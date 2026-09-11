/**
 * Disclosure attributes for a settings row whose switch unfolds a card
 * (2026-09-11 review-fix F3).
 *
 * WHY this is not a JSX prop pair on a wrapper element: `aria-expanded` is only
 * supported on role-bearing interactive elements — ARIA 1.2 lists application /
 * button / checkbox / combobox / gridcell / link / listbox / menuitem / row /
 * rowheader / tab / treeitem, with `switch` inheriting it from `checkbox` — and
 * NOT on a role-less `<span>` (role `generic`), which is where this row used to
 * carry it: assistive tech had no element to read it from. Any wrapper role that
 * DOES support the attribute is a widget, and a widget wrapping the switch would
 * nest two interactive controls (axe `nested-interactive`), so the pair belongs
 * on the control that actually unfolds the card — the switch's own button, which
 * is also where upstream keeps it (ui-primitives `DisclosureRow`'s role=button
 * row, ui-primitives `PluginCard`'s header button).
 *
 * The official `Switch` renders exactly that button (`<button type="button"
 * role="switch" aria-checked aria-label>`) but exposes only `{checked, onChange,
 * label, disabled, title, className}` — no attribute pass-through, and
 * ui-primitives is a different package, out of this package's scope. The owning
 * component therefore applies the pair to the primitive's rendered node through
 * this function (see `DisclosureSwitch` in GeneralView.tsx for the lookup and
 * test/upstream-alignment-locks.test.ts for the primitive contract it relies on:
 * the primitive's root element IS the `role="switch"` button). If a future
 * upstream `Switch` accepts these attributes as props, delete this module and
 * pass them there.
 *
 * Kept free of React and of the DOM types' surface so a plain node test can
 * drive it with a fake node — this package's tests run without a DOM.
 */

/** The slice of an element this module writes to (a real HTMLElement satisfies it). */
export interface DisclosureAttributeTarget {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

/**
 * Write the disclosure relationship onto the switch's control node.
 *
 * `aria-expanded` is always written (both `'true'` and `'false'` are real states
 * of the disclosure, and its absence would mean "does not control anything").
 * `aria-controls` is written only while the unfolded card exists: the collapsed
 * render omits the card element, so keeping a stale id would point at nothing.
 * @param node - the primitive's control node, or null when it is not attached.
 * @param expanded - whether the row's card is currently unfolded.
 * @param controls - the id of the unfolded card, or undefined while collapsed.
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
