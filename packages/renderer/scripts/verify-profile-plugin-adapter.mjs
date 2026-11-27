#!/usr/bin/env node
/**
 * verify-profile-plugin-adapter.mjs - per-adapter artifact evidence for the optional
 * profile-plugin adapter layer (design 09 §4).
 *
 * MANUAL evidence tool, NOT a CI gate and NOT part of the official per-pin gate:
 * `scripts/upstream/verify/verify-runtime-plugin-patches.mjs` keeps its scope (bundled
 * official payloads only) and never reads this registry. Each concrete third-party
 * adapter entry in `packages/renderer/src/profile-plugin-registry.ts` must carry its own
 * artifact evidence produced by this script; PRs record the output.
 *
 * The script is package/version agnostic: the adapter descriptor comes from the registry
 * and the artifact is supplied by the caller (npm tarball or an extracted client.js),
 * with an optional sha256 pin. It never hardcodes a package id or version.
 *
 * Checks per artifact, on BOTH the raw published text and the upstream served-combo
 * shape: adapter shape validation; every witness exactly once; the declared bare
 * `document.baseURI` token count (qualified/aliased forms are reported as unsafe); every
 * explicit anchor exactly once; the factory anchors present exactly once; the generic
 * per-apply rewrite succeeds and the rewritten classic script compiles; a best-effort
 * runtime shape probe (fake page seams, no browser) then executes raw and patched text and
 * checks: object plugin with apply(), wrapper apply non-constructable, exported-key subset,
 * and `inject`/`name` equality with the adapter metadata. It also reports explicit
 * `exports.<name>` drift so dropped Cordis metadata (provide/Config/reusable/...) is
 * visible at review time (the wrapper can only re-expose apply/inject/name).
 *
 * Runtime behavior (per-apply state isolation, per-ctx prefix) is covered by the synthetic
 * fixture suite in `packages/renderer/test/lifecycle/profile-plugin-adapters.test.ts`;
 * this tool proves the REAL artifact still matches the adapter's structural guards.
 *
 * Usage:
 *   node packages/renderer/scripts/verify-profile-plugin-adapter.mjs \
 *     (--package <npm package id> | --adapter-json <file>) --artifact <tarball|client.js> [--sha256 <hex>] [--out <dir>] [--help]
 *
 * Exit codes: 0 evidence complete - 1 problems - 2 usage error.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')

export const USAGE = [
  'Usage: node packages/renderer/scripts/verify-profile-plugin-adapter.mjs',
  '         (--package <npm package id> | --adapter-json <file>) --artifact <tarball|client.js> [--sha256 <hex>] [--out <dir>] [--help]',
  '',
  '  --package      registered profile adapter package id (looked up in profile-plugin-registry.ts)',
  '  --adapter-json validate a candidate adapter JSON without registering it (framework-only registries)',
  '  --artifact     npm tarball (.tgz/.tar.gz: package.json exports["./client"] is resolved) or a client.js path',
  '  --sha256       optional expected sha256 of the client.js text (defaults to adapter.evidence.sha256)',
  '  --out          optional directory: write client.raw.patched.js and client.served.patched.js',
  '  --help/-h      print this usage',
  '',
  'Evidence only for the optional profile-plugin adapter layer (design 09 §4); the official',
  'runtime-patch gate keeps its own scope. Exit 0 evidence complete, 1 problems, 2 usage error.',
].join('\n')

/** Parse CLI arguments; problems are usage errors (exit 2). */
export function parseArgs(argv) {
  const flags = { help: false, pkg: undefined, artifact: undefined, sha256: undefined, out: undefined, adapterJson: undefined }
  const problems = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') { flags.help = true; continue }
    if (argument === '--package' || argument === '--adapter-json' || argument === '--artifact' || argument === '--sha256' || argument === '--out') {
      const value = argv[index + 1]
      if (value === undefined || value === '' || value.startsWith('-')) { problems.push(argument + ' needs a value'); continue }
      const key = argument === '--package' ? 'pkg' : argument === '--adapter-json' ? 'adapterJson' : argument.slice(2)
      flags[key] = value
      index += 1
      continue
    }
    problems.push('unknown argument ' + argument)
  }
  return { ...flags, problems }
}

