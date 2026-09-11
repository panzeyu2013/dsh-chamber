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
  // 确定性版（2026-09-11 CI 修复）：原实现用 30 次 `sleep(1)` 制造"运行期间
  // 持续到达"，把断言建立在 sleep 精度上。Windows runner 的定时器粒度约
  // 15ms（= 单遍时长），风暴（30×15ms）会跑赢第一条链（3×15ms），末尾到达
  // 各自起新链；收尾的 `refresh()` 因此可能加入**某条正在跑封顶遍**的链——
  // 那种加入者不会触发新一遍（cap 已到），于是 `runs > stormRuns` 为假，而它
  // 上一行 `assert.equal(await refresh(), runs)` 仍为真。CI 形态正是如此
  // （c7f12930 的 test-windows 腿：line 72 过 / line 73 挂）。现在改为 gate
  // 驱动：放行时机与"到达发生在第几遍"全部显式可控，不看时间，也不受平台
  // 定时器粒度影响。
  let runs = 0
  const gates: (() => void)[] = []
  const refresh = createCoalescedRefresher(async () => {
    runs += 1
    await new Promise<void>((resolve) => { gates.push(resolve) })
    return runs
  }, { maxReruns: 3 })
  /** 等到链的下一次 compute 开始（gate 注册）；纯事件驱动，无定时器。 */
  const nextRunInFlight = async () => {
    for (let i = 0; i < 1000 && gates.length === 0; i += 1) await Promise.resolve()
    assert.equal(gates.length > 0, true, '放行一遍后链应当立刻开始下一遍')
  }
  /** cap 失效时（无界补跑）链永不结束：绑一个宽超时，让它以具名失败而非挂死套件。 */
  const settledWithin = async <T>(promise: Promise<T>, label: string): Promise<T> => Promise.race([
    promise,
    sleep(5000).then((): never => { throw new Error(`${label} 5s 内未结束——maxReruns 封顶失效（无界补跑）`) }),
  ])

  const first = refresh()          // 第 1 遍在途
  await nextRunInFlight()
  void refresh()                   // 第 1 遍运行期间到达 → 置位补跑
  gates.shift()!()                 // 放行第 1 遍
  await nextRunInFlight()          // 第 2 遍在途
  void refresh()                   // 第 2 遍运行期间到达 → 置位补跑
  gates.shift()!()                 // 放行第 2 遍
  await nextRunInFlight()          // 第 3 遍 = 封顶遍在途
  assert.equal(runs, 3, '持续到达应补跑到 maxReruns 封顶（正是 3 遍）')
  void refresh()                   // 封顶遍期间到达：置位，但已无第 4 遍
  gates.shift()!()                 // 放行封顶遍
  assert.equal(await settledWithin(first, '封顶链'), 3, '封顶链结束于第 3 遍，该遍的加入者拿到它的结果')
  assert.equal(runs, 3, '触顶后不再补跑：病态到达率不会把一次刷新拖成无限循环')

  // 链已结束（风暴停止）：下一次请求开一条全新链并成功。
  const stormRuns = runs
  const fresh = refresh()
  await nextRunInFlight()
  gates.shift()!()
  assert.equal(await settledWithin(fresh, '新链'), stormRuns + 1, '静止后新请求必开新链，返回新一遍的结果')
  assert.equal(runs, stormRuns + 1)
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

test('cap 触顶那遍的加入者拿到该遍结果（≤1 遍有界陈旧，确定性钉死）', async () => {
  // 文件头声明的有界陈旧语义：cap 触顶时，cap 遍运行期间到达的加入者拿到
  // 的是**已启动于其到达之前**的那遍结果（≤1 遍陈旧窗口）——本用例用可控
  // 门闩逐遍放行，确定性断言「触顶遍的到达者绝不再触发第 3 遍、且其值 =
  // 触顶遍结果」。
  let runs = 0
  const gates: Array<() => void> = []
  let releaseRun: () => void = () => undefined
  const refresh = createCoalescedRefresher(async () => {
    runs += 1
    await new Promise<void>(resolve => {
      releaseRun = resolve
      gates.push(resolve)
    })
    return runs
  }, { maxReruns: 2 })
  const until = async (predicate: () => boolean): Promise<void> => {
    while (!predicate()) await new Promise(resolve => setImmediate(resolve))
  }
  try {
    const first = refresh() // run 1 在途
    const duringRun1 = refresh() // 加入 run 1 → 置位补跑
    await until(() => gates.length === 1)
    releaseRun() // run 1 完成 → reruns=1 < 2 → run 2 补跑开始
    await until(() => gates.length === 2)
    const duringRun2 = refresh() // 加入 run 2（cap 触顶那遍）→ 置位但不再补跑
    releaseRun() // run 2 完成 → reruns=2 触顶 → 链结束
    assert.equal(await first, 2)
    assert.equal(await duringRun1, 2, 'run1 加入者拿到补跑（run 2）结果')
    assert.equal(await duringRun2, 2, '触顶遍加入者拿到 run 2 结果（≤1 遍有界陈旧）')
    assert.equal(runs, 2, 'cap=2：链内恰 2 遍，触顶遍到达者绝不触发第 3 遍')
    // 链结束后新请求 = 全新链（第 3 遍），陈旧窗口随链终结而结束。
    const next = refresh()
    await until(() => gates.length === 3)
    releaseRun()
    assert.equal(await next, 3)
    assert.equal(runs, 3)
  } finally {
    // 确保任何遗留门闩都被放行，测试永不悬挂。
    while (gates.length > 0) gates.pop()?.()
  }
})

test('maxReruns 钳制：0/负数/NaN 按 1（链仍至少跑首遍）', async () => {
  for (const bogus of [0, -5, Number.NaN]) {
    let runs = 0
    const refresh = createCoalescedRefresher(async () => {
      runs += 1
      await sleep(10)
      return runs
    }, { maxReruns: bogus })
    const first = refresh()
    void refresh()
    assert.equal(await first, 1, `maxReruns=${String(bogus)} 钳制为 1：无补跑`)
    assert.equal(runs, 1)
  }
})
