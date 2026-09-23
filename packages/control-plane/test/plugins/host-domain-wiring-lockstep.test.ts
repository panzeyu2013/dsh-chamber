/**
 * Chamber host-domain wiring lockstep (audit arch-03 P1-1).
 *
 * CHAMBER_HOST_PACKAGES (src/host-graph-seed.ts) is the single source for each
 * domain's IDENTITY (loader insert id/name + probe method/args). Making a new
 * domain actually reach all three delivery paths — the local profile seed, the
 * ssh remote + gateway upload, and the activation probes — additionally needs
 * six hand-registered wire-ups, and three of them used to skip silently for a
 * missing row. This suite drives every assertion from the registry itself, so a
 * new domain that is not wired everywhere is RED:
 *
 *   ① the three sourceDir registrations cover every registry row:
 *      ①a the Swift map (sidecar-ctx.ts chamberHostSourceDirsFor) is called for
 *          real and must key every non-localOnly registry package;
 *      ①b a synthetic new non-localOnly row without a resolver throws, naming
 *          the domain and the missing sourceDir key;
 *      ①c the Electron map literal (main.ts chamberHostSourceDirs) keys every
 *          non-localOnly registry package (and exactly those — a localOnly row
 *          must stay absent from the remote map);
 *      ①d the control-plane local seed map (src/index.ts hostPackageSourceDirs)
 *          keys every registry insert id, localOnly included.
 *   ② dsh-runtime's activation contract covers every registry probe domain:
 *      HOST_DOMAIN_PROBE_NAMES is set-EQUAL to the registry domains (complete,
 *      localOnly included) and REQUIRED_ACTIVATION_PROBES carries them all.
 *   ③ runtime-probes.ts closes a real branch per domain: each registry domain,
 *      run ALONE through the real runRuntimeActivationProbes, must issue exactly
 *      one RPC carrying the registry-pinned method/args and return its own row
 *      (never the "probe not wired" fallback that a missing
 *      wantsDomain/name/byName registration produces).
 *   ④/⑤ the remote seed constructor (plugin-sync.ts chamberHostPackageSeedsFrom)
 *      and its built-artifact filter: a non-localOnly row without a sourceDir
 *      key THROWS; only an existsSync-missing dist/index.js may skip.
 *   ⑥ the superseded official open-in wire face (audit arch-03 P2-3): the
 *      vendored web bundle still mounts the official host row this local
 *      overlay disables, and NO chamber production source calls its
 *      `/open-in-app/*` routes (the renderer page-own-skips the official client
 *      row, so a caller would create a second live wire authority).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as hostGraphSeedModule from '../../src/host-graph-seed.ts'
import {
  CHAMBER_HOST_PACKAGES,
  OFFICIAL_OPEN_IN_DISABLE,
  type ChamberHostPackageDescriptor,
} from '../../src/host-graph-seed.ts'
import {
  HOST_DOMAIN_PROBE_NAMES,
  REQUIRED_ACTIVATION_PROBES,
  activationProbeNamesForDomains,
} from '../../../dsh-runtime/src/activation-gate.ts'
import { runRuntimeActivationProbes, type RuntimeProbeCall } from '../../../dsh-runtime/src/runtime-probes.ts'
import * as pluginSyncModule from '../../../desktop/plugin-sync.ts'
import {
  builtChamberHostPackageSeeds,
  chamberHostPackageSeedsFrom,
  type ChamberHostPackageSeed,
} from '../../../desktop/plugin-sync.ts'
import { chamberHostSourceDirsFor } from '../../../desktop/sidecar-ctx.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

/** Every registry probe domain, in registry order. */
const ALL_DOMAINS = CHAMBER_HOST_PACKAGES.map(descriptor => descriptor.probe.method)
/** The rows that must exist on a REMOTE instance / gateway (design 20 §6). */
const REMOTE_PACKAGES = CHAMBER_HOST_PACKAGES.filter(descriptor => descriptor.localOnly !== true)
const LOCAL_ONLY_PACKAGES = CHAMBER_HOST_PACKAGES.filter(descriptor => descriptor.localOnly === true)
/** The Swift flavor's explicit host dirs; null = the named default resolution. */
const NO_EXPLICIT_DIRS = { graph: null, git: null, archive: null, openIn: null }
/** A synthetic next registry row: non-localOnly, no resolver, no sourceDir key. */
const GHOST_DESCRIPTOR: ChamberHostPackageDescriptor = {
  insert: { id: 'ghost-domain', name: '@dsh-chamber/dsh-chamber-seed-ghost-domain' },
  probe: { method: 'ghost/probe', args: {} },
}

