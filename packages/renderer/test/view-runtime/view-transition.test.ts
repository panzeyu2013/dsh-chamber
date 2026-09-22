/**
 * view-transition.ts 键控单槽并发语义单元测试。无浏览器、无真实时序——document.startViewTransition 与
 * matchMedia 均为可控 fake（模块惰性读取，测试各自安装/恢复），过渡节由
 * 测试手动触发（update 回调 / finish / reject），全部断言确定性。
 *
 * 钉死的语义（与模块头注 / design 05 §4 逐条对应）：
 * - 同键最新意图胜出：在途期间同键新意图替换旧意图，被取代意图从不执行；
 * - 回调时认领：补发过渡的更新回调执行瞬间才 claim 本键最新意图（融合）；
 * - 同键突发实际过渡 ≤ 2 节（在途 1 节 + 补发 1 节）；
 * - 跨键 FIFO、settle 永不被吞；finished resolve/reject 双路都清槽补发；
 * - startViewTransition 抛错 → 直接执行最新意图并清槽，绝不钉死；
 * - reduced-motion 在途翻转：直通落地经同一单槽队列取到最新意图。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runViewTransition } from '../../src/view-transition.ts'

/** 可控 view-transition fake：每个 startViewTransition 调用登记一节句柄，
 *  由测试手动触发 update 回调与 finished/updateCallbackDone 的 resolve/
 *  reject（reduced 可中途翻转——matchMedia 每次现读）。 */
function installFake(options: {
  support?: boolean
  reduced?: boolean
  throwOnStart?: boolean
  /** 非规约返回值：句柄缺失时过渡槽不得被钉死。 */
  returnHandle?: 'undefined' | 'empty' | 'no-finished'
} = {}) {
  const cfg = { reduced: options.reduced ?? false }
  const transitions: Array<{
    update: () => void
    finish(): void
    skip(): void
    rejectUpdate(): void
    failReady(): void
  }> = []
  const originalDocument = globalThis.document
  const originalMatchMedia = globalThis.matchMedia
  // 绘制意图写在 documentElement 的 data-vt-intent 上（CSS 据此作用域化命名组
  // 动画），所以 fake 必须带 documentElement——否则 writePaintIntent 走静默分支，
  // 整个 paint 特性对这套断言不可见。
  const attributes = new Map<string, string>()
  const doc: {
    startViewTransition?: (update: () => void) => unknown
    documentElement?: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void }
  } = {
    documentElement: {
      setAttribute(name: string, value: string) { attributes.set(name, value) },
      removeAttribute(name: string) { attributes.delete(name) },
    },
  }
  if (options.support !== false) {
    doc.startViewTransition = (update: () => void) => {
      if (options.throwOnStart === true) throw new Error('fake startViewTransition threw')
      let finishResolve!: () => void
      let finishReject!: (error: Error) => void
      let updateResolve!: () => void
      let updateReject!: (error: Error) => void
      let readyReject!: (error: Error) => void
      const finished = new Promise<void>((resolve, reject) => { finishResolve = resolve; finishReject = reject })
      const updateCallbackDone = new Promise<void>((resolve, reject) => { updateResolve = resolve; updateReject = reject })
      const ready = new Promise<void>((_resolve, reject) => { readyReject = reject })
      transitions.push({
        update,
        finish() { updateResolve(); finishResolve() },
        skip() { finishReject(new Error('transition skipped')) },
        rejectUpdate() { updateReject(new Error('update failed')) },
        failReady() { readyReject(new Error('transition could not begin')) },
      })
      if (options.returnHandle === 'undefined') return undefined
      if (options.returnHandle === 'empty') return {}
      if (options.returnHandle === 'no-finished') return { updateCallbackDone, ready }
      return { finished, updateCallbackDone, ready }
    }
  }
  globalThis.document = doc as unknown as Document
  globalThis.matchMedia = (() => ({ matches: cfg.reduced })) as unknown as typeof matchMedia
  return {
    cfg,
    transitions,
    attributes,
    restore() {
      globalThis.document = originalDocument
      globalThis.matchMedia = originalMatchMedia
    },
  }
}

/** 等微任务排空（finished.then 链与 drainNext 都是 promise 回调）。 */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

