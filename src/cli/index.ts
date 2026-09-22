#!/usr/bin/env node
/**
 * vwap -- plan and cost long-horizon accumulation.
 *
 * This CLI is read-only. It resolves tokens, audits them, measures live impact,
 * and prints a schedule with its costs. It does not sign, submit, or custody
 * anything: placing the resulting orders is a deliberate act the user performs
 * in their own wallet.
 */
import { parseArgs } from 'node:util';
import { formatUnits, parseUnits, splitByWeights } from '../core/money.ts';
import { bracketSizes, measureCurve } from '../core/impact.ts';
import { decideSlicing } from '../core/planner.ts';
import { SECONDS, iso, nextDayOfMonth, scheduleFor } from '../core/schedule.ts';
import type { Token } from '../core/types.ts';
import { type JupToken } from '../venues/jupiter/client.ts';
import { JUPITER } from '../venues/jupiter/capabilities.ts';
import { auditToken, looksLikeMint, type TokenAudit } from '../venues/jupiter/safety.ts';
import { OrderTooSmallError, chunkPeriods, createDcaOrder } from '../venues/jupiter/orders.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AmbiguousTokenError, USDC, makeQuoteFn, resolveToken, toToken,
} from '../venues/jupiter/adapter.ts';
import { bold, cyan, dim, green, pct, red, severityMark, severityStyle, usd, yellow } from './format.ts';

/**
 * The venue this CLI places orders on.
 *
 * Everything below reads limits, fees and scheduling semantics from here rather
 * than from Jupiter directly, so supporting another chain means choosing a
 * different value -- not editing the command logic.
 */
const VENUE = JUPITER;

const HELP = `
${bold('vwap')} -- plan long-horizon accumulation, non-custodially.

${bold('USAGE')}
  vwap check <token...> [--per-buy <usd>] [--total <usd>]
  vwap plan  --legs <SYM=weight,...> --budget <usd> [options]
  vwap order --legs <SYM=weight,...> --budget <usd> --wallet <pubkey> [options]

${bold('COMMANDS')}
  check    Resolve tokens and audit them for identity and liquidity risk.
  plan     Build a full schedule with measured impact and slicing decisions.
  order    Build UNSIGNED DCA transactions for you to sign in your own wallet.

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
  --out <dir>         Where to write the unsigned transactions.

${bold('NOTES')}
  Tokens may be given as tickers or mint addresses. A ticker matching more than
  one token is an error, not a guess -- pass the mint to disambiguate.

  'order' builds transactions and stops. It never signs, never submits, and
  never asks for a secret key.
`;

// Annotated explicitly: TypeScript only narrows through a never-returning
// arrow function when the binding itself carries the type.
const fail: (msg: string) => never = (msg) => {
  console.error(`${red('error')} ${msg}`);
  process.exit(1);
};

