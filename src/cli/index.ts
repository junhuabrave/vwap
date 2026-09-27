#!/usr/bin/env node
/**
 * vwap -- plan and cost long-horizon accumulation.
 *
 * This CLI formats; it does not orchestrate. The sequence of resolve, audit,
 * measure and decide lives in app/service.ts, shared with the local web UI, so
 * the two cannot disagree about what a plan costs.
 *
 * Nothing here signs, submits, or asks for a secret key.
 */
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatUnits } from '../core/money.ts';
import type { OrderSpec } from '../venues/jupiter/orders.ts';
import { auditToken, type TokenAudit } from '../venues/jupiter/safety.ts';
import { AmbiguousTokenError, resolveToken } from '../venues/jupiter/adapter.ts';
import {
  VENUE, emitWithPreflight, orderSpecs, planReport, type PlanReport,
} from '../app/service.ts';
import { serve } from '../web/server.ts';
import { bold, cyan, dim, green, pct, red, severityMark, severityStyle, usd, yellow } from './format.ts';

const HELP = `
${bold('vwap')} -- plan long-horizon accumulation, non-custodially.

${bold('USAGE')}
  vwap check <token...> [--per-buy <usd>] [--total <usd>]
  vwap plan  --legs <SYM=weight,...> --budget <usd> [options]
  vwap order --legs <SYM=weight,...> --budget <usd> --wallet <pubkey> [options]
  vwap emit  <spec.json> [--no-check] [--force]
  vwap serve [--port <n>]

${bold('COMMANDS')}
  check    Resolve tokens and audit them for identity and liquidity risk.
  plan     Build a schedule with measured impact and slicing decisions.
  order    Validate a plan against the venue and write durable order specs.
  emit     Build a fresh UNSIGNED transaction, vet it, and print it to sign.
  serve    Run the local web UI, where a wallet can sign without copy-paste.

${bold('PLAN OPTIONS')}
  --legs <spec>       Comma list, e.g. "JUP=1,SOL=1,MET=1" or mint=weight.
  --budget <usd>      Spend per period.            (required)
  --cadence <c>       daily | weekly | monthly.    (default: monthly)
  --periods <n>       Number of buys.              (default: 48)
  --day <n>           Day of month for monthly.    (default: 1)
  --slippage <bps>    Per-order slippage cap.      (default: 50)
  --json              Emit machine-readable JSON.

${bold('ORDER OPTIONS')}
  --wallet <pubkey>   Your PUBLIC key. Never pass a private key to this tool.
  --chunk <n>         Split into consecutive orders of n periods each, so you
                      do not escrow the whole plan at once.
  --out <dir>         Where to write the order specs.

${bold('EMIT OPTIONS')}
  --no-check          Skip the on-chain pre-flight (offline, or no RPC).
  --force             Print the transaction even if a check failed.

  Pre-flight simulates the transaction against an RPC node and checks the
  blockhash, your SOL for fees, and your USDC balance. Set SOLANA_RPC to use
  your own node; the public endpoint is heavily rate-limited.

${bold('NOTES')}
  Tokens may be given as tickers or mint addresses. A ticker matching more than
  one token is an error, not a guess -- pass the mint to disambiguate.

  Specs are durable; transactions are not. A Solana transaction dies with its
  blockhash after roughly 90 seconds, so 'order' stores intent and 'emit'
  builds the transaction at the moment you are ready to sign it.
`;

const fail: (msg: string) => never = (msg) => {
  console.error(`${red('error')} ${msg}`);
  process.exit(1);
};

function explain(err: unknown): never {
  if (err instanceof AmbiguousTokenError) {
    console.error(`${red('ambiguous')} ${err.message}`);
    process.exit(1);
  }
  return fail(err instanceof Error ? err.message : String(err));
}

