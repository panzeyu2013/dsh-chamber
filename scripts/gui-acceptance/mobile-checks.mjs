/**
 * Pure judgement layer of the CDP mobile walkthrough (task: STATUS 2026-09-13
 * 移动档开放项 ⑤ —— `scripts/gui-acceptance/` 只有桌面走查，没有设备模拟)。
 *
 * 与 `checks.mjs` 同一套纪律：这里没有 CDP、没有 DOM、没有 fs —— 只有
 * 「把页面测出来的事实判成 PASS / FAIL / INFO」的纯函数与那两条**页面内探测
 * 表达式**。于是判定逻辑可以用合成事实做负例测试（mobile-checks.test.mjs），
 * 而驱动层（mobile-walkthrough.mjs）只负责连 CDP、装模拟、测量、落盘。
 *
 * 设备模拟的实证结论（Electron 41 / Chromium，2026-09 本机实测；这三条是**测量
 * 边界**，移动档的任何模拟结论都要按它们打折）：
 *   1. `Emulation.setTouchEmulationEnabled({enabled:true})` 是**唯一**能让
 *      `(pointer:coarse)` / `(hover:none)` / `(any-pointer:coarse)` 成立的手段
 *      （maxTouchPoints > 0 ⇒ Blink 的触摸设备判定）；
 *   2. `Emulation.setEmulatedMedia` 的 `pointer`/`hover` 特性被**忽略**——
 *      同一调用里 `prefers-color-scheme` 生效、`pointer`/`hover` 不生效，
 *      所以「用媒体特性覆写伪造 pointer:coarse」这条路不通（重要限制，已登记）；
 *   3. `Emulation.setDeviceMetricsOverride({mobile:true})` 单独**不会**翻转
 *      pointer 媒体特性，且会把 `window.innerWidth` 变成**布局视口**宽度
 *      （收缩适配：390 的设备宽 + 900 宽的内容 ⇒ innerWidth 报 900），
 *      于是「scrollWidth <= innerWidth + 1」这条断言在 mobile:true 下会**假绿**；
 *      真正的 ICB 宽度是 `document.documentElement.clientWidth`。因此溢出判定
 *      两条都算：设备宽（clientWidth）为准，innerWidth 一并报告并注明收缩适配。
 */

/** 移动档设备模型（默认 390×844 / DPR 3 —— STATUS ⑤ 里点名的手机档）。 */
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
    screenWidth: window.screen === undefined ? null : window.screen.width,
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
 */
