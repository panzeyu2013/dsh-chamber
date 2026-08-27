# dsh-chamber Agent Guide

## Purpose

dsh-chamber is the local desktop **connection manager** for dsh: the local dsh instance (web profile) is hosted by the control plane; dsh instances on remote servers are attached over SSH tunnels. The UI is the **dsh official frontend, source-reused and self-built** (single window, single frame; multiple instances coexist as N-ctx shells). The control plane owns connection management, per-instance same-origin reverse proxying, and static frontend serving (v1 has no authentication/audit surface — removed with the 2026-08-14 consolidation). Host-native capabilities (goals, jobs, terminals, schedule, settings, pluginInventory, …) remain the host and host-frontend's job — the control plane only attaches, never re-implements. **Session business is entirely the dsh frontend runtime's job; the control plane consumes no host frames.**

This file contains only always-on repository rules and routing. Detailed design lives in `docs/design/`, progress in `docs/progress/`, and unimplemented feature ideas in `docs/todo/`.

## Instruction Order

These steps are mandatory. Before editing, you **MUST**:

1. Follow this root guide.
2. Read the relevant design document (`docs/design/0X-*.md`) and the progress overview (`docs/progress/STATUS.md` — the only progress record).
3. Follow the consolidation principles of `docs/design/01-overview.md`: anything the dsh host or its frontend already covers is attached/served by the control plane — **never re-implement an execution surface**; the control plane does not consume host sessions; domains removed from scope (walkthrough, notifications, MCP, thin-shell chat UI, control-plane session runtime, …) **must not return in any form**. One carve-out (2026-08-16, design 08): git/GitHub stays out of the control plane and the 本体, but may ship as a chamber-bundled client plugin (worktree lifecycle etc., see 08) — the plugin never re-implements a dsh host surface.
4. Honor documented deviations in module docs.

If these sources materially conflict, stop and resolve the conflict instead of silently choosing one.

## Runtime Boundaries

- `packages/control-plane` — connection-manager core: local host hosting (web-profile spawn/readiness/reaper/health/logs), management REST (`/health`, `/api/connections` local-only, `/api/host/logs`), per-instance generic reverse proxy (`/api/i/<id>/*` HTTP/WS/SSE passthrough; v1 anonymous, loopback-only — no auth/audit surface), static frontend serving (dist + `__DSH_BOOT__` manifest).
- `packages/renderer` — the self-built dsh frontend (source reuse): entry build (chamber composite entry), the pure-dsh first screen bridge host (entry-level React: local auto-start / registry auto-connect / chamberBridge publish & onOpenSession), N-ctx multi-instance orchestration, boot manifest generation, design 09 module C (per-instance host-graph merge + extra-entry preloading: `host-graph.ts` + `chamber-covered.ts`).
- `packages/dsh-client-connection` — in-repo copy of the official connection client with the base-path patch (shadows the vendored workspace entry).
- `packages/dsh-client-web` — in-repo copy of the official web shell with the rc.8 boot.ts class boot kernel re-based onto the rc.8 module system (incl. the per-instance `extraRows` boot-row merge + `__ModuleLoader__` facade + runtimeCtx getter, design 09 module D) (shadows the vendored workspace entry).
- `packages/dsh-chamber-client-ui-sidebar` — the self-built sidebar plugin (copied ui-sidebar structure): multi-source session navigation + chamberBridge (`shared/aggregate-store.ts` + per-instance unary client `shared/instance-api.ts`), replacing the official ui-sidebar registration (see 05 §6).
- `packages/dsh-chamber-client-ui-layout` — the chamber self-built ui-layout shell fork (design 06): layout-store replacement persisting `sidebarWidth` into the sidebar's shared view-prefs store; replaces the official ui-layout registration.
- `packages/dsh-chamber-client-ui-settings-connections` — the self-built connections settings plugin: local instance card + remote host CRUD/connect/systemd/logs (settings.section, dsh design tokens, see 05 §5).
- `packages/dsh-chamber-client-ui-settings-bridge` — the self-built settings SHELL plugin: replaces the official SettingsRoot registration (sidebar.settings at priority -1, shadowing) — a server dropdown over the selected instance's official settings sections (child cordis context bridge) plus the fixed chamber-global connections nav entry (see 05 §5 sibling design discussion 2026-08).
- `packages/desktop` — Electron shell: single frame (`loadURL` the control-plane origin), transport-manager (generic transport runtime; `transport-provider.ts` interface + the `ssh` provider in `ssh-provider.ts` — tunnels + systemd exec, v1 kind `ssh`), instance registry (`<userData>/ssh-instances.json`), IPC.
- `packages/dsh-host-client-graph` — the chamber self-built host package (design 09 module A): exposes the instance's `clientModules.graph()` boot graph over a Typert Remote (read-only); committed esbuild artifact `dist/index.js` is seeded into profiles by the control plane (not a vendor source).
- `packages/dsh-chamber-host-git-worktree` — the chamber-bundled, per-instance Git worktree host plugin (design 08): domain-only Typert Remotes over authoritative `workspaceRegistry`/agent state; Git runs as the dsh instance OS user, never through renderer IPC or desktop SSH argv.
- `packages/dsh-chamber-client-ui-git` — the chamber-bundled Git worktree client plugin (design 08): `sidebar.workspace.git` topology plus safe create/remove sagas; facts/actions stay in a page-wide plugin coordinator and never become a control-plane execution surface.
- `packages/dsh-chamber-client-ui-open-in` — the chamber-bundled open-in plugin (designs 16/17): `conversation.session.header.utilities` open-in button (Finder / VS Code via the main-process OpenInApp registry + `dsh-chamber://` OS deep link); zero control-plane surface.
- `packages/cli` — CLI thin shell (serve/status/connections/host logs).
- `docs/design/` — design documents (01 is the entry point; 05 is the surface/architecture contract (v1); the v2-era thin-shell docs, old 05/10, were removed with the v4 consolidation).
- `docs/progress/` — STATUS.md is the only writer of the overview.

