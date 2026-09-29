/**
 * 「按工作区树」（design 06 §3.4）：上游 owningParentFolder 的规则移植、家族优先
 * （design 08 §3.3 连续家族不变式）、深度计算与渲染接线锁。
 * Run directly: node test/session-rows/workspace-tree.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  normalizeWorkspacePath, owningParentFolder, workspaceTreeDepths, workspaceTreeParents,
  type WorkspaceTreeEntry,
} from '@dsh-chamber/dsh-chamber-client-core/workspace-tree'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const SECTION = read('../../src/client/ServerSection.tsx')
const HEADER = read('../../src/client/ServerSectionHeader.tsx')
const CSS = read('../../src/client/sidebar-chamber.module.css')

const entry = (id: string, path: string, extra: Partial<WorkspaceTreeEntry> = {}): WorkspaceTreeEntry => ({ id, path, ...extra })

test('owningParentFolder ports the vendor rule: nearest registered ancestor, self excluded, case- and separator-correct', () => {
  const parents = ['/code', '/code/app', '/code/app/lib', '/other']
  assert.equal(owningParentFolder('/code/app/lib/src', parents), '/code/app/lib', 'the nearest registered ancestor wins')
  assert.equal(owningParentFolder('/code/app', parents), '/code')
  assert.equal(owningParentFolder('/code', parents), undefined, 'a directory is never its own parent')
  assert.equal(owningParentFolder('/Code/app', parents), undefined, 'matching stays case-sensitive (workspace identity)')
  assert.equal(owningParentFolder('/code/app2', parents), '/code', 'a bare prefix without the separator is not a parent')
  assert.equal(owningParentFolder('C:\\work\\proj\\sub', ['C:\\work\\proj']), 'C:\\work\\proj', 'Windows spellings compare with / separators')
  assert.equal(owningParentFolder('/a/b\\c', ['/a/b']), undefined, 'a POSIX backslash is a literal character, not a separator')
  assert.equal(normalizeWorkspacePath('C:\\work\\proj\\'), 'C:/work/proj')
  assert.equal(normalizeWorkspacePath('/a/b///'), '/a/b')
})

test('workspaceTreeParents: path nesting first, family priority second, synthetic rows never nest', () => {
  const rows = [
    entry('root', '/code'),
    entry('app', '/code/app'),
    entry('lib', '/code/app/lib'),
    entry('main', '/elsewhere/repo'),
    entry('wt', '/home/.dsh/worktrees/repo-abc/wt1'),
    entry('other', '/unrelated'),
    entry('ungrouped', '', { ungrouped: true }),
    entry('synthetic', '/cwd-derived', { synthetic: true }),
  ]
  const plain = workspaceTreeParents(rows)
  assert.equal(plain.get('app'), 'root')
  assert.equal(plain.get('lib'), 'app', 'the chain nests deeper than one level')
  assert.equal(plain.get('wt'), undefined, 'a registered ancestor is required for nesting')
  assert.equal(plain.get('ungrouped'), undefined, 'the ungrouped bucket never nests')
  assert.equal(plain.get('synthetic'), undefined, 'display-only cwd groups never nest')

  // 家族优先：派生 worktree 取 main 的父级，而不是自己路径前缀下的父节点。
  const family = workspaceTreeParents(rows, id => (id === 'wt' ? 'main' : undefined))
  assert.equal(family.get('wt'), plain.get('main'))
  // 即便给派生自己的路径注册了父目录，家族优先仍然胜出（家族不被拆开）。
  const nested = [...rows, entry('wtroot', '/home/.dsh/worktrees/repo-abc')]
  const familyNested = workspaceTreeParents(nested, id => (id === 'wt' ? 'main' : undefined))
  assert.equal(familyNested.get('wt'), familyNested.get('main'))
  assert.notEqual(familyNested.get('wt'), 'wtroot')
})

test('workspaceTreeParents/Depths stay cycle-safe on a degenerate registration', () => {
  const rows = [entry('a', '/x'), entry('b', '/x/b')]
  // a 的家族 main 是 b ⇒ a 取 b 的父级 = a 自己：自环必须被守卫回退到路径判定。
  const parents = workspaceTreeParents(rows, id => (id === 'a' ? 'b' : undefined))
  assert.equal(parents.get('a'), undefined)
  assert.equal(parents.get('b'), 'a')
  const depths = workspaceTreeDepths(parents)
  assert.equal(depths.get('a'), 0)
  assert.equal(depths.get('b'), 1)
})

test('the section renders tree mode from the pure projection (source lock)', () => {
  assert.ok(SECTION.includes('const treeDepths = useMemo(') && SECTION.includes("groupByMode !== 'workspace-tree'"),
    'tree mode is a per-source groupBy state, computed in one memoized projection')
  assert.ok(SECTION.includes('workspaceTreeDepths(workspaceTreeParents('),
    'the render consumes the pure parents/depths projection')
  assert.ok(SECTION.includes('id => getWorkspaceGitFlag(server.id, id)?.mainWorkspaceId'),
    'family priority is fed from the git plugin flags (absent = pure prefix)')
  assert.ok(SECTION.includes('treeDepth > 0 && cc.workspaceTreeNested'))
  assert.ok(SECTION.includes("'--chamber-tree-depth': String(treeDepth)"))
  assert.ok(SECTION.includes('data-chamber-tree-depth={treeDepth > 0 ? treeDepth : undefined}'))
  assert.ok(CSS.includes('calc(var(--chamber-tree-depth, 1) * 12px)'),
    'the indentation is one CSS rule serving any depth')
  assert.ok(HEADER.includes("id: 'workspace-tree', label: t('groupBy.workspaceTree'), icon: <IconWorkspaceTreeOutlineRegular /> }"),
    'the view-options menu exposes the axis (enabled; no git info degrades to pure prefix)')
})
