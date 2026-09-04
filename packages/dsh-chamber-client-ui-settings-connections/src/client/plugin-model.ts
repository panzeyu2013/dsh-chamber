/**
 * The unified plugin-management MODEL layer (design 21 §6.6, refactor step ①
 * — pure model first, UI wiring later; design 21 §3 single-model matrix).
 *
 * This module is the pure, UI-free and backend-free core of the unified model
 * view that PluginSyncModal evolves into (§6.6 direction): intent ordering
 * (remove before add), batch failure policy (the SINGLE definition shared by
 * the ssh and gateway flows), apply-result normalization for both backends,
 * the gateway task projection → row model, the v1 undo derive (撤销最近变更,
 * §6.4/§6.8 r2), the reserved-name filter and the backend dispatch table.
 *
 * Discipline notes:
 * - PURE + LOCALE-FREE: imports nothing, touches no window/ambient surface,
 *   returns no localized copy — plain node can run every function. Phase 5C
 *   owns the zh/en key table; only the doc-only batch-policy sentence keeps an
 *   unlocalized English constant here (§6.6 policy 文案如实呈现; zh wording in
 *   the comment, keyed in 5C).
 * - MIRROR DISCIPLINE: ambient types (src/global.d.ts re-export of the
 *   renderer's global.d.ts) own the WINDOW surface. This module never imports
 *   them — every IPC/wire shape it consumes is declared as a LOCAL structural
 *   twin below, named *Shape, with the authority cited in the comment (the
 *   ipc-surface-mirror test in packages/desktop pins the preload ↔ renderer
 *   sides; these twins pin the renderer → model read). The reserved-name
 *   predicate is a hand mirror of the Node-side control-plane single source
 *   (packages/control-plane/src/plugin-spec.ts — the browser cannot import
 *   it), the ADD_SPEC precedent; a lockstep test (test/plugin-model.test.ts)
 *   pins the mirror textually.
 */

/* ---------------------------------------------------------------------------
 * 1. Reserved-name deny mirror (design 21 §6.2/§6.7 decision 19)
 * ---------------------------------------------------------------------------
 * Renderer hand-mirror of control-plane plugin-spec.ts isDeniedPluginName
 * (ADD_SPEC precedent: the web chain cannot import the Node-side module; the
 * lockstep test in test/plugin-model.test.ts compares the two predicate
 * bodies textually). Both the official domain (@deepseek-ai/*) and the
 * chamber domain (@dsh-chamber/* — seeded host packages, self-built client
 * plugins, the mobile exception) are chamber-managed and can never be
 * installed/removed through the plugin model. The prefix match stays correct
 * even if a versioned `@scope/name@ver` string reaches it.
 */
export function isDeniedPluginName(name: string): boolean {
  return name.startsWith('@deepseek-ai/') || name.startsWith('@dsh-chamber/')
}

/* ---------------------------------------------------------------------------
 * 2. Intent model (design 21 §3 matrix row: apply({add[], remove[], defer}))
 * ---------------------------------------------------------------------------
 * The ordered intent a batch apply submits: removes FIRST, then adds
 * (decision 5 — remove releases the old layer before the new one installs),
 * input order preserved within each group, duplicates stripped (first
 * occurrence wins per group).
 */

/** One registry add: name plus its registry spec (bare name = install
 *  latest; `name@range` = pinned). Materialize rows never ride the batch
 *  add — they submit per-row through the backend materialize verb. */
export interface ModelPluginAdd {
  name: string
  spec: string
}

/** Raw batch intent (as the view builds it from checked rows). */
export interface ApplyInput {
  add: ModelPluginAdd[]
  remove: string[]
  /** true = record the change only; the restart-to-apply is deferred. */
  defer: boolean
}

