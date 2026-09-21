/**
 * `--attach` / `--dev` acceptance: drive the real GUI through CDP and assert
 * STRUCTURAL facts, then leave screenshots + observed text as the human
 * (visual) evidence.
 *
 * LANGUAGE POLICY: only two lookups are locale-coupled (the sidebar settings
 * seat and the first-run modal's dismiss action) and both go through a small
 * zh/en allowlist, recording what was found when nothing matches. Everything
 * else uses the DOM contracts the code already carries:
 *   - `[data-instance]`                      per-instance shell (renderer InstanceView)
 *   - `[data-chamber-section]` / `[data-chamber-row]`  sidebar sources and rows
 *   - `[data-sidebar-collapsed]`             official frame attribute: the sidebar rail state
 *   - `[data-chamber-hovercard]` / `[data-chamber-hovercard-anchor]`  hover card + its anchor
 *   - `[data-slot]` / `[data-slot-error]`     settings-bridge render sites
 *   - `dialog nav [class*="navList"] > button`  settings nav items (aria-current = active)
 *
 * SAFETY: the run never clicks a control that is not one of the above (no
 * 启动/停止/保存/删除 can be reached). Two legs are located STRUCTURALLY and are
 * judged by the EFFECT they must produce — never by the clicked element's own
 * attribute: W-4 picks the sidebar header's icon-sized button and requires the
 * frame's `[data-sidebar-collapsed]` to flip (the rail toggle carries no
 * `aria-expanded`, so the previous "first aria-expanded in the left half"
 * selector silently took the source-section fold and passed while the sidebar
 * never moved; that false green is what the structural pick + effect assertion replace).
 * W-4a drives that source-section fold, which writes the PERSISTED
 * `sourceFolded` preference (design 06 §3.1), so it runs only on a throwaway
 * instance (`--dev`); `--attach` records INFO for it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CdpSession, discoverPageTarget } from './cdp.mjs'
import { sleep } from '../lib/cli.mjs'
import {
  KNOWN_UPSTREAM_BOOT_NOISE, TOLERATED_REQUEST_FAILURES, applyRequireHover, createRecorder, hoverCardVerdict,
  hoverDismissVerdict, hoverExclusiveVerdict, hoverRaceVerdict, partitionFailures, pickRailToggle,
  raceBandForWindow, railFactsSnapshot, railToggleVerdict, renderMarkdown, sourceFoldVerdict, summarize,
  summarizeNetFailures, veilLayeringVerdict,
} from './checks.mjs'

const SETTINGS_SEAT_LABELS = ['设置', 'Settings']
const ONBOARDING_DISMISS_LABELS = ['稍后配置', '稍后', 'Later', 'Skip', '跳过']

/**
 * First-run modals are a WIZARD: the step a fresh instance shows may only offer
 * "继续/Continue", so there is no dismiss control to click. Advancing it writes
 * to the instance's own onboarding state — acceptable ONLY on a throwaway
 * instance (`--dev`, which passes advanceOnboarding: true). On `--attach` (a
 * real instance) the walkthrough records the buttons and skips the settings leg
 * instead of silently clicking through someone's first-run flow.
 */
const CLICK_FIRST_DIALOG_BUTTON = `(() => {
  const visible = el => { const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 }
  const others = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
    .filter(el => visible(el) && el.querySelector('nav [class*="navList"]') === null)
  const dialog = others[0]
  if (dialog === undefined) return null
  const button = [...dialog.querySelectorAll('button')].filter(visible)[0]
  if (button === undefined) return null
  const label = (button.innerText || '').trim()
  button.click()
  return label
})()`

const ROOT_MOUNTED = `document.querySelector('#root') && document.querySelector('#root').children.length > 0`
const DOM_FACTS = `(() => {
  const visible = el => { const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 }
  const text = el => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
  const label = el => ((el.innerText || '').trim() || (el.getAttribute('aria-label') || '').trim() || (el.getAttribute('title') || '').trim())
  const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(visible)
  // The settings surface is identified structurally (its nav rail), never by
  // title text: other modals (first-run onboarding) must not be mistaken for it.
  const settingsDialog = dialogs.find(dialog => dialog.querySelector('nav [class*="navList"]') !== null)
  const others = dialogs.filter(dialog => dialog !== settingsDialog)
  const navItems = settingsDialog === undefined ? [] : [...settingsDialog.querySelectorAll('nav [class*="navList"] > button')].filter(visible)
  return {
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    shells: [...document.querySelectorAll('[data-instance]')].map(el => el.getAttribute('data-instance')),
    sidebarSources: document.querySelectorAll('[data-chamber-section]').length,
    sidebarRows: document.querySelectorAll('[data-chamber-row]').length,
    sessionRows: document.querySelectorAll('[data-session-id]').length,
    slots: [...new Set([...document.querySelectorAll('[data-slot]')].map(el => el.getAttribute('data-slot')))].length,
    slotErrors: [...document.querySelectorAll('[data-slot-error]')].map(el => el.getAttribute('data-slot-error')),
    settingsOpen: settingsDialog !== undefined,
    otherDialogs: others.length,
    otherDialogButtons: others.flatMap(dialog => [...dialog.querySelectorAll('button')].filter(visible).map(label)).slice(0, 8),
    navLabels: navItems.map(text),
    panelChars: settingsDialog === undefined ? 0 : text(settingsDialog).length,
    controls: [...document.querySelectorAll('button,a[href],[role="button"]')].filter(visible).length,
    // The structurally-located legs (W-4 rail, W-4a fold) read these: every
    // visible button as a DESCRIPTOR — the page never picks, the pure
    // pickRailToggle (checks.mjs) does — plus the official
    // [data-sidebar-collapsed] frame attribute. One facts expression, so
    // "settings open" and the section counts cannot drift between legs.
    railCollapsed: document.querySelector('[data-sidebar-collapsed]') !== null,
    buttons: [...document.querySelectorAll('button')].map((el, index) => {
      const rect = el.getBoundingClientRect()
      let inDialog = false
      for (let node = el; node !== null; node = node.parentElement) {
        if (node.getAttribute !== undefined && node.getAttribute('role') === 'dialog') { inDialog = true; break }
      }
      // Inactive instance views stay MOUNTED in N-ctx windows, hidden by
      // visibility: hidden (.instance-hidden / .instance-pending,
      // packages/renderer/src/styles.css) — geometry alone would keep their
      // header buttons in the candidate set, so the computed visibility rides
      // along as a FACT the pure picker uses to scope to the visible view.
      return {
        index,
        ariaLabel: el.getAttribute('aria-label'),
        ariaExpanded: el.getAttribute('aria-expanded'),
        cls: (el.className || '').toString().slice(0, 80),
        left: Math.round(rect.left), top: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height),
        visibility: window.getComputedStyle(el).visibility,
        inDialog,
      }
    }).filter(entry => entry.width > 0 && entry.height > 0),
  }
})()`