function printAudit(audit: TokenAudit, indent = '  ') {
  const t = audit.token;
  const badge = audit.verdict === 'blocked' ? red('BLOCKED')
    : audit.verdict === 'caution' ? yellow('CAUTION') : green('OK');
  console.log(
    `${indent}${bold(t.symbol.padEnd(8))} ${badge}  ${dim(t.name)}\n` +
    `${indent}${dim(t.id)}\n` +
    `${indent}${dim(
      `liquidity ${usd(t.liquidity ?? 0)} | mcap ${usd(t.mcap ?? 0)} | ` +
      `holders ${t.holderCount ?? '?'} | verified ${t.isVerified ? 'yes' : 'no'}`,
    )}`,
  );
  for (const f of audit.findings) {
    console.log(`${indent}  ${severityStyle[f.severity](severityMark[f.severity].padEnd(5))} ${f.message}`);
  }
  if (audit.findings.length === 0) console.log(`${indent}  ${dim('no findings')}`);
  console.log();
}

async function cmdCheck(tokens: string[], perBuyUsd?: number, totalUsd?: number) {
  if (tokens.length === 0) fail('give at least one token');
  console.log(`\n${bold('Token audit')}\n`);
  let blocked = 0;
  for (const q of tokens) {
    const { token, collisions } = await resolveToken(q).catch(explain);
    const audit = auditToken(token, {
      ...(perBuyUsd !== undefined ? { perBuyUsd } : {}),
      ...(totalUsd !== undefined ? { totalPositionUsd: totalUsd } : {}),
      collisions,
    });
    if (audit.verdict === 'blocked') blocked++;
    printAudit(audit);
  }
  if (blocked > 0) {
    console.log(`${red(`${blocked} token(s) blocked.`)} Resolve these before planning.\n`);
    process.exit(2);
  }
}

function printPlan(r: PlanReport) {
  console.log(`\n${bold('Plan')}  ${usd(r.budgetUsd)} ${r.cadence} x ${r.periods} = ${bold(usd(r.totalUsd))} total`);
  console.log(dim(`first buy ${r.schedule[0]}  ...  last buy ${r.schedule[r.schedule.length - 1]}`));
  console.log(dim(`funding ${r.fundingSymbol} on ${r.venue}, slippage cap ${r.slippageBps}bps\n`));

  for (const l of r.legs) {
    printAudit(l.audit);
    console.log(
      `    ${dim('spend')} ${usd(l.spendPerPeriodUsd)}/period  ${dim('->')} ${usd(l.legTotalUsd)} over ${r.periods}\n` +
      `    ${dim('impact')} ${pct(l.decision.impactIfSingle)} at size` +
      (Number.isFinite(l.exponent)
        ? `  ${dim(`(exponent ${l.exponent.toFixed(2)}, R2 ${l.rSquared.toFixed(2)}${l.rSquared < 0.8 ? ' -- unreliable' : ''})`)}`
        : `  ${dim('(curve too flat to fit)')}`) + '\n' +
      `    ${dim('slicing')} ${l.decision.parts === 1 ? 'none' : cyan(`${l.decision.parts} parts`)} -- ${l.decision.reason}\n` +
      `    ${dim('route')} ${l.route.join(' > ') || 'n/a'}\n`,
    );
  }

  console.log(`${bold('Estimated cost over the whole plan')}`);
  console.log(`  venue fee (${VENUE.proportionalFeeBps}bps)   ${usd(r.feeUsd)}`);
  console.log(`  price impact        ${usd(r.impactUsd)}`);
  const total = r.feeUsd + r.impactUsd;
  console.log(`  ${bold('total')}               ${bold(usd(total))}  ${dim(`(${pct(total / r.totalUsd, 2)} of deployed capital)`)}`);
  console.log(dim('\n  Excludes network fees and any spread the router already reflects in its quote.'));
  console.log(dim("  Impact is measured at today's liquidity; it will drift over a multi-year plan.\n"));
}

