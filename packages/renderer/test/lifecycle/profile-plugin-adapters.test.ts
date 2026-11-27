/**
 * Optional profile-plugin adapters (design 09 §4): the transform half — the per-apply
 * factory wrapper, the per-instance `document.baseURI` token replacement, explicit anchor
 * rewrites, adapter validation and combo classification — plus a behavioral harness over
 * the real page seam (`window.__ModuleLoader__.load` + fake page globals + fake per-entry
 * contexts). Every fixture is SYNTHETIC: no real package id or version may appear in this
 * suite. The concrete package list is data in `profile-plugin-registry.ts`; this file
 * proves the framework without any real adapter registered.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  applyProfileAdapter,
  classifyProfilePluginBundle,
  findProfilePluginAdapter,
  profilePluginPatch,
  scanDocumentBaseUri,
  validateProfileAdapter,
  PROFILE_BASE_URI_LOCAL,
  PROFILE_DOCUMENT_BASE_URI,
  PROFILE_FACTORY_CLOSE,
  PROFILE_FACTORY_OPEN,
  PROFILE_WRAPPER_MARKER,
  type ProfilePluginAdapter,
} from '../../src/profile-plugin-adapters.ts'
import { PROFILE_PLUGIN_ADAPTERS } from '../../src/profile-plugin-registry.ts'
import { CLIENT_PLUGIN_PATCHES } from '../../src/client-plugin-patches.ts'

interface ProbeEvent { id: string | undefined; reads: number; url: string }
interface ProbeGlobal { events: ProbeEvent[] }
interface ExecPlugin {
  inject?: string[]
  name?: string
  apply(ctx: FakeContext, ...args: unknown[]): unknown
}
interface FakeContext { get(name: string): unknown }

/** Approximate the upstream combo serving transform (trailer strip + separator + map). */
function servedText(text: string): string {
  return text.split('\n').filter(line => !line.startsWith('//# sourceMappingURL=') && !line.startsWith('//# sourceURL=')).join('\n').trimEnd()
    + ';\n//# sourceMappingURL=/plugins/??<combo>.js.map&rev=test\n'
}

/** One synthetic classic combo in the CJS-exports factory shape (state in factory scope). */
function cjsFixture(id: string, route: string): string {
  return [
    'window.__ModuleLoader__.load({',
    '  id: ' + JSON.stringify(id) + ',',
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    '    const react = require("react");',
    '    const state = { reads: 0 };',
    '    const bridgeUrl = (endpoint) => new URL(' + JSON.stringify(route + '/') + ' + endpoint, document.baseURI).toString();',
    '    function apply(ctx, ...args) {',
    '      state.reads += 1;',
    '      globalThis.__profileProbe.events.push({ id: ctx.get("chamberInstanceId"), reads: state.reads, url: bridgeUrl("describe") });',
    '      return String(args.length);',
    '    }',
    '    const inject = ["slots"];',
    '    exports.apply = apply;',
    '    exports.inject = inject;',
    '    return module.exports;',
    '  },',
    '});',
  ].join('\n')
}

/** One synthetic classic combo in the object-return factory shape (different inject). */
function objectFixture(id: string): string {
  return [
    'window.__ModuleLoader__.load({',
    '  id: ' + JSON.stringify(id) + ',',
    '  factory: (require) => {',
    '    const state = { reads: 0 };',
    '    function apply(ctx) {',
    '      state.reads += 1;',
    '      globalThis.__profileProbe.events.push({ id: ctx.get("chamberInstanceId"), reads: state.reads, url: "relative" });',
    '    }',
    '    return { inject: ["commandUi"], apply };',
    '  },',
    '});',
  ].join('\n')
}

/** One synthetic bundle whose host route is NOT derived from document.baseURI. */
function customRouteFixture(id: string): string {
  return [
    'window.__ModuleLoader__.load({',
    '  id: ' + JSON.stringify(id) + ',',
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    '    const state = { reads: 0 };',
    '    const API = "/api/acme-custom";',
    '    function apply(ctx) {',
    '      state.reads += 1;',
    '      globalThis.__profileProbe.events.push({ id: ctx.get("chamberInstanceId"), reads: state.reads, url: new URL(API + "/describe", document.baseURI).toString() });',
    '    }',
    '    exports.apply = apply;',
    '    exports.inject = ["slots"];',
    '    return module.exports;',
    '  },',
    '});',
  ].join('\n')
}

/** One synthetic bundle in the official-preset shape: load-object fields after the factory. */
function metaTailFixture(id: string): string {
  return [
    'window.__ModuleLoader__.load({',
    '  id: ' + JSON.stringify(id) + ',',
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    '    const state = { reads: 0 };',
    '    function apply(ctx) {',
    '      state.reads += 1;',
    '      globalThis.__profileProbe.events.push({ id: ctx.get("chamberInstanceId"), reads: state.reads, url: "meta" });',
    '    }',
    '    exports.apply = apply;',
    '    exports.inject = ["slots"];',
    '    return module.exports;',
    '  },',
    '  meta: () => ({ stylesheets: ["acme.css"] }),',
    '});',
  ].join('\n')
}

