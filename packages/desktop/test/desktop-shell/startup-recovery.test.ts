/**
 * startup-recovery.test.ts —— C4（启动与修复）纯决策 + main.ts 接线锁步。
 *
 * 覆盖三层：
 *   ① startup-error.ts 的纯决策：三选（退出/重启/安全模式重启）按钮布局、默认项
 *      与 Esc 都落安全项（S-43 纪律）、越界响应回落安全项；
 *   ② 备份腿：copied / identical（幂等）/ absent / failed（失败不中断）与
 *      「只备份 chamber 自持文件、绝不碰 dsh profile」白名单；
 *   ③ main.ts 接线（Electron main 无法在 node 单测里真跑）：五条 fatal 路径都经
 *      reportFatalStartupFailure、重启腿先 app.relaunch() 再 await 既有清理链、
 *      释放目录锁后才 app.exit(0)、安全模式 env 一行声明生效面；
 *      另钉跨包/跨语言字面量（env 名与页面全局名）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SAFE_MODE_ENV,
  backupChamberOwnedState,
  chamberBackupTargets,
  createDiskBackupIo,
  formatStartupFailureDetail,
  isSafeModeEnabled,
  planStartupRecovery,
  recoveryBackupDir,
  resolveStartupRecoveryAction,
} from '../../startup-error.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const mainSource = readFileSync(path.join(here, '..', '..', 'main.ts'), 'utf8')
const COPY = { exit: '退出', restart: '重启', safeModeRestart: '安全模式重启' }

test('三选恢复：默认项与 Esc 都落安全模式重启（绝不误退出/误普通重启）', () => {
  const plan = planStartupRecovery(COPY, 'startup')
  assert.deepEqual(plan.buttons, ['退出', '重启', '安全模式重启'])
  assert.deepEqual(plan.actions, ['exit', 'restart', 'safe-mode-restart'])
  assert.equal(plan.defaultId, 2, 'Enter 必须落安全项（安全模式重启）')
  assert.equal(plan.cancelId, 2, 'Esc 必须落安全项（安全模式重启）——上游 cancelId=0「Esc=退出」不跟随')
  assert.equal(resolveStartupRecoveryAction(plan, 0), 'exit')
  assert.equal(resolveStartupRecoveryAction(plan, 1), 'restart')
  assert.equal(resolveStartupRecoveryAction(plan, 2), 'safe-mode-restart')
  for (const unknown of [-1, 3, 99]) {
    assert.equal(resolveStartupRecoveryAction(plan, unknown), 'safe-mode-restart',
      '越界/未知响应必须落安全项，绝不静默退出')
  }
})

test('已在运行（锁冲突）：两选，默认与 Esc 都落安全项「重启」而不是退出', () => {
  const plan = planStartupRecovery(COPY, 'already-running')
  assert.deepEqual(plan.buttons, ['退出', '重启'])
  assert.deepEqual(plan.actions, ['exit', 'restart'])
  assert.equal(plan.defaultId, 1)
  assert.equal(plan.cancelId, 1)
  assert.equal(resolveStartupRecoveryAction(plan, 1), 'restart')
  assert.equal(resolveStartupRecoveryAction(plan, 42), 'restart')
})

test('安全模式 env：只有字面量 1 生效（与既有 DSH_CHAMBER_* 开关同契约）', () => {
  assert.equal(isSafeModeEnabled({ [SAFE_MODE_ENV]: '1' }), true)
  for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '2']) {
    assert.equal(isSafeModeEnabled({ [SAFE_MODE_ENV]: value }), false, `env=${String(value)} 不得视为安全模式`)
  }
  assert.equal(isSafeModeEnabled({}), false)
})

test('致命 detail：短错误原样、超长取尾部并带截断标记', () => {
  assert.equal(formatStartupFailureDetail('控制面启动失败：端口占用'), '控制面启动失败：端口占用')
  const long = 'X'.repeat(5000)
  const formatted = formatStartupFailureDetail(long, { limit: 300 })
  assert.ok(formatted.startsWith('[已截断]'))
  assert.ok(formatted.length < 400, '截断必须真的缩短 detail')
  assert.ok(formatted.endsWith('X'.repeat(50)), '截断保留尾部（栈尾信息量更大）')
  const manyLines = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n')
  const tail = formatStartupFailureDetail(manyLines)
  assert.ok(tail.includes('line-12') && tail.includes('line-19'), '只保留最后 8 行')
  assert.ok(!tail.includes('line-11'), '更早的行必须被裁掉')
})

test('备份白名单：只有 chamber 自持文件，绝不包含 dsh profile / 凭据 / runtime 树', () => {
  const targets = chamberBackupTargets()
  const paths = targets.map(target => target.relativePath)
  assert.deepEqual(paths, ['chamber-settings.json', path.join('state', 'dsh-chamber-graph.patch.yml')])
  for (const relative of paths) {
    assert.ok(!relative.includes('dsh-home'), 'dsh profile 的插件配置绝不进备份白名单')
    assert.ok(!relative.includes('profiles'), 'dsh profile 的插件配置绝不进备份白名单')
    assert.ok(!relative.includes('credential'), '凭据文件绝不复制')
    assert.ok(!relative.includes('runtime'), '可重建的 runtime 树绝不复制')
  }
})

/** 内存 IO：记录写入次数，支持注入读写失败。 */
function fakeIo(initial: Record<string, Buffer>, fail?: { read?: string[]; write?: string[] }) {
  const files = new Map(Object.entries(initial))
  const writes: string[] = []
  return {
    files,
    writes,
    io: {
      readSource: (p: string) => {
        if (fail?.read?.includes(p)) throw new Error(`read denied: ${p}`)
        return files.get(p) ?? null
      },
      readBackup: (p: string) => files.get(p) ?? null,
      writeBackup: (p: string, content: Buffer) => {
        if (fail?.write?.includes(p)) throw new Error(`write denied: ${p}`)
        writes.push(p)
        files.set(p, content)
      },
    },
  }
}

