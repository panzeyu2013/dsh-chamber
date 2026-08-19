# Contributing to dsh-chamber

Thank you for contributing! dsh-chamber is the local desktop **connection manager** for dsh: the local dsh instance (web profile) is hosted by the control plane, remote instances attach over SSH tunnels, and the UI is the dsh official frontend, source-reused and self-built. This guide covers setup, development, validation, and what a good pull request looks like.

> 中文版: [CONTRIBUTING.md](../CONTRIBUTING.md)

## Getting Started

```bash
git clone <REPO-URL>
cd dsh-chamber
pnpm install
```

Requirements: Node.js 22+ (LTS recommended, see `.nvmrc`). The repository uses pnpm workspaces; `vendor/harness-packages` is a read-only symlink into the external dsh source checkout (see the README install notes).

## Repository Structure

```
packages/
  control-plane/    Control-plane core (web-profile host hosting,
                    management REST, per-instance reverse proxy, frontend serving)
  renderer/         Self-built dsh frontend (source reuse: pure-dsh first
                    screen bridge host + N-ctx orchestration, boot manifest)
  dsh-chamber-client-ui-sidebar/  Self-built sidebar plugin (multi-source session
                    navigation + chamberBridge; replaces the official
                    ui-sidebar registration)
  dsh-chamber-client-ui-layout/   Self-built ui-layout shell fork (layout-store
                    replacement persisting sidebarWidth via the sidebar's shared
                    view-prefs store; replaces the official ui-layout registration)
  dsh-chamber-client-ui-settings-connections/
                    Self-built connections settings plugin (local instance card
                    + remote host CRUD/connect/systemd/logs, settings.section)
  dsh-chamber-client-ui-settings-bridge/
                    Self-built settings shell plugin (shadows the official
                    SettingsRoot registration; server dropdown over the selected
                    instance's official settings sections)
  desktop/          Electron shell (single frame, transport-manager + ssh provider, instance registry, IPC)
  cli/              CLI thin shell
docs/
  design/           Design documents (01-overview.md is the entry point;
                    05-connection-manager.md is the surface/architecture contract)
  progress/         Module status (STATUS.md is the overview)
```

## Development Scripts

Run from the repository root unless a section says otherwise.

| Script | Description |
|---|---|
| `pnpm run dev:control-plane` | Start the control plane (management REST + static frontend) on port 17500 |
| `pnpm run dev:desktop` | Electron shell: full window (control plane + dsh frontend + desktop shell) |
| `pnpm run build:renderer` | Build the dsh-frontend bundle |
| `pnpm run build:desktop` | renderer build + control-plane compile + dsh runtime bundling |
| `pnpm run dist:desktop:mac` | Package the macOS app (dmg + zip) |
| `pnpm run cli -- --help` | CLI thin shell |
| `pnpm run smoke` | Control-plane integration smoke |
| `pnpm run typecheck` | Strict `tsc --noEmit` (0 errors) |
| `pnpm run verify:i18n` | Fail when an EN ↔ ZH pair drifts (re-record with `-- --write`) |

### Testing

Unit tests run directly with node (the project currently has no test framework):

```bash
node packages/control-plane/test/protocol.ts    # dsh client protocol
node packages/control-plane/test/storage.ts     # storage & recovery
node packages/control-plane/test/m1-dsh-client.ts  # describe/health client behavior
node packages/control-plane/test/host-logs.ts   # host logs ring buffer
node packages/control-plane/test/manager-api.ts # management REST (/health, /api/connections)
node packages/control-plane/test/instance-proxy.ts  # per-instance reverse proxy (HTTP/WS/SSE, 503)
pnpm run smoke                                  # integration smoke
```

These six control-plane test files are exactly what CI's `test` job runs, together with the desktop transport tests (`packages/desktop/transport-manager.test.ts`, `ssh-provider.test.ts`, `ssh-config.test.ts`) and the client plugin tests — the same set CI runs, driven by the root scripts:

```bash
pnpm run test:desktop        # desktop transport / ssh unit tests
pnpm run test:sidebar        # sidebar derive / view-prefs unit tests
pnpm run test:settings-bridge  # settings shell policy unit tests
```

`pnpm run smoke` prints SKIP and exits 0 when dsh is not installed; this is expected, not a failure.

### Desktop Shell

```bash
pnpm --prefix packages/desktop run bundle:dsh   # install the official @deepseek-ai/dsh release into vendor/dsh
pnpm run dev:desktop
```

## Before Submitting

