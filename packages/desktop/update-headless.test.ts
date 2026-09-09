/**
 * update-headless.test.ts —— Swift flavor 更新控制器单测（W-22；design 25 §7）
 *
 * 覆盖：
 *  ① selectLatestReleaseVersion：stable/beta 通道的 draft/prerelease/tag 形状
 *     严格筛选 + 版本最大值（含畸形条目跳过、超界/非数组 → null）；
 *  ② resolveHeadlessChannel：内建 beta 版本 / DSH_CHAMBER_UPDATE_CHANNEL 覆盖；
 *  ③ 控制器初始态：idle + installBlockedReason = 原生壳 reason；
 *  ④ 真实 check（注入假 fetch）：有更新 → available + releaseUrl（过白名单）；
 *     无更新 → up-to-date（latestVersion/releaseUrl 清空）；
 *  ⑤ HTTP 失败 / 响应非数组 → error（绝不把 feed 故障伪装成「已是最新」）；
 *  ⑥ download/restartAndInstall 核心层显式拒绝（不是 UI 隐藏）；
 *  ⑦ subscribe 推送与退订；start() 不排周期检查。
 * 纯逻辑（无网络、无 Electron、无真实 timer 等待）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAllowedReleaseUrl } from './updater.ts'
import {
  NATIVE_SHELL_DOWNLOAD_REFUSAL,
  NATIVE_SHELL_INSTALL_BLOCKED_REASON,
  NATIVE_SHELL_RESTART_REFUSAL,
  createHeadlessUpdateController,
  resolveHeadlessChannel,
  selectLatestReleaseVersion,
} from './update-headless.ts'

const logger = { log: () => {}, warn: () => {}, error: () => {} }

function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}): typeof fetch {
  return (async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  })) as unknown as typeof fetch
}

function release(tag: string, opts: { draft?: boolean; prerelease?: boolean } = {}) {
  return { tag_name: tag, draft: opts.draft ?? false, prerelease: opts.prerelease ?? false }
}

test('① selectLatestReleaseVersion：stable 取最大非 draft/非 prerelease', () => {
  const releases = [
    release('v0.2.1'),
    release('v0.2.3', { prerelease: true }),
    release('v0.3.0'),
    release('v0.2.9', { draft: true }),
    release('v0.2.2'),
    release('v0.2.4-beta.1', { prerelease: true }),
    release('not-a-version'),
    null,
    'x',
  ]
  assert.equal(selectLatestReleaseVersion(releases, 'stable'), '0.3.0')
})

test('① selectLatestReleaseVersion：beta 只取 prerelease beta 最大值', () => {
  const releases = [
    release('v0.3.0'),
    release('v0.3.1-beta.2', { prerelease: true }),
    release('v0.3.1-beta.10', { prerelease: true }),
    release('v0.3.1-beta.3', { prerelease: true }),
    release('v0.4.0-beta.1', { draft: true, prerelease: true }),
  ]
  assert.equal(selectLatestReleaseVersion(releases, 'beta'), '0.3.1-beta.10')
})

test('① selectLatestReleaseVersion：非数组/超界/无候选 → null', () => {
  assert.equal(selectLatestReleaseVersion(null, 'stable'), null)
  assert.equal(selectLatestReleaseVersion({}, 'stable'), null)
  assert.equal(selectLatestReleaseVersion(new Array(101).fill(release('v9.9.9')), 'stable'), null)
  assert.equal(selectLatestReleaseVersion([release('v1.0.0', { draft: true })], 'stable'), null)
  assert.equal(selectLatestReleaseVersion([release('v1.0.0-beta.1', { prerelease: true })], 'stable'), null)
})

test('② resolveHeadlessChannel：beta 版本与 env 覆盖', () => {
  assert.equal(resolveHeadlessChannel('0.2.2'), 'stable')
  assert.equal(resolveHeadlessChannel('0.2.2-beta.3'), 'beta')
  assert.equal(resolveHeadlessChannel('0.2.2', { DSH_CHAMBER_UPDATE_CHANNEL: 'beta' }), 'beta')
  assert.equal(resolveHeadlessChannel('0.2.2', { DSH_CHAMBER_UPDATE_CHANNEL: 'stable' }), 'stable')
})

test('③ 初始态：idle + 原生壳 blocked reason + 通道', () => {
  const controller = createHeadlessUpdateController({ version: '0.2.2', logger })
  const state = controller.state()
  assert.equal(state.phase, 'idle')
  assert.equal(state.currentVersion, '0.2.2')
  assert.equal(state.channel, 'stable')
  assert.equal(state.installBlockedReason, NATIVE_SHELL_INSTALL_BLOCKED_REASON)
  assert.equal(state.latestVersion, null)
  assert.equal(state.releaseUrl, null)
  assert.equal(state.error, null)
})

test('④ 有更新 → available + releaseUrl（白名单通过）', async () => {
  const controller = createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request: fakeFetch([release('v0.2.2'), release('v0.2.3')]),
  })
  const result = await controller.checkNow()
  assert.deepEqual(result, { ok: true })
  const state = controller.state()
  assert.equal(state.phase, 'available')
  assert.equal(state.latestVersion, '0.2.3')
  assert.equal(state.releaseUrl, 'https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.2.3')
  assert.equal(isAllowedReleaseUrl(state.releaseUrl), true)
  assert.equal(state.installBlockedReason, NATIVE_SHELL_INSTALL_BLOCKED_REASON)
  assert.equal(state.error, null)
})

test('④ 无更新 → up-to-date（latestVersion/releaseUrl 清空）', async () => {
  const controller = createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request: fakeFetch([release('v0.2.2'), release('v0.2.1')]),
  })
  await controller.checkNow()
  const state = controller.state()
  assert.equal(state.phase, 'up-to-date')
  assert.equal(state.latestVersion, null)
  assert.equal(state.releaseUrl, null)
})

test('⑤ HTTP 失败 / 响应非数组 → error（不伪装成 up-to-date）', async () => {
  const failing = createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request: fakeFetch({}, { ok: false, status: 503 }),
  })
  await failing.checkNow()
  assert.equal(failing.state().phase, 'error')
  assert.match(failing.state().error ?? '', /HTTP 503/)

  const malformed = createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request: fakeFetch({ message: 'rate limited' }),
  })
  await malformed.checkNow()
  assert.equal(malformed.state().phase, 'error')
  assert.match(malformed.state().error ?? '', /invalid GitHub releases response/)
})

test('⑤ 不可比较的版本 → error（绝不猜）', async () => {
  const controller = createHeadlessUpdateController({
    version: 'not-semver',
    logger,
    request: fakeFetch([release('v0.2.3')]),
  })
  await controller.checkNow()
  assert.equal(controller.state().phase, 'error')
  assert.match(controller.state().error ?? '', /uncomparable/)
})

test('⑤ feed 三态：本通道暂无发布物 → up-to-date；形状全坏 → error（三审 #14）', async () => {
  // 全是 draft（版本可解析）→ 稳定通道确实还没有可升级发布物 → up-to-date。
  const allDrafts = createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request: fakeFetch([release('v9.9.9', { draft: true })]),
  })
  await allDrafts.checkNow()
  assert.equal(allDrafts.state().phase, 'up-to-date', '可解析但全 draft 不算 feed 异常')

  // 全是 beta → 稳定通道无候选（三审 #14：不再是 error 的 UX 翻转）。
  const allBeta = createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request: fakeFetch([release('v0.3.0-beta.1', { prerelease: true })]),
  })
  await allBeta.checkNow()
  assert.equal(allBeta.state().phase, 'up-to-date')

  // 非空但一个可解析版本都没有（tag 形状全坏）→ 响亮 error，绝不伪装最新。
  const malformed = createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request: fakeFetch([release('not-a-version'), release('latest'), release('v0.2')]),
  })
  await malformed.checkNow()
  assert.equal(malformed.state().phase, 'error')
  assert.match(malformed.state().error ?? '', /no usable release/)

  // 空列表 = 确实没有发布物 → up-to-date。
  const empty = createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request: fakeFetch([]),
  })
  await empty.checkNow()
  assert.equal(empty.state().phase, 'up-to-date')
})

test('⑥ download / restartAndInstall 核心层显式拒绝', async () => {
  const controller = createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request: fakeFetch([release('v0.2.3')]),
  })
  assert.deepEqual(await controller.download(), { ok: false, error: 'no update available' })
  await controller.checkNow()
  assert.deepEqual(await controller.download(), { ok: false, error: NATIVE_SHELL_DOWNLOAD_REFUSAL })
  assert.deepEqual(controller.restartAndInstall(), { ok: false, error: NATIVE_SHELL_RESTART_REFUSAL })
  // 拒绝后状态不变（仍是 available + 诚实 blocked 行）。
  assert.equal(controller.state().phase, 'available')
  assert.equal(controller.state().installBlockedReason, NATIVE_SHELL_INSTALL_BLOCKED_REASON)
})

test('⑦ subscribe 推送与退订；start() 不改状态', async () => {
  const seen: string[] = []
  const controller = createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request: fakeFetch([release('v0.2.3')]),
  })
  const dispose = controller.subscribe((state) => seen.push(state.phase))
  controller.start()
  assert.deepEqual(seen, [], 'start() 不排周期检查、不推送')
  assert.equal(controller.state().phase, 'idle')
  await controller.checkNow()
  assert.deepEqual(seen, ['checking', 'available'])
  dispose()
  await controller.checkNow()
  assert.deepEqual(seen, ['checking', 'available'], '退订后不再推送')
})

test('⑧ 渲染器侧 known reason 映射与本地化键锁步（跨包文本断言）', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const section = readFileSync(
    path.join(repoRoot, 'packages/dsh-chamber-client-ui-settings-bridge/src/client/UpdateSection.tsx'),
    'utf8')
  assert.ok(
    section.includes(`const NATIVE_SHELL_BLOCKED_REASON = '${NATIVE_SHELL_INSTALL_BLOCKED_REASON}'`),
    'UpdateSection 的 known reason 字面量必须与 update-headless.ts 的常量逐字一致')
  assert.ok(
    section.includes("t('updateAvailableBlockedNativeShell'")
      && section.includes("t('updateInstallBlockedNativeShell'"),
    'available/downloaded 两条 blocked 行都应使用原生壳本地化键')
  const locales = readFileSync(
    path.join(repoRoot, 'packages/dsh-chamber-client-ui-settings-bridge/src/locales.ts'),
    'utf8')
  for (const key of ['updateAvailableBlockedNativeShell', 'updateInstallBlockedNativeShell']) {
    // zh + en 两份（同一文件内两处键定义）。
    assert.equal(
      (locales.match(new RegExp(`${key}:`, 'g')) ?? []).length, 2,
      `locales.ts 应有 ${key} 的 zh/en 两处定义`)
  }
})
