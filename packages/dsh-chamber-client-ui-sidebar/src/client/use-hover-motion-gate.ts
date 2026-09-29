/**
 * hover-motion-gate 的 React 接线：每次提交后 scan，卸载时摘监听并弃用机器。
 * 与纯机器分成两个文件，是为了让 hover-motion-gate.ts 保持零 React 依赖、可被 plain-node
 * 行为测直接 import（本包测试无 DOM/React 环境）。scan 必须在 layout 阶段跑：它依赖
 * `matches(':hover')` 仍是**位移前**状态来区分"被搬进指针下"与"指针本来就停在这行上"。
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { createHoverMotionGate, type HoverMotionGate } from './hover-motion-gate.ts'

export function useHoverMotionGate(ref: RefObject<Element | null>): void {
  const gateRef = useRef<HoverMotionGate | null>(null)
  // StrictMode（dev）会 setup→cleanup→setup：dispose 摘掉了 document 监听，所以必须同时把
  // ref 置空，让下一次 setup 换一台新机器——复用这台已 inert 的机器时，scan 加上的
  // `data-hover-gate` 再无人解除（揭示/悬停卡/跑马灯就此永久失效到刷新）。与 ServerSection
  // 的 prewarm-intent 同款纪律（锁句见 test/session-rows/prewarm-intent.test.ts）。
  useEffect(() => () => {
    gateRef.current?.dispose()
    gateRef.current = null
  }, [])
  useLayoutEffect(() => {
    // 首次挂载与 StrictMode 重挂载后都在这里取机器（渲染期不建：document 监听是副作用）。
    // scan 读的 `matches(':hover')` 此刻仍是位移前的真相。
    if (gateRef.current === null) gateRef.current = createHoverMotionGate()
    gateRef.current.scan(ref.current)
  })
}
