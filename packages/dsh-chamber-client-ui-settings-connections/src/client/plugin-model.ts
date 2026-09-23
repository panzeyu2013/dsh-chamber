/**
 * The unified plugin-management MODEL layer (design 21 §6.6; design 21 §3
 * single-model matrix).
 *
 * This module is the pure, UI-free and backend-free core of the unified model
 * view PluginDialog renders (§6.6 direction): intent ordering
 * (remove before add), batch failure policy (the SINGLE definition shared by
 * the ssh and gateway flows), apply-result normalization for both backends,
 * the gateway task projection → row model, the v1 undo derive (撤销最近变更,
 * §6.4/§6.8 r2) and the protected-row projection + the diff/apply boundary
 * (§6.11.5).
 *
 * Discipline notes:
 * - PURE + LOCALE-FREE: no runtime imports (the wire faces it names are
 *   type-only), touches no window/ambient surface,
 *   returns no localized copy — plain node can run every function. Phase 5C
 *   owns the zh/en key table; only the doc-only batch-policy sentence keeps an
 *   unlocalized English constant here (§6.6 policy 文案如实呈现; zh wording in
 *   the comment, keyed in 5C).
 * - MIRROR DISCIPLINE: ambient types (src/global.d.ts re-export of the
 *   renderer's global.d.ts) own the WINDOW surface. This module never imports
 *   them — every IPC/wire shape it consumes is declared as a LOCAL structural
 *   twin below, named *Shape, with the authority cited in the comment (the
 *   ipc-surface-mirror test in packages/desktop pins the preload ↔ renderer
 *   sides; these twins pin the renderer → model read).
 * - NO PROTECTION MIRROR (design 21 §6.11.5): the protected set
 *   `P = B₀ ∪ S ∪ F` is derived and projected by the BACKEND — the side that
 *   can compute P (local/gateway = desktop main / gateway server; ssh =
 *   desktop main) — and the renderer only renders `rows[].protected` /
 *   `rows[].role`. This module holds NO isDeniedPluginName / filterDeniedRows
 *   hand mirror of the Node-side predicate; the sole survivor is
 *   `legacyProtectedName`, documented as the fallback policy for an UN-UPGRADED
 *   gateway (§6.11.7), never a mirror of a Node-side function.
 */

/* ---------------------------------------------------------------------------
 * 1. Legacy protection fallback (design 21 §6.11.7 — version skew only)
 * 旧就地在场的 gateway 不返回 `rows`（§6.11.5 的加性字段），渲染端此时没有
 * 后端投影可消费，只能兜底：官方域（@deepseek-ai/*）与本仓 chamber 域
 * （@dsh-chamber/*）都从可操作行里滤掉——未升级服务端的写面拒绝它们，所以
 * 绝不能给出一个必然被拒的按钮/勾选。这是**对未升级服务端的回退策略**，不是
 * 任何 Node 侧函数的镜像；受保护集合 P 的判定权威在后端
 * `control-plane/src/protected-plugins.ts`，渲染端只消费投影（本回退路径的移除
 * 已登记为 §6.11.8 的偏差）。
 */
export function legacyProtectedName(name: string): boolean {
  return name.startsWith('@deepseek-ai/') || name.startsWith('@dsh-chamber/')
}

