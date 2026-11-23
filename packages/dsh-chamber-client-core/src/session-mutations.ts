/**
 * 会话变更的**唯一事实出口**——工作区出口（workspace-mutations.ts）的会话侧同构件。
 * WHY 收口：会话回声（session-echo.ts）是「本窗口刚建出来的会话行」的唯一非挂载读
 * 通道。unary 侧建出来的会话只有宿主 `api-session/added` 广播能进挂载壳的官方
 * summaries，竞态窗内随后的挂载推送会用还不含它的 store 替换整份聚合；未挂载来源
 * 根本收不到该广播。事实必须由**任何**应用内创建者发布——侧栏 "+"、会话行菜单
 * fork、Git worktree 插件的创建（create/adopt/recovery）：漏发一个调用点，行就
 * 必须点开那个服务器才出现。包装刻意保持薄：无状态、无重试、不是第二事实源；
 * 投影的唯一写者仍是 App 层，权威仍是该来源挂载壳的会话列表 / 工作区 follow 基线。
 * 归档（archive）是这条链的撤下半：创建后立刻归档的行靠它退场（与工作区回声的
 * remove 半同理），而不是留到 TTL；恢复（unarchive，官方 wire）是它的可逆半，同时
 * 负责清掉本地归档墓碑。
 */
import { chamberBridge } from './aggregate-store.ts'
import { increasedForkTitle, sessionDurableTitles } from './fork-titles.ts'
import type { SessionCreationOrigin } from './session-create-ledger.ts'
import {
  archiveSession, callAndThrow, createSession, forkSession, getInstanceClient, MutationOutcomeUnknownError,
  pinSession, renameSession, ResponseLostError, unpinSession,
} from './instance-api.ts'
import { reportSessionRestored } from './session-restore.ts'
import { assertSingletonModule } from './singleton.ts'

// The title-reservation ledger below is page-wide cross-boundary state (the sidebar
// bundle and the App reach this module through the vite shared chunk); bundling
// drift would silently split it and re-open the same-tick duplicate-title hole.
assertSingletonModule('session-mutations')

interface SessionCreationOptions {
  /** 调用方预分配的会话 id（多步 saga 重试复用；缺省 = 宿主自铸）。 */
  sessionId?: string
  /** 该次创建**意图**写入的显示标题（fork 的递增标题）：回声行生来就是最终标签，
   *  不必先渲染会话 id 再等 rename 翻转。缺省 = 官方 id 阶梯；权威行始终压过它。 */
  title?: string
  /** 该次 fork 的**源 durable 标题**（非空时启用 skip-taken 标题策略）：候选名由唯一
   *  出口按同来源已用 durable 标题跳过编号后定名并 rename，回声在 rename 完成后发布
   *  （见 `forkSessionForSource`）。与 `title` 同时给时本字段优先；缺省 = 旧行为
   *  （fork 成功后立即发回声、不 rename）。 */
  increaseTitleFrom?: string
  /** 归因：这次创建的**触发路径**；每个调用点都必须表态（'unknown' 是仪表覆盖缺口的信号）。 */
  origin?: SessionCreationOrigin
  /**
   * 该次创建**意图**生效的工作目录（design 08 PR2 §5.3）：在 checkout 内新建会话时
   * 传 checkout path，回声行立即被派生到对应 checkout 行，而不是先在源行闪一下。
   * 缺省 = 源 workspace 自身目录；宿主投影到达后以宿主为准。
   */
  workingDirectory?: string
}

/** 对 `sourceId` 执行 session.create，并发布创建回声事实（blank = 官方临时行）。 */
export async function createSessionForSource(
  sourceId: string,
  workspaceId: string,
  options: SessionCreationOptions = {},
): Promise<string> {
  const sessionId = await createSession(getInstanceClient(sourceId), workspaceId, options.sessionId)
  chamberBridge.reportSessionCreated({
    sourceId,
    sessionId,
    workspaceId,
    blank: true,
    // 标签是加法字段——未表态的调用方**不发**该键（事实形状逐字节不变），桥按 'unknown' 记账。
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.workingDirectory === undefined ? {} : { workingDirectory: options.workingDirectory }),
  })
  return sessionId
}

