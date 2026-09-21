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
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { findPageTarget, connect, installEarlyObservers, pollState, readPerf, summarize } from './cdp-lib.mjs'
import { sleep } from '../lib/cli.mjs'

const cycles = Number(process.argv[2] ?? 3)
const rapidFlag = process.argv.indexOf('--rapid')
const rapidN = rapidFlag >= 0 ? Number(process.argv[rapidFlag + 1]) : 0
const outFlag = process.argv.indexOf('--out')
const outPath = outFlag >= 0 ? process.argv[outFlag + 1] : 'scripts/perf/data/switch-baseline.json'
/** I9（plan §10）：来源/工作区目标必须可参数化——写死标签是「点不中反而更快」的来源。 */
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const TARGET_A = { source: argOf('--source-a', '本地实例'), workspace: argOf('--workspace-a', 'Desktop') }
const TARGET_B = { source: argOf('--source-b', 'test'), workspace: argOf('--workspace-b', 'test') }
const requireFlag = process.argv.includes('--require-switch')
// nit2 (2026-09 review)：与 boot-measure 同病——非有限正整数（含首参误为 --out
// 得 NaN）时静默跑 0 次并写出空文件，改为显式报错退出；rapid 模式不消费 cycles，
// 只校验所用模式的那个参数
const USAGE = '用法：node scripts/perf/switch-measure.mjs [cycles=3] [--rapid N] [--out scripts/perf/data/switch-baseline.json] [--source-a <id|标签> --workspace-a <标签> --source-b <id|标签> --workspace-b <标签>] [--require-switch]'
if (rapidFlag >= 0) {
  if (!Number.isInteger(rapidN) || rapidN < 1) {
    console.error(USAGE)
    console.error(`--rapid 须为 ≥1 的整数，收到：${JSON.stringify(process.argv[rapidFlag + 1] ?? '(缺失)')}`)
    process.exit(1)
  }
} else if (!Number.isInteger(cycles) || cycles < 1) {
  console.error(USAGE)
  console.error(`cycles 须为 ≥1 的整数，收到：${JSON.stringify(process.argv[2] ?? '(缺省)')}`)
  process.exit(1)
}

const page = await findPageTarget(9333)
const cdp = connect(page.webSocketDebuggerUrl)
await cdp.ready
await installEarlyObservers(cdp, cdp.send)
const ev = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result?.value

/**
 * 点击来源 `sourceRef`（**id 或标签**）下标题为 `wsLabel` 的工作区行。
 * I9：定位锚点是 `[data-chamber-section]`（来源）与行内文本，**不再全页扫 treeitem 文本**
 * ——全页文本匹配是「点错来源也返回 OK」的根源。返回结构化结果：
 *   { ok, reason, instanceId }；reason ∈ OK | NOROW | HIDDEN | NOSECTION。
 */
async function clickWorkspace(sourceRef, wsLabel) {
  const result = await ev(`(() => {
    const ref = ${JSON.stringify(sourceRef)}
    const sections = [...document.querySelectorAll('[data-chamber-section]')]
    const section = sections.find(s => s.getAttribute('data-chamber-section') === ref)
      ?? sections.find(s => (s.innerText || '').includes(ref))
    if (!section) return { ok: false, reason: 'NOSECTION', instanceId: null }
    const instanceId = section.getAttribute('data-chamber-section')
    const rows = [...section.querySelectorAll('[role="treeitem"]')]
    const row = rows.find(r => {
      const txt = (r.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean)
      return txt.includes(${JSON.stringify(wsLabel)})
    }) ?? rows.find(r => r.getAttribute('data-chamber-row') === ${JSON.stringify(wsLabel)})
    if (!row) return { ok: false, reason: 'NOROW', instanceId }
    const r = row.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return { ok: false, reason: 'HIDDEN', instanceId }
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.x + 30, clientY: r.y + r.height / 2 }))
    row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.x + 30, clientY: r.y + r.height / 2 }))
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.x + 30, clientY: r.y + r.height / 2 }))
    return { ok: true, reason: 'OK', instanceId }
  })()`)
  return result ?? { ok: false, reason: 'EVALFAILED', instanceId: null }
}

/** I9：点不中/不可见 = 失败，绝不静默继续（否则「点不中反而更快」会被记成好成绩）。 */
/**
 * I15 严格档语义（同 `--require-hover`）：`--require-switch` 下「没发生切换」= FAIL。
 * 不加旗标时不静默：仍然**响亮告警**并把它记进结果（paintSeen=false 会随 JSON 落盘），
 * 这样"未执行"既不会被读成绿，也不会在对照基线时凭空消失。
 */
function assertPainted(label, expectedInstance, summary) {
  if (expectedInstance == null || summary.paintAfterSettle === true) return
  const message = `switch-measure：${label} 目标实例 ${expectedInstance} 未在安静样本上绘制（paintSeen=${summary.paintSeen}）——`+
    '该次「settle」不能证明切换发生。'
  if (requireFlag) {
    console.error('FAIL ' + message)
    process.exit(1)
  }
  console.warn('WARN ' + message + '（加 --require-switch 会直接失败）')
}

