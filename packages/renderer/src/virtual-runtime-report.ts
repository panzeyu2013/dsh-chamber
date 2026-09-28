/**
 * 无 ctx 来源的"虚拟上报"——判定侧读回退（design 19 §3.5 / design 06 §4.1–§4.4 的
 * 无壳边界）。
 *
 * facts 快照是无壳来源唯一的状态载体；本模块把它**按需**投影成壳上报的结构子集，
 * 只在两个判定读取点使用（修正臂步进与通知 reconcile 的 shell 输入），**绝不写回**
 * factsStore：物化会引入第二写者、渲染 stale 与判定 stale 混用、共享壳轨记忆与第二个
 * 壳边沿裁决点（物化被否见 design 06 §9）。
 *
 * - `listComplete` 只认快照的 `baselines`（wire `diagnostics.baselines`，进程内完整
 *   基线计数）；缺席 = false（旧端保守：不清臂），**绝不由行数推断**。`listKnown` 是
 *   该计数器**在场**（缺席 = 未知）：未知 ≠ 未就绪——第二支（首见 idle 武装）只在
 *   `listKnown && !listComplete` 时启用。
 * - `stale` = 判定不可用（渲染档可用但载体已断）：边沿全关、臂只冻结；渲染面读的是
 *   自己的 overlay/聚合行，不经过本模块（因此不会冒出"离线"标记）。
 * - `beforeBaseline` = 该行首次观察即来自无壳观察者的 status 事件（source-mux-facts
 *   首建；网关平面——快照/增量——都不赋该位）⇒ 上游 `observeRunning` 的第二支
 *   （首见 idle 也武装）在无壳来源上可忠实复现；列表播种的行不带该位。
 * - `identityConfirmed === false` 的行（仅由 status/activity/waterfall 首建、尚未被任何
 *   列表事实确认）一律跳过：它是 S1 门的判定面等价门（子代理绝不通知），观察者快照与
 *   本投影双保险。
 */
import { isFactsUsable, type SessionFactsPendingKind, type SessionFactsSnapshot } from './session-facts-source.ts'

/** 虚拟行 = 壳行判定子集（`ShellObservationRow` 的结构子集）。 */
export interface VirtualRuntimeRow {
  running: boolean
  pending?: SessionFactsPendingKind
  /** 首次观察来自观察者 status 事件（source-mux-facts 首建）；由快照行携带。 */
  beforeBaseline?: boolean
}

export interface VirtualRuntimeReport {
  sessions: Record<string, VirtualRuntimeRow>
  /** 官方列表是否已就绪（缺席/0 = false；离表清除只在 true 时允许）。 */
  listComplete: boolean
  /** 官方列表基数是否**已知**（`baselines !== undefined`）：未知 ≠ 未就绪，
   *  第二支武装只在 `listKnown && !listComplete` 时启用。 */
  listKnown: boolean
  /** 判定不可用（stale）：武装冻结、边沿关闭；不冒充渲染 stale。 */
  stale: boolean
}

/**
 * 判定侧投影：`undefined` = 无可判事实（来源无 facts / verdict 非 ok / 服务不可用）。
 * `stale` 的快照仍投影（臂需要冻结输入），只是 `stale: true`。
 */
export function virtualRuntimeReport(
  snapshot: SessionFactsSnapshot | undefined,
): VirtualRuntimeReport | undefined {
  if (snapshot === undefined || !isFactsUsable(snapshot)) return undefined
  const sessions: Record<string, VirtualRuntimeRow> = {}
  // for..in（不建 entries 数组）：投影在每次 facts 发布与每次臂步进都被调用，行数千级时
  // 这是该路径最主要的分配。（快照对象发布后不可变，但目前无测试钉住；本函数不缓存。）
  for (const sessionId in snapshot.rows) {
    const row = snapshot.rows[sessionId]!
    // S1 等价门（判定面）：身份未由列表事实确认的行不得投影——它可能其实是子代理，
    // 投递就会为子代理发真横幅。观察者快照已在源侧过滤该位；这里再挡一道，任何未来的
    // 生产者漏过滤都不会把未确认行送进判定面。
    if (row.identityConfirmed === false) continue
    sessions[sessionId] = {
      running: row.running,
      ...(row.pendingKind === null ? {} : { pending: row.pendingKind }),
      ...(row.firstSeenByDelta === true ? { beforeBaseline: true } : {}),
    }
  }
  return {
    sessions,
    listKnown: snapshot.baselines !== undefined,
    listComplete: (snapshot.baselines ?? 0) > 0,
    // 守卫已保证可判 ⇒ 等值于 !isFactsDecisionUsable（后者= usable && !stale）。
    stale: snapshot.stale === true,
  }
}
