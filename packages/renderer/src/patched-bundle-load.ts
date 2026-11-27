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
 * ANCHOR-MISS POLICY (per entry, design 09 §4). A registered bundle whose anchors no
 * longer match is handled by the entry's `anchorMiss` policy: `refuse` keeps the
 * original fail-closed contract above (a plain rejection, so the instance boot fails);
 * `degrade-unpatched` (CORE official rows only) reports the miss through the optional
 * `deps.onAnchorMiss` and delegates to `deps.loadUnpatched(url)` — the untouched
 * script-element path of the shell, carried by the same 30s/BundleLoadTimeoutError
 * contract. `degrade-unpatched-optional` (optional profile rows only, design 09 §4
 * "第三方 profile 插件的装载期可选适配层") degrades on ANY failure BEFORE the patched
 * text executes — unreadable served text, a refused rewrite (witness/anchor/base-token
 * drift), or (when the caller provides `deps.compile`, as the shell always does) a patched
 * text that cannot compile (`SyntaxError` → `compile-failed`) or whose compile executor is
 * unavailable (anything else, e.g. a CSP-refused `new Function` `EvalError` →
 * `eval-unavailable`) — because an optional third-party
 * row must never turn a version/shape drift into a whole-instance boot failure. An
 * execution failure AFTER the patched text started running is not retried (a replay
 * could double-register the factory); the 30s loader timeout stays a loud failure. A degrade never runs the served text through `new Function`: a version-skewed bundle may be ESM-only and the resulting SyntaxError would turn the degrade back into a boot failure. The per-pin artifact verifier still requires exact anchors
 * for every entry; degrade only absorbs a load-time remote/local runtime line skew.
 *
 * PAGE BUDGET. `fetchPluginBundleText` takes `budget:'caller-held'` on the patched
 * load path: the loader kernel already acquired this dispatch's bundle slot BEFORE
 * calling `loadBundle` (bundleMax is 2 page-wide, so a nested acquisition could never
 * be granted while the kernel's own slot is held). `budget:'acquire'` is the identity
 * read path (runs outside any loader dispatch) and keeps the previous semantics.
 *
 * EXECUTION (patched text only). The registered bundles are classic scripts that
 * self-register through `window.__ModuleLoader__.load`; `executePatchedBundle` runs the
 * REWRITTEN text with `new Function(text + '//# sourceURL=…')()` — a function-body
 * scope (top-level declarations stay local) in sloppy mode (the upstream stock loader's
 * classic-script semantics). It depends on the page CSP `script-src 'unsafe-eval'` (the
 * control-plane page sends it) and iterates the URL through `sanitizeSourceUrl` so
 * U+2028/U+2029 cannot escape the sourceURL comment. A degrade row never reaches this
 * executor: it loads the served text through the untouched script-element path.
 */
import { httpBudgetLeaseFor, runWithHttpBudget } from '@dsh-chamber/dsh-chamber-client-core/http-budget'
import { sanitizeSourceUrl } from './client-plugin-patches.ts'

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

/** Anchor-miss policy of one loadable bundle patch. */
export type LoadableBundleAnchorMiss = 'refuse' | 'degrade-unpatched' | 'degrade-unpatched-optional'

/**
 * The structural patch contract the loader needs. Both tables satisfy it: the official
 * table (`client-plugin-patches.ts`, `refuse` / `degrade-unpatched`) and the optional
 * profile adapter table (`profile-plugin-registry.ts`, patch built by `profile-plugin-adapters.ts`, `degrade-unpatched-optional`).
 */
export interface LoadableBundlePatch {
  /** npm package id as it appears in the single-id combo bundle URL. */
  readonly packageId: string
  /** Why this patch exists and when it may be deleted (carried by diagnostics). */
  readonly reason: string
  /** Anchor/witness count for diagnostics (the loader never re-counts anchors). */
  readonly anchors: number
  /** Per-entry failure policy (see the module header). */
  readonly anchorMiss: LoadableBundleAnchorMiss
  /** Rewrite one served bundle text, or return null when the guards do not match. */
  apply(text: string): string | null
}

/** The loader contract inputs the shell supplies (injected so the contract is testable). */
export interface PatchedBundleLoadDeps {
  /** Reads the served bundle text (throws on any read failure). */
  readonly readText: (url: string) => Promise<string>
  /** Executes the patched classic script (throws when the text cannot run). */
  readonly execute: (text: string, url: string) => void
  /**
   * Loads one served bundle through the untouched script-element path (the degrade
   * fallback): the shell's own pre-patch loader, with its 30s deadline and
   * BundleLoadTimeoutError/bundleOutcome contract.
   */
  readonly loadUnpatched: (url: string) => Promise<void>
  /**
   * Reports an anchor miss on a `degrade-unpatched` row (diagnostic seam only; the load
   * itself continues through `loadUnpatched`). Optional: a degrade load must not depend
   * on a reporting sink.
   */
  readonly onAnchorMiss?: (info: { readonly packageId: string; readonly anchors: number; readonly url: string }) => void
  /**
   * Reports an optional-profile fallback decision (diagnostic seam only; the fallback
   * itself never depends on a sink). `reason` names the pre-execution failure class.
   */
  readonly onFallback?: (info: { readonly packageId: string; readonly reason: string; readonly url: string }) => void
  /**
   * Optional compile check for `degrade-unpatched-optional` rows (when the caller provides
   * it; the shell always does), run after the rewrite and before execution: a patched text that cannot compile degrades to the untouched
   * script path instead of rejecting the load. The shell supplies a `new Function`
   * compile (no execution); a compile failure is a pre-execution failure class, named
   * `compile-failed` for a `SyntaxError` and `eval-unavailable` for any other throw
   * (the compile executor itself is unavailable, e.g. the page CSP refuses eval).
   */
  readonly compile?: (text: string) => void
  /** Builds the loader's timeout error; must carry the still-pending outcome. */
  readonly createTimeoutError: (message: string, bundleOutcome: Promise<boolean>) => Error
  readonly setTimeout: (callback: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
  /** One loader budget for the whole read+execute operation. */
  readonly timeoutMs: number
}

/**
 * Load one registered bundle through its patch: read the SERVED text, rewrite it, and
 * execute the result; when the anchors no longer match, apply the entry's policy —
 * `refuse` rejects (a kept-row failure makes the instance's whole shell boot fail, with
 * a `bundle-load-failed` diagnostic carrying the patch's reason and anchor count),
 * `degrade-unpatched` reports through `deps.onAnchorMiss` and loads the served text
 * through the untouched script path (`deps.loadUnpatched`); `degrade-unpatched-optional`
 * also absorbs read/rewrite/compile failures the same way (optional rows never fail the
 * instance boot pre-execution).
 * @param url - the served bundle URL.
 * @param patch - the registered patch for that bundle (official or optional-profile).
 * @param deps - text reader, executor(s), reporting sinks, timers and the timeout error factory.
 * @returns resolves when the patched bundle executed, or the degrade fallback settled.
 */
export function loadPatchedBundle(url: string, patch: LoadableBundlePatch, deps: PatchedBundleLoadDeps): Promise<void> {
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
    const optional = patch.anchorMiss === 'degrade-unpatched-optional'
    /** Degrade an optional-profile row to the untouched script-element path. */
    const fallback = async (reason: string): Promise<void> => {
      try { deps.onFallback?.({ packageId: patch.packageId, reason, url }) } catch { /* diagnostics never break the load */ }
      await deps.loadUnpatched(url)
    }
    void (async (): Promise<void> => {
      let text: string
      try {
        text = await deps.readText(url)
      } catch (error) {
        if (!optional) throw error
        await fallback('read-failed')
        return
      }
      let patched: string | null
      try {
        patched = patch.apply(text)
      } catch (error) {
        if (!optional) throw error
        await fallback('rewrite-threw')
        return
      }
      if (patched === null) {
        if (optional) {
          // Optional profile row: witness/anchor/token drift must never fail the instance boot.
          await fallback('guards-mismatched')
          return
        }
        if (patch.anchorMiss === 'degrade-unpatched') {
          // Core-row degrade: delegate to the untouched script-element path. Running the
          // served text through `new Function` could turn an ESM-only skewed bundle into a
          // SyntaxError and thus into the very boot failure degrade exists to avoid.
          try { deps.onAnchorMiss?.({ packageId: patch.packageId, anchors: patch.anchors, url }) } catch { /* diagnostics never break the load */ }
          await deps.loadUnpatched(url)
          return
        }
        // fail-closed (official optional rows): a served bundle whose anchors no longer
        // match must not run unpatched (it would send the owner-only upload to the
        // control-plane root). The refusal names the patch's reason and anchor count.
        throw new Error(
          'dsh-chamber: runtime patch for ' + patch.packageId + ' matched no unique anchor (anchors: '
          + String(patch.anchors) + ') in ' + url
          + '; refusing to load the unpatched bundle — ' + patch.reason,
        )
      }
      if (optional && deps.compile !== undefined) {
        try {
          deps.compile(patched)
        } catch (error) {
          // A patched text that cannot compile is a pre-execution failure: the untouched
          // script path preserves the plugin's original (broken-config) behavior. Only a
          // SyntaxError implicates the REWRITTEN TEXT; any other throw means the compile
          // executor itself is unavailable (for example the page CSP refuses `new Function`),
          // so the diagnostic names that class instead of blaming the rewrite.
          await fallback(error instanceof SyntaxError ? 'compile-failed' : 'eval-unavailable')
          return
        }
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
