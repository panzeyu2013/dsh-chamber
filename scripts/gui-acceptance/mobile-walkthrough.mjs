#!/usr/bin/env node
/**
 * CDP 移动档走查（`--mobile`；STATUS 2026-09-13 移动档开放项 ⑤ / design 17 §18.6
 * 「CDP 设备模拟 + 真机抽检」里**缺失的那一半**）。
 *
 * 与桌面走查（walkthrough.mjs）的关系：同一条 CDP 连接方式（`./cdp.mjs` 的
 * `discoverPageTarget` + `CdpSession`，零依赖、Node 内置 fetch/WebSocket）、
 * 同一套产物纪律（报告 md+json、截图只作**视觉**证据、判定全部结构化）。差别只在
 * 开头三步与断言清单：
 *   1. `Emulation.setDeviceMetricsOverride`（默认 390×844 / DPR 3 / mobile:true）
 *   2. `Emulation.setTouchEmulationEnabled`（**这是 `(pointer:coarse)`/`(hover:none)`
 *      唯一可靠的来源**——`Emulation.setEmulatedMedia` 的 pointer/hover 特性被
 *      Chromium 忽略，本机实测，见 mobile-checks.mjs 文件头）
 *   3. 重新加载（模拟是会话级、跨导航保留），随后只做**只读测量**
 *
 * 断言（结构化，不靠截图；判据纯函数在 mobile-checks.mjs）：
 *   M-1 设备模拟生效（含 pointer:coarse / hover:none / 手机档媒体查询）
 *   M-2 无横向溢出（设备宽基准 + task 的 innerWidth 断言；收缩适配时明确标注）
 *   M-3 会话头首行高度 ≤ 48px
 *   M-4 会话头内无「单字换行」（行盒数 + 高度启发式，lineage count 单列）
 *   M-5 会话头内所有 button 命中盒 ≥ 44px
 *   M-6 插件激活观察（[data-mobile-frame] 打标；观察项，不判失败）
 *   M-7 WebSocket 帧捕获（`Network.webSocketFrameSent/Received`，落盘 JSON）
 *   M-8 走查期间的控制台/网络观察（观察项，判定沿用桌面走查的容忍表）
 *
 * 凭据：**没有任何硬编码**。要访问认证过的 gateway 时只从环境变量读：
 *   --auth-token-env <NAME>（默认 DSH_MOBILE_AUTH_TOKEN）→ `Authorization: Bearer <值>`
 *   --cookie-env <NAME>     （默认 DSH_MOBILE_COOKIE）    → `Cookie: <值>`
 * 值只用于 `Network.setExtraHTTPHeaders`，**永不打印**（只打印变量名与长度），
 * 并且在 WS 帧落盘前过一遍脱敏（mobile-checks.redactSecrets）。
 *
 * 没有真机、没有凭据、没有实例时**优雅失败**：打印缺什么、需要什么、怎么给，
 * 写一份只含 INFO 的报告，exit 0（`--require-run` 时 exit 1）——判定语义与
 * run.mjs 一致：INFO = 本次未执行，永不冒充通过。
 *
 * 用法：
 *   node scripts/gui-acceptance/mobile-walkthrough.mjs --cdp-port 9333
 *   node scripts/gui-acceptance/mobile-walkthrough.mjs --cdp-port 9333 --url http://127.0.0.1:17500/
 *   node scripts/gui-acceptance/mobile-walkthrough.mjs --ws-frames full --out .tmp/mobile
 *
 * exit-code：0 = 无 FAIL（含 INFO/环境不可用）；1 = 有断言 FAIL 或 --require-run
 * 下未执行；2 = 用法错误。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { CdpSession, discoverPageTarget } from './cdp.mjs'
import {
  KNOWN_UPSTREAM_BOOT_NOISE, TOLERATED_REQUEST_FAILURES, createRecorder, partitionFailures,
  renderMarkdown, summarize, summarizeNetFailures,
} from './checks.mjs'
import {
  DEVICE_FACTS_EXPRESSION, HEADER_FACTS_EXPRESSION, MOBILE_DEVICE, deviceEmulationSteps,
  deviceEmulationVerdict, headerFirstRowVerdict, headerWrapVerdict, hitBoxVerdict,
  overflowVerdict, pluginActivationVerdict, redactSecrets, summarizeWebSocketFrames,
} from './mobile-checks.mjs'

const ROOT_MOUNTED = `document.querySelector('#root') !== null && document.querySelector('#root').children.length > 0`
/** 单帧落盘上限（base64 图片/大 JSON 会把帧文件撑爆；完整长度另记）。 */
const DEFAULT_FRAME_CAP = 8_000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 从环境变量读凭据并装成请求头。**永不返回/打印值**——只回传头对象与一句
 * 可打印的说明（变量名 + 长度）。
 *
 * @returns {{headers: object, notes: string[], secrets: string[]}}
 */
