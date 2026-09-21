/**
 * CDP 采集公共库 —— `scripts/gui-acceptance/cdp.mjs` 的薄封装（P1-3：
 * 仓库里曾有两套 CDP 客户端；本文件只保留 perf 侧的历史 API 形状与采集助手，
 * 协议载波、超时与 pending 清理全部复用 gui-acceptance 的实现）。
 *
 * 行为差异（有意收紧）：`send` 现在带 30s 超时（gui-acceptance 的语义），
 * 不再依赖各调用点自己 Promise.race；`findPageTarget` 保持历史 fail-fast
 * （一次 /json/list，不在 90s 窗口里等待）。
 *
 * 用法见 boot-measure.mjs / switch-measure.mjs 头注。
 */
import { CdpSession } from '../gui-acceptance/cdp.mjs'
import { sleep } from '../lib/cli.mjs'

export async function findPageTarget(port = 9333) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const pages = list.filter(t => t.type === 'page')
  if (!pages.length) throw new Error(`no page target on :${port}: ${JSON.stringify(list.map(t => t.type))}`)
  // nit3 (2026-09 review)：取首个 page target 无校验——DevTools/多窗口打开时首
  // target 未必是脚本要驱动的被测视图。各 measure 只传 CDP 端口、不传目标 URL，
  // lib 无法判定“正确”target：最小处置 = 候选 >1 时警告并列出 url/title（实测
  // dev 实例单窗口时列表首项即被测页），仍按首匹配取用。
  if (pages.length > 1) {
    console.warn(`findPageTarget: :${port} 上有 ${pages.length} 个 page target，取首个：${pages[0].url}`)
    for (const t of pages) console.warn(`  - ${t.url}${t.title ? `（${t.title}）` : ''}`)
  }
  return pages[0]
}

/**
 * One CDP session with the historical perf shape:
 * `{ ready, send, on, close }` where `send` resolves the raw protocol result
 * (`{ result: { value } }` / `{ exceptionDetails }`) exactly as before.
 */
export function connect(targetWsUrl) {
  const ready = CdpSession.connect(targetWsUrl)
  const send = async (method, params = {}) => {
    const session = await ready
    return session.send(method, params)
  }
  const on = (method, fn) => {
    void ready.then(session => session.onMessage(message => {
      if (message.method === method) fn(message.params)
    }))
  }
  const close = () => { void ready.then(session => session.close()) }
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
    await sleep(intervalMs)
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
  const fcp = perf?.paints?.find(p => p.name === 'first-contentful-paint')?.start
  return {
    phase,
    ltCount: perf?.ltCount ?? lts.length,
    maxLongtaskMs: Math.round((perf?.maxLt ?? 0) * 10) / 10,
    topLongtasksMs: lts.slice(0, 5).map(l => Math.round(l.dur * 10) / 10),
    cls: perf?.cls ?? null,
    fcpMs: fcp != null ? Math.round(fcp) : null,
    domContentLoadedMs: perf?.domContentLoaded != null ? Math.round(perf.domContentLoaded) : null,
    loadEndMs: perf?.loadEnd != null ? Math.round(perf.loadEnd) : null,
  }
}