test('直通模式（不支持 View Transition）：每次调用即时执行其最新意图，零过渡节', async () => {
  const fake = installFake({ support: false })
  try {
    const executed: string[] = []
    runViewTransition(() => executed.push('a'), 'view')
    runViewTransition(() => executed.push('b'), 'view')
    runViewTransition(() => executed.push('s'), 'settle')
    await settle()
    assert.deepEqual(executed, ['a', 'b', 's'], '直通：无在途节时每次调用各自即时执行')
    assert.equal(fake.transitions.length, 0, '直通模式绝不创建过渡节')
  } finally {
    fake.restore()
  }
})

test('同键突发：在途 1 节 + 补发 1 节，回调认领最新意图，被取代意图从不执行', async () => {
  const fake = installFake()
  try {
    const executed: string[] = []
    runViewTransition(() => executed.push('a'), 'view') // 起节 T1（意图 a）
    assert.equal(fake.transitions.length, 1, '首个调用起节')
    runViewTransition(() => executed.push('b'), 'view') // 在途同键 → pending b
    runViewTransition(() => executed.push('c'), 'view') // b 被 c 取代
    // T1 的更新回调触发：claim 到本键最新意图 c（b 从未执行）。
    fake.transitions[0]!.update()
    assert.deepEqual(executed, ['c'], '回调认领最新意图；被取代的 a/b 从不执行')
    // 认领后又有新意图到达（在途节期间）→ 下一轮补发。
    runViewTransition(() => executed.push('d'), 'view')
    fake.transitions[0]!.finish()
    await settle()
    assert.equal(fake.transitions.length, 2, '同键突发总节数 ≤ 2（在途 1 + 补发 1）')
    fake.transitions[1]!.update()
    assert.deepEqual(executed, ['c', 'd'], '补发节执行其认领到的最新意图')
    fake.transitions[1]!.finish()
    await settle()
    assert.deepEqual(executed, ['c', 'd'], '每个意图恰执行一次')
  } finally {
    fake.restore()
  }
})

test('跨键 FIFO：settle 意图在 view 在途期间入队，结束后独立起节、永不被吞', async () => {
  const fake = installFake()
  try {
    const executed: string[] = []
    runViewTransition(() => executed.push('view-a'), 'view')
    runViewTransition(() => executed.push('view-b'), 'view')
    runViewTransition(() => executed.push('settle-a'), 'settle')
    runViewTransition(() => executed.push('view-c'), 'view') // view 键最新
    fake.transitions[0]!.update() // claim view-c
    assert.deepEqual(executed, ['view-c'])
    fake.transitions[0]!.finish()
    await settle()
    // FIFO：settle 键次之（Map 保序：view 先达、settle 后达）。
    assert.equal(fake.transitions.length, 2)
    assert.equal(executed.length, 1, 'settle 未与 view 合并')
    fake.transitions[1]!.update() // settle 节 claim settle-a
    assert.deepEqual(executed, ['view-c', 'settle-a'], 'settle 意图完整执行（veil 移除不被吞）')
    fake.transitions[1]!.finish()
    await settle()
    assert.deepEqual(executed, ['view-c', 'settle-a'])
  } finally {
    fake.restore()
  }
})

test('reduced-motion 在途翻转：直通落地经单槽队列取到最新意图，绝不被在途节旧意图覆盖', async () => {
  const fake = installFake()
  try {
    const executed: string[] = []
    runViewTransition(() => executed.push('a'), 'view') // 起节 T1（fallback a）
    runViewTransition(() => executed.push('b'), 'view') // pending b
    fake.cfg.reduced = true // 在途期间翻转为 reduced-motion
    runViewTransition(() => executed.push('c'), 'view') // pending c（b 被取代）
    fake.transitions[0]!.finish() // 在途节结束 → drainNext 走直通
    await settle()
    assert.equal(fake.transitions.length, 1, '翻转后不再起新过渡节')
    assert.deepEqual(executed, ['c'], '直通落地执行最新意图 c——在途节的旧 fallback a 永不覆盖')
  } finally {
    fake.restore()
  }
})

test('startViewTransition 抛错：直接执行该次意图并清槽，后续调用照常', async () => {
  const fake = installFake({ throwOnStart: true })
  const originalError = console.error
  console.error = () => undefined // 该路径按设计 console.error 一次
  try {
    const executed: string[] = []
    // 同步调用各自即时 drain：无在途节可合并，每次抛错路径执行其自身意图。
    runViewTransition(() => executed.push('a'), 'view')
    runViewTransition(() => executed.push('b'), 'view')
    runViewTransition(() => executed.push('c'), 'view')
    assert.deepEqual(executed, ['a', 'b', 'c'], '抛错时每次调用直接执行其意图')
    assert.equal(fake.transitions.length, 0, '抛错路径不产生句柄')
    runViewTransition(() => executed.push('d'), 'view')
    assert.deepEqual(executed, ['a', 'b', 'c', 'd'], '清槽后后续调用照常（绝不钉死）')
  } finally {
    console.error = originalError
    fake.restore()
  }
})

