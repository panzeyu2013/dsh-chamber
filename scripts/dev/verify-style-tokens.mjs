/**
 * Upstream design-token conformance gate (S1–S7).
 *
 * chamber injects its own components into the dsh document, so its stylesheets
 * are bound by dsh's styling rules — the pinned upstream tree's
 * `docs/web-styling.md`. Upstream enforces those rules with specs that scan
 * `packages/` OF THE UPSTREAM REPO (ui-theme's elevation / corner-shape /
 * scrollbar specs). chamber's packages sit outside that scan, which is how a
 * batch of violations shipped unnoticed (2026-09 style review). This gate
 * applies the same rules across EVERY chamber package and every file kind that
 * can carry CSS (`.css`, `.ts`, `.tsx`, `.html` — the gateway login page and
 * the mobile plugin both carry stylesheets as strings, which a CSS-only scan
 * never sees).
 *
 *   S1  no `var(--dsw-*)` / `var(--dsh-*)` reference to a name the upstream
 *       tree does not declare. A misspelled alias does NOT fail loudly in the
 *       browser: it either falls back to a literal or drops the declaration,
 *       so the surface silently renders unthemed. This is the check that
 *       catches `--dsw-alias-state-warning-primary` (upstream spells it
 *       `…-state-warn-…`; the wrong name silently defused every warning
 *       affordance that used it).
 *       Scope note: the scan is over raw file text, COMMENTS INCLUDED — a
 *       comment that names a retired spelling is a documentation bug worth
 *       correcting too, and chamber's stylesheets name tokens extensively in
 *       prose. The one legitimate case — a spec quoting a name to assert on
 *       the stylesheet — is covered by the test-fixture exclusion below.
 *   S2  namespace discipline. A custom property chamber DECLARES must either
 *       be a real upstream name (a deliberate mirror, e.g. the pre-auth login
 *       page re-declaring `--dsw-alias-*`) or carry the `--chamber-` prefix.
 *       Inventing a name inside upstream's `--dsw-`/`--dsh-` namespace risks
 *       silent collision with a future upstream token, and hides which values
 *       were sampled from dsh and which chamber chose.
 *   S3  neutral borders draw at 0.5px (upstream `wideNeutralBorders` +
 *       `wideFilledDividers`). The hairline weight is the design system's, not
 *       a preference: Chromium paints 0.5px as one device pixel, so a 1px
 *       neutral border is visibly twice as heavy on 2x displays as the
 *       surrounding dsh chrome. Dashed affordances and state-coloured borders
 *       stay 1px, and spinner ring tracks keep their width — same exemptions
 *       as upstream's spec.
 *   S4  no literal colour inside a `var(--dsw-alias-*, …)` fallback. The
 *       fallback is what let S1 hide: the alias resolved to a hardcoded value
 *       instead of failing, and that value ignored the light/dark palette.
 *   S5  no neutral `--dsw-alias-border-*` border beside an lv/elevation
 *       `box-shadow` (upstream `neutralBordersBesideElevation`). An elevated
 *       surface sets `border: 0` and lets the shadow's 0.5px first layer draw
 *       the outline; a real border beside it double-draws the stroke AND
 *       shifts layout by its width. State-coloured borders are out of scope.
 *   S6  no custom property declared in a CSS context and never read. A dead
 *       declaration is not harmless: it reads as a live knob, so the next
 *       author reuses the name expecting it to do something.
 *   S7  every effectively full-round `border-radius` pairs `corner-shape:
 *       round` in the same rule (upstream `unpairedFullRound`). ui-theme's
 *       corner-shape.css smooths every corner to a superellipse on supporting
 *       engines, which deforms a circle into a squircle — a spinner visibly
 *       wobbles — and squares off capsule ends.
 *
 * Files byte-identical to an upstream counterpart are SKIPPED: they are
 * upstream's own text, pinned by the C1 fork-purity gate, and reporting them
 * here would ask chamber to fix dsh's styles in a vendored copy.
 *
 * Read-only; no vendor writes. The upstream reference set comes from the
 * bootstrapped vendor tree, so run after `ensure-harness-vendor` (the same
 * precondition as the C-gates in verify-upstream-touchpoints.mjs).
 *
 * Usage:
 *   node scripts/dev/verify-style-tokens.mjs           # gate (exit 1 on any finding)
 *   node scripts/dev/verify-style-tokens.mjs --list    # print the upstream token set
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const UPSTREAM = join(ROOT, 'vendor/harness-checkout')
const UPSTREAM_THEME_STYLES = join(UPSTREAM, 'packages/client/ui-theme/src/styles')

/** Directories that never carry authored styles: deps, VCS, the read-only
 *  vendor tree, and build outputs (`lib/`, `dist/` mirror `src/` — the C8
 *  rebuild gate already pins that equality, so scanning them would only
 *  duplicate findings). */
