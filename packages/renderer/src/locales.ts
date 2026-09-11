/**
 * App-frame copy (T16, 2026-09-11 upstream-alignment).
 *
 * Upstream's rule for the client stack (`packages/client/AGENTS.md`, "Styling
 * and localization"): EVERY product-visible string — text, accessibility names,
 * tooltips, placeholders, status/unit formatters, primitive chrome — lives in a
 * typed locale dictionary and reaches the component through the standard `t`
 * seat or an already-localized prop. The chamber's own client plugins comply
 * (each owns `src/locales.ts`, registered through `ctx.locale.register`). The
 * FRAME around those shells (App.tsx, InstanceView.tsx, the static skeleton)
 * does not: it hosts N ctxs and owns NO `t` seat, so its chrome copy was inline
 * Chinese literals.
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
 * service is its single writer — `syncDocumentLanguage` sets `<html lang>` at
 * activation and on every locale change (vendor
 * packages/client/locale/src/client/index.ts:149), i.e. the booted shell's own
 * active locale IS the document language. This is the same mechanism, and the
 * same fallback pin, the chamber's settings-bridge already uses for ctx-free
 * copy (`DshRuntimeSection.tsx` `formatTimestamp`: "the served markup defaults
 * to zh-CN, so an unset lang falls back to zh-CN rather than the OS locale") —
 * the served markup's own default is `zh-CN` (index.html). Only the document is
 * observed, never `navigator.language`: the user's choice inside dsh is
 * authoritative, and an English document must produce English chrome.
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
  /** Static first-frame skeleton hint (index.html; re-applied by main.tsx). */
  'boot.starting': '正在启动…',
  /** App-frame crash screen (ErrorBoundary) title. */
  'error.ui.title': '界面发生错误',
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
  /** Notification title: a session finished its turn. */
  'notification.sessionComplete': '会话已完成',
  /** Notification title: the agent is asking the user a question. */
  'notification.awaitingAnswer': '代理正在等待你的回答',
  /** Notification title: the agent requests approval. */
  'notification.awaitingApproval': '代理请求你的批准',
} satisfies Record<string, string>

/** The frame key union (dictionary keys, typed). */
export type FrameKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en: Record<FrameKey, string> = {
  'action.retry': 'Retry',
  'action.switchServer': 'Switch to another server:',
  'boot.loading': 'Loading {label}…',
  'boot.loadingHint': 'The full interface loads on first open',
  'boot.starting': 'Starting…',
  'error.ui.title': 'Interface error',
  'fatal.boot.title': 'Instance failed to start',
  'fatal.entries.title': 'Failed to load plugins',
  'fatal.controlPlane.title': 'Cannot reach the control plane',
  'fatal.harvestTimeout': 'Instance boot timed out: no response within {seconds}s of mounting (retry or switch source)',
  'source.local': 'Local instance',
  'session.untitled': 'Untitled session',
  'notification.sessionComplete': 'Session complete',
  'notification.awaitingAnswer': 'The agent is waiting for your answer',
  'notification.awaitingApproval': 'The agent requests your approval',
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
