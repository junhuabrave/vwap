import test from 'node:test';
import assert from 'node:assert/strict';
import { base58, decodeTransaction } from '../src/venues/solana/transaction.ts';

const shortVec = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  for (;;) {
    if (v < 0x80) { out.push(v); break; }
    out.push((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
};

const key = (fill: number) => new Uint8Array(32).fill(fill);

/** Assemble a legacy transaction by hand, so decoding is tested against bytes we chose. */
function buildTx(o: {
  signatures: Uint8Array[];
  accounts: Uint8Array[];
  blockhash: Uint8Array;
  instructions: { prog: number; accts: number[]; data: number[] }[];
}): string {
  const b: number[] = [];
  b.push(...shortVec(o.signatures.length));
  for (const s of o.signatures) b.push(...s);
  b.push(1, 0, 1);                                   // message header
  b.push(...shortVec(o.accounts.length));
  for (const a of o.accounts) b.push(...a);
  b.push(...o.blockhash);
  b.push(...shortVec(o.instructions.length));
  for (const ix of o.instructions) {
    b.push(ix.prog);
    b.push(...shortVec(ix.accts.length), ...ix.accts);
    b.push(...shortVec(ix.data.length), ...ix.data);
  }
  return Buffer.from(Uint8Array.from(b)).toString('base64');
}

test('base58 matches known Solana addresses', () => {
  // 32 zero bytes is the System program, rendered as 32 '1's.
  assert.equal(base58(new Uint8Array(32)), '1'.repeat(32));
  assert.equal(base58(new Uint8Array([0])), '1');
  assert.equal(base58(new Uint8Array([0, 0, 1])), '112');
});

test('an unsigned transaction is recognised as unsigned', () => {
  const tx = buildTx({
    signatures: [new Uint8Array(64)],
    accounts: [key(1), key(2), new Uint8Array(32)],
    blockhash: key(9),
    instructions: [{ prog: 2, accts: [0, 1], data: [1, 2, 3] }],
  });
  const d = decodeTransaction(tx);
  assert.equal(d.unsigned, true);
  assert.equal(d.signatureSlots, 1);
  assert.equal(d.version, 'legacy');
  assert.equal(d.accounts.length, 3);
  assert.equal(d.recentBlockhash, base58(key(9)));
  assert.deepEqual(d.programIds, ['1'.repeat(32)], 'instruction 0 targets the System program');
});

test('a single non-zero byte anywhere in a signature means signed', () => {
  // This is the check that stops the tool printing something already signed.
  for (const at of [0, 31, 63]) {
    const sig = new Uint8Array(64);
    sig[at] = 1;
    const tx = buildTx({
      signatures: [sig], accounts: [key(1)], blockhash: key(9),
      instructions: [{ prog: 0, accts: [], data: [] }],
    });
    assert.equal(decodeTransaction(tx).unsigned, false, `byte ${at} should mark it signed`);
  }
});

test('multiple signature slots are all inspected', () => {
  const signed = new Uint8Array(64); signed[10] = 7;
  const tx = buildTx({
    signatures: [new Uint8Array(64), signed], accounts: [key(1)], blockhash: key(9),
    instructions: [{ prog: 0, accts: [], data: [] }],
  });
  const d = decodeTransaction(tx);
  assert.equal(d.signatureSlots, 2);
  assert.equal(d.unsigned, false, 'one signed slot is enough to disqualify it');
});

test('instructions with multi-byte lengths still parse', () => {
  // A data length over 127 needs two bytes of short-vec, which is where a
  // hand-rolled parser usually breaks.
  const big = Array.from({ length: 300 }, (_, i) => i % 256);
  const tx = buildTx({
    signatures: [new Uint8Array(64)],
    accounts: [key(1), key(2)],
    blockhash: key(5),
    instructions: [
      { prog: 1, accts: [0], data: big },
      { prog: 0, accts: [0, 1], data: [9] },
    ],
  });
  const d = decodeTransaction(tx);
  assert.equal(d.programIds.length, 2);
  assert.equal(d.recentBlockhash, base58(key(5)));
});

test('malformed input is rejected rather than half-parsed', () => {
  assert.throws(() => decodeTransaction(''), /too short/);
  assert.throws(() => decodeTransaction(Buffer.from(new Uint8Array(70)).toString('base64')), /truncated|implausible/);
  // A signature count of zero is not a transaction.
  const bad = Buffer.from(Uint8Array.from([0, ...new Array(200).fill(0)])).toString('base64');
  assert.throws(() => decodeTransaction(bad), /implausible signature count/);
});

test('versioned transactions report their version', () => {
  const b: number[] = [...shortVec(1), ...new Uint8Array(64), 0x80, 1, 0, 1];
  b.push(...shortVec(1), ...key(3), ...key(4), ...shortVec(0));
  const d = decodeTransaction(Buffer.from(Uint8Array.from(b)).toString('base64'));
  assert.equal(d.version, 0, 'v0 transaction');
  assert.equal(d.unsigned, true);
});
