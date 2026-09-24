/**
 * App-frame copy.
 *
 * The FRAME around the mounted shells (App.tsx, InstanceView.tsx, the static
 * skeleton) hosts N ctxs and owns NO `t` seat, so its chrome copy needs this
 * ctx-free dictionary instead of inline literals. Same shape the client plugins
 * use (`zh` is the key-set source of truth, `en` is checked complete against it),
 * consumed by {@link frameText} (render time) and {@link readDocumentLocale}
 * (copy assembled outside a render).
 *
 * Locale choice: only `document.documentElement.lang` is observed, never
 * `navigator.language` — in the N-ctx document every mounted shell's locale
 * service writes it, so `page-language.ts` sanctions only the ON-SCREEN source's
 * SETTLED language and restores every other write. An absent/empty tag falls back
 * to the served markup's own default (`zh-CN`, index.html) rather than the OS
 * locale, so a cold, un-booted page always shows the served copy.
 */

/** Languages this frame carries copy for. */
export type FrameLocale = 'zh' | 'en'

/** Chinese dictionary — the key-set source of truth (dotted-domain keys). */
export const zh = {
  /** Retry affordance of every frame-level failure screen (boot, control plane, UI crash). */
  'action.retry': '重试',
  'action.switchServer': '切换到其他服务器：',
  /** Shell-level veil title; `{label}` is the source display name. */
  'boot.loading': '正在加载 {label}…',
  /** Shell-level veil hint under the title. */
  'boot.loadingHint': '首次打开需加载完整界面',
  /** Deferred-boot veil title: boot is held until the user connects the source. */
  'boot.deferred': '未连接 {label}',
  'boot.deferredHint': '该来源尚未连接。连接成功后再打开会话。',
  /** Elapsed wait shown once the veil becomes actionable; `{seconds}` is rounded. */
  'boot.elapsed': '已等待 {seconds} 秒',
  /** Actionable veil line while the boot is still running (never a failure claim). */
  'boot.stuckHint': '仍未完成：可以继续等待，或先离开这个来源。',
  /** Selected only when `isTerminalUnreadyPhase` is true (error / stopped /
   *  restart-exhausted): the copy must not blame the boot for a transport failure;
   *  a `degraded` source is reconnecting and gets `boot.stuckHint`. */
  'boot.sourceFailedHint': '该来源的连接已中断：可以先重试，或离开这个来源。',
  /** Honest retry-queue note: the new attempt waits for the still-running predecessor. */
  'boot.retryQueued': '这次重试排在上一次启动之后（最长约 {seconds} 秒）；若上一次已经结束，会立即开始。',
  'boot.reloadHint': '若界面长时间无响应，可按 ⌘R（Windows/Linux 为 Ctrl+R）重新加载。',
  /** Connect affordance of the deferred-boot veil (same semantics as the settings page). */
  'action.connect': '连接',
  /** Settled-boot gap notice: the source's interface is reachable, but part of its frontend never registered. */
  'bootGap.title': '该来源的前端能力受限',
  /** Gap body: the source never served its client plugin graph in the boot window. */
  'bootGap.body.graphUnavailable': '该来源在启动窗口内没有提供客户端插件图，本次挂载没有加载它的前端插件；依赖这些插件的界面（例如会话正文）不会出现。',
  /** Gap body: the local graph endpoint answered 404/method-missing — a chamber-side
   *  installation/seed problem, so the copy must NOT send the user to a runtime
   *  upgrade (read-only on Windows). */
  'bootGap.body.localGraphNotInjected': '本地实例没有注入客户端插件图（接口返回 404 或缺少该方法）。应用托管的本地 dsh 总会注入该图，因此这是安装/seed 产物不完整或未生效；本次挂载没有加载它的前端插件，依赖这些插件的界面（例如会话正文）不会出现。',
  /** Gap body: a service the page's own frontend injects was never provided. */
  'bootGap.body.requiredServicesMissing': '该来源没有提供本次页面所需的前端服务，等待这些服务的界面（例如会话正文）不会注册。',
  /** Gap body: a deferred frontend plugin family never registered this boot. */
  'bootGap.body.deferredRegistrationFailed': '本次挂载有前端插件家族没有注册成功，它们提供的界面与插槽在本次挂载里缺失。',
  'bootGap.services': '缺少的服务',
  'bootGap.injectedBy': '等待它们的插件',
  'bootGap.failedPlugins': '未注册的插件',
  /** Gap next-step line while the self-heal will still re-mount this mount. */
  'bootGap.action.autoRetry': '该来源就绪后会自动重挂一次；若重挂后仍然如此，需要在该来源上处理。',
  /** Remote branch. Deliberately says 常见原因 — the app cannot prove the cause —
   *  and asserts no COMPLETED re-mount (it also renders in the frame between arming
   *  the self-heal and the re-mount resetting state). */
  'bootGap.action.manual': '若仍然如此，需要在该来源上处理。常见原因：该来源的 dsh 运行时与本次页面所需的前端插件不匹配（版本较旧或缺少插件）——在该来源上升级或对齐 dsh 运行时。',
  /** Local branch: runtime management is read-only on Windows, so the honest actions
   *  are restart / re-mount / diagnostics — never a runtime upgrade. */
  'bootGap.action.manualLocal': '若仍然如此：先在 设置 → 连接 中重启本地 dsh，再重新挂载该来源；仍不恢复时，请在 设置 → 连接 中复制诊断信息反馈。本地实例的客户端插件图由应用自身注入，属于安装完整性问题。',
  /** Label of the raw producer diagnostic line shown under the gap copy. */
  'bootGap.detail': '诊断',
  /** Static first-frame skeleton hint (index.html; re-applied by main.tsx). */
  'boot.starting': '正在启动…',
  /** App-frame crash screen (ErrorBoundary) title. */
  'error.ui.title': '界面发生错误',
  /** Aggregate-error fallback when the control plane reports no message. */
  'error.unknown': '未知错误',
  /** Open-session failure the App throws itself: the source left the registry. */
  'open.failed.sourceGone': '打开会话失败：来源 {source} 已不在注册表',
  /** Open-session failure wrapping the underlying error text; `{detail}` is that text. */
  'open.failed.detail': '打开会话失败：{detail}',
  /** Replayed notification whose source was removed and rebuilt; the open is dropped. */
  'open.failed.sourceRebuilt': '来源 {source} 已被移除并以新代重建，旧通知未打开',
  /** Instance boot-failure overlay title. */
  'fatal.boot.title': '实例启动失败',
  /** Heading of the failed-plugin list (upstream's boot page: 'Failed to load plugins'). */
  'fatal.entries.title': '插件加载失败',
  /** Control-plane-unreachable overlay title. */
  'fatal.controlPlane.title': '无法连接控制面',
  /** Harvest-abandon boot timeout; `{seconds}` is the rounded abandon budget. */
  'fatal.harvestTimeout': '实例启动超时：挂载后 {seconds} 秒未收到任何响应（可重试或切换来源）',
  /** Display name fallback for the local source (a label the control plane may override). */
  'source.local': '本地实例',
  /** Session title fallback used by the notification body. */
  'session.untitled': '未命名会话',
  'notification.sessionComplete': '会话已完成',
  'notification.awaitingAnswer': '代理正在等待你的回答',
  'notification.awaitingApproval': '代理请求你的批准',
  /** L3 liveness guard. The copy must only say「无法确认」: legal silence (long tool/
   *  推理) and a real stall are indistinguishable here. */
  'sessionStall.text': '无法确认 {sources} 的会话状态：连接可能已停滞。',
  /** L3 source-list separator: CJK enumeration comma (en uses ', '). */
  'sessionStall.separator': '、',
  /** L3 recovery actions; dismiss hides this continuous stall only (re-armed when it breaks). */
  'sessionStall.reconnect': '重新连接',
  'sessionStall.reload': '重新加载应用页面',
  'sessionStall.dismiss': '忽略',
} satisfies Record<string, string>

