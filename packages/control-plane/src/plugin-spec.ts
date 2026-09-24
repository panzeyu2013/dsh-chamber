/**
 * The plugin spec/name whitelist family (the reserved-name DENY predicate lives
 * in protected-plugins.ts, the single write-face judge) — THE single source
 * shared by every plugin-management backend:
 *
 *  - the desktop main process consumes it through
 *    desktop/control-plane-module.ts (packaged → compiled dist, dev → this
 *    source), which ssh-provider.ts re-exports and plugin-sync.ts imports;
 *  - the gateway imports '@dsh-chamber/control-plane' directly;
 *  - the WEB/RENDERER chain must NOT import this Node-side module — the
 *    renderer's ADD_SPEC is a hand mirror that must stay in lockstep with
 *    PLUGIN_SPEC_PATTERN.
 */

/** Package-spec length cap: bounds add/remove inputs before any whitelist test or remote argv construction. */
export const MAX_PLUGIN_SPEC_CHARS = 512

/**
 * Package spec whitelist: registry name (+ optional scope) with an optional
 * `@version` (exact / `^`range / `~`range / dist-tag). The character class is
 * deliberately shell-safe — NO `| < > *` space quotes `$` `; & ( )` backtick —
 * because the ssh transport hands the argument to the REMOTE shell verbatim and
 * the gateway executor passes it through spawn argv. Ranges (`>=1.2.3 <2`),
 * `||`, wildcards, `npm:` aliases, `git+` / URL specs and `file:`/`link:`/
 * relative paths are all REFUSED here (injection surface, or materialized via a
 * separate path). The renderer's ADD_SPEC mirrors this byte-for-byte.
 */
export const PLUGIN_SPEC_PATTERN = /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*(@(\^|~)?([0-9A-Za-z][0-9A-Za-z._+-]*|latest|next))?$/

/** Name-only form for `dsh plugin remove <name>` / remove-side validation. */
export const PLUGIN_NAME_PATTERN = /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * The materialize-add `file:` spec whitelist: only the ABSOLUTE form of the
 * materialized-tarball stable dir may reach the remote `dsh plugin add` command
 * — `<remote-home>/.dsh-chamber/plugins/<name>-<hash>.tgz`. The path is
 * constrained to the `.dsh-chamber/plugins/` subtree (the same fixed surface
 * resolveWriteTarget allows writes into), shell-safe, and the argv is only ever
 * constructed by the main-process materialize orchestration (the renderer has no
 * channel forwarding a `file:` spec to a remote `run`; applyPlugins
 * re-validates against PLUGIN_SPEC_PATTERN, which refuses `file:`). `~` is never
 * accepted here: a word-middle `~` is not expanded by the remote shell/pnpm.
 */
export const MATERIALIZE_FILE_SPEC_PATTERN = /^file:\/([a-zA-Z0-9._-]+\/)*\.dsh-chamber\/plugins\/[a-zA-Z0-9._-]+\.tgz$/

/**
 * write-file content cap (50MiB suggested): bounds both the base64 payload
 * decoded in the main process and the materialize/seed payloads flowing
 * through write-file.
 */
export const WRITE_FILE_MAX_BYTES = 50 * 1024 * 1024

/** Captured stdout cap for whitelisted remote reads: remote profile files are
 * not trusted to be small, so without a byte budget a corrupt/malicious remote
 * `cat` could exhaust Electron's main-process memory; it still admits the
 * largest write-file read-back exactly. */
export const RUN_STDOUT_MAX_BYTES = WRITE_FILE_MAX_BYTES

/**
 * The registry package NAME a spec/name value refers to — shared extraction core
 * for the sibling copies in gateway-ipc-shared.ts, gateway plugins-tasks.ts and
 * desktop ssh-apply-rows.ts (the guarded, null-returning variant).
 *
 * Rule: the whitelist has already guaranteed the shape (registry name +
 * optional scope, optional trailing @version); the name is everything before
 * the LAST `@`, and a bare `@scope/name` is returned whole. Inputs failing the
 * whitelist are NOT this helper's contract.
 */
export function extractSpecName(spec: string): string {
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}