/** Click a button/link by label allowlist; returns the matched label or null. */
function clickByLabel(labels) {
  return `(() => {
    const wanted = ${JSON.stringify(labels)}
    const visible = el => { const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 }
    const label = el => ((el.innerText || '').trim() || (el.getAttribute('aria-label') || '').trim() || (el.getAttribute('title') || '').trim())
    const candidates = [...document.querySelectorAll('button,a[href],[role="button"]')]
      .filter(el => visible(el) && label(el).length > 0 && label(el).length <= 40)
      .filter(el => wanted.some(word => label(el) === word || label(el).includes(word)))
      .sort((a, b) => label(a).length - label(b).length)
    if (candidates.length === 0) return null
    candidates[0].scrollIntoView({ block: 'center' })
    candidates[0].click()
    return label(candidates[0])
  })()`
}

/** Click the k-th settings nav item (structural allowlist — never a form control). */
function clickNavItem(index) {
  return `(() => {
    const visible = el => { const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 }
    const dialog = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(visible)
    if (dialog === undefined) return null
    const items = [...dialog.querySelectorAll('nav [class*="navList"] > button')].filter(visible)
    const item = items[${index}]
    if (item === undefined) return null
    item.scrollIntoView({ block: 'center' })
    item.click()
    return (item.innerText || '').trim()
  })()`
}

/**
 * Persisted sidebar view preferences (design 06 §3.1, the shared
 * `dsh-chamber.sidebar.v1` localStorage key) as a compact snapshot: the write
 * boundary W-4/W-4a assert, so the README's "this leg writes nothing / the round
 * trip leaves no residue" claims are checked rather than promised. Only counts
 * and the fold map are reported — never session titles or paths.
 */
const VIEW_PREFS = `(() => {
  try {
    const raw = window.localStorage.getItem('dsh-chamber.sidebar.v1')
    if (raw === null) return { present: false }
    const parsed = JSON.parse(raw)
    return {
      present: true,
      v: parsed.v ?? null,
      sourceFolded: parsed.sourceFolded ?? null,
      foldedKeys: parsed.folded === undefined ? null : Object.keys(parsed.folded).length,
      sidebarWidth: parsed.sidebarWidth ?? null,
      serverOrder: parsed.serverOrder === undefined ? null : parsed.serverOrder.length,
      orderByKeys: parsed.orderBy === undefined ? null : Object.keys(parsed.orderBy).length,
    }
  } catch (error) {
    return { present: true, parseError: String(error?.message ?? error) }
  }
})()`

/**
 * W-4a's facts: the FIRST source section, its fold control (the section's first
 * VISIBLE `button[aria-expanded]` — that is the source-fold switch in the header
 * row), the section's rendered height and its rows. The height is why this leg
 * exists: design 06 §2.4 judges the collapsed workspace LIST, not the attribute.
 */
const SOURCE_FOLD_FACTS = `(() => {
  const visible = el => { const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 }
  // The FIRST VISIBLE section: in an N-ctx window the DOM also holds inactive
  // views (hidden by visibility: hidden), and folding one of those would judge
  // a view the user cannot see.
  const section = [...document.querySelectorAll('[data-chamber-section]')]
    .find(el => window.getComputedStyle(el).visibility !== 'hidden') ?? null
  if (section === null) return { found: false }
  const all = [...document.querySelectorAll('button')]
  const control = [...section.querySelectorAll('button[aria-expanded]')]
    .filter(visible)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]
  const rect = section.getBoundingClientRect()
  const controlRect = control === undefined ? null : control.getBoundingClientRect()
  return {
    found: true,
    expanded: control === undefined ? null : control.getAttribute('aria-expanded') === 'true',
    foldIndex: control === undefined ? null : all.indexOf(control),
    // Identity of the control, so the click can be addressed by DESCRIPTOR
    // (clickButtonAt) instead of trusting a DOM index across two CDP calls.
    control: control === undefined ? null : {
      ariaLabel: control.getAttribute('aria-label'),
      left: Math.round(controlRect.left), top: Math.round(controlRect.top),
      width: Math.round(controlRect.width), height: Math.round(controlRect.height),
    },
    height: Math.round(rect.height),
    rows: section.querySelectorAll('[data-chamber-row]').length,
    sections: document.querySelectorAll('[data-chamber-section]').length,
  }
})()`

/**
 * Click the control the PURE picker chose, addressed by IDENTITY: the DOM index
 * is only a hint. If the page re-rendered between the facts call and this one
 * (a session event inserts a row, a poll commits), the element at that index is
 * some OTHER button — possibly a mutating one. So the page verifies the element
 * at the index against the expected descriptor, re-locates the control by
 * descriptor when it drifted, and clicks nothing when it cannot find it (the
 * leg then fails on the effect it never produced).
 *
 * Remembering the clicked element is what keeps the RESTORE click on the same
 * node: re-running a selector after the state changed is how the old leg's
 * "restore" step clicked the rail's settings seat and opened the settings dialog.
 * @param index - descriptor index from the facts dump (a hint only).
 * @param expected - descriptor `{ ariaLabel, left, top }` of the chosen control.
 * @returns `{ clicked, drifted, identity }`.
 */
export function clickButtonAt(index, expected) {
  return `(() => {
    const wanted = ${JSON.stringify(expected ?? null)}
    if (wanted === null) return { clicked: false, drifted: false, identity: null }
    const all = [...document.querySelectorAll('button')]
    const near = (value, want) => Math.abs(value - want) <= 2
    const matches = el => {
      const rect = el.getBoundingClientRect()
      return (el.getAttribute('aria-label') ?? null) === (wanted.ariaLabel ?? null)
        && near(Math.round(rect.left), wanted.left) && near(Math.round(rect.top), wanted.top)
    }
    let el = all[${index}]
    let drifted = false
    if (el === undefined || !matches(el)) {
      drifted = true
      el = all.find(node => matches(node))
    }
    if (el === undefined) return { clicked: false, drifted: drifted, identity: null }
    const rect = el.getBoundingClientRect()
    window.__dshGuiAcceptanceClicked = el
    const identity = {
      ariaLabel: el.getAttribute('aria-label'),
      cls: (el.className || '').toString().slice(0, 80),
      left: Math.round(rect.left), top: Math.round(rect.top),
      width: Math.round(rect.width), height: Math.round(rect.height),
    }
    el.click()
    return { clicked: true, drifted: drifted, identity: identity }
  })()`
}

/** The restore click: the element the leg clicked before, never a re-scan. */
export const CLICK_STASHED_BUTTON = `(() => {
  const el = window.__dshGuiAcceptanceClicked
  if (el === undefined || el === null || el.isConnected === false) return { clicked: false, drifted: false, identity: null }
  const rect = el.getBoundingClientRect()
  const identity = {
    ariaLabel: el.getAttribute('aria-label'),
    cls: (el.className || '').toString().slice(0, 80),
    left: Math.round(rect.left), top: Math.round(rect.top),
    width: Math.round(rect.width), height: Math.round(rect.height),
  }
  el.click()
  return { clicked: true, drifted: false, identity: identity }
})()`