/** Sha256 of one UTF-8 text (artifact evidence pin). */
export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** Count non-overlapping literal occurrences of one string. */
export function countOccurrences(text, needle) {
  let total = 0
  let at = text.indexOf(needle)
  while (at >= 0) {
    total += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return total
}

/**
 * Approximate the upstream combo serving transform the same way the official per-pin
 * gate does: strip per-module sourceURL/sourceMappingURL trailers, keep a trailing ';'
 * separator and append the combo sourceMappingURL. Every adapter witness/anchor lives
 * mid-body, so this trailer-zone approximation cannot move one; the raw check remains
 * the real artifact byte for byte.
 */
export function toServedComboText(raw) {
  // Byte-identical to the official per-pin gate transform (verify-runtime-plugin-patches
  // .mjs): the trailer regexes are NOT line-start anchored, so an inline trailer is
  // stripped here exactly like the official gate strips it.
  const stripped = String(raw)
    .replace(/\/\/# sourceMappingURL=.*$/m, '')
    .replace(/\/\/# sourceURL=.*$/m, '')
    .replace(/\s+$/u, '')
  return stripped + ';\n' + '//# sourceMappingURL=/plugins/??<combo>.js.map&rev=verify\n'
}

/** Extract one member of an npm tarball as UTF-8 text (throws on absence). */
function readTarballMember(tarballPath, member) {
  const extracted = spawnSync('tar', ['-xOzf', tarballPath, member], { maxBuffer: 32 * 1024 * 1024 })
  if (extracted.status !== 0) {
    throw new Error('could not extract ' + member + ' from ' + tarballPath + ': ' + String(extracted.stderr))
  }
  return extracted.stdout.toString('utf8')
}

/** Resolve the published client bundle member inside one npm tarball. */
export function resolveTarballClientPath(tarballPath) {
  try {
    const manifest = JSON.parse(readTarballMember(tarballPath, 'package/package.json'))
    const exported = manifest?.exports?.['./client']
    const candidate = typeof exported === 'string'
      ? exported
      : exported?.default
    if (typeof candidate === 'string' && candidate !== '') {
      return 'package/' + candidate.replace(/^\.\//u, '')
    }
  } catch {
    /* fall through to the npm-standard member */
  }
  return 'package/lib/client.js'
}

/** Read one artifact: npm tarball (exports["./client"], else package/lib/client.js) or a file. */
export function readArtifact(artifactPath) {
  const absolute = resolve(artifactPath)
  if (/\.(?:tgz|tar\.gz)$/iu.test(absolute)) return readTarballMember(absolute, resolveTarballClientPath(absolute))
  return readFileSync(absolute, 'utf8')
}

/** Published package name of one npm tarball (undefined for a plain client.js or unreadable manifest). */
export function readArtifactPackageName(artifactPath) {
  const absolute = resolve(artifactPath)
  if (!/\.(?:tgz|tar\.gz)$/iu.test(absolute)) return undefined
  try {
    return JSON.parse(readTarballMember(absolute, 'package/package.json')).name
  } catch {
    return undefined
  }
}

/**
 * Best-effort extra-export scan: the wrapper only re-exposes declared metadata. Findings
 * are WARNINGS (printed, never fail the evidence run) because the scan is textual and a
 * direct `module.exports = {...}` cannot be enumerated statically.
 */
export function inspectExportsMetadata(adapter, raw) {
  const problems = []
  const warnings = []
  const declared = new Set(['apply'])
  if (adapter.metadata?.inject !== undefined) declared.add('inject')
  if (adapter.metadata?.name !== undefined) declared.add('name')
  const names = new Set()
  for (const match of String(raw).matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=/gu)) names.add(match[1])
  if (/\bmodule\.exports\s*=\s*\{/u.test(raw)) {
    // A direct object assignment cannot be enumerated statically; ask for manual review.
    warnings.push('artifact assigns module.exports directly; confirm the adapter declares every plugin export it needs (the wrapper re-exposes only apply/inject/name)')
  }
  for (const name of names) {
    if (declared.has(name)) continue
    if (name === '__esModule') continue // CJS interop marker, not plugin metadata
    problems.push('artifact exports `' + name + '` which the adapter metadata does not declare; the wrapper drops every export except apply/inject/name')
  }
  return { problems, warnings }
}

/** Install the minimal page seams a classic combo bundle touches at load time. */
async function withPageStubs(run) {
  const globals = globalThis
  const restores = []
  const set = (key, value) => {
    const previous = Object.getOwnPropertyDescriptor(globals, key)
    try {
      Object.defineProperty(globals, key, { value, writable: true, configurable: true })
    } catch {
      return // a read-only platform global (e.g. navigator on newer Node) is good enough
    }
    restores.push(() => {
      if (previous === undefined) delete globals[key]
      else Object.defineProperty(globals, key, previous)
    })
  }
  const noop = () => {}
  const element = () => ({ dataset: {}, style: {}, setAttribute: noop, appendChild: noop, remove: noop, addEventListener: noop, removeEventListener: noop })
  set('window', {
    __ModuleLoader__: { load: (handoff) => { globals.__profileEvidenceHandoff = handoff } },
    location: { origin: 'http://127.0.0.1:17510' },
    addEventListener: noop,
    removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: noop,
  })
  set('location', { origin: 'http://127.0.0.1:17510' })
  set('document', {
    baseURI: 'http://127.0.0.1:17510/',
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: element,
    createTextNode: () => ({}),
    head: { appendChild: noop },
    body: { appendChild: noop },
    documentElement: { appendChild: noop },
    addEventListener: noop,
    removeEventListener: noop,
    getElementById: () => null,
  })
  set('fetch', async () => ({ ok: true, json: async () => ({}), text: async () => '' }))
  try {
    return await run()
  } finally {
    for (const restore of restores.reverse()) restore()
    delete globals.__profileEvidenceHandoff
  }
}

const ALLOWED_PLUGIN_EXPORTS = new Set(['apply', 'inject', 'name'])
const FACTORY_SIDE_EFFECT_PATTERNS = [
  ['customElements.define(', 'customElements.define'],
  ['document.addEventListener(', 'document.addEventListener'],
  ['window.addEventListener(', 'window.addEventListener'],
  ['setInterval(', 'setInterval'],
  ['new MutationObserver(', 'MutationObserver'],
]

/** Best-effort runtime probe of one classic bundle text: registration + factory exports. */
export async function inspectBundleShape(adapter, label, text) {
  const problems = []
  const warnings = []
  try {
    await withPageStubs(async () => {
      new Function(text)()
      const handoff = globalThis.__profileEvidenceHandoff
      if (handoff === undefined || typeof handoff.factory !== 'function') {
        problems.push(label + ': shape probe: bundle did not register a factory through window.__ModuleLoader__.load')
        return
      }
      let plugin
      try {
        plugin = handoff.factory(new Proxy({}, { get: () => ({}) }))
      } catch (error) {
        const message = label + ': shape probe: factory could not materialize under the generic require stub: ' + (error instanceof Error ? error.message : String(error))
        if (adapter.metadata?.inject !== undefined || adapter.metadata?.name !== undefined) {
          problems.push(message + '; the declared metadata.inject/name is therefore UNVERIFIED')
        } else {
          warnings.push(message)
        }
        return
      }
      if (plugin === null || typeof plugin !== 'object') {
        problems.push(label + ': shape probe: factory returns ' + (plugin === null ? 'null' : typeof plugin) + '; the adapter layer only supports object plugins with apply()')
        return
      }
      if (typeof plugin.apply !== 'function') problems.push(label + ': shape probe: factory plugin object has no apply()')
      const extra = Object.keys(plugin).filter((key) => !ALLOWED_PLUGIN_EXPORTS.has(key) && key !== '__esModule' && key !== 'default')
      if (extra.length > 0) problems.push(label + ': shape probe: factory exports ' + extra.join(', ') + ' which the wrapper would drop; the adapter metadata must model every needed export')
      for (const key of ['inject', 'name']) {
        const declared = adapter.metadata?.[key]
        const actual = plugin[key]
        if (declared === undefined && actual !== undefined) problems.push(label + ': shape probe: artifact exports ' + key + ' but adapter metadata.' + key + ' is absent')
        else if (declared !== undefined && actual === undefined) problems.push(label + ': shape probe: adapter declares metadata.' + key + ' but the artifact plugin has no ' + key)
        else if (declared !== undefined && JSON.stringify(declared) !== JSON.stringify(actual)) problems.push(label + ': shape probe: artifact ' + key + ' ' + JSON.stringify(actual) + ' !== adapter metadata.' + key + ' ' + JSON.stringify(declared))
      }
    })
  } catch (error) {
    warnings.push(label + ': shape probe: artifact could not execute under the generic page stub: ' + (error instanceof Error ? error.message : String(error)))
  }
  return { problems, warnings }
}

/** Best-effort patched-text probe: the wrapper must expose a non-constructable apply and no dropped exports. */
export async function inspectPatchedShape(adapter, label, patched) {
  const problems = []
  const warnings = []
  try {
    await withPageStubs(async () => {
      new Function(patched)()
      const handoff = globalThis.__profileEvidenceHandoff
      if (handoff === undefined || typeof handoff.factory !== 'function') {
        problems.push(label + ': patched shape probe: no factory registration')
        return
      }
      let plugin
      try {
        plugin = handoff.factory(new Proxy({}, { get: () => ({}) }))
      } catch (error) {
        problems.push(label + ': patched shape probe: factory threw: ' + (error instanceof Error ? error.message : String(error)))
        return
      }
      if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
        problems.push(label + ': patched shape probe: wrapper did not expose an object plugin with apply()')
        return
      }
      if (Object.prototype.hasOwnProperty.call(plugin.apply, 'prototype')) problems.push(label + ': patched shape probe: wrapper apply is constructable (cordis would call it with new)')
      const extra = Object.keys(plugin).filter((key) => !ALLOWED_PLUGIN_EXPORTS.has(key) && key !== '__esModule' && key !== 'default')
      if (extra.length > 0) problems.push(label + ': patched shape probe: wrapper exposes unexpected keys ' + extra.join(', '))
      const fakeContext = {
        get: () => undefined,
        inject: (_deps, callback) => callback(fakeContext),
        effect: (callback) => { try { callback() } catch (error) { warnings.push(label + ': patched shape probe: instance effect threw under the generic stub: ' + (error instanceof Error ? error.message : String(error))) } },
        on: () => () => {},
        slots: { inject: (_name, callback) => callback(), register: () => () => {} },
      }
      try {
        await Promise.resolve(plugin.apply(fakeContext))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Wrapper contract errors are hard failures; a generic stub missing a plugin
        // service is only a warning (the real page provides that service).
        if (message.startsWith('dsh-chamber: optional profile adapter for ')) problems.push(label + ': patched shape probe: ' + message)
        else warnings.push(label + ': patched shape probe: apply threw under the generic stub context: ' + message)
      }
    })
  } catch (error) {
    warnings.push(label + ': patched shape probe: patched text could not execute under the generic page stub: ' + (error instanceof Error ? error.message : String(error)))
  }
  return { problems, warnings }
}


/** Run the evidence checks for one adapter against one artifact text. */
export async function inspectArtifact(adaptersModule, adapter, raw) {
  const problems = []
  const warnings = []
  for (const problem of adaptersModule.validateProfileAdapter(adapter)) problems.push('adapter shape: ' + problem)
  const open = adapter.factoryAnchors?.open ?? adaptersModule.PROFILE_FACTORY_OPEN
  const close = adapter.factoryAnchors?.close ?? adaptersModule.PROFILE_FACTORY_CLOSE
  const openCount = countOccurrences(raw, open)
  const closeCount = countOccurrences(raw, close)
  const closeOccurrence = adapter.factoryAnchors?.closeOccurrence ?? 'first'
  if (openCount !== 1) problems.push('raw: factory open anchor matched ' + openCount + ' times (expected 1); a non-default shape needs factoryAnchors.open')
  if (closeOccurrence === 'last' ? closeCount < 1 : closeCount !== 1) {
    problems.push('raw: factory close anchor matched ' + closeCount + ' times (' + (closeOccurrence === 'last' ? 'expected >= 1' : 'expected 1') + '); a load object with fields after the factory needs factoryAnchors.close (and a repeated minified tail needs closeOccurrence last)')
  }
  const openAt = raw.indexOf(open)
  const closeAt = closeOccurrence === 'last' ? raw.lastIndexOf(close) : raw.indexOf(close)
  const hasRegion = openCount === 1 && (closeOccurrence === 'last' ? closeCount >= 1 : closeCount === 1) && closeAt > openAt + open.length
  const region = hasRegion ? raw.slice(openAt + open.length, closeAt) : raw
  const regionScan = adaptersModule.scanDocumentBaseUri(region)
  const wholeScan = adaptersModule.scanDocumentBaseUri(raw)
  if (adapter.baseUri !== undefined) {
    if (!hasRegion) problems.push('raw: cannot locate the factory body to bound the baseUri transform')
    if (regionScan.total !== regionScan.bare) problems.push('raw: ' + String(regionScan.total - regionScan.bare) + ' qualified/aliased document.baseURI occurrence(s) inside the factory body cannot be rewritten')
    if (regionScan.bare !== adapter.baseUri.expectedCount) problems.push('raw: bare document.baseURI inside the factory body matched ' + regionScan.bare + ' times (expected ' + adapter.baseUri.expectedCount + ')')
  } else if (regionScan.total > 0) {
    problems.push('raw: artifact carries ' + String(regionScan.total) + ' document.baseURI token(s) inside the factory body but the adapter declares no baseUri transform; those host routes would still hit the control-plane root')
  }
  if (regionScan.total > 0) warnings.push('raw: baseURI replacement is textual; confirm the counted document.baseURI occurrences are real property reads, not strings/comments')
  const outsideTokens = wholeScan.total - regionScan.total
  if (outsideTokens > 0) warnings.push('raw: ' + String(outsideTokens) + ' document.baseURI token(s) outside the factory body are left unchanged (top-level/load-object/chunk scope keeps the control-plane origin)')
  // Region split: an uncovered form INSIDE the factory body makes the framework refuse the
  // rewrite (for every adapter, declared transform or not), so it is a problem; the same form
  // OUTSIDE the body is left unchanged by contract and only needs a warning.
  const regionWords = countOccurrences(region, 'baseURI')
  const outsideWords = countOccurrences(raw, 'baseURI') - regionWords
  const uncoveredInside = regionWords - regionScan.total
  if (uncoveredInside > 0) {
    problems.push('raw: ' + String(uncoveredInside) + ' other baseURI access form(s) (computed access / alias) inside the factory body are not covered by the textual transform; the adapter refuses this artifact')
  }
  const uncoveredOutside = outsideWords - outsideTokens
  if (uncoveredOutside > 0) warnings.push('raw: ' + String(uncoveredOutside) + ' other baseURI access form(s) outside the factory body are left unchanged')
  for (const [token, label] of FACTORY_SIDE_EFFECT_PATTERNS) {
    if (region.includes(token)) problems.push('raw: factory body contains ' + label + '; factory-level one-time side effects would run per mount under this layer — move it into apply() before registering')
  }
  for (const witness of adapter.witnesses) {
    const hits = countOccurrences(raw, witness)
    if (hits !== 1) problems.push('raw: witness ' + JSON.stringify(witness.slice(0, 60)) + ' matched ' + hits + ' times (expected 1)')
  }
  for (const rewrite of adapter.anchorRewrites ?? []) {
    const hits = countOccurrences(raw, rewrite.anchor)
    if (hits !== 1) problems.push('raw: anchorRewrite ' + JSON.stringify(rewrite.anchor.slice(0, 60)) + ' matched ' + hits + ' times (expected 1)')
    if (hasRegion) {
      const at = raw.indexOf(rewrite.anchor)
      if (at < openAt + open.length || at + rewrite.anchor.length > closeAt) problems.push('raw: anchorRewrite ' + JSON.stringify(rewrite.anchor.slice(0, 60)) + ' is outside the factory body; explicit rewrites are only safe inside it')
    }
  }
  const metadataScan = inspectExportsMetadata(adapter, raw)
  problems.push(...metadataScan.problems)
  warnings.push(...metadataScan.warnings)
  const patchedByLabel = new Map()
  const labels = [['raw', raw], ['served', toServedComboText(raw)]]
  for (const [label, text] of labels) {
    const patched = adaptersModule.applyProfileAdapter(text, adapter)
    if (patched === null) {
      problems.push(label + ': applyProfileAdapter refused the artifact (witness/anchor/token/structure drift); see the guard diagnostics above')
      continue
    }
    try {
      new Function(patched)
    } catch (error) {
      problems.push(label + ': patched text does not compile: ' + (error instanceof Error ? error.message : String(error)))
    }
    patchedByLabel.set(label, patched)
  }
  const rawShape = await inspectBundleShape(adapter, 'raw', raw)
  problems.push(...rawShape.problems)
  warnings.push(...rawShape.warnings)
  for (const [label, patched] of patchedByLabel) {
    const patchedShape = await inspectPatchedShape(adapter, label, patched)
    problems.push(...patchedShape.problems)
    warnings.push(...patchedShape.warnings)
  }
  return { problems, warnings, patchedByLabel }
}

/**
 * Evidence-pin checks for one artifact: published package identity, the registered-adapter
 * evidence requirement (an entry must pin sha256 and record how to obtain the artifact) and
 * the expected-sha comparison. `--adapter-json` candidates may omit evidence fields, but an
 * explicit `--sha256` still applies to them. Pure seam so the self-test can lock every
 * branch without a registered entry (the registry ships empty).
 * @param {object} input - adapter, adapterJson flag, explicit sha, actual digest, tarball name.
 * @returns {string[]} problems (empty = evidence pin satisfied).
 */
export function evidencePinProblems({ adapter, adapterJson, parsedSha, digest, publishedName }) {
  const problems = []
  if (publishedName !== undefined && publishedName !== adapter.packageId) {
    problems.push('artifact package.json name ' + JSON.stringify(publishedName) + ' !== adapter packageId ' + JSON.stringify(adapter.packageId))
  }
  const expectedSha = parsedSha ?? adapter.evidence?.sha256
  if (!adapterJson && expectedSha === undefined) {
    problems.push('registered adapter must record evidence.sha256 (or pass --sha256) so release re-runs prove the same published artifact')
  }
  if (!adapterJson && (typeof adapter.evidence?.artifact !== 'string' || adapter.evidence.artifact.trim() === '')) {
    problems.push('registered adapter must record evidence.artifact (how to obtain the exact published client.js) so release re-runs are reproducible')
  }
  if (expectedSha !== undefined && String(expectedSha).toLowerCase() !== digest) {
    problems.push('artifact sha256 ' + digest + ' !== expected ' + String(expectedSha))
  }
  return problems
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) { console.log(USAGE); return 0 }
  if (parsed.problems.length > 0) { for (const problem of parsed.problems) console.error('[verify-profile-plugin-adapter] ' + problem); console.error(USAGE); return 2 }
  if (parsed.artifact === undefined || (parsed.pkg === undefined && parsed.adapterJson === undefined)) {
    console.error('[verify-profile-plugin-adapter] --artifact plus --package or --adapter-json is required')
    console.error(USAGE)
    return 2
  }
  let adaptersModule
  let registryModule
  let patchesModule
  try {
    adaptersModule = await import('../src/profile-plugin-adapters.ts')
    registryModule = await import('../src/profile-plugin-registry.ts')
    patchesModule = await import('../src/client-plugin-patches.ts')
  } catch (error) {
    console.error('[verify-profile-plugin-adapter] could not load the adapter modules (node with TypeScript type stripping required): ' + String(error))
    return 1
  }
  let adapter
  if (parsed.adapterJson !== undefined) {
    try {
      adapter = JSON.parse(readFileSync(resolve(parsed.adapterJson), 'utf8'))
    } catch (error) {
      console.error('[verify-profile-plugin-adapter] could not read --adapter-json: ' + (error instanceof Error ? error.message : String(error)))
      return 1
    }
    const candidateProblems = adaptersModule.validateProfileAdapter(adapter)
    if (candidateProblems.length > 0) {
      console.error('x verify-profile-plugin-adapter: --adapter-json is not a usable adapter:')
      for (const problem of candidateProblems) console.error('  - ' + problem)
      return 1
    }
    if (parsed.pkg !== undefined && parsed.pkg !== adapter.packageId) {
      console.error('[verify-profile-plugin-adapter] --package ' + JSON.stringify(parsed.pkg) + ' does not match adapter-json packageId ' + JSON.stringify(adapter.packageId))
      return 2
    }
  } else {
    adapter = registryModule.PROFILE_PLUGIN_ADAPTERS.find(entry => entry.packageId === parsed.pkg)
    if (adapter === undefined) {
      console.error('[verify-profile-plugin-adapter] package ' + JSON.stringify(parsed.pkg) + ' is not registered in profile-plugin-registry.ts')
      return 1
    }
  }
  const problems = []
  const comboUrl = '/api/i/verify/plugins/??' + String(adapter.packageId) + '/client.js&rev=evidence'
  if (patchesModule.bundlePackageIdOf(comboUrl) !== adapter.packageId) {
    problems.push('registry wiring: packageId ' + JSON.stringify(adapter.packageId) + ' does not form the combo resource <id>/client.js; the runtime matcher can never select it')
  }
  let raw
  try { raw = readArtifact(parsed.artifact) } catch (error) { console.error('[verify-profile-plugin-adapter] ' + (error instanceof Error ? error.message : String(error))); return 1 }
  const publishedName = readArtifactPackageName(parsed.artifact)
  const digest = sha256(raw)
  problems.push(...evidencePinProblems({
    adapter,
    adapterJson: parsed.adapterJson !== undefined,
    parsedSha: parsed.sha256,
    digest,
    publishedName,
  }))
  const outcome = await inspectArtifact(adaptersModule, adapter, raw)
  for (const warning of outcome.warnings) console.log('! ' + warning)
  for (const problem of outcome.problems) problems.push(problem)
  if (parsed.out !== undefined) {
    mkdirSync(parsed.out, { recursive: true })
    for (const [label, patched] of outcome.patchedByLabel) writeFileSync(join(parsed.out, 'client.' + label + '.patched.js'), patched)
  }
  const lines = [
    'adapter       ' + adapter.packageId,
    'artifact      ' + parsed.artifact + ' (' + raw.length + ' B, sha256 ' + digest + ')',
    'witnesses     ' + String(adapter.witnesses.length) + ' each exactly once on raw+served',
    'baseUri       ' + (adapter.baseUri === undefined ? 'not used' : String(adapter.baseUri.expectedCount) + ' bare document.baseURI inside the factory body'),
    'anchorRewrites ' + String(adapter.anchorRewrites?.length ?? 0),
    'factoryAnchors ' + (adapter.factoryAnchors === undefined ? 'default (synthetic shape)' : 'custom'),
    'patched       raw+served rewrite + compile ok',
  ]
  if (problems.length > 0) {
    console.error('x verify-profile-plugin-adapter: ' + problems.length + ' problem(s)')
    for (const problem of problems) console.error('  - ' + problem)
    return 1
  }
  for (const line of lines) console.log(line)
  console.log('OK verify-profile-plugin-adapter: ' + adapter.packageId + ' artifact matches the adapter guards; record this output in the PR')
  return 0
}

const isEntry = process.argv[1] !== undefined
  && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
if (isEntry) process.exitCode = await main()