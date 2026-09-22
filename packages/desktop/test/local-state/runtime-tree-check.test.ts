/**
 * runtime-tree-check 单测：安装树的上游
 * client-plugin 闭包抽样必须 fail-closed，且纯函数可在任何平台的 sidecar
 * node 上直接跑（临时目录 fixture，不碰 Electron/真实安装树）。
 *
 * Run directly: node packages/desktop/test/local-state/runtime-tree-check.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  RUNTIME_CLIENT_CLOSURE_SAMPLE,
  RUNTIME_CLOSURE_REQUIRED,
  RUNTIME_DSH_BIN_ENTRY,
  verifyRuntimeClientClosure,
} from '../../runtime-tree-check.ts'

/** 造一棵完整的运行树：dsh 入口 + 三个抽样包的 manifest。 */
function treeFixture(): string {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), 'dsh-chamber-runtime-closure-'))
  for (const entry of RUNTIME_CLOSURE_REQUIRED) {
    const target = path.join(workspaceDir, entry)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, entry.endsWith('.js') ? '#!/usr/bin/env node\n' : '{}\n')
  }
  return workspaceDir
}

test('完整运行树通过抽样，missing 为空', () => {
  const workspaceDir = treeFixture()
  try {
    assert.deepEqual(verifyRuntimeClientClosure(workspaceDir), { ok: true, missing: [] })
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true })
  }
})

test('缺 sidebarRight 唯一 provider 时 fail-closed 并点名该包', () => {
  const workspaceDir = treeFixture()
  try {
    const provider = RUNTIME_CLIENT_CLOSURE_SAMPLE[0]!
    rmSync(path.join(workspaceDir, provider))
    const verdict = verifyRuntimeClientClosure(workspaceDir)
    assert.equal(verdict.ok, false)
    assert.deepEqual(verdict.missing, [provider])
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true })
  }
})

test('缺 dsh 入口 bin.js 时 fail-closed（宿主根本起不来）', () => {
  const workspaceDir = treeFixture()
  try {
    rmSync(path.join(workspaceDir, RUNTIME_DSH_BIN_ENTRY))
    assert.deepEqual(verifyRuntimeClientClosure(workspaceDir), {
      ok: false,
      missing: [RUNTIME_DSH_BIN_ENTRY],
    })
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true })
  }
})

test('运行树整个不存在 / 路径未解析：全量 missing，绝不静默判过', () => {
  const absent = path.join(tmpdir(), 'dsh-chamber-runtime-closure-absent-' + process.pid)
  assert.deepEqual(verifyRuntimeClientClosure(absent), {
    ok: false,
    missing: [...RUNTIME_CLOSURE_REQUIRED],
  })
  for (const empty of [null, undefined, '']) {
    assert.deepEqual(verifyRuntimeClientClosure(empty), {
      ok: false,
      missing: [...RUNTIME_CLOSURE_REQUIRED],
    })
  }
})

test('exists 接缝决定判定，调用方永不吞掉缺失', () => {
  const present = new Set(RUNTIME_CLOSURE_REQUIRED.map((entry) => path.join('/tree', entry)))
  assert.deepEqual(
    verifyRuntimeClientClosure('/tree', { exists: (file) => present.has(file) }),
    { ok: true, missing: [] },
  )
  assert.deepEqual(
    verifyRuntimeClientClosure('/tree', { exists: () => false }),
    { ok: false, missing: [...RUNTIME_CLOSURE_REQUIRED] },
  )
})

test('抽样表固定：入口 + 三个上游 client-plugin 包，顺序稳定', () => {
  assert.equal(RUNTIME_CLOSURE_REQUIRED[0], RUNTIME_DSH_BIN_ENTRY)
  assert.deepEqual([...RUNTIME_CLIENT_CLOSURE_SAMPLE], [
    'node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/package.json',
    'node_modules/@deepseek-ai/dsh-client-resources/package.json',
    'node_modules/@deepseek-ai/dsh-client-ui-chat/package.json',
  ])
})
