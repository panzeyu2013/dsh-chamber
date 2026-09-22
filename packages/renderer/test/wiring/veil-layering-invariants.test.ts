/**
 * 遮罩层叠不变量。
 * 加载遮罩期间官方 composer 会画在遮罩之上：运行构建里的
 * `.instance-loading{z-index:1}` 与 `[data-phase=active] .composerSeat{z-index:7}` 同处
 * `.instance-view` 的 stacking context，而 `.instance-shell` 是静态元素——数值上 7>1，
 * 绘制上穿透。边界因此画在租客根上（`.instance-shell{isolation:isolate}`），使遮罩按结构
 * 获胜，与壳内未来的任何 z 值无关。本文件用源码文本把不变量钉住（node 直跑，无 DOM 依赖）：
 *  1. `.instance-shell` 必须声明 `isolation: isolate`，遮罩仍是 z-index:1；
 *  2. `.instance-view.instance-veil-held .instance-shell` 必须 `visibility:hidden`，
 *     且三条隐藏态选择器都必须进"隐藏壳不创建动画"门（跨包锁在 sidebar 包，这里是我方半边）；
 *  3. 只有活动视图带 `view-transition-name`，非活动显式 `none`；`cut` 意图把命名组硬切；
 *  4. 揭幕读容器内会话根相位、窗口基准是**本次持有起点**（不是 settle 时刻），
 *     且兜底/外层两个上界是导出常量。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

/**
 * 取"选择器列表含 selector"的**全部**规则的声明体合并文本（去注释、空白归一）。
 * 一个选择器可以出现在多条规则里（基础态 + 隐藏态 + 过渡态），只取第一条会漏判。
 */
function decls(css: string, selector: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  const found: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(clean)) !== null) {
    const selectors = m[1].split(',').map(part => part.trim().replace(/\s+/g, ' '))
    if (selectors.includes(selector)) found.push(m[2].replace(/\s+/g, ' '))
  }
  assert.notEqual(found.length, 0, `规则缺失：${selector}`)
  return found.join(' ')
}

test('P0：租客根是 stacking context（veil 由结构获胜，不靠 z 值约定）', () => {
  const css = read('../../src/styles.css')
  assert.match(
    decls(css, '.instance-shell'),
    /(^| )isolation: isolate( |;|$)/,
    '.instance-shell 必须声明 isolation: isolate——否则壳内任何 z-index>1 的定位元素都会画在 .instance-loading(z-index:1) 之上',
  )
  assert.match(decls(css, '.instance-loading'), /z-index: 1/, '遮罩层级保持 1：结构由租客边界保证，不升 z')
})

test('P1：遮罩持有期隐藏租客，并进"隐藏壳不创建动画"门', () => {
  const css = read('../../src/styles.css')
  assert.match(
    decls(css, '.instance-view.instance-veil-held .instance-shell'),
    /visibility: hidden/,
    '持有期必须是 visibility:hidden（保留 layout；不用 content-visibility 以免每次持有付缓存失效）',
  )
  for (const selector of [
    '.instance-hidden .instance-shell *',
    '.instance-pending .instance-shell *',
    '.instance-veil-held .instance-shell *',
  ]) {
    const body = decls(css, selector)
    assert.match(body, /animation: none !important/, `${selector} 必须进"隐藏壳不创建动画"门`)
    assert.match(body, /transition: none !important/, `${selector} 的过渡同样要关门`)
  }
  const view = read('../../src/components/InstanceView.tsx')
  assert.match(view, /const shellHeld = settled && veilHeld/, '隐藏判定耦合帧的 held 事实（P2 释放时同帧恢复可见）')
  assert.ok(view.includes('instance-veil-held'), '状态类必须存在')
  assert.ok(
    view.includes('className="instance-shell"'),
    '容器 div 的 JSX 是 baseline-harvest 用例钉住的字面量，不得改动',
  )
})