export function buildCredentialHeaders({ authTokenEnv = 'DSH_MOBILE_AUTH_TOKEN', cookieEnv = 'DSH_MOBILE_COOKIE', env = process.env } = {}) {
  const headers = {}
  const notes = []
  const secrets = []
  const token = env[authTokenEnv]
  if (typeof token === 'string' && token.length > 0) {
    headers.Authorization = `Bearer ${token}`
    secrets.push(token)
    notes.push(`凭据：已从环境变量 ${authTokenEnv} 读取（${token.length} 字符；值不打印）→ Authorization: Bearer ***`)
  }
  const cookie = env[cookieEnv]
  if (typeof cookie === 'string' && cookie.length > 0) {
    headers.Cookie = cookie
    secrets.push(cookie)
    notes.push(`凭据：已从环境变量 ${cookieEnv} 读取（${cookie.length} 字符；值不打印）→ Cookie: ***`)
  }
  if (notes.length === 0) {
    notes.push(`凭据：未提供（${authTokenEnv} / ${cookieEnv} 均为空）。匿名/回环实例不需要；认证过的 gateway 需要其中之一——`
      + '本走查不会、也无法自己登录，缺凭据时页面停在登录页，几何断言会如实报「没有会话头」')
  }
  return { headers, notes, secrets }
}

/**
 * 把 CDP 事件流里的 WebSocket 帧收进数组（纯收集，判定在 mobile-checks）。
 * @returns {{frames: object[], stop: () => void}}
 */
function collectWebSocketFrames(session, { cap = DEFAULT_FRAME_CAP } = {}) {
  const frames = []
  const onMessage = message => {
    const params = message.params ?? {}
    if (message.method === 'Network.webSocketCreated') {
      frames.push({ direction: 'created', url: params.url, at: params.timestamp ?? null })
      return
    }
    if (message.method === 'Network.webSocketClosed') {
      frames.push({ direction: 'closed', at: params.timestamp ?? null })
      return
    }
    if (message.method === 'Network.webSocketFrameError') {
      frames.push({ direction: 'error', error: params.errorMessage, at: params.timestamp ?? null })
      return
    }
    if (message.method === 'Network.webSocketFrameSent' || message.method === 'Network.webSocketFrameReceived') {
      const response = params.response ?? {}
      const payload = String(response.payloadData ?? '')
      frames.push({
        direction: message.method === 'Network.webSocketFrameSent' ? 'sent' : 'received',
        opcode: response.opcode,
        payloadLength: payload.length,
        truncated: payload.length > cap,
        payload: payload.slice(0, cap),
        at: params.timestamp ?? null,
      })
    }
  }
  session.onMessage(onMessage)
  return { frames, stop: () => {} }
}

