/**
 * 控制面滚动日志文件契约（packages/control-plane/src/log-file.ts）。
 *
 * 锁：JSONL 落盘形状、logger 原样转发、按字节轮转、以及**任何失败都只降级
 * 不阻断**（打包态从 Finder 启动时 stdout 不落盘，这条文件是 WS splice 归因
 * 证据的唯一去处，但日志绝不允许反过来影响控制面行为）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONTROL_LOG_DIR, CONTROL_LOG_FILE, createControlLogSink, formatControlLogLine, withControlLogFile,
} from '../src/log-file.ts'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'cp-log-'))

test('logger 包装：原样转发给底层 sink 并落盘 JSONL', () => {
  const stateDir = tempDir()
  const forwarded: string[] = []
  const logger = withControlLogFile({
    log: (...args: unknown[]) => { forwarded.push(`log:${String(args[0])}`) },
    warn: (...args: unknown[]) => { forwarded.push(`warn:${String(args[0])}`) },
    error: (...args: unknown[]) => { forwarded.push(`error:${String(args[0])}`) },
  }, stateDir, { now: () => new Date('2026-12-01T00:00:00.000Z') })
  logger.log('WebSocket stream 7 closed (heartbeat lost after 1 unanswered ping(s), 30123ms)')
  logger.warn('warned')
  logger.error(new Error('boom'))
  logger.close()
  const lines = readFileSync(join(stateDir, CONTROL_LOG_DIR, CONTROL_LOG_FILE), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines.length, 3)
  assert.equal(lines[0].ts, '2026-12-01T00:00:00.000Z')
  assert.equal(lines[0].level, 'log')
  assert.match(lines[0].line, /closed \(heartbeat lost after 1 unanswered ping\(s\), 30123ms\)/)
  assert.equal(lines[2].level, 'error')
  assert.match(lines[2].line, /boom/)
  assert.deepEqual(forwarded, [
    'log:WebSocket stream 7 closed (heartbeat lost after 1 unanswered ping(s), 30123ms)',
    'warn:warned',
    'error:Error: boom',
  ], '控制面行为不变：日志仍照常转发给注入的 logger')
})

test('按字节轮转：超过上限后当前文件重置，旧内容进 .1', () => {
  const stateDir = tempDir()
  const sink = createControlLogSink({ stateDir, maxBytes: 200, files: 3 })
  const write = (index: number): void => {
    sink.write({ ts: '2026-12-01T00:00:00.000Z', level: 'log', line: `line-${String(index)}-${'x'.repeat(60)}` })
  }
  for (let index = 0; index < 8; index += 1) write(index)
  const ring = (suffix: string): string =>
    readFileSync(join(stateDir, CONTROL_LOG_DIR, `${CONTROL_LOG_FILE}${suffix}`), 'utf8')
  const current = ring('')
  assert.ok(current.length < 300, '当前文件在轮转后应远小于累积体积')
  assert.match(current, /line-6/, '最新记录在当前文件')
  assert.match(ring('.1'), /line-4/, '上一代记录在 .1')
  assert.match(ring('.2'), /line-2/, '更早一代在 .2')
  assert.equal(existsSync(join(stateDir, CONTROL_LOG_DIR, `${CONTROL_LOG_FILE}.3`)), false,
    'files=3 ⇒ 环只有 .log/.1/.2（有界保留，最旧的确实被淘汰）')
})

test('目录不可创建时只降级：write 不抛错、isActive()=false、告警一次', () => {
  const stateDir = tempDir()
  const blocker = join(stateDir, 'not-a-dir')
  writeFileSync(blocker, 'x')
  const warnings: string[] = []
  const sink = createControlLogSink({ stateDir: blocker, warn: message => { warnings.push(message) } })
  assert.equal(sink.isActive(), false)
  sink.write({ ts: 't', level: 'log', line: 'never lands' })
  sink.write({ ts: 't', level: 'log', line: 'never lands either' })
  assert.equal(warnings.length, 1, '降级只告警一次')
  rmSync(stateDir, { recursive: true, force: true })
})

test('0600/0700 纪律：日志目录与文件都不放宽到世界可读（design 02 §3.8 同族）', () => {
  const stateDir = tempDir()
  const sink = createControlLogSink({ stateDir, warn: () => undefined })
  sink.write({ ts: 't', level: 'log', line: 'x' })
  const dirMode = statSync(join(stateDir, CONTROL_LOG_DIR)).mode & 0o777
  const fileMode = statSync(join(stateDir, CONTROL_LOG_DIR, CONTROL_LOG_FILE)).mode & 0o777
  assert.equal(dirMode, 0o700, '日志目录必须 0700（与 host-logs.ts 同纪律）')
  assert.equal(fileMode, 0o600, '日志文件必须 0600（内容可能含本机路径/会话内容）')
  sink.close()
})

test('轮转环最小 2 份：files=1 被夹到 2（不得留下与文档不符的第二份）', () => {
  const stateDir = tempDir()
  const sink = createControlLogSink({ stateDir, files: 1, maxBytes: 10, warn: () => undefined })
  for (const index of [0, 1, 2, 3, 4]) sink.write({ ts: 't', level: 'log', line: 'y'.repeat(20) + String(index) })
  const dir = join(stateDir, CONTROL_LOG_DIR)
  assert.deepEqual(readdirSync(dir).sort(), [CONTROL_LOG_FILE, `${CONTROL_LOG_FILE}.1`], '环只有 .log 与 .1 两份')
  assert.ok(statSync(join(dir, CONTROL_LOG_FILE)).size <= 60, '当前文件仍有界')
  sink.close()
})

test('close→reopen 必须恢复落盘（控制面 stop→start 重启的取证缺口）', () => {
  const stateDir = tempDir()
  const sink = createControlLogSink({ stateDir, warn: () => undefined })
  const path = join(stateDir, CONTROL_LOG_DIR, CONTROL_LOG_FILE)
  sink.write({ ts: 't', level: 'log', line: 'before-close' })
  sink.close()
  const afterClose = sink.isActive()
  sink.write({ ts: 't', level: 'log', line: 'while-closed' })
  sink.reopen()
  sink.write({ ts: 't', level: 'log', line: 'after-reopen' })
  const text = readFileSync(path, 'utf8')
  assert.equal(afterClose, false, 'close 之后 isActive 为假')
  assert.equal(sink.isActive(), true, 'reopen 必须恢复落盘')
  assert.ok(text.includes('before-close'))
  assert.ok(!text.includes('while-closed'), '关闭期间的写入不得落盘')
  assert.ok(text.includes('after-reopen'), '重开后的写入必须落盘')
  sink.close()
})

test('logs/ 本身是符号链接时必须拒绝落盘（文件级 O_NOFOLLOW 只保护最后一段）', () => {
  const stateDir = tempDir()
  const outside = tempDir()
  mkdirSync(join(stateDir, CONTROL_LOG_DIR), { recursive: true })
  rmSync(join(stateDir, CONTROL_LOG_DIR), { recursive: true, force: true })
  symlinkSync(outside, join(stateDir, CONTROL_LOG_DIR))
  const warnings: string[] = []
  const sink = createControlLogSink({ stateDir, warn: message => { warnings.push(message) } })
  sink.write({ ts: 't', level: 'log', line: 'must-not-land-outside' })
  assert.equal(sink.isActive(), false, '符号链接目录必须降级为不落盘')
  assert.equal(warnings.length, 1, '只告警一次')
  assert.ok(!existsSync(join(outside, CONTROL_LOG_FILE)), '绝不透过符号链接写出去')
})

test('logs/ 符号链接在 reopen 之后仍必须拒绝落盘（start() 无条件 reopen）', () => {
  const stateDir = tempDir()
  const outside = tempDir()
  mkdirSync(join(stateDir, CONTROL_LOG_DIR), { recursive: true })
  rmSync(join(stateDir, CONTROL_LOG_DIR), { recursive: true, force: true })
  symlinkSync(outside, join(stateDir, CONTROL_LOG_DIR))
  const warnings: string[] = []
  const sink = createControlLogSink({ stateDir, warn: message => { warnings.push(message) } })
  assert.equal(sink.isActive(), false, '构造期即降级')
  // 生产路径：createControlPlane → start() 无条件 reopen()（2026-12 独立复核发现：
  // 只查构造期会让降级在 reopen 时被撤销，O_NOFOLLOW 只保护最后一段）。
  sink.reopen()
  assert.equal(sink.isActive(), false, 'reopen 不得把符号链接目录重新激活')
  sink.write({ ts: 't', level: 'log', line: 'must-not-land-outside' })
  assert.ok(warnings.length >= 1, '降级必须告警')
  assert.ok(!existsSync(join(outside, CONTROL_LOG_FILE)), 'reopen 后也绝不透过符号链接写出去')
  assert.ok(!existsSync(join(outside, CONTROL_LOG_DIR)), '不得在链接目标目录里创建任何日志构件')
})

test('reopen 必须重新对齐磁盘水位（句柄已开时不 stat 会让边界涨到 2x 上限）', () => {
  const stateDir = tempDir()
  const sink = createControlLogSink({ stateDir, maxBytes: 100, warn: () => undefined })
  const path = join(stateDir, CONTROL_LOG_DIR, CONTROL_LOG_FILE)
  sink.write({ ts: 't', level: 'log', line: 'x'.repeat(20) })
  appendFileSync(path, 'y'.repeat(200)) // 外部写入：内存水位不再反映磁盘
  sink.reopen()
  sink.write({ ts: 't', level: 'log', line: 'z'.repeat(20) })
  assert.ok(statSync(path).size <= 100, 'reopen 后必须先按真实大小判定轮转')
  sink.close()
})

test('轮转失败必须降级并告警一次，绝不让文件无界增长', () => {
  const stateDir = tempDir()
  const warnings: string[] = []
  const sink = createControlLogSink({ stateDir, maxBytes: 10, warn: message => { warnings.push(message) } })
  const dir = join(stateDir, CONTROL_LOG_DIR)
  sink.write({ ts: 't', level: 'log', line: 'a'.repeat(20) })
  // 目录设为不可写：rename 必然 EPERM ⇒ 轮转不成立（当前文件仍在且超限）。
  chmodSync(dir, 0o500)
  sink.write({ ts: 't', level: 'log', line: 'b'.repeat(20) })
  chmodSync(dir, 0o700)
  assert.equal(sink.isActive(), false, '轮转失败即降级为不落盘')
  assert.equal(warnings.length, 1, '只告警一次')
  const size = statSync(join(dir, CONTROL_LOG_FILE)).size
  assert.ok(size < 60, `降级后不得继续追加（实际 ${String(size)} 字节）`)
})

test('行序列化：换行折叠、Error 取 stack、超长截断', () => {
  assert.equal(formatControlLogLine(['a\nb', 'c']), 'a ⏎ b c')
  assert.match(formatControlLogLine([new Error('deep')]), /Error: deep/)
  const long = formatControlLogLine(['y'.repeat(9_000)])
  assert.ok(long.length <= 8_193, '单行有界')
  assert.ok(long.endsWith('…'))
})

test('stateDir 下的 logs 目录被创建（与 host-logs 并列，不互相干扰）', () => {
  const stateDir = tempDir()
  mkdirSync(join(stateDir, 'host-logs'), { recursive: true })
  const sink = createControlLogSink({ stateDir })
  sink.write({ ts: 't', level: 'log', line: 'hello' })
  assert.ok(existsSync(join(stateDir, 'logs')), 'logs/ 被创建')
  assert.ok(existsSync(join(stateDir, 'host-logs')), 'host-logs/ 不受影响')
  rmSync(stateDir, { recursive: true, force: true })
})
