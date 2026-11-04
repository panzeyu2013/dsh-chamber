/**
 * Transport-manager POSIX UDS mode (P2-1) over REAL sockets: the runtime
 * resolves the provider's socket path, skips the port allocator, probes and
 * verifies through the socket, projects transportSocket='unix' with
 * localPort=null, exposes readySocketPath() and keeps the crash ledger in
 * lockstep with the spawned child's lifetime.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTransportManager } from '../../transport-manager.ts'
import { sshProvider } from '../../ssh-provider.ts'
import { ensureSshSocketDirectory, sshSocketPath, sshUdsSupported } from '../../ssh-socket.ts'
import { sshChildrenDir } from '../../ssh-orphan.ts'
import { FakeChild, silentLogger, sleep, waitFor } from '../support/transport-manager-harness.ts'

function tempBase(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'transport-uds-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A UDS HTTP server that answers the dsh identity handshake like a real host. */
async function identityServer(socketPath: string) {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/session/canOpenWorkspacePath') {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        let envelope: { type?: unknown; rpcId?: unknown; method?: unknown } | null = null
        try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { envelope = null }
        if (envelope?.type === 'client-request' && envelope.method === 'session/canOpenWorkspacePath'
          && typeof envelope.rpcId === 'string') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: true } }))
          return
        }
        res.writeHead(400)
        res.end()
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(socketPath)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  return server
}

test('a POSIX ssh tunnel becomes ready through the UDS listener: no port allocation, unix projection', async (t) => {
  if (!sshUdsSupported()) { t.skip('win32 keeps the TCP tunnel shape'); return }
  const base = tempBase(t)
  const id = `uds-${String(process.pid)}-${String(Date.now())}`
  const socketPath = ensureSshSocketDirectory(sshSocketPath(id))
  const server = await identityServer(socketPath)
  t.after(() => { server.closeAllConnections?.(); server.close(); try { unlinkSync(socketPath) } catch { /* already gone */ } })

  let allocations = 0
  const spawnCalls: Array<{ args: readonly string[]; child: FakeChild }> = []
  const manager = createTransportManager({
    provider: sshProvider,
    spawnFn: (_command, args) => {
      const child = new FakeChild()
      spawnCalls.push({ args, child })
      return child
    },
    instancesFile: join(base, 'ssh-instances.json'),
    logger: silentLogger,
    allocatePort: async () => { allocations += 1; return 45_000 },
    options: { readyTimeoutMs: 2_000, probeIntervalMs: 20, retryBaseMs: 20, retryMaxMs: 40, maxRetryAttempts: 2 },
  })
  t.after(() => manager.dispose())
  manager.saveInstances([{ id, label: 'home', kind: 'dsh', transport: 'ssh', host: 'h.example.com', user: 'alice', remotePort: 2222 }])
  manager.connect(id)
  await waitFor(() => manager.status(id)?.phase === 'ready', 5_000, 'ready through the UDS identity probe')

  assert.equal(allocations, 0, 'a UDS tunnel never asks the port allocator')
  assert.equal(spawnCalls.length, 1)
  const forwardIndex = spawnCalls[0]!.args.indexOf('-L')
  assert.equal(spawnCalls[0]!.args[forwardIndex + 1], `${socketPath}:127.0.0.1:2222`)
  const status = manager.status(id)!
  assert.equal(status.transportSocket, 'unix')
  assert.equal(status.localPort, null)
  assert.equal(status.phase, 'ready')
  assert.equal(manager.readyUrl(id), 'http://127.0.0.1:2222', 'the URL names the remote loopback authority')
  assert.equal(manager.readySocketPath(id), socketPath, 'the dial target is the socket')

  // Leaving ready clears the socket projection: no consumer may keep dialling a dead listener.
  manager.disconnect(id)
  assert.equal(manager.status(id)!.transportSocket, 'tcp')
  assert.equal(manager.status(id)!.localPort, null)
  assert.equal(manager.readySocketPath(id), null)
  assert.equal(manager.readyUrl(id), null)
})

test('the crash ledger records a spawned child and removes it on exit', async (t) => {
  if (!sshUdsSupported()) { t.skip('the crash ledger is POSIX-only'); return }
  const base = tempBase(t)
  const id = `uds-orphan-${String(process.pid)}-${String(Date.now())}`
  const ledgerDir = join(base, 'state')
  const pid = 43_210
  const spawnCalls: Array<{ child: FakeChild }> = []
  const manager = createTransportManager({
    provider: sshProvider,
    spawnFn: () => {
      const child = new FakeChild()
      child.pid = pid
      spawnCalls.push({ child })
      return child
    },
    instancesFile: join(base, 'ssh-instances.json'),
    logger: silentLogger,
    sshOrphanStateDir: ledgerDir,
    portProbe: async () => true,
    verifyProbe: async () => ({ ok: true }),
    allocatePort: async () => { throw new Error('a UDS tunnel must not allocate a port') },
    options: { readyTimeoutMs: 2_000, probeIntervalMs: 20, retryBaseMs: 20, retryMaxMs: 40, maxRetryAttempts: 2 },
  })
  t.after(() => manager.dispose())
  manager.saveInstances([{ id, label: 'home', kind: 'dsh', transport: 'ssh', host: 'h.example.com', remotePort: 2222 }])
  manager.connect(id)
  await waitFor(() => manager.status(id)?.phase === 'ready', 5_000, 'ready (fake identity probe)')

  const recordPath = join(sshChildrenDir(ledgerDir), `${String(pid)}.json`)
  assert.equal(existsSync(recordPath), true, 'the spawned pid is ledgered before it can be orphaned')
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { pid: number; startedAt: number; target: string }
  assert.equal(record.pid, pid)
  assert.ok(Number.isFinite(record.startedAt) && record.startedAt > 0)
  assert.match(record.target, /h\.example\.com:2222/u)

  spawnCalls[0]!.child.simulateExit(0)
  await waitFor(() => !existsSync(recordPath), 3_000, 'a clean exit removes the ledger record')
  await sleep(10)
})
