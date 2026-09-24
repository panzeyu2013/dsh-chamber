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
