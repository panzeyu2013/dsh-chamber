window.__ModuleLoader__.load({ id: "@dsh-chamber/dsh-client-ui-mobile", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/locales.ts
var zh = {
  "dsh-chamber.mobile.title": "\u79FB\u52A8\u89C6\u56FE",
  "dsh-chamber.mobile.drawer.open": "\u6253\u5F00\u4FA7\u8FB9\u680F",
  "dsh-chamber.mobile.drawer.close": "\u6536\u8D77\u4FA7\u8FB9\u680F"
};
var en = {
  "dsh-chamber.mobile.title": "Mobile view",
  "dsh-chamber.mobile.drawer.open": "Open sidebar",
  "dsh-chamber.mobile.drawer.close": "Close sidebar"
};

// src/client/styles.ts
var MOBILE_CSS = `
/* The mobile-only UI (hamburger, backdrop) defaults to hidden OUTSIDE the
   touch tier \u2014 the official shell.overlay layer renders entries
   unconditionally, so without this default desktop browsers would see an
   unstyled ghost button (design 17 \xA718.4.2 "PC leak" invariant, applied to
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
   the tap and STAYS over the control that was just used (\u53D1\u9001/\u505C\u6B62 included).
   The rule is therefore gated by pointer/hover ALONE \u2014 an iPad in landscape
   is 1024px+ and still taps, while attaching a mouse flips hover to hover
   and correctly restores hover tooltips \u2014 and is scoped to bubbles that
   DUPLICATE an accessible name: button[aria-label] + [role="tooltip"]
   (the component renders the bubble as the trigger's immediate next sibling;
   [data-side] is the component's own marker \u2014 see the preserved list below).
   Of the 31 official Tooltip sites, 27 are aria-labelled buttons (composer
   send/stop/commands/ContextMeter, queue dock, goal bar, sidebar, message
   feedback, workspace rows, chat copy/branch) whose aria-label names the same
   action (3 of them phrase it slightly differently \u2014 workspace search \xD72,
   trajectory load-earlier \u2014 same semantics; verified against the pinned
   install at the 2026-09 re-anchor, see the module header). Four
   informational bubbles are deliberately
   NOT hidden because their trigger has no accessible duplicate: the chat
   stats line (ui-chat:3853, ellipsized non-focusable div), the agent-preset
   card description (ui-agent-preset:960, line-clamp:4), the trajectory
   timeline span (ui-trajectory:6821, aria-hidden, no click path) and the
   trajectory kind tag at \u2264620px (ui-trajectory:5554, visible label collapsed)
   \u2014 they keep the sticky-hover quirk rather than lose content a touch user
   cannot otherwise read. The tree's fifth role="tooltip" producer (ui-chat
   turn-rail preview, :1735) is a non-button div WITHOUT data-side and is
   therefore structurally outside this rule (it is aria-describedby-referenced
   and its rail is container-hidden \u2264900px anyway). Desktop is untouched
   (media-query scoped). */
@media (pointer: coarse) and (hover: none) {
  button[aria-label] + [role="tooltip"][data-side] {
    display: none !important;
  }
}

/* ---- touch tier: tablet/phone touch (design 17 \xA718.4.2) ---- */
@media (max-width: 1023px) and (pointer: coarse) {
  /* Three-column frame \u2192 single column; the sidebar leaves the grid flow
     entirely (it becomes the fixed drawer below). The grid tracks are
     explicitly locked so the center column is never squeezed into a 0-width
     track by the fixed sibling. IMPORTANT (P1-C): the official AppFrame
     sets NO explicit grid-column \u2014 with the sidebar fixed (out of flow),
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
     through its own track \u2014 but this tier pins the third track to 0, so at
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
     out. The HIDDEN state needs no gate either \u2014 upstream hides the panel with
     transform: translateX(100%) + visibility: hidden, and an inset:0 box of
     full width sits exactly one viewport to the right, invisible and
     untouchable. The frame attribute stays the right key for the DRAWER yield
     below, which must follow the panel's shown state rather than its box.
     ANCHOR: the panel is NOT the column's direct child \u2014 it sits under the
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
       tier), so inset:0 runs edge to edge \u2014 on a notched iPhone in LANDSCAPE
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

  /* Sidebar \u2192 fixed overlay drawer, off-canvas by default. translateX(-105%)
     keeps the shadow out of view; the open state is driven purely by the
     official frame attribute (no JS state, no React). Motion uses the
     official tokens (--ds-ease-in-out / --ds-transition-duration-slow) and
     is disabled under prefers-reduced-motion. visibility hides the closed
     drawer from the tab order (WCAG 2.4.3 \u2014 off-canvas content must not be
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

  /* Drawer backdrop: dims the conversation behind the open drawer and \u2014 by
     sitting above it (z-74 < drawer 75) \u2014 absorbs stray taps on the ~50px
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

  /* Drag handles are desktop affordances (mouse resizing) \u2014 hidden on
     touch where the drawer/overlay geometry replaces them. Anchored on the
     official attribute seams: the AppFrame resize strips carry
     [data-side] (no role), the conversation width strips carry
     [data-width-handle]; the ui-primitives Tooltip bubble also carries
     [data-side] for placement and must NOT be hidden (role="tooltip"
     exclusion). Attribute anchors replace the legacy [class$="_handle"]
     local-name rule here: the attribute seams are stable by contract, while a
     local-name suffix match would also catch unrelated handles.
     FUTURE-FRAGILE ANCHOR NOTE (2026-12 audit): the [data-side] exclusion
     was verified safe across the whole tree at audit time \u2014 no other
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
     split, so hiding it removed a usable affordance on a false premise \u2014
     the "the right surface is fullscreen here" half was untrue at 769-1023px
     as well (2026-09-13 review-fix; the tier now presents that surface
     fullscreen, see the right-panel rule above). */
  [data-mobile-frame] [data-dockkit-divider] {
    display: none !important;
  }

  /* Floating drawer toggle: the official sidebar toggle lives inside the
     sidebar DOM, which the off-canvas transform hides \u2014 this shell.overlay
     entry is the mobile entry point. Hidden again while the drawer is open
     (the drawer's own header carries the close control). The default
     display: none outside this tier kills the desktop ghost button \u2014 the
     official overlay layer renders entries unconditionally. Visual language
     follows the official icon buttons: transparent base, hover/active
     fills from the alias tokens, focus ring in the business-primary color,
     and the glyph in the official rail ink \u2014 the control IS the official
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
    border-radius: 12px;
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

  /* Right panel OPEN \u21D2 the drawer YIELDS (a shown right panel owns the screen
     on this tier \u2014 it is presented fullscreen above): the floating toggle and
     the backdrop stand down, and an open drawer goes 'visibility: hidden' \u2014
     the same mechanism the closed drawer uses, which also drops it out of the
     tab order (WCAG 2.4.3) instead of leaving nav rows and the settings seat
     focusable behind the panel (2026-09-13 review-fix).
     TWO ARMS, because "the panel is shown" is NOT one attribute:
       - :not([data-rightbar-collapsed]) is upstream's TRACK flag
         (cols.rightbar === 0, AppFrame.tsx) and the seat only asks for a
         track at >= 768px (track = shown && !autoFullscreen,
         SidebarRight.tsx:371) \u2014 so on the phone tier a SHOWN panel still
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
     push<->fullscreen flip (and the label it flips with it) is inert \u2014
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
     <header> > titleRow [+ tabs]) \u2014 a structural selector, no hashed
     classes. The gutter reserves the toggle box plus an 8px gap; padding on
     the header (not the title row) also clears the tab strip when a session
     has multiple views. */
  [data-mobile-frame] [data-slot="conversation.session.header"] > header {
    padding-left: calc(62px + env(safe-area-inset-left, 0px)) !important;
  }

  /* Crumbs/lineage chain: wrap instead of clip. The official .crumbs row is
     nowrap + overflow hidden (desktop-width assumption): on a phone a long
     title chain or the lineage chips ("N \u4E2A\u5B50\u4EE3\u7406" catalog triggers) get
     silently CUT (the observed truncated/collapsed header labels). Wrapping
     keeps every crumb segment and chip on its own line; per-crumb ellipsis
     (official .crumb max-width) still bounds single titles. */
  [data-mobile-frame] [data-slot="conversation.session.header"] nav {
    flex-wrap: wrap;
    overflow: visible;
    white-space: normal;
  }

  /* Session-header view tabs ('role="tablist"'): 'tabs.length > 1' is the
     NORM, not an edge case \u2014 ui-chat and ui-trajectory both register a
     conversation view unconditionally, and both ship in the default web
     bundle. The official tab box is 13px text on a 25px box and the strip
     neither wraps nor scrolls, while the frame clips overflow
     (AppFrame.module.css 'overflow: hidden') \u2014 a third view or a longer
     (en) label would be simply unreachable. The strip WRAPS rather than
     scrolling: a scroll container would clip the active tab's 2px bar, which
     upstream draws 1px past the tab box to end flush with the header's bottom
     rule (overflow-x:auto also forces overflow-y to compute to auto). The
     44px floor grows the tab box \u2014 with box-sizing so the floor means the BOX
     (the official tab pads 9px at the bottom, so a content-box floor would be
     53px); the header's 'min-height: 76px' is a FLOOR, so the row follows
     instead of clipping (its sidebar-strip alignment figure is a desktop
     concern \u2014 on this tier the sidebar is a drawer). */
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
     WCAG 2.5.8 \u226524px is exceeded). The official toolbar/sidebar buttons are
     28-36px (desktop-mouse sizes) \u2014 unusable on touch. Icon-only buttons
     also get a width floor; text buttons (composer bar) keep their natural
     width. Menu/popup items and settings entries get the same floor.
     The SEAT list is explicit and grows with upstream: the 2026-09-13
     review-fix added the header's utilities + corner seats and the right
     panel's dockkit strip, which the earlier three-seat list left at their
     desktop sizes (28px) while the panel became a primary mobile surface.
     The strip's CHIP-CLOSE control is excluded on purpose: upstream floats it
     at 20px inside the chip (absolute, top-right, pointer-events gated by
     hover/active), so the floor would inflate it into a 44px box over the
     chip's label \u2014 the chip itself is the 44px target and closing stays
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
     reached by ACTIVATING a neighbour \u2014 the kit scrolls the active chip into
     view \u2014 never by panning. Anything else would fight the tab drag.)
     box-sizing applies to the strip's BUTTONS only: their chrome icons declare
     28px boxes WITH 6px padding, so the floor must mean the BOX \u2014 otherwise 44
     becomes 56 and the strip grows 12px for nothing. The CHIPS stay
     content-box on purpose: they pad horizontally only (44px is 44px either
     way), while dockkit MEASURES the chip minimum as min-width + padding
     under content-box (ui-dockkit/components/measure.ts chipMinimum) \u2014 forcing
     border-box there would silently lower that measured minimum from 100px to
     80px and make the pane-split "halves fit" rule more permissive than
     upstream intends. Scoped to this new seat: the pre-existing
     header-actions arm is left exactly as shipped, so the header row keeps the
     geometry it was verified with (its floor therefore lands on the CONTENT
     box: padded icon buttons render ~56px, and the header row grows with
     them \u2014 a device-judged tradeoff, see STATUS). */
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
     manipulation (no double-tap zoom), but textareas MUST keep auto \u2014 a
     manipulation textarea swallows the caret/scroll (design \xA718.4.3
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
     when the soft keyboard opens, so the official sticky composer seat \u2014
     pinned to the scrollport's layout bottom \u2014 ends up BEHIND the keyboard.
     The installer mirrors resizes-content semantics against the visual
     viewport: while the keyboard is open it raises the seat's sticky bottom
     to the keyboard top AND pads the conversation scrollport by the same
     offset, so the message tail can scroll up beside the raised seat instead
     of hiding under the keyboard. State rides the plugin's own frame stamp:
     'data-mobile-kbd' + the '--chamber-mobile-kbd-offset' custom property on the
     stamped frame (never official attributes). Android Chrome WITH the token
     shrinks the layout viewport itself: covered height \u2248 0, the installer
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
     ui-workspace:1187) and inline rename (14px, :531) were the gap \u2014 a
     focus-zoom there used to leave the composer behind the keyboard for the
     rest of the session (cross-check P1). */
  [data-mobile-role="sidebar"] input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),
  [data-mobile-role="sidebar"] textarea {
    font-size: max(16px, var(--dsh-content-font-size, 16px)) !important;
  }
}

/* ---- phone tier (design 17 \xA718.4.2/\xA718.4.3) ---- */
@media (max-width: 768px) and (pointer: coarse) {
  /* Composer toolbar: one line. The official row wraps; force nowrap (the
     official 12px gap is kept \u2014 no gap override). */
  /* Local-name SUFFIX match (production names are [hash]_[local]): the dual
     arm covers multi-class elements. It also hits sibling rows whose local name
     ends in "row" inside the composer bar subtree (e.g. the queue dock's
     .row), which is harmless today \u2014 those rows declare no flex-wrap and carry
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
     is 800px wide and flex-row \u2014 a fixed 188px nav RAIL + content column.
     A phone needs the sheet stacked: the nav becomes a top strip (title +
     horizontally scrolling section chips), the content header row (actions
     + Close) stays pinned and only the section options scroll under it.
     All anchors are structural (panel [role=dialog][aria-modal] carrying
     the settings.header seat; direct nav/content children) \u2014 the :has()
     anchor is scoped to aria-modal dialogs, so its invalidation cost stays
     off the streaming conversation subtree (design 17 \xA718.4.4 records
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
  /* Nav rail \u2192 top strip: title + chips row, safe-area padded. */
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
     options area scroll (the earlier shell rule scrolled the whole column \u2014
     the Close button scrolled out of reach on a phone). The content column
     itself stays a FALLBACK scroller (overflow-y auto) instead of
     overflow:hidden: on the verified header+options child grammar the
     pinned header + inner options scroller fill the column exactly (no
     double scroll), while an upstream wrapper drift cannot hard-lock the
     sheet \u2014 the column scrolls and the sticky header keeps Close visible. */
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
     insensitive to an extra wrapper level \u2014 the row stays sticky if upstream
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
     [hash]_[local]) is the documented exception; a naming flip fails SOFT \u2014
     the official grid stays.
     - Models provider row (two text inputs + chevron + trash on one
       4-column line) \u2192 TWO equal columns: the four children auto-place
       2\xD72 (inputs on the first row, the two icon actions under them).
     The card grids are NOT overridden: upstream owns both of them, and they
     are TWO grids under this very section with two DIFFERENT upstream rules
     (2026-09-11 review-fix F3 \u2014 the deleted arm's blast radius had been
     recorded for one grid only):
     - PluginInventorySettingsTab.module.css collapses its .cards itself at
       max-width: 680px, so the chamber's former arm only contradicted
       upstream there in the 681-768px window;
     - ui-agent-preset AgentPresetSection.module.css declares NO breakpoint at
       all \u2014 its .cards is repeat(auto-fill, minmax(268px, 1fr)) inside a
       .section capped at 720px, so upstream renders TWO columns from about
       580px of viewport width (two 268px cards plus the 12px gap need 548px
       inside the options box = viewport minus 2x(16px + safe-area)). For that
       grid the deleted arm changed the layout across its WHOLE two-column
       range, about 580-768px of the phone tier, not just 681-768px.
     The arm was deleted for both grids (2026-09-11 upstream-alignment T17b) \u2014
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
     composerSeat]), so the official sheet declares NO padding-bottom here \u2014
     the bottom spacing lives on the InputBar root (8px) and the message
     column (16px), neither of which this rule touches. */
  [data-conversation-scroll] {
    overscroll-behavior-y: contain;
  }
}
`;
var VIEWPORT_TOKENS = ["viewport-fit=cover", "interactive-widget=resizes-content"];
var PLUGIN_STYLE_TAG = "dsh-chamber-client-ui-mobile";

// src/client/markup.ts
var ROOT_SLOT_SELECTOR = '[data-slot="root"]';
var MOBILE_FRAME_ATTR = "data-mobile-frame";
var MOBILE_ROLE_ATTR = "data-mobile-role";
var ROLE_SLOT_KEYS = {
  sidebar: "sidebar",
  conversation: "main",
  details: "rightbar"
};
function findFrame(root) {
  for (const child of root.children) {
    if (child !== null) return child;
  }
  return null;
}
function findColumn(frame, slot) {
  for (const col of frame.children) {
    for (const inner of col.children) {
      if (inner.getAttribute("data-slot") === slot) return col;
    }
  }
  return null;
}
function stampFrame(root) {
  const frame = findFrame(root);
  if (frame === null) return null;
  frame.setAttribute(MOBILE_FRAME_ATTR, "");
  for (const role of ["sidebar", "conversation", "details"]) {
    const column = findColumn(frame, ROLE_SLOT_KEYS[role]);
    if (column !== null) column.setAttribute(MOBILE_ROLE_ATTR, role);
  }
  return frame;
}
function isStructuralTarget(target) {
  if (target === null || target === void 0) return false;
  let cursor = target;
  for (let hop = 0; hop <= 4; hop += 1) {
    if (cursor === null || cursor === void 0) return false;
    if (cursor.matches(ROOT_SLOT_SELECTOR) || cursor.matches(`[${MOBILE_FRAME_ATTR}]`) || cursor.matches(`[${MOBILE_ROLE_ATTR}]`)) return true;
    cursor = cursor.parentElement;
  }
  return false;
}
function isElementNode(node) {
  return typeof node === "object" && node !== null && typeof node.matches === "function";
}
function shouldRestamp(mutations) {
  return mutations.some((mutation) => {
    if (mutation.type !== "childList") return false;
    for (let index = 0; index < mutation.addedNodes.length; index++) {
      const node = mutation.addedNodes[index];
      if (isElementNode(node) && isStructuralTarget(node)) return true;
    }
    return false;
  });
}

// src/client/composer.ts
var COMPOSER_INPUT_SELECTOR = "[data-composer-input]";
var TOUCH_TIER_QUERY = "(max-width: 1023px) and (pointer: coarse)";
var PHONE_TIER_QUERY = "(max-width: 768px) and (pointer: coarse)";
function isEditableComposer(input) {
  return input !== null && input !== void 0 && input.contentEditable === "true";
}
function hasHighlightedMenuOpen() {
  const highlighted = document.querySelector(
    '[data-trigger-menu] [aria-activedescendant], [data-trigger-menu] [role="option"][aria-selected="true"]'
  );
  return highlighted !== null;
}
function createComposingGuard() {
  let lastCompositionEnd = 0;
  const onStart = () => {
    lastCompositionEnd = 0;
  };
  const onEnd = () => {
    lastCompositionEnd = Date.now();
  };
  return {
    isComposingNow: () => Date.now() - lastCompositionEnd < 10,
    attach: () => {
      document.addEventListener("compositionstart", onStart, true);
      document.addEventListener("compositionend", onEnd, true);
      return () => {
        document.removeEventListener("compositionstart", onStart, true);
        document.removeEventListener("compositionend", onEnd, true);
      };
    }
  };
}
function installEnterToNewline() {
  const composing = createComposingGuard();
  const detachComposing = composing.attach();
  let warnedOnce = false;
  const onKeyDown = (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    if (event.repeat) return;
    if (event.ctrlKey || event.metaKey) return;
    if (composing.isComposingNow()) return;
    const input = event.target instanceof Element ? event.target.closest(COMPOSER_INPUT_SELECTOR) : null;
    if (!(input instanceof HTMLElement) || !isEditableComposer(input)) return;
    if (hasHighlightedMenuOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    const fingerprint = composerFingerprint(input);
    const ok = document.execCommand("insertLineBreak");
    if (!ok) {
      const fallbackOk = document.execCommand("insertText", false, "\n");
      if (!fallbackOk && fingerprint === composerFingerprint(input) && !insertLineBreakManually(input)) {
        if (!warnedOnce) {
          warnedOnce = true;
          console.warn("[dsh-chamber.mobile] composer line-break insertion failed (execCommand + DOM fallback)");
        }
      }
    }
    revealCaretInComposerScroll(input);
  };
  document.addEventListener("keydown", onKeyDown, true);
  return () => {
    document.removeEventListener("keydown", onKeyDown, true);
    detachComposing();
  };
}
function composerFingerprint(input) {
  if (input === null) return "";
  return `${input.childNodes.length}:${input.textContent ?? ""}`;
}
function insertLineBreakManually(input) {
  if (input === null || !(input instanceof HTMLElement) || input.contentEditable !== "true") return false;
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (!input.contains(range.commonAncestorContainer)) return false;
  if (!range.collapsed) return false;
  try {
    const br = document.createElement("br");
    range.insertNode(br);
    range.setStartAfter(br);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
}
function caretRevealDelta(rectTop, rectBottom, hostTop, hostBottom, margin = 8) {
  if (rectBottom > hostBottom) return rectBottom - hostBottom + margin;
  if (rectTop < hostTop) return rectTop - hostTop - margin;
  return 0;
}
function revealCaretInComposerScroll(input) {
  if (input === null) return;
  const scrollHost = input.closest("[data-input-scroll]");
  if (!(scrollHost instanceof HTMLElement)) return;
  if (scrollHost.scrollHeight <= scrollHost.clientHeight) return;
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0) return;
  const hostRect = scrollHost.getBoundingClientRect();
  let rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.height === 0 && rect.width === 0) {
    const anchor = selection.focusNode;
    const element = anchor instanceof Element ? anchor : anchor?.parentElement;
    if (element instanceof Element) rect = element.getBoundingClientRect();
  }
  if (rect.height === 0 && rect.width === 0) return;
  const delta = caretRevealDelta(rect.top, rect.bottom, hostRect.top, hostRect.bottom);
  if (delta !== 0) scrollHost.scrollTop += delta;
}
function isEditabilityFlipToEditable(editableNow, focused, previousEditable, recordOldValues) {
  if (!editableNow || !focused) return false;
  return previousEditable === false || recordOldValues.includes("false");
}
var EDITABILITY_MUTATION_OPTIONS = {
  attributes: true,
  attributeFilter: ["contenteditable"],
  subtree: true,
  attributeOldValue: true
};
function installEditabilityRecovery(root = document) {
  let current = null;
  let lastEditable = null;
  const query = () => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR);
    return input instanceof HTMLElement ? input : null;
  };
  const seed = (input) => {
    current = input;
    lastEditable = input === null ? null : input.contentEditable === "true";
  };
  seed(query());
  const observer = new MutationObserver((records) => {
    const input = query();
    if (input === null) {
      seed(null);
      return;
    }
    const editable = input.contentEditable === "true";
    const previous = input === current ? lastEditable : editable;
    if (isEditabilityFlipToEditable(
      editable,
      input === document.activeElement,
      previous,
      records.map((record) => record.oldValue)
    )) {
      input.blur();
      input.focus({ preventScroll: true });
    }
    seed(input);
  });
  observer.observe(root, EDITABILITY_MUTATION_OPTIONS);
  return () => observer.disconnect();
}
function isKeyboardOpen(layoutHeight, visualHeight) {
  const gap = layoutHeight - visualHeight;
  return gap > 120 && gap > layoutHeight * 0.2;
}
function installImeLadder(root = document) {
  let lastPointerDown = 0;
  let lastPointerDownInSeat = false;
  let keyboardOpen = false;
  const syncKeyboard = () => {
    const vv = window.visualViewport;
    keyboardOpen = vv !== null && isKeyboardOpen(window.innerHeight, vv.height);
  };
  const gestureInSeat = (event) => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR);
    if (!(input instanceof Element)) return false;
    const seat = input.closest("[data-composer-seat]");
    const zone = seat instanceof Element ? seat : input;
    return event.target instanceof Node && zone.contains(event.target);
  };
  const onPointerDown = (event) => {
    lastPointerDown = Date.now();
    lastPointerDownInSeat = gestureInSeat(event);
  };
  const onFocusIn = (event) => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR);
    if (!(input instanceof HTMLElement)) return;
    if (event.target !== input && !input.contains(event.target)) return;
    const fromGesture = Date.now() - lastPointerDown < 500 && lastPointerDownInSeat;
    if (fromGesture) return;
    let frames = 0;
    let cancelled = false;
    const onGestureCancel = (event2) => {
      if (gestureInSeat(event2)) cancelled = true;
    };
    document.addEventListener("pointerdown", onGestureCancel, true);
    const drop = () => {
      frames += 1;
      if (frames > 12 || cancelled) {
        document.removeEventListener("pointerdown", onGestureCancel, true);
        return;
      }
      if (input === document.activeElement && !keyboardOpen) {
        input.blur();
        requestAnimationFrame(drop);
      } else {
        document.removeEventListener("pointerdown", onGestureCancel, true);
      }
    };
    drop();
  };
  const onPointerUp = (event) => {
    if (event.pointerType === "mouse") return;
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR);
    if (!(input instanceof HTMLElement)) return;
    if (!input.contains(event.target)) return;
    if (input === document.activeElement) return;
    if (keyboardOpen) return;
    input.focus({ preventScroll: true });
  };
  const onViewportResize = () => {
    syncKeyboard();
  };
  return {
    attach: () => {
      syncKeyboard();
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("focusin", onFocusIn, true);
      document.addEventListener("pointerup", onPointerUp, true);
      window.visualViewport?.addEventListener("resize", onViewportResize);
      window.visualViewport?.addEventListener("scroll", onViewportResize);
      return () => {
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("focusin", onFocusIn, true);
        document.removeEventListener("pointerup", onPointerUp, true);
        window.visualViewport?.removeEventListener("resize", onViewportResize);
        window.visualViewport?.removeEventListener("scroll", onViewportResize);
      };
    },
    isKeyboardOpen: () => keyboardOpen
  };
}
var KBD_OFFSET_QUANTUM_PX = 16;
var KBD_OFFSET_HEADROOM_PX = 8;
var MOBILE_KBD_ATTR = "data-mobile-kbd";
var MOBILE_KBD_VAR = "--chamber-mobile-kbd-offset";
var KBD_EDITABLE_FOCUS_GRACE_MS = 1200;
var ACTIVE_SEAT_SELECTOR = '[data-phase="active"] [data-composer-seat]';
function kbdCoveredHeight(layoutHeight, visualHeight, visualOffsetTop) {
  return Math.max(0, layoutHeight - visualOffsetTop - visualHeight);
}
function nextKbdOffset(covered, quantum = KBD_OFFSET_QUANTUM_PX, headroom = KBD_OFFSET_HEADROOM_PX) {
  if (covered <= 0) return 0;
  return Math.ceil((covered + headroom) / quantum) * quantum;
}
function isAtScrollEnd(scrollTop, scrollHeight, clientHeight, slack = 8) {
  if (clientHeight <= 0 || scrollHeight <= clientHeight) return true;
  return scrollTop + clientHeight >= scrollHeight - slack;
}
function shouldCompensateKeyboard(keyboardOpen, visualScale, editableFocused, composerFocused) {
  if (!keyboardOpen || !editableFocused) return false;
  if (visualScale > 1.01 && !composerFocused) return false;
  return true;
}
function isEditableFocus(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA";
}
function isComposerSelection() {
  const selection = document.getSelection();
  const anchor = selection?.anchorNode ?? null;
  if (anchor === null) return false;
  const element = anchor instanceof Element ? anchor : anchor.parentElement;
  if (!(element instanceof Element)) return false;
  return element.closest(COMPOSER_INPUT_SELECTOR) !== null || element.closest("[data-composer-seat]") !== null;
}
function installKeyboardCompensation(root = document) {
  const vv = window.visualViewport;
  if (vv === null) return () => {
  };
  let applied = 0;
  let armedFrame = null;
  let lastEditableFocusAt = 0;
  const disarm = () => {
    if (armedFrame === null) return;
    armedFrame.removeAttribute(MOBILE_KBD_ATTR);
    armedFrame.style.removeProperty(MOBILE_KBD_VAR);
    armedFrame = null;
  };
  const editableFocused = () => {
    if (isEditableFocus(document.activeElement)) return true;
    if (isComposerSelection()) return true;
    return Date.now() - lastEditableFocusAt < KBD_EDITABLE_FOCUS_GRACE_MS;
  };
  const composerFocused = () => {
    const active = document.activeElement;
    if (active instanceof Element && (active.closest(COMPOSER_INPUT_SELECTOR) !== null || active.closest("[data-composer-seat]") !== null)) {
      return true;
    }
    return isComposerSelection();
  };
  const sync = () => {
    const layoutHeight = window.innerHeight;
    const target = shouldCompensateKeyboard(
      isKeyboardOpen(layoutHeight, vv.height),
      vv.scale,
      editableFocused(),
      composerFocused()
    ) ? nextKbdOffset(kbdCoveredHeight(layoutHeight, vv.height, vv.offsetTop)) : 0;
    if (target === 0) {
      applied = 0;
      disarm();
      return;
    }
    const seat = root.querySelector(ACTIVE_SEAT_SELECTOR);
    if (!(seat instanceof Element)) return;
    const frame = seat.closest("[data-mobile-frame]");
    if (!(frame instanceof HTMLElement)) return;
    const armed = frame === armedFrame && frame.hasAttribute(MOBILE_KBD_ATTR);
    if (armed && target === applied) return;
    if (armedFrame !== null && armedFrame !== frame) disarm();
    const scroller = seat.closest("[data-conversation-scroll]");
    const wasAtEnd = scroller instanceof HTMLElement && isAtScrollEnd(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight);
    const delta = armed ? target - applied : target;
    frame.setAttribute(MOBILE_KBD_ATTR, "");
    frame.style.setProperty(MOBILE_KBD_VAR, `${target}px`);
    armedFrame = frame;
    applied = target;
    if (wasAtEnd && scroller instanceof HTMLElement && delta > 0) {
      scroller.scrollTop += delta;
    }
  };
  const onViewportChange = () => sync();
  const onFocusIn = (event) => {
    if (isEditableFocus(event.target)) lastEditableFocusAt = Date.now();
    sync();
  };
  const onFocusOut = (event) => {
    if (isEditableFocus(event.target)) lastEditableFocusAt = Date.now();
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") sync();
  };
  sync();
  vv.addEventListener("resize", onViewportChange);
  vv.addEventListener("scroll", onViewportChange);
  window.addEventListener("resize", onViewportChange);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    vv.removeEventListener("resize", onViewportChange);
    vv.removeEventListener("scroll", onViewportChange);
    window.removeEventListener("resize", onViewportChange);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
    document.removeEventListener("visibilitychange", onVisibility);
    applied = 0;
    disarm();
  };
}
var BUSY_STUCK_MS = 3e4;
var BUSY_COMPOSER_PHASES = ["adjudicating", "submitting"];
function isComposerSubmitBusy(phase) {
  return phase !== null && phase !== void 0 && BUSY_COMPOSER_PHASES.includes(phase);
}
function isOfficiallyDisabled(input) {
  return input.getAttribute("aria-disabled") === "true";
}
function lockClock(editable, busy, disabled, since, now) {
  if (editable || !busy || disabled) return 0;
  return since === 0 ? now : since;
}
function shouldRecoverStuckComposer(facts) {
  return !facts.editable && facts.busy && !facts.disabled && facts.elapsedMs >= BUSY_STUCK_MS;
}
var SELF_HEAL_MUTATION_OPTIONS = {
  attributes: true,
  attributeFilter: ["contenteditable", "data-phase", "aria-disabled"],
  subtree: true
};
function installComposerSelfHeal(root = document) {
  let current = null;
  let lockedSince = 0;
  const query = () => {
    const input = root.querySelector(COMPOSER_INPUT_SELECTOR);
    return input instanceof HTMLElement ? input : null;
  };
  const sync = (input, now = Date.now()) => {
    if (input === null) {
      current = null;
      lockedSince = 0;
      return;
    }
    if (input !== current) {
      current = input;
      lockedSince = 0;
    }
    lockedSince = lockClock(
      input.contentEditable === "true",
      isComposerSubmitBusy(input.dataset.phase),
      isOfficiallyDisabled(input),
      lockedSince,
      now
    );
  };
  sync(query());
  const observer = new MutationObserver(() => sync(query()));
  const onPointerDown = (event) => {
    if (event.pointerType === "mouse") return;
    const input = query();
    if (input === null || !input.contains(event.target)) return;
    sync(input);
    if (lockedSince === 0) return;
    const recover = shouldRecoverStuckComposer({
      editable: input.contentEditable === "true",
      busy: isComposerSubmitBusy(input.dataset.phase),
      disabled: isOfficiallyDisabled(input),
      elapsedMs: Date.now() - lockedSince
    });
    lockedSince = 0;
    if (!recover) return;
    input.blur();
    input.contentEditable = "true";
    input.focus({ preventScroll: true });
  };
  observer.observe(root, SELF_HEAL_MUTATION_OPTIONS);
  document.addEventListener("pointerdown", onPointerDown, true);
  return () => {
    observer.disconnect();
    document.removeEventListener("pointerdown", onPointerDown, true);
  };
}

