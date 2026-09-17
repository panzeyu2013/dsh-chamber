/**
 * host-package-dirs.test.ts —— chamber host 包目录名映射纯函数单测。
 *
 * 覆盖 2026-12 验证轮的两条要求：
 *  ① scoped 包名必须去 scope（dev 向上检索按 packages/<目录名> 拼路径，把
 *     '@scope/name' 当目录名会让检索永远落空——该缺陷在集成期被自查抓到）；
 *  ② 无 scope 包名原样返回、空串/异常输入不得抛（调用方在装配路径上）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageDirName } from './host-package-dirs.ts'

test('① scoped 包名去 scope（注册表 → 仓库目录名）', () => {
  assert.equal(packageDirName('@dsh-chamber/dsh-chamber-seed-client-graph'), 'dsh-chamber-seed-client-graph')
  assert.equal(packageDirName('@dsh-chamber/dsh-chamber-seed-git-worktree'), 'dsh-chamber-seed-git-worktree')
  assert.equal(packageDirName('@dsh-chamber/dsh-chamber-seed-archive-cleanup'), 'dsh-chamber-seed-archive-cleanup')
  // 只剥第一段 scope：@a/b/c 的目录名是 b/c（与 npm 语义一致）。
  assert.equal(packageDirName('@a/b/c'), 'b/c')
})

test('② 无 scope / 边界输入原样返回', () => {
  assert.equal(packageDirName('plain-name'), 'plain-name')
  assert.equal(packageDirName('@scope-only/'), '')
  assert.equal(packageDirName(''), '')
})

/** P-05/P-13：布局锚点具名函数（sidecar-ctx 导出；Swift 布局锁步测试读源文本）。 */
test('③ P-13 打包布局锚点 = Swift PackagedLayout / build-sidecar.sidecarLayout 拼写', async () => {
  const {
    packagedHostPackageDir,
    packagedPnpmEntry,
    legacyPackagedPnpmEntry,
    devPnpmEntry,
  } = await import('./sidecar-ctx.ts')
  assert.equal(packagedHostPackageDir('/R/sidecar', 'pkg-a'), '/R/sidecar/dist/pkg-a')
  assert.equal(packagedPnpmEntry('/R/sidecar'), '/R/sidecar/pnpm/bin/pnpm.cjs')
  // path.join 会规范化 '..'：旧装配位 = <sidecarDir 的父目录>/pnpm/bin/pnpm.cjs。
  assert.equal(legacyPackagedPnpmEntry('/R/sidecar'), '/R/pnpm/bin/pnpm.cjs')
  assert.equal(legacyPackagedPnpmEntry('/R/sidecar/'), '/R/pnpm/bin/pnpm.cjs')
  assert.equal(devPnpmEntry('/repo/packages/desktop'), '/repo/packages/desktop/node_modules/pnpm/bin/pnpm.cjs')
})

