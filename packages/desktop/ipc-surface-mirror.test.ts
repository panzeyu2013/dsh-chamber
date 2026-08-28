/**
 * IPC surface mirror lockstep tests (2026 audit L3): the bridge types are
 * hand-mirrored across packages/desktop/preload.cts (the surface contract),
 * packages/renderer/src/global.d.ts and the settings-connections plugin's
 * global.d.ts (interface merging requires identical shapes). A structural
 * comparison of METHOD sets AND FIELD sets turns a silent drift into a loud
 * test failure — the field check catches shape drift inside helper types
 * (e.g. a missing `chamber` / `gitWorktree` / `notifications` field).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')

/** The balanced-brace block of one interface/type declaration. For union
 *  aliases (`type X = | {…} | {…}`) the block spans ALL members: after a
 *  depth-0 closing brace, a `|` continuation keeps the scan going. */
function interfaceBlock(source: string, typeName: string): string {
  // Word-boundary anchored: `ChamberSettings` must not prefix-match
  // `ChamberSettingsStatus`.
  const start = source.search(new RegExp(`\\binterface ${typeName}\\b`))
  const startType = start === -1 ? source.search(new RegExp(`\\btype ${typeName}\\b`)) : start
  assert.notEqual(startType, -1, `${typeName} not found in the source`)
  const open = source.indexOf('{', startType)
  assert.notEqual(open, -1, `${typeName} has no opening brace`)
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        // Union continuation: a `|` right after the brace means more members.
        let j = i + 1
        while (j < source.length && /\s/.test(source[j])) j += 1
        if (source[j] === '|') continue
        end = i
        break
      }
    }
  }
  assert.notEqual(end, -1, `${typeName} has no closing brace`)
  return source.slice(open + 1, end)
}

/** Strip block + line comments so comment prose cannot pollute the scans.
 *  Line comments are stripped only at line START (after optional indentation)
 *  — a `//` inside a string literal must survive (2026 review hardening). */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n')
}

