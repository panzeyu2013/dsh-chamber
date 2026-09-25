/**
 * Shell-owned copy lock (2026-09 parity batch): the Electron flavor resolves the
 * native-chrome strings from one typed dictionary pair, mirroring upstream
 * apps/desktop/src/locale.ts (zh* → zh-CN, else en). Scope = tray, error boxes and
 * the quit dialog; the Web UI keeps its own i18n.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHELL_STRINGS, resolveShellLocale, shellStrings } from './shell-locale.ts'

const DESKTOP = dirname(fileURLToPath(import.meta.url))
const main = readFileSync(join(DESKTOP, 'main.ts'), 'utf8')

test('shell locale: upstream resolve rule (zh* → zh-CN, else en)', () => {
  assert.equal(resolveShellLocale('zh-Hans-CN'), 'zh-CN')
  assert.equal(resolveShellLocale('ZH'), 'zh-CN')
  assert.equal(resolveShellLocale('zh-TW'), 'zh-CN')
  assert.equal(resolveShellLocale('en-US'), 'en')
  assert.equal(resolveShellLocale('fr-FR'), 'en')
  assert.equal(resolveShellLocale(''), 'en')
  assert.equal(shellStrings('zh-CN').quitButton, '退出')
  assert.equal(shellStrings('de').quitButton, 'Quit')
})

test('shell locale: both dictionaries carry the same complete key set', () => {
  for (const [id, strings] of Object.entries(SHELL_STRINGS)) {
    for (const [key, value] of Object.entries(strings)) {
      assert.equal(typeof value, 'string', id + '.' + key + ' must be a string')
      assert.ok(value.length > 0, id + '.' + key + ' must not be empty')
    }
  }
  assert.deepEqual(
    Object.keys(SHELL_STRINGS['zh-CN']).sort(),
    Object.keys(SHELL_STRINGS.en).sort(),
    'both dictionaries must stay in lockstep',
  )
})

test('shell chrome resolves the locale instead of hardcoding copy', () => {
  assert.match(main, /shellStrings\(app\.getLocale\(\)\)/, 'main.ts must resolve app.getLocale()')
  for (const literal of [
    "'显示窗口'",
    "'退出 dsh-chamber'",
    "'退出 dsh-chamber？'",
    "'dsh-chamber 启动失败'",
    "'dsh-chamber 已在运行'",
    "'dsh-chamber 前端异常'",
  ]) {
    assert.ok(!main.includes(literal), 'main.ts must not hardcode ' + literal)
  }
})
