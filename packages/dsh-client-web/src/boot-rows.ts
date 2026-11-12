/**
 * Boot-row composition (chamber patch; pure, so the per-instance extraRows merge is
 * testable without a DOM). The kernel adopts `modules` (record pre-materialized as
 * the bootstrap) and `ui-renderer` (shell-static factory) itself; the manifest rows
 * follow minus those two, then the per-instance extra rows from the host boot graph.
 */

/** The modules package's own graph row id (kernel-adopted, never fetched). */
export const MODULES_ID = '@deepseek-ai/dsh-client-modules'

/** The ui-renderer graph row id (kernel-adopted, never fetched): it carries the
 *  slot-renderer install and the app mount, which the boot reaches through the
 *  `uiRenderer` service its apply provides. */
export const UI_RENDERER_ID = '@deepseek-ai/dsh-client-ui-renderer'

/**
 * Kernel-adopted loader entries whose inactivity fails the boot.
 *
 * rc.2 moved the audit to a required-name roster (packages/client/web/src/boot-client.ts:
 * "the minimum fatal set"). Re-derived for the chamber page it collapses to the kernel
 * rows: every other id in that roster is composite-covered — the composite statically
 * registers it and the host-graph merge drops its row (chamber-covered.ts) — so it can
 * never exist as a loader entry here, and a name absent from the manifest has no effect.
 * The page's build-time manifest row(s) are appended to the fatal set when the audit runs:
 * the manifest is built at build time (it carries only the chamber composite bundle), so
 * an inactive manifest row is corruption, not version skew. Per-instance extra rows are
 * host-graph facts that DO version-skew independently of this page, so they degrade
 * instead of failing the boot; the shell's required-service probe (renderer
 * required-extra-rows.ts) reports the gaps a degraded row leaves behind.
 */
export const REQUIRED_BOOT_ROW_IDS: readonly string[] = [MODULES_ID, UI_RENDERER_ID]

/** Compose the loader rows in kernel order (two adopted entries, then manifest ids
 *  minus those, then extras); the caller owns the projections. */
export function composeBootRows(
  manifestIds: readonly string[],
  extraIds: readonly string[] = [],
): string[] {
  const manifest = manifestIds.filter(id => id !== MODULES_ID && id !== UI_RENDERER_ID)
  // Dedupe WITHIN extras (a duplicate would reach loader.create twice); kernel/manifest
  // overlaps stay — the loader creates kernel rows first, first wins.
  const extras = extraIds.filter((id, index) => extraIds.indexOf(id) === index)
  return [MODULES_ID, UI_RENDERER_ID, ...manifest, ...extras]
}
