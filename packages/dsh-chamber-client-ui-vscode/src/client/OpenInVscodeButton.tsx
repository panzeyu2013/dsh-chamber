/**
 * VS Code deep-link header utility button (design 16 §6, real-machine
 * placement fix 2026-08): registered into the OFFICIAL conversation header
 * utilities slot (`conversation.session.header.utilities`, the same
 * right-aligned row as the vendor "Session log" action), so the button lays
 * out INLINE beside it — the original `shell.overlay` top-right anchor was
 * measured to overlap that row (details column closed ⇒ the center column
 * reaches the frame edge), so the frame-level position is gone entirely.
 *
 * Three gates (design 16 §6.3), ANY failure → render null (never a dead
 * button):
 *  1. VS Code availability === true (unknown/probe-failed → hidden, fail-closed);
 *  2. THIS header's session belongs to a workspace whose path exists
 *    (the slot delivers the per-header `sessionId`; both remote AND local
 *    sources show — user decision 2026-08: local opens `vscode://file/<path>`,
 *    remote opens `ssh-remote+`).
 *
 * Workspace rows come from the framework's global `useWorkspaces` selector
 * hook (the same store the sidebar groups by), so the plugin keeps zero
 * @dsh-chamber dependency and no direct ctx store access (design 16 §6.2).
 */
import { useEffect, useState } from 'react'
import {
  ensureVscodeAvailability,
  getVscodeAvailability,
  subscribeVscodeAvailability,
  vscodeBridgeReady,
  type Translate,
  type VscodeBridgeSurface,
} from '../shared/coordinator.ts'
import styles from './OpenInVscodeButton.module.css'

/** Injected face the plugin supplies: per-boot source id + bound translator. */
export interface OpenInVscodeInjected {
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
export interface OpenInVscodeProps extends OpenInVscodeInjected {
  /** The session this header belongs to (framework-supplied). */
  sessionId: string
  /** Framework selector hook over the workspace list (rows carry path/sessionIds). */
  useWorkspaces: <S>(sel: (ws: {
    items: ReadonlyArray<{ workspaceId: string; path: string; sessionIds: string[] }>
  }) => S) => S
}

/**
 * The official Visual Studio Code product icon (single-path, brand blue).
 * Microsoft trademark — used here as nominative reference for a button whose
 * only function is "open in VS Code" (user decision 2026-08); implies no
 * endorsement. Fixed fill: the brand color stays recognizable regardless of
 * the theme.
 */
function VscodeLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">
      <path
        fill="#007ACC"
        d="M29.01 5.03 20.997 1.02a3.335 3.335 0 0 0-3.806.648L7.637 10.37l-3.68-2.726a2 2 0 0 0-2.552.115L.3 8.853a2 2 0 0 0 .002 2.956l2.601 2.194-2.6 2.195a2 2 0 0 0-.002 2.956l1.105 1.093a2 2 0 0 0 2.552.115l3.68-2.724 9.555 8.7a3.333 3.333 0 0 0 3.806.65l8.01-4.01A3.335 3.335 0 0 0 30.999 24.86V7.14a3.333 3.333 0 0 0-1.99-2.11zM23.91 22.29l-9.582-8.7a1 1 0 0 1-.221-1.34 1 1 0 0 1 1.34-.22l9.58 8.7 2.67-1.34-9.56-17.46-2.67 1.34z"
      />
    </svg>
  )
}

export function OpenInVscodeButton({ sourceId, t, sessionId, useWorkspaces }: OpenInVscodeProps) {
  const [available, setAvailable] = useState<boolean | null>(getVscodeAvailability())

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
      if (!vscodeBridgeReady()) {
        attempts += 1
        if (attempts > 40) clearInterval(timer)
        return
      }
      clearInterval(timer)
      void ensureVscodeAvailability().then(setAvailable)
    }, 500)
    const unsubscribe = subscribeVscodeAvailability(() => setAvailable(getVscodeAvailability()))
    return () => {
      cancelled = true
      clearInterval(timer)
      unsubscribe()
    }
  }, [])

  // Hooks run unconditionally (before any gate's early return).
  const workspaces = useWorkspaces(ws => ws.items)

  // Gate 1: availability (fail-closed — null/undefined/false all hide).
  if (available !== true) return null
  // Gate 2: THIS header's session must live in a workspace with a concrete
  // path. Both remote and local sources show (user decision 2026-08); the
  // launch branch (ssh-remote vs file) is decided in the main process by
  // instanceId.
  const workspace = workspaces.find(item => item.sessionIds.includes(String(sessionId)))
  const path = workspace?.path
  if (path === undefined || path === '') return null

  const onClick = (): void => {
    // View id → raw instance id: the button's sourceId is the per-boot VIEW id
    // ('local' | 'ssh-<id>'), but the main-process launch keyed on the RAW
    // registry id — the 'ssh-' prefix is stripped here ('local' stays as-is;
    // security-review P1-1 / user decision 2026-08).
    const instanceId = sourceId.startsWith('ssh-') ? sourceId.slice(4) : sourceId
    void (window as unknown as VscodeBridgeSurface).dshChamber?.vscode?.open(instanceId, path).then((result) => {
      if (result !== undefined && !result.ok) {
        console.error(`[dsh-chamber] ${t('openFailed')}${result.error}`)
      }
    }).catch((error: unknown) => {
      // Transport-level rejection (IPC fence / handler throw): loud, never
      // an unhandled rejection (frontend-review P2-3).
      console.error(`[dsh-chamber] ${t('openFailed')}${error instanceof Error ? error.message : String(error)}`)
    })
  }

  return (
    <button
      type="button"
      className={styles.button}
      onClick={onClick}
      aria-label={t('title')}
      title={t('title')}
    >
      <VscodeLogo />
    </button>
  )
}
