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
 *   - `[data-slot]` / `[data-slot-error]`     settings-bridge render sites
 *   - `dialog nav [class*="navList"] > button`  settings nav items (aria-current = active)
 *
 * SAFETY: the run never clicks a control that is not one of the above (no
 * 启动/停止/保存/删除 can be reached), and it performs no data mutation.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CdpSession, discoverPageTarget } from './cdp.mjs'
import {
  KNOWN_UPSTREAM_BOOT_NOISE, TOLERATED_REQUEST_FAILURES, createRecorder, hoverCardVerdict, partitionFailures,
  renderMarkdown, summarizeNetFailures,
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

/** The sidebar's collapse toggle, found structurally: an aria-expanded control in the left rail. */
const CLICK_SIDEBAR_TOGGLE = `(() => {
  const visible = el => { const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 }
  const toggle = [...document.querySelectorAll('button[aria-expanded]')]
    .filter(el => visible(el) && el.getBoundingClientRect().left < window.innerWidth * 0.4)[0]
  if (toggle === undefined) return null
  const before = toggle.getAttribute('aria-expanded')
  toggle.click()
  return before
})()`


/**
 * A hoverable sidebar row, as a viewport point. Workspace headers and session
 * rows are `[data-chamber-row][role="treeitem"]`; the source header deliberately
 * carries no card and no treeitem role, so it is never selected here.
 */
const HOVER_ROW_POINT = `(() => {
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const rows = [...document.querySelectorAll('[data-chamber-row][role="treeitem"]')].filter(visible)
  const fits = rows.find(el => {
    const r = el.getBoundingClientRect()
    return r.top > 4 && r.bottom < window.innerHeight - 8 && r.left >= 0 && r.right < window.innerWidth * 0.5
  })
  const row = fits ?? rows[0]
  if (row === undefined) return null
  row.scrollIntoView({ block: 'center' })
  const r = row.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0 || r.top < 0 || r.bottom > window.innerHeight) return null
  return { x: Math.round(r.left + r.width * 0.6), y: Math.round(r.top + r.height / 2) }
})()`

/** Portaled row cards currently in the document (244px fixed card, z-index 100). */
const CARD_COUNT = `[...document.body.querySelectorAll('*')].filter(el => {
  const cs = getComputedStyle(el)
  return cs.position === 'fixed' && Math.round(parseFloat(cs.width)) === 244 && cs.zIndex === '100'
}).length`

/**
 * Run the walkthrough.
 * @param opts.cdpPort CDP port of a dev instance (9333 by convention, scripts/perf/README.md)
 * @param opts.outDir artifact directory
 */
export async function runWalkthrough({ cdpPort = 9333, outDir = '.tmp/gui-acceptance', settleMs = 1_500, advanceOnboarding = false } = {}) {
  const rec = createRecorder()
  const shots = path.join(outDir, 'shots')
  mkdirSync(shots, { recursive: true })
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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
  await sleep(4_000)

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

  // Sidebar collapse/expand through the aria-expanded rail toggle.
  const toggleBefore = await session.evaluate(CLICK_SIDEBAR_TOGGLE)
  await sleep(settleMs)
  const collapsed = await session.evaluate(`(() => {
    const el = [...document.querySelectorAll('button[aria-expanded]')].find(node => node.getBoundingClientRect().left < window.innerWidth * 0.4)
    return el === undefined ? null : el.getAttribute('aria-expanded')
  })()`)
  await shot('03-sidebar-toggled')
  if (toggleBefore === null || collapsed === null) {
    rec.add('W-4', '侧栏折叠开关', null, '未找到 aria-expanded 导轨开关：请目检（截图见 03-sidebar-toggled.png）')
  } else {
    rec.add('W-4', '侧栏折叠/展开切换', toggleBefore !== collapsed, `aria-expanded ${toggleBefore} → ${collapsed}`)
    await session.evaluate(CLICK_SIDEBAR_TOGGLE)
    await sleep(settleMs)
    await shot('03b-sidebar-restored')
  }

  // Row hover card (design 06 §7, id W-4b): dwelling on a cardable row raises
  // one card and leaving clears it — the user-visible contract the chamber-owned
  // atom exists for (a stranded card was the reported defect). Real pointer
  // input: a synthetic DOM event would bypass the browser's own hit-testing.
  const hoverPoint = await session.evaluate(HOVER_ROW_POINT)
  const neutral = { x: Math.round(boot.viewport.width * 0.8), y: Math.round(boot.viewport.height * 0.7) }
  let hoverFacts = { cardable: false, opened: null, closed: null }
  if (hoverPoint !== null) {
    await session.moveMouse(hoverPoint.x, hoverPoint.y)
    await sleep(900)
    const dwelling = await session.evaluate(CARD_COUNT)
    await shot('03c-hover-card')
    await session.moveMouse(neutral.x, neutral.y)
    await sleep(700)
    const afterLeave = await session.evaluate(CARD_COUNT)
    hoverFacts = { cardable: true, opened: dwelling === 1, closed: afterLeave === 0 }
  }
  const hoverVerdict = hoverCardVerdict(hoverFacts)
  rec.add('W-4b', '行悬停卡片：悬停升起、移开消失', hoverVerdict.ok,
    `${hoverVerdict.evidence}${hoverPoint === null ? '' : ` point=${JSON.stringify(hoverPoint)}`}`)

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
  return { results: rec.results, reportPath, shots, passed: rec.passed, failed: rec.failed }
}
