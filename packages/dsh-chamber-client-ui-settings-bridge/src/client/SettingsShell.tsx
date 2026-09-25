/**
 * Chamber settings shell — replaces the official SettingsRoot registration in the
 * `sidebar.settings` slot (lower priority: the official shell is shadowed, not
 * conflicted). The nav rail is re-aimed: a searchable SERVER dropdown over the
 * SELECTED server's OWN settings sections, rendered through that source's own boot
 * ctx, registrations and renderer-bound seats (settings-source-face.ts, design 05
 * §5). The chamber-global connections surface is a FIXED nav entry below a divider —
 * it never follows the selected server. Chrome stays chamber-owned.
 *
 * The shell also coordinates its OWN ctx's `settings.onboarding` stage
 * (./onboarding.ts): the active-view fact gates MOUNTING only, the completed set
 * resets on the sessions fact alone.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Button, IconAgentPresetOutlineRegular, IconChevronDownOutlineRegular, IconCloseOutlineRegular, IconDataOutlineRegular, IconLinkOutlineRegular, IconLoadingOutlineRegular, IconPersonalizationOutlineRegular, IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
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
} from '@dsh-chamber/dsh-chamber-client-core'
import { sectionRows } from './section-rows.ts'
import { nestedModalOwnsEscape } from './escape-owner.ts'
import {
  getSettingsSourceFace, publishSettingsSourceSeats, settingsSourceFaceReady,
  settingsSourceFaceRevision, subscribeSettingsSourceFaces,
  type RenderableSettingsSourceFace,
} from './settings-source-face.ts'
import { BridgeEntryBoundary, BridgeOutlet, useLocaleRevision } from './bridge-outlet.tsx'
import type { BridgeStandardSeats } from './bridge-outlet.tsx'
import {
  onboardingStage, sessionsSeatOf,
} from './onboarding.ts'
import { useActiveView, useOnboardingActive, useOnboardingSteps } from './onboarding-hooks.ts'
import css from './SettingsShell.module.css'
import {
  filterServerRows,
  serverDropdownPlacement,
} from './server-selector.ts'

export interface SettingsShellInjected {
  /** Bound translate over the shell's own dictionary namespace ({param} interpolation supported). */
  t: (key: SettingsBridgeKey, params?: Record<string, unknown>) => string
  /** Bound translate over the connections section's dictionary ('dsh-chamber.settings.connections'). */
  connectionsT: (key: string) => string
  /** The hosting boot's instance id ('local' | '<kind>-<id>'), when known. */
  chamberInstanceId?: string
}

export type SettingsShellProps =
  PropsRuntime<'sidebar.settings'>
  & InjectFace<SettingsShellInjected>

/** The local instance id (always selectable, even while its host is not ready). */
const LOCAL_INSTANCE_ID = 'local'

/** Nav glyph by section id; unknown ids fall back to the settings gear (official mirror). */
function navIcon(id: string): ReactNode {
  if (id === 'models') return <IconDataOutlineRegular className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutlineRegular className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutlineRegular className={css.navIcon} size={16} />
  return <IconSettingsOutlineRegular className={css.navIcon} size={16} />
}

