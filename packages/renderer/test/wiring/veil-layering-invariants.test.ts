/**
 * 遮罩层叠不变量（2026-12 P0/P1/P2/P3 回归锁）。
 *
 * 这条缺陷（加载遮罩期间官方 composer 画在遮罩之上）此前**没有任何断言**：运行构建里的
 * `.instance-loading{z-index:1}` 与 `[data-phase=active] .composerSeat{z-index:7}` 同处
 * `.instance-view` 的 stacking context，而 `.instance-shell` 是静态元素——数值上 7>1，
 * 绘制上穿透。修复把边界画在租客根上（`.instance-shell{isolation:isolate}`），使遮罩按结构
 * 获胜，与壳内未来的任何 z 值无关。本文件用源码文本把不变量钉住（node 直跑，无 DOM 依赖）：
 *
 *  1. P0：`.instance-shell` 必须声明 `isolation: isolate`，遮罩仍是 z-index:1；
 *  2. P1：`.instance-view.instance-veil-held .instance-shell` 必须 `visibility:hidden`，
 *     且三条隐藏态选择器都必须进"隐藏壳不创建动画"门（跨包锁在 sidebar 包，这里是我方半边）；
 *  3. P2：只有活动视图带 `view-transition-name`，非活动显式 `none`；`cut` 意图把命名组硬切；
 *  4. P3：揭幕读容器内会话根相位、窗口基准是**本次持有起点**（不是 settle 时刻），
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
  assert.match(view, /const shellHeld = settled && veilVisible/, '隐藏判定耦合合成后的 veilVisible（P3 释放时同帧恢复可见）')
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
  assert.ok(
    view.includes('(!settled || (holdVeil === true && !surfaceRelease))'),
    '揭幕由 surfaceRelease 约束：active 立即释放，hero/settling 保持、absent 走 2s 兜底',
  )
  assert.ok(view.includes('surfaceHoldBoundMs(surfacePhase)'), '相位→上界映射必须取自 leaf（唯一一份，不得在组件里再写一遍三元）')
  // 接线行为锁（2026-12 二轮 review MINOR-5）：组件级真实渲染在本 worktree 跑不了，
  // 这六条文本锁各自对应第一轮 MAJOR(C) / 二轮突变矩阵里"改坏也不红"的点：
  // N4 单向闩锁、N3 观察器 deps 混入 surfaceRelease、N5 观察器改成文档级作用域、
  // N6 观察器回调不再重采样、N7 删掉上升沿相位复位、N8 定时器丢掉相位档。
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
  // N6（2026-09 渲染进程崩溃轮改版）：观察器回调必须继续重采样（只剩挂载时一次 ⇒
  // 相位永不更新），但不再"每次变更排一帧"——boot 窗口里那等于每帧一次 React 同步
  // commit，而崩溃栈的入口正是 rAF 回调内一个被 OSR 编译的热函数。改走
  // frame-coalescer：首帧一次、窗口内合并、尾部必采；三条语义由
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
  assert.ok(view.includes('nowMs: monotonicNow()'), '判定的时基必须是单调钟（墙钟回拨会让外层保险静默失效）')
  assert.ok(
    view.includes('}, [surfaceHoldActive, holdStartedAt, absentSince, surfacePhase, surfaceFallbackTick])'),
    '定时器 deps 必须含相位档、缺失起点与到期 tick（否则换档后 bound 陈旧、提前触发后不再重臂）',
  )
  const leaf = read('../../src/session-surface.ts')
  assert.match(leaf, /export const SURFACE_ABSENT_FALLBACK_MS = 2_000/, 'absent 兜底窗是导出常量（有界出口）')
  assert.match(leaf, /export const SURFACE_MAX_HOLD_MS = 70_000/, 'hero/settling 的外层保险是导出常量')
  assert.ok(
    leaf.includes('SESSION_SCROLL_ANCHOR'),
    '相位读取必须从 [data-conversation-scroll] 反查祖先（composer 也发 data-phase，first-match 不可靠）',
  )
  // App 侧接线锁（2026-12 二轮 review）：paint resolver 是纯接线、node 单测覆盖不到，
  // 只能按本仓既有惯例（baseline-harvest/session-liveness-wiring 同款）读源码钉住——
  // 否则"改回静态 cut 或漏传第三参"会让 P2 的修复静默消失。
  const app = read('../../src/App.tsx')
  assert.ok(
    app.includes("el.querySelector('.instance-loading') === null ? 'crossfade' : 'cut'"),
    'App 的 paint 判据必须按目标视图落地后的遮罩事实（settled 镜像不是判据）',
  )
  assert.ok(app.includes(", 'view', paint)"), 'selectView 必须把 resolver 交给 view 键过渡')
  assert.ok(
    app.includes('openIntentId={openIntents[viewId]}'),
    '持有窗的请求身份必须来自 openIntents（同视图换代＝新一次持有，窗口重新起算）',
  )
  assert.equal(app.includes('settledViewIdsRef'), false, '已删除的 settled 镜像不得复活')
})