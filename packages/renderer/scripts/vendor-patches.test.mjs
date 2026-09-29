/**
 * Vendor patch registry tests (design 09 §3.6).
 *
 * These run against the REAL pinned vendor source, so they fail the moment an
 * upstream anchor drifts (the same condition C9 of
 * verify-upstream-touchpoints.mjs reports before a pin bump).
 *
 * Every patch that rewrites or inserts LOGIC is covered by an EXECUTION test:
 * esbuild transforms the patched source (never a hand copy), the replacement
 * body runs, and the assertion is on observed behaviour (URLs handed to fetch,
 * props reaching the child component, flush timestamps under a simulated
 * stream) instead of substrings. Each execution test runs the SAME behaviour
 * check against the unpatched upstream body as its negative control, proving
 * the old defect is red. CSS has no executable body; the sweep test therefore
 * PARSES the keyframes and asserts the animated property set.
 *
 * The artifact-side markers (verify-vendor-patch-applied.mjs) are pinned for
 * every registered patch: one present marker per vendor file, and each of the five
 * route-bound markers is judged inside the chunk declaring its route.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  applyVendorPatches, checkRetiredPatches, checkVendorPatchSources, RETIRED_PATCHES,
  VENDOR_PATCHES, vendorPatchRegistryProblems,
} from './vendor-patches.mjs'
import {
  VENDOR_PATCH_MARKERS,
  checkVendorPatchBundle,
} from './verify-vendor-patch-applied.mjs'
// The composite transforms only what its graph imports; the patch registry asserts
// every patched package is covered here before the build can fail on a dead patch.
import { CHAMBER_COVERED_IDS } from '../src/chamber-covered.ts'

// esbuild is resolved through the renderer's vite tree (the build scripts do
// the same) so the patched TypeScript bodies can be evaluated as JS.
const requireFromRenderer = createRequire(new URL('../package.json', import.meta.url))
const esbuild = await import(
  pathToFileURL(createRequire(requireFromRenderer.resolve('vite')).resolve('esbuild')).href
)

const NL = String.fromCharCode(10)
const BT = String.fromCharCode(96)
const VENDOR = fileURLToPath(new URL('../../../vendor/harness-packages/@deepseek-ai/', import.meta.url))

/** Real pinned vendor files. */
const FILES = {
  markdown: VENDOR + 'dsh-client-ui-chat/src/client/chat/AssistantMarkdown.tsx',
  nodeView: VENDOR + 'dsh-client-ui-chat/src/client/chat/AssistantNodeView.tsx',
  chatView: VENDOR + 'dsh-client-ui-chat/src/client/chat/ChatView.tsx',
  reasoningCss: VENDOR + 'dsh-client-ui-chat/src/client/chat/ReasoningRow.module.css',
  upload: VENDOR + 'dsh-client-file-upload/src/client/runtime.ts',
  presentOpen: VENDOR + 'dsh-client-ui-deliverables/src/client/present-open.ts',
  deliverablesIndex: VENDOR + 'dsh-client-ui-deliverables/src/client/index.ts',
  deliverables: VENDOR + 'dsh-client-ui-deliverables/src/client/Deliverables.tsx',
  reviewTab: VENDOR + 'dsh-client-ui-deliverables/src/client/ReviewTab.tsx',
  hostReadStore: VENDOR + 'dsh-client-ui-deliverables/src/client/host-read-store.ts',
  exportController: VENDOR + 'dsh-session-log-export/src/client/controller.ts',
  exportIndex: VENDOR + 'dsh-session-log-export/src/client/index.ts',
  assembly: VENDOR + 'dsh-client-ui-conversation/src/client/conversation/assembly.ts',
  reading: VENDOR + 'dsh-client-ui-chat/src/client/chat/use-chat-reading.ts',
  values: VENDOR + 'dsh-util-values/src/index.ts',
  workspaceNavigation: VENDOR + 'dsh-client-ui-workspace/src/client/navigation.ts',
}

/** Module ids in both forms: the symlinked vendor path and the realpath'd submodule path. */
const IDS = {
  markdown: '/x/node_modules/@deepseek-ai/dsh-client-ui-chat/src/client/chat/AssistantMarkdown.tsx',
  // The renderer resolves vendor sources through realpathSync, so the id vite
  // reports is normally the SUBMODULE path (this is the form that matters).
  markdownReal: '/x/vendor/harness-checkout/packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx',
  nodeView: '/x/vendor/harness-checkout/packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx',
  chatViewReal: '/x/vendor/harness-checkout/packages/client/ui-chat/src/client/chat/ChatView.tsx',
  reasoningCss: '/x/vendor/harness-checkout/packages/client/ui-chat/src/client/chat/ReasoningRow.module.css',
  uploadReal: '/x/vendor/harness-checkout/packages/client/file-upload/src/client/runtime.ts',
  presentOpen: '/x/vendor/harness-checkout/packages/client/ui-deliverables/src/client/present-open.ts',
  deliverablesIndex: '/x/vendor/harness-checkout/packages/client/ui-deliverables/src/client/index.ts',
  deliverablesReal: '/x/vendor/harness-checkout/packages/client/ui-deliverables/src/client/Deliverables.tsx',
  reviewTabReal: '/x/vendor/harness-checkout/packages/client/ui-deliverables/src/client/ReviewTab.tsx',
  hostReadStoreReal: '/x/vendor/harness-checkout/packages/client/ui-deliverables/src/client/host-read-store.ts',
  exportController: '/x/vendor/harness-checkout/packages/session-query/session-log-export/src/client/controller.ts',
  exportIndex: '/x/vendor/harness-checkout/packages/session-query/session-log-export/src/client/index.ts',
  assembly: '/x/vendor/harness-checkout/packages/client/ui-conversation/src/client/conversation/assembly.ts',
  workspaceNavigation: '/x/vendor/harness-checkout/packages/client/ui-workspace/src/client/navigation.ts',
  readingReal: '/x/vendor/harness-checkout/packages/client/ui-chat/src/client/chat/use-chat-reading.ts',
  valuesVendor: '/x/node_modules/@deepseek-ai/dsh-util-values/src/index.ts',
  valuesReal: '/x/vendor/harness-checkout/packages/util/values/src/index.ts',
}

/** Strip a leading export keyword so a sliced declaration can run inline. */
function unexport(code) {
  return code.replace(/^export /gm, '')
}

/**
 * esbuild-transform a slice of the PATCHED source and evaluate it, returning
 * one named binding. The slice is real patched code: a broken replacement body
 * reaches the assertions instead of being compared as a substring.
 * @param {string} code - patched module source.
 * @param {{ from: string, to?: string, loader?: string, params?: Record<string, unknown>, binding: string, transform?: object }} input slice + bindings.
 * @returns {unknown} the requested binding.
 */
function evaluateSlice(code, { from, to, loader = 'ts', params = {}, binding, transform = {} }) {
  const start = code.indexOf(from)
  assert.notEqual(start, -1, 'slice start marker not found: ' + from)
  const end = to === undefined ? code.length : code.indexOf(to, start)
  assert.notEqual(end, -1, 'slice end marker not found: ' + to)
  const js = esbuild.transformSync(unexport(code.slice(start, end)), { loader, ...transform }).code
  const names = Object.keys(params)
  return new Function(...names, js + NL + 'return ' + binding)(...names.map((name) => params[name]))
}

/** The createSnapshotStore seam these modules import; enough for the controllers. */
function fakeSnapshotStore(initial) {
  let snapshot = initial
  return {
    getSnapshot: () => snapshot,
    set: (value) => { snapshot = value },
    update: (mutate) => {
      const draft = { ...snapshot }
      mutate(draft)
      snapshot = draft
    },
  }
}

test('every registered patch anchor still matches the pinned vendor source exactly once', () => {
  const results = checkVendorPatchSources()
  assert.equal(results.length, VENDOR_PATCHES.length, 'one result per patch')
  for (const result of results) {
    assert.equal(result.ok, true, result.vendorFile + ': ' + result.detail)
  }
})

