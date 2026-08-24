/**
 * registry-metadata.ts pure-logic tests (design 18 §4 — abbreviated packument
 * reading) — node:test, no electron, NO real network: a node:http loopback
 * server serves controlled JSON and records the request (URL + Accept
 * header). Covers dist-tags.latest passthrough / max-semver fallback when
 * latest is missing or malformed / missing dist.integrity excluded / semver-
 * descending version order / tarball-less versions excluded / HTTP + JSON +
 * network failures propagating / immutable (frozen) metadata.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchRegistryMetadata, fetchRegistryResponse, type RegistryMetadata } from './registry-metadata.ts';
import { registryRedirectOrigins } from './registry-url.ts';

const SRI_A = `sha512-${Buffer.alloc(64, 0xaa).toString('base64')}`;
const SRI_C = `sha512-${Buffer.alloc(64, 0xcc).toString('base64')}`;

interface ServedRequest {
  url: string;
  accept: string | null;
}

/** Abbreviated packument fixture (install-v1+json shape, design 18 §4). */
const fixture = (origin = 'https://registry.npmjs.org') => ({
  'dist-tags': { latest: '0.2.0' },
  versions: {
    '0.2.0': {
      dist: { tarball: `${origin}/@deepseek-ai/dsh/-/dsh-0.2.0.tgz`, integrity: SRI_A, unpackedSize: 456 },
    },
    '0.1.1': {
      // dist present, integrity absent → not safely installable, excluded.
      dist: { tarball: `${origin}/@deepseek-ai/dsh/-/dsh-0.1.1.tgz`, unpackedSize: 123 },
    },
    '0.1.1-rc.2': {
      dist: { tarball: `${origin}/@deepseek-ai/dsh/-/dsh-0.1.1-rc.2.tgz`, integrity: SRI_C },
    },
    '0.1.0-no-tarball': {
      // No tarball → not installable → excluded from versions/byVersion.
      dist: { unpackedSize: 1 },
    },
  },
});

/**
 * Start a loopback registry server. `respond` maps the request path to a
 * {status, body} (body may be an object — JSON-stringified — or a raw string).
 * Resolves to { origin, requests, close }.
 */