/**
 * 目标发现（复用 `cdp.mjs` 的发现器；`--url` 只用来**优先**挑对目标）。
 *
 * 三级：① URL 前缀命中的页面目标（导航前的位置）；② 仓库约定的回环 http 目标；
 * ③ 任意 page 目标（`--url` 指向的地址与页面当前位置不同时走这一级，会打印
 * 警告）。都找不到返回 null，由调用方走「环境不可用」的 fail-soft 路径。
 *
 * @returns {Promise<object|null>}
 */
async function discoverMobileTarget(cdpPort, url) {
  if (url !== null) {
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    try {
      const target = await discoverPageTarget(cdpPort, { urlPattern: new RegExp(`^${escaped}`), timeoutMs: 8_000 })
      console.log(`# CDP 目标（--url 前缀命中）：${target.url}`)
      return target
    } catch { /* 回落到下一级 */ }
  }
  try {
    const target = await discoverPageTarget(cdpPort, { timeoutMs: 8_000 })
    console.log(`# CDP 目标（回环 http 约定命中）：${target.url}`)
    return target
  } catch { /* 回落到下一级 */ }
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
    const target = list.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl !== undefined) ?? null
    if (target !== null) console.warn(`# 警告：未命中 --url 前缀/回环约定，改用第一个 page 目标 ${target.url}（随后按 --url 导航）`)
    return target
  } catch {
    return null
  }
}

/**
 * 跑一次移动档走查。
 *
 * @param {object} opts
 * @param {number} opts.cdpPort - 已带 `--remote-debugging-port` 的浏览器 CDP 端口（约定 9333）
 * @param {string} opts.outDir - 产物目录（报告/截图/WS 帧）
 * @param {string|null} opts.url - 可选：先导航到该 URL（认证 gateway 的移动入口）
 * @param {object} opts.device - 设备模型（`--width/--height/--dpr` 组装）
 * @param {'off'|'summary'|'full'} opts.wsFrames - 帧输出档
 * @param {boolean} opts.requireRun - 未执行（INFO）计为 FAIL（对应 run.mjs 的 --require-hover）
 * @param {string} opts.authTokenEnv - Bearer 凭据的环境变量名（值永不打印）
 * @param {string} opts.cookieEnv - Cookie 头的环境变量名（值永不打印）
 * @returns {Promise<{results: object[], reportPath: string, framesPath: string|null, shots: string, passed: number, failed: number, info: number, skipped: boolean}>}
 */
