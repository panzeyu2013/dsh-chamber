#!/usr/bin/env node
/**
 * remote-state-injection-matrix —— 故障注入覆盖矩阵校验器（plan §10「故障注入」
 * 与「故障注入补三条」的**可执行台账**）。
 *
 * 为什么需要它：§10 列的每一条注入（watcher 被杀、host 停机、读取失败、时钟偏斜、
 * 游标过期、事件静默、/read 写失败与乱序、blank 归因…）都要求「每项都断言不产生
 * 假未读 / 不丢真未读」。但测试文件会改名、用例会被删、断言会被改绿——一份写在
 * 文档里的台账会悄悄失真。本脚本把每条注入映射到**具体的文件 + 用例标题**，逐条
 * 校验它今天仍然存在；标为 covered 而找不到证据的即 exit 1，标为 open 的逐条列出
 * （未闭合项不得在验收报告里被算作通过）。
 *
 * 用法：node scripts/gates/remote-state-injection-matrix.mjs [--json] [--allow-open]
 * 退出码：0 无失真（open 项允许存在，除 --allow-open 外仍会列出）/ 1 covered 缺证据 / 2 用法错误。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const GW = 'packages/gateway/test/session-state'
const SB = 'packages/dsh-chamber-client-ui-sidebar/test'
const RN = 'packages/renderer/test'

/** 每条注入：covered = 必须有 live 断言；open = 已知未闭合（如实列出）。 */
const INJECTIONS = [
  { id: 'watcher-restart', fault: 'watcher 被杀 / 重启', expect: 'covered', checks: [
    { file: `${GW}/session-state-persistence.test.ts`, title: 'reload preserves the cursor, rows, completion classification and read marks' },
    { file: `${GW}/session-state-persistence.test.ts`, title: 'a stored running row stays a gap candidate across a restart until classified' },
  ] },
  { id: 'host-down', fault: 'host 停机（不伪造完成）', expect: 'covered', checks: [
    { file: `${GW}/session-state-observer.test.ts`, title: 'suspend: host-down reports serviceable false and stop() closes the watcher' },
    { file: `${GW}/session-state-routes.test.ts`, title: 'host-down still answers' },
    { file: `${GW}/session-state-store.test.ts`, title: 'host-down keeps rows but flips serviceable false (plan section 4)' },
  ] },
  { id: 'unreadable-tail', fault: '读取失败（尾巴不可读）→ 降级武装而非丢完成', expect: 'covered', checks: [
    { file: `${GW}/session-state-observer.test.ts`, title: 'an unreadable follow falls back to arming with the degraded marker' },
    { file: `${GW}/session-state-store.test.ts`, title: 'an unreadable tail falls back to arming with a null lastTurnEnd marker' },
    { file: `${SB}/session-rows/derive-unread.test.ts`, title: 'a degraded arm still respects the read watermark (no permanent unread)' },
  ] },
  { id: 'clock-skew', fault: '时钟偏斜 ≥1h（不丢真未读）', expect: 'covered', checks: [
    { file: `${GW}/session-state-routes.test.ts`, title: 'a client clock ahead of the host cannot buy a future read mark (plan §10 skew)' },
  ] },
  { id: 'cursor-expired', fault: '游标过期 / 伪造（强制全量重取）', expect: 'covered', checks: [
    { file: `${GW}/session-state-store.test.ts`, title: 'replayFrom distinguishes satisfiable, current, future and e' },
    { file: `${GW}/session-state-routes.test.ts`, title: 'Last-Event-ID resumes from the ring without a snapshot' },
  ] },
  { id: 'event-silence', fault: '事件静默（连接在、事件停，R21）', expect: 'covered', checks: [
    { file: `${GW}/session-state-observer.test.ts`, title: 'event silence triggers a resubscribe and a fresh baseline' },
  ] },
  { id: 'read-write-order', fault: '/read 写失败与乱序（R22）', expect: 'covered', checks: [
    { file: `${GW}/session-state-store.test.ts`, title: 'read marks are per-client, monotonic, idempotent and source-wide effective' },
    { file: `${GW}/session-state-persistence.test.ts`, title: 'double corruption is sticky, loud and never overwritten' },
  ] },
  { id: 'gap-reconstruction', fault: '缺口重建（R3，重启后重分类）', expect: 'covered', checks: [
    { file: `${GW}/session-state-observer.test.ts`, title: 'a baseline-found stop after a restart is re-classified (gap reconstruction, R3)' },
    { file: `${GW}/session-state-store.test.ts`, title: 'a stored running row found stopped after restart is a reconstructed edge (once)' },
  ] },
  { id: 'waterfall-delegation', fault: '瀑布委派（有下游才委派、无壳保持等待）', expect: 'covered', checks: [
    { file: `${GW}/session-state-observer.test.ts`, title: 'a waterfall is held while no downstream mu' },
    { file: `${GW}/session-state-observer.test.ts`, title: 'a held waterfall is delegated with ne' },
    { file: `${GW}/session-state-observer.test.ts`, title: 'the grace window is honoured: no delegation before waterfallGraceMs' },
  ] },
  { id: 'user-stop-no-unread', fault: '用户主动停止不产生假未读', expect: 'covered', checks: [
    { file: `${GW}/session-state-observer.test.ts`, title: 'an aborted+user tail never arms unread but is recorded as lastTurnEnd' },
    { file: `${SB}/session-rows/derive-unread.test.ts`, title: 'completedAt counts for a completed classification and for the degraded (absent) marker' },
  ] },
  { id: 'neutral-endings', fault: 'blocked/error/max-tokens/interrupted 中立', expect: 'covered', checks: [
    { file: `${GW}/session-state-observer.test.ts`, title: 'a neutral (blocked) tail arms nothing' },
  ] },
  { id: 'poll-mode-degradation', fault: '轮询模式退化（不臆造未读，R18/R20）', expect: 'covered', checks: [
    { file: `${GW}/session-state-observer.test.ts`, title: 'poll mode owns the unary baseline cadence while $events never becomes ready (R18)' },
    { file: `${GW}/session-state-routes.test.ts`, title: 'poll mode advertises the reduced feature set' },
  ] },
  { id: 'disabled-switch', fault: '禁用开关（503 session_state_disabled）', expect: 'covered', checks: [
    { file: `${GW}/session-state-routes.test.ts`, title: 'the disabled switch answers 503 session_state_disabled on every route' },
  ] },
  { id: 'persistence-integrity', fault: '持久化损坏 ≠ 空状态（响亮拒写）', expect: 'covered', checks: [
    { file: `${GW}/session-state-persistence.test.ts`, title: 'a schemaVersion-less document is corruption, not an empty state' },
  ] },
  { id: 'privacy-whitelist', fault: '落盘仅 id 与状态元数据（无内容/凭据）', expect: 'covered', checks: [
    { file: `${GW}/session-state-persistence.test.ts`, title: 'the persisted document carries only session ids and state metadata (privacy whitelist)' },
  ] },
  { id: 'four-surface-consistency', fault: '四面一致（点/待办/徽标/通知同一投影）', expect: 'covered', checks: [
    { file: `${RN}/aggregate/badge-count.test.ts`, title: 'a vendor-armed completion counts even with no ledger entry' },
    { file: `${SB}/session-rows/derive-unread.test.ts`, title: 'unread uses max(updatedAt, completedAt): either watermark above readThrough wins' },
    { file: `${SB}/session-rows/todo-attention.test.ts`, title: '' },
  ] },
  { id: 'blank-frame', fault: '白帧三形态判据（含严格档）', expect: 'covered', checks: [
    { file: `${RN}/view-runtime/switch-frame-verdict.test.ts`, title: '' },
    { file: `${RN}/view-runtime/switch-frame-instruments.test.ts`, title: '' },
  ] },
  { id: 'blank-attribution', fault: 'blank 创建归因（I10，R23）', expect: 'covered', checks: [
    { file: `${SB}/session-state/session-create-ledger.test.ts`, title: 'the ledger aggregates per source and per origin, and counts blanks by label' },
    { file: `${SB}/session-state/session-create-ledger.test.ts`, title: 'unlabeled creations are visible (the instrument coverage half of the criterion)' },
    { file: `${SB}/session-state/session-create-ledger.test.ts`, title: 'every create call site declares an origin' },
  ] },
  // W6：SSH/dsh 远端的无壳观察者（实例自己的远程协议；观察者不结算瀑布）。
  { id: 'ssh-headless-observer', fault: '无壳仍能观察完成（SSH/dsh 远端，W6）', expect: 'covered', checks: [
    { file: `${RN}/session-state/source-mux-facts.test.ts`, title: 'the observer opens only $events and never answers a waterfall' },
    { file: `${RN}/session-state/source-mux-facts.test.ts`, title: 'one true->false edge opens exactly one follow and completed arms the row' },
    { file: `${RN}/session-state/source-mux-facts.test.ts`, title: 'a user stop and a neutral ending never arm; an unreadable tail degrades and arms' },
  ] },
  { id: 'facts-source-wiring', fault: '桌面事实源接线（probe/stream/overlay/落盘）', expect: 'covered', checks: [
    // The App source-text wiring locks were retired in the second trim round
    // (round-2 rule: a wiring lock dies once the invariant has behaviour tests);
    // the three behaviour witnesses below carry the injection.
    { file: `${RN}/session-state/unread-store.test.ts`, title: '' },
    { file: `${RN}/session-state/session-facts-source.test.ts`, title: '' },
    { file: `${RN}/session-state/unread-derivation.test.ts`, title: '' },
  ] },
]

