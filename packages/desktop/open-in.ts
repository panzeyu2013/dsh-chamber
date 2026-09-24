/**
 * open-in registry — the generic "open this source's path in an app" launch
 * surface of the desktop main process. The provider set is deliberately
 * vscode-only: the local file manager and every other local application are
 * launched by the INSTANCE's own chamber host domain over that instance's
 * generic RPC, so the main process carries no finder/stat/openPath/reveal IPC
 * and keeps only what the instance cannot do — constructing the VS Code remote
 * URL for SSH sources from the chamber registry facts. Unknown appId is a loud
 * `unknown open-in app` error, never a guess or fallback. Electron-free by
 * construction: every host capability is injected via OpenInLaunchContext.
 */

import { INSTANCE_ID_PATTERN } from './transport-provider.ts'
import { describeUnknownError, runVscodeLaunch, validateLocalPath, validateRemotePath } from './deep-link.ts'

/** A normalized open-in launch request (renderer IPC payload, untrusted). */
export interface OpenInRequest {
  appId: string
  instanceId: string
  path: string
  /** IPC producer's exact non-secret source identity (validated by main). */
  sourceFingerprint?: string
}

/** Host capabilities injected by main.ts; a structural superset of
 *  VscodeLaunchContext, so the vscode provider delegates to runVscodeLaunch. */
export interface OpenInLaunchContext {
  platform: string
  /** Registry lookup; null = the instance does not exist. `transport` must be
   * 'ssh' for the vscode provider (re-checked by runVscodeLaunch). */
  lookupInstance(id: string): { id: string; host: string; user: string | null; sshPort: number | null; transport: string } | null
  vscodeAvailable(): boolean
  /** Open a vscode:// URL (main-process shell.openExternal wrapper; loud failure). */
  openVscodeUrl(url: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Chamber setting `vscodeOpenInNewWindow`: lazy per-launch read like
   *  vscodeAvailable; absent/undefined → bare URL (VS Code's own reuse/replace
   *  default), passed through to runVscodeLaunch. */
  vscodeOpenInNewWindow?(): boolean
}

/** The open-in execution result — loud {error} on failure, never a silent success. */
export type OpenInResult = { ok: true } | { ok: false; error: string }

/** Non-secret capability projection for the renderer (apps() negotiation). */
export interface OpenInAppInfo {
  id: string
  displayKind: string
  remoteCapable: boolean
  available: boolean
}

export type OpenInProbeErrorReporter = (appId: string, error: string) => void

/** One "how to launch" provider. `available` is a pure probe — never spawns,
 *  never executes; host facts come from the injected ctx only. */
export interface OpenInApp {
  readonly id: string
  /** Renderer presentation category (intentionally extensible, unlike id). */
  readonly displayKind: string
  /** Whether remote-instance (ssh-source) paths can be opened; vscode only. */
  readonly remoteCapable: boolean
  available(ctx: OpenInLaunchContext): boolean
  open(req: { instanceId: string; path: string }, ctx: OpenInLaunchContext): Promise<OpenInResult>
}

/**
 * The vscode provider: wraps runVscodeLaunch (registry lookup → authority
 * construction → availability re-check → openVscodeUrl) unchanged; the injected
 * context is a structural superset of VscodeLaunchContext and passes through.
 */
const vscodeApp = Object.freeze<OpenInApp>({
  id: 'vscode',
  displayKind: 'vscode',
  remoteCapable: true,
  // Same injected main-process fact as apps() negotiation — the two cannot diverge.
  available: (ctx) => ctx.vscodeAvailable(),
  open: (req, ctx) => runVscodeLaunch(req, ctx),
})

/** The fixed-order registry: vscode only — the main process never regains a
 *  local-execution surface (local launches stay the instance's job). */
const openInApps: readonly OpenInApp[] = Object.freeze([vscodeApp])

/** Whitelist lookup by id; a non-string appId (untrusted IPC) resolves to null like any unknown id — never guessed. */
export function getOpenInApp(appId: string): OpenInApp | null {
  if (typeof appId !== 'string') return null
  return openInApps.find(app => app.id === appId) ?? null
}

/**
 * Capability negotiation for the renderer (apps()): the full registry in fixed
 * order, each app projected to {id, displayKind, remoteCapable, available};
 * negotiation never branches on a provider id.
 */
export function listOpenInApps(
  ctx: OpenInLaunchContext,
  reportProbeError: OpenInProbeErrorReporter = () => {},
): OpenInAppInfo[] {
  return openInApps.map(app => ({
    id: app.id,
    displayKind: app.displayKind,
    remoteCapable: app.remoteCapable,
    // A broken probe fails closed for that app only — one provider never erases the list.
    available: (() => {
      try {
        return app.available(ctx)
      } catch (error) {
        // apps() has no per-entry error field; fail closed for that one app.
        try { reportProbeError(app.id, describeUnknownError(error)) } catch { /* logging must not erase the list */ }
        return false
      }
    })(),
  }))
}

/**
 * The single open-in execution pipeline shared by any IPC entry point:
 * 1. appId whitelist lookup — unknown (incl. non-string) → loud error;
 * 2. instanceId validation — 'local' reserved + INSTANCE_ID_PATTERN;
 * 3. path validation hoisted into the pipeline (validateLocalPath for 'local',
 *    which may be a Windows drive/UNC path; POSIX-only validateRemotePath for
 *    remote sessions), so no provider ever receives an unvalidated string;
 * 4. remoteCapable gate — a non-local instance against a local-only app refused;
 * 5. availability re-check via the injected ctx (defense in depth; vscode's
 *    runVscodeLaunch re-checks inside, keeping the double guard);
 * 6. delegate to the provider. Every failure is loud; no silent success path.
 */
export async function runOpenInLaunch(
  req: OpenInRequest,
  ctx: OpenInLaunchContext,
): Promise<OpenInResult> {
  const app = getOpenInApp(req.appId)
  if (app === null) {
    // Never stringify an untrusted non-string value (Proxy/toString trap).
    const appIdLabel = typeof req.appId === 'string' ? req.appId : '<invalid>'
    return { ok: false, error: `unknown open-in app: ${appIdLabel}` }
  }
  if (typeof req.instanceId !== 'string' || (req.instanceId !== 'local' && !INSTANCE_ID_PATTERN.test(req.instanceId))) {
    return { ok: false, error: 'invalid instance id' }
  }
  // Local workspaces may be Windows drive/UNC paths; remote session paths are POSIX.
  const validatedPath = req.instanceId === 'local'
    ? validateLocalPath(req.path)
    : validateRemotePath(req.path)
  if (!validatedPath.ok) return validatedPath
  if (req.instanceId !== 'local' && !app.remoteCapable) {
    return { ok: false, error: `${app.id} is not available for remote instances` }
  }
  let available: boolean
  try {
    available = app.available(ctx)
  } catch (error) {
    return { ok: false, error: `${app.id} availability check failed: ${describeUnknownError(error)}` }
  }
  if (!available) {
    return { ok: false, error: `${app.id} not detected` }
  }
  try {
    return await app.open({ instanceId: req.instanceId, path: validatedPath.path }, ctx)
  } catch (error) {
    return { ok: false, error: `${app.id} open failed: ${describeUnknownError(error)}` }
  }
}
