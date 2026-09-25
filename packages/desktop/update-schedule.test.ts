/**
 * update-schedule.test.ts — 上游节奏策略（600s 基准 ±20% 抖动 / 失败退避封顶 1h /
 * DSH_DESKTOP_UPDATE_CHECK_* env）的锁步用例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UPDATE_SCHEDULE_DEFAULTS,
  UPDATE_FIRST_CHECK_DELAY_MS,
  nextCheckDelay,
  resolveUpdateIdleTimeout,
  resolveUpdateScheduleConfig,
} from './update-schedule.ts'

test('默认值 = 上游（600s / 1h 封顶 / 0.2 抖动；首检 15s）', () => {
  const { config, problems } = resolveUpdateScheduleConfig({})
  assert.deepEqual(problems, [])
  assert.deepEqual(config, {
    intervalMs: 600_000,
    maxBackoffMs: 3_600_000,
    jitter: 0.2,
  })
  assert.equal(UPDATE_SCHEDULE_DEFAULTS.intervalMs, 600_000)
  assert.equal(UPDATE_FIRST_CHECK_DELAY_MS, 15_000)
})

test('env 名与上游逐字相同，且被采用', () => {
  const { config, problems } = resolveUpdateScheduleConfig({
    DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '900000',
    DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS: '7200000',
    DSH_DESKTOP_UPDATE_CHECK_JITTER: '0.5',
  })
  assert.deepEqual(problems, [])
  assert.deepEqual(config, { intervalMs: 900_000, maxBackoffMs: 7_200_000, jitter: 0.5 })
})

test('非法 env 回退默认且 loud（绝不抛：装配期抛错 = 应用打不开）', () => {
  for (const env of [
    { DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '0' },
    { DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: 'abc' },
    { DSH_DESKTOP_UPDATE_CHECK_JITTER: '2' },
    { DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS: '600000', DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS: '1000' },
  ]) {
    const { config, problems } = resolveUpdateScheduleConfig(env)
    assert.ok(problems.length > 0, '非法值必须产生 problems：' + JSON.stringify(env))
    assert.equal(config.intervalMs, 600_000)
  }
})

test('退避：×2 封顶 maxBackoff，抖动在 ±jitter 内，且不低于下限', () => {
  const config = { intervalMs: 600_000, maxBackoffMs: 3_600_000, jitter: 0.2 }
  const noJitter = () => 0.5 // 0.5 的随机数 = 抖动对称中点
  assert.equal(nextCheckDelay({ attempt: 0, config, random: noJitter }), 600_000)
  assert.equal(nextCheckDelay({ attempt: 1, config, random: noJitter }), 1_200_000)
  assert.equal(nextCheckDelay({ attempt: 2, config, random: noJitter }), 2_400_000)
  assert.equal(nextCheckDelay({ attempt: 3, config, random: noJitter }), 3_600_000, '封顶 1h')
  assert.equal(nextCheckDelay({ attempt: 9, config, random: noJitter }), 3_600_000)
  // 抖动边界：random=0 → -jitter；random→1 → +jitter。
  assert.equal(nextCheckDelay({ attempt: 0, config, random: () => 0 }), 480_000)
  assert.equal(nextCheckDelay({ attempt: 0, config, random: () => 1 }), 720_000)
  // 下限：jitter=1 时 base - base = 0 → 必须抬到 1s（绝不热循环）。
  assert.equal(
    nextCheckDelay({ attempt: 0, config: { intervalMs: 1_000, maxBackoffMs: 1_000, jitter: 1 }, random: () => 0 }),
    1_000,
  )
})

test('idle 超时：上游同名 env（缺省 60s），非法值回退并记问题', () => {
  assert.equal(resolveUpdateIdleTimeout({}).timeoutMs, 60_000)
  assert.equal(resolveUpdateIdleTimeout({ DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS: '5000' }).timeoutMs, 5_000)
  assert.equal(resolveUpdateIdleTimeout({ DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS: '5000' }).problem, null)
  const tooSmall = resolveUpdateIdleTimeout({ DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS: '10' })
  assert.equal(tooSmall.timeoutMs, 60_000, '非法值必须回退默认')
  assert.match(tooSmall.problem ?? '', /IDLE_TIMEOUT_MS/)
  assert.equal(resolveUpdateIdleTimeout({ DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS: 'abc' }).timeoutMs, 60_000)
})