test('备份腿：copied → 幂等 identical → 源缺失 absent，且永不上抛', () => {
  const userDataDir = '/tmp/userdata'
  const backupDir = recoveryBackupDir(userDataDir, '2026-01-01T00-00-00-000Z')
  const settings = Buffer.from('{"keepAwake":true}')
  const patch = Buffer.from('insert: []')
  const source = path.join(userDataDir, 'chamber-settings.json')
  const patchSource = path.join(userDataDir, 'state', 'dsh-chamber-graph.patch.yml')
  const fake = fakeIo({ [source]: settings, [patchSource]: patch })

  const first = backupChamberOwnedState({ userDataDir, backupDir, io: fake.io })
  assert.deepEqual(first.map(o => o.status), ['copied', 'copied'])
  assert.equal(fake.writes.length, 2)

  const second = backupChamberOwnedState({ userDataDir, backupDir, io: fake.io })
  assert.deepEqual(second.map(o => o.status), ['identical', 'identical'], '同内容重复执行必须零写（幂等）')
  assert.equal(fake.writes.length, 2)

  const missing = backupChamberOwnedState({
    userDataDir: '/tmp/empty',
    backupDir,
    io: fakeIo({}).io,
  })
  assert.deepEqual(missing.map(o => o.status), ['absent', 'absent'], '源缺失不是错误')
})

test('备份腿失败路径：读失败/写失败逐条 failed、绝不 throw、不阻断其它目标', () => {
  const userDataDir = '/tmp/userdata'
  const backupDir = '/tmp/userdata/recovery-backup/stamp'
  const settingsSource = path.join(userDataDir, 'chamber-settings.json')
  const patchSource = path.join(userDataDir, 'state', 'dsh-chamber-graph.patch.yml')
  const settingsBackup = path.join(backupDir, 'chamber-settings.json')
  const io = fakeIo(
    { [settingsSource]: Buffer.from('settings'), [patchSource]: Buffer.from('patch') },
    { write: [settingsBackup] },
  ).io
  const outcomes = backupChamberOwnedState({ userDataDir, backupDir, io })
  assert.deepEqual(outcomes.map(o => o.status), ['failed', 'copied'],
    '单目标写失败必须只记 failed，后续目标照常备份')
  assert.match(outcomes[0].error ?? '', /write denied/)
  assert.equal(outcomes[1].status, 'copied')
})

