/**
 * `--live` acceptance: read-only probes against a RUNNING dsh-chamber.
 *
 * Works against the packaged app (no CDP, no dev instance) and against a dev
 * control plane: it only issues GET/HEAD, reads one SSE frame, and performs raw
 * HTTP upgrade handshakes. It never POSTs/PATCHes/DELETEs, so it is safe on a
 * live install with real sessions.
 */
import { request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  createRecorder, deriveSourceIds, hasSecurityHeaders, isHonestError, isInstanceIndex, isShellIndex,
  isWriterQuiescent, leakedFileContent, parseInstanceAssets, parsePluginLoaderUrls, parseShellAssets,
  renderMarkdown, safeJson, summarizeNetFailures, writerEvidence,
} from './checks.mjs'

/** Raw request target (fetch normalizes; the origin-form fence must see the raw one). */
function rawRequest(origin, target, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin)
    const request = httpRequest({ host: url.hostname, port: url.port, path: target, method, headers }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }))
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Raw WebSocket upgrade: the acceptance question is the HTTP answer (403 fence /
 * 101 accepted), not a working socket — so a raw handshake needs no WS client and
 * can carry a hostile Origin header, which the standard WebSocket constructor
 * cannot.
 */
function probeUpgrade(origin, target, originHeader) {
  return new Promise(resolve => {
    const url = new URL(origin)
    // A well-formed 16-byte key: a malformed one is answered 502 by the upstream
    // leg, which would look like a proxy failure instead of the fence under test.
    const key = randomBytes(16).toString('base64')
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      path: target,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': key,
        ...(originHeader === undefined ? {} : { origin: originHeader }),
      },
    })
    const done = outcome => { try { request.destroy() } catch { /* already gone */ } resolve(outcome) }
    request.on('upgrade', response => done({ status: 101, body: '' }))
    request.on('response', response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => done({ status: response.statusCode, body: body.slice(0, 200) }))
    })
    request.on('error', error => done({ status: 0, body: String(error?.message ?? error) }))
    request.end()
  })
}

/** Desktop connection registry path per platform (Electron userData convention). */
export function registryPath(env = process.env, home = homedir()) {
  const appDir = '@dsh-chamber/desktop'
  if (process.platform === 'darwin') return path.join(home, 'Library/Application Support', appDir, 'ssh-instances.json')
  if (process.platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData/Roaming'), appDir, 'ssh-instances.json')
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), appDir, 'ssh-instances.json')
}

/** Read ONLY ids/kinds from the registry — credentials and hosts never enter a report. */
export function configuredSourceIds(file = registryPath()) {
  if (!existsSync(file)) return []
  try { return deriveSourceIds(JSON.parse(readFileSync(file, 'utf8'))) } catch { return [] }
}

async function get(origin, target, init) {
  const response = await fetch(`${origin}${target}`, { redirect: 'manual', ...init })
  const body = await response.text()
  return { status: response.status, headers: Object.fromEntries(response.headers), body }
}

const headerList = headers => headers['content-type'] ?? ''

/**
 * Run every live probe.
 * @param opts.planeOrigin control-plane origin (default http://127.0.0.1:17500)
 * @param opts.instanceOrigin the managed dsh instance port (optional, for the credential fence)
 * @param opts.sourceIds remote source ids; defaults to the desktop registry
 * @param opts.outDir artifact directory (default .tmp/gui-acceptance)
 */
