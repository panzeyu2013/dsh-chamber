/**
 * Per-entry `<html lang>` ownership hook.
 *
 * The official locale plugin writes the DOCUMENT-global `<html lang>` from its own
 * fiber (activation + every dictionary registration, no teardown, no active-source
 * gate): right for a single shell, last-writer-wins in the chamber's N-ctx document.
 * The composite owns the MOUNT moment, so this hook runs IMMEDIATELY after the vendor
 * `apply()` and reports this entry's fact to the page owner (`page-language.ts`); the
 * owner accepts it only when this entry is the source on screen AND its settings
 * surface has settled, and otherwise restores its own value in the same synchronous
 * task. Every install reports a mount GENERATION. Fail-open: missing per-entry
 * identity, an unreadable face, or an untrusted settings scope leaves the entry
 * UNOWNED, while its document writes are still reverted by the page backstop observer.
 */

import type { Context } from '@deepseek-ai/cordis'

import { reportPageLanguageEntry, type EntryLanguageFact } from './page-language.ts'

/**
 * The vendor's settings namespace for the language preference; mirrored literally
 * on purpose — this is the HOST settings document's key (`settings.yaml` `locale:`),
 * not an implementation detail.
 */
const LOCALE_SETTINGS_NAMESPACE = 'locale'

/** The vendor's settings namespace for the language preference; mirrored literally on
 *  purpose — this is the HOST settings document's key (`settings.yaml` `locale:`). */
let mountGeneration = 0

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Loose mirror of the ui-renderer slot face consumed here: `hostFace().locale` is the LocaleFace installed via `ctx.slots.installLocale(face)`. */
    slots?: {
      hostFace?: () => { locale?: unknown }
    }
    /**
     * Loose mirror of the ui-settings domain service: the per-namespace scope is
     * what the vendor locale plugin itself binds; snapshot `status` is the "settings
     * surface settled" fact — `loading` is the only unresolved state.
     */
    settingsScope?: {
      bind(spec: { namespace: string }): SettingsScopeFace
    }
  }
}

/** The minimal settings-scope face this hook reads (ui-settings domain service). */
interface SettingsScopeFace {
  getSnapshot(): { status?: unknown }
  subscribe(listener: () => void): () => void
}

/** The minimal locale face this hook reads (LocaleFace: getSnapshot/subscribe). */
interface LocaleFace {
  getSnapshot(): { active?: unknown }
  subscribe(listener: () => void): () => void
}

/**
 * Decorate one plugin namespace so its document writes are reported to the page owner:
 * the vendor body applies FIRST, then the hook installs — same fiber, same synchronous
 * task, after `locale.subscribe(sync)` registration. A namespace without an `apply`
 * body is returned untouched.
 */
export function withLocaleOwnership(plugin: object): object {
  const apply = (plugin as { apply?: unknown }).apply
  if (typeof apply !== 'function') return plugin
  // A NORMAL function, not an arrow: cordis picks the execution path from
  // `isConstructor` and calls with `new` when the callback has a prototype. An
  // arrow wrapper would flip that branch and swallow a returned instance, so
  // forward BOTH `this` and the return value.
  return {
    ...plugin,
    apply: function (this: unknown, ctx: Context): unknown {
      const result = (apply as (this: unknown, ctx: Context) => unknown).call(this, ctx)
      installLocaleOwnership(ctx)
      return result
    },
  }
}

/**
 * Report this entry's language fact to the page owner for the entry's whole life.
 * Called from the vendor's own `apply` fiber, AFTER `locale.subscribe(sync)`
 * registration, so the owner's restore lands in the same synchronous task.
 */
