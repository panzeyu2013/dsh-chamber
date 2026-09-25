/** Window-chrome controls for the fully hidden macOS sidebar (frame `shell.leading` seat). */
import {
  IconNewChatOutlineRegular, IconPanelLeftOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the layout frame's `shell.leading` slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarRootInjected, SidebarShortcutEntry } from './contract/slots.ts'
import css from './SidebarLeadingControls.module.css'

/** Bound `useShortcuts` selector hook (the loose vendor inject face erases the hook's type). */
type ShortcutsHook = <Selected>(selector: (rows: readonly SidebarShortcutEntry[]) => Selected) => Selected

/** Full props of the `shell.leading` occupant. */
export type SidebarLeadingControlsProps =
  PropsRuntime<'shell.leading'>
  & InjectFace<SidebarRootInjected>
  & PropsLocale<'sidebar'>

/**
 * Sidebar-open and New Session controls in the frame's window-chrome seat.
 * On macOS desktop a collapsed sidebar hides the whole column, taking the
 * rail's toggle and New Session button off screen; this occupant puts both
 * back beside the traffic lights. The frame mounts the seat only in that
 * state and owns its placement, so the occupant renders unconditionally.
 * The two controls are fixed (official ui-sidebar parity: the reopen toggle
 * sits closest to the traffic lights, New Session to its right); each binds
 * its own shortcut row so the tooltip keycap and `aria-keyshortcuts` follow
 * the effective binding, both absent while the command is unregistered.
 * @param props - Injected sidebar actions, the shortcut catalog hook and the sidebar locale seat.
 * @returns the two window-chrome controls.
 */
export function SidebarLeadingControls({ toggleSidebar, startSession, useShortcuts, t }: SidebarLeadingControlsProps) {
  const shortcut = (useShortcuts as ShortcutsHook)(rows => rows.find(row => row.id === 'sidebar.left.toggle'))
  const newShortcut = (useShortcuts as ShortcutsHook)(rows => rows.find(row => row.id === 'session.new'))
  return (
    <div className={css.controls}>
      <Tooltip label={t('toggle.open')} shortcutKeys={shortcut?.keys} delayMs={500}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('toggle.open')}
          aria-keyshortcuts={shortcut?.aria}
          onClick={() => { toggleSidebar() }}
        >
          <IconPanelLeftOutlineRegular size={16} />
        </button>
      </Tooltip>
      <Tooltip label={t('session.new.label')} shortcutKeys={newShortcut?.keys} delayMs={500}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('session.new.label')}
          aria-keyshortcuts={newShortcut?.aria}
          onClick={() => { startSession() }}
        >
          <IconNewChatOutlineRegular size={16} />
        </button>
      </Tooltip>
    </div>
  )
}
