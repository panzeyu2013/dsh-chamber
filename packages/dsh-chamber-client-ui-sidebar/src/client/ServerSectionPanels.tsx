/**
 * One source's panel rows: the `sidebar.panellist` entries THIS ctx registered,
 * hung under the source that owns them (design 05 §2 / design 06 §4.7). The row
 * component, its geometry and its interaction are the upstream ones verbatim —
 * only the container (and therefore the position) is chamber's. The owning
 * section renders it (`server.id === chamberInstanceId`), so a foreign source's
 * section never borrows another instance's ledger; the collapsed rail keeps the
 * upstream global glyph axis (SidebarRoot.tsx).
 */
import type { ReactNode } from 'react'
import { PanelRow } from './sidebar-root-chrome.tsx'
import { useSidebarSection } from './sidebar-context.ts'
import cc from './sidebar-chamber.module.css'

export function ServerSectionPanels(): ReactNode {
  const { wide, t, panels, usePanelInfo, selectPanel, renderSlot } = useSidebarSection()
  if (panels.length === 0) return null
  return (
    <nav className={cc.sectionPanels} aria-label={t('panels.label')}>
      {panels.map(panel => (
        <PanelRow
          key={panel.id}
          id={panel.id}
          label={panel.label}
          wide={wide}
          usePanelInfo={usePanelInfo}
          selectPanel={selectPanel}
          renderSlot={renderSlot}
        />
      ))}
    </nav>
  )
}
