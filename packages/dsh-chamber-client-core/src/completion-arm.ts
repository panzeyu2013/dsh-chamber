/**
 * N-ctx completion-arm correction — the ONLY chamber-side state in the
 * completed-unread model.
 *
 * Authority is the vendor's own `uiSession.sessionStatus.completionUnread`
 * (memory-only; armed on a running→idle edge while the session is NOT retained
 * by this ctx's main view; cleared on re-running, on becoming main-retained, or
 * when the row leaves a ready list). The chamber keeps every mounted instance
 * view alive with its own mainView retention across source switches (session
 * keep-alive, design 06 §4.2), so a HIDDEN source's last-opened session keeps
 * `isMain === true` forever and every completion in it is silently never armed.
 * That session is exactly the one the user just left — the most likely
 * background completion.
 *
 * This pure step fills ONLY that hole, plus the case the vendor never covers at all:
 * each fresh running→idle edge can arm the ctx's mainView-retained `current` row of a
 * source that is not painted, and — when a source has NO official ctx report
 * (`factsOnly`, the facts-only provenance; never inferred from `current === undefined`)
 * — every row with a fresh host running→idle edge. It is ROW-keyed and never sweeps —
 * reading one row clears only that row — so a source whose `current` moved on can hold
 * one arm per distinct completed row (exactly the upstream "N unread sessions"
 * semantics). Disarmed by re-running, by reading it (the painted source with that row as
 * its current, or the App's open intent for a no-ctx source), or by leaving an
 * authoritative list. Source retirement is the App dropping the whole per-source table,
 * so this step never sees it.
 *
 * Deliberately NOT a second ledger: no persistence, no watermark, no clock, no
 * facts track. When the official bit is true the arm is irrelevant —
 * `mergeRuntimeFacts` ORs them, and the vendor clears its own bit on reading.
 */

/** Fresh-channel rows of one source (the per-session facts slice the channel reports). */
export type CompletionArmRows = Readonly<Record<string, { running?: boolean; beforeBaseline?: boolean } | undefined>>

/** One step's inputs: the App's reading fact plus that source's fresh report. */
export interface CompletionArmStepInput {
  /** The ctx's mainView-retained row (the vendor `isMain` target), if any. */
  current: string | undefined
  /** Fresh channel rows; undefined = no report (freeze — memory kept, never arm). */
  rows: CompletionArmRows | undefined
  /** The source is the PAINTED (on-screen) view — the App fact, never the bridge selection. */
  painted: boolean
  /** The official list is authoritative (an absent row means deleted). */
  listComplete: boolean
  /**
   * 官方列表**基数已知**（facts 快照的 `baselines !== undefined`）。未知 ≠ 未就绪：第二支
   * 只在「已知且未就绪」时启用，未知时关闭——绝不把"没有清单事实"当"清单未就绪"凭空武装
   * （假完成点，P1）。缺席 = false；有壳路径无消费者（inert）。
   */
  listKnown?: boolean
  /** A stale (disconnected) report is never arm evidence. */
  stale: boolean
  /**
   * 本来源此刻没有官方 ctx 上报（provenance = virtual）：vendor 的 isMain 规则没有运行时
   * 主场，逐行的 host running 边沿就是唯一证据。**不得**由 `current === undefined` 推断
   * （有壳 ctx 也可合法无 current）。缺席 = false ⇒ 有壳路径逐字不变。
   */
  factsOnly?: boolean
  /** provenance = virtual 时的"已读"事实：App 的会话打开意图（无官方 current 可用）。 */
  readIntent?: string | undefined
}

/** Next state for one source. `arms` is row-keyed: an entry comes only from
 * that row's own completion edge (no sweep), so no stale true survives in it. */
export interface CompletionArmStepResult {
  arms: Record<string, boolean>
  running: Record<string, boolean>
  changed: boolean
}

/** True-only table comparison (absent = false); the tables never store false. */
export function sameTrueTable(
  left: Readonly<Record<string, boolean>>,
  right: Readonly<Record<string, boolean>>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if ((left[key] === true) !== (right[key] === true)) return false
  }
  return true
}

