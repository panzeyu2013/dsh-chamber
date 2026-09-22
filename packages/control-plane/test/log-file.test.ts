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
  chownSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONTROL_LOG_DIR, CONTROL_LOG_FILE, DEFAULT_CONTROL_LOG_FILES, DEFAULT_CONTROL_LOG_MAX_BYTES,
  IDENTITY_CHECK_EVERY, MIN_CONTROL_LOG_FILES, createControlLogSink, formatControlLogLine,
  verifyOpenedLeafIdentity, withControlLogFile,
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
  // 预置不安全归档槽（目录）⇒ 环的槽位校验拒绝整个轮转，与进程 uid 无关。
  // 原实现用 chmod 0500 制造 EPERM，但 uid 0 下 rename 仍会成功（2026-12 实测），
  // 该注入在 root 环境/容器里恒不成立，等于这条用例在那里无法失败。
  mkdirSync(join(dir, CONTROL_LOG_FILE + '.1'))
  sink.write({ ts: 't', level: 'log', line: 'b'.repeat(20) })
  assert.equal(sink.isActive(), false, '轮转失败即降级为不落盘')
  assert.equal(warnings.length, 1, '只告警一次')
  const size = statSync(join(dir, CONTROL_LOG_FILE)).size
  assert.ok(size < 60, `降级后不得继续追加（实际 ${String(size)} 字节）`)
})

test('轮转遇预置符号链接归档槽：拒绝轮转并降级，链接与目标都保留（P1-4 同包收敛）', () => {
  const stateDir = tempDir()
  const outside = tempDir()
  const victim = join(outside, 'victim.log')
  writeFileSync(victim, 'secret-victim')
  const dir = join(stateDir, CONTROL_LOG_DIR)
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, CONTROL_LOG_FILE + '.1')
  symlinkSync(victim, archive)
  const warnings: string[] = []
  const sink = createControlLogSink({ stateDir, maxBytes: 10, files: 3, warn: message => { warnings.push(message) } })
  sink.write({ ts: 't', level: 'log', line: 'a'.repeat(20) })
  sink.write({ ts: 't', level: 'log', line: 'b'.repeat(20) })
  assert.equal(sink.isActive(), false, '被预置链接的归档槽必须让 sink 降级而不是被覆盖')
  assert.equal(warnings.length, 1, '只告警一次')
  assert.equal(readFileSync(victim, 'utf8'), 'secret-victim', '链接目标内容不得被改动')
  assert.equal(lstatSync(archive).isSymbolicLink(), true, '预置链接作为证据保留')
  sink.close()
})

test('轮转遇多链接归档槽：拒绝轮转并降级，不删除不覆盖（P1-4 同包收敛）', () => {
  const stateDir = tempDir()
  const outside = tempDir()
  const victim = join(outside, 'victim.log')
  writeFileSync(victim, 'secret-victim')
  const dir = join(stateDir, CONTROL_LOG_DIR)
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, CONTROL_LOG_FILE + '.1')
  linkSync(victim, archive)
  const warnings: string[] = []
  const sink = createControlLogSink({ stateDir, maxBytes: 10, files: 3, warn: message => { warnings.push(message) } })
  sink.write({ ts: 't', level: 'log', line: 'a'.repeat(20) })
  sink.write({ ts: 't', level: 'log', line: 'b'.repeat(20) })
  assert.equal(sink.isActive(), false, '多链接归档槽必须 fail-closed')
  assert.equal(warnings.length, 1)
  assert.equal(readFileSync(victim, 'utf8'), 'secret-victim')
  assert.equal(existsSync(archive), true, '多链接槽位不得被删除')
  assert.equal(statSync(archive).nlink, 2, '链接关系保持不变')
  sink.close()
})

test('轮转遇异主归档槽：拒绝轮转并降级（同 uid 校验；chown 需权限，否则跳过）（P1-4 同包收敛）', t => {
  const stateDir = tempDir()
  const dir = join(stateDir, CONTROL_LOG_DIR)
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, CONTROL_LOG_FILE + '.1')
  writeFileSync(archive, 'foreign')
  // A foreign-owned slot is only constructible as root: a non-root process
  // chowning to "another" uid would only ever recreate its own uid, and the
  // symlink/hard-link cases above already lock the refusal path everywhere.
  const effectiveUid = process.geteuid?.() ?? -1
  if (effectiveUid !== 0) {
    t.skip('creating a foreign-owned file requires root')
    return
  }
  try {
    chownSync(archive, 65534, 65534)
  } catch {
    t.skip('chown to another uid is unavailable on this filesystem')
    return
  }
  const warnings: string[] = []
  const sink = createControlLogSink({ stateDir, maxBytes: 10, files: 3, warn: message => { warnings.push(message) } })
  sink.write({ ts: 't', level: 'log', line: 'a'.repeat(20) })
  sink.write({ ts: 't', level: 'log', line: 'b'.repeat(20) })
  assert.equal(sink.isActive(), false, '异主归档槽必须 fail-closed')
  assert.equal(warnings.length, 1)
  assert.equal(readFileSync(archive, 'utf8'), 'foreign', '他人文件不得被删除或覆盖')
  sink.close()
})

