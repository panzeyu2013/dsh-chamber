/**
 * 孤儿 workspace（路径已消失）行的删除入口：常驻清理钮 + 徽标。
 *
 * 为什么锁这条：worktree 行没有 kebab（design 08 §3.2），而 Git occupant 只在快照
 * 里存在该 worktree 行时才挂载（git 插件的 SidebarWorkspaceGitLine.tsx 在
 * gitFactsForWorkspace 为空时整块
 * 不渲染）——因此「目录被外部删除、Git 记录也已被 prune」的行**没有任何 Git 侧删除
 * 控件**，此前的唯一出口是「已消失」状态徽标。清理钮把出口显式化、常驻化，并与徽标
 * 共用 onDeleteWorkspace（同一 orphan 确认文案、同一层 Modal 门、同一条拖拽尾随 click 门）。
 *
 * 本包测试跑在 plain node 下、没有 DOM/React 渲染环境，因此用源码文本锁 +
 * 可独立导入的字典值（与 session-row-actions.test.ts 同款纪律）。
 * Run directly: node test/session-rows/workspace-orphan-cleanup.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { en, zh } from '../../src/client/locales.ts'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const SECTION = read('../../src/client/ServerSection.tsx')
const CSS = read('../../src/client/sidebar-chamber.module.css')
const CJK = /[\u4e00-\u9fff]/u
/**
 * The header's hover-revealed cluster (workspace row scope). Its className must keep
 * BOTH reveal sources — the kebab menu and the section's keyboard-focus state (they
 * share `.rowActionsVisible`; design 06 §7 / design 08 §3.2). Anchored on the class
 * token as a regex, so neither a reformat of the clsx call nor a pasted duplicate can
 * satisfy it; the word boundary keeps it off `cc.rowActionsVisible` itself.
 */
const CLUSTER_AT = /cc\.rowActions\b/u

test('the orphan worktree row renders a RESIDENT cleanup control behind the orphan gate', () => {
  const at = SECTION.indexOf('cc.orphanCleanup')
  assert.notEqual(at, -1, 'the orphan cleanup control must exist in the workspace header')
  assert.equal((SECTION.match(/cc\.orphanCleanup/gu) ?? []).length, 1,
    'exactly one control (a pasted duplicate must fail; indexOf alone locks only the first)')
  // Resident, not hover-gated: JSX children are written after their parent's opening
  // tag, so a control appearing BEFORE the cluster's opening tag cannot be inside it.
  const cluster = SECTION.search(CLUSTER_AT)
  assert.notEqual(cluster, -1, 'the header hover cluster must stay where it is')
  assert.ok(at < cluster, 'the cleanup control must stay OUTSIDE the hover-revealed cluster')
  // Close the slice at the NEXT attribute: a '>' search would stop inside the
  // cluster's own onClick arrow, several lines later.
  const clusterBlock = SECTION.slice(cluster, SECTION.indexOf('onClick', cluster))
  assert.match(clusterBlock, /cc\.rowActionsVisible/u, 'the cluster must keep its reveal class')
  assert.match(clusterBlock, /menuOpen\[workspaceKey\] === true/u, 'kebab-open reveal')
  assert.match(clusterBlock, /keyboardFocusKey === workspaceKey/u,
    'the keyboard reveal state must ride the same class (design 06 §7)')
  // Gate: only the orphaned WORKTREE half — a plain orphaned workspace keeps its kebab.
  const gateAt = SECTION.lastIndexOf('{gitFlag?.orphaned === true', at)
  assert.notEqual(gateAt, -1, 'the control lives under the orphan-flag gate')
  const gate = SECTION.slice(gateAt, at)
  assert.match(gate, /&& isWorktree/u, 'only the worktree half gets the trash glyph')
  assert.match(gate, /!workspace\.ungrouped && !workspace\.synthetic/u,
    'and only in a real workspace header (the same guard as the other header controls)')
  // The button block itself: shared action box + danger modifier + resident hook,
  // 14px glyph, own accessible name, the badge's tooltip and the shared opener.
  // Slice from the BUTTON TAG: `at` points at the class token INSIDE the tag, so a
  // slice from there would drop the className the next assertion locks.
  const tagAt = SECTION.lastIndexOf('<button', at)
  assert.notEqual(tagAt, -1, 'the control must be a real <button>')
  const block = SECTION.slice(tagAt, SECTION.indexOf('</button>', at) + '</button>'.length)
  assert.match(block, /className=\{clsx\(cc\.actionIcon, cc\.actionIconDanger, cc\.orphanCleanup\)\}/u,
    'the shared 20px action box + danger hover ink + the resident hook')
  assert.match(block, /<IconTrashOutlineRegular size=\{14\} \/>/u, 'the row-action glyph size')
  assert.match(block, /aria-label=\{t\('action\.orphanedCleanup\.aria', \{ name: workspace\.title \}\)\}/u,
    'its own accessible name, parameterized with the ROW it acts on (repo row-action policy)')
  assert.match(block, /title=\{t\('confirm\.deleteOrphan', \{ title: workspace\.title \}\)\}/u,
    'one action, one confirm copy (the badge tooltip)')
  assert.match(block, /if \(suppressClickRef\.current\) return/u,
    'the drag-tail click guard comes first (a drop over the header must never arm a delete)')
  assert.match(block, /onDeleteWorkspace\(server, workspace\.id, workspace\.title\)/u,
    'it reuses the workspace-delete opener: orphan copy + single-Modal gate, no second funnel')
})