// src/client/layout-facts.ts
function findFrame2() {
  const root = document.querySelector('[data-slot="root"]');
  if (root === null) return null;
  for (const child of root.children) {
    if (child instanceof Element) return child;
  }
  return null;
}
function createLayoutFactSource(ctx) {
  let facts;
  try {
    facts = ctx.layoutFacts;
  } catch {
    facts = void 0;
  }
  const tier = window.matchMedia(TOUCH_TIER_QUERY);
  if (facts !== void 0) {
    const listeners2 = /* @__PURE__ */ new Set();
    const notify2 = () => {
      for (const listener of listeners2) listener();
    };
    const unsubscribeStore = facts.subscribeLayout(notify2);
    const onTierChange2 = () => notify2();
    tier.addEventListener("change", onTierChange2);
    return {
      getCollapsed: () => facts.getCollapsed(),
      getNarrow: () => tier.matches,
      subscribe: (listener) => {
        listeners2.add(listener);
        listener();
        return () => {
          listeners2.delete(listener);
        };
      },
      dispose: () => {
        unsubscribeStore();
        tier.removeEventListener("change", onTierChange2);
      }
    };
  }
  const listeners = /* @__PURE__ */ new Set();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  let frame = findFrame2();
  const frameObserver = new MutationObserver(notify);
  const attach = () => {
    const next = findFrame2();
    if (next === frame) return;
    if (frame !== null) frameObserver.disconnect();
    frame = next;
    if (frame !== null) {
      frameObserver.observe(frame, { attributes: true, attributeFilter: ["data-sidebar-collapsed", "data-rightbar-collapsed"] });
    }
    notify();
  };
  attach();
  const isStructuralTarget2 = (node) => node instanceof Element && (node.matches('[data-slot="root"]') || node.parentElement?.matches('[data-slot="root"]') === true);
  const bodyObserver = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => mutation.type === "childList" && Array.from(mutation.addedNodes).some((node) => isStructuralTarget2(node)))) {
      attach();
    }
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });
  const onTierChange = () => notify();
  tier.addEventListener("change", onTierChange);
  return {
    // Fail-safe null: no frame yet reads as "collapsed" (no scroll lock),
    // which is the safe direction while the shell is still mounting.
    getCollapsed: () => frame === null || frame.hasAttribute("data-sidebar-collapsed"),
    getNarrow: () => tier.matches,
    subscribe: (listener) => {
      listeners.add(listener);
      listener();
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      frameObserver.disconnect();
      bodyObserver.disconnect();
      tier.removeEventListener("change", onTierChange);
    }
  };
}

