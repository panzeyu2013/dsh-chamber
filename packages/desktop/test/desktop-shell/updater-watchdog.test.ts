/**
 * updater.ts (design 11) unit tests — part 4: the idle watchdogs added by the
 * 2026-12 P0 work (台账 §8.a) — a check or download that goes silent becomes a
 * NAMED failure ('check-network' / 'download-network') instead of an endless
 * checking/downloading phase. electron-updater cannot be aborted, so a late
 * result from an abandoned attempt is handled explicitly.
 *
 * Sibling parts: updater.test.ts, updater-restart-install.test.ts,
 * updater-cache-maintenance.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeController, waitFor } from '../support/updater-harness.ts'

test('检查看门狗：feed 无响应 → check-network 命名失败，且迟到事件不复活旧检查', async () => {
  const { fake, controller } = makeController({ deps: { updateIdleTimeoutMs: 40 } })
  fake.checkResult = new Promise(() => {}) // 永不 settle = feed 静默
  void controller.checkNow() // 不 await：该检查永远不会自己完成
  assert.equal(await waitFor(() => controller.state().phase === 'error'), true, '超时后必须离开 checking')
  const stalled = controller.state()
  assert.equal(stalled.failureKind, 'check-network')
  assert.match(stalled.error ?? '', /timed out after/)
  assert.equal(stalled.latestVersion, null)

  // 被放弃那次的迟到事件不得改写结果。
  fake.emit('update-available', { version: '9.9.9' })
  fake.emit('update-not-available')
  assert.equal(controller.state().phase, 'error', '超时检查的迟到事件必须被忽略')
  assert.equal(controller.state().latestVersion, null)

  // 下一次检查恢复正常（抑制只作用于被放弃的那一次）。
  fake.checkResult = Promise.resolve({})
  const next = controller.checkNow()
  fake.emit('update-available', { version: '9.9.9' })
  await next
  assert.equal(controller.state().phase, 'available')
  assert.equal(controller.state().latestVersion, '9.9.9')
  assert.equal(controller.state().failureKind, undefined, '新检查不得携带旧失败分类')
})

test('下载看门狗：有进展不误杀，静默后按 idle 判 download-network', async () => {
  const { fake, controller } = makeController({ deps: { updateIdleTimeoutMs: 400 } })
  fake.emit('update-available', { version: '9.9.9' })
  fake.downloadResult = new Promise(() => {}) // 下载不返回，只有 progress 事件在动
  void controller.download()
  for (let index = 0; index < 4; index += 1) {
    fake.emit('download-progress', { percent: 10 * index })
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(controller.state().phase, 'downloading', '有进展的下载不得被判停滞')
  assert.equal(await waitFor(() => controller.state().phase === 'error', 120), true, '静默超过 idle 必须失败')
  assert.equal(controller.state().failureKind, 'download-network')
  assert.match(controller.state().error ?? '', /stalled for/)
})

test('下载看门狗：判停滞之后迟到的完成被接受（不隐藏真实成功）', async () => {
  const { fake, controller } = makeController({ deps: { updateIdleTimeoutMs: 40 } })
  fake.emit('update-available', { version: '9.9.9' })
  fake.downloadResult = new Promise(() => {})
  void controller.download()
  assert.equal(await waitFor(() => controller.state().phase === 'error'), true)
  fake.emit('update-downloaded', { version: '9.9.9' })
  assert.equal(controller.state().phase, 'downloaded', '迟到但真实的下载完成必须被接受')
  assert.equal(controller.state().latestVersion, '9.9.9')
})

test('看门狗不干扰正常路径：立即完成的检查与下载照常落相位', async () => {
  const { fake, controller } = makeController({ deps: { updateIdleTimeoutMs: 30_000 } })
  fake.checkResult = Promise.resolve({})
  await controller.checkNow()
  fake.emit('update-available', { version: '9.9.9' })
  fake.downloadResult = Promise.resolve({})
  await controller.download()
  fake.emit('download-progress', { percent: 55 })
  fake.emit('update-downloaded', { version: '9.9.9' })
  await waitFor(() => false, 1) // 让事件同步落地
  assert.equal(controller.state().phase, 'downloaded')
  assert.equal(controller.state().downloadPercent, 100)
  assert.equal(controller.state().failureKind, undefined)
})

test('下载看门狗：停滞判定后恢复必须撤回判定，且仍是受看门狗保护的（回归：复活后无人看表）', async () => {
  const { fake, controller } = makeController({ deps: { updateIdleTimeoutMs: 120 } })
  fake.emit('update-available', { version: '9.9.9' })
  fake.downloadResult = new Promise(() => {})
  void controller.download()
  assert.equal(await waitFor(() => controller.state().phase === 'error'), true)
  assert.equal(controller.state().failureKind, 'download-network')
  // 未中止的下载又发来分片：相位必须如实恢复且失败分类被清掉。
  fake.emit('download-progress', { percent: 42 })
  assert.equal(controller.state().phase, 'downloading')
  assert.equal(controller.state().downloadPercent, 42)
  assert.equal(controller.state().failureKind, undefined)
  // 恢复之后再次静默：必须**再次**被判停滞（计时器从未停表）。
  assert.equal(await waitFor(() => controller.state().phase === 'error', 120), true,
    '恢复后的再次静默必须重新落 error——否则页面会永远停在 downloading')
  assert.equal(controller.state().failureKind, 'download-network')
})


// --- 2026-12 复审方向 A / C：静默链、start 幂等与停滞待决（A2/A3/A6/C2） ---

/** 捕获 setTimeout 调用（不真正排程）：用例按记录的 ms/fn 手动驱动。
 *  注意：捕获期间不得再调用 waitFor（它内部依赖 setTimeout）。 */
