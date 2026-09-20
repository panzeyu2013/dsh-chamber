/**
 * 会话面绘制信号（2026-12 P3）——用"壳自己画出了什么"替换"App 侧事实猜就绪"。
 *
 * ## 背景
 *
 * 打开意图揭示门（`sidebar/src/shared/open-intent.ts` 的 `shouldHoldViewVeil`）在 boot
 * settle 后继续持有遮罩，直到**请求的会话**在屏上。但它的输入是两个异步镜像事实——
 * `runtimeFacts[viewId].current`（推送）与 `aggregates` 的 session `blank` 行（未知按
 * blank 处理）——两者迟到或抖动时，遮罩会挂在已经渲染好的壳上，最长烧满 open 预算
 * （单次 8s、排队 68s），并且同一动作时快时慢（用户观察到的"白屏 / 直接显示载入中"交替）。
 *
 * 本模块把这段判定换成**壳自己暴露的 DOM 事实**：官方会话根 `div[data-phase]`（已由
 * `scripts/upstream/mobile-anchors.mjs` 登记的上游锚点）。相位语义已对安装态上游产物逐条
 * 核对（2026-12 review；`dsh-client-ui-conversation/lib/client.js`）：
 *
 *  - `hero`：会话根未选中任何会话，或选中的是"空白新会话"（`shellPhase === 'blank'` 且
 *    `openState === 'open'` 或 `summaryBlank === true`）——**无正当内容**，遮罩保持
 *    （这正是揭示门存在的理由：不闪空白"新会话"）；
 *  - `settling`：会话已选中，但内容相位仍是 blank 且正在载入（`openState === 'loading'`），
 *    或等待父目录可用（`parentAvailabilityPending`，continuable subagent）——同样按
 *    "无正当内容"处理，遮罩保持；
 *  - `active`：上游把它写成 `settling ? 'settling' : hero ? 'hero' : 'active'`（client.js
 *    `conversationPhase`/`settling`/`hero` 邻近行）——**它是"非 hero 非 settling"的兜底值**，
 *    不是一个"真实会话面已在屏"的断言：`shellPhase === 'blank'` 且 `openState ∈ {cold, error,
 *    undefined}` 而 `summaryBlank !== true` 的组合、以及会话快照缺失都会落到这里
 *    （第二轮 review MINOR-3；移动插件 `session-stall.ts` 同样写作 "active (everything else)"）。
 *    语义上它**释放遮罩**，因此这个方向是 fail-open：只保证"不是 hero/settling"，不保证
 *    "有正当内容"，也不保证"是请求的那个会话"（详见 design 05 §2.2.1 的取舍与残余）；
 *  - 取不到会话根：`absent`（boot 早期，或 ui-chat 未注册的降级形态）。
 *
 * `data-phase` 在同一容器里不止一个发射点（会话根 + composer contenteditable，后者值域是
 * inert/plain/claimed/…），所以读取**不靠"第一个 `[data-phase]`"**，而是从恒在的
 * {@link SESSION_SCROLL_ANCHOR} 反查最近的 `[data-phase]` 祖先（与移动插件
 * `session-stall.ts` 同款）；取不到向上关系时按 `absent` 处理（有界出口）。
 *
 * ## 释放规则（2026-12 review 修订：窗口基准 = **本次持有**的起点）
 *
 * 遮罩的兜底窗必须从"已 settle 且揭示门首次持有"的那一刻起算，**绝不能**锚在 shell 的
 * settle 时刻——温壳上 settle 早已是几分钟前，用它会让持有窗在第一帧就过期，揭示门在温壳
 * 上整体退化为无操作（review 发现并复现的 MAJOR）。
 *
 *  - `active` ⇒ 立即释放；
 *  - `absent` ⇒ 以 {@link SURFACE_ABSENT_FALLBACK_MS} 为界（观察不到会话根：降级形态）；
 *  - `hero` / `settling` ⇒ 保持遮罩，只留 {@link SURFACE_MAX_HOLD_MS} 外层保险
 *    （> 68s 排队预算；正常路径由 App 的 open 生命周期先释放意图）；
 *  - 未 settle ⇒ 永不释放（boot 期遮罩由 `!settled` 契约负责）；
 *  - 时钟未建立 ⇒ 永不释放（新一次持有的第一帧，相位可能还是上一代的残留）。
 *
 * 释放是**电平**而不是闩锁：观察器在持有窗内始终运行，相位若回到 `hero`/`settling`（例如
 * 官方初始导航先把持久化的真实会话显示出来、随后 workspace-follow 又复用/新建 blank 会话），
 * 遮罩仍会回来——否则一次瞬时 `active` 会让空白"新会话"在整个 open 窗内裸露（review 的
 * 第二个 MAJOR）。窗口本身把来回抖动限制在 open 生命周期内。
 *
 * 本模块是叶子（零运行时 import），可被 node 直测；DOM 访问只发生在
 * {@link readSessionSurfacePhase} 的入参接口上（观察器接线在 InstanceView）。
 */

/** 会话根相位（脚本与移动插件共用的上游锚点取值域）。 */
export type SessionSurfacePhase = 'absent' | 'hero' | 'settling' | 'active'

/** 会话根相位属性的名字（观察器 attributeFilter 与查询共用一处定义）。 */
export const SESSION_PHASE_ATTRIBUTE = 'data-phase'

