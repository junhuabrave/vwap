/**
 * Local web server for vwap.
 *
 * Why a server at all, rather than a page that talks to Jupiter directly: the
 * engine is already written and tested, and running it server-side means the
 * browser and the CLI cannot drift apart on what a plan costs. It also keeps
 * the wallet where it belongs -- the page connects it and signs there, so a
 * signature never crosses this process. There is no code path here that signs
 * or submits anything.
 *
 * Bound to loopback only. This serves a fixed set of files and four endpoints;
 * no path from a request reaches the filesystem, so there is nothing to
 * traverse.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrderSpec } from '../venues/jupiter/orders.ts';
import { AmbiguousTokenError } from '../venues/jupiter/adapter.ts';
import { emitWithPreflight, orderSpecs, planReport } from '../app/service.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Only these files are servable. A request path never becomes a file path. */
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'app.html', type: 'text/html; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

const MAX_BODY = 256 * 1024;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
};

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));

async function handleApi(path: string, body: unknown, res: ServerResponse): Promise<void> {
  const b = (body ?? {}) as Record<string, unknown>;

  if (path === '/api/plan') {
    return send(res, 200, await planReport({
      legs: str(b['legs']), budget: str(b['budget']), cadence: str(b['cadence'] ?? 'monthly'),
      periods: num(b['periods'], 48), dayOfMonth: num(b['dayOfMonth'], 1),
      slippageBps: num(b['slippageBps'], 50),
    }));
  }

  if (path === '/api/order') {
    const chunkRaw = b['chunk'];
    const chunk = chunkRaw === undefined || chunkRaw === null || chunkRaw === '' ? undefined : num(chunkRaw, 0);
    return send(res, 200, await orderSpecs({
      legs: str(b['legs']), budget: str(b['budget']), cadence: str(b['cadence'] ?? 'monthly'),
      periods: num(b['periods'], 48), wallet: str(b['wallet']),
      ...(chunk !== undefined && chunk > 0 ? { chunk } : {}),
      validate: b['validate'] === true,
    }));
  }

  if (path === '/api/emit') {
    const spec = b['spec'] as OrderSpec | undefined;
    if (!spec || typeof spec !== 'object') throw new Error('emit needs a "spec"');
    return send(res, 200, await emitWithPreflight(spec, { check: b['check'] !== false }));
  }

  send(res, 404, { error: `no such endpoint: ${path}` });
}

export function createApp() {
  return createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      try {
        // Same-origin only: the page is served from here and fetches relative
        // URLs, so no CORS headers are needed and none are granted.
        if (req.method === 'GET') {
          const entry = STATIC[path];
          if (!entry) return send(res, 404, { error: 'not found' });
          const content = await readFile(join(HERE, entry.file));
          res.writeHead(200, { 'content-type': entry.type, 'cache-control': 'no-store' });
          return res.end(content);
        }
        if (req.method === 'POST' && path.startsWith('/api/')) {
          return await handleApi(path, await readBody(req), res);
        }
        send(res, 405, { error: 'method not allowed' });
      } catch (err) {
        // Ambiguity is a user-correctable 409, not a server fault: the caller
        // has to name a mint, and the candidate list is the useful part.
        if (err instanceof AmbiguousTokenError) {
          return send(res, 409, {
            error: err.message,
            ambiguous: true,
            candidates: err.candidates.map((c) => ({
              mint: c.id, symbol: c.symbol, name: c.name,
              liquidity: c.liquidity ?? 0, verified: c.isVerified === true,
            })),
          });
        }
        send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}

export function serve(port: number, host = '127.0.0.1'): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createApp();
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve(`http://${host}:${actual}`);
    });
  });
}
