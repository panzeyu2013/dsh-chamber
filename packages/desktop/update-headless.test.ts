/**
 * update-headless.test.ts —— Swift flavor 更新控制器单测（design 25 §7）
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
 *  ⑦ subscribe 推送与退订；start() 立即不改状态（首检在定时器上）；
 *  ⑨ 订阅者（宿主推送腿）抛错不反噬控制器：check 不卡死、二次检查仍推进；
 *  ⑩ start() 与 Electron 同节奏（15s 静默首检 + 6h 周期）、定时器 unref/幂等/
 *     stop 可停、失败轮不抛穿；
 *  ⑮/⑯ 发现单源：原生腿在场 → 零 GitHub 出网、恰一次 kind=check、页面
 *     checking → 壳推送结果、不排静默定时器；原生腿缺席 → 既有 GitHub 检查原样；
 *  ⑰ 坏配置：能力探测原因被记录、保持 blocked，check 落 error（不停 checking）。
 * 纯逻辑（无网络、无 Electron、无真实 timer 等待——⑩/⑮ 用假定时器注入）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAllowedReleaseUrl } from './updater.ts'
import {
  HEADLESS_CHECK_DELAY_MS,
  HEADLESS_CHECK_INTERVAL_MS,
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

  // 全是 beta → 稳定通道无候选。
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

test('⑦ subscribe 推送与退订；start() 立即不改状态（首检在 15s 定时器上）', async () => {
  const seen: string[] = []
  const controller = createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request: fakeFetch([release('v0.2.3')]),
  })
  const dispose = controller.subscribe((state) => seen.push(state.phase))
  controller.start()
  assert.deepEqual(seen, [], 'start() 不立即检查、不推送（首检在 15s 定时器上）')
  assert.equal(controller.state().phase, 'idle')
  await controller.checkNow()
  assert.deepEqual(seen, ['checking', 'available'])
  dispose()
  await controller.checkNow()
  assert.deepEqual(seen, ['checking', 'available'], '退订后不再推送')
})

test('⑧ 渲染器侧 known reason 映射与本地化键锁步（跨包文本断言）', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  // 字面量在纯模块 blocked-reason.ts（.tsx 无法被 node:test 直接 import），
  // 此处按该落位断言。
  const reasonModule = readFileSync(
    path.join(repoRoot, 'packages/dsh-chamber-client-ui-settings-bridge/src/client/blocked-reason.ts'),
    'utf8')
  assert.ok(
    reasonModule.includes(`export const NATIVE_SHELL_BLOCKED_REASON = '${NATIVE_SHELL_INSTALL_BLOCKED_REASON}'`),
    'blocked-reason.ts 的 known reason 字面量必须与 update-headless.ts 的常量逐字一致')
  const section = readFileSync(
    path.join(repoRoot, 'packages/dsh-chamber-client-ui-settings-bridge/src/client/UpdateSection.tsx'),
    'utf8')
  assert.ok(
    section.includes("t('updateAvailableBlockedNativeShell'")
      && section.includes("t('updateInstallBlockedNativeShell'"),
    'available/downloaded 两条 blocked 行都应使用原生壳本地化键')
  assert.ok(
    section.includes("from './blocked-reason.ts'"),
    'UpdateSection 必须从 blocked-reason.ts 取分类/字面量（单一来源）')
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

test('⑨ 订阅者抛错不反噬控制器：check 不卡死、二次检查仍推进（审查回归）', async () => {
  const controller = createHeadlessUpdateController({
    version: '0.3.1',
    logger,
    request: fakeFetch([release('v0.3.2')]),
  })
  const seen: string[] = []
  controller.subscribe((state) => {
    seen.push(state.phase)
    throw new Error('listener boom')
  })
  // 每个相位的 listener 抛错都只响亮记录，IPC 仍 resolve（首个 'checking' 推送
  // 若把异常抛穿 runCheck，checking 会卡死、后续检查永久 no-op）。
  await assert.doesNotReject(controller.checkNow())
  assert.deepEqual(seen, ['checking', 'available'], '推送照常推进（抛错不吞相位）')
  assert.equal(controller.state().phase, 'available')
  await controller.checkNow()
  assert.deepEqual(seen, ['checking', 'available', 'checking', 'available'], 'checking 必须复位')
})

test('⑩ start()：15s 静默首检 + 上游节奏（update-schedule 单一来源），unref/幂等/stop 可停；失败轮退避且不抛穿', async () => {
  // 2026-09 跟随上游：节奏收敛到 update-schedule.ts（600s 基准 ±20% 抖动 + 失败退避
  // 封顶 1h + DSH_DESKTOP_UPDATE_CHECK_* env）。两侧都必须从那里取，写死周期即红。
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
  const updaterSource = readFileSync(path.join(here, 'updater.ts'), 'utf8')
  const headlessSource = readFileSync(path.join(here, 'update-headless.ts'), 'utf8')
  for (const source of [updaterSource, headlessSource]) {
    assert.ok(source.includes("from './update-schedule.ts'"), '两边都必须用共享节奏模块')
    assert.ok(!/CHECK_INTERVAL_MS = \d/.test(source), '不得再写死周期常量')
  }
  assert.equal(HEADLESS_CHECK_DELAY_MS, 15_000)
  assert.equal(HEADLESS_CHECK_INTERVAL_MS, 600_000, '周期基准 = 上游默认 600s')
  interface TimerCall { fn: () => void; ms: number; unref: boolean }
  const timeouts: TimerCall[] = []
  const intervals: TimerCall[] = []
  const timeoutHandles: unknown[] = []
  const intervalHandles: unknown[] = []
  const clearedTimeouts: unknown[] = []
  const clearedIntervals: unknown[] = []
  const makeHandle = (call: TimerCall, sink: unknown[]): { unref(): void } => {
    const handle = { unref(): void { call.unref = true } }
    sink.push(handle)
    return handle
  }
  const realTimers = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
  }
  try {
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const call: TimerCall = { fn, ms: ms ?? 0, unref: false }
      timeouts.push(call)
      return makeHandle(call, timeoutHandles)
    }) as unknown as typeof setTimeout
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const call: TimerCall = { fn, ms: ms ?? 0, unref: false }
      intervals.push(call)
      return makeHandle(call, intervalHandles)
    }) as unknown as typeof setInterval
    globalThis.clearTimeout = ((handle: unknown) => { clearedTimeouts.push(handle) }) as unknown as typeof clearTimeout
    globalThis.clearInterval = ((handle: unknown) => { clearedIntervals.push(handle) }) as unknown as typeof clearInterval

    let requests = 0
    const request = (async () => {
      requests += 1
      if (requests === 2) throw new Error('network down')
      return { ok: true, status: 200, json: async () => [release('v0.2.3')] }
    }) as unknown as typeof fetch

    // A：start() 排定两枚定时器后立即 stop() → 两枚句柄都必须被清掉，且零出网。
    const stopped = createHeadlessUpdateController({ version: '0.2.2', logger, request })
    stopped.start()
    assert.equal(timeouts.length, 1, 'start() 恰排一枚 15s 静默首检')
    assert.equal(timeouts[0]?.ms, HEADLESS_CHECK_DELAY_MS, '首检延迟必须与 Electron CHECK_DELAY_MS 同值')
    assert.equal(timeouts[0]?.unref, true, '首检定时器必须 unref（不阻止进程退出）')
    assert.equal(intervals.length, 0, '自排程：不再 setInterval')
    assert.equal(requests, 0, 'start() 本身不出网（首检在 15s 定时器上）')
    assert.equal(stopped.state().phase, 'idle')
    stopped.start()
    assert.equal(timeouts.length, 1, 'start() 幂等：不叠加首检定时器')
    stopped.stop()
    assert.ok(clearedTimeouts.includes(timeoutHandles[0]), 'stop() 必须 clearTimeout 首检句柄')

    // B：定时器到点走真实受控检查路径——首检成功、周期失败折 error（绝不抛穿）。
    const controller = createHeadlessUpdateController({ version: '0.2.2', logger, request })
    controller.start()
    const initial = timeouts[1]!
    initial.fn()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(requests, 1, '首检在 15s 到点后才出网')
    assert.equal(controller.state().phase, 'available')
    // 最后一次排程 = 首检完成后的静默检查（检查内部的请求超时定时器在它之前）。
    const firstSchedule = timeouts[timeouts.length - 1]!
    assert.ok(firstSchedule.ms >= 600_000 * 0.8 - 1 && firstSchedule.ms <= 600_000 * 1.2 + 1,
      '成功后延迟必须是 600s 基准 ±20% 抖动（实际 ' + firstSchedule.ms + '）')
    firstSchedule.fn()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(requests, 2)
    assert.equal(controller.state().phase, 'error', '失败轮折叠为 error 态（绝不 reject/抛穿定时器）')
    const backoffSchedule = timeouts[timeouts.length - 1]!
    assert.ok(backoffSchedule.ms >= 1_200_000 * 0.8 - 1 && backoffSchedule.ms <= 1_200_000 * 1.2 + 1,
      '失败后退避必须 ×2（1200s 基准 ±20%，实际 ' + backoffSchedule.ms + '）')
    controller.stop()
    controller.stop() // 幂等：再次 stop 不抛
  } finally {
    globalThis.setTimeout = realTimers.setTimeout
    globalThis.setInterval = realTimers.setInterval
    globalThis.clearTimeout = realTimers.clearTimeout
    globalThis.clearInterval = realTimers.clearInterval
  }
})

test('⑪ 原生更新器可用：start() 清空 installBlockedReason；check/available/download/downloaded 后 restart 转发', async () => {
  const calls: string[] = []
  const controller = createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request: fakeFetch([release('v0.2.3')]),
    nativeUpdater: {
      async available() { return { available: true } },
      async trigger(kind: 'check' | 'download' | 'install') { calls.push(kind); return { ok: true as const } },
    },
  })
  assert.equal(controller.state().installBlockedReason, NATIVE_SHELL_INSTALL_BLOCKED_REASON)
  controller.start()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(controller.state().installBlockedReason, null, '原生可用 → 不再谎称 blocked')
  // 相位门（冻结语义「绝不二次下载」）：没有已发现的更新时绝不转发壳。
  assert.deepEqual(await controller.download(), { ok: false, error: 'no update available' })
  // 未下载完成（available）时「重启并安装」也不得转发（与 Electron 同门）。
  assert.deepEqual(await controller.restartAndInstallAsync!(), { ok: false, error: NATIVE_SHELL_RESTART_REFUSAL })
  // 检查经冻结边 kind=check 交壳（不走 GitHub）；壳推送 available。
  await controller.checkNow()
  assert.deepEqual(calls, ['check'], '检查恰发一次 kind=check')
  assert.equal(controller.state().phase, 'checking', '终态等壳的 __host.nativeUpdatePhase，不自行判定')
  controller.applyNativePhase({ phase: 'available', version: '0.2.3', error: null })
  assert.equal(controller.state().phase, 'available')
  assert.deepEqual(await controller.download(), { ok: true })
  // 原生窗口的下载完成阶段由壳推送 → 这时才允许重启并安装。
  controller.applyNativePhase({ phase: 'downloaded', version: '0.2.3', error: null })
  assert.equal(controller.state().phase, 'downloaded')
  assert.deepEqual(await controller.restartAndInstallAsync!(), { ok: true })
  assert.deepEqual(calls, ['check', 'download', 'install'], '转发顺序与 kind 原样')
  controller.stop()
})

test('⑬ applyNativePhase：八个原生相位折进同一 UpdateState 投影（S-19/S-21）', () => {
  const nativeUpdater = {
    async available() { return { available: false } },
    async trigger(_kind: 'check' | 'download' | 'install') { return { ok: false as const, error: 'never' } },
  }
  const controller = createHeadlessUpdateController({
    version: '0.2.2', logger, request: fakeFetch([release('v0.2.3')]), nativeUpdater,
  })
  const seen: string[] = []
  controller.subscribe((state) => seen.push(state.phase))
  // 任何时候的原生阶段都必须清空 blocked reason（冻结语义：已配置的 Sparkle
  // 绝不被降级为 unavailable——即便能力探测失败/未返回）。
  controller.applyNativePhase({ phase: 'downloading', version: '0.2.3', error: null })
  assert.equal(controller.state().phase, 'downloading')
  assert.equal(controller.state().downloadPercent, null, '原生下载无百分比 → null（页面用不定量文案）')
  assert.equal(controller.state().installBlockedReason, null, '原生阶段证明 Sparkle 已配置')
  controller.applyNativePhase({ phase: 'checking', version: null, error: null })
  assert.equal(controller.state().phase, 'checking')
  controller.applyNativePhase({ phase: 'available', version: '0.2.3', error: null })
  assert.equal(controller.state().phase, 'available')
  assert.equal(controller.state().latestVersion, '0.2.3')
  assert.equal(controller.state().releaseUrl, 'https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.2.3')
  assert.equal(isAllowedReleaseUrl(controller.state().releaseUrl), true)
  controller.applyNativePhase({ phase: 'downloaded', version: '0.2.3', error: null })
  assert.equal(controller.state().phase, 'downloaded')
  assert.equal(controller.state().downloadPercent, 100)
  controller.applyNativePhase({ phase: 'installing', version: '0.2.3', error: null })
  assert.equal(controller.state().phase, 'installing')
  assert.equal(controller.state().downloadPercent, 100)
  controller.applyNativePhase({ phase: 'failed', version: '0.2.3', error: 'Cannot read /Users/example/Library/Caches/dsh-chamber-updater/x' })
  assert.equal(controller.state().phase, 'error')
  assert.equal(controller.state().latestVersion, '0.2.3', '下载失败保留版本（重试行）')
  // 与 Electron 的 error 面同一 sanitize（绝对路径 → [path]，非秘密投影）。
  assert.equal(controller.state().error, 'Cannot read [path]')
  controller.applyNativePhase({ phase: 'failed', version: null, error: null })
  assert.equal(controller.state().error, 'native updater failed', '缺 error 文案时用稳定兜底串')
  controller.applyNativePhase({ phase: 'up-to-date', version: null, error: null })
  assert.equal(controller.state().phase, 'up-to-date')
  assert.equal(controller.state().latestVersion, null)
  assert.equal(controller.state().releaseUrl, null)
  controller.applyNativePhase({ phase: 'idle', version: null, error: null })
  assert.equal(controller.state().phase, 'idle')
  assert.deepEqual(seen, [
    'downloading', 'checking', 'available', 'downloaded', 'installing',
    'error', 'error', 'up-to-date', 'idle',
  ], '每个原生阶段都必须经 subscribe 推送（页面/壳单一来源）')
})

test('⑭ 冻结语义：downloading/downloaded/installing 在飞时绝不二次下载/安装，安装中不重查', async () => {
  const calls: string[] = []
  let requests = 0
  const controller = createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request: (async () => { requests += 1; return { ok: true, status: 200, json: async () => [release('v0.2.3')] } }) as unknown as typeof fetch,
    nativeUpdater: {
      async available() { return { available: true } },
      async trigger(kind: 'check' | 'download' | 'install') { calls.push(kind); return { ok: true as const } },
    },
  })
  controller.applyNativePhase({ phase: 'available', version: '0.2.3', error: null })
  assert.deepEqual(await controller.download(), { ok: true })
  assert.deepEqual(calls, ['download'])
  // 下载在飞：再点「更新」明确拒绝，绝不转发（第二次下载）。
  controller.applyNativePhase({ phase: 'downloading', version: '0.2.3', error: null })
  assert.deepEqual(await controller.download(), { ok: false, error: 'download already in progress' })
  // 已下载/安装中同样拒绝；安装中「重启并安装」也拒绝。
  controller.applyNativePhase({ phase: 'downloaded', version: '0.2.3', error: null })
  assert.deepEqual(await controller.download(), { ok: false, error: 'download already in progress' })
  controller.applyNativePhase({ phase: 'installing', version: '0.2.3', error: null })
  assert.deepEqual(await controller.download(), { ok: false, error: 'download already in progress' })
  assert.deepEqual(await controller.restartAndInstallAsync!(), { ok: false, error: 'restart already in progress' })
  assert.deepEqual(calls, ['download'], '在飞阶段零额外触发')
  // 安装中重查也不得打回 checking / 出网。
  await controller.checkNow()
  assert.equal(requests, 0, '安装中的检查必须是 no-op（不出网）')
  assert.equal(controller.state().phase, 'installing')
})

test('⑫ 原生腿已声明但不可用/探测失败：check 仍交壳（绝不出网），保持 blocked-available 且不转发下载', async () => {
  const calls: string[] = []
  let requests = 0
  const request = (async () => {
    requests += 1
    return { ok: true, status: 200, json: async () => [release('v0.2.3')] }
  }) as unknown as typeof fetch
  // 壳在不可用时对 updateNativeAction 的诚实应答（SwiftEdgeHostLegs：
  // guard isAvailable else "native-updater-unavailable"）。
  const bridge = (available: () => Promise<{ available: boolean; error?: string | null }>) => ({
    available,
    async trigger(kind: 'check' | 'download' | 'install') {
      calls.push(kind)
      return { ok: false as const, error: 'native-updater-unavailable' }
    },
  })
  const unavailable = createHeadlessUpdateController({
    version: '0.2.2', logger, request,
    nativeUpdater: bridge(async () => ({ available: false })),
  })
  unavailable.start()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(unavailable.state().installBlockedReason, NATIVE_SHELL_INSTALL_BLOCKED_REASON, '探测 false 不得清空 blocked')
  await unavailable.checkNow()
  // 无回退：壳拒绝就是终态（响亮 error），绝不跑 GitHub 发现给出相反结论。
  assert.equal(unavailable.state().phase, 'error')
  assert.equal(unavailable.state().error, 'native-updater-unavailable')
  assert.equal(requests, 0, 'S-21：声明过原生腿后绝不跑 GitHub releases 发现')
  // 壳拒绝后没有已知更新 + blocked reason 仍在 → download 连原生门都进不了
  // （不是「原生壳不支持自动安装」那条 blocked 文案：确实没有可下载的更新）。
  assert.deepEqual(await unavailable.download(), { ok: false, error: 'no update available' })
  assert.deepEqual(await unavailable.restartAndInstallAsync!(), { ok: false, error: NATIVE_SHELL_RESTART_REFUSAL })

  const broken = createHeadlessUpdateController({
    version: '0.2.2', logger, request,
    nativeUpdater: bridge(async () => { throw new Error('pipe closed') }),
  })
  broken.start()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(broken.state().installBlockedReason, NATIVE_SHELL_INSTALL_BLOCKED_REASON, '探测失败不得清空 blocked')
  await broken.checkNow()
  assert.equal(broken.state().phase, 'error', '探测失败也不回退 GitHub：check 仍只发壳边')
  assert.equal(requests, 0, '探测失败同样零出网')
  assert.deepEqual(calls, ['check', 'check'], '两次检查恰两次边调用（不重复、不回退）')
  unavailable.stop(); broken.stop()
})

test('⑮ S-21 提交形态：原生腿在场 → 零 GitHub 出网、恰一次 kind=check、页面 checking → 壳结果，且不排静默定时器', async () => {
  const calls: string[] = []
  let requests = 0
  const request = (async () => {
    requests += 1
    throw new Error('S-21 违反：原生腿在场时不得跑 GitHub releases 查询')
  }) as unknown as typeof fetch
  const controller = createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request,
    nativeUpdater: {
      async available() { return { available: true } },
      async trigger(kind: 'check' | 'download' | 'install') { calls.push(kind); return { ok: true as const } },
    },
  })
  // 假定时器：原生腿在场时 start() 必须零排程（不排静默 GitHub 检查；Sparkle 的
  // 用户发起窗口绝不能被定时调用打开）。
  const realSetTimeout = globalThis.setTimeout
  const realSetInterval = globalThis.setInterval
  const scheduled: number[] = []
  try {
    globalThis.setTimeout = ((_fn: () => void, ms?: number) => {
      scheduled.push(ms ?? 0)
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    globalThis.setInterval = ((_fn: () => void, ms?: number) => {
      scheduled.push(ms ?? 0)
      return { unref() {} } as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof setInterval

  controller.start()
  await Promise.resolve(); await Promise.resolve()
    assert.equal(controller.state().installBlockedReason, null, '能力探测可用 → blocked 清空')
    assert.deepEqual(scheduled, [], 'S-21：原生腿在场时不排 15s 首检 / 6h 周期')

    const seen: string[] = []
    controller.subscribe((state) => seen.push(state.phase))
    await controller.checkNow()
    assert.equal(requests, 0, '页面「检查更新」绝不跑自己的 GitHub 发现')
    assert.deepEqual(calls, ['check'], '冻结边 updateNativeAction kind=check 恰一次')
    assert.equal(controller.state().phase, 'checking', '点下即呈现 checking（等壳结果）')
    assert.deepEqual(seen, ['checking'])
    // 壳推送终态 → 页面渲染壳的结果（available + 白名单 releaseUrl）。
    controller.applyNativePhase({ phase: 'available', version: '0.2.3', error: null })
    assert.equal(controller.state().phase, 'available')
    assert.equal(controller.state().releaseUrl, 'https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.2.3')
    assert.deepEqual(seen, ['checking', 'available'])
    // 再点一次仍是单源：一次新边调用，零出网。
    await controller.checkNow()
    controller.applyNativePhase({ phase: 'up-to-date', version: null, error: null })
    assert.equal(controller.state().phase, 'up-to-date')
    assert.deepEqual(calls, ['check', 'check'])
    assert.equal(requests, 0)
    controller.stop()
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.setInterval = realSetInterval
  }
})

test('⑯ S-21 对照：原生腿缺席 → 既有 GitHub releases 检查原样（feed 的唯一来源）', async () => {
  let requests = 0
  const controller = createHeadlessUpdateController({
    version: '0.2.2',
    logger,
    request: (async (url: string) => {
      requests += 1
      assert.equal(url, 'https://api.github.com/repos/panzeyu2013/dsh-chamber/releases?per_page=100')
      return { ok: true, status: 200, json: async () => [release('v0.2.2'), release('v0.2.3')] }
    }) as unknown as typeof fetch,
  })
  assert.equal(controller.state().installBlockedReason, NATIVE_SHELL_INSTALL_BLOCKED_REASON)
  await controller.checkNow()
  assert.equal(requests, 1, '无原生腿：GitHub 检查照旧（该形态的 feed 来源，不是回退）')
  assert.equal(controller.state().phase, 'available')
  assert.equal(controller.state().latestVersion, '0.2.3')
})

test('⑰ S-38 坏配置：能力探测原因必须记录、保持 blocked，check 落 error 而非停在 checking', async () => {
  const reason = 'native-updater-misconfigured:SUPublicEDKey 必须是 base64 编码的 32 字节 Ed25519 公钥'
  const warns: string[] = []
  const controller = createHeadlessUpdateController({
    version: '0.2.2',
    logger: {
      log: () => {},
      warn: (...args: unknown[]) => warns.push(args.map((value) => String(value)).join(' ')),
      error: () => {},
    },
    request: fakeFetch([release('v0.2.3')]),
    nativeUpdater: {
      // 壳的诚实能力回执（SwiftEdgeHostLegs：{available:false, error}）。
      async available() { return { available: false, error: reason } },
      async trigger() { return { ok: false as const, error: reason } },
    },
  })
  controller.start()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(controller.state().installBlockedReason, NATIVE_SHELL_INSTALL_BLOCKED_REASON,
    '坏配置不得被当作可用（installBlockedReason 保持）')
  assert.ok(warns.some((line) => line.includes('SUPublicEDKey 必须是 base64 编码的 32 字节 Ed25519 公钥')),
    '能力探测的真实原因必须被记录，不能只剩一个没有理由的 false')
  await controller.checkNow()
  assert.equal(controller.state().phase, 'error',
    '壳拒绝 → 页面诚实 error 相位（旧实现停在 checking）')
  assert.equal(controller.state().error, reason, '错误文案 = 壳的真实原因（sanitize 后不变）')
  controller.stop()
})


// --- 2026-12 复审方向 A：headless nudge 门反 / stop 终局 / 启动日志（A4/A7/A9） ---

/** 捕获 setTimeout 调用（不真正排程）：用例按记录的 ms/fn 手动驱动。 */
function captureHeadlessTimeouts(): { calls: { fn: () => void; ms: number }[]; restore: () => void } {
  const calls: { fn: () => void; ms: number }[] = []
  const real = globalThis.setTimeout
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    calls.push({ fn, ms: ms ?? 0 })
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  return { calls, restore: () => { globalThis.setTimeout = real } }
}

