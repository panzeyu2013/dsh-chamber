/**
 * Open-in header utility button (design 16 §6 + open-in extension,
 * real-machine placement fix 2026-08): registered into the OFFICIAL
 * conversation header utilities slot (`conversation.session.header.utilities`,
 * the same right-aligned row as the vendor "Session log" action), so the
 * button lays out INLINE beside it — the original `shell.overlay` top-right
 * anchor was measured to overlap that row (details column closed ⇒ the center
 * column reaches the frame edge), so the frame-level position is gone
 * entirely.
 *
 * The button opens the current session's workspace in an installed app,
 * chosen per source: LOCAL sources (sourceId === 'local') can open in any
 * reported app (Finder + VS Code on a typical mac) — ≥2 apps render the main
 * icon button (default = VS Code when present) plus a chevron dropdown whose
 * rows show each app's own mark + short name (OpenChamber OpenInAppButton
 * style, 2026-09); REMOTE sources (ssh-<id>) only get remote-capable apps
 * (VS Code) — exactly one app renders the plain icon button, behavior
 * unchanged from the VS Code-only days.
 *
 * Three gates (design 16 §6.3), ANY failure → render null (never a dead
 * button):
 *  1. the probed app list is non-empty after filtering (unknown/probe-failed →
 *     hidden, fail-closed);
 *  2. THIS header's session belongs to a workspace whose path exists
 *    (the slot delivers the per-header `sessionId`; both remote AND local
 *    sources show — user decision 2026-08: local opens `vscode://file/<path>`,
 *    remote opens `ssh-remote+`).
 *
 * Workspace rows come from the framework's global `useWorkspaces` selector
 * hook (the same store the sidebar groups by), so the plugin keeps zero
 * @dsh-chamber dependency and no direct ctx store access (design 16 §6.2).
 *
 * Marks: the VS Code mark is the ACTUAL product icon extracted from the
 * installed VS Code app (`vscode-icon.png`, Code.icns → 32px @2x), replacing
 * the original hand-drawn older-logo SVG path — nominative reference (design
 * 16 §6), so the button always matches the user's installed icon. Finder
 * (macOS only) uses the real Finder product icon (`finder-icon.png`, system
 * Finder.icns → 32px @2x, pixel-identical to OpenChamber's embedded Finder
 * mark, OpenChamber OpenInAppButton style); Explorer / file managers keep the
 * neutral inline folder outline in design tokens.
 */
import { useEffect, useState } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import finderIcon from './finder-icon.png'
import vscodeIcon from './vscode-icon.png'
import {
  bridgePlatform,
  getApps,
  getOpenInApps,
  openInBridgeReady,
  refreshApps,
  subscribeOpenIn,
  type OpenInApp,
  type Translate,
} from '../shared/coordinator.ts'
import { rawInstanceIdForLaunch, usableAppsForSource, workspacePathForSession } from './open-in-gates.ts'
import styles from './OpenInButton.module.css'

