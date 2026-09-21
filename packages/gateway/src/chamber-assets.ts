/**
 * Gateway browser-app assets (2026-12 audit F2 split): the embedded control
 * panel HTML, its script and the mobile light surface, moved verbatim out of
 * routes.ts. The only interpolation is the dashboard semver helper source
 * (chamber-dashboard-semver.ts), whose template-safety is pinned by the
 * dashboard-semver lockstep test.
 */
import { DASHBOARD_SEMVER_JS } from './chamber-dashboard-semver.ts'

export const CHAMBER_APP_HTML = `<!doctype html>
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
    /* 2026-09-11 upstream-alignment T2: the confirmation dialog reuses this page's panel/actions/status vocabulary (.panel + .actions + .danger); only the modal shell is new. */
    .dialog-backdrop{position:fixed;inset:0;z-index:3;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgba(1,4,9,.72)}.dialog-backdrop[hidden]{display:none}.dialog{width:min(30rem,100%);max-height:calc(100vh - 2rem);overflow:auto}.dialog .actions{justify-content:flex-end}
    @media(max-width:760px){header{align-items:flex-start}main{grid-template-columns:1fr}.wide{grid-column:auto}.header-actions{justify-content:flex-end}.runtime-controls,.runtime-registry,.runtime-facts{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <header id="page-header">
    <div><h1>dsh gateway</h1><p class="subtle">Authenticated operations</p></div>
    <div class="header-actions"><a id="open-dsh" class="button" href="/">Open dsh</a><button id="refresh" type="button">Refresh</button></div>
  </header>
  <main id="page-main">
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
          <button id="runtime-start" type="button" disabled title="Bring the managed dsh back up (start applies to a stopped / error / restart-exhausted runtime)">Start dsh</button>
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
  <!-- 2026-09-11 upstream-alignment T2: this page's own confirmation dialog.
       The two credential removals below used to gate on the browser's native
       confirmation popup, whose OS chrome cannot ride this page's vocabulary,
       reads as an alien layer over it, and is not localizable — the same
       reason the chamber's other admin surfaces were converted. The title and
       description are deliberately empty here: app.js fills them through
       textContent, so no interpolated copy is ever parsed as HTML.
       2026-09-11 review-fix F1/F2: the two background landmarks carry ids so
       the script can make them inert for the dialog's whole armed lifetime
       (aria-modal="true" is a promise the page has to keep, not a claim); the
       dialog container carries tabindex="-1" as the focus target while an
       accepted action runs and both controls are disabled; and the busy flag
       rides the actions row (#confirm-actions), never an ancestor of the
       #confirm-pending live region, whose announcement a busy subtree may
       swallow. -->
  <div id="confirm-backdrop" class="dialog-backdrop" hidden>
    <div id="confirm-dialog" class="panel dialog" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
      <h2 id="confirm-title"></h2>
      <p id="confirm-description" class="body"></p>
      <p id="confirm-pending" class="status" role="status" aria-live="polite"></p>
      <div id="confirm-actions" class="actions">
        <button id="confirm-cancel" type="button">Cancel</button>
        <button id="confirm-accept" class="danger" type="button"></button>
      </div>
    </div>
  </div>
  <script defer src="/chamber/app.js"></script>
</body>
</html>
`

