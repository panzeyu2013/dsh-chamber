#!/usr/bin/env node
/**
 * remote-state-acceptance —— 远程会话状态与切源体验的**统一验收执行器**
 * （plan `docs/progress/todo/remote-session-state-and-switch.md` §9 验收矩阵 /
 * §10 测试与度量 / W4「验收脚本」交付物）。
 *
 * 为什么需要它：本仓的验收面横跨 6 个包 + 网关 + 手机壳，且**两种运行环境**
 * 混在一起——CI（有 node_modules、有 vendor 树）与本工作树（无 node_modules、
 * vendor 未物化）。把「真失败」与「环境阻塞」混为一谈，就会得到「本地绿」的
 * 假结论；这正是 plan §9 与 residual-verifiability-review 反复强调的诚实性要求。
 *
 * 本脚本因此做三件事：
 *   1. 按组跑**可跑的**测试文件（默认用 bundled node，可 --node 覆盖）；
 *   2. 逐文件分类：pass / fail / blocked（ERR_MODULE_NOT_FOUND、vendor 树未物化、
 *      或显式 skip 环境变量），blocked 一律列名并标注「CI 权威」；
 *   3. 打印验收表 + 写 JSON 报告；**只要存在真失败即 exit 1**，blocked 不判绿也
 *      不判红（单独一栏，绝不静默跳过）。
 *
 * 用法：
 *   node scripts/gates/remote-state-acceptance.mjs [--json] [--out <path>]
 *        [--node <path>] [--only <group>] [--list] [--self-test]
 * 退出码：0 = 无真失败（可能含 blocked）/ 1 = 有真失败 / 2 = 用法错误。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveNodeBinary, resolveSidecarDir } from '../lib/sidecar-assembly.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LOADER = 'packages/gateway/test/session-state/workspace-loader.mjs'

/**
 * Default interpreter: the assembly's bundled node when it is a real file, else
 * the node running this script. It used to be the absolute path
 * '/Applications/dsh-chamber.app/Contents/Resources/sidecar/node', which turned
 * every local run into ~30 bogus failures on any machine that did not carry the
 * maintainer's app bundle (P1-2 of the 13-scripts audit).
 */
function defaultNode() {
  return resolveNodeBinary(resolveSidecarDir())
}

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function listFiles(dir, match = /.test.(ts|mjs)$/) {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs).filter(f => match.test(f)).map(f => join(dir, f))
}

/** 组 = 一条验收面；env 为该组统一的进程环境（如 vendor 缺失显式 skip）。 */
const GROUPS = [
  {
    id: 'control-plane-protocol',
    cwd: 'packages/control-plane',
    // protocol/ = 协议与 mux；proxy/sse-resume = §11 风险条（Last-Event-ID 续传）的行为锁。
    files: [...listFiles('packages/control-plane/test/protocol'), 'test/proxy/sse-resume.test.ts'],
  },
  { id: 'gateway-session-state', cwd: 'packages/gateway', nodeArgs: ['--import', '../../' + LOADER], files: listFiles('packages/gateway/test/session-state') },
  { id: 'sidebar-state', cwd: 'packages/dsh-chamber-client-ui-sidebar', env: { DSH_CHAMBER_VENDOR_ABSENT: 'skip' }, files: [...listFiles('packages/dsh-chamber-client-ui-sidebar/test/session-rows'), ...listFiles('packages/dsh-chamber-client-ui-sidebar/test/session-state')] },
  { id: 'layout-theme', cwd: 'packages/dsh-chamber-client-ui-layout', files: listFiles('packages/dsh-chamber-client-ui-layout/test') },
  { id: 'renderer-state', cwd: 'packages/renderer', files: [
    'packages/renderer/test/aggregate/badge-count.test.ts',
    'packages/renderer/test/aggregate/notification-edges.test.ts',
    'packages/renderer/test/aggregate/notification-dedupe.test.ts',
    'packages/renderer/test/view-runtime/retention.test.ts',
    'packages/renderer/test/view-runtime/reveal-gate.test.ts',
    'packages/renderer/test/view-runtime/switch-frame-verdict.test.ts',
    'packages/renderer/test/view-runtime/switch-frame-instruments.test.ts',
    'packages/renderer/test/wiring/session-liveness-wiring.test.ts',
    'packages/renderer/test/lifecycle/source-readiness.test.ts',
    'packages/renderer/test/lifecycle/source-refresh-hint.test.ts',
    // WS-C 事实接线（probe/SSE 源 + v2 未读落盘 + 派生）
    ...listFiles('packages/renderer/test/session-state'),
  ].filter(f => existsSync(join(ROOT, f))) },
  { id: 'desktop-edges', cwd: 'packages/desktop', files: [
    'packages/desktop/test/desktop-shell/notifications.test.ts',
    'packages/desktop/test/desktop-shell/badge.test.ts',
    'packages/desktop/test/ipc/ipc-surface-mirror.test.ts',
  ].filter(f => existsSync(join(ROOT, f))) },
  { id: 'mobile-guards', cwd: 'packages/dsh-chamber-client-ui-mobile', files: [
    'packages/dsh-chamber-client-ui-mobile/scripts/artifact-scope-marker.test.mjs',
  ].filter(f => existsSync(join(ROOT, f))) },
  { id: 'instruments', cwd: '.', files: [], self: [
    { label: 'budget-check --self-test', args: ['scripts/perf/budget-check.mjs', '--self-test'] },
    { label: 'switch-frame-probe CLI fails loud on an unknown flag', args: ['scripts/perf/switch-frame-probe.mjs', '--definitely-not-a-flag'], expectExit: 'nonzero', marker: 'unknown argument' },
    { label: 'png-ink --self-test', args: ['scripts/lib/png-ink.mjs', '--self-test'] },
  ] },
]