test('finished 与 updateCallbackDone 的拒绝双路都清槽补发，无未处理拒绝', async () => {
  const fake = installFake()
  try {
    const executed: string[] = []
    runViewTransition(() => executed.push('view-a'), 'view')
    runViewTransition(() => executed.push('settle-a'), 'settle') // 排队等补发
    // updateCallbackDone 拒绝被吞（模块内 catch）：不阻断 finished 路径。
    fake.transitions[0]!.rejectUpdate()
    fake.transitions[0]!.finish()
    await settle()
    assert.equal(fake.transitions.length, 2, 'updateCallbackDone 拒绝不清槽、补发照常')
    fake.transitions[1]!.update()
    fake.transitions[1]!.skip() // finished reject 同样清槽
    await settle()
    assert.deepEqual(executed, ['settle-a'], '两路拒绝后补发链仍完整执行')
    // 拒绝后新请求正常起新链（无残留 activeKey）。
    runViewTransition(() => executed.push('after'), 'view')
    assert.equal(fake.transitions.length, 3)
    fake.transitions[2]!.update()
    fake.transitions[2]!.finish()
    await settle()
    assert.deepEqual(executed, ['settle-a', 'after'])
  } finally {
    fake.restore()
  }
})

test('P2：绘制意图起节前写入、认领后按实际意图覆盖、结束/抛错清空', async () => {
  const fake = installFake()
  try {
    const executed: string[] = []
    runViewTransition(() => executed.push('cold'), 'view', 'cut')
    assert.equal(fake.attributes.get('data-vt-intent'), 'cut',
      '静态 cut 必须在 startViewTransition 之前写入（伪元素树建立时就要带上作用域）')
    fake.transitions[0].update()
    assert.deepEqual(executed, ['cold'])
    assert.equal(fake.attributes.get('data-vt-intent'), 'cut', '认领时按实际意图重写（此处仍是 cut）')
    fake.transitions[0].finish()
    await settle()
    assert.equal(fake.attributes.has('data-vt-intent'), false,
      'finished resolve 之后必须清空（否则后续所有命名组过渡都被硬切）')
  } finally {
    fake.restore()
  }
})

test('P2：resolver 起节先保守 cut，认领（flushSync 之后）才求值并覆盖', async () => {
  const fake = installFake()
  try {
    let resolved = 0
    runViewTransition(() => undefined, 'view', () => { resolved += 1; return 'crossfade' })
    assert.equal(fake.attributes.get('data-vt-intent'), 'cut', 'resolver 结果未知时起节保守取 cut（宁可硬切也不混色）')
    assert.equal(resolved, 0, '不得在起节前求值：那时 DOM 还不是落地后的状态')
    fake.transitions[0].update()
    assert.equal(resolved, 1, '认领后必须恰好求值一次')
    assert.equal(fake.attributes.has('data-vt-intent'), false, '求值为 crossfade ⇒ 清掉标记')
    fake.transitions[0].finish()
    await settle()
  } finally {
    fake.restore()
  }
})

test('P2：finished 拒绝 / 起节抛错 / 直通模式都不留标记', async () => {
  const skipped = installFake()
  try {
    runViewTransition(() => undefined, 'view', 'cut')
    skipped.transitions[0].skip()
    await settle()
    assert.equal(skipped.attributes.has('data-vt-intent'), false, 'finished 拒绝路径同样要清')
  } finally {
    skipped.restore()
  }
  const throwing = installFake({ throwOnStart: true })
  try {
    runViewTransition(() => undefined, 'view', 'cut')
    assert.equal(throwing.attributes.has('data-vt-intent'), false, 'startViewTransition 抛错路径由 finally 清')
  } finally {
    throwing.restore()
  }
  const direct = installFake({ support: false })
  try {
    runViewTransition(() => undefined, 'view', 'cut')
    assert.equal(direct.attributes.has('data-vt-intent'), false, '直通模式没有过渡节，绝不写标记')
  } finally {
    direct.restore()
  }
})

