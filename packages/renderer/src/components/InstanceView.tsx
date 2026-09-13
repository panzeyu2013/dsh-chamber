/**
 * InstanceView — one dsh shell per instance (design 05 §1: N-ctx).
 * The container div hosts a full AppWebEntry (independent cordis ctx + full
 * ui-* tree, connected to this instance through the /api/i/<id> proxy via the
 * base-path parameterized connection client). shell.ts installs immutable
 * instance facts into each entry Context; once booted the shell stays mounted
 * and switching is pure CSS hide/show.
 *
 * 保留策略（2026 性能整改，05 §1/§4 偏差）：App 层不再让隐藏壳无限常驻——
 * 超限的隐藏壳由 App 先 disposeInstanceShell 再从 mountedViews 移除，本组件
 * 随之卸载（回收语义与注册表删除一致，aliveRef 的卸载丢弃逻辑同时覆盖两种
 * 回收路径）；重开 = 重新挂载 + 冷 boot + entry 重放。本组件自身从不
 * dispose shell——卸载只发生在 App 已处置之后。
 *
 * Switching is driven by the App layer wrapping the active-view change in a
 * View Transition (view-transition.ts): the previous view is captured as a
 * static snapshot that stays on screen until the incoming view is actually
 * painted — no black frame ever, including the incremental re-layout a hidden
 * shell pays on reveal when its content kept streaming while hidden (the
 * content-visibility render cache was invalidated by those DOM changes).
 *
 * This component owns the per-view loading state: a full-area same-tone veil
 * (`.instance-loading`, design 05 §4) shown while the shell boots. Perf T1
 * (2026-09, D1=A) dropped the layout-mimicking skeleton blocks (rail + sidebar
 * placeholders): the real sidebar width is layout-store persisted and
 * user-draggable, so a fixed 280px mock geometry mismatched widened instances
 * and could shift the main-area left edge on settle reveal (CLS on the
 * reduced-motion/degraded paths). The veil makes no geometric claim. It covers
 * the dsh in-shell boot page (z-index above the shell), so no opacity tricks
 * are needed. When the boot settles, the settle state is applied through a
 * second View Transition (veil → real UI, or the failure report + retry).
 * Background-booted views (idle prewarm, or a view the user left mid-boot)
 * use `.instance-pending`: visibility-only hidden, layout kept alive so the
 * vendor shells' measurement / IntersectionObserver machinery works during
 * boot.
 */
import { useEffect, useRef, useState } from 'react'
import { bootInstanceShell, shellStateIdle, type ChamberTransport, type ShellState } from '../shell.ts'
import { runViewTransition } from '../view-transition.ts'
import { frameText, type FrameLocale } from '../locales.ts'

export interface InstanceViewProps {
  instanceId: string
  basePath: string
  /** Immutable non-secret transport identity bound to this exact boot ctx. */
  sourceFingerprint: string
  /** Immutable transport mechanism for open-in and other per-entry capability gates. */
  transport: ChamberTransport
  active: boolean
  /** 服务器显示名（骨架屏文案）。 */
  label: string
  /**
   * 框架文案语言（T16 2026-09-11 upstream-alignment）：框架没有 `t` 席位，
   * App 用 locales.ts 的 typed 字典按文档语言解析后传入（本组件只渲染，
   * 不自己读文档语言，保证同一帧内所有 chamber chrome 用同一语言）。
   */
  locale: FrameLocale
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
  /**
   * 来源就绪门（2026-09-10）：交给实例 shell 的取图重试——实例仍在启动时
   * （冷启动 / 重启跨越窗口）先等它就绪再取客户端插件图，而不是在固定预算用尽后
   * 静默少一片插件（`ui-chat` 会因此永久 PENDING、对话视图不注册）。
   */
  waitForServing?: (instanceId: string) => Promise<boolean>
  /**
   * 打开意图揭示门（2026-12，design 05 §2.2 修订；真机问题 1）：由 App 用共享纯规则
   * `shouldHoldViewVeil` 判定后传入的**最终判定**——遮罩在干净 settle 之后继续保留，
   * 直到该壳显示的会话就是要打开的那个为止（规则与两个输入都在 App：壳状态镜像 +
   * 原始 runtime current；本组件只负责合成 `!settled || holdVeil`）。冷 boot 期间官方
   * 初始导航策略会新建并打开一个 blank 会话，而排队中的 open 要等
   * session-controller 子 fiber + 一次 400ms 重试才分发；壳失败时 App 永远传 false
   * （失败呈现归 App 覆盖层所有），因此遮罩不会挂住。
   */
  holdVeil?: boolean
}

