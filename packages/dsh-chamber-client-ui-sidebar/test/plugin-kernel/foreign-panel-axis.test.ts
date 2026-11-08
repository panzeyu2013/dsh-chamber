/**
 * 非活动来源的面板轴回落（N-ctx，design 05 §2 / design 06 §4.7 的两档补充）源码文本锁。
 *
 * 本包 tests 跑在 plain node 下（无 DOM/React），因此锁的是五个面的接线与合同：
 *
 * 1. core 的页面级单例（client-core panel-axis.ts，API 冻结）：类型/常量/函数签名；
 * 2. 每个挂载壳的发布/退役 + 一次性 selectPanel 意图消费（src/client/index.ts 两个 effect；
 *    含 first-screen 侧栏先于 extra-row panellist 注册的 boot 竞态：意图挂起等注册，TTL 才丢）；
 * 3. **每个 server 头按来源**读页面级快照（ServerSectionHeader 的 useSyncExternalStore +
 *    per-source 选择器；不进 SidebarRoot/section 共用 context，避免行 memo 白算）；
 * 4. server 头两档选择（已发布优先；未挂载且 connected 才回落默认组合）与点击链纪律
 *    （先切来源再武装意图；本壳绝不替别的 ctx 调 selectPanel；未注册 id 不调用）；
 * 5. 回落字形（schedules → 时钟）/默认条目/词典转录，以及「foreign 入口不用 renderSlot」。
 *
 * 全部是 stripComments + normalize 后的文本锁与纯断言；不 import React/TSX。
 * Run directly: node test/plugin-kernel/foreign-panel-axis.test.ts
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const read = (relative: string): string => stripComments(readFileSync(new URL(relative, import.meta.url), 'utf8'))

const root = read('../../src/client/SidebarRoot.tsx')
const index = read('../../src/client/index.ts')
const header = read('../../src/client/ServerSectionHeader.tsx')
const chrome = read('../../src/client/sidebar-root-chrome.tsx')
const axis = read('../../src/client/remote-panel-axis.tsx')
const context = read('../../src/client/sidebar-context.ts')
const locales = read('../../src/client/locales.ts')
// 冻结的 core 合同（跨包源码锁）：API 已冻结，消费者测试必须能看见同一面。
const CORE_DIR = new URL('../../../../packages/dsh-chamber-client-core/src/', import.meta.url)
const coreAxis = stripComments(readFileSync(new URL('panel-axis.ts', CORE_DIR), 'utf8'))
const coreBarrel = stripComments(readFileSync(new URL('index.ts', CORE_DIR), 'utf8'))

/** body of the first brace block opened at or after openAt. */
function braceBody(text: string, openAt: number): string {
  let depth = 0
  for (let i = openAt; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(openAt + 1, i)
    }
  }
  throw new Error('unbalanced braces at ' + String(openAt))
}

/** normalized body of one interface declaration. */
function interfaceBody(source: string, name: string): string {
  const at = source.indexOf('export interface ' + name)
  assert.notEqual(at, -1, name + ' must exist in the core axis module')
  return normalize(braceBody(source, source.indexOf('{', at)))
}
/** named members of every import of one bare package face (whitespace-collapsed). */
function packageImports(source: string, specifier: string): string[] {
  const collapsed = normalize(source)
  const marker = "} from '" + specifier + "'"
  const members: string[] = []
  let from = 0
  for (;;) {
    const end = collapsed.indexOf(marker, from)
    if (end === -1) return members
    const open = collapsed.lastIndexOf('{', end)
    if (open !== -1) members.push(collapsed.slice(open + 1, end))
    from = end + marker.length
  }
}

