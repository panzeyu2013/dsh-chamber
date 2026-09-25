/**
 * Plugin-spec single-source lockstep tests (design 21 §6.2/§6.7): the
 * spec/name whitelist family lives in the control-plane shared pure module
 * (`packages/control-plane/src/plugin-spec.ts`, exported through
 * '@dsh-chamber/control-plane'), which the desktop main consumes through its
 * control-plane-module.ts dual-path facade and the gateway executor imports
 * directly. The WEB/RENDERER chain cannot import the Node-side module, so the
 * renderer's ADD_SPEC stays a hand-written mirror — these tests pin that
 * mirror to the shared PLUGIN_SPEC_PATTERN literal TEXTUALLY (a regex-source
 * change on either side fails here), and assert the desktop files do not
 * re-declare those constants (they only re-export).
 *
 * Run directly: node packages/gateway/test/plugins/plugin-spec-lockstep.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_PLUGIN_SPEC_CHARS,
  PLUGIN_NAME_PATTERN,
  PLUGIN_SPEC_PATTERN,
  RUN_STDOUT_MAX_BYTES,
  WRITE_FILE_MAX_BYTES,
} from '@dsh-chamber/control-plane'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const sshProviderSource = () => readFileSync(
  join(REPO_ROOT, 'packages', 'desktop', 'ssh-provider.ts'),
  'utf8',
)
const pluginSyncSource = () => readFileSync(
  join(REPO_ROOT, 'packages', 'desktop', 'plugin-sync.ts'),
  'utf8',
)

// ---------------------------------------------------------------------------
// Desktop: re-export only, no re-declaration
// ---------------------------------------------------------------------------

const MOVED_DECLARATIONS = [
  'MAX_PLUGIN_SPEC_CHARS',
  'PLUGIN_SPEC_PATTERN',
  'PLUGIN_NAME_PATTERN',
  'WRITE_FILE_MAX_BYTES',
  'RUN_STDOUT_MAX_BYTES',
]

test('ssh-provider.ts no longer declares the moved constants (single source lives in control-plane)', () => {
  const source = sshProviderSource()
  for (const name of MOVED_DECLARATIONS) {
    assert.doesNotMatch(source, new RegExp(`export const ${name}\\s*=`),
      `ssh-provider.ts must not re-declare ${name} (control-plane plugin-spec.ts is the single source)`)
  }
})

test('ssh-provider.ts consumes the content bounds through the control-plane-module facade', () => {
  const source = sshProviderSource()
  assert.match(source, /import \{ RUN_STDOUT_MAX_BYTES, WRITE_FILE_MAX_BYTES \} from '\.\/control-plane-module\.ts'/,
    'ssh-provider.ts must consume the content bounds through the dual-path facade')
  assert.match(source, /export \{ RUN_STDOUT_MAX_BYTES, WRITE_FILE_MAX_BYTES \}/,
    'ssh-provider.ts must keep re-exporting the content bounds')
})

test('plugin-sync.ts keeps re-exporting the shared spec/name patterns (no ssh-provider middleman)', () => {
  const source = pluginSyncSource()
  assert.match(source, /export \{ PLUGIN_SPEC_PATTERN, PLUGIN_NAME_PATTERN \}/,
    'plugin-sync.ts must keep its PLUGIN_SPEC_PATTERN / PLUGIN_NAME_PATTERN re-export (plugin-sync.test.ts imports them)')
  assert.doesNotMatch(source, /import \{[^}]*MAX_PLUGIN_SPEC_CHARS[^}]*\} from '\.\/ssh-provider\.ts'/,
    'plugin-sync.ts must import the whitelist family from the facade, not from ssh-provider.ts')
  assert.match(source, /from '\.\/control-plane-module\.ts'/,
    'plugin-sync.ts must consume the whitelist family through the dual-path facade')
})

// ---------------------------------------------------------------------------
// Runtime sanity of the shared module through the package export
// ---------------------------------------------------------------------------

test('the shared whitelist values ride the @dsh-chamber/control-plane export', () => {
  assert.equal(PLUGIN_SPEC_PATTERN.test('pkg'), true)
  assert.equal(PLUGIN_SPEC_PATTERN.test('@scope/pkg'), true)
  assert.equal(PLUGIN_SPEC_PATTERN.test('@scope/pkg@1.2.3'), true)
  assert.equal(PLUGIN_SPEC_PATTERN.test('pkg@latest'), true)
  assert.equal(PLUGIN_NAME_PATTERN.test('pkg'), true)
  assert.equal(PLUGIN_NAME_PATTERN.test('@scope/pkg'), true)
  for (const bad of ['../../etc/passwd', 'pkg@1.2.3 || true', 'file:../x', 'pkg;rm -rf /', 'pkg>=1.2.3', '']) {
    assert.equal(PLUGIN_SPEC_PATTERN.test(bad), false, `spec ${JSON.stringify(bad)} must be refused`)
    assert.equal(PLUGIN_NAME_PATTERN.test(bad), false, `name ${JSON.stringify(bad)} must be refused`)
  }
  assert.equal(MAX_PLUGIN_SPEC_CHARS, 512)
  assert.equal(WRITE_FILE_MAX_BYTES, 50 * 1024 * 1024)
  assert.equal(RUN_STDOUT_MAX_BYTES, WRITE_FILE_MAX_BYTES)
})