/**
 * 遮罩层叠探针（2026-12 P0–P3，design 05 §4）：遮罩 `.instance-loading` 可见的那些帧里，
 * 对已登记锚点（composer 座 / 输入区 / 会话流中心与底缘）各做一次 `elementFromPoint`，
 * 按命中面归属归并计数：`veil`（遮罩获胜）/ `tenant`（租客画在其上 ⇒ FAIL）/
 * `portal`（文档级 body portal，已登记残余 ⇒ 只记）/ `none`（无命中 ⇒ 不判）。
 *
 * 采样按 rAF 每 4 帧一次（≈16Hz）：足够覆盖一次 settle/切换窗口，又不给同一次走查里的
 * 时序腿（hover 竞态窗口、提交时延）添可测的额外布局读。自停在 20s / 1200 帧；读回用
 * {@link VEIL_LAYERING_PROBE_READ}，判定用纯函数 `veilLayeringVerdict`（CI 单测）。
 * 装在会话建立之后**尽早**执行：本地实例壳通常还在 boot，正是冷启动遮罩那一窗。
 */
export const VEIL_LAYERING_PROBE_INSTALL = `(() => {
  if (window.__veilLayering !== undefined) return { installed: false, reason: 'already' }
  const VEIL = '.instance-loading'
  // 只认**活动视图**的遮罩与锚点：后台预热/收割的视图（.instance-pending，
  // 只 visibility:hidden）遮罩仍在 DOM 里，全文档口径会把它的遮罩帧与活动视图的
  // 命中面配在一起，对健康构建判出假 FAIL（2026-12 review 复现）。
  const SCOPE = '.instance-view:not(.instance-hidden):not(.instance-pending)'
  const ANCHORS = ['[data-composer-seat]', '[data-composer-input]', '[data-conversation-scroll]']
  const state = { frames: 0, veilFrames: 0, heldFrames: 0, bootFrames: 0, samples: {}, error: null, done: false, startedAt: Date.now() }
  const record = (point, winner, hit) => {
    const key = point + '|' + winner
    const entry = state.samples[key]
    if (entry === undefined) {
      state.samples[key] = {
        point: point, winner: winner, count: 1,
        hit: hit === null ? null : (hit.tagName.toLowerCase() + (typeof hit.className === 'string' && hit.className !== '' ? '.' + hit.className.trim().split(/\\s+/)[0] : '')),
      }
    } else {
      entry.count += 1
    }
  }
  const sample = () => {
    const view = document.querySelector(SCOPE)
    if (view === null) return
    const veil = view.querySelector(VEIL)
    if (veil === null) return
    // 双保险：显式隐藏的遮罩不算"遮罩可见帧"（SCOPE 已排除 hidden/pending 视图）。
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(veil)
      if (style.visibility === 'hidden' || style.display === 'none') return
    }
    state.veilFrames += 1
    // PASS 的强弱取决于这一帧属于哪一段（2026-12 二轮 review）：已 settle 的持有态里
    // 租客被 .instance-veil-held 隐藏（visibility:hidden 移出命中测试），PASS 只证明
    // "遮罩盖住了锚点"，不单独断言 P0（isolation）或 P1（持有期隐藏）任一条；只有
    // !settled 的 boot 段里租客仍参与命中测试，才有完整的判别力。分开计数并写进 evidence。
    let held = false
    if (typeof view.classList === 'object' && view.classList !== null && typeof view.classList.contains === 'function') {
      held = view.classList.contains('instance-veil-held')
    }
    if (held) state.heldFrames += 1
    else state.bootFrames += 1
    for (const anchor of ANCHORS) {
      const node = view.querySelector(anchor)
      if (node === null) continue
      const rect = node.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) continue
      const points = [[rect.left + rect.width / 2, rect.top + rect.height / 2], [rect.left + rect.width / 2, rect.bottom - 2]]
      for (const [x, y] of points) {
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue
        const hit = document.elementFromPoint(x, y)
        if (hit === null) { record(anchor, 'none', null); continue }
        const winner = hit.closest(VEIL) !== null ? 'veil'
          : (hit.closest('.instance-shell') !== null || hit.closest('[data-instance]') !== null) ? 'tenant'
          : 'portal'
        record(anchor, winner, hit)
      }
    }
  }
  const tick = () => {
    // 读回（READ 删除全局）后立即停：否则 rAF 环会带着旧 state 继续跑满自停窗，
    // 给同一次走查里的时序腿（hover 竞态窗口）添不必要的负载。
    if (window.__veilLayering !== state) { state.done = true; return }
    if (Date.now() - state.startedAt > 20_000 || state.frames > 1_200) { state.done = true; return }
    state.frames += 1
    if (state.frames % 4 === 0) {
      try { sample() } catch (error) { state.error = String(error) }
    }
    requestAnimationFrame(tick)
  }
  window.__veilLayering = state
  requestAnimationFrame(tick)
  return { installed: true }
})()`

/** 读回并清除探针状态（`samples` 拍平成数组，供纯判据消费）。 */
export const VEIL_LAYERING_PROBE_READ = `(() => {
  const state = window.__veilLayering
  if (state === undefined) return { installed: false, frames: 0, veilFrames: 0, samples: [], error: null, done: false }
  const samples = Object.keys(state.samples).map(key => state.samples[key])
  // done 不再强制为 true（2026-12 二轮 review）：它表示"探针自己跑完了 20s/1200 帧窗口"，
  // false = 本次是提前读回。tick 在被读回后的下一帧自行退出。
  delete window.__veilLayering
  return {
    installed: true, frames: state.frames, veilFrames: state.veilFrames,
    heldFrames: state.heldFrames, bootFrames: state.bootFrames,
    samples: samples, error: state.error, done: state.done === true,
  }
})()`


/**
 * The core fix's identity markers (packages/dsh-chamber-client-ui-sidebar/
 * src/client/RowHoverCard.tsx): the portaled card carries
 * `data-chamber-hovercard`, and the wrapper `<span>` that holds the hover target
 * carries `data-chamber-hovercard-anchor`. They are the ONLY card anchor: a card
 * is rendered nowhere else, so counting/selecting by them is identity, not
 * geometry (the previous `position:fixed && width 244 && z-index 100` count
 * could be satisfied by a Tooltip bubble or a leftover card).
 */
const HOVER_CARD_MARKER = 'data-chamber-hovercard'
const HOVER_ANCHOR_MARKER = 'data-chamber-hovercard-anchor'