```bash
pnpm run typecheck                            # tsc --noEmit (0 errors)
pnpm run typecheck:sidebar                    # client plugin type checks
pnpm run typecheck:connections
pnpm run typecheck:settings-bridge
node packages/control-plane/test/protocol.ts  # focused unit tests (see Testing above)
node packages/control-plane/test/storage.ts
node packages/control-plane/test/m1-dsh-client.ts
node packages/control-plane/test/host-logs.ts
node packages/control-plane/test/manager-api.ts
node packages/control-plane/test/instance-proxy.ts
pnpm run test:desktop                         # desktop transport / ssh unit tests
pnpm run test:sidebar                         # sidebar unit tests
pnpm run test:settings-bridge                 # settings shell unit tests
pnpm run smoke                                # PASS (or SKIP, which is normal)
pnpm run build:renderer                       # renderer build succeeds
```

For changes that touch runtime, auth, protocol, or desktop-shell behavior, add or update focused tests — static checks alone do not prove runtime correctness.

## Code Style

- Erasable-only TypeScript (`"type": "module"`, zero build — sources run natively via Node type stripping; see `tsconfig.json`). Contract validation is hand-written TS (the zod-reuse deviation is documented in the design docs).
- Follow the existing `src/` layout: single-purpose files with a top doc comment.
- Keep error handling and naming consistent with neighboring code.
- No unrelated refactors; keep diffs focused.

## Commit Messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): subject
```

- **type** — one of: `feat` (new capability), `fix` (bug fix), `chore` (build/tooling/maintenance), `docs`, `refactor`, `test`, `ci`, `perf`, `style` (formatting only), `revert`.
- **scope** — optional, but prefer the affected package or area: `control-plane`, `renderer`, `desktop`, `sidebar`, `settings-bridge`, `cli`, `ci`, `docs`, `packaging`.
- **subject** — imperative mood, no trailing period, ≤ 72 characters ("fix", not "fixed"; "add", not "adds").
- **body** — when the change is not self-evident, explain the *what* and *why* after a blank line; reference the relevant design/progress document or issue where applicable.
- **breaking changes** — append `!` after type/scope (e.g. `feat(desktop)!: ...`) or add a `BREAKING CHANGE:` footer, and describe the migration impact in the body.

Examples:

```
feat(control-plane): add per-instance health endpoint
fix(desktop): await tunnel dispose before quit
chore(ci): ad-hoc sign the macOS app in the afterPack hook
docs: document the commit message convention
```

One logical change per commit; keep diffs focused. Commits bundling unrelated changes should be split.

## Scope Discipline

- Anything the dsh host, its plugin ecosystem, or the reused dsh frontend already provides is **attached or served, never re-implemented**.
- Domains removed from scope (git/GitHub execution, walkthrough, notification center, terminal rendering/input, web preview, MCP, thin-shell chat UI, control-plane session runtime, …) **must not return** to the roadmap in any form.
- For any new domain feature proposal, first ask: does dsh native, the plugin ecosystem, or the host web frontend already cover it? If yes → don't build it.

## Pull Requests

Pull requests are review handoffs, not just diffs. A reviewer must be able to understand intent, assess risk, and verify the result without reconstructing the contributor's work.

Before opening a pull request:

1. Read [`AGENTS.md`](./AGENTS.md) and the relevant design/progress documents (`docs/design/01-overview.md` is the entry point).
2. Keep the change focused. Separate unrelated cleanup or refactors.
3. Run the validation required by the change, not only the broad commands above.
4. Complete the pull request template with concrete, current evidence for the final PR HEAD.

### Pull Request Contract

Every pull request must explain:

- **Intent:** the user or maintainer problem being solved and the resulting behavior.
- **Non-goals:** nearby behavior intentionally left unchanged when scope could otherwise be ambiguous.
- **Affected surfaces:** packages, runtimes, persisted/external contracts, and user-visible states affected by the change.
- **Repository guidance:** the AGENTS.md rules and owning design/progress documents that applied, why they applied, and how the implementation satisfies their constraints.
- **Validation:** exact commands and manual checks performed, their result, and anything that was not verified. A command name without a result is not evidence.
- **Risk and failure behavior:** failure, rollback, cleanup, compatibility, security, performance, or cross-runtime considerations.

Do not claim runtime, auth, protocol, or platform correctness based only on static checks. If required validation could not be performed, state that explicitly and explain why.

## Not a Developer?

You can still help:

- Report bugs or UX issues — even "this felt confusing" is valuable feedback
- Test on different platforms and environments (local host, SSH, different OSes)
- Suggest features via issues
- Ask questions and help others in the issue tracker

## Questions?

Open an [issue](https://github.com/<YOUR-ORG>/dsh-chamber/issues) or read the design docs in [`docs/design/`](docs/design/).
