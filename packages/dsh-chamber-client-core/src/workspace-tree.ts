/**
 * 「按工作区树」的纯投影（上游 ui-workspace `owningParentFolder` 的移植，design 06 §3.4）：
 * 把每个真实工作区挂到**最近的已注册父目录**下。跑在 git 家族之上时**家族优先**：
 * 派生 worktree 的显示父级取它 main 的父级，整族保持同一层级与连续性，不与
 * "连续家族不变式"（design 08 §3.3）冲突；没有家族信息时退化为上游的纯前缀规则。
 *
 * 纯函数：无 store、无 DOM、无渲染——parents 映射与深度都由这里一次算出，渲染只消费。
 */

/**
 * Path spelling normalisation identical to the vendor rule: a Windows spelling
 * (/^[A-Za-z]:[\/]/ or a UNC prefix) compares with '/' separators; POSIX
 * backslashes stay literal characters. Trailing slashes are stripped.
 */
export function normalizeWorkspacePath(path: string): string {
  const windows = /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
  return (windows ? path.replaceAll('\\', '/') : path).replace(/\/+$/, '')
}

/**
 * Nearest REGISTERED ancestor directory of `path` among `parents`, excluding the
 * directory itself. Matching is case-sensitive (workspace identity is), and the
 * longest registered prefix wins (the nearest parent, not the root). PURE.
 */
export function owningParentFolder(path: string, parents: readonly string[]): string | undefined {
  const child = normalizeWorkspacePath(path)
  let owner: string | undefined
  let length = -1
  for (const parent of parents) {
    const root = normalizeWorkspacePath(parent)
    if (root.length > length && child !== root && child.startsWith(`${root}/`)) {
      owner = parent
      length = root.length
    }
  }
  return owner
}

/** One workspace row the tree projection may nest. */
export interface WorkspaceTreeEntry {
  id: string
  /** Wire display path; absent for synthetic/un-grouped rows (which never nest). */
  path?: string
  /** Display-only cwd-derived groups: never nested (design 06 §3.4). */
  synthetic?: boolean
  /** The synthetic trailing ungrouped bucket: never nested. */
  ungrouped?: boolean
}

/**
 * Display parent per workspace id. Path prefix first; then **family priority**:
 * when `familyMainOf` names a MAIN for a derived workspace, that workspace
 * inherits the MAIN's parent so the family block keeps one nesting level
 * (design 08 §3.3's continuous-family invariant). Degenerate registrations that
 * would create a cycle fall back to the path verdict for the offending entry.
 * PURE — the render order is untouched; only the parent map is produced.
 */
export function workspaceTreeParents(
  workspaces: readonly WorkspaceTreeEntry[],
  familyMainOf: (workspaceId: string) => string | undefined = () => undefined,
): Map<string, string | undefined> {
  const real = workspaces.filter(workspace => workspace.synthetic !== true && workspace.ungrouped !== true)
  const paths = real.flatMap(workspace => (workspace.path === undefined ? [] : [workspace.path]))
  const idByPath = new Map(real.flatMap(workspace => (workspace.path === undefined ? [] : [[workspace.path, workspace.id] as const])))
  const pathParent = new Map<string, string | undefined>(real.map(workspace => {
    const parentPath = workspace.path === undefined ? undefined : owningParentFolder(workspace.path, paths)
    return [workspace.id, parentPath === undefined ? undefined : idByPath.get(parentPath)]
  }))
  const parents = new Map(pathParent)
  const known = new Set(real.map(workspace => workspace.id))
  for (const workspace of real) {
    const mainId = familyMainOf(workspace.id)
    if (mainId === undefined || mainId === workspace.id || !known.has(mainId)) continue
    parents.set(workspace.id, pathParent.get(mainId))
  }
  // Cycle guard: walk each chain; an entry that closes a loop falls back to its path verdict.
  for (const workspace of real) {
    const seen = new Set<string>([workspace.id])
    let cursor = parents.get(workspace.id)
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        parents.set(workspace.id, pathParent.get(workspace.id))
        break
      }
      seen.add(cursor)
      cursor = parents.get(cursor)
    }
  }
  return parents
}

/**
 * Nesting depth per workspace id (0 = top level). An id whose parent chain leaves
 * the map (or is unknown) is depth 0. PURE and cycle-safe.
 */
export function workspaceTreeDepths(
  parents: ReadonlyMap<string, string | undefined>,
): Map<string, number> {
  const depths = new Map<string, number>()
  for (const id of parents.keys()) {
    let depth = 0
    const seen = new Set<string>([id])
    let cursor = parents.get(id)
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor)
      depth += 1
      cursor = parents.get(cursor)
    }
    depths.set(id, depth)
  }
  return depths
}
