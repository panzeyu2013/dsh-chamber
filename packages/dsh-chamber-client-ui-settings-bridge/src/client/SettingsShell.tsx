/**
 * Chamber settings shell — replaces the official SettingsRoot registration
 * in the `sidebar.settings` slot (registered at a lower priority so the
 * official shell is shadowed, not conflicted). The sidebar-foot trigger plus
 * the centered modal panel keep the official panel geometry (figma
 * 501:29947), but the nav rail is re-aimed: a SERVER dropdown on top
 * (local default; searchable portal, all rows selectable, connection state
 * colored green/red) over the SELECTED server's official settings
 * sections, and the options column renders that server's official section
 * content through the child cordis context bridge (bridge-context.ts). The
 * chamber-global connections surface is a FIXED nav entry below a divider —
 * it never follows the selected server and renders the official
 * ConnectionsSection as a full options-column view when active.
 *
 * Deliberate omissions vs the official shell: onboarding steps and the
 * settings.header/action seats are not rendered (the header title and close
 * are self-built); every section's config fact still lives on the selected
 * instance's host machine.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  IconAgentPresetOutline16, IconCloseOutline16, IconDataOutline16, IconLinkOutline16,
  IconLoadingOutline16, IconPersonalizationOutline16, IconSettingsOutline14, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsBridgeKey } from '../locales.ts'
import { ConnectionsSection } from '@dsh-chamber/dsh-client-ui-settings-connections/src/client/ConnectionsSection.tsx'
import { GeneralView } from './GeneralView.tsx'
import {
  CONNECTIONS_SECTION_ID,
  GENERAL_SECTION_ID,
  resolveActiveSection,
  type SectionNavRow,
} from './nav-active.ts'
import {
  getServers, subscribeServers, type BridgeServerRow,
} from './bridge-servers.ts'
import {
  mountBridgeSession, sectionRows, type BridgeSession,
} from './bridge-context.ts'
import {
  nextMountRetryDelayMs,
} from './mount-retry.ts'
import { BridgeEntryBoundary, BridgeOutlet, useLocaleRevision } from './bridge-outlet.tsx'
import css from './SettingsShell.module.css'
import { filterServerRows, serverDropdownPlacement } from './server-selector.ts'

/** Registration-side business face for the chamber settings shell. */
export interface SettingsShellInjected {
  /** Bound translate over the shell's own dictionary namespace ({param} interpolation supported). */
  t: (key: SettingsBridgeKey, params?: Record<string, unknown>) => string
  /** Bound translate over the connections section's dictionary ('dsh-chamber.settings.connections'). */
  connectionsT: (key: string) => string
  /** The hosting boot's instance id ('local' | 'ssh-<id>'), when known. */
  chamberInstanceId?: string
}

/** Full component props. */
export type SettingsShellProps =
  PropsRuntime<'sidebar.settings'>
  & InjectFace<SettingsShellInjected>

/** The local instance id (always selectable, even while its host is not ready). */
const LOCAL_INSTANCE_ID = 'local'

function pluginDiagnosticText(
  state: NonNullable<BridgeServerRow['pluginDiagnostic']>['state'],
  t: (key: SettingsBridgeKey) => string,
): string {
  if (state === 'ok') return t('pluginDiagnosticOk')
  if (state === 'not-injected') return t('pluginDiagnosticNotInjected')
  if (state === 'graph-unreachable') return t('pluginDiagnosticGraphUnreachable')
  if (state === 'bundle-load-failed') return t('pluginDiagnosticBundleFailed')
  return t('pluginDiagnosticRestartRequired')
}

/**
 * Per-selection session-mount retry ledger: `failures` counts consecutive
 * child-ctx mount rejections for selection `id` (0 = none; '' = no
 * selection). The id binding gives a selection switch (or panel reopen) a
 * FRESH budget even when the previous server burned its attempts; the
 * schedule itself lives in mount-retry.ts (bounded backoff, ~15s worst-case
 * wait, fail-loud at the bound).
 */