export async function runMobileWalkthrough({
  cdpPort = 9333,
  outDir = '.tmp/gui-acceptance-mobile',
  url = null,
  device = MOBILE_DEVICE,
  wsFrames = 'summary',
  requireRun = false,
  authTokenEnv = 'DSH_MOBILE_AUTH_TOKEN',
  cookieEnv = 'DSH_MOBILE_COOKIE',
  settleMs = 2_000,
  frameCap = DEFAULT_FRAME_CAP,
  env = process.env,
} = {}) {
  const rec = createRecorder()
  const shots = path.join(outDir, 'shots')
  mkdirSync(shots, { recursive: true })

  const credentials = buildCredentialHeaders({ authTokenEnv, cookieEnv, env })
  for (const note of credentials.notes) console.log(`# ${note}`)

  // ---- 连接：失败即「环境不可用」，打印需要什么，写 INFO 报告后返回 ----
  let target = null
  let connectError = null
  try {
    target = await discoverMobileTarget(cdpPort, url)
  } catch (error) {
    connectError = error
  }
  if (target === null) {
    const reason = connectError === null
      ? `/json/list 在 ${cdpPort} 上没有应答或没有 page 目标`
      : String(connectError?.message ?? connectError)
    const requirement = [
      `CDP 端口 ${cdpPort} 上没有可走的页面目标：${reason}`,
      '需要什么（任选其一）：',
      `  1) 一个开着远程调试端口的浏览器/Electron，且页面停在移动入口：例如 dev 实例 `,
      `     （packages/desktop 的 electron-dev 流程）带 --remote-debugging-port=${cdpPort}；`,
      `  2) 认证过的 gateway：额外给 --url <origin> 与凭据环境变量 ${authTokenEnv}（Bearer）或 ${cookieEnv}（Cookie）。`,
      '不需要真机：设备尺寸/DPR/触控都由 CDP 模拟（Emulation.*）。',
      '本脚本不会自己启动实例、不会登录、不会读任何硬编码凭据。',
    ].join('\n')
    console.log(requirement)
    rec.add('M-0', '走查环境（CDP 目标）', requireRun ? false : null, requirement)
    const reportPath = writeReport({ outDir, target: null, cdpPort, url, results: rec.results, frames: null, notes: [requirement] })
    return {
      results: rec.results, reportPath, framesPath: null, shots, skipped: true,
      ...summarize(rec.results),
    }
  }

  console.log(`# CDP 移动走查目标 ${target.url}（${target.title}）`)
  const session = await CdpSession.connect(target.webSocketDebuggerUrl)
  const ws = collectWebSocketFrames(session, { cap: frameCap })
  await session.enableObservation()
  if (Object.keys(credentials.headers).length > 0) {
    await session.send('Network.setExtraHTTPHeaders', { headers: credentials.headers })
  }

  const shot = async name => { await session.screenshot(path.join(shots, `${name}.png`)); return `${name}.png` }

  try {
    if (url !== null) {
      await session.send('Page.navigate', { url })
      await sleep(1_500)
    }
    // ---- 设备模拟（模拟是会话级；reload 后仍生效，实测） ----
    for (const step of deviceEmulationSteps(device)) await session.send(step.method, step.params)
    await session.reload()
    await sleep(3_000)
    session.beginObservationWindow()
    await session.waitFor(ROOT_MOUNTED, 'shell mounted', { timeoutMs: 30_000 }).catch(() => {})
    await sleep(settleMs)

    const deviceFacts = await session.evaluate(DEVICE_FACTS_EXPRESSION)
    await shot('M1-device')
    const emulation = deviceEmulationVerdict(deviceFacts, device)
    rec.add('M-1', '设备模拟生效（390×844@3x + 触控 ⇒ pointer:coarse / hover:none）', emulation.ok, emulation.evidence)

    const overflow = overflowVerdict(deviceFacts, device)
    rec.add('M-2', '无横向溢出（设备宽基准；task 的 innerWidth 断言一并报告）', overflow.ok, overflow.evidence)

    const activation = pluginActivationVerdict(deviceFacts)
    rec.add('M-6', '移动插件激活（观察项：[data-mobile-frame] 打标）', activation.ok, activation.evidence)

    // ---- 会话头几何（无会话 ⇒ INFO，不冒充通过） ----
    const headerFacts = await session.evaluate(HEADER_FACTS_EXPRESSION)
    await shot('M2-header')
    const firstRow = headerFirstRowVerdict(headerFacts)
    rec.add('M-3', `会话头首行高度 ≤ 48px（实测，无会话则 INFO）`, firstRow.ok, firstRow.evidence)
    const wrap = headerWrapVerdict(headerFacts)
    rec.add('M-4', '会话头内无「单字换行」（行盒数 + 高度启发式）', wrap.ok, wrap.evidence)
    const hitBox = hitBoxVerdict(headerFacts)
    rec.add('M-5', '会话头内所有 button 命中盒 ≥ 44px', hitBox.ok, hitBox.evidence)

    // ---- 观察项：帧 + 控制台/网络（沿用桌面走查的容忍表） ----
    await sleep(1_000)
    const frameSummary = summarizeWebSocketFrames(ws.frames)
    rec.add('M-7', 'WebSocket 帧捕获（会话打开停滞的证据来源）', null,
      `${frameSummary.summary}\n（帧自 CDP 连接起累计——含 reload 前的那一次连接；完整帧见报告旁 mobile-ws-frames.json，已脱敏；--ws-frames full 可逐帧打印）`)
    if (wsFrames === 'full') {
      for (const frame of ws.frames) {
        console.log(`[WS] ${frame.direction} opcode=${frame.opcode ?? '-'} len=${frame.payloadLength ?? '-'} ${redactSecrets(frame.payload ?? frame.url ?? frame.error ?? '', credentials.secrets).slice(0, 300)}`)
      }
    }

    const net = partitionFailures([...session.netFailures.keys()], TOLERATED_REQUEST_FAILURES)
    const consolePartition = partitionFailures(session.consoleErrors, KNOWN_UPSTREAM_BOOT_NOISE)
    rec.add('M-8', '走查期间的 ≥400 请求与渲染层 error（观察项）', null,
      [`未预期网络：${net.unexpected.slice(0, 5).join(' | ') || '（无）'}`,
        `已登记容忍：${net.tolerated.slice(0, 3).join(' | ') || '（无）'}`,
        `未预期 console error：${consolePartition.unexpected.slice(0, 3).join(' | ') || '（无）'}`,
        `已登记上游噪声：${consolePartition.tolerated.slice(0, 2).join(' | ') || '（无）'}`].join('\n'))

    // ---- 帧落盘（脱敏后） ----
    const framesPath = path.join(outDir, 'mobile-ws-frames.json')
    writeFileSync(framesPath, JSON.stringify({
      meta: { target: target.url, cdpPort, at: new Date().toISOString() },
      counts: frameSummary.counts,
      frames: ws.frames.map(frame => ({ ...frame, payload: frame.payload === undefined ? undefined : redactSecrets(frame.payload, credentials.secrets) })),
    }, null, 2))

    const reportPath = writeReport({
      outDir, target, cdpPort, url, device,
      results: rec.results,
      frames: { summary: frameSummary.summary, counts: frameSummary.counts, file: framesPath },
      netFailures: summarizeNetFailures(session.netFailures),
      consoleErrors: session.consoleErrors.map(error => redactSecrets(error, credentials.secrets)),
      consoleWarnings: session.consoleWarnings.map(warning => redactSecrets(warning, credentials.secrets)),
      notes: credentials.notes,
    })
    const counts = summarize(rec.results)
    console.log(`\n=== 移动走查：${counts.passed} pass / ${counts.failed} fail / ${counts.info} info / ${rec.results.length} checks ===\nreport: ${reportPath}\nws frames: ${framesPath}\nscreenshots: ${shots}`)
    return { results: rec.results, reportPath, framesPath, shots, skipped: false, ...counts }
  } finally {
    session.close()
  }
}