test('P2：认领到的意图与起节 fallback 的 paint 不同时，按认领结果重写', async () => {
  // 起节 crossfade → 回调前同键换成 cut：末意图胜出必须在 paint 维度也成立。
  const cold = installFake()
  try {
    const executed: string[] = []
    runViewTransition(() => executed.push('slow'), 'view', 'crossfade')
    runViewTransition(() => executed.push('cold'), 'view', 'cut')
    assert.equal(cold.attributes.has('data-vt-intent'), false, '起节写的是 fallback 的 crossfade')
    cold.transitions[0].update()
    assert.deepEqual(executed, ['cold'], '同键最新意图胜出')
    assert.equal(cold.attributes.get('data-vt-intent'), 'cut', '认领到 cut 就必须把属性改成 cut')
    cold.transitions[0].finish()
    await settle()
    assert.equal(cold.attributes.has('data-vt-intent'), false)
  } finally {
    cold.restore()
  }
  const warm = installFake()
  try {
    const executed: string[] = []
    runViewTransition(() => executed.push('cold'), 'view', 'cut')
    runViewTransition(() => executed.push('warm'), 'view', 'crossfade')
    assert.equal(warm.attributes.get('data-vt-intent'), 'cut', '起节写 fallback 的 cut')
    warm.transitions[0].update()
    assert.deepEqual(executed, ['warm'])
    assert.equal(warm.attributes.has('data-vt-intent'), false, '认领到 crossfade 就必须清掉 cut')
    warm.transitions[0].finish()
    await settle()
  } finally {
    warm.restore()
  }
})

test('P2：被取代意图的 resolver 永不求值，认领的恰好一次', async () => {
  const fake = installFake()
  try {
    let replaced = 0
    let claimed = 0
    runViewTransition(() => undefined, 'view', () => { replaced += 1; return 'cut' })
    runViewTransition(() => undefined, 'view', () => { claimed += 1; return 'crossfade' })
    fake.transitions[0].update()
    assert.equal(replaced, 0, '被取代意图的 resolver 不得求值')
    assert.equal(claimed, 1, '认领的 resolver 恰好求值一次')
    fake.transitions[0].finish()
    await settle()
  } finally {
    fake.restore()
  }
})

test('P2：ready 拒绝（过渡开始不了）不破坏队列，finished 后照常补发', async () => {
  const fake = installFake()
  try {
    const executed: string[] = []
    runViewTransition(() => executed.push('first'), 'view', 'cut')
    fake.transitions[0].failReady()
    await settle()
    // `[]` 字面量会让 node:assert 的断言签名把 `executed` 收窄成 never[]，显式标注期望值类型。
    assert.deepEqual(executed, [] as string[], 'ready 拒绝不改变本节的 update 时序')
    fake.transitions[0].update()
    assert.deepEqual(executed, ['first'], '本节的 update 照常执行')
    runViewTransition(() => executed.push('second'), 'view', 'cut')
    fake.transitions[0].finish()
    await settle()
    fake.transitions[1].update()
    assert.deepEqual(executed, ['first', 'second'], 'ready 拒绝后队列照常补发（模块对它挂了 catch）')
    fake.transitions[1].finish()
    await settle()
    assert.equal(fake.attributes.has('data-vt-intent'), false, '两节都结束后标记清空')
  } finally {
    fake.restore()
  }
})

test('P2：非规约 startViewTransition 句柄不得把过渡槽钉死', async () => {
  for (const returnHandle of ['undefined', 'empty', 'no-finished'] as const) {
    const fake = installFake({ returnHandle })
    try {
      const executed: string[] = []
      runViewTransition(() => executed.push('first'), 'view', 'cut')
      runViewTransition(() => executed.push('second'), 'view', 'cut')
      // 句柄不规约 ⇒ 槽必须同步收尾：第二次调用得**真的起新节**（钉死时它会被吞进在途槽）。
      // update 回调在真实引擎里由浏览器调用，假件不代调，所以这里自己驱动第二节。
      assert.equal(fake.transitions.length, 2, returnHandle + '：第二次调用必须真的起新节（过渡槽未被钉死）')
      fake.transitions[1].update()
      assert.deepEqual(executed, ['second'], returnHandle + '：后续意图照常执行')
      assert.equal(fake.attributes.has('data-vt-intent'), false, returnHandle + '：属性不得残留')
      // 收尾：释放在途槽，避免把模块级状态带进下一个用例（测试共享同一个模块实例）。
      fake.transitions[1].finish()
      await settle()
    } finally {
      fake.restore()
    }
  }
})
