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
    sessionMenu.includes('onArchiveSession(server, session.id)'),
    'selecting archive must run the same handler the old button ran',
  )
  // 2026-09-11 review-fix finding 5d: the third argument is dead (the confirm
  // that consumed the title is gone), so no caller may pass one again.
  assert.equal(
    sessionMenu.includes('onArchiveSession(server, session.id,'),
    false,
    'the retired title argument must not come back',
  )
  // No separate archive affordance survives in the row's action cluster.
  // 2026-09-11 review-fix finding 4: both bounds are CODE tokens (comments are
  // stripped before this file slices) and both are asserted. The retired bound
  // was the JSX comment "Trailing state slot", which stripComments removes →
  // indexOf = -1 → the slice silently ran to end-of-file, so these assertions
  // read "anywhere after the first cc.rowActions" (an accidental broadening
  // with a misleading failure message) instead of "inside the session row's
  // action cluster". The cluster opens at the cc.rowActions that belongs to the
  // session row — the LAST one before the session menu's anchor — and closes at
  // that row's trailing cc.sessionStateSlot.
  const sessionMenuAnchor = sectionCode.indexOf("t('action.menu.session'")
  assert.ok(sessionMenuAnchor >= 0, 'the session menu anchor must exist (region bound)')
  const rowActionsFrom = sectionCode.lastIndexOf('cc.rowActions', sessionMenuAnchor)
  const rowActionsTo = sectionCode.indexOf('cc.sessionStateSlot', rowActionsFrom)
  assert.ok(rowActionsFrom >= 0, 'the session row action cluster anchor (cc.rowActions) must exist')
  assert.ok(rowActionsTo > rowActionsFrom, 'the session row trailing slot anchor (cc.sessionStateSlot) must exist AFTER the cluster')
  const rowActions = sectionCode.slice(rowActionsFrom, rowActionsTo)
  // The region is the CLUSTER, not the file: a lock that silently widened to
  // end-of-file would also pass these two negatives for the wrong reason.
  assert.ok(rowActions.includes("id: 'archive'"), 'the region must contain the session row menu (archive is a menu verb there)')
  assert.ok(rowActions.length < sectionCode.length / 2, 'the region must stay a local cluster, not the rest of the file')
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
  // + outline cancel/destructive pair + a role="status" pending line + a
  // role="alert" failure line.
  const modal = rootCode.slice(rootCode.indexOf('<Modal\n'), rootCode.indexOf('</Modal>'))
  assert.ok(modal.includes("title={t('delete.workspace')}"), 'the dialog title is upstream delete.workspace copy')
  assert.ok(modal.includes("description: deleteTarget.orphaned"), 'the orphan case keeps its own sentence')
  assert.ok(modal.includes("t('delete.desc', { name: deleteTarget.title })"), 'the normal case rides upstream delete.desc')
  // 2026-09-11 review-fix finding 5e: the DESCRIPTION is a statement. The
  // long-standing `confirm.deleteOrphan` question (trailing "？") stays where it
  // belongs — the orphan badge's native title in the nav (asserted below).
  assert.ok(modal.includes("t('delete.descOrphan', { name: deleteTarget.title })"), 'the orphan description is its own statement key')
  assert.equal(modal.includes("t('confirm.deleteOrphan'"), false, 'the badge\'s question must not be the dialog description')
  for (const dict of [dictionarySide(locales, 'zh'), dictionarySide(locales, 'en')]) {
    const orphanDescription = /'delete\.descOrphan': '([^']*)'/.exec(dict)
    assert.ok(orphanDescription, 'both dictionaries must declare the orphan dialog description')
    assert.equal(orphanDescription[1].includes('？'), false, 'the dialog description must be a statement, not a question')
    assert.equal(orphanDescription[1].includes('?'), false, 'the dialog description must be a statement, not a question')
  }
  assert.ok(
    sectionCode.includes("title={t('confirm.deleteOrphan', { title: workspace.title })}"),
    'the orphan badge keeps its own native title',
  )
  assert.ok(modal.includes('variant="outline"'), 'both footer buttons are outline (upstream danger pair)')
  assert.ok(modal.includes('className={cc.archiveManagerDanger}'), 'the destructive button rides the danger ink')
  assert.ok(modal.includes('disabled={deletePending}'), 'the dialog locks while the delete is in flight')
  assert.ok(modal.includes('role="status"'), 'the pending row is a live status region')
  assert.ok(modal.includes("t('delete.pending')"), 'the pending row uses upstream copy')
  // 2026-09-11 review-fix finding 3: a FAILED delete reports INSIDE the dialog
  // (upstream WorkspaceBrowser.tsx:1417-1418) and the dialog stays open — the
  // row-keyed inline error has no surface once the deleted row unmounted.
  assert.ok(
    modal.includes('{deleteError !== null && <div className={cc.deleteError} role="alert">{deleteError}</div>}'),
    'the dialog must render the failure as a role="alert" line',
  )
  assert.ok(rootCode.includes('const [deleteError, setDeleteError] = useState<string | null>(null)'), 'the failure message must be shell state')
  const confirmDelete = rootCode.slice(rootCode.indexOf('const confirmDeleteWorkspace = ()'), rootCode.indexOf('const commitRename = ()'))
  assert.ok(
    normalize(confirmDelete).includes("setDeleteError(reason instanceof Error ? reason.message : String(reason))"),
    'the failure message must reach the dialog',
  )
  assert.ok(
    normalize(confirmDelete).includes('throw reason'),
    'the failure must still be rethrown so the keyed rowErrors line keeps reporting it',
  )
  assert.ok(normalize(confirmDelete).includes('if (ok) dismissDeleteWorkspace()'), 'the dialog closes on SUCCESS only')
  assert.equal(
    normalize(confirmDelete).includes('setDeletePending(false) dismissDeleteWorkspace()'),
    false,
    'a settled FAILURE must not auto-close the dialog (that is the invisible-failure defect)',
  )
  assert.ok(
    normalize(rootCode).includes('if (deleteTarget === null || deletePending || deleteError !== null) return'),
    'a reported failure must survive its source dropping (the alert is the only explanation left)',
  )
  // The dialog is mounted with the source liveness guard and focus discipline
  // the archive manager uses (opening must not strand a keyboard user).
  assert.ok(rootCode.includes('deleteBodyRef.current?.focus()'), 'focus must land inside the dialog')
  assert.ok(rootCode.includes('if (server === undefined || !server.connected) setDeleteTarget(null)'), 'a dead source must drop the armed confirm')
  assert.ok(rootCode.includes('if (opener !== null && opener.isConnected) opener.focus()'), 'closing must restore focus to the opener')
  // 2026-09-11 review-fix finding 2: the retired "can never stack" claim was
  // false — the orphan badge is an always-rendered tabbable button OUTSIDE the
  // hover cluster and the official Modal has no focus trap, so every opener
  // must gate. The both-directions lock lives in its own test below.
})