/**
 * Server selection default: the hosting instance first (even when not yet connected —
 * the placeholder keeps the user anchored to their own machine), then the first
 * connected server, then the first row.
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
 * Searchable server combobox rendered through a body portal so a long roster cannot be
 * clipped: offline rows stay selectable and lead to the explicit unavailable placeholder;
 * the popup flips/clamps to the viewport and keeps listbox
 * keyboard/outside-click/focus-return semantics.
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

  // Measure before paint so the portal never flashes at (0, 0), then focus the search
  // input. Focus must NOT use `autoFocus`: React runs it in the MUTATION phase, BEFORE
  // the portal's `popupRef` attaches (LAYOUT), so onRootBlur would read the trigger's
  // blur as "focus left" and close the list the instant it opens.
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

  // Outside pointerdown closes. Escape/arrow handling lives on the root div's
  // React onKeyDown (below), NOT on a document listener: stopping the native
  // event here keeps Escape from closing the whole panel.
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

  // Keyboard handling mirrors the official ModelSelect and lives on the root div
  // so trigger and list share one dispatch surface. ArrowDown/ArrowUp on the
  // CLOSED dropdown expand it (rove deferred past the list's commit via
  // queueMicrotask); Escape closes the dropdown only.
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
        {/* 统一下拉箭头：与运行时 select / 连接表单下拉同一图标词汇
            （IconChevronDownOutlineRegular）；右缘 inset 由 trigger padding 决定（10px）。 */}
        <span className={css.dropdownArrow} aria-hidden="true">
          <IconChevronDownOutlineRegular />
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
                // WebKit does not focus a <button> on mouse-down, so pressing this row
                // would blur the search input with `relatedTarget: null`; onRootBlur
                // would then close the portal and unmount the row BEFORE the click
                // landed. Suppressing the default keeps the row alive until the click.
                onMouseDown={event => event.preventDefault()}
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

  // Document-level Escape closes the panel; the dropdown's own stopPropagation
  // keeps a dropdown-open Escape from reaching here.
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // A modal OTHER than this panel owns Escape while it is open (nested official
      // Modal overlays): closing the panel underneath it would swallow its close
      // intent. The panel NODE must be excluded by identity — a blanket
      // `[aria-modal="true"]` query self-matches and makes Escape a no-op.
      if (nestedModalOwnsEscape(document.querySelectorAll('[aria-modal="true"]'), panelRef.current)) return
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  const selected = servers.find(server => server.id === selectedId)

  // The selected server's OWN section ledger (that boot ctx's registry, live
  // while the panel is open); stable subscribe/getSnapshot closures per face.
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
  // Active resolution (nav-active.ts): chamber-global ids win; a server-section id that left the ledger falls back to the first row.
  const active = resolveActiveSection(activeId, rows)
  // Header context: the selected server name sits under the header ONLY for
  // server-owned content (chamber-global pages are server-independent — implying
  // a server there would mislead). The active section's TITLE is not repeated:
  // every content branch renders its own heading, one title per page.
  const headerSub = active !== CONNECTIONS_SECTION_ID && active !== GENERAL_SECTION_ID
    ? selected?.label ?? ''
    : ''
  // Per-source client-plugin runtime diagnostics, keyed by source id
  // ('local' | '<kind>-<id>'), handed to the chamber-global connections surface:
  // a chamber-owned fact, so it belongs in the connections page, NOT on top of
  // the official dsh「插件」section.
  const pluginDiagnostics = useMemo(() => {
    const map: Record<string, BridgeServerRow['pluginDiagnostic']> = {}
    for (const server of servers) map[server.id] = server.pluginDiagnostic
    return map
  }, [servers])

  // Per-source settled-boot gaps, keyed like the diagnostics: the graph channel
  // can answer `ok` while a surface never registered, so the card needs this
  // SEPARATE fact to avoid claiming everything is fine next to a missing body.
  const bootGaps = useMemo(() => {
    const map: Record<string, BridgeServerRow['bootGap']> = {}
    for (const server of servers) map[server.id] = server.bootGap
    return map
  }, [servers])

  // CHANNEL-class diagnostic self-heal pass: the recorded diagnostic describes the
  // source's LAST boot, and a 404 `not-injected` / `graph-unreachable` can heal
  // without a re-boot (e.g. the managed dsh restarted with the synced host packages
  // right after the boot that recorded it). While the connections page is open,
  // re-check every source whose diagnostic is a channel fact — once per activation and
  // once per channel-diagnostic change. Loop-freedom comes from the recheck contract
  // itself: it writes back only on a verdict STATE change.
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

  // Explicit dialog-triggered rechecks (plugin dialogs ask for their own source on open/refresh) — same host-owned write-back.
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
              <IconLinkOutlineRegular className={css.navIcon} size={16} />
              <span className={css.navLabel}>{t('connectionsNav')}</span>
            </button>
            <button
              key={GENERAL_SECTION_ID}
              type="button"
              className={clsx(css.navCell, active === GENERAL_SECTION_ID && css.active)}
              aria-current={active === GENERAL_SECTION_ID ? 'true' : undefined}
              onClick={() => onSelectSection(GENERAL_SECTION_ID)}
            >
              <IconSettingsOutlineRegular className={css.navIcon} size={16} />
              <span className={css.navLabel}>{t('clientNav')}</span>
            </button>
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            {/* Server sub-line (the duplicated page title is dropped). */}
            {headerSub !== '' && <span className={css.headerSub}>{headerSub}</span>}
            <div className={css.actions}>
              {/* The official open-document action ("打开配置文件") is a HOST-MACHINE
                  operation (native opener): LOCAL instance only, suppressed for remote
                  servers. The outlet is wrapped in containAll so a foreign entry's
                  failure can never abdicate the chamber-owned `sidebar.settings` entry
                  (which would fall back to the official SettingsRoot). */}
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
              <IconCloseOutlineRegular size={14} />
              <span className={css.hiddenLabel}>{t('close')}</span>
            </button>
          </div>
          <div className={css.options}>
            {active === CONNECTIONS_SECTION_ID ? (
              /* Chamber-global connection management: independent of the selected
                 server (never refetched on switch), with that server's own
                 plugin-graph health rendered inside its card. */
              <ConnectionsSection
                t={connectionsT}
                pluginDiagnostics={pluginDiagnostics}
                bootGaps={bootGaps}
                onRecheckDiagnostic={recheckDiagnostic}
              />
            ) : active === GENERAL_SECTION_ID ? (
              /* Chamber-global runtime settings: close-window behavior / launch
                 at login / keep awake / quit confirmation — reads the
                 main-process chamber-settings.json, independent of the selected
                 server. The update status lives inside this section too. */
              <GeneralView t={t} />
            ) : selectedId === undefined || selected === undefined ? (
              <p className={css.placeholder}>{t('noServers')}</p>
            ) : !selected.connected ? (
              /* role="alert"：该分支是"插入即带内容"的整块替换，polite 的 status 不会被播报。 */
              <div className={css.unavailableView} role="alert">
                <p className={css.placeholder}>
                  {selected.id === LOCAL_INSTANCE_ID
                    ? t('localNotReady')
                    : selected.managedRuntimeDown === true
                      // 隧道正常、托管 dsh 停机——「不可达」不准确，必须说清是哪一层停了。
                      ? t('managedDshDown')
                      : selected.kind === 'gateway'
                        && (selected.phase === 'starting' || selected.phase === 'restarting')
                        // 瞬态同理：不是「不可达」，只是还没起来。
                        ? t('managedDshStarting')
                        : t('targetUnavailable')}
                </p>
                {/* Every action pill in this panel is the official Button (`variant="outline"`, size sm). */}
                <Button
                  variant="outline"
                  size="sm"
                  className={css.inlineAction}
                  onClick={() => onSelectSection(CONNECTIONS_SECTION_ID)}
                >
                  {t('manageConnections')}
                </Button>
              </div>
            ) : face !== undefined ? (
              /* The selected server's own ledger: normal content, keyed by server
                 so a switch remounts the wrapper and replays the fade-in. */
              rows.length === 0 ? (
                /* upstream renders an EMPTY options column here (its single-ctx shell
                   can never show the panel without sections); the chamber keeps the
                   honest placeholder deliberately — an unpublished ledger is a
                   REACHABLE N-source state, and a blank column would read as "this
                   server has no settings" instead of "its sections are not here yet". */
                <div key={selectedId} className={css.contentFade}>
                  <p className={css.placeholder}>{t('sectionsEmpty')}</p>
                </div>
              ) : (
                active !== undefined && (
                  <div key={selectedId} className={css.contentFade}>
                    {/* The selected server's OWN section content, rendered with
                        that server's own renderer-bound seats. containAll keeps a
                        foreign entry's failure (render crash or a BridgeAssemblyError
                        from a miswired entry) inside a `settings.section` error
                        div; it can never abdicate the chamber-owned shell. */}
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
              /* Connected, but that server's shell has not published its settings
                 face yet (its frontend is still booting — the App mounts it for
                 this panel via chamberBridge.setSettingsTarget). The distinct key
                 remounts the wrapper so the ready content replays its fade-in. */
              <div key={`loading-${selectedId}`} className={css.contentFade}>
                <div className={css.loadingView}>
                  <IconLoadingOutlineRegular className={css.loadingSpinner} size={16} aria-hidden="true" />
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
 * Complete-bridge contract (design 05 §5): the panel renders the SELECTED source's
 * OWN boot-ctx `settings.section` ledger with that source's OWN renderer-bound
 * seats. This component is that source's `sidebar.settings` occupant, so the
 * renderer hands it the complete standard kit (published under its
 * `chamberInstanceId`), and it asks the App layer to keep that source's shell
 * MOUNTED while the panel is open (`chamberBridge.setSettingsTarget`). Nothing is
 * mounted twice and no service is stubbed, so a third-party plugin active in that
 * instance's frontend is active here too, with its real `remote` and seats.
 */
export function SettingsShell(props: SettingsShellProps) {
  // The ambient slot face is erased (Record<string, unknown>); the real
  // sidebar.settings owner share is `{ wide: boolean }` and the standard seats
  // (useSessions / useWorkspaces / usePanelInfo / useResource /
  // useSessionPendingInteraction / root props) arrive beside it.
  const wide = props.wide === true
  const { t, connectionsT, chamberInstanceId } = props
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [servers, setServers] = useState<BridgeServerRow[]>(() => getServers())
  const [selectedId, setSelectedId] = useState<string | undefined>(() =>
    defaultSelection(getServers(), chamberInstanceId))

  useEffect(() => subscribeServers(() => setServers(getServers())), [])

  // Closing the dialog returns focus to the trigger it was opened from (upstream
  // SettingsRoot's wasOpen effect), AFTER the close commit, when the dialog can
  // no longer own focus.
  const triggerButton = useRef<HTMLButtonElement | null>(null)
  const wasOpen = useRef(open)
  useEffect(() => {
    if (wasOpen.current && !open) triggerButton.current?.focus()
    wasOpen.current = open
  }, [open])

  // Seat publication: seats are stable per (binding, source), so the effect
  // re-publishes only when the renderer swaps one (locale/root binding change) —
  // not every render. The same object feeds this ctx's own onboarding outlet
  // below (one materialization, two readers).
  const useSessions = props.useSessions
  const useWorkspaces = props.useWorkspaces
  const usePanelInfo = props.usePanelInfo
  const useResource = props.useResource
  const useSessionPendingInteraction = props.useSessionPendingInteraction
  const rootProps = useMemo(() => {
    const base = props.chamberFileApiBase
    return base === undefined ? undefined : { chamberFileApiBase: base }
  }, [props.chamberFileApiBase])
  const ownSeats = useMemo<BridgeStandardSeats>(() => ({
    ...(useSessions === undefined ? {} : { useSessions }),
    ...(useWorkspaces === undefined ? {} : { useWorkspaces }),
    ...(usePanelInfo === undefined ? {} : { usePanelInfo }),
    ...(useResource === undefined ? {} : { useResource }),
    ...(useSessionPendingInteraction === undefined ? {} : { useSessionPendingInteraction }),
    ...(rootProps === undefined ? {} : { props: rootProps }),
  }), [
    useSessions, useWorkspaces, usePanelInfo, useResource,
    useSessionPendingInteraction, rootProps,
  ])
  useEffect(() => {
    if (chamberInstanceId === undefined) return () => {}
    return publishSettingsSourceSeats(chamberInstanceId, ownSeats)
  }, [chamberInstanceId, ownSeats])

  // The App layer publishes the first projection asynchronously; backfill the
  // selection once servers arrive, and re-anchor when the selected server left it.
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

  // No active-reset on server switch — the connections page is server-independent;
  // a section id that left the new server's ledger falls back to its first row.
  const selected = servers.find(server => server.id === selectedId)
  const selectedConnected = selected?.connected ?? false

  useSyncExternalStore(subscribeSettingsSourceFaces, settingsSourceFaceRevision)
  const face = getSettingsSourceFace(selectedId)
  // A face is renderable only for the exact authoritative source incarnation:
  // delete/re-add or a transport-identity edit replaces the source under the same
  // id, and the previous ctx's ledger must never render for the new one.
  const faceMatchesIncarnation = face !== undefined
    && face.sourceFingerprint !== undefined
    && face.sourceFingerprint === selected?.sourceFingerprint
  const usableFace = faceMatchesIncarnation && settingsSourceFaceReady(face) ? face : undefined

  const selectServer = useCallback((id: string) => { setSelectedId(id) }, [])

  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])

  // ---- settings.onboarding stage ----
  // Upstream's SettingsRoot mounts the first not-yet-completed ordered
  // `settings.onboarding` entry while the CURRENT SESSION is blank or absent.
  // Chamber parity reads exactly the two facts upstream reads: the CTX'S OWN ledger
  // (this shell is that instance's `sidebar.settings` occupant) and the CTX'S OWN
  // sessions seat (`props.useSessions`) — no seat invented, no new fact channel. The
  // stage is deliberately per-ctx, NOT per selected source (a foreign ctx's step would
  // need a foreign hook, and two shells selecting one source would mount it twice);
  // MOUNTING is additionally gated on the chamber's active-view fact (document-global
  // dialog, several mounted shells); that gate does NOT touch the completed set.
  const ownFace = getSettingsSourceFace(chamberInstanceId)
  const ownSlots = ownFace?.slots
  const onboardingSteps = useOnboardingSteps(ownSlots)
  // Both coordinates are read by their OWN unconditional hook call: a composite
  // `useOnboardingActive(...) && useActiveView(...)` would short-circuit the
  // second hook whenever the sessions fact is false — a hook sequence changing on
  // a routine fact flip, the one shape React refuses outright.
  const sessionsOnboardingActive = useOnboardingActive(sessionsSeatOf(props))
  const onboardingInActiveView = useActiveView(chamberInstanceId)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  // The stage itself is the pure projection in ./onboarding.ts: MOUNTING = both facts, RESET = sessions alone.
  const onboardingStageState = onboardingStage({
    steps: onboardingSteps,
    completed: completedOnboarding,
    sessionsActive: sessionsOnboardingActive,
    inActiveView: onboardingInActiveView,
  })
  const onboardingStep = onboardingStageState.step
  // A new blank-session run starts the stage over — the SESSIONS fact alone (upstream
  // SettingsRoot's reset effect), never the composite: a view switch is not a new run,
  // and resetting on the composite would re-mount an acknowledged or explicitly
  // deferred step over a still-blank session. RESIDUAL: this set is component-local,
  // so a REMOUNT starts an empty set and re-mounts an acknowledged step.
  useEffect(() => {
    if (!onboardingStageState.resetsCompleted) return
    setCompletedOnboarding(new Set())
  }, [onboardingStageState.resetsCompleted])
  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])
  const openSection = useCallback((id: string) => {
    setActiveId(id)
    setOpen(true)
  }, [])

  return (
    <>
      <button
        ref={triggerButton}
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        // The rail (narrow) form renders the icon only, so the accessible name
        // must come from the label the official trigger slot also carries.
        aria-label={t('trigger')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(true) }}
      >
        {wide ? <IconSettingsOutlineRegular size={16} /> : <IconSettingsOutlineRegular size={18} />}
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
      {/* Exactly ONE step mounts, from this ctx's own ledger with its own
          renderer-bound seats (the step owns its ctx reads, readiness gate and dialog
          chrome). containAll keeps a crashed foreign step inside an error div. */}
      {onboardingStep !== undefined && ownSlots !== undefined && (
        <BridgeEntryBoundary containAll slotKey="settings.onboarding">
          <BridgeOutlet
            slots={ownSlots}
            locale={ownFace?.locale}
            standard={ownSeats}
            slotKey="settings.onboarding"
            ownerProps={{
              stepId: onboardingStep.id,
              complete: () => { completeOnboardingStep(onboardingStep.id) },
              openSection,
            }}
            opts={{ only: onboardingStep.id }}
          />
        </BridgeEntryBoundary>
      )}
    </>
  )
}