test('P2：活动视图唯一命名 + cut 意图硬切', () => {
  const css = read('../../src/styles.css')
  assert.match(
    decls(css, '.instance-view:not(.instance-hidden):not(.instance-pending)'),
    /view-transition-name: active-instance/,
    '活动视图必须带唯一的过渡组名',
  )
  // 两条分别断言（拼起来 match 等价于"任一条有即可"，与"名字必须唯一"的意图不符）。
  assert.match(decls(css, '.instance-view.instance-hidden'), /view-transition-name: none/, '隐藏视图不得持有名字')
  assert.match(decls(css, '.instance-view.instance-pending'), /view-transition-name: none/, '待开视图不得持有名字')
  assert.match(
    decls(css, "html[data-vt-intent='cut']::view-transition-old(active-instance)"),
    /opacity:\s*0\s*;/,
    'cut 意图下旧快照必须**完全不透明地不可见**（/opacity: 0/ 会放过 0.5 —— 半透明旧快照就是部分混色）',
  )
  assert.match(
    decls(css, "html[data-vt-intent='cut']::view-transition-group(active-instance)"),
    /animation: none/,
    'cut 意图下命名组的 morph 也必须停掉（否则两个全屏视图仍走 250ms 组动画）',
  )
  const wrapper = read('../../src/view-transition.ts')
  assert.match(wrapper, /data-vt-intent/, 'view-transition.ts 必须写/清 data-vt-intent')
  assert.match(wrapper, /export type PaintIntent = 'crossfade' \| 'cut'/, '绘制意图类型是导出的契约')
})

