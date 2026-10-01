/**
 * Pure judgement layer of the CDP mobile walkthrough.
 *
 * 与 `checks.mjs` 同一套纪律：这里没有 CDP、没有 DOM、没有 fs —— 只有
 * 「把页面测出来的事实判成 PASS / FAIL / INFO」的纯函数与那三条**页面内探测
 * 表达式**（设备事实 / 会话头几何 / M-9 覆盖层只读探查）。于是判定逻辑可以用
 * 合成事实做负例测试（mobile-checks.test.mjs），
 * 而驱动层（mobile-walkthrough.mjs）只负责连 CDP、装模拟、测量、落盘。
 *
 * 设备模拟的实证结论（Electron 41 / Chromium 本机实测；这三条是**测量
 * 边界**，移动档的任何模拟结论都要按它们打折）：
 *   1. `Emulation.setTouchEmulationEnabled({enabled:true})` 是**唯一**能让
 *      `(pointer:coarse)` / `(hover:none)` / `(any-pointer:coarse)` 成立的手段
 *      （maxTouchPoints > 0 ⇒ Blink 的触摸设备判定）；
 *   2. `Emulation.setEmulatedMedia` 的 `pointer`/`hover` 特性被**忽略**——
 *      同一调用里 `prefers-color-scheme` 生效、`pointer`/`hover` 不生效，
 *      所以「用媒体特性覆写伪造 pointer:coarse」这条路不通（重要限制）；
 *   3. `Emulation.setDeviceMetricsOverride({mobile:true})` 单独**不会**翻转
 *      pointer 媒体特性，且会把 `window.innerWidth` 变成**布局视口**宽度
 *      （收缩适配：390 的设备宽 + 900 宽的内容 ⇒ innerWidth 报 900），
 *      于是「scrollWidth <= innerWidth + 1」这条断言在 mobile:true 下会**假绿**；
 *      真正的 ICB 宽度是 `document.documentElement.clientWidth`。因此溢出判定
 *      两条都算：设备宽（clientWidth）为准，innerWidth 一并报告并注明收缩适配。
 */

/** 移动档设备模型（默认 390×844 / DPR 3）。 */
export const MOBILE_DEVICE = Object.freeze({
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
  maxTouchPoints: 5,
})

/** 会话头首行高度上限（design 17 §18.6 的触控/几何底线）。 */
export const HEADER_FIRST_ROW_MAX_PX = 48
/** 触控目标命中盒下限。 */
export const HIT_BOX_MIN_PX = 44
/** 收缩适配判定容差（1px 亚像素）。 */
const EPSILON = 1
/** `line-height: normal` 的行高折算系数（Blink 的 normal ≈ 1.2 × font-size）。 */
const NORMAL_LINE_HEIGHT_RATIO = 1.2

/**
 * 判定一条事实。`ok === null` 记 INFO（本次未执行/无法判定），与 checks.mjs 的
 * `verdict()` 同形，便于复用 createRecorder/renderMarkdown。
 *
 * @param {boolean|null} ok
 * @param {string} evidence
 * @returns {{ok: boolean|null, evidence: string}}
 */
export function judge(ok, evidence) {
  return { ok, evidence: String(evidence) }
}

/** 一条 CDP 模拟步骤（纯数据；驱动层按序 send）。 */
export function deviceEmulationSteps(device = MOBILE_DEVICE) {
  return [
    {
      method: 'Emulation.setDeviceMetricsOverride',
      params: {
        width: device.width,
        height: device.height,
        // screen.* 与窗口/视口一起被这个 override 决定：不传时 Chromium 用宿主的
        // screen 尺寸，判定层会把「screen 没落地」误读成模拟器偏差。
        screenWidth: device.width,
        screenHeight: device.height,
        deviceScaleFactor: device.deviceScaleFactor,
        mobile: device.mobile,
      },
    },
    // 顺序有意如此：touch 模拟在后，它是 pointer:coarse 的真正来源（实测 1/2）。
    { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: true, maxTouchPoints: device.maxTouchPoints } },
    // 只为「鼠标事件也走触摸路径」；实测它不改变媒体特性，属补充而非前提。
    { method: 'Emulation.setEmitTouchEventsForMouse', params: { enabled: true, configuration: 'mobile' } },
  ]
}

/**
 * 页面内的设备事实探测（一条 `Runtime.evaluate` 表达式）。
 * 只读：不改 DOM、不点任何控件。
 */
export const DEVICE_FACTS_EXPRESSION = `(() => {
  const mq = q => { try { return window.matchMedia(q).matches } catch { return null } }
  const scrolling = document.scrollingElement
  return {
    url: location.href,
    title: document.title,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollWidth: scrolling === null ? null : scrolling.scrollWidth,
    scrollHeight: scrolling === null ? null : scrolling.scrollHeight,
    visualViewport: window.visualViewport === undefined ? null
      : { width: Math.round(window.visualViewport.width), height: Math.round(window.visualViewport.height), scale: window.visualViewport.scale },
    dpr: window.devicePixelRatio,
    // screen.* 是**落地信号**（与 dpr/maxTouchPoints/ontouchstart 同级）：判定层要求
    // 它等于请求设备，setDeviceMetricsOverride 传了 screenWidth/screenHeight 才会成立。
    screenWidth: window.screen === undefined ? null : window.screen.width,
    screenHeight: window.screen === undefined ? null : window.screen.height,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    ontouchstart: 'ontouchstart' in window,
    pointerCoarse: mq('(pointer: coarse)'),
    pointerFine: mq('(pointer: fine)'),
    hoverNone: mq('(hover: none)'),
    anyPointerCoarse: mq('(any-pointer: coarse)'),
    // 与插件源码同源的档位查询（composer.ts TOUCH_TIER_QUERY / PHONE_TIER_QUERY）
    touchTier: mq('(max-width: 1023px) and (pointer: coarse)'),
    phoneTier: mq('(max-width: 768px) and (pointer: coarse)'),
    rootSlots: document.querySelectorAll('[data-slot="root"]').length,
    mobileFrames: document.querySelectorAll('[data-mobile-frame]').length,
    mobileRoles: [...document.querySelectorAll('[data-mobile-role]')].map(el => el.getAttribute('data-mobile-role')),
    pluginStyle: document.querySelector('style[data-plugin="dsh-chamber-client-ui-mobile"]') !== null,
    // 键盘守卫（composer.ts installComposerVisibilityGuard）的诊断面：M-4 的
    // 激活证据不止「frame 打了标」：已生效的 data-mobile-kbd 帧、state
    // 取值（armed | idle | no-seat | no-frame | still-covered）与 spacer 高度
    // 决定「插件激活了但键盘面没有生效」能不能被看见。
    mobileKbdFrames: document.querySelectorAll('[data-mobile-frame][data-mobile-kbd]').length,
    // 状态面在 frame 与 <html> 上各镜像一份：按载体分别收集，否则同一状态恒出现
    // 两次，走查证据会被读成「两个 frame / 两个载体」。
    mobileKbdStates: [...document.querySelectorAll('[data-mobile-kbd-state]')]
      .map(el => (el.tagName === 'HTML' ? 'html:' : 'frame:') + el.getAttribute('data-mobile-kbd-state')),
    mobileKbdSpacers: [...document.querySelectorAll('[data-mobile-kbd-spacer]')]
      .map(el => Math.round(el.getBoundingClientRect().height)),
  }
})()`

