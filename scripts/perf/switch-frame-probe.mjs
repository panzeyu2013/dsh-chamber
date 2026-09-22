#!/usr/bin/env node
/**
 * 切源「无白帧」逐帧探针：Leg A（DOM 逐帧）+ Leg B（CDP screencast 像素）。
 *
 * 为什么存在：现有探针都给不出这条判据——
 * `switch-measure.mjs:87` 的 done 只断言 `!skeleton && quietMs>700`（settle 下界，
 * 不校验目标/内容），`measure-ui.mjs:88-100` 的帧采样器只记帧间隔（`{t,delta}`，
 * 无内容归属），遮罩层叠探针只在遮罩可见帧判 `elementFromPoint` 归属（证明"谁在命中
 * 测试里胜出"，不证明"画了像素"）。本脚本产出的**逐帧观测**交给纯判据
 * `packages/renderer/src/switch-frame-verdict.ts` 的三形态（无可见视图 / 平坦 #fff /
 * 主题失配进度面）判定，判据本身进 CI（`packages/renderer/test/view-runtime/`）。
 *
 * 两条腿：
 *  - **Leg A**（CI 主判据面）：页面内注入 rAF 采样器（`switchFrameProbeInstall/Read`，
 *    与 gui-acceptance/walkthrough.mjs 的探针体例同款；采样器只读 DOM，不进业务代码），
 *    每 4 帧记一次 `{visibleView, veil, veilBg(computed), phase, at}`；
 *  - **Leg B**（实机像素证据，`--screencast`）：`Page.startScreencast` PNG 帧，
 *    用零依赖 `scripts/lib/png-ink.mjs` 对内容区（`[data-conversation-scroll]`，
 *    退化到窗口中心 60%）取众数色 + ink 占比。已知边界：screencast 在静止期可能没有帧
 *    （采样率写进产物，报告不得把覆盖率读成通过）。
 *
 * 用法（需要 dev Electron + CDP；本脚本**不进 CI 门禁**，是人工/验收工具）：
 *   node scripts/perf/switch-frame-probe.mjs --target gateway-abc123 --require-switch
 *   node scripts/perf/switch-frame-probe.mjs --target dsh-xyz --screencast --json .tmp/switch.json
 *
 * 退出码：0 判据过；1 判据 FAIL（含 --require-switch 下未演练/探针坏）；2 环境不可用
 * （无 CDP target / 点不中来源行 / evaluate 失败）。`INFO` 不是通过——严格档位把它升 FAIL。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CdpSession, discoverPageTarget } from '../gui-acceptance/cdp.mjs'
import { decodePng, isFlat, regionStats } from '../lib/png-ink.mjs'
import { applyRequireSwitch, switchFrameVerdict } from '../../packages/renderer/src/switch-frame-verdict.ts'

/** 采样节奏：每 4 个 rAF 记一帧 ≈15Hz。 */
const FRAME_SAMPLE_EVERY = 4
/** 默认采样窗：覆盖一次切换（含 1s 持有窗 + 冷 boot 的遮罩期）后仍在观察。 */
const DEFAULT_WINDOW_MS = 8_000
/** 探针自停上限（照 walkthrough 的 20s/1200 帧自停纪律，防 rAF 环长留页面）。 */
const PROBE_MAX_FRAMES = 1_800

const USAGE = `用法：node scripts/perf/switch-frame-probe.mjs --target <sourceId> [选项]
  --port <n>            CDP 端口（默认 9333）
  --target <sourceId>   要切去的来源 id（== InstanceView 的 data-instance / 侧栏 data-chamber-row）
  --click <selector>    显式点击选择器（默认 [data-chamber-row="<target>"] → [data-chamber-section] → 文本匹配）
  --expected-bg <#rrggbb>  目标 cache 命中时的精确遮罩底色（缺省 = 无 cache，判暗色族）
  --light <id[,id]>     声明的浅色来源（可重复；它们的纯白平面合法）
  --window <ms>         采样窗（默认 8000）
  --screencast          额外跑 Leg B（Page.startScreencast + PNG 像素）
  --require-switch      严格档：切换未真实演练/探针坏掉 ⇒ FAIL（不得记 INFO）
  --json <path>         产物路径（默认 .tmp/switch-frame-<ts>.json）`