/** 写 markdown + json 报告（与桌面走查同形，便于同一套人读/机读流程）。 */
function writeReport({ outDir, target, cdpPort, url, device = MOBILE_DEVICE, results, frames, netFailures = [], consoleErrors = [], consoleWarnings = [], notes = [] }) {
  const meta = {
    目标: target === null ? '(无 CDP 目标)' : target.url,
    CDP端口: cdpPort,
    导航: url ?? '(未导航，走当前页面)',
    设备: `${device.width}×${device.height} @${device.deviceScaleFactor}x mobile=${device.mobile}`,
    时间: new Date().toISOString(),
    截图目录: path.join(outDir, 'shots'),
  }
  const report = renderMarkdown({ title: 'GUI 验收（移动档：CDP 设备模拟走查）', meta, results, netFailures, consoleErrors, consoleWarnings })
  const withFrames = frames === null ? report
    : `${report}\n\n## WebSocket 帧\n\n\`\`\`\n${frames.summary}\n\`\`\`\n\n完整帧文件：\`${frames.file}\`（计数 ${JSON.stringify(frames.counts)}）\n`
  const withNotes = notes.length === 0 ? withFrames : `${withFrames}\n\n## 凭据与环境\n\n${notes.map(note => `- ${note}`).join('\n')}\n`
  const reportPath = path.join(outDir, 'gui-mobile-walkthrough-report.md')
  writeFileSync(reportPath, withNotes)
  writeFileSync(path.join(outDir, 'gui-mobile-walkthrough-report.json'), JSON.stringify({
    meta, results, frames, netFailures, consoleErrors, consoleWarnings, notes,
  }, null, 2))
  return reportPath
}

