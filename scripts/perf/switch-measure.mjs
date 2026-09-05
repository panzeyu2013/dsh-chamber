#!/usr/bin/env node
/**
 * T0 场景②（跨实例切换 settle / 真 CLS 来源）与场景③（连点 ×N）实机采集雏形。
 *
 * 前置：dev Electron (CDP 9333) 运行，侧栏含 ≥2 个可切换来源的工作区行
 * （本地实例 + 远程实例）。脚本在 UI 主视图执行：
 *   - 场景②：A→B→A 单点切换循环（每跳测量骨架窗口/长任务/CLS）；
 *   - 场景③：对 B 目标连点 N 次（快速意图替换），测末意图落地时间与过渡节数
 *     （通过长任务分布与响应延迟近似：最后一次点击 → 内容稳定）。
 *
 * 用法：node scripts/perf/switch-measure.mjs [cycles=3] [--rapid N] [--out ...json]
 */
import { writeFileSync } from 'node:fs'
import { findPageTarget, connect, installEarlyObservers, pollState, readPerf, summarize } from './cdp-lib.mjs'

const cycles = Number(process.argv[2] ?? 3)
const rapidFlag = process.argv.indexOf('--rapid')
const rapidN = rapidFlag >= 0 ? Number(process.argv[rapidFlag + 1]) : 0
const outFlag = process.argv.indexOf('--out')
const outPath = outFlag >= 0 ? process.argv[outFlag + 1] : 'scripts/perf/data/switch-baseline.json'

const page = await findPageTarget(9333)
const cdp = connect(page.webSocketDebuggerUrl)
await cdp.ready
await installEarlyObservers(cdp, cdp.send)
const ev = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result?.value
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 点击指定来源下标题为 label 的工作区行（role=treeitem）。 */
async function clickWorkspace(sourceLabel, wsLabel) {
  const ok = await ev(`(() => {
    const rows = [...document.querySelectorAll('[role="treeitem"]')]
    const row = rows.find(r => {
      const txt = (r.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean)
      return txt.includes(${JSON.stringify(wsLabel)})
    })
    if (!row) return 'NOROW:' + ${JSON.stringify(wsLabel)}
    const r = row.getBoundingClientRect()
    if (r.width < 2) return 'HIDDEN'
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.x + 30, clientY: r.y + r.height / 2 }))
    row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.x + 30, clientY: r.y + r.height / 2 }))
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.x + 30, clientY: r.y + r.height / 2 }))
    return 'OK'
  })()`)
  return ok
}

async function closeSettingsIfOpen() {
  const open = await ev(`!!document.querySelector('[role="dialog"]')`)
  if (open) {
    const closed = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim()==='关闭' || (b.getAttribute('aria-label')||'').includes('关闭')); if (b) { b.click(); return 'clicked' } const set = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim()==='设置'); if (set) { set.click(); return 'toggled' } return 'none' })()`)
    await sleep(700)
    return closed
  }
  return 'clean'
}

const MARKER = `(() => {
  const skeleton = !!document.querySelector('.instance-loading')
  const body = document.body.innerText || ''
  const head = body.slice(0, 260)
  const lt = window.__dshPerf ? window.__dshPerf.longtasks : []
  const lastLtEnd = lt.length ? lt[lt.length - 1].start + lt[lt.length - 1].dur : 0
  return { done: false, skeleton, head, quietMs: Math.round(performance.now() - lastLtEnd), at: Math.round(performance.now()) }
})()`

async function switchAndMeasure(label, target) {
  const before = await readPerf(cdp, cdp.send)
  const tClick = Date.now()
  const clicked = await target()
  const res = await pollState(cdp, cdp.send, `(() => { const s = ${MARKER}; s.done = !s.skeleton && s.quietMs > 700; return s })()`, { timeoutMs: 45000, label })
  let after = null
  try { after = await readPerf(cdp, cdp.send) } catch (e) { console.log(label, 'readPerf failed:', e.message) }
  const trail = res.trail
  const skelIdx = trail.findIndex(s => s.skeleton)
  const skelEnd = skelIdx >= 0 ? trail.findIndex((s, i) => i > skelIdx && !s.skeleton) : -1
  const s = summarize(after, label)
  s.clicked = clicked
  s.clickToSettledMs = res.elapsedMs
  s.skeletonWindowMs = skelIdx >= 0 && skelEnd > skelIdx ? trail[skelEnd].at - trail[skelIdx].at : null
  s.skeletonSeen = skelIdx >= 0
  s.longtasksDelta = after.longtasks.length - (before?.longtasks?.length ?? 0)
  console.log(label, JSON.stringify(s))
  return s
}

const results = []
console.log('prep:', await closeSettingsIfOpen())
// 打开两个源的工作区行到可见态（树展开）
const T_A = () => clickWorkspace('本地实例', 'Desktop')
const T_B = () => clickWorkspace('test', 'test')
console.log('preclick A:', await T_A())
await sleep(2500)
console.log('preclick B:', await T_B())
await sleep(2500)
console.log('preclick A:', await T_A())
await sleep(3000)

if (rapidN > 0) {
  // 场景③：快速连点远程目标 N 次（不等待中间 settle）
  const before = await readPerf(cdp, cdp.send)
  const t0 = Date.now()
  for (let i = 0; i < rapidN; i++) {
    await T_B()
    await sleep(90)
  }
  const res = await pollState(cdp, cdp.send, `(() => { const s = ${MARKER}; s.done = !s.skeleton && s.quietMs > 900; return s })()`, { timeoutMs: 90000 })
  const after = await readPerf(cdp, cdp.send)
  const s = summarize(after, `rapid-x${rapidN}`)
  s.clicksMs = Date.now() - t0
  s.lastClickToQuietMs = res.elapsedMs
  s.longtasksDelta = after.longtasks.length - (before?.longtasks?.length ?? 0)
  console.log(JSON.stringify(s, null, 1))
  results.push(s)
} else {
  for (let i = 0; i < cycles; i++) {
    console.log('== phase A→B #' + (i + 1) + ' ==')
    try { results.push(await switchAndMeasure(`A→B #${i + 1}`, T_B)) } catch (e) { console.log('switch failed:', e.message) }
    console.log('== phase B→A #' + (i + 1) + ' ==')
    try { results.push(await switchAndMeasure(`B→A #${i + 1}`, T_A)) } catch (e) { console.log('switch failed:', e.message) }
  }
}

writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
console.log(`written: ${outPath}`)
cdp.close()
process.exit(0)
