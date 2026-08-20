# @deepseek-ai/dsh-client-web

English | [中文](README.zh.md)

Web shell kernel: `new AppWebEntry(container, options?).run()` mounts the whole client through the two-stage boot (rc.8 shape). Stage one (module face): adopt (or install) the shared client module system (`@deepseek-ai/dsh-client-modules`, built through the `window.__ModuleLoader__` bootstrap facade) over the host-pushed entry graph (`window.__DSH_BOOT__`) and prefetch the `immediately` tier in parallel — bundle execution registers factories only. Stage two (plugin face): mount the vendored cordis Loader with the module system injected through its `internal` contract, create one loader entry per graph row (tree.import materializes each module), await quiescence, audit activation, then mount the real UI through the `uiRenderer` service (the rc.8 renderer row — kernel-adopted here). The loading page is framework-free (`boot-page.ts`). Composition is entirely the host graph's: the roster and the immediately tier live in the composing app; the shell makes zero composition decisions.

Shell self-sufficiency (web2 hard rule): the kernel value-imports no plugin package except the two bootstrap identities — the modules package (`@deepseek-ai/dsh-client-modules`, the module system cannot arrive through itself) and the ui-renderer package (`@deepseek-ai/dsh-client-ui-renderer`, rc.8 moved the renderer OUT of the shell; the chamber kernel adopts its client half so the mount is version-independent). Everything else arrives as loader rows.

`PLATFORM_MODULES` (src/platform.ts) is the single source of truth for shared modules: seed-table keys, tsdown client externals, and the Vite alias set are its projections.

The optional override parameter `options` forwards the module system's `loadBundle` transport override (`BootSeams`) for environments where external `<script>` execution cannot reach the page context, plus the chamber patch's per-instance `extraRows` (host-graph client-plugin rows merged into the boot rows; their bundles are pre-loaded by the chamber shell, and their activation failures degrade instead of failing the boot — version tolerance).

Browser-title projection moved to the ui-renderer row with the application (rc.8); the chamber desktop shell freezes the native titlebar anyway.

## Model Experience

None, as the entry shell boots the browser plugin tree; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One-shot rendering by design** — the UI waits for the boot settle; a single entry failure keeps the loading page with a loud per-entry report, no partial availability (progressive rendering returns with its own project).
- **Narrow-window shell behavior lacks an assembled walkthrough** — ui-layout implements the concession chain, but this package has no shell-level narrow-viewport acceptance case.
