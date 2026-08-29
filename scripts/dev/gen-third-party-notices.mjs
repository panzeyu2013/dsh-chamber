/**
 * Generate THIRD_PARTY_NOTICES.md from the installed node_modules trees
 * (root + per-workspace). Run after any dependency change:
 *   npm run gen:notices
 * Output is name-ordered; workspace packages (@dsh-chamber/*) are excluded.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const OUT = join(ROOT, 'THIRD_PARTY_NOTICES.md')
const found = new Map()

function licenseOf(pkg) {
  const value = pkg.license
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.type === 'string') return value.type
  return 'SEE LICENSE IN PACKAGE'
}

function record(pkgPath) {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch { return }
  if (typeof pkg.name !== 'string' || pkg.name.startsWith('@dsh-chamber/')) return
  found.set(pkg.name, { version: pkg.version ?? 'unknown', license: licenseOf(pkg) })
}

function scan(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    // pnpm links installed packages into node_modules as symlinks — follow
    // them, otherwise every package is skipped and the table comes out empty.
    const isDir = entry.isDirectory() || entry.isSymbolicLink()
    if (entry.name.startsWith('@')) {
      const scoped = join(dir, entry.name)
      if (!isDir) continue
      for (const sub of readdirSync(scoped, { withFileTypes: true })) {
        if (sub.isDirectory() || sub.isSymbolicLink()) record(join(scoped, sub.name, 'package.json'))
      }
      continue
    }
    if (isDir) record(join(dir, entry.name, 'package.json'))
  }
}

scan(join(ROOT, 'node_modules'))
scan(join(ROOT, 'packages/renderer/node_modules'))
scan(join(ROOT, 'packages/desktop/node_modules'))

const rows = [...found.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, { version, license }]) => `| \`${name}\` | ${version} | ${license} |`)

const bodyZh = `# 第三方声明（Third-Party Notices）

dsh-chamber 重新分发以下第三方包。每个包的完整许可证文本位于其自身的
\`node_modules\` 下的 \`LICENSE\` 文件中。经 \`npm run gen:notices\` 生成。

| 包 | 版本 | 许可证 |
|---|---|---|
${rows.join('\n')}
`

const bodyEn = `# Third-Party Notices

dsh-chamber redistributes the following third-party packages. The full license
text of each package lives in its own \`LICENSE\` file under \`node_modules\`.
Generated with \`npm run gen:notices\`.

| Package | Version | License |
|---|---|---|
${rows.join('\n')}
`

const EN_OUT = join(ROOT, 'docs/THIRD_PARTY_NOTICES.en-US.md')
writeFileSync(OUT, bodyZh)
writeFileSync(EN_OUT, bodyEn)
console.log(`wrote ${OUT} + ${EN_OUT} (${found.size} packages)`)
