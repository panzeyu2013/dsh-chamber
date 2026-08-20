# Contributing to dsh-chamber

Thank you for contributing! dsh-chamber is the local desktop **connection manager** for dsh: the local dsh instance (web profile) is hosted by the control plane, remote instances attach over SSH tunnels, and the UI is the dsh official frontend, source-reused and self-built. This guide covers the contribution process, validation, and what a good pull request looks like.

> 中文版: [CONTRIBUTING.md](../CONTRIBUTING.md)

## Development Environment

Environment setup (requirements, clone, vendor bootstrap, `pnpm install`, `bundle:dsh`), running, build/packaging, CI/releases, and repository layout live in the **development docs [docs/DEVELOPMENT.en-US.md](DEVELOPMENT.en-US.md)**. Quick start:

```bash
git clone <REPO-URL>
cd dsh-chamber
node scripts/ensure-harness-vendor.mjs   # must run before pnpm install
pnpm install
pnpm run dev:desktop                     # full window (control plane + dsh frontend + desktop shell)
```

## Testing

Unit tests run directly with node (the project currently has no test framework):

```bash
node packages/control-plane/test/protocol.ts    # dsh client protocol
node packages/control-plane/test/storage.ts     # storage & recovery
node packages/control-plane/test/m1-dsh-client.ts  # describe/health client behavior
node packages/control-plane/test/host-logs.ts   # host logs ring buffer
node packages/control-plane/test/manager-api.ts # management REST (/health, /api/connections)
node packages/control-plane/test/instance-proxy.ts  # per-instance reverse proxy (HTTP/WS/SSE, 503)
node packages/control-plane/test/static-serving.ts  # first-screen static serving and boot manifest
node packages/control-plane/test/host-graph-seed.ts # chamber host-package seed/overlay
pnpm run smoke                                  # integration smoke
```

These eight control-plane test files are exactly what CI's `test` job runs, together with desktop transport, renderer-shell, and client/host plugin tests — the same set CI runs, driven by the root scripts:

```bash
pnpm run test:desktop        # desktop transport / ssh unit tests
pnpm run test:renderer-shell # composite entry / host-graph lockstep
pnpm run test:sidebar        # sidebar derive / view-prefs unit tests
pnpm run test:git            # Git worktree client / saga unit tests
pnpm run test:host-git       # in-instance Git host core unit tests
pnpm run test:settings-bridge  # settings shell policy unit tests
```

`pnpm run smoke` prints SKIP and exits 0 when dsh is not installed; this is expected, not a failure.

## Before Submitting

```bash
pnpm run typecheck                            # tsc --noEmit (0 errors)
pnpm run typecheck:host-graph
pnpm run typecheck:host-git
pnpm run typecheck:sidebar                    # client plugin type checks
pnpm run typecheck:git
pnpm run typecheck:connections
pnpm run typecheck:settings-bridge
node packages/control-plane/test/protocol.ts  # focused unit tests (see Testing above)
node packages/control-plane/test/storage.ts
node packages/control-plane/test/m1-dsh-client.ts
node packages/control-plane/test/host-logs.ts
node packages/control-plane/test/manager-api.ts
node packages/control-plane/test/instance-proxy.ts
node packages/control-plane/test/static-serving.ts
node packages/control-plane/test/host-graph-seed.ts
pnpm run test:desktop                         # desktop transport / ssh unit tests
pnpm run test:renderer-shell                  # renderer shell / coverage-table lockstep
pnpm run test:sidebar                         # sidebar unit tests
pnpm run test:git                             # Git client unit tests
pnpm run test:host-git                        # Git host unit tests
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
- Domains removed from scope (walkthrough, notification center, terminal rendering/input, web preview, MCP, thin-shell chat UI, control-plane session runtime, …) **must not return** to the roadmap in any form. The sole exception is the design-08 Git worktree plugin: it may only be a chamber-bundled client plugin plus a domain-limited in-instance host Remote, never a Git execution surface in the control plane or Desktop.
- For any new domain feature proposal, first ask: does dsh native, the plugin ecosystem, or the host web frontend already cover it? If yes → don't build it.

## Pull Requests

Pull requests are review handoffs, not just diffs. A reviewer must be able to understand intent, assess risk, and verify the result without reconstructing the contributor's work.

Before opening a pull request:

1. Read [`AGENTS.md`](../AGENTS.md) and the relevant design/progress documents (`docs/design/01-overview.md` is the entry point).
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

Open an [issue](https://github.com/<YOUR-ORG>/dsh-chamber/issues) or read the design docs in [`docs/design/`](design/).
