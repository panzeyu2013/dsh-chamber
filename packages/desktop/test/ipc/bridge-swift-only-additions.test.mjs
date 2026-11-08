/**
 * bridge-swift-only-additions.test.mjs — Swift-only A 桥白名单的最小解析/合并单测。
 *
 * 政策与 schema：docs/progress/electron-frozen.md §5.2；生成器
 * scripts/emit-bridge-manifest.mjs。这里锁「白名单解析 + 校验 + 合入 manifest +
 * 空表三产物逐字节不变」+ 白名单与 dshDesktop 域不相交 + verify-shim-payload-shape
 * 的白名单豁免（正例/负例/空表不变）——通道面本身仍由 bridge-manifest.test.ts /
 * bridge-shim-surface.test.ts / ipc-surface-mirror.test.ts 锁。
 *
 * 形态取舍：本文件是 .mjs（不是 .ts），因此可以直接 import 生成器的纯函数——
 * bridge-manifest.test.ts 属根 typecheck 程序，无声明文件的 .mjs import 会 TS7016，
 * 所以那边只能 spawn CLI；白名单解析单测放在 .mjs 才能覆盖纯函数错误分支。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMMITTED_MANIFEST,
  COMMITTED_SHIM_STUB,
  COMMITTED_SHORTCUTS_BRIDGE,
  COMMITTED_SWIFT,
  COMMITTED_SWIFT_ONLY,
  MAIN_SIDE_FILES,
  assertSwiftOnlyDshDesktopDisjoint,
  computeManifest,
  loadDshDesktopCarrierDomains,
  loadSwiftOnlyAdditions,
  parseDshDesktopCarrierDomains,
  parseIpcChannels,
  renderJsonManifest,
  renderShimStub,
  renderSwiftManifest,
  validateSwiftOnlyAdditions,
} from '../../scripts/emit-bridge-manifest.mjs'
import { comparePayloadShapes, compareRuntimePayloads } from '../../../../scripts/gates/verify-shim-payload-shape.mjs'

const IPC_SOURCE = `const IPC_CHANNELS = {
  ALPHA: 'dsh-chamber:alpha',
  BETA: 'dsh-chamber:beta',
}
`
const IPC_ENTRIES = [
  { key: 'ALPHA', channel: 'dsh-chamber:alpha' },
  { key: 'BETA', channel: 'dsh-chamber:beta' },
]
const ALPHA_ONLY = [{ file: 'electron/main.ts', text: 'deps.ipc.handle(IPC_CHANNELS.ALPHA, async () => {})' }]
const BETA_REGISTERED = [{
  file: 'electron/main.ts',
  text: 'deps.ipc.handle(IPC_CHANNELS.ALPHA, async () => {})\ndeps.ipc.handle(IPC_CHANNELS.BETA, async () => {})',
}]
const BETA_WHITELIST = [{
  channel: 'dsh-chamber:beta',
  key: 'BETA',
  direction: 'invoke',
  namespace: 'desktopSsh',
  method: 'betaOnly',
  reason: '只存在于 Swift shim 的测试通道',
}]

/** 合成 main 侧文件集：computeManifest 要求 MAIN_SIDE_FILES 全覆盖。 */
function mainSideFiles(codeByFile) {
  return MAIN_SIDE_FILES.map((file) => ({ file, text: codeByFile[file] ?? '' }))
}

// ---------------------------------------------------------------------------
// verify-shim-payload-shape 白名单豁免的正例/负例 fixture（真实源 + 最小注入）
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL('../../../../', import.meta.url)
const REAL_PRELOAD = readFileSync(new URL('packages/desktop/electron/preload.cts', REPO_ROOT), 'utf8')
const REAL_SHIM = readFileSync(new URL('macos/Sources/DSHChamber/Resources/bridge-shim.js', REPO_ROOT), 'utf8')
const REAL_MANIFEST = JSON.parse(readFileSync(new URL('packages/desktop/bridge-manifest.json', REPO_ROOT), 'utf8'))

