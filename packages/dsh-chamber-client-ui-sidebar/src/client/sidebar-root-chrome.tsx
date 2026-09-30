/** Sidebar shell chrome: the two panel-axis entry forms (the wide source
 *  header's compact action and the collapsed rail's upstream row), the region
 *  error boundary and the source-dot accent helper — presentational pieces that
 *  own no shell state. */

import { Component, type CSSProperties, type ReactNode } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PanelSelectorHook, SidebarPanelMetadata, SidebarRootComponentProps } from './contract/slots.ts'
import { sourceAccentColor } from '@dsh-chamber/dsh-chamber-client-core/derive'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import css from './SidebarRoot.module.css'
import cc from './sidebar-chamber.module.css'

/** Selector hook over the registered panels (inject hooks compartment). */
export type PanelsHook = <Selected>(selector: (panels: readonly SidebarPanelMetadata[]) => Selected) => Selected

/**
 * Remote sources carry the derived accent (34% saturation, 61% lightness, matching
 * the workspace icon accents); the local source keeps the default dot. The color
 * survives only on the rail dots, the active-source left inset and the fold-toggle
 * glyph. ONE palette definition: shared/derive.ts sourceAccentColor.
 */
export function sourceDotStyle(server: ChamberServerAggregate): CSSProperties | undefined {
  const color = sourceAccentColor(server.id)
  return color === undefined ? undefined : { backgroundColor: color }
}

/**
 * Region-scoped error boundary around the chamber list: an unexpected render error
 * (e.g. an interaction state meeting a malformed projection) must never take the
 * whole shell down; the list region shows the error inline. The region remounts on
 * the next sidebar expand/collapse cycle, which clears the boundary.
 */
export class ChamberListBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error }
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return <div className={cc.boundaryError} role="alert">{String(this.state.error.message || this.state.error)}</div>
    }
    return this.props.children
  }
}

/** One panel row for the collapsed rail axis (the wide column renders the compact
 *  `PanelHeaderEntry` instead): it subscribes only to its own selection state, so
 *  a panel switch re-renders the affected rows instead of the whole column. This is
 *  the upstream row's RAIL form only — the upstream wide half (16px glyph, title
 *  span, `disabled` tooltip) can never render here since the wide entry moved into
 *  the source header, so it was removed in the 2026-10 cleanup instead of being
 *  kept as unreachable code. */
export function PanelRow({
  id,
  label,
  usePanelInfo,
  selectPanel,
  renderSlot,
}: {
  id: SidebarPanelMetadata['id']
  label: string
  usePanelInfo: PanelSelectorHook
  selectPanel: (id: SidebarPanelMetadata['id']) => void
  renderSlot: SidebarRootComponentProps['renderSlot']
}) {
  const active = usePanelInfo(info => info.activePanelId === id)
  return (
    <Tooltip label={label} delayMs={500}>
      <button
        type="button"
        className={clsx(css.panelRow, active && css.panelActive)}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        onClick={() => { selectPanel(id) }}
      >
        <span className={css.panelGlyph} aria-hidden="true">
          {renderSlot('sidebar.panellist', { size: 18, active }, { only: id })}
        </span>
      </button>
    </Tooltip>
  )
}

/**
 * One panel entry as a source-header action (design 05 §2 / design 06 §4.7):
 * the WIDE column renders each `sidebar.panellist` registration as a compact
 * action in the header of the source that owns it, left of the view options.
 * It rides the header's `.sourceActions` cluster, so it is `display:none` at
 * rest and appears with its neighbours on hover or keyboard focus — the same
 * reveal discipline as the view-options button. The glyph still comes from the
 * list contract's owner props and the click forwards to the injected
 * `selectPanel`, exactly like the rail row (`PanelRow`); only the box differs
 * (the 20px `.actionIcon` instead of the upstream 36px row). The header's
 * suppress-click / pending-click gate wraps the forwarding at the CALL SITE
 * (ServerSectionHeader), not inside this component.
 */
export function PanelHeaderEntry({
  id,
  label,
  usePanelInfo,
  renderSlot,
  onSelect,
}: {
  id: SidebarPanelMetadata['id']
  label: string
  usePanelInfo: PanelSelectorHook
  renderSlot: SidebarRootComponentProps['renderSlot']
  onSelect: (id: SidebarPanelMetadata['id']) => void
}) {
  const active = usePanelInfo(info => info.activePanelId === id)
  return (
    <Tooltip label={label} side="bottom" delayMs={500}>
      <button
        type="button"
        className={clsx(cc.actionIcon, active && cc.actionPanelActive)}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        onClick={(event) => {
          event.stopPropagation()
          onSelect(id)
        }}
      >
        <span className={css.panelGlyph} aria-hidden="true">
          {renderSlot('sidebar.panellist', { size: 14, active }, { only: id })}
        </span>
      </button>
    </Tooltip>
  )
}
