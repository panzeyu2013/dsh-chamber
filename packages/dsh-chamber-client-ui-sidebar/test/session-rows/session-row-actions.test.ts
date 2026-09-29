/**
 * 会话行 hover 动作簇：kebab（本仓行菜单）+ 独立归档钮 + 独立置顶钮，以及静息置顶标记。
 *
 * 置顶面（菜单首项 order 100、悬停钮 order 200、静息 `PinnedIndicator`、切换漏斗与上游文案）见下方同名用例。
 *
 * 归档钮是上游 ui-workspace `session-actions/ArchiveSession.tsx` 的
 * `ArchiveSessionRowButton`（注册进 `sidebar.workspaces.session.row.action`，
 * order 100）按形态逐字移植：同一个动作簇里 kebab 之后的第二个成员，文案键
 * `actions.archive`（tooltip，`side="bottom" align="end" delayMs={500}` 为上游
 * 调用值）、无障碍名 `action.archive.aria`（`{name}` = 行标题；上游同座席用泛化名，本仓按行级
 * 无障碍政策参数化行名并记为有意分歧，design 06 §7；行菜单项仍是 `menu.archiveSession`），点击走本仓既有的两段式
 * 归档出口。归档筛选（design 06 §3.4）落地后，上游的 unarchive 半个分支同样可达：
 * 归档行上归档钮/菜单项翻转为「恢复」并走官方 `workspace/unarchiveSession`。
 *
 * 本包测试跑在 plain node 下、没有 DOM/React 渲染环境，因此用源码文本锁 +
 * 可独立导入的字典值（与 row-render-cost.test.ts 同款纪律）。
 * Run directly: node test/session-rows/session-row-actions.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { en, zh } from '../../src/client/locales.ts'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const ROWS = read('../../src/client/ServerSectionRows.tsx')
const CSS = read('../../src/client/sidebar-chamber.module.css')

/** The blank-row gate line that hides the whole action cluster (official `!row.blank`). */
const BLANK_GATE = 'session.blank !== true && ('
/** The row action strip's opening tag. */
const CLUSTER = 'className={clsx(cc.rowActions, menuOpenRow && cc.rowActionsVisible)}'