/** Extract the sorted method names of one interface block. */
function interfaceMethodNames(source: string, interfaceName: string): string[] {
  const names: string[] = []
  for (const line of stripComments(interfaceBlock(source, interfaceName)).split('\n')) {
    const match = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\(/.exec(line)
    if (match !== null) names.push(match[1])
  }
  return names.sort()
}

/** Extract the sorted field names of one interface/type block (covers union
 *  member shapes like `| { ok: true; hostGraph: ... }`). */
function interfaceFieldNames(source: string, typeName: string): string[] {
  const fields = new Set<string>()
  for (const line of stripComments(interfaceBlock(source, typeName)).split('\n')) {
    const global = /\b([a-zA-Z_][a-zA-Z0-9_]*)\??:/g
    let match: RegExpExecArray | null
    while ((match = global.exec(line)) !== null) fields.add(match[1])
  }
  return [...fields].sort()
}

/** Extract `name: type` signatures of one FLAT interface (one field per line).
 *  Type-sensitive (M2): a `version: string` → `string | null` drift fails.
 *  Union-shaped types must use interfaceFieldNames (member shapes are
 *  single-line here, but the type text is not comparable across formats). */
function interfaceFieldSignatures(source: string, typeName: string): string[] {
  const signatures: string[] = []
  for (const raw of stripComments(interfaceBlock(source, typeName)).split('\n')) {
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\??:\s*(.+)$/.exec(raw.trim())
    if (match === null) continue
    let type = match[2].replace(/[,;]\s*$/, '').replace(/\s+/g, ' ').trim()
    // preload names PluginApplyFailure inline; the client mirrors name it —
    // structurally equivalent, normalize for the text comparison.
    type = type.replace(/\bPluginApplyFailure\[\]/g, '{ spec: string; error: string }[]')
    signatures.push(`${match[1]}:${type}`)
  }
  return signatures.sort()
}

const preload = readFileSync(join(ROOT, 'packages/desktop/preload.cts'), 'utf8')
const renderer = readFileSync(join(ROOT, 'packages/renderer/src/global.d.ts'), 'utf8')
const settings = readFileSync(join(ROOT, 'packages/dsh-chamber-client-ui-settings-connections/src/global.d.ts'), 'utf8')
const rendererApp = readFileSync(join(ROOT, 'packages/renderer/src/App.tsx'), 'utf8')

test('system-resume channel name stays in lockstep across all three sites (H2)', async () => {
  // The desktop side is single-sourced in ipc-events.ts (main.ts imports it);
  // preload.cts is a self-contained single-file build (build-preload.mjs) and
  // cannot import the shared constant — the literal is duplicated on purpose.
  // The renderer App layer re-dispatches the same IPC push as a window event.
  // Pin all three sites to the same string so a rename can never drift
  // silently. The preload assertion is anchored on the ACTUAL subscription
  // call (not a bare includes) so the literal cannot hide in a comment.
  const { SYSTEM_RESUME_EVENT } = await import('./ipc-events.ts')
  assert.ok(
    preload.includes(`ipcRenderer.on('${SYSTEM_RESUME_EVENT}'`),
    'preload.cts no longer subscribes with the same system-resume channel literal as ipc-events.ts',
  )
  assert.ok(
    rendererApp.includes(`new Event('${SYSTEM_RESUME_EVENT}')`),
    'App.tsx no longer re-dispatches the same system-resume window event as ipc-events.ts',
  )
})

test('DesktopSshSurface stays in lockstep across preload / renderer mirrors (L3)', () => {
  const authoritative = interfaceMethodNames(preload, 'DesktopSshSurface')
  assert.deepEqual(interfaceMethodNames(renderer, 'DesktopSshSurface'), authoritative, 'renderer global.d.ts mirror drifted')
})

test('UpdateSurface and SettingsSurface match their GOLDEN baselines (L3 golden guard)', () => {
  assert.deepEqual(interfaceMethodNames(preload, 'UpdateSurface'), ['check', 'download', 'onChanged', 'openReleasePage', 'state'].sort())
  assert.deepEqual(interfaceMethodNames(preload, 'SettingsSurface'), ['get', 'onChanged', 'set'].sort())
})

test('DesktopSshSurface matches the GOLDEN baseline — a method deleted from ALL mirrors still fails (L3 golden guard)', () => {
  // Snapshot of the authoritative surface (regenerate deliberately when a
  // method is genuinely removed; a synchronized three-way deletion otherwise
  // stays green in the pairwise comparison above).
  const golden = [
    'config_list', 'connect', 'disconnect', 'instances_get', 'instances_set',
    'is_active', 'local_plugin_add', 'local_plugin_add_file', 'local_plugin_list',
    'local_plugin_remove', 'logs', 'logs_clear', 'npm_search', 'onInstancesChanged',
    'onStatusChanged', 'plugin_apply', 'plugin_list', 'plugin_materialize_add',
    'plugin_materialize_add_pick', 'restart_service', 'seed_host_graph',
    'set_password', 'start_service', 'status', 'stop_service',
  ].sort()
  assert.deepEqual(interfaceMethodNames(preload, 'DesktopSshSurface'), golden, 'DesktopSshSurface drifted from the golden baseline')
})

test('UpdateSurface and SettingsSurface stay in lockstep across preload and renderer mirrors (L3)', () => {
  for (const surface of ['UpdateSurface', 'SettingsSurface']) {
    assert.deepEqual(
      interfaceMethodNames(renderer, surface),
      interfaceMethodNames(preload, surface),
      `${surface} renderer mirror drifted`,
    )
  }
})

test('the plugin-manifest projections carry identical FIELD SETS across all three mirrors (L3 — shape drift guard)', () => {
  // preload names them Ssh*; the client mirrors drop the prefix.
  const remotePairs: Array<[string, string, string]> = [
    ['SshRemotePluginManifest', 'RemotePluginManifest', 'RemotePluginManifest'],
    ['SshLocalPluginManifest', 'LocalPluginManifest', 'LocalPluginManifest'],
  ]
  for (const [preloadName, rendererName] of remotePairs) {
    const fields = interfaceFieldNames(preload, preloadName)
    assert.ok(fields.includes('chamber'), `${preloadName} must carry the chamber field`)
    assert.deepEqual(interfaceFieldNames(renderer, rendererName), fields, `${rendererName} mirror drifted`)
  }
})

test('the IPC result unions carry identical FIELD SETS across the mirrors that name them (L3 — union shape drift guard)', () => {
  // Named aliases exist on both sides: preload Ssh* vs client mirrors.
  const aliasPairs: Array<[string, string, string]> = [
    ['SshMaterializeResult', 'SshMaterializeResult', 'SshMaterializeResult'],
    ['SshLocalPluginExecIpcResult', 'SshLocalPluginExecIpcResult', 'SshLocalPluginExecIpcResult'],
  ]
  for (const [preloadName, rendererName] of aliasPairs) {
    const fields = interfaceFieldNames(preload, preloadName)
    assert.deepEqual(interfaceFieldNames(renderer, rendererName), fields, `${rendererName} renderer mirror drifted`)
  }
  // SshPluginApplyIpcResult is a NAMED alias in preload only; the client
  // mirrors inline it into the plugin_apply signature. plugin_apply has no
  // picker or other cancellation path; widening it with a cancelled member
  // would hide a producer/consumer contract mistake.
  const applyFields = interfaceFieldNames(preload, 'SshPluginApplyIpcResult')
  assert.deepEqual(applyFields, ['error', 'ok', 'result'], 'plugin_apply result union must remain exact')
})

test('the apply-result and notification-settings shapes are type-identical across mirrors (L3 — type-sensitive drift guard)', () => {
  // PluginApplyResult: preload names it SshPluginApplyResult; clients drop the prefix.
  const applyResult = interfaceFieldSignatures(preload, 'SshPluginApplyResult')
  assert.deepEqual(interfaceFieldSignatures(renderer, 'PluginApplyResult'), applyResult, 'renderer PluginApplyResult drifted')
  // ChamberNotificationSettings (nested under ChamberSettings.notifications).
  const notificationSettings = interfaceFieldSignatures(preload, 'ChamberNotificationSettings')
  assert.deepEqual(interfaceFieldSignatures(renderer, 'ChamberNotificationSettings'), notificationSettings, 'renderer ChamberNotificationSettings drifted')
})

test('flat shared interfaces are TYPE-identical across preload and renderer (L3 — not just field names)', () => {
  for (const name of ['ChamberHostGraphState', 'ChamberSettings']) {
    const authoritative = interfaceFieldSignatures(preload, name)
    assert.deepEqual(interfaceFieldSignatures(renderer, name), authoritative, `${name} renderer type drift`)
  }
  const remoteManifest = interfaceFieldSignatures(preload, 'SshRemotePluginManifest')
  assert.deepEqual(interfaceFieldSignatures(renderer, 'RemotePluginManifest'), remoteManifest, 'RemotePluginManifest renderer type drift')
  const localManifest = interfaceFieldSignatures(preload, 'SshLocalPluginManifest')
  assert.deepEqual(interfaceFieldSignatures(renderer, 'LocalPluginManifest'), localManifest, 'LocalPluginManifest renderer type drift')
})

test('settings-connections re-exports the whole IPC face from the renderer (single source of truth, L3)', () => {
  // T1 (2026 review): the settings plugin no longer structurally mirrors the
  // IPC types — it re-exports them from the renderer's authoritative
  // global.d.ts. Assert the re-export statement covers the critical names.
  const start = settings.indexOf('export type {')
  assert.ok(start !== -1, 'settings-connections must re-export the IPC face')
  const exportBlock = settings.slice(start, settings.indexOf("} from '../../renderer/src/global.d.ts'", start))
  for (const name of ['DesktopSshSurface', 'SshInstanceSpec', 'SshStatusProjection', 'ChamberSettings', 'PluginApplyResult']) {
    assert.ok(exportBlock.includes(name), `settings-connections must re-export ${name}`)
  }
})

test('ChamberInjectionState / ChamberHostGraphState / ChamberSettings stay in lockstep (L3 — shape drift guard)', () => {
  // ChamberInjectionState union: ok/hostGraph/gitWorktree/error must match.
  assert.deepEqual(interfaceFieldNames(preload, 'ChamberInjectionState'), interfaceFieldNames(renderer, 'ChamberInjectionState'), 'ChamberInjectionState preload/renderer drifted')
  assert.deepEqual(interfaceFieldNames(preload, 'ChamberHostGraphState'), interfaceFieldNames(renderer, 'ChamberHostGraphState'), 'ChamberHostGraphState preload/renderer drifted')
  assert.deepEqual(interfaceFieldNames(renderer, 'ChamberSettings'), interfaceFieldNames(preload, 'ChamberSettings'), 'ChamberSettings preload/renderer drifted')
})

// ---------------------------------------------------------------------------
// B8: channel-name lockstep (string-level guard). The main side registers
// every channel through the IPC_CHANNELS constants in ipc-events.ts (single
// source of truth); the preload CANNOT import that module (build-preload.mjs
// self-contained single-file contract), so its literals are duplicated on
// purpose. These tests assert the two sides can never drift:
//   main-side  ipcMain.handle  set  ==  preload-side ipcRenderer.invoke set
//   main-side  webContents.send set ==  preload-side ipcRenderer.on    set
// and that every preload literal is a known IPC_CHANNELS value (so a rename
// in the constants fails loudly on the preload side too).
// ---------------------------------------------------------------------------

const { IPC_CHANNELS } = await import('./ipc-events.ts')

/** The main-process files that register IPC channels (main.ts assembly +
 *  the wiring modules). */
const MAIN_SIDE_FILES = [
  'main.ts',
  'ipc-settings.ts',
  'ipc-notifications.ts',
  'ipc-ssh.ts',
  'ipc-plugin-sync.ts',
  'ipc-open-in.ts',
  'ipc-update.ts',
  'ipc-deep-link.ts',
]

function mainSideSource(): string {
  return MAIN_SIDE_FILES
    .map(file => readFileSync(join(ROOT, 'packages/desktop', file), 'utf8'))
    .join('\n')
}

/** Collect the channel names of one main-side registration/send call: the
 *  argument is either an IPC_CHANNELS constant reference (resolved against
 *  the imported constants) or a raw quoted literal (a regression the guard
 *  must also surface — the constant set is the source of truth). */
function collectMainChannels(source: string, call: 'ipcMain.handle' | 'webContents.send'): string[] {
  const channels = new Set<string>()
  const pattern = new RegExp(`${call}\\(\\s*(?:IPC_CHANNELS\\.([A-Z][A-Z0-9_]*)|'([^']*)'|"([^"]*)")`, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    if (match[1] !== undefined) {
      const key = match[1] as keyof typeof IPC_CHANNELS
      assert.ok(key in IPC_CHANNELS, `main-side code references an unknown IPC_CHANNELS member: ${match[1]}`)
      channels.add(IPC_CHANNELS[key])
    } else {
      // A raw literal on the main side: still pinned by the equality checks
      // below, but the constants are the source of truth — loud here too.
      channels.add(match[2] !== undefined ? match[2] : match[3])
    }
  }
  return [...channels].sort()
}

/** Collect the preload-side channel literals of one ipcRenderer call. */
function collectPreloadChannels(source: string, call: 'invoke' | 'on'): string[] {
  const channels = new Set<string>()
  const pattern = new RegExp(`ipcRenderer\\.${call}\\(\\s*'([^']*)'`, 'g')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) channels.add(match[1])
  return [...channels].sort()
}

