/**
 * coalesced-refresh.ts 单元测试（perf T3：节流/单飞/终态一次）。
 * 覆盖：突发共享 + 至多一遍补跑；串行请求各自新鲜一遍；错误传播与下次重试；
 * maxReruns 封顶不会死循环。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createCoalescedRefresher } from '../src/coalesced-refresh.ts'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('burst requests share one run plus one terminal trailing run', async () => {
  let runs = 0
  const refresh = createCoalescedRefresher(async () => {
    runs += 1
    await sleep(30)
    return runs
  })
  // 第一请求启动第 1 遍；其余在途到达（共享 + 置位补跑）。
  const requests = [refresh(), refresh(), refresh(), refresh(), refresh()]
  const settled = await Promise.all(requests)
  assert.equal(runs, 2, '突发请求应合并为在途 1 遍 + 终态补跑 1 遍')
  // 所有加入者拿到同一终态结果（补跑那遍的返回值）。
  assert.ok(settled.every((value) => value === settled[0]))
  assert.equal(settled[0], runs)
})

test('sequential awaited requests each start a fresh run', async () => {
  let runs = 0
  const refresh = createCoalescedRefresher(async () => {
    runs += 1
    await sleep(10)
    return runs
  })
  assert.equal(await refresh(), 1)
  assert.equal(await refresh(), 2)
  assert.equal(await refresh(), 3)
  assert.equal(runs, 3)
})

test('error propagates to every joiner and the next request retries cleanly', async () => {
  let runs = 0
  const refresh = createCoalescedRefresher(async () => {
    runs += 1
    if (runs === 1) throw new Error('boom')
    return runs
  })
  const results = await Promise.allSettled([refresh(), refresh(), refresh()])
  assert.ok(results.every((r) => r.status === 'rejected'))
  assert.equal(runs, 1, '失败不补跑：错误即终态，链清空')
  assert.equal(await refresh(), 2, '下一次请求全新运行并成功')
  assert.equal(runs, 2)
})

test('maxReruns caps the trailing chain instead of looping forever', async () => {
  let runs = 0
  const refresh = createCoalescedRefresher(async () => {
    runs += 1
    await sleep(15)
    return runs
  }, { maxReruns: 3 })
  const first = refresh()
  // 持续到达：每次运行期间都有新请求加入 → 补跑直到封顶后链结束（不挂死）。
  for (let i = 0; i < 30; i += 1) {
    void refresh()
    await sleep(1)
  }
  const capped = await first
  assert.ok(capped >= 2 && capped <= 3, `封顶链应结束于 ≤3 遍，实际 ${capped}`)
  const stormRuns = runs
  // 风暴停止后，下一次请求打开全新链并成功。
  assert.equal(await refresh(), runs)
  assert.ok(runs > stormRuns)
})

test('maxReruns=1 pins the whole chain to a single run (boundary semantics)', async () => {
  let runs = 0
  const refresh = createCoalescedRefresher(async () => {
    runs += 1
    await sleep(20)
    return runs
  }, { maxReruns: 1 })
  const first = refresh()
  // 运行期间的到达只共享、绝不触发补跑（reruns 首遍即达上限）。
  const joiners = [first, refresh(), refresh(), refresh()]
  assert.deepEqual(await Promise.all(joiners), [1, 1, 1, 1])
  assert.equal(runs, 1, 'maxReruns=1：链内总遍数上限即首遍，无任何补跑')
  // 链结束后新请求 = 全新链。
  assert.equal(await refresh(), 2)
  assert.equal(runs, 2)
})

test('rerunOnJoin:false joins the in-flight run silently without a trailing rerun', async () => {
  let runs = 0
  const refresh = createCoalescedRefresher(async () => {
    runs += 1
    await sleep(20)
    return runs
  })
  const first = refresh()
  // 静默 join：共享在途一遍结果、不置位补跑（TTL/轮询读方语义）。
  const silent = [refresh({ rerunOnJoin: false }), refresh({ rerunOnJoin: false })]
  assert.deepEqual(await Promise.all(silent), [1, 1])
  assert.equal(runs, 1, '静默 join 不触发补跑')
  assert.equal(await first, 1)
  // 默认请求仍触发补跑（写前闸口语义）：新链 run2 在途到达 → 补跑 run3，
  // 加入者拿到链末值（终态补跑结果）。
  const second = refresh()
  void refresh()
  assert.equal(await second, 3)
  assert.equal(runs, 3, '默认 rerunOnJoin 保持终态补跑')
})
