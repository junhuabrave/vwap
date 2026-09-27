/**
 * The orchestration behind every command, as data rather than printed output.
 *
 * Both the CLI and the local web server call these. Anything that formats for a
 * terminal stays in cli/, anything that serialises to JSON stays in web/, and
 * the sequence of "resolve, audit, measure, decide" lives here once. A second
 * copy of that sequence behind a UI is how two front ends start disagreeing
 * about what a plan costs.
 *
 * These functions throw. They never exit the process, because a server has to
 * answer the next request.
 */
import { formatUnits, parseUnits, splitByWeights } from '../core/money.ts';
import { bracketSizes, measureCurve } from '../core/impact.ts';
import { decideSlicing } from '../core/planner.ts';
import { SECONDS, iso, nextDayOfMonth, scheduleFor } from '../core/schedule.ts';
import type { Cadence, SliceDecision, Token } from '../core/types.ts';
import type { VenueCapabilities } from '../core/venue.ts';
import { JUPITER } from '../venues/jupiter/capabilities.ts';
import { auditToken, type TokenAudit } from '../venues/jupiter/safety.ts';
import { USDC, makeQuoteFn, resolveToken, toToken } from '../venues/jupiter/adapter.ts';
import {
  OrderTooSmallError, chunkPeriods, createDcaOrder, requestFromSpec, type OrderSpec,
} from '../venues/jupiter/orders.ts';
import { decodeTransaction, type DecodedTransaction } from '../venues/solana/transaction.ts';
import { blockhashValid, rpcUrl, simulate, solBalance, splBalance } from '../venues/solana/rpc.ts';

export const VENUE: VenueCapabilities = JUPITER;
export const CADENCES: readonly Cadence[] = ['daily', 'weekly', 'monthly'];

/** Enough SOL to cover fees and rent for the order's accounts. */
export const SOL_FLOOR_LAMPORTS = 20_000_000n; // 0.02 SOL

export interface LegSpec { readonly query: string; readonly weight: number }

/** Parse "JUP=1,SOL=2" or a bare "JUP,SOL" into weighted legs. */
export function parseLegs(spec: string): LegSpec[] {
  const legs = spec.split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const [q, w] = part.split('=');
    if (!q?.trim()) throw new Error(`bad leg: ${part}`);
    const weight = w === undefined || w.trim() === '' ? 1 : Number(w);
    if (!(weight > 0) || !Number.isFinite(weight)) throw new Error(`bad weight in "${part}"`);
    return { query: q.trim(), weight };
  });
  if (legs.length === 0) throw new Error('no legs given');
  return legs;
}

export function asCadence(value: string): Cadence {
  if ((CADENCES as readonly string[]).includes(value)) return value as Cadence;
  throw new Error(`bad cadence: ${value} (expected ${CADENCES.join(', ')})`);
}

export interface LegReport {
  readonly symbol: string;
  readonly name: string;
  readonly mint: string;
  readonly weight: number;
  readonly spendPerPeriodUsd: number;
  readonly legTotalUsd: number;
  readonly audit: TokenAudit;
  readonly decision: SliceDecision;
  readonly exponent: number;
  readonly rSquared: number;
  readonly route: readonly string[];
  readonly impactUsdOverPlan: number;
}

export interface PlanReport {
  readonly venue: string;
  readonly fundingSymbol: string;
  readonly budgetUsd: number;
  readonly cadence: Cadence;
  readonly periods: number;
  readonly totalUsd: number;
  readonly slippageBps: number;
  readonly schedule: readonly string[];
  readonly legs: readonly LegReport[];
  readonly feeUsd: number;
  readonly impactUsd: number;
  readonly blocked: number;
}

export interface PlanInput {
  readonly legs: string;
  readonly budget: string;
  readonly cadence: string;
  readonly periods: number;
  readonly dayOfMonth?: number;
  readonly slippageBps?: number;
}