const BLOCKED_MARKERS = [
  'ERR_MODULE_NOT_FOUND',
  'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING',
  'ERR_INVALID_TYPESCRIPT_SYNTAX',
  'vendor/harness-packages',
  '未物化',
  'ran no test body',
]

function runOne(node, cwd, file, nodeArgs, env) {
  const abs = resolve(ROOT, cwd)
  const relative = file.startsWith(cwd + '/') ? file.slice(cwd.length + 1) : file
  const res = spawnSync(node, [...(nodeArgs ?? []), relative], {
    cwd: abs,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, ...(env ?? {}) },
  })
  const out = (res.stdout ?? '') + (res.stderr ?? '')
  const pass = Number((out.match(/^ℹ pass (\d+)$/m) ?? [])[1] ?? '0')
  const fail = Number((out.match(/^ℹ fail (\d+)$/m) ?? [])[1] ?? '0')
  const tests = Number((out.match(/^ℹ tests (\d+)$/m) ?? [])[1] ?? '0')
  // G4（审计假绿面 #4）：BLOCKED 子串启发式会把输出里恰好含环境标记的**真断言失败**降级成
  // blocked（不计 fail ⇒ exit 0）。真失败优先：AssertionError / ℹ fail>0 一律判 fail。
  const blockedByEnv = BLOCKED_MARKERS.some(m => out.includes(m))
  const hardFail = fail > 0 || /AssertionError/.test(out)
  const blocked = blockedByEnv && !hardFail
  let verdict = 'pass'
  if (blocked) verdict = 'blocked'
  else if (hardFail || res.status !== 0 || tests === 0) verdict = 'fail'
  return { file: relative, verdict, tests, pass, fail, exit: res.status, detail: blocked ? (out.match(/^(?:Error|AssertionError)[^\n]*/m) ?? [])[0] ?? null : null }
}

/**
 * `--self-test`：**仪表本身必须能失败**（plan §10 的纪律）。用两个合成用例跑同一条
 * runOne 判据：故意失败的必须判 fail 且非零退出，故意通过的必须判 pass——
 * 两侧都要成立，才能排除「分类器一律判红」或「一律判绿」这两种假绿。
 */
