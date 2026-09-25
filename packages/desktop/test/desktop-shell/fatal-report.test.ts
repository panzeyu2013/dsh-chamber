import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { describeFatalError } from '../../describe-error.ts'
import {
  CONSOLE_RING_BYTES,
  ConsoleRing,
  appendFatalReport,
  fatalReportPath,
  pushConsoleMessage,
  recordFatalReport,
  renderFatalReport,
} from '../../fatal-report.ts'

test('describeFatalError：带上 Node 错误的 code/syscall/path（上游 inspect 面的最小可用子集）', () => {
  const error = Object.assign(new Error('spawn failed'), {
    code: 'EACCES',
    syscall: 'spawn /usr/local/bin/node',
    path: '/Applications/dsh.app/Contents/Resources/vendor/dsh/bin/node',
  })
  const text = describeFatalError(error)
  assert.ok(text.includes('spawn failed'), text)
  assert.ok(text.includes('code=EACCES'), text)
  assert.ok(text.includes('syscall=spawn /usr/local/bin/node'), text)
  assert.ok(text.includes('path=/Applications/dsh.app'), text)
})

test('describeFatalError：cause 链有界（≤4 层）且带 ← 连接', () => {
  let error: Error = new Error('level-1')
  for (let depth = 2; depth <= 6; depth++) error = new Error('level-' + depth, { cause: error })
  const text = describeFatalError(error)
  assert.ok(text.includes('level-6'), text)
  assert.ok(text.includes('level-4'), text)
  assert.ok(text.includes('level-3'), '第 4 层仍在描述内：' + text)
  assert.ok(!text.includes('level-2'), '超过 4 层的 cause 必须丢掉：' + text)
  assert.equal((text.match(/←/gu) ?? []).length, 3, '4 层 = 3 个连接符：' + text)
})

test('describeFatalError：敌意 getter 不抛、非 Error 值也有稳定文本', () => {
  const hostile = new Error('hostile')
  Object.defineProperty(hostile, 'code', {
    get() { throw new Error('nope') },
  })
  assert.ok(describeFatalError(hostile).includes('hostile'))
  assert.equal(describeFatalError('plain string'), 'plain string')
  assert.equal(describeFatalError(undefined), 'unknown fatal error')
})

test('renderFatalReport：键=值行式，含 source/phase/event 与换行转义', () => {
  const text = renderFatalReport({
    at: '2026-01-01T00:00:00.000Z',
    version: '0.4.0-beta.1',
    source: 'electron-main',
    phase: 'startup',
    event: 'startup-failure',
    detail: 'line1\nline2',
    extras: ['extra-a', ''],
  })
  assert.ok(text.includes('at=2026-01-01T00:00:00.000Z'), text)
  assert.ok(text.includes('version=0.4.0-beta.1'), text)
  assert.ok(text.includes('source=electron-main'), text)
  assert.ok(text.includes('phase=startup'), text)
  assert.ok(text.includes('event=startup-failure'), text)
  assert.ok(text.includes('detail=line1 ⏎ line2'), '换行必须转义为单行：' + text)
  assert.ok(text.includes('extra=extra-a'), text)
})

test('appendFatalReport：IO 注入 → 成功/失败，路径恒为 <userData>/logs/fatal-report.log', () => {
  const written: Array<{ path: string; text: string }> = []
  const dirs: string[] = []
  const target = '/tmp/fake-user-data'
  const pathUnderTest = fatalReportPath(target)
  assert.equal(pathUnderTest, path.join(target, 'logs', 'fatal-report.log'))
  const ok = appendFatalReport({
    path: pathUnderTest,
    text: 'body',
    io: { ensureDir: (dir) => dirs.push(dir), append: (p, text) => written.push({ path: p, text }) },
  })
  assert.deepEqual(ok, { written: true, path: pathUnderTest })
  assert.deepEqual(dirs, [path.join(target, 'logs')])
  assert.deepEqual(written, [{ path: pathUnderTest, text: 'body' }])
  const failed = appendFatalReport({
    path: pathUnderTest,
    text: 'body',
    io: { ensureDir: () => {}, append: () => { throw new Error('disk full') } },
  })
  assert.equal(failed.written, false)
  assert.ok((failed.reason ?? '').includes('disk full'), JSON.stringify(failed))
})

test('recordFatalReport：成功给路径、失败如实说不（绝不给假路径）', () => {
  const userDataDir = '/tmp/fake-user-data'
  const ok = recordFatalReport({
    userDataDir,
    record: { at: 'now', version: 'v', source: 'electron-main', phase: 'running', event: 'fatal', detail: 'boom' },
    io: { ensureDir: () => {}, append: () => {} },
  })
  assert.equal(ok.result.written, true)
  assert.equal(ok.line, '本地报告：' + fatalReportPath(userDataDir))
  const failed = recordFatalReport({
    userDataDir,
    record: { at: 'now', version: 'v', source: 'electron-main', phase: 'running', event: 'fatal', detail: 'boom' },
    io: { ensureDir: () => {}, append: () => { throw new Error('EACCES') } },
  })
  assert.equal(failed.result.written, false)
  assert.ok(failed.line.startsWith('本地报告写入失败'), failed.line)
  assert.ok(failed.line.includes('EACCES'), failed.line)
})

test('ConsoleRing：按字节有界、只留尾部证据', () => {
  const ring = new ConsoleRing(64)
  for (let index = 0; index < 40; index++) ring.push('line-' + index)
  assert.ok(ring.size <= 64, String(ring.size))
  const snapshot = ring.snapshot()
  assert.ok(snapshot.includes('line-39'), snapshot)
  assert.ok(!snapshot.startsWith('line-0'), snapshot)
  assert.ok(snapshot.length > 0)
  assert.equal(CONSOLE_RING_BYTES, 64 * 1024)
})

test('pushConsoleMessage：只收 error 级，两种事件形态都认', () => {
  const ring = new ConsoleRing()
  pushConsoleMessage(ring, [{ level: 'error', message: 'details-shape', lineNumber: 7, sourceId: 'app.js' }])
  assert.ok(ring.snapshot().includes('app.js:7 details-shape'), ring.snapshot())
  const fresh = new ConsoleRing()
  pushConsoleMessage(fresh, [{ level: 'info', message: 'ignored' }])
  assert.equal(fresh.snapshot(), '')
  pushConsoleMessage(fresh, [undefined, 3, 'legacy-error', 12, 'bundle.js'])
  assert.ok(fresh.snapshot().includes('bundle.js:12 legacy-error'), fresh.snapshot())
})
