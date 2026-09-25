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
  official-frame-attribute-driven drawer scroll lock, composer behavior, drawer tap
  self-heal, settings-sheet section-switch polish, the stranded official
  hover-card watchdog, `shell.overlay` drawer
  toggle (the official panel glyph) + backdrop. The toggle IS the official
  control, not a look-alike (2026-09-11 upstream-alignment T17a): it renders
  `IconPanelLeftOutlineRegular` — the glyph the official sidebar toggle draws, from
  the `ui-primitives` client baseline module, so the bundle needs no package
  dependency for it — and it carries the official state-carrying `aria-label`
  pair with no `aria-haspopup`. Its ARIA is the official NAME plus one
  truthful attribute of its own, not the official attribute list (2026-09-11
  review-fix F4a): the official toggle carries that label alone, because it
  sits inside the sidebar it collapses, while this out-of-canvas substitute
  also declares `aria-expanded`. The retired CSS hamburger and its
  `aria-haspopup="true"` claim are gone; the touch tier keeps what the
  official control cannot give it (the 44px floating box and the
  tap-absorbing backdrop);
- `src/client/styles.ts` — single stylesheet (fully media-query scoped,
  desktop untouched; official `--dsw-*`/`--ds-*` tokens only);
- `src/client/markup.ts` / `composer.ts` / `layout-facts.ts` /
  `drawer-taps.ts` / `settings-sheet.ts` / `official-hover-card.ts` /
  `session-stall.ts` — pure logic + thin installers (unit-testable);
- `scripts/build.mjs` — esbuild two-half build (`dist/index.js` + `lib/client.js`).

## Session header adaptation (touch tier)

The conversation session header (`conversation.session.header` outlet — the
official title/crumbs row) is desktop-width chrome that collides with the
mobile surface on three axes, all covered structurally (no hashed classes):

- **Toggle overlap**: the floating drawer toggle (top-left 44px) sat on top of
  the header content — the header gets a reserved gutter (`padding-left`);
- **Clipped crumbs**: the official crumbs row is `nowrap + overflow hidden`, so
  long title chains and the lineage chips ("N 个子代理" catalog triggers) were
  silently cut. The strip keeps the official single-line contract and PANS
  (`overflow-x: auto`, scrollbar hidden) instead of wrapping: the lineage chip
  renders INSIDE the crumbs row (inside its own crumb segment) and its count
  text is a bare `span` with **no class of its own** upstream (the
  `SubagentHeaderLineage` class dictionary omits the `count` key the component
  references), so the inherited `nowrap` was its only protection — overriding
  it to `normal` let CJK break per character and the badge rendered as a
  five-line vertical column (5 x 18px = 90px) that inflated the title row from
  30px to ~96px (2026-09-14 review-fix; the earlier wrap rule WAS the
  regression);
- **Session header row (phone tier)**: one bounded 48px row with the top/right
  safe-area insets applied. The shrink order is explicit — the CURRENT crumb
  (the one upstream renders with `disabled`) absorbs the remaining width and
  ellipsises; the lineage chip is OUT of the shrink race (`flex: 0 0 auto`, a
  44px touch floor where upstream ships a 28px box, and a bounded count label)
  because it is the only entry point to the subagent catalog; the agent-preset
  cell — upstream's `AgentPresetLabel`, a BARE `span[icon][name]` and the only
  text-bearing direct child of the `headerActions` list seat — gives width back
  from 480px down (8em) and once more at 360px (5em) so the crumb strip keeps
  room; upstream bounds that label itself at 180px, and the plugin only takes
  width back (`overflow: hidden`, never `display: none`), so the icon and the
  accessible name survive; and the two icon
  seats take `box-sizing: border-box` so the shared 44px floor means the BOX
  (without it a 28px button with 6px padding renders ~56px and thickens the row
  for nothing);
