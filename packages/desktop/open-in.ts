/**
 * open-in registry — the generic "open this source's path in an app" launch
 * surface (desktop main process). This is the M0+M1 generalization of the
 * VS Code deep-link module (design 16): vscode is ONE provider of a registry
 * whose apps are looked up by id.
 *
 * Batch 3 Phase 2 (2026-09), revised by design 20 §2.2 (fork & supersede,
 * 2026-09-11): the provider set is deliberately vscode-only. The local file
 * manager (and every other local application) is served by the INSTANCE's own
 * chamber host domain — `@dsh-chamber/dsh-chamber-seed-open-in` (the fork of
 * upstream's open-in host half), reached by the client plugin over that
 * instance's generic RPC — so the main process no longer carries
 * finder/stat/openPath/reveal IPC surfaces, and it never calls the official
 * host half either: the local launch trust boundary lives in the instance
 * process, and the main process keeps only what the instance cannot do —
 * constructing the VS Code remote URL for SSH sources from the chamber's
 * registry facts.
 *
 * The registry mirrors two established philosophies:
 * - transport-provider.ts's "new source = new provider": each app is a
 *   self-contained provider (`OpenInApp`) registered once in a fixed-order
 *   list; the pipeline never guesses or falls back — an unknown appId is a
 *   loud `unknown open-in app` error.
 * - deep-link.ts's injection-test shape: the module is electron-free by
 *   construction (imports only node built-ins + INSTANCE_ID_PATTERN and the
 *   deep-link core), and every host capability (registry lookup, vscode
 *   availability/url-open) is injected via OpenInLaunchContext, so the
 *   pure-Node test suite (open-in.test.ts) runs without electron or any
 *   third-party dependency.
 *
 * Responsibilities:
 * - getOpenInApp / listOpenInApps: id lookup + capability negotiation
 *   (id / displayKind / remoteCapable / available) for the renderer UI.
 * - runOpenInLaunch: the single execution pipeline shared by any IPC entry
 *   point — appId whitelist → instanceId validation (mirror of
 *   runVscodeLaunch's symmetric gate) → path validation (validateLocalPath
 *   for instanceId 'local' — Windows drive/UNC paths included, design 21 M4;
 *   validateRemotePath hoisted for every remote dsh session, POSIX-only) →
 *   remoteCapable gate → availability re-check
 *   via the injected ctx (defense in depth; vscode's runVscodeLaunch has its
 *   own re-check inside, keeping the double guard) → app.open. Every failure
 *   is loud, never a silent success.
 *
 * main.ts only wires this module (IPC handlers + the OpenInLaunchContext
 * host adapters); it holds no open-in logic.
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

/** Host capabilities injected by main.ts; the module itself stays
 *  electron-free and unit-testable. A superset of VscodeLaunchContext —
 *  structurally compatible, so the vscode provider delegates to
 *  runVscodeLaunch directly. */
