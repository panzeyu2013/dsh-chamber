/**
 * Source-text wiring locks for the alpha.2 panel axis and brand holes.
 *
 * The sidebar shell's ambient dsh declarations are intentionally loose
 * (`Record<string, any>` faces), so a renamed slot key, a dropped inject
 * member, or a missing render site would still typecheck. These assertions
 * pin the three registration surfaces the sidebar owns — the SlotMap
 * declarations, the children/inject wiring, and the render sites — against
 * silent drift, mirroring the git plugin's `slot-contract.test.ts` precedent.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

/**
 * Remove line/block comments while preserving string and template literals.
 * The ordering lock below must not be satisfiable by a `syncPanels()` that only
 * exists inside a comment (2026-09 round-3 W4-12).
 * @param code - the source text.
 * @returns the source with comments replaced by spaces.
 */
function stripComments(code: string): string {
  let out = ''
  let quote: string | undefined
  let line = false
  let block = false
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i]
    const next = code[i + 1]
    if (line) {
      if (ch === '\n') { line = false; out += ch } else out += ' '
      continue
    }
    if (block) {
      if (ch === '*' && next === '/') { block = false; out += '  '; i += 1 } else out += ch === '\n' ? ch : ' '
      continue
    }
    if (quote !== undefined) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '/' && next === '/') { line = true; out += '  '; i += 1; continue }
    if (ch === '/' && next === '*') { block = true; out += '  '; i += 1; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    out += ch
  }
  return out
}

/** Collapse whitespace so formatting changes cannot break a semantic lock. */
function normalize(code: string): string {
  return code.replace(/\s+/g, ' ')
}

const slots = source('../src/client/contract/slots.ts')
const index = source('../src/client/index.ts')
const root = source('../src/client/SidebarRoot.tsx')
const css = source('../src/client/SidebarRoot.module.css')
const locales = source('../src/client/locales.ts')

test('the alpha.2 brand + panellist holes are declared with the official shapes', () => {
  for (const declaration of [
    "'sidebar.brand.mark': { kind: 'single'; scope: 'root'; owner: SidebarBrandMarkOwnerProps }",
    "'sidebar.brand.name': { kind: 'single'; scope: 'root'; owner: SidebarBrandNameOwnerProps }",
    "'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: SidebarPanelIconOwnerProps }",
  ]) {
    assert.ok(slots.includes(declaration), `slots.ts must declare ${declaration}`)
  }
  for (const typeName of [
    'export interface SidebarBrandMarkOwnerProps',
    'export interface SidebarBrandNameOwnerProps',
    'export interface SidebarPanelIconOwnerProps',
    'export interface SidebarPanelMetadata',
  ]) {
    assert.ok(slots.includes(typeName), `slots.ts must declare ${typeName}`)
  }
  // The injected face carries the panel axis; the component props bind it
  // through InjectFace so `hooks.panels` arrives as `usePanels`.
  assert.ok(slots.includes('selectPanel: (id: MainPanelId) => void'), 'injected selectPanel must be typed')
  assert.ok(slots.includes('hooks: { panels: HostObservable<readonly SidebarPanelMetadata[]> }'), 'injected hooks.panels must be typed')
  assert.ok(slots.includes('& InjectFace<SidebarRootInjected>'), 'component props must bind the inject face')
  assert.ok(slots.includes("| 'sidebar.panellist'"), 'component props must render the panellist hole')
})