/**
 * 页面内的会话头探测（一条 `Runtime.evaluate` 表达式）。
 *
 * 「单字换行」的判据是**行盒数量**，不是猜的：`Range.getClientRects()` 对一段
 * 文本每个行盒返回一个 rect（实测：`会话标题` 在 30px 宽里返回 2 个 rect、
 * `12` 因数字间没有断行机会恒为 1 个）。同时按 task 的写法附上高度启发式
 * （元素高 > 行高 ×1.5），两者任一命中即判为换行；`line-height: normal` 时
 * 行高按 1.2 × font-size 折算，并在证据里标注来源。
 *
 * 只测**带直接文本节点**的元素（容器的固定高不能当换行证据：44px 的行里放
 * 16px 文字，高度启发式会假阳），`white-space: nowrap` 的元素按定义不换行。
 *
 * `paddingTop/Bottom` 一并采集：带纵向内边距的单行叶子（chip / 徽标）会被 padding
 * 撑到 `行高 ×1.5` 之上，按 box 高度判就是假红——所以纵向 padding 非零的叶子不参与
 * 高度启发式（判定层里，它们的真实换行只由精确的行盒数抓）。
 */
export const HEADER_FACTS_EXPRESSION = `(() => {
  const OUTLET = '[data-slot="conversation.session.header"]'
  const SEAT_PREFIX = '[data-slot^="conversation.session.header"]'
  // 锚点形状（design 17 §18.4.3）：outlet 是槽出口包装，\`<header>\` 是它的**祖先**
  // （上游 ConversationHeader 渲染 header，会话头槽挂在它的 children 里）——所以
  // \`outlet.closest('header')\` 与上游形状同义。旧式 \`outlet > header\` 假设 header 是
  // outlet 的直接子节点，已列入锚点门的 FORBIDDEN_PATTERNS：它匹配不到真实 DOM 时
  // hasHeader=false，判定层会硬失败（"锚点形状失效"），不再静默 INFO。
  const outlet = document.querySelector(OUTLET)
  const header = outlet === null ? null : outlet.closest('header')
  const rect = el => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) } }
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const lineBoxes = el => {
    const range = document.createRange()
    let boxes = 0
    for (const node of el.childNodes) {
      if (node.nodeType !== 3 || node.textContent.trim() === '') continue
      range.selectNodeContents(node)
      boxes += range.getClientRects().length
    }
    return boxes
  }
  const textFacts = el => {
    const style = getComputedStyle(el)
    const fontSize = Number.parseFloat(style.fontSize) || 0
    const rawLineHeight = style.lineHeight
    const parsed = Number.parseFloat(rawLineHeight)
    const lineHeight = Number.isFinite(parsed) ? parsed : fontSize * ${NORMAL_LINE_HEIGHT_RATIO}
    const boxes = lineBoxes(el)
    const own = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
    return {
      text: own.slice(0, 60),
      tag: el.tagName.toLowerCase(),
      display: style.display,
      elementChildren: el.children.length,
      interactive: el.matches('button, a[href], [role="button"], input, select, textarea'),
      seat: el.closest(SEAT_PREFIX) === null ? null : el.closest(SEAT_PREFIX).getAttribute('data-slot'),
      lineBoxes: boxes,
      height: Math.round(el.getBoundingClientRect().height),
      lineHeight: Math.round(lineHeight * 100) / 100,
      lineHeightSource: Number.isFinite(parsed) ? 'computed' : 'normal×' + ${NORMAL_LINE_HEIGHT_RATIO},
      whiteSpace: style.whiteSpace,
      fontSize: Math.round(fontSize * 100) / 100,
      // 纵向 padding 会撑起 border-box 高度：高度启发式必须减掉它，否则一个带
      // 上下内边距的单行叶子（chip / 徽标）会被读成「换行」——假红。
      paddingTop: Math.round((Number.parseFloat(style.paddingTop) || 0) * 100) / 100,
      paddingBottom: Math.round((Number.parseFloat(style.paddingBottom) || 0) * 100) / 100,
    }
  }
  const hasOwnText = el => [...el.childNodes].some(node => node.nodeType === 3 && node.textContent.trim() !== '')
  const lineage = document.querySelector('[data-slot="conversation.session.header.lineage"]')
  const headerScope = header ?? outlet
  // 候选 = 会话头子树里**直接带文本节点**的元素（含 lineage 自身：count 文本就在
  // 座位元素上，只查后代会漏掉它——首版踩过）。
  const allTextElements = headerScope === null ? [] : [headerScope, ...headerScope.querySelectorAll('*')].filter(hasOwnText)
  // 80 是证据体积上限，不是"没超"的证明：超限时 textsTruncated=true，判定层把
  // 「共 N 个、只扫了前 80 个」写进 evidence（截断必须可见）。
  const textElements = allTextElements.slice(0, 80)
  const buttons = outlet === null ? [] : [...outlet.querySelectorAll('button')]
  const tabs = headerScope === null ? [] : [...headerScope.querySelectorAll('[role="tablist"], [role="tab"]')]
  return {
    hasOutlet: outlet !== null,
    hasHeader: header !== null,
    headerBox: header === null ? null : rect(header),
    firstRowBox: outlet === null || outlet.firstElementChild === null ? null : rect(outlet.firstElementChild),
    headerChildren: header === null ? [] : [...header.children].map(child => ({ tag: child.tagName.toLowerCase(), box: rect(child) })),
    tabs: tabs.map(el => ({ role: el.getAttribute('role'), box: rect(el) })),
    buttons: buttons.map(el => ({
      label: ((el.innerText || '').trim() || el.getAttribute('aria-label') || '').slice(0, 30),
      visible: visible(el),
      box: rect(el),
    })),
    lineage: lineage === null ? null : { box: rect(lineage), texts: [lineage, ...lineage.querySelectorAll('*')].filter(hasOwnText).map(textFacts) },
    texts: textElements.map(textFacts),
    textsTruncated: allTextElements.length > textElements.length,
    textsTotal: allTextElements.length,
    // 会话头是否真的在会话页（无会话/首启时 header 不存在 ⇒ INFO 而非 FAIL）
    sessionHeaderPresent: outlet !== null,
    rootPhase: document.querySelector('[data-phase]') === null ? null : document.querySelector('[data-phase]').getAttribute('data-phase'),
  }
})()`