test('the session row renders the upstream archive hover button inside the action cluster', () => {
  const gate = ROWS.indexOf(BLANK_GATE)
  const cluster = ROWS.indexOf(CLUSTER)
  const button = ROWS.indexOf(`<Tooltip label={t(session.archived === true ? 'actions.unarchive' : 'actions.archive')} side="bottom" align="end" delayMs={500}>`)
  const kebab = ROWS.indexOf('items={menuItems}')
  assert.ok(gate !== -1 && cluster > gate, 'the action cluster stays inside the blank-row gate')
  assert.ok(button > cluster, 'the archive button lives in the row action cluster (hover reveal), not beside it')
  assert.ok(kebab > cluster && kebab < button,
    'DOM order is upstream order: the kebab trigger first, the row.action entries after it')
  // 顺序不等于**包含**：把整簇搬到 blank 门外仍满足上面的 index 序，故再切出闸门块本身来断言。
  const gateEnd = ROWS.indexOf('\n      )}', gate)
  assert.notEqual(gateEnd, -1, 'the blank gate must close with an indented )}')
  const gateBlock = ROWS.slice(gate, gateEnd)
  assert.ok(gateBlock.includes(CLUSTER) && gateBlock.includes(`<Tooltip label={t(session.archived === true ? 'actions.unarchive' : 'actions.archive')}`),
    'both row-action exits stay INSIDE the blank gate (a cluster moved outside would survive index order)')
  // 断言只在这一个按钮的切片里做（不用跨文件的宽松窗口）：形态 = 共享动作类名 + 上行无障碍名 +
  // 14px 归档字形 + 本仓两段式出口（标题随行传入，拒绝相位要用它）+ 拖拽尾随 click 门。
  const buttonBlock = ROWS.slice(button, ROWS.indexOf('</Tooltip>', button) + '</Tooltip>'.length)
  assert.match(buttonBlock, /className=\{cc\.actionIcon\}/u, 'the shared icon-action class, not a new one')
  assert.match(buttonBlock, /aria-label=\{t\(session\.archived === true \? 'action\.unarchive\.aria' : 'action\.archive\.aria', \{ name: session\.displayTitle \}\)\}/u,
    'the accessible name is parameterized with the row title and flips on archived rows (chamber row-action policy)')
  assert.match(buttonBlock, /\{session\.archived === true \? <IconUnarchiveOutlineRegular size=\{14\} \/> : <IconArchiveOutlineRegular size=\{14\} \/>\}/u,
    'the unarchive/archive glyph toggle at the upstream 14px size')
  assert.match(buttonBlock, /if \(suppressClickRef\.current\) return/u,
    'the row-control drag-tail click guard stays first in the handler (upstream markup has none)')
  assert.match(buttonBlock, /onUnarchiveSession\(server, session\.id\)/u,
    'an archived row restores through the official workspace/unarchiveSession funnel')
  assert.match(buttonBlock, /onArchiveSession\(server, session\.id, session\.displayTitle\)/u,
    'the button calls the existing archive funnel, with the row title for the confirm phase')
  // 「恰一个」也要锁计数：indexOf 只锁第一个，粘贴出第二个按钮/第三处出口仍会绿。
  assert.equal((ROWS.match(/<Tooltip label=\{t\(session\.archived === true \? 'actions\.unarchive' : 'actions\.archive'\)/gu) ?? []).length, 1,
    'exactly one row-level archive/unarchive button')
  assert.equal((ROWS.match(/onArchiveSession\(/gu) ?? []).length, 2,
    'exactly two archive exits: the hover button and the kebab menu item')
  assert.equal((ROWS.match(/onUnarchiveSession\(/gu) ?? []).length, 2,
    'the same two surfaces flip to unarchive on archived rows')
})

test('the archive funnel guards an in-flight click and clears it by identity', () => {
  const sessions = read('../../src/client/sidebar-root-sessions.ts')
  const guard = sessions.indexOf('archiveActionRef.current.has(key)')
  assert.notEqual(guard, -1, 'the archive funnel guards in-flight clicks (newSession has the same shape)')
  const run = sessions.indexOf('const task = runAction(key', guard)
  assert.ok(run > guard,
    'the in-flight guard runs BEFORE that funnel\'s action starts (a second click must not fire a second archive RPC)')
  assert.match(sessions,
    /if \(archiveActionRef\.current\.get\(key\) === task\) archiveActionRef\.current\.delete\(key\)/u,
    'the entry is cleared by identity, so a newer attempt is never dropped by a late finally')
})

test('the hover reveal is the shared cluster rule, not a second mechanism', () => {
  // 归档钮不新增揭示规则：cluster 仍由行 hover / kebab 展开切进切出。注意行簇**没有**
  // 键盘焦点入口（session 行无 focus 座席；键盘焦点那一半只属于 workspace 头，见 CSS 注释
  // 与 design 06 §7 的已登记取舍）。
  assert.match(CSS, /\.sessionRow:hover \.rowActions \{/u)
})

test('the pin surfaces are the upstream forms: menu order 100 first, hover button 200 rightmost, sparse set marker', () => {
  // 上游座席顺序：菜单项 pin(100) 先于 rename(200)；行动作 archive(100) 先于 pin(200)，pin 是最右成员。
  const kebab = ROWS.indexOf('items={menuItems}')
  const archive = ROWS.indexOf(`<Tooltip label={t(session.archived === true ? 'actions.unarchive' : 'actions.archive')}`)
  const pin = ROWS.indexOf(`{t(session.pinned === true ? 'actions.unpin' : 'actions.pin')}`)
  assert.ok(kebab !== -1 && archive > kebab && pin > archive,
    'DOM order mirrors the two upstream seats: archive (100) then pin (200) after the kebab')
  // 顺序不等于**包含**（同归档钮口径）：把整个 Tooltip 搬出动作簇或搬出 blank 门，index 序照样成立。
  const gate = ROWS.indexOf(BLANK_GATE)
  const gateEnd = ROWS.indexOf('\n      )}', gate)
  const cluster = ROWS.indexOf(CLUSTER)
  assert.ok(gate !== -1 && gateEnd !== -1 && cluster !== -1 && cluster < pin,
    'the pin button lives in the row action cluster (hover reveal), not beside it')
  assert.ok(ROWS.slice(gate, gateEnd).includes(CLUSTER)
    && ROWS.slice(gate, gateEnd).includes("{t(session.pinned === true ? 'actions.unpin' : 'actions.pin')}"),
    'the pin exit stays INSIDE the blank gate (a cluster moved outside would survive index order)')
  const pinButton = ROWS.slice(pin - 20, ROWS.indexOf('</Tooltip>', pin) + '</Tooltip>'.length)
  assert.ok(pinButton.includes('side="bottom" align="end" delayMs={500}'), 'upstream Tooltip call values')
  assert.ok(pinButton.includes("aria-label={t(session.pinned === true ? 'menu.unpinSession' : 'menu.pinSession')}"),
    'the accessible name is the upstream long form (row-name parameterization stays on the archive button)')
  assert.ok(pinButton.includes('if (suppressClickRef.current) return'), 'the drag-tail click guard')
  assert.ok(pinButton.includes('onPinSession(server, session.id, session.pinned === true)'),
    'the button calls the pin funnel with the row own pinned state (toggle direction)')
  assert.ok(pinButton.includes('{session.pinned === true ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}'),
    'the 14px fill/outline pair, exactly as upstream passes size')
  // 菜单项：pin 是数组第一项（order 100），标签/字形随 pinned 切换，依赖里带上该字段。
  const menuEnd = ROWS.indexOf('], [t, session.pinned')
  assert.notEqual(menuEnd, -1, 'the menu memo deps line must exist (a -1 end would widen the slice silently)')
  const menu = ROWS.slice(ROWS.indexOf('const menuItems = useMemo'), menuEnd)
  assert.ok(menu.indexOf("id: 'pin'") !== -1 && menu.indexOf("id: 'pin'") < menu.indexOf("id: 'rename'"),
    'the pin menu item leads the list (upstream menu order 100)')
  assert.ok(menu.includes("label: t(session.pinned === true ? 'menu.unpinSession' : 'menu.pinSession')"))
  assert.ok(ROWS.includes('], [t, session.pinned, session.archived, renameShortcut, forkShortcut, archiveShortcut])'),
    'the memo must depend on session.pinned and session.archived or the toggle labels freeze')
  // 断言到分支体本身：只查字符串的话，悬停钮那处调用就能满足它，清空菜单分支也全绿。
  assert.match(ROWS, /else if \(id === 'pin'\) \{\n\s*onPinSession\(server, session\.id, session\.pinned === true\)/u,
    'the kebab item reaches the same funnel (branch body, not just the string)')
  // 静息标记：上游 PinnedIndicator（role=img + row.pinned 双名 + 14px 实心针），稀疏出现，
  // 落在状态槽之后，并与状态槽共用同一条 hover 换出规则。
  const markerAt = ROWS.indexOf('{session.pinned === true && (')
  const marker = ROWS.slice(markerAt, ROWS.indexOf('</div>', markerAt))
  assert.ok(marker.includes(`className={cc.pinSlot} role="img" aria-label={t('row.pinned')} title={t('row.pinned')}`))
  assert.ok(marker.includes('<IconPinFillRegular size={14} />'))
  // 上游 PinnedIndicator 是**非交互** span：换成带 onClick/tabIndex 的 button 曾是全绿（变异实测）。
  assert.ok(marker.includes('<span className={cc.pinSlot}'), 'the marker keeps the non-interactive span form')
  assert.equal(/onClick|tabIndex|type="button"/u.test(marker), false,
    'the resting marker must stay non-interactive (no click handler, no tab stop)')
  // 两个下标都要先证明在场：-1 会让「小于」静默成立（状态槽类名消失也照样绿）。
  const stateAt = ROWS.indexOf('cc.sessionStateSlot')
  const pinAt = ROWS.indexOf('cc.pinSlot')
  assert.ok(stateAt !== -1 && pinAt !== -1 && pinAt > stateAt,
    'the marker trails the trailing cell, like upstream trails the time cell')
  assert.ok(CSS.includes('.sessionRow:hover .pinSlot,\n.sessionRow:has(.rowActionsVisible) .pinSlot {\n  display: none;'),
    'the marker swaps out with the state slot while the actions are in')
  // 几何按本仓结构定稿（design 06 §7、checklist §4.6）：20×20 跟齐动作盒、不另加左边距。
  // 必须**在 .pinSlot 规则体内**断言：整份 CSS 里 "width: 20px; height: 20px;" 另有命中
  // （.actionIcon 等），对全文 includes 的断言在把 .pinSlot 改回 16px 时依然全绿（变异实测）。
  const pinSlotRule = CSS.slice(CSS.indexOf('.pinSlot {'), CSS.indexOf('}', CSS.indexOf('.pinSlot {')))
  assert.ok(pinSlotRule !== '' && pinSlotRule.includes('width: 20px;\n  height: 20px;'),
    'the marker box matches the chamber 20px action box so the hover swap does not jump')
  assert.equal(/margin-left/u.test(pinSlotRule), false,
    'spacing comes from the row gap, never an upstream margin stacked on top of it')
  // 「恰两个出口」也要锁计数（同归档钮口径）：只断言两处各自的形态，粘贴出第三个出口仍会绿。
  assert.equal((ROWS.match(/onPinSession\(/gu) ?? []).length, 2,
    'exactly two pin exits: the hover button and the kebab menu item')
  // 失败可见性：pin 键必须挂在行错误白名单链上（否则失败静默）。
  assert.ok(ROWS.includes('rowErrors[`${server.id}/session/${session.id}/pin`]'))
  // 优先级也要锁**顺序**：只查在场的话，把 pin 键挪到 fork 之后仍全绿（更陈旧的失败会遮住新的）。
  const chainFrom = ROWS.indexOf('const sessionActionError = ')
  const chainTo = ROWS.indexOf('openErrorKey(', chainFrom)
  assert.ok(chainFrom !== -1 && chainTo !== -1, 'the row error chain must exist as one block')
  const chainOrder = ['/rename`]', '/archive`]', '/unarchive`]', '/pin`]', '/fork`]'].map(marker => ROWS.slice(chainFrom, chainTo).indexOf(marker))
  assert.ok(chainOrder.every(at => at !== -1), 'the chain must name all five action keys')
  assert.deepEqual(chainOrder, [...chainOrder].sort((a, b) => a - b),
    'the chain order stays rename → archive → unarchive → pin → fork (a reordered key masks the newer failure)')
})

test('the pin funnel mirrors the archive funnel: in-flight guard by key, toggle direction, refresh after success', () => {
  const sessions = read('../../src/client/sidebar-root-sessions.ts')
  assert.ok(sessions.includes('const key = `${server.id}/session/${sessionId}/pin`'))
  const guard = sessions.indexOf('pinActionRef.current.has(key)')
  const run = sessions.indexOf('const task = runAction(key', guard)
  assert.ok(guard !== -1 && run > guard, 'the in-flight guard runs before the action starts')
  assert.ok(sessions.includes('await (currentlyPinned ? unpinSessionForSource : pinSessionForSource)(server.id, sessionId)'),
    'the toggle direction comes from the clicked row state')
  assert.ok(sessions.includes('if (pinActionRef.current.get(key) === task) pinActionRef.current.delete(key)'))
  const refresh = sessions.indexOf('chamberBridge.requestRefresh(server.id)', run)
  const set = sessions.indexOf('pinActionRef.current.set(key, task)')
  assert.ok(refresh > run && refresh < set,
    'the refresh happens inside the funnel after a successful wire (no optimistic echo)')
  // 但「在漏斗里」不等于「在 wire 之后」：源码顺序也能满足上面那条。锚到 await 的紧邻下一行，
  // 把 requestRefresh 提到 await 之前（乐观刷新）就必须变红。
  assert.match(sessions,
    /await \(currentlyPinned \? unpinSessionForSource : pinSessionForSource\)\(server\.id, sessionId\)\n\s*chamberBridge\.requestRefresh\(server\.id\)/u,
    'the refresh is adjacent to the resolved wire, not merely later in the file')
})

test('the pin copy is upstream verbatim in both dictionaries', () => {
  // 上游 zh 的「置顶」承诺排序（pin 会写 pinSessionOrder）；本仓首落未接置顶序——该差异
  // 登记在 design 06 §5 与 todo/upstream-ui-parity-plan.md §1.1，文案仍取上游逐字。
  assert.equal(zh['menu.pinSession'], '置顶会话')
  assert.equal(zh['menu.unpinSession'], '取消置顶')
  assert.equal(zh['actions.pin'], '置顶会话')
  assert.equal(zh['actions.unpin'], '取消置顶')
  assert.equal(zh['row.pinned'], '已置顶')
  assert.equal(en['menu.pinSession'], 'Pin session')
  assert.equal(en['menu.unpinSession'], 'Unpin session')
  assert.equal(en['actions.pin'], 'Pin')
  assert.equal(en['actions.unpin'], 'Unpin')
  assert.equal(en['row.pinned'], 'Pinned')
})

test('the archived row is the upstream form: grayed, unopenable, unpinnable, archive flips to unarchive', () => {
  const SESSIONS = read('../../src/client/sidebar-root-sessions.ts')
  const SEARCH = read('../../src/client/ServerSectionSearch.tsx')
  const SECTION = read('../../src/client/ServerSection.tsx')
  // 行形态：置灰类 + 不可打开 aria + 不可拖 + 点击就地提示 + 状态槽留空。
  assert.ok(ROWS.includes('session.archived === true && cc.sessionArchived'))
  assert.ok(ROWS.includes("aria-description={session.archived === true ? t('toast.archivedNotOpenable') : undefined}"))
  assert.ok(ROWS.includes('draggable={!ghost && !synthetic && session.archived !== true && session.blank !== true}'),
    'archived rows are undroppable sources, and blank (provisional) rows are excluded like upstream')
  assert.ok(ROWS.includes("showNotice(server.id, 'archivedNotOpenable', session.id)"))
  assert.ok(ROWS.includes('{session.archived === true ? null : sessionStateDot(server, session)}'))
  // pin 两个出口在归档行缺席（菜单项 spread 门 + 悬停钮包裹门），静息标记由 derive 保证。
  assert.ok(ROWS.includes('...(session.archived === true'))
  assert.ok(ROWS.includes('{session.archived !== true && ('))
  // 恢复漏斗：与归档同一条 keyed 行动作。
  assert.ok(SESSIONS.includes('const key = `${server.id}/session/${sessionId}/unarchive`'))
  assert.ok(SESSIONS.includes('await unarchiveSessionForSource(server.id, sessionId)'))
  // 提示条：三态文案 + 筛选入口在已显示归档时隐藏 + 两个相位触达。
  for (const key of ["'toast.stoppedAndArchived'", "'toast.archived'", "t('toast.archivedNotOpenable')"]) {
    assert.ok(SECTION.includes(key), `the notice renders ${key}`)
  }
  assert.ok(SECTION.includes("archivedFilter === 'default' && server.archiveSetKnown === true && ("),
    'the filter link hides once archived rows are visible AND is provenance-gated (it writes show)')
  assert.ok(SECTION.includes("t('empty.noneArchived')") && SECTION.includes("t('empty.viewOthers')"), 'the only-mode empty state')
  assert.ok(SESSIONS.includes("showNotice(server.id, 'archived', sessionId)"))
  const DIALOGS = read('../../src/client/sidebar-root-dialogs.tsx')
  assert.ok(DIALOGS.includes("showNotice(target.sourceId, 'stoppedAndArchived', target.sessionId)"))
  // 搜索结果命中行跟随（归档行不可开 + 行后恢复入口）。
  assert.ok(SEARCH.includes('const archived = projectedArchived(item.sessionId)'))
  assert.ok(SEARCH.includes("showNotice(server.id, 'archivedNotOpenable', item.sessionId)"))
  assert.ok(SEARCH.includes('onUnarchiveSession(server, item.sessionId)'))
})

test('the archived/notice copy is upstream verbatim in both dictionaries', () => {
  assert.equal(zh['row.archived'], '已归档')
  assert.equal(zh['menu.unarchiveSession'], '取消归档')
  assert.equal(zh['actions.unarchive'], '取消归档')
  assert.equal(zh['toast.archivedNotOpenable'], '已归档对话暂时无法查看，请取消归档后查看')
  assert.equal(zh['toast.archived'], '会话已归档，可')
  assert.equal(zh['toast.stoppedAndArchived'], '已停止并归档，可')
  assert.equal(zh['toast.archivedUndo'], '撤销')
  assert.equal(zh['toast.archivedOr'], '或')
  assert.equal(zh['toast.archivedFilter'], '筛选已归档会话')
  assert.equal(zh['empty.noneArchived'], '暂无已归档会话')
  assert.equal(zh['empty.viewOthers'], '查看其他会话')
  assert.equal(en['row.archived'], 'Archived')
  assert.equal(en['menu.unarchiveSession'], 'Unarchive session')
  assert.equal(en['actions.unarchive'], 'Unarchive')
  assert.equal(en['toast.archived'], 'Session archived. You can ')
  assert.equal(en['toast.stoppedAndArchived'], 'Session stopped and archived. You can ')
  assert.equal(en['toast.archivedUndo'], 'undo')
  assert.equal(en['toast.archivedOr'], ' or ')
  assert.equal(en['toast.archivedFilter'], 'filter archived sessions')
  assert.equal(en['empty.noneArchived'], 'No archived sessions yet')
  assert.equal(en['empty.viewOthers'], 'View other sessions')
})

test('the button copy is upstream verbatim in both dictionaries', () => {
  assert.equal(zh['actions.archive'], '归档会话')
  assert.equal(en['actions.archive'], 'Archive')
  // 行菜单项与上游同键（`menu.archiveSession`）；行内按钮另用参数化行名的 `action.archive.aria`。
  assert.equal(zh['menu.archiveSession'], '归档会话')
  assert.equal(en['menu.archiveSession'], 'Archive session')
})