function selfTest(node) {
  const dir = resolve(ROOT, '.tmp/acceptance/self-test')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'synthetic-fails.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('synthetic failure', () => { assert.equal(1, 2) })\n")
  writeFileSync(join(dir, 'synthetic-passes.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('synthetic pass', () => { assert.equal(1, 1) })\n")
  const bad = runOne(node, '.tmp/acceptance/self-test', 'synthetic-fails.test.mjs')
  const good = runOne(node, '.tmp/acceptance/self-test', 'synthetic-passes.test.mjs')
  const ok = bad.verdict === 'fail' && bad.exit !== 0 && good.verdict === 'pass'
  console.log(ok
    ? `acceptance self-test: ok（合成失败判 fail / exit ${bad.exit}；合成通过判 pass）`
    : `acceptance self-test: FAIL（失败用例判 ${bad.verdict}/exit ${bad.exit}，通过用例判 ${good.verdict}）`)
  process.exit(ok ? 0 : 1)
}

function main() {
  const node = argValue('--node') ?? defaultNode()
  if (!existsSync(node)) {
    console.error(`remote-state-acceptance: node 解释器不存在：${node}——用 --node 指定可执行文件，或先物化 sidecar 装配（${'DSH_CHAMBER_SIDECAR_DIR'}）`)
    process.exit(2)
  }
  const only = argValue('--only')
  const wantJson = process.argv.includes('--json')
  const groups = GROUPS.filter(g => only === undefined || g.id === only)
  if (only !== undefined && groups.length === 0) {
    console.error(`未知分组 ${only}；可用：${GROUPS.map(g => g.id).join(', ')}`)
    process.exit(2)
  }
  // G1（审计假绿面 #1）：整组文件来自 listFiles/existsSync —— 目录改名或清空会让该组变成
  // 0 项而整体仍 exit 0。这与本脚本头注释的"不静默跳过"矛盾，故空组一律报错退出。
  const emptyGroups = groups.filter(g => g.files.length + (g.self?.length ?? 0) === 0)
  if (emptyGroups.length > 0) {
    for (const g of emptyGroups) console.error(`分组 ${g.id} 登记项为 0——目录改名/清空不得静默通过`)
    process.exit(2)
  }
  if (process.argv.includes('--list')) {
    for (const g of groups) console.log(`${g.id.padEnd(24)} ${(g.files.length + (g.self?.length ?? 0))} 项`)
    return
  }
  const rows = []
  for (const group of groups) {
    for (const file of group.files) rows.push({ group: group.id, ...runOne(node, group.cwd, file, group.nodeArgs, group.env) })
    for (const s of group.self ?? []) {
      const res = spawnSync(node, s.args, { cwd: ROOT, encoding: 'utf8', timeout: 120_000 })
      const out = (res.stdout ?? '') + (res.stderr ?? '')
      // expectExit: 'zero'（默认，自测类）要求 exit 0；'nonzero' 要求**响亮失败**
      // （CLI 参数面探针：未知旗标必须报错而不是被吞掉）。marker 为可选附加证据。
      const expectNonzero = s.expectExit === 'nonzero'
      const exitOk = expectNonzero ? res.status !== 0 : res.status === 0
      const markerOk = s.marker === undefined || out.includes(s.marker)
      const ok = exitOk && markerOk
      rows.push({ group: group.id, file: s.label, verdict: ok ? 'pass' : 'fail', tests: 0, pass: 0, fail: ok ? 0 : 1, exit: res.status, detail: ok ? null : out.split('\n').slice(-3).join(' ') })
    }
  }
  const totals = {
    pass: rows.filter(r => r.verdict === 'pass').length,
    fail: rows.filter(r => r.verdict === 'fail').length,
    blocked: rows.filter(r => r.verdict === 'blocked').length,
    assertions: rows.reduce((n, r) => n + r.pass, 0),
  }
  const report = { schema: 'remote-state-acceptance/v1', capturedAt: new Date().toISOString(), node, totals, rows }
  const outPath = argValue('--out')
  if (outPath) {
    const abs = resolve(outPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, JSON.stringify(report, null, 2))
  }
  if (wantJson) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`remote-state-acceptance（node=${node}）`)
    for (const group of groups) {
      const mine = rows.filter(r => r.group === group.id)
      console.log(`\n[${group.id}]`)
      for (const r of mine) {
        const tag = r.verdict === 'pass' ? 'PASS   ' : r.verdict === 'fail' ? 'FAIL   ' : 'BLOCKED'
        console.log(`  ${tag} ${r.file.padEnd(64)} pass=${r.pass} fail=${r.fail}${r.detail ? `  （${r.detail.slice(0, 90)}）` : ''}`)
      }
    }
    console.log(`\n合计：pass=${totals.pass} fail=${totals.fail} blocked=${totals.blocked}（断言通过 ${totals.assertions}）`)
    if (totals.blocked > 0) console.log('blocked = 本环境无法跑（无 node_modules / vendor 未物化），**以 CI 为准**，不得当作通过。')
    if (totals.fail > 0) console.log('存在真失败：见上方 FAIL 行。')
  }
  process.exit(totals.fail > 0 ? 1 : 0)
}

if (process.argv.includes('--self-test')) selfTest(argValue('--node') ?? DEFAULT_NODE)
else main()
