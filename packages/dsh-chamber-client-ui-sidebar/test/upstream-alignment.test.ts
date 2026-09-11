/**
 * 2026-09-11 upstream-alignment locks (audit findings T2/T5/T7/T10/T11/T12/A2/
 * A5/A6/A7-extra against the pinned vendor tree `vendor/harness-checkout`).
 *
 * These are SOURCE-TEXT locks (comments stripped first — see source-lock.ts):
 * the components under test value-import React and the dsh client packages and
 * cannot be imported by a plain `node test/…` run. Where a finding has a pure
 * function behind it, the BEHAVIOURAL test lives beside the function
 * (session-row-window.test.ts for T11, panel-source.test.ts for A5); these
 * locks pin the wiring that no node test can execute.
 *
 * Every lock names the upstream reference it enforces, so a future vendor pin
 * bump can re-check the claim instead of guessing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { hasCjk, normalize, source, stripComments } from './source-lock.ts'

const root = source('../src/client/SidebarRoot.tsx')
const rootCode = stripComments(root)
const section = source('../src/client/ServerSection.tsx')
const sectionCode = stripComments(section)
const archive = source('../src/client/ArchiveManagerDialog.tsx')
const archiveCode = stripComments(archive)
const locales = source('../src/client/locales.ts')
const index = source('../src/client/index.ts')
const panelSource = source('../src/client/panel-source.ts')
const chamberCss = source('../src/client/sidebar-chamber.module.css')
const chamberCode = stripComments(chamberCss)

test('T2a/T2b: the native confirm call is gone from the whole package', () => {
  // The retired call's token is spelled from parts so THIS file does not
  // contain it: `grep -rn <token> packages/dsh-chamber-client-ui-sidebar`
  // (node_modules aside) must then come back completely empty — the audit's
  // own grep proof, not just an absence inside src.
  const banned = ['window', 'confirm'].join('.')
  for (const [name, text] of [
    ['SidebarRoot.tsx', root],
    ['ServerSection.tsx', section],
    ['ArchiveManagerDialog.tsx', archive],
    ['SessionTodoArea.tsx', source('../src/client/SessionTodoArea.tsx')],
    ['sidebar-chamber.module.css', chamberCss],
  ] as const) {
    assert.equal(text.includes(banned), false, `${name} must not mention the retired call`)
  }
  // ...and nowhere else in src either: every module must be free of the token.
  assert.deepEqual(findInTree('src', banned), [], 'no src file may mention the retired call')
})

test('T2a: archive is one row-menu verb, never a second hover button', () => {
  const sessionMenu = sessionRowMenu()
  // The archive entry lives in the session row's menu, with upstream's copy
  // (vendor ui-workspace locales.ts menu.archiveSession) and the 20-native glyph
  // in the menu's 16px icon slot (vendor Rows.tsx:420).
  assert.ok(sessionMenu.includes("id: 'archive'"), 'the session menu must carry the archive entry')
  assert.ok(sessionMenu.includes("label: t('menu.archiveSession')"), 'the archive entry uses upstream copy')
  assert.ok(sessionMenu.includes('<IconArchiveOutline20 size={16} />'), 'the archive entry uses the 20-native glyph')
  assert.ok(
    sessionMenu.includes("onArchiveSession(server, session.id, sessionTitleText)"),
    'selecting archive must run the same handler the old button ran',
  )
  // No separate archive affordance survives in the row's action cluster.
  const rowActions = sectionCode.slice(sectionCode.indexOf('cc.rowActions'), sectionCode.indexOf('Trailing state slot'))
  assert.equal(rowActions.includes("t('action.archive')"), false, 'no standalone archive button may remain')
  assert.equal(rowActions.includes('<IconArchiveOutline20 size={14} />'), false, 'no standalone archive glyph may remain')
  // ...while the verb stays REACHABLE: kebab + archive + fork + rename all live
  // in that one menu (no capability may disappear with the button).
  for (const id of ["id: 'rename'", "id: 'fork'", "id: 'archive'"]) {
    assert.ok(sessionMenu.includes(id), `the session menu must keep ${id}`)
  }
  // The action's gating and error reporting are untouched: the handler is still
  // the keyed runAction.
  assert.ok(
    normalize(rootCode).includes("runAction(`${server.id}/session/${sessionId}/archive`, async () => {"),
    'archive must keep its keyed rowErrors action',
  )
})

test('T2b: workspace delete confirm is the in-app Modal, with upstream chrome', () => {
  // The armed confirm is shell state (the row may unmount mid-flight), the wire
  // call runs only on accept, and the action keeps its keyed rowErrors.
  assert.ok(rootCode.includes('const [deleteTarget, setDeleteTarget] = useState<WorkspaceDeleteTarget | null>(null)'), 'the armed confirm must be shell state')
  assert.ok(rootCode.includes('const [deletePending, setDeletePending] = useState(false)'), 'the in-flight state must exist')
  assert.ok(
    normalize(rootCode).includes('runActionWithOutcome(`${target.sourceId}/workspace/${target.workspaceId}/delete`, async () => {'),
    'the accepted confirm must run the same keyed delete action',
  )
  assert.ok(rootCode.includes('chamberBridge.reportWorkspaceRemoved({ sourceId: target.sourceId, workspaceId: target.workspaceId, path })'), 'the workspace-echo withdraw fact must survive')
  assert.ok(rootCode.includes('chamberBridge.requestRefresh(target.sourceId)'), 'the post-delete refresh must survive')
  // Modal chrome (upstream WorkspaceBrowser.tsx:1393-1418): title + description
  // + outline cancel/destructive pair + a role="status" pending line.
  const modal = rootCode.slice(rootCode.indexOf('<Modal\n'), rootCode.indexOf('</Modal>'))
  assert.ok(modal.includes("title={t('delete.workspace')}"), 'the dialog title is upstream delete.workspace copy')
  assert.ok(modal.includes("description: deleteTarget.orphaned"), 'the orphan case keeps its own sentence')
  assert.ok(modal.includes("t('delete.desc', { name: deleteTarget.title })"), 'the normal case rides upstream delete.desc')
  assert.ok(modal.includes("t('confirm.deleteOrphan', { title: deleteTarget.title })"), 'the orphan sentence stays keyed')
  assert.ok(modal.includes('variant="outline"'), 'both footer buttons are outline (upstream danger pair)')
  assert.ok(modal.includes('className={cc.archiveManagerDanger}'), 'the destructive button rides the danger ink')
  assert.ok(modal.includes('disabled={deletePending}'), 'the dialog locks while the delete is in flight')
  assert.ok(modal.includes('role="status"'), 'the pending row is a live status region')
  assert.ok(modal.includes("t('delete.pending')"), 'the pending row uses upstream copy')
  // The dialog is mounted with the source liveness guard and focus discipline
  // the archive manager uses (opening must not strand a keyboard user).
  assert.ok(rootCode.includes('deleteBodyRef.current?.focus()'), 'focus must land inside the dialog')
  assert.ok(rootCode.includes('if (server === undefined || !server.connected) setDeleteTarget(null)'), 'a dead source must drop the armed confirm')
  assert.ok(rootCode.includes('if (opener !== null && opener.isConnected) opener.focus()'), 'closing must restore focus to the opener')
})

test('T5: the row-action accessible names are {name}-parameterized and used', () => {
  // Both dictionaries, both keys, both sides.
  for (const key of ['action.newSession.aria', 'action.menu.workspace', 'action.menu.session']) {
    for (const dict of [dictionarySide(locales, 'zh'), dictionarySide(locales, 'en')]) {
      const match = new RegExp(`'${key.replace('.', '\\.')}': '([^']*)'`).exec(dict)
      assert.ok(match, `both dictionaries must declare ${key}`)
      assert.ok(match[1].includes('{name}'), `${key} must be parameterized with {name}`)
    }
  }
  // The three live sites pass the ROW label (workspace title / session title),
  // mirroring upstream Rows.tsx:179,190,492.
  assert.ok(
    sectionCode.includes("t('action.newSession.aria', { name: workspace.title })"),
    'the workspace `+` must name its workspace',
  )
  assert.ok(
    sectionCode.includes("t('action.menu.workspace', { name: workspace.title })"),
    'the workspace kebab must name its workspace',
  )
  assert.ok(
    sectionCode.includes("t('action.menu.session', { name: sessionTitleText })"),
    'the session kebab must name its session',
  )
  for (const parameterized of ['t(\'action.newSession.aria\'', 't(\'action.menu.workspace\'', 't(\'action.menu.session\'']) {
    assert.ok(sectionCode.includes(parameterized), `${parameterized} must be used`)
  }
  // The generic keys are gone: a bare action.newSession / action.menu can no
  // longer typecheck (the keys are removed from the dictionaries).
  assert.ok(sectionCode.includes("aria-label={t('action.newSession.aria'"), 'no generic newSession label may remain')
  assert.equal(sectionCode.includes("t('action.menu')"), false, 'the generic action.menu key must be gone')
  assert.equal(locales.includes("'action.menu':"), false, 'the generic action.menu key must be gone from the dictionaries')
  assert.equal(locales.includes("'action.newSession':"), false, 'the generic action.newSession key must be gone')
  // T2a's fourth site (the archive button that carried `action.archive`): the
  // verb moved INTO the row menu, whose anchor now carries the row name — see
  // the T5 note in the report; the generic key is gone here too.
  assert.equal(locales.includes("'action.archive':"), false, 'the generic action.archive key must be gone')
  // The workspace delete verb now rides upstream `delete.workspace` (menu entry
  // AND the modal's confirm button), so the old generic key is dead copy.
  assert.equal(locales.includes("'action.delete':"), false, 'the dead generic action.delete key must be gone')
})

test('T10: completed rides the official StateDot `done` tone, no bespoke dot', () => {
  assert.ok(
    sectionCode.includes('return <StateDot state="done" size={10} />'),
    'the session row completed dot must be StateDot done',
  )
  assert.ok(
    stripComments(source('../src/client/SessionTodoArea.tsx')).includes('<StateDot state="done" size={10} />'),
    'the pinned todo strip renders the same official done dot',
  )
  assert.equal(chamberCode.includes('.stateCompleted'), false, 'the bespoke .stateCompleted class must be deleted')
  assert.equal(sectionCode.includes('cc.stateCompleted'), false, 'no render site may reference the dead class')
  assert.equal(
    stripComments(source('../src/client/SessionTodoArea.tsx')).includes('cc.stateCompleted'),
    false,
    'no render site may reference the dead class',
  )
})

test('T11: the row window is a two-way disclosure with upstream copy', () => {
  const disclosureFrom = sectionCode.indexOf('{hiddenVisibleCount > 0')
  const disclosure = sectionCode.slice(disclosureFrom, sectionCode.indexOf("t('sessions.expand'", disclosureFrom) + 200)
  assert.ok(disclosure.includes('aria-expanded={rowsExpanded}'), 'the disclosure must report its state')
  assert.ok(
    normalize(disclosure).includes("setSessionRowsExpanded(prev => ({ ...prev, [workspaceKey]: !rowsExpanded }))"),
    'the disclosure must collapse again (two-way)',
  )
  assert.ok(disclosure.includes("t('sessions.collapse')"), 'the expanded state renders upstream sessions.collapse copy')
  assert.ok(disclosure.includes("t('sessions.expand', { n: hiddenVisibleCount })"), 'the collapsed state renders upstream sessions.expand copy')
  // The disclosure window is expansion-independent, so the control survives its
  // own expansion (upstream WorkspaceBrowser.tsx:598-609).
  assert.ok(sectionCode.includes('sessionRowDisclosure({'), 'the disclosure must read its own expansion-independent window')
  for (const [key, copy] of [['sessions.expand', '展开其余 {n} 个会话'], ['sessions.collapse', '收起']] as const) {
    assert.ok(locales.includes(`'${key}': '${copy}'`), `zh copy must match upstream: ${key}`)
  }
  assert.equal(locales.includes("'sessionRows.showMore'"), false, 'the retired chamber key must be gone')
  assert.equal(sectionCode.includes('sessionRows.showMore'), false, 'the retired chamber key must be gone from the component')
})

test('T12: row menus ride upstream Menu props; the sort menu mirrors ViewOptionsMenu', () => {
  // Row menus (workspace + session): closeOnPointerLeave, never compact.
  const sessionMenu = sessionRowMenu()
  assert.ok(sessionMenu.includes('closeOnPointerLeave'), 'the session row menu must close on pointer leave')
  assert.equal(sessionMenu.includes('compact'), false, 'the session row menu must not use compact')
  const workspaceAnchor = sectionCode.indexOf("t('action.menu.workspace'")
  const workspaceMenu = sectionCode.slice(sectionCode.lastIndexOf('<Menu', workspaceAnchor), workspaceAnchor)
  assert.ok(workspaceMenu.includes('closeOnPointerLeave'), 'the workspace row menu must close on pointer leave')
  assert.equal(workspaceMenu.includes('compact'), false, 'the workspace row menu must not use compact')
  // The sort trigger follows the upstream view-options menu (dense + Tooltip).
  assert.ok(sectionCode.includes('dense'), 'the sort menu must use upstream dense, not compact')
  assert.ok(
    normalize(sectionCode).includes('<Menu dense portal align="end" open={sortMenuOpen === server.id}'),
    'the sort menu must carry dense + portal + align=end',
  )
  // No Menu anywhere in this package may use compact again (comments stripped,
  // so the explanatory notes above cannot satisfy — or break — the lock).
  assert.equal(sectionCode.includes('compact'), false, 'no Menu may use compact')
  assert.equal(rootCode.includes('compact'), false, 'no Menu may use compact')
})

test('T7: wording, glyph, tooltips, tree name and rail controls follow upstream', () => {
  // Wording (vendor ui-workspace locales.ts:19,50-58).
  for (const [key, copy] of [
    ['status.running', '进行中'],
    ['status.waitingApproval', '等待审批'],
    ['status.planReview', '计划待审'],
    ['orderBy.updated', '最近更新'],
    ['action.addWorkspace', '添加工作区'],
    ['search.unavailable', '内容搜索暂不可用，仅显示名称匹配。'],
  ] as const) {
    assert.ok(locales.includes(`'${key}': '${copy}'`), `zh copy must follow upstream: ${key}`)
  }
  // The browse tree carries an accessible name like its results sibling.
  assert.ok(
    normalize(sectionCode).includes("aria-label={query === '' && server.aggregateError === undefined ? t('section.sessions') : undefined}"),
    'the browse tree must be named',
  )
  assert.ok(locales.includes("'section.sessions': '会话'"), 'the browse tree name is upstream section.sessions')
  assert.ok(locales.includes("'section.sessions': 'Sessions'"), 'the browse tree name is upstream section.sessions')
  // Add-workspace uses the official project-add glyph.
  assert.ok(sectionCode.includes('<IconProjectAddOutline16 size={14} />'), 'the add-workspace control must use IconProjectAddOutline16')
  // The four source-header controls ride the official Tooltip instead of title=.
  for (const label of [
    'label={sortLabel}',
    "label={t('action.addWorkspace')}",
    "label={t('search.sessions.aria')}",
    "label={t('action.purgeArchived')}",
  ]) {
    assert.ok(sectionCode.includes(`<Tooltip ${label} side="bottom" delayMs={500}>`), `the header control must use Tooltip: ${label}`)
  }
  for (const title of ['title={sortLabel}', "title={t('action.addWorkspace')}", "title={t('search.sessions.aria')}", "title={t('action.purgeArchived')}"]) {
    assert.equal(sectionCode.includes(title), false, `the borrowed native title must be gone: ${title}`)
  }
  // The collapsed rail renders named, operable buttons — and keeps the dot.
  assert.ok(rootCode.includes('className={cc.railDotButton}'), 'the rail must render a button per source')
  assert.ok(rootCode.includes('aria-label={label}'), 'the rail button must be named')
  assert.ok(rootCode.includes("aria-current={active ? 'true' : undefined}"), 'the active source must be marked')
  assert.ok(rootCode.includes('chamberBridge.requestActivateSource(server.id)'), 'the rail button must be operable')
  assert.ok(rootCode.includes('className={clsx(cc.railDot, active && cc.railDotActive)}'), 'the status dot + active ring must stay')
  assert.ok(rootCode.includes('style={{ ...sourceDotStyle(server), ...sourceAccentStyle(server) }}'), 'the source colour must stay on the dot')
  assert.equal(rootCode.includes('title={server.label}'), false, 'the inert title-only span must be gone')
})

test('A5/A6/A2 and finding 11: store engine, documented reasons, no inline copy', () => {
  // A5: the projection rides the store engine's factory; the hand-rolled
  // listener Set is gone; set() (plain arrays) is the write path.
  assert.ok(panelSource.includes("import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'"), 'panel-source must import the store engine')
  assert.ok(panelSource.includes('const panels = createSnapshotStore<readonly SidebarPanelMetadata[]>([])'), 'the projection must be a createSnapshotStore product')
  assert.ok(panelSource.includes('panels.set(next)'), 'the projection must publish through set()')
  assert.equal(panelSource.includes('new Set<() => void>()'), false, 'the hand-rolled listener Set must be gone')
  assert.equal(panelSource.includes('getSnapshot: () => current'), false, 'the hand-rolled observable must be gone')
  // A6: the chamber-owned children declaration carries its documented reason.
  assert.ok(
    normalize(index).includes('A6 (2026-09-11 upstream-alignment, audit recommendation: KEEP with this'),
    'the children declaration must document why it is chamber-owned',
  )
  assert.ok(normalize(index).includes('the official bundle never loads in a chamber boot'), 'the reason must state that the official bundle never loads')
  assert.ok(normalize(index).includes('type collision'), 'the reason must state the locale key-union collision')
  // A2: labelOf's local-copy reason is stated (and the copy is still local).
  assert.ok(
    normalize(panelSource).includes('2026-09-11 upstream-alignment A2: audit recommendation is KEEP with this'),
    'labelOf must keep its documented reason',
  )
  assert.ok(panelSource.includes('typeof label === \'function\' ? label() : label'), 'labelOf stays the local one-liner')
  // Finding 11: the archive dialog's inline Chinese is gone (comments stripped).
  assert.equal(hasCjk(archiveCode), false, 'ArchiveManagerDialog must carry no hardcoded Chinese outside comments')
  assert.ok(archiveCode.includes("t('archive.manager.busyOther')"), 'the busy-refusal line must ride the dictionary')
  assert.ok(archiveCode.includes("t('archive.manager.deleting')"), 'the in-flight status must ride the dictionary')
  for (const dict of [dictionarySide(locales, 'zh'), dictionarySide(locales, 'en')]) {
    assert.ok(dict.includes("'archive.manager.busyOther':"), 'both dictionaries must declare the busy-refusal copy')
    assert.ok(dict.includes("'archive.manager.deleting':"), 'both dictionaries must declare the in-flight copy')
  }
})

test('T7 active-Schedule marker: rendered at the upstream position, both row kinds', () => {
  // Upstream: `{row.hasActiveSchedule && <ActiveScheduleIndicator/>}` right after
  // the row title (vendor ui-workspace Rows.tsx:468) and after the search row's
  // title inside the heading (Rows.tsx:351), fed by tree.ts:161-163.
  const rowMarker = sectionCode.slice(sectionCode.indexOf('cc.sessionTitle'), sectionCode.indexOf('cc.sessionStateSlot', sectionCode.indexOf('cc.sessionTitle')))
  assert.ok(
    normalize(rowMarker).includes("{session.hasActiveSchedule === true && ( <SessionScheduleIndicator label={t('schedule.active')} /> )}"),
    'the session row must render the marker right after its title',
  )
  const searchMarker = sectionCode.slice(sectionCode.indexOf('cc.searchResultTitle'), sectionCode.indexOf('cc.searchResultWorkspace'))
  assert.ok(
    normalize(searchMarker).includes("{projectedHasActiveSchedule(item.sessionId) && ( <SessionScheduleIndicator label={t('schedule.active')} /> )}"),
    'the search row must render the marker right after its title',
  )
  // The marker itself mirrors upstream's markup and rides the official glyph.
  const indicator = sectionCode.slice(sectionCode.indexOf('function SessionScheduleIndicator'), sectionCode.indexOf('function projectionToLocalSearchSnapshot'))
  assert.ok(indicator.includes('role="img"'), 'the marker is an image role like upstream')
  assert.ok(indicator.includes('aria-label={label}') && indicator.includes('title={label}'), 'the marker names itself with the copy')
  assert.ok(indicator.includes('<IconAlarmClockOutline16 size={16} />'), "upstream's alarm-clock glyph at 16px")
  assert.ok(chamberCss.includes('.scheduleIndicator'), 'the marker has its own class')
  // Exactly one rule (the marker is one element, not one per row kind).
  assert.equal(chamberCode.split('.scheduleIndicator').length - 1, 1, 'exactly one .scheduleIndicator rule')
  // The copy key, both languages, upstream wording.
  assert.ok(locales.includes("'schedule.active': '有活动定时任务'"), 'zh copy must match upstream')
  assert.ok(locales.includes("'schedule.active': 'Has active scheduled task'"), 'en copy must match upstream')
  // End-to-end: the fact is projected from the row's projection bag on the
  // mounted path and from the unary wire's projections block on the fallback
  // path — one helper, no second authority.
  const derive = source('../src/shared/derive.ts')
  assert.ok(derive.includes('export function hasActiveScheduleOf('), 'the derivation must be exported for tests')
  assert.ok(derive.includes('Array.isArray(schedule) && schedule.length > 0'), 'the derivation mirrors upstream (non-empty schedule)')
  assert.ok(
    stripComments(source('../src/shared/instance-api.ts')).includes('if (hasActiveScheduleOf(summary?.projections?.values)) row.hasActiveSchedule = true'),
    'the unary fallback carries the same fact from projections.values',
  )
  assert.ok(
    derive.includes('...(hasActiveScheduleOf(row.projectionValues) ? { hasActiveSchedule: true as const } : {}),'),
    'the mounted projection carries the fact from projectionValues',
  )
})

test('the styling hook is the data-* attribute form, :disabled outside the brackets', () => {
  // Cross-package rule (the chamber mobile package documents it,
  // packages/dsh-chamber-client-ui-mobile/src/client/styles.ts:10-20): styling
  // hooks are data attributes, because CSS Modules hashes local class names.
  const reveal = normalize(chamberCss)
  assert.ok(reveal.includes('.workspaceHeader:hover [data-git-action]'), 'the hover reveal must use the attribute hook')
  assert.ok(reveal.includes('.workspaceHeader:has(:focus-visible) [data-git-action]'), 'the keyboard reveal must use the attribute hook')
  assert.ok(reveal.includes('.workspaceHeader:has(.rowActionsVisible) [data-git-action]'), 'the kebab reveal must use the attribute hook')
  assert.ok(reveal.includes('.workspaceHeader:hover [data-git-action]:disabled'), 'the disabled rule keeps :disabled OUTSIDE the attribute selector')
  assert.equal(chamberCode.includes('git-ws-action'), false, 'the retired class hook must be gone')
  assert.equal(chamberCode.includes('[data-git-action:disabled]'), false, 'a pseudo-class inside the attribute selector is invalid CSS')
})

/**
 * The session row's Menu block: its items (which precede the anchor in the
 * JSX) plus the anchor itself, located by the fork entry — the id only the
 * SESSION menu carries.
 */
