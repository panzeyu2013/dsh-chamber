/**
 * Settings-sheet chip predicate tests: the section-switch scroll reset must
 * fire only on a CHIP click (a button whose nearest nav ancestor is the
 * settings nav) — never on the nav title, the options area or the dialog
 * chrome. The decision is pure and duck-typed (same pattern as
 * composer.test.ts's ClosestStub); the INSTALLER wiring (the deferred rAF
 * reset, the scroller walk, installOnce seating) is additionally driven through
 * a minimal DOM double below. The device acceptance gate stays the end-to-end
 * check (§18.6).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  installSettingsSheetScrollReset,
  isSectionChipClick,
  type ChipTargetLike,
} from '../../src/client/settings-sheet.ts'

/** closest() stub: `chain` maps a selector to the node it resolves to. */
class NodeStub implements ChipTargetLike {
  readonly chain: Record<string, NodeStub>
  constructor(chain: Record<string, NodeStub> = {}) { this.chain = chain }
  closest(selector: string): ChipTargetLike | null {
    return this.chain[selector] ?? null
  }
}

test('isSectionChipClick: a chip button inside the settings nav resets', () => {
  // The click target is the chip's inner <svg>/<span>: closest('button')
  // walks up to the official navCell, whose closest('nav') is the settings nav.
  const nav = new NodeStub()
  const chip = new NodeStub({ nav })
  const target = new NodeStub({ button: chip })
  assert.equal(isSectionChipClick(target, nav), true)
})

test('isSectionChipClick: the nav title (no button ancestor) never resets', () => {
  const nav = new NodeStub()
  const title = new NodeStub({ nav })
  assert.equal(isSectionChipClick(title, nav), false)
})

test('isSectionChipClick: a button OUTSIDE the settings nav (Close/actions) never resets', () => {
  const nav = new NodeStub()
  const dialog = new NodeStub()
  const close = new NodeStub({ dialog })
  const target = new NodeStub({ button: close })
  assert.equal(isSectionChipClick(target, nav), false)
})

test('isSectionChipClick: a chip inside a NESTED nav is not the settings nav', () => {
  // closest() returns the nearest nav, so a nested nav cannot impersonate the
  // settings nav (contains() would have accepted it).
  const nav = new NodeStub()
  const nested = new NodeStub({ nav })
  const chip = new NodeStub({ nav: nested })
  const target = new NodeStub({ button: chip })
  assert.equal(isSectionChipClick(target, nav), false)
})

test('isSectionChipClick: null-tolerant on both sides', () => {
  assert.equal(isSectionChipClick(null, new NodeStub()), false)
  assert.equal(isSectionChipClick(new NodeStub(), null), false)
})

// ---------------------------------------------------------------------------
// The INSTALLER, driven through a minimal DOM double: the pure chip predicate
// above cannot see the click wiring, the deferred rAF reset, the scroller walk
// or installOnce's single seat. The installer reads the real
// document/Element/HTMLElement/requestAnimationFrame globals, so this bench
// installs duck-typed doubles for the duration of one test.
// ---------------------------------------------------------------------------

const DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]'
const HEADER_SELECTOR = '[data-slot="settings.header"]'
const SECTION_SELECTOR = '[data-slot="settings.section"]'

/** The element face the installer touches: closest()/querySelector() answers,
 *  a wired parent chain and a lastElementChild. */
class SheetNode {
  readonly closestMap: Record<string, SheetNode | null> = {}
  readonly queryMap: Record<string, SheetNode | null> = {}
  parentElement: SheetNode | null = null
  lastElementChild: SheetNode | null = null
  closest(selector: string): SheetNode | null { return this.closestMap[selector] ?? null }
  querySelector(selector: string): SheetNode | null { return this.queryMap[selector] ?? null }
}

/** A scroller whose writes are logged: resetting an already-zero scrollTop is
 *  invisible without the write log. */
class ScrollNode extends SheetNode {
  readonly writes: number[] = []
  private current = 0
  get scrollTop(): number { return this.current }
  set scrollTop(value: number) { this.current = value; this.writes.push(value) }
}

class ClickDocumentDouble {
  private readonly listeners = new Map<string, Array<(event: never) => void>>()
  addEventListener(type: string, handler: (event: never) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, handler: (event: never) => void): void {
    const list = this.listeners.get(type) ?? []
    const index = list.indexOf(handler)
    if (index !== -1) list.splice(index, 1)
  }
  dispatch(type: string, event: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event as never)
  }
  listenerCount(type: string): number { return (this.listeners.get(type) ?? []).length }
}

interface SheetTree {
  readonly dialog: SheetNode
  /** The click target: the chip's inner span (closest -> button -> chip). */
  readonly chipTarget: SheetNode
  readonly nav: SheetNode
  readonly options: ScrollNode
  readonly column: ScrollNode
  readonly content: ScrollNode
}

/** dialog > nav + content; content > column > options > section outlet. */
function sheetTree(): SheetTree {
  const dialog = new SheetNode()
  const nav = new SheetNode()
  dialog.queryMap[HEADER_SELECTOR] = new SheetNode()
  dialog.queryMap[':scope > nav'] = nav
  const options = new ScrollNode()
  const column = new ScrollNode()
  const content = new ScrollNode()
  const outlet = new SheetNode()
  options.parentElement = column
  column.parentElement = dialog
  outlet.parentElement = options
  dialog.queryMap[SECTION_SELECTOR] = outlet
  dialog.lastElementChild = content
  const chip = new SheetNode()
  chip.closestMap['nav'] = nav
  const chipTarget = new SheetNode()
  chipTarget.closestMap['button'] = chip
  chipTarget.closestMap[DIALOG_SELECTOR] = dialog
  return { dialog, chipTarget, nav, options, column, content }
}

