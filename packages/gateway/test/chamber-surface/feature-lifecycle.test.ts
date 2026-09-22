/**
 * Chamber-surface tests (design 17 §10): the gateway's own `/chamber/*`
 * operations surface — channels projection + plugin-sync seed cache + browser
 * dashboard assets (Credentials + dsh runtime management only).
 *
 * The dashboard's two credential-removal gates run in the page's own
 * confirmation dialog (no native confirm). The
 * served markup/script contract is asserted here AND the served script is
 * executed against the DOM/fetch harness in dashboard-harness.ts, so the
 * cancel/confirm semantics are covered behaviourally rather than by text.
 *
 * The suite locks the modal's reachability for the WHOLE armed lifetime —
 * including the pending window, where both controls are disabled — through the
 * harness's emulated Tab move (`pressKey` performs the browser's own focus
 * move unless the page prevented it). The busy flag stays off the live
 * region's ancestor. Request paths are asserted as a SET per scenario, because
 * the responder's throw for an unexpected path is swallowed by the page's own
 * catch.
 *
 * Run directly: node packages/gateway/test/chamber-surface/feature-lifecycle.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transformSync } from 'esbuild'
import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'
import { createChamberPlugins, SYNCED_ARTIFACT_MAX_BYTES, SYNCED_PACKAGE_MAX_BYTES } from '../../src/plugins.ts'
import { createChamberInstalled } from '../../src/plugins-installed.ts'
import { createChamberSurface } from '../../src/routes.ts'
import { createDashboardHarness, type DashboardHarness, type DashboardRequest } from '../support/dashboard-harness.ts'
import { seedCacheProjection } from '../support/chamber-surface-fixtures.ts'
import { FakeResponse, stubPluginTasks } from '../support/utils.ts'
import { handleChamberSurface, makeChamberSurfaceHarness, surfaceSilentLogger, surfaceStubChannels } from '../support/chamber-surface-harness.ts'

// Shared harness: one logger, channel stub, surface factory and transport
// runner for the chamber-surface suites.
const logger = surfaceSilentLogger
const channels = surfaceStubChannels

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
  return makeChamberSurfaceHarness(t).surface
}

const handle = handleChamberSurface

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
  assert.match(html, /^<!doctype html>/, 'the app page keeps its doctype')
  assert.match(html, /<script defer src="\/chamber\/app\.js"><\/script>/)
  assert.equal((html.match(/<script/g) ?? []).length, 1, 'exactly one script tag')
  assert.ok(html.trimEnd().endsWith('</html>'), 'the app page is a complete document')
  assert.match(html, /id="credentials-title"/)
  assert.match(html, /id="runtime-title"/)
  // No orchestration panels.
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
  assert.ok(source.startsWith('(function () {'), 'the script stays one IIFE')
  // The served bytes keep the interpolated comparators and stay safely
  // inlinable.
  assert.match(source, /semverNumericCompare/, 'the interpolated comparator landed')
  assert.match(source, /semverCompare/, 'the interpolated comparator landed')
  assert.equal(source.includes('${'), false, 'no un-interpolated template slot survives')
  assert.equal(source.includes('DASHBOARD_SEMVER_JS'), false, 'the helper name is not leaked into the asset')
  assert.equal(source.includes('</script'), false, 'the script stays safely inlinable')
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
  // No orchestration logic: no settings/approvals/sessions/schedule/worktrees
  // loaders, no feature flags, no revision display, no SSE.
  assert.doesNotMatch(source, /loadSettings|saveSettings|applySettings/)
  assert.doesNotMatch(source, /loadApprovals|loadSessions|loadSchedule|loadWorktrees/)
  assert.doesNotMatch(source, /chamber\/approvals|chamber\/schedule|chamber\/sessions|chamber\/git\/worktrees|chamber\/settings/)
  assert.doesNotMatch(source, /enabled !== false/, 'feature flags are gone with the orchestration strip')
  assert.doesNotMatch(source, /revision/, 'the settings revision counter display is removed (2026-12)')
})

// ---------------------------------------------------------------------------
// In-page confirmation dialog
// ---------------------------------------------------------------------------

/** Comment-stripped source, using the repo's canonical stripper (esbuild — the
 * same tool verify-upstream-touchpoints C10 strips comments with), so a "no
 * native confirm" scan reads CODE only: a comment naming that API can neither
 * trip the scan nor hide a real call. esbuild REPRINTS what it strips
 * (quote style changes), so this output is used for absence/token scans only —
 * copy and call-shape assertions read the served text. */
