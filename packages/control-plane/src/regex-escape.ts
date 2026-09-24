/**
 * One literal-to-regexp escape shared by the control plane's fail-closed text
 * matchers (the cordis loader-scalar counter and the reaper's command-line
 * token match). A leaf so the two consumers cannot drift.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
