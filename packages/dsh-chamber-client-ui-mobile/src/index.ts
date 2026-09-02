/**
 * Host loader entry for the browser-only mobile adaptation plugin (design 17
 * §18). The gateway seed gate requires `dist/index.js` to exist; the host
 * half carries no server-side surface — the plugin adapts the official
 * frontend purely in the browser.
 */
export function apply(): void {}
