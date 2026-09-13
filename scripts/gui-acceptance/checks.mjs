/**
 * Pure judgement layer of the GUI acceptance toolbox: every predicate and every
 * report renderer lives here, with no HTTP, DOM or CDP access — so the whole
 * judgement surface is unit-testable in CI (see gui-acceptance.test.mjs) while
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
