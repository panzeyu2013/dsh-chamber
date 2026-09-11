/**
 * Open-in header utility entry (design 16 §6 + open-in extension + Batch 3
 * Phase 2 unification): the SINGLE header entry that opens the current
 * session's workspace in an installed app, over the per-source view-model.
 *
 * Registered into the OFFICIAL conversation header utilities slot
 * (`conversation.session.header.utilities`, the same right-aligned row as the
 * vendor "Session log" action), so the control lays out INLINE beside it — the
 * original `shell.overlay` top-right anchor was measured to overlap that row
 * (details column closed ⇒ the center column reaches the frame edge), so the
 * frame-level position is gone entirely.
 *
 * Presentation matrix (see `shared/open-in-view-model.ts`, the single decision
 * surface):
 *  - LOCAL sources render the instance-hosted application catalog (the chamber
 *    host domain `openInApp/*` in `packages/dsh-chamber-seed-open-in`: real
 *    bundle icons over the instance's own RPC channel) plus the desktop
 *    main-process provider (the VS Code override);
 *  - SSH-transport remote sources render the main provider's remote-capable
 *    apps only (VS Code Remote-SSH);
 *  - HTTP/unknown sources render nothing.
 * ≥2 entries render the main button (remembered/default selection) plus a
 * chevron menu; exactly one renders the plain icon button; zero renders null.
 * The menu is the official `Menu` primitive (dense rows, fill selection, real
 * app icons, focus transfer and arrow navigation through `autoFocus`), and the
 * button carries the design-system `Tooltip`; only the `.instance-view`-scoped
 * dismissal stays local (`instance-view-guard.ts`) because this shell stacks
 * one instance view per source (2026-09-11 upstream-alignment, T13/T5).
 *
 * Superset of the official `open-in-app` client (design 20 §7): the catalog and
 * its real icons (`local-catalog.ts`), the product-label table and button copy
 * (`../locales.ts`), the persisted choice (`choice-store.ts`, per source here),
 * the busy/error dress of the split button (delayed busy paint, decaying
 * error), plus what upstream never had — remote sources through the desktop
 * main-process provider, source-scoped memory and the remote deeplink carrier.
 *
 * Two gates (design 16 §6.3), ANY failure → render null (never a dead button):
 *  1. the merged view-model has ≥1 usable entry (unknown/probe-failed →
 *     hidden, fail-closed);
 *  2. THIS header's session belongs to a workspace with a concrete path.
 *
 * Workspace rows come from the framework's global `useWorkspaces` selector
 * hook (the same store the sidebar groups by), so the plugin keeps zero
 * @dsh-chamber dependency and no direct ctx store access (design 16 §6.2).
 */