/**
 * 设备模拟判定：metrics / touch / 媒体特性三件事各自是否成立。
 *
 * @param {object} facts - {@link DEVICE_FACTS_EXPRESSION} 的结果。
 * @param {object} device - {@link MOBILE_DEVICE} 形状。
 * @returns {{ok: boolean, evidence: string}} 媒体特性不成立时硬失败——此后所有
 *   几何断言测到的都是**桌面**布局，整轮走查没有意义；「明确报告 CDP 能否
 *   伪造 pointer:coarse」指的正是这条。
 */
export function deviceEmulationVerdict(facts, device = MOBILE_DEVICE) {
  const problems = []
  // 媒体特性仍是**硬失败**的第一层：不成立时后续几何断言测的是桌面布局。
  const mediaOk = facts.pointerCoarse === true && facts.hoverNone === true
  if (!mediaOk) problems.push('pointer:coarse / hover:none 未同时成立（此后几何断言测的是桌面布局）')
  // 落地信号：只有 setTouchEmulationEnabled 真正生效，命中盒/触控面才成立。
  if (!(typeof facts.maxTouchPoints === 'number' && facts.maxTouchPoints > 0)) {
    problems.push(`maxTouchPoints=${facts.maxTouchPoints}（触控落地信号缺失）`)
  }
  if (facts.ontouchstart !== true) problems.push('ontouchstart 不存在（触摸事件面未落地）')
  if (facts.dpr !== device.deviceScaleFactor) {
    problems.push(`devicePixelRatio=${facts.dpr} != 请求 deviceScaleFactor=${device.deviceScaleFactor}`)
  }
  // screen.* 与 dpr/maxTouchPoints/ontouchstart 同级的落地断言：deviceEmulationSteps
  // 把 screenWidth/screenHeight 一并交给 setDeviceMetricsOverride，因此不符要么是
  // 模拟没生效、要么是步骤里漏传——两种都必须红，不能只当「模拟器偏差」标注。
  if (facts.screenWidth !== device.width || facts.screenHeight !== device.height) {
    problems.push(`screen=${facts.screenWidth}×${facts.screenHeight} != 请求设备 ${device.width}×${device.height}（setDeviceMetricsOverride 的 screenWidth/screenHeight 未落地或步骤漏传）`)
  }
  // 档位蕴含（插件 composer.ts 的查询就是这两条）：请求宽落在哪一档，对应档位
  // 媒体查询就必须为真；否则插件样式会按另一档渲染，走查结论没有意义。
  if (device.width <= 1023 && facts.touchTier !== true) {
    problems.push(`请求宽 ${device.width} <= 1023 但 touchTier(≤1023&coarse)=${facts.touchTier} 未成立`)
  }
  if (device.width <= 768 && facts.phoneTier !== true) {
    problems.push(`请求宽 ${device.width} <= 768 但 phoneTier(≤768&coarse)=${facts.phoneTier} 未成立`)
  }
  // screen.* 是落地信号（与 dpr/maxTouchPoints/ontouchstart 同级参与 problems）。
  const screenNote = facts.screenWidth === device.width && facts.screenHeight === device.height
    ? `screen=${facts.screenWidth}×${facts.screenHeight}（与请求设备一致）`
    : `screen=${facts.screenWidth}×${facts.screenHeight} 与请求设备 ${device.width}×${device.height} 不符`
  const evidence = [
    `请求 ${device.width}×${device.height} @${device.deviceScaleFactor}x mobile=${device.mobile} maxTouchPoints=${device.maxTouchPoints}`,
    `实测 innerWidth=${facts.innerWidth} clientWidth=${facts.clientWidth} dpr=${facts.dpr} maxTouchPoints=${facts.maxTouchPoints} ontouchstart=${facts.ontouchstart}`,
    `媒体特性 pointer:coarse=${facts.pointerCoarse} pointer:fine=${facts.pointerFine} hover:none=${facts.hoverNone} any-pointer:coarse=${facts.anyPointerCoarse}`,
    `档位 touchTier(≤1023&coarse)=${facts.touchTier} phoneTier(≤768&coarse)=${facts.phoneTier}（请求宽蕴含：touchTier=${device.width <= 1023 ? '必须' : '不要求'} phoneTier=${device.width <= 768 ? '必须' : '不要求'}）`,
    screenNote,
    mediaOk ? '' : 'CDP 限制：pointer/hover 媒体特性只能靠 Emulation.setTouchEmulationEnabled 翻转（setEmulatedMedia 的 pointer/hover 特性被忽略，实测）',
    problems.length > 0 ? '失败项：' + problems.join('；') : '',
  ].filter(Boolean).join('\n')
  return { ok: problems.length === 0, evidence }
}

/**
 * 横向溢出判定。两条都算：
 *   - **设备宽基准**（`document.documentElement.clientWidth`，= 模拟设备宽）：
 *     内容比设备宽 = 真的溢出；
 *   - `scrollWidth <= innerWidth + 1`：在 `mobile:true` 的收缩适配下
 *     innerWidth 会膨胀到内容宽，这条会假绿——所以它成立**不算通过**，只是
 *     被一起报告；它不成立就一定溢出。
 *
 * @param {object} facts - {@link DEVICE_FACTS_EXPRESSION} 的结果。
 * @param {object} device
 * @returns {{ok: boolean|null, evidence: string}}
 */
