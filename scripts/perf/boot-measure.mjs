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
import { writeFileSync } from 'node:fs'
import { findPageTarget, connect, installEarlyObservers, pollState, readPerf, summarize } from './cdp-lib.mjs'

const runs = Number(process.argv[2] ?? 3)
const outFlag = process.argv.indexOf('--out')
const outPath = outFlag >= 0 ? process.argv[outFlag + 1] : 'scripts/perf/data/boot-baseline.json'

const page = await findPageTarget(9333)
const cdp = connect(page.webSocketDebuggerUrl)
await cdp.ready
await installEarlyObservers(cdp, cdp.send)

// 状态快照：骨架元素存在性 + 侧栏实例就绪 + 长任务安静
const STATE_SNAPSHOT = `(() => {
  const skeleton = !!document.querySelector('.instance-loading')
  const body = document.body.innerText || ''
  const hasInstanceList = body.includes('本地实例') || body.includes('已连接')
  const hasSource = body.includes('Desktop') || body.includes('工作区') || body.includes('选择工作区')
  const lt = window.__dshPerf ? window.__dshPerf.longtasks : []
  const lastLtEnd = lt.length ? lt[lt.length - 1].start + lt[lt.length - 1].dur : 0
  const quietMs = performance.now() - lastLtEnd
  const ready = !skeleton && hasInstanceList && hasSource
  const contentStable = ready && quietMs > 800
  return { done: contentStable, skeleton, hasInstanceList, hasSource, quietMs: Math.round(quietMs), at: Math.round(performance.now()) }
})()`

const results = []
for (let i = 0; i < runs; i++) {
  const t0 = Date.now()
  console.log(`--- run ${i + 1}/${runs} ---`)
  const perf = await readPerf(cdp, cdp.send)
  if (perf) console.log('pre-reload baseline:', JSON.stringify(summarize(perf)))
  await cdp.send('Page.reload', { ignoreCache: false })
  // 轮询期间记录骨架起止时刻
  const first = await pollState(cdp, cdp.send, STATE_SNAPSHOT, { timeoutMs: 120000 })
  const after = await readPerf(cdp, cdp.send)
  // 从 trail 中推出骨架窗口
  const skeletonSeen = first.trail.findIndex(s => s.skeleton)
  let skeletonGone = first.trail.findIndex(s => !s.skeleton && skeletonSeen >= 0 && s.at > 0)
  if (skeletonGone < 0 && first.trail.length) skeletonGone = first.trail.length - 1
  const s = summarize(after, `boot-run-${i + 1}`)
  s.wallMs = Date.now() - t0
  s.skeletonWindowMs = skeletonSeen >= 0 && skeletonGone > skeletonSeen
    ? (first.trail[skeletonGone].at - first.trail[skeletonSeen].at)
    : null
  s.skeletonSeen = skeletonSeen >= 0
  s.pollTrail = first.trail.filter((t, idx) => idx % 5 === 0)
  results.push(s)
  console.log(JSON.stringify(s, null, 1))
  await new Promise(res => setTimeout(res, 1500))
}
writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), env: { node: process.version }, results }, null, 2))
console.log(`written: ${outPath}`)
cdp.close()
process.exit(0)
