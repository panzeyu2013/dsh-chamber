/**
 * ARCHIVED (2026-11, Electron frozen; docs/progress/electron-frozen.md): the local SSH
 * fixture feeds the archived Electron/CDP packaged/attached GUI legs; kept for revival.
 *
 * W-14b's local SSH fixture: a REAL transport path with no external host.
 *
 * WHY this exists: W-14b (design 28 §16.9) must prove a remote source's
 * loopback page embeds end to end — real SSH tunnel, per-source alias,
 * forward lifecycle. A real remote machine is not available to the acceptance
 * toolbox, so the fixture builds the whole chain on this host:
 *
 *   1. a throwaway sshd on its own port + temp host key/config/authorized_keys
 *      (never the user's ~/.ssh config; every path under <--out>/ssh-fixture);
 *   2. a throwaway ssh-agent holding a temp client key (the app's ssh children
 *      inherit SSH_AUTH_SOCK — no ~/.ssh identity writes);
 *   3. a throwaway remote dsh host (packages/desktop/vendor/dsh CLI, temp
 *      DSH_HOME, 127.0.0.1:<dshPort>) launched with the web profile;
 *   4. a loopback HTTP cookie-injecting proxy on 127.0.0.1:<remotePort>: the
 *      app's ssh tunnel terminates on this proxy. The dsh web profile gates
 *      /api + / behind the spawn-time browser-auth cookie (its launch token is
 *      only printed on that process's console). The fixture captures the token
 *      from the dsh's own stdout, exchanges it for the signed cookie, and the
 *      proxy pins Host/Origin to the dsh's own authority + injects the cookie,
 *      so the app's real SSH transport/verify/frontend path sees a normal dsh;
 *   5. a remote-loopback HTTP fixture page (127.0.0.1:<fixturePort>) that the
 *      panel forwards to: the iframe src is the per-source alias, the page
 *      posts its marker to the app document (engine-level proof);
 *   6. the dev userData is seeded with the app-owned known_hosts entry for the
 *      temp host key and the ssh-instances.json row (dsh + ssh + remotePort =
 *      proxy port), BEFORE the app launches.
 *
 * Everything is cleaned up by stop(): child processes killed, servers closed,
 * the agent killed. The temp tree stays under <--out> for post-mortem logs and
 * is gitignored like every other acceptance artifact.
 *
 * This is acceptance tooling, not product code: no IPC channel, no main seam.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startEmbedFixture } from './fixture.mjs'

/** Registry id / source id of the fixture source (dsh-<id>). */
export const SSH_FIXTURE_SOURCE_ID = 'ifx'

/** Host key line alias the app's ssh children look up (hostKeyAliasFor). */
function hostKeyAlias(host, port) {
  return host + ':' + String(port)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** One free loopback TCP port (listen 0 then close). */
async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise(resolve => server.close(resolve))
  return port
}

/** Resolve once something accepts a TCP connection on the port. */
async function waitForPort(port, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last = 'no answer'
  while (Date.now() < deadline) {
    const outcome = await new Promise(resolve => {
      const socket = netConnect({ host: '127.0.0.1', port })
      const finish = value => { socket.destroy(); resolve(value) }
      socket.once('connect', () => finish(true))
      socket.once('error', error => finish(error.code ?? 'error'))
      socket.setTimeout(500, () => finish('timeout'))
    })
    if (outcome === true) return
    last = String(outcome)
    await sleep(150)
  }
  throw new Error('ssh-fixture: ' + label + ' never listened on 127.0.0.1:' + String(port) + ' (' + last + ')')
}

function runOrThrow(command, args, options, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    throw new Error('ssh-fixture: ' + label + ' failed: ' + String(result.stderr ?? result.stdout ?? '').slice(0, 400))
  }
  return result
}

/**
 * Start the whole fixture. Call before the dev app launches (the registry and
 * known_hosts must exist at app boot), then install `env` into process.env so
 * the app's ssh children authenticate via the fixture agent.
 * @param opts.outDir - acceptance artifact dir (all fixture state lives under it)
 * @param opts.sourceId - registry id (source id becomes dsh-<id>)
 * @returns fixture facts + `stop()`.
 */
