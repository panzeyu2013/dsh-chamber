/**
 * protected-plugins.ts — 受保护集合 P 的派生、写面判定与读面行投影（design 21 §6.11，
 * 决策 19 的 2026-12 修订口径）。
 *
 * 单一来源：本模块是「哪些名字不能装卸 / 官方 scope 的安装是否同代 / 每个已安装行是什么角色」
 * 的唯一实现。desktop 经 control-plane-module.ts 双路径 facade 消费，gateway 经
 * '@dsh-chamber/control-plane' 直引；渲染端**不镜像**本模块（它消费后端投影的
 * `rows[].role` / `rows[].protected`）。
 *
 * 规则要点（与 design 21 §6.11 逐条对应）：
 * - `P = B₀ ∪ S ∪ F`：B₀ = profile 安装自带组合（模板默认快照，**不含**用户后加的层）、
 *   S = chamber 播种注册表名、F = 运行时线族（**运行时锁文件闭包**优先，实例树枚举兜底）。
 * - `decidePluginMutation`：install/remove **同判 P**；remove **永不判版本**；官方 scope 的
 *   install 另需**精确同代**（无版本、`^`/`~`/dist-tag 拒；预发布字符串全等）。
 * - `profile_absent` → defer（保留既有 first-install 语义，绝不 fail-closed；调用方把 defer
 *   当作"让 CLI 去创建 profile"，不是拒绝）。
 * - F 不可得 → **保守降级**（`familySource:'none'|'unavailable'`）：P 退到 B₀ ∪ S，
 *   官方 scope 的 install 一律拒（比同代校验更强），第三方与 remove 面照常。
 *   绝不退化成"没有保护"。
 *
 * 纯逻辑 + 两个只读 fs 探针（运行时树枚举 / 已装版本读取），无第三方依赖。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_PLUGIN_SPEC_CHARS } from './plugin-spec.ts'

/**
 * 运行时线闭包的**核心锚**：F 少了任何一个都说明取错了来源（源码线/裁剪过的树/外来锁文件）。
 * 与 C11 门禁同源——门禁直接 import 本模块，不再自己抄一份（2026-12 review）。
 */
export const RUNTIME_FAMILY_CORE: readonly string[] = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
]

/**
 * F 里**绝不允许**出现的包：opt-in 层（`dsh-experimental-*`）与 dev/test 段。出现即说明
 * 用了源码线闭包（design 21 §6.11.1 明确排除）。与 C11 同源。
 */
export const RUNTIME_FAMILY_FORBIDDEN: readonly { pattern: RegExp; label: string; why: string }[] = [
  {
    pattern: /^@deepseek-ai\/dsh-experimental-/,
    label: '官方 opt-in 段（experimental）',
    why: 'opt-in layer belongs to the source line, not the runtime line',
  },
  {
    pattern: /^@deepseek-ai\/dsh-.*(?:-testkit|-mock-server)$/,
    label: 'dev/test 工具包',
    why: 'dev/test tooling belongs to the source line',
  },
  {
    pattern: /^@deepseek-ai\/dsh-(?:benchmarks|loader-smoke|llm-replay|client-test-runtime)$/,
    label: 'dev/test 专用包',
    why: 'dev/test package belongs to the source line',
  },
  {
    pattern: /^@deepseek-ai\/dsh-(?:test|dev|e2e)-/,
    label: 'dev/test 段',
    why: 'dev/test package belongs to the source line',
  },
  {
    pattern: /^@deepseek-ai\/harness-/,
    label: '源码线 harness 段',
    why: 'harness packages are the source line',
  },
]

/**
 * 闭包是否可信（核心锚齐全 + 无禁名）。运行时与 C11 门禁共用同一判据：不可信 ⇒ 调用方
 * 走保守降级（官方 scope 装面全拒），绝不静默把它当 F。
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
 *  派生（B₀ ∪ S ∪ F），「chamber 自建包一律拒绝」那套前缀规则已随 design 21 §6.11 退役
 *  ——保留它只为表述包的归属，别拿它当门（2026-09-13 复核）。 */