test('①a the Swift sidecar sourceDir map is registry-driven and covers every non-localOnly domain', () => {
  const map = chamberHostSourceDirsFor(NO_EXPLICIT_DIRS, join(REPO_ROOT, 'packages', 'desktop'))
  assert.deepEqual(
    Object.keys(map).sort(),
    REMOTE_PACKAGES.map(descriptor => descriptor.insert.name).sort(),
    'every non-localOnly registry row owns exactly one sourceDir key',
  )
  for (const descriptor of REMOTE_PACKAGES) {
    const dir = map[descriptor.insert.name]
    assert.ok(typeof dir === 'string' && dir !== '', descriptor.insert.name + ' must resolve to a directory')
  }
})

test('①b a new non-localOnly row with no sidecar resolver throws, naming the domain and the sourceDir key', () => {
  assert.throws(
    () => chamberHostSourceDirsFor(NO_EXPLICIT_DIRS, REPO_ROOT, [...CHAMBER_HOST_PACKAGES, GHOST_DESCRIPTOR]),
    (error: unknown) => error instanceof Error
      && error.message.includes(GHOST_DESCRIPTOR.insert.name)
      && error.message.includes('sourceDir 键'),
    'the Swift map must never silently skip a non-localOnly registry row',
  )
})

test('①c the Electron main.ts sourceDir map names every non-localOnly registry domain', () => {
  const mainSource = readFileSync(join(REPO_ROOT, 'packages', 'desktop', 'main.ts'), 'utf8')
  const block = /const chamberHostSourceDirs: Record<string, string> = \{([\s\S]*?)\n\s*\};/u.exec(mainSource)
  assert.ok(block !== null, 'main.ts must keep the chamberHostSourceDirs map literal')
  const exported = pluginSyncModule as unknown as Record<string, unknown>
  for (const descriptor of REMOTE_PACKAGES) {
    // The desktop constant convention: <LOADER_ID_UPPER>_PACKAGE_NAME.
    const key = descriptor.insert.id.toUpperCase().replace(/-/gu, '_') + '_PACKAGE_NAME'
    assert.equal(exported[key], descriptor.insert.name, key + ' must name the registry package ' + descriptor.insert.name)
    assert.match(block[1], new RegExp('\\[' + key + '\\]:'), 'main.ts must key the Electron map by ' + key)
  }
  const keyed = block[1].match(/\[[A-Z0-9_]+\]:/gu) ?? []
  assert.equal(
    keyed.length,
    REMOTE_PACKAGES.length,
    'the Electron map carries exactly the non-localOnly rows (a localOnly row must stay absent from the remote map)',
  )
  assert.ok(LOCAL_ONLY_PACKAGES.length > 0, 'the registry must still carry its localOnly row for this pin to mean anything')
})