## Always-On Constraints

- Do not modify external repositories. `vendor/harness-packages` is a read-only symlink tree into the dsh source checkout — bootstrapped automatically by the root `preinstall` (`scripts/ensure-harness-vendor.mjs`) from the pinned upstream commit (`harness.commit`, overridable via `DSH_CHAMBER_HARNESS_ROOT` / `DSH_CHAMBER_HARNESS_COMMIT`; sibling `../deepseek-harness` is used when present, zero-network); `ref-dsh` and `ref-upstream` are local reference symlinks only and are **never committed**.
- Do not run git or GitHub commands unless the user explicitly asks.
- Package manager is **pnpm** (`pnpm install`; scripts defined in `package.json` — run them via `pnpm run`). Do not add runtime dependencies unless explicitly requested (current set: `ws`, `electron-updater` (desktop auto-update, design 11), React/Vite, Electron, plus the dsh client workspace packages; `node-pty` is a root devDependency for the dsh subprocess spawn-helper resolution shim). The TypeScript toolchain (`typescript`, `@types/*`) is a sanctioned devDependency set.
- The only modifiable dsh sources are our chamber packages: the in-repo copies `packages/dsh-client-connection` (the base-path patch) and `packages/dsh-client-web` (the rc.8 boot.ts re-base: N-ctx module-table sharing seam + `__ModuleLoader__` facade, incl. `extraRows`, + runtimeCtx getter), the self-built `packages/dsh-chamber-client-ui-sidebar` (replacing the official ui-sidebar registration — see 05 §6), `packages/dsh-chamber-client-ui-settings-connections` and `packages/dsh-chamber-client-ui-settings-bridge` (see 05 §5), `packages/dsh-chamber-client-ui-layout` (replacing the official ui-layout registration — see design 06), `packages/dsh-chamber-client-ui-git` (design 08) and `packages/dsh-chamber-client-ui-open-in` (designs 16/17), the host packages `packages/dsh-host-client-graph` (design 09 module A — chamber-owned host gateway, no vendor surface) and `packages/dsh-chamber-host-git-worktree` (design 08); everything under `vendor/harness-packages` is untouched upstream source.
- Tunnel URLs and private SSH material (credentials, keys, proxy configuration) never enter the renderer, logs, or any persistence layer — only non-secret metadata projections (host/user/ports, localPort/phase) do; the control plane listens on loopback only. Sanctioned exception (design 05 §8, 2026-08; plaintext-file fallback per user decision): an optional per-host SSH password is collected transiently in the connections form and forwarded over IPC; the main process holds it in memory and mirrors it to `<userData>/ssh-passwords.json` (0600, atomic write, loaded at startup so password-only hosts auto-connect after restart) — never in the registry, never logged, never exposed back to the renderer. It reaches ssh via an ephemeral owner-only 0700 askpass helper (directly executable by OpenSSH, deleted on transport stop); the entry is dropped on instance removal or explicit clear. Password auth is gated off on platforms without reliable askpass support (Windows in v1).
- Keep changes minimal and preserve unrelated uncommitted changes.
- Enforce security and correctness in core/runtime logic, not only through UI hiding or prompts.
- Update owning documentation: when module ownership, contracts, or invariants change, update `docs/progress/STATUS.md`.

