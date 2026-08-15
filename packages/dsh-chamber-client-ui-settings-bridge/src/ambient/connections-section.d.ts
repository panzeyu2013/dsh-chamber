/**
 * Local declaration for the connections settings section component
 * (packages/dsh-client-ui-settings-connections): the bridge section embeds
 * it as the page-bottom connection management surface (create/delete
 * connections). Resolved via tsconfig paths — the connections package's own
 * sources are never compiled here; at runtime vite resolves the specifier
 * through the explicit renderer alias to the real TSX.
 *
 * MIRROR WARNING: this face mirrors the REAL component's consumption
 * surface. The real component currently consumes ONLY `props.t` (verified
 * against ConnectionsSection.tsx) — if the real component ever starts
 * consuming close/owner props, this declaration and the <ConnectionsSection>
 * call site in SettingsShell.tsx MUST be updated together.
 */

import type { ReactNode } from 'react'

/** The section's own dictionary namespace (registered by the connections plugin on the hosting boot). */
export type SettingsConnectionsKey = string

/** Business face consumed by the component (t only — close is declared but unused). */
export interface ConnectionsSectionInjected {
  t: (key: SettingsConnectionsKey) => string
}

/** Full component props (loose mirror: runtime passes the inject face; slot surfaces are inert). */
export type ConnectionsSectionProps = ConnectionsSectionInjected & Record<string, unknown>

/** The connections settings section component. */
export function ConnectionsSection(props: ConnectionsSectionProps): ReactNode
