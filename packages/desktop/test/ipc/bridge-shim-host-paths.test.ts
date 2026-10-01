/**
 * bridge-shim host-path carrier（上游 apps/desktop/src/preload-app.ts 的
 * __DSH_HOST_PATHS__）的 Swift 腿行为锁：painted-source 门控、UA 事件批次、
 * 目录按名 / 文件按精确字节数的同步配对、双方各消费一次、TTL、旧代忽略与载荷失败闭合。
 *
 * 与 desktop-carrier-surface/bridge-shim-document 同一 vm 隔离法：不 import shim
 * 模块，直接在 stub 上下文里求值源码。stub 有意各自持有（两处 DOM 面差异大）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const shim = readFileSync(
  fileURLToPath(new URL('../../../../macos/Sources/DSHChamber/Resources/bridge-shim.js', import.meta.url)),
  'utf8',
)
const TOKEN = '__DSH_CHAMBER_NATIVE_TOKEN__'

interface BatchFile { name: string; size: number }

function page({ scope = 'local', now = 1000 }: { scope?: string; now?: number } = {}) {
  const clock = { value: now }
  const attributes = new Map<string, string>([['data-chamber-painted-source', scope]])
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const captures = new Map<string, unknown>()
  const on = (type: string, listener: (event: unknown) => void, options?: unknown): void => {
    let set = listeners.get(type)
    if (set === undefined) { set = new Set(); listeners.set(type, set) }
    set.add(listener)
    captures.set(type, options)
  }
  const off = (type: string, listener: (event: unknown) => void): void => { listeners.get(type)?.delete(listener) }
  const window: Record<string, unknown> = {
    crypto: { randomUUID: () => 'uuid' },
    webkit: { messageHandlers: { dshChamber: { postMessage: () => {} } } },
    dispatchEvent: () => true,
    addEventListener: on,
    removeEventListener: off,
  }
  const documentElement = {
    dataset: {} as Record<string, string>,
    getAttribute: (name: string): string | null => attributes.get(name) ?? null,
  }
  const document = { documentElement, addEventListener: on, removeEventListener: off }
  runInNewContext(shim, {
    window,
    document,
    navigator: { platform: 'MacIntel' },
    Event: class { readonly type: string; constructor(type: string) { this.type = type } },
    console,
    setTimeout,
    Date: { now: () => clock.value },
  })
  const emit = (type: string, event: unknown): void => {
    for (const listener of listeners.get(type) ?? []) listener(event)
  }
  const hostPaths = window.__DSH_HOST_PATHS__ as { pathFor(file: unknown): string }
  const push = window.__dshChamberHostPaths as (token: string, payload: unknown) => void
  return { window, hostPaths, push, emit, clock, attributes, captures }
}

function file(name: string, size: number): BatchFile { return { name, size } }

function entry(name: string, path: string, size: number, isDirectory = false) {
  return { name, path, size, isDirectory }
}

function drop(...files: BatchFile[]): { dataTransfer: { files: BatchFile[] }; isTrusted: boolean } {
  return { dataTransfer: { files }, isTrusted: true }
}

function change(files: BatchFile[], isTrusted = true) {
  return { target: { type: 'file', files }, isTrusted }
}

test('the carrier is installed at documentStart as a frozen global', () => {
  const pageUnderTest = page()
  assert.equal(typeof pageUnderTest.hostPaths.pathFor, 'function')
  const carrier = Object.getOwnPropertyDescriptor(pageUnderTest.window, '__DSH_HOST_PATHS__')
  assert.equal(carrier?.configurable, false)
  assert.equal(carrier?.writable, false, 'the page must not be able to re-cover pathFor')
  assert.equal(Object.getOwnPropertyDescriptor(pageUnderTest.window, '__dshChamberHostPaths')?.configurable, false)
})

test('the batch listeners run in the capture phase, before the page own document listeners', () => {
  const pageUnderTest = page()
  assert.equal(pageUnderTest.captures.get('drop'), true, 'the window drop listener must be capture')
  assert.equal(pageUnderTest.captures.get('change'), true, 'the document change listener must be capture')
})

test('a non-local painted source never yields a path', () => {
  const pageUnderTest = page({ scope: 'gateway-alpha' })
  pageUnderTest.push(TOKEN, { generation: 1, entries: [entry('a.txt', '/host/a.txt', 3)] })
  pageUnderTest.emit('drop', drop(file('a.txt', 3)))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('a.txt', 3)), '')
})

test('scope flipping to local starts serving the next drop', () => {
  const pageUnderTest = page({ scope: 'gateway-alpha' })
  pageUnderTest.push(TOKEN, { generation: 1, entries: [entry('a.txt', '/host/a.txt', 3)] })
  pageUnderTest.emit('drop', drop(file('a.txt', 3)))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('a.txt', 3)), '')
  pageUnderTest.attributes.set('data-chamber-painted-source', 'local')
  pageUnderTest.emit('drop', drop(file('a.txt', 3)))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('a.txt', 3)), '/host/a.txt')
})

test('a user-delivered File in the batch pairs with the catalog and is consumed once', () => {
  const pageUnderTest = page()
  pageUnderTest.push(TOKEN, {
    generation: 1,
    entries: [entry('a.txt', '/host/a.txt', 3), entry('b.txt', '/host/b.txt', 4)],
  })
  pageUnderTest.emit('drop', drop(file('a.txt', 3), file('b.txt', 4)))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('a.txt', 3)), '/host/a.txt')
  assert.equal(pageUnderTest.hostPaths.pathFor(file('b.txt', 4)), '/host/b.txt')
  // 双方各消费一次：重复询问拿不到路径（intake containment 之外的纵深防御）。
  assert.equal(pageUnderTest.hostPaths.pathFor(file('a.txt', 3)), '')
})

test('a File never delivered by a trusted event cannot borrow a catalog entry', () => {
  const pageUnderTest = page()
  pageUnderTest.push(TOKEN, { generation: 1, entries: [entry('secret.txt', '/host/secret.txt', 3)] })
  assert.equal(pageUnderTest.hostPaths.pathFor(file('secret.txt', 3)), '', 'no batch = no path')
  pageUnderTest.emit('drop', drop(file('other.txt', 1)))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('secret.txt', 3)), '', 'batch mismatch = no path')
})

test('synthetic (untrusted) drop or change events cannot arm the batch', () => {
  const pageUnderTest = page()
  pageUnderTest.push(TOKEN, { generation: 1, entries: [entry('a.txt', '/host/a.txt', 3)] })
  pageUnderTest.emit('drop', { dataTransfer: { files: [file('a.txt', 3)] }, isTrusted: false })
  assert.equal(pageUnderTest.hostPaths.pathFor(file('a.txt', 3)), '', 'a synthetic drop is ignored')
  pageUnderTest.emit('change', change([file('a.txt', 3)], false))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('a.txt', 3)), '', 'a synthetic change is ignored')
  pageUnderTest.emit('drop', drop(file('a.txt', 3)))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('a.txt', 3)), '/host/a.txt', 'the trust-rejected batch was not latched')
})

test('same-name Files pair in order and file entries require the exact size', () => {
  const pageUnderTest = page()
  pageUnderTest.push(TOKEN, {
    generation: 1,
    entries: [entry('r.md', '/one/r.md', 5), entry('r.md', '/two/r.md', 9)],
  })
  pageUnderTest.emit('drop', drop(file('r.md', 9), file('r.md', 5)))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('r.md', 9)), '/two/r.md', 'size picks the entry')
  assert.equal(pageUnderTest.hostPaths.pathFor(file('r.md', 5)), '/one/r.md')
  assert.equal(pageUnderTest.hostPaths.pathFor(file('r.md', 7)), '', 'no entry of that size')
})

test('a directory drop (File.size 0) matches by name, a size-0 File cannot impersonate a real file', () => {
  const directory = page()
  directory.push(TOKEN, { generation: 1, entries: [entry('docs', '/host/docs', -1, true)] })
  directory.emit('drop', drop(file('docs', 0)))
  assert.equal(directory.hostPaths.pathFor(file('docs', 0)), '/host/docs')

  const realFile = page()
  realFile.push(TOKEN, { generation: 1, entries: [entry('x.txt', '/host/x.txt', 3)] })
  realFile.emit('drop', drop(file('x.txt', 0)))
  assert.equal(realFile.hostPaths.pathFor(file('x.txt', 0)), '', 'a size-0 File must not match a 3-byte entry')
})

test('a stale catalog generation is ignored', () => {
  const pageUnderTest = page()
  pageUnderTest.push(TOKEN, { generation: 2, entries: [entry('new.txt', '/host/new.txt', 4)] })
  pageUnderTest.push(TOKEN, { generation: 1, entries: [entry('old.txt', '/host/old.txt', 5)] })
  pageUnderTest.emit('drop', drop(file('old.txt', 5), file('new.txt', 4)))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('old.txt', 5)), '', 'the stale generation never replaced the catalog')
  assert.equal(pageUnderTest.hostPaths.pathFor(file('new.txt', 4)), '/host/new.txt')
})

test('the catalog and batch are capped at HOST_PATH_MAX_ENTRIES', () => {
  const pageUnderTest = page()
  const entries = Array.from({ length: 257 }, (_value, index) => entry('f' + index + '.txt', '/host/f' + index + '.txt', 1))
  pageUnderTest.push(TOKEN, { generation: 1, entries })
  const files = Array.from({ length: 257 }, (_value, index) => file('f' + index + '.txt', 1))
  pageUnderTest.emit('drop', drop(...files))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('f255.txt', 1)), '/host/f255.txt', 'entry 256 is served')
  assert.equal(pageUnderTest.hostPaths.pathFor(file('f256.txt', 1)), '', 'entry 257 was dropped by the cap')
})

test('the gesture window fails closed while a long hover keeps the drag snapshot', () => {
  const pageUnderTest = page()
  pageUnderTest.push(TOKEN, { generation: 1, entries: [entry('a.txt', '/host/a.txt', 3)] })
  pageUnderTest.emit('drop', drop(file('a.txt', 3)))
  pageUnderTest.clock.value += 5001
  assert.equal(pageUnderTest.hostPaths.pathFor(file('a.txt', 3)), '', 'stale gesture window')

  // 慢速悬停（远超 5s，乃至分钟级）后落下：批次在 drop 当刻装填，目录快照不设 TTL。
  pageUnderTest.clock.value += 300000
  pageUnderTest.emit('drop', drop(file('a.txt', 3)))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('a.txt', 3)), '/host/a.txt', 'a long hover still resolves')
})

test('a directory resolves by name even when the DOM File carries a non-zero size', () => {
  // 实机口径未证（残余④邻域：目录 size 形态）：若 WebKit 给目录非 0 的 size，仍按名命中未消费的目录条目，
  // 避免整个 batch 因目录失配而作废。
  const pageUnderTest = page()
  pageUnderTest.push(TOKEN, { generation: 1, entries: [entry('docs', '/host/docs', -1, true)] })
  pageUnderTest.emit('drop', drop(file('docs', 4096)))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('docs', 4096)), '/host/docs')

  // 回退不得抢走文件配对：同名文件条目可用时，非匹配 size 仍失败闭合。
  const mixed = page()
  mixed.push(TOKEN, { generation: 1, entries: [entry('x', '/host/x', 3), entry('x', '/host/x-dir', -1, true)] })
  mixed.emit('drop', drop(file('x', 3), file('x', 99)))
  assert.equal(mixed.hostPaths.pathFor(file('x', 3)), '/host/x', 'the exact-size file entry wins')
  assert.equal(mixed.hostPaths.pathFor(file('x', 99)), '', 'the fallback does not steal the file entry')
})

test('cross-class or duplicate ambiguity fails closed instead of guessing', () => {
  // 没有 entry API 就无法在 shim 里区分「目录」与「同名空文件」；候选不唯一时回退上传，
  // 绝不按 DOM 顺序分配路径（残余④）。
  const both = page()
  both.push(TOKEN, { generation: 1, entries: [entry('docs', '/host/DIR/docs', -1, true), entry('docs', '/host/FILE/docs', 0)] })
  both.emit('drop', drop(file('docs', 0)))
  assert.equal(both.hostPaths.pathFor(file('docs', 0)), '', 'a directory and an empty file with the same name are ambiguous')

  const duplicateFiles = page()
  duplicateFiles.push(TOKEN, { generation: 1, entries: [entry('x', '/one/x', 3), entry('x', '/two/x', 3)] })
  duplicateFiles.emit('drop', drop(file('x', 3)))
  assert.equal(duplicateFiles.hostPaths.pathFor(file('x', 3)), '', 'two same-name same-size files are ambiguous')

  const onlyFile = page()
  onlyFile.push(TOKEN, { generation: 1, entries: [entry('docs', '/host/FILE/docs', 0)] })
  onlyFile.emit('drop', drop(file('docs', 0)))
  assert.equal(onlyFile.hostPaths.pathFor(file('docs', 0)), '/host/FILE/docs')
})

test('the paperclip change event records the batch too', () => {
  const pageUnderTest = page()
  pageUnderTest.push(TOKEN, { generation: 1, entries: [entry('picked.bin', '/host/picked.bin', 5)] })
  pageUnderTest.emit('change', change([file('picked.bin', 5)]))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('picked.bin', 5)), '/host/picked.bin')
})

test('a malformed catalog or a wrong token throws without replacing the catalog', () => {
  const pageUnderTest = page()
  pageUnderTest.push(TOKEN, { generation: 1, entries: [entry('a.txt', '/host/a.txt', 3)] })
  assert.throws(() => pageUnderTest.push('wrong-token', { generation: 2, entries: [] }), /token mismatch/)
  assert.throws(() => pageUnderTest.push(TOKEN, null), /malformed host-path catalog/)
  assert.throws(() => pageUnderTest.push(TOKEN, { entries: 'no' }), /malformed host-path catalog entries/)
  assert.throws(
    () => pageUnderTest.push(TOKEN, { generation: 2, entries: [{ name: 'a', path: '/a', size: '3', isDirectory: false }] }),
    /malformed host-path catalog entry/,
  )
  pageUnderTest.emit('drop', drop(file('a.txt', 3)))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('a.txt', 3)), '/host/a.txt', 'the valid catalog survives')
})

test('an empty catalog clears stale entries', () => {
  const pageUnderTest = page()
  pageUnderTest.push(TOKEN, { generation: 1, entries: [entry('a.txt', '/host/a.txt', 3)] })
  pageUnderTest.push(TOKEN, { generation: 2, entries: [] })
  pageUnderTest.emit('drop', drop(file('a.txt', 3)))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('a.txt', 3)), '')
})

test('a catalog from a previous delivery cannot serve the next one', () => {
  const pageUnderTest = page()
  pageUnderTest.push(TOKEN, { generation: 1, entries: [entry('a.txt', '/host/a.txt', 3), entry('b.txt', '/host/b.txt', 4)] })
  pageUnderTest.clock.value += 50
  pageUnderTest.emit('drop', drop(file('a.txt', 3)))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('a.txt', 3)), '/host/a.txt')

  pageUnderTest.clock.value += 50
  pageUnderTest.emit('drop', drop(file('b.txt', 4)))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('b.txt', 4)), '', 'the catalog predates this delivery')

  pageUnderTest.push(TOKEN, { generation: 2, entries: [entry('b.txt', '/host/b.txt', 4)] })
  pageUnderTest.emit('drop', drop(file('b.txt', 4)))
  assert.equal(pageUnderTest.hostPaths.pathFor(file('b.txt', 4)), '/host/b.txt', 'a catalog adopted inside the delivery serves it')
})

test('a trusted paste clears the pending batch (paste is not a carrier channel)', () => {
  const pageUnderTest = page()
  pageUnderTest.push(TOKEN, { generation: 1, entries: [entry('a.txt', '/host/a.txt', 3)] })
  pageUnderTest.emit('drop', drop(file('a.txt', 3)))
  pageUnderTest.emit('paste', { isTrusted: true })
  assert.equal(pageUnderTest.hostPaths.pathFor(file('a.txt', 3)), '', 'the batch is gone after a paste')

  const other = page()
  other.push(TOKEN, { generation: 1, entries: [entry('a.txt', '/host/a.txt', 3)] })
  other.emit('drop', drop(file('a.txt', 3)))
  other.emit('paste', { isTrusted: false })
  assert.equal(other.hostPaths.pathFor(file('a.txt', 3)), '/host/a.txt', 'an untrusted paste does not clear')
})

