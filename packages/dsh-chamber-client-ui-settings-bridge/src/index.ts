/**
 * Settings bridge host half: nothing to do in the host process — the bridge
 * is a renderer-only surface (per-instance proxy RPCs need no host wiring).
 */

export function apply(): void {}
