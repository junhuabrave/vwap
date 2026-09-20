import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUnits, formatUnits, splitEvenly, splitByWeights, mulDiv, bps, lessBps,
} from '../src/core/money.ts';

test('parseUnits is exact where floats are not', () => {
  // 0.1 + 0.2 !== 0.3 in float; in base units it is exact.
  assert.equal(parseUnits('0.1', 6) + parseUnits('0.2', 6), parseUnits('0.3', 6));
  assert.equal(parseUnits('1', 9), 1_000_000_000n);
  assert.equal(parseUnits('0.000001', 6), 1n);
  assert.equal(parseUnits('123.456789', 6), 123_456_789n);
  // A value larger than Number.MAX_SAFE_INTEGER survives intact.
  assert.equal(parseUnits('9007199254.740993', 9), 9_007_199_254_740_993_000n);
});

test('parseUnits rejects precision the token cannot hold', () => {
  assert.throws(() => parseUnits('0.0000001', 6), /more precision/);
  // Trailing zeros beyond the decimals are harmless, not an error.
  assert.equal(parseUnits('1.5000000', 6), 1_500_000n);
  assert.throws(() => parseUnits('abc', 6), /not a decimal/);
  assert.throws(() => parseUnits('1e9', 6), /not a decimal/);
});

test('formatUnits round-trips', () => {
  for (const [v, d] of [['0.1', 6], ['123.456789', 6], ['1', 9], ['0', 6]] as const) {
    assert.equal(formatUnits(parseUnits(v, d), d), String(Number(v)));
  }
  assert.equal(formatUnits(1n, 9), '0.000000001');
  assert.equal(formatUnits(-1_500_000n, 6), '-1.5');
});

test('splitEvenly conserves every base unit', () => {
  for (const [total, n] of [[100n, 3], [500_000_000n, 48], [7n, 8], [0n, 4]] as const) {
    const parts = splitEvenly(total, n);
    assert.equal(parts.length, n);
    assert.equal(parts.reduce((a, b) => a + b, 0n), total, `total ${total} / ${n}`);
    // Parts differ by at most one base unit.
    assert.ok(parts.reduce((a, b) => (a > b ? a : b)) - parts.reduce((a, b) => (a < b ? a : b)) <= 1n);
  }
});

test('$500 across 48 months leaves no dust', () => {
  const total = parseUnits('24000', 6); // 4 years of $500, in micro-USDC
  const months = splitEvenly(total, 48);
  assert.equal(months.reduce((a, b) => a + b, 0n), total);
  assert.ok(months.every((m) => m === parseUnits('500', 6)));
});

test('splitByWeights conserves the total and honours proportions', () => {
  const total = parseUnits('500', 6);
  const equal = splitByWeights(total, [1, 1, 1, 1, 1]);
  assert.equal(equal.reduce((a, b) => a + b, 0n), total);
  assert.ok(equal.every((p) => p === parseUnits('100', 6)));

  // An indivisible split still conserves exactly.
  const awkward = splitByWeights(100n, [1, 1, 1]);
  assert.equal(awkward.reduce((a, b) => a + b, 0n), 100n);

  const skewed = splitByWeights(parseUnits('1000', 6), [50, 30, 20]);
  assert.equal(skewed.reduce((a, b) => a + b, 0n), parseUnits('1000', 6));
  assert.equal(skewed[0], parseUnits('500', 6));
  assert.equal(skewed[1], parseUnits('300', 6));
  assert.equal(skewed[2], parseUnits('200', 6));
});

test('splitByWeights rejects nonsense', () => {
  assert.throws(() => splitByWeights(100n, []), /no weights/);
  assert.throws(() => splitByWeights(100n, [1, 0]), /positive/);
  assert.throws(() => splitByWeights(100n, [1, NaN]), /finite/);
});

test('mulDiv keeps precision that float would lose', () => {
  const big = 2n ** 80n;
  assert.equal(mulDiv(big, 3n, 7n), (big * 3n) / 7n);
  assert.throws(() => mulDiv(1n, 1n, 0n), /division by zero/);
});

test('basis points', () => {
  assert.equal(bps(1_000n, 50n), 5n);            // 0.50%
  assert.equal(bps(parseUnits('100', 6), 10n), parseUnits('0.1', 6)); // 0.1% Jupiter fee
  assert.equal(lessBps(parseUnits('100', 6), 10n), parseUnits('99.9', 6));
});