// ---------------------------------------------------------------------------
// CLI（`node scripts/gui-acceptance/mobile-walkthrough.mjs …`）
// ---------------------------------------------------------------------------

const USAGE = `用法：node scripts/gui-acceptance/mobile-walkthrough.mjs [选项]

选项：
  --cdp-port <port>        CDP 端口（默认 9333，与桌面走查同约定）
  --out <dir>              产物目录（默认 .tmp/gui-acceptance-mobile）
  --url <origin>           先导航到该 URL（认证 gateway 的移动入口）
  --width/--height <px>    设备尺寸（默认 390 / 844）
  --dpr <n>                设备像素比（默认 3）
  --ws-frames <档>         WebSocket 帧输出：off | summary（默认）| full
  --auth-token-env <NAME>  从该环境变量读 Bearer 凭据（默认 DSH_MOBILE_AUTH_TOKEN；值永不打印）
  --cookie-env <NAME>      从该环境变量读 Cookie 头（默认 DSH_MOBILE_COOKIE；值永不打印）
  --require-run            未执行（INFO，例如没有 CDP 目标/没有会话）计为 FAIL ⇒ exit 1
  --help, -h               打印本用法并 exit 0

退出码：0 = 无 FAIL（含 INFO）；1 = 有 FAIL 或 --require-run 下未执行；2 = 用法错误。

不需要真机；没有凭据/实例时脚本会打印需要什么并优雅退出（不伪造通过）。`

/** CLI 入口（可被 import 的模块：只有本文件被 node 直接执行时才跑）。 */
async function main(argv) {
  let values
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'cdp-port': { type: 'string', default: '9333' },
        out: { type: 'string', default: '.tmp/gui-acceptance-mobile' },
        url: { type: 'string' },
        width: { type: 'string', default: String(MOBILE_DEVICE.width) },
        height: { type: 'string', default: String(MOBILE_DEVICE.height) },
        dpr: { type: 'string', default: String(MOBILE_DEVICE.deviceScaleFactor) },
        'ws-frames': { type: 'string', default: 'summary' },
        'auth-token-env': { type: 'string', default: 'DSH_MOBILE_AUTH_TOKEN' },
        'cookie-env': { type: 'string', default: 'DSH_MOBILE_COOKIE' },
        'require-run': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    }))
  } catch (error) {
    console.error(`${USAGE}\n用法错误：${String(error?.message ?? error)}`)
    process.exit(2)
  }
  if (values.help) { console.log(USAGE); process.exit(0) }
  if (!['off', 'summary', 'full'].includes(values['ws-frames'])) {
    console.error(`${USAGE}\n用法错误：--ws-frames 只能是 off|summary|full（得到 ${values['ws-frames']}）`)
    process.exit(2)
  }
  for (const key of ['width', 'height', 'dpr', 'cdp-port']) {
    if (!Number.isFinite(Number(values[key])) || Number(values[key]) <= 0) {
      console.error(`${USAGE}\n用法错误：--${key} 需要一个正数（得到 ${values[key]}）`)
      process.exit(2)
    }
  }
  const device = {
    ...MOBILE_DEVICE,
    width: Number(values.width),
    height: Number(values.height),
    deviceScaleFactor: Number(values.dpr),
  }
  const result = await runMobileWalkthrough({
    cdpPort: Number(values['cdp-port']),
    outDir: values.out,
    url: values.url ?? null,
    device,
    wsFrames: values['ws-frames'],
    requireRun: values['require-run'],
    authTokenEnv: values['auth-token-env'],
    cookieEnv: values['cookie-env'],
  })
  process.exit(result.failed > 0 ? 1 : 0)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
