/**
 * Managed-dsh application-log bridge tests (host-log-bridge.ts).
 *
 * The bridge exists because the pinned dsh runtime registers no exporter for
 * its Cordis logger, so application logs never reached the child's
 * stdout/stderr and host-logs/<port>.log only held readiness announcements.
 * These tests pin the two halves of the contract WITHOUT spawning a dsh host:
 *
 *   1. the SWITCH: off ⇒ zero change (no generated package, no loader row, the
 *      overlay stays byte-identical to the pre-bridge content); on ⇒ the
 *      generated seed entry, the loader row and the seeded profile package;
 *   2. the GENERATED PLUGIN: loaded for real (dynamic import of the file the
 *      control plane wrote) with an injected Cordis-like context and an
 *      injected stderr sink, it registers an exporter at the configured
 *      threshold and forwards lines — which then ride the production
 *      redaction + rolling-log writer into the {"ts","stream","line"} JSONL
 *      shape the readers and the CLI consume.
 *
 * Run directly: node packages/control-plane/test/host-log-bridge.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tempDir } from './utils.ts'
import {
  DEFAULT_HOST_LOG_BRIDGE_LEVEL,
  HOST_LOG_BRIDGE_ENV,
  HOST_LOG_BRIDGE_INSERT,
  HOST_LOG_BRIDGE_LEVELS,
  HOST_LOG_BRIDGE_PACKAGE_NAME,
  HOST_LOG_BRIDGE_SOURCE_DIRNAME,
  ensureHostLogBridgeSource,
  hostLogBridgeModuleSource,
  parseHostLogBridgeEnv,
  planHostLogBridge,
} from '../src/host-log-bridge.ts'
import {
  HOST_GRAPH_INSERT,
  HOST_GRAPH_PACKAGE_NAME,
  HOST_GRAPH_PATCH_FILENAME,
} from '../src/host-graph-seed.ts'
import { resolveLocalHostGraphOverlay } from '../src/index.ts'
import { redactChildOutputLine } from '../src/spawn-dsh.ts'
import { createHostLogWriter, logPathFor, readLogTail } from '../src/host-logs.ts'

/** Repository root: `packages/control-plane/test` → three levels up. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** The pre-bridge overlay for the single host-graph row (byte-exact mirror of
 *  host-graph-seed.test.ts's EXPECTED_OVERLAY): what a disabled switch must
 *  still produce, unchanged. */
const EXPECTED_GRAPH_ONLY_OVERLAY = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-chamber-seed-client-graph'
`

/** The same overlay with the opt-in bridge row appended (registry rows first). */
const EXPECTED_BRIDGE_OVERLAY = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-chamber-seed-client-graph'
    - id: host-log-bridge
      name: '@dsh-chamber/dsh-chamber-seed-host-log-bridge'
`

/** A managed profile whose own user patch layer carries `patchContent`. */
function writeLocalProfileFixture(dir: string, patchContent: string | null): string {
  const dshHome = join(dir, 'dsh-home')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
  }))
  if (patchContent !== null) writeFileSync(join(profileDir, 'cordis.patch.yml'), patchContent)
  return dshHome
}

/** A built host-graph source dir (package.json + dist/index.js). */
function writeBuiltSeedSource(dir: string): string {
  const sourceDir = join(dir, 'built-seed-source')
  mkdirSync(join(sourceDir, 'dist'), { recursive: true })
  writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ name: HOST_GRAPH_PACKAGE_NAME }))
  writeFileSync(join(sourceDir, 'dist', 'index.js'), 'export const graph = 1\n')
  return sourceDir
}

function graphEntry(sourceDir: string) {
  return {
    insert: HOST_GRAPH_INSERT,
    kind: 'host' as const,
    source: 'packaged' as const,
    sourceDir,
    probeDomains: [] as readonly string[],
  }
}

/** The seeded profile location of the generated bridge package. */
function bridgeSeedTarget(dshHome: string): string {
  return join(dshHome, 'profiles', 'web', 'node_modules', HOST_LOG_BRIDGE_PACKAGE_NAME)
}

// ---------------------------------------------------------------------------
// parseHostLogBridgeEnv — the switch itself
// ---------------------------------------------------------------------------