/** 一条只存在于 shim 的演练通道（不提交，仅用于证明豁免链路真能放行）。 */
const SWIFT_ONLY_PROBE = {
  channel: 'dsh-chamber:swift-only-probe',
  key: 'SWIFT_ONLY_PROBE',
  direction: 'invoke',
  namespace: 'badge',
  method: 'swiftProbe',
  reason: '负例/正例探针：只存在于 shim 的演练通道',
}

/** 在真实 shim 的 badge 命名空间里注入一个 shim-only 成员。 */
function shimWithProbe() {
  const marker = '  var badge = {\n'
  assert.ok(REAL_SHIM.includes(marker), 'bridge-shim.js 的 badge 块形状变了（fixture 需同步）')
  return REAL_SHIM.replace(marker, marker + "    swiftProbe: function () { return invoke('dsh-chamber:swift-only-probe', null) },\n")
}

/** 在真实 shim 里注入一个全新的 Swift-only 命名空间。 */
function shimWithNewNamespace() {
  const marker = '  /** forward'
  assert.ok(REAL_SHIM.includes(marker), 'bridge-shim.js 的 forward 注记变了（fixture 需同步）')
  return REAL_SHIM.replace(marker, "  var swiftOnlyNs = {\n    probe: function () { return invoke('dsh-chamber:swift-only-probe', null) }\n  }\n\n" + marker)
}

/** 真实提交 manifest 的副本 + 一条白名单通道（invoke）。 */
function manifestWithProbe() {
  const copy = structuredClone(REAL_MANIFEST)
  copy.invoke.push({ channel: SWIFT_ONLY_PROBE.channel, key: SWIFT_ONLY_PROBE.key })
  copy.counts.invoke += 1
  copy.counts.total += 1
  return copy
}

