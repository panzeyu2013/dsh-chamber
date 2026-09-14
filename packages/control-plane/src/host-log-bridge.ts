/**
 * Managed-dsh application-log bridge — opt-in forensic switch (control-plane half).
 *
 * THE GAP this module closes (verified against the pinned harness/dsh runtime,
 * 2026-09): the dsh application logs through the Cordis built-in logger
 * (`ctx.logger.*`, 300+ call sites across the runtime), but the pinned runtime
 * registers NO exporter for it — `@deepseek-ai/cordis`'s LoggerService ships
 * only an in-memory ring buffer, and the upstream console exporter
 * (`@deepseek-ai/cordis-plugin-logger-console`) is an upstream devDependency
 * that is NOT installed in the chamber-managed runtime (chamber adds no
 * dependencies). So `ctx.logger` output never reaches stdout/stderr, and
 * `<stateDir>/host-logs/<port>.log` only ever held readiness announcements —
 * exactly the "session opened and then nothing" blind spot.
 *
 * THE BRIDGE: a tiny generated Cordis plugin (no imports — it uses the
 * documented `ctx.logger` invite/exporter API) that exports every accepted log
 * message to the host process's stderr. stderr is deliberate: the spawn path
 * already captures both child pipes, and stderr keeps application lines away
 * from the stdout-only `dsh web:` launch-token scanner (spawn-dsh.ts). Each
 * line therefore rides the EXISTING pipeline: line-buffered split →
 * `?token=` redaction → `{"ts","stream","line"}` JSONL in host-logs/<port>.log
 * (host-logs.ts, bounded by MAX_LOG_LINES/COMPACT_KEEP_LINES).
 *
 * THE SWITCH: `DSH_CHAMBER_HOST_LOG_LEVEL` (HOST_LOG_BRIDGE_ENV). Unset/empty/
 * off/0/false/no ⇒ NO bridge row, NO generated file: the overlay is
 * byte-identical to the pre-bridge behavior. A level name (error|info|warn|
 * debug — the Cordis verbosity thresholds, see HOST_LOG_BRIDGE_LEVELS) or an
 * enable token (on/true/1/yes, or any unrecognized value) mounts the bridge at
 * a CONSERVATIVE default level (`warn`, i.e. everything except debug) so a typo
 * cannot flood the disk. Debug/trace verbosity is never a default.
 *
 * WHY A GENERATED SEED ENTRY (and not a CHAMBER_HOST_PACKAGES row): the bridge
 * exposes no Typert Remote domain, so it must not join the host-package
 * registry — that registry's `probe.method` values are the activation-gate's
 * expected domain set, and a row without a live Remote would fail the
 * instance's activation probe. It is instead one more seed entry: the same
 * `ensureSeedPackage` copy discipline, the same `--patch` overlay renderer, the
 * same loader-id/name conflict checks — just not a managed plugin surface. The
 * loader id/package name still obey the canonical chamber seed namespace
 * (`dsh-chamber-seed-<loader-id>`), pinned fail-fast at module load.
 *
 * The generated source lives under <stateDir>/host-log-bridge-package (chamber
 * state, 0600 private writes) and is content-compared; a level change rewrites
 * it and the per-spawn seed refreshes the profile copy.
 */

import { join } from 'node:path'
import {
  assertHostSeedInsertNaming,
  type HostPackageInsert,
  type SeedEntry,
} from './host-graph-seed.ts'
import {
  atomicWritePrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
  readPrivateFileNoFollow,
} from './private-file.ts'

/**
 * The opt-in switch. Read from the control-plane process environment (the
 * spawned host inherits it) at every managed spawn; see the module header for
 * the accepted values. Deliberately NOT `DSH_GATEWAY_*`: that prefix is
 * stripped from the child environment on purpose (sanitizeManagedDshEnv), and
 * this value is not a credential.
 */
export const HOST_LOG_BRIDGE_ENV = 'DSH_CHAMBER_HOST_LOG_LEVEL'

