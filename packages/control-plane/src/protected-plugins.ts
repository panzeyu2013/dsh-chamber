/**
 * protected-plugins.ts — 受保护集合 P 的派生、写面判定与读面行投影。
 *
 * 单一来源：本模块是「哪些名字不能装卸 / 官方 scope 的安装是否同代 / 每个已安装行是什么
 * 角色」的唯一实现。desktop 经 facade 双路径消费，gateway 直引；渲染端不镜像。
 *
 * 规则要点：
 * - P = B₀ ∪ S ∪ F：B₀ = profile 安装自带组合（模板默认快照，不含用户后加的层）、
 *   S = chamber 播种注册表名、F = 运行时线族（运行时锁文件闭包优先，实例树枚举兜底）。
 * - decidePluginMutation：install/remove 同判 P；remove 永不判版本；官方 scope 的 install
 *   另需精确同代（无版本、`^`/`~`/dist-tag 拒；预发布字符串全等）。
 * - profile_absent → defer（保留 first-install 语义，绝不 fail-closed）。
 * - F 不可得 → 保守降级（P 退到 B₀ ∪ S，官方 scope 的 install 一律拒），绝不退化成"没有保护"。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import {
  isMaterializedValue,
  readManifestVersion,
} from '@dsh-chamber/dsh-chamber-wire/plugin-manifest'
import type { PluginRow, PluginRowRole } from '@dsh-chamber/dsh-chamber-wire/plugin-row'
import { errorMessage } from './error-text.ts'
import { MAX_PLUGIN_SPEC_CHARS } from './plugin-spec.ts'

// 运行时线族锚（F）与锁文件名字解析的唯一实现在 leaf 模块 runtime-family.ts：本模块还会
// 引入 wire 的 manifest 读算法（install 前裸 workspace 包名无法解析），故原样 re-export。
import {
  RUNTIME_FAMILY_CORE,
  RUNTIME_FAMILY_FORBIDDEN,
  familyNamesFromLockfileClosure,
} from './runtime-family.ts'
export {
  RUNTIME_FAMILY_CORE,
  RUNTIME_FAMILY_FORBIDDEN,
  familyNamesFromLockfileClosure,
} from './runtime-family.ts'

/**
 * 闭包是否可信（核心锚齐全 + 无禁名）。运行时与 C11 门禁共用同一判据：不可信 ⇒ 调用方走
 * 保守降级（官方 scope 装面全拒），绝不静默把它当 F。
 */
export function runtimeFamilyFindings(names: readonly string[]): string[] {
  const findings: string[] = []
  const set = new Set(names)
  for (const core of RUNTIME_FAMILY_CORE) {
    if (!set.has(core)) findings.push(`runtime family closure is missing the core anchor ${core}`)
  }
  for (const name of names) {
    for (const rule of RUNTIME_FAMILY_FORBIDDEN) {
      if (rule.pattern.test(name)) findings.push(`${name}: ${rule.label} (${rule.why})`)
    }
  }
  return findings
}

/** 官方 scope（代耦合规则的适用面）。 */
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
  /** 本次派生是否**含 F**（false = 只有 B₀ ∪ S：ssh 形态，或该后端读不到族事实的降级态）。
   *  判定入口据此自动走保守形态——调用方忘了传 `familySource` 也不会静默放行官方 scope。 */
  readonly familyComplete: boolean
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

/** 派生结果：ok=false 时写面必须 fail-closed（ssh 走保守降级）。 */
export type ProtectedDerivation =
  | { ok: true; set: ProtectedSet }
  | { ok: false; reason: string }

/**
 * 派生受保护集合。`familyNames === null` 表示该后端没有族事实源（ssh）——仍返回 `ok:true`
 * 但只覆盖 B₀ ∪ S，由 `decidePluginMutation` 的 `familySource:'none'` 分支把官方 scope 的
 * install 一律拒掉（只收紧不放松）。
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
  // familyNames: null) must not answer ok:true with zero names, or decidePluginMutation could
  // allow removing a composition member. A caller reading bundles from a profile can reach
  // this, and the failure mode is silent loss of protection — fail closed instead.
  if (names.size === 0) {
    return { ok: false, reason: 'protected set derived empty (installation/seed/family facts all empty)' }
  }
  return {
    ok: true,
    set: {
      names: new Set(names.keys()),
      sources: names,
      familyComplete: facts.familyNames !== null && facts.familyNames.length > 0,
    },
  }
}

/** 名字的受保护来源；不在 P 内返回 null。 */
export function protectedReason(set: ProtectedSet, name: string): ProtectedSource | null {
  return set.sources.get(name) ?? null
}