/** The frame key union (dictionary keys, typed). */
export type FrameKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en: Record<FrameKey, string> = {
  'action.retry': 'Retry',
  'action.switchServer': 'Switch to another server:',
  'boot.loading': 'Loading {label}…',
  'boot.loadingHint': 'The full interface loads on first open',
  'boot.deferred': '{label} is not connected',
  'boot.deferredHint': 'This source is not connected yet. Connect it, then open the session again.',
  'boot.elapsed': 'Waiting {seconds}s',
  'boot.stuckHint': 'Still not ready: you can keep waiting, or leave this source for now.',
  'boot.sourceFailedHint': 'This source’s connection dropped: retry, or leave this source for now.',
  'boot.retryQueued': 'This retry waits behind the previous attempt (up to about {seconds}s); it starts at once if that attempt has already ended.',
  'boot.reloadHint': 'If the interface stays unresponsive, press ⌘R (Ctrl+R on Windows/Linux) to reload.',
  'action.connect': 'Connect',
  'bootGap.title': 'This source’s interface is limited',
  'bootGap.body.graphUnavailable': 'This source did not serve its client plugin graph inside the boot window, so this mount loaded none of its frontend plugins; the surfaces that depend on them (the conversation body, for example) will not appear.',
  'bootGap.body.localGraphNotInjected': 'This local instance did not inject its client plugin graph (the endpoint answered 404 or has no such method). The app-managed local dsh always injects that graph, so the installation/seed artifacts are incomplete or did not take effect; this mount loaded none of its frontend plugins, so the surfaces that depend on them (the conversation body, for example) will not appear.',
  'bootGap.body.requiredServicesMissing': 'This source did not provide a frontend service this page needs, so the surfaces waiting on it (the conversation body, for example) never register.',
  'bootGap.body.deferredRegistrationFailed': 'A frontend plugin family failed to register in this mount, so the surfaces and slots it provides are missing here.',
  'bootGap.services': 'Missing services',
  'bootGap.injectedBy': 'Plugins waiting on them',
  'bootGap.failedPlugins': 'Plugins that did not register',
  'bootGap.action.autoRetry': 'It will be re-mounted once automatically when the source becomes ready; if the gap survives that, it has to be handled on that source.',
  'bootGap.action.manual': 'If the gap persists, it has to be handled on that source. Common cause: that source’s dsh runtime does not match the frontend plugins this page needs (older version, or plugins missing) — upgrade or align the dsh runtime there.',
  'bootGap.action.manualLocal': 'If the gap persists: restart the local dsh in Settings → Connections, then re-mount this source; if it still does not recover, copy the diagnostics from Settings → Connections and report them. The local client plugin graph is injected by the app itself, so this is an installation-integrity problem.',
  'bootGap.detail': 'Diagnostic',
  'boot.starting': 'Starting…',
  'error.ui.title': 'Interface error',
  'error.unknown': 'Unknown error',
  'open.failed.sourceGone': 'Failed to open the session: source {source} is no longer registered',
  'open.failed.detail': 'Failed to open the session: {detail}',
  'open.failed.sourceRebuilt': 'Source {source} was removed and rebuilt as a new generation; the stale notification was not opened',
  'fatal.boot.title': 'Instance failed to start',
  'fatal.entries.title': 'Failed to load plugins',
  'fatal.controlPlane.title': 'Cannot reach the control plane',
  'fatal.harvestTimeout': 'Instance boot timed out: no response within {seconds}s of mounting (retry or switch source)',
  'source.local': 'Local instance',
  'session.untitled': 'Untitled session',
  'notification.sessionComplete': 'Session complete',
  'notification.awaitingAnswer': 'The agent is waiting for your answer',
  'notification.awaitingApproval': 'The agent requests your approval',
  'sessionStall.text': 'Cannot confirm the session state of {sources}: the connection may be stalled.',
  'sessionStall.separator': ', ',
  'sessionStall.reconnect': 'Reconnect',
  'sessionStall.reload': 'Reload the app page',
  'sessionStall.dismiss': 'Dismiss',
}

