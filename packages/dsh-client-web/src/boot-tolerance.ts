/**
 * React-free decision rules behind the chamber version-tolerance seams
 * (design 09 §3.3, 2026-08): the boot kernel's extra-row degrade (boot.ts
 * assertEntriesActive / runPluginBoot) and the renderer-install adoption
 * adjudication (a chamber-owned install adopting an already-installed slot
 * renderer — the rule is retained for any chamber-side install path; the rc.8
 * shell itself no longer installs the renderer, the composite-covered
 * ui-renderer row does).
 *
 * Why a separate module: boot.ts cannot load under plain
 * node (DOM), but the tolerance POLICY is the load-bearing contract of
 * the rc.8 regression fix — so the rules live here, fully self-contained
 * (zero runtime imports), and are unit-tested under plain node by
 * `packages/dsh-client-web/test/boot-tolerance.test.ts` (node:test, run via
 * `pnpm run test:client-web`).
 *
 * The rules mirror the pre-extraction behavior EXACTLY (including the
 * failure-report strings); extraction is a testability refactor, not a
 * behavior change.
 */

/**
 * One loader entry's projected fiber label (the STATE_LABELS face), or
 * undefined when the entry is fiberless (its import failed — Entry._init
 * logged and returned, so no status event ever fires for it).
 */
export type SweepFiberLabel =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'disposed'
  | 'unloading'
  | undefined

/**
 * Verdict for ONE loader entry in the post-await sweep (assertEntriesActive).
 *
 * - `ok` — the entry is usable. Manifest rows and the app-shell assembly
 *   must be ACTIVE; a tolerated (extra) row is OK whenever it RAN, because
 *   its features being present is all the shell promised.
 * - `degraded` — a tolerated extra row that did not activate: the status
 *   store marks it 'failed', the boot continues. Version skew = absent
 *   features, not corruption (design 09 §3.3) — a backend of a newer/older
 *   dsh may ship rows this shell cannot run.
 * - `fatal` — a manifest row or the app-shell assembly failed to activate:
 *   the boot fails loud, listing the exact reason (the sweep is also the
 *   fail-loud compensation for cordis inject waiting, which has no timeout).
 */
export type SweepVerdict =
  | { kind: 'ok' }
  | { kind: 'degraded' }
  | { kind: 'fatal'; reason: string }

export function classifySweepEntry(
  name: string,
  fiberLabel: SweepFiberLabel,
  toleratedIds: ReadonlySet<string>,
  pendingMissing: readonly string[],
): SweepVerdict {
  if (toleratedIds.has(name)) {
    // Tolerated row: report, never fail the boot (see SweepVerdict).
    return fiberLabel === 'active' ? { kind: 'ok' } : { kind: 'degraded' }
  }
  if (fiberLabel === undefined) {
    return { kind: 'fatal', reason: `${name}: import failed (see console for the import error)` }
  }
  if (fiberLabel === 'active') return { kind: 'ok' }
  if (fiberLabel === 'pending') {
    // A required service never arrived — cordis inject waiting has no
    // timeout, so this sweep is the fail-loud compensation.
    return {
      kind: 'fatal',
      reason: `${name}: pending (waiting for service${pendingMissing.length === 1 ? '' : 's'}: ${pendingMissing.join(', ') || 'unknown'})`,
    }
  }
  return { kind: 'fatal', reason: `${name}: ${fiberLabel}` }
}

/**
 * The exact substring the runtime's boot-once renderer install throws with
 * (vendor `@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts`
 * SlotRegistry.install — "slot renderer already installed (install() is
 * boot-once)"; the SlotRegistry moved there with the v0.1.2-alpha.1 runtime
 * split). A backend dsh
 * may move the install into its OWN graph row (rc.8's `dsh-client-ui-renderer`
 * does); whichever install runs second throws this, and the tolerant reading
 * adopts the already-installed renderer (same createSlotRenderer contract).
 *
 * ANY other error is a real bug in this shell's own install and must fail the
 * boot loud — the string match is fail-safe by construction: a backend that
 * changes the message simply rethrows and boots loud instead of adopting.
 */
const RENDERER_ALREADY_INSTALLED = 'slot renderer already installed'

export function classifyRendererInstallError(error: unknown): 'adopt' | 'fatal' {
  return error instanceof Error && error.message.includes(RENDERER_ALREADY_INSTALLED) ? 'adopt' : 'fatal'
}
