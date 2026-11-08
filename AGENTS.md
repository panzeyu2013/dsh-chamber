# dsh-chamber Agent Guide

## 当前版本范围（2026-11 用户裁决）

- **唯一出货 flavor = macOS Swift 原生壳**（`macos/` + 打包 Node sidecar，design 25）：开发、门禁、发布与文档维护只以 **macOS Swift + 共享契约**为范围；Windows/Linux 桌面腿冻结、不发布，恢复需用户裁决。
- **Electron flavor 已冻结归档**：不删除文件与历史文档，保留可复活形态。冻结面 = Electron 入口与边沿（`packages/desktop/electron/` 与 `updater.ts`）、Electron 打包与更新腿、Windows/Linux CI/发布腿、默认测试组中的 Electron-only 测试；完整清单、仍共享的契约、禁用面与复活清单见 [`docs/progress/electron-frozen.md`](./docs/progress/electron-frozen.md)。
- **agent 默认规则**：只在 Swift 腿与共享契约（control-plane / renderer / client 插件 / wire / dsh-runtime / seed 包等）内改；Electron 归档文件、Electron 打包/发布/CI 腿、Windows/Linux 桌面腿默认不改、不「顺手同步」——确需改冻结面或恢复发布腿 = 用户重开范围的裁决，先读 electron-frozen 并按其复活清单执行。新增只用于 Swift 腿的 A 桥通道 / 命名空间 / 方法进 `packages/desktop/bridge-swift-only-additions.json` 白名单（政策见 electron-frozen §5），不要求 Electron 侧同步注册。

## Purpose

dsh-chamber is the local desktop **connection manager** for dsh: it hosts one local dsh instance (web profile) and attaches remote dsh instances over SSH tunnels inside a single native window (macOS Swift; the Electron flavor is frozen and archived — 2026-11, `docs/progress/electron-frozen.md`) that runs the dsh official frontend — source-reused, self-built, one N-ctx shell per instance. The control plane owns connection management, per-instance same-origin reverse proxying and static frontend serving (v1: anonymous, loopback-only). Host-native capabilities (goals, jobs, terminals, settings, plugin inventory, …) stay the dsh host's and its frontend's job: the control plane attaches and serves, and never re-implements an execution surface. **Session business belongs entirely to the dsh frontend runtime — the desktop control plane consumes no host frames.**

`packages/gateway` is a second, explicitly invoked **server deployment shape** (design 17): the same local-host manager behind an authenticated-by-default public request boundary. It is never auto-started or imported by the desktop control plane, and never becomes authoritative for dsh facts.

This file is an action guide, not a record: purpose, hard facts, and the flows with a fixed procedure. Document structure and writing rules are `docs/AGENTS.md`; the global docs map is [`docs/INDEX.md`](./docs/INDEX.md). Design navigation is [`docs/design/INDEX.md`](./docs/design/INDEX.md) (overview: `01-overview.md`), unimplemented ideas in `docs/progress/TODO.md` and open work in `docs/progress/STATUS.md` (recording rules: `docs/progress/README.md`). The frozen Electron scope, shared contracts, forbidden surfaces and revival checklist live in `docs/progress/electron-frozen.md`; the deviation register is `docs/progress/deviations.md` (historical reference while frozen).

## STATUS.md — what to record

`docs/progress/STATUS.md` is the repository's only progress record and holds **open** work only. The recording rules — what to add, remove or update, and the prohibited narratives — live in `docs/progress/README.md`; this file does not repeat them.

## Execution Flows

### Before release

- Read and execute `docs/checklists/release/release-checklist.md` — any ❌ blocks the release (version, preflight, changelog/i18n, full suite on the exact release commit, build, tag, CI dry-run first). Changes to packaged modules, build scripts, `build.files` or `extraResources` additionally require `docs/checklists/release/packaging-closure-checklist.md`; the release workflow is policy-tested (`pnpm run test:release-workflow`).
- **Release-blocking markers**: `FIXME` blocks a release unless reviewers explicitly agree; shipping one requires `release-preflight --allow-fixme` (a recorded decision). `TODO` means fix soon; `XXX` means someday.
- `CHANGELOG.md` (with its `docs/CHANGELOG.en-US.md` mirror and the `verify:i18n` record) is written at RELEASE time only — never add `[Unreleased]` entries while implementing. It records **only the difference between adjacent formal releases**: what someone running the previous formal release sees changed. A formal release preceded by a beta series aggregates the series into one release-level delta; a beta section still exists because `release.yml` extracts it as the release body. Internal path — intermediate pins, beta-to-beta deltas, batch/round codenames, gate counts, lockfile notes, verification reports — never goes in: it belongs to git history and, while still open, STATUS.

### Before a dsh (upstream) upgrade

