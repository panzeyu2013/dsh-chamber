/**
 * Per-entry `<html lang>` ownership hook (design 06 §4.6「页面语言归属」).
 *
 * The official locale plugin writes the DOCUMENT-global `<html lang>` from its
 * own fiber — at activation and on every dictionary registration — with no
 * teardown and no active-source gate (built package
 * `@deepseek-ai/dsh-client-locale/lib/client.js`: `apply()` → `sync()` →
 * `syncDocumentLanguage()`). In a single-shell deployment that is exactly right;
 * in the chamber's N-ctx document it is the last-writer-wins defect this hook
 * closes.
 *
 * The composite owns the moment the plugin is MOUNTED (`chamber-entry.ts`
 * `register()` → `decorateMount`, and the deferred cluster's mount too), so the
 * hook runs IMMEDIATELY after the vendor `apply()` and reports this entry's
 * language fact to the page owner (`page-language.ts`): the owner accepts it
 * only when this entry is the source on screen AND this instance's settings
 * surface has settled, and otherwise restores its own value — in the same
 * synchronous task, before any paint. What is reported is the vendor's
 * locale-FACE publishes; the one vendor write that publishes nothing (its
 * settings-row callback calls `sync()` directly) is reverted by the page
 * backstop observer instead — a microtask later, still before paint. Every
 * install reports a mount GENERATION, so a retired mount can never erase a
 * newer mount's fact.
 *
 * Fail-open: no per-entry `chamberInstanceId` (the official single-shell shape),
 * a locale face the hook cannot read, or a settings scope it cannot bind or
 * whose shape it cannot trust leaves this entry UNOWNED — its language is never
 * adopted (the page keeps its current language until an ownable source reports),
 * while its document writes are still reverted by the page owner's backstop
 * observer. "The vendor keeps the document" holds only where no owner is
 * installed at all, i.e. the official single-shell shape.
 */

import type { Context } from '@deepseek-ai/cordis'

import { reportPageLanguageEntry, type EntryLanguageFact } from './page-language.ts'

/**
 * The vendor's settings namespace for the language preference
 * (`LOCALE_SETTINGS_NAMESPACE` in `@deepseek-ai/dsh-client-locale`; the plugin
 * binds `ctx.settingsScope.bind({ namespace: LOCALE_SETTINGS_NAMESPACE })`).
 * Mirrored literally on purpose: this is the HOST settings document's key
 * (`settings.yaml` `locale:`), not an implementation detail.
 */
const LOCALE_SETTINGS_NAMESPACE = 'locale'

/**
 * Mount generation counter (page-scoped, monotonic): the per-entry hook reports
 * it with every fact so a later mount of the same source outranks an earlier one
 * (see `PageLanguageOwner.report`).
 */
let mountGeneration = 0

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Loose mirror of the ui-renderer slot service faces this hook consumes
     * (nothing else): `hostFace().locale` is the LocaleFace the official locale
     * plugin installs through `ctx.slots.installLocale(face)`.
     */
    slots?: {
      hostFace?: () => { locale?: unknown }
    }
    /**
     * Loose mirror of the ui-settings domain service (design 05 §5): the
     * per-namespace scope is what the vendor locale plugin itself binds, and its
     * snapshot `status` is this hook's "the settings surface settled" fact —
     * `loading` is the only unresolved state (the host has not answered), any
     * other status means the face's active value is this instance's own.
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
 * Decorate one plugin namespace so its document writes are reported to the page
 * owner: the vendor body applies FIRST, then the ownership hook installs — same
 * fiber, same synchronous task, and (crucially) after the vendor registered its
 * own `locale.subscribe(sync)`, so every publish reaches the hook with the
 * vendor's document write already made.
 * @param plugin - the namespace the composite is about to mount.
 * @returns the namespace to mount; a shape without an `apply` body is returned untouched.
 */
