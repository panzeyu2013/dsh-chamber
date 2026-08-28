/**
 * InstanceView — one dsh shell per instance (design 05 §1: N-ctx).
 * The container div hosts a full AppWebEntry (independent cordis ctx + full
 * ui-* tree, connected to this instance through the /api/i/<id> proxy via the
 * base-path parameterized connection client). shell.ts installs immutable
 * instance facts into each entry Context; once booted the shell stays mounted
 * and switching is pure CSS hide/show.
 *
 * Switching is driven by the App layer wrapping the active-view change in a
 * View Transition (view-transition.ts): the previous view is captured as a
 * static snapshot that stays on screen until the incoming view is actually
 * painted — no black frame ever, including the incremental re-layout a hidden
 * shell pays on reveal when its content kept streaming while hidden (the
 * content-visibility render cache was invalidated by those DOM changes).
 *
 * This component owns the per-view loading state: a layout-mimicking skeleton
 * (`.instance-loading`, design 05 §4 — NN/g skeleton pattern) shown while the
 * shell boots. The skeleton covers the dsh in-shell boot page (z-index above
 * the shell), so no opacity tricks are needed. When the boot settles, the
 * settle state is applied through a second View Transition (skeleton → real
 * UI, or the failure report + retry). Background-booted views (idle prewarm,
 * or a view the user left mid-boot) use `.instance-pending`: visibility-only
 * hidden, layout kept alive so the vendor shells' measurement /
 * IntersectionObserver machinery works during boot.
 */
import { useEffect, useRef, useState } from 'react'
import { bootInstanceShell, shellStateIdle, type ShellState } from '../shell.ts'
import { runViewTransition } from '../view-transition.ts'

export interface InstanceViewProps {
  instanceId: string
  basePath: string
  /** Immutable non-secret transport identity bound to this exact boot ctx. */
  sourceFingerprint: string
  active: boolean
  /** 服务器显示名（骨架屏文案）。 */
  label: string
  /** boot settle 回调（成功或失败均触发）：App 用于预热队列推进。 */
  onSettled?: (instanceId: string) => void
  /**
   * Shell 状态上报（chamber 2026-08，05 §4 失败呈现修订）：每次 settle 落
   * 地后把最终 ShellState 报给 App——失败呈现（失败报告 + 重试 + 服务器
   * 切换）由 App 在活动视图上统一渲染（覆盖层），InstanceView 自身不再
   * 画失败面板。非活动视图的失败在激活时才呈现。
   */
  onStateChange?: (instanceId: string, state: ShellState) => void
  /**
   * 重试令牌：App 的失败覆盖层「重试」按钮递增它；变化时本视图复位
   * boot 状态并重新启动 shell（先前的 entry 已由 shell.ts 在失败分支
   * dispose，重 boot 干净）。
   */
  retryToken?: number
}

export default function InstanceView({
  instanceId, basePath, sourceFingerprint, active, label, onSettled, onStateChange, retryToken,
}: InstanceViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const startedRef = useRef(false)
  // 卸载门控（2026-08 review 加固）：视图被回收（注册表删除）后，在途 boot
  // 的 settle 仍会经 .then 回调——若不经门控上报，陈旧终态（如取消 boot 的
  // "shell disposed"）会写进 App 的 shellStates，在 remove→re-add 窗口内对
  // 新挂载视图的骨架屏盖上一个虚假的"实例启动失败"覆盖层。卸载即丢弃。
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])
  // settle 时读取最新可见性（boot 期间视图可能被点击激活——避免用闭包里的旧值）。
  const activeRef = useRef(active)
  activeRef.current = active
  const [shell, setShell] = useState<ShellState>(() => shellStateIdle(instanceId, basePath))

  useEffect(() => {
    if (startedRef.current || shell.booted || shell.booting) return
    const el = containerRef.current
    // 先取容器再置位：ref 挂载前（理论上首帧不可能，防御）不置 started，
    // 否则容器一旦为 null，本视图永远不再尝试 boot。
    if (el === null) return
    startedRef.current = true
    void bootInstanceShell(instanceId, basePath, el, setShell, sourceFingerprint).then((next) => {
      // 卸载后到达的 settle 一律丢弃（视图已回收，App 已清理该视图状态；
      // 陈旧上报会污染重加视图的失败覆盖层判定）。
      if (!aliveRef.current) return
      // settle 落地：可见视图用 View Transition（骨架 → 内容/失败报告）；
      // 后台 boot（预热）即时落位——用户点击切换时的过渡由 App 层覆盖。
      if (activeRef.current) runViewTransition(() => setShell(next))
      else setShell(next)
      onSettled?.(instanceId)
      // 失败呈现由 App 统一负责（覆盖层）：每次 settle 上报最终状态。
      onStateChange?.(instanceId, next)
    })
  }, [instanceId, basePath, sourceFingerprint, shell, onSettled, onStateChange])

  // 重试令牌：App 失败覆盖层的「重试」→ 递增令牌 → 复位 boot 状态，boot
  // effect 观察 shell 变化重新启动。
  const lastRetryTokenRef = useRef(retryToken)
  useEffect(() => {
    if (retryToken === lastRetryTokenRef.current) return
    lastRetryTokenRef.current = retryToken
    startedRef.current = false
    const next = shellStateIdle(instanceId, basePath)
    setShell(next)
    onStateChange?.(instanceId, next)
  }, [retryToken, instanceId, basePath, onStateChange])

  const settled = shell.booted || shell.error !== null
  const viewClass = active
    ? 'instance-view'
    : settled
      ? 'instance-view instance-hidden'
      : 'instance-view instance-pending'

  return (
    <div className={viewClass} data-instance={instanceId}>
      <div ref={containerRef} className="instance-shell" />
      {!settled && (
        <div className="instance-loading" aria-busy="true">
          <div className="instance-loading-frame">
            <div className="instance-loading-rail">
              <div className="instance-loading-block" />
              <div className="instance-loading-block" />
              <div className="instance-loading-block" />
              <div className="instance-loading-block" />
            </div>
            <div className="instance-loading-sidebar">
              <div className="instance-loading-block" />
              <div className="instance-loading-block" />
              <div className="instance-loading-block" />
              <div className="instance-loading-block" />
            </div>
            <div className="instance-loading-main">
              <div className="instance-loading-spinner" />
              <div className="instance-loading-title">正在加载 {label}…</div>
              <div className="instance-loading-hint">首次打开需加载完整界面</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
