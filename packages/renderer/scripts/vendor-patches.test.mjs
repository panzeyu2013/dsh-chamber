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
 * every registered patch: one present marker per vendor file, and the two
 * route-bound markers are judged inside the chunk declaring their route.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyVendorPatches, checkVendorPatchSources, VENDOR_PATCHES } from './vendor-patches.mjs'
import {
  VENDOR_PATCH_MARKERS,
  checkVendorPatchBundle,
} from './verify-vendor-patch-applied.mjs'

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
  reasoningCss: VENDOR + 'dsh-client-ui-chat/src/client/chat/ReasoningRow.module.css',
  upload: VENDOR + 'dsh-client-file-upload/src/client/runtime.ts',
  presentOpen: VENDOR + 'dsh-client-ui-deliverables/src/client/present-open.ts',
  deliverablesIndex: VENDOR + 'dsh-client-ui-deliverables/src/client/index.ts',
  exportController: VENDOR + 'dsh-session-log-export/src/client/controller.ts',
  exportIndex: VENDOR + 'dsh-session-log-export/src/client/index.ts',
  assembly: VENDOR + 'dsh-client-ui-conversation/src/client/conversation/assembly.ts',
  reading: VENDOR + 'dsh-client-ui-chat/src/client/chat/use-chat-reading.ts',
  values: VENDOR + 'dsh-util-values/src/index.ts',
}

/** Module ids in both forms: the symlinked vendor path and the realpath'd submodule path. */
const IDS = {
  markdown: '/x/node_modules/@deepseek-ai/dsh-client-ui-chat/src/client/chat/AssistantMarkdown.tsx',
  // The renderer resolves vendor sources through realpathSync, so the id vite
  // reports is normally the SUBMODULE path (this is the form that matters).
  markdownReal: '/x/vendor/harness-checkout/packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx',
  nodeView: '/x/vendor/harness-checkout/packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx',
  reasoningCss: '/x/vendor/harness-checkout/packages/client/ui-chat/src/client/chat/ReasoningRow.module.css',
  uploadReal: '/x/vendor/harness-checkout/packages/client/file-upload/src/client/runtime.ts',
  presentOpen: '/x/vendor/harness-checkout/packages/client/ui-deliverables/src/client/present-open.ts',
  deliverablesIndex: '/x/vendor/harness-checkout/packages/client/ui-deliverables/src/client/index.ts',
  exportController: '/x/vendor/harness-checkout/packages/session-query/session-log-export/src/client/controller.ts',
  exportIndex: '/x/vendor/harness-checkout/packages/session-query/session-log-export/src/client/index.ts',
  assembly: '/x/vendor/harness-checkout/packages/client/ui-conversation/src/client/conversation/assembly.ts',
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
  const patched = 'const o="/api/present.host",d=o.slice(1);async function f(t){return fetch(' + BT + '${this.chamberFileApiBase}${d}' + BT + ',{signal:t})}'
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
