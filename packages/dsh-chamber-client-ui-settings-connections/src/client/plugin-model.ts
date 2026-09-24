/**
 * The unified plugin-management MODEL layer (design 21 §3 / §6.6): the pure,
 * UI-free and backend-free core of the model view PluginDialog renders —
 * intent ordering (remove before add), the SINGLE batch failure policy, apply-result
 * normalization for both backends, the gateway task projection, the undo derive and
 * the protected-row / diff-apply boundary.
 *
 * Discipline: PURE + LOCALE-FREE (no runtime imports, no window surface, no localized
 * copy — plain node runs every function). Ambient types stay in src/global.d.ts; every
 * IPC/wire shape consumed here is a LOCAL structural twin named *Shape with its authority
 * cited. The protected set P = B₀ ∪ S ∪ F is derived and projected by the BACKEND — this
 * module holds NO hand mirror of the Node-side predicate; the sole survivor is the
 * legacyProtectedName fallback for an un-upgraded gateway.
 */

/* ---- 1. Legacy protection fallback (version skew only) ----
 * 旧 gateway 不返回 `rows`：官方域（@deepseek-ai/*）与本仓 chamber 域（@dsh-chamber/*）
 * 都从可操作行滤掉——未升级服务端的写面拒绝它们，绝不能给出必然被拒的按钮/勾选。
 * 这是**对未升级服务端的回退策略**，不是 Node 侧函数镜像；P 的判定权威在后端。 */
export function legacyProtectedName(name: string): boolean {
  return name.startsWith('@deepseek-ai/') || name.startsWith('@dsh-chamber/')
}

/* ---- 2. Intent model (apply({add[], remove[], defer})) ----
 * The ordered intent a batch apply submits: removes FIRST, then adds (remove releases the
 * old layer before the new installs), input order preserved within each group, duplicates
 * stripped (first occurrence wins). */

/** One registry add: name plus its registry spec (bare = latest; `name@range` = pinned).
 *  Materialize rows never ride the batch add — they submit per-row through the materialize verb. */
export interface ModelPluginAdd {
  name: string
  spec: string
}

/* ---- 3. Apply-result normalization (both backends → one outcome) ----
 * The unified outcome the result surface renders. Per-name attribution is backend-shaped: the
 * gateway names its ops; the ssh result reports COUNTS only, so its executed arm carries empty
 * name lists and the view attributes per-row outcomes from result.failed. The ssh producer's
 * fail-loud ok:true states (verified / ready recheck) are PRESERVED as markers on the summary. */

/** Local structural twin of the desktop gateway_plugin_apply IPC union (authority:
 *  renderer global.d.ts / desktop preload.cts — the window type stays ambient). */
export type GatewayApplyShape =
  | { ok: true; cancelled: true }
  | { ok: true; installed: string[]; removed: string[]; restarted: boolean; deferred?: boolean }
  | { ok: false; error: string; partial?: { installed: string[]; removed: string[] } }

/** Local structural twin of the ssh plugin_apply result projection (authority:
 *  renderer global.d.ts PluginApplyResult / desktop plugin-sync.ts applyPlugins). */
export interface SshApplyResultShape {
  /** Ops that executed successfully (removes + adds). */
  applied: number
  /** Ops never attempted (refused up front by whitelist/deny/skip policy — never a user
   *  dismissal: ssh plugin_apply has no cancellation path). */
  skipped: number
  /** Per-item failures (single-item isolation — never blocks the rest). */
  failed: { spec: string; error: string }[]
  restarted: boolean
  deferred: boolean
  verified: boolean
  ready: boolean | null
  readyNote?: string
}

/** Local structural twin of the ssh plugin_apply IPC union (authority: renderer
 *  global.d.ts / desktop preload.cts; ipc-surface-mirror.test.ts pins the producer union).
 *  NO `{ok:true,cancelled:true}` arm: the ssh apply handler has no confirmation dialog or
 *  picker to dismiss — the gateway twin keeps the cancelled arm. */
export type SshApplyShape =
  | { ok: true; result: SshApplyResultShape }
  | { ok: false; error: string }

/** What a fully executed batch reports (name attribution is backend-shaped: the gateway
 *  names its ops; the ssh result reports counts only → empty lists). */