/** 是否官方 scope（代耦合规则的适用面）。 */
export function officialScope(name: string): boolean {
  return name.startsWith(OFFICIAL_SCOPE)
}

// 版本语法与代比较

/** 精确版本：`X.Y.Z[-pre][+build]`（无 `^`/`~`/dist-tag/范围）。 */
const EXACT_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export interface ParsedVersion {
  major: string
  minor: string
  patch: string
  /** 预发布串（不含 build），无则 null。 */
  prerelease: string | null
}

/** 解析精确版本；非精确形态返回 null。 */
export function parseExactVersion(value: string | null | undefined): ParsedVersion | null {
  if (typeof value !== 'string') return null
  // NO trim: ` 1.2.3 ` is not an exact version literal, and suggestExactSpec must never hand back a suggestion the whitelist would reject.
  const match = EXACT_VERSION_RE.exec(value)
  if (match === null) return null
  return { major: match[1], minor: match[2], patch: match[3], prerelease: match[4] ?? null }
}

/** 是否精确版本字面量（`^`/`~`/`latest`/`next`/范围一律 false）。 */
export function isExactVersion(value: string | null | undefined): boolean {
  return parseExactVersion(value) !== null
}

/**
 * 同代判定：任一侧带预发布 ⇒ 字符串全等（0.1.5-rc.1 ≠ 0.1.5-rc.2）；两侧都是稳定版 ⇒ 比较
 * major.minor.patch。
 */
export function sameGeneration(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = parseExactVersion(a)
  const right = parseExactVersion(b)
  if (left === null || right === null) return false
  if (left.prerelease !== null || right.prerelease !== null) {
    return left.prerelease === right.prerelease
      && left.major === right.major && left.minor === right.minor && left.patch === right.patch
  }
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch
}

/** 建议 spec（`name@<installedVersion>`）；版本未知时返回 null。 */
export function suggestExactSpec(name: string, runtimeVersion: string | null | undefined): string | null {
  return isExactVersion(runtimeVersion) ? `${name}@${runtimeVersion}` : null
}

// 写面判定

export type PluginMutationOp = 'install' | 'remove'

/** 拒绝码（gateway 400 code；客户端仍须接受旧 `reserved` 码）。 */
export type PluginRefusalCode =
  /** 名字本身不是合法 registry 名（**输入**错误，与"事实缺失"区分；后端在更早的
   *  形状校验里通常已拦下，这里是判定入口自己的守卫）。 */
  | 'invalid-name'
  | 'protected'
  | 'needs-version'
  | 'needs-exact-version'
  | 'generation-mismatch'
  | 'protected-set-unavailable'
  | 'runtime-version-unknown'

export type PluginMutationDecision =
  | { kind: 'allow' }
  /** profile 未初始化：沿用既有 deferred 语义（首次安装靠它创建 profile）。 */
  | { kind: 'defer'; code: 'profile_absent'; error: string }
  | { kind: 'refuse'; code: PluginRefusalCode; error: string; suggest?: string }

export interface DecidePluginMutationInput {
  op: PluginMutationOp
  name: string
  /** 声明/清单里的版本字面量（install 才有意义；remove 传 null）。 */
  version?: string | null
  /** 目标实例当前生效的运行时版本（事实源见 design 21 §6.11.1）。 */
  runtimeVersion?: string | null
  /** 派生结果：null = 派生失败（fail-closed）。 */
  derivation: ProtectedDerivation | null
  /** profile 形态：absent = 尚未初始化（→ defer）。 */
  profileState?: 'ready' | 'absent'
  /**
   * 族事实源：'runtime' = 完整 P；'none' = 该后端没有 F（ssh）；'unavailable' = 本该有 F 但
   * 派生失败。'none' 与 'unavailable' 保护效果相同（官方 scope 的 install 一律拒、B₀∪S 照常
   * 保护、第三方不受影响），差别只在拒绝码与文案：后者响亮指出这是事实缺失导致的降级。
   */
  familySource?: 'runtime' | 'none' | 'unavailable'
}

