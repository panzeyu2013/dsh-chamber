#!/usr/bin/env node
/**
 * verify-upstream-touchpoints.mjs — 上游触点保鲜门（T4，docs/checklists/
 * upstream-touchpoints.md 的机器侧）。
 *
 * 只读、仅内置模块、exit-code 语义：
 *   C1  纯文件字节恒等（fork 副本中未登记补丁的文件必须与上游锚逐字节一致）
 *   C2  --tags <old> <new>：上游两 tag 间三 fork 面的重放差异报告（advisory）
 *   C3  完整性：fork 每文件有分类（pure/patched/own），上游每文件有裁决
 *       （mirrored/dropped）；漏分类/新文件漏裁决 = 硬失败
 *   C4  roster：typert remote 装配契约 == 15（集合与顺序）、covered/factory 存在性、
 *       删包 fail-loud（存在性哨兵列表）
 *   C5  过期锚扫描：三 fork package.json 版本 == 上游同文件版本；
 *       submodule HEAD == harness.commit
 *   C6  EXCLUDED 上游存在性（ensure-harness-vendor 排除的三个 fork 源目录）
 *   C7  种子域锁步：gateway HOST_PACKAGE_PROBE_DOMAINS 值集 ==
 *       dsh-runtime HOST_DOMAIN_PROBE_NAMES 列表（文本双门；运行时已有 fail-loud）
 *   C8  提交态生成物 == src（确定性重建-比对，硬失败）：host dist ×3 +
 *       mobile dist/lib 四件；重建后字节不同 = 产物陈旧。写后原样还原，
 *       `--no-artifact-rebuild` 退回 mtime advisory（fresh checkout 会误报）
 *   C9  vendor 源码补丁锚（硬失败）：`packages/renderer/scripts/vendor-patches.mjs`
 *       注册的每处 expect 必须在 pin 住的上游文件里恰好命中一次——重锚后
 *       上游文本一漂移即红，避免「补丁静默失效」
 *   C10 版本锚一致性 + 活版本字面量白名单（硬失败）：运行时版本从
 *       `packages/desktop/vendor/dsh/package.json` 单一来源读出，六锚 / 三 fork
 *       副本必须等于它；生产源码（非注释、非测试、非产物）里出现任何其他
 *       dsh 版本字面量即红——历史叙述只能留在注释里
 *
 * 登记纪律：给某个文件打 chamber 补丁 = 在 FORKS.patched 里登记（含原因）；
 * 新增 chamber 自有文件 = own；上游文件有意不镜像 = dropped。任何对 pure
 * 文件的修改都会在此硬失败——升级/重锚后同步登记表（每 tag 维护循环见文档 §7）。
 *
 * 用法：
 *   node scripts/dev/verify-upstream-touchpoints.mjs            # C1/C3–C10
 *   node scripts/dev/verify-upstream-touchpoints.mjs --tags <old> <new>  # +C2
 */

import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { artifactGateVerdict, compareOutputs, restoreDir, snapshotDir } from './artifact-gate.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SUBMODULE = join(ROOT, 'vendor', 'harness-checkout')
const PIN_FILE = join(ROOT, 'harness.commit')

// ---------------------------------------------------------------------------
// 触点登记（与 docs/checklists/upstream-touchpoints.md 的表同源；维护时两侧同步）
// ---------------------------------------------------------------------------

/**
 * forks[].rel 相对仓库根；upstream 相对 submodule 根。
 * - patched: { <相对 fork 文件>: 原因 } —— 允许与上游不一致的 chamber 补丁面
 * - own:     fork 自有文件（上游无对应物），ownPrefix 覆盖整目录（如 test/）
 * - dropped: 上游文件有意不镜像（exact 或 prefix），如 tsdown.config.ts、tests/
 * - upstreamExtraExclude / forkExtraExclude: 两侧各自的排除目录（node_modules/
 *   lib/产物），不入登记表。
 */
