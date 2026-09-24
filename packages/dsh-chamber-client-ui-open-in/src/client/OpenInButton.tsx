/**
 * Open-in header utility entry: the SINGLE header control that opens the
 * current session’s workspace in an installed app, over the per-source
 * view-model (`shared/open-in-view-model.ts` is the single decision surface).
 *
 * It sits in the OFFICIAL conversation header utilities slot
 * (`conversation.session.header.utilities`, the same right-aligned row as the
 * vendor "Session log" action) so it lays out INLINE beside that row; a
 * `shell.overlay` top-right anchor would overlap it.
 *
 * Presentation is the OFFICIAL control’s: the 28px / r14 split box, upstream’s
 * mark sizes, the design-system `Tooltip` on both halves (a native `title`
 * bubble draws differently across WebKit/Chromium), the official `Menu` at
 * chamber `compact` density, and upstream’s rounded-square fallback for an id
 * the catalog cannot answer. TWO GATES, any failure renders null (never a dead
 * button): ≥1 usable entry, and a workspace path for THIS header’s session.
 */
import { useEffect, useRef, useState } from 'react'
import {
  IconChevronDownOutline14, Menu, Tooltip, type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useInstanceViewDismissal } from './instance-view-guard.ts'
import type { Translate } from '../shared/coordinator.ts'
import { describeOpenInError } from '../shared/capabilities.ts'
import type { OpenInResult, OpenInSource } from '../shared/capabilities.ts'
import type { OpenInViewEntry, OpenInViewModel } from '../shared/open-in-view-model.ts'
import { OPEN_IN_APP_LABEL_KEY } from '../locales.ts'
import { workspacePathForSession } from './open-in-gates.ts'
import styles from './OpenInButton.module.css'

/** Injected face the plugin supplies: per-boot source id + bound translator. */
export interface OpenInInjected {
  /** Strictly parsed per-boot source with orthogonal target id and transport. */
  source: OpenInSource
  /** Bound translator for the plugin namespace. */
  t: Translate
  /** Current merged per-source view-model (local + main pools). */
  getViewModel(): OpenInViewModel
  /** Subscribe to view-model changes (pool probes, icons, choice). */
  subscribe(listener: () => void): () => void
  /** Re-probe both pools on menu open. (Window focus releases only the page-wide
   *  MAIN pool memo — `coordinator.ts`’s hydration recovery — while the machine
   *  catalog is re-probed here and by each entry’s boot.) */
  refresh(): Promise<void>
  /** Launch one entry through its channel; rejects on failure. */
  launch(entry: OpenInViewEntry, path: string): Promise<OpenInResult>
  /** The persisted app choice for THIS source ('' before the first pick). */
  getChoice(): string
  /** Remember a picked app id for THIS source. */
  choose(appId: string): void
  /** Cached host icon `data:` URL, consulted for every channel; null while
   *  unknown or when the instance serves none. */
  iconUrl(appId: string): string | null
  /** Host platform string ('darwin' | 'win32' | 'linux' | …) or null. */
  platform: string | null
}

/**
 * Slot props: the injected face plus the framework standard kit the header
 * utilities slot delivers (per-header `sessionId`, global `useWorkspaces`
 * selector). Structural subset on purpose — the vendor runtime publishes no
 * d.ts tree in the workspace symlink.
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
 *  paints; the visible dim-and-wait treatment is for launches taking a while. */
const BUSY_DRESS_DELAY_MS = 250
/** Error dress decay (absorbed from the official client). */
const ERROR_DECAY_MS = 2_000

/** Rendered size of the app mark inside the main button (upstream’s own `AppIcon` size). */
const BUTTON_MARK_SIZE = 15
/** Rendered size of the app mark in a menu row (the official plugin’s 18px leading icon). */
const MENU_MARK_SIZE = 18

/** Upstream’s own fallback glyph for an app whose icon the host does not serve:
 *  the single rounded square, geometry and class treatment verbatim, colour
 *  inherited (never set here). */
function GenericAppMark({ size }: { size: number }) {
  return (
    <svg
      className={styles.mark}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
    </svg>
  )
}

/** Icon URLs whose image already failed to decode this page (a broken icon is
 *  not re-attempted per menu open). Keyed by URL, not app id: one page reads ONE
 *  machine catalog, so a failure remembered once falls back everywhere. */
const failedIcons = new Set<string>()

/** One machine-catalog entry's real bundle icon with the generic fallback. */
function CatalogIcon({ url, size }: { url: string; size: number }) {
  const [failed, setFailed] = useState(failedIcons.has(url))
  if (failed) return <GenericAppMark size={size} />
  return (
    <img
      className={styles.mark}
      src={url}
      alt=""
      width={size}
      height={size}
      draggable={false}
      aria-hidden="true"
      onError={() => {
        failedIcons.add(url)
        setFailed(true)
      }}
    />
  )
}

/** Platform-appropriate wording for the "file manager" family. */
function finderLabel(t: Translate, platform: string | null): string {
  if (platform === 'darwin') return t('titleFinder')
  if (platform === 'win32') return t('titleExplorer')
  return t('titleFileManager')
}

/** Per-entry title for both tooltip/aria-label and menu row: the absorbed
 *  official label table, then our family wording, then the raw id. */