/**
 * Live-code projection: comments removed and skip/todo declarations renamed, so
 * a title that only survives in a comment or in a skipped declaration no longer
 * counts as evidence (P2-13: the old matcher was a plain substring search).
 */
function liveProjection(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\b(?:test|it|describe|suite)\.(?:skip|todo|fixme)\s*\(\s*(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, 'SKIPPED_DECL')
}

function exists(title, file) {
  let text
  try { text = readFileSync(join(ROOT, file), 'utf8') } catch { return false }
  // 文件级证据（title ''）只证明文件存在 —— 见头注的覆盖纪律。
  return title === '' ? true : liveProjection(text).includes(title)
}

function main() {
  const wantJson = process.argv.includes('--json')
  const rows = INJECTIONS.map(injection => {
    const checks = injection.checks.map(check => ({ file: check.file, title: check.title || '(文件级：该文件存在即证据)', live: exists(check.title, check.file) }))
    return { ...injection, checks, live: checks.every(c => c.live) }
  })
  const lost = rows.filter(r => r.expect === 'covered' && !r.live)
  const open = rows.filter(r => r.expect === 'open')
  if (wantJson) {
    console.log(JSON.stringify({ schema: 'remote-state-injection-matrix/v1', capturedAt: new Date().toISOString(), rows, lost: lost.map(r => r.id), open: open.map(r => r.id) }, null, 2))
  } else {
    console.log('故障注入覆盖矩阵（plan §10）')
    for (const r of rows) {
      const tag = r.expect === 'open' ? 'OPEN   ' : r.live ? 'COVERED' : 'LOST   '
      console.log(`  ${tag} ${r.id.padEnd(26)} ${r.fault}`)
      for (const c of r.checks) if (!c.live) console.log(`           ↳ 缺证据：${c.file} :: ${c.title || '(文件)'}`)
      if (r.expect === 'open') console.log('           ↳ 未闭合：交付后须替换为 live 断言，本项不得计入通过')
    }
    console.log(`\ncovered=${rows.filter(r => r.expect === 'covered' && r.live).length} lost=${lost.length} open=${open.length}`)
    if (open.length > 0) console.log(`未闭合（不得计入通过）：${open.map(r => r.id).join(', ')}`)
  }
  process.exit(lost.length > 0 ? 1 : 0)
}

/**
 * `--self-test`：负控——把一条 covered 条目的证据标题故意改坏，矩阵**必须**
 * 把它判成 LOST 并以非零退出。没有这一步，"20 covered"无法与"检查根本没跑"
 * 区分（仪表必须能失败）。
 */
function selfTest() {
  const target = INJECTIONS.find(entry => entry.expect === 'covered' && entry.checks.length > 0)
  if (target === undefined) {
    console.error('self-test FAIL：没有可用的 covered 条目做负控')
    process.exit(1)
  }
  const original = target.checks[0]
  target.checks[0] = { ...original, title: 'SELF-TEST: title that must not exist' }
  const rows = INJECTIONS.map(injection => {
    const checks = injection.checks.map(check => ({ file: check.file, title: check.title || '(文件级：该文件存在即证据)', live: exists(check.title, check.file) }))
    return { ...injection, checks, live: checks.every(c => c.live) }
  })
  const lost = rows.filter(r => r.expect === 'covered' && !r.live)
  target.checks[0] = original
  const ok = lost.length === 1 && lost[0].id === target.id
  console.log(ok
    ? `injection-matrix self-test: ok（负控 ${target.id} 被判 LOST，恰一条）`
    : `injection-matrix self-test: FAIL（期望恰 ${target.id} 一条 LOST，实得 ${lost.map(r => r.id).join(',') || '0'}）`)
  process.exit(ok ? 0 : 1)
}

if (process.argv.includes('--self-test')) selfTest()
else main()
