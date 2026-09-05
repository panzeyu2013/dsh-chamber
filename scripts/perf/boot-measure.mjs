#!/usr/bin/env node
/**
 * T0 场景①（启动：骨架 → 内容）实机采集。
 *
 * 流程（对每个 run）：
 *   1. 连接 CDP 页面 target（localhost:9333，dev 实例 --remote-debugging-port=9333）；
 *   2. 注入早期性能观察者（addScriptToEvaluateOnNewDocument，长任务/layout-shift/paint
 *      自导航起点 buffered 采集）；
 *   3. Page.reload → 每 ~120ms 轮询页面状态快照：骨架(.instance-loading)出现与消失、
 *      侧栏实例列表就绪（"本地实例"/来源文本）——记录骨架→内容区间；
 *   4. 读取 __dshPerf，输出 JSON：长任务列表/最大/前 5、CLS、FCP/DCL/load、区间时长。
 *
 * 用法：node scripts/perf/boot-measure.mjs [runs=3] [--out scripts/perf/data/boot-baseline.json]
 * 前置：dev Electron 实例已以 --remote-debugging-port=9333 运行（实例已含本地连接）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { findPageTarget, connect, installEarlyObservers, pollState, readPerf, summarize } from './cdp-lib.mjs'

const runs = Number(process.argv[2] ?? 3)
const outFlag = process.argv.indexOf('--out')
const outPath = outFlag >= 0 ? process.argv[outFlag + 1] : 'scripts/perf/data/boot-baseline.json'
// nit2 (2026-09 review)：runs 非有限正整数时旧代码静默跑 0 次并写出空文件
// （首参误为 --out 即得 NaN）——改为显式报错退出
if (!Number.isInteger(runs) || runs < 1) {
  console.error('用法：node scripts/perf/boot-measure.mjs [runs=3] [--out scripts/perf/data/boot-baseline.json]')
  console.error(`runs 须为 ≥1 的整数，收到：${JSON.stringify(process.argv[2] ?? '(缺省)')}`)
  process.exit(1)
}

const page = await findPageTarget(9333)
const cdp = connect(page.webSocketDebuggerUrl)
await cdp.ready
await installEarlyObservers(cdp, cdp.send)

// 状态快照：骨架元素存在性 + 侧栏实例就绪 + 长任务安静。
// 快照按 run 生成并嵌入本次导航发起时刻 tReload——nit5 (2026-09 review)：
// Page.reload 后首轮 poll 可能仍命中 reload 前旧文档（其 performance.timeOrigin
// 早于本次导航）；采样记录 timeOrigin，done 判定与归并前过滤都以
// timeOrigin ≥ tReload - RELOAD_SKEW_MS 为界（跨进程时钟偏差裕量；旧文档/
// 上一 run 文档必然早于该界）。
const RELOAD_SKEW_MS = 2000
const makeSnapshot = tReload => `(() => {
  const to = Math.round(performance.timeOrigin)
  const fresh = to >= ${tReload - RELOAD_SKEW_MS}
  const skeleton = !!document.querySelector('.instance-loading')
  const body = document.body.innerText || ''
  const hasInstanceList = body.includes('本地实例') || body.includes('已连接')
  const hasSource = body.includes('Desktop') || body.includes('工作区') || body.includes('选择工作区')
  const lt = window.__dshPerf ? window.__dshPerf.longtasks : []
  const lastLtEnd = lt.length ? lt[lt.length - 1].start + lt[lt.length - 1].dur : 0
  const quietMs = performance.now() - lastLtEnd
  const ready = !skeleton && hasInstanceList && hasSource
  const contentStable = ready && quietMs > 800
  return { done: contentStable && fresh, stale: !fresh, skeleton, hasInstanceList, hasSource, quietMs: Math.round(quietMs), at: Math.round(performance.now()), to }
})()`

const results = []
for (let i = 0; i < runs; i++) {
  const t0 = Date.now()
  console.log(`--- run ${i + 1}/${runs} ---`)
  const perf = await readPerf(cdp, cdp.send)
  if (perf) console.log('pre-reload baseline:', JSON.stringify(summarize(perf)))
  const tReload = Date.now() // nit5 分界锚点：本次导航发起时刻
  await cdp.send('Page.reload', { ignoreCache: false })
  // 轮询期间记录骨架起止时刻（快照嵌 tReload 分界：旧文档样本不置 done）
  const first = await pollState(cdp, cdp.send, makeSnapshot(tReload), { timeoutMs: 120000 })
  // 归并前丢弃 timeOrigin 早于本次导航的旧文档样本（其 at/to 为旧文档值）
  const trail = first.trail.filter(s => s.at == null || !s.stale)
  const after = await readPerf(cdp, cdp.send)
  // 从 trail 中推出骨架窗口
  const skeletonSeen = trail.findIndex(s => s.skeleton)
  // nit8 (2026-09 review)：原条件含恒真的 skeletonSeen >= 0（findIndex 结果非
  // 负即 -1；骨架未出现时窗口由下方 skeletonSeen >= 0 判定收口为 null）——
  // 删除该冗余判定，行为不变
  let skeletonGone = trail.findIndex(s => !s.skeleton && s.at > 0)
  if (skeletonGone < 0 && trail.length) skeletonGone = trail.length - 1
  const s = summarize(after, `boot-run-${i + 1}`)
  s.wallMs = Date.now() - t0
  s.skeletonWindowMs = skeletonSeen >= 0 && skeletonGone > skeletonSeen
    ? (trail[skeletonGone].at - trail[skeletonSeen].at)
    : null
  s.skeletonSeen = skeletonSeen >= 0
  s.pollTrail = trail.filter((t, idx) => idx % 5 === 0)
  results.push(s)
  console.log(JSON.stringify(s, null, 1))
  await new Promise(res => setTimeout(res, 1500))
}
// nit1 (2026-09 review)：--out 目标目录未必已存在，写前先建（仿 disk-walk-baseline.mjs）
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), env: { node: process.version }, results }, null, 2))
console.log(`written: ${outPath}`)
cdp.close()
process.exit(0)
