import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  INSTANCE_ID_PATTERN as UI_INSTANCE_ID_PATTERN,
  MAX_INSTANCE_LABEL_CHARS as UI_MAX_INSTANCE_LABEL_CHARS,
  MAX_REMOTE_DSH_HOME_CHARS as UI_MAX_REMOTE_DSH_HOME_CHARS,
  MAX_SERVICE_NAME_CHARS as UI_MAX_SERVICE_NAME_CHARS,
  MAX_SSH_HOST_CHARS as UI_MAX_SSH_HOST_CHARS,
  MAX_SSH_PASSWORD_CHARS as UI_MAX_SSH_PASSWORD_CHARS,
  MAX_SSH_USER_CHARS as UI_MAX_SSH_USER_CHARS,
  REMOTE_DSH_HOME_PATTERN as UI_REMOTE_DSH_HOME_PATTERN,
  SERVICE_NAME_PATTERN as UI_SERVICE_NAME_PATTERN,
  SSH_HOST_PATTERN as UI_SSH_HOST_PATTERN,
  SSH_USER_PATTERN as UI_SSH_USER_PATTERN,
} from './host-validation.ts'

const desktopAuthority = [
  '../../../desktop/transport-provider.ts',
  '../../../desktop/ssh-provider.ts',
].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')

function assertDesktopExport(name: string, value: RegExp | number): void {
  const literal = value instanceof RegExp ? value.toString() : String(value)
  assert.ok(
    desktopAuthority.includes(`export const ${name} = ${literal}`),
    `desktop authority must export ${name} = ${literal}`,
  )
}

test('connection form metadata gates stay byte-for-byte aligned with desktop authority', () => {
  assertDesktopExport('INSTANCE_ID_PATTERN', UI_INSTANCE_ID_PATTERN)
  assertDesktopExport('SSH_HOST_PATTERN', UI_SSH_HOST_PATTERN)
  assertDesktopExport('SSH_USER_PATTERN', UI_SSH_USER_PATTERN)
  assertDesktopExport('SERVICE_NAME_PATTERN', UI_SERVICE_NAME_PATTERN)
  assertDesktopExport('REMOTE_DSH_HOME_PATTERN', UI_REMOTE_DSH_HOME_PATTERN)
  assertDesktopExport('MAX_INSTANCE_LABEL_CHARS', UI_MAX_INSTANCE_LABEL_CHARS)
  assertDesktopExport('MAX_SSH_HOST_CHARS', UI_MAX_SSH_HOST_CHARS)
  assertDesktopExport('MAX_SSH_USER_CHARS', UI_MAX_SSH_USER_CHARS)
  assertDesktopExport('MAX_SERVICE_NAME_CHARS', UI_MAX_SERVICE_NAME_CHARS)
  assertDesktopExport('MAX_REMOTE_DSH_HOME_CHARS', UI_MAX_REMOTE_DSH_HOME_CHARS)
  assertDesktopExport('MAX_SSH_PASSWORD_CHARS', UI_MAX_SSH_PASSWORD_CHARS)
})

test('remoteDshHome rejects traversal/empty segments and accepts safe home roots', () => {
  for (const invalid of ['/srv/../tmp', '~/../tmp', '/srv/./dsh', '/srv//dsh', '/srv/dsh/']) {
    assert.equal(UI_REMOTE_DSH_HOME_PATTERN.test(invalid), false, invalid)
  }
  for (const valid of ['~/.dsh', '/srv/dsh', '/srv/dsh-home_1']) {
    assert.equal(UI_REMOTE_DSH_HOME_PATTERN.test(valid), true, valid)
  }
})

test('service names cannot be parsed as systemctl options', () => {
  assert.equal(UI_SERVICE_NAME_PATTERN.test('--help'), false)
  assert.equal(UI_SERVICE_NAME_PATTERN.test('-Hattacker'), false)
  assert.equal(UI_SERVICE_NAME_PATTERN.test('dsh-chamber.service'), true)
  assert.equal(UI_SERVICE_NAME_PATTERN.test('dsh@worker.service'), true)
  assert.equal(UI_SERVICE_NAME_PATTERN.test('team:worker.service'), true)
})
