/**
 * Browse-tree motion contract: the FLIP animator is a self-owned port of
 * upstream ui-workspace `rows/AnimatedRows.tsx` (design 06 §7), wired to the
 * `data-row-key` attributes the browse tree renders. Two locks:
 * 1. provenance — the port keeps upstream's body byte-for-byte, its constants
 *    and the exit-overlay stylesheet (loud failure when the vendor tree is
 *    absent, like the other vendor-reading locks in this package);
 * 2. wiring — the browse tree renders the wrapper with the complete key list,
 *    one attribute per pushed key, plus the ready/resetKey gates the vendor
 *    component documents (a drag in flight and a view replacement stand down).
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8')

const PORT = read('../../src/client/rows/animated-rows.tsx')
const PORT_CSS = read('../../src/client/rows/animated-rows.module.css')
const SECTION = read('../../src/client/ServerSection.tsx')
const ROWS = read('../../src/client/ServerSectionRows.tsx')

const VENDOR_ROOT = fileURLToPath(new URL('../../../../vendor/harness-packages/@deepseek-ai/', import.meta.url))
const VENDOR_DIR = VENDOR_ROOT + 'dsh-client-ui-workspace/src/client/rows/'
const VENDOR_TSX = VENDOR_DIR + 'AnimatedRows.tsx'
const VENDOR_CSS = VENDOR_DIR + 'AnimatedRows.module.css'
const MISSING = !existsSync(VENDOR_TSX)
const OPT_OUT = process.env.DSH_CHAMBER_VENDOR_ABSENT === 'skip'

if (MISSING) {
  console.error(`[vendor-lockstep] vendor 树未物化：${VENDOR_DIR}`)
  console.error(OPT_OUT
    ? '[vendor-lockstep] DSH_CHAMBER_VENDOR_ABSENT=skip 已显式设置 ⇒ 本文件跳过（CI 不设该变量）。'
    : '[vendor-lockstep] 默认失败：本 lockstep 必须读 pin 住的 vendor 源。'
      + '若确为无 submodule 的本地 worktree，显式设 DSH_CHAMBER_VENDOR_ABSENT=skip。')
}

/** 缺树时：默认按断言失败处理（响亮），只有显式 opt-out 才 skip（仓内同款：vendor-session-fact-contract）。 */
const vendorTest = (name: string, body: () => void): void => {
  test(name, { skip: MISSING && OPT_OUT ? 'vendor tree absent; explicit DSH_CHAMBER_VENDOR_ABSENT=skip' : false }, () => {
    if (MISSING) {
      assert.fail('vendor/harness-packages 未物化：本 lockstep 读 pin 住的 vendor 源，缺树即失败'
        + '（显式 DSH_CHAMBER_VENDOR_ABSENT=skip 才跳过）。')
    }
    body()
  })
}

/** The vendor body (from the import block on) with the CSS specifier normalized. */
const vendorBody = (source: string, cssName: string): string =>
  source.slice(source.indexOf('import { Component')).replace(`'./${cssName}'`, "'./AnimatedRows.module.css'")

test('the port keeps upstream constants and the exit-overlay contract', () => {
  assert.match(PORT, /const ROW_FADE_MS = 100/u)
  assert.match(PORT, /const ROW_GLIDE_MS = 200/u)
  assert.match(PORT, /easing: 'ease-out'/u)
  assert.match(PORT, /fill: 'forwards'/u)
  assert.match(PORT, /clone\.inert = true/u)
  assert.match(PORT, /clone\.removeAttribute\('data-row-key'\)/u)
  assert.match(PORT, /prefers-reduced-motion: reduce/u, 'reduced motion must stand the animator down entirely')
  assert.match(PORT, /animation\.cancel\(\)/u, 'every movement cancels on finish: no frozen invisible row can survive')
  assert.match(PORT, /const nextKeys = new Set\(this\.props\.rowKeys\)/u)
  assert.match(PORT_CSS, /\.exits \{\s*position: absolute;\s*inset: 0;\s*contain: strict;\s*overflow: clip;\s*pointer-events: none;\s*\}/u)
})

