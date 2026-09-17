/**
 * 「重启并安装」退出腿的源码契约（design 11，2026-12 实机缺陷回归）。
 *
 * 缺陷：macOS 上 electron-updater 的 `quitAndInstall()` → Electron 原生
 * `autoUpdater.quitAndInstall()` **先关闭全部窗口、再退出**（Electron 43.4.0
 * typings `AutoUpdater#before-quit-for-update` 明文：`before-quit` 不会在窗口
 * 关闭前发出；本机 43.4.0/darwin 探针亦证实 autoUpdater 的
 * `before-quit-for-update` 与窗口 `close` 都发生在调用内部）。而 main.ts 的
 * 「关窗到托盘」（design 14 D1，默认 `hide-to-tray`）只在 `quitRequested`
 * （由 `before-quit` 置位，即关窗**之后**）才放行关窗，于是更新退出腿的关窗被
 * hide 吞掉：页面消失、进程连同本地 dsh/隧道永久留存、更新永不安装。
 *
 * 这些断言把修复钉死在 main.ts 的接线上（纯函数判定本身见 chamber-settings.test.ts）：
 *  - 关窗裁决必须把 `updaterQuitArmed` 交给共享关窗决策
 *    （S-08 起的 decideMainWindowClose，其 hide 分支仍单源在 shouldHideToTray）；
 *  - 控制器必须挂上 `onQuitAndInstallArmed: armUpdaterQuit`——该回调是唯一「真的
 *    武装了原生退出」的证据点，且是关窗前的最后一个同步指令（控制器内不早于
 *    quitAndInstall 的调用点、拒绝路径不触发，见 updater-restart-install.test.ts）；
 *  - updater 状态订阅必须在重启失败/停滞（一次性 restartFailureText）或相位离开
 *    `downloaded` 时撤回武装，并把被关掉的窗口拉回来。
 *
 * 真实的 macOS 端到端（点击 → 窗口真正关闭 → will-quit 清理日志 → 进程退出码 0
 * → 新版本自动启动）仍是实机门禁（design 11 §9 / docs/progress/STATUS.md）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const desktopMain = readFileSync(join(import.meta.dirname, '..', '..', 'main.ts'), 'utf8')

/** Comment-stripped main.ts (shared quote-aware stripper): the flag assertions
 *  below must not be satisfiable by a COMMENTED-OUT line —
 *  `// updaterQuitArmed = true;` is the commonest way to disable a fix while
 *  debugging (2026-09-13 round-2 review F3). */
const desktopCode = stripComments(desktopMain)

// W-10 (design 25 §4.1 seam): the updater registration bodies and the state
// subscription live in shell-core.ts's installIpcHandlers (deps.ipc.handle);
// main.ts keeps only the assembly, the arming/disarming host state and the
// controller creation. The two assertions that pin the IPC/subscription side
// therefore read shell-core.ts, comment-stripped the same way.
const coreSource = readFileSync(join(import.meta.dirname, '..', '..', 'shell-core.ts'), 'utf8')
const coreCode = stripComments(coreSource)

/**
 * Top-level `;`-separated statements of a `{ … }` block, whitespace collapsed.
 * Statement level, not substring: `if (false) updaterQuitArmed = true;` contains
 * the literal but never runs, and that mutation used to survive this file.
 */
function blockStatements(block: string): string[] {
  const inner = block.slice(1, -1)
  const statements: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (ch === '{' || ch === '(' || ch === '[') depth += 1
    else if (ch === '}' || ch === ')' || ch === ']') depth -= 1
    else if (ch === ';' && depth === 0) {
      statements.push(inner.slice(start, i).replace(/\s+/g, ' ').trim())
      start = i + 1
    }
  }
  const tail = inner.slice(start).replace(/\s+/g, ' ').trim()
  if (tail !== '') statements.push(tail)
  return statements.filter((statement) => statement !== '')
}

/** The `{ … }` block that starts at or after `from` (balanced braces). */
function balancedBlock(source: string, from: number): string {
  const open = source.indexOf('{', from)
  assert.notEqual(open, -1, 'no block found in main.ts')
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  assert.fail('unbalanced block in main.ts')
}

