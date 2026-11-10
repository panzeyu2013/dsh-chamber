/**
 * Pure judgement layer of the GUI acceptance toolbox: every predicate and every
 * report renderer lives here, with no HTTP, DOM or CDP access — so the whole
 * judgement surface is unit-testable in CI (see checks.test.mjs) while
 * only the driving layer stays local.
 */

/** One acceptance result. `ok === null` records a fact that is neither pass nor fail. */
export function verdict(id, title, ok, evidence = '') {
  return { id, title, ok, evidence: String(evidence) }
}

/** Collect results and expose the aggregate counts the report needs. */
export function createRecorder() {
  const results = []
  return {
    results,
    add(id, title, ok, evidence) {
      const entry = verdict(id, title, ok, evidence)
      results.push(entry)
      const mark = entry.ok === true ? 'PASS' : entry.ok === false ? 'FAIL' : 'INFO'
      console.log(`[${mark}] ${id} ${title}${entry.evidence === '' ? '' : `\n        ${entry.evidence}`}`)
      return entry
    },
    get passed() { return results.filter(entry => entry.ok === true).length },
    get failed() { return results.filter(entry => entry.ok === false).length },
  }
}

const ASSET_ATTRIBUTE = /(?:src|href)="(\/assets\/[^"]+)"/g
const RELATIVE_ASSET_ATTRIBUTE = /(?:src|href)="\.\/(assets\/[^"]+)"/g
const BASE_HREF_ATTRIBUTE = /<base\s[^>]*?href="([^"]*)"/i
// The pinned host stamps `<base href="./">` into every rendered index
// (vendor/harness-checkout/packages/host/frontend-static/src/index.ts:119) and its
// loader rows are document-relative (`plugins/??…`, client-modules
// `comboReference`). A root-absolute `/plugins/??…` is accepted by this parser but
// is NOT the same resource in a browser: it resolves to the ORIGIN root. The
// declared form is therefore kept verbatim — resolution is resolveDeclaredUrl's job.
const PLUGIN_LOADER_ATTRIBUTE = /(?:src|href)="((?:\.\/|\/)?plugins\/\?\?[^"]+)"/g

/** Root-absolute asset urls declared by a shell index.html. */
export function parseShellAssets(html) {
  return [...html.matchAll(ASSET_ATTRIBUTE)].map(match => match[1])
}

/** Document-relative (`./assets/…`) asset urls declared by a proxied dsh index.html. */
export function parseInstanceAssets(html) {
  return [...html.matchAll(RELATIVE_ASSET_ATTRIBUTE)].map(match => match[1])
}

/**
 * The `<base href>` a proxied instance page declares, verbatim, or null when it
 * declares none. The value is a URL fragment, not a path: `./` keeps every
 * document-relative reference under the instance prefix, while `/` re-roots it onto
 * the origin. Only {@link resolveDeclaredUrl} may interpret it.
 * @param html - the proxied instance index document.
 * @returns the declared base href, or null.
 */
export function parseBaseHref(html) {
  const declared = BASE_HREF_ATTRIBUTE.exec(html)
  return declared === null ? null : declared[1].replace(/&amp;/g, '&')
}

/**
 * Multi-entry plugin loader urls, exactly as the document declares them (entities
 * decoded, a leading `./` kept). The `rev` query is part of the contract: the
 * instance answers 404 for the same path without it, so the declared URL — not a
 * hand-built one — is what the acceptance run probes. The FORM is load-bearing too
 * and stays untouched: prefixing a `/` here would erase the only difference between
 * a document-relative and an origin-absolute declaration.
 * @param html - the proxied instance index document.
 * @returns the declared loader urls, in document order.
 */
export function parsePluginLoaderUrls(html) {
  return [...html.matchAll(PLUGIN_LOADER_ATTRIBUTE)].map(match => match[1].replace(/&amp;/g, '&'))
}

/**
 * Resolve one URL a proxied instance document declares into the control-plane
 * request target, with the browser's own algorithm: `<base href>` resolved against
 * the document URL, then the declared URL resolved against that (`new URL(url, base)`),
 * never string concatenation.
 *
 * The difference is the point of this function. Under the pinned `<base href="./">`
 * a document-relative `plugins/??…` lands under the instance prefix
 * (`/api/i/<id>/plugins/??…`), while a root-absolute `/plugins/??…` lands on the
 * ORIGIN root, where the control plane serves nothing. Concatenating the instance
 * prefix onto both fetches the first form twice and reports a PASS for a resource
 * the browser never loads.
 * @param declaredUrl - the attribute value as written in the document.
 * @param options.documentUrl - the absolute URL the document was fetched from.
 * @param options.baseHref - the document's `<base href>` value, or null/absent when
 *   it declares none (the document URL is then the base, per HTML's fallback base URL).
 * @returns the origin-form target (`/path?query`), or null when the declared URL is
 *   empty, cannot be resolved, or resolves off the document's origin.
 */
export function resolveDeclaredUrl(declaredUrl, { documentUrl, baseHref = null } = {}) {
  if (typeof declaredUrl !== 'string' || declaredUrl === '') return null
  try {
    const page = new URL(documentUrl)
    const base = new URL(baseHref ?? '', page)
    const resolved = new URL(declaredUrl, base)
    if (resolved.origin !== page.origin) return null
    return `${resolved.pathname}${resolved.search}`
  } catch {
    // A malformed declaration is the document's own fact, not a crash: the caller
    // records "cannot probe" and the check fails closed.
    return null
  }
}

/** The chamber shell's own markers. */
export function isShellIndex(status, html) {
  return status === 200 && /<!doctype html>/i.test(html) && html.includes('dsh-chamber')
}

/** A proxied per-instance dsh frontend document. */
export function isInstanceIndex(status, html) {
  return status === 200 && html.includes('__DSH_BOOT__') && /<base href=/.test(html)
}

/** Security headers the control plane must stamp on every response (design 04 §4.3). */
export function hasSecurityHeaders(headers) {
  const csp = headers['content-security-policy'] ?? ''
  return csp.includes("default-src 'self'")
    && headers['x-frame-options'] === 'DENY'
    && headers['x-content-type-options'] === 'nosniff'
    && headers['referrer-policy'] === 'same-origin'
}

/** A fence held: no leaked /etc/passwd content regardless of status. */
export function leakedFileContent(body) {
  return /root:.*:0:0:/.test(body)
}

/** An answer that names the failure instead of pretending (design 03 §3.3). */
export function isHonestError(status, body, code) {
  return status >= 400 && typeof code === 'string' && code !== '' && body.includes(code)
}

/**
 * The local writer diagnosis route: `{quiescent, writers[], errors[]}`
 * (control-plane api.ts §"GET /api/connections/local/writers").
 *
 * `quiescent` is the verdict; `writers[]` lists the SCAN OUTCOMES and may
 * legitimately be non-empty — a `reclaimed` orphan is reported so the
 * connections page can show it, and it does not block anything. Only a
 * non-quiescent verdict (a `kept` record that could not be reclaimed) means a
 * live writer the plane cannot account for.
 */
export function isWriterQuiescent(body) {
  const parsed = safeJson(body)
  return parsed !== null && parsed.quiescent === true
}

/** Human-readable writer evidence: every scan outcome plus the error count. */
export function writerEvidence(body) {
  const parsed = safeJson(body)
  if (parsed === null) return 'not json'
  const writers = Array.isArray(parsed.writers) ? parsed.writers : []
  const summary = writers
    .map(entry => `${entry?.name ?? '?'}:${entry?.status ?? '?'}${entry?.takeOverAvailable === true ? '(可接管)' : ''}`)
    .join(' ')
  const errors = Array.isArray(parsed.errors) ? parsed.errors.length : 0
  return `quiescent=${parsed.quiescent} writers=[${summary}] errors=${errors}`
}

/**
 * Documented tolerances. Each entry is a fact the product itself specifies, so a
 * matching failure is an environment state, not an acceptance failure — the raw
 * text stays in the report either way.
 */
export const TOLERATED_REQUEST_FAILURES = [
  {
    // design 09 §3.2 documents this environment state: a cold-started instance
    // answers clientGraph/graph with 503 instance_unavailable (the reverse proxy
    // refuses to forward while the managed dsh is not serving yet).
    pattern: /503 \S*\/api\/i\/[^/]+\/api\/clientGraph\/graph$/,
    reason: '冷启动期实例未 serving：clientGraph/graph 503 属 design 09 §3.2 预期',
  },
]

/** Upstream boot noise that is not a chamber defect (raw text still reported). */
export const KNOWN_UPSTREAM_BOOT_NOISE = [
  {
    // vendor/harness-checkout …/cordis-client-runner/src/client/inspect-registry.ts:85
    // logs this once per boot, before any connection is active; it is upstream
    // code and it does not affect any interaction.
    pattern: /\[cordis-client-runner\] syncing inspect providers failed: .*has no active Connection/,
    reason: '上游 cordis-client-runner 启动期日志（连接尚未激活），非 chamber 缺陷',
  },
]

/** Split observed failures into tolerated (documented) and unexpected. */
export function partitionFailures(entries, rules) {
  const tolerated = []
  const unexpected = []
  for (const entry of entries) {
    const rule = rules.find(candidate => candidate.pattern.test(entry))
    if (rule === undefined) unexpected.push(entry)
    else tolerated.push(`${entry} — ${rule.reason}`)
  }
  return { tolerated, unexpected }
}

export function safeJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

/**
 * Source ids the desktop registry exposes to the renderer: `<kind>-<id>` per
 * connection (renderer/src/transport-source.ts). Only `id` and `kind` are read —
 * host/user/port and every credential stay out of the acceptance run.
 */
export function deriveSourceIds(registry) {
  const rows = Array.isArray(registry) ? registry : Object.values(registry ?? {})
  const ids = new Set()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const { id, kind } = row
    if (typeof id !== 'string' || id === '' || typeof kind !== 'string' || kind === '') continue
    ids.add(`${kind}-${id}`)
  }
  return [...ids].sort()
}

/** Group failed-request facts for the report (deterministic order). */
export function summarizeNetFailures(failures) {
  const entries = failures instanceof Map ? [...failures.entries()] : Object.entries(failures ?? {})
  return entries.map(([key, count]) => `${key} ×${count}`).sort()
}

/** Aggregate counts used by the CLI exit code and the report header. */
export function summarize(results) {
  return {
    total: results.length,
    passed: results.filter(entry => entry.ok === true).length,
    failed: results.filter(entry => entry.ok === false).length,
    info: results.filter(entry => entry.ok === null).length,
  }
}

/** Markdown report: the artifact a worker attaches to a PR or an issue. */
export function renderMarkdown({ title, meta, results, netFailures = [], consoleErrors = [], consoleWarnings = [] }) {
  const counts = summarize(results)
  const lines = [
    `# ${title}`,
    '',
    ...Object.entries(meta).map(([key, value]) => `- ${key}: ${value}`),
    `- 结果：${counts.passed} pass / ${counts.failed} fail / ${counts.info} info（共 ${counts.total} 项）`,
    '',
    '| id | 检查项 | 结果 | 证据 |',
    '|---|---|---|---|',
    ...results.map(entry => `| ${entry.id} | ${cell(entry.title)} | ${entry.ok === true ? '✅' : entry.ok === false ? '❌' : 'ℹ️'} | ${cell(entry.evidence)} |`),
    '',
    `## 页面失败请求（≥400 / loadingFailed）：${netFailures.length}`,
    '',
    ...(netFailures.length === 0 ? ['（无）'] : netFailures.map(entry => `- ${cell(entry)}`)),
    '',
    `## 控制台：error ${consoleErrors.length} / warning ${consoleWarnings.length}`,
    '',
    ...(consoleErrors.length === 0 ? ['（无 error）'] : consoleErrors.slice(0, 20).map(entry => `- ${cell(entry)}`)),
  ]
  return lines.join('\n') + '\n'
}