export default function InstanceView({
  instanceId, basePath, sourceFingerprint, transport, active, label, locale, onSettled, onStateChange,
  retryToken, waitForServing, holdVeil,
}: InstanceViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const startedRef = useRef(false)
  /** 每次 boot 尝试的令牌：丢弃被重试取代的迟到 settle。 */
  const bootTokenRef = useRef(0)
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
    // 本次尝试的令牌（2026-12 复查 MINOR）：重试后旧 boot 若迟到 settle，
    // 不得覆盖新尝试已经落地的健康状态。
    const bootToken = bootTokenRef.current + 1
    bootTokenRef.current = bootToken
    void bootInstanceShell(instanceId, basePath, el, setShell, sourceFingerprint, transport, {
      waitForServing,
      // 结算后补发的事实（5s 探针判词、延迟簇失败）必须到达 **App**（2026-12
      // BLOCKER 修复）：shell 的 onState 形参是本视图的 React setter，只发它
      // 就只重渲染本视图（settled 已为真，DOM 无变化），App 的 shellStates 镜像
      // ——横幅、侧栏/连接页投射、每 ready 世代一次的自愈全都读它——永远收不到。
      // 因此单列一条 App 向的汇道，且只由这条**过栅栏的结算后路径**调用：boot
      // 自身的结算前发布（before、被取代/阻塞的失败）仍不进 App 镜像。
      onRepublish: onStateChange === undefined ? undefined : (id, next) => onStateChange(id, next),
    }).then((next) => {
      // 卸载后到达的 settle 一律丢弃（视图已回收，App 已清理该视图状态；
      // 陈旧上报会污染重加视图的失败覆盖层判定）；被更新的尝试取代的迟到
      // settle 同样丢弃。
      if (!aliveRef.current || bootToken !== bootTokenRef.current) return
      // settle 落地：可见视图用 View Transition（骨架 → 内容/失败报告）；
      // 后台 boot（预热）即时落位——用户点击切换时的过渡由 App 层覆盖。
      // 键 'settle'（perf T2）：与视图切换流跨键隔离——settle 若被同键吞并
      // 会导致骨架 veil 永驻；同视图连续 settle（重试链）单槽合并。
      if (activeRef.current) runViewTransition(() => setShell(next), 'settle')
      else setShell(next)
      onSettled?.(instanceId)
      // 失败呈现由 App 统一负责（覆盖层）：每次 settle 上报最终状态。
      onStateChange?.(instanceId, next)
    })
  }, [instanceId, basePath, sourceFingerprint, transport, shell, onSettled, onStateChange, waitForServing])

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
  // 2026-12（design 05 §2.2 修订）：遮罩 = boot 期（未 settle）**或** App 判定的
  // 打开意图揭示门。判定规则（含"壳已经显示请求的会话就不遮"与"壳失败不遮"）在
  // sidebar 包 shared/open-intent.ts 内单测覆盖；遮罩的生命周期由 open promise
  // 自身界定（dispatchOpen 8s 预算 + App 的 finally 释放），不会出现挂住的加载层。
  const veilVisible = !settled || holdVeil === true
  const viewClass = active
    ? 'instance-view'
    : settled
      ? 'instance-view instance-hidden'
      : 'instance-view instance-pending'

  return (
    <div className={viewClass} data-instance={instanceId}>
      {/* 每次重试换一个容器元素（2026-12 复查 MAJOR）：上一个尝试若挂死，
          它的 AppWebEntry 仍持有旧容器——复用同一个 div 会让第二次尝试把新的
          boot 页/React root 追加进已有 root 的容器里（shell.ts 头注的
          "一容器一 root" 不变量）。旧容器随 key 变更被 React 摘除，挂死尝试
          写进的是已脱离文档的节点。 */}
      <div key={retryToken ?? 0} ref={containerRef} className="instance-shell" />
      {veilVisible && (
        <div className="instance-loading" aria-busy="true">
          <div className="instance-loading-main">
            {/* a11y (2026-09-11 upstream-alignment nit): the spinner is pure
                decoration — the adjacent title already announces the state, so
                it must stay out of the accessibility tree
                (aria-busy on the veil carries the busy fact). */}
            <div className="instance-loading-spinner" aria-hidden="true" />
            <div className="instance-loading-title">{frameText(locale, 'boot.loading', { label })}</div>
            <div className="instance-loading-hint">{frameText(locale, 'boot.loadingHint')}</div>
          </div>
        </div>
      )}
    </div>
  )
}
