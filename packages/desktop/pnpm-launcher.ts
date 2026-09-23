/**
 * pnpm launcher resolution for the desktop main process (design 21 §6.3 /
 * design 23).
 *
 * The launcher never names a `.cmd`: Node >=18.20.2/20.12.2 refuses to spawn
 * `.cmd`/`.bat` without a `shell` option (CVE-2024-27980 hardening, EINVAL),
 * and the direct-spawn supervisor passes none. On win32 the pnpm SCRIPT entry
 * (`pnpm.cjs` — the bundled extraResources copy, else a dev/installer copy)
 * therefore runs through the current node/Electron binary, the same
 * `[process.execPath, pnpm.cjs]` shape main.ts injects into the runtime
 * installer; POSIX keeps the bare `pnpm` name (PATH lookup).
 *
 * Pure module (no fs, no electron): every existence probe stays the caller's,
 * so the command/args shape is unit-testable per platform on every CI leg.
 * Path joins are chosen by the TARGET platform, not the host, which is what
 * makes that testing possible off-Windows.
 */
import { posix, win32 } from 'node:path'

/** One direct-spawn pnpm launch: command + argv prefix + env overlay. */
export interface PnpmLauncher {
  command: string
  /** argv prefix before the pnpm subcommand (the pnpm.cjs entry on win32). */
  args: string[]
  /** Env overlay the launcher needs (Electron-as-node on win32). */
  env: Record<string, string>
}

function pathFor(platform: NodeJS.Platform): typeof win32 {
  return platform === 'win32' ? win32 : posix
}

function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return pathFor(platform).join(...parts)
}

function dirnameFor(platform: NodeJS.Platform, path: string): string {
  return pathFor(platform).dirname(path)
}

/**
 * Resolve the pnpm launcher for a DIRECT spawn (no shell).
 *
 * POSIX: the bare `pnpm` name. win32: `execPath` + the
 * pnpm.cjs script entry, or null when no script entry exists — the caller then
 * fails loud instead of falling back to the `pnpm.cmd` shim Node refuses.
 * `electron` adds ELECTRON_RUN_AS_NODE=1 so the Electron main binary executes
 * the script as node.
 */
export function resolvePnpmLauncher(input: {
  platform: NodeJS.Platform
  /** process.execPath (Electron main → the Electron binary). */
  execPath: string
  /** Existing absolute pnpm.cjs entry, or null when none was found. */
  scriptEntry: string | null
  /** Electron runtime: run the script with ELECTRON_RUN_AS_NODE=1. */
  electron?: boolean
}): PnpmLauncher | null {
  if (input.platform !== 'win32') {
    return { command: 'pnpm', args: [], env: {} }
  }
  if (input.scriptEntry === null || input.scriptEntry === '') return null
  return {
    command: input.execPath,
    args: [input.scriptEntry],
    env: input.electron === true ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  }
}

/**
 * Absolute `pnpm.cjs` entries for the desktop's OWN bundled/dev launcher, in
 * preference order — the ONE candidate set every desktop consumer reads (the
 * runtime installer's pnpmEntry, the Swift sidecar assembly entry, the
 * `pnpm pack` script entry, the PATH bin-dir scan):
 *   1. `<resourcesPath>/pnpm/bin/pnpm.cjs`      packaged Electron extraResources
 *   2. `assemblyEntry`                          Swift sidecar assembly dir entry
 *   3. `legacyAssemblyEntry`                    legacy Swift sidecar assembly dir
 *   4. `<moduleDir>/node_modules/pnpm/bin/pnpm.cjs`  dev workspace tree
 * The sidecar's two layout spellings are passed in by sidecar-ctx (their Swift
 * layout-lockstep anchors); the resources/dev spellings live here. Pure: the
 * caller probes existence (firstExistingPnpmEntry).
 */
