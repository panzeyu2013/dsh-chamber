/**
 * FILES-TAB SEAT DECLARATION LOCK (ruling D-01 = B).
 *
 * rc.2 declares the official hole `sidebar.right.tab.files.actions` (list,
 * session scope, owner `{ absolutePath }`) in vendor ui-sidebar-files, and the
 * official ui-open-in-app row occupies it. In this N-ctx page that occupant
 * reads document-relative `open-in-app/*` routes that resolve to the
 * control-plane origin (SPA-fallback HTML the controller rejects), so it renders
 * nothing; chamber occupies the same hole with its own list id and its
 * per-source view-model.
 *
 * This lock pins THREE things: the VENDOR declaration our mirror must follow
 * (without this the loose vendor d.ts and the `register(any, any)` signature
 * would let an upstream shape change pass silently), the occupancy wired to OUR
 * id (never the official `open-in-app`), and the shared inject closure that keeps
 * both seats on one per-source adapter/choice. The component is React (not
 * importable under plain node), so the wiring is locked as SOURCE TEXT with
 * comments stripped; the pure path precedence is tested in
 * test/launch-flow/open-in-path.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

function source(relative: string): string {
  return stripComments(readFileSync(new URL(relative, import.meta.url), 'utf8'))
}

const vendorDecl = '../../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-sidebar-files/src/client/index.ts'
const vendorOccupant = '../../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-open-in-app/src/client/index.ts'
assert.ok(existsSync(new URL(vendorDecl, import.meta.url)), 'vendor tree must be materialized (run the bootstrap) — the upstream half of this lock cannot be skipped')

const vendor = source(vendorDecl)
const official = source(vendorOccupant)
const index = source('../../src/client/index.ts')
const button = source('../../src/client/OpenInButton.tsx')
const gates = source('../../src/client/open-in-gates.ts')

test('the vendor declaration keeps the shape our mirror follows', () => {
  assert.match(vendor, /'sidebar\.right\.tab\.files\.actions': \{/, 'upstream still declares the hole')
  assert.match(vendor, /kind: 'list'[\s\S]{0,80}scope: 'session'/, 'kind/scope as our mirror assumes')
  assert.match(vendor, /readonly absolutePath: string/, 'the owner share stays an absolute path')
})

test('the official occupant is the inert row this page overrides', () => {
  assert.match(official, /'sidebar\.right\.tab\.files\.actions'/, 'the official row registers into the hole')
  assert.match(official, /id: 'open-in-app'/, 'official list id (ours must differ)')
  const start = official.indexOf("ctx.slots.inject('sidebar.right.tab.files.actions'")
  assert.ok(start > 0, 'the official Files registration call must exist')
  const call = official.slice(start, start + 260)
  assert.match(call, /id: 'open-in-app'/, 'official list id (ours must differ)')
  assert.doesNotMatch(call, /order:/, 'the official Files entry keeps the default order — ours does too')
})

test('chamber occupies the seat with its OWN list id and the shared adapter', () => {
  assert.match(index, /FILES_ACTIONS_SLOT = 'sidebar\.right\.tab\.files\.actions' as const/)
  const registration = index.slice(index.indexOf('FILES_ACTIONS_SLOT, () => ctx.slots.register'))
  const end = registration.indexOf('}, OpenInButton))')
  assert.ok(end > 0, 'the seat registration must close on the shared component')
  const block = registration.slice(0, end)
  assert.match(block, /id: 'open-in'/, 'our own id, distinct from the official row')
  assert.doesNotMatch(block, /id: 'open-in-app'/, 'never claim the official id')
  assert.match(block, /inject: injected,/, 'both seats share ONE per-source adapter closure')
  assert.doesNotMatch(block, /order:/, 'no order: the official occupant keeps the default 0')
})

test('the header seat keeps its own registration (id/order/component/label)', () => {
  const header = index.slice(index.indexOf('OPEN_IN_HEADER_SLOT, () => ctx.slots.register'))
  const headerEnd = header.indexOf('}, OpenInButton))')
  assert.ok(headerEnd > 0, 'the header registration block must close on its component')
  const headerBlock = header.slice(0, headerEnd)
  assert.match(headerBlock, /id: 'open-in'/)
  assert.match(headerBlock, /order: -10/, 'keeps the vendor Session log (order 0) at the far right')
  assert.match(headerBlock, /inject: injected,/)
  const registrations = [...index.matchAll(/ctx\.slots\.register\(/g)]
  assert.equal(registrations.length, 2, 'exactly two seat registrations (header + rc.2 Files hole)')
})

test('the component takes the owner path before any session lookup', () => {
  assert.match(button, /absolutePath\?: string/, 'the seat owner prop must be part of the props')
  assert.match(button, /useWorkspaces: <S>\(sel:/, 'the framework selector stays a required prop (every slot component receives it)')
  assert.match(button, /resolveOpenInPath\(absolutePath, workspaces, sessionId\)/, 'Gate 2 must consult the owner path')
  assert.match(gates, /export function resolveOpenInPath\(/, 'the precedence lives in the pure gate module')
  assert.match(gates, /const owner = absolutePath\.trim\(\)/, 'the owner path is normalized before use')
})
