/**
 * Source lock for the git occupant's REST-STATE footprint (design 08 §3.2
 * 「occupant 容器 rest 态零布局占用」).
 *
 * The occupant action hides itself (`display: none` on `.headerGitAction`), but that is
 * not enough: the mount renders a CONTAINER span (`.headerGit`, SidebarGit.module.css)
 * that stays an in-flow flex item at rest — and a zero-width flex item still consumes
 * the header's `gap: 4px`. Every row carrying git facts therefore parked its count badge
 * 4px off the shared right column (the session rows' trailing state slots, the todo
 * count pill) while a facts-less row kept its badge flush: one column, two x positions,
 * re-split whenever git facts landed, plus 4px of title width spent on nothing. The
 * container carries its own cross-package hook (`data-git-occupant`) that the sidebar
 * keeps out of the layout at rest and returns on exactly the states that reveal the
 * action.
 *
 * Pinned here: (1) the mount still renders BEFORE (left of) the sidebar's action cluster
 * — placement belongs to the git package's `test/locks/slot-contract.test.ts`, and this
 * lock re-asserts it only so the footprint mechanism cannot be satisfied by moving the
 * mount into the cluster; (2) the container's rest state REMOVES the item (a `display`
 * change, never transparent-but-present); (3) its reveal selector set is the action
 * hook's own — hover plus the shared `.rowActionsVisible` class (kebab-open or keyboard
 * focus) — so the two can never disagree; (4) the hook crosses the package
 * boundary as an attribute alone, never through a hashed class name.
 *
 * This is a MECHANISM lock, not a pixel lock: the repository has no browser harness, so
 * the pixel contract itself (the badge's 4px inset sharing the session state slots' /
 * todo pill's right column, unchanged by git facts landing) stays a real-engine
 * measurement against this stylesheet (design 08 §3.2).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

/** Comment-stripped source: a lock must never be satisfied by a comment. */
const source = (relative: string): string =>
  stripComments(readFileSync(new URL(relative, import.meta.url), 'utf8'))

const sidebarCss = source('../../src/client/sidebar-chamber.module.css')
const gitCss = source('../../../dsh-chamber-client-ui-git/src/client/SidebarGit.module.css')
const gitLineTsx = source('../../../dsh-chamber-client-ui-git/src/client/SidebarWorkspaceGitLine.tsx')
const serverSection = source('../../src/client/ServerSection.tsx')

/** Locates the workspace-scope mount: the other two call sites are not in a header. */
const MOUNT_CONTEXT = 'hookContext: { sourceId: server.id, workspaceId: workspace.id },'
const HOOK = '[data-git-occupant]'
const ACTION_HOOK = '[data-git-action]'

const flat = (code: string): string => normalize(code).trim()

interface Rule {
  /** The rule's whole selector list, whitespace-normalized. */
  selector: string
  declarations: string
}

/** Every flat `selector { declarations }` rule of a stylesheet (no nesting in these sheets). */
const rules = (css: string): Rule[] =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(match => ({
    selector: flat(match[1] ?? ''),
    declarations: flat(match[2] ?? ''),
  }))

const selectors = (rule: Rule): string[] => rule.selector.split(',').map(part => part.trim())

const displayRules = (hook: string): Rule[] =>
  rules(sidebarCss).filter(rule => rule.selector.includes(hook) && /\bdisplay\s*:/u.test(rule.declarations))

test('the mount stays before (left of) the sidebar cluster', () => {
  const render = serverSection.indexOf(MOUNT_CONTEXT)
  assert.notEqual(render, -1, 'the workspace-scope occupant mount exists')
  assert.ok(
    serverSection.indexOf('workspaceTitle') < render,
    'the occupant renders inside the header row, after the title',
  )
  assert.ok(
    render < serverSection.indexOf('cc.rowActions'),
    'the occupant renders before (left of) the row actions — the git package\'s slot-contract contract',
  )
})

test('the container leaves the layout at rest, never faked invisible', () => {
  const rest = rules(sidebarCss).filter(rule => rule.selector === '.workspaceHeader ' + HOOK)
  assert.equal(rest.length, 1, 'exactly one rest rule for the occupant container')
  assert.match(rest[0]!.declarations, /\bdisplay:\s*none;/u, 'the rest state must change display')
  assert.doesNotMatch(
    rest[0]!.declarations,
    /(opacity|visibility|clip|width:\s*0)/u,
    'an item that is merely invisible still takes a flex slot and still consumes the header gap',
  )
})

test('the reveal set is exactly the action hook’s states', () => {
  const occupantDisplay = displayRules(HOOK)
  assert.equal(occupantDisplay.length, 2, 'one rest rule + one reveal rule, no third display rule')
  const shown = occupantDisplay.filter(rule => /\bdisplay:\s*inline-flex;/u.test(rule.declarations))
  assert.equal(shown.length, 1, 'the container is revealed by exactly one rule')
  assert.deepEqual(
    selectors(shown[0]!).sort(),
    [
      '.workspaceHeader:has(.rowActionsVisible) ' + HOOK,
      // hover 半边带行位移门控（design 06 §7）：被位移搬到静止指针下、而指针并未移动的行不得
      // 认领揭示——否则 :hover 揭示树会在用户没指向它时整行重构（"删除会话时 workspace 闪一下"）。
      // 下面的 HOOK→ACTION_HOOK 映射断言要求容器与动作两侧同时带这条门控，漏一侧即红。
      '.workspaceHeader:hover:not([data-hover-gate]) ' + HOOK,
    ].sort(),
    'hover (:not([data-hover-gate])) / .rowActionsVisible (kebab-open or keyboard focus) — never :focus-within, and never a CSS :has(:focus-visible) reveal (Blink does not navigate into it; see keyboard-reveal-reachability.test.ts)',
  )
  for (const hook of [HOOK, ACTION_HOOK]) {
    assert.equal(
      rules(sidebarCss).filter(rule => rule.selector.includes(hook) && rule.selector.includes(':focus-visible')).length,
      0,
      'the keyboard reveal must ride the JS state, not a CSS :has(:focus-visible) display flip',
    )
  }
  const actionDisplay = displayRules(ACTION_HOOK)
  assert.equal(actionDisplay.length, 1, 'the action hook has exactly one display rule')
  assert.deepEqual(
    selectors(shown[0]!).map(part => part.replace(HOOK, ACTION_HOOK)).sort(),
    selectors(actionDisplay[0]!).sort(),
    'the container and its action must ride the same reveal states (hover / .rowActionsVisible) — the two hooks cannot disagree',
  )
})

test('the hook crosses the package boundary as an attribute alone', () => {
  assert.match(
    gitLineTsx,
    /className=\{css\.headerGit\} data-git-occupant=""/u,
    'the plugin emits the container hook on its own span',
  )
  assert.match(gitCss, /\.headerGit\s*\{/u, 'the plugin still owns the revealed container styling')
  // The plugin brings NO reveal of its own: its action is `display: none` at rest, so a
  // CSS `:focus-visible` flip inside the plugin sheet could never fire anyway — the host
  // owns every reveal state. This is the regression lock for the rule retired with the
  // align merge (nothing else reads the plugin sheet's reveal surface).
  for (const rule of rules(gitCss)) {
    if (!rule.selector.includes(':focus-visible')) continue
    assert.doesNotMatch(
      rule.declarations,
      /\bdisplay\s*:/u,
      `the git plugin must not reveal anything on keyboard focus (${rule.selector})`,
    )
  }
  assert.doesNotMatch(
    sidebarCss,
    /_headerGit_/u,
    'the sidebar must match the attribute, never the plugin\'s hashed class name',
  )
})