/** Resolve, audit, measure impact and decide slicing for every leg. */
export async function planReport(input: PlanInput): Promise<PlanReport> {
  const cadence = asCadence(input.cadence);
  const legSpecs = parseLegs(input.legs);
  const periods = input.periods;
  if (!Number.isInteger(periods) || periods < 1) throw new Error(`bad period count: ${periods}`);
  const slippageBps = input.slippageBps ?? 50;

  const budget = parseUnits(input.budget, USDC.decimals);
  if (budget <= 0n) throw new Error('budget must be positive');
  const budgetUsd = Number(formatUnits(budget, USDC.decimals));
  const totalUsd = budgetUsd * periods;

  const shares = splitByWeights(budget, legSpecs.map((l) => l.weight));
  const startAt = cadence === 'monthly'
    ? nextDayOfMonth(Math.floor(Date.now() / 1000), input.dayOfMonth ?? 1)
    : Math.floor(Date.now() / 1000) + 60;
  const schedule = scheduleFor(startAt, cadence, periods).map(iso);

  const legs: LegReport[] = [];
  let blocked = 0;
  let impactUsd = 0;

  for (const [i, leg] of legSpecs.entries()) {
    const spend = shares[i]!;
    const spendUsd = Number(formatUnits(spend, USDC.decimals));
    const legTotalUsd = spendUsd * periods;

    const { token: jup, collisions } = await resolveToken(leg.query);
    const token: Token = toToken(jup);
    const audit = auditToken(jup, { perBuyUsd: spendUsd, totalPositionUsd: legTotalUsd, collisions });
    if (audit.verdict === 'blocked') blocked++;

    // Probe around the real order size so it sits mid-range, not at the
    // reference point where its own impact would measure as zero.
    const curve = await measureCurve(
      token, bracketSizes(spend, 2, 2, 4n), makeQuoteFn(USDC, token, slippageBps),
    );
    const decision = decideSlicing(curve, { venue: VENUE, spend, spendUsd, maxParts: 12 });
    const legImpact = Number.isFinite(decision.impactIfSliced)
      ? decision.impactIfSliced * legTotalUsd : 0;
    impactUsd += legImpact;

    legs.push({
      symbol: jup.symbol, name: jup.name, mint: jup.id, weight: leg.weight,
      spendPerPeriodUsd: spendUsd, legTotalUsd, audit, decision,
      exponent: curve.exponent, rSquared: curve.rSquared,
      route: curve.points[0]?.routeLabels ?? [],
      impactUsdOverPlan: legImpact,
    });
  }

  return {
    venue: VENUE.label, fundingSymbol: USDC.symbol,
    budgetUsd, cadence, periods, totalUsd, slippageBps, schedule, legs,
    feeUsd: (totalUsd * VENUE.proportionalFeeBps) / 10_000,
    impactUsd, blocked,
  };
}

export interface OrderPlan {
  readonly specs: readonly OrderSpec[];
  readonly chunks: readonly number[];
  readonly escrowNowUsd: number;
  readonly totalUsd: number;
  readonly escrowsUpfront: boolean;
  /** Days a fixed-interval venue drifts from the calendar over the plan. */
  readonly driftDays: number | null;
  readonly blockedLegs: readonly string[];
}

export interface OrderInput extends PlanInput {
  readonly wallet: string;
  readonly chunk?: number;
  /** Round-trip each order through the venue to confirm it is acceptable. */
  readonly validate?: boolean;
}

/**
 * Turn a plan into durable order specs.
 *
 * Every leg is checked against the venue floor BEFORE anything is built, so a
 * plan either works whole or fails having produced nothing. A half-placed
 * basket is worse than no basket.
 */
export async function orderSpecs(input: OrderInput): Promise<OrderPlan> {
  const cadence = asCadence(input.cadence);
  const legSpecs = parseLegs(input.legs);
  const periods = input.periods;
  if (!Number.isInteger(periods) || periods < 1) throw new Error(`bad period count: ${periods}`);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.wallet)) {
    if (/^[1-9A-HJ-NP-Za-km-z]{45,}$/.test(input.wallet)) {
      throw new Error(
        'that looks like a SECRET key, not a public key. Never give a secret key to this tool — ' +
        'it signs nothing and needs only your public address.',
      );
    }
    throw new Error('wallet must be a base58 public key');
  }

  const budget = parseUnits(input.budget, USDC.decimals);
  if (budget <= 0n) throw new Error('budget must be positive');
  const budgetUsd = Number(formatUnits(budget, USDC.decimals));
  const shares = splitByWeights(budget, legSpecs.map((l) => l.weight));
  const chunks = chunkPeriods(periods, input.chunk);
  const interval = VENUE.intervalSeconds[cadence];

  for (const [i, leg] of legSpecs.entries()) {
    const perOrderUsd = Number(formatUnits(shares[i]!, USDC.decimals));
    if (perOrderUsd < VENUE.minOrderUsd) {
      throw new Error(`${leg.query}: ${new OrderTooSmallError(perOrderUsd).message}`);
    }
  }

  const specs: OrderSpec[] = [];
  const blockedLegs: string[] = [];

  for (const [i, leg] of legSpecs.entries()) {
    const { token: jup, collisions } = await resolveToken(leg.query);
    const perOrderUsd = Number(formatUnits(shares[i]!, USDC.decimals));
    const audit = auditToken(jup, {
      perBuyUsd: perOrderUsd, totalPositionUsd: perOrderUsd * periods, collisions,
    });
    if (audit.verdict === 'blocked') {
      blockedLegs.push(jup.symbol);
      continue;
    }

    let offset = 0;
    for (const count of chunks) {
      const deposit = shares[i]! * BigInt(count);
      const startAt = offset === 0 ? undefined : Math.floor(Date.now() / 1000) + offset * interval;
      const spec: OrderSpec = {
        leg: jup.symbol, mint: jup.id, wallet: input.wallet,
        depositUsdc: formatUnits(deposit, USDC.decimals),
        numberOfOrders: count, intervalSeconds: interval,
        ...(startAt !== undefined ? { startAt } : {}),
      };
      if (input.validate === true) {
        // Round-trip only to prove acceptance; the transaction is discarded
        // because its blockhash is already dying.
        await createDcaOrder(requestFromSpec(spec, USDC.address, deposit));
      }
      specs.push(spec);
      offset += count;
    }
  }

  if (blockedLegs.length > 0) {
    throw new Error(`blocked by the audit, refusing to build orders: ${blockedLegs.join(', ')}`);
  }

  const driftDays = VENUE.intervalSemantics === 'fixed-seconds' && cadence === 'monthly'
    ? Math.round((periods * (SECONDS.monthly - VENUE.intervalSeconds.monthly)) / 86_400)
    : null;

  return {
    specs, chunks,
    escrowNowUsd: budgetUsd * (chunks[0] ?? 0),
    totalUsd: budgetUsd * periods,
    escrowsUpfront: VENUE.escrow === 'upfront',
    driftDays, blockedLegs,
  };
}

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface PreflightCheck {
  readonly status: CheckStatus;
  readonly label: string;
  readonly logs?: readonly string[];
}

