/**
 * 完成未读账本的**派生投影**。
 * 唯一未读谓词来自 client-core 的 4 参 `deriveUnread`（本模块**不重实现**）；本模块只做三件事：
 *   1. 通道边沿机（`reconcileCompletedFacts`）承担 running→idle 武装——**包括 facts 不可判窗口**
 *      （通知轨一直用的就是这条证据；没有它，facts 载体一坏，整个未读面就停在初始空态）；
 *   2. 有 facts 行且可判时 facts 是该会话的**完成权威**（通道边沿被结算，aborted+user 不得假武装）；
 *   3. 首见基线播种一步（`factsBaselineSeed`）——地板镜像复用 unread-store 的唯一实现。
 * 规则 0（冻结只冻 facts 结论，通道边沿照常；通道也缺席才原样冻结）全文见 design 19 §3.7.1。
 * `listComplete` 是**唯一剪枝门**，且必须与通道**同时在场**（authoritativeList）：没收到列表
 * 不等于「列表为空」，缺省/undefined/无通道一律保留 `prevLedger`（列表短暂收缩不得假清）。
 * 判定函数由调用方注入 client-core 的导出（零运行时 import），接线锁确保 App 喂的是共享导出。
 */
import type { TurnEndFact } from '@dsh-chamber/dsh-chamber-client-core'
// 读水位 host 域规则 / 地板 / 源级上界的**唯一实现**（「全部已读」与本模块的首见播种共用）。
import { hostWatermark, maxWatermark, seedReadFloor } from './unread-store.ts'

/** facts 源的一行（session-state 判定输入；时间值全在 host/observer 域）。 */
export interface UnreadDerivationFactsRow {
  sessionId: string
  running: boolean
  updatedAt: number
  completedAt: number | null
  lastTurnEnd: TurnEndFact | null
  completedAtSource?: 'observed' | 'reconstructed' | null
  /**
   * completedAt 的**时间域**（无壳观察者内部标注，gateway 事实源不携带）：
   * 'host'（可并入 host 域读水位）或 'observer'（客户端观察者戳——只武装未读，
   * **绝不**推进读水位）；缺省 = host 域（含 gateway 的 reconstructed：其观察者就在 host 上）。
   */
  completedAtDomain?: 'host' | 'observer' | null
}

export interface UnreadDerivationDeps {
  deriveUnread: (
    completedAt: number | undefined,
    lastTurnEnd: TurnEndFact | null | undefined,
    readThrough: number | undefined,
    updatedAt: number | undefined,
  ) => boolean
  reconcileCompletedFacts: (params: {
    sessions: Record<string, { running?: boolean }>
    nextRunning: Record<string, boolean>
    prevRunning: Record<string, boolean>
    prevCompleted: Record<string, boolean>
    readingCurrent: string | undefined
    /** 缺席当删除的权威门（listComplete ∧ 通道在场）；清扫键空间由它放行。 */
    authoritativeList: boolean
  }) => { completed: Record<string, boolean>; changed: boolean }
}

export interface UnreadDerivationInput {
  /** gateway facts 行；undefined = channel-only / legacy / degraded。 */
  facts?: Readonly<Record<string, UnreadDerivationFactsRow>> | undefined
  /** 通道上报的 sessions（running 位）；undefined = 无挂载上报。 */
  channel?: Readonly<Record<string, { running?: boolean }>> | undefined
  /** 只有 true **且通道在场**（authoritativeList）才允许剪枝；缺省/undefined = 不剪。 */
  listComplete: boolean
  /** 易失 running 转移记忆（上一份）。 */
  prevRunning: Readonly<Record<string, boolean>>
  /** durable 未读回退账本（上一份投影；v4 edge 表）。 */
  prevLedger: Readonly<Record<string, boolean>>
  /** 该来源的 host 域读水位。 */
  readMarks: Readonly<Record<string, number>>
  /** 正在阅读的会话（paintedView ∩ current ∩ hasFocus，由 App 计算）。 */
  readingSessionId: string | undefined
  /**
   * facts 快照是否可判（规则 0 判定闸，全文见 design 19 §3.7.1）：false = facts 冻结支
   * （不按 facts 结算/剪枝/clobber，通道边沿照常）；只有快照缺席才是 true 的 channel-only。
   * 谓词唯一家 `session-facts-source.ts`，接线锁 `test/wiring/session-authority-wiring.test.ts`。
   */
  factsVerified: boolean
}

export interface UnreadDerivationResult {
  /** 完成未读投影（写 completedBySource[source]，并作为 v4 edge 表落盘）。 */
  unread: Record<string, boolean>
  /** 写回的易失 running 记忆。 */
  nextRunning: Record<string, boolean>
  changed: boolean
}

/** 同形布尔表比较（账本 identity 闸）。 */
export function sameBooleanMap(
  left: Readonly<Record<string, boolean>>,
  right: Readonly<Record<string, boolean>>,
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if ((left[key] === true) !== (right[key] === true)) return false
  }
  return true
}

