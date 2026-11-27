/**
 * Page-level runtime plugin patch table (design 09 §4 runtime base backfill): the pure
 * declaration half — anchors, the two-anchor rewriter, combo-URL classification
 * (patch / none / refuse) and the sourceURL sanitizer. The loader contract and the
 * browser text/eval behavior live in `patched-bundle-load.test.ts`; this file also
 * pins that the pure module has ZERO imports (the upgrade-time verifier imports it
 * directly, so it must run under plain node type-stripping).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CHAT_IMPORT_CALL_ANCHOR,
  CHAT_IMPORT_PACKAGE_ID,
  CHAT_IMPORT_UPLOAD_ANCHOR,
  CLIENT_PLUGIN_PATCHES,
  DOCUMENT_PREVIEW_BODY_ANCHOR,
  DOCUMENT_PREVIEW_PACKAGE_ID,
  DOCUMENT_PREVIEW_RESOLVE_ANCHOR,
  PATCHED_PATH_IMAGES_BASE_EXPRESSION,
  PATCHED_UPLOAD_BASE_EXPRESSION,
  applyChatImportUploadBasePatch,
  applyDocumentPreviewPathImagesBasePatch,
  bundlePackageIdOf,
  classifyClientPluginBundle,
  findClientPluginPatch,
  sanitizeSourceUrl,
} from '../../src/client-plugin-patches.ts'

/** Count non-overlapping literal occurrences (independent of the production helper). */
function count(text: string, needle: string): number {
  let total = 0
  let at = text.indexOf(needle)
  while (at >= 0) {
    total += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return total
}

/**
 * Synthetic served-bundle fixture: the upstream classic-script bundle shape (self-registration,
 * self-registration, the upload URL against document.baseURI, the carrier fallback) —
 * independently written here so a production anchor typo cannot self-validate.
 */
const CHAT_IMPORT_FIXTURE = [
  '\nwindow.__ModuleLoader__.load({id:`@deepseek-ai/dsh-deepseek-chat-import`,factory:require=>{',
  'var module={exports:{}};var exports=module.exports;',
  'const UPLOAD_PATH=`/api/deepseek-chat-import/archive`;const UPLOAD_ROUTE=UPLOAD_PATH.slice(1);',
  'function uploadArchive(file,workspaceId,onProgress,signal){const url=new URL(`${UPLOAD_ROUTE}?${new URLSearchParams({workspaceId}).toString()}`,document.baseURI);',
  'const carrier=globalThis.__DSH_TRANSPORT__?.fetch;',
  'return carrier===void 0?sendWithXhr(file,url,onProgress,signal):sendWithCarrier(carrier,file,url,onProgress,signal)}',
  'function registerUi(ctx){const injected={importArchive:async(file,workspaceId,onProgress,signal)=>{',
  'const answer=await uploadArchive(file,workspaceId,onProgress,signal);',
  'return answer}};return injected}',
  'function sendWithXhr(){return Promise.resolve({ok:false})}',
  'function sendWithCarrier(){return Promise.resolve({ok:false})}',
  'exports.apply=async ctx=>{registerUi(ctx)};exports.inject=[`remote`];return module.exports}});',
  '//# sourceMappingURL=/plugins/??@deepseek-ai/dsh-deepseek-chat-import/client.js.map&rev=abc',
].join('')

/**
 * Independently written pinned-shape fixture for the document preview body: the two anchor
 * texts are literal here (not imported), so a production anchor typo cannot self-validate.
 */
const DOCUMENT_PREVIEW_FIXTURE = [
  'window.__ModuleLoader__.load({id:`@deepseek-ai/dsh-client-ui-sidebar-documentpreview`,factory:require=>{',
  'var module={exports:{}};var exports=module.exports;',
  'function markdownImageUrl(base,documentPath,destination){return new URL(`api/file?path=${encodeURIComponent(destination)}`,base).href}',
  'function MarkdownBody({content,resourceAddress,useResource,t}){',
  'const absolutePath=useResource(resourceAddress).value?.absolutePath;',
  'const pathImages=(0,react.useMemo)(()=>({resolve:value=>markdownImageUrl(document.baseURI,absolutePath,value)}),[absolutePath]);',
  'return content.kind===`text`?pathImages:null}',
  'exports.apply=ctx=>{};return module.exports}});',
].join('')

const UPLOAD_ANCHOR = CHAT_IMPORT_UPLOAD_ANCHOR
const CALL_ANCHOR = CHAT_IMPORT_CALL_ANCHOR

test('the pure patch module has zero imports (the upgrade verifier imports it directly)', () => {
  const source = readFileSync(new URL('../../src/client-plugin-patches.ts', import.meta.url), 'utf8')
  const importLines = source.split('\n').filter(line => /^\s*import\b/.test(line))
  assert.deepEqual(importLines, [], 'the pure module must stay import-free: ' + String(importLines))
  // The exported table is the single source: both registered packages, two anchors each.
  assert.equal(CLIENT_PLUGIN_PATCHES.length, 2)
  const chatImport = findClientPluginPatch('/api/i/local/plugins/??' + CHAT_IMPORT_PACKAGE_ID + '/client.js&rev=abc')
  assert.equal(chatImport?.packageId, CHAT_IMPORT_PACKAGE_ID)
  assert.equal(chatImport?.anchors, 2)
  assert.equal(chatImport?.anchorMiss, 'refuse')
  assert.deepEqual(chatImport?.probe, { token: 'chamberBasePath', count: 1 })
  assert.deepEqual(chatImport?.anchorTexts, [CHAT_IMPORT_UPLOAD_ANCHOR, CHAT_IMPORT_CALL_ANCHOR])
  const documentPreview = findClientPluginPatch('/api/i/local/plugins/??' + DOCUMENT_PREVIEW_PACKAGE_ID + '/client.js&rev=abc')
  assert.equal(documentPreview?.packageId, DOCUMENT_PREVIEW_PACKAGE_ID)
  assert.equal(documentPreview?.anchors, 2)
  assert.equal(documentPreview?.anchorMiss, 'degrade-unpatched')
  assert.deepEqual(documentPreview?.probe, { token: 'chamberFileApiBase', count: 3 })
  assert.deepEqual(documentPreview?.anchorTexts, [DOCUMENT_PREVIEW_BODY_ANCHOR, DOCUMENT_PREVIEW_RESOLVE_ANCHOR])
})

test('a single-id combo names its package for both rev spellings; batches/chunks/assets name none', () => {
  const id = CHAT_IMPORT_PACKAGE_ID
  assert.equal(bundlePackageIdOf('/api/i/local/plugins/??' + id + '/client.js&rev=abc123'), id)
  assert.equal(bundlePackageIdOf('/api/i/local/plugins/??' + id + '/client.js?rev=abc123'), id)
  // Host-root form (pre-0.1.6 graphs) resolves too: the loader only ever decides patch-or-not.
  assert.equal(bundlePackageIdOf('/plugins/??' + id + '/client.js&rev=abc'), id)
  assert.equal(bundlePackageIdOf('/api/i/dsh-remote/plugins/??@scope/pkg/client.js&rev=1'), '@scope/pkg')
  // Batch scripts register several ids: no single package owns them.
  assert.equal(bundlePackageIdOf('/plugins/??@a/one/client.js,@b/two/client.js&rev=9'), null)
  // Package-local chunks, assets and non-plugin sources name no package.
  assert.equal(bundlePackageIdOf('/api/i/local/plugins/@scope/pkg/client.chunk1.js?rev=1'), null)
  assert.equal(bundlePackageIdOf('/api/i/local/plugins/@scope/pkg/assets/icon.svg'), null)
  assert.equal(bundlePackageIdOf('/assets/chamber-entry-1.js'), null)
  assert.equal(bundlePackageIdOf(''), null)
  assert.equal(bundlePackageIdOf('not a url'), null)
})

test('classification: an official-id-lookalike (fork) is not refused by substring matching', () => {
  const url = '/api/i/local/plugins/??' + CHAT_IMPORT_PACKAGE_ID + '-fork/client.js&rev=abc'
  assert.equal(classifyClientPluginBundle(url).kind, 'none')
})

test('classification: patch only for the registered single-id combo; registered-in-batch refuses', () => {
  const id = CHAT_IMPORT_PACKAGE_ID
  const patch = classifyClientPluginBundle('/api/i/local/plugins/??' + id + '/client.js&rev=abc')
  assert.equal(patch.kind, 'patch')
  assert.equal(patch.kind === 'patch' ? patch.patch.packageId : null, id)
  // Unregistered single-id combo keeps the script path.
  assert.equal(classifyClientPluginBundle('/api/i/local/plugins/??@deepseek-ai/dsh-client-ui-workspace/client.js&rev=1').kind, 'none')
  // A plain chunk route must NEVER be touched (no combo marker).
  assert.equal(classifyClientPluginBundle('/api/i/local/plugins/' + id + '/client.terminal.js?rev=1').kind, 'none')
  // Registered package present but not a single-id <pkg>/client.js combo => refuse.
  const batch = classifyClientPluginBundle('/plugins/??' + id + '/client.js,@a/b/client.js&rev=1')
  assert.equal(batch.kind, 'refuse')
  if (batch.kind === 'refuse') {
    assert.equal(batch.patch.packageId, id)
    assert.ok(batch.message.includes(id), 'the refusal names the package')
    assert.ok(batch.message.includes(batch.patch.reason), 'the refusal carries the patch reason')
    assert.ok(batch.message.includes('anchors: 2'), 'the refusal carries the anchor count')
  }
  const wrongResource = classifyClientPluginBundle('/plugins/??' + id + '/client.other.js&rev=1')
  assert.equal(wrongResource.kind, 'refuse')
  assert.equal(classifyClientPluginBundle('/plugins/??' + id + '&rev=1').kind, 'refuse', 'a token equal to the registered id is malformed, not a different package')
  // The document-preview entry keeps the same defensive shape rule: degrade covers anchor
  // misses only, never a non-single-id combo (an invariant breach, not runtime skew).
  const documentSingle = classifyClientPluginBundle('/api/i/local/plugins/??' + DOCUMENT_PREVIEW_PACKAGE_ID + '/client.js&rev=1')
  assert.equal(documentSingle.kind, 'patch')
  const documentBatch = classifyClientPluginBundle('/plugins/??' + DOCUMENT_PREVIEW_PACKAGE_ID + '/client.js,@a/b/client.js&rev=1')
  assert.equal(documentBatch.kind, 'refuse')
  // A batch with no registered package is not our business: keep the untouched path.
  assert.equal(classifyClientPluginBundle('/plugins/??@a/one/client.js,@b/two/client.js&rev=1').kind, 'none')
  assert.equal(findClientPluginPatch('/api/i/local/plugins/??' + id + '/client.js&rev=abc')?.packageId, id)
  assert.equal(findClientPluginPatch('/assets/chamber-entry-1.js'), null)
})

test('the patched base expression resolves the upload route under the per-entry proxy', () => {
  // The exact expression spliced into the bundle, evaluated against a fake document base.
  const resolve = new Function(
    'basePath', 'document', `return (${PATCHED_UPLOAD_BASE_EXPRESSION})`,
  ) as unknown as (basePath: string | undefined, document: { readonly baseURI: string }) => string
  const page = { baseURI: 'http://127.0.0.1:51234/' }
  for (const [basePath, expected] of [
    ['/api/i/local', '/api/i/local/api/deepseek-chat-import/archive'],
    ['/api/i/dsh-remote-7', '/api/i/dsh-remote-7/api/deepseek-chat-import/archive'],
    [undefined, '/api/deepseek-chat-import/archive'],
  ] as const) {
    const resolved = new URL('api/deepseek-chat-import/archive?workspaceId=w', resolve(basePath, page))
    assert.equal(resolved.pathname, expected)
    assert.equal(resolved.searchParams.get('workspaceId'), 'w')
  }
  // An absent base is the native dsh page: the document base itself, byte for byte.
  assert.equal(resolve(undefined, page), page.baseURI)
})

test('the chat-import patch adds the per-entry base once and keeps the carrier branch', () => {
  const patched = applyChatImportUploadBasePatch(CHAT_IMPORT_FIXTURE)
  if (patched === null) assert.fail('the upstream-shaped fixture must patch')
  assert.equal(count(patched, UPLOAD_ANCHOR), 0)
  assert.equal(count(patched, CALL_ANCHOR), 0)
  assert.equal(count(patched, 'function uploadArchive(file,workspaceId,onProgress,signal,basePath){'), 1)
  assert.equal(count(patched, 'uploadArchive(file,workspaceId,onProgress,signal,ctx.get(`chamberBasePath`))'), 1)
  assert.equal(count(patched, PATCHED_UPLOAD_BASE_EXPRESSION), 1)
  // The fallback arm and the prefixed-URL base: the expression's two document references.
  assert.equal(count(patched, 'document.baseURI'), 2)
  // The page-transport carrier branch is untouched (a shell carrier still wins).
  assert.equal(count(patched, '__DSH_TRANSPORT__'), 1)
  // Everything outside the two anchors is byte-identical.
  const head = CHAT_IMPORT_FIXTURE.slice(0, CHAT_IMPORT_FIXTURE.indexOf(UPLOAD_ANCHOR))
  assert.ok(patched.startsWith(head))
  assert.ok(patched.endsWith('//# sourceMappingURL=/plugins/??@deepseek-ai/dsh-deepseek-chat-import/client.js.map&rev=abc'))
})

test('a duplicated or missing anchor refuses the patch (fail-closed)', () => {
  assert.equal(applyChatImportUploadBasePatch(CHAT_IMPORT_FIXTURE.replace(CALL_ANCHOR, CALL_ANCHOR + CALL_ANCHOR)), null)
  assert.equal(applyChatImportUploadBasePatch(CHAT_IMPORT_FIXTURE.replace(UPLOAD_ANCHOR, UPLOAD_ANCHOR + UPLOAD_ANCHOR)), null)
  assert.equal(applyChatImportUploadBasePatch(CHAT_IMPORT_FIXTURE.replace(CALL_ANCHOR, '')), null)
  assert.equal(applyChatImportUploadBasePatch(CHAT_IMPORT_FIXTURE.replace(UPLOAD_ANCHOR, UPLOAD_ANCHOR.replace('document.baseURI', 'location.origin'))), null)
  assert.equal(applyChatImportUploadBasePatch(''), null)
  assert.equal(applyChatImportUploadBasePatch('window.__ModuleLoader__.load({id:`x`,factory:()=>({})})'), null)
})

test('the document-preview patch adds the standard-prop base to the only image resolver', () => {
  const patched = applyDocumentPreviewPathImagesBasePatch(DOCUMENT_PREVIEW_FIXTURE)
  if (patched === null) assert.fail('the pinned-shaped fixture must patch')
  assert.equal(count(patched, DOCUMENT_PREVIEW_BODY_ANCHOR), 0)
  assert.equal(count(patched, DOCUMENT_PREVIEW_RESOLVE_ANCHOR), 0)
  assert.equal(count(patched, 'function MarkdownBody({content,resourceAddress,useResource,t,chamberFileApiBase}){'), 1)
  assert.equal(count(patched, PATCHED_PATH_IMAGES_BASE_EXPRESSION), 1)
  // The fallback arm and the URL-resolution base: the guarded expression's two references.
  assert.equal(count(patched, 'document.baseURI'), 2)
  // Everything outside the two anchors is byte-identical.
  const head = DOCUMENT_PREVIEW_FIXTURE.slice(0, DOCUMENT_PREVIEW_FIXTURE.indexOf(DOCUMENT_PREVIEW_BODY_ANCHOR))
  assert.ok(patched.startsWith(head))
  assert.ok(patched.endsWith('exports.apply=ctx=>{};return module.exports}});'))
})

test('a duplicated, missing or drifted document-preview anchor refuses the patch', () => {
  assert.equal(applyDocumentPreviewPathImagesBasePatch(DOCUMENT_PREVIEW_FIXTURE.replace(DOCUMENT_PREVIEW_RESOLVE_ANCHOR, '')), null)
  assert.equal(applyDocumentPreviewPathImagesBasePatch(DOCUMENT_PREVIEW_FIXTURE.replace(DOCUMENT_PREVIEW_RESOLVE_ANCHOR, DOCUMENT_PREVIEW_RESOLVE_ANCHOR + DOCUMENT_PREVIEW_RESOLVE_ANCHOR)), null)
  assert.equal(applyDocumentPreviewPathImagesBasePatch(DOCUMENT_PREVIEW_FIXTURE.replace('markdownImageUrl(document.baseURI', 'markdownImageUrl(location.origin')), null)
  assert.equal(applyDocumentPreviewPathImagesBasePatch(''), null)
})

test('the path-images base expression falls back to the document base and keeps the per-entry prefix', () => {
  const resolve = new Function(
    'chamberFileApiBase', 'document', `return (${PATCHED_PATH_IMAGES_BASE_EXPRESSION})`,
  ) as unknown as (basePath: string | undefined, document: { readonly baseURI: string }) => string
  const page = { baseURI: 'http://127.0.0.1:51234/' }
  assert.equal(resolve(undefined, page), page.baseURI)
  assert.equal(resolve('/api/i/local', page), 'http://127.0.0.1:51234/api/i/local/')
  assert.equal(resolve('/api/i/dsh-remote-7', page), 'http://127.0.0.1:51234/api/i/dsh-remote-7/')
})

test('sourceURL sanitization strips every ECMAScript line terminator', () => {
  assert.equal(sanitizeSourceUrl('a\r\nb\u2028c\u2029d'), 'abcd')
  assert.equal(sanitizeSourceUrl('/api/i/local/plugins/x.js'), '/api/i/local/plugins/x.js')
})

test('the shell dispatches by classification and keeps the script fallback', () => {
  const shell = readFileSync(new URL('../../src/shell.ts', import.meta.url), 'utf8')
  // Dispatch first, script-element path second: none/refuse/patch are the only branches.
  assert.match(shell, /const match = classifyClientPluginBundle\(url\)/)
  assert.match(shell, /if \(match\.kind === 'refuse'\) return Promise\.reject\(new Error\(match\.message\)\)/)
  assert.match(shell, /if \(match\.kind === 'patch'\) return loadPatchedModuleBundle\(url, match\.patch\)/)
  assert.match(shell, /const el = document\.createElement\('script'\)/)
  assert.match(shell, /el\.type = 'module'/)
  // The wrapper is the real-dependency wiring for the testable loader module.
  assert.match(shell, /return loadPatchedBundle\(url, patch, \{/)
  assert.match(shell, /budget: 'caller-held'/)
  assert.match(shell, /createTimeoutError: \(message, bundleOutcome\) => new BundleLoadTimeoutError\(message, bundleOutcome\)/)
  // One shared script-element loader: the untouched path AND the degrade fallback.
  assert.match(shell, /function loadScriptElementBundle\(url: string\): Promise<void> \{/)
  assert.match(shell, /loadUnpatched: loadScriptElementBundle/)
  assert.match(shell, /onAnchorMiss: info => \{/)
  // The degrade verdict word itself is load-bearing: gui-acceptance step 6 identifies the
  // fallback by this exact diagnostic tail (the dispatch lock above only pins the callback).
  assert.match(shell, /\(degrade-unpatched\)/u)
})