## Correctness Invariants

- Prefer authoritative state over heuristics: facts persisted by the host are only attached/served by the control plane — never authoritative.
- Derive liveness from live channels, not persisted history (remote liveness = tunnel phase + probe, never a saved status).
- Scope temporary fallbacks narrowly and clear them when authoritative state arrives.
- Proxy honesty: an instance transport failure must never masquerade as empty success — no tunnel → explicit 503; proxy errors are explicit, never silent.
- One failed entity must not erase or block unrelated complete entities.
- Runtime differences must be intentional and visible in code (e.g., local vs SSH adapter differences).

## Documentation Discovery

Read the matching design and progress documents before changing a module:

- `docs/design/01-overview.md` — entry point & consolidation principles
- `docs/design/02-host-management-deployment.md` — host management (web profile)
- `docs/design/03-connections-proxy.md` — connections & per-instance proxy
- `docs/design/04-control-plane-api-data.md` — management API & data model
- `docs/design/05-connection-manager.md` — surface & architecture contract (v1)
- `docs/progress/STATUS.md` — incomplete/partially-complete items, open design issues & remaining deviations (implemented baselines live in git history / CHANGELOG / design docs)

## Validation

- Use `package.json` scripts as the command source of truth (run with `pnpm run`).
- Unit tests (the exact set CI runs): control-plane `node packages/control-plane/test/protocol.ts`, `storage.ts`, `m1-dsh-client.ts`, `host-logs.ts`, `manager-api.ts`, `local-connection.ts`, `spawn-dsh.ts`, `instance-proxy.ts`, `ws-frames.ts`, `static-serving.ts`, `host-graph-seed.ts`; desktop `pnpm run test:desktop` (transport-manager / ssh-provider / ssh-config / renderer-trust / plugin-sync / ipc-surface-mirror / chamber-settings / deep-link / open-in / notifications / bundle-swap / after-pack-adhoc-sign); renderer shell `pnpm run test:renderer-shell`; Git plugins `pnpm run test:git` + `pnpm run test:host-git`; other client plugins `pnpm run test:sidebar` + `pnpm run test:settings-bridge` + `pnpm run test:connections` (settings-connections `plugin-diff` + `save-host`) + `pnpm run test:client-web` (web-shell boot-tolerance decision rules — design 09 §3.5 version tolerance) + `pnpm run test:connection` (the chamber base-path patch decision rules).
- Client plugin type checks: `pnpm run typecheck:sidebar`, `typecheck:layout`, `typecheck:connections`, `typecheck:settings-bridge`, `typecheck:git`, `typecheck:open-in` (the root `typecheck` program does NOT include the self-built plugins — ambient `declare module` entries shadow them); web copy `pnpm run typecheck:client-web` (filtered gate over the chamber-owned `dsh-client-web` files); host packages `pnpm run typecheck:host-graph` + `pnpm run typecheck:host-git` (both are outside the root `typecheck` program and map the `@deepseek-ai/*` vendor sources through package tsconfigs).
- Integration: `pnpm run smoke` (auto-SKIPs when dsh is not installed — normal).
- Frontend: `pnpm run build:renderer` must succeed (vite build over the dsh workspace source).
- Packaging: `pnpm run dist:desktop:mac`.
- i18n: `pnpm run verify:i18n` must not report DRIFTED pairs.
- Lockfile: after any `pnpm-lock.yaml` regeneration, `pnpm install --frozen-lockfile` must pass. pnpm 11 prunes the `vendor/harness-packages/@deepseek-ai/*` importer records (symlinked workspace packages) when writing the lockfile from scratch, and its own frozen check then fails — the committed lockfile keeps those records (regenerate with the vendor tree present and verify frozen; do not commit a pruned lockfile).
- Do not assume the absence of a JS type-check means no validation is needed; run focused tests, syntax checks, builds, or runtime validation for the touched surface.
- Report exactly what was and was not validated. Static checks do not prove runtime, auth, protocol, or platform correctness.

## Pull Request Handoff

Before creating or updating a pull request, read `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md`. Complete the template with concrete, current evidence for the final PR HEAD; do not make the reviewer reconstruct intent, affected surfaces, applicable guidance, validation, or failure/rollback considerations from the diff alone.
