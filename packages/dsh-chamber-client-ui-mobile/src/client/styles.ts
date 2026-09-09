/**
 * Mobile adaptation stylesheet (design 17 §18.4.3/§18.4.5): a single global
 * sheet injected at apply() as `<style data-plugin="…">`. Anchors are the
 * OFFICIAL stable attributes confirmed against the dsh 0.1.2-alpha.4 DOM
 * (CDP empirical audit; ui-layout AppFrame byte-identical with the alpha.3
 * pin — alpha.4 anchor audit) plus the plugin's own `data-mobile-*`
 * stamps — no hashed class names. Production CSS-modules naming is
 * `_<local>_<hash>_<idx>` (verified on the production bundle), so
 * `[class$="_<local>"]` suffix selectors can never match — legacy suffix
 * rules predate that verification and are migrated to attribute anchors;
 * the documented exception is the hash-insensitive infix
 * `[class*="_<local>_"]` (settings section grids, see below).
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
 *    toolbar single line, popups constrained to the viewport, settings as a
 *    stacked full-screen sheet (nav strip + pinned close + scrolling
 *    options), section grids degraded, dialogs edge-capped, editable
 *    fields ≥16px (iOS focus zoom), safe-area guarantees.
 *  - `(pointer: coarse) and (hover: none)` — the width-independent CHROME
 *    tier (cross-check round): sticky-hover tooltip bubbles are a
 *    coarse-pointer artifact wherever the viewport is wide, so this one
 *    cosmetic rule is gated by pointer/hover alone (an iPad in landscape is
 *    1024px+ and still taps; attaching a mouse flips hover to `hover` and
 *    stands the rule down).
 * EVERY rule lives inside a media query — FINE-POINTER desktop widths are
 * byte-for-byte untouched (the official layout must not be affected), and the
 * hamburger has an explicit `display: none` default outside the touch tier.
 *
 * Empirical anchor notes (dsh 0.1.5-alpha.2, CDP audit):
 *  - `data-sidebar-collapsed` on the frame: present "true" when collapsed,
 *    REMOVED when expanded — `:not([data-sidebar-collapsed])` is the open
 *    drawer condition.
 *  - `data-rightbar-collapsed` is the alpha.2 rename of the details column
 *    flag; the right column is now a docking surface with its own
 *    `<768px` fullscreen presentation (upstream), so this stylesheet no
 *    longer re-presents it — the third track stays locked at 0 and the
 *    official surface owns the overlay.
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

/* ---- coarse-pointer chrome tier (width-independent) ---- */
/* Sticky-hover tooltip bubbles (official ui-primitives Tooltip, bundle
   component Fd) are a coarse-pointer artifact, not a narrow-viewport one: a
   tap synthesizes the trigger's mouseenter but the mouseleave only arrives
   with the NEXT tap elsewhere, so the delayed (200-500ms) bubble pops after
   the tap and STAYS over the control that was just used (发送/停止 included).
   The rule is therefore gated by pointer/hover ALONE — an iPad in landscape
   is 1024px+ and still taps, while attaching a mouse flips hover to hover
   and correctly restores hover tooltips — and is scoped to bubbles that
   DUPLICATE an accessible name: button[aria-label] + [role="tooltip"]
   (the component renders the bubble as the trigger's immediate next sibling;
   [data-side] is the component's own marker — see the preserved list below).
   Of the 31 official Tooltip sites, 27 are aria-labelled buttons (composer
   send/stop/commands/ContextMeter, queue dock, goal bar, sidebar, message
   feedback, workspace rows, chat copy/branch) whose aria-label names the same
   action (3 of them phrase it slightly differently — workspace search ×2,
   trajectory load-earlier — same semantics; verified against the 0.1.2-rc.1
   install, 2026-12 cross-check). Four informational bubbles are deliberately
   NOT hidden because their trigger has no accessible duplicate: the chat
   stats line (ui-chat:3853, ellipsized non-focusable div), the agent-preset
   card description (ui-agent-preset:960, line-clamp:4), the trajectory
   timeline span (ui-trajectory:6821, aria-hidden, no click path) and the
   trajectory kind tag at ≤620px (ui-trajectory:5554, visible label collapsed)
   — they keep the sticky-hover quirk rather than lose content a touch user
   cannot otherwise read. The tree's fifth role="tooltip" producer (ui-chat
   turn-rail preview, :1735) is a non-button div WITHOUT data-side and is
   therefore structurally outside this rule (it is aria-describedby-referenced
   and its rail is container-hidden ≤900px anyway). Desktop is untouched
   (media-query scoped). */