function stripped(source: string, loader: 'js' | 'ts'): string {
  return transformSync(source, { loader, legalComments: 'none' }).code
}

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

/** Every path the page requests while it boots and renders the credentials /
 *  runtime panels. A scenario's allowed set is this baseline plus the removal
 *  path it actually drives. */
const BASELINE_PATHS = ['/auth/credentials', '/chamber/runtime/status', '/chamber/runtime/versions'] as const

/** The elements Tab may hold while the confirmation dialog is open. */
const DIALOG_FOCUS_IDS = new Set(['confirm-dialog', 'confirm-cancel', 'confirm-accept'])

/** The page-behind controls that must stay unreachable during the pending
 *  window: the header link, Refresh, and the credential/runtime
 *  controls — #cred-change-password among them, a POST gate with no
 *  confirmation of its own. */
const BACKGROUND_FOCUS_IDS = new Set([
  'open-dsh', 'refresh', 'cred-current-password', 'cred-new-password', 'cred-change-password',
  'cred-remove-password', 'cred-rotate-token', 'cred-remove-token', 'cred-token-value',
  'runtime-version', 'runtime-select', 'runtime-apply', 'runtime-apply-now', 'runtime-rollback',
  'runtime-restore', 'runtime-retry-apply', 'runtime-retry-restore', 'runtime-restart',
  'runtime-start', 'runtime-registry', 'runtime-registry-save',
])

/** The requests a scenario may issue, and nothing else: the responder throws
 *  for an unexpected path, but the page's own catch turns that into a status
 *  line — so the RECORDED set is what has to be asserted, not the responder's
 *  reaction to it. */
function assertOnlyPaths(page: DashboardHarness, allowed: readonly string[]): void {
  for (const path of new Set(page.requests.map(request => request.path))) {
    assert.ok(allowed.includes(path), 'the page issued an unexpected request: ' + path)
  }
}

/** Boot the SERVED dashboard script (harness.ts) with the configured
 * credentials of `configured`, and fill the current-password proof field.
 * Removal requests are held so the pending window stays observable — unless
 * `answerRemoval` takes them over, which is how the failure path below runs
 * the page's own error handling. */