async function cmdOrder(opts: {
  legs: string; budget: string; cadence: string; periods: number;
  wallet: string; chunk?: number; out: string;
}) {
  const plan = await orderSpecs({ ...opts, validate: true }).catch(explain);

  console.log(`\n${bold('Order')}  ${usd(plan.totalUsd / opts.periods)} ${opts.cadence} x ${opts.periods}`);
  if (plan.chunks.length > 1) {
    console.log(dim(`split into ${plan.chunks.length} consecutive orders of ${plan.chunks[0]} periods each`));
  }
  if (plan.escrowsUpfront) {
    console.log(
      `${bold('Capital escrowed now:')} ${bold(usd(plan.escrowNowUsd))}` +
      (plan.chunks.length > 1 ? dim(`  (of ${usd(plan.totalUsd)} total; the rest when each chunk ends)`) : ''),
    );
    console.log(dim(
      `${VENUE.label} locks the whole deposit when the order is created. It stays\n` +
      'yours and is withdrawable by cancelling, but it is committed from today.',
    ));
  } else {
    console.log(dim(`${VENUE.label} draws each part as it executes; nothing is locked up front.`));
  }
  if (plan.driftDays !== null) {
    const days = Math.round(VENUE.intervalSeconds.monthly / 86_400);
    console.log(
      `\n${yellow('note')} ${VENUE.label} schedules by fixed ${days}-day intervals, not calendar ` +
      `dates,\n     so buys cannot be pinned to the 1st. Over ${opts.periods} orders they drift ` +
      `about ${plan.driftDays} days\n     earlier. For averaging the date is immaterial, but it is ` +
      `not what "the 1st" means.`,
    );
  }
  console.log();

  await mkdir(opts.out, { recursive: true });
  const seen = new Map<string, number>();
  const written: string[] = [];
  for (const spec of plan.specs) {
    const n = (seen.get(spec.leg) ?? 0) + 1;
    seen.set(spec.leg, n);
    const name = `${spec.leg}-${String(n).padStart(2, '0')}.json`;
    await writeFile(join(opts.out, name), JSON.stringify(spec, null, 2) + '\n');
    written.push(name);
    console.log(
      `  ${green('validated')} ${bold(spec.leg.padEnd(8))} ` +
      `${usd(Number(spec.depositUsdc))} over ${spec.numberOfOrders} orders  ${dim(name)}`,
    );
  }

  console.log(`\n${bold(`${written.length} order spec(s) written to ${opts.out}/`)}`);
  console.log(dim(
    '\nEach was round-tripped through the venue to prove it is acceptable. Nothing\n' +
    'has been submitted and no funds have moved.',
  ));
  console.log(
    `\nA Solana transaction dies with its blockhash after about 90 seconds, so the\n` +
    `specs hold the ${bold('intent')}, not a transaction. Build one when you are ready to\n` +
    `sign it, and sign it immediately:\n\n` +
    `  ${cyan(`vwap emit ${join(opts.out, written[0] ?? 'SPEC.json')}`)}\n` +
    `\nOr drive the whole flow with a connected wallet:  ${cyan('vwap serve')}\n`,
  );
  console.log(dim('Place one short order first and confirm it fills before committing the rest.'));
}

async function cmdEmit(specPath: string, opts: { check: boolean; force: boolean }) {
  const spec = JSON.parse(await readFile(specPath, 'utf8')) as OrderSpec;
  const r = await emitWithPreflight(spec, { check: opts.check }).catch(explain);

  console.log(
    `\n${bold(spec.leg)}  ${usd(Number(spec.depositUsdc))} over ${spec.numberOfOrders} orders ` +
    `${dim(`(${spec.mint})`)}\n${dim(`wallet ${spec.wallet}`)}`,
  );
  console.log(dim(`calls: ${r.programs.join(', ')}`));
  console.log(`\n${bold('Pre-flight')} ${dim(`(rpc ${r.rpcHost})`)}`);
  for (const c of r.checks) {
    const mark = c.status === 'ok' ? green('  ok  ') : c.status === 'warn' ? yellow(' warn ') : red(' FAIL ');
    console.log(`  ${mark} ${c.label}`);
    for (const l of c.logs ?? []) console.log(dim(`         ${l.slice(0, 110)}`));
  }
  if (!opts.check) console.log(dim('  ..... on-chain checks skipped (--no-check)'));

  if (r.blocking > 0 && !opts.force) {
    console.error(
      `\n${red(`${r.blocking} blocking problem(s).`)} Not printing the transaction — signing it would ` +
      `burn a fee\nto land a failure. Fix the above, or pass ${cyan('--force')} to see it anyway.`,
    );
    process.exit(2);
  }

  console.log(`\n${bold('Unsigned transaction (base64):')}`);
  console.log(r.transaction);
  console.log(
    `\n${yellow('This expires in about 90 seconds.')} Sign and send it now, or run ${cyan('emit')} again.\n` +
    dim('Nothing has been signed or submitted by this tool.'),
  );
}