export const CHAMBER_SCOPE = '@dsh-chamber/'

/**
 * B₀ 快照：web profile 的安装自带组合（上游 `PROFILE_TEMPLATES.web.bundles` 的对拍对象，
 * 由 C12 保鲜门守住）。**不得**从 live `dsh.profile.bundles` 取——那是「按已安装状态重算」
 * 的结果，会把用户后加的层也变成受保护项（design 21 §6.11.2）。
 */
export const PROFILE_BUNDLES_SNAPSHOT: readonly string[] = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
]

/** 行角色（读面投影；渲染端只渲染，不推导）。 */
export type PluginRowRole =
  | 'composition'
  | 'seed'
  | 'layer'
  | 'third-party'
  | 'materialized'
  | 'unknown'

/** 受保护来源（用于文案与 tooltip；同一名字可能同时命中多个来源，取最先命中的）。 */
export type ProtectedSource = 'installation' | 'chamber' | 'family'

/** 一行已安装事实（design 21 §6.11.5 的 wire 形状）。 */
export interface PluginRow {
  name: string
  /** 声明的依赖值（file: 值按各后端既有掩码纪律处理）；组合/种子行无依赖值时为 null。 */
  spec: string | null
  /** 已装版本（能从 node_modules 清单读到才有；否则 null）。 */
  version: string | null
  role: PluginRowRole
  protected: boolean
  owner?: 'installation' | 'chamber' | 'user'
}

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
 * 派生受保护集合。`familyNames === null` 表示该后端**没有**族事实源（ssh）——此时仍返回
 * `ok:true` 但只覆盖 B₀ ∪ S，由 `decidePluginMutation` 的 `familySource:'none'` 分支把
 * 官方 scope 的 install 一律拒掉（只收紧不放松）。
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
  // The set must never be EMPTY (2026-09-13 round-2 review F3). `familyComplete`
  // only says whether F contributed; it does not say whether P is non-empty, so an
  // all-empty input (installationBundles: [], seedNames: [], familyNames: null)
  // used to answer `ok:true` with zero names — and then `decidePluginMutation`
  // allowed a remove of a composition member such as `@deepseek-ai/dsh-base`.
  // The three production call sites cannot reach this today (B₀ defaults to the
  // non-empty snapshot, S comes from the non-empty registry), but a future caller
  // that reads the installation bundles from a profile can — and the failure mode
  // is silent loss of protection, which is exactly what this module promises
  // never to degrade into. Fail closed instead.
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

// ---------------------------------------------------------------------------
// 版本语法与代比较
// ---------------------------------------------------------------------------

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
  // NO trim: ` 1.2.3 ` is not an exact version literal, and `suggestExactSpec` must never
  // hand back a suggestion the spec whitelist would reject (2026-12 review).
  const match = EXACT_VERSION_RE.exec(value)
  if (match === null) return null
  return { major: match[1], minor: match[2], patch: match[3], prerelease: match[4] ?? null }
}

/** 是否精确版本字面量（`^`/`~`/`latest`/`next`/范围一律 false）。 */
export function isExactVersion(value: string | null | undefined): boolean {
  return parseExactVersion(value) !== null
}