@media (pointer: coarse) and (hover: none) {
  button[aria-label] + [role="tooltip"][data-side] {
    display: none !important;
  }
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
    z-index: 75;
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
    z-index: 74;
    background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24));
    -webkit-backdrop-filter: var(--dsw-mask-blur, blur(2px));
    backdrop-filter: var(--dsw-mask-blur, blur(2px));
    border: none;
    padding: 0;
  }

  /* Drag handles are desktop affordances (mouse resizing) — hidden on
     touch where the drawer/overlay geometry replaces them. Anchored on the
     official attribute seams: the AppFrame resize strips carry
     [data-side] (no role), the conversation width strips carry
     [data-width-handle]; the ui-primitives Tooltip bubble also carries
     [data-side] for placement and must NOT be hidden (role="tooltip"
     exclusion). Attribute anchors replace the legacy hashed-suffix rules
     ([class$="_handle"]) that cannot match production class naming.
     FUTURE-FRAGILE ANCHOR NOTE (2026-12 audit): the [data-side] exclusion
     was verified safe across the whole tree at audit time — no other
     [data-side] carriers beyond the AppFrame handles / width strips /
     role="tooltip" bubbles; re-grep [data-side] when the vendored base
     moves before trusting this rule. */
  [data-mobile-frame] [data-width-handle],
  [data-mobile-frame] [data-side]:not([role="tooltip"]) {
    display: none !important;
  }
  /* Dockkit split affordances: pointer-drag chrome with no touch equivalent
     (the right surface is fullscreen on this tier). */
  [data-mobile-frame] [data-dockkit-divider],
  [data-mobile-frame] [data-dockkit-split-button] {
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
    left: max(10px, env(safe-area-inset-left, 0px));
    z-index: 76;
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

  /* Conversation session header: the floating toggle (44px, top-left) must
     never overlap the header content. The header is the DIRECT child of the
     session-header slot outlet (anchor-audited shape: outlet wrapper >
     <header> > titleRow [+ tabs]) — a structural selector, no hashed
     classes. The gutter reserves the toggle box plus an 8px gap; padding on
     the header (not the title row) also clears the tab strip when a session
     has multiple views. */
  [data-mobile-frame] [data-slot="conversation.session.header"] > header {
    padding-left: calc(62px + env(safe-area-inset-left, 0px)) !important;
  }

  /* Crumbs/lineage chain: wrap instead of clip. The official .crumbs row is
     nowrap + overflow hidden (desktop-width assumption): on a phone a long
     title chain or the lineage chips ("N 个子代理" catalog triggers) get
     silently CUT (the observed truncated/collapsed header labels). Wrapping
     keeps every crumb segment and chip on its own line; per-crumb ellipsis
     (official .crumb max-width) still bounds single titles. */
  [data-mobile-frame] [data-slot="conversation.session.header"] nav {
    flex-wrap: wrap;
    overflow: visible;
    white-space: normal;
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

  /* Keyboard compensation (composer.ts installKeyboardCompensation, IME
     ladder layer 5): engines that ignore 'interactive-widget=resizes-content'
     (iOS Safari, older Android WebViews) keep the LAYOUT viewport full-height
     when the soft keyboard opens, so the official sticky composer seat —
     pinned to the scrollport's layout bottom — ends up BEHIND the keyboard.
     The installer mirrors resizes-content semantics against the visual
     viewport: while the keyboard is open it raises the seat's sticky bottom
     to the keyboard top AND pads the conversation scrollport by the same
     offset, so the message tail can scroll up beside the raised seat instead
     of hiding under the keyboard. State rides the plugin's own frame stamp:
     'data-mobile-kbd' + the '--dsh-mobile-kbd-offset' custom property on the
     stamped frame (never official attributes). Android Chrome WITH the token
     shrinks the layout viewport itself: covered height ≈ 0, the installer
     never arms, these rules stay inert. */
  [data-mobile-frame][data-mobile-kbd] [data-phase="active"] [data-conversation-scroll] {
    padding-bottom: var(--dsh-mobile-kbd-offset, 0px) !important;
  }
  [data-mobile-frame][data-mobile-kbd] [data-phase="active"] [data-composer-seat] {
    bottom: var(--dsh-mobile-kbd-offset, 0px) !important;
    /* The phone-tier safe-area padding (below) is home-indicator spacing for
       the UNCOVERED state; while the keyboard is up that inset sits behind
       the keyboard and would add up to ~34px of dead space below the raised
       seat (cross-check). Zeroing it cannot cause overlap: the lift comes
       from the keyboard geometry, not from the inset. */
    padding-bottom: 0 !important;
  }

  /* iOS focus zoom: ANY editable field below 16px auto-zooms the page on
     focus and the page STAYS zoomed. The composer, settings fields and dialog
     fields already carry the floor; the drawer's session search (13px,
     ui-workspace:1187) and inline rename (14px, :531) were the gap — a
     focus-zoom there used to leave the composer behind the keyboard for the
     rest of the session (cross-check P1). */
  [data-mobile-role="sidebar"] input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),
  [data-mobile-role="sidebar"] textarea {
    font-size: max(16px, var(--dsh-content-font-size, 16px)) !important;
  }
}

