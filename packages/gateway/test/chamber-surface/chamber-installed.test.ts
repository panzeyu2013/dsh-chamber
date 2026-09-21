/**
 * Managed-profile installed-plugin read projection tests (design 21 §6.2 —
 * A0 read surface, plan Phase 3a): the pure gateway read module
 * (plugins-installed.ts) plus the GET /chamber/plugins/installed route
 * (routes.ts) — absent/corrupt/mask/profileExists/bundles submatrix plus the
 * route method discipline. Desktop IPC/UI land in later sub-steps.
 *
 * Run directly: node packages/gateway/test/chamber-surface/chamber-installed.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHAMBER_HOST_PACKAGES, PLUGIN_MATERIALIZED_VALUE_MASK } from '@dsh-chamber/control-plane'
import {
  createChamberInstalled,
  INSTALLED_MANIFEST_MAX_BYTES,
  INSTALLED_PROFILE_DIR,
  MATERIALIZED_VALUE_MASK,
  type InstalledResult,
} from '../../src/plugins-installed.ts'
import { createChamberSurface } from '../../src/routes.ts'
import { stubPluginTasks } from '../support/utils.ts'
import { handleChamberSurface, makeChamberSurfaceHarness, surfaceSilentLogger } from '../support/chamber-surface-harness.ts'

// Shared harness (2026-12 audit F40): only the logger default remains local.
const logger = surfaceSilentLogger

/** Read the module projection directly (pure-module tests). */
function readProjection(stateDir: string): InstalledResult {
  return createChamberInstalled(stateDir).read()
}

function scratch(t: { after(fn: () => void): void }): string {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-installed-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  return stateDir
}

/** <stateDir>/dsh-home/profiles/web (mirrors the module layout). */
function profileDir(stateDir: string): string {
  return join(stateDir, 'dsh-home', INSTALLED_PROFILE_DIR)
}

function writeManifest(stateDir: string, text: string): void {
  mkdirSync(profileDir(stateDir), { recursive: true })
  writeFileSync(join(profileDir(stateDir), 'package.json'), text)
}

function surface(
  _t: { after(fn: () => void): void },
  stateDir: string,
  tasks: ReturnType<typeof stubPluginTasks> = stubPluginTasks(),
  loggerForSurface: typeof logger = logger,
): ReturnType<typeof createChamberSurface> {
  return makeChamberSurfaceHarness(_t, { stateDir, tasks, logger: loggerForSurface }).surface
}

const handle = handleChamberSurface

// ---------------------------------------------------------------------------
// Pure module: absent / corrupt / valid / masking
// ---------------------------------------------------------------------------

test('installed read: no managed profile yet (dsh-home absent) → profile_absent', t => {
  const stateDir = scratch(t)
  assert.deepEqual(readProjection(stateDir), { ok: false, code: 'profile_absent' })
})

test('installed read: profile directory without package.json → profile_absent', t => {
  const stateDir = scratch(t)
  mkdirSync(profileDir(stateDir), { recursive: true })
  assert.deepEqual(readProjection(stateDir), { ok: false, code: 'profile_absent' })
})

test('installed read: unreadable-but-present manifest (permissions) → profile_corrupt', t => {
  if (process.platform === 'win32') {
    t.skip('chmod 0o000 does not deny reads on Windows')
    return
  }
  if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
    t.skip('root bypasses file permission checks')
    return
  }
  const stateDir = scratch(t)
  writeManifest(stateDir, JSON.stringify({ dependencies: { a: '^1.0.0' } }))
  chmodSync(join(profileDir(stateDir), 'package.json'), 0o000)
  const result = readProjection(stateDir)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'profile_corrupt')
    assert.equal(typeof result.error, 'string')
  }
})

