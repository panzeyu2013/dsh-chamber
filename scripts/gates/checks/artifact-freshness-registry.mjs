/**
 * G2/G8 artifact-freshness registry — every build artifact, its generator, and
 * either the guard that notices staleness or a signed exemption reason.
 *
 * WHY: the freshness gate only compares the classes it implements; an artifact
 * nobody compares (desktop/dist/web, the host-package trees, the vendor
 * allowBuilds lockstep) can be stale on the exact machine that packages it while
 * every CI run is green (CI always builds from scratch and never sees "exists but
 * stale"). G2 = one table asserting every artifact has a guard OR a recorded
 * exemption; G8 = the exemption itself must carry a reason someone signed, so the
 * table cannot be hollowed out by exempting everything silently.
 *
 * Ownership: the freshness ids are the ids `verify-artifact-freshness.mjs` emits
 * from `note()`; the verifier enforces the two-way lockstep at run time (an id
 * here with no verifier note, or a note with no registry row, fails the gate).
 * Guard classes that live elsewhere (C8 build-artifacts, test-wiring, package
 * marker guards) are registered here but not re-implemented.
 */

/** Allowed guard classes. */
export const FRESHNESS_GUARD_KINDS = Object.freeze(['freshness', 'build-artifacts', 'test-wiring', 'marker', 'exemption'])

/**
 * The registry. `guard.kind === 'exemption'` entries MUST carry a non-empty
 * `guard.reason` (G8); every other entry MUST carry a non-empty `guard.detail`
 * naming where the guard lives.
 */
export const ARTIFACT_FRESHNESS_REGISTRY = Object.freeze([
  {
    id: 'desktop/preload.cjs',
    artifact: 'packages/desktop/dist/preload.cjs',
    generator: 'pnpm --filter @dsh-chamber/desktop run build:preload',
    guard: { kind: 'freshness', detail: 'tsc 重编译逐字节比对（Electron 冻结归档，复活时才产出）' },
  },
  {
    id: 'renderer/src/generated/typert',
    artifact: 'packages/renderer/src/generated/typert/**',
    generator: 'pnpm run build:renderer（gen-typert-remotes）',
    guard: { kind: 'freshness', detail: '重跑生成器：目录键集 == C4 roster + 同名文件逐字节' },
  },
  {
    id: 'gateway/dist/index.js',
    artifact: 'packages/gateway/dist/index.js',
    generator: 'pnpm run build:gateway',
    guard: { kind: 'freshness', detail: '临时副本重建后逐字节（模块注释行 rung 归一）' },
  },
  {
    id: 'seed/dist',
    artifact: 'packages/dsh-chamber-seed-*/dist/index.js（4 个 seed 包）',
    generator: 'pnpm run build:host-packages',
    guard: { kind: 'build-artifacts', detail: 'C8 单一清单 scripts/lib/build-artifacts.mjs（verify-upstream-touchpoints C8）' },
  },
  {
    id: 'dsh-runtime/dist',
    artifact: 'packages/dsh-runtime/dist/index.js',
    generator: 'pnpm run build:dsh-runtime',
    guard: { kind: 'build-artifacts', detail: 'C8 单一清单 scripts/lib/build-artifacts.mjs（verify-upstream-touchpoints C8）' },
  },
  {
    id: 'desktop/dist/control-plane',
    artifact: 'packages/desktop/dist/control-plane/**',
    generator: 'pnpm --filter @dsh-chamber/desktop run build:control-plane',
    guard: { kind: 'marker', detail: 'packages/desktop/scripts/control-plane-freshness.test.ts（标记守卫，逐文件内容不比对）' },
  },
  {
    id: 'gateway/dist (marker)',
    artifact: 'packages/gateway/dist/**',
    generator: 'pnpm run build:gateway',
    guard: { kind: 'marker', detail: '标记守卫；入口文件的内容比对由 gateway/dist/index.js 一类承担' },
  },
  {
    id: 'test-wiring',
    artifact: '测试接线（G1/G4/G6）',
    generator: '人工登记 + 脚本',
    guard: { kind: 'test-wiring', detail: 'verify:test-wiring 断言每个测试文件都被某脚本接线' },
  },
  {
    id: 'desktop/dist/web',
    artifact: 'packages/desktop/dist/web/**',
    generator: 'pnpm run build:renderer',
    guard: {
      kind: 'freshness',
      detail: 'G3 构建清单：check-chunk-budgets.mjs 成功末尾写 .build-manifest.json（inputsHash/toolVersion/outputs）；verify-artifact-freshness 读回比对（缺失=SKIP，漂移=陈旧）',
    },
  },
  {
    id: 'desktop/dist/host-*-package',
    artifact: 'packages/desktop/dist/host-{graph,git-worktree,archive-cleanup,open-in}-package/**',
    generator: 'pnpm --filter @dsh-chamber/desktop run build:host-graph-package',
    guard: {
      kind: 'freshness',
      detail: 'G3 构建清单：build-host-graph-package.mjs 在 .tmp 内写 .build-manifest.json 后原子 rename；verify-artifact-freshness 逐行比对（含行集不得缩水：缺目录或旧摘要=陈旧）',
    },
  },
  {
    id: 'vendor allowBuilds lockstep',
    artifact: '根 pnpm-workspace.yaml ↔ packages/dsh-runtime/src/allow-builds.mjs',
    generator: '人工同步',
    guard: {
      kind: 'exemption',
      reason: '纯人工同步表，没有可比较的生成物；漂移的影响面（原生依赖构建白名单）由 frozen lockfile 与 allowBuilds 渲染测试覆盖去水（G7 锁步门未落地，登记为已知缺口）',
    },
  },
])