function parseArgs(argv) {
  const options = {
    port: 9333, target: null, click: null, expectedBg: null, light: [],
    windowMs: DEFAULT_WINDOW_MS, screencast: false, requireSwitch: false, json: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--port') options.port = Number(argv[++index])
    else if (token === '--target') options.target = argv[++index]
    else if (token === '--click') options.click = argv[++index]
    else if (token === '--expected-bg') options.expectedBg = argv[++index]
    else if (token === '--light') options.light.push(...String(argv[++index]).split(',').filter(value => value !== ''))
    else if (token === '--window') options.windowMs = Number(argv[++index])
    else if (token === '--screencast') options.screencast = true
    else if (token === '--require-switch') options.requireSwitch = true
    else if (token === '--json') options.json = argv[++index]
    else if (token === '--help') { console.log(USAGE); process.exit(0) }
    else { console.error(USAGE); console.error('unknown argument: ' + token); process.exit(2) }
  }
  if (options.target === null || options.target === '') {
    console.error(USAGE)
    console.error('--target 必填：判据需要知道"切去的目标来源"（无目标无从判主题失配）')
    process.exit(2)
  }
  if (!Number.isFinite(options.windowMs) || options.windowMs < 500) {
    console.error(USAGE)
    console.error('--window 须为 ≥500 的毫秒数，收到：' + JSON.stringify(options.windowMs))
    process.exit(2)
  }
  return options
}

/**
 * 页面内 rAF 采样器（Leg A）。装到 `window.__switchFrameProbe`，由 READ 读回并删除。
 * 采样器只读 DOM：可见视图口径照遮罩探针（`.instance-view:not(.instance-hidden):not(.instance-pending)`），
 * 遮罩底色取 `getComputedStyle(...).backgroundColor`（DOM 真值，不需要截图）。
 * `targetSettledBeforeSwitch` 在**安装时**捕获一次：目标视图存在且已在 `.instance-hidden`
 * 态（App 的 viewClass 语义：settled 才 hidden，未 settle 是 pending）且没有遮罩 ⇒ 温壳。
 */
function installProbe(targetId, windowMs, everyNthFrame, maxFrames) {
  if (window.__switchFrameProbe !== undefined) return { installed: false, reason: 'already' }
  const SCOPE = '.instance-view:not(.instance-hidden):not(.instance-pending)'
  const targetView = document.querySelector('.instance-view[data-instance="' + targetId + '"]')
  const targetSettledBeforeSwitch = targetView !== null
    && targetView.classList.contains('instance-hidden')
    && targetView.querySelector('.instance-loading') === null
  const state = {
    frames: [], error: null, done: false,
    startedAt: performance.now(), windowMs: windowMs, everyNthFrame: everyNthFrame,
    maxFrames: maxFrames, ticks: 0, targetSettledBeforeSwitch: targetSettledBeforeSwitch,
  }
  const sample = function () {
    const view = document.querySelector(SCOPE)
    const veil = view === null ? null : view.querySelector('.instance-loading')
    let veilBg = null
    if (veil !== null && typeof getComputedStyle === 'function') {
      const style = getComputedStyle(veil)
      if (style.visibility === 'hidden' || style.display === 'none') {
        // 显式隐藏的遮罩不算"进度面可见"：照探针体例按无遮罩记录。
      } else {
        veilBg = style.backgroundColor
      }
    }
    const phaseNode = view === null ? null : view.querySelector('[data-phase]')
    state.frames.push({
      at: performance.now(),
      visibleView: view === null ? null : view.getAttribute('data-instance'),
      selectedView: targetId,
      veil: veilBg !== null,
      veilBg: veilBg,
      phase: phaseNode === null ? null : phaseNode.getAttribute('data-phase'),
      targetSettledBeforeSwitch: targetSettledBeforeSwitch,
    })
  }
  const tick = function () {
    if (window.__switchFrameProbe !== state) { state.done = true; return }
    if (performance.now() - state.startedAt > state.windowMs || state.frames.length >= state.maxFrames) {
      state.done = true
      return
    }
    state.ticks += 1
    if (state.ticks % state.everyNthFrame === 0) {
      try { sample() } catch (error) { state.error = String(error) }
    }
    requestAnimationFrame(tick)
  }
  window.__switchFrameProbe = state
  requestAnimationFrame(tick)
  return { installed: true, targetSettledBeforeSwitch: targetSettledBeforeSwitch }
}

