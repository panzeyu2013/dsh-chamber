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
const PLUGIN_LOADER_ATTRIBUTE = /(?:src|href)="(\/plugins\/\?\?[^"]+)"/g

/** Root-absolute asset urls declared by a shell index.html. */
export function parseShellAssets(html) {
  return [...html.matchAll(ASSET_ATTRIBUTE)].map(match => match[1])
}

/** Instance-relative asset urls declared by a proxied dsh index.html. */
export function parseInstanceAssets(html) {
  return [...html.matchAll(RELATIVE_ASSET_ATTRIBUTE)].map(match => match[1])
}

/**
 * Multi-entry plugin loader urls. The `rev` query is part of the contract: the
 * instance answers 404 for the same path without it, so the declared URL — not a
 * hand-built one — is what the acceptance run must probe.
 */
export function parsePluginLoaderUrls(html) {
  return [...html.matchAll(PLUGIN_LOADER_ATTRIBUTE)].map(match => match[1].replace(/&amp;/g, '&'))
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
    // design 09 §3.2 (client/serving-gate.ts header): "A cold-started instance
    // answers clientGraph/graph with 503 instance_unavailable (the reverse proxy
    // refuses to forward while the managed dsh is not serving yet)."
    pattern: /503 \S*\/api\/i\/[^/]+\/api\/clientGraph\/graph$/,
    reason: '冷启动期实例未 serving：clientGraph/graph 503 属 design 09 §3.2 预期',
  },
  {
    // Chromium records a CLIENT-side abort as `net::ERR_ABORTED`; the health
    // stream is re-subscribed by the app (e.g. when the settings surface mounts
    // its source), so the previous connection is torn down by the page itself.
    // A server-side drop shows up as a status code or another error string and
    // stays a failure.
    pattern: /^FAILED\(net::ERR_ABORTED\) \S*\/api\/host\/health-events$/,
    reason: 'SSE 流由页面自身重订阅/关闭：浏览器记 net::ERR_ABORTED，非服务端错误',
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
 * `workspace.title` / `sessionTitleText` (ServerSection.tsx:1752 / :2090), the
 * same value the row itself renders (`cc.workspaceTitle` :1566 / `cc.sessionTitle`
 * :1949) — and every card is rendered inside `[data-chamber-hovercard]`
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
 * a build that does not stamp the marker (the pre-fix vendored atom) has to be
 * told apart from an instance that genuinely has no cardable row: `anchorCount`
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
 * measured. These are the historical fixed band: they only discriminate when the
 * dwell→commit latency happens to be at least as large, which is why the
 * walkthrough now measures the window first and treats this as a fallback.
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
 * WHY DERIVED, NOT FIXED (adversarial review, finding H5/#3): a strand needs the
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
 * HONESTY (finding H5/#3): the leg only proves something when the leave offsets
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
 * label that flips between `toggle.collapse` / `toggle.open`. The mobile
 * substitute states the reason explicitly (`MobileNavToggle.tsx`): the official
 * control "carries that label alone, because it sits inside the sidebar it
 * collapses", so the OUT-OF-CANVAS substitute had to add the disclosure state
 * itself. Selecting "the first `aria-expanded` control in the left half" could
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
  // instead of silently taking the first one (the defect this policy replaces).
  if (tied.length > 1) return { ok: false, reason: 'ambiguous', picked: tied[0], candidates: sorted }
  return { ok: true, picked: sorted[0], candidates: sorted }
}

/**
 * Adapter between the merged facts expression and the rail verdicts: `DOM_FACTS`
 * names the sidebar population `sidebarSources`/`sidebarRows`, the verdicts read a
 * small stable snapshot (`sections`/`rows`). Keeping the mapping in one place is
 * what makes the merge safe — the first merged run reported
 * `[data-chamber-section] undefined → undefined → undefined` because the two
 * names had drifted apart.
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
 * `[data-sidebar-collapsed]` (the contract the mobile plugin already consumes,
 * `layout-facts.ts`) must APPEAR on the collapse click and DISAPPEAR on the
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
 * W-4a's verdict: source-section fold (design 06 §2.4 — the control the old
 * W-4 selector hit by accident, kept as its own leg with §2.4's own criterion).
 *
 * §2.4 requires the click to collapse the source's ENTIRE workspace list, so the
 * disclosure attribute alone is not enough: the section's rendered height must
 * SHRINK and come back on expand. A flip with no visible change is a FAIL — the
 * same "flipped something, proved nothing" shape the rail leg was fixed for.
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
