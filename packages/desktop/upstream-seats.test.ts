/**
 * Upstream desktop seat lock (2026-09 calibration S-51/S-52): both flavors install
 * the two things the official Web client looks for — the document platform mark
 * (`data-platform`) and the \`globalThis.dshDesktop\` carrier — and the carrier keeps
 * the upstream shape (protocolVersion 1 + status/open/subscribe) with an identical
 * phase mapping on both sides (one chamber UpdateState source).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(DESKTOP, '..', '..')
const preload = readFileSync(join(DESKTOP, 'preload.cts'), 'utf8')
const shim = readFileSync(
  join(REPO_ROOT, 'macos', 'Sources', 'DSHChamber', 'Resources', 'bridge-shim.js'),
  'utf8',
)

test('S-51: both flavors mark the document platform', () => {
  assert.match(
    preload,
    /document\.documentElement\.dataset\.platform = process\.platform/,
    'Electron mirrors upstream preload-platform.ts (process.platform)',
  )
  assert.match(
    shim,
    /document\.documentElement\.dataset\.platform = platform/,
    'the Swift shell marks the host platform (darwin on its only supported host, design 25)',
  )
})

test('S-52: both flavors expose the upstream dshDesktop carrier', () => {
  const arms: [string, string][] = [['preload', preload], ['shim', shim]]
  for (const [name, text] of arms) {
    assert.match(text, /dshDesktop/, name + ' must install the dshDesktop carrier')
    assert.match(text, /protocolVersion: 1,/, name + ' must carry upstream protocolVersion 1')
    assert.match(text, /status: (?:function \(\)|\(\) =>)/, name + ' must implement status()')
    assert.match(text, /open: (?:function \(\)|\(\) =>)/, name + ' must implement open()')
    assert.match(text, /subscribe: (?:function|\()/, name + ' must implement subscribe()')
    // One mapping, both arms: downloaded → ready, everything else idle-ish.
    assert.match(text, /case 'downloaded': return withVersion\('ready'\)/, name + ' maps downloaded → ready')
    assert.match(text, /default: return \{ phase: 'idle' \}/, name + ' maps up-to-date/unknown → idle')
  }
})

// native theme seat（上游 apps/desktop/src/preload-theme.ts + main.ts 的 syncNativeTheme）
// 尚未移植：Electron 腿需要一条新的 invoke 通道（dsh-chamber:native-theme-set）——
// 它同时改桥面计数（manifest / Swift 白名单 / shim 载荷锁步），属跨面包改动；Swift
// 腿已由 ShellPageFacts → applyAppearance 承担（design 25 §5.3，本文件不再需要该臂）。
// 开放项登记在 STATUS「取件移植」条；接线后把原断言补回本文件（原文见 git 历史：
// backup/v016-alpha1-pre-reset:packages/desktop/upstream-seats.test.ts）。

test('S-52: the carrier classifies the failed operation like upstream', () => {
  // Upstream DesktopUpdateFailureKind: the official error copy is chosen from
  // presentation.failure. Both arms track the in-flight operation and name it on
  // error (we ship the three non-network kinds; the *-network refinements need a
  // transport verdict the chamber does not carry).
  assert.match(preload, /let upstreamActiveOperation: 'check' \| 'download' \| 'install' = 'check'/)
  assert.match(preload, /failure: upstreamActiveOperation/)
  assert.match(shim, /var upstreamActiveOperation = 'check'/)
  assert.match(shim, /failed\.failure = upstreamActiveOperation/)
  for (const [name, text] of [['preload', preload], ['shim', shim]] as [string, string][]) {
    assert.match(text, /upstreamActiveOperation = 'download'/, name + ' tracks download failures')
    assert.match(text, /upstreamActiveOperation = 'install'/, name + ' tracks install failures')
    assert.match(text, /'checking'\) upstreamActiveOperation = 'check'|upstreamActiveOperation = 'check'/, name + ' tracks check failures')
  }
})

test('Windows caption seat: preload marker + hidden-titlebar window branch', () => {
  // Upstream preload-windows.ts:8-14 + windows-layout.ts:4: the shared Web UI's
  // Windows branch keys off html[data-windows-titlebar] and the height variable.
  assert.match(preload, /process\.platform !== 'win32'\) return/, 'the mark is win32-only')
  assert.match(preload, /root\.dataset\.windowsTitlebar = ''/)
  assert.match(preload, /root\.style\.setProperty\('--dsh-windows-titlebar-height', WINDOWS_TITLEBAR_HEIGHT \+ 'px'\)/)
  // Mirrored constants must stay equal (preload cannot import across the CJS boundary).
  const main = readFileSync(join(DESKTOP, 'main.ts'), 'utf8')
  const constant = /const WINDOWS_TITLEBAR_HEIGHT = (\d+);/
  const preloadHeight = preload.match(constant)?.[1]
  const mainHeight = main.match(constant)?.[1]
  assert.equal(preloadHeight, '40', 'preload mirrors upstream windows-layout.ts:4')
  assert.equal(mainHeight, preloadHeight, 'main and preload must agree on the caption height')
  assert.match(main, /titleBarStyle: 'hidden' as const/, 'upstream main.ts:118-122 win32 branch')
  assert.match(main, /titleBarOverlay: \{/)
  assert.match(preload, /markWindowsTitlebar\(\);/, 'bootstrap installs the mark')
})

test('S-52: the carrier is installed before info hydration', () => {
  assert.ok(
    preload.indexOf('exposeDesktopCarrier();') < preload.indexOf('requestAppInfo().then('),
    'Electron: the carrier must precede the bridge payload request',
  )
  // lastIndexOf: the rehydrate helper declares an earlier fetchInfo call, the
  // kick-off at the end of the IIFE is the one that must follow the carrier.
  assert.ok(
    shim.indexOf("defineWindowGlobal('dshDesktop', dshDesktopCarrier)") < shim.lastIndexOf('fetchInfo(INFO_MAX_ATTEMPTS + 1)'),
    'Swift: the carrier must precede info hydration',
  )
})