export function overflowVerdict(facts, device = MOBILE_DEVICE) {
  if (facts.scrollWidth === null || facts.clientWidth === undefined) return judge(null, '拿不到滚动/视口宽度（页面未挂载？）')
  const taskLimit = facts.innerWidth + EPSILON
  const shrinkToFit = facts.innerWidth > facts.clientWidth + EPSILON
  const scale = facts.visualViewport === null || facts.visualViewport === undefined ? null : facts.visualViewport.scale
  // 判定基准必须是**设备宽**：clientWidth 只有在等于请求设备宽（±1px）时才可信。
  // 缩放（visualViewport.scale < 1）会把布局视口/ICB 语义一起改掉，此时
  // scrollWidth 与 clientWidth 不再是同一坐标系下的量——判 FAIL（基准不可信），
  // 而不是把不可解释的数字当通过。
  const untrusted = []
  if (!(facts.clientWidth <= device.width + EPSILON)) {
    untrusted.push(`clientWidth=${facts.clientWidth} > 请求设备宽 ${device.width}+1：ICB 不是模拟设备宽，设备宽基准不可信`)
  }
  if (typeof scale === 'number' && scale < 1) {
    untrusted.push(`visualViewport.scale=${scale} < 1：页面处于缩放态，scrollWidth/clientWidth 不在同一坐标系，判定基准不可信`)
  }
  const evidence = [
    `scrollWidth=${facts.scrollWidth} clientWidth(设备宽基准)=${facts.clientWidth} innerWidth=${facts.innerWidth} 请求设备宽=${device.width} visualViewport=${JSON.stringify(facts.visualViewport)}`,
    `task 断言 scrollWidth<=innerWidth+1 = ${facts.scrollWidth <= taskLimit}`,
    shrinkToFit
      ? `收缩适配生效：innerWidth(${facts.innerWidth}) > clientWidth(${facts.clientWidth}) —— 此时 task 那条断言恒真、不可作为溢出证据；判定以设备宽为准`
      : '无收缩适配：innerWidth == clientWidth，task 断言与设备宽基准等价',
  ]
  if (untrusted.length > 0) {
    return judge(false, [...evidence, '判定 FAIL（基准不可信，不是"内容没溢出"）：' + untrusted.join('；')].join('\n'))
  }
  const deviceLimit = facts.clientWidth + EPSILON
  const ok = facts.scrollWidth <= deviceLimit && facts.scrollWidth <= taskLimit
  return { ok, evidence: evidence.join('\n') }
}

/**
 * 会话头锚点形状失效的硬失败文案（outlet 在、但找不到其祖先 header）。
 * 这不是"无会话"：无会话时 outlet 也不存在（INFO）。
 */
function headerShapeBrokenEvidence() {
  return '会话头锚点形状失效（硬失败）：outlet [data-slot="conversation.session.header"] 存在，但 outlet.closest("header") 为空——'
    + '上游把 header 从 outlet 祖先链上移走/换容器了，按 design 17 §18.4.3 重锚后才能继续几何判定（首版直接子选择器正是这样静默 INFO 的）'
}

/**
 * 会话头首行高度判定（≤ 48px）。无会话（outlet 也不存在）⇒ INFO；锚点形状失效 ⇒ FAIL；
 * 会话头隐藏/零尺寸（首行盒宽或高 = 0）⇒ INFO——0 高恒 ≤ 上限，若判 PASS 就是
 * 「没测到」冒充「没超标」。INFO 在 `--require-run` 下会被走查层改判 FAIL。
 */
export function headerFirstRowVerdict(facts, maxPx = HEADER_FIRST_ROW_MAX_PX) {
  if (facts.hasOutlet === true && facts.hasHeader !== true) return judge(false, headerShapeBrokenEvidence())
  if (facts.hasHeader !== true) {
    return judge(null, '本次页面没有 [data-slot="conversation.session.header"]（无会话/首启/非会话页）——首行高度未测')
  }
  const row = facts.firstRowBox ?? facts.headerBox
  if (row === null) return judge(null, '会话头存在但拿不到首行几何')
  if (!(row.w > 0 && row.h > 0)) {
    return judge(null, `会话头首行隐藏/零尺寸（${row.w}×${row.h}）——高度未测（不是通过；--require-run 下改判 FAIL）`)
  }
  const evidence = [
    `首行=${facts.firstRowBox === null ? '（outlet 无元素子节点，退回 header 自身）' : 'outlet.firstElementChild'} 高 ${row.h}px（上限 ${maxPx}）`,
    `header 高 ${facts.headerBox === null ? '?' : facts.headerBox.h}px；子元素=${(facts.headerChildren ?? []).map(child => `${child.tag}(${child.box.h})`).join(' ')}`,
    `tab 条=${(facts.tabs ?? []).map(tab => `${tab.role}(${tab.box.w}×${tab.box.h})`).join(' ') || '（无）'}`,
  ].join('\n')
  return { ok: row.h <= maxPx, evidence }
}

/**
 * 会话头内「单字换行」判定。
 *
 * 两条信号：
 *   - **行盒数 > 1**（精确）：`Range.getClientRects()` 对每个行盒返回一个 rect；
 *   - **高 > 行高 ×1.5**（启发式）：只对「文本叶子」生效——无元素
 *     子节点、非交互控件（button/a/input…）、且 `display` 不是 flex/grid/contents。
 *     不设这个门槛，44px 高的图标按钮（`line-height: normal`）会全部假阳
 *     （本机实测：三个 44×44 的 header 按钮会被判成「换行」）。纵向 padding 非零的
 *     叶子**不参与**高度启发式：chip / 徽标那类单行叶子靠上下内边距撑高，高度单独
 *     说明不了换行——它们的真实换行由精确的行盒数抓。
 *
 * `white-space: nowrap` 的元素按定义不换行（它的溢出是裁切问题，另论）。
 *
 * @returns {{ok: boolean|null, evidence: string}} INFO = 本次会话头里没有**可见**文本
 *   （没有带文本元素的，或文本元素全部隐藏/零行盒），或带文本元素超过 80 个证据上限
 *   而**扫描被截断**（只扫了前 80 个，不能断言整页没有换行）——「测不到」绝不算「没换行」。
 */
