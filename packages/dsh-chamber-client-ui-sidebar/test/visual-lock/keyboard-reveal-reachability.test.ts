/**
 * Source lock for the KEYBOARD-REVEAL reachability fix (design 08 §3.2).
 *
 * The hover/kebab action clusters (`.rowActions`, the git occupant, and the
 * source header's `.sourceActions`) are `display: none` at rest, so their buttons
 * are not in the Tab order. The keyboard reveal used to be a CSS
 * `:has(:focus-visible)` display change — which LOOKS revealed but is NOT
 * reachable: Blink's Tab navigation does not treat an element whose display was
 * flipped by a `:has()` invalidation as focusable. Controlled experiment (one page,
 * identical CSS, real CDP key events, with and without forced frames): a
 * `:focus-within`-revealed cluster let Tab through to its buttons, a
 * `:has(:focus-visible)`-revealed cluster was skipped (focus jumped to the next
 * row's control), and a JS-applied class worked. The keyboard reveal therefore
 * rides the JS state that already reveals the cluster — `.rowActionsVisible`
 * (kebab open) / `.sourceActionsVisible` — armed only for `:focus-visible` targets
 * so a pointer click cannot pin the cluster open.
 *
 * Pinned here: (1) both header components arm the reveal class from a keyboard
 * focus state gated on `:focus-visible`, and clear it only when focus leaves the
 * whole header row; (2) the SIDEBAR stylesheet re-introduces no `:focus-visible`
 * display flip for these hooks — the visual layer is hover + the class. (A
 * plugin's own sheet is out of this lock's scope: the host owns the reveal.)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

/** Comment-stripped sources: a lock must never be satisfied by a comment. */
const source = (relative: string): string =>
  stripComments(readFileSync(new URL(relative, import.meta.url), 'utf8'))

const section = source('../../src/client/ServerSection.tsx')
const header = source('../../src/client/ServerSectionHeader.tsx')
const sidebarCss = source('../../src/client/sidebar-chamber.module.css')
const model = source('../../src/client/server-section-model.ts')

test('the workspace row arms .rowActionsVisible from keyboard focus', () => {
  assert.match(
    section,
    /const \[keyboardFocusKey, setKeyboardFocusKey\] = useState<string \| null>\(null\)/u,
    'the section owns one keyboard-focus row key',
  )
  assert.match(
    section,
    /\(menuOpen\[workspaceKey\] === true \|\| keyboardFocusKey === workspaceKey\)\s*\n\s*&& cc\.rowActionsVisible/u,
    'kebab-open and keyboard focus reveal through the same class',
  )
  assert.match(
    section,
    /event\.target\.matches\(':focus-visible'\)[\s\S]{0,120}?setKeyboardFocusKey\(workspaceKey\)/u,
    'only :focus-visible focus arms it — a pointer click must not pin the cluster open',
  )
  assert.match(
    section,
    /if \(!\(next instanceof Node\) \|\| !event\.currentTarget\.contains\(next\)\)[\s\S]{0,160}?setKeyboardFocusKey\(current => \(current === workspaceKey \? null : current\)\)/u,
    'the focus transfer INSIDE the row must keep it (that is what lets Tab reach the buttons)',
  )
  assert.match(
    section,
    /if \(keyboardFocusKey !== null && !liveWorkspaceKeys\.current\.has\(keyboardFocusKey\)\) setKeyboardFocusKey\(null\)/u,
    'a row removed while focused fires no blur in Blink: the stale key must be dropped once its row is gone',
  )
  assert.match(
    section,
    /liveWorkspaceKeys\.current\.add\(workspaceKey\)/u,
    'every rendered workspace row registers its key for that post-render check',
  )
  assert.match(
    section,
    /if \(prevInlineRenameActive\.current && !inlineRenameActive\) setKeyboardFocusKey\(null\)/u,
    'an inline rename ends with focus still in the row (its autoFocus input unmounts, no blur fires): the key must be dropped',
  )
})

test('the source header arms .sourceActionsVisible from keyboard focus', () => {
  assert.match(header, /const \[keyboardFocus, setKeyboardFocus\] = useState\(false\)/u)
  assert.match(
    header,
    /search\?\.expanded === true \|\| sortMenuOpen === server\.id \|\| keyboardFocus\)\s*\n\s*&& cc\.sourceActionsVisible/u,
    'capsule-open, sort-menu-open and keyboard focus share one reveal class',
  )
  assert.match(header, /event\.target\.matches\(':focus-visible'\)[\s\S]{0,120}?setKeyboardFocus\(true\)/u)
  assert.match(header, /if \(!\(next instanceof Node\) \|\| !event\.currentTarget\.contains\(next\)\)[\s\S]{0,120}?setKeyboardFocus\(false\)/u)
})

test('the owning header is not focusable: the fold toggle is the panel-axis entry Tab path', () => {
  // The panel-axis entry only mounts in the OWNING source's header, and that header
  // is deliberately not activatable (hence role/tabIndex are dropped) — so its Tab
  // path must be the unconditional fold toggle, whose focusin bubbles to the
  // header's onFocus, which arms .sourceActionsVisible.
  assert.match(model, /return server\.id !== chamberInstanceId && !managedUnusable\n/u,
    'the model keeps the owning-source exclusion (line-final: a trailing || would break it)')
  assert.match(header, /const headerActivatable = sourceHeaderActivatable\(server, chamberInstanceId\)/u,
    'the header derives activatability from the model, it does not hard-code it')
  assert.match(header, /role=\{headerActivatable \? 'button' : undefined\}/u)
  assert.match(header, /tabIndex=\{headerActivatable \? 0 : undefined\}/u)
  const headerOpen = header.indexOf('<header')
  const focusAt = header.indexOf('onFocus=')
  const foldAt = header.indexOf('ref={foldToggleRef}')
  assert.ok(headerOpen !== -1 && focusAt > headerOpen && focusAt < foldAt,
    'the reveal handler lives on the header element itself, before its children')
  const clusterAt = header.indexOf('cc.sourceActions,')
  const entryAt = header.indexOf('<PanelHeaderEntry')
  const headerClose = header.indexOf('</header>')
  assert.ok(foldAt !== -1 && clusterAt > foldAt && entryAt > clusterAt,
    'the fold toggle precedes the action cluster, and the entry sits inside it')
  assert.ok(headerClose > entryAt,
    'the cluster and the entry stay inside the header element (hover/focus containment)')
})

test('no stylesheet flips these hooks on :focus-visible again', () => {
  // Per selector PART, not per rule list: a shared rule list may pair a workspace-header
  // part with an archive-manager part that legitimately keys on :has(:focus-visible).
  const selectors = [...sidebarCss.matchAll(/([^{}]+)\{/gu)]
    .flatMap(match => normalize(match[1] ?? '').split(',').map(part => part.trim()))
  for (const hook of ['.rowActions', '.sourceActions', '[data-git-action]', '[data-git-occupant]', '.workspaceCount']) {
    assert.ok(
      !selectors.some(selector => selector.includes(hook) && selector.includes(':focus-visible')),
      hook + ': a :focus-visible display flip is visible but NOT Tab-reachable (see the docstring)',
    )
  }
})
