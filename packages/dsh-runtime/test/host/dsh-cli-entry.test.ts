/**
 * dsh-cli-entry.ts 单测：dsh CLI 入口两形状 + isDshWorkspace 派生。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isDshWorkspace, resolveDshCliEntry } from '../../src/dsh-cli-entry.ts'

function touch(file: string): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '')
  return file
}

test('resolveDshCliEntry: installed artifact first, source checkout second, absent → null', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-cli-entry-'))
  try {
    assert.equal(resolveDshCliEntry(workspace), null)
    assert.equal(isDshWorkspace(workspace), false)
    const source = touch(join(workspace, 'apps', 'cli', 'src', 'bin.ts'))
    assert.deepEqual(resolveDshCliEntry(workspace), { entry: source, viaTsx: true, layout: 'source' })
    assert.equal(isDshWorkspace(workspace), true)
    const installed = touch(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    assert.deepEqual(
      resolveDshCliEntry(workspace),
      { entry: installed, viaTsx: false, layout: 'installed' },
      'the installed artifact outranks the dev source entry',
    )
    assert.equal(isDshWorkspace(workspace), true)
    rmSync(join(workspace, 'node_modules'), { recursive: true, force: true })
    assert.deepEqual(resolveDshCliEntry(workspace), { entry: source, viaTsx: true, layout: 'source' })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})
