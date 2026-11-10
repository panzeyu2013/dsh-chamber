#!/usr/bin/env node
/**
 * GUI acceptance entry point (docs/checklists/acceptance/gui-acceptance-checklist.md).
 *
 *   pnpm run acceptance:gui                     # --live: read-only probes against the RUNNING app
 *   pnpm run acceptance:gui -- --attach         # native default: probe a running native shell control plane
 *   pnpm run acceptance:gui -- --dev --flavor electron # ARCHIVED Electron dev walkthrough (revival only)
 *
 * Electron flavor is **frozen/archived** (2026-11, docs/progress/electron-frozen.md): --dev/--attach
 * default to the shipped native flavor; requesting Electron requires an explicit --flavor electron
 * and a revived Electron dev environment.
 *
 * Exit code: 0 when nothing FAILED (INFO entries never fail a run); 1 otherwise.
 * Artifacts (report.md + report.json + screenshots) land in --out (default
 * .tmp/gui-acceptance, gitignored) — attach them to the PR as evidence.
 */
import { parseArgs } from 'node:util'
import { runLiveAcceptance } from '../checks/probe.mjs'
import { runWalkthrough } from './walkthrough.mjs'
import { launchDevInstance } from './launch.mjs'
import { runNativeAcceptance } from './native.mjs'
import { startSshFixture } from '../fixtures/ssh-fixture.mjs'

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
    // native (default for --dev/--attach) probes the shipped macOS Swift sidecar/control
    // plane (G20); electron (ARCHIVED, explicit only) drives the Electron dev instance
    // over CDP. --live is HTTP-only and stays flavor-agnostic.
    flavor: { type: 'string' },
    'sidecar-dir': { type: 'string' },
    // N-6 input: without it the native leg can only judge the shell index when
    // the assembly itself carries dist/web, and under --require-assembly a
    // missing web dist is now a FAIL, so CI must hand over the renderer output.
    'web-dist': { type: 'string' },
    // G33: native machine gate — an absent assembly is a FAIL, not a SKIP, so a
    // CI step that lost its build prerequisite cannot exit 0 on a skip.
    'require-assembly': { type: 'boolean', default: false },
    out: { type: 'string', default: '.tmp/gui-acceptance' },
    plane: { type: 'string', default: 'http://127.0.0.1:17500' },
    instance: { type: 'string', default: 'http://127.0.0.1:17510' },
    sources: { type: 'string' },
    // MX sweep source: the desktop registry file. Defaults to the Electron
    // userData convention; point it at the probed instance's own file when
    // --plane is not that instance (dev/isolated/under-test payloads).
    registry: { type: 'string' },
    'cdp-port': { type: 'string', default: '9333' },
    'cp-port': { type: 'string', default: '17530' },
    'electron-arg': { type: 'string', multiple: true, default: [] },
    keep: { type: 'boolean', default: false },
    'require-hover': { type: 'boolean', default: false },
    // v2 embedded browser (design 28 §16.9): the embed legs' strictness flag
    // (INFO → FAIL, same shape as --require-hover) and the operator-supplied
    // remote loopback port W-14b needs on the real SSH source.
    'require-embed': { type: 'boolean', default: false },
    'embed-port': { type: 'string' },
    // W-14b local end-to-end fixture: throwaway sshd + remote dsh + loopback
    // HTTP page + app registry/known_hosts preseed (scripts/gui-acceptance/
    // ssh-fixture.mjs). --dev only; the fixture writes only its own <--out> tree.
    'ssh-fixture': { type: 'boolean', default: false },
    // Explicit, opt-in write permission for a THROWAWAY packaged/attach smoke:
    // the browser legs need a visible Session, and --attach otherwise refuses to
    // create one in someone's real app. Only valid together with --attach.
    'attach-create-session': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  console.log(`用法：
  --live                     只读探测运行中的应用（默认；安装态亦可用）
  --attach                   对已带 --remote-debugging-port 的 dev 实例做界面走查
  --dev                      自起一次性 dev 实例（隔离 user-data）→ 走查 → 关闭
  --flavor <electron|native> 目标 flavor（--dev/--attach 默认 native；--live 与 flavor 无关）。
                             native 走查原生壳 spawn 的 sidecar 装配（ready/B 桥/控制面 HTTP）；
                             注意 native 不可驱动 WKWebView UI（无 CDP），那仍属实机验收。
                             electron 已冻结归档，仅显式传 --flavor electron 时用于复活后的 CDP 走查
  --sidecar-dir <dir>        native 模式的 sidecar 装配目录（默认 packages/desktop/release/sidecar）
  --web-dist <dir>           native 模式的 web dist 目录（renderer 产物，N-6 判"壳 index +
                             声明资源可服务"；相对路径按当前目录解析）；未给时探测
                             sidecarDir/dist/web → sidecarDir/../dist/web；
                             --require-assembly 下探测不到即 N-6 FAIL
  --require-assembly         native 模式机器门：装配缺失记 FAIL（而非 SKIP）并退出 1，
                             供 CI 的 native 装配启动门使用（缺前置不得变绿）
  --out <dir>                产物目录（默认 .tmp/gui-acceptance）
  --plane <origin>           控制面 origin（默认 http://127.0.0.1:17500）
  --instance <origin>        本地 dsh 实例 origin（默认 http://127.0.0.1:17510，用于凭据围栏项）
  --sources a,b,c            显式来源 id（默认只读桌面注册表的 id/kind）
  --registry <path>          桌面连接注册表（默认 Electron userData 约定；--plane 指向隔离实例时
                             给出该实例自己的 ssh-instances.json）
  --cdp-port <port>          CDP 端口（默认 9333）
  --cp-port <port>           --dev 的控制面端口（默认 17530）
  --electron-arg <arg>       追加 Electron 开关（可重复；沙箱内需 --electron-arg=--no-sandbox）
  --keep                     --dev 结束后保留实例（默认关闭）
  --require-hover            走查的 hover 腿必须真实执行：未执行（INFO）计为 FAIL（默认关闭）
  --require-embed            内嵌腿（W-13/W-14a/W-14b/W-15/W-15b）必须真实执行：
                             未执行（INFO）计为 FAIL（默认关闭；--attach 无真实 SSH 源时尤其需要它）。SH-7 恒判定，不在本旗标范围
  --embed-port <port>        W-14b 的远端 loopback 端口：把窗口切到 dsh/gateway+ssh 来源并给出该主机
                             127.0.0.1 上真实可服务的端口，才跑真实 SSH → alias iframe 端到端腿
  --attach-create-session    显式允许 --attach 在浏览器腿前经既有 UI 建一次性工作区/会话
                              （仅用于打包/一次性实例的自起自关 smoke；默认禁止写真实实例状态）
  --ssh-fixture              W-14b 本机端到端夹具（仅 --dev）：一次性 sshd（独立端口/临时 host key）+
                             ssh-agent + 临时 remote dsh（vendor dsh CLI，temp DSH_HOME）+ 回环
                             cookie 注入代理 + fixture 页面；预置 dev userData 的 ssh-instances.json 与
                             app 自有 known_hosts，走真实 SSH 隧道验证 alias iframe/上游 sandbox/referrer/
                             postMessage/关 tab 释放`);
  process.exit(0)
}