const SKIP_DIRS = new Set([
  'node_modules', 'lib', 'dist', '.git', '.cache', 'release', 'vendor', 'coverage', '.vite', '.turbo',
])

/** File kinds that can carry CSS: stylesheets, CSS-in-TS template strings,
 *  and inline `<style>` blocks in generated HTML. `.mjs` is deliberately OUT —
 *  no chamber script carries a stylesheet, and this gate's own doc comments
 *  name tokens in prose (`var(--dsw-shadow-lv`), which a scan would read as a
 *  live reference. */
const STYLE_FILE = /\.(css|ts|tsx|html)$/

/**
 * Test fixtures are outside the scan面, the same convention the C10 version
 * gate uses: a spec legitimately QUOTES a token name while asserting on a
 * stylesheet (`assert.ok(!css.includes('var(--dsw-shadow-lv'))`), which would
 * otherwise read as a reference to a name nothing declares. Only shipped
 * surfaces matter here, and the tests that read a stylesheet read it from
 * `src/`, which IS scanned.
 */
const TEST_FILE = /(?:^|[/\\])test[/\\]|\.test\.(?:ts|tsx|mjs|js)$/

/**
 * Upstream names that upstream itself references without declaring. Exempting
 * them keeps this gate about CHAMBER's conformance: a finding here would
 * reproduce an upstream defect chamber cannot fix in its own packages.
 * (`--dsw-font-mono` is used by upstream feature CSS with a literal fallback
 * and declared nowhere.)
 */
const UPSTREAM_UNDECLARED_ALLOWLIST = new Set(['--dsw-font-mono'])

/**
 * Spinner ring tracks, keyed `<basename> <selector>`: the border is the drawn
 * graphic (a rotating ring), not an outline, so it keeps its width. Mirrors
 * upstream's RING_TRACKS in `ui-theme/tests/elevation-styles.client.spec.ts`;
 * add a chamber entry only when the border genuinely draws a ring.
 */
const RING_TRACKS = new Set([
  'boot-page.module.css .spinner',
  'TrajectoryTable.module.css .historyLoadingSpinner',
  'styles.css .instance-loading-spinner',
])

const args = new Set(process.argv.slice(2))

/** Hard-failure counter; `fail()` owns it so no finding can be logged without failing the run. */
let hardFails = 0

function fail(message) {
  console.error(`✗ ${message}`)
  hardFails += 1
}

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(join(dir, entry.name), out)
    } else if (STYLE_FILE.test(entry.name)) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

