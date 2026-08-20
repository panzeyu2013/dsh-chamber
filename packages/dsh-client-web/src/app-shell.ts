/**
 * App-shell assembly plugin. Its pseudo package id exists only in the host
 * graph and shell registry; there is no npm package behind it.
 */
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { createSlotRenderer } from '@deepseek-ai/dsh-client-web-react'
import { classifyRendererInstallError } from './boot-tolerance.ts'
import { buildRenderApp } from './app.tsx'

/** Shell-owned pseudo entry id under which the host graph mounts this plugin. */
export const APP_SHELL_ID = '@deepseek-ai/dsh-client-app-shell'

/** The assembled-UI face AppRoot renders once the boot settles. */
export interface AppShellService {
  /** Build (once) and render the real UI tree. */
  renderApp: () => ReactNode
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The shell assembly face, provided by the app-shell entry once its inject set is active. */
    appShell: AppShellService
  }
}

/** Cordis plugin name. */
export const name = 'app-shell'

/** Services required before shell assembly. */
export const inject = ['slots', 'sessions', 'layout']

/** Installs the React renderer and exposes the assembled application.
 * @param ctx - Plugin context.
 */
export function apply(ctx: Context): void {
  // The renderer install is shell territory (web-react is shell-bundled),
  // but ctx.slots exists only once the runtime entry is active — so it lands
  // here, on the entry whose inject set guarantees that ordering.
  //
  // ## chamber patch (2026-08, version-tolerance): a backend dsh version may
  // move the renderer install into its OWN graph row (rc.8's
  // `dsh-client-ui-renderer` does — it is a core row the composite does not
  // cover, so it arrives as an extra row and installs `createSlotRenderer()`
  // from ITS bundle). Whichever of the two installs runs second would throw
  // "slot renderer already installed (install() is boot-once)" — in the order
  // where this shell entry runs second, that throw would fail the WHOLE boot
  // (this entry is not a tolerated extra row). The install is idempotent by
  // contract (boot-once), so the tolerant reading is: if the renderer is
  // already installed, this shell simply adopts the existing one. Both
  // orders now settle — either the shell's renderer wins (a newer row
  // degraded by the extra-row tolerance) or the row's does (this install
  // skips) — and both are the same createSlotRenderer contract. The decision
  // rule (string match, fail-safe: any other error rethrows loud) lives in
  // boot-tolerance.ts, unit-tested.
  //
  // Lifecycle tail-gate (documented, accepted): in the "row installs first,
  // this shell adopts" order, install() registered its uninstall effect on
  // the ROW's fiber (slots.ts ctx.effect) — if that row later stops while
  // this shell lives, the disposer clears slots._renderer (by-value guard)
  // and renderSlot('root') would throw "slot renderer not installed". Only a
  // core renderer row dying mid-flight reaches this, and the pre-patch
  // behavior (the whole boot fails) is strictly worse — noted, not fixed.
  try {
    ctx.slots.install(createSlotRenderer())
  } catch (error) {
    if (classifyRendererInstallError(error) === 'fatal') throw error
    console.warn('[web-shell] slot renderer already installed by a backend row; adopting it (version-tolerance)')
  }

  // Assemble once on first render: the closure must be identity-stable
  // across AppRoot re-renders.
  let renderApp: (() => ReactNode) | undefined
  ctx.reflect.provide('appShell', {
    renderApp: (): ReactNode => {
      renderApp ??= buildRenderApp({ ctx })
      return renderApp()
    },
  })
}