function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 400)
}

/** Trim + collapse whitespace in an observed text fact (never throws). */
export function normalizeCardText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Identity of a hover card with the row that raised it.
 *
 * The card's first block IS the row's own title — `cc.hoverTitle` renders
 * `workspace.title` / `sessionTitleText` (ServerSection.tsx:912 /
 * ServerSectionRows.tsx:405), the same value the row itself renders
 * (`cc.workspaceTitle` ServerSection.tsx:695 / `cc.sessionTitle`
 * ServerSectionRows.tsx:259) — and every card is rendered inside `[data-chamber-hovercard]`
 * (RowHoverCard.tsx). So "the card's text contains the hovered row's title" is a
 * contract-level identity fact, not a text coincidence. Containment, not
 * equality: a session card legitimately appends time / state lines.
 * @param rowTitle - the hovered row's own title text.
 * @param cardText - the dwelling card's full text.
 * @returns true only when the card provably belongs to that row.
 */
export function cardIdentityHolds(rowTitle, cardText) {
  const row = normalizeCardText(rowTitle)
  const card = normalizeCardText(cardText)
  return row !== '' && card !== '' && card.includes(row)
}

function noteTail(note) {
  return note === '' ? '' : `（${note}）`
}

/**
 * Row hover card verdict (design 06 §7): dwelling on a cardable row must raise
 * exactly ONE card, that card must carry the hovered row's own title, and moving
 * the pointer away must clear it.
 *
 * `cardable` is decided by the `<span data-chamber-hovercard-anchor>` marker, so
 * a build that does not stamp the marker has to be told apart from an
 * instance that genuinely has no cardable row: `anchorCount`
 * and `wrappedRows` do that. A cardable row is wrapped by RowHoverCard's anchor
 * span (RowHoverCard.tsx), so cardable-looking rows WITHOUT the marker mean the
 * marker contract is missing in the running bundle — a FAIL, never INFO.
 * @param facts - what the walkthrough observed.
 * @param facts.cardable - whether a marker-anchored, visible row was found.
 * @param facts.opened - exactly one card was visible while the pointer dwelt (or null).
 * @param facts.closed - no card remained after the pointer left (or null).
 * @param facts.rowTitle - the hovered row's own title text.
 * @param facts.cardText - the dwelling card's full text.
 * @param facts.anchorCount - `[data-chamber-hovercard-anchor]` elements seen (0 = marker absent).
 * @param facts.wrappedRows - rows whose parent is an anchor-shaped `<span>` (diagnostic only).
 * @param facts.note - walkthrough-side explanation, appended to the evidence.
 * @returns `{ ok, evidence }` for the recorder (`ok === null` is INFO).
 */
export function hoverCardVerdict({
  cardable, opened = null, closed = null, rowTitle = '', cardText = '',
  anchorCount = null, wrappedRows = 0, note = '',
}) {
  if (!cardable) {
    if (anchorCount === 0 && wrappedRows > 0) {
      return {
        ok: false,
        evidence: `anchors=0 wrappedRows=${wrappedRows}：有 RowHoverCard 锚点形状的行，却没有 [data-chamber-hovercard-anchor] 标记`
          + ` → 标记契约缺失（RowHoverCard.tsx 的修复未打进这个包），与"实例没有卡片行"不是一回事${noteTail(note)}`,
      }
    }
    return {
      ok: null,
      evidence: `本次实例没有可悬停的卡片行（仅来源头/无卡片行按设计无卡片，anchors=${anchorCount} wrappedRows=${wrappedRows}）→ 未执行${noteTail(note)}`,
    }
  }
  const identity = cardIdentityHolds(rowTitle, cardText)
  return {
    ok: opened === true && closed === true && identity,
    evidence: `cardable=1 dwellingCard=${opened} clearedAfterLeave=${closed} identity=${identity}`
      + ` rowTitle=${JSON.stringify(rowTitle)} cardText=${JSON.stringify(cardText)}${noteTail(note)}`,
  }
}

/**
 * Leave offsets (ms after the dwell) sampled when no usable commit window was
 * measured. This fixed band only discriminates when the dwell→commit latency
 * happens to be at least as large, so the walkthrough measures the window first
 * and treats this as a fallback.
 */
export const HOVER_RACE_FALLBACK_OFFSETS = [10, 20, 35, 50, 60]

/**
 * A commit window this small cannot be probed with real timers/CDP: `setTimeout`
 * granularity plus one evaluate round trip is already ~1-5ms, so offsets inside
 * it are not deliverable. Below this the race leg reports "could not
 * discriminate" instead of pretending to have proven anything.
 */
export const HOVER_RACE_MIN_WINDOW_MS = 2

/**
 * Upper bound on the window used to derive offsets. The strand only needs the
 * leave to land somewhere inside the window, so a huge window is sampled near
 * its start; the cap keeps one trial ~1s instead of letting a slow run blow up
 * the walkthrough's wall time.
 */
export const HOVER_RACE_WINDOW_CAP_MS = 200

/**
 * The leave offsets a race trial should sample, derived from THIS run's measured
 * dwell→commit latency.
 *
 * WHY DERIVED, NOT FIXED: a strand needs the
 * pointerleave to land AFTER the dwell callback ran and BEFORE React committed
 * the open — the vendored handler is `clearTimer(); if (open) armClose()`, so a
 * leave outside that window arms its grace normally and NO card strands even on
 * the broken build. A fixed `dwell+10..60ms` band is therefore only a lower
 * bound: on a fast/idle thread the whole band can land after the commit and the
 * leg goes green on a regression. Offsets inside the measured window are the
 * only ones that can discriminate.
 *
 * The returned offsets are deterministic (quarter/half/near-end of the window,
 * deduped and sorted) and always inside `[1, window]` when the window allows it.
 * @param commitLatencyMs - measured `tCommit - tEnter - dwell`, or null/NaN/≤0 when unmeasured.
 * @returns the offsets to cycle through (the fallback band when unusable).
 */
export function raceBandForWindow(commitLatencyMs) {
  if (typeof commitLatencyMs !== 'number' || !Number.isFinite(commitLatencyMs) || commitLatencyMs <= 0) {
    return [...HOVER_RACE_FALLBACK_OFFSETS]
  }
  const window = Math.min(commitLatencyMs, HOVER_RACE_WINDOW_CAP_MS)
  const reach = Math.max(1, Math.floor(window))
  const offsets = [0.25, 0.5, 0.9].map(share => Math.min(Math.max(1, Math.round(window * share)), reach))
  return [...new Set(offsets)].sort((a, b) => a - b)
}

/**
 * Strand race verdict (design 06 §7 / hover-intent.ts header: the vendored
 * atom's committed-`open` race): a pointerleave inside the dwell→commit window
 * must never leave a card on screen. ONE stranded card is a FAIL, because a card
 * nobody can dismiss is the reported defect.
 *
 * HONESTY: the leg only proves something when the leave offsets
 * it sampled were actually inside this run's measured window. A run whose window
 * could not be measured, or is too small to probe, did NOT discriminate — it is
 * reported as INFO ("本次运行不具区分力"), never as a pass, so a green run is not
 * read as "the strand race was verified". `--require-hover` (see
 * {@link applyRequireHover}) turns exactly that INFO into a FAIL for runs that
 * demand real coverage. A strand, when seen, is a FAIL regardless of the window.
 * @param facts.trials - trials actually run (>0; 0 means "no cardable row" → INFO).
 * @param facts.stranded - trials whose settle still showed a card.
 * @param facts.bandMs - the leave offsets actually sampled (ms after the dwell).
 * @param facts.windowMs - the measured commit latency, or null when unmeasured.
 * @param facts.strandedTrials - trial indices that stranded (evidence only).
 * @returns `{ ok, evidence }` (`ok === null` is INFO).
 */
export function hoverRaceVerdict({ trials, stranded, bandMs, windowMs = null, strandedTrials = [] }) {
  const band = Array.isArray(bandMs) ? bandMs.join('/') : String(bandMs)
  const measured = typeof windowMs === 'number' && Number.isFinite(windowMs)
  const discriminating = measured && windowMs > HOVER_RACE_MIN_WINDOW_MS
  const window = measured ? `${windowMs}ms` : '未测到'
  const honesty = discriminating ? `window=${window}（可区分）`
    : measured ? `window=${window} ≤${HOVER_RACE_MIN_WINDOW_MS}ms（低于探针分辨率：本次运行不具区分力）`
      : `window=${window}（窗口未测到，用的是兜底 band：本次运行不具区分力）`
  if (!(trials > 0)) {
    return { ok: null, evidence: `未执行：没有可悬停的卡片行（或标记契约缺失），竞态腿跳过 band=dwell+{${band}}ms ${honesty}` }
  }
  const where = strandedTrials.length === 0 ? '' : `（搁浅于第 ${strandedTrials.join(',')} 次）`
  const facts = `trials=${trials} band=dwell+{${band}}ms stranded=${stranded}${where} ${honesty}`
  // A strand is proof on its own; a clean run only counts when it could have failed.
  if (stranded > 0) return { ok: false, evidence: facts }
  return { ok: discriminating ? true : null, evidence: facts }
}

/**
 * Exclusivity / self-heal verdict (design 06 §7): a pointer can only be in one
 * region, so crossing from row A to row B must never show two cards, and must
 * END on exactly one card carrying B's own title (B taking the slot is also the
 * self-heal path for a leave that was never delivered at all).
 * @param facts.pairs - cardable rows available; fewer than 2 → INFO (nothing to swap to).
 * @param facts.startCount - card count on A BEFORE crossing (must be exactly one,
 *   or the transition was never exercised and the leg would pass vacuously).
 * @param facts.maxCount - highest card count sampled across the A→B transition.
 * @param facts.endCount - card count once B's dwell has landed.
 * @param facts.rowTitle - row B's own title.
 * @param facts.endText - the ending card's text.
 * @param facts.note - walkthrough-side explanation, appended to the evidence.
 * @returns `{ ok, evidence }` (`ok === null` is INFO).
 */
export function hoverExclusiveVerdict({
  pairs = 0, startCount = null, maxCount = null, endCount = null, rowTitle = '', endText = '', note = '',
}) {
  if (!(pairs >= 2)) {
    return {
      ok: null,
      evidence: `未执行：本次实例只有 ${pairs} 个可悬停的卡片行，凑不出同屏 A→B${noteTail(note)}`,
    }
  }
  const identity = cardIdentityHolds(rowTitle, endText)
  return {
    ok: startCount === 1 && maxCount === 1 && endCount === 1 && identity,
    evidence: `startCardCount=${startCount} maxCardCount=${maxCount} endCount=${endCount} identity=${identity}`
      + ` rowTitle=${JSON.stringify(rowTitle)} endText=${JSON.stringify(endText)}${noteTail(note)}`,
  }
}

/**
 * Page-level dismiss verdict (design 06 §7 / `bindDismissWatch` in hover-intent.ts): with a card
 * open, a `blur` on `window` and a `visibilitychange` while the document is
 * hidden must each clear the card.
 *
 * The walkthrough drives both with synthetic DOM events — a real OS focus loss
 * or a real tab hide cannot be produced over CDP — so this judges the LISTENER
 * WIRING (bound on the first card open, correct dismissal), not the OS hand-off.
 * @param facts.cardable - whether a cardable row existed (else INFO).
 * @param facts.blur - `{ opened, cleared }` for the blur leg (or null).
 * @param facts.hidden - `{ opened, cleared }` for the hidden leg (or null).
 * @param facts.note - walkthrough-side explanation, appended to the evidence.
 * @returns `{ ok, evidence }` (`ok === null` is INFO).
 */
