/**
 * E1 回归：simple-icons 必须解析到 ESM 入口。
 *
 * 回归形态：一旦解析回落到包默认的 CJS `index.js`，Rollup 的 tree-shaking 失效，
 * chamber entry 会把 5.2 MB 全量图标表（~3.4k 个）全部带进首屏——vendor 的
 * `SiteGlyph.tsx` 实际只 import 34 个。体积门（check-chunk-budgets 的 chamber
 * entry warn）只提示不断言，所以行为锁放在这里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { resolveSimpleIconsEsmEntry } from './simple-icons-entry.mjs'

test('simple-icons 解析到 ESM 入口（index.mjs），不是 CJS index.js', () => {
  // 纯 Node 上下文解析不到 renderer 的 bare import：走 vendor 消费方安装树回退。
  const entry = resolveSimpleIconsEsmEntry()
  assert.equal(basename(entry), 'index.mjs')
  assert.ok(existsSync(entry), `entry 不存在: ${entry}`)
  const source = readFileSync(entry, 'utf8')
  // ESM 入口的证据：真正的 export 语句、无 CJS 导出赋值、且仍是全量表
  // （包本身是 5.2 MB；能否只留 34 个图标由 Rollup 决定）。
  assert.match(source, /export const siDotenv/u)
  assert.match(source, /siGithub/u)
  assert.doesNotMatch(source, /module\.exports/u)
  assert.ok(statSync(entry).size > 1_000_000, 'ESM 入口应包含包的全量图标表')
})

test('vite 配置在通用 require 解析之前把 bare simple-icons 路由到 ESM 入口', () => {
  const config = readFileSync(new URL('../vite.config.mjs', import.meta.url), 'utf8')
  const routeAt = config.indexOf("if (specifier === 'simple-icons') return resolveSimpleIconsEsmEntry(requireFromRenderer)")
  const genericAt = config.indexOf('return requireFromRenderer.resolve(specifier)')
  assert.ok(routeAt >= 0, 'vite 配置必须保留 simple-icons 的 ESM 路由接线')
  assert.ok(genericAt > routeAt, 'ESM 路由必须先于通用 require 解析（否则 CJS index.js 重新命中）')
  assert.match(config, /import \{ resolveSimpleIconsEsmEntry \} from '\.\/scripts\/simple-icons-entry\.mjs'/u)
})
