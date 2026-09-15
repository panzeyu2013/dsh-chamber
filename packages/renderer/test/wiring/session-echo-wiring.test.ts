/**
 * Wiring contract for the session-creation echo (design 05 §2.2 revision
 * 2026-12; the session-side sibling of the workspace echo).
 *
 * `App.tsx` cannot be imported by a node test (it renders the whole shell), so
 * this follows the repo's established source-text contract pattern
 * (`workspace-echo-wiring.test.ts`): a green run proves the SHAPE, not the
 * behaviour — the behaviour is covered by the sidebar package's
 * `session-echo.test.ts` (echo/projection/convergence rules) and
 * `session-mutations.test.ts` (the bridge facts).
 *
 * Every link here is a silent no-op when it goes missing: the single funnel
 * (sidebar shared/session-mutations.ts) creates the session and never publishes
 * the fact, the App never records it, the derive never merges it (so the row
 * vanishes again as soon as the mounted push REPLACES the aggregate from a
 * summary store that does not list it — the exact field report), the official
 * session-list refresh is never requested (the mounted ctx never re-reads the
 * corpus, so the echo has to carry the row for its whole TTL), or nothing ever
 * retires the entry (a phantom row that survives the authoritative baseline).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../support/source-text.ts'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('the single funnel publishes the HOST session id right after a successful create/fork', () => {
  const sidebar = read('../../../dsh-chamber-client-ui-sidebar/src/client/SidebarRoot.tsx')
  const funnel = read('../../../dsh-chamber-client-ui-sidebar/src/shared/session-mutations.ts')
  const git = read('../../../dsh-chamber-client-ui-git/src/shared/coordinator.ts')
  const create = funnel.indexOf('await createSession(getInstanceClient(sourceId), workspaceId, options.sessionId)')
  const report = funnel.indexOf('chamberBridge.reportSessionCreated({')
  assert.notEqual(create, -1, 'the funnel performs the create wire call')
  assert.ok(report > create, 'the echo fact is published only after the host accepted the create')
  assert.match(funnel, /sessionId,\s*\n\s*workspaceId,\s*\n\s*blank: true,/, 'the created fact carries the host session id, its workspace and the blank flag')
  assert.match(funnel, /const childId = await forkSession\(getInstanceClient\(sourceId\), sessionId\)/, 'fork goes through the same funnel')
  assert.match(funnel, /parentSessionId: sessionId,/, 'the fork child carries its parent so the App can resolve its workspace')
  assert.match(funnel, /blank: false,/, 'a fork child inherits content — it is not the provisional blank row')
  assert.match(funnel, /await archiveSession\(getInstanceClient\(sourceId\), sessionId\)/, 'archive is the funnel\'s withdraw half')
  assert.match(funnel, /chamberBridge\.reportSessionRemoved\(\{ sourceId, sessionId \}\)/, 'the archive fact is published after the wire accepts it')
  assert.match(sidebar, /createSessionForSource\(server\.id, workspaceId\)/, 'the sidebar "+" goes through the funnel')
  assert.match(sidebar, /forkSessionForSource\(/, 'the session row menu\'s fork goes through the funnel')
  assert.match(sidebar, /archiveSessionForSource\(server\.id, sessionId\)/, 'the archive verb goes through the funnel')
  assert.doesNotMatch(sidebar, /chamberBridge\.reportSessionCreated/, 'no call site publishes the fact itself')
  assert.match(git, /createSessionForSource\(sourceId, workspaceId, \{ sessionId/, 'the Git plugin\'s session creates go through the funnel too (the second-entry-point lesson)')
})

test('the App records the fact in a lifespan-scoped ledger (state + synchronous ref mirror)', () => {
  const app = read('../../src/App.tsx')
  assert.match(app, /const \[sessionEcho, setSessionEcho\] = useState<SessionEchoLedger>\(\{\}\)/)
  assert.match(app, /const sessionEchoRef = useRef<SessionEchoLedger>\(\{\}\)/)
  assert.match(app, /const updateSessionEcho = useCallback\(\(next: SessionEchoLedger\): void => \{/)
  // The subscription must be fenced exactly like every other source-scoped
  // handler: a dead source and an ownership mismatch must not enter the ledger.
  assert.match(app, /return chamberBridge\.onSessionCreated\(\(fact\) => \{/)
  assert.match(app, /const owner = sourceLifecyclesRef\.current!\.capture\(sourceId\)/)
  assert.match(app, /const owner = sourceLifecyclesRef\.current!\.capture\(sourceId\)[\s\S]{0,200}?if \(owner === null\) return/)
  // Membership resolution: the fact's workspace id first, the parent's workspace
  // second (a fork child belongs to its parent's directory), path from the row.
  assert.match(app, /workspaces\.find\(workspace => workspace\.workspaceId === fact\.workspaceId\)/)
  assert.match(app, /workspaces\.find\(workspace => workspace\.sessionIds\.includes\(parentId\)\)/)
  assert.match(app, /ledger = recordPendingSession\(ledger, sourceId, \{/)
  assert.match(app, /blank: fact\.blank,/)
  // The official convergence seam: without it the mounted ctx never re-reads
  // the corpus and the echo carries the row for its whole TTL.
  const at = app.indexOf('return chamberBridge.onSessionCreated((fact) => {')
  const end = app.indexOf('}, [updateSessionEcho])', at)
  assert.notEqual(end, -1, 'the create subscription must return the unsubscribe (effect cleanup)')
  assert.match(
    app.slice(at, end),
    /chamberBridge\.requestSessionListRefresh\(sourceId\)/,
    'the fact must ask that source\'s mounted ctx to re-run its official session-list refresh',
  )
})

test('the projection merges the echo at the single derive choke point', () => {
  const app = read('../../src/App.tsx')
  assert.match(
    app,
    /function deriveServers\([\s\S]*?sessionEcho: SessionEchoLedger,/,
    'deriveServers takes the session ledger',
  )
  assert.match(
    app,
    /function deriveServers\([\s\S]*?sessionArchive: SessionArchiveLedger,/,
    'deriveServers takes the local archive tombstone ledger too',
  )
  assert.match(
    app,
    /workspaces = deriveServerWorkspaces\([\s\S]*?withSessionEcho\(\s*withWorkspaceEcho\(withPendingArchives\(aggregate, sessionArchive\[id\]\), workspaceEcho\[id\]\),\s*sessionEcho\[id\],\s*\),/,
    'the three local facts merge at ONE choke point in a load-bearing order: archive tombstones first (they also hide a same-id creation echo), then the workspace echo (a session created in a just-echoed workspace must find that row), then the session echo',
  )
  assert.match(
    app,
    /\) => deriveServers\([\s\S]*?sessionEcho, sessionArchive, openIntents, locale\),\n    \[health, [^\]]*sessionEcho, sessionArchive, openIntents, locale\],/,
    'both ledgers must be derive inputs AND memo dependencies, otherwise the rows never paint',
  )
})

test('every exit retires the echo: authoritative push, unmounted pull, retirement, TTL', () => {
  const app = read('../../src/App.tsx')
  // Push tick: the authoritative membership is the convergence signal.
  assert.match(
    app,
    /const swept = sweepPendingSessions\(sessionEchoRef\.current, Date\.now\(\)\)\s*const reconciled = reconcilePendingSessions\(swept, sourceId, snapshot\.workspaces\)\s*if \(reconciled !== sessionEchoRef\.current\) updateSessionEcho\(reconciled\)/,
    'a mounted push must retire what it now ACCOUNTS (workspace membership), not merely what it lists',
  )
  // Pull tick: an unmounted source's cwd-derived groups are its projection
  // workspaces, so a listing pull converges there; a pushed source must NOT
  // converge against the fallback's synthetic rows (that would re-home the row).
  assert.match(
    app,
    /sweepSessionEcho\(\)\s*if \(snapshotSourcesRef\.current\[instanceId\] !== true\) \{\s*const reconciled = reconcilePendingSessions\(sessionEchoRef\.current, instanceId, snapshot\.workspaces\)/,
    'the fallback pull is the only clock an unmounted source has, and it must not converge a pushed source',
  )
  assert.match(
    app,
    /\}, \[clearAggregateRetry, refreshHealth, sweepSessionArchive, sweepSessionEcho, sweepWorkspaceEcho, updateSessionArchive, updateSessionEcho\]\)/,
    'the pull path must depend on every clock it touches',
  )
  // TTL helper + the create tick that sweeps before it records.
  assert.match(
    app,
    /const sweepSessionEcho = useCallback\(\(\): void => \{\s*const next = sweepPendingSessions\(sessionEchoRef\.current, Date\.now\(\)\)/,
  )
  assert.match(app, /let ledger = sweepPendingSessions\(sessionEchoRef\.current, now\)/)
  // Retirement with the source generation.
  assert.match(app, /updateSessionEcho\(forgetPendingSessions\(sessionEchoRef\.current, retired\)\)/)
})

test('the echo’s withdraw half is fenced and writes through the same ledger path', () => {
  const code = stripComments(read('../../src/App.tsx'))
  const at = code.indexOf('return chamberBridge.onSessionRemoved((fact) => {')
  assert.notEqual(at, -1, 'onSessionRemoved must stay subscribed (the funnel publishes it; nobody else owns the ledger)')
  const end = code.indexOf('}, [updateSessionArchive, updateSessionEcho])', at)
  assert.notEqual(end, -1, 'the removal subscription must keep the create fact\'s effect shape (unsubscribe returned, ledger deps)')
  const body = code.slice(at, end)
  assert.match(
    body,
    /if \(sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef\.current\.has\(sourceId\)\) return/,
    'a source that left the registry must be dropped (same fence as the create fact)',
  )
  assert.match(body, /const owner = sourceLifecyclesRef\.current!\.capture\(sourceId\)/, 'the lifecycle must be captured')
  assert.match(body, /if \(owner === null\) return/)
  assert.match(
    body,
    /const withoutPending = removePendingSession\(sessionEchoRef\.current, sourceId, fact\.sessionId\)\s*if \(withoutPending !== sessionEchoRef\.current\) updateSessionEcho\(withoutPending\)/,
    'an archive retires a pending creation row through the identity-preserving ledger path',
  )
  assert.match(
    body,
    /const swept = sweepPendingArchives\(sessionArchiveRef\.current, now\)\s*const archived = recordPendingArchive\(swept, sourceId, fact\.sessionId, now\)\s*if \(archived !== sessionArchiveRef\.current\) updateSessionArchive\(archived\)/,
    'and records the local archive tombstone that hides the row on an UNMOUNTED source',
  )
})

test('the local archive tombstone is a first-class ledger with authoritative-only convergence', () => {
  const app = read('../../src/App.tsx')
  // Lifespan-scoped ledger: state + synchronous ref mirror + one write path.
  assert.match(app, /const \[sessionArchive, setSessionArchive\] = useState<SessionArchiveLedger>\(\{\}\)/)
  assert.match(app, /const sessionArchiveRef = useRef<SessionArchiveLedger>\(\{\}\)/)
  assert.match(app, /const updateSessionArchive = useCallback\(\(next: SessionArchiveLedger\): void => \{/)
  assert.match(
    app,
    /const sweepSessionArchive = useCallback\(\(\): void => \{\s*const next = sweepPendingArchives\(sessionArchiveRef\.current, Date\.now\(\)\)/,
    'the lease-expiry tick must exist as its own identity-preserving helper',
  )
  // Push tick: ONLY the authoritative set converges (the unary fallback's empty
  // set is a known-degraded artifact — converging on it would un-hide everything).
  assert.match(
    app,
    /if \(snapshot\.archiveSetKnown === true\) \{\s*reconcileArchiveEchoes\(sourceId, snapshot\.archivedSessionIds\)\s*\}/,
    'the mounted push retires covered tombstones, gated on archive-set provenance',
  )
  assert.match(
    app,
    /const reconcileArchiveEchoes = useCallback\(\(sourceId: string, archivedSessionIds: readonly string\[\]\): void => \{/,
    'the convergence must be one funnel, not per-call-site filtering',
  )
  // Pull tick: the lease is refreshed from the listing that still shows the row;
  // the fallback's (empty) archive set is never used to converge.
  assert.match(
    app,
    /const listed = new Set\(snapshot\.sessions\.map\(session => session\.sessionId\)\)\s*const leased = refreshPendingArchives\(sessionArchiveRef\.current, instanceId, listed, Date\.now\(\)\)[\s\S]{0,400}?sweepSessionArchive\(\)/,
    'the lease is renewed BEFORE the ledger-wide sweep, otherwise a source that was offline past the window loses its tombstone to another source pull and the archived row resurfaces',
  )
  assert.match(app, /updateSessionArchive\(forgetPendingArchives\(sessionArchiveRef\.current, retired\)\)/)
})
