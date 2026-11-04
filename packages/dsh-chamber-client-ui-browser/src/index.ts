/**
 * Host loader entry for the browser-only remote-browser plugin.
 *
 * The whole feature is a renderer client plugin: the right-sidebar tab type and
 * the launcher run in the composite page, and the trusted main process owns the
 * SSH forward + system-browser open. There is deliberately NO host half and no
 * seed (report v4 §2: a renderer workspace client package is loaded by the
 * composite; the remote instance needs nothing installed).
 */

/** Provides no host-side behavior. */
export function apply(): void {}
