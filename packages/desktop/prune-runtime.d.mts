/**
 * Type declaration for prune-runtime.mjs at the desktop package root
 * (design 18 §4) — lets the main-process TypeScript (runtime-installer.ts)
 * resolve the dynamic import of the build-time prune module without enabling
 * allowJs. The .mjs is the runtime-prune source; this `.d.mts` mirrors its
 * public exports.
 */
export const PRUNE_DIR_NAMES: Set<string>
export const PRUNE_FILE_PATTERNS: RegExp[]
export function pruneRuntimeArtifacts(root: string): { removedFiles: number; removedDirs: number }
