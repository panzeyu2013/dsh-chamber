/**
 * Local structural face of the official right-sidebar tab-type registry
 * (`ctx.sidebarRightTabs`) — the ONE service this plugin cannot declare in its
 * exported `inject` face.
 *
 * Why a local declaration: the plugin must register the Browser tab only on
 * the sources that show it, while the required-service probe reads each
 * plugin's exported `inject` array. Naming `sidebarRightTabs` there would make
 * an http source report a missing service even though the entry is deliberately
 * absent there (review round-2 repo-process B1). The probe is
 * therefore done at apply time with `ctx.get('sidebarRightTabs')`, and the
 * service face is declared here instead of being imported.
 *
 * Shape source (MUST be re-checked in W0 against the pinned tree):
 * `@deepseek-ai/dsh-client-ui-sidebar-browser/lib/client.js` (0.2.1-rc.2) —
 * register({ id, kind, multiple, priority?, title(address), guide[],
 * keepMounted? }), where guide entries are `{ id, order, title(), description(),
 * commandId?, icon? }` and clicking one calls
 * `tab.actions.openTab(entry.kind, { replaceTab: true })` inside ui-sidebar-right.
 * The task's register literal omitted `title`, but rc.2's placeTab calls
 * `definition.title(address)` when a tab is opened, so a type without a title
 * would throw at open time; this file includes it.
 *
 * TODO(W0/pin): confirm against 0.2.2-rc.1:
 *   1. does `title` remain mandatory, and is it called with the page address?
 *   2. are guide `title`/`description` functions (rc.2) or plain strings?
 *   3. is `priority` still optional and does the default band remain 'extension'?
 *   4. does `guide` still open the entry's kind on click (no command needed)?
 * If any answer changes, adjust this contract and the registration only.
 */

/** One guide entry: what the empty right pane offers. */
export interface SidebarRightTabGuideEntry {
  id: string
  order: number
  title: () => string
  description: () => string
}

/** The slice of a tab-type definition this plugin registers. */
export interface SidebarRightTabDefinition {
  id: string
  kind: string
  multiple: boolean
  title: (address: string) => string
  guide: readonly SidebarRightTabGuideEntry[]
}

/** The registry face probed at apply time. */
export interface SidebarRightTabsService {
  register(definition: SidebarRightTabDefinition): (() => void) | void
}

/**
 * Validate the probed service (`ctx.get` returns the raw value).
 *
 * @param value - the untyped service value.
 * @returns the registry face when `register` exists, else null.
 */
export function asSidebarRightTabs(value: unknown): SidebarRightTabsService | null {
  if (typeof value !== 'object' || value === null) return null
  let register: unknown
  try {
    register = (value as { register?: unknown }).register
  } catch {
    return null
  }
  return typeof register === 'function' ? (value as SidebarRightTabsService) : null
}