/**
 * 同代判定（design 21 §6.11.3）：
 * - 任一侧带预发布 ⇒ **字符串全等**（`0.1.5-rc.1 ≠ 0.1.5-rc.2`；tuple 相等不算通过）；
 * - 两侧都是稳定版 ⇒ 比较 `major.minor.patch`。
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

// ---------------------------------------------------------------------------
// 写面判定
// ---------------------------------------------------------------------------

export type PluginMutationOp = 'install' | 'remove'

/** 拒绝码（gateway 400 code；`reserved` 随本次修订退役，客户端仍须接受旧码）。 */
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
   * 族事实源：
   * - `'runtime'`：完整 P（本后端能读运行时线 F）；
   * - `'none'`：该后端**没有** F（ssh —— 远端无族事实源）；
   * - `'unavailable'`：本该有 F 但**派生失败**（运行时树缺失/锁文件不可解析）。
   *   `'none'` 与 `'unavailable'` 的**保护效果相同**（官方 scope 的 install 一律拒、
   *   B₀∪S 照常保护、第三方不受影响），差别只在拒绝码与文案：后者响亮指出这是
   *   事实缺失导致的降级，而不是"这个层被组合保护"。
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
 * 写面唯一判定入口（design 21 §6.11.3）。
 *
 * 调用方把结果映射到各自的后端语义：`defer` → 既有 profile_absent 路径（202 deferred）、
 * `refuse` → 400/拒绝并响亮报错、`allow` → 继续执行。
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
  // `'none'` is an explicit backend fact; otherwise an incomplete set (no F) degrades to
  // `'unavailable'` even if the caller forgot the flag — never a silent "runtime" default.
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

  // 保守形态（在 B₀ ∪ S 判名**之后**：那一份事实永远可得，官方 scope 的保守只是「F 不可得」）：
  // 没有 F（ssh）或 F 派生失败（降级）⇒ 官方 scope 的 install 一律拒。
  // 这是**只收紧不放松**的方向：官方 scope 全拒比"同代校验"更强，B₀∪S 仍照常保护，
  // 第三方 install/remove 与 remove 面（B₀∪S 事实）不受影响。
  if ((familySource === 'none' || familySource === 'unavailable')
    && input.op === 'install' && officialScope(name)) {
    // 码按设计表（ssh → `protected`，降级 → `protected-set-unavailable`），但**文案必须说真话**：
    // 这不是"被组合保护"，而是"本后端无法约束官方 scope 的安装"（2026-12 review）。
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

// ---------------------------------------------------------------------------
// 事实源：运行时线族集合
// ---------------------------------------------------------------------------

/** 运行时线族集合的解析结果（`lockfilePath` 是实际采用的锁文件，证据用）。 */
export type RuntimeFamilyResolution =
  | {
    ok: true
    names: readonly string[]
    /** pinned-lockfile = 已提交的运行时线锚（首选）；lockfile-closure = 活动树的锁文件；
     *  runtime-tree = 无锁文件时的树枚举兜底。 */
    source: 'pinned-lockfile' | 'lockfile-closure' | 'runtime-tree'
    lockfilePath: string | null
    /** 树枚举原始结果（证据字段：锁文件命中时为 null —— 懒枚举，不白读目录；
     *  真正用树作来源时它等于 names）。调用方只用它做日志/诊断。 */
    treeNames: readonly string[] | null
  }
  | { ok: false; reason: string }

/**
 * 从**运行时锁文件**（`pnpm-lock.yaml`，唯一权威，平台无关）解析 `@deepseek-ai/*` 名字集合。
 * 兼容 pnpm v9（`'@scope/name@version':`）与 v6（`/@scope/name/version:`）两种键形。
 */
export function familyNamesFromLockfileClosure(lockfileText: string): string[] {
  const names = new Set<string>()
  const v9 = /^ {2}'?(@deepseek-ai\/[a-z0-9._-]+)@/gm
  const v6 = /^ {2}\/(@deepseek-ai\/[a-z0-9._-]+)\//gm
  for (const re of [v9, v6]) {
    for (const match of lockfileText.matchAll(re)) names.add(match[1])
  }
  return [...names].sort()
}

/** 枚举一棵运行时树的 `node_modules/@deepseek-ai/*`（目录或 symlink 都算）。 */
export function familyNamesFromRuntimeTree(workspacePath: string): string[] | null {
  const dir = join(workspacePath, 'node_modules', '@deepseek-ai')
  if (!existsSync(dir)) return null
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => `${OFFICIAL_SCOPE}${entry.name}`)
      .sort()
  } catch {
    return null
  }
}

