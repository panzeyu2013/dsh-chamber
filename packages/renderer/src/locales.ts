/**
 * App-frame copy.
 *
 * Upstream's rule for the client stack (`packages/client/AGENTS.md`, "Styling
 * and localization"): EVERY product-visible string — text, accessibility names,
 * tooltips, placeholders, status/unit formatters, primitive chrome — lives in a
 * typed locale dictionary and reaches the component through the standard `t`
 * seat or an already-localized prop. The chamber's own client plugins comply
 * (each owns `src/locales.ts`, registered through `ctx.locale.register`). The
 * FRAME around those shells (App.tsx, InstanceView.tsx, the static skeleton)
 * does not: it hosts N ctxs and owns NO `t` seat, so its chrome copy needs a
 * ctx-free dictionary instead of inline Chinese literals.
 *
 * This module is that dictionary: the same shape the client plugins use (`zh`
 * is the key-set source of truth, `en` is checked complete against it), consumed
 * by two ctx-free readers —
 *
 *  - {@link frameText} for render-time copy, keyed by the {@link FrameLocale}
 *    the module resolves for the reader;
 *  - {@link readDocumentLocale} for copy assembled OUTSIDE a render (the
 *    notification edge projection, whose effect holds no render-scope values).
 *
 * ## How the frame chooses the locale (it owns no `t` seat)
 *
 * The document language: `document.documentElement.lang`. The official locale
 * service writes it (`syncDocumentLanguage`, vendor
 * packages/client/locale/src/client/index.ts:149) — but in the chamber's N-ctx
 * document EVERY mounted shell's service writes it, at activation and on every
 * dictionary registration, so "the booted shell's locale" is not "the
 * shell that wrote last" (which could be a prewarmed one's browser-derived
 * provisional). The page-language
 * owner: `page-language.ts` sanctions only the ON-SCREEN source's SETTLED
 * language and restores every other write (design 06 §4.6「页面语言归属」), so
 * the document language the readers below observe IS the on-screen instance's
 * own language. This is the same mechanism, and the
 * same fallback pin, the chamber's settings-bridge already uses for ctx-free
 * copy (`DshRuntimeSection.tsx` `formatTimestamp`: "the served markup defaults
 * to zh-CN, so an unset lang falls back to zh-CN rather than the OS locale") —
 * the served markup's own default is `zh-CN` (index.html). Only the document is
 * observed, never `navigator.language`: the user's choice inside dsh is
 * authoritative, and an English document must produce English chrome.
 *
 * "An English document" only exists AFTER a
 * shell booted — on a COLD load the served markup declares `lang="zh-CN"`
 * (index.html:2) and no locale service has run yet, so every frame reader
 * resolves zh and the first copy the user sees is always the served one (which
 * is also what the static skeleton in index.html already carries, so the
 * pre-mount rewrite in main.tsx is a no-op on that path). The dictionary takes
 * over the moment the document language actually changes — the page-language
 * owner letting the on-screen source's settled language land (main.tsx installs
 * it before any shell boots), or a control-plane markup that declares another
 * language — which is exactly the subscription below.
 */

/** Languages this frame carries copy for. */
export type FrameLocale = 'zh' | 'en'

/**
 * Chinese dictionary — the key-set source of truth (client-plugin convention:
 * `satisfies Record<string, string>`, keys are dotted domains).
 */