- **"Session 日志" export capsule**: RETIRED at the alpha.2 re-anchor —
  upstream now renders that control as a 28x28 icon button inside the header
  more-actions menu, so the plugin no longer stamps it by copy. The right
  column keeps the grid lock for the third track and draws no overlay of its
  own — the panel's presentation stays the official one, re-presented
  fullscreen across the whole touch tier (a bare grid lock left the
  769-1023px band covered by a normal-width panel; see "Right panel & drawer
  coexistence").
- **Drawer entry gate**: the floating toggle and its backdrop only render when
  the drawer can actually work — the frame must be stamped AND
  `data-mobile-roles` must include the sidebar role. `stampFrame` is
  all-or-nothing (a frame whose conversation column is missing is never
  adapted), so without this gate a vendor rename of the centre key would leave
  a visible button whose only effect is flipping a frame attribute nothing
  responds to, plus a full-screen scrim over the transcript.
- **View tabs**: `tabs.length > 1` is the NORM, not an edge case — `ui-chat`
  and `ui-trajectory` both register a `conversation.view` unconditionally and
  both ship in the default web bundle. The official tab is 13px text on a 25px
  box and the strip neither wraps nor scrolls while the frame clips overflow
  (`AppFrame.module.css` `overflow: hidden`), so a third view or a longer (en)
  label would be unreachable: the touch tier grows the tab box to the 44px
  floor (`box-sizing: border-box`, so the official 9px bottom padding does not
  make it 53; the header's `min-height: 76px` is a FLOOR, so the row follows)
  and lets the strip WRAP. Wrapping rather than scrolling is deliberate: a
  scroll container forces the other axis to `auto` and would clip the active
  tab's 2px bar, which upstream draws 1px past the tab box to end flush with
  the header's bottom rule.

## Session-open stall notice (touch tier)

The official chat view renders its `chat.loadingHistory` hint while a session's
journal stream is opening, and NEITHER the client nor the host has a first-frame
timeout — a stalled `session/follow` (the remote stream that rides the
`/api/remote.mux` WebSocket mux) therefore leaves the transcript on that hint
forever, and the official UI offers no recovery control at all. `session-stall.ts`
adds a non-blocking notice for exactly that state. The predicate is
ATTRIBUTE-ONLY — the package's anchor discipline forbids matching the hint by
its hashed class or by its copy:

Since 2026-09-21 the same predicate also drives an AUTOMATIC arm: once the stall
reaches the threshold AND the concrete `Session.openPromise` reports no open in
flight, the module calls the pinned `resync()` to rebuild that session's journal
stream itself, bounded by the same cooldown (120 s) and rolling budget (at most 3
per 10 minutes). An open that IS in flight is never interrupted (a slow Host), and
a face that cannot be read is `unknown` and fails closed. Past
`STALL_FAILED_MS` (180 s) the copy switches to "session content not loaded" so a
failed load is never described as one still running. The touch tier carries no
chamber fork, so this arm is that tier's only automatic recovery.

- a `[data-chat-flow]` column exists and its nearest `[data-phase]` ancestor
  carries an emitted conversation phase of `settling` or `active` (the DOM value
  space is exactly `settling` / `hero` / `active`, emitted by upstream
  `ConversationRoot`; `hero` is the no-session face and never qualifies, so an
  empty session cannot false-positive. `conversationPhase()`'s internal
  `blank`/`engaging` names never reach the attribute — the earlier note here
  claimed that value space and was wrong. Which arms of `settling` can actually
  reach this predicate is decided by the header gate below, not by the phase
  list: upstream hides the header in the blank-shell arm),
- the flow subtree contains NO `[data-chat-anchor-key]` row,
- the `conversation.session.header` `<header>` exists and is actually rendered
  (upstream hides it while the shell is blank, which is what keeps the
  `settling` inclusion from firing on a header-less face),
- the state has held for a continuous 45s of VISIBLE page time — background time
  is discarded rather than accumulated, because a frozen mobile timer must not
  replay a stale interval on resume — and
- the session identity (and therefore the clock, the dismissal and the shown
  notice) is the displayed `<header>` node, with NO fallback: `ui-layout`'s
  `main` slot is keyed by entry identity, so `div.root[data-phase]` survives a
  session switch, while the session-scoped header subtree is remounted. When no
  header is displayed the shape is false anyway, so there is nothing to time.

Known limit of the shape: `data-chat-anchor-key` is emitted only by the routed
node wrapper, so a session with an EMPTY transcript and a pending first prompt
(the optimistic submission echo) satisfies the shape and would be told the
loading face is stalled. Narrowing that needs an anchor upstream does not expose
(open state / a pending-echo attribute); the dismissal control is what keeps the
false-positive cost at zero.

The notice is `role="status"` / `aria-live="polite"`, anchored under the session
header, `pointer-events: none` except its two controls, and never takes focus.
Its primary action is a USER-INITIATED page reload; the secondary control
("keep waiting") DISMISSES the notice for the current continuous stall and
re-arms when the shape breaks — a slow-but-healthy open looks exactly like this
shape, and the threshold is not device-calibrated (STATUS keeps that gate open),
so the false-positive path must cost the user nothing. It never reloads or
reopens a session on its own. It ships its own minimal
`data-plugin="dsh-chamber-mobile-stall"` style tag, installs only in the touch
tier, and is fully removed (timers, listeners, DOM, own style tag) on dispose.
Installation is reference-counted on the window: a second context joins the live
watcher, and the last disposer tears it down.

## Right panel & drawer coexistence (touch tier)

Upstream presents the right panel fullscreen only BELOW 768px
(`autoFullscreen = viewportWidth < 768`, `SidebarRight.tsx`) and otherwise
pushes the centre through its own track. The touch tier pins that track to 0
(the sidebar is a drawer, the conversation takes the full width), so between
769 and 1023px the official panel used to draw at its normal width — 313-460px,
about two-fifths of the content column (41-45% of the viewport width) — straight
over the transcript: no
track, no fullscreen, no way to make room (STATUS geometry residue ①). The tier
therefore presents the official panel fullscreen itself
(`[data-mobile-role="details"] [data-sidebar-right-panel]`
→ `position: fixed; inset: 0; z-index: 40`, upstream's own fullscreen layer).

The rule is deliberately NOT gated on the frame's shown flag
(`data-rightbar-collapsed`): the seat reports `shown: false` in the SAME commit
as the slide-out, so a frame-gated rule would drop the fullscreen box
mid-animation and the panel would shrink to its normal width while sliding out.
The hidden state needs no gate — upstream hides the panel with
`transform: translateX(100%)` + `visibility: hidden`, and a full-width `inset: 0`
box sits exactly one viewport to the right, invisible and untouchable. That is
also why the safe-area insets live in this same block, and why it declares
`box-sizing: border-box`: the panel carries no box-sizing of its own and the
tree has no global border-box reset, so a content-box panel with `left: 0` +
`width: 100%` would paint its insets WIDER than the viewport (the notch-side
content, i.e. the strip-end controls, cut off-screen in landscape).

The panel is NOT the column's direct child: every slot render site wraps its
output in a `[data-slot="<key>"]` outlet whose style is `display: contents`
(ui-renderer `scoped-slots.tsx`, `ANCHOR_STYLE`), so a positional rule on the
column's child is a silent no-op — the first cut of this fix landed exactly
there, and the rule now targets the panel's own upstream state attribute
(`data-sidebar-right-panel`, emitted by `SidebarRight.tsx`) scoped to the
details column. The breakpoint test pins all of it: the panel is the target,
the outlet wrapper is not, the rule stays ungated, and the selector is unique.

That rule also carries the iOS safe-area insets (`env(safe-area-inset-*)`),
in the same block because they matter exactly while the panel is fullscreen:
this plugin injects `viewport-fit=cover` on the touch tier, so `inset: 0` runs
edge to edge — a notched iPhone in LANDSCAPE falls in the same band, with the
notch over one vertical edge and the home indicator under the bottom. That
applies on the PHONE tier too, which is the band upstream itself presents
fullscreen: the rule is ungated, so both bands get the insets. Upstream's
fullscreen presenter carries none of its own; the drawer, the settings sheet
and the composer seat on this tier all do. The surface still paints full-bleed —
the background covers the padding box — only its content moves inside.

A shown panel owns the screen, so the drawer YIELDS: the floating toggle and the
backdrop stand down, and an open drawer goes `visibility: hidden` — the same
mechanism the closed drawer uses, which also drops it out of the tab order
(WCAG 2.4.3) instead of leaving nav rows and the settings seat focusable behind
the panel. This needs TWO selector arms, because "the panel is shown" is not one
attribute: `data-rightbar-collapsed` is upstream's TRACK flag
(`cols.rightbar === 0`) and the seat only asks for a track at >= 768px
(`track = shown && !autoFullscreen`), so a shown panel on the PHONE tier still
reports track=false and that arm alone would leave phones un-yielded; the second
arm keys on `[data-rightbar-fullscreen]`, which `openRightbar`/`closeRightbar`
set and clear, i.e. present exactly while a fullscreen panel is shown. ORDER
MATTERS: these selectors tie on specificity with the open-drawer / backdrop
rules, so they sit after them (the open rule's `visibility 0s` transition keeps
the hide immediate).

In the 768-1023px band the panel's own MODE control is hidden: this tier pins
the fullscreen presentation, so upstream's push↔fullscreen flip (and the label
that flips with it) cannot change anything any more — pressing "exit fullscreen"
would leave the panel fullscreen. Below 768px it stays, because upstream's
`autoFullscreen` branch turns that same click into "collapse the panel". The
separate collapse control is untouched in both bands.

The panel's dockkit strip joins the 44px touch floor (the strip itself grows
with its controls — `height: auto; min-height: 44px` — instead of clipping a
44px chip in a 28px row), as do the session header's utilities and corner seats.
On the strip the floor means the BOX (`box-sizing: border-box`, on the strip's
BUTTONS only): the chrome icons declare 28px boxes with 6px padding, so a
content-box floor would turn 44 into 56 and grow the strip for nothing. The
CHIPS stay content-box on purpose — they pad horizontally only, and dockkit
measures the chip minimum as `min-width + padding` under content-box
(`measure.ts` `chipMinimum`), so forcing border-box there would lower that
measured minimum from 100px to 80px and loosen the pane-split room rule.
The chip's own CLOSE control is deliberately excluded from the floor: upstream
floats it at 20px inside the chip (absolute, `pointer-events` gated by
hover/active), so the floor would inflate it into a 44px box over the chip's
label — the chip itself is the 44px target and closing stays reachable from the
chip menu; it is only re-centred in the taller box it now lives in.
The split BUTTON is no longer hidden: upstream renders it as a plain click
control that disables itself when the pane cannot split, so the earlier blanket
hide removed a usable affordance on a false "pointer-drag chrome" premise; the
`[data-dockkit-divider]` arm stays hidden — that one really is drag-only chrome
(and with the divider hidden, a touch split gets upstream's even halves rather
than a draggable ratio). The whole panel subtree also declares
`overscroll-behavior: contain`: a fullscreen panel owns the screen, so its inner
scrollers must not chain their overscroll into the document behind it.
One device-judged note: the header-seat floor lands on the CONTENT box (the
pre-existing arm was left as shipped), so padded icon buttons render ~56px boxes
and the header row grows with them — if that reads as too much chrome on a
phone, the three header arms can move to border-box together (44px).

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
  (bottom safe-area padding). The pinned row is anchored on the documented
  `[data-slot="settings.action"]` + `[data-slot="settings.close"]` seams
  rather than a positional first child (2026-09-11 upstream-alignment T17c);
- **Section grid degradation**: only the Models provider row (4-column line of
  two inputs + two icon actions) degrades to 2×2, through the documented
  local-name suffix exception `:is([class$="_<local>"], [class*="_<local> "])`
  — production naming in the instance bundle is `[hash]_[local]` (upstream
  cssModules pattern,
  `vendor/harness-checkout/packages/client/tsdown.client.ts:517`; observed in
  the shipped bundles as `JObwrW_row`, `zGbnIq_modelRow`, `qSYn7G_cards`), so
  only the suffix arm can match. `_<local>_<hash>_<idx>` is the CHAMBER
  shell's own Vite naming, never the instance bundle's; the old
  `[class*="_<local>_"]` infix form therefore matched nothing and a naming
  flip fails SOFT — the official grid stays. The card grids are NOT touched,
  and they are **two** grids under this section with two different upstream
  rules (2026-09-11 review-fix F3): `PluginInventorySettingsTab` `.cards`
  collapses to one column at `max-width: 680px` itself, while `ui-agent-preset`
  (`AgentPresetSection.module.css`) declares no breakpoint at all — its
  `.cards` is `repeat(auto-fill, minmax(268px, 1fr))` inside a `.section`
  capped at 720px, so upstream renders two columns from about 580px of
  viewport width (two 268px cards plus the 12px gap need 548px inside the
  options box: the viewport minus 2×(16px + safe-area)). The chamber's former
  one-card-per-row arm therefore changed the Agent-presets layout across its
  whole two-column range, about 580–768px of the phone tier — not only the
  681–768px window the inventory grid's own breakpoint leaves. It was deleted
  for both grids (2026-09-11 upstream-alignment T17b);
- **Dialogs other than the settings sheet are not restyled**. The phone tier
  no longer caps `aria-modal` dialogs at `100vw - 24px` (2026-09-11
  upstream-alignment T6): the tree has exactly three `role="dialog"`
  `aria-modal="true"` producers and each owns its fit — this sheet, the
  ui-primitives `Modal` (its root pads 24px and the dialog is
  `min(380px, 100%)`), and the `ui-attachment` `ImageLightbox`, a fixed
  full-bleed backdrop at `inset: 0` whose mask is an absolute `inset: 0`
  layer. `max-width` beside `inset: 0` is over-constrained: the lightbox
  backdrop shrank to `100vw - 24px`, left-anchored, leaving a 24px undimmed
  click-through strip on the right;
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

The same tier suppresses the chamber pages' **hand-rolled `data-tip`
bubbles** (`[data-tip]::after { display: none !important }`) — e.g. the
connections settings sheet's `.iconButton` / `.restartTip` bubbles
(`ConnectionsSection.module.css`, `content: attr(data-tip)` on the `::after`,
opacity-gated on `:hover` / `:focus-visible`): the same coarse-pointer artifact
in a different vocabulary. Every one of the 13 sites pairs the attribute with
`aria-label` (that package's `Button` prop surface documents the pairing), so
no accessible name is lost; the official bundle carries ZERO `data-tip`
attributes, so the rule cannot reach an official surface; and only the
pseudo-element is hidden — the host button, its box and its label are
untouched. Residual: on the two `.restartTip` sites whose tip carries the
*disabled reason*, this tier loses the visible explanation (the reason still
rides the `aria-label` and the `disabled` state) — the same trade the official
Tooltip rule above already takes, and preferable to a bubble that sticks over
the row after every tap.

## Stranded official hover card (coarse-pointer tier)

The instance's own frontend — the gateway tier, and the only tier that loads
this package — renders the OFFICIAL `ui-primitives` `HoverCard` for session
rows; the chamber's replacement (`RowHoverCard` + the `hover-intent` machine)
exists only in the composite page, which never loads this plugin. The official
atom arms its 200ms close grace from the last COMMITTED `open`, so a leave
inside the commit window arms nothing and the card then mounts with the pointer
already gone; on touch no leave is delivered at all. The card is portaled to
`document.body` (`position: fixed`, 244px), so no host-side CSS can hide it
either.

`official-hover-card.ts` is a document-level watchdog for exactly that tier
(same `(pointer: coarse) and (hover: none)` gate as the tooltip rule — a
hover-capable pointer, and every desktop, keeps official behavior). It never
touches the official package: for a card matched to exactly one wrapper by the
atom's own anchoring geometry (`card.left = wrapper.right + 8`; `card.top =
wrapper.top`, or the bottom-clamped `card.bottom = innerHeight − 8`) and the
two CSS-module class tokens (`_card_38jqx_*` / `_root_38jqx_*`), it dispatches
ONE bubbling `pointerout` on the wrapper with no related target. React's
delegated enter/leave path reads that as "the pointer left the window" and runs
the wrapper's `onPointerLeave`, which — with the card in the DOM, i.e. the
atom's committed `open` true — arms the atom's own grace close; a real
`pointerenter` inside those 200ms cancels it again, so genuine user input
always wins. Triggers: a `pointerdown` whose target AND coordinates are
provably outside both boxes (2px inflated), `window.blur`, and
`visibilitychange → hidden`. The watchdog dispatches no click / pointerdown /
key event, arms no timer of its own, fails closed on anything unexpected, is
idempotent, and is installed/uninstalled by `ctx.effect` behind one
`Symbol.for` window guard.

**Residual reality — what this does NOT cover.**

1. **The instance-origin frontend opened DIRECTLY** (e.g.
   `http://127.0.0.1:17510` in a browser) has NO chamber client plugin at all:
   nothing from this package is loaded there, so the stranding bug is still
   live on that origin. It cannot be mitigated from the chamber — that tier
   needs the upstream fix in `ui-primitives` (the same one the chamber made for
   its own card on the composite tier).
2. On the covered tier the two page-state triggers also close a card whose
   pointer is physically parked on a row across a blur or tab switch; the card
   reopens on the next leave-and-re-enter (or tap). No click, navigation or
   focus change is involved.
3. The class tokens are pinned to the vendored build, like every other anchor
   in this package, and must be re-anchored when the pin moves. A stale token
   now fails `verify-mobile-anchors.mjs` hard (exit 1) instead of silently
   no-op'ing the watchdog; the matcher itself stays fail-closed (no card ever
   matches) — never a misfire.

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
- **Composer visibility guard** (IME ladder layer 5, `composer.ts`
  `installComposerVisibilityGuard`): engines that ignore
  `interactive-widget=resizes-content` (iOS Safari, older Android WebViews)
  keep the LAYOUT viewport full-height, so the official sticky composer seat —
  a FLOW child of the conversation scrollport — pins to the layout bottom,
  behind the keyboard. The guard does NOT infer the keyboard: it MEASURES how
  far the conversation scrollport's bottom edge sits below the visible bottom
  (visual viewport + its pan offset) and raises the seat's sticky `bottom` by
  exactly that much (frame-level `data-mobile-kbd` +
  `--chamber-mobile-kbd-offset`, styles.ts). The conversation's scroll range
  comes from an in-flow spacer the guard inserts before the seat
  (`data-mobile-kbd-spacer`) — NOT from padding the scrollport, which is also
  the seat's sticky containing block: padding there shrank the sticky threshold
  and stacked with the inset (measured double lift: the seat landed 368px ABOVE
  the keyboard top on a 390x844 rig with the real upstream CSS). A
  bottom-pinned conversation scrolls down by the same delta so the message tail
  stays glued above the raised seat (the official chat already re-glues the
  outer scroll on seat resize, so this owns only the keyboard-driven change).
  The seat's bottom safe-area padding is zeroed while armed (it sits behind the
  keyboard and would add 0–34px of dead space). Hysteresis arms at ≥96px of
  measured overlap and holds until it drops below 72px — browser chrome and
  60px-scale overlaps stay idle (measured) — and offsets are quantized (16px
  steps with a fixed `KBD_OFFSET_HEADROOM_PX` = 8px of headroom above the raw
  overlap → an 8–23px dead band). Triggers: visualViewport resize/scroll,
  window resize, focusin (focusout only stamps the 1200ms grace window — the
  re-sync comes from the next event or the poll), visibilitychange, a `[data-phase]` observer
  (the sticky seat exists only in the active phase), a document `pointerdown`
  (re-syncs ONCE — it never re-arms or extends the poll) and a BOUNDED 250ms
  poll while an editable is focused (4s budget, stamped once per focus arm),
  so an engine that delivers no viewport event on keyboard open still
  converges (measured: 8 frames). The lift is served for the composer only
  (editable focus, composer selection, the `KBD_EDITABLE_FOCUS_GRACE_MS` =
  1200ms grace window); under ZOOM a non-composer field stays vetoed — the drawer's 13px
  search field is a common iOS focus-zoom trigger, so the drawer's fields also
  get the 16px floor at the source. Arming is idempotent per frame element, so
  a renderer remount that replaces the AppFrame while the keyboard stays open
  re-stamps the new frame (and cleans the old one). After writing the offset the
  guard re-measures at most twice (24px slack) — that loop only fires when the
  requirement GROWS while the write lands (an unchanged requirement cannot enter
  it; a partially honouring engine converges on the next event/poll tick) — and
  then REPORTS `data-mobile-kbd-state` (`armed | idle | no-seat | no-frame |
  still-covered`): `idle` covers "below the arm threshold", "no editable focus"
  and "focus outside the composer"; `still-covered` is the reported residue of an
  engine that ignores the sticky inset or — latched since 2026-09 — of a carrier
  that moves with the guard's own write. The residue is surfaced, never chased.
