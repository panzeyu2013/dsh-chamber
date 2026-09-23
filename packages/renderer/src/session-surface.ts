/**
 * 会话面绘制信号——以"壳自己画出了什么"为准，而非"App 侧事实猜就绪"。
 * ## 背景
 * 打开意图揭示门（`client-core/src/open-intent.ts` 的 `shouldHoldViewVeil`）在 boot
 * settle 后继续持有遮罩，直到**请求的会话**在屏上。但它的输入是两个异步镜像事实——
 * `runtimeFacts[viewId].current`（推送）与 `aggregates` 的 session `blank` 行（未知按
 * blank 处理）——两者迟到或抖动时，遮罩会挂在已经渲染好的壳上，最长烧满 open 预算
 * （单次 8s、排队 68s），并且同一动作时快时慢。
 * 本模块以**壳自己暴露的 DOM 事实**为准：官方会话根 `div[data-phase]`（
 * `scripts/upstream/mobile-anchors.mjs` 登记的上游锚点）。相位语义：
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
 *    （移动插件 `session-stall.ts` 同样写作 "active (everything else)"）。
 *    语义上它**释放遮罩**，因此这个方向是 fail-open：只保证"不是 hero/settling"，不保证
 *    "有正当内容"，也不保证"是请求的那个会话"（详见 design 05 的取舍与残余）；
 *  - 取不到会话根：`absent`（boot 早期，或 ui-chat 未注册的降级形态）。
 * `data-phase` 在同一容器里不止一个发射点（会话根 + composer contenteditable，后者值域是
 * inert/plain/claimed/…），所以读取**不靠"第一个 `[data-phase]`"**，而是从恒在的
 * {@link SESSION_SCROLL_ANCHOR} 反查最近的 `[data-phase]` 祖先（与移动插件
 * `session-stall.ts` 同款）；取不到向上关系时按 `absent` 处理（有界出口）。
 * ## 释放规则
 * 遮罩的兜底窗必须从"已 settle 且揭示门首次持有"的那一刻起算，**绝不能**锚在 shell 的
 * settle 时刻——温壳上 settle 早已是几分钟前，用它会让持有窗在第一帧就过期，揭示门在温壳
 * 上整体退化为无操作。
 *  - `active` ⇒ 立即释放；
 *  - `absent` / `unknown` ⇒ 以共享表的 2s 兜底为界（观察不到会话根 / 读不懂相位：降级形态）；
 *  - `hero` / `settling` ⇒ 保持遮罩，只留共享表的 70s 外层保险
 *    （> 68s 排队预算；正常路径由 App 的 open 生命周期先释放意图）；
 *  - 未 settle ⇒ 永不释放（boot 期遮罩由 `!settled` 契约负责）；
 *  - 时钟未建立 ⇒ 永不释放（新一次持有的第一帧，相位可能还是上一代的残留）。
 * 释放是**电平**而不是闩锁：观察器在持有窗内始终运行，相位若回到 `hero`/`settling`（例如
 * 官方初始导航先把持久化的真实会话显示出来、随后 workspace-follow 又复用/新建 blank 会话），
 * 遮罩仍会回来——否则一次瞬时 `active` 会让空白"新会话"在整个 open 窗内裸露。
 * 窗口本身把来回抖动限制在 open 生命周期内。
 * 本模块是叶子（零运行时 import），可被 node 直测；DOM 访问只发生在
 * {@link readSessionSurfacePhase} 的入参接口上（观察器接线在 InstanceView）。
 */

/** 会话根相位（脚本与移动插件共用的上游锚点取值域）。
 * `unknown` 是 P2 引入的独立取值：本 build 读不懂的取值不得折进 `hero`（那会按 70s
 * 外层保险持有），而应与 `absent` 同走 2s 兜底——版本歪斜的锚点不能把用户按在遮罩上。 */
export type SessionSurfacePhase = 'absent' | 'hero' | 'settling' | 'active' | 'unknown'

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
 * 相位采样（MutationObserver → 相位落 state）的最小间隔，
 * 每次 DOM 变更排一帧的采样在 boot 窗口（各来源壳 + 插件同时装载）等于每帧
 * 一次 React 状态更新；Apple 符号化的崩溃栈正是"rAF 回调内一个热函数 OSR 进入时
 * JSC 代码块替换 trap"。合并到 100ms 并把尾部采样保证住，语义不变（最终相位一定会被
 * 观察到，遮罩判定不依赖中间帧），每帧工作量下降约 6 倍。
 */
export const SURFACE_SAMPLE_MIN_INTERVAL_MS = 100

// 相位 → 上界映射与两个阈值（2s 兜底 / 70s 外层保险）由共享包提供：
// `surfaceBoundMs`/`decidePresentation` 是唯一判定，阈值在
// `@dsh-chamber/dsh-stream-state` 的 `PRESENTATION_THRESHOLDS`（tables.ts/tables.json 同源），
// 组件只消费帧里的 `veil`/`releaseAtMonoMs`。本模块只保留相位读取与采样间隔常量。

/** 读取相位所需的最小 DOM 面（node 测试用桩即可，不依赖真实 DOM）。 */
export interface SessionSurfaceRoot {
  querySelector(selector: string): {
    closest(selector: string): { getAttribute(name: string): string | null } | null
  } | null
}

/**
 * 读取容器内的会话根相位：`[data-conversation-scroll]` → 最近的 `[data-phase]` 祖先。
 * 取不到锚点或祖先时返回 `absent`（有界出口由共享表的 2s 兜底给）；
 * 祖先存在但取值未知时返回 `unknown`（与 absent 同界），绝不把"没看懂"读成"已就绪"，
 * 也绝不用 hero 的 70s 外层保险把一个版本歪斜的锚点按在遮罩上。
 */
export function readSessionSurfacePhase(root: SessionSurfaceRoot): SessionSurfacePhase {
  const anchor = root.querySelector(SESSION_SCROLL_ANCHOR)
  const node = anchor === null ? null : anchor.closest(`[${SESSION_PHASE_ATTRIBUTE}]`)
  if (node === null) return 'absent'
  const raw = node.getAttribute(SESSION_PHASE_ATTRIBUTE)
  if (raw === 'active' || raw === 'settling' || raw === 'hero') return raw
  return 'unknown'
}