export interface EmitResult {
  readonly transaction: string;
  readonly decoded: DecodedTransaction;
  readonly programs: readonly string[];
  readonly checks: readonly PreflightCheck[];
  readonly blocking: number;
  readonly rpcHost: string;
}

export const PROGRAM_LABELS: Record<string, string> = {
  DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M: 'Jupiter DCA',
  ComputeBudget111111111111111111111111111111: 'Compute Budget',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'SPL Token',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token',
  '11111111111111111111111111111111': 'System',
};

/** Build a fresh transaction for a spec and vet it before anyone signs it. */
export async function emitWithPreflight(
  spec: OrderSpec, opts: { check?: boolean } = {},
): Promise<EmitResult> {
  for (const field of ['leg', 'mint', 'wallet', 'depositUsdc', 'numberOfOrders', 'intervalSeconds'] as const) {
    if (spec[field] === undefined) throw new Error(`spec is missing "${field}"`);
  }
  const depositRaw = parseUnits(spec.depositUsdc, USDC.decimals);
  const built = await createDcaOrder(requestFromSpec(spec, USDC.address, depositRaw));

  let decoded: DecodedTransaction;
  try {
    decoded = decodeTransaction(built.transaction);
  } catch (err) {
    throw new Error(`venue returned something that will not parse as a transaction: ${String(err)}`);
  }
  if (!decoded.unsigned) {
    throw new Error('refusing to hand back a transaction that already carries a signature');
  }

  const checks: PreflightCheck[] = [
    { status: 'ok', label: `unsigned: ${decoded.signatureSlots} empty signature slot(s)` },
  ];

  if (opts.check !== false) {
    try {
      const [fresh, lamports, usdc, sim] = await Promise.all([
        blockhashValid(decoded.recentBlockhash),
        solBalance(spec.wallet),
        splBalance(spec.wallet, USDC.address),
        simulate(built.transaction),
      ]);
      checks.push({
        status: fresh ? 'ok' : 'fail',
        label: fresh ? 'blockhash is live' : 'blockhash already expired — rebuild it',
      });
      checks.push({
        status: lamports >= SOL_FLOOR_LAMPORTS ? 'ok' : 'warn',
        label: `wallet holds ${formatUnits(lamports, 9)} SOL for fees and rent` +
          (lamports >= SOL_FLOOR_LAMPORTS ? '' : ` (under ${formatUnits(SOL_FLOOR_LAMPORTS, 9)} — may fail)`),
      });
      checks.push({
        status: usdc >= depositRaw ? 'ok' : 'fail',
        label: usdc >= depositRaw
          ? `wallet holds ${formatUnits(usdc, USDC.decimals)} USDC, needs ${spec.depositUsdc}`
          : `wallet holds ${formatUnits(usdc, USDC.decimals)} USDC but this order deposits ${spec.depositUsdc}`,
      });
      if (sim.err === null) {
        checks.push({
          status: 'ok',
          label: `simulated clean${sim.unitsConsumed !== undefined ? ` (${sim.unitsConsumed} compute units)` : ''}`,
        });
      } else {
        const interesting = sim.logs.filter((l) => /error|fail|insufficient|panic/i.test(l)).slice(0, 4);
        checks.push({
          status: 'fail',
          label: `simulation failed: ${JSON.stringify(sim.err)}`,
          logs: (interesting.length > 0 ? interesting : sim.logs.slice(-4)).map((l) => l.slice(0, 160)),
        });
      }
    } catch (err) {
      checks.push({
        status: 'warn',
        label: `on-chain checks unavailable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return {
    transaction: built.transaction,
    decoded,
    programs: [...new Set(decoded.programIds)].map((id) => PROGRAM_LABELS[id] ?? `${id.slice(0, 8)}...`),
    checks,
    blocking: checks.filter((c) => c.status === 'fail').length,
    rpcHost: new URL(rpcUrl()).host,
  };
}
