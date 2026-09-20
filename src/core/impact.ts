/**
 * Empirical price-impact measurement.
 *
 * Rather than assume a market-impact model, probe the aggregator at several
 * sizes and measure how the fill price actually degrades. Routing across a
 * dozen venues makes any closed-form curve a guess; the router's own quotes are
 * the ground truth, and they are free to ask for.
 *
 * Degradation is measured against the smallest probe, which stands in for the
 * untouched mid price. It is the number a trader actually cares about: how much
 * worse do I fill as I get bigger?
 */
import type { ImpactCurve, ImpactPoint, Token } from './types.ts';

export interface QuoteFn {
  (spend: bigint): Promise<{
    outAmount: bigint;
    priceImpactPct: number;
    routeLabels: readonly string[];
  }>;
}

/**
 * Probe sizes spanning the decision, geometrically spaced.
 *
 * Geometric rather than linear because impact curves are power laws: equal
 * ratios carry equal information, so linear spacing wastes probes at the top.
 */
export function probeSizes(base: bigint, count = 5, factor = 4n): bigint[] {
  if (base <= 0n) throw new RangeError('probe base must be positive');
  const out: bigint[] = [];
  let s = base;
  for (let i = 0; i < count; i++) {
    out.push(s);
    s *= factor;
  }
  return out;
}

/**
 * Probe sizes that BRACKET the order, smaller sizes first.
 *
 * The smallest probe is the reference price, so it has to be genuinely smaller
 * than the order -- probing from the order size upward makes the order its own
 * reference and reports its impact as zero. Measuring against a probe that is
 * itself non-zero understates impact slightly, which is the safe direction: it
 * makes slicing look less attractive than it is, never more.
 */
export function bracketSizes(spend: bigint, below = 2, above = 2, factor = 4n): bigint[] {
  if (spend <= 0n) throw new RangeError('spend must be positive');
  const out: bigint[] = [];
  let lo = spend;
  for (let i = 0; i < below; i++) {
    lo /= factor;
    if (lo <= 0n) break;
    out.unshift(lo);
  }
  out.push(spend);
  let hi = spend;
  for (let i = 0; i < above; i++) { hi *= factor; out.push(hi); }
  return out;
}

/** Effective price as a float ratio: output tokens per unit of funding spent. */
const effectivePrice = (outAmount: bigint, spend: bigint): number => {
  if (spend === 0n) return 0;
  // Scale before converting so small ratios keep their significant digits.
  return Number((outAmount * 1_000_000_000n) / spend) / 1e9;
};

/**
 * Fit impact ~ k * size^a by least squares on log-log axes.
 *
 * The exponent is what decides whether slicing can help at all:
 *   a < 1  concave  -- slicing hurts; the marginal unit is getting cheaper
 *   a ~ 1  linear   -- slicing within a block is a wash (classic AMM behaviour)
 *   a > 1  convex   -- slicing genuinely reduces cost
 *
 * Returns NaN when there are too few usable points to say anything. The planner
 * is required to treat NaN as "don't slice" rather than guessing.
 */
export function fitPowerLaw(
  samples: readonly { size: number; impact: number }[],
): { exponent: number; rSquared: number } {
  const usable = samples.filter((s) => s.size > 0 && s.impact > 1e-9 && Number.isFinite(s.impact));
  if (usable.length < 3) return { exponent: NaN, rSquared: NaN };

  const xs = usable.map((s) => Math.log(s.size));
  const ys = usable.map((s) => Math.log(s.impact));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx, dy = ys[i]! - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0) return { exponent: NaN, rSquared: NaN };
  const exponent = sxy / sxx;
  const rSquared = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { exponent, rSquared };
}

/** Probe the curve for one token by asking for real quotes at increasing sizes. */
export async function measureCurve(
  token: Token,
  sizes: readonly bigint[],
  quoteFn: QuoteFn,
): Promise<ImpactCurve> {
  const points: ImpactPoint[] = [];
  for (const spend of sizes) {
    try {
      const q = await quoteFn(spend);
      points.push({
        spend,
        outAmount: q.outAmount,
        priceImpactPct: q.priceImpactPct,
        routeLabels: q.routeLabels,
      });
    } catch {
      // A size with no route is itself a finding: the book ran out. Stop
      // climbing rather than reporting a curve built from partial data.
      break;
    }
  }
  if (points.length === 0) {
    return { token, points, exponent: NaN, rSquared: NaN };
  }

  const ref = points[0]!;
  const refPrice = effectivePrice(ref.outAmount, ref.spend);
  const samples = points.map((p) => {
    const price = effectivePrice(p.outAmount, p.spend);
    // Degradation relative to the smallest probe, floored at zero: negative
    // values are routing noise, not free money.
    const measured = refPrice > 0 ? Math.max(0, (refPrice - price) / refPrice) : 0;
    // Fall back to the router's own estimate when our differential is in the noise.
    const impact = measured > 1e-6 ? measured : p.priceImpactPct / 100;
    return { size: Number(p.spend), impact };
  });

  const { exponent, rSquared } = fitPowerLaw(samples);
  return { token, points, exponent, rSquared };
}

/** Interpolate measured degradation at an arbitrary size. */
export function impactAt(curve: ImpactCurve, spend: bigint): number {
  const pts = curve.points;
  if (pts.length === 0) return NaN;
  if (pts.length === 1) return pts[0]!.priceImpactPct / 100;

  const ref = pts[0]!;
  const refPrice = effectivePrice(ref.outAmount, ref.spend);
  const deg = (p: ImpactPoint) => {
    const price = effectivePrice(p.outAmount, p.spend);
    const measured = refPrice > 0 ? Math.max(0, (refPrice - price) / refPrice) : 0;
    return measured > 1e-6 ? measured : p.priceImpactPct / 100;
  };

  const x = Number(spend);
  for (let i = 1; i < pts.length; i++) {
    const lo = pts[i - 1]!, hi = pts[i]!;
    const xl = Number(lo.spend), xh = Number(hi.spend);
    if (x <= xh) {
      const t = xh === xl ? 0 : (x - xl) / (xh - xl);
      return deg(lo) + t * (deg(hi) - deg(lo));
    }
  }
  // Beyond the probed range, extrapolate with the fitted power law if we have
  // one; otherwise return the largest measured point rather than inventing.
  const last = pts[pts.length - 1]!;
  if (Number.isFinite(curve.exponent) && curve.exponent > 0) {
    return deg(last) * Math.pow(x / Number(last.spend), curve.exponent);
  }
  return deg(last);
}