export interface ApplyExecutedSummary {
  removed: string[]
  installed: string[]
  restarted: boolean
  deferred: boolean
  /** ssh FAIL-LOUD markers (the producer reports these INSIDE ok:true — it asserts and
   *  re-checks readiness itself). The result surface MUST render any present marker; an executed
   *  summary with these absent is the only shape that may render as clean success.
   *  verified:false = the post-apply package.json assertion failed (loud, no rollback);
   *  ready:false = restart executed but readiness recheck failed; ready:null + readyNote =
   *  readiness not re-checked. */
  verified?: false
  ready?: false | null
  readyNote?: string
}

/** Normalized apply outcome. `cancelled` = user dismissed the confirmation (nothing ran);
 *  `executed` = the batch ran (per-item failures via `partial`); `failed` = refused/loudly failed
 *  before completing, with partialDone/partialTotal carrying what ran before it. */
export type ApplyOutcome =
  | { cancelled: true }
  | {
    executed: ApplyExecutedSummary
    partial?: { done: number; total: number }
  }
  | { failed: { error: string; partialDone: number; partialTotal: number } }

/** Classify a gateway_plugin_apply IPC result. ok:true = the whole batch was accepted
 *  (execution failures surface in the task journal, never here) → executed without partial;
 *  optional `deferred` defaults to false. ok:false = the partial ops the executor accepted
 *  before the failure; `attemptedOps` turns that into the honest n/m total. */
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

/** Classify a plugin_apply (ssh) IPC result. ok:true with per-item failures is still an
 *  EXECUTED batch with partial {done: applied, total: applied + failed} — skipped ops were never
 *  attempted. The ssh result carries no per-name success list (the view merges result.failed
 *  against its own rows). The producer's fail-loud ok:true states are preserved as presence-based
 *  markers. ok:false = a wholesale refusal; `attemptedOps` supplies the total. */
export function classifySshApplyResult(result: SshApplyShape, attemptedOps?: number): Exclude<ApplyOutcome, { cancelled: true }> {
  if (!result.ok) {
    return { failed: { error: result.error, partialDone: 0, partialTotal: attemptedOps ?? 0 } }
  }
  // No cancelled arm: plugin_apply has no cancellation path — the only cancelled producer
  // is the gateway apply, classified by classifyGatewayApplyResult.
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
  // Fail-loud markers (assertion + ready recheck): presence mirrors exactly what the ssh modal
  // renders loudly — verified false, a failed ready recheck, or a skipped recheck with its readyNote.
  if (r.verified === false) executed.verified = false
  if (r.ready === false) executed.ready = false
  else if (r.readyNote !== undefined) {
    executed.ready = null
    executed.readyNote = r.readyNote
  }
  return partial === undefined ? { executed } : { executed, partial }
}

/** The n/m progress projection: cancelled → null; executed → its partial (null when nothing
 *  was partial — full success); failed → the backend-reported done/total pair. */
export function partialCounts(outcome: ApplyOutcome): { done: number; total: number } | null {
  if ('cancelled' in outcome) return null
  if ('failed' in outcome) {
    return { done: outcome.failed.partialDone, total: outcome.failed.partialTotal }
  }
  return outcome.partial ?? null
}

/** The n/m prefix for a partial outcome ('Completed 2 of 5: '), empty when nothing was
 *  partially done. Shared by the manage and add surfaces. */
export function partialTextOf(
  counts: { done: number; total: number } | null,
  t: (key: 'partialNofM' | 'partialSep') => string,
): string {
  if (counts === null || counts.done === 0) return ''
  return `${t('partialNofM').replace('{done}', String(counts.done)).replace('{total}', String(counts.total))}${t('partialSep')}`
}

/* ---- 4. Batch failure policy — the SINGLE definition ----
 * 「失败即停」与逐行隔离的分界，模型层单一定义：
 * - 提交面 fail-fast：registry/remove 整批一次提交；任一提交/预检拒绝即停，整批不执行；
 * - 进入执行后 ssh 逐行串行隔离：单行失败不阻塞后续行、不吞没已执行行——如实 partial；
 * - materialize 恒逐行隔离（单实体失败不阻塞其余行）。
 * describeBatchPolicy 仅 doc-only（无 key 的英文常句，UI 一律走键）。 */

/** Doc-only policy sentence (unlocalized; the key table owns the zh/en copy): the
 *  registry/remove batch submits as one fail-fast unit, while accepted ssh executions run
 *  serially per-row isolated (executed rows report honestly as partial) and materialize rows
 *  stay isolated per row: a failed row never blocks the rest. */
export const BATCH_POLICY_SENTENCE =
  'The registry/remove batch submits as one unit and fails fast on any refusal (gateway submission surface / ssh pre-flight); accepted ssh executions run serially per-row isolated and report executed rows honestly as partial, and materialize rows stay isolated — a failed row never blocks the rest.'

