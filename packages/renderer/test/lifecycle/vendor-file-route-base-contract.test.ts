/**
 * VENDOR FILE-ROUTE BASE LOCKSTEP (design 09 section 3.6).
 *
 * The chamber shell prefixes the ui-deliverables file-action producers with the
 * per-entry API base path: the layout fork publishes that fact as the root
 * standard prop `chamberFileApiBase`, and the patched fetch/producer call sites
 * prepend it. Two upstream facts decide whether the patch still works, and both
 * live in the PINNED tree:
 *
 *  1. the slots runtime merges the ROOT standard binding into every non-root
 *     scope (scoped-slots.tsx standardProps): every render path - definition,
 *     local scope, factory - passes rootBinding, and the per-scope object spreads
 *     the root materialization. If that narrows to first-screen scopes or moves,
 *     the deferred, session-scoped delivery/review cards receive undefined and
 *     both fall back to document.baseURI, i.e. the control-plane origin 404 that
 *     the patch exists to remove - with every other gate still green.
 *  2. the owner routes stay document-relative and are produced ONLY in the three
 *     patched sites. Upstream adding its own base resolution inside
 *     presented.ts/changes.ts, or a fourth fetch site, would double-prefix or
 *     bypass the patch without tripping C9, which only compares the patched
 *     call-site lines.
 *
 *  3. ui-chat holds exactly two `document.baseURI` producers, both covered by producer
 *     patches (chat markdown paths, chat file images); a third producer, or upstream
 *     adopting a base parameter of its own, fails the producer lock below instead of
 *     silently 404ing from the control-plane origin in the shell.
 *
 * One sibling site is NOT patchable and is locked as a recorded gap instead:
 * ui-sidebar-documentpreview's Markdown body resolves images against document.baseURI
 * too, but the package is served from the INSTANCE bundle, so no module of it reaches
 * our build (registering a patch fails the buildEnd applied-coverage gate). Test #4
 * pins that shape and that the package stays out of the composite covered set.
 *
 * The tree is resolved through the vendor symlink layout; a missing tree
 * LOUD-SKIPS the vendor locks (they read nothing and must not read as green).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const VENDOR_ROOT = fileURLToPath(new URL('../../../../vendor/harness-packages/@deepseek-ai', import.meta.url))
const VENDOR_SKIP = existsSync(VENDOR_ROOT)
  ? false
  : 'vendor/harness-packages not materialized (pnpm install / missing submodule): ' + VENDOR_ROOT
const SCOPED_SLOTS = join(VENDOR_ROOT, 'dsh-client-ui-renderer/src/client/scoped-slots.tsx')
const DELIVERABLES = join(VENDOR_ROOT, 'dsh-client-ui-deliverables/src')

/** Comment-free, whitespace-normalized text of one pinned vendor source file. */
function vendorSource(path: string): string {
  return normalize(stripComments(readFileSync(path, 'utf8')))
}

/** Every .ts/.tsx file under one pinned directory, recursively. */
function vendorSources(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(full).isDirectory())) found.push(...vendorSources(full))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(full)
  }
  return found
}

/** Tokens that can turn a document-relative path into an absolute URL request. */
const URL_SURFACE_TOKENS = ['document.baseURI', 'document[', 'location.href', 'location.origin', 'new URL(', 'fetch(', 'url(', 'src='] as const

/**
 * Per-file URL-surface census of one pinned package: the count of every token above,
 * including `.css` (`url(...)`). A filename allow-list alone lets a new file - or a
 * second producer inside an already-locked file - escape; counting tokens catches both.
 */
function urlSurfaceCensus(dir: string): string[] {
  const rows: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(full).isDirectory())) {
        walk(full)
      } else if (/\.(ts|tsx|css)$/u.test(entry.name)) {
        const text = stripComments(readFileSync(full, 'utf8'))
        const counts = URL_SURFACE_TOKENS
          .map((token) => token + '@' + (text.split(token).length - 1))
          .filter((cell) => !cell.endsWith('@0'))
        if (counts.length > 0) rows.push(full.slice(dir.length + 1) + ': ' + counts.join(' '))
      }
    }
  }
  walk(dir)
  return rows.sort()
}

