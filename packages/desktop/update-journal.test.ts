/**
 * update-journal.test.ts — opt-in JSONL 更新取证（上游 update-journal.ts 的镜像）：
 * 只写白名单字段、连续重复不写、目录非法 = 关闭、写失败自禁用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UPDATE_JOURNAL_DIR_ENV,
  createUpdateJournal,
  resolveUpdateJournalDir,
  updateJournalState,
} from './update-journal.ts'
import type { UpdateState } from './updater.ts'

function state(patch: Partial<UpdateState>): UpdateState {
  return {
    phase: 'idle',
    currentVersion: '0.3.2-beta.3',
    latestVersion: null,
    channel: 'stable',
    downloadPercent: null,
    releaseUrl: null,
    installBlockedReason: null,
    error: null,
    ...patch,
  }
}

test('目录解析：未设置 = 关闭；非绝对路径 = 关闭 + 说明', () => {
  assert.deepEqual(resolveUpdateJournalDir({}), { dir: null, problem: null })
  assert.deepEqual(resolveUpdateJournalDir({ [UPDATE_JOURNAL_DIR_ENV]: '' }), { dir: null, problem: null })
  const relative = resolveUpdateJournalDir({ [UPDATE_JOURNAL_DIR_ENV]: 'logs/updates' })
  assert.equal(relative.dir, null)
  assert.match(relative.problem ?? '', /absolute/)
  assert.equal(resolveUpdateJournalDir({ [UPDATE_JOURNAL_DIR_ENV]: '/tmp/x' }).dir, '/tmp/x')
})

test('白名单投影：不含 raw 诊断；错误只留固定码或 UNCLASSIFIED', () => {
  const idle = updateJournalState(state({ phase: 'idle', error: 'secret raw text' })) as Record<string, unknown>
  assert.deepEqual(Object.keys(idle).sort(), ['phase'])
  const downloading = updateJournalState(state({ phase: 'downloading', downloadPercent: 41.7 })) as Record<string, unknown>
  assert.equal(downloading.percent, 41)
  const error = updateJournalState(state({ phase: 'error', error: 'net::ERR_CONNECTION_RESET while fetching' })) as Record<string, unknown>
  assert.equal(error.errorCode, 'ERR_CONNECTION_RESET')
  const unclassified = updateJournalState(state({ phase: 'error', error: 'boom' })) as Record<string, unknown>
  assert.equal(unclassified.errorCode, 'UNCLASSIFIED')
  assert.ok(!JSON.stringify(error).includes('fetching'), 'raw 诊断绝不进日志')
})

test('写入：JSONL 逐条、连续重复不写、非幂等字段照写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-update-journal-'))
  try {
    const journal = createUpdateJournal({ dir, version: '0.3.2-beta.3' })
    assert.ok(journal !== null)
    journal.record(state({ phase: 'checking' }))
    journal.record(state({ phase: 'checking' })) // 重复 → 不写
    journal.record(state({ phase: 'available', latestVersion: '0.3.3' }))
    const lines = readFileSync(journal.path, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2, '重复的连续状态不得重复落盘')
    const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    assert.equal(first.phase, 'checking')
    assert.equal(first.version, '0.3.2-beta.3')
    assert.equal((JSON.parse(lines[1] ?? '{}') as Record<string, unknown>).targetVersion, '0.3.3')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目录不可写 → 取证自禁用但不抛（绝不成为更新链故障源）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-update-journal-'))
  try {
    const file = join(dir, 'not-a-dir')
    writeFileSync(file, 'x')
    const journal = createUpdateJournal({ dir: file, version: '0.3.2-beta.3' })
    assert.equal(journal, null, '目录创建失败 = 取证关闭')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