async function startRegistryServer(
  respond: (url: string, origin: string) => { status: number; body: unknown },
): Promise<{ origin: string; requests: ServedRequest[]; close: () => Promise<void> }> {
  const requests: ServedRequest[] = [];
  let origin = '';
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', accept: req.headers.accept ?? null });
    const { status, body } = respond(req.url ?? '', origin);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('fetchRegistryMetadata: parses the abbreviated packument (design 18 §4)', async () => {
  const registry = await startRegistryServer((_url, origin) => ({ status: 200, body: fixture(origin) }));
  try {
    const metadata = await fetchRegistryMetadata('@deepseek-ai/dsh', { origin: registry.origin });
    assert.equal(metadata.packageName, '@deepseek-ai/dsh');
    assert.equal(metadata.origin, registry.origin);
    assert.equal(metadata.latest, '0.2.0');
    assert.deepEqual(metadata.versions, ['0.2.0', '0.1.1-rc.2'], 'semver descending, tarball/SRI-less versions excluded');
    assert.equal(metadata.byVersion.size, 2);
    assert.equal(metadata.byVersion.get('0.2.0')?.integrity, SRI_A);
    assert.equal(metadata.byVersion.get('0.2.0')?.tarball, `${registry.origin}/@deepseek-ai/dsh/-/dsh-0.2.0.tgz`);
    assert.equal(metadata.byVersion.get('0.1.1'), undefined, 'missing dist.integrity → excluded');
    assert.equal(metadata.byVersion.get('0.1.0-no-tarball'), undefined, 'no tarball → not in byVersion');
    // Request shape: /{packageName} with the abbreviated-accept header.
    assert.equal(registry.requests.length, 1);
    assert.equal(registry.requests[0].url, '/@deepseek-ai/dsh');
    assert.equal(registry.requests[0].accept, 'application/vnd.npm.install-v1+json');
  } finally {
    await registry.close();
  }
});

test('fetchRegistryMetadata: selected origin cannot delegate tarballs to another public registry', async () => {
  const registry = await startRegistryServer(() => ({ status: 200, body: fixture('https://registry.npmjs.org') }));
  try {
    const metadata = await fetchRegistryMetadata('@deepseek-ai/dsh', { origin: registry.origin });
    assert.deepEqual(metadata.versions, []);
    assert.equal(metadata.latest, null);
  } finally {
    await registry.close();
  }
});

test('fetchRegistryMetadata: junk/non-semver version keys are excluded at parse time', async () => {
  const registry = await startRegistryServer((_url, origin) => ({
    status: 200,
    body: {
      'dist-tags': { latest: '0.2.0' },
      versions: {
        ...fixture(origin).versions,
        '1.0': { dist: { tarball: `${origin}/@deepseek-ai/dsh/-/dsh-1.0.tgz`, integrity: SRI_A } },
        'not-a-version': { dist: { tarball: `${origin}/@deepseek-ai/dsh/-/dsh-x.tgz`, integrity: SRI_A } },
        '0.2.0/../evil': { dist: { tarball: `${origin}/@deepseek-ai/dsh/-/dsh-evil.tgz`, integrity: SRI_A } },
      },
    },
  }));
  try {
    const metadata = await fetchRegistryMetadata('@deepseek-ai/dsh', { origin: registry.origin });
    assert.deepEqual(metadata.versions, ['0.2.0', '0.1.1-rc.2'], 'junk version keys never enter versions/byVersion');
    assert.equal(metadata.byVersion.get('1.0'), undefined);
    assert.equal(metadata.byVersion.get('not-a-version'), undefined);
    assert.equal(metadata.byVersion.get('0.2.0/../evil'), undefined);
    assert.equal(metadata.latest, '0.2.0');
  } finally {
    await registry.close();
  }
});

test('fetchRegistryMetadata: dist-tags.latest missing → max semver fallback', async () => {
  // No dist-tags at all in the packument.
  const registry = await startRegistryServer((_url, origin) => ({ status: 200, body: { versions: fixture(origin).versions } }));
  try {
    const metadata = await fetchRegistryMetadata('@deepseek-ai/dsh', { origin: registry.origin });
    assert.equal(metadata.latest, '0.2.0', 'falls back to the max semver of the parsed versions');
    assert.deepEqual(metadata.versions, ['0.2.0', '0.1.1-rc.2']);
  } finally {
    await registry.close();
  }
});

test('fetchRegistryMetadata: malformed dist-tags.latest → max semver fallback', async () => {
  const registry = await startRegistryServer((_url, origin) => ({
    status: 200,
    body: {
      'dist-tags': { latest: '9.9.9-not-a-real-version' },
      versions: fixture(origin).versions,
    },
  }));
  try {
    const metadata = await fetchRegistryMetadata('@deepseek-ai/dsh', { origin: registry.origin });
    assert.equal(metadata.latest, '0.2.0', 'latest not among parsed versions is malformed → max semver');
  } finally {
    await registry.close();
  }
});

test('fetchRegistryMetadata: garbage document → empty metadata, latest null', async () => {
  const registry = await startRegistryServer(() => ({ status: 200, body: { nope: true } }));
  try {
    const metadata = await fetchRegistryMetadata('@deepseek-ai/dsh', { origin: registry.origin });
    assert.equal(metadata.latest, null);
    assert.deepEqual(metadata.versions, []);
    assert.equal(metadata.byVersion.size, 0);
  } finally {
    await registry.close();
  }
});

test('fetchRegistryMetadata: HTTP error propagates (not swallowed)', async () => {
  const registry = await startRegistryServer(() => ({ status: 404, body: { error: 'not found' } }));
  try {
    await assert.rejects(fetchRegistryMetadata('@deepseek-ai/dsh', { origin: registry.origin }), /HTTP 404/);
  } finally {
    await registry.close();
  }
});

test('fetchRegistryMetadata: invalid JSON propagates (not swallowed)', async () => {
  const registry = await startRegistryServer(() => ({ status: 200, body: 'not json at all' }));
  try {
    await assert.rejects(fetchRegistryMetadata('@deepseek-ai/dsh', { origin: registry.origin }));
  } finally {
    await registry.close();
  }
});

test('fetchRegistryMetadata: network failure propagates (not swallowed)', async () => {
  // Grab a port from a server, close it, then fetch it → ECONNREFUSED.
  const registry = await startRegistryServer((_url, origin) => ({ status: 200, body: fixture(origin) }));
  const deadOrigin = registry.origin;
  await registry.close();
  await assert.rejects(fetchRegistryMetadata('@deepseek-ai/dsh', { origin: deadOrigin }));
});

test('fetchRegistryMetadata: AbortSignal aborts the request', async () => {
  const registry = await startRegistryServer((_url, origin) => ({ status: 200, body: fixture(origin) }));
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fetchRegistryMetadata('@deepseek-ai/dsh', { origin: registry.origin, signal: controller.signal }));
  } finally {
    await registry.close();
  }
});

