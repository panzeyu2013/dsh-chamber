#!/usr/bin/env node
/**
 * T6 H3 实验探针（2026-09，D3）：主 bundle 求值长任务归因。
 *
 * 每 run：**新建** CDP 连接（导航竞态下同一条 ws 跨 reload 偶发挂起——
 * 2026-09 实测）→ 注入早期观察者 → Page.reload 冷启 → settle 后读取：
 *   - 每条 ≥50ms 长任务的 attribution（containerSrc/Name）与 duration；
 *   - 引导期全部 JS 资源加载（URL + transferSize）——fetch 完成序即大体
 *     等于 module 求值序。
 * 目标：把「主 bundle 求值」长任务归因到具体 chunk（main/vendor/index/
 * chamber/chamber-covered/langs/*），供懒加载 A/B 前后对照。
 *
 * 用法：node scripts/perf/eval-measure.mjs [runs=3] [--out ...json]
 * 前置：dev Electron 实例已以 --remote-debugging-port=9333 运行。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { findPageTarget, connect, installEarlyObservers, pollState, readPerf } from './cdp-lib.mjs'

const runs = Number(process.argv[2] ?? 3)
const outFlag = process.argv.indexOf('--out')
const outPath = outFlag >= 0 ? process.argv[outFlag + 1] : 'scripts/perf/data/eval-baseline.json'
// nit2 (2026-09 review)：与 boot-measure 同病——runs 非有限正整数（含首参误为
// --out 得 NaN）时静默跑 0 次并写出空文件，改为显式报错退出
if (!Number.isInteger(runs) || runs < 1) {
  console.error('用法：node scripts/perf/eval-measure.mjs [runs=3] [--out scripts/perf/data/eval-baseline.json]')
  console.error(`runs 须为 ≥1 的整数，收到：${JSON.stringify(process.argv[2] ?? '(缺省)')}`)
  process.exit(1)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const results = []
for (let i = 0; i < runs; i++) {
  const label = `eval-run-${i + 1}`
  const page = await findPageTarget(9333)
  const cdp = connect(page.webSocketDebuggerUrl)
  await cdp.ready
  await installEarlyObservers(cdp, cdp.send)
  await cdp.send('Page.reload', { ignoreCache: false })
  const res = await pollState(cdp, cdp.send, `(() => {
    const skeleton = !!document.querySelector('.instance-loading')
    const body = document.body ? (document.body.innerText || '') : ''
    const lt = window.__dshPerf ? window.__dshPerf.longtasks : []
    const lastLtEnd = lt.length ? lt[lt.length - 1].start + lt[lt.length - 1].dur : 0
    return { done: !skeleton && body.includes('本地实例') && performance.now() - lastLtEnd > 700, quietMs: Math.round(performance.now() - lastLtEnd) }
  })()`, { timeoutMs: 60000, label })
  const perf = await readPerf(cdp, cdp.send)
  const lts = (perf?.longtasks ?? []).sort((a, b) => b.dur - a.dur).map(l => ({
    start: Math.round(l.start), dur: Math.round(l.dur * 10) / 10,
    attribution: l.attribution?.filter(a => a.containerSrc || a.containerName).slice(0, 3) ?? [],
  }))
  const js = (perf?.resources ?? [])
    .filter(r => r.name.endsWith('.js'))
    .map(r => ({ name: r.name.replace(/^.*\/assets\//, ''), size: r.size, dur: Math.round(r.dur * 10) / 10 }))
  results.push({ phase: label, wallSettleMs: res.elapsedMs, ok: res.ok, longtasks: lts, jsLoaded: js })
  console.log(label, JSON.stringify({ ok: res.ok, wallSettleMs: res.elapsedMs, ltCount: lts.length, topLtMs: lts.slice(0, 3).map(l => l.dur), ltAttr: lts.slice(0, 2).map(l => l.attribution), js: js.map(j => `${j.name}(${j.size})`).slice(0, 24) }))
  cdp.close()
  await sleep(1000)
}
// nit1 (2026-09 review)：--out 目标目录未必已存在，写前先建（仿 disk-walk-baseline.mjs）
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), env: { node: process.version }, results }, null, 2))
console.log(`written: ${outPath}`)