export function hoverDismissVerdict({ cardable = false, blur = null, hidden = null, note = '' }) {
  const leg = value => (value === null ? 'n/a' : `opened=${value.opened},cleared=${value.cleared}`)
  if (!cardable) {
    return { ok: null, evidence: `未执行：没有可悬停的卡片行（或标记契约缺失），失焦/隐藏腿跳过${noteTail(note)}` }
  }
  return {
    ok: blur?.opened === true && blur?.cleared === true && hidden?.opened === true && hidden?.cleared === true,
    evidence: `blur(${leg(blur)}) visibilitychange-hidden(${leg(hidden)})${noteTail(note)}`,
  }
}

/**
 * Locator policy for the sidebar RAIL toggle (W-4), as a pure function over the
 * button descriptors the walkthrough dumps from the page.
 *
 * WHY IT IS NOT `button[aria-expanded]`: the official toggle — and this repo's
 * sidebar fork with it — carries NO `aria-expanded`; its only own handle is a
 * label that flips between `toggle.collapse` / `toggle.open`. Selecting "the
 * first `aria-expanded` control in the left half" could
 * therefore never take this control — it took the SOURCE-SECTION fold switch
 * (`ServerSection.tsx`, design 06 §2.4) instead, and the leg passed while the
 * sidebar never moved.
 *
 * The control is located STRUCTURALLY instead: the icon-sized button in the
 * sidebar HEADER ROW, on the sidebar side of the viewport, outside any modal.
 * Identity is then settled by the EFFECT the leg asserts (see
 * `railToggleVerdict`): a click that does not move the frame's
 * `[data-sidebar-collapsed]` is a FAIL, so a wrong pick can never pass again.
 *
 * SAFETY — the header band must stay TIGHT: the rail state renders a second
 * icon-sized button in the sidebar header region, the rail's `新建会话`
 * (36×36 at top≈66, measured), which STARTS A SESSION. A band wide enough to
 * include it would let a missing/hidden toggle degrade into clicking a
 * mutating control on `--attach`'s real app — the one thing the toolbox's
 * click allowlist promises never happens. With the band bounded to the header
 * row (top < 48: measured toggle tops 18/22) a missing toggle yields
 * `no-candidate` ⇒ FAIL, and no mutation. Do not raise it without re-measuring
 * the rows below.
 * @param buttons - descriptors `{ index, left, top, width, height, inDialog }`.
 * @param opts.viewportWidth - viewport width; candidates must sit on its left side.
 * @returns `{ ok, picked?, reason?, candidates }` — `ok: false` means NOT LOCATED
 *   (a shell-control contract, not an environment fact), never "picked a guess".
 */
export const RAIL_TOGGLE_BOX_MAX_PX = 48
export const RAIL_TOGGLE_BAND_MAX_TOP_PX = 48
export const RAIL_TOGGLE_LEFT_FRACTION = 0.4

export function pickRailToggle(buttons, { viewportWidth = null } = {}) {
  const list = Array.isArray(buttons) ? buttons : []
  const candidates = list.filter(entry =>
    entry.width > 0 && entry.height > 0
    && entry.width <= RAIL_TOGGLE_BOX_MAX_PX && entry.height <= RAIL_TOGGLE_BOX_MAX_PX
    && entry.top < RAIL_TOGGLE_BAND_MAX_TOP_PX
    && (viewportWidth === null || entry.left < viewportWidth * RAIL_TOGGLE_LEFT_FRACTION)
    && entry.inDialog !== true
    // Inactive instance views (N-ctx) keep layout, so their controls have a real
    // rect: without this scope a hidden shell's toggle either wins the topmost
    // rule or ties with the visible one (measured: an injected hidden clone was
    // taken while it was topmost; a real hidden shell sits at the same top).
    && entry.visibility !== 'hidden')
  if (candidates.length === 0) return { ok: false, reason: 'no-candidate', candidates: [] }
  const sorted = [...candidates].sort((a, b) => (a.top - b.top) || (a.index - b.index))
  const tied = sorted.filter(entry => entry.top === sorted[0].top)
  // Two plausible header-band controls mean the structure moved: fail closed
  // instead of silently taking the first one.
  if (tied.length > 1) return { ok: false, reason: 'ambiguous', picked: tied[0], candidates: sorted }
  return { ok: true, picked: sorted[0], candidates: sorted }
}

/**
 * Adapter between the merged facts expression and the rail verdicts: `DOM_FACTS`
 * names the sidebar population `sidebarSources`/`sidebarRows`, the verdicts read a
 * small stable snapshot (`sections`/`rows`). Keeping the mapping in one place is
 * what makes the merge safe: a drift between the two name sets reports
 * `[data-chamber-section] undefined → undefined → undefined`.
 * @param facts - a `DOM_FACTS` snapshot (or null).
 * @returns `{ railCollapsed, sections, rows, settingsOpen }`, or null.
 */
export function railFactsSnapshot(facts) {
  if (facts === null || facts === undefined) return null
  return {
    railCollapsed: facts.railCollapsed === true,
    sections: facts.sidebarSources,
    rows: facts.sidebarRows,
    settingsOpen: facts.settingsOpen === true,
  }
}

/** One button descriptor as an evidence fragment. */
export function describeButton(entry) {
  if (entry === null || entry === undefined) return '（无）'
  const raw = entry.ariaLabel
  const label = raw === null || raw === undefined || raw === '' ? '(无 aria-label)' : `"${raw}"`
  return `${label} ${entry.width ?? '?'}×${entry.height ?? '?'}@(${entry.left ?? '?'},${entry.top ?? '?'})`
}

/**
 * Fingerprint of the persisted sidebar view preferences (design 06 §3.1, the
 * shared `dsh-chamber.sidebar.v1` localStorage key) as the walkthrough reports
 * them. Comparing fingerprints is how the README's write-boundary claim stops
 * being prose: "this leg wrote nothing" / "the round trip left no residue"
 * become checked facts.
 * @param prefs - `VIEW_PREFS` snapshot, or null when the leg did not read it.
 * @returns a comparable string, or null when no snapshot was taken.
 */
export function viewPrefsFingerprint(prefs) {
  if (prefs === null || prefs === undefined) return null
  if (prefs.present !== true) return 'absent'
  return JSON.stringify({
    v: prefs.v ?? null,
    sourceFolded: prefs.sourceFolded ?? null,
    folded: prefs.foldedKeys ?? null,
    width: prefs.sidebarWidth ?? null,
    order: prefs.serverOrder ?? null,
    orderBy: prefs.orderByKeys ?? null,
    parseError: prefs.parseError ?? null,
  })
}

/**
 * Whether a `VIEW_PREFS` snapshot can support a boundary CLAIM at all: a missing
 * snapshot (the leg never read it) or an unparsable stored value means "not
 * checked", which must never read as "nothing was written". A snapshot with
 * `present: false` IS readable — it says the key does not exist.
 * @param prefs - `VIEW_PREFS` snapshot.
 * @returns true when the snapshot cannot support a claim.
 */
export function viewPrefsUnreadable(prefs) {
  if (prefs === null || prefs === undefined) return true
  return prefs.parseError !== undefined && prefs.parseError !== null
}

/**
 * The changed preference fields between two snapshots, as a short evidence
 * fragment (null when nothing changed, or when either side was not read).
 * @param before - `VIEW_PREFS` snapshot.
 * @param after - `VIEW_PREFS` snapshot.
 * @returns a description such as `sourceFolded null→{"local":true}`, or null.
 */
export function viewPrefsDelta(before, after) {
  // A fresh --dev instance has no store key at all; the first fold round-trip
  // necessarily creates it. Creating ONLY the default shape (no sourceFolded,
  // no folded keys, no width/order) is not residue — design 06 §3.1 keeps
  // sourceFolded only while collapsed. Any user state still reports a delta.
  if (before?.present === false && after?.present === true
    && (after.sourceFolded === null || after.sourceFolded === undefined)
    && (after.foldedKeys ?? 0) === 0
    && (after.orderByKeys ?? 0) === 0
    && (after.serverOrder ?? 0) === 0
    && (after.sidebarWidth === null || after.sidebarWidth === undefined)
    && (after.parseError === undefined || after.parseError === null)) return null
  const fingerprintBefore = viewPrefsFingerprint(before)
  const fingerprintAfter = viewPrefsFingerprint(after)
  if (fingerprintBefore === null || fingerprintAfter === null || fingerprintBefore === fingerprintAfter) return null
  const show = value => (value === undefined || value === null ? 'null' : JSON.stringify(value))
  const fields = ['v', 'sourceFolded', 'foldedKeys', 'sidebarWidth', 'serverOrder', 'orderByKeys']
  const changed = fields.filter(field => show(before?.[field]) !== show(after?.[field]))
    .map(field => `${field} ${show(before?.[field])}→${show(after?.[field])}`)
  return changed.length > 0 ? changed.join('，') : `${fingerprintBefore} → ${fingerprintAfter}`
}

/**
 * W-4's verdict, anchored on the SHELL EFFECT rather than on the clicked
 * element's own attribute.
 *
 * Judged effects (`DOM_FACTS`): the official frame attribute
 * `[data-sidebar-collapsed]` (the official frame attribute) must APPEAR on the
 * collapse click and DISAPPEAR on the
 * restore click, and the sidebar's `[data-chamber-section]` population is
 * reported alongside. A click that leaves the attribute untouched is a FAIL —
 * that is exactly how the old leg's silent mis-target (source-section fold)
 * would be caught today.
 *
 * The leg also asserts the WRITE boundary: design 06 §3.1 keeps the collapsed
 * state in the store (it is never persisted, only the dragged width is), so a
 * visible change in `dsh-chamber.sidebar.v1` across either click is a FAIL.
 * @param args.pick - result of `pickRailToggle`.
 * @param args.identity - descriptor of the element actually clicked.
 * @param args.drift - whether the click had to be re-located by identity.
 * @param args.before/after/restored - `DOM_FACTS` snapshots around the two clicks.
 * @param args.restoredVia - how the restore click was delivered ('stash' | 'rescan' | 'none').
 * @param args.prefs - `{ before, after, restored }` `VIEW_PREFS` snapshots.
 * @param args.note - walkthrough-side explanation appended to the evidence.
 * @returns `{ ok, evidence }` (`ok === null` is INFO; W-4 never reports INFO:
 *   the control exists in both sidebar states, so "not located" is a FAIL).
 */
