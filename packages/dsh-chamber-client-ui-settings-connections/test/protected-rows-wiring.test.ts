/**
 * Protected-row wiring drift (design 21 §6.11.5 读面契约 + diff/apply 边界):
 * the three installed zones must render the BACKEND row union (composition and
 * seed rows exist only in `rows`), protected rows must be read-only, and
 * computePluginDiff's inputs must be narrowed to actionable rows.
 *
 * The dialog is a React component this DOM-free suite cannot render, so its
 * half is pinned at the SOURCE level — the same lockstep discipline as
 * installed-fence-wiring.test.ts. Each assertion is a regression that was real
 * (or would be):
 *
 * 1. local/gateway/ssh built their rows from `dependencies` only, so a live
 *    profile with `dependencies: {}` + non-empty `bundles` rendered an EMPTY
 *    installed list and its protected rows stayed invisible.
 * 2. An unfiltered diff input turns a composition row into a default-checked
 *    `missing` row; doApply submits it as an add spec and the backend refuses
 *    the whole batch (ordinary reconciliation breaks).
 * 3. The renderer must never re-derive protection: the former
 *    isDeniedPluginName / filterDeniedRows mirror is gone (§6.11.5).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(TEST_DIR, '..', 'src', 'client', 'PluginDialog.tsx'), 'utf8')

/** A source window around a marker (JSX call sites are matched in context). */
function window(marker: string, before = 0, after = 900): string {
  const index = source.indexOf(marker)
  assert.notEqual(index, -1, `PluginDialog.tsx no longer contains: ${marker}`)
  return source.slice(Math.max(0, index - before), index + after)
}

test('all three installed zones project the backend rows union (composition/seed rows included)', () => {
  for (const call of [
    'projectInstalledRows(localList.dependencies, pluginRowsOf(localList))',
    'projectInstalledRows(installed.dependencies, pluginRowsOf(installed))',
    'projectInstalledRows(remoteManifest.dependencies, pluginRowsOf(remoteManifest))',
  ]) {
    assert.ok(source.includes(call), `a zone no longer projects the backend rows union: ${call}`)
  }
  // rows 缺失（旧 gateway / 旧 producer）→ 回退路径，而不是崩溃或静默空表。
  assert.equal(source.split('projectInstalledRows(').length - 1, 3,
    'local / gateway / ssh must each project rows exactly once')
})

test('protected rows are read-only: role badge + hint, and no remove button', () => {
  // 三区共用同一个受保护门控的操作格（row.removable = 非受保护才可移除）。
  assert.equal(source.split('rowActionCell(').length - 1, 3, 'each zone must route its action cell through the shared gate')
  const cell = window('const rowActionCell', 0, 800)
  assert.match(cell, /row\.removable/u, 'the remove button is gated on the backend-computed non-protected fact')
  assert.match(cell, /css\.dim\} title=\{t\('pluginsProtectedHint'\)\}>—</u,
    'a protected row renders the read-only dash (with the hint as its title), never a remove button')
  // 角色徽标 + 受保护提示逐行渲染（rows[].role / rows[].protected 驱动）。
  assert.equal(source.split('roleBadge(row)').length - 1, 3)
  assert.equal(source.split('protectedHint(row)').length - 1, 3)
  // 渲染端绝不重算受保护集合：域名前缀谓词与旧过滤器都不许回来。
  assert.equal(/startsWith\('@/.test(source), false,
    'the dialog must not re-derive protection from name prefixes — rows[].protected is the authority')
  assert.equal(/isDeniedPluginName|filterDeniedRows/.test(source), false,
    'the deleted deny mirror must not come back (§6.11.5)')
  // 更严一层：连"用现成的常量/正则/切分自己拼前缀判断"都不许（2026-12 review：
  // 只查 `startsWith('@` 会漏掉 OFFICIAL_SCOPE_PREFIX、/^@deepseek-ai\//、split('/') 等变体）。
  // 检查的是 **代码**：import 说明符与注释里的 scope 字样不算（它们不带判定语义）。
  const codeOnly = source
    .replace(/import[\s\S]*?from\s*'[^']*'/g, 'import-stripped')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  assert.equal(/\bOFFICIAL_SCOPE_PREFIX\b|\blegacyProtectedName\b/.test(codeOnly), false,
    'the dialog must not import/use a scope predicate of its own (the transport filter lives in plugin-model)')
  assert.equal(/@deepseek-ai|@dsh-chamber/.test(codeOnly), false,
    'no scope literal may appear in dialog code — protection comes from rows[].protected')
})

test('the diff/apply boundary narrows BOTH computePluginDiff arguments (ssh transport form)', () => {
  // 对账视图是 **ssh** 面（loadSync 由 isSsh 门控），因此两侧都走 ssh 传输形收窄：
  // protected（后端判定）∪ 官方 scope（ssh 装面整批拒绝 ⇒ 传输能力）都不进批次。
  assert.match(source, /sshSyncableDependencies\(localRes\.manifest\.dependencies, pluginRowsOf\(localRes\.manifest\)\)/u,
    'the local diff argument must be narrowed (missing rows are default-checked adds)')
  assert.match(source, /sshSyncableDependencies\(remoteRes\.manifest\.dependencies, pluginRowsOf\(remoteRes\.manifest\)\)/u,
    'the remote diff argument must be narrowed (extra rows become removes)')
  // 第三个调用点：hasLocal 计数随之修正（受保护行不进对账面）。
  assert.equal(source.split('sshSyncableDependencies(').length - 1, 3)
  assert.match(window('const hasLocal', 0, 260), /sshSyncableDependencies\(localManifest\.dependencies, pluginRowsOf\(localManifest\)\)/u,
    'the reconcile "no local plugins" count must use the same narrowing')
  // 用户自己加的层必须仍然可同步（按角色收窄是功能回归，2026-12 review 修正）：
  // model 侧的 isActionableRow 只吃 protected，角色不参与。
  const model = readFileSync(join(TEST_DIR, '..', 'src', 'client', 'plugin-model.ts'), 'utf8')
  assert.match(model, /export function isActionableRow\(row: PluginRowShape\): boolean \{\s*return row\.protected === false/u,
    'the actionable predicate must be protected-only (layers stay syncable)')
  assert.match(model, /export function sshSyncableDependencies\(/u,
    'the ssh transport filter must exist as its own documented helper')
})

test('the old-gateway fallback hint is gateway-only and driven by the legacy projection (§6.11.7)', () => {
  assert.equal(source.split("t('pluginsLegacyGatewayHint')").length - 1, 1,
    'the version-skew hint belongs to the gateway zone alone')
  assert.match(window("t('pluginsLegacyGatewayHint')", 400, 120), /legacyRows \?/u,
    'the hint renders only when the projection actually fell back (no misleading copy on a new gateway)')
})