const flavor = values.flavor ?? 'native' // concrete default; --live ignores flavor, --dev/--attach use native
if (flavor !== 'electron' && flavor !== 'native') {
  console.error('--flavor 只接受 electron|native，收到：' + String(values.flavor))
  process.exit(2)
}
if (values.dev && flavor !== 'electron') {
  console.error('--dev 依赖 Electron dev（已冻结归档，2026-11）。原生壳请用 --attach --flavor native；'
    + '确需复活 Electron dev 时按 docs/progress/electron-frozen.md §6 操作并显式传 --flavor electron。')
  process.exit(2)
}
if (values['ssh-fixture'] && (!values.dev || flavor !== 'electron')) {
  console.error('--ssh-fixture 只支持 --dev --flavor electron（夹具预置一次性 dev userData 的注册表/known_hosts，并在该实例里走真实 SSH 隧道；Electron dev 已冻结归档）')
  process.exit(2)
}
if (flavor === 'electron' && (values.dev || values.attach)) {
  console.warn('ARCHIVED: Electron flavor 已冻结归档（2026-11，docs/progress/electron-frozen.md）；'
    + '本模式需要复活后的 Electron dev/CDP 环境。')
}
if (values['require-hover'] && (!(values.dev || values.attach) || flavor !== 'electron')) {
  console.error('--require-hover 只属于归档的 Electron CDP 走查：需 --attach/--dev --flavor electron（docs/progress/electron-frozen.md）')
  process.exit(2)
}
if (values['require-embed'] && flavor !== 'electron' && (values.dev || values.attach)) {
  console.error('--require-embed 在 native 走查没有可执行的界面腿：请改用 --live（HTTP 探针）或 --flavor electron（归档 CDP）')
  process.exit(2)
}
if (values['embed-port'] && (!(values.dev || values.attach) || flavor !== 'electron')) {
  console.error('--embed-port 只属于归档的 Electron CDP 走查（--attach/--dev --flavor electron）')
  process.exit(2)
}
if (values['attach-create-session'] && flavor !== 'electron') {
  console.error('--attach-create-session 只属于归档的 Electron CDP 走查：需 --flavor electron')
  process.exit(2)
}
if ((values.dev || values.attach) && flavor === 'native'
  && (values['cdp-port'] !== '9333' || (values['electron-arg'] ?? []).length > 0)) {
  console.error('--cdp-port/--electron-arg 只属于归档的 Electron dev 走查：native 无 CDP；需 --flavor electron')
  process.exit(2)
}
if (flavor === 'electron' && (values['web-dist'] || values['require-assembly'])) {
  console.error('--web-dist/--require-assembly 只属于 native 装配走查：请用 --flavor native')
  process.exit(2)
}

