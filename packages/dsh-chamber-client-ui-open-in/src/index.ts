/** Host loader entry for the browser-only open-in plugin. */

/** No host-side behavior: the launch runs in the desktop main process, and there
 *  is deliberately no host plugin / no seed — a local launch, never in-instance. */
export function apply(): void {}