test('switch: unset and the off-family values leave the bridge disabled', () => {
  for (const raw of [undefined, '', '   ', 'off', 'OFF', 'false', '0', 'no']) {
    const setting = parseHostLogBridgeEnv(raw)
    assert.equal(setting.enabled, false, `${JSON.stringify(raw)} must not enable the bridge`)
    assert.equal(setting.levelName, DEFAULT_HOST_LOG_BRIDGE_LEVEL)
    assert.equal(setting.unrecognized, undefined)
  }
})

test('switch: level names map to the cordis verbosity thresholds', () => {
  assert.deepEqual(
    { error: HOST_LOG_BRIDGE_LEVELS.error, info: HOST_LOG_BRIDGE_LEVELS.info, warn: HOST_LOG_BRIDGE_LEVELS.warn, debug: HOST_LOG_BRIDGE_LEVELS.debug },
    { error: 0, info: 1, warn: 2, debug: 3 },
  )
  for (const [name, level] of Object.entries(HOST_LOG_BRIDGE_LEVELS)) {
    const setting = parseHostLogBridgeEnv(name.toUpperCase())
    assert.equal(setting.enabled, true)
    assert.equal(setting.levelName, name)
    assert.equal(setting.level, level)
    assert.equal(setting.unrecognized, undefined)
  }
})

test('switch: enable tokens and unrecognized values fall back to the conservative default, never debug', () => {
  for (const raw of ['on', 'true', '1', 'yes']) {
    const setting = parseHostLogBridgeEnv(raw)
    assert.equal(setting.enabled, true)
    assert.equal(setting.levelName, DEFAULT_HOST_LOG_BRIDGE_LEVEL)
    assert.equal(setting.level, HOST_LOG_BRIDGE_LEVELS.warn)
    assert.notEqual(setting.levelName, 'debug')
    assert.equal(setting.unrecognized, undefined)
  }
  const typo = parseHostLogBridgeEnv('verbose')
  assert.equal(typo.enabled, true, 'a typo enables at the conservative default instead of silently disabling forensics')
  assert.equal(typo.levelName, DEFAULT_HOST_LOG_BRIDGE_LEVEL)
  assert.equal(typo.unrecognized, 'verbose', 'the caller warns loudly about the substituted value')
})

// ---------------------------------------------------------------------------
// planHostLogBridge — disabled writes nothing, enabled materializes the entry
// ---------------------------------------------------------------------------

test('plan: a disabled switch writes no generated package and returns no entry', () => {
  const dir = tempDir()
  const warn: string[] = []
  for (const env of [{}, { [HOST_LOG_BRIDGE_ENV]: '' }, { [HOST_LOG_BRIDGE_ENV]: 'off' }]) {
    assert.equal(planHostLogBridge({ stateDir: dir, env, warn: message => warn.push(message) }), null)
  }
  assert.equal(warn.length, 0, 'a disabled switch is silent, not a warning')
  assert.equal(existsSync(join(dir, HOST_LOG_BRIDGE_SOURCE_DIRNAME)), false)
})

test('plan: an enabled switch materializes the canonical seed entry and the generated plugin', () => {
  const dir = tempDir()
  const entry = planHostLogBridge({ stateDir: dir, env: { [HOST_LOG_BRIDGE_ENV]: 'debug' } })
  assert.ok(entry !== null)
  assert.deepEqual(entry.insert, HOST_LOG_BRIDGE_INSERT)
  assert.equal(entry.kind, 'host')
  assert.equal(entry.source, 'packaged')
  assert.deepEqual(entry.probeDomains, [], 'the bridge backs no activation-probe domain')
  assert.equal(entry.sourceDir, join(dir, HOST_LOG_BRIDGE_SOURCE_DIRNAME))

  const manifest = JSON.parse(readFileSync(join(entry.sourceDir as string, 'package.json'), 'utf8'))
  assert.equal(manifest.name, HOST_LOG_BRIDGE_PACKAGE_NAME)
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, 'dist/index.js')
  const source = readFileSync(join(entry.sourceDir as string, 'dist', 'index.js'), 'utf8')
  assert.match(source, /const LEVEL = 3\b/, 'the level is baked in — the child needs no environment')
  assert.match(source, /const LEVEL_NAME = 'debug'/)
  assert.equal(statSync(join(entry.sourceDir as string, 'dist', 'index.js')).mode & 0o777, 0o600)
})