function requireTarget(result, label) {
  if (result?.ok === true) return result
  console.error(`switch-measure FAIL：${label} 目标不可达（${result?.reason ?? 'UNKNOWN'}）——来源/工作区行不存在或不可见；`+
    '请用 --source-a/--workspace-a/--source-b/--workspace-b 指定，或先展开该来源与工作区。')
  process.exit(1)
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
  // I9：把**当前绘制中的实例**记进样本——"安静"不等于"目标已上屏"，
  // paintSeen 就是这两者的机器区分（见 §4-R7 的三要素判据）。
  const view = document.querySelector('.instance-view:not(.instance-hidden)')
  const instance = view ? view.getAttribute('data-instance') : null
  return { done: false, skeleton, head, instance, quietMs: Math.round(performance.now() - lastLtEnd), at: Math.round(performance.now()) }
})()`

async function switchAndMeasure(label, target, expectedInstance) {
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
  // 口径（2026-09 review minor2，见 README「指标口径」）：click → 首个「安静」
  // 轮询间隔 = settle **下界**，非内容稳定证明——轮询只断言 !skeleton &&
  // quietMs>700，不校验目标视图/内容确已切换
  s.clickToSettledMs = res.elapsedMs
  s.skeletonWindowMs = skelIdx >= 0 && skelEnd > skelIdx ? trail[skelEnd].at - trail[skelIdx].at : null
  s.skeletonSeen = skelIdx >= 0
  s.longtasksDelta = after.longtasks.length - (before?.longtasks?.length ?? 0)
  // I9 paintSeen：轮询轨迹里出现过"目标实例正在绘制"的样本，且它在一次安静样本上出现
  // （安静但屏上仍是旧实例 ⇒ paintSeen=false：settle 只是"没在忙"，不是"切到了"）。
  const paintTrail = Array.isArray(res.trail) ? res.trail : []
  const painted = paintTrail.filter(sample => sample.instance === expectedInstance)
  s.expectedInstance = expectedInstance
  s.paintSeen = painted.length > 0
  s.paintAfterSettle = painted.some(sample => !sample.skeleton && sample.quietMs > 700)
  assertPainted(label, expectedInstance, s)
  console.log(label, JSON.stringify(s))
  return s
}

const results = []
// G3（审计假绿面 #3）：相位异常原本全吞、results=[] 也 exit 0 ⇒ 一次"跑了个寂寞"被当成基线。
let phaseFailures = 0
console.log('prep:', await closeSettingsIfOpen())
// 打开两个源的工作区行到可见态（树展开）
const T_A = () => clickWorkspace(TARGET_A.source, TARGET_A.workspace)
const T_B = () => clickWorkspace(TARGET_B.source, TARGET_B.workspace)
const preA = requireTarget(await T_A(), 'preclick A')
await sleep(2500)
const preB = requireTarget(await T_B(), 'preclick B')
await sleep(2500)
requireTarget(await T_A(), 'preclick A (second)')
await sleep(3000)
if (preA.instanceId === preB.instanceId) {
  console.error(`switch-measure FAIL：A/B 解析到同一个来源 ${preA.instanceId}——切换场景需要两个不同来源。`)
  process.exit(1)
}

if (rapidN > 0) {
  // 场景③：快速连点远程目标 N 次（不等待中间 settle）
  const before = await readPerf(cdp, cdp.send)
  const t0 = Date.now()
  for (let i = 0; i < rapidN; i++) {
    requireTarget(await T_B(), 'rapid target')
    await sleep(90)
  }
  const res = await pollState(cdp, cdp.send, `(() => { const s = ${MARKER}; s.done = !s.skeleton && s.quietMs > 900; return s })()`, { timeoutMs: 90000 })
  const after = await readPerf(cdp, cdp.send)
  const s = summarize(after, `rapid-x${rapidN}`)
  s.clicksMs = Date.now() - t0
  // 口径（2026-09 review minor2，同 clickToSettledMs）：末次 click → 首个「安静」
  // 轮询间隔 = settle **下界**；I9 追加 paintSeen：安静且目标实例在屏，才算切换发生。
  s.lastClickToQuietMs = res.elapsedMs
  const rapidTrail = Array.isArray(res.trail) ? res.trail : []
  s.paintSeen = rapidTrail.some(sample => sample.instance === preB.instanceId)
  s.paintAfterSettle = rapidTrail.some(sample => sample.instance === preB.instanceId && !sample.skeleton)
  assertPainted(`rapid-x${rapidN}`, preB.instanceId, s)
  s.longtasksDelta = after.longtasks.length - (before?.longtasks?.length ?? 0)
  console.log(JSON.stringify(s, null, 1))
  results.push(s)
} else {
  for (let i = 0; i < cycles; i++) {
    console.log('== phase A→B #' + (i + 1) + ' ==')
    try { results.push(await switchAndMeasure(`A→B #${i + 1}`, T_B, preB.instanceId)) } catch (e) { phaseFailures += 1; console.log('switch failed:', e.message) }
    console.log('== phase B→A #' + (i + 1) + ' ==')
    try { results.push(await switchAndMeasure(`B→A #${i + 1}`, T_A, preA.instanceId)) } catch (e) { phaseFailures += 1; console.log('switch failed:', e.message) }
  }
}

// nit4 (2026-09 review)：输出补 env 键（与 boot/eval/disk-walk 的 env 键同构）；
// nit1：--out 目标目录未必已存在，写前先建（仿 disk-walk-baseline.mjs）
if (results.length === 0) {
  console.error('switch-measure FAIL：没有任何一次测量落盘（相位全部异常）——不写空基线、不 exit 0。')
  cdp.close()
  process.exit(1)
}
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), env: { node: process.version }, results }, null, 2))
console.log(`written: ${outPath}`)
cdp.close()
if (phaseFailures > 0) {
  console.error(`switch-measure FAIL：${phaseFailures} 个相位异常（结果 ${results.length} 条已落盘，但本次不得当作完整基线）。`)
  process.exit(1)
}
process.exit(0)
