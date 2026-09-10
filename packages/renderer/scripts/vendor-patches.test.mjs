/**
 * Vendor patch registry tests (design 09 §3.6).
 *
 * These run against the REAL pinned vendor source, so they fail the moment an
 * upstream anchor drifts (the same condition C9 of
 * verify-upstream-touchpoints.mjs reports before a pin bump). The behaviour
 * test evaluates the PATCHED function, proving the chamber URL shape and the
 * upstream fallback without a browser.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyVendorPatches, checkVendorPatchSources, VENDOR_PATCHES } from './vendor-patches.mjs'

// esbuild is resolved through the renderer's vite tree (the build scripts do
// the same) so the patched TypeScript function can be evaluated as JS.
const requireFromRenderer = createRequire(new URL('../package.json', import.meta.url))
const esbuild = await import(
  pathToFileURL(createRequire(requireFromRenderer.resolve('vite')).resolve('esbuild')).href
)

const VENDOR = fileURLToPath(new URL('../../../vendor/harness-packages/@deepseek-ai/', import.meta.url))
const MARKDOWN = `${VENDOR}dsh-client-ui-chat/src/client/chat/AssistantMarkdown.tsx`
const NODE_VIEW = `${VENDOR}dsh-client-ui-chat/src/client/chat/AssistantNodeView.tsx`
const MARKDOWN_ID = '/x/node_modules/@deepseek-ai/dsh-client-ui-chat/src/client/chat/AssistantMarkdown.tsx'
// The renderer resolves vendor sources through realpathSync, so the id vite
// reports is normally the SUBMODULE path (this is the form that matters).
const MARKDOWN_REAL_ID = '/x/vendor/harness-checkout/packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx'

test('every registered patch anchor still matches the pinned vendor source exactly once', () => {
  const results = checkVendorPatchSources()
  assert.equal(results.length, VENDOR_PATCHES.length, 'one result per patch')
  for (const result of results) {
    assert.equal(result.ok, true, `${result.vendorFile}: ${result.detail}`)
  }
})

test('the patch rewrites the file-API URL to carry the per-entry base path', () => {
  const source = readFileSync(MARKDOWN, 'utf8')
  // Both id forms must select the patch: the symlinked vendor path and the
  // realpath'd submodule path (the one vite actually reports).
  const viaVendorPath = applyVendorPatches(MARKDOWN_ID, source)
  const patched = applyVendorPatches(MARKDOWN_REAL_ID, source)
  assert.notEqual(viaVendorPath, undefined, 'the @deepseek-ai id form must match')
  assert.equal(viaVendorPath.code, patched?.code, 'both id forms produce the same patch')
  assert.deepEqual(patched.applied, ['dsh-client-ui-chat/src/client/chat/AssistantMarkdown.tsx'])
  assert.ok(patched.code.includes('${origin}${basePath}/api/file?path='), 'the URL carries the base path')
  assert.ok(!patched.code.includes('return `${origin}/api/file?path='), 'the unpatched URL shape is gone')
  assert.ok(patched.code.includes('}, [chamberFileApiBase])'), 'the memo depends on the prop')
  // Behaviour: evaluate the patched function itself.
  const start = patched.code.indexOf('function localPathMediaUrl')
  const end = patched.code.indexOf('\n}', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const tsFunction = patched.code.slice(start, end + 2)
  const jsFunction = esbuild.transformSync(tsFunction, { loader: 'ts' }).code
  const fn = new Function(`${jsFunction}; return localPathMediaUrl`)()
  const origin = 'http://127.0.0.1:30800'
  const encoded = encodeURIComponent('/tmp/a.png')
  // Upstream fallback: no base path supplied (official-layout deployment).
  assert.equal(fn('http:', origin, '/tmp/a.png'), `${origin}/api/file?path=${encoded}`)
  assert.equal(fn('https:', origin, '/tmp/a.png', ''), `${origin}/api/file?path=${encoded}`)
  // Chamber: the per-entry prefix is inserted before the api path.
  assert.equal(fn('http:', origin, '/tmp/a.png', '/api/i/local'), `${origin}/api/i/local/api/file?path=${encoded}`)
  // Upstream guards are untouched.
  assert.equal(fn('file:', 'file:///app', '/tmp/a.png'), undefined)
  assert.equal(fn('http:', origin, '//cdn.example.com/x.png'), undefined)
  assert.equal(fn('http:', origin, 'relative.png'), undefined)
  assert.equal(fn('http:', origin, ''), undefined)
})

test('the node view forwards the root standard prop into the markdown component', () => {
  const patched = applyVendorPatches(
    '/x/node_modules/@deepseek-ai/dsh-client-ui-chat/src/client/chat/AssistantNodeView.tsx',
    readFileSync(NODE_VIEW, 'utf8'),
  )
  assert.notEqual(patched, undefined)
  assert.ok(patched.code.includes('chamberFileApiBase,\n}: ChatNodeViewProps<\'assistant-step\'>) {'), 'destructured')
  assert.ok(patched.code.includes('chamberFileApiBase={chamberFileApiBase}'), 'passed to AssistantMarkdown')
})

test('the file-upload patch routes the upload URL through the per-entry base path', () => {
  const source = readFileSync(`${VENDOR}dsh-client-file-upload/src/client/runtime.ts`, 'utf8')
  const patched = applyVendorPatches(
    '/x/vendor/harness-checkout/packages/client/file-upload/src/client/runtime.ts',
    source,
  )
  assert.notEqual(patched, undefined)
  assert.ok(patched.code.includes('resolveUrl(path: string, basePath = \'\'): URL {'), 'base path parameter added')
  assert.ok(patched.code.includes('return new URL(`${basePath}${path}`,'), 'the URL carries the base path')
  // Behaviour: evaluate the patched resolver (no window.location in node, so
  // the internal base is used, which is enough to prove prefixing).
  const start = patched.code.indexOf('function resolveUrl')
  const end = patched.code.indexOf('\n}', start)
  const js = esbuild.transformSync(patched.code.slice(start, end + 2), { loader: 'ts' }).code
  const resolveUrl = new Function(`${js}; return resolveUrl`)()
  assert.equal(resolveUrl('/api/session/uploadFileBinary').href, 'http://dsh.internal/api/session/uploadFileBinary')
  assert.equal(
    resolveUrl('/api/session/uploadFileBinary', '/api/i/local').href,
    'http://dsh.internal/api/i/local/api/session/uploadFileBinary',
  )
})

test('the ui-deliverables patches prefix both present routes and pass the ctx fact', () => {
  const open = applyVendorPatches(
    '/x/vendor/harness-checkout/packages/client/ui-deliverables/src/client/present-open.ts',
    readFileSync(`${VENDOR}dsh-client-ui-deliverables/src/client/present-open.ts`, 'utf8'),
  )
  assert.notEqual(open, undefined)
  assert.ok(open.code.includes('constructor(chamberFileApiBase = \'\') {'), 'the controller takes the base path')
  assert.ok(open.code.includes('fetch(`${this.chamberFileApiBase}${PRESENT_HOST_PATH}`'), 'present.host carries the base path')
  assert.ok(open.code.includes('fetch(`${this.chamberFileApiBase}${action === \'open\''), 'present.open carries the base path')

  const index = applyVendorPatches(
    '/x/vendor/harness-checkout/packages/client/ui-deliverables/src/client/index.ts',
    readFileSync(`${VENDOR}dsh-client-ui-deliverables/src/client/index.ts`, 'utf8'),
  )
  assert.notEqual(index, undefined)
  assert.ok(index.code.includes("new PresentedOpenController((ctx.get('chamberBasePath') as string | undefined) ?? '')"), 'apply passes the chamber fact through ctx.get (undefined-safe)')
})

test('the session-log-export patches route the export URL through the per-entry base path', () => {
  const controller = applyVendorPatches(
    '/x/vendor/harness-checkout/packages/session-query/session-log-export/src/client/controller.ts',
    readFileSync(`${VENDOR}dsh-session-log-export/src/client/controller.ts`, 'utf8'),
  )
  assert.notEqual(controller, undefined)
  assert.ok(controller.code.includes('chamberFileApiBase = \'\''), 'the controller carries a base-path field')
  assert.ok(
    controller.code.includes('new URL(`${this.chamberFileApiBase}/api/session.export`, hostBase())'),
    'the export URL carries the base path',
  )
  const index = applyVendorPatches(
    '/x/vendor/harness-checkout/packages/session-query/session-log-export/src/client/index.ts',
    readFileSync(`${VENDOR}dsh-session-log-export/src/client/index.ts`, 'utf8'),
  )
  assert.notEqual(index, undefined)
  assert.ok(index.code.includes("controller.chamberFileApiBase = (ctx.get('chamberBasePath') as string | undefined) ?? ''"), 'apply sets the base path via ctx.get')
})

test('an id without a registered patch is left untouched', () => {
  assert.equal(applyVendorPatches('/x/node_modules/@deepseek-ai/dsh-client-ui-conversation/src/client/index.ts', 'code'), undefined)
  assert.equal(applyVendorPatches('/x/packages/renderer/src/main.tsx', 'code'), undefined)
})

test('a drifted anchor fails loudly instead of silently shipping an unpatched bundle', () => {
  const source = readFileSync(MARKDOWN, 'utf8')
  const drifted = source.replace('return `${origin}/api/file?path=${encodeURIComponent(value)}`', 'return `${origin}/api/file?path=${value}`')
  assert.notEqual(drifted, source, 'the test mutation must change the source')
  assert.throws(
    () => applyVendorPatches(MARKDOWN_ID, drifted),
    /AssistantMarkdown\.tsx[\s\S]*anchor matched 0 times \(expected exactly 1\)[\s\S]*Reason: same-origin absolute file-API URL/,
  )
})

test('an ambiguous anchor (duplicated upstream text) also fails loudly', () => {
  const source = readFileSync(MARKDOWN, 'utf8')
  const duplicated = `${source}\n${source}`
  assert.throws(() => applyVendorPatches(MARKDOWN_ID, duplicated), /anchor matched 2 times \(expected exactly 1\)/)
})

test('vite module ids with a query string or windows separators still match', () => {
  const source = readFileSync(MARKDOWN, 'utf8')
  assert.notEqual(applyVendorPatches(`${MARKDOWN_ID}?v=abc123`, source), undefined)
  assert.notEqual(
    applyVendorPatches('C:\\repo\\node_modules\\@deepseek-ai\\dsh-client-ui-chat\\src\\client\\chat\\AssistantMarkdown.tsx', source),
    undefined,
  )
})
