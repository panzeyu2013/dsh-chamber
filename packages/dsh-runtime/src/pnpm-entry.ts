/**
 * pnpm 入口解析的单一来源。每个宿主都从一组候选里挑第一个存在的 `pnpm.cjs`：gateway 走
 * bundledDir → explicit package 解析；desktop 走 resourcesPath / moduleDir / legacy packaged
 * 装配位；官方安装器目录（%LOCALAPPDATA% / %APPDATA% / node 安装目录）是最后兜底。路径 join
 * 按 search.platform 选择（而非宿主平台），Windows 形状因此可在任意 CI 腿单测。消费方：
 * gateway/src/pnpm-entry.ts；pnpmEntryCandidates 只供包内测试与后续 desktop 消费，暂不导出。
 */
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/** 一次 pnpm 入口解析的全部形状参数。 */
export interface PnpmEntrySearch {
  /** 目标平台（决定 join/dirname 的斜杠与根形状，未必等于宿主平台）。 */
  platform: NodeJS.Platform
  /** process.execPath —— 其 dirname 是 node 安装目录（npm 全局前缀兜底）。 */
  execPath: string
  /** process.env（Windows 的 LOCALAPPDATA / APPDATA 兜底根）。 */
  env?: NodeJS.ProcessEnv
  /** gateway 形状：bundle 旁挂的 dist 目录（<bundledDir>/pnpm/bin/pnpm.cjs）。 */
  bundledDir?: string | null
  /** desktop 打包形状：Electron process.resourcesPath（<resources>/pnpm/bin/pnpm.cjs）。 */
  resourcesPath?: string | null
  /** desktop dev 形状：模块目录（<moduleDir>/node_modules/pnpm/bin/pnpm.cjs）。 */
  moduleDir?: string | null
  /** desktop 旧装配位：sidecar 目录（<legacyPackagedDir>/pnpm/bin/pnpm.cjs）。 */
  legacyPackagedDir?: string | null
  /** 调用方自行解析的显式入口，按序插在 resourcesPath 之后、dev 形状之前。 */
  explicitEntries?: readonly string[]
}

function pathFor(platform: NodeJS.Platform): typeof win32 {
  return platform === 'win32' ? win32 : posix
}

function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return pathFor(platform).join(...parts)
}

function dirnameFor(platform: NodeJS.Platform, path: string): string {
  return pathFor(platform).dirname(path)
}

function usable(value: string | null | undefined): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * 候选入口，按优先级：bundledDir → resourcesPath → explicitEntries → moduleDir →
 * legacyPackagedDir → LOCALAPPDATA/APPDATA/dirname(execPath) 兜底。
 */
export function pnpmEntryCandidates(search: PnpmEntrySearch): readonly string[] {
  const entries: string[] = []
  if (usable(search.bundledDir)) {
    entries.push(joinFor(search.platform, search.bundledDir, 'pnpm', 'bin', 'pnpm.cjs'))
  }
  if (usable(search.resourcesPath)) {
    entries.push(joinFor(search.platform, search.resourcesPath, 'pnpm', 'bin', 'pnpm.cjs'))
  }
  for (const entry of search.explicitEntries ?? []) {
    if (usable(entry)) entries.push(entry)
  }
  if (usable(search.moduleDir)) {
    entries.push(joinFor(search.platform, search.moduleDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
  }
  if (usable(search.legacyPackagedDir)) {
    entries.push(joinFor(search.platform, search.legacyPackagedDir, 'pnpm', 'bin', 'pnpm.cjs'))
  }
  const roots = [search.env?.LOCALAPPDATA, search.env?.APPDATA, dirnameFor(search.platform, search.execPath)]
  for (const root of roots) {
    if (!usable(root)) continue
    entries.push(joinFor(search.platform, root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
  }
  return entries
}

/**
 * 第一个 existsSync 命中的候选；全部缺失时返回 candidates[0]，让调用方按既有 loud 失败语义
 * 处理（spawn/显式读取时报错，绝不静默回退到别的 pnpm）。
 */
export function resolvePnpmEntry(search: PnpmEntrySearch): string {
  const candidates = pnpmEntryCandidates(search)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0] ?? ''
}
