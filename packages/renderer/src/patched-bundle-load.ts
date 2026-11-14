/**
 * Loading half of the page-level runtime plugin patches (design 09 §4): read one
 * registered served bundle through the page HTTP budget, apply the pure patch table
 * (`client-plugin-patches.ts`), and execute the result — with the loader contract the
 * module system expects. The shell owns only the dispatch and the real dependencies.
 *
 * CONTRACT (mirrors the script-element path in shell.ts so the module-system kernel
 * cannot tell the two apart): one loader budget (`deps.timeoutMs`); on expiry reject
 * `deps.createTimeoutError(message, bundleOutcome)` where the still-pending operation
 * keeps the tombstone outcome (late success executes the bundle and resolves the
 * outcome TRUE, late failure FALSE — exactly like a late script `load`/`error` event);
 * every other failure is a plain rejection that host-graph reports as
 * `bundle-load-failed`. Double settlement is guarded.
 *
 * PAGE BUDGET. `fetchPluginBundleText` takes `budget:'caller-held'` on the patched
 * load path: the loader kernel already acquired this dispatch's bundle slot BEFORE
 * calling `loadBundle` (bundleMax is 2 page-wide, so a nested acquisition could never
 * be granted while the kernel's own slot is held). `budget:'acquire'` is the identity
 * read path (runs outside any loader dispatch) and keeps the previous semantics.
 *
 * EXECUTION. The registered bundles are classic scripts that self-register through
 * `window.__ModuleLoader__.load`; `executePatchedBundle` runs the text with
 * `new Function(text + '//# sourceURL=…')()` — a function-body scope (top-level
 * declarations stay local) in sloppy mode (the upstream stock loader's classic-script
 * semantics). It depends on the page CSP `script-src 'unsafe-eval'` (the control-plane
 * page sends it) and iterates the URL through `sanitizeSourceUrl` so U+2028/U+2029
 * cannot escape the sourceURL comment.
 */
import { httpBudgetLeaseFor, runWithHttpBudget } from '@dsh-chamber/dsh-chamber-client-core/http-budget'
import { sanitizeSourceUrl, type ClientPluginPatch } from './client-plugin-patches.ts'

/** Text cap for one served plugin bundle read (a plugin bundle, not an asset dump). */
export const BUNDLE_TEXT_MAX_BYTES = 4 * 1024 * 1024

/** How one plugin-bundle text read participates in the page HTTP budget. */
export type BundleTextRead =
  /** The read acquires its own page-budget slot (identity reads run outside a dispatch). */
  | { readonly budget: 'acquire'; readonly sourceId: string; readonly timeoutMs: number }
  /** The caller already holds this dispatch's page-budget slot (the loader kernel). */
  | { readonly budget: 'caller-held'; readonly timeoutMs: number }

/**
 * Fetch one served plugin bundle's text: same-origin through the instance proxy, bounded
 * in size and time. Only a JavaScript body is a bundle (an error page / JSON answer must
 * never be patched or compare equal across two hosts). Throws on every failure kind so
 * the caller can distinguish a load failure from an unverifiable identity read.
 * @param url - the served bundle URL.
 * @param options - budget participation and the read deadline.
 * @returns the response body text.
 */
export async function fetchPluginBundleText(url: string, options: BundleTextRead): Promise<string> {
  const read = async (): Promise<string> => {
    const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs) })
    if (!response.ok) {
      throw new Error(`dsh-chamber: plugin bundle ${url} answered HTTP ${response.status}`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!/(?:java|ecma)script/i.test(contentType)) {
      throw new Error(`dsh-chamber: plugin bundle ${url} is not JavaScript (${contentType || 'no content-type'})`)
    }
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > BUNDLE_TEXT_MAX_BYTES) {
      throw new Error(`dsh-chamber: plugin bundle ${url} declares ${declared} bytes (cap ${BUNDLE_TEXT_MAX_BYTES})`)
    }
    const text = await response.text()
    if (text.length > BUNDLE_TEXT_MAX_BYTES) {
      throw new Error(`dsh-chamber: plugin bundle ${url} exceeds the ${BUNDLE_TEXT_MAX_BYTES}-byte text cap`)
    }
    return text
  }
  if (options.budget === 'caller-held') return await read()
  return await runWithHttpBudget({
    sourceId: options.sourceId,
    kind: 'bundle',
    lane: 'background',
    leaseMs: httpBudgetLeaseFor(options.timeoutMs),
    // Queue rather than refuse on a momentarily busy page: the boot is about to
    // decide interchangeability, and a budget refusal must not become a source fact.
    queueDeadlineAt: Date.now() + 1_500,
    label: 'plugin-identity:' + url,
  }, read)
}