/** 判定文案（zh-CN，与 gateway/desktop 既有错误文案同风格；渲染端有各自的本地化键）。 */
function refusalCopy(code: PluginRefusalCode, name: string, suggest: string | null): { error: string; suggest?: string } {
  switch (code) {
    case 'invalid-name':
      return { error: 'invalid plugin name' }
    case 'protected':
      return { error: `plugin name is protected by the instance composition (${name} cannot be installed or removed through the plugin model)` }
    case 'needs-version':
      return {
        error: `official plugin installs must pin an exact version (${name})`,
        ...(suggest === null ? {} : { suggest }),
      }
    case 'needs-exact-version':
      return {
        error: `official plugin installs must pin an exact version — ranges and dist-tags are refused (${name})`,
        ...(suggest === null ? {} : { suggest }),
      }
    case 'generation-mismatch':
      return { error: `plugin generation does not match the instance runtime (${name})` }
    case 'protected-set-unavailable':
      return { error: 'the protected-plugin set could not be derived from this instance\'s facts; plugin mutations are refused until it can' }
    case 'runtime-version-unknown':
      return { error: 'the instance runtime version is unknown; official plugin installs cannot be verified as same-generation' }
  }
}

/**
 * 写面唯一判定入口。调用方把结果映射到各自后端语义：defer → 既有 profile_absent 路径、
 * refuse → 400/拒绝并响亮报错、allow → 继续执行。
 */
export function decidePluginMutation(input: DecidePluginMutationInput): PluginMutationDecision {
  const name = input.name
  // Shape guard: an empty OR absurdly long name is an INPUT error. The bound also keeps
  // the refusal copy (which interpolates the name) from being amplified back to the caller.
  if (typeof name !== 'string' || name === '' || name.length > MAX_PLUGIN_SPEC_CHARS) {
    return { kind: 'refuse', code: 'invalid-name', error: 'invalid plugin name' }
  }
  // R0：profile 未初始化 → 沿用既有 deferred 语义（绝不 fail-closed：首次安装正是创建者）。
  if (input.profileState === 'absent') {
    return { kind: 'defer', code: 'profile_absent', error: 'managed profile is not initialized; the intent is deferred until it is' }
  }
  // `'none'` is an explicit backend fact; otherwise an incomplete set degrades to `'unavailable'` even if the caller forgot the flag — never a silent "runtime" default.
  const explicitSource = input.familySource ?? 'runtime'
  const familySource = explicitSource === 'none'
    ? 'none'
    : (input.derivation?.ok === true && !input.derivation.set.familyComplete ? 'unavailable' : explicitSource)

  // R1：保护（install / remove 同判，只看名字）。
  const derivation = input.derivation
  if (derivation === null || derivation.ok === false) {
    const reason = derivation === null ? 'protected set was not derived' : derivation.reason
    return {
      kind: 'refuse',
      code: 'protected-set-unavailable',
      error: `${refusalCopy('protected-set-unavailable', name, null).error} [${reason}]`,
    }
  }
  if (derivation.set.names.has(name)) {
    return { kind: 'refuse', code: 'protected', ...refusalCopy('protected', name, null) }
  }

  // 保守形态（在 B₀ ∪ S 判名之后）：没有 F（ssh）或 F 派生失败 ⇒ 官方 scope 的 install
  // 一律拒。只收紧不放松：官方 scope 全拒比同代校验更强，B₀∪S 与 remove 面不受影响。
  if ((familySource === 'none' || familySource === 'unavailable')
    && input.op === 'install' && officialScope(name)) {
    // 码按设计表（ssh → protected，降级 → protected-set-unavailable），但文案必须说真话：这不是"被组合保护"。
    return familySource === 'none'
      ? {
        kind: 'refuse',
        code: 'protected',
        error: `official-scope plugins cannot be installed through this plugin model (${name}): this target has no runtime-family facts — install it on the instance itself`,
      }
      : {
        kind: 'refuse',
        code: 'protected-set-unavailable',
        error: `official-scope installs are refused while this instance's runtime family cannot be derived (${name})`,
      }
  }

  // R2：仅 install，且仅官方 scope。
  if (input.op === 'install' && officialScope(name)) {
    const runtimeVersion = input.runtimeVersion ?? null
    const version = input.version ?? null
    if (version === null || version === '') {
      const code: PluginRefusalCode = 'needs-version'
      return { kind: 'refuse', code, ...refusalCopy(code, name, suggestExactSpec(name, runtimeVersion)) }
    }
    if (!isExactVersion(version)) {
      const code: PluginRefusalCode = 'needs-exact-version'
      return { kind: 'refuse', code, ...refusalCopy(code, name, suggestExactSpec(name, runtimeVersion)) }
    }
    if (!isExactVersion(runtimeVersion)) {
      const code: PluginRefusalCode = 'runtime-version-unknown'
      return { kind: 'refuse', code, ...refusalCopy(code, name, null) }
    }
    if (!sameGeneration(version, runtimeVersion)) {
      const code: PluginRefusalCode = 'generation-mismatch'
      return { kind: 'refuse', code, ...refusalCopy(code, name, suggestExactSpec(name, runtimeVersion)) }
    }
  }

  return { kind: 'allow' }
}

