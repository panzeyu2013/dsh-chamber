/**
 * VS Code deep-link overlay button (design 16 §6): anchored to the top-right
 * of the main-area title-bar row (the `shell.overlay` frame-wide layer is
 * `position:absolute; inset:0`, so the entry positions itself frame-relative;
 * the vendor layer CSS `.overlayLayer > * { pointer-events: auto }` makes the
 * root element clickable without any opt-in of its own).
 *
 * Three gates (design 16 §6.3), ANY failure → render null (never a dead
 * button):
 *  1. VS Code availability === true (unknown/probe-failed → hidden, fail-closed);
 *  2. the CURRENT session belongs to a workspace whose path exists.
 *    (Both remote AND local sources show — user decision 2026-08: local
 *    opens `vscode://file/<path>`, remote opens `ssh-remote+`.)
 *
 * The current workspace path is read from THIS ctx's own runtime stores
 * (sessions snapshot `current` + workspaces rows `sessionIds`/`path` — the
 * vendor stores carry both, so the plugin keeps zero @dsh-chamber dependency,
 * design 16 §6.2/P2-1).
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  ensureVscodeAvailability,
  getVscodeAvailability,
  subscribeVscodeAvailability,
  vscodeBridgeReady,
  type Translate,
  type VscodeBridgeSurface,
} from '../shared/coordinator.ts'
import styles from './OpenInVscodeButton.module.css'

export interface OpenInVscodeProps {
  /** Per-boot source id ('local' | 'ssh-<id>') from the slot inject factory. */
  sourceId: string
  /** Bound translator for the plugin namespace. */
  t: Translate
  /** The source's own sessions list observable (vendor runtime store). */
  sessionsList: {
    subscribe(listener: () => void): () => void
    getSnapshot(): { current?: string }
  }
  /** The source's own workspaces list observable (vendor runtime store rows carry path). */
  workspacesList: {
    subscribe(listener: () => void): () => void
    getSnapshot(): { items: ReadonlyArray<{ workspaceId: string; path: string; sessionIds: string[] }> }
  }
}

/** useSyncExternalStore adapter over the vendor observable lists (zustand-style). */
function useObservableSnapshot<T>(observable: {
  subscribe(listener: () => void): () => void
  getSnapshot(): T
}): T {
  return useSyncExternalStore(
    (callback) => observable.subscribe(callback),
    () => observable.getSnapshot(),
    () => observable.getSnapshot(),
  )
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

export function OpenInVscodeButton({ sourceId, t, sessionsList, workspacesList }: OpenInVscodeProps) {
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

  const sessions = useObservableSnapshot(sessionsList)
  const workspaces = useObservableSnapshot(workspacesList)

  // Gate 1: availability (fail-closed — null/undefined/false all hide).
  if (available !== true) return null
  // Gate 2: the current session must live in a workspace with a concrete path.
  // Both remote and local sources show (user decision 2026-08); the launch
  // branch (ssh-remote vs file) is decided in the main process by instanceId.
  const current = sessions.current
  const workspace = current === undefined
    ? undefined
    : workspaces.items.find(item => item.sessionIds.includes(current))
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
