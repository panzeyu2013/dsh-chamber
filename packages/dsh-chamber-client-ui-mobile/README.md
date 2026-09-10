# @dsh-chamber/dsh-client-ui-mobile

Chamber mobile adaptation plugin (design 17 §18): makes the official dsh web
frontend actually usable in a mobile browser (via the gateway) — narrow-viewport
drawer layout, touch targets, safe areas, PWA phased.

> The single chamber client plugin packaged with the gateway distribution
> (§3 assembly-matrix mobile exception; no desktop in the chain, not part of
> the `/chamber/plugins` desktop sync).

## Structure

- `src/index.ts` — host-half no-op entry (the seed gate requires `dist/index.js`);
- `src/client/index.ts` — browser half: asset injection (viewport/stylesheet/
  theme-color), frame stamping (`ROLE_SLOT_KEYS` maps the plugin's roles onto
  the alpha.2 slot keys `sidebar` / `main` / `rightbar`),
  layout-source-driven drawer scroll lock, composer behavior, drawer tap
  self-heal, settings-sheet section-switch polish, `shell.overlay` hamburger +
  backdrop;
- `src/client/styles.ts` — single stylesheet (fully media-query scoped,
  desktop untouched; official `--dsw-*`/`--ds-*` tokens only);
- `src/client/markup.ts` / `composer.ts` / `layout-facts.ts` /
  `drawer-taps.ts` / `settings-sheet.ts` — pure logic + thin installers
  (unit-testable);
- `scripts/build.mjs` — esbuild two-half build (`dist/index.js` + `lib/client.js`).

## Session header adaptation (touch tier)

The conversation session header (`conversation.session.header` outlet — the
official title/crumbs row) is desktop-width chrome that collides with the
mobile surface on three axes, all covered structurally (no hashed classes):

- **Toggle overlap**: the floating hamburger (top-left 44px) sat on top of
  the header content — the header gets a reserved gutter (`padding-left`);
- **Clipped crumbs**: the official crumbs row is nowrap + overflow hidden, so
  long title chains and the lineage chips ("N 个子代理" catalog triggers)
  were silently cut — crumbs wrap instead of clip (per-crumb ellipsis stays);
- **"Session 日志" export capsule**: RETIRED at the alpha.2 re-anchor —
  upstream now renders that control as a 28x28 icon button inside the header
  more-actions menu, so the plugin no longer stamps it by copy. The right
  column's mobile presentation is likewise upstream-owned: `ui-sidebar-right`
  auto-fullscreens below 768px, so the plugin keeps only the grid lock for the
  third track and no longer draws its own overlay.

## Settings sheet adaptation (phone tier)

The official settings shell (`ui-settings-general`, `sidebar.settings` seat —
the only settings surface on the gateway/mobile chain; chamber
settings-bridge and the official settings document are desktop-only) is an
800px flex-row modal: a fixed 188px nav rail + content column. Phone-tier
rules restructure it structurally (slot/role anchors only):

- **Stacked sheet**: panel → `flex-direction: column` full-screen; the nav
  rail becomes a top strip — title + **horizontally scrolling section
  chips** (44px touch targets, safe-area top padding);
- **Pinned chrome, scrolling options**: the content header row (actions +
  Close) no longer scrolls away — only the section options area scrolls
  (bottom safe-area padding);
- **Section grid degradation**: the Models provider row (4-column line of
  two inputs + two icon actions) degrades to 2×2 and the Plugins-inventory
  two-column card grid to a single column. Official inner cells carry no
  stable attribute, so these two use the documented hash-insensitive
  `[class*="_<local>_"]` local-name exception (production naming
  `_<local>_<hash>_<idx>`; a naming flip fails SOFT — the official grid
  stays);
- **Other `aria-modal` dialogs** (onboarding steps, pickers) are capped to
  `100vw - 24px` (the sheet itself owns the full screen);
- **iOS focus zoom**: editable fields inside dialogs get the composer's
  16px floor (`max(16px, var(--dsh-content-font-size, 16px))`).

