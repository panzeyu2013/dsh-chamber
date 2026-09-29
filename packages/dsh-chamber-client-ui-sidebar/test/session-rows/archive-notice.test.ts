/**
 * 归档提示条模型（design 06 §3.4，D5）：per-kind TTL（归档两类 6s / 普通警示 3s，上游
 * RowActionToast/Toast 同步调）与断连裁剪（TTL 内重连不得弹回）；hook 的计时与 shell
 * 接线由源码锁承重。本包测试跑在 plain node 下，模型保持无 React 依赖。
 * Run directly: node test/session-rows/archive-notice.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  retainConnectedNoticeSources, sourceNoticeTtl, SOURCE_NOTICE_PLAIN_TTL_MS, SOURCE_NOTICE_TTL_MS,
} from '../../src/client/sidebar-notices-model.ts'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const HOOK = read('../../src/client/sidebar-root-notices.ts')
const ROOT = read('../../src/client/SidebarRoot.tsx')

test('per-kind TTL mirrors upstream: archive kinds 6s, the plain warning 3s', () => {
  assert.equal(SOURCE_NOTICE_TTL_MS, 6_000)
  assert.equal(SOURCE_NOTICE_PLAIN_TTL_MS, 3_000)
  assert.equal(sourceNoticeTtl('archived'), SOURCE_NOTICE_TTL_MS)
  assert.equal(sourceNoticeTtl('stoppedAndArchived'), SOURCE_NOTICE_TTL_MS)
  assert.equal(sourceNoticeTtl('archivedNotOpenable'), SOURCE_NOTICE_PLAIN_TTL_MS)
})

test('a disconnected source drops its notice (identity-preserving when nothing drops)', () => {
  const notices = {
    local: { kind: 'archived' as const, sessionId: 's1' },
    'ssh-a': { kind: 'archivedNotOpenable' as const, sessionId: 's2' },
  }
  assert.equal(retainConnectedNoticeSources(notices, new Set(['local', 'ssh-a'])), notices,
    'nothing dropped keeps the same reference (no setState churn)')
  const pruned = retainConnectedNoticeSources(notices, new Set(['local']))
  assert.deepEqual(Object.keys(pruned), ['local'])
  assert.deepEqual(retainConnectedNoticeSources({}, new Set()), {})
})

test('the hook consumes the model and the shell feeds it the live sources (source lock)', () => {
  assert.ok(HOOK.includes('sourceNoticeTtl(kind)'), 'the per-kind TTL drives the timer')
  assert.ok(HOOK.includes('retainConnectedNoticeSources(prev, connected)'), 'the disconnect prune is wired')
  assert.ok(ROOT.includes('useSidebarNotices(servers)'), 'the shell passes the live sources')
})
