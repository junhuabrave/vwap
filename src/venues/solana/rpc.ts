/**
 * Minimal Solana JSON-RPC client. Read-only: it simulates and inspects, and
 * has no code path that submits anything.
 *
 * Simulation is the difference between "these bytes are well formed" and "a
 * validator agrees this transaction would succeed". Decoding a transaction
 * proves it calls the right program with the right amounts; only simulation
 * catches a missing token account, an empty wallet, or an instruction that
 * reverts. Both checks are cheap, and neither costs a fee.
 */

export const MAINNET = 'https://api.mainnet-beta.solana.com';

export const rpcUrl = (): string =>
  process.env['SOLANA_RPC']?.trim() || MAINNET;

export class RpcError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

async function call(url: string, method: string, params: unknown[], timeoutMs = 20_000): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      result?: unknown; error?: { message?: string; code?: number };
    };
    if (body.error) throw new RpcError(`${method}: ${body.error.message ?? 'rpc error'}`, body.error.code);
    if (!res.ok) throw new RpcError(`${method}: HTTP ${res.status}`, res.status);
    return body.result;
  } catch (err) {
    if (err instanceof RpcError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new RpcError(`${method}: timed out after ${timeoutMs}ms`);
    }
    throw new RpcError(`${method}: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface SimulationResult {
  /** null when the transaction would succeed. */
  readonly err: unknown;
  readonly logs: readonly string[];
  readonly unitsConsumed: number | undefined;
}

/**
 * Simulate an unsigned transaction.
 *
 * `sigVerify: false` is what makes this possible on an unsigned transaction --
 * the signature slot is still zeroed. `replaceRecentBlockhash: true` swaps in a
 * live blockhash so an expired one does not masquerade as a broken
 * instruction; blockhash freshness is checked separately, at emit time.
 */
export async function simulate(txBase64: string, url = rpcUrl()): Promise<SimulationResult> {
  const result = (await call(url, 'simulateTransaction', [
    txBase64,
    { sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64', commitment: 'confirmed' },
  ])) as { value?: { err?: unknown; logs?: string[]; unitsConsumed?: number } };
  const v = result?.value ?? {};
  return {
    err: v.err ?? null,
    logs: v.logs ?? [],
    unitsConsumed: v.unitsConsumed,
  };
}

/** Lamports held by an address. Zero for an address that does not exist. */
export async function solBalance(pubkey: string, url = rpcUrl()): Promise<bigint> {
  const r = (await call(url, 'getBalance', [pubkey, { commitment: 'confirmed' }])) as { value?: number };
  return BigInt(r?.value ?? 0);
}

/**
 * An owner's balance of one SPL mint, summed across their token accounts.
 *
 * Summed rather than taking the first account: a wallet can hold several
 * accounts for the same mint, and reporting only one would understate the
 * balance and produce a false "insufficient funds".
 */
export async function splBalance(owner: string, mint: string, url = rpcUrl()): Promise<bigint> {
  const r = (await call(url, 'getTokenAccountsByOwner', [
    owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' },
  ])) as {
    value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }>;
  };
  let total = 0n;
  for (const acct of r?.value ?? []) {
    const amt = acct.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (amt !== undefined) total += BigInt(amt);
  }
  return total;
}

/** Is this blockhash still valid, i.e. would the transaction still land? */
export async function blockhashValid(blockhash: string, url = rpcUrl()): Promise<boolean> {
  const r = (await call(url, 'isBlockhashValid', [blockhash, { commitment: 'confirmed' }])) as { value?: boolean };
  return r?.value === true;
}
