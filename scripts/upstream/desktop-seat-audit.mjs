/**
 * desktop-seat-audit.mjs — §4.5「桌面 seat 覆盖审计」表的纯逻辑面：
 * 解析 checklist 表行 + 与 registry 的 apps/desktop/src mirror 条目做双向覆盖检查。
 *
 * 为什么单独成模块：registry.mjs 的边界是「数据形状与 canonical 序列化」，不解析文档；
 * verify-registry.mjs 是门本体。这里只放可单测的纯函数（不读文件系统；路径存在性由
 * 调用方注入 resolvePath，测试可注入临时根）。
 */

/** §4.5 小节标题（表必须活在该小节内，避免扫到后续 §4.6/§9 的表）。 */
export const DESKTOP_SEAT_AUDIT_HEADING = '## 4.5 桌面 seat 覆盖审计'

/** 表内允许的分类（与 registry 的 entry 分类同域，只是这张表按上游文件逐行记）。 */
export const DESKTOP_SEAT_CLASSES = Object.freeze(['mirror', 'different-adopted', 'not-applicable'])

const ROW_PATTERN = /^\|\s*`([^`]+)`\s*\|\s*([a-z-]+)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*$/u
const SECTION_END = /^## /mu
const PATH_TOKEN = /(?:packages|macos|scripts|docs)\/[A-Za-z0-9._@/-]+/gu
const REGISTRY_COVERED = /覆盖文件：apps\/desktop\/src\/\{([^}]+)\}/u

/**
 * 解析 §4.5 小节里的审计行（`| 上游文件 | 分类 | chamber 对照点 | 理由 |`）。
 * @param {string} checklistText - docs/checklists/upstream-touchpoints.md 全文。
 * @returns {{ rows: {file: string, classification: string, chamber: string, reason: string}[], problems: string[] }}
 */
export function parseDesktopSeatAudit(checklistText) {
  const start = checklistText.indexOf(DESKTOP_SEAT_AUDIT_HEADING)
  if (start < 0) return { rows: [], problems: ['缺少 ' + DESKTOP_SEAT_AUDIT_HEADING + ' 小节'] }
  const rest = checklistText.slice(start + DESKTOP_SEAT_AUDIT_HEADING.length)
  const end = SECTION_END.exec(rest)
  const section = end === null ? rest : rest.slice(0, end.index)
  const rows = []
  for (const raw of section.split('\n')) {
    const match = ROW_PATTERN.exec(raw.trim())
    if (match === null) continue
    rows.push({
      file: match[1].trim(),
      classification: match[2].trim(),
      chamber: match[3].trim(),
      reason: match[4].trim(),
    })
  }
  return { rows, problems: [] }
}

/** chamber 对照点里的仓内路径 token（去尾标点；占位符/glob 不参与存在性检查）。 */
function pathTokens(cell) {
  const tokens = []
  for (const match of cell.matchAll(PATH_TOKEN)) {
    const token = match[0].replace(/[.,;:]+$/u, '')
    if (token.includes('*') || token.includes('{') || token.includes('<')) continue
    tokens.push(token)
  }
  return [...new Set(tokens)]
}

/**
 * §4.5 审计表的覆盖网（verify-registry ⑤E 的纯函数面）：
 * 表内一致性 + chamber 对照路径存在性 + 表 mirror 行与 registry apps/desktop/src mirror 条目双向覆盖。
 * @param {string} checklistText - checklist 全文。
 * @param {object} registry - registry.json 对象。
 * @param {{ exists?: (path: string) => boolean, resolvePath?: (token: string) => string }} [options]
 * @returns {string[]} findings（空数组 = 通过）。
 */
export function desktopSeatAuditFindings(checklistText, registry, { exists = () => true, resolvePath = (token) => token } = {}) {
  const findings = []
  const { rows, problems } = parseDesktopSeatAudit(checklistText)
  for (const problem of problems) findings.push(problem)
  if (rows.length === 0) findings.push('§4.5 表格没有任何审计行')
  const seen = new Set()
  for (const row of rows) {
    if (row.file === '') findings.push('§4.5 存在空上游文件名行')
    if (!DESKTOP_SEAT_CLASSES.includes(row.classification)) findings.push('§4.5 ' + row.file + ': 未知分类 ' + row.classification)
    if (row.reason === '') findings.push('§4.5 ' + row.file + ': 缺一句理由')
    if (seen.has(row.file)) findings.push('§4.5 上游文件重复: ' + row.file)
    seen.add(row.file)
    const tokens = pathTokens(row.chamber)
    for (const token of tokens) {
      if (!exists(resolvePath(token))) findings.push('§4.5 ' + row.file + ': chamber 对照点指向不存在的路径 ' + token)
    }
    if (row.classification === 'mirror' && tokens.length === 0) findings.push('§4.5 ' + row.file + ': mirror 行没有可核对的 chamber 路径')
  }
  const seatEntries = (registry.entries ?? []).filter((entry) => entry.type === 'mirror' && entry.upstream === 'apps/desktop/src')
  if (seatEntries.length === 0) findings.push('§4.5: registry 没有 apps/desktop/src 的 mirror 条目')
  const covered = new Map()
  for (const entry of seatEntries) {
    if (!checklistText.includes(entry.id)) findings.push('§4.5: registry 条目 ' + entry.id + ' 未在审计表小节中列出')
    const match = REGISTRY_COVERED.exec(entry.evidence ?? '')
    if (match === null) {
      findings.push('§4.5: ' + entry.id + ' 的 evidence 缺少「覆盖文件：apps/desktop/src/{...}」清单')
      continue
    }
    for (const name of match[1].split(',')) covered.set(name.trim() + '.ts', entry.id)
  }
  const tableMirror = new Set(rows.filter((row) => row.classification === 'mirror').map((row) => row.file))
  for (const file of tableMirror) {
    if (!covered.has(file)) findings.push('§4.5: 表 mirror 行 ' + file + ' 未被任何 registry 条目覆盖')
  }
  for (const [file, id] of covered) {
    if (!tableMirror.has(file)) findings.push('§4.5: registry ' + id + ' 覆盖 ' + file + '，但表里不是 mirror 行')
  }
  return findings
}
