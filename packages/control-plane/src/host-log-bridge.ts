/**
 * Managed-dsh application-log bridge — opt-in forensic switch (control-plane half).
 *
 * The dsh application logs through the Cordis built-in logger, but the pinned runtime
 * registers no exporter for it (the upstream console exporter is a devDependency not
 * installed in the chamber-managed runtime), so `ctx.logger` output never reaches
 * stdout/stderr and host-logs/<port>.log holds only readiness announcements.
 *
 * The bridge is a tiny generated Cordis plugin (no imports; documented `ctx.logger`
 * invite API) that exports every accepted message to stderr: stderr keeps application
 * lines away from the stdout-only `dsh web:` launch-token scanner, and each line rides
 * the existing pipeline (line buffering → `?token=` redaction → JSONL in the shared
 * host-logs ring). Enabling it at the conservative `warn` threshold means INFO traffic
 * can evict the readiness line from disk sooner — the token itself is captured in memory
 * by the scanner, never re-read from the log.
 *
 * The plugin mounts through `LoggerService.exporter()`, the documented invite API:
 * since 0.1.7 its disposer deletes the id it registered, so unloading any exporter's
 * fiber no longer removes the newest registration (the pre-0.1.7 counter bug).
 *
 * `DSH_CHAMBER_HOST_LOG_LEVEL` switches it: unset/empty/off/0/false/no ⇒ no bridge row and
 * no generated file (the overlay stays byte-identical to the disabled shape); a level name
 * or enable token mounts at the conservative `warn` default so a typo cannot flood the
 * disk. It is one more SEED ENTRY, not a CHAMBER_HOST_PACKAGES row — it exposes no Typert
 * Remote domain, and such a row would fail the activation probe. The generated source
 * lives under <stateDir>/host-log-bridge-package and is content-compared.
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
 * The opt-in switch. Read from the control-plane process environment (the spawned host
 * inherits it) at every managed spawn. Deliberately NOT `DSH_GATEWAY_*`: that prefix is
 * stripped from the child environment (sanitizeManagedDshEnv), and this is not a credential.
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

// Fail-fast naming pin: a row whose name is not `dsh-chamber-seed-<id>` would seed a profile
// directory the overlay row cannot resolve.
assertHostSeedInsertNaming([HOST_LOG_BRIDGE_INSERT])

/**
 * Cordis logger verbosity thresholds (LoggerService `_method` levels): a message is
 * exported when `message.level <= configured` — error(0) errors only, info(1), warn(2),
 * debug(3) everything. The numeric value is baked into the generated plugin.
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
  /** The raw value when it was neither a level name nor an enable token; the caller warns loudly. */
  readonly unrecognized?: string
}

/**
 * Parse the switch value. Absent/`off`-family ⇒ disabled; a level name ⇒ that level; an
 * enable token or unrecognized non-empty value ⇒ enabled at
 * DEFAULT_HOST_LOG_BRIDGE_LEVEL. Never throws — a bad value must not break a spawn.
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
 * The generated Cordis plugin source. No imports: the module must resolve while loaded
 * from the managed profile, whose node_modules holds only the seeded chamber packages.
 * Formatting delegates to the host's own `Logger.format` through the documented
 * `ctx.logger(name)` API, with a minimal fallback so a formatter change degrades to plain
 * text instead of dropping evidence.
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
    const mount = function () {
      const sink = {
        colors: 0,
        maxLength: MAX_LINE_CHARS,
        levels: { default: LEVEL },
        export(message) {
          try {
            const lines = String(render(message)).split('\\n')
            for (const line of lines) process.stderr.write(line.slice(0, MAX_LINE_CHARS) + '\\n')
          } catch { /* diagnostics must never break the host */ }
        },
      }
      // The documented invite API owns registration and removal: since 0.1.7
      // LoggerService.exporter() returns its own effect disposer, which deletes
      // the id IT registered (the pre-0.1.7 counter bug is gone). That disposer
      // is the whole cleanup path, so the returned function calls it directly.
      // Deliberately NOT wrapped: a throwing registration must propagate so the
      // caller's mount mark stays unset and a later apply can retry (the outer
      // try/catch keeps the host boot alive either way).
      const returned = ctx.logger.exporter(sink)
      return function () { returned() }
    }
    // The registration is owned by THIS fiber's effect: a loader remount
    // disposes the effect and re-runs the body, and the
    // effect's disposer removes exactly our own exporter entry, so no run can
    // leave a second exporter behind. MOUNTED is cleared by that same disposer:
    // a same-fiber reload (Fiber.update re-runs the plugin with the SAME ctx)
    // disposes the effect first, so marking ownership outside the effect would
    // suppress the re-mount and silently stop the bridge. Every cordis Context
    // carries effect(), so the bridge registers through it unconditionally; the
    // outer try/catch is the only containment a broken bridge needs.
    const run = function () {
      // Mark ONLY after a successful mount: effect() asserts the fiber is active
      // BEFORE it runs this callback (fiber.ts), so a throw here means nothing
      // was registered — and marking first would leave the ctx poisoned, so a
      // later apply could never retry and the bridge would be silently dead.
      const dispose = mount()
      MOUNTED.add(ctx)
      return function () {
        MOUNTED.delete(ctx)
        dispose()
      }
    }
    ctx.effect(run, 'chamber host log bridge exporter')
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
 * Materialize the generated bridge package under <stateDir> and return its source
 * directory (idempotent: unchanged files are left alone). The directory has the exact
 * shape `ensureSeedPackage` consumes (package.json + dist/index.js).
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
 * Plan the bridge seed entry for one spawn: null while the switch is off (the overlay then
 * stays byte-identical to the disabled overlay), otherwise the canonical seed entry whose
 * source has just been (re)materialized. The environment is passed in explicitly so a
 * synthetic caller never picks up the ambient shell.
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
    // No Typert Remote domain: chamber-internal diagnostics with no activation-probe coupling.
    probeDomains: [],
  }
}
