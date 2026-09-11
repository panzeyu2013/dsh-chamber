/**
 * Chamber settings shell — replaces the official SettingsRoot registration
 * in the `sidebar.settings` slot (registered at a lower priority so the
 * official shell is shadowed, not conflicted). The sidebar-foot trigger plus
 * the centered modal panel keep the official panel geometry (figma
 * 501:29947), but the nav rail is re-aimed: a SERVER dropdown on top
 * (local default; searchable portal, all rows selectable, connection state
 * colored green/red) over the SELECTED server's OWN settings sections. The
 * options column renders that server's own ledger through this panel — the
 * source's own boot ctx, its own registrations, its own renderer-bound seats
 * (settings-source-face.ts, design 05 §5 2026-12 完整桥接修订). The
 * chamber-global connections surface is a FIXED nav entry below a divider —
 * it never follows the selected server and renders the official
 * ConnectionsSection as a full options-column view when active.
 *
 * Chrome stays chamber-owned: the header title and close button are
 * self-built (the official `settings.header`/`close` seats are chrome, not
 * content). Every section's config fact still lives on the selected
 * instance's host machine.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  IconAgentPresetOutline16, IconChevronDownOutline14, IconCloseOutline16, IconDataOutline16, IconLinkOutline16,
  IconLoadingOutline16, IconPersonalizationOutline16, IconSettingsOutline14, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsBridgeKey } from '../locales.ts'
import { ConnectionsSection } from '@dsh-chamber/dsh-chamber-client-ui-settings-connections/section'
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
  chamberBridge, isChannelClassDiagnostic, recheckPluginGraphDiagnostic,
} from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import { sectionRows } from './section-rows.ts'
import { nestedModalOwnsEscape } from './escape-owner.ts'
import {
  getSettingsSourceFace, publishSettingsSourceSeats, settingsSourceFaceReady,
  settingsSourceFaceRevision, subscribeSettingsSourceFaces,
  type RenderableSettingsSourceFace,
} from './settings-source-face.ts'
import { BridgeEntryBoundary, BridgeOutlet, useLocaleRevision } from './bridge-outlet.tsx'
import css from './SettingsShell.module.css'
import {
  filterServerRows,
  serverDropdownPlacement,
} from './server-selector.ts'

/** Registration-side business face for the chamber settings shell. */
export interface SettingsShellInjected {
  /** Bound translate over the shell's own dictionary namespace ({param} interpolation supported). */
  t: (key: SettingsBridgeKey, params?: Record<string, unknown>) => string
  /** Bound translate over the connections section's dictionary ('dsh-chamber.settings.connections'). */
  connectionsT: (key: string) => string
  /** The hosting boot's instance id ('local' | '<kind>-<id>'), when known. */
  chamberInstanceId?: string
}

/** Full component props. */
export type SettingsShellProps =
  PropsRuntime<'sidebar.settings'>
  & InjectFace<SettingsShellInjected>