// src/client/drawer-taps.ts
var DRAWER_SIDEBAR_SELECTOR = '[data-mobile-role="sidebar"]';
var HEAL_FORM_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
var TAP_SLOP_PX = 12;
var HEAL_GRACE_MS = 120;
var HEAL_SUPPRESS_MS = 150;
function isStableTap(geometry, slop = TAP_SLOP_PX) {
  return Math.abs(geometry.endX - geometry.startX) <= slop && Math.abs(geometry.endY - geometry.startY) <= slop;
}
function isHealableDrawerTarget(target) {
  if (target === null) return false;
  if (target.closest(HEAL_FORM_SELECTOR) !== null) return false;
  return target.closest(DRAWER_SIDEBAR_SELECTOR) !== null;
}
function shouldClearPendingHeal(facts) {
  return facts.atOrInsideTapTarget || facts.ancestorOfTapTarget;
}
function isSuppressedLateClick(healFiredAtMs, nowMs, dx, dy) {
  const since = nowMs - healFiredAtMs;
  if (since < 0 || since > HEAL_SUPPRESS_MS) return false;
  return Math.abs(dx) <= TAP_SLOP_PX && Math.abs(dy) <= TAP_SLOP_PX;
}
function installDrawerTapHeal(active) {
  const pointerStarts = /* @__PURE__ */ new Map();
  let pending = null;
  let healFired = null;
  const clearPending = () => {
    if (pending === null) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending = null;
  };
  const onPointerDown = (event) => {
    if (!active()) return;
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    const downTarget = event.target instanceof Element ? event.target : null;
    pointerStarts.set(event.pointerId, { x: event.clientX, y: event.clientY, downTarget });
    healFired = null;
  };
  const onPointerUp = (event) => {
    if (!active()) return;
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    const start = pointerStarts.get(event.pointerId);
    pointerStarts.delete(event.pointerId);
    if (start === void 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!isStableTap({ startX: start.x, startY: start.y, endX: event.clientX, endY: event.clientY })) return;
    if (!isHealableDrawerTarget(start.downTarget)) return;
    if (!isHealableDrawerTarget(target)) return;
    clearPending();
    const record = { target, timer: null };
    pending = record;
    record.timer = setTimeout(() => {
      if (pending !== record) return;
      pending = null;
      if (!active()) return;
      if (!record.target.isConnected) return;
      healFired = { time: Date.now(), x: event.clientX, y: event.clientY };
      record.target.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window
      }));
    }, HEAL_GRACE_MS);
  };
  const onPointerCancel = (event) => {
    pointerStarts.delete(event.pointerId);
  };
  const onClick = (event) => {
    if (pending !== null) {
      if (!(event.target instanceof Node)) return;
      const clickInsidePending = pending.target === event.target || pending.target.contains(event.target);
      const pendingInsideClick = event.target instanceof Element && event.target.contains(pending.target);
      if (shouldClearPendingHeal({ atOrInsideTapTarget: clickInsidePending, ancestorOfTapTarget: pendingInsideClick })) {
        clearPending();
      }
      return;
    }
    if (healFired === null || !event.isTrusted || !(event.target instanceof Node)) return;
    if (!isSuppressedLateClick(healFired.time, Date.now(), event.clientX - healFired.x, event.clientY - healFired.y)) return;
    healFired = null;
    event.stopPropagation();
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("pointercancel", onPointerCancel, true);
  document.addEventListener("click", onClick, true);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointerup", onPointerUp, true);
    document.removeEventListener("pointercancel", onPointerCancel, true);
    document.removeEventListener("click", onClick, true);
    clearPending();
    pointerStarts.clear();
    healFired = null;
  };
}

