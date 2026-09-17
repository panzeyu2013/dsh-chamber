#!/usr/bin/env node
/**
 * GUI acceptance entry point (docs/checklists/gui-acceptance-checklist.md).
 *
 *   pnpm run acceptance:gui                     # --live: read-only probes against the RUNNING app
 *   pnpm run acceptance:gui -- --attach         # walk through an already-running dev instance (CDP 9333)
 *   pnpm run acceptance:gui -- --dev            # launch a throwaway dev instance, walk it, shut it down
 *
 * Exit code: 0 when nothing FAILED (INFO entries never fail a run); 1 otherwise.
 * Artifacts (report.md + report.json + screenshots) land in --out (default
 * .tmp/gui-acceptance, gitignored) — attach them to the PR as evidence.
 */
import { parseArgs } from 'node:util'
import { runLiveAcceptance } from './probe.mjs'
import { runWalkthrough } from './walkthrough.mjs'
import { launchDevInstance } from './launch.mjs'
import { runNativeAcceptance } from './native.mjs'

// `pnpm run acceptance:gui -- --dev` forwards the separator literally, while
// `pnpm run acceptance:gui --dev` does not. Accept both: strip one leading `--`.
const argv = process.argv.slice(2)
if (argv[0] === '--') argv.shift()

const { values } = parseArgs({
  args: argv,
  options: {
    live: { type: 'boolean', default: false },
    dev: { type: 'boolean', default: false },
    attach: { type: 'boolean', default: false },
    // electron (default) drives the Electron dev instance over CDP; native runs
    // the minimal sidecar walkthrough of the macOS Swift payload (G20).
    flavor: { type: 'string', default: 'electron' },
    'sidecar-dir': { type: 'string' },
    // G33: native machine gate — an absent assembly is a FAIL, not a SKIP, so a
    // CI step that lost its build prerequisite cannot exit 0 on a skip.
    'require-assembly': { type: 'boolean', default: false },
    out: { type: 'string', default: '.tmp/gui-acceptance' },
    plane: { type: 'string', default: 'http://127.0.0.1:17500' },
    instance: { type: 'string', default: 'http://127.0.0.1:17510' },
    sources: { type: 'string' },
    'cdp-port': { type: 'string', default: '9333' },
    'cp-port': { type: 'string', default: '17530' },
    'electron-arg': { type: 'string', multiple: true, default: [] },
    keep: { type: 'boolean', default: false },
    'require-hover': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  console.log(`用法：
  --live                     只读探测运行中的应用（默认；安装态亦可用）
  --attach                   对已带 --remote-debugging-port 的 dev 实例做界面走查
  --dev                      自起一次性 dev 实例（隔离 user-data）→ 走查 → 关闭
  --flavor <electron|native> 目标 flavor（默认 electron）。native 走查原生壳 spawn 的
                             sidecar 装配（ready/B 桥/控制面 HTTP）；—— 注意 native 不可
                             驱动 WKWebView UI（无 CDP），那仍属实机验收
  --sidecar-dir <dir>        native 模式的 sidecar 装配目录（默认 packages/desktop/release/sidecar）
  --require-assembly         native 模式机器门：装配缺失记 FAIL（而非 SKIP）并退出 1，
                             供 CI 的 native 装配启动门使用（缺前置不得变绿）
  --out <dir>                产物目录（默认 .tmp/gui-acceptance）
  --plane <origin>           控制面 origin（默认 http://127.0.0.1:17500）
  --instance <origin>        本地 dsh 实例 origin（默认 http://127.0.0.1:17510，用于凭据围栏项）
  --sources a,b,c            显式来源 id（默认只读桌面注册表的 id/kind）
  --cdp-port <port>          CDP 端口（默认 9333）
  --cp-port <port>           --dev 的控制面端口（默认 17530）
  --electron-arg <arg>       追加 Electron 开关（可重复；沙箱内需 --electron-arg=--no-sandbox）
  --keep                     --dev 结束后保留实例（默认关闭）
  --require-hover            走查的 hover 腿必须真实执行：未执行（INFO）计为 FAIL（默认关闭）`)
  process.exit(0)
}

const flavor = values.flavor
if (flavor !== 'electron' && flavor !== 'native') {
  console.error(`--flavor 只接受 electron|native，收到：${flavor}`)
  process.exit(2)
}
if (flavor === 'native' && values.dev) {
  console.error('--flavor native 不支持 --dev（原生壳没有 CDP dev 实例）：请用 --attach 指向运行中的原生壳控制面，或直接运行 native 走查（会自起 sidecar 装配）')
  process.exit(2)
}

const mode = values.dev ? 'dev' : values.attach ? 'attach' : 'live'
const outDir = values.out
const cdpPort = Number(values['cdp-port'])
const cpPort = Number(values['cp-port'])
const sourceIds = values.sources === undefined ? undefined : values.sources.split(',').map(id => id.trim()).filter(Boolean)

let failed = 0
let info = 0
let launched = null
try {
  if (flavor === 'native') {
    // Native flavor: probe the sidecar the packaged Swift shell spawns (or, in
    // --attach mode, the control plane of an already-running native shell). The
    // WKWebView UI itself has no CDP endpoint and cannot be driven here — the
    // report says so instead of claiming coverage.
    const native = await runNativeAcceptance({
      sidecarDir: values['sidecar-dir'],
      outDir,
      attachPlaneOrigin: values.attach ? values.plane : null,
      requireAssembly: values['require-assembly'],
    })
    if (native.skipped) {
      console.error('SKIP: ' + native.reason)
    }
    failed += native.failed
    info += native.info
  } else {
    // --dev: the throwaway instance must exist before anything probes it.
    if (mode === 'dev') {
      launched = await launchDevInstance({ outDir, cpPort, cdpPort, electronArgs: values['electron-arg'] })
    }
    if (mode === 'live') {
      const live = await runLiveAcceptance({
        planeOrigin: values.plane,
        instanceOrigin: values.instance,
        sourceIds,
        outDir,
      })
      failed += live.failed
    }
    if (mode === 'dev') {
      // Same read-only probe set, aimed at the throwaway instance (its dsh port is
      // dynamic, and a fresh state dir has no remote sources to sweep).
      const live = await runLiveAcceptance({
        planeOrigin: `http://127.0.0.1:${cpPort}`,
        instanceOrigin: '',
        sourceIds: [],
        outDir: `${outDir}/dev`,
      })
      failed += live.failed
    }
    if (mode === 'attach' || mode === 'dev') {
      // --dev runs on a throwaway instance: advancing the first-run wizard writes
      // only to that instance's own state. --attach never does (someone's real app).
      const walked = await runWalkthrough({
        cdpPort, outDir, advanceOnboarding: mode === 'dev', requireHover: values['require-hover'],
        // State-writing legs (W-4a source fold) run only on the throwaway instance.
        allowPersistentWrites: mode === 'dev',
      })
      failed += walked.failed
      info += walked.info
    }
  }
} finally {
  if (launched !== null && !values.keep) {
    await launched.stop()
    console.log('dev 实例已关闭（--keep 可保留）')
  } else if (launched !== null) {
    console.log(`dev 实例保留运行：control-plane :${launched.cpPort}、CDP :${launched.cdpPort}（pid ${launched.pid}）`)
  }
}

// INFO means "not exercised": a green run must never read as full coverage, so
// the count rides the summary. Exit-code semantics are unchanged (INFO ≠ FAIL).
const infoNote = info === 0 ? '' : failed === 0 ? `（${info} 项 INFO 未执行）` : `（另有 ${info} 项 INFO 未执行）`
console.log(failed === 0 ? `\nGUI 验收：无 FAIL${infoNote}` : `\nGUI 验收：${failed} 项 FAIL${infoNote}`)
process.exit(failed === 0 ? 0 : 1)