test('installed read: symlinked profile directory / manifest → profile_corrupt (no-follow)', t => {
  const stateDir = scratch(t)
  mkdirSync(join(stateDir, 'dsh-home', 'profiles'), { recursive: true })
  const real = scratch(t)
  writeManifest(real, JSON.stringify({ dependencies: { a: '^1.0.0' } }))
  const web = join(stateDir, 'dsh-home', 'profiles', 'web')
  symlinkSync(join(real, 'dsh-home', INSTALLED_PROFILE_DIR), web)
  const dirResult = readProjection(stateDir)
  assert.equal(dirResult.ok, false)
  if (!dirResult.ok) assert.equal(dirResult.code, 'profile_corrupt')

  // Same discipline on the manifest leaf itself.
  rmSync(web, { recursive: true, force: true })
  mkdirSync(web, { recursive: true })
  const decoy = join(stateDir, 'decoy.json')
  writeFileSync(decoy, JSON.stringify({ dependencies: {} }))
  symlinkSync(decoy, join(web, 'package.json'))
  const leafResult = readProjection(stateDir)
  assert.equal(leafResult.ok, false)
  if (!leafResult.ok) assert.equal(leafResult.code, 'profile_corrupt')
})

test('installed read: invalid JSON manifest → profile_corrupt', t => {
  const stateDir = scratch(t)
  writeManifest(stateDir, '{ not json')
  const result = readProjection(stateDir)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.code, 'profile_corrupt')
    assert.match(result.error ?? '', /not valid JSON/)
  }
})

test('installed read: non-object manifest (array / null / primitive) → profile_corrupt', t => {
  for (const body of ['[1, 2]', 'null', '"plain"', '42']) {
    const stateDir = scratch(t)
    writeManifest(stateDir, body)
    const result = readProjection(stateDir)
    assert.equal(result.ok, false, body)
    if (!result.ok) {
      assert.equal(result.code, 'profile_corrupt', body)
      assert.match(result.error ?? '', /not a JSON object/, body)
    }
  }
})

test('installed read: a DECLARED baseline name still classifies + stays protected', t => {
  // B₀/S no longer create rows (2026-09 row-set revision), but when a profile
  // itself declares such a name the backend classification and the protected
  // flag still apply — the row renders read-only in the dialog.
  const seed = CHAMBER_HOST_PACKAGES[0].insert.name
  const stateDir = scratch(t)
  writeManifest(stateDir, JSON.stringify({
    dependencies: { '@deepseek-ai/dsh-base': '0.1.5-rc.2', [seed]: '0.3.1' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }))
  const projection = readProjection(stateDir)
  assert.equal(projection.ok, true)
  if (projection.ok) {
    assert.deepEqual(rowShape(projection.rows), [
      '@deepseek-ai/dsh-base:composition:true',
      `${seed}:seed:true`,
    ].sort())
  }
})

test('installed read: oversized manifest (> 1 MiB) → profile_corrupt; exact bound reads', t => {
  const stateDir = scratch(t)
  const base = JSON.stringify({ dependencies: { a: '^1.0.0' }, pad: '' })
  const exact = JSON.stringify({ dependencies: { a: '^1.0.0' }, pad: 'x'.repeat(INSTALLED_MANIFEST_MAX_BYTES - base.length) })
  writeManifest(stateDir, exact)
  const atBound = readProjection(stateDir)
  assert.equal(atBound.ok, true)
  if (atBound.ok) {
    assertProjection(atBound, { ok: true, dependencies: { a: '^1.0.0' }, bundles: [], profileExists: true }, ['a:third-party:false'])
  }
  const over = JSON.stringify({ dependencies: { a: '^1.0.0' }, pad: 'x'.repeat(INSTALLED_MANIFEST_MAX_BYTES - base.length + 1) })
  writeManifest(stateDir, over)
  const result = readProjection(stateDir)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'profile_corrupt')
})

/** B₀ (installation-owned composition) and S (chamber seeds) are CLASSIFIERS
 *  only (design 21 §6.11.5, 2026-09 row-set revision): the projection lists one
 *  row per declared dependency, so a baseline composition member or a seed
 *  shows up only when the profile itself declares it. */
const rowShape = (rows: readonly { name: string; role: string; protected: boolean }[]): string[] =>
  rows.map(row => `${row.name}:${row.role}:${row.protected}`)

/** Split a projection into `rows` + the rest, asserting both (the manifest
 *  fields keep their exact historical meaning — `rows` is additive). */
function assertProjection(
  projection: { ok: true; rows: readonly { name: string; role: string; protected: boolean }[] } & Record<string, unknown>,
  expectedRest: Record<string, unknown>,
  expectedRows: string[],
): void {
  const { rows, ...rest } = projection
  assert.deepEqual(rest, expectedRest)
  assert.deepEqual(rowShape(rows), [...expectedRows].sort())
}

