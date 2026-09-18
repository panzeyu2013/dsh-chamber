#!/usr/bin/env node
//  手动验收：编译仓库策略源 + 探针，跑 baseline/policy 矩阵并断言
//  （design 25 §5.1 / deviations S-48）。
//
//  为什么是"编译仓库源文件"而不是读一个串：策略模式里注入的就是
//  ShellOverscrollPolicy.makeUserScript() 的真实产出，手抄/替换这一步不存在，
//  因此 B1 那类"占位符未插值"缺陷会在这里直接现形。
//
//  用法（手动，不进 CI；需要已登录的 GUI 会话——探针会建 accessory 窗口并合成滚轮）：
//      node macos/scripts/overscroll-probe/run.mjs            # 只打印观测
//      node macos/scripts/overscroll-probe/run.mjs --assert   # 断言失败时退出 1
//  （无 GUI 的机器只跑编译面：node macos/scripts/overscroll-probe/typecheck.mjs，已接入 darwin 门禁。）
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 注入串的签入锚：任何对 ShellOverscrollPolicy 的**有意**改动都必须同步这一行，
// 并复核 design 25 §5.1 / deviations S-48（否则注入面会在无人察觉时漂移）。
const POLICY_SHA256_PIN = '8eaa28f3b073c9069e04ed8eb38fc9f5e986da679a475c39129020ae17b6a210'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const assertMode = process.argv.includes('--assert')
const work = mkdtempSync(join(tmpdir(), 'dsh-overscroll-probe-'))
const bin = join(work, 'osc-probe')
const env = { ...process.env, TMPDIR: work }

console.log('[probe] compiling: main.swift + macos/Sources/DSHChamberPoc/ShellOverscrollPolicy.swift')
execFileSync(
  'xcrun',
  ['swiftc', '-O', '-module-cache-path', join(work, 'modulecache'), '-o', bin,
    join(here, 'main.swift'),
    join(root, 'macos/Sources/DSHChamberPoc/ShellOverscrollPolicy.swift'),
    '-framework', 'AppKit', '-framework', 'WebKit'],
  { stdio: ['ignore', 'inherit', 'inherit'], env },
)

function parse(line) {
  return Object.fromEntries(line.trim().split(/\s+/).map((kv) => {
    const i = kv.indexOf('=')
    return [kv.slice(0, i), kv.slice(i + 1)]
  }))
}
function run(mode, scenario) {
  const out = execFileSync(bin, [mode, scenario], { encoding: 'utf8', env, timeout: 120_000 })
  if (out.includes('HARNESS-ERROR')) {
    throw new Error('探针上报 HARNESS-ERROR（采样失败绝不当 0 用）：\n' + out)
  }
  const measures = []
  let harness = null
  for (const line of out.split('\n')) {
    if (line.startsWith('HARNESS ')) harness = parse(line.slice(8))
    if (line.startsWith('MEASURE ')) measures.push(parse(line.slice(8)))
  }
  if (measures.length === 0) throw new Error('probe produced no MEASURE line: ' + out)
  return { measures, harness }
}
const num = (m, k) => Number(m[k])
const abs = (m) => Math.max(Math.abs(num(m, 'vvTopMin')), Math.abs(num(m, 'vvTopMax')))

const modes = {}
for (const scenario of ['bar-up', 'bar-down', 'content-top-up', 'content-bottom-down', 'content-mid']) {
  modes['baseline:' + scenario] = run('baseline', scenario).measures[0]
}
for (const scenario of ['bar-up', 'bar-down', 'content-top-up', 'content-bottom-down', 'content-mid', 'scope', 'causal']) {
  const r = run('policy', scenario)
  modes['policy:' + scenario] = r.measures
  modes.harness = r.harness
}

console.log('\n=== observations (vvTop = visualViewport.pageTop during held gesture) ===')
for (const [key, v] of Object.entries(modes)) {
  if (key === 'harness') continue
  for (const m of Array.isArray(v) ? v : [v]) {
    console.log('[' + key.split(':')[0] + '] ' + Object.entries(m).map(([k, val]) => k + '=' + val).join(' '))
  }
}
console.log('policy bytes=' + modes.harness.policyBytes + ' sha256=' + modes.harness.policySHA256)

