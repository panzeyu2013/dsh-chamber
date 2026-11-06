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
import type { ForwardSshSpec } from '../../remote-forward-args.ts'
import { sshTrustPins } from '../../host-key.ts'

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
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none',
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
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none',
      '-p', '2222',
      '-L', '127.0.0.254:1024:127.0.0.1:9432',
      'root@203.0.113.9',
    ],
  )
})

test('argv golden: the app-owned known_hosts pins the tunnel trust store (v2)', () => {
  const spec: ForwardSshSpec = {
    host: 'dev.example.com',
    user: 'root',
    sshPort: 2222,
    knownHosts: { knownHostsFile: '/app data/ssh/known_hosts', globalKnownHostsFile: '/dev/null' },
  }
  assert.deepEqual(
    buildForwardArgs(spec, '127.0.0.2', 40000, 5173),
    [
      '-N',
      '-o', 'ConnectTimeout=8',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none',
      '-o', 'StrictHostKeyChecking=yes',
      // Paths are ssh-quoted (macOS userData contains a space).
      '-o', 'UserKnownHostsFile="/app data/ssh/known_hosts"',
      '-o', 'GlobalKnownHostsFile="/dev/null"',
      '-o', 'HostKeyAlias=dev.example.com:2222',
      ...sshTrustPins(),
      '-p', '2222',
      '-L', '127.0.0.2:40000:127.0.0.1:5173',
      'root@dev.example.com',
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
                assert.match(args[index + 1] ?? '', /^(?:ConnectTimeout|ExitOnForwardFailure|ServerAliveInterval|ServerAliveCountMax|ControlMaster|ControlPath)=/u)
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

test('the transport provider and the forward builder share one -o option set (v2 lockstep)', () => {
  // Runtime-importing ssh-provider.ts is not available to the pure desktop test
  // leg (it reaches the packaged control-plane facade), so the lockstep reads
  // its buildStartArgs source text: the option NAMES come from the same table.
  const providerText = readFileSync(SSH_PROVIDER_PATH, 'utf8')
  const start = providerText.indexOf('buildStartArgs(')
  const end = providerText.indexOf('buildStartEnv(', start)
  assert.ok(start > 0 && end > start, 'ssh-provider buildStartArgs must exist')
  // Template literals become single-quoted literals for the name scan.
  const body = providerText.slice(start, end).split(String.fromCharCode(96)).join("'")

  const spec = {
    host: 'dev.example.com',
    user: 'root',
    sshPort: null,
    knownHosts: { knownHostsFile: '/app/ssh/known_hosts', globalKnownHostsFile: '/dev/null' },
  }
  const argv = buildForwardArgs(spec, '127.0.0.2', 40000, 5173)
  const optionNames = (args: readonly string[]): Set<string> => {
    const names = new Set<string>()
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] !== '-o') continue
      const value = args[index + 1] ?? ''
      names.add(value.slice(0, value.indexOf('=')))
    }
    return names
  }
  const forwardNames = optionNames(argv)
  // The trust pins come from the shared host-key.ts helper, never re-typed.
  for (const name of optionNames(sshTrustPins())) forwardNames.delete(name)

  const providerNames = new Set<string>()
  for (const match of body.matchAll(/-o',\s*'([A-Za-z][A-Za-z0-9]*)=/gu)) {
    if (match[1] !== undefined) providerNames.add(match[1])
  }
  // Transport-only option: the tunnel's POSIX UDS branch replaces a stale socket
  // file; a browser forward always binds a TCP alias host and never sets it.
  providerNames.delete('StreamLocalBindUnlink')
  assert.deepEqual([...forwardNames].sort(), [...providerNames].sort())
  // The dynamic host-key expressions are the SAME helper calls, not re-typed.
  for (const literal of [
    'StrictHostKeyChecking=yes',
    'UserKnownHostsFile=${sshOptionValue(knownHosts.knownHostsFile)}',
    'GlobalKnownHostsFile=${sshOptionValue(knownHosts.globalKnownHostsFile)}',
    'HostKeyAlias=${hostKeyAliasFor(spec)}',
    '...sshTrustPins()',
  ]) {
    assert.ok(body.includes(literal), 'ssh-provider must build ' + literal)
  }
})

test('the known_hosts store argument is validated and quoted (never raw payload)', () => {
  const base = { host: 'h', user: null, sshPort: null }
  for (const knownHosts of [
    { knownHostsFile: '', globalKnownHostsFile: '/dev/null' },
    { knownHostsFile: '/x', globalKnownHostsFile: '' },
    { knownHostsFile: '/x\nrm -rf', globalKnownHostsFile: '/dev/null' },
    { knownHostsFile: 'x'.repeat(4097), globalKnownHostsFile: '/dev/null' },
    { knownHostsFile: 42, globalKnownHostsFile: '/dev/null' },
    'not-an-object',
  ]) {
    assert.throws(() => buildForwardArgs(
      { ...base, knownHosts: knownHosts as unknown as { knownHostsFile: string; globalKnownHostsFile: string } },
      '127.0.0.2',
      5173,
      5173,
    ), TypeError, JSON.stringify(knownHosts))
  }
  const quoted = buildForwardArgs({
    ...base,
    knownHosts: { knownHostsFile: '/a b/c', globalKnownHostsFile: '/dev/null' },
  }, '127.0.0.2', 5173, 5173)
  assert.ok(quoted.includes('UserKnownHostsFile="/a b/c"'), 'the path value must be ssh-quoted')
})
