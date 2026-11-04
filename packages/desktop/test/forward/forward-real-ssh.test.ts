/**
 * Real-SSH acceptance for the Remote Browser forward plane (Linux, root only).
 *
 * Unlike forward-spawn.test.ts (a fake ssh executable), this test starts a
 * throwaway OpenSSH server on 127.0.0.1, generates a client key, and lets the
 * production launcher run the REAL ssh -N -L command. It then fetches the
 * forwarded alias URL and proves the bytes traversed the SSH tunnel.
 *
 * Guarded to Linux + uid 0 because it starts sshd and writes a temporary HOME;
 * CI without those privileges skips. It never touches /etc/ssh, the system
 * sshd, or the user's real ~/.ssh.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { createRemoteForwardService } from '../../remote-forward-service.ts'
import type { ForwardServiceStorage } from '../../remote-forward-service.ts'
import type { ShellIpcCtx } from '../../shell-ipc-ctx.ts'
import type { TransportInstanceSpec } from '../../transport-provider.ts'
import { isForwardRequestResult } from '../../../dsh-chamber-wire/src/forward.ts'

const execFile = promisify(execFileCb)
const SSHD = '/usr/sbin/sshd'
const SSH_KEYGEN = '/usr/bin/ssh-keygen'
const SSH_CLIENT = '/usr/bin/ssh'
const SOURCE_ID = 'dsh-web-1'
const FINGERPRINT = 'a'.repeat(64)

class MemoryFile {
  text: string | null = null
  async read(): Promise<string | null> { return this.text }
  async write(text: string): Promise<void> { this.text = text }
  async verifyOwner(): Promise<boolean> { return true }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
    })
    if (ok) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('sshd did not listen on 127.0.0.1:' + String(port))
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

test('real ssh: sshd + real ssh -L -> alias fetch -> release', {
  skip: process.platform !== 'linux'
    || (typeof process.getuid === 'function' && process.getuid() !== 0)
    || !existsSync(SSHD)
    || !existsSync(SSH_KEYGEN)
    || !existsSync(SSH_CLIENT),
}, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-real-ssh-'))
  const sshConfigPath = path.join(dir, 'ssh_config')
  const wrapperPath = path.join(dir, 'ssh')
  const oldPath = process.env.PATH
  const oldAskpass = process.env.SSH_ASKPASS
  const oldAuthSock = process.env.SSH_AUTH_SOCK
  let sshd: ReturnType<typeof spawn> | null = null
  let target: http.Server | null = null
  let service: ReturnType<typeof createRemoteForwardService> | null = null
  try {
    const hostKey = path.join(dir, 'host_ed25519')
    const clientKey = path.join(dir, 'client_ed25519')
    await execFile(SSH_KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey])
    await execFile(SSH_KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey])
    const clientPub = readFileSync(clientKey + '.pub', 'utf8')
    writeFileSync(path.join(dir, 'authorized_keys'), clientPub, { mode: 0o600 })
    const sshPort = await freePort()
    const hostPub = readFileSync(hostKey + '.pub', 'utf8').trim()
    const knownHostsPath = path.join(dir, 'known_hosts')
    writeFileSync(knownHostsPath, '[127.0.0.1]:' + String(sshPort) + ' ' + hostPub + '\n', { mode: 0o600 })
    writeFileSync(sshConfigPath, [
      'Host *',
      '  IdentityFile ' + clientKey,
      '  UserKnownHostsFile ' + knownHostsPath,
      '  StrictHostKeyChecking yes',
      '  IdentitiesOnly yes',
      '',
    ].join('\n'), { mode: 0o600 })
    // The launcher spawns `ssh`; a tiny PATH wrapper pins the throwaway key and
    // host-key file without writing the passwd home (~/.ssh is read-only here).
    writeFileSync(wrapperPath, '#!/bin/sh\nexec /usr/bin/ssh -F ' + sshConfigPath + ' "$@"\n', { mode: 0o755 })
    process.env.PATH = dir + ':' + (oldPath ?? '')
    const config = [
      'Port ' + String(sshPort),
      'ListenAddress 127.0.0.1',
      'HostKey ' + hostKey,
      'PidFile ' + path.join(dir, 'sshd.pid'),
      'AuthorizedKeysFile ' + path.join(dir, 'authorized_keys'),
      'PermitRootLogin yes',
      'PubkeyAuthentication yes',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'ChallengeResponseAuthentication no',
      'UsePAM no',
      'StrictModes no',
      'AllowTcpForwarding yes',
      'GatewayPorts no',
      'LogLevel ERROR',
      'Subsystem sftp internal-sftp',
      '',
    ].join('\n')
    writeFileSync(path.join(dir, 'sshd_config'), config)
    let sshdErr = ''
    sshd = spawn(SSHD, ['-D', '-e', '-f', path.join(dir, 'sshd_config')], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    sshd.stderr?.on('data', (chunk: unknown) => { sshdErr = (sshdErr + String(chunk)).slice(-4096) })
    await waitPort(sshPort, 5_000)

    const targetBody = 'real-forward-ok'
    target = http.createServer((_request, response) => { response.end(targetBody) })
    await new Promise<void>((resolve) => target!.listen(0, '127.0.0.1', resolve))
    const targetAddress = target.address()
    const targetPort = typeof targetAddress === 'object' && targetAddress !== null ? targetAddress.port : 0
    assert.ok(targetPort > 0)

    delete process.env.SSH_ASKPASS
    delete process.env.SSH_AUTH_SOCK

    const instance: TransportInstanceSpec = {
      id: 'web-1',
      label: 'web-1',
      kind: 'dsh',
      transport: 'ssh',
      host: '127.0.0.1',
      user: 'root',
      sshPort,
      remotePort: 17520,
      serviceName: null,
      remoteDshHome: null,
      insecureHttp: false,
    }
    const ledgerFile = new MemoryFile()
    const storage: ForwardServiceStorage = {
      namespace: new MemoryFile(),
      ledger: ledgerFile,
      enablement: new MemoryFile(),
    }
    service = createRemoteForwardService(makeContext(dir, instance), {
      dataDir: dir,
      storage,
      browserEnabled: { isEnabled: () => true, markEnabled: (): void => {} },
      authLease: () => null,
      platform: 'linux',
      mintId: () => 'fwd-0000000000000001',
      mintNamespace: () => 0,
      probeTimeoutMs: 5_000,
      probeIntervalMs: 100,
      releaseTimeoutMs: 2_000,
      reconnect: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
      reapOnStart: false,
    })

    const requested = await service.request({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, port: targetPort })
    assert.equal(isForwardRequestResult(requested), true)
    assert.equal(requested.ok, true, 'the real ssh -L listener must bind (sshd stderr: ' + sshdErr + ')')
    if (!requested.ok) return
    if (requested.record.state !== 'bound') {
      console.error('real-ssh record:', JSON.stringify(requested.record), 'sshd stderr:', sshdErr)
    }
    assert.equal(requested.record.state, 'bound')
    assert.equal(requested.record.targetPort, targetPort)

    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get({ host: requested.record.aliasHost, port: requested.record.localPort, path: '/' }, (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => { text += chunk })
        response.on('end', () => resolve(text))
      })
      req.on('error', reject)
      req.setTimeout(5_000, () => { req.destroy(new Error('forwarded fetch timed out')) })
    })
    assert.equal(body, targetBody, 'the bytes must traverse the real SSH tunnel')

    const released = await service.release({ sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: requested.record.id })
    assert.equal(released.ok, true)
    for (let i = 0; i < 40; i += 1) await new Promise(resolve => setTimeout(resolve, 50))
    const children = JSON.parse(ledgerFile.text ?? '{"children":[]}') as { children: unknown[] }
    assert.equal(children.children.length, 0, 'the ledger record must be removed after release')
  } finally {
    try { await service?.dispose() } catch { /* best effort */ }
    if (target !== null) await new Promise<void>((resolve) => target!.close(() => resolve()))
    if (sshd !== null) {
      try { sshd.kill('SIGTERM') } catch { /* already gone */ }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    if (oldAskpass === undefined) delete process.env.SSH_ASKPASS
    else process.env.SSH_ASKPASS = oldAskpass
    if (oldAuthSock === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = oldAuthSock
    rmSync(dir, { recursive: true, force: true })
  }
})