export function railToggleVerdict({ pick, identity = null, drift = false, before = null, after = null, restored = null, restoredVia = 'stash', prefs = null, note = '' }) {
  if (pick?.ok !== true) {
    const seen = (pick?.candidates ?? []).slice(0, 4).map(describeButton).join(' | ') || '（无）'
    return {
      ok: false,
      evidence: `未定位到侧栏导轨开关（${pick?.reason ?? 'unknown'}）：它在展开态与 rail 态都存在，属壳契约；候选=${seen}${noteTail(note)}`,
    }
  }
  const clicked = `clicked=${describeButton(identity ?? pick.picked)}${drift ? '（索引漂移，已按身份重定位）' : ''}`
  const trail = `[data-sidebar-collapsed] ${before?.railCollapsed} → ${after?.railCollapsed} → ${restored?.railCollapsed}`
  const counts = `[data-chamber-section] ${before?.sections ?? '?'} → ${after?.sections ?? '?'} → ${restored?.sections ?? '?'}；settingsOpen=${restored?.settingsOpen ?? '?'}`
  // The collapse fact must be a boolean on all three snapshots; a missing one is
  // "not checked", and must not be reported as "the click did not collapse"
  // (that message would accuse the product of the tool's own unreadable input).
  if (typeof before?.railCollapsed !== 'boolean' || typeof after?.railCollapsed !== 'boolean' || typeof restored?.railCollapsed !== 'boolean') {
    return {
      ok: false,
      evidence: `壳折叠状态不可读（[data-sidebar-collapsed]=${before?.railCollapsed} → ${after?.railCollapsed} → ${restored?.railCollapsed}）：读不到该官方属性即 FAIL；${clicked}${noteTail(note)}`,
    }
  }
  if (before.railCollapsed === after.railCollapsed) {
    return {
      ok: false,
      evidence: `点击未折叠：${trail}（${clicked}）——点到的不是导轨开关，效果没发生即 FAIL；${counts}${noteTail(note)}`,
    }
  }
  if (restored?.railCollapsed !== before?.railCollapsed) {
    return {
      ok: false,
      evidence: `复原失败：${trail}（复原路径=${restoredVia}，${clicked}）；${counts}${noteTail(note)}`,
    }
  }
  if (prefs !== null) {
    const unreadable = ['before', 'after', 'restored'].filter(side => viewPrefsUnreadable(prefs[side]))
    if (unreadable.length > 0) {
      return {
        ok: false,
        evidence: `写入边界不可判：偏好快照读不到（${unreadable.join('、')}）——本次运行证明不了"点击没写用户状态"，按未检查处理；${clicked}；${trail}${noteTail(note)}`,
      }
    }
    const wrote = viewPrefsDelta(prefs.before, prefs.after) ?? viewPrefsDelta(prefs.before, prefs.restored)
    if (wrote !== null) {
      return {
        ok: false,
        evidence: `持久化边界被破坏：本次点击写入了 dsh-chamber.sidebar.v1（${wrote}）——design 06 §3.1 只持久化拖拽宽度，折叠态留在 store；${clicked}；${trail}${noteTail(note)}`,
      }
    }
  }
  const via = restoredVia === 'stash' ? '' : `；复原路径=${restoredVia}`
  const writeNote = prefs === null ? '' : '；持久化偏好未变'
  return { ok: true, evidence: `${clicked}；${trail}；${counts}${via}${writeNote}${noteTail(note)}` }
}

/**
 * W-4a's verdict: source-section fold (design 06 §2.4 — its own leg with
 * §2.4's own criterion).
 *
 * §2.4 requires the click to collapse the source's ENTIRE workspace list, so the
 * disclosure attribute alone is not enough: the section's rendered height must
 * SHRINK and come back on expand. A flip with no visible change is a FAIL — the
 * same "flipped something, proved nothing" shape the rail leg must avoid.
 * @param args.executed - whether the leg ran at all (it writes the persisted
 *   `sourceFolded` preference, so `--attach` records INFO instead).
 * @param args.reason - why it did not run (INFO evidence).
 * @param args.before/after/restored - `SOURCE_FOLD_FACTS` snapshots.
 * @param args.drift - whether a click had to be re-located by identity.
 * @param args.prefs - `{ before, after }` `VIEW_PREFS` snapshots taken AFTER the
 *   normalisation click and AFTER the round trip: the fold is a persisted
 *   preference; the round trip must leave the stored value exactly as it was.
 * @returns `{ ok, evidence }`.
 */
export function sourceFoldVerdict({ executed = false, reason = '', identity = null, drift = false, before = null, after = null, restored = null, prefs = null }) {
  if (executed !== true) return { ok: null, evidence: `未执行：${reason}` }
  const fn = `aria-expanded ${before?.expanded} → ${after?.expanded} → ${restored?.expanded}`
  const px = `来源节高度 ${before?.height} → ${after?.height} → ${restored?.height} px`
  const clicked = identity === null ? '' : `（${describeButton(identity)}${drift ? '，索引漂移已按身份重定位' : ''}）`
  // The geometry IS the criterion here (design 06 §2.4 judges the collapsed
  // LIST): an unreadable height must fail closed — `NaN <= 1` and `NaN > 1` are
  // both false, so a malformed snapshot would otherwise pass every gate below.
  if (![before?.height, after?.height, restored?.height].every(Number.isFinite)) {
    return {
      ok: false,
      evidence: `来源节几何不可读（height=${before?.height} → ${after?.height} → ${restored?.height}）：本腿判"列表真的收拢了"，读不到几何即 FAIL；${fn}${clicked}`,
    }
  }
  if (before?.expanded !== true) {
    return { ok: false, evidence: `起始态不是展开：${fn}${clicked}，无法判定收拢方向` }
  }
  if (after?.expanded !== false || (before.height - after.height) <= 1) {
    return {
      ok: false,
      evidence: `点击后未收拢：${fn}，${px}${clicked} —— design 06 §2.4 要求收拢该来源的整个列表，开关翻转而列表没动同样算 FAIL`,
    }
  }
  if (restored?.expanded !== true || Math.abs(restored.height - before.height) > 1) {
    return { ok: false, evidence: `展开未恢复：${fn}，${px}${clicked}` }
  }
  if (prefs !== null) {
    const unreadable = ['before', 'after'].filter(side => viewPrefsUnreadable(prefs[side]))
    if (unreadable.length > 0) {
      return {
        ok: false,
        evidence: `写入边界不可判：偏好快照读不到（${unreadable.join('、')}）——往返是否留下残留无法证明，按未检查处理；${fn}，${px}${clicked}`,
      }
    }
    const residue = viewPrefsDelta(prefs.before, prefs.after)
    if (residue !== null) {
      return {
        ok: false,
        evidence: `收拢偏好未复原：往返后 dsh-chamber.sidebar.v1 仍有残留（${residue}）——design 06 §3.1 的 sourceFolded 只在收拢期存在；${fn}，${px}${clicked}`,
      }
    }
  }
  const writeNote = prefs === null ? '' : '；收拢往返后持久化偏好未变'
  return { ok: true, evidence: `${fn}；${px}；行 ${before?.rows ?? '?'} → ${after?.rows ?? '?'} → ${restored?.rows ?? '?'}${clicked}${writeNote}` }
}

/**
 * Opt-in strictness for legs that may legitimately not run (`--require-hover`).
 *
 * A verdict of `ok === null` is INFO: the environment did not offer the thing
 * the leg judges (here: no cardable row), so the leg decided nothing. INFO keeps
 * a run green by design, which is exactly how "nothing was exercised" can be
 * misread as "hover verified" — this helper turns that into a FAIL when the run
 * asked for the leg to really execute. It is a re-labelling ONLY: a verdict that
 * already decided (`ok === true` or `ok === false`) is returned untouched, so a
 * pass stays a pass and an existing failure keeps its own evidence.
 * @param verdict - `{ ok, evidence }` from any verdict function.
 * @param requireHover - whether this run demands the leg actually ran.
 * @returns the original verdict, or its FAIL re-labelling.
 */
export function applyRequireHover(verdict, requireHover) {
  if (requireHover !== true || verdict.ok !== null) return verdict
  return {
    ...verdict,
    ok: false,
    evidence: `${verdict.evidence}（--require-hover：本次运行要求 hover 腿必须真实执行）`,
  }
}

/**
 * 遮罩层叠判定（design 05 §4）。
 *
 * 断言：`.instance-loading` 可见期间，租客壳（`.instance-shell` / `[data-instance]`
 * 子树）的任何元素都不得画在它之上——这正是"白屏里出现输入栏"缺陷的核心不变量。
 * 源码锁在 `packages/renderer/test/wiring/veil-layering-invariants.test.ts`，
 * 运行时命中判定由本函数承担。
 *
 * 采样由页面侧探针完成（`walkthrough.mjs` 的 `VEIL_LAYERING_PROBE_INSTALL` /
 * `VEIL_LAYERING_PROBE_READ`）：遮罩可见的那些帧里，对 composer 座 / 输入区 /
 * 会话流等已登记锚点各做一次 `elementFromPoint`，按命中面归属归并计数。本函数只做判定，
 * 因此可在 CI 单测（`checks.test.mjs`）。
 *
 * @param facts.veilFrames - 探测窗内观察到遮罩的帧数（0 ⇒ 本次无从判定，INFO）。
 * @param facts.samples - `[{ point, winner, count, hit? }]`，`winner ∈ 'veil' | 'tenant' | 'portal' | 'none'`；
 *   `portal` = 文档级 body portal（已登记残余，只记不判）；`none` = 该点无命中，不判。
 * @returns `{ ok, evidence }`；`ok === null` 是 INFO（本次未执行/无法判定），不是通过。
 */
export function veilLayeringVerdict({ veilFrames = 0, samples = [], error = null, heldFrames = 0, bootFrames = 0 } = {}) {
  // 探针异常一律 fail-closed 成 INFO：否则前半窗采到的 veil 采样
  // 会让一条已经坏掉的探针给出 PASS 标题，而"探针坏了"只躺在 evidence 里。
  if (error !== null && error !== undefined && String(error) !== '') {
    return { ok: null, evidence: `探针异常（${String(error)}）：本次层叠判定未执行——"探针坏了"不得读成通过` }
  }
  if (veilFrames === 0) {
    return { ok: null, evidence: '本次运行未观察到遮罩（无冷 boot / 无持有期）：层叠判定不适用' }
  }
  const judged = samples.filter(sample => sample !== null && typeof sample === 'object' && sample.winner !== 'none')
  if (judged.length === 0) {
    return { ok: null, evidence: `遮罩可见 ${veilFrames} 帧，但没有任何可采样锚点（composer 座/输入区/会话流不在 DOM）` }
  }
  const tenants = judged.filter(sample => sample.winner === 'tenant')
  const portals = judged.filter(sample => sample.winner === 'portal')
  if (tenants.length > 0) {
    const hits = tenants.reduce((sum, sample) => sum + (Number.isFinite(sample.count) ? sample.count : 1), 0)
    const detail = tenants.map(sample => `${sample.point}(${sample.hit ?? '未知元素'})`).join('、')
    return {
      ok: false,
      evidence: `遮罩可见时租客元素仍画在其上：${detail}；累计 ${hits} 次采样——检查 .instance-shell 的 isolation 与 'cut' 过渡作用域`,
    }
  }
  const note = portals.length > 0
    ? `；另有 ${portals.length} 个采样点命中文档级浮层（body portal，已登记残余，非本门判据）`
    : ''
  const split = heldFrames + bootFrames > 0
    ? `；其中持有态 ${heldFrames} 帧 / boot 段 ${bootFrames} 帧（持有态里租客被隐藏、不参与命中测试 ⇒ 该段 PASS 只证明"遮罩盖住锚点"，boot 段的 PASS 才有完整判别力）`
    : ''
  return {
    ok: true,
    evidence: `遮罩 ${veilFrames} 帧内 ${judged.length} 个采样组（锚点×归属）均由遮罩获胜（命中 .instance-loading）${note}${split}`,
  }
}


