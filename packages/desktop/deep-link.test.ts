/**
 * VS Code deep-link core (design 16 §3/§4/§5) unit tests — pure Node, no
 * electron, no real VS Code. The OS-level deep link is untrusted input, so
 * the suite drives parseOpenVscodeIntent / buildVscodeRemoteUrl with malicious
 * and boundary inputs, drives detectVscodeAvailability through injected
 * platform + PATH + fs stubs, and drives runVscodeLaunch through an injected
 * VscodeLaunchContext (registry lookup / availability / openExternal are all
 * faked — no real SSH host, no real VS Code).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVscodeFileUrl, buildVscodeRemoteUrl, detectVscodeAvailability, parseOpenVscodeIntent, runVscodeLaunch, validateLocalPath } from './deep-link.ts'
import type { VscodeLaunchContext, VscodeLaunchRequest } from './deep-link.ts'

/** A minimal valid ssh instance for runVscodeLaunch context fakes. */
const sshInstance = { id: 'web-1', host: 'h.example.com', user: 'root', sshPort: null, kind: 'ssh' }

function context(overrides: Partial<VscodeLaunchContext> & { lookup?: VscodeLaunchContext['lookupInstance'] } = {}): VscodeLaunchContext {
  return {
    lookupInstance: overrides.lookupInstance ?? (() => ({ ...sshInstance })),
    vscodeAvailable: overrides.vscodeAvailable ?? (() => true),
    openVscodeUrl: overrides.openVscodeUrl ?? (async () => ({ ok: true })),
  }
}

test('parseOpenVscodeIntent accepts a well-formed deep link', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=web-1&path=%2Fhome%2Fuser%2Fproj')
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.intent, { instanceId: 'web-1', path: '/home/user/proj' })
  }
})

test('parseOpenVscodeIntent rejects a non-dsh-chamber scheme', () => {
  const result = parseOpenVscodeIntent('https://open-vscode?instance=web-1&path=/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /scheme/i)
})

test('parseOpenVscodeIntent rejects an unexpected host', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://evil?instance=web-1&path=/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /host/i)
})

test('parseOpenVscodeIntent rejects a missing instance', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode?path=/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /instance/i)
})

test('parseOpenVscodeIntent rejects an invalid instance id', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=bad%2Fid&path=/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /instance/i)
})

test('parseOpenVscodeIntent accepts the reserved local instance id (user decision 2026-08)', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=local&path=/foo')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.intent.instanceId, 'local')
})

test('parseOpenVscodeIntent accepts Windows drive and UNC paths only for the local instance', () => {
  const drive = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=local&path=C%3A%5CUsers%5CAlice%5Cproject')
  assert.equal(drive.ok, true)
  const unc = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=local&path=%5C%5Cserver%5Cshare%5Cproject')
  assert.equal(unc.ok, true)
  assert.equal(parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=ssh-1&path=C%3A%5CUsers%5CAlice').ok, false)
})

test('parseOpenVscodeIntent rejects userinfo in the authority (P2-2)', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://user:pass@open-vscode?instance=web-1&path=/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /userinfo/i)
})

test('parseOpenVscodeIntent rejects a port in the authority (P2-2)', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode:9999?instance=web-1&path=/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /port/i)
})

test('parseOpenVscodeIntent rejects a missing path', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=web-1')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /path/i)
})

test('parseOpenVscodeIntent rejects a relative path', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=web-1&path=foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /absolute|leading \//i)
})

test('parseOpenVscodeIntent rejects a path with control characters', () => {
  const result = parseOpenVscodeIntent('dsh-chamber://open-vscode?instance=web-1&path=%2Ffoo%0Abar')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /control/i)
})

test('parseOpenVscodeIntent rejects an overlong path', () => {
  const longPath = '/' + 'a'.repeat(4096)
  const result = parseOpenVscodeIntent(`dsh-chamber://open-vscode?instance=web-1&path=${encodeURIComponent(longPath)}`)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /4096/)
})

test('parseOpenVscodeIntent rejects malformed URLs without throwing', () => {
  const result = parseOpenVscodeIntent('not a url')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /invalid deep-link/i)
})

test('buildVscodeRemoteUrl omits the user when null', () => {
  const result = buildVscodeRemoteUrl('h.example.com', null, null, '/foo')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.url, 'vscode://vscode-remote/ssh-remote+h.example.com/foo')
})

test('buildVscodeRemoteUrl includes the user when present', () => {
  const result = buildVscodeRemoteUrl('h.example.com', 'root', null, '/foo')
  assert.equal(result.ok, true)
  if (result.ok) assert.match(result.url, /ssh-remote\+root@h\.example\.com\//)
})

test('buildVscodeRemoteUrl brackets an IPv6 literal', () => {
  const result = buildVscodeRemoteUrl('[::1]', null, null, '/foo')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.url, 'vscode://vscode-remote/ssh-remote+[::1]/foo')
})