/* ---------------------------------------------------------------------------
 * 2. Intent model (design 21 §3 matrix row: apply({add[], remove[], defer}))
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
 * The unified outcome the result surface renders (partial「已完成 n/m」、
 * cancelled、failed copy, §6.6). Per-name attribution: the gateway result
 * names its installed/removed ops; the ssh result reports COUNTS only (see
 * classifySshApplyResult), so its executed arm carries empty name lists and
 * the view attributes per-row outcomes from result.failed against its own
 * submitted rows. The ssh producer's fail-loud ok:true states (verified /
 * ready recheck, plugin-sync.ts applyPlugins ④/⑤) are PRESERVED as markers
 * on the executed summary — the ssh arm renders them loudly today
 * (PluginDialog.tsx) and the unified result surface must keep doing so
 * (ssh 等价 is the refactor's load-bearing wall); the gateway ok:true arm
 * carries no such members.
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
 *  confirmation dialog or picker to dismiss (design 21 §7 — the ssh apply
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
   *  ④/⑤). The result surface MUST render any present marker (the ssh arm
   *  equivalents are pluginsVerifyFailed / pluginsReadyFailed / the readyNote
   *  verbatim, PluginDialog.tsx) — an executed summary with these
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
 *  is still an EXECUTED batch (single-item isolation, design 13 §3) with
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
  // confirm gap, design 21 §7) — the only cancelled producer is the gateway
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

/** The n/m prefix for a partial outcome ('Completed 2 of 5: '), empty when
 *  nothing was partially done. Shared by the manage and add surfaces instead
 *  of spelling the interpolation twice. */
export function partialTextOf(
  counts: { done: number; total: number } | null,
  t: (key: 'partialNofM' | 'partialSep') => string,
): string {
  if (counts === null || counts.done === 0) return ''
  return `${t('partialNofM').replace('{done}', String(counts.done)).replace('{total}', String(counts.total))}${t('partialSep')}`
}

/* ---------------------------------------------------------------------------
 * 4. Batch failure policy — the SINGLE definition (design 21 §6.6)
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
 * The task endpoint answers {ok:true, tasks: JournalOp[], deferred:
 * DeferredIntent[], busy} (packages/gateway/src/routes.ts 1146-1150):
 * journal ops newest-first (retention-capped) + durable deferred install
 * intents (awaiting a ready edge) + the executor busy flag. The projection
 * maps BOTH arrays into one row model — deferred intents first (they are the
 * future queue, not journal history), then the journal ops in wire order.
 */

export type TaskStatus = 'pending' | 'ok' | 'failed' | 'blocked'

/** The journal op kinds the gateway can record (`undo` is the design 21 §6.3
 *  restore op — it carries `undoOf`). */
export type TaskKind = 'install' | 'remove' | 'materialize' | 'undo'

/** One projected row: a journal op or a deferred intent. */
export interface TaskRow {
  /** Journal op id; '' for a deferred intent that has no journal op yet (the
   *  drained op receives its own opId later). */
  opId: string
  kind: TaskKind
  name: string
  /** Registry spec / materialized path; journaled for install/materialize
   *  only — null for removes/undo and for unknown specs. */
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
  /** The op's pre-mutation backup reference (`backups/<op-id>/`), or null.
   *  This is the undo verb's restoring material: only an op that carries one
   *  is undoable (design 21 §6.3 preImage semantics). */
  preImage: string | null
  /** For `kind: 'undo'` rows: the op whose preImage this undo restored. */
  undoOf: string | null
}

/** Structural twin of the gateway JournalOp (authority:
 *  packages/gateway/src/plugins-journal.ts) — full fidelity so the projection
 *  cannot drift from the wire. */
export interface GatewayJournalOpShape {
  id: string
  ts: number
  kind: TaskKind
  name: string
  spec?: string
  /** Reference to the pre-mutation backup dir (backups/<op-id>/) when the
   *  executor placed one, null otherwise. */
  preImage: string | null
  /** Present only for `kind: 'undo'` ops: the restored op's id. */
  undoOf?: string
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
      preImage: null,
      undoOf: null,
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
      preImage: op.preImage ?? null,
      undoOf: op.undoOf ?? null,
    })
  }
  return { rows, busy: shape.busy }
}