test('备份腿：目标清单可注入（用例回归面）+ 实盘 IO 缺失目标返回 absent', () => {
  const fake = fakeIo({})
  const outcomes = backupChamberOwnedState({
    userDataDir: '/tmp/none',
    backupDir: '/tmp/none/backup',
    io: fake.io,
    targets: [{ id: 'only', relativePath: 'chamber-settings.json' }],
  })
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].id, 'only')
  assert.equal(outcomes[0].status, 'absent')
  assert.equal(typeof createDiskBackupIo().readBackup, 'function')
})

test('main.ts 接线：五条 fatal 路径都走三选恢复框，单键 showErrorBox 已清零', () => {
  const callSites = mainSource.split('reportFatalStartupFailure(').length - 1
  assert.ok(callSites >= 5, `五条致命路径（渲染器反复崩溃/preload 缺失/loadURL 失败/锁冲突/控制面启动失败）都必须走恢复框，实际 ${callSites}`)
  assert.ok(!mainSource.includes('dialog.showErrorBox'), 'main.ts 的致命路径不得再有单键 showErrorBox')
  assert.match(mainSource, /\{ title: copy\.rendererCrashedTitle, detail: copy\.rendererCrashedMessage \},\s*\n\s*'startup',/)
  assert.match(mainSource, /alreadyRunningTitle, detail: chamberLock\.error \},\s*\n\s*'already-running',/)
  assert.match(mainSource, /控制面启动失败：/, '控制面启动失败必须是恢复框的一条路径')
  assert.match(mainSource, /preload 构建产物缺失/)
})

test('main.ts 重启腿：先 relaunch、再 await 既有清理链、释放目录锁后才 app.exit(0)', () => {
  const relaunchStart = mainSource.indexOf('async function relaunchForRecovery')
  assert.ok(relaunchStart > 0, 'relaunchForRecovery 必须存在')
  const body = mainSource.slice(relaunchStart, mainSource.indexOf('function runQuitCleanupChain', relaunchStart))
  const relaunchIndex = body.indexOf('app.relaunch()')
  const cleanupIndex = body.indexOf('await runQuitCleanupChain()')
  const releaseIndex = body.indexOf('chamberLockHandle?.release()')
  const exitIndex = body.indexOf('app.exit(0)')
  assert.ok(relaunchIndex > 0 && cleanupIndex > relaunchIndex, 'app.relaunch() 必须先排队（清理腿超时也不丢重启）')
  assert.ok(releaseIndex > cleanupIndex, '目录锁必须在清理链之后显式释放')
  assert.ok(exitIndex > releaseIndex, '释放目录锁之后才 app.exit(0)——绝不在锁未释放时退出重启')
  assert.match(body, /backupChamberStateForRecovery/, '安全模式重启必须先备份 chamber 自持文件')
  assert.match(body, /process\.env\[SAFE_MODE_ENV\] = '1'/, '安全模式重启必须把 env 交给新实例')
})

test('main.ts：既有清理链单飞（will-quit 与恢复重启共享同一 promise）', () => {
  assert.match(mainSource, /function runQuitCleanupChain\(\): Promise<void> \{/)
  assert.match(mainSource, /if \(quitCleanupPromise !== null\) return quitCleanupPromise/)
  assert.match(mainSource, /void runQuitCleanupChain\(\)\.finally\(\(\) => \{\s*\n\s*app\.quit\(\);\s*\n\s*\}\)/)
  assert.match(mainSource, /applyStartupRecoveryAction\(response === null \? 'exit' : resolveStartupRecoveryAction\(plan, response\)\)/,
    '对话框失败必须 fail-closed 按退出处理')
})

test('main.ts 安全模式声明行 + 显式传给控制面', () => {
  assert.match(mainSource, /console\.log\(\`\[dsh-chamber\] 安全模式生效（\${SAFE_MODE_ENV}=1）/)
  assert.match(mainSource, /const safeModeActive = isSafeModeEnabled\(process\.env\)/)
  assert.match(mainSource, /safeMode: safeModeActive,/, '控制面必须收到装配期快照')
})

// 待取件（P2-1 Swift 半边）：跨包/跨语言字面量锁步（env 名与页面全局名 × 控制面 /
// 渲染端 / Swift AppDelegate / bridge-shim 四处一致）随 Swift 恢复框同批落地——
// 目前 Swift 壳尚未声明 DSH_CHAMBER_SAFE_MODE，该断言会在那一批恢复。
