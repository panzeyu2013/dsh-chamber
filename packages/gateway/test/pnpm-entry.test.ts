/**
 * pnpm-entry: the gateway's PATH shim for the managed `dsh plugin` CLI.
 *
 * Regression (2026-09 audit, P1): upstream `dsh plugin` spawns a literal
 * `pnpm` from PATH and answers 127 when the host has none — the gateway ships
 * the pinned pnpm as a bare `pnpm.cjs`, which a PATH lookup cannot see, so a
 * server provisioned with npm alone could not seed or mutate the managed
 * profile. These cases pin the shim's shape, its idempotence and the PATH
 * prepend contract.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  PNPM_SHIM_DIR,
  ensurePnpmOnPath,
  pathDelimiter,
  resolvePnpmEntry,
  withPnpmOnPath,
} from '../src/pnpm-entry.ts'

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pnpm-shim-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

test('resolvePnpmEntry returns an existing pnpm entry script', () => {
  const entry = resolvePnpmEntry()
  assert.ok(entry.endsWith('pnpm.cjs'), `unexpected entry: ${entry}`)
  assert.ok(existsSync(entry), `entry does not exist: ${entry}`)
})

test('ensurePnpmOnPath materializes an executable shim that forwards to the bundled pnpm', t => {
  const root = scratch(t)
  const dir = ensurePnpmOnPath(root)
  assert.equal(dir, join(root, PNPM_SHIM_DIR))
  const shim = join(dir!, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  const content = readFileSync(shim, 'utf8')
  assert.match(content, /pnpm\.cjs/)
  assert.ok(content.includes(process.execPath), 'the shim execs the current node binary')
  if (process.platform === 'win32') {
    assert.match(content, /%(\*|)/)
  } else {
    assert.match(content, /^#!\/bin\/sh\n/)
    assert.equal(statSync(shim).mode & 0o777, 0o755, 'the POSIX shim is executable')
  }
})

test('ensurePnpmOnPath is idempotent and leaves a stable shim behind', t => {
  const root = scratch(t)
  const first = ensurePnpmOnPath(root)
  const shim = join(first!, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  const before = statSync(shim).mtimeMs
  const second = ensurePnpmOnPath(root)
  assert.equal(second, first)
  assert.equal(statSync(shim).mtimeMs, before, 'identical content is not rewritten')
})

test('withPnpmOnPath prepends with the platform delimiter and is a no-op for null', () => {
  const dir = join('shim', 'dir')
  const prefixed = withPnpmOnPath({ PATH: '/usr/bin', DSH_HOME: '/state' }, dir)
  assert.equal(prefixed.PATH, `${dir}${pathDelimiter()}/usr/bin`)
  assert.equal(prefixed.DSH_HOME, '/state')
  const untouched = withPnpmOnPath({ PATH: '/usr/bin' }, null)
  assert.equal(untouched.PATH, '/usr/bin')
})

test('withPnpmOnPath tolerates an env without PATH', () => {
  assert.equal(withPnpmOnPath({} as Record<string, string | undefined>, '/shim').PATH, `/shim${pathDelimiter()}`)
})