/** 通道 running 转移记忆：通道位 +（非权威列表时）保留缺席会话的旧记忆。两支共用一份实现。 */
function channelRunning(
  channel: Readonly<Record<string, { running?: boolean }>>,
  prevRunning: Readonly<Record<string, boolean>>,
  authoritativeList: boolean,
): Record<string, boolean> {
  const nextRunning: Record<string, boolean> = {}
  for (const [sessionId, row] of Object.entries(channel)) {
    nextRunning[sessionId] = row?.running === true
  }
  if (!authoritativeList) {
    for (const [sessionId, wasRunning] of Object.entries(prevRunning)) {
      if (nextRunning[sessionId] === undefined) nextRunning[sessionId] = wasRunning
    }
  }
  return nextRunning
}

export function deriveSourceUnread(
  input: UnreadDerivationInput,
  deps: UnreadDerivationDeps,
): UnreadDerivationResult {
  // 权威列表门：listComplete 与通道**同时在场**才允许把缺席当删除（没收到列表 ≠ 列表为空）。
  const authoritativeList = input.listComplete && input.channel !== undefined
  // 规则 0（判定闸）：facts 不可判只冻 facts 的结论（不结算/剪枝/clobber，通道边沿照常），通道也缺席才原样冻结。
  if (!input.factsVerified && input.channel === undefined) {
    return {
      unread: { ...input.prevLedger },
      nextRunning: { ...input.prevRunning },
      changed: false,
    }
  }
  const channel = input.channel ?? {}
  const facts = input.facts ?? {}
  const nextRunning = channelRunning(channel, input.prevRunning, authoritativeList)
  // 通道边沿机（现行 arm/disarm/阅读解除/离表清扫规则，一套不改；prevCompleted 是结余）。
  const edgeStep = deps.reconcileCompletedFacts({
    sessions: channel,
    nextRunning,
    prevRunning: input.prevRunning,
    prevCompleted: input.prevLedger,
    readingCurrent: input.readingSessionId,
    authoritativeList,
  })
  const unread: Record<string, boolean> = {}
  const edge: Record<string, boolean> = { ...edgeStep.completed }
  if (!input.factsVerified) {
    // facts 不可判：通道边沿是本次唯一证据（一行 facts 都不用，也不按 facts 解除）。
    for (const [sessionId, armed] of Object.entries(edge)) {
      if (armed === true) unread[sessionId] = true
    }
    return { unread, nextRunning, changed: !sameBooleanMap(unread, input.prevLedger) }
  }
  const allIds = new Set<string>([...Object.keys(channel), ...Object.keys(facts)])
  // 结果是 Record，键顺无判定语义；Set 迭代是确定序（插入序），不为键顺做热路径拷贝+排序。
  for (const sessionId of allIds) {
    const fact = facts[sessionId]
    if (fact === undefined) {
      if (edge[sessionId] === true) unread[sessionId] = true
      continue
    }
    // W1（M1）：无可用 host 水位 = 「不知道内容在哪」，不是「内容位置是 0」。0 水位在协议里
    // 不是极小值——host 的 updatedAt = max(header.createdAt, lastPromptAt ?? 0)，合法来源永远 > 0
    // （watermark.ts 同判：completionWatermark 对 0/0 返回 undefined）。因此这种行**不得**产出
    // unread=false，也**不得**清通道臂：否则一个 0 水位的 facts 行会把刚武装的点抹掉（实测症状）。
    // 方向是 fail-closed 向未读：保留已武装的边沿，但不假武装（无证据不产新点）。
    if (hostWatermark(fact.updatedAt, fact.completedAt, fact.completedAtDomain) === 0) {
      // 保留**已武装**或**上一拍已判未读**的会话：既不清通道臂，也不产 unread=false。
      // 取舍（已登记）：源侧水位坏着时这些点只能靠「阅读」之外的证据清除（viewingReadWatermark
      // 同样要求可用水位）——即水位没恢复前它们是钉子户；这是 fail-closed 的一侧，
      // 源侧修好后行一有可用水位即恢复常规结算（W3 记录语义将替换这一族）。
      if (edge[sessionId] === true || input.prevLedger[sessionId] === true) unread[sessionId] = true
      continue
    }
    // 事实是该会话的完成权威（含 aborted+user 的抑制）；通道边沿在此结算，
    // 避免「用户停止被通道 running→idle 假武装」。
    delete edge[sessionId]
    const viewing = sessionId === input.readingSessionId
    const factUnread = !viewing
      && deps.deriveUnread(
        fact.completedAt ?? undefined,
        fact.lastTurnEnd,
        input.readMarks[sessionId],
        fact.updatedAt,
      )
    if (factUnread) unread[sessionId] = true
  }
  // 非权威列表（listComplete !== true 或无通道）：缺席会话保留 prevLedger 的未读（不清扫）。
  if (!authoritativeList) {
    for (const [sessionId, wasUnread] of Object.entries(input.prevLedger)) {
      if (wasUnread !== true || allIds.has(sessionId)) continue
      unread[sessionId] = true
    }
  }
  return { unread, nextRunning, changed: !sameBooleanMap(unread, input.prevLedger) }
}

