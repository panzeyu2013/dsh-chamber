/**
 * registry-url.ts pure-logic tests (design 18 §4/§6 — registry-domain URL
 * whitelist) — node:test, no electron. Covers the three allowed shapes
 * (metadata / tarball / `/-/v1/search`), origin + scheme + port rejection,
 * userinfo rejection, the decode-then-re-normalize encoding-traversal
 * defense, and custom-origin override. All cases are local — no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_REGISTRY_ORIGINS, canonicalRegistryOrigin, isAllowedRegistryUrl, registryRedirectOrigins } from './registry-url.ts';

test('canonicalRegistryOrigin: accepts exact HTTPS origins and loopback HTTP only', () => {
  assert.equal(canonicalRegistryOrigin('https://registry.npmjs.org/'), 'https://registry.npmjs.org');
  assert.match(canonicalRegistryOrigin('http://127.0.0.1:12345') ?? '', /^http:\/\/127\.0\.0\.1:/);
  assert.equal(canonicalRegistryOrigin('http://registry.npmjs.org'), null);
  assert.equal(canonicalRegistryOrigin('ftp://registry.npmjs.org'), null);
  assert.equal(canonicalRegistryOrigin('https://registry.npmjs.org/path'), null);
  assert.equal(canonicalRegistryOrigin('https://user:secret@registry.npmjs.org'), null);
  assert.equal(canonicalRegistryOrigin('https://registry.npmjs.org?token=secret'), null);
});

test('isAllowedRegistryUrl: metadata / tarball / search URLs pass', () => {
  assert.equal(isAllowedRegistryUrl('https://registry.npmjs.org/@deepseek-ai/dsh'), true);
  // npm's canonical encoded-scope metadata form decodes to the same shape.
  assert.equal(isAllowedRegistryUrl('https://registry.npmjs.org/@deepseek-ai%2fdsh'), true, 'encoded scope slash');
  assert.equal(isAllowedRegistryUrl('https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.1.tgz'), true);
  assert.equal(isAllowedRegistryUrl('https://registry.npmjs.org/-/v1/search?text=deepseek&size=20'), true);
  assert.equal(isAllowedRegistryUrl('https://registry.npmmirror.com/@deepseek-ai/dsh'), true, 'whitelisted mirror');
  assert.equal(isAllowedRegistryUrl('https://registry.npmjs.org/foo'), true, 'unscoped metadata');
  assert.equal(isAllowedRegistryUrl('https://registry.npmjs.org/foo/-/foo-1.0.0.tgz'), true, 'unscoped tarball');
});

test('isAllowedRegistryUrl: rejects off-origin / http / non-default port / off-shape paths', () => {
  assert.equal(isAllowedRegistryUrl('https://evil.example/@deepseek-ai/dsh'), false);
  assert.equal(isAllowedRegistryUrl('http://registry.npmjs.org/@deepseek-ai/dsh'), false, 'http is never allowed');
  assert.equal(isAllowedRegistryUrl('https://registry.npmjs.org:8443/@deepseek-ai/dsh'), false, 'non-default port changes origin');
  assert.equal(isAllowedRegistryUrl('https://registry.npmjs.org/foo/bar'), false, 'two-segment unscoped path is off-shape');
  assert.equal(isAllowedRegistryUrl('https://registry.npmjs.org/-/v1/other'), false);
});

test('isAllowedRegistryUrl: rejects userinfo (origin ignores it)', () => {
  assert.equal(isAllowedRegistryUrl('https://user:pass@registry.npmjs.org/@deepseek-ai/dsh'), false);
  assert.equal(isAllowedRegistryUrl('https://user@registry.npmjs.org/@deepseek-ai/dsh'), false);
});

test('isAllowedRegistryUrl: rejects encoded traversal that re-normalizes off-shape', () => {
  // `..%2f` / `%2e%2e%2f` decode then resolve through a fresh URL — the
  // result must still be one of the allowed shapes (it resolves to `/etc/passwd`).
  assert.equal(isAllowedRegistryUrl('https://registry.npmjs.org/..%2f..%2fetc/passwd'), false);
  assert.equal(isAllowedRegistryUrl('https://registry.npmjs.org/%2e%2e%2f%2e%2e%2fetc/passwd'), false);
  assert.equal(isAllowedRegistryUrl('https://registry.npmjs.org/@deepseek-ai%2f..%2f..%2f..%2fetc%2fpasswd'), false);
  // NOTE: a traversal that resolves to a single-segment path (e.g. `/etc`)
  // IS the metadata shape — the effective request is a legit metadata fetch.
  // These cases resolve to `/etc/passwd`, which is off-shape.
  assert.equal(isAllowedRegistryUrl('https://registry.npmjs.org/foo/-/..%2f..%2f..%2fetc%2fpasswd'), false);
  // Malformed percent-encoding → decodeURIComponent throws → never allowed.
  assert.equal(isAllowedRegistryUrl('https://registry.npmjs.org/%zz/@deepseek-ai'), false);
});

test('isAllowedRegistryUrl: rejects non-string / unparsable input', () => {
  assert.equal(isAllowedRegistryUrl('not a url'), false);
  assert.equal(isAllowedRegistryUrl(42), false);
  assert.equal(isAllowedRegistryUrl(null), false);
  assert.equal(isAllowedRegistryUrl(undefined), false);
});

test('isAllowedRegistryUrl: custom origins override the default whitelist', () => {
  assert.equal(
    isAllowedRegistryUrl('https://registry.npmmirror.com/@deepseek-ai/dsh', ['https://registry.npmjs.org']),
    false,
    'mirror not in the custom list',
  );
  assert.equal(
    isAllowedRegistryUrl('https://custom.registry.example/@deepseek-ai/dsh', ['https://custom.registry.example']),
    true,
  );
  assert.equal(
    isAllowedRegistryUrl('https://custom.registry.example/@deepseek-ai/dsh', []),
    false,
    'an empty custom list allows nothing',
  );
});

test('ALLOWED_REGISTRY_ORIGINS: design §4 default whitelist', () => {
  assert.deepEqual(ALLOWED_REGISTRY_ORIGINS, ['https://registry.npmjs.org', 'https://registry.npmmirror.com']);
});

test('registryRedirectOrigins: npmmirror includes its tarball CDN, others do not', () => {
  assert.deepEqual(
    registryRedirectOrigins('https://registry.npmmirror.com'),
    ['https://registry.npmmirror.com', 'https://cdn.npmmirror.com'],
  );
  assert.deepEqual(registryRedirectOrigins('https://registry.npmjs.org'), ['https://registry.npmjs.org']);
  assert.deepEqual(registryRedirectOrigins('https://custom.registry.example'), ['https://custom.registry.example']);
});

test('isAllowedRegistryUrl: npmmirror CDN tarball passes with the redirect origins', () => {
  const allowed = registryRedirectOrigins('https://registry.npmmirror.com');
  assert.equal(
    isAllowedRegistryUrl('https://cdn.npmmirror.com/@deepseek-ai/dsh/-/dsh-0.1.1-rc.1.tgz', allowed),
    true,
  );
  // The real 302 target: the CDN's own `/packages/...` tarball layout, with
  // the percent-encoded scope slash exactly as the registry sends it.
  assert.equal(
    isAllowedRegistryUrl('https://cdn.npmmirror.com/packages/%40deepseek-ai/dsh/0.1.1-rc.1/dsh-0.1.1-rc.1.tgz', allowed),
    true,
    'encoded CDN tarball layout',
  );
  assert.equal(
    isAllowedRegistryUrl('https://cdn.npmmirror.com/packages/@deepseek-ai/dsh/0.1.1-rc.1/dsh-0.1.1-rc.1.tgz', allowed),
    true,
    'decoded CDN tarball layout',
  );
  assert.equal(
    isAllowedRegistryUrl('https://cdn.npmmirror.com/packages/lodash/4.17.21/lodash-4.17.21.tgz', allowed),
    true,
    'unscoped CDN tarball layout',
  );
  // The CDN-only layout must never be accepted on a registry origin, and the
  // CDN must never accept registry-internal paths beyond the tarball shapes.
  assert.equal(
    isAllowedRegistryUrl('https://registry.npmmirror.com/packages/@deepseek-ai/dsh/0.1.1-rc.1/dsh-0.1.1-rc.1.tgz', allowed),
    false,
    '/packages layout is CDN-only',
  );
  assert.equal(
    isAllowedRegistryUrl('https://cdn.npmmirror.com/packages/@deepseek-ai/dsh/0.1.1-rc.1/', allowed),
    false,
    'directory-shaped CDN path',
  );
  // A traversal must still re-normalize and land on an allowed shape: enough
  // dot-segments to climb above /packages/ resolves to /etc/… and is rejected
  // (a shallower traversal only reaches a 404 under /packages/, never SSRF).
  assert.equal(
    isAllowedRegistryUrl('https://cdn.npmmirror.com/packages/@deepseek-ai/dsh/0.1.1-rc.1/../../../../etc/passwd.tgz', allowed),
    false,
    'traversal escaping the CDN layout',
  );
  assert.equal(
    isAllowedRegistryUrl('https://cdn.npmmirror.com/packages/@deepseek-ai/dsh/0.1.1-rc.1/..%2f..%2f..%2f..%2fetc%2fpasswd.tgz', allowed),
    false,
    'encoded traversal escaping the CDN layout',
  );
  // The CDN is NOT a metadata source: it is rejected by the default whitelist.
  assert.equal(isAllowedRegistryUrl('https://cdn.npmmirror.com/@deepseek-ai/dsh'), false);
});
