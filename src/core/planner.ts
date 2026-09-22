/**
 * Does slicing actually pay for itself?
 *
 * The honest answer is usually no. Splitting a trade helps only when impact is
 * convex in size AND the book has time to refill between slices; otherwise all
 * it buys is more transactions to pay for. This module makes that a measurement
 * instead of a preference.
 *
 * Note what slicing is NOT doing here. Dollar-cost averaging over months reduces
 * the variance of your entry price -- that is a real benefit and it has nothing
 * to do with market impact. Slicing a single period's buy is purely an execution
 * cost question, and at retail size the answer is usually "don't bother".
 */
import type { ImpactCurve, SliceDecision } from './types.ts';
import type { VenueCapabilities } from './venue.ts';
import { impactAt } from './impact.ts';

export interface SliceOptions {
  /**
   * The venue this order would be placed on.
   *
   * Slicing is a venue decision, not a market one: the same curve is worth
   * slicing where a fill costs half a cent and not worth it where a fill costs
   * four dollars. The planner reads that cost from the venue rather than
   * carrying a table of chains it would have to be edited to extend.
   */
  readonly venue: VenueCapabilities;
  /** Spend for one period, in funding base units. */
  readonly spend: bigint;
  /** USD value of that spend, for costing fixed fees. */
  readonly spendUsd: number;
  /** Largest number of parts to consider. */
  readonly maxParts?: number;
  /**
   * How much of the book refills between slices, 0..1.
   *
   * Slicing only helps if the pool recovers in between. At 0 the slices land as
   * if they were one trade and splitting is pointless; at 1 each slice meets an
   * untouched book. The default is deliberately conservative -- assuming full
   * replenishment is how backtests promise savings that never arrive.
   */
  readonly replenishment?: number;
  /**
   * Minimum R^2 before the fitted exponent is trusted.
   *
   * At retail sizes the impact signal is smaller than the variation between
   * routes, so the fit is often noise with a slope. Acting on an unreliable
   * exponent is worse than not slicing at all.
   */
  readonly minFitQuality?: number;
}

export function decideSlicing(curve: ImpactCurve, opts: SliceOptions): SliceDecision {
  const { venue, spend, spendUsd } = opts;
  const maxParts = opts.maxParts ?? 12;
  const replenishment = opts.replenishment ?? 0.7;
  const token = curve.token;
  const single = impactAt(curve, spend);
  const fillCost = venue.fixedCostPerFillUsd;

  const no = (reason: string, sliced = single): SliceDecision => ({
    token, parts: 1, reason,
    impactIfSingle: single,
    impactIfSliced: sliced,
    feeCostBps: 0,
    worthIt: false,
  });

  if (!Number.isFinite(single)) {
    return no('impact could not be measured -- not slicing on a guess');
  }
  if (single < 0.0005) {
    return no(`impact at this size is ${(single * 100).toFixed(3)}%, already negligible`);
  }
  if (!Number.isFinite(curve.exponent)) {
    return no('impact curve too flat to fit -- no evidence slicing would help');
  }
  const minFit = opts.minFitQuality ?? 0.8;
  if (!Number.isFinite(curve.rSquared) || curve.rSquared < minFit) {
    return no(
      `impact curve fits poorly (R2 ${Number.isFinite(curve.rSquared) ? curve.rSquared.toFixed(2) : 'n/a'}) ` +
      `-- the measurement is routing noise, not a shape worth trading on`,
    );
  }
  if (curve.exponent <= 1.05) {
    return no(
      `impact is ${curve.exponent < 0.95 ? 'concave' : 'linear'} in size ` +
      `(exponent ${curve.exponent.toFixed(2)}), so splitting saves nothing`,
    );
  }

  // Search for the part count with the best net saving.
  let best = { parts: 1, net: 0, impact: single };
  for (let n = 2; n <= maxParts; n++) {
    const per = spend / BigInt(n);
    if (per <= 0n) break;
    const perImpact = impactAt(curve, per);
    if (!Number.isFinite(perImpact)) break;

    // With partial replenishment the effective impact sits between the sliced
    // ideal and the unsliced reality.
    const effective = perImpact * replenishment + single * (1 - replenishment);
    const savedUsd = (single - effective) * spendUsd;
    const extraCostUsd = (n - 1) * fillCost;
    const net = savedUsd - extraCostUsd;
    if (net > best.net) best = { parts: n, net, impact: effective };
  }

  if (best.parts === 1) {
    return no(
      `slicing would cost more in fees ($${fillCost.toFixed(3)} per extra fill on ` +
      `${venue.label}) than it saves in impact`,
    );
  }

  return {
    token,
    parts: best.parts,
    reason:
      `impact is convex (exponent ${curve.exponent.toFixed(2)}); ${best.parts} parts cuts effective ` +
      `impact from ${(single * 100).toFixed(3)}% to ${(best.impact * 100).toFixed(3)}%, ` +
      `netting ~$${best.net.toFixed(2)} after ${best.parts - 1} extra fill(s)`,
    impactIfSingle: single,
    impactIfSliced: best.impact,
    feeCostBps: spendUsd > 0 ? ((best.parts - 1) * fillCost / spendUsd) * 10_000 : 0,
    worthIt: true,
  };
}
