/**
 * gateway serve refuses a state root held by a live writer with the deterministic
 * exit code 3 (design 17 §12).
 *
 * The systemd unit's RestartPreventExitStatus=2 3 depends on this exact code, and
 * this file covers the SERVICE entry (the one systemd actually runs): the
 * control-plane tests cover `dsh serve` and standalone, and the auth test covers
 * the short-lease path, but nothing else spawns the gateway service CLI against a
 * locked root. Before this file, reverting the return value to 1 left every suite
 * green.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireStateRootLease } from '@dsh-chamber/control-plane'

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url))

test('gateway serve refuses a locked state root with exit 3 before starting anything', async t => {
  const root = mkdtempSync(join(tmpdir(), 'gateway-cli-lease-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const stateDir = join(root, 'state')
  const dsh = join(root, 'dsh')
  mkdirSync(join(dsh, 'apps', 'cli', 'src'), { recursive: true })
  writeFileSync(join(dsh, 'apps', 'cli', 'src', 'bin.ts'), '')

  const lease = acquireStateRootLease(stateDir, { scope: 'state-root', flavor: 'gateway' })
  try {
    const env = { ...process.env }
    delete env.DSH_GATEWAY_STATE
    const result = spawnSync(process.execPath, [
      CLI, 'serve',
      '--dsh-path', dsh,
      '--state-dir', stateDir,
      '--host', '127.0.0.1',
      '--port', '39281',
    ], { encoding: 'utf8', env, timeout: 20_000 })

    // Exit 3 is the "do not auto-restart" contract the unit pins; exit 1 would
    // bring the three-second restart loop back.
    assert.equal(result.status, 3, result.stderr)
    assert.match(result.stderr, /state_root_locked:/u)
    assert.match(result.stderr, new RegExp('owned by pid ' + String(process.pid) + ' \\(gateway\\)'),
      'the message names the holder pid and flavor')
    assert.doesNotMatch(result.stderr, /^\s+at /m, 'never print a stack')
    // The refusal happens before any state write: only the held lease record exists.
    assert.deepEqual(readdirSync(stateDir), ['owner.json'])
  } finally {
    lease.release()
  }
})