export function stepCompletionArm(
  prevArms: Readonly<Record<string, boolean>>,
  prevRunning: Readonly<Record<string, boolean>>,
  input: CompletionArmStepInput,
): CompletionArmStepResult {
  if (input.rows === undefined) {
    // Freeze: no report means no evidence either way (never arm, never clear).
    return { arms: { ...prevArms }, running: { ...prevRunning }, changed: false }
  }
  const nextRunning: Record<string, boolean> = {}
  for (const [id, row] of Object.entries(input.rows)) {
    // 逐行写入**观察到的布尔**（false 也写，unknown 不写）：running 记忆里的 `undefined`
    // 必须真正等价「从未观察」——只存 true 时，首见 idle 行的 false 不落记忆，点击读清
    // 后下一拍的第二支又会以"从未观察"重新武装（W11）。unknown 仍缺席。
    if (row !== undefined && row.running !== undefined) nextRunning[id] = row.running
  }
  const arms: Record<string, boolean> = { ...prevArms }
  // Re-running disarms (the vendor deletes its own bit on the same edge). The memory table
  // now carries observed `false` too, so the edge must still key on running === true.
  for (const id of Object.keys(nextRunning)) {
    if (nextRunning[id] === true && arms[id] === true) delete arms[id]
  }
  // Reading disarms: the painted source is showing its current row.
  if (input.painted && input.current !== undefined && arms[input.current] === true) delete arms[input.current]
  // provenance = virtual：没有官方 current，App 的打开意图是唯一的已读事实；即便该来源
  // 的壳 boot 失败、永不出现 current，点击也一定能消点（否则复现"点击消不掉"）。
  if (input.factsOnly === true && input.readIntent !== undefined && arms[input.readIntent] === true) {
    delete arms[input.readIntent]
  }
  // Authoritative list: rows that left it drop the arm. The edge memory needs no
  // pass — it is rebuilt from this report every step, so a row absent here is
  // already gone from nextRunning (缺席即丢；S6 删掉的空转退役循环是死代码).
  if (input.listComplete) {
    for (const id of Object.keys(arms)) if (input.rows[id] === undefined) delete arms[id]
  }
  if (!input.painted && !input.stale) {
    if (input.factsOnly === true) {
      // provenance = virtual：无官方 mainView/isMain，逐行的 host running 边沿武装
      // （每个不同行一格，与上游"N 个未读会话"同语义）。
      for (const [id, row] of Object.entries(input.rows)) {
        // 正在被读的那一行不武装（同拍读到与完成同时到达也不得留点：无官方位可清）。
        if (id !== input.readIntent && prevRunning[id] === true && row?.running === false) arms[id] = true
      }
      // 上游 observeRunning 的第二支：首见即 idle，且官方列表**已知**尚未就绪（那时没有
      // isMain 可言）。未知（没有 baselines 事实）绝不等于未就绪：关闭第二支（P1 假完成点）。
      // 行来源只认"首次观察来自状态事件"（列表播种不带该位）。
      if (input.listKnown === true && input.listComplete !== true) {
        for (const [id, row] of Object.entries(input.rows)) {
          if (id !== input.readIntent && row?.beforeBaseline === true && row.running === false
              && prevRunning[id] === undefined) {
            arms[id] = true
          }
        }
      }
    } else if (input.current !== undefined && prevRunning[input.current] === true
      && input.rows[input.current]?.running === false) {
      // The hole: the vendor suppressed this completion as main-retained, while the
      // user is on another source. Exactly one candidate per source (the current row).
      arms[input.current] = true
    }
  }
  const changed = !sameTrueTable(arms, prevArms) || !sameRunningMemory(nextRunning, prevRunning)
  return { arms, running: nextRunning, changed }
}

/**
 * Running-memory comparison: an observed `false` MUST differ from `undefined`
 * ("never observed") — the beforeBaseline second arm keys on that distinction,
 * and {@link sameTrueTable} deliberately folds both to "not true". Without this
 * exact comparison a false-only step would report no change, the caller would
 * skip persisting the memory, and the second arm could re-fire after a read.
 */
function sameRunningMemory(
  left: Readonly<Record<string, boolean>>,
  right: Readonly<Record<string, boolean>>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (left[key] !== right[key]) return false
  }
  return true
}