test('main.ts: the close handler passes the armed update restart into the shared close decision', () => {
  const marker = "win.on('close', (event) => {"
  const first = desktopCode.indexOf(marker)
  assert.notEqual(first, -1, 'the main-window close handler is gone from main.ts')
  assert.equal(desktopCode.indexOf(marker, first + 1), -1,
    'a second close handler appeared — this contract must be pointed at the one that guards hide-to-tray')
  const handler = balancedBlock(desktopCode, first)
  // S-08（2026-12 审计）后 hide 裁决由纯函数 decideMainWindowClose 承担（其中
  // shouldHideToTray 仍是 hide 分支的单源，真值表见 chamber-settings.test.ts）；
  // 这里钉住同一意图：关窗路由必须把 updaterQuitArmed 交给共享决策，否则被
  // 武装的更新重启会被 hide/defer 吞掉，退出链死亡。
  assert.match(handler, /decideMainWindowClose\(\{/,
    'the close route must go through the shared close decision')
  assert.match(handler, /updateRestartArmed: updaterQuitArmed/,
    'the close handler must weigh updaterQuitArmed — otherwise an armed update restart is hidden to tray and the quit chain dies')
  assert.match(handler, /event\.preventDefault\(\)/, 'the hide/defer branches must preventDefault')
})

test('main.ts: the controller is given the arming hook, and the restart handler stays a plain call', () => {
  const creationStart = desktopMain.indexOf('createUpdateController({')
  assert.notEqual(creationStart, -1, 'createUpdateController is gone from main.ts')
  const creation = balancedBlock(desktopMain, creationStart)
  assert.match(creation, /onQuitAndInstallArmed: armUpdaterQuit/,
    'the close-to-tray exception must be armed by the controller hook (the only proof the native quit was really armed)')
  assert.match(creation, /onNativeUpdaterQuitting: armNativeUpdaterQuit/,
    'the native before-quit-for-update signal must be bridged to the host (late native quit + quit fallback)')
  const handlerStart = coreCode.indexOf('deps.ipc.handle(IPC_CHANNELS.UPDATE_RESTART')
  assert.notEqual(handlerStart, -1, 'the UPDATE_RESTART handler is gone from shell-core.ts')
  const statementEnd = coreCode.indexOf(';\n', handlerStart)
  assert.notEqual(statementEnd, -1, 'the UPDATE_RESTART handler statement is unterminated')
  const handler = coreCode.slice(handlerStart, statementEnd)
  assert.match(handler, /updater\.restartAndInstall\(\)/,
    'the IPC boundary must stay a plain call: arming and its rollback belong to the controller hook + the failure pushes')
  assert.equal(handler.includes('armUpdaterQuit()'), false,
    'the handler must not arm by itself — a gate refusal would arm a restart that never happens')
})

test('main.ts: the native quit fallback is bounded, guarded, and released with the arming', () => {
  const armStart = desktopMain.indexOf('function armNativeUpdaterQuit(')
  assert.notEqual(armStart, -1, 'armNativeUpdaterQuit is gone from main.ts')
  const arm = balancedBlock(desktopMain, armStart)
  assert.match(arm, /armUpdaterQuit\(\)/, 'a native quit must re-arm the close-to-tray exception (a late native quit after a stall)')
  assert.match(arm, /setTimeout\(/, 'the fallback must be time-bounded')
  assert.match(arm, /UPDATER_QUIT_FALLBACK_MS/, 'the grace must be the named constant — never an inline literal')
  assert.match(arm, /const windowAlive = mainWindow !== null && !mainWindow\.isDestroyed\(\)/,
    'window liveness must be read at fire time — it is the predicate input proving the update leg really closed the window')
  assert.match(arm, /shouldUpdaterQuitTakeOver\(quitRequested, updaterQuitArmed, windowAlive\)/,
    'the three guards must go through the pure predicate (behavioural truth table in chamber-settings.test.ts)')
  assert.match(arm, /app\.quit\(\)/, 'the fallback must drive a real quit (the native macOS leg stops after closing windows)')
  assert.match(arm, /unref/, 'the fallback timer must never hold the process alive')
  const disarm = balancedBlock(desktopMain, desktopMain.indexOf('function disarmUpdaterQuit('))
  assert.match(disarm, /clearTimeout\(updaterQuitFallback\)/,
    'releasing the arming on a restart failure must also cancel the pending fallback (no self-quit after the window came back)')
  const handlerBody = balancedBlock(desktopMain, desktopMain.indexOf("app.on('window-all-closed'"))
  assert.match(handlerBody, /process\.platform !== 'darwin' \|\| chamberSettings\.windowCloseBehavior === 'quit'/,
    'window-all-closed must keep its darwin/hide-to-tray condition: the update quit leg relies on the bounded native fallback, never on a blanket quit here')
})

test('main.ts: the arming flag really is set and really is released (the fix IS the flag)', () => {
  // Regression guard for the mutation that used to survive this file: deleting
  // `updaterQuitArmed = true;` from the arming hook disabled the whole fix while
  // every wiring assertion above still passed (2026-09-13 review B3). The flag's
  // lifecycle is the fix, so it is asserted directly — the pure decisions it
  // feeds are behaviourally covered in chamber-settings.test.ts.
  //
  // Round-2 review F3: matching the raw text made the guard blind to the two
  // commonest ways to disable a line without deleting it. Comments are stripped
  // and the assignment must be a TOP-LEVEL statement of the hook, so neither
  // `// updaterQuitArmed = true;` nor `if (false) updaterQuitArmed = true;` passes.
  const declaration = /let updaterQuitArmed = false;/.exec(desktopCode)
  assert.notEqual(declaration, null, 'the arming flag must start false at module scope')
  const armBlock = balancedBlock(desktopCode, desktopCode.indexOf('function armUpdaterQuit('))
  const armStatements = blockStatements(armBlock)
  assert.match(armBlock, /if \(updaterQuitArmed\) return;/,
    're-arming must be idempotent (a second native event must not restart the log line)')
  assert.ok(armStatements.includes('updaterQuitArmed = true'),
    'the arming hook must SET the flag as a top-level statement — deleting it, commenting it out '
    + 'or wrapping it in dead code must all fail here, because without it nothing about the fix works')
  const disarmBlock = balancedBlock(desktopCode, desktopCode.indexOf('function disarmUpdaterQuit('))
  const disarmStatements = blockStatements(disarmBlock)
  assert.match(disarmBlock, /if \(!updaterQuitArmed\) return;/,
    'releasing an unarmed leg must be a no-op (no spurious window restore)')
  assert.ok(disarmStatements.includes('updaterQuitArmed = false'),
    'releasing must CLEAR the flag as a top-level statement — otherwise the close-to-tray semantics '
    + 'never come back')
  // Order matters inside the arm: the flag is set before anything else can run.
  assert.match(armBlock, /console\.log/, 'the arm still logs the arming (the operator visible half)')
  assert.ok(armBlock.indexOf('updaterQuitArmed = true') < armBlock.indexOf('console.log'),
    'the flag must be set before the log line, so the log never claims an arming that did not happen')
})

test('main.ts: the updater state subscription disarms on restart failure and restores the window', () => {
  const subscribeStart = coreCode.indexOf('updater.subscribe((updateState) => {')
  assert.notEqual(subscribeStart, -1, 'the updater state subscription is gone from shell-core.ts')
  const subscription = balancedBlock(coreCode, subscribeStart)
  assert.match(subscription, /updateState\.restartFailureText !== undefined \|\| updateState\.phase !== 'downloaded'/,
    'a restart failure push (one-shot restartFailureText, phase stays downloaded) or a phase that left downloaded must release the arming')
  // W-10: core reaches the arming state through the ctx leaf (the host state
  // itself stays in main.ts — see the disarm assertions below).
  assert.match(subscription, /disarmUpdaterQuit\?\.\(/, 'the release path must go through the ctx disarmUpdaterQuit leaf')
  const disarm = balancedBlock(desktopMain, desktopMain.indexOf('function disarmUpdaterQuit('))
  assert.match(disarm, /showMainWindow\(\)/,
    'when the update quit leg already closed the window, the failure must bring it back — that is the only honest failure surface')
})
