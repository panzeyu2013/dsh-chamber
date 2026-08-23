/**
 * Type declaration for allow-builds.mjs (design 16 §4 R3-2 F6/F7, R3-5 P2-3).
 *
 * allow-builds.mjs is the single source of truth for the dsh runtime
 * allowBuilds whitelist, imported by BOTH the build-time bundler
 * (scripts/bundle-dsh.mjs) and the runtime installer (main-process TS).
 * Node resolves the .mjs at runtime; this `.d.mts` lets the TypeScript
 * typechecker (module: nodenext) resolve `import './allow-builds.mjs'`
 * from .ts callers without enabling allowJs.
 */
export const ALLOW_BUILDS: string[]
