/** Host loader entry for the browser-only VS Code deep-link plugin. */

/** Provides no host-side behavior; the VS Code launch runs in the desktop
 *  main process (design 16 — there is deliberately no host plugin / no seed:
 *  the action is a local launch, never an in-instance execution). */
export function apply(): void {}