/** Loader id of the generated bridge row. */
export const HOST_LOG_BRIDGE_INSERT_ID = 'host-log-bridge'

/** Seeded package name — the canonical `dsh-chamber-seed-<loader-id>` namespace. */
export const HOST_LOG_BRIDGE_PACKAGE_NAME = '@dsh-chamber/dsh-chamber-seed-host-log-bridge'

/** The loader row the overlay carries while the bridge is enabled. */
export const HOST_LOG_BRIDGE_INSERT: HostPackageInsert = {
  id: HOST_LOG_BRIDGE_INSERT_ID,
  name: HOST_LOG_BRIDGE_PACKAGE_NAME,
}

// Fail-fast naming pin, matching the seed registry's own load-time discipline:
// a row whose name is not `dsh-chamber-seed-<id>` would seed a profile
// directory the overlay row cannot resolve.
assertHostSeedInsertNaming([HOST_LOG_BRIDGE_INSERT])

/**
 * Cordis logger verbosity thresholds (LoggerService `_method` levels): a
 * message is exported when `message.level <= configured`. So `error` (0) is
 * errors only, `info` (1) adds info, `warn` (2) adds warnings, `debug` (3) is
 * everything. The numeric value is what the generated plugin bakes in.
 */
export const HOST_LOG_BRIDGE_LEVELS = {
  error: 0,
  info: 1,
  warn: 2,
  debug: 3,
} as const

export type HostLogBridgeLevelName = keyof typeof HOST_LOG_BRIDGE_LEVELS

/** Conservative level substituted for an enable token / unrecognized value —
 *  never `debug`, so an accidental "on" cannot turn on the firehose. */
export const DEFAULT_HOST_LOG_BRIDGE_LEVEL: HostLogBridgeLevelName = 'warn'

/** Values that mean "off" (case-insensitive, trimmed). */
const HOST_LOG_BRIDGE_OFF = new Set(['', 'off', 'false', '0', 'no'])

/** Bare enable tokens; the level is the conservative default. */
const HOST_LOG_BRIDGE_ON = new Set(['on', 'true', '1', 'yes'])

/** One parsed switch value. */
export interface HostLogBridgeSetting {
  readonly enabled: boolean
  /** The effective level name (the conservative default when substituted). */
  readonly levelName: HostLogBridgeLevelName
  /** The effective Cordis threshold baked into the generated plugin. */
  readonly level: number
  /** The raw value when it was neither a level name nor an enable token — the
   *  caller warns loudly; the bridge still mounts at `levelName`. */
  readonly unrecognized?: string
}

/**
 * Parse the switch value. Absent/`off`-family ⇒ disabled; a level name ⇒ that
 * level; an enable token or an unrecognized non-empty value ⇒ enabled at
 * DEFAULT_HOST_LOG_BRIDGE_LEVEL (with `unrecognized` set for the loud warn).
 * @param raw - the environment value (or undefined).
 * @returns the setting; never throws — a bad value must not break a spawn.
 */
export function parseHostLogBridgeEnv(raw: string | undefined): HostLogBridgeSetting {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (value === '' || HOST_LOG_BRIDGE_OFF.has(value)) {
    return { enabled: false, levelName: DEFAULT_HOST_LOG_BRIDGE_LEVEL, level: HOST_LOG_BRIDGE_LEVELS[DEFAULT_HOST_LOG_BRIDGE_LEVEL] }
  }
  if (Object.prototype.hasOwnProperty.call(HOST_LOG_BRIDGE_LEVELS, value)) {
    const levelName = value as HostLogBridgeLevelName
    return { enabled: true, levelName, level: HOST_LOG_BRIDGE_LEVELS[levelName] }
  }
  if (HOST_LOG_BRIDGE_ON.has(value)) {
    return { enabled: true, levelName: DEFAULT_HOST_LOG_BRIDGE_LEVEL, level: HOST_LOG_BRIDGE_LEVELS[DEFAULT_HOST_LOG_BRIDGE_LEVEL] }
  }
  return {
    enabled: true,
    levelName: DEFAULT_HOST_LOG_BRIDGE_LEVEL,
    level: HOST_LOG_BRIDGE_LEVELS[DEFAULT_HOST_LOG_BRIDGE_LEVEL],
    unrecognized: value,
  }
}