const mainHandleChannels = collectMainChannels(mainSideSource(), 'ipcMain.handle')
const mainSendChannels = collectMainChannels(mainSideSource(), 'webContents.send')
const preloadInvokeChannels = collectPreloadChannels(preload, 'invoke')
const preloadOnChannels = collectPreloadChannels(preload, 'on')

test('every ipcMain.handle channel is an IPC_CHANNELS constant (B8 — no raw main-side literals)', () => {
  const mainSource = mainSideSource()
  const rawLiteral = /ipcMain\.handle\(\s*'([^']*)'|ipcMain\.handle\(\s*"([^"]*)"/.exec(mainSource)
  assert.equal(rawLiteral, null, `main-side ipcMain.handle must use IPC_CHANNELS constants, found raw literal: ${rawLiteral?.[1] ?? rawLiteral?.[2]}`)
})

test('the main-side handle channel set EQUALS the preload invoke channel set (B8)', () => {
  assert.deepEqual(mainHandleChannels, preloadInvokeChannels, 'ipcMain.handle channels drifted from the preload invoke channels')
})

test('the main-side send channel set EQUALS the preload on channel set (B8 — pushes can never drift)', () => {
  assert.deepEqual(mainSendChannels, preloadOnChannels, 'webContents.send channels drifted from the preload on channels')
})

test('every preload channel literal is a known IPC_CHANNELS value (B8 — constants are the single source)', () => {
  const known = new Set<string>(Object.values(IPC_CHANNELS))
  for (const channel of [...preloadInvokeChannels, ...preloadOnChannels]) {
    assert.ok(known.has(channel), `preload references a channel that is not in IPC_CHANNELS: ${channel}`)
  }
})
