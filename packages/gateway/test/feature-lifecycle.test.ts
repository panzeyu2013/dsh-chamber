/**
 * Chamber-surface tests (design 17 §10, 2026-12 strip): the gateway's own
 * `/chamber/*` operations surface — channels projection + plugin-sync seed
 * cache + browser dashboard assets (Credentials + dsh runtime management
 * only). The orchestration
 * routes (git worktrees, approvals/notifications, schedule, session index,
 * feature settings) were removed with the feature host; dsh native or
 * design 08 covers them.
 *
 * 2026-09-11 upstream-alignment T2: the dashboard's two credential-removal
 * gates run in the page's own confirmation dialog (no native confirm). The
 * served markup/script contract is asserted here AND the served script is
 * executed against the DOM/fetch harness in dashboard-harness.ts, so the
 * cancel/confirm semantics are covered behaviourally rather than by text.
 *
 * Run directly: node packages/gateway/test/feature-lifecycle.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'
import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'
import { createChamberPlugins, SYNCED_ARTIFACT_MAX_BYTES, SYNCED_PACKAGE_MAX_BYTES } from '../src/plugins.ts'
import { createChamberInstalled } from '../src/plugins-installed.ts'
import { createChamberSurface } from '../src/routes.ts'
import { createDashboardHarness, type DashboardHarness } from './dashboard-harness.ts'
import { FakeRequest, FakeResponse, stubPluginTasks } from './utils.ts'

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
  const installed = createChamberInstalled(stateDir)
  return createChamberSurface({ logger, channels, plugins, installed, tasks: stubPluginTasks(), stateDir })
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

// ---------------------------------------------------------------------------
// In-page confirmation dialog (2026-09-11 upstream-alignment T2)
// ---------------------------------------------------------------------------

/** Comment-stripped source, using the repo's canonical stripper (esbuild — the
 * same tool verify-upstream-touchpoints C10 strips comments with), so a "no
 * native confirm" scan reads CODE only: a comment naming the removed API can
 * neither trip the scan nor hide a real call. esbuild REPRINTS what it strips
 * (quote style changes), so this output is used for absence/token scans only —
 * copy and call-shape assertions read the served text. */
function stripped(source: string, loader: 'js' | 'ts'): string {
  return transformSync(source, { loader, legalComments: 'none' }).code
}

const GATEWAY_SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** One credential projection entry: the shape the page validates. */
function credentialProjection(configured: boolean): unknown {
  return configured ? { set: true, source: 'runtime', updatedAt: 1_760_000_000_000 } : null
}

/** The minimal runtime status `parseRuntimeStatus` accepts. The tests below
 * drive the credentials flow; the runtime panel only has to boot cleanly. */
const RUNTIME_STATUS = {
  kind: 'dsh-chamber-gateway-runtime',
  phase: 'idle',
  mutationsAllowed: true,
  activeVersion: '0.1.5-rc.1',
  builtinVersion: '0.1.5-rc.1',
  source: 'builtin',
  connectionState: 'ready',
  selectedVersion: null,
  hasOverride: false,
  progress: null,
  snapshotCount: 0,
  diskUsage: null,
  diskError: null,
  failure: null,
  registry: 'https://registry.npmjs.org/',
  operationError: null,
  startupBlockedReason: null,
  registryError: null,
  snapshotError: null,
  restoreInProgress: false,
}

const REMOVAL_PATHS = { password: '/auth/change-password', token: '/auth/change-token' } as const

/** Boot the SERVED dashboard script (harness.ts) with the configured
 * credentials of `configured`, and fill the current-password proof field.
 * Removal requests are held so the pending window stays observable. */
async function dashboardWithCredentials(
  t: { after(fn: () => void): void },
  configured: { password: boolean; token: boolean } = { password: true, token: true },
) {
  const host = surface(t)
  const html = (await handle(host, 'GET', '/chamber/')).chunks.join('')
  const script = (await handle(host, 'GET', '/chamber/app.js')).chunks.join('')
  const page = createDashboardHarness({
    html,
    script,
    hold: [REMOVAL_PATHS.password, REMOVAL_PATHS.token],
    respond: request => {
      if (request.path === '/auth/credentials') {
        return {
          password: credentialProjection(configured.password),
          token: credentialProjection(configured.token),
        }
      }
      if (request.path === '/chamber/runtime/status') return RUNTIME_STATUS
      if (request.path === '/chamber/runtime/versions') return { versions: [] }
      const removal = request.path === REMOVAL_PATHS.password ? 'password' : 'token'
      if ((request.path === REMOVAL_PATHS.password || request.path === REMOVAL_PATHS.token)
        && request.body?.remove === true) {
        configured[removal] = false
        return { changed: true, kind: removal, removed: true }
      }
      throw new Error('unexpected request: ' + request.method + ' ' + request.path)
    },
  })
  await page.settle()
  page.byId('cred-current-password').value = 'current-secret'
  return { page, host, configured }
}

