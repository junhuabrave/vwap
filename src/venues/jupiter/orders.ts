/**
 * Building Jupiter DCA orders.
 *
 * This module builds UNSIGNED transactions and stops. It never signs, never
 * submits, and never sees a private key -- placing an order is a deliberate act
 * the user performs in their own wallet.
 *
 * A note on which API this targets. Jupiter's docs say DCA has moved into
 * Trigger V2, and the Recurring API is unmaintained. But as of September 2026
 * there is no public `trigger/v2/*` endpoint -- every path 404s -- and
 * `trigger/v1/createOrder` is limit-orders-only (it requires `maker`/`payer`
 * and price params). `recurring/v1/createOrder` is the only public endpoint
 * that builds a working DCA order, so that is what this uses. When Trigger V2
 * ships publicly, this is the module that changes; nothing in core/ should.
 */
import { JupiterError } from './client.ts';
import { MIN_ORDER_USD } from './capabilities.ts';

const LITE = 'https://lite-api.jup.ag';

export interface DcaOrderRequest {
  /** The wallet that will own and fund the order. A public key, never a secret. */
  readonly user: string;
  readonly inputMint: string;
  readonly outputMint: string;
  /** TOTAL deposited up front, in input base units. Split across every order. */
  readonly totalDeposit: bigint;
  readonly numberOfOrders: number;
  readonly intervalSeconds: number;
  /** Unix seconds, or omitted to begin immediately. */
  readonly startAt?: number;
}

export interface BuiltOrder {
  readonly requestId: string;
  /** Base64 unsigned transaction, for the user to sign in their own wallet. */
  readonly transaction: string;
}

export class OrderTooSmallError extends Error {
  readonly perOrderUsd: number;
  constructor(perOrderUsd: number) {
    super(
      `each order would be worth $${perOrderUsd.toFixed(2)}, below Jupiter's ` +
        `$${MIN_ORDER_USD} minimum. Raise the budget, cut the number of legs, ` +
        `or buy less often.`,
    );
    this.name = 'OrderTooSmallError';
    this.perOrderUsd = perOrderUsd;
  }
}

/**
 * Ask Jupiter to build the order transaction.
 *
 * `inAmount` is the total deposit and must be a JSON number, not a string --
 * the API silently rejects the string form as an unmatched enum variant, with
 * an error that names neither the field nor the reason.
 */
export async function createDcaOrder(req: DcaOrderRequest): Promise<BuiltOrder> {
  if (req.numberOfOrders < 1) throw new RangeError('numberOfOrders must be at least 1');
  if (req.totalDeposit <= 0n) throw new RangeError('totalDeposit must be positive');

  const time: Record<string, unknown> = {
    inAmount: Number(req.totalDeposit),
    numberOfOrders: req.numberOfOrders,
    interval: req.intervalSeconds,
  };
  if (req.startAt !== undefined) time['startAt'] = req.startAt;

  const res = await fetch(`${LITE}/recurring/v1/createOrder`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      user: req.user,
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      params: { time },
    }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    transaction?: string; requestId?: string; error?: string;
  };
  if (!res.ok || !body.transaction) {
    throw new JupiterError(`createOrder failed: ${body.error ?? `HTTP ${res.status}`}`, res.status);
  }
  return { requestId: body.requestId ?? '', transaction: body.transaction };
}

/**
 * Split a long plan into shorter consecutive orders.
 *
 * Jupiter escrows the ENTIRE deposit when the order is created, so a 48-month
 * plan locks four years of capital today. Chunking into yearly orders cuts that
 * commitment and gives natural points to reassess, at the cost of having to
 * place a new order when each chunk ends.
 */
/**
 * The durable description of an order, safe to keep on disk.
 *
 * Deliberately NOT the transaction. A Solana transaction carries a recent
 * blockhash and dies with it after roughly 60-90 seconds, so a transaction
 * written to a file is scrap by the time anyone has read it. What survives is
 * the intent; the transaction gets rebuilt at the moment of signing.
 */
export interface OrderSpec {
  readonly leg: string;
  readonly mint: string;
  readonly wallet: string;
  readonly depositUsdc: string;
  readonly numberOfOrders: number;
  readonly intervalSeconds: number;
  readonly startAt?: number;
}

/** Turn a spec back into the request that builds it. */
export const requestFromSpec = (spec: OrderSpec, inputMint: string, depositRaw: bigint): DcaOrderRequest => ({
  user: spec.wallet,
  inputMint,
  outputMint: spec.mint,
  totalDeposit: depositRaw,
  numberOfOrders: spec.numberOfOrders,
  intervalSeconds: spec.intervalSeconds,
  ...(spec.startAt !== undefined ? { startAt: spec.startAt } : {}),
});

export function chunkPeriods(periods: number, chunkSize?: number): number[] {
  if (periods < 1) throw new RangeError('periods must be at least 1');
  if (chunkSize === undefined) return [periods];
  if (chunkSize < 1) throw new RangeError('chunk size must be at least 1');
  const out: number[] = [];
  let left = periods;
  while (left > 0) {
    const take = Math.min(chunkSize, left);
    out.push(take);
    left -= take;
  }
  return out;
}
