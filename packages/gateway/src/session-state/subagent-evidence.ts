/**
 * P2a 子代理证据（design 19 §3.5 I-12 / design 17 §10.7）：由行集重算父行的
 * **运行中后代数**、谱系认证位与 fail-closed 保留位。纯函数 + 显式脏行回调。
 *
 * 运行数按**祖先链归并**（与 P2b 的 `lineageFactsForRows`、侧栏 `indexSubagentDescendants`
 * 同规则）：子代理再生子代理时，运行中的孙代也计入祖父——只看直接子行会让网关来源在
 * 嵌套委派下把「孙代在跑」读成 idle，派发回合提前发横幅。归并是自底向上的一次后序累计
 * （O(rows)），不是每个 running 子行各自上溯（无环安全，也无 O(n·depth) 悬崖）。
 *
 * `subagentCount` 保持直接子行口径（渲染字段的既有语义不变）；`lineageVerified` 只在
 * **有运行中后代**时置真（wire 语义 = 「这条 busy 证据可信」）：count 为 0 时分类器无论
 * verified 与否都判 idle，而旧版渲染器按「verified && 在场数>0 ⇒ busy」读，因此该位只在
 * 「运行数>0」时下发，两端解读一致，且首份基线不会把无子行的行全部标脏。
 * 谱系链断裂（缺父边的子行 / 自指父边）判「不可判」（verified=false），由 fail-closed 位接管；
 * 祖先未镜像或成环只截断归并，不冒充 lineage verdict。
 */

/** Structural row shape the evidence math needs (store-codec.ts owns the real type;
 *  keeping this module import-free of it breaks the codec <-> evidence type cycle). */
export interface EvidenceRow {
  sessionId: string
  present: boolean
  origin: 'subagent' | null
  parentSessionId: string | null
  running: boolean
  subagentCount: number
  subagentRunningCount: number
  lineageVerified: boolean
  subagentKnown: boolean
}

/**
 * Recompute every parent's evidence from the current rows and write it back.
 * @param rows - the store's row table (mutated in place).
 * @param baselinesApplied - successful complete baselines applied in THIS process.
 * @param markDirty - callback for each WIRE-VISIBLE change (never a no-op rewrite).
 */
export function recomputeSubagentEvidence(
  rows: ReadonlyMap<string, EvidenceRow>,
  baselinesApplied: number,
  markDirty: (row: EvidenceRow) => void,
): void {
  const presence = new Map<string, number>()
  const children = new Map<string, string[]>()
  let verified = baselinesApplied > 0
  for (const row of rows.values()) {
    if (!row.present || row.origin !== 'subagent') continue
    if (row.parentSessionId === null || row.parentSessionId === row.sessionId) {
      // A subagent row without a usable parent edge means the lineage is not judgeable.
      verified = false
      continue
    }
    presence.set(row.parentSessionId, (presence.get(row.parentSessionId) ?? 0) + 1)
    const siblings = children.get(row.parentSessionId)
    if (siblings === undefined) children.set(row.parentSessionId, [row.sessionId])
    else siblings.push(row.sessionId)
  }
  // 自底向上一次后序：subtreeRunning(x) = x 自身的运行位 + 各子树的累计。父行的运行数
  // 就是它整棵子树的累计（孙代自然计入），复杂度 O(rows + edges)。
  const subtreeRunning = new Map<string, number>()
  const visiting = new Set<string>()
  for (const root of rows.keys()) {
    if (subtreeRunning.has(root) || visiting.has(root)) continue
    const pending: Array<{ id: string; next: number }> = [{ id: root, next: 0 }]
    visiting.add(root)
    while (pending.length > 0) {
      const top = pending[pending.length - 1]!
      const kids = children.get(top.id) ?? []
      if (top.next < kids.length) {
        const kid = kids[top.next]!
        top.next += 1
        if (subtreeRunning.has(kid)) continue
        // A cycle is corrupt lineage: never loop (a 2-cycle would otherwise re-push
        // forever), truncate the walk and let fail-closed take over.
        if (visiting.has(kid)) { verified = false; continue }
        visiting.add(kid)
        pending.push({ id: kid, next: 0 })
        continue
      }
      pending.pop()
      visiting.delete(top.id)
      let sum = 0
      const self = rows.get(top.id)
      if (self !== undefined && self.running && self.origin === 'subagent') sum += 1
      for (const kid of kids) sum += subtreeRunning.get(kid) ?? 0
      subtreeRunning.set(top.id, sum)
    }
  }
  for (const row of rows.values()) {
    const nextPresence = presence.get(row.sessionId) ?? 0
    const nextRunning = subtreeRunning.get(row.sessionId) ?? 0
    const nextVerified = verified && nextRunning > 0
    const nextKnown = !verified && nextPresence > 0
    if (nextPresence === row.subagentCount && nextRunning === row.subagentRunningCount
        && nextVerified === row.lineageVerified && nextKnown === row.subagentKnown) continue
    row.subagentCount = nextPresence
    row.subagentRunningCount = nextRunning
    row.lineageVerified = nextVerified
    row.subagentKnown = nextKnown
    markDirty(row)
  }
}

/**
 * Wire fields for the derived evidence (design 17 §10.7). `lineageVerified` is already
 * stored gated on `running > 0` (see the module note), so no extra compatibility gate is
 * needed here: old readers only see it where their presence-based reading is correct.
 */
export function evidenceWireFields(row: EvidenceRow): { lineageVerified?: true; subagentKnown?: true } {
  const fields: { lineageVerified?: true; subagentKnown?: true } = {}
  if (row.lineageVerified) fields.lineageVerified = true
  if (row.subagentKnown) fields.subagentKnown = true
  return fields
}
