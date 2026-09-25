/**
 * protected-plugins.ts — 受保护集合 P 的派生与读面行投影。
 *
 * 单一来源：本模块是「哪些名字属于受保护组合 / 每个已安装行是什么角色」的唯一实现。
 * desktop 经 facade 双路径消费，gateway 直引；渲染端不镜像。用户插件写面
 * （install/remove/materialize）已随 2026-09 C 分层退役，本模块只保留读面事实。
 *
 * 规则要点：
 * - P = B₀ ∪ S ∪ F：B₀ = profile 安装自带组合（模板默认快照，不含用户后加的层）、
 *   S = chamber 播种注册表名、F = 运行时线族（运行时锁文件闭包优先，实例树枚举兜底；
 *   官方 opt-in 只许登记白名单内的名字——运行时根包自己声明的 opt-in 依赖属于 F，
 *   未登记的 experimental 名字仍是「取错来源/上游新提升」的信号，见 runtime-family.ts）。
 * - F 不可得 ⇒ 读面退到 B₀ ∪ S 的降级阶梯（gateway/desktop 各自实现），
 *   `deriveProtectedSet` 对三分量全空仍 fail-closed，绝不退化成"没有保护"。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import {
  isMaterializedValue,
  readManifestVersion,
} from '@dsh-chamber/dsh-chamber-wire/plugin-manifest'
import type { PluginRow, PluginRowRole } from '@dsh-chamber/dsh-chamber-wire/plugin-row'

// 运行时线族锚（F）、禁名/opt-in 白名单判据与锁文件名字解析的唯一实现都在 leaf 模块
// runtime-family.ts：本模块还会引入 wire 的 manifest 读算法（打包态裸 workspace 包名
// 无法解析，已装清单的版本判据必须从单源读取），故原样 re-export。
import {
  familyNamesFromLockfileClosure,
  runtimeFamilyNameFindings,
} from './runtime-family.ts'
export {
  RUNTIME_FAMILY_CORE,
  RUNTIME_FAMILY_FORBIDDEN,
  RUNTIME_FAMILY_OPT_IN_ALLOWED,
  RUNTIME_FAMILY_OPT_IN_PATTERN,
  familyNamesFromLockfileClosure,
} from './runtime-family.ts'

/**
 * 闭包是否可信（核心锚齐全 + 无 dev/test 与源码线段 + 官方 opt-in 全在登记白名单内）。
 * 运行时与 C11 门禁共用 leaf 模块 runtime-family.ts 的同一判据：不可信 ⇒
 * `resolveRuntimeFamily` 拒绝该来源（继续找下一个候选），绝不静默把它当 F。
 */
export function runtimeFamilyFindings(names: readonly string[]): string[] {
  return runtimeFamilyNameFindings(names).map((finding) => (
    finding.kind === 'missing-core'
      ? `runtime family closure is missing the core anchor ${finding.name}`
      : `${finding.name}: ${finding.label} (${finding.why})`
  ))
}

/** 官方 scope（运行时线族与受保护名字的域）。 */
export const OFFICIAL_SCOPE = '@deepseek-ai/'

/** chamber scope（播种物与 chamber 自建包的域）。**不参与任何判定**：受保护集合按事实
 *  派生（B₀ ∪ S ∪ F）；保留该常量只为表述包的归属，别拿它当门。 */
export const CHAMBER_SCOPE = '@dsh-chamber/'

/**
 * B₀ 快照：web profile 的安装自带组合（上游模板的对拍对象）。不得从 live
 * `dsh.profile.bundles` 取——那是按已安装状态重算的结果，会把用户后加的层也变成受保护项。
 */
export const PROFILE_BUNDLES_SNAPSHOT: readonly string[] = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
]

/** 受保护来源（用于文案与 tooltip；同一名字可能同时命中多个来源，取最先命中的）。 */
export type ProtectedSource = 'installation' | 'chamber' | 'family'