function repoRel(abs) {
  return relative(ROOT, abs).split(sep).join('/')
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

// ---------------------------------------------------------------------------
// Upstream reference set
// ---------------------------------------------------------------------------

/**
 * Collect every custom property the pinned dsh declares, plus the content
 * hashes of its files.
 *
 * Every upstream source file is scanned rather than only the token sheet,
 * because upstream also declares component-local properties
 * (`--dsh-composer-height`, `--dsh-boot-*`, …) that chamber may legitimately
 * mirror. Declarations are matched as `--name:` in a CSS block or as a
 * quoted/backticked key in TS (the theme package registers runtime tokens
 * that way).
 * @returns {{sheetTokens: Set<string>, allTokens: Set<string>, hashes: Set<string>, fileCount: number}}
 */
function collectUpstreamReference() {
  const sheetTokens = new Set()
  const allTokens = new Set()
  const hashes = new Set()
  const consumed = new Set()
  const declaration = /(--(?:dsw|dsh)-[a-z0-9-]+)\s*:/gi
  const quoted = /['"`](--(?:dsw|dsh)-[a-z0-9-]+)['"`]/gi

  const record = (target, text) => {
    for (const match of text.matchAll(declaration)) target.add(match[1])
    for (const match of text.matchAll(quoted)) target.add(match[1])
    // A name upstream READS counts as consumed, so S6 never calls a chamber
    // declaration dead when its reader lives in the vendor tree
    // (`--dsh-scrollbar-thumb` is consumed by ui-theme's scrollbar.css).
    for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) consumed.add(match[1])
  }

  if (existsSync(UPSTREAM_THEME_STYLES)) {
    for (const name of readdirSync(UPSTREAM_THEME_STYLES)) {
      if (!name.endsWith('.css')) continue
      record(sheetTokens, readFileSync(join(UPSTREAM_THEME_STYLES, name), 'utf8'))
    }
  }

  const upstreamFiles = walk(UPSTREAM)
  for (const file of upstreamFiles) {
    const text = readFileSync(file, 'utf8')
    record(allTokens, text)
    hashes.add(sha256(text))
  }
  for (const token of sheetTokens) allTokens.add(token)

  return { sheetTokens, allTokens, hashes, consumed, fileCount: upstreamFiles.length }
}

// ---------------------------------------------------------------------------
// Lexical helpers
// ---------------------------------------------------------------------------

/** Innermost `selector { body }` pairs. `@media` wrappers nest, so the outer
 *  block never matches — which is what we want: the exemptions are keyed by
 *  the rule's own selector. */
const RULE = /([^{}]*)\{([^{}]*)\}/g

/** `border[-side]: <width>px solid var(--dsw-alias-…)`. */
const SOLID_BORDER = /border(?:-(?:top|right|bottom|left))?\s*:\s*([0-9.]+)px\s+solid\s+var\(\s*(--dsw-alias-[a-z0-9-]+)/g

/** A separator drawn as a filled box: a border-token background on a 1px-tall
 *  or 1px-wide element (upstream's `wideFilledDividers`). Only an exact `1px`
 *  is a hairline drawn the wrong way; a taller/wider box is a real surface. */
const FILLED_DIVIDER = /(?:^|;)\s*(?:height|width)\s*:\s*1px\s*(?:;|$)/g

/** `border-radius` declarations inside a rule body. */
const BORDER_RADIUS = /border-radius\s*:\s*([^;]+)/g

/**
 * Whether a radius value makes the element full-round — an uncapped fraction
 * of the box (50% / 100%) or a pill radius far above any box size. Mirrors
 * upstream's `isFullRound`; component-local radius indirections stay below the
 * pill threshold, so the check is lexical over literal components.
 * @param {string} value - a `border-radius` declaration value.
 * @returns {boolean} true when some component is full-round.
 */
function isFullRound(value) {
  return value.split(/\s+/).some((part) =>
    part === '50%' || part === '100%' || (part.endsWith('px') && Number.parseFloat(part) >= 99))
}

/** `var(--token, fallback…)` — the fallback's leading token decides whether it is a literal colour. */
const ALIAS_FALLBACK = /var\(\s*(--dsw-alias-[a-z0-9-]+)\s*,([^)]*)/gi
const LITERAL_COLOUR = /^\s*(#[0-9a-f]{3,8}\b|rgba?\(|hsla?\()/i

/** `var(--…)` references, used to tell a real custom property from a CLI flag. */
const VAR_REFERENCE = /var\(\s*(--[a-z0-9-]+)/gi

const DECLARATION = /^\s*(--(?:dsw|dsh|chamber)-[a-z0-9-]+)\s*:/gim
const DECLARATION_QUOTED = /['"`](--(?:dsw|dsh|chamber)-[a-z0-9-]+)['"`]\s*:/gi

/** A declaration in CSS position: right after `{` or `;` (or at the start of
 *  the sheet). Anchoring on the separator is what keeps a `case '--dsh-port':`
 *  switch label and an object key from reading as a CSS custom property. */
const CSS_DECLARATION = /(?:^|[{;])[\s\n]*(--[a-z0-9-]+)\s*:/g

/** An lv/elevation shadow, the half of the S5 pairing that is not a border. */
const ELEVATION_SHADOW = /box-shadow\s*:[^;]*--dsw-(?:shadow-lv|elevation)/

/** A neutral-token border wider than zero, the other half of the S5 pairing. */
const NEUTRAL_BORDER_DECL = /border(?:-(?:top|right|bottom|left))?\s*:\s*(?!0(?:px)?\s*(?:;|$))[^;]*var\(\s*--dsw-alias-border-/

/**
 * The CSS contexts inside a file. A stylesheet is all context; in `.ts`/`.tsx`
 * the CSS lives in backtick template literals (the gateway login page and the
 * mobile plugin both keep whole stylesheets there) and in `<style>` blocks.
 * Ordinary TypeScript — object keys, CLI switch labels — is therefore never
 * read as CSS.
 * @param {string} file - absolute path (the extension decides the strategy).
 * @param {string} text - file contents.
 * @returns {string[]} the CSS-carrying slices of the file.
 */
function cssContexts(file, text) {
  if (file.endsWith('.css')) return [text]
  const out = []
  for (const match of text.matchAll(/`([^`]*)`/g)) out.push(match[1])
  for (const match of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) out.push(match[1])
  return out
}

// ---------------------------------------------------------------------------

const { sheetTokens, allTokens, hashes: upstreamHashes, consumed: upstreamConsumed, fileCount } = collectUpstreamReference()

if (allTokens.size === 0) {
  fail(`上游 token 集为空——vendor 树未 bootstrap（缺 ${repoRel(UPSTREAM_THEME_STYLES)}）；先跑 scripts/dev/ensure-harness-vendor.mjs`)
} else if (args.has('--list')) {
  for (const token of [...allTokens].sort()) console.log(token)
  process.exit(0)
}

/** Every authored file under `packages/` and `scripts/`. */
function collectChamberFiles() {
  const files = []
  for (const dir of ['packages', 'scripts']) {
    const abs = join(ROOT, dir)
    if (existsSync(abs)) walk(abs, files)
  }
  return files
}

const chamberFiles = collectChamberFiles()
  .filter((file) => statSync(file).isFile())
const scannedFiles = chamberFiles.filter((file) => !TEST_FILE.test(repoRel(file)))

/** Names chamber actually uses as custom properties. A CLI flag such as
 *  `--dsh-path` is never referenced through `var()`, so this is what
 *  separates a stray CSS property from a command-line option. */
const referencedNames = new Set()
for (const file of scannedFiles) {
  for (const match of readFileSync(file, 'utf8').matchAll(VAR_REFERENCE)) referencedNames.add(match[1])
}

/** Every custom property anything reads: chamber's `var()` references, plus a
 *  value a script pulls out with `getPropertyValue`. The upstream tree's own
 *  `var()` references are unioned in so a chamber declaration whose reader
 *  lives in the vendor tree is never reported as dead. */
const consumedNames = new Set([...referencedNames, ...upstreamConsumed])
for (const file of scannedFiles) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/getPropertyValue\(\s*['"`](--[a-z0-9-]+)/gi)) consumedNames.add(match[1])
}

/** Custom properties declared in a CSS position anywhere in chamber, with the
 *  files that declare them (S6). */
const declaredInCss = new Map()

const findings = { s1: [], s2: [], s3: [], s4: [], s5: [], s6: [], s7: [] }
let skippedMirrors = 0

for (const file of scannedFiles) {
  const rel = repoRel(file)
  const text = readFileSync(file, 'utf8')

  // Upstream's own text pinned by C1: not chamber's to fix here.
  if (upstreamHashes.has(sha256(text))) {
    skippedMirrors += 1
    continue
  }

  // S1 — reference to an upstream-namespaced name upstream never declares.
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/var\(\s*(--(?:dsw|dsh)-[a-z0-9-]+)/gi)) {
      const token = match[1]
      if (allTokens.has(token) || UPSTREAM_UNDECLARED_ALLOWLIST.has(token)) continue
      findings.s1.push(`${rel}:${index + 1}  ${token}`)
    }
  })

  // S2 — chamber invents a name inside upstream's namespace.
  const declaredHere = new Set()
  for (const match of text.matchAll(DECLARATION)) declaredHere.add(match[1])
  for (const match of text.matchAll(DECLARATION_QUOTED)) declaredHere.add(match[1])
  for (const token of declaredHere) {
    if (!referencedNames.has(token)) continue // a CLI flag or an inert literal
    if (token.startsWith('--chamber-') || allTokens.has(token)) continue
    findings.s2.push(`${rel}  ${token}`)
  }

  // S3 — neutral borders heavier than the hairline, and wide filled dividers.
  const base = basename(file)
  for (const rule of text.matchAll(RULE)) {
    // The captured `selector` group is everything since the previous `}`, so it
    // still carries the preceding comment block; strip comments and keep the
    // trailing selector line for a readable finding.
    const selector = rule[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(part => part.trim())
      .filter(Boolean)
      .join(' ')
      .slice(-120)
    const body = rule[2]
    const isRing = RING_TRACKS.has(`${base} ${selector.split(/[\s,]+/).pop()}`)

    for (const match of body.matchAll(SOLID_BORDER)) {
      const width = Number(match[1])
      const token = match[2]
      if (token.startsWith('--dsw-alias-state-')) {
        if (width !== 1) findings.s3.push(`${rel}  ${selector}  ${token} at ${width}px (state borders stay 1px)`)
        continue
      }
      if (isRing) continue
      if (width !== 0.5) findings.s3.push(`${rel}  ${selector}  ${token} at ${width}px (neutral borders are 0.5px)`)
    }

    if (/(?:^|;)\s*background(?:-color)?\s*:\s*var\(--dsw-alias-border-/.test(body)) {
      for (const _ of body.matchAll(FILLED_DIVIDER)) {
        findings.s3.push(`${rel}  ${selector}  filled divider at 1px (hairline is 0.5px)`)
      }
    }

    // S5 — an elevated surface must not also carry a neutral real border: the
    // shadow already draws the hairline, so a border beside it double-draws the
    // outline and shifts layout by its width. State-coloured borders stay real
    // borders and are out of scope, exactly as in upstream's spec.
    if (ELEVATION_SHADOW.test(body) && NEUTRAL_BORDER_DECL.test(body)) {
      findings.s5.push(`${rel}  ${selector}`)
    }

    // S7 — a full-round radius must pair `corner-shape: round`, or the global
    // superellipse smoothing deforms the circle / squares off the capsule.
    const radii = [...body.matchAll(BORDER_RADIUS)].map((match) => match[1].trim())
    if (radii.some(isFullRound) && !/corner-shape\s*:\s*round/.test(body)) {
      findings.s7.push(`${rel}  ${selector}  border-radius: ${radii.join(' | ')}`)
    }
  }

  // S4 — literal colour hiding behind a semantic-alias fallback.
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(ALIAS_FALLBACK)) {
      if (!LITERAL_COLOUR.test(match[2])) continue
      // A data-URI / gradient argument containing a hex is not a colour fallback.
      if (/url\(|gradient\(/i.test(match[2])) continue
      findings.s4.push(`${rel}:${index + 1}  ${match[1]}  → ${match[2].trim().slice(0, 40)}`)
    }
  })

  // S6 — collect declared custom properties (CSS position only) for the
  // dead-declaration pass after the loop, once every consumer is known.
  for (const context of cssContexts(file, text)) {
    for (const match of context.matchAll(CSS_DECLARATION)) {
      if (!declaredInCss.has(match[1])) declaredInCss.set(match[1], new Set())
      declaredInCss.get(match[1]).add(rel)
    }
  }
}

// S6 — a declaration nothing reads is dead: it reads as a live knob, so the
// next author reuses the name expecting it to do something.
for (const [name, where] of [...declaredInCss].sort()) {
  if (consumedNames.has(name)) continue
  findings.s6.push(`${name}  declared in ${[...where].join(', ')}`)
}

// ---------------------------------------------------------------------------

const LABELS = {
  s1: 'S1 引用了未声明的 --dsw-*/--dsh-*（错名 alias 静默降级，不报错）',
  s2: 'S2 命名空间越界（chamber 自造名未使用 --chamber- 前缀）',
  s3: 'S3 中性 border / 填充分隔线未按 0.5px 发丝线绘制',
  s4: 'S4 语义 alias 的 fallback 写了字面量颜色',
  s5: 'S5 边框 + 阴影配对（高层级表面应 border: 0，描边走阴影，规范禁止配对）',
  s6: 'S6 声明了但无人读取的自定义属性（死声明）',
  s7: 'S7 全圆角未配对 corner-shape: round（超椭圆会把圆压成方圆形 / 削平胶囊端）',
}

for (const key of ['s1', 's2', 's3', 's4', 's5', 's6', 's7']) {
  const list = findings[key]
  if (list.length === 0) continue
  fail(`${LABELS[key]} — ${list.length} 处`)
  for (const entry of list) console.error(`    ${entry}`)
}

if (hardFails === 0) {
  console.log(`✓ 样式 token 门 S1–S7：扫描 ${scannedFiles.length - skippedMirrors} 个 chamber 文件`
    + `（跳过 ${skippedMirrors} 个上游逐字节镜像、${chamberFiles.length - scannedFiles.length} 个测试夹具）`)
  console.log(`  参照：上游 ${allTokens.size} 个 token（token sheet 声明 ${sheetTokens.size} 个，`
    + `被读取 ${upstreamConsumed.size} 个），取自 ${fileCount} 个 vendor 文件`)
  console.log(`  声明 ${declaredInCss.size} 个自定义属性，全部有读取点`)
  console.log('  S1 未声明引用 0 · S2 命名空间越界 0 · S3 发丝线合规 · S4 无字面量 fallback'
    + ' · S5 无边框+阴影配对 · S6 无死声明 · S7 圆角配对合规')
}

process.exitCode = hardFails === 0 ? 0 : 1
