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
 * icon button (default = VS Code when present) plus a chevron dropdown;
 * REMOTE sources whose transport is SSH (whether target kind is dsh or
 * gateway) only get remote-capable apps (VS Code). HTTP transports get no
 * vscode-remote action. Exactly one usable app renders the plain icon button.
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
 * 16 §6), so the button always matches the user's installed icon. Finder (and
 * Explorer / file managers) get a neutral inline folder outline in design
 * tokens.
 */
import { useEffect, useState } from 'react'
import vscodeIcon from './vscode-icon.png'
import { AccessibleAppMenu } from './AccessibleAppMenu.tsx'
import {
  bridgePlatform,
  getApps,
  getOpenInApps,
  openInBridgeReady,
  refreshApps,
  subscribeOpenIn,
  type Translate,
} from '../shared/coordinator.ts'
import {
  buildOpenInLaunchRequest,
  describeOpenInError,
  parseOpenInResult,
  usableOpenInApps,
  type OpenInApp,
  type OpenInSource,
} from '../shared/capabilities.ts'
import { workspacePathForSession } from './open-in-gates.ts'
import styles from './OpenInButton.module.css'

/** Injected face the plugin supplies: per-boot source id + bound translator. */
export interface OpenInInjected {
  /** Strictly parsed per-boot source with orthogonal target id and transport. */
  source: OpenInSource
  /** Immutable identity of this exact boot, never read from a latest-roster global. */
  sourceFingerprint: string
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

/** Neutral folder outline (20×20), tinted with the design token label color —
 *  the platform-neutral mark for Finder / Explorer / file managers. */
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

/** Neutral application mark for future providers whose presentation family is
 * unknown to this client version. It deliberately does not impersonate the
 * file manager. */
function GenericAppMark() {
  return (
    <svg className={styles.genericMark} viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      <rect x="3" y="3" width="6" height="6" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="11" y="3" width="6" height="6" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="3" y="11" width="6" height="6" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="11" y="11" width="6" height="6" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

/** Platform-appropriate wording for the "file manager" app: Finder on macOS,
 *  Explorer on Windows, generic file manager elsewhere. */
function finderLabel(t: Translate, platform: string | null): string {
  if (platform === 'darwin') return t('titleFinder')
  if (platform === 'win32') return t('titleExplorer')
  return t('titleFileManager')
}

/** Per-app title used for both the button tooltip/aria-label and the dropdown
 *  row label. */
function appLabel(app: OpenInApp, t: Translate, platform: string | null): string {
  if (app.displayKind === 'vscode') return t('titleVscode')
  if (app.displayKind === 'file-manager') return finderLabel(t, platform)
  return t('titleGeneric', { app: app.id })
}

function appMark(app: OpenInApp) {
  if (app.displayKind === 'vscode') return <VscodeMark />
  if (app.displayKind === 'file-manager') return <FolderMark />
  return <GenericAppMark />
}

export function OpenInButton({ source, sourceFingerprint, t, sessionId, useWorkspaces }: OpenInProps) {
  const [appList, setAppList] = useState<OpenInApp[] | null>(getOpenInApps())
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null)

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
        if (attempts >= 40) clearInterval(timer)
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
  // available app; REMOTE sources over SSH get only remote-capable ones,
  // irrespective of dsh/gateway target kind. HTTP transports get none. The
  // bridge's `available` flag is honored as a hard filter (fail-closed).
  const usableApps = usableOpenInApps(appList, source)
  if (usableApps.length === 0) return null

  // Gate 2: THIS header's session must live in a workspace with a concrete
  // path. Both remote and local sources show (user decision 2026-08); the
  // launch branch (ssh-remote vs file) is decided in the main process from
  // the authoritative instance transport behind instanceId.
  const path = workspacePathForSession(workspaces, sessionId)
  if (path === undefined || path === '') return null

  // Default selection (this mount's memory only, no localStorage): VS Code
  // when present, else the first app.
  const defaultApp = usableApps.find(app => app.displayKind === 'vscode') ?? usableApps[0]
  const activeApp = usableApps.find(app => app.id === selectedAppId) ?? defaultApp

  const platform = bridgePlatform()

  const openApp = (app: OpenInApp): void => {
    const bridge = (window as unknown as {
      dshChamber?: { openIn?: { open(appId: string, instanceId: string, path: string, sourceFingerprint: string): Promise<unknown> } }
    }).dshChamber?.openIn
    if (bridge === undefined) {
      console.error(`[dsh-chamber] ${t('openFailed')}${t('bridgeUnavailable')}`)
      return
    }
    const request = buildOpenInLaunchRequest(app.id, source, path, sourceFingerprint)
    void bridge.open(request.appId, request.instanceId, request.path, request.sourceFingerprint).then((rawResult) => {
      const result = parseOpenInResult(rawResult)
      if (result === null) {
        console.error(`[dsh-chamber] ${t('openFailed')}${t('invalidResponse')}`)
      } else if (!result.ok) {
        console.error(`[dsh-chamber] ${t('openFailed')}${result.error}`)
      }
    }).catch((error: unknown) => {
      // Transport-level rejection (IPC fence / handler throw): loud, never
      // an unhandled rejection (frontend-review P2-3).
      console.error(`[dsh-chamber] ${t('openFailed')}${describeOpenInError(error)}`)
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
        {appMark(app)}
      </button>
    )
  }

  // ≥2 usable apps → main icon button (default selection) + chevron dropdown.
  const items = usableApps.map(app => ({ id: app.id, label: appLabel(app, t, platform) }))
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
        {appMark(activeApp)}
      </button>
      <AccessibleAppMenu
        items={items}
        selectedId={activeApp.id}
        triggerLabel={t('chooseAppAria')}
        triggerClassName={styles.chevron}
        triggerIcon={(
          <svg className={styles.chevronMark} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        onOpening={() => { void refreshApps() }}
        onSelect={(id) => {
          setSelectedAppId(id)
          const chosen = usableApps.find(app => app.id === id)
          if (chosen !== undefined) openApp(chosen)
        }}
      />
    </span>
  )
}