// ============================================================================
// ARCHIVED v2 embedded browser (design 28 §16, iframe era): pure judgement for
// W-13 / W-14a / W-14b / W-15 / W-15b. The iframe carrier is retired (ADR-0004)
// and these five verdicts judge facts the v3 native guest can NEVER produce
// (iframe count / data-sidebar-browser-frame / sandbox / referrerpolicy) — a
// green run here proves the v2 carrier, not v3 acceptance. They remain only as
// the frozen Electron CDP leg's judgement (walkthrough.mjs is ARCHIVED too) for
// revival reference; v3 criteria = docs/checklists/acceptance/
// remote-browser-acceptance.md §E2 (guest, real machine). SH-7 (below) and the
// pure locator/URL predicates stay LIVE for v3. No DOM, no HTTP, no CDP — the
// walkthrough gathers facts, these functions decide, and checks.test.mjs runs
// them in CI (including the REAL page expressions against a fake DOM).
// ============================================================================

/**
 * ARCHIVED (v2 iframe carrier; ADR-0004 retired it): the upstream-fork iframe
 * marker/sandbox/referrer values the archived Electron CDP walkthrough asserted
 * (design 28 §16). v3 carries the page in a child WKWebView guest, where none of
 * these DOM attributes exist, so this mirror is v2 revival reference only; the
 * live v3 values are the bridge/wire contracts, not iframe attributes.
 *
 * Kept here instead of importing the browser package: checks.mjs is the
 * dependency-free judgement layer and the package is a source-only renderer
 * package. The mirrored iframe constants are frozen with the archived leg
 * (`view/IframePresentation.ts` no longer exists); checks.test.mjs still mirrors
 * the LIVE pieces from `view/BrowserBody.tsx`, `definition.tsx`,
 * `shared/source.ts` and `browser/ForwardFrameResolver.ts`, plus the vendored
 * upstream guide/chip markers.
 *
 * The self-built v2 launcher UI (panel marker / data-frame-phase / remote
 * sections / attached rows / XFO projection) is GONE; these verdicts judged the
 * upstream iframe fork's DOM/behavior instead of fake self-built anchors. v3
 * judges guest/wire facts, not DOM (acceptance §E2).
 */
/** Alias octet range of the per-source forward hosts (wire FORWARD_ALIAS_OCTETS). */
const BROWSER_ALIAS_MIN_OCTET = 2
const BROWSER_ALIAS_MAX_OCTET = 254

/** `127.0.0.2` .. `127.0.0.254` (never 127.0.0.1, never another 127/8). */
const BROWSER_ALIAS_HOST = /^127\.0\.0\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/u

/**
 * The RETIRED v2 desktop `frame-src` set (design 28 §16.3, iframe era): the
 * wire's `forwardFrameSources()` (blob: + 127.0.0.1 + localhost + the 253
 * aliases) followed by the two bare scheme sources v2 desktop main/sidecar
 * appended because the upstream iframe browser could frame ANY http(s) page.
 *
 * KEPT ONLY AS THE SH-7 NEGATIVE FIXTURE. v3 (design 28 §5「CSP」, ADR-0004)
 * retired the iframe carrier for the Swift native guest — a top-level document
 * that `frame-src` does not constrain — so no startup point passes
 * `ControlPlaneOptions.frameSources` any more and this set appearing in a shell
 * header is a FAIL (re-enabled widening = regression).
 */
export const BROWSER_FRAME_CSP_SOURCES = Object.freeze([
  'blob:',
  'http://127.0.0.1:*',
  'http://localhost:*',
  ...Array.from(
    { length: BROWSER_ALIAS_MAX_OCTET - BROWSER_ALIAS_MIN_OCTET + 1 },
    (_unused, index) => 'http://127.0.0.' + String(index + BROWSER_ALIAS_MIN_OCTET) + ':*',
  ),
  'http:',
  'https:',
])

/** Size ceiling of the shell CSP header (defensive: the short claim is tiny; keep < 8KB). */
export const BROWSER_FRAME_CSP_MAX_BYTES = 8_192

/**
 * The v3 desktop short `frame-src` claim (design 28 §5「CSP」): the
 * control-plane default, document previews only. Every deployment (desktop,
 * gateway, cli, standalone) carries exactly this now — SH-7 demands it verbatim.
 */
export const BROWSER_FRAME_CSP_V1 = Object.freeze(['blob:'])

/**
 * Whether a source id carries a remote-loopback forward leg (design 28 §16.2):
 * `local` never does; `dsh-<id>` / `gateway-<id>` do; anything else is unknown
 * (null) and the caller must fail closed rather than guess.
 * @param sourceId - an instance's `data-instance` / a boot source id.
 * @returns true/false, or null for an unreadable source id.
 */
export function sourceIdAllowsForward(sourceId) {
  if (typeof sourceId !== 'string' || sourceId === '') return null
  if (sourceId === 'local') return false
  return /^(?:dsh|gateway|ssh)-[A-Za-z0-9_-]{1,64}$/u.test(sourceId) ? true : null
}