export interface OpenInLaunchContext {
  /** Host platform (`process.platform` in production). */
  platform: string
  /** Registry lookup; null = the instance does not exist. `transport` must be
   * 'ssh' for the vscode provider (the vscode-remote URL is an ssh-transport
   * feature — v2 semantics, design 17 §2; runVscodeLaunch re-checks it). */
  lookupInstance(id: string): { id: string; host: string; user: string | null; sshPort: number | null; transport: string } | null
  /** VS Code availability (the main-process probe, see detectVscodeAvailability). */
  vscodeAvailable(): boolean
  /** Open a vscode:// URL (main-process shell.openExternal wrapper; loud failure). */
  openVscodeUrl(url: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Chamber setting `vscodeOpenInNewWindow` (design 16 §3.3): lazy per-launch
   *  read like vscodeAvailable; absent/undefined → bare URL (VS Code's own
   *  default reuse/replace policy). Passed through to runVscodeLaunch by the
   *  vscode provider. */
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

/** One "how to launch" provider. available is a pure probe (no side effects —
 *  never spawns, never executes); host facts come from the injected ctx for
 *  both negotiation and execution, so every provider follows one path and the
 *  gate stays unit-testable on any machine. OS-resident apps ignore the arg. */
export interface OpenInApp {
  readonly id: string
  /** Renderer presentation category; unlike id, this is intentionally
   * extensible and keeps future providers from being mislabeled as Finder. */
  readonly displayKind: string
  /** Whether remote-instance (ssh-source) paths can be opened: only the vscode
   *  family is true (vscode://vscode-remote/). */
  readonly remoteCapable: boolean
  available(ctx: OpenInLaunchContext): boolean
  open(req: { instanceId: string; path: string }, ctx: OpenInLaunchContext): Promise<OpenInResult>
}

/**
 * The vscode provider: wraps runVscodeLaunch with zero behavior change — the
 * existing pipeline (registry lookup → authority construction → availability
 * re-check → openVscodeUrl, design 16 §3.4) runs untouched. The injected
 * OpenInLaunchContext is a structural superset of VscodeLaunchContext, so the
 * context passes straight through.
 */
const vscodeApp = Object.freeze<OpenInApp>({
  id: 'vscode',
  displayKind: 'vscode',
  remoteCapable: true,
  // The probe is the injected main-process fact (same real detection as the
  // renderer-facing apps() negotiation) — injectable in tests, so the ok-path
  // cases never depend on whether the machine has VS Code installed.
  available: (ctx) => ctx.vscodeAvailable(),
  open: (req, ctx) => runVscodeLaunch(req, ctx),
})

/**
 * The fixed-order registry. Batch 3 Phase 2, revised by design 20 §2.2:
 * vscode only — the local file manager and every other local application come
 * from the instance's own chamber host domain
 * (`@dsh-chamber/dsh-chamber-seed-open-in`), which the client plugin reaches
 * over that instance's generic RPC (the instance performs those launches; the
 * main process never regains a local-execution surface).
 */
const openInApps: readonly OpenInApp[] = Object.freeze([vscodeApp])

/** Whitelist lookup by id; a non-string appId (untrusted IPC payload) is
 *  never guessed — it resolves to null like any unknown id. */
export function getOpenInApp(appId: string): OpenInApp | null {
  if (typeof appId !== 'string') return null
  return openInApps.find(app => app.id === appId) ?? null
}

/**
 * Capability negotiation for the renderer (apps()): the full registry in
 * fixed order, each app projected to
 * {id, displayKind, remoteCapable, available}. Every provider receives the
 * same injected context; negotiation never
 * branches on a provider id. This preserves the registry contract that a new
 * provider is added in one place without editing the dispatcher.
 */
export function listOpenInApps(
  ctx: OpenInLaunchContext,
  reportProbeError: OpenInProbeErrorReporter = () => {},
): OpenInAppInfo[] {
  return openInApps.map(app => ({
    id: app.id,
    displayKind: app.displayKind,
    remoteCapable: app.remoteCapable,
    // A broken provider probe fails closed independently; one provider never
    // erases the complete capability projection for unrelated providers.
    available: (() => {
      try {
        return app.available(ctx)
      } catch (error) {
        // apps() has no per-entry error field. A broken probe therefore fails
        // closed for that app without rejecting the whole capability list.
        try { reportProbeError(app.id, describeUnknownError(error)) } catch { /* logging must not erase the list */ }
        return false
      }
    })(),
  }))
}

/**
 * The single open-in execution pipeline (any IPC entry point shares it):
 * 1. appId whitelist lookup — unknown (incl. non-string) → loud error;
 * 2. instanceId validation — mirror of runVscodeLaunch's symmetric gate
 *    ('local' reserved + INSTANCE_ID_PATTERN, security-review P2-3);
 * 3. path validation — validateRemotePath hoisted INTO the pipeline (not just
 *    per-provider), so a future provider can never hand an unvalidated string
 *    to its host wrapper; the validated path is what the provider receives
 *    (its own re-validation stays as harmless defense in depth);
 * 4. remoteCapable gate — a non-local instance against a local-only app is
 *    refused before the provider even runs;
 * 5. availability re-check via the injected ctx (defense in depth — vscode's
 *    runVscodeLaunch has its own second check inside, keeping the double
 *    guard);
 * 6. delegate to the provider.
 * Every failure is loud; there is no silent success path.
 */
export async function runOpenInLaunch(
  req: OpenInRequest,
  ctx: OpenInLaunchContext,
): Promise<OpenInResult> {
  const app = getOpenInApp(req.appId)
  if (app === null) {
    // Never stringify an untrusted non-string value: a Proxy/toString trap
    // must not turn the structured error channel into a rejection.
    const appIdLabel = typeof req.appId === 'string' ? req.appId : '<invalid>'
    return { ok: false, error: `unknown open-in app: ${appIdLabel}` }
  }
  if (typeof req.instanceId !== 'string' || (req.instanceId !== 'local' && !INSTANCE_ID_PATTERN.test(req.instanceId))) {
    return { ok: false, error: 'invalid instance id' }
  }
  // design 21 M4: local workspaces may be Windows drive/UNC paths; remote dsh
  // session paths are always POSIX.
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
