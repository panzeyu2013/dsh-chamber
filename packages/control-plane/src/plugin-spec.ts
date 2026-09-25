/**
 * The plugin spec/name whitelist family (the reserved-name DENY predicate lives
 * in protected-plugins.ts, the single write-face judge) — THE single source
 * shared by every plugin-management backend:
 *
 *  - the desktop main process consumes it through
 *    desktop/control-plane-module.ts (packaged → compiled dist, dev → this
 *    source), which ssh-provider.ts re-exports and plugin-sync.ts imports;
 *  - the gateway imports '@dsh-chamber/control-plane' directly.
 * The user plugin write surface was retired with the 2026-09 C layering ruling,
 * so the constants here now serve the surviving read/protection paths alone.
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


