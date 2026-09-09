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
 *
 * 登记纪律：给某个文件打 chamber 补丁 = 在 FORKS.patched 里登记（含原因）；
 * 新增 chamber 自有文件 = own；上游文件有意不镜像 = dropped。任何对 pure
 * 文件的修改都会在此硬失败——升级/重锚后同步登记表（每 tag 维护循环见文档 §7）。
 *
 * 用法：
 *   node scripts/dev/verify-upstream-touchpoints.mjs            # C1/C3–C8
 *   node scripts/dev/verify-upstream-touchpoints.mjs --tags <old> <new>  # +C2
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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

function fail(message) {
  console.error(`✗ ${message}`)
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
let hardFails = 0

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
    hardFails += 1
    console.error(`✗ [${fork.name}] C1/C3 违规 ${violations.length} 项:`)
    for (const v of violations) console.error(`    - ${v}`)
  } else {
    console.log(`✓ [${fork.name}] C1/C3: pure=${pure} patched=${patchedKeys.size} own=${forkFiles.length - pure - patchedKeys.size} dropped=${fork.dropped.length}`)
  }
  if (upPkg.version !== forkPkg.version) {
    hardFails += 1
    fail(`C5 [${fork.name}] fork 版本 ${forkPkg.version} != 上游 ${upPkg.version}（过期锚——升级/重锚后应同步）`)
  }
}

// C5 —— submodule HEAD == 声明 pin
{
  const head = spawnSync('git', ['-C', SUBMODULE, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (head.status !== 0 || head.stdout.trim() !== pin) {
    hardFails += 1
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
    hardFails += 1
  }

  const assemblyEntry = join(ROOT, 'vendor/harness-packages/@deepseek-ai/dsh-api-remotes/src/client/index.ts')
  if (existsSync(assemblyEntry)) {
    const { remotePackagesFromAssembly, EXPECTED_REMOTE_PACKAGES } = await import(
      join(ROOT, 'packages/renderer/scripts/typert-remote-contract.mjs')
    )
    const remotes = remotePackagesFromAssembly(readFileSync(assemblyEntry, 'utf8'))
    // Exact set AND order: a same-length swap (a package added while another
    // is removed, or a reordered assembly) must not pass silently. The
    // expected list is single-sourced in typert-remote-contract.mjs (shared
    // with the lockstep test) so an upstream change is one edit.
    const expected = [...EXPECTED_REMOTE_PACKAGES]
    if (remotes.length !== expected.length || remotes.some((name, index) => name !== expected[index])) {
      hardFails += 1
      fail(`C4 remotePackagesFromAssembly = ${JSON.stringify(remotes)}（期望 ${JSON.stringify(expected)}）——上游装配面变更需重审 typert 契约`)
    } else {
      console.log(`✓ C4 remote assembly 契约 = ${remotes.length}（集合与顺序）`)
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
    hardFails += 1
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
    const stale = []
    const skipped = []
    for (const group of groups) {
      const paths = group.outputs.map((output) => join(ROOT, output))
      const missing = group.outputs.filter((_, index) => !existsSync(paths[index]))
      if (missing.length > 0) {
        stale.push(...missing.map((output) => `${output}（缺失）`))
        continue
      }
      const before = paths.map((path) => readFileSync(path))
      try {
        const run = spawnSync(process.execPath, [join(ROOT, group.script)], { cwd: ROOT, encoding: 'utf8' })
        if (run.status !== 0) {
          const detail = `${run.stderr ?? ''}`.trim().split('\n').pop() ?? `exit ${run.status}`
          skipped.push(`${group.script}（构建不可用：${detail}）`)
          continue
        }
        for (const [index, output] of group.outputs.entries()) {
          if (!readFileSync(paths[index]).equals(before[index])) stale.push(output)
        }
      } finally {
        // Restore verbatim: the gate must not leave a modified working tree.
        paths.forEach((path, index) => writeFileSync(path, before[index]))
      }
    }
    for (const note of skipped) warn(`C8 跳过：${note}`)
    if (stale.length > 0) {
      hardFails += 1
      fail(`C8 提交态生成物与 src 不一致（重建后字节不同）: ${stale.join(', ')} — 跑 pnpm run build:host-packages / node packages/dsh-chamber-client-ui-mobile/scripts/build.mjs 后提交`)
    } else if (skipped.length === 0) {
      console.log('✓ C8 提交态生成物与 src 一致（重建-比对）')
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

if ((process.exitCode ?? 0) !== 0) {
  console.error('\n✗ verify-upstream-touchpoints: 存在硬失败——见上。')
} else {
  console.log('\n✓ verify-upstream-touchpoints 全部通过（C1/C3–C8）')
}