interface MountRetryLedger {
  id: string
  failures: number
}

/** Nav glyph by section id; unknown ids fall back to the settings gear (official mirror). */
function navIcon(id: string): ReactNode {
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutline16 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

/**
 * Server selection default: the hosting instance first (even when not yet
 * connected — its placeholder text keeps the user anchored to their own
 * machine), then the first connected server, then the first row.
 */
function defaultSelection(
  servers: readonly BridgeServerRow[],
  chamberInstanceId: string | undefined,
): string | undefined {
  if (chamberInstanceId !== undefined && servers.some(server => server.id === chamberInstanceId)) {
    return chamberInstanceId
  }
  return servers.find(server => server.connected)?.id ?? servers[0]?.id
}

/** Human text for any rejection (transport or business). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Searchable server combobox: rendered through a body portal so a long roster
 * cannot be clipped by the settings panel. Offline rows remain selectable and
 * lead to the explicit unavailable placeholder. The popup flips/clamps to the
 * viewport and keeps listbox keyboard/outside-click/focus-return semantics.
 */
function ServerDropdown({
  servers, selectedId, chamberInstanceId, t, onSelect,
}: {
  servers: readonly BridgeServerRow[]
  selectedId: string | undefined
  chamberInstanceId: string | undefined
  t: (key: SettingsBridgeKey) => string
  onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState({ top: 0, left: 0, width: 280, maxHeight: 360 })
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const menuId = useId()
  const selected = servers.find(server => server.id === selectedId)
  const filteredServers = filterServerRows(servers, query)

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    setQuery('')
    if (restoreFocus) {
      queueMicrotask(() => triggerRef.current?.focus())
    }
  }, [])

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    setPosition(serverDropdownPlacement(rect, { width: window.innerWidth, height: window.innerHeight }))
  }, [])

  // Measure before paint so the body portal never flashes at (0, 0).
  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, updatePosition])

  // Outside pointerdown closes. NOTE: Escape/arrow handling lives on the
  // root div's React onKeyDown (below), NOT on a document listener — the
  // panel's own Escape listener lives on the document, and stopping the
  // native event here keeps Escape from closing the whole panel.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)
        && !popupRef.current?.contains(event.target as Node)) {
        close(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, close])

  const rove = (direction: 1 | -1): void => {
    const items = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []
    if (items.length === 0) return
    const current = Array.from(items).findIndex(item => item === document.activeElement)
    const next = current === -1
      ? (direction === 1 ? 0 : items.length - 1)
      : (current + direction + items.length) % items.length
    items[next]?.focus()
  }

  // Keyboard handling mirrors the official ModelSelect: it lives on the
  // root div so the trigger and the list share one dispatch surface.
  // ArrowDown/ArrowUp on the CLOSED dropdown expand it (rove deferred past
  // the list's commit via queueMicrotask); Escape closes the dropdown only.
  const onRootKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      if (!open) {
        setOpen(true)
        queueMicrotask(() => rove(direction))
        return
      }
      rove(direction)
    } else if (event.key === 'Escape' && open) {
      event.stopPropagation()
      close(true)
    }
  }

  // Blur close (official ModelSelect): focus leaving the whole root closes
  // the menu; relatedTarget outside root means a real leave.
  const onRootBlur = (event: ReactFocusEvent): void => {
    if (!open) return
    const next = event.relatedTarget
    if (next === null || (!rootRef.current?.contains(next as Node) && !popupRef.current?.contains(next as Node))) {
      close(false)
    }
  }

  return (
    <div className={css.dropdown} ref={rootRef} onKeyDown={onRootKeyDown} onBlur={onRootBlur}>
      <button
        ref={triggerRef}
        type="button"
        className={css.dropdownTrigger}
        aria-label={`${t('serverDropdownLabel')}: ${selected?.label ?? t('noServers')}, ${selected?.connected === true ? t('serverConnected') : t('serverOffline')}`}
        aria-haspopup="listbox"
        aria-expanded={open && servers.length > 0}
        aria-controls={open && servers.length > 0 ? menuId : undefined}
        onClick={() => {
          if (open) close(false)
          else {
            setQuery('')
            setOpen(true)
          }
        }}
      >
        <span className={clsx(css.dot, selected?.connected === true ? css.dotOk : css.dotErr)} />
        <span className={css.dropdownValue}>{selected?.label ?? t('noServers')}</span>
        <span className={css.dropdownArrow} aria-hidden="true">▾</span>
      </button>
      {open && servers.length > 0 ? (createPortal(
        <div
          ref={popupRef}
          className={css.dropdownList}
          style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
        >
          <input
            className={css.dropdownSearch}
            value={query}
            placeholder={t('serverSearchPlaceholder')}
            aria-label={t('serverSearchLabel')}
            onChange={event => setQuery(event.target.value)}
            autoFocus
          />
          <div id={menuId} ref={listRef} role="listbox" className={css.dropdownItems} aria-label={t('serverDropdownLabel')}>
          {filteredServers.map(server => {
            return (
              <button
                key={server.id}
                type="button"
                role="option"
                aria-selected={selectedId === server.id}
                aria-label={`${server.label}, ${server.connected ? t('serverConnected') : t('serverOffline')}${server.id === chamberInstanceId ? `, ${t('current')}` : ''}`}
                className={clsx(css.dropdownItem, selectedId === server.id && css.selected)}
                onClick={() => {
                  onSelect(server.id)
                  close(true)
                }}
              >
                <span className={clsx(css.dot, server.connected ? css.dotOk : css.dotErr)} />
                <span className={css.dropdownItemName}>{server.label}</span>
                <span className={css.connectionState}>{server.connected ? t('serverConnected') : t('serverOffline')}</span>
                {server.id === chamberInstanceId && <span className={css.current}>{t('current')}</span>}
                {selectedId === server.id && <span className={css.selectedCheck} aria-hidden="true">✓</span>}
              </button>
            )
          })}
          </div>
          {filteredServers.length === 0 && <p role="status" className={css.dropdownEmpty}>{t('serverSearchEmpty')}</p>}
        </div>
      , document.body) as unknown as ReactNode) : null}
    </div>
  )
}