- Execute `docs/checklists/upgrade/dsh-upgrade-checklist.md`, then the per-tag maintenance loop in `docs/checklists/upgrade/upstream-touchpoints.md` §7.
- The upstream-touchpoint registry has **one machine source**: `scripts/upstream/registry/registry.json` (paths, per-file classification, criterion ids, deviation ids, reasons). `scripts/upstream/verify/verify-upstream-touchpoints.mjs` reads it (C1/C3–C16; C2 is advisory under `--tags`), and `docs/checklists/upgrade/upstream-touchpoints.md` §2/§9 are its **generated views** — the `<!-- GENERATED:registry:… -->` blocks are hand-edit forbidden (`node scripts/upstream/registry/registry-views.mjs --write` regenerates them; `verify:registry` is the freshness gate). `verify:registry` and `verify:anchors` (symbol anchors + the legacy `file:line` budget, which may only go down) are ordinary gates in `check:static` and on both CI paths.
- `docs/checklists/*` are **procedure only**: no version values — no pinned tags, commits, baseline snapshots or per-tag delta logs. The current anchor's single sources are `harness.commit` (source line), `packages/desktop/vendor/dsh/pnpm-lock.yaml` (runtime line) and each fork's `package.json`; a tag's upgrade narrative goes to the `CHANGELOG.md` release section, and still-open deviations to STATUS.

### Before changing the Swift native shell (`macos/`)

- Assemble the sidecar payload and the app with `pnpm run build:sidecar` then `pnpm run build:swift-app` (flags, capability prerequisites and the full payload chain: `docs/DEVELOPMENT.md` §4 and `docs/checklists/release/packaging-closure-checklist.md`; push CI builds only the `--skip-node` assembly). Native artifacts are the release artifacts — the Electron leg is frozen, so no Electron artifacts ship. A signed build must pass `codesign --verify --deep --strict` and the bundle must stay free of symlinks that escape it.
- `pnpm run test:macos` is the macOS-only leg (darwin lock assertions plus the packaging-script suites); it runs in the ci.yml `test-macos-pack` job (the Swift build/test core is `test-macos`), never on the ubuntu leg.

### Before a pull request

Read `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md`; complete the template with concrete, current evidence for the final PR HEAD. A change that alters a design contract, a cross-package boundary, or shipped behavior adds a short **Rejected alternatives** section to the owning design doc under [`docs/design/`](./docs/design/INDEX.md) (domain subdirectories) — a **review duty, not a gate**; a green gate never means this one was satisfied.
Pick evidence with `node scripts/gates/runners/run-checks.mjs <static|tests|typecheck|full>` (`--list` shows the plan): a local pass is the same evidence for every gate the selected mode contains (darwin-only gates are absent from a linux run). Gates outside the modes are enumerated in `docs/progress/STATUS.md` §1.6.

## Runtime Boundaries