// Native assembly intent: an explicit `--flavor native` or any native-only flag
// runs the sidecar spawn walkthrough. Without such intent the historical default
// stays `--live` (read-only probes against a RUNNING app), so `pnpm run acceptance:gui`
// keeps its documented meaning.
const nativeRequest = (values.flavor !== undefined && flavor === 'native')
  || values['require-assembly'] === true
  || values['sidecar-dir'] !== undefined
  || values['web-dist'] !== undefined
const mode = values.dev ? 'dev' : values.attach ? 'attach' : (values.live || !nativeRequest) ? 'live' : 'native'
if (values['attach-create-session'] && mode !== 'attach') {
  console.error('--attach-create-session 只支持 --attach（仅用于显式的打包/一次性实例 smoke）')
  process.exit(2)
}
const outDir = values.out
const cdpPort = Number(values['cdp-port'])
const cpPort = Number(values['cp-port'])
const sourceIds = values.sources === undefined ? undefined : values.sources.split(',').map(id => id.trim()).filter(Boolean)
const embedPort = values['embed-port'] === undefined ? null : Number(values['embed-port'])
if (embedPort !== null && (!Number.isInteger(embedPort) || embedPort < 1 || embedPort > 65535)) {
  console.error(`--embed-port 只接受 1–65535 的整数端口，收到：${values['embed-port']}`)
  process.exit(2)
}