test('the committed whitelist is the canonical empty table (version 1, entries [])', () => {
  const entries = loadSwiftOnlyAdditions()
  assert.deepEqual(entries, [])
  const raw = JSON.parse(readFileSync(COMMITTED_SWIFT_ONLY, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(typeof raw.policy, 'string')
  assert.ok(raw.policy.length > 0)
})

test('loadSwiftOnlyAdditions fails loudly on a missing file, bad JSON or a wrong shape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swift-only-'))
  try {
    assert.throws(() => loadSwiftOnlyAdditions(join(dir, 'missing.json')), /不可读或不是合法 JSON/)
    const badJson = join(dir, 'bad.json')
    writeFileSync(badJson, '{ not json')
    assert.throws(() => loadSwiftOnlyAdditions(badJson), /不可读或不是合法 JSON/)
    for (const body of [
      '[]',
      '{}',
      '{"version":2,"entries":[]}',
      '{"version":1,"entries":{}}',
    ]) {
      const path = join(dir, 'shape.json')
      writeFileSync(path, body)
      assert.throws(() => loadSwiftOnlyAdditions(path), /version: 1, entries/, body)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('validateSwiftOnlyAdditions accepts a schema-valid entry and rejects every malformed arm', () => {
  const ipcEntries = parseIpcChannels(IPC_SOURCE)
  assert.deepEqual(ipcEntries, IPC_ENTRIES)
  assert.deepEqual(validateSwiftOnlyAdditions(BETA_WHITELIST, ipcEntries), BETA_WHITELIST)
  for (const [label, mutate] of [
    ['missing direction', (entry) => { delete entry.direction }],
    ['bad direction', (entry) => { entry.direction = 'send' }],
    ['unknown key', (entry) => { entry.key = 'GAMMA'; entry.channel = 'dsh-chamber:gamma' }],
    ['channel/key mismatch', (entry) => { entry.channel = 'dsh-chamber:alpha' }],
    ['empty reason', (entry) => { entry.reason = '   ' }],
    ['bad key shape', (entry) => { entry.key = 'beta' }],
  ]) {
    const entry = { ...BETA_WHITELIST[0] }
    mutate(entry)
    assert.throws(() => validateSwiftOnlyAdditions([entry], ipcEntries), /Swift-only 白名单/, label)
  }
  assert.throws(
    () => validateSwiftOnlyAdditions([BETA_WHITELIST[0], { ...BETA_WHITELIST[0] }], ipcEntries),
    /重复登记/,
  )
})

test('a whitelisted key is exempt from the dead-key arm but must have zero main-side registration', () => {
  // 未登记白名单：BETA 在 main 侧零引用 = 死键，生成器必须 loud（旧行为）。
  assert.throws(
    () => computeManifest(IPC_SOURCE, mainSideFiles({ 'electron/main.ts': ALPHA_ONLY[0].text }), []),
    /死键.*BETA/,
  )
  // 登记白名单后：BETA 方向取自白名单，两键都进 manifest（按 IPC_CHANNELS 定义序）。
  const manifest = computeManifest(
    IPC_SOURCE,
    mainSideFiles({ 'electron/main.ts': ALPHA_ONLY[0].text }),
    BETA_WHITELIST,
  )
  assert.deepEqual(manifest.invoke.map((entry) => entry.key), ['ALPHA', 'BETA'])
  assert.deepEqual(manifest.push, [])
  assert.deepEqual(manifest.counts, { invoke: 2, push: 0, total: 2 })
  // 两侧都注册的通道不得进白名单：main 侧出现该键的注册调用即 loud。
  assert.throws(
    () => computeManifest(IPC_SOURCE, mainSideFiles({ 'electron/main.ts': BETA_REGISTERED[0].text }), BETA_WHITELIST),
    /白名单键同时被 main 侧注册/,
  )
})


// ---------------------------------------------------------------------------
// ② 白名单 × dshDesktop 通道域：不相交护栏（生成器侧纯函数 + 单源解析）
// ---------------------------------------------------------------------------

test('the committed whitelist is disjoint from the dshDesktop carrier channel domain (no-op while empty)', () => {
  // 单源 = shortcuts-bridge.ts 的 DESKTOP_SHORTCUTS_CHANNELS（测试进程直接读提交物文本）。
  const domains = loadDshDesktopCarrierDomains(COMMITTED_SHORTCUTS_BRIDGE)
  assert.ok(domains.channels.includes('dsh-desktop:shortcuts-input'), 'dshDesktop 通道表单源应可解析')
  assert.ok(domains.keys.includes('INPUT'))
  assert.deepEqual(domains.namespaces, ['dshDesktop'])
  // 空表恒 no-op（且不读 shortcuts-bridge.ts）。
  assert.deepEqual(assertSwiftOnlyDshDesktopDisjoint([], domains), [])
  const ipcEntries = parseIpcChannels(IPC_SOURCE)
  assert.deepEqual(validateSwiftOnlyAdditions([], ipcEntries, domains), [])
  // 域外条目通过。
  assert.deepEqual(validateSwiftOnlyAdditions(BETA_WHITELIST, ipcEntries, domains), BETA_WHITELIST)
})

test('a whitelist entry falling into the dshDesktop domain is rejected loudly (channel/key/namespace)', () => {
  const domains = loadDshDesktopCarrierDomains(COMMITTED_SHORTCUTS_BRIDGE)
  // channel 碰撞：IPC_CHANNELS 某键的值恰好是 dshDesktop 通道（白名单会把 A 桥通道写进该域）。
  const collisionIpc = parseIpcChannels(`const IPC_CHANNELS = {
  ALPHA: 'dsh-chamber:alpha',
  INPUT: 'dsh-desktop:shortcuts-input',
}`)
  assert.throws(
    () => validateSwiftOnlyAdditions(
      [{ ...BETA_WHITELIST[0], key: 'INPUT', channel: 'dsh-desktop:shortcuts-input' }],
      collisionIpc,
      domains,
    ),
    /dshDesktop 通道域/,
  )
  // key 碰撞：A 桥常量名与 dshDesktop 通道常量同名。
  const keyCollisionIpc = parseIpcChannels(`const IPC_CHANNELS = {
  ALPHA: 'dsh-chamber:alpha',
  INPUT: 'dsh-chamber:beta',
}`)
  assert.throws(
    () => validateSwiftOnlyAdditions(
      [{ ...BETA_WHITELIST[0], key: 'INPUT', channel: 'dsh-chamber:beta' }],
      keyCollisionIpc,
      domains,
    ),
    /dshDesktop 通道常量同名/,
  )
  // namespace 碰撞：白名单命名空间占用 dshDesktop 域。
  assert.throws(
    () => validateSwiftOnlyAdditions(
      [{ ...BETA_WHITELIST[0], namespace: 'dshDesktop' }],
      parseIpcChannels(IPC_SOURCE),
      domains,
    ),
    /与 dshDesktop 域同名/,
  )
})

test('parseDshDesktopCarrierDomains fails closed on a missing/empty channel table', () => {
  const real = readFileSync(COMMITTED_SHORTCUTS_BRIDGE, 'utf8')
  const domains = parseDshDesktopCarrierDomains(real)
  assert.equal(domains.channels.length, 6, 'DESKTOP_SHORTCUTS_CHANNELS 当前 6 条通道')
  assert.throws(() => parseDshDesktopCarrierDomains('export const OTHER = {}'), /DESKTOP_SHORTCUTS_CHANNELS/)
  assert.throws(
    () => parseDshDesktopCarrierDomains('export const DESKTOP_SHORTCUTS_CHANNELS = {\n} as const'),
    /0 条通道/,
  )
})

test('parseDshDesktopCarrierDomains accepts double-quoted rows but rejects a partially parsed table', () => {
  const doubleQuoted = 'export const DESKTOP_SHORTCUTS_CHANNELS = {\n  A: "dsh-desktop:a",\n  B: "dsh-desktop:b",\n} as const'
  assert.deepEqual(parseDshDesktopCarrierDomains(doubleQuoted).channels, ['dsh-desktop:a', 'dsh-desktop:b'])
  assert.throws(
    () => parseDshDesktopCarrierDomains('export const DESKTOP_SHORTCUTS_CHANNELS = {\n  A: "dsh-desktop:a",\n  B: dsh-desktop:b,\n} as const'),
    /解析不完整/,
  )
})

// ---------------------------------------------------------------------------
// ③ verify-shim-payload-shape：白名单豁免（空表逐字不变 / 正例放行 / 负例仍红）
// ---------------------------------------------------------------------------

test('the shape gate keeps the empty table byte-identical (65 pairs, same counts)', () => {
  const verdict = comparePayloadShapes({ preloadText: REAL_PRELOAD, shimText: REAL_SHIM, manifest: REAL_MANIFEST })
  assert.deepEqual(verdict.mismatches, [])
  assert.deepEqual(verdict.missingFromManifest, [])
  assert.deepEqual(verdict.unexposedManifestChannels, [])
  assert.equal(verdict.checked, 65, '空表：与加豁免前相同的 65 个双侧成员')
  assert.equal(verdict.namespaces, 11)
})

test('the shape gate exempts a whitelisted shim-only member but still fails without it', () => {
  const manifest = manifestWithProbe()
  const shim = shimWithProbe()
  const exempted = comparePayloadShapes({
    preloadText: REAL_PRELOAD, shimText: shim, manifest, swiftOnly: [SWIFT_ONLY_PROBE],
  })
  assert.deepEqual(exempted.mismatches, [])
  assert.deepEqual(exempted.unexposedManifestChannels, [], '白名单通道计入已暴露集')
  assert.equal(exempted.checked, 65, '白名单成员不进双侧计数')
  // 同一源不给白名单 = 旧的严格行为，必须红（豁免不是普遍放宽）。
  const strict = comparePayloadShapes({ preloadText: REAL_PRELOAD, shimText: shim, manifest })
  assert.ok(strict.mismatches.some((m) => m.includes('method set differs')), JSON.stringify(strict.mismatches))
  // 全新 Swift-only 命名空间同样可放行（shim 真实现 + manifest 已收录）。
  const newNamespace = comparePayloadShapes({
    preloadText: REAL_PRELOAD,
    shimText: shimWithNewNamespace(),
    manifest,
    swiftOnly: [{ ...SWIFT_ONLY_PROBE, namespace: 'swiftOnlyNs', method: 'probe' }],
  })
  assert.deepEqual(newNamespace.mismatches, [])
  assert.deepEqual(newNamespace.unexposedManifestChannels, [])
})

test('the shape gate fails closed when the whitelist claim is not true on the shim/manifest side', () => {
  const cases = [
    ['missing shim method', [{ ...SWIFT_ONLY_PROBE, method: 'nope' }], manifestWithProbe(), REAL_SHIM, /missing from the shim/],
    ['channel not in manifest', [SWIFT_ONLY_PROBE], REAL_MANIFEST, shimWithProbe(), /not in bridge-manifest\.json/],
    ['preload already exposes it', [{ ...SWIFT_ONLY_PROBE, method: 'set', channel: 'dsh-chamber:badge-count' }], REAL_MANIFEST, shimWithProbe(), /preload must not expose/],
    ['direction mismatch', [{ ...SWIFT_ONLY_PROBE, direction: 'push' }], manifestWithProbe(), shimWithProbe(), /call kind/],
    ['new namespace missing from shim', [{ ...SWIFT_ONLY_PROBE, namespace: 'ghostNs', method: 'probe' }], manifestWithProbe(), REAL_SHIM, /namespace is missing from the shim/],
  ]
  for (const [label, swiftOnly, manifest, shimText, pattern] of cases) {
    const verdict = comparePayloadShapes({ preloadText: REAL_PRELOAD, shimText, manifest, swiftOnly })
    assert.ok(verdict.mismatches.some((m) => pattern.test(m)), label + ': ' + JSON.stringify(verdict.mismatches))
  }
})

test('the runtime arm skips whitelisted shim-only members without shifting the pins', async () => {
  const runtime = await compareRuntimePayloads({
    preloadText: REAL_PRELOAD, shimText: shimWithProbe(), swiftOnly: [SWIFT_ONLY_PROBE],
  })
  assert.deepEqual(runtime.mismatches, [])
  assert.equal(runtime.checked, 65)
  assert.equal(runtime.invoked, 56)
  assert.equal(runtime.subscribed, 9)
  assert.equal(runtime.namespaces, 11)
  assert.equal(runtime.perNamespace.badge, 1, '白名单成员不计入命名空间行数钉子')
  // 不给白名单 = 旧的严格行为，必须红。
  const strict = await compareRuntimePayloads({ preloadText: REAL_PRELOAD, shimText: shimWithProbe() })
  assert.ok(strict.mismatches.some((m) => m.includes('no preload.cts call site')), JSON.stringify(strict.mismatches))
})

test('the empty table reproduces the three committed artifacts byte-for-byte', () => {
  const manifest = computeManifest()
  assert.equal(renderJsonManifest(manifest), readFileSync(COMMITTED_MANIFEST, 'utf8'), '空表 JSON 必须逐字节不变')
  assert.equal(renderSwiftManifest(manifest), readFileSync(COMMITTED_SWIFT, 'utf8'), '空表 Swift 必须逐字节不变')
  assert.equal(renderShimStub(manifest), readFileSync(COMMITTED_SHIM_STUB, 'utf8'), '空表 shim stub 必须逐字节不变')
})