| Package | Responsibility |
|---|---|
| `packages/control-plane` | Connection-manager core: local host lifecycle (spawn/readiness/reaper/health/logs), management REST, per-instance generic reverse proxy (HTTP/WS/SSE), static frontend serving, page-level multiplex WS (`/api/page-channel`) + its three upstream adapters (design 26) |
| `packages/dsh-runtime` | Shared host-agnostic dsh runtime version management core (design 18); adapted by the desktop sidecar and the gateway, which never share runtime state |
| `packages/renderer` | Self-built dsh frontend: composite entry build, per-instance host-graph merge and extra-entry preloading, N-ctx orchestration, notification edge projection, boot manifest (designs 09, 19) |
| `packages/dsh-chamber-client-core` | Shared chamber client kernel: multi-source session/workspace projection, chamberBridge, page-level client-plugin load kernel, per-instance unary client, page-level multiplex channel client (design 26), settings-seat + framework-free runtime-management / SVG-resource-scope leaf contracts, page-level same-origin HTTP dispatch budget (design 26 §D7). Source-only: consumers resolve its TypeScript sources and the seed bundle inlines them (designs 05, 09, 26) |
| `packages/dsh-chamber-wire` | Neutral host↔client wire contracts for the chamber host domains (design 24 `archiveCleanup`; design 26 page-channel; P1-A session-state as `./session-state` with `./json-guards` and `./mux-frame`). Zero runtime dependencies; inlined by the seed esbuild bundle and client bundles |
| `packages/dsh-stream-state` | Pure, clockless lifecycle state for the session/stream chain (design 14 §D4): reducers take observations and return typed recovery actions; zero deps, no timers, no DOM |
| `packages/dsh-client-connection` | In-repo copy of the official connection client plus the per-entry base-path patch |
| `packages/dsh-client-web` | In-repo copy of the official web shell with the N-ctx boot re-base (design 09) |
| `packages/dsh-api-gateway` | Second-implementation fork of the official api-gateway client half (client half only): per-entry base path + carrier retry / opening deadline / journal stall watchdog over `@dsh-chamber/dsh-stream-state`; pin upgrades replay it as a fork (registry `fork.dsh-api-gateway`, deviation G43) |
| `packages/dsh-chamber-client-ui-sidebar` | Self-built sidebar: multi-source session navigation + chamberBridge, consuming client-core's load kernel and settings-seat contract (design 05) |
| `packages/dsh-chamber-client-ui-layout` | Self-built ui-layout shell fork: layout store persistence and the only document-level theme projection (design 06) |
| `packages/dsh-chamber-client-ui-settings-connections` | Chamber-global connections settings page (design 05) |
| `packages/dsh-chamber-client-ui-settings-bridge` | Self-built settings shell: server dropdown over the SELECTED source's own boot-ctx `settings.section` ledger, rendered with that ctx's renderer-bound seats (design 05 §5) |
| `packages/dsh-chamber-client-ui-settings-plugin-manager` | Reuses the upstream plugin manager as its own Settings section (`settings.section` id `plugin-manager`); owns no sidebar panel (design 05) |
| `packages/dsh-chamber-client-ui-git` | Git worktree client plugin (design 08); facts and actions stay client-side and never become a control-plane execution surface |
| `packages/dsh-chamber-client-ui-open-in` | Desktop open-in client plugin (designs 16, 20) + the conversation stream-health seat (design 14 §D4) |
| `packages/dsh-chamber-client-ui-browser` | Client-only right-sidebar Browser (design 28 v2, 2026-11 rulings): faithful fork of upstream `ui-sidebar-browser`'s iframe path (SHA-256-locked in package tests), deferred covered row, **not seeded**. Only behavior difference = SSH reverse proxy: local loads `target.url`; `dsh`/`gateway`+ssh with target host `127.0.0.1` attaches the forward lease and uses main's alias `frameUrl` (bar/history keep the logical URL; external exit uses the alias, disabled while resolving/failing; tab close releases); other http(s) loads directly. Desktop CSP allows `blob:`/loopback/alias/`http:`/`https:`; main owns child-frame navigation/download/permissions; no gateway tunnel/shared `127.0.0.1` fallback/native child view. Electron frozen; Swift shipped |
| `packages/desktop` | **Node sidecar host business core + frozen Electron entry (archived reference)**: shared assembly (`host-assembly`, `shell-core`, `host-edges`, `ipc-events`, transport providers/registry, credentials + runtime management, SSH forward service — `remote-forward-*`, `shell-ipc-browser`; design 28 §16.11) runs in the Swift sidecar; the Electron entry/edges/preload (`packages/desktop/electron/`) are frozen; `updater.ts` stays for the sidecar's headless update controller. Neither flavor becomes a dsh execution surface |
| `packages/dsh-chamber-seed-*` | Chamber host packages seeded into the managed instance: read-only client boot graph, in-instance Git worktree, archived-session cleanup, in-instance open-in catalog/icons/launch (designs 09, 08, 24, 20) |
| `packages/cli` | CLI thin shell (serve/status/connections/host logs) |
| `packages/gateway` | Separately invoked server shape (design 17): authenticated-by-default public boundary, single local-dsh proxy, host duties, seed registry |
| `macos/` | Swift native shell (design 25): WKWebView over the control-plane origin, packaged Node sidecar, native edges (notifications, deep link, open-in, hide/restore), shared directory lock |

## Hard Facts

- `vendor/harness-packages` is a read-only symlink tree into the pinned submodule `vendor/harness-checkout`; upgrade the pin only via `scripts/upstream/pin/update-vendor.mjs <tag>`, never by editing `harness.commit` or the gitlink. Of the dsh sources, only the chamber packages are ours to change (see Runtime Boundaries).
- Do not run git or GitHub commands unless the user explicitly asks.
- This repository installs **no git hooks**, and adding one is a decision to raise rather than a convenience to add: `core.hooksPath` is not carried by a clone. The cheap checks live as ordinary gates instead — `pnpm run check:static` runs that set (registration: STATUS, 范围决策).
- Credentials and connection secrets never enter the renderer, logs or any persistence layer — only the documented transient write-only form inputs (design 05 §8, design 17).
- Swift ships the Darwin shared directory lock `<userData>/.dsh-chamber.lock` (`flock(LOCK_EX|LOCK_NB)`); the Electron Darwin `O_EXLOCK` leg remains in the frozen archive. The lock file carries no secrets and is **never the arbitration authority** — the exclusive lock itself is; recorded pid/start time are diagnostics only (design 25 §6.3); the root derivation is pinned by `chamber-lock.test.ts`.
- Package manager is pnpm, and runtime dependencies are not added without an explicit request (current set: `ws`, `electron-updater`, `clsx`, React/Vite, the embedded pinned `pnpm`, the dsh client workspace packages; `Sparkle` (pinned in `macos/Package.swift`) is the Swift native shell's only SwiftPM dependency — the in-app update chain, user ruling "D-1 = B"). `Electron` (devDependency) is the frozen flavor's **revival baseline**, not a Swift-leg dependency; `electron-updater` stays because the shared update controller imports it. `typescript` / `@types/*` / `node-pty` are devDependencies — `node-pty` is the root resolution target for `@deepseek-ai/dsh-subprocess-local`'s workspace postinstall, not a chamber runtime dependency.
- Removed domains and the bounded exceptions (designs 08, 17, 19, 20, 24, 28 — narrowest boundaries in design 24 §2, design 20 §6.3, design 28 §16.9/§16.11) are stated in `docs/design/01-overview.md` §4 and §5.
