/**
 * N-CTX OWNER GUARD for the open-in menu (2026-09-11 upstream-alignment, T13).
 *
 * The menu itself is the official `Menu` primitive (`@deepseek-ai/dsh-client-ui-primitives`),
 * which already owns focus transfer (`autoFocus`), roving arrow/Home/End
 * navigation, Escape-to-anchor, outside-pointer dismissal, placement, row
 * density, fill selection and item icons — the bespoke 458-line menu this module
 * used to serve implemented those semantics by hand.
 *
 * What the primitive cannot know is THIS shell's shape: one page holds one
 * `.instance-view` per attached source, inactive views are hidden through
 * `instance-hidden` / `instance-pending` classes (plus `hidden` /
 * `aria-hidden`), and the menu's open state lives in the component above the
 * primitive. A view can therefore lose its interaction surface while a menu
 * that belongs to it is still open — the leftover open state would be revealed
 * together with the view, and a keystroke aimed at the visible view could
 * still commit against the hidden one. Closing on owner loss is the one piece
 * of this menu that is genuinely N-ctx, so it is the only piece kept here.
 */

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** The owned `.instance-view` of one chamber shell. */
const INSTANCE_VIEW_SELECTOR = '.instance-view'

/**
 * DOM-independent snapshot of the trigger and its owning instance view. The
 * component reads these facts from the document; keeping the decision pure
 * makes the fail-closed rule deterministic to test even though this package
 * deliberately has no browser-DOM test dependency.
 */
export interface MenuOwnerSnapshot {
  triggerConnected: boolean
  ownerConnected: boolean
  ownerContainsTrigger: boolean
  ownerIsInstanceView: boolean
  ownerHasInactiveClass: boolean
  ownerHidden: boolean
  ownerAriaHidden: boolean
  rendered: boolean
}

/**
 * Decide whether the owning instance view may still host interaction.
 * @param snapshot - the facts read from the trigger and its owner.
 * @returns true only when every fact is positively satisfied (fail-closed).
 */
export function menuOwnerAllowsInteraction(snapshot: MenuOwnerSnapshot): boolean {
  return snapshot.triggerConnected &&
    snapshot.ownerConnected &&
    snapshot.ownerContainsTrigger &&
    snapshot.ownerIsInstanceView &&
    !snapshot.ownerHasInactiveClass &&
    !snapshot.ownerHidden &&
    !snapshot.ownerAriaHidden &&
    snapshot.rendered
}

/** The owning `.instance-view` of a trigger, or null when the trigger is not
 *  inside one (a bare document cannot vouch for the trigger's liveness). */
function owningInstanceView(trigger: HTMLElement | null): HTMLElement | null {
  return trigger?.closest<HTMLElement>(INSTANCE_VIEW_SELECTOR) ?? null
}

function elementIsRendered(element: HTMLElement): boolean {
  try {
    if (typeof element.checkVisibility === 'function') {
      return element.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true })
    }
    const view = element.ownerDocument.defaultView
    if (view === null) return false
    for (let current: HTMLElement | null = element; current !== null; current = current.parentElement) {
      const style = view.getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
        return false
      }
    }
    return true
  } catch {
    // DOM visibility is an execution guard here, not cosmetic metadata: an
    // unexpected browser/realm failure closes the menu rather than guessing.
    return false
  }
}

/**
 * Read the owner snapshot for one trigger element.
 * @param trigger - the menu's anchor element inside the instance view.
 * @returns the snapshot fed to {@link menuOwnerAllowsInteraction}.
 */
function ownerSnapshotFor(trigger: HTMLElement | null): MenuOwnerSnapshot {
  const owner = owningInstanceView(trigger)
  return {
    triggerConnected: trigger?.isConnected === true,
    ownerConnected: owner?.isConnected === true,
    ownerContainsTrigger: trigger !== null && owner !== null && owner.contains(trigger),
    ownerIsInstanceView: owner?.matches(INSTANCE_VIEW_SELECTOR) === true,
    ownerHasInactiveClass:
      owner?.classList.contains('instance-hidden') === true || owner?.classList.contains('instance-pending') === true,
    ownerHidden: owner?.hasAttribute('hidden') === true,
    ownerAriaHidden: owner?.getAttribute('aria-hidden') === 'true',
    rendered: trigger !== null && owner !== null && elementIsRendered(trigger) && elementIsRendered(owner),
  }
}

/**
 * Watch only the trigger's ancestor chain while the menu is open. This catches
 * the owning instance view's active/hidden class transition and every possible
 * disconnect point without observing unrelated streaming DOM.
 * @param trigger - the watched anchor.
 * @param onLost - invoked once the owner stops allowing interaction.
 * @returns the observer's disconnect function.
 */
function observeOwnerLifetime(trigger: HTMLElement, onLost: () => void): () => void {
  const Observer = trigger.ownerDocument.defaultView?.MutationObserver
  if (Observer === undefined) {
    onLost()
    return () => undefined
  }

  const watched = new Set<Node>()
  for (let current: Node | null = trigger; current !== null; current = current.parentNode) {
    watched.add(current)
  }

  const observer = new Observer((records) => {
    const ancestorAttributeChanged = records.some(record => record.type === 'attributes')
    const ownerChainRemoved = records.some(record =>
      Array.from(record.removedNodes).some(removed =>
        Array.from(watched).some(watchedNode => removed === watchedNode || removed.contains(watchedNode)),
      ),
    )
    if (ancestorAttributeChanged || ownerChainRemoved || !menuOwnerAllowsInteraction(ownerSnapshotFor(trigger))) {
      onLost()
    }
  })

  for (const node of watched) {
    if (node.nodeType === 1) {
      observer.observe(node, {
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
        childList: true,
      })
    } else {
      observer.observe(node, { childList: true })
    }
  }
  return () => observer.disconnect()
}

/**
 * Close the menu as soon as its owning instance view stops allowing
 * interaction, and refuse to stay open in a view that is already inactive.
 *
 * Dismissal is a plain state removal: React flushes an update scheduled by the
 * observer callback in a microtask, which runs before the next input task, so
 * no pointerdown can reach a menu the owner has already lost.
 * @param open - whether the menu is currently open.
 * @param anchorRef - ref of the element the menu is anchored to.
 * @param onLost - close callback (state owner).
 */
export function useInstanceViewDismissal(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  onLost: () => void,
): void {
  const lostRef = useRef(onLost)
  lostRef.current = onLost
  useEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    if (anchor === null || !menuOwnerAllowsInteraction(ownerSnapshotFor(anchor))) {
      lostRef.current()
      return
    }
    const dismiss = (): void => { lostRef.current() }
    return observeOwnerLifetime(anchor, dismiss)
  }, [open, anchorRef])
}
