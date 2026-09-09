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
  assert.ok(index.includes('panels.sync('), 'the projection must be re-read from the ledger')
  assert.ok(index.includes('hooks: { panels: panels.source }'), 'the projection must ride the inject hooks compartment')
  assert.ok(index.includes('selectPanel: (id) => { ctx.layout.selectPanel(id) }'), 'row clicks must call the layout service directly')
})

test('the shell renders the brand holes and the panel rows', () => {
  assert.ok(root.includes("renderSlot('sidebar.brand.mark', { size: 24 }"), 'the brand mark hole must render (with its fallback)')
  assert.ok(root.includes("renderSlot('sidebar.brand.name'"), 'the brand name hole must render')
  assert.ok(root.includes("renderSlot('sidebar.panellist', { size: wide ? 16 : 18, active }"), 'panel rows must render their icon hole')
  assert.ok(root.includes('const panels = (usePanels as PanelsHook)('), 'the shell must read the injected panel snapshot')
  assert.ok(root.includes('const active = usePanelInfo(info => info.activePanelId === id)'), 'each row must derive its own selection state')
  assert.ok(root.includes("t('panels.label')"), 'the panel list needs its accessible label')
  for (const cls of ['panelList', 'panelRow', 'panelActive', 'panelGlyph', 'panelTitle']) {
    assert.ok(css.includes(`.${cls}`), `SidebarRoot.module.css must define .${cls}`)
    assert.ok(root.includes(`css.${cls}`), `SidebarRoot.tsx must use css.${cls}`)
  }
  assert.ok(locales.includes("'panels.label'"), 'the panels.label copy must exist in both dictionaries')
})