test('plan: an unrecognized value warns loudly and still uses the conservative level', () => {
  const dir = tempDir()
  const warn: string[] = []
  const entry = planHostLogBridge({ stateDir: dir, env: { [HOST_LOG_BRIDGE_ENV]: 'trace' }, warn: message => warn.push(message) })
  assert.ok(entry !== null)
  assert.equal(warn.length, 1)
  assert.match(warn[0] as string, /"trace" is not a level name/)
  assert.match(readFileSync(join(entry.sourceDir as string, 'dist', 'index.js'), 'utf8'), /const LEVEL = 2\b/)
})

test('plan: an in-sync generated package is not rewritten; a level change is', () => {
  const dir = tempDir()
  const modulePath = join(dir, HOST_LOG_BRIDGE_SOURCE_DIRNAME, 'dist', 'index.js')
  planHostLogBridge({ stateDir: dir, env: { [HOST_LOG_BRIDGE_ENV]: 'warn' } })
  const before = statSync(modulePath)
  const directoryBefore = statSync(join(dir, HOST_LOG_BRIDGE_SOURCE_DIRNAME, 'dist'))
  planHostLogBridge({ stateDir: dir, env: { [HOST_LOG_BRIDGE_ENV]: 'warn' } })
  const after = statSync(modulePath)
  // Atomic publication is tmp+rename, so a rewrite would move the inode, the
  // file mtime and the parent directory mtime — a no-op leaves all three.
  assert.equal(after.ino, before.ino, 'unchanged content must not churn the generated file')
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.equal(statSync(join(dir, HOST_LOG_BRIDGE_SOURCE_DIRNAME, 'dist')).mtimeMs, directoryBefore.mtimeMs)
  planHostLogBridge({ stateDir: dir, env: { [HOST_LOG_BRIDGE_ENV]: 'error' } })
  assert.match(readFileSync(modulePath, 'utf8'), /const LEVEL = 0\b/, 'a level change rewrites the plugin')
})

test('source: the module generator refuses out-of-range input', () => {
  assert.throws(() => hostLogBridgeModuleSource(4, 'debug'), /invalid level/)
  assert.throws(() => hostLogBridgeModuleSource(-1, 'error'), /invalid level/)
  assert.throws(() => hostLogBridgeModuleSource(1, 'trace' as never), /invalid level name/)
})

test('source: an enabled source dir is exactly what ensureSeedPackage consumes', () => {
  const dir = tempDir()
  const sourceDir = ensureHostLogBridgeSource(dir, parseHostLogBridgeEnv('info'))
  assert.equal(sourceDir, join(dir, HOST_LOG_BRIDGE_SOURCE_DIRNAME))
  assert.equal(existsSync(join(sourceDir, 'package.json')), true)
  assert.equal(existsSync(join(sourceDir, 'dist', 'index.js')), true)
})

// ---------------------------------------------------------------------------
// resolveLocalHostGraphOverlay — off is byte-identical, on adds exactly one row
// ---------------------------------------------------------------------------

test('overlay: the switch is off by default even when the AMBIENT environment sets it', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const sourceDir = writeBuiltSeedSource(dir)
  const previous = process.env[HOST_LOG_BRIDGE_ENV]
  process.env[HOST_LOG_BRIDGE_ENV] = 'debug'
  try {
    // No `env` input: a synthetic caller can never pick up the ambient shell.
    const overlay = resolveLocalHostGraphOverlay({
      stateDir: dir,
      dshHome,
      entries: [graphEntry(sourceDir)],
      log() {},
      warn() {},
    })
    assert.equal(overlay, join(dir, HOST_GRAPH_PATCH_FILENAME))
    assert.equal(readFileSync(overlay as string, 'utf8'), EXPECTED_GRAPH_ONLY_OVERLAY)
    assert.equal(existsSync(join(dir, HOST_LOG_BRIDGE_SOURCE_DIRNAME)), false)
    assert.equal(existsSync(bridgeSeedTarget(dshHome)), false)
  } finally {
    if (previous === undefined) delete process.env[HOST_LOG_BRIDGE_ENV]
    else process.env[HOST_LOG_BRIDGE_ENV] = previous
  }
})