test('installed read: valid minimal manifest → masked passthrough projection', t => {
  const stateDir = scratch(t)
  writeManifest(stateDir, JSON.stringify({
    dependencies: { a: '^1.0.0' },
    dsh: { profile: { bundles: ['b'] } },
  }))
  const projection = readProjection(stateDir)
  assert.equal(projection.ok, true)
  if (projection.ok) {
    assertProjection(projection, {
      ok: true,
      dependencies: { a: '^1.0.0' },
      bundles: ['b'],
      profileExists: true,
      // `b` is listed in the live bundles but is NOT a dependency ⇒ no row: the
      // installed list is the profile's own plugin set (2026-09 row-set revision).
    }, ['a:third-party:false'])
  }
})

test('installed read: file: values are masked (case-insensitive) in dependencies AND rows', t => {
  const stateDir = scratch(t)
  writeManifest(stateDir, JSON.stringify({
    dependencies: {
      'registry-pkg': '^2.1.0',
      'tildes': '~1.2.0',
      'file-pkg': 'file:../local-pkg',
      'case-pkg': 'FILE:/abs/local-pkg',
      'file-tgz': 'file:../pkg.tgz',
    },
    dsh: { profile: { bundles: [] } },
  }))
  const result = readProjection(stateDir)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.dependencies, {
      'registry-pkg': '^2.1.0',
      'tildes': '~1.2.0',
      'file-pkg': MATERIALIZED_VALUE_MASK,
      'case-pkg': MATERIALIZED_VALUE_MASK,
      'file-tgz': MATERIALIZED_VALUE_MASK,
    })
    assert.deepEqual(result.bundles, [])
    assert.equal(result.profileExists, true)
    // The row projection carries the SAME masking rule: no gateway-local path
    // may reach the renderer through `rows[].spec` either (design 21 §6.2).
    const byName = new Map(result.rows.map(row => [row.name, row]))
    assert.equal(byName.get('file-pkg')?.spec, MATERIALIZED_VALUE_MASK)
    assert.equal(byName.get('case-pkg')?.spec, MATERIALIZED_VALUE_MASK)
    assert.equal(byName.get('file-tgz')?.spec, MATERIALIZED_VALUE_MASK)
    assert.equal(byName.get('registry-pkg')?.spec, '^2.1.0')
    // ...and the mask still classifies as materialize, not as third-party.
    assert.equal(byName.get('file-pkg')?.role, 'materialized')
    assert.equal(byName.get('registry-pkg')?.role, 'third-party')
  }
})

test('installed read: missing dsh block → bundles []; non-string dependency values dropped', t => {
  const stateDir = scratch(t)
  writeManifest(stateDir, JSON.stringify({
    dependencies: {
      'good': '^1.0.0',
      'object-spec': { nested: true },
      'number-spec': 3,
      'null-spec': null,
    },
  }))
  const projection = readProjection(stateDir)
  assert.equal(projection.ok, true)
  if (projection.ok) {
    assertProjection(projection, {
      ok: true,
      dependencies: { good: '^1.0.0' },
      bundles: [],
      profileExists: true,
    }, ['good:third-party:false'])
  }
})

test('installed read: bundles keeps only string members', t => {
  const stateDir = scratch(t)
  writeManifest(stateDir, JSON.stringify({
    dependencies: {},
    dsh: { profile: { bundles: ['b', 5, null, 'c'] } },
  }))
  const result = readProjection(stateDir)
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.bundles, ['b', 'c'])
})

// ---------------------------------------------------------------------------
// Mask / layout lockstep (desktop plugin-sync.ts parity — drift guards until
// the shared whitelist module lands in Phase 4.3)
// ---------------------------------------------------------------------------

/** The desktop manifest/whitelist twin source (packages/desktop/plugin-sync.ts)
 * the gateway read projection mirrors. */
function desktopPluginSyncSource(): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'desktop', 'plugin-sync.ts'),
    'utf8',
  )
}

