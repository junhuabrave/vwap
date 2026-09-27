import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/web/server.ts';
import type { AddressInfo } from 'node:net';

/** Boot the app on an ephemeral port for the duration of one test. */
async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('serves the page and its assets, and nothing else', async () => {
  await withServer(async (base) => {
    for (const [path, type] of [['/', 'text/html'], ['/app.css', 'text/css'], ['/app.js', 'text/javascript']] as const) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.ok(res.headers.get('content-type')?.startsWith(type), `${path} content-type`);
    }
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});

test('a request path never becomes a file path', async () => {
  // The static table is a fixed allow-list, so traversal has nothing to walk.
  await withServer(async (base) => {
    for (const path of [
      '/../package.json', '/../../etc/passwd', '/%2e%2e/package.json', '/app.js/../../LICENSE',
    ]) {
      const res = await fetch(base + path, { redirect: 'manual' });
      assert.equal(res.status, 404, `${path} must not resolve`);
    }
  });
});

test('bad input is a 400 with a usable message, not a stack trace', async () => {
  await withServer(async (base) => {
    const post = (path: string, body: unknown) =>
      fetch(base + path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });

    const noLegs = await post('/api/plan', { legs: '', budget: '100', periods: 4 });
    assert.equal(noLegs.status, 400);
    assert.match((await noLegs.json() as { error: string }).error, /no legs/);

    const badCadence = await post('/api/plan', { legs: 'SOL', budget: '100', cadence: 'hourly', periods: 4 });
    assert.equal(badCadence.status, 400);
    assert.match((await badCadence.json() as { error: string }).error, /bad cadence/);

    // A secret key must be refused before anything touches the network.
    const secret = await post('/api/order', {
      legs: 'SOL', budget: '100', periods: 4,
      wallet: '5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviUkouzc3uSpwaCpxAWjXrf1KpNiNmvXF23FKqNQjSSgv',
    });
    assert.equal(secret.status, 400);
    assert.match((await secret.json() as { error: string }).error, /SECRET key/);

    assert.equal((await post('/api/emit', {})).status, 400);
    assert.equal((await post('/api/nonsense', {})).status, 404);
  });
});

test('GET on an api route is rejected', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/plan`)).status, 404);
    assert.equal((await fetch(`${base}/app.css`, { method: 'POST' })).status, 405);
  });
});

test('no CORS headers are granted', async () => {
  // The page is same-origin; handing out CORS would let any site drive it.
  await withServer(async (base) => {
    const res = await fetch(base + '/');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});