export const CHAMBER_APP_JS = `(function () {
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
    start: '/chamber/runtime/start',
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

  // SemVer 2.0 precedence for the version dropdown. ONE local source of the
  // rules (chamber-dashboard-semver.ts; 2026-12 audit F8), interpolated here
  // verbatim: build metadata is ignored, unparseable strings compare equal and
  // keep their stable sort position at the tail — the same policy as the
  // settings-bridge selector. A lockstep test pins the shared dsh-runtime
  // conclusions for valid semver.
${DASHBOARD_SEMVER_JS}

  function setRuntimeControls() {
    var row = runtimeSnapshot;
    var selected = runtimeVersion();
    var busy = row === null || runtimeActionRunning || row.phase === 'installing' || row.phase === 'applying' || row.restart === 'running' || row.start === 'running';
    var pendingBlocked = row !== null && row.phase === 'pending';
    // Recovery phases and any projected startup block (FATAL / swap / restore /
    // env-probe-failed / resolution failure) disable every mutation surface —
    // the server's recovery gate refuses them (2026 audit R2/R3); declared
    // before baseMutationBlocked so select/apply/rollback/registry/restore and
    // the recovery escape buttons all share the same truth.
    var recoveryPhase = row !== null && (row.phase === 'swap-attempted' || row.phase === 'snapshot-failed' || row.phase === 'restore-blocked');
    var startupBlocked = row !== null && row.startupBlockedReason !== null && row.startupBlockedReason !== '';
    var baseMutationBlocked = busy || row.mutationsAllowed !== true || row.source === 'env' || recoveryPhase || startupBlocked;
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
    byId('runtime-restore').disabled = baseMutationBlocked || recoveryPhase || startupBlocked || row.hasOverride !== true;
    // Matching retries stay ENABLED in their recovery phases: on the real
    // wire phase and startupBlockedReason co-project from the same in-memory
    // block, so the reason must not re-disable the retry the phase advertises
    // (2026 audit R4 F1 — busy/env/read-only only, never mutationBlocked).
    byId('runtime-retry-apply').disabled = busy || row.mutationsAllowed !== true || row.source === 'env' || (row.phase !== 'swap-attempted' && row.phase !== 'snapshot-failed');
    byId('runtime-retry-restore').disabled = busy || row.mutationsAllowed !== true || row.source === 'env' || row.phase !== 'restore-blocked';
    byId('runtime-restart').disabled = busy || pendingBlocked || recoveryPhase || startupBlocked || (row.connectionState !== 'ready' && row.connectionState !== 'degraded');
    // Start (design 21 §6.8 r1 / decision-12 recovery primitive): brings the
    // managed dsh up from stopped/error/restart-exhausted. The enablement
    // mirrors the /chamber/runtime/start route gate (runtime-routes.ts): the
    // recovery gate (startupBlockedReason + swap/snapshot/restore recovery
    // phases), a pending armed switch, installing/applying windows and any
    // non-startable connection state all refuse — the UI disables up front
    // instead of surfacing the 409. Restart stays the ready/degraded surface;
    // start is its stopped-runtime counterpart, so the server copy that told
    // the operator to "start the managed dsh" is now reachable from this page.
    var startableConnection = row !== null && (row.connectionState === 'stopped' || row.connectionState === 'error' || row.connectionState === 'restart-exhausted');
    byId('runtime-start').disabled = busy || pendingBlocked || recoveryPhase || startupBlocked || !startableConnection;
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
  // -------------------------------------------------------------------------
  // In-page confirmation dialog (2026-09-11 upstream-alignment T2).
  //
  // Both credential removals used to gate on the browser's native
  // confirmation popup: OS-styled chrome that cannot ride this page's own
  // visual vocabulary (panel/actions/status/danger), reads as an alien layer
  // over it, and cannot be localized — the same reason the chamber's other
  // admin surfaces were converted (the settings bridge's confirmations are now
  // one in-app dialog built from the official design-system primitive). This
  // page is deliberately dependency-free, so the dialog is the page's own
  // #confirm-* markup driven by plain DOM calls; all operator-visible copy is
  // written through textContent, never parsed as HTML.
  //
  // One armed request at a time. ARMING fills the dialog, makes the page
  // behind it inert and moves focus INTO it (Cancel, the least destructive
  // control, takes the initial focus). CANCEL or Escape dismisses it and
  // performs NOTHING: the runner is dropped before it is ever called, so no
  // request leaves the page. CONFIRM launches the runner EXACTLY once and the
  // dialog becomes a non-dismissible progress surface (both controls disabled,
  // the actions row marked busy, the pending line announced through
  // role="status") until the action settles; the action owns its own
  // success/failure reporting, so this page's existing status lines stay the
  // single report.
  //
  // 2026-09-11 review-fix F1: the background is inert for the WHOLE armed
  // lifetime, and the Tab trap covers the pending window too. Before this, the
  // trap switched itself off the moment a confirm was accepted: with both
  // controls disabled the browser drops focus to <body>, and Tab walked the
  // page behind — the header link, #refresh, #cred-change-password (a real
  // POST gate with no confirmation of its own) and every runtime control —
  // exactly while a scrypt verify or a store write had the operator waiting.
  // inert is the enforcement a browser honours; the trap stays as the
  // portable equivalent, so an engine without inert (or a Tab that starts on
  // the dialog container) still cannot leave the dialog.
  // 2026-09-11 review-fix F2: the busy flag rides the actions row, NOT this
  // dialog element: #confirm-pending is a descendant of the dialog, and
  // assistive technology may ignore changes inside a busy subtree, which would
  // swallow the very announcement the flag accompanies.
  // -------------------------------------------------------------------------
  var confirmArmed = null;

  // The page behind the dialog: the two body-level landmarks. Both carry ids
  // in the served markup so inert can be applied and — more importantly —
  // removed again before focus is handed back to the invoking control.
  var CONFIRM_BACKGROUND_IDS = ['page-header', 'page-main'];

  function setBackgroundInert(on) {
    for (var i = 0; i < CONFIRM_BACKGROUND_IDS.length; i += 1) {
      var landmark = byId(CONFIRM_BACKGROUND_IDS[i]);
      if (on) landmark.setAttribute('inert', '');
      else landmark.removeAttribute('inert');
    }
  }

  function confirmElements() {
    return {
      backdrop: byId('confirm-backdrop'),
      dialog: byId('confirm-dialog'),
      title: byId('confirm-title'),
      description: byId('confirm-description'),
      pending: byId('confirm-pending'),
      actions: byId('confirm-actions'),
      cancel: byId('confirm-cancel'),
      accept: byId('confirm-accept')
    };
  }

  // Close the dialog and hand focus back to the control that opened it (the
  // invoking button), so the keyboard flow resumes where the operator left it.
  function closeConfirmDialog() {
    var armed = confirmArmed;
    if (armed === null) return;
    confirmArmed = null;
    document.removeEventListener('keydown', confirmKeydown, true);
    var parts = confirmElements();
    parts.backdrop.hidden = true;
    // The background comes back BEFORE the focus hand-off: an inert invoking
    // control cannot take focus (2026-09-11 review-fix F1).
    setBackgroundInert(false);
    parts.actions.removeAttribute('aria-busy');
    parts.title.textContent = '';
    parts.description.textContent = '';
    parts.pending.textContent = '';
    parts.accept.textContent = '';
    parts.accept.disabled = false;
    parts.cancel.disabled = false;
    if (armed.returnFocus !== null && typeof armed.returnFocus.focus === 'function') armed.returnFocus.focus();
  }

  // A dismiss while the accepted action is running is ignored: the dialog is a
  // progress surface then, and closing it would imply a cancellation that does
  // not exist.
  function dismissConfirmDialog() {
    if (confirmArmed === null || confirmArmed.pending) return;
    closeConfirmDialog();
  }

  function acceptConfirmDialog() {
    var armed = confirmArmed;
    // A second accept — a same-frame double click included — launches nothing.
    if (armed === null || armed.pending) return;
    armed.pending = true;
    var parts = confirmElements();
    // 2026-09-11 review-fix F2: the busy flag goes on the ACTIONS ROW, not on
    // the dialog: the pending line below is a descendant of the dialog, and a
    // busy subtree is exactly what assistive technology may refuse to
    // announce.
    parts.actions.setAttribute('aria-busy', 'true');
    parts.accept.disabled = true;
    parts.cancel.disabled = true;
    parts.accept.textContent = armed.pendingLabel;
    // The pending state is announced on the dialog's own role="status" line
    // (a scrypt verify or a store write takes a moment; the dialog says so
    // instead of looking inert).
    parts.pending.textContent = armed.pendingLabel;
    // The runner starts one microtask later, so a synchronous throw is caught
    // like any other failure, and its promise settlement (success or failure)
    // is what closes the dialog — the modal can never outlive the action it
    // announced.
    Promise.resolve().then(armed.run).then(closeConfirmDialog, closeConfirmDialog);
  }

  function confirmKeydown(event) {
    if (confirmArmed === null) return;
    if (event.key === 'Escape' || event.key === 'Esc') {
      event.preventDefault();
      dismissConfirmDialog();
      return;
    }
    if (event.key !== 'Tab') return;
    // The trap covers the WHOLE armed lifetime (2026-09-11 review-fix F1).
    // While an accepted action runs, both controls are disabled and there is
    // nothing inside the dialog to cycle: focus — which the disabled control
    // handed to <body> — goes to the dialog container (tabindex="-1") and
    // stays there. The pre-accept branch cycles the dialog's two controls
    // (Cancel, then the destructive Confirm) instead of walking back out into
    // the page. aria-modal="true" promises the page behind is unreachable, so
    // this branch must never fall through to the browser's own Tab move.
    event.preventDefault();
    var parts = confirmElements();
    if (confirmArmed.pending) {
      parts.dialog.focus();
      return;
    }
    var order = [parts.cancel, parts.accept];
    var step = event.shiftKey ? -1 : 1;
    order[(order.indexOf(document.activeElement) + step + order.length) % order.length].focus();
  }

  // Arm the page's ONE in-app confirmation (2026-09-11 upstream-alignment T2):
  // nothing runs before the operator confirms, and the copy the dialog shows is
  // the gate's own (title = the question, description = the consequence).
  function armConfirmDialog(request) {
    if (confirmArmed !== null) return;
    confirmArmed = {
      pending: false,
      pendingLabel: request.pendingLabel,
      run: request.run,
      // Focus memory: the invoking button is passed explicitly (a click does
      // not focus a button in every browser), with the currently focused
      // control as the fallback.
      returnFocus: request.opener !== undefined && request.opener !== null ? request.opener : document.activeElement
    };
    var parts = confirmElements();
    // Every interpolated string goes through textContent — the dialog can
    // never turn copy (or a server message) into markup.
    parts.title.textContent = request.title;
    parts.description.textContent = request.description;
    parts.pending.textContent = '';
    parts.accept.textContent = request.confirmLabel;
    parts.accept.disabled = false;
    parts.cancel.disabled = false;
    parts.actions.removeAttribute('aria-busy');
    parts.backdrop.hidden = false;
    // aria-modal="true" is a promise: from this moment until close, the page
    // behind the dialog is out of the tab order, out of the accessibility
    // tree and out of pointer reach (2026-09-11 review-fix F1).
    setBackgroundInert(true);
    document.addEventListener('keydown', confirmKeydown, true);
    // Focus moves INTO the dialog, onto the least destructive control: the
    // destructive button is never the default action of a modal.
    parts.cancel.focus();
  }

  function removePassword() {
    if (credentialSnapshot.password === null) { status('credentials', 'No password is configured — nothing to remove.', true); return; }
    armConfirmDialog({
      title: 'Remove the gateway password?',
      description: 'The password login is invalidated immediately.',
      confirmLabel: 'Remove password',
      pendingLabel: 'Removing password…',
      opener: byId('cred-remove-password'),
      run: async function () {
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
    });
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
  function removeToken() {
    if (credentialSnapshot.token === null) { status('credentials', 'No token is configured — nothing to remove.', true); return; }
    if (credentialSnapshot.password === null) {
      status('credentials', 'This gateway has no password; remove the token from a bearer-token client instead.', true);
      return;
    }
    armConfirmDialog({
      title: 'Remove the gateway token?',
      description: 'Authenticated API and desktop clients are disconnected immediately.',
      confirmLabel: 'Remove token',
      pendingLabel: 'Removing token…',
      opener: byId('cred-remove-token'),
      run: async function () {
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
    });
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
  byId('runtime-start').addEventListener('click', function () { void runtimeAction(RUNTIME_PATHS.start, undefined, 'dsh start'); });
  byId('runtime-registry-save').addEventListener('click', function () { void saveRuntimeRegistry(); });
  byId('cred-change-password').addEventListener('click', function () { void changePassword(); });
  byId('cred-remove-password').addEventListener('click', function () { void removePassword(); });
  byId('cred-rotate-token').addEventListener('click', function () { void rotateToken(); });
  byId('cred-remove-token').addEventListener('click', function () { void removeToken(); });
  byId('cred-copy-token').addEventListener('click', copyToken);
  // The confirmation dialog's own controls (2026-09-11 upstream-alignment T2):
  // Cancel dismisses (a cancel performs NOTHING), Confirm launches the armed
  // runner exactly once, and a click on the mask outside the dialog dismisses
  // the same way — the affordance the chamber's other in-app dialogs have
  // (the settings bridge's Modal closes on mask click), and the only one a
  // touch device without an Escape key would otherwise miss. Registered ONCE:
  // the dialog is re-armed many times, and the listeners must not accumulate.
  byId('confirm-cancel').addEventListener('click', dismissConfirmDialog);
  byId('confirm-accept').addEventListener('click', acceptConfirmDialog);
  byId('confirm-backdrop').addEventListener('click', function (event) {
    if (event.target === byId('confirm-backdrop')) dismissConfirmDialog();
  });
  byId('refresh').addEventListener('click', function () { void Promise.allSettled([refreshRuntime(), loadCredentials()]); });
  void Promise.allSettled([refreshRuntime(), loadCredentials()]);
  setInterval(function () { void loadRuntimeStatus(); }, 3000);
}());
`

export const MOBILE_HTML = `<!doctype html>
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