test('buildVscodeRemoteUrl re-brackets an unbracketed IPv6 literal', () => {
  const result = buildVscodeRemoteUrl('::1', null, null, '/foo')
  assert.equal(result.ok, true)
  if (result.ok) assert.match(result.url, /ssh-remote\+\[::1\]\//)
})

test('buildVscodeRemoteUrl rejects a host:port ambiguity', () => {
  const result = buildVscodeRemoteUrl('host:22', null, null, '/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /IPv6|host:port|冒号/i)
})

test('buildVscodeRemoteUrl accepts sshPort 22', () => {
  const result = buildVscodeRemoteUrl('h.example.com', null, 22, '/foo')
  assert.equal(result.ok, true)
})

test('buildVscodeRemoteUrl rejects a non-22 sshPort with the config guidance', () => {
  const result = buildVscodeRemoteUrl('h.example.com', null, 2222, '/foo')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /~\/\.ssh\/config/)
})

test('buildVscodeRemoteUrl encodes path segments (space / CJK / # / ? / %)', () => {
  const result = buildVscodeRemoteUrl('h.example.com', null, null, '/a b/中文/c#d?e%f')
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(
      result.url,
      'vscode://vscode-remote/ssh-remote+h.example.com/a%20b/%E4%B8%AD%E6%96%87/c%23d%3Fe%25f',
    )
    assert.ok(!result.url.includes(' '), 'no raw space survives')
    assert.ok(!result.url.includes('#'), 'no raw # survives')
    assert.ok(!result.url.includes('?'), 'no raw ? survives')
  }
})

test('buildVscodeRemoteUrl hardcodes the vscode: scheme prefix', () => {
  const result = buildVscodeRemoteUrl('h.example.com', 'u', null, '/foo')
  assert.equal(result.ok, true)
  if (result.ok) assert.ok(result.url.startsWith('vscode://vscode-remote/ssh-remote+'), 'scheme is hardcoded vscode:')
})

test('buildVscodeRemoteUrl rejects a non-absolute path', () => {
  const result = buildVscodeRemoteUrl('h.example.com', null, null, 'relative')
  assert.equal(result.ok, false)
})

test('detectVscodeAvailability finds the macOS app bundle', () => {
  const result = detectVscodeAvailability('darwin', {
    exists: target => target === '/Applications/Visual Studio Code.app',
  })
  assert.deepEqual(result, { available: true })
})

test('detectVscodeAvailability finds the per-user macOS app bundle', () => {
  const result = detectVscodeAvailability('darwin', {
    homeDir: '/home/u',
    exists: target => target === '/home/u/Applications/Visual Studio Code.app',
  })
  assert.deepEqual(result, { available: true })
})

test('detectVscodeAvailability finds an executable code in PATH (linux)', () => {
  const result = detectVscodeAvailability('linux', {
    pathEnv: '/a:/b',
    accessX: target => target === '/b/code',
  })
  assert.deepEqual(result, { available: true })
})

test('detectVscodeAvailability treats missing/empty PATH as not found', () => {
  const result = detectVscodeAvailability('linux', {
    pathEnv: '',
    accessX: () => false,
  })
  assert.deepEqual(result, { available: false })
})