/** Build one adapter; overrides keep each test's intent local. */
function adapter(overrides: Partial<ProfilePluginAdapter> = {}): ProfilePluginAdapter {
  return {
    packageId: 'acme-search',
    metadata: { inject: ['slots'] },
    baseUri: { expectedCount: 1 },
    witnesses: ['const state = { reads: 0 };'],
    reason: 'synthetic adapter for the framework suite',
    ...overrides,
  }
}

function fakeContext(instanceId: string | undefined, basePath: string | undefined): FakeContext {
  return {
    get: (name: string): unknown => name === 'chamberInstanceId' ? instanceId : name === 'chamberBasePath' ? basePath : undefined,
  }
}

interface RunOutcome {
  plugin: ExecPlugin | null
  handoff: { id?: string; factory: (require: (spec: string) => unknown) => unknown; meta?: unknown } | null
  events: ProbeEvent[]
  error: Error | null
}

/**
 * Execute one served/patched classic bundle against the page seams and run the caller's
 * assertions/actions while those seams are installed (the plugin's closures read the
 * fake `window`/`document`/probe during apply and callbacks, so the environment must stay
 * up for the whole run). Errors thrown inside `run` are returned in `error` so the test
 * can surface them with its own message.
 */
function executeBundle(text: string, run?: (plugin: ExecPlugin, events: ProbeEvent[], handoff: NonNullable<RunOutcome['handoff']>) => void): RunOutcome {
  const globals = globalThis as unknown as { window?: unknown; document?: unknown; location?: unknown; __profileProbe?: ProbeGlobal }
  const previousWindow = globals.window
  const previousDocument = globals.document
  const previousLocation = globals.location
  const previousProbe = globals.__profileProbe
  let handoff: RunOutcome['handoff'] = null
  globals.window = {
    __ModuleLoader__: { load: (loaded: NonNullable<RunOutcome['handoff']>) => { handoff = loaded } },
    location: { origin: 'http://127.0.0.1:17510' },
  }
  globals.document = {
    baseURI: 'http://127.0.0.1:17510/',
    querySelector: () => ({}),
    createElement: () => ({ dataset: {}, style: {} }),
    head: { appendChild: () => {} },
  }
  globals.location = { origin: 'http://127.0.0.1:17510' }
  globals.__profileProbe = { events: [] }
  const events = globals.__profileProbe.events
  let plugin: ExecPlugin | null = null
  try {
    new Function(text)()
    plugin = handoff!.factory(() => ({})) as ExecPlugin
    if (run !== undefined) run(plugin, events, handoff!)
    return { plugin, handoff, events, error: null }
  } catch (error) {
    return { plugin, handoff, events, error: error instanceof Error ? error : new Error(String(error)) }
  } finally {
    globals.window = previousWindow
    globals.document = previousDocument
    globals.location = previousLocation
    globals.__profileProbe = previousProbe
  }
}