/**
 * The modal panel: mask + panel; nav rail (server dropdown + sections) + options column.
 */
function SettingsPanel({
  servers, selectedId, sessions, sessionError, activeId, onSelectSection, onClose,
  onSelectServer, chamberInstanceId, t, connectionsT,
}: {
  servers: readonly BridgeServerRow[]
  selectedId: string | undefined
  sessions: Record<string, BridgeSession>
  sessionError: string | null
  activeId: string | undefined
  onSelectSection: (id: string) => void
  onClose: () => void
  onSelectServer: (id: string) => void
  chamberInstanceId: string | undefined
  t: (key: SettingsBridgeKey, params?: Record<string, unknown>) => string
  connectionsT: (key: string) => string
}) {
  const titleId = useId()

  // Document-level Escape closes the panel (official mirror); the server
  // dropdown's own Escape stopPropagation keeps a dropdown-open Escape from
  // reaching here.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Baseline focus management: entering the dialog lands on the close button.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  // The selected server's session (its child ctx keeps a per-server cache —
  // repeat switches are instant; an uncached switch shows the loading
  // intermediate state immediately instead of stale content).
  const selectedSession = selectedId === undefined ? undefined : sessions[selectedId]

  // The selected server's section ledger, live while the panel is open.
  // Stable subscribe/getSnapshot closures per session (no resubscribe churn
  // on unrelated re-renders — official per-face cache pattern).
  const sectionSubscribe = useMemo(
    () => (fn: () => void) => selectedSession === undefined ? () => {} : selectedSession.slots.subscribe('settings.section', fn),
    [selectedSession],
  )
  const sectionVersion = useSyncExternalStore(
    sectionSubscribe,
    useMemo(() => () => selectedSession === undefined ? 0 : selectedSession.slots.getVersion('settings.section'), [selectedSession]),
  )
  const localeRevision = useLocaleRevision(selectedSession?.locale)
  const rows: SectionNavRow[] = useMemo(
    () => (selectedSession === undefined ? [] : sectionRows(selectedSession.slots)),
    [selectedSession, sectionVersion, localeRevision],
  )
  // Active resolution (nav-active.ts): chamber-global fixed ids win; a
  // server-section id that left the ledger falls back to the first row.
  const active = resolveActiveSection(activeId, rows)
  const selected = servers.find(server => server.id === selectedId)

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <nav className={css.nav}>
          <div className={css.navTitle} id={titleId}>{t('title')}</div>
          <ServerDropdown
            servers={servers}
            selectedId={selectedId}
            chamberInstanceId={chamberInstanceId}
            t={t}
            onSelect={onSelectServer}
          />
          <div className={css.navList}>
            {rows.map(row => (
              <button
                key={row.id}
                type="button"
                className={clsx(css.navCell, row.id === active && css.active)}
                aria-current={row.id === active ? 'true' : undefined}
                onClick={() => onSelectSection(row.id)}
              >
                {navIcon(row.id)}
                <span className={css.navLabel}>{row.label}</span>
              </button>
            ))}
          </div>
          <div className={css.navDivider} />
          <div className={css.navList}>
            <button
              key={CONNECTIONS_SECTION_ID}
              type="button"
              className={clsx(css.navCell, active === CONNECTIONS_SECTION_ID && css.active)}
              aria-current={active === CONNECTIONS_SECTION_ID ? 'true' : undefined}
              onClick={() => onSelectSection(CONNECTIONS_SECTION_ID)}
            >
              <IconLinkOutline16 className={css.navIcon} size={16} />
              <span className={css.navLabel}>{t('connectionsNav')}</span>
            </button>
            <button
              key={GENERAL_SECTION_ID}
              type="button"
              className={clsx(css.navCell, active === GENERAL_SECTION_ID && css.active)}
              aria-current={active === GENERAL_SECTION_ID ? 'true' : undefined}
              onClick={() => onSelectSection(GENERAL_SECTION_ID)}
            >
              <IconSettingsOutline16 className={css.navIcon} size={16} />
              <span className={css.navLabel}>{t('generalNav')}</span>
            </button>
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            <div className={css.actions}>
              {/* The official open-document action ("打开配置文件") is a
                  HOST-MACHINE file operation (native opener): it renders for
                  the LOCAL instance only and is suppressed for remote
                  servers (the config there lives on the remote machine).
                  The whole outlet is wrapped in an ALL-CONTAINING entry
                  boundary (containAll) — this is the child-ctx → host seam:
                  ANY failure in this bridged surface (entry render, outlet
                  frame, or a BridgeAssemblyError from child-ctx content) is
                  contained to a `<div data-slot-error="settings.action">`
                  and can never abdicate the entire `sidebar.settings` entry
                  (which would fall the shell back to the official
                  SettingsRoot with no server dropdown). */}
              {selectedId === LOCAL_INSTANCE_ID && selectedSession !== undefined && (
                <BridgeEntryBoundary containAll slotKey="settings.action">
                  <BridgeOutlet
                    slots={selectedSession.slots}
                    locale={selectedSession.locale}
                    slotKey="settings.action"
                    ownerProps={{}}
                  />
                </BridgeEntryBoundary>
              )}
            </div>
            <button ref={closeButton} type="button" className={css.close} onClick={onClose}>
              <IconCloseOutline16 size={14} />
              <span className={css.hiddenLabel}>{t('close')}</span>
            </button>
          </div>
          <div className={css.options}>
            {active === 'plugins' && selected?.pluginDiagnostic !== undefined && (
              <div
                className={clsx(
                  css.pluginDiagnostic,
                  selected.pluginDiagnostic.state === 'ok' ? css.pluginDiagnosticOk : css.pluginDiagnosticProblem,
                )}
                role="status"
              >
                <strong>{t('pluginDiagnosticLabel')}：{pluginDiagnosticText(selected.pluginDiagnostic.state, t)}</strong>
                {selected.pluginDiagnostic.pluginId !== undefined && <span>{selected.pluginDiagnostic.pluginId}</span>}
                {selected.pluginDiagnostic.message !== undefined && <span>{selected.pluginDiagnostic.message}</span>}
              </div>
            )}
            {active === CONNECTIONS_SECTION_ID ? (
              /* Chamber-global connection management: independent of the
                 selected server (never refetched on server switch). */
              <ConnectionsSection t={connectionsT} />
            ) : active === GENERAL_SECTION_ID ? (
              /* Chamber-global runtime settings (design 14 D7 / design 15):
                 close-window behavior / launch at login / keep awake / quit
                 confirmation — reads the main-process chamber-settings.json,
                 independent of the selected server. The update status (design
                 11) lives inside this section too. */
              <GeneralView t={t} />
            ) : selectedId === undefined || selected === undefined ? (
              <p className={css.placeholder}>{t('noServers')}</p>
            ) : !selected.connected ? (
              <div className={css.unavailableView}>
                <p className={css.placeholder}>
                  {selected.id === LOCAL_INSTANCE_ID ? t('localNotReady') : t('targetUnavailable')}
                </p>
                <button type="button" className={css.inlineAction} onClick={() => onSelectSection(CONNECTIONS_SECTION_ID)}>
                  {t('manageConnections')}
                </button>
              </div>
            ) : sessionError !== null ? (
              <p className={css.placeholder}>{sessionError}</p>
            ) : sessions[selectedId] !== undefined ? (
              /* The selected server's own session: normal content, keyed by
                 server so a server switch remounts the wrapper and replays
                 the fade-in. */
              rows.length === 0 ? (
                <div key={selectedId} className={css.contentFade}>
                  <p className={css.placeholder}>{t('sectionsEmpty')}</p>
                </div>
              ) : (
                active !== undefined && (
                  <div key={selectedId} className={css.contentFade}>
                    {/* Child-ctx → host seam: the selected server's official
                        section content. containAll keeps EVERY child-ctx
                        failure (an ordinary render crash or a
                        BridgeAssemblyError from the bridged entries — e.g.
                        renderSlot for an undeclared slot, a missing locale
                        face) inside a `<div data-slot-error="settings.section">`;
                        it can never escape to abdicate the chamber-owned
                        shell (falling back to the official SettingsRoot). */}
                    <BridgeEntryBoundary containAll slotKey="settings.section">
                      <BridgeOutlet
                        slots={sessions[selectedId].slots}
                        locale={sessions[selectedId].locale}
                        slotKey="settings.section"
                        ownerProps={{ close: onClose }}
                        opts={{ only: active }}
                      />
                    </BridgeEntryBoundary>
                  </div>
                )
              )
            ) : (
              /* Uncached server (first visit, or a slow target): switch to
                 the loading intermediate state IMMEDIATELY — honest signal,
                 no stale content wait; the per-server cache makes repeat
                 switches instant. The distinct key remounts the wrapper so
                 the ready content below replays its fade-in. */
              <div key={`loading-${selectedId}`} className={css.contentFade}>
                <div className={css.loadingView}>
                  <IconLoadingOutline16 className={css.loadingSpinner} size={16} aria-hidden="true" />
                  <p className={css.placeholder}>{t('loadingServers')}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Render the settings trigger and the bridged panel.
 * @param props - composed slot props (sidebar.settings seat).
 */
export function SettingsShell(props: SettingsShellProps) {
  // The ambient slot face is erased (Record<string, unknown>); the real
  // sidebar.settings owner share is `{ wide: boolean }`.
  const wide = props.wide === true
  const { t, connectionsT, chamberInstanceId } = props
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [servers, setServers] = useState<BridgeServerRow[]>(() => getServers())
  const [selectedId, setSelectedId] = useState<string | undefined>(() =>
    defaultSelection(getServers(), chamberInstanceId))
  // Per-server child ctx cache (keep-alive while the panel is open): repeat
  // switches to a visited server are instant (no re-assembly, no re-read).
  const [sessions, setSessions] = useState<Record<string, BridgeSession>>({})
  const sessionsRef = useRef<Record<string, BridgeSession>>({})
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  // Auto-retry ledger for the CURRENT selection's session mount (bounded
  // backoff — see MountRetryLedger / mount-retry.ts). Bumping the state
  // re-runs the mount effect, which re-attempts the SAME mount path.
  const [mountRetry, setMountRetry] = useState<MountRetryLedger>({ id: '', failures: 0 })

  useEffect(() => subscribeServers(() => setServers(getServers())), [])

  // The App layer publishes the first projection asynchronously; if the
  // settings trigger opened first, backfill the selection once servers
  // arrive. Also re-anchors when the selected server left the projection.
  useEffect(() => {
    if (servers.length === 0) return
    if (selectedId === undefined || !servers.some(server => server.id === selectedId)) {
      setSelectedId(defaultSelection(servers, chamberInstanceId))
    }
  }, [servers, selectedId, chamberInstanceId])

  // NOTE: no active-reset on server switch — the connections page is
  // server-independent and stays put; a section id that left the new
  // server's ledger falls back to its first row via the derived `active`.
  const selected = servers.find(server => server.id === selectedId)
  const selectedConnected = selected?.connected ?? false

  // Child ctx keep-alive: sessions assemble lazily per server while the
  // panel is open; closing (or an unreachable target) releases everything.
  // Switching to an UNCACHED server shows the loading intermediate state
  // IMMEDIATELY (the user never waits on stale content — the cache only
  // makes repeat switches instant).
  const releaseAllSessions = useCallback(() => {
    const all = sessionsRef.current
    sessionsRef.current = {}
    for (const session of Object.values(all)) void session.dispose().catch(() => {})
  }, [])

  // Release on component unmount (slot re-render / host boot teardown) —
  // never leak child contexts outside the panel lifetime.
  useEffect(() => () => { releaseAllSessions() }, [releaseAllSessions])

  useEffect(() => {
    if (!open || selectedId === undefined) {
      // Panel closed (or the selection is being re-anchored): release every
      // child ctx and clear the projection-facing state. The retry ledger
      // resets too — a reopen is a fresh context (no-op when already reset).
      releaseAllSessions()
      setSessions({})
      setSessionError(null)
      setMountRetry(current => current.id === selectedId && current.failures === 0
        ? current
        : { id: selectedId ?? '', failures: 0 })
      return
    }
    if (!selectedConnected) {
      // The SELECTED target became unreachable: release only its session —
      // other servers' cached sessions survive a tunnel blip. The retry
      // ledger resets too: a connection transition is a fresh context, so an
      // exhausted budget from before the blip must not suppress retries
      // after the tunnel is back.
      const dropped = sessionsRef.current[selectedId]
      if (dropped !== undefined) {
        const next = { ...sessionsRef.current }
        delete next[selectedId]
        sessionsRef.current = next
        setSessions(next)
        void dropped.dispose().catch(() => {})
      }
      setSessionError(null)
      setMountRetry(current => current.id === selectedId && current.failures === 0
        ? current
        : { id: selectedId, failures: 0 })
      return
    }
    // Already mounted for this selection: nothing to do (cache hit) — but
    // clear any error left by a PREVIOUS server's failed mount so the
    // cached content is never shadowed by a foreign error. The ledger resets
    // as well (content is live again: any later failure starts fresh).
    if (sessionsRef.current[selectedId] !== undefined) {
      setSessionError(null)
      setMountRetry(current => current.id === selectedId && current.failures === 0
        ? current
        : { id: selectedId, failures: 0 })
      return
    }
    let cancelled = false
    // Explicit DOM timer id: `ReturnType<typeof window.setTimeout>` picks the
    // node global overload via the `Window & typeof globalThis` intersection.
    let retryTimer: number | undefined
    setSessionError(null)
    mountBridgeSession(selectedId).then((mounted) => {
      if (cancelled) {
        void mounted.dispose().catch(() => {})
        return
      }
      sessionsRef.current = { ...sessionsRef.current, [selectedId]: mounted }
      setSessions(sessionsRef.current)
      // Mount succeeded: reset the retry ledger (no-op when already reset) —
      // a LATER failure starts a fresh budget instead of inheriting this
      // one's burned attempts.
      setMountRetry(current => current.id === selectedId && current.failures === 0
        ? current
        : { id: selectedId, failures: 0 })
    }).catch((error: unknown) => {
      if (cancelled) return
      setSessionError(errorMessage(error))
      // Bounded-backoff auto-retry of the SAME mount path (issue 6 彻底修复,
      // W2 residual gap P2): a transient not-ready burst (the selected host
      // mid-boot/restart) can reject the child-ctx mount, and the error
      // state had NO auto-recovery while the panel stayed open (only
      // re-click / connection transition / reopen recovered) — which could
      // strand the settings content in error. Retry with a capped schedule
      // (1s, 2s, 4s, 8s — ~15s worst-case wait; see mount-retry.ts for the
      // rationale) so the content recovers by itself once the target is
      // ready. The budget is per-selection and bounded (MOUNT_RETRY_ATTEMPTS
      // total attempts), so a genuinely dead target still fails loud. Every
      // exit path — success, unmount, panel close, selection change,
      // connection transition — clears the pending timer (cleanup below).
      const failures = mountRetry.id === selectedId ? mountRetry.failures + 1 : 1
      const delay = nextMountRetryDelayMs(failures)
      if (delay !== null) {
        retryTimer = window.setTimeout(() => {
          // Bump the ledger (always a fresh object, so the effect re-runs)
          // → the SAME mount path is re-attempted. The ledger read in the
          // NEXT catch is this bumped value, so the backoff advances
          // 1s → 2s → 4s → 8s across consecutive failures.
          if (!cancelled) setMountRetry({ id: selectedId, failures })
        }, delay)
      }
    })
    return () => {
      cancelled = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [open, selectedId, selectedConnected, retryNonce, mountRetry, releaseAllSessions])

  const selectServer = useCallback((id: string) => {
    // Offline rows remain selectable: the content column owns the explicit
    // unavailable placeholder and the route to connection management.
    if (id === selectedId && sessionError !== null) {
      // Retry path: bump the nonce so the mount effect re-runs without
      // flashing an undefined selection (no noServers frame). The retry
      // ledger resets too — a user-initiated retry restarts the auto-retry
      // budget (no-op when already reset).
      setMountRetry(current => current.id === id && current.failures === 0 ? current : { id, failures: 0 })
      setRetryNonce(nonce => nonce + 1)
      return
    }
    setSelectedId(id)
  }, [selectedId, sessionError])

  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])

  return (
    <>
      <button
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(true) }}
      >
        {wide ? <IconSettingsOutline16 size={16} /> : <IconSettingsOutline14 size={18} />}
        {wide && <span className={css.triggerLabel}>{t('trigger')}</span>}
      </button>
      {open && (
        <SettingsPanel
          servers={servers}
          selectedId={selectedId}
          sessions={sessions}
          sessionError={sessionError}
          activeId={activeId}
          onSelectSection={setActiveId}
          onClose={close}
          onSelectServer={selectServer}
          chamberInstanceId={chamberInstanceId}
          t={t}
          connectionsT={connectionsT}
        />
      )}
    </>
  )
}