interface SheetEnvironment {
  click(target: unknown): void
  listenerCount(type: string): number
}

/** One deferred frame queue: the reset must run AFTER the section re-render. */
function installFrameQueue(): { flush(): void; restore(): void } {
  const globals = globalThis as unknown as Record<string, unknown>
  const previous = globals.requestAnimationFrame
  const frames: Array<() => void> = []
  globals.requestAnimationFrame = (handler: () => void): number => {
    frames.push(handler)
    return frames.length
  }
  return {
    flush: (): void => { for (const handler of frames.splice(0)) handler() },
    restore: (): void => {
      if (previous === undefined) delete globals.requestAnimationFrame
      else globals.requestAnimationFrame = previous
    },
  }
}

function withSheetDom(run: (env: SheetEnvironment) => void): void {
  const document = new ClickDocumentDouble()
  const globals = globalThis as unknown as Record<string, unknown>
  const names = ['document', 'Element', 'HTMLElement'] as const
  const previous = names.map(name => [name, globals[name]] as const)
  globals.document = document
  globals.Element = SheetNode
  globals.HTMLElement = SheetNode
  try {
    run({
      click: (target: unknown) => document.dispatch('click', { target }),
      listenerCount: (type: string) => document.listenerCount(type),
    })
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete globals[name]
      else globals[name] = value
    }
  }
}

test('installSettingsSheetScrollReset: a chip click resets the whole scroller chain after the frame', () => {
  const frames = installFrameQueue()
  try {
    withSheetDom(env => {
      const tree = sheetTree()
      const dispose = installSettingsSheetScrollReset(() => true)
      try {
        for (const scroller of [tree.options, tree.column, tree.content]) scroller.scrollTop = 480
        for (const scroller of [tree.options, tree.column, tree.content]) scroller.writes.length = 0
        env.click(tree.chipTarget)
        assert.deepEqual(tree.options.writes, [], 'the reset is deferred to the section re-render frame')
        frames.flush()
        // The walk starts at the section outlet's parent and stops at the
        // dialog; the content column (lastElementChild) is the fallback.
        assert.deepEqual(tree.options.writes, [0], 'the options scroller is the sheet\'s scroll seat')
        assert.deepEqual(tree.column.writes, [0], 'an ancestor scroller on the way to the dialog is reset too')
        assert.deepEqual(tree.content.writes, [0], 'the content column fallback is reset')
        assert.equal(tree.options.scrollTop, 0)
        assert.equal(tree.content.scrollTop, 0)
      } finally {
        dispose()
      }
    })
  } finally {
    frames.restore()
  }
})

test('installSettingsSheetScrollReset: a second install seats ONE listener and one reset', () => {
  const frames = installFrameQueue()
  try {
    withSheetDom(env => {
      const tree = sheetTree()
      const first = installSettingsSheetScrollReset(() => true)
      const second = installSettingsSheetScrollReset(() => true)
      try {
        assert.equal(env.listenerCount('click'), 1, 'installOnce: the second install must not add a listener')
        env.click(tree.chipTarget)
        frames.flush()
        assert.deepEqual(tree.options.writes, [0], 'exactly one reset per chip click')
        second()
        assert.equal(env.listenerCount('click'), 1, 'the no-op disposer must not release the live seat')
      } finally {
        second()
        first()
      }
      assert.equal(env.listenerCount('click'), 0)
    })
  } finally {
    frames.restore()
  }
})

test('installSettingsSheetScrollReset: the nav title, a foreign nav, a missing header and a flipped tier never reset', () => {
  const frames = installFrameQueue()
  try {
    withSheetDom(env => {
      const tree = sheetTree()
      let active = true
      const dispose = installSettingsSheetScrollReset(() => active)
      try {
        // The nav TITLE carries no button ancestor: not a chip.
        const title = new SheetNode()
        title.closestMap[DIALOG_SELECTOR] = tree.dialog
        env.click(title)
        // A button in ANOTHER nav (closest('nav') !== the settings nav).
        const foreignNav = new SheetNode()
        const foreignChip = new SheetNode()
        foreignChip.closestMap['nav'] = foreignNav
        const foreignTarget = new SheetNode()
        foreignTarget.closestMap['button'] = foreignChip
        foreignTarget.closestMap[DIALOG_SELECTOR] = tree.dialog
        env.click(foreignTarget)
        // A non-Element target (plain node object).
        env.click({})
        // A flipped tier.
        active = false
        env.click(tree.chipTarget)
        active = true
        // A dialog that does not carry the settings header seat.
        tree.dialog.queryMap[HEADER_SELECTOR] = null
        env.click(tree.chipTarget)
        frames.flush()
        assert.deepEqual(tree.options.writes, [], 'none of these is a section-chip switch')
        assert.deepEqual(tree.content.writes, [])
      } finally {
        dispose()
      }
    })
  } finally {
    frames.restore()
  }
})

test('installSettingsSheetScrollReset: dispose removes the listener and stops resetting', () => {
  const frames = installFrameQueue()
  try {
    withSheetDom(env => {
      const tree = sheetTree()
      const dispose = installSettingsSheetScrollReset(() => true)
      dispose()
      assert.equal(env.listenerCount('click'), 0)
      env.click(tree.chipTarget)
      frames.flush()
      assert.deepEqual(tree.options.writes, [], 'a disposed installer never resets')
    })
  } finally {
    frames.restore()
  }
})