test('finding 2: at most ONE chamber dialog layer, in BOTH orderings', () => {
  // ONE rule, consulted by every opener (SidebarRoot `otherChamberDialogOpen`):
  // each clause excludes the caller's own layer, so all three sites share the
  // rule instead of keeping three copies that can drift apart.
  const predicate = rootCode.slice(
    rootCode.indexOf('function otherChamberDialogOpen('),
    rootCode.indexOf('const openWorkspaceBrowser = ('),
  )
  assert.ok(predicate.length > 0, 'the shared one-layer rule must exist')
  for (const [layer, state] of [
    ["'delete'", 'deleteTarget !== null'],
    ["'archive'", 'archiveCleanupServerId !== null'],
    ["'browser'", 'addingWorkspace !== null'],
  ] as const) {
    assert.ok(
      normalize(predicate).includes(`self !== ${layer} && ${state}`),
      `the rule must cover the ${layer} layer`,
    )
  }
  // Every opener consults it, inside its OWN handler, BEFORE it arms/opens the
  // layer — so the two REVERSE directions (archive manager / add-workspace
  // browser opened on top of an armed delete confirm) are as guarded as the arm.
  const handler = (from: string, to: string): string => {
    const at = rootCode.indexOf(from)
    assert.ok(at >= 0, `${from} must exist (lock region bound)`)
    const end = rootCode.indexOf(to, at)
    assert.ok(end > at, `${to} must follow ${from} (lock region bound)`)
    return rootCode.slice(at, end)
  }
  const openers = [
    ['the workspace-delete arm', handler('const onDeleteWorkspace = (', 'const dismissDeleteWorkspace = ('), "if (otherChamberDialogOpen('delete')) return", 'setDeleteTarget({'],
    ['the archive manager opener', handler('const onOpenArchiveCleanup = (', 'const closeArchiveCleanup = ('), "if (otherChamberDialogOpen('archive')) return", 'setArchiveCleanupServerId(server.id)'],
    ['the add-workspace opener', handler('const openWorkspaceBrowser = (', 'const onOpenArchiveCleanup = ('), "if (otherChamberDialogOpen('browser')) return", 'setAddingWorkspace(sourceId)'],
  ] as const
  for (const [name, code, guard, action] of openers) {
    const guardAt = code.indexOf(guard)
    assert.ok(guardAt >= 0, `${name} must refuse while another chamber dialog layer is up`)
    assert.ok(code.indexOf(action) > guardAt, `${name}'s gate must precede the layer it opens`)
  }
  // The reachable control this whole invariant exists for is still rendered
  // outside the hover cluster…
  assert.ok(sectionCode.includes('className={cc.orphanBadge}'), 'the reachable badge must still render outside the hover cluster')
  // …and the section cannot poke the raw setter anymore: the shell hands it the
  // GUARDED opener as the only add-workspace entry (capability preserved — the
  // `+` still opens the browser whenever no other layer is up).
  assert.equal(sectionCode.includes('setAddingWorkspace('), false, 'the section must ride the guarded opener, not the raw setter')
  assert.ok(sectionCode.includes('openWorkspaceBrowser(server.id)'), 'the source-header `+` must ride the guarded opener')
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

test('T10 (2026-09 amended): completed is the chamber blue dot, running keeps the official ring', () => {
  // The 2026-09-11 alignment round swapped this mark to the official
  // `StateDot state="done"`; the 2026-09 user decision RESTORED the pre-T10
  // chamber dot — `done`'s `--dsw-alias-state-success-primary` green is the
  // very token of the source header's own connection dot (`.statusOk`), so
  // completion and "server connected" painted the same colour in one sidebar.
  // Rationale and geometry: design 06 §4.3 + the stylesheet note.
  assert.ok(
    sectionCode.includes('return <span className={cc.stateCompleted} />'),
    'the session row completed mark must be the restored chamber blue dot',
  )
  assert.ok(
    stripComments(source('../src/client/SessionTodoArea.tsx')).includes('<span className={cc.stateCompleted} />'),
    'the pinned todo strip renders the same blue dot',
  )
  assert.ok(
    sectionCode.includes('return <StateDot state="ongoing" size={10} />'),
    'running / running-subagents must keep the official StateDot ongoing ring',
  )
  assert.equal(
    sectionCode.includes('<StateDot state="done"'),
    false,
    'the official done tone must not come back (it collides with .statusOk)',
  )
  assert.ok(
    chamberCode.includes('.stateCompleted'),
    'the stylesheet must define the restored blue dot class',
  )
  assert.ok(
    chamberCode.includes('background: var(--dsw-static-deepseek-450)'),
    'the restored dot rides the brand blue the ongoing ring uses',
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

test('T12 (2026-09 amended): menus keep upstream interaction at chamber density', () => {
  // Interaction stays upstream: row menus close on pointer leave, the sort menu
  // keeps portal + align=end + the active-mode label.
  const sessionMenu = sessionRowMenu()
  assert.ok(sessionMenu.includes('closeOnPointerLeave'), 'the session row menu must close on pointer leave')
  const workspaceAnchor = sectionCode.indexOf("t('action.menu.workspace'")
  const workspaceMenu = sectionCode.slice(sectionCode.lastIndexOf('<Menu', workspaceAnchor), workspaceAnchor)
  assert.ok(workspaceMenu.includes('closeOnPointerLeave'), 'the workspace row menu must close on pointer leave')
  assert.ok(
    normalize(sectionCode).includes('<Menu compact portal align="end" open={sortMenuOpen === server.id}'),
    'the sort menu must carry compact + portal + align=end',
  )
  // Density is chamber's call (STATUS「菜单密度 = chamber 档」, design 06 §7):
  // T12's "never compact" was reverted in 2026-09 because the official default
  // (40px items) and `dense` (34px) are sized against upstream's own 32px rows,
  // not our 26px ones. All three call sites use the primitive's `compact`.
  // Site-by-site, not a global count: a decoy `compact` line anywhere else in the
  // file (say inside a template literal) must not stand in for a real call site.
  const menuTags = [...sectionCode.matchAll(/<Menu\b/g)]
    .map((match) => sectionCode.slice(match.index, sectionCode.indexOf('items=', match.index)))
  assert.equal(menuTags.length, 3, 'the package renders exactly three menus')
  for (const tag of menuTags) {
    assert.match(tag, /(?:^|\s)compact(?:\s|$)/,
      'every menu call site (session, workspace, sort) must pass compact')
  }
  const compactCount = sectionCode.match(/^\s*compact$/gm)?.length ?? 0
  assert.equal(compactCount, 3, 'and no fourth compact may appear outside those sites')
  assert.equal(/^\s*dense$/m.test(sectionCode), false, 'no menu may go back to the 34px dense variant')
  assert.equal(rootCode.includes('dense'), false, 'no menu in this package may use dense')
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
  // 2026-09-11 review-fix finding 1: the fact must ALSO ride the PROJECTION
  // signature (serversProjectionSignature), which BOTH publish gates read
  // (App.tsx before chamberBridge.publish, and this shell's own subscription).
  // Non-sparse on purpose — that row is a change detector, never persisted —
  // so a schedule-only flip moves the bytes even when nothing else does (the
  // behavioural proof lives in derive.test.ts).
  assert.ok(
    derive.includes('hasActiveSchedule: x.hasActiveSchedule === true,'),
    'the projection signature row carries the schedule fact (change detector, non-sparse)',
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

test('the test-only vendor loader stays environment-free (CI regression)', () => {
  // 2026-09-12 CI fix: mapping the specifier to vendor SOURCE made the suite
  // depend on the vendored member's install shape — it passed locally (stray
  // vendor node_modules) and failed in CI with `ERR_MODULE_NOT_FOUND: zustand`
  // (run 34667681904). The loader now maps to a local contract-faithful double;
  // the REAL import stays pinned on the production side (the A5 lock) and is
  // resolved for real by `pnpm run build:renderer`.
  const loader = stripComments(source('../test/vendor-loader.mjs'))
  assert.match(loader, /'\.\/vendor-store-double\.mjs'/, 'the loader must map to the local double')
  assert.doesNotMatch(loader, /vendor\//, 'the loader must not resolve anything under vendor/ (environment-dependent)')
  assert.match(source('../test/vendor-store-double.mjs'), /export function createSnapshotStore/,
    'the double must implement the engine factory the projection consumes')
})
