/**
 * Gateway chamber surface (design 17 §8.5, 2026-12 收窄): the gateway-owned
 * `/chamber/*` routes behind the auth gate (dispatch.ts). After the 2026-12
 * orchestration strip (approvals/notifications, cross-session schedule,
 * session index, git worktree records, feature settings all removed — dsh
 * native or design 08 covers them), this surface keeps only:
 *
 *   - `/chamber/channels`        — channel registry projection (MVP empty);
 *   - `/chamber/` + assets       — the browser dashboard (Credentials +
 *                                  dsh runtime management only);
 *   - `/chamber/runtime/*`       — the runtime controller (design 18 §9.3,
 *                                  dispatched separately in dispatch.ts).
 *
 * The dashboard also carries a Credentials panel (design 17 §7) that drives
 * the runtime credential endpoints (/auth/change-password, /auth/change-token,
 * /auth/credentials). It never renders secret values: the rotated token is
 * shown once in a readonly textarea (no innerHTML injection) and cleared after
 * a successful copy.
 *
 * Every route reads/writes gateway-owned state; the authoritative dsh facts
 * stay on dsh — the gateway never becomes authoritative over host business
 * (design 17 §10, chamber discipline).
 */

import {
  type ApiRequest,
  type ApiResponse,
  type Logger,
} from '@dsh-chamber/control-plane'
import type { ChannelRegistry } from './channels.ts'
import type { ChamberPlugins } from './plugins.ts'

export interface ChamberSurfaceDeps {
  logger: Logger
  /** The channel registry (design 17 §2.4; MVP empty). */
  channels: ChannelRegistry
  /** The desktop-synced host-package seed cache (2026-12 Phase 3). */
  plugins: ChamberPlugins
}

export interface ChamberSurface {
  /** Handle a `/chamber/*` request. Returns true when the path was claimed
   * (including a 404 for an unknown /chamber route). */
  handle(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean>
}

function json(res: ApiResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Bounded JSON body reader for the plugin-sync upload (2026-12 Phase 3).
 * Cap: 8 MiB — two host packages, each up to 4 MiB artifact + manifest, as
 * JSON strings. An oversized body is answered 413 and the request socket is
 * destroyed instead of drained (a slow authenticated upload must not pin the
 * connection). */
function readUploadJsonBody(req: ApiRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const MAX = 8 * 1024 * 1024

    const cleanup = (): void => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      req.removeListener('aborted', onAborted)
      req.removeListener('close', onClose)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      chunks.length = 0
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer): void => {
      if (settled) return
      size += chunk.length
      if (size > MAX) {
        fail(Object.assign(new Error('request body exceeds 8 MiB'), { code: 'body_too_large' }))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      if (settled) return
      try {
        const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
        settled = true
        chunks.length = 0
        cleanup()
        resolve(body)
      } catch {
        fail(Object.assign(new Error('request body is not valid JSON'), { code: 'bad_request' }))
      }
    }
    const onError = (): void => fail(Object.assign(new Error('request body stream failed'), { code: 'request_aborted' }))
    const onAborted = (): void => fail(Object.assign(new Error('request body was aborted'), { code: 'request_aborted' }))
    const onClose = (): void => fail(Object.assign(new Error('request body was closed'), { code: 'request_aborted' }))

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
    req.on('close', onClose)
  })
}

// ---------------------------------------------------------------------------
// Gateway-owned browser assets (design 17 D6 / §10/§9). The full dsh frontend
// remains proxied at `/`; `/chamber/` is a deliberately small operations
// surface backed only by gateway-owned routes. 2026-12: the dashboard keeps
// Credentials + dsh runtime management only (feature settings, approvals,
// sessions, schedule and worktree blocks were removed with the orchestration
// strip).
// ---------------------------------------------------------------------------

const CHAMBER_APP_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'"