test('the slots runtime merges the root standard binding into every scope', { skip: VENDOR_SKIP }, () => {
  const slots = vendorSource(SCOPED_SLOTS)
  assert.match(
    slots,
    /standard = \{ \.\.\.materializeStandardBinding\(rootBinding, false, scopeBinding\.key\), \.\.\.materializeStandardBinding\(scopeBinding, scope === 'session-maybe'\), \}/,
    'a non-root scope standard no longer spreads the root binding materialization',
  )
  for (const call of [
    'const standard = standardProps(scope, rootBinding, scopeBinding)',
    'const localStandard = standardProps(declared.scope, current.rootBinding, localScopeBinding)',
    'const standard = standardProps(definition.scope, rootBinding, scopeBinding)',
  ]) {
    assert.ok(slots.includes(call), 'render path no longer composes the root binding: ' + call)
  }
})

test('the pinned owner routes stay document-relative with no base resolution of their own', { skip: VENDOR_SKIP }, () => {
  const pairs = [
    ['dsh-client-ui-deliverables/src/presented.ts', 'PRESENT_OPEN_ROUTE', 'PRESENT_OPEN_PATH'],
    ['dsh-client-ui-deliverables/src/presented.ts', 'PRESENT_HOST_ROUTE', 'PRESENT_HOST_PATH'],
    ['dsh-client-ui-deliverables/src/changes.ts', 'CHANGED_FILES_ROUTE', 'CHANGED_FILES_PATH'],
    ['dsh-client-ui-deliverables/src/changes.ts', 'CHANGES_DIFF_ROUTE', 'CHANGES_DIFF_PATH'],
    ['dsh-client-ui-deliverables/src/changes.ts', 'CHANGES_OPEN_ROUTE', 'CHANGES_OPEN_PATH'],
  ] as const
  for (const [rel, route, absolute] of pairs) {
    const source = vendorSource(join(VENDOR_ROOT, rel))
    assert.ok(
      source.includes('export const ' + route + ' = ' + absolute + '.slice(1)'),
      'the route is no longer the browser-relative form of its path: ' + rel + ' ' + route,
    )
  }
  for (const rel of ['dsh-client-ui-deliverables/src/presented.ts', 'dsh-client-ui-deliverables/src/changes.ts']) {
    const source = vendorSource(join(VENDOR_ROOT, rel))
    assert.doesNotMatch(
      source,
      /document\.baseURI|location\.origin|new URL\(/,
      'the pinned builder gained its own base resolution; the chamber prefix would double: ' + rel,
    )
  }
})

const UI_CHAT = join(VENDOR_ROOT, 'dsh-client-ui-chat/src/client')
const DOCUMENT_PREVIEW = join(VENDOR_ROOT, 'dsh-client-ui-sidebar-documentpreview/src/client')
const MARKDOWN_BODY = join(DOCUMENT_PREVIEW, 'markdown/MarkdownBody.tsx')
const COMPOSITE_COVERED = fileURLToPath(new URL('../../src/chamber-covered.ts', import.meta.url))
const CHAMBER_ENTRY = fileURLToPath(new URL('../../src/chamber-entry.ts', import.meta.url))

test('every document.baseURI producer in ui-chat is one of the two patched resolvers', { skip: VENDOR_SKIP }, () => {
  const producers: string[] = []
  for (const file of vendorSources(UI_CHAT)) {
    const source = stripComments(readFileSync(file, 'utf8'))
    if (!source.includes('document.baseURI')) continue
    producers.push(file.slice(UI_CHAT.length + 1))
    assert.equal(
      source.split('document.baseURI').length - 1,
      1,
      'a second document-relative producer appeared in one file; extend the patch set or this lock: ' + file,
    )
    assert.ok(
      !/\bchamberFileApiBase\b/u.test(source),
      'upstream adopted a base parameter; the chamber producer patch is now redundant: ' + file,
    )
  }
  assert.deepEqual(
    producers.sort(),
    ['chat/AssistantMarkdown.tsx', 'chat/ChatView.tsx'],
    'a document-relative image or file producer outside the two patched ui-chat resolvers appeared or moved',
  )
})

test('the uncovered document-preview resolver stays a recorded gap, never a patched site', { skip: VENDOR_SKIP }, () => {
  // The right sidebar previews Markdown images through this resolver, and the package is
  // served from the INSTANCE bundle: our build never transforms it, so a producer patch
  // cannot apply (registering one fails the buildEnd applied-coverage gate - measured).
  // STATUS records the deviation; closing it needs a deliberate coverage decision.
  const body = stripComments(readFileSync(MARKDOWN_BODY, 'utf8'))
  assert.ok(
    body.includes('markdownImageUrl(document.baseURI'),
    'the resolver shape changed; re-derive the recorded gap before trusting this lock',
  )
  assert.ok(
    !/\bchamberFileApiBase\b/u.test(body),
    'upstream adopted a base parameter: the gap can close with a producer patch now',
  )
  const covered = stripComments(readFileSync(COMPOSITE_COVERED, 'utf8'))
  assert.ok(
    !covered.includes('dsh-client-ui-sidebar-documentpreview'),
    'the package joined the composite covered set: register the producer patch and drop the recorded gap',
  )
})

test('the inert official open-in probes stay a recorded, unpatched site', { skip: VENDOR_SKIP }, () => {
  // The official open-in CLIENT row is loaded from the instance bundle (design 20 §2.2): its
  // probes are document-relative by construction, so under the N-ctx shell they reach the
  // control-plane origin, the apps read yields nothing and the header seat renders null —
  // deliberately inert, locked here instead of patched (the row is outside the composite
  // graph, so a producer patch could never apply).
  const OPEN_IN_APP = join(VENDOR_ROOT, 'dsh-client-ui-open-in-app/src/client')
  const controller = vendorSource(join(OPEN_IN_APP, 'controller.ts'))
  for (const symbol of ['OPEN_IN_APP_APPS_ROUTE', 'OPEN_IN_APP_OPEN_ROUTE']) {
    assert.ok(
      controller.includes(symbol),
      'the open-in route symbol moved: re-derive the recorded gap (' + symbol + ')',
    )
  }
  assert.ok(
    !/\bchamberFileApiBase\b/u.test(controller),
    'the official open-in client grew a base prop: revisit the patched-producer decision',
  )
  assert.ok(
    vendorSource(join(OPEN_IN_APP, 'index.ts')).includes('${OPEN_IN_APP_ICON_PREFIX_ROUTE}/${appId}'),
    'the root-relative icon builder moved: re-derive the recorded gap',
  )

  // Census the package the same way as the preview package: a new producer in a NEW
  // file (or a second one inside a locked file) must fail here, not silently 404.
  assert.deepEqual(
    urlSurfaceCensus(OPEN_IN_APP),
    [
      'FileRouteAction.tsx: fetch(@1',
      'OpenTargetButton.tsx: src=@1',
      'controller.ts: fetch(@1',
    ],
    'the inert open-in probes changed shape: re-derive the recorded gap before trusting this lock',
  )
})

test('the per-entry base path the producers trust is validated at its only source', { skip: VENDOR_SKIP }, () => {
  // The patches normalize undefined/'' and otherwise trust the value; the prefix math
  // (`new URL(`${base}/`, document.baseURI)`) needs the exact `/api/i/<id>` form — with a
  // trailing slash or a query/fragment it would double the slash or distort the URL.
  const entry = stripComments(readFileSync(CHAMBER_ENTRY, 'utf8'))
  assert.ok(
    entry.includes('chamberBasePath !== `/api/i/${chamberInstanceId}`'),
    'the base-path producer stopped asserting the exact /api/i/<id> form: re-derive the prefix math',
  )

  // Execute the guard, not just its text: the patches trust the value, so anything but
  // the exact `/api/i/<id>` form must be rejected at runtime, not only in source.
  const guardStart = entry.indexOf("if (typeof chamberBasePath !== 'string'")
  assert.notEqual(guardStart, -1, 'the base-path guard block moved: re-derive the executed check')
  const guardEnd = entry.indexOf('\n  }', guardStart)
  assert.notEqual(guardEnd, -1, 'the base-path guard block no longer closes in the expected shape')
  const guard = entry.slice(guardStart, guardEnd + 4)
  const check = new Function('chamberBasePath', 'chamberInstanceId', guard + '\nreturn "accepted"') as unknown as (basePath: unknown, instanceId: string) => string
  assert.equal(check('/api/i/local', 'local'), 'accepted', 'the exact per-entry base path must be accepted')
  for (const bad of [undefined, null, '', '/api/i/local/', '/api/i/local?x=1', '/api/i/local#f', '/api/i/other', '/api/i/local/../x', 7]) {
    assert.throws(() => check(bad, 'local'), 'a malformed base path must be rejected at its only source: ' + String(bad))
  }
})

test('the instance-served preview package URL surface stays exactly the recorded gap', { skip: VENDOR_SKIP }, () => {
  // The recorded gap is this package's Markdown image resolver. A second producer would
  // widen the gap silently, so census the package the same way the ui-chat producers are
  // enumerated above: every file's URL surface (including .css) must match exactly.
  assert.deepEqual(
    urlSurfaceCensus(DOCUMENT_PREVIEW),
    [
      'html/HtmlBody.tsx: src=@1',
      'image/ImageBody.tsx: src=@1',
      'markdown/MarkdownBody.tsx: document.baseURI@1',
      'pdf/assets.ts: fetch(@2',
    ],
    'the URL surface of the instance-served preview package changed: extend the recorded gap or cover the package',
  )
})

test('the markdown delegate provider outranks pathImages, so the chat fileImages patch is load-bearing', { skip: VENDOR_SKIP }, () => {
  const render = vendorSource(join(VENDOR_ROOT, 'dsh-client-ui-primitives/src/markdown/render.tsx'))
  assert.ok(
    render.includes(
      'const src = (file === undefined ? undefined : fileImages?.resolve(file.path)) ?? imageSource(destination, pathImages)',
    ),
    'the delegate-provider precedence moved: re-check which chat resolver owns the image URL',
  )

  // Execute the precedence expression itself: the delegate provider must win when it
  // resolves, and the pathImages fallback must still serve when it does not.
  const marker = 'const src = (file === undefined ? undefined : fileImages?.resolve(file.path)) ?? imageSource(destination, pathImages)'
  assert.notEqual(render.indexOf(marker), -1, 'the delegate-precedence expression moved; re-derive the executed check')
  const expression = marker.slice('const src = '.length)
  const resolve = new Function('file', 'fileImages', 'imageSource', 'destination', 'pathImages', 'return (' + expression + ')') as unknown as (...args: unknown[]) => unknown
  const delegate = { resolve: (path: string) => 'FILE:' + path }
  assert.equal(resolve({ path: 'x.png' }, delegate, () => 'PATH', 'a.png', {}), 'FILE:x.png', 'the delegate provider must outrank pathImages')
  assert.equal(resolve(undefined, delegate, () => 'PATH', 'a.png', {}), 'PATH', 'without a file result the pathImages fallback must still serve')
})

test('the deliverables file-action route is only ever fetched, never re-parsed', { skip: VENDOR_SKIP }, () => {
  const openIn = join(VENDOR_ROOT, 'dsh-client-ui-open-in-app/src/client')
  const consumers = vendorSources(openIn).filter((file) => stripComments(readFileSync(file, 'utf8')).includes('actionUrl'))
  assert.deepEqual(
    consumers.map((file) => file.slice(openIn.length + 1)).sort(),
    ['FileRouteAction.tsx'],
    'a new consumer of the owner action route appeared: it must fetch the URL as handed over',
  )
  const action = stripComments(readFileSync(join(openIn, 'FileRouteAction.tsx'), 'utf8'))
  assert.ok(
    action.includes('useFileApplications(props.actionUrl, queryRoute, props.available)'),
    'the route is no longer handed to the shared reader unchanged',
  )
  assert.ok(
    action.includes('await fetch(url, { signal })'),
    'the single route fetch changed shape; a parsing consumer would need a chamber ruling',
  )
  // The shared reader keys its retained entry by the URL (an opaque identity), and the
  // only fetch is the query helper above: prefixing the URL therefore de-collides the
  // per-instance readers instead of breaking a path parse.
  for (const file of ['FileRouteAction.tsx', 'file-applications.ts']) {
    const source = stripComments(readFileSync(join(openIn, file), 'utf8'))
    assert.ok(
      !source.includes('new URL(url') && !source.includes('new URL(props.actionUrl') && !source.includes('new URL(target'),
      'a consumer parses the action URL instead of treating it as an opaque fetch target: ' + file,
    )
  }
})

test('every ui-deliverables route fetch is one of the three patched producers', { skip: VENDOR_SKIP }, () => {
  const fetches = new Map<string, number>()
  for (const file of vendorSources(DELIVERABLES)) {
    const count = stripComments(readFileSync(file, 'utf8')).split('fetch(').length - 1
    if (count > 0) fetches.set(file.slice(DELIVERABLES.length + 1), count)
  }
  assert.deepEqual(
    [...fetches.entries()].sort(),
    [['client/host-read-store.ts', 1], ['client/present-open.ts', 2]],
    'a ui-deliverables fetch site outside the patched producers appeared or moved',
  )
})