test('fetchRegistryMetadata: validates every redirect before issuing the next request', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(null, {
      status: 302,
      headers: { location: 'https://evil.invalid/capability/PATH_SECRET?token=TOP_SECRET' },
    });
  };
  await assert.rejects(
    fetchRegistryMetadata('@deepseek-ai/dsh', {
      origin: 'https://registry.npmjs.org',
      fetchImpl,
    }),
    (error: unknown) => {
      assert.match(String(error), /redirect.*白名单/);
      assert.doesNotMatch(String(error), /TOP_SECRET|PATH_SECRET/, 'redirect capability material must be redacted');
      return true;
    },
  );
  assert.equal(calls.length, 1, 'off-origin redirect target must never be fetched');
});

test('tarball download gate follows the real npmmirror CDN redirect chain', async () => {
  // npmmirror 302s the registry-shaped tarball URL to the CDN's own
  // `/packages/<scope>/<name>/<version>/<file>.tgz` layout (with the scope
  // slash percent-encoded). The per-hop gate must allow exactly that.
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://registry.npmmirror.com/')) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.npmmirror.com/packages/%40deepseek-ai/dsh/0.1.1-rc.1/dsh-0.1.1-rc.1.tgz' },
      });
    }
    return new Response('tarball-bytes', { status: 200 });
  };
  const { response, finalUrl } = await fetchRegistryResponse(
    'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.1.1-rc.1.tgz',
    {
      allowedOrigins: registryRedirectOrigins('https://registry.npmmirror.com'),
      fetchImpl,
    },
  );
  assert.equal(response.status, 200);
  assert.equal(finalUrl, 'https://cdn.npmmirror.com/packages/%40deepseek-ai/dsh/0.1.1-rc.1/dsh-0.1.1-rc.1.tgz');
  assert.deepEqual(calls, [
    'https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.1.1-rc.1.tgz',
    'https://cdn.npmmirror.com/packages/%40deepseek-ai/dsh/0.1.1-rc.1/dsh-0.1.1-rc.1.tgz',
  ]);
});

test('fetchRegistryMetadata: follows an allowed redirect manually and enforces the hop limit', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (!url.includes('redirected=1')) {
      return new Response(null, { status: 302, headers: { location: '/@deepseek-ai/dsh?redirected=1' } });
    }
    return new Response(JSON.stringify(fixture()), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const metadata = await fetchRegistryMetadata('@deepseek-ai/dsh', {
    origin: 'https://registry.npmjs.org',
    fetchImpl,
    maxRedirects: 1,
  });
  assert.equal(metadata.latest, '0.2.0');
  assert.equal(calls.length, 2);

  const loopFetch: typeof fetch = async () => new Response(null, {
    status: 302,
    headers: { location: '/@deepseek-ai/dsh' },
  });
  await assert.rejects(
    fetchRegistryMetadata('@deepseek-ai/dsh', {
      origin: 'https://registry.npmjs.org',
      fetchImpl: loopFetch,
      maxRedirects: 1,
    }),
    /exceeded limit/,
  );
});

test('fetchRegistryMetadata: timeout aborts a stalled fetch', async () => {
  const fetchImpl: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(
    fetchRegistryMetadata('@deepseek-ai/dsh', {
      origin: 'https://registry.npmjs.org',
      fetchImpl,
      timeoutMs: 10,
    }),
    /timed out/,
  );
});

test('fetchRegistryMetadata: returned metadata is immutable (read-only map + frozen entries)', async () => {
  const registry = await startRegistryServer((_url, origin) => ({ status: 200, body: fixture(origin) }));
  try {
    const metadata: RegistryMetadata = await fetchRegistryMetadata('@deepseek-ai/dsh', { origin: registry.origin });
    const map = metadata.byVersion as Map<string, unknown>;
    assert.throws(() => map.set('0.9.9', { version: '0.9.9', tarball: 'x', integrity: null }));
    assert.throws(() => map.delete('0.2.0'));
    assert.throws(() => map.clear());
    assert.throws(() => metadata.byVersion.get('0.2.0')!.tarball = 'mutated');
    assert.throws(() => (metadata.versions as string[]).push('9.9.9'));
    assert.throws(() => (metadata as { origin: string }).origin = 'https://evil.invalid');
    // Reads still work through the read-only view.
    assert.equal(metadata.byVersion.get('0.2.0')?.integrity, SRI_A);
    assert.equal(metadata.byVersion.size, 2);
  } finally {
    await registry.close();
  }
});
