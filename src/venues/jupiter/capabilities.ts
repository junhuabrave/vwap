/** Jupiter's capabilities, as measured against the live API. */
import type { VenueCapabilities } from '../../core/venue.ts';

/**
 * Jupiter rejects orders worth less than this each.
 *
 * Jupiter reports the limit as 50.00 USDC. The effective check sits a little
 * lower because it values the order through a price feed, so $48 slips through
 * today. We enforce the stated 50 rather than the observed boundary: a plan
 * that builds today and starts failing when the feed drifts is worse than one
 * that refuses up front.
 */
export const MIN_ORDER_USD = 50;

/**
 * Jupiter schedules by fixed second intervals, not calendar dates.
 *
 * "Monthly" is therefore 30 days, not "the 1st of each month". Over a 48-order
 * plan the two diverge by about three weeks. For averaging purposes the exact
 * date is immaterial -- regular spacing is the whole mechanism -- but a plan
 * that promised the 1st cannot be delivered literally, and should say so.
 */
export const INTERVAL_SECONDS = {
  daily: 86_400,
  weekly: 604_800,
  monthly: 2_592_000, // 30 days
} as const;

/** Jupiter's DCA fee, in basis points. */
export const DCA_FEE_BPS = 10;

/**
 * Cost of one extra fill on Solana, in USD.
 *
 * Base fee plus a modest priority fee. Small enough that slicing is nearly
 * free, which is why any measured convexity is worth harvesting here and is
 * not on mainnet.
 */
const FILL_COST_USD = 0.005;

export const JUPITER: VenueCapabilities = {
  id: 'jupiter',
  label: 'Jupiter (Solana)',
  chain: 'solana',
  minOrderUsd: MIN_ORDER_USD,
  proportionalFeeBps: DCA_FEE_BPS,
  fixedCostPerFillUsd: FILL_COST_USD,
  escrow: 'upfront',
  intervalSemantics: 'fixed-seconds',
  intervalSeconds: INTERVAL_SECONDS,
};