export function headerWrapVerdict(facts) {
  if (facts.hasOutlet === true && facts.hasHeader !== true) return judge(false, headerShapeBrokenEvidence())
  if (facts.hasHeader !== true && facts.hasOutlet !== true) return judge(null, '本次页面没有会话头（无会话/首启）——换行未测')
  const candidates = facts.texts ?? []
  if (candidates.length === 0) return judge(null, '会话头内没有带直接文本节点的元素——换行未测')
  // 有文本元素 ≠ 可测：隐藏/零尺寸元素的 lineBoxes=0，旧判定从它得 wrapped=[] ⇒ PASS，
  // 把「一个行盒都没有」读成「没有换行」。至少要有一个可见行盒才允许下结论。
  const measurable = candidates.filter(item => item.lineBoxes > 0)
  if (measurable.length === 0) {
    return judge(null, `会话头内有 ${candidates.length} 个带文本元素，但没有任何可见行盒（隐藏/零尺寸）——换行未测（不是通过；--require-run 下改判 FAIL）`)
  }
  // 纵向 padding 非零的叶子不参与高度启发式：`getBoundingClientRect().height` 含
  // 上下内边距，带内边距的单行叶子会被垫过 `行高 ×1.5`——高度单独说明不了换行，
  // 只有精确的行盒数算数。padding 字段缺失按 0 处理（老事实形状仍按原判据判）。
  const verticalPadding = item => (item.paddingTop ?? 0) + (item.paddingBottom ?? 0)
  const heuristicApplies = item => item.lineBoxes === 1 && item.interactive !== true && item.elementChildren === 0
    && !['flex', 'grid', 'contents', 'inline-flex'].includes(item.display) && verticalPadding(item) === 0
  const wrapped = candidates.filter(item => item.whiteSpace !== 'nowrap'
    && (item.lineBoxes > 1 || (heuristicApplies(item) && item.height > item.lineHeight * 1.5)))
  const heuristicHits = wrapped.filter(item => item.lineBoxes === 1).length
  const lineageNote = facts.lineage === null
    ? 'lineage 座位不存在'
    : `lineage count=${JSON.stringify(facts.lineage.texts.map(t => t.text))} 行盒=${facts.lineage.texts.map(t => t.lineBoxes).join(',') || '（座位自身无直接文本）'}`
  const describeHit = item => item.lineBoxes > 1
    ? `行盒：${JSON.stringify(item.text)}（${item.seat ?? '?'} ${item.tag} 行盒=${item.lineBoxes} 高=${item.height} 行高=${item.lineHeight}(${item.lineHeightSource})）`
    : `高度启发式：${JSON.stringify(item.text)}（${item.seat ?? '?'} ${item.tag} 高=${item.height} 行高=${item.lineHeight}(${item.lineHeightSource}) 纵向 padding=0）`
  // 被 padding 排除在启发式之外的叶子数：报告要能解释「为什么这个高叶子没被判」。
  const paddedExcluded = candidates.filter(item => item.lineBoxes === 1 && verticalPadding(item) !== 0).length
  const evidence = [
    `扫描 ${candidates.length} 个带文本元素；判为换行 ${wrapped.length} 个（其中高度启发式 ${heuristicHits} 个）`
      + (paddedExcluded === 0 ? '' : `；纵向 padding 非零、只按行盒数判的叶子 ${paddedExcluded} 个`)
      + (facts.textsTruncated === true ? `；[截断] 会话头共 ${facts.textsTotal ?? '?'} 个带文本元素，只扫描了前 ${candidates.length} 个（80 是证据上限）` : ''),
    lineageNote,
    ...wrapped.slice(0, 6).map(describeHit),
  ].join('\n')
  if (wrapped.length > 0) return { ok: false, evidence }
  // 扫描截断（80 是证据上限）时「前 80 个没有换行」不是「整页没有换行」：未检查的
  // 元素里可能有换行，只能 INFO（--require-run 下由走查层 applyRequireRun 改判 FAIL）。
  if (facts.textsTruncated === true) {
    return judge(null, `${evidence}\n扫描截断：只检查了前 ${candidates.length} 个带文本元素（共 ${facts.textsTotal ?? '?'} 个，80 是证据上限）——未检查的元素未判定，不能据此判「没有换行」`)
  }
  return { ok: true, evidence }
}

/**
 * 命中盒判定：会话头里的每个可见**控件**两轴都 ≥ 44px。控件 = button ∪ tab
 * （`role="tab"` 的 44px 底线与 button 同一条；tab 盒已由 HEADER_FACTS 采集）。
 * 没有可见控件 ⇒ INFO。同一个元素同时被两条查询命中时按几何去重
 * （button[role=tab] 会同时出现在 buttons 与 tabs 里），去重数写进证据。
 */
export function hitBoxVerdict(facts, minPx = HIT_BOX_MIN_PX) {
  if (facts.hasOutlet !== true) return judge(null, '本次页面没有会话头（无会话/首启）——命中盒未测')
  const controls = []
  const seenGeometry = new Set()
  let deduplicated = 0
  const add = (kind, label, box) => {
    const key = box.w + "×" + box.h + "@" + box.top + "," + box.left
    if (seenGeometry.has(key)) { deduplicated += 1; return }
    seenGeometry.add(key)
    controls.push({ kind, label, box })
  }
  let hidden = 0
  for (const button of facts.buttons ?? []) {
    if (button.visible !== true) { hidden += 1; continue }
    add('button', button.label ?? '', button.box)
  }
  for (const tab of facts.tabs ?? []) {
    // tab 盒没有 visible 字段：0 尺寸即不可见（display:none / 未渲染）。
    if (!(tab.box.w > 0 && tab.box.h > 0)) { hidden += 1; continue }
    add("tab", "role=" + tab.role, tab.box)
  }
  if (controls.length === 0) return judge(null, '会话头里没有可见 button/tab（隐藏/零尺寸 ' + hidden + ' 个）——命中盒未测')
  const small = controls.filter(control => control.box.w < minPx || control.box.h < minPx)
  const describe = control => control.box.w + "×" + control.box.h + (control.label === "" ? "" : "(" + control.label + ")")
  const evidence = [
    "可见控件 " + controls.length + " 个（button+tab 去重后" + (deduplicated > 0 ? "，去重 " + deduplicated + " 个" : "") + "；隐藏/零尺寸 " + hidden + " 个），下限 " + minPx + "px",
    "尺寸=" + controls.map(control => control.kind + ":" + describe(control)).join(" "),
    small.length === 0 ? "" : "不足：" + small.map(control => control.kind + ":" + describe(control)).join(" "),
  ].filter(Boolean).join('\n')
  return { ok: small.length === 0, evidence }
}

