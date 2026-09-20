/** Terminal formatting. Honours NO_COLOR and non-TTY output. */
const enabled = process.env['NO_COLOR'] === undefined && process.stdout.isTTY === true;
const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const cyan = wrap('36');

import type { Severity } from '../venues/jupiter/safety.ts';

export const severityStyle: Record<Severity, (s: string) => string> = {
  critical: red, high: red, medium: yellow, low: dim, info: dim,
};

export const severityMark: Record<Severity, string> = {
  critical: 'BLOCK', high: 'HIGH', medium: 'WARN', low: 'note', info: 'info',
};

export const usd = (n: number): string =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
  : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K`
  : `$${n.toFixed(2)}`;

export const pct = (n: number, dp = 3): string =>
  Number.isFinite(n) ? `${(n * 100).toFixed(dp)}%` : 'n/a';