/** The ordered, de-duplicated, net-coalesced batch. */
export interface OrderedApplyOps {
  /** Removes in input order (net rule already applied). */
  removes: string[]
  /** Adds in input order, first occurrence per name kept. */
  adds: ModelPluginAdd[]
  defer: boolean
  /** Remove entries dropped by the NET rule: the same name is also added, so
   *  the remove would be a no-op preface — the re-add wins (final effect =
   *  the name is added). Only cross-list drops are reported; intra-group
   *  duplicates are pure no-ops and drop silently. */
  coalesced: string[]
}

export function orderApplyOps(input: ApplyInput): OrderedApplyOps {
  const removals: string[] = []
  const seenRemove = new Set<string>()
  for (const name of input.remove) {
    if (seenRemove.has(name)) continue
    seenRemove.add(name)
    removals.push(name)
  }
  const additions: ModelPluginAdd[] = []
  const seenAdd = new Set<string>()
  for (const add of input.add) {
    if (seenAdd.has(add.name)) continue
    seenAdd.add(add.name)
    additions.push(add)
  }
  const addedNames = new Set(additions.map(add => add.name))
  const coalesced: string[] = []
  const removes = removals.filter(name => {
    if (addedNames.has(name)) {
      coalesced.push(name)
      return false
    }
    return true
  })
  return { removes, adds: additions, defer: input.defer, coalesced }
}

/* ---------------------------------------------------------------------------
 * 3. Apply-result normalization (both backends → one outcome)
 * ---------------------------------------------------------------------------
 * The unified outcome the result surface renders (partial「已完成 n/m」、
 * cancelled、failed copy, §6.6). Per-name attribution: the gateway result
 * names its installed/removed ops; the ssh result reports COUNTS only (see
 * classifySshApplyResult), so its executed arm carries empty name lists and
 * the view attributes per-row outcomes from result.failed against its own
 * submitted rows. The ssh producer's fail-loud ok:true states (verified /
 * ready recheck, plugin-sync.ts applyPlugins ④/⑤) are PRESERVED as markers
 * on the executed summary — the ssh modal renders them loudly today
 * (PluginSyncModal.tsx:837-843) and the unified result surface must keep
 * doing so (ssh 等价 is the refactor's load-bearing wall); the gateway
 * ok:true arm carries no such members.
 */

/** Local structural twin of the desktop gateway_plugin_apply IPC union
 *  (authority: renderer global.d.ts GatewayPluginApplyIpcResult / desktop
 *  preload.cts; mirror discipline — the window type stays ambient, the pure
 *  module reads its own twin). */
export type GatewayApplyShape =
  | { ok: true; cancelled: true }
  | { ok: true; installed: string[]; removed: string[]; restarted: boolean; deferred?: boolean }
  | { ok: false; error: string; partial?: { installed: string[]; removed: string[] } }

/** Local structural twin of the ssh plugin_apply result projection
 *  (authority: renderer global.d.ts PluginApplyResult / desktop preload.cts
 *  SshPluginApplyResult — desktop plugin-sync.ts applyPlugins producer). */
export interface SshApplyResultShape {
  /** Ops that executed successfully (removes + adds). */
  applied: number
  /** Ops never attempted (refused up front by whitelist/deny/skip policy —
   *  never a user dismissal: ssh plugin_apply has no cancellation path; the
   *  v1 producer always reports 0 here — whole-batch refusals surface as
   *  ok:false, per-item failures land in failed[]). */
  skipped: number
  /** Per-item failures (single-item isolation — never blocks the rest). */
  failed: { spec: string; error: string }[]
  restarted: boolean
  deferred: boolean
  verified: boolean
  ready: boolean | null
  readyNote?: string
}

/** Local structural twin of the ssh plugin_apply IPC union (authority:
 *  renderer global.d.ts DesktopSshSurface.plugin_apply / desktop preload.cts
 *  SshPluginApplyIpcResult — ipc-surface-mirror.test.ts pins the producer
 *  union). NO `{ok:true,cancelled:true}` arm: the ssh apply handler has no
 *  confirmation dialog or picker to dismiss (design 21 §10 — the ssh apply
 *  confirm gap is a registered open item), so the twin carries no cancelled
 *  arm — the gateway twin keeps it (classifyGatewayApplyResult). */