function captureTimeouts(): { calls: { fn: () => void; ms: number }[]; restore: () => void } {
  const calls: { fn: () => void; ms: number }[] = []
  const real = globalThis.setTimeout
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    calls.push({ fn, ms: ms ?? 0 })
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  return { calls, restore: () => { globalThis.setTimeout = real } }
}

/** 推进若干宏任务让 await 链落定（绝不依赖被捕获的 setTimeout）。 */
async function flushAsync(times = 2): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

test('A2 回归：checkForUpdates 永不 settle 时看门狗超时必须让 runCheck 返回，静默链继续排下一轮', async () => {
  const { fake, controller } = makeController({
    deps: { updateIdleTimeoutMs: 40 },
    env: {
      DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '1000',
      DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS: '1000',
      DSH_DESKTOP_UPDATE_CHECK_JITTER: '0',
    },
  })
  fake.checkResult = new Promise(() => {}) // 永不 settle = electron-updater 对 in-flight check 去重
  controller.start() // 首检排 15s（unref 真实定时器，本用例不等到点）
  controller.noteActivity('focus') // 立即走同一条 runScheduledCheck 腿
  assert.equal(await waitFor(() => fake.checkCalls === 1), true)
  assert.equal(await waitFor(() => controller.state().phase === 'error'), true, '看门狗必须落 check-network')
  assert.equal(controller.state().failureKind, 'check-network')
  // 修复前：runScheduledCheck 卡在 await runCheck()（checkForUpdates 永不 settle），
  // 下一轮永不 arm → checkCalls 永远停在 1（静默链死）。
  assert.equal(await waitFor(() => fake.checkCalls >= 2, 250), true,
    '超时后 runCheck 必须返回，runScheduledCheck 必须继续排下一轮（修复前此处红）')
})