function appLabel(entry: OpenInViewEntry, t: Translate, platform: string | null): string {
  const labelKey = OPEN_IN_APP_LABEL_KEY[entry.id]
  if (labelKey !== undefined) return t(labelKey)
  if (entry.displayKind === 'file-manager') return finderLabel(t, platform)
  if (entry.displayKind === 'vscode') return t('titleVscode')
  return t('titleGeneric', { app: entry.id })
}

/** The machine’s own art when the catalog answered the id, else upstream’s square. */
function appMark(iconUrl: string | null, size: number) {
  return iconUrl === null ? <GenericAppMark size={size} /> : <CatalogIcon url={iconUrl} size={size} />
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
  /** Why the last launch failed, presented in the app (design-system tooltip
   *  beside the red ring) instead of a console line; cleared with the error dress. */
  const [failureReason, setFailureReason] = useState<string | null>(null)
  const inFlight = useRef(false)
  const busyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
/** The menu’s anchor element — the wrapper the instance-view guard anchors on. */
  const groupRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => subscribe(() => { setModel(getViewModel()) }), [subscribe, getViewModel])

  useEffect(() => () => {
    clearTimeout(busyTimer.current)
    clearTimeout(errorTimer.current)
  }, [])

  // The one genuinely N-ctx piece: this shell keeps one `.instance-view` per
  // attached source and hides inactive ones, so an open menu must close when the
  // view that owns it goes inactive. Everything else comes from the primitive.
  useInstanceViewDismissal(open, groupRef, () => { setOpen(false) })

  // Hooks run unconditionally (before any gate's early return).
  const workspaces = useWorkspaces(ws => ws.items)

  // Gate 1: the merged view-model decides what this source may use (fail-closed); an empty set renders null.
  const entries = model.entries
  if (entries.length === 0) return null

  // Gate 2: THIS header's session must live in a workspace with a concrete path;
  // the launch channel decides ssh-remote vs local/instance semantics.
  const path = workspacePathForSession(workspaces, sessionId)
  if (path === undefined || path === '') return null

  // Remembered selection when still usable, else the view-model default (first VS Code entry, else first).
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
      // Transport-level rejection (IPC fence / host route throw): surfaced in the app, never unhandled.
      inFlight.current = false
      clearTimeout(busyTimer.current)
      setFailureReason(describeOpenInError(error))
      setPhase('error')
      errorTimer.current = setTimeout(() => {
        setPhase('idle')
        setFailureReason(null)
      }, ERROR_DECAY_MS)
    })
  }

/** The button’s accessible name: the action in the remembered app, or the failure state. */
  const title = phase === 'error' ? t('openError') : t('openTitle', { app: appLabel(activeEntry, t, platform) })
/** The tooltip carries a failed launch’s reason, and the neutral "opens locally" hint otherwise. */
  const tooltip = phase === 'error' && failureReason !== null
    ? `${t('openFailed')}${failureReason}`
    : phase === 'error' ? t('openError') : t('openTooltip')

  // ≥1 usable entry → the official split button (main icon button + chevron
  // menu), the same form upstream renders for one app as for ten.
  const items: MenuItem[] = entries.map(entry => ({
    id: entry.id,
    label: appLabel(entry, t, platform),
    icon: appMark(iconUrl(entry.id), MENU_MARK_SIZE),
  }))
  return (
    <Menu
      open={open}
      autoFocus
      // Chamber popup menus run at chamber scale (`compact`, 26px/12px), not
      // `dense` (34px items); `autoFocus`, arrow keys, fill selection and icons stay.
      compact
      selection="fill"
      align="end"
      items={items}
      selectedId={activeEntry.id}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        const chosen = entries.find(entry => entry.id === id)
        if (chosen === undefined) return
        setOpen(false)
        // A pick while a launch is in flight is ignored whole: persisting without launching would name an app the gesture never opened.
        if (inFlight.current) return
        choose(id)
        openApp(chosen)
      }}
      anchor={(
        <span className={styles.split} ref={groupRef}>
          <Tooltip label={tooltip} side="bottom">
            <button
              type="button"
              className={styles.button}
              data-state={phase}
              disabled={phase === 'busy'}
              onClick={() => {
                // The anchor REGION is the Menu's own root, so a main-button press is not an outside dismissal: close the list here.
                setOpen(false)
                openApp(activeEntry)
              }}
              aria-label={title}
            >
              {appMark(iconUrl(activeEntry.id), BUTTON_MARK_SIZE)}
            </button>
          </Tooltip>
          {/* Same design-system bubble as the main button: no native `title` on
              either half, whose rendering differs across WebKit and Chromium. */}
          <Tooltip label={t('menuToggle')} side="bottom">
            <button
              type="button"
              className={styles.chevron}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={t('menuToggle')}
              onClick={() => {
                const next = !open
                setOpen(next)
                // The catalog is re-probed on every open.
                if (next) void refresh()
              }}
              onKeyDown={(event) => {
                // Arrow-key opening stays available (the primitive’s `autoFocus` moves focus into the list).
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  setOpen(true)
                  void refresh()
                }
              }}
            >
              {/* The design system's own chevron at the official client's 11px size — no hand-drawn glyph and no invented animation. */}
              <IconChevronDownOutline14 size={11} />
            </button>
          </Tooltip>
        </span>
      )}
    />
  )
}