// src/client/settings-sheet.ts
var SETTINGS_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';
function isSectionChipClick(target, nav) {
  if (target === null || nav === null) return false;
  const chip = target.closest("button");
  if (chip === null) return false;
  return chip.closest("nav") === nav;
}
function installSettingsSheetScrollReset(active) {
  const onClick = (event) => {
    if (!active()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    const dialog = target.closest(SETTINGS_DIALOG_SELECTOR);
    if (!(dialog instanceof Element)) return;
    if (dialog.querySelector('[data-slot="settings.header"]') === null) return;
    const nav = dialog.querySelector(":scope > nav");
    if (!(nav instanceof Element)) return;
    if (!isSectionChipClick(target, nav)) return;
    requestAnimationFrame(() => {
      let scroller = dialog.querySelector('[data-slot="settings.section"]')?.parentElement ?? null;
      while (scroller instanceof HTMLElement && scroller !== dialog) {
        scroller.scrollTop = 0;
        scroller = scroller.parentElement;
      }
      const content = dialog.lastElementChild;
      if (content instanceof HTMLElement) content.scrollTop = 0;
    });
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}

// src/client/MobileNavToggle.tsx
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime = require("react/jsx-runtime");
function findFrame3(root) {
  for (const child of root.children) {
    if (child instanceof Element) return child;
  }
  return null;
}
function MobileNavToggle({ toggleSidebar, t }) {
  const [open, setOpen] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    const root = document.querySelector('[data-slot="root"]');
    if (root === null) return;
    const frame = findFrame3(root);
    if (frame === null) return;
    const sync = () => setOpen(!frame.hasAttribute("data-sidebar-collapsed"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(frame, { attributes: true, attributeFilter: ["data-sidebar-collapsed"] });
    return () => observer.disconnect();
  }, []);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        type: "button",
        className: "dsh-mobile-nav-toggle",
        "aria-label": open ? t("dsh-chamber.mobile.drawer.close") : t("dsh-chamber.mobile.drawer.open"),
        "aria-expanded": open,
        onClick: () => toggleSidebar(),
        children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconPanelLeftOutline16, { size: 18 })
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        type: "button",
        className: "dsh-mobile-backdrop",
        "aria-label": t("dsh-chamber.mobile.drawer.close"),
        tabIndex: -1,
        onClick: () => toggleSidebar()
      }
    )
  ] });
}

