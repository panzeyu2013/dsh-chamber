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
  theme-color), frame stamping, layout-source-driven drawer scroll lock,
  composer behavior, `shell.overlay` hamburger + backdrop;
- `src/client/styles.ts` — single stylesheet (fully media-query scoped,
  desktop untouched; official `--dsw-*`/`--ds-*` tokens only);
- `src/client/markup.ts` / `composer.ts` / `layout-facts.ts` — pure logic
  (unit-testable);
- `scripts/build.mjs` — esbuild two-half build (`dist/index.js` + `lib/client.js`).

## Build / Test

```sh
pnpm --filter @dsh-chamber/dsh-client-ui-mobile run build
pnpm run typecheck:mobile
pnpm run test:mobile
```

## Anchor baseline

Official dsh **v0.1.2-alpha.3** (harness.commit=dd6322d6) DOM, empirically
audited via CDP (2026-12): `data-sidebar-collapsed` present=collapsed /
removed=expanded; the composer is a Lexical `[data-composer-input]` (no
textarea); the settings dialog renders INSIDE the sidebar DOM (the drawer
open state uses `transform: none` for the containing-block rule).
