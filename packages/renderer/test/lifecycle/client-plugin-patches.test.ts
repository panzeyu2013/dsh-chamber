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
  PATCHED_UPLOAD_BASE_EXPRESSION,
  applyChatImportUploadBasePatch,
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
 * Synthetic served-bundle fixture: the upstream 0.2.2-rc.3 bundle shape (classic script,
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

const UPLOAD_ANCHOR = CHAT_IMPORT_UPLOAD_ANCHOR
const CALL_ANCHOR = CHAT_IMPORT_CALL_ANCHOR

test('the pure patch module has zero imports (the upgrade verifier imports it directly)', () => {
  const source = readFileSync(new URL('../../src/client-plugin-patches.ts', import.meta.url), 'utf8')
  const importLines = source.split('\n').filter(line => /^\s*import\b/.test(line))
  assert.deepEqual(importLines, [], 'the pure module must stay import-free: ' + String(importLines))
  // The exported table is the single source: one registered package, two anchors.
  assert.equal(CLIENT_PLUGIN_PATCHES.length, 1)
  assert.equal(CLIENT_PLUGIN_PATCHES[0]?.packageId, CHAT_IMPORT_PACKAGE_ID)
  assert.equal(CLIENT_PLUGIN_PATCHES[0]?.anchors, 2)
  assert.deepEqual(CLIENT_PLUGIN_PATCHES[0]?.anchorTexts, [CHAT_IMPORT_UPLOAD_ANCHOR, CHAT_IMPORT_CALL_ANCHOR])
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
})