test('the badge stays the status marker and the second (keyboard-resident) entry', () => {
  const badgeAt = SECTION.indexOf('className={cc.orphanBadge}')
  assert.notEqual(badgeAt, -1, 'the orphan badge must stay')
  const badge = SECTION.slice(badgeAt, SECTION.indexOf('</button>', badgeAt) + '</button>'.length)
  assert.match(badge, /onDeleteWorkspace\(server, workspace\.id, workspace\.title\)/u, 'the badge keeps its opener')
  assert.match(badge, /if \(suppressClickRef\.current\) return/u,
    'and gains the same drag-tail guard as every other header control')
  assert.ok(!badge.includes('cc.orphanCleanup'), 'the two entries stay distinct controls')
})

test('the cleanup hook is resident and carries the Missing alert ink', () => {
  const at = CSS.indexOf('\n.orphanCleanup {')
  assert.notEqual(at, -1, 'the .orphanCleanup rule must exist')
  const body = CSS.slice(at, CSS.indexOf('}', at))
  assert.match(body, /color: var\(--dsw-alias-state-warn-primary\)/u,
    'warn ink at rest, so the glyph reads as part of the Missing alert')
  assert.doesNotMatch(body, /display:\s*none/u, 'residency is the whole point: no hover gate here')
  const clusterAt = CSS.indexOf('\n.rowActions {')
  assert.notEqual(clusterAt, -1, 'the hover cluster rule must stay')
  assert.match(CSS.slice(clusterAt, CSS.indexOf('}', clusterAt)), /display:\s*none/u,
    'the reveal gate stays where it belongs (the cluster), not on the cleanup control')
})

test('the new accessible name exists in both dictionaries and the en side stays English', () => {
  assert.equal(typeof zh['action.orphanedCleanup.aria'], 'string')
  assert.equal(typeof en['action.orphanedCleanup.aria'], 'string')
  assert.match(zh['action.orphanedCleanup.aria'], CJK, 'the zh copy is authored, not a placeholder')
  assert.doesNotMatch(en['action.orphanedCleanup.aria'], CJK, 'the en dictionary never falls back to Chinese')
  assert.match(zh['action.orphanedCleanup.aria'], /\{name\}/u, 'row-action names carry the ROW (repo policy)')
  assert.match(en['action.orphanedCleanup.aria'], /\{name\}/u, 'row-action names carry the ROW (repo policy)')
  assert.match(zh['confirm.deleteOrphan'], /仅删除其 workspace 注册/u, 'the zh confirm keeps the registration-only scope')
  assert.match(en['confirm.deleteOrphan'], /only its workspace registration/u, 'the en confirm keeps the registration-only scope')
})
