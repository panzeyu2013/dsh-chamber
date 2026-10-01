/**
 * 会话投影事实（标签 + 稀疏日程标记）跨代际保留的接线锁：规则只有一个定义处（纯聚合模块），两处提交点
 * （推送提交 / unary 提交）都必须经过它——任一处漏掉，代际清空窗口或 unary 弱标签
 * 就会再次把权威名字覆盖成 cwd basename（2026-10-01 实机：Harness 源会话行
 * 「阅读工作区文档并制定执行计划」在 socket 关闭后的 0.7s 内显示为「photo」）。
 *
 * These are source-text locks, not behavior tests: the rule's behavior lives in
 * test/aggregate/aggregate-refresh.test.ts. They exist so that dropping the
 * retention from either commit path (or growing a second rule at the spot)
 * fails loudly instead of silently regressing the flash.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const policy = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/aggregate-refresh.ts', import.meta.url)), 'utf8'))
const pushCommit = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/app-hooks/use-bridge-subscriptions.ts', import.meta.url)), 'utf8'))
const unaryCommit = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/app-hooks/use-aggregate-refresh.ts', import.meta.url)), 'utf8'))

test('retainSessionLabels has exactly ONE definition (the pure aggregate module)', () => {
  assert.match(policy, /export function retainSessionLabels\(/u, 'the rule lives in aggregate-refresh.ts')
  assert.doesNotMatch(pushCommit, /function retainSessionLabels\(/u, 'the push commit must not grow a second rule')
  assert.doesNotMatch(unaryCommit, /function retainSessionLabels\(/u, 'the unary commit must not grow a second rule')
})

test('both session-row commit sites route through retainSessionLabels', () => {
  // The push commit retains BEFORE computing its signature, so a clear-window
  // push whose only degradation is the missing label dedupes to no commit.
  // Whitespace-tolerant: argument renames/line breaks must not produce a false alarm.
  assert.match(pushCommit, /retainSessionLabels\(\s*current\.sessions,\s*snapshot\.sessions\s*\)/u,
    'the push commit retains known labels before its signature dedupe')
  // The unary commit covers the fallback's weaker label for pushed sources AND
  // the reclaimed/unmounted sources that no producer will ever re-push.
  assert.match(unaryCommit, /retainSessionLabels\(\s*current\.sessions,\s*committed\.sessions\s*\)/u,
    'the unary commit retains known labels (pushed and reclaimed sources alike)')
})

test('the retained value is what both commits compare and STORE (data-flow floor)', () => {
  // 2026-10 review M1: computing `retained` but comparing/storing the raw push
  // would regress the 0.6-0.8s directory-name flash while every helper test
  // stays green. Pin the data flow itself, not just the call.
  assert.match(pushCommit, /instanceSnapshotSignature\(\s*retained\s*\)/u,
    'the push compares the RETAINED bytes, never the raw push')
  assert.doesNotMatch(pushCommit, /instanceSnapshotSignature\(\s*snapshot\s*\)/u,
    'the raw push must not be the comparison input')
  assert.match(pushCommit, /\.\.\.retained,\s*error: null/u,
    'the push commits the retained rows')
  assert.match(unaryCommit, /instanceSnapshotSignature\(\s*next\s*\)/u,
    'the unary commit compares the retained aggregate')
  assert.doesNotMatch(unaryCommit, /instanceSnapshotSignature\(\s*committed\s*\)/u,
    'the unretained merge result must not be the comparison input')
  assert.match(unaryCommit, /\[instanceId\]: next/u,
    'the unary commit stores the retained aggregate')
})