test('MATERIALIZED_VALUE_MASK is the SHARED control-plane constant on both sides', () => {
  // The literal was centralized into control-plane protected-plugins.ts for the
  // protected-set work (design 21 §6.2/§6.11.5): neither side may hardcode its
  // own copy again — the gateway's export and the desktop's export must both
  // resolve to PLUGIN_MATERIALIZED_VALUE_MASK.
  assert.equal(MATERIALIZED_VALUE_MASK, PLUGIN_MATERIALIZED_VALUE_MASK)
  assert.equal(PLUGIN_MATERIALIZED_VALUE_MASK, 'file:<hidden>')
  assert.match(desktopPluginSyncSource(),
    /export const MATERIALIZED_VALUE_MASK = PLUGIN_MATERIALIZED_VALUE_MASK/,
    'desktop plugin-sync.ts must re-export the shared constant, not a fresh literal')
})

test('INSTALLED_PROFILE_DIR stays on the desktop WEB_PROFILE layout (profiles/web parity)', () => {
  const match = /WEB_PROFILE\s*=\s*'([^']+)'/.exec(desktopPluginSyncSource())
  if (match === null) assert.fail('desktop plugin-sync.ts must declare WEB_PROFILE as a quoted literal')
  // Desktop reads <home>/profiles/<WEB_PROFILE>/package.json (plugin-sync.ts
  // WEB_PROFILE = 'web'); the gateway reads <stateDir>/dsh-home/<INSTALLED_
  // PROFILE_DIR>/package.json. Layout parity = the desktop layout rebuilt
  // from its constant must equal our constant (a profiles/web rename on
  // either side fails here).
  assert.equal(join('profiles', match[1]), INSTALLED_PROFILE_DIR,
    'gateway profile layout must stay on the desktop WEB_PROFILE (drift guard until the shared layout/whitelist module lands in Phase 4.3)')
})

// ---------------------------------------------------------------------------
// Route level: GET /chamber/plugins/installed
// ---------------------------------------------------------------------------

test('route: GET /chamber/plugins/installed → 200 ok projection (trailing slash tolerant)', async t => {
  const stateDir = scratch(t)
  writeManifest(stateDir, JSON.stringify({
    dependencies: { a: '^1.0.0', 'local': 'file:../thing' },
    dsh: { profile: { bundles: ['a'] } },
  }))
  const host = surface(t, stateDir)
  const plain = await handle(host, 'GET', '/chamber/plugins/installed')
  assert.equal(plain.status, 200)
  assertProjection(plain.json() as never, {
    ok: true,
    dependencies: { a: '^1.0.0', 'local': MATERIALIZED_VALUE_MASK },
    bundles: ['a'],
    profileExists: true,
  }, ['a:layer:false', 'local:materialized:false'])
  const slash = await handle(host, 'GET', '/chamber/plugins/installed/')
  assert.equal(slash.status, 200)
  assert.deepEqual(slash.json(), plain.json())
})

test('route: absent profile → 404 profile_absent; corrupt manifest → 500 profile_corrupt', async t => {
  const stateDir = scratch(t)
  const host = surface(t, stateDir)
  const absent = await handle(host, 'GET', '/chamber/plugins/installed')
  assert.equal(absent.status, 404)
  assert.deepEqual(absent.json(), { error: 'managed profile is not initialized', code: 'profile_absent' })

  writeManifest(stateDir, '{ nope')
  const corrupt = await handle(host, 'GET', '/chamber/plugins/installed')
  assert.equal(corrupt.status, 500)
  assert.deepEqual(corrupt.json(), { error: 'managed profile is corrupted', code: 'profile_corrupt' })
})

test('route: non-GET methods on /chamber/plugins/installed → 405', async t => {
  const stateDir = scratch(t)
  writeManifest(stateDir, JSON.stringify({ dependencies: {} }))
  const host = surface(t, stateDir)
  for (const method of ['PUT', 'POST', 'DELETE', 'PATCH', 'HEAD']) {
    const response = await handle(host, method, '/chamber/plugins/installed')
    assert.equal(response.status, 405, method)
    assert.equal(response.json().code, 'method_not_allowed', method)
  }
})

// ---------------------------------------------------------------------------
// Route level: the shared read/write fence (design 21 §6.2 读与写面共享栅栏,
// C-F8) — the read consults the A1 write surface's in-flight state and answers
// the lease family's retryable 409 instead of publishing a stale/torn
// projection.
// ---------------------------------------------------------------------------