- **Enter belongs to the editor**: the composer's resident div doubles as the
  no-workspace picker trigger — with no workspace it binds `editor = null`, so
  it renders `contenteditable="false"` while still carrying
  `[data-composer-input]`, `tabIndex=0` and the official React `onKeyDown` that
  opens the picker. The document-capture Enter handler now requires
  `contenteditable="true"`, so that activation survives (intercepting it
  inserted nothing AND swallowed the picker's Enter — one keyboard path lost,
  no line break gained). Shift+Enter keeps the official line break, and the
  official ACCELERATED chord (Ctrl/Cmd+Enter — `keymap.ts` passes
  `event.ctrlKey || event.metaKey` into the submission policy, which flips
  queue↔steer) passes through untouched: with a hardware keyboard attached
  (the iPad case) a newline is not what that gesture means.
- **Editability state is SEEDED, never assumed**: React writes
  `contenteditable` on the DETACHED element, so a composer that mounts locked
  produces no mutation record at all — the old `lastEditable = true` /
  `lockedSince = 0` guesses could therefore never arm the layer-2 recovery or
  the 30s self-heal on the very states they exist for. Both now seed from the
  mounted DOM (the recovery also reads the mutation's `oldValue`, so a genuine
  `false → true` flip is recognised even for an element the observer never saw
  mount).
