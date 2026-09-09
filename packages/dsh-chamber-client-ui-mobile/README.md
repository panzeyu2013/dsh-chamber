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
  theme-color), frame + session-header stamping, layout-source-driven drawer
  scroll lock, composer behavior, drawer tap self-heal, settings-sheet
  section-switch polish, `shell.overlay` hamburger + backdrop;
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
- **"Session 日志" export capsule** (official `session-log-export`, header
  utilities): a ≥111px pill that eats the phone title row for a download
  mobile users rarely make — on the phone tier it is compacted to a round
  44px icon target. The capsule carries no stable attribute, so markup.ts
  stamps it (`data-mobile-dismiss="session-log-export"`) by its official
  bilingual copy + download-icon shape when the session header mounts
  (idempotent, pruned search — the chat scroll body is never walked).

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
  two inputs + two actions) degrades to 2×2 and the Plugins-inventory
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

Settings-sheet behavior (`settings-sheet.ts`, touch tier): the official
shell shares ONE options scroll container across sections — switching chips
keeps the previous section's scroll position, so a long list scrolled
mid-way lands the next (shorter) section mid-viewport. A chip click resets
the options scroller (and the sheet's fallback content scroller) to the
top after the section re-render.

## Tooltip & hover chrome (touch tier)

Official ui-primitives `Tooltip` bubbles (`[role="tooltip"]`) are pure
hover/focus chrome a coarse pointer can never dismiss: a tap synthesizes
the trigger's mouseenter but the mouseleave only arrives with the next tap
elsewhere, so the delayed (500ms) send/pause/stop bubbles pop and STAY over
the button that was just used. Every composer-bar trigger carries an
`aria-label` duplicating the bubble text and the remaining `role="tooltip"`
uses (turn-rail previews) are hover-only — the touch tier hides the bubbles
entirely; desktop is untouched.

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
  seat pins to the layout bottom — behind the keyboard. While the keyboard
  is open the seat's sticky bottom is raised to the keyboard top and the
  conversation scrollport gets an equal bottom padding (frame-level
  `data-mobile-kbd` + `--dsh-mobile-kbd-offset`, styles.ts); a
  bottom-pinned conversation scrolls down by the same delta so the message
  tail stays glued above the seat. Offsets are quantized (48px steps) and
  re-synced from visualViewport resize/scroll, window resize and
  visibilitychange; the offset disarms when the seat unmounts (reconnect
  settle / session switch) and re-arms on the next sync.
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

Official dsh **v0.1.2-alpha.4** DOM, empirically audited via CDP; the
ui-layout AppFrame is byte-identical with the alpha.3 pin (alpha.4 anchor
audit, harness pin 4e84901e): `data-sidebar-collapsed` present=collapsed /
removed=expanded; the composer is a Lexical `[data-composer-input]` (no
textarea); the settings dialog renders INSIDE the sidebar DOM (the drawer
open state uses `transform: none` for the containing-block rule). The
details column SHELL is resident from first paint while its
`[data-slot=details]` outlet is session-gated — stamping re-triggers when
the outlet mounts (markup.ts `isStructuralTarget`).
