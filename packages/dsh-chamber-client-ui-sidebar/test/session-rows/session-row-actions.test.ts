/**
 * 会话行 hover 动作簇：kebab（本仓行菜单）+ 独立归档钮。
 *
 * 归档钮是上游 ui-workspace `session-actions/ArchiveSession.tsx` 的
 * `ArchiveSessionRowButton`（注册进 `sidebar.workspaces.session.row.action`，
 * order 100）按形态逐字移植：同一个动作簇里 kebab 之后的第二个成员，文案键
 * `actions.archive`（tooltip，`side="bottom" align="end" delayMs={500}` 为上游
 * 调用值）、无障碍名 `action.archive.aria`（`{name}` = 行标题；上游同座席用泛化名，本仓按行级
 * 无障碍政策参数化行名并记为有意分歧，design 06 §7；行菜单项仍是 `menu.archiveSession`），点击走本仓既有的两段式
 * 归档出口。上游的 unarchive 半个分支在本仓不可达（归档行不进导航投影，
 * `derive.ts` 的 sessionVisible），所以本仓只有归档方向——这条锁同时钉住
 * 「不得引入死分支」。
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
  const button = ROWS.indexOf(`<Tooltip label={t('actions.archive')} side="bottom" align="end" delayMs={500}>`)
  const kebab = ROWS.indexOf('items={menuItems}')
  assert.ok(gate !== -1 && cluster > gate, 'the action cluster stays inside the blank-row gate')
  assert.ok(button > cluster, 'the archive button lives in the row action cluster (hover reveal), not beside it')
  assert.ok(kebab > cluster && kebab < button,
    'DOM order is upstream order: the kebab trigger first, the row.action entries after it')
  // 顺序不等于**包含**：把整簇搬到 blank 门外仍满足上面的 index 序，故再切出闸门块本身来断言。
  const gateEnd = ROWS.indexOf('\n      )}', gate)
  assert.notEqual(gateEnd, -1, 'the blank gate must close with an indented )}')
  const gateBlock = ROWS.slice(gate, gateEnd)
  assert.ok(gateBlock.includes(CLUSTER) && gateBlock.includes(`<Tooltip label={t('actions.archive')}`),
    'both row-action exits stay INSIDE the blank gate (a cluster moved outside would survive index order)')
  // 断言只在这一个按钮的切片里做（不用跨文件的宽松窗口）：形态 = 共享动作类名 + 上行无障碍名 +
  // 14px 归档字形 + 本仓两段式出口（标题随行传入，拒绝相位要用它）+ 拖拽尾随 click 门。
  const buttonBlock = ROWS.slice(button, ROWS.indexOf('</Tooltip>', button) + '</Tooltip>'.length)
  assert.match(buttonBlock, /className=\{cc\.actionIcon\}/u, 'the shared icon-action class, not a new one')
  assert.match(buttonBlock, /aria-label=\{t\('action\.archive\.aria', \{ name: session\.displayTitle \}\)\}/u,
    'the accessible name is parameterized with the row title (chamber row-action policy; upstream uses the plain verb)')
  assert.match(buttonBlock, /<IconArchiveOutlineRegular size=\{14\} \/>/u, 'upstream glyph size')
  assert.match(buttonBlock, /if \(suppressClickRef\.current\) return/u,
    'the row-control drag-tail click guard stays first in the handler (upstream markup has none)')
  assert.match(buttonBlock, /onArchiveSession\(server, session\.id, session\.displayTitle\)/u,
    'the button calls the existing archive funnel, with the row title for the confirm phase')
  assert.equal(ROWS.includes('IconUnarchiveOutlineRegular'), false,
    'no unarchive half: archived rows never enter the navigation projection')
  // 「恰一个」也要锁计数：indexOf 只锁第一个，粘贴出第二个按钮/第三处出口仍会绿。
  assert.equal((ROWS.match(/<Tooltip label=\{t\('actions\.archive'\)/gu) ?? []).length, 1,
    'exactly one row-level archive button')
  assert.equal((ROWS.match(/onArchiveSession\(/gu) ?? []).length, 2,
    'exactly two archive exits: the hover button and the kebab menu item')
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

test('the button copy is upstream verbatim in both dictionaries', () => {
  assert.equal(zh['actions.archive'], '归档会话')
  assert.equal(en['actions.archive'], 'Archive')
  // 行菜单项与上游同键（`menu.archiveSession`）；行内按钮另用参数化行名的 `action.archive.aria`。
  assert.equal(zh['menu.archiveSession'], '归档会话')
  assert.equal(en['menu.archiveSession'], 'Archive session')
})
