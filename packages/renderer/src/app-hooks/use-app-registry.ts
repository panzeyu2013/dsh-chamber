/**
 * App registry projection: the transport registry store (remotes), the roster gate, the
 * two degradation bits (F13 registry-degraded / V5-A roster-incomplete), the
 * health-unavailable warning latch and the F11 bridge-shape verdict.
 *
 * Extracted verbatim from App.tsx: the hook order inside the cluster and every state
 * initialiser are unchanged, so identity and subscription timing stay exactly as before.
 */
import { useRef, useState, useSyncExternalStore } from 'react'
import { createRemotesStore } from '../host/remotes-store.ts'
import { createRosterGate } from '../host/roster-gate.ts'
import type { DesktopBridgeVerdict } from './use-bridge-subscriptions.ts'

export function useAppRegistry() {  // 注册表投影（实例表 + 每 raw id 隧道相位）为单一 store：事件回调经
  // getSnapshot() 读最新值，渲染与回调不再各持一份（host/remotes-store.ts）。
  const [remotesStore] = useState(createRemotesStore)
  const remotes = useSyncExternalStore(remotesStore.subscribe, remotesStore.getSnapshot, remotesStore.getSnapshot)
  const remoteInstances = remotes.instances
  // 注册表闸门（单一权威）：generation/settledGeneration/listenerReady 都在
  // host/roster-gate.ts，渲染值与事件回调同步读同一份快照（无 state/ref 镜像）。
  const [rosterGate] = useState(createRosterGate)
  const roster = useSyncExternalStore(rosterGate.subscribe, rosterGate.getSnapshot, rosterGate.getSnapshot)
  /**
   * 注册表加载降级（F13）：持久化注册表加载失败（损坏文件保留为 *.corrupt 后空启动；或 live
   * 缺失而 .corrupt 副本仍在）时，instances_get 的空/缺行 roster 不是权威。本 state 置 true 使
   * durable 剪枝门保持关闭（「有桥但未结算」），直到健康探针恢复后才允许正常结算；告警按 reason
   * 去重（30s 轮询不得刷屏）。
   */
  const [registryDegraded, setRegistryDegraded] = useState(false)
  const registryDegradedWarnedRef = useRef<string | null>(null)
  /**
   * roster 行级丢弃（V5-A）：loadInstances() 解析成功但丢弃了条目（provider validateSpec 拒绝／
   * 重复 id）时，磁盘有内容而 roster 只是子集——合法行仍安装并结算（连接不能不可见），但 durable
   * 剪枝门由本位置 true 关死（与 degraded 同档，诊断区分）；恢复完整后健康探针把本位置回 false。
   */
  const [rosterIncomplete, setRosterIncomplete] = useState(false)
  const rosterIncompleteWarnedRef = useRef<string | null>(null)
  /** F16/A4：健康探针不可用（旧桥缺方法 / invoke 抛错）的告警文案只喊一次。 */
  const healthUnavailableWarnedRef = useRef<string | null>(null)
  /**
   * 桥面形态判定（F11 无桥形态剪枝门）：'pending' 探测中 / 'present' desktopSsh 已 expose /
   * 'absent' 探测预算耗尽仍无桥。无桥形态没有远程来源，live={local} 即完整权威集合，durable
   * 四类剪枝可按它收敛；'pending' 与 'present' 都保持「等权威 roster 结算」。翻转那一拍使剪枝
   * effect 重跑完成收敛。由 app-hooks/use-ssh-bridge-probe.ts 的探测 effect 维护。
   */
  const [bridgeVerdict, setBridgeVerdict] = useState<DesktopBridgeVerdict>('pending')
  return {
    remotesStore, remotes, remoteInstances, rosterGate, roster,
    registryDegraded, setRegistryDegraded, registryDegradedWarnedRef,
    rosterIncomplete, setRosterIncomplete, rosterIncompleteWarnedRef,
    healthUnavailableWarnedRef, bridgeVerdict, setBridgeVerdict,
  }
}