export type SshApplyShape =
  | { ok: true; result: SshApplyResultShape }
  | { ok: false; error: string }

/** What a fully executed batch reports (name attribution is backend-shaped:
 *  the gateway names its ops; the ssh result reports counts only → empty
 *  lists, see classifySshApplyResult). */
export interface ApplyExecutedSummary {
  removed: string[]
  installed: string[]
  restarted: boolean
  deferred: boolean
  /** ssh FAIL-LOUD markers (the ssh producer reports these INSIDE ok:true —
   *  applyPlugins asserts and re-checks readiness itself, plugin-sync.ts
   *  ④/⑤). The result surface MUST render any present marker (the ssh modal
   *  equivalents are pluginsVerifyFailed / pluginsReadyFailed / the readyNote
   *  verbatim, PluginSyncModal.tsx:837-843) — an executed summary with these
   *  members absent is the only shape that may render as a clean success.
   *  The gateway ok:true arm never carries them (its execution failures land
   *  in the task journal as per-op rows, never inside the apply result).
   *  Presence-based, mirroring the producer's loud set:
   *  verified:false = the post-apply package.json assertion failed — loud,
   *  no rollback; verified:true is omitted (clean).
   *  ready:false = a restart executed but the bounded readiness recheck
   *  failed. ready:null + readyNote = a restart executed but readiness was
   *  NOT re-checked (the instance was not connected before restart) —
   *  readyNote carries why; a bare ready:null without a note (nothing
   *  attempted / deferred) is not loud and stays omitted. */
  verified?: false
  ready?: false | null
  readyNote?: string
}

/** Normalized apply outcome. `cancelled` = the user dismissed the
 *  confirmation (nothing ran). `executed` = the batch ran (per-item failures
 *  included via `partial`); `partial.done/total` = executed ops out of the
 *  attempted batch. `failed` = the batch was refused/loudly failed before
 *  completing; partialDone/partialTotal carry what ran before it. */
export type ApplyOutcome =
  | { cancelled: true }
  | {
    executed: ApplyExecutedSummary
    partial?: { done: number; total: number }
  }
  | { failed: { error: string; partialDone: number; partialTotal: number } }

/** Classify a gateway_plugin_apply IPC result. An ok:true gateway arm means
 *  the whole batch was accepted (execution failures surface in the task
 *  journal, never inside this result) → executed without partial; the
 *  optional `deferred` member defaults to false. An ok:false arm reports the
 *  partial ops the executor accepted before the failure; `attemptedOps`
 *  (adds + removes submitted) turns that into the honest n/m total — when
 *  omitted, the total degrades to the backend-reported count (n/n). */
export function classifyGatewayApplyResult(result: GatewayApplyShape, attemptedOps?: number): ApplyOutcome {
  if (result.ok) {
    if ('cancelled' in result) return { cancelled: true }
    return {
      executed: {
        removed: result.removed,
        installed: result.installed,
        restarted: result.restarted,
        deferred: result.deferred ?? false,
      },
    }
  }
  const partialDone = result.partial === undefined
    ? 0
    : result.partial.installed.length + result.partial.removed.length
  return {
    failed: {
      error: result.error,
      partialDone,
      partialTotal: attemptedOps ?? partialDone,
    },
  }
}