async function cmdServe(port: number) {
  const url = await serve(port).catch((err: unknown) =>
    fail(`could not start the server: ${err instanceof Error ? err.message : String(err)}`));
  console.log(`\n${bold('vwap')} is serving at ${cyan(url)}`);
  console.log(dim(
    'Bound to loopback only. The page connects your wallet and signs there —\n' +
    'no signature and no secret key passes through this process.\n\nCtrl-C to stop.',
  ));
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); return; }

  try {
    if (cmd === 'check') {
      const { values, positionals } = parseArgs({
        args: argv.slice(1), allowPositionals: true,
        options: { 'per-buy': { type: 'string' }, total: { type: 'string' } },
      });
      await cmdCheck(
        positionals,
        values['per-buy'] !== undefined ? Number(values['per-buy']) : undefined,
        values['total'] !== undefined ? Number(values['total']) : undefined,
      );
      return;
    }

    if (cmd === 'plan') {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: {
          legs: { type: 'string' }, budget: { type: 'string' },
          cadence: { type: 'string', default: 'monthly' },
          periods: { type: 'string', default: '48' },
          day: { type: 'string', default: '1' },
          slippage: { type: 'string', default: '50' },
          json: { type: 'boolean', default: false },
        },
      });
      const legs = values.legs ?? fail('--legs is required, e.g. --legs "JUP=1,SOL=1"');
      const budget = values.budget ?? fail('--budget is required, e.g. --budget 500');
      const report = await planReport({
        legs, budget,
        cadence: values.cadence ?? 'monthly',
        periods: Number(values.periods ?? '48'),
        dayOfMonth: Number(values.day ?? '1'),
        slippageBps: Number(values.slippage ?? '50'),
      }).catch(explain);
      if (values.json === true) console.log(JSON.stringify(report, null, 2));
      else printPlan(report);
      if (report.blocked > 0) {
        console.error(`${red(`${report.blocked} token(s) blocked.`)} Fix these before placing orders.`);
        process.exit(2);
      }
      return;
    }

    if (cmd === 'order') {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: {
          legs: { type: 'string' }, budget: { type: 'string' }, wallet: { type: 'string' },
          cadence: { type: 'string', default: 'monthly' },
          periods: { type: 'string', default: '48' },
          chunk: { type: 'string' },
          out: { type: 'string', default: 'orders' },
        },
      });
      const legs = values.legs ?? fail('--legs is required');
      const budget = values.budget ?? fail('--budget is required');
      const wallet = values.wallet ?? fail('--wallet is required (your PUBLIC key)');
      await cmdOrder({
        legs, budget, wallet,
        cadence: values.cadence ?? 'monthly',
        periods: Number(values.periods ?? '48'),
        ...(values.chunk !== undefined ? { chunk: Number(values.chunk) } : {}),
        out: values.out ?? 'orders',
      });
      return;
    }

    if (cmd === 'emit') {
      const { values, positionals } = parseArgs({
        args: argv.slice(1), allowPositionals: true,
        options: { 'no-check': { type: 'boolean', default: false }, force: { type: 'boolean', default: false } },
      });
      const spec = positionals[0] ?? fail('usage: vwap emit <spec.json>');
      await cmdEmit(spec, { check: values['no-check'] !== true, force: values.force === true });
      return;
    }

    if (cmd === 'serve') {
      const { values } = parseArgs({ args: argv.slice(1), options: { port: { type: 'string', default: '4747' } } });
      await cmdServe(Number(values.port ?? '4747'));
      return;
    }

    fail(`unknown command: ${cmd}`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

await main();
