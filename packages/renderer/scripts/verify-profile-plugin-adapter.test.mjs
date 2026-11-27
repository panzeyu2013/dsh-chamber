/**
 * Evidence-tool self-tests (`verify-profile-plugin-adapter.mjs`): argument parsing, the
 * serving transform parity with the official per-pin gate, artifact reading, structural
 * inspection (witness/base-token/factory-anchor/metadata drift) and the CLI exit codes.
 * The tool is a manual per-adapter evidence helper, so its pure seam is locked here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  USAGE,
  evidencePinProblems,
  inspectArtifact,
  inspectExportsMetadata,
  parseArgs,
  readArtifact,
  readArtifactPackageName,
  resolveTarballClientPath,
  sha256,
  toServedComboText,
} from './verify-profile-plugin-adapter.mjs'
import { toServedComboText as officialServedText } from '../../../scripts/upstream/verify/verify-runtime-plugin-patches.mjs'

const SCRIPT = fileURLToPath(new URL('./verify-profile-plugin-adapter.mjs', import.meta.url))
const adapters = await import(pathToFileURL(fileURLToPath(new URL('../src/profile-plugin-adapters.ts', import.meta.url))).href)

function fixture(extraExports = '') {
  return [
    'window.__ModuleLoader__.load({',
    '  id: "acme-evidence",',
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    '    const state = { reads: 0 };',
    '    const bridgeUrl = (endpoint) => new URL("api/acme-evidence/" + endpoint, document.baseURI).toString();',
    '    function apply(ctx) { state.reads += 1; return bridgeUrl("describe") }',
    '    exports.apply = apply;',
    '    exports.inject = ["slots"];',
    extraExports,
    '    return module.exports;',
    '  },',
    '});',
  ].filter(line => line !== '').join('\n')
}

const adapter = {
  packageId: 'acme-evidence',
  metadata: { inject: ['slots'] },
  baseUri: { expectedCount: 1 },
  witnesses: ['const state = { reads: 0 };'],
  reason: 'synthetic evidence-tool self-test adapter',
}

test('parseArgs accepts the documented flags and rejects malformed invocations', async () => {
  assert.equal(parseArgs(['--help']).help, true)
  const full = parseArgs(['--package', 'pkg', '--artifact', 'a.tgz', '--sha256', 'ab', '--out', 'dir'])
  assert.deepEqual(full.problems, [])
  assert.equal(full.pkg, 'pkg')
  assert.equal(full.artifact, 'a.tgz')
  assert.equal(full.sha256, 'ab')
  assert.equal(full.out, 'dir')
  assert.equal(parseArgs(['--adapter-json', 'adapter.json', '--artifact', 'a.js']).adapterJson, 'adapter.json')
  assert.match(parseArgs(['--package']).problems.join('\n'), /needs a value/)
  assert.match(parseArgs(['--wat']).problems.join('\n'), /unknown argument/)
  assert.ok(USAGE.includes('--package'))
})

test('the serving transform is byte-identical to the official per-pin gate transform', async () => {
  for (const raw of [
    'window.__ModuleLoader__.load({});\n//# sourceMappingURL=client.js.map\n//# sourceURL=client.js\n',
    'plain body\n',
    'body\n//# sourceURL=/plugins/x/client.js\n',
    'body //# sourceURL=/inline/client.js\n',
  ]) {
    assert.equal(toServedComboText(raw), officialServedText(raw), JSON.stringify(raw))
  }
})

test('sha256 and readArtifact handle a plain client.js file and an npm tarball exports["./client"]', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'profile-evidence-tgz-'))
  mkdirSync(join(directory, 'package', 'dist'), { recursive: true })
  writeFileSync(join(directory, 'package', 'package.json'), JSON.stringify({ name: 'acme-evidence', exports: { './client': './dist/client.js' } }))
  writeFileSync(join(directory, 'package', 'dist', 'client.js'), fixture())
  const tarball = join(directory, 'acme-evidence.tgz')
  const tarred = spawnSync('tar', ['-czf', tarball, 'package'], { cwd: directory, encoding: 'utf8' })
  assert.equal(tarred.status, 0, tarred.stderr)
  assert.equal(resolveTarballClientPath(tarball), 'package/dist/client.js')
  assert.equal(readArtifactPackageName(tarball), 'acme-evidence')
  assert.equal(readArtifact(tarball), fixture())
});
test('sha256 and readArtifact handle a plain client.js file', async () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const directory = mkdtempSync(join(tmpdir(), 'profile-evidence-'))
  const path = join(directory, 'client.js')
  writeFileSync(path, fixture())
  assert.equal(readArtifact(path), fixture())
})

test('inspectArtifact accepts the synthetic artifact on raw+served and reports drift', async () => {
  const outcome = await inspectArtifact(adapters, adapter, fixture())
  assert.deepEqual(outcome.problems, [])
  assert.deepEqual([...outcome.patchedByLabel.keys()].sort(), ['raw', 'served'])
  const drift = await inspectArtifact(adapters, adapter, fixture().replace('const state = { reads: 0 };', 'const state = { reads: 1 };'))
  assert.match(drift.problems.join('\n'), /witness/)
  assert.equal(drift.patchedByLabel.size, 0)
})

test('inspectArtifact runtime probe fails on unsupported plugin forms and metadata mismatch', async () => {
  const fnArtifact = [
    'window.__ModuleLoader__.load({',
    '  id: "acme-evidence",',
    '  factory: (require) => function plugin(ctx) { return ctx },',
    '});',
  ].join('\n')
  const fnOutcome = await inspectArtifact(adapters, { ...adapter, baseUri: undefined }, fnArtifact)
  assert.match(fnOutcome.problems.join('\n'), /object plugins/u)

  const mismatch = await inspectArtifact(adapters, { ...adapter, metadata: { inject: ['other'] } }, fixture())
  assert.match(mismatch.problems.join('\n'), /inject.*other/u)
})

test('inspectArtifact leaves tokens outside the factory body unchanged and warns about them', async () => {
  const withOutside = 'const ROOT = document.baseURI;\n' + fixture()
  const outcome = await inspectArtifact(adapters, adapter, withOutside)
  assert.deepEqual(outcome.problems, [])
  assert.match(outcome.warnings.join('\n'), /outside the factory body/u)
})

test('inspectArtifact reports qualified base tokens, factory-anchor shape and extra exports', async () => {
  const qualified = await inspectArtifact(adapters, adapter, fixture().replace('document.baseURI', 'window.document.baseURI'))
  assert.match(qualified.problems.join('\n'), /qualified\/aliased document\.baseURI/)
  const shape = await inspectArtifact(adapters, adapter, fixture().replace('  },', '  },\n  meta: () => ({}),'))
  assert.match(shape.problems.join('\n'), /factory close anchor matched 0 times/)
  const extra = await inspectArtifact(adapters, adapter, fixture('    exports.Config = {};'))
  assert.match(extra.problems.join('\n'), /artifact exports `Config`/)
  const metadata = inspectExportsMetadata(adapter, 'exports.Config = {};')
  assert.match(metadata.problems.join('\n'), /artifact exports `Config`/)
  assert.deepEqual(metadata.warnings, [])
  const noBase = await inspectArtifact(adapters, { ...adapter, baseUri: undefined }, fixture())
  assert.match(noBase.problems.join('\n'), /declares no baseUri transform/)
})

test('the CLI: --help exits 0, missing args exit 2, an unregistered package exits 1', async () => {
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--package/)
  const missing = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /--artifact plus --package or --adapter-json is required/)
  const unregistered = spawnSync(process.execPath, [SCRIPT, '--package', 'not-registered', '--artifact', 'x.js'], { encoding: 'utf8' })
  assert.equal(unregistered.status, 1)
  assert.match(unregistered.stderr, /is not registered in profile-plugin-registry\.ts/)
})

test('inspectArtifact honors closeOccurrence last for the minified served shape', async () => {
  const minified = 'window.__ModuleLoader__.load({id:"acme-evidence",factory:require=>{var module={exports:{}};var exports=module.exports;const state={reads:0};const holder="}});";const bridgeUrl=(e)=>new URL("api/acme-evidence/"+e,document.baseURI).toString();function apply(ctx){state.reads+=1}const inject=["slots"];exports.apply=apply;exports.inject=inject;return module.exports}});'
  const lastAdapter = {
    ...adapter,
    witnesses: ['const state={reads:0};'],
    factoryAnchors: { open: 'factory:require=>{', close: '}});', closeOccurrence: 'last' },
  }
  const outcome = await inspectArtifact(adapters, lastAdapter, minified)
  assert.deepEqual(outcome.problems, [])
  assert.deepEqual([...outcome.patchedByLabel.keys()].sort(), ['raw', 'served'])
})

test('inspectArtifact survives an async apply rejection (no unhandled rejection)', async () => {
  const asyncArtifact = [
    'window.__ModuleLoader__.load({',
    '  id: "acme-evidence",',
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    '    const state = { reads: 0 };',
    '    async function apply(ctx) { state.reads += 1; throw new Error("async boom") }',
    '    exports.apply = apply;',
    '    exports.inject = ["slots"];',
    '    return module.exports;',
    '  },',
    '});',
  ].join('\n')
  const outcome = await inspectArtifact(adapters, { ...adapter, baseUri: undefined }, asyncArtifact)
  assert.match(outcome.warnings.join('\n'), /async boom/u)
})

test('the CLI diagnoses an unusable --adapter-json candidate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'profile-evidence-bad-json-'))
  const artifact = join(directory, 'client.js')
  writeFileSync(artifact, fixture())
  const candidate = join(directory, 'bad-adapter.json')
  writeFileSync(candidate, JSON.stringify({ packageId: 'acme-evidence', reason: 'missing witnesses' }))
  const run = spawnSync(process.execPath, [SCRIPT, '--adapter-json', candidate, '--artifact', artifact], { encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /is not a usable adapter/u)
})

test('the CLI success path validates a candidate adapter via --adapter-json', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'profile-evidence-cli-'))
  const artifact = join(directory, 'client.js')
  writeFileSync(artifact, fixture())
  const candidate = join(directory, 'adapter.json')
  writeFileSync(candidate, JSON.stringify({ ...adapter, evidence: { sha256: sha256(fixture()) } }))
  const run = spawnSync(process.execPath, [SCRIPT, '--adapter-json', candidate, '--artifact', artifact], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /OK verify-profile-plugin-adapter/u)
})
test('inspectArtifact reports a rewritten text that does not compile', async () => {
  // The guards pass but the explicit rewrite produces invalid JavaScript: the compile check
  // must surface it (otherwise a candidate artifact with a broken route replacement would
  // silently ship a script that fails at load time).
  const brokenRewrite = {
    ...adapter,
    anchorRewrites: [{ anchor: 'const bridgeUrl = (endpoint)', replacement: 'const bridgeUrl = (' }],
  }
  const outcome = await inspectArtifact(adapters, brokenRewrite, fixture())
  assert.match(outcome.problems.join('\n'), /patched text does not compile/u)
})

test('inspectArtifact reports factory-body one-time side effects as a problem', async () => {
  // The wrapper re-runs the factory body per mount; a side effect must block registration.
  // A comment is enough for the textual scan and keeps the raw artifact executable.
  const outcome = await inspectArtifact(adapters, adapter, fixture('    // legacy: customElements.define("x", class {})'))
  assert.match(outcome.problems.join('\n'), /customElements\.define/u)
})

test('inspectArtifact reports runtime-only extra exports the text scan cannot see', async () => {
  const objectExtra = [
    'window.__ModuleLoader__.load({',
    '  id: "acme-evidence",',
    '  factory: (require) => {',
    '    const state = { reads: 0 };',
    '    const bridgeUrl = (endpoint) => new URL("api/acme-evidence/" + endpoint, document.baseURI).toString();',
    '    function apply(ctx) { state.reads += 1; return bridgeUrl("describe") }',
    '    return { apply, inject: ["slots"], hidden: 1 };',
    '  },',
    '});',
  ].join('\n')
  const outcome = await inspectArtifact(adapters, adapter, objectExtra)
  assert.match(outcome.problems.join('\n'), /factory exports hidden/u)
})

test('inspectArtifact reports metadata.name drift from the artifact plugin', async () => {
  const namedArtifact = fixture().replace(
    '    exports.inject = ["slots"];',
    '    exports.inject = ["slots"];\n    exports.name = "artifact-name";',
  )
  const namedAdapter = { ...adapter, metadata: { inject: ['slots'], name: 'declared-name' } }
  const outcome = await inspectArtifact(adapters, namedAdapter, namedArtifact)
  assert.match(outcome.problems.join('\n'), /artifact name "artifact-name" !== adapter metadata\.name "declared-name"/u)
})

test('inspectArtifact splits uncovered baseURI forms by region (inside problem, outside warning)', async () => {
  const insideComputed = fixture().replace(
    '    exports.inject = ["slots"];',
    '    exports.inject = ["slots"];\n    const computed = document["baseURI"];',
  )
  const inside = await inspectArtifact(adapters, adapter, insideComputed)
  assert.match(inside.problems.join('\n'), /inside the factory body are not covered/u)
  const outsideAlias = 'const ROOT = document["baseURI"];\n' + fixture()
  const outside = await inspectArtifact(adapters, adapter, outsideAlias)
  assert.deepEqual(outside.problems, [])
  assert.match(outside.warnings.join('\n'), /outside the factory body are left unchanged/u)
  // With no declared transform the framework still refuses any uncovered word INSIDE the body.
  const noBaseInside = await inspectArtifact(adapters, { ...adapter, baseUri: undefined }, fixture().replace('document.baseURI', 'document["baseURI"]'))
  assert.match(noBaseInside.problems.join('\n'), /inside the factory body are not covered/u)
})

test('the release re-run pin logic is a pure seam with every branch locked', () => {
  const digest = sha256(fixture())
  const pinned = { ...adapter, evidence: { sha256: digest, artifact: 'npm pack <package>' } }
  const base = { adapterJson: false, parsedSha: undefined, digest, publishedName: 'acme-evidence' }
  assert.deepEqual(evidencePinProblems({ adapter: pinned, ...base }), [])
  assert.match(evidencePinProblems({ adapter: pinned, ...base, parsedSha: '0'.repeat(64) }).join('\n'), /artifact sha256 .* !== expected/u)
  const noPin = evidencePinProblems({ adapter: { ...adapter }, ...base, publishedName: undefined })
  assert.match(noPin.join('\n'), /must record evidence\.sha256/u)
  assert.match(noPin.join('\n'), /must record evidence\.artifact/u)
  assert.match(evidencePinProblems({ adapter: pinned, ...base, publishedName: 'other-name' }).join('\n'), /package\.json name/u)
  assert.match(evidencePinProblems({ adapter: { ...adapter, evidence: { sha256: '0'.repeat(64), artifact: 'x' } }, ...base, publishedName: undefined }).join('\n'), /artifact sha256 .* !== expected/u)
  // An adapter-json candidate may omit evidence fields; an explicit --sha256 still applies.
  assert.deepEqual(evidencePinProblems({ adapter: { ...adapter }, ...base, adapterJson: true, publishedName: undefined }), [])
  assert.match(evidencePinProblems({ adapter: { ...adapter }, ...base, adapterJson: true, publishedName: undefined, parsedSha: '0'.repeat(64) }).join('\n'), /artifact sha256 .* !== expected/u)
})

test('inspectExportsMetadata keeps direct module.exports as a manual-review warning', () => {
  const scan = inspectExportsMetadata(adapter, 'module.exports = { apply() {} };')
  assert.deepEqual(scan.problems, [])
  assert.match(scan.warnings.join('\n'), /module\.exports directly/u)
})

test('the CLI treats -h and --help as help even with malformed extra args', () => {
  for (const argv of [['-h'], ['--help', '--wat']]) {
    const run = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8' })
    assert.equal(run.status, 0, JSON.stringify(argv) + ': ' + run.stderr)
    assert.match(run.stdout, /Usage:/u)
  }
})

test('the CLI fails an explicit --sha256 mismatch for an adapter-json candidate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'profile-evidence-sha-'))
  const artifact = join(directory, 'client.js')
  writeFileSync(artifact, fixture())
  const candidate = join(directory, 'adapter.json')
  writeFileSync(candidate, JSON.stringify({ ...adapter }))
  const run = spawnSync(process.execPath, [SCRIPT, '--adapter-json', candidate, '--artifact', artifact, '--sha256', '0'.repeat(64)], { encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /artifact sha256 .* !== expected/u)
})

test('the CLI writes both patched texts when --out is given', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'profile-evidence-out-'))
  const artifact = join(directory, 'client.js')
  writeFileSync(artifact, fixture())
  const candidate = join(directory, 'adapter.json')
  writeFileSync(candidate, JSON.stringify({ ...adapter }))
  const out = join(directory, 'out')
  const run = spawnSync(process.execPath, [SCRIPT, '--adapter-json', candidate, '--artifact', artifact, '--out', out], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  for (const name of ['client.raw.patched.js', 'client.served.patched.js']) {
    assert.match(readFileSync(join(out, name), 'utf8'), /const createInstance = /u, name)
  }
})

test('inspectArtifact reports an artifact the adapter cannot patch at all', async () => {
  // Preserve the witness so the refusal is attributable to the parameter collision, and keep
  // the raw bundle executable (the collision only affects the wrapper's injected scope).
  const paramArtifact = fixture().replace(
    '    exports.inject = ["slots"];',
    '    exports.inject = ["slots"];\n    const existing = __dshChamberBasePath;',
  )
  const outcome = await inspectArtifact(adapters, adapter, paramArtifact)
  assert.match(outcome.problems.join('\n'), /applyProfileAdapter refused the artifact/u)
  assert.equal(outcome.patchedByLabel.size, 0)
})
