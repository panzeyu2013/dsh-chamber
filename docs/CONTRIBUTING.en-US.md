# Contributing to dsh-chamber

dsh-chamber is the local desktop connection manager for dsh: the control plane hosts the local dsh instance (web profile); remote connections compose `dsh|gateway` targets with `ssh|http` transports; the UI is the dsh official frontend, source-reused and self-built; the explicitly started Gateway is a separate authenticated-by-default server shape. This guide covers the contribution process, validation, and what a good pull request looks like.

> 中文版: [CONTRIBUTING.md](../CONTRIBUTING.md)

## Development Environment

Requirements, clone, vendor bootstrap, `pnpm install`, `bundle:dsh`, running, build/packaging, CI/releases and repo layout: development docs [docs/DEVELOPMENT.en-US.md](DEVELOPMENT.en-US.md).

```bash
git clone <REPO-URL> --recurse-submodules
cd dsh-chamber
node scripts/dev/ensure-harness-vendor.mjs   # must run before pnpm install
pnpm install
pnpm run dev:desktop                     # full window (control plane + dsh frontend + desktop shell)
```

## Testing

The root `package.json` scripts are CI's sole test roster; do not hand-maintain a control-plane test file list:

```bash
pnpm run test:control-plane
pnpm run test:runtime
pnpm run test:desktop
pnpm run test:gateway
pnpm run test:renderer-shell
pnpm run test:git && pnpm run test:host-git
pnpm run test:sidebar && pnpm run test:layout
pnpm run test:settings-bridge && pnpm run test:connections
pnpm run test:client-web && pnpm run test:connection
pnpm run test:open-in && pnpm run test:cli
pnpm run test:release-workflow
pnpm run smoke
```

`pnpm run smoke` prints SKIP and exits 0 without a dsh install; expected, not a failure.

## Before Submitting

```bash
pnpm run typecheck                            # tsc --noEmit (0 errors)
pnpm run typecheck:runtime
pnpm run typecheck:gateway
pnpm run typecheck:host-graph
pnpm run typecheck:host-git
pnpm run typecheck:sidebar                    # client plugin type checks
pnpm run typecheck:layout
pnpm run typecheck:git
pnpm run typecheck:connections
pnpm run typecheck:settings-bridge
pnpm run typecheck:open-in
pnpm run typecheck:client-web
pnpm run typecheck:connection
pnpm run test:control-plane && pnpm run test:runtime
pnpm run test:desktop && pnpm run test:gateway
pnpm run test:renderer-shell
pnpm run test:git && pnpm run test:host-git
pnpm run test:sidebar && pnpm run test:layout
pnpm run test:settings-bridge && pnpm run test:connections
pnpm run test:client-web && pnpm run test:connection
pnpm run test:open-in && pnpm run test:cli
pnpm run test:release-workflow
pnpm run smoke                                # PASS (or SKIP, which is normal)
pnpm run build:renderer                       # renderer build succeeds
pnpm run build:gateway                        # gateway + dsh-runtime build succeeds
pnpm --filter @dsh-chamber/desktop run build:preload
pnpm run verify:i18n
pnpm run verify:styles
```

For changes touching runtime, auth, protocol, or desktop-shell behavior, add or update focused tests — static checks alone do not prove runtime correctness.

## Code Style

- Erasable-only TypeScript (`"type": "module"`, zero build; sources run natively via Node type stripping, see `tsconfig.json`); contract validation is hand-written TS (zod-reuse deviation in the design docs).
- Follow the existing `src/` layout: single-purpose files with a top doc comment.
- Match error handling and naming to neighboring code.
- No unrelated refactors; keep diffs focused.

## Commit Messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): subject
```

- type — one of: `feat` (new capability), `fix` (bug fix), `chore` (build/tooling), `docs`, `refactor`, `test`, `ci`, `perf`, `style` (formatting), `revert`.
- scope — optional; prefer the affected package or area: `control-plane`, `renderer`, `desktop`, `sidebar`, `settings-bridge`, `cli`, `ci`, `docs`, `packaging`.
- subject — imperative, no trailing period, ≤ 72 characters ("fix" not "fixed"; "add" not "adds").
- language (mandatory) — commit messages are always English: subject and body both (the examples below are canonical). The repository's Chinese history is not a precedent; every commit added from this rule onward is English, so upstream and outside contributors can search and cite it. Code comments, design docs and PR bodies may stay Chinese.
- body — when the change is not self-evident, explain the *what* and *why* after a blank line; reference the relevant design/progress doc or issue.
- breaking changes — append `!` after type/scope (e.g. `feat(desktop)!: ...`) or add a `BREAKING CHANGE:` footer, and describe migration impact in the body.

Examples:

```
feat(control-plane): add per-instance health endpoint
fix(desktop): await tunnel dispose before quit
ci(release): enforce channel-specific update assets
docs: document the commit message convention
```

One logical change per commit; split commits that bundle unrelated changes.

## Scope Discipline

- Anything the dsh host, its plugin ecosystem, or the reused dsh frontend already provides is attached or served, never re-implemented.
- Domains removed from scope (walkthrough, notification center/history, terminal rendering/input, web preview, MCP, thin-shell chat UI, control-plane session runtime, …) must not return in any form. Ratified bounded exceptions only: Design 08's in-instance Git worktree plugin; Design 17's separately invoked gateway (shell + host duties + seed registry); Design 18's shared dsh runtime-management core; Design 19's Electron-native notification edge projection; Design 20's trusted open-in edge capability (including its local-shape in-instance host domain `openInApp`, boundaries in design 20 §6.3); Design 24's in-instance archive-cleanup host domain `archiveCleanup/{preview,purge,probe}` (delete-only, whole-subtree skip while running, idempotent; narrowest boundaries in design 24 §2). None may introduce an execution surface, session consumer, notification history, or fact authority into `packages/control-plane` or the renderer.
- For any new domain feature, ask first whether dsh native, the plugin ecosystem, or the host web frontend already covers it; if so, don't build.

## Pull Requests

Pull requests are review handoffs, not just diffs: a reviewer must understand intent, assess risk, and verify the result without redoing the contributor's work.

Before opening a pull request:

1. Read [`AGENTS.md`](../AGENTS.md) and the relevant design/progress docs (`docs/design/01-overview.md` is the entry point).
2. Keep the change focused; separate unrelated cleanup or refactors.
3. Run the validation required by the change, not only the broad commands above.
4. Complete the pull request template with concrete, current evidence for the final PR HEAD.

### Pull Request Contract

Every pull request must explain:

- Intent: the user or maintainer problem being solved and the resulting behavior.
- Non-goals: nearby behavior intentionally left unchanged where scope could otherwise be ambiguous.
- Affected surfaces: packages, runtimes, persisted/external contracts, and user-visible states affected by the change.
- Repository guidance: the AGENTS.md rules and owning design/progress docs that applied, why, and how the implementation satisfies them.
- Validation: exact commands and manual checks performed, their result, and anything that was not verified. A command name without a result is not evidence.
- Risk and failure behavior: failure, rollback, cleanup, compatibility, security, performance, or cross-runtime considerations.

Do not claim runtime, auth, protocol, or platform correctness from static checks alone; if required validation could not be performed, say so and why.

## Not a Developer?

You can still help:

- Report bugs or UX issues — even "this felt confusing" is valuable feedback
- Test on different platforms and environments (local host, SSH, different OSes)
- Suggest features via issues
- Ask and answer questions in the issue tracker

## Questions?

Open an [issue](https://github.com/panzeyu2013/dsh-chamber/issues) or read the design docs in [`docs/design/`](design/).
