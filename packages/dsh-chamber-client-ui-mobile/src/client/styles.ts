/**
 * Mobile adaptation stylesheet: one global <style data-plugin="..."> injected
 * at apply(). Anchors are OFFICIAL stable attributes (keyed main / rightbar
 * columns; frame data-sidebar-collapsed|data-rightbar-collapsed) plus this
 * plugin's data-mobile-* stamps. CROSS-PACKAGE RULE: hooks are attributes,
 * never classes (classes are hashed per bundle). Exception: the composer bar
 * row, the settings Models row and the conversation to-bottom slot match a
 * compiled local name in BOTH build shapes
 * (local-first _<local>_<hash>_<idx> and hash-first [hash]_[local]) — the arm
 * keeps a suffix AND an infix term, and dropping the infix matches nothing.
 * These local-name exceptions are NOT covered by the anchor gate (it extracts
 * data-* / role / slot / hash tokens only): they are pinned by
 * test/behavior/composer-guard.test.ts, and the pin-upgrade re-anchor step
 * must re-verify each local name in the served bundles (README "Anchor
 * baseline").
 * The model trigger instead anchors on [data-slot="conversation.input.model"].
 * Tokens are official --dsw-* / --ds-* only (no literal colors but fallbacks);
 * dark theme follows the official flip. Every rule is inside a media query
 * (fine-pointer desktop untouched): touch (max-width:1023px) and
 * (pointer:coarse) = overlay drawer / fullscreen right panel / 44px targets;
 * phone (max-width:768px) and (pointer:coarse) = one-line composer toolbar,
 * viewport-constrained popups, stacked settings sheet, fields >=16px (iOS
 * focus zoom); chrome (pointer:coarse) and (hover:none) = hover tooltips only.
 * pointer:coarse is the PC-leak guard, mirrored in JS. data-sidebar-collapsed
 * is PRESENT when collapsed and REMOVED when expanded, so
 * :not([data-sidebar-collapsed]) is the open condition;
 * data-rightbar-collapsed means "no retained track", NOT "hidden", so the
 * drawer yield also uses [data-rightbar-fullscreen] for the auto-fullscreen
 * phone case. The drawer is the frame's own sidebar COLUMN taken out of the
 * grid flow and fixed (z-75, its own root stacking layer); it is NOT a
 * shell.overlay entry — only the floating toggle (z-76) and the backdrop
 * (z-74) are, and those live inside shell.overlay's own z-20 layer with
 * z-indexes of their own. The drawer deliberately outranks the fullscreen
 * rightbar (z-40) and the floating host (z-60); the two yield arms below are
 * what keep it off a SHOWN panel. ACCEPTED TRADEOFF: closing a panel clears
 * [data-rightbar-fullscreen] in the same commit the slide-out starts, so an
 * open drawer becomes visible again immediately and paints OVER the panel for
 * its exit transition (~0.3s). Delaying the retract by the panel animation
 * would also delay the next drawer open, so the overlap is accepted. The
 * SETTINGS dialog is body-portaled by upstream (rc.2 SettingsPanel
 * createPortal(..., document.body)), so the drawer's transform no longer traps
 * it; transform: none is kept deliberately. The composer is a
 * Lexical div[contenteditable][data-composer-input] —
 * there is NO textarea.
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
   (the component renders the bubble as the trigger's immediate next sibling),
   PLUS the WRAPPED-trigger sibling shape — three official sites render
   <span><button aria-label/></span> as the tooltip's anchor, so the button is
   a grandchild and the plain sibling arm cannot see it (the right-panel
   document preview's zoom +/- and the font warning): those match
   :is(span,div):has(> button[aria-label]) + [role="tooltip"][data-side], kept
   as an INDEPENDENT rule so an engine without :has() drops only that arm and
   leaves the two unconditional ones live,
   PLUS every portal-rendered bubble: portal:true moves the same .bubble
   (role="tooltip", data-side, data-portal) to <body> via createPortal, so the
   sibling arm cannot reach it and its sticky-hover latch is the same
   coarse-pointer artifact. The portal arm is structural and unconditional —
   at <body> there is no trigger relationship left to read — so the
   informational-bubble carve-out below applies to the SIBLING shape only.
   [data-side] is the component's own marker on both shapes — see the
   preserved list below.
   Of the 31 official Tooltip sites, 27 are aria-labelled buttons (composer
   send/stop/commands/ContextMeter, queue dock, goal bar, sidebar, message
   feedback, workspace rows, chat copy/branch) whose aria-label names the same
   action (3 of them phrase it slightly differently — workspace search ×2,
   trajectory load-earlier — same semantics; verified against the pinned
   install (see the module header). Four
   informational bubbles are deliberately
   NOT hidden because their trigger has no accessible duplicate: the chat
   stats line (ui-chat, ellipsized non-focusable div), the agent-preset
   card description (ui-agent-preset, line-clamp:4), the trajectory
   timeline span (ui-trajectory, aria-hidden, no click path) and the
   trajectory kind tag at ≤620px (ui-trajectory, visible label collapsed)
   — coordinates are a pin-0.2.0-rc.2 snapshot; line numbers drift with the pin,
   so re-anchor by SHAPE, not by the numbers
   — they keep the sticky-hover quirk rather than lose content a touch user
   cannot otherwise read. The tree's fifth role="tooltip" producer (ui-chat
   turn-rail preview, :1735) is a non-button div WITHOUT data-side and is
   therefore structurally outside this rule (it is aria-describedby-referenced
   and its rail is container-hidden ≤900px anyway). Desktop is untouched
   (media-query scoped). */