test('overlay: an enabled switch appends the bridge row and seeds the package, leaving the other rows alone', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const sourceDir = writeBuiltSeedSource(dir)
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    entries: [graphEntry(sourceDir)],
    log() {},
    warn() {},
    env: { [HOST_LOG_BRIDGE_ENV]: 'warn' },
  })
  assert.equal(overlay, join(dir, HOST_GRAPH_PATCH_FILENAME))
  assert.equal(readFileSync(overlay as string, 'utf8'), EXPECTED_BRIDGE_OVERLAY)
  // The graph seed is untouched, and the bridge package was seeded like any
  // other host seed (the profile's node_modules anchor the loader row resolves).
  assert.equal(existsSync(join(dshHome, 'profiles', 'web', 'node_modules', HOST_GRAPH_PACKAGE_NAME, 'dist', 'index.js')), true)
  const seededModule = join(bridgeSeedTarget(dshHome), 'dist', 'index.js')
  assert.equal(existsSync(seededModule), true)
  assert.match(readFileSync(seededModule, 'utf8'), /const LEVEL = 2\b/)
  const seededManifest = JSON.parse(readFileSync(join(bridgeSeedTarget(dshHome), 'package.json'), 'utf8'))
  assert.equal(seededManifest.name, HOST_LOG_BRIDGE_PACKAGE_NAME)
})

test('overlay: the bridge alone still yields an overlay when no other seed is available', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    entries: [],
    log() {},
    warn() {},
    env: { [HOST_LOG_BRIDGE_ENV]: 'error' },
  })
  assert.equal(overlay, join(dir, HOST_GRAPH_PATCH_FILENAME))
  assert.equal(readFileSync(overlay as string, 'utf8'), `- insert:
    - id: host-log-bridge
      name: '@dsh-chamber/dsh-chamber-seed-host-log-bridge'
`)
})