/** Chamber-owned scratch directory holding the generated package (stateDir). */
export const HOST_LOG_BRIDGE_SOURCE_DIRNAME = 'host-log-bridge-package'

/** The generated plugin's package manifest (seeded verbatim). */
function hostLogBridgePackageManifest(): string {
  return `${JSON.stringify({
    name: HOST_LOG_BRIDGE_PACKAGE_NAME,
    version: '0.1.0',
    private: true,
    description: 'Chamber opt-in Cordis logger exporter: forwards managed-dsh application log lines to stderr (captured into host-logs/<port>.log)',
    type: 'module',
    main: 'dist/index.js',
    exports: { '.': './dist/index.js' },
    license: 'MIT',
  }, null, 2)}\n`
}

/**
 * The generated Cordis plugin source.
 *
 * No imports: the module must resolve while loaded from the managed profile,
 * whose node_modules holds only the seeded chamber packages (bare
 * `@deepseek-ai/*` specifiers are NOT resolvable from there). Formatting is
 * delegated to the host's own `Logger.format` through the documented
 * `ctx.logger(name)` invite API, with a minimal fallback so a formatter change
 * degrades to plain text instead of dropping evidence.
 * @param level - the Cordis threshold baked in (see HOST_LOG_BRIDGE_LEVELS).
 * @param levelName - the level's name, for the mount announcement.
 * @returns the ESM source of the bridge plugin.
 */
export function hostLogBridgeModuleSource(level: number, levelName: HostLogBridgeLevelName): string {
  if (!Number.isInteger(level) || level < 0 || level > 3) {
    throw new Error(`host log bridge: invalid level ${String(level)}`)
  }
  if (!Object.prototype.hasOwnProperty.call(HOST_LOG_BRIDGE_LEVELS, levelName)) {
    throw new Error(`host log bridge: invalid level name ${JSON.stringify(levelName)}`)
  }
  return `/**
 * Chamber host-log bridge — a Cordis logger exporter for the managed dsh host.
 *
 * Generated by @dsh-chamber/control-plane (host-log-bridge.ts); content-compared
 * and rewritten at every managed spawn. Do not edit.
 *
 * Enabled by DSH_CHAMBER_HOST_LOG_LEVEL at spawn time (level: ${levelName}, cordis
 * threshold ${level}). Writes every exported message to stderr, where the chamber
 * control plane already captures, redacts and rolls child output into
 * host-logs/<port>.log as {"ts","stream","line"}.
 */
const LEVEL = ${level}
const LEVEL_NAME = '${levelName}'
const MAX_LINE_CHARS = 8192
const MOUNTED = new WeakSet()

function safeText(value) {
  if (typeof value === 'string') return value
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

/** Last-resort renderer: the real host always provides Logger.format. */
function fallbackFormat(message) {
  const args = Array.isArray(message.args) ? message.args.slice() : []
  if (args.length > 0 && args[0] instanceof Error) args[0] = args[0].stack || args[0].message
  return args.map(safeText).join(' ')
}

export default function chamberHostLogBridge(ctx) {
  try {
    if (ctx === null || typeof ctx !== 'object' || MOUNTED.has(ctx)) return
    MOUNTED.add(ctx)
    let render = fallbackFormat
    try {
      const Logger = ctx.logger('chamber-host-log-bridge').constructor
      if (Logger !== null && Logger !== undefined && typeof Logger.format === 'function') {
        render = function (message) {
          return Logger.format({ colors: 0, maxLength: MAX_LINE_CHARS }, message)
        }
      }
    } catch { /* keep the fallback renderer */ }
    // A closed pipe (control plane gone) must not turn a diagnostic write into
    // an uncaught stream error that takes the host down with it.
    try { process.stderr.on('error', function () {}) } catch { /* ignore */ }
    ctx.logger.exporter({
      colors: 0,
      maxLength: MAX_LINE_CHARS,
      levels: { default: LEVEL },
      export(message) {
        try {
          const lines = String(render(message)).split('\\n')
          for (const line of lines) process.stderr.write(line.slice(0, MAX_LINE_CHARS) + '\\n')
        } catch { /* diagnostics must never break the host */ }
      },
    })
    process.stderr.write('[chamber] host log bridge active (level=' + LEVEL_NAME + ')\\n')
  } catch { /* a broken bridge must never fail the host boot */ }
}
`
}

