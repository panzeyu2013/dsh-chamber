/**
 * Wiring contract for the workspace-creation echo (design 05 §2.2 revision
 * 2026-12; 2026-12 field report problem 2).
 *
 * `App.tsx` cannot be imported by a node test (it renders the whole shell), so
 * this follows the repo's established source-text contract pattern
 * (`sidebar-right-heal-wiring.test.ts`, `app-purged-memory-wiring.test.ts`): a
 * green run proves the SHAPE, not the behaviour — the behaviour is covered by
 * the sidebar package's `workspace-echo.test.ts` (echo/union/dedupe rules) and
 * `aggregate-store.test.ts` (the bridge fact).
 *
 * Every link here is a silent no-op when it goes missing: the sidebar creates
 * the workspace and never publishes the fact, the App never records it, the
 * derive never merges it (so the row stays invisible for unmounted sources —
 * the exact field report), or nothing ever retires the entry (a phantom row
 * that survives the authoritative baseline forever).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from './source-text.ts'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('the sidebar publishes the host workspace identity right after a successful create', () => {
  const sidebar = read('../../dsh-chamber-client-ui-sidebar/src/client/SidebarRoot.tsx')
  const report = sidebar.indexOf('chamberBridge.reportWorkspaceCreated({')
  const refresh = sidebar.indexOf('chamberBridge.requestRefresh(sourceId)', report)
  assert.notEqual(report, -1, 'the sidebar must publish the created workspace')
  assert.notEqual(refresh, -1, 'the refresh that follows must stay (it owns every other row of that source)')
  assert.match(sidebar, /\.then\(\(created\) => \{/, 'the create result carries the host workspace id')
  assert.match(sidebar, /workspaceId: created\.workspaceId,/, 'the echoed id is the HOST id, never a synthesized one')
  assert.match(sidebar, /path: created\.path,/)
  assert.doesNotMatch(
    sidebar,
    /reused:/,
    'the fact carries only what the ledger consumes (id + path): an inert field is not carried "just in case"',
  )
})

test('the App records the fact in a lifespan-scoped ledger (state + synchronous ref mirror)', () => {
  const app = read('../src/App.tsx')
  assert.match(app, /const \[workspaceEcho, setWorkspaceEcho\] = useState<WorkspaceEchoLedger>\(\{\}\)/)
  assert.match(app, /const workspaceEchoRef = useRef<WorkspaceEchoLedger>\(\{\}\)/)
  assert.match(app, /const updateWorkspaceEcho = useCallback\(\(next: WorkspaceEchoLedger\): void => \{/)
  // The subscription must be fenced exactly like every other source-scoped
  // handler: a dead source and an ownership mismatch must not enter the ledger.
  assert.match(app, /return chamberBridge\.onWorkspaceCreated\(\(fact\) => \{/)
  assert.match(app, /const owner = sourceLifecyclesRef\.current!\.capture\(sourceId\)/)
  assert.match(app, /ledger = recordPendingWorkspace\(ledger, sourceId, \{ workspaceId: fact\.workspaceId, path: fact\.path \}, now\)/)
})

test('the projection merges the echo at the single derive choke point', () => {
  const app = read('../src/App.tsx')
  assert.match(
    app,
    /function deriveServers\([\s\S]*?workspaceEcho: WorkspaceEchoLedger,/,
    'deriveServers takes the ledger',
  )
  assert.match(
    app,
    /workspaces = deriveServerWorkspaces\(\s*withWorkspaceEcho\(aggregate, workspaceEcho\[id\]\),\s*id,\s*'',\s*current,\s*\)/,
    'the echo merges into the aggregate BEFORE the workspace derive (one place, no second state copy)',
  )
  // 2026-09-11 review-fix (finding 4f): `locale` is REQUIRED in both places, not
  // an optional suffix — a mutation that dropped it from the call or the memo
  // deps used to keep this lock green (the echoed row would still paint, but the
  // frame copy the derive assembles would freeze in its first-render locale).
  assert.match(
    app,
    /\) => deriveServers\([\s\S]*?workspaceEcho, openIntents, locale\),\n    \[health, [^\]]*workspaceEcho, openIntents, locale\],/,
    'the ledger plus the frame locale must be both derive inputs and memo dependencies, otherwise the echoed row never paints',
  )
})

test('every exit retires the echo: authoritative push reconciliation and source retirement', () => {
  const app = read('../src/App.tsx')
  // The push tick sweeps (TTL) and then reconciles what the authoritative list now covers;
  // the reconcile input is the swept ledger, not the raw ref — see the TTL wiring test.
  const reconcile = app.indexOf('reconcilePendingWorkspaces(swept, sourceId, snapshot.workspaces)')
  const identityCheck = app.indexOf('if (!readyAggregateSourcesRef.current.has(sourceId)) return', reconcile)
  assert.notEqual(reconcile, -1, 'a mounted push must retire what it now covers')
  assert.ok(
    identityCheck > reconcile,
    'the reconciliation must run BEFORE the ready gate: workspace identity is authoritative even on a not-ready generation',
  )
  assert.match(
    app,
    /updateWorkspaceEcho\(forgetPendingWorkspaces\(workspaceEchoRef\.current, retired\)\)/,
    'a retired source must not leave a phantom workspace row behind for a same-id re-add',
  )
})

test('the echo TTL ticks on every clock the App owns (create, push, fallback pull)', () => {
  // The TTL is a leak guard, not a convergence budget: an echo whose
  // authoritative convergence never arrives (a source that is never mounted
  // again, a workspace deleted on the host by another client) must still expire.
  // Sweeping only inside the create handler — the first implementation — left
  // such an entry alive for the rest of the session. Each tick is pinned here
  // because every one of them is a silent no-op when it goes missing.
  const app = read('../src/App.tsx')
  assert.match(
    app,
    /const sweepWorkspaceEcho = useCallback\(\(\): void => \{\s*const next = sweepPendingWorkspaces\(workspaceEchoRef\.current, Date\.now\(\)\)/,
    'the sweep helper must be the single expiring entry point',
  )
  assert.match(
    app,
    /let ledger = sweepPendingWorkspaces\(workspaceEchoRef\.current, now\)/,
    'create tick: the recording handler sweeps before it records',
  )
  assert.match(
    app,
    /const swept = sweepPendingWorkspaces\(workspaceEchoRef\.current, Date\.now\(\)\)\s*const reconciled = reconcilePendingWorkspaces\(swept, sourceId, snapshot\.workspaces\)/,
    'push tick: the authoritative mounted push sweeps and then reconciles',
  )
  assert.match(
    app,
    /clearAggregateRetry\(instanceId\)[\s\S]{0,400}?sweepWorkspaceEcho\(\)/,
    'pull tick: the 30s unary fallback pull is the only clock an unmounted source has',
  )
  assert.match(
    app,
    /\}, \[clearAggregateRetry, refreshHealth, sweepWorkspaceEcho\]\)/,
    'the pull path must depend on the sweep helper it calls',
  )
})

test('the echo’s withdraw/rewrite facts (removed / renamed) are fenced and go through the same ledger path', () => {
  // 2026-09-11 review S3 + F4: a create-only echo has no exit. A row the user
  // deletes right after creating it stays a GHOST — the authoritative push only
  // retires entries it LISTS, so a workspace it cannot show until the 10-min TTL
  // is unreachable — and a rename looks like a no-op (the ledger derives the
  // title from the path). These two subscriptions are the fix; every link is a
  // silent no-op when it goes missing, so each one is pinned. Comments are
  // stripped before matching: the invariants are described in the prose right
  // above the code, so a raw-text lock could be satisfied by a comment
  // (panel-wiring.test.ts precedent).
  const code = stripComments(read('../src/App.tsx'))
  const handlers = new Map<string, string>()
  for (const name of ['onWorkspaceRemoved', 'onWorkspaceRenamed']) {
    const at = code.indexOf(`return chamberBridge.${name}((fact) => {`)
    assert.notEqual(at, -1, `${name} must stay subscribed (the sidebar publishes it; nobody else owns the ledger)`)
    // The subscription must be RETURNED: the effect's cleanup is the bridge's
    // own unsubscribe, so an unmounted App cannot keep writing the ledger.
    const end = code.indexOf('}, [updateWorkspaceEcho])', at)
    assert.notEqual(end, -1, `${name} must keep the create fact's effect shape (unsubscribe returned, ledger dep)`)
    handlers.set(name, code.slice(at, end))
  }
  for (const [name, body] of handlers) {
    assert.match(
      body,
      /if \(sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef\.current\.has\(sourceId\)\) return/,
      `${name} must drop a source that left the registry (same fence as onWorkspaceCreated)`,
    )
    assert.match(
      body,
      /const owner = sourceLifecyclesRef\.current!\.capture\(sourceId\)/,
      `${name} must capture the source lifecycle — a stale fact must not enter a new incarnation's ledger`,
    )
    assert.match(body, /if \(owner === null\) return/, `${name} must not write the ledger without an owner`)
    assert.match(
      body,
      /if \((?:next|ledger) !== workspaceEchoRef\.current\) updateWorkspaceEcho\((?:next|ledger)\)/,
      `${name} must write through the identity-preserving updateWorkspaceEcho path (the App stays the only owner)`,
    )
  }
  assert.match(
    handlers.get('onWorkspaceRemoved')!,
    /let ledger = sweepPendingWorkspaces\(workspaceEchoRef\.current, Date\.now\(\)\)\s*ledger = removePendingWorkspace\(ledger, sourceId, \{ workspaceId: fact\.workspaceId, path: fact\.path \}\)/,
    'a removal sweeps (it changes what the list SHOULD contain) and drops the pending row by host id AND path (the id may never have been recorded)',
  )
  assert.match(
    handlers.get('onWorkspaceRenamed')!,
    /renamePendingWorkspace\(\s*workspaceEchoRef\.current,\s*sourceId,\s*fact\.workspaceId,\s*fact\.title,\s*\)/,
    'a rename must rewrite the pending row’s title instead of leaving the path-derived one',
  )
})
