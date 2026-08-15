/**
 * InstanceView — one dsh shell per instance (design 05 §1: N-ctx).
 * The container div hosts a full AppWebEntry (independent cordis ctx + full
 * ui-* tree, connected to this instance through the /api/i/<id> proxy via the
 * base-path parameterized connection client). Boots are serialized through
 * shell.ts (window.__DSH_BASE_PATH__ discipline); once booted the shell stays
 * mounted and switching is pure CSS hide/show.
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
  active: boolean
  /** 服务器显示名（骨架屏文案）。 */
  label: string
  /** boot settle 回调（成功或失败均触发）：App 用于预热队列推进。 */
  onSettled?: (instanceId: string) => void
}

export default function InstanceView({ instanceId, basePath, active, label, onSettled }: InstanceViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const startedRef = useRef(false)
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
    void bootInstanceShell(instanceId, basePath, el, setShell).then((next) => {
      // settle 落地：可见视图用 View Transition（骨架 → 内容/失败报告）；
      // 后台 boot（预热）即时落位——用户点击切换时的过渡由 App 层覆盖。
      if (activeRef.current) runViewTransition(() => setShell(next))
      else setShell(next)
      onSettled?.(instanceId)
    })
  }, [instanceId, basePath, shell, onSettled])

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
      {shell.error !== null && (
        <div className="instance-fatal" role="alert">
          <div className="fatal-title">实例启动失败</div>
          <div className="fatal-message">{shell.error}</div>
          <button
            className="btn"
            onClick={() => {
              startedRef.current = false
              setShell(shellStateIdle(instanceId, basePath))
            }}
          >
            重试
          </button>
        </div>
      )}
    </div>
  )
}