- **The self-heal only fights a STUCK SUBMIT**: its clock runs only while the
  composer is non-editable AND its own `data-phase` is `adjudicating` or
  `submitting` (the official input machine's in-flight phases). A composer that
  is non-editable for a long-lived legitimate reason — removed / inert /
  no-session picker node / owner-blocked / a continuable child whose parent is
  offline — never starts the clock, so the recovery cannot force
  `contenteditable="true"` against a block upstream still holds (Lexical's own
  `setEditable(false)` gate would stay closed anyway, leaving a half-editable
  DOM). A composer that MOUNTS already stuck is still covered: the tap that
  finds it stuck starts the clock.
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

Official dsh DOM, empirically audited via CDP at **v0.1.5-alpha.2** and re-anchored
at **v0.1.5-rc.2** — every anchor below resolved in the rc.2 tree. Under the current
pin (v0.1.7-rc.2) the strict anchor gate resolves all 47 property anchors and the
two build-time CSS-module hash tokens with 0 misses
(`verify-mobile-anchors.mjs --require-anchor-root`); the hash tokens were re-anchored
to the served rc.2 bundle and a zero-hit token is now a hard failure (see below). The
alpha.2 → rc.1 delta (the `ui-sidebar-*` guide/preview rows, the
`ui-primitives` `CodeBlock` wrapper, the `ui-chat` stats dialog, two `z-index`
additions in `ui-dockkit`'s CSS and a slot-catalog doc pointer) and the rc.1 → rc.2
delta (feedback-dialog, delivery-card and code-file-icon refinements in
`ui-{chat,deliverables,message-feedback,primitives}`) touch neither this
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

The vendored base is now **v0.1.7-rc.2** (harness pin `477b4f4205`; single source
`harness.commit`). Historical audit record: the anchors above were re-verified
against the alpha.2 source (2026-09 re-anchor) and held at v0.1.5-rc.2 (whose
client deltas are listed above and left those anchors, and the
z-index layers this plugin stacks against, untouched), which also
established: the composer seat is a flow child of `[data-conversation-scroll]`
(sticky only while the content overflows), `[data-input-scroll]` is the
composer's inner scroller (`max-height: 336px`), the official
`revealSelection` runs only on the `draft !== ""` boolean flip, the official
settings dialog has NO width-based media query at all, and the served
viewport meta never carries `interactive-widget` (this plugin injects it
client-side, touch-tier gated).

The 2026-09-13 review-fix re-audited the same pin against the vendored SOURCE
(not only the CDP-observed DOM) and extended that set with five anchors, each
with its emitting file: the panel's own `data-sidebar-right-panel` state
attribute — the thing the fullscreen presentation actually targets, since the
slot outlet wrapper in between is `display: contents` (`SidebarRight.tsx`,
`ui-renderer/scoped-slots.tsx`), and it is deliberately used WITHOUT the frame's
shown flag so the close animation keeps its box; the frame's
`data-rightbar-collapsed` (the TRACK flag) and `data-rightbar-fullscreen` (the
seat's fullscreen report) as the two shown keys for the DRAWER yield
(`AppFrame.tsx`, `ui-layout/stores.ts`) — the track flag alone is false for a
shown phone-tier panel; the
right panel's dockkit strip `[data-dockkit-strip]` — 28px chips, add/split and
panel-chrome buttons, and the excluded 20px `[data-dockkit-tab-close]` — as a
touch-floor seat (`TabPanel.tsx`,
`SidebarRight.tsx`); and the
session header's `role="tablist"` strip, rendered whenever a session has more
than one view and therefore always in practice (`ConversationSession.tsx`). It
also verified what the plugin must NOT anchor on: `[data-dockkit-split-button]`
is a click button, not drag chrome; the `[role="menu"]
[role="menuitem"][aria-selected]` highlight signal does not exist at this pin
(the ui-primitives `Menu` emits no `aria-selected`, and it moves focus into the
menu, so its Enter never reaches a document handler); and the tree still has
exactly three `aria-modal` producers and exactly three `data-side` carriers
(the two AppFrame/ConversationRoot drag handles and the always-`role="tooltip"`
bubble).

**The session-header anchors (2026-09-14 review-fix)**, all attribute- or
structure-shaped and verified in the rc.2 tree:

- `conversation.session.header.lineage` — a FOURTH seat of the session-header
  outlet, registered next to `actions` / `utilities` / `corner`, but rendered
  **inside `nav.crumbs`** (inside the current crumb's `span.crumbSeg`), which is
  what makes it the element the crumb strip can squeeze;
- the seat's own shape: a root `div` whose first child is the `/` separator
  `span` (count variant only), then `button` holding
  `[span.activitySlot][span(count, NO class)][IconChevronDownOutline14]`;
- the DOM nesting the phone-tier selectors depend on:
  `header > div.titleRow > div.titleCluster > [nav.crumbs, div.headerActions]`,
  with `div.headerUtilities` and `div.headerCorner[data-conversation-header-corner]`
  as further `titleRow` children and `div.tabs[role=tablist]` as the header's
  second child — so a `> nav` child combinator on the row is a silent NO-OP
  (the `:has()` arm must be a descendant match);
- the current crumb is `button.crumb:disabled` (upstream renders
  `disabled: last`), which is the hook the shrink order uses;
- the `headerActions` outlet is a LIST seat whose three registrants in this pin
  render NO direct-child `button`: `agent-preset` (order −10) is
  `AgentPresetLabel`, a bare `span[icon][name]` that upstream itself bounds
  (`max-width: 180px` + `overflow: hidden`) and that is non-interactive (a
  `title` only), while `schedule-catalog` (10) and `job-list` (20) are `div`
  wrappers with nested triggers — so the seat's hit-box rules must use a
  DESCENDANT `button` selector, a `> button` arm is dead code, and the hero
  chip's interactive `button[aria-haspopup=menu]` lives in a different seat
  (`conversation.hero.agentPreset`); the outlet itself is `display: contents`;
- `data-mobile-roles` (the plugin's own, not upstream's): the roles the frame
  probe actually found, space-separated. `stampFrame` is ALL-OR-NOTHING — it
  refuses to adapt a frame whose conversation column is missing, so the
  stylesheet's `grid-template-columns: 0 minmax(0,1fr) 0` lock can never strand
  the transcript in the 0px first track after a vendor rename of the centre key
  (the page degrades to the official narrow layout instead).

**The session-stall notice's anchors (2026-09-14; value space re-audited
)**, likewise attribute-only:

- `[data-chat-flow]` — the `ui-chat` message column; absent means no chat
  surface is on screen, so nothing else is read;
- the flow's NEAREST `[data-phase]` ancestor — the conversation root
  (`ConversationRoot.tsx`), whose attribute value space is exactly
  `settling` / `hero` / `active`. `hero` is the no-session face; the internal
  `conversationPhase()` names (`blank` / `engaging`) never reach the attribute,
  so a plugin matching them would be dead code;
- `[data-chat-anchor-key]` — a rendered message row (the official
  `routedNode.key` projection);
- `[data-slot="conversation.session.header"] > header` — the header outlet and
  its direct `<header>` child, which is also the SESSION IDENTITY: the outlet is
  a session-scoped slot the renderer remounts per session, unlike the keyed
  root-scope `[data-phase]` node.

**The theme observer's anchor ()**: `data-ds-dark-theme` — observed through
`MutationObserver.observe(document.body, { attributeFilter: ['data-ds-dark-theme', …] })`
in `index.ts`. Upstream's only WRITE at the pin is
`document.body.toggleAttribute('data-ds-dark-theme', dark)` (`dsh-client-ui-theme`'s
client half); every other reference is a CSS rule
(`body[data-ds-dark-theme]{…}`), i.e. consumption — which
`scripts/upstream/verify-mobile-anchors.mjs` deliberately does NOT accept as proof that
the attribute is still emitted. A pin that moves the writer to the `dataset` API
would stop the literal name from appearing and fail the gate closed; re-anchor
against the new writer rather than widening the matcher blindly.

**The hover-card watchdog's own anchors (2026-09-13 review B2 — these are anchors
too, so they are listed here rather than only in the feature section above):**
`official-hover-card.ts` matches the official atom by three facts, all re-audited
when the pin moves:

- `_root_38jqx_3` and `_card_38jqx_9` — the ui-primitives `HoverCard` module's
  CSS-module class tokens in the SERVED bundle. They are build-time hashes: the
  rc.2 build emits them in `@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js`
  (verified byte-for-byte on the bundled copy under `packages/desktop/vendor/dsh/`,
  where minified `Pp="_root_38jqx_3"` / `Rp="_card_38jqx_9"` /
  `zp="_copyable_38jqx_21"`; the matching `index-*.css` carries the same two class
  selectors). The rc.2 re-anchor replaced the previous pin's `_root_1b2ny_*` /
  `_card_1b2ny_*` pair; `verify-mobile-anchors.mjs` now **hard-fails** a zero-hit
  hash token (it was advisory before), so the next pin move forces the re-anchor
  instead of degrading the watchdog to a silent no-op (fail closed, never a
  misfire), and this remains the one anchor in the package with no
  attribute-shaped fallback;
- the anchoring geometry `card.left = wrapper.right + 8`, `card.top =
  wrapper.top` (or the bottom-clamped `card.bottom = innerHeight − 8`);
- the card box being the only `[class*="_card_38jqx_"]` element inside that
  wrapper.

`test/dom/official-hover-card.test.ts` pins the constants, the served class
strings and the src↔artifact lockstep, and C8 pins the shipped bytes;
`verify-mobile-anchors.mjs` is the gate that sees the served bundle's hash move
(against the vendored `dsh-web-frontend` artifact under
`packages/desktop/vendor/dsh/`; CI without an anchor tree still fail-softs), which
is exactly why this entry exists.