/**
 * 解析运行时线族集合（design 21 §6.11.1 的事实源优先级）：
 *
 * 1. **已提交的运行时线锚锁文件**（`opts.pinnedLockfilePath`）——唯一权威、平台无关，
 *    且正是 C11 门禁断言的那个文件（生产包把它随应用一起发；dev 形态它就是仓库里的
 *    `packages/desktop/vendor/dsh/pnpm-lock.yaml`）。**必须先试它**：活动树在 dev 形态
 *    可能是源码线（`ref-dsh`），其闭包含 opt-in 段，用它当 F 会让官方 opt-in 层永久受保护。
 * 2. 活动树自己的 `pnpm-lock.yaml`（用户另装的运行时树；与锚同源时结果相同）。
 * 3. 无锁文件时退回 `node_modules/@deepseek-ai/*` 枚举（平台相关，仅兜底）。
 *
 * 锁文件"存在即权威"：不做"名字太少就换来源"的启发式，空集交给 `deriveProtectedSet`
 * 判为派生失败 ⇒ 后端保守降级（只收紧不放松）。树枚举同时作为交叉校验事实返回。
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
      const names = familyNamesFromLockfileClosure(readFileSync(candidate.path, 'utf8'))
      // 可信性判据（与 C11 同源）：核心锚缺失或含禁名 ⇒ 这个闭包**不是**运行时线的 F
      // （源码线/裁剪树/外来锁文件），拒绝它并继续找；全被拒则 ok:false（保守降级）。
      const findings = runtimeFamilyFindings(names)
      if (findings.length === 0) return { ok: true, names, source: candidate.source, lockfilePath: candidate.path, treeNames: null }
      rejected.push(`${candidate.path}: ${findings.join('; ')}`)
    } catch {
      /* 读失败（EACCES/损坏）→ 下一个候选 */
    }
  }
  // 只有在没有可用锁文件时才枚举实例树（每次 IPC 都 readdir 不值得）；树同样过可信性判据。
  const treeNames = familyNamesFromRuntimeTree(workspacePath)
  if (treeNames !== null && treeNames.length > 0) {
    const findings = runtimeFamilyFindings(treeNames)
    if (findings.length === 0) return { ok: true, names: treeNames, source: 'runtime-tree', lockfilePath: null, treeNames }
    rejected.push(`${workspacePath}/node_modules/@deepseek-ai: ${findings.join('; ')}`)
  }
  return {
    ok: false,
    reason: rejected.length > 0
      ? `no trustworthy runtime family facts (${rejected.join(' | ')})`
      : `no runtime family facts under ${workspacePath} (neither a usable pnpm-lock.yaml nor node_modules/@deepseek-ai)`,
  }
}

// ---------------------------------------------------------------------------
// 读面行投影
// ---------------------------------------------------------------------------

/**
 * 投影里 materialize 值（`file:`/`link:`/本地路径）的掩码。**保留 `file:` 前缀**，
 * 这样掩码后的值仍被三端的 spec 分类器判为 materialize（name 基 diff 不受影响）。
 * 单一来源：desktop plugin-sync.ts 与 gateway plugins-installed.ts 的
 * `MATERIALIZED_VALUE_MASK` 都指回这里（design 21 §6.2 掩码纪律）。
 */
export const PLUGIN_MATERIALIZED_VALUE_MASK = 'file:<hidden>'

/**
 * `file:`/`link:`/路径类依赖值 = materialize 行（与各后端既有 value grammar 同义）。
 *
 * **必须与 semver 范围区分**：`~1.2.0`（波浪号范围）、`^1.0.0`、`>=1 <2`、`1.x`、`latest`
 * 都是 registry 值而不是路径——早先"任何 `~` 开头都算路径"会把 `~1.2.0` 误判为 materialize
 * 行（2026-12 review 由掩码扩面暴露）。只有 `~/`、`./`、`../`、`/abs`、`C:\`、`\\unc` 这类
 * **路径形态**才算。
 */