// 读面行形状（PluginRow / PluginRowRole）的唯一声明在 wire 的 ./plugin-row 面；本文件只有
// import/type 再导出、无本地字段重声明，名字原样再导出。
export type { PluginRow, PluginRowRole }

/** 派生后的受保护集合。 */
export interface ProtectedSet {
  readonly names: ReadonlySet<string>
  readonly sources: ReadonlyMap<string, ProtectedSource>
}

/** P 的三个输入分量（缺一不可派生；F 允许显式缺席 = ssh 形态）。 */
export interface ProtectedFacts {
  /** B₀：安装自带组合（默认取 PROFILE_BUNDLES_SNAPSHOT）。 */
  installationBundles?: readonly string[]
  /** S：chamber 播种注册表名。 */
  seedNames: readonly string[]
  /** F：运行时线族名集合；null = 该后端没有族事实源（ssh）。 */
  familyNames: readonly string[] | null
}

/** 派生结果：ok=false 时调用方走降级阶梯，绝不把空集当成"没有保护"。 */
export type ProtectedDerivation =
  | { ok: true; set: ProtectedSet }
  | { ok: false; reason: string }

/**
 * 派生受保护集合。`familyNames === null` 表示该后端没有族事实源（ssh）——仍返回 `ok:true`
 * 但只覆盖 B₀ ∪ S：读面的 `protected` 行标志与各自后端的降级阶梯据此判定，绝不退化成
 * "没有保护"的静默通过。
 */
export function deriveProtectedSet(facts: ProtectedFacts): ProtectedDerivation {
  const names = new Map<string, ProtectedSource>()
  for (const name of facts.installationBundles ?? PROFILE_BUNDLES_SNAPSHOT) {
    if (typeof name !== 'string' || name === '') return { ok: false, reason: 'installation bundle list contains a non-string/empty name' }
    if (!names.has(name)) names.set(name, 'installation')
  }
  for (const name of facts.seedNames) {
    if (typeof name !== 'string' || name === '') return { ok: false, reason: 'seed registry resolved to a non-string/empty name' }
    if (!names.has(name)) names.set(name, 'chamber')
  }
  if (facts.familyNames !== null) {
    if (facts.familyNames.length === 0) return { ok: false, reason: 'runtime family resolved to an empty name set' }
    for (const name of facts.familyNames) {
      if (typeof name !== 'string' || name === '') return { ok: false, reason: 'runtime family contains a non-string/empty name' }
      if (!names.has(name)) names.set(name, 'family')
    }
  }
  // The set must never be EMPTY: an all-empty input (installationBundles: [], seedNames: [],
  // familyNames: null) must not answer ok:true with zero names — the read face would then mark
  // every row unprotected. A caller reading bundles from a profile can reach this, and the
  // failure mode is silent loss of protection — fail closed instead.
  if (names.size === 0) {
    return { ok: false, reason: 'protected set derived empty (installation/seed/family facts all empty)' }
  }
  return {
    ok: true,
    set: {
      names: new Set(names.keys()),
      sources: names,
    },
  }
}

/** 名字的受保护来源；不在 P 内返回 null。 */
export function protectedReason(set: ProtectedSet, name: string): ProtectedSource | null {
  return set.sources.get(name) ?? null
}

// 事实源：运行时线族集合

/**
 * 运行时线为某个名字提供的版本集合（`resolveRuntimeFamily` 的事实输出）。
 *
 * 键缺席或空数组 = 该来源没给出版本（绝不猜）；锁文件可能同时 pin 同一名字的多个版本，
 * 故是集合而非单值。名字与版本两个解析器对同一批键必须互相一致：版本一个都解析不出时
 * `resolveRuntimeFamily` 拒绝该来源（parserDisagreement 判据）。
 */
export type FamilyVersions = ReadonlyMap<string, readonly string[]>