vendorTest('the port is byte-identical to the pinned vendor body', () => {
  assert.equal(vendorBody(PORT, 'animated-rows.module.css'), vendorBody(read(VENDOR_TSX), 'AnimatedRows.module.css'),
    'the ported body must stay upstream-verbatim (only the provenance header and the CSS specifier differ)')
  assert.equal(PORT_CSS, read(VENDOR_CSS), 'the exit-overlay stylesheet is a verbatim copy')
})

/** The key families `rowKeys.push` writes, in file order (the render walk's order). */
const pushedFamilies = (source: string): string[] => {
  const out: string[] = []
  for (const line of source.split('\n')) {
    const at = line.indexOf('rowKeys.push(`')
    if (at < 0) continue
    const match = /^rowKeys\.push\(`([^`]+)`\)/u.exec(line.slice(at))
    if (match !== null) out.push(match[1]!.replace(/\$\{.*$/u, ''))
  }
  return out
}

/** The `data-row-key` families the source renders, in file order (the DOM order). */
const keyedFamilies = (source: string): string[] => {
  const out: string[] = []
  for (const line of source.split('\n')) {
    const at = line.indexOf('data-row-key=')
    if (at < 0) continue
    const match = /^(?:\{`([^`]*)`\}|"([^"]*)")/u.exec(line.slice(at + 'data-row-key='.length))
    if (match !== null) out.push((match[1] ?? match[2] ?? '').replace(/\$\{.*$/u, ''))
  }
  return out
}

test('the pushed key order equals the rendered attribute order, one attribute per key', () => {
  // The walk pushes header, the three error-banner families, the row component's
  // session keys, then the disclosure button; `empty` is seeded, not pushed.
  assert.deepEqual(pushedFamilies(SECTION),
    ['workspace:', 'error:workspace:', 'error:workspace-drag:', 'error:open:', 'session:', 'more:'])
  // DOM order: header, the three banner families, the session rows (own component),
  // the disclosure button, then the empty state after the groups.
  assert.deepEqual(keyedFamilies(SECTION),
    ['workspace:', 'error:workspace:', 'error:workspace-drag:', 'error:open:', 'more:', 'empty'])
  assert.deepEqual(keyedFamilies(ROWS), ['session:'])
  // Pairing: dropping the non-data `empty` seed and the child-rendered session rows
  // leaves exactly the same sequence on both sides (a duplicate or an extra key
  // attribute would break this).
  assert.deepEqual(keyedFamilies(SECTION).filter(family => family !== 'empty'),
    pushedFamilies(SECTION).filter(family => family !== 'session:'))
})

test('only the browse branch is wrapped; search and aggregate keep a plain list', () => {
  const browse = SECTION.indexOf('{merged !== undefined ? (')
  const searchList = SECTION.indexOf('<div className={cc.workspaceList}>', browse)
  const aggregateList = SECTION.indexOf('<div className={cc.workspaceList}>', searchList + 1)
  const wrapper = SECTION.indexOf('<AnimatedRows')
  assert.ok(browse >= 0 && searchList > browse && aggregateList > searchList && wrapper > aggregateList,
    'the animator must wrap the last ternary arm (browse), after both plain-list arms')
  assert.equal(SECTION.split('<div className={cc.workspaceList}>').length - 1, 2,
    'exactly two plain list containers: the search and the aggregate-error branches')
  assert.ok(SECTION.indexOf('</AnimatedRows>') > wrapper)
})

test('the wrapper carries the vendor gates', () => {
  assert.match(SECTION, /const rowKeys: string\[\] = server\.workspaces\.length === 0 \? \['empty'\] : \[\]/u)
  assert.match(SECTION, /import \{ AnimatedRows \} from '\.\/rows\/animated-rows\.tsx'/u,
    'the browse tree consumes the local port (registry C16 admits only relative imports of an export function)')
  assert.match(SECTION, /<AnimatedRows[\s\S]{0,900}?rowKeys=\{rowKeys\}/u)
  assert.match(SECTION, /ready=\{server\.aggregateReady === true && workspaceDrag === null && sessionDrag === null\}/u,
    'a drag in flight or an unloaded aggregate must stand the motion down')
  assert.match(SECTION, /resetKey=\{JSON\.stringify\(\[orderBy, sessionRowsExpanded, currentId\]\)\}/u,
    'order, the per-group disclosure and the current session (auto window) replace the view: they settle instead of gliding')
})
