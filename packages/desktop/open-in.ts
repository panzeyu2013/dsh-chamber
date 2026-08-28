/**
 * open-in registry — the generic "open this source's path in an app" launch
 * surface (desktop main process). This is the M0+M1 generalization of the
 * VS Code deep-link module (design 16): vscode becomes ONE provider of a
 * registry whose apps are looked up by id, and the finder provider opens the
 * local file manager for the local instance.
 *
 * The registry mirrors two established philosophies:
 * - transport-provider.ts's "new source = new provider": each app is a
 *   self-contained provider (`OpenInApp`) registered once in a fixed-order
 *   list; the pipeline never guesses or falls back — an unknown appId is a
 *   loud `unknown open-in app` error.
 * - deep-link.ts's injection-test shape: the module is electron-free by
 *   construction (imports only node built-ins + INSTANCE_ID_PATTERN and the
 *   deep-link core), and every host capability (registry lookup, vscode
 *   availability/url-open, fs stat, shell open/reveal) is injected via
 *   OpenInLaunchContext, so the pure-Node test suite (open-in.test.ts) runs
 *   without electron or any third-party dependency.
 *
 * Responsibilities:
 * - getOpenInApp / listOpenInApps: id lookup + capability negotiation
 *   (id / displayKind / remoteCapable / available) for the renderer UI.
 * - runOpenInLaunch: the single execution pipeline shared by any IPC entry
 *   point — appId whitelist → instanceId validation (mirror of
 *   runVscodeLaunch's symmetric gate) → path validation (validateRemotePath
 *   hoisted into the pipeline) → remoteCapable gate → availability re-check
 *   via the injected ctx (defense in depth; vscode's runVscodeLaunch has its
 *   own re-check inside, keeping the double guard) → app.open. Every failure
 *   is loud, never a silent success.
 * - normalizeOpenPathError: the shell.openPath success/error boundary as a
 *   testable pure function.
 *
 * main.ts only wires this module (IPC handlers + the OpenInLaunchContext
 * host adapters); it holds no open-in logic.
 */

import { INSTANCE_ID_PATTERN } from './transport-provider.ts'
import { describeUnknownError, runVscodeLaunch, validateRemotePath } from './deep-link.ts'

/** A normalized open-in launch request (renderer IPC payload, untrusted). */
export interface OpenInRequest {
  appId: string
  instanceId: string
  path: string
  /** IPC producer's exact non-secret source identity (validated by main). */
  sourceFingerprint?: string
}

/** Host capabilities injected by main.ts (stat/openPath/showItemInFolder are
 *  electron shell/fs wrappers); the module itself stays electron-free and
 *  unit-testable. A superset of VscodeLaunchContext — structurally
 *  compatible, so the vscode provider delegates to runVscodeLaunch directly. */
export interface OpenInLaunchContext {
  /** Host platform (`process.platform` in production). */
  platform: string
  /** Registry lookup; null = the instance does not exist. */
  lookupInstance(id: string): { id: string; host: string; user: string | null; sshPort: number | null; kind: string } | null
  /** VS Code availability (the main-process probe, see detectVscodeAvailability). */
  vscodeAvailable(): boolean
  /** Open a vscode:// URL (main-process shell.openExternal wrapper; loud failure). */
  openVscodeUrl(url: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Host stat wrapper (follows symlinks in production). */
  stat(path: string): Promise<{ kind: 'dir' | 'file' } | null>
  /** shell.openPath wrapper: success (null or empty string) → null, failure → error string. */
  openPath(path: string): Promise<string | null>
  /** shell.showItemInFolder wrapper: reveal a file in the OS file manager. */
  showItemInFolder(path: string): void
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
 * Electron opens a directory through the desktop's default handler. On macOS,
 * LaunchServices may classify a directory as a package through an arbitrary
 * registered extension or package metadata, so no suffix deny-list can prove
 * it is an ordinary folder. The only complete safe policy is to reveal every
 * Darwin directory in Finder. Other platforms retain directory openPath.
 */
export function shouldRevealDirectoryInsteadOfOpen(platform: string): boolean {
  return platform === 'darwin'
}

/**
 * The finder provider: opens the OS file manager (常驻文件管理器 — always
 * present, so available is constant true). Local instance only — a remote
 * path has nothing to reveal in THIS machine's file manager, so any non-local
 * instanceId is refused loudly (defense in depth: the pipeline's
 * remoteCapable gate would already have refused, but the provider re-checks).
 * Path discipline mirrors deep-link (absolute / control-char-free / ≤ 4096 via
 * validateRemotePath); files are revealed. Directories use openPath outside
 * macOS; every macOS directory is revealed because LaunchServices package
 * classification cannot be exhaustively predicted from a suffix list.
 */
const finderApp = Object.freeze<OpenInApp>({
  id: 'finder',
  displayKind: 'file-manager',
  remoteCapable: false,
  available: () => true,
  async open(req, ctx) {
    if (req.instanceId !== 'local') {
      return { ok: false, error: 'finder is only available for the local instance' }
    }
    const validated = validateRemotePath(req.path)
    if (!validated.ok) return validated
    const entry = await ctx.stat(validated.path)
    if (entry === null) {
      return { ok: false, error: `path does not exist: ${validated.path}` }
    }
    if (entry.kind === 'dir') {
      if (shouldRevealDirectoryInsteadOfOpen(ctx.platform)) {
        ctx.showItemInFolder(validated.path)
        return { ok: true }
      }
      const error = await ctx.openPath(validated.path)
      if (error !== null) {
        return { ok: false, error: `open path failed: ${error}` }
      }
      return { ok: true }
    }
    ctx.showItemInFolder(validated.path)
    return { ok: true }
  },
})

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

/** The fixed-order registry — [finder, vscode] is the documented list order. */
const openInApps: readonly OpenInApp[] = Object.freeze([finderApp, vscodeApp])

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

/** Production stat adapter semantics: only a genuinely absent path maps to
 * null. Permission, I/O and hostile failures propagate to runOpenInLaunch's
 * structured provider boundary instead of masquerading as non-existence. */
export async function classifyLocalPath(
  stat: (path: string) => Promise<{ isDirectory(): boolean }>,
  path: string,
): Promise<{ kind: 'dir' | 'file' } | null> {
  try {
    const entry = await stat(path)
    return entry.isDirectory() ? { kind: 'dir' } : { kind: 'file' }
  } catch (error) {
    let code: unknown
    try {
      code = error !== null && typeof error === 'object'
        ? (error as { code?: unknown }).code
        : undefined
    } catch {
      throw error
    }
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

/**
 * Electron `shell.openPath` result normalization: the API resolves '' on
 * success and an error string on failure. '' / non-string → null (success);
 * a non-empty string → the error text. Extracted as an electron-free pure
 * function so the boundary is unit-testable (the wrapper lives in main.ts).
 */
export function normalizeOpenPathError(err: unknown): string | null {
  return typeof err === 'string' && err.length > 0 ? err : null
}

/** Complete Electron openPath adapter boundary, including its documented
 * resolved error string and platform-specific rejection paths. Returning only
 * the raw host error leaves the public prefix to finderApp exactly once. */
export async function invokeOpenPath(
  openPath: (path: string) => Promise<unknown>,
  path: string,
): Promise<string | null> {
  try {
    return normalizeOpenPathError(await openPath(path))
  } catch (error) {
    return describeUnknownError(error)
  }
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
  const validatedPath = validateRemotePath(req.path)
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
