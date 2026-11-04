/**
 * ssh tunnel argv shape for the POSIX UDS listener (P2-1) and the win32 TCP
 * fallback, plus the ControlMaster-is-off invariant that must hold on BOTH.
 * Pure argv construction on a temp directory (no ssh process).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sshProvider } from '../../ssh-provider.ts'
import { sshSocketPath, sshUdsSupported } from '../../ssh-socket.ts'
import type { TransportInstanceSpec } from '../../transport-provider.ts'

function spec(overrides: Partial<TransportInstanceSpec> = {}): TransportInstanceSpec {
  return {
    id: 'argv-1', label: 'home', kind: 'dsh', transport: 'ssh', host: 'home.example.com',
    user: 'alice', sshPort: null, remotePort: 2222, serviceName: null, remoteDshHome: null,
    insecureHttp: false, ...overrides,
  }
}

function forwardValue(argv: readonly string[]): string {
  const index = argv.indexOf('-L')
  assert.notEqual(index, -1, 'the tunnel carries exactly one -L forward')
  return argv[index + 1]!
}

test('POSIX: -L points at the UDS socket and StreamLocalBindUnlink is on', (t) => {
  if (!sshUdsSupported()) { t.skip('win32 keeps the TCP forward'); return }
  const argv = sshProvider.buildStartArgs!(spec(), null)
  const socketPath = sshSocketPath('argv-1')
  assert.equal(forwardValue(argv), `${socketPath}:127.0.0.1:2222`)
  assert.ok(argv.includes('StreamLocalBindUnlink=yes'))
  assert.ok(argv.includes('ControlMaster=no'))
  assert.ok(argv.includes('ControlPath=none'))
  assert.ok(!argv.some(arg => /^\d+:127\.0\.0\.1:2222$/.test(arg)), 'no ephemeral local port is requested')
  assert.equal(statSync(join(socketPath, '..')).mode & 0o777, 0o700, 'the socket directory is owner-only 0700')
  assert.equal(argv.at(-1), `alice@home.example.com`)
})

test('win32 shape (resolved null): the historical TCP -L with ControlMaster still off', () => {
  const argv = sshProvider.buildStartArgs!(spec(), 40000, undefined, null)
  assert.match(forwardValue(argv), /^40000:127\.0\.0\.1:2222$/)
  assert.ok(!argv.includes('StreamLocalBindUnlink=yes'), 'StreamLocalBindUnlink is a UDS-only flag')
  assert.ok(argv.includes('ControlMaster=no'))
  assert.ok(argv.includes('ControlPath=none'))
})

test('the runtime-resolved socket path is used verbatim (one mode decision)', (t) => {
  if (!sshUdsSupported()) { t.skip('win32 keeps the TCP forward'); return }
  const base = mkdtempSync(join(tmpdir(), 'ssh-argv-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const custom = join(base, 'custom.sock')
  const argv = sshProvider.buildStartArgs!(spec(), null, undefined, custom)
  assert.equal(forwardValue(argv), `${custom}:127.0.0.1:2222`)
  assert.equal(statSync(base).mode & 0o777, 0o700, 'the custom parent is tightened to 0700')
})

test('sshPort rides before the forward; UDS and TCP share the prefix', (t) => {
  if (!sshUdsSupported()) { t.skip('win32 keeps the TCP forward'); return }
  const uds = sshProvider.buildStartArgs!(spec({ sshPort: 2202 }), null)
  const tcp = sshProvider.buildStartArgs!(spec({ sshPort: 2202 }), 40001, undefined, null)
  for (const argv of [uds, tcp]) {
    const portIndex = argv.indexOf('-p')
    assert.equal(argv[portIndex + 1], '2202')
    assert.ok(argv.indexOf('-L') > portIndex, 'the forward follows -p')
    assert.match(forwardValue(argv), /^(?:40001|\/[^:]+):127\.0\.0\.1:2222$/)
  }
})