test('行序列化：换行折叠、Error 取 stack、超长截断', () => {
  assert.equal(formatControlLogLine(['a\nb', 'c']), 'a ⏎ b c')
  assert.match(formatControlLogLine([new Error('deep')]), /Error: deep/)
  const long = formatControlLogLine(['y'.repeat(9_000)])
  assert.ok(long.length <= 8_193, '单行有界')
  assert.ok(long.endsWith('…'))
})

test('默认保留规格被钉住（文档记录的 2 MiB × 3 份 = 6 MiB 不得静默漂移）', () => {
  // 设计 02 §3.8 / 设计 25 §3.1 / T-25 都以这些数字作跨 flavor 对照（Electron 2 MiB×3
  // vs 原生 256 KiB×2）；常量此前只被 src 内部引用，改小会让文档与实现脱钩而零告警
  // （2026-12 独立复核）。
  assert.equal(DEFAULT_CONTROL_LOG_MAX_BYTES, 2 * 1024 * 1024)
  assert.equal(DEFAULT_CONTROL_LOG_FILES, 3)
  assert.equal(MIN_CONTROL_LOG_FILES, 2)
  assert.equal(CONTROL_LOG_DIR, 'logs')
  assert.equal(CONTROL_LOG_FILE, 'control-plane.log')
})

test('已存在的宽松目录/文件必须被显式收紧到 0700/0600（mode 只在创建时生效）', () => {
  const stateDir = tempDir()
  const directory = join(stateDir, CONTROL_LOG_DIR)
  const path = join(directory, CONTROL_LOG_FILE)
  mkdirSync(directory, { recursive: true })
  chmodSync(directory, 0o755)
  writeFileSync(path, '')
  chmodSync(path, 0o644)
  const sink = createControlLogSink({ stateDir, warn: () => undefined })
  sink.write({ ts: 't', level: 'log', line: 'tightened' })
  assert.equal(statSync(directory).mode & 0o777, 0o700, '既有目录必须收紧到 0700')
  assert.equal(statSync(path).mode & 0o777, 0o600, '既有文件必须收紧到 0600')
  sink.close()
  rmSync(stateDir, { recursive: true, force: true })
})

test('日志文件被外部删除后必须有界自愈（常驻句柄不得一直写进已 unlink 的 inode）', () => {
  const stateDir = tempDir()
  const path = join(stateDir, CONTROL_LOG_DIR, CONTROL_LOG_FILE)
  const sink = createControlLogSink({ stateDir, warn: () => undefined })
  sink.write({ ts: 't', level: 'log', line: 'before-delete' })
  rmSync(path, { force: true })
  assert.ok(!existsSync(path))
  // 身份巡检按行摊薄：IDENTITY_CHECK_EVERY 行内必须发现文件消失并重新创建。
  for (let index = 0; index < IDENTITY_CHECK_EVERY; index += 1) {
    sink.write({ ts: 't', level: 'log', line: 'after-' + String(index) })
  }
  assert.ok(existsSync(path), '巡检后必须重新创建日志文件')
  assert.ok(readFileSync(path, 'utf8').includes('after-' + String(IDENTITY_CHECK_EVERY - 1)),
    '重建后的文件必须继续接住后续日志')
  sink.close()
  rmSync(stateDir, { recursive: true, force: true })
})

test('符号链接目录：拒绝落盘之前绝不动链接目标的权限（chmod 在 lstat 之前会跟随链接）', () => {
  const stateDir = tempDir()
  const outside = tempDir()
  chmodSync(outside, 0o755)
  symlinkSync(outside, join(stateDir, CONTROL_LOG_DIR))
  const sink = createControlLogSink({ stateDir, warn: () => undefined })
  assert.equal(sink.isActive(), false, '符号链接目录必须降级')
  assert.equal(statSync(outside).mode & 0o777, 0o755, '链接目标目录权限不得被 chmod 改掉')
  sink.reopen()
  assert.equal(statSync(outside).mode & 0o777, 0o755, 'reopen 路径同理（先判链接再 chmod）')
})

test('叶子被换成 FIFO：打开不得阻塞事件循环（O_NONBLOCK），只降级', () => {
  const stateDir = tempDir()
  const path = join(stateDir, CONTROL_LOG_DIR, CONTROL_LOG_FILE)
  mkdirSync(join(stateDir, CONTROL_LOG_DIR), { recursive: true })
  execFileSync('mkfifo', [path])
  const sink = createControlLogSink({ stateDir, warn: () => undefined })
  // 无读者的 FIFO：O_WRONLY 同步 open 会永久阻塞（旧实现），O_NONBLOCK 下立即 ENXIO。
  sink.write({ ts: 't', level: 'log', line: 'must-not-block' })
  assert.equal(sink.isActive(), false, 'FIFO 叶子必须降级而不是阻塞')
})

