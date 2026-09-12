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
