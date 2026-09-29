/**
 * hover-motion-gate 的 React 接线：每次提交后 scan，卸载时摘监听。
 * 与纯机器分成两个文件，是为了让 hover-motion-gate.ts 保持零 React 依赖、可被 plain-node
 * 行为测直接 import（本包测试无 DOM/React 环境）。scan 必须在 layout 阶段跑：它依赖
 * `matches(':hover')` 仍是**位移前**状态来区分"被搬进指针下"与"指针本来就停在这行上"。
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { createHoverMotionGate, type HoverMotionGate } from './hover-motion-gate.ts'

export function useHoverMotionGate(ref: RefObject<Element | null>): void {
  const gateRef = useRef<HoverMotionGate | null>(null)
  if (gateRef.current === null) gateRef.current = createHoverMotionGate()
  const gate = gateRef.current
  useEffect(() => () => { gate.dispose() }, [gate])
  useLayoutEffect(() => { gate.scan(ref.current) })
}