test('①d the control-plane local seed map keys every registry row (localOnly included)', () => {
  const indexSource = readFileSync(join(REPO_ROOT, 'packages', 'control-plane', 'src', 'index.ts'), 'utf8')
  const block = /const hostPackageSourceDirs: ReadonlyMap<string, string> = new Map\(\[([\s\S]*?)\n\s*\]\)/u.exec(indexSource)
  assert.ok(block !== null, 'index.ts must keep the hostPackageSourceDirs map literal')
  const identifiers = [...block[1].matchAll(/\[([A-Z0-9_]+)\.id,/gu)].map(match => match[1])
  assert.equal(
    identifiers.length,
    CHAMBER_HOST_PACKAGES.length,
    'the local seed map carries exactly one source dir per registry row',
  )
  const exported = hostGraphSeedModule as unknown as Record<string, unknown>
  const mappedIds = identifiers.map(identifier => {
    const insert = exported[identifier]
    assert.ok(
      insert !== null && typeof insert === 'object' && 'id' in insert,
      identifier + ' must be a HostPackageInsert exported by host-graph-seed.ts',
    )
    return (insert as { id: string }).id
  })
  assert.deepEqual(
    mappedIds.sort(),
    CHAMBER_HOST_PACKAGES.map(descriptor => descriptor.insert.id).sort(),
    'the local seed map must key every registry insert id (localOnly included: the LOCAL profile seeds open-in)',
  )
})

test('② dsh-runtime activation contract covers every registry probe domain', () => {
  assert.deepEqual(
    [...HOST_DOMAIN_PROBE_NAMES].sort(),
    [...ALL_DOMAINS].sort(),
    'HOST_DOMAIN_PROBE_NAMES must stay set-equal to the registry domains (complete, localOnly included)',
  )
  for (const domain of ALL_DOMAINS) {
    assert.ok(
      (REQUIRED_ACTIVATION_PROBES as readonly string[]).includes(domain),
      domain + ' must be a REQUIRED_ACTIVATION_PROBES member',
    )
  }
  assert.equal(
    new Set(REQUIRED_ACTIVATION_PROBES).size,
    REQUIRED_ACTIVATION_PROBES.length,
    'a duplicated REQUIRED probe name would break the exact-set activation verdict',
  )
  assert.deepEqual(
    [...activationProbeNamesForDomains(ALL_DOMAINS)],
    [...REQUIRED_ACTIVATION_PROBES],
    'the full registry domain list must derive exactly the REQUIRED set',
  )
})

/** Canonical carrier answer per registry probe method (the shape runtime-probes accepts). */
const CANONICAL_DOMAIN_VALUE: Record<string, unknown> = {
  'clientGraph/graph': { rev: 1, entries: [] },
  'gitWorktree/previewCreate': { ok: false, error: { code: 'invalid-input', message: 'input.sourceWorkspaceId is required' } },
  'archiveCleanup/probe': { ok: true, value: {} },
  'openInApp/probe': { ok: true, value: { platform: 'linux' } },
}

function recordingCall(observed: Array<{ method: string; payload: unknown }>): RuntimeProbeCall {
  return async (_baseUrl, method, payload) => {
    observed.push({ method, payload })
    if (method === 'commands/execute') {
      const error = new Error('missing probe session') as Error & { code: string }
      error.code = 'session/not-found'
      throw error
    }
    if (method === 'session/canOpenWorkspacePath') return { result: { value: true } }
    if (method === 'settings/describe') return { result: { value: { writable: true, namespaces: [] } } }
    return { result: { value: CANONICAL_DOMAIN_VALUE[method] ?? null } }
  }
}

test('③ runtime-probes.ts closes its per-domain branch over every registry domain (real runner)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-host-domain-lockstep-'))
  try {
    writeFileSync(join(home, 'settings.yaml'), 'locale:\n  preference: zh\n')
    for (const descriptor of CHAMBER_HOST_PACKAGES) {
      const domain = descriptor.probe.method
      const observed: Array<{ method: string; payload: unknown }> = []
      const results = await runRuntimeActivationProbes({
        baseUrl: 'http://127.0.0.1:1',
        dshHome: home,
        call: recordingCall(observed),
        windowMs: 5_000,
        rpcTimeoutMs: 500,
        hostDomainNames: [domain],
      })
      assert.deepEqual(
        results.map(result => result.name),
        [...activationProbeNamesForDomains([domain])],
        domain + ': the expected exact probe set',
      )
      const row = results.find(result => result.name === domain)
      assert.ok(row !== undefined, domain + ' must own a probe row')
      assert.notEqual(
        row.error,
        'probe not wired',
        domain + ' must run its own branch (the unwired placeholder means the wantsDomain/name/byName registration is missing)',
      )
      if (CANONICAL_DOMAIN_VALUE[domain] !== undefined) {
        assert.equal(row.ok, true, domain + ' must accept its canonical carrier answer')
      }
      const calls = observed.filter(entry => entry.method === domain)
      assert.equal(calls.length, 1, domain + ' must issue exactly one RPC')
      assert.deepEqual(
        calls[0].payload,
        { args: descriptor.probe.args },
        domain + ' must send the registry-pinned probe args',
      )
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

function seedOf(descriptor: ChamberHostPackageDescriptor, sourceDir: string): ChamberHostPackageSeed {
  return {
    insertId: descriptor.insert.id,
    packageName: descriptor.insert.name,
    sourceDir,
    label: descriptor.insert.id,
    ...(descriptor.localOnly === true ? { localOnly: true as const } : {}),
  }
}

test('④ builtChamberHostPackageSeeds skips ONLY a missing dist/index.js (a mapping gap throws)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-host-domain-built-'))
  try {
    const unbuilt = join(scratch, 'unbuilt')
    mkdirSync(unbuilt)
    const built = join(scratch, 'built')
    mkdirSync(join(built, 'dist'), { recursive: true })
    writeFileSync(join(built, 'dist', 'index.js'), 'export const ok = 1\n')
    const remote = REMOTE_PACKAGES[0]
    assert.deepEqual(
      builtChamberHostPackageSeeds([seedOf(remote, unbuilt)]),
      [],
      'a mapped-but-unbuilt package is the ONE allowed skip (existsSync)',
    )
    assert.equal(builtChamberHostPackageSeeds([seedOf(remote, built)]).length, 1, 'a mapped-and-built package ships')
    assert.throws(
      () => builtChamberHostPackageSeeds([seedOf(remote, '')]),
      (error: unknown) => error instanceof Error
        && error.message.includes(remote.insert.name)
        && error.message.includes('sourceDir'),
      'an empty sourceDir is a wiring defect, never "not built"',
    )
    const localOnly = LOCAL_ONLY_PACKAGES[0]
    assert.deepEqual(
      builtChamberHostPackageSeeds([seedOf(localOnly, '')]),
      [],
      'a localOnly row never travels: it is filtered, not thrown',
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('⑤ chamberHostPackageSeedsFrom: every non-localOnly row needs its sourceDir key, missing key throws', () => {
  const complete: Record<string, string> = {}
  for (const descriptor of CHAMBER_HOST_PACKAGES) {
    complete[descriptor.insert.name] = join(REPO_ROOT, 'packages', descriptor.insert.id)
  }
  const seeds = chamberHostPackageSeedsFrom(complete)
  assert.deepEqual(
    seeds.map(entry => entry.insertId),
    CHAMBER_HOST_PACKAGES.map(descriptor => descriptor.insert.id),
    'the seed array is the registry, in registry order',
  )
  for (const descriptor of CHAMBER_HOST_PACKAGES) {
    const entry = seeds.find(candidate => candidate.insertId === descriptor.insert.id)
    assert.ok(entry !== undefined)
    if (descriptor.localOnly === true) {
      assert.equal(entry.sourceDir, '', 'a localOnly row carries the empty sentinel, never a resolvable dir')
      assert.equal(entry.localOnly, true)
    } else {
      assert.equal(entry.sourceDir, complete[descriptor.insert.name])
    }
  }
  for (const descriptor of REMOTE_PACKAGES) {
    const partial = { ...complete }
    delete partial[descriptor.insert.name]
    assert.throws(
      () => chamberHostPackageSeedsFrom(partial),
      (error: unknown) => error instanceof Error
        && error.message.includes(descriptor.insert.name)
        && error.message.includes('sourceDir 键'),
      descriptor.insert.name + ' must fail loud without its sourceDir key',
    )
  }
  assert.equal(
    chamberHostPackageSeedsFrom({}, [LOCAL_ONLY_PACKAGES[0]])[0].sourceDir,
    '',
    'the localOnly row is exempt from the sourceDir-key requirement',
  )
})

// ---------------------------------------------------------------------------
// ⑥ the superseded official open-in wire face (audit arch-03 P2-3)
// ---------------------------------------------------------------------------

/** Source extensions the route-caller scan reads (never build output/data). */
const CHAMBER_SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|mjs|js|jsx)$/u

/**
 * Every chamber production source file under packages/ — tests, build output,
 * caches and the vendored upstream trees excluded — so a NEW package or a new
 * file is scanned without editing this list. */
function chamberProductionSources(): string[] {
  const files: string[] = []
  const skip = new Set(['node_modules', 'vendor', 'dist', 'lib', 'test', 'tests', '.cache', 'coverage'])
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) visit(join(dir, entry.name))
        continue
      }
      if (entry.isFile() && CHAMBER_SOURCE_EXTENSIONS.test(entry.name)) files.push(join(dir, entry.name))
    }
  }
  visit(join(REPO_ROOT, 'packages'))
  return files
}