test('the frozen core page-level panel axis contract exists', () => {
  const entry = interfaceBody(coreAxis, 'PagePanelAxisEntry')
  assert.match(entry, /readonly id: string/)
  assert.match(entry, /readonly order: number/)
  assert.match(entry, /readonly label: string/)
  const request = interfaceBody(coreAxis, 'PanelSelectRequest')
  assert.match(request, /readonly sourceId: string/)
  assert.match(request, /readonly panelId: string/)
  assert.match(normalize(coreAxis), /export const PANEL_SELECT_INTENT_TTL_MS = 15_000/,
    'the one-shot intent lifetime is 15s (never a durable intent)')
  const functions = [
    'publishPanelAxis', 'retirePanelAxis', 'getPanelAxesSnapshot', 'subscribePanelAxes',
    'requestPanelSelect', 'onPanelSelectRequest', 'consumePanelSelect',
  ]
  for (const name of functions) {
    assert.match(normalize(coreAxis), new RegExp('export function ' + name + '\\('), name + ' must stay exported')
    assert.ok(normalize(coreBarrel).includes(name), name + ' must be re-exported by the core barrel')
  }
  // The test-only reset seam stays internal to the module (its own test imports the face
  // directly): consumers must never reset the page-wide axis from production code.
  assert.match(normalize(coreAxis), /export function __resetPanelAxisForTests()/)
  assert.ok(!normalize(coreBarrel).includes('__resetPanelAxisForTests'),
    'the reset seam must not reach the consumer barrel')
  const consumeAt = coreAxis.indexOf('export function consumePanelSelect')
  assert.notEqual(consumeAt, -1)
  assert.match(coreAxis.slice(consumeAt, consumeAt + 700),
    /\{ readonly panelId: string; readonly at: number \} \| undefined/,
    'consumePanelSelect returns the panel id AND its original click instant (or undefined for nothing/expired)')
  assert.match(coreBarrel, /export type \* from '\.\/panel-axis\.ts'/,
    'the entry/request types ride the barrel type face')
})

test('every mounted shell publishes its own axis and retires it on teardown', () => {
  const axisImport = packageImports(index, '@dsh-chamber/dsh-chamber-client-core')
    .find(names => names.includes('publishPanelAxis'))
  assert.ok(axisImport !== undefined, 'the axis API is imported from the core barrel')
  for (const name of [
    'publishPanelAxis', 'retirePanelAxis', 'consumePanelSelect', 'onPanelSelectRequest',
    'requestPanelSelect', 'PANEL_SELECT_INTENT_TTL_MS',
  ]) assert.ok(axisImport.includes(name), name + ' is part of the page-axis import')

  assert.equal((index.match(/const instanceId = \(ctx as any\)\.chamberInstanceId as string \| undefined/g) ?? []).length, 2,
    'both effects scope to the immutable per-entry instance id')
  assert.equal((index.match(/if \(instanceId === undefined\) return/g) ?? []).length, 2,
    'a shell with no instance id (non-chamber boot) wires neither effect')

  assert.match(index, /publishPanelAxis\(instanceId, panels\.source\.getSnapshot\(\)\)/,
    'the publication mirrors the panel-source snapshot (id/order/label are this ctx authority)')
  assert.match(index, /const off = panels\.source\.subscribe\(publish\)/,
    'later registrations/locale relabels republish through the source subscription')
  const publishAt = index.indexOf('publishPanelAxis(instanceId, panels.source.getSnapshot())')
  const subscribeAt = index.indexOf('const off = panels.source.subscribe(publish)')
  assert.ok(publishAt !== -1 && publishAt < subscribeAt, 'the first publication precedes the subscription')
  assert.match(normalize(index), /return \(\) => \{ off\(\) retirePanelAxis\(instanceId\) \}/,
    'teardown unsubscribes and retires the source axis')
  assert.ok(index.includes("'dsh-chamber: page panel-axis publication'"),
    'the publication effect is labelled')
})

