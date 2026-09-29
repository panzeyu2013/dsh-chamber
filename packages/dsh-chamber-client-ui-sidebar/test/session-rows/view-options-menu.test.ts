/**
 * 每来源视图选项菜单（上游 ui-workspace ViewOptionsMenu 三段形态的形态锁）：
 * 分组方式 / 排序方式 / 筛选会话三轴、label + separator + icon + selectedIds、
 * compact 密度与 tooltip 文案，以及筛选轴在未知归档集下的禁用与「按实际渲染态选中」
 * 规则（design 06 §3.4）。本包测试跑在 plain node 下、没有 DOM/React 渲染
 * 环境，因此用源码文本锁 + 可独立导入的字典值（与 session-row-actions.test.ts 同款纪律）。
 * Run directly: node test/session-rows/view-options-menu.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { en, zh } from '../../src/client/locales.ts'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const HEADER = read('../../src/client/ServerSectionHeader.tsx')
const PROJ = read('../../src/client/sidebar-root-projection.ts')

const at = (needle: string): number => HEADER.indexOf(needle)

test('the source-header menu is the upstream three-section view options form', () => {
  // 三段 label 依序：分组在前、排序居中、筛选在后（上游 ViewOptionsMenu 的 items 顺序）。
  const groupLabel = at(`id: 'group-by', text: t('groupBy.label')`)
  const orderLabel = at(`id: 'order-by', text: t('orderBy.label')`)
  const filterLabel = at(`id: 'filter-by', text: t('filterBy.label')`)
  assert.ok(groupLabel !== -1 && orderLabel > groupLabel && filterLabel > orderLabel,
    'the three labels keep upstream order: group-by, order-by, filter-by')
  // 选项 id 顺序（上游同序）。
  const ids = [
    `id: 'workspace',`, `id: 'workspace-tree',`, `id: 'flat',`,
    `id: 'manual',`, `id: 'updated',`,
    `id: 'hide-archived',`, `id: 'show-archived',`, `id: 'only-archived',`,
  ].map(needle => at(needle))
  assert.ok(ids.every(index => index !== -1), 'every upstream option id is present')
  for (let i = 1; i < ids.length; i += 1) {
    assert.ok(ids[i]! > ids[i - 1]!, `option ${i} keeps upstream relative order`)
  }
  // 两处分隔线（组间 hairline），都落在对应 label 之前。
  const separators = HEADER.match(/type: 'separator' as const/gu) ?? []
  assert.equal(separators.length, 2, 'exactly two group separators, like upstream')
  const firstSeparator = at(`id: 'order-by-separator'`)
  const secondSeparator = at(`id: 'archived-filter-separator'`)
  assert.ok(firstSeparator > groupLabel && firstSeparator < orderLabel)
  assert.ok(secondSeparator > orderLabel && secondSeparator < filterLabel)
  // selectedIds 三轴齐备（上游 selectedIds = [groupBy, orderBy, archivedFilter 映射]）。
  assert.ok(HEADER.includes('selectedIds={[groupByMode, orderByMode, archivedSelection]}'),
    'selectedIds carries all three axes')
  // 菜单形态：compact（本仓裁决）+ portal + align end（上游调用值）。
  const menu = HEADER.slice(at('<Menu'), at('selectedIds={[groupByMode'))
  assert.ok(menu.includes('compact') && menu.includes('portal') && menu.includes('align="end"'),
    'compact density (chamber ruling) plus the upstream portal/align values')
  // 触发钮：上游 sliders 字形 + 视图选项 tooltip/aria（不再只写排序）。
  assert.ok(HEADER.includes(`<Tooltip label={viewOptionsLabel} side="bottom" delayMs={500}>`))
  assert.ok(HEADER.includes(`aria-label={viewOptionsLabel}`))
  assert.ok(HEADER.includes('<IconSlidersTwoOutlineRegular size={14} />'))
  // 旧两轴排序菜单已被替换（不得残留）。
  assert.equal(HEADER.includes(`id: 'sort-label'`), false, 'the two-item sort-only menu is gone')
})

test('each option routes to its axis setter and the disabled rule covers the unknown archive set', () => {
  assert.ok(HEADER.includes(`else if (id === 'workspace' || id === 'workspace-tree' || id === 'flat') setGroupBy(server, id)`))
  assert.ok(HEADER.includes(`if (id === 'manual' || id === 'updated') setOrderBy(server, id)`))
  for (const [id, filter] of [['hide-archived', 'default'], ['show-archived', 'show'], ['only-archived', 'only']] as const) {
    assert.ok(HEADER.includes(`else if (id === '${id}') setArchivedFilter(server, '${filter}')`), `${id} routes to ${filter}`)
  }
  // 未知归档集：筛选轴三项整体禁用（默认项若可点会把存储值写回 'default'），
  // 选中按实际渲染态呈现，存储值保留（D6/A2）。
  const disabled = HEADER.match(/disabled: !archiveFilterKnown/gu) ?? []
  assert.equal(disabled.length, 3, 'the whole filter axis is disabled while the archive set is unknown')
  // 未知归档集：存储值保留、选中态按实际渲染态（hide-archived）呈现。
  assert.ok(HEADER.includes('const archivedSelection = archiveFilterKnown'))
  assert.ok(HEADER.includes(`    : 'hide-archived'`))
  // 三轴状态都读 per-source 视图偏好；groupBy=workspace / archivedFilter=default 的缺省与上游一致，
  // orderBy 缺省 manual 是登记偏差 B1（上游默认 updated）。
  assert.ok(HEADER.includes(`viewPrefs.groupBy?.[server.id] ?? 'workspace'`))
  assert.ok(HEADER.includes(`viewPrefs.orderBy?.[server.id] ?? 'manual'`))
  assert.ok(HEADER.includes(`viewPrefs.archivedFilter?.[server.id] ?? 'default'`))
  // 写入侧：两个新 setter 都在 projection 中定义（context 三处接线由类型检查承重）。
  for (const symbol of ['setGroupBy', 'setArchivedFilter']) {
    assert.ok(PROJ.includes(`const ${symbol} = (server: ChamberServerAggregate`), `${symbol} defined in the projection`)
    assert.ok(PROJ.includes(`${symbol},`), `${symbol} exported from the projection`)
  }
})

test('the view-options copy is upstream verbatim in both dictionaries', () => {
  assert.equal(zh['viewOptions.label'], '视图选项')
  assert.equal(zh['groupBy.label'], '分组方式')
  assert.equal(zh['groupBy.workspace'], '按工作区')
  assert.equal(zh['groupBy.workspaceTree'], '按工作区树')
  assert.equal(zh['groupBy.flat'], '单列表')
  assert.equal(zh['orderBy.label'], '排序方式')
  assert.equal(zh['orderBy.manual'], '手动排序')
  assert.equal(zh['orderBy.updated'], '最近更新')
  assert.equal(zh['filterBy.label'], '筛选会话')
  assert.equal(zh['viewOptions.hideArchived'], '隐藏已归档')
  assert.equal(zh['viewOptions.showArchived'], '全部对话（显示已归档）')
  assert.equal(zh['viewOptions.onlyArchived'], '仅显示已归档')
  assert.equal(en['viewOptions.label'], 'View options')
  assert.equal(en['groupBy.label'], 'Group by')
  assert.equal(en['groupBy.workspace'], 'WorkSpace')
  assert.equal(en['groupBy.workspaceTree'], 'Workspace Tree')
  assert.equal(en['groupBy.flat'], 'In one list')
  assert.equal(en['orderBy.label'], 'Order by')
  assert.equal(en['orderBy.manual'], 'Manual')
  assert.equal(en['orderBy.updated'], 'Last updated')
  assert.equal(en['filterBy.label'], 'Filter sessions')
  assert.equal(en['viewOptions.hideArchived'], 'Hide archived')
  assert.equal(en['viewOptions.showArchived'], 'All conversations (show archived)')
  assert.equal(en['viewOptions.onlyArchived'], 'Archived only')
})