test('A2 回归：永不 settle 的检查不得让 checkNow 永久挂起，被放弃 promise 的迟到 reject 不得反噬', async () => {
  const { fake, controller } = makeController({ deps: { updateIdleTimeoutMs: 40 } })
  let rejectLate = null as ((error: Error) => void) | null
  fake.checkResult = new Promise((_resolve, reject) => { rejectLate = reject })
  const outcome = await Promise.race([
    controller.checkNow().then((value) => ({ kind: 'resolved' as const, value })),
    new Promise<{ kind: 'hung' }>((resolve) => setTimeout(() => resolve({ kind: 'hung' }), 3000)),
  ])
  assert.deepEqual(outcome, { kind: 'resolved', value: { ok: true } },
    '看门狗超时后 runCheck 必须返回（修复前 checkNow 永久挂起）')
  assert.equal(controller.state().phase, 'error')
  assert.equal(controller.state().failureKind, 'check-network')
  // 被放弃 promise 的迟到 reject：必须被 no-op catch 消费（默认
  // --unhandled-rejections=throw 下，未处理拒绝会直接打崩测试进程）。
  rejectLate?.(new Error('late boom'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(controller.state().phase, 'error', '迟到 reject 不得改写状态')
})

test('A3 回归：到点的静默检查撞上在飞下载时必须重排一轮，不得吃掉静默链', async () => {
  const timers = captureTimeouts()
  try {
    const { fake, controller } = makeController({ deps: { updateIdleTimeoutMs: 30_000 } })
    fake.checkResult = Promise.resolve({})
    controller.start()
    assert.equal(timers.calls.length, 1, 'start() 恰排一枚 15s 首检')
    assert.equal(timers.calls[0]!.ms, 15_000)
    // 首检到点并完成 → 排下一轮；runCheck 内部的 watchdog 也是 setTimeout，会占位。
    timers.calls[0]!.fn()
    await flushAsync()
    assert.equal(fake.checkCalls, 1)
    const periodic = timers.calls[timers.calls.length - 1]!
    assert.ok(periodic.ms >= 480_000 && periodic.ms <= 720_000,
      '首检成功后必须排 600s 基准 ±20% 抖动（实际 ' + periodic.ms + '）')

    // 用户在周期内点「更新」：下载在飞，相位 downloading。
    fake.emit('update-available', { version: '9.9.9' })
    let settleDownload = null as ((value: unknown) => void) | null
    fake.downloadResult = new Promise((resolve) => { settleDownload = resolve })
    void controller.download()
    fake.emit('download-progress', { percent: 5 })
    assert.equal(controller.state().phase, 'downloading')

    // 周期到点：runCheck 因 downloadInFlight / 相位 downloading 早退——本轮没跑成。
    const before = timers.calls.length
    periodic.fn()
    await flushAsync()
    assert.equal(fake.checkCalls, 1, '下载在飞时不得并发重查')
    // 修复前：runScheduledCheck 看到相位 downloading 直接 return，不 arm → 链死。
    assert.equal(timers.calls.length, before + 1,
      '本轮没跑成（下载在飞）必须仍排一轮 interval——修复前此处不 arm，静默链死')
    assert.ok(timers.calls[before]!.ms >= 480_000 && timers.calls[before]!.ms <= 720_000,
      '重排必须是一轮 interval（实际 ' + timers.calls[before]!.ms + '）')

    // 下载随后失败（底层 promise 也结算）→ 曾重排的一轮必须真的还能跑：链活着。
    fake.emit('error', new Error('download boom'))
    settleDownload?.({})
    await flushAsync()
    assert.equal(controller.state().phase, 'error')
    timers.calls[before]!.fn()
    await flushAsync()
    assert.equal(fake.checkCalls, 2, '碰撞轮之后静默链必须还活着（修复前停在 1）')
  } finally {
    timers.restore()
  }
})

test('A6 回归：start() 幂等——重复调用不重复挂焦点监听、不重置 15s 首检', () => {
  const timers = captureTimeouts()
  try {
    const focusEvents: string[] = []
    const app = {
      isPackaged: false,
      on(event: string) { focusEvents.push(event) },
      removeListener() {},
    }
    const { controller } = makeController({ deps: { app } })
    controller.start()
    controller.start()
    controller.start()
    assert.equal(focusEvents.filter((event) => event === 'browser-window-focus').length, 1,
      '重复 start() 不得重复 attach focus 监听（修复前 3 次）')
    assert.equal(timers.calls.length, 1, '重复 start() 不得重置/叠加 15s 首检')
    assert.equal(timers.calls[0]!.ms, 15_000)
  } finally {
    timers.restore()
  }
})

test('C2 回归：停滞判定不得放开检查排除——迟到的 update-not-available 不得覆盖 downloaded', async () => {
  const { fake, controller } = makeController({ deps: { updateIdleTimeoutMs: 120 } })
  fake.emit('update-available', { version: '9.9.9' })
  fake.downloadResult = new Promise(() => {}) // 底层 downloadUpdate() 仍在飞（无法中止）
  void controller.download()
  assert.equal(await waitFor(() => controller.state().phase === 'error'), true, '停滞必须落 error')
  assert.equal(controller.state().failureKind, 'download-network')
  // 修复前：停滞判定把 downloadInFlight 释放成 false，runCheck 门全开 → 这里会真起一次检查。
  const checksBefore = fake.checkCalls
  await controller.checkNow()
  assert.equal(fake.checkCalls, checksBefore,
    '停滞待决期间检查必须继续被排除（修复前此处 checkCalls 增长）')
  // 迟到的真实完成：相位必须落 downloaded 并保住 latestVersion。
  fake.emit('update-downloaded', { version: '9.9.9' })
  assert.equal(controller.state().phase, 'downloaded')
  assert.equal(controller.state().latestVersion, '9.9.9')
  // 那次并发检查的迟到 not-available 不得把它打回 up-to-date / 清空版本。
  fake.emit('update-not-available')
  assert.equal(controller.state().phase, 'downloaded', '迟到的 not-available 不得覆盖 downloaded')
  assert.equal(controller.state().latestVersion, '9.9.9',
    '已下载版本不得被清空（会丢「重启并安装」行与 before-quit 豁免）')
})

test('C2 回归：停滞后的用户显式 download() 重试仍放行，重试期间继续排除检查', async () => {
  const { fake, controller } = makeController({ deps: { updateIdleTimeoutMs: 120 } })
  fake.emit('update-available', { version: '9.9.9' })
  fake.downloadResult = new Promise(() => {})
  void controller.download()
  assert.equal(await waitFor(() => controller.state().phase === 'error'), true)
  assert.equal(controller.state().failureKind, 'download-network')
  // 显式重试必须放行（停滞待决不能堵住用户的重试），并重新武装看门狗。
  let settleRetry = null as ((value: unknown) => void) | null
  fake.downloadResult = new Promise((resolve) => { settleRetry = resolve })
  const retry = controller.download()
  assert.equal(fake.downloadCalls, 2, '停滞后的显式重试必须真的再次调用 downloadUpdate')
  const checksBefore = fake.checkCalls
  await controller.checkNow()
  assert.equal(fake.checkCalls, checksBefore, '重试在飞期间检查仍被单飞排除')
  settleRetry?.({})
  assert.deepEqual(await retry, { ok: true })
  // 重试结算 → 待决解除：相位仍是 error + latestVersion，允许新一轮检查。
  await controller.checkNow()
  assert.equal(fake.checkCalls, checksBefore + 1, '重试结算后检查排除必须解除')
})
