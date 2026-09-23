/**
 * anchor-version.ts 单测：锚点 dsh 版本的三候选优先级与 accept 门（design 18
 * §9.3）。纯逻辑，临时目录，无 electron/网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readAnchorVersion } from '../../src/anchor-version.ts'

function touch(file: string, content: string): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

test('readAnchorVersion: root dependencies → installed manifest → apps/cli, in that priority order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-anchor-version-'))
  try {
    assert.equal(readAnchorVersion(dir), null, 'no manifest anywhere → null')
    touch(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '1.2.3' } }))
    assert.equal(readAnchorVersion(dir), '1.2.3')
    touch(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: '2.0.0' }))
    assert.equal(readAnchorVersion(dir), '1.2.3', 'the workspace root declaration stays first')
    rmSync(join(dir, 'package.json'))
    assert.equal(readAnchorVersion(dir), '2.0.0', 'installed package manifest second')
    touch(join(dir, 'apps', 'cli', 'package.json'), JSON.stringify({ version: '3.0.0' }))
    assert.equal(readAnchorVersion(dir), '2.0.0', 'installed manifest outranks the source checkout')
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
    assert.equal(readAnchorVersion(dir), '3.0.0', 'source checkout apps/cli is the last candidate')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readAnchorVersion: an unsafe version is skipped and the next candidate is tried', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-anchor-version-'))
  try {
    touch(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '^1.2.3' } }))
    touch(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: '../evil' }))
    touch(join(dir, 'apps', 'cli', 'package.json'), JSON.stringify({ version: '4.5.6' }))
    assert.equal(readAnchorVersion(dir), '4.5.6', 'both unsafe declarations fall through')
    writeFileSync(join(dir, 'apps', 'cli', 'package.json'), JSON.stringify({ version: 'not-semver' }))
    assert.equal(readAnchorVersion(dir), null, 'every candidate unsafe → null (fail loud at apply time)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readAnchorVersion: the accept gate replaces isSafeVersion without changing candidate order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-anchor-version-'))
  try {
    touch(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh': 'not-semver' } }))
    touch(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: '9.9.9' }))
    assert.equal(readAnchorVersion(dir), '9.9.9', 'the default gate rejects and falls through')
    assert.equal(readAnchorVersion(dir, raw => raw === 'not-semver'), 'not-semver', 'a custom gate can accept the first candidate')
    assert.equal(readAnchorVersion(dir, () => false), null, 'a rejecting gate leaves the whole read null')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
