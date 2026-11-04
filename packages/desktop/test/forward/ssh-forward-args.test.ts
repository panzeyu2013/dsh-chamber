/**
 * SSH argv golden tests for browser forwards (W0/S1, security review I9).
 *
 * The argv is the security boundary: one string built from a registry value can
 * become a remote/local execution option. These tests therefore assert the
 * COMPLETE array (not substrings), sweep a parameter grid for forbidden option
 * names, and pin the keepalive constants to ssh-provider.ts by reading its
 * source text (no runtime import: the provider pulls the control-plane facade,
 * and a text lock is the repository's established constant-drift check).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  buildForwardArgs,
  FORWARD_SSH_FORBIDDEN_OPTION_NAMES,
  FORWARD_CONNECT_TIMEOUT_SECONDS,
  FORWARD_SERVER_ALIVE_COUNT_MAX,
  FORWARD_SERVER_ALIVE_INTERVAL_SECONDS,
  FORWARD_TARGET_HOST,
} from '../../remote-forward-args.ts'

const SSH_PROVIDER_PATH = fileURLToPath(new URL('../../ssh-provider.ts', import.meta.url))

function providerConstant(name: string): number {
  const text = readFileSync(SSH_PROVIDER_PATH, 'utf8')
  const match = new RegExp('export const ' + name + ' = (\\d+)', 'u').exec(text)
  assert.ok(match !== null, 'ssh-provider must export ' + name)
  return Number(match[1])
}

test('argv golden: default ssh port, no user, alias bind on 127.0.0.2', () => {
  assert.deepEqual(
    buildForwardArgs({ host: 'dev.example.com', user: null, sshPort: null }, '127.0.0.2', 51234, 5173),
    [
      '-N',
      '-o', 'ConnectTimeout=8',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-L', '127.0.0.2:51234:127.0.0.1:5173',
      'dev.example.com',
    ],
  )
})

test('argv golden: user@host, explicit ssh port and the full alias range', () => {
  assert.deepEqual(
    buildForwardArgs({ host: '203.0.113.9', user: 'root', sshPort: 2222 }, '127.0.0.254', 1024, 9432),
    [
      '-N',
      '-o', 'ConnectTimeout=8',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-p', '2222',
      '-L', '127.0.0.254:1024:127.0.0.1:9432',
      'root@203.0.113.9',
    ],
  )
})

test('the remote side is ALWAYS 127.0.0.1 and the bind host is ALWAYS the alias', () => {
  for (const target of [1, 80, 443, 1024, 5173, 65535]) {
    const args = buildForwardArgs({ host: 'h', user: null, sshPort: null }, '127.0.0.9', 60000, target)
    const bind = args[args.indexOf('-L') + 1]
    assert.equal(bind, '127.0.0.9:60000:127.0.0.1:' + String(target))
    assert.equal(args.includes(FORWARD_TARGET_HOST), false, 'the target host only appears inside -L')
  }
})

test('no argv in the grid ever carries a forbidden ssh option', () => {
  const hosts = ['dev.example.com', '203.0.113.9', 'a-b_c.d']
  const users: (string | null)[] = [null, 'root', 'dev.user']
  const sshPorts: (number | null)[] = [null, 22, 2222, 65535]
  const aliases = ['127.0.0.2', '127.0.0.100', '127.0.0.254']
  const locals = [1024, 5173, 65535]
  const targets = [1, 80, 1024, 5173, 65535]
  let count = 0
  for (const host of hosts) {
    for (const user of users) {
      for (const sshPort of sshPorts) {
        for (const alias of aliases) {
          for (const localPort of locals) {
            for (const targetPort of targets) {
              const args = buildForwardArgs({ host, user, sshPort }, alias, localPort, targetPort)
              count += 1
              for (const forbidden of FORWARD_SSH_FORBIDDEN_OPTION_NAMES) {
                assert.equal(args.some(arg => arg.includes(forbidden)), false, 'forbidden option ' + forbidden + ' in ' + JSON.stringify(args))
              }
              assert.equal(args[0], '-N')
              assert.equal(args.filter(arg => arg === '-L').length, 1)
              // Every -o value is a compile-time literal, never a payload string.
              for (let index = 0; index < args.length; index += 1) {
                if (args[index] !== '-o') continue
                assert.match(args[index + 1] ?? '', /^(?:ConnectTimeout|ExitOnForwardFailure|ServerAliveInterval|ServerAliveCountMax)=/u)
              }
            }
          }
        }
      }
    }
  }
  assert.equal(count, 3 * 3 * 4 * 3 * 3 * 5)
})

test('keepalive/connect constants are pinned to ssh-provider.ts (one ssh discipline)', () => {
  assert.equal(FORWARD_CONNECT_TIMEOUT_SECONDS, 8)
  assert.equal(FORWARD_SERVER_ALIVE_INTERVAL_SECONDS, providerConstant('SERVER_ALIVE_INTERVAL_SECONDS'))
  assert.equal(FORWARD_SERVER_ALIVE_COUNT_MAX, providerConstant('SERVER_ALIVE_COUNT_MAX'))
})

test('invalid local bind hosts are refused (never 127.0.0.1/0/255, never localhost)', () => {
  for (const host of ['127.0.0.1', '127.0.0.0', '127.0.0.255', 'localhost', '0.0.0.0', '127.0.1.2', '']) {
    assert.throws(
      () => buildForwardArgs({ host: 'h', user: null, sshPort: null }, host, 5173, 5173),
      RangeError,
      host,
    )
  }
})

test('invalid ports are refused (target 1..65535, local >= 1024)', () => {
  for (const target of [0, -1, 65536, 5173.5, Number.NaN]) {
    assert.throws(() => buildForwardArgs({ host: 'h', user: null, sshPort: null }, '127.0.0.2', 5173, target), RangeError, String(target))
  }
  for (const local of [0, 80, 1023, 65536, 1.5]) {
    assert.throws(() => buildForwardArgs({ host: 'h', user: null, sshPort: null }, '127.0.0.2', local, 5173), RangeError, String(local))
  }
  for (const sshPort of [0, 65536, 1.5]) {
    assert.throws(() => buildForwardArgs({ host: 'h', user: null, sshPort }, '127.0.0.2', 5173, 5173), RangeError, String(sshPort))
  }
})

test('a hostile host/user can never become an ssh option or a second word', () => {
  const badHosts = [
    '-oProxyCommand=calc.exe',
    'host name',
    'host\n-oLocalCommand=x',
    'host;rm -rf /',
    'host$(id)',
    '',
    'x'.repeat(256),
  ]
  for (const host of badHosts) {
    assert.throws(() => buildForwardArgs({ host, user: null, sshPort: null }, '127.0.0.2', 5173, 5173), TypeError, host)
  }
  for (const user of ['root@evil', 'root -o X', 'root\nX', '']) {
    assert.throws(() => buildForwardArgs({ host: 'h', user, sshPort: null }, '127.0.0.2', 5173, 5173), TypeError, user)
  }
})
