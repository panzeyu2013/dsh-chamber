/**
 * update-journal.ts — 可选更新取证日志（上游 apps/desktop/src/update-journal.ts 的镜像）。
 *
 * 启停：仅当 env `DSH_DESKTOP_UPDATE_JOURNAL_DIR`（绝对路径）设置时启用；未设置 = 零开销。
 * 内容白名单：只写 phase / 目标版本 / 整数进度 / 固定错误码，**绝不写 raw 诊断或请求数据**
 * （与上游 desktopUpdateJournalState 同口径）。每行 JSONL 逐条 flush（appendFileSync），
 * 跨重启可取证。写入失败只 loud 一次并自禁用，绝不把取证变成更新链的故障源。
 *
 * 两个 flavor 共用：Electron 的 updater.ts 与 Swift flavor 的 update-headless.ts 都调
 * createUpdateJournal(...)（同一环境变量、同一白名单）。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
/**
 * journal 投影所需的更新状态子集（结构化声明，故本模块是叶子：不 import
 * updater.ts 的 UpdateState，避免 update-journal ↔ updater 的类型环）。
 * updater.ts 的 UpdateState 结构上兼容本类型，测试也可直接构造。
 */
export interface UpdateJournalState {
  phase: string
  latestVersion: string | null
  downloadPercent: number | null
  error: string | null
}

/** 上游同款固定错误码集合：只有命中者进日志，其余落 UNCLASSIFIED。 */
export const UPDATE_JOURNAL_ERROR_CODES = [
  'ETIMEDOUT',
  'ENOSPC',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_UPDATER_INVALID_SIGNATURE',
  'ERR_UPDATER_CHECKSUM_MISMATCH',
] as const

/** 环境变量名（与上游逐字相同）。 */
export const UPDATE_JOURNAL_DIR_ENV = 'DSH_DESKTOP_UPDATE_JOURNAL_DIR'

/**
 * 解析取证目录：未设置 = null（关闭）；非绝对路径 = null + 说明（绝不猜相对路径）。
 * @param env - 进程环境（默认 process.env；测试注入）。
 * @returns { dir, problem }。
 */
export function resolveUpdateJournalDir(env: Record<string, string | undefined>): {
  dir: string | null
  problem: string | null
} {
  const raw = env[UPDATE_JOURNAL_DIR_ENV]
  if (raw === undefined || raw === '') return { dir: null, problem: null }
  if (!isAbsolute(raw)) return { dir: null, problem: UPDATE_JOURNAL_DIR_ENV + ' must be an absolute path' }
  return { dir: raw, problem: null }
}

/**
 * 单条状态的白名单投影（结构镜像上游 desktopUpdateJournalState）。
 * @param state - 主进程持有的更新状态。
 * @returns 只含 phase / targetVersion / percent / errorCode 的对象。
 */
export function updateJournalState(state: UpdateJournalState): Record<string, unknown> {
  return {
    phase: state.phase,
    ...(state.latestVersion !== null ? { targetVersion: state.latestVersion } : {}),
    ...(state.phase === 'downloading' && state.downloadPercent !== null
      ? { percent: Math.floor(state.downloadPercent) }
      : {}),
    ...(state.phase === 'error'
      ? {
          errorCode: UPDATE_JOURNAL_ERROR_CODES.find((code) => state.error?.includes(code)) ?? 'UNCLASSIFIED',
        }
      : {}),
  }
}

export interface UpdateJournal {
  readonly path: string
  /** 记录一次状态投影（连续重复不写；写失败 loud 一次后自禁用）。 */
  record(state: UpdateJournalState): void
  /** 进程退出前的收尾（当前实现无缓冲，保留以对齐上游生命周期）。 */
  close(): void
}

export interface UpdateJournalDeps {
  /** 目录（null = 关闭）。 */
  dir: string | null
  /** 已安装版本（写入每条记录的 version 字段）。 */
  version: string
  /** 日志（默认 console）。 */
  logger?: { log(...args: unknown[]): void; warn(...args: unknown[]): void }
}

/**
 * 创建 JSONL 取证器；目录不可写时 loud 一次并返回 null（取证绝不阻断更新链）。
 * @param deps - 目录、版本、logger 注入。
 * @returns journal 或 null。
 */
export function createUpdateJournal(deps: UpdateJournalDeps): UpdateJournal | null {
  if (deps.dir === null) return null
  const logger = deps.logger ?? console
  const path = join(deps.dir, 'update-journal.jsonl')
  let disabled = false
  let previous: string | undefined
  let sequence = 0
  try {
    mkdirSync(deps.dir, { recursive: true })
  } catch (error) {
    logger.warn('[update-journal] 取证目录不可用，取证关闭：', error instanceof Error ? error.message : String(error))
    return null
  }
  logger.log('[update-journal] 更新取证已启用：' + path)
  return {
    path,
    record(state: UpdateJournalState) {
      if (disabled) return
      // 去重按**投影**（不含 seq/时间戳）：连续相同状态不得重复落盘。
      const projection = updateJournalState(state)
      const key = JSON.stringify(projection)
      if (key === previous) return
      previous = key
      const payload = { seq: ++sequence, at: new Date().toISOString(), version: deps.version, ...projection }
      const line = JSON.stringify(payload)
      try {
        appendFileSync(path, line + '\n')
      } catch (error) {
        disabled = true
        logger.warn('[update-journal] 写入失败，取证关闭：', error instanceof Error ? error.message : String(error))
      }
    },
    close() {
      // appendFileSync 已逐条 flush；无缓冲需排空。
    },
  }
}