/** One journal op as the tasks projection shapes it (the fence reads only
 * `status`; the rest keeps the projection structurally honest). */
function journalOp(status: 'pending' | 'ok' | 'failed' | 'blocked'): Record<string, unknown> {
  return { id: `op-${status}`, ts: Date.now(), kind: 'install', name: 'alpha', preImage: null, status }
}

function tasksProjection(overrides: {
  busy?: boolean
  ops?: Array<Record<string, unknown>>
  deferred?: Array<Record<string, unknown>>
  throws?: boolean
}): ReturnType<typeof stubPluginTasks> {
  return stubPluginTasks({
    tasks: () => {
      if (overrides.throws === true) throw new Error('journal store unavailable')
      return {
        tasks: (overrides.ops ?? []) as never,
        deferred: (overrides.deferred ?? []) as never,
        busy: overrides.busy ?? false,
      }
    },
  })
}

test('route: a write in flight fences the read → 409 runtime_busy (retryable), never a projection', async t => {
  const stateDir = scratch(t)
  // No manifest at all: the fence must be consulted BEFORE the projection, so
  // the answer is the fence 409 — not profile_absent (a 404 would tell the
  // client "nothing is installed" while a write is mid-flight).
  for (const inFlight of [
    tasksProjection({ busy: true }),
    // Queued-but-not-running window (the window a client reads in right after
    // the 202): the executor is idle, yet the op holds the profile-write lease.
    tasksProjection({ busy: false, ops: [journalOp('pending')] }),
  ]) {
    const host = surface(t, stateDir, inFlight)
    const response = await handle(host, 'GET', '/chamber/plugins/installed')
    assert.equal(response.status, 409)
    const body = response.json()
    assert.equal(body.code, 'runtime_busy', 'the lease family code, not a new one')
    assert.match(body.error, /write in flight/)
    assert.match(body.error, /retry/, 'the refusal must state its retryable contract')
  }

  // Same fence on the trailing-slash form.
  writeManifest(stateDir, JSON.stringify({ dependencies: { a: '^1.0.0' } }))
  const fenced = await handle(surface(t, stateDir, tasksProjection({ busy: true })), 'GET', '/chamber/plugins/installed/')
  assert.equal(fenced.status, 409)
})

test('route: no write in flight → 200 unchanged (terminal ops, deferred intents, idle executor)', async t => {
  const stateDir = scratch(t)
  writeManifest(stateDir, JSON.stringify({
    dependencies: { a: '^1.0.0', 'local': 'file:../thing' },
    dsh: { profile: { bundles: ['a'] } },
  }))
  const expected = {
    ok: true,
    dependencies: { a: '^1.0.0', 'local': MATERIALIZED_VALUE_MASK },
    bundles: ['a'],
    profileExists: true,
  }
  const expectedRows = ['a:layer:false', 'local:materialized:false']
  const idle = [
    tasksProjection({}),
    tasksProjection({ busy: false, ops: [journalOp('ok'), journalOp('failed'), journalOp('blocked')] }),
    // A deferred intent holds NO lease and has NO writer (design 21 §6.8 r1
    // keeps the installed read — "installed 纯文件读" — available while the
    // instance is stopped): it must never fence the read.
    tasksProjection({ deferred: [{ id: 'int-1', ts: Date.now(), kind: 'install', name: 'later' }] }),
  ]
  for (const tasks of idle) {
    const response = await handle(surface(t, stateDir, tasks), 'GET', '/chamber/plugins/installed')
    assert.equal(response.status, 200)
    assertProjection(response.json() as never, expected, expectedRows)
  }
})

test('route: a failing fence probe is loud but fail-open (the §6.8 r1 recovery read stays available)', async t => {
  const stateDir = scratch(t)
  writeManifest(stateDir, JSON.stringify({ dependencies: { a: '^1.0.0' } }))
  const warnings: string[] = []
  const capturing = { log() {}, warn(message: string) { warnings.push(message) }, error() {} }
  const host = surface(t, stateDir, tasksProjection({ throws: true }), capturing as never)
  const response = await handle(host, 'GET', '/chamber/plugins/installed')
  assert.equal(response.status, 200, 'the read itself still answers')
  assert.equal(response.json().dependencies.a, '^1.0.0')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /write-fence probe failed, reading unfenced/)
})