export const zh = {
  /** Retry affordance of every frame-level failure screen (boot, control plane, UI crash). */
  'action.retry': '重试',
  /** Escape hatch of the boot-failure overlay: switch to another source. */
  'action.switchServer': '切换到其他服务器：',
  /** Shell-level veil title (design 05 §4); `{label}` is the source display name. */
  'boot.loading': '正在加载 {label}…',
  /** Shell-level veil hint under the title. */
  'boot.loadingHint': '首次打开需加载完整界面',
  /** Deferred-boot veil title: the source is manually disconnected, so the
   *  boot is held back until the user explicitly connects it. `{label}` = source name. */
  'boot.deferred': '未连接 {label}',
  /** Deferred-boot veil hint: what the user should do next. */
  'boot.deferredHint': '该来源尚未连接。连接成功后再打开会话。',
  /** Elapsed wait shown once the veil becomes actionable; `{seconds}` is rounded. */
  'boot.elapsed': '已等待 {seconds} 秒',
  /** Actionable veil line while the boot is still running (never a failure claim). */
  'boot.stuckHint': '仍未完成：可以继续等待，或先离开这个来源。',
  /** Actionable veil line when the source's own connection is already terminal:
   *  the copy must not blame the boot for a transport failure. Selected only when
   *  `isTerminalUnreadyPhase` is true (error / stopped / restart-exhausted); a
   *  `degraded` source is reconnecting and gets `boot.stuckHint` instead. */
  'boot.sourceFailedHint': '该来源的连接已中断：可以先重试，或离开这个来源。',
  /** Honest retry-queue note: the new attempt waits for the still-running
   *  predecessor (same-id boot tail, capped at two boot budgets). */
  'boot.retryQueued': '这次重试排在上一次启动之后（最长约 {seconds} 秒）；若上一次已经结束，会立即开始。',
  /** Last-resort hint: whole-document reload is always available in both shells. */
  'boot.reloadHint': '若界面长时间无响应，可按 ⌘R（Windows/Linux 为 Ctrl+R）重新加载。',
  /** Connect affordance of the deferred-boot veil (same semantics as the settings page). */
  'action.connect': '连接',
  /** Settled-boot gap notice title (design 05 §4 「降级呈现」): the source's own
   *  interface is reachable, but part of its frontend never registered. */
  'bootGap.title': '该来源的前端能力受限',
  /** Gap body: the source never served its client plugin graph inside the boot
   *  window, so this mount loaded none of its frontend plugins. */
  'bootGap.body.graphUnavailable': '该来源在启动窗口内没有提供客户端插件图，本次挂载没有加载它的前端插件；依赖这些插件的界面（例如会话正文）不会出现。',
  /** Gap body: the LOCAL instance's graph endpoint answered
   *  404/method-missing. The app-managed local host always injects its graph, so
   *  the cause is chamber-side (installation/seed integrity) — the copy must NOT
   *  send the user to a runtime upgrade (read-only on Windows). */
  'bootGap.body.localGraphNotInjected': '本地实例没有注入客户端插件图（接口返回 404 或缺少该方法）。应用托管的本地 dsh 总会注入该图，因此这是安装/seed 产物不完整或未生效；本次挂载没有加载它的前端插件，依赖这些插件的界面（例如会话正文）不会出现。',
  /** Gap body: the graph arrived, but a service the page's own frontend injects
   *  was never provided, so the fibers waiting on it never activated. */
  'bootGap.body.requiredServicesMissing': '该来源没有提供本次页面所需的前端服务，等待这些服务的界面（例如会话正文）不会注册。',
  /** Gap body: a deferred frontend plugin family never registered this boot. */
  'bootGap.body.deferredRegistrationFailed': '本次挂载有前端插件家族没有注册成功，它们提供的界面与插槽在本次挂载里缺失。',
  /** Label of the missing-service list in the gap notice (structured facts follow). */
  'bootGap.services': '缺少的服务',
  /** Label of the injector list in the gap notice. */
  'bootGap.injectedBy': '等待它们的插件',
  /** Label of the unregistered-plugin list in the gap notice. */
  'bootGap.failedPlugins': '未注册的插件',
  /** Gap next-step line while the self-heal will still re-mount this mount. */
  'bootGap.action.autoRetry': '该来源就绪后会自动重挂一次；若重挂后仍然如此，需要在该来源上处理。',
  /** Gap next-step line otherwise (REMOTE sources; the local branch is
   *  `bootGap.action.manualLocal`). Deliberately says 常见原因 — the app
   *  cannot prove the cause — and deliberately asserts no COMPLETED re-mount:
   *  this line is also what renders in the one frame between arming the
   *  self-heal and the re-mount resetting the state, where "已重挂过" would not
   *  be true yet. */
  'bootGap.action.manual': '若仍然如此，需要在该来源上处理。常见原因：该来源的 dsh 运行时与本次页面所需的前端插件不匹配（版本较旧或缺少插件）——在该来源上升级或对齐 dsh 运行时。',
  /** Gap next-step line for the LOCAL instance: runtime
   *  management there is a read-only projection on Windows, so the honest
   *  actions are restarting the local dsh, re-mounting the source and reporting
   *  diagnostics — never a runtime upgrade. */
  'bootGap.action.manualLocal': '若仍然如此：先在 设置 → 连接 中重启本地 dsh，再重新挂载该来源；仍不恢复时，请在 设置 → 连接 中复制诊断信息反馈。本地实例的客户端插件图由应用自身注入，属于安装完整性问题。',
  /** Label of the raw producer diagnostic line shown under the gap copy. */
  'bootGap.detail': '诊断',
  /** Static first-frame skeleton hint (index.html; re-applied by main.tsx). */
  'boot.starting': '正在启动…',
  /** App-frame crash screen (ErrorBoundary) title. */
  'error.ui.title': '界面发生错误',
  /** Aggregate-error fallback when the control plane reports a failure with no message
   *  (rendered verbatim by the sidebar's source alert). */
  'error.unknown': '未知错误',
  /** Open-session failure the App throws itself: the source left the registry. */
  'open.failed.sourceGone': '打开会话失败：来源 {source} 已不在注册表',
  /** Open-session failure wrapping the underlying error text; `{detail}` is that text. */
  'open.failed.detail': '打开会话失败：{detail}',
  /** Replayed notification whose source was removed and rebuilt; the open is dropped. */
  'open.failed.sourceRebuilt': '来源 {source} 已被移除并以新代重建，旧通知未打开',
  /** Instance boot-failure overlay title (design 05 §4). */
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
  'sessionOpen.waiting': '仍在载入会话内容。若主机迟迟没有响应，可继续等待。',
  'sessionOpen.failed': '会话内容未载入。可以重建对话通道；若主机无响应，重建也无法生成缺失的历史内容。',
  /** The conversation face is open; the content channel itself stopped updating. */
  'sessionOpen.rebuild': '重建对话通道',
  'sessionOpen.reload': '重新加载页面',
  /** Notification title: a session finished its turn. */
  'notification.sessionComplete': '会话已完成',
  /** Notification title: the agent is asking the user a question. */
  'notification.awaitingAnswer': '代理正在等待你的回答',
  /** Notification title: the agent requests approval. */
  'notification.awaitingApproval': '代理请求你的批准',
  /** L3 of the runtime-liveness guard: the conversation stopped receiving facts. */
  // 判据是「拿不到权威结论」（不是「沉默很久」）：长工具/长推理的合法静默与
  // 真卡死在本层不可区分，文案必须只说「无法确认」，不得断言任务停了。
  'sessionStall.text': '无法确认 {sources} 的会话状态：连接可能已停滞。',
  /** L3 source-list separator: CJK enumeration comma (en uses ', '). */
  'sessionStall.separator': '、',
  /** L3 light recovery: reconnect the source's connection generation without a page reload. */
  'sessionStall.reconnect': '重新连接',
  /** L3 heavy recovery: reload the whole app page (loses page-local UI state). */
  'sessionStall.reload': '重新加载应用页面',
  /** L3 dismiss: hide the notice for this continuous stall (re-armed when it breaks). */
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
  'sessionOpen.waiting': 'Still loading this conversation. You can keep waiting for the host.',
  'sessionOpen.failed': 'Conversation content did not load. Rebuild the stream, or reload the page. If the host is unresponsive, neither action can recreate missing history.',
  'sessionOpen.rebuild': 'Rebuild conversation stream',
  'sessionOpen.reload': 'Reload page',
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

/** Attribute the official locale service writes (locale/src/client/index.ts syncDocumentLanguage). */
export const DOCUMENT_LANGUAGE_ATTRIBUTE = 'lang'

/** Fallback locale: the served markup's own default (index.html lang="zh-CN"). */
export const FALLBACK_FRAME_LOCALE: FrameLocale = 'zh'

/**
 * Resolve the frame locale from a document language tag.
 *
 * A `zh`-family tag (`zh`, `zh-CN`, `zh-Hans`, …) is Chinese; every other known
 * tag is English (the frame carries exactly these two dictionaries, and the
 * official locale service only ever writes a tag it has copy for); an absent or
 * empty tag falls back to the SERVED MARKUP default rather than to the OS
 * locale, so an un-booted page shows the copy its own markup declares.
 * @param lang - the raw `document.documentElement.lang` value.
 * @returns the locale to render with.
 */
export function resolveFrameLocale(lang: string | undefined | null): FrameLocale {
  if (lang === undefined || lang === null) return FALLBACK_FRAME_LOCALE
  const tag = lang.trim().toLowerCase()
  if (tag === '') return FALLBACK_FRAME_LOCALE
  if (tag === 'zh' || tag.startsWith('zh-') || tag.startsWith('zh_')) return 'zh'
  return 'en'
}

/**
 * The document's current frame locale, read on demand (render time, or the
 * moment an out-of-render string is assembled).
 * @returns the resolved locale; the fallback in a doctored/DOM-less environment.
 */
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
 * Subscribe to document-language changes (the shell's locale service rewriting
 * `<html lang>`). Framework-free so the React side can bind it through
 * `useSyncExternalStore` and so plain-node imports stay usable.
 * @param onChange - called after every `lang` attribute change.
 * @returns the unsubscribe function.
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

/**
 * Render one dictionary entry, substituting `{name}` placeholders.
 * @param locale - the locale to render in.
 * @param key - a typed dictionary key.
 * @param params - placeholder values (unmatched placeholders stay verbatim).
 * @returns the localized string.
 */
export function frameText(
  locale: FrameLocale,
  key: FrameKey,
  params?: Readonly<Record<string, string>>,
): string {
  const template = FRAME_DICTIONARIES[locale][key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match)
}
