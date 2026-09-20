/** Chain-agnostic vocabulary. Venue adapters translate these into orders. */

/** Where an order can be placed. Add a chain by adding an adapter, not a branch. */
export const CHAINS = ['solana', 'base', 'arbitrum', 'ethereum'] as const;
export type Chain = (typeof CHAINS)[number];

/** A token, always identified by its contract/mint address -- never by ticker. */
export interface Token {
  readonly chain: Chain;
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

/** One asset in a basket, with its share of each period's budget. */
export interface Leg {
  readonly token: Token;
  /** Relative weight. [1,1,1] and [100,100,100] mean the same thing. */
  readonly weight: number;
}

export const CADENCES = ['daily', 'weekly', 'monthly'] as const;
export type Cadence = (typeof CADENCES)[number];

/** What the user wants: this much, this often, into these assets, for this long. */
export interface Plan {
  readonly name: string;
  readonly chain: Chain;
  /** The asset spent -- usually a stablecoin. */
  readonly funding: Token;
  /** Budget per period, in funding-token base units. */
  readonly budgetPerPeriod: bigint;
  readonly cadence: Cadence;
  readonly periods: number;
  /** First execution, unix seconds. */
  readonly startAt: number;
  readonly legs: readonly Leg[];
  /** Per-order slippage ceiling. Orders that would exceed it should not fill. */
  readonly maxSlippageBps: number;
}

/** A single intended purchase: spend this much funding on this token at this time. */
export interface Slice {
  readonly token: Token;
  readonly spend: bigint;
  readonly at: number;
}

/**
 * A measured point on a token's impact curve: what the aggregator actually
 * quoted at this size. Not modelled -- probed.
 */
export interface ImpactPoint {
  readonly spend: bigint;
  readonly priceImpactPct: number;
  readonly outAmount: bigint;
  readonly routeLabels: readonly string[];
}

export interface ImpactCurve {
  readonly token: Token;
  readonly points: readonly ImpactPoint[];
  /**
   * Fitted exponent a in impact ~ k * size^a, by least squares on log-log.
   *
   * a ~ 1 means impact is linear in size, and splitting a trade WITHIN one
   * block saves nothing. a > 1 means the book is convex and slicing helps even
   * without waiting. This number is why the planner can refuse to slice.
   */
  readonly exponent: number;
  readonly rSquared: number;
}

/** What the planner decided, and -- more usefully -- why. */
export interface SliceDecision {
  readonly token: Token;
  readonly parts: number;
  readonly reason: string;
  readonly impactIfSingle: number;
  readonly impactIfSliced: number;
  readonly feeCostBps: number;
  readonly worthIt: boolean;
}

export interface VenueFee {
  readonly bps: number;
  readonly label: string;
}