/* ---------------------------------------------------------------------------
 * 6. Undo derive for 「撤销最近变更」(design 21 §6.4/§6.8 r2) — gateway
 * implementation
 * V1 (UNDO_V1_POLICY = 'ok-only'): only ops that actually took effect are
 * undoable — a failed/blocked op never is (its recovery belongs to the r2-r4
 * 恢复阶梯 flows, driven backend-side from the journal + preImage backups).
 *
 * The gateway undo is 撤销=恢复 (the §6.4 ssh semantics, one model): the
 * backend RESTORES the latest ok op's preImage pair (package.json + lockfile,
 * byte-for-byte), which undoes an install, a materialize and a remove alike —
 * there is no synthesized remove/add action here and no remove-only shortcut.
 * The renderer's only job is to decide WHETHER the affordance is offered and
 * to carry the op identity for projection; the request itself is
 * `POST /chamber/plugins/undo` (id-only, main/backend picks the target from
 * the durable journal).
 *
 * The scan reads only journal-op rows (intentId === null; deferred intents
 * are pending, never executed) in list order and takes the NEWEST op with
 * status 'ok' — rows must be newest-first within the op group, which
 * projectTasks() guarantees. That op must ALSO carry a preImage reference
 * (the restoring material): an ok op with a lost/pruned backup is NOT
 * undoable, and the derive does NOT skip to an older ok op — a wholesale
 * preImage restore would revert the newer change too, so the honest answer is
 * 'no-preimage'. When no ok op exists: a failed/blocked terminal exists →
 * 'only-failed' (attempted, never succeeded); no terminal op at all (empty
 * journal / pending-only) → 'none-executed'. A newer failed/blocked op above
 * the newest ok op does not hide it in v1 (only successful changes are
 * undoable; the failed row owns its own surface). */
export const UNDO_V1_POLICY = 'ok-only' as const

/** The undo the UI can offer: the op whose preImage the backend will restore.
 *  `opId`/name/kind ride the projection for the affordance and its copy;
 *  the request itself carries no id (the backend re-selects the latest
 *  undoable op under its single-flight fence). */
export interface UndoAction {
  kind: 'restore'
  /** The journal op the backend would restore (the newest ok op). */
  opId: string
  name: string
  /** The kind of the op being undone (for the recovery copy). */
  opKind: TaskKind
}

export type UndoRefusalReason = 'none-executed' | 'only-failed' | 'no-preimage'

export type UndoLatest =
  | { action: UndoAction }
  | { action: null; reason: UndoRefusalReason }

export function undoForLatest(rows: readonly TaskRow[]): UndoLatest {
  const ops = rows.filter(row => row.intentId === null)
  for (const row of ops) {
    if (row.status !== 'ok') continue
    // The newest ok op: only its own preImage may be restored (no skipping —
    // see the section comment).
    if (row.preImage === null) return { action: null, reason: 'no-preimage' }
    return { action: { kind: 'restore', opId: row.opId, name: row.name, opKind: row.kind } }
  }
  const terminal = ops.some(row => row.status === 'failed' || row.status === 'blocked')
  return terminal
    ? { action: null, reason: 'only-failed' }
    : { action: null, reason: 'none-executed' }
}

/* ---------------------------------------------------------------------------
 * 7. Protected rows: read-side projection + the diff/apply boundary
 *    (design 21 §6.11.5)
 * 后端三端各投影 `rows: PluginRow[]`（加性字段；`dependencies` 语义不变），
 * 渲染端只消费。本节提供三件事：
 * - projectInstalledRows：已安装列表的行投影。**行集 = profile 的依赖表**：
 *   安装自带组合（B₀）与 chamber 播种物（S）不造行——
 *   chamber 组件有自己的表（探针状态 + 版本 + 手动重推），官方组合是运行时基线。
 *   受保护名若确实出现在依赖表里，仍只读可见（无移除按钮 + 角色徽标）。rows 缺失
 *   （旧 gateway，§6.11.7）时回退到 dependencies 过滤并置 legacy 标记。
 * - actionableDependencies：computePluginDiff 的输入收窄（**硬要求**）。若把
 *   受保护行并进 diff 输入，`missing` 行默认勾选 ⇒ 一次普通第三方对账会把
 *   `@deepseek-ai/dsh-base@…` 当 add 提交，后端整批拒绝（gateway 亦然）。
 * - isActionableRow / legacyProtectedName：上面两条共用的行判据。
 *
 * 本模块**不重算保护集合**（`rows[].protected` 是后端判定）。唯一的域名前缀例外是
 * `OFFICIAL_SCOPE_PREFIX` / `sshSyncableDependencies`：那是 ssh **传输能力**过滤
 * （ssh 装面对官方 scope 整批拒绝），不是保护判定（§6.11.5/§6.11.3）。
 */

