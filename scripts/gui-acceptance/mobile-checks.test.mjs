/**
 * mobile-checks.test.mjs — CDP 移动走查**判定层**的负例测试（纯函数，无 CDP、无浏览器）。
 * 每条断言喂好/坏两档合成事实：判定**必须**在坏档变红、无法判定时给 INFO 而不是 PASS。
 * 真实浏览器侧只能由 `mobile-walkthrough.mjs` 对活页面跑出来（需要 CDP 目标，不在 CI）；
 * 这里只锁判定语义。跑法：`node --test scripts/gui-acceptance/mobile-checks.test.mjs`。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEVICE_FACTS_EXPRESSION, HEADER_FIRST_ROW_MAX_PX, HIT_BOX_MIN_PX, MOBILE_DEVICE, applyRequireRun,
  deviceEmulationSteps, deviceEmulationVerdict,
  headerFirstRowVerdict, headerWrapVerdict, hitBoxVerdict, overflowVerdict, pluginActivationVerdict,
  redactSecrets, summarizeWebSocketFrames,
} from './mobile-checks.mjs'
/** 一台「模拟成功 + 390 宽 + 无溢出」的设备事实。 */
const deviceFacts = (over = {}) => ({
  innerWidth: 390, innerHeight: 844, clientWidth: 390, clientHeight: 844,
  scrollWidth: 390, scrollHeight: 1200, visualViewport: { width: 390, height: 844, scale: 1 },
  dpr: 3, screenWidth: 390, maxTouchPoints: 5, ontouchstart: true,
  pointerCoarse: true, pointerFine: false, hoverNone: true, anyPointerCoarse: true,
  touchTier: true, phoneTier: true,
  rootSlots: 1, mobileFrames: 1, mobileRoles: ['sidebar', 'conversation', 'details'], pluginStyle: true,
  mobileKbdFrames: 0, mobileKbdStates: [], mobileKbdSpacers: [],
  ...over,
})
/** 一条会话头文本事实。 */
const text = (over = {}) => ({
  text: '12', tag: 'div', display: 'block', elementChildren: 0, interactive: false,
  seat: 'conversation.session.header.lineage', lineBoxes: 1, height: 20, lineHeight: 20,
  lineHeightSource: 'computed', whiteSpace: 'normal', fontSize: 14, ...over,
})
const headerFacts = (over = {}) => ({
  hasOutlet: true, hasHeader: true,
  headerBox: { w: 390, h: 44, top: 0, left: 0 },
  firstRowBox: { w: 390, h: 44, top: 0, left: 0 },
  headerChildren: [{ tag: 'div', box: { w: 390, h: 44, top: 0, left: 0 } }],
  tabs: [], buttons: [{ label: 'A', visible: true, box: { w: 44, h: 44, top: 0, left: 0 } }],
  lineage: { box: { w: 20, h: 20, top: 0, left: 0 }, texts: [text()] },
  texts: [text()], sessionHeaderPresent: true, rootPhase: 'active', ...over,
})

test('设备模拟：pointer:coarse/hover:none 成立才 PASS；不成立即 FAIL（此后几何断言没有意义）', () => {
  assert.equal(deviceEmulationVerdict(deviceFacts()).ok, true)
  const fine = deviceEmulationVerdict(deviceFacts({ pointerCoarse: false, hoverNone: false, pointerFine: true }))
  assert.equal(fine.ok, false)
  assert.match(fine.evidence, /CDP 限制/)
})

test('设备模拟步骤：三项 Emulation 调用，touch 在后（pointer:coarse 的真来源）', () => {
  const steps = deviceEmulationSteps(MOBILE_DEVICE)
  assert.deepEqual(steps.map(step => step.method), [
    'Emulation.setDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled', 'Emulation.setEmitTouchEventsForMouse',
  ])
  assert.equal(steps[0].params.mobile, true)
  assert.equal(steps[1].params.maxTouchPoints, 5)
})