test('④ P-05 检索根限定含 pnpm-workspace.yaml 的目录；祖先链同名包不再成为 seed 源', async () => {
  const { findWorkspaceRoot, resolveHostPackageSourceDir, packagedHostPackageDir } = await import('./sidecar-ctx.ts')
  const fixture = mkdtempSync(path.join(tmpdir(), 'dsh-host-dirs-'))
  try {
    // 祖先链上有 packages/pkg-a/package.json，但**没有** pnpm-workspace.yaml
    // → 不得采信（P-05 的原始风险：祖先链同名包被当成源）。
    const nested = path.join(fixture, 'outer', 'inner')
    mkdirSync(path.join(fixture, 'outer', 'packages', 'pkg-a'), { recursive: true })
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(fixture, 'outer', 'packages', 'pkg-a', 'package.json'), '{}')
    assert.equal(findWorkspaceRoot(nested), null, '无 pnpm-workspace.yaml 不构成检索根')
    const unanchored = resolveHostPackageSourceDir('pkg-a', null, nested)
    assert.equal(
      unanchored,
      packagedHostPackageDir(nested, 'pkg-a'),
      '无 workspace 根时退回打包锚点 <moduleDir>/dist/<pkg>，绝不采信祖先链同名包',
    )
    assert.notEqual(unanchored, path.join(fixture, 'outer', 'packages', 'pkg-a'))

    // 在 outer 放 pnpm-workspace.yaml 后成为检索根：packages/pkg-a 被采信。
    writeFileSync(path.join(fixture, 'outer', 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    assert.equal(findWorkspaceRoot(nested), path.join(fixture, 'outer'))
    assert.equal(
      resolveHostPackageSourceDir('pkg-a', null, nested),
      path.join(fixture, 'outer', 'packages', 'pkg-a'),
    )
    // 显式 CLI 目录优先，且不要求存在（seed 侧存在性过滤负责 loud）。
    assert.equal(resolveHostPackageSourceDir('pkg-a', '/explicit/dir', nested), '/explicit/dir')

    // 真实仓库：pnpm-workspace.yaml 在 repo 根；packages/desktop 的 dev 解析命中源树。
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
    assert.equal(findWorkspaceRoot(path.join(repoRoot, 'packages', 'desktop')), repoRoot)
    assert.equal(
      resolveHostPackageSourceDir('dsh-chamber-seed-client-graph', null, path.join(repoRoot, 'packages', 'desktop')),
      path.join(repoRoot, 'packages', 'dsh-chamber-seed-client-graph'),
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})


/** P-04：Electron-free sidecar 的 dev 内建工作区回退（与 main.ts 同候选顺序）。 */
test('⑥ P-04 sidecar dev fallback: explicit > ref-dsh > vendor; packaged never probes the repo', async () => {
  const {
    devBuiltinDshWorkspaceCandidates,
    resolveDevBuiltinDshWorkspace,
    resolveSidecarBuiltinDshWorkspace,
  } = await import('./shell-core.ts')
  const fixture = mkdtempSync(path.join(tmpdir(), 'dsh-dev-workspace-'))
  try {
    const packageDir = path.join(fixture, 'repo', 'packages', 'desktop')
    const refDsh = path.join(fixture, 'repo', 'ref-dsh')
    const vendorDsh = path.join(packageDir, 'vendor', 'dsh')
    assert.deepEqual(devBuiltinDshWorkspaceCandidates(packageDir), [refDsh, vendorDsh])
    // 两分支：都不存在 → null（保持 loud blocked 语义）。
    assert.equal(resolveDevBuiltinDshWorkspace(packageDir), null)
    // 只有 vendor → vendor。
    mkdirSync(vendorDsh, { recursive: true })
    assert.equal(resolveDevBuiltinDshWorkspace(packageDir), vendorDsh)
    // ref-dsh 优先于 vendor。
    mkdirSync(refDsh, { recursive: true })
    assert.equal(resolveDevBuiltinDshWorkspace(packageDir), refDsh)
    // sidecar 解析：dev 走回退；显式参数恒最高优先；打包形态恒不探测仓库。
    assert.equal(resolveSidecarBuiltinDshWorkspace({ explicit: null, packaged: false, packageDir }), refDsh)
    assert.equal(resolveSidecarBuiltinDshWorkspace({ explicit: '/explicit/dsh', packaged: false, packageDir }), '/explicit/dsh')
    assert.equal(resolveSidecarBuiltinDshWorkspace({ explicit: null, packaged: true, packageDir }), null,
      '打包形态不得探测仓库（装配总是显式 --dsh-path，缺省保持 loud 阻塞）')
    assert.equal(resolveSidecarBuiltinDshWorkspace({ explicit: '/explicit/dsh', packaged: true, packageDir }), '/explicit/dsh')
    // exists 可注入：不触盘也能覆盖「候选命中」分支。
    assert.equal(
      resolveSidecarBuiltinDshWorkspace({
        explicit: null,
        packaged: false,
        packageDir: '/nowhere',
        exists: candidate => candidate.endsWith(path.join('vendor', 'dsh')),
      }),
      path.join('/nowhere', 'vendor', 'dsh'),
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

/** P-05 加固：只认最近的 pnpm-workspace.yaml 根，不再向更高祖先探测。 */
test('⑦ P-05 最近 workspace 根优先：更上层的同名 packages/<pkg> 绝不被采信', async () => {
  const { findWorkspaceRoot, resolveHostPackageSourceDir, packagedHostPackageDir } = await import('./sidecar-ctx.ts')
  const fixture = mkdtempSync(path.join(tmpdir(), 'dsh-workspace-nearest-'))
  try {
    const grand = path.join(fixture, 'grand')
    const middle = path.join(grand, 'middle')
    const start = path.join(middle, 'packages', 'desktop')
    mkdirSync(path.join(grand, 'packages', 'pkg-a'), { recursive: true })
    writeFileSync(path.join(grand, 'packages', 'pkg-a', 'package.json'), '{}')
    mkdirSync(start, { recursive: true })
    writeFileSync(path.join(middle, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    // 最近的根（middle）没有 packages/pkg-a：必须退回打包锚点，绝不越过它去
    // grand 的同名包（祖先链同名 package.json 风险的第二形态）。
    assert.equal(findWorkspaceRoot(start), middle)
    assert.equal(resolveHostPackageSourceDir('pkg-a', null, start), packagedHostPackageDir(start, 'pkg-a'))
    assert.notEqual(resolveHostPackageSourceDir('pkg-a', null, start), path.join(grand, 'packages', 'pkg-a'))
    // 最近的根里有包 → 命中它。
    mkdirSync(path.join(middle, 'packages', 'pkg-a'), { recursive: true })
    writeFileSync(path.join(middle, 'packages', 'pkg-a', 'package.json'), '{}')
    assert.equal(resolveHostPackageSourceDir('pkg-a', null, start), path.join(middle, 'packages', 'pkg-a'))
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
test('⑤ P-13 pnpm 入口解析：装配位 > 旧装配位 > dev；全缺失保留 dev 形状', async () => {
  const {
    resolvePnpmEntry,
    packagedPnpmEntry,
    legacyPackagedPnpmEntry,
    devPnpmEntry,
  } = await import('./sidecar-ctx.ts')
  const fixture = mkdtempSync(path.join(tmpdir(), 'dsh-pnpm-entry-'))
  try {
    // moduleDir = <fixture>/a/b：旧装配位 = <fixture>/a/pnpm/bin/pnpm.cjs。
    const moduleDir = path.join(fixture, 'a', 'b')
    mkdirSync(moduleDir, { recursive: true })
    // 全空：保留 dev 形状（安装路径上的 loud 失败与 main 缺 artifact 同向）。
    assert.equal(resolvePnpmEntry(moduleDir), devPnpmEntry(moduleDir))
    // dev 位存在 → 命中 dev。
    mkdirSync(path.dirname(devPnpmEntry(moduleDir)), { recursive: true })
    writeFileSync(devPnpmEntry(moduleDir), '// dev')
    assert.equal(resolvePnpmEntry(moduleDir), devPnpmEntry(moduleDir))
    assert.equal(existsSync(devPnpmEntry(moduleDir)), true)
    // 旧装配位存在 → 优先旧装配位（Resources/pnpm 同构位）。
    mkdirSync(path.dirname(legacyPackagedPnpmEntry(moduleDir)), { recursive: true })
    writeFileSync(legacyPackagedPnpmEntry(moduleDir), '// legacy')
    assert.equal(resolvePnpmEntry(moduleDir), legacyPackagedPnpmEntry(moduleDir))
    // 装配位存在 → 最高优先（sidecarLayout().pnpmEntry 同锚）。
    mkdirSync(path.dirname(packagedPnpmEntry(moduleDir)), { recursive: true })
    writeFileSync(packagedPnpmEntry(moduleDir), '// assembled')
    assert.equal(resolvePnpmEntry(moduleDir), packagedPnpmEntry(moduleDir))
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
