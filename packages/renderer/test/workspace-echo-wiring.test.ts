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
  assert.match(
    app,
    /\) => deriveServers\([\s\S]*?workspaceEcho(?:, openIntents)?\),\n    \[health, [^\]]*workspaceEcho(?:, openIntents)?\],/,
    'the ledger must be both a derive input and a memo dependency, otherwise the echoed row never paints',
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
