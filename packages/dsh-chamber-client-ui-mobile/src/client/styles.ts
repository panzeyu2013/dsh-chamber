/**
 * Mobile adaptation stylesheet (design 17 §18.4.3/§18.4.5): a single global
 * sheet injected at apply() as `<style data-plugin="…">`. Anchors are the
 * OFFICIAL stable attributes confirmed against the dsh 0.1.2-alpha.4 DOM
 * (CDP empirical audit; ui-layout AppFrame byte-identical with the alpha.3
 * pin — alpha.4 anchor audit) plus the plugin's own `data-mobile-*`
 * stamps — no hashed class names except the `[class$="_…"]` suffix
 * convention where the official DOM exposes no attribute.
 *
 * VISUAL LANGUAGE: everything rides the official `--dsw-*`/`--ds-*` tokens
 * (no literal colors except token fallbacks); the drawer reuses the official
 * sidebar surface (no repainted background), the hamburger uses the official
 * interactive/hover tokens, motion uses the official ease/duration tokens,
 * and the drawer gets the official elevation shadow. Dark theme follows
 * automatically through the official token flip — the plugin never touches
 * color-scheme.
 *
 * Breakpoints (design 17 §18.4.2):
 *  - `(max-width: 1023px) and (pointer: coarse)` — the touch tier: the
 *    sidebar rail becomes an overlay drawer, the details column is hidden,
 *    the conversation takes the full width, touch targets get the 44px
 *    floor. The `pointer: coarse` guard is the "PC leak" lesson (a desktop
 *    window narrower than 1024 must NOT get the mobile UI) — applied to
 *    BOTH tiers and mirrored in the JS behavior layer.
 *  - `(max-width: 768px) and (pointer: coarse)` — the phone tier: composer
 *    toolbar single line, popups constrained to the viewport, settings
 *    full-screen, safe-area guarantees.
 * EVERY rule lives inside a media query — desktop widths are byte-for-byte
 * untouched (the official layout must not be affected), and the hamburger
 * has an explicit `display: none` default outside the touch tier.
 *
 * Empirical anchor notes (dsh 0.1.2-alpha.4, CDP audit):
 *  - `data-sidebar-collapsed` on the frame: present "true" when collapsed,
 *    REMOVED when expanded — `:not([data-sidebar-collapsed])` is the open
 *    drawer condition.
 *  - `data-details-collapsed` same semantics.
 *  - ONBOARDING/directory dialogs portal to a body-level root
 *    (`div._root_15u5s_2`), but the SETTINGS dialog renders INSIDE the
 *    sidebar DOM (sidebar.settings slot, no body portal) — the drawer's
 *    open state therefore uses `transform: none` (an identity transform
 *    would still create a containing block and trap the settings sheet at
 *    the drawer's width).
 *  - The composer is a Lexical `div[contenteditable][data-composer-input]` —
 *    there is NO textarea.
 */