/** Classify a plugin_apply (ssh) IPC result. ok:true with per-item failures
 *  is still an EXECUTED batch (single-item isolation, design 13 §4.5) with
 *  partial {done: applied, total: applied + failed} — skipped ops were never
 *  attempted and do not count toward the total. The ssh result carries no
 *  per-name success list, so the executed arm's removed/installed stay []
 *  (the view merges result.failed against its own submitted rows). The
 *  producer's fail-loud ok:true states are PRESERVED, never collapsed into a
 *  clean success: verified:false and ready:false/readyNote ride onto the
 *  executed summary as presence-based markers (ApplyExecutedSummary) the
 *  result surface must render. An ok:false arm is a wholesale refusal
 *  (single-flight / invalid input) — nothing of the registry batch ran;
 *  `attemptedOps` supplies the total when the caller wants an n/m frame
 *  (defaults to 0 = render no counts). */
export function classifySshApplyResult(result: SshApplyShape, attemptedOps?: number): Exclude<ApplyOutcome, { cancelled: true }> {
  if (!result.ok) {
    return { failed: { error: result.error, partialDone: 0, partialTotal: attemptedOps ?? 0 } }
  }
  // No cancelled arm: plugin_apply has no cancellation path (the ssh apply
  // confirm gap, design 21 §10) — the only cancelled producer is the gateway
  // apply, classified by classifyGatewayApplyResult.
  const r = result.result
  const partial = r.failed.length > 0
    ? { done: r.applied, total: r.applied + r.failed.length }
    : undefined
  const executed: ApplyExecutedSummary = {
    removed: [],
    installed: [],
    restarted: r.restarted,
    deferred: r.deferred,
  }
  // Fail-loud markers (plugin-sync.ts applyPlugins ④ assertion + ⑤ ready
  // recheck): presence mirrors exactly what the ssh modal renders loudly —
  // verified false, a failed ready recheck (false), or a skipped recheck
  // with its readyNote. Everything else stays absent (clean).
  if (r.verified === false) executed.verified = false
  if (r.ready === false) executed.ready = false
  else if (r.readyNote !== undefined) {
    executed.ready = null
    executed.readyNote = r.readyNote
  }
  return partial === undefined ? { executed } : { executed, partial }
}

/** The n/m progress projection of an outcome: cancelled → null; executed →
 *  its partial (null when nothing was partial — full success); failed → the
 *  backend-reported done/total pair. */
export function partialCounts(outcome: ApplyOutcome): { done: number; total: number } | null {
  if ('cancelled' in outcome) return null
  if ('failed' in outcome) {
    return { done: outcome.failed.partialDone, total: outcome.failed.partialTotal }
  }
  return outcome.partial ?? null
}

/* ---------------------------------------------------------------------------
 * 4. Batch failure policy — the SINGLE definition (design 21 §6.6)
 * ---------------------------------------------------------------------------
 * 「失败即停」与逐行隔离的分界，模型层单一定义（zh 措辞 5C 键表落位）：
 * - 提交面 fail-fast：registry/remove 整批一次提交（一次确认）；任一提交/
 *   预检拒绝即停——整批不执行（gateway 提交面 queue_busy/invalid/reserved，
 *   ssh 预检 invalid/single-flight；分类的 failed 整批拒绝臂）；
 * - 进入执行后 ssh 逐行串行隔离（plugin-sync.ts applyPlugins ②）：单行失败
 *   不阻塞后续行、不吞没已执行行——如实 partial（executed+partial 臂）。即
 *   「失败即停」描述提交边界，不描述 ssh 执行期；
 * - materialize 恒逐行隔离（单实体失败不阻塞其余行，与 AGENTS「one failed
 *   entity must not block the rest」一致）。
 * describeBatchPolicy 仅 doc-only（无 key 的英文常句，UI 一律走键）。
 */

/** The two failure regimes (design 21 §6.6 single definition):
 *  registryAndRemove = 'fail-fast' means the registry/remove BATCH fails fast
 *  at its submission/refusal boundary — a wholesale refusal (gateway
 *  submission surface, ssh pre-flight) aborts the whole batch; it does NOT
 *  describe ssh execution-time row failures, which are serially isolated and
 *  surface as an executed+partial outcome. materializeRows = 'isolated' in
 *  every phase. */
