/**
 * Generate THIRD_PARTY_NOTICES.md from the directly declared packages in the
 * installed node_modules trees (root + per-workspace). Run after any
 * dependency change:
 *   npm run gen:notices
 * Output is name-ordered; workspace packages (@dsh-chamber/*) are excluded.
 * Reading manifests instead of every top-level directory keeps the result
 * stable when a local pnpm install uses a hoisted layout or retains stale
 * transitive entries.
 */

import { readFileSync, writeFileSync } from 'node:fs'
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

function scanDeclared(packageDir, nodeModulesDir) {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  } catch { return }
  const names = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ])
  for (const name of names) record(join(nodeModulesDir, name, 'package.json'))
}

scanDeclared(ROOT, join(ROOT, 'node_modules'))
scanDeclared(join(ROOT, 'packages/renderer'), join(ROOT, 'packages/renderer/node_modules'))
scanDeclared(join(ROOT, 'packages/desktop'), join(ROOT, 'packages/desktop/node_modules'))

const rows = [...found.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, { version, license }]) => `| \`${name}\` | ${version} | ${license} |`)

// macOS 原生壳的第三方依赖与打包资产（SwiftPM 不在 npm 树里；2026-12 裁决「D-1 选 B」批准）。
// 版本与 macos/Package.swift 的钉值同步——改钉值时这里同改（许可证取自包自身 LICENSE）。
const nativeRows = [
  '| `Sparkle` | 2.10.0 | MIT |',
]

const bodyZh = `# 第三方声明（Third-Party Notices）

dsh-chamber 重新分发以下第三方包。每个包的完整许可证文本位于其自身的
\`node_modules\` 下的 \`LICENSE\` 文件中。经 \`npm run gen:notices\` 生成。

| 包 | 版本 | 许可证 |
|---|---|---|
${rows.join('\n')}

## macOS 原生壳（SwiftPM / 打包资产）

| 包 | 版本 | 许可证 |
|---|---|---|
${nativeRows.join('\n')}

原生 DMG 的 Finder 背景资产 \`macos/resources/dmg-background.tiff\` 取自
\`electron-builder\` 的 \`dmg-builder/templates/background.tiff\`（MIT，
electron-userland/electron-builder；双 rep 540×380@72dpi + 1080×760@144dpi），
目的是让原生 DMG 与 Electron 腿的拖拽引导完全同款（2026-09）。
`

const bodyEn = `# Third-Party Notices

dsh-chamber redistributes the following third-party packages. The full license
text of each package lives in its own \`LICENSE\` file under \`node_modules\`.
Generated with \`npm run gen:notices\`.

| Package | Version | License |
|---|---|---|
${rows.join('\n')}

## macOS native shell (SwiftPM / packaging assets)

| Package | Version | License |
|---|---|---|
${nativeRows.join('\n')}

The native DMG's Finder background asset \`macos/resources/dmg-background.tiff\` is
taken from \`electron-builder\`'s \`dmg-builder/templates/background.tiff\` (MIT,
electron-userland/electron-builder; dual representation 540×380@72dpi +
1080×760@144dpi) so the native DMG ships the same drag-to-install cue as the
Electron leg (2026-09).
`

const EN_OUT = join(ROOT, 'docs/THIRD_PARTY_NOTICES.en-US.md')
writeFileSync(OUT, bodyZh)
writeFileSync(EN_OUT, bodyEn)
console.log(`wrote ${OUT} + ${EN_OUT} (${found.size} packages)`)