/** Every dictionary keyed by locale (the frame's `t` seat). */
export const FRAME_DICTIONARIES: Record<FrameLocale, Record<FrameKey, string>> = { zh, en }

/** The document attribute the official locale service writes. */
export const DOCUMENT_LANGUAGE_ATTRIBUTE = 'lang'

/** Fallback locale: the served markup's own default (index.html lang="zh-CN"). */
export const FALLBACK_FRAME_LOCALE: FrameLocale = 'zh'

/**
 * Resolve the frame locale from a document language tag: a `zh`-family tag is
 * Chinese, every other known tag is English; absent/empty falls back to the SERVED
 * MARKUP default rather than the OS locale.
 */
export function resolveFrameLocale(lang: string | undefined | null): FrameLocale {
  if (lang === undefined || lang === null) return FALLBACK_FRAME_LOCALE
  const tag = lang.trim().toLowerCase()
  if (tag === '') return FALLBACK_FRAME_LOCALE
  if (tag === 'zh' || tag.startsWith('zh-') || tag.startsWith('zh_')) return 'zh'
  return 'en'
}

/** The document's current frame locale, read on demand; the fallback in a doctored/DOM-less environment. */
export function readDocumentLocale(): FrameLocale {
  if (typeof document === 'undefined') return FALLBACK_FRAME_LOCALE
  try {
    return resolveFrameLocale(document.documentElement?.getAttribute(DOCUMENT_LANGUAGE_ATTRIBUTE))
  } catch {
    // A hostile/absent documentElement must never fail a render.
    return FALLBACK_FRAME_LOCALE
  }
}

/**
 * Subscribe to document-language changes; framework-free so React can bind it through
 * `useSyncExternalStore` and plain-node imports stay usable. Returns the unsubscribe.
 */
export function subscribeDocumentLocale(onChange: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver(() => { onChange() })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [DOCUMENT_LANGUAGE_ATTRIBUTE],
  })
  return () => { observer.disconnect() }
}

/** Render one dictionary entry, substituting `{name}` placeholders (unmatched stay verbatim). */
export function frameText(
  locale: FrameLocale,
  key: FrameKey,
  params?: Readonly<Record<string, string>>,
): string {
  const template = FRAME_DICTIONARIES[locale][key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match)
}