let failed = 0
let info = 0
let launched = null
let sshFixture = null
try {
  if (mode === 'live') {
    // --live is HTTP-only and works against either flavor (native shell or a revived
    // Electron instance); it never needs CDP or the Electron dev flow.
    const live = await runLiveAcceptance({
      planeOrigin: values.plane,
      instanceOrigin: values.instance,
      sourceIds,
      registryFile: values.registry,
      outDir,
      requireEmbed: values['require-embed'],
    })
    failed += live.failed
  } else if (flavor === 'native') {
    // Native flavor: probe the sidecar the packaged Swift shell spawns (or, in
    // --attach mode, the control plane of an already-running native shell). The
    // WKWebView UI itself has no CDP endpoint and cannot be driven here — the
    // report says so instead of claiming coverage.
    const native = await runNativeAcceptance({
      sidecarDir: values['sidecar-dir'],
      outDir,
      attachPlaneOrigin: values.attach ? values.plane : null,
      requireAssembly: values['require-assembly'],
      webDistDir: values['web-dist'] ?? null,
    })
    if (native.skipped) {
      console.error('SKIP: ' + native.reason)
    }
    failed += native.failed
    info += native.info
  } else {
    // --dev: the throwaway instance must exist before anything probes it.
    if (mode === 'dev') {
      // --ssh-fixture seeds the registry + app-owned known_hosts BEFORE boot, and
      // exports the fixture agent so the app's ssh children authenticate with the
      // temp key (no user ~/.ssh writes).
      if (values['ssh-fixture']) {
        sshFixture = await startSshFixture({ outDir })
        Object.assign(process.env, sshFixture.env)
        console.log('ssh fixture 就绪：sshd :' + String(sshFixture.sshPort)
          + '、remote dsh :' + String(sshFixture.dshPort)
          + '、cookie 代理 :' + String(sshFixture.remotePort)
          + '、fixture 页 :' + String(sshFixture.fixturePort)
          + '（来源 ' + sshFixture.sourceViewId + '）')
      }
      launched = await launchDevInstance({ outDir, cpPort, cdpPort, electronArgs: values['electron-arg'] })
    }
    if (mode === 'dev') {
      // Same read-only probe set, aimed at the throwaway instance (its dsh port is
      // dynamic, and a fresh state dir has no remote sources to sweep).
      const live = await runLiveAcceptance({
        planeOrigin: `http://127.0.0.1:${cpPort}`,
        instanceOrigin: '',
        sourceIds: [],
        outDir: `${outDir}/dev`,
        requireEmbed: values['require-embed'],
      })
      failed += live.failed
    }
    if (mode === 'attach' || mode === 'dev') {
      // --dev runs on a throwaway instance: advancing the first-run wizard writes
      // only to that instance's own state. --attach never does (someone's real app).
      const walked = await runWalkthrough({
        cdpPort, outDir, advanceOnboarding: mode === 'dev', requireHover: values['require-hover'],
        // State-writing legs (W-4a source fold) run only on the throwaway instance;
        // --attach-create-session is the explicit packaged-smoke opt-in.
        allowPersistentWrites: mode === 'dev' || (mode === 'attach' && values['attach-create-session'] === true),
        requireEmbed: values['require-embed'],
        embedPort,
        sshFixture,
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
  // The app must be down before the fixture stops: its ssh children/tunnels use
  // the fixture agent/sshd, and fixture process death should be the last edge.
  if (sshFixture !== null) {
    await sshFixture.stop()
    console.log('ssh fixture 已关闭（sshd/remote dsh/代理/agent 已回收）')
  }
}

// INFO means "not exercised": a green run must never read as full coverage, so
// the count rides the summary. Exit-code semantics are unchanged (INFO ≠ FAIL).
const infoNote = info === 0 ? '' : failed === 0 ? `（${info} 项 INFO 未执行）` : `（另有 ${info} 项 INFO 未执行）`
console.log(failed === 0 ? `\nGUI 验收：无 FAIL${infoNote}` : `\nGUI 验收：${failed} 项 FAIL${infoNote}`)
process.exit(failed === 0 ? 0 : 1)