test('溢出：设备宽基准能抓到收缩适配下的真溢出（task 的 innerWidth 断言会假绿）', () => {
  const shrink = overflowVerdict(deviceFacts({ scrollWidth: 900, innerWidth: 900, clientWidth: 390 }))
  assert.equal(shrink.ok, false)
  assert.match(shrink.evidence, /收缩适配/)
  assert.match(shrink.evidence, /scrollWidth<=innerWidth\+1 = true/)
  assert.equal(overflowVerdict(deviceFacts()).ok, true)
  assert.equal(overflowVerdict(deviceFacts({ scrollWidth: 392 })).ok, false)
  // 1px 亚像素容差
  assert.equal(overflowVerdict(deviceFacts({ scrollWidth: 391 })).ok, true)
})

test('溢出：拿不到宽度时 INFO，不冒充通过', () => {
  const verdict = overflowVerdict(deviceFacts({ scrollWidth: null }))
  assert.equal(verdict.ok, null)
})

test('首行高度：> 48px 红；无会话头 INFO', () => {
  assert.equal(headerFirstRowVerdict(headerFacts()).ok, true)
  assert.equal(headerFirstRowVerdict(headerFacts({ firstRowBox: { w: 390, h: HEADER_FIRST_ROW_MAX_PX + 1, top: 0, left: 0 } })).ok, false)
  assert.equal(headerFirstRowVerdict(headerFacts({ hasHeader: false, firstRowBox: null })).ok, null)
})

test('换行：行盒 > 1 即红（精确信号）', () => {
  const wrapped = headerFacts({ texts: [text({ text: '会话计数', lineBoxes: 3, height: 60 })] })
  const verdict = headerWrapVerdict(wrapped)
  assert.equal(verdict.ok, false)
  assert.match(verdict.evidence, /行盒/)
})

test('换行：44px 高的图标按钮不得被高度启发式误判（本机实测踩过的假阳）', () => {
  const buttons = headerFacts({
    texts: [
      text({ text: 'A', tag: 'button', interactive: true, elementChildren: 0, height: 44, lineHeight: 16, lineHeightSource: 'normal×1.2' }),
      text({ text: '会话计数', lineBoxes: 1, height: 20, lineHeight: 20 }),
    ],
  })
  assert.equal(headerWrapVerdict(buttons).ok, true)
})

test('换行：文本叶子高 > 行高×1.5 且行盒=1 时按启发式红（task 点名的写法）', () => {
  const tall = headerFacts({ texts: [text({ height: 40, lineHeight: 20, lineBoxes: 1 })] })
  const verdict = headerWrapVerdict(tall)
  assert.equal(verdict.ok, false)
  assert.match(verdict.evidence, /高度启发式/)
})

test('换行：nowrap 元素按定义不换行', () => {
  assert.equal(headerWrapVerdict(headerFacts({ texts: [text({ whiteSpace: 'nowrap', lineBoxes: 1, height: 60 })] })).ok, true)
})

test('换行：无会话头/无文本 INFO', () => {
  assert.equal(headerWrapVerdict(headerFacts({ hasHeader: false, hasOutlet: false })).ok, null)
  assert.equal(headerWrapVerdict(headerFacts({ texts: [] })).ok, null)
})

test('命中盒：任一轴 < 44px 即红；无可见 button INFO；隐藏按钮不计', () => {
  assert.equal(hitBoxVerdict(headerFacts()).ok, true)
  assert.equal(hitBoxVerdict(headerFacts({ buttons: [{ label: 'A', visible: true, box: { w: 28, h: 28, top: 0, left: 0 } }] })).ok, false)
  assert.equal(hitBoxVerdict(headerFacts({ buttons: [{ label: 'A', visible: true, box: { w: 44, h: HIT_BOX_MIN_PX - 1, top: 0, left: 0 } }] })).ok, false)
  assert.equal(hitBoxVerdict(headerFacts({ buttons: [] })).ok, null)
  assert.equal(hitBoxVerdict(headerFacts({ buttons: [{ label: 'x', visible: false, box: { w: 1, h: 1, top: 0, left: 0 } }] })).ok, null)
  assert.equal(hitBoxVerdict(headerFacts({ hasOutlet: false })).ok, null)
})

