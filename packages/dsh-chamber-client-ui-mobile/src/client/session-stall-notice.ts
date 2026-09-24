/**
 * The stall notice's presentation surface: its style tag, class names, geometry
 * and stylesheet. The ladder DECISION lives in
 * @dsh-chamber/dsh-stream-state; nothing here decides anything.
 */

/** The notice's own marker (same naming family as the nav toggle/backdrop). */
export const STALL_STYLE_TAG = 'dsh-chamber-mobile-stall'
export const STALL_NOTICE_CLASS = 'dsh-mobile-stall'
export const STALL_NOTICE_MESSAGE_CLASS = 'dsh-mobile-stall-message'
export const STALL_NOTICE_ACTION_CLASS = 'dsh-mobile-stall-action'
export const STALL_NOTICE_DISMISS_CLASS = 'dsh-mobile-stall-dismiss'

/** Gap between the session header and the notice (px). */
export const STALL_NOTICE_GAP_PX = 8

/** When the header anchor is clamped, this much of the notice stays on screen
 *  (px) — the notice is never positioned off the bottom edge. */
export const STALL_NOTICE_MIN_VISIBLE_PX = 96

import { TOUCH_TIER_QUERY } from './composer.ts'

/** Double-install guard (the official-hover-card.ts pattern); declared with the
 *  notice surface and imported by the installer. */
export const STALL_GUARD: unique symbol = Symbol.for('dsh-chamber.dsh-client-ui-mobile.session-stall')

/**
 * The notice's CSS (self-contained: styles.ts is not extendable from this
 * module). The default display: none is OUTSIDE the tier media query on
 * purpose — the declarative half of the PC-leak guard.
 */
export const STALL_NOTICE_CSS = `
/* Mobile-only surface: invisible outside the touch tier, the same default the
   nav toggle and backdrop carry (the official shell.overlay layer renders
   entries unconditionally; here the element is only ever mounted while the
   tier matches, so this is the second, declarative half of that guard). */
.dsh-mobile-stall {
  display: none;
}

@media ${TOUCH_TIER_QUERY} {
  .dsh-mobile-stall {
    position: fixed;
    /* Fallback anchor: clear of the floating nav toggle band. The installer
       overwrites this with the session header's measured bottom whenever that
       rect is usable. */
    top: calc(env(safe-area-inset-top, 0px) + 56px);
    left: 50%;
    transform: translateX(-50%);
    /* Above the conversation content, BELOW the official shell.overlay layer
       (z-index 20 inside the frame: drawer, floating toggle, right panel; the
       frame itself creates no stacking context, so 19 < 20 still orders them). */
    z-index: 19;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: min(92vw, 26rem);
    padding: 8px 8px 8px 12px;
    border-radius: 12px;
    background: var(--dsw-alias-bg-layer-2);
    color: var(--dsw-alias-label-primary);
    box-shadow: 0 4px 16px rgb(0 0 0 / 18%);
    font-size: 13px;
    line-height: 18px;
    /* The notice never blocks the page: only its action takes taps. */
    pointer-events: none;
  }
  .dsh-mobile-stall-message {
    flex: 1;
    min-width: 0;
  }
  .dsh-mobile-stall-action {
    flex: none;
    pointer-events: auto;
    /* The same 44px touch floor the rest of this package's controls carry: a
       tap target, not a text link. */
    min-height: 44px;
    box-sizing: border-box;
    padding: 6px 10px;
    border: none;
    border-radius: 8px;
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
    font: inherit;
    white-space: nowrap;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-appearance: none;
    appearance: none;
  }
  .dsh-mobile-stall-action:active {
    background: var(--dsw-alias-interactive-bg-active);
  }
  .dsh-mobile-stall-action:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary);
  }
  /* The dismiss half ("keep waiting"): the same hit box, no filled surface —
     it must read as "the notice goes away", not as a second action to take. */
  .dsh-mobile-stall-dismiss {
    flex: none;
    pointer-events: auto;
    min-height: 44px;
    box-sizing: border-box;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--dsw-alias-label-secondary);
    font: inherit;
    white-space: nowrap;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-appearance: none;
    appearance: none;
  }
  .dsh-mobile-stall-dismiss:active {
    background: var(--dsw-alias-interactive-bg-hover);
  }
  .dsh-mobile-stall-dismiss:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary);
  }
}
`
