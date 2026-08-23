/**
 * registry-metadata.ts pure-logic tests (design 16 §4 — abbreviated packument
 * reading) — node:test, no electron, NO real network: a node:http loopback
 * server serves controlled JSON and records the request (URL + Accept
 * header). Covers dist-tags.latest passthrough / max-semver fallback when
 * latest is missing or malformed / missing dist.integrity → null / semver-
 * descending version order / tarball-less versions excluded / HTTP + JSON +
 * network failures propagating / immutable (frozen) metadata.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchRegistryMetadata, type RegistryMetadata } from './registry-metadata.ts';

interface ServedRequest {
  url: string;
  accept: string | null;
}

/** Abbreviated packument fixture (install-v1+json shape, design 16 §4). */
const FIXTURE = {
  'dist-tags': { latest: '0.2.0' },
  versions: {
    '0.2.0': {
      dist: { tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.0.tgz', integrity: 'sha512-aaa', unpackedSize: 456 },
    },
    '0.1.1': {
      // dist present, integrity absent → integrity must be null.
      dist: { tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.1.tgz', unpackedSize: 123 },
    },
    '0.1.1-rc.2': {
      dist: { tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.1-rc.2.tgz', integrity: 'sha512-ccc' },
    },
    '0.1.0-no-tarball': {
      // No tarball → not installable → excluded from versions/byVersion.
      dist: { unpackedSize: 1 },
    },
  },
};

/**
 * Start a loopback registry server. `respond` maps the request path to a
 * {status, body} (body may be an object — JSON-stringified — or a raw string).
 * Resolves to { origin, requests, close }.
 */
async function startRegistryServer(
  respond: (url: string) => { status: number; body: unknown },
): Promise<{ origin: string; requests: ServedRequest[]; close: () => Promise<void> }> {
  const requests: ServedRequest[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', accept: req.headers.accept ?? null });
    const { status, body } = respond(req.url ?? '');
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('fetchRegistryMetadata: parses the abbreviated packument (design 16 §4)', async () => {
  const registry = await startRegistryServer(() => ({ status: 200, body: FIXTURE }));
  try {
    const metadata = await fetchRegistryMetadata('@deepseek-ai/dsh', { origin: registry.origin });
    assert.equal(metadata.latest, '0.2.0');
    assert.deepEqual(metadata.versions, ['0.2.0', '0.1.1', '0.1.1-rc.2'], 'semver descending, tarball-less version excluded');
    assert.equal(metadata.byVersion.size, 3);
    assert.equal(metadata.byVersion.get('0.2.0')?.integrity, 'sha512-aaa');
    assert.equal(metadata.byVersion.get('0.2.0')?.tarball, 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.0.tgz');
    assert.equal(metadata.byVersion.get('0.1.1')?.integrity, null, 'missing dist.integrity → null');
    assert.equal(metadata.byVersion.get('0.1.0-no-tarball'), undefined, 'no tarball → not in byVersion');
    // Request shape: /{packageName} with the abbreviated-accept header.
    assert.equal(registry.requests.length, 1);
    assert.equal(registry.requests[0].url, '/@deepseek-ai/dsh');
    assert.equal(registry.requests[0].accept, 'application/vnd.npm.install-v1+json');
  } finally {
    await registry.close();
  }
});

test('fetchRegistryMetadata: dist-tags.latest missing → max semver fallback', async () => {
  // No dist-tags at all in the packument.
  const noDistTags = { versions: FIXTURE.versions };
  const registry = await startRegistryServer(() => ({ status: 200, body: noDistTags }));
  try {
    const metadata = await fetchRegistryMetadata('@deepseek-ai/dsh', { origin: registry.origin });
    assert.equal(metadata.latest, '0.2.0', 'falls back to the max semver of the parsed versions');
    assert.deepEqual(metadata.versions, ['0.2.0', '0.1.1', '0.1.1-rc.2']);
  } finally {
    await registry.close();
  }
});

test('fetchRegistryMetadata: malformed dist-tags.latest → max semver fallback', async () => {
  const malformed = {
    'dist-tags': { latest: '9.9.9-not-a-real-version' },
    versions: FIXTURE.versions,
  };
  const registry = await startRegistryServer(() => ({ status: 200, body: malformed }));
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
  const registry = await startRegistryServer(() => ({ status: 200, body: FIXTURE }));
  const deadOrigin = registry.origin;
  await registry.close();
  await assert.rejects(fetchRegistryMetadata('@deepseek-ai/dsh', { origin: deadOrigin }));
});

test('fetchRegistryMetadata: AbortSignal aborts the request', async () => {
  const registry = await startRegistryServer(() => ({ status: 200, body: FIXTURE }));
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fetchRegistryMetadata('@deepseek-ai/dsh', { origin: registry.origin, signal: controller.signal }));
  } finally {
    await registry.close();
  }
});

test('fetchRegistryMetadata: returned metadata is immutable (read-only map + frozen entries)', async () => {
  const registry = await startRegistryServer(() => ({ status: 200, body: FIXTURE }));
  try {
    const metadata: RegistryMetadata = await fetchRegistryMetadata('@deepseek-ai/dsh', { origin: registry.origin });
    const map = metadata.byVersion as Map<string, unknown>;
    assert.throws(() => map.set('0.9.9', { version: '0.9.9', tarball: 'x', integrity: null }));
    assert.throws(() => map.delete('0.2.0'));
    assert.throws(() => map.clear());
    assert.throws(() => metadata.byVersion.get('0.2.0')!.tarball = 'mutated');
    // Reads still work through the read-only view.
    assert.equal(metadata.byVersion.get('0.2.0')?.integrity, 'sha512-aaa');
    assert.equal(metadata.byVersion.size, 3);
  } finally {
    await registry.close();
  }
});
