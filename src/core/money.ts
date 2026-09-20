/**
 * Exact integer money math.
 *
 * Token amounts are ALWAYS bigint in base units (lamports, wei, micro-USDC).
 * Nothing in the amount path is ever a JS number: 2^53 is smaller than the
 * supply of many tokens, and decimal fractions are not representable in binary
 * floating point. A float that is wrong in the 15th digit is a rounding error
 * in a report and a failed transaction on-chain.
 *
 * Floats appear in this codebase only for things that are genuinely estimates
 * and never settle on-chain: price impact percentages, scores, USD display.
 */

/** A token amount in base units, tagged with the decimals needed to render it. */
export interface Amount {
  readonly raw: bigint;
  readonly decimals: number;
}

export const amount = (raw: bigint, decimals: number): Amount => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(`decimals out of range: ${decimals}`);
  }
  return { raw, decimals };
};

const POW10: bigint[] = Array.from({ length: 37 }, (_, i) => 10n ** BigInt(i));

export const pow10 = (n: number): bigint => {
  const p = POW10[n];
  if (p === undefined) throw new RangeError(`pow10 out of range: ${n}`);
  return p;
};

/**
 * Parse a decimal string into base units. Exact: no Number ever touches the value.
 *
 * Rejects more precision than the token can represent rather than silently
 * truncating -- if a user writes 0.0000001 SOL of a 6-decimal token, that is a
 * mistake worth surfacing, not rounding to zero.
 */
export function parseUnits(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new SyntaxError(`not a decimal number: ${JSON.stringify(value)}`);
  }
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf('.');
  const whole = dot === -1 ? body : body.slice(0, dot);
  const frac = dot === -1 ? '' : body.slice(dot + 1);

  if (frac.length > decimals) {
    const excess = frac.slice(decimals).replace(/0+$/, '');
    if (excess.length > 0) {
      throw new RangeError(
        `${value} has more precision than ${decimals} decimals can represent`,
      );
    }
  }
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const raw = BigInt(whole) * pow10(decimals) + BigInt(padded || '0');
  return neg ? -raw : raw;
}

/** Render base units as a decimal string. Exact, no float. */
export function formatUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = pow10(decimals);
  const whole = v / base;
  const frac = v % base;
  const sign = neg ? '-' : '';
  if (decimals === 0) return `${sign}${whole}`;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fracStr.length === 0 ? `${sign}${whole}` : `${sign}${whole}.${fracStr}`;
}

export const format = (a: Amount): string => formatUnits(a.raw, a.decimals);

/** Multiply then divide, keeping full precision in between. Truncates toward zero. */
export function mulDiv(value: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('division by zero');
  return (value * numerator) / denominator;
}

export const BPS = 10_000n;

/** Apply a basis-point fraction, e.g. bps(1000n, 50n) -> 5n (0.50%). */
export const bps = (value: bigint, points: bigint): bigint => mulDiv(value, points, BPS);

/** Subtract a basis-point fee, e.g. 0.1% Jupiter fee. */
export const lessBps = (value: bigint, points: bigint): bigint => value - bps(value, points);

/**
 * Split an amount into n parts that sum EXACTLY to the original.
 *
 * Remainder is distributed one base unit at a time across the leading parts
 * rather than dropped. Dropping it is how a "$500 monthly" plan quietly
 * becomes $499.99 and leaves dust stranded in an escrow account.
 */
export function splitEvenly(total: bigint, n: number): bigint[] {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`bad split count: ${n}`);
  if (total < 0n) throw new RangeError('cannot split a negative amount');
  const count = BigInt(n);
  const base = total / count;
  const remainder = total % count;
  return Array.from({ length: n }, (_, i) => base + (BigInt(i) < remainder ? 1n : 0n));
}

/**
 * Split proportionally to weights, summing EXACTLY to total.
 *
 * Uses largest-remainder apportionment: floor every share, then hand the
 * leftover base units to whichever legs were rounded down hardest.
 */
export function splitByWeights(total: bigint, weights: readonly number[]): bigint[] {
  if (weights.length === 0) throw new RangeError('no weights given');
  if (weights.some((w) => !(w > 0) || !Number.isFinite(w))) {
    throw new RangeError('weights must be finite and positive');
  }
  // Scale float weights to integers once, up front, so apportionment is exact.
  const SCALE = 1_000_000;
  const scaled = weights.map((w) => BigInt(Math.round(w * SCALE)));
  const sum = scaled.reduce((a, b) => a + b, 0n);
  if (sum <= 0n) throw new RangeError('weights sum to zero');

  const shares = scaled.map((w) => mulDiv(total, w, sum));
  let allocated = shares.reduce((a, b) => a + b, 0n);
  let leftover = total - allocated;

  const remainders = scaled
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));

  let k = 0;
  while (leftover > 0n && remainders.length > 0) {
    const target = remainders[k % remainders.length]!;
    shares[target.i] = shares[target.i]! + 1n;
    leftover -= 1n;
    k++;
  }
  return shares;
}
