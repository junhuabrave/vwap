import test from 'node:test';
import assert from 'node:assert/strict';
import { bracketSizes, fitPowerLaw, impactAt, probeSizes } from '../src/core/impact.ts';
import { decideSlicing } from '../src/core/planner.ts';
import type { ImpactCurve, Token } from '../src/core/types.ts';
import type { VenueCapabilities } from '../src/core/venue.ts';
import { maxLegsFor } from '../src/core/venue.ts';

/**
 * Two venues identical but for the cost of a fill. Everything the planner does
 * differently between chains should come from this one number.
 */
const CHEAP_VENUE: VenueCapabilities = {
  id: 'test-cheap', label: 'Cheap venue', chain: 'solana',
  minOrderUsd: 50, proportionalFeeBps: 10, fixedCostPerFillUsd: 0.005,
  escrow: 'upfront', intervalSemantics: 'fixed-seconds',
  intervalSeconds: { daily: 86_400, weekly: 604_800, monthly: 2_592_000 },
};
const COSTLY_VENUE: VenueCapabilities = {
  ...CHEAP_VENUE, id: 'test-costly', label: 'Costly venue',
  chain: 'ethereum', fixedCostPerFillUsd: 4.0,
};

const TOKEN: Token = {
  chain: 'solana', address: 'So11111111111111111111111111111111111111112',
  symbol: 'TEST', name: 'Test', decimals: 6,
};

const SPEND = 100_000_000n;                       // $100 at 6 decimals
const SIZES = bracketSizes(SPEND, 2, 2, 4n);      // order sits in the middle

/**
 * Build a curve with a known degradation shape.
 *
 * Degradation is measured against the smallest probe, so it is zero there by
 * construction -- the same thing the live measurement does. `exponent` is set
 * explicitly because fitting is tested separately; these tests are about what
 * the planner DECIDES given a curve, not about recovering the curve.
 */
function curveWith(k: number, a: number, exponent = a, sizes = SIZES): ImpactCurve {
  const s0 = Number(sizes[0]!);
  const deg = (s: bigint) => k * (Math.pow(Number(s) / s0, a) - 1);
  const points = sizes.map((spend) => {
    const d = deg(spend);
    return {
      spend,
      outAmount: BigInt(Math.round(Number(spend) * (1 - d))),
      priceImpactPct: d * 100,
      routeLabels: ['synthetic'],
    };
  });
  return { token: TOKEN, points, exponent, rSquared: 1 };
}

test('fitPowerLaw recovers a known exponent', () => {
  for (const a of [0.5, 1.0, 1.5, 2.0]) {
    const samples = [1, 4, 16, 64, 256].map((s) => ({ size: s * 1e6, impact: 1e-6 * Math.pow(s, a) }));
    const { exponent, rSquared } = fitPowerLaw(samples);
    assert.ok(Math.abs(exponent - a) < 1e-6, `expected ${a}, got ${exponent}`);
    assert.ok(rSquared > 0.999);
  }
});

test('fitPowerLaw refuses to guess from too little signal', () => {
  assert.ok(Number.isNaN(fitPowerLaw([{ size: 1, impact: 0.1 }]).exponent));
  // A perfectly liquid token reports zero impact; that must not become a fit.
  assert.ok(Number.isNaN(fitPowerLaw([1, 2, 3, 4].map((s) => ({ size: s, impact: 0 }))).exponent));
});

test('bracketSizes puts the order in the middle, not at the reference', () => {
  assert.deepEqual(bracketSizes(100n, 2, 2, 4n), [6n, 25n, 100n, 400n, 1600n]);
  assert.equal(bracketSizes(100n, 2, 2, 4n)[2], 100n);
  assert.throws(() => bracketSizes(0n), /positive/);
});

test('the order size has a non-zero measured impact', () => {
  // The bug this guards: probing upward from the order made it its own
  // reference, so measured impact was always exactly zero.
  const curve = curveWith(2.74e-4, 1.8);
  const atOrder = impactAt(curve, SPEND);
  assert.ok(atOrder > 0.001, `order-size impact should be measurable, got ${atOrder}`);
});

test('convex impact is sliced; linear and concave are not', () => {
  const opts = { venue: CHEAP_VENUE, spend: SPEND, spendUsd: 100 };

  const convex = decideSlicing(curveWith(2.74e-4, 1.8), opts);
  assert.ok(convex.worthIt, `expected slicing, got: ${convex.reason}`);
  assert.ok(convex.parts > 1);
  assert.ok(convex.impactIfSliced < convex.impactIfSingle);
  assert.match(convex.reason, /convex/);

  const linear = decideSlicing(curveWith(2.74e-4, 1.8, 1.0), opts);
  assert.equal(linear.parts, 1);
  assert.match(linear.reason, /linear/);

  const concave = decideSlicing(curveWith(2.74e-4, 1.8, 0.6), opts);
  assert.equal(concave.parts, 1);
  assert.match(concave.reason, /concave/);
});