/**
 * 会话根的反查锚：`[data-conversation-scroll]` 在 hero/settling/active 三态都由官方
 * ConversationRoot 恒渲染（composer 座在它**内部**，与它同属会话根子树），因此从它
 * `closest` 向上拿相位比"容器内第一个 `[data-phase]`"更结构化（上游再加/前插相位
 * 节点也不会读错）。
 */
export const SESSION_SCROLL_ANCHOR = '[data-conversation-scroll]'

/**
 * `absent`（观察不到会话根）的兜底窗：到期即揭幕，把解释交给壳自身的装载面与既有
 * `.boot-gap-layer` 降级横幅——绝不出现无出口的加载层。
 */
export const SURFACE_ABSENT_FALLBACK_MS = 2_000

/**
 * `hero`/`settling`（观察得到但尚无正当内容）的外层保险：只防"持有永不到期"，
 * 取在 App 的 open 排队预算（68s）之上；正常路径由 App 释放意图，本上界不会触发。
 */
export const SURFACE_MAX_HOLD_MS = 70_000

/**
 * 相位 → 本次持有的上界（唯一映射，组件与判据共用一处，避免两处手工同步）：
 * `absent` 走 2s 兜底，`hero`/`settling` 走 70s 外层保险（只防"持有永不到期"）。
 */
export function surfaceHoldBoundMs(phase: SessionSurfacePhase): number {
  return phase === 'absent' ? SURFACE_ABSENT_FALLBACK_MS : SURFACE_MAX_HOLD_MS
}

/** 判定输入：全部是"已观察到的事实"，无异步猜测。 */
export interface SessionSurfaceFacts {
  /** 壳是否已 settle（booted 或失败）。未 settle 时遮罩由 boot 期契约负责。 */
  settled: boolean
  /** 当前观察到的会话根相位。 */
  phase: SessionSurfacePhase
  /** **本次持有**开始的时刻（ms epoch）；null = 时钟尚未建立（保守：继续持有）。 */
  holdStartedAtMs: number | null
  /**
   * 相位为 `absent` 时的**连续缺失起点**（相位从非 absent 变成 absent 的那一帧；ms，同源时钟）。
   * 缺省（null/未给）时退回 {@link holdStartedAtMs}：会话根**从未出现**的降级形态仍按持有
   * 起点 2s 揭幕。按"连续缺失"而不是"持有起点"计窗的理由：持有 60s 后会话根短暂消失一帧
   * （插件重注册、会话切换空档）时，若按持有起点算，遮罩会立刻消失、下一帧根回来又回遮
   * ——电平式释放下就是"遮罩→露壳→遮罩"的闪动（2026-12 第二轮 review MINOR-1）。
   */
  absentSinceMs?: number | null
  /** 当前时刻（ms epoch，调用方与持有时钟同源）。 */
  nowMs: number
}

/**
 * 遮罩是否可以因会话面信号而释放。
 *
 * 语义边界：本函数**只回答"能不能揭幕"**，不回答"要不要持有"——持有意图（在途 open、
 * 失败、模态覆盖层）仍由 App 与 InstanceView 的既有合取项负责。
 */
export function shouldReleaseVeilForSurface(facts: SessionSurfaceFacts): boolean {
  if (facts.settled !== true) return false
  // 时钟先于相位判定：持有刚开始的那一帧时钟还没建立（时钟由被动 effect 落 state），
  // 而 surfacePhase 可能仍留着**上一代**最后观察到的 'active'——若让相位先短路，新一次
  // 持有一个 commit 就既不显示遮罩、也不隐藏租客（2026-12 第二轮 review 的状态机反例）。
  // 时钟未建立 = 本代还没有任何相位事实，保守继续持有。
  if (facts.holdStartedAtMs === null) return false
  if (facts.phase === 'active') return true
  const elapsed = facts.nowMs - facts.holdStartedAtMs
  // 时钟回拨/NaN：保守继续持有（有界出口由 App 的 open 生命周期与外层保险兜）。
  if (!(elapsed >= 0)) return false
  if (facts.phase === 'absent') {
    // absent 用"连续缺失"起点（缺省退回持有起点，覆盖"根从未出现"的降级形态）。
    const absentBase = facts.absentSinceMs ?? facts.holdStartedAtMs
    const absentElapsed = facts.nowMs - absentBase
    if (!(absentElapsed >= 0)) return false
    return absentElapsed >= SURFACE_ABSENT_FALLBACK_MS
  }
  return elapsed >= SURFACE_MAX_HOLD_MS
}

/** 读取相位所需的最小 DOM 面（node 测试用桩即可，不依赖真实 DOM）。 */
export interface SessionSurfaceRoot {
  querySelector(selector: string): {
    closest(selector: string): { getAttribute(name: string): string | null } | null
  } | null
}

/**
 * 读取容器内的会话根相位：`[data-conversation-scroll]` → 最近的 `[data-phase]` 祖先。
 * 取不到锚点或祖先时返回 `absent`（有界出口由 {@link SURFACE_ABSENT_FALLBACK_MS} 给）；
 * 祖先存在但取值未知时保守返回 `hero`（保持遮罩），绝不把"没看懂"读成"已就绪"。
 */
export function readSessionSurfacePhase(root: SessionSurfaceRoot): SessionSurfacePhase {
  const anchor = root.querySelector(SESSION_SCROLL_ANCHOR)
  const node = anchor === null ? null : anchor.closest(`[${SESSION_PHASE_ATTRIBUTE}]`)
  if (node === null) return 'absent'
  const raw = node.getAttribute(SESSION_PHASE_ATTRIBUTE)
  if (raw === 'active' || raw === 'settling' || raw === 'hero') return raw
  return 'hero'
}
