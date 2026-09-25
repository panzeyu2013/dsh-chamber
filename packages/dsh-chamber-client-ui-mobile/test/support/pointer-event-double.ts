/**
 * Minimal PointerEvent double for the mobile package's plain-node DOM suites.
 *
 * `dispatchBoundaryLeave` constructs the boundary event with the REAL
 * `PointerEvent` constructor and no fallback chain, so a Node process with no
 * DOM globals installs this double instead of the watchdog silently downgrading
 * to MouseEvent/Event. It extends the platform `Event`, so the dispatched event
 * keeps real bubbling/cancelable semantics and carries the init fields the
 * atom's delegated listener reads.
 */

/** The init subset the watchdog passes (a real PointerEventInit is wider). */
export interface PointerEventInitDouble {
  bubbles?: boolean
  cancelable?: boolean
  composed?: boolean
  relatedTarget?: unknown
}

export class PointerEventDouble extends Event {
  readonly relatedTarget: unknown
  constructor(type: string, init: PointerEventInitDouble = {}) {
    super(type, init)
    this.relatedTarget = init.relatedTarget ?? null
  }
}

/** Install the double as the global `PointerEvent`; returns the restore. */
export function installPointerEventDouble(): () => void {
  const globals = globalThis as { PointerEvent?: unknown }
  const previous = globals.PointerEvent
  globals.PointerEvent = PointerEventDouble
  return () => {
    if (previous === undefined) delete globals.PointerEvent
    else globals.PointerEvent = previous
  }
}