Tablets (touch tier, >768px) keep the desktop modal geometry — only phones
get the stacked sheet.

Settings-sheet behavior (`settings-sheet.ts`, phone tier): the official
shell shares ONE options scroll container across sections — switching chips
keeps the previous section's scroll position, so a long list scrolled
mid-way lands the next (shorter) section mid-viewport. A click on a section
CHIP resets the options scroller (its direct parent) and the sheet's fallback
content scroller to the top after the section re-render (rAF); the chip test
is the pure, unit-tested `isSectionChipClick` predicate (a `button` whose
nearest `nav` is the settings nav), so clicks on the nav title, the options
area or the dialog chrome never reset. The behavior is
gated on the PHONE tier, not the touch tier: a 769–1023px touch tablet keeps
the official modal geometry and the official cross-section scroll behavior.

## Tooltip & hover chrome (coarse-pointer tier)

Official ui-primitives `Tooltip` bubbles (`[role="tooltip"]`) are hover/focus
chrome a coarse pointer can never dismiss: a tap synthesizes the trigger's
mouseenter but the mouseleave only arrives with the next tap elsewhere, so
the delayed (200–500ms) send/stop/pause bubble pops and STAYS over the button
that was just used. This is a coarse-pointer artifact, not a narrow-viewport
one, so the rule is gated by `(pointer: coarse) and (hover: none)` (an iPad in
landscape is 1024px+ and still taps; attaching a mouse flips `hover` and
correctly restores hover tooltips) and is scoped to bubbles that duplicate an
accessible name — `button[aria-label] + [role="tooltip"][data-side]` (the
component renders the bubble as the trigger's immediate next sibling and marks
it with its own `data-side`). Of the 31 official Tooltip sites, 27 are
aria-labelled buttons whose label names the same action (composer
send/stop/commands/ContextMeter, queue dock, goal bar, sidebar, message
feedback, workspace rows, chat copy/branch; three phrase it slightly
differently — workspace search ×2, trajectory load-earlier — same semantics).
Four informational bubbles are deliberately left alone because their trigger
has no accessible duplicate — the chat stats line, the agent-preset card
description (clamped to 4 lines), the trajectory timeline span (`aria-hidden`,
no click path) and the trajectory kind tag at ≤620px (visible label
collapsed): they keep the sticky-hover quirk rather than lose content a touch
user cannot otherwise read. The tree's fifth `role="tooltip"` producer (the
trajectory turn-rail preview, `aria-describedby`-referenced) carries no
`data-side` and is structurally outside the rule. Desktop is untouched
(media-query scoped).

## Drawer taps & keyboard (touch tier)

- **Tap self-heal** (`drawer-taps.ts`): iOS Safari suppresses the
  compatibility click for drawer taps (the hover reveal shifts the hit row),
  so a single tap on a session row did nothing — after a stable tap whose
  real click did not arrive within a 120ms grace the heal re-dispatches an
  untrusted click from the pointerup target; React's delegated row handler
  runs it, one tap switches sessions. A trusted click at the healed
  coordinates inside the following 150ms is the delayed real click and is
  suppressed (no double activation); origins are tracked per pointerId
  (multi-touch safe, pointercancel honored). Pan/scroll intents (movement
  beyond the slop), form fields (incl. contenteditable in any non-false
  state) and everything outside the drawer never heal; desktop paths are
  untouched (touch/pen + touch-tier gates only).
- **No keyboard pop on drawer navigation**: the official composer returns
  focus to the box on session switch, which pops the iOS keyboard right
  after a drawer tap — the IME ladder's layer-1 gesture test now drops a
  programmatic composer refocus only when the gesture started in a
  NAVIGATION region (drawer rows, session-header breadcrumbs); composer
  taps, send button, mouse/hardware-keyboard focus and portaled picker
  flows (workspace/agent-preset menus) keep the keyboard / typing intent.
