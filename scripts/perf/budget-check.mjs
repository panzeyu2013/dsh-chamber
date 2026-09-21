#!/usr/bin/env node
/**
 * budget-check —— 分档预算验收执行器（plan 决定 9「度量口径改为分档预算」/
 * §9 验收矩阵性能行）。
 *
 * 分工：measure-ui.mjs / switch-frame-probe.mjs 负责**采集**（同环境、同实例、
 * 同挂载壳数档位），本脚本负责**判据**——读入基线 A 与候选 B 两份采集 JSON，
 * 按「每壳 DOM + p95 帧时 + 长任务 + 堆」逐项给出上限与判决，任一超限即 exit 1。
 *
 * 为什么是分档而不是全页单值：全页 DOM 与壳数同向增长，单一「全页 ≤13,000」
 * 既惩罚多 server（用户真实用法）又放过单壳膨胀（真正的泄漏）。分档 = 先固定
 * 档位（--tier 2|4|8，与实机矩阵同档），再对**每壳**与**分布**（p95）比较。
 *
 * 判据（默认值可被 --budgets JSON 覆盖；都是「不超过 A 的 k 倍或绝对地板」）：
 *   perShellDom   候选每壳最大节点数 ≤ max(A 每壳最大, 1500) × 1.15
 *   p95FrameMs    候选 ≤ max(A p95, 20ms) × 1.25
 *   worstFrameMs  候选 ≤ 500ms（绝对上限；单帧 >500ms 是可见卡顿）
 *   longTaskOver100  候选 ≤ A + 2（全页空闲窗内 >100ms 长任务条数）
 *   maxLongTaskMs 候选 ≤ 200ms（绝对上限）
 *   heapUsed      候选 ≤ A × 1.2
 *   mountedShells 给了 --tier 时必须等于档位；未给则与 A 相差 ≤1
 * 缺字段（采集降级）→ 该行记 skip，不判失败也不判通过（errors 里单独可见）。
 *
 * 用法：
 *   node scripts/perf/budget-check.mjs --baseline a.json --candidate b.json [--tier 4]
 *        [--warn-only] [--json] [--budgets budgets.json]
 *   node scripts/perf/budget-check.mjs --self-test
 * 退出码：0 全过 / 1 超预算 / 2 用法或 IO 错误。--warn-only 时超限仍打印但 exit 0。
 */
import { readFileSync } from 'node:fs'

const DEFAULTS = Object.freeze({
  perShellDomRatio: 1.15,
  perShellDomFloor: 1_500,
  p95FrameRatio: 1.25,
  p95FrameFloorMs: 20,
  worstFrameCeilingMs: 500,
  longTaskCountDelta: 2,
  maxLongTaskCeilingMs: 200,
  heapRatio: 1.2,
  shellsTolerance: 1,
})

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Tolerant extraction:采集脚本 schema 演进时缺字段即 null（skip），不猜。 */
export function extract(doc) {
  if (doc === null || typeof doc !== 'object') return {}
  const rows = Array.isArray(doc.dom?.perInstanceNodes) ? doc.dom.perInstanceNodes : []
  const perShell = rows.map(r => (typeof r?.nodes === 'number' ? r.nodes : null)).filter(n => n !== null)
  perShell.sort((a, b) => a - b)
  const over100 = (doc.idle?.longtasks ?? []).filter(lt => (lt?.dur ?? 0) > 100).length
  return {
    mountedShells: typeof doc.mountedShells === 'number'
      ? doc.mountedShells
      : (typeof doc.dom?.views?.mounted === 'number' ? doc.dom.views.mounted : null),
    perShellMax: perShell.length > 0 ? perShell[perShell.length - 1] : null,
    p95FrameMs: typeof doc.frames?.p95Ms === 'number' ? doc.frames.p95Ms : null,
    worstFrameMs: typeof doc.frames?.worstMs === 'number' ? doc.frames.worstMs : null,
    longTaskOver100: doc.idle?.longtasks === undefined ? null : over100,
    maxLongTaskMs: typeof doc.idle?.maxLongtaskMs === 'number' ? doc.idle.maxLongtaskMs : null,
    heapUsed: typeof doc.heap?.usedJSHeapSize === 'number' ? doc.heap.usedJSHeapSize : null,
  }
}

