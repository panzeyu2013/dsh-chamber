import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseWindowsCommandLine,
  parseWindowsProcessJson,
  windowsProcessQueryArgs,
} from '../../remote-forward-windows.ts'

const BS = String.fromCharCode(92)

test('windows query: one bounded CIM argv, never a shell string', () => {
  const args = windowsProcessQueryArgs(4242)
  assert.equal(args[0], '-NoProfile')
  assert.equal(args[1], '-NonInteractive')
  assert.equal(args[2], '-Command')
  assert.match(args[3], /ProcessId=4242/)
  assert.match(args[3], /Get-CimInstance Win32_Process/)
  assert.match(args[3], /ConvertTo-Json -Compress/)
  assert.equal(args.length, 4)
  assert.throws(() => windowsProcessQueryArgs(0), /invalid pid/)
  assert.throws(() => windowsProcessQueryArgs(1.5), /invalid pid/)
})

test('windows command line: plain ssh argv round-trips token by token', () => {
  assert.deepEqual(
    parseWindowsCommandLine('ssh -N -L 127.0.0.2:5173:127.0.0.1:5173 root@dev.example.com'),
    ['ssh', '-N', '-L', '127.0.0.2:5173:127.0.0.1:5173', 'root@dev.example.com'],
  )
})

test('windows command line: quotes and backslashes follow CommandLineToArgvW', () => {
  const exe = 'C:' + BS + 'Program Files' + BS + 'ssh.exe'
  assert.deepEqual(
    parseWindowsCommandLine('"' + exe + '" -N "a b"'),
    [exe, '-N', 'a b'],
  )
  assert.deepEqual(parseWindowsCommandLine('a"b c"'), ['ab c'])
  assert.deepEqual(parseWindowsCommandLine('a' + BS + '"b'), ['a"b'])
  assert.deepEqual(parseWindowsCommandLine('""'), [''])
  assert.deepEqual(parseWindowsCommandLine('a' + BS), ['a' + BS])
})

test('windows command line: unprovable input is null, never a guess', () => {
  assert.equal(parseWindowsCommandLine(''), null)
  assert.equal(parseWindowsCommandLine('   '), null)
  assert.equal(parseWindowsCommandLine('"unterminated'), null)
})

test('windows process JSON: valid CIM record becomes a cim token + argv', () => {
  const parsed = parseWindowsProcessJson(JSON.stringify({
    startTime: '2026-11-04T09:00:00.0000000Z',
    commandLine: 'ssh -N -L 127.0.0.2:5173:127.0.0.1:5173 root@dev.example.com',
  }))
  assert.notEqual(parsed, null)
  assert.equal(parsed?.startTime, 'cim:2026-11-04T09:00:00.0000000Z')
  assert.deepEqual(parsed?.argv, ['ssh', '-N', '-L', '127.0.0.2:5173:127.0.0.1:5173', 'root@dev.example.com'])
})

test('windows process JSON: missing/malformed fields are null', () => {
  assert.equal(parseWindowsProcessJson(''), null)
  assert.equal(parseWindowsProcessJson('not json'), null)
  assert.equal(parseWindowsProcessJson('null'), null)
  assert.equal(parseWindowsProcessJson('{}'), null)
  assert.equal(parseWindowsProcessJson(JSON.stringify({ startTime: '', commandLine: 'ssh' })), null)
  assert.equal(parseWindowsProcessJson(JSON.stringify({ startTime: 't', commandLine: '' })), null)
  assert.equal(parseWindowsProcessJson(JSON.stringify({ startTime: 't', commandLine: '"unterminated' })), null)
})