/** 安全的包名字面量（闭包遍历用；`readInstalledVersion` 共用同一判据）。 */
const SAFE_PACKAGE_NAME = /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** 运行时线族集合的解析结果（`lockfilePath` 是实际采用的锁文件，证据用）。 */
export type RuntimeFamilyResolution =
  | {
    ok: true
    names: readonly string[]
    /** 每个族名字由运行时线提供的版本集合；键缺席 = 该来源没有版本事实。 */
    versions: FamilyVersions
    /** pinned-lockfile = 已提交的运行时线锚（首选）；lockfile-closure = 活动树的锁文件；
     *  runtime-tree = 无锁文件时的树枚举兜底。 */
    source: 'pinned-lockfile' | 'lockfile-closure' | 'runtime-tree'
    lockfilePath: string | null
    /** 树枚举原始结果（证据字段：锁文件命中时为 null —— 懒枚举，不白读目录；
     *  真正用树作来源时它等于 names）。调用方只用它做日志/诊断。 */
    treeNames: readonly string[] | null
  }
  | { ok: false; reason: string }

// familyNamesFromLockfileClosure 的实现在 leaf 模块 runtime-family.ts；本文件经上面的 re-export 读同一份。

/**
 * 同一个锁文件的版本事实：族名字 → 被 pin 的版本集合。名字抽取刻意与
 * familyNamesFromLockfileClosure 分离（后者是 C11 门禁与 P 的唯一权威，逐字不变），键形兼容
 * pnpm v9/v6。不在版本后锚定 ' / :：pnpm 的 snapshot 键会把 peer 解析结果缀在版本后（可嵌套），
 * 因此版本用严格字符集截断（数字开头，遇 ' / : / 空白 / ( 即停）。
 */
export function familyVersionsFromLockfileClosure(lockfileText: string): Map<string, string[]> {
  const versions = new Map<string, string[]>()
  const add = (name: string, version: string): void => {
    const list = versions.get(name)
    if (list === undefined) versions.set(name, [version])
    else if (!list.includes(version)) list.push(version)
  }
  const v9 = /^ {2}'?(@deepseek-ai\/[a-z0-9._-]+)@([0-9][^':\s()]*)/gm
  const v6 = /^ {2}\/(@deepseek-ai\/[a-z0-9._-]+)\/([0-9][^':\s()]*)/gm
  for (const re of [v9, v6]) {
    for (const match of lockfileText.matchAll(re)) add(match[1], match[2])
  }
  for (const list of versions.values()) list.sort()
  return versions
}

/**
 * 树枚举的名字 + 版本事实：目录名给名字，各包 package.json 给版本（读不到就不登记该名字的
 * 版本）。树是锁文件缺席时的兜底来源，只有这条路径额外花读清单的成本。
 */
function familyFactsFromRuntimeTree(workspacePath: string): { names: string[]; versions: Map<string, string[]> } | null {
  const dir = join(workspacePath, 'node_modules', '@deepseek-ai')
  if (!existsSync(dir)) return null
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const names: string[] = []
  const versions = new Map<string, string[]>()
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const name = `${OFFICIAL_SCOPE}${entry.name}`
    names.push(name)
    const manifest = readPackageManifest(join(dir, entry.name, 'package.json'))
    const version = manifest?.version
    if (typeof version === 'string' && version !== '') versions.set(name, [version])
  }
  return { names: names.sort(), versions }
}