/** Injected face the plugin supplies: per-boot source id + bound translator. */
export interface OpenInInjected {
  /** Per-boot source id ('local' | 'ssh-<id>'), read from ctx.chamberInstanceId. */
  sourceId: string
  /** Bound translator for the plugin namespace. */
  t: Translate
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

/** The official Visual Studio Code product icon (32px @2x raster extracted
 *  from the installed app's Code.icns). Microsoft trademark — used here as
 *  nominative reference for a button whose only function is "open in VS Code"
 *  (user decision 2026-08); implies no endorsement. */
function VscodeMark() {
  return <img src={vscodeIcon} alt="" draggable={false} />
}

/** The macOS Finder product icon (32px @2x raster extracted from the system
 *  Finder.icns, pixel-identical to OpenChamber's embedded Finder mark). Apple
 *  trademark — nominative reference for a row/button whose only function is
 *  "open in Finder" (design 16 §6 precedent); implies no endorsement. */
function FinderMark() {
  return <img src={finderIcon} alt="" draggable={false} />
}

/** Neutral folder outline (20×20), tinted with the design token label color —
 *  the platform-neutral mark for Explorer / file managers (and Finder on
 *  non-macOS). */
function FolderMark() {
  return (
    <svg
      className={styles.folderMark}
      viewBox="0 0 20 20"
      width="20"
      height="20"
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

/** The file-manager mark for the current platform: the real Finder icon on
 *  macOS (OpenChamber OpenInAppButton style), the neutral folder outline
 *  elsewhere — Explorer / file managers get a platform-neutral mark in design
 *  tokens. */
function fileManagerMark(platform: string | null) {
  return platform === 'darwin' ? <FinderMark /> : <FolderMark />
}

/** Platform-appropriate wording for the "file manager" app: Finder on macOS,
 *  Explorer on Windows, generic file manager elsewhere. */
function finderLabel(t: Translate, platform: string | null): string {
  if (platform === 'darwin') return t('titleFinder')
  if (platform === 'win32') return t('titleExplorer')
  return t('titleFileManager')
}

/** Full per-app title for the main button tooltip/aria-label ("open current
 *  workspace in …"); the dropdown rows use the short `appName` instead. */
function appLabel(app: OpenInApp, t: Translate, platform: string | null): string {
  return app.id === 'vscode' ? t('titleVscode') : finderLabel(t, platform)
}

/** Short display name for the finder-family app (dropdown row wording). */
function finderName(t: Translate, platform: string | null): string {
  if (platform === 'darwin') return t('appFinder')
  if (platform === 'win32') return t('appExplorer')
  return t('appFileManager')
}

/** Short per-app display name for a dropdown row — the app itself ("VS Code",
 *  "Finder"), not the full "open current workspace in …" sentence that stays
 *  on the main button's tooltip/aria-label. */
function appName(app: OpenInApp, t: Translate, platform: string | null): string {
  return app.id === 'vscode' ? t('appVscode') : finderName(t, platform)
}

export function OpenInButton({ sourceId, t, sessionId, useWorkspaces }: OpenInProps) {
  const [appList, setAppList] = useState<OpenInApp[] | null>(getOpenInApps())
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    // The preload exposes the bridge after an async info round-trip, so a
    // mount before hydration would probe nothing and (with the coordinator's
    // bridge-missing reset, frontend-review P1-1) stay unknown. Poll for the
    // bridge like App.tsx's sshBridgeReady guard (bounded: web builds without
    // a bridge stay hidden after the budget instead of retrying forever).
    let cancelled = false
    let attempts = 0
    const timer = setInterval(() => {
      if (cancelled) return
      if (!openInBridgeReady()) {
        attempts += 1
        if (attempts > 40) clearInterval(timer)
        return
      }
      clearInterval(timer)
      void getApps().then(setAppList)
    }, 500)
    const unsubscribe = subscribeOpenIn(() => setAppList(getOpenInApps()))
    return () => {
      cancelled = true
      clearInterval(timer)
      unsubscribe()
    }
  }, [])

  // Hooks run unconditionally (before any gate's early return).
  const workspaces = useWorkspaces(ws => ws.items)

  // Gate 1: the probed app list, fail-closed (null/undefined/empty all hide),
  // filtered to what this source may actually use. LOCAL sources get every
  // available app; REMOTE (ssh-<id>) sources only remote-capable ones
  // (vscode). GATEWAY (gateway-<id>) and unknown sources get NOTHING — a
  // gateway instance has no vscode-remote semantics and the main-process
  // launch keys on the raw registry id ('ssh-' prefix strip only), so any
  // gateway button would be a guaranteed-fail dead button (frontend-review
  // P2 fix, 2026-09). The bridge's `available` flag is honored as a hard
  // filter (fail-closed).
  const usableApps = usableAppsForSource(sourceId, appList ?? [])
  if (usableApps.length === 0) return null

  // Gate 2: THIS header's session must live in a workspace with a concrete
  // path. Both remote and local sources show (user decision 2026-08); the
  // launch branch (ssh-remote vs file) is decided in the main process by
  // instanceId.
  const path = workspacePathForSession(workspaces, sessionId)
  if (path === undefined || path === '') return null

  // Default selection (this mount's memory only, no localStorage): VS Code
  // when present, else the first app.
  const defaultApp = usableApps.find(app => app.id === 'vscode') ?? usableApps[0]
  const activeApp = usableApps.find(app => app.id === selectedAppId) ?? defaultApp

  const platform = bridgePlatform()

  const openApp = (app: OpenInApp): void => {
    // View id → raw instance id: the sourceId is the per-boot VIEW id
    // ('local' | 'ssh-<id>'), but the main-process launch keys on the RAW
    // registry id — the 'ssh-' prefix is stripped here ('local' stays as-is;
    // security-review P1-1 / user decision 2026-08). Gateway ids never reach
    // this path (gate 1 filters them out — P2 fix).
    const instanceId = rawInstanceIdForLaunch(sourceId)
    void (window as unknown as {
      dshChamber?: { openIn?: { open(appId: string, instanceId: string, path: string): Promise<{ ok: true } | { ok: false; error: string }> } }
    }).dshChamber?.openIn?.open(app.id, instanceId, path).then((result) => {
      if (result !== undefined && !result.ok) {
        console.error(`[dsh-chamber] ${t('openFailed')}${result.error}`)
      }
    }).catch((error: unknown) => {
      // Transport-level rejection (IPC fence / handler throw): loud, never
      // an unhandled rejection (frontend-review P2-3).
      console.error(`[dsh-chamber] ${t('openFailed')}${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // One usable app → plain icon button (VS Code remote behavior unchanged).
  if (usableApps.length === 1) {
    const app = usableApps[0]
    const label = appLabel(app, t, platform)
    return (
      <button
        type="button"
        className={styles.button}
        onClick={() => openApp(app)}
        aria-label={label}
        title={label}
      >
        {app.id === 'vscode' ? <VscodeMark /> : fileManagerMark(platform)}
      </button>
    )
  }

  // ≥2 usable apps → main icon button (default selection) + chevron dropdown.
  // Each row carries the app's own mark + short name (OpenChamber
  // OpenInAppButton style) — nothing else, so the list is exactly
  // "icon + app name" per entry.
  const items = usableApps.map(app => ({
    id: app.id,
    label: appName(app, t, platform),
    icon: (
      <span className={styles.menuIcon}>
        {app.id === 'vscode' ? <VscodeMark /> : fileManagerMark(platform)}
      </span>
    ),
  }))
  const activeLabel = appLabel(activeApp, t, platform)
  return (
    <span className={styles.group}>
      <button
        type="button"
        className={styles.button}
        onClick={() => openApp(activeApp)}
        aria-label={activeLabel}
        title={activeLabel}
      >
        {activeApp.id === 'vscode' ? <VscodeMark /> : fileManagerMark(platform)}
      </button>
      <Menu
        portal
        align="end"
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onSelect={(id: string) => {
          setMenuOpen(false)
          setSelectedAppId(id)
          const chosen = usableApps.find(app => app.id === id)
          if (chosen !== undefined) openApp(chosen)
        }}
        items={items}
        selectedId={activeApp.id}
        anchor={(
          <button
            type="button"
            className={styles.chevron}
            aria-label={t('chooseAppAria')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => {
              // Toggle-close on an already-open menu (restores the original
              // chevron semantics; the Menu's outside-click/Escape/select
              // paths close as well). Opening is IMMEDIATE with a background
              // refresh — waiting for the probe before opening created a
              // reopen race with a quick item selection; the list updates in
              // place via the coordinator subscription once the fresh result
              // lands (epoch-guarded, fail-closed).
              if (menuOpen) { setMenuOpen(false); return }
              void refreshApps()
              setMenuOpen(true)
            }}
          >
            <svg className={styles.chevronMark} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      />
    </span>
  )
}
