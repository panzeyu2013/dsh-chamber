/**
 * 「调试模式」行的呈现决策（纯函数，零 React）：可见性、禁用门与状态行分类都从这里出，
 * 组件只做「分类 → 文案 + className」的映射。抽出来的理由与 update-gate.ts /
 * blocked-reason.ts 同款——真值表可以真测，源码断言只留结构锚（不 pin 变量名）。
 */

/** 宿主实测回读的形状子集（settings 投影的 `debugRuntime`）。 */
export interface DebugRuntimeLike {
  inspectable: boolean
  reason?: string
}

/** 状态行分类：
 *  - `unknown`：本进程尚未应用过（`runtime` 缺省）——**不按 enabled 推断**；
 *  - `on`：宿主实测处于可检查态；
 *  - `error`：用户想开、但实测没开（带宿主原因原文）；
 *  - `off`：用户本就关着且回读也是关——正常状态，不渲染事实卡。 */
export type DebugStatusKind = 'unknown' | 'on' | 'off' | 'error'

export function debugStatusKind(runtime: DebugRuntimeLike | undefined, enabled: boolean): DebugStatusKind {
  if (runtime === undefined) return 'unknown'
  if (runtime.inspectable === true) return 'on'
  return enabled ? 'error' : 'off'
}

/** 事实卡是否**值得呈现**（组件再叠加 supported 门）：想开着（意图）｜宿主实测
 *  **还**开着（撤销未被确认，绝不能因为设置说关就藏起来）｜这次保存报错。 */
export function debugFactsCardVisible(input: {
  supported: boolean
  enabled: boolean
  inspectable: boolean
  saveError: boolean
}): boolean {
  return input.supported && (input.enabled || input.inspectable || input.saveError)
}

/** 事实卡内谁出现（纯映射，组件只做 t(statusKey) 与描边）：状态行键 + 两段「开启」
 *  说明是否需要。三处「不要」都有真实场景：
 *  - `off`（用户本就关着且回读也是关）：无可说，渲染状态行 = 报假错；
 *  - `saving`：宿主回读是跨进程 await，在飞期间展示的是**上一次**结果，暂缓；
 *  - `off` 时也不渲染 Safari/信任边界两段：那次保存在失败回滚后开关是关的，讲「开启」
 *    的注意事项会误导。 */
export interface DebugFactsCard {
  /** 状态行文案键；null = 不渲染状态行。 */
  statusKey: 'debugModeStatusOn' | 'debugModeStatusError' | 'debugModeStatusUnknown' | null
  /** 是否渲染「Safari 如何附着」与「信任边界」两段。 */
  showEnableHints: boolean
  /** 失败原因原文（宿主/系统文案不翻译）。 */
  reason?: string
}

export function debugFactsCard(input: {
  kind: DebugStatusKind
  saving: boolean
  reason?: string
}): DebugFactsCard {
  if (input.kind === 'off') return { statusKey: null, showEnableHints: false }
  if (input.saving) return { statusKey: null, showEnableHints: true }
  const statusKey = input.kind === 'on'
    ? 'debugModeStatusOn'
    : input.kind === 'error' ? 'debugModeStatusError' : 'debugModeStatusUnknown'
  return {
    statusKey,
    showEnableHints: true,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  }
}

/** 开关禁用门：未水合、当前壳不支持、或一次保存在飞。
 *  在飞门是必需的——宿主回读是**跨进程 await**，两次快速点击的落盘/推送顺序不保证
 *  与点击顺序一致（末次点击可能不生效），所以一次只允许一个意图在途。 */
export function debugToggleDisabled(input: {
  hydrated: boolean
  supported: boolean
  saving: boolean
}): boolean {
  return !input.hydrated || !input.supported || input.saving
}

/** 能力门：缺字段 = 早于该门的主进程 → 按「不支持」读（禁用 + 原因），绝不呈现一个
 *  可能无效的开关。与 `badgeSupported` 的「缺失 = 支持」是非对称的，且这是有意的。 */
export function debugSupported(supported: { debugInspectable?: boolean } | undefined): boolean {
  return supported?.debugInspectable === true
}
