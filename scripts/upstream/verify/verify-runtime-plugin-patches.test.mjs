/**
 * Unit + CLI tests for verify-runtime-plugin-patches.mjs: the serving transform, the anchor/apply
 * contract on synthetic fixtures, argument parsing, and the loud-skip / --require exit semantics.
 * Hermetic: the positive CLI case writes its own fixture payload into a temp vendor root.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  DEGRADE_ALLOWED_PACKAGE_IDS,
  countOccurrences,
  parseArgs,
  payloadPath,
  runGate,
  toServedComboText,
  validatePatchEntry,
  verifyPatchText,
} from './verify-runtime-plugin-patches.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const GATE = fileURLToPath(new URL('./verify-runtime-plugin-patches.mjs', import.meta.url))
const PATCH_MODULE = pathToFileURL(join(HERE, '../../../packages/renderer/src/client-plugin-patches.ts')).href
const PATCH_MODULE_PATH = fileURLToPath(PATCH_MODULE)
const patchModule = await import(PATCH_MODULE)
const patch = patchModule.CLIENT_PLUGIN_PATCHES.find(entry => entry.packageId === patchModule.CHAT_IMPORT_PACKAGE_ID)

/** A minimal valid bundle carrying both real anchors (built from the exports, not copied). */
function positiveFixture() {
  return 'const UPLOAD_ROUTE=\'api/deepseek-chat-import/archive\';\n'
    + patchModule.CHAT_IMPORT_UPLOAD_ANCHOR
    + ';}\n'
    + 'async function registerUi(ctx){' + patchModule.CHAT_IMPORT_CALL_ANCHOR + '}'
}

/**
 * Independently written pinned-shape fixture for the document-preview entry: the two anchor
 * texts are literal here (not imported), so a production anchor typo cannot self-validate.
 */
function documentPreviewFixture() {
  return [
    'window.__ModuleLoader__.load({id:`@deepseek-ai/dsh-client-ui-sidebar-documentpreview`,factory:require=>{',
    'function markdownImageUrl(base,documentPath,destination){return new URL(`api/file?path=${encodeURIComponent(destination)}`,base).href}',
    'function MarkdownBody({content,resourceAddress,useResource,t}){',
    'const absolutePath=useResource(resourceAddress).value?.absolutePath;',
    'const pathImages={resolve:value=>markdownImageUrl(document.baseURI,absolutePath,value)};',
    'return pathImages}',
    'exports.apply=()=>{};return module.exports}});',
  ].join('\n')
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

const documentPreviewPatch = patchModule.CLIENT_PLUGIN_PATCHES.find(
  entry => entry.packageId === patchModule.DOCUMENT_PREVIEW_PACKAGE_ID,
)

test('the document-preview entry passes raw+served with its own probe token/count', () => {
  const fixture = documentPreviewFixture()
  for (const [label, text] of [['raw', fixture], ['served', toServedComboText(fixture)]]) {
    const outcome = verifyPatchText(documentPreviewPatch, text, 'documentpreview [' + label + ']')
    assert.deepEqual(outcome.problems, [])
    assert.equal(countOccurrences(outcome.patched, 'chamberFileApiBase'), 3)
    for (const anchor of documentPreviewPatch.anchorTexts) assert.equal(outcome.patched.includes(anchor), false)
  }
  // A wrong probe count is a drift failure: the gate no longer hard-codes one package's token.
  const wrongProbe = { ...documentPreviewPatch, probe: { token: 'chamberFileApiBase', count: 4 } }
  const outcome = verifyPatchText(wrongProbe, fixture, 'documentpreview [probe]')
  assert.match(outcome.problems.join('\n'), /chamberFileApiBase 3 times \(expected 4\)/u)
})

test('entry shape: anchorMiss/probe validation and the core-row degrade allowlist', () => {
  for (const entry of [patch, documentPreviewPatch]) assert.deepEqual(validatePatchEntry(entry, entry.packageId), [])
  assert.deepEqual(DEGRADE_ALLOWED_PACKAGE_IDS, ['@deepseek-ai/dsh-client-ui-sidebar-documentpreview'])
  const foreignDegrade = { ...documentPreviewPatch, packageId: '@scope/foreign' }
  assert.match(validatePatchEntry(foreignDegrade, 'foreign').join('\n'), /reserved for the core official row/u)
  const badPolicy = { ...documentPreviewPatch, anchorMiss: 'skip' }
  assert.match(validatePatchEntry(badPolicy, 'bad-policy').join('\n'), /invalid anchorMiss/u)
  const noProbe = { ...documentPreviewPatch, probe: undefined }
  assert.match(validatePatchEntry(noProbe, 'no-probe').join('\n'), /no valid probe/u)
  const anchorMismatch = { ...documentPreviewPatch, anchors: 3 }
  assert.match(validatePatchEntry(anchorMismatch, 'mismatch').join('\n'), /!== anchorTexts.length/u)
})

/**
 * Materialize one isolated gate root: the real (or mutated) patch module at the path the
 * gate imports, plus both fixture payloads at the vendor root it reads. This is a full
 * runGate fixture, not the pure helpers the other cases drive.
 */
function gateFixtureRoot(patchSource) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-patch-gate-table-'))
  writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n')
  mkdirSync(join(root, 'packages/renderer/src'), { recursive: true })
  writeFileSync(join(root, 'packages/renderer/src/client-plugin-patches.ts'), patchSource)
  for (const [packageId, text] of [[patch.packageId, positiveFixture()],
    [patchModule.DOCUMENT_PREVIEW_PACKAGE_ID, documentPreviewFixture()]]) {
    mkdirSync(join(root, 'vendor/node_modules', packageId, 'lib'), { recursive: true })
    writeFileSync(payloadPath(join(root, 'vendor'), packageId), text)
  }
  return root
}