@media (pointer: coarse) and (hover: none) {
  button[aria-label] + [role="tooltip"][data-side],
  [role="tooltip"][data-portal][data-side] {
    display: none !important;
  }

  /* Wrapped-trigger sibling arm (see above). Its own rule on purpose: :has()
     is unsupported on older engines, and one invalid selector in the comma
     list above would invalidate the two unconditional arms with it. */
  :is(span, div):has(> button[aria-label]) + [role="tooltip"][data-side] {
    display: none !important;
  }

  /* data-tip bubbles: the hand-rolled ones on chamber pages (e.g. the
     connections settings sheet's .iconButton / .restartTip in
     ConnectionsSection.module.css, whose ::after carries content:
     attr(data-tip)) AND the official ones — upstream's agent-preset client row
     sets the data-tip attribute on its icon buttons and consumes it the same
     way (content:attr(data-tip) in its bundled CSS; a grep of only the SHELL
     bundle misses it — the dynamic client rows carry it too). Same
     coarse-pointer artifact as the official Tooltip above: the bubble is
     opacity-gated on :hover / :focus-visible, so a tap leaves the synthesized
     hover behind and the bubble stays over the row it describes. On the
     chamber pages every data-tip site pairs the attribute with aria-label
     (verified across the 13 sites; that package's Button
     prop surface documents the pairing), so no chamber accessible name is
     lost; the official sites are upstream's own pairing and are suppressed for
     the same reason as the tooltip rule above. Hiding only the pseudo-element
     leaves the host control, its box and its label untouched: pure CSS, no JS,
     desktop untouched (media-query scoped). */
  [data-tip]::after {
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
     covered with no way to make room. Give the whole touch tier the
     presentation upstream
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
     so a positional rule on the wrapper is a silent no-op. Target the
     panel's own upstream state
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
       surface on this tier does (drawer — its four insets were added in the
       same review pass — settings sheet, composer seat); the surface still
       paints full-bleed (background covers the padding box). */
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
    /* The drawer is the sidebar's replacement chrome and reaches the screen
       edges under viewport-fit=cover, so it owns the same iOS safe areas every
       other full-bleed surface on this tier carries; the tree has NO global
       border-box reset, so the padding must be declared inside the fixed
       width/height box. */
    box-sizing: border-box;
    padding-top: env(safe-area-inset-top, 0px);
    padding-right: env(safe-area-inset-right, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
    padding-left: env(safe-area-inset-left, 0px);
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
     exclusion). Attribute anchors, not a [class$="_handle"]
     local-name rule: the attribute seams are stable by contract, while a
     local-name suffix match would also catch unrelated handles.
     FUTURE-FRAGILE ANCHOR NOTE: the [data-side] exclusion
     is verified safe across the whole tree — no other
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
     split, so hiding it would remove a usable affordance on a false premise —
     the "the right surface is fullscreen here" half is untrue at 769-1023px
     as well (the tier presents that surface fullscreen, see the right-panel
     rule above). */
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
     panel toggle glyph at the touch size (the plugin draws no control of
     its own). */
  .dsh-mobile-nav-toggle {
    position: fixed;
    top: max(10px, env(safe-area-inset-top, 0px));
    left: max(10px, env(safe-area-inset-left, 0px));
    z-index: 76;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border: none;
    /* Official rail-toggle silhouette: the dsh sidebar's
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
  /* The toggle is the DRAWER's entry point, so it may only be VISIBLE when the
     drawer can actually work: the frame must be stamped AND the sidebar column
     must have been found (markup.ts writes data-mobile-roles from the same
     all-or-nothing probe that gates the frame, see stampFrame). Without this
     gate a vendor rename of the centre key would leave a floating button whose
     only effect is flipping a frame attribute nothing responds to — a dead
     control is worse than an absent one. The display switch lives in its own
     rule (not in the block above) so the artifact/test pins on that block stay
     valid; the stylesheet's media-query-free default already hides it. */
  [data-mobile-frame][data-mobile-roles~="sidebar"] .dsh-mobile-nav-toggle {
    display: inline-flex;
  }
  /* Same gate for the tap-absorbing backdrop: it exists only to close the
     drawer, so with no sidebar role found it must not cover the transcript.
     A separate rule (rather than editing the pinned backdrop rule) keeps the
     existing selector/declaration pins intact; equal specificity + later
     position means this one wins exactly when the sidebar role is absent. */
  [data-mobile-frame]:not([data-mobile-roles~="sidebar"]) .dsh-mobile-backdrop {
    display: none;
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
     focusable behind the panel.
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
     never overlap the header content. Real anchor-audited shape: the outer
     [data-slot="conversation.header"] outlet wrapper (display:contents) is
     the PARENT of <header>, and the [data-slot="conversation.session.header"]
     outlet is a child INSIDE the header (titleRow/tabs are its children) —
     the earlier "session outlet > <header>" reading was reversed. Two
     INDEPENDENT attribute rules keep the gutter on the header element either
     way: the outer outlet's direct child, and the header that directly parents
     the session outlet. They must NOT share one comma list: on an engine
     without :has() the whole list would be dropped, taking the attribute arm
     down with it. No hashed classes. The gutter reserves the toggle box plus
     an 8px gap (44px toggle + 8px gap + 10px toggle offset = 62px) inside the
     left safe area and is applied to the header (not the title row), so the
     tab strip is cleared too when a session has multiple views. */
  [data-mobile-frame] [data-slot="conversation.header"] > header {
    padding-left: calc(62px + env(safe-area-inset-left, 0px)) !important;
  }
  [data-mobile-frame] header:has(> [data-slot="conversation.session.header"]) {
    padding-left: calc(62px + env(safe-area-inset-left, 0px)) !important;
  }

  /* Crumbs/lineage chain: KEEP the official single-line contract and pan the
     strip instead of wrapping it. Upstream .crumbs is white-space:nowrap +
     overflow:hidden + min-width:0; a wrap rule would override the inherited
     nowrap to normal, which is a REGRESSION for the
     lineage chip: its count text is a bare span with NO class of its own (the
     upstream SubagentHeaderLineage class dictionary omits the count key it
     references), so the ONLY thing keeping "31 个子代理" on one line was the
     nowrap it inherited from this row. With normal, CJK broke per character
     and the badge rendered as a five-line vertical column (5 x 18px = 90px),
     inflating the title row from 30px to ~96px and squeezing the title.
     overflow-x:auto replaces the upstream clip so long ancestry chains stay
     reachable; the lineage chip is kept out of the shrink race in the phone
     tier below, so panning is the last resort rather than the mechanism. The
     scrollbar is hidden because the strip is a gesture surface, not a widget. */
  [data-mobile-frame] [data-slot="conversation.session.header"] nav {
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    white-space: nowrap;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  [data-mobile-frame] [data-slot="conversation.session.header"] nav::-webkit-scrollbar {
    display: none;
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
     The SEAT list is explicit and grows with upstream: the header's
     utilities + corner seats and the right panel's dockkit strip are
     included, because a three-seat list leaves them at their desktop
     sizes (28px) while the panel is a primary mobile surface.
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
     upstream intends. Scoped to the dockkit seat: the
     header-actions arm is left as shipped, so the header row keeps its verified
     geometry (its floor therefore lands on the CONTENT
     box: padded icon buttons render ~56px, and the header row grows with
      them). */
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

  /* Composer visibility guard (composer.ts installComposerVisibilityGuard,
     IME ladder layer 5): engines that ignore
     'interactive-widget=resizes-content' (iOS Safari, older Android WebViews)
     keep the LAYOUT viewport full-height when the soft keyboard opens, so the
     official sticky composer seat — pinned to the scrollport's layout bottom —
     ends up BEHIND the keyboard. The guard MEASURES how far the conversation
     scrollport's bottom edge sits below the visible bottom (visual viewport +
     its pan offset) and raises the seat's sticky bottom by exactly that much.
     The conversation's scroll range comes from an in-flow spacer the guard
     inserts before the seat ('data-mobile-kbd-spacer'), NOT from padding this
     scrollport: the scrollport is also the seat's sticky containing block, so
     a padding here shrank that containing block and the inset stacked with it
     — measured double lift, the seat landing 368px ABOVE the keyboard top on
     a 390x844 rig. State rides the plugin's own frame stamp:
     'data-mobile-kbd' (applied px) + 'data-mobile-kbd-state' (armed | idle |
     no-seat | no-frame | still-covered) + the '--chamber-mobile-kbd-offset'
     custom property on the stamped frame (never official attributes). Android
     Chrome WITH the token shrinks the layout viewport itself: the measured
     overlap is ~0, the guard stays idle, this rule stays inert. */
  [data-mobile-frame][data-mobile-kbd] [data-phase="active"] [data-composer-seat] {
    bottom: var(--chamber-mobile-kbd-offset, 0px) !important;
    /* The phone-tier safe-area padding (below) is home-indicator spacing for
       the UNCOVERED state; while the keyboard is up that inset sits behind
       the keyboard and would add up to ~34px of dead space below the raised
       seat (cross-check). Zeroing it cannot cause overlap: the lift comes
       from the keyboard geometry, not from the inset. */
    padding-bottom: 0 !important;
  }
  /* The back-to-bottom control rides the same lift. Upstream stamps
     [data-conversation-scroll] as the sticky containing block and pins the
     slot to bottom: calc(var(--dsh-composer-height, 152px) + 16px)
     (ui-chat toBottomSlot, served class <hash>_toBottomSlot): without the
     keyboard offset the control stays at the UNCOVERED composer height and
     the raised seat covers it. The selector is the REGISTERED local-name
     exception (module header + the composer-guard text lock; the served class
     is [hash]_[local], so only the suffix arm can match and a naming flip
     fails soft to the official bottom). The anchor gate now covers compiled
     local names as a hard-fail category and REQUIRED_ANCHORS lists
     _toBottomSlot, so a pin bump that renames it turns the gate red. */
  [data-mobile-frame][data-mobile-kbd] [data-conversation-scroll] :is([class$="_toBottomSlot"], [class*="_toBottomSlot "], [class*="_toBottomSlot_"]) {
    bottom: calc(var(--chamber-mobile-kbd-offset, 0px) + var(--dsh-composer-height, 152px) + 16px);
  }

  /* iOS focus zoom: ANY editable field below 16px auto-zooms the page on
     focus and the page STAYS zoomed. The composer, settings fields and dialog
     fields already carry the floor; the drawer's session search (13px,
     ui-workspace:1187) and inline rename (14px, :531) were the gap — a
     focus-zoom there would leave the composer behind the keyboard for the
     rest of the session. */
  [data-mobile-role="sidebar"] input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),
  [data-mobile-role="sidebar"] textarea {
    font-size: max(16px, var(--dsh-content-font-size, 16px)) !important;
  }
}

/* ---- phone tier (design 17 §18.4.2/§18.4.3) ---- */
@media (max-width: 768px) and (pointer: coarse) {
  /* Session header: one bounded row. The touch tier
     restored the official nowrap contract on the crumb strip; this tier
     decides WHAT gives up width. The header element itself is selected by the
     real DOM shape above (outer [data-slot="conversation.header"] outlet >
     <header>, plus the :has() arm); the row below reads the header's INSIDE,
     where the [data-slot="conversation.session.header"] outlet
     (display:contents) is a child of <header> and titleRow/tabs are its
     children. Upstream ConversationSessionHeader shape:
       [data-slot="conversation.session.header"] (outlet, display:contents)
         > div.titleRow
             > div.titleCluster > [nav.crumbs, div.headerActions]
             > div.headerUtilities
             > div.headerCorner[data-conversation-header-corner]
         > div.tabs[role=tablist]
     The lineage chip renders INSIDE nav.crumbs (inside its crumbSeg), so it
     sits at the END of the strip and must never be the element that is
     squeezed — that is exactly how the five-line vertical badge happened. The
     LAST crumbSeg absorbs instead, which it can do textually: the last
     segment's title is a span.crumb (rc.2 renders NO disabled button), and
     upstream .crumb already carries max-width:220px + text-overflow:ellipsis.
     NOTE the :has() arm is a DESCENDANT match on purpose — the nav is
     titleRow > titleCluster > nav, so a child combinator (> nav) would be a
     silent no-op. The :has() invalidation cost stays inside the header
     subtree, never the streaming transcript. */
  /* Same two INDEPENDENT arms as the touch tier (a shared comma list would
     lose the attribute arm wherever :has() is unsupported). */
  [data-mobile-frame] [data-slot="conversation.header"] > header {
    padding-top: calc(10px + env(safe-area-inset-top, 0px)) !important;
    padding-right: calc(12px + env(safe-area-inset-right, 0px)) !important;
  }
  [data-mobile-frame] header:has(> [data-slot="conversation.session.header"]) {
    padding-top: calc(10px + env(safe-area-inset-top, 0px)) !important;
    padding-right: calc(12px + env(safe-area-inset-right, 0px)) !important;
  }
  [data-mobile-frame] [data-slot="conversation.session.header"] > div:has(nav) {
    flex-wrap: nowrap;
    min-height: 48px;
  }
  /* The corner seat ships margin-right:-16px against upstream's 28px header
     padding. This tier narrows that padding to 12px, so the negative margin
     now only buys overlap risk. */
  [data-mobile-frame] [data-slot="conversation.session.header"] > div:has(nav) > div:last-child {
    margin-right: 0 !important;
  }
  /* hideChrome/settling renders the title row WITHOUT a nav child, so the
     :has(nav) arm above is inert exactly then and the corner seat keeps its
     upstream -16px margin against this tier's narrowed padding. Structural
     independent rule (the corner carries its own stable attribute). */
  [data-mobile-frame] [data-slot="conversation.session.header"] > div > [data-conversation-header-corner] {
    margin-right: 0 !important;
  }
  /* Shrink order, crumb strip (STRUCTURAL: the rc.2 crumb is a span — there is
     no disabled button to key on). Every segment except the LAST keeps its
     intrinsic width and is panned by the strip, and every crumb button stays
     at its intrinsic width; only the LAST segment (and the span crumb inside
     it) may shrink. Upstream .crumb already carries max-width:220px +
     text-overflow:ellipsis + white-space:nowrap, so the current title
     ellipsises instead of pushing the lineage chip out of the row. */
  [data-mobile-frame] [data-slot="conversation.session.header"] nav > span:not(:last-child),
  [data-mobile-frame] [data-slot="conversation.session.header"] nav > span > button {
    flex: 0 0 auto;
  }
  [data-mobile-frame] [data-slot="conversation.session.header"] nav > span:last-child {
    flex: 0 1 auto;
    min-width: 0;
  }
  /* The title is the LAST span of the segment (the first span is the
     separator); last-of-type is the structural pick — a :last-child form would
     target a trailing separator instead whenever the renderer ships one. */
  [data-mobile-frame] [data-slot="conversation.session.header"] nav > span:last-child > span:last-of-type {
    flex: 0 1 auto;
    min-width: 0;
  }
  /* Zero-lineage bare crumb (nav > span without a crumb class and with no
     inner span): the arm above only reaches a span CHILD, so the segment's own
     text needs the ellipsis contract itself. Its own rule on purpose: :has()
     in a shared selector would invalidate every other arm on engines without
     it. */
  [data-mobile-frame] [data-slot="conversation.session.header"] nav > span:not(:has(span)) {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Lineage chip: flex:0 0 auto so it is never in the shrink race, a 44px
     touch floor (upstream ships a 28px box) and a bounded, single-line count
     label. The count span is CLIPPED, never removed, so the accessible name
     keeps the full text. */
  [data-mobile-frame] [data-slot="conversation.session.header.lineage"] button {
    flex: 0 0 auto;
    min-width: 0;
    min-height: 44px;
    max-width: 100%;
    white-space: nowrap;
  }
  [data-mobile-frame] [data-slot="conversation.session.header.lineage"] button > svg {
    flex: none;
  }
  [data-mobile-frame] [data-slot="conversation.session.header.lineage"] button > span:last-of-type {
    min-width: 0;
    max-width: 8em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The two icon seats: the 44px floor must mean the BOX (the same decision
     the tab strip and the dockkit chips already carry). Without border-box a
     28px button with 6px padding renders ~56px and thickens the row for
     nothing. */
  [data-mobile-frame] [data-slot="conversation.session.header.utilities"] button,
  [data-mobile-frame] [data-slot="conversation.session.header.corner"] button {
    box-sizing: border-box;
  }

  /* Composer toolbar: one line. The official row wraps; force nowrap (the
     official 12px gap is kept — no gap override). */
  /* Local-name match, BOTH production shapes (see the header): suffix for the
     hash-first [hash]_[local] form (single- and multi-class), infix for the
     local-first _<local>_<hash>_<idx> form the pinned bundles emit. It also
     hits sibling rows whose local name ends in "row" inside the composer bar
     subtree (e.g. the queue dock's .row), which is harmless today — those rows
     declare no flex-wrap and carry no _trigger child. */
  [data-slot="conversation.composer.bar"] :is([class$="_row"], [class*="_row "], [class*="_row_"]) {
    flex-wrap: nowrap !important;
  }
  /* Model trigger: truncate instead of overflowing. Scoped to the model SEAT,
     not to every local name "trigger" in the row: the seat renders a
     div[data-slot="conversation.input.model"] wrapper around ModelSelect's
     button (upstream scoped-slots.tsx gives every slot an addressable wrapper),
     while the row's trailing cluster also holds ContextMeter — same "trigger"
     local name, but flex:none and width:28px. A class-name arm therefore capped
     the 28px ring's max-width and overrode its flex:none. The seat anchor is the
     narrow one; test/behavior/composer-guard.test.ts pins both it and the absence of any
     "trigger" class arm. */
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
     a positional div:first-child. Both
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
     are TWO grids under this very section with two DIFFERENT upstream rules:
     - PluginInventorySettingsTab.module.css collapses its .cards itself at
       max-width: 680px, so a chamber override would contradict upstream in
       the 681-768px window;
     - ui-agent-preset AgentPresetSection.module.css declares NO breakpoint at
       all — its .cards is repeat(auto-fill, minmax(268px, 1fr)) inside a
       .section capped at 720px, so upstream renders TWO columns from about
       580px of viewport width (two 268px cards plus the 12px gap need 548px
       inside the options box = viewport minus 2x(16px + safe-area)). For that
       grid a chamber override would change the layout across its WHOLE
       two-column range, about 580-768px of the phone tier, not just 681-768px.
     Upstream's geometry is the only geometry for each of them. */
  [data-slot="settings.section"] :is([class$="_modelRow"], [class*="_modelRow "], [class*="_modelRow_"]) {
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
     than the settings sheet are NOT capped. The tree has FOUR producers of
     role="dialog" + aria-modal="true", and each owns its viewport fit: the
     settings panel above (this sheet), the ui-settings-account PlatformOverlay
     (a body portal whose overlay pins inset 0 at z-1001, the account/about
     surfaces), the ui-primitives Modal (Modal.module.css pins its Root to
     inset 0 with a 24px padding and caps the Dialog at min(380px, 100%)) and
     the ui-primitives ImageLightbox (a fixed full-bleed backdrop at inset 0
     whose mask is an absolute inset-0 layer). A blanket max-width is
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

/* ---- narrow phone tier: 480px and below ----
   The session header's width budget at 390px is ~78px of title after the
   floating toggle gutter, the two 44px icon seats, the agent-preset label and
   the lineage chip. The agent-preset label is the only text-bearing direct
   child of the actions seat and it is READ-ONLY (upstream's AgentPresetLabel
   names the session's fixed composition; there is no control behind it), so
   its LABEL is the cheapest thing to give width back: the icon stays and the
   text clips (rather than being removed), keeping the accessible name and
   the title attribute intact. The lineage chip keeps its digits — it is the
   only entry point to the subagent catalog. */
@media (max-width: 480px) and (pointer: coarse) {
  /* The headerActions seat's ONLY text-bearing direct child is upstream's
     agent-preset cell, and it is a bare span (AgentPresetLabel) — the schedule
     and job cells are div wrappers whose triggers are nested, so a
     "> button > span" selector matches nothing at all, and the
     HERO seat's button[aria-haspopup=menu] is upstream's own registration into
     conversation.hero.agentPreset — not into the header — so no rule is
     needed against it. Upstream already
     bounds that label itself (max-width 180px + nowrap + overflow hidden), so
     this tier only takes width BACK from it: the icon stays, the text clips,
     and the crumb strip keeps usable room on a narrow row instead of losing it
     to a label the user has already read.
     FALLBACK ONLY: upstream AgentPresetLabel.module.css already declares
     @container (width<=540px) { .label { display: none } }, so on every engine
     WITH container queries the label is gone well before this tier and the
     rule below is inert. It is kept for engines WITHOUT container-query
     support (older WebKit), where the span keeps its own 180px max-width and
     would otherwise eat the crumb strip. */
  [data-mobile-frame] [data-slot="conversation.session.header.actions"] > span {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 8em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

/* ---- narrowest tier: 360px and below ----
   Content width is ~246px here: the crumb strip keeps the digits and the
   chevron, the agent-preset label steps down once more, and the lineage count
   label gets the tightest clip that still shows a count. The last crumbSeg
   already shrinks on the structural arm above (the rc.2 current crumb is a
   span, so no disabled floor is needed). Everything stays attribute-anchored.
   The lineage label span lives INSIDE the chip's button (span.count, after
   the optional activity span), so only the button-child arm can clip it —
   there is no root-level span to hide (the pin's span is in the button). */
@media (max-width: 360px) and (pointer: coarse) {
  /* One more step for the narrowest row: the same agent-preset label (the
     480px tier documents the upstream @container fallback this arm serves). */
  [data-mobile-frame] [data-slot="conversation.session.header.actions"] > span {
    max-width: 5em;
  }
  [data-mobile-frame] [data-slot="conversation.session.header.lineage"] button > span:last-of-type {
    max-width: 2.4em;
  }
}
`

/** The canonical viewport meta tokens the plugin ensures are present:
 *  viewport-fit=cover for safe-area insets and interactive-widget=
 *  resizes-content (Android Chrome 108+) so the keyboard squeezes the layout
 *  viewport and the sticky composer floats above it. user-scalable is NOT
 *  locked (WCAG 1.4.4) — focus-zoom prevention lives in the CSS above. */
export const VIEWPORT_TOKENS = ['viewport-fit=cover', 'interactive-widget=resizes-content']

/** The plugin's style-tag identity (matches the inject guard). */
export const PLUGIN_STYLE_TAG = 'dsh-chamber-client-ui-mobile'