test('插件激活：打标即 PASS，未打标是 INFO 且 --require-run 下改判 FAIL（F9）', () => {
  const activated = pluginActivationVerdict(deviceFacts())
  assert.equal(activated.ok, true)
  assert.equal(activated.evidence.includes('未打标'), false)
  assert.match(activated.evidence, /键盘面诊断/)
  const unstamped = pluginActivationVerdict(deviceFacts({ mobileFrames: 0, mobileRoles: [] }))
  assert.equal(unstamped.ok, null)
  assert.match(unstamped.evidence, /未打标/)
  // 走查声明「该腿必须真实执行」时，INFO 不再是免责通道。
  assert.equal(applyRequireRun(unstamped, true).ok, false)
})

test('插件激活证据读出键盘守卫的诊断面（kbd 帧 / state / spacer 高度）', () => {
  const verdict = pluginActivationVerdict(deviceFacts({
    mobileKbdFrames: 1,
    // 载体前缀：状态在 frame 与 <html> 各镜像一份。
    mobileKbdStates: ['frame:still-covered', 'html:still-covered'],
    mobileKbdSpacers: [352],
  }))
  assert.equal(verdict.ok, true)
  assert.match(verdict.evidence, /\[data-mobile-frame\]\[data-mobile-kbd\]=1/)
  assert.match(verdict.evidence, /still-covered/)
  assert.match(verdict.evidence, /spacer 高度=\[352\]/)
})

test('DEVICE_FACTS_EXPRESSION 采集键盘守卫诊断面（M-4 证据的页面来源）', () => {
  // 证据字段不采集 = 人永远看不到；三个锚点各自钉一次。
  for (const anchor of ['[data-mobile-frame][data-mobile-kbd]', '[data-mobile-kbd-state]', '[data-mobile-kbd-spacer]']) {
    assert.ok(DEVICE_FACTS_EXPRESSION.includes(anchor), `DEVICE_FACTS_EXPRESSION must read ${anchor}`)
  }
  for (const field of ['mobileKbdFrames', 'mobileKbdStates', 'mobileKbdSpacers']) {
    assert.ok(DEVICE_FACTS_EXPRESSION.includes(field), `DEVICE_FACTS_EXPRESSION must expose ${field}`)
  }
})

test('WS 帧摘要：有上行无下行 = 停滞形态；计数与 URL 去参数', () => {
  const summary = summarizeWebSocketFrames([
    { direction: 'created', url: 'ws://127.0.0.1:17510/api/remote.mux?token=1' },
    { direction: 'sent', opcode: 1, payload: 'hello' },
  ])
  assert.deepEqual(summary.counts, { created: 1, sent: 1, received: 0, closed: 0, error: 0 })
  assert.match(summary.summary, /有上行、无下行/)
  assert.match(summary.summary, /remote\.mux/)
  assert.ok(!summary.summary.includes('token=1'))
})

test('applyRequireRun：INFO 在 --require-run 下改判 FAIL，已判定的结论原样保留', () => {
  // 规则住在无 IO 的判据层才测得到（CI）；语义与桌面档 checks.mjs 的 applyRequireHover 同构。
  const info = { ok: null, evidence: '本次没有 CDP 目标' }
  assert.deepEqual(applyRequireRun(info, false), info, '默认档：INFO 保持 INFO')
  const strict = applyRequireRun(info, true)
  assert.equal(strict.ok, false)
  assert.match(strict.evidence, /--require-run/)
  assert.match(strict.evidence, /本次没有 CDP 目标/, '原有证据必须保留')
  const passing = { ok: true, evidence: 'ok' }
  assert.deepEqual(applyRequireRun(passing, true), passing, '已通过的不受影响')
  const failing = { ok: false, evidence: '真的失败了' }
  assert.deepEqual(applyRequireRun(failing, true), failing, '已失败的不被覆盖证据')
})

test('脱敏：环境变量 secrets 列表的值也被抹掉（键值形之外的通道）', () => {
  const redacted = redactSecrets('prefix super-secret-token-value suffix', ['super-secret-token-value'])
  assert.ok(!redacted.includes('super-secret-token-value') && redacted.includes('***'))
})