// 事实源：运行时线族集合

/**
 * 运行时线为某个名字提供的版本集合。
 *
 * 没有这一半，复验只能拿 installedVersion 去比 dsh 世代串，而改域后的 vendored 包（保留上游
 * 版本号）永远不可能等于世代串，会被判成跨代副本。键缺席或空数组 = 该来源没给出版本（回退
 * 世代比较，绝不猜）；锁文件可能同时 pin 同一名字的多个版本，故是集合而非单值。
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

/** 枚举一棵运行时树的 `node_modules/@deepseek-ai/*`（目录或 symlink 都算）。 */
export function familyNamesFromRuntimeTree(workspacePath: string): string[] | null {
  const facts = familyFactsFromRuntimeTree(workspacePath)
  return facts === null ? null : facts.names
}

/**
 * 树枚举的名字 + 版本事实：目录名给名字，各包 package.json 给版本（读不到就不登记该名字的
 * 版本，回退世代比较）。树是锁文件缺席时的兜底来源，只有这条路径额外花读清单的成本。
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
      // 放行就意味着 F 里每个名字都缺版本事实、静默退回世代比较；宁可拒绝该来源、让树兜底。
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
  // 退回世代比较——方向是"响亮误报"而非静默放行。在这里拒绝反而会把用户挡在门外。
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
   * 派生好的受保护集合；null = 派生失败：行仍按事实投影（role 照算，`protected` 全 false）。
   * 写面不会因此放松——它在 `decidePluginMutation` 里对 `derivation: null` 一律拒绝。
   */
  protectedSet: ProtectedSet | null
  /** S：播种注册表名（**分类器**：role/owner = seed/chamber；不作行源）。 */
  seedNames?: readonly string[]
  /** B₀（默认快照）；分类器：区分 composition / layer 与 owner=installation。 */
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
 * 行集 = dependencies 一行一条，仅此：bundles / B₀ / S 只做 role/owner 分类器与保护判定输入，
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
  // owner 是全枚举（design 21 §6.11.5）：安装自带 = installation、播种 = chamber、
  // 其余（用户自己装的层/第三方/materialize 行）= user。绝不缺省成"无主"。
  const ownerOf = (name: string): 'installation' | 'chamber' | 'user' => {
    if (installation.has(name)) return 'installation'
    if (seeds.has(name)) return 'chamber'
    return 'user'
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
      owner: ownerOf(name),
    })
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return rows
}

/**
 * `name@<value>` 形式里 pin 的 VERSION 值（裸名 / `file:` / 非 registry 值 → null）。
 * 三个后端的 install 判定都用它取「声明的版本」。
 */
export function registrySpecVersion(spec: string | null | undefined): string | null {
  if (typeof spec !== 'string' || spec === '' || spec.startsWith('file:')) return null
  const at = spec.lastIndexOf('@')
  if (at <= 0) return null
  const value = spec.slice(at + 1)
  return value === '' ? null : value
}

