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
  applyVendorPatches, checkRetiredPatches, checkVendorPatchSources, countSourcemapSegments,
  decodeSourcemapMappings, probeVendorPatchRetirement, RETIRED_PATCHES, VENDOR_PATCHES,
  vendorPatchRegistryProblems,
} from './vendor-patches.mjs'
import {
  VENDOR_PATCH_MARKERS,
  checkVendorPatchBundle,
  checkVendorPatchSourcemaps,
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
  account: VENDOR + 'dsh-client-ui-settings-account/src/client/index.ts',
  attachmentDrop: VENDOR + 'dsh-client-ui-attachment/src/client/drop-events.ts',
  attachmentComponent: VENDOR + 'dsh-client-ui-attachment/src/client/ComposerAttachments.tsx',
  nodeView: VENDOR + 'dsh-client-ui-chat/src/client/chat/AssistantNodeView.tsx',
  chatView: VENDOR + 'dsh-client-ui-chat/src/client/chat/ChatView.tsx',
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
  workspaceNavigation: VENDOR + 'dsh-client-ui-workspace/src/client/navigation.ts',
  workspaceIndex: VENDOR + 'dsh-client-ui-workspace/src/client/index.ts',
  // ui-theme styles.ts is RETIRED at alpha.1 (upstream replaced the inline-import
  // style-tag installer with bundle CSS imports; see RETIRED_PATCHES). Those module
  // resources are installed by the per-renderer DocumentStyles, which the
  // document-styles page-global entry dedupes for N-ctx.
  iconSprite: VENDOR + 'dsh-client-ui-theme/src/client/icon-sprite.ts',
  documentStyles: VENDOR + 'dsh-client-ui-renderer/src/client/styles/document-styles.ts',
  chatViewport: VENDOR + 'dsh-client-ui-chat/src/client/chat/use-chat-viewport.ts',
}

