/**
 * Just enough Solana wire-format parsing to check a transaction before signing.
 *
 * Deliberately not a transaction library: this reads what it needs to answer
 * two questions a user is entitled to have answered before they sign anything.
 * Is it really unsigned? And is its blockhash still alive, or is it already
 * scrap? Both were verified by hand once; code that runs every time is better
 * than a check someone remembered to do.
 */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58-encode, Bitcoin alphabet, preserving leading-zero bytes as '1'. */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    const r = Number(n % 58n);
    out = B58[r] + out;
    n /= 58n;
  }
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading++;
  return '1'.repeat(leading) + (out || (bytes.length ? '' : ''));
}

/** Read a compact-u16 (Solana's "short vec" length prefix). */
function shortVec(buf: Uint8Array, pos: number): [number, number] {
  let n = 0, shift = 0, p = pos;
  for (;;) {
    const byte = buf[p];
    if (byte === undefined) throw new RangeError('truncated transaction');
    p++;
    n |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 21) throw new RangeError('malformed length prefix');
  }
  return [n, p];
}

export interface DecodedTransaction {
  readonly signatureSlots: number;
  /** True when every signature slot is 64 zero bytes. */
  readonly unsigned: boolean;
  readonly version: 'legacy' | number;
  readonly accounts: readonly string[];
  readonly recentBlockhash: string;
  readonly programIds: readonly string[];
}

/** Parse the fields needed to vet a transaction. Throws on anything malformed. */
export function decodeTransaction(txBase64: string): DecodedTransaction {
  const raw = Uint8Array.from(Buffer.from(txBase64, 'base64'));
  if (raw.length < 64) throw new RangeError('too short to be a transaction');

  let pos = 0;
  let nsig: number;
  [nsig, pos] = shortVec(raw, pos);
  if (nsig < 1 || nsig > 16) throw new RangeError(`implausible signature count: ${nsig}`);

  let unsigned = true;
  for (let i = 0; i < nsig; i++) {
    const sig = raw.subarray(pos + i * 64, pos + (i + 1) * 64);
    if (sig.length !== 64) throw new RangeError('truncated signature');
    if (sig.some((b) => b !== 0)) unsigned = false;
  }
  pos += nsig * 64;

  const first = raw[pos];
  if (first === undefined) throw new RangeError('truncated message');
  const versioned = (first & 0x80) !== 0;
  const version: 'legacy' | number = versioned ? (first & 0x7f) : 'legacy';
  if (versioned) pos += 1;

  pos += 3; // message header: required sigs, readonly signed, readonly unsigned

  let nacct: number;
  [nacct, pos] = shortVec(raw, pos);
  const accounts: string[] = [];
  for (let i = 0; i < nacct; i++) {
    const key = raw.subarray(pos, pos + 32);
    if (key.length !== 32) throw new RangeError('truncated account key');
    accounts.push(base58(key));
    pos += 32;
  }

  const bh = raw.subarray(pos, pos + 32);
  if (bh.length !== 32) throw new RangeError('truncated blockhash');
  const recentBlockhash = base58(bh);
  pos += 32;

  let nix: number;
  [nix, pos] = shortVec(raw, pos);
  const programIds: string[] = [];
  for (let i = 0; i < nix; i++) {
    const progIdx = raw[pos];
    if (progIdx === undefined) throw new RangeError('truncated instruction');
    pos += 1;
    const id = accounts[progIdx];
    if (id !== undefined) programIds.push(id);
    let na: number;
    [na, pos] = shortVec(raw, pos);
    pos += na;
    let dl: number;
    [dl, pos] = shortVec(raw, pos);
    pos += dl;
  }

  return { signatureSlots: nsig, unsigned, version, accounts, recentBlockhash, programIds };
}
