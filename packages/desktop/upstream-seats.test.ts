/**
 * Upstream desktop seat lock (2026-09 calibration S-52): both flavors install the
 * \`globalThis.dshDesktop\` carrier the official Web client looks for, and the carrier
 * keeps the upstream shape (protocolVersion 1 + status/open/subscribe) with an
 * identical phase mapping on both sides (one chamber UpdateState source).
 *
 * S-51 (the `data-platform` document mark) is locked by
 * test/ipc/desktop-carrier-surface.test.ts ④ — do not re-pin it here.
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

test('native theme seat: the Electron arm observes data-ds-theme-source like upstream', () => {
  // Upstream syncNativeTheme() (apps/desktop/src/preload-theme.ts): the Web UI writes
  // html[data-ds-theme-source]; the bootstrap mirrors it to the host so window chrome
  // follows the APP palette instead of the OS appearance. Only the Electron arm
  // carries the observer — the Swift shell already follows page facts
  // (ShellPageFacts → applyAppearance, design 25 §5.3) — so the shared channel keeps
  // its member on both faces while the node edge is a documented no-op.
  assert.match(preload, /'data-ds-theme-source'/, 'the observer reads the theme-source attribute')
  assert.match(preload, /'dsh-chamber:native-theme-set'/, 'the observer invokes the theme channel')
  assert.match(preload, /typeof MutationObserver === 'undefined'\) return/, 'DOM-less hosts skip')
  assert.match(preload, /function syncNativeTheme\(\): void \{/, 'bootstrap-internal observer')
  assert.match(preload, /if \(process\.platform !== 'darwin'\) return/, 'macOS-only like upstream')
  assert.match(preload, /MutationObserver\(send\)\.observe\(document\.documentElement/,
    'the observer watches the root attribute')
  const shellSettings = readFileSync(join(DESKTOP, 'shell-ipc-settings.ts'), 'utf8')
  assert.match(shellSettings, /IPC_CHANNELS\.NATIVE_THEME_SET/, 'core handles the channel')
  assert.match(shellSettings, /deps\.edges\.nativeThemeSet\(source\)/, 'core routes it through the host edge')
  const electronEdges = readFileSync(join(DESKTOP, 'electron-edges.ts'), 'utf8')
  assert.match(electronEdges, /nativeTheme\.themeSource = source/, 'Electron sets nativeTheme.themeSource')
  const nodeEdges = readFileSync(join(DESKTOP, 'node-edges.ts'), 'utf8')
  assert.match(nodeEdges, /nativeThemeSet\(_source: 'light' \| 'dark' \| 'system'\)/,
    'the Swift face keeps the member for the shared edge type')
  assert.match(nodeEdges, /显式 no-op/, 'the Swift arm documents why it does not forward the edge')
})

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
    assert.match(text, /'checking'\) upstreamActiveOperation = 'check'/, name + ' tracks check failures')
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

test('S-54: the macOS window chrome mirrors the upstream darwin branch', () => {
  // Upstream apps/desktop/src/main.ts:219-225 (darwin): hiddenInset puts the
  // traffic lights inside the sidebar strip, sidebar vibrancy needs the window's
  // background to stay transparent, and 'active' keeps the material stable when
  // the window blurs. The page side is upstream ui-web/ui-layout CSS (transparent
  // frame, --dsh-frame-top-clearance 48px); the fullscreen mark is S-53.
  const main = readFileSync(join(DESKTOP, 'main.ts'), 'utf8')
  assert.match(main, /process\.platform === 'darwin'/, 'the darwin branch must exist')
  assert.match(main, /titleBarStyle: 'hiddenInset' as const/)
  assert.match(main, /trafficLightPosition: \{ x: 16, y: 18 \}/)
  assert.match(main, /vibrancy: 'sidebar' as const/)
  assert.match(main, /visualEffectState: 'active' as const/)
  assert.match(main, /backgroundColor: '#00000000'/, 'the vibrancy material needs a transparent window background')
  // The non-macOS/non-Windows fallback keeps the first-frame fill (no white flash).
  assert.match(main, /: \{ backgroundColor: '#0f1115' \}/)
})

test('S-55: the darwin mark publishes the vibrancy marker the page rules gate on', () => {
  // The page's "yield the fill to the window material" rules (renderer/styles.css
  // .app/.instance-view, the sidebar's .root/.brand/.newSession) are gated on
  // html[data-platform=darwin][data-window-vibrancy], never on data-platform alone;
  // macos CrossLanguageLockstepTests locks the Swift shim half. The Electron window
  // now carries the same material, so its preload mark must publish the marker too —
  // without it the vibrancy stays hidden behind the page's opaque fills.
  assert.match(preload, /dataset\.windowVibrancy = 'true'/)
  assert.match(preload, /if \(process\.platform === 'darwin'\) document\.documentElement\.dataset\.windowVibrancy = 'true'/)
  assert.match(preload, /dataset\.platform = process\.platform/, 'the platform mark stays (upstream preload-platform.ts)')
})

test('S-52: the carrier is installed before info hydration', () => {
  assert.ok(
    preload.indexOf('exposeDesktopCarrier();') < preload.indexOf('requestAppInfo().then('),
    'Electron: the carrier must precede the bridge payload request',
  )
  // lastIndexOf: the rehydrate helper declares an earlier fetchInfo call, the
  // kick-off at the end of the IIFE is the one that must follow the carrier.
  // Both indexes must exist: a renamed carrier previously made this assertion
  // vacuously true (-1 < n).
  const carrierInstall = shim.indexOf("defineWindowGlobal('dshDesktop', dshDesktopApi)")
  const hydrationKickoff = shim.lastIndexOf('fetchInfo(INFO_MAX_ATTEMPTS + 1)')
  assert.ok(carrierInstall !== -1, 'Swift: the shim must install the dshDesktop carrier')
  assert.ok(hydrationKickoff !== -1, 'Swift: the shim must kick off info hydration')
  assert.ok(
    carrierInstall < hydrationKickoff,
    'Swift: the carrier must precede info hydration',
  )
})

test('S-53: the Electron flavor mirrors the fullscreen mark like the Swift shell', () => {
  // vendor apps/desktop/src/preload-platform.ts writes html[data-fullscreen]; the
  // Electron flavor has no preload equivalent, so main pushes the same expression on
  // enter/leave and replays it after every load (the Swift shell does it natively in
  // ShellWindowFullscreenMark.swift — same spelling, same dataset form).
  const main = readFileSync(join(DESKTOP, 'main.ts'), 'utf8')
  const swift = readFileSync(
    join(REPO_ROOT, 'macos', 'Sources', 'DSHChamber', 'ShellWindowFullscreenMark.swift'),
    'utf8',
  )
  for (const [name, text] of [['main', main], ['swift', swift]] as const) {
    assert.match(text, /document\.documentElement\.dataset\.fullscreen = 'true'/, name + ' must set the fullscreen mark')
    assert.match(text, /delete document\.documentElement\.dataset\.fullscreen/, name + ' must clear the fullscreen mark')
  }
  for (const event of ['enter-full-screen', 'leave-full-screen']) {
    assert.ok(main.includes("'" + event + "'"), 'main must listen to ' + event)
  }
  assert.match(main, /did-finish-load/, 'main must replay the mark after a load')
})

test('item 71: both flavors read the questionnaire machine description from the info payload', () => {
  // Upstream preload-app.ts exposes dshDesktop.deviceInfo() reading the info payload;
  // the payload field is produced once in shell-ipc-settings.ts (readDeviceInfo).
  assert.match(preload, /deviceInfo: \(\) => readAppInfo\(\)\.then/, 'preload must read the payload on demand')
  assert.match(shim, /deviceInfo: function \(\)/, 'shim must expose deviceInfo')
  assert.match(shim, /fetchInfo\(INFO_MAX_ATTEMPTS \+ 1\)/, 'shim must read the payload through the info channel')
})

test('S-56: both flavors expose the upstream host-path carrier', () => {
  // Upstream apps/desktop/src/preload-app.ts:79-84 (__DSH_HOST_PATHS__): the composer
  // cites dropped/picked files and folders that have a real host path as @ references.
  // Electron mirrors webUtils.getPathForFile exactly; the Swift shell cannot query
  // WebKit for a DOM File path, so its shim pairs the event batch with a native
  // drag-pasteboard catalog. Both arms install the global at documentStart and gate
  // on the chamber renderer's painted-source document mark.
  assert.match(preload, /contextBridge\.exposeInMainWorld\('__DSH_HOST_PATHS__'/)
  assert.match(preload, /webUtils\.getPathForFile/)
  assert.match(preload, /function exposeHostPaths\(\): void \{/)
  assert.match(preload, /data-chamber-painted-source/)
  const hostPathsCall = preload.indexOf('exposeHostPaths();')
  const bridgeRequest = preload.indexOf('requestAppInfo().then(')
  assert.notEqual(hostPathsCall, -1, 'Electron: the bootstrap must call exposeHostPaths()')
  assert.notEqual(bridgeRequest, -1, 'Electron: the bridge payload request must stay')
  assert.ok(hostPathsCall < bridgeRequest, 'Electron: the carrier must precede the bridge payload request')
  assert.match(shim, /defineWindowGlobal\('__DSH_HOST_PATHS__', \{ pathFor: hostPathFor \}\)/)
  assert.match(shim, /defineWindowGlobal\('__dshChamberHostPaths', adoptHostPathCatalog\)/)
  assert.match(shim, /data-chamber-painted-source/)
  const scope = readFileSync(join(REPO_ROOT, 'packages', 'renderer', 'src', 'host-path-scope.ts'), 'utf8')
  assert.match(scope, /HOST_PATH_SCOPE_ATTRIBUTE = 'data-chamber-painted-source'/)
  assert.match(scope, /export function publishHostPathScope/)
  // The VALUE contract too: both carriers compare against the local instance id, and a
  // rename would otherwise silently disable the carrier on both flavors with every gate
  // green (fail-closed, but the feature dies unnoticed).
  const localInstance = readFileSync(join(REPO_ROOT, 'packages', 'renderer', 'src', 'local-instance.ts'), 'utf8')
  assert.match(localInstance, /LOCAL_INSTANCE_ID = 'local'/)
  assert.match(preload, /getAttribute\('data-chamber-painted-source'\) === 'local'/)
  assert.match(shim, /getAttribute\('data-chamber-painted-source'\) === 'local'/)
})