/** Module ids in both forms: the symlinked vendor path and the realpath'd submodule path. */
const IDS = {
  markdown: '/x/node_modules/@deepseek-ai/dsh-client-ui-chat/src/client/chat/AssistantMarkdown.tsx',
  // The renderer resolves vendor sources through realpathSync, so the id vite
  // reports is normally the SUBMODULE path (this is the form that matters).
  markdownReal: '/x/vendor/harness-checkout/packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx',
  accountReal: '/x/vendor/harness-checkout/packages/client/ui-settings-account/src/client/index.ts',
  attachmentDropReal: '/x/vendor/harness-checkout/packages/client/ui-attachment/src/client/drop-events.ts',
  attachmentComponentReal: '/x/vendor/harness-checkout/packages/client/ui-attachment/src/client/ComposerAttachments.tsx',
  nodeView: '/x/vendor/harness-checkout/packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx',
  chatViewReal: '/x/vendor/harness-checkout/packages/client/ui-chat/src/client/chat/ChatView.tsx',
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
  workspaceIndex: '/x/vendor/harness-checkout/packages/client/ui-workspace/src/client/index.ts',
  readingReal: '/x/vendor/harness-checkout/packages/client/ui-chat/src/client/chat/use-chat-reading.ts',
  iconSpriteReal: '/x/vendor/harness-checkout/packages/client/ui-theme/src/client/icon-sprite.ts',
  documentStylesReal: '/x/vendor/harness-checkout/packages/client/ui-renderer/src/client/styles/document-styles.ts',
  chatViewportReal: '/x/vendor/harness-checkout/packages/client/ui-chat/src/client/chat/use-chat-viewport.ts',
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
  assert.ok(patched.code.includes('mentions, renderSlot, useGroupAction, t, chamberFileApiBase,'),
    'the prop is destructured after the alpha.2 parameter additions (renderSlot, useGroupAction)')
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
    loadImage: false,
    fileMentions: () => undefined,
    // 0.2.2: the node view reads the folded-replies policy through this hook.
    usePresentation: (select) => select({ foldedReplies: 'none' }),
    t: 't',
    // 0.2.2-alpha.3: the node view opens the context-menu bindings at render.
    sessionId: 'local',
    useContextMenu: () => ({ getTriggerProps: () => ({}) }),
    resolveFilePath: (path) => path,
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
  assert.ok(patched.code.includes('useInteractionIds, dispatchInteraction, t, fileDrag, chamberFileApiBase,'), 'the prop is destructured out of the composed props')
  assert.ok(patched.code.includes('}), [chamberFileApiBase, directory, t, fileDrag, sessionId])'),
    'the memo depends on the base path (and keeps upstream\'s selectSessionDirectory dependency)')

  // Behaviour: evaluate the patched memo with a recording resolver; the base it
  // hands the resolver must be this entry's own file-API directory, and the
  // decoded path must stay unprefixed (the resolver owns the path, not the base).
  const baseFor = (code, deps, prop) => {
    const start = code.indexOf('  const fileImages = useMemo(() => ({')
    const end = code.indexOf(NL + '  ' + deps, start)
    assert.notEqual(start, -1)
    assert.notEqual(end, -1)
    const js = esbuild.transformSync(code.slice(start, end) + NL + '  ' + deps + NL + 'return fileImages', { loader: 'tsx' }).code
    const makeFileImages = new Function('useMemo', 'fileMediaUrl', 'resolveWorkspacePath', 'sessionFileAddress', 'document', 'directory', 't', 'chamberFileApiBase', 'fileDrag', 'sessionId', js)
    let seen
    const images = makeFileImages(
      (factory) => factory(),
      (base, path) => { seen = base + '|' + path; return seen },
      (_cwd, path) => path,
      (_sessionId, path) => path,
      { baseURI: 'http://127.0.0.1:30800/' },
      '/work',
      (key) => key,
      prop,
      {},
      'session-1',
    )
    assert.equal(images.resolve('/tmp/a.png'), seen)
    return seen
  }
  // Upstream fallback: absent OR empty base keeps the document itself.
  assert.equal(baseFor(patched.code, '}), [chamberFileApiBase, directory, t, fileDrag, sessionId])', undefined), 'http://127.0.0.1:30800/|/tmp/a.png')
  assert.equal(baseFor(patched.code, '}), [chamberFileApiBase, directory, t, fileDrag, sessionId])', ''), 'http://127.0.0.1:30800/|/tmp/a.png',
    'an empty chamber fact stays document-relative, not origin-root')
  // Chamber: the per-entry prefix becomes the resolver's directory.
  assert.equal(baseFor(patched.code, '}), [chamberFileApiBase, directory, t, fileDrag, sessionId])', '/api/i/local'), 'http://127.0.0.1:30800/api/i/local/|/tmp/a.png')
  // Negative control: the unpatched memo ignores the prop entirely.
  assert.equal(baseFor(source, '}), [directory, t, fileDrag, sessionId])', '/api/i/local'), 'http://127.0.0.1:30800/|/tmp/a.png')
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
      // The controller file does not declare PRESENTED_SUCCESS_HOLD_MS; the class is
      // the stable slice root (its imports are supplied as params below).
      from: 'export class PresentedOpenController',
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
  // 0.2.3-alpha.1: the binding follows the window only while a reference retains the
  // `conversation` facet; the constructor takes the retention snapshot and `start()`
  // installs the feed subscription (previously the constructor did both).
  const retained = {
    getSnapshot: () => true,
    subscribe: () => () => {},
  }
  new BoundConversation(feed, assembler, retained).start()
  // alpha.1's start() folds the retained window once (an initial flush); the scheduler
  // assertions below measure PUBLICATION-driven flushes only, so the baseline is cleared.
  flushes.length = 0
  frames.length = 0
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

/**
 * Context lines of a patched module, from an INDEPENDENT oracle (a plain line
 * diff of patched vs pinned source): `[patchedLine, upstreamLine]` for every line
 * the patch did NOT touch. Lines inside the rewritten anchor are excluded —
 * their mapping is approximate by construction (it lands inside the anchor).
 * @param {string} original
 * @param {string} patched
 * @returns {[number, number][]}
 */
function contextLinePairs(original, patched) {
  const { diffLines } = requireFromRenderer('diff')
  const pairs = []
  let originalLine = 0
  let patchedLine = 0
  for (const part of diffLines(original, patched)) {
    const count = part.count ?? part.value.split(NL).length - 1
    if (part.added) {
      patchedLine += count
      continue
    }
    if (part.removed) {
      originalLine += count
      continue
    }
    for (let index = 0; index < count; index += 1) {
      pairs.push([patchedLine + index, originalLine + index])
    }
    patchedLine += count
    originalLine += count
  }
  return pairs
}

test('every patched module carries a sourcemap that keeps context lines on their own upstream line', () => {
  // The transform rewrites text and moves lines; returning code without a map
  // makes rollup log SOURCEMAP_BROKEN and drop the module from every emitted
  // chunk map (design 09 §3.6). The map is generated by the patcher because
  // `map: null` ("the transformation did not move code") is false here.
  for (const patch of VENDOR_PATCHES) {
    const source = readFileSync(VENDOR + patch.vendorFile, 'utf8')
    const suffix = patch.idSuffixes.find((candidate) => candidate.startsWith('packages/')) ?? patch.idSuffixes[0]
    const id = '/x/vendor/harness-checkout/' + suffix
    const patched = applyVendorPatches(id, source)
    assert.notEqual(patched, undefined, patch.vendorFile + ' must be patched')
    assert.equal(patched.map.version, 3, patch.vendorFile + ': sourcemap version')
    assert.deepEqual(patched.map.sources, [id], patch.vendorFile + ': the map documents the module it rewrote')
    assert.deepEqual(patched.map.sourcesContent, [source], patch.vendorFile + ': sourcesContent is the PINNED source')
    assert.notEqual(patched.map.mappings, '', patch.vendorFile + ': a module without mappings is dropped from the bundle map')
    const decoded = decodeSourcemapMappings(patched.map.mappings)
    // Coverage: a line without a segment falls back to the bundle position.
    const patchedLines = patched.code.split(NL)
    for (const [line, text] of patchedLines.entries()) {
      if (text === '') continue
      assert.notEqual((decoded[line] ?? []).length, 0, patch.vendorFile + ': no mapping on line ' + (line + 1))
    }
    // Accuracy: every context line maps to the upstream line that still holds
    // its text — an insertion/deletion earlier in the file must not shift it.
    for (const [patchedLine, originalLine] of contextLinePairs(source, patched.code)) {
      const mapped = (decoded[patchedLine] ?? []).find((segment) => segment.length === 4)
      assert.notEqual(mapped, undefined, patch.vendorFile + ': no mapping on context line ' + (patchedLine + 1))
      assert.equal(mapped[2], originalLine,
        patch.vendorFile + ': context line ' + (patchedLine + 1) + ' must map to upstream line ' + (originalLine + 1))
    }
  }
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

test('the sourcemap decoder consumes the optional name field (minifier maps)', () => {
  // A fifth field is the name index (esbuild/rollup emit them for minified
  // bindings). Reading only four fields desynchronises every following segment
  // on that line — the artifact gate and the accuracy test would both go blind.
  assert.deepEqual(decodeSourcemapMappings('AAAAA,CACCC'), [[[0, 0, 0, 0], [1, 0, 1, 1]]])
  assert.deepEqual(decodeSourcemapMappings('AAAAA;;CAACC'), [[[0, 0, 0, 0]], [], [[1, 0, 0, 1]]])
})

test('the segment counter and the decoder agree (two readers, one wire format)', () => {
  // The artifact gate counts with countSourcemapSegments while the accuracy tests
  // decode with decodeSourcemapMappings. A one-sided fix (the optional name field
  // is easy to miss) would blind the gate without failing any map assertion.
  const countFromDecoded = (mappings) => {
    const counts = new Map()
    for (const segments of decodeSourcemapMappings(mappings)) {
      for (const segment of segments) {
        if (segment.length !== 4) continue
        counts.set(segment[1], (counts.get(segment[1]) ?? 0) + 1)
      }
    }
    return counts
  }
  const fixture = 'AAAAA,CACCC;;CAACC'
  assert.deepEqual(countSourcemapSegments(fixture), countFromDecoded(fixture))
  const patched = applyVendorPatches(IDS.workspaceNavigation, readFileSync(FILES.workspaceNavigation, 'utf8'))
  assert.deepEqual(
    countSourcemapSegments(patched.map.mappings),
    countFromDecoded(patched.map.mappings),
    'the emitted map must be counted and read identically',
  )
})

test('the artifact sourcemap gate rejects a patched module without mappings or content', () => {
  const patch = VENDOR_PATCHES[0]
  const suffix = patch.idSuffixes.find((candidate) => candidate.startsWith('packages/')) ?? patch.idSuffixes[0]
  const source = '../../vendor/harness-checkout/' + suffix
  const failuresFor = (maps) => checkVendorPatchSourcemaps(maps)
    .filter((failure) => failure.vendorFile === patch.vendorFile)
  assert.equal(failuresFor([{ sources: [source], sourcesContent: ['pinned'], segmentCounts: new Map([[0, 3]]) }]).length, 0,
    'a mapped source with content passes')
  assert.equal(failuresFor([{ sources: [source], sourcesContent: ['pinned'], segmentCounts: new Map() }]).length, 1,
    'a source that no mapping points at fails')
  assert.equal(failuresFor([{ sources: [source], sourcesContent: [''], segmentCounts: new Map([[0, 3]]) }]).length, 1,
    'a mapped source without content fails')
  assert.equal(failuresFor([{ sources: ['../../src/main.tsx'], sourcesContent: ['x'], segmentCounts: new Map([[0, 1]]) }]).length, 1,
    'a module absent from every chunk map fails')
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

test('live retire probes miss the current pin (a hit is C9 retire-candidate, not drift)', () => {
  // C9 evaluates retireCheck only AFTER an anchor has drifted, so a probe that
  // already matches the pinned source is invisible there: it is either a
  // tautology (a later anchor drift would be misreported as "upstream fixed it")
  // or the upstream fix arrived without moving our anchors. This fence turns red
  // exactly when C9's retire-candidate phase starts: retire the entry, move the
  // upstream shape into RETIRED_PATCHES and delete its artifact marker (I-7).
  let probed = 0
  for (const patch of VENDOR_PATCHES) {
    if (patch.retireCheck === undefined) continue
    probed += 1
    const verdict = probeVendorPatchRetirement(patch)
    assert.equal(
      verdict.ok,
      false,
      patch.vendorFile + ': retireCheck matches the CURRENT pin (' + verdict.detail + ') - C9 would report retire-candidate: retire the entry + its marker',
    )
    assert.ok(!verdict.detail.includes('unreadable'),
      patch.vendorFile + ': retireCheck could not read the pinned source, so this fence proves nothing (' + verdict.detail + ')')
  }
  assert.ok(probed > 0, 'the live fence must cover at least one retireCheck entry')
})

test('the viewport retire probe anchors to the onScroll handler, not a 900-char window (P2-3)', () => {
  // The pre-tightening regex (`/onScroll[\s\S]{0,900}?(?:rAF|flushScroll|queueMicrotask)/`)
  // started at ANY `onScroll` occurrence - including the addEventListener
  // registration - so unrelated frame code moving into that window turned a pure
  // anchor drift into a release-blocking retire-candidate with the wrong
  // remediation. These decoys PASS on the old shape and fail on the tightened one.
  const entry = VENDOR_PATCHES.find((patch) => patch.vendorFile === 'dsh-client-ui-chat/src/client/chat/use-chat-viewport.ts')
  assert.notEqual(entry, undefined, 'the use-chat-viewport entry exists')
  assert.notEqual(entry.retireCheck, undefined, 'the viewport entry declares a retireCheck')
  const patterns = entry.retireCheck.probes.flatMap((probe) => probe.match ?? [])
  const misses = (text) => patterns.every((pattern) => {
    pattern.lastIndex = 0
    return !pattern.test(text)
  })

  // Decoy 1: rAF right after the listener registration (inside the old window).
  assert.equal(misses(
    "    scroller.addEventListener('scroll', this.onScroll, { passive: true })\n"
    + '    const closingFrame = requestAnimationFrame(() => {})\n',
  ), true, 'unrelated frame code after the registration is not the upstream fix')

  // Decoy 2: the NEXT method coalesces while the handler still reads per event
  // (the old declaration + fixed window crossed the handler boundary).
  assert.equal(misses(
    '  private readonly onScroll = (event: Event): void => {\n'
    + '    const scroll = this.readScroll()\n'
    + '  }\n'
    + '  private readonly onScrollEnd = (event: Event): void => {\n'
    + '    const frame = requestAnimationFrame(() => {})\n'
    + '  }\n',
  ), true, 'the probe must stop at the handler boundary')

  // Positive control: the handler coalescing inside its own body IS the fix.
  for (const body of [
    '    this.scrollFrame = requestAnimationFrame(() => this.flushScroll())\n',
    '    queueMicrotask(() => this.flush())\n',
    '    this.flushScroll()\n',
  ]) {
    assert.equal(misses('  private readonly onScroll = (event: Event): void => {\n' + body + '  }\n'), false,
      'an upstream onScroll that coalesces in its own body must match')
  }
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
  // Retired at the 0.2.0-rc.1 pin: the running-row sweep moved into the shared
  // TextShimmer and the intrinsic check became engine-independent. A
  // retire-candidate moves here and deletes its patch + marker in the same change.
  assert.deepEqual(RETIRED_PATCHES.map((entry) => entry.vendorFile), [
    'dsh-client-ui-primitives/src/TextShimmer.module.css',
    'dsh-util-values/src/index.ts',
    // 0.2.3-alpha.1: upstream compiles theme CSS into bundle resources (plain CSS
    // imports) instead of appending per-shell <style data-plugin-css> tags, so the
    // page-global stylesheet singleton patch has nothing left to patch; the module
    // resources are installed by the per-renderer DocumentStyles, deduped by the
    // document-styles page-global entry.
    'dsh-client-ui-theme/src/client/styles.ts',
  ])
  for (const entry of RETIRED_PATCHES) {
    assert.equal(typeof entry.reason, 'string')
    assert.ok(entry.reason.length > 0)
    assert.equal(typeof entry.ensure, 'string')
  }
  // The retired command-row sweep entry must stay out of the registry.
  assert.equal(
    VENDOR_PATCHES.find((patch) => patch.vendorFile.includes('GenericCommandCard')),
    undefined,
    'the retired command-row sweep patch is deleted',
  )
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
        // 0.2.3-alpha.1: relative paths resolve from the Session's CURRENT directory.
        selectSessionDirectory: (state, id) => state.byId[id]?.cwd,
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
      // 0.2.2-alpha.3: the delivery card opens the context-menu bindings at render.
      useContextMenu: () => ({ getTriggerProps: () => ({}) }),
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
        // 0.2.3-alpha.1: current-directory selection + workspace-relative resolution.
        selectSessionDirectory: (state, id) => state.byId[id]?.cwd,
        resolveWorkspacePath: (_cwd, path) => path,
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
 * deliberate skips `chamber-covered.ts` documents in its header (hmr /
 * directory-picker-native) — page-own rows the composite replaces
 * plus host rows the shell drops on purpose. Without this subtraction the covered
 * check below would vouch for a package no module of which reaches the build — the
 * ui-sidebar-documentpreview case can enter through the dedupe list instead of an
 * instance bundle.
 */
const COVERED_BUT_NEVER_LOADED_IDS = Object.freeze([
  '@deepseek-ai/dsh-client-hmr',
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
])

test('every registered vendor patch targets a composite-covered package or dependency', () => {
  // A patch applies only to modules THIS build transforms. Registering one for an
  // instance-bundled row can never apply and fails buildEnd (the ui-sidebar-documentpreview case), so assert graph membership here for early
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
  // The boot kernel (dsh-client-web) owns the kernel-adopted rows the composite does not
  // import itself: modules and ui-renderer are value-imported there, so a patch on them is
  // transformed by this build just like a composite row.
  const kernelSource = readFileSync(new URL('../../dsh-client-web/src/boot.ts', import.meta.url), 'utf8')
  const loaded = [...new Set([...entryLoadedIds(entrySource), ...entryLoadedIds(kernelSource)])]
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
test('vendor patch counts stay in the registry, not hand-copied in README/docs', () => {
  // Counts drift by construction; the docs point at the single source instead of copying it.
  const docs = [
    '../README.md',
    '../../../docs/design/client/09-client-plugin-runtime-loading.md',
    '../../../docs/checklists/upgrade/upstream-touchpoints.md',
  ]
  for (const docPath of docs) {
    const text = readFileSync(fileURLToPath(new URL(docPath, import.meta.url)), 'utf8')
    assert.match(text, /vendor-patches\.mjs/u, 'the doc must point at the patch registry: ' + docPath)
    assert.doesNotMatch(text, /\d+\s*(?:补丁|文件)\s*\/\s*\d+\s*处?锚点/u,
      'a hand-copied patch count must stay out: ' + docPath)
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
    { vendorFile: 'dsh-client-ui-settings-account/src/client/index.ts', key: 'account', real: IDS.accountReal, loader: 'ts', route: '' },
    { vendorFile: 'dsh-client-ui-chat/src/client/chat/AssistantNodeView.tsx', key: 'nodeView', real: IDS.nodeView, loader: 'tsx', route: '' },
    { vendorFile: 'dsh-client-ui-chat/src/client/chat/ChatView.tsx', key: 'chatView', real: IDS.chatViewReal, loader: 'tsx', route: '' },
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
    { vendorFile: 'dsh-client-ui-attachment/src/client/drop-events.ts', key: 'attachmentDrop', real: IDS.attachmentDropReal, loader: 'ts', route: '' },
    { vendorFile: 'dsh-client-ui-attachment/src/client/ComposerAttachments.tsx', key: 'attachmentComponent', real: IDS.attachmentComponentReal, loader: 'tsx', route: '' },
    { vendorFile: 'dsh-client-ui-workspace/src/client/navigation.ts', key: 'workspaceNavigation', real: IDS.workspaceNavigation, loader: 'ts', route: '' },
    { vendorFile: 'dsh-client-ui-workspace/src/client/index.ts', key: 'workspaceIndex', real: IDS.workspaceIndex, loader: 'ts', route: '' },
    { vendorFile: 'dsh-client-ui-theme/src/client/icon-sprite.ts', key: 'iconSprite', real: IDS.iconSpriteReal, loader: 'ts', route: '' },
    { vendorFile: 'dsh-client-ui-renderer/src/client/styles/document-styles.ts', key: 'documentStyles', real: IDS.documentStylesReal, loader: 'ts', route: '' },
    { vendorFile: 'dsh-client-ui-chat/src/client/chat/use-chat-viewport.ts', key: 'chatViewport', real: IDS.chatViewportReal, loader: 'ts', route: '' },
  ]
  assert.deepEqual(
    [...new Set(sources.map((source) => source.vendorFile))].sort(),
    VENDOR_PATCHES.map((patch) => patch.vendorFile).sort(),
    'the bundle fixture must cover every registered vendor file exactly once',
  )
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
  // The layout marker has no vendorFile (the layout fork publishes the root prop). Give it the
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

/** Evaluate one installDocumentDropEvents body with fake document/window/Element/Node. */
function createDropHarness(code, { Element, Node, querySelector = () => null } = {}) {
  // Slice both module-level helpers: onDrop calls droppedDirectories too.
  const start = code.indexOf('function droppedDirectories')
  assert.notEqual(start, -1, 'installer slice start marker not found')
  const js = esbuild.transformSync(unexport(code.slice(start)), { loader: 'ts' }).code
  const listeners = new Map()
  const windowListeners = new Map()
  const documentElement = {}
  const body = {}
  const documentStub = {
    addEventListener: (type, listener) => {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener: () => {},
    querySelector,
    documentElement,
    body,
  }
  const windowStub = {
    addEventListener: (type, listener) => {
      const list = windowListeners.get(type) ?? []
      list.push(listener)
      windowListeners.set(type, list)
    },
    removeEventListener: () => {},
    innerWidth: 1024,
    innerHeight: 768,
  }
  // 0.2.2: the module imports FILE_DRAG_TOKEN_TYPE from dsh-util-file-drag; the slice keeps
  // the reference but not the import, so feed the literal the pinned util exports.
  const install = new Function('document', 'window', 'Element', 'Node', 'FILE_DRAG_TOKEN_TYPE', js + NL + 'return installDocumentDropEvents')(
    documentStub, windowStub, Element, Node, 'application/x-dsh-file',
  )
  return {
    install,
    dispatch: (type, event) => {
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
    dispatchWindow: (type, event) => {
      for (const listener of windowListeners.get(type) ?? []) listener(event)
    },
    documentElement,
    body,
  }
}

/** Single-installer convenience used by the intake-containment test. */
function installDropEvents(code, options) {
  const harness = createDropHarness(code, options)
  return { install: harness.install, drop: (event) => harness.dispatch('drop', event) }
}

test('the attachment drop intake is contained to the view its listener belongs to (executed patched installer)', () => {
  const source = readFileSync(FILES.attachmentDrop, 'utf8')
  const patched = applyVendorPatches(IDS.attachmentDropReal, source)
  assert.notEqual(patched, undefined)
  assert.deepEqual(patched.applied, ['dsh-client-ui-attachment/src/client/drop-events.ts'])

  class NodeStub {}
  class ElementStub extends NodeStub {}
  const insideNode = new ElementStub()
  const outsideNode = new ElementStub()
  const owner = { contains: (node) => node === insideNode }
  // 0.2.2 intakes only when the resolved file list is non-empty (an empty drop is a no-op),
  // so the fixture has to carry one file for the intake path to be observable.
  const dropEvent = (target) => ({
    dataTransfer: { types: ['Files'], files: [{ name: 'a.png' }], items: [] },
    target,
    preventDefault: () => {},
  })

  const run = (code) => {
    const calls = []
    const harness = installDropEvents(code, { Element: ElementStub, Node: NodeStub })
    harness.install(true, (files, directories) => { calls.push({ files, directories }) }, { current: 0 }, () => {}, () => undefined, () => owner)
    harness.drop(dropEvent(insideNode))
    harness.drop(dropEvent(outsideNode))
    return calls
  }

  assert.equal(run(patched.code).length, 1, 'the patched installer intakes only the drop inside its own view')
  assert.equal(run(source).length, 2, 'negative control: the unpatched installer intakes both (the fan-out)')

  // owner 解析失败时的兜底：文档里没有任何实例壳 = 官方布局 → 按上游放行；
  // 有壳却解析不到自己 = 挂载脱离等异常 → 拒绝（fail-closed）。
  const dropIn = (code, querySelector) => {
    const calls = []
    const harness = installDropEvents(code, { Element: ElementStub, Node: NodeStub, querySelector })
    harness.install(true, () => { calls.push(1) }, { current: 0 }, () => {}, () => undefined, () => null)
    harness.drop(dropEvent(insideNode))
    return calls.length
  }
  assert.equal(dropIn(patched.code, () => null), 1, 'a layout with no instance shells keeps upstream behaviour')
  assert.equal(dropIn(patched.code, () => ({})), 0, 'an unresolvable owner beside mounted shells is refused')
})

/** Evaluate the patched ComposerAttachments with hook stubs; capture its installer wiring and wrapper element. */
function renderAttachments(code) {
  const start = code.indexOf('export function ComposerAttachments({')
  assert.notEqual(start, -1, 'component slice start marker not found')
  const js = esbuild.transformSync(unexport(code.slice(start)), { loader: 'tsx' }).code
  const installed = []
  const refs = []
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children },
    }),
  }
  const useState = (initial) => [initial, () => {}]
  const useRef = (initial) => {
    const ref = { current: initial }
    refs.push(ref)
    return ref
  }
  const useMemo = (fn) => fn()
  const useCallback = (fn) => fn
  const useEffect = (fn) => { fn() }
  const installDocumentDropEvents = (...args) => { installed.push(args); return () => {} }
  const component = new Function(
    'React', 'useState', 'useRef', 'useMemo', 'useCallback', 'useEffect', 'installDocumentDropEvents',
    'css', 'DropOverlay', 'AttachmentRail', 'FileCard', 'ImageLightbox',
    'dropOverlayLabels', 'attachmentRailLabels', 'fileCardLabels', 'lightboxLabels', 'IconCloseFillRegular',
    js + NL + 'return ComposerAttachments',
  )(
    React, useState, useRef, useMemo, useCallback, useEffect, installDocumentDropEvents,
    {}, () => null, () => null, () => null, () => null, () => ({}), () => ({}), () => ({}), () => ({}), () => null,
  )
  const element = component({
    attachments: [], canAcceptDrop: true, onAddFiles: () => {}, onRemoveAttachment: () => {},
    uploads: {}, onRetryFile: () => {}, dropLimits: {}, t: (key) => key,
  })
  return { installed, refs, element }
}

test('the attachment component hands its own view resolver to the drop installer (executed patched component)', () => {
  const source = readFileSync(FILES.attachmentComponent, 'utf8')
  const patched = applyVendorPatches(IDS.attachmentComponentReal, source)
  assert.notEqual(patched, undefined)
  assert.deepEqual(patched.applied, ['dsh-client-ui-attachment/src/client/ComposerAttachments.tsx'])

  const { installed, refs, element } = renderAttachments(patched.code)
  assert.equal(installed.length, 1, 'the install effect runs once')
  assert.equal(installed[0].length, 6, 'the installer receives the file-drag resolver and then its owner resolver')
  const ownerView = installed[0][5]
  assert.equal(typeof ownerView, 'function')

  // The wrapper carries the ref (display:contents generates no box) and the resolver reads the view root from it.
  assert.equal(element.type, 'span')
  assert.equal(element.props.style.display, 'contents')
  assert.equal(element.props.ref, refs[1], 'the wrapper ref is the one the resolver reads')

  const sentinel = {}
  let selector = null
  refs[1].current = { closest: (value) => { selector = value; return sentinel } }
  assert.equal(ownerView(), sentinel)
  assert.equal(selector, '[data-instance]')
  refs[1].current = null
  assert.equal(ownerView(), null, 'a detached mount resolves to null (the installer then fails closed)')

  // Negative control: the unpatched component never passes a resolver at all.
  const raw = renderAttachments(source)
  assert.equal(raw.installed[0].length, 5, 'the unpatched installer call has no owner argument')
})

test('a hidden shell cannot veto or overlay the visible shell drag (executed patched handlers)', () => {
  const source = readFileSync(FILES.attachmentDrop, 'utf8')
  const patched = applyVendorPatches(IDS.attachmentDropReal, source)
  assert.notEqual(patched, undefined)

  class NodeStub {}
  class ElementStub extends NodeStub {}
  const insideNode = new ElementStub()
  const visibleOwner = { contains: (node) => node === insideNode }
  const hiddenOwner = { contains: () => false }
  const run = (code) => {
    const harness = createDropHarness(code, { Element: ElementStub, Node: NodeStub })
    const active = []
    harness.install(true, () => {}, { current: 0 }, (value) => { active.push(['visible', value]) }, () => undefined, () => visibleOwner)
    harness.install(false, () => {}, { current: 0 }, (value) => { active.push(['hidden', value]) }, () => undefined, () => hiddenOwner)
    const event = {
      dataTransfer: { types: ['Files'], files: [], items: [], dropEffect: 'unset' },
      target: insideNode,
      clientX: 10,
      clientY: 10,
      preventDefault: () => {},
    }
    harness.dispatch('dragover', event)
    harness.dispatch('dragenter', event)
    harness.dispatch('dragleave', event)
    return { event, active }
  }

  const patchedRun = run(patched.code)
  assert.equal(patchedRun.event.dataTransfer.dropEffect, 'copy', 'the visible shell keeps the copy effect')
  assert.deepEqual(patchedRun.active, [['visible', true], ['visible', false]], 'only the visible shell reacts to the whole drag sequence (enter/leave)')

  // Negative control: upstream lets the hidden (false, later-registered) shell veto and overlay.
  const rawRun = run(source)
  assert.equal(rawRun.event.dataTransfer.dropEffect, 'none', 'negative control: the hidden shell vetoes')
  assert.deepEqual(rawRun.active.filter(([who]) => who === 'hidden'), [['hidden', true], ['hidden', false]], 'negative control: the hidden shell reacts too')
})

test('the upstream viewport-left reset and dragend still clear the overlay (escape hatches)', () => {
  const source = readFileSync(FILES.attachmentDrop, 'utf8')
  const patched = applyVendorPatches(IDS.attachmentDropReal, source)
  assert.notEqual(patched, undefined)

  class NodeStub {}
  class ElementStub extends NodeStub {}
  const insideNode = new ElementStub()
  const owner = { contains: (node) => node === insideNode }
  const harness = createDropHarness(patched.code, { Element: ElementStub, Node: NodeStub })
  const active = []
  harness.install(true, () => {}, { current: 0 }, (value) => { active.push(value) }, () => undefined, () => owner)

  harness.dispatch('dragenter', { dataTransfer: { types: ['Files'] }, target: insideNode, preventDefault: () => {} })
  assert.deepEqual(active, [true])

  // Target html/body + pointer outside the viewport: not owned by any shell, but the drag session left
  // the window, so every shell must drop its own overlay (OS drags do not guarantee a page dragend).
  harness.dispatch('dragleave', { dataTransfer: { types: ['Files'] }, target: harness.documentElement, clientX: -1, clientY: 5, preventDefault: () => {} })
  assert.deepEqual(active, [true, false], 'leaving the viewport clears the overlay')

  harness.dispatch('dragenter', { dataTransfer: { types: ['Files'] }, target: insideNode, preventDefault: () => {} })
  harness.dispatchWindow('dragend', {})
  assert.deepEqual(active, [true, false, true, false], 'dragend still resets')
})

/* ------------------------------------------------------------------------- *
 * ui-theme icon-sprite page-global singleton. The stylesheet half of this
 * section RETIRED at 0.2.3-alpha.1: upstream now compiles theme CSS into bundle
 * resources (plain CSS imports), so there is no per-shell ui-theme <style>
 * installer to dedupe (RETIRED_PATCHES owns the fence); the module resources are
 * installed by the per-renderer DocumentStyles, deduped by the document-styles
 * page-global entry below.
 * ------------------------------------------------------------------------- */

/** Cordis ctx surface these modules use: inline effects + captured event listeners. */
function createThemeCtx() {
  const cleanups = []
  const listeners = new Map()
  return {
    effect: (fn) => {
      const cleanup = fn()
      cleanups.push(cleanup)
      return cleanup
    },
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    emit: (event, payload) => {
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
    dispose: () => {
      while (cleanups.length > 0) cleanups.pop()()
    },
  }
}

/** One fake SVG page (body shared by N module instances) for the sprite tests. */
function createSpritePage() {
  const body = []
  const createdSymbols = []
  const makeNode = (kind, markup) => {
    const node = {
      kind,
      markup,
      id: '',
      attrs: {},
      children: [],
      parent: null,
      removed: false,
      get isConnected() {
        return body.includes(this)
      },
      style: { cssText: '' },
      setAttribute(name, value) {
        this.attrs[name] = value
      },
      append(...nodes) {
        for (const child of nodes) {
          child.parent = this
          this.children.push(child)
        }
      },
      replaceWith(next) {
        const index = this.parent === null ? -1 : this.parent.children.indexOf(this)
        if (index !== -1) this.parent.children[index] = next
        next.parent = this.parent
        this.removed = true
      },
      remove() {
        const index = this.parent === null ? -1 : this.parent.children.indexOf(this)
        if (index !== -1) this.parent.children.splice(index, 1)
        this.removed = true
      },
    }
    if (kind === 'symbol') createdSymbols.push(node)
    return node
  }
  const documentStub = {
    createElementNS: (_namespace, kind) => makeNode(kind),
    importNode: (node) => node,
    body: {
      // Real DOM prepend moves an existing child instead of duplicating it.
      prepend: (node) => {
        const existing = body.indexOf(node)
        if (existing !== -1) body.splice(existing, 1)
        node.parent = { children: body }
        body.unshift(node)
      },
    },
  }
  class FakeDomParser {
    parseFromString(markup) {
      return { documentElement: { attributes: [], childNodes: [{ kind: 'path', markup }] } }
    }
  }
  return { document: documentStub, DOMParser: FakeDomParser, body, createdSymbols }
}

/** Evaluate the patched (or upstream) sprite module against one fake page. */
function loadIconSprite(code, page, iconSymbols) {
  const start = code.indexOf('const SVG_NS =')
  assert.notEqual(start, -1, 'icon sprite slice start marker not found')
  const js = esbuild.transformSync(unexport(code.slice(start)), { loader: 'ts' }).code
  return new Function('document', 'DOMParser', 'ICON_SYMBOLS', js + NL + 'return installIconSprite')(
    page.document, page.DOMParser, iconSymbols,
  )
}

test('the icon sprite is a page-global singleton with a shared markup map (executed patched installer)', () => {
  const source = readFileSync(FILES.iconSprite, 'utf8')
  const patched = applyVendorPatches(IDS.iconSpriteReal, source)
  assert.notEqual(patched, undefined)
  assert.deepEqual(patched.applied, ['dsh-client-ui-theme/src/client/icon-sprite.ts'])
  assert.ok(patched.code.includes("Symbol.for('dsh-chamber:page-icon-sprite')"),
    'the sprite registry is keyed on a page-global symbol')

  const iconSymbols = { alpha: '<svg data-icon="alpha"/>', beta: '<svg data-icon="beta"/>' }
  const page = createSpritePage()
  const ctxA = createThemeCtx()
  const ctxB = createThemeCtx()
  const installA = loadIconSprite(patched.code, page, iconSymbols)
  const installB = loadIconSprite(patched.code, page, iconSymbols)
  installA(ctxA)
  assert.equal(page.body.length, 1, 'one shell prepends one sprite')
  const sprite = page.body[0]
  assert.equal(sprite.attrs['data-dsh-icon-sprite'], '')
  assert.equal(sprite.attrs['aria-hidden'], 'true')
  assert.equal(sprite.style.cssText, 'position: absolute; width: 0; height: 0; overflow: hidden')
  assert.deepEqual(sprite.children.map((symbol) => symbol.id), ['alpha', 'beta'])
  assert.equal(page.createdSymbols.length, 2, 'one <symbol> per icon id')
  installB(ctxB)
  assert.equal(page.body.length, 1, 'a second bundle instance reuses the same sprite')
  assert.deepEqual(sprite.children.map((symbol) => symbol.id), ['alpha', 'beta'],
    'an identical theme does not rebuild symbols')
  assert.equal(page.createdSymbols.length, 2, 'the shared markup map skips the second shell')

  // theme/change updates the ONE shared sprite; only the changed icon re-parses.
  ctxA.emit('theme/change', { active: { icons: { alpha: '<svg data-icon="alpha-2"/>' } } })
  const alpha = sprite.children.find((symbol) => symbol.id === 'alpha')
  assert.equal(alpha.children[0].markup, '<svg data-icon="alpha-2"/>',
    'the shared sprite follows the last theme/change')
  assert.equal(page.createdSymbols.length, 3, 'only the changed symbol is rebuilt')
  assert.equal(sprite.children.length, 2, 'the sprite keeps one symbol per icon id')

  // refcount: a surviving owner keeps the sprite, the last owner removes it.
  ctxB.dispose()
  assert.equal(page.body.length, 1, 'a surviving owner keeps the shared sprite')
  ctxA.dispose()
  assert.equal(page.body.length, 0, 'the last owner removes the shared sprite')

  // An official-layout / single-instance page must keep the upstream DOM exactly.
  const patchedPage = createSpritePage()
  loadIconSprite(patched.code, patchedPage, iconSymbols)(createThemeCtx())
  const upstreamPage = createSpritePage()
  loadIconSprite(source, upstreamPage, iconSymbols)(createThemeCtx())
  const describe = (spriteElement) => ({
    attrs: spriteElement.attrs,
    cssText: spriteElement.style.cssText,
    ids: spriteElement.children.map((symbol) => symbol.id),
  })
  assert.equal(upstreamPage.body.length, 1)
  assert.deepEqual(describe(patchedPage.body[0]), describe(upstreamPage.body[0]),
    'a single-instance page keeps the upstream sprite DOM')

  // Negative control: upstream prepends one sprite per bundle instance and re-renders every symbol.
  const rawPage = createSpritePage()
  loadIconSprite(source, rawPage, iconSymbols)(createThemeCtx())
  loadIconSprite(source, rawPage, iconSymbols)(createThemeCtx())
  assert.equal(rawPage.body.length, 2, 'negative control: one sprite per bundle instance')
  assert.equal(rawPage.createdSymbols.length, 4, 'negative control: every symbol rendered twice')
})

test('a detached shared sprite is re-attached by the next acquire (external all-document sweep)', () => {
  const source = readFileSync(FILES.iconSprite, 'utf8')
  const patched = applyVendorPatches(IDS.iconSpriteReal, source)
  assert.notEqual(patched, undefined)
  const iconSymbols = { alpha: '<svg data-icon="alpha"/>' }
  const page = createSpritePage()
  const ctxA = createThemeCtx()
  const install = loadIconSprite(patched.code, page, iconSymbols)
  install(ctxA)
  assert.equal(page.body.length, 1)
  const sprite = page.body[0]
  // Simulate an external all-document sweep: the sprite is gone, the owner still lives.
  page.body.length = 0
  assert.equal(sprite.isConnected, false)
  const ctxB = createThemeCtx()
  install(ctxB)
  assert.equal(page.body.length, 1, 'a new owner re-attaches the shared sprite')
  assert.equal(page.body[0], sprite, 'the same shared sprite node is re-used')
  ctxB.dispose()
  assert.equal(page.body.length, 1)
  ctxA.dispose()
  assert.equal(page.body.length, 0)
})

/* ------------------------------------------------------------------------- *
 * ui-chat scroll geometry: one read per frame (use-chat-viewport)
 * ------------------------------------------------------------------------- */

/** Fake scrollport with geometry read counters; frames are drained manually. */
function createViewportHarness(code, { animate = true } = {}) {
  const start = code.indexOf('const READING_INTENTS')
  const end = code.indexOf('/**\n * Bind viewport resource ownership')
  assert.notEqual(start, -1, 'chat viewport slice start marker not found')
  assert.notEqual(end, -1, 'chat viewport slice end marker not found')
  const js = esbuild.transformSync(unexport(code.slice(start, end)), { loader: 'ts' }).code

  const geometry = { top: 0, height: 600, content: 2000 }
  const reads = { top: 0, height: 0, content: 0 }
  const scroller = {
    style: {},
    addEventListener: () => {},
    removeEventListener: () => {},
    ownerDocument: { addEventListener: () => {}, removeEventListener: () => {} },
    querySelector: () => null,
    closest: () => scroller,
  }
  Object.defineProperties(scroller, {
    scrollTop: {
      get: () => {
        reads.top += 1
        return geometry.top
      },
      set: (value) => {
        geometry.top = value
      },
    },
    clientHeight: {
      get: () => {
        reads.height += 1
        return geometry.height
      },
    },
    scrollHeight: {
      get: () => {
        reads.content += 1
        return geometry.content
      },
    },
  })
  const list = { closest: () => scroller, querySelector: () => null, contains: () => true, style: {} }
  const column = { querySelector: () => null, children: [] }
  const frames = []
  const dispatches = []
  let nextFrame = 0
  const requestFrame = animate
    ? (callback) => {
      nextFrame += 1
      frames.push({ id: nextFrame, callback })
      return nextFrame
    }
    : undefined
  const cancelFrame = (id) => {
    for (const frame of frames) if (frame.id === id) frame.callback = null
  }
  const scrollMetricsStub = (element) => {
    const height = element.clientHeight
    return { top: element.scrollTop, height, floor: Math.max(0, element.scrollHeight - height) }
  }
  const createFlowMotion = () => ({
    clear: () => {}, foldActive: () => false, inputActive: () => false, active: () => false,
  })
  class ScrollFollowStub { static forElement() { return undefined } }
  const ChatViewport = new Function(
    'scrollMetrics', 'ScrollFollow', 'createFlowMotion', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver',
    js + NL + 'return ChatViewport',
  )(scrollMetricsStub, ScrollFollowStub, createFlowMotion, requestFrame, animate ? cancelFrame : undefined, undefined)
  const viewport = new ChatViewport()
  viewport.attach(list, column)
  viewport.connect({
    scroll: (scroll) => { dispatches.push({ scroll }) },
    scrollEnd: (outer) => { dispatches.push({ scrollEnd: outer }) },
    resize: () => { dispatches.push({ resize: true }) },
    interact: () => {},
  })
  const flushFrame = () => {
    const pending = frames.splice(0)
    for (const frame of pending) if (frame.callback !== null) frame.callback()
  }
  return { viewport, geometry, reads, frames, dispatches, flushFrame, scroller }
}

test('chat scroll geometry is read once per frame instead of once per scroll event (executed patched handler)', () => {
  const source = readFileSync(FILES.chatViewport, 'utf8')
  const patched = applyVendorPatches(IDS.chatViewportReal, source)
  assert.notEqual(patched, undefined)
  assert.deepEqual(patched.applied, ['dsh-client-ui-chat/src/client/chat/use-chat-viewport.ts'])
  assert.ok(patched.code.includes('private flushScroll(): void'), 'the coalesced delivery is its own method')
  assert.ok(patched.code.includes('this.scrollFrame === null'), 'the handler owns a frame slot')

  const harness = createViewportHarness(patched.code)
  harness.geometry.top = 120
  harness.viewport.onScroll({ target: harness.scroller })
  harness.viewport.onScroll({ target: harness.scroller })
  assert.equal(harness.frames.length, 1, 'two scroll events share one frame')
  assert.equal(harness.dispatches.length, 0, 'the patched handler does not dispatch synchronously')
  assert.deepEqual({ ...harness.reads }, { top: 0, height: 0, content: 0 },
    'no synchronous geometry read runs in the scroll events')
  harness.flushFrame()
  assert.equal(harness.dispatches.length, 1, 'one coalesced delivery per frame')
  assert.equal(harness.dispatches[0].scroll.metrics.top, 120)
  assert.equal(harness.dispatches[0].scroll.movedByReader, true, 'movement attribution is the same readScroll result')
  assert.deepEqual({ ...harness.reads }, { top: 1, height: 1, content: 1 }, 'the frame pays exactly one geometry read')

  // Negative control: upstream reads and dispatches per scroll event (the measured forced layout).
  const raw = createViewportHarness(source)
  raw.geometry.top = 120
  raw.viewport.onScroll({ target: raw.scroller })
  raw.viewport.onScroll({ target: raw.scroller })
  assert.equal(raw.dispatches.length, 2, 'negative control: upstream dispatches per event')
  assert.deepEqual({ ...raw.reads }, { top: 2, height: 2, content: 2 }, 'negative control: upstream reads geometry per event')
})

test('the coalesced viewport keeps landing suppression, scrollend ordering and detach/cancel (executed patched handlers)', () => {
  const source = readFileSync(FILES.chatViewport, 'utf8')
  const patched = applyVendorPatches(IDS.chatViewportReal, source)
  assert.notEqual(patched, undefined)

  // 1) Self-authored landing echo: a scroll event at the written position must not redeliver.
  const echo = createViewportHarness(patched.code)
  echo.viewport.observation = { top: 150, landing: { metrics: { top: 150, floor: 1400, height: 600 }, position: null, turn: null } }
  echo.geometry.top = 150
  echo.viewport.onScroll({ target: echo.scroller })
  echo.flushFrame()
  assert.deepEqual(echo.dispatches, [], 'the landing echo is still suppressed')

  // 2) scrollend flushes the coalesced delivery BEFORE the settle (the unbatched order).
  const end = createViewportHarness(patched.code)
  end.geometry.top = 200
  end.viewport.onScroll({ target: end.scroller })
  assert.equal(end.dispatches.length, 0, 'the delivery waits for its frame')
  end.viewport.onScrollEnd({ target: end.scroller })
  assert.deepEqual(end.dispatches.map((entry) => Object.keys(entry)[0]), ['scroll', 'scrollEnd'],
    'the scroll delivery precedes scrollend')
  assert.equal(end.dispatches[0].scroll.metrics.top, 200)
  end.flushFrame()
  assert.equal(end.dispatches.length, 2, 'the flushed frame is cancelled, not delivered twice')

  // 3) The dispatched payload is the same readScroll result upstream computes for that geometry.
  const current = createViewportHarness(patched.code)
  const reference = createViewportHarness(source)
  current.geometry.top = 320
  reference.geometry.top = 320
  current.viewport.onScroll({ target: current.scroller })
  current.flushFrame()
  assert.deepEqual(current.dispatches[0].scroll, reference.viewport.readScroll(),
    'same metrics + movedByReader attribution as the upstream read')

  // 4) A pending frame never runs after detach.
  const detached = createViewportHarness(patched.code)
  detached.viewport.onScroll({ target: detached.scroller })
  assert.equal(detached.frames.length, 1)
  detached.viewport.detach()
  detached.flushFrame()
  assert.deepEqual(detached.dispatches, [], 'a coalesced delivery is cancelled by detach')

  // 5) No requestAnimationFrame (SSR/test environment): flush synchronously like upstream.
  const synchronous = createViewportHarness(patched.code, { animate: false })
  synchronous.geometry.top = 64
  synchronous.viewport.onScroll({ target: synchronous.scroller })
  assert.equal(synchronous.dispatches.length, 1, 'the fallback stays synchronous')
  assert.equal(synchronous.dispatches[0].scroll.metrics.top, 64)
})

/* ------------------------------------------------------------------------- *
 * ui-renderer DocumentStyles page-global singleton (N-ctx). Upstream alpha.1
 * installs module styles from a PER-RENDERER DocumentStyles instance; the
 * chamber page mounts one renderer per instance shell against ONE shared module
 * table, so N shells install N copies of every style[data-plugin][data-path]
 * node into document.head. The registered patch publishes each
 * (container, plugin, path) sheet once per document behind Symbol.for and
 * refcounts it. This test EXECUTES the patched vendor module against a fake
 * DOM/module table, and runs the same scenario against the UNPATCHED source as
 * the negative control (duplicate nodes = the defect the patch removes).
 * ------------------------------------------------------------------------- */

/** Minimal document/element model for DocumentStyles install, ordering and removal. */
function createFakeDocument() {
  const makeElement = (tagName) => ({
    tagName,
    attributes: {},
    textContent: '',
    parent: undefined,
    isConnected: false,
    setAttribute(name, value) { this.attributes[name] = value },
    remove() {
      const list = this.parent?.childNodes
      if (list === undefined) return
      const index = list.indexOf(this)
      if (index !== -1) list.splice(index, 1)
      this.parent = undefined
      this.isConnected = false
    },
    get nextSibling() {
      const list = this.parent?.childNodes
      if (list === undefined) return null
      const index = list.indexOf(this)
      return index === -1 ? null : (list[index + 1] ?? null)
    },
  })
  const document = { createElement: makeElement }
  const container = {
    ownerDocument: document,
    childNodes: [],
    append(node) { this.insertBefore(node, null) },
    insertBefore(node, anchor) {
      if (node.isConnected) node.remove()
      const list = this.childNodes
      const index = anchor === null ? list.length : list.indexOf(anchor)
      list.splice(index === -1 ? list.length : index, 0, node)
      node.parent = this
      node.isConnected = true
      return node
    },
  }
  document.head = container
  return document
}

/** Module table seam DocumentStyles consumes, over fixed client-module records. */
function createFakeModules(records) {
  return {
    activeRecords: () => records,
    subscribeModules: () => () => {},
    resolveAsset: (reference) => reference,
  }
}

/** One client-module record whose metadata produces module stylesheets. */
function styleRecord(ownerId, path, css) {
  return {
    id: ownerId,
    ownerId,
    exports: {},
    edges: new Set(),
    meta: () => ({ stylesheets: { [path]: { text: () => css } } }),
  }
}

/** Load transformed module source as a fresh ESM module. */
async function importTransformedDocumentStyles(code) {
  const dir = mkdtempSync(join(tmpdir(), 'document-styles-dedupe-'))
  const file = join(dir, 'document-styles.mjs')
  writeFileSync(file, esbuild.transformSync(code, { loader: 'ts', format: 'esm' }).code)
  return import(pathToFileURL(file).href + '?' + Date.now())
}

/**
 * Mount two renderers over one page and report the installed sheet nodes.
 * @param {new (container: unknown, modules: unknown) => { mount(): void, dispose(): void }} DocumentStyles
 */
async function mountTwoRenderers(DocumentStyles) {
  const document = createFakeDocument()
  const modules = createFakeModules([
    styleRecord('@scope/one', 'one.css', '.one{}'),
    styleRecord('@scope/two', 'two.css', '.two{}'),
  ])
  const first = new DocumentStyles(document.head, modules)
  const second = new DocumentStyles(document.head, modules)
  first.mount()
  second.mount()
  const installed = document.head.childNodes.map((node) => node.attributes['data-plugin'] + '/' + node.attributes['data-path'])
  first.dispose()
  const afterFirstDispose = document.head.childNodes.length
  second.dispose()
  const afterBothDispose = document.head.childNodes.length
  return { installed, afterFirstDispose, afterBothDispose }
}

test('the ui-renderer DocumentStyles patch installs each module sheet once per page (N shells, one copy)', async () => {
  const source = readFileSync(VENDOR + 'dsh-client-ui-renderer/src/client/styles/document-styles.ts', 'utf8')
  const patched = applyVendorPatches(
    '/x/vendor/harness-checkout/packages/client/ui-renderer/src/client/styles/document-styles.ts',
    source,
  )
  assert.notEqual(patched, undefined, 'the document-styles module must be patched')
  assert.deepEqual(patched.applied, ['dsh-client-ui-renderer/src/client/styles/document-styles.ts'])
  assert.ok(patched.code.includes("Symbol.for('dsh-chamber:page-module-styles')"),
    'the page-level registry is keyed on the document behind Symbol.for')

  const { DocumentStyles } = await importTransformedDocumentStyles(patched.code)
  const deduped = await mountTwoRenderers(DocumentStyles)
  assert.deepEqual(deduped.installed.slice().sort(), ['@scope/one/one.css', '@scope/two/two.css'],
    'two renderers over one page install ONE sheet per (plugin, path)')
  assert.equal(deduped.afterFirstDispose, 2,
    'the surviving shell keeps the shared sheets after the first owner disposes')
  assert.equal(deduped.afterBothDispose, 0,
    'the last owner removes the shared sheets: the upstream single-page DOM on a single-shell page')

  // Negative control: the same scenario on the UNPATCHED pinned source duplicates every sheet.
  const { DocumentStyles: UpstreamDocumentStyles } = await importTransformedDocumentStyles(source)
  const naive = await mountTwoRenderers(UpstreamDocumentStyles)
  assert.equal(naive.installed.length, 4,
    'unpatched per-renderer installers duplicate every sheet (2 shells x 2 paths) - the defect')
  assert.equal(naive.afterFirstDispose, 2)
  assert.equal(naive.afterBothDispose, 0)
})

/** Module table seam whose record set can change, mirroring one module publish. */
function createUpdatableModules(records) {
  let current = records
  const listeners = new Set()
  return {
    activeRecords: () => current,
    subscribeModules: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    resolveAsset: (reference) => reference,
    update(next) {
      current = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Sorted "plugin/path" view of the installed page sheets (order-neutral assertions). */
function installedSheetKeys(document) {
  return document.head.childNodes
    .map((node) => node.attributes['data-plugin'] + '/' + node.attributes['data-path'])
    .sort()
}

/** Load the patched module under test from the registered patch + the pinned source. */
async function loadPatchedDocumentStyles() {
  const source = readFileSync(VENDOR + 'dsh-client-ui-renderer/src/client/styles/document-styles.ts', 'utf8')
  const patched = applyVendorPatches(IDS.documentStylesReal, source)
  assert.notEqual(patched, undefined, 'the document-styles module must be patched')
  assert.deepEqual(patched.applied, ['dsh-client-ui-renderer/src/client/styles/document-styles.ts'])
  const { DocumentStyles } = await importTransformedDocumentStyles(patched.code)
  return { DocumentStyles }
}

test('DocumentStyles refresh releases one owner share and re-acquiring a live key reuses the node', async () => {
  const { DocumentStyles } = await loadPatchedDocumentStyles()
  const document = createFakeDocument()
  // Two shells over ONE page with independent module-table views: the page-global
  // registry is keyed by (container, plugin, path), never by the module system.
  const firstModules = createUpdatableModules([styleRecord('@scope/x', 'x.css', '.x{}')])
  const secondModules = createUpdatableModules([styleRecord('@scope/x', 'x.css', '.x{}')])
  const first = new DocumentStyles(document.head, firstModules)
  const second = new DocumentStyles(document.head, secondModules)
  first.mount()
  second.mount()
  assert.equal(document.head.childNodes.length, 1, 'both shells share one sheet')
  const shared = document.head.childNodes[0]

  // The FIRST owner refresh drops the key: it releases only its own ref; the sheet stays.
  firstModules.update([])
  assert.equal(document.head.childNodes.length, 1, 'the surviving shell keeps the sheet (refcount 2 -> 1)')
  assert.equal(document.head.childNodes[0], shared, 'the shared node is kept, never re-created')
  assert.equal(shared.isConnected, true)

  // Same key re-acquire while another owner still holds it returns THAT node (no second copy).
  firstModules.update([styleRecord('@scope/x', 'x.css', '.x{}')])
  assert.equal(document.head.childNodes.length, 1, 're-acquiring a live key must not install a second copy')
  assert.equal(document.head.childNodes[0], shared, 'the re-acquire reuses the live shared node')

  // The other owner releases (refcount 2 -> 1): the first owner's re-acquire keeps it.
  secondModules.update([])
  assert.equal(document.head.childNodes.length, 1, 'one owner still holds the sheet')
  // The last owner's refresh removes the sheet.
  firstModules.update([])
  assert.equal(document.head.childNodes.length, 0, 'the last release removes the shared sheet')
  first.dispose()
  second.dispose()
})

test('a new owner re-attaches shared sheets detached by an external sweep (acquire path)', async () => {
  const { DocumentStyles } = await loadPatchedDocumentStyles()
  const document = createFakeDocument()
  const modules = createFakeModules([
    styleRecord('@scope/one', 'one.css', '.one{}'),
    styleRecord('@scope/two', 'two.css', '.two{}'),
  ])
  const first = new DocumentStyles(document.head, modules)
  const second = new DocumentStyles(document.head, modules)
  first.mount()
  second.mount()
  const shared = [...document.head.childNodes]
  assert.deepEqual(installedSheetKeys(document), ['@scope/one/one.css', '@scope/two/two.css'])

  // An external all-document sweep (removeOwnedStyles-style) detaches every sheet.
  for (const node of [...document.head.childNodes]) node.remove()
  assert.equal(document.head.childNodes.length, 0, 'the sweep detaches every sheet')

  // A third shell mounts: acquire must re-publish the SAME shared nodes, exactly one copy per key.
  const third = new DocumentStyles(document.head, modules)
  third.mount()
  assert.deepEqual(installedSheetKeys(document), ['@scope/one/one.css', '@scope/two/two.css'])
  assert.equal(document.head.childNodes.length, 2, 'the mount re-attaches, never duplicates')
  for (const node of document.head.childNodes) assert.equal(node.isConnected, true, 'a new owner claims connected sheets')
  for (const node of shared) assert.ok(document.head.childNodes.includes(node), 'the re-attached node is the shared one')

  // refcount: the new owner's dispose keeps both sheets for the still-mounted shells.
  third.dispose()
  assert.equal(document.head.childNodes.length, 2, 'two owners still hold the shared sheets')
  first.dispose()
  assert.equal(document.head.childNodes.length, 2, 'one owner still holds the shared sheets')
  second.dispose()
  assert.equal(document.head.childNodes.length, 0, 'the last owner removes the shared sheets')
})

test('an owner refresh re-attaches detached sheets and a full withdraw/re-add reinstalls one copy', async () => {
  const { DocumentStyles } = await loadPatchedDocumentStyles()
  const document = createFakeDocument()
  const modules = createUpdatableModules([
    styleRecord('@scope/one', 'one.css', '.one{}'),
    styleRecord('@scope/two', 'two.css', '.two{}'),
  ])
  const first = new DocumentStyles(document.head, modules)
  const second = new DocumentStyles(document.head, modules)
  first.mount()
  second.mount()
  const shared = [...document.head.childNodes]

  // External sweep detaches the shared sheets; a module publish runs BOTH owners'
  // refresh, whose ordering pass must re-attach the SAME shared nodes.
  for (const node of [...document.head.childNodes]) node.remove()
  modules.update([
    styleRecord('@scope/one', 'one.css', '.one{}'),
    styleRecord('@scope/two', 'two.css', '.two{}'),
  ])
  assert.deepEqual(installedSheetKeys(document), ['@scope/one/one.css', '@scope/two/two.css'])
  for (const node of shared) assert.ok(document.head.childNodes.includes(node), 'refresh re-attaches the shared node')

  // Withdraw every key: both owners release through refresh; the last release removes the sheets.
  modules.update([])
  assert.equal(document.head.childNodes.length, 0, 'refresh release removes the sheets after the last owner')

  // Re-add the same keys: a fresh single copy per key (the registry entry died with its node).
  modules.update([
    styleRecord('@scope/one', 'one.css', '.one{}'),
    styleRecord('@scope/two', 'two.css', '.two{}'),
  ])
  assert.deepEqual(installedSheetKeys(document), ['@scope/one/one.css', '@scope/two/two.css'])
  assert.equal(document.head.childNodes.length, 2, 'a re-added key installs exactly one copy')

  first.dispose()
  assert.equal(document.head.childNodes.length, 2, 'the surviving shell keeps the re-added sheets')
  second.dispose()
  assert.equal(document.head.childNodes.length, 0)
})