export const BATCH_FAILURE_POLICY = {
  registryAndRemove: 'fail-fast',
  materializeRows: 'isolated',
} as const

/** Doc-only policy sentence (unlocalized; 5C key table owns the zh/en copy):
 *  the registry/remove batch submits as one fail-fast unit — a submission or
 *  pre-flight refusal aborts the whole batch — while accepted ssh executions
 *  run serially per-row isolated (executed rows report honestly as partial)
 *  and materialize rows stay isolated per row: a failed row never blocks the
 *  rest. */
export const BATCH_POLICY_SENTENCE =
  'The registry/remove batch submits as one unit and fails fast on any refusal (gateway submission surface / ssh pre-flight); accepted ssh executions run serially per-row isolated and report executed rows honestly as partial, and materialize rows stay isolated — a failed row never blocks the rest.'

export function describeBatchPolicy(): string {
  return BATCH_POLICY_SENTENCE
}

/* ---------------------------------------------------------------------------
 * 5. Gateway task projection → row model (design 21 §6.2/§6.3; GET
 * /chamber/plugins/tasks — read side of the 202 contract)
 * ---------------------------------------------------------------------------
 * The task endpoint answers {ok:true, tasks: JournalOp[], deferred:
 * DeferredIntent[], busy} (packages/gateway/src/routes.ts 1146-1150):
 * journal ops newest-first (retention-capped) + durable deferred install
 * intents (awaiting a ready edge) + the executor busy flag. The projection
 * maps BOTH arrays into one row model — deferred intents first (they are the
 * future queue, not journal history), then the journal ops in wire order.
 */

export type TaskStatus = 'pending' | 'ok' | 'failed' | 'blocked'

/** One projected row: a journal op or a deferred intent. */
export interface TaskRow {
  /** Journal op id; '' for a deferred intent that has no journal op yet (the
   *  drained op receives its own opId later). */
  opId: string
  kind: 'install' | 'remove' | 'materialize'
  name: string
  /** Registry spec / materialized path; journaled for install/materialize
   *  only — null for removes and for unknown specs. */
  spec: string | null
  status: TaskStatus
  error: string | null
  /** Post-mutation restart outcome; null when none was recorded. */
  restarted: 'ok' | 'failed' | 'skipped' | null
  /** Epoch-ms record time. */
  ts: number
  /** true for deferred-intent rows (awaiting a ready edge, not yet an op). */
  deferred: boolean
  /** Deferred-intent id; null for journal-op rows. */
  intentId: string | null
}

/** Structural twin of the gateway JournalOp (authority:
 *  packages/gateway/src/plugins-journal.ts) — full fidelity so the projection
 *  cannot drift from the wire. */
export interface GatewayJournalOpShape {
  id: string
  ts: number
  kind: 'install' | 'remove' | 'materialize'
  name: string
  spec?: string
  /** Reference to the pre-mutation backup dir (backups/<op-id>/) when the
   *  executor placed one, null otherwise. */
  preImage: string | null
  initiator?: string
  status: 'pending' | 'ok' | 'failed' | 'blocked'
  error?: string
  restarted?: 'ok' | 'failed' | 'skipped'
}

/** Structural twin of the gateway DeferredIntent (authority:
 *  packages/gateway/src/plugins-tasks.ts — install/materialize only; remove
 *  is never deferred). */
export interface GatewayDeferredIntentShape {
  id: string
  ts: number
  kind: 'install' | 'materialize'
  name: string
  spec?: string
  initiator?: string
}

/** Structural twin of GET /chamber/plugins/tasks 200 body (authority:
 *  packages/gateway/src/routes.ts — {ok:true, ...tasksProjection} where
 *  tasksProjection = PluginTaskTasksProjection). */
