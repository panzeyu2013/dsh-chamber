/** Sidebar shell chrome: the panel row (rail axis and source-scoped section
 *  share it), the region error boundary and the source-dot accent helper —
 *  presentational pieces that own no shell state. */

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

/** One panel row (the rail axis and the per-source section share this component):
 *  it subscribes only to its own selection state, so a panel switch re-renders the
 *  affected rows instead of the whole column. */
export function PanelRow({
  id,
  label,
  wide,
  usePanelInfo,
  selectPanel,
  renderSlot,
}: {
  id: SidebarPanelMetadata['id']
  label: string
  wide: boolean
  usePanelInfo: PanelSelectorHook
  selectPanel: (id: SidebarPanelMetadata['id']) => void
  renderSlot: SidebarRootComponentProps['renderSlot']
}) {
  const active = usePanelInfo(info => info.activePanelId === id)
  return (
    <Tooltip label={label} delayMs={500} disabled={wide}>
      <button
        type="button"
        className={clsx(css.panelRow, active && css.panelActive)}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        onClick={() => { selectPanel(id) }}
      >
        <span className={css.panelGlyph} aria-hidden="true">
          {renderSlot('sidebar.panellist', { size: wide ? 16 : 18, active }, { only: id })}
        </span>
        {wide && <span className={css.panelTitle}>{label}</span>}
      </button>
    </Tooltip>
  )
}