/** How long one title assigned by an in-flight fork may be skipped before the
 *  authority is expected to list it (mounted push / unmounted fallback pull).
 *  MUST outlive BOTH mutation legs of one fork: the title is decided before the
 *  fork RPC, but the authority only lists the child after the fork AND the
 *  rename resolve, and each leg may legally stay in flight for one
 *  `mutationCallBudgetMs` (proxy worst case: 60s inbound + 60s flush + 45s
 *  header + 5s cushion = 170s at the floor; see
 *  `@dsh-chamber/dsh-chamber-wire` net-budget) — so the naming→authority window
 *  is up to two budgets (~340s). 400_000 covers both with margin; a shorter TTL
 *  lets a second same-window fork reuse the number while the first is still
 *  pending. */
const FORK_TITLE_RESERVATION_TTL_MS = 400_000

/** Defensive ceiling per source; expiry/observed pruning keeps the normal size tiny. */
const FORK_TITLE_RESERVATION_MAX_PER_SOURCE = 64

/**
 * Page-level reservations of fork titles this window already assigned while the
 * authoritative title set has not listed them yet. Without them two forks fired
 * in the same tick (double click / two quick menu picks) read the same stale set
 * and pick the same number. TITLE-keyed on purpose: skip-taken is a title
 * predicate, not a session-identity one. The singleton guard above covers
 * bundling drift (a duplicated ledger would silently re-open the hole).
 */
const forkTitleReservations = new Map<string, Map<string, number>>()

/**
 * Drop one source's in-flight fork-title reservations. Called from the renderer's
 * authoritative retirement path: a retired source's titles must not keep skipping
 * numbers after a same-id re-add (the authority is gone, so nothing would prune them
 * before the 400s TTL).
 * @param sourceId - the retired aggregate source id.
 */
export function forgetForkTitleReservations(sourceId: string): void {
  forkTitleReservations.delete(sourceId)
}

/**
 * The authoritative same-source title set (never includes our own reservations):
 * the mounted shell's raw session snapshot (full membership incl. archived rows;
 * subagent-origin rows are filtered by its projection) plus the page aggregate's
 * nav rows and archived metadata (the unmounted-source complement). Purely local
 * reads — no RPC.
 */
function authoritativeForkTitles(sourceId: string): Set<string> {
  const titles = new Set<string>()
  const snapshot = chamberBridge.getInstanceSnapshots()[sourceId]
  if (snapshot !== undefined) {
    for (const title of sessionDurableTitles(snapshot.sessions)) titles.add(title)
  }
  const server = chamberBridge.getServers().find(candidate => candidate.id === sourceId)
  if (server !== undefined) {
    for (const workspace of server.workspaces) {
      for (const title of sessionDurableTitles(workspace.sessions)) titles.add(title)
    }
    for (const title of sessionDurableTitles(server.archivedSessions ?? [])) titles.add(title)
  }
  return titles
}

/**
 * Live reservations for one source: expired entries and titles the authority now
 * lists retire in place (the authority owns them from then on).
 */
function liveReservedForkTitles(sourceId: string, now: number, authoritative: ReadonlySet<string>): Set<string> {
  const live = new Set<string>()
  const reserved = forkTitleReservations.get(sourceId)
  if (reserved === undefined) return live
  for (const [title, expiresAt] of reserved) {
    if (expiresAt <= now || authoritative.has(title)) {
      reserved.delete(title)
      continue
    }
    live.add(title)
  }
  if (reserved.size === 0) forkTitleReservations.delete(sourceId)
  return live
}

/** Candidate set = authority ∪ this page's live reservations (in-flight titles).
 *  @param authoritative - the already-read authority (freshness owned by the caller);
 *    omission reads it now. */
function takenForkTitles(
  sourceId: string,
  authoritative: ReadonlySet<string> = authoritativeForkTitles(sourceId),
): ReadonlySet<string> {
  const taken = new Set(authoritative)
  for (const title of liveReservedForkTitles(sourceId, Date.now(), authoritative)) taken.add(title)
  return taken
}

