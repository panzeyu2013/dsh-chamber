/**
 * Sidebar shell chrome:
 * the global-panel row, the region error boundary and the source-dot accent
 * helper — presentational pieces that own no shell state.
 */

import { Component, type CSSProperties, type ReactNode } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarPanelMetadata, SidebarRootComponentProps } from './contract/slots.ts'
import { sourceAccentColor } from '@dsh-chamber/dsh-chamber-client-core/derive'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import css from './SidebarRoot.module.css'
import cc from './sidebar-chamber.module.css'

/** Root panel-selection snapshot (alpha.2 `ctx.layout` / `usePanelInfo`). */
interface PanelInfoSnapshot {
  readonly activePanelId: string | null
}

/** Selector hook over the panel selection (framework-bound prop). */
type PanelSelectorHook = <Selected>(selector: (info: PanelInfoSnapshot) => Selected) => Selected

/** Selector hook over the registered global panels (inject hooks compartment). */
export type PanelsHook = <Selected>(selector: (panels: readonly SidebarPanelMetadata[]) => Selected) => Selected

/**
 * Remote sources carry the derived accent; the local source keeps the default
 * dot. Soft palette: 34% saturation at 61% lightness, matching the workspace
 * icon accents. There is no source-header identity DOT; this
 * color survives on the rail dots, the active-source left inset and the
 * source fold-toggle glyph only. ONE palette definition: shared/derive.ts
 * sourceAccentColor (the session-todo source dot consumes the same helper).
 */
export function sourceDotStyle(server: ChamberServerAggregate): CSSProperties | undefined {
  const color = sourceAccentColor(server.id)
  return color === undefined ? undefined : { backgroundColor: color }
}

/**
 * Region-scoped error boundary around the chamber list (design 05 §2): an
 * unexpected render error — e.g. an interaction state (drag) meeting a
 * malformed projection — must never take the whole shell (and with it the
 * app) down. The column shell stays intact; the list region shows the error
 * text inline, which both keeps the UI alive and surfaces the root cause to
 * the user instead of a blank. The region remounts on the next sidebar
 * expand/collapse cycle, which clears the boundary.
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

/**
 * One global-panel row (alpha.2 `sidebar.panellist`): the sidebar owns the
 * button and the row subscribes only to its own selection state, so a panel
 * switch re-renders the affected rows instead of the whole column. The icon
 * comes from the addressing list entry; the label is the shell's resolved
 * metadata.
 */
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
        {wide && <span className={clsx(css.panelTitle, css.wide)}>{label}</span>}
      </button>
    </Tooltip>
  )
}