export interface GatewayTasksShape {
  ok: true
  /** Journal ops, newest first (retention-capped). */
  tasks: GatewayJournalOpShape[]
  /** Durable deferred intents (newest first). */
  deferred: GatewayDeferredIntentShape[]
  /** True while the executor has a mutation in flight. */
  busy: boolean
}

/** Project the gateway task shape into the row model. Group order contract:
 *  deferred-intent rows first (each pending, deferred:true, intentId set),
 *  then journal-op rows in wire order (newest first). */
export function projectTasks(shape: GatewayTasksShape): { rows: TaskRow[]; busy: boolean } {
  const rows: TaskRow[] = []
  for (const intent of shape.deferred) {
    rows.push({
      opId: '',
      kind: intent.kind,
      name: intent.name,
      spec: intent.spec ?? null,
      status: 'pending',
      error: null,
      restarted: null,
      ts: intent.ts,
      deferred: true,
      intentId: intent.id,
    })
  }
  for (const op of shape.tasks) {
    rows.push({
      opId: op.id,
      kind: op.kind,
      name: op.name,
      spec: op.spec ?? null,
      status: op.status,
      error: op.error ?? null,
      restarted: op.restarted ?? null,
      ts: op.ts,
      deferred: false,
      intentId: null,
    })
  }
  return { rows, busy: shape.busy }
}

/* ---------------------------------------------------------------------------
 * 6. Undo derive for 「撤销最近变更」(design 21 §6.4/§6.8 r2) — v1 policy
 * ---------------------------------------------------------------------------
 * V1 (UNDO_V1_POLICY = 'ok-only'): only ops that actually took effect are
 * undoable — a failed/blocked op never is (its recovery belongs to the
 * r2-r4 恢复阶梯 flows, driven backend-side from the journal + preImage
 * backups, not to this ok-only derive). Undoing an executed install/
 * materialize = removing the name it installed (materialize undo = remove of
 * the name it installed — the preImage-restore true undo of a later phase is
 * backend-side). An executed REMOVE cannot be synthesized here: the tasks
 * projection journals specs only for install/materialize, so the re-add
 * spec is unknown ('remove-lacks-spec' — only a backend preImage restore
 * could undo it).
 *
 * The scan reads only journal-op rows (intentId === null; deferred intents
 * are pending, never executed) in list order and takes the NEWEST op with
 * status 'ok' — rows must be newest-first within the op group, which
 * projectTasks() guarantees. When no ok op exists: a failed/blocked terminal
 * exists → 'only-failed' (attempted, never succeeded); no terminal op at all
 * (empty journal / pending-only) → 'none-executed'. A newer failed/blocked op
 * above the newest ok op does not hide it in v1 (only successful changes are
 * undoable; the failed row owns its own surface). */
export const UNDO_V1_POLICY = 'ok-only' as const
export type UndoV1Policy = typeof UNDO_V1_POLICY

/** The undo the UI can offer. `remove` = re-submit the name for removal.
 *  `add` (name + spec) is reserved for the future when the prior spec is
 *  recoverable — never produced by the v1 ok-only derive. */
export type UndoAction =
  | { kind: 'remove'; name: string }
  | { kind: 'add'; name: string; spec: string }

export type UndoRefusalReason = 'none-executed' | 'remove-lacks-spec' | 'only-failed'

export type UndoLatest =
  | { action: UndoAction }
  | { action: null; reason: UndoRefusalReason }

export function undoForLatest(rows: readonly TaskRow[]): UndoLatest {
  const ops = rows.filter(row => row.intentId === null)
  for (const row of ops) {
    if (row.status !== 'ok') continue
    if (row.kind === 'remove') return { action: null, reason: 'remove-lacks-spec' }
    return { action: { kind: 'remove', name: row.name } }
  }
  const terminal = ops.some(row => row.status === 'failed' || row.status === 'blocked')
  return terminal
    ? { action: null, reason: 'only-failed' }
    : { action: null, reason: 'none-executed' }
}