/** 行角色（wire 单源的字面量并集；渲染端只渲染，绝不推导）。
 *  一行已安装事实的**唯一声明**在 wire 的 `./plugin-row` 面，这里经
 *  client-core 的浏览器面（`@dsh-chamber/dsh-chamber-client-core/plugin-row`）
 *  只 import/再导出，**不重声明**字段（C14 断言：引用面 + 无本地重声明）。旧名
 *  `PluginRowShape` / `PluginRowRoleShape` 由 import 别名保持，其余模块引用不变。 */
import type {
  PluginRow as PluginRowShape,
  PluginRowRole as PluginRowRoleShape,
} from '@dsh-chamber/dsh-chamber-client-core/plugin-row'
export type { PluginRowShape, PluginRowRoleShape }

/** 加性 `rows` 成员的载体孪生（可选：旧 gateway 不返回，§6.11.7）。 */
export interface PluginRowsCarrierShape {
  rows?: readonly PluginRowShape[] | undefined
}

/** 读清单上的加性行投影；缺失/非数组 → null（调用方走 §6.11.7 回退路径）。
 *  返回浅拷贝：调用方可以自由遍历/排序而不动 IPC 载荷。 */
export function pluginRowsOf(manifest: PluginRowsCarrierShape | null | undefined): PluginRowShape[] | null {
  if (manifest === null || manifest === undefined) return null
  const rows = manifest.rows
  return Array.isArray(rows) ? [...rows] : null
}

/** diff/apply 边界的行判据（§6.11.5 硬要求）：只要后端判它**非受保护**，它就能进
 *  对账面——`layer`（用户自己加的层）同样是用户内容，必须可同步；被排除的是组合/
 *  播种/线族/受保护行（`protected` 已由后端算好）。
 *
 *  注意角色**不**参与判据：按 `role ∈ {third-party, materialized}` 收窄会把用户
 *  后加的层从对账视图里静默抹掉。官方 scope 在 **ssh** 面上的不可装是
 *  **传输能力**问题，由 `sshSyncableDependencies` 单独处理，不混进保护判据。 */
export function isActionableRow(row: PluginRowShape): boolean {
  return row.protected === false
}

/** ssh 对账面的输入收窄（§6.11.5 + §6.11.3 ssh 保守装面）：在
 *  `actionableDependencies` 之上再排除官方 scope。原因是**传输能力**而非保护判定——
 *  ssh 装面对官方 scope 一律整批拒绝（`familySource:'none'`），一个这样的行就会让
 *  一次普通对账整体失效；保护判定始终以后端 `rows[].protected` 为准。
 *  这是**传输能力**判据，不是保护判定：`protected` 始终等于「name ∈ P」（后端投影）；
 *  官方 scope 行若不在 P 内则仍可移除（remove 只判 B₀ ∪ S），只是装不进 ssh。 */
export function sshSyncableDependencies(
  dependencies: Record<string, string>,
  rows: readonly PluginRowShape[] | null,
): Record<string, string> {
  const actionable = actionableDependencies(dependencies, rows)
  const syncable: Record<string, string> = {}
  for (const [name, spec] of Object.entries(actionable)) {
    if (name.startsWith(OFFICIAL_SCOPE_PREFIX)) continue
    syncable[name] = spec
  }
  return syncable
}

/** 官方 scope 前缀：**只**用于 ssh 对账面的传输能力过滤（见上），不是保护判定——
 *  保护判定唯一来源是后端投影的 `rows[].protected`（§6.11.5）。 */
export const OFFICIAL_SCOPE_PREFIX = '@deepseek-ai/'

