#!/usr/bin/env node
//  探针的编译面门禁（CI darwin 腿用，**不需要 GUI 会话**）：
//  把 overscroll-probe 的 main.swift 与仓库策略源一起 -typecheck。它挡的是"探针随策略源
//  API 漂移而烂掉、却要等人工跑探针才发现"这一缺口——例如改掉 makeUserScript() /
//  styleElementAttribute / source 名字，或删掉策略文件。
//
//  接线上：scripts/gates/run-checks.mjs 的 MACOS_CHECKS 直接以 `node <本文件>` 形式登记。
//  效果断言仍在手动 run.mjs --assert（需要 GUI 会话）。
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const work = mkdtempSync(join(tmpdir(), 'dsh-overscroll-typecheck-'))

try {
  execFileSync(
    'xcrun',
    ['swiftc', '-typecheck', '-module-cache-path', join(work, 'modulecache'),
      join(here, 'main.swift'),
      join(root, 'macos/Sources/DSHChamberPoc/ShellOverscrollPolicy.swift'),
      '-framework', 'AppKit', '-framework', 'WebKit'],
    { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, TMPDIR: work } },
  )
} catch {
  console.error('[overscroll-probe] typecheck FAILED：探针与策略源的编译面已漂移（见上方 swiftc 输出）')
  process.exit(1)
}
console.log('[overscroll-probe] typecheck OK（探针 + 策略源编译面一致，无需 GUI 会话）')