test('the venue, not the market, decides whether to slice', () => {
  // Identical curve, identical order: only the venue's per-fill cost differs.
  // This is the whole argument for keeping retail accumulation off mainnet, and
  // the reason the planner reads capabilities instead of a table of chains.
  const curve = curveWith(2.74e-4, 1.8);
  const spend = SPEND, spendUsd = 100;
  assert.ok(decideSlicing(curve, { venue: CHEAP_VENUE, spend, spendUsd }).worthIt);
  const costly = decideSlicing(curve, { venue: COSTLY_VENUE, spend, spendUsd });
  assert.equal(costly.parts, 1, 'a $4 fill should swamp the saving');
  assert.match(costly.reason, /cost more in fees/);
  assert.match(costly.reason, /Costly venue/, 'the explanation should name the venue');
});

test('a bigger order justifies slicing even at $4 a fill', () => {
  // Same curve shape, 1000x the money: now the impact saved dwarfs the gas.
  const curve = curveWith(2.74e-4, 1.8);
  const d = decideSlicing(curve, { venue: COSTLY_VENUE, spend: SPEND, spendUsd: 100_000 });
  assert.ok(d.worthIt, `expected slicing at size, got: ${d.reason}`);
});

test('a new venue needs no planner change', () => {
  // Describing a venue is enough to change the decision -- nothing in core/
  // knows this venue exists.
  const curve = curveWith(2.74e-4, 1.8);
  const midCost: VenueCapabilities = { ...CHEAP_VENUE, id: 'mid', label: 'Mid', fixedCostPerFillUsd: 0.5 };
  const d = decideSlicing(curve, { venue: midCost, spend: SPEND, spendUsd: 100 });
  assert.ok(Number.isFinite(d.impactIfSliced));
  assert.match(d.reason, /Mid|convex|fees/);
});

test('maxLegsFor respects the venue floor', () => {
  assert.equal(maxLegsFor(500, CHEAP_VENUE), 10);
  assert.equal(maxLegsFor(500, { ...CHEAP_VENUE, minOrderUsd: 5 }), 100);
  assert.equal(maxLegsFor(500, { ...CHEAP_VENUE, minOrderUsd: 5_000 }), 0);
});

test('negligible impact short-circuits before any slicing maths', () => {
  const d = decideSlicing(curveWith(1e-10, 1.8), { venue: CHEAP_VENUE, spend: SPEND, spendUsd: 100 });
  assert.equal(d.parts, 1);
  assert.match(d.reason, /negligible/);
});

test('an unmeasurable curve never slices on a guess', () => {
  const empty: ImpactCurve = { token: TOKEN, points: [], exponent: NaN, rSquared: NaN };
  const d = decideSlicing(empty, { venue: CHEAP_VENUE, spend: SPEND, spendUsd: 100 });
  assert.equal(d.parts, 1);
  assert.equal(d.worthIt, false);

  const unfittable = decideSlicing(curveWith(2.74e-4, 1.8, NaN), { venue: CHEAP_VENUE, spend: SPEND, spendUsd: 100 });
  assert.equal(unfittable.parts, 1);
  assert.match(unfittable.reason, /too flat to fit/);
});

test('a noisy fit is not traded on', () => {
  // Convex exponent, but the fit explains almost none of the variance: at
  // retail size this is routing noise with a slope, and slicing on it is a
  // coin flip dressed up as a measurement.
  const noisy = { ...curveWith(2.74e-4, 1.8), rSquared: 0.3 };
  const d = decideSlicing(noisy, { venue: CHEAP_VENUE, spend: SPEND, spendUsd: 100 });
  assert.equal(d.parts, 1);
  assert.match(d.reason, /routing noise/);

  // The same curve with a clean fit does slice.
  assert.ok(decideSlicing({ ...noisy, rSquared: 0.95 }, { venue: CHEAP_VENUE, spend: SPEND, spendUsd: 100 }).worthIt);
});

test('impactAt interpolates inside the probed range and extrapolates beyond it', () => {
  const curve = curveWith(2.74e-4, 1.8);
  const half = impactAt(curve, SPEND / 2n);
  const full = impactAt(curve, SPEND);
  assert.ok(half < full, 'a smaller order must not cost more');
  const beyond = impactAt(curve, SIZES[SIZES.length - 1]! * 4n);
  assert.ok(beyond > full, 'impact must keep rising past the last probe');
});

test('probeSizes are geometric', () => {
  assert.deepEqual(probeSizes(500_000_000n, 4, 4n),
    [500_000_000n, 2_000_000_000n, 8_000_000_000n, 32_000_000_000n]);
  assert.throws(() => probeSizes(0n), /positive/);
});