/**
 * Hover timing, derived from the machine's own constants
 * (packages/dsh-chamber-client-ui-sidebar/src/shared/hover-intent.ts):
 *
 *  - the card opens HOVER_DWELL_MS after the pointer enters (`HOVER_OPEN_DELAY_MS`)
 *    and closes HOVER_GRACE_MS after it leaves (`HOVER_CLOSE_GRACE_MS`);
 *  - the defect this check exists for is a STRAND: the vendored atom fires its
 *    dwell timer at HOVER_DWELL_MS and React commits that open only after the
 *    rest of the frame's commit work — a window bounded by nothing the app
 *    controls (one large React root per instance, plus the N-ctx shells sharing a
 *    scheduler). Its `onPointerLeave` is `clearTimer(); if (open) armClose()`, so
 *    a leave handled inside that window armed no close and the card mounted with
 *    the pointer already gone.
 *
 *    THEREFORE the discriminating leave offsets are `(0, commitLatency]` AFTER
 *    the dwell, where commitLatency is THIS RUN's measured latency — and they are
 *    measured, not assumed. A fixed band (the historical `[10, 60]ms`) is only a
 *    LOWER BOUND: on a fast/idle thread the whole band can land after the commit,
 *    the vendored grace arms normally, and the leg would go green on broken code
 *    (adversarial review, finding H5/#3). The measurement pass below probes the
 *    window and `raceBandForWindow` derives the offsets from it; when the window
 *    cannot be measured, or is too small to probe, the verdict reports "could not
 *    discriminate" (INFO) instead of claiming a pass — and `--require-hover`
 *    turns exactly that INFO into a FAIL.
 *  - one strand is enough to FAIL, and the trials cycle deterministically through
 *    the derived offsets, so the leg never depends on one lucky millisecond. The
 *    trial count is a wall-time/coverage trade, not a probability claim: there is
 *    no committed strand rate to compute one from. Nothing injects main-thread
 *    load: this leg measures the window the run actually has.
 *
 * WALL TIME: one race trial costs (dwell + offset + settle) ≈ 0.95-1.2s, so
 * HOVER_RACE_TRIALS=12 bounds that leg at ~12-14s; the measurement pass adds
 * HOVER_COMMIT_SAMPLES × (dwell + latency + clear) ≈ 3s.
 */
const HOVER_DWELL_MS = 500
const HOVER_GRACE_MS = 200
const HOVER_OPEN_WAIT_MS = HOVER_DWELL_MS + 400
const HOVER_LEAVE_SETTLE_MS = HOVER_GRACE_MS + 500
const HOVER_RACE_TRIALS = 12
const HOVER_RACE_SETTLE_MS = HOVER_GRACE_MS + 200
/** Poll cadence of the commit-latency probe (one CDP evaluate per poll). */
const HOVER_COMMIT_POLL_MS = 5
/** How many times the dwell→commit window is measured (max of the samples is used). */
const HOVER_COMMIT_SAMPLES = 3
/** Give up on a sample this long after the dwell: no card ⇒ window unmeasurable. */
const HOVER_COMMIT_LIMIT_MS = 400
const HOVER_SWAP_SAMPLE_MS = 40
const HOVER_SWAP_SAMPLES = 10
/** Let B's dwell land after the sampling window (samples cover the A→B overlap). */
const HOVER_SWAP_END_WAIT_MS = Math.max(0, HOVER_DWELL_MS + 150 - HOVER_SWAP_SAMPLE_MS * HOVER_SWAP_SAMPLES)
const HOVER_DISMISS_SETTLE_MS = 250

/**
 * A cardable sidebar row, as a viewport point plus the row's OWN title.
 *
 * SELECTION IS MARKER-BASED: only rows inside `[data-chamber-hovercard-anchor]`
 * are cardable, so the ungrouped workspace bucket header — which carries
 * `data-chamber-row` and `role="treeitem"` (ServerSection.tsx:1436-1437) but is
 * rendered WITHOUT RowHoverCard on purpose (:1743-1746, deliberately card-less)
 * — can never be picked. The old comment here claimed that bucket was excluded;
 * it was not, and the old `[data-chamber-row][role="treeitem"]` selector would
 * record a false `ok:false` on an instance whose first fitting row is it.
 *
 * `wrappedRows` is a DIAGNOSTIC ONLY (it never drives the pointer): a cardable
 * row's parent is RowHoverCard's anchor `<span>` (RowHoverCard.tsx:248-268, marker at :252), so
 * span-parented rows distinguish "this build stamps no anchor marker" (the
 * pre-fix bundle — a contract failure) from "this instance really has no
 * cardable row" (INFO). The row's own title is the first non-empty text node in
 * document order: both row kinds put their title first (`cc.workspaceTitle`
 * ServerSection.tsx:1566, `cc.sessionTitle` :1949), the same value the card
 * repeats as its first block (:1752 / :2090).
 */
const HOVER_TARGETS = `(() => {
  const visible = el => {
    const style = window.getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const fits = el => {
    const r = el.getBoundingClientRect()
    return r.top > 4 && r.bottom < window.innerHeight - 8 && r.left >= 0 && r.right < window.innerWidth * 0.5
  }
  const ownTitle = el => {
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3 && child.textContent.trim() !== '') return child.textContent
        if (child.nodeType === 1) { const found = walk(child); if (found !== null) return found }
      }
      return null
    }
    return (walk(el) ?? '').replace(/\\s+/g, ' ').trim()
  }
  const point = el => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width * 0.6), y: Math.round(r.top + r.height / 2) }
  }
  const rows = [...document.querySelectorAll('[data-chamber-row][role="treeitem"]')]
  const anchors = [...document.querySelectorAll('[${HOVER_ANCHOR_MARKER}]')]
  const wrappedRows = rows.filter(row => row.parentElement !== null && row.parentElement.tagName === 'SPAN').length
  const cardable = rows.filter(row => row.closest('[${HOVER_ANCHOR_MARKER}]') !== null && visible(row) && ownTitle(row) !== '')
  let fitting = cardable.filter(fits)
  if (fitting.length === 0 && cardable.length > 0) {
    cardable[0].scrollIntoView({ block: 'center' })
    fitting = cardable.filter(fits)
  }
  const targets = fitting.map(row => ({ point: point(row), title: ownTitle(row) }))
  const first = targets[0] ?? null
  const second = first === null ? null : (targets.find(target => target.title !== first.title) ?? null)
  return { rows: rows.length, anchors: anchors.length, wrappedRows, first, second }
})()`

/** Portaled row cards currently in the document, by MARKER (never by geometry). */
const CARD_COUNT = `document.querySelectorAll('[${HOVER_CARD_MARKER}]').length`

/** Card count plus the cards' own text, so identity can be asserted. */
const CARD_FACTS = `(() => {
  const cards = [...document.querySelectorAll('[${HOVER_CARD_MARKER}]')]
  return {
    count: cards.length,
    text: cards.map(el => (el.textContent || '').replace(/\\s+/g, ' ').trim()).join(' '),
  }
})()`

/**
 * Page-level dismiss watch probes (`bindDismissWatch` in hover-intent.ts binds
 * `window` blur and `visibilitychange`-while-hidden to the visible card). These are SYNTHETIC DOM
 * events ON PURPOSE and are the toolbox's only documented exception to "real
 * input only": a real OS focus loss or a real tab hide cannot be produced over
 * CDP, so they verify the LISTENER WIRING (bound on first open + dismissal),
 * never the OS hand-off. `visibilityState` is shadowed on the document instance
 * with a configurable own property and deleted again afterwards, so the page is
 * left exactly as found even when the assertion in between throws.
 */