test('P3：揭幕信号来自会话面 DOM 事实，窗口锚在本次持有起点', () => {
  const view = read('../../src/components/InstanceView.tsx')
  assert.ok(view.includes('readSessionSurfacePhase(el)'), '观察器必须读容器内的会话根相位')
  assert.ok(view.includes('SESSION_PHASE_ATTRIBUTE,'), '相位属性名取自 leaf 模块，不在组件里另写字面量')
  assert.ok(
    view.includes('const [holdStartedAt, setHoldStartedAt] = useState<number | null>(null)'),
    '兜底窗基准必须是**本次持有**起点（review MAJOR：锚在 settle 时刻会让暖壳上的揭示门整体失效）',
  )
  assert.ok(view.includes('holdStartedAtMs: holdStartedAt'), '判定必须吃这个基准')
  assert.equal(
    view.includes('settledAtRef'),
    false,
    '不得再回到"以 shell 的 settle 时刻为基准"的实现',
  )
  // 合成式（未 settle ⇒ 遮罩；持有意图未释放 ⇒ 遮罩；失败覆盖层在场 ⇒ 无遮罩）
  // 与相位→上界映射都在共享 arbiter。本锁钉**单一所有者**：组件必须消费
  // arbiter 的帧，且不得把合成式或映射在组件里再写一遍（组件里的第二份实现）。
  // 两条规则的真值表由 presentation 包套件覆盖（含 absent 2s 含边界、hero/settling 70s）。
  assert.ok(view.includes("const veilHeld = presentation.veil === 'held'"), '遮罩覆盖事实必须来自 arbiter 的帧')
  assert.ok(view.includes('PRESENTATION_THRESHOLDS'), '阈值必须来自共享表，不得在组件里另存一份')
  assert.equal(view.includes('holdVeil === true && !surfaceRelease'), false, '不得在组件里再写一遍合成式')
  assert.equal(view.includes('surfaceHoldBoundMs('), false, '不得在组件里再写一遍相位→上界映射')
  assert.ok(view.includes('const delay = planVeilTimer(presentation, frameNowMs)'), '兜底时钟只从帧的绝对 releaseAtMonoMs 换算（planVeilTimer），不得再重算窗口')
  // 接线行为锁：组件级真实渲染在本 worktree 跑不了，
  // 这六条文本锁各自对应一个"改坏也不红"的点：
  // 单向闩锁、观察器 deps 混入 surfaceRelease、观察器改成文档级作用域、
  // 观察器回调不再重采样、删掉上升沿相位复位、定时器丢掉相位档。
  assert.ok(view.includes('if (!surfaceHoldActive) return'), '观察器必须只在持有窗内装，但不得因一次释放就断开（电平，不是闩锁）')
  assert.equal(view.includes('if (!surfaceHoldActive || surfaceRelease)'), false, '不得回到单向闩锁（第一轮 MAJOR(C)）')
  assert.ok(
    view.includes('}, [surfaceHoldActive, retryToken, openIntentId])'),
    '观察器/持有窗 deps 只认持有窗、容器更换与请求身份（释放不得 teardown；换代必须重采相位）',
  )
  assert.ok(view.includes('openIntentId?: string'), '请求身份是显式 prop（不靠 App 内部的闭包）')
  assert.equal(view.includes('[surfaceHoldActive, surfaceRelease, retryToken]'), false, 'surfaceRelease 不得进观察器依赖（每次释放都会 teardown/重订阅）')
  assert.ok(view.includes('observer.observe(el, {'), '观察器必须观察本视图容器（文档级作用域会配错遮罩与锚点，第一轮 W-1b 假红同类）')
  assert.match(view, /attributeFilter: \[SESSION_PHASE_ATTRIBUTE\]/, '观察器必须监听 data-phase 属性变化')
  // 观察器回调必须继续重采样（只剩挂载时一次 ⇒
  // 相位永不更新），但不得"每次变更排一帧"——boot 窗口里那等于每帧一次 React 同步
  // commit。采样走 frame-coalescer：首帧一次、窗口内合并、尾部必采；三条语义由
  // test/view-runtime/frame-coalescer.test.ts 逐条钉住。
  assert.ok(
    view.includes('const observer = new MutationObserver(() => sampler.request())'),
    '观察器回调必须重采样（只剩挂载时一次 ⇒ 相位永不更新）',
  )
  assert.ok(
    view.includes('createFrameCoalescer({') && view.includes('minIntervalMs: SURFACE_SAMPLE_MIN_INTERVAL_MS'),
    '采样必须走合并器，且间隔取自 session-surface 的导出常量（不得在组件里写死数字）',
  )
  assert.ok(
    view.split('sampler.request()').length - 1 >= 2,
    '挂载时必须立即采一次，观察器回调也必须继续请求采样',
  )
  assert.equal(
    view.includes('requestAnimationFrame(() => { frame = 0; sample() })'),
    false,
    '不得回到"每次变更排一帧"的旧形态（每帧一次 commit）',
  )
  assert.ok(view.includes("setSurfacePhase('absent')"), '持有上升沿必须复位相位（与 leaf 时钟门双重保险）')
  assert.ok(view.includes('absentSinceMs: absentSince'), 'absent 必须把"连续缺失起点"交给 leaf')
  assert.ok(view.includes('const frameNowMs = monotonicNow()'), '判定的时基必须是单调钟（墙钟回拨会让外层保险静默失效）')
  assert.ok(view.includes('nowMs: frameNowMs'), '判定必须吃同一拍单调钟读数（帧的绝对期限与它同基）')
  assert.ok(
    view.includes('}, [presentation.veil, presentation.releaseAtMonoMs, frameNowMs, surfaceFallbackTick])'),
    '定时器 deps 必须含帧的 held 事实、绝对期限与到期 tick（提前触发只重算，不再 0ms 空转）',
  )
  const leaf = read('../../src/session-surface.ts')
  assert.equal(leaf.includes('SURFACE_ABSENT_FALLBACK_MS'), false, 'absent 兜底窗已收归共享表，leaf 不得留副本')
  assert.equal(leaf.includes('SURFACE_MAX_HOLD_MS'), false, 'hero/settling 外层保险已收归共享表，leaf 不得留副本')
  assert.ok(
    leaf.includes('SESSION_SCROLL_ANCHOR'),
    '相位读取必须从 [data-conversation-scroll] 反查祖先（composer 也发 data-phase，first-match 不可靠）',
  )
  // App 侧接线锁：paint resolver 是纯接线、node 单测覆盖不到，
  // 只能按本仓既有惯例（baseline-harvest/session-liveness-wiring 同款）读源码钉住——
  // 否则"改回静态 cut 或漏传第三参"会让命名组硬切静默消失。
  const app = read('../../src/App.tsx')
  assert.ok(
    app.includes("el.querySelector('.instance-loading') === null ? 'crossfade' : 'cut'"),
    'App 的 paint 判据必须按目标视图落地后的遮罩事实（settled 镜像不是判据）',
  )
  assert.ok(app.includes(", 'view', paint)"), 'W3 揭示节必须把 resolver 交给 view 键过渡')
  assert.ok(
    app.includes('openIntentId={openIntents[viewId]}'),
    '持有窗的请求身份必须来自 openIntents（同视图换代＝新一次持有，窗口重新起算）',
  )
  assert.equal(app.includes('settledViewIdsRef'), false, '已删除的 settled 镜像不得复活')
})

/**
 * 可见性 = paintedView（屏上），选择 = activeView（意图）。这些锁各自对应一条
 * "改坏也不红"的接线（判定本体在 view-runtime/reveal-gate.test.ts，这里钉 App 的
 * 装配）：可见性绑定、揭示回调的重验守卫、保留/回收与 hiddenSince 跟随屏上、
 * 侧栏 current 高亮跟随屏上、退役回落、失败/控制面不可达强制释放持有。
 * 阅读/蓝点武装（notify requireHidden / reconcile 的 readingCurrent / 清 current
 * 蓝点 effect）按同一语义也应当读 paintedView，但那三处位于 runtime-facts handler
 * 与 completedBySource 账本内；本工作流的写权限冻结在它们之外
 * （App.tsx 的 paintedView 声明注释同样写明）。
 */
