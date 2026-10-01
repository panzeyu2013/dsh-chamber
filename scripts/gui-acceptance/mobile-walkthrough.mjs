#!/usr/bin/env node
/**
 * CDP 移动档走查（独立入口；design 17 §18.6「CDP 设备模拟 + 真机抽检」的
 * CDP 设备模拟的一半）。`--mobile` 是桌面走查的档位名，从来不是本脚本的参数
 * （文件头不再假装支持它）。
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
 * 断言（结构化，不靠截图；判据纯函数在 mobile-checks.mjs，编号即报告里的顺序）：
 *   M-0 走查环境（找不到 CDP 目标、或会话建立失败 ⇒ INFO；--require-run 时 FAIL；
 *       运行中会话/采集中断 ⇒ FAIL——两种情况都照样写出报告并关会话）
 *   M-1 壳挂载成功（30s 内出现挂载标记；默认 INFO，--require-run 时 FAIL）
 *   M-2 设备模拟生效（含 pointer:coarse / hover:none / 手机档媒体查询；标题跟随 --width/--height/--dpr）
 *   M-3 无横向溢出（设备宽基准 + task 的 innerWidth 断言；收缩适配时明确标注）
 *   M-4 插件激活（[data-mobile-frame] 打标 + 键盘守卫诊断面；打标 PASS、无打标 INFO、--require-run 时 FAIL）
 *   M-5 会话头首行高度 ≤ 48px（无会话 ⇒ INFO；--require-run 时 FAIL）
 *   M-6 会话头内无「单字换行」（行盒数 + 高度启发式，纵向 padding 非零的叶子只按行盒数判；
 *       无会话 ⇒ INFO、--require-run 时 FAIL；带文本元素超过 80 个证据上限而截断时同样 INFO——没扫完不算通过）
 *   M-7 会话头内所有 button 命中盒 ≥ 44px（同上）
 *   M-8 WebSocket 帧捕获（`Network.webSocketFrameSent/Received`；**先脱敏后截断**，落盘 JSON；
 *       观察项恒 INFO，**不参与 --require-run**）
 *   M-9 覆盖层只读探查（position:fixed|absolute 且 z-index≥40 的可见元素 vs **布局视口**；
 *       不点击、不改 DOM；fixed 无位移的越界项判 FAIL；命中 40 个上限而截断时 INFO；
 *       **不参与 --require-run**——扫描完成即算执行，没有覆盖层仍记 INFO）
 *   M-10 走查期间的 ≥400 请求与渲染层 error（**真判定**：各自过容忍表后存在未预期项即 FAIL，
 *       容忍表见 checks.mjs 的 TOLERATED_REQUEST_FAILURES / KNOWN_UPSTREAM_BOOT_NOISE；
 *       **不参与 --require-run**——容忍表判的是本次观察到的事实，没有「未执行」的中间态）
 *
 * 脱敏的**已知边界**：能识别这些键名族（…token / …key / authorization / cookie / password /
 * secret / credential / session[-_]?id / session / sid / jwt）与
 * URL 查询串、JSON 转义形、`\u0022` 形；但**跨帧拼接**的凭据、URL **路径段/矩阵参数**里的
 * 值、以及 `webSocketFrameError.errorMessage` 里的自由文本，只有在值本身来自环境变量
 * （`--auth-token-env`/`--cookie-env`）时才一定能抹掉。不要把本工具的输出当成
 * 「一定不含凭据」的证明。
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
 * 环境在运行中失效（`connect` 失败、`enableObservation`/`evaluate` 抛错、页面被导航走、
 * CDP 会话断开）同样 fail-soft：不把异常抛给调用方，而是写一份带原因的报告、关掉会话后
 * 返回。已经判过的腿原样留在报告里；中断本身记 FAIL（会话建立失败仍按「环境不可用」记
 * INFO，`--require-run` 下记 FAIL），exit code 由汇总结果决定。
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
import { sleep } from '../lib/cli.mjs'
import {
  KNOWN_UPSTREAM_BOOT_NOISE, TOLERATED_REQUEST_FAILURES, createRecorder, partitionFailures,
  renderMarkdown, summarize, summarizeNetFailures,
} from './checks.mjs'
import {
  DEVICE_FACTS_EXPRESSION, HEADER_FACTS_EXPRESSION, MOBILE_DEVICE, OVERLAY_FACTS_EXPRESSION, applyRequireRun,
  deviceEmulationSteps, deviceEmulationVerdict, headerFirstRowVerdict, headerWrapVerdict, hitBoxVerdict,
  overflowVerdict, overlayProbeVerdict, pluginActivationVerdict, redactSecrets, summarizeWebSocketFrames,
} from './mobile-checks.mjs'

const ROOT_MOUNTED = `document.querySelector('#root') !== null && document.querySelector('#root').children.length > 0`
/** 单帧落盘上限（base64 图片/大 JSON 会把帧文件撑爆；完整长度另记）。 */
const DEFAULT_FRAME_CAP = 8_000


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
 *
 * 顺序纪律：**先脱敏、后截断**（cap 只作用在脱敏后的文本上），`payloadLength`
 * 始终记原始长度、`truncated` 由原始长度判定。反过来的写法（先 slice 再在落盘
 * 时脱敏）会让截断点切开一个凭据的键值上下文——正则匹配不到半截值，凭据前缀
 * 照样进内存/摘要。导出以便单测直接钉住这个顺序。
 * @returns {{frames: object[], stop: () => void}}
 */