/** The loader contract inputs the shell supplies (injected so the contract is testable). */
export interface PatchedBundleLoadDeps {
  /** Reads the served bundle text (throws on any read failure). */
  readonly readText: (url: string) => Promise<string>
  /** Executes the patched classic script (throws when the text cannot run). */
  readonly execute: (text: string, url: string) => void
  /** Builds the loader's timeout error; must carry the still-pending outcome. */
  readonly createTimeoutError: (message: string, bundleOutcome: Promise<boolean>) => Error
  readonly setTimeout: (callback: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
  /** One loader budget for the whole read+execute operation. */
  readonly timeoutMs: number
}

/**
 * Load one registered bundle through its patch: read the SERVED text, rewrite it
 * (fail-closed on a missing/duplicated anchor), execute it. The rejection/diagnostic
 * contract is the loader's own (see the module header): a kept-row failure makes the
 * instance's whole shell boot fail, with a `bundle-load-failed` diagnostic carrying
 * the patch's reason and anchor count.
 * @param url - the served bundle URL.
 * @param patch - the registered patch for that bundle.
 * @param deps - text reader, executor, timers and the timeout error factory.
 * @returns resolves when the patched bundle executed (factory registration included).
 */
export function loadPatchedBundle(url: string, patch: ClientPluginPatch, deps: PatchedBundleLoadDeps): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let requestSettled = false
    let operationSettled = false
    let timer: unknown
    let settleOutcome!: (loaded: boolean) => void
    const bundleOutcome = new Promise<boolean>((resolveOutcome) => { settleOutcome = resolveOutcome })
    const settle = (loaded: boolean, action: () => void): void => {
      if (operationSettled) return
      operationSettled = true
      deps.clearTimeout(timer)
      settleOutcome(loaded)
      if (!requestSettled) {
        requestSettled = true
        action()
      }
    }
    // Same contract as the script-element path: a hung read fails THIS load loud, while
    // the still-pending operation keeps its tombstone outcome for the loader to observe
    // (late success executes the bundle and settles the outcome loaded, exactly like a
    // late script `load` event).
    timer = deps.setTimeout(() => {
      if (requestSettled) return
      requestSettled = true
      reject(deps.createTimeoutError(
        `dsh-chamber: patched bundle ${url} timed out after ${deps.timeoutMs}ms`,
        bundleOutcome,
      ))
    }, deps.timeoutMs)
    void (async (): Promise<void> => {
      const text = await deps.readText(url)
      const patched = patch.apply(text)
      // fail-closed: a served bundle whose anchors no longer match must not run unpatched
      // (it would send the owner-only upload to the control-plane root). The refusal names
      // the patch's reason and anchor count so the bundle-load-failed diagnostic is usable.
      if (patched === null) {
        throw new Error(
          'dsh-chamber: runtime patch for ' + patch.packageId + ' matched no unique anchor (anchors: '
          + String(patch.anchors) + ') in ' + url
          + '; refusing to load the unpatched bundle — ' + patch.reason,
        )
      }
      deps.execute(patched, url)
    })().then(
      () => { settle(true, resolve) },
      (error: unknown) => { settle(false, () => { reject(error) }) },
    )
  })
}

/**
 * Execute one patched classic bundle in the page. The bundle self-registers through
 * `window.__ModuleLoader__.load` exactly like the script-element path; the appended
 * `sourceURL` keeps stack traces attributable and is stripped of every LineTerminator
 * (U+2028/U+2029 included) so the URL cannot escape the comment.
 * @param text - the patched bundle text.
 * @param url - the bundle URL (stack attribution only; never executed).
 */
export function executePatchedBundle(text: string, url: string): void {
  new Function(text + '\n//# sourceURL=' + sanitizeSourceUrl(url))()
}
