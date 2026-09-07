#!/usr/bin/env node
/**
 * measure-ui —— UI 稳态基线尺子（2026 性能整改验收用，收敛版探针）。
 *
 * 与 boot/switch/eval-measure 的分工：那些测"事件窗"（启动/切换/归因）；
 * 本脚本测**稳态基数与空闲/输入响应**，输出一份固定 schema 的基线 JSON，
 * 供视图保留回收 / 预热收敛 / 后台拉取门控等整改的 A/B 前后对照
 * （performance-baseline.md §1 环境纪律：只做同环境 A/B，跨环境不可比）。
 *
 * 前置（同 performance-baseline.md §7）：以 --remote-debugging-port=9333
 * 启动的 dev/打包实例，渲染目标已就绪（本地连接 + 期望的挂载视图数）。
 *
 * 用法：node scripts/perf/measure-ui.mjs [--port 9333] [--idle 15] [--clicks 5]
 *       [--profile] [--out scripts/perf/data/measure-ui-<ts>.json]
 *
 * 输出字段（schema: measure-ui/v1）：
 *   dom.totalNodes / dom.views.{mounted,hidden} / dom.perInstanceNodes[]
 *     （每项 {id,hidden,pending,nodes}）
 *   heap.{usedJSHeapSize,totalJSHeapSize,jsSizeHeapLimit}
 *   idle.{durationMs,longtasks[],maxLongtaskMs,over100msCount}   —— 空闲 15s
 *   input.clicks[]（每击 {click,target,worstFrameMs,frames,longtasksMs}）
 *     —— 合成点击后 1s 窗；target = 该击解析到的元素描述（aria-label /
 *     文本前 40 字符 / 标签名）。点击会落在活动视图首个可交互元素上，
 *     可能触发真实导航副作用——见 README 前置警告。
 *   frames.{p95Ms,worstMs,samples}                               —— 全程帧间隔
 *   profile.top20 (仅 --profile，5s CPU profile 自顶向下)
 *   各采集步失败降级为字段缺失并记入 errors[]；仅连接/参数错误非零退出。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findPageTarget, connect, installEarlyObservers, readPerf } from './cdp-lib.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function argValue(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const port = Number(argValue('--port', '9333'))
const idleSec = Number(argValue('--idle', '15'))
const clicks = Number(argValue('--clicks', '5'))
const wantProfile = process.argv.includes('--profile')
const outPath = argValue('--out', null)
const USAGE = `用法：node scripts/perf/measure-ui.mjs [--port 9333] [--idle 15] [--clicks 5] [--profile] [--out scripts/perf/data/measure-ui-<ts>.json]`
if (!Number.isInteger(port) || port < 1 || !Number.isInteger(idleSec) || idleSec < 1
  || !Number.isInteger(clicks) || clicks < 0 || clicks > 60) {
  console.error(USAGE)
  console.error('--port/--idle/--clicks 须为正整数（clicks 可为 0）')
  process.exit(1)
}

const outputPath = outPath ?? `scripts/perf/data/measure-ui-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
const errors = []

/** 单次 evaluate 带 4s 超时守卫（cdp-lib 纪律：导航竞态下 send 可能永不返回）。 */
function evGuard(send, expression) {
  return Promise.race([
    send('Runtime.evaluate', { expression, returnByValue: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate-timeout')), 4000)),
  ]).then(r => r?.result?.value)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- 连接（失败即清晰退出）----
let page
try {
  page = await findPageTarget(port)
} catch (error) {
  console.error(`无法连接 :${port} 的 CDP target（${error instanceof Error ? error.message : String(error)}）`)
  console.error('前置：以 --remote-debugging-port=9333 启动实例（见 docs/progress/performance-baseline.md §7）')
  process.exit(1)
}
const cdp = connect(page.webSocketDebuggerUrl)
await cdp.ready
await installEarlyObservers(cdp, cdp.send)
const ev = expression => evGuard(cdp.send, expression)

const summary = {
  schema: 'measure-ui/v1',
  capturedAt: new Date().toISOString(),
  target: { url: page.url, title: page.title ?? null },
  errors,
}
const startedAt = Date.now()

// ---- 帧间隔采样器（rAF loop，仅记录；调用方按时间段切片）----
await ev(`(() => {
  if (window.__dshPerfFramesInstalled) return
  window.__dshPerfFramesInstalled = true
  window.__dshPerfFrames = []
  let last = performance.now()
  const loop = (t) => {
    const delta = t - last
    last = t
    if (window.__dshPerfFrames.length < 200000) window.__dshPerfFrames.push({ t: Math.round(t), delta: Math.round(delta * 100) / 100 })
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
})()`)

// ---- 1. DOM / 视图 / 堆基数 ----
const domSnapshot = await ev(`(() => {
  const total = document.getElementsByTagName('*').length
  const views = [...document.querySelectorAll('.instance-view')]
  const perInstance = views.map(v => ({ id: v.getAttribute('data-instance'), hidden: v.classList.contains('instance-hidden'), pending: v.classList.contains('instance-pending'), nodes: v.querySelectorAll('*').length }))
  return { totalNodes: total, views: { mounted: views.length, hidden: views.filter(v => v.classList.contains('instance-hidden')).length }, perInstanceNodes: perInstance }
})()`)
if (domSnapshot === undefined) errors.push('domSnapshot evaluate failed')
else summary.dom = domSnapshot

const heap = await ev(`(() => { const m = performance.memory; return m ? { usedJSHeapSize: m.usedJSHeapSize, totalJSHeapSize: m.totalJSHeapSize, jsHeapSizeLimit: m.jsHeapSizeLimit } : null })()`)
if (heap === undefined || heap === null) errors.push('heap evaluate failed/unsupported')
else summary.heap = heap

// ---- 2. 空闲观测窗（idleSec 秒，longtask 经 cdp-lib 观察者采集）----
const idleMark = await ev(`(() => { window.__dshPerfIdleMark = performance.now(); return window.__dshPerfIdleMark })()`)
if (idleMark === undefined) errors.push('idle mark evaluate failed')
await sleep(idleSec * 1000)
const perf = await readPerf(cdp, cdp.send)
if (perf === null) errors.push('readPerf failed')
const idleLongtasks = (perf?.longtasks ?? [])
  .filter(lt => lt.start >= (idleMark ?? 0))
  .map(lt => ({ start: Math.round(lt.start), dur: Math.round(lt.dur * 10) / 10 }))
summary.idle = {
  durationMs: idleSec * 1000,
  longtasks: idleLongtasks,
  maxLongtaskMs: idleLongtasks.reduce((m, lt) => Math.max(m, lt.dur), 0),
  over100msCount: idleLongtasks.filter(lt => lt.dur > 100).length,
}

// ---- 3. 合成输入：对活动视图派发点击，测每击后 1s 窗帧间隔/长任务 ----
const clickResults = []
for (let i = 0; i < clicks; i++) {
  await sleep(2000)
  const at = await ev(`(() => { window.__dshPerfClickMark = performance.now(); return window.__dshPerfClickMark })()`)
  const clicked = await ev(`(() => {
    const view = [...document.querySelectorAll('.instance-view')].find(v => !v.classList.contains('instance-hidden'))
    if (!view) return 'NOVIEW'
    const targets = [...view.querySelectorAll('button, [role="treeitem"], [role="button"]')]
    const target = targets.find(t => { const r = t.getBoundingClientRect(); return r.width > 2 && r.height > 2 }) ?? targets[0]
    if (!target) return 'NOTARGET'
    const r = target.getBoundingClientRect()
    const x = r.x + Math.min(20, r.width / 2)
    const y = r.y + r.height / 2
    // 记录解析到的目标（2026 评审：合成点击可能命中真实动作——new session/
    // 设置等——逐击记录 aria-label/文本前 40 字符/标签名，A/B 对照时可在
    // JSON 里核对每击实际点了什么；README 已加前置警告）。
    const desc = target.getAttribute('aria-label')
      || (target.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40)
      || target.tagName
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }))
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }))
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }))
    return 'OK:' + desc
  })()`)
  await sleep(1000)
  // 点击后 1s 窗：帧间隔最坏值与长任务
  const windowStats = await ev(`(() => {
    const mark = window.__dshPerfClickMark ?? 0
    const until = mark + 1000
    const frames = (window.__dshPerfFrames || []).filter(f => f.t >= mark && f.t <= until).map(f => f.delta)
    const lts = (window.__dshPerf && window.__dshPerf.longtasks || []).filter(lt => lt.start >= mark && lt.start <= until).map(lt => Math.round(lt.dur * 10) / 10)
    return { worstFrameMs: frames.length ? Math.round(Math.max(...frames) * 10) / 10 : null, frames: frames.length, longtasksMs: lts }
  })()`)
  clickResults.push({ click: i + 1, target: clicked, ...(windowStats ?? {}) })
}
summary.input = { clicks: clickResults }

// ---- 帧间隔汇总（全程采样窗，p95/最坏）----
const frameStats = await ev(`(() => {
  const frames = (window.__dshPerfFrames || []).map(f => f.delta).filter(d => d > 0).sort((a, b) => a - b)
  if (frames.length === 0) return { samples: 0 }
  const p95 = frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.95))]
  return { samples: frames.length, p95Ms: Math.round(p95 * 10) / 10, worstMs: Math.round(frames[frames.length - 1] * 10) / 10 }
})()`)
summary.frames = frameStats ?? { samples: 0 }

// ---- 4. 可选 5s CPU profile（自顶向下 top20）----
if (wantProfile) {
  try {
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.start')
    await sleep(5000)
    const { profile } = await cdp.send('Profiler.stop')
    const selfByNode = new Map()
    const nodes = profile.nodes
    for (const node of nodes) {
      if (node.callFrame.functionName === '(root)' || node.callFrame.functionName === '(idle)') continue
      const key = `${node.callFrame.url}:${node.callFrame.functionName}`
      const agg = selfByNode.get(key) ?? { selfTime: 0, hitCount: 0, url: node.callFrame.url, functionName: node.callFrame.functionName }
      agg.selfTime += node.selfTime ?? 0
      agg.hitCount += node.hitCount ?? 0
      selfByNode.set(key, agg)
    }
    summary.profile = {
      durationMs: 5000,
      top20: [...selfByNode.values()].sort((a, b) => b.selfTime - a.selfTime).slice(0, 20)
        .map(row => ({ ...row, selfTimeMs: Math.round(row.selfTime * 1000) })),
    }
  } catch (error) {
    errors.push(`profile failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

summary.elapsedMs = Date.now() - startedAt
const absoluteOut = isAbsolute(outputPath) ? outputPath : join(repoRoot, outputPath)
mkdirSync(dirname(absoluteOut), { recursive: true })
writeFileSync(absoluteOut, JSON.stringify(summary, null, 2))

// ---- stdout 人类可读摘要 ----
console.log(`measure-ui: DOM=${summary.dom?.totalNodes ?? 'n/a'} nodes (${summary.dom?.views?.mounted ?? '?'} views, ${summary.dom?.views?.hidden ?? '?'} hidden)`)
console.log(`heap used=${summary.heap ? Math.round(summary.heap.usedJSHeapSize / 1024 / 1024) + ' MiB' : 'n/a'}`)
console.log(`idle ${idleSec}s: longtasks=${summary.idle.longtasks.length} max=${summary.idle.maxLongtaskMs}ms over100ms=${summary.idle.over100msCount}`)
if (summary.frames?.samples) console.log(`frames: samples=${summary.frames.samples} p95=${summary.frames.p95Ms}ms worst=${summary.frames.worstMs}ms`)
console.log(`input clicks=${clickResults.length}${clickResults.some(c => c.worstFrameMs !== null && c.worstFrameMs > 500) ? '（存在 >500ms 帧间隔，见 JSON）' : ''}`)
if (summary.profile) console.log(`profile top1: ${summary.profile.top20[0]?.functionName ?? '-'} @ ${summary.profile.top20[0]?.selfTimeMs ?? 0}ms`)
console.log(`saved: ${outputPath}${errors.length > 0 ? `\nwarnings/errors: ${errors.join('; ')}` : ''}`)
