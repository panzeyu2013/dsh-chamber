import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findDshWorkspace, isDshWorkspace } from '../src/dsh-path.ts'

test('findDshWorkspace accepts a source checkout fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-dsh-source-'))
  const entry = join(root, 'apps', 'cli', 'src', 'bin.ts')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, '')
  assert.equal(isDshWorkspace(root), true)
  assert.equal(findDshWorkspace(root, ''), root)
})

test('findDshWorkspace derives a global package root from the dsh bin symlink', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'gateway-dsh-global-'))
  const root = join(fixture, 'lib')
  const entry = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const bin = join(fixture, 'bin', 'dsh')
  mkdirSync(dirname(entry), { recursive: true })
  mkdirSync(dirname(bin), { recursive: true })
  writeFileSync(entry, '')
  symlinkSync(entry, bin)
  assert.equal(findDshWorkspace(join(fixture, 'missing'), dirname(bin), 'linux'), realpathSync(root))
})

test('findDshWorkspace finds a sibling dsh package when the global bin is a wrapper', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'gateway-dsh-sibling-'))
  const entry = join(fixture, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const gatewayBundle = join(fixture, 'node_modules', '@dsh-chamber', 'gateway', 'dist', 'cli.js')
  const wrapper = join(fixture, 'bin', 'dsh.cmd')
  mkdirSync(dirname(entry), { recursive: true })
  mkdirSync(dirname(gatewayBundle), { recursive: true })
  mkdirSync(dirname(wrapper), { recursive: true })
  writeFileSync(entry, '')
  writeFileSync(gatewayBundle, '')
  writeFileSync(wrapper, '@echo off\r\n')
  assert.equal(
    findDshWorkspace(join(fixture, 'missing'), dirname(wrapper), 'win32', gatewayBundle),
    realpathSync(fixture),
  )
})

test('findDshWorkspace returns null for an unrelated dsh executable', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'gateway-dsh-unrelated-'))
  const bin = join(fixture, 'dsh')
  writeFileSync(bin, '#!/bin/sh\n')
  assert.equal(findDshWorkspace(join(fixture, 'missing'), fixture, 'linux'), null)
})
