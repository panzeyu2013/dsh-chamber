# dsh-chamber Agent Guide

## Purpose

dsh-chamber is the local desktop **connection manager** for dsh. It hosts one local dsh instance
(web profile) and attaches remote dsh instances over SSH tunnels, inside a single Electron window
that runs the dsh official frontend — source-reused, self-built, one N-ctx shell per instance. The
control plane owns connection management, per-instance same-origin reverse proxying and static
frontend serving (v1: anonymous, loopback-only). Host-native capabilities (goals, jobs, terminals,
settings, plugin inventory, …) stay the dsh host's and its frontend's job: the control plane
attaches and serves, and never re-implements an execution surface. **Session business belongs
entirely to the dsh frontend runtime — the desktop control plane consumes no host frames.**

`packages/gateway` is a second, explicitly invoked **server deployment shape** (design 17): the same
local-host manager behind an authenticated-by-default public request boundary. It is never
auto-started or imported by the desktop control plane, and it never becomes authoritative for dsh
facts.

This file is an action guide, not a record: it carries the purpose, the recording rules for
`docs/progress/STATUS.md`, and the flows that have a fixed procedure. Design lives in `docs/design/`
(entry point `01-overview.md`), unimplemented ideas in `docs/progress/todo/`.

## STATUS.md — what to record

`docs/progress/STATUS.md` is the repository's only progress record, and it holds **open** work only:

- 未完成 / 部分完成 items, including real-machine / on-device acceptance gates still outstanding;
- 设计未决 — open design questions;
- 必要取舍 that still hold today: scope decisions (不做 / 推迟 / 移出) and known deviations or
  degradations, each with the evidence that keeps it checkable (path, command, design reference).

Change scope:

- **Add** an entry when open work appears or a deviation is registered.
- **Remove** the entry once the work lands or the deviation stops being true. The implemented
  baseline then lives in git history, `CHANGELOG.md` and `docs/design/` — never as a "completed"
  record in STATUS.md.
- **Update** it when module ownership, contracts or invariants change. Nothing else obliges an edit.

Do not record blindly. STATUS.md is not a log, a changelog draft or a verification report: no
`✅ 已完成 / 已落地 / 已合入` narrative, no batch or round ledgers, no test counts or green-gate
lists, no commit hashes, no retelling of how something was implemented, and no temporary "baseline
alignment" blocks — those belong in the CHANGELOG release section. Record only what still carries
decision value and is not already owned by a design document or `CHANGELOG.md`.

## Execution Flows

### Before release

- Read and execute `docs/checklists/release-checklist.md` — any ❌ blocks the release (version
  assertions, release preflight, changelog/i18n, the full test suite on the exact release commit,
  build, tag, and a CI dry-run first).
- Changes to packaged modules, build scripts, `build.files` or `extraResources` additionally require
  `docs/checklists/packaging-closure-checklist.md`.
- The release workflow is policy-tested: `pnpm run test:release-workflow`.
- `CHANGELOG.md` (with its `docs/CHANGELOG.en-US.md` mirror and the `verify:i18n` record) is written
  at RELEASE time only — never add `[Unreleased]` entries while implementing.

### Before a dsh (upstream) upgrade

- Execute `docs/checklists/dsh-upgrade-checklist.md`, then the per-tag maintenance loop in
  `docs/checklists/upstream-touchpoints.md` §7.
- `docs/checklists/upstream-touchpoints.md` and `scripts/dev/verify-upstream-touchpoints.mjs`
  (gates C1–C10, run in CI) are two sides of one registry — a change to either must be mirrored in
  the other, and the pin-upgrade entry point reminds you of the freshness gate.

### Before a pull request

Read `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md`; complete the template with concrete,
current evidence for the final PR HEAD. The reviewer must not have to reconstruct intent, affected
surfaces, applicable guidance, validation, or failure/rollback considerations from the diff alone.

## Runtime Boundaries

| Package | Responsibility |
|---|---|
| `packages/control-plane` | Connection-manager core: local host lifecycle (spawn/readiness/reaper/health/logs), management REST, per-instance generic reverse proxy (HTTP/WS/SSE), static frontend serving |
| `packages/dsh-runtime` | Shared host-agnostic dsh runtime version management core (design 18); adapted by the desktop main process and the gateway, which never share runtime state |
| `packages/renderer` | Self-built dsh frontend: composite entry build, per-instance host-graph merge and extra-entry preloading, N-ctx multi-instance orchestration, notification edge projection, boot manifest (designs 09, 19) |
| `packages/dsh-client-connection` | In-repo copy of the official connection client plus the per-entry base-path patch |
| `packages/dsh-client-web` | In-repo copy of the official web shell with the N-ctx boot re-base (design 09) |
| `packages/dsh-api-gateway` | In-repo copy of the official api-gateway client half plus the per-entry base-path patch on its stream carrier |
| `packages/dsh-chamber-client-ui-sidebar` | Self-built sidebar: multi-source session navigation, chamberBridge, the page-level client-plugin load kernel, settings-seat contract (design 05) |
| `packages/dsh-chamber-client-ui-layout` | Self-built ui-layout shell fork: layout store persistence and the only document-level theme projection (design 06) |
| `packages/dsh-chamber-client-ui-settings-connections` | Chamber-global connections settings page (design 05) |
| `packages/dsh-chamber-client-ui-settings-bridge` | Self-built settings shell: server dropdown over the selected instance's graph-driven settings contributions (design 05) |
| `packages/dsh-chamber-client-ui-git` | Git worktree client plugin (design 08); facts and actions stay client-side and never become a control-plane execution surface |
| `packages/dsh-chamber-client-ui-open-in` | Desktop open-in client plugin (designs 16, 20) |
| `packages/dsh-chamber-client-ui-mobile` | Packaged mobile client served by the gateway — the single packaged plugin exception (design 17) |
| `packages/desktop` | Electron shell: single frame over the control-plane origin, trusted domain-scoped IPC, open-in/deep-link routing, edge notifications, crash-safe credential and runtime management |
| `packages/dsh-chamber-seed-*` | Chamber host packages seeded into the managed instance: read-only client boot graph, in-instance Git worktree, archived-session content cleanup, in-instance open-in catalog/icons/launch (designs 09, 08, 24, 20) |
| `packages/cli` | CLI thin shell (serve/status/connections/host logs) |
| `packages/gateway` | Separately invoked server shape (design 17): authenticated-by-default public boundary, single local-dsh proxy, host duties, seed registry |

## Hard Facts

- `vendor/harness-packages` is a read-only symlink tree into the pinned submodule
  `vendor/harness-checkout`; upgrade the pin only via `scripts/dev/update-vendor.mjs <tag>`, never by
  editing `harness.commit` or the gitlink. Of the dsh sources, only the chamber packages are ours to
  change (see Runtime Boundaries).
- Do not run git or GitHub commands unless the user explicitly asks.
- Credentials and connection secrets never enter the renderer, logs or any persistence layer — only
  the documented transient write-only form inputs (design 05 §8, design 17).
- Package manager is pnpm, and runtime dependencies are not added without an explicit request
  (current set: `ws`, `electron-updater`, React/Vite, Electron, the embedded pinned `pnpm`, the dsh
  client workspace packages; `typescript` / `@types/*` are devDependencies).
- Removed domains and the bounded exceptions (designs 08, 17, 19, 20, 24 — narrowest boundaries in
  design 24 §2, and for the open-in host domain in design 20 §6.3) are stated in
  `docs/design/01-overview.md` §4 and §5.
