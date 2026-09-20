/**
 * Token safety audit.
 *
 * Buying the wrong token is the single most common way retail loses money on
 * Solana, and it almost never looks like a hack -- it looks like a ticker that
 * matched. This module refuses to let a plan be built on a symbol alone, and
 * surfaces the properties that decide whether a token is safe to accumulate
 * into for years rather than minutes.
 *
 * A long horizon changes which risks matter. A live mint authority is survivable
 * for a day trade and disqualifying for a four-year position. Shallow liquidity
 * barely affects a $100 entry and dominates the eventual exit.
 */
import type { JupToken } from './client.ts';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
}

export type Verdict = 'ok' | 'caution' | 'blocked';

export interface TokenAudit {
  readonly token: JupToken;
  readonly findings: readonly Finding[];
  readonly verdict: Verdict;
}

export interface AuditContext {
  /** USD spent per individual buy. */
  readonly perBuyUsd?: number;
  /** USD the plan will have accumulated by the end. Drives exit-liquidity risk. */
  readonly totalPositionUsd?: number;
  /** Other tokens sharing this symbol, if the user resolved by ticker. */
  readonly collisions?: readonly JupToken[];
}

const pct = (n: number) => `${n.toFixed(2)}%`;
const usd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000 ? `$${(n / 1_000).toFixed(0)}K`
  : `$${n.toFixed(0)}`;

export function auditToken(token: JupToken, ctx: AuditContext = {}): TokenAudit {
  const f: Finding[] = [];
  const liq = token.liquidity ?? 0;

  // --- Identity -----------------------------------------------------------
  const rivals = (ctx.collisions ?? []).filter(
    (t) => t.id !== token.id && t.symbol?.toUpperCase() === token.symbol?.toUpperCase(),
  );
  if (rivals.length > 0) {
    f.push({
      severity: 'critical',
      code: 'ticker-collision',
      message:
        `${rivals.length} other token${rivals.length > 1 ? 's' : ''} also trade${rivals.length > 1 ? '' : 's'} as ` +
        `${token.symbol}: ${rivals.map((r) => `${r.name} (${r.id.slice(0, 8)}...)`).join(', ')}. ` +
        `Confirm the mint address, not the ticker.`,
    });
  }
  if (token.isVerified !== true) {
    f.push({
      severity: 'high',
      code: 'unverified',
      message: 'Not on Jupiter\'s verified list. Treat the identity as unconfirmed.',
    });
  }

  // --- Supply control -----------------------------------------------------
  // A live mint authority means the supply can grow without warning. Over a
  // multi-year hold that is a standing dilution risk, not a theoretical one.
  const mintAuthDisabled =
    token.audit?.mintAuthorityDisabled === true ||
    token.mintAuthority === null ||
    token.mintAuthority === undefined;
  if (!mintAuthDisabled) {
    f.push({
      severity: 'high',
      code: 'mint-authority-live',
      message:
        `Mint authority is still active (${String(token.mintAuthority).slice(0, 8)}...). ` +
        `Supply can be increased at any time. This is normal for bridged assets and ` +
        `dangerous for everything else -- verify which this is.`,
    });
  }
  if (token.audit?.freezeAuthorityDisabled === false) {
    f.push({
      severity: 'high',
      code: 'freeze-authority-live',
      message: 'Freeze authority is active: your balance can be frozen by the issuer.',
    });
  }
  const devMints = token.audit?.devMints ?? 0;
  if (devMints > 1) {
    f.push({
      severity: 'medium',
      code: 'repeated-mints',
      message: `Supply has been minted ${devMints} separate times.`,
    });
  }

  // --- Liquidity ----------------------------------------------------------
  // Entry and exit are different problems. A $100 buy is trivially absorbed by
  // almost any pool; the position built over years is what has to get back out.
  if (liq <= 0) {
    f.push({ severity: 'critical', code: 'no-liquidity', message: 'No measurable on-chain liquidity.' });
  } else {
    if (ctx.perBuyUsd !== undefined) {
      const share = (ctx.perBuyUsd / liq) * 100;
      if (share > 1) {
        f.push({
          severity: share > 5 ? 'high' : 'medium',
          code: 'entry-size',
          message: `Each ${usd(ctx.perBuyUsd)} buy is ${pct(share)} of ${usd(liq)} pool liquidity.`,
        });
      }
    }
    if (ctx.totalPositionUsd !== undefined) {
      const share = (ctx.totalPositionUsd / liq) * 100;
      if (share > 2) {
        f.push({
          severity: share > 20 ? 'critical' : share > 10 ? 'high' : 'medium',
          code: 'exit-liquidity',
          message:
            `The finished position (${usd(ctx.totalPositionUsd)}) would be ${pct(share)} of today's ` +
            `${usd(liq)} liquidity. Entering is cheap; selling this back is the hard part.`,
        });
      }
    }
    const vol = (token.stats24h?.buyVolume ?? 0) + (token.stats24h?.sellVolume ?? 0);
    if (vol > 0 && liq > 0 && vol / liq > 20) {
      f.push({
        severity: 'low',
        code: 'high-turnover',
        message: `24h volume is ${(vol / liq).toFixed(0)}x pool liquidity -- typical of incentivised or wash flow.`,
      });
    }
  }

  // --- Distribution and age ----------------------------------------------
  const top = token.audit?.topHoldersPercentage;
  if (top !== undefined && top > 30) {
    f.push({
      severity: top > 60 ? 'high' : 'medium',
      code: 'holder-concentration',
      message: `Top holders control ${pct(top)} of supply.`,
    });
  }
  if ((token.holderCount ?? 0) > 0 && (token.holderCount ?? 0) < 1_000) {
    f.push({
      severity: 'medium',
      code: 'few-holders',
      message: `Only ${token.holderCount} holders.`,
    });
  }
  const created = token.firstPool?.createdAt ? Date.parse(token.firstPool.createdAt) : NaN;
  if (Number.isFinite(created)) {
    const days = (Date.now() - created) / 86_400_000;
    if (days < 180) {
      f.push({
        severity: days < 30 ? 'high' : 'medium',
        code: 'young-market',
        message: `First pool created ${Math.round(days)} days ago -- no long price history to average into.`,
      });
    }
  }

  const rank = (s: Severity) => SEVERITIES.indexOf(s);
  const worst = f.reduce<Severity>((acc, x) => (rank(x.severity) < rank(acc) ? x.severity : acc), 'info');
  const verdict: Verdict = worst === 'critical' ? 'blocked' : rank(worst) <= rank('medium') ? 'caution' : 'ok';

  return { token, findings: [...f].sort((a, b) => rank(a.severity) - rank(b.severity)), verdict };
}

/**
 * Resolve user input to exactly one mint.
 *
 * A 32-44 character base58 string is taken as a mint address. Anything else is
 * treated as a ticker, and a ticker that matches more than one token is an
 * error the caller has to resolve -- never a silent "first match wins".
 */
export const looksLikeMint = (s: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