/* ---- phone tier (design 17 §18.4.2/§18.4.3) ---- */
@media (max-width: 768px) and (pointer: coarse) {
  /* Composer toolbar: one line. The official row wraps; force nowrap (the
     official 12px gap is kept — no gap override). */
  [data-slot="conversation.composer.bar"] [class*="_row_"] {
    flex-wrap: nowrap !important;
  }
  [data-slot="conversation.composer.bar"] [class*="_row_"] [class*="_trigger_"],
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

  /* Settings sheet (official ui-settings-general shell): the desktop modal
     is 800px wide and flex-row — a fixed 188px nav RAIL + content column.
     A phone needs the sheet stacked: the nav becomes a top strip (title +
     horizontally scrolling section chips), the content header row (actions
     + Close) stays pinned and only the section options scroll under it.
     All anchors are structural (panel [role=dialog][aria-modal] carrying
     the settings.header seat; direct nav/content children) — the :has()
     anchor is scoped to aria-modal dialogs, so its invalidation cost stays
     off the streaming conversation subtree (design 17 §18.4.4 records
     :has() as a per-DOM-change cost; this selector only re-evaluates when a
     modal dialog subtree changes). A 100vh fallback precedes 100dvh for
     older engines. */
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) {
    position: fixed !important;
    inset: 0 !important;
    width: 100vw !important;
    max-width: none !important;
    height: 100vh !important;
    height: 100dvh !important;
    max-height: none !important;
    border-radius: 0 !important;
    flex-direction: column !important;
  }
  /* Nav rail → top strip: title + chips row, safe-area padded. */
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) > nav {
    flex: none;
    flex-direction: row;
    align-items: center;
    gap: 4px;
    width: auto;
    padding:
      calc(8px + env(safe-area-inset-top))
      calc(8px + env(safe-area-inset-right))
      2px
      calc(12px + env(safe-area-inset-left));
    overflow: hidden;
  }
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) > nav > div:first-child {
    flex: none;
    padding-right: 6px;
  }
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) > nav > div:last-child {
    display: flex;
    flex-direction: row;
    gap: 2px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    /* The chip strip is a tab bar, not a document: no visible scrollbar
       (Firefox scrollbar-width + Chromium/WebKit ::-webkit-scrollbar). */
    scrollbar-width: none;
  }
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) > nav > div:last-child::-webkit-scrollbar {
    display: none;
  }
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) > nav button {
    flex: none;
    min-height: 44px;
  }
  /* Content column: pin the header row (actions + Close) and let only the
     options area scroll (the earlier shell rule scrolled the whole column —
     the Close button scrolled out of reach on a phone). The content column
     itself stays a FALLBACK scroller (overflow-y auto) instead of
     overflow:hidden: on the verified header+options child grammar the
     pinned header + inner options scroller fill the column exactly (no
     double scroll), while an upstream wrapper drift cannot hard-lock the
     sheet — the column scrolls and the sticky header keeps Close visible. */
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) > div:last-child {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) > div:last-child > div:first-child {
    flex: none;
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--dsw-alias-bg-layer-2, #ffffff);
  }
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) > div:last-child > div:last-child {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-right: calc(16px + env(safe-area-inset-right));
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
    padding-left: calc(16px + env(safe-area-inset-left));
  }
  /* Section inner grids that assume desktop width. Official inner cells
     carry no stable attribute — the [class*="_<local>_"] local-name match
     is the documented hash-insensitive exception (naming
     "_<local>_<hash>_<idx>" verified on the production bundle; a naming
     flip fails SOFT — the official grid stays).
     - Models provider row (two text inputs + chevron + trash on one
       4-column line) → TWO equal columns: the four children auto-place
       2×2 (inputs on the first row, the two icon actions under them).
     - ".cards" two-column grids → single column. Only ONE settings
       section is mounted at a time under [data-slot="settings.section"],
       so this reaches whichever page is open: the Plugins inventory
       (repeat(2, …) card grid) and, when the agent-presets section is
       active, its auto-fill .cards (already single-column at phone
       widths by auto-fit; forcing one column only changes 590-768px,
       where two ~268px cards would otherwise fit). */
  [data-slot="settings.section"] [class*="_modelRow_"] {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  [data-slot="settings.section"] [class*="_cards_"] {
    grid-template-columns: minmax(0, 1fr) !important;
  }
  /* Other aria-modal dialogs (onboarding steps, pickers) keep their own
     chrome but must never touch the screen edges. The settings sheet above
     is excluded (it owns the full screen). */
  [role="dialog"][aria-modal="true"]:not(:has([data-slot="settings.header"])) {
    max-width: calc(100vw - 24px) !important;
  }
  /* iOS focus zoom: any editable field below 16px triggers the automatic
     page zoom on focus. The composer already carries its own rule; the
     settings sheet and its dialogs get the same floor (respecting the
     official content-size preference when set larger). */
  [role="dialog"] input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),
  [role="dialog"] select,
  [role="dialog"] textarea {
    font-size: max(16px, var(--dsh-content-font-size, 16px)) !important;
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

  /* Scrolling body: contain the pull gesture. The composer seat is a FLOW
     child of this scroller (official rc.1: scrollBody > [session slot,
     composerSeat]), so the official sheet declares NO padding-bottom here —
     the bottom spacing lives on the InputBar root (8px) and the message
     column (16px), neither of which this rule touches. */
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