export function isMaterializedValue(value: string): boolean {
  if (typeof value !== 'string' || value === '') return false
  if (/^(file|link):/i.test(value)) return true
  if (/^\.\.?([/\\]|$)/.test(value)) return true
  if (value.startsWith('/') || value.startsWith('\\')) return true
  if (value === '~' || /^~[/\\]/.test(value)) return true
  return /^[a-zA-Z]:[\\/]/.test(value)
}

export interface DerivePluginRowsInput {
  /** profile 声明的依赖（name → spec/value；各后端已按自己的掩码纪律处理过）。 */
  dependencies: Record<string, string>
  /** live `dsh.profile.bundles`（只用于 role，不参与保护判定）。 */
  bundles: readonly string[]
  /**
   * 派生好的受保护集合；null = 派生失败：行仍按事实投影（role 照算，`protected` 全 false）。
   * 写面不会因此放松——它在 `decidePluginMutation` 里对 `derivation: null` 一律拒绝。
   */
  protectedSet: ProtectedSet | null
  /** S：播种注册表名（投影 seed 行）。 */
  seedNames?: readonly string[]
  /** B₀（默认快照）；用于区分 composition / layer。 */
  installationBundles?: readonly string[]
  /** 已装版本读取（可选；按 name 返回版本或 null）。 */
  installedVersion?: (name: string) => string | null
  /**
   * 可选：依赖值 → 投影值的掩码钩子。**缺省 = 原值**——行投影的 `spec` 必须与调用方自己的
   * `dependencies` 掩码一致：gateway 与 ssh 的 manifest 都掩 `file:` 值（远端/受管 profile
   * 的本地路径不进渲染端），local 的原样清单不掩，三者各自传自己的掩码器。
   */
  maskSpec?: (spec: string) => string | null
}

/**
 * 把「依赖 + bundles + 种子」并集投影成行（design 21 §6.11.5）。
 *
 * **注意**：`dependencies` 本身不并集——组合成员与播种物可能根本不在依赖表里（实测 live
 * profile `dependencies: {}` 而 `bundles` 非空），所以行集必须是三者的并集，否则受保护行
 * 在 UI 里永远不可见。
 */
export function derivePluginRows(input: DerivePluginRowsInput): PluginRow[] {
  const installation = new Set(input.installationBundles ?? PROFILE_BUNDLES_SNAPSHOT)
  const bundles = new Set(input.bundles)
  const seeds = new Set(input.seedNames ?? [])
  const protectedNames = input.protectedSet?.names ?? new Set<string>()
  const versionOf = input.installedVersion ?? (() => null)
  const rows: PluginRow[] = []
  const seen = new Set<string>()

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
    seen.add(name)
    rows.push({
      name,
      spec: mask(spec),
      version: versionOf(name),
      role: roleOf(name, spec),
      protected: protectedNames.has(name),
      owner: ownerOf(name),
    })
  }
  // 组合自带行（不在依赖表里也要可见）。行集取 **live bundles ∪ B₀**：
  // B₀ 是安装自带的事实，live bundles 可能为空/未列出默认组合（远端 profile
  // 尚未初始化、或 fixture/裁剪过的 manifest），但「组合成员可见且只读」不能因此消失。
  for (const name of [...new Set([...bundles, ...(input.installationBundles ?? PROFILE_BUNDLES_SNAPSHOT)])]) {
    if (seen.has(name)) continue
    seen.add(name)
    rows.push({
      name,
      spec: null,
      version: versionOf(name),
      role: roleOf(name, null),
      protected: protectedNames.has(name),
      owner: ownerOf(name),
    })
  }
  // 播种行（extraneous，同样不在依赖表里）
  for (const name of seeds) {
    if (seen.has(name)) continue
    seen.add(name)
    rows.push({
      name,
      spec: null,
      version: versionOf(name),
      role: 'seed',
      protected: protectedNames.has(name),
      owner: 'chamber',
    })
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return rows
}

