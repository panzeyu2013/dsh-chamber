/**
 * 启动/致命失败面的纯决策（上游 apps/desktop/src/fatal-recovery.ts 的等价物）：
 * 三选恢复框（退出 / 重启 / 安全模式重启）的按钮布局与响应映射、安全模式 env
 * （DSH_CHAMBER_SAFE_MODE）读取，以及「只备份 chamber 自持文件」的计划与执行。
 *
 * 本模块零 electron import：main.ts 只做「弹框 → 既有退出清理链 → relaunch」的
 * 接线，决策与备份语义在此直测。上游的 disableAllPlugins/sanitizeProfile 不在
 * 此实现——离线摘 dsh profile 插件属插件写面（C 分层冲突），替代动作 = 安全模式
 * 重启 + chamber 自持状态备份（理由与替代动作登记在
 * docs/progress/swift-vs-upstream-differences.md §6.4）。
 *
 * 按键纪律（S-43，上游 fatal-recovery 的 defaultId=1/cancelId=0 不跟随）：
 * **默认项与 Esc 都落安全项**——致命启动失败时安全项 = 安全模式重启，已在运行
 * 时安全项 = 重启；两者都不误退出（上游 Esc = 退出）、都不把用户丢进必再次
 * 崩溃的普通重启。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 安全模式 env 名（Electron / Swift / 控制面 / 渲染端共用同一字面量）。 */
export const SAFE_MODE_ENV = 'DSH_CHAMBER_SAFE_MODE'

/**
 * 安全模式是否生效（只认 '1'，与其他 DSH_CHAMBER_* 开关同款显式契约）。
 * @param env - 进程环境（或测试注入的等价映射）。
 * @returns true = 本次启动按安全模式运行。
 */
export function isSafeModeEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[SAFE_MODE_ENV] === '1'
}

/** 恢复动作：退出 / 普通重启 / 安全模式重启。 */
export type StartupRecoveryAction = 'exit' | 'restart' | 'safe-mode-restart'

/** 启动失败的种类：致命启动失败 vs 已有实例占住（锁冲突）。 */
export type StartupFailureKind = 'startup' | 'already-running'

/** 恢复框按钮文案（由调用方从 shell-locale 字典注入，保持本地化单源）。 */
export interface StartupRecoveryCopy {
  readonly exit: string
  readonly restart: string
  readonly safeModeRestart: string
}

/** 恢复框的按钮布局：labels/actions 同序，defaultId/cancelId 都指安全项。 */
export interface StartupRecoveryPlan {
  readonly buttons: readonly string[]
  readonly actions: readonly StartupRecoveryAction[]
  readonly defaultId: number
  readonly cancelId: number
}

/**
 * 计划恢复框按钮。
 * - `startup`：退出 / 重启 / 安全模式重启，默认与取消（Esc）= 安全模式重启；
 * - `already-running`：退出 / 重启（安全模式救不了锁冲突），默认与取消 = 重启。
 * @param copy - 本地化按钮文案。
 * @param kind - 失败种类。
 * @returns 按钮布局与响应映射。
 */
export function planStartupRecovery(copy: StartupRecoveryCopy, kind: StartupFailureKind): StartupRecoveryPlan {
  if (kind === 'already-running') {
    return {
      buttons: [copy.exit, copy.restart],
      actions: ['exit', 'restart'],
      defaultId: 1,
      cancelId: 1,
    }
  }
  return {
    buttons: [copy.exit, copy.restart, copy.safeModeRestart],
    actions: ['exit', 'restart', 'safe-mode-restart'],
    defaultId: 2,
    cancelId: 2,
  }
}

/**
 * 把对话框响应映射为动作；越界/未知响应（含对话框被系统取消）落安全项。
 * @param plan - {@link planStartupRecovery} 的结果。
 * @param response - Electron showMessageBoxSync 的按钮下标。
 * @returns 要执行的恢复动作。
 */
export function resolveStartupRecoveryAction(plan: StartupRecoveryPlan, response: number): StartupRecoveryAction {
  return plan.actions[response] ?? plan.actions[plan.cancelId] ?? 'exit'
}

/** 启动失败 detail 的格式化选项。 */
export interface StartupFailureDetailOptions {
  /** 整段 detail 上限（含截断标记），默认 1200 字符（与上游 dialogDetail 同预算）。 */
  readonly limit?: number
  /** 截断标记（本地化文案；默认中文）。 */
  readonly truncatedLabel?: string
}

/**
 * 致命启动失败 detail：保留最后 8 行、按字符预算尾部截断（上游 dialogDetail
 * 的等价物；首行摘要常被超长堆栈淹没，故取尾部而不是头部）。
 * @param error - 完整错误文案。
 * @param options - 预算与截断标记。
 * @returns 可直接进对话框 detail 的文本。
 */
export function formatStartupFailureDetail(error: string, options: StartupFailureDetailOptions = {}): string {
  const limit = options.limit ?? 1200
  const truncatedLabel = options.truncatedLabel ?? '[已截断]'
  const tail = error.split(/\r\n|[\n\r\u2028\u2029]/u).slice(-8).join('\n')
  const budget = Math.max(0, limit - truncatedLabel.length - 1)
  const shortened = tail.slice(-budget).replace(/^[\uDC00-\uDFFF]/u, '')
  return shortened === error ? error : `${truncatedLabel}\n${shortened}`
}

/** 一个 chamber 自持备份目标：id 用于日志，relativePath 相对 <userData>。 */
export interface ChamberBackupTarget {
  readonly id: string
  readonly relativePath: string
}

