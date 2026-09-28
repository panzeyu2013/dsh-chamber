/**
 * The official "Created {time}" hover line: createdLabel composes date.ymd + a 24-hour
 * HH:MM inside hover.created (copied verbatim from upstream ui-workspace Rows.tsx).
 * Clock-free: the fake t mirrors the dictionary for the two keys involved.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createdLabel } from '../../src/client/server-section-model.ts'
import { en, zh } from '../../src/client/locales.ts'

const translate = (table: Record<string, string>) =>
  (key: string, params?: Record<string, string | number>): string => {
    let out = table[key] ?? key
    for (const [name, value] of Object.entries(params ?? {})) out = out.replace('{' + name + '}', String(value))
    return out
  }

test('createdLabel composes the localized absolute time the official card renders', () => {
  // Local-time constructor on purpose: createdLabel reads the LOCAL fields, and the
  // expected string is built from the same Date instance, so no timezone assumption.
  const at = new Date(2026, 0, 2, 9, 5)
  const tables = { zh, en } as Record<'zh' | 'en', Record<string, string>>
  // 词典取实际发货的 zh/en（不是本文件复刻的副本）：locale 值漂移必须在这里红。
  assert.equal(createdLabel(at.getTime(), translate(tables.zh) as never), '创建于 2026年1月2日 09:05')
  assert.equal(createdLabel(at.getTime(), translate(tables.en) as never), 'Created 2026-1-2 09:05')
})

test('the card only mounts on a real creation fact (sparse wire contract)', () => {
  // 上游同门（WS `if (row.createdAt === void 0) return ownRow;`）：没有创建事实就不挂卡，
  // 因为 createdLabel 对任意 number 逐字格式化 ⇒ NaN 会渲染成「NaN年NaN月NaN日」。
  const model = readFileSync(new URL('../../src/client/ServerSection.tsx', import.meta.url), 'utf8')
  assert.match(model, /workspace\.createdAt === undefined/u,
    'the workspace card mounts only when the projection carries a creation time')
})