- **Keyboard-visible composer compensation** (IME ladder layer 5,
  `composer.ts` `installKeyboardCompensation`): engines that ignore
  `interactive-widget=resizes-content` (iOS Safari, older Android WebViews)
  keep the LAYOUT viewport full-height, so the official sticky composer
  seat — a FLOW child of the conversation scrollport — pins to the layout
  bottom, behind the keyboard. While the keyboard is open the seat's sticky
  bottom is raised to the keyboard top and the conversation scrollport gets
  an equal bottom padding (frame-level `data-mobile-kbd` +
  `--chamber-mobile-kbd-offset`, styles.ts); a bottom-pinned conversation scrolls
  down by the same delta so the message tail stays glued above the seat (the
  official chat already re-glues the outer scroll on seat resize, so this owns
  only the keyboard-driven change). The seat's bottom safe-area padding is
  zeroed while armed (it sits behind the keyboard and would add 0–34px of
  dead space). Offsets are quantized (16px steps → an 8–23px dead band, vs
  8–55px at 48px) and re-synced from visualViewport resize/scroll, window
  resize, focusin/focusout and visibilitychange. Arming requires a
  visual-viewport shrink AND an editable focus (focusin + focusout stamps, a
  composer-selection fallback for the submit window, and a 1.2s grace window).
  Under ZOOM the compensation is served for the composer only: a blanket
  `scale ≈ 1` veto would leave the composer behind the keyboard for the rest
  of an iOS focus-zoomed session — the drawer's 13px search field is a common
  trigger, so the drawer's fields also get the 16px floor at the source — while
  zoom + a non-composer field stays vetoed (panning a zoomed page must not
  drive the offset). Arming is idempotent per frame element, so a renderer
  remount that replaces the AppFrame while the keyboard stays open re-stamps
  the new frame (and cleans the old one) instead of leaving the composer
  behind the keyboard.
- **Enter-newline caret reveal**: a newline inserted by the mobile
  Enter=换行 path bypasses the official keymap pipeline, whose caret reveal
  never runs — when the composer has grown past its max height the new line
  can land below the fold of its internal scrollport. After each insert the
  caret is revealed within `[data-input-scroll]` (no-op when visible or
  when there is no inner overflow).

## Build / Test

```sh
pnpm --filter @dsh-chamber/dsh-client-ui-mobile run build
pnpm run typecheck:mobile
pnpm run test:mobile
```

## Anchor baseline

Official dsh **v0.1.5-rc.1** DOM, empirically audited via CDP (at v0.1.5-alpha.2) and
re-anchored when the vendored pin moved — every anchor below still resolves in the
rc.1 tree, whose client delta (the `ui-sidebar-*` guide/preview rows, the
`ui-primitives` `CodeBlock` wrapper, the `ui-chat` stats dialog, two `z-index`
additions in `ui-dockkit`'s CSS and a slot-catalog doc pointer) touches neither this
anchors' emitters nor the layers this plugin stacks against: `data-sidebar-collapsed`
present=collapsed / removed=expanded; the centre column is the keyed **`main`**
slot and the right column is **`rightbar`** (both column shells and their
`[data-slot=…]` outlet wrappers are resident from first paint — the renderer
emits the wrapper unconditionally; only the docking surface inside is
registration-gated, so stamping converges on the shell, markup.ts
`isStructuralTarget` + `ROLE_SLOT_KEYS`);
the composer is a Lexical `[data-composer-input]` (no textarea); the settings
dialog renders INSIDE the sidebar DOM (no body portal; the drawer open state
must use `transform: none` — an identity transform still creates a containing
block).

The vendored base is now **v0.1.5-rc.1** (harness pin 183f08e9c6dd); the anchors
above were re-verified against the alpha.2 source (2026-09 re-anchor) and hold at
rc.1 (whose client delta is listed above and leaves those anchors, and the
z-index layers this plugin stacks against, untouched), which also
established: the composer seat is a flow child of `[data-conversation-scroll]`
(sticky only while the content overflows), `[data-input-scroll]` is the
composer's inner scroller (`max-height: 336px`), the official
`revealSelection` runs only on the `draft !== ""` boolean flip, the official
settings dialog has NO width-based media query at all, and the served
viewport meta never carries `interactive-widget` (this plugin injects it
client-side, touch-tier gated).
