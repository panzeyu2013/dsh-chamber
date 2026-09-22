/**
 * The plugin spec/name whitelist family (the reserved-name DENY predicate
 * lives in `protected-plugins.ts`, the single write-face judge,
 * design 21 §6.11) — the
 * SINGLE source shared by every plugin-management backend (design 21 §6.2 /
 * §6.7, cross-package single-sourcing):
 *
 * - the desktop main process consumes them through
 *   desktop/control-plane-module.ts (the dual-path facade: packaged →
 *   compiled dist/control-plane, dev/tests → this workspace source), which
 *   ssh-provider.ts re-exports and plugin-sync.ts imports;
 * - the gateway imports '@dsh-chamber/control-plane' directly (its build
 *   bundles this module);
 * - the WEB/RENDERER chain must NOT import this module (it is Node-side; a
 *   browser bundle cannot reach it) — the renderer's ADD_SPEC keeps its hand
 *   mirror, and the lockstep test
 *   (packages/gateway/test/plugins/plugin-spec-lockstep.test.ts) pins that mirror to
 *   this file's PLUGIN_SPEC_PATTERN literal.
 *
 * Shared with the desktop and gateway backends so they can never drift
 * (design 13 §7.2 origin); ssh-provider.ts re-exports this module through the
 * desktop facade.
 */

/** Package-spec length cap (design 13 §7.2): bounds add/remove inputs before
 * any whitelist test or remote argv construction. */
export const MAX_PLUGIN_SPEC_CHARS = 512

/**
 * Package spec whitelist (design 13 §7.2): registry name (+ optional scope)
 * with an optional `@version` (exact / `^`range / `~`range / dist-tag). The
 * character class is deliberately shell-safe — NO `| < > *` space quotes `$`
 * `; & ( )` backtick — because the ssh transport hands the argument to the
 * REMOTE shell verbatim and the gateway executor passes it through spawn
 * argv. Ranges (`>=1.2.3 <2`), `||`, wildcards, `npm:` aliases, `git+` /
 * URL specs and `file:`/`link:`/relative paths are all REFUSED here (they
 * are injection surface, or are materialized via a separate path, design 13
 * §3). The renderer's ADD_SPEC is a byte-identical hand mirror pinned by
 * the lockstep test.
 */
export const PLUGIN_SPEC_PATTERN = /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*(@(\^|~)?([0-9A-Za-z][0-9A-Za-z._+-]*|latest|next))?$/

/** Name-only form for `dsh plugin remove <name>` / remove-side validation. */
export const PLUGIN_NAME_PATTERN = /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * The materialize-add `file:` spec whitelist (design 13 §7.2): only the
 * ABSOLUTE form of the materialized-tarball stable dir may reach the remote
 * `dsh plugin add` command — `<remote-home>/.dsh-chamber/plugins/<name>-<hash>.tgz`.
 * The path is constrained to the `.dsh-chamber/plugins/` subtree (the same
 * fixed surface resolveWriteTarget allows writes into), shell-safe, and the
 * argv is only ever constructed by the main-process materialize orchestration
 * (the renderer has no channel that forwards a `file:` spec to a remote
 * `run` — applyPlugins re-validates against PLUGIN_SPEC_PATTERN, which
 * refuses `file:`). `~` is never accepted here: a word-middle `~` is not
 * expanded by the remote shell/pnpm, so the absolute form is mandatory.
 */
export const MATERIALIZE_FILE_SPEC_PATTERN = /^file:\/([a-zA-Z0-9._-]+\/)*\.dsh-chamber\/plugins\/[a-zA-Z0-9._-]+\.tgz$/

/**
 * write-file content cap (design 13 §4.1: 50MiB suggested): bounds both the
 * base64 payload decoded in the main process and the materialize/seed
 * orchestration payloads that flow through write-file.
 */
export const WRITE_FILE_MAX_BYTES = 50 * 1024 * 1024

/** Captured stdout cap for whitelisted remote reads. Remote profile files
 * are not trusted to be small; without a byte budget a corrupt/malicious
 * remote `cat` could exhaust Electron's main-process memory. The cap also
 * admits the largest write-file read-back exactly. */
export const RUN_STDOUT_MAX_BYTES = WRITE_FILE_MAX_BYTES

/**
 * The registry package NAME a spec/name value refers to — the shared
 * extraction core of the whitelist-validation-then-lastIndexOf('@') rule the
 * three sibling copies re-implement today:
 * - desktop gateway-ipc-shared.ts `pluginSpecName` (extraction after the
 *   caller's PLUGIN_SPEC_PATTERN check in parseSpecArg);
 * - gateway plugins-tasks.ts `pluginSpecName` (verbatim copy, called after
 *   validateSubmission's PLUGIN_SPEC_PATTERN check);
 * - desktop ssh-apply-rows.ts `parseSpecName` (the guarded, null-returning
 *   variant: its type/whitelist/PLUGIN_NAME_PATTERN guards wrap this core).
 *
 * Rule: the whitelist has already guaranteed the shape (registry name +
 * optional scope, optional trailing @version) — then the name is everything
 * before the LAST `@`; a bare `@scope/name` has its scope `@` at index 0 and
 * is returned whole. Inputs that fail the whitelist are NOT this helper's
 * contract (the guarded variant filters them first).
 */
export function extractSpecName(spec: string): string {
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}
