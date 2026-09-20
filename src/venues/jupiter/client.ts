/** Thin, typed client for Jupiter's public API. Read-only: it never signs. */

const LITE = 'https://lite-api.jup.ag';

export interface JupTokenStats {
  readonly buyVolume?: number;
  readonly sellVolume?: number;
  readonly numTraders?: number;
  readonly priceChange?: number;
}

export interface JupToken {
  readonly id: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly dev?: string;
  readonly circSupply?: number;
  readonly totalSupply?: number;
  readonly tokenProgram?: string;
  readonly mintAuthority?: string | null;
  readonly holderCount?: number;
  readonly mcap?: number | null;
  readonly fdv?: number | null;
  readonly usdPrice?: number;
  readonly liquidity?: number;
  readonly isVerified?: boolean;
  readonly tags?: readonly string[];
  readonly organicScore?: number;
  readonly firstPool?: { readonly createdAt?: string };
  readonly audit?: {
    readonly freezeAuthorityDisabled?: boolean;
    readonly mintAuthorityDisabled?: boolean;
    readonly topHoldersPercentage?: number;
    readonly devMints?: number;
  };
  readonly stats24h?: JupTokenStats;
}

export interface JupRoutePlanEntry {
  readonly swapInfo: { readonly label?: string; readonly ammKey?: string };
}

export interface JupQuote {
  readonly inputMint: string;
  readonly inAmount: string;
  readonly outputMint: string;
  readonly outAmount: string;
  readonly otherAmountThreshold: string;
  readonly priceImpactPct: string;
  readonly slippageBps: number;
  readonly routePlan: readonly JupRoutePlanEntry[];
}

export class JupiterError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'JupiterError';
    this.status = status;
  }
}

async function getJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json' },
    });
    const body = await res.text();
    if (!res.ok) {
      throw new JupiterError(`${res.status} from ${new URL(url).pathname}: ${body.slice(0, 200)}`, res.status);
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new JupiterError(`non-JSON response from ${new URL(url).pathname}: ${body.slice(0, 120)}`);
    }
  } catch (err) {
    if (err instanceof JupiterError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new JupiterError(`timed out after ${timeoutMs}ms: ${url}`);
    }
    throw new JupiterError(`request failed: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search tokens by symbol, name, or mint address.
 *
 * Returns ALL matches, deliberately. Callers must not assume the first hit is
 * the intended token -- resolving a ticker to a single mint without showing the
 * collisions is how people buy the wrong asset.
 */
export async function searchTokens(query: string): Promise<JupToken[]> {
  const raw = await getJson(`${LITE}/tokens/v2/search?query=${encodeURIComponent(query)}`);
  const list = Array.isArray(raw)
    ? raw
    : (raw as { tokens?: unknown[]; data?: unknown[] }).tokens ??
      (raw as { data?: unknown[] }).data ??
      [];
  return (list as JupToken[]).filter((t) => typeof t?.id === 'string');
}

export async function getToken(mint: string): Promise<JupToken | undefined> {
  const hits = await searchTokens(mint);
  return hits.find((t) => t.id === mint);
}

/** Quote an exact-in swap. `amount` is in input-token base units. */
export async function quote(params: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
}): Promise<JupQuote> {
  const q = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount.toString(),
    slippageBps: String(params.slippageBps),
  });
  const raw = (await getJson(`${LITE}/swap/v1/quote?${q}`)) as JupQuote & { error?: string };
  if (raw.error) throw new JupiterError(`no route: ${raw.error}`);
  if (!raw.outAmount) throw new JupiterError('quote response missing outAmount');
  return raw;
}

/**
 * Jupiter's DCA fee, in basis points.
 *
 * 0.1% as documented for the Recurring API. Jupiter has since folded DCA into
 * Trigger V2, which unifies price orders and DCA behind one vault and deposit
 * flow; the older Recurring API is unmaintained. Re-verify this rate against
 * Trigger V2 before relying on it for order placement -- Jupiter prices limit
 * orders differently for stable pairs, and DCA may follow.
 */
export const DCA_FEE_BPS = 10;