const DISPATCH_BLUR = `(() => { window.dispatchEvent(new Event('blur')); return true })()`
const FORCE_HIDDEN = `(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
  return document.visibilityState
})()`
const RESTORE_VISIBILITY = `(() => { delete document.visibilityState; return document.visibilityState })()`

/**
 * Run the walkthrough.
 * @param opts.cdpPort CDP port of a dev instance (9333 by convention, scripts/perf/README.md)
 * @param opts.outDir artifact directory
 * @param opts.advanceOnboarding whether a first-run wizard may be advanced (throwaway instance only)
 * @param opts.requireHover (`--require-hover`) turn the hover legs' INFO into FAIL, so an
 *   opt-in run cannot go green without the hover surface having really been exercised.
 *   Without it INFO stays INFO; the returned `info` count still rides the run summary.
 * @returns `{ results, reportPath, shots, passed, failed, info }` — `info` is the number of
 *   legs that were NOT exercised (judged nothing), which is what keeps a green run honest.
 */
export async function runWalkthrough({
  cdpPort = 9333, outDir = '.tmp/gui-acceptance', settleMs = 1_500, advanceOnboarding = false, requireHover = false,
  // Legs that WRITE state (the source-section fold persists `sourceFolded`) are
  // allowed only on a throwaway instance, exactly like advancing the wizard.
  allowPersistentWrites = false,
} = {}) {
  const rec = createRecorder()
  const shots = path.join(outDir, 'shots')
  mkdirSync(shots, { recursive: true })

  const target = await discoverPageTarget(cdpPort)
  console.log(`# CDP 走查目标 ${target.url}（${target.title}）`)
  const session = await CdpSession.connect(target.webSocketDebuggerUrl)
  await session.enableObservation()
  await session.reload()
  await sleep(3_000)
  // Start collecting only AFTER our own reload: reloading aborts the previous
  // document's SSE stream, which would otherwise be reported as a page failure.
  session.beginObservationWindow()
  await session.waitFor(ROOT_MOUNTED, 'shell mounted')
  // P0–P3 acceptance（2026-12）：壳一挂上就装遮罩层叠探针——此刻本地实例壳通常还在
  // boot，正是冷启动遮罩那一窗（晚装/温壳则本次判 INFO，不伪绿）。读回后交给纯判据。
  const veilProbeInstall = await session.evaluate(VEIL_LAYERING_PROBE_INSTALL)
  await sleep(4_000)
  const veilProbe = await session.evaluate(VEIL_LAYERING_PROBE_READ)
  const veilVerdict = veilLayeringVerdict({
    veilFrames: veilProbe.veilFrames,
    samples: veilProbe.samples,
    error: veilProbe.error,
    heldFrames: veilProbe.heldFrames,
    bootFrames: veilProbe.bootFrames,
  })
  rec.add('W-1b', '遮罩层叠：可见期内租客不得画在遮罩之上', veilVerdict.ok,
    `${veilVerdict.evidence}；probe={installed:${String(veilProbeInstall.installed)},frames:${veilProbe.frames},veilFrames:${veilProbe.veilFrames},held:${veilProbe.heldFrames},boot:${veilProbe.bootFrames},samples:${veilProbe.samples.length},done:${String(veilProbe.done)},error:${String(veilProbe.error)}}`)

  const shot = async name => { await session.screenshot(path.join(shots, `${name}.png`)); return `${name}.png` }

  const boot = await session.evaluate(DOM_FACTS)
  await shot('01-boot')
  rec.add('W-1', '壳启动并挂载视图', boot.shells.length >= 1,
    `shells=[${boot.shells.join(',')}] viewport=${boot.viewport.width}x${boot.viewport.height} controls=${boot.controls}`)
  rec.add('W-2', '侧栏多来源结构渲染', boot.sidebarSources >= 1,
    `[data-chamber-section]=${boot.sidebarSources} [data-chamber-row]=${boot.sidebarRows} [data-session-id]=${boot.sessionRows}`)

  // First-run modal (settings.onboarding stage) — it is layered ABOVE the shell,
  // so the settings leg below is only meaningful once it is gone.
  let blockedByModal = false
  if (boot.otherDialogs > 0) {
    // Bounded walk of the first-run wizard: prefer a dismiss control, otherwise
    // (throwaway instance only) advance one step, up to FOUR steps.
    const clicks = []
    let after = boot
    for (let step = 0; step < 4 && after.otherDialogs > 0; step += 1) {
      const dismiss = await session.evaluate(clickByLabel(ONBOARDING_DISMISS_LABELS))
      if (dismiss !== null) { clicks.push(`dismiss:${dismiss}`) } else if (advanceOnboarding) {
        const advanced = await session.evaluate(CLICK_FIRST_DIALOG_BUTTON)
        if (advanced === null) break
        clicks.push(`advance:${advanced}`)
      } else break
      await sleep(settleMs)
      after = await session.evaluate(DOM_FACTS)
    }
    await shot('02-after-onboarding')
    if (after.otherDialogs === 0) {
      rec.add('W-3', '首启模态可关闭/可走完', true,
        `起始按钮=${JSON.stringify(boot.otherDialogButtons)} 动作=${JSON.stringify(clicks)}`)
    } else {
      blockedByModal = true
      rec.add('W-3', '首启模态未走完（设置面走查跳过）', null,
        `起始按钮=${JSON.stringify(boot.otherDialogButtons)} 动作=${JSON.stringify(clicks)} 剩余模态=${after.otherDialogs}`
        + (advanceOnboarding ? '' : '；--attach 不代点首启流程（--dev 在一次性实例上会走完）'))
    }
  } else {
    rec.add('W-3', '首启模态（本次未出现）', null, '实例已有历史状态：非首启，跳过')
  }

  // W-4: sidebar rail collapse/expand — located STRUCTURALLY (the pure
  // `pickRailToggle`) and judged by the frame's own `[data-sidebar-collapsed]`
  // contract. See the file header: the old "first aria-expanded in the left
  // half" pick took the source-section fold and passed while the sidebar never
  // moved.
  const W4_TITLE = '侧栏 rail 折叠/展开（[data-sidebar-collapsed] 效果锚定）'
  const railPrefsBefore = await session.evaluate(VIEW_PREFS)
  const railBefore = await session.evaluate(DOM_FACTS)
  const railPick = pickRailToggle(railBefore.buttons, { viewportWidth: railBefore.viewport.width })
  // A shell that never mounted already failed W-1: say so rather than leaving
  // the reader with two reds that look unrelated.
  const shellNote = railBefore.shells.length === 0 ? '壳未挂载（见 W-1）' : ''
  let railVerdict
  if (!railPick.ok) {
    railVerdict = railToggleVerdict({ pick: railPick, before: railFactsSnapshot(railBefore), note: shellNote })
    await shot('03-sidebar-toggled')
  } else {
    const railClick = await session.evaluate(clickButtonAt(railPick.picked.index, railPick.picked))
    await sleep(settleMs)
    const railAfter = await session.evaluate(DOM_FACTS)
    const railPrefsAfter = await session.evaluate(VIEW_PREFS)
    await shot('03-sidebar-toggled')
    // Restore click = the SAME element. Only if React dropped it do we re-locate
    // through the same policy — and the effect assertion still catches a wrong
    // pick, so the fallback cannot turn into a second false green.
    let railRestore = await session.evaluate(CLICK_STASHED_BUTTON)
    let restoredVia = 'stash'
    if (railRestore.clicked !== true) {
      const rePick = pickRailToggle(railAfter.buttons, { viewportWidth: railAfter.viewport.width })
      railRestore = rePick.ok
        ? await session.evaluate(clickButtonAt(rePick.picked.index, rePick.picked))
        : { clicked: false, drifted: false, identity: null }
      restoredVia = rePick.ok ? 'rescan' : 'none'
    }
    await sleep(settleMs)
    const railRestored = await session.evaluate(DOM_FACTS)
    const railPrefsRestored = await session.evaluate(VIEW_PREFS)
    await shot('03b-sidebar-restored')
    const clickNote = railClick.clicked === true ? shellNote : [shellNote, '点击未落下（选中控件已不在 DOM）'].filter(Boolean).join('；')
    railVerdict = railToggleVerdict({
      pick: railPick, identity: railClick.identity, drift: railClick.drifted,
      before: railFactsSnapshot(railBefore), after: railFactsSnapshot(railAfter),
      restored: railFactsSnapshot(railRestored), restoredVia,
      prefs: { before: railPrefsBefore, after: railPrefsAfter, restored: railPrefsRestored },
      note: clickNote,
    })
  }
  rec.add('W-4', W4_TITLE, railVerdict.ok, railVerdict.evidence)

  // W-4a: source-section fold (design 06 §2.4) — the control the old W-4
  // selector hit by accident, kept as its own leg with §2.4's own criterion
  // (the collapsed LIST must be visible in the geometry, not just the
  // attribute). It writes the persisted `sourceFolded` preference, so it runs
  // only on a throwaway instance — the same rule as the first-run wizard.
  const foldStart = await session.evaluate(SOURCE_FOLD_FACTS)
  if (!foldStart.found) {
    rec.add('W-4a', '来源级收拢（来源节折叠）', null, '实例里没有 [data-chamber-section]：无可收拢的来源节（见 W-2）')
  } else if (!allowPersistentWrites) {
    rec.add('W-4a', '来源级收拢（来源节折叠）', null,
      '未执行：本腿写入持久化偏好 sourceFolded（design 06 §3.1），只允许在一次性实例（--dev）上跑；--attach 面向真实状态')
  } else {
    // Normalize first: a previous run may have left the source folded.
    if (foldStart.expanded === false && foldStart.foldIndex !== null) {
      await session.evaluate(clickButtonAt(foldStart.foldIndex, foldStart.control))
      await sleep(settleMs)
    }
    const foldBefore = await session.evaluate(SOURCE_FOLD_FACTS)
    // Read the stored preference AFTER normalisation: the round trip below must
    // leave it exactly as it found it (design 06 §3.1).
    const foldPrefsBefore = await session.evaluate(VIEW_PREFS)
    const foldClick = foldBefore.foldIndex === null
      ? { clicked: false, drifted: false, identity: null }
      : await session.evaluate(clickButtonAt(foldBefore.foldIndex, foldBefore.control))
    await sleep(settleMs)
    const foldAfter = await session.evaluate(SOURCE_FOLD_FACTS)
    await shot('03c-source-folded')
    const foldRestore = await session.evaluate(CLICK_STASHED_BUTTON)
    await sleep(settleMs)
    const foldRestored = await session.evaluate(SOURCE_FOLD_FACTS)
    const foldPrefsAfter = await session.evaluate(VIEW_PREFS)
    await shot('03d-source-restored')
    const foldVerdict = sourceFoldVerdict({
      executed: true, identity: foldClick.identity, drift: foldClick.drifted,
      before: foldBefore, after: foldAfter, restored: foldRestored,
      prefs: { before: foldPrefsBefore, after: foldPrefsAfter },
    })
    rec.add('W-4a', '来源级收拢（来源节折叠）', foldVerdict.ok, foldVerdict.evidence)
  }

  // Row hover card (design 06 §7, id W-4b): identity-anchored, four legs.
  // Real pointer input throughout (Input.dispatchMouseEvent via moveMouse): a
  // synthetic DOM event would bypass the browser's own hit-testing, which is
  // what the hover machine reacts to. The only synthetic events are the two
  // dismiss-watch probes, documented above.
  const hover = await session.evaluate(HOVER_TARGETS)
  const hoverRow = hover.first
  const neutral = { x: Math.round(boot.viewport.width * 0.8), y: Math.round(boot.viewport.height * 0.7) }
  const away = async () => { await session.moveMouse(neutral.x, neutral.y); await sleep(HOVER_LEAVE_SETTLE_MS) }

  // Leg 1 (W-4b): dwell raises exactly one card, its text carries the hovered
  // row's OWN title, and leaving clears it. Screenshot kept as visual evidence.
  let hoverFacts = {
    cardable: false, anchorCount: hover.anchors, wrappedRows: hover.wrappedRows,
    note: `rows=${hover.rows} anchors=${hover.anchors} cardableTargets=${hoverRow === null ? 0 : 1}`,
  }
  if (hoverRow !== null) {
    await session.moveMouse(hoverRow.point.x, hoverRow.point.y)
    await sleep(HOVER_OPEN_WAIT_MS)
    const dwelling = await session.evaluate(CARD_FACTS)
    await shot('03c-hover-card')
    await away()
    const afterLeave = await session.evaluate(CARD_COUNT)
    hoverFacts = {
      cardable: true, opened: dwelling.count === 1, closed: afterLeave === 0,
      rowTitle: hoverRow.title, cardText: dwelling.text,
      anchorCount: hover.anchors, wrappedRows: hover.wrappedRows,
    }
  }
  const hoverVerdict = applyRequireHover(hoverCardVerdict(hoverFacts), requireHover)
  rec.add('W-4b', '行悬停卡片：悬停升起一张、文本匹配该行标题、移开消失', hoverVerdict.ok,
    `${hoverVerdict.evidence}${hoverRow === null ? '' : ` point=${JSON.stringify(hoverRow.point)}`}`)

  // Leg 2 (W-4b-race): the strand race, run on THIS run's measured window.
  // A strand needs the leave between the dwell callback and React's commit, so
  // the only discriminating offsets are (0, commitLatency] after the dwell; the
  // historical fixed band is only a lower bound on that window and can miss
  // entirely on a fast thread (adversarial review finding H5/#3). So: measure the
  // window, derive the offsets from it, and let the verdict say whether the run
  // could discriminate at all. Leg 1 already proved this very point raises a
  // card, so a clean run means the leave cancelled/settled it — not that the row
  // was inert. The loop stops at the first strand: a stranded card would
  // contaminate every later trial. No evaluate runs between enter and leave, so
  // the sampled timing is not disturbed by the probe itself.
  /**
   * Measure the dwell→commit window: enter the row, poll for the card marker
   * every ~HOVER_COMMIT_POLL_MS, and record `tLastMiss - tEnter - dwell`.
   *
   * WHY THE LAST MISS, NOT THE FIRST HIT: the paint happened somewhere inside the
   * poll interval that first saw the card, so the last poll that did NOT see it is
   * a STRICT LOWER bound of the commit time while the first hit is an upper bound.
   * Overshooting the commit is the direction that would let a broken bundle pass
   * (the leave would land after the open was committed, the vendored grace would
   * arm normally, and no card would strand), so the safe estimate is the lower
   * one. Across HOVER_COMMIT_SAMPLES samples the MAX of those lower bounds is the
   * tightest estimate that still cannot overshoot. `tEnter` is stamped AFTER
   * moveMouse resolves (the browser has dispatched the enter by then), which keeps
   * the bound on the safe side as well.
   * @returns the window in ms, or null when no card was observed within the limit.
   */
  const measureCommitLatency = async () => {
    const samples = []
    let usable = true
    for (let sample = 0; sample < HOVER_COMMIT_SAMPLES && usable; sample += 1) {
      // Bounded clear (not the fixed settle): poll until the card is gone.
      await session.moveMouse(neutral.x, neutral.y)
      const clearDeadline = Date.now() + HOVER_LEAVE_SETTLE_MS
      while (Date.now() < clearDeadline && await session.evaluate(CARD_COUNT) !== 0) await sleep(30)
      await session.moveMouse(hoverRow.point.x, hoverRow.point.y)
      const tEnter = Date.now()
      const deadline = tEnter + HOVER_DWELL_MS + HOVER_COMMIT_LIMIT_MS
      let lastMiss = null
      let painted = false
      while (Date.now() < deadline) {
        if (await session.evaluate(CARD_COUNT) > 0) { painted = true; break }
        lastMiss = Date.now()
        await sleep(HOVER_COMMIT_POLL_MS)
      }
      if (!painted) { usable = false; break }
      samples.push(Math.max(0, (lastMiss ?? tEnter) - tEnter - HOVER_DWELL_MS))
    }
    await away()
    return usable && samples.length > 0 ? Math.max(...samples) : null
  }

  let raceFacts = { trials: 0, stranded: 0, bandMs: [], windowMs: null }
  if (hoverRow !== null) {
    const windowMs = await measureCommitLatency()
    const offsets = raceBandForWindow(windowMs)
    const strandedTrials = []
    let trials = 0
    for (let trial = 0; trial < HOVER_RACE_TRIALS; trial += 1) {
      await session.moveMouse(hoverRow.point.x, hoverRow.point.y)
      await sleep(HOVER_DWELL_MS + offsets[trial % offsets.length])
      await session.moveMouse(neutral.x, neutral.y)
      // FIXED settle, deliberately NOT poll-until-zero: a strand commits shortly
      // AFTER the leave, so an early zero would report the trial clean before the
      // card that proves the defect has even mounted.
      await sleep(HOVER_RACE_SETTLE_MS)
      trials = trial + 1
      if (await session.evaluate(CARD_COUNT) !== 0) { strandedTrials.push(trial); break }
    }
    raceFacts = { trials, stranded: strandedTrials.length, bandMs: offsets, windowMs, strandedTrials }
  }
  const raceVerdict = applyRequireHover(hoverRaceVerdict(raceFacts), requireHover)
  rec.add('W-4b-race', '行悬停竞态：实测 dwell→提交窗口内移开不搁浅卡片', raceVerdict.ok, raceVerdict.evidence)

  // Leg 3 (W-4b-swap): exclusivity + self-heal. Hover row A until its card is
  // up, cross to row B, and sample the whole transition: the count must never
  // exceed ONE (A closes on the grace while B is still dwelling) and must end on
  // exactly one card carrying B's title. Both rows are re-picked here (the list
  // can reorder while the earlier legs run), and both must fit the viewport at
  // the same time — the point of A is never re-derived after the scroll.
  const swapTargets = await session.evaluate(HOVER_TARGETS)
  const pair = swapTargets.first === null || swapTargets.second === null ? null : swapTargets
  let swapFacts = {
    pairs: pair === null ? 0 : 2,
    note: `rows=${swapTargets.rows} anchors=${swapTargets.anchors} cardablePairs=${pair === null ? 0 : 2}`,
  }
  if (pair !== null) {
    await session.moveMouse(pair.first.point.x, pair.first.point.y)
    await sleep(HOVER_OPEN_WAIT_MS)
    const openedA = await session.evaluate(CARD_FACTS)
    const samples = [openedA.count]
    await session.moveMouse(pair.second.point.x, pair.second.point.y)
    for (let index = 0; index < HOVER_SWAP_SAMPLES; index += 1) {
      await sleep(HOVER_SWAP_SAMPLE_MS)
      samples.push(await session.evaluate(CARD_COUNT))
    }
    await sleep(HOVER_SWAP_END_WAIT_MS)
    const end = await session.evaluate(CARD_FACTS)
    samples.push(end.count)
    await shot('03d-hover-card-swap')
    await away()
    swapFacts = {
      pairs: 2, startCount: openedA.count, maxCount: Math.max(...samples), endCount: end.count,
      rowTitle: pair.second.title, endText: end.text,
      note: `samples=${samples.join(',')} A=${JSON.stringify(pair.first.title)} B=${JSON.stringify(pair.second.title)}`,
    }
  }
  const swapVerdict = applyRequireHover(hoverExclusiveVerdict(swapFacts), requireHover)
  rec.add('W-4b-swap', '行悬停互斥/自愈：切到 B 时始终至多一张，结束为 B 的卡片', swapVerdict.ok, swapVerdict.evidence)

  // Leg 4 (W-4b-dismiss): the page-level dismiss watch — window blur, and
  // visibilitychange while hidden — clears an open card. Synthetic events: this
  // verifies the LISTENER WIRING, not a real OS focus loss (see the probe
  // comments above). Visibility is restored even when an assertion throws.
  const dismissTarget = await session.evaluate(HOVER_TARGETS)
  const dismissRow = dismissTarget.first ?? hoverRow
  let dismissFacts = { cardable: dismissRow !== null }
  if (dismissRow !== null) {
    await session.moveMouse(dismissRow.point.x, dismissRow.point.y)
    await sleep(HOVER_OPEN_WAIT_MS)
    const beforeBlur = await session.evaluate(CARD_COUNT)
    await session.evaluate(DISPATCH_BLUR)
    await sleep(HOVER_DISMISS_SETTLE_MS)
    const afterBlur = await session.evaluate(CARD_COUNT)
    await away()
    await session.moveMouse(dismissRow.point.x, dismissRow.point.y)
    await sleep(HOVER_OPEN_WAIT_MS)
    const beforeHidden = await session.evaluate(CARD_COUNT)
    await session.evaluate(FORCE_HIDDEN)
    let afterHidden = null
    try {
      await sleep(HOVER_DISMISS_SETTLE_MS)
      afterHidden = await session.evaluate(CARD_COUNT)
    } finally {
      await session.evaluate(RESTORE_VISIBILITY)
    }
    await away()
    dismissFacts = {
      cardable: true,
      blur: { opened: beforeBlur === 1, cleared: afterBlur === 0 },
      hidden: { opened: beforeHidden === 1, cleared: afterHidden === 0 },
    }
  }
  const dismissVerdict = applyRequireHover(hoverDismissVerdict(dismissFacts), requireHover)
  rec.add('W-4b-dismiss', '行悬停失焦/隐藏清卡（监听接线，非真实 OS 失焦）', dismissVerdict.ok, dismissVerdict.evidence)

  // Settings surface (skipped while a first-run modal still owns the screen).
  if (blockedByModal) {
    rec.add('W-5', '设置面走查（被首启模态挡住，未执行）', null,
      '设置面在首启模态之下；请先走完/跳过首启流程，或用 --dev 在一次性实例上跑')
    await shot('04-blocked-by-modal')
  }
  const seatClicked = blockedByModal ? null : await session.evaluate(clickByLabel(SETTINGS_SEAT_LABELS))
  await sleep(settleMs + 1_000)
  const opened = await session.evaluate(DOM_FACTS)
  if (!blockedByModal) await shot('04-settings-open')
  if (!blockedByModal) rec.add('W-5', '设置面从侧栏座席打开', seatClicked !== null && opened.settingsOpen,
    `clicked=${JSON.stringify(seatClicked)} settingsOpen=${opened.settingsOpen} navItems=${opened.navLabels.length}`)
  if (blockedByModal) {
    // already reported above; nothing else to claim
  } else if (!opened.settingsOpen) {
    rec.add('W-6', '设置插槽渲染（settings.*）', null, `未打开设置面，后续走查跳过；slots=${opened.slots}`)
  } else {
    rec.add('W-6', '设置插槽渲染且无 slot 失败', opened.slots > 0 && opened.slotErrors.length === 0,
      `slots=${opened.slots} slotErrors=${JSON.stringify(opened.slotErrors)}`)
    rec.add('W-7', '设置导航项可用（结构选择器）', opened.navLabels.length >= 2, `navLabels=${JSON.stringify(opened.navLabels)}`)

    // Visit every nav item; the label alphabet is the instance's own language.
    const visited = []
    for (let index = 0; index < opened.navLabels.length; index += 1) {
      const label = await session.evaluate(clickNavItem(index))
      await sleep(settleMs)
      const facts = await session.evaluate(DOM_FACTS)
      const file = await shot(`05-tab-${String(index).padStart(2, '0')}-${(label ?? 'unknown').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 12) || 'tab'}`)
      visited.push({ index, label, panelChars: facts.panelChars, slots: facts.slots, slotErrors: facts.slotErrors, shot: file })
    }
    const empty = visited.filter(entry => entry.panelChars === 0 || entry.slotErrors.length > 0)
    rec.add('W-8', '每个设置页渲染内容且无 slot 失败', visited.length >= 2 && empty.length === 0,
      visited.map(entry => `${entry.label ?? '?'}(${entry.panelChars} chars,${entry.slots} slots)`).join(' | '))
    rec.add('W-9', '页面切换真的换内容', new Set(visited.map(entry => entry.panelChars)).size > 1,
      `panelChars=${visited.map(entry => entry.panelChars).join(',')}`)

    // Real Escape key event closes the surface.
    await session.pressKey('Escape', 'Escape', 27)
    await sleep(settleMs)
    const afterEscape = await session.evaluate(DOM_FACTS)
    await shot('06-after-escape')
    rec.add('W-10', '真实 Escape 关闭设置面', afterEscape.settingsOpen === false,
      `settingsOpen=${afterEscape.settingsOpen} 其它模态=${afterEscape.otherDialogs}`)
  }

  // Tolerance patterns match the RAW keys; the `×N` counts are display only.
  const withCounts = keys => keys.map(key => `${key} ×${session.netFailures.get(key) ?? 1}`)
  const netFailures = summarizeNetFailures(session.netFailures)
  const net = partitionFailures([...session.netFailures.keys()], TOLERATED_REQUEST_FAILURES)
  const unexpectedNet = withCounts(net.unexpected)
  const toleratedNet = withCounts(net.tolerated.map(entry => entry.split(' — ')[0]))
  rec.add('W-11', '走查期间无未预期的 ≥400 请求', net.unexpected.length === 0,
    [`未预期：${unexpectedNet.slice(0, 6).join(' | ') || '（无）'}`,
      `已登记容忍：${net.tolerated.slice(0, 4).join(' | ') || '（无）'}`].join('\n'))

  const consolePartition = partitionFailures(session.consoleErrors, KNOWN_UPSTREAM_BOOT_NOISE)
  rec.add('W-12', '走查期间无未预期的渲染层 error', consolePartition.unexpected.length === 0,
    [`未预期：${consolePartition.unexpected.slice(0, 4).join(' | ') || '（无）'}`,
      `已登记上游噪声：${consolePartition.tolerated.slice(0, 3).join(' | ') || '（无）'}`].join('\n'))

  const report = renderMarkdown({
    title: 'GUI 验收（--attach/--dev：CDP 走查）',
    meta: { 目标: target.url, CDP端口: cdpPort, 时间: new Date().toISOString(), 截图目录: shots },
    results: rec.results,
    netFailures,
    consoleErrors: session.consoleErrors,
    consoleWarnings: session.consoleWarnings,
  })
  const reportPath = path.join(outDir, 'gui-walkthrough-report.md')
  writeFileSync(reportPath, report)
  writeFileSync(path.join(outDir, 'gui-walkthrough-report.json'), JSON.stringify({
    meta: { target: target.url, cdpPort, shots }, results: rec.results, netFailures,
    consoleErrors: session.consoleErrors, consoleWarnings: session.consoleWarnings,
  }, null, 2))
  session.close()
  console.log(`\n=== 走查：${rec.passed} pass / ${rec.failed} fail / ${rec.results.length} checks ===\nreport: ${reportPath}\nscreenshots: ${shots}`)
  // `info` is carried out so a green run can say so: INFO means "not exercised",
  // and run.mjs prints the count instead of letting a pass read as full coverage.
  const counts = summarize(rec.results)
  return { results: rec.results, reportPath, shots, passed: counts.passed, failed: counts.failed, info: counts.info }
}
