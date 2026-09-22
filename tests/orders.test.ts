import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OrderTooSmallError, chunkPeriods, createDcaOrder, requestFromSpec, type OrderSpec,
} from '../src/venues/jupiter/orders.ts';
import { INTERVAL_SECONDS, JUPITER, MIN_ORDER_USD } from '../src/venues/jupiter/capabilities.ts';
import { parseUnits, splitByWeights, formatUnits } from '../src/core/money.ts';

test('chunking keeps the period count exact', () => {
  assert.deepEqual(chunkPeriods(48, 12), [12, 12, 12, 12]);
  assert.deepEqual(chunkPeriods(48), [48], 'no chunk size means one order');
  // A remainder becomes a short final chunk rather than being dropped.
  assert.deepEqual(chunkPeriods(50, 12), [12, 12, 12, 12, 2]);
  assert.deepEqual(chunkPeriods(5, 12), [5]);
  for (const [periods, size] of [[48, 12], [50, 12], [7, 3], [1, 1]] as const) {
    assert.equal(chunkPeriods(periods, size).reduce((a, b) => a + b, 0), periods);
  }
});

test('chunking rejects nonsense', () => {
  assert.throws(() => chunkPeriods(0), /at least 1/);
  assert.throws(() => chunkPeriods(12, 0), /at least 1/);
});

test('chunking is what limits capital escrowed up front', () => {
  // Jupiter escrows the whole deposit on creation, so the first chunk is the
  // real commitment. This is the number the CLI has to show.
  const perPeriod = parseUnits('100', 6);
  const chunks = chunkPeriods(48, 12);
  const escrowedNow = perPeriod * BigInt(chunks[0]!);
  const wholePlan = perPeriod * 48n;
  assert.equal(formatUnits(escrowedNow, 6), '1200');
  assert.equal(formatUnits(wholePlan, 6), '4800');
  assert.ok(escrowedNow < wholePlan, 'chunking must reduce what is locked today');
});

test('a $500 budget only splits so many ways before Jupiter refuses', () => {
  const budget = parseUnits('500', 6);
  const perLeg = (n: number) =>
    Number(formatUnits(splitByWeights(budget, Array(n).fill(1))[0]!, 6));
  assert.ok(perLeg(5) >= MIN_ORDER_USD, '5 legs at $100 each is fine');
  assert.equal(perLeg(10), MIN_ORDER_USD, '10 legs lands exactly on the $50 floor');
  assert.ok(perLeg(11) < MIN_ORDER_USD, '11 legs at $45.45 is refused');
  // The practical ceiling for a $500 monthly budget.
  assert.equal(Math.floor(500 / MIN_ORDER_USD), 10);
});

test('OrderTooSmallError explains the fix, not just the failure', () => {
  const err = new OrderTooSmallError(40);
  assert.match(err.message, /\$40\.00/);
  assert.match(err.message, new RegExp(`\\$${MIN_ORDER_USD} minimum`));
  assert.match(err.message, /Raise the budget|cut the number of legs/);
});

test('Jupiter capabilities describe what the engine needs to know', () => {
  assert.equal(JUPITER.minOrderUsd, MIN_ORDER_USD);
  assert.equal(JUPITER.escrow, 'upfront', 'Jupiter locks the whole deposit on creation');
  assert.equal(JUPITER.intervalSemantics, 'fixed-seconds', 'so "the 1st" is not expressible');
  assert.equal(JUPITER.intervalSeconds.monthly, INTERVAL_SECONDS.monthly);
  assert.ok(JUPITER.fixedCostPerFillUsd < 0.05, 'a Solana fill is cheap enough that slicing is nearly free');
});

test('monthly is 30 days, not a calendar month', () => {
  // Jupiter schedules by fixed seconds. This gap is why a plan cannot promise
  // "the 1st of the month", and the CLI has to say so.
  assert.equal(INTERVAL_SECONDS.monthly, 2_592_000);
  const calendarMonth = 2_629_746;
  const driftDays = (48 * (calendarMonth - INTERVAL_SECONDS.monthly)) / 86_400;
  assert.ok(driftDays > 20 && driftDays < 22, `expected ~21 days of drift, got ${driftDays}`);
});

test('createDcaOrder validates before it reaches the network', async () => {
  const base = {
    user: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    outputMint: 'So11111111111111111111111111111111111111112',
    totalDeposit: 1_000_000n,
    numberOfOrders: 12,
    intervalSeconds: INTERVAL_SECONDS.monthly,
  };
  await assert.rejects(() => createDcaOrder({ ...base, numberOfOrders: 0 }), /at least 1/);
  await assert.rejects(() => createDcaOrder({ ...base, totalDeposit: 0n }), /must be positive/);
});


test('a spec is durable where a transaction is not', () => {
  // A Solana transaction dies with its blockhash after ~90s, so what gets
  // written to disk is the intent. Anything resembling a transaction in a spec
  // would be scrap by the time it was read.
  const spec: OrderSpec = {
    leg: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    wallet: 'So11111111111111111111111111111111111111112',
    depositUsdc: '1200', numberOfOrders: 12,
    intervalSeconds: INTERVAL_SECONDS.monthly,
  };
  assert.ok(!('transaction' in spec), 'specs must not carry a transaction');
  assert.ok(!('unsignedTransaction' in spec));
  // Round-trips through JSON without losing anything.
  assert.deepEqual(JSON.parse(JSON.stringify(spec)), spec);
});

test('requestFromSpec rebuilds exactly what the spec described', () => {
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const base: OrderSpec = {
    leg: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    wallet: 'So11111111111111111111111111111111111111112',
    depositUsdc: '1200', numberOfOrders: 12,
    intervalSeconds: INTERVAL_SECONDS.monthly,
  };
  const deposit = parseUnits(base.depositUsdc, 6);
  const req = requestFromSpec(base, usdc, deposit);
  assert.equal(req.user, base.wallet);
  assert.equal(req.inputMint, usdc);
  assert.equal(req.outputMint, base.mint);
  assert.equal(req.totalDeposit, 1_200_000_000n);
  assert.equal(req.numberOfOrders, 12);
  assert.equal(req.startAt, undefined, 'absent startAt must not appear');

  // A later chunk carries its start time through.
  const dated = requestFromSpec({ ...base, startAt: 1_800_000_000 }, usdc, deposit);
  assert.equal(dated.startAt, 1_800_000_000);
});
