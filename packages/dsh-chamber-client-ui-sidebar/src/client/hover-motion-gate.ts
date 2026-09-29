/**
 * 行位移动效期间的"指针并未移动"门控（design 06 §7）。
 *
 * WHY：一次提交把某 keyed 行搬到静止指针下时，浏览器会为该行合成 boundary 事件——
 * 本机 headless Chromium 149 实测：提交后 t≈347ms 收到 pointerover/pointerenter/
 * mouseover/mouseenter（clientX/Y 与按下时相同，同期 0 个 pointermove），随后 :hover 也
 * 命中它。于是三条"指针进入"路径在用户并未指向该行时被触发：① :hover 揭示树（行洗色 +
 * 文件夹→chevron + 计数徽标换 +/kebab + git 占位者换入）——即"删除会话时对应的 workspace
 * 闪一下"；② RowHoverCard 的 onPointerEnter → 800ms 停留后卡片自己弹开；③ 会话标题跑马灯
 * onPointerEnter → 标题自己开始爬行。本模块只回答一件事：这次进入是不是"行自己滑过来"的。
 *
 * 判定纪律：scan 在提交后的 layout 阶段同步执行（早于本帧的 hover 更新），因此
 * `matches(':hover')` 仍是**位移前**的真相——位移前就在指针下的行保留揭示，只有被搬进
 * 指针下的行才门控；用户真实悬停不会掉。门控在下一个真实 pointermove（坐标变化）或
 * pointerdown 时摘除，并对仍在指针下的行补一次 pointerover，让 React 的 onPointerEnter
 * 重新求值（pointerenter/leave 不冒泡，React 由 pointerover/out 合成 enter/leave）。
 *
 * 本模块零 React 依赖：纯判定与门控机器留在可被 plain-node 行为测直接 import 的模块里，
 * hook 在兄弟文件 use-hover-motion-gate.ts（本包测试无 DOM/React 环境，见
 * row-render-cost.test.ts 头注）。
 */
export const HOVER_GATE_ATTR = 'data-hover-gate'

/** 属性形式的样式钩子（CSS Modules 不哈希属性选择器）——选择器只此一处构造。 */
export const HOVER_GATE_SELECTOR = `[${HOVER_GATE_ATTR}]`

/**
 * 纯判定：本提交被位移、且位移前不处于 hover 的行要门控。
 * @param moved - 本提交是否把该行搬到新位置（由 layout 阶段仍带 transform 的 keyed 行动画判定）。
 * @param hoveredBefore - scan 时刻该行是否已处于 :hover（layout 阶段读到的仍是位移前状态）。
 */
export function needsHoverGate(moved: boolean, hoveredBefore: boolean): boolean {
  return moved && !hoveredBefore
}

export interface HoverMotionGate {
  /** 每次提交后的 layout effect 调用；root 为该节段（section）根。 */
  scan(root: Element | null): void
  /** 卸载：摘监听并清掉遗留门控属性。 */
  dispose(): void
}

/** 每个来源 section 一台机器（hook 挂在 ServerSection 上，各自只扫自己的子树）：N 个来源 =
 * N 台机器、2N 个 document 监听，每次提交各做一次子树 `getAnimations` 扫描。 */
export function createHoverMotionGate(): HoverMotionGate {
  const gated = new Set<HTMLElement>()
  let lastX = Number.NaN
  let lastY = Number.NaN

  const release = (): void => {
    if (gated.size === 0) return
    for (const row of gated) {
      row.removeAttribute(HOVER_GATE_ATTR)
      // 指针此刻就在这行上、只是从未移动过：补一次 over，让 React 的 onPointerEnter
      // 重新求值——否则该行要到指针离开再进入才会 arm 卡片与跑马灯。这次合成 over 会冒泡到
      // 侧栏壳列的 onPointerEnter（SidebarRoot 的 cancelLinger/setPointerInside）：指针确实
      // 还在侧栏内，语义一致，只是本机制唯一的跨组件副作用，记此备查。
      if (row.matches(':hover')) {
        row.dispatchEvent(new PointerEvent('pointerover', {
          bubbles: true, composed: true, relatedTarget: null,
        }))
      }
    }
    gated.clear()
  }

  const onPointer = (event: PointerEvent): void => {
    // 只认"真的动了"：pointermove 坐标不变（合成或重复帧）不解除门控。
    if (event.type === 'pointermove' && event.clientX === lastX && event.clientY === lastY) return
    lastX = event.clientX
    lastY = event.clientY
    release()
  }

  document.addEventListener('pointermove', onPointer, { capture: true, passive: true })
  document.addEventListener('pointerdown', onPointer, { capture: true, passive: true })

  return {
    scan(root) {
      if (!(root instanceof HTMLElement)) return
      // 只有 keyed 行会被 FLIP 位移；退出克隆体没有 data-row-key，天然排除；行内常驻控件的
      // CSS 过渡/转圈也不是 keyed 行，一并排除。
      for (const animation of root.getAnimations({ subtree: true })) {
        const effect = animation.effect
        const target = effect instanceof KeyframeEffect ? effect.target : null
        if (!(target instanceof HTMLElement)) continue
        if (target.dataset.rowKey === undefined) continue
        if (!needsHoverGate(true, target.matches(':hover'))) continue
        target.setAttribute(HOVER_GATE_ATTR, '')
        gated.add(target)
      }
    },
    dispose() {
      release()
      document.removeEventListener('pointermove', onPointer, { capture: true })
      document.removeEventListener('pointerdown', onPointer, { capture: true })
    },
  }
}
