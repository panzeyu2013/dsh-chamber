/**
 * CDP 采集公共库（T0 场景表实机测量）。
 * 复用仓库既有 ws（经 control-plane 包解析，仓库根由 import.meta.url 定锚，
 * 任意 cwd 可运行），不加新依赖。用法见 boot-measure.mjs / switch-measure.mjs 头注。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(join(repoRoot, 'packages/control-plane/package.json'))
const WebSocket = require('ws')

export async function findPageTarget(port = 9333) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find(t => t.type === 'page')
  if (!page) throw new Error(`no page target on :${port}: ${JSON.stringify(list.map(t => t.type))}`)
  return page
}

export function connect(targetWsUrl) {
  const ws = new WebSocket(targetWsUrl)
  let id = 0
  const pending = new Map()
  const listeners = new Map()
  ws.on('message', d => {
    const m = JSON.parse(String(d))
    if (m.id !== undefined && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) rej(new Error(`${m.error.code}: ${m.error.message}`))
      else res(m.result)
      return
    }
    if (m.method && listeners.has(m.method)) for (const fn of listeners.get(m.method)) fn(m.params)
  })
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  ws.on('close', () => {
    const err = new Error('cdp ws closed')
    for (const { res, rej } of pending.values()) rej(err)
    pending.clear()
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const on = (method, fn) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn) }
  const close = () => ws.close()
  return { ready, send, on, close }
}

export const OBSERVER_SOURCE = `(() => {
  if (window.__dshPerfInstalled) return
  window.__dshPerfInstalled = true
  const nav = performance.getEntriesByType('navigation')[0]
  window.__dshPerf = {
    installedAt: performance.now(),
    navStart: nav ? nav.startTime : 0,
    longtasks: [],
    cls: 0,
    clsShifts: [],
    paints: [],
    marks: [],
  }
  try {
    new PerformanceObserver(l => { for (const e of l.getEntries()) window.__dshPerf.longtasks.push({ start: e.startTime, dur: e.duration, name: e.name, attribution: (e.attribution || []).map(a => ({ containerType: a.containerType, containerName: a.containerName || null, containerSrc: a.containerSrc || null })) }) }).observe({ type: 'longtask', buffered: true })
    new PerformanceObserver(l => { for (const e of l.getEntries()) { window.__dshPerf.clsShifts.push({ start: e.startTime, v: e.value, ri: e.hadRecentInput }); if (!e.hadRecentInput) window.__dshPerf.cls += e.value } }).observe({ type: 'layout-shift', buffered: true })
    new PerformanceObserver(l => { for (const e of l.getEntries()) window.__dshPerf.paints.push({ name: e.name, start: e.startTime }) }).observe({ type: 'paint', buffered: true })
  } catch {}
  try {
    // H3 实验（2026-09）：长任务归因 + 引导期 JS 资源加载清单（fetch 完成时
    // 刻与 transferSize）——区分「主 bundle 求值」任务与首帧后任务的脚本面。
    new PerformanceObserver(l => { for (const e of l.getEntries()) window.__dshPerf.resources = (window.__dshPerf.resources || []).concat({ name: e.name, dur: e.duration, size: e.transferSize }) }).observe({ type: 'resource', buffered: true })
  } catch {}
  if (typeof document.visibilityState !== 'undefined') window.__dshPerf.vis = document.visibilityState
})()`

/** 在页面注入性能观察者（后续每次导航自动先于页面脚本执行）。 */
export async function installEarlyObservers(cdp, send) {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER_SOURCE })
  // 当前已加载文档也补装一次
  await send('Runtime.evaluate', { expression: OBSERVER_SOURCE })
}

/** 轮询页面状态快照（骨架/列表/就绪标记），fn 返回 {done, state}。
 *  单次 evaluate 带 4s 超时守卫：CDP ws 在导航竞态下偶发"请求永不返回"，
 *  轮询绝不能被单次挂起的 send 钉死（2026-09 T6 探针实测发现）。 */
export async function pollState(cdp, send, fn, { intervalMs = 120, timeoutMs = 90000, label = 'poll' } = {}) {
  const t0 = Date.now()
  const trail = []
  const sendWithTimeout = async (expression) => {
    const result = await Promise.race([
      send('Runtime.evaluate', { expression, returnByValue: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate-timeout')), 4000)),
    ])
    return result
  }
  while (Date.now() - t0 < timeoutMs) {
    let s = { done: false, evaluateError: 'send-failed' }
    try {
      const r = await sendWithTimeout(fn)
      s = r?.result?.value
      if (s === undefined || s === null) {
        s = { done: false, evaluateError: r?.exceptionDetails?.text ?? r?.exceptionDetails?.exception?.description ?? 'no-value' }
      }
    } catch (error) {
      s = { done: false, evaluateError: error instanceof Error ? error.message : String(error) }
    }
    trail.push(s)
    if (s.done) return { ok: true, trail, elapsedMs: Date.now() - t0 }
    await new Promise(res => setTimeout(res, intervalMs))
  }
  return { ok: false, trail, elapsedMs: Date.now() - t0 }
}

/** 汇总 __dshPerf 并输出指标对象（单次 evaluate 带 4s 超时守卫，同
 *  pollState——导航竞态下 send 偶发永不返回，汇总绝不能钉死脚本）。 */
export async function readPerf(cdp, send) {
  const expression = `(() => { const p = window.__dshPerf || { longtasks: [], cls: 0, paints: [] }; const nav = performance.getEntriesByType('navigation')[0]; return { longtasks: p.longtasks, cls: Math.round(p.cls * 1000) / 1000, clsShifts: p.clsShifts || [], paints: p.paints, resources: p.resources || [], ltCount: p.longtasks.length, maxLt: p.longtasks.reduce((m, l) => Math.max(m, l.dur), 0), domContentLoaded: nav ? nav.domContentLoadedEventEnd : null, loadEnd: nav ? nav.loadEventEnd : null, navStart: p.navStart } })()`
  const r = await Promise.race([
    send('Runtime.evaluate', { expression, returnByValue: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('readPerf-evaluate-timeout')), 4000)),
  ])
  return r?.result?.value ?? null
}

export function summarize(perf, phase = '') {
  const lts = [...(perf?.longtasks ?? [])].sort((a, b) => b.dur - a.dur)
  return {
    phase,
    ltCount: perf?.ltCount ?? lts.length,
    maxLongtaskMs: Math.round((perf?.maxLt ?? 0) * 10) / 10,
    topLongtasksMs: lts.slice(0, 5).map(l => Math.round(l.dur * 10) / 10),
    cls: perf?.cls ?? null,
    fcpMs: perf?.paints?.find(p => p.name === 'first-contentful-paint')?.start != null ? Math.round(perf.paints.find(p => p.name === 'first-contentful-paint').start) : null,
    domContentLoadedMs: perf?.domContentLoaded != null ? Math.round(perf.domContentLoaded) : null,
    loadEndMs: perf?.loadEnd != null ? Math.round(perf.loadEnd) : null,
  }
}