test('P4/W3：可见性由 paintedView 驱动，选择与绘制分离', () => {
  const app = read('../../src/App.tsx')
  assert.match(
    app,
    /const \[paintedView, setPaintedView\] = useState<string>\(LOCAL_INSTANCE_ID\)/,
    'paintedView 必须是与 activeView 并列的 App 事实（初始 = local）',
  )
  assert.ok(app.includes('active={paintedView === viewId}'), 'InstanceView 的可见性必须绑定 paintedView')
  assert.equal(
    /active=\{activeView === viewId\}/.test(app),
    false,
    '不得回到 activeView 驱动可见性——那会让持有窗内目标壳提前露出（未 settle 时是 pending）',
  )
  // 揭示回调的重验：单槽队列里的揭示意图可能已过期（用户点了 B 又点回 A；来源退役）。
  // 没有这道守卫，一个过期揭示会把已撤销的目标画回屏上。
  assert.ok(
    app.split('if (activeViewRef.current !== selected) return').length - 1 >= 2,
    '揭示的 microtask 与 view 过渡 update 回调都必须重验 activeViewRef.current === selected',
  )
  assert.ok(
    app.includes('if (paintedViewRef.current === target) return'),
    '揭示前必须再确认屏上目标未变（排队期间的改写不得重复起节）',
  )
  const revealEffect = /useLayoutEffect\(\(\) => \{[\s\S]*?shouldReveal\(\{[\s\S]*?\}, \[activeView, paintedView, shellStates, mountedViews, revealTick\]\)/.exec(app)
  assert.ok(revealEffect !== null, '揭示 effect 必须以 [activeView, paintedView, shellStates, mountedViews, revealTick] 为依赖')
  assert.ok(revealEffect[0].includes('queueMicrotask('), 'flushSync 出场必须经 microtask（commit 相位内不得 flushSync）')
  assert.ok(
    revealEffect[0].includes('revealHoldRemainingMs(revealHoldStartedAtRef.current, nowMs)'),
    '持有窗到期必须用单调钟重臂一次性定时器（墙钟回拨会让它不再重臂）',
  )
  assert.ok(
    app.includes('revealHoldStartedAt(revealHoldStartedAtRef.current, {'),
    '持有起点必须经纯叶子推进（分叉锚定一次、稳态清空）',
  )
})

test('P4/W3：保留 / 回收 / 计时 / 侧栏高亮 / 退役都跟随 paintedView', () => {
  // 回收/隐藏计时/candidates 判定在 use-view-scheduler —— 本测试对两个
  // 落点取并集判 presence（App + scheduler），无负断言，断言强度不变。
  const app = read('../../src/App.tsx') + '\n' + read('../../src/app-hooks/use-view-scheduler.ts')
  assert.ok(
    app.includes('id === activeViewRef.current || id === paintedViewRef.current || id === pendingViewRef.current'),
    'reclaimView 守卫必须含 painted：屏上的壳永不被回收（唯一拆除入口）',
  )
  assert.ok(
    app.includes('activeViewId: paintedViewRef.current'),
    'decideReclaimCandidates 的 activeViewId 必须是 painted（否则持有窗内屏上壳被算成隐藏壳）',
  )
  assert.ok(
    app.includes('if (instanceId === paintedViewRef.current) delete hiddenSinceRef.current[instanceId]'),
    'settle 起表必须按 painted：屏上壳不开始隐藏计时',
  )
  assert.ok(app.includes('}, [paintedView])'), 'hiddenSince 落地 effect 必须以 paintedView 为键')
  assert.ok(
    app.includes('completedBySource, paintedView, pluginDiagnostics'),
    'deriveServers 的 current 投影必须吃 paintedView（侧栏高亮跟随屏上来源）',
  )
  assert.ok(
    app.includes('setPaintedView(prev => retireSelectedSource(prev, retired, LOCAL_INSTANCE_ID))'),
    'painted 必须与 activeView 同帧随注册表退役回落 local（同帧回落 + 揭示门 unmountable 双保险）',
  )
  assert.ok(
    app.includes('if (activeShellError === null && !controlUnreachable) return'),
    '失败 / 控制面不可达必须强制释放持有（覆盖层不透明，不等待揭示门）',
  )
})