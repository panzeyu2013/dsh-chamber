import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// W3 采集仪器（Leg A/B）的最小可 CI 验证：探针与 PNG 取样器都是仓库级脚本
// （scripts/perf/switch-frame-probe.mjs、scripts/lib/png-ink.mjs），无头环境跑不了 CDP，
// 但"解码器正确"与"注入表达式语法正确 + CLI 失败响亮"可以在 node 里证明。判据本体
// （switchFrameVerdict）在 switch-frame-verdict.test.ts。
//
// 为什么注册在 renderer 包：scripts/ 的测试清单（scripts/gates/run-script-tests.mjs）不在
// 本工作流的写权限内；renderer 是持有全部白帧判据的包，先在这里进 CI，后续可整体搬迁。

const PNG_INK = fileURLToPath(new URL('../../../../scripts/lib/png-ink.mjs', import.meta.url))
const PROBE = fileURLToPath(new URL('../../../../scripts/perf/switch-frame-probe.mjs', import.meta.url))
const PROBE_URL = new URL('../../../../scripts/perf/switch-frame-probe.mjs', import.meta.url).href

test('png-ink：合成 PNG 的解码/区域统计/平面判定往返自测', () => {
  const result = spawnSync(process.execPath, [PNG_INK, '--self-test'], { encoding: 'utf8' })
  assert.equal(result.status, 0, 'png-ink --self-test 失败：' + result.stdout + result.stderr)
  assert.match(result.stdout, /png-ink self-test: OK/)
})

test('switch-frame-probe：注入表达式可解析、探针模块可被测试 import（CLI 不执行）', () => {
  const script = 'import(' + JSON.stringify(PROBE_URL) + ').then(module => {'
    + ' const install = module.switchFrameProbeInstall("source-x", 1000);'
    + ' new Function("return " + install);'
    + ' new Function("return " + module.SWITCH_FRAME_PROBE_READ);'
    + ' console.log("probe-expressions-ok " + install.length + " " + module.SWITCH_FRAME_PROBE_READ.length)'
    + '})'
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, '探针表达式检查失败：' + result.stdout + result.stderr)
  assert.match(result.stdout, /probe-expressions-ok \d+ \d+/)
  assert.doesNotMatch(result.stdout, /用法：/, 'CLI 不得在 import 时执行（import guard 失效）')
})

test('switch-frame-probe：环境/参数失败必须响亮（--target 缺失 exit 2；--help exit 0）', () => {
  const missing = spawnSync(process.execPath, [PROBE], { encoding: 'utf8' })
  assert.equal(missing.status, 2, '缺 --target 必须以 exit 2 结束：' + missing.stdout + missing.stderr)
  assert.match(missing.stderr, /--target 必填/)
  const help = spawnSync(process.execPath, [PROBE, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, '--help 必须 exit 0')
  assert.match(help.stdout, /--require-switch/)
})
