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

/** Revision of the prune rule set; recorded in the bundle manifest so a rule change re-bundles. */
export const PRUNE_RULES_REVISION: number