test('detectVscodeAvailability treats a DIRECTORY named code as NOT available (real fs, P1-2)', () => {
  // POSIX directories pass access(X_OK); the executable check must also
  // require isFile() — a PATH entry named `code` that is a directory is not
  // VS Code (security-review P1-2).
  const dir = mkdtempSync(join(tmpdir(), 'dsh-deeplink-dir-'))
  try {
    mkdirSync(join(dir, 'code'))
    const result = detectVscodeAvailability('linux', { pathEnv: dir })
    assert.deepEqual(result, { available: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectVscodeAvailability finds a real executable file named code (real fs)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-deeplink-exe-'))
  try {
    const bin = join(dir, 'code')
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o644 })
    chmodSync(bin, 0o755)
    const result = detectVscodeAvailability('linux', { pathEnv: dir })
    assert.deepEqual(result, { available: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectVscodeAvailability finds Code.exe via LOCALAPPDATA (win32, isFile)', () => {
  const result = detectVscodeAvailability('win32', {
    localAppData: 'C:\\Users\\u\\AppData\\Local',
    exists: target => target.endsWith('Code.exe'),
    isFile: target => target.endsWith('Code.exe'),
  })
  assert.deepEqual(result, { available: true })
})

test('detectVscodeAvailability rejects a DIRECTORY at the Code.exe path (win32)', () => {
  const result = detectVscodeAvailability('win32', {
    localAppData: 'C:\\Users\\u\\AppData\\Local',
    exists: target => target.endsWith('Code.exe'),
    isFile: () => false, // same-named directory: not installed
  })
  assert.deepEqual(result, { available: false })
})

test('detectVscodeAvailability finds code.cmd in PATH (win32)', () => {
  const result = detectVscodeAvailability('win32', {
    pathEnv: 'C:\\x;D:\\y',
    accessX: target => target.endsWith('code.cmd'),
  })
  assert.deepEqual(result, { available: true })
})

test('detectVscodeAvailability returns false for an unknown platform', () => {
  const result = detectVscodeAvailability('sunos', { pathEnv: '', accessX: () => false })
  assert.deepEqual(result, { available: false })
})

test('runVscodeLaunch fails loudly for an unknown instance', async () => {
  const result = await runVscodeLaunch({ instanceId: 'ghost', path: '/foo' }, context({ lookupInstance: () => null }))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not found/i)
})

test('runVscodeLaunch rejects an instanceId that fails INSTANCE_ID_PATTERN (P2-3)', async () => {
  const result = await runVscodeLaunch(
    { instanceId: '!!weird!!', path: '/foo' },
    context({ lookupInstance: () => ({ ...sshInstance }) }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /instance/i)
})

test('runVscodeLaunch fails loudly for a non-ssh instance kind', async () => {
  const result = await runVscodeLaunch(
    { instanceId: 'web-1', path: '/foo' },
    context({ lookupInstance: () => ({ ...sshInstance, kind: 'tailscale' }) }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not an ssh instance/i)
})

test('runVscodeLaunch fails loudly when VS Code is not detected', async () => {
  const result = await runVscodeLaunch(
    { instanceId: 'web-1', path: '/foo' },
    context({ vscodeAvailable: () => false }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /vscode not detected/i)
})

test('runVscodeLaunch passes through an openVscodeUrl failure loudly', async () => {
  const result = await runVscodeLaunch(
    { instanceId: 'web-1', path: '/foo' },
    context({ openVscodeUrl: async () => ({ ok: false, error: 'open failed' }) }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error, 'open failed')
})

test('runVscodeLaunch succeeds end-to-end and opens the constructed URL', async () => {
  let opened: string | null = null
  const result = await runVscodeLaunch(
    { instanceId: 'web-1', path: '/home/user/proj' },
    context({
      lookupInstance: () => ({ id: 'web-1', host: 'h.example.com', user: 'root', sshPort: null, kind: 'ssh' }),
      openVscodeUrl: async url => {
        opened = url
        return { ok: true }
      },
    }),
  )
  assert.equal(result.ok, true)
  assert.equal(opened, 'vscode://vscode-remote/ssh-remote+root@h.example.com/home/user/proj')
})

test('buildVscodeFileUrl builds a local file target with encoded path', () => {
  const result = buildVscodeFileUrl('/home/user/我的 项目')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.url, 'vscode://file/home/user/%E6%88%91%E7%9A%84%20%E9%A1%B9%E7%9B%AE')
})

test('buildVscodeFileUrl supports Windows drive and UNC absolute paths', () => {
  assert.deepEqual(buildVscodeFileUrl('C:\\Users\\Alice\\My Project'), {
    ok: true,
    url: 'vscode://file/C:/Users/Alice/My%20Project',
  })
  assert.deepEqual(buildVscodeFileUrl('\\\\server\\share\\My Project'), {
    ok: true,
    url: 'vscode://file//server/share/My%20Project',
  })
  assert.equal(validateLocalPath('C:relative').ok, false)
})

test('buildVscodeFileUrl rejects a relative path', () => {
  const result = buildVscodeFileUrl('relative/path')
  assert.equal(result.ok, false)
})

test('runVscodeLaunch opens a local file URL for instance=local (user decision 2026-08)', async () => {
  let opened: string | null = null
  const result = await runVscodeLaunch(
    { instanceId: 'local', path: '/home/user/local-ws' },
    context({
      lookupInstance: () => null, // local is never in the ssh registry
      openVscodeUrl: async url => {
        opened = url
        return { ok: true }
      },
    }),
  )
  assert.equal(result.ok, true)
  assert.equal(opened, 'vscode://file/home/user/local-ws')
})

test('runVscodeLaunch local branch still re-checks availability', async () => {
  const result = await runVscodeLaunch(
    { instanceId: 'local', path: '/home/user/local-ws' },
    context({ vscodeAvailable: () => false }),
  )
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /vscode not detected/i)
})
