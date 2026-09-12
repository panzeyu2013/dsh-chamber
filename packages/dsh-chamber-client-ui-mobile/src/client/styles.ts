/**
 * Mobile adaptation stylesheet (design 17 §18.4.3/§18.4.5): a single global
 * sheet injected at apply() as `<style data-plugin="…">`. Anchors are the
 * OFFICIAL stable attributes confirmed against the dsh 0.1.5-alpha.2 DOM
 * (CDP empirical audit, re-anchored when the vendored pin moved — that audit
 * generation is alpha.2; at the current pin 0.1.5-rc.2 those emitting files are
 * unchanged (re-checked across rc.1 → rc.2), so the anchors still hold: the centre
 * column is the keyed `main` slot, the right column is `rightbar`, and the
 * frame carries `data-sidebar-collapsed` / `data-rightbar-collapsed`) plus
 * the plugin's own `data-mobile-*` stamps — no hashed class names except the
 * documented local-name exception below.
 *
 * CROSS-PACKAGE STYLING HOOKS: anchors are attributes, never classes — a
 * class emitted by another package is hashed per bundle and cannot be targeted
 * from here. That rule is why the sidebar's git-action hook is the
 * `data-git-action` attribute (2026-09-11 upstream-alignment) rather than the
 * global class it used to be; this header is the package that states it. Production CSS-modules naming in the
 * instance bundle is `[hash]_[local]` (upstream cssModules pattern, verified
 * on the shipped 0.1.5-rc.1 bundles: `JObwrW_row`, `zGbnIq_modelRow`,
 * `qSYn7G_cards`; the emitting packages are untouched at 0.1.5-rc.2), so a local
 * name is matched by SUFFIX through
 * `:is([class$="_<local>"], [class*="_<local> "])` — the second arm covers
 * elements that carry several classes, where the local name is not last.
 * The earlier `[class*="_<local>_"]` infix form matched NOTHING in production:
 * `_<local>_<hash>_<idx>` is the CHAMBER shell's own Vite naming, never the
 * instance bundle's, so the phone-tier composer row, the model row and the
 * settings card grids silently kept their desktop geometry (2026-09 audit).
 *
 * VISUAL LANGUAGE: everything rides the official `--dsw-*`/`--ds-*` tokens
 * (no literal colors except token fallbacks); the drawer reuses the official
 * sidebar surface (no repainted background), the floating drawer toggle draws
 * the official `IconPanelLeftOutline16` glyph (the official sidebar toggle's
 * own control) in the official rail ink (`--dsw-alias-label-primary`, the
 * collapsed-sidebar icon ink, ui-sidebar SidebarRoot.module.css) with the
 * official interactive/hover tokens, motion uses the official ease/duration
 * tokens, and the drawer gets the official elevation shadow. Dark theme
 * follows automatically through the official token flip — the plugin never
 * touches color-scheme.
 *
 * Breakpoints (design 17 §18.4.2):
 *  - `(max-width: 1023px) and (pointer: coarse)` — the touch tier: the
 *    sidebar rail becomes an overlay drawer, a shown right panel is presented
 *    fullscreen (and the drawer yields to it), the conversation takes the
 *    full width, touch targets get the 44px floor. The `pointer: coarse`
 *    guard is the "PC leak" lesson (a desktop window narrower than 1024 must
 *    NOT get the mobile UI) — applied to BOTH tiers and mirrored in the JS
 *    behavior layer.
 *  - `(max-width: 768px) and (pointer: coarse)` — the phone tier: composer
 *    toolbar single line, popups constrained to the viewport, settings as a
 *    stacked full-screen sheet (nav strip + pinned close + scrolling
 *    options), the Models provider row degraded, editable fields ≥16px
 *    (iOS focus zoom), safe-area guarantees. Dialogs other than the settings
 *    sheet are NOT touched: every remaining official `aria-modal` producer
 *    already fits the viewport itself (2026-09-11 upstream-alignment T6 —
 *    see the phone-tier note at the popup rule).
 *  - `(pointer: coarse) and (hover: none)` — the width-independent CHROME
 *    tier (cross-check round): sticky-hover tooltip bubbles are a
 *    coarse-pointer artifact wherever the viewport is wide, so this one
 *    cosmetic rule is gated by pointer/hover alone (an iPad in landscape is
 *    1024px+ and still taps; attaching a mouse flips hover to `hover` and
 *    stands the rule down).
 * EVERY rule lives inside a media query — FINE-POINTER desktop widths are
 * byte-for-byte untouched (the official layout must not be affected), and the
 * drawer toggle has an explicit `display: none` default outside the touch tier.
 *
 * Empirical anchor notes (dsh 0.1.5-alpha.2, CDP audit):
 *  - `data-sidebar-collapsed` on the frame: present "true" when collapsed,
 *    REMOVED when expanded — `:not([data-sidebar-collapsed])` is the open
 *    drawer condition.
 *  - `data-rightbar-collapsed` is the alpha.2 rename of the details column
 *    flag, and it means "the column has NO retained track" —
 *    `cols.rightbar === 0`, AppFrame.tsx — NOT "the panel is hidden": the
 *    occupant only asks for a track at >= 768px (`track = shown &&
 *    !autoFullscreen`, SidebarRight.tsx), so a shown panel on the phone tier
 *    still reports track=false and the attribute IS present. Two different
 *    questions therefore use two different keys: the fullscreen PRESENTATION
 *    below is not gated at all (the panel's own `data-sidebar-right-panel`
 *    state is the anchor), while the DRAWER yield uses both shown signals —
 *    `:not([data-rightbar-collapsed])` for the pushed track and
 *    `[data-rightbar-fullscreen]` (set by `openRightbar`, cleared by
 *    `closeRightbar`) for the auto-fullscreen phone case. Keying the yield on
 *    the track flag alone silently left phones un-yielded (2026-09-13
 *    review-fix, round 3).
 *  - STACKING SCOPE (2026-09 二轮, 2026-09-13 review-fix): this plugin's
 *    fixed layers (drawer 75, backdrop 74, toggle 76) are mounted inside the
 *    official `shell.overlay` layer, which is `position: absolute;
 *    z-index: 20` — a stacking context of its own. The tiers therefore order
 *    correctly among THEMSELVES and above the frame content / normal rightbar
 *    column (z-10), but they can never paint above a sibling stacking context:
 *    the official fullscreen rightbar (z-40) and the floating-panel host
 *    (z-60) cover them. Intentional — and since the right panel IS the
 *    fullscreen surface on this tier, the drawer now stands down explicitly
 *    while it is shown (hidden + out of the tab order) instead of staying
 *    focusable behind it. Escaping would require a body-level portal (not
 *    done).
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
   trajectory load-earlier — same semantics; verified against the pinned
   install at the 2026-09 re-anchor, see the module header). Four
   informational bubbles are deliberately
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
     auto-placement would put the main column into track 1 (0px) and the
     rightbar column into track 2 (full width). Both remaining columns must
     be pinned explicitly. */
  [data-mobile-frame] {
    grid-template-columns: 0 minmax(0, 1fr) 0 !important;
  }
  [data-mobile-role="conversation"] {
    grid-column: 2;
  }
  [data-mobile-role="details"] {
    grid-column: 3;
  }

  /* Right panel: upstream presents it fullscreen only BELOW 768px
     ('autoFullscreen = viewportWidth < 768') and otherwise pushes the centre
     through its own track — but this tier pins the third track to 0, so at
     769-1023px the panel drew at its normal width (313-460px, about two fifths
     of the content column and 41-45% of the viewport) straight over the
     transcript: no track, no fullscreen
     covered with no way to make room (2026-09-13 review-fix, the STATUS
     geometry residue). Give the whole touch tier the presentation upstream
     reserves for phones: the official panel fills the frame.
     NOT gated on the frame's shown flag: the close report lands in the same
     commit as the slide-out (SidebarRight reports shown:false immediately when
     the panel leaves), so a frame-gated rule would drop the fullscreen box
     mid-animation and the panel would shrink to its normal width while sliding
     out. The HIDDEN state needs no gate either — upstream hides the panel with
     transform: translateX(100%) + visibility: hidden, and an inset:0 box of
     full width sits exactly one viewport to the right, invisible and
     untouchable. The frame attribute stays the right key for the DRAWER yield
     below, which must follow the panel's shown state rather than its box.
     ANCHOR: the panel is NOT the column's direct child — it sits under the
     rightbar slot's [data-slot="rightbar"] outlet wrapper, and every outlet
     wrapper is display:contents (ui-renderer scoped-slots ANCHOR_STYLE),
     so a positional rule on the wrapper is a silent no-op (the first cut of
     this very fix landed there). Target the panel's own upstream state
     attribute instead, scoped to the column. z-40 is upstream's own
     fullscreen layer ('[data-sidebar-right-panel=fullscreen]'), kept so the
     official stacking order is unchanged. */
  [data-mobile-role="details"] [data-sidebar-right-panel] {
    position: fixed;
    inset: 0;
    z-index: 40;
    width: 100% !important;
    max-width: none !important;
    border: none;
    /* The padding below must not add to that 100%: the panel declares no
       box-sizing of its own and the tree has NO global border-box reset, so a
       content-box panel with left:0 + width:100% runs the right offset over
       and paints insets WIDER than the viewport (content cut on the notch
       side). */
    box-sizing: border-box;
    /* iOS safe areas, in the SAME rule because they matter exactly while the
       panel is fullscreen: this plugin injects viewport-fit=cover (touch
       tier), so inset:0 runs edge to edge — on a notched iPhone in LANDSCAPE
       the width falls in the 769-1023px band and the notch/sensor housing sits
       over the panel's left or right edge, with the home indicator under its
       bottom. Upstream's fullscreen presenter carries no env(safe-area-inset-*)
       of its own (ui-sidebar-right), while every other full-bleed chamber
       surface on this tier does (drawer, settings sheet, composer seat); the
       surface still paints full-bleed (background covers the padding box). */
    padding-top: env(safe-area-inset-top, 0px);
    padding-right: env(safe-area-inset-right, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
    padding-left: env(safe-area-inset-left, 0px);
  }

  /* Sidebar → fixed overlay drawer, off-canvas by default. translateX(-105%)
     keeps the shadow out of view; the open state is driven purely by the
     official frame attribute (no JS state, no React). Motion uses the
     official tokens (--ds-ease-in-out / --ds-transition-duration-slow) and
     is disabled under prefers-reduced-motion. visibility hides the closed
     drawer from the tab order (WCAG 2.4.3 — off-canvas content must not be
     focusable) with a 0s delay so the close animation still plays. The
     official elevation shadow separates the drawer from the conversation:
     --dsw-elevation-prominent is the raised-surface token (0.5px hairline
     stroke + two soft shadows, ui-theme's gradient-shadow-text.css), not the
     legacy --dsw-shadow-lv* scale upstream keeps only for Toast / HoverCard
     / ImageLightbox. (No backticks in this template: the stylesheet IS a
     template literal, so a quoted token name would end it.) */
  [data-mobile-role="sidebar"] {
    position: fixed !important;
    top: 0 !important;
    bottom: 0 !important;
    left: 0 !important;
    z-index: 75;
    width: min(86vw, 280px) !important;
    box-shadow: var(--dsw-elevation-prominent);
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
     sitting above it (z-74 < drawer 75) — absorbs stray taps on the ~50px
     live seam right of the drawer (the composer send button must not be
     hit while the drawer is open). Tap on the backdrop closes the drawer
     (the toggle component wires the click). */
  [data-mobile-frame]:not([data-sidebar-collapsed]) .dsh-mobile-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 74;
    background: var(--dsw-alias-bg-mask-1);
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
     exclusion). Attribute anchors replace the legacy [class$="_handle"]
     local-name rule here: the attribute seams are stable by contract, while a
     local-name suffix match would also catch unrelated handles.
     FUTURE-FRAGILE ANCHOR NOTE (2026-12 audit): the [data-side] exclusion
     was verified safe across the whole tree at audit time — no other
     [data-side] carriers beyond the AppFrame handles / width strips /
     role="tooltip" bubbles; re-grep [data-side] when the vendored base
     moves before trusting this rule. */
  [data-mobile-frame] [data-width-handle],
  [data-mobile-frame] [data-side]:not([role="tooltip"]) {
    display: none !important;
  }
  /* Dockkit split affordances: the DIVIDER is pointer-drag chrome with no
     touch equivalent (a split ratio cannot be dragged on this tier). The
     SPLIT BUTTON is not: upstream renders it as a plain 'button' whose
     'onClick' splits the pane and which disables ITSELF when the pane cannot
     split, so hiding it removed a usable affordance on a false premise —
     the "the right surface is fullscreen here" half was untrue at 769-1023px
     as well (2026-09-13 review-fix; the tier now presents that surface
     fullscreen, see the right-panel rule above). */
  [data-mobile-frame] [data-dockkit-divider] {
    display: none !important;
  }

  /* Floating drawer toggle: the official sidebar toggle lives inside the
     sidebar DOM, which the off-canvas transform hides — this shell.overlay
     entry is the mobile entry point. Hidden again while the drawer is open
     (the drawer's own header carries the close control). The default
     display: none outside this tier kills the desktop ghost button — the
     official overlay layer renders entries unconditionally. Visual language
     follows the official icon buttons: transparent base, hover/active
     fills from the alias tokens, focus ring in the business-primary color,
     and the glyph in the official rail ink — the control IS the official
     panel toggle glyph at the touch size (2026-09-11 upstream-alignment
     T17a; the plugin draws no control of its own). */
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
    /* Official rail-toggle silhouette (2026-09 batch 1, H2): the dsh sidebar's
       own icon button is a circle (28/36px), so the phone's only way back to
       navigation keeps that shape at the 44px touch size instead of becoming a
       12px-cornered square. The corner-shape keyword is paired with the full
       round radius (ui-theme smooths unpaired circles into squircles). */
    border-radius: 50%;
    corner-shape: round;
    background: transparent;
    color: var(--dsw-alias-label-primary);
    cursor: pointer;
    touch-action: manipulation;
    -webkit-appearance: none;
    appearance: none;
  }
  .dsh-mobile-nav-toggle:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }
  .dsh-mobile-nav-toggle:active {
    background: var(--dsw-alias-interactive-bg-active);
  }
  .dsh-mobile-nav-toggle:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary);
  }
  [data-mobile-frame]:not([data-sidebar-collapsed]) .dsh-mobile-nav-toggle {
    display: none;
  }

  /* Right panel OPEN ⇒ the drawer YIELDS (a shown right panel owns the screen
     on this tier — it is presented fullscreen above): the floating toggle and
     the backdrop stand down, and an open drawer goes 'visibility: hidden' —
     the same mechanism the closed drawer uses, which also drops it out of the
     tab order (WCAG 2.4.3) instead of leaving nav rows and the settings seat
     focusable behind the panel (2026-09-13 review-fix).
     TWO ARMS, because "the panel is shown" is NOT one attribute:
       - :not([data-rightbar-collapsed]) is upstream's TRACK flag
         (cols.rightbar === 0, AppFrame.tsx) and the seat only asks for a
         track at >= 768px (track = shown && !autoFullscreen,
         SidebarRight.tsx:371) — so on the phone tier a SHOWN panel still
         reports track=false and this arm is inert there;
       - [data-rightbar-fullscreen] is the seat's FULLSCREEN report, set by
         openRightbar(track, fullscreen) and cleared by closeRightbar()
         (ui-layout stores.ts:133-141), so it is present exactly while a
         fullscreen (i.e. every phone-tier) panel is shown.
     Together they cover every shown state on this tier; keying on the track
     flag alone silently left phones un-yielded.
     ORDER MATTERS: these selectors tie on specificity with the open-drawer /
     backdrop rules above, so this block must stay AFTER them. */
  [data-mobile-frame]:not([data-rightbar-collapsed]) .dsh-mobile-nav-toggle,
  [data-mobile-frame][data-rightbar-fullscreen] .dsh-mobile-nav-toggle,
  [data-mobile-frame]:not([data-rightbar-collapsed]) .dsh-mobile-backdrop,
  [data-mobile-frame][data-rightbar-fullscreen] .dsh-mobile-backdrop {
    display: none;
  }
  [data-mobile-frame]:not([data-rightbar-collapsed]) [data-mobile-role="sidebar"],
  [data-mobile-frame][data-rightbar-fullscreen] [data-mobile-role="sidebar"] {
    visibility: hidden;
  }

  /* The panel's MODE control cannot change anything in the 768-1023px band any
     more: this tier forces the fullscreen presentation above, so upstream's
     push<->fullscreen flip (and the label it flips with it) is inert —
     pressing "exit fullscreen" would leave the panel fullscreen. It is hidden
     exactly there. BELOW 768px it stays: upstream's autoFullscreen branch turns
     that same click into "collapse the panel" (SidebarRight.tsx), a real
     affordance. The separate collapse control is untouched in both bands. */
  @media (min-width: 768px) {
    [data-mobile-frame] [data-sidebar-right-mode] {
      display: none !important;
    }
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

  /* Session-header view tabs ('role="tablist"'): 'tabs.length > 1' is the
     NORM, not an edge case — ui-chat and ui-trajectory both register a
     conversation view unconditionally, and both ship in the default web
     bundle. The official tab box is 13px text on a 25px box and the strip
     neither wraps nor scrolls, while the frame clips overflow
     (AppFrame.module.css 'overflow: hidden') — a third view or a longer
     (en) label would be simply unreachable. The strip WRAPS rather than
     scrolling: a scroll container would clip the active tab's 2px bar, which
     upstream draws 1px past the tab box to end flush with the header's bottom
     rule (overflow-x:auto also forces overflow-y to compute to auto). The
     44px floor grows the tab box — with box-sizing so the floor means the BOX
     (the official tab pads 9px at the bottom, so a content-box floor would be
     53px); the header's 'min-height: 76px' is a FLOOR, so the row follows
     instead of clipping (its sidebar-strip alignment figure is a desktop
     concern — on this tier the sidebar is a drawer). */
  [data-slot="conversation.session.header"] [role="tablist"] {
    flex-wrap: wrap;
  }
  [data-slot="conversation.session.header"] [role="tab"] {
    display: inline-flex;
    align-items: center;
    box-sizing: border-box;
    min-height: 44px;
  }

  /* Touch targets: high-frequency controls get the 44px floor (Apple HIG;
     WCAG 2.5.8 ≥24px is exceeded). The official toolbar/sidebar buttons are
     28-36px (desktop-mouse sizes) — unusable on touch. Icon-only buttons
     also get a width floor; text buttons (composer bar) keep their natural
     width. Menu/popup items and settings entries get the same floor.
     The SEAT list is explicit and grows with upstream: the 2026-09-13
     review-fix added the header's utilities + corner seats and the right
     panel's dockkit strip, which the earlier three-seat list left at their
     desktop sizes (28px) while the panel became a primary mobile surface.
     The strip's CHIP-CLOSE control is excluded on purpose: upstream floats it
     at 20px inside the chip (absolute, top-right, pointer-events gated by
     hover/active), so the floor would inflate it into a 44px box over the
     chip's label — the chip itself is the 44px target and closing stays
     reachable from the chip menu. */
  [data-slot="conversation.composer.bar"] button,
  [data-slot="sidebar"] button,
  [data-slot="conversation.session.header.actions"] button,
  [data-slot="conversation.session.header.utilities"] button,
  [data-slot="conversation.session.header.corner"] button,
  [data-slot="settings.section"] button,
  [data-sidebar-right-panel] [data-dockkit-strip] button:not([data-dockkit-tab-close]),
  [data-sidebar-right-panel] [data-dockkit-strip] [role="tab"],
  [role="menuitem"], [role="option"] {
    min-height: 44px;
  }
  [data-slot="sidebar"] button,
  [data-slot="conversation.session.header.actions"] button,
  [data-slot="conversation.session.header.utilities"] button,
  [data-slot="conversation.session.header.corner"] button,
  [data-sidebar-right-panel] [data-dockkit-strip] button:not([data-dockkit-tab-close]),
  [role="menuitem"], [role="option"] {
    min-width: 44px;
  }
  /* The strip itself is 28px tall by upstream contract: let it grow with the
     controls instead of clipping them. (The chip row does NOT become
     finger-pannable: upstream declares touch-action:none on the strip, the
     chip row AND the chips to own the drag gesture, so an overflowing chip is
     reached by ACTIVATING a neighbour — the kit scrolls the active chip into
     view — never by panning. Anything else would fight the tab drag.)
     box-sizing applies to the strip's BUTTONS only: their chrome icons declare
     28px boxes WITH 6px padding, so the floor must mean the BOX — otherwise 44
     becomes 56 and the strip grows 12px for nothing. The CHIPS stay
     content-box on purpose: they pad horizontally only (44px is 44px either
     way), while dockkit MEASURES the chip minimum as min-width + padding
     under content-box (ui-dockkit/components/measure.ts chipMinimum) — forcing
     border-box there would silently lower that measured minimum from 100px to
     80px and make the pane-split "halves fit" rule more permissive than
     upstream intends. Scoped to this new seat: the pre-existing
     header-actions arm is left exactly as shipped, so the header row keeps the
     geometry it was verified with (its floor therefore lands on the CONTENT
     box: padded icon buttons render ~56px, and the header row grows with
     them — a device-judged tradeoff, see STATUS). */
  [data-sidebar-right-panel] [data-dockkit-strip] {
    height: auto;
    min-height: 44px;
  }
  [data-sidebar-right-panel] [data-dockkit-strip] button:not([data-dockkit-tab-close]) {
    box-sizing: border-box;
  }
  /* The chip's close control was laid out for a 28px chip (top: 4px); the
     44px chip leaves it hanging at the top edge, so it is centred in the box
     it now lives in. Its 20px size, opacity and pointer-events gating stay
     upstream's (the chip itself is the 44px target, and closing also lives in
     the chip menu). */
  [data-sidebar-right-panel] [data-dockkit-tab-close] {
    top: 50%;
    transform: translateY(-50%);
  }
  /* A fullscreen panel owns the whole screen on this tier, so its inner
     scrollers must not chain their overscroll to the document behind it
     (rubber-band + dynamic-toolbar movement under a fixed surface). Same
     containment the conversation scrollport already declares on the phone
     tier; Safari 16+ honours it, older WebKit ignores it harmlessly. */
  [data-sidebar-right-panel] * {
    overscroll-behavior: contain;
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
     'data-mobile-kbd' + the '--chamber-mobile-kbd-offset' custom property on the
     stamped frame (never official attributes). Android Chrome WITH the token
     shrinks the layout viewport itself: covered height ≈ 0, the installer
     never arms, these rules stay inert. */
  [data-mobile-frame][data-mobile-kbd] [data-phase="active"] [data-conversation-scroll] {
    padding-bottom: var(--chamber-mobile-kbd-offset, 0px) !important;
  }
  [data-mobile-frame][data-mobile-kbd] [data-phase="active"] [data-composer-seat] {
    bottom: var(--chamber-mobile-kbd-offset, 0px) !important;
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
  /* Local-name SUFFIX match (production names are [hash]_[local]): the dual
     arm covers multi-class elements. It also hits sibling rows whose local name
     ends in "row" inside the composer bar subtree (e.g. the queue dock's
     .row), which is harmless today — those rows declare no flex-wrap and carry
     no _trigger child. */
  [data-slot="conversation.composer.bar"] :is([class$="_row"], [class*="_row "]) {
    flex-wrap: nowrap !important;
  }
  [data-slot="conversation.composer.bar"] :is([class$="_row"], [class*="_row "]) :is([class$="_trigger"], [class*="_trigger "]),
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
  /* Header row (actions + Close), anchored on the documented seams
     [data-slot="settings.action"] + [data-slot="settings.close"] instead of
     a positional div:first-child (2026-09-11 upstream-alignment T17c). Both
     outlet wrappers are unconditional on their call sites, and the ROW is
     the only element carrying both: the official shape is content > header >
     (actions > action-outlet, close-button > close-outlet), so the actions
     cell holds the action seam ALONE and the options cell holds only
     [data-slot="settings.section"]. Descendant :has() keeps the anchor
     insensitive to an extra wrapper level — the row stays sticky if upstream
     nests either cell deeper, and the options cell can never match. */
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) > div:last-child > div:has([data-slot="settings.action"]):has([data-slot="settings.close"]) {
    flex: none;
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--dsw-alias-bg-layer-2);
  }
  [role="dialog"][aria-modal="true"]:has([data-slot="settings.header"]) > div:last-child > div:last-child {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-right: calc(16px + env(safe-area-inset-right));
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
    padding-left: calc(16px + env(safe-area-inset-left));
  }
  /* Section inner grid that assumes desktop width. Official inner cells
     carry no stable attribute, so the local-name SUFFIX match
     (:is([class$="_<local>"], [class*="_<local> "]), production naming
     [hash]_[local]) is the documented exception; a naming flip fails SOFT —
     the official grid stays.
     - Models provider row (two text inputs + chevron + trash on one
       4-column line) → TWO equal columns: the four children auto-place
       2×2 (inputs on the first row, the two icon actions under them).
     The card grids are NOT overridden: upstream owns both of them, and they
     are TWO grids under this very section with two DIFFERENT upstream rules
     (2026-09-11 review-fix F3 — the deleted arm's blast radius had been
     recorded for one grid only):
     - PluginInventorySettingsTab.module.css collapses its .cards itself at
       max-width: 680px, so the chamber's former arm only contradicted
       upstream there in the 681-768px window;
     - ui-agent-preset AgentPresetSection.module.css declares NO breakpoint at
       all — its .cards is repeat(auto-fill, minmax(268px, 1fr)) inside a
       .section capped at 720px, so upstream renders TWO columns from about
       580px of viewport width (two 268px cards plus the 12px gap need 548px
       inside the options box = viewport minus 2x(16px + safe-area)). For that
       grid the deleted arm changed the layout across its WHOLE two-column
       range, about 580-768px of the phone tier, not just 681-768px.
     The arm was deleted for both grids (2026-09-11 upstream-alignment T17b) —
     upstream's geometry is the only geometry for each of them. */
  [data-slot="settings.section"] :is([class$="_modelRow"], [class*="_modelRow "]) {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
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
  /* No dialog-width rule of this plugin's own, deliberately: dialogs other
     than the settings sheet are NOT capped (2026-09-11 upstream-alignment
     T6). The tree has exactly three role="dialog" aria-modal="true"
     producers, and each owns its viewport fit: the settings panel above
     (this sheet), the ui-primitives Modal (Modal.module.css pins its Root to
     inset 0 with a 24px padding and caps the Dialog at min(380px, 100%)),
     and the ui-attachment ImageLightbox (a fixed full-bleed backdrop at
     inset 0 whose mask is an absolute inset-0 layer). A blanket max-width is
     over-constrained against inset: 0: the lightbox backdrop would shrink to
     100vw-24px, left-anchored, leaving a 24px undimmed click-through strip
     on the right. The official geometries are the fit. */

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
     child of this scroller (official shape since rc.1: scrollBody > [session slot,
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