/** 一条族一致性违例（装后复验，design 21 §6.11.4）。 */
export interface FamilyConsistencyFinding {
  name: string
  version: string | null
  kind: 'outside-family' | 'generation-mismatch'
}

/** 装后复验结果。`skipped` 非空 = 复验**没能真正执行**（理由随行）——调用方必须响亮记录，
 *  绝不允许"跳过"被当成"通过"（这正是本特性存在的意义）。 */
export type FamilyConsistencyVerdict =
  | { ok: true; checked: number; skipped?: string }
  | { ok: false; findings: FamilyConsistencyFinding[] }

/**
 * 装后复验：R2 只看直接 spec，但官方层的依赖闭包也会落进实例树。读 profile 树顶层
 * `node_modules/@deepseek-ai/*`：直接依赖已由 R2 判定 ⇒ 跳过；F 提供的名字 ⇒ 必须与运行时为
 * 该名字提供的版本一致（没有版本事实时退回 sameGeneration），不一致 = 异版本/跨代副本，会
 * shadow 运行时那一份；F 不提供的官方 scope 名字 ⇒ 若属于用户显式安装层的依赖闭包则豁免，
 * 否则 = 族外官方 scope 影子副本。判定顺序是"先版本、后闭包"：闭包归属不得掩盖真实版本歪斜。
 * 只读；profile 树不存在 ⇒ ok。
 */
export function verifyProfileFamilyConsistency(input: {
  profileDir: string
  familyNames: readonly string[]
  runtimeVersion: string | null
  /** F 内名字由运行时线提供的版本集合；缺省/空 = 该名字没有版本事实（回退世代比较）。 */
  familyVersions?: FamilyVersions | null
}): FamilyConsistencyVerdict {
  const modulesDir = join(input.profileDir, 'node_modules', '@deepseek-ai')
  const manifestPath = join(input.profileDir, 'package.json')
  // Nothing materialized yet = a normal empty verification (not a skip).
  if (!existsSync(modulesDir)) return { ok: true, checked: 0 }
  let direct = new Set<string>()
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const deps = (parsed as Record<string, unknown>).dependencies
      if (deps !== null && typeof deps === 'object' && !Array.isArray(deps)) {
        direct = new Set(Object.keys(deps as Record<string, unknown>))
      }
    }
  } catch (error) {
    // The tree exists but cannot be classified (unreadable/corrupt/torn manifest). Skipping is
    // the ONLY honest option (treating every entry as transitive would flag the user's own
    // layer), so the reason travels with the verdict and callers log it — never a silent pass.
    return { ok: true, checked: 0, skipped: `the profile manifest could not be read (${messageOfUnknown(error)})` }
  }
  const family = new Set(input.familyNames)
  const findings: FamilyConsistencyFinding[] = []
  let entries: string[]
  try {
    entries = readdirSync(modulesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => `${OFFICIAL_SCOPE}${entry.name}`)
      .sort()
  } catch (error) {
    return { ok: true, checked: 0, skipped: `the profile node_modules tree could not be listed (${messageOfUnknown(error)})` }
  }
  const owned = profileLayerClosure(input.profileDir, direct)
  let checked = 0
  let familyEntries = 0
  /**
   * 族名字里一次臂都没跑成的（既无版本事实、实例世代也未知）。按名字收集而不是只记一个总
   * 布尔：否则"部分名字比对过、剩下的从未被比较"会聚合成一个无声的通过（跳过不是通过）。
   */
  const unverified: string[] = []
  for (const name of entries) {
    if (direct.has(name)) continue
    checked += 1
    const version = readInstalledVersion(input.profileDir, name)
    if (family.has(name)) {
      familyEntries += 1
      const provided = input.familyVersions?.get(name)
      if (provided !== undefined && provided.length > 0) {
        if (version === null || !provided.includes(version)) {
          findings.push({ name, version, kind: 'generation-mismatch' })
        }
        continue
      }
      if (input.runtimeVersion === null) {
        unverified.push(name)
        continue
      }
      if (!sameGeneration(version, input.runtimeVersion)) {
        findings.push({ name, version, kind: 'generation-mismatch' })
      }
      continue
    }
    // Not a runtime-provided name: harmless only when the user's own layer
    // brought it in. Anything else is an unexplained official-scope shadow.
    if (owned.has(name)) continue
    findings.push({ name, version, kind: 'outside-family' })
  }
  if (findings.length > 0) return { ok: false, findings }
  // 有族成员没能比对 ⇒ 如实报 skipped（响亮），绝不谎报"通过"（R2 在同一状态下是拒装）。
  // 缺事实时退回世代比较仍是设计口径；不能把"调用方给了版本表但名字不在表里"也改成 skipped，
  // 那会让没有版本事实的跨代副本从响亮失败退化成静默放行。
  if (unverified.length > 0) {
    const names = unverified.join(', ')
    return unverified.length === familyEntries
      ? { ok: true, checked, skipped: 'the instance runtime version is unknown; the generation arm of the verification could not run' }
      : { ok: true, checked, skipped: `no runtime-provided version fact exists and the instance runtime version is unknown for ${names}; the generation arm of the verification could not run for them` }
  }
  return { ok: true, checked }
}