export async function runLiveAcceptance({
  planeOrigin = 'http://127.0.0.1:17500',
  instanceOrigin = 'http://127.0.0.1:17510',
  sourceIds,
  outDir = '.tmp/gui-acceptance',
  localInstanceId = 'local',
} = {}) {
  const rec = createRecorder()
  mkdirSync(outDir, { recursive: true })
  const artifacts = path.join(outDir, 'artifacts')
  mkdirSync(artifacts, { recursive: true })

  // ------------------------------------------------------------------ control plane
  const health = await get(planeOrigin, '/health')
  const healthJson = safeJson(health.body)
  rec.add('CP-1', 'GET /health 存活探针', health.status === 200 && healthJson !== null,
    `status=${health.status} body=${health.body.slice(0, 160)}`)
  const ready = healthJson?.dsh?.status === 'ready'

  const head = await rawRequest(planeOrigin, '/health', { method: 'HEAD' })
  rec.add('CP-2', 'HEAD /health（HEAD 孪生）', head.status === 200, `status=${head.status}`)

  const connections = await get(planeOrigin, '/api/connections')
  const row = safeJson(connections.body)?.connection
  rec.add('CP-3', 'GET /api/connections → 本地连接行', connections.status === 200 && row !== undefined,
    `status=${connections.status} row=${JSON.stringify(row)}`)

  const writers = await get(planeOrigin, '/api/connections/local/writers')
  if (writers.status === 404) {
    // The route landed 2026-09-10; a packaged build older than that legitimately
    // answers 404 — record the fact instead of failing the older build.
    rec.add('CP-4', '写者静默诊断路由（该构建无此路由）', null, `status=404 body=${writers.body.slice(0, 120)}`)
  } else {
    rec.add('CP-4', '写者静默诊断：无未证实写者', writers.status === 200 && isWriterQuiescent(writers.body),
      `status=${writers.status} ${writerEvidence(writers.body)}`)
  }

  const logs = await get(planeOrigin, '/api/host/logs?limit=5')
  const entries = safeJson(logs.body)
  const logRows = Array.isArray(entries) ? entries : entries?.entries ?? entries?.lines
  const logsOk = logs.status === 200 && Array.isArray(logRows) && logRows.length > 0
  if (ready) {
    rec.add('CP-5', 'GET /api/host/logs 可读', logsOk, `status=${logs.status} entries=${Array.isArray(logRows) ? logRows.length : 'n/a'}`)
  } else {
    rec.add('CP-5', 'GET /api/host/logs 可读（实例未就绪，跳过）', null,
      `status=${logs.status} body=${logs.body.slice(0, 120)}`)
  }

  const sse = await firstSseFrame(`${planeOrigin}/api/host/health-events`)
  rec.add('CP-6', 'GET /api/host/health-events SSE 首帧', sse.ok, sse.detail)

  const hostile = await get(planeOrigin, '/api/connections', { headers: { origin: 'https://evil.example' } })
  rec.add('CP-7', '敌意 Origin 被拒（403 origin_forbidden）',
    hostile.status === 403 && hostile.body.includes('origin_forbidden'), `status=${hostile.status} body=${hostile.body.slice(0, 120)}`)

  const ownOrigin = await get(planeOrigin, '/api/connections', { headers: { origin: planeOrigin } })
  rec.add('CP-8', '自身 Origin 放行', ownOrigin.status === 200, `status=${ownOrigin.status}`)

  const badTarget = await rawRequest(planeOrigin, '//etc/passwd')
  rec.add('CP-9', '非 origin-form 目标被拒', badTarget.status === 400 && !leakedFileContent(badTarget.body),
    `status=${badTarget.status} body=${badTarget.body.slice(0, 120)}`)

  const backslash = await rawRequest(planeOrigin, '/api/connections\\..\\etc')
  rec.add('CP-10', '反斜杠目标被拒', backslash.status === 400 || backslash.status === 404, `status=${backslash.status}`)

  // ------------------------------------------------------------------ static shell
  const shell = await get(planeOrigin, '/')
  const shellAssets = parseShellAssets(shell.body)
  rec.add('SH-1', '壳 index.html 服务', isShellIndex(shell.status, shell.body), `status=${shell.status} bytes=${shell.body.length} assets=${shellAssets.length}`)
  rec.add('SH-2', '壳安全响应头（design 04 §4.3）', hasSecurityHeaders(shell.headers),
    `csp=${(shell.headers['content-security-policy'] ?? '').slice(0, 70)}… xfo=${shell.headers['x-frame-options']}`)

  const shellAssetResults = []
  for (const asset of shellAssets) {
    const probe = await get(planeOrigin, asset)
    shellAssetResults.push(`${asset}→${probe.status}`)
  }
  rec.add('SH-3', '壳声明资源全部 200', shellAssetResults.length > 0 && shellAssetResults.every(item => item.endsWith('→200')),
    shellAssetResults.join(' '))

  const missing = await get(planeOrigin, `/assets/missing-${Date.now()}.js`)
  rec.add('SH-4', '缺失资源 404 JSON', missing.status === 404 && missing.body.includes('not_found'), `status=${missing.status}`)

  const deepPath = await get(planeOrigin, '/settings/connections')
  rec.add('SH-5', '深路径回落壳（SPA）', isShellIndex(deepPath.status, deepPath.body), `status=${deepPath.status} bytes=${deepPath.body.length}`)

  const traversalEncoded = await rawRequest(planeOrigin, '/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd')
  const traversalRaw = await rawRequest(planeOrigin, '/assets/../../../../etc/passwd')
  rec.add('SH-6', '静态路径穿越围栏',
    !leakedFileContent(traversalEncoded.body) && !leakedFileContent(traversalRaw.body),
    `encoded=${traversalEncoded.status} raw=${traversalRaw.status}`)

  // ---------------------------------------------------------------- instance proxy
  // Every /api/i/* and /api/host/logs probe needs a READY managed instance: while
  // it is starting (or stopped) the control plane answers 503 by design
  // (design 18 §3.4 quarantine), which is an environment fact, not an acceptance
  // failure. Control-plane and static-shell checks above are unaffected.
  if (!ready) {
    rec.add('IP-0', '实例就绪前提（其余实例面检查转为 INFO）', null,
      `dsh.status=${healthJson?.dsh?.status ?? 'unknown'}（design 18 §3.4 隔离期 503 属预期）`)
  }
  const instanceCheck = (id, title, ok, evidence) => {
    if (ready) return rec.add(id, title, ok, evidence)
    return rec.add(id, `${title}（实例未就绪，跳过）`, null, evidence)
  }

  const base = `/api/i/${localInstanceId}`
  const instance = await get(planeOrigin, `${base}/`)
  writeFileSync(path.join(artifacts, `${localInstanceId}.html`), instance.body)
  instanceCheck('IP-1', '实例反代根返回 dsh 前端', isInstanceIndex(instance.status, instance.body),
    `status=${instance.status} bytes=${instance.body.length}`)

  const instanceAssets = parseInstanceAssets(instance.body).slice(0, 4)
  const instanceAssetResults = []
  for (const asset of instanceAssets) {
    const probe = await get(planeOrigin, `${base}/${asset}`)
    instanceAssetResults.push(`${asset}→${probe.status}`)
  }
  instanceCheck('IP-2', '实例资源经 /api/i/<id> 反代', instanceAssets.length > 0 && instanceAssetResults.every(item => item.endsWith('→200')),
    instanceAssetResults.join(' ') || '（实例文档未取得，无声明资源可探）')

  const pluginUrls = parsePluginLoaderUrls(instance.body).slice(0, 3)
  const pluginResults = []
  for (const url of pluginUrls) {
    const probe = await get(planeOrigin, `${base}${url}`)
    pluginResults.push(`${probe.status} ${url.slice(0, 60)}…(${probe.body.length}B)`)
  }
  instanceCheck('IP-3', '多入口插件包按声明 URL 可取（含 rev）',
    pluginUrls.length > 0 && pluginResults.every(item => item.startsWith('200')), pluginResults.join(' | ') || '（无声明插件 URL）')

  const unknown = await get(planeOrigin, `/api/i/nonexistent-${Date.now()}/`)
  rec.add('IP-4', '未知实例诚实报错', isHonestError(unknown.status, unknown.body, 'instance_not_found'),
    `status=${unknown.status} body=${unknown.body.slice(0, 140)}`)

  const proxyTraversal = await rawRequest(planeOrigin, `${base}/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`)
  rec.add('IP-5', '实例代理路径穿越围栏', !leakedFileContent(proxyTraversal.body), `status=${proxyTraversal.status}`)

  const hostileUpgrade = await probeUpgrade(planeOrigin, `${base}/api/remote.mux`, 'https://evil.example')
  rec.add('IP-6', '升级请求敌意 Origin 被拒', hostileUpgrade.status === 403, JSON.stringify(hostileUpgrade).slice(0, 200))

  const ownUpgrade = await probeUpgrade(planeOrigin, `${base}/api/remote.mux`, planeOrigin)
  instanceCheck('IP-7', '升级请求自身 Origin 被接受（101）', ownUpgrade.status === 101, `status=${ownUpgrade.status}`)

  // ------------------------------------------------------------------ remote sources
  const sources = sourceIds ?? configuredSourceIds()
  rec.add('MX-1', '桌面注册表中的来源（只读 id/kind）', null,
    sources.length === 0 ? '未读到注册表（可用 --sources 显式给出）' : `count=${sources.length} ids=${sources.join(',')}`)

  if (sources.length > 0) {
    const ready = []
    const unavailable = []
    for (const sourceId of sources) {
      const probe = await get(planeOrigin, `/api/i/${sourceId}/`)
      if (isInstanceIndex(probe.status, probe.body)) {
        const asset = parseInstanceAssets(probe.body)[0]
        const assetProbe = asset === undefined ? { status: 'n/a' } : await get(planeOrigin, `/api/i/${sourceId}/${asset}`)
        ready.push(`${sourceId}(asset=${assetProbe.status})`)
      } else {
        unavailable.push(`${sourceId}:${probe.status}${probe.body.includes('instance_unavailable') ? '(instance_unavailable)' : ''}`)
      }
    }
    rec.add('MX-2', '每个来源经同源前缀返回自己的前端', ready.length > 0 && ready.length + unavailable.length === sources.length,
      `ready=${ready.length} unavailable=${unavailable.length} :: ${[...ready, ...unavailable].join(' | ').slice(0, 700)}`)
  }

  // ------------------------------------------------------------- instance credential fence
  if (instanceOrigin !== '' && instanceOrigin !== planeOrigin) {
    const direct = await get(instanceOrigin, '/')
    rec.add('IN-1', '实例端口无凭据直连被拒（401）', direct.status === 401, `status=${direct.status} body=${direct.body.slice(0, 100)}`)
  }

  // ------------------------------------------------------------------------- report
  const results = rec.results
  const counts = { passed: rec.passed, failed: rec.failed }
  const report = renderMarkdown({
    title: 'GUI 验收（--live：运行中应用只读探测）',
    meta: { 控制面: planeOrigin, 本地实例: instanceOrigin, 时间: new Date().toISOString() },
    results,
  })
  const reportPath = path.join(outDir, 'gui-live-report.md')
  writeFileSync(reportPath, report)
  writeFileSync(path.join(outDir, 'gui-live-report.json'), JSON.stringify({ meta: { planeOrigin, instanceOrigin, sources }, results }, null, 2))
  console.log(`\n=== --live: ${counts.passed} pass / ${counts.failed} fail / ${results.length} checks ===\nreport: ${reportPath}`)
  return { results, reportPath, passed: counts.passed, failed: counts.failed }
}

/** Read exactly one SSE frame (then abort) — enough to prove the push channel lives. */
async function firstSseFrame(url, timeoutMs = 5_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: controller.signal })
    if (response.status !== 200 || !headerList(Object.fromEntries(response.headers)).includes('text/event-stream')) {
      return { ok: false, detail: `status=${response.status} content-type=${response.headers.get('content-type')}` }
    }
    const reader = response.body.getReader()
    const { value } = await reader.read()
    const chunk = new TextDecoder().decode(value ?? new Uint8Array())
    const ok = /^data: /m.test(chunk) && chunk.includes('"dsh"')
    return { ok, detail: `firstFrame=${ok} bytes=${chunk.length}` }
  } catch (error) {
    return { ok: false, detail: `no frame: ${String(error?.message ?? error)}` }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

export { summarizeNetFailures }
