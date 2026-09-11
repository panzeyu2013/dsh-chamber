/**
 * Local declaration for the connections settings section component
 * (packages/dsh-client-ui-settings-connections): the bridge section embeds
 * it as the page-bottom connection management surface (create/delete
 * connections). Resolved via tsconfig paths for the stable
 * `@dsh-chamber/dsh-chamber-client-ui-settings-connections/section` subpath (A6 —
 * never a deep `./src/*` import) — the connections package's own sources are
 * never compiled here; at runtime vite resolves the specifier through the
 * explicit renderer alias to the real TSX.
 *
 * MIRROR WARNING: this face mirrors the REAL component's consumption
 * surface (ConnectionsSection.tsx destructures `t` + `pluginDiagnostics` +
 * `onRecheckDiagnostic` + the settings-assembly block props; the local card
 * reads the renderer-published plugin diagnostics — 2026 review T4). If the
 * real component's props change, this declaration and the <ConnectionsSection>
 * call site in SettingsShell.tsx MUST be updated together — since the 2026-09
 * relocation that pairing is also pinned by
 * `test/connections-section-mirror.test.ts` (the mirror had no gate before).
 * Structural note: the real component keeps
 * pluginDiagnostics/onRecheckDiagnostic/assembly* in its extra-props block (not
 * the injected business face); the mirror lumps them into
 * ConnectionsSectionInjected for call-site convenience — harmless because the
 * call site passes them positionally, but keep the member names in sync with
 * the real Props.
 */

import type { ReactNode } from 'react'
import type { SettingsBridgeKey } from '../locales.ts'

/** The section's own dictionary namespace (registered by the connections plugin on the hosting boot). */
export type SettingsConnectionsKey = string

/** One settings-assembly notice as it crosses the boundary (its key belongs to
 *  the settings shell's dictionary, so it stays a plain string here). */
export interface SettingsAssemblyNoticeMirror {
  key: string
  params?: Record<string, string> | undefined
}

/** Per-source settings-assembly report (structural mirror of the shell's
 *  `settings-extensions.ts` `SettingsAssemblyReport`; the producer owns it). */
export interface SettingsAssemblyReportMirror {
  sourceId: string
  state: string
  total: number
  notices: readonly SettingsAssemblyNoticeMirror[]
}

/** Business face consumed by the component. */
export interface ConnectionsSectionInjected {
  t: (key: SettingsConnectionsKey) => string
  /** Renderer-published per-instance plugin diagnostics (local card). */
  pluginDiagnostics?: Readonly<Record<string, { state: string; message?: string } | undefined>>
  /** Host-provided CHANNEL-class diagnostic self-heal recheck (design 09
   *  §3.5): the section's plugin dialogs ask the host when their banner is a
   *  channel fact; the host owns the shared store write-back. */
  onRecheckDiagnostic?: (sourceId: string) => void
  /** The SELECTED source's settings-assembly report (2026-09 relocation):
   *  rendered inside exactly the card whose id it names. */
  assemblyReport?: SettingsAssemblyReportMirror | undefined
  /** The settings shell's translate over ITS OWN dictionary namespace (the
   *  report's copy lives there; params supported). Keyed by THIS shell's
   *  dictionary type so the bound `t` is assignable: the real component types
   *  the prop as string-keyed, and every notice key it renders is a member of
   *  this dictionary by contract (see `SettingsNoticeKey`). */
  assemblyT?: ((key: SettingsBridgeKey, params?: Record<string, unknown>) => string) | undefined
  /** Ask the shell to re-read the source's plugin graph and reconcile. */
  onRefreshAssembly?: (() => void) | undefined
  /** A reconcile refresh is in flight. */
  assemblyRefreshing?: boolean | undefined
}

/** Full component props (loose mirror: runtime passes the inject face; slot surfaces are inert). */
export type ConnectionsSectionProps = ConnectionsSectionInjected & Record<string, unknown>

/** The connections settings section component. */
export function ConnectionsSection(props: ConnectionsSectionProps): ReactNode
