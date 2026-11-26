/**
 * Type declaration for prune-runtime.mjs at the desktop package root
 * (design 18 §4) — lets the main-process TypeScript (runtime-installer.ts)
 * resolve the dynamic import of the build-time prune module without enabling
 * allowJs. The .mjs is the runtime-prune source; this `.d.mts` mirrors its
 * public exports.
 */
export function pruneRuntimeArtifacts(root: string): { removedFiles: number; removedDirs: number }

/** The declared bundle detail documents (`locale/*.json` `meta.detail`) that exist in `root`. */
export function collectDeclaredDetailFiles(root: string): string[]

/**
 * Runtime skill-face Markdown (under any `skills/` or `references/` directory) in `root`.
 * bundle-dsh records them before the prune and fails the bundle when one is gone.
 */
export function collectRuntimeSkillFiles(root: string): string[]

/** Pre/post-prune verdict for the runtime skill-face Markdown retention surface. */
export function judgeRuntimeMarkdownRetention(
  declared: string[],
  options?: { exists?: (file: string) => boolean },
): { ok: boolean; kind: 'kept' | 'empty' | 'dropped'; missing: string[] }

/** Revision of the prune rule set; recorded in the bundle manifest so a rule change re-bundles. */
export const PRUNE_RULES_REVISION: number