// src/client/index.ts
var NS = "dsh-chamber.mobile";
var inject = ["slots", "locale", "layout"];
function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-chamber: mobile dictionaries");
  ctx.effect(() => {
    const disposers = [];
    const touchTier = window.matchMedia(TOUCH_TIER_QUERY);
    if (touchTier.matches) {
      const meta = document.querySelector('meta[name="viewport"]');
      if (meta instanceof HTMLMetaElement) {
        const content = meta.content;
        const missing = VIEWPORT_TOKENS.filter((token) => !content.includes(token));
        if (missing.length > 0) {
          meta.content = [content, ...missing].filter(Boolean).join(", ");
          disposers.push(() => {
            meta.content = content;
          });
        }
      } else {
        const created = document.createElement("meta");
        created.name = "viewport";
        created.content = `width=device-width, initial-scale=1, ${VIEWPORT_TOKENS.join(", ")}`;
        document.head.appendChild(created);
        disposers.push(() => created.remove());
      }
    }
    if (document.querySelector(`style[data-plugin="${PLUGIN_STYLE_TAG}"]`) === null) {
      const style = document.createElement("style");
      style.setAttribute("data-plugin", PLUGIN_STYLE_TAG);
      style.textContent = MOBILE_CSS;
      document.head.appendChild(style);
      disposers.push(() => style.remove());
    }
    const existingThemeMeta = document.querySelector('meta[name="theme-color"]');
    const themeMeta = existingThemeMeta ?? document.createElement("meta");
    if (existingThemeMeta === null) {
      themeMeta.name = "theme-color";
      document.head.appendChild(themeMeta);
      disposers.push(() => themeMeta.remove());
    }
    const syncThemeColor = () => {
      const surface = getComputedStyle(document.body).getPropertyValue("--dsw-alias-bg-base").trim();
      themeMeta.setAttribute("content", surface === "" ? "#ffffff" : surface);
    };
    syncThemeColor();
    const themeObserver = new MutationObserver(syncThemeColor);
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme", "class"] });
    disposers.push(() => themeObserver.disconnect());
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "dsh-chamber: mobile assets");
  ctx.effect(() => {
    let frameAttributeObserver = null;
    const stamp = () => {
      const roots = document.querySelectorAll(ROOT_SLOT_SELECTOR);
      for (const root of roots) stampFrame(root);
      frameAttributeObserver?.disconnect();
      frameAttributeObserver = null;
      const frames = [];
      for (const root of roots) {
        const frame = root.firstElementChild;
        if (frame instanceof Element) frames.push(frame);
      }
      if (frames.length === 0) return;
      frameAttributeObserver = new MutationObserver(() => stamp());
      for (const frame of frames) {
        frameAttributeObserver.observe(frame, {
          attributes: true,
          attributeFilter: ["data-sidebar-collapsed", "data-rightbar-collapsed"]
        });
      }
    };
    const onMutations = (mutations) => {
      if (shouldRestamp(mutations)) stamp();
    };
    stamp();
    const childListObserver = new MutationObserver(onMutations);
    childListObserver.observe(document.body, { childList: true, subtree: true });
    return () => {
      childListObserver.disconnect();
      frameAttributeObserver?.disconnect();
    };
  }, "dsh-chamber: mobile frame stamping");
  const layoutSource = createLayoutFactSource(ctx);
  ctx.effect(() => {
    let lastLocked = false;
    const lockScroll = (locked) => {
      const containers = document.querySelectorAll("[data-conversation-scroll]");
      for (const container of containers) {
        if (container instanceof HTMLElement) {
          container.style.overflow = locked ? "hidden" : "";
        }
      }
      document.body.style.overflow = locked ? "hidden" : "";
    };
    const sync = () => {
      const locked = layoutSource.getNarrow() && !layoutSource.getCollapsed();
      if (locked === lastLocked) return;
      lastLocked = locked;
      lockScroll(locked);
    };
    const unsubscribe = layoutSource.subscribe(sync);
    return () => {
      unsubscribe();
      lockScroll(false);
    };
  }, "dsh-chamber: mobile drawer scroll lock");
  ctx.effect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (!layoutSource.getNarrow()) return;
      const modalOpen = document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
      if (modalOpen) return;
      if (!layoutSource.getCollapsed()) ctx.layout.toggleSidebar();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, "dsh-chamber: mobile drawer escape close");
  ctx.effect(() => () => layoutSource.dispose(), "dsh-chamber: mobile layout source");
  ctx.effect(() => {
    const touchTier = window.matchMedia(TOUCH_TIER_QUERY);
    const phoneTier = window.matchMedia(PHONE_TIER_QUERY);
    let disposers = [];
    const sync = () => {
      if (touchTier.matches) {
        if (disposers.length === 0) {
          const ladder = installImeLadder();
          disposers = [
            installEnterToNewline(),
            installEditabilityRecovery(),
            installKeyboardCompensation(),
            installComposerSelfHeal(),
            // iOS suppresses the compatibility click for drawer taps (the
            // hover-reveal layout shift) — heal the lost activation so one
            // tap switches sessions (drawer-taps.ts).
            installDrawerTapHeal(() => touchTier.matches),
            // Phone-tier settings sheet: switching section chips must reset
            // the shared options scroller (settings-sheet.ts).
            installSettingsSheetScrollReset(() => phoneTier.matches),
            ladder.attach()
          ];
        }
      } else {
        for (const dispose of disposers) dispose();
        disposers = [];
      }
    };
    sync();
    touchTier.addEventListener("change", sync);
    return () => {
      touchTier.removeEventListener("change", sync);
      for (const dispose of disposers) dispose();
    };
  }, "dsh-chamber: mobile composer behavior");
  const injected = () => ({
    toggleSidebar: () => ctx.layout.toggleSidebar(),
    t
  });
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({
    name: "shell.overlay",
    id: "mobile-nav-toggle",
    label: () => t("dsh-chamber.mobile.title"),
    locale: NS,
    inject: injected
  }, MobileNavToggle));
}
return module.exports; } });
//# sourceMappingURL=client.js.map
