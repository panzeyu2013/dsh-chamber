/**
 * sanitize-error.ts pure-logic tests (design 18 §6 — extraction of the
 * updater's redaction) — node:test, no electron. Covers URL survival (the
 * scheme + `//host` part is never swallowed), POSIX absolute-path redaction,
 * Windows drive-path redaction (scheme-like `x://` survives), and plain-text
 * passthrough. Assertions pin the verbatim-extracted behavior of the original
 * updater.ts implementation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeErrorText } from '../src/sanitize-error.ts';

test('sanitizeErrorText: URL scheme + //host survive (never swallowed)', () => {
  // The lookbehind keeps `https://github.com` visible; only the path part is
  // redacted as a path token.
  assert.equal(
    sanitizeErrorText('check failed: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.2.0'),
    'check failed: https://github.com[path]',
  );
  assert.equal(
    sanitizeErrorText('download failed: https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.1.tgz'),
    'download failed: https://registry.npmjs.org[path]',
  );
  // A bare scheme + host with no path is left completely untouched.
  assert.equal(sanitizeErrorText('go to https://github.com now'), 'go to https://github.com now');
});

test('sanitizeErrorText: file URLs are local paths and never retain user directories', () => {
  assert.equal(
    sanitizeErrorText('load failed at file:///Users/alice/Library/Application%20Support/dsh/runtime.js'),
    'load failed at [path]',
  );
  assert.equal(
    sanitizeErrorText('load failed at file:///home/alice/.local/share/dsh/runtime.js'),
    'load failed at [path]',
  );
  assert.equal(sanitizeErrorText('UNC file://server/share/alice/secret'), 'UNC [path]');
});

test('sanitizeErrorText: POSIX absolute paths redacted (any root component)', () => {
  assert.equal(
    sanitizeErrorText('update cache /Users/alice/Library/Caches/dsh-chamber/updater is full'),
    'update cache [path] is full',
  );
  assert.equal(sanitizeErrorText('/opt/dsh-chamber/bin failed'), '[path] failed');
});

test('sanitizeErrorText: Windows drive paths redacted; scheme-like x:// survives', () => {
  assert.equal(
    sanitizeErrorText('cache dir C:\\Users\\alice\\AppData\\Roaming\\dsh-chamber\\updater'),
    'cache dir [path]',
  );
  assert.equal(sanitizeErrorText('path C:/Users/alice/x is bad'), 'path [path] is bad');
  // `C://foo` looks like a scheme (`x://`, drive letter followed by TWO
  // slashes) → not treated as a drive path.
  assert.equal(sanitizeErrorText('C://foo is fine'), 'C://foo is fine');
});

test('sanitizeErrorText: UNC shares are redacted (no drive letter, no forward slash)', () => {
  // 2026-09 review: a UNC path matches neither the drive rule nor the POSIX
  // rule, so it used to ride the projection verbatim — the gap widened when
  // probe failure details started carrying host-side text.
  assert.equal(
    sanitizeErrorText(String.raw`open \\fileserver\share\alice\secret.json failed`),
    'open [path] failed',
  );
  // extended-length form carries the same material
  assert.equal(
    sanitizeErrorText(String.raw`open \\?\C:\Users\alice\x.json failed`),
    'open [path] failed',
  );
  // a UNC token with forward slashes is eaten whole, not left half-redacted
  assert.equal(
    sanitizeErrorText(String.raw`open \\fileserver\share/alice/x.json failed`),
    'open [path] failed',
  );
});

test('sanitizeErrorText: plain text passes through unchanged', () => {
  assert.equal(sanitizeErrorText('everything is fine'), 'everything is fine');
  assert.equal(sanitizeErrorText(''), '');
});

test('sanitizeErrorText: caller-declared tokens survive redaction', () => {
  // Default behavior is unchanged: the POSIX branch matches `word/word` from
  // INSIDE the token, so a registered RPC method name reads as a path.
  assert.equal(sanitizeErrorText('commands/execute failed'), 'commands[path] failed');
  // A declared token is restored verbatim while everything else is still redacted.
  assert.equal(
    sanitizeErrorText('commands/execute: /Users/alice/x is bad', ['commands/execute']),
    'commands/execute: [path] is bad',
  );
  assert.equal(
    sanitizeErrorText(
      'session/canOpenWorkspacePath and commands/execute both survived',
      ['commands/execute', 'session/canOpenWorkspacePath'],
    ),
    'session/canOpenWorkspacePath and commands/execute both survived',
  );
  // URL-path redaction and the kept token do not interfere.
  assert.equal(
    sanitizeErrorText('see https://github.com/a/b for commands/execute', ['commands/execute']),
    'see https://github.com[path] for commands/execute',
  );
  // A declared token that is absent changes nothing.
  assert.equal(sanitizeErrorText('nothing to keep', ['commands/execute']), 'nothing to keep');
});