/**
 * 已安装行的移除动作判据：写面只按 `name ∈ P` 拒绝 remove（§6.11.3 R1，remove 永不
 * 判版本），所以非受保护行都能移除——与 `isActionableRow` **同一条判据**（按角色
 * 收窄 diff 会把用户内容静默抹掉，见 isActionableRow 注释）。
 * 保留名字是为了让调用点的语义自解释（移除按钮 vs 对账输入）。
 */
export const isRemovableRow = isActionableRow

/** 把清单的 `dependencies` 收窄成 diff/apply 边界可操作的行（§6.11.5 硬要求）。
 *  rows 可用时：只保留「存在对应行且 isActionableRow」的依赖项——严格是**过滤**
 *  （绝不凭行新增依赖项）；rows 缺失（旧 gateway）时按 legacyProtectedName 回退。
 *  依赖表的值逐字保留（与既有显示/提交值同源）。
 *
 *  **隐含前提**：rows 覆盖 dependencies（三端都由同一张依赖表派生，二者键集恒等；
 *  control-plane 单测有锁步断言）。缺行 = 静默跳过——失败方向是
 *  「少动作」（安全但不响亮），所以 producer 若哪天收窄成子集，必须在这里改成响亮拒绝。 */
export function actionableDependencies(
  dependencies: Record<string, string>,
  rows: readonly PluginRowShape[] | null,
): Record<string, string> {
  const actionable: Record<string, string> = {}
  if (rows === null) {
    for (const [name, spec] of Object.entries(dependencies)) {
      if (!legacyProtectedName(name)) actionable[name] = spec
    }
    return actionable
  }
  const byName = new Map(rows.map(row => [row.name, row]))
  for (const [name, spec] of Object.entries(dependencies)) {
    const row = byName.get(name)
    if (row === undefined || !isActionableRow(row)) continue
    actionable[name] = spec
  }
  return actionable
}

/** 已安装列表的一行视图（渲染端只读投影）。legacy 回退行的 role 为 'unknown'
 *  （没有后端投影可消费）；「gateway 版本较低」提示由投影级 legacy 标记驱动
 *  （projectInstalledRows 的返回值），行本身不携带该标记。 */
export interface InstalledRowView {
  name: string
  /** 依赖值（掩码后）；后端行没有依赖项且自身 spec 为 null 时为 null（后端不产出
   *  这种行，保留为防御：渲染端落到版本格）。 */
  spec: string | null
  version: string | null
  role: PluginRowRoleShape
  protected: boolean
  /** 是否渲染逐行移除按钮（见 isRemovableRow）。 */
  removable: boolean
}

/**
 * Project one zone's installed rows from a backend manifest: the backend's
 * `rows` (one row per declared dependency — design 21 §6.11.5) rendered in
 * backend order. `rows: []` is AUTHORITATIVE (an empty
 * result renders the empty state, never the legacy dependency fallback): the
 * field is additive, so only its ABSENCE means "this backend is too old to
 * project rows" — an empty array is a real answer, and re-deriving from
 * `dependencies` would resurrect the protection mirror the renderer must not
 * own. With no `rows` (old gateway, §6.11.7) the legacy
 * dependency filter is the only fallback, reported via the `legacy` flag.
 */
export function projectInstalledRows(
  dependencies: Record<string, string>,
  rows: readonly PluginRowShape[] | null,
): { rows: InstalledRowView[]; legacy: boolean } {
  if (rows === null) {
    const legacyRows: InstalledRowView[] = []
    for (const [name, spec] of Object.entries(dependencies)) {
      if (legacyProtectedName(name)) continue
      legacyRows.push({ name, spec, version: null, role: 'unknown', protected: false, removable: true })
    }
    return { rows: legacyRows, legacy: true }
  }
  return {
    rows: rows.map(row => ({
      name: row.name,
      spec: dependencies[row.name] ?? row.spec ?? null,
      version: row.version,
      role: row.role,
      protected: row.protected,
      removable: isRemovableRow(row),
    })),
    legacy: false,
  }
}
