/**
 * Boot-row composition (chamber patch, design 09 module D) — pure so the
 * per-instance host-graph extraRows merge is unit-testable without a DOM or a
 * full boot (test:client-web boot-rows case). The kernel adopts two entries
 * itself: `modules` (its record is pre-materialized as the module-system
 * bootstrap) and `ui-renderer` (its factory is shell-static, registered on the
 * shared module table — rc.8 baseline alignment); the manifest rows follow
 * minus those two, then the per-instance extra client-plugin rows from the
 * host boot graph.
 */

/** The modules package's own graph row id (kernel-adopted, never fetched). */
export const MODULES_ID = '@deepseek-ai/dsh-client-modules'

/** The ui-renderer package's own graph row id (kernel-adopted, never fetched).
 *  rc.8 moved the slot-renderer install and the application mount OUT of the
 *  shell into this row; the chamber kernel adopts it (page-own covered id —
 *  the host-graph merge filters it, chamber-entry never imports it) and the
 *  boot mounts through the `uiRenderer` service its apply provides. */
export const UI_RENDERER_ID = '@deepseek-ai/dsh-client-ui-renderer'

/**
 * Compose the loader rows in kernel order: the two kernel-adopted entries
 * first, then the manifest plugin ids minus those two, then the per-instance
 * extra ids. Pure — the caller owns the manifest/extra projections.
 * @param manifestIds - the boot manifest's plugin row ids.
 * @param extraIds - the per-instance host-graph extra row ids ([] when none).
 * @returns the ordered row id list the loader creates.
 */
export function composeBootRows(
  manifestIds: readonly string[],
  extraIds: readonly string[] = [],
): string[] {
  return [
    MODULES_ID,
    UI_RENDERER_ID,
    ...manifestIds.filter(id => id !== MODULES_ID && id !== UI_RENDERER_ID),
    ...extraIds,
  ]
}