/**
 * `name@<value>` 形式里 pin 的 VERSION 值（裸名 / `file:` / 非 registry 值 → null）。
 * 三个后端的 install 判定都用它取「声明的版本」（design 21 §6.11.3 R2）。
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
 * 装后复验（design 21 §6.11.4）：R2 只看**直接 spec**，但官方层的依赖闭包也会落进
 * 实例树。这里读 profile 树顶层 `node_modules/@deepseek-ai/*`：
 *
 * - **直接依赖**（profile manifest 的 `dependencies` 里的名字）= 用户显式请求的安装，
 *   已由 R2 判定 ⇒ 跳过（层自己通常就是 `@deepseek-ai/dsh-experimental-*`，不在 F 内）；
 * - **其余**（被 pnpm 提升上来的传递副本）必须 ∈ F 且与实例同代，否则：
 *   `outside-family` = 引入了族外的官方 scope 影子副本；`generation-mismatch` = 跨代副本。
 *
 * 只读；失败返回 findings（调用方决定回滚/响亮报错）。profile 树不存在 ⇒ ok。
 */
export function verifyProfileFamilyConsistency(input: {
  profileDir: string
  familyNames: readonly string[]
  runtimeVersion: string | null
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
    // The tree exists but cannot be classified (unreadable/corrupt/torn
    // manifest). Skipping is the ONLY honest option (treating every entry as
    // transitive would flag the user's own layer), so the reason travels with
    // the verdict and the callers log it — never a silent pass.
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
  let checked = 0
  let generationChecked = false
  let familyEntries = 0
  for (const name of entries) {
    if (direct.has(name)) continue
    checked += 1
    const version = readInstalledVersion(input.profileDir, name)
    if (!family.has(name)) {
      findings.push({ name, version, kind: 'outside-family' })
      continue
    }
    familyEntries += 1
    if (input.runtimeVersion === null) continue
    generationChecked = true
    if (!sameGeneration(version, input.runtimeVersion)) {
      findings.push({ name, version, kind: 'generation-mismatch' })
    }
  }
  if (findings.length > 0) return { ok: false, findings }
  // 有族成员却读不到实例版本 ⇒ 代臂**没能跑**：如实报 skipped（响亮），绝不谎报"通过"
  // （2026-12 review：R2 在同一状态下是拒装，复验不能反而放行）。
  return familyEntries > 0 && !generationChecked
    ? { ok: true, checked, skipped: 'the instance runtime version is unknown; the generation arm of the verification could not run' }
    : { ok: true, checked }
}

/** 一个未知错误的简短文案（复验跳过理由用；不引入额外依赖）。 */
function messageOfUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 违例 → 面向操作者的响亮文案（两端共用）。 */
export function describeFamilyFindings(findings: readonly FamilyConsistencyFinding[], runtimeVersion: string | null): string {
  return findings.map((finding) => (finding.kind === 'outside-family'
    ? `${finding.name}@${finding.version ?? '?'} is a runtime-family copy that the pinned release does not provide`
    : `${finding.name}@${finding.version ?? '?'} does not match the instance runtime generation (${runtimeVersion ?? 'unknown'})`)).join('；')
}

/**
 * 从已装清单读一个包的版本（可选辅助；name 必须已过 PLUGIN_NAME_PATTERN 类白名单）。
 * 返回 null 表示读不到（未装/无清单/读失败）——投影里就是 `version: null`，绝不让它成为判据。
 */
export function readInstalledVersion(profileDir: string, name: string): string | null {
  if (!/^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return null
  const manifestPath = join(profileDir, 'node_modules', name, 'package.json')
  if (!existsSync(manifestPath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    const version = (parsed as Record<string, unknown>).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}