async function dashboardWithCredentials(
  t: { after(fn: () => void): void },
  configured: { password: boolean; token: boolean } = { password: true, token: true },
  answerRemoval?: (request: DashboardRequest) => unknown,
) {
  const host = surface(t)
  const html = (await handle(host, 'GET', '/chamber/')).chunks.join('')
  const script = (await handle(host, 'GET', '/chamber/app.js')).chunks.join('')
  const page = createDashboardHarness({
    html,
    script,
    hold: answerRemoval === undefined ? [REMOVAL_PATHS.password, REMOVAL_PATHS.token] : [],
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
        if (answerRemoval !== undefined) return answerRemoval(request)
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
  assert.match(html, /id="confirm-dialog" class="panel dialog" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description"/)
  assert.match(html, /<p id="confirm-pending" class="status" role="status" aria-live="polite"><\/p>/)
  assert.match(html, /<button id="confirm-cancel" type="button">Cancel<\/button>/)
  assert.match(html, /<button id="confirm-accept" class="danger" type="button"><\/button>/)
  // The two background landmarks carry ids (the script makes them inert), the
  // dialog container is the pending focus target, and the busy flag has its own
  // row so it never sits on an ancestor of the live region.
  assert.match(html, /<header id="page-header">/)
  assert.match(html, /<main id="page-main">/)
  assert.match(html, /<div id="confirm-actions" class="actions">/)
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
  // The gate copy and the exact POST bodies are asserted behaviorally through
  // the executed page (remove password :334-335/:373-374, token :416-418/:433-434).

  // Every id the script addresses literally exists in the served markup — the
  // same contract the DOM harness enforces while it drives the script.
  const addressed = new Set([...script.matchAll(/byId\('([^']+)'\)/g)].map(match => match[1]))
  assert.ok(addressed.size >= 20, 'the id contract check must actually walk the script')
  for (const id of addressed) assert.ok(html.includes('id="' + id + '"'), 'missing markup id: ' + id)
})

test('remove password: cancel performs nothing, confirm issues exactly one request (2026-09-11 upstream-alignment T2)', async t => {
  const { page } = await dashboardWithCredentials(t)
  const path = REMOVAL_PATHS.password
  const invoke = 'cred-remove-password'

  // Arming shows the gate's copy in the page's own dialog (one sentence split
  // into the dialog's title + description).
  page.click(invoke)
  assert.equal(page.byId('confirm-title').textContent, 'Remove the gateway password?')
  assert.equal(page.byId('confirm-description').textContent, 'The password login is invalidated immediately.')
  assert.equal(page.byId('confirm-accept').textContent, 'Remove password')
  assert.equal(page.byId('confirm-accept').className, 'danger',
    'the destructive button carries the page danger styling')
  assert.equal(page.byId('confirm-pending').textContent, '')
  assert.equal(page.byId('confirm-actions').getAttribute('aria-busy'), null)
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
  // The busy flag rides the actions row. On the dialog element it would sit on
  // an ANCESTOR of #confirm-pending, and AT may
  // ignore changes inside a busy subtree — swallowing the pending announcement
  // this same task just wrote.
  assert.equal(page.byId('confirm-actions').getAttribute('aria-busy'), 'true')
  assert.equal(page.byId('confirm-dialog').getAttribute('aria-busy'), null,
    'the busy flag must never sit on an ancestor of the live region it accompanies')
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
  assert.equal(page.byId('confirm-actions').getAttribute('aria-busy'), null)
  assertOnlyPaths(page, [...BASELINE_PATHS, path])
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
  assert.equal(page.byId('confirm-actions').getAttribute('aria-busy'), 'true')
  assert.equal(page.byId('confirm-dialog').getAttribute('aria-busy'), null)

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
  assertOnlyPaths(page, BASELINE_PATHS)
})

test('a failed removal reports the mapped failure copy and closes the dialog (2026-09-11 review-fix F4b)', async t => {
  // The harness's spy answers 200 for every request it does not hold, so
  // `answerRemoval` supplies the error the page's own request() builds for a
  // non-ok response — an Error carrying the wire code — and the page's catch
  // has to map it to operator copy.
  const { page, configured } = await dashboardWithCredentials(t, { password: true, token: true }, () => {
    throw Object.assign(new Error('Request failed (HTTP 401)'), { code: 'invalid_credentials' })
  })
  const path = REMOVAL_PATHS.password

  page.click('cred-remove-password')
  page.click('confirm-accept')
  await page.settle()
  assert.equal(page.requestsTo(path).length, 1, 'exactly one POST reached the wire')
  assert.equal(page.dialogOpen(), false, 'the dialog never outlives the action it announced')
  assert.equal(page.byId('credentials-status').textContent,
    'The current password is missing or incorrect.',
    'the wire code is mapped to operator copy, not echoed as a raw failure')
  assert.equal(page.byId('credentials-status').className, 'status error',
    'the failure rides the page status styling')
  assert.match(page.byId('password-projection').textContent, /^Configured \(source: runtime\)/,
    'a refused removal changes nothing')
  assert.equal(configured.password, true)
  assert.equal(page.activeElementId(), 'cred-remove-password',
    'focus comes back to the invoking control after a failure too')
  assertOnlyPaths(page, [...BASELINE_PATHS, path])
})

// ---------------------------------------------------------------------------
// The modal's reachability, pending window included
// ---------------------------------------------------------------------------
test('the dialog keeps the page behind out of reach for its whole armed lifetime (2026-09-11 review-fix F1)', async t => {
  const { page } = await dashboardWithCredentials(t)
  const path = REMOVAL_PATHS.password
  const invoke = 'cred-remove-password'

  // Positive control for every assertion below: the harness's Tab really does
  // walk the document's tab order, and the first two stops ARE the escape
  // routes — the header link and Refresh. Without this, "Tab
  // never reached the page behind" would hold for a harness that moved no
  // focus at all.
  assert.equal(page.activeElementId(), null, 'nothing is focused after boot')
  page.pressKey('Tab')
  assert.equal(page.activeElementId(), 'open-dsh', 'the harness walks the document tab order')
  page.pressKey('Tab')
  assert.equal(page.activeElementId(), 'refresh')

  // Armed: aria-modal="true" is enforced, not merely claimed — both background
  // landmarks are inert, so the header link, Refresh, the credential controls
  // (including #cred-change-password, which has no gate of its own) and every
  // runtime control are out of the tab order, the accessibility tree and
  // pointer reach.
  page.click(invoke)
  assert.equal(page.dialogOpen(), true)
  assert.equal(page.byId('page-header').getAttribute('inert'), '')
  assert.equal(page.byId('page-main').getAttribute('inert'), '')
  assert.equal(page.activeElementId(), 'confirm-cancel')
  // The trap cycles the dialog's two controls — through the harness's real Tab
  // move, which lands on #open-dsh instead when the page does not trap.
  page.pressKey('Tab')
  assert.equal(page.activeElementId(), 'confirm-accept')
  page.pressKey('Tab')
  assert.equal(page.activeElementId(), 'confirm-cancel')
  page.pressKey('Tab', { shiftKey: true })
  assert.equal(page.activeElementId(), 'confirm-accept')

  // Accepted: the action is on the wire and unanswered, both controls are
  // disabled, and the browser hands focus to <body> — the window in which an
  // untrapped Tab would walk the page behind, exactly while a scrypt verify or
  // a store write has the operator waiting.
  page.click('confirm-accept')
  await page.settle()
  assert.equal(page.requestsTo(path).length, 1, 'the accepted action is on the wire and unanswered')
  assert.equal(page.byId('confirm-accept').disabled, true)
  assert.equal(page.byId('confirm-cancel').disabled, true)
  assert.equal(page.activeElementId(), null,
    'disabling the focused control hands focus to <body>, where an untrapped Tab starts walking')
  assert.equal(page.byId('page-header').getAttribute('inert'), '')
  assert.equal(page.byId('page-main').getAttribute('inert'), '')

  // The union that matters: no Tab step may hand focus to the page behind —
  // the walk that reached #open-dsh and #refresh a moment ago.
  for (let step = 0; step < 6; step += 1) {
    page.pressKey('Tab')
    const reached = page.activeElementId()
    assert.ok(!BACKGROUND_FOCUS_IDS.has(reached ?? ''),
      'Tab reached the page behind the modal (step ' + step + ': ' + String(reached) + ')')
  }
  page.pressKey('Tab', { shiftKey: true })
  assert.ok(!BACKGROUND_FOCUS_IDS.has(page.activeElementId() ?? ''),
    'Shift+Tab reached the page behind the modal')

  // The shipped contract is stronger than that union: focus stays INSIDE the
  // dialog. inert and the trap are both kept on purpose — inert is the
  // enforcement a browser honours, the trap is the portable equivalent for an
  // engine without inert support and for a Tab that starts on the container —
  // so this asserts the pair rather than either mechanism alone.
  page.pressKey('Tab')
  assert.equal(page.activeElementId(), 'confirm-dialog',
    'with both controls disabled, Tab lands on the dialog container (tabindex="-1")')
  assert.ok(DIALOG_FOCUS_IDS.has(page.activeElementId() ?? ''))

  // The dialog is still the only live surface, and closing it hands the
  // background and the focus back together.
  page.pressKey('Escape')
  page.click('confirm-cancel')
  assert.equal(page.dialogOpen(), true, 'a dismiss stays ignored while the action runs')
  assert.equal(page.requestsTo(path).length, 1)

  await page.release()
  assert.equal(page.dialogOpen(), false)
  assert.equal(page.byId('page-header').getAttribute('inert'), null,
    'the background comes back when the dialog closes')
  assert.equal(page.byId('page-main').getAttribute('inert'), null)
  assert.equal(page.activeElementId(), invoke,
    'focus returns to the invoking button — inert is lifted first, so it can take focus')
  assertOnlyPaths(page, [...BASELINE_PATHS, path])

  // And the handed-back page really is reachable again: with no dialog listener
  // left, Tab walks on to the next control of the credentials panel.
  page.pressKey('Tab')
  assert.equal(page.activeElementId(), 'cred-rotate-token',
    'a closed dialog no longer holds the keyboard')
})

test('mobile entry asset keeps serving', async t => {
  const host = surface(t)
  // The PWA trio (manifest.webmanifest / sw-register.js / sw.js) is not served
  // — it has no consumer — and the mobile light surface is the one asset the
  // mobile-UA shunting serves.
  for (const [path, type] of [
    ['/chamber/mobile.html', /^text\/html/],
  ] as const) {
    const response = await handle(host, 'GET', path)
    assert.equal(response.status, 200, path)
    assert.match(response.headers['content-type'] ?? '', type, path)
  }
  // The served mobile surface keeps its doctype, viewport meta and desktop
  // escape hatch.
  const mobileHtml = (await handle(host, 'GET', '/chamber/mobile.html')).chunks.join('')
  assert.match(mobileHtml, /^<!doctype html>/, 'the mobile surface keeps its doctype')
  assert.match(mobileHtml, /name="viewport"/, 'the mobile surface keeps its viewport meta')
  assert.match(mobileHtml, /\/\?desktop=1/, 'the mobile escape hatch is preserved (dispatch.ts 4.5)')
  const notAllowed = await handle(host, 'POST', '/chamber/mobile.html')
  assert.equal(notAllowed.status, 405)
})

test('unknown chamber paths are claimed with a stable 404', async t => {
  const host = surface(t)
  // The orchestration routes stay unclaimed.
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
  assert.deepEqual(before.json(), seedCacheProjection())

  const upload = (body: unknown): Promise<FakeResponse> => uploadVia(host, body)

  const first = await upload({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', files: { 'package.json': manifest, 'dist/index.js': artifact } })
  assert.equal(first.status, 200)
  assert.deepEqual(first.json(), { ok: true, changed: true })

  const after = await handle(host, 'GET', '/chamber/plugins')
  assert.deepEqual(after.json(), seedCacheProjection({ '@dsh-chamber/dsh-chamber-seed-client-graph': '1.2.3' }))

  // Idempotent re-upload: identical bytes → changed:false, no rewrite.
  const second = await upload({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', files: { 'package.json': manifest, 'dist/index.js': artifact } })
  assert.deepEqual(second.json(), { ok: true, changed: false })

  // Validation: unknown package / manifest-name mismatch / malformed body.
  const badName = await upload({ name: '@dsh-chamber/dsh-client-ui-mobile', files: { 'package.json': manifest, 'dist/index.js': artifact } })
  assert.equal(badName.status, 400)
  assert.equal(badName.json().code, 'invalid_input')
  // …and the echoed REASON must still name the refused package: the scoped name
  // is path-shaped, so it is redacted into `[path]` unless the route keeps it —
  // the desktop must be able to tell which package was refused.
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
  assert.deepEqual(after.json(), seedCacheProjection())

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
  for (const path of ['/chamber/app.js', '/chamber/mobile.html']) {
    const head = await handle(host, 'HEAD', path)
    assert.equal(head.status, 200, path)
    assert.equal(head.chunks.join(''), '', path)
  }
  const post = await handle(host, 'POST', '/chamber/')
  assert.equal(post.status, 405)
  assert.equal(post.json().code, 'method_not_allowed')
})