import { useEffect, useRef, useState } from 'react'
import { Menu, Tooltip, type MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'
import vscodeIcon from './vscode-icon.png'
import { useInstanceViewDismissal } from './instance-view-guard.ts'
import type { Translate } from '../shared/coordinator.ts'
import type { OpenInResult, OpenInSource } from '../shared/capabilities.ts'
import type { OpenInViewEntry, OpenInViewModel } from '../shared/open-in-view-model.ts'
import { OPEN_IN_APP_LABEL_KEY } from '../locales.ts'
import { markKindFor, workspacePathForSession } from './open-in-gates.ts'
import styles from './OpenInButton.module.css'

/** Injected face the plugin supplies: per-boot source id + bound translator. */
export interface OpenInInjected {
  /** Strictly parsed per-boot source with orthogonal target id and transport. */
  source: OpenInSource
  /** Immutable identity of this exact boot, never read from a latest-roster global. */
  sourceFingerprint: string
  /** Bound translator for the plugin namespace. */
  t: Translate
  /** Current merged per-source view-model (local + main pools). */
  getViewModel(): OpenInViewModel
  /** Subscribe to view-model changes (pool probes, icons, choice). */
  subscribe(listener: () => void): () => void
  /** Re-probe both pools (menu open / window focus). */
  refresh(): Promise<void>
  /** Launch one entry through its channel; rejects on failure. */
  launch(entry: OpenInViewEntry, path: string): Promise<OpenInResult>
  /** The persisted app choice for THIS source ('' before the first pick). */
  getChoice(): string
  /** Remember a picked app id for THIS source. */
  choose(appId: string): void
  /** Cached catalog icon `data:` URL for a local entry; null while unknown or absent. */
  iconUrl(appId: string): string | null
  /** Host platform string ('darwin' | 'win32' | 'linux' | …) or null. */
  platform: string | null
}

/**
 * Slot component props: the injected face plus the framework standard kit the
 * header-utilities slot delivers — the per-header `sessionId` and the global
 * `useWorkspaces` selector hook over the vendor workspace store. Structural
 * subset on purpose (the vendor runtime's published d.ts trees are absent in
 * the workspace symlink, so the plugin types against the slice it reads).
 */
export interface OpenInProps extends OpenInInjected {
  /** The session this header belongs to (framework-supplied). */
  sessionId: string
  /** Framework selector hook over the workspace list (rows carry path/sessionIds). */
  useWorkspaces: <S>(sel: (ws: {
    items: ReadonlyArray<{ workspaceId: string; path: string; sessionIds: string[] }>
  }) => S) => S
}

/** Quick launches settle well under this delay, so their busy dress never
 *  paints — the visible dim-and-wait treatment is reserved for launches that
 *  are actually taking a while (absorbed from the official client). */
const BUSY_DRESS_DELAY_MS = 250
/** Error dress decay (absorbed from the official client). */
const ERROR_DECAY_MS = 2_000

/** Rendered size of the app mark inside the 32px header pill. */
const BUTTON_MARK_SIZE = 20
/** Rendered size of the app mark in a menu row (the official plugin's 18px
 *  leading icon, `OpenInAppAction.tsx`: `icon: <AppIcon … size={18}/>`). */
const MENU_MARK_SIZE = 18

/** The official Visual Studio Code product icon (32px @2x raster extracted
 *  from the installed app's Code.icns). Microsoft trademark — used here as
 *  nominative reference for a button whose only function is "open in VS Code"
 *  (user decision 2026-08); implies no endorsement. */
function VscodeMark({ size }: { size: number }) {
  return <img src={vscodeIcon} alt="" width={size} height={size} draggable={false} />
}

/** Neutral folder outline (20×20 at the button size; the menu rows render it
 *  at the primitive's icon size), tinted with the design token label color —
 *  the platform-neutral mark for Finder / Explorer / file managers. */
function FolderMark({ size }: { size: number }) {
  return (
    <svg
      className={styles.folderMark}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.6a1.5 1.5 0 0 1 1.2.6l.9 1.2a1.5 1.5 0 0 0 1.2.6H16a1.5 1.5 0 0 1 1.5 1.5v6.6a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Neutral application mark for catalog families this client version cannot
 *  name, and for an icon image the host does not serve. */
function GenericAppMark({ size }: { size: number }) {
  return (
    <svg className={styles.genericMark} viewBox="0 0 20 20" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="3" y="3" width="6" height="6" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="11" y="3" width="6" height="6" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="3" y="11" width="6" height="6" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="11" y="11" width="6" height="6" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

/** App ids whose icon image already failed this page (a 404 icon is fetched
 *  once, not per menu open — absorbed from the official client). */
const failedIcons = new Set<string>()

/** One official catalog entry's real bundle icon with the generic fallback. */
function CatalogIcon({ id, url, size }: { id: string; url: string; size: number }) {
  const [failed, setFailed] = useState(failedIcons.has(id))
  if (failed) return <GenericAppMark size={size} />
  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      draggable={false}
      onError={() => {
        failedIcons.add(id)
        setFailed(true)
      }}
    />
  )
}

/** Platform-appropriate wording for the "file manager" family: Finder on
 *  macOS, Explorer on Windows, generic file manager elsewhere. */
function finderLabel(t: Translate, platform: string | null): string {
  if (platform === 'darwin') return t('titleFinder')
  if (platform === 'win32') return t('titleExplorer')
  return t('titleFileManager')
}

/** Per-entry title used for both the button tooltip/aria-label and the dropdown
 *  row label: the absorbed official label table first, then the chamber's
 *  family wording, then the raw id (a host catalog extension stays visible). */
function appLabel(entry: OpenInViewEntry, t: Translate, platform: string | null): string {
  const labelKey = OPEN_IN_APP_LABEL_KEY[entry.id]
  if (labelKey !== undefined) return t(labelKey)
  if (entry.displayKind === 'file-manager') return finderLabel(t, platform)
  if (entry.displayKind === 'vscode') return t('titleVscode')
  return t('titleGeneric', { app: entry.id })
}

function appMark(entry: OpenInViewEntry, iconUrl: string | null, size: number) {
  switch (markKindFor(entry, iconUrl !== null)) {
    case 'catalog-icon':
      return <CatalogIcon id={entry.id} url={iconUrl as string} size={size} />
    case 'vscode':
      return <VscodeMark size={size} />
    case 'file-manager':
      return <FolderMark size={size} />
    default:
      return <GenericAppMark size={size} />
  }
}

export function OpenInButton({
  t,
  sessionId,
  useWorkspaces,
  getViewModel,
  subscribe,
  refresh,
  launch,
  getChoice,
  choose,
  iconUrl,
  platform,
}: OpenInProps) {
  const [model, setModel] = useState<OpenInViewModel>(() => getViewModel())
  const [phase, setPhase] = useState<'idle' | 'busy' | 'error'>('idle')
  const [open, setOpen] = useState(false)
  /** Why the last launch failed, presented IN THE APP (the design-system
   *  tooltip, beside the red ring) instead of a console line plus a native
   *  `title` bubble (2026-09-11 upstream-alignment, T5). Cleared with the
   *  error dress it belongs to, so no stale reason can outlive it. */
  const [failureReason, setFailureReason] = useState<string | null>(null)
  const inFlight = useRef(false)
  const busyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** The menu's anchor element: the official `Menu` renders the anchor itself,
   *  so this is the wrapper the instance-view guard anchors on. */
  const groupRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => subscribe(() => { setModel(getViewModel()) }), [subscribe, getViewModel])

  useEffect(() => () => {
    clearTimeout(busyTimer.current)
    clearTimeout(errorTimer.current)
  }, [])

  // The one piece of the retired bespoke menu that is genuinely N-ctx: this
  // shell keeps one `.instance-view` per attached source and hides inactive
  // ones, so an open menu must close when the view that owns it goes inactive
  // (see instance-view-guard.ts). Focus transfer, arrow/Home/End navigation,
  // Escape-to-anchor, outside-pointer dismissal, placement and the item markup
  // all come from the official primitive.
  useInstanceViewDismissal(open, groupRef, () => { setOpen(false) })

  // Hooks run unconditionally (before any gate's early return).
  const workspaces = useWorkspaces(ws => ws.items)

  // Gate 1: the merged view-model decides what this source may use. Unknown or
  // failed probes contribute nothing (fail-closed); an empty set renders null.
  const entries = model.entries
  if (entries.length === 0) return null

  // Gate 2: THIS header's session must live in a workspace with a concrete
  // path. Both remote and local sources show (user decision 2026-08); the
  // launch channel decides ssh-remote vs local/instance semantics.
  const path = workspacePathForSession(workspaces, sessionId)
  if (path === undefined || path === '') return null

  // Remembered selection wins when still usable; otherwise the view-model's
  // default (first VS Code entry, else the first entry).
  const choice = getChoice()
  const activeEntry = entries.find(entry => entry.id === choice)
    ?? entries.find(entry => entry.id === model.defaultEntryId)
    ?? entries[0]

  const openApp = (entry: OpenInViewEntry): void => {
    if (inFlight.current) return
    inFlight.current = true
    clearTimeout(errorTimer.current)
    clearTimeout(busyTimer.current)
    busyTimer.current = setTimeout(() => { setPhase('busy') }, BUSY_DRESS_DELAY_MS)
    void launch(entry, path).then((result) => {
      inFlight.current = false
      clearTimeout(busyTimer.current)
      if (result.ok) {
        setPhase('idle')
        setFailureReason(null)
        return
      }
      setFailureReason(result.error)
      setPhase('error')
      errorTimer.current = setTimeout(() => {
        setPhase('idle')
        setFailureReason(null)
      }, ERROR_DECAY_MS)
    }).catch((error: unknown) => {
      // Transport-level rejection (IPC fence / host route throw): surfaced in
      // the app, never an unhandled rejection.
      inFlight.current = false
      clearTimeout(busyTimer.current)
      setFailureReason(error instanceof Error ? error.message : String(error))
      setPhase('error')
      errorTimer.current = setTimeout(() => {
        setPhase('idle')
        setFailureReason(null)
      }, ERROR_DECAY_MS)
    })
  }

  /** The button's accessible name: the action it performs in the remembered
   *  app, or the failure state (upstream `open.title` / `open.error`). */
  const title = phase === 'error' ? t('openError') : t('openTitle', { app: appLabel(activeEntry, t, platform) })
  /** The tooltip carries the reason of a failed launch (the error dress it
   *  belongs to), and the neutral "opens locally" hint otherwise. */
  const tooltip = phase === 'error' && failureReason !== null
    ? `${t('openFailed')}${failureReason}`
    : phase === 'error' ? t('openError') : t('openTooltip')

  // One usable entry → plain icon button.
  if (entries.length === 1) {
    return (
      <Tooltip label={tooltip} side="bottom">
        <button
          type="button"
          className={styles.button}
          data-state={phase}
          disabled={phase === 'busy'}
          onClick={() => { openApp(activeEntry) }}
          aria-label={title}
        >
          {appMark(activeEntry, iconUrl(activeEntry.id), BUTTON_MARK_SIZE)}
        </button>
      </Tooltip>
    )
  }

  // ≥2 usable entries → main icon button (remembered/default selection) + the
  // official chevron menu. The rows carry the same real app marks the button
  // does, at the primitive's icon size (upstream `MenuItem.icon`).
  const items: MenuItem[] = entries.map(entry => ({
    id: entry.id,
    label: appLabel(entry, t, platform),
    icon: appMark(entry, iconUrl(entry.id), MENU_MARK_SIZE),
  }))
  return (
    <Menu
      open={open}
      autoFocus
      dense
      selection="fill"
      align="end"
      items={items}
      selectedId={activeEntry.id}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        const chosen = entries.find(entry => entry.id === id)
        if (chosen === undefined) return
        setOpen(false)
        // A pick while a launch is in flight is ignored whole: persisting the
        // choice without launching would leave the button naming an app the
        // gesture never opened (official-client semantics).
        if (inFlight.current) return
        choose(id)
        openApp(chosen)
      }}
      anchor={(
        <span className={styles.group} ref={groupRef}>
          <Tooltip label={tooltip} side="bottom">
            <button
              type="button"
              className={styles.button}
              data-state={phase}
              disabled={phase === 'busy'}
              onClick={() => {
                // The anchor REGION is the Menu's own root, so a press on the
                // main button is not an outside dismissal: close the list here,
                // as the previous menu did, so no list lingers over a launch.
                setOpen(false)
                openApp(activeEntry)
              }}
              aria-label={title}
            >
              {appMark(activeEntry, iconUrl(activeEntry.id), BUTTON_MARK_SIZE)}
            </button>
          </Tooltip>
          <button
            type="button"
            className={styles.chevron}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={t('menuToggle')}
            title={t('menuToggle')}
            onClick={() => {
              const next = !open
              setOpen(next)
              // The catalog is re-probed on every open (the bespoke menu's
              // `onOpening` behaviour, now owned by the trigger).
              if (next) void refresh()
            }}
            onKeyDown={(event) => {
              // Arrow-key opening stays available (the primitive's `autoFocus`
              // then moves focus into the list).
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setOpen(true)
                void refresh()
              }
            }}
          >
            <svg className={styles.chevronMark} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </span>
      )}
    />
  )
}
