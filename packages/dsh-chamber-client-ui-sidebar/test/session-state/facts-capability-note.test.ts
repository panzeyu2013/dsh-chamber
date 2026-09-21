/**
 * R19 能力一览（plan W4）侧栏接线锁：来源行必须把「会话事实档位」就地、诚实地
 * 显示出来，且**只在事实存在时**显示。
 *
 * 为什么用源文本锁：档位来自桌面侧事实源的探测/观测结论，侧栏拿到的只是一个可选
 * 字段；这里钉住三件事——(1) 事实字段是加法可选的（缺席 = 未知，绝不臆造 full）；
 * (2) 行上有机器可读锚点（验收仪器/诊断读取）；(3) 文案键两种语言都在，且档位
 * 为 full/缺席时级联以空串收尾（不产生新说明行）。
 *
 * Run directly:
 *   node test/session-state/facts-capability-note.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const SECTION = [
  read('../../src/client/ServerSection.tsx'),
  read('../../src/client/ServerSectionHeader.tsx'),
  read('../../src/client/ServerSectionRows.tsx'),
  read('../../src/client/ServerSectionSearch.tsx'),
  read('../../src/client/server-section-controls.tsx'),
  read('../../src/client/server-section-model.ts'),
  read('../../src/client/server-section-session-state.tsx'),
].join('\n')
const LOCALES = read('../../src/client/locales.ts')
const AGGREGATE = read('../../src/shared/aggregate-store.ts')

test('the aggregate exposes the facts-mode fact as an additive optional field', () => {
  assert.match(AGGREGATE, /export type SourceSessionFactsMode = 'full' \| 'degraded' \| 'legacy' \| 'disabled'/)
  assert.match(AGGREGATE, /sessionFacts\?: SourceSessionFactsMode/)
  // 缺席 = 未知：类型必须可选（否则生产者会被迫猜一个值）。
  assert.doesNotMatch(AGGREGATE, /sessionFacts: SourceSessionFactsMode/)
})

test('the source header carries a machine-readable facts-mode anchor', () => {
  assert.match(SECTION, /data-chamber-facts-mode=\{server\.sessionFacts\}/)
})

test('only the three non-full modes have a note branch, and the cascade still ends empty', () => {
  for (const mode of ['degraded', 'legacy', 'disabled']) {
    assert.match(SECTION, new RegExp("server\\.sessionFacts === '" + mode + "'"), mode)
  }
  // 'full' 与缺席都不得新增说明行：分支链以空串收尾。
  assert.doesNotMatch(SECTION, /server\.sessionFacts === 'full'/)
  assert.match(SECTION, /: server\.sessionFacts === 'disabled'[\s\S]{0,160}?: ''/)
})

test('every facts-mode key exists in both dictionaries', () => {
  for (const key of ['source.factsDegraded', 'source.factsLegacy', 'source.factsDisabled']) {
    const hits = LOCALES.split("'" + key + "'").length - 1
    assert.equal(hits, 2, key + ' must exist once per language')
  }
})
