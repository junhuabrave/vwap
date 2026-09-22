/**
 * What a venue can and cannot do.
 *
 * Venues differ in ways that change the answer, not just the plumbing: Jupiter
 * escrows a whole plan up front while CoW pulls per part; Jupiter's floor is
 * $50 an order and CoW's is $5 on an L2 and $5,000 on mainnet; Jupiter counts
 * fixed seconds where a calendar-aware venue could honour "the 1st". Code that
 * assumes one venue's shape quietly produces wrong numbers on another.
 *
 * So the engine reads capabilities instead of knowing venues. Adding a chain
 * means describing it here and writing an adapter -- never editing the planner.
 *
 * Only dimensions with a real consumer live in this type. More are catalogued
 * in docs/multichain.md; add them when a venue actually needs them, rather than
 * guessing at a shape before anything reads it.
 */
import type { Cadence, Chain } from './types.ts';

export interface VenueCapabilities {
  /** Stable identifier, e.g. 'jupiter'. */
  readonly id: string;
  /** Human label used in explanations, e.g. 'Jupiter (Solana)'. */
  readonly label: string;
  readonly chain: Chain;

  /** Smallest order the venue will accept, in USD. */
  readonly minOrderUsd: number;

  /**
   * Proportional fee in basis points.
   *
   * Proportional fees cancel out of the slicing decision -- they cost the same
   * whether an order is one fill or ten -- so this is for cost reporting, never
   * for deciding how to slice.
   */
  readonly proportionalFeeBps: number;

  /**
   * Fixed cost of one additional fill, in USD.
   *
   * This is the number that makes slicing venue-dependent. On Solana a fill
   * costs a fraction of a cent, so any convexity is worth harvesting. On
   * Ethereum mainnet a fill costs dollars, which swamps the impact saved on a
   * retail-sized order and makes slicing actively wrong.
   */
  readonly fixedCostPerFillUsd: number;

  /**
   * When the venue takes the money.
   *
   * 'upfront' escrows the entire plan on creation, so a four-year schedule
   * commits four years of capital today. 'per-part' draws each part from an
   * allowance as it executes.
   */
  readonly escrow: 'upfront' | 'per-part';

  /**
   * How the venue understands an interval.
   *
   * 'fixed-seconds' means a "month" is a fixed span and buys drift against the
   * calendar -- a plan cannot promise the 1st. 'wall-clock' means calendar
   * dates are honoured.
   */
  readonly intervalSemantics: 'fixed-seconds' | 'wall-clock';

  /** Seconds the venue uses for each cadence. */
  readonly intervalSeconds: Readonly<Record<Cadence, number>>;
}

/** How many legs a budget can split into before hitting the venue's floor. */
export const maxLegsFor = (budgetUsd: number, venue: VenueCapabilities): number =>
  Math.floor(budgetUsd / venue.minOrderUsd);