test('runGate: the degrade allowlist is enforced at the gate call site (a bad table is red end-to-end)', async () => {
  const source = readFileSync(PATCH_MODULE_PATH, 'utf8')
  // Control leg: the unmutated table passes through the SAME fixture root (exit 0), so a
  // red below cannot be an artifact of the fixture layout.
  const healthyRoot = gateFixtureRoot(source)
  try {
    const healthy = await runGate({ root: healthyRoot, vendorRoot: 'vendor' })
    assert.equal(healthy.code, 0, healthy.lines.join('\n'))
    assert.match(healthy.lines.join('\n'), /2 patch\(es\) x raw\+served verified/u)
  } finally {
    rmSync(healthyRoot, { recursive: true, force: true })
  }
  // The same root with the optional chat-import row flipped to the core-row degrade policy
  // must be red: this is the only test that exercises the gate's validatePatchEntry call
  // site (the pure-function cases above pass with a bad table, and every CLI case runs the
  // real table).
  const badSource = source.replace("anchorMiss: 'refuse',", "anchorMiss: 'degrade-unpatched',")
  assert.notEqual(badSource, source, 'the fixture mutation must land on the chat-import row')
  const badRoot = gateFixtureRoot(badSource)
  try {
    const outcome = await runGate({ root: badRoot, vendorRoot: 'vendor' })
    const output = outcome.lines.join('\n')
    assert.equal(outcome.code, 1, output)
    assert.match(output, /degrade-unpatched is reserved for the core official row/u)
    assert.match(output, /got @deepseek-ai\/dsh-deepseek-chat-import/u)
    assert.equal(output.includes('OK verify-runtime-plugin-patches'), false)
  } finally {
    rmSync(badRoot, { recursive: true, force: true })
  }
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

test('CLI: both real fixture payloads under --vendor-root verify raw+served and exit 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-patch-gate-'))
  try {
    for (const [packageId, text] of [[patch.packageId, positiveFixture()],
      [patchModule.DOCUMENT_PREVIEW_PACKAGE_ID, documentPreviewFixture()]]) {
      const payload = payloadPath(root, packageId)
      mkdirSync(join(root, 'node_modules', packageId, 'lib'), { recursive: true })
      writeFileSync(payload, text)
    }
    const result = runGateCli(['--vendor-root', root])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /raw .* served .* anchors, probe .* policy refuse, apply ok/u)
    assert.match(result.stdout, /policy degrade-unpatched, apply ok/u)
    assert.match(result.stdout, /2 patch\(es\) x raw\+served verified/u)
    assert.match(result.stdout, /OK verify-runtime-plugin-patches/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: a drifted document-preview payload is red (pin drift stays fail-closed for a degrade entry)', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-patch-gate-drift-'))
  try {
    const payload = payloadPath(root, patchModule.DOCUMENT_PREVIEW_PACKAGE_ID)
    mkdirSync(join(root, 'node_modules', patchModule.DOCUMENT_PREVIEW_PACKAGE_ID, 'lib'), { recursive: true })
    const drifted = documentPreviewFixture().replace('function MarkdownBody(', 'function MarkdownBodyX(')
    writeFileSync(payload, drifted)
    const result = runGateCli(['--vendor-root', root])
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout, /anchor 1\/2 matched 0 times/u)
    assert.match(result.stdout, /apply refused the text/u)
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

test('CLI: --require fails when only ONE registered payload is missing (partial payload is fatal)', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-patch-gate-partial-'))
  try {
    // Materialize only the chat-import payload: the document-preview entry stays missing.
    const payload = payloadPath(root, patch.packageId)
    mkdirSync(join(root, 'node_modules', patch.packageId, 'lib'), { recursive: true })
    writeFileSync(payload, positiveFixture())
    const loose = runGateCli(['--vendor-root', root])
    assert.equal(loose.status, 0, loose.stdout + loose.stderr)
    assert.match(loose.stdout, /SKIP .*documentpreview.* payload missing/u)
    const required = runGateCli(['--vendor-root', root, '--require'])
    assert.equal(required.status, 1, required.stdout + required.stderr)
    assert.match(required.stdout, /1 registered patch payload\(s\) missing/u)
    assert.equal(required.stdout.includes('OK verify-runtime-plugin-patches'), false)
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