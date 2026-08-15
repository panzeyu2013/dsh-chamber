/**
 * Generate THIRD_PARTY_NOTICES.md from the installed node_modules trees
 * (root + per-workspace). Run after any dependency change:
 *   npm run gen:notices
 * Output is name-ordered; workspace packages (@dsh-chamber/*) are excluded.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
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
    if (entry.name.startsWith('@')) {
      const scoped = join(dir, entry.name)
      for (const sub of readdirSync(scoped, { withFileTypes: true })) {
        if (sub.isDirectory()) record(join(scoped, sub.name, 'package.json'))
      }
      continue
    }
    if (entry.isDirectory()) record(join(dir, entry.name, 'package.json'))
  }
}

scan(join(ROOT, 'node_modules'))
scan(join(ROOT, 'packages/renderer/node_modules'))
scan(join(ROOT, 'packages/desktop/node_modules'))

const rows = [...found.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, { version, license }]) => `| \`${name}\` | ${version} | ${license} |`)

const body = `# Third-Party Notices

dsh-chamber redistributes the following third-party packages. The full license
text of each package lives in its own \`LICENSE\` file under \`node_modules\`.
Generated with \`npm run gen:notices\`.

| Package | Version | License |
|---|---|---|
${rows.join('\n')}
`

writeFileSync(OUT, body)
console.log(`wrote ${OUT} (${found.size} packages)`)