export function bundledPnpmEntryCandidates(input: {
  platform: NodeJS.Platform
  /** dirname(fileURLToPath(import.meta.url)) — the desktop package dir / sidecar dir. */
  moduleDir: string
  /** Electron `process.resourcesPath` (packaged app), or null/undefined in dev. */
  resourcesPath?: string | null
  /** Sidecar assembly entry (`<sidecarDir>/pnpm/bin/pnpm.cjs`), or null. */
  assemblyEntry?: string | null
  /** Legacy sidecar assembly entry (`<sidecarDir>/../pnpm/bin/pnpm.cjs`), or null. */
  legacyAssemblyEntry?: string | null
}): string[] {
  const entries: string[] = []
  if (typeof input.resourcesPath === 'string' && input.resourcesPath !== '') {
    entries.push(joinFor(input.platform, input.resourcesPath, 'pnpm', 'bin', 'pnpm.cjs'))
  }
  if (typeof input.assemblyEntry === 'string' && input.assemblyEntry !== '') {
    entries.push(input.assemblyEntry)
  }
  if (typeof input.legacyAssemblyEntry === 'string' && input.legacyAssemblyEntry !== '') {
    entries.push(input.legacyAssemblyEntry)
  }
  entries.push(joinFor(input.platform, input.moduleDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
  return entries
}

/** First candidate that exists (the probe is the caller's — this module stays
 *  fs-free and per-platform unit-testable), or null when none exists. */
export function firstExistingPnpmEntry(
  candidates: readonly string[],
  exists: (entry: string) => boolean,
): string | null {
  for (const entry of candidates) {
    if (exists(entry)) return entry
  }
  return null
}

/**
 * `bundledPnpmEntryCandidates` plus the roots the official pnpm/npm installers
 * use (%LOCALAPPDATA%\pnpm standalone, %APPDATA%\npm shims, and the node install
 * dir for npm-global prefixes), in preference order. Pure: the caller probes
 * existence.
 */
export function pnpmScriptEntryCandidates(input: {
  platform: NodeJS.Platform
  /** dirname(fileURLToPath(import.meta.url)) — the desktop package dir. */
  moduleDir: string
  /** Electron `process.resourcesPath` (packaged app), or null/undefined in dev. */
  resourcesPath?: string | null
  /** `process.env` (LOCALAPPDATA / APPDATA on Windows). */
  env?: NodeJS.ProcessEnv
  /** `process.execPath` — its dirname is the node install dir. */
  execPath: string
}): string[] {
  const entries = bundledPnpmEntryCandidates(input)
  const roots = [input.env?.LOCALAPPDATA, input.env?.APPDATA, dirnameFor(input.platform, input.execPath)]
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') continue
    entries.push(joinFor(input.platform, root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
  }
  return entries
}

/**
 * Windows directories the official pnpm/npm installers use, plus the app's own
 * bundled pnpm bin dir, in preference order (pure: the caller probes the
 * launcher file names). `%LOCALAPPDATA%\pnpm` is the standalone installer
 * (pnpm.exe); `%APPDATA%\npm` is the npm global prefix (pnpm.cmd shims); the
 * node install dir hosts the npm-global/corepack shims when node owns the
 * prefix. Always Windows joins — this list only exists on win32.
 */
export function windowsPnpmSearchDirs(input: {
  env?: NodeJS.ProcessEnv
  execPath: string
  /** Directory of the bundled pnpm.cjs (packaged resources / dev tree), or null. */
  bundledBinDir?: string | null
}): string[] {
  const dirs: string[] = []
  if (typeof input.bundledBinDir === 'string' && input.bundledBinDir !== '') dirs.push(input.bundledBinDir)
  const localAppData = input.env?.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData !== '') dirs.push(win32.join(localAppData, 'pnpm'))
  const appData = input.env?.APPDATA
  if (typeof appData === 'string' && appData !== '') dirs.push(win32.join(appData, 'npm'))
  dirs.push(win32.dirname(input.execPath))
  return dirs
}

/** File names probed inside one directory for a runnable pnpm bin dir: win32
 *  accepts the bundled script form, POSIX the bare name. */
export function pnpmBinNames(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm.cjs'] : ['pnpm']
}

/**
 * Directories scanned for a runnable pnpm bin dir, in preference order (the
 * PATH prefix for a desktop-launched packaged app, whose PATH is minimal and
 * lacks pnpm): the PATH entries themselves, then the app's own bundled bin dir,
 * then the official installer roots — Windows: %LOCALAPPDATA%\pnpm standalone,
 * %APPDATA%\npm global prefix, the node install dir; POSIX: nvm version dirs,
 * volta, the Linux installer roots, homebrew and the standard bin dirs. Pure:
 * `nvmVersionDirs` is read by the caller and every existence probe stays with
 * the caller (pnpmBinNames probes the file names).
 */
export function pnpmBinDirCandidates(input: {
  platform: NodeJS.Platform
  /** Already-split PATH entries (empty entries are skipped). */
  pathEntries?: readonly string[]
  env?: NodeJS.ProcessEnv
  execPath: string
  /** Directory of the bundled pnpm.cjs (packaged resources / dev tree), or null. */
  bundledBinDir?: string | null
  /** Entries of `<homedir>/.nvm/versions/node` (POSIX only; caller reads them). */
  nvmVersionDirs?: readonly string[]
  homedir: string
}): string[] {
  const candidates: string[] = []
  for (const dir of input.pathEntries ?? []) {
    if (dir !== '') candidates.push(dir)
  }
  if (input.platform === 'win32') {
    candidates.push(...windowsPnpmSearchDirs({
      env: input.env,
      execPath: input.execPath,
      bundledBinDir: input.bundledBinDir,
    }))
    return candidates
  }
  for (const version of input.nvmVersionDirs ?? []) {
    candidates.push(joinFor(input.platform, input.homedir, '.nvm', 'versions', 'node', version, 'bin'))
  }
  candidates.push(
    joinFor(input.platform, input.homedir, '.volta', 'bin'),
    joinFor(input.platform, input.homedir, '.local', 'share', 'pnpm'),
    joinFor(input.platform, input.homedir, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  )
  return candidates
}