/** Whether a frame URL points at one of this app's own per-source aliases. */
export function isAliasFrameUrl(value) {
  if (typeof value !== 'string' || value === '') return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return BROWSER_ALIAS_HOST.test(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * Whether an iframe src is the W-14a fixture document: same origin as the
 * fixture and the root path. The fixture's own origin is generated per run, so
 * only the runner knows it; comparing origins (not a fixed string) is the
 * contract here.
 */
export function isLocalFixtureUrl(value, fixtureOrigin) {
  if (typeof value !== 'string' || typeof fixtureOrigin !== 'string') return false
  try {
    const frame = new URL(value)
    const fixture = new URL(fixtureOrigin)
    return frame.origin === fixture.origin
      && frame.pathname === '/'
      && frame.search === ''
      && frame.hash === ''
  } catch {
    return false
  }
}

export const BROWSER_FRAME_CONTRACT = Object.freeze({
  /** The upstream iframe dataset marker (IframePresentation.ts). */
  frameMarker: 'data-sidebar-browser-frame',
  /** Its upstream value (dataset assignment), not merely presence. */
  frameMarkerValue: 'iframe',
  /** Exact sandbox attribute (upstream WEB_BROWSER_SANDBOX, order included). */
  sandbox: 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox',
  sandboxTokens: Object.freeze([
    'allow-scripts', 'allow-forms', 'allow-same-origin', 'allow-popups', 'allow-popups-to-escape-sandbox',
  ]),
  /** Exact referrerpolicy attribute (upstream IframePresentation). */
  referrerPolicy: 'no-referrer',
  /** The guide/chip registry kind: the FORK keeps upstream's 'browser'. */
  guideEntryKind: 'browser',
})

/**
 * The upstream address input's localized aria-label/placeholder. The guide,
 * toolbar and body are addressed by STRUCTURE + these upstream labels, never
 * by document order or by a test-only hook.
 */
export const BROWSER_ADDRESS_LABELS = Object.freeze(['输入 HTTP(S) 地址', 'Enter an HTTP(S) address'])

/** Upstream toolbar control labels per role (zh/en; the run's locale is zh). */
export const BROWSER_TOOLBAR_LABELS = Object.freeze({
  back: Object.freeze(['后退', 'Back']),
  forward: Object.freeze(['前进', 'Forward']),
  reload: Object.freeze(['刷新', 'Reload']),
  go: Object.freeze(['前往', 'Go']),
  external: Object.freeze(['在系统浏览器中打开', 'Open in system browser']),
})

/** Whether one label belongs to a role's upstream allowlist. */
export function isBrowserLabel(labels, value) {
  return typeof value === 'string' && Array.isArray(labels) && labels.includes(value)
}

/**
 * The W-13 entry locator: the visible right-sidebar guide capsule whose marker
 * is the tab KIND (upstream GuideBody renders `data-sidebar-right-guide-entry=
 * {entry.kind}`). Never by translated label, never by document index; several
 * visible candidates fail closed.
 * @param entries - descriptor dump `{ index, kind, visible }`.
 * @param opts.expectedKind - the tab kind (defaults to the contract 'browser').
 * @returns `{ ok, picked?, reason?, candidates }`; `ok: false` = NOT LOCATED.
 */
export function pickBrowserGuideEntry(entries, { expectedKind = BROWSER_FRAME_CONTRACT.guideEntryKind } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const candidates = list.filter(entry =>
    entry !== null && typeof entry === 'object'
    && entry.kind === expectedKind
    && entry.visible === true)
  if (candidates.length === 0) return { ok: false, reason: 'no-entry', candidates: [] }
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous', candidates }
  return { ok: true, picked: candidates[0], candidates }
}

/** One upstream BrowserBody's facts from BROWSER_LANDSCAPE's `bodies`. */
function firstBody(bodies) {
  return Array.isArray(bodies) && bodies.length === 1 ? bodies[0] : null
}

/**
 * ARCHIVED（v2 iframe 判据）W-13's verdict: the upstream Browser surface STRUCTURE (design 28 §16.9).
 * v3 的 W-13 = 面板结构 + 占位几何，见 acceptance §E2 步 1；本判据的 sandbox 开关在 v3 不存在。
 *
 * Judged facts (reported by the page dump, decided here):
 *  - a visible Session's right sidebar is open (upstream renders the surface
 *    per Session; a collapsed panel is not a pass);
 *  - exactly ONE upstream BrowserBody (located by its address input, upstream
 *    BrowserBody.tsx), visible, with every upstream toolbar role present;
 *  - the address input carries the upstream placeholder aria-label;
 *  - the sandbox toggle exists and reports the default ON state
 *    (aria-pressed=true after the upstream iframe provider's sandboxEnabled);
 *  - the content region's aria-busy is readable.
 * No iframe is required at this point: the guide tab is a doorway, and an
 * iframe only exists after a navigation.
 *
 * A missing session surface is INFO (design 28 §10: no Session, no surface). A
 * visible session whose entry cannot be located or whose click produces no body
 * IS a FAIL — the entry is the contract this leg exists for.
 * @param facts - BROWSER_LANDSCAPE facts (walkthrough.mjs) or the fake-DOM subset.
 * @param facts.entryPick - result of {@link pickBrowserGuideEntry} (or null).
 * @param facts.openedVia - 'existing' | 'clicked-entry' | 'none' (diagnostic).
 * @returns `{ ok, evidence }` (`ok === null` is INFO).
 */
export function browserPanelVerdict({
  hasActiveView = false,
  activeSource = null,
  sessionPresent = false,
  sessionOpen = false,
  entryPick = null,
  openedVia = 'none',
  bodyCount = 0,
  bodies = [],
  frames = [],
} = {}) {
  if (hasActiveView !== true) {
    return { ok: false, evidence: '没有可见的 [data-instance] 实例视图：N-ctx 窗口里找不到活动来源（见 W-1）' }
  }
  if (sessionPresent !== true) {
    return {
      ok: null,
      evidence: '未执行：来源 ' + JSON.stringify(activeSource) + ' 没有可见 Session 的右栏 surface（design 28 §10：无 Session/右栏收起时不渲染），本腿无法进入浏览器页签',
    }
  }
  const where = '来源 ' + JSON.stringify(activeSource) + ' 会话' + (sessionOpen === true ? '已展开' : '未展开')
  if (sessionOpen !== true) {
    return { ok: false, evidence: where + '；右栏面板未展开，upstream BrowserBody 不渲染' }
  }
  if (bodyCount !== 1 || firstBody(bodies) === null) {
    const reason = entryPick !== null && entryPick.ok === true
      ? '入口存在但点击后上游 BrowserBody 仍未出现（openedVia=' + openedVia + '）——页签注册/呈现断链'
      : entryPick !== null && entryPick.reason === 'ambiguous'
        ? '可见的浏览器入口候选并列（不可安全点击）'
        : '未定位到右栏浏览器入口 [data-sidebar-right-guide-entry="' + BROWSER_FRAME_CONTRACT.guideEntryKind + '"]'
    return { ok: false, evidence: where + '；' + reason + '；BrowserBody=' + bodyCount + ' iframe=' + (Array.isArray(frames) ? frames.length : 'n/a') }
  }
  const body = firstBody(bodies)
  if (body.visible !== true) {
    return { ok: false, evidence: where + '；BrowserBody 存在但不可见（隐藏视图/收起面板里的 body 不算当前来源）' }
  }
  const missing = []
  for (const role of ['back', 'forward', 'reload', 'go', 'external']) {
    if (body.toolbarRoles === null || body.toolbarRoles === undefined || body.toolbarRoles.includes(role) !== true) missing.push(role)
  }
  if (missing.length > 0) {
    return { ok: false, evidence: where + '；上游工具栏缺少控件：' + missing.join(',') + '（aria-label 未命中 upstream 文案）' }
  }
  if (body.addressInput !== true) {
    return { ok: false, evidence: where + '；BrowserBody 没有地址栏（upstream form input[aria-label=地址 placeholder]）——入口存在但不可操作' }
  }
  if (body.sandboxToggle !== true) {
    return { ok: false, evidence: where + '；BrowserBody 没有 sandbox 开关（upstream aria-pressed 控件）' }
  }
  if (body.sandboxed !== true) {
    return { ok: false, evidence: where + '；sandbox 开关初始应为开启（aria-pressed=true），实际 ' + JSON.stringify(body.sandboxed) }
  }
  if (typeof body.busy !== 'boolean') {
    return { ok: false, evidence: where + '；content 的 aria-busy 不可读（读不到不算结构成立）' }
  }
  return {
    ok: true,
    evidence: 'source=' + String(activeSource) + ' body=1 addressLabel=' + JSON.stringify(body.addressLabel)
      + ' toolbar=' + JSON.stringify(body.toolbarRoles) + ' sandboxToggle=true sandboxed=' + String(body.sandboxed)
      + ' iframe=' + (Array.isArray(frames) ? frames.length : 0) + ' openedVia=' + openedVia,
  }
}

/**
 * ARCHIVED（v2 iframe 判据）W-14a's verdict: a LOCAL fixture page really rendered inside the upstream
 * BrowserBody iframe. v3 的 W-14a = guest 真跑 + page JS 证据，见 acceptance §E2 步 2。
 *
 * Required: exactly one upstream BrowserBody/frame, the frame marker VALUE is
 * 'iframe', the src is THIS run's local fixture root, the sandbox token set and
 * referrerpolicy equal the upstream contract, the iframe is inside the browser
 * body, the address bar keeps the typed LOGICAL address (explicit http URL), and
 * the fixture's own postMessage proves the script ran. Upstream exposes no
 * title/name contract for the iframe, so those are not asserted.
 * @param facts.bodyCount - visible-session BrowserBody count.
 * @param facts.bodies - BrowserBody facts (addressValue/busy/...).
 * @param facts.frames - iframe facts (src/sandbox/referrerpolicy/markerValue/insideBody).
 * @param facts.fixtureOrigin - this run's fixture origin (http://127.0.0.1:<port>).
 * @param facts.messages - postMessage facts collected by the witness.
 * @param facts.expectedAddress - the explicit address typed into the bar.
 * @returns `{ ok, evidence }`.
 */
export function embedFrameVerdict({
  bodyCount = 0,
  bodies = [],
  frames = [],
  fixtureOrigin = '',
  messages = [],
  expectedAddress = null,
  expectedType = 'dsh-chamber-embed-probe',
  expectedMarker = 'dsh-embed-ok',
} = {}) {
  const body = firstBody(bodies)
  if (bodyCount !== 1 || body === null) {
    return { ok: false, evidence: '可见 BrowserBody 数=' + bodyCount + '：W-14a 需要恰一个可见的上游 BrowserBody' }
  }
  if (!Array.isArray(frames) || frames.length !== 1) {
    return { ok: false, evidence: 'iframe[' + BROWSER_FRAME_CONTRACT.frameMarker + '] 数=' + (Array.isArray(frames) ? frames.length : 'n/a') + '（应恰 1 个）；busy=' + JSON.stringify(body.busy) }
  }
  const frame = frames[0]
  const problems = []
  if (frame.markerValue !== BROWSER_FRAME_CONTRACT.frameMarkerValue) {
    problems.push('iframe ' + BROWSER_FRAME_CONTRACT.frameMarker + '=' + JSON.stringify(frame.markerValue) + '（upstream 值是 ' + JSON.stringify(BROWSER_FRAME_CONTRACT.frameMarkerValue) + '）')
  }
  if (frame.sandbox !== BROWSER_FRAME_CONTRACT.sandbox) {
    problems.push('sandbox=' + JSON.stringify(frame.sandbox) + ' 不是上游契约值 ' + JSON.stringify(BROWSER_FRAME_CONTRACT.sandbox))
  }
  if (frame.referrerpolicy !== BROWSER_FRAME_CONTRACT.referrerPolicy) {
    problems.push('referrerpolicy=' + JSON.stringify(frame.referrerpolicy) + ' 不是 ' + BROWSER_FRAME_CONTRACT.referrerPolicy)
  }
  if (!isLocalFixtureUrl(frame.src, fixtureOrigin)) {
    problems.push('src=' + JSON.stringify(frame.src) + ' 未指向本次 fixture ' + fixtureOrigin + '/')
  }
  if (frame.insideBody !== true) problems.push('iframe 不在 BrowserBody 的 [data-sidebar-right-tab] 内')
  const wantedAddress = expectedAddress === null ? fixtureOrigin + '/' : expectedAddress
  if (body.addressValue !== wantedAddress) {
    problems.push('地址栏=' + JSON.stringify(body.addressValue) + ' 未显示本次逻辑地址 ' + JSON.stringify(wantedAddress))
  }
  if (body.busy !== false) problems.push('content aria-busy=' + JSON.stringify(body.busy) + '（fixture 已回应，页面不应仍 busy）')
  const message = (Array.isArray(messages) ? messages : []).find(entry => {
    const data = entry?.data
    return data !== null && typeof data === 'object' && data.type === expectedType && data.marker === expectedMarker
  })
  if (message === undefined) {
    problems.push('未收到 fixture 的 postMessage（type=' + expectedType + '，marker=' + expectedMarker + '）——iframe 没真正载入并运行页面脚本')
  }
  if (problems.length > 0) return { ok: false, evidence: problems.join('；') }
  return {
    ok: true,
    evidence: 'src=' + frame.src + ' sandbox=' + JSON.stringify(frame.sandbox) + ' referrerpolicy=' + frame.referrerpolicy
      + ' address=' + JSON.stringify(body.addressValue) + ' postMessage=' + JSON.stringify(message.origin),
  }
}

/**
 * ARCHIVED（v2 iframe 判据）W-14b's verdict: a REMOTE source's loopback page embedded end-to-end through
 * main's forward lease (upstream BrowserBody iframe src = per-source alias).
 * v3 的 W-14b = guest 实际加载 alias + 页面执行证据，见 acceptance §E2 步 3。
 *
 * Required: one visible BrowserBody, exactly one marker frame whose src host is
 * a per-source ALIAS (127.0.0.2..254 — never 127.0.0.1, never the remote
 * spelling), the upstream sandbox/referrer contract, the address bar keeping the
 * LOGICAL remote address (explicit `http://127.0.0.1:<port>/`, never the alias),
 * and — when the page is the acceptance fixture — its postMessage proof. The
 * upstream fork deleted the old attached-list UI, so the lease is proven by the
 * alias iframe + message + the tab-close release leg (W-15b), not by a row.
 * @param facts.executed - whether the leg ran.
 * @param facts.reason - why not (INFO evidence).
 * @param facts.bodyCount - visible BrowserBody count.
 * @param facts.bodies - BrowserBody facts.
 * @param facts.frames - marker-iframe facts.
 * @param facts.messages - postMessage witness facts.
 * @param facts.requireMessage - demand the fixture page's own postMessage.
 * @param facts.expectedAddress - the logical address typed into the bar.
 * @returns `{ ok, evidence }` (`ok === null` is INFO).
 */
export function remoteEmbedVerdict({
  executed = false,
  reason = '',
  bodyCount = 0,
  bodies = [],
  frames = [],
  messages = null,
  requireMessage = false,
  expectedAddress = null,
} = {}) {
  if (executed !== true) return { ok: null, evidence: '未执行：' + reason }
  const body = firstBody(bodies)
  if (bodyCount !== 1 || body === null) {
    return { ok: false, evidence: '可见 BrowserBody 数=' + bodyCount + '：W-14b 需要恰一个可见的上游 BrowserBody' }
  }
  const bodyFacts = 'busy=' + JSON.stringify(body.busy) + ' failures=' + JSON.stringify((body.failureTexts ?? []).slice(0, 2))
  if (!Array.isArray(frames) || frames.length !== 1) {
    return { ok: false, evidence: 'iframe[' + BROWSER_FRAME_CONTRACT.frameMarker + '] 数=' + (Array.isArray(frames) ? frames.length : 'n/a') + '（应恰 1 个）；' + bodyFacts }
  }
  const frame = frames[0]
  const problems = []
  if (!isAliasFrameUrl(frame.src)) {
    problems.push('iframe src=' + JSON.stringify(frame.src) + ' 不是 per-source alias（127.0.0.2–254）——远端内嵌必须经 forward；' + bodyFacts)
  }
  if (frame.sandbox !== BROWSER_FRAME_CONTRACT.sandbox) {
    problems.push('sandbox=' + JSON.stringify(frame.sandbox) + ' 不是上游契约值')
  }
  if (frame.referrerpolicy !== BROWSER_FRAME_CONTRACT.referrerPolicy) {
    problems.push('referrerpolicy=' + JSON.stringify(frame.referrerpolicy) + ' 不是 ' + BROWSER_FRAME_CONTRACT.referrerPolicy)
  }
  if (frame.markerValue !== BROWSER_FRAME_CONTRACT.frameMarkerValue) {
    problems.push('iframe ' + BROWSER_FRAME_CONTRACT.frameMarker + ' 值=' + JSON.stringify(frame.markerValue))
  }
  if (body.addressValue === null || body.addressValue === undefined) {
    problems.push('地址栏值不可读（上游地址栏必须保留逻辑地址，而不是 alias）')
  } else if (expectedAddress !== null) {
    if (body.addressValue !== expectedAddress) {
      problems.push('地址栏=' + JSON.stringify(body.addressValue) + ' 未显示逻辑地址 ' + JSON.stringify(expectedAddress) + '（alias 只能出现在 iframe src）')
    }
  } else if (typeof body.addressValue === 'string' && body.addressValue.includes(frame.src === null ? '' : new URL(frame.src).hostname)) {
    problems.push('地址栏=' + JSON.stringify(body.addressValue) + ' 出现 alias 主机——逻辑地址被改写')
  }
  if (body.busy === true) problems.push('content aria-busy=true（导航未落地）')
  let messageNote = ''
  if (requireMessage === true) {
    const proof = (Array.isArray(messages) ? messages : []).find(entry => {
      const data = entry?.data
      return data !== null && typeof data === 'object' && data.type === 'dsh-chamber-embed-probe' && data.marker === 'dsh-embed-ok'
    })
    if (proof === undefined) {
      problems.push('未收到 fixture 页经 alias iframe 发回的 postMessage（引擎级证明：aliased 文档没有真正运行）')
    } else {
      messageNote = ' postMessage=' + JSON.stringify(proof.origin)
    }
  }
  if (problems.length > 0) return { ok: false, evidence: problems.join('；') }
  return {
    ok: true,
    evidence: 'src=' + frame.src + ' alias=true sandbox=' + JSON.stringify(frame.sandbox)
      + ' referrerpolicy=' + frame.referrerpolicy + ' address=' + JSON.stringify(body.addressValue) + messageNote,
  }
}

/**
 * ARCHIVED（v2 iframe 判据，v3 判据反转）W-15's verdict: the SYSTEM-BROWSER EXIT under upstream iframe semantics.
 * v2 允许「XFO 站点白屏、不承诺失败 UI」；v3 guest 是顶层文档，XFO 站点必须可见
 * （acceptance §E2 步 4），所以本判据的 XFO 半段在 v3 失效，切勿当 v3 证据。
 *
 * Upstream `ui-sidebar-browser` does NOT promise XFO/TLS failure detection: a
 * framed document that sets `X-Frame-Options: DENY` simply stays an empty
 * frame, and no failure UI is projected. The honest acceptance contract is
 * therefore:
 *  - the upstream toolbar's external control exists and is ENABLED once a target
 *    exists, and clicking it calls `window.open(externalUrl, '_blank',
 *    'noopener,noreferrer')` exactly once (the witness stubs window.open, so no
 *    real browser opens);
 *  - the page NEVER opens the system browser on its own while loading the XFO
 *    negative control;
 *  - the iframe actually attempted the explicit http XFO URL;
 *  - any upstream failure bar text is reported as OBSERVED evidence, not
 *    required — "no failure UI" is an upstream limitation, not a defect (INFO
 *    is acceptable here; the leg passes on the documented exit contract).
 * @param facts.executed - whether the leg ran.
 * @param facts.reason - why not (INFO evidence).
 * @param facts.bodyCount - visible BrowserBody count.
 * @param facts.bodies - BrowserBody facts.
 * @param facts.frames - iframe facts.
 * @param facts.expectedFrameUrl - the explicit XFO URL the iframe must load.
 * @param facts.autoOpened - window.open calls observed BEFORE the explicit click.
 * @param facts.openedAfterClick - window.open URLs observed after the click.
 * @param facts.expectedExternalUrl - the logical URL the exit must open.
 * @param facts.failureTexts - upstream failure/status texts (evidence only).
 * @returns `{ ok, evidence }` (`ok === null` is INFO).
 */
export function externalExitVerdict({
  executed = false,
  reason = '',
  bodyCount = 0,
  bodies = [],
  frames = [],
  expectedFrameUrl = null,
  autoOpened = 0,
  openedAfterClick = [],
  expectedExternalUrl = null,
  failureTexts = [],
} = {}) {
  if (executed !== true) return { ok: null, evidence: '未执行：' + reason }
  const body = firstBody(bodies)
  if (bodyCount !== 1 || body === null) {
    return { ok: false, evidence: '可见 BrowserBody 数=' + bodyCount + '：W-15 需要恰一个可见的上游 BrowserBody' }
  }
  const problems = []
  if (body.externalButton !== true) {
    problems.push('上游工具栏没有系统浏览器出口控件（aria-label 未命中 ' + JSON.stringify(BROWSER_TOOLBAR_LABELS.external) + '）')
  } else if (body.externalEnabled !== true) {
    problems.push('系统浏览器出口在有目标时仍 disabled（upstream externalUrl 未就绪）')
  }
  if (autoOpened > 0) {
    problems.push('页面装载 XFO 负例时自动打开了系统浏览器（window.open ×' + String(autoOpened) + '）——出口必须显式')
  }
  if (!Array.isArray(frames) || frames.length !== 1) {
    problems.push('iframe 数=' + (Array.isArray(frames) ? frames.length : 'n/a') + '（XFO 负例仍应留下上游 iframe）')
  } else if (expectedFrameUrl !== null && frames[0].src !== expectedFrameUrl) {
    problems.push('iframe src=' + JSON.stringify(frames[0].src) + ' 不是本次 XFO 地址 ' + JSON.stringify(expectedFrameUrl))
  }
  if (!Array.isArray(openedAfterClick) || openedAfterClick.length !== 1) {
    problems.push('点击系统浏览器出口后 window.open 次数=' + (Array.isArray(openedAfterClick) ? openedAfterClick.length : 'n/a') + '（应恰 1 次；upstream 出口走 window.open）')
  } else if (expectedExternalUrl !== null && openedAfterClick[0] !== expectedExternalUrl) {
    problems.push('window.open URL=' + JSON.stringify(openedAfterClick[0]) + ' 不是逻辑地址 ' + JSON.stringify(expectedExternalUrl))
  }
  const observed = Array.isArray(failureTexts) && failureTexts.length > 0
    ? '上游失败条=' + JSON.stringify(failureTexts.slice(0, 2))
    : '上游未投影 XFO 失败 UI（design 28：上游不承诺 XFO/TLS 探测，属 INFO 语义）'
  if (problems.length > 0) return { ok: false, evidence: problems.join('；') + '；' + observed }
  return {
    ok: true,
    evidence: 'external=present+enabled window.open=' + JSON.stringify(openedAfterClick[0]) + ' autoOpen=0 frame=' + String(frames[0].src) + '；' + observed,
  }
}

/**
 * ARCHIVED（v2 iframe 判据）W-15b's verdict: closing the Browser tab releases the tab occurrence — the
 * upstream BrowserBody and its iframe are gone, no pending rebuild shows up in
 * the settle window, and (when the run had a forward) its alias port is
 * unreachable. The upstream fork has no forward-list UI; the release is proven
 * by the removed DOM plus the alias TCP probe.
 * @param facts.executed - whether the close was driven by this run.
 * @param facts.reason - why not (INFO evidence).
 * @param facts.bodyCount - BrowserBody count after the settle window.
 * @param facts.frameCount - marker iframe count after the settle window.
 * @param facts.busy - whether any surviving body still reports aria-busy.
 * @param facts.settled - whether the immediately-after and settled snapshots agree.
 * @param facts.aliasProbe - `{ url, reachable }` when a forward alias was captured, else null.
 * @returns `{ ok, evidence }` (`ok === null` is INFO).
 */
export function closeReleaseVerdict({
  executed = false,
  reason = '',
  bodyCount = null,
  frameCount = null,
  busy = null,
  settled = null,
  aliasProbe = null,
} = {}) {
  if (executed !== true) return { ok: null, evidence: '未执行：' + reason }
  const problems = []
  if (bodyCount !== 0) problems.push('上游 BrowserBody 仍为 ' + String(bodyCount) + ' 个')
  if (frameCount !== 0) problems.push('iframe[' + BROWSER_FRAME_CONTRACT.frameMarker + '] 仍为 ' + String(frameCount) + ' 个')
  if (busy === true) problems.push('BrowserBody 仍处 aria-busy=true（有未落地的 pending 操作）')
  if (busy === null) problems.push('pending 状态不可读（读不到不算已释放）')
  if (settled !== true) problems.push('关闭后的观察窗内 BrowserBody/iframe 又出现（pending 重建）')
  if (aliasProbe !== null && aliasProbe !== undefined) {
    if (aliasProbe.reachable === 'open' || aliasProbe.reachable === true) {
      problems.push('forward alias ' + aliasProbe.url + ' 关闭页签后仍可连通——listener 未释放')
    } else if (aliasProbe.reachable !== 'closed' && aliasProbe.reachable !== false) {
      problems.push('alias 可达性未能判定（' + aliasProbe.url + '：' + String(aliasProbe.reachable) + '）——不把未知读成已释放')
    }
  }
  if (problems.length > 0) return { ok: false, evidence: problems.join('；') }
  const alias = aliasProbe === null || aliasProbe === undefined
    ? '本次无 forward（local 直连）：alias 不可达腿不适用'
    : aliasProbe.url + ' 已不可连通'
  return { ok: true, evidence: '关 tab 后 body=0 frame=0 无 pending；' + alias }
}

/**
 * Opt-in strictness for the embedded-browser legs (`--require-embed`).
 *
 * Same shape as {@link applyRequireHover}: an INFO verdict means the leg did
 * not exercise the embedding surface (no SSH source, panel not staged, panel
 * hidden...), and a green run must not read as "embedding verified". The strict
 * flag re-labels ONLY `ok === null` — a decided PASS/FAIL is returned untouched.
 * @param verdict - `{ ok, evidence }` from any embed verdict.
 * @param requireEmbed - whether this run demands the embed legs really ran.
 * @returns the original verdict, or its FAIL re-labelling.
 */
export function applyRequireEmbed(verdict, requireEmbed) {
  if (requireEmbed !== true || verdict.ok !== null) return verdict
  return {
    ...verdict,
    ok: false,
    evidence: verdict.evidence + '（--require-embed：本次运行要求内嵌腿必须真实执行）',
  }
}

/** Split a CSP header into `directive -> tokens` (first occurrence wins). */
function cspDirectives(header) {
  const directives = new Map()
  for (const part of String(header).split(';')) {
    const tokens = part.trim().split(/\s+/u).filter(Boolean)
    if (tokens.length === 0) continue
    const name = tokens[0].toLowerCase()
    if (!directives.has(name)) directives.set(name, tokens.slice(1))
  }
  return directives
}

/**
 * SH-7's verdict: the shell's CSP `frame-src` contract (design 28 §5「CSP」v3).
 *
 * ONE LEGITIMATE SHAPE (v3): the shell carries the control-plane default short
 * claim `frame-src blob:` byte-for-byte (document previews only). The embedded
 * browser is the Swift native guest carrier — a TOP-LEVEL WKWebView document,
 * not an iframe — so no startup point passes `ControlPlaneOptions.frameSources`
 * any more and `frame-src` must not be widened (design 28 §5, ADR-0004;
 * acceptance `remote-browser-acceptance.md` §E2 step 15).
 *
 * The RETIRED v2 extended set (blob: + loopback/alias hosts + bare http:/https:,
 * {@link BROWSER_FRAME_CSP_SOURCES}) MUST FAIL: its reappearance means a startup
 * point re-enabled the iframe-era widening — a regression, never INFO.
 * `'self'`/`*`/`data:`/any other host, partial lists, a weakened
 * `frame-ancestors`, a missing directive and an oversized header are FAIL too.
 * @param contentSecurityPolicy - the shell response header (or undefined).
 * @returns `{ ok, shape, evidence }` (`ok === null` stays reserved for INFO
 *   legs; SH-7 itself now always decides PASS/FAIL).
 */
export function browserFrameCspVerdict(contentSecurityPolicy) {
  const header = typeof contentSecurityPolicy === 'string' ? contentSecurityPolicy : ''
  if (header.trim() === '') {
    return { ok: false, shape: 'missing', evidence: '响应没有 Content-Security-Policy 头（SH-2 同样会红）' }
  }
  const directives = cspDirectives(header)
  const frame = directives.get('frame-src')
  const ancestors = directives.get('frame-ancestors')
  if (frame === undefined) {
    return {
      ok: false,
      shape: 'invalid',
      evidence: "CSP 缺 frame-src 指令——回落到 default-src 'self' 会拒绝一切内嵌",
    }
  }
  if (ancestors === undefined || ancestors.length !== 1 || ancestors[0] !== "'none'") {
    return {
      ok: false,
      shape: 'invalid',
      evidence: '应用自身的 frame-ancestors 合同被改弱（期望恰为 ' + JSON.stringify("'none'") + '，实际 ' + JSON.stringify(ancestors ?? null) + '）',
    }
  }
  const expected = BROWSER_FRAME_CSP_V1
  const forbidden = frame.filter(token => ["'self'", '*', 'data:'].includes(token))
  if (forbidden.length > 0) {
    return {
      ok: false,
      shape: 'invalid',
      evidence: 'frame-src 含禁止源 ' + forbidden.join(' ') + "——不得放 'self'/通配/data:（design 28 §5 v3）",
    }
  }
  const exact = frame.length === expected.length && expected.every((token, index) => frame[index] === token)
  if (exact) {
    if (header.length > BROWSER_FRAME_CSP_MAX_BYTES) {
      return {
        ok: false,
        shape: 'invalid',
        evidence: 'CSP 头 ' + String(header.length) + 'B 超过 ' + String(BROWSER_FRAME_CSP_MAX_BYTES) + 'B 上限（壳头只应有短 frame-src，plan E2 的 8KB 天花板保留）',
      }
    }
    return {
      ok: true,
      shape: 'v3',
      evidence: 'frame-src 精确等于 v3 短头（仅 blob:，头长 ' + String(header.length) + 'B ≤ ' + String(BROWSER_FRAME_CSP_MAX_BYTES) + "B），frame-ancestors 'none'；内嵌浏览器 = native guest 载体（顶层文档，不受 frame-src 约束），启动点不再传 frameSources（design 28 §5 CSP）",
    }
  }
  const missing = expected.filter(token => !frame.includes(token))
  const extra = frame.filter(token => !expected.includes(token))
  return {
    ok: false,
    shape: 'drift',
    evidence: 'frame-src 与 v3 短头（仅 blob:）不符（' + String(frame.length) + ' 源）：缺 ' + (missing.slice(0, 2).join(' ') || '（无）') + '；多 ' + (extra.slice(0, 4).join(' ') || '（无）') + (extra.length > 4 ? ' …' : '') + ' —— v2 扩展源集（loopback/alias/裸 http:/https:）在 v3 属回归 FAIL：iframe 已退役，启动点不得再传 frameSources（design 28 §5 CSP）',
  }
}

/**
 * ARCHIVED（v2 W-15 腿）: request/console noise produced by the acceptance
 * fixture itself (W-15's XFO negative control). Scoped by the fixture-only path
 * segment `/embed-xfo`: Chromium's refusal of that framed document is the
 * criterion W-15 judges, so the global W-11/W-12 gates must not call it an
 * unexpected failure. A normal request is never tolerated. v3 guest loads XFO
 * pages top-level (acceptance §E2 step 4), so this noise rule has no v3 leg.
 */
export const EXPECTED_FIXTURE_REQUEST_FAILURES = Object.freeze([
  Object.freeze({
    pattern: /\/embed-xfo(?:\?|#|$)/,
    reason: 'W-15 的 XFO 负例 fixture 自身的子 frame 装载失败（判据在 W-15：上游不承诺失败 UI，系统浏览器出口必须显式且不自动打开）',
  }),
])

/** ARCHIVED（v2 W-15 腿）: console noise of the same fixture (Chromium's "Refused to display" log). */
export const EXPECTED_FIXTURE_CONSOLE_NOISE = Object.freeze([
  Object.freeze({
    pattern: /Refused to display [^]*\/embed-xfo[^]*X-Frame-Options/i,
    reason: 'W-15 的 XFO 负例 fixture：Chromium 的拒绝日志是已知上游语义（上游不投影 XFO 失败），不是缺陷',
  }),
])

// ============================================================================
// W-13 prerequisite: a visible Session (design 28 §10 — the right sidebar
// renders per Session). A cold --dev instance has no workspace and no session,
// so the whole embed family would INFO out; these pure helpers decide which
// EXISTING UI control bootstraps one, the walkthrough drives the clicks.
//
// Locale coupling is explicit and allowlisted here (zh/en), the same discipline
// as the settings seat / onboarding dismiss lookups: the workspace chip, the
// directory dialog's "edit path" and "open" actions. The new-session control is
// located STRUCTURALLY by its registered shortcut (aria-keyshortcuts
// Control+N / Meta+N) and only falls back to the label allowlist.
// ============================================================================

/** Hero workspace chip aria-labels (zh/en) — "choose workspace" when none is picked. */
export const WORKSPACE_CHIP_LABELS = Object.freeze(['选择工作区', 'Choose workspace'])
/** Directory-browser path-edit control labels (zh/en). */
export const DIRECTORY_EDIT_PATH_LABELS = Object.freeze(['编辑路径', 'Edit path'])
/** Directory-browser confirm control labels (zh/en; fallback when no primary class is readable). */
export const DIRECTORY_OPEN_LABELS = Object.freeze(['打开', 'Open'])
/** New-session control labels (zh/en) — fallback only; the shortcut attr is the structural locator. */
export const NEW_SESSION_LABELS = Object.freeze(['新建会话', '新会话', 'New session', 'New Session'])
/** Registered new-session shortcut (aria-keyshortcuts spelling, platform-dependent modifier). */
export const NEW_SESSION_KEYS = /^(?:Control|Meta)\+N$/iu

/** Area of a dumped control (for the deterministic "largest new-session button" pick). */
function controlArea(control) {
  const width = Number(control?.width)
  const height = Number(control?.height)
  return Number.isFinite(width) && Number.isFinite(height) ? width * height : 0
}

/**
 * Pick the new-session control from a descriptor dump.
 *
 * The sidebar renders TWO new-session buttons (the brand button and the
 * labelled "New session" row) plus a Control+N registration; both do the same
 * thing, so the pick is deterministic (largest area, then earliest) rather than
 * ambiguous. Shortcut match wins; the zh/en label allowlist is only a fallback
 * for builds that stop publishing aria-keyshortcuts.
 * @param buttons - descriptor dump `{ index, ariaLabel, keys, text, width, height, disabled }`.
 * @returns `{ ok, picked?, reason?, candidates }`; `ok:false` = not located.
 */
export function pickNewSessionControl(buttons) {
  const list = Array.isArray(buttons) ? buttons : []
  const usable = list.filter(button =>
    button !== null && typeof button === 'object' && button.disabled !== true)
  const byShortcut = usable.filter(button =>
    typeof button.keys === 'string' && NEW_SESSION_KEYS.test(button.keys.trim()))
  const candidates = byShortcut.length > 0 ? byShortcut : usable.filter(button =>
    NEW_SESSION_LABELS.includes(typeof button.ariaLabel === 'string' ? button.ariaLabel : ''))
  if (candidates.length === 0) return { ok: false, reason: 'no-control', candidates: [] }
  const sorted = [...candidates].sort((a, b) => controlArea(b) - controlArea(a)
    || (Number(a.index) || 0) - (Number(b.index) || 0))
  return { ok: true, picked: sorted[0], candidates: sorted }
}

/** Pick the hero workspace chip (exactly one; several visible chips fail closed). */
export function pickWorkspaceChip(buttons) {
  const list = Array.isArray(buttons) ? buttons : []
  const candidates = list.filter(button => button !== null && typeof button === 'object'
    && button.disabled !== true
    && WORKSPACE_CHIP_LABELS.includes(typeof button.ariaLabel === 'string' ? button.ariaLabel : ''))
  if (candidates.length === 0) return { ok: false, reason: 'no-control', candidates: [] }
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous', candidates }
  return { ok: true, picked: candidates[0], candidates }
}

/** Pick the directory browser's path-edit control (aria-label, exactly one). */
export function pickDirectoryEditButton(buttons) {
  const list = Array.isArray(buttons) ? buttons : []
  const candidates = list.filter(button => button !== null && typeof button === 'object'
    && button.disabled !== true
    && DIRECTORY_EDIT_PATH_LABELS.includes(typeof button.ariaLabel === 'string' ? button.ariaLabel : ''))
  if (candidates.length === 0) return { ok: false, reason: 'no-control', candidates: [] }
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous', candidates }
  return { ok: true, picked: candidates[0], candidates }
}

/**
 * Pick the directory browser's confirm ("open") control: an enabled PRIMARY
 * button (the class token is the vendor's own variant), falling back to the
 * zh/en label allowlist. The walkthrough clicks it only after the path has been
 * typed — the caller fails closed when no enabled candidate exists (no target
 * yet / still loading).
 */
export function pickDirectoryOpenButton(buttons) {
  const list = Array.isArray(buttons) ? buttons : []
  const enabled = list.filter(button => button !== null && typeof button === 'object'
    && button.disabled !== true)
  const primary = enabled.filter(button => button.primary === true)
  const candidates = primary.length > 0 ? primary : enabled.filter(button =>
    DIRECTORY_OPEN_LABELS.includes(typeof button.text === 'string' ? button.text : ''))
  if (candidates.length === 0) return { ok: false, reason: 'no-control', candidates: [] }
  return { ok: true, picked: candidates[candidates.length - 1], candidates }
}

/**
 * W-13 prerequisite verdict: after the bootstrap attempt there must be a
 * visible Session (the right sidebar surface exists).
 *
 * `executed:false` is INFO: `--attach` never creates or switches sessions (that
 * writes the real instance's state), so the operator must select one; the
 * `--require-embed` strict flag re-labels that INFO to FAIL.
 * @param facts.executed - whether this run drove the bootstrap UI.
 * @param facts.reason - why it did not run (INFO evidence).
 * @param facts.sessionPresent - whether a visible `[data-sidebar-right-session]` exists afterwards.
 * @param facts.via - 'existing' | 'new-session' | 'workspace-created' | 'none'.
 * @param facts.note - bootstrap-side explanation appended to the evidence.
 * @returns `{ ok, evidence }` (`ok === null` is INFO).
 */
export function sessionBootstrapVerdict({
  executed = false,
  reason = '',
  sessionPresent = false,
  via = 'none',
  note = '',
} = {}) {
  const tail = note === '' ? '' : '；' + note
  if (executed !== true) return { ok: null, evidence: '未执行：' + reason }
  if (sessionPresent === true) {
    return { ok: true, evidence: '已有可见 Session（via=' + via + '）' + tail }
  }
  return {
    ok: false,
    evidence: '仍没有可见 Session（via=' + via + '）' + tail
      + '——右栏 surface 按 Session 渲染（design 28 §10），W-13 无法进入浏览器页签',
  }
}

/**
 * Run-scoped fixture noise rules (W-11/W-12 hygiene).
 *
 * The fixture's XFO negative control is EXPECTED to be refused by the engine,
 * and Chromium reports the refusal against the fixture origin (the console line
 * may name the framed origin's root while the failed navigation names the XFO
 * path). The static rules in EXPECTED_FIXTURE_* cover the canonical spellings;
 * these rules scope the SAME acceptance-owned noise to THIS RUN's random
 * origin — an unrelated page refusing framing can never be tolerated by it.
 * @param fixtureOrigin - the live fixture origin ('http://127.0.0.1:<port>') or ''.
 * @returns request/console rule lists for partitionFailures.
 */
export function fixtureNoiseRules(fixtureOrigin) {
  if (typeof fixtureOrigin !== 'string' || fixtureOrigin === '') return { request: [], console: [] }
  const escaped = fixtureOrigin.replace(/[.*+?^$()|[\]\\]/gu, '\\$&')
  const reason = 'W-15 的 XFO 负例 fixture（本次运行 ' + fixtureOrigin + '）：拒绝装载是判据输入，不是未预期失败'
  return {
    request: [{ pattern: new RegExp('FAILED\\([^)]*\\)[^]*' + escaped), reason }],
    console: [{ pattern: new RegExp('Refused to display [^]*' + escaped + '[^]*X-Frame-Options', 'iu'), reason }],
  }
}
