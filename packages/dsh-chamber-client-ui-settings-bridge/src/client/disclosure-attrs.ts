/**
 * Disclosure attributes for a settings row whose switch unfolds a card.
 *
 * WHY not a JSX prop pair on a wrapper: `aria-expanded` is only supported on
 * role-bearing interactive elements (ARIA 1.2: application / button / checkbox /
 * combobox / link / menuitem / row / tab / treeitem, `switch` inheriting from
 * `checkbox`) and NOT on a role-less `<span>` — assistive tech would have no element
 * to read it from. Any wrapper role that supports it is a widget, and a widget
 * wrapping the switch would nest two interactive controls (axe `nested-interactive`),
 * so the pair belongs on the control that actually unfolds the card — the switch's
 * own button, where upstream also keeps it.
 *
 * The official `Switch` renders exactly that button but exposes no attribute
 * pass-through, and ui-primitives is out of this package's scope, so the owning
 * component applies the pair to the primitive's rendered node through this function
 * (`DisclosureSwitch` in GeneralView.tsx). If a future upstream `Switch` accepts
 * these as props, delete this module. Kept free of React and of the DOM types'
 * surface so a plain node test can drive it with a fake node.
 */

/** The slice of an element this module writes to (a real HTMLElement satisfies it). */
export interface DisclosureAttributeTarget {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

/**
 * Write the disclosure relationship onto the switch's control node.
 *
 * `aria-expanded` is always written (absence would mean "does not control
 * anything"); `aria-controls` only while the unfolded card exists — the collapsed
 * render omits the card element, so a stale id would point at nothing.
 */
export function applyDisclosureAttributes(
  node: DisclosureAttributeTarget | null,
  expanded: boolean,
  controls: string | undefined,
): void {
  if (node === null) return
  node.setAttribute('aria-expanded', expanded ? 'true' : 'false')
  if (controls === undefined) node.removeAttribute('aria-controls')
  else node.setAttribute('aria-controls', controls)
}
