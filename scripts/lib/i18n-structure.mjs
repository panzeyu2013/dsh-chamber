/**
 * 双语文档的「结构对等签名」：语言无关的骨架面（标题层级序列、围栏代码块数、
 * 表格数、HTML 注释数）。升级计划 §22.3.7 的结构签名项——字节哈希只能证明
 * 「记录与实际一致」，证明不了镜像有没有整段缺失；骨架能。
 *
 * 只比语言无关的面：标题**文本**、正文措辞、表格内容都允许两种语言各自不同。
 */

/**
 * 提取一个 markdown 文档的结构骨架。
 * @param {string} markdown - 文档全文。
 * @returns {{ headings: number[], fences: number, tables: number, comments: number }}
 */
export function structuralSignature(markdown) {
  const headings = []
  let fences = 0
  let tables = 0
  let comments = 0
  // 逐行扫描并跟踪围栏：代码块里的 `# 注释` 行不是标题，块里的表格/注释样行也不算。
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^```/u.test(line)) {
      fences += 1
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const heading = /^(#{1,6})[ \t]/u.exec(line)
    if (heading !== null) headings.push(heading[1].length)
    if (/^\|[-: |]+\|[ \t]*$/u.test(line)) tables += 1
    comments += (line.match(/<!--/gu) ?? []).length
  }
  return { headings, fences, tables, comments }
}

/**
 * 稳定字符串形式（日志与断言用）。
 * @param {ReturnType<typeof structuralSignature>} signature - 骨架。
 * @returns {string} 单行签名。
 */
export function signatureText(signature) {
  return 'headings=[' + signature.headings.join(',') + '] fences=' + signature.fences
    + ' tables=' + signature.tables + ' comments=' + signature.comments
}

/**
 * 比较一对文档的结构对等性。
 * @param {string} zhMarkdown - 中文侧全文。
 * @param {string} enMarkdown - en-US 侧全文。
 * @returns {{ ok: boolean, problems: string[], zh: object, en: object }}
 */
export function compareStructures(zhMarkdown, enMarkdown) {
  const zh = structuralSignature(zhMarkdown)
  const en = structuralSignature(enMarkdown)
  const problems = []
  if (zh.headings.join(',') !== en.headings.join(',')) {
    problems.push('标题层级序列不同（zh ' + signatureText(zh) + ' vs en ' + signatureText(en) + '）')
  }
  if (zh.fences !== en.fences) problems.push('围栏代码块数不同（zh ' + zh.fences + ' vs en ' + en.fences + '）')
  if (zh.tables !== en.tables) problems.push('表格数不同（zh ' + zh.tables + ' vs en ' + en.tables + '）')
  if (zh.comments !== en.comments) problems.push('HTML 注释数不同（zh ' + zh.comments + ' vs en ' + en.comments + '）')
  return { ok: problems.length === 0, problems, zh, en }
}
