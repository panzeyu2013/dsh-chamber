/**
 * Chamber-surface tests (design 17 §10, 2026-12 strip): the gateway's own
 * `/chamber/*` operations surface — channels projection + plugin-sync seed
 * cache + browser dashboard assets (Credentials + dsh runtime management
 * only). The orchestration
 * routes (git worktrees, approvals/notifications, schedule, session index,
 * feature settings) were removed with the feature host; dsh native or
 * design 08 covers them.
 *
 * Run directly: node packages/gateway/test/feature-lifecycle.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'
import { createChamberPlugins, SYNCED_ARTIFACT_MAX_BYTES, SYNCED_PACKAGE_MAX_BYTES } from '../src/plugins.ts'
import { createChamberSurface } from '../src/routes.ts'
import { FakeRequest, FakeResponse } from './utils.ts'

const logger = {
  log() {},
  warn() {},
  error() {},
}

const channels = {
  register() {},
  async start() {},
  async stop() {},
  resolve: () => null,
  health: () => 'unknown' as const,
  list: () => [],
}

class UploadRequest extends EventEmitter {
  method = 'PUT'
  headers: Record<string, string | string[] | undefined> = {}
  destroyed = false
  destroy(): void { this.destroyed = true }
}

function uploadVia(host: ReturnType<typeof surface>, body: unknown): Promise<FakeResponse> {
  const response = new FakeResponse()
  const request = new UploadRequest()
  const pending = host.handle(request as unknown as ApiRequest, response as unknown as ApiResponse, '/chamber/plugins')
  queueMicrotask(() => {
    request.emit('data', Buffer.from(JSON.stringify(body)))
    request.emit('end')
  })
  return pending.then(() => response)
}

function surface(t?: { after(fn: () => void): void }) {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-surface-'))
  t?.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const plugins = createChamberPlugins(stateDir, logger)
  return createChamberSurface({ logger, channels, plugins })
}

async function handle(surfaceHost: ReturnType<typeof surface>, method: string, path: string): Promise<FakeResponse> {
  const response = new FakeResponse()
  await surfaceHost.handle(new FakeRequest(method) as unknown as ApiRequest,
    response as unknown as ApiResponse, path)
  return response
}

test('chamber channels projection is a read-only GET', async t => {
  const host = surface(t)
  const ok = await handle(host, 'GET', '/chamber/channels')
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json(), { items: [] })
  const notAllowed = await handle(host, 'POST', '/chamber/channels')
  assert.equal(notAllowed.status, 405)
  assert.equal(notAllowed.json().code, 'method_not_allowed')
})

test('dashboard HTML carries only Credentials + runtime panels and a closed CSP', async t => {
  const host = surface(t)
  const page = await handle(host, 'GET', '/chamber/')
  assert.equal(page.status, 200)
  assert.match(page.headers['content-type'], /^text\/html/)
  assert.equal(page.headers['cache-control'], 'no-store')
  const csp = page.headers['content-security-policy']
  assert.equal(csp.split(';').map(value => value.trim()).find(value => value.startsWith('script-src')), "script-src 'self'")
  const html = page.chunks.join('')
  assert.match(html, /<script defer src="\/chamber\/app\.js"><\/script>/)
  assert.match(html, /id="credentials-title"/)
  assert.match(html, /id="runtime-title"/)
  // 2026-12 strip: no orchestration panels remain.
  assert.doesNotMatch(html, /settings-title|save-settings|setting-git|setting-notifications|setting-schedule/)
  assert.doesNotMatch(html, /approvals-title|sessions-title|schedule-title|worktrees-title/)
  const head = await handle(host, 'HEAD', '/chamber/')
  assert.equal(head.status, 200)
  assert.equal(head.chunks.join(''), '')
})

test('dashboard script parses and carries only credentials + runtime logic', async t => {
  const host = surface(t)
  const script = await handle(host, 'GET', '/chamber/app.js')
  assert.equal(script.status, 200)
  assert.match(script.headers['content-type'], /^application\/javascript/)
  const source = script.chunks.join('')
  assert.doesNotThrow(() => new Function(source), 'the served classic script must parse')
  // Credentials + runtime blocks stay.
  assert.match(source, /AUTH_PATHS\.credentials/)
  assert.match(source, /result\.durability === 'unknown'/,
    'a token published before a durability error is still shown once with an explicit storage warning')
  assert.match(source, /credentials: 'same-origin'/)
  assert.match(source, /RUNTIME_PATHS\.applyNow/)
  assert.match(source, /setInterval\(function \(\) \{ void loadRuntimeStatus\(\); \}, 3000\)/,
    'runtime status keeps polling independently while dsh is down')
  assert.match(source, /row\.phase === 'pending'/)
  assert.match(source, /Applying… restarting/,
    'the activation window renders the honest applying/restarting status copy')
  // 2026-12 strip: orchestration logic is gone (no settings/approvals/
  // sessions/schedule/worktrees loaders, no feature flags, no revision
  // display, no SSE).
  assert.doesNotMatch(source, /loadSettings|saveSettings|applySettings/)
  assert.doesNotMatch(source, /loadApprovals|loadSessions|loadSchedule|loadWorktrees/)
  assert.doesNotMatch(source, /chamber\/approvals|chamber\/schedule|chamber\/sessions|chamber\/git\/worktrees|chamber\/settings/)
  assert.doesNotMatch(source, /enabled !== false/, 'feature flags are gone with the orchestration strip')
  assert.doesNotMatch(source, /revision/, 'the settings revision counter display is removed (2026-12)')
})

test('PWA and mobile assets keep serving', async t => {
  const host = surface(t)
  for (const [path, type] of [
    ['/chamber/manifest.webmanifest', /^application\/manifest\+json/],
    ['/chamber/sw-register.js', /^application\/javascript/],
    ['/chamber/sw.js', /^application\/javascript/],
    ['/chamber/mobile.html', /^text\/html/],
  ] as const) {
    const response = await handle(host, 'GET', path)
    assert.equal(response.status, 200, path)
    assert.match(response.headers['content-type'] ?? '', type, path)
  }
  const notAllowed = await handle(host, 'POST', '/chamber/mobile.html')
  assert.equal(notAllowed.status, 405)
})

test('unknown chamber paths are claimed with a stable 404', async t => {
  const host = surface(t)
  // 2026-12 strip: the removed orchestration routes must not resurrect.
  for (const path of [
    '/chamber/approvals', '/chamber/notifications', '/chamber/schedule',
    '/chamber/sessions', '/chamber/settings', '/chamber/git/worktrees',
    '/chamber/git/worktrees/ws-1', '/chamber/unknown',
  ]) {
    const response = await handle(host, 'GET', path)
    assert.equal(response.status, 404, path)
    assert.deepEqual(response.json(), { error: 'not_found', code: 'not_found' }, path)
  }
})

test('chamber plugins sync caches desktop-provided host packages (2026-12 Phase 3)', async t => {
  const host = surface(t)
  const manifest = JSON.stringify({
    name: '@dsh-chamber/dsh-host-client-graph',
    version: '1.2.3',
    main: 'dist/index.js',
  })
  const artifact = 'export const graph = 1\n'

  const before = await handle(host, 'GET', '/chamber/plugins')
  assert.equal(before.status, 200)
  assert.deepEqual(before.json(), {
    items: [
      { name: '@dsh-chamber/dsh-host-client-graph', version: null },
      { name: '@dsh-chamber/dsh-host-git-worktree', version: null },
    ],
  })

  const upload = (body: unknown): Promise<FakeResponse> => uploadVia(host, body)

  const first = await upload({ name: '@dsh-chamber/dsh-host-client-graph', files: { 'package.json': manifest, 'dist/index.js': artifact } })
  assert.equal(first.status, 200)
  assert.deepEqual(first.json(), { ok: true, changed: true })

  const after = await handle(host, 'GET', '/chamber/plugins')
  assert.deepEqual(after.json(), {
    items: [
      { name: '@dsh-chamber/dsh-host-client-graph', version: '1.2.3' },
      { name: '@dsh-chamber/dsh-host-git-worktree', version: null },
    ],
  })

  // Idempotent re-upload: identical bytes → changed:false, no rewrite.
  const second = await upload({ name: '@dsh-chamber/dsh-host-client-graph', files: { 'package.json': manifest, 'dist/index.js': artifact } })
  assert.deepEqual(second.json(), { ok: true, changed: false })

  // Validation: unknown package / manifest-name mismatch / malformed body.
  const badName = await upload({ name: '@dsh-chamber/dsh-client-ui-mobile', files: { 'package.json': manifest, 'dist/index.js': artifact } })
  assert.equal(badName.status, 400)
  assert.equal(badName.json().code, 'invalid_input')
  const mismatched = await upload({ name: '@dsh-chamber/dsh-host-client-graph', files: { 'package.json': JSON.stringify({ name: 'other', version: '1.0.0' }), 'dist/index.js': artifact } })
  assert.equal(mismatched.status, 400)
  const malformed = await upload({ name: '@dsh-chamber/dsh-host-client-graph', files: { 'package.json': 'not json', 'dist/index.js': artifact } })
  assert.equal(malformed.status, 400)
  assert.equal(malformed.json().code, 'invalid_input')
})

test('chamber plugins upload enforces the body and per-file size bounds', async t => {
  const host = surface(t)
  const manifest = JSON.stringify({
    name: '@dsh-chamber/dsh-host-client-graph',
    version: '1.0.0',
  })
  // Oversized request body (> 8 MiB) → 413 + socket destroy, never drained.
  const oversizedBody = JSON.stringify({
    name: '@dsh-chamber/dsh-host-client-graph',
    files: { 'package.json': manifest, 'dist/index.js': 'x'.repeat(9 * 1024 * 1024) },
  })
  const response = new FakeResponse()
  const request = new UploadRequest()
  const pending = host.handle(request as unknown as ApiRequest, response as unknown as ApiResponse, '/chamber/plugins')
  queueMicrotask(() => {
    request.emit('data', Buffer.from(oversizedBody.slice(0, 5 * 1024 * 1024)))
    request.emit('data', Buffer.from(oversizedBody.slice(5 * 1024 * 1024)))
    request.emit('end')
  })
  await pending
  assert.equal(response.status, 413)
  assert.equal(response.json().code, 'body_too_large')
  assert.equal(request.destroyed, true, 'an oversized upload must destroy the socket, not drain it')
  // Nothing was cached by the rejected upload.
  const after = await handle(host, 'GET', '/chamber/plugins')
  assert.deepEqual(after.json(), {
    items: [
      { name: '@dsh-chamber/dsh-host-client-graph', version: null },
      { name: '@dsh-chamber/dsh-host-git-worktree', version: null },
    ],
  })

  // Per-file caps: manifest > 64 KiB → 400 invalid_input; artifact > 4 MiB → 400.
  const bigManifest = await uploadVia(host, {
    name: '@dsh-chamber/dsh-host-client-graph',
    files: {
      'package.json': JSON.stringify({ name: '@dsh-chamber/dsh-host-client-graph', version: '1.0.0', pad: 'x'.repeat(SYNCED_PACKAGE_MAX_BYTES) }),
      'dist/index.js': 'ok',
    },
  })
  assert.equal(bigManifest.status, 400)
  assert.equal(bigManifest.json().code, 'invalid_input')
  const bigArtifact = await uploadVia(host, {
    name: '@dsh-chamber/dsh-host-client-graph',
    files: {
      'package.json': manifest,
      'dist/index.js': 'x'.repeat(SYNCED_ARTIFACT_MAX_BYTES + 1),
    },
  })
  assert.equal(bigArtifact.status, 400)
  assert.equal(bigArtifact.json().code, 'invalid_input')
})

test('chamber plugins upload maps persistence failures to a coded 500, not 400', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-surface-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const plugins = createChamberPlugins(stateDir, logger)
  const failing = {
    ...plugins,
    // A storage-layer failure (disk full, permissions, …) carries no
    // invalid_input code — the route must answer 500, never 400.
    put: async (): Promise<{ changed: boolean }> => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    },
  }
  const host = createChamberSurface({ logger, channels, plugins: failing })
  const response = new FakeResponse()
  const request = new UploadRequest()
  const pending = host.handle(request as unknown as ApiRequest, response as unknown as ApiResponse, '/chamber/plugins')
  queueMicrotask(() => {
    request.emit('data', Buffer.from(JSON.stringify({
      name: '@dsh-chamber/dsh-host-client-graph',
      files: {
        'package.json': JSON.stringify({ name: '@dsh-chamber/dsh-host-client-graph', version: '1.0.0' }),
        'dist/index.js': 'export const ok = 1\n',
      },
    })))
    request.emit('end')
  })
  await pending
  assert.equal(response.status, 500)
  assert.equal(response.json().code, 'persistence_failed')
})

test('chamber plugins cache lands 0600 files under 0700 dirs and rejects symlinked targets', async t => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-surface-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  const plugins = createChamberPlugins(stateDir, logger)
  const manifest = JSON.stringify({ name: '@dsh-chamber/dsh-host-client-graph', version: '1.0.0' })
  const artifact = 'export const ok = 1\n'
  await plugins.put('@dsh-chamber/dsh-host-client-graph', { 'package.json': manifest, 'dist/index.js': artifact })

  const cacheRoot = join(stateDir, 'chamber-plugins')
  // Cache subdirs use the scope-stripped slug (name minus '@dsh-chamber/').
  const pkgDir = join(cacheRoot, 'dsh-host-client-graph')
  assert.equal(statSync(cacheRoot).mode & 0o777, 0o700)
  assert.equal(statSync(pkgDir).mode & 0o777, 0o700)
  assert.equal(statSync(join(pkgDir, 'dist')).mode & 0o777, 0o700)
  assert.equal(statSync(join(pkgDir, 'package.json')).mode & 0o777, 0o600)
  assert.equal(statSync(join(pkgDir, 'dist', 'index.js')).mode & 0o777, 0o600)

  // No-follow discipline: a symlinked cache target must be rejected, never
  // followed or overwritten through the link.
  const target = join(pkgDir, 'package.json')
  rmSync(target)
  const decoy = join(stateDir, 'decoy.json')
  symlinkSync(decoy, target)
  await assert.rejects(
    () => plugins.put('@dsh-chamber/dsh-host-client-graph', { 'package.json': manifest, 'dist/index.js': artifact }),
  )
  assert.equal(existsSync(decoy), false, 'the decoy must never be written through the link')
})

test('chamber surface asset method edges: HEAD on scripts and 405 on POST /chamber/', async t => {
  const host = surface(t)
  for (const path of ['/chamber/app.js', '/chamber/mobile.html', '/chamber/manifest.webmanifest']) {
    const head = await handle(host, 'HEAD', path)
    assert.equal(head.status, 200, path)
    assert.equal(head.chunks.join(''), '', path)
  }
  const post = await handle(host, 'POST', '/chamber/')
  assert.equal(post.status, 405)
  assert.equal(post.json().code, 'method_not_allowed')
})