test('序列化永不抛回调用方：可撤销 Proxy 也不能（instanceof 本身会抛）', () => {
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  assert.doesNotThrow(() => formatControlLogLine([proxy]))
  assert.equal(formatControlLogLine([proxy]), '[unserializable log argument]')
})

test('序列化永不抛回调用方（toJSON 与 toString 同时抛的宿主对象）', () => {
  const hostile = {
    toJSON() { throw new Error('boom-json') },
    toString() { throw new Error('boom-string') },
  }
  assert.doesNotThrow(() => formatControlLogLine([hostile]),
    '日志序列化失败不得把异常抛回 logger（否则 logger.log 本身成为新的失败面）')
})

test('withControlLogFile 的降级告警走**注入的** logger，而不是硬编码 console.warn', () => {
  // 2026-12 三轮独立复核（M7）：这条被宣称的修复此前没有任何测试——删掉
  // `warn: options.warn ?? (m => base.warn(m))` 全套仍然绿。这里从**包装器**入口
  // 触发一次真实降级（stateDir 指向一个普通文件），断言告警落在调用方的 logger 上。
  const stateDir = tempDir()
  const blocker = join(stateDir, 'not-a-dir')
  writeFileSync(blocker, 'x')
  const forwarded: string[] = []
  const logger = withControlLogFile({
    log: () => undefined,
    warn: message => { forwarded.push(String(message)) },
    error: () => undefined,
  }, blocker)
  logger.log('宿主行')
  assert.equal(forwarded.length, 1, '降级告警必须经注入的 logger 转发（且只一次）')
  assert.match(forwarded[0] ?? '', /disabled/, '转发的就是降级说明')
  logger.close()
  rmSync(stateDir, { recursive: true, force: true })
})

test('identity 巡检跨过门槛即发现外部替换并按新 inode 重开（回到可观测契约）', () => {
  // 2026-12 三轮独立复核 M10：把 open 时的 fstatSync(handle) 换回 statSync(path)，
  // 19 个用例全绿——因为真正的分歧只在"open 与记身份之间路径被换"的竞态里，而没有
  // seam 就构造不出那一刻。这里至少锁住可观测契约（外部替换 → 巡检重绑），并把
  // 该竞态的构造缺口如实记为已接受残余（见本条复核记录）。
  const stateDir = tempDir()
  const sink = createControlLogSink({ stateDir, warn: () => undefined })
  const file = join(stateDir, CONTROL_LOG_DIR, CONTROL_LOG_FILE)
  sink.write({ ts: 't', level: 'log', line: 'first' })
  rmSync(file)
  writeFileSync(file, 'external' + String.fromCharCode(10))
  for (let i = 0; i < IDENTITY_CHECK_EVERY + 2; i += 1) {
    sink.write({ ts: 't', level: 'log', line: `after-${i}` })
  }
  assert.equal(sink.isActive(), true, '巡检发现换手后按新文件重开（不是永久写进已 unlink 的 inode）')
  const lines = readFileSync(file, 'utf8').trim().split(String.fromCharCode(10))
  assert.equal(lines[0], 'external', '外部内容保留（巡检不截断新文件）')
  assert.ok(lines.length > 1 && (lines[1] ?? '').includes('after-'), '门槛之后的行落在新文件里')
  sink.close()
  rmSync(stateDir, { recursive: true, force: true })
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

test('win32 回退身份复验：符号链接叶子与换文件被拒绝，真实叶子通过（C2）', () => {
  // win32 无 O_NOFOLLOW：open 后必须按 (dev, ino) 复验 path 仍是刚打开的叶子，
  // 否则 logs/control-plane.log 被换成链接时会跟随写入并对目标 fchmod 0600。
  const stateDir = tempDir()
  const real = join(stateDir, 'real.log')
  writeFileSync(real, 'x' + String.fromCharCode(10))
  const fd = openSync(real, constants.O_WRONLY | constants.O_APPEND)
  try {
    verifyOpenedLeafIdentity(real, fd)
    const link = join(stateDir, 'link.log')
    symlinkSync(real, link)
    assert.throws(() => verifyOpenedLeafIdentity(link, fd), /symbolic link/)
    const other = join(stateDir, 'other.log')
    writeFileSync(other, 'y' + String.fromCharCode(10))
    assert.throws(() => verifyOpenedLeafIdentity(other, fd), /changed while being opened/)
  } finally {
    closeSync(fd)
    rmSync(stateDir, { recursive: true, force: true })
  }
})