/**
 * 新增 M-9 只读探查（design 17 §18.6 的覆盖层/遮挡观察）：枚举 position:fixed|absolute
 * 且计算 z-index>=40 的**可见**元素，报告 rect 超出**布局视口**的项。不点击、不改 DOM。
 *
 * 判定（本文件定义）：**INFO** = 一个覆盖层都没有（未命中，不是通过）；**FAIL** = 某个
 * `position:fixed` 且无 transform/translate 位移的覆盖层超出**布局视口**——fixed 层没有位移
 * 却离开视口就是真实布局溢出。有位移的超出项按"故意移出视口"（抽屉/滑入层）解释并只作证据。
 * **M-9 不走 applyRequireRun**：这个探针只要跑到就完成了它的工作，「页面没有覆盖层」
 * 是合法结论（INFO），不是「该腿没执行」。
 * 基准刻意用布局视口而非 visualViewport：Safari 地址栏/IME 只收缩 visual 视口，用它会把
 * 合法的全屏 fixed 层（右栏面板、抽屉遮罩）误报成溢出；visual 尺寸仍采集并在证据里对照。
 * 上限 40 个命中即截断（scanCapped 写进证据，避免遍历整页元素把证据撑爆）；
 * **截断时「没发现越界项」只能记 INFO**——第 41 个以后没检查过，不能冒充「全页没有越界项」。
 */
export const OVERLAY_FACTS_EXPRESSION = `(() => {
  const vv = window.visualViewport === undefined ? null : window.visualViewport
  // FAIL basis = the LAYOUT viewport. A fixed/absolute element is laid out
  // against it; Safari's bars and the IME shrink only the VISUAL viewport, so
  // judging against the visual size reported every legitimate full-screen fixed
  // layer (rightbar panel, drawer backdrop) as "overflowing". The visual size
  // is still collected and reported as evidence.
  const limitW = Math.round(document.documentElement.clientWidth)
  const limitH = Math.round(document.documentElement.clientHeight)
  const visualW = vv === null ? null : Math.round(vv.width)
  const visualH = vv === null ? null : Math.round(vv.height)
  const overlays = []
  let capped = false
  for (const el of document.querySelectorAll('*')) {
    const style = getComputedStyle(el)
    if (style.position !== 'fixed' && style.position !== 'absolute') continue
    const z = Number.parseInt(style.zIndex, 10)
    if (!Number.isFinite(z) || z < 40) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    if (style.visibility === 'hidden' || style.display === 'none'
      || (style.opacity !== '' && Number(style.opacity) === 0)) continue
    const rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    overlays.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      slot: el.getAttribute('data-slot'),
      position: style.position,
      zIndex: z,
      // 位移属性（transform / 独立的 translate 属性）解释「故意移出视口」的覆盖层。
      displaced: style.transform !== 'none' || (typeof style.translate === 'string' && style.translate !== 'none'),
      rect,
      overflows: rect.x < -1 || rect.y < -1 || rect.x + rect.w > limitW + 1 || rect.y + rect.h > limitH + 1,
    })
    if (overlays.length >= 40) { capped = true; break }
  }
  return { limitW, limitH, visualW, visualH, overlays, scanCapped: capped }
})()`

/**
 * {@link OVERLAY_FACTS_EXPRESSION} 的判定（见其头注）。
 * @param {object} facts
 * @returns {{ok: boolean|null, evidence: string}}
 */
export function overlayProbeVerdict(facts) {
  if (typeof facts.limitW !== 'number' || typeof facts.limitH !== 'number') {
    return judge(null, '拿不到视口尺寸（页面未挂载？）——覆盖层探查未测')
  }
  const overlays = facts.overlays ?? []
  const visualNote = typeof facts.visualW === 'number' && typeof facts.visualH === 'number'
    && (facts.visualW !== facts.limitW || facts.visualH !== facts.limitH)
    ? `visualViewport ${facts.visualW}×${facts.visualH} 与布局视口不一致（地址栏/键盘/缩放）——判定以布局视口为准，visual 只作证据`
    : ''
  const header = `视口 ${facts.limitW}×${facts.limitH}（布局视口基准）${visualNote === '' ? '' : '；' + visualNote}；position:fixed|absolute 且 z-index>=40 的可见元素 ${overlays.length} 个（上限 40${facts.scanCapped === true ? "，已截断" : ""}）`
  if (overlays.length === 0) return judge(null, header + '——只读探查未命中（没有覆盖层），不是“通过”')
  const overflowing = overlays.filter(overlay => overlay.overflows)
  const unexplained = overflowing.filter(overlay => overlay.position === "fixed" && overlay.displaced !== true)
  const describe = overlay => overlay.tag + (overlay.slot === null ? "" : "[data-slot=" + overlay.slot + "]")
    + (overlay.role === null ? "" : "[role=" + overlay.role + "]")
    + " z=" + overlay.zIndex + " " + overlay.position
    + " rect=(" + overlay.rect.x + "," + overlay.rect.y + "," + overlay.rect.w + "×" + overlay.rect.h + ")"
  const capped = facts.scanCapped === true
  const evidence = [
    header,
    overflowing.length === 0
      ? (capped
          ? '已扫描的前 ' + overlays.length + ' 个 rect 都在视口内，但扫描在上限 40 处截断：未扫描到的元素未检查，不能据此判「全页没有越界项」'
          : '全部覆盖层 rect 均在视口内')
      : '超出视口 ' + overflowing.length + ' 个：' + overflowing.slice(0, 8).map(describe).join(' | '),
    '已解释（有 transform/translate 位移）：' + overflowing.filter(overlay => overlay.displaced === true).length + ' 个；未解释（fixed 且无位移）：' + unexplained.length + ' 个',
    unexplained.length === 0 ? '' : '判定 FAIL：fixed 覆盖层既超出视口、又没有位移属性——fixed 层离开视口只能靠位移解释，否则就是真实布局溢出',
  ].filter(Boolean).join('\n')
  // 截断不得冒充通过：上限 40 之前的元素没问题，不等于第 41 个以后没问题。已经扫到的
  // 真溢出仍按 FAIL 报（那是确凿事实）；只有「没发现问题」这一侧要退成 INFO。
  if (unexplained.length > 0) return { ok: false, evidence }
  if (capped) {
    return judge(null, evidence + '\n判定 INFO（扫描截断）：命中数到达上限 40，未命中元素未检查——「已扫描的部分没有越界项」不是「全页没有越界项」')
  }
  return { ok: true, evidence }
}