/**
 * 允许备份的 chamber 自持文件白名单——**只**列 <userData> 下 chamber 自己写的
 * 状态。dsh profile（<userData>/state/dsh-home/profiles/web/**）的插件配置、
 * 凭据绑定文件与 runtime 树一律不在表内：前者是 dsh/profile 写面（C 分层冲突，
 * 备份也不改写它），后两者属秘密与可重建大对象，复制只会制造新的泄露面。
 * @returns 目标清单（顺序 = 备份顺序）。
 */
export function chamberBackupTargets(): readonly ChamberBackupTarget[] {
  return [
    { id: 'chamber-settings', relativePath: 'chamber-settings.json' },
    { id: 'host-graph-patch', relativePath: join('state', 'dsh-chamber-graph.patch.yml') },
  ]
}

/**
 * 本次恢复备份的落点：<userData>/recovery-backup/<stamp>/<relativePath>。
 * 时间戳作目录名使重复进入安全模式不覆盖上一轮快照；同一 stamp 内重复执行
 * 由内容比对收敛为 identical（幂等）。
 * @param userDataDir - 用户数据根。
 * @param stamp - 调用方给定的时间戳（测试注入；生产用 ISO 串）。
 * @returns 备份根目录。
 */
export function recoveryBackupDir(userDataDir: string, stamp: string): string {
  return join(userDataDir, 'recovery-backup', stamp)
}

/** 备份 IO 注入面（生产用 node:fs 实现；用例注入内存假件）。 */
export interface ChamberBackupIo {
  /** 读源文件；不存在返回 null（绝不因读取失败而中断恢复）。 */
  readSource(path: string): Buffer | null
  /** 读既有备份；不存在返回 null。 */
  readBackup(path: string): Buffer | null
  /** 写备份（含建父目录）；失败抛。 */
  writeBackup(path: string, content: Buffer): void
}

/** 单个目标的结果状态。 */
export type ChamberBackupStatus = 'copied' | 'identical' | 'absent' | 'failed'

/** 单个目标的结果（备份腿永远不 throw，失败逐条记账）。 */
export interface ChamberBackupOutcome {
  readonly id: string
  readonly source: string
  readonly destination: string
  readonly status: ChamberBackupStatus
  readonly error?: string
}

/** {@link backupChamberOwnedState} 的输入。 */
export interface ChamberBackupInput {
  readonly userDataDir: string
  readonly backupDir: string
  readonly io: ChamberBackupIo
  /** 覆盖白名单（测试用；生产省略 = {@link chamberBackupTargets}）。 */
  readonly targets?: readonly ChamberBackupTarget[]
}

/**
 * 备份 chamber 自持文件：源缺失 = absent（无事可做，不是错误）、备份已存在且
 * 逐字节相同 = identical（幂等，第二次进入安全模式零写）、否则复制 = copied；
 * 任何单个目标的读写失败记 failed 并继续下一个——恢复动作绝不因备份而中断。
 * @param input - 目录、IO 与（可选）目标覆盖。
 * @returns 逐目标结果（顺序 = 目标顺序）。
 */
export function backupChamberOwnedState(input: ChamberBackupInput): readonly ChamberBackupOutcome[] {
  const targets = input.targets ?? chamberBackupTargets()
  const outcomes: ChamberBackupOutcome[] = []
  for (const target of targets) {
    const source = join(input.userDataDir, target.relativePath)
    const destination = join(input.backupDir, target.relativePath)
    let content: Buffer | null
    try {
      content = input.io.readSource(source)
    } catch (error) {
      outcomes.push({ ...target, source, destination, status: 'failed', error: describeBackupError(error) })
      continue
    }
    if (content === null) {
      outcomes.push({ id: target.id, source, destination, status: 'absent' })
      continue
    }
    let existing: Buffer | null
    try {
      existing = input.io.readBackup(destination)
    } catch (error) {
      outcomes.push({ id: target.id, source, destination, status: 'failed', error: describeBackupError(error) })
      continue
    }
    if (existing !== null && existing.equals(content)) {
      outcomes.push({ id: target.id, source, destination, status: 'identical' })
      continue
    }
    try {
      input.io.writeBackup(destination, content)
      outcomes.push({ id: target.id, source, destination, status: 'copied' })
    } catch (error) {
      outcomes.push({ id: target.id, source, destination, status: 'failed', error: describeBackupError(error) })
    }
  }
  return outcomes
}

/** node:fs 实盘 IO：读缺失/不可读一律 null，写失败上抛（由调用方记 failed）。 */
export function createDiskBackupIo(): ChamberBackupIo {
  return {
    readSource(path) {
      try {
        return readFileSync(path)
      } catch {
        return null
      }
    },
    readBackup(path) {
      try {
        return readFileSync(path)
      } catch {
        return null
      }
    },
    writeBackup(path, content) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(path, content, { mode: 0o600 })
    },
  }
}

/** {@link backupChamberStateForRecovery} 的输入。 */
export interface ChamberRecoveryBackupInput {
  readonly userDataDir: string
  readonly stamp: string
  /** 测试注入；生产省略 = {@link createDiskBackupIo}。 */
  readonly io?: ChamberBackupIo
}

/**
 * 安全模式重启前的备份编排：<userData>/recovery-backup/<stamp>/…。
 * @param input - userData 根、时间戳与（可选）IO。
 * @returns 逐目标结果，交给调用方 loud 记录。
 */
export function backupChamberStateForRecovery(input: ChamberRecoveryBackupInput): readonly ChamberBackupOutcome[] {
  return backupChamberOwnedState({
    userDataDir: input.userDataDir,
    backupDir: recoveryBackupDir(input.userDataDir, input.stamp),
    io: input.io ?? createDiskBackupIo(),
  })
}

/** 错误文案归一（备份腿自己的失败面，不 import main.ts 的 sanitize 面）。 */
function describeBackupError(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}