/** The subset of `files` carrying the official `/open-in-app/` route prefix. */
function officialOpenInRouteCallers(files: readonly string[]): string[] {
  return files.filter(file => readFileSync(file, 'utf8').includes('/open-in-app/'))
}

test('⑥a no chamber production source calls the official /open-in-app/* routes (P2-3 wire-face lock)', () => {
  // Positive control first: the scanner detects the literal it is about to
  // reject, so a green run cannot come from a broken/empty matcher.
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-open-in-route-lock-'))
  try {
    const fixture = join(scratch, 'fixture.ts')
    writeFileSync(fixture, "await fetch('/open-in-app/apps')\n")
    assert.deepEqual(officialOpenInRouteCallers([fixture]), [fixture],
      'the route-caller scanner must detect the official literal')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  const files = chamberProductionSources()
  assert.ok(files.length > 200, `the scan surface must cover the chamber tree (found ${String(files.length)} files)`)
  assert.deepEqual(officialOpenInRouteCallers(files), [],
    'the official host routes are superseded by dsh-chamber-seed-open-in; a caller would re-establish a second wire authority')
})

/** The pin's vendor link tree (ensure-harness-vendor builds it). */
const VENDOR_PACKAGES = join(REPO_ROOT, 'vendor', 'harness-packages', '@deepseek-ai')
const VENDOR_MISSING = !existsSync(join(VENDOR_PACKAGES, 'dsh-host-open-in-app', 'src', 'shared.ts'))
const VENDOR_OPT_OUT = process.env.DSH_CHAMBER_VENDOR_ABSENT === 'skip'

test('⑥b the vendored web bundle still mounts the official open-in host row this overlay disables', {
  skip: VENDOR_MISSING && VENDOR_OPT_OUT ? 'vendor tree absent; explicit DSH_CHAMBER_VENDOR_ABSENT=skip' : false,
}, () => {
  if (VENDOR_MISSING) {
    assert.fail('vendor/harness-packages 未物化：本锁步读 pin 住的 vendor 源，缺树即失败'
      + '（显式 DSH_CHAMBER_VENDOR_ABSENT=skip 才跳过）。')
  }
  const shared = readFileSync(join(VENDOR_PACKAGES, 'dsh-host-open-in-app', 'src', 'shared.ts'), 'utf8')
  assert.match(shared, /OPEN_IN_APP_APPS_ROUTE = '\/open-in-app\/apps'/, 'the official apps route must still exist')
  assert.match(shared, /OPEN_IN_APP_ICON_PREFIX = '\/open-in-app\/icon'/, 'the official icon route must still exist')
  assert.match(shared, /OPEN_IN_APP_OPEN_ROUTE = '\/open-in-app\/open'/, 'the official open route must still exist')
  const bundle = readFileSync(join(VENDOR_PACKAGES, 'dsh-web-app', 'cordis.patch.yml'), 'utf8')
  assert.match(bundle, /- id: open-in-app\n\s+name: '@deepseek-ai\/dsh-host-open-in-app'/,
    'the web bundle must still insert the row this overlay disables (a rename would silently resurrect the dead face)')
  assert.equal(OFFICIAL_OPEN_IN_DISABLE.id, 'open-in-app')
  assert.equal(OFFICIAL_OPEN_IN_DISABLE.name, '@deepseek-ai/dsh-host-open-in-app')
})