/**
 * 插件激活判定：模拟成立后，本插件是否真的把 frame 打标了（**判**：打了就是
 * PASS），并把守卫自己的键盘诊断面一并读出来（data-mobile-kbd 帧、state、
 * spacer 高度）。
 *
 * 未打标仍是 INFO 而不是硬 FAIL —— 可能本实例根本没装移动插件（对着别的实例
 * 走查）。但这条腿走 `addGated`/`applyRequireRun`：走查一旦用
 * `--require-run` 声明「插件必须在场」，INFO 就被改判 FAIL，不再靠人工注意。
 */
export function pluginActivationVerdict(facts) {
  const stamped = facts.mobileFrames > 0
  const kbdFrames = facts.mobileKbdFrames ?? 0
  const kbdStates = facts.mobileKbdStates ?? []
  const kbdSpacers = facts.mobileKbdSpacers ?? []
  const evidence = [
    `[data-slot="root"]=${facts.rootSlots} [data-mobile-frame]=${facts.mobileFrames} data-mobile-role=${JSON.stringify(facts.mobileRoles)}`,
    `插件 <style> 注入=${facts.pluginStyle}`,
    `键盘面诊断：[data-mobile-frame][data-mobile-kbd]=${kbdFrames} data-mobile-kbd-state=${JSON.stringify(kbdStates)} spacer 高度=${JSON.stringify(kbdSpacers)}`,
    stamped
      ? '已打标：插件在本次模拟下激活；键盘面诊断字段为空说明本次走查没有 active 会话/键盘面（不是激活失败）'
      : '未打标：要么本实例未装 dsh-chamber-client-ui-mobile，要么插件在本次模拟下未激活——需要人工确认（--require-run 下判 FAIL）',
  ].filter(Boolean).join('\n')
  return { ok: stamped ? true : null, evidence }
}

/**
 * Opt-in strictness for legs that may legitimately not run (`--require-run`).
 *
 * The mobile twin of `checks.mjs`'s `applyRequireHover`, and it exists for the
 * same reason: a verdict of `ok === null` is INFO — the environment did not
 * offer the thing the leg judges (no CDP target, a page that never mounted, no
 * session in the header), so the leg decided nothing. INFO keeps a run green by
 * design, which is exactly how "nothing was exercised" gets misread as
 * "verified"; this helper turns that into a FAIL when the run asked for the leg
 * to really execute. It is a re-labelling ONLY: a verdict that already decided
 * (`ok === true` / `ok === false`) is returned untouched, so a pass stays a pass
 * and an existing failure keeps its own evidence.
 *
 * Not every leg opts in: the M-9 overlay probe is a read-only scan whose completion
 * IS its execution, so the driver records it with `rec.add`, never through this gate.
 *
 * @param {{ok: boolean|null, evidence: string}} verdict
 * @param {boolean} requireRun - whether this run demands the leg actually ran.
 * @returns the original verdict, or its FAIL re-labelling.
 */
export function applyRequireRun(verdict, requireRun) {
  if (requireRun !== true || verdict.ok !== null) return verdict
  return {
    ...verdict,
    ok: false,
    evidence: `${verdict.evidence}（--require-run：本次运行要求该腿必须真实执行）`,
  }
}

/**
 * WebSocket 帧摘要（`Network.webSocketFrameSent/Received` + created/closed/error）。
 * 这是「会话打开停滞」唯一缺的证据来源：帧有没有发出去、上游有没有回。
 *
 * The payload snippets below are the ONE place raw frame bytes leave this module,
 * and the summary is persisted (report md+json) and printed. `redact` is applied
 * to every snippet BEFORE slicing, so a handshake frame carrying
 * `Authorization: Bearer …` cannot ride the summary past the redaction the frame
 * FILE goes through.
 *
 * @param {Array<{direction: string, url?: string, opcode?: number, payload?: string, at?: number}>} frames
 * @param {{redact?: (value: string) => string}} [options]
 * @returns {{counts: object, summary: string}}
 */
export function summarizeWebSocketFrames(frames, { redact = value => value } = {}) {
  const counts = { created: 0, sent: 0, received: 0, closed: 0, error: 0 }
  for (const frame of frames) {
    if (Object.hasOwn(counts, frame.direction)) counts[frame.direction] += 1
  }
  const urls = [...new Set(frames.filter(frame => frame.direction === 'created').map(frame => frame.url ?? '(未知)'))]
  const lastSent = [...frames].reverse().find(frame => frame.direction === 'sent')
  const lastReceived = [...frames].reverse().find(frame => frame.direction === 'received')
  // 截断必须可见：落盘/摘要都是持久层，一个被截断的帧不能只显示前缀而让人
  // 以为那就是全部（原始长度与 truncated 标记由采集层保留）。
  const truncationNote = frame => frame === undefined || frame.truncated !== true
    ? ''
    : `（已截断：原始 ${frame.payloadLength ?? '?'} 字节，落盘仅前 ${frame.payload === undefined ? '?' : String(frame.payload).length} 字节）`
  const truncatedCount = frames.filter(frame => frame.truncated === true).length
  const summary = [
    `created=${counts.created} sent=${counts.sent} received=${counts.received} closed=${counts.closed} error=${counts.error}`,
    urls.length === 0 ? '未观察到 WebSocket 连接' : `连接=${urls.map(url => url.replace(/[?#].*$/, '')).join(', ')}`,
    lastSent === undefined ? '' : `最后一帧上行：opcode=${lastSent.opcode} ${redact(JSON.stringify(lastSent.payload ?? '')).slice(0, 120)}${truncationNote(lastSent)}`,
    lastReceived === undefined ? '' : `最后一帧下行：opcode=${lastReceived.opcode} ${redact(JSON.stringify(lastReceived.payload ?? '')).slice(0, 120)}${truncationNote(lastReceived)}`,
    truncatedCount === 0 ? '' : `截断帧 ${truncatedCount} 个（payloadLength 是原始长度；落盘只保留脱敏后的前缀——需要更长证据时调大 cap）`,
    counts.created > 0 && counts.sent > 0 && counts.received === 0
      ? '有上行、无下行 —— 与「会话打开停滞」的形态一致（值得人工看完整帧文件）'
      : '',
  ].filter(Boolean).join('\n')
  return { counts, summary }
}