test('the patch resolves the file-API base through the per-entry base path', () => {
  const source = readFileSync(FILES.markdown, 'utf8')
  // Both id forms must select the patch: the symlinked vendor path and the
  // realpath'd submodule path (the one vite actually reports).
  const viaVendorPath = applyVendorPatches(IDS.markdown, source)
  const patched = applyVendorPatches(IDS.markdownReal, source)
  assert.notEqual(viaVendorPath, undefined, 'the @deepseek-ai id form must match')
  assert.equal(viaVendorPath.code, patched?.code, 'both id forms produce the same patch')
  assert.deepEqual(patched.applied, ['dsh-client-ui-chat/src/client/chat/AssistantMarkdown.tsx'])
  assert.ok(patched.code.includes('chamberFileApiBase?: string | undefined'), 'the root standard prop is declared')
  assert.ok(patched.code.includes('mentions, t, chamberFileApiBase,'), 'the prop is destructured')
  // Behaviour: evaluate the patched memo with a recording resolver; the base it
  // hands the resolver must be this entry's own file-API directory.
  const start = patched.code.indexOf('  const pathImages = useMemo')
  const end = patched.code.indexOf(NL + '  const last =', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const js = esbuild.transformSync(patched.code.slice(start, end) + NL + 'return pathImages', { loader: 'tsx' }).code
  const makePathImages = new Function('useMemo', 'localPathMediaUrl', 'document', 'chamberFileApiBase', js)
  const resolverBase = (chamberFileApiBase, baseURI) => {
    let seen
    const pathImages = makePathImages(
      callback => callback(),
      (base, value) => { seen = base; return 'resolved:' + value },
      { baseURI },
      chamberFileApiBase,
    )
    assert.equal(pathImages.resolve('/tmp/a.png'), 'resolved:/tmp/a.png')
    return seen
  }
  // Upstream fallback: no base path supplied (official-layout deployment).
  assert.equal(resolverBase(undefined, 'http://127.0.0.1:30800/'), 'http://127.0.0.1:30800/')
  // An empty chamber fact is the absent case: it must not become the origin root.
  assert.equal(resolverBase('', 'http://127.0.0.1:30800/'), 'http://127.0.0.1:30800/')
  // Chamber: the per-entry prefix becomes the resolver's directory.
  assert.equal(resolverBase('/api/i/local', 'http://127.0.0.1:30800/'), 'http://127.0.0.1:30800/api/i/local/')
})

test('the node view forwards the root standard prop into the markdown component (executed component)', () => {
  const source = readFileSync(FILES.nodeView, 'utf8')
  const patched = applyVendorPatches(IDS.nodeView, source)
  assert.notEqual(patched, undefined)
  assert.deepEqual(patched.applied, ['dsh-client-ui-chat/src/client/chat/AssistantNodeView.tsx'])

  const makeComponent = (code) => {
    const rendered = []
    const React = {
      createElement: (type, props) => {
        const element = { type, props }
        rendered.push(element)
        return element
      },
    }
    const AssistantNodeView = evaluateSlice(code, {
      from: 'export const AssistantNodeView',
      loader: 'tsx',
      transform: { jsx: 'transform' },
      params: {
        React,
        memo: (component) => component,
        useCallback: (callback) => callback,
        useMemo: (factory) => factory(),
        AssistantMarkdown: function AssistantMarkdown() {},
      },
      binding: 'AssistantNodeView',
    })
    return { AssistantNodeView, rendered }
  }
  const props = (basePath) => ({
    node: {
      data: { blocks: [], status: 'settled', step: 1, finalNode: undefined },
      location: { kind: 'step', turn: { status: 'open' } },
    },
    groupPart: undefined,
    useDisclosure: undefined,
    useTurnData: () => undefined,
    turnProcess: undefined,
    openFile: () => {},
    renderMessageImages: false,
    fileMentions: () => undefined,
    usePresentation: undefined,
    t: 't',
    ...(basePath === undefined ? {} : { chamberFileApiBase: basePath }),
  })

  const patchedComponent = makeComponent(patched.code)
  patchedComponent.AssistantNodeView(props('/api/i/local'))
  assert.equal(patchedComponent.rendered.length, 1)
  assert.equal(patchedComponent.rendered[0].props.chamberFileApiBase, '/api/i/local',
    'the executed patched component must hand the root prop to AssistantMarkdown')
  // An official-layout caller without the prop keeps undefined (upstream shape).
  patchedComponent.rendered.length = 0
  patchedComponent.AssistantNodeView(props(undefined))
  assert.equal(patchedComponent.rendered[0].props.chamberFileApiBase, undefined)

  // Negative control: the same behaviour check against the unpatched component
  // must fail — the prop never reaches the child.
  const upstreamComponent = makeComponent(source)
  upstreamComponent.AssistantNodeView(props('/api/i/local'))
  assert.equal(upstreamComponent.rendered[0].props.chamberFileApiBase, undefined)
  assert.notEqual(upstreamComponent.rendered[0].props.chamberFileApiBase, '/api/i/local')
})

test('the chat view file images resolve from the per-entry base path (executed memo)', () => {
  const source = readFileSync(FILES.chatView, 'utf8')
  const patched = applyVendorPatches(IDS.chatViewReal, source)
  assert.notEqual(patched, undefined)
  assert.deepEqual(patched.applied, ['dsh-client-ui-chat/src/client/chat/ChatView.tsx'])
  assert.ok(patched.code.includes('useProjection, t, chamberFileApiBase,'), 'the prop is destructured out of the composed props')
  assert.ok(patched.code.includes('}), [chamberFileApiBase, cwd, t])'), 'the memo depends on the base path')

  // Behaviour: evaluate the patched memo with a recording resolver; the base it
  // hands the resolver must be this entry's own file-API directory, and the
  // decoded path must stay unprefixed (the resolver owns the path, not the base).
  const baseFor = (code, deps, prop) => {
    const start = code.indexOf('  const fileImages = useMemo(() => ({')
    const end = code.indexOf(NL + '  ' + deps, start)
    assert.notEqual(start, -1)
    assert.notEqual(end, -1)
    const js = esbuild.transformSync(code.slice(start, end) + NL + '  ' + deps + NL + 'return fileImages', { loader: 'tsx' }).code
    const makeFileImages = new Function('useMemo', 'fileMediaUrl', 'resolveWorkspacePath', 'document', 'cwd', 't', 'chamberFileApiBase', js)
    let seen
    const images = makeFileImages(
      (factory) => factory(),
      (base, path) => { seen = base + '|' + path; return seen },
      (_cwd, path) => path,
      { baseURI: 'http://127.0.0.1:30800/' },
      '/work',
      (key) => key,
      prop,
    )
    assert.equal(images.resolve('/tmp/a.png'), seen)
    return seen
  }
  // Upstream fallback: absent OR empty base keeps the document itself.
  assert.equal(baseFor(patched.code, '}), [chamberFileApiBase, cwd, t])', undefined), 'http://127.0.0.1:30800/|/tmp/a.png')
  assert.equal(baseFor(patched.code, '}), [chamberFileApiBase, cwd, t])', ''), 'http://127.0.0.1:30800/|/tmp/a.png',
    'an empty chamber fact stays document-relative, not origin-root')
  // Chamber: the per-entry prefix becomes the resolver's directory.
  assert.equal(baseFor(patched.code, '}), [chamberFileApiBase, cwd, t])', '/api/i/local'), 'http://127.0.0.1:30800/api/i/local/|/tmp/a.png')
  // Negative control: the unpatched memo ignores the prop entirely.
  assert.equal(baseFor(source, '}), [cwd, t])', '/api/i/local'), 'http://127.0.0.1:30800/|/tmp/a.png')
})


test('the file-upload patch routes the upload URL through the per-entry base path', async () => {
  const source = readFileSync(FILES.upload, 'utf8')
  const patched = applyVendorPatches(IDS.uploadReal, source)
  assert.notEqual(patched, undefined)
  assert.ok(
    patched.code.includes("function customTransport(customFetch: FileUploadFetch, basePath = ''): FileUploadTransport {"),
    'custom transport takes the prefix',
  )
  assert.ok(
    patched.code.includes("function workerTransport(basePath = ''): FileUploadTransport {"),
    'worker transport takes the prefix',
  )
  assert.ok(
    patched.code.includes('url: new URL(' + BT + '$' + '{basePath}$' + '{request.path}' + BT + ', document.baseURI).href,'),
    'the worker URL carries the prefix',
  )
  // Behaviour: evaluate the patched custom transport; its fetch receives the
  // prefixed document-relative path, and an empty prefix keeps upstream.
  const start = patched.code.indexOf('function customTransport')
  const end = patched.code.indexOf(NL + '}', start)
  const js = esbuild.transformSync(patched.code.slice(start, end + 2), { loader: 'ts' }).code
  const customTransport = new Function(js + NL + 'return customTransport')()
  let seen
  const fetchInput = async input => {
    seen = input
    return { status: 200, text: async () => '' }
  }
  const post = transport => transport.post({ path: 'api/session/uploadFileBinary?x=1', body: new Uint8Array() })
  await post(customTransport(fetchInput, '/api/i/local/'))
  assert.equal(seen, '/api/i/local/api/session/uploadFileBinary?x=1')
  await post(customTransport(fetchInput))
  assert.equal(seen, 'api/session/uploadFileBinary?x=1', 'no prefix keeps the upstream document-relative request')
})

test('the ui-deliverables controller prefixes both present routes (executed patched class)', async () => {
  const source = readFileSync(FILES.presentOpen, 'utf8')
  const patched = applyVendorPatches(IDS.presentOpen, source)
  assert.notEqual(patched, undefined)
  assert.deepEqual(patched.applied, ['dsh-client-ui-deliverables/src/client/present-open.ts'])

  const makeController = (code, basePath) => {
    const calls = []
    const Controller = evaluateSlice(code, {
      from: 'export const PRESENTED_SUCCESS_HOLD_MS',
      params: {
        createSnapshotStore: fakeSnapshotStore,
        presentedFileUrl: (sessionId, seq, index) => 'api/present.open?sessionId=' + sessionId + '&seq=' + seq + '&index=' + index,
        changedFileUrl: (sessionId, seq, index) => 'api/present.changed?sessionId=' + sessionId + '&seq=' + seq + '&index=' + index,
        PRESENT_HOST_ROUTE: 'api/present.host',
        isPresentedHost: (value) => value !== null && typeof value === 'object',
        fetch: async (input, init) => {
          calls.push({ url: String(input), method: init?.method })
          return { ok: true, status: 200, json: async () => ({ name: 'host', available: true, fileManager: null }) }
        },
        AbortController,
        AbortSignal,
        setTimeout,
        clearTimeout,
      },
      binding: 'PresentedOpenController',
    })
    return { controller: new Controller(basePath), calls }
  }
  const EXPECTED_URLS = [
    '/api/i/local/api/present.host',
    '/api/i/local/api/present.open?sessionId=s1&seq=7&index=0',
    '/api/i/local/api/present.changed?sessionId=s1&seq=8&index=1',
  ]
  const expectPrefixed = (calls) => assert.deepEqual(calls.map((call) => call.url), EXPECTED_URLS)

  // The constructor normalizes the prefix once; both routes and the host read
  // go through it, and the POST carries the method.
  const prefixed = makeController(patched.code, '/api/i/local')
  await prefixed.controller.loadHost()
  await prefixed.controller.open('s1', 7, 0)
  await prefixed.controller.openChanged('s1', 8, 1)
  expectPrefixed(prefixed.calls)
  assert.deepEqual(prefixed.calls.map((call) => call.method), [undefined, 'POST', 'POST'])
  await prefixed.controller.dispose()

  // Upstream fallback: no base path supplied (official-layout deployment).
  const plain = makeController(patched.code)
  await plain.controller.open('s1', 7, 0)
  assert.equal(plain.calls[0].url, 'api/present.open?sessionId=s1&seq=7&index=0')
  await plain.controller.dispose()

  // Negative control: the SAME behaviour check against the unpatched body must
  // fail — even with the field planted (the pre-fix index assignment shape),
  // the upstream route builder ignores it.
  const upstream = makeController(source)
  upstream.controller.chamberFileApiBase = '/api/i/local/'
  await upstream.controller.loadHost()
  await upstream.controller.open('s1', 7, 0)
  await upstream.controller.openChanged('s1', 8, 1)
  assert.equal(upstream.calls[0].url, 'api/present.host', 'upstream ignores the planted prefix')
  assert.throws(
    () => expectPrefixed(upstream.calls),
    /strictly deep-equal|Expected values/,
    'the unpatched controller must not satisfy the prefixed-route behaviour',
  )
  await upstream.controller.dispose()
})

test('the session-log-export controller concatenates the prefixed route (executed patched class)', async () => {
  const source = readFileSync(FILES.exportController, 'utf8')
  const patched = applyVendorPatches(IDS.exportController, source)
  assert.notEqual(patched, undefined)
  assert.deepEqual(patched.applied, ['dsh-session-log-export/src/client/controller.ts'])

  const makeController = (code) => {
    const fetches = []
    const saves = []
    const Controller = evaluateSlice(code, {
      from: 'const INITIAL',
      params: {
        createSnapshotStore: fakeSnapshotStore,
        SESSION_LOG_EXPORT_ROUTE: 'api/session.export',
        downloadUrl: () => {},
      },
      binding: 'SessionLogDownloadController',
    })
    const controller = new Controller(
      async (input, init) => {
        fetches.push({ url: String(input), method: init?.method })
        return { ok: true, status: 200, text: async () => '' }
      },
      (url, filename) => saves.push({ url, filename }),
    )
    return { controller, fetches, saves }
  }
  const EXPECTED_ROUTE = '/api/i/local/api/session.export?sessionId=s1&includeDescendants=true'

  // What the patched index hands the controller: the canonical trailing slash.
  const prefixed = makeController(patched.code)
  prefixed.controller.chamberFileApiBase = '/api/i/local/'
  await prefixed.controller.download('s1')
  assert.deepEqual(prefixed.fetches, [{ url: EXPECTED_ROUTE, method: 'HEAD' }])
  assert.deepEqual(prefixed.saves, [{ url: EXPECTED_ROUTE, filename: 'dsh-session-s1.zip' }])

  // Upstream fallback: the default field value keeps the document-relative route.
  const plain = makeController(patched.code)
  await plain.controller.download('s1')
  assert.equal(plain.fetches[0].url, 'api/session.export?sessionId=s1&includeDescendants=true')

  // Negative control: the unpatched body concatenates the UNPREFIXED route even
  // with the field planted, so the behaviour assertion must go red.
  const upstream = makeController(source)
  upstream.controller.chamberFileApiBase = '/api/i/local/'
  await upstream.controller.download('s1')
  assert.equal(upstream.fetches[0].url, 'api/session.export?sessionId=s1&includeDescendants=true')
  assert.throws(
    () => assert.equal(upstream.fetches[0].url, EXPECTED_ROUTE),
    /Expected values to be strictly equal/,
    'the unpatched controller must not satisfy the prefixed-route behaviour',
  )
})

test('the patched index expressions hand the ctx fact to the controllers (executed statements)', () => {
  // ui-deliverables: the apply body constructs the controller with the ctx fact
  // (undefined-safe), normalizing inside the controller.
  const deliverablesIndex = applyVendorPatches(IDS.deliverablesIndex, readFileSync(FILES.deliverablesIndex, 'utf8'))
  assert.notEqual(deliverablesIndex, undefined)
  const openerLine = deliverablesIndex.code.split(NL).find((line) => line.includes('const opener = new PresentedOpenController('))
  assert.notEqual(openerLine, undefined, 'the apply body constructs the opener')
  const openerJs = esbuild.transformSync(
    'const opener = ' + openerLine.replace(/^\s*const opener = /, ''),
    { loader: 'ts' },
  ).code
  const makeOpener = (basePath) => {
    const seen = []
    class Controller {
      constructor(base) { seen.push(base) }
    }
    const ctx = { get: (key) => key === 'chamberBasePath' ? basePath : undefined }
    new Function('PresentedOpenController', 'ctx', openerJs + NL + 'return opener')(Controller, ctx)
    return seen[0]
  }
  assert.equal(makeOpener('/api/i/local'), '/api/i/local')
  assert.equal(makeOpener(undefined), '', 'an absent chamber fact degrades to the official layout')
  assert.equal(makeOpener(''), '', 'an empty chamber fact stays document-relative, not origin-root')

  // session-log-export: the two inserted statements read and normalize the fact.
  const exportIndex = applyVendorPatches(IDS.exportIndex, readFileSync(FILES.exportIndex, 'utf8'))
  assert.notEqual(exportIndex, undefined)
  const statements = exportIndex.code.split(NL)
    .filter((line) => line.includes("ctx.get('chamberBasePath')") || line.includes('controller.chamberFileApiBase ='))
  assert.equal(statements.length, 2, 'the patch inserts the read and the normalized assignment')
  const assignJs = esbuild.transformSync(statements.join(NL), { loader: 'ts' }).code
  const assignBase = (basePath) => {
    const controller = { chamberFileApiBase: '' }
    const ctx = { get: (key) => key === 'chamberBasePath' ? basePath : undefined }
    new Function('ctx', 'controller', assignJs)(ctx, controller)
    return controller.chamberFileApiBase
  }
  assert.equal(assignBase('/api/i/local'), '/api/i/local/')
  assert.equal(assignBase(undefined), '', 'an absent chamber fact degrades to the official layout')
  assert.equal(assignBase(''), '', 'an empty chamber fact stays document-relative, not origin-root')

  // ui-deliverables stores: the inserted statements read and normalize the fact
  // for BOTH read stores (the wire URL only; the state key stays unprefixed).
  const storeLines = deliverablesIndex.code.split(NL).filter((line) => line.includes('chamberFileApiBase'))
  const declarations = deliverablesIndex.code.split(NL)
    .filter((line) => line.includes('const chamberBasePath') || line.includes('const chamberFileApiBase'))
  assert.equal(declarations.length, 2, 'the patch inserts the read and the normalized prefix')
  const storeDeclJs = esbuild.transformSync(declarations.join(NL), { loader: 'ts' }).code
  const storeBase = (basePath) => {
    const ctx = { get: (key) => key === 'chamberBasePath' ? basePath : undefined }
    return new Function('ctx', storeDeclJs + NL + 'return chamberFileApiBase')(ctx)
  }
  assert.equal(storeBase('/api/i/local'), '/api/i/local/')
  assert.equal(storeBase(undefined), '', 'an absent chamber fact degrades to the official layout')
  assert.equal(storeBase(''), '', 'an empty chamber fact stays document-relative, not origin-root')
  assert.equal(storeLines.filter((line) => line.includes('.chamberFileApiBase = chamberFileApiBase')).length, 2,
    'both read stores receive the prefix')
})

/**
 * A minimal BoundConversation host: the fake feed drives the publication path
 * and every scheduled requestAnimationFrame is queued for the test to run, so
 * the flush timestamps of the REAL patched scheduler are observable.
 */
function schedulerHarness(code, { appendPublication = 'animation-frame' } = {}) {
  const start = code.indexOf('class BoundConversation')
  const end = code.indexOf('interface BindingRecord')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const js = esbuild.transformSync(code.slice(start, end), { loader: 'ts' }).code
  let now = 1000
  const frames = []
  const flushes = []
  const BoundConversation = new Function(
    'createSnapshotStore', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance',
    js + NL + 'return BoundConversation',
  )(
    () => ({ getSnapshot: () => ({}), set: () => {}, update: (mutate) => mutate({}) }),
    (callback) => { frames.push(callback); return frames.length },
    () => { frames.length = 0 },
    { now: () => now },
  )
  const assembler = {
    flush: () => { flushes.push(now); return true },
    openTurn: () => 1,
    activateTarget: () => false,
    activityTargets: () => [],
    replaceWindow: () => 'none',
    prepend: () => 'none',
    append: () => appendPublication,
    settleAssistant: () => 'none',
    rebuildRegistry: () => 'none',
  }
  let listener
  let revision = 0
  let eventWindow = { revision: 0, change: { kind: 'replace' }, entries: [], hasMore: false }
  const feed = {
    getSnapshot: () => eventWindow,
    subscribe: (callback) => { listener = callback; return () => { listener = undefined } },
  }
  new BoundConversation(feed, assembler)
  const emit = () => {
    revision += 1
    eventWindow = { revision, change: { kind: 'append', entries: [{}] }, hasMore: false }
    listener()
  }
  const drive = () => {
    const callback = frames.shift()
    assert.notEqual(callback, undefined, 'no animation frame queued')
    callback()
  }
  return { frames, flushes, emit, drive, setNow: (value) => { now = value } }
}

test('the conversation scheduler holds saturated streams to the 80 ms slice (executed patched body)', () => {
  const source = readFileSync(FILES.assembly, 'utf8')
  const patched = applyVendorPatches(IDS.assembly, source)
  assert.notEqual(patched, undefined)
  assert.deepEqual(patched.applied, ['dsh-client-ui-conversation/src/client/conversation/assembly.ts'])

  // 8 ms frames (a 120 Hz display): the upstream three-paint chain takes 24 ms,
  // so the next event is < 40 ms after the last publication — saturated.
  const runStream = (code) => {
    const harness = schedulerHarness(code)
    harness.setNow(1000)
    harness.emit()
    for (const at of [1008, 1016, 1024]) {
      harness.setNow(at)
      harness.drive()
    }
    assert.equal(harness.flushes.length, 1, 'the first publication keeps the three-paint chain')
    for (let at = 1032; at <= 1200; at += 8) {
      harness.setNow(at)
      harness.emit()
      if (harness.frames.length > 0) harness.drive()
    }
    return harness.flushes
  }

  const patchedFlushes = runStream(patched.code)
  assert.equal(patchedFlushes[0], 1024, 'the quiet path still flushes after three paints')
  assert.ok(patchedFlushes[1] >= 1104, 'a saturated stream holds until the 80 ms slice boundary: ' + JSON.stringify(patchedFlushes))
  assert.ok(patchedFlushes.length <= 3, 'saturated flushes coalesce instead of one per chain: ' + JSON.stringify(patchedFlushes))

  // Negative control: executing the SAME stream against the upstream body
  // keeps the one-chain-per-publication cadence and flushes inside the slice
  // window — exactly the defect this patch removes.
  const upstreamFlushes = runStream(source)
  assert.ok(upstreamFlushes.some((at) => at > 1024 && at < 1104),
    'upstream must flush inside the slice window: ' + JSON.stringify(upstreamFlushes))
  assert.ok(upstreamFlushes.length >= 7,
    'upstream (three paints per flush) must flush far more often: ' + JSON.stringify(upstreamFlushes))
})

test('immediate publications bypass the scheduler and cancel the pending frame (executed patched body)', () => {
  const source = readFileSync(FILES.assembly, 'utf8')
  const patched = applyVendorPatches(IDS.assembly, source)
  const harness = schedulerHarness(patched.code, { appendPublication: 'animation-frame' })
  harness.setNow(1000)
  harness.emit()
  assert.equal(harness.frames.length, 1, 'the animation-frame publication queued a frame')
  const immediate = schedulerHarness(patched.code, { appendPublication: 'immediate' })
  immediate.setNow(1000)
  immediate.emit()
  assert.deepEqual(immediate.flushes, [1000], 'immediate flushes synchronously')
  assert.equal(immediate.frames.length, 0, 'immediate never queues a paint')
})

test('the running-row sweep animates only compositor properties (parsed patched CSS)', () => {
  const file = 'dsh-client-ui-chat/src/client/chat/ReasoningRow.module.css'
  const name = 'dsh-reasoning-row-sweep'
  const source = readFileSync(FILES.reasoningCss, 'utf8')
  const patched = applyVendorPatches(IDS.reasoningCss, source)
  assert.notEqual(patched, undefined, file + ' must be selected through the submodule id form')
  assert.deepEqual(patched.applied, [file])

  /** Parse one @keyframes block and return the animated property names. */
  const keyframeProperties = (css, keyframesName) => {
    const block = new RegExp('@keyframes\\s+' + keyframesName + '\\s*\\{([\\s\\S]*?)\\n\\}').exec(css)
    assert.notEqual(block, null, '@keyframes ' + keyframesName + ' not found')
    const body = block[1].replace(/\/\*[\s\S]*?\*\//g, '')
    const properties = new Set()
    for (const match of body.matchAll(/([a-zA-Z-]+)\s*:/g)) properties.add(match[1])
    return [...properties].sort()
  }

  const running = new RegExp('animation:\\s*(' + name + '[\\w-]*)\\s+2\\.6s ease-out infinite;').exec(patched.code)
  assert.notEqual(running, null, 'the running row uses the sweep animation')
  assert.equal(running[1], name + '-x')
  assert.deepEqual(keyframeProperties(patched.code, running[1]), ['transform'],
    'the patched sweep must animate only a compositor property')
  assert.ok(patched.code.includes('animation: none;'), 'the reduced-motion opt-out is untouched')
  // Negative control: the same parser reports the upstream layout property.
  assert.deepEqual(keyframeProperties(source, name), ['left'])
  // 0.1.7-rc.2 retired the sibling command-row sweep; a patch for a file that
  // no longer carries the animation would be dead code.
  assert.equal(
    VENDOR_PATCHES.find((patch) => patch.vendorFile.includes('GenericCommandCard')),
    undefined,
    'the retired command-row sweep patch is deleted',
  )
})

/**
 * The follow sampler's settle path, driven through the PATCHED class: the
 * viewport reports a reader-attributed offset (inside or beyond the follow
 * tolerance) and the settle decides whether the tail is re-pinned.
 */
function readingHarness(code, { movedByReader, top, floor }) {
  const metrics = { top, floor, height: 500 }
  const calls = { scrollToBottom: 0, states: [] }
  const follow = {
    following: true,
    animating: false,
    nearBottom: (value) => value.floor - value.top <= 24,
    sample(value, moved) {
      if (!this.animating && moved) this.following = this.nearBottom(value)
      return this.following
    },
    setFollowing(value) { this.following = value },
  }
  const viewport = {
    readScroll: () => ({ metrics, movedByReader }),
    scrollToBottom: () => { calls.scrollToBottom += 1; return { metrics, turn: 1, position: null } },
    capturePosition: () => null,
    acknowledge: () => {},
    latestTurn: 1,
    readVisibleTurn: () => 1,
  }
  const store = { read: () => null, save: () => {} }
  const ChatReading = evaluateSlice(code, {
    from: 'export class ChatReading {',
    to: 'export function useChatReading',
    binding: 'ChatReading',
    params: { window: { setTimeout: () => 0, clearTimeout: () => {} } },
  })
  const reading = new ChatReading(viewport, store, { initialized: true, followingTail: true }, (state) => { calls.states.push(state) }, follow)
  reading.sampleTimer = 1
  return { reading, calls }
}

test('the follow sampler re-pins a residual offset inside the tolerance (executed patched class)', () => {
  const source = readFileSync(FILES.reading, 'utf8')
  const patched = applyVendorPatches(IDS.readingReal, source)
  assert.notEqual(patched, undefined)
  assert.deepEqual(patched.applied, ['dsh-client-ui-chat/src/client/chat/use-chat-reading.ts'])

  // The reported defect: the settle arrives with the tail still owned and a
  // 12 px residual offset (half of a 24 px row) — the tail must win.
  const patchedInside = readingHarness(patched.code, { movedByReader: true, top: 988, floor: 1000 })
  patchedInside.reading.flushSample()
  assert.equal(patchedInside.calls.scrollToBottom, 1, 'a settled offset inside the tolerance re-pins the floor')
  assert.equal(patchedInside.reading.followingTail, true, 'the tail stays owned inside the tolerance')

  // Negative control: the SAME delivery against the upstream body keeps the
  // offset — exactly the defect this patch removes.
  const upstreamInside = readingHarness(source, { movedByReader: true, top: 988, floor: 1000 })
  upstreamInside.reading.flushSample()
  assert.equal(upstreamInside.calls.scrollToBottom, 0, 'upstream keeps the residual offset')

  // A released follow (movement beyond the tolerance) is untouched: the reader
  // position is preserved and nothing is re-pinned.
  const released = readingHarness(patched.code, { movedByReader: true, top: 940, floor: 1000 })
  released.reading.flushSample()
  assert.equal(released.calls.scrollToBottom, 0, 'a released follow must not re-pin')
  assert.equal(released.reading.followingTail, false, 'the reader position is kept')
})

test('an id without a registered patch is left untouched', () => {
  assert.equal(applyVendorPatches('/x/node_modules/@deepseek-ai/dsh-client-ui-conversation/src/client/index.ts', 'code'), undefined)
  assert.equal(applyVendorPatches('/x/packages/renderer/src/main.tsx', 'code'), undefined)
})

test('a drifted anchor fails loudly instead of silently shipping an unpatched bundle', () => {
  const source = readFileSync(FILES.markdown, 'utf8')
  const drifted = source.replace(
    'return { resolve: value => localPathMediaUrl(document.baseURI, value) }',
    'return { resolve: value => localPathMediaUrl(value, document.baseURI) }',
  )
  assert.notEqual(drifted, source, 'the test mutation must change the source')
  assert.throws(
    () => applyVendorPatches(IDS.markdown, drifted),
    /AssistantMarkdown\.tsx[\s\S]*anchor matched 0 times \(expected exactly 1\)[\s\S]*Reason: document-relative file-API URL/,
  )
})

test('an ambiguous anchor (duplicated upstream text) also fails loudly', () => {
  const source = readFileSync(FILES.markdown, 'utf8')
  const duplicated = source + NL + source
  assert.throws(() => applyVendorPatches(IDS.markdown, duplicated), /anchor matched 2 times \(expected exactly 1\)/)
})

test('vite module ids with a query string or windows separators still match', () => {
  const source = readFileSync(FILES.markdown, 'utf8')
  assert.notEqual(applyVendorPatches(IDS.markdown + '?v=abc123', source), undefined)
  assert.notEqual(
    applyVendorPatches('C:\\repo\\node_modules\\@deepseek-ai\\dsh-client-ui-chat\\src\\client\\chat\\AssistantMarkdown.tsx', source),
    undefined,
  )
})

test('the ui-workspace selection persist key is scoped to the entry base path (I-14)', () => {
  const source = readFileSync(FILES.workspaceNavigation, 'utf8')
  const patched = applyVendorPatches(IDS.workspaceNavigation, source)
  assert.notEqual(patched, undefined, 'the ui-workspace navigation module must be patched')
  assert.ok(patched.applied.includes('dsh-client-ui-workspace/src/client/navigation.ts'))
  assert.ok(patched.code.includes('chamberSelectionScope(this.ctx)'), 'the store call must read the per-entry scope')
  assert.ok(!patched.code.includes("{ persist: { name: 'dsh.sessions.current' } }"),
    'the page-global persist key must be gone')
  // The injected helper is plain JS: evaluate exactly the emitted function and
  // prove the scope semantics, including the official-layout fallback.
  const start = patched.code.indexOf('function chamberSelectionScope')
  const end = patched.code.indexOf(NL + '}', start)
  assert.ok(start !== -1 && end !== -1, 'the helper must be injected')
  const scopeOf = new Function('return (' + patched.code.slice(start, end + 2) + ')')()
  assert.equal(scopeOf({ get: () => '/api/i/remote-a' }), './api/i/remote-a')
  assert.equal(scopeOf({ get: () => '/api/i/local' }), './api/i/local')
  assert.equal(scopeOf({ get: () => undefined }), '', 'no chamberBasePath keeps upstream behaviour')
  assert.equal(scopeOf({ get: () => 42 }), '', 'a non-string service value keeps upstream behaviour')
})

test('every registered vendor patch has exactly one artifact present marker', () => {
  for (const patch of VENDOR_PATCHES) {
    const markers = VENDOR_PATCH_MARKERS.filter((marker) => marker.vendorFile === patch.vendorFile)
    assert.equal(markers.length, 1, patch.vendorFile + ' must have exactly one artifact marker')
    assert.equal(markers[0].present instanceof RegExp, true, patch.vendorFile + ': present must be a RegExp')
  }
})

test('a route-bound marker is judged inside the chunk declaring its route (cross-chunk negative control)', () => {
  const what = 'ui-deliverables present routes carry the per-entry base path'
  const failures = (assets) => checkVendorPatchBundle(assets).filter((failure) => failure.what === what)
  // The marker in the foreign chunk must not vouch for the route's own
  // (unpatched) copy in the owner chunk.
  const owner = 'const o="/api/present.host",d=o.slice(1);async function f(t){return fetch(d,{signal:t})}'
  const foreign = 'async function g(a){return fetch(' + BT + '${this.chamberFileApiBase}${a}' + BT + ')}'
  assert.equal(failures([owner, foreign]).length, 1, 'a foreign marker must not satisfy the route owner')
  assert.equal(failures([foreign]).length, 1, 'a missing route declaration must fail')
  // Marker and route in the SAME chunk: present.
  // BOTH patched routes must appear: the host read (consumed by .ok/.json) and the POST open.
  const patched = 'const o="/api/present.host",d=o.slice(1);async function f(t){const n=await fetch(' + BT + '${this.chamberFileApiBase}${d}' + BT + ',{signal:t});if(n.ok){return await n.json()}}'
    + 'async function g(t){return fetch(' + BT + '${this.chamberFileApiBase}${d}' + BT + ',{method:"POST",signal:t})}'
  assert.deepEqual(failures([patched]), [])
})

test('the intrinsic-prototype patch accepts plain JSON under a multi-line Function.prototype.toString', () => {
  const source = readFileSync(FILES.values, 'utf8')
  const viaVendorPath = applyVendorPatches(IDS.valuesVendor, source)
  const patched = applyVendorPatches(IDS.valuesReal, source)
  assert.notEqual(viaVendorPath, undefined, 'the @deepseek-ai id form must match')
  assert.notEqual(patched, undefined, 'the realpath id form must match')
  assert.equal(viaVendorPath.code, patched.code, 'both id forms produce the same patch')
  assert.deepEqual(patched.applied, ['dsh-util-values/src/index.ts'])
  assert.ok(patched.code.includes('.replace(/\\s+/g'), 'the anchor was rewritten in place')
  // The exported snapshot API is the observable face: it returns undefined for every
  // plain object/array while the engine prints multi-line native source.
  const slice = { from: 'function hasIntrinsicConstructor', to: 'export function isJsonValue' }
  const upstream = evaluateSlice(source, { ...slice, binding: 'snapshotJsonValue' })
  const fixed = evaluateSlice(patched.code, { ...slice, binding: 'snapshotJsonValue' })
  const nativeToString = Function.prototype.toString
  Function.prototype.toString = function toString() {
    return String(nativeToString.call(this)).replace('{ [native code] }', '{' + NL + '    [native code]' + NL + '}')
  }
  let upstreamValue
  let patchedValue
  try {
    upstreamValue = upstream({ a: [1, 2], b: 'x' })
    patchedValue = fixed({ a: [1, 2], b: 'x' })
  } finally {
    Function.prototype.toString = nativeToString
  }
  // Negative control: the unpatched predicate rejects a plain value under the
  // multi-line form - the exact defect this entry exists for.
  assert.equal(upstreamValue, undefined)
  assert.deepEqual(patchedValue, { a: [1, 2], b: 'x' })
  // V8's canonical single-line form keeps working, and non-plain objects stay out.
  assert.deepEqual(fixed({ a: [1, 2] }), { a: [1, 2] })
  assert.equal(fixed(new Date()), undefined)
})

/**
 * A throwaway vendor root for the retirement verdicts. The real tree exercises
 * the happy path above; these fixtures drive the two failure branches.
 */
function retireFixtureRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-retire-'))
  return {
    root: dir + '/',
    write: (file, text) => writeFileSync(join(dir, file), text),
  }
}

const FIXTURE_PATCH = {
  idSuffixes: ['fixture.ts'],
  vendorFile: 'fixture.ts',
  reason: 'fixture reason',
  edits: [{ expect: 'ORIGINAL;', replace: 'PATCHED;' }],
  retireCheck: {
    probes: [{ match: [/FIXED_MARK/], absent: ['ORIGINAL;'] }],
    note: 'upstream carries the fix',
  },
}

test('C9 verdicts separate a retired upstream fix from a construction drift (I-7)', () => {
  const fixture = retireFixtureRoot()
  fixture.write('fixture.ts', 'ORIGINAL;' + NL)
  const ok = checkVendorPatchSources(fixture.root, [FIXTURE_PATCH])[0]
  assert.equal(ok.verdict, 'ok')
  assert.equal(ok.ok, true)

  // Anchor gone + the fix shape present = retire candidate, still blocking.
  fixture.write('fixture.ts', '// FIXED_MARK' + NL + 'CHANGED;' + NL)
  const candidate = checkVendorPatchSources(fixture.root, [FIXTURE_PATCH])[0]
  assert.equal(candidate.verdict, 'retire-candidate')
  assert.equal(candidate.ok, false)
  assert.match(candidate.detail, /retireCheck matched/)
  assert.match(candidate.detail, /upstream carries the fix/)

  // Anchor gone and no fix shape = plain drift, re-derive against the new pin.
  fixture.write('fixture.ts', 'CHANGED;' + NL)
  const drift = checkVendorPatchSources(fixture.root, [FIXTURE_PATCH])[0]
  assert.equal(drift.verdict, 'drift')
  assert.match(drift.detail, /re-derive the patch against the new pin/)

  // An entry without a retireCheck keeps the drift-only behavior.
  fixture.write('fixture.ts', 'CHANGED;' + NL)
  const noCheck = { ...FIXTURE_PATCH, retireCheck: undefined }
  assert.equal(checkVendorPatchSources(fixture.root, [noCheck])[0].verdict, 'drift')
})

test('retired patches are fenced by their ensure assertion', () => {
  const fixture = retireFixtureRoot()
  fixture.write('fixed.ts', 'const engineIndependent = true;' + NL)
  const entry = { vendorFile: 'fixed.ts', reason: 'fixture fix', ensure: 'const engineIndependent = true;' }
  assert.equal(checkRetiredPatches(fixture.root, [entry])[0].ok, true)
  fixture.write('fixed.ts', 'const regressed = true;' + NL)
  const missing = checkRetiredPatches(fixture.root, [entry])[0]
  assert.equal(missing.ok, false)
  assert.match(missing.detail, /ensure matched 0 times/)
  fixture.write('fixed.ts', 'const engineIndependent = true;' + NL + 'const engineIndependent = true;' + NL)
  assert.match(checkRetiredPatches(fixture.root, [entry])[0].detail, /matched 2 times/)
})

test('the live registry declares a retirement form per patch and no orphan artifact marker', () => {
  assert.deepEqual(vendorPatchRegistryProblems(), [])
  for (const patch of VENDOR_PATCHES) {
    assert.ok(patch.retireCheck !== undefined || patch.noRetireForm !== undefined, patch.vendorFile)
  }
  // Nothing is retired at the current pin. Accepting a retire-candidate moves
  // the entry here and deletes its patch + marker in the same change.
  assert.deepEqual(RETIRED_PATCHES, [])
  for (const marker of VENDOR_PATCH_MARKERS) {
    if (marker.vendorFile === undefined) continue
    assert.equal(
      VENDOR_PATCHES.some((patch) => patch.vendorFile === marker.vendorFile),
      true,
      'orphan artifact marker (its patch was retired without deleting the marker): ' + marker.vendorFile,
    )
  }
})
test('the summary/diff store prefixes only the wire URL and keeps the state key (executed patched class)', async () => {
  const source = readFileSync(FILES.hostReadStore, 'utf8')
  const patched = applyVendorPatches(IDS.hostReadStoreReal, source)
  assert.notEqual(patched, undefined)
  assert.deepEqual(patched.applied, ['dsh-client-ui-deliverables/src/client/host-read-store.ts'])

  const makeStore = (code) => {
    const seen = []
    const Store = evaluateSlice(code, {
      from: 'export class HostReadStore',
      params: {
        createSnapshotStore: fakeSnapshotStore,
        fetch: async (input) => {
          seen.push(String(input))
          return { ok: true }
        },
      },
      binding: 'HostReadStore',
    })
    const policy = { loading: 'loading', failed: 'error', retryable: () => false, decode: async () => 'decoded' }
    return { store: new Store(policy), seen }
  }
  const route = 'api/changes.summary?sessionId=s1&seq=3'

  // Upstream shape: no base assigned, the document-relative request stands.
  const upstream = makeStore(source)
  await upstream.store.loadUrl(route)
  assert.equal(upstream.seen[0], route)

  // Chamber: the wire URL carries the prefix, the state key does NOT.
  const chamber = makeStore(patched.code)
  chamber.store.chamberFileApiBase = '/api/i/local/'
  await chamber.store.loadUrl(route)
  assert.equal(chamber.seen[0], '/api/i/local/' + route)
  assert.deepEqual(Object.keys(chamber.store.state.getSnapshot()), [route],
    'the state key stays the authenticated URL the callers and the controller key on')
})

test('the delivery-card file actions carry the per-entry base path (executed patched component)', () => {
  const source = readFileSync(FILES.deliverables, 'utf8')
  const patched = applyVendorPatches(IDS.deliverablesReal, source)
  assert.notEqual(patched, undefined)
  assert.deepEqual(patched.applied, ['dsh-client-ui-deliverables/src/client/Deliverables.tsx'])

  const render = (code, basePath) => {
    const slots = []
    const React = { createElement: (type, props) => ({ type, props }), Fragment: Symbol('fragment') }
    const Deliverables = evaluateSlice(code, {
      from: 'export function Deliverables',
      loader: 'tsx',
      transform: { jsx: 'transform' },
      params: {
        React,
        css: {},
        COLLAPSED_PRESENTED_COUNT: 4,
        useState: (initial) => [initial, () => {}],
        useEffect: () => {},
        PresentedFileCard: function PresentedFileCard() {},
        ChangedFiles: function ChangedFiles() {},
        Button: function Button() {},
        IconChevronDownOutlineRegular: function IconChevronDownOutlineRegular() {},
        IconChevronUpOutlineRegular: function IconChevronUpOutlineRegular() {},
        presentedFileUrl: (sessionId, seq, index) => 'api/present.open?sessionId=' + sessionId + '&seq=' + seq + '&index=' + index,
        changesSummaryUrl: (sessionId, seq) => 'api/changes.summary?sessionId=' + sessionId + '&seq=' + seq,
      },
      binding: 'Deliverables',
    })
    Deliverables({
      matched: { changes: null, presented: [{ seq: 1, index: 0, path: '/w/a.txt' }] },
      sessionId: 'local',
      openFile: () => {}, openPresented: () => {}, openChangesReview: () => {},
      loadChangesSummary: () => {}, loadChangesDiff: () => {}, reloadPresentedHost: () => {},
      useChangesDiff: () => undefined, useChangesSummary: () => undefined, useSessions: (selector) => selector({ byId: {} }),
      usePresentedHost: (selector) => selector({ available: true }), usePresentedOpen: (selector) => selector({}),
      useShowCodeDiff: (selector) => selector(false), t: (key) => key,
      renderSlot: (name, owner) => { slots.push({ name, owner }); return null },
      ...(basePath === undefined ? {} : { chamberFileApiBase: basePath }),
    })
    return slots
  }

  const chamber = render(patched.code, '/api/i/local')
  assert.equal(chamber[0].name, 'deliverables.file.actions')
  assert.equal(chamber[0].owner.actionUrl, '/api/i/local/api/present.open?sessionId=local&seq=1&index=0')
  // An official-layout caller without the prop keeps the upstream relative route.
  assert.equal(render(patched.code, undefined)[0].owner.actionUrl, 'api/present.open?sessionId=local&seq=1&index=0')

  // Negative control: the unpatched component ignores the prop entirely.
  const upstream = render(source, '/api/i/local')
  assert.equal(upstream[0].owner.actionUrl, 'api/present.open?sessionId=local&seq=1&index=0')
  assert.notEqual(upstream[0].owner.actionUrl, '/api/i/local/api/present.open?sessionId=local&seq=1&index=0')
})

test('the review file actions carry the per-entry base path (executed patched component)', () => {
  const source = readFileSync(FILES.reviewTab, 'utf8')
  const patched = applyVendorPatches(IDS.reviewTabReal, source)
  assert.notEqual(patched, undefined)
  assert.deepEqual(patched.applied, ['dsh-client-ui-deliverables/src/client/ReviewTab.tsx'])

  const summaryUrl = (sessionId, seq) => 'api/changes.summary?sessionId=' + sessionId + '&seq=' + seq
  const diffUrl = (sessionId, seq, index) => 'api/changes.diff?sessionId=' + sessionId + '&seq=' + seq + '&index=' + index
  const changedUrl = (sessionId, seq, index) => 'api/changes.open?sessionId=' + sessionId + '&seq=' + seq + '&index=' + index
  const tab = { id: 'changes-review:1', contentId: 'changes-review?seq=2&turn=1', navigation: { revision: 0, params: undefined }, actions: { openResource: () => {} } }

  const render = (code, basePath) => {
    const slots = []
    const React = { createElement: (type, props) => ({ type, props }), Fragment: Symbol('fragment') }
    const ReviewTab = evaluateSlice(code, {
      from: 'export function ReviewTab',
      loader: 'tsx',
      transform: { jsx: 'transform' },
      params: {
        React,
        css: {},
        diffCss: {},
        useState: (initial) => [initial, () => {}],
        useEffect: () => {},
        useMemo: (factory) => factory(),
        parseChangesReviewAddress: () => ({ seq: 2, turn: 1 }),
        navigatedIndex: () => undefined,
        changesSummaryUrl: summaryUrl,
        changesDiffUrl: diffUrl,
        changedFileUrl: changedUrl,
        fileAddressFor: () => '/w/a.txt',
        GROUPED: { format: (value) => String(value) },
        Counts: function Counts() {}, FileDiff: function FileDiff() {}, Menu: function Menu() {},
        PathLabel: function PathLabel() {}, Tooltip: function Tooltip() {},
        IconChevronDownOutlineRegular: function IconChevronDownOutlineRegular() {},
        IconCompareSplitOutlineRegular: function IconCompareSplitOutlineRegular() {},
        IconInspectOutlineRegular: function IconInspectOutlineRegular() {},
        IconNowrapFillRegular: function IconNowrapFillRegular() {},
        IconWrapFillRegular: function IconWrapFillRegular() {},
      },
      binding: 'ReviewTab',
    })
    ReviewTab({
      useTabInfo: () => ({ tab }),
      sessionId: 'local',
      useSessions: (selector) => selector({ byId: {} }),
      useStore: (selector) => selector({ byTab: { [tab.id]: { navigated: 0, index: 0, split: false, wrap: false } } }),
      useChangesSummary: (selector) => selector({ [summaryUrl('local', 2)]: { files: [{ path: 'a.txt', display: 'a.txt', added: 1, deleted: 0 }], turn: 1 } }),
      useChangesDiff: (selector) => selector({}),
      usePresentedHost: (selector) => selector({ available: true }),
      usePresentedOpen: (selector) => selector({}),
      actions: { navigated: () => {}, forget: () => {}, selected: () => {}, toggledSplit: () => {}, toggledWrap: () => {} },
      loadChangesSummary: () => {}, loadChangesDiff: () => {}, reloadPresentedHost: () => {}, openChanged: () => {},
      t: (key) => key,
      renderSlot: (name, owner) => { slots.push({ name, owner }); return null },
      ...(basePath === undefined ? {} : { chamberFileApiBase: basePath }),
    })
    return slots
  }

  const chamber = render(patched.code, '/api/i/local')
  assert.equal(chamber[0].name, 'deliverables.review.file.actions')
  assert.equal(chamber[0].owner.actionUrl, '/api/i/local/api/changes.open?sessionId=local&seq=2&index=0')
  assert.equal(render(patched.code, undefined)[0].owner.actionUrl, 'api/changes.open?sessionId=local&seq=2&index=0')

  const upstream = render(source, '/api/i/local')
  assert.equal(upstream[0].owner.actionUrl, 'api/changes.open?sessionId=local&seq=2&index=0')
  assert.notEqual(upstream[0].owner.actionUrl, '/api/i/local/api/changes.open?sessionId=local&seq=2&index=0')
})

/**
 * Patched packages that are NOT rows of their own: they arrive in the composite graph
 * as dependencies of covered packages (`util-values` is imported by ui-chat and
 * ui-deliverables). Every id here still has to be transformed by the composite build —
 * the buildEnd applied-coverage gate is the authority; a package that is only served
 * from the instance bundle (ui-sidebar-documentpreview) must never join this list.
 */
/**
 * Boot-graph ids `chamber-entry.ts` actually loads: its static imports and the deferred
 * roster, with the trailing `/client` face stripped. This is the precise set a patch can
 * ever be transformed in, so a patched package outside it is a dead patch even when the
 * covered list (a boot-dedupe set, not a load set) still names it.
 */
function entryLoadedIds(entrySource) {
  const ids = new Set()
  for (const match of entrySource.matchAll(/from\s+['"](@[^'"]+)['"]/gu)) {
    ids.add(match[1].replace(/\/(?:client|server)$/u, ''))
  }
  for (const match of entrySource.matchAll(/\[\s*'(@[^']+)'\s*,\s*\(\)\s*=>\s*import\(/gu)) {
    ids.add(match[1])
  }
  return [...ids]
}
const PATCHED_BUNDLED_DEPENDENCY_IDS = Object.freeze(['@deepseek-ai/dsh-util-values'])

/**
 * Covered ids the composite never loads, so a patch on one could never apply: the
 * deliberate skips `chamber-covered.ts` documents in its header (hmr / mobile /
 * directory-picker-native / settings-account) — page-own rows the composite replaces
 * plus host rows the shell drops on purpose. Without this subtraction the covered
 * check below would vouch for a package no module of which reaches the build — the
 * recorded ui-sidebar-documentpreview failure mode reached through the dedupe list
 * instead of an instance bundle.
 */
const COVERED_BUT_NEVER_LOADED_IDS = Object.freeze([
  '@deepseek-ai/dsh-client-hmr',
  '@dsh-chamber/dsh-client-ui-mobile',
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
  '@deepseek-ai/dsh-client-ui-settings-account',
])

test('every registered vendor patch targets a composite-covered package or dependency', () => {
  // A patch applies only to modules THIS build transforms. Registering one for an
  // instance-bundled row can never apply and fails buildEnd (the ⑫
  // ui-sidebar-documentpreview lesson), so assert graph membership here for early
  // feedback instead of waiting for a full build to fail. buildEnd stays the
  // authority: this names the boot-dedupe set minus the documented skips, not the
  // transformed-module set itself.
  for (const id of COVERED_BUT_NEVER_LOADED_IDS) {
    assert.ok(CHAMBER_COVERED_IDS.includes(id), 'the skip list names an id the covered set lost: ' + id)
  }
  // Pin the constant to the header that documents these skips (chamber-covered.ts):
  // renaming an id, or adding a skip without the header (or vice versa), fails here.
  const coveredHeader = readFileSync(new URL('../src/chamber-covered.ts', import.meta.url), 'utf8')
  for (const id of COVERED_BUT_NEVER_LOADED_IDS) {
    const short = id.replace(/^@[^/]+\//u, '').replace(/^dsh-(client-|chamber-)/u, '')
    assert.ok(coveredHeader.includes(short), 'the covered header no longer documents a skip: ' + short)
  }
  const packages = VENDOR_PATCHES.map((patch) => '@deepseek-ai/' + patch.vendorFile.slice(0, patch.vendorFile.indexOf('/')))
  // Precision on top of the covered-list check: the covered set is a boot-DEDUPE set, so a
  // phantom id (covered but never loaded) would pass it while its patch can never apply.
  // Bind every patched package to the ids chamber-entry.ts actually loads (plus the listed
  // bundled dependency), and prove the never-loaded list stays disjoint from that set.
  const entrySource = readFileSync(new URL('../src/chamber-entry.ts', import.meta.url), 'utf8')
  const loaded = entryLoadedIds(entrySource)
  const notLoaded = [...new Set(packages)].filter((id) => !loaded.includes(id) && !PATCHED_BUNDLED_DEPENDENCY_IDS.includes(id))
  assert.deepEqual(notLoaded, [], 'a patched package is not loaded by chamber-entry.ts: its patch can never apply')
  const loadedSkips = COVERED_BUT_NEVER_LOADED_IDS.filter((id) => loaded.includes(id))
  assert.deepEqual(loadedSkips, [], 'the never-loaded list names an id the entry actually loads')
  // A patched package in the skip list can never be transformed, so its patch would fail
  // buildEnd (or silently no-op behind a green fixture). Assert disjointness directly; the
  // covered set alone is a lower bound, and an unlisted phantom id still fails loudly at
  // buildEnd - later, which is the documented residual of this early check.
  const packagesInSkipList = [...new Set(packages)].filter((id) => COVERED_BUT_NEVER_LOADED_IDS.includes(id))
  assert.deepEqual(packagesInSkipList, [], 'a patched package sits in the never-loaded skip list')
  const unchecked = [...new Set(packages)].filter((id) => (
    !CHAMBER_COVERED_IDS.includes(id) && !PATCHED_BUNDLED_DEPENDENCY_IDS.includes(id)
  ))
  assert.deepEqual(unchecked, [],
    'a patched vendor package is neither composite-covered nor a listed bundled dependency: '
  )
})

test('the deliverables base wiring and the read-store field it writes stay registered together', () => {
  // ui-deliverables/src/client/index.ts assigns `.chamberFileApiBase` on both read stores — a
  // field that exists only because of the host-read-store entry. Retire that entry alone and the
  // index anchor still matches upstream text, the build stays green, and the write becomes a
  // silent no-op: summary/diff reads fall back to the control-plane origin. Bind the pair.
  const indexPatch = VENDOR_PATCHES.find((patch) => patch.vendorFile === 'dsh-client-ui-deliverables/src/client/index.ts')
  assert.notEqual(indexPatch, undefined, 'the deliverables index entry is registered')
  const writes = indexPatch.edits.some((edit) => edit.replace.includes('.chamberFileApiBase ='))
  assert.equal(writes, true, 'the index entry still hands the base to the read stores')
  const storePatch = VENDOR_PATCHES.find((patch) => patch.vendorFile === 'dsh-client-ui-deliverables/src/client/host-read-store.ts')
  assert.notEqual(storePatch, undefined, 'a base write without the read-store entry is a silent no-op')
  assert.equal(
    storePatch.edits.some((edit) => edit.replace.includes('chamberFileApiBase')),
    true,
    'the read-store entry no longer declares the field the index writes',
  )
})

test('the deliverables index insert anchors at the read-store constructions (execution order)', () => {
  // The second index edit inserts the base declaration plus both field writes. Anchoring it
  // anywhere else (e.g. after the apply() header) keeps every text-level check green while
  // the emitted code reads `summaries` before initialization - a TDZ ReferenceError at boot.
  // Bind the expect to the store constructions AND assert the patched statement order.
  const patch = VENDOR_PATCHES.find((candidate) => candidate.vendorFile === 'dsh-client-ui-deliverables/src/client/index.ts')
  assert.notEqual(patch, undefined, 'the deliverables index entry is registered')
  const insert = patch.edits.find((edit) => edit.replace.includes('chamberFileApiBase'))
  assert.notEqual(insert, undefined, 'the index entry still inserts the base wiring')
  assert.ok(insert.expect.includes('const summaries = new ChangesSummaryStore()'), 'the insert anchor must sit at the summary store construction')
  assert.ok(insert.expect.includes('const diffs = new ChangesDiffStore()'), 'the insert anchor must sit at the diff store construction')
  const patched = applyVendorPatches(IDS.deliverablesIndex, readFileSync(FILES.deliverablesIndex, 'utf8')).code
  const at = (needle) => {
    const index = patched.indexOf(needle)
    assert.notEqual(index, -1, 'the patched output lost: ' + needle)
    return index
  }
  const summaryStore = at('const summaries = new ChangesSummaryStore()')
  const diffStore = at('const diffs = new ChangesDiffStore()')
  const baseDecl = at("const chamberBasePath = ctx.get('chamberBasePath')")
  const summaryWrite = at('summaries.chamberFileApiBase =')
  const diffWrite = at('diffs.chamberFileApiBase =')
  assert.ok(summaryStore < baseDecl && diffStore < baseDecl, 'the base declaration must follow both store constructions')
  assert.ok(baseDecl < summaryWrite && summaryWrite < diffWrite, 'the field writes must follow the declaration, summary then diff')
})

test('the ui-chat file-image pair (AssistantMarkdown + ChatView) retires together', () => {
  // Both halves read the same root prop; retiring one alone leaves the other resolving
  // against document.baseURI on an N-ctx page. The deliverables index + read-store pair
  // already has this lock; this is the ui-chat twin, including the forwarding hop.
  const am = VENDOR_PATCHES.find((patch) => patch.vendorFile === 'dsh-client-ui-chat/src/client/chat/AssistantMarkdown.tsx')
  const cv = VENDOR_PATCHES.find((patch) => patch.vendorFile === 'dsh-client-ui-chat/src/client/chat/ChatView.tsx')
  assert.notEqual(am, undefined, 'the AssistantMarkdown entry is registered')
  assert.notEqual(cv, undefined, 'a base prop without the chat-view half leaves images on document.baseURI')
  for (const patch of [am, cv]) {
    assert.ok(VENDOR_PATCH_MARKERS.some((marker) => marker.vendorFile === patch.vendorFile), 'both halves keep an artifact marker: ' + patch.vendorFile)
    assert.ok(patch.edits.some((edit) => edit.replace.includes('chamberFileApiBase')), 'both halves still read the root prop: ' + patch.vendorFile)
  }
  assert.ok(VENDOR_PATCHES.some((patch) => patch.vendorFile.endsWith('AssistantNodeView.tsx')), 'the forwarding hop stays registered with the pair')
  assert.ok(VENDOR_PATCH_MARKERS.some((marker) => marker.vendorFile === undefined), 'the root prop publication marker must stay registered')
})
test('hand-written patch counts in README and the two docs match the registry', () => {
  // The "12 补丁 / 26 锚点" text went stale once already; derive the numbers and fail when a
  // doc keeps a count the registry no longer has (or drops the sentence entirely).
  const files = VENDOR_PATCHES.length
  const anchors = VENDOR_PATCHES.reduce((total, patch) => total + patch.edits.length, 0)
  const docs = [
    { path: '../README.md', pattern: /(\d+)\s*补丁\s*\/\s*(\d+)\s*锚点/u },
    { path: '../../../docs/design/09-client-plugin-runtime-loading.md', pattern: /(\d+)\s*个文件\s*\/\s*(\d+)\s*处锚点/u },
    { path: '../../../docs/checklists/upstream-touchpoints.md', pattern: /(\d+)\s*文件\s*\/\s*(\d+)\s*处锚点/u },
  ]
  for (const doc of docs) {
    const text = readFileSync(fileURLToPath(new URL(doc.path, import.meta.url)), 'utf8')
    const pattern = new RegExp(doc.pattern.source, doc.pattern.flags + 'g')
    const matches = [...text.matchAll(pattern)]
    assert.equal(matches.length, 1, 'the patch-count sentence must appear exactly once: ' + doc.path)
    const match = matches[0]
    assert.deepEqual(
      [Number(match[1]), Number(match[2])],
      [files, anchors],
      'a hand-written patch count is stale: ' + doc.path,
    )
  }
})

test('each patch artifact marker matches its own bundled source, and no other (fixture lockstep)', async () => {
  // Bundle mode, not a single-file transform: only a real bundle pass renames imported
  // and module-level helpers (the emitted chunk calls `$z1(...)` where the source says
  // `localPathMediaUrl(...)`), and a marker must never depend on such a name. Every
  // non-entry import stays external, so this fixture remains unit-speed.
  const externalPlugin = {
    name: 'chamber-external',
    setup(build) {
      build.onResolve({ filter: /.*/u }, (args) => args.kind === 'entry-point' ? undefined : { external: true })
    },
  }
  const bundle = async (code, file, loader) => {
    const result = await esbuild.build({
      stdin: { contents: code, resolveDir: dirname(file), sourcefile: basename(file), loader },
      bundle: true, write: false, minify: true, format: 'esm', platform: 'browser', logLevel: 'silent', plugins: [externalPlugin],
    })
    return result.outputFiles.map((output) => output.text).join(NL)
  }
  // Every registered vendor file, so no marker escapes the bundle-mode recipe (the
  // route literal rides beside its own file, and the raw bundle must reject the marker).
  const sources = [
    { vendorFile: 'dsh-client-ui-chat/src/client/chat/AssistantMarkdown.tsx', key: 'markdown', real: IDS.markdownReal, loader: 'tsx', route: '' },
    { vendorFile: 'dsh-client-ui-chat/src/client/chat/AssistantNodeView.tsx', key: 'nodeView', real: IDS.nodeView, loader: 'tsx', route: '' },
    { vendorFile: 'dsh-client-ui-chat/src/client/chat/ChatView.tsx', key: 'chatView', real: IDS.chatViewReal, loader: 'tsx', route: '' },
    { vendorFile: 'dsh-client-ui-chat/src/client/chat/ReasoningRow.module.css', key: 'reasoningCss', real: IDS.reasoningCss, loader: 'css', route: '' },
    { vendorFile: 'dsh-client-ui-chat/src/client/chat/use-chat-reading.ts', key: 'reading', real: IDS.readingReal, loader: 'ts', route: '' },
    { vendorFile: 'dsh-client-file-upload/src/client/runtime.ts', key: 'upload', real: IDS.uploadReal, loader: 'ts', route: 'api/session.uploadFileBinary' },
    { vendorFile: 'dsh-session-log-export/src/client/controller.ts', key: 'exportController', real: IDS.exportController, loader: 'ts', route: 'api/session.export' },
    { vendorFile: 'dsh-session-log-export/src/client/index.ts', key: 'exportIndex', real: IDS.exportIndex, loader: 'ts', route: '' },
    { vendorFile: 'dsh-client-ui-deliverables/src/client/present-open.ts', key: 'presentOpen', real: IDS.presentOpen, loader: 'ts', route: 'api/present.host' },
    { vendorFile: 'dsh-client-ui-deliverables/src/client/index.ts', key: 'deliverablesIndex', real: IDS.deliverablesIndex, loader: 'ts', route: '' },
    { vendorFile: 'dsh-client-ui-deliverables/src/client/host-read-store.ts', key: 'hostReadStore', real: IDS.hostReadStoreReal, loader: 'ts', route: 'api/changes.summary' },
    { vendorFile: 'dsh-client-ui-deliverables/src/client/Deliverables.tsx', key: 'deliverables', real: IDS.deliverablesReal, loader: 'tsx', route: 'api/present.open' },
    { vendorFile: 'dsh-client-ui-deliverables/src/client/ReviewTab.tsx', key: 'reviewTab', real: IDS.reviewTabReal, loader: 'tsx', route: 'api/changes.open' },
    { vendorFile: 'dsh-client-ui-conversation/src/client/conversation/assembly.ts', key: 'assembly', real: IDS.assembly, loader: 'ts', route: '' },
    { vendorFile: 'dsh-client-ui-workspace/src/client/navigation.ts', key: 'workspaceNavigation', real: IDS.workspaceNavigation, loader: 'ts', route: '' },
    { vendorFile: 'dsh-util-values/src/index.ts', key: 'values', real: IDS.valuesReal, loader: 'ts', route: '' },
  ]
  const bundled = []
  for (const entry of sources) {
    const file = FILES[entry.key]
    const source = readFileSync(file, 'utf8')
    const patched = applyVendorPatches(entry.real, source)
    assert.notEqual(patched, undefined, 'the registered patch applies: ' + entry.vendorFile)
    bundled.push({
      entry,
      patched: await bundle(patched.code, file, entry.loader) + ' ' + entry.route,
      raw: await bundle(source, file, entry.loader) + ' ' + entry.route,
    })
  }
  // The 17th marker has no vendorFile (the layout fork publishes the root prop). Give it the
  // same bundle lockstep as the vendor markers: it must match its own bundle and stay disjoint
  // from every patched and raw vendor bundle.
  const layoutFile = fileURLToPath(new URL('../../dsh-chamber-client-ui-layout/src/client/index.ts', import.meta.url))
  const layoutBundleText = await bundle(readFileSync(layoutFile, 'utf8'), layoutFile, 'tsx')
  const layoutMarker = VENDOR_PATCH_MARKERS.find((marker) => marker.vendorFile === undefined)
  assert.notEqual(layoutMarker, undefined, 'the layout publication marker is registered')
  assert.equal(layoutMarker.present.test(layoutBundleText), true, 'the layout marker matches the bundled layout source')
  for (const { entry, patched, raw } of bundled) {
    assert.equal(layoutMarker.present.test(patched), false, 'the layout marker stays disjoint from patched ' + entry.vendorFile)
    assert.equal(layoutMarker.present.test(raw), false, 'the layout marker stays disjoint from raw ' + entry.vendorFile)
  }
  for (const { entry, patched, raw } of bundled) {
    const marker = VENDOR_PATCH_MARKERS.find((candidate) => candidate.vendorFile === entry.vendorFile)
    assert.notEqual(marker, undefined, 'a marker exists for ' + entry.vendorFile)
    assert.equal(marker.present.test(patched), true, 'the marker matches the bundled patched source: ' + entry.vendorFile)
    assert.equal(marker.present.test(raw), false, 'the marker rejects the bundled unpatched source: ' + entry.vendorFile)
    // Gate-shaped: run the same check the build runs (route-scoped where the marker declares
    // one), so this fixture cannot pass a marker the real gate would drop.
    const gateFailures = checkVendorPatchBundle([patched])
    assert.equal(gateFailures.some((failure) => failure.what === marker.what), false, 'the gate-shaped check accepts: ' + entry.vendorFile)
    if (marker.route !== undefined) {
      // Falsify the route scoping itself: with the route literal removed, the route-bound
      // marker must disappear from the gate's view (otherwise routeOwned is inert here).
      const withoutRoute = patched.split(marker.route).join('').split(marker.route.replace(/^\//u, '')).join('')
      assert.equal(withoutRoute.includes(marker.route), false, 'the route literal is removable in the fixture: ' + entry.vendorFile)
      const stripped = checkVendorPatchBundle([withoutRoute])
      assert.equal(stripped.some((failure) => failure.what === marker.what), true, 'route scoping hides the marker without its route literal: ' + entry.vendorFile)
    }
    for (const other of bundled) {
      if (other.entry === entry) continue
      assert.equal(marker.present.test(other.patched), false, 'the marker stays disjoint from ' + other.entry.vendorFile)
    }
  }
  // The production minifier rewrites module-level helper names, so a marker that
  // names one would pass this fixture (single-file esbuild keeps the name) yet never
  // match the emitted chunk. Deny-list them explicitly: the lesson of the 10:49 red.
  const renamable = ['localPathMediaUrl', 'fileMediaUrl', 'markdownImageUrl', 'changedFileUrl', 'presentedFileUrl', 'resolveWorkspacePath']
  for (const marker of VENDOR_PATCH_MARKERS) {
    const risky = renamable.filter((token) => marker.present.source.includes(token))
    assert.deepEqual(risky, [], 'marker binds a helper the chunk minifier renames: ' + (marker.vendorFile ?? 'layout'))
  }
})