test('the registration declares every child and wires the panel projection', () => {
  for (const child of [
    "'sidebar.brand.mark': { kind: 'single', scope: 'root' },",
    "'sidebar.brand.name': { kind: 'single', scope: 'root' },",
    "'sidebar.panellist': { kind: 'list', scope: 'root' },",
  ]) {
    assert.ok(index.includes(child), `children must declare ${child}`)
  }
  assert.ok(index.includes("ctx.slots.subscribe('sidebar.panellist', syncPanels)"), 'the ledger subscription must be wired')
  assert.ok(index.includes('hooks: { panels: panels.source }'), 'the projection must ride the inject hooks compartment')
  // 2026-09 二轮：`includes('panels.sync(')` 被 syncPanels 的**定义行**满足，
  // 锁不住「注册后补一次同步」的顺序。改为顺序断言：注册之后必须出现一次
  // 独立调用（上游 ui-sidebar index.ts 同序，见 registry 侧注释）。
  const stripped = stripComments(index)
  const registerAt = stripped.indexOf('ctx.slots.register({')
  const syncCallAt = stripped.search(/^\s*syncPanels\(\);?\s*$/m)
  assert.ok(registerAt !== -1, 'the shell registration must exist')
  assert.ok(syncCallAt > registerAt, 'syncPanels() must run AFTER the slot registration (first-frame list must not be empty)')
  // 语义锁（空白归一化后匹配，抗格式化漂移）：点击直调 ctx.layout.selectPanel。
  const compactIndex = index.replace(/\s+/g, ' ')
  assert.ok(compactIndex.includes('selectPanel: (id) => { ctx.layout.selectPanel(id) }'), 'row clicks must call the layout service directly')
})

test('the registration rides the slots.inject declaration gate (upstream form)', () => {
  // 2026-12 review P3: a bare `ctx.slots.register` into an undeclared key
  // throws, and this shell's parent slot ('sidebar', declared by the layout's
  // 'root' entry) can be declared AFTER this plugin's apply. The upstream
  // ui-sidebar / ui-settings-general / ui-conversation shape waits for the
  // declaration through `ctx.slots.inject` instead of depending on apply
  // order; the wait must stay inside the existing registration effect.
  const compact = normalize(stripComments(index))
  assert.ok(
    compact.includes("ctx.slots.inject('sidebar', () => ctx.slots.register({"),
    "the sidebar must register through ctx.slots.inject('sidebar', …), not a bare register into a parent declaration",
  )
  assert.ok(
    compact.includes("SidebarRoot)), 'dsh-chamber: sidebar slot registration',"),
    'the inject wait must stay inside the labeled registration effect',
  )
})

test('the shell renders the brand holes and the panel rows', () => {
  assert.ok(root.includes("renderSlot('sidebar.brand.mark', { size: 24 }"), 'the brand mark hole must render (with its fallback)')
  assert.ok(root.includes("renderSlot('sidebar.brand.name'"), 'the brand name hole must render')
  assert.ok(root.includes("renderSlot('sidebar.panellist', { size: wide ? 16 : 18, active }"), 'panel rows must render their icon hole')
  assert.ok(root.includes('const panels = (usePanels as PanelsHook)('), 'the shell must read the injected panel snapshot')
  assert.ok(root.includes('const active = usePanelInfo(info => info.activePanelId === id)'), 'each row must derive its own selection state')
  assert.ok(root.includes("t('panels.label')"), 'the panel list needs its accessible label')
  // 空态与宽窄几何：上游「无注册项时不渲染列表及其间距」+ 行按 wide 切换尺寸。
  assert.ok(root.includes('{panels.length > 0 && ('), 'an empty panellist must render nothing (upstream empty state)')
  assert.ok(root.includes('wide={wide}'), 'each row must receive the shell width state')
  assert.ok(normalize(root).includes(normalize('{wide && <span className={clsx(css.panelTitle, css.wide)}>{label}</span>}')), 'the label renders only in the wide state')
  for (const cls of ['panelList', 'panelRow', 'panelActive', 'panelGlyph', 'panelTitle']) {
    assert.ok(css.includes(`.${cls}`), `SidebarRoot.module.css must define .${cls}`)
    assert.ok(root.includes(`css.${cls}`), `SidebarRoot.tsx must use css.${cls}`)
  }
  // Both dictionaries, not just one: the zh and en copies must both exist.
  assert.ok(locales.includes("'panels.label': '全局面板'"), 'the zh panels.label copy must exist')
  assert.ok(locales.includes("'panels.label': 'Global panels'"), 'the en panels.label copy must exist')
})