export function collectWebSocketFrames(session, { cap = DEFAULT_FRAME_CAP, redact = value => value } = {}) {
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
      const raw = String(response.payloadData ?? '')
      const safe = String(redact(raw))
      frames.push({
        direction: message.method === 'Network.webSocketFrameSent' ? 'sent' : 'received',
        opcode: response.opcode,
        // 原始长度与截断标记都按 raw 记（脱敏可能改变长度）。
        payloadLength: raw.length,
        redactedLength: safe.length,
        truncated: raw.length > cap,
        payload: safe.slice(0, cap),
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
async function discoverMobileTarget(cdpPort, url, secrets = []) {
  // Logged URLs go through the same scrub as the persisted ones: a launch token
  // can ride the query string, and stdout is a log too.
  const scrub = value => redactSecrets(String(value), secrets)
  if (url !== null) {
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    try {
      const target = await discoverPageTarget(cdpPort, { urlPattern: new RegExp(`^${escaped}`), timeoutMs: 8_000 })
      console.log(`# CDP 目标（--url 前缀命中）：${scrub(target.url)}`)
      return target
    } catch { /* 回落到下一级 */ }
  }
  try {
    const target = await discoverPageTarget(cdpPort, { timeoutMs: 8_000 })
    console.log(`# CDP 目标（回环 http 约定命中）：${scrub(target.url)}`)
    return target
  } catch { /* 回落到下一级 */ }
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
    const target = list.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl !== undefined) ?? null
    if (target !== null) console.warn(`# 警告：未命中 --url 前缀/回环约定，改用第一个 page 目标 ${scrub(target.url)}（随后按 --url 导航）`)
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
 * @param {number} [opts.navigateSettleMs] - 导航后等待（默认 1500）
 * @param {number} [opts.reloadSettleMs] - reload 后等待设备模拟生效（默认 3000）
 * @param {number} [opts.frameSettleMs] - 帧/控制台观察窗前等待（默认 1000）
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
  // Wall-clock waits the real CDP run needs; injectable so the hermetic test
  // (which drives the same code path with fake sessions) does not pay ~5.5s of
  // page-settle time per case for behaviour it never observes.
  navigateSettleMs = 1_500,
  reloadSettleMs = 3_000,
  frameSettleMs = 1_000,
  frameCap = DEFAULT_FRAME_CAP,
  env = process.env,
  // Test seams (defaults are the real CDP paths). Injectable so the whole run —
  // every sink the credentials could reach — is covered by a hermetic test
  // instead of only by a live browser.
  discover = discoverMobileTarget,
  connect = (webSocketDebuggerUrl) => CdpSession.connect(webSocketDebuggerUrl),
} = {}) {
  const rec = createRecorder()
  const shots = path.join(outDir, 'shots')
  mkdirSync(shots, { recursive: true })

  const credentials = buildCredentialHeaders({ authTokenEnv, cookieEnv, env })
  for (const note of credentials.notes) console.log(`# ${note}`)
  // 脱敏是**每条落盘通道**（stdout / 报告 / 帧文件）共用的同一层；两条 fail-soft
  // 出口（无目标、运行中会话失效）也要用它，所以建在这里而不是 try 里面。
  const scrub = value => redactSecrets(String(value), credentials.secrets)

  // ---- 连接：失败即「环境不可用」，打印需要什么，写 INFO 报告后返回 ----
  let target = null
  let connectError = null
  try {
    target = await discover(cdpPort, url, credentials.secrets)
  } catch (error) {
    connectError = error
  }
  if (target === null) {
    // reason 可能带 URL/查询串（发现器抛出的错误），落盘与打印都先过脱敏。
    const reason = scrub(connectError === null
      ? `/json/list 在 ${cdpPort} 上没有应答或没有 page 目标`
      : String(connectError?.message ?? connectError))
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
    const reportPath = writeReport({
      outDir, target: null, cdpPort, url, device, secrets: credentials.secrets,
      results: rec.results, frames: null, notes: [requirement],
    })
    return {
      results: rec.results, reportPath, framesPath: null, shots, skipped: true,
      ...summarize(rec.results),
    }
  }

  console.log(`# CDP 移动走查目标 ${scrub(target.url)}（${scrub(target.title)}）`)
  // 会话建立、观测开启与全部采集共用一个 try：connect / enableObservation / evaluate
  // 的失败是**可预期的运行事实**（目标在发现与 attach 之间消失、页面被导航走、CDP
  // 会话断开），它们同样要写报告并关掉会话，而不是把异常抛给调用方（fail-soft）。
  let session = null
  let framesPath = null
  let frameSummary = null
  try {
    session = await connect(target.webSocketDebuggerUrl)
    // `--ws-frames off` means off: no listener, no accumulation. (The summary is
    // the only place raw frame bytes leave this module, so not collecting is both
    // the honest reading of the flag and one less credential-bearing buffer.)
    const ws = wsFrames === 'off' ? { frames: [] } : collectWebSocketFrames(session, {
      cap: frameCap,
      redact: value => redactSecrets(String(value), credentials.secrets),
    })
    await session.enableObservation()
    if (Object.keys(credentials.headers).length > 0) {
      await session.send('Network.setExtraHTTPHeaders', { headers: credentials.headers })
    }

    const shot = async name => { await session.screenshot(path.join(shots, `${name}.png`)); return `${name}.png` }
    if (url !== null) {
      await session.send('Page.navigate', { url })
      await sleep(navigateSettleMs)
    }
    // ---- 设备模拟（模拟是会话级；reload 后仍生效，实测） ----
    for (const step of deviceEmulationSteps(device)) await session.send(step.method, step.params)
    await session.reload()
    await sleep(reloadSettleMs)
    session.beginObservationWindow()
    // The mount wait must not be swallowed (`.catch(() => {})`): a 500/login page
    // would then produce a fully green walkthrough, because the emulation and
    // overflow legs pass on ANY page. Record it — INFO by default (the
    // walkthrough is also used to inspect a page mid-load), FAIL under
    // --require-run.
    const mounted = await session.waitFor(ROOT_MOUNTED, 'shell mounted', { timeoutMs: 30_000 })
      .then(() => true)
      .catch(() => false)
    const mountVerdict = applyRequireRun({
      ok: mounted ? true : null,
      evidence: mounted
        ? 'shell mounted 标记在 30s 内出现'
        : `30s 内未观察到挂载标记 ${ROOT_MOUNTED}——其后每条几何/插件判据的 INFO 都不能当成通过`,
    }, requireRun)
    rec.add('M-1', '壳挂载成功（会话/插件面的前提）', mountVerdict.ok, mountVerdict.evidence)
    await sleep(settleMs)

    /** Record a judged leg through the pure --require-run gate. */
    const addGated = (id, title, verdict) => {
      const gated = applyRequireRun(verdict, requireRun)
      rec.add(id, title, gated.ok, gated.evidence)
    }
    const deviceFacts = await session.evaluate(DEVICE_FACTS_EXPRESSION)
    await shot('M1-device')
    const emulation = deviceEmulationVerdict(deviceFacts, device)
    rec.add('M-2', `设备模拟生效（${device.width}×${device.height}@${device.deviceScaleFactor}x + 触控 ⇒ pointer:coarse / hover:none）`, emulation.ok, emulation.evidence)

    addGated('M-3', '无横向溢出（设备宽基准；task 的 innerWidth 断言一并报告）', overflowVerdict(deviceFacts, device))

    // M-4 is GATED: stamped = PASS with the keyboard
    // guard's diagnosis surface in the evidence; unstamped stays INFO for a
    // walkthrough of a page that simply lacks the plugin, but --require-run
    // (the "this leg must really execute" mode) turns it into a FAIL.
    addGated('M-4', '移动插件激活（[data-mobile-frame] 打标 + 键盘守卫诊断面）',
      pluginActivationVerdict(deviceFacts))

    // ---- 会话头几何（无会话 ⇒ INFO；--require-run 下「没有会话」正是它要拦的
    //      情形，USAGE 承诺过 ⇒ applyRequireRun 把它改判 FAIL） ----
    const headerFacts = await session.evaluate(HEADER_FACTS_EXPRESSION)
    await shot('M2-header')
    addGated('M-5', `会话头首行高度 ≤ 48px（实测，无会话则 INFO）`, headerFirstRowVerdict(headerFacts))
    addGated('M-6', '会话头内无「单字换行」（行盒数 + 高度启发式；纵向 padding 非零的叶子只按行盒数判）', headerWrapVerdict(headerFacts))
    addGated('M-7', '会话头内所有 button/tab 命中盒 ≥ 44px', hitBoxVerdict(headerFacts))


    // ---- 帧 + 控制台/网络：M-8 是观察项（恒 INFO），M-10 按 checks.mjs 的容忍表真判定 ----
    await sleep(frameSettleMs)
    frameSummary = summarizeWebSocketFrames(ws.frames, { redact: scrub })
    rec.add('M-8', 'WebSocket 帧捕获（会话打开停滞的证据来源）', null,
      wsFrames === 'off'
        ? '--ws-frames off：本档不采集、不落盘、不打印帧（其余判据不受影响）'
        : `${scrub(frameSummary.summary)}\n（帧自 CDP 连接起累计——含 reload 前的那一次连接；完整帧见报告旁 mobile-ws-frames.json，payload/URL 均已脱敏；--ws-frames full 可逐帧打印）`)
    if (wsFrames === 'full') {
      for (const frame of ws.frames) {
        console.log(`[WS] ${frame.direction} opcode=${frame.opcode ?? '-'} len=${frame.payloadLength ?? '-'}${frame.truncated === true ? ' (截断，落盘为脱敏后前缀)' : ''} ${redactSecrets(frame.payload ?? frame.url ?? frame.error ?? '', credentials.secrets).slice(0, 300)}`)
      }
    }

    // ---- M-9：覆盖层只读探查（不点击、不改 DOM；**不参与 --require-run**） ----
    // 探针跑完即算「执行过」：页面上没有覆盖层时判定本身按设计记 INFO（未命中，
    // 不是通过），--require-run 把它改判 FAIL 只会惩罚一个确实执行了的只读扫描；
    // 「压根没连上页面」由 M-0/M-1 负责。因此这里走 rec.add 而不是 addGated。
    // 记录顺序贴着编号（M-8 之后、M-10 之前）：报告行序与文件头的清单一致。
    const overlayFacts = await session.evaluate(OVERLAY_FACTS_EXPRESSION)
    const overlay = overlayProbeVerdict(overlayFacts)
    rec.add('M-9', '覆盖层只读探查（fixed|absolute z-index≥40 超出布局视口）', overlay.ok, overlay.evidence)

    const net = partitionFailures([...session.netFailures.keys()], TOLERATED_REQUEST_FAILURES)
    const consolePartition = partitionFailures(session.consoleErrors, KNOWN_UPSTREAM_BOOT_NOISE)
    rec.add('M-10', '走查期间无未预期的 ≥400 请求与渲染层 error（容忍表见 checks.mjs）',
      net.unexpected.length === 0 && consolePartition.unexpected.length === 0,
      [`未预期网络：${scrub(net.unexpected.slice(0, 5).join(' | ')) || '（无）'}`,
        `已登记容忍：${scrub(net.tolerated.slice(0, 3).join(' | ')) || '（无）'}`,
        `未预期 console error：${scrub(consolePartition.unexpected.slice(0, 3).join(' | ')) || '（无）'}`,
        `已登记上游噪声：${scrub(consolePartition.tolerated.slice(0, 2).join(' | ')) || '（无）'}`].join('\n'))

    // ---- 帧落盘（脱敏后；--ws-frames off 不落盘） ----
    // 凭据可以出现在 URL 查询串里（`?token=…`），不只出现在帧载荷里：每个要落盘的
    // 字符串都过一遍 redactSecrets（url /
    // meta.target / netFailures 同样落盘，漏一处等于把凭据写进了持久层）。
    framesPath = wsFrames === 'off' ? null : path.join(outDir, 'mobile-ws-frames.json')
    if (framesPath !== null) {
      writeFileSync(framesPath, JSON.stringify({
        meta: { target: redactSecrets(target.url, credentials.secrets), cdpPort, at: new Date().toISOString() },
        counts: frameSummary.counts,
        frames: ws.frames.map(frame => ({
          ...frame,
          url: frame.url === undefined ? undefined : redactSecrets(frame.url, credentials.secrets),
          error: frame.error === undefined ? undefined : redactSecrets(frame.error, credentials.secrets),
          payload: frame.payload === undefined ? undefined : redactSecrets(frame.payload, credentials.secrets),
        })),
      }, null, 2))
    }

    const reportPath = writeReport({
      outDir, target, cdpPort, url, device, secrets: credentials.secrets,
      results: rec.results,
      frames: framesPath === null ? null : { summary: scrub(frameSummary.summary), counts: frameSummary.counts, file: framesPath },
      netFailures: summarizeNetFailures(session.netFailures),
      consoleErrors: session.consoleErrors.map(value => scrub(value)),
      consoleWarnings: session.consoleWarnings.map(value => scrub(value)),
      notes: credentials.notes,
    })
    const counts = summarize(rec.results)
    console.log(`\n=== 移动走查：${counts.passed} pass / ${counts.failed} fail / ${counts.info} info / ${rec.results.length} checks ===\nreport: ${reportPath}\nws frames: ${framesPath ?? '(off)'}\nscreenshots: ${shots}`)
    return { results: rec.results, reportPath, framesPath, shots, skipped: false, ...counts }
  } catch (error) {
    // fail-soft：connect / enableObservation / evaluate 的失败在这里收口。报告照样写、
    // 会话照样关；已经判过的腿原样留在报告里，中断本身记进 M-0（环境前提）。
    const environmentOnly = rec.results.length === 0
    const reason = scrub(error?.message ?? error)
    const evidence = environmentOnly
      ? [`CDP 会话建立失败：${reason}`,
          `需要什么：CDP 端口 ${cdpPort} 上的页面目标必须能 attach（webSocketDebuggerUrl 可用）；本脚本不重试其它目标、也不会自己启动实例。`].join('\n')
      : [`采集中断：${reason}`,
          '已判定的腿原样保留在报告里；未执行的腿不会以 INFO 冒充通过——中断本身记 FAIL（会话已关闭）。'].join('\n')
    const entry = {
      id: 'M-0',
      title: environmentOnly ? '走查环境（CDP 目标）' : '走查环境（CDP 会话中断）',
      ok: environmentOnly ? (requireRun ? false : null) : false,
      evidence,
    }
    // M-0 是环境前提：无论何时失败都排在报告首行，编号顺序才与文件头一致。
    rec.results.unshift(entry)
    const mark = entry.ok === false ? 'FAIL' : 'INFO'
    console.log(`[${mark}] ${entry.id} ${entry.title}\n        ${entry.evidence}`)
    const reportPath = writeReport({
      outDir, target, cdpPort, url, device, secrets: credentials.secrets,
      results: rec.results,
      frames: frameSummary === null ? null : { summary: scrub(frameSummary.summary), counts: frameSummary.counts, file: framesPath },
      netFailures: summarizeNetFailures(session?.netFailures ?? new Map()),
      consoleErrors: (session?.consoleErrors ?? []).map(value => scrub(value)),
      consoleWarnings: (session?.consoleWarnings ?? []).map(value => scrub(value)),
      notes: [...credentials.notes, evidence],
    })
    const counts = summarize(rec.results)
    console.log(`\n=== 移动走查（fail-soft）：${counts.passed} pass / ${counts.failed} fail / ${counts.info} info / ${rec.results.length} checks ===\nreport: ${reportPath}\nws frames: ${framesPath ?? '(off)'}\nscreenshots: ${shots}`)
    return { results: rec.results, reportPath, framesPath, shots, skipped: environmentOnly, ...counts }
  } finally {
    if (session !== null) session.close()
  }
}

/** 写 markdown + json 报告（与桌面走查同形，便于同一套人读/机读流程）。
 *  `secrets` 里的每个值、以及 token/authorization/cookie 形态的键值，都在落盘前抹掉：
 *  报告是持久层，URL 查询串同样可能带凭据。 */
function writeReport({ outDir, target, cdpPort, url, device = MOBILE_DEVICE, results, frames, netFailures = [], consoleErrors = [], consoleWarnings = [], notes = [], secrets = [] }) {
  const scrub = text => redactSecrets(String(text), secrets)
  const meta = {
    目标: target === null ? '(无 CDP 目标)' : scrub(target.url),
    CDP端口: cdpPort,
    导航: url === null ? '(未导航，走当前页面)' : scrub(url),
    设备: `${device.width}×${device.height} @${device.deviceScaleFactor}x mobile=${device.mobile}`,
    时间: new Date().toISOString(),
    截图目录: path.join(outDir, 'shots'),
  }
  const safeNetFailures = netFailures.map(scrub)
  // 标题与 meta.设备 一起跟随 --width/--height/--dpr：报告用默认设备名不加尺寸会误导。
  const title = `GUI 验收（移动档：CDP 设备模拟走查 ${device.width}×${device.height}@${device.deviceScaleFactor}x）`
  const report = renderMarkdown({ title, meta, results, netFailures: safeNetFailures, consoleErrors, consoleWarnings })
  const withFrames = frames === null ? report
    : `${report}\n\n## WebSocket 帧\n\n\`\`\`\n${frames.summary}\n\`\`\`\n\n完整帧文件：\`${frames.file}\`（计数 ${JSON.stringify(frames.counts)}）\n`
  const withNotes = notes.length === 0 ? withFrames : `${withFrames}\n\n## 凭据与环境\n\n${notes.map(note => `- ${note}`).join('\n')}\n`
  const reportPath = path.join(outDir, 'gui-mobile-walkthrough-report.md')
  writeFileSync(reportPath, withNotes)
  writeFileSync(path.join(outDir, 'gui-mobile-walkthrough-report.json'), JSON.stringify({
    meta, results, frames, netFailures: safeNetFailures, consoleErrors, consoleWarnings, notes,
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
                           （M-8 帧采集、M-9 覆盖层探查、M-10 网络/控制台观察不在此列：
                           它们不经过这道门；M-9 的只读扫描完成即算执行，无覆盖层仍是 INFO，
                           命中 40 个上限而截断时也是 INFO；M-10 按容忍表真判定）
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
  // 顶层 catch：runMobileWalkthrough 自己已把 connect/evaluate 的失败转成 fail-soft
  // 报告，能到这里的是意料之外的异常（写盘失败等）。不打印未捕获拒绝的整段堆栈，
  // 但也绝不假装成功：exit 1 并指出产物目录，让人知道去哪儿找半成品报告。
  try {
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
  } catch (error) {
    console.error(`移动走查异常终止（exit 1）：${String(error?.stack ?? error)}`)
    console.error(`产物目录：${values.out}（若报告已写出，以报告里的判定为准）`)
    process.exit(1)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
