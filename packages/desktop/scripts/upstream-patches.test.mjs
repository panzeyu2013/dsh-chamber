/**
 * Upstream patch-channel lockstep (upgrade plan §17-C / §22.0-2).
 *
 * The runtime bundle must install the PINNED upstream patch set: without it the
 * packaged runtime ships unpatched node-pty / pi-ai while the upstream checkout
 * looks fine. These tests pin the three facts the bundler relies on — the vendor
 * workspace owns a parseable patchedDependencies block, every referenced patch
 * file exists, and the COMMITTED runtime lockfile records exactly that set (so a
 * pin upgrade that changes the patch set fails here until
 * `bundle:dsh --force --refresh-lockfile` regenerates it).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VENDOR_PATCHES,
  VENDOR_WORKSPACE,
  parsePatchedDependencies,
  renderRuntimeWorkspace,
  stageUpstreamPatches,
  upstreamPatchFiles,
  upstreamPatchedDependencies,
} from './upstream-patches.mjs'
import { RUNTIME_LOCKFILE } from './upstream-patches.mjs'

const block = upstreamPatchedDependencies()
const entries = parsePatchedDependencies(block)

test('上游 patch 集合可解析：specifier → patches/*.patch', () => {
  assert.ok(entries.length >= 7, 'behind the pin at least the seven recorded patches')
  for (const entry of entries) assert.match(entry.file, /^patches\/[^/]+\.patch$/u)
  assert.equal(new Set(entries.map(e => e.spec)).size, entries.length, 'no duplicate specifier')
})

test('每个条目都有对应的 patch 文件，且目录内没有未登记文件', () => {
  const files = upstreamPatchFiles()
  const registered = entries.map(e => e.file.slice('patches/'.length)).sort()
  assert.deepEqual(files, registered, VENDOR_PATCHES + ' 与 vendor-workspace 的登记集合必须一致')
})

test('渲染出的运行期 workspace 携带 patch 块与 unused-patch 豁免', () => {
  const text = renderRuntimeWorkspace('  "node-pty": true', block)
  assert.ok(text.startsWith('minimumReleaseAge: 0\nallowBuilds:\n'))
  assert.ok(text.includes(block), 'patch 块逐字保留')
  assert.ok(text.trimEnd().endsWith('allowUnusedPatches: true'))
  assert.equal(parsePatchedDependencies(text).length, entries.length)
})

test('staging 把 pin 的文件按字节拷进 work 目录', () => {
  const work = mkdtempSync(join(tmpdir(), 'dsh-patches-'))
  try {
    const staged = stageUpstreamPatches(work)
    assert.equal(staged.files, entries.length)
    assert.equal(staged.entries, entries.length)
    const nodePty = 'node-pty@1.2.0-beta.15.patch'
    assert.deepEqual(
      readFileSync(join(work, 'patches', nodePty)),
      readFileSync(join(VENDOR_PATCHES, nodePty)),
      '字节一致（patch 内容即上游 pin 的内容）',
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('提交的运行期锁文件记录同一 patch 集合（pin 升级必须重生成）', () => {
  const lock = readFileSync(RUNTIME_LOCKFILE, 'utf8')
  const lockBlock = /^patchedDependencies:\n(?: {2}.*\n)+/mu.exec(lock)?.[0]
  assert.ok(lockBlock !== undefined, 'runtime lockfile 必须有 patchedDependencies')
  // The lockfile records specifier → patch hash (the patch path lives in the
  // workspace file), so this block is parsed with its own shape.
  const lockEntries = [...lockBlock.matchAll(/^ {2}'?([^':\n]+)'?: ([0-9a-f]{64})$/gmu)]
    .map(match => ({ spec: match[1], hash: match[2] }))
  assert.deepEqual(lockEntries.map(e => e.spec).sort(), entries.map(e => e.spec).sort())
  assert.equal(new Set(lockEntries.map(e => e.hash)).size, lockEntries.length, '每个 specifier 一个独立 patch hash')
})

test('缺少 patchedDependencies 块的上游 workspace 必须红', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-patch-ws-'))
  try {
    const plain = join(dir, 'pnpm-workspace.yaml')
    writeFileSync(plain, 'packages:\n  - packages/*\n')
    assert.throws(() => upstreamPatchedDependencies(plain), /patchedDependencies/u)
    assert.throws(() => upstreamPatchedDependencies(join(dir, 'missing.yaml')), /读不到/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})