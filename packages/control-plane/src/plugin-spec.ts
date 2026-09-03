/**
 * The plugin spec/name whitelist family + reserved-name deny predicate — the
 * SINGLE source shared by every plugin-management backend (design 21 §6.2 /
 * §6.7, A2 cross-package single-sourcing; plan Phase 4.3):
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
 *   (packages/gateway/test/plugin-spec-lockstep.test.ts) pins that mirror to
 *   this file's PLUGIN_SPEC_PATTERN literal.
 *
 * Moved verbatim from desktop ssh-provider.ts (design 13 §7.2 origin) so the
 * desktop and gateway backends can never drift; ssh-provider.ts now re-exports
 * this module through the desktop facade.
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
 * §4.6). The renderer's ADD_SPEC is a byte-identical hand mirror pinned by
 * the lockstep test.
 */
export const PLUGIN_SPEC_PATTERN = /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*(@(\^|~)?([0-9A-Za-z][0-9A-Za-z._+-]*|latest|next))?$/

/** Name-only form for `dsh plugin remove <name>` / remove-side validation. */
export const PLUGIN_NAME_PATTERN = /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * The materialize-add `file:` spec whitelist (design 13 §4.6 / §7.2): only the
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
 * Reserved-name deny predicate (design 21 §6.2/§6.4/decision 19 — the shared
 * model-level rule for INSTALL and REMOVE alike, matching the plugin
 * dialog's third-party row filter): the official domain (`@deepseek-ai/*`)
 * and the chamber domain (`@dsh-chamber/*` — the seeded host packages, the
 * self-built client plugins and the mobile exception are all chamber-managed
 * and can never be installed/removed through the plugin model) are denied.
 * Callers apply it to the parsed package NAME (install paths extract the
 * name from the full spec first); the prefix match stays correct even if a
 * versioned `@scope/name@ver` string reaches it.
 */
export function isDeniedPluginName(name: string): boolean {
  return name.startsWith('@deepseek-ai/') || name.startsWith('@dsh-chamber/')
}
