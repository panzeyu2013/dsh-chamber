/**
 * Forward launcher integration: a REAL child process (a fake ssh executable)
 * through the production spawn/start-time/port/probe/ledger/stop adapters.
 *
 * WHY: the rest of test/forward uses injected children, so the one path that
 * actually spawns, reads /proc/<pid>/stat, binds 127.0.0.N, probes the listener,
 * writes the ledger and kills the process group was untested. This test keeps
 * the SSH protocol fake (the fake executable only opens the requested -L
 * listener and exits on SIGTERM) while exercising the real OS seams.
 *
 * Linux-only: the start-time adapter reads /proc/<pid>/stat. Other platforms
 * skip; macOS/win32 need their own real-machine drills.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn as nodeSpawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createRemoteForwardService } from '../../remote-forward-service.ts'
import type {
  ForwardServiceStorage,
  ForwardSpawnOptions,
  ForwardSpawnProcessHandle,
} from '../../remote-forward-service.ts'
import type { ShellIpcCtx } from '../../shell-ipc-ctx.ts'
import type { TransportInstanceSpec, TransportSpawnLease } from '../../transport-provider.ts'
import { isForwardRequestResult } from '../../../dsh-chamber-wire/src/forward.ts'

const SOURCE_ID = 'dsh-web-1'
const FINGERPRINT = 'a'.repeat(64)

class MemoryFile {
  text: string | null = null
  async read(): Promise<string | null> { return this.text }
  async write(text: string): Promise<void> { this.text = text }
  async verifyOwner(): Promise<boolean> { return true }
}

function writeFakeSsh(dir: string): string {
  const file = path.join(dir, 'fake-ssh.js')
  const script = [
    '#!' + process.execPath,
    "const net = require('node:net')",
    'const argv = process.argv.slice(2)',
    "const at = argv.indexOf('-L')",
    "const spec = at >= 0 ? argv[at + 1] : ''",
    'const match = /^(127\\.0\\.0\\.[0-9]+):([0-9]+):127\\.0\\.0\\.1:([0-9]+)$/.exec(spec)',
    'if (match === null) process.exit(2)',
    "const server = net.createServer(socket => {",
    "  const upstream = net.connect(Number(match[3]), '127.0.0.1')",
    "  socket.on('error', () => upstream.destroy())",
    "  upstream.on('error', () => socket.destroy())",
    "  socket.pipe(upstream).pipe(socket)",
    '})',
    'server.on("error", () => process.exit(3))',
    'server.listen(Number(match[2]), match[1])',
    "const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 200).unref() }",
    "process.on('SIGTERM', stop)",
    "process.on('SIGINT', stop)",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n')
  writeFileSync(file, script, { mode: 0o755 })
  chmodSync(file, 0o755)
  return file
}

function makeContext(dir: string, instance: TransportInstanceSpec): ShellIpcCtx {
  const deps = {
    ipc: { handle: (): void => {} },
    ctx: {
      localDshHome: path.join(dir, 'state', 'dsh-home'),
      transportManager: { listInstances: () => [instance] },
    },
    edges: {
      openExternal: async (): Promise<void> => {},
      showMessage: async (): Promise<number> => 1,
    },
  }
  return {
    deps,
    captureVscodeSource: () => null,
    matchesNotificationSource: () => true,
    ownsNotificationSource: () => true,
  } as unknown as ShellIpcCtx
}

test('real child: spawn -> /proc start time -> ledger -> bind/probe -> release', { skip: process.platform !== 'linux' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-forward-spawn-'))
  const previousPath = process.env.PATH
  try {
    const fakeSsh = writeFakeSsh(dir)
    const instance: TransportInstanceSpec = {
      id: 'web-1',
      label: 'web-1',
      kind: 'dsh',
      transport: 'ssh',
      host: 'dev.example.com',
      user: 'root',
      sshPort: null,
      remotePort: 17520,
      serviceName: null,
      remoteDshHome: null,
      insecureHttp: false,
    }
    let leases = 0
    const lease: TransportSpawnLease = {
      env: { SSH_ASKPASS: path.join(dir, 'askpass'), SSH_ASKPASS_REQUIRE: 'force' },
      release: () => { leases += 1 },
    }
    const ledgerFile = new MemoryFile()
    const storage: ForwardServiceStorage = {
      namespace: new MemoryFile(),
      ledger: ledgerFile,
      enablement: new MemoryFile(),
    }
    const targetPort = 27123
    let spawnOptions: ForwardSpawnOptions | null = null
    const service = createRemoteForwardService(makeContext(dir, instance), {
      dataDir: dir,
      storage,
      browserEnabled: { isEnabled: () => true, markEnabled: (): void => {} },
      authLease: () => lease,
      spawn: (_command: string, args: readonly string[], options: ForwardSpawnOptions): ForwardSpawnProcessHandle => {
        spawnOptions = options
        return nodeSpawn(fakeSsh, args, options) as unknown as ForwardSpawnProcessHandle
      },
      platform: 'linux',
      mintId: () => 'fwd-0000000000000001',
      mintNamespace: () => 0,
      probeTimeoutMs: 2_000,
      probeIntervalMs: 50,
      releaseTimeoutMs: 2_000,
      reconnect: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
      reapOnStart: false,
    })

    const requested = await service.request({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, port: targetPort })
    assert.equal(isForwardRequestResult(requested), true)
    assert.equal(requested.ok, true)
    if (!requested.ok) return
    assert.equal(requested.record.state, 'bound')
    assert.equal(requested.record.targetPort, targetPort)
    const captured = spawnOptions as ForwardSpawnOptions | null
    assert.ok(captured !== null, 'the real spawn seam was called')
    assert.equal(captured.shell, false)
    assert.equal(captured.detached, true)
    assert.equal(captured.env.SSH_ASKPASS, path.join(dir, 'askpass'))
    assert.equal(captured.env.SSH_ASKPASS_REQUIRE, 'force')
    const aliasOctets = requested.record.aliasHost.split('.')
    assert.deepEqual(aliasOctets.slice(0, 3), ['127', '0', '0'])
    const aliasOctet = Number(aliasOctets[3])
    assert.ok(aliasOctet >= 2 && aliasOctet <= 254, 'alias is 127.0.0.2..254')
    const children = JSON.parse(ledgerFile.text ?? '{"children":[]}') as { children: Array<{ argv?: unknown[] }> }
    assert.equal(children.children.length, 1, 'the ledger record is written before the launch is reported')
    assert.equal(children.children[0]?.argv?.[0], 'ssh', 'the ledger records the full spawned argv')

    const released = await service.release({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: requested.record.id })
    assert.equal(released.ok, true)
    for (let i = 0; i < 40; i += 1) await new Promise(resolve => setTimeout(resolve, 50))
    const after = JSON.parse(ledgerFile.text ?? '{"children":[]}') as { children: unknown[] }
    assert.equal(after.children.length, 0, 'a stopped child removes its ledger record')
    assert.equal(leases, 1, 'the askpass lease is released exactly once')
    await service.dispose()
  } finally {
    process.env.PATH = previousPath
    rmSync(dir, { recursive: true, force: true })
  }
})