/** 安装探针的求值表达式。 */
export function switchFrameProbeInstall(targetId, windowMs) {
  return '(() => (' + installProbe.toString() + ')('
    + JSON.stringify(targetId) + ',' + JSON.stringify(windowMs) + ','
    + JSON.stringify(FRAME_SAMPLE_EVERY) + ',' + JSON.stringify(PROBE_MAX_FRAMES) + '))()'
}

/** 读回并删除探针状态（帧数组原样返回，判定交给纯函数）。 */
export const SWITCH_FRAME_PROBE_READ = '(() => {'
  + ' const s = window.__switchFrameProbe;'
  + ' if (s === undefined) return { installed: false, frames: [], error: null, done: true };'
  + ' delete window.__switchFrameProbe;'
  + ' return { installed: true, frames: s.frames, error: s.error, done: s.done === true,'
  + ' targetSettledBeforeSwitch: s.targetSettledBeforeSwitch === true }'
  + '})()'

/** 内容区矩形（CSS 像素；`[data-conversation-scroll]` 优先，退化到窗口中心 60%）。 */
const CONTENT_RECT_EXPRESSION = '(() => {'
  + ' const el = document.querySelector("[data-conversation-scroll]");'
  + ' const viewport = { w: window.innerWidth, h: window.innerHeight };'
  + ' if (el !== null) { const r = el.getBoundingClientRect();'
  + '   if (r.width > 8 && r.height > 8) return { x: r.x, y: r.y, w: r.width, h: r.height, source: "conversation-scroll", viewport: viewport }; }'
  + ' const w = viewport.w * 0.6, h = viewport.h * 0.6;'
  + ' return { x: (viewport.w - w) / 2, y: (viewport.h - h) / 2, w: w, h: h, source: "center-60", viewport: viewport };'
  + '})()'

