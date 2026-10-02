/**
 * 来源级普通警示模型（design 06 §3.4）：3s TTL（上游 Toast 默认 hold）与断连裁剪
 * （TTL 内重连不得弹回）；hook 的计时与 shell 接线由源码锁承重。归档成功 / 停止并归档
 * 两态的就地提示条已按用户裁决移除，模型只剩「点击归档行不可打开」这一条警示。
 * 本包测试跑在 plain node 下，模型保持无 React 依赖。
 * Run directly: node test/session-rows/archive-notice.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  retainConnectedNoticeSources, SOURCE_NOTICE_TTL_MS,
} from '../../src/client/sidebar-notices-model.ts'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const HOOK = read('../../src/client/sidebar-root-notices.ts')
const ROOT = read('../../src/client/SidebarRoot.tsx')

test('the plain warning holds for the upstream Toast default 3s', () => {
  assert.equal(SOURCE_NOTICE_TTL_MS, 3_000)
})

test('a disconnected source drops its notice (identity-preserving when nothing drops)', () => {
  const notices = { local: true as const, 'ssh-a': true as const }
  assert.equal(retainConnectedNoticeSources(notices, new Set(['local', 'ssh-a'])), notices,
    'nothing dropped keeps the same reference (no setState churn)')
  const pruned = retainConnectedNoticeSources(notices, new Set(['local']))
  assert.deepEqual(Object.keys(pruned), ['local'])
  assert.deepEqual(retainConnectedNoticeSources({}, new Set()), {})
})

test('the hook consumes the model and the shell feeds it the live sources (source lock)', () => {
  assert.ok(HOOK.includes('SOURCE_NOTICE_TTL_MS'), 'the upstream hold drives the timer')
  assert.ok(HOOK.includes('retainConnectedNoticeSources(prev, connected)'), 'the disconnect prune is wired')
  assert.ok(ROOT.includes('useSidebarNotices(servers)'), 'the shell passes the live sources')
})