export function describeBatchPolicy(): string {
  return BATCH_POLICY_SENTENCE
}

/* ---- 5. Gateway task projection → row model ----
 * The task endpoint answers {ok:true, tasks: JournalOp[], deferred: DeferredIntent[], busy}:
 * journal ops newest-first + durable deferred install intents + the executor busy flag. The
 * projection maps BOTH arrays into one row model — deferred intents first (the future queue,
 * not journal history), then the journal ops in wire order. */

export type TaskStatus = 'pending' | 'ok' | 'failed' | 'blocked'

/** The journal op kinds the gateway can record (`undo` carries `undoOf`). */
export type TaskKind = 'install' | 'remove' | 'materialize' | 'undo'

/** One projected row: a journal op or a deferred intent. */
export interface TaskRow {
  /** Journal op id; '' for a deferred intent that has no journal op yet (the drained op receives its own opId later). */
  opId: string
  kind: TaskKind
  name: string
  /** Registry spec / materialized path; journaled for install/materialize only — null for removes/undo and unknown specs. */
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
  /** The op's pre-mutation backup reference (`backups/<op-id>/`), or null. Only an op
   *  carrying one is undoable. */
  preImage: string | null
  /** For `kind: 'undo'` rows: the op whose preImage this undo restored. */
  undoOf: string | null
}

/** Structural twin of the gateway JournalOp (authority: packages/gateway/src/plugins-journal.ts) —
 *  full fidelity so the projection cannot drift from the wire. */
export interface GatewayJournalOpShape {
  id: string
  ts: number
  kind: TaskKind
  name: string
  spec?: string
  /** Reference to the pre-mutation backup dir (`backups/<op-id>/`) when the executor placed one, null otherwise. */
  preImage: string | null
  /** Present only for `kind: 'undo'` ops: the restored op's id. */
  undoOf?: string
  initiator?: string
  status: 'pending' | 'ok' | 'failed' | 'blocked'
  error?: string
  restarted?: 'ok' | 'failed' | 'skipped'
}

/** Structural twin of the gateway DeferredIntent (authority: packages/gateway/src/plugins-tasks.ts —
 *  install/materialize only; remove is never deferred). */
export interface GatewayDeferredIntentShape {
  id: string
  ts: number
  kind: 'install' | 'materialize'
  name: string
  spec?: string
  initiator?: string
}

/** Structural twin of GET /chamber/plugins/tasks 200 body (authority: packages/gateway/src/routes.ts —
 *  {ok:true, ...tasksProjection}). */
export interface GatewayTasksShape {
  ok: true
  /** Journal ops, newest first (retention-capped). */
  tasks: GatewayJournalOpShape[]
  /** Durable deferred intents (newest first). */
  deferred: GatewayDeferredIntentShape[]
  /** True while the executor has a mutation in flight. */
  busy: boolean
}

/** Project the gateway task shape into the row model. Group order contract: deferred-intent
 *  rows first (pending, deferred:true, intentId set), then journal-op rows in wire order. */
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

/* ---- 6. Undo derive for 「撤销最近变更」 ----
 * V1 (UNDO_V1_POLICY = 'ok-only'): only ops that actually took effect are undoable.
 * The gateway undo is 撤销=恢复: the backend RESTORES the latest ok op's preImage pair
 * (package.json + lockfile, byte-for-byte), undoing install, materialize and remove alike —
 * no synthesized remove/add action, no remove-only shortcut. The renderer only decides WHETHER
 * to offer the affordance; the request is id-only `POST /chamber/plugins/undo`.
 * The scan reads only journal-op rows (deferred intents are pending) in list order and takes the
 * NEWEST op with status 'ok'; that op must ALSO carry a preImage (an ok op with a lost/pruned
 * backup is NOT undoable and the derive does NOT skip to an older ok op — a wholesale restore
 * would revert the newer change too). No ok op: a failed/blocked terminal → 'only-failed'; no
 * terminal at all (empty/pending-only journal) → 'none-executed'. */
export const UNDO_V1_POLICY = 'ok-only' as const

/** The undo the UI can offer: the op whose preImage the backend will restore. opId/name/kind
 *  ride the projection for the affordance and its copy; the request carries no id. */
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
    // The newest ok op: only its own preImage may be restored (no skipping — see the section comment).
    if (row.preImage === null) return { action: null, reason: 'no-preimage' }
    return { action: { kind: 'restore', opId: row.opId, name: row.name, opKind: row.kind } }
  }
  const terminal = ops.some(row => row.status === 'failed' || row.status === 'blocked')
  return terminal
    ? { action: null, reason: 'only-failed' }
    : { action: null, reason: 'none-executed' }
}