/**
 * 正在阅读的会话水位推进：返回推进后的读水位（单调），undefined/0 不臆造。
 * 有 facts 行时取 max(updatedAt, completedAt)——host 域规则只有一份实现（unread-store.hostWatermark），
 * completedAt 只在 **host 域**参与（observer 降级戳只武装、不推进读水位）；无 facts 行返回 undefined
 * （通道边沿轨结算）。代价（已评估、接受）：observer 域完成事实的未读无法被「只阅读」清掉——
 * fail-closed 的一侧，比用客户端墙钟把真正的 host 内容误判为已读安全；真正闭合需要 host 域完成游标。
 */
export function viewingReadWatermark(
  row: UnreadDerivationFactsRow | undefined,
): number | undefined {
  if (row === undefined) return undefined
  const watermark = hostWatermark(row.updatedAt, row.completedAt, row.completedAtDomain)
  return watermark > 0 ? watermark : undefined
}

/**
 * 首见基线播种的**一步**（纯函数；hook 只负责 refs 与落盘）：本来源**这一代化身**的首个
 * 可判批次把源级读水位地板镜像到全表——没有它，facts 面首次可用时历史完成会在同一拍整表
 * 武装（实测 148 条会话 ⇒ 148 个点 + Dock 211）。地板与「全部已读」共用 `seedReadFloor`，
 * 域规则与派生同一条（observer 域戳只武装、不进地板）；已武装的完成点由 keepUnread 排除。
 *
 * 化身判据 = **owner token 的对象身份**（`SourceOwnershipRegistry.capture(sourceId)`；无
 * owner 时回落页代 token）。指纹不是化身身份：same-id 删后重现会让新一代拿到与旧代相同的
 * 传输指纹（只有 `retire` 后的 `activate` 必然 mint 新对象）；标记挂在指纹上时，重挂会跳过
 * 播种而 readMarks 已随退役清空 ⇒ `deriveUnread` 整表武装。也不用「readMarks 为空 ⇒ 标记
 * 失效」做近似：全部行都被 keepUnread 时标记会在什么都没写的情况下被消费（readMarks 合法
 * 为空），该近似会把下一拍的真完成一起吸收——唯一可靠的是「本代是否已经播过」这个身份事实。
 *
 * 只在真的可播（`through > 0`）的那一拍消费标记：空/全零水位批次什么都没镜像，若此刻消费，
 * 这一代化身再也不会播，下一批首见历史完成会按 completedAt 直接武装。
 */
export interface FactsBaselineSeedInput {
  /** 本拍可判 facts 行；undefined = 不可判（冻结/降级：绝不播种）。 */
  factsRows: Readonly<Record<string, UnreadDerivationFactsRow>> | undefined
  /** 本来源当前化身身份（SourceOwnershipRegistry 的 token 对象；无 owner = 页代 token）。 */
  incarnation: unknown
  /** 该来源上一份播种标记（undefined = 本化身尚未播种）。 */
  seededIncarnation: unknown
  /** 该来源当前读水位表。 */
  readMarks: Readonly<Record<string, number>>
  /** 已武装的完成点（seedReadFloor 的 keepUnread）。 */
  keepUnread: Readonly<Record<string, boolean>>
}

export interface FactsBaselineSeedResult {
  /** true = 本次真的镜像了地板（调用方写回 readMarks 并落盘）。 */
  seeded: boolean
  /** true = 本化身此前已经播过种（标记命中）：稳态读数用它区分「已消费」与「从未消费」。 */
  alreadySeeded: boolean
  /** 应写回的化身标记（未播种 = 入参原值）。 */
  incarnation: unknown
  /** 播种后的读水位表（未播种 = 入参原值）。 */
  readMarks: Readonly<Record<string, number>>
}

export function factsBaselineSeed(input: FactsBaselineSeedInput): FactsBaselineSeedResult {
  const unchanged: FactsBaselineSeedResult = {
    seeded: false,
    alreadySeeded: input.seededIncarnation !== undefined && input.seededIncarnation === input.incarnation,
    incarnation: input.seededIncarnation,
    readMarks: input.readMarks,
  }
  if (input.factsRows === undefined) return unchanged
  // 标记已经属于本化身 ⇒ 播过了（标记只在真的播了之后才写）。
  if (input.seededIncarnation === input.incarnation) return unchanged
  const through = maxWatermark(input.factsRows)
  // 零水位/空批次：什么都没镜像，不消费这一代的机会（下一批照常尝试）。
  if (through <= 0) return unchanged
  return {
    seeded: true,
    alreadySeeded: false,
    incarnation: input.incarnation,
    readMarks: seedReadFloor(input.readMarks, input.factsRows, through, input.keepUnread),
  }
}