async function flushHeadlessAsync(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** 记录日志行的最小 logger（warn/error 也被收进同一条流便于断言）。 */
function recordingLogger(lines: string[]): {
  log: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
} {
  const push = (...args: unknown[]): void => { lines.push(args.map((value) => String(value)).join(' ')) }
  return { log: push, warn: push, error: push }
}

test('A4 回归：noteActivity 到点后必须触发检查（与 Electron 同语义：elapsed < interval 才 return）', async () => {
  const lines: string[] = []
  let requests = 0
  const request = (async () => {
    requests += 1
    return { ok: true, status: 200, json: async () => [] }
  }) as unknown as typeof fetch
  const controller = createHeadlessUpdateController({
    version: '0.2.2',
    logger: recordingLogger(lines),
    request,
    // 1s 周期（env 下限）：本用例真的等一次「到点」。
    env: { DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '1000' },
    random: () => 0.5,
  })
  controller.start()
  try {
    // 首检定时器（15s）仍挂着；「最后一次完成检查」为空 → nudge 必须立刻检查。
    // 修复前门是写反的（scheduleTimer === null && elapsed < interval 才查），
    // 定时器在挂 → 永不触发，headless nudge 形同虚设。
    controller.noteActivity('resume')
    await flushHeadlessAsync()
    assert.equal(requests, 1, 'resume nudge 必须触发一次静默检查（修复前 requests 停在 0）')
    assert.ok(lines.some((line) => line.includes('前台/唤醒触发静默检查（resume）')),
      'nudge 必须留日志')
    assert.equal(controller.state().phase, 'up-to-date')

    // 刚查完（elapsed < interval）→ nudge 必须被合并，不重复检查。
    controller.noteActivity('focus')
    await flushHeadlessAsync()
    assert.equal(requests, 1, 'elapsed < interval 的 nudge 必须合并')

    // 超过一个 interval → nudge 必须再次检查（假时钟推 elapsed，不真等 15s 首检/周期）。
    const realNow = Date.now
    Date.now = () => realNow() + 5_000
    try {
      controller.noteActivity('focus')
      await flushHeadlessAsync()
    } finally {
      Date.now = realNow
    }
    assert.equal(requests, 2, 'elapsed >= interval 后 nudge 必须再次检查')
  } finally {
    controller.stop()
  }
})

test('A7 回归：stop() 是终局——在飞的 runScheduledCheck 结算后不得再 arm，start() 不得复活', async () => {
  const timers = captureHeadlessTimeouts()
  try {
    let settleRequest = null as ((value: unknown) => void) | null
    let requests = 0
    const request = (() => {
      requests += 1
      return new Promise((resolve) => { settleRequest = resolve })
    }) as unknown as typeof fetch
    const controller = createHeadlessUpdateController({ version: '0.2.2', logger, request })
    controller.start()
    assert.equal(timers.calls.filter((call) => call.ms === 15_000).length, 1, 'start() 恰排一枚 15s 首检')
    timers.calls[0]!.fn() // 首检到点：runScheduledCheck 在飞（fetch 未结算）
    await flushHeadlessAsync()
    assert.equal(requests, 1)
    controller.stop() // sidecar 退出路径：停表 + 终局
    settleRequest?.({ ok: true, status: 200, json: async () => [] })
    await flushHeadlessAsync()
    // 修复前：stop() 只清了当前 timer，在飞的检查完成后仍 arm 下一轮（≈600s）。
    // 只数 >60s 的排程：检查内部的 fetch 超时定时器（10s）不是排程。
    assert.equal(timers.calls.filter((call) => call.ms > 60_000).length, 0,
      'stop() 后结算的检查不得再 arm（修复前这里会排下一轮）')
    assert.equal(controller.state().phase, 'up-to-date', '结算本身照常落相位')
    controller.start()
    assert.equal(timers.calls.filter((call) => call.ms > 60_000).length, 0, 'stop() 终局：start() 不得复活定时器')
  } finally {
    timers.restore()
  }
})

test('A9 回归：启动日志用分钟表述（±jitter% + 退避封顶），不再打印小时分数', () => {
  const logs: string[] = []
  const controller = createHeadlessUpdateController({
    version: '0.2.2',
    logger: recordingLogger(logs),
    request: fakeFetch([]),
    env: {},
  })
  controller.start()
  controller.stop()
  const line = logs.find((entry) => entry.includes('更新检查已启动'))
  assert.ok(line, 'start() 必须打印启动日志')
  // 修复前打印 HEADLESS_CHECK_INTERVAL_MS / 3_600_000 = 0.16666666666666666h。
  assert.match(line!, /15s 后首次检查，之后每 10min ±20%，失败退避封顶 60min/,
    '启动日志必须与 Electron 同款分钟表述（实际：' + line + '）')
  assert.ok(!line!.includes('h）'), '不得再打印小时分数：' + line)

  // env 覆盖后同样按分钟表述。
  const overriddenLogs: string[] = []
  const overridden = createHeadlessUpdateController({
    version: '0.2.2',
    logger: recordingLogger(overriddenLogs),
    request: fakeFetch([]),
    env: { DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '120000' },
  })
  overridden.start()
  overridden.stop()
  const overriddenLine = overriddenLogs.find((entry) => entry.includes('更新检查已启动'))
  assert.match(overriddenLine!, /之后每 2min ±20%，失败退避封顶 60min/,
    'env 覆盖的周期同样按分钟表述（实际：' + overriddenLine + '）')
})