function sessionRowMenu(): string {
  const forkItem = sectionCode.indexOf("id: 'fork'")
  assert.ok(forkItem !== -1, 'the session menu must exist')
  // In the JSX the Menu's props and onSelect handler precede its items, so the
  // region starts at the Menu opening tag itself.
  const from = sectionCode.lastIndexOf('<Menu', forkItem)
  assert.ok(from !== -1, 'the session menu element must exist')
  const anchor = sectionCode.indexOf("t('action.menu.session'", forkItem)
  assert.ok(anchor !== -1, 'the session menu anchor must exist')
  return sectionCode.slice(from, sectionCode.indexOf('IconEllipsisOutline16', anchor) + 60)
}

/** One side of the locales module (zh first, en second). */
function dictionarySide(text: string, side: 'zh' | 'en'): string {
  const boundary = text.indexOf("export const en = {")
  return side === 'zh' ? text.slice(0, boundary) : text.slice(boundary)
}

/** Every file under `dir` (relative to src/) containing `needle`. */
function findInTree(dir: string, needle: string): string[] {
  const base = fileURLToPath(new URL(`../${dir}`, import.meta.url))
  const hits: string[] = []
  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (readFileSync(full, 'utf8').includes(needle)) hits.push(full.slice(base.length + 1))
    }
  }
  walk(base)
  return hits
}