/** 读一个包的 `package.json`（只读、容错；任何失败都返回 null）。 */
function readPackageManifest(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 解析运行时线族集合（事实源优先级）：
 * 1. 已提交的运行时线锚锁文件——唯一权威、平台无关，且正是 C11 门禁断言的文件；必须先试它，
 *    因为 dev 形态的活动树可能是源码线（ref-dsh），其闭包含 opt-in 段；
 * 2. 活动树自己的 pnpm-lock.yaml；
 * 3. 无锁文件时退回 node_modules/@deepseek-ai/* 枚举（平台相关，仅兜底）。
 *
 * 锁文件"存在即权威"：不做"名字太少就换来源"的启发式，空集交给 deriveProtectedSet 判为派生失败。
 */
export function resolveRuntimeFamily(
  workspacePath: string,
  opts: { pinnedLockfilePath?: string | null } = {},
): RuntimeFamilyResolution {
  const pinned = opts.pinnedLockfilePath ?? null
  const candidates: Array<{ path: string; source: 'pinned-lockfile' | 'lockfile-closure' }> = []
  if (pinned !== null) candidates.push({ path: pinned, source: 'pinned-lockfile' })
  candidates.push({ path: join(workspacePath, 'pnpm-lock.yaml'), source: 'lockfile-closure' })
  const rejected: string[] = []
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue
    try {
      const lockfileText = readFileSync(candidate.path, 'utf8')
      const names = familyNamesFromLockfileClosure(lockfileText)
      const versions = familyVersionsFromLockfileClosure(lockfileText)
      // 可信性判据（与 C11 同源）：核心锚缺失或含禁名 ⇒ 这个闭包**不是**运行时线的 F
      // （源码线/裁剪树/外来锁文件），拒绝它并继续找；全被拒则 ok:false（保守降级）。
      const findings = runtimeFamilyFindings(names)
      // 第二条判据：名字解析得出来但版本一个都解析不出来 ⇒ 两个解析器对同一批键互相矛盾，
      // 放行就意味着 F 里每个名字都缺版本事实；宁可拒绝该来源、让树兜底。
      const parserDisagreement = names.length > 0 && versions.size === 0
      if (findings.length > 0) {
        rejected.push(`${candidate.path}: ${findings.join('; ')}`)
      } else if (parserDisagreement) {
        rejected.push(`${candidate.path}: the closure yielded ${names.length} names but no parseable versions (the name and version parsers disagree about the same keys)`)
      } else {
        return {
          ok: true,
          names,
          versions,
          source: candidate.source,
          lockfilePath: candidate.path,
          treeNames: null,
        }
      }
    } catch {
      /* 读失败（EACCES/损坏）→ 下一个候选 */
    }
  }
  // 只有在没有可用锁文件时才枚举实例树（每次 IPC 都 readdir 不值得）；树同样过可信性判据。
  // 树来源刻意不要求版本事实：枚举目录名本身就是这条兜底路径的用途，而清单读不出的名字会
  // 版本事实——方向是"响亮误报"而非静默放行。在这里拒绝反而会把用户挡在门外。
  const tree = familyFactsFromRuntimeTree(workspacePath)
  if (tree !== null && tree.names.length > 0) {
    const findings = runtimeFamilyFindings(tree.names)
    if (findings.length === 0) {
      return {
        ok: true,
        names: tree.names,
        versions: tree.versions,
        source: 'runtime-tree',
        lockfilePath: null,
        treeNames: tree.names,
      }
    }
    rejected.push(`${workspacePath}/node_modules/@deepseek-ai: ${findings.join('; ')}`)
  }
  return {
    ok: false,
    reason: rejected.length > 0
      ? `no trustworthy runtime family facts (${rejected.join(' | ')})`
      : `no runtime family facts under ${workspacePath} (neither a usable pnpm-lock.yaml nor node_modules/@deepseek-ai)`,
  }
}

// 读面行投影

/**
 * 掩码与 materialize 判据的单一来源 = 中立契约包
 * `@dsh-chamber/dsh-chamber-wire/plugin-manifest`。本模块不重声明常量与路径文法：判据从单源
 * 导入，掩码常量经本模块公开面透传（desktop 经 facade 消费；打包态由 esbuild bundle 内联 wire）。
 */
export { PLUGIN_MATERIALIZED_VALUE_MASK } from '@dsh-chamber/dsh-chamber-wire/plugin-manifest'