const CHAMBER_APP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>dsh gateway</title>
  <style>
    :root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0b0f14;color:#e6edf3}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0b0f14}header{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem max(1rem,calc((100vw - 74rem)/2));border-bottom:1px solid #30363d;background:rgba(11,15,20,.96)}
    h1,h2,h3,p{margin:0}h1{font-size:1.15rem}h2{font-size:1rem}h3{font-size:.9rem}.subtle,.status,small{color:#8b949e}.header-actions,.actions{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
    main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;max-width:74rem;margin:0 auto;padding:1rem}.panel{min-width:0;display:flex;flex-direction:column;gap:.75rem;padding:1rem;border:1px solid #30363d;border-radius:.75rem;background:#161b22}.wide{grid-column:1/-1}
    button,a.button{display:inline-flex;align-items:center;justify-content:center;min-height:2rem;padding:.35rem .75rem;border:1px solid #484f58;border-radius:1rem;background:#21262d;color:#e6edf3;font:inherit;font-size:.82rem;text-decoration:none;cursor:pointer}button.primary{border-color:#238636;background:#238636}button.danger{border-color:#da3633;color:#ff7b72}button:disabled{opacity:.5;cursor:default}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #58a6ff;outline-offset:2px}
    fieldset{display:flex;flex-direction:column;gap:.55rem;margin:0;padding:.75rem;border:1px solid #30363d;border-radius:.6rem}legend{padding:0 .3rem;font-weight:600}.toggle,.choice{display:flex;align-items:flex-start;gap:.5rem;font-size:.9rem}.choice small{display:block;margin-top:.15rem}.custom{display:flex;flex-direction:column;gap:.3rem;font-size:.8rem;color:#8b949e}.custom input{width:100%;padding:.45rem .55rem;border:1px solid #484f58;border-radius:.4rem;background:#0d1117;color:#e6edf3}
    select,.text-input{min-height:2rem;padding:.35rem .55rem;border:1px solid #484f58;border-radius:.4rem;background:#0d1117;color:#e6edf3;font:inherit}.runtime-controls{display:grid;grid-template-columns:minmax(12rem,1fr) auto;gap:.55rem}.runtime-controls .actions{grid-column:1/-1}.runtime-registry{display:grid;grid-template-columns:minmax(12rem,1fr) auto;gap:.55rem}.runtime-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem}.runtime-facts .item{padding:.6rem}
    .list{display:flex;flex-direction:column;gap:.6rem}.item{display:flex;flex-direction:column;gap:.35rem;padding:.75rem;border-radius:.55rem;background:#0d1117;overflow-wrap:anywhere}.item-head{display:flex;justify-content:space-between;gap:.75rem;align-items:baseline}.item-head strong{min-width:0}.meta,code{color:#8b949e;font-size:.75rem;overflow-wrap:anywhere;white-space:pre-wrap}.body{font-size:.86rem;white-space:pre-wrap;overflow-wrap:anywhere}.status{min-height:1.2rem;font-size:.8rem}.status.error,.error{color:#ff7b72}.empty{padding:.5rem 0;color:#8b949e;font-size:.85rem}
    .token-reveal{display:flex;flex-direction:column;gap:.5rem}.token-reveal[hidden]{display:none}.token-reveal textarea{width:100%;min-height:6rem;resize:vertical;font-family:ui-monospace,SFMono-Regular,monospace;font-size:.78rem}
    @media(max-width:760px){header{align-items:flex-start}main{grid-template-columns:1fr}.wide{grid-column:auto}.header-actions{justify-content:flex-end}.runtime-controls,.runtime-registry,.runtime-facts{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <header>
    <div><h1>dsh gateway</h1><p class="subtle">Authenticated operations</p></div>
    <div class="header-actions"><a class="button" href="/">Open dsh</a><button id="refresh" type="button">Refresh</button></div>
  </header>
  <main>
    <section class="panel" aria-labelledby="credentials-title">
      <h2 id="credentials-title">Credentials</h2>
      <p id="credentials-status" class="status" role="status">Loading…</p>
      <div class="list">
        <div class="item">
          <div class="item-head"><strong>Password</strong><span id="password-projection" class="meta">—</span></div>
        </div>
        <div class="item">
          <div class="item-head"><strong>Token</strong><span id="token-projection" class="meta">—</span></div>
        </div>
      </div>
      <fieldset>
        <legend>Change password</legend>
        <label class="custom"><span>Current password</span><input id="cred-current-password" class="text-input" type="password" autocomplete="current-password" spellcheck="false"></label>
        <label class="custom"><span>New password (12–1024 characters)</span><input id="cred-new-password" class="text-input" type="password" autocomplete="new-password" spellcheck="false"></label>
        <div class="actions">
          <button id="cred-change-password" type="button">Change password</button>
          <button id="cred-remove-password" class="danger" type="button">Remove password</button>
        </div>
      </fieldset>
      <fieldset>
        <legend>Token</legend>
        <div class="actions">
          <button id="cred-rotate-token" type="button">Rotate token</button>
          <button id="cred-remove-token" class="danger" type="button">Remove token</button>
        </div>
        <div id="cred-token-reveal" class="token-reveal" hidden>
          <p class="status error">Shown once — store it now.</p>
          <textarea id="cred-token-value" rows="4" readonly spellcheck="false"></textarea>
          <div class="actions"><button id="cred-copy-token" type="button">Copy</button></div>
        </div>
      </fieldset>
    </section>
    <section class="panel wide" aria-labelledby="runtime-title">
      <h2 id="runtime-title">dsh runtime</h2>
      <p id="runtime-status" class="status" role="status">Loading…</p>
      <div id="runtime-facts" class="runtime-facts"></div>
      <div class="runtime-controls">
        <label class="custom"><span>Runtime version</span><select id="runtime-version" disabled><option value="">Loading versions…</option></select></label>
        <button id="runtime-select" class="primary" type="button" disabled>Install / select</button>
        <div class="actions">
          <button id="runtime-apply" type="button" disabled>Apply on next start</button>
          <button id="runtime-apply-now" type="button" disabled>Apply now</button>
          <button id="runtime-rollback" type="button" disabled title="Rollback switches to an older installed version">Rollback</button>
          <button id="runtime-restore" type="button" disabled>Restore builtin</button>
          <button id="runtime-retry-apply" type="button" disabled>Retry apply</button>
          <button id="runtime-retry-restore" type="button" disabled>Retry restore</button>
          <button id="runtime-restart" type="button" disabled>Restart dsh</button>
        </div>
      </div>
      <p class="subtle">Switch: select a version, then Apply on next start (installs if needed); Rollback is for installed older versions.</p>
      <p id="runtime-versions-status" class="status" role="status"></p>
      <div class="runtime-registry">
        <label class="custom"><span>Registry origin</span><input id="runtime-registry" class="text-input" type="url" autocomplete="off" spellcheck="false" disabled></label>
        <button id="runtime-registry-save" type="button" disabled>Save registry</button>
      </div>
      <p id="runtime-action-status" class="status" role="status"></p>
    </section>
  </main>
  <script defer src="/chamber/app.js"></script>
</body>
</html>
`

const CHAMBER_APP_JS = `(function () {
  'use strict';
  var runtimeRefreshRunning = false;
  var runtimeActionRunning = false;
  var runtimeSelectionTouched = false;
  var runtimeSnapshot = null;
  // version -> cached flag, refreshed by loadRuntimeVersions (the rollback
  // gate needs the installed-tree info the status projection does not carry).
  var runtimeCachedVersions = {};
  var RUNTIME_PATHS = {
    status: '/chamber/runtime/status',
    versions: '/chamber/runtime/versions',
    select: '/chamber/runtime/select',
    apply: '/chamber/runtime/apply',
    applyNow: '/chamber/runtime/apply-now',
    rollback: '/chamber/runtime/rollback',
    restore: '/chamber/runtime/restore-builtin',
    retryApply: '/chamber/runtime/retry-apply',
    retryRestore: '/chamber/runtime/retry-restore',
    restart: '/chamber/runtime/restart',
    registry: '/chamber/runtime/registry'
  };
  function byId(id) { return document.getElementById(id); }
  function ownRecord(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed ' + label + ' response');
    return value;
  }
  function requiredText(row, key, label) {
    if (typeof row[key] !== 'string' || row[key].length === 0) throw new Error('Malformed ' + label + ' response');
    return row[key];
  }
  function optionalText(row, key, label) {
    if (row[key] === undefined) return undefined;
    if (typeof row[key] !== 'string') throw new Error('Malformed ' + label + ' response');
    return row[key];
  }
  function nullableText(row, key, label) {
    if (row[key] === undefined || row[key] === null) return null;
    if (typeof row[key] !== 'string') throw new Error('Malformed ' + label + ' response');
    return row[key];
  }
  function bounded(value, limit) {
    var text = typeof value === 'string' ? value : String(value);
    return text.length <= limit ? text : text.slice(0, limit) + '…';
  }
  function element(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = bounded(text, 4000);
    if (className) node.className = className;
    return node;
  }
  function status(name, text, failed) {
    var node = byId(name + '-status');
    node.textContent = text;
    node.className = failed ? 'status error' : 'status';
  }
  async function request(path, options) {
    var input = options || {};
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, typeof input.timeoutMs === 'number' ? input.timeoutMs : 15000);
    var hasBody = Object.prototype.hasOwnProperty.call(input, 'body');
    try {
      var response = await fetch(path, {
        method: input.method || 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: Object.assign({ accept: 'application/json' }, hasBody ? { 'content-type': 'application/json' } : {}),
        body: hasBody ? JSON.stringify(input.body) : undefined,
        signal: controller.signal
      });
      var payload;
      try { payload = await response.json(); } catch (_) { payload = undefined; }
      if (!response.ok) {
        var detail = payload !== null && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.error === 'string'
          ? ': ' + bounded(payload.error, 1000) : '';
        var requestError = new Error('Request failed (HTTP ' + response.status + ')' + detail);
        // The wire error code (e.g. 'last_credential', 'rate_limited') lets
        // callers map 400/401/403/409/429/503 to readable messages.
        requestError.code = payload !== null && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.code === 'string'
          ? payload.code : null;
        requestError.httpStatus = response.status;
        throw requestError;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }
  function itemShell(title, meta) {
    var item = element('article', undefined, 'item');
    var head = element('div', undefined, 'item-head');
    head.appendChild(element('strong', title));
    if (meta) head.appendChild(element('span', meta, 'meta'));
    item.appendChild(head);
    return item;
  }
  function appendMeta(item, text) { if (text) item.appendChild(element('code', text)); }

  function formatBytes(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'unknown';
    var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    var size = value; var unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return (unit === 0 ? String(Math.round(size)) : size.toFixed(size >= 10 ? 1 : 2)) + ' ' + units[unit];
  }

  function parseRuntimeStatus(value) {
    var row = ownRecord(value, 'runtime status');
    if (row.kind !== 'dsh-chamber-gateway-runtime') throw new Error('Malformed runtime status identity');
    if (typeof row.phase !== 'string' || typeof row.mutationsAllowed !== 'boolean') throw new Error('Malformed runtime status response');
    return row;
  }

  function runtimeVersion() { return byId('runtime-version').value || null; }

  // SemVer 2.0 precedence for the version dropdown (build metadata ignored;
  // unparseable strings compare equal and keep their stable sort position at
  // the tail — the same policy as the settings-bridge selector). Written
  // regex-free: this is an inline script template, backslash escapes would be
  // consumed by the template literal.
  function semverNumericCompare(a, b) {
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return a === b ? 0 : (a < b ? -1 : 1);
  }
  function semverIsDigits(s) {
    if (s.length === 0) return false;
    for (var i = 0; i < s.length; i += 1) {
      var c = s.charCodeAt(i);
      if (c < 48 || c > 57) return false;
    }
    return true;
  }
  function semverParse(value) {
    var plus = value.indexOf('+');
    if (plus !== -1) value = value.slice(0, plus);
    var dash = value.indexOf('-');
    var core = (dash === -1 ? value : value.slice(0, dash)).split('.');
    if (core.length !== 3) return null;
    var nums = [];
    for (var i = 0; i < 3; i += 1) {
      var part = core[i];
      if (!semverIsDigits(part)) return null;
      if (part.length > 1 && part.charCodeAt(0) === 48) return null; // leading zero
      nums.push(part);
    }
    return { core: nums, prerelease: dash === -1 ? [] : value.slice(dash + 1).split('.') };
  }
  function semverCompare(a, b) {
    var left = semverParse(a), right = semverParse(b);
    if (left === null || right === null) return 0;
    for (var i = 0; i < 3; i += 1) {
      var c = semverNumericCompare(left.core[i], right.core[i]);
      if (c !== 0) return c;
    }
    var lp = left.prerelease, rp = right.prerelease;
    if (lp.length === 0 || rp.length === 0) {
      if (lp.length === rp.length) return 0;
      return lp.length === 0 ? 1 : -1;
    }
    var common = Math.min(lp.length, rp.length);
    for (var j = 0; j < common; j += 1) {
      var x = lp[j], y = rp[j];
      if (x === y) continue;
      var xn = semverIsDigits(x), yn = semverIsDigits(y);
      if (xn && yn) return semverNumericCompare(x, y);
      if (xn !== yn) return xn ? -1 : 1;
      return x < y ? -1 : 1;
    }
    if (lp.length === rp.length) return 0;
    return lp.length < rp.length ? -1 : 1;
  }

  function setRuntimeControls() {
    var row = runtimeSnapshot;
    var selected = runtimeVersion();
    var busy = row === null || runtimeActionRunning || row.phase === 'installing' || row.phase === 'applying' || row.restart === 'running';
    var pendingBlocked = row !== null && row.phase === 'pending';
    var baseMutationBlocked = busy || row.mutationsAllowed !== true || row.source === 'env';
    var mutationBlocked = baseMutationBlocked || pendingBlocked;
    byId('runtime-version').disabled = mutationBlocked;
    byId('runtime-select').disabled = mutationBlocked || selected === null || selected === row.activeVersion;
    byId('runtime-apply').disabled = mutationBlocked || selected === null || selected === row.activeVersion;
    // Apply now (design 18 addendum §5.1): the in-session execution of the
    // armed/staged switch. It is pending's own semantic premise, so the
    // pending terminal gate must NOT disable it (unlike apply). It needs a
    // target that differs from the active version or an armed pending, a
    // serviceable dsh (the route's connection gate), and no recovery phase
    // (those refuse apply-now with runtime_recovery_required). The manager's
    // sync preflight rejects the remaining no-op cases with 409 noop_target.
    // P2 review fix: the enablement must mirror the SERVER's persisted target
    // (row.selectedVersion = override.chosenVersion), NOT the dropdown's local
    // value — a merely highlighted dropdown row has no persisted selection, so
    // preflight would answer 409 noop_target/no_selection for it.
    var recoveryPhase = row !== null && (row.phase === 'swap-attempted' || row.phase === 'snapshot-failed' || row.phase === 'restore-blocked');
    var applyNowBlocked = baseMutationBlocked || recoveryPhase
      || (row.connectionState !== 'ready' && row.connectionState !== 'degraded');
    var applyNowAvailable = row !== null && (row.phase === 'pending' || (row.selectedVersion != null && row.selectedVersion !== row.activeVersion));
    byId('runtime-apply-now').disabled = applyNowBlocked || !applyNowAvailable;
    // Rollback is direction-gated: only a downgrade to an already-installed
    // (cached) version may use the rollback route — the server refuses an
    // upgrade-direction rollback (invalid_target 409), so the UI disables it
    // up front instead of surfacing a 409. The gate mirrors the server's
    // guard: it compares against activeVersion, which IS the effective active
    // version (current pointer ?? builtin anchor — the server's rollback
    // guard and apply()/apply-now manualRollback formula use the same
    // effective version, so a builtin-active downgrade stays enabled and is
    // accepted). Upgrade flows use Install / select + Apply on next start,
    // which installs the target as needed.
    var rollbackTarget = row !== null && selected !== null
      && row.activeVersion !== null && selected !== row.activeVersion
      && semverCompare(selected, row.activeVersion) === -1
      && runtimeCachedVersions[selected] === true;
    byId('runtime-rollback').disabled = mutationBlocked || !rollbackTarget;
    // Design 18 pending terminal gate: restore-builtin is the sole escape.
    // It remains disabled for live install/apply/restart and env/read-only.
    byId('runtime-restore').disabled = baseMutationBlocked || row.hasOverride !== true;
    byId('runtime-retry-apply').disabled = mutationBlocked || (row.phase !== 'swap-attempted' && row.phase !== 'snapshot-failed');
    byId('runtime-retry-restore').disabled = mutationBlocked || row.phase !== 'restore-blocked';
    byId('runtime-restart').disabled = pendingBlocked || busy || (row.connectionState !== 'ready' && row.connectionState !== 'degraded');
    byId('runtime-registry').disabled = mutationBlocked;
    byId('runtime-registry-save').disabled = mutationBlocked || byId('runtime-registry').value.trim().length === 0;
  }

  function renderRuntime(value) {
    var row = parseRuntimeStatus(value);
    runtimeSnapshot = row;
    var active = nullableText(row, 'activeVersion', 'runtime status') || 'unknown';
    var builtin = nullableText(row, 'builtinVersion', 'runtime status') || 'unknown';
    var source = nullableText(row, 'source', 'runtime status') || 'unresolved';
    var connection = nullableText(row, 'connectionState', 'runtime status') || 'unknown';
    // Design 18 addendum §6.3: the activation window (apply-now / startup /
    // restore-builtin) is an honest in-session restart — the status line says
    // so instead of the bare phase label.
    var phaseText = row.phase === 'applying' ? 'Applying… restarting' : row.phase;
    var summary = 'Active v' + active + ' · builtin v' + builtin + ' · ' + source + ' · ' + phaseText + ' · ' + connection;
    var failed = row.operationError || row.startupBlockedReason || row.registryError;
    status('runtime', summary + (failed ? ' — ' + bounded(failed, 1000) : ''), Boolean(failed));

    var fragment = document.createDocumentFragment();
    var progress = row.progress !== null && typeof row.progress === 'object' ? row.progress : null;
    if (progress) {
      var progressText = 'Stage: ' + bounded(progress.stage, 50);
      if (progress.stage === 'download' && typeof progress.received === 'number') {
        progressText += ' · ' + formatBytes(progress.received) + (typeof progress.total === 'number' ? ' / ' + formatBytes(progress.total) : '');
      }
      fragment.appendChild(itemShell('Install progress', progressText));
    }
    var snapshotMeta = typeof row.snapshotCount === 'number' ? String(row.snapshotCount) + ' snapshot(s)' : 'unavailable';
    if (typeof row.latestSnapshotAt === 'string') snapshotMeta += ' · latest ' + new Date(row.latestSnapshotAt).toLocaleString();
    if (typeof row.preRollbackCount === 'number') snapshotMeta += ' · ' + String(row.preRollbackCount) + ' rollback stash(es)';
    if (typeof row.restoreOutcome === 'string') snapshotMeta += ' · restore ' + bounded(row.restoreOutcome, 40);
    var snapshotCard = itemShell('Data snapshots', snapshotMeta);
    if (row.snapshotError) snapshotCard.appendChild(element('p', row.snapshotError, 'error'));
    if (row.restoreInProgress === true) snapshotCard.appendChild(element('p', 'Restore is incomplete; recovery evidence is retained.', 'error'));
    fragment.appendChild(snapshotCard);
    if (row.failure !== null && typeof row.failure === 'object') {
      var failure = ownRecord(row.failure, 'runtime failure');
      var failureCard = itemShell('Latest failure: v' + requiredText(failure, 'version', 'runtime failure'), nullableText(failure, 'at', 'runtime failure'));
      failureCard.appendChild(element('p', requiredText(failure, 'reason', 'runtime failure'), 'error'));
      fragment.appendChild(failureCard);
    }
    if (row.diskUsage !== null && typeof row.diskUsage === 'object') {
      var disk = ownRecord(row.diskUsage, 'runtime disk usage');
      var diskCard = itemShell('Runtime disk', formatBytes(disk.totalBytes));
      appendMeta(diskCard, String(disk.versionTrees) + ' tree(s) · snapshots ' + formatBytes(disk.snapshotBytes) + ' · recovery/failures ' + formatBytes((disk.preRollbackBytes || 0) + (disk.restoreBackupBytes || 0) + (disk.failureBytes || 0)));
      if (row.diskLimitExceeded === true) diskCard.appendChild(element('p', 'The logical disk soft limit has been reached; new downloads are paused.', 'error'));
      fragment.appendChild(diskCard);
    } else if (row.diskError) {
      var diskError = itemShell('Runtime disk', 'unavailable'); diskError.appendChild(element('p', row.diskError, 'error')); fragment.appendChild(diskError);
    }
    byId('runtime-facts').replaceChildren(fragment);
    if (typeof row.registry === 'string' && document.activeElement !== byId('runtime-registry')) byId('runtime-registry').value = row.registry;
    setRuntimeControls();
  }

  async function loadRuntimeStatus() {
    try { renderRuntime(await request(RUNTIME_PATHS.status)); }
    catch (error) {
      runtimeSnapshot = null;
      status('runtime', error instanceof Error ? error.message : 'Runtime status unavailable', true);
      setRuntimeControls();
    }
  }

  async function loadRuntimeVersions() {
    try {
      var payload = ownRecord(await request(RUNTIME_PATHS.versions), 'runtime versions');
      if (!Array.isArray(payload.versions)) throw new Error('Malformed runtime versions response');
      var rows = payload.versions.map(function (value) {
        var row = ownRecord(value, 'runtime version');
        return { version: requiredText(row, 'version', 'runtime version'), cached: row.cached === true };
      });
      // Pure semver descending order, mirroring the settings-bridge selector
      // (design 18 §3.6 A.2 decision 11: no 'latest' recommendation badge —
      // the data flag is still projected, just not displayed). The active
      // version is identified by the 'current' marker, not by pinning.
      rows.sort(function (a, b) { return semverCompare(b.version, a.version); });
      runtimeCachedVersions = {};
      rows.forEach(function (row) { runtimeCachedVersions[row.version] = row.cached; });
      var select = byId('runtime-version');
      var previous = runtimeSelectionTouched ? select.value : '';
      var active = runtimeSnapshot ? runtimeSnapshot.activeVersion : null;
      var fragment = document.createDocumentFragment();
      rows.forEach(function (row) {
        var option = document.createElement('option'); option.value = row.version;
        option.textContent = 'v' + row.version
          + (active !== null && row.version === active ? ' · current' : '')
          + (row.cached ? ' · cached' : '');
        fragment.appendChild(option);
      });
      select.replaceChildren(fragment);
      var preferred = previous || (runtimeSnapshot && (runtimeSnapshot.selectedVersion || runtimeSnapshot.activeVersion));
      if (preferred && Array.from(select.options).some(function (option) { return option.value === preferred; })) select.value = preferred;
      status('runtime-versions', typeof payload.error === 'string' ? payload.error : String(payload.versions.length) + ' version(s)', typeof payload.error === 'string');
      setRuntimeControls();
    } catch (error) { status('runtime-versions', error instanceof Error ? error.message : 'Runtime versions unavailable', true); }
  }

  async function runtimeAction(path, body, label) {
    if (runtimeActionRunning) return;
    runtimeActionRunning = true; setRuntimeControls(); status('runtime-action', label + '…', false);
    try {
      await request(path, { method: 'POST', timeoutMs: 11 * 60 * 1000, ...(body === undefined ? {} : { body: body }) });
      status('runtime-action', label + ' accepted.', false);
      await Promise.allSettled([loadRuntimeStatus(), loadRuntimeVersions()]);
    } catch (error) {
      status('runtime-action', error instanceof Error ? error.message : label + ' failed', true);
    } finally { runtimeActionRunning = false; setRuntimeControls(); }
  }

  async function saveRuntimeRegistry() {
    if (runtimeActionRunning) return;
    runtimeActionRunning = true; setRuntimeControls(); status('runtime-action', 'Saving registry…', false);
    try {
      await request(RUNTIME_PATHS.registry, { method: 'PUT', body: { origin: byId('runtime-registry').value.trim() } });
      status('runtime-action', 'Registry saved.', false); await Promise.allSettled([loadRuntimeStatus(), loadRuntimeVersions()]);
    } catch (error) { status('runtime-action', error instanceof Error ? error.message : 'Registry save failed', true); }
    finally { runtimeActionRunning = false; setRuntimeControls(); }
  }

  async function refreshRuntime() {
    if (runtimeRefreshRunning) return;
    runtimeRefreshRunning = true;
    try { await Promise.allSettled([loadRuntimeStatus(), loadRuntimeVersions()]); }
    finally { runtimeRefreshRunning = false; }
  }

  var credentialSnapshot = { password: null, token: null };
  var AUTH_PATHS = {
    credentials: '/auth/credentials',
    changePassword: '/auth/change-password',
    changeToken: '/auth/change-token'
  };
  function credentialErrorText(error) {
    var code = error && error.code;
    switch (code) {
      case 'bad_request': return 'Invalid input — check the entered values.';
      case 'invalid_credentials': return 'The current password is missing or incorrect.';
      case 'ambient_principal_rejected': return 'Enter the current password to change gateway credentials.';
      case 'last_credential': return 'Cannot remove the last credential — configure a replacement first.';
      case 'rate_limited': return 'Too many attempts — try again later.';
      case 'auth_busy': return 'The authentication service is busy — try again shortly.';
      case 'body_too_large': return 'Request too large.';
      default: return error instanceof Error ? error.message : 'Credentials operation failed';
    }
  }
  function credentialProjectionEntry(value, label) {
    if (value === null || value === undefined) return null;
    var record = ownRecord(value, label);
    if (record.set !== true || (record.source !== 'config' && record.source !== 'runtime')
      || typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) throw new Error('Malformed credential projection response');
    return { source: record.source, updatedAt: record.updatedAt };
  }
  function renderCredentials(value) {
    var row = ownRecord(value, 'credentials');
    var password = credentialProjectionEntry(row.password, 'credential projection');
    var token = credentialProjectionEntry(row.token, 'credential projection');
    credentialSnapshot = { password: password, token: token };
    function projectionLine(entry) {
      if (entry === null) return 'Not configured';
      return 'Configured (source: ' + entry.source + ') · ' + new Date(entry.updatedAt).toLocaleString()
        + (entry.source === 'runtime' ? ' (runtime-managed)' : '');
    }
    byId('password-projection').textContent = projectionLine(password);
    byId('token-projection').textContent = projectionLine(token);
  }
  async function loadCredentials() {
    status('credentials', 'Loading…', false);
    try {
      renderCredentials(await request(AUTH_PATHS.credentials));
      status('credentials', 'Ready', false);
    } catch (error) { status('credentials', error instanceof Error ? error.message : 'Credentials unavailable', true); }
  }
  var tokenRevealTimer = null;
  function hideTokenReveal() {
    if (tokenRevealTimer !== null) { clearTimeout(tokenRevealTimer); tokenRevealTimer = null; }
    byId('cred-token-reveal').hidden = true;
    byId('cred-token-value').value = '';
  }
  async function changePassword() {
    var next = byId('cred-new-password').value;
    if (next.length < 12) { status('credentials', 'New password must be at least 12 characters.', true); return; }
    if (next.length > 1024) { status('credentials', 'New password must be at most 1024 characters.', true); return; }
    // Pre-check the current password when one is configured (a cookie-only
    // session must prove it; an empty submit would burn server rate-limit
    // quota on the scrypt verify).
    if (credentialSnapshot.password !== null && byId('cred-current-password').value.length === 0) {
      status('credentials', 'Enter the current password to change the gateway password.', true);
      return;
    }
    hideTokenReveal();
    status('credentials', 'Changing password…', false);
    try {
      await request(AUTH_PATHS.changePassword, { method: 'POST', body: { currentPassword: byId('cred-current-password').value, newPassword: next } });
      byId('cred-new-password').value = '';
      await loadCredentials();
      status('credentials', 'Password changed.', false);
    } catch (error) { status('credentials', credentialErrorText(error), true); }
  }
  async function removePassword() {
    if (credentialSnapshot.password === null) { status('credentials', 'No password is configured — nothing to remove.', true); return; }
    if (!window.confirm('Remove the gateway password? The password login is invalidated immediately.')) return;
    var current = byId('cred-current-password').value;
    if (current.length === 0) { status('credentials', 'Enter the current password to remove the gateway password.', true); return; }
    hideTokenReveal();
    status('credentials', 'Removing password…', false);
    try {
      await request(AUTH_PATHS.changePassword, { method: 'POST', body: { remove: true, currentPassword: current } });
      // A config-managed credential is re-seeded on the next restart — say
      // so instead of implying a permanent removal (design 17 §7.4 seeding).
      var wasConfigManaged = credentialSnapshot.password !== null && credentialSnapshot.password.source === 'config';
      byId('cred-current-password').value = '';
      await loadCredentials();
      status('credentials', wasConfigManaged
        ? 'Password removed for now — it is managed by deployment config and will be re-seeded on the next gateway restart.'
        : 'Password removed.', false);
    } catch (error) { status('credentials', credentialErrorText(error), true); }
  }
  async function rotateToken() {
    if (credentialSnapshot.password !== null && byId('cred-current-password').value.length === 0) {
      status('credentials', 'Enter the current password to rotate the token.', true);
      return;
    }
    hideTokenReveal();
    status('credentials', 'Rotating token…', false);
    try {
      // The change-token proof gate requires a non-ambient principal: a
      // cookie-only browser session must supply the current password when a
      // password is configured (otherwise 403 ambient_principal_rejected).
      var result = ownRecord(await request(AUTH_PATHS.changeToken, { method: 'POST', body: { currentPassword: byId('cred-current-password').value } }), 'token change');
      var token = typeof result.token === 'string' && result.token.length > 0 ? result.token : null;
      if (token === null) throw new Error('Malformed token change response');
      var durabilityUnknown = result.durability === 'unknown';
      byId('cred-token-value').value = token;
      byId('cred-token-reveal').hidden = false;
      // Defense in depth: the one-time token also auto-clears after 60s even
      // if the operator never copies it (the session cookie is the only
      // ambient exposure; this shrinks that window).
      if (tokenRevealTimer !== null) clearTimeout(tokenRevealTimer);
      tokenRevealTimer = setTimeout(hideTokenReveal, 60000);
      await loadCredentials();
      status('credentials', durabilityUnknown
        ? 'Token rotated and shown once, but disk durability could not be confirmed — save it now and rotate again after checking storage.'
        : 'Token rotated — shown once, store it now.', durabilityUnknown);
    } catch (error) { status('credentials', credentialErrorText(error), true); }
  }
  async function removeToken() {
    if (credentialSnapshot.token === null) { status('credentials', 'No token is configured — nothing to remove.', true); return; }
    if (credentialSnapshot.password === null) {
      status('credentials', 'This gateway has no password; remove the token from a bearer-token client instead.', true);
      return;
    }
    if (!window.confirm('Remove the gateway token? Authenticated API and desktop clients are disconnected immediately.')) return;
    var current = byId('cred-current-password').value;
    if (current.length === 0) { status('credentials', 'Enter the current password to remove the gateway token.', true); return; }
    hideTokenReveal();
    status('credentials', 'Removing token…', false);
    try {
      await request(AUTH_PATHS.changeToken, { method: 'POST', body: { remove: true, currentPassword: current } });
      // A config-managed credential is re-seeded on the next restart — say
      // so instead of implying a permanent removal (design 17 §7.4 seeding).
      var wasConfigManaged = credentialSnapshot.token !== null && credentialSnapshot.token.source === 'config';
      byId('cred-current-password').value = '';
      await loadCredentials();
      status('credentials', wasConfigManaged
        ? 'Token removed for now — it is managed by deployment config and will be re-seeded on the next gateway restart.'
        : 'Token removed.', false);
    } catch (error) { status('credentials', credentialErrorText(error), true); }
  }
  function copyToken() {
    var textarea = byId('cred-token-value');
    if (textarea.value.length === 0) return;
    textarea.focus();
    textarea.select();
    var copied = false;
    try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
    if (copied) {
      status('credentials', 'Token copied — cleared from this page.', false);
      hideTokenReveal();
    } else {
      status('credentials', 'Copy failed — select the token text manually, then store it.', true);
    }
  }

  byId('runtime-version').addEventListener('change', function () { runtimeSelectionTouched = true; setRuntimeControls(); });
  byId('runtime-registry').addEventListener('input', setRuntimeControls);
  byId('runtime-select').addEventListener('click', function () {
    var version = runtimeVersion(); if (version) void runtimeAction(RUNTIME_PATHS.select, { version: version }, 'Runtime install/select');
  });
  byId('runtime-apply').addEventListener('click', function () { void runtimeAction(RUNTIME_PATHS.apply, undefined, 'Runtime apply'); });
  // Apply now: same single-flight runtimeAction machinery — POST returns 202
  // and the accepted handler reloads status/versions, then the 3s poll keeps
  // showing the applying window until the transaction settles.
  byId('runtime-apply-now').addEventListener('click', function () { void runtimeAction(RUNTIME_PATHS.applyNow, undefined, 'Apply now'); });
  byId('runtime-rollback').addEventListener('click', function () {
    var version = runtimeVersion(); if (version) void runtimeAction(RUNTIME_PATHS.rollback, { version: version }, 'Runtime rollback');
  });
  byId('runtime-restore').addEventListener('click', function () { void runtimeAction(RUNTIME_PATHS.restore, undefined, 'Builtin restore'); });
  byId('runtime-retry-apply').addEventListener('click', function () { void runtimeAction(RUNTIME_PATHS.retryApply, undefined, 'Apply retry'); });
  byId('runtime-retry-restore').addEventListener('click', function () { void runtimeAction(RUNTIME_PATHS.retryRestore, undefined, 'Restore retry'); });
  byId('runtime-restart').addEventListener('click', function () { void runtimeAction(RUNTIME_PATHS.restart, undefined, 'dsh restart'); });
  byId('runtime-registry-save').addEventListener('click', function () { void saveRuntimeRegistry(); });
  byId('cred-change-password').addEventListener('click', function () { void changePassword(); });
  byId('cred-remove-password').addEventListener('click', function () { void removePassword(); });
  byId('cred-rotate-token').addEventListener('click', function () { void rotateToken(); });
  byId('cred-remove-token').addEventListener('click', function () { void removeToken(); });
  byId('cred-copy-token').addEventListener('click', copyToken);
  byId('refresh').addEventListener('click', function () { void Promise.allSettled([refreshRuntime(), loadCredentials()]); });
  void Promise.allSettled([refreshRuntime(), loadCredentials()]);
  setInterval(function () { void loadRuntimeStatus(); }, 3000);
}());
`

const MANIFEST_WEBMANIFEST = JSON.stringify({
  name: 'dsh gateway',
  short_name: 'dsh',
  start_url: '/',
  display: 'standalone',
  background_color: '#0b0f14',
  theme_color: '#0b0f14',
})

const SW_REGISTER_JS = `// dsh gateway service-worker registration (design 17 §9, P4).
// No-op for now: registers an empty worker so the PWA installs and later
// offline/cache behavior can be added without changing the registration point.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/chamber/sw.js').catch(() => {})
}
`

const MOBILE_HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh gateway</title>
<style>body{font-family:system-ui;background:#0b0f14;color:#e6edf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}</style>
<main style="text-align:center;padding:2rem">
  <h1>dsh gateway</h1>
  <p>Mobile light surface (design 17 §9, P4).</p>
  <!-- The ?desktop=1 escape hatch is the shunting loop exit (dispatch.ts
       4.5): without it a mobile UA would be redirected right back here. -->
  <p><a href="/?desktop=1" style="color:#58a6ff">Open the full dsh frontend →</a></p>
</main>
`

/** Serve a gateway-owned static asset at a /chamber/* path. */
function serveAsset(
  res: ApiResponse,
  contentType: string,
  body: string,
  head: boolean,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
    ...extraHeaders,
  })
  res.end(head ? undefined : body)
}

function isAssetMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD'
}

function methodNotAllowed(res: ApiResponse): true {
  json(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
  return true
}

/**
 * The gateway's own `/chamber/*` surface (design 17 §8.5, 2026-12 scope):
 * channels projection + plugin-sync seed cache + browser dashboard assets.
 * Every route is read-only (GET/HEAD) except PUT /chamber/plugins — a
 * synchronous, atomic cache write that completes before its route tail
 * settles (the credential-mutation drain tracks the credential/runtime
 * writers; the plugin sync has no async tail, so no mutation admission fence
 * is needed — the 2026-12 orchestration strip removed the last async
 * /chamber writers (schedule/worktree/settings)).
 */
export function createChamberSurface(deps: ChamberSurfaceDeps): ChamberSurface {
  const { channels, logger } = deps
  async function handleRoute(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean> {
    // /chamber/channels: the channel registry projection (§7; MVP empty).
    if (pathname === '/chamber/channels') {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
        return true
      }
      json(res, 200, { items: channels.list() })
      return true
    }

    // /chamber/plugins (2026-12 Phase 3): the desktop-synced host-package
    // seed cache. GET = non-secret projection (name + version); PUT = upload
    // one syncable host package (validated + atomically cached; the next dsh
    // spawn re-seeds from the cache, and the syncing desktop triggers the
    // controlled /chamber/runtime/restart to refresh the running profile).
    if (pathname === '/chamber/plugins' || pathname === '/chamber/plugins/') {
      if (req.method === 'GET') {
        json(res, 200, { items: deps.plugins.list() })
        return true
      }
      if (req.method === 'PUT') {
        try {
          const body = (await readUploadJsonBody(req)) as { name?: unknown; files?: unknown }
          const name = typeof body?.name === 'string' ? body.name : null
          if (name === null || body?.files === null || typeof body?.files !== 'object' || Array.isArray(body.files)) {
            json(res, 400, { error: 'invalid_input', code: 'invalid_input' })
            return true
          }
          const files = body.files as Record<string, unknown>
          const packageJson = typeof files['package.json'] === 'string' ? files['package.json'] : null
          const distIndex = typeof files['dist/index.js'] === 'string' ? files['dist/index.js'] : null
          if (packageJson === null || distIndex === null) {
            json(res, 400, { error: 'invalid_input', code: 'invalid_input' })
            return true
          }
          const outcome = await deps.plugins.put(name, { 'package.json': packageJson, 'dist/index.js': distIndex })
          json(res, 200, { ok: true, changed: outcome.changed })
        } catch (error) {
          const code = (error as { code?: unknown })?.code
          if (code === 'body_too_large') {
            json(res, 413, { error: 'body_too_large', code: 'body_too_large' })
            req.destroy?.()
            return true
          }
          if (code === 'bad_request') {
            json(res, 400, { error: 'bad_request', code: 'bad_request' })
            return true
          }
          if (code === 'request_aborted') return true
          if (code === 'invalid_input') {
            json(res, 400, { error: 'invalid_input', code: 'invalid_input' })
            return true
          }
          // Any other throw is a persistence failure (fs write, permissions,
          // disk full …) — the client must be able to distinguish "your input
          // was bad" from "the gateway could not write" (proxy honesty).
          logger.warn(`chamber-plugins: persistence failure: ${String(error)}`)
          json(res, 500, { error: 'persistence_failed', code: 'persistence_failed' })
          return true
        }
        return true
      }
      json(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
      return true
    }

    // Gateway-owned browser operations surface (design 17 D6 / §10).
    // It is already behind dispatch.ts's mandatory auth gate. The document
    // uses an external same-origin script so the control-plane CSP can keep
    // inline script closed; neither asset accepts credentials in its URL.
    if (pathname === '/chamber/') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'text/html; charset=utf-8', CHAMBER_APP_HTML, req.method === 'HEAD', {
        'content-security-policy': CHAMBER_APP_CSP,
      })
      return true
    }
    if (pathname === '/chamber/app.js') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'application/javascript; charset=utf-8', CHAMBER_APP_JS, req.method === 'HEAD')
      return true
    }

    // P4 static assets (design 17 §10/§9): PWA manifest + SW registration +
    // mobile light surface + the (empty) service worker.
    if (pathname === '/chamber/manifest.webmanifest') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'application/manifest+json', MANIFEST_WEBMANIFEST, req.method === 'HEAD')
      return true
    }
    if (pathname === '/chamber/sw-register.js') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'application/javascript', SW_REGISTER_JS, req.method === 'HEAD')
      return true
    }
    if (pathname === '/chamber/sw.js') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'application/javascript', '/* dsh gateway service worker (empty) */\n', req.method === 'HEAD')
      return true
    }
    if (pathname === '/chamber/mobile.html') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'text/html; charset=utf-8', MOBILE_HTML, req.method === 'HEAD')
      return true
    }

    // Unknown /chamber/* → 404 (claimed, so the default dispatch does not run).
    json(res, 404, { error: 'not_found', code: 'not_found' })
    return true
  }

  // Everything on this surface is read-only; a stale-but-authenticated
  // request can still read. No mutation admission fence exists (2026-12).
  void logger
  void channels

  return {
    async handle(req, res, pathname): Promise<boolean> {
      return handleRoute(req, res, pathname)
    },
  }
}
