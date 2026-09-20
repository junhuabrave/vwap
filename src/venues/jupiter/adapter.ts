/** Jupiter adapter: resolves tokens and supplies quotes to the core engine. */
import type { Token } from '../../core/types.ts';
import type { QuoteFn } from '../../core/impact.ts';
import { getToken, quote, searchTokens, type JupToken } from './client.ts';
import { looksLikeMint } from './safety.ts';

export const USDC: Token = {
  chain: 'solana',
  address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
};

export const toToken = (t: JupToken): Token => ({
  chain: 'solana',
  address: t.id,
  symbol: t.symbol,
  name: t.name,
  decimals: t.decimals,
});

export interface Resolution {
  readonly token: JupToken;
  /** Every other token sharing the requested symbol. Never silently discarded. */
  readonly collisions: readonly JupToken[];
  readonly resolvedBy: 'mint' | 'ticker';
}

export class AmbiguousTokenError extends Error {
  readonly query: string;
  readonly candidates: readonly JupToken[];
  constructor(query: string, candidates: readonly JupToken[]) {
    super(
      `"${query}" matches ${candidates.length} tokens. Specify the mint address:\n` +
        candidates
          .map((c) => `    ${c.id}  ${c.symbol.padEnd(8)} ${c.name}`)
          .join('\n'),
    );
    this.name = 'AmbiguousTokenError';
    this.query = query;
    this.candidates = candidates;
  }
}

/**
 * Resolve a user's token reference to exactly one mint.
 *
 * A mint address resolves directly. A ticker is matched case-insensitively and
 * exactly -- and if more than one verified token answers to it, this throws
 * rather than picking. There is no sensible default when two tokens share a
 * ticker; guessing is how people buy the wrong asset.
 */
export async function resolveToken(query: string): Promise<Resolution> {
  const q = query.trim();
  if (looksLikeMint(q)) {
    const hit = await getToken(q);
    if (!hit) throw new Error(`no token found for mint ${q}`);
    return { token: hit, collisions: [], resolvedBy: 'mint' };
  }

  const hits = await searchTokens(q);
  const exact = hits.filter((t) => t.symbol?.toUpperCase() === q.toUpperCase());
  if (exact.length === 0) {
    throw new Error(
      `no token with ticker "${q}". Closest names: ` +
        (hits.slice(0, 3).map((t) => `${t.symbol} (${t.name})`).join(', ') || 'none'),
    );
  }

  // Prefer verified tokens, then deepest liquidity -- but only to order the
  // candidate list, never to auto-pick when the choice is genuinely contested.
  const ranked = [...exact].sort((a, b) => {
    if (a.isVerified !== b.isVerified) return a.isVerified ? -1 : 1;
    return (b.liquidity ?? 0) - (a.liquidity ?? 0);
  });

  const verified = ranked.filter((t) => t.isVerified);
  const leader = ranked[0]!;
  // Contested when several verified tokens share the ticker, or when the top
  // unverified candidate is within 10x the liquidity of the leader.
  const contested =
    verified.length > 1 ||
    ranked.slice(1).some((t) => (t.liquidity ?? 0) * 10 > (leader.liquidity ?? 0));
  if (contested) throw new AmbiguousTokenError(q, ranked.slice(0, 6));

  return { token: leader, collisions: ranked.slice(1), resolvedBy: 'ticker' };
}

/** A quote function bound to one funding/output pair, for impact probing. */
export function makeQuoteFn(funding: Token, out: Token, slippageBps: number): QuoteFn {
  return async (spend: bigint) => {
    const q = await quote({
      inputMint: funding.address,
      outputMint: out.address,
      amount: spend,
      slippageBps,
    });
    return {
      outAmount: BigInt(q.outAmount),
      priceImpactPct: Number(q.priceImpactPct) * 100,
      routeLabels: q.routePlan.map((r) => r.swapInfo.label ?? '?'),
    };
  };
}