export function withLocaleOwnership(plugin: object): object {
  const apply = (plugin as { apply?: unknown }).apply
  if (typeof apply !== 'function') return plugin
  // A NORMAL function, not an arrow: cordis picks a plugin's execution path from
  // `isConstructor` (does the callback have a prototype?) and calls it with
  // `new` when it does. An arrow wrapper would silently flip that branch
  // (`this` becomes undefined) and swallow a returned instance, so this wrapper
  // keeps the vendor callback's own shape and forwards BOTH `this` and the
  // return value.
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
 * Report this entry's language fact to the page owner and keep it current for
 * the entry's whole life.
 *
 * Called from the locale plugin's own `apply` fiber, AFTER the vendor's
 * `ctx.effect(() => locale.subscribe(sync))` registration — so on every locale
 * snapshot change the vendor's document write has already happened when this
 * hook runs, and the owner's restore lands in the same synchronous task.
 * @param ctx - the entry context the vendor locale plugin just applied to.
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
    // 'loading' is the mirror's initial state: the host has not answered yet, so
    // the face's value is the browser-derived PROVISIONAL — never an owner.
    // Every other settled status is this instance's OWN effective language:
    // 'ready' with a stored preference (the setting), 'ready' without one (the
    // same browser-derived value, which the instance's own UI keeps using) and
    // 'unavailable' (this host serves no locale namespace at all).
    const status = scope.getSnapshot()?.status
    return { locale: active, settled: status !== undefined && status !== 'loading' }
  }
  const report = (): void => { reportPageLanguageEntry(instanceId, fact(), generation) }
  // 形状对但会抛的 face/scope 也必须 fail-open：
  // 一次 getSnapshot 抛错会经 ctx.effect 逃出 vendor fiber，把 locale 插件整条
  // 装起来失败（= 降级启动），与"无归属、语言不被采纳"的 fail-open 声明相反。
  // 守卫包在**订阅与 effect 用的那层**：抛错时按"无事实"上报（撤回/不采纳）。
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
      // This MOUNT is gone: drop its fact (the owner keeps its current language
      // regardless), but only if no newer mount of the same source has since
      // claimed the slot — the generation inside `report` decides.
      reportPageLanguageEntry(instanceId, undefined, generation)
    }
  }, 'chamber: <html lang> ownership')
}

/**
 * The entry's locale face. Two public doors, in contract order: the service the
 * vendor provides (`ctx.provide('locale', locale)` — read NON-strictly because
 * the providing fiber is still activating while this hook runs) and the face the
 * vendor installs into the slot service (`ctx.slots.installLocale`).
 * @param ctx - the entry context.
 * @returns the face, or undefined when neither door carries one.
 */
function resolveLocaleFace(ctx: Context): LocaleFace | undefined {
  const viaService = ctx.get('locale', false)
  if (isLocaleFace(viaService)) return viaService
  const viaSlots = ctx.slots?.hostFace?.()?.locale
  return isLocaleFace(viaSlots) ? viaSlots : undefined
}

/**
 * The settings scope for the locale namespace — the same binding the vendor
 * plugin performs, so its snapshot is the vendor's own "host answered" fact.
 * A scope that cannot be bound disables the hook (fail-open) rather than
 * guessing whether a value is provisional.
 * @param ctx - the entry context.
 * @returns the bound scope, or undefined.
 */
function bindLocaleScope(ctx: Context): SettingsScopeFace | undefined {
  try {
    const scope = ctx.settingsScope?.bind({ namespace: LOCALE_SETTINGS_NAMESPACE })
    // Shape-checked like the locale face: a scope that cannot answer snapshots
    // would throw inside the install-time report and fail the vendor fiber
    // instead of failing open.
    return isSettingsScope(scope) ? scope : undefined
  } catch (error) {
    // Loud but non-fatal: without the scope the ownership rule cannot tell an
    // unresolved provisional from an adopted one, so this entry stays UNOWNED
    // (its language is never adopted) instead of the page guessing.
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
