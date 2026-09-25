/**
 * Managed-profile installed-plugin read projection tests (design 21 §6.2):
 * the pure gateway read module (plugins-installed.ts) plus the GET
 * /chamber/plugins/installed route (routes.ts) — absent/corrupt/mask/
 * profileExists/rows submatrix plus the route method discipline.
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
import { handleChamberSurface, makeChamberSurfaceHarness, surfaceSilentLogger } from '../support/chamber-surface-harness.ts'

// Shared harness: only the logger default remains local.
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
  loggerForSurface: typeof logger = logger,
): ReturnType<typeof createChamberSurface> {
  return makeChamberSurfaceHarness(_t, { stateDir, logger: loggerForSurface }).surface
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
  // B₀/S create no rows by themselves, but when a profile itself declares such
  // a name the backend classification and the protected flag still apply — the
  // row renders read-only in the dialog.
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
    assertProjection(atBound, { ok: true, dependencies: { a: '^1.0.0' }, profileExists: true }, ['a:third-party:false'])
  }
  const over = JSON.stringify({ dependencies: { a: '^1.0.0' }, pad: 'x'.repeat(INSTALLED_MANIFEST_MAX_BYTES - base.length + 1) })
  writeManifest(stateDir, over)
  const result = readProjection(stateDir)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'profile_corrupt')
})

/** B₀ (installation-owned composition) and S (chamber seeds) are CLASSIFIERS
 *  only (design 21 §6.11.5): the projection lists one
 *  row per declared dependency, so a baseline composition member or a seed
 *  shows up only when the profile itself declares it. */
const rowShape = (rows: readonly { name: string; role: string; protected: boolean }[]): string[] =>
  rows.map(row => `${row.name}:${row.role}:${row.protected}`)

/** Split a projection into `rows` + the rest, asserting both (the manifest
 *  fields keep their exact meaning — `rows` is additive). */
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
      profileExists: true,
      // `b` is listed in the live bundles but is NOT a dependency ⇒ no row: the
      // installed list is the profile's own plugin set.
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

test('installed read: missing dsh block leaves plain rows; non-string dependency values dropped', t => {
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
      profileExists: true,
    }, ['good:third-party:false'])
  }
})

test('installed read: the bundles walk keeps only string members (server-side role classifier)', t => {
  const stateDir = scratch(t)
  writeManifest(stateDir, JSON.stringify({
    dependencies: { b: '^1.0.0', c: '^1.0.0', d: '^1.0.0' },
    dsh: { profile: { bundles: ['b', 5, null, 'c'] } },
  }))
  const projection = readProjection(stateDir)
  assert.equal(projection.ok, true)
  if (projection.ok) {
    assert.deepEqual(rowShape(projection.rows), ['b:layer:false', 'c:layer:false', 'd:third-party:false'].sort())
  }
})

// ---------------------------------------------------------------------------
// Mask / layout lockstep (desktop plugin-sync.ts parity — drift guards)
// ---------------------------------------------------------------------------

/** The desktop manifest/whitelist twin source (packages/desktop/plugin-sync.ts)
 * the gateway read projection mirrors. */
function desktopPluginSyncSource(): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'desktop', 'plugin-sync.ts'),
    'utf8',
  )
}

test('MATERIALIZED_VALUE_MASK is the SHARED wire constant on every side', () => {
  // The literal lives in @dsh-chamber/dsh-chamber-wire/plugin-manifest
  // (design 21 §6.2/§6.11.5): no side may hardcode its own copy — the
  // gateway's export, the control-plane re-export and the desktop's export
  // must all resolve to PLUGIN_MATERIALIZED_VALUE_MASK (the wire/control-plane
  // ↔ gateway equality is pinned again by plugin-manifest-lockstep.test.ts).
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