/** The local instance id (always selectable, even while its host is not ready). */
const LOCAL_INSTANCE_ID = 'local'

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
  const searchRef = useRef<HTMLInputElement | null>(null)
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

  // Measure before paint so the body portal never flashes at (0, 0), and move
  // focus to the search input. Focus must NOT use the `autoFocus` attribute:
  // React runs `autoFocus` in the MUTATION phase, BEFORE the portal's
  // `popupRef` is attached (refs attach in the LAYOUT phase). The trigger's
  // resulting blur would then be misread by onRootBlur as "focus left the
  // dropdown" (popupRef.current is still null), so the list would close the
  // instant it opens. Focusing here — after refs are attached — lets
  // onRootBlur see the input inside the portal and keeps the list open.
  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    searchRef.current?.focus()
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
        {/* 统一下拉箭头（2026-12）：与运行时 select / 连接表单下拉同一图标
            词汇（IconChevronDownOutline14）；右缘 inset 由 trigger 的
            padding 决定（10px），与文字左缘对称。 */}
        <span className={css.dropdownArrow} aria-hidden="true">
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open && servers.length > 0 ? (createPortal(
        <div
          ref={popupRef}
          className={css.dropdownList}
          style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
        >
          <input
            ref={searchRef}
            className={css.dropdownSearch}
            value={query}
            placeholder={t('serverSearchPlaceholder')}
            aria-label={t('serverSearchLabel')}
            onChange={event => setQuery(event.target.value)}
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
  servers, selectedId, face, faceStarting, activeId, onSelectSection, onClose,
  onSelectServer, chamberInstanceId, t, connectionsT,
}: {
  servers: readonly BridgeServerRow[]
  selectedId: string | undefined
  /** The selected source's own settings face (its boot-ctx ledger + seats), when renderable. */
  face: RenderableSettingsSourceFace | undefined
  /** Selected source is connected but its shell has not published a face yet (booting). */
  faceStarting: boolean
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
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // A modal OTHER than this panel owns Escape while it is open (nested
      // official Modal overlays incl. the connections plugin dialogs, or
      // another layer's overlay): closing the whole panel underneath it would
      // swallow the modal's own close intent (2026 dev-QA observation). The
      // panel itself IS aria-modal, so the panel NODE must be excluded by
      // identity — a blanket `[aria-modal="true"]` query self-matched and made
      // Escape a no-op (2026-09-11 fix; see ./escape-owner.ts).
      if (nestedModalOwnsEscape(document.querySelectorAll('[aria-modal="true"]'), panelRef.current)) return
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Baseline focus management: entering the dialog lands on the close button.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  const selected = servers.find(server => server.id === selectedId)

  // The selected server's OWN section ledger — the registry of that
  // instance's boot ctx, live while the panel is open. Stable
  // subscribe/getSnapshot closures per face (no resubscribe churn on
  // unrelated re-renders — official per-face cache pattern).
  const sourceSlots = face?.slots
  const sectionSubscribe = useMemo(
    () => (fn: () => void) => sourceSlots === undefined ? () => {} : sourceSlots.subscribe('settings.section', fn),
    [sourceSlots],
  )
  const sectionVersion = useSyncExternalStore(
    sectionSubscribe,
    useMemo(() => () => sourceSlots === undefined ? 0 : sourceSlots.getVersion('settings.section'), [sourceSlots]),
  )
  const localeRevision = useLocaleRevision(face?.locale)
  const rows: SectionNavRow[] = useMemo(
    () => (sourceSlots === undefined ? [] : sectionRows(sourceSlots)),
    [sourceSlots, sectionVersion, localeRevision],
  )
  // Active resolution (nav-active.ts): chamber-global fixed ids win; a
  // server-section id that left the ledger falls back to the first row.
  const active = resolveActiveSection(activeId, rows)
  // Header context (2026-11): the active section label on the left; the
  // selected server name sits under it ONLY for server-owned content (the
  // chamber-global 连接/通用 pages are server-independent — implying a server
  // there would mislead). Fills the header that used to sit empty for remote
  // and unavailable states.
  const headerTitle = active === CONNECTIONS_SECTION_ID
    ? t('connectionsNav')
    : active === GENERAL_SECTION_ID
      ? t('generalNav')
      : rows.find(row => row.id === active)?.label ?? t('title')
  // The header sub-line names the selected server for SERVER-OWNED content
  // only (the chamber-global connections/general pages are server-independent
  // — implying a server there would mislead).
  const headerSub = active !== CONNECTIONS_SECTION_ID && active !== GENERAL_SECTION_ID
    ? selected?.label ?? ''
    : ''
  // Per-source client-plugin runtime diagnostics, keyed by source id
  // ('local' | '<kind>-<id>'), handed to the chamber-global connections surface.
  // The diagnostic is a chamber-owned fact (design 09) and belongs in the
  // connections page, NOT on top of the official dsh「插件」section.
  const pluginDiagnostics = useMemo(() => {
    const map: Record<string, BridgeServerRow['pluginDiagnostic']> = {}
    for (const server of servers) map[server.id] = server.pluginDiagnostic
    return map
  }, [servers])

  // CHANNEL-class diagnostic self-heal pass (design 09 §3.5): the recorded
  // diagnostic describes the source's LAST shell boot; a 404 `not-injected` /
  // `graph-unreachable` can heal without a re-boot (e.g. the gateway's
  // managed dsh restarted with the desktop-synced chamber host packages right
  // after the boot that recorded the 404). While the connections page is
  // open, re-check every source whose diagnostic is a channel fact — once per
  // activation and once per channel-diagnostic change (the effect keys on a
  // channel-class signature, never on unrelated roster republishes — another
  // server's session/phase flips cannot re-probe a still-broken source).
  // Loop-freedom comes from the recheck contract itself: it writes back only
  // on a verdict STATE change, so a still-broken channel re-verifies silently
  // and the pass cannot re-trigger through its own writes; the in-flight set
  // only collapses republish races.
  const channelDiagnosticsSignature = useMemo(
    () => servers
      .filter(server => server.pluginDiagnostic !== undefined && isChannelClassDiagnostic(server.pluginDiagnostic.state))
      .map(server => `${server.id}:${server.pluginDiagnostic?.state}:${server.pluginDiagnostic?.message ?? ''}`)
      .join('|'),
    [servers],
  )
  const recheckInFlight = useRef<ReadonlySet<string>>(new Set())
  const activeConnections = active === CONNECTIONS_SECTION_ID
  useEffect(() => {
    if (!activeConnections) return
    for (const server of servers) {
      const diagnostic = server.pluginDiagnostic
      if (diagnostic === undefined || !isChannelClassDiagnostic(diagnostic.state)) continue
      if (recheckInFlight.current.has(server.id)) continue
      const next = new Set(recheckInFlight.current)
      next.add(server.id)
      recheckInFlight.current = next
      void recheckPluginGraphDiagnostic(server.id).finally(() => {
        const after = new Set(recheckInFlight.current)
        after.delete(server.id)
        recheckInFlight.current = after
      })
    }
  }, [activeConnections, channelDiagnosticsSignature])

  // Explicit dialog-triggered rechecks (plugin dialogs ask for their own
  // source on open/refresh) — same host-owned write-back.
  const recheckDiagnostic = useCallback((sourceId: string): void => {
    void recheckPluginGraphDiagnostic(sourceId)
  }, [])

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div ref={panelRef} className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
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
            <div className={css.headerText}>
              <span className={css.headerTitle}>{headerTitle}</span>
              {headerSub !== '' && <span className={css.headerSub}>{headerSub}</span>}
            </div>
            <div className={css.actions}>
              {/* The official open-document action ("打开配置文件") is a
                  HOST-MACHINE file operation (native opener): it renders for
                  the LOCAL instance only and is suppressed for remote
                  servers (the config there lives on the remote machine). The
                  outlet is wrapped in an ALL-CONTAINING entry boundary
                  (containAll): a failure in that foreign entry is contained to
                  a `<div data-slot-error="settings.action">` and can never
                  abdicate the chamber-owned `sidebar.settings` entry (which
                  would fall the shell back to the official SettingsRoot with
                  no server dropdown). */}
              {selectedId === LOCAL_INSTANCE_ID && face !== undefined && (
                <BridgeEntryBoundary containAll slotKey="settings.action">
                  <BridgeOutlet
                    slots={face.slots}
                    locale={face.locale}
                    standard={face.seats}
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
            {active === CONNECTIONS_SECTION_ID ? (
              /* Chamber-global connection management: independent of the
                 selected server (never refetched on server switch), with that
                 server's own plugin-graph health rendered inside its card. */
              <ConnectionsSection
                t={connectionsT}
                pluginDiagnostics={pluginDiagnostics}
                onRecheckDiagnostic={recheckDiagnostic}
              />
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
              /* role="alert"：该分支是"插入即带内容"的整块替换，polite 的
                 status 不会被播报（2026-12 复查 MINOR）。 */
              <div className={css.unavailableView} role="alert">
                <p className={css.placeholder}>
                  {selected.id === LOCAL_INSTANCE_ID
                    ? t('localNotReady')
                    : selected.managedRuntimeDown === true
                      // 2026-12（问题 B）：隧道正常、托管 dsh 停机——"不可达"
                      // 的说法不准确，改说清是哪一层停了。
                      ? t('managedDshDown')
                      : selected.kind === 'gateway'
                        && (selected.phase === 'starting' || selected.phase === 'restarting')
                        // 瞬态同理：不是"不可达"，只是还没起来（2026-12 复查 MINOR）。
                        ? t('managedDshStarting')
                        : t('targetUnavailable')}
                </p>
                <button type="button" className={css.inlineAction} onClick={() => onSelectSection(CONNECTIONS_SECTION_ID)}>
                  {t('manageConnections')}
                </button>
              </div>
            ) : face !== undefined ? (
              /* The selected server's own ledger: normal content, keyed by
                 server so a server switch remounts the wrapper and replays
                 the fade-in. */
              rows.length === 0 ? (
                <div key={selectedId} className={css.contentFade}>
                  <p className={css.placeholder}>{t('sectionsEmpty')}</p>
                </div>
              ) : (
                active !== undefined && (
                  <div key={selectedId} className={css.contentFade}>
                    {/* The selected server's OWN section content, rendered
                        with that server's own renderer-bound seats. containAll
                        keeps every failure of a foreign entry (an ordinary
                        render crash or a BridgeAssemblyError from a miswired
                        entry — e.g. renderSlot for an undeclared slot) inside a
                        `<div data-slot-error="settings.section">`; it can never
                        escape to abdicate the chamber-owned shell (falling back
                        to the official SettingsRoot). */}
                    <BridgeEntryBoundary containAll slotKey="settings.section">
                      <BridgeOutlet
                        slots={face.slots}
                        locale={face.locale}
                        standard={face.seats}
                        slotKey="settings.section"
                        ownerProps={{ close: onClose }}
                        opts={{ only: active }}
                      />
                    </BridgeEntryBoundary>
                  </div>
                )
              )
            ) : (
              /* Connected, but that server's shell has not published its
                 settings face yet: its frontend is still booting (the App
                 mounts it for this panel — see chamberBridge.setSettingsTarget).
                 The distinct key remounts the wrapper so the ready content
                 replays its fade-in. */
              <div key={`loading-${selectedId}`} className={css.contentFade}>
                <div className={css.loadingView}>
                  <IconLoadingOutline16 className={css.loadingSpinner} size={16} aria-hidden="true" />
                  <p className={css.placeholder}>{faceStarting ? t('sourceStarting') : t('loadingServers')}</p>
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
 * Render the settings trigger and the panel.
 *
 * Complete-bridge contract (design 05 §5, 2026-12 修订): the panel renders the
 * SELECTED source's OWN boot-ctx `settings.section` ledger with that source's
 * OWN renderer-bound seats. Two things make that possible and both live here:
 *
 * 1. this component is that source's `sidebar.settings` occupant, so the
 *    renderer hands it the complete standard kit — it publishes those seats
 *    under its own `chamberInstanceId` (`publishSettingsSourceSeats`);
 * 2. it asks the App layer to keep the selected source's shell MOUNTED while
 *    the panel is open (`chamberBridge.setSettingsTarget`) — the mounted shell
 *    IS the surface, and a closed panel releases the hold.
 *
 * Nothing is mounted twice and no service is stubbed, so a third-party plugin
 * that is active in that instance's own frontend is active here too, with its
 * real `remote`, live settings events and real session/workspace/resource
 * seats.
 * @param props - composed slot props (sidebar.settings seat).
 */
export function SettingsShell(props: SettingsShellProps) {
  // The ambient slot face is erased (Record<string, unknown>); the real
  // sidebar.settings owner share is `{ wide: boolean }` and the standard seats
  // arrive beside it (useSessions / useWorkspaces / usePanelInfo /
  // useResource / useSessionPendingInteraction / root props).
  const wide = props.wide === true
  const { t, connectionsT, chamberInstanceId } = props
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [servers, setServers] = useState<BridgeServerRow[]>(() => getServers())
  const [selectedId, setSelectedId] = useState<string | undefined>(() =>
    defaultSelection(getServers(), chamberInstanceId))

  useEffect(() => subscribeServers(() => setServers(getServers())), [])

  // Seat publication: the seats are stable per (binding, source), so the effect
  // re-publishes only when the renderer swaps one (locale/root binding change)
  // — not on every render.
  const useSessions = props.useSessions
  const useWorkspaces = props.useWorkspaces
  const usePanelInfo = props.usePanelInfo
  const useResource = props.useResource
  const useSessionPendingInteraction = props.useSessionPendingInteraction
  const rootProps = useMemo(() => {
    const base = props.chamberFileApiBase
    return base === undefined ? undefined : { chamberFileApiBase: base }
  }, [props.chamberFileApiBase])
  useEffect(() => {
    if (chamberInstanceId === undefined) return () => {}
    return publishSettingsSourceSeats(chamberInstanceId, {
      ...(useSessions === undefined ? {} : { useSessions }),
      ...(useWorkspaces === undefined ? {} : { useWorkspaces }),
      ...(usePanelInfo === undefined ? {} : { usePanelInfo }),
      ...(useResource === undefined ? {} : { useResource }),
      ...(useSessionPendingInteraction === undefined ? {} : { useSessionPendingInteraction }),
      ...(rootProps === undefined ? {} : { props: rootProps }),
    })
  }, [
    chamberInstanceId, useSessions, useWorkspaces, usePanelInfo, useResource,
    useSessionPendingInteraction, rootProps,
  ])

  // The App layer publishes the first projection asynchronously; if the
  // settings trigger opened first, backfill the selection once servers
  // arrive. Also re-anchors when the selected server left the projection.
  useEffect(() => {
    if (servers.length === 0) return
    if (selectedId === undefined || !servers.some(server => server.id === selectedId)) {
      setSelectedId(defaultSelection(servers, chamberInstanceId))
    }
  }, [servers, selectedId, chamberInstanceId])

  // Keep the selected source mounted while the panel is open (and release the
  // hold on close/unmount): an unmounted source has no ledger to render.
  useEffect(() => {
    if (!open) return () => {}
    chamberBridge.setSettingsTarget(selectedId)
    return () => { chamberBridge.setSettingsTarget(undefined) }
  }, [open, selectedId])

  // NOTE: no active-reset on server switch — the connections page is
  // server-independent and stays put; a section id that left the new
  // server's ledger falls back to its first row via the derived `active`.
  const selected = servers.find(server => server.id === selectedId)
  const selectedConnected = selected?.connected ?? false

  // Face subscription: the registry revision is the uSES snapshot.
  useSyncExternalStore(subscribeSettingsSourceFaces, settingsSourceFaceRevision)
  const face = getSettingsSourceFace(selectedId)
  // A face is renderable only for the exact authoritative source incarnation:
  // delete/re-add or a transport-identity edit replaces the source under the
  // same id, and the previous ctx's ledger must never render for the new one.
  const faceMatchesIncarnation = face !== undefined
    && face.sourceFingerprint !== undefined
    && face.sourceFingerprint === selected?.sourceFingerprint
  const usableFace = faceMatchesIncarnation && settingsSourceFaceReady(face) ? face : undefined

  const selectServer = useCallback((id: string) => { setSelectedId(id) }, [])

  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])

  return (
    <>
      <button
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        // The rail (narrow) form renders the icon only, so the accessible name
        // must come from the label the official trigger slot also carries
        // (vendor SettingsRoot.tsx: `aria-label={t('trigger')}`).
        aria-label={t('trigger')}
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
          face={usableFace}
          faceStarting={selectedConnected && usableFace === undefined}
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