test('the select intent consumer resolves only for its own source and holds a boot-late panel instead of dropping the intent', () => {
  assert.ok(index.includes("'dsh-chamber: page panel-select intent'"), 'the consumer effect is labelled')
  const labelAt = index.indexOf("'dsh-chamber: page panel-select intent'")
  const effectAt = index.lastIndexOf('ctx.effect(() => {', labelAt)
  assert.ok(effectAt !== -1 && labelAt > effectAt, 'the labelled consumer effect block is locatable')
  const effect = index.slice(effectAt, labelAt)
  // Boot race: the sidebar is first-screen sync while panellist registrants are host-graph
  // extra rows. The consumer must observe the panel axis instead of judging registration
  // once at mount -- an intent that arrives before the registration must NOT be dropped.
  assert.match(effect, /const offPanels = panels\.source\.subscribe\(tryResolve\)/,
    'the consumer subscribes to the panel axis so an extra-row registration wakes the held intent')
  assert.match(effect, /const offSelect = onPanelSelectRequest\(\(request\) => \{/,
    'later intents arrive through the page-level listener')
  assert.match(effect, /if \(request\.sourceId !== instanceId\) return/,
    'only the addressed source executes the intent')
  // Teardown: release the two listeners FIRST, then hand an unresolved locally held intent
  // back to the core pending — a shell released in the async-teardown window must not take
  // the click with it; the next generation's apply consumes it. The re-arm PRESERVES the
  // original TTL (armedAt as the injected clock) and drops an already-expired intent.
  assert.match(normalize(effect),
    /return \(\) => \{ offPanels\(\) offSelect\(\) if \(pendingPanelId !== undefined\) \{ const remaining = PANEL_SELECT_INTENT_TTL_MS - \(performance\.now\(\) - armedAt\) if \(remaining > 0\) requestPanelSelect\(\{ sourceId: instanceId, panelId: pendingPanelId \}, armedAt\) pendingPanelId = undefined \} \}/,
    'teardown releases both listeners before re-arming the unresolved held intent, preserving its original TTL and dropping an expired one')
  assert.ok(!/setTimeout|setInterval/.test(effect),
    'the local TTL is checked on axis changes only -- no timer may outlive the shell')

  // The held intent: local variable, resolved when the panel appears, discarded only by the
  // core TTL (never by a single too-early registration check).
  const tryAt = effect.indexOf('const tryResolve = (): void => {')
  assert.notEqual(tryAt, -1, 'the retry resolver exists')
  const resolver = normalize(braceBody(effect, effect.indexOf('{', tryAt)))
  assert.match(resolver, /const panelId = pendingPanelId if \(panelId === undefined\) return/,
    'nothing held -> nothing to resolve')
  assert.match(resolver,
    /if \(performance\.now\(\) - armedAt > PANEL_SELECT_INTENT_TTL_MS\) \{ pendingPanelId = undefined return \}/,
    'ONLY the core TTL discards a held intent (checked when the axis changes)')
  assert.match(resolver, /if \(!panels\.source\.getSnapshot\(\)\.some\(panel => panel\.id === panelId\)\) return/,
    'a not-yet-registered panel returns with the intent still held')
  const ttlDropAt = resolver.indexOf('pendingPanelId = undefined')
  const unregisteredAt = resolver.indexOf('!panels.source.getSnapshot().some')
  const successClearAt = resolver.indexOf('pendingPanelId = undefined', unregisteredAt)
  const selectAt = resolver.indexOf('selectIfRegistered(panelId)')
  assert.ok(ttlDropAt !== -1 && unregisteredAt > ttlDropAt,
    'the TTL discard branch precedes the registration check')
  assert.ok(successClearAt > unregisteredAt, 'the held id is cleared only after registration is observed')
  assert.ok(selectAt > successClearAt, 'selection runs only after the panel is confirmed registered')
  assert.match(normalize(effect),
    /const arm = \(panelId: string, at = performance\.now\(\)\): void => \{ pendingPanelId = panelId armedAt = at tryResolve\(\) \}/,
    'arming carries the ORIGINAL click instant (mount consumption passes pending.at; a listener click defaults to now)')
  assert.match(normalize(effect),
    /const pending = consumePanelSelect\(instanceId\) if \(pending !== undefined\) arm\(pending\.panelId, pending\.at\)/,
    'the mount-time consumption keeps the original click instant, so a shell handoff cannot renew the TTL')
  assert.match(normalize(effect), /consumePanelSelect\(instanceId\) arm\(request\.panelId\)/,
    'an intent received by the listener clears the core pending and is held locally')
  assert.equal((index.match(/consumePanelSelect\(instanceId\)/g) ?? []).length, 2,
    'one core pending slot per source: mount consumption + listener clearing')
  assert.match(normalize(index),
    /try \{ ctx\.layout\.selectPanel\(panelId as Parameters<typeof ctx\.layout\.selectPanel>\[0\]\) \} catch \(error\) \{ console\.error\('\[dsh-chamber\] panel select failed:', error\) \}/,
    'a selectPanel throw is contained (the intent must not break the shell)')
})

test('each source header subscribes to the page-level axis per source (no shared-context churn)', () => {
  // 页面快照在 header 内按 source id 订阅：getSnapshot 返回该来源自己的稳定数组引用，未变化
  // 时 React bail out。**不**把整张快照放进 section 共用 context——否则每个后台壳的挂载 /
  // 面板注册都会换 ctxValue，令 memo(ServerSection)/memo(SessionRow) 全部白算（detail:
  // row-render-cost.test.ts 的 ctxValue 键/deps 动态对账与上方 memo 纪律）。
  assert.match(normalize(header), /import \{[^}]*useSyncExternalStore[^}]*\} from 'react'/,
    'the page snapshot is a render source (not an effect-only read)')
  const axisImport = packageImports(header, '@dsh-chamber/dsh-chamber-client-core')
    .find(names => names.includes('getPanelAxesSnapshot'))
  assert.ok(axisImport !== undefined && axisImport.includes('subscribePanelAxes'),
    'the header owns the getPanelAxesSnapshot + subscribePanelAxes pair')
  assert.match(normalize(header),
    /const foreignPanelAxis = useSyncExternalStore\( subscribePanelAxes, \(\) => getPanelAxesSnapshot\(\)\[server\.id\]/,
    'the selector reads THIS source entry, so an unrelated publish returns the same reference and bails out')
  assert.match(normalize(header), /const fallbackPanels = useMemo\(\(\) => defaultForeignPanelEntries\(t\), \[t\]\)/,
    'the default-composition fallback is memoized on the dictionary (headers re-render on local hover state)')
  // Negative lock: the header must NOT destructure the retired shared-context field (a
  // stray binding is invisible to the placement/row locks and only tsc would catch it).
  assert.ok(!normalize(header).includes('foreignPanels'),
    'the header reads the page axis ONLY through its per-source subscription, never the retired context field')
  assert.ok(!normalize(root).includes('foreignPanels'),
    'the shell root no longer carries the page axis (that would churn the section context)')
  assert.ok(!normalize(root).includes('subscribePanelAxes'),
    'no page-wide axis subscription in the shell root')
  assert.ok(!normalize(context).includes('foreignPanels'),
    'the shared section context carries no page-wide axis snapshot')
  // 非活动来源的入口仍然只从「已发布快照 ?? connected 时的默认组合」选择，且与 header/rail
  // 共用激活门（不可激活来源不渲染：点击第一步就是切来源）。
  assert.match(normalize(header),
    /const foreign = server\.id !== chamberInstanceId && headerActivatable \? \(foreignPanelAxis \?\? \(server\.connected \? fallbackPanels : NO_FOREIGN_PANELS\)\) : NO_FOREIGN_PANELS/,
    'the header reads its own axis entry first, then the connected-only default composition, and never promises an activation the header itself refuses')
})

test('the non-active header renders the two tiers: published entries first, default composition only when connected', () => {
  assert.match(normalize(header),
    /const foreign = server\.id !== chamberInstanceId && headerActivatable \? \(foreignPanelAxis \?\? \(server\.connected \? fallbackPanels : NO_FOREIGN_PANELS\)\) : NO_FOREIGN_PANELS/,
    'owning sources render no foreign tier; published axes win over the fallback; the fallback is connection-gated; the activation gate matches header/rail')
  const selectionAt = header.indexOf('const foreign = server.id !== chamberInstanceId')
  const publishedAt = header.indexOf('foreignPanelAxis ??', selectionAt)
  const connectedAt = header.indexOf('server.connected ? fallbackPanels', selectionAt)
  assert.ok(selectionAt !== -1 && publishedAt !== -1 && connectedAt !== -1 && publishedAt < connectedAt,
    'the published snapshot is the first truth; the default composition is only the fallback')
  // Owning tier unchanged: same gate + same entry form + same in-shell selector.
  assert.match(normalize(header), /\{server\.id === chamberInstanceId && panels\.map\(panel => \(/,
    'the owning branch keeps its gate and ledger')
  assert.match(normalize(header), /<PanelHeaderEntry key=\{panel\.id\} id=\{panel\.id\} label=\{panel\.label\}/)
  // Foreign tier placement: after the owning map, before the view-options control.
  const owningAt = header.indexOf('panels.map(panel =>')
  const foreignAt = header.indexOf('foreign.map(entry =>')
  const viewOptionsAt = header.indexOf('cc.sortActive')
  assert.ok(owningAt !== -1 && foreignAt > owningAt && viewOptionsAt > foreignAt,
    'the foreign tier follows the owning entries in the same action cluster')
  // Unknown panel ids render nothing; the glyph table is the only gate.
  assert.match(normalize(header),
    /const glyph = foreignPanelGlyph\(entry\.id\) return glyph === undefined \? null : \( <ForeignPanelHeaderEntry key=\{entry\.id\} label=\{entry\.label\} glyph=\{glyph\}/,
    'a panel id without a known glyph is dropped instead of getting a meaningless icon')
  // Foreign entries never renderSlot / never select this shell layout.
  const foreignBlock = header.slice(foreignAt, header.indexOf('})}', foreignAt))
  assert.ok(!foreignBlock.includes('renderSlot'), 'the foreign form cannot renderSlot another ctx registration')
  assert.ok(!foreignBlock.includes('selectPanel('), 'the foreign form does not select THIS shell layout')
  // Click chain: switch first, then arm the one-shot intent for the target shell.
  assert.match(normalize(header),
    /onSelect=\{\(\) => \{ if \(suppressClickRef\.current\) return clearPendingClick\(\) chamberBridge\.requestActivateSource\(server\.id\) requestPanelSelect\(\{ sourceId: server\.id, panelId: entry\.id \}\) \}\}/,
    'the click rides the same suppress/pending gates as its sibling actions')
  const activateAt = foreignBlock.indexOf('chamberBridge.requestActivateSource(server.id)')
  const intentAt = foreignBlock.indexOf('requestPanelSelect({ sourceId: server.id, panelId: entry.id })')
  assert.ok(activateAt !== -1 && intentAt > activateAt,
    'activate the source BEFORE arming the intent (the target shell consumes it)')
})

test('the foreign entry form, the fallback axis table and the transcribed dictionary copy are pinned', () => {
  const entryAt = chrome.indexOf('export function ForeignPanelHeaderEntry')
  assert.notEqual(entryAt, -1, 'the header entry form exists')
  const form = normalize(chrome.slice(entryAt))
  assert.match(form, /className=\{cc\.actionIcon\}/, 'same compact 20px header box as the owning entry')
  assert.match(form, /aria-label=\{label\}/)
  assert.match(form, /<Tooltip label=\{label\} side="bottom" delayMs=\{500\}>/,
    'the header tooltip form matches the owning entry')
  assert.match(form, /<span className=\{css\.panelGlyph\} aria-hidden="true"> \{glyph\} <\/span>/,
    'the caller-supplied glyph is the decorative child of the shared glyph slot')
  assert.match(form, /onClick=\{\(event\) => \{ event\.stopPropagation\(\) onSelect\(\) \}\}/,
    'the click stops the header-activation bubble and forwards to the caller gate')
  assert.doesNotMatch(form, /\bactive\b/, 'a foreign source has no selected state on this page')
  assert.doesNotMatch(form, /aria-current/, 'no faked aria-current for another source panel')
  assert.doesNotMatch(form, /renderSlot/, 'the foreign form never hand-rolls a slot binding')

  assert.match(normalize(axis),
    /import \{ IconClockOutlineRegular \} from '@deepseek-ai\/dsh-client-ui-primitives'/)
  assert.match(normalize(axis),
    /const FOREIGN_PANEL_GLYPHS: Readonly<Record<string, ReactNode>> = \{ schedules: <IconClockOutlineRegular size=\{14\} \/>, \}/,
    'the only known upstream panellist id falls back to the clock at the header icon size')
  assert.match(normalize(axis),
    /export function foreignPanelGlyph\(id: string\): ReactNode \| undefined \{ return FOREIGN_PANEL_GLYPHS\[id\] \}/,
    'unknown ids resolve to undefined (not rendered)')
  assert.match(normalize(axis), /export const DEFAULT_FOREIGN_PANEL_ID = 'schedules'/)
  assert.match(normalize(axis),
    /export function defaultForeignPanelEntries\(t: \(key: string\) => string\): readonly PagePanelAxisEntry\[\] \{ return \[\{ id: DEFAULT_FOREIGN_PANEL_ID, order: 10, label: t\('panel\.schedules'\) \}\] \}/,
    'the default composition is exactly the pin schedule panel, order 10, localised label')
  assert.ok(!axis.includes('renderSlot') && !axis.includes('selectPanel('),
    'the fallback axis is glyph+label data only (no slot render, no selection)')

  assert.match(normalize(locales), /'panel\.schedules': '自动化任务'/,
    'zh copy transcribed verbatim from vendor ui-schedule task-manager-locales.ts')
  assert.match(normalize(locales), /'panel\.schedules': 'Automation tasks'/,
    'en copy transcribed verbatim from the same upstream face')
  assert.equal((locales.match(/'panel\.schedules'/g) ?? []).length, 2,
    'one key per dictionary (zh/en), no shadowing entries')

  // The foreign entry must not hand-roll a panel slot binding: the whole client tree
  // keeps exactly the two bindings the owning entry and the rail row own.
  const CLIENT_DIR = new URL('../../src/client/', import.meta.url)
  const bindings = (readdirSync(CLIENT_DIR, { recursive: true }) as string[])
    .filter(name => /\.(?:ts|tsx)$/u.test(name))
    .reduce((sum, name) => sum + (stripComments(readFileSync(new URL(name, CLIENT_DIR), 'utf8'))
      .match(/renderSlot\('sidebar\.panellist'/g) ?? []).length, 0)
  assert.equal(bindings, 2,
    'exactly two panellist slot bindings in the whole client tree (owning header entry + rail row)')
})