test('脱敏：Bearer/Basic/Cookie 的**值**整段抹掉（只抹方案词等于没抹）', () => {
  // 值必须整段抹掉——只抹方案词等于没抹（`"Authorization":"*** SECRET"` 仍把
  // 凭据写进持久层）；外层 JSON 里的转义引号形（`\"token\":\"x\"`）同样是 WS 帧里真会出现的形状。
  const secret = 'SECRETFRAMETOKEN'
  for (const [name, input] of [
    ['quoted', `{"Authorization":"Bearer ${secret}"}`],
    ['bare', `authorization: Bearer ${secret}`],
    ['basic', 'Authorization: Basic Ym9iOnNlY3JldA=='],
    ['cookie', `Cookie: sid=${secret}; other=1`],
    ['escaped', `{"payload":"{\\"Authorization\\":\\"Bearer ${secret}\\"}"}`],
    ['escaped token', '{"payload":"{\\"token\\":\\"abc12345\\"}"}'],
  ]) {
    const out = redactSecrets(input, [])
    assert.ok(!out.includes(secret), `${name}: ${out}`)
    assert.ok(!out.includes('Ym9iOnNlY3JldA'), `${name}: basic 的 base64 也必须抹掉`)
    assert.ok(!out.includes('abc12345'), `${name}: ${out}`)
  }
  // 不越界：同一条记录里后面的键值不受影响；查询串的其它参数保留。
  assert.match(redactSecrets('Authorization: Bearer x, "next": 1', []), /"next": 1/)
  assert.match(redactSecrets('ws://h/x?token=1&keep=1', []), /keep=1/)
})

test('帧摘要里的 payload 片段也过脱敏（它同样会被落盘/打印）', () => {
  // 摘要里的「最后一帧上/下行」是另一条落盘通道（报告 md+json + M-8 证据 + stdout）。
  const frames = [
    { direction: 'sent', opcode: 1, payload: '{"Authorization":"Bearer SECRETFRAMETOKEN"}' },
    { direction: 'received', opcode: 1, payload: '{"token":"abc12345"}' },
  ]
  const raw = summarizeWebSocketFrames(frames)
  assert.ok(raw.summary.includes('SECRETFRAMETOKEN'), '前提：不注入脱敏时片段是原始的')
  const scrub = value => redactSecrets(String(value), [])
  const safe = summarizeWebSocketFrames(frames, { redact: scrub })
  assert.ok(!safe.summary.includes('SECRETFRAMETOKEN'), safe.summary)
  assert.ok(!safe.summary.includes('abc12345'), safe.summary)
  assert.match(safe.summary, /最后一帧上行：opcode=1/)
})

test('脱敏：URL 查询串里的凭据也抹掉（长度不限——短 token 同样是凭据）', () => {
  // 帧 url / 报告 meta / 网络记录都会落盘，只脱敏 payload 等于把 `?token=…` 写进持久层；键值规则不设长度下限，`token=1` 同样要抹。
  const redacted = redactSecrets('ws://127.0.0.1:17510/api/remote.mux?token=1&keep=1', [])
  assert.ok(!redacted.includes('token=1'), redacted)
  assert.match(redacted, /token=\*\*\*/)
  assert.match(redacted, /keep=1/, 'unrelated query parameters stay readable')
  const headers = redactSecrets('https://h/p?password=pw&cookie=session-abc', [])
  assert.ok(!headers.includes('password=pw'), headers)
  assert.ok(!headers.includes('cookie=session-abc'), headers)
  // A query VALUE is one unit even though `,` and `;` are legal in a URL: only the query rule can take
  // the whole thing, so this is the case that pins it.
  const comma = redactSecrets('ws://h/x?token=abc,def&keep=1', [])
  assert.ok(!comma.includes('def'), comma)
  assert.match(comma, /token=\*\*\*&keep=1/)
  assert.ok(!redactSecrets('ws://h/x?token=a;b', []).includes(';b'))
  // The FRAGMENT half needs its own case: a `?token=` one cannot fail when
  // fragment support is removed, and neither the `#token=SECRET` case nor
  // `?token=abc,def` pins `#`.
  const fragment = redactSecrets('https://h/#token=abc,def', [])
  assert.ok(!fragment.includes('def'), fragment)
  assert.match(fragment, /#token=\*\*\*/)
})