/** Problem list for a registry (empty = valid). Exported for the gate + its tests. */
export function validateArtifactFreshnessRegistry(registry = ARTIFACT_FRESHNESS_REGISTRY) {
  const problems = []
  const seen = new Set()
  for (const entry of registry) {
    const where = typeof entry?.id === 'string' ? entry.id : '<missing id>'
    if (typeof entry?.id !== 'string' || entry.id.trim() === '') { problems.push('entry without a non-empty id'); continue }
    if (seen.has(entry.id)) problems.push('duplicate id: ' + entry.id)
    seen.add(entry.id)
    for (const field of ['artifact', 'generator']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') problems.push(where + ': missing ' + field)
    }
    if (typeof entry.guard !== 'object' || entry.guard === null) { problems.push(where + ': missing guard'); continue }
    if (!FRESHNESS_GUARD_KINDS.includes(entry.guard.kind)) { problems.push(where + ': unknown guard kind ' + String(entry.guard.kind)); continue }
    if (entry.guard.kind === 'exemption') {
      if (typeof entry.guard.reason !== 'string' || entry.guard.reason.trim() === '') problems.push(where + ': exemption needs a reason (G8)')
    } else if (typeof entry.guard.detail !== 'string' || entry.guard.detail.trim() === '') {
      problems.push(where + ': guard needs a detail naming where it lives')
    }
  }
  return problems
}

/** The ids the freshness verifier itself must observe (two-way lockstep). */
export function freshnessGuardIds(registry = ARTIFACT_FRESHNESS_REGISTRY) {
  return registry.filter(entry => entry.guard.kind === 'freshness').map(entry => entry.id)
}

/** One-line summary for the gate output. */
export function artifactFreshnessSummary(registry = ARTIFACT_FRESHNESS_REGISTRY) {
  const counts = { freshness: 0, 'build-artifacts': 0, 'test-wiring': 0, marker: 0, exemption: 0 }
  for (const entry of registry) counts[entry.guard.kind] += 1
  return 'G2/G8 registry: ' + registry.length + ' artifact(s) — ' + JSON.stringify(counts)
}