async function resolveOrExplain(query: string) {
  try {
    return await resolveToken(query);
  } catch (err) {
    if (err instanceof AmbiguousTokenError) {
      console.error(`${red('ambiguous')} ${err.message}`);
      process.exit(1);
    }
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function printAudit(audit: TokenAudit, indent = '  ') {
  const t = audit.token;
  const badge =
    audit.verdict === 'blocked' ? red('BLOCKED')
    : audit.verdict === 'caution' ? yellow('CAUTION')
    : green('OK');
  console.log(
    `${indent}${bold(t.symbol.padEnd(8))} ${badge}  ${dim(t.name)}\n` +
    `${indent}${dim(t.id)}\n` +
    `${indent}${dim(
      `liquidity ${usd(t.liquidity ?? 0)} | mcap ${usd(t.mcap ?? 0)} | ` +
      `holders ${t.holderCount ?? '?'} | verified ${t.isVerified ? 'yes' : 'no'}`,
    )}`,
  );
  for (const f of audit.findings) {
    const style = severityStyle[f.severity];
    console.log(`${indent}  ${style(severityMark[f.severity].padEnd(5))} ${f.message}`);
  }
  if (audit.findings.length === 0) console.log(`${indent}  ${dim('no findings')}`);
  console.log();
}

async function cmdCheck(tokens: string[], perBuyUsd?: number, totalUsd?: number) {
  if (tokens.length === 0) fail('give at least one token');
  console.log(`\n${bold('Token audit')}\n`);
  let blocked = 0;
  for (const q of tokens) {
    const { token, collisions } = await resolveOrExplain(q);
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

interface LegSpec { query: string; weight: number }

function parseLegs(spec: string): LegSpec[] {
  const legs = spec.split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const [q, w] = part.split('=');
    if (!q) throw new Error(`bad leg: ${part}`);
    const weight = w === undefined ? 1 : Number(w);
    if (!(weight > 0) || !Number.isFinite(weight)) throw new Error(`bad weight in "${part}"`);
    return { query: q.trim(), weight };
  });
  if (legs.length === 0) throw new Error('no legs given');
  return legs;
}

async function cmdPlan(opts: {
  legs: string; budget: string; cadence: string; periods: number;
  day: number; slippage: number; json: boolean;
}) {
  const cadence = opts.cadence as 'daily' | 'weekly' | 'monthly';
  if (!['daily', 'weekly', 'monthly'].includes(cadence)) fail(`bad cadence: ${opts.cadence}`);

  let legSpecs: LegSpec[];
  try { legSpecs = parseLegs(opts.legs); } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }

  const budget = parseUnits(opts.budget, USDC.decimals);
  if (budget <= 0n) fail('budget must be positive');
  const budgetUsd = Number(formatUnits(budget, USDC.decimals));
  const totalUsd = budgetUsd * opts.periods;

  const shares = splitByWeights(budget, legSpecs.map((l) => l.weight));

  const startAt = cadence === 'monthly'
    ? nextDayOfMonth(Math.floor(Date.now() / 1000), opts.day)
    : Math.floor(Date.now() / 1000) + 60;
  const times = scheduleFor(startAt, cadence, opts.periods);

  if (!opts.json) {
    console.log(`\n${bold('Plan')}  ${usd(budgetUsd)} ${cadence} x ${opts.periods} = ${bold(usd(totalUsd))} total`);
    console.log(dim(`first buy ${iso(times[0]!)}  ...  last buy ${iso(times[times.length - 1]!)}`));
    console.log(dim(`funding ${USDC.symbol} on solana, slippage cap ${opts.slippage}bps\n`));
  }

  const rows: Array<Record<string, unknown>> = [];
  let blocked = 0;
  let totalImpactUsd = 0;

  for (const [i, leg] of legSpecs.entries()) {
    const spend = shares[i]!;
    const spendUsd = Number(formatUnits(spend, USDC.decimals));
    const legTotalUsd = spendUsd * opts.periods;
    const { token: jup, collisions } = await resolveOrExplain(leg.query);
    const token: Token = toToken(jup);

    const audit = auditToken(jup, {
      perBuyUsd: spendUsd, totalPositionUsd: legTotalUsd, collisions,
    });
    if (audit.verdict === 'blocked') blocked++;

    // Probe around the actual per-period spend, so the order size sits in the
    // middle of the measured range rather than at its reference point.
    const curve = await measureCurve(
      token,
      bracketSizes(spend, 2, 2, 4n),
      makeQuoteFn(USDC, token, opts.slippage),
    );
    const decision = decideSlicing(curve, {
      venue: VENUE, spend, spendUsd, maxParts: 12,
    });

    const impactUsd = Number.isFinite(decision.impactIfSliced)
      ? decision.impactIfSliced * spendUsd * opts.periods : 0;
    totalImpactUsd += impactUsd;

    if (opts.json) {
      rows.push({
        symbol: jup.symbol, mint: jup.id, weight: leg.weight,
        spendPerPeriod: formatUnits(spend, USDC.decimals),
        verdict: audit.verdict,
        findings: audit.findings,
        exponent: curve.exponent, rSquared: curve.rSquared,
        parts: decision.parts, reason: decision.reason,
        impactSingle: decision.impactIfSingle, impactSliced: decision.impactIfSliced,
      });
    } else {
      printAudit(audit);
      console.log(
        `    ${dim('spend')} ${usd(spendUsd)}/period  ${dim('->')} ${usd(legTotalUsd)} over ${opts.periods}\n` +
        `    ${dim('impact')} ${pct(decision.impactIfSingle)} at size` +
        (Number.isFinite(curve.exponent)
          ? `  ${dim(
              `(exponent ${curve.exponent.toFixed(2)}, R2 ${curve.rSquared.toFixed(2)}` +
              `${curve.rSquared < 0.8 ? ' -- unreliable' : ''})`,
            )}`
          : `  ${dim('(curve too flat to fit)')}`) + '\n' +
        `    ${dim('slicing')} ${decision.parts === 1 ? 'none' : cyan(`${decision.parts} parts`)} -- ${decision.reason}\n` +
        `    ${dim('route')} ${curve.points[0]?.routeLabels.join(' > ') ?? 'n/a'}\n`,
      );
    }
  }

  const feeUsd = (totalUsd * VENUE.proportionalFeeBps) / 10_000;
  if (opts.json) {
    console.log(JSON.stringify({
      budgetPerPeriod: opts.budget, cadence, periods: opts.periods,
      totalUsd, schedule: times.map(iso), legs: rows,
      estimatedFeeUsd: feeUsd, estimatedImpactUsd: totalImpactUsd,
    }, null, 2));
  } else {
    console.log(`${bold('Estimated cost over the whole plan')}`);
    console.log(`  venue fee (${VENUE.proportionalFeeBps}bps)   ${usd(feeUsd)}`);
    console.log(`  price impact        ${usd(totalImpactUsd)}`);
    console.log(`  ${bold('total')}               ${bold(usd(feeUsd + totalImpactUsd))}  ${dim(`(${pct((feeUsd + totalImpactUsd) / totalUsd, 2)} of deployed capital)`)}`);
    console.log(dim('\n  Excludes network fees and any spread the router already reflects in its quote.'));
    console.log(dim('  Impact is measured at today\'s liquidity; it will drift over a multi-year plan.\n'));
  }

  if (blocked > 0) {
    console.error(`${red(`${blocked} token(s) blocked.`)} Fix these before placing orders.`);
    process.exit(2);
  }
}

async function cmdOrder(opts: {
  legs: string; budget: string; cadence: string; periods: number;
  wallet: string; chunk?: number; out: string;
}) {
  const cadence = opts.cadence as 'daily' | 'weekly' | 'monthly';
  if (!['daily', 'weekly', 'monthly'].includes(cadence)) fail(`bad cadence: ${opts.cadence}`);
  // A Solana secret key is 64 bytes and base58-encodes to ~87-88 characters, so
  // an over-long base58 string is almost certainly a secret. Check this BEFORE
  // the generic format check, so the user gets the warning that matters.
  if (/^[1-9A-HJ-NP-Za-km-z]{45,}$/.test(opts.wallet)) {
    fail('that looks like a SECRET key, not a public key. Never pass a secret key to this tool -- it signs nothing and needs only your public address.');
  }
  if (!looksLikeMint(opts.wallet)) fail(`--wallet must be a base58 public key, got ${JSON.stringify(opts.wallet)}`);

  const legSpecs = parseLegs(opts.legs);
  const budget = parseUnits(opts.budget, USDC.decimals);
  const budgetUsd = Number(formatUnits(budget, USDC.decimals));
  const shares = splitByWeights(budget, legSpecs.map((l) => l.weight));
  const chunks = chunkPeriods(opts.periods, opts.chunk);
  const interval = VENUE.intervalSeconds[cadence];

  // Validate every leg BEFORE building anything, so a plan either works whole
  // or fails without leaving half its orders built.
  for (const [i, leg] of legSpecs.entries()) {
    const perOrderUsd = Number(formatUnits(shares[i]!, USDC.decimals));
    if (perOrderUsd < VENUE.minOrderUsd) {
      const err = new OrderTooSmallError(perOrderUsd);
      fail(`${leg.query}: ${err.message}`);
    }
  }

  const firstChunkUsd = budgetUsd * chunks[0]!;
  console.log(`\n${bold('Order')}  ${usd(budgetUsd)} ${cadence} x ${opts.periods} across ${legSpecs.length} legs`);
  if (chunks.length > 1) {
    console.log(dim(`split into ${chunks.length} consecutive orders of ${chunks[0]} periods each`));
  }
  if (VENUE.escrow === 'upfront') {
    console.log(
      `${bold('Capital escrowed now:')} ${bold(usd(firstChunkUsd))}` +
      (chunks.length > 1 ? dim(`  (of ${usd(budgetUsd * opts.periods)} total; the rest when each chunk ends)`) : ''),
    );
    console.log(dim(
      `${VENUE.label} locks the whole deposit when the order is created. It stays\n` +
      'yours and is withdrawable by cancelling, but it is committed from today.',
    ));
  } else {
    console.log(dim(`${VENUE.label} draws each part as it executes; nothing is locked up front.`));
  }

  // A venue that counts fixed seconds cannot honour a calendar date, so say so
  // rather than letting a plan imply a precision it does not have.
  if (VENUE.intervalSemantics === 'fixed-seconds' && cadence === 'monthly') {
    const driftDays = Math.round(
      (opts.periods * (SECONDS.monthly - VENUE.intervalSeconds.monthly)) / 86_400,
    );
    const days = Math.round(VENUE.intervalSeconds.monthly / 86_400);
    console.log(
      `\n${yellow('note')} ${VENUE.label} schedules by fixed ${days}-day intervals, not calendar ` +
      `dates,\n     so buys cannot be pinned to the 1st. Over ${opts.periods} orders they drift ` +
      `about ${driftDays} days\n     earlier. For averaging the date is immaterial, but it is not ` +
      `what "the 1st" means.`,
    );
  }
  console.log();

  await mkdir(opts.out, { recursive: true });
  const written: string[] = [];

  for (const [i, leg] of legSpecs.entries()) {
    const { token: jup } = await resolveOrExplain(leg.query);
    const audit = auditToken(jup, {
      perBuyUsd: Number(formatUnits(shares[i]!, USDC.decimals)),
      totalPositionUsd: Number(formatUnits(shares[i]!, USDC.decimals)) * opts.periods,
    });
    if (audit.verdict === 'blocked') {
      printAudit(audit);
      fail(`${jup.symbol} is blocked by the audit -- refusing to build an order for it`);
    }

    let offset = 0;
    for (const [c, count] of chunks.entries()) {
      const deposit = shares[i]! * BigInt(count);
      const startAt = offset === 0 ? undefined : Math.floor(Date.now() / 1000) + offset * interval;
      const built = await createDcaOrder({
        user: opts.wallet,
        inputMint: USDC.address,
        outputMint: jup.id,
        totalDeposit: deposit,
        numberOfOrders: count,
        intervalSeconds: interval,
        ...(startAt !== undefined ? { startAt } : {}),
      });
      const name = `${jup.symbol}-${String(c + 1).padStart(2, '0')}.json`;
      const file = join(opts.out, name);
      await writeFile(file, JSON.stringify({
        leg: jup.symbol, mint: jup.id, wallet: opts.wallet,
        depositUsdc: formatUnits(deposit, USDC.decimals),
        numberOfOrders: count, intervalSeconds: interval,
        ...(startAt !== undefined ? { startAt } : {}),
        requestId: built.requestId,
        unsignedTransaction: built.transaction,
      }, null, 2) + '\n');
      written.push(file);
      console.log(
        `  ${green('built')} ${bold(jup.symbol.padEnd(8))} ${usd(Number(formatUnits(deposit, USDC.decimals)))} ` +
        `over ${count} orders  ${dim(name)}`,
      );
      offset += count;
    }
  }

  console.log(`\n${bold(`${written.length} unsigned transaction(s) written to ${opts.out}/`)}`);
  console.log(dim(
    '\nThese are UNSIGNED. Nothing has been submitted and no funds have moved.\n' +
    'Review each one, then sign and send it from your own wallet. Place a single\n' +
    'short order first and confirm it fills before committing the full plan.',
  ));
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(HELP); return;
  }

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
    if (cmd === 'order') {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: {
          legs: { type: 'string' }, budget: { type: 'string' },
          wallet: { type: 'string' },
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
      await cmdPlan({
        legs, budget,
        cadence: values.cadence ?? 'monthly',
        periods: Number(values.periods ?? '48'),
        day: Number(values.day ?? '1'),
        slippage: Number(values.slippage ?? '50'),
        json: values.json ?? false,
      });
      return;
    }
    fail(`unknown command: ${cmd}`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

await main();
