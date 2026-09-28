/**
 * 桌面桥探测（F11 + A6）。
 *
 * preload 经异步 info 往返后才 expose `window.dshChamber`，桥可能在挂载 effect 之后才出现——
 * 一次性订阅会静默丢失状态/注册表推送（退化为 30s 轮询自愈）。探测节奏：500ms 直到预算耗尽，
 * 之后降频到 30s 长尾而不是停止——真迟到的桥仍会被判 present，而 500ms 只留给 preload 的正常
 * bounded expose 窗口（2.5s = 5 × 500ms）。桥一旦出现就走原语义：置 ready/present，停探，
 * roster 门重新接权威拉取结算。
 *
 * 抽成 app-hook 是 App.tsx 行数棘轮的要求（只许减不许增）；`classifySshBridgeProbeAttempt`
 * 是纯函数，A6 的预算耗尽断言直接跑它，不再只锁源码文本。
 */
import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DesktopBridgeVerdict } from './use-bridge-subscriptions.ts'

/** 桥面探测节奏（与既有 `window.dshChamber` 500ms 探测一致）。 */
export const BRIDGE_PROBE_MS = 500
/** 无桥形态判定预算（F11）：2.5s = 5 × 500ms；超预算判 'absent'，durable 剪枝门才放行 live={local}。 */
export const BRIDGE_ABSENT_PROBE_LIMIT = 5
/** 预算耗尽后的长尾探测节奏（A6）：迟到桥仍会被判 present，但不再维持 500ms 永续轮询。 */
export const BRIDGE_SLOW_PROBE_MS = 30_000

/**
 * 一次桥探测的裁决：`attempts` 是本次（1-based）尝试序号，`bridgePresent` 是这次读到的桥事实。
 * `verdict` 为 null = 保持现判定；`nextDelayMs` 为 null = 停止探测（桥已出现）。
 */
export function classifySshBridgeProbeAttempt(
  attempts: number,
  bridgePresent: boolean,
): { readonly verdict: DesktopBridgeVerdict | null; readonly nextDelayMs: number | null } {
  if (bridgePresent) return { verdict: 'present', nextDelayMs: null }
  if (attempts >= BRIDGE_ABSENT_PROBE_LIMIT) {
    return { verdict: 'absent', nextDelayMs: BRIDGE_SLOW_PROBE_MS }
  }
  return { verdict: null, nextDelayMs: BRIDGE_PROBE_MS }
}

export interface SshBridgeProbeOptions {
  /** 桥已出现：探测 effect 保持 idle。 */
  readonly ready: boolean
  readonly setReady: Dispatch<SetStateAction<boolean>>
  readonly setVerdict: Dispatch<SetStateAction<DesktopBridgeVerdict>>
}

/** 桌面桥探测 effect：mount 起 500ms 一拍，预算耗尽后 30s 长尾；桥出现即置 ready/present 并停探。 */
export function useSshBridgeProbe({ ready, setReady, setVerdict }: SshBridgeProbeOptions): void {
  useEffect(() => {
    if (ready) return
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = (): void => {
      attempts += 1
      const step = classifySshBridgeProbeAttempt(
        attempts,
        window.dshChamber?.desktopSsh !== undefined,
      )
      if (step.verdict === 'present') {
        setReady(true)
        setVerdict('present')
      } else if (step.verdict === 'absent') {
        // 已见桥绝不回退到 'absent'（迟到的状态推送与探测乱序都不许降级判定）。
        setVerdict(prev => (prev === 'present' ? prev : 'absent'))
      }
      if (step.nextDelayMs === null) return
      timer = setTimeout(poll, step.nextDelayMs)
    }
    timer = setTimeout(poll, BRIDGE_PROBE_MS)
    return () => {
      if (timer !== null) clearTimeout(timer)
    }
  }, [ready, setReady, setVerdict])
}