export const MOBILE_CSS = `
/* The mobile-only UI (hamburger, backdrop) defaults to hidden OUTSIDE the
   touch tier — the official shell.overlay layer renders entries
   unconditionally, so without this default desktop browsers would see an
   unstyled ghost button (design 17 §18.4.2 "PC leak" invariant, applied to
   the overlay entries). */
.dsh-mobile-nav-toggle,
.dsh-mobile-backdrop {
  display: none;
}

/* ---- touch tier: tablet/phone touch (design 17 §18.4.2) ---- */
@media (max-width: 1023px) and (pointer: coarse) {
  /* Three-column frame → single column; the sidebar leaves the grid flow
     entirely (it becomes the fixed drawer below). The grid tracks are
     explicitly locked so the center column is never squeezed into a 0-width
     track by the fixed sibling. IMPORTANT (P1-C): the official AppFrame
     sets NO explicit grid-column — with the sidebar fixed (out of flow),
     auto-placement would put conversation into track 1 (0px) and details
     into track 2 (full width). Both remaining columns must be pinned
     explicitly. */
  [data-mobile-frame] {
    grid-template-columns: 0 minmax(0, 1fr) 0 !important;
  }
  [data-mobile-role="conversation"] {
    grid-column: 2;
  }
  [data-mobile-role="details"] {
    grid-column: 3;
  }

  /* Sidebar → fixed overlay drawer, off-canvas by default. translateX(-105%)
     keeps the shadow out of view; the open state is driven purely by the
     official frame attribute (no JS state, no React). Motion uses the
     official tokens (--ds-ease-in-out / --ds-transition-duration-slow) and
     is disabled under prefers-reduced-motion. visibility hides the closed
     drawer from the tab order (WCAG 2.4.3 — off-canvas content must not be
     focusable) with a 0s delay so the close animation still plays. The
     official elevation shadow separates the drawer from the conversation. */
  [data-mobile-role="sidebar"] {
    position: fixed !important;
    top: 0 !important;
    bottom: 0 !important;
    left: 0 !important;
    z-index: 40;
    width: min(86vw, 280px) !important;
    box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0, 0, 0, 0.08));
    transform: translateX(-105%);
    visibility: hidden;
    transition:
      transform var(--ds-transition-duration-slow, 0.3s) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
      visibility 0s 0.3s;
  }
  [data-mobile-frame]:not([data-sidebar-collapsed]) [data-mobile-role="sidebar"] {
    transform: none;
    visibility: visible;
    transition:
      transform var(--ds-transition-duration-slow, 0.3s) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
      visibility 0s;
  }
  @media (prefers-reduced-motion: reduce) {
    [data-mobile-role="sidebar"] {
      transition: none;
    }
  }

  /* Drawer backdrop: dims the conversation behind the open drawer and — by
     sitting above it (z-39 < drawer 40) — absorbs stray taps on the ~50px
     live seam right of the drawer (the composer send button must not be
     hit while the drawer is open). Tap on the backdrop closes the drawer
     (the toggle component wires the click). */
  [data-mobile-frame]:not([data-sidebar-collapsed]) .dsh-mobile-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 39;
    background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24));
    -webkit-backdrop-filter: var(--dsw-mask-blur, blur(2px));
    backdrop-filter: var(--dsw-mask-blur, blur(2px));
    border: none;
    padding: 0;
  }

  /* Details column → right-side overlay when opened (data-details-collapsed
     removed): the official details/trajectory panel stays reachable on
     touch. Design §18.4.3 offers two variants (bottom sheet / Status tab);
     this implementation uses a THIRD form — a right-side overlay that
     keeps the official DOM untouched (zero re-implementation). The grid's
     third track stays 0 — the fixed column overlays the conversation.
     transform: none while open (same containing-block rule as the
     drawer). */
  [data-mobile-role="details"] {
    position: fixed !important;
    top: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    z-index: 38;
    width: min(86vw, 320px) !important;
    box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0, 0, 0, 0.08));
    transform: translateX(105%);
    visibility: hidden;
    transition:
      transform var(--ds-transition-duration-slow, 0.3s) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
      visibility 0s 0.3s;
  }
  [data-mobile-frame]:not([data-details-collapsed]) [data-mobile-role="details"] {
    transform: none;
    visibility: visible;
    transition:
      transform var(--ds-transition-duration-slow, 0.3s) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)),
      visibility 0s;
  }
  @media (prefers-reduced-motion: reduce) {
    [data-mobile-role="details"] {
      transition: none;
    }
  }

  /* Drag handles are desktop affordances (mouse resizing) — hidden on
     touch where the drawer/overlay geometry replaces them. */
  [data-mobile-frame] [class$="_widthHandle"],
  [data-mobile-frame] [class$="_handle"] {
    display: none !important;
  }

  /* Floating drawer toggle: the official sidebar toggle lives inside the
     sidebar DOM, which the off-canvas transform hides — this shell.overlay
     entry is the mobile entry point. Hidden again while the drawer is open
     (the drawer's own header carries the close control). The default
     display: none outside this tier kills the desktop ghost button — the
     official overlay layer renders entries unconditionally. Visual language
     follows the official icon buttons: transparent base, hover/active
     fills from the alias tokens, focus ring in the business-primary color. */
  .dsh-mobile-nav-toggle {
    position: fixed;
    top: max(10px, env(safe-area-inset-top, 0px));
    left: 10px;
    z-index: 41;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border: none;
    border-radius: 12px;
    background: transparent;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-appearance: none;
    appearance: none;
  }
  .dsh-mobile-nav-toggle:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
  }
  .dsh-mobile-nav-toggle:active {
    background: var(--dsw-alias-interactive-bg-active, rgba(0, 0, 0, 0.08));
  }
  .dsh-mobile-nav-toggle:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #4176e6);
  }
  .dsh-mobile-nav-toggle-bars,
  .dsh-mobile-nav-toggle-bars::before,
  .dsh-mobile-nav-toggle-bars::after {
    display: block;
    width: 20px;
    height: 2px;
    border-radius: 2px;
    background: var(--dsw-alias-label-primary, #0f1115);
  }
  .dsh-mobile-nav-toggle-bars { position: relative; }
  .dsh-mobile-nav-toggle-bars::before,
  .dsh-mobile-nav-toggle-bars::after {
    content: '';
    position: absolute;
    left: 0;
  }
  .dsh-mobile-nav-toggle-bars::before { top: -6px; }
  .dsh-mobile-nav-toggle-bars::after { top: 6px; }
  [data-mobile-frame]:not([data-sidebar-collapsed]) .dsh-mobile-nav-toggle {
    display: none;
  }

  /* Touch targets: high-frequency controls get the 44px floor (Apple HIG;
     WCAG 2.5.8 ≥24px is exceeded). The official toolbar/sidebar buttons are
     28-36px (desktop-mouse sizes) — unusable on touch. Icon-only buttons
     also get a width floor; text buttons (composer bar) keep their natural
     width. Menu/popup items and settings entries get the same floor. */
  [data-slot="conversation.composer.bar"] button,
  [data-slot="sidebar"] button,
  [data-slot="conversation.session.header.actions"] button,
  [data-slot="settings.section"] button,
  [role="menuitem"], [role="option"] {
    min-height: 44px;
  }
  [data-slot="sidebar"] button,
  [data-slot="conversation.session.header.actions"] button,
  [role="menuitem"], [role="option"] {
    min-width: 44px;
  }

  /* touch-action: the composer contenteditable and inputs get
     manipulation (no double-tap zoom), but textareas MUST keep auto — a
     manipulation textarea swallows the caret/scroll (design §18.4.3
     note). */
  [contenteditable="true"], input:not([type="range"]) {
    touch-action: manipulation;
  }
  textarea {
    touch-action: auto;
  }

  /* No double-tap zoom / tap highlight noise; keep text scaling intact. */
  html {
    -webkit-tap-highlight-color: transparent;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }
}

/* ---- phone tier (design 17 §18.4.2/§18.4.3) ---- */
@media (max-width: 768px) and (pointer: coarse) {
  /* Composer toolbar: one line. The official row wraps; force nowrap (the
     official 12px gap is kept — no gap override). */
  [data-slot="conversation.composer.bar"] [class$="_row"] {
    flex-wrap: nowrap !important;
  }
  [data-slot="conversation.composer.bar"] [class$="_row"] [class$="_trigger"],
  [data-slot="conversation.input.model"] button {
    max-width: 112px !important;
    flex: 0 1 auto !important;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Popups (command menu, model menu, context pickers) never overflow the
     viewport horizontally. */
  [role="menu"], [role="listbox"], [data-trigger-menu] {
    max-width: calc(100vw - 24px) !important;
  }

  /* Settings dialog → full-screen sheet with its own scrolling; the
     official 800px dialog is unusable on a phone. The :has() anchor is fine
     here: this rule is static (no per-DOM-change re-evaluation hot path).
     A 100vh fallback precedes 100dvh for older engines. */
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) {
    position: fixed !important;
    inset: 0 !important;
    width: 100vw !important;
    max-width: none !important;
    height: 100vh !important;
    height: 100dvh !important;
    max-height: none !important;
    border-radius: 0 !important;
  }
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) nav {
    padding: calc(10px + env(safe-area-inset-top)) 12px 10px !important;
  }
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) > div:last-child {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: env(safe-area-inset-bottom);
  }

  /* Composer seat: respect the home-indicator inset. The official seat is
     sticky inside the scroll body; the padding keeps the input above the
     gesture bar. */
  [data-composer-seat] {
    padding-bottom: env(safe-area-inset-bottom);
  }

  /* iOS focus zoom: the composer must not trigger the automatic 16px
     minimum zoom on focus. max(16px, ...) keeps the official content-size
     preference (--dsh-content-font-size) when the user set it larger. */
  [data-composer-input] {
    font-size: max(16px, var(--dsh-content-font-size, 16px)) !important;
  }

  /* Conversation header: allow the title cluster to wrap instead of
     overflowing (the official row assumes desktop width). */
  [data-slot="conversation.session.header"] [class$="_titleRow"] {
    flex-wrap: wrap;
  }

  /* Scrolling body: the official padding-bottom for the composer is a
     variable; keep it sane on short screens. */
  [data-conversation-scroll] {
    overscroll-behavior-y: contain;
  }
}
`

/** The canonical viewport meta tokens the plugin ensures are present
 *  (design 17 §18.4.3): `viewport-fit=cover` for safe-area insets and
 *  `interactive-widget=resizes-content` (Android Chrome 108+) so the
 *  keyboard squeezes the layout viewport and the sticky composer floats
 *  above it. user-scalable is NOT locked (WCAG 1.4.4) — the focus-zoom
 *  prevention lives in the CSS above. */
export const VIEWPORT_TOKENS = ['viewport-fit=cover', 'interactive-widget=resizes-content']

/** The plugin's style-tag identity (matches the inject guard). */
export const PLUGIN_STYLE_TAG = 'dsh-chamber-client-ui-mobile'
