/**
 * ~/.ssh/config host discovery (desktop main process) unit tests.
 *
 * Covers the hand-rolled parser: entries, comments, continuations,
 * case-insensitivity, wildcard skipping, global-section defaults, the
 * alias-as-hostname fallback, non-secret projection only (IdentityFile /
 * ProxyCommand / passwords never surface), and the loud-vs-empty file
 * semantics (missing file = empty set, unreadable file = {error}).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSshConfigHosts, parseSshConfig } from './ssh-config.ts'

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-config-'))
  return dir
}

test('parses Host entries with HostName/User/Port', () => {
  const hosts = parseSshConfig(`
    Host home
      HostName home.example.com
      User alice
      Port 2222

    Host lab
      HostName 10.0.0.5
      User bob
  `)
  assert.deepEqual(hosts, [
    { alias: 'home', hostName: 'home.example.com', user: 'alice', port: 2222 },
    { alias: 'lab', hostName: '10.0.0.5', user: 'bob', port: null },
  ])
})

test('alias without HostName falls back to the alias itself', () => {
  const hosts = parseSshConfig('Host bare\n  User root\n')
  assert.deepEqual(hosts, [{ alias: 'bare', hostName: 'bare', user: 'root', port: null }])
})

test('wildcard Host patterns are skipped as entries', () => {
  const hosts = parseSshConfig(`
    Host *
      User defaultuser
    Host prod-*
      User ops
    Host !prod-db
      User skip
    Host real
      HostName real.example.com
  `)
  assert.deepEqual(hosts, [{ alias: 'real', hostName: 'real.example.com', user: null, port: null }])
})

test('global-section User/Port become defaults for every entry', () => {
  const hosts = parseSshConfig(`
    User globaluser
    Port 2200
    Host a
      HostName a.example.com
    Host b
      HostName b.example.com
      Port 2300
  `)
  assert.deepEqual(hosts, [
    { alias: 'a', hostName: 'a.example.com', user: 'globaluser', port: 2200 },
    { alias: 'b', hostName: 'b.example.com', user: 'globaluser', port: 2300 },
  ])
})

test('comments, blank lines, and backslash continuations are handled', () => {
  const hosts = parseSshConfig([
    '# leading comment',
    'Host conti\\',
    'nued',
    '  HostName continued.example.com \\',
    '    # comment inside the continuation',
    '  User carol',
    '',
  ].join('\n'))
  assert.deepEqual(hosts, [
    { alias: 'continued', hostName: 'continued.example.com', user: 'carol', port: null },
  ])
})

test('multi-alias Host lines expand to one entry per alias; quoted args are unquoted', () => {
  const hosts = parseSshConfig(`
    Host "web" app db
      HostName svc.example.com
      User deploy
  `)
  assert.deepEqual(hosts, [
    { alias: 'web', hostName: 'svc.example.com', user: 'deploy', port: null },
    { alias: 'app', hostName: 'svc.example.com', user: 'deploy', port: null },
    { alias: 'db', hostName: 'svc.example.com', user: 'deploy', port: null },
  ])
})

test('duplicate aliases on one Host line collapse to a single entry; quoted ports parse', () => {
  const hosts = parseSshConfig(`
    Host dup dup again
      User carol
      Port "2222"
    Host qp
      Port "2333"
  `)
  assert.deepEqual(hosts, [
    { alias: 'dup', hostName: 'dup', user: 'carol', port: 2222 },
    { alias: 'again', hostName: 'again', user: 'carol', port: 2222 },
    { alias: 'qp', hostName: 'qp', user: null, port: 2333 },
  ])
})

test('a valueless Host keyword and semicolons produce no entries (OpenSSH: # only)', () => {
  const hosts = parseSshConfig([
    'Host',
    '  User who',
    'Host foo;bar',
    '  User x',
    'Host ok',
    '',
  ].join('\n'))
  assert.deepEqual(hosts, [
    { alias: 'foo;bar', hostName: 'foo;bar', user: 'x', port: null },
    { alias: 'ok', hostName: 'ok', user: null, port: null },
  ])
})

test('Match blocks are skipped entirely and never leak into entries', () => {
  const hosts = parseSshConfig(`
    Host before
      HostName before.example.com
    Match host *.example.com
      User matcheduser
      Port 2999
    Host after
      HostName after.example.com
  `)
  assert.deepEqual(hosts, [
    { alias: 'before', hostName: 'before.example.com', user: null, port: null },
    { alias: 'after', hostName: 'after.example.com', user: null, port: null },
  ])
})

test('keywords are case-insensitive and only Host/HostName/User/Port are projected', () => {
  const hosts = parseSshConfig(`
    host mixed
      hostname Mixed.Example.COM
      identityfile ~/.ssh/id_ed25519
      ProxyCommand nc %h %p
      PasswordAuthentication yes
      user dave
  `)
  assert.deepEqual(hosts, [{ alias: 'mixed', hostName: 'Mixed.Example.COM', user: 'dave', port: null }])
})

test('first obtained value wins for each field (ssh semantics)', () => {
  const hosts = parseSshConfig(`
    Host dup
      User first
      User second
      Port 2000
      Port 2100
  `)
  assert.deepEqual(hosts, [{ alias: 'dup', hostName: 'dup', user: 'first', port: 2000 }])
})

test('invalid and non-decimal ports are ignored (OpenSSH accepts decimal only)', () => {
  const hosts = parseSshConfig(`
    User 
    Port abc
    Port 0
    Port 70000
    Port 0x10
    Port 1e3
    Host fine
      Port 22
    Host hex
      Port 0x10
  `)
  assert.deepEqual(hosts, [
    { alias: 'fine', hostName: 'fine', user: null, port: 22 },
    { alias: 'hex', hostName: 'hex', user: null, port: null },
  ])
})

test('a missing config file is an empty set, never an error', () => {
  const dir = tempDir()
  const result = discoverSshConfigHosts(join(dir, 'nope', 'config'))
  assert.deepEqual(result, { hosts: [] })
})

test('an unreadable config file is a loud {error}, never a silent empty', () => {
  const dir = tempDir()
  const file = join(dir, 'config')
  mkdirSync(file)
  const result = discoverSshConfigHosts(file)
  assert.ok('error' in result)
  if ('error' in result) assert.match(result.error, /could not read ssh config/)
  rmSync(dir, { recursive: true, force: true })
})

test('discovery reads the file and projects hosts', () => {
  const dir = tempDir()
  const file = join(dir, 'config')
  writeFileSync(file, 'Host prod\n  HostName prod.example.com\n  User deploy\n  Port 2222\n')
  const result = discoverSshConfigHosts(file)
  assert.deepEqual(result, {
    hosts: [{ alias: 'prod', hostName: 'prod.example.com', user: 'deploy', port: 2222 }],
  })
  rmSync(dir, { recursive: true, force: true })
})