export const HEADER_FACTS_EXPRESSION = `(() => {
  const HEADER = '[data-slot="conversation.session.header"] > header'
  const SEAT_PREFIX = '[data-slot^="conversation.session.header"]'
  const header = document.querySelector(HEADER)
  const outlet = document.querySelector('[data-slot="conversation.session.header"]')
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
    }
  }
  const hasOwnText = el => [...el.childNodes].some(node => node.nodeType === 3 && node.textContent.trim() !== '')
  const lineage = document.querySelector('[data-slot="conversation.session.header.lineage"]')
  const headerScope = header ?? outlet
  // 候选 = 会话头子树里**直接带文本节点**的元素（含 lineage 自身：count 文本就在
  // 座位元素上，只查后代会漏掉它——首版踩过）。
  const textElements = headerScope === null ? [] : [headerScope, ...headerScope.querySelectorAll('*')]
    .filter(hasOwnText)
    .slice(0, 80)
  const buttons = outlet === null ? [] : [...outlet.querySelectorAll('button')]
  const tabs = headerScope === null ? [] : [...headerScope.querySelectorAll('[role="tablist"], [role="tab"]')]
  return {
    hasOutlet: outlet !== null,
    hasHeader: header !== null,
    headerBox: header === null ? null : rect(header),
    firstRowBox: header === null || header.firstElementChild === null ? null : rect(header.firstElementChild),
    headerChildren: header === null ? [] : [...header.children].map(child => ({ tag: child.tagName.toLowerCase(), box: rect(child) })),
    tabs: tabs.map(el => ({ role: el.getAttribute('role'), box: rect(el) })),
    buttons: buttons.map(el => ({
      label: ((el.innerText || '').trim() || el.getAttribute('aria-label') || '').slice(0, 30),
      visible: visible(el),
      box: rect(el),
    })),
    lineage: lineage === null ? null : { box: rect(lineage), texts: [lineage, ...lineage.querySelectorAll('*')].filter(hasOwnText).map(textFacts) },
    texts: textElements.map(textFacts),
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
 *   几何断言测到的都是**桌面**布局，整轮走查没有意义；这正是 task 要求「明确
 *   报告 CDP 能否伪造 pointer:coarse」的那一条。
 */
export function deviceEmulationVerdict(facts, device = MOBILE_DEVICE) {
  const mediaOk = facts.pointerCoarse === true && facts.hoverNone === true
  const evidence = [
    `请求 ${device.width}×${device.height} @${device.deviceScaleFactor}x mobile=${device.mobile} maxTouchPoints=${device.maxTouchPoints}`,
    `实测 innerWidth=${facts.innerWidth} clientWidth=${facts.clientWidth} dpr=${facts.dpr} maxTouchPoints=${facts.maxTouchPoints} ontouchstart=${facts.ontouchstart}`,
    `媒体特性 pointer:coarse=${facts.pointerCoarse} pointer:fine=${facts.pointerFine} hover:none=${facts.hoverNone} any-pointer:coarse=${facts.anyPointerCoarse}`,
    `档位 touchTier(≤1023&coarse)=${facts.touchTier} phoneTier(≤768&coarse)=${facts.phoneTier}`,
    mediaOk ? '' : 'CDP 限制：pointer/hover 媒体特性只能靠 Emulation.setTouchEmulationEnabled 翻转（setEmulatedMedia 的 pointer/hover 特性被忽略，实测）',
  ].filter(Boolean).join('\n')
  return { ok: mediaOk, evidence }
}

/**
 * 横向溢出判定。两条都算：
 *   - **设备宽基准**（`document.documentElement.clientWidth`，= 模拟设备宽）：
 *     内容比设备宽 = 真的溢出；
 *   - task 写的 `scrollWidth <= innerWidth + 1`：在 `mobile:true` 的收缩适配下
 *     innerWidth 会膨胀到内容宽，这条会假绿——所以它成立**不算通过**，只是
 *     被一起报告；它不成立就一定溢出。
 *
 * @param {object} facts - {@link DEVICE_FACTS_EXPRESSION} 的结果。
 * @param {object} device
 * @returns {{ok: boolean|null, evidence: string}}
 */
export function overflowVerdict(facts, device = MOBILE_DEVICE) {
  if (facts.scrollWidth === null || facts.clientWidth === undefined) return judge(null, '拿不到滚动/视口宽度（页面未挂载？）')
  const deviceLimit = facts.clientWidth + EPSILON
  const taskLimit = facts.innerWidth + EPSILON
  const shrinkToFit = facts.innerWidth > facts.clientWidth + EPSILON
  const ok = facts.scrollWidth <= deviceLimit && facts.scrollWidth <= taskLimit
  const evidence = [
    `scrollWidth=${facts.scrollWidth} clientWidth(设备宽基准)=${facts.clientWidth} innerWidth=${facts.innerWidth} visualViewport=${JSON.stringify(facts.visualViewport)}`,
    `请求设备宽=${device.width}；task 断言 scrollWidth<=innerWidth+1 = ${facts.scrollWidth <= taskLimit}`,
    shrinkToFit
      ? `收缩适配生效：innerWidth(${facts.innerWidth}) > clientWidth(${facts.clientWidth}) —— 此时 task 那条断言恒真、不可作为溢出证据；判定以设备宽为准`
      : '无收缩适配：innerWidth == clientWidth，task 断言与设备宽基准等价',
  ].join('\n')
  return { ok, evidence }
}

/**
 * 会话头首行高度判定（≤ 48px）。header 不存在 ⇒ INFO（无会话可测）。
 */
export function headerFirstRowVerdict(facts, maxPx = HEADER_FIRST_ROW_MAX_PX) {
  if (facts.hasHeader !== true) {
    return judge(null, '本次页面没有 [data-slot="conversation.session.header"] > header（无会话/首启/非会话页）——首行高度未测')
  }
  const row = facts.firstRowBox ?? facts.headerBox
  if (row === null) return judge(null, '会话头存在但拿不到首行几何')
  const evidence = [
    `首行=${facts.firstRowBox === null ? '（header 无元素子节点，退回 header 自身）' : 'header.firstElementChild'} 高 ${row.h}px（上限 ${maxPx}）`,
    `header 高 ${facts.headerBox === null ? '?' : facts.headerBox.h}px；子元素=${facts.headerChildren.map(child => `${child.tag}(${child.box.h})`).join(' ')}`,
    `tab 条=${facts.tabs.map(tab => `${tab.role}(${tab.box.w}×${tab.box.h})`).join(' ') || '（无）'}`,
  ].join('\n')
  return { ok: row.h <= maxPx, evidence }
}

/**
 * 会话头内「单字换行」判定。
 *
 * 两条信号：
 *   - **行盒数 > 1**（精确）：`Range.getClientRects()` 对每个行盒返回一个 rect；
 *   - **高度 > 行高 ×1.5**（task 点名的启发式）：只对「文本叶子」生效——无元素
 *     子节点、非交互控件（button/a/input…）、且 `display` 不是 flex/grid/contents。
 *     不设这个门槛，44px 高的图标按钮（`line-height: normal`）会全部假阳
 *     （本机实测踩过：三个 44×44 的 header 按钮被判成「换行」）。
 *
 * `white-space: nowrap` 的元素按定义不换行（它的溢出是裁切问题，另论）。
 *
 * @returns {{ok: boolean|null, evidence: string}} INFO = 本次会话头里没有可测文本。
 */
export function headerWrapVerdict(facts) {
  if (facts.hasHeader !== true && facts.hasOutlet !== true) return judge(null, '本次页面没有会话头（无会话/首启）——换行未测')
  const candidates = facts.texts ?? []
  if (candidates.length === 0) return judge(null, '会话头内没有带直接文本节点的元素——换行未测')
  const heuristicApplies = item => item.lineBoxes === 1 && item.interactive !== true && item.elementChildren === 0
    && !['flex', 'grid', 'contents', 'inline-flex'].includes(item.display)
  const wrapped = candidates.filter(item => item.whiteSpace !== 'nowrap'
    && (item.lineBoxes > 1 || (heuristicApplies(item) && item.height > item.lineHeight * 1.5)))
  const heuristicHits = wrapped.filter(item => item.lineBoxes === 1).length
  const lineageNote = facts.lineage === null
    ? 'lineage 座位不存在'
    : `lineage count=${JSON.stringify(facts.lineage.texts.map(t => t.text))} 行盒=${facts.lineage.texts.map(t => t.lineBoxes).join(',') || '（座位自身无直接文本）'}`
  const evidence = [
    `扫描 ${candidates.length} 个带文本元素；判为换行 ${wrapped.length} 个（其中高度启发式 ${heuristicHits} 个）`,
    lineageNote,
    ...wrapped.slice(0, 6).map(item => `${item.lineBoxes > 1 ? '行盒' : '高度启发式'}：${JSON.stringify(item.text)}（${item.seat ?? '?'} ${item.tag} 行盒=${item.lineBoxes} 高=${item.height} 行高=${item.lineHeight}(${item.lineHeightSource})）`),
  ].join('\n')
  return { ok: wrapped.length === 0, evidence }
}

/**
 * 命中盒判定：会话头里的每个可见 button 两轴都 ≥ 44px。没有 button ⇒ INFO。
 */
export function hitBoxVerdict(facts, minPx = HIT_BOX_MIN_PX) {
  const buttons = (facts.buttons ?? []).filter(button => button.visible)
  if (facts.hasOutlet !== true) return judge(null, '本次页面没有会话头（无会话/首启）——命中盒未测')
  if (buttons.length === 0) return judge(null, '会话头里没有可见 button ——命中盒未测')
  const small = buttons.filter(button => button.box.w < minPx || button.box.h < minPx)
  const evidence = [
    `可见 button ${buttons.length} 个，下限 ${minPx}px`,
    `尺寸=${buttons.map(button => `${button.box.w}×${button.box.h}${button.label === '' ? '' : `(${button.label})`}`).join(' ')}`,
    small.length === 0 ? '' : `不足：${small.map(button => `${button.box.w}×${button.box.h}(${button.label || '无标签'})`).join(' ')}`,
  ].filter(Boolean).join('\n')
  return { ok: small.length === 0, evidence }
}

/**
 * 插件激活判定（**观察项**）：模拟成立后，本插件是否真的把 frame 打标了。
 * 失败不判 FAIL：可能本实例根本没装移动插件（对着别的实例走查），这条只帮人
 * 分辨「走查环境不对」与「插件在移动档没生效」。
 */
export function pluginActivationVerdict(facts) {
  const stamped = facts.mobileFrames > 0
  const evidence = [
    `[data-slot="root"]=${facts.rootSlots} [data-mobile-frame]=${facts.mobileFrames} data-mobile-role=${JSON.stringify(facts.mobileRoles)}`,
    `插件 <style> 注入=${facts.pluginStyle}`,
    stamped ? '' : '未打标：要么本实例未装 dsh-chamber-client-ui-mobile，要么插件在本次模拟下未激活——需要人工确认（不是断言失败）',
  ].filter(Boolean).join('\n')
  return { ok: null, evidence }
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
 * FILE goes through (2026-12 review).
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
  const summary = [
    `created=${counts.created} sent=${counts.sent} received=${counts.received} closed=${counts.closed} error=${counts.error}`,
    urls.length === 0 ? '未观察到 WebSocket 连接' : `连接=${urls.map(url => url.replace(/[?#].*$/, '')).join(', ')}`,
    lastSent === undefined ? '' : `最后一帧上行：opcode=${lastSent.opcode} ${redact(JSON.stringify(lastSent.payload ?? '')).slice(0, 120)}`,
    lastReceived === undefined ? '' : `最后一帧下行：opcode=${lastReceived.opcode} ${redact(JSON.stringify(lastReceived.payload ?? '')).slice(0, 120)}`,
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
 * 这一层（2026-12 review：旧版只脱敏 payload，且键值规则要求 ≥4 字符，`?token=1`
 * 这种短值会原样留下）。
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
  return out
    // URL query / fragment: length is irrelevant (a short token is a credential)
    // and an unrelated `&param` must survive.
    .replace(/([?&#](?:token|authorization|cookie|password|secret)=)[^&\s"'<>]*/gi, '$1***')
    // QUOTED values — JSON, JS object literals, and the escaped-quote form you
    // get when a JSON payload is embedded inside another JSON string. The WHOLE
    // value is consumed: matching only up to the first space redacted the scheme
    // word and left the credential itself on disk
    // (`"Authorization":"Bearer SECRET"` → `"Authorization":"*** SECRET"`).
    .replace(/((?:token|authorization|cookie|password|secret)(?:\\?")?\s*[:=]\s*)(\\?")[^"\\]*(\\?")/gi, '$1$2***$3')
    // BARE values — header-dump shapes (`Authorization: Bearer X`,
    // `Cookie: a=1; b=2`). Run to the end of the record, never past a query
    // separator or into the next JSON member.
    .replace(/((?:token|authorization|cookie|password|secret)(?:\\?")?\s*[:=]\s*)(?!\\?")([^\r\n},&]*)/gi, '$1***')
}