function reserveForkTitle(sourceId: string, title: string, now: number): void {
  let reserved = forkTitleReservations.get(sourceId)
  if (reserved === undefined) {
    reserved = new Map<string, number>()
    forkTitleReservations.set(sourceId, reserved)
  }
  reserved.set(title, now + FORK_TITLE_RESERVATION_TTL_MS)
  if (reserved.size <= FORK_TITLE_RESERVATION_MAX_PER_SOURCE) return
  // Drop the assignment closest to expiry (the oldest one) — bounded memory only.
  let oldestTitle: string | undefined
  let oldestExpiry = Number.POSITIVE_INFINITY
  for (const [candidate, expiresAt] of reserved) {
    if (expiresAt >= oldestExpiry) continue
    oldestExpiry = expiresAt
    oldestTitle = candidate
  }
  if (oldestTitle !== undefined && oldestTitle !== title) reserved.delete(oldestTitle)
}

function releaseForkTitle(sourceId: string, title: string): void {
  const reserved = forkTitleReservations.get(sourceId)
  if (reserved === undefined) return
  reserved.delete(title)
  if (reserved.size === 0) forkTitleReservations.delete(sourceId)
}

/**
 * A rename failure that may already have applied: the mutation reached the host
 * and only the answer was lost. Only these two classes are ambiguous; every
 * other throw is a pre-dispatch/business refusal (`callAndThrow` promotes an
 * unclassified mutation failure to the first one).
 */
function renameOutcomeUnknown(error: unknown): boolean {
  return error instanceof MutationOutcomeUnknownError || error instanceof ResponseLostError
}

/**
 * Publish one fork-child creation echo. `title` is the funnel-decided final label
 * (sparse: omitted on the plain path / when the source has no durable title).
 */
function reportForkChildCreated(
  sourceId: string,
  childId: string,
  parentSessionId: string,
  options: SessionCreationOptions,
  title: string | undefined,
): void {
  chamberBridge.reportSessionCreated({
    sourceId,
    sessionId: childId,
    parentSessionId,
    blank: false,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(title === undefined ? {} : { title }),
  })
}

/** 对 `sourceId` 执行 session.fork，并发布子会话的创建回声事实。子会话继承父内容，
 *  不是 blank 行；工作区成员位由 App 从 `parentSessionId` 解析。
 *
 *  `increaseTitleFrom` 非空时启用 skip-taken 标题策略（design 05 §2.2）：候选名 =
 *  源 durable 标题递增并跳过**同一来源**已用 durable 标题（authority ∪ 本窗口
 *  在飞预留），点击处理的同步段定名并预留；fork 返回后按权威集合复核一次（上游
 *  在 fork 后读 taken 的时序；未挂载来源没有 push 在 fork RTT 内落地，此步基本
 *  no-op）；随后 rename，**成功后才发布回声**（title = 意图标题），确定性失败
 *  释放预留并以继承标题发回声 + console.warn，结果未知保留预留并以意图标题发回声
 *  （可能已生效）。失败非致命：fork 已成功、子会话照常打开。不采用 host 返回的
 *  accepted title（instance-api 预算棘轮；残余登记见 design 05 §2.2）。plain 调用
 *  （无 increaseTitleFrom）保持旧行为：fork 成功后立即发回声、不 rename。 */