/** 找到来源行并真实点击（CDP Input；点不中即 FAIL 面，绝不"点不中反而更快"）。 */
async function clickSourceRow(cdp, options) {
  const selector = options.click !== null
    ? options.click
    : '[data-chamber-row="' + options.target + '"], [data-chamber-section="' + options.target + '"]'
  const rect = await cdp.evaluate('(() => {'
    + ' const el = document.querySelector(' + JSON.stringify(selector) + ');'
    + ' if (el === null) return null;'
    + ' const r = el.getBoundingClientRect();'
    + ' if (r.width < 2 || r.height < 2) return null;'
    + ' return { x: r.x + Math.min(24, r.width / 2), y: r.y + r.height / 2 };'
    + '})()')
  if (rect === null) return { clicked: false, reason: 'NOROW:' + selector }
  const point = { x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
  return { clicked: true, at: point }
}

/** 读 Leg A 的 User Timing 标记（appViewRequest/appViewReveal），算 switchFrameMs（证据）。 */
const MARKS_EXPRESSION = '(() => {'
  + ' const marks = performance.getEntriesByType("mark")'
  + '   .filter(m => m.name.indexOf("dsh:app:view-") === 0)'
  + '   .map(m => ({ name: m.name, at: m.startTime }));'
  + ' return marks'
  + '})()'

function switchFrameMsFrom(marks, target) {
  const request = marks.filter(mark => mark.name === 'dsh:app:view-request:' + target).pop()
  const reveal = marks.filter(mark => mark.name === 'dsh:app:view-reveal:' + target).pop()
  if (request === undefined || reveal === undefined) return null
  return Math.round((reveal.at - request.at) * 10) / 10
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  let target
  try {
    target = await discoverPageTarget(options.port, { timeoutMs: 20_000 })
  } catch (error) {
    console.error('switch-frame-probe: 环境不可用 —— ' + String(error && error.message ? error.message : error))
    process.exit(2)
  }
  const cdp = await CdpSession.connect(target.webSocketDebuggerUrl)
  await cdp.enableObservation()
  const marks = await cdp.evaluate(MARKS_EXPRESSION).catch(() => [])

  const install = await cdp.evaluate(switchFrameProbeInstall(options.target, options.windowMs))
  if (install === null || install.installed !== true) {
    console.error('switch-frame-probe: 探针安装失败：' + JSON.stringify(install))
    cdp.close()
    process.exit(2)
  }

  // Leg B（可选）：先拿内容区矩形与 timeOrigin，再开 screencast（帧处理在 onMessage 里）。
  const screencastFrames = []
  let contentRect = null
  if (options.screencast) {
    contentRect = await cdp.evaluate(CONTENT_RECT_EXPRESSION)
    const timeOrigin = await cdp.evaluate('performance.timeOrigin')
    cdp.onMessage(message => {
      if (message.method !== 'Page.screencastFrame') return
      const params = message.params
      // ack 必须及时：不 ack 时 Chromium 会停发（协议要求逐帧确认）。
      void cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined)
      try {
        const image = decodePng(Buffer.from(params.data, 'base64'))
        const scale = contentRect !== null && contentRect.viewport.w > 0 ? image.width / contentRect.viewport.w : 1
        const stats = contentRect === null ? null : regionStats(image, contentRect, scale)
        const flat = isFlat(stats)
        screencastFrames.push({
          at: Number.isFinite(params.metadata && params.metadata.timestamp)
            ? Math.max(0, params.metadata.timestamp * 1000 - (Number.isFinite(timeOrigin) ? timeOrigin : 0))
            : Date.now(),
          selectedView: options.target,
          targetSettledBeforeSwitch: install.targetSettledBeforeSwitch === true,
          flatColor: flat === true ? stats.modeColor : null,
          inkRatio: stats === null ? null : Math.round(stats.inkRatio * 10000) / 10000,
          phase: null,
        })
      } catch (error) {
        screencastFrames.push({ at: Date.now(), selectedView: options.target, error: 'decode:' + String(error) })
      }
    })
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 960 })
  }

  const click = await clickSourceRow(cdp, options)
  if (click.clicked !== true) {
    if (options.screencast) await cdp.send('Page.stopScreencast').catch(() => undefined)
    console.error('switch-frame-probe: 点不中来源行 —— ' + JSON.stringify(click))
    cdp.close()
    process.exit(2)
  }
  await new Promise(resolve => setTimeout(resolve, options.windowMs))

  if (options.screencast) await cdp.send('Page.stopScreencast').catch(() => undefined)
  const read = await cdp.evaluate(SWITCH_FRAME_PROBE_READ)
  const marksAfter = await cdp.evaluate(MARKS_EXPRESSION).catch(() => marks)
  cdp.close()

  const domFrames = read !== null && Array.isArray(read.frames) ? read.frames : []
  const pixelFrames = screencastFrames.filter(frame => frame.error === undefined)
  const samples = [...domFrames, ...pixelFrames].sort((a, b) => a.at - b.at)
  const expectedVeilBg = options.expectedBg === null ? {} : { [options.target]: options.expectedBg }
  const verdict = applyRequireSwitch(switchFrameVerdict({
    samples,
    expectedVeilBg,
    declaredLightViewIds: options.light,
    switchExercised: read !== null && read.installed === true,
    error: read !== null && read.error !== null && read.error !== undefined ? read.error : null,
  }), options.requireSwitch)

  const artifact = {
    schema: 'switch-frame-probe/v1',
    at: new Date().toISOString(),
    env: { node: process.version },
    target: options.target,
    click,
    legs: { dom: domFrames.length, screencast: pixelFrames.length, screencastRequested: options.screencast },
    contentRect,
    switchFrameMs: switchFrameMsFrom(Array.isArray(marksAfter) ? marksAfter : [], options.target),
    counts: verdict.counts,
    verdict: { ok: verdict.ok, evidence: verdict.evidence },
    samples,
  }
  const jsonPath = options.json ?? ('.tmp/switch-frame-' + Date.now() + '.json')
  mkdirSync(dirname(jsonPath), { recursive: true })
  writeFileSync(jsonPath, JSON.stringify(artifact, null, 2))

  console.log('[switch-frame] target=' + options.target
    + ' frames=' + verdict.counts.frames + ' (dom=' + domFrames.length + ', pixels=' + pixelFrames.length + ')'
    + ' switchFrameMs=' + String(artifact.switchFrameMs))
  console.log('[switch-frame] ' + (verdict.ok === true ? 'PASS' : verdict.ok === false ? 'FAIL' : 'INFO') + ' — ' + verdict.evidence)
  console.log('[switch-frame] written: ' + jsonPath)
  process.exit(verdict.ok === true ? 0 : verdict.ok === false ? 1 : 2)
}

// Import guard：探针的表达式/判据接线也要能被测试 import（同仓内 test.mjs / 各探针体例），
// CLI 只在作为入口运行时执行。
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch(error => {
    console.error('switch-frame-probe: ' + String(error && error.stack ? error.stack : error))
    process.exit(2)
  })
}