test('the framework module stays package/version agnostic; registry entries are valid unique data', () => {
  const source = readFileSync(new URL('../../src/profile-plugin-adapters.ts', import.meta.url), 'utf8')
  const suiteSource = readFileSync(new URL(import.meta.url), 'utf8')
  assert.equal(/packageId:\s*['"]/u.test(source), false, 'adapter package ids are registry data, never framework code')
  for (const official of CLIENT_PLUGIN_PATCHES) {
    assert.equal(source.includes(official.packageId), false, 'the framework must not name the official package ' + official.packageId)
    assert.equal(suiteSource.includes(official.packageId), false, 'the framework suite must not name the official package ' + official.packageId)
  }
  const semver = /\b\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/u
  assert.equal(semver.test(source), false, 'the framework must not pin a version literal')
  assert.ok(Array.isArray(PROFILE_PLUGIN_ADAPTERS), 'the registry is a data array')
  const seen = new Set()
  for (const entry of PROFILE_PLUGIN_ADAPTERS) {
    assert.deepEqual(validateProfileAdapter(entry), [], 'registered adapter ' + entry.packageId + ' must be valid')
    assert.match(entry.evidence?.sha256 ?? '', /^[0-9a-f]{64}$/u, 'registered adapter ' + entry.packageId + ' must pin its published artifact sha256')
    assert.ok((entry.evidence?.artifact ?? '').trim() !== '', 'registered adapter ' + entry.packageId + ' must record how to obtain the exact published artifact')
    assert.equal(seen.has(entry.packageId), false, 'duplicate registry package id ' + entry.packageId)
    seen.add(entry.packageId)
    for (const official of CLIENT_PLUGIN_PATCHES) {
      // Official matching uses exact combo resource tokens (not substrings), so containment
      // is not a conflict by itself; only a duplicated id can match both tables for one URL.
      assert.notEqual(entry.packageId, official.packageId, 'an official patch row must not be registered twice in the optional profile table')
    }
  }
})

test('validateProfileAdapter rejects malformed registry data', () => {
  assert.deepEqual(validateProfileAdapter(adapter()), [])
  assert.match(validateProfileAdapter(adapter({ packageId: '' })).join('\n'), /packageId/)
  assert.match(validateProfileAdapter(adapter({ reason: '' })).join('\n'), /reason/)
  assert.match(validateProfileAdapter(adapter({ witnesses: [] })).join('\n'), /witnesses/)
  assert.match(validateProfileAdapter(adapter({ witnesses: ['x', 'x'] })).join('\n'), /duplicate witness/)
  assert.match(validateProfileAdapter(adapter({ baseUri: { expectedCount: 0 } })).join('\n'), /expectedCount/)
  assert.match(validateProfileAdapter(adapter({ anchorRewrites: [{ anchor: 'a', replacement: 'b' }, { anchor: 'a', replacement: 'c' }] })).join('\n'), /duplicate anchorRewrite/)
  assert.match(validateProfileAdapter(adapter({ anchorRewrites: [{ anchor: PROFILE_DOCUMENT_BASE_URI, replacement: 'x' }] })).join('\n'), /must not contain/)
  assert.match(validateProfileAdapter(adapter({ metadata: { inject: [''] } })).join('\n'), /metadata.inject/)
})

test('scanDocumentBaseUri separates bare accesses from qualified/aliased ones', () => {
  assert.deepEqual(scanDocumentBaseUri('new URL("api/x", document.baseURI)'), { total: 1, bare: 1 })
  assert.deepEqual(scanDocumentBaseUri('window.document.baseURI'), { total: 1, bare: 0 })
  assert.deepEqual(scanDocumentBaseUri('document.baseURI + document.baseURI'), { total: 2, bare: 2 })
  assert.deepEqual(scanDocumentBaseUri('myDocument.baseURI'), { total: 0, bare: 0 })
  assert.deepEqual(scanDocumentBaseUri('mydocument.baseURI'), { total: 1, bare: 0 })
  assert.deepEqual(scanDocumentBaseUri('this.#document.baseURI'), { total: 1, bare: 0 })
  assert.deepEqual(scanDocumentBaseUri('document.baseURIx'), { total: 1, bare: 0 }, 'an identifier-suffix token is not a bare access')
  assert.deepEqual(scanDocumentBaseUri('$document.baseURI'), { total: 1, bare: 0 }, 'a $-identifier prefix is not a bare access')
})

test('applyProfileAdapter wraps a CJS-export factory per apply, keeps strict mode and rewrites bare base tokens', () => {
  const fixture = cjsFixture('acme-search', 'api/acme-settings')
  const patched = applyProfileAdapter(fixture, adapter())
  assert.notEqual(patched, null)
  assert.equal(patched!.split(PROFILE_WRAPPER_MARKER).length - 1, 1, 'exactly one per-apply wrapper')
  assert.match(patched!, /'use strict';\n\s*const createInstance = \(__dshChamberBasePath\)/u, 'the instance body keeps module-strict semantics')
  assert.equal(patched!.includes(PROFILE_DOCUMENT_BASE_URI), true, 'the injected per-instance fallback keeps the native document base')
  assert.equal(patched!.includes(PROFILE_BASE_URI_LOCAL), true)
  assert.doesNotThrow(() => { new Function(patched!) })
  assert.notEqual(applyProfileAdapter(servedText(fixture), adapter()), null, 'the served combo shape passes the same guards')
  assert.equal(applyProfileAdapter(patched!, adapter()), null, 'a patched text is never patched twice')
})

test('applyProfileAdapter refuses mixed/computed/private baseURI forms inside the factory body', () => {
  const mixed = cjsFixture('acme-search', 'api/acme-settings').replace(
    'const state = { reads: 0 };',
    'const state = { reads: 0, alias: window.document.baseURI };',
  )
  assert.equal(applyProfileAdapter(mixed, adapter({ baseUri: { expectedCount: 1 } })), null)
  const computed = cjsFixture('acme-search', 'api/acme-settings').replace(
    'const state = { reads: 0 };',
    'const state = { reads: 0, computed: document["baseURI"] };',
  )
  assert.equal(applyProfileAdapter(computed, adapter({ baseUri: { expectedCount: 1 } })), null)
  // One covered bare token plus one uncovered `baseURI` word, witness/anchor/expected-count
  // all still matching: only the "every baseURI word is covered" guard can refuse. Without it
  // the computed read would survive the rewrite and keep hitting the control-plane root.
  const uncoveredWord = cjsFixture('acme-search', 'api/acme-settings').replace(
    '    const inject = ["slots"];',
    '    const inject = ["slots"];\n    const computed = document["baseURI"];',
  )
  assert.equal(applyProfileAdapter(uncoveredWord, adapter({ baseUri: { expectedCount: 1 } })), null)
  // A qualified extra token must make the rewrite refuse: the served text is only allowed to
  // carry the bare accesses the transform covers; any leftover qualified read stays on the
  // control-plane root (or gets corrupted into a different property access).
  const qualifiedExtra = cjsFixture('acme-search', 'api/acme-settings').replace(
    '    const inject = ["slots"];',
    '    const inject = ["slots"];\n    const qualified = window.document.baseURI;',
  )
  assert.equal(applyProfileAdapter(qualifiedExtra, adapter({ baseUri: { expectedCount: 1 } })), null)
  const privateField = cjsFixture('acme-search', 'api/acme-settings').replace(
    'const state = { reads: 0 };',
    'const state = { reads: 0, note: "see #document.baseURI" };',
  )
  assert.equal(applyProfileAdapter(privateField, adapter({ baseUri: { expectedCount: 1 } })), null)
})

test('applyProfileAdapter refuses qualified/aliased base tokens instead of silently rewriting them', () => {
  const qualified = cjsFixture('acme-search', 'api/acme-settings').replace('document.baseURI', 'window.document.baseURI')
  assert.equal(applyProfileAdapter(qualified, adapter()), null)
  const mixed = cjsFixture('acme-search', 'api/acme-settings').replace('const state = { reads: 0 };', 'const state = { reads: 0, base: window.document.baseURI };')
  assert.equal(applyProfileAdapter(mixed, adapter({ baseUri: { expectedCount: 1 } })), null)
})

test('applyProfileAdapter refuses when a witness/anchor/base-token guard does not match exactly once', () => {
  const fixture = cjsFixture('acme-search', 'api/acme-settings')
  const entry = adapter()
  assert.equal(applyProfileAdapter(fixture.replace('const state = { reads: 0 };', ''), entry), null, 'missing witness')
  assert.equal(applyProfileAdapter(fixture + '\n;' + fixture, entry), null, 'duplicated factory anchors')
  assert.equal(applyProfileAdapter(fixture.replace(PROFILE_DOCUMENT_BASE_URI, 'document.URL'), entry), null, 'wrong base token count')
  assert.equal(applyProfileAdapter(fixture + '\n// factory: (require) => {', entry), null, 'factory open duplicated')
  assert.equal(applyProfileAdapter(fixture, adapter({ anchorRewrites: [{ anchor: PROFILE_FACTORY_CLOSE, replacement: '});' }] })), null, 'a rewrite that destroys the factory close is refused')
})

test('applyProfileAdapter accepts both object-return field orders (apply-first included)', () => {
  for (const returned of ['return { apply, inject: ["slots"] };', 'return { inject: ["slots"], apply };']) {
    const fixture = [
      'window.__ModuleLoader__.load({',
      '  id: "acme-apply-first",',
      '  factory: (require) => {',
      '    const state = { reads: 0 };',
      '    function apply(ctx) { state.reads += 1; globalThis.__profileProbe.events.push({ id: ctx.get("chamberInstanceId"), reads: state.reads, url: "object" }); }',
      '    ' + returned,
      '  },',
      '});',
    ].join('\n')
    const patched = applyProfileAdapter(fixture, adapter({ packageId: 'acme-apply-first', baseUri: undefined }))
    assert.notEqual(patched, null, returned)
    const outcome = executeBundle(patched!, (plugin) => { plugin.apply(fakeContext('local', '/api/i/local')) })
    assert.equal(outcome.error, null, outcome.error?.message ?? '')
    assert.deepEqual(outcome.events.map(event => event.reads), [1])
  }
})

test('applyProfileAdapter tolerates a witness that the injected strict directive also contains', () => {
  const fixture = cjsFixture('acme-search', 'api/acme-settings').replace('const state = { reads: 0 };', "'use strict';\n    const state = { reads: 0 };")
  const entry = adapter({ witnesses: ["'use strict';", 'const state = { reads: 0 };'] })
  assert.notEqual(applyProfileAdapter(fixture, entry), null, 'the injected directive may add one occurrence of a directive witness')
})

test('applyProfileAdapter supports a custom factory open anchor (non-default builder shape)', () => {
  const fixture = cjsFixture('acme-search', 'api/acme-settings').replace('factory: (require) => {', 'factory: function (require) {')
  const entry = adapter({ factoryAnchors: { open: 'factory: function (require) {', close: PROFILE_FACTORY_CLOSE } })
  const patched = applyProfileAdapter(fixture, entry)
  assert.notEqual(patched, null)
  const outcome = executeBundle(patched!, (plugin) => { plugin.apply(fakeContext('local', '/api/i/local')) })
  assert.equal(outcome.error, null, outcome.error?.message ?? '')
})

test('applyProfileAdapter wraps an object-return factory and preserves declared metadata', () => {
  const fixture = objectFixture('@acme/panel')
  const entry = adapter({ packageId: '@acme/panel', metadata: { inject: ['commandUi'], name: 'acme-panel' }, baseUri: undefined })
  const patched = applyProfileAdapter(fixture, entry)
  assert.notEqual(patched, null)
  const outcome = executeBundle(patched!, (plugin) => {
    assert.deepEqual(plugin.inject, ['commandUi'])
    assert.equal(plugin.name, 'acme-panel')
  })
  assert.equal(outcome.error, null, outcome.error?.message ?? '')
})

test('applyProfileAdapter refuses a function-form plugin loudly instead of a silent Function.prototype.apply', () => {
  const fixture = [
    'window.__ModuleLoader__.load({',
    '  id: "acme-function",',
    '  factory: (require) => {',
    '    const state = { reads: 0 };',
    '    function apply(ctx) { state.reads += 1; return ctx.get("chamberInstanceId") }',
    '    return function plugin(ctx) { return apply(ctx) };',
    '  },',
    '});',
  ].join('\n')
  const patched = applyProfileAdapter(fixture, adapter({ packageId: 'acme-function', baseUri: undefined, metadata: undefined }))
  assert.notEqual(patched, null)
  const outcome = executeBundle(patched!, (plugin) => {
    assert.throws(() => plugin.apply(fakeContext('local', '/api/i/local')), /function\/class Cordis plugin forms are not supported/u)
  })
  assert.equal(outcome.error, null, outcome.error?.message ?? '')
})

test('applyProfileAdapter preserves load-object fields AFTER the factory (meta) with a custom close anchor', () => {
  const fixture = metaTailFixture('acme-meta')
  const entry = adapter({
    packageId: 'acme-meta',
    baseUri: undefined,
    witnesses: ['const state = { reads: 0 };'],
    factoryAnchors: { open: PROFILE_FACTORY_OPEN, close: '\n  },' },
  })
  const patched = applyProfileAdapter(fixture, entry)
  assert.notEqual(patched, null)
  assert.equal(patched!.includes('meta: () => ({ stylesheets: ["acme.css"] }),'), true, 'the registration tail is preserved')
  const outcome = executeBundle(patched!, (plugin) => {
    plugin.apply(fakeContext('local', '/api/i/local'))
  })
  assert.equal(outcome.error, null, outcome.error?.message ?? '')
  assert.equal(typeof outcome.handoff!.meta, 'function', 'the load-object meta field survives the rewrite')
  assert.deepEqual((outcome.handoff!.meta as () => unknown)(), { stylesheets: ['acme.css'] })
})

test('applyProfileAdapter supports explicit anchor rewrites for non-baseURI host routes', () => {
  const fixture = customRouteFixture('acme-custom')
  const entry = adapter({
    packageId: 'acme-custom',
    witnesses: ['const state = { reads: 0 };'],
    anchorRewrites: [{
      anchor: 'const API = "/api/acme-custom";',
      replacement: 'const API = __dshChamberBasePath === undefined ? "/api/acme-custom" : __dshChamberBasePath + "/api/acme-custom";',
    }],
  })
  const patched = applyProfileAdapter(fixture, entry)
  assert.notEqual(patched, null)
  const outcome = executeBundle(patched!, (plugin, events) => {
    plugin.apply(fakeContext('local', '/api/i/local'))
    plugin.apply(fakeContext('ssh-b', '/api/i/ssh-b'))
    assert.deepEqual(events.map(event => event.url), [
      'http://127.0.0.1:17510/api/i/local/api/acme-custom/describe',
      'http://127.0.0.1:17510/api/i/ssh-b/api/acme-custom/describe',
    ])
  })
  assert.equal(outcome.error, null, outcome.error?.message ?? '')
})

test('factory-body scoping: bare tokens outside the factory are left untouched and never reference the instance scope', () => {
  const fixture = 'const ROOT = document.baseURI;\n' + cjsFixture('acme-search', 'api/acme-settings')
  const patched = applyProfileAdapter(fixture, adapter())
  assert.notEqual(patched, null)
  assert.equal(patched!.includes('const ROOT = document.baseURI;'), true, 'the outside token is preserved as-is')
  const outcome = executeBundle(patched!, (plugin, events) => {
    plugin.apply(fakeContext('local', '/api/i/local'))
    plugin.apply(fakeContext('ssh-b', '/api/i/ssh-b'))
    assert.deepEqual(events.map(event => event.url), [
      'http://127.0.0.1:17510/api/i/local/api/acme-settings/describe',
      'http://127.0.0.1:17510/api/i/ssh-b/api/acme-settings/describe',
    ])
  })
  assert.equal(outcome.error, null, outcome.error?.message ?? '')
})

test('factory-body scoping: tokens in load-object fields after the factory stay untouched', () => {
  const fixture = metaTailFixture('acme-meta').replace('stylesheets: ["acme.css"]', 'stylesheets: [document.baseURI]')
  const entry = adapter({ packageId: 'acme-meta', baseUri: undefined, witnesses: ['const state = { reads: 0 };'], factoryAnchors: { open: PROFILE_FACTORY_OPEN, close: '\n  },' } })
  const patched = applyProfileAdapter(fixture, entry)
  assert.notEqual(patched, null)
  const outcome = executeBundle(patched!, (plugin, _events, handoff) => {
    plugin.apply(fakeContext('local', '/api/i/local'))
    assert.deepEqual((handoff.meta as () => unknown)(), { stylesheets: ['http://127.0.0.1:17510/'] })
  })
  assert.equal(outcome.error, null, outcome.error?.message ?? '')
})

test('factory-body scoping: an anchor rewrite outside the factory is refused', () => {
  const fixture = 'const OUTSIDE = "replace-me";\n' + cjsFixture('acme-search', 'api/acme-settings')
  const entry = adapter({ anchorRewrites: [{ anchor: 'const OUTSIDE = "replace-me";', replacement: 'const OUTSIDE = __dshChamberBasePath;' }] })
  assert.equal(applyProfileAdapter(fixture, entry), null)
})

test('applyProfileAdapter rewrites multiple bare tokens inside the factory body (expectedCount > 1)', () => {
  const fixture = cjsFixture('acme-search', 'api/acme-settings').replace('    exports.apply = apply;', '    exports.apply = apply;\n    const ROOT2 = document.baseURI;')
  const entry = adapter({ baseUri: { expectedCount: 2 } })
  const patched = applyProfileAdapter(fixture, entry)
  assert.notEqual(patched, null)
  const outcome = executeBundle(patched!, (plugin, events) => {
    plugin.apply(fakeContext('local', '/api/i/local'))
    assert.deepEqual(events.map(event => event.url), ['http://127.0.0.1:17510/api/i/local/api/acme-settings/describe'])
  })
  assert.equal(outcome.error, null, outcome.error?.message ?? '')
})

test('the outer apply is an arrow (non-constructable) so cordis never calls it with new', () => {
  const patched = applyProfileAdapter(cjsFixture('acme-search', 'api/acme-settings'), adapter())
  const outcome = executeBundle(patched!)
  assert.equal(outcome.plugin!.apply.prototype, undefined)
})

test('the wrapper enforces that chamberBasePath belongs to the instance', () => {
  const patched = applyProfileAdapter(cjsFixture('acme-search', 'api/acme-settings'), adapter())
  const outcome = executeBundle(patched!, (plugin) => {
    assert.throws(() => plugin.apply(fakeContext('local', '/api/i/other')), /does not belong to its instance/u)
  })
  assert.equal(outcome.error, null, outcome.error?.message ?? '')
})

test('applyProfileAdapter refuses an artifact that already uses the injected identifier', () => {
  const fixture = cjsFixture('acme-search', 'api/acme-settings').replace('const state = { reads: 0 };', 'const state = { reads: 0, x: __dshChamberBasePath };')
  assert.equal(applyProfileAdapter(fixture, adapter()), null)
})

test('applyProfileAdapter refuses malformed adapter data before touching the text', () => {
  // The registry is validated data, but a malformed entry must fail closed here too: returning
  // a patched text from an adapter the validator rejects would silently apply broken guards.
  const malformed = { packageId: 'acme-search', baseUri: { expectedCount: 1 }, witnesses: [], reason: 'missing witnesses' }
  assert.equal(applyProfileAdapter(cjsFixture('acme-search', 'api/acme-settings'), malformed), null)
})

test('applyProfileAdapter refuses an artifact that already declares the injected base-path parameter', () => {
  // Preserve the witness so the refusal is attributable to the parameter collision, not to a
  // missing witness (the wrapper would otherwise redeclare __dshChamberBasePath).
  const fixture = cjsFixture('acme-search', 'api/acme-settings').replace(
    '    const inject = ["slots"];',
    '    const inject = ["slots"];\n    const existing = __dshChamberBasePath;',
  )
  assert.equal(applyProfileAdapter(fixture, adapter()), null)
})

test('applyProfileAdapter refuses an anchor rewrite whose replacement reintroduces the anchor', () => {
  const entry = adapter({
    anchorRewrites: [{
      anchor: 'const bridgeUrl = (endpoint)',
      replacement: 'const bridgeUrl = (endpoint) // const bridgeUrl = (endpoint)',
    }],
  })
  assert.equal(applyProfileAdapter(cjsFixture('acme-search', 'api/acme-settings'), entry), null)
})

test('validateProfileAdapter requires a combo-addressable npm package id', () => {
  for (const bad of ['has space', 'a/b/client.js', '/leading', 'trailing/', 'UPPER']) {
    assert.match(validateProfileAdapter(adapter({ packageId: bad })).join('\n'), /valid npm package name/u, bad)
  }
})

test('classification survives a malformed registry entry without throwing', () => {
  const malformed = { packageId: 'acme-malformed', reason: 'missing witnesses' } as unknown as ProfilePluginAdapter
  assert.doesNotThrow(() => classifyProfilePluginBundle('http://cp/api/i/local/plugins/??acme-malformed/client.js&rev=1', [malformed]))
  assert.doesNotThrow(() => classifyProfilePluginBundle('http://cp/api/i/local/plugins/??acme-malformed/client.other.js&rev=1', [malformed]))
})

test('classification: an empty registry is a no-op for every URL', () => {
  assert.deepEqual(classifyProfilePluginBundle('http://cp/api/i/local/plugins/??acme-search/client.js&rev=1', []), { kind: 'none' })
  assert.deepEqual(classifyProfilePluginBundle('http://cp/x', []), { kind: 'none' })
})

test('classification: a malformed resource under the registered namespace keeps the script path with a diagnostic', () => {
  const entry = adapter()
  const malformed = classifyProfilePluginBundle('http://cp/api/i/local/plugins/??acme-search/client.other.js&rev=1', [entry])
  assert.equal(malformed.kind, 'unpatched')
  assert.equal(classifyProfilePluginBundle('http://cp/api/i/local/plugins/??acme-search-fork/client.js&rev=1', [entry]).kind, 'none')
})

test('applyProfileAdapter refuses a factory body that reads document.baseURI without a declared baseUri transform', () => {
  const fixture = cjsFixture('acme-search', 'api/acme-settings')
  const entry = adapter({ baseUri: undefined })
  assert.equal(applyProfileAdapter(fixture, entry), null)
  // A computed access has no bare `document.baseURI` token (total = 0), so only the word count
  // refuses; without it the read would survive unpatched on the control-plane root.
  assert.equal(applyProfileAdapter(fixture.replace('document.baseURI', 'document["baseURI"]'), entry), null)
})

test('injected base scaffolding is globalThis-qualified so body declarations cannot shadow it', () => {
  const fixture = cjsFixture('acme-search', 'api/acme-settings').replace(
    '    var module = { exports: {} };',
    '    var module = { exports: {} };\n    const URL = globalThis.URL;\n    const document = globalThis.document;\n    const window = globalThis;',
  )
  const patched = applyProfileAdapter(fixture, adapter())
  assert.notEqual(patched, null)
  const outcome = executeBundle(patched!, (plugin, events) => {
    plugin.apply(fakeContext('local', '/api/i/local'))
    assert.deepEqual(events.map(event => event.url), ['http://127.0.0.1:17510/api/i/local/api/acme-settings/describe'])
  })
  assert.equal(outcome.error, null, outcome.error?.message ?? '')
})

test('applyProfileAdapter supports a minified factory shape with closeOccurrence last', () => {
  const fixture = 'window.__ModuleLoader__.load({id:"acme-min",factory:require=>{var module={exports:{}};var exports=module.exports;const state={reads:0};const holder="}});";const bridgeUrl=(e)=>new URL("api/acme-min/"+e,document.baseURI).toString();function apply(ctx){state.reads+=1;globalThis.__profileProbe.events.push({id:ctx.get("chamberInstanceId"),reads:state.reads,url:bridgeUrl("describe")})}const inject=["slots"];exports.apply=apply;exports.inject=inject;return module.exports}});'
  const entry = adapter({
    packageId: 'acme-min',
    witnesses: ['const state={reads:0};'],
    factoryAnchors: { open: 'factory:require=>{', close: '}});', closeOccurrence: 'last' },
  })
  const patched = applyProfileAdapter(fixture, entry)
  assert.notEqual(patched, null)
  const outcome = executeBundle(patched!, (plugin, events) => {
    plugin.apply(fakeContext('local', '/api/i/local'))
    plugin.apply(fakeContext('ssh-b', '/api/i/ssh-b'))
    assert.deepEqual(events.map(event => event.url), [
      'http://127.0.0.1:17510/api/i/local/api/acme-min/describe',
      'http://127.0.0.1:17510/api/i/ssh-b/api/acme-min/describe',
    ])
  })
  assert.equal(outcome.error, null, outcome.error?.message ?? '')
})

test('validateProfileAdapter refuses overlapping/no-op anchor rewrites', () => {
  assert.match(validateProfileAdapter(adapter({ anchorRewrites: [
    { anchor: 'const API = "/api/x";', replacement: 'const API = "/api/y";' },
    { anchor: 'API = "/api/x";', replacement: 'API = "/api/z";' },
  ] })).join('\n'), /substrings of each other/u)
  assert.match(validateProfileAdapter(adapter({ anchorRewrites: [
    { anchor: 'const API = "/api/x";', replacement: 'const API = "/api/x";' },
  ] })).join('\n'), /must differ from its anchor/u)
})

test('classification: single-id combo patches; a registered package in a non-single combo keeps the script path', () => {
  const entry = adapter()
  assert.equal(findProfilePluginAdapter('http://cp/api/i/local/plugins/??acme-search/client.js&rev=1', [entry]), entry)
  assert.equal(findProfilePluginAdapter('http://cp/api/i/local/plugins/??@acme/panel/client.js?rev=1', [adapter({ packageId: '@acme/panel' })])?.packageId, '@acme/panel')
  assert.deepEqual(classifyProfilePluginBundle('http://cp/x', [entry]), { kind: 'none' })
  assert.equal(classifyProfilePluginBundle('http://cp/api/i/local/plugins/??acme-search/client.js&rev=1', [entry]).kind, 'patch')
  assert.equal(classifyProfilePluginBundle('http://cp/api/i/local/plugins/??acme-search/client.js,other/client.js&rev=1', [entry]).kind, 'unpatched')
  assert.equal(classifyProfilePluginBundle('http://cp/api/i/local/plugins/??acme-search-extra/client.js,other/client.js&rev=1', [entry]).kind, 'none', 'combo ids match exactly, not by substring')
  assert.equal(findProfilePluginAdapter('http://cp/api/i/local/plugins/acme-search/client.chunk1.js', [entry]), null)
})

test('profilePluginPatch exposes the optional-row loader contract', () => {
  const patch = profilePluginPatch(adapter())
  assert.equal(patch.packageId, 'acme-search')
  assert.equal(patch.anchorMiss, 'degrade-unpatched-optional')
  assert.equal(patch.anchors, 2)
  assert.equal(patch.apply('no anchors here'), null)
})

test('behavior: patched factory gives every context its own state and its own base prefix', () => {
  const patched = applyProfileAdapter(cjsFixture('acme-search', 'api/acme-settings'), adapter())
  const outcome = executeBundle(patched!, (plugin, events) => {
    const a = fakeContext('local', '/api/i/local')
    const b = fakeContext('ssh-b', '/api/i/ssh-b')
    const native = fakeContext(undefined, undefined)
    assert.equal(plugin.apply(a, 'x'), '1')
    assert.equal(plugin.apply(b, 'x', 'y'), '2')
    plugin.apply(native)
    assert.deepEqual(events.map(event => event.reads), [1, 1, 1], 'factory-scope state is per apply, not shared')
    assert.deepEqual(events.map(event => event.url), [
      'http://127.0.0.1:17510/api/i/local/api/acme-settings/describe',
      'http://127.0.0.1:17510/api/i/ssh-b/api/acme-settings/describe',
      'http://127.0.0.1:17510/api/acme-settings/describe',
    ])
  })
  assert.equal(outcome.error, null, outcome.error?.message ?? '')
})

test('behavior: the untouched bundle shows the shared-state/root-origin defect the adapter fixes', () => {
  const outcome = executeBundle(cjsFixture('acme-search', 'api/acme-settings'), (plugin, events) => {
    plugin.apply(fakeContext('local', '/api/i/local'))
    plugin.apply(fakeContext('ssh-b', '/api/i/ssh-b'))
    assert.deepEqual(events.map(event => event.reads), [1, 2], 'the raw factory shares one state object')
    assert.deepEqual([...new Set(events.map(event => event.url))], ['http://127.0.0.1:17510/api/acme-settings/describe'], 'both instances hit the control-plane root')
  })
  assert.equal(outcome.error, null, outcome.error?.message ?? '')
})

test('behavior: chamberInstanceId without chamberBasePath fails loudly; an invalid base path is rejected', () => {
  const patched = applyProfileAdapter(cjsFixture('acme-search', 'api/acme-settings'), adapter())
  const outcome = executeBundle(patched!, (plugin) => {
    assert.throws(() => plugin.apply(fakeContext('ssh-old', undefined)), /cannot resolve its per-entry base path/u)
    assert.throws(() => plugin.apply(fakeContext('local', 'api/i/local')), /invalid chamberBasePath/u)
  })
  assert.equal(outcome.error, null, outcome.error?.message ?? '')
})

test('shell dispatch keeps the official table first and wires the optional fallback/compile seams', () => {
  const shell = readFileSync(new URL('../../src/shell.ts', import.meta.url), 'utf8')
  // Source lock (the shell is not importable here): every branch of the page dispatch must
  // exist AND keep this order. Deleting the optional-profile patch branch, or moving the
  // profile block above the official refuse branch, would otherwise keep the suite green —
  // the latter would let a mixed batch URL that also names a registered profile package
  // fall through to the untouched script path, bypassing the official fail-closed refusal.
  const officialClassifyAt = shell.indexOf('const match = classifyClientPluginBundle(url)')
  const refuseAt = shell.indexOf("if (match.kind === 'refuse') return Promise.reject(new Error(match.message))")
  const officialPatchAt = shell.indexOf("if (match.kind === 'patch') return loadPatchedModuleBundle(url, match.patch)")
  const profileClassifyAt = shell.indexOf('classifyProfilePluginBundle(url, PROFILE_PLUGIN_ADAPTERS)')
  const profilePatchAt = shell.indexOf("if (profile.kind === 'patch') return loadPatchedModuleBundle(url, profile.patch)")
  const profileUnpatchedAt = shell.indexOf("if (profile.kind === 'unpatched')")
  const scriptFallbackAt = shell.lastIndexOf('return loadScriptElementBundle(url)')
  for (const [label, at] of [
    ['official classification', officialClassifyAt],
    ['official refuse branch', refuseAt],
    ['official patch branch', officialPatchAt],
    ['profile classification', profileClassifyAt],
    ['profile patch branch', profilePatchAt],
    ['profile unpatched branch', profileUnpatchedAt],
    ['script fallback', scriptFallbackAt],
  ] as const) {
    assert.ok(at >= 0, 'shell dispatch missing: ' + label)
  }
  assert.ok(officialClassifyAt < refuseAt && refuseAt < officialPatchAt,
    'the official table must be classified and refused before any patch dispatch')
  assert.ok(officialPatchAt < profileClassifyAt,
    'the official patch dispatch must win before the profile table is consulted')
  assert.ok(profileClassifyAt < profilePatchAt && profilePatchAt < profileUnpatchedAt,
    'the profile patch branch must run before the unpatched fallback branch')
  assert.ok(profileUnpatchedAt < scriptFallbackAt,
    'unmatched URLs keep the script-element path as the final fallback')
  // The final fallback is a separate statement (the unpatched branch above returns the same
  // text): pin the whole tail so deleting the last `return loadScriptElementBundle(url)` —
  // which `lastIndexOf` would silently re-anchor to the branch above — still fails here.
  const dispatchTail = [
    "  if (profile.kind === 'unpatched') {",
    "    console.error('[chamber] ' + profile.message)",
    '    return loadScriptElementBundle(url)',
    '  }',
    '  return loadScriptElementBundle(url)',
    '}',
  ].join('\n')
  assert.equal(shell.includes(dispatchTail), true, 'unmatched URLs keep the script-element path as the final fallback')
  for (const needle of [
    "profile.kind === 'unpatched'",
    'onFallback: info =>',
    'compile: (text) => { new Function(text) }',
    '[chamber] optional profile adapter for',
  ]) {
    assert.equal(shell.includes(needle), true, 'shell wiring missing: ' + needle)
  }
})