const checks = []
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail })
const B = (s) => modes['baseline:' + s]
const P = (s) => modes['policy:' + s][0]

check('baseline bar-up overscrolls (vvTopMin <= -8)', num(B('bar-up'), 'vvTopMin') <= -8, 'vvTopMin=' + num(B('bar-up'), 'vvTopMin'))
check('baseline content-top-up overscrolls (vvTopMin <= -8)', num(B('content-top-up'), 'vvTopMin') <= -8, 'vvTopMin=' + num(B('content-top-up'), 'vvTopMin'))
check('baseline content-bottom-down overscrolls (vvTopMax >= 8)', num(B('content-bottom-down'), 'vvTopMax') >= 8, 'vvTopMax=' + num(B('content-bottom-down'), 'vvTopMax'))
for (const s of ['bar-up', 'bar-down', 'content-top-up', 'content-bottom-down']) {
  check('policy ' + s + ' has no viewport shift (|vvTop| <= 1pt 容差)', abs(P(s)) <= 1, 'max|vvTop|=' + abs(P(s)))
}
check('policy 注入的样式在册 (styleCount >= 1)', Number(P('bar-up').styleCount) >= 1, 'styleCount=' + P('bar-up').styleCount)
check('computed overscrollBehavior = none', String(P('bar-up').de).includes('none'), 'de=' + P('bar-up').de)
const scope = P('scope')
check('scope: 主文档有注入样式', Number(scope.mainStyles) >= 1, 'mainStyles=' + scope.mainStyles)
check('scope: 主文档 computed = none', String(scope.mainDe).includes('none'), 'mainDe=' + scope.mainDe)
check('scope: iframe 子文档不被注入（forMainFrameOnly 可观测面）', Number(scope.iframeStyles) === 0, 'iframeStyles=' + scope.iframeStyles)
check('scope: iframe 保持自身 auto', String(scope.iframeDe).includes('auto'), 'iframeDe=' + scope.iframeDe)
// 合成滚轮的指针落点语义不由装置保证（NSEvent windowNumber=0），所以"正常滚动"用实测能驱动
// 内层滚动器的那条手势（bar-down：#main 0→810）比对两态位移，而不是拿指针位置当断言维度。
const scrollB = num(B('bar-down'), 'mainAfter') - num(B('bar-down'), 'mainBefore')
const scrollP = num(P('bar-down'), 'mainAfter') - num(P('bar-down'), 'mainBefore')
check('normal scroll still works in both modes (inner scroller moves >= 50px)', scrollB >= 50 && scrollP >= 50, 'baseline=' + scrollB + ' policy=' + scrollP)
check('normal scroll identical across modes (|Δ| <= 1)', Math.abs(scrollB - scrollP) <= 1, 'baseline=' + scrollB + ' policy=' + scrollP)
const causal = modes['policy:causal']
const byLabel = Object.fromEntries(causal.map((m) => [m.scenario, m]))
check('causal: with policy no shift', abs(byLabel['causal-with-policy']) <= 1, 'max|vvTop|=' + abs(byLabel['causal-with-policy']))
check('causal: after runtime removal the shift returns (vvTopMin <= -8)', num(byLabel['causal-after-remove'], 'vvTopMin') <= -8, 'vvTopMin=' + num(byLabel['causal-after-remove'], 'vvTopMin'))
check('causal: after re-adding the policy no shift', abs(byLabel['causal-after-readd']) <= 1, 'max|vvTop|=' + abs(byLabel['causal-after-readd']))
check('注入串指纹 == 签入锚（bytes=' + modes.harness.policyBytes + '）',
  modes.harness.policySHA256 === POLICY_SHA256_PIN,
  'sha256=' + modes.harness.policySHA256 + '（若是有意改动注入串：同步更新 POLICY_SHA256_PIN 并复核 S-48/§5.1）')

console.log('\n=== checks ===')
let failed = 0
for (const c of checks) {
  if (!c.ok) failed += 1
  console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + '  [' + c.detail + ']')
}
console.log('\n' + (failed === 0 ? 'PROBE OK' : 'PROBE FAILED (' + failed + ' check(s))'))
if (assertMode && failed > 0) process.exit(1)
