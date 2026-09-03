/**
 * Plugin-spec single-source lockstep tests (design 21 §6.2/§6.7, plan Phase
 * 4.3 — A1 whitelist centralization): the spec/name whitelist family moved
 * from desktop ssh-provider.ts into the control-plane shared pure module
 * (`packages/control-plane/src/plugin-spec.ts`, exported through
 * '@dsh-chamber/control-plane'), which the desktop main consumes through its
 * control-plane-module.ts dual-path facade and the gateway executor imports
 * directly. The WEB/RENDERER chain cannot import the Node-side module, so the
 * renderer's ADD_SPEC stays a hand-written mirror — these tests pin that
 * mirror to the shared PLUGIN_SPEC_PATTERN literal TEXTUALLY (a regex-source
 * change on either side fails here), and assert the desktop files no longer
 * re-declare the moved constants (they only re-export).
 *
 * Run directly: node packages/gateway/test/plugin-spec-lockstep.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isDeniedPluginName,
  MATERIALIZE_FILE_SPEC_PATTERN,
  MAX_PLUGIN_SPEC_CHARS,
  PLUGIN_NAME_PATTERN,
  PLUGIN_SPEC_PATTERN,
  RUN_STDOUT_MAX_BYTES,
  WRITE_FILE_MAX_BYTES,
} from '@dsh-chamber/control-plane'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const pluginSpecSource = () => readFileSync(
  join(REPO_ROOT, 'packages', 'control-plane', 'src', 'plugin-spec.ts'),
  'utf8',
)
const pluginAddViewSource = () => readFileSync(
  join(REPO_ROOT, 'packages', 'dsh-chamber-client-ui-settings-connections', 'src', 'client', 'PluginAddView.tsx'),
  'utf8',
)
const sshProviderSource = () => readFileSync(
  join(REPO_ROOT, 'packages', 'desktop', 'ssh-provider.ts'),
  'utf8',
)
const pluginSyncSource = () => readFileSync(
  join(REPO_ROOT, 'packages', 'desktop', 'plugin-sync.ts'),
  'utf8',
)

/** The whole `/…/` regex literal from one single-line declaration. */
function regexLiteral(source: string, declaration: string): string {
  const match = new RegExp(`^${declaration}\\s*=\\s*(/.*/)$`, 'm').exec(source)
  if (match === null) {
    assert.fail(`expected a single-line literal declaration: ${declaration} = /…/`)
  }
  return match[1]
}

// ---------------------------------------------------------------------------
// Renderer ADD_SPEC ↔ control-plane PLUGIN_SPEC_PATTERN mirror (textual)
// ---------------------------------------------------------------------------

test('the renderer ADD_SPEC literal is byte-identical to the shared PLUGIN_SPEC_PATTERN', () => {
  const renderer = regexLiteral(pluginAddViewSource(), 'const ADD_SPEC')
  const shared = regexLiteral(pluginSpecSource(), 'export const PLUGIN_SPEC_PATTERN')
  assert.equal(renderer, shared,
    'PluginAddView ADD_SPEC must stay a byte-identical hand mirror of control-plane PLUGIN_SPEC_PATTERN (the renderer cannot import the Node-side module; change both sides together)')
  // The extracted literal must also be the live constant the gateway and the
  // desktop consume through the package export — guards a stale copy surviving
  // next to the real declaration.
  assert.equal(shared.slice(1, -1), PLUGIN_SPEC_PATTERN.source,
    'the shared literal must be the exported PLUGIN_SPEC_PATTERN (no duplicate copy in plugin-spec.ts)')
})

// ---------------------------------------------------------------------------
// Desktop rewiring: re-export only, no re-declaration
// ---------------------------------------------------------------------------

const MOVED_DECLARATIONS = [
  'MAX_PLUGIN_SPEC_CHARS',
  'PLUGIN_SPEC_PATTERN',
  'PLUGIN_NAME_PATTERN',
  'MATERIALIZE_FILE_SPEC_PATTERN',
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

test('ssh-provider.ts re-exports the family through the control-plane-module facade', () => {
  const source = sshProviderSource()
  assert.match(source, /from '\.\/control-plane-module\.ts'/,
    'ssh-provider.ts must consume the family through the dual-path facade')
  for (const name of [...MOVED_DECLARATIONS, 'isDeniedPluginName']) {
    assert.match(source, new RegExp(`^\\s*${name},?$`, 'm'),
      `ssh-provider.ts must re-export ${name} from the facade`)
  }
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
  assert.equal(MATERIALIZE_FILE_SPEC_PATTERN.test('file:/home/u/.dsh-chamber/plugins/scope-name-abc123.tgz'), true)
  assert.equal(MATERIALIZE_FILE_SPEC_PATTERN.test('file:relative.tgz'), false)
})

test('isDeniedPluginName denies the official and chamber domains (design 21 §6.2/decision 19)', () => {
  assert.equal(isDeniedPluginName('@deepseek-ai/dsh'), true, 'official domain is denied')
  assert.equal(isDeniedPluginName('@dsh-chamber/dsh-host-client-graph'), true, 'seed host package is denied')
  assert.equal(isDeniedPluginName('@dsh-chamber/dsh-host-git-worktree'), true, 'seed host package is denied')
  assert.equal(isDeniedPluginName('@dsh-chamber/dsh-chamber-client-ui-mobile'), true, 'mobile exception is denied')
  assert.equal(isDeniedPluginName('@dsh-chamber/anything-else'), true, 'chamber domain is entirely chamber-managed')
  // A versioned spec still matches by prefix when a caller forgets to extract
  // the name first.
  assert.equal(isDeniedPluginName('@dsh-chamber/pkg@1.0.0'), true)
  for (const ok of ['third-party-plugin', '@scope/third-party', 'dsh-plugin-x']) {
    assert.equal(isDeniedPluginName(ok), false, `${ok} must not be denied`)
  }
})
