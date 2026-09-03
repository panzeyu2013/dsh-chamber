/**
 * Local declaration for the connections settings section component
 * (packages/dsh-client-ui-settings-connections): the bridge section embeds
 * it as the page-bottom connection management surface (create/delete
 * connections). Resolved via tsconfig paths for the stable
 * `@dsh-chamber/dsh-client-ui-settings-connections/section` subpath (A6 —
 * never a deep `./src/*` import) — the connections package's own sources are
 * never compiled here; at runtime vite resolves the specifier through the
 * explicit renderer alias to the real TSX.
 *
 * MIRROR WARNING: this face mirrors the REAL component's consumption
 * surface (ConnectionsSection.tsx destructures `t` + `pluginDiagnostics` +
 * `onRecheckDiagnostic`; the local card reads the renderer-published plugin
 * diagnostics — 2026 review T4). If the real component's props change, this
 * declaration and the <ConnectionsSection> call site in SettingsShell.tsx MUST
 * be updated together. Structural note: the real component keeps
 * pluginDiagnostics/onRecheckDiagnostic in its extra-props block (not the
 * injected business face); the mirror lumps them into ConnectionsSectionInjected
 * for call-site convenience — harmless because the call site passes them
 * positionally, but keep the member names in sync with the real Props.
 */

import type { ReactNode } from 'react'

/** The section's own dictionary namespace (registered by the connections plugin on the hosting boot). */
export type SettingsConnectionsKey = string

/** Business face consumed by the component. */
export interface ConnectionsSectionInjected {
  t: (key: SettingsConnectionsKey) => string
  /** Renderer-published per-instance plugin diagnostics (local card). */
  pluginDiagnostics?: Readonly<Record<string, { state: string; message?: string } | undefined>>
  /** Host-provided CHANNEL-class diagnostic self-heal recheck (design 09
   *  §3.5): the section's plugin dialogs ask the host when their banner is a
   *  channel fact; the host owns the shared store write-back. */
  onRecheckDiagnostic?: (sourceId: string) => void
}

/** Full component props (loose mirror: runtime passes the inject face; slot surfaces are inert). */
export type ConnectionsSectionProps = ConnectionsSectionInjected & Record<string, unknown>

/** The connections settings section component. */
export function ConnectionsSection(props: ConnectionsSectionProps): ReactNode