export async function startSshFixture({ outDir = '.tmp/gui-acceptance', sourceId = SSH_FIXTURE_SOURCE_ID } = {}) {
  const base = path.resolve(outDir, 'ssh-fixture')
  rmSync(base, { recursive: true, force: true })
  const sshDir = path.join(base, 'ssh')
  const remoteHome = path.join(base, 'remote-dsh-home')
  const workspacePath = path.join(base, 'workspace')
  for (const dir of [sshDir, remoteHome, workspacePath]) mkdirSync(dir, { recursive: true })
  const hostKey = path.join(sshDir, 'host_ed25519')
  const clientKey = path.join(sshDir, 'client_ed25519')
  runOrThrow('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey], {}, 'host keygen')
  runOrThrow('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey], {}, 'client keygen')

  const sshPort = await freePort()
  const dshPort = await freePort()
  const proxyPort = await freePort()
  const sshdConfig = path.join(sshDir, 'sshd_config')
  writeFileSync(sshdConfig, [
    'Port ' + String(sshPort),
    'ListenAddress 127.0.0.1',
    'HostKey ' + hostKey,
    'PidFile ' + path.join(sshDir, 'sshd.pid'),
    'AuthorizedKeysFile ' + path.join(sshDir, 'authorized_keys'),
    'StrictModes no',
    'PermitRootLogin yes',
    'PubkeyAuthentication yes',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'UsePAM no',
    'AllowTcpForwarding yes',
    'GatewayPorts no',
    'X11Forwarding no',
    'LogLevel VERBOSE',
    '',
  ].join('\n'))
  writeFileSync(path.join(sshDir, 'authorized_keys'), readFileSync(clientKey + '.pub'))
  try { mkdirSync('/run/sshd', { recursive: true }) } catch { /* exists or not needed */ }

  const sshdLog = openSync(path.join(sshDir, 'sshd.log'), 'a')
  const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', sshdConfig], { stdio: ['ignore', sshdLog, sshdLog] })
  closeSync(sshdLog)
  // A Unix-domain socket path must stay short (sun_path ~104 bytes): the repo
  // path under --out can exceed it, so the agent lives in a throwaway shortdir.
  const agentDir = mkdtempSync(path.join(tmpdir(), 'dsh-sshfixture-'))
  const agentSock = path.join(agentDir, 'agent.sock')
  const agentStart = runOrThrow('ssh-agent', ['-s', '-a', agentSock], {}, 'ssh-agent')
  const agentEnv = {}
  for (const line of String(agentStart.stdout).split('\n')) {
    if (line.startsWith('SSH_AUTH_SOCK=')) agentEnv.SSH_AUTH_SOCK = line.slice('SSH_AUTH_SOCK='.length).replace(/;.*$/u, '')
    if (line.startsWith('SSH_AGENT_PID=')) agentEnv.SSH_AGENT_PID = line.slice('SSH_AGENT_PID='.length).replace(/;.*$/u, '')
  }
  if (agentEnv.SSH_AUTH_SOCK !== agentSock) {
    throw new Error('ssh-fixture: ssh-agent did not create ' + agentSock)
  }
  runOrThrow('ssh-add', [clientKey], { env: { ...process.env, ...agentEnv } }, 'ssh-add')

  // The remote dsh must serve the CHAMBER host graph: without the seeded host
  // packages its client-plugin graph answers no rows, and the remote source's
  // UI providers (sidebar/right-sidebar/tabs) stay PENDING. Seed the same built
  // host packages the product's ssh seed path installs (design 13 M2), plus the
  // loader overlay that mounts them — the remote dsh is ours, so this is a local
  // copy before its first boot (open-in stays localOnly and is never remote).
  const seedPackages = [
    ['host-graph-package', '@dsh-chamber/dsh-chamber-seed-client-graph', 'client-graph'],
    ['host-git-worktree-package', '@dsh-chamber/dsh-chamber-seed-git-worktree', 'git-worktree'],
    ['host-archive-cleanup-package', '@dsh-chamber/dsh-chamber-seed-archive-cleanup', 'archive-cleanup'],
  ]
  const remoteModules = path.join(remoteHome, 'profiles', 'web', 'node_modules', '@dsh-chamber')
  mkdirSync(remoteModules, { recursive: true })
  const inserts = []
  for (const [dirName, packageName, insertId] of seedPackages) {
    const source = path.resolve('packages/desktop/dist', dirName)
    if (!existsSync(source)) throw new Error('ssh-fixture: built host package missing at ' + source + ' — run pnpm run build:host-packages first')
    cpSync(source, path.join(remoteModules, packageName.slice('@dsh-chamber/'.length)), { recursive: true })
    inserts.push({ id: insertId, name: packageName })
  }
  const overlayPath = path.join(base, 'remote-graph.patch.yml')
  const overlayLines = ['- insert:']
  for (const insert of inserts) {
    overlayLines.push('    - id: ' + insert.id)
    overlayLines.push("      name: '" + insert.name + "'")
  }
  overlayLines.push('')
  writeFileSync(overlayPath, overlayLines.join('\n'))

  const dshEntry = path.resolve('packages/desktop/vendor/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (!existsSync(dshEntry)) throw new Error('ssh-fixture: vendor dsh CLI missing at ' + dshEntry)
  const dshLog = openSync(path.join(base, 'remote-dsh.log'), 'a')
  const dsh = spawn(process.execPath, [dshEntry, '--profile', 'web', '--patch', overlayPath, '--host', '127.0.0.1', '--port', String(dshPort), '--trusted-host', '127.0.0.1:' + String(dshPort)], {
    cwd: remoteHome,
    env: {
      ...process.env,
      DSH_HOME: remoteHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      // Under an SSH launch marker the directory-picker resolves to the in-app
      // browse dialog — the same interaction the managed local instance uses,
      // so the remote view's workspace pick can be driven over CDP.
      SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0',
    },
    stdio: ['ignore', 'pipe', dshLog],
  })
  closeSync(dshLog)
  let dshOutput = ''
  let dshToken = null
  const onDshOutput = chunk => {
    dshOutput += chunk.toString('utf8')
    if (dshToken === null) {
      const match = /dsh web:\s*(https?:\/\/\S+)/u.exec(dshOutput)
      if (match !== null) {
        const launch = new URL(match[1])
        if (launch.searchParams.get('token') !== null) dshToken = launch.searchParams.get('token')
      }
    }
  }
  dsh.stdout.on('data', onDshOutput)

  const authority = '127.0.0.1:' + String(dshPort)
  /** GET /?token=... once: capture the signed cookie for the dsh authority. */
  const exchangeCookie = () => new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: dshPort,
      path: '/?token=' + encodeURIComponent(dshToken),
      method: 'GET',
      headers: { host: authority },
    }, response => {
      response.resume()
      response.on('end', () => {
        const cookies = response.headers['set-cookie'] ?? []
        const first = cookies[0] === undefined ? '' : cookies[0].split(';')[0]
        resolve(response.statusCode === 303 && first !== '' ? first : null)
      })
    })
    request.on('error', reject)
    request.end()
  })
  let cookie = ''
  const tokenDeadline = Date.now() + 90_000
  while (Date.now() < tokenDeadline && cookie === '') {
    if (dshToken !== null) {
      try { cookie = (await exchangeCookie()) ?? '' } catch { cookie = '' }
    }
    if (cookie === '') await sleep(250)
  }
  if (cookie === '') {
    throw new Error('ssh-fixture: could not exchange the remote dsh launch token for a cookie. dsh output tail: ' + dshOutput.slice(-600))
  }

  /** Rewrite one inbound header set for the dsh authority (Host/Origin/cookie). */
  const rewrittenHeaders = (rawHeaders, { upgrade = false } = {}) => {
    const headers = {}
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const key = String(rawHeaders[index]).toLowerCase()
      const name = rawHeaders[index]
      const value = rawHeaders[index + 1]
      if (key === 'host' || key === 'origin' || key === 'cookie') continue
      if (!upgrade && (key === 'connection' || key === 'upgrade' || key === 'keep-alive' || key === 'proxy-connection')) continue
      headers[name] = value
    }
    headers.host = authority
    headers.origin = 'http://' + authority
    headers.cookie = cookie
    return headers
  }
  const proxySockets = new Set()
  const proxy = createServer((request, response) => {
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: dshPort,
      path: request.url,
      method: request.method,
      headers: rewrittenHeaders(request.rawHeaders),
    }, upstreamResponse => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' })
      response.end('ssh-fixture: upstream dsh error')
    })
    request.pipe(upstream)
  })
  proxy.on('connection', socket => {
    proxySockets.add(socket)
    socket.on('close', () => proxySockets.delete(socket))
  })
  proxy.on('upgrade', (request, clientSocket, head) => {
    const headers = rewrittenHeaders(request.rawHeaders, { upgrade: true })
    headers.connection = 'Upgrade'
    headers.upgrade = request.headers.upgrade ?? 'websocket'
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: dshPort,
      path: request.url,
      method: request.method,
      headers,
    })
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      let raw = 'HTTP/1.1 101 Switching Protocols\r\n'
      for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
        raw += upstreamResponse.rawHeaders[index] + ': ' + upstreamResponse.rawHeaders[index + 1] + '\r\n'
      }
      raw += '\r\n'
      clientSocket.write(raw)
      if (upstreamHead !== undefined && upstreamHead.length > 0) clientSocket.write(upstreamHead)
      if (head !== undefined && head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(clientSocket)
      clientSocket.pipe(upstreamSocket)
      upstreamSocket.on('error', () => clientSocket.destroy())
      clientSocket.on('error', () => upstreamSocket.destroy())
    })
    upstream.on('response', upstreamResponse => {
      clientSocket.write('HTTP/1.1 ' + String(upstreamResponse.statusCode) + ' Bad Request\r\n\r\n')
      clientSocket.destroy()
    })
    upstream.on('error', () => clientSocket.destroy())
    upstream.end()
  })
  await new Promise((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(proxyPort, '127.0.0.1', resolve)
  })

  const fixturePage = await startEmbedFixture({ host: '127.0.0.1' })

  const hostPublic = runOrThrow('ssh-keygen', ['-y', '-f', hostKey], {}, 'host public key').stdout.trim()
  const parts = hostPublic.split(/\s+/u)
  if (parts.length < 2) throw new Error('ssh-fixture: unreadable temp host key')
  const userDataDir = path.resolve(outDir, 'dev-user-data')
  mkdirSync(path.join(userDataDir, 'ssh'), { recursive: true })
  const alias = hostKeyAlias('127.0.0.1', sshPort)
  writeFileSync(path.join(userDataDir, 'ssh', 'known_hosts'), alias + ' ' + parts[0] + ' ' + parts[1] + '\n', { mode: 0o600 })
  // Pre-grant the forward plane's per-(source, incarnation) port confirmation.
  // The FIRST forward request otherwise raises a native main-process dialog
  // (design 28 §6.6, no timeout) that a headless acceptance run can never
  // answer; the grant is keyed by (sourceId, sha256(kind|transport|host|user|
  // sshPort|remotePort)) and the deterministic namespace assignment below.
  // This is the same durable store the "打开系统浏览器" confirmation writes.
  const fixtureNamespace = 7
  const fixtureAlias = '127.0.0.' + String(2 + (fixtureNamespace % 253))
  const fixtureIdentity = createHash('sha256').update([
    'dsh', 'ssh', '127.0.0.1', 'root', String(sshPort), String(proxyPort),
  ].join('|')).digest('hex')
  const forwardDataDir = path.join(userDataDir, 'remote-browser')
  mkdirSync(forwardDataDir, { recursive: true })
  writeFileSync(path.join(forwardDataDir, 'remote-browser-namespaces.json'), JSON.stringify({
    version: 1,
    entries: [{
      sourceId: 'dsh-' + sourceId,
      namespace: fixtureNamespace,
      aliasHost: fixtureAlias,
      identity: fixtureIdentity,
      assignedAt: Date.now(),
      retiredAt: null,
    }],
  }, null, 2) + '\n', { mode: 0o600 })
  writeFileSync(path.join(forwardDataDir, 'remote-browser-enabled.json'), JSON.stringify({
    version: 1,
    entries: [{
      sourceId: 'dsh-' + sourceId,
      identity: fixtureIdentity,
      enabledAt: Date.now(),
      confirmedPorts: [String(fixtureNamespace) + ':' + String(fixturePage.port)],
    }],
  }, null, 2) + '\n', { mode: 0o600 })
  writeFileSync(path.join(userDataDir, 'ssh-instances.json'), JSON.stringify([{
    id: sourceId,
    kind: 'dsh',
    transport: 'ssh',
    label: 'SSH fixture',
    host: '127.0.0.1',
    user: 'root',
    sshPort,
    remotePort: proxyPort,
    serviceName: null,
    remoteDshHome: remoteHome,
    insecureHttp: false,
    spkiPin: null,
  }], null, 2) + '\n')

  /** Kill one child and wait for its exit (bounded); never throw during cleanup. */
  const killAndWait = async (child, signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise(resolve => child.once('exit', resolve))
    try { child.kill(signal) } catch { /* already gone */ }
    await Promise.race([exited, sleep(5_000)])
  }
  const waitForClosed = async (port, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const open = await new Promise(resolve => {
        const socket = netConnect({ host: '127.0.0.1', port })
        const finish = value => { socket.destroy(); resolve(value) }
        socket.once('connect', () => finish(true))
        socket.once('error', () => finish(false))
        socket.setTimeout(300, () => finish(false))
      })
      if (!open) return true
      await sleep(150)
    }
    return false
  }
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    for (const socket of proxySockets) {
      try { socket.destroy() } catch { /* gone */ }
    }
    await new Promise(resolve => proxy.close(() => resolve(undefined)))
    try { await fixturePage.close() } catch { /* gone */ }
    await killAndWait(dsh, 'SIGKILL')
    await killAndWait(sshd, 'SIGKILL')
    if (agentEnv.SSH_AGENT_PID !== undefined) {
      try { process.kill(Number(agentEnv.SSH_AGENT_PID), 'SIGTERM') } catch { /* gone */ }
    }
    try { rmSync(agentDir, { recursive: true, force: true }) } catch { /* gone */ }
    // Port reclamation is part of the fixture contract: the next run must be
    // able to bind the same names, and a leaked sshd/dsh would poison it.
    const reclaimed = await Promise.all([waitForClosed(sshPort, 5_000), waitForClosed(dshPort, 5_000)])
    if (reclaimed.some(open => open !== true)) {
      console.warn('ssh-fixture: a fixture listener did not close in time (sshd/dsh) — check <out>/ssh-fixture logs')
    }
  }

  // Only NOW wait for real listeners (processes are up; the app will connect after).
  await waitForPort(sshPort, 15_000, 'sshd')
  await waitForPort(dshPort, 15_000, 'remote dsh')
  await waitForPort(proxyPort, 5_000, 'cookie proxy')

  return {
    sourceId,
    sourceViewId: 'dsh-' + sourceId,
    sshPort,
    dshPort,
    remotePort: proxyPort,
    fixturePort: fixturePage.port,
    fixtureOrigin: fixturePage.origin,
    expectedAliasHost: fixtureAlias,
    expectedNamespace: fixtureNamespace,
    workspacePath,
    userDataDir,
    baseDir: base,
    env: agentEnv,
    stop,
  }
}
