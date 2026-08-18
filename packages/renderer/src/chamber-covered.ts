/**
 * The boot-graph entry ids the chamber page covers WITHOUT the host graph —
 * the dedupe set the per-instance host-graph merge filters against (design 09
 * §3.3, module C: `dedupeHostEntries` in host-graph.ts).
 *
 * Two families:
 *
 * - every client plugin package the chamber composite bundle statically
 *   registers (chamber-entry.ts import list — one entry per package name):
 *   loading such a row again from the host graph would register the same
 *   plugin twice on one cordis ctx (cordis rejects the duplicate provide /
 *   slot), so these rows must be skipped, never loaded;
 * - page-own rows that must never arrive as graph extras:
 *   `@deepseek-ai/dsh-client-ui-sidebar` — the official sidebar registration
 *   the chamber sidebar REPLACES (loading it would collide on the sidebar
 *   slot), and `@deepseek-ai/dsh-client-modules` — the shell kernel adopts
 *   that entry itself (boot.tsx MODULES_ID: statically registered, never
 *   fetched), so a second entry would provide `modules` twice.
 *
 * Maintenance discipline: when a plugin import is added to chamber-entry.ts,
 * append its package name here in the same batch; when a row becomes
 * page-own (kernel-adopted, or replacing an official registration), append
 * it with a comment. Missing ids fail LOUD at boot (duplicate registration);
 * extra ids are harmless (a covered id absent from a host graph is never
 * filtered).
 *
 * `@deepseek-ai/cordis` is intentionally absent: it is a type-only import in
 * chamber-entry.ts, never a registered client plugin, and the host graph
 * cannot carry a row for it.
 *
 * This constant lives in its own module (re-exported by chamber-entry.ts) on
 * purpose: shell.ts must import it without pulling chamber-entry.ts's
 * top-level module-table handoff into the main chunk (same pattern as
 * chamber-knob.ts — see its header comment).
 */

export const CHAMBER_COVERED_IDS: readonly string[] = [
  // ── chamber composite registration (chamber-entry.ts import list) ──
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-theme',
  '@dsh-chamber/dsh-client-ui-layout',
  '@dsh-chamber/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-settings-models',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-jobs',
  '@deepseek-ai/dsh-client-ui-goal',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-message-feedback',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-skill',
  '@deepseek-ai/dsh-client-ui-subagent',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-trajectory',
  '@deepseek-ai/dsh-client-ui-user-questions',
  '@deepseek-ai/dsh-client-ui-workflow-run',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-deliverables',
  // Directory picking: the composite pins the `browse` interaction (the host
  // pins the same per spawn — chamber-entry.ts import comment), so the
  // picker-auto-mounted browse row is composite-covered too.
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-permission-presets',
  '@dsh-chamber/dsh-client-ui-settings-connections',
  '@dsh-chamber/dsh-client-ui-settings-bridge',
  // ── page-own rows (see header comment) ──
  '@deepseek-ai/dsh-client-ui-sidebar',
  // The official layout registration the chamber ui-layout fork REPLACES
  // (design 06): the composite registers the fork into 'root', so loading
  // the official bundle would register a second 'root' entry — a duplicate
  // declaration of the same slot at the same priority, rejected by the
  // one-declarer rule (ui-slots index.ts:800-803).
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-modules',
]