export async function forkSessionForSource(
  sourceId: string,
  sessionId: string,
  options: SessionCreationOptions = {},
): Promise<string> {
  const client = getInstanceClient(sourceId)
  const sourceTitle = options.increaseTitleFrom
  if (sourceTitle === undefined || sourceTitle === '') {
    const childId = await forkSession(client, sessionId)
    reportForkChildCreated(sourceId, childId, sessionId, options, options.title)
    return childId
  }

  let intendedTitle = increasedForkTitle(sourceTitle, takenForkTitles(sourceId))
  reserveForkTitle(sourceId, intendedTitle, Date.now())
  let childId: string
  try {
    childId = await forkSession(client, sessionId)
  } catch (error) {
    releaseForkTitle(sourceId, intendedTitle)
    throw error
  }
  // Upstream reads `taken` AFTER the fork resolves; re-check the AUTHORITY only
  // (our own reservation must never bump us). For an unmounted source no push
  // lands inside the fork RTT, so this is normally a no-op there.
  const authoritativeAfter = authoritativeForkTitles(sourceId)
  if (authoritativeAfter.has(intendedTitle)) {
    releaseForkTitle(sourceId, intendedTitle)
    intendedTitle = increasedForkTitle(sourceTitle, takenForkTitles(sourceId, authoritativeAfter))
    reserveForkTitle(sourceId, intendedTitle, Date.now())
  }
  try {
    await renameSession(client, childId, intendedTitle)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (renameOutcomeUnknown(error)) {
      // May already have applied: keep the reservation; the authority settles it.
      reportForkChildCreated(sourceId, childId, sessionId, options, intendedTitle)
      console.warn('[chamber] fork child rename outcome unknown for ' + sourceId + '/' + childId
        + ': ' + reason + '; keeping the intended title')
      return childId
    }
    // Provably not applied (business refusal / pre-dispatch): the host keeps the
    // child's inherited durable title, so the echo must not claim the increment.
    releaseForkTitle(sourceId, intendedTitle)
    reportForkChildCreated(sourceId, childId, sessionId, options, sourceTitle)
    console.warn('[chamber] fork child rename failed for ' + sourceId + '/' + childId
      + ': ' + reason + '; the child keeps its inherited title')
    return childId
  }
  // Success: keep the reservation until the authority lists the title (observed
  // on the next fork) or the TTL retires it; the echoed title is the intent.
  reportForkChildCreated(sourceId, childId, sessionId, options, intendedTitle)
  return childId
}

/** 对 `sourceId` 执行 workspace.archiveSession，并发布撤下事实。App 据此退休该会话的
 *  待定创建回声，并记一条本地**归档墓碑**（未挂载来源上刚归档的行也必须立刻消失——
 *  那条来源没有任何活通道能带出新的归档集）。
 *
 *  `stopActivity`：上游归档准入的两段式第二段。首调不带它，宿主对有活跃工作的会话
 *  以 `workspace/session-active` 拒绝并列出活动；用户确认后带它重发，宿主写归档集并由
 *  自己的 provider 停止该会话的工作（回合/子代理后代/后台任务/定时提醒），客户端不再
 *  自跑补偿停止腿。 */
export async function archiveSessionForSource(
  sourceId: string,
  sessionId: string,
  options: { stopActivity?: boolean } = {},
): Promise<void> {
  await archiveSession(getInstanceClient(sourceId), sessionId, options)
  chamberBridge.reportSessionRemoved({ sourceId, sessionId })
}

/** 对 `sourceId` 执行官方 `workspace/unarchiveSession`（0.1.7，幂等），并发布恢复
 *  事实。App 据此立即清除该会话的本地归档墓碑——权威集合收缩**不**覆盖它，墓碑的收敛规则
 *  只退休仍被集合覆盖的 id；重列由挂载 push 的 archive-set 收缩走既有重列机器。 */
export async function unarchiveSessionForSource(sourceId: string, sessionId: string): Promise<void> {
  const client = getInstanceClient(sourceId)
  await callAndThrow(() => client.workspace.unarchiveSession({ sessionId }))
  reportSessionRestored({ sourceId, sessionId })
}

/** 对 `sourceId` 执行官方 `workspace/pinSession`（幂等；宿主拒绝归档中的会话）。**不发布本地事实**：
 *  置顶集只有挂载 follow 基线/增量一条线源，乐观回声会与未知集合打架；调用点
 *  在成功后照常走 `chamberBridge.requestRefresh`，标记由下一次权威推送落定。 */
export async function pinSessionForSource(sourceId: string, sessionId: string): Promise<void> {
  await pinSession(getInstanceClient(sourceId), sessionId)
}

/** 对 `sourceId` 执行官方 `workspace/unpinSession`（幂等，无存在性检查）。同前：无本地事实。 */
export async function unpinSessionForSource(sourceId: string, sessionId: string): Promise<void> {
  await unpinSession(getInstanceClient(sourceId), sessionId)
}
