/**
 * Unit + CLI tests for verify-runtime-plugin-patches.mjs: the serving transform, the anchor/apply
 * contract on synthetic fixtures, argument parsing, and the loud-skip / --require exit semantics.
 * Hermetic: the positive CLI case writes its own fixture payload into a temp vendor root.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { countOccurrences, parseArgs, payloadPath, toServedComboText, verifyPatchText } from './verify-runtime-plugin-patches.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const GATE = fileURLToPath(new URL('./verify-runtime-plugin-patches.mjs', import.meta.url))
const PATCH_MODULE = pathToFileURL(join(HERE, '../../../packages/renderer/src/client-plugin-patches.ts')).href
const patchModule = await import(PATCH_MODULE)
const patch = patchModule.CLIENT_PLUGIN_PATCHES[0]

/** A minimal valid bundle carrying both real anchors (built from the exports, not copied). */
function positiveFixture() {
  return 'const UPLOAD_ROUTE=\'api/deepseek-chat-import/archive\';\n'
    + patchModule.CHAT_IMPORT_UPLOAD_ANCHOR
    + ';}\n'
    + 'async function registerUi(ctx){' + patchModule.CHAT_IMPORT_CALL_ANCHOR + '}'
}

test('serving transform reproduces the upstream combo shape (strip module trailer, append ; and combo map)', () => {
  const raw = 'window.__ModuleLoader__.load({});\n//# sourceMappingURL=client.js.map\n'
  const served = toServedComboText(raw)
  assert.equal(served.includes('client.js.map'), false, 'the per-module trailer is stripped')
  const trailer = '//# sourceMappingURL=/plugins/??<combo>.js.map&rev=verify\n'
  assert.equal(served.endsWith(trailer), true, 'the combo map trailer is last')
  assert.match(served.slice(0, -trailer.length), /;\n$/u, 'the resource body ends with the combo separator')
  const withUrl = toServedComboText('x\n//# sourceURL=abc\n')
  assert.equal(withUrl.includes('sourceURL='), false, 'the sourceURL trailer is stripped too')
})

test('the raw fixture passes every contract check and the drift controls fire', () => {
  const fixture = positiveFixture()
  const outcome = verifyPatchText(patch, fixture, 'fixture [raw]')
  assert.deepEqual(outcome.problems, [])
  assert.notEqual(outcome.patched, null)
  assert.equal(countOccurrences(outcome.patched, 'chamberBasePath'), 1)
  for (const anchor of patch.anchorTexts) assert.equal(outcome.patched.includes(anchor), false)
  // Both anchors are load-bearing: drop the call anchor -> apply refuses.
  const missing = verifyPatchText(patch, fixture.replace(patchModule.CHAT_IMPORT_CALL_ANCHOR, ''), 'fixture [missing]')
  assert.equal(missing.problems.length > 0, true)
  assert.equal(missing.patched, null)
  // Duplicating either anchor is a drift failure, not a best-effort rewrite.
  const duplicated = verifyPatchText(patch, fixture + '\n;' + fixture, 'fixture [dup]')
  assert.equal(duplicated.patched, null)
  assert.match(duplicated.problems.join('\n'), /anchor .* matched 2 times/u)
})

test('the served fixture passes the same contract (trailer shape does not shift the anchors)', () => {
  const served = toServedComboText(positiveFixture())
  const outcome = verifyPatchText(patch, served, 'fixture [served]')
  assert.deepEqual(outcome.problems, [])
  assert.match(outcome.patched, /\/\/# sourceMappingURL=\/plugins\/\?\?<combo>\.js\.map&rev=verify/u)
})

test('parseArgs: default vendor root, --vendor-root, --require, usage errors', () => {
  assert.deepEqual(parseArgs([]), { vendorRoot: 'packages/desktop/vendor/dsh', require: false, help: false, problems: [] })
  assert.equal(parseArgs(['--vendor-root', '/tmp/x']).vendorRoot, '/tmp/x')
  assert.equal(parseArgs(['--require']).require, true)
  assert.equal(parseArgs(['--help']).help, true)
  assert.match(parseArgs(['--vendor-root']).problems[0], /needs a path/u)
  assert.match(parseArgs(['--bogus']).problems[0], /unknown argument/u)
})

function runGateCli(args, cwd = HERE) {
  const result = spawnSync(process.execPath, [GATE, ...args], { cwd, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

test('CLI: a real fixture payload under --vendor-root verifies raw+served and exits 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-patch-gate-'))
  try {
    const payload = payloadPath(root, patch.packageId)
    mkdirSync(join(root, 'node_modules', patch.packageId, 'lib'), { recursive: true })
    writeFileSync(payload, positiveFixture())
    const result = runGateCli(['--vendor-root', root])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /raw .* served .* anchors, apply ok/u)
    assert.match(result.stdout, /OK verify-runtime-plugin-patches/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: a missing payload is a loud skip by default and a failure under --require', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-patch-gate-empty-'))
  try {
    const skip = runGateCli(['--vendor-root', root])
    assert.equal(skip.status, 0, skip.stdout + skip.stderr)
    assert.match(skip.stdout, /SKIP .* payload missing/u)
    assert.match(skip.stdout, /skipped \(no bundled payload/u)
    const required = runGateCli(['--vendor-root', root, '--require'])
    assert.equal(required.status, 1, required.stdout + required.stderr)
    assert.match(required.stdout, /--require set but no payload was found|payload missing/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: unknown arguments are usage errors (exit 2) and --help exits 0', () => {
  assert.equal(runGateCli(['--bogus']).status, 2)
  const help = runGateCli(['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage: node scripts\/upstream\/verify\/verify-runtime-plugin-patches\.mjs/u)
})