/** 闭包遍历的清单读取上限：profile 树是有限集，超限说明树畸形 → 停止扩展（只收窄豁免面）。 */
const MAX_PROFILE_CLOSURE_MANIFESTS = 4096

/**
 * 用户显式安装层的依赖闭包：沿 `node_modules/<name>/package.json` 的
 * dependencies ∪ optionalDependencies 递归。
 *
 * 只从官方 scope 的直接依赖起步——闭包豁免的唯一用途是解释「官方 scope 但运行时线不提供」
 * 的名字，而这类名字的合法来源就是用户显式安装的官方层；从任意直接依赖起步会让第三方包夹带
 * 一个官方 scope 名字并静默通过。peerDependencies 同样不纳入：profile 固定
 * `autoInstallPeers: false`，peer 不会被物化，也不构成"这一层带来了它"的证据。
 * 名字先过 SAFE_PACKAGE_NAME，否则 `../` 之类会逃出 node_modules。
 */
function profileLayerClosure(profileDir: string, direct: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>()
  const queue = [...direct].filter(name => officialScope(name))
  let reads = 0
  while (queue.length > 0 && reads < MAX_PROFILE_CLOSURE_MANIFESTS) {
    const name = queue.pop() as string
    if (seen.has(name)) continue
    seen.add(name)
    // Only OFFICIAL nodes expand the walk: the real closures carry third-party packages, and
    // letting one declare an official-scope dependency would explain an arbitrary official name.
    // The name itself stays in `seen` (the layer did bring it in); its manifest is not consulted.
    if (!officialScope(name)) continue
    if (!SAFE_PACKAGE_NAME.test(name)) continue
    const manifest = readPackageManifest(join(profileDir, 'node_modules', name, 'package.json'))
    if (manifest === null) continue
    reads += 1
    for (const field of ['dependencies', 'optionalDependencies'] as const) {
      const block = manifest[field]
      if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
      for (const dependency of Object.keys(block as Record<string, unknown>)) {
        if (!seen.has(dependency)) queue.push(dependency)
      }
    }
  }
  return seen
}

/** 一个未知错误的简短文案（复验跳过理由用）；实现为共享叶子 error-text.ts，本地名保留以免改动调用点。 */
function messageOfUnknown(error: unknown): string {
  return errorMessage(error)
}

/**
 * 违例 → 面向操作者的响亮文案（两端共用）。命中版本事实时改述为"不是本实例运行时代为提供的
 * 版本"，因为对改域 vendored 包来说世代串本身就不是它的版本尺度。
 */
export function describeFamilyFindings(
  findings: readonly FamilyConsistencyFinding[],
  runtimeVersion: string | null,
  familyVersions?: FamilyVersions | null,
): string {
  return findings.map((finding) => {
    if (finding.kind === 'outside-family') {
      return `${finding.name}@${finding.version ?? '?'} is a runtime-family copy that the pinned release does not provide`
    }
    const provided = familyVersions?.get(finding.name)
    if (provided !== undefined && provided.length > 0) {
      return `${finding.name}@${finding.version ?? '?'} is not the version this instance runtime provides (expected ${provided.join(' | ')})`
    }
    return `${finding.name}@${finding.version ?? '?'} does not match the instance runtime generation (${runtimeVersion ?? 'unknown'})`
  }).join('；')
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