/* ---- 7. Protected rows: read-side projection + the diff/apply boundary ----
 * 后端三端各投影 `rows: PluginRow[]`（加性字段；`dependencies` 语义不变），渲染端只消费。
 * - projectInstalledRows：已安装列表行投影。行集 = profile 的依赖表——安装自带组合（B₀）
 *   与 chamber 播种物（S）不造行（chamber 组件有自己的表；官方组合是运行时基线）。受保护名若
 *   出现在依赖表里仍只读可见。rows 缺失（旧 gateway）时回退到 dependencies 过滤并置 legacy。
 * - actionableDependencies：computePluginDiff 的输入收窄（硬要求）——受保护行进输入会让
 *   missing 行默认勾选，普通对账把官方包当 add 提交、后端整批拒绝。
 * - isActionableRow / legacyProtectedName：上面两条共用的行判据。
 * 本模块不重算保护集合；唯一域名前缀例外是 ssh 传输能力过滤，不是保护判定。 */

/** 行角色（wire 单源的字面量并集；渲染端只渲染，绝不推导）。一行已安装事实的唯一声明在
 *  wire 的 `./plugin-row` 面，这里经 client-core 浏览器面只 import/再导出，不重声明字段。 */
import type {
  PluginRow as PluginRowShape,
  PluginRowRole as PluginRowRoleShape,
} from '@dsh-chamber/dsh-chamber-client-core/plugin-row'
export type { PluginRowShape, PluginRowRoleShape }

/** 加性 `rows` 成员的载体孪生（可选：旧 gateway 不返回，§6.11.7）。 */
export interface PluginRowsCarrierShape {
  rows?: readonly PluginRowShape[] | undefined
}

/** 读清单上的加性行投影；缺失/非数组 → null（调用方走 legacy 回退路径）。返回浅拷贝，调用方可自由排序。 */
export function pluginRowsOf(manifest: PluginRowsCarrierShape | null | undefined): PluginRowShape[] | null {
  if (manifest === null || manifest === undefined) return null
  const rows = manifest.rows
  return Array.isArray(rows) ? [...rows] : null
}

/** diff/apply 边界的行判据（硬要求）：只要后端判它非受保护，它就能进对账面——`layer`
 *  同样是用户内容，必须可同步。角色不参与判据（按 role 收窄会把用户后加的层静默抹掉）；
 *  官方 scope 在 ssh 面的不可装是传输能力问题，由 sshSyncableDependencies 单独处理。 */
export function isActionableRow(row: PluginRowShape): boolean {
  return row.protected === false
}

/** ssh 对账面的输入收窄：在 actionableDependencies 之上再排除官方 scope。原因是传输能力
 *  而非保护判定——ssh 装面对官方 scope 一律整批拒绝，一个这样的行就会让普通对账整体失效。
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

/** 官方 scope 前缀：只用于 ssh 对账面的传输能力过滤，不是保护判定——保护判定唯一来源是后端投影的 rows[].protected。 */
export const OFFICIAL_SCOPE_PREFIX = '@deepseek-ai/'

/**
 * 已安装行的移除动作判据：写面只按 `name ∈ P` 拒绝 remove，所以非受保护行都能移除——与
 * isActionableRow 同一条判据（按角色收窄会静默抹掉用户内容）；保留名字让调用点自解释。
 */
export const isRemovableRow = isActionableRow

/** 把清单的 `dependencies` 收窄成 diff/apply 边界可操作的行。rows 可用时只保留「存在对应行
 *  且 isActionableRow」的依赖项——严格是过滤，绝不凭行新增；rows 缺失时按 legacyProtectedName
 *  回退。依赖表的值逐字保留。隐含前提：rows 覆盖 dependencies（键集恒等，有锁步断言）；
 *  缺行 = 静默跳过，失败方向是「少动作」——producer 若收窄成子集，必须在这里改成响亮拒绝。 */
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

/** 已安装列表的一行视图（渲染端只读投影）。legacy 回退行的 role 为 'unknown'；「gateway
 *  版本较低」提示由投影级 legacy 标记驱动，行本身不携带该标记。 */
export interface InstalledRowView {
  name: string
  /** 依赖值（掩码后）；后端行没有依赖项且自身 spec 为 null 时为 null（防御：渲染端落到版本格）。 */
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