test('overlay: a user-owned bridge row is reused (no duplicate id) and the package is still seeded', t => {
  const dir = tempDir(t)
  const userPatch = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-chamber-seed-client-graph'
    - id: host-log-bridge
      name: '@dsh-chamber/dsh-chamber-seed-host-log-bridge'
`
  const dshHome = writeLocalProfileFixture(dir, userPatch)
  const sourceDir = writeBuiltSeedSource(dir)
  const stale = join(dir, HOST_GRAPH_PATCH_FILENAME)
  writeFileSync(stale, EXPECTED_BRIDGE_OVERLAY)
  const overlay = resolveLocalHostGraphOverlay({
    stateDir: dir,
    dshHome,
    entries: [graphEntry(sourceDir)],
    log() {},
    warn() {},
    env: { [HOST_LOG_BRIDGE_ENV]: 'debug' },
  })
  assert.equal(overlay, null, 'every row is already user-owned — no --patch is passed')
  assert.equal(existsSync(stale), false, 'the leftover overlay is cleared')
  assert.equal(existsSync(join(bridgeSeedTarget(dshHome), 'dist', 'index.js')), true,
    'the user-owned row still needs its package on disk')
})

test('overlay: turning the switch back off removes the row and restores the previous overlay bytes', t => {
  const dir = tempDir(t)
  const dshHome = writeLocalProfileFixture(dir, '# user layer\n[]\n')
  const sourceDir = writeBuiltSeedSource(dir)
  const on = resolveLocalHostGraphOverlay({
    stateDir: dir, dshHome, entries: [graphEntry(sourceDir)], log() {}, warn() {},
    env: { [HOST_LOG_BRIDGE_ENV]: 'warn' },
  })
  assert.equal(readFileSync(on as string, 'utf8'), EXPECTED_BRIDGE_OVERLAY)
  const off = resolveLocalHostGraphOverlay({
    stateDir: dir, dshHome, entries: [graphEntry(sourceDir)], log() {}, warn() {},
    env: {},
  })
  assert.equal(off, join(dir, HOST_GRAPH_PATCH_FILENAME))
  assert.equal(readFileSync(off as string, 'utf8'), EXPECTED_GRAPH_ONLY_OVERLAY)
})

// ---------------------------------------------------------------------------
// The generated plugin, mounted for real with an injected host context
// ---------------------------------------------------------------------------

/** A stand-in for the host's own Logger facade — only `static format` is used. */
class FakeHostLogger {
  static format(exporter: { maxLength: number }, message: { args: unknown[] }): string {
    return `fmt(${exporter.maxLength}):${message.args.map(value => String(value)).join('|')}`
  }
}

/** An injected Cordis-like context that models the PINNED host contract exactly
 *  (vendor/harness-checkout/vendor/cordis/src/logger.ts, asserted by the
 *  cordis-contract test below):
 *    - `exporters` is a public `Map<number, sink>`;
 *    - `exporter(sink)` registers under an incrementing counter and returns
 *      `() => exporters.delete(this._snExporter)` — the CURRENT counter, NOT the
 *      registration's own id, so that disposer removes whichever exporter
 *      registered LAST (the upstream identity bug the bridge works around);
 *    - `ctx.effect()` owns whatever the plugin returns for its fiber's lifetime.
 *  `unmount()` plays the fiber unload; `remount()` plays a same-fiber reload
 *  (`Fiber.update` → the effect disposes, then the body re-runs with the SAME
 *  ctx) — the case that used to leave the bridge silently dead. */
function fakeHostContext(): { ctx: unknown; sinks: () => any[]; unmount: () => void } {
  const exporters = new Map<number, unknown>()
  const disposers: Array<() => void> = []
  let counter = 0
  const list = () => [...exporters.values()]
  const logger = Object.assign(
    (_name?: string) => new FakeHostLogger(),
    {
      exporters,
      exporter: (exporter: unknown) => {
        exporters.set(++counter, exporter)
        return () => { exporters.delete(counter) }
      },
    },
  )
  const ctx = {
    logger,
    effect: (execute: () => (() => void) | undefined) => {
      const off = execute()
      if (typeof off === 'function') disposers.push(off)
      return off
    },
  }
  return {
    ctx,
    sinks: list,
    // Plays the fiber unload (and, called twice, a same-fiber reload: the effect
    // disposes, then the plugin body re-runs with the SAME ctx).
    unmount: () => { for (const off of disposers.splice(0).reverse()) off() },
  }
}

/** Run `fn` with process.stderr.write captured; returns everything written. */
function withStderrCapture(fn: () => void): string {
  const original = process.stderr.write
  let captured = ''
  process.stderr.write = ((chunk: unknown) => { captured += String(chunk); return true }) as unknown as typeof process.stderr.write
  try {
    fn()
  } finally {
    process.stderr.write = original
  }
  return captured
}

/** Materialize + dynamically import the generated plugin (a real ESM load). */
async function loadGeneratedPlugin(levelName: 'error' | 'info' | 'warn' | 'debug', stateDir: string) {
  const sourceDir = ensureHostLogBridgeSource(stateDir, parseHostLogBridgeEnv(levelName))
  const module = await import(pathToFileURL(join(sourceDir, 'dist', 'index.js')).href)
  return module.default as (ctx: unknown) => void
}

test('plugin: mounting registers one exporter at the baked level and announces itself on stderr', async t => {
  const dir = tempDir(t)
  const plugin = await loadGeneratedPlugin('warn', dir)
  const host = fakeHostContext()
  const announce = withStderrCapture(() => {
    plugin(host.ctx)
    plugin(host.ctx) // a double mount (HMR remount / duplicate row) must not duplicate lines
  })
  const mounted = host.sinks()
  assert.equal(mounted.length, 1)
  assert.equal(mounted[0].levels.default, HOST_LOG_BRIDGE_LEVELS.warn)
  assert.equal(mounted[0].colors, 0)
  assert.match(announce, /\[chamber\] host log bridge active \(level=warn\)\n/)
})

test('plugin: a loader remount replaces the exporter instead of stacking a second one', async t => {
  const dir = tempDir(t)
  const plugin = await loadGeneratedPlugin('warn', dir)
  const first = fakeHostContext()
  withStderrCapture(() => plugin(first.ctx))
  assert.equal(first.sinks().length, 1)
  // The managed profile runs `patchReload: 'live'`: the loader disposes the old
  // fiber and mounts the plugin again on a NEW context. LoggerService.exporter()
  // registers its effect on the ROOT context, so only the plugin's own effect
  // can remove that registration — without it the previous exporter keeps
  // writing, and every application line reaches stderr twice.
  first.unmount()
  assert.equal(first.sinks().length, 0, 'unloading the plugin fiber removes its exporter')
  const second = fakeHostContext()
  withStderrCapture(() => plugin(second.ctx))
  assert.equal(second.sinks().length, 1, 'exactly one exporter per live mount')
})

test('plugin: a SAME-FIBER reload re-mounts the exporter (Fiber.update re-runs the body)', async t => {
  const dir = tempDir(t)
  const plugin = await loadGeneratedPlugin('warn', dir)
  const host = fakeHostContext()
  withStderrCapture(() => plugin(host.ctx))
  assert.equal(host.sinks().length, 1)
  // A same-fiber reload disposes the effect and then re-runs the plugin body with
  // the SAME ctx (loader entry.ts on a config-only diff). Marking ownership
  // OUTSIDE the effect used to suppress the re-mount, silently killing the
  // bridge: the effect's own disposer clears the mark.
  host.unmount()
  assert.equal(host.sinks().length, 0)
  withStderrCapture(() => plugin(host.ctx))
  assert.equal(host.sinks().length, 1, 'the re-mount must not be suppressed by a stale guard')
})

test('plugin: unloading removes OUR exporter even when another one registered later', async t => {
  const dir = tempDir(t)
  const plugin = await loadGeneratedPlugin('warn', dir)
  const host = fakeHostContext()
  withStderrCapture(() => plugin(host.ctx))
  const ours = host.sinks()[0]
  // The pinned cordis disposer deletes the CURRENT counter entry, so it would
  // remove the LATER exporter and leave ours installed (double lines on the next
  // mount). The bridge removes its own entry by identity instead.
  const later = { export() {} }
  ;(host.ctx as { logger: { exporter: (sink: unknown) => unknown } }).logger.exporter(later)
  assert.equal(host.sinks().length, 2)
  host.unmount()
  const left = host.sinks()
  assert.equal(left.length, 1, 'exactly the other exporter must survive')
  assert.equal(left[0], later, 'our identity-based removal must not take the later exporter')
  assert.ok(!left.includes(ours), 'our exporter must be gone')
})

test('plugin: exported messages are rendered by the host formatter and written per line', async t => {
  const dir = tempDir(t)
  const plugin = await loadGeneratedPlugin('debug', dir)
  const host = fakeHostContext()
  withStderrCapture(() => plugin(host.ctx))
  const out = withStderrCapture(() => {
    host.sinks()[0].export({ name: 'session', args: ['session opened', 'id=7'], level: 1 })
    host.sinks()[0].export({ name: 'remote', args: ['first\nsecond'], level: 3 })
  })
  // One write per rendered line (a multi-line message becomes two stderr
  // lines, i.e. two JSONL entries) — the real Logger.format keeps the
  // newlines and prefixes nothing per line, exactly like this fake.
  assert.equal(out, 'fmt(8192):session opened|id=7\nfmt(8192):first\nsecond\n')
})

test('plugin: an error argument renders its stack instead of an object dump', async t => {
  const dir = tempDir(t)
  const plugin = await loadGeneratedPlugin('error', dir)
  const host = fakeHostContext()
  withStderrCapture(() => plugin(host.ctx))
  const out = withStderrCapture(() => {
    host.sinks()[0].export({ name: 'app', args: [new Error('boom')], level: 0 })
  })
  assert.match(out, /fmt\(8192\):Error: boom/)
})

test('plugin: a host without the Logger formatter still forwards (fallback renderer)', async t => {
  const dir = tempDir(t)
  const plugin = await loadGeneratedPlugin('info', dir)
  const exporters: any[] = []
  const bareLogger = Object.assign(() => ({}), {
    exporter: (exporter: unknown) => { exporters.push(exporter); return () => {} },
  })
  const out = withStderrCapture(() => {
    plugin({ logger: bareLogger })
    exporters[0].export({ name: 'app', args: ['plain', { k: 1 }], level: 1 })
  })
  assert.equal(out, '[chamber] host log bridge active (level=info)\nplain {"k":1}\n')
})

test('plugin: a broken host context never throws out of the mount', async t => {
  const dir = tempDir(t)
  const plugin = await loadGeneratedPlugin('warn', dir)
  withStderrCapture(() => {
    assert.doesNotThrow(() => plugin({}))
    assert.doesNotThrow(() => plugin(null))
  })
})

/**
 * The strongest available check: mount the generated plugin on the REAL pinned
 * Cordis Context and drive its LoggerService, proving the baked `levels.default`
 * is the threshold the host actually applies (error 0 / info 1 / warn 2 /
 * debug 3) and that `Logger.format` renders the placeholders.
 *
 * Self-skips when `@deepseek-ai/cordis` is not resolvable (the vendored harness
 * tree is a preinstall-linked workspace member; a bare control-plane checkout
 * without it must not fail here).
 */
/**
 * The three Cordis logger facts the generated plugin is written against, read
 * from the PINNED vendor source. This half cannot skip: `@deepseek-ai/cordis`
 * is deliberately not a dependency of this package (the managed host resolves
 * it from its own profile), so an import-based check self-skips in every CI
 * tree and would leave the API bet unenforced (2026-12 review). Reading the
 * vendored signature is the same discipline the activation-probe lockstep uses
 * (`packages/dsh-runtime/test/runtime-probes.test.ts`).
 */
test('cordis contract: the pinned LoggerService still matches what the generated plugin calls', () => {
  const source = readFileSync(
    join(repoRoot, 'vendor', 'harness-checkout', 'vendor', 'cordis', 'src', 'logger.ts'),
    'utf8',
  )
  // (1) exporter() registers through the SERVICE's own ctx.effect and returns
  // that disposer. The service ctx is the app root (`self.ctx = ctx` in the
  // constructor), NOT the calling plugin's fiber — which is exactly why the
  // generated plugin re-owns the registration through its own ctx.effect.
  assert.match(source, /self\.ctx = ctx/, 'the logger service must still bind the ctx it was constructed with')
  const exporterBody = source.match(/exporter\(exporter: Exporter\)\s*\{([\s\S]*?)\n {2}\}/)
  assert.ok(exporterBody !== null, 'LoggerService.exporter(exporter) must still exist')
  assert.match(exporterBody![1]!, /return this\.ctx\.effect\(/, 'exporter() must register through this.ctx.effect and return its disposer')
  assert.match(exporterBody![1]!, /exporters\.delete\(/, 'the returned disposer must remove the registration')
  // (2) the generated plugin renders through the facade's static formatter and
  // passes `{ colors: 0, maxLength }`; both options must stay supported.
  assert.match(source, /static format\(exporter: Exporter, message: Message\): string \{/, 'Logger.format(exporter, message) must stay a static method')
  assert.match(source, /const \{ maxLength = \d+ \} = exporter/, 'the exporter maxLength option must still bound each line')
  // (3) the baked threshold is read from `levels.default` and a message is
  // exported when its level is at or below the threshold.
  assert.match(source, /exporter\.levels\?\.\[this\.name\] \?\? exporter\.levels\?\.default/, 'the per-exporter threshold must still fall back to levels.default')
  assert.match(source, /if \(targetLevel < level\) continue/, 'the threshold must still mean "export when level <= targetLevel"')
})

test('real cordis (optional leg): the host LoggerService honors the baked level', async t => {
  let Context: new () => any
  let LoggerService: any
  try {
    // The dynamic import is cast through a local face on purpose: this repo's
    // typecheck deliberately excludes the vendored dsh packages and types each
    // specifier with a loose ambient stub (see the vendor-modules.d.ts files),
    // so the members visible here depend on which surface resolves in a given
    // tree (bare checkout vs materialized vendor). Reading them through the
    // declared module type would make the file typecheck only in one of them;
    // the runtime shape is asserted below instead. The contract half above is
    // the leg CI enforces — this one only adds a live mount where resolvable.
    const cordis = (await import('@deepseek-ai/cordis')) as unknown as {
      Context?: new () => any
      LoggerService?: unknown
    }
    Context = cordis.Context as never
    LoggerService = cordis.LoggerService
  } catch {
    t.skip('@deepseek-ai/cordis is not resolvable in this tree (the contract test above still ran)')
    return
  }
  assert.equal(typeof LoggerService, 'function', 'the pinned runtime still ships the built-in logger')

  const emittedAt = async (levelName: 'error' | 'warn' | 'debug'): Promise<string> => {
    const dir = tempDir(t)
    const plugin = await loadGeneratedPlugin(levelName, dir)
    const ctx = new Context()
    const fiber = ctx.plugin(plugin)
    await fiber
    await new Promise(resolve => setTimeout(resolve, 0))
    const captured = withStderrCapture(() => {
      ctx.logger.error('an %s happened', 'error')
      ctx.logger.info('an %s happened', 'info')
      ctx.logger.warn('an %s happened', 'warn')
      ctx.logger.debug('an %s happened', 'debug')
    })
    await ctx.fiber.dispose()
    return captured
  }

  const atError = await emittedAt('error')
  assert.match(atError, /an error happened/, 'errors are always exported')
  assert.doesNotMatch(atError, /an info happened/)

  const atWarn = await emittedAt('warn')
  assert.match(atWarn, /an info happened/)
  assert.match(atWarn, /an warn happened/)
  assert.doesNotMatch(atWarn, /an debug happened/, 'the conservative default never carries debug')

  const atDebug = await emittedAt('debug')
  assert.match(atDebug, /an debug happened/)
  assert.match(atDebug, /host log bridge active \(level=debug\)/)
})

// ---------------------------------------------------------------------------
// End of the pipeline: redaction + rolling log keep the {"ts","stream","line"} shape
// ---------------------------------------------------------------------------

test('pipeline: bridge output is redacted and lands in host-logs as {"ts","stream","line"}', async t => {
  const dir = tempDir(t)
  const plugin = await loadGeneratedPlugin('info', dir)
  const host = fakeHostContext()
  withStderrCapture(() => plugin(host.ctx))
  const leaked = withStderrCapture(() => {
    host.sinks()[0].export({
      name: 'connection',
      args: ['open http://127.0.0.1:30800/?token=SEKRET&keep=1 failed'],
      level: 1,
    })
  })
  assert.match(leaked, /token=SEKRET/, 'the sink itself receives the raw line …')

  // … and the production gate masks it before anything is persisted.
  assert.equal(
    redactChildOutputLine(leaked.trimEnd()),
    'fmt(8192):open http://127.0.0.1:30800/?token=***&keep=1 failed',
  )

  const stateDir = tempDir(t)
  const port = 17593
  const writer = createHostLogWriter(stateDir, port)
  for (const line of leaked.split('\n')) {
    if (line !== '') writer.write(redactChildOutputLine(line), 'stderr')
  }
  await writer.close()

  const onDisk = readFileSync(logPathFor(stateDir, port), 'utf8').trim()
  assert.deepEqual(Object.keys(JSON.parse(onDisk)).sort(), ['line', 'stream', 'ts'],
    'the persisted entry keeps exactly the ts/stream/line shape')

  const result = await readLogTail(logPathFor(stateDir, port), { limit: 10, offset: 0 })
  assert.equal(result.lines.length, 1)
  assert.equal(result.lines[0]?.stream, 'stderr', 'application lines are captured on the stderr stream')
  assert.equal(typeof result.lines[0]?.ts, 'string')
  assert.equal(result.lines[0]?.line.includes('SEKRET'), false)
  assert.equal(result.lines[0]?.line.includes('token=***'), true)
  assert.equal(result.lines[0]?.line.includes('&keep=1'), true)
})

test('pipeline: the &token= form is masked too (no credential shape slips through)', () => {
  assert.equal(redactChildOutputLine('wss://h/api?x=1&token=abc.def-ghi&y=2'), 'wss://h/api?x=1&token=***&y=2')
  assert.equal(redactChildOutputLine('token=noleadingmarker'), 'token=noleadingmarker')
})