/**
 * 凭据脱敏：帧载荷/URL/网络记录里任何等于凭据的值、URL 查询串里的
 * `token|authorization|cookie|password|secret=`，以及 `"token": …` 这类键值，
 * 都替换成 `***`。凭据只从环境变量来、永不打印——WS 帧与 URL 是唯一会把凭据
 * **间接**带出来的通道（握手/首帧/查询串可能带上它），所以任何落盘路径都必须过
 * 这一层：只脱敏 payload 不够，键值规则也不设长度下限，`?token=1`
 * 这种短值同样是凭据。
 *
 * @param {string} text
 * @param {string[]} secrets - 需要完全抹掉的值（去重、忽略空串）。
 * @returns {string}
 */
export function redactSecrets(text, secrets) {
  let out = String(text)
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue
    out = out.split(secret).join('***')
  }
  // JSON escapes one quote as `\u0022`, so an embedded payload can spell the same
  // shape the rules below match — normalize that spelling first, or
  // `{"payload":"{\u0022Authorization\u0022:…}"}` rides through untouched.
  out = out.replace(/\\u0022/g, '"')
  // The key names that carry credentials. A prefix is allowed so the real-world
  // spellings match too: `access_token`, `refreshToken`, `x-api-key`, `apiKey`.
  // `sessionId` / `session_id` / `session-id` (any case) are spelled out: plain
  // `session` cannot reach them, because nothing in the family ends at the `d`.
  const key = '[A-Za-z0-9_.-]*(?:authorization|cookie|password|passwd|pwd|secret|credential|token|api[-_]?key|session[-_]?id|session|jwt|sid)'
  return out
    // URL query / fragment: length is irrelevant (a short token is a credential)
    // and an unrelated `&param` must survive.
    .replace(new RegExp(`([?&#]${key}=)[^&\\s"'<>]*`, 'gi'), '$1***')
    // QUOTED values — JSON, JS object literals, and the escaped-quote form you get
    // when a JSON payload is embedded inside another JSON string. The WHOLE value
    // is consumed: matching only up to the first space redacted the scheme word
    // and left the credential itself on disk.
    .replace(new RegExp(`(${key}(?:\\\\?")?\\s*[:=]\\s*)(\\\\?")[^"\\\\]*(\\\\?")`, 'gi'), '$1$2***$3')
    // COOKIE headers: the whole header value is credentials, however many
    // `a=1; b=2` pairs it has — but the value is taken as ONE unit and the rest of
    // the line is handed back untouched, so this rule can neither unbalance a JSON
    // document (`{"cookie":{"a":1},"next":2}`) nor swallow a following key
    // (`{"cookie":[1,2],"next":2}`). A quoted value was already taken by the rule
    // above, hence the `(?!\\?")` skip.
    .replace(/((?:set-)?cookie(?:\\?")?\s*[:=]\s*)(?!\\?")([^\r\n]*)/gi,
      (match, prefix, rest) => prefix + maskCookieValue(rest, prefix.includes('\\"')))
    // Every other BARE value (header-dump shapes: `Authorization: Bearer X`):
    // one value token, optionally after an auth scheme. Deliberately does NOT run
    // to the end of the line — `"token":{"kind":"opaque","ttl":30}` is a token
    // DESCRIPTOR and redacting into it would produce unbalanced JSON in the very
    // evidence a human reads, while prose after `token:` would lose its tail.
    .replace(new RegExp(`(${key}(?:\\\\?")?\\s*[:=]\\s*)(?!\\\\?")(?:(?:Bearer|Basic|Digest|Token)\\s+)?[^\\s,}&{\\[]+`, 'gi'), '$1***')
}

/**
 * Mask ONE cookie value out of the rest of a line (the text after `Cookie:` /
 * `"cookie":`). A balanced `{…}`/`[…]` literal becomes a QUOTED placeholder —
 * `"***"`, or `\"***\"` when the document around it is escaped (`escaped`) — so
 * the enclosing JSON stays parseable; anything else is a bare header value that
 * ends at the first `,`, `}` or `]`, and the tail is returned untouched (that is
 * what keeps a following key on the same line alive). The cost is deliberate: a
 * `Set-Cookie` Expires date after the first comma survives — a date is not a
 * credential, and swallowing the rest of the line is exactly the bug this rule
 * exists to avoid.
 */
function maskCookieValue(text, escaped) {
  if (text === '') return text
  if (text.startsWith('{') || text.startsWith('[')) {
    const end = balancedLiteralEnd(text)
    if (end > 0) return (escaped ? '\\"***\\"' : '"***"') + text.slice(end)
  }
  const stop = text.search(/[,}\]]/)
  return '***' + (stop === -1 ? '' : text.slice(stop))
}

/**
 * End index (exclusive) of the balanced `{…}`/`[…]` literal at the start of
 * `text`, or -1 when it never closes. String literals are skipped and a
 * backslash escapes the next character, so an embedded JSON document
 * (`{\"cookie\":…}`) cannot confuse the bracket count.
 */
function balancedLiteralEnd(text) {
  const stack = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\\') { i += 1; continue }
    if (ch === '"') {
      i += 1
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i += 1; i += 1 }
      continue
    }
    if (ch === '{' || ch === '[') { stack.push(ch); continue }
    if (ch === '}' || ch === ']') {
      if (stack.length === 0) return -1
      stack.pop()
      if (stack.length === 0) return i + 1
    }
  }
  return -1
}