/* ---------------------------------------------------------------------------
 * 7. Reserved-row filter (design 21 §6.6 — the dialog's third-party filter)
 * ---------------------------------------------------------------------------
 * Partition any name-carrying row set (diff rows, installed rows, inventory
 * entries) into what the model may act on and what the reserved domains own.
 */

export function filterDeniedRows<T extends { name: string }>(rows: readonly T[]): { allowed: T[]; denied: T[] } {
  const allowed: T[] = []
  const denied: T[] = []
  for (const row of rows) {
    if (isDeniedPluginName(row.name)) denied.push(row)
    else allowed.push(row)
  }
  return { allowed, denied }
}

/* ---------------------------------------------------------------------------
 * 8. Backend dispatch table (design 21 §3 matrix — adapter selection)
 * ---------------------------------------------------------------------------
 * Target kind (`local | dsh | gateway`) × transport (`local | ssh | http`)
 * → the model surface that serves the target. THIS table is which BACKEND
 * serves a target; which DIALOG opens is dialogForSurface (v1 target UI
 * mapping mirrors the current ConnectionsSection routing so the step-②/③
 * refactor can key off it).
 *
 * Ground truth — ConnectionsSection.tsx current routing (2026-12):
 *   - the local instance card button → setPluginFor('local') (the sync modal
 *     in LOCAL mode; ~L1190-1198);
 *   - remote rows: `spec.transport === 'ssh' && spec.kind === 'dsh'` →
 *     setPluginFor(spec) (ssh sync modal), everything else (gateway over ssh
 *     OR http, dsh over http) → setInventoryFor(spec) (~L1408-1417);
 *   - the modals render PluginSyncModal for pluginFor and PluginInventoryView
 *     for inventoryFor (~L1988-2005; design 21 §6.5: http+dsh 只读不变 — the
 *     inventory view IS today's read-only surface that the gateway unified
 *     view evolves from in steps ②/③).
 * Kind 'local' never appears in the SshInstanceSpec registry; its transport
 * is irrelevant here (loopback instance → 'local' surface). A dsh target
 * over any non-ssh transport can never claim a writable surface in v1 →
 * 'readonly-http' (the conservative answer; registry rows today only carry
 * ssh|http). */
export type ModelTargetKind = 'local' | 'dsh' | 'gateway'
export type ModelTransport = 'local' | 'ssh' | 'http' | null

/** Which model surface serves a target. 'local' = the local dsh profile
 *  (desktopSsh local_plugin_* verbs); 'ssh' = the ssh plugin surface
 *  (plugin_apply family); 'gateway' = the gateway backend (gateway IPC +
 *  /chamber routes via the instance proxy); 'readonly-http' = a direct http
 *  dsh target with NO plugin execution surface (inventory reads only). */
export type TargetSurface = 'local' | 'ssh' | 'gateway' | 'readonly-http'

export function targetSurfaceFor(kind: ModelTargetKind, transport: ModelTransport): TargetSurface {
  if (kind === 'local') return 'local'
  if (kind === 'gateway') return 'gateway'
  return transport === 'ssh' ? 'ssh' : 'readonly-http'
}

/** Which dialog opens for a surface (design 21 §6.6 — v1 mirrors the current
 *  routing: ssh AND local open the sync modal — the local arm in local mode
 *  (spec null); gateway targets open the unified plugin view (today's
 *  PluginInventoryView container, which becomes the unified view in step ②/③
 *  while PluginInventoryView narrows to http+dsh 只读); readonly-http stays on
 *  the inventory-readonly projection. */
export type DialogTarget = 'sync-modal' | 'unified-view' | 'inventory-readonly'

export function dialogForSurface(surface: TargetSurface): DialogTarget {
  switch (surface) {
    case 'local': return 'sync-modal'
    case 'ssh': return 'sync-modal'
    case 'gateway': return 'unified-view'
    case 'readonly-http': return 'inventory-readonly'
  }
}