const FORKS = [
  {
    name: 'connection',
    rel: 'packages/dsh-client-connection',
    upstream: 'packages/client/connection',
    patched: {
      'package.json': '[patch-add] 仅追加 chamber test 脚本（其余与上游一致；版本行随上游推进）',
      'src/api-path.ts': '[patch-mod] 追加 resolveInstanceBasePath + 头部 chamber 说明（basePath 语义，design 05 §3.6）',
      'src/client/connection.ts': '[patch-mod] 仅 erasableSyntaxOnly 显式字段改写（两个构造参数属性）+ 顶部 chamber 说明；其余逐字节上游（Batch 2 重锚：loopEpoch 守卫与 CONNECTION_BACKOFF_MAX_MS 导出退役，改由原生 reconnect/setNetworkAvailable）',
      'src/client/index.ts': '[patch-mod] apply(ctx) 读 ctx.chamberBasePath → 载波装配（design 05 §3.6）+ SYSTEM_RESUME_EVENT/liveness 触发（design 14 D4）+ recovery-policy 转出（/client barrel）+ 头部 chamber 说明',
      'src/client/rpc.ts': '[patch-mod] basePath 前缀拼装 + WebConnectionRpcOptions（chamber 选项对象）+ 头部 chamber 说明',
      'tsconfig.client.json': '[patch-mod] chamber 构面：extends ../../tsconfig.json + vendor paths + files 列表（与上游 files 增量同步维护）',
      'tsconfig.host.json': '[patch-mod] 同上（host 构面）',
    },
    own: {
      'tsconfig.check-base.json': 'chamber erasable-only 校验构面',
      'tsconfig.check-client.json': 'chamber erasable-only 校验构面（files 与 client 同步）',
      'tsconfig.check-host.json': 'chamber erasable-only 校验构面（files 与 host 同步）',
    },
    ownPrefix: ['test/', 'src/client/carrier-assembly.ts', 'src/client/liveness-triggers.ts', 'src/client/recovery-policy.ts'],
    ownNotes: {
      'src/client/carrier-assembly.ts': 'chamber 载波装配纯策略（basePath 扇出）',
      'src/client/liveness-triggers.ts': 'chamber sleep/wake 活性触发（design 14；原生 reconnect + 离线门 + 唤醒事件旁路）',
      'src/client/recovery-policy.ts': 'chamber 每来源恢复时序策略（远端 45s/5s，本地保持上游默认）',
      'test/': 'chamber 自有测试（api-path/carrier-assembly/liveness-triggers/client-apply + fixtures/桩 loader）',
    },
    dropped: ['tsdown.config.ts', 'tests/'],
  },
  {
    name: 'client-web',
    rel: 'packages/dsh-client-web',
    upstream: 'packages/client/web',
    patched: {
      'package.json': '[patch-mod] 描述/测试脚本/deps·peerDeps·files 面差异（版本行随上游推进）',
      'README.md': '[own-divergent] chamber 说明（boot kernel 差异/维护约定），非上游镜像',
      'README.zh.md': '[own-divergent] 同 README.md（中文镜像）',
      'README.i18n.yaml': '[own-divergent] chamber README 对的哈希记录',
      'src/boot.ts': '[patch-mod] rc.8 N-ctx boot kernel（extraRows/configureContext/异步 dispose）',
      'src/index.ts': '[patch-mod] 入口差异（module-system 宿主接线）',
      'src/platform.ts': '[patch-mod] PLATFORM_MODULES/静态表 chamber 接线（C3 偏差：ui-primitives 不 seed）',
      'src/seed.ts': '[patch-mod] seed 行 chamber 接线（extraRows/__ModuleLoader__；C3 偏差同步）',
      'tsconfig.json': '[patch-mod] chamber 构面（vendor paths/检查面）',
    },
    own: {
      'src/boot-rows.ts': 'chamber 每实例 boot-rows（design 09 module D）',
      'src/boot-tolerance.ts': 'chamber boot 容忍/恢复（design 09）',
    },
    ownPrefix: ['test/'],
    ownNotes: {
      'test/': 'chamber 自有测试（boot-tolerance/boot-rows/configure-context + fixtures）',
    },
    dropped: ['tsdown.config.ts', 'tests/'],
  },
  {
    name: 'api-gateway',
    rel: 'packages/dsh-api-gateway',
    upstream: 'packages/api/gateway',
    patched: {
      'package.json': '[patch-mod] description/peer 集裁剪（host 依赖 dropped）+ 版本行随上游推进',
      'src/client/index.ts': '[patch-mod] apply(ctx) 读 ctx.chamberBasePath → /api/remote.mux 落到实例前缀 + start(sinks, recoveryOverridesForTransport(transport))（design 05 §3.6）',
      'src/client/stream-client.ts': '[patch-mod] per-entry basePath（流载波 URL 拼装）',
      'tsconfig.json': '[patch-mod] chamber 构面',
      'tsconfig.client.json': '[patch-mod] chamber client 构面',
    },
    own: {
      'tsconfig.check-base.json': 'chamber erasable-only 校验构面',
      'tsconfig.check-client.json': 'chamber erasable-only 校验构面',
    },
    ownPrefix: ['test/'],
    ownNotes: {
      'test/': 'chamber 自有测试（若有）',
    },
    dropped: [
      'README.md', 'README.zh.md', 'README.i18n.yaml',
      'src/index.ts', 'src/stream-server.ts', 'src/types.ts',
      'tsconfig.host.json', 'tsdown.config.ts', 'tests/',
    ],
    droppedNotes: {
      'src/index.ts': '上游 host 插件入口（chamber 不镜像 host 半）',
      'src/stream-server.ts': '上游 host 半流服务器（dropped）',
      'src/types.ts': '上游 host/aux 类型文件（exports 保留 inert ./types 子路径）',
      'README*': '上游 README 不携带（fork 描述在 package.json）',
      'tsconfig.host.json': 'host 构面不镜像',
    },
  },
]

/** ensure-harness-vendor EXCLUDED（fork 影子覆盖的上游包）——C6 存在性哨兵。 */
const EXCLUDED_UPSTREAM_DIRS = [
  'packages/client/connection',
  'packages/client/web',
  'packages/api/gateway',
]

/** C4 roster 存在性哨兵：covered 关键 id 删除即硬失败（删包保护）。 */
const COVERED_SENTINELS = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-hmr',
  '@deepseek-ai/dsh-client-ui-open-in-app',
  '@dsh-chamber/dsh-chamber-client-ui-open-in',
]

// ---------------------------------------------------------------------------

/** Hard-failure counter; `fail()` owns it so no violation can be logged without failing the run. */
let hardFails = 0

function fail(message) {
  console.error(`✗ ${message}`)
  hardFails += 1
  process.exitCode = 1
}

function warn(message) {
  console.warn(`⚠ ${message}`)
}