/** Arm the gate and dismiss it: the dialog must perform NOTHING (no request)
 * and hand focus back to the invoking button. */
async function assertDismissPerformsNothing(
  page: DashboardHarness,
  invokeId: string,
  path: string,
  dismiss: () => void,
): Promise<void> {
  const before = page.requestsTo(path).length
  page.click(invokeId)
  assert.equal(page.dialogOpen(), true)
  assert.equal(page.activeElementId(), 'confirm-cancel',
    'focus moves into the dialog, onto the least destructive control')
  assert.equal(page.requestsTo(path).length, before, 'arming the dialog issues no request')
  dismiss()
  assert.equal(page.dialogOpen(), false)
  assert.equal(page.activeElementId(), invokeId, 'focus returns to the invoking button')
  await page.settle()
  assert.equal(page.requestsTo(path).length, before, 'a dismiss performs nothing')
}

test('the served dashboard gates credential removal on an in-page dialog and carries no native confirm (2026-09-11 upstream-alignment T2)', async t => {
  const host = surface(t)
  const html = (await handle(host, 'GET', '/chamber/')).chunks.join('')
  const script = (await handle(host, 'GET', '/chamber/app.js')).chunks.join('')

  // The dialog is the PAGE's own markup: the role/aria contract plus the
  // existing panel/danger/status vocabulary (no second visual language).
  assert.match(html, /<div id="confirm-backdrop" class="dialog-backdrop" hidden>/)
  assert.match(html, /id="confirm-dialog" class="panel dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description"/)
  assert.match(html, /<p id="confirm-pending" class="status" role="status" aria-live="polite"><\/p>/)
  assert.match(html, /<button id="confirm-cancel" type="button">Cancel<\/button>/)
  assert.match(html, /<button id="confirm-accept" class="danger" type="button"><\/button>/)
  // Title and description start EMPTY by design: the script fills them through
  // textContent, so interpolated copy is never parsed as HTML.
  assert.match(html, /<h2 id="confirm-title"><\/h2>/)
  assert.match(html, /<p id="confirm-description" class="body"><\/p>/)

  // Comment-stripped: no native confirmation survives in the served code …
  const code = stripped(script, 'js')
  assert.doesNotMatch(code, /window\s*\.\s*confirm/)
  assert.doesNotMatch(code, /(^|[^.\w$])confirm\s*\(/m)
  // … and BOTH removal gates go through that dialog.
  assert.equal((code.match(/armConfirmDialog\(\{/g) ?? []).length, 2,
    'exactly the two credential-removal gates arm the dialog')
  assert.match(script, /AUTH_PATHS\.changePassword, \{ method: 'POST', body: \{ remove: true, currentPassword: current \} \}/)
  assert.match(script, /AUTH_PATHS\.changeToken, \{ method: 'POST', body: \{ remove: true, currentPassword: current \} \}/)
  assert.match(script, /title: 'Remove the gateway password\?'/)
  assert.match(script, /description: 'The password login is invalidated immediately\.'/)
  assert.match(script, /title: 'Remove the gateway token\?'/)
  assert.match(script, /description: 'Authenticated API and desktop clients are disconnected immediately\.'/)

  // Every id the script addresses literally exists in the served markup — the
  // same contract the DOM harness enforces while it drives the script.
  const addressed = new Set([...script.matchAll(/byId\('([^']+)'\)/g)].map(match => match[1]))
  assert.ok(addressed.size >= 20, 'the id contract check must actually walk the script')
  for (const id of addressed) assert.ok(html.includes('id="' + id + '"'), 'missing markup id: ' + id)
})

test('no gateway source file calls a native confirm (2026-09-11 upstream-alignment T2)', () => {
  const files = readdirSync(GATEWAY_SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.ts'))
  assert.ok(files.length >= 20, 'the scan must actually walk the gateway src tree')
  for (const file of files) {
    const code = stripped(readFileSync(join(GATEWAY_SRC_DIR, file), 'utf8'), 'ts')
    assert.doesNotMatch(code, /window\s*\.\s*confirm/, file)
    assert.doesNotMatch(code, /(^|[^.\w$])confirm\s*\(/m, file)
  }
})

test('remove password: cancel performs nothing, confirm issues exactly one request (2026-09-11 upstream-alignment T2)', async t => {
  const { page } = await dashboardWithCredentials(t)
  const path = REMOVAL_PATHS.password
  const invoke = 'cred-remove-password'

  // Arming shows the gate's copy in the page's own dialog (the native gate's
  // one sentence split into the dialog's title + description).
  page.click(invoke)
  assert.equal(page.byId('confirm-title').textContent, 'Remove the gateway password?')
  assert.equal(page.byId('confirm-description').textContent, 'The password login is invalidated immediately.')
  assert.equal(page.byId('confirm-accept').textContent, 'Remove password')
  assert.equal(page.byId('confirm-accept').className, 'danger',
    'the destructive button carries the page danger styling')
  assert.equal(page.byId('confirm-pending').textContent, '')
  assert.equal(page.byId('confirm-dialog').getAttribute('aria-busy'), null)
  assert.equal(page.activeElementId(), 'confirm-cancel')
  page.click('confirm-cancel')

  // Cancel, Escape and a mask click all dismiss without performing anything.
  await assertDismissPerformsNothing(page, invoke, path, () => page.click('confirm-cancel'))
  await assertDismissPerformsNothing(page, invoke, path, () => page.pressKey('Escape'))
  await assertDismissPerformsNothing(page, invoke, path, () => page.click('confirm-backdrop'))

  // The dialog is the ONLY thing that reaches the wire: the
  // empty-current-password proof still runs AFTER the gate (the native gate's
  // order) and issues nothing.
  page.byId('cred-current-password').value = ''
  page.click(invoke)
  page.click('confirm-accept')
  await page.release()
  assert.equal(page.byId('credentials-status').textContent,
    'Enter the current password to remove the gateway password.')
  assert.equal(page.dialogOpen(), false, 'the dialog closes when the refused action returns')
  assert.equal(page.requestsTo(path).length, 0, 'a refused proof issues no request')

  // Confirm: exactly one request, an announced pending state, and a dialog
  // that stays put until the action settles.
  page.byId('cred-current-password').value = 'current-secret'
  page.click(invoke)
  page.click('confirm-accept')
  // A same-frame double click launches nothing more: the control is disabled,
  // and an accept that reaches the handler directly is single-flight.
  page.click('confirm-accept')
  page.byId('confirm-accept').emit('click')
  await page.settle()
  const issued = page.requestsTo(path)
  assert.equal(issued.length, 1, 'confirm issues exactly one request')
  assert.equal(issued[0].method, 'POST')
  assert.deepEqual(issued[0].body, { remove: true, currentPassword: 'current-secret' })
  assert.equal(page.byId('confirm-pending').textContent, 'Removing password…',
    'the pending state is announced on the dialog role="status" line')
  assert.equal(page.byId('credentials-status').textContent, 'Removing password…',
    'the page status line keeps reporting the same busy copy')
  assert.equal(page.byId('confirm-dialog').getAttribute('aria-busy'), 'true')
  assert.equal(page.byId('confirm-accept').disabled, true)
  assert.equal(page.byId('confirm-cancel').disabled, true)
  assert.equal(page.byId('confirm-accept').textContent, 'Removing password…')
  // Dismissing the progress surface is ignored — no implied cancellation.
  page.pressKey('Escape')
  page.click('confirm-cancel')
  assert.equal(page.dialogOpen(), true)
  assert.equal(page.requestsTo(path).length, 1)

  // Settled: the dialog closes, focus returns, and the existing success
  // reporting is unchanged.
  await page.release()
  assert.equal(page.dialogOpen(), false)
  assert.equal(page.activeElementId(), invoke, 'focus returns to the invoking button')
  assert.equal(page.byId('credentials-status').textContent, 'Password removed.')
  assert.equal(page.byId('password-projection').textContent, 'Not configured')
  assert.equal(page.byId('cred-current-password').value, '')
  assert.equal(page.byId('confirm-pending').textContent, '', 'the dialog is cleared for the next arm')
  assert.equal(page.byId('confirm-accept').textContent, '')
  assert.equal(page.byId('confirm-dialog').getAttribute('aria-busy'), null)
})

test('remove token: cancel performs nothing, confirm issues exactly one request (2026-09-11 upstream-alignment T2)', async t => {
  const { page } = await dashboardWithCredentials(t)
  const path = REMOVAL_PATHS.token
  const invoke = 'cred-remove-token'

  page.click(invoke)
  assert.equal(page.dialogOpen(), true)
  assert.equal(page.byId('confirm-title').textContent, 'Remove the gateway token?')
  assert.equal(page.byId('confirm-description').textContent,
    'Authenticated API and desktop clients are disconnected immediately.')
  assert.equal(page.byId('confirm-accept').textContent, 'Remove token')
  assert.equal(page.byId('confirm-accept').className, 'danger')
  page.click('confirm-cancel')

  await assertDismissPerformsNothing(page, invoke, path, () => page.click('confirm-cancel'))
  await assertDismissPerformsNothing(page, invoke, path, () => page.pressKey('Escape'))
  await assertDismissPerformsNothing(page, invoke, path, () => page.click('confirm-backdrop'))

  page.click(invoke)
  page.click('confirm-accept')
  page.click('confirm-accept')
  await page.settle()
  const issued = page.requestsTo(path)
  assert.equal(issued.length, 1, 'confirm issues exactly one request')
  assert.equal(issued[0].method, 'POST')
  assert.deepEqual(issued[0].body, { remove: true, currentPassword: 'current-secret' })
  assert.equal(page.byId('confirm-pending').textContent, 'Removing token…')
  assert.equal(page.byId('confirm-dialog').getAttribute('aria-busy'), 'true')

  await page.release()
  assert.equal(page.dialogOpen(), false)
  assert.equal(page.activeElementId(), invoke)
  assert.equal(page.byId('credentials-status').textContent, 'Token removed.')
  assert.equal(page.byId('token-projection').textContent, 'Not configured')
})

test('the credential-removal guards still refuse before the dialog opens (2026-09-11 upstream-alignment T2)', async t => {
  const { page } = await dashboardWithCredentials(t, { password: false, token: true })
  // A token removal without a configured password has no proof surface …
  page.click('cred-remove-token')
  assert.equal(page.dialogOpen(), false, 'the refusal must not open the dialog')
  assert.equal(page.byId('credentials-status').textContent,
    'This gateway has no password; remove the token from a bearer-token client instead.')
  assert.deepEqual(page.requestsTo(REMOVAL_PATHS.token), [])
  // … and there is nothing to remove when the password is already gone.
  page.click('cred-remove-password')
  assert.equal(page.dialogOpen(), false)
  assert.equal(page.byId('credentials-status').textContent, 'No password is configured — nothing to remove.')
  assert.deepEqual(page.requestsTo(REMOVAL_PATHS.password), [])
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
    name: '@dsh-chamber/dsh-chamber-seed-client-graph',
    version: '1.2.3',
    main: 'dist/index.js',
  })
  const artifact = 'export const graph = 1\n'

  const before = await handle(host, 'GET', '/chamber/plugins')
  assert.equal(before.status, 200)
  assert.deepEqual(before.json(), {
    items: [
      { name: '@dsh-chamber/dsh-chamber-seed-client-graph', version: null },
      { name: '@dsh-chamber/dsh-chamber-seed-git-worktree', version: null },
      { name: '@dsh-chamber/dsh-chamber-seed-archive-cleanup', version: null },
      // The projection is REGISTRY-DERIVED, so a new host package row appears
      // here without a gateway edit. The open-in row (design 20 §6) is
      // `localOnly`: it is in the derived whitelist but the desktop never
      // uploads it, so its cache — and therefore its version — stays absent.
      { name: '@dsh-chamber/dsh-chamber-seed-open-in', version: null },
    ],
  })

  const upload = (body: unknown): Promise<FakeResponse> => uploadVia(host, body)

  const first = await upload({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', files: { 'package.json': manifest, 'dist/index.js': artifact } })
  assert.equal(first.status, 200)
  assert.deepEqual(first.json(), { ok: true, changed: true })

  const after = await handle(host, 'GET', '/chamber/plugins')
  assert.deepEqual(after.json(), {
    items: [
      { name: '@dsh-chamber/dsh-chamber-seed-client-graph', version: '1.2.3' },
      { name: '@dsh-chamber/dsh-chamber-seed-git-worktree', version: null },
      { name: '@dsh-chamber/dsh-chamber-seed-archive-cleanup', version: null },
      { name: '@dsh-chamber/dsh-chamber-seed-open-in', version: null },
    ],
  })

  // Idempotent re-upload: identical bytes → changed:false, no rewrite.
  const second = await upload({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', files: { 'package.json': manifest, 'dist/index.js': artifact } })
  assert.deepEqual(second.json(), { ok: true, changed: false })

  // Validation: unknown package / manifest-name mismatch / malformed body.
  const badName = await upload({ name: '@dsh-chamber/dsh-client-ui-mobile', files: { 'package.json': manifest, 'dist/index.js': artifact } })
  assert.equal(badName.status, 400)
  assert.equal(badName.json().code, 'invalid_input')
  // …and the echoed REASON must still name the refused package: the scoped name
  // is path-shaped, so it is redacted into `[path]` unless the route keeps it
  // (2026-09 audit — the desktop saw `"@dsh-chamber[path]` and could not tell
  // which package the old gateway refused).
  assert.match(String(badName.json().error), /"@dsh-chamber\/dsh-client-ui-mobile"/)
  assert.doesNotMatch(String(badName.json().error), /\[path\]/)
  const mismatched = await upload({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', files: { 'package.json': JSON.stringify({ name: 'other', version: '1.0.0' }), 'dist/index.js': artifact } })
  assert.equal(mismatched.status, 400)
  const malformed = await upload({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', files: { 'package.json': 'not json', 'dist/index.js': artifact } })
  assert.equal(malformed.status, 400)
  assert.equal(malformed.json().code, 'invalid_input')
})

test('chamber plugins upload enforces the body and per-file size bounds', async t => {
  const host = surface(t)
  const manifest = JSON.stringify({
    name: '@dsh-chamber/dsh-chamber-seed-client-graph',
    version: '1.0.0',
  })
  // Oversized request body (> 8 MiB) → 413 + socket destroy, never drained.
  const oversizedBody = JSON.stringify({
    name: '@dsh-chamber/dsh-chamber-seed-client-graph',
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
      { name: '@dsh-chamber/dsh-chamber-seed-client-graph', version: null },
      { name: '@dsh-chamber/dsh-chamber-seed-git-worktree', version: null },
      { name: '@dsh-chamber/dsh-chamber-seed-archive-cleanup', version: null },
      // The projection is REGISTRY-DERIVED, so a new host package row appears
      // here without a gateway edit. The open-in row (design 20 §6) is
      // `localOnly`: it is in the derived whitelist but the desktop never
      // uploads it, so its cache — and therefore its version — stays absent.
      { name: '@dsh-chamber/dsh-chamber-seed-open-in', version: null },
    ],
  })

  // Per-file caps: manifest > 64 KiB → 400 invalid_input; artifact > 4 MiB → 400.
  const bigManifest = await uploadVia(host, {
    name: '@dsh-chamber/dsh-chamber-seed-client-graph',
    files: {
      'package.json': JSON.stringify({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', version: '1.0.0', pad: 'x'.repeat(SYNCED_PACKAGE_MAX_BYTES) }),
      'dist/index.js': 'ok',
    },
  })
  assert.equal(bigManifest.status, 400)
  assert.equal(bigManifest.json().code, 'invalid_input')
  const bigArtifact = await uploadVia(host, {
    name: '@dsh-chamber/dsh-chamber-seed-client-graph',
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
  const host = createChamberSurface({
    logger,
    channels,
    plugins: failing,
    installed: createChamberInstalled(stateDir),
    tasks: stubPluginTasks(),
    stateDir,
  })
  const response = new FakeResponse()
  const request = new UploadRequest()
  const pending = host.handle(request as unknown as ApiRequest, response as unknown as ApiResponse, '/chamber/plugins')
  queueMicrotask(() => {
    request.emit('data', Buffer.from(JSON.stringify({
      name: '@dsh-chamber/dsh-chamber-seed-client-graph',
      files: {
        'package.json': JSON.stringify({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', version: '1.0.0' }),
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
  const manifest = JSON.stringify({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', version: '1.0.0' })
  const artifact = 'export const ok = 1\n'
  await plugins.put('@dsh-chamber/dsh-chamber-seed-client-graph', { 'package.json': manifest, 'dist/index.js': artifact })

  const cacheRoot = join(stateDir, 'chamber-plugins')
  // Cache subdirs use the scope-stripped slug (name minus '@dsh-chamber/').
  const pkgDir = join(cacheRoot, 'dsh-chamber-seed-client-graph')
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
    () => plugins.put('@dsh-chamber/dsh-chamber-seed-client-graph', { 'package.json': manifest, 'dist/index.js': artifact }),
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