export interface DerivePluginRowsInput {
  /** profile 声明的依赖（name → spec/value；各后端已按自己的掩码纪律处理过）。
   *  **唯一行源**：一行 = 一条依赖（见 derivePluginRows）。 */
  dependencies: Record<string, string>
  /** live `dsh.profile.bundles`（**分类器**：role = layer；不参与保护判定，也不作行源）。 */
  bundles: readonly string[]
  /**
   * 派生好的受保护集合；null = 派生失败：行仍按事实投影（role 照算，`protected` 全 false），
   * 读面不因缺 F 而静默扩大或收窄保护面。
   */
  protectedSet: ProtectedSet | null
  /** S：播种注册表名（**分类器**：role = seed；不作行源）。 */
  seedNames?: readonly string[]
  /** B₀（默认快照）；分类器：区分 composition / layer。 */
  installationBundles?: readonly string[]
  /** 已装版本读取（可选；按 name 返回版本或 null）。 */
  installedVersion?: (name: string) => string | null
  /**
   * 可选：依赖值 → 投影值的掩码钩子。缺省 = 原值——行投影的 `spec` 必须与调用方自己的
   * `dependencies` 掩码一致：gateway 与 ssh 的 manifest 都掩 `file:` 值，local 的原样清单不掩。
   */
  maskSpec?: (spec: string) => string | null
}

/**
 * 把 profile 的依赖表投影成「已安装」行。
 *
 * 行集 = dependencies 一行一条，仅此：bundles / B₀ / S 只做 role 分类器与保护判定输入，
 * 不作行源。并集会让「安装自带」的东西出现在「已安装」里——官方组合是运行时基线、chamber
 * 播种物在「chamber 受管组件」表里已有自己的行。上游 reconcilePlugins 也只把依赖表里的包并入
 * `dsh.profile.bundles`。裸依赖表还会带出自相矛盾的行（组合成员在 profiles/web/node_modules
 * 里不存在，版本列只能显示 —）。保护判定不受影响：受保护名若出现在依赖表里照样只读可见。
 */
export function derivePluginRows(input: DerivePluginRowsInput): PluginRow[] {
  const installation = new Set(input.installationBundles ?? PROFILE_BUNDLES_SNAPSHOT)
  const bundles = new Set(input.bundles)
  const seeds = new Set(input.seedNames ?? [])
  const protectedNames = input.protectedSet?.names ?? new Set<string>()
  const versionOf = input.installedVersion ?? (() => null)
  const rows: PluginRow[] = []

  const roleOf = (name: string, spec: string | null): PluginRowRole => {
    if (seeds.has(name)) return 'seed'
    if (installation.has(name)) return 'composition'
    if (bundles.has(name)) return 'layer'
    if (spec !== null && isMaterializedValue(spec)) return 'materialized'
    return 'third-party'
  }
  // 掩码（design 21 §6.2/§6.11.5）：`rows[].spec` 与调用方的 `dependencies` 投影必须用同一
  // 条规则（后端各传自己的 maskSpec；缺省原值 = local 原样清单的语义）。role 恒按**原值**分类。
  const mask = input.maskSpec ?? ((spec: string): string | null => spec)
  for (const [name, spec] of Object.entries(input.dependencies)) {
    rows.push({
      name,
      spec: mask(spec),
      version: versionOf(name),
      role: roleOf(name, spec),
      protected: protectedNames.has(name),
    })
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return rows
}

/**
 * 从已装清单读一个包的版本（name 必须已过白名单）。null = 读不到（未装/无清单/读失败）——
 * 投影里就是 `version: null`，绝不让它成为判据。
 */
export function readInstalledVersion(profileDir: string, name: string): string | null {
  if (!SAFE_PACKAGE_NAME.test(name)) return null
  const manifestPath = join(profileDir, 'node_modules', name, 'package.json')
  if (!existsSync(manifestPath)) return null
  try {
    // 版本判据的单一来源 = wire plugin-manifest readManifestVersion（非空字符串
    // 才算版本；非对象/数组/缺失一律 null，绝不给猜测值）。
    return readManifestVersion(JSON.parse(readFileSync(manifestPath, 'utf8')))
  } catch {
    return null
  }
}