function readPin() {
  const line = readFileSync(PIN_FILE, 'utf8').split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'))
  if (line === undefined) throw new Error(`缺少固定提交文件 ${PIN_FILE}`)
  return line
}

/** 收集目录下文件（排除 node_modules/lib 与给定排除前缀）。 */
function collectFiles(root, excludePrefixes = []) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = relative(root, full)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === '.git'
          || excludePrefixes.some((p) => rel === p || rel.startsWith(`${p}/`))) continue
        walk(full)
      } else if (!rel.endsWith('.tsbuildinfo')) {
        out.push(rel)
      }
    }
  }
  walk(root)
  return out.sort()
}

function within(rel, prefixes) {
  return prefixes.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p))
}

const pin = readPin()

// C1/C3 —— 逐 fork 分类校验
for (const fork of FORKS) {
  const forkRoot = join(ROOT, fork.rel)
  const upRoot = join(SUBMODULE, fork.upstream)
  const droppedExact = fork.dropped.filter((p) => !p.endsWith('/'))
  const droppedPrefix = fork.dropped.filter((p) => p.endsWith('/'))
  const upstreamFiles = existsSync(upRoot)
    ? collectFiles(upRoot)
    : []
  const forkFiles = existsSync(forkRoot)
    ? collectFiles(forkRoot)
    : []
  const ownKeys = new Set(Object.keys(fork.own))
  const patchedKeys = new Set(Object.keys(fork.patched))
  let pure = 0
  let violations = []
  for (const f of upstreamFiles) {
    if (droppedExact.includes(f) || within(f, droppedPrefix)) continue
    if (!forkFiles.includes(f)) {
      violations.push(`上游文件未镜像且未登记 dropped: ${f}`)
      continue
    }
    const forkFile = join(forkRoot, f)
    const upFile = join(upRoot, f)
    if (readFileSync(forkFile).equals(readFileSync(upFile))) {
      pure += 1
    } else if (!patchedKeys.has(f)) {
      violations.push(`与上游不一致且未登记补丁（pure 面被改）: ${f}`)
    }
  }
  for (const f of forkFiles) {
    if (!upstreamFiles.includes(f)) {
      const isOwnFile = ownKeys.has(f) || within(f, [...(fork.ownPrefix ?? [])])
      if (!isOwnFile) {
        violations.push(`fork 自有文件未登记 own: ${f}`)
      }
    }
  }
  for (const f of patchedKeys) {
    if (!forkFiles.includes(f)) violations.push(`patched 登记文件不存在: ${f}`)
  }
  const upPkg = JSON.parse(readFileSync(join(upRoot, 'package.json'), 'utf8'))
  const forkPkg = JSON.parse(readFileSync(join(forkRoot, 'package.json'), 'utf8'))
  if (violations.length > 0) {
    fail(`[${fork.name}] C1/C3 违规 ${violations.length} 项（pure 面被改 / 未登记补丁 / 上游文件漏裁决）:`)
    for (const v of violations) console.error(`    - ${v}`)
  } else {
    console.log(`✓ [${fork.name}] C1/C3: pure=${pure} patched=${patchedKeys.size} own=${forkFiles.length - pure - patchedKeys.size} dropped=${fork.dropped.length}`)
  }
  if (upPkg.version !== forkPkg.version) {
    fail(`C5 [${fork.name}] fork 版本 ${forkPkg.version} != 上游 ${upPkg.version}（过期锚——升级/重锚后应同步）`)
  }
}