function row(metric, baseline, candidate, ceiling, note) {
  if (candidate === null || candidate === undefined) return { metric, baseline, candidate: null, ceiling, verdict: 'skip', note: note ?? 'candidate field missing' }
  if (baseline === null || baseline === undefined) return { metric, baseline: null, candidate, ceiling, verdict: 'skip', note: note ?? 'baseline field missing' }
  return { metric, baseline, candidate, ceiling, verdict: candidate <= ceiling ? 'pass' : 'fail', note }
}

/** Pure judge: 给定 A/B 快照与预算，返回逐行判决（--self-test 直接驱动它）。 */
export function evaluate({ baseline, candidate, tier = null, budgets = DEFAULTS }) {
  const a = extract(baseline)
  const b = extract(candidate)
  const rows = [
    row('perShellDom.maxNodes', a.perShellMax, b.perShellMax,
      Math.round(Math.max(a.perShellMax ?? 0, budgets.perShellDomFloor) * budgets.perShellDomRatio),
      '每壳 DOM（档位内线性）'),
    row('frames.p95Ms', a.p95FrameMs, b.p95FrameMs,
      Math.round(Math.max(a.p95FrameMs ?? 0, budgets.p95FrameFloorMs) * budgets.p95FrameRatio * 10) / 10,
      'p95 帧间隔'),
    row('frames.worstMs', a.worstFrameMs, b.worstFrameMs, budgets.worstFrameCeilingMs, '最坏单帧（绝对上限）'),
    row('idle.longTaskOver100', a.longTaskOver100, b.longTaskOver100,
      (a.longTaskOver100 ?? 0) + budgets.longTaskCountDelta, '空闲窗 >100ms 长任务条数'),
    row('idle.maxLongtaskMs', a.maxLongTaskMs, b.maxLongTaskMs, budgets.maxLongTaskCeilingMs, '最长长任务（绝对上限）'),
    row('heap.usedJSHeapSize', a.heapUsed, b.heapUsed,
      a.heapUsed === null ? null : Math.round(a.heapUsed * budgets.heapRatio), '堆用量'),
  ]
  if (b.mountedShells === null) {
    rows.push({ metric: 'mountedShells', baseline: a.mountedShells, candidate: null, ceiling: tier ?? null, verdict: 'skip', note: 'shell count missing' })
  } else if (tier !== null) {
    rows.push({
      metric: 'mountedShells', baseline: a.mountedShells, candidate: b.mountedShells, ceiling: tier,
      verdict: b.mountedShells === tier ? 'pass' : 'fail',
      note: '必须等于 --tier（档位一致性：跨档比较无意义）',
    })
  } else {
    const ceiling = a.mountedShells === null ? null : a.mountedShells + budgets.shellsTolerance
    rows.push(row('mountedShells', a.mountedShells, b.mountedShells, ceiling, '与基线同档（±1）'))
  }
  // G2（审计假绿面 #2）：全部指标 skip 时 ok 仍为 true ⇒ exit 0。判过必须至少有一条被判过的指标。
  const judged = rows.filter(r => r.verdict !== 'skip')
  return {
    rows,
    ok: rows.every(r => r.verdict !== 'fail') && judged.length > 0,
    judged: judged.length,
    skipped: rows.filter(r => r.verdict === 'skip').map(r => r.metric),
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`无法读取/解析 ${path}：${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}

function selfTest() {
  const assert = (cond, label) => { if (!cond) { console.error(`self-test FAIL: ${label}`); process.exit(1) } }
  const base = {
    mountedShells: 4,
    dom: { views: { mounted: 4 }, perInstanceNodes: [{ nodes: 1000 }, { nodes: 1200 }, { nodes: 1100 }, { nodes: 900 }] },
    heap: { usedJSHeapSize: 200 * 1024 * 1024 },
    idle: { longtasks: [{ dur: 60 }, { dur: 140 }], maxLongtaskMs: 140 },
    frames: { p95Ms: 16.8, worstMs: 120 },
  }
  const clone = () => JSON.parse(JSON.stringify(base))
  // 1. 同档微增 → 全过
  const same = clone(); same.dom.perInstanceNodes[1].nodes = 1300
  let r = evaluate({ baseline: base, candidate: same, tier: 4 })
  assert(r.ok, 'small per-shell growth must pass')
  // 2. 每壳膨胀 40% → perShellDom 失败（全页节点数可能完全一样，这正是分档的意义）
  const fat = clone(); fat.dom.perInstanceNodes = fat.dom.perInstanceNodes.map(n => ({ nodes: n.nodes + 600 }))
  r = evaluate({ baseline: base, candidate: fat, tier: 4 })
  assert(!r.ok && r.rows.some(x => x.metric === 'perShellDom.maxNodes' && x.verdict === 'fail'), 'per-shell bloat must fail')
  // 3. p95 帧时恶化 → 失败
  const slow = clone(); slow.frames.p95Ms = 40
  r = evaluate({ baseline: base, candidate: slow, tier: 4 })
  assert(!r.ok && r.rows.some(x => x.metric === 'frames.p95Ms' && x.verdict === 'fail'), 'p95 regression must fail')
  // 4. 档位不一致 → 失败（跨档比较无意义）
  const tierDrift = clone(); tierDrift.mountedShells = 6
  r = evaluate({ baseline: base, candidate: tierDrift, tier: 4 })
  assert(!r.ok && r.rows.some(x => x.metric === 'mountedShells' && x.verdict === 'fail'), 'tier mismatch must fail')
  // 5. 长任务超绝对上限 / 缺字段 → skip 而不是 fail
  const lt = clone(); lt.idle.maxLongtaskMs = 260
  r = evaluate({ baseline: base, candidate: lt, tier: 4 })
  assert(!r.ok, 'absolute long-task ceiling must fail')
  const missing = clone(); delete missing.heap
  r = evaluate({ baseline: base, candidate: missing, tier: 4 })
  assert(r.ok && r.skipped.includes('heap.usedJSHeapSize'), 'missing field must skip, never fabricate')
  console.log('budget-check self-test: 6 cases ok')
}

function main() {
  if (process.argv.includes('--self-test')) { selfTest(); return }
  const baselinePath = argValue('--baseline')
  const candidatePath = argValue('--candidate')
  if (!baselinePath || !candidatePath) {
    console.error('用法：node scripts/perf/budget-check.mjs --baseline <A.json> --candidate <B.json> [--tier 2|4|8] [--warn-only] [--json] [--self-test]')
    process.exit(2)
  }
  const tierRaw = argValue('--tier')
  const tier = tierRaw === undefined ? null : Number(tierRaw)
  if (tier !== null && ![2, 4, 8].includes(tier)) {
    console.error('--tier 只接受 2/4/8（实机矩阵的三档）')
    process.exit(2)
  }
  const budgetsPath = argValue('--budgets')
  const budgets = budgetsPath ? { ...DEFAULTS, ...readJson(budgetsPath) } : DEFAULTS
  const result = evaluate({ baseline: readJson(baselinePath), candidate: readJson(candidatePath), tier, budgets })
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`budget-check: A=${baselinePath} B=${candidatePath}${tier ? ` tier=${tier}` : ''}`)
    for (const r of result.rows) {
      const fmt = v => v === null ? 'n/a' : (typeof v === 'number' && v > 1_000_000 ? `${(v / 1024 / 1024).toFixed(1)}MiB` : String(v))
      console.log(`  ${r.verdict.toUpperCase().padEnd(4)} ${r.metric.padEnd(24)} A=${fmt(r.baseline).padEnd(10)} B=${fmt(r.candidate).padEnd(10)} 上限=${fmt(r.ceiling)}${r.note ? `  （${r.note}）` : ''}`)
    }
    if (result.skipped.length > 0) console.log(`  跳过（采集缺字段，不判通过）：${result.skipped.join(', ')}`)
  }
  const warnOnly = process.argv.includes('--warn-only')
  if (!result.ok && !warnOnly) {
    console.error('budget-check: 存在超预算项（--warn-only 可只看不拦）')
    process.exit(1)
  }
}

main()
