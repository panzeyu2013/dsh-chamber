import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * "+" (new session) wiring contract — design 05 §2.1 + the 2026-09 review.
 *
 * `SidebarRoot.tsx` is a React component that imports CSS modules, so a node
 * test cannot import it. Its two behavioural halves ARE unit-tested elsewhere
 * (`findReusableBlankSession` in derive.test.ts, the projection signature
 * flips in derive.test.ts); this source-text lock pins the GLUE that decides
 * between reuse and create, because a mutation there is invisible to every
 * pure test:
 *
 *  1. the handler must READ `reusableBlankSessionId` and reopen it, instead of
 *     issuing `session/create` unconditionally — the defect that produced
 *     invisible empty sessions (I2);
 *  2. the reuse branch must come BEFORE the create call in source order;
 *  3. a per-workspace in-flight guard must exist, mirroring upstream
 *     `connectWorkspace`'s `connecting` map: two clicks in the same tick both
 *     read the pre-create snapshot, so without the guard each issues its own
 *     create and one empty row is garbage forever.
 *
 * It guards WIRING, not semantics: a green run proves the calls still exist in
 * the expected shape, not that the behaviour is right.
 */
const sidebarRoot = fileURLToPath(new URL('../src/client/SidebarRoot.tsx', import.meta.url))

function onNewSessionBody(): string {
  const source = readFileSync(sidebarRoot, 'utf8')
  const start = source.indexOf('const onNewSession = ')
  assert.notEqual(start, -1, 'SidebarRoot.tsx no longer declares onNewSession')
  // The handler ends at the next top-level `\n  const ` / `\n  //` boundary the
  // file uses between handlers; a generous slice keeps this robust without
  // pretending to parse TSX.
  const rest = source.slice(start)
  const end = rest.indexOf('\n  // chamber (06 §2.2')
  return end === -1 ? rest.slice(0, 4000) : rest.slice(0, end)
}

test('"+": the handler resolves reuse BEFORE it creates (design 05 §2.1)', () => {
  const body = onNewSessionBody()
  const reuseAt = body.indexOf('reusableBlankSessionId')
  const createAt = body.indexOf('createSession(')
  assert.notEqual(reuseAt, -1, 'onNewSession no longer reads reusableBlankSessionId — "+" would always create')
  assert.notEqual(createAt, -1, 'onNewSession no longer creates the fallback session at all')
  assert.ok(reuseAt < createAt, 'the reuse branch must precede session/create in source order')
  assert.match(body, /chamberBridge\.requestOpenSession\(server\.id, reusable\)/,
    'the reuse branch must OPEN the existing row through the per-source open path')
})

test('"+": a second click joins the in-flight resolution instead of creating again', () => {
  const source = readFileSync(sidebarRoot, 'utf8')
  assert.match(source, /newSessionRef = useRef\(new Map<string, Promise<void>>\(\)\)/,
    'the per-workspace in-flight map is the upstream `connecting` equivalent and must exist')
  const body = onNewSessionBody()
  assert.match(body, /newSessionRef\.current\.get\(key\)/, 'the handler must consult the in-flight map')
  assert.match(body, /newSessionRef\.current\.set\(key, task\)/, 'the handler must register its in-flight task')
  assert.match(body, /newSessionRef\.current\.delete\(key\)/, 'the in-flight entry must be released on settle')
})