// C5 —— submodule HEAD == 声明 pin
{
  const head = spawnSync('git', ['-C', SUBMODULE, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (head.status !== 0 || head.stdout.trim() !== pin) {
    fail(`C5 submodule HEAD != harness.commit（${pin.slice(0, 12)}）——请走 update-vendor.mjs`)
  } else {
    console.log(`✓ C5 锚: harness.commit = ${pin.slice(0, 12)}，三 fork 版本与上游一致`)
  }
}

// C6 —— EXCLUDED 上游目录存在性
{
  let missing = 0
  for (const dir of EXCLUDED_UPSTREAM_DIRS) {
    if (!existsSync(join(SUBMODULE, dir))) {
      missing += 1
      fail(`C6 EXCLUDED 上游目录缺失: ${dir}`)
    }
  }
  if (missing === 0) console.log(`✓ C6 EXCLUDED 上游目录 ×${EXCLUDED_UPSTREAM_DIRS.length} 存在`)
}

// C4 —— roster
{
  const coveredSrc = readFileSync(join(ROOT, 'packages/renderer/src/chamber-covered.ts'), 'utf8')
  const readList = (marker) => {
    const seg = coveredSrc.split(marker)[1]
    const m = seg.match(/=\s*\[([\s\S]*?)\n\]/)
    return m[1].split('\n').filter((l) => /^\s+'@/.test(l)).map((l) => l.trim().match(/'([^']+)'/)[1])
  }
  const covered = readList('export const CHAMBER_COVERED_IDS')
  const factory = readList('export const CHAMBER_COVERED_FACTORY_IDS')
  const factorySet = new Set(factory)
  const factoryOutside = factory.filter((id) => !covered.includes(id))
  const dupCovered = covered.filter((id, i) => covered.indexOf(id) !== i)
  let rosterFails = 0
  for (const sentinel of COVERED_SENTINELS) {
    if (!covered.includes(sentinel)) {
      rosterFails += 1
      fail(`C4 covered 哨兵缺失（删包?）: ${sentinel}`)
    }
  }
  if (factoryOutside.length > 0) {
    rosterFails += 1
    fail(`C4 factory id 不在 covered 内: ${factoryOutside.join(', ')}`)
  }
  if (dupCovered.length > 0) {
    rosterFails += 1
    fail(`C4 covered 重复 id: ${dupCovered.join(', ')}`)
  }
  if (rosterFails === 0) {
    console.log(`✓ C4 covered=${covered.length} factory=${factory.length}（factory ⊆ covered，哨兵齐）`)
  } else {
    fail(`C4 roster 校验 ${rosterFails} 项失败（covered/factory 存在性、哨兵或锁步断言）`)
  }

  const assemblyEntry = join(ROOT, 'vendor/harness-packages/@deepseek-ai/dsh-api-remotes/src/client/index.ts')
  if (!existsSync(assemblyEntry)) {
    fail(`C4 找不到上游装配面 ${relative(ROOT, assemblyEntry)} — 该面被删除/改名时必须重审 typert 契约（不能静默跳过）`)
  } else {
    const { remotePackagesFromAssembly, remoteMountPackages, EXPECTED_REMOTE_PACKAGES } = await import(
      join(ROOT, 'packages/renderer/scripts/typert-remote-contract.mjs')
    )
    let remotes
    let mounted
    try {
      remotes = remotePackagesFromAssembly(readFileSync(assemblyEntry, 'utf8'))
      mounted = remoteMountPackages(readFileSync(assemblyEntry, 'utf8'))
    } catch (error) {
      fail(`C4 装配面解析失败（上游结构漂移）: ${error.message}`)
      remotes = undefined
    }
    if (remotes !== undefined) {
    // Exact set AND order: a same-length swap (a package added while another
    // is removed, or a reordered assembly) must not pass silently. The
    // expected list is single-sourced in typert-remote-contract.mjs (shared
    // with the lockstep test) so an upstream change is one edit.
    const expected = [...EXPECTED_REMOTE_PACKAGES]
    if (remotes.length !== expected.length || remotes.some((name, index) => name !== expected[index])) {
      fail(`C4 remotePackagesFromAssembly = ${JSON.stringify(remotes)}（期望 ${JSON.stringify(expected)}）——上游装配面变更需重审 typert 契约`)
    } else if (mounted.length !== expected.length || mounted.some((name, index) => name !== expected[index])) {
      fail(`C4 apply() 挂载数组 = ${JSON.stringify(mounted)} != import 选择 ${JSON.stringify(remotes)}——挂载面与选择面必须 1:1 同序`)
    } else {
      console.log(`✓ C4 remote assembly 契约 = ${remotes.length}（import 选择 == apply 挂载，集合与顺序）`)
    }
    }
  }
}

// C7 —— 种子域锁步（文本双门）
{
  const gatewaySrc = readFileSync(join(ROOT, 'packages/gateway/src/plugins.ts'), 'utf8')
  const runtimeSrc = readFileSync(join(ROOT, 'packages/dsh-runtime/src/activation-gate.ts'), 'utf8')
  // 限定到各自声明块内提取，避免同文件其他字符串常量干扰。
  const blockOf = (src, startMarker, endMarker) => {
    const start = src.indexOf(startMarker)
    if (start === -1) return ''
    const rest = src.slice(start)
    const end = rest.indexOf(endMarker)
    return end === -1 ? rest : rest.slice(0, end)
  }
  const mapBlock = blockOf(gatewaySrc, 'HOST_PACKAGE_PROBE_DOMAINS:', '}')
  // 两种形态同门：① 字面表（逐行 `'<name>': '<domain>'`）；② 2026-09 起的
  // 注册表派生表（`Object.fromEntries(CHAMBER_HOST_PACKAGES.map(...))`）——
  // 派生形态的值唯一来源是控制面注册表，故改读 host-graph-seed.ts 的
  // `{ insert: …, probe: { method: '<domain>' } }` 行（与 chamber-seed-drift
  // 客户端镜像测试同一提取口径）。派生表在 gateway 模块加载时另有 fail-loud
  // 运行时门（mappedProbeDomains vs HOST_DOMAIN_PROBE_NAMES），本门是文本哨兵。
  const mapValues = mapBlock.includes('CHAMBER_HOST_PACKAGES')
    ? [...readFileSync(join(ROOT, 'packages/control-plane/src/host-graph-seed.ts'), 'utf8')
        .matchAll(/\{ insert: HOST_[A-Z_]+_INSERT, probe: \{ method: '([^']+)'/g)].map((m) => m[1])
    : [...mapBlock.matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => m[2])
  const listBlock = blockOf(runtimeSrc, 'HOST_DOMAIN_PROBE_NAMES = [', '] as const')
  const listEntries = [...listBlock.matchAll(/'([^']+)'/g)].map((m) => m[1])
  const gatewaySet = new Set(mapValues)
  const runtimeSet = new Set(listEntries)
  if (mapValues.length !== gatewaySet.size || listEntries.length !== runtimeSet.size
    || gatewaySet.size !== runtimeSet.size
    || [...gatewaySet].some((v) => !runtimeSet.has(v))) {
    fail('C7 种子域漂移：gateway HOST_PACKAGE_PROBE_DOMAINS 值集 != dsh-runtime HOST_DOMAIN_PROBE_NAMES（两侧同改）')
  } else {
    console.log(`✓ C7 种子域锁步: ${[...gatewaySet].join(', ')}`)
  }
}

// C8 —— 生成物陈旧（确定性重建-比对；2026-09 二轮改为内容门）
//
// The 2026-09 V1 review found the previous mtime comparison to be a paper
// gate: on a fresh checkout every file carries the checkout time, so a
// committed-but-stale bundle was never detected (exactly the BLOCKER shape:
// the alpha.2 slot rename lived in src while lib/client.js still walked the
// retired slots), while a freshly built tree could report a false positive
// when the artifact was written a millisecond before its own source. Both
// build scripts are deterministic (esbuild, fixed target/externals, LF-only
// committed artifacts per .gitattributes), so the gate rebuilds each artifact
// group in place and byte-compares against the bytes captured first, then
// restores them verbatim — the repo is left unchanged, and the only observable
// effect is the artifact mtime. A mismatch is a hard failure: the committed
// artifact no longer matches its source. `--no-artifact-rebuild` keeps the
// old advisory mtime behavior for environments without esbuild.
{
  const groups = [
    {
      script: 'packages/dsh-chamber-seed-client-graph/scripts/build.mjs',
      outputs: ['packages/dsh-chamber-seed-client-graph/dist/index.js'],
    },
    {
      script: 'packages/dsh-chamber-seed-git-worktree/scripts/build.mjs',
      outputs: ['packages/dsh-chamber-seed-git-worktree/dist/index.js'],
    },
    {
      script: 'packages/dsh-chamber-seed-archive-cleanup/scripts/build.mjs',
      outputs: ['packages/dsh-chamber-seed-archive-cleanup/dist/index.js'],
    },
    {
      // The shared runtime core's committed bundle (the desktop/gateway
      // installer ships it; a stale copy is as wrong as a stale seed bundle).
      script: 'packages/dsh-runtime/scripts/build.mjs',
      outputs: ['packages/dsh-runtime/dist/index.js'],
    },
    {
      // The mobile browser half is a committed artifact too (package.json
      // exports ./client -> lib/client.js) and the gateway seeds it byte for
      // byte; a stale bundle silently keeps retired DOM anchors (2026-09 V1
      // review BLOCKER). lib/index.js is the mirrored host half.
      script: 'packages/dsh-chamber-client-ui-mobile/scripts/build.mjs',
      outputs: [
        'packages/dsh-chamber-client-ui-mobile/dist/index.js',
        'packages/dsh-chamber-client-ui-mobile/lib/index.js',
        'packages/dsh-chamber-client-ui-mobile/lib/client.js',
        'packages/dsh-chamber-client-ui-mobile/lib/client.js.map',
      ],
    },
  ]
  if (process.argv.includes('--no-artifact-rebuild')) {
    // Advisory fallback: mtime is unreliable on fresh checkouts — say so.
    const stale = []
    for (const group of groups) {
      for (const artifact of group.outputs) {
        const artifactPath = join(ROOT, artifact)
        if (!existsSync(artifactPath)) continue
        const srcDir = join(ROOT, artifact.split('/dist/')[0].split('/lib/')[0], 'src')
        if (!existsSync(srcDir)) continue
        let newest = 0
        const walk = (d) => {
          for (const entry of readdirSync(d, { withFileTypes: true })) {
            const full = join(d, entry.name)
            if (entry.isDirectory()) {
              if (entry.name !== 'node_modules' && entry.name !== 'lib' && entry.name !== 'dist') walk(full)
            } else {
              newest = Math.max(newest, statSync(full).mtimeMs)
            }
          }
        }
        walk(srcDir)
        if (statSync(artifactPath).mtimeMs < newest) stale.push(artifact)
      }
    }
    if (stale.length > 0) warn(`C8 生成物 mtime 落后（advisory；fresh checkout 会误报，请用默认重建门）: ${stale.join(', ')}`)
    else console.log('✓ C8 生成物 mtime 新鲜（advisory 模式）')
  } else {
    // Serialize the in-place rebuild: two concurrent runs would interleave
    // write/restore and leave rebuilt (uncommitted) bytes behind. The lock is
    // an exclusive file in the OS temp dir, keyed by the repo path.
    const lockPath = join(
      tmpdir(),
      `dsh-chamber-c8-${createHash('sha256').update(ROOT).digest('hex').slice(0, 16)}.lock`,
    )
    let lockFd
    let lockTaken = false
    for (let attempt = 0; attempt < 2 && !lockTaken; attempt += 1) {
      try {
        lockFd = openSync(lockPath, 'wx')
        writeFileSync(lockFd, `${process.pid}\n`)
        lockTaken = true
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        // A killed gate cannot clean its own lock (process.exit bypasses
        // finally): take over when the recorded PID is gone.
        const recorded = Number.parseInt(`${readFileSync(lockPath, 'utf8')}`.trim(), 10)
        let alive = false
        if (Number.isInteger(recorded) && recorded > 0) {
          try { process.kill(recorded, 0); alive = true } catch { alive = false }
        }
        if (alive) {
          fail(`C8 无法重建：另一个 C8 重建正在运行（pid ${recorded}，${lockPath}）——不能证明产物新鲜度，稍后重跑`)
          break
        }
        rmSync(lockPath, { force: true })
      }
    }
    if (!lockTaken && lockFd === undefined && !process.exitCode) {
      // The lock loop broke on a live holder: `fail()` already reported it.
      lockFd = undefined
    }
    if (lockFd !== undefined) {
      // Snapshot/restore/compare live in scripts/dev/artifact-gate.mjs so the
      // decision logic is unit-tested (see artifact-gate.test.mjs).
      const artifactDirs = (group) => [...new Set(group.outputs.map(output => dirname(join(ROOT, output))))]
      let inFlight = undefined
      let child = undefined
      const onSignal = (signal) => {
        try { child?.kill('SIGTERM') } catch { /* already gone */ }
        if (inFlight !== undefined) {
          try { inFlight() } catch (error) { console.error(`C8 信号恢复失败: ${error.message}`) }
        }
        try { rmSync(lockPath, { force: true }) } catch { /* best effort */ }
        process.exit(signal === 'SIGINT' ? 130 : 143)
      }
      process.on('SIGINT', () => onSignal('SIGINT'))
      process.on('SIGTERM', () => onSignal('SIGTERM'))
      // Async spawn (not spawnSync): the event loop must stay free so a signal
      // during a rebuild is handled immediately — restore, kill the child, exit.
      const BUILD_TIMEOUT_MS = 300_000
      const runBuild = (script) => new Promise((resolve) => {
        const proc = spawn(process.execPath, [script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
        child = proc
        let stderr = ''
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          try { proc.kill('SIGKILL') } catch { /* already gone */ }
        }, BUILD_TIMEOUT_MS)
        proc.stderr.on('data', (chunk) => { stderr += chunk })
        proc.on('error', (error) => {
          clearTimeout(timer)
          child = undefined
          resolve({ status: -1, stderr: error.message })
        })
        proc.on('close', (status) => {
          clearTimeout(timer)
          child = undefined
          resolve({ status: timedOut ? -1 : status, stderr: timedOut ? `${stderr}\nbuild timed out after ${BUILD_TIMEOUT_MS}ms` : stderr })
        })
      })
      const stale = []
      const skipped = []
      try {
        for (const group of groups) {
          const paths = group.outputs.map((output) => join(ROOT, output))
          const missing = group.outputs.filter((_, index) => !existsSync(paths[index]))
          if (missing.length > 0) {
            stale.push(...missing.map((output) => `${output}（缺失）`))
            continue
          }
          let snapshots
          try {
            snapshots = new Map(artifactDirs(group).map(dir => [dir, snapshotDir(dir)]))
          } catch (error) {
            stale.push(`${group.script} 的产物不可读：${error.message}`)
            continue
          }
          inFlight = () => { for (const [dir, files] of snapshots) restoreDir(dir, files) }
          try {
            const run = await runBuild(group.script)
            if (run.status !== 0) {
              const detail = `${run.stderr ?? ''}`.trim().split('\n').pop() ?? `exit ${run.status}`
              skipped.push(`${group.script}（构建不可用：${detail}）`)
              continue
            }
            stale.push(...compareOutputs(
              group.outputs,
              ROOT,
              snapshots,
              (abs, dir) => relative(dir, abs),
            ))
          } finally {
            // Restore the whole artifact directory verbatim (extra files
            // removed, originals written back) — the gate must not leave a
            // modified working tree, even on a build failure.
            inFlight()
            inFlight = undefined
          }
        }
      } finally {
        closeSync(lockFd)
        rmSync(lockPath, { force: true })
      }
      for (const note of skipped) warn(`C8 跳过：${note}`)
      const verdict = artifactGateVerdict({ stale, skipped })
      if (!verdict.ok) fail(verdict.message)
      else console.log(`✓ C8 提交态生成物与 src 一致（重建-比对，${groups.length} 组）`)
    }
  }
}

// C9 —— vendor 源码补丁锚（design 09 §3.6；硬失败）
{
  const { VENDOR_PATCHES, checkVendorPatchSources } = await import(
    join(ROOT, 'packages/renderer/scripts/vendor-patches.mjs')
  )
  const results = checkVendorPatchSources()
  const broken = results.filter(result => !result.ok)
  const editCount = VENDOR_PATCHES.reduce((total, patch) => total + patch.edits.length, 0)
  if (broken.length > 0) {
    fail(`C9 vendor 补丁锚漂移（重锚后需按新 pin 重导补丁）: ${broken.map(b => `${b.vendorFile} — ${b.detail}`).join('; ')}`)
  } else if (results.length === 0) {
    warn('C9 未注册任何 vendor 补丁（如确已全部退役可忽略）')
  } else {
    console.log(`✓ C9 vendor 补丁锚: ${results.length} 文件 / ${editCount} 处锚点全部唯一命中`)
  }
}

// C10 —— 版本锚一致性 + 活版本字面量白名单（硬失败）
{
  const DSH_VERSION_RE = /0\.1\.[0-9]+-(?:alpha|beta|rc)\.[0-9]+/g
  // SINGLE SOURCE = the TRACKED bundle lockfile (`bundle:dsh` regenerates it;
  // the sibling package.json is gitignored and absent in a fresh checkout).
  // When that manifest does exist locally it must agree, so a hand-edited
  // workdir cannot silently disagree with the anchored line.
  const lockPath = join(ROOT, 'packages', 'desktop', 'vendor', 'dsh', 'pnpm-lock.yaml')
  const lockText = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : ''
  const lockMatch = /'@deepseek-ai\/dsh':\n\s+specifier: (\S+)\n\s+version: (\S+)/.exec(lockText)
  const current = lockMatch?.[1]
  const manifestPath = join(ROOT, 'packages', 'desktop', 'vendor', 'dsh', 'package.json')
  const manifestVersion = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))?.dependencies?.['@deepseek-ai/dsh']
    : undefined
  if (typeof current !== 'string' || !DSH_VERSION_RE.test(current)) {
    fail(`C10 无法从 packages/desktop/vendor/dsh/pnpm-lock.yaml 读出运行时版本（得到 ${JSON.stringify(current)}）`)
  } else if (manifestVersion !== undefined && manifestVersion !== current) {
    fail(`C10 运行时线自相矛盾：锁文件 ${current} != bundle 工作目录清单 ${manifestVersion}（重跑 bundle:dsh）`)
  } else {
    DSH_VERSION_RE.lastIndex = 0
    // Files MAY carry a live dsh version literal — each entry is an anchor or a
    // named diagnostic constant; a value != the pinned runtime version fails.
    // anchor:true  → 每处活字面量必须等于 current（锚/单一来源/fork 基线）
    // anchor:false → 具名诊断常量（上限 1 处，值本身是历史事实，例如「身份探针自哪一代起注册」）
    const ALLOWED = new Map([
      ['packages/desktop/vendor/dsh/package.json', { anchor: true, reason: 'bundle 工作目录清单（gitignored；本地存在时与锁文件交叉校验）' }],
      ['packages/desktop/scripts/bundle-dsh.mjs', { anchor: true, reason: '运行时线锚 1/6（bundle 兜底常量）' }],
      ['packages/desktop/vendor/dsh/pnpm-lock.yaml', { anchor: true, reason: '运行时版本的**单一来源**（C10 的 current 读自此处；bundle:dsh 生成且已提交）' }],
      ['.github/workflows/release.yml', { anchor: true, reason: '运行时线锚 3/6（release env）' }],
      ['scripts/install-gateway.sh', { anchor: true, reason: '运行时线锚 4/6（gateway 安装默认值）' }],
      ['packages/gateway/package.json', { anchor: true, reason: '运行时线锚 5/6（dshAnchorVersion）' }],
      ['scripts/dev/release-preflight.mjs', { anchor: true, reason: '运行时线锚 6/6（FORK_VERSION）' }],
      ['packages/dsh-client-connection/package.json', { anchor: true, reason: 'fork 副本版本 = 上游基线' }],
      ['packages/dsh-client-web/package.json', { anchor: true, reason: 'fork 副本版本 = 上游基线' }],
      ['packages/dsh-api-gateway/package.json', { anchor: true, reason: 'fork 副本版本 = 上游基线' }],
      ['packages/control-plane/src/rpc-envelope.ts', { anchor: false, reason: 'HOST_IDENTITY_METHOD_SINCE：身份探针「自哪一代起注册」的唯一常量（历史事实，不等于 current）' }],
      ['packages/dsh-runtime/src/runtime-probes.ts', { anchor: false, reason: '上条常量的跨包镜像（本包不依赖控制面）' }],
    ])
    const REQUIRED = [
      'packages/desktop/scripts/bundle-dsh.mjs',
      '.github/workflows/release.yml',
      'scripts/install-gateway.sh',
      'packages/gateway/package.json',
      'scripts/dev/release-preflight.mjs',
      'packages/desktop/vendor/dsh/pnpm-lock.yaml',
    ]
    // Live-literal extraction: TS/JS via esbuild (comments stripped, strings
    // preserved); yml/sh/json via a line scan that drops `#`/`//` comments.
    const esbuildEntry = (() => {
      try {
        const requireFromRenderer = createRequire(join(ROOT, 'packages', 'renderer', 'package.json'))
        const viteEntry = requireFromRenderer.resolve('vite')
        return createRequire(viteEntry).resolve('esbuild')
      } catch {
        return undefined
      }
    })()
    let transformSync
    if (esbuildEntry !== undefined) {
      const esbuild = await import(pathToFileURL(esbuildEntry).href)
      transformSync = esbuild.transformSync
    }
    /** Drop line and block comments outside JSON strings. */
    const stripJsonComments = (text) => {
      let out = ''
      let quote = false
      let i = 0
      while (i < text.length) {
        const ch = text[i]
        const next = text[i + 1]
        if (quote) {
          out += ch
          if (ch === '\\') { out += next ?? ''; i += 2; continue }
          if (ch === '"') quote = false
          i += 1
          continue
        }
        if (ch === '"') { quote = true; out += ch; i += 1; continue }
        if (ch === '/' && next === '/') {
          while (i < text.length && text[i] !== '\n') i += 1
          continue
        }
        if (ch === '/' && next === '*') {
          i += 2
          while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
          i += 2
          continue
        }
        out += ch
        i += 1
      }
      return out
    }

    const candidates = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        const rel = relative(ROOT, full)
        if (entry.isDirectory()) {
          if (['node_modules', 'dist', 'lib', '.git', 'docs', 'coverage', 'generated'].includes(entry.name)) continue
          if (rel.startsWith('packages/desktop/vendor/') && entry.name !== 'dsh') continue
          if (rel === 'packages/desktop/vendor/dsh' || rel.startsWith('packages/desktop/vendor/dsh/')) {
            // only the runtime manifest + lockfile are scanned below
            if (entry.name !== 'dsh') continue
            for (const inner of ['package.json', 'pnpm-lock.yaml']) {
              const innerPath = join(full, inner)
              if (existsSync(innerPath)) candidates.push(innerPath)
            }
            continue
          }
          walk(full)
          continue
        }
        if (!/\.(ts|tsx|mjs|js|yml|yaml|json|sh)$/.test(entry.name)) continue
        if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.mjs')) continue
        if (rel.includes('/test/') || rel.includes('/test-fixtures/')) continue
        if (rel === 'pnpm-lock.yaml') continue
        candidates.push(full)
      }
    }
    for (const dir of ['packages', 'scripts', '.github']) {
      const full = join(ROOT, dir)
      if (existsSync(full)) walk(full)
    }
    if (existsSync(join(ROOT, 'package.json'))) candidates.push(join(ROOT, 'package.json'))

    const liveLiterals = (file) => {
      const src = readFileSync(file, 'utf8')
      const rel = relative(ROOT, file)
      if (/\.(ts|tsx|mjs|js)$/.test(file)) {
        if (transformSync === undefined) return undefined // esbuild unavailable: report a skip
        const code = transformSync(src, {
          loader: file.endsWith('.tsx') ? 'tsx' : file.endsWith('.ts') ? 'ts' : 'js',
          minifyWhitespace: true,
          legalComments: 'none',
        }).code
        return [...code.matchAll(DSH_VERSION_RE)].map((m) => m[0])
      }
      // yml/sh (`#`) and jsonc (`//`, `/* */`) comments are stripped with a
      // string-aware scan so a comment can never masquerade as a live literal.
      const stripped = file.endsWith('.json')
        ? stripJsonComments(src)
        : src.split('\n').map((line) => line.replace(/#.*$/, '')).join('\n')
      return [...stripped.matchAll(DSH_VERSION_RE)].map((m) => m[0])
    }

    const unregistered = []
    const stale = []
    const skipped = []
    const seen = new Map()
    for (const file of candidates) {
      const rel = relative(ROOT, file)
      const found = liveLiterals(file)
      if (found === undefined) {
        skipped.push(rel)
        continue
      }
      if (found.length === 0) continue
      seen.set(rel, [...new Set(found)])
      const rule = ALLOWED.get(rel)
      if (rule === undefined) {
        unregistered.push(`${rel} → ${[...new Set(found)].join(', ')}`)
        continue
      }
      if (!rule.anchor) {
        // Named diagnostic constant: exactly one literal, value is a recorded
        // historical fact (not the pin) — more than one means it proliferated.
        if (found.length > 1) {
          stale.push(`${rel} → ${found.length} 处版本字面量（具名常量上限 1 处：${rule.reason}）`)
        }
        continue
      }
      for (const value of new Set(found)) {
        if (value !== current) stale.push(`${rel} → ${value}（应为 ${current}；${rule.reason}）`)
      }
    }
    for (const rel of REQUIRED) {
      if (!seen.has(rel)) {
        // A required anchor with NO literal is also drift (it must pin the version).
        const full = join(ROOT, rel)
        const raw = existsSync(full) ? readFileSync(full, 'utf8') : ''
        if (!raw.includes(current)) stale.push(`${rel} → 未出现运行时版本 ${current}`)
      }
    }
    if (unregistered.length > 0) {
      fail(`C10 未登记的「活」dsh 版本字面量（生产源码/脚本/配置里不应硬编码版本；历史叙述请留在注释里，或登记到 C10 白名单并说明理由）: ${unregistered.join('; ')}`)
    } else if (stale.length > 0) {
      fail(`C10 版本锚不一致: ${stale.join('; ')}`)
    } else if (skipped.length > 0) {
      warn(`C10 跳过 ${skipped.length} 个文件（esbuild 不可用，无法剥离注释做活字面量扫描）`)
    } else {
      console.log(`✓ C10 版本锚 = ${current}（六锚 + 3 fork 一致；生产源码无未登记版本字面量，扫描 ${candidates.length} 文件）`)
    }
  }
}

// C2 —— tag 重放报告（advisory）
{
  const tagIndex = process.argv.indexOf('--tags')
  if (tagIndex !== -1 && process.argv[tagIndex + 2] !== undefined) {
    const [oldTag, newTag] = process.argv.slice(tagIndex + 1, tagIndex + 3)
    const dirs = FORKS.map((f) => f.upstream)
    const result = spawnSync('git', ['-C', SUBMODULE, 'diff', '--stat', oldTag, newTag, '--', ...dirs], { encoding: 'utf8' })
    console.log(`\n[C2] 上游 ${oldTag} → ${newTag} 触点面差异（advisory）：`)
    console.log(result.stdout.trim() || '  （无差异）')
    for (const f of FORKS) {
      const added = spawnSync('git', ['-C', SUBMODULE, 'diff', '--name-status', oldTag, newTag, '--', `${f.upstream}/package.json`], { encoding: 'utf8' })
      console.log(`[C2] ${f.name} package.json: ${added.stdout.trim().split('\n')[0] || 'unchanged'}`)
    }
    console.log('[C2] 提示：按 docs/checklists/upstream-touchpoints.md §7 循环逐面裁决（重放/登记/契约复验）。')
  }
}

if (hardFails > 0 || (process.exitCode ?? 0) !== 0) {
  process.exitCode = 1
  console.error(`\n✗ verify-upstream-touchpoints: ${hardFails} 项硬失败——见上。`)
} else {
  console.log('\n✓ verify-upstream-touchpoints 全部通过（C1/C3–C10）')
}