function installLocaleOwnership(ctx: Context): void {
  const instanceId = ctx.chamberInstanceId
  // Fail-open: no per-entry identity means this is not the chamber's N-ctx mount.
  if (typeof instanceId !== 'string' || instanceId === '') return
  const face = resolveLocaleFace(ctx)
  if (face === undefined) return
  const scope = bindLocaleScope(ctx)
  if (scope === undefined) return
  // This mount's generation: a later mount of the same source outranks it, so a
  // retiring mount can never erase a live fact (PageLanguageOwner.report).
  const generation = ++mountGeneration

  const fact = (): EntryLanguageFact | undefined => {
    const active = face.getSnapshot()?.active
    if (typeof active !== 'string' || active === '') return undefined
    // 'loading' is the mirror's initial state: the host has not answered, so the face's
    // value is the browser-derived PROVISIONAL — never an owner. Every other settled
    // status is this instance's OWN effective language ('ready', 'unavailable', …).
    const status = scope.getSnapshot()?.status
    return { locale: active, settled: status !== undefined && status !== 'loading' }
  }
  const report = (): void => { reportPageLanguageEntry(instanceId, fact(), generation) }
  // 形状对但会抛的 face/scope 也必须 fail-open：一次 getSnapshot 抛错会经 ctx.effect 逃出
  // vendor fiber，把 locale 插件整条装失败。守卫包在订阅与 effect 层，抛错按"无事实"上报。
  const safeReport = (): void => {
    try {
      report()
    } catch (error) {
      console.warn('[renderer] <html lang> ownership fact unavailable:', error)
      reportPageLanguageEntry(instanceId, undefined, generation)
    }
  }

  ctx.effect(() => {
    const offFace = face.subscribe(safeReport)
    const offScope = scope.subscribe(safeReport)
    // The vendor wrote the document during `apply()`, before this hook existed:
    // report (and let the owner restore) that write now.
    safeReport()
    return () => {
      offFace()
      offScope()
      // This MOUNT is gone: drop its fact, but only if no newer mount of the same
      // source has claimed the slot — the generation inside `report` decides.
      reportPageLanguageEntry(instanceId, undefined, generation)
    }
  }, 'chamber: <html lang> ownership')
}

/**
 * The entry's locale face, two doors in contract order: the vendor-provided service
 * (`ctx.provide('locale')`, read NON-strictly) and the slot-service installed face.
 */
function resolveLocaleFace(ctx: Context): LocaleFace | undefined {
  const viaService = ctx.get('locale', false)
  if (isLocaleFace(viaService)) return viaService
  const viaSlots = ctx.slots?.hostFace?.()?.locale
  return isLocaleFace(viaSlots) ? viaSlots : undefined
}

/**
 * The locale-namespace settings scope — the same binding the vendor plugin performs
 * (its snapshot is the "host answered" fact); an unbindable scope disables the hook.
 */
function bindLocaleScope(ctx: Context): SettingsScopeFace | undefined {
  try {
    const scope = ctx.settingsScope?.bind({ namespace: LOCALE_SETTINGS_NAMESPACE })
    // Shape-checked like the locale face: a scope that cannot answer snapshots would
    // throw inside the install-time report and fail the vendor fiber.
    return isSettingsScope(scope) ? scope : undefined
  } catch (error) {
    // Loud but non-fatal: without the scope the rule cannot tell an unresolved
    // provisional from an adopted one, so this entry stays UNOWNED.
    console.warn('[renderer] <html lang> ownership disabled: locale settings scope unavailable:', error)
    return undefined
  }
}

/** Structural check for the settings-scope pair this hook relies on. */
function isSettingsScope(value: unknown): value is SettingsScopeFace {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { getSnapshot?: unknown; subscribe?: unknown }
  return typeof candidate.getSnapshot === 'function' && typeof candidate.subscribe === 'function'
}

/** Structural check for the LocaleFace pair this hook relies on. */
function isLocaleFace(value: unknown): value is LocaleFace {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { getSnapshot?: unknown; subscribe?: unknown }
  return typeof candidate.getSnapshot === 'function' && typeof candidate.subscribe === 'function'
}