/** Write `content` to `path` only when the bytes differ (0600, atomic). */
function writeIfChanged(path: string, content: string): boolean {
  try {
    if (readPrivateFileNoFollow(path, { maxBytes: 1024 * 1024 }).value === content) return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  atomicWritePrivateFileNoFollow(path, content, { mode: 0o600 })
  return true
}

/**
 * Materialize the generated bridge package under <stateDir> and return its
 * source directory (idempotent: unchanged files are left alone, so a spawn does
 * not churn inodes). The returned directory has the exact shape
 * `ensureSeedPackage` consumes (package.json + dist/index.js).
 * @param stateDir - the control-plane state root.
 * @param setting - the parsed switch value (already enabled).
 * @returns the generated package's source directory.
 */
export function ensureHostLogBridgeSource(stateDir: string, setting: HostLogBridgeSetting): string {
  const sourceDir = join(stateDir, HOST_LOG_BRIDGE_SOURCE_DIRNAME)
  ensurePrivateDirectoryNoFollow(sourceDir, 0o700, { existingMode: 'preserve' })
  ensurePrivateDirectoryNoFollow(join(sourceDir, 'dist'), 0o700, { existingMode: 'preserve' })
  writeIfChanged(join(sourceDir, 'package.json'), hostLogBridgePackageManifest())
  writeIfChanged(
    join(sourceDir, 'dist', 'index.js'),
    hostLogBridgeModuleSource(setting.level, setting.levelName),
  )
  return sourceDir
}

/**
 * Plan the bridge seed entry for one spawn: null while the switch is off (the
 * overlay then stays byte-identical to the pre-bridge behavior), otherwise the
 * canonical seed entry whose source has just been (re)materialized.
 *
 * The environment is passed in explicitly — production passes `process.env`
 * from the plane's own spawn-thunk wiring, so a synthetic/test caller never
 * accidentally picks up the ambient shell.
 * @param input - {stateDir, env, warn}: state root, environment snapshot, and
 *   the loud sink for an unrecognized switch value.
 * @returns the seed entry, or null when the bridge is disabled.
 */
export function planHostLogBridge(input: {
  stateDir: string
  env: NodeJS.ProcessEnv
  warn?: (message: string) => void
}): SeedEntry | null {
  const setting = parseHostLogBridgeEnv(input.env[HOST_LOG_BRIDGE_ENV])
  if (!setting.enabled) return null
  if (setting.unrecognized !== undefined) {
    input.warn?.(
      `host log bridge: ${HOST_LOG_BRIDGE_ENV}=${JSON.stringify(setting.unrecognized)} is not a level name `
        + `(error|info|warn|debug) — mounting at the conservative default '${setting.levelName}'`,
    )
  }
  return {
    insert: HOST_LOG_BRIDGE_INSERT,
    kind: 'host',
    source: 'packaged',
    sourceDir: ensureHostLogBridgeSource(input.stateDir, setting),
    // No Typert Remote domain: the bridge is chamber-internal diagnostics and
    // deliberately carries no activation-probe coupling (see the module header).
    probeDomains: [],
  }
}
