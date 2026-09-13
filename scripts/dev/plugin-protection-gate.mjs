import {
  RUNTIME_FAMILY_CORE,
  RUNTIME_FAMILY_FORBIDDEN,
  familyNamesFromLockfileClosure,
} from '../../packages/control-plane/src/protected-plugins.ts'

/**
 * plugin-protection-gate.mjs — C11–C14 的纯判据（docs/checklists/upstream-touchpoints.md
 * §6 的机器侧；design 21 §6.11「受保护集合与代耦合」的保鲜门）。
 *
 * 为什么单独成模块：`verify-upstream-touchpoints.mjs` 是顶层过程式程序、不可被
 * 测试 import（同 verify-upstream-touchpoints-args.mjs 的拆法先例）。这里只放
 * **纯函数**（无 fs、无 process）：调用方读文件/读目录，把文本与名字数组传进来，
 * 拿回 `{violations, notes}`，再由调用方决定 fail/warn。于是每条判据都能用合成
 * 夹具做**负例**测试（改坏派生来源/契约/播种/镜像 → 必须变红）。
 *
 * 判据的**单一来源**：C11 的核心锚/禁名判据与锁文件解析器都直接 import 运行时模块
 * `packages/control-plane/src/protected-plugins.ts`（node 24 直接跑 TS，零依赖），
 * 所以"门禁判据"与"运行时判据"不可能再漂移（2026-12 review F6）。
 *
 * 四门的语义（design 21 §6.11）：
 * - C11 运行时线族集合：受保护集合的 F 分量只有一个权威来源——**已提交**的
 *   `packages/desktop/vendor/dsh/pnpm-lock.yaml` 闭包；实例树枚举只作等价性
 *   交叉校验。opt-in 层（`@deepseek-ai/dsh-experimental-*`）与 dev/test 包
 *   **绝不**属于 F，否则 G1（能装官方 opt-in 层）当场失效。
 * - C12 profile 契约锚：上游仍以 `dsh.profile.bundles` 承载层列表、以
 *   `dsh.bundle.patch` 声明层、web 模板默认组合不变、profile workspace 仍是
 *   hoisted + 不自动装 peer。任一漂移 ⇒ 停升级、改派生（B₀ 快照）。
 * - C13 播种注册表结构：`HOST_*_PACKAGE_NAME` 常量 ↔ `HOST_*_INSERT` 行 ↔
 *   `CHAMBER_HOST_PACKAGES` 注册表三面一一对应（漏登记即 S 分量失真）。
 * - C14 manifest 三方镜像：`plugin-sync.ts`（producer）↔ `preload.cts` ↔
 *   `renderer/src/global.d.ts` 的字段集必须一致（ipc-surface-mirror 只覆盖
 *   后两者，producer 侧原本裸奔）。
 */

/**
 * 核心锚与禁名形态**不再在本文件声明**：运行时（`protected-plugins.ts` 的
 * `runtimeFamilyFindings`）与 C11 必须用同一份判据，否则"门禁绿而运行时另有一套"
 * 就没有意义（2026-12 review F6）。这里只做再导出，保持一致与向后兼容。
 */
export const FAMILY_CORE = RUNTIME_FAMILY_CORE

/** 绝不属于 F 的名字形态（同源，label 也在模块里，避免两套文案）。 */
export const FAMILY_FORBIDDEN = RUNTIME_FAMILY_FORBIDDEN

/** node-addon-system 平台分包：允许「闭包有、本平台树无」。 */
const PLATFORM_NATIVE_RE = /^@deepseek-ai\/node-addon-system-/

/** 闭包解析的健全性下限（当前运行时线 ≈ 244；解析坏了必须响亮）。 */
const MIN_FAMILY_SIZE = 200

/**
 * 运行时线族集合：`pnpm-lock.yaml` 的 `packages:` 段键名。
 * 只认两级缩进（2 空格）的包条目——importer 段（6 空格）与 snapshots 段
 * （`packages:` 之外的 `snapshots:` 用 2 空格 + 依赖列表）都不会命中 `@版本` 形态。
 *
 * @param {string} lockfileText - `packages/desktop/vendor/dsh/pnpm-lock.yaml` 文本。
 * @returns {string[]} 去重升序的 `@deepseek-ai/*` 包名。
 */
export function runtimeFamilyNames(lockfileText) {
  // 直接调用运行时模块的解析器（同一实现，见文件头）。
  return familyNamesFromLockfileClosure(lockfileText)
}

/**
 * C11 判据。
 *
 * @param {{ names: string[], treeNames: string[] | null, sourceTreeNames?: string[] | null }} input
 *   `names` = `runtimeFamilyNames()` 结果；`treeNames` = 活动运行时树
 *   `node_modules/@deepseek-ai/*` 的枚举（未物化传 null ⇒ 只跳过等价性校验）；
 *   `sourceTreeNames` = 可选：源码线 `vendor/harness-packages/@deepseek-ai/*` 枚举，
 *   仅用于产出一条提醒性 note（源码线不是 F 的来源）。
 * @returns {{ violations: string[], notes: string[] }}
 */
export function familyFindings({ names, treeNames, sourceTreeNames = null }) {
  const violations = []
  const notes = []

  if (names.length < MIN_FAMILY_SIZE) {
    violations.push(`运行时线闭包只解析出 ${names.length} 个 @deepseek-ai/*（< ${MIN_FAMILY_SIZE}）——锁文件格式变了或解析失配`)
    return { violations, notes }
  }

  const nameSet = new Set(names)
  for (const core of FAMILY_CORE) {
    if (!nameSet.has(core)) violations.push(`运行时线闭包缺少核心包 ${core}`)
  }
  for (const name of names) {
    if (name.startsWith('@dsh-chamber/')) violations.push(`运行时线闭包混入 chamber 包 ${name}`)
    for (const rule of FAMILY_FORBIDDEN) {
      if (rule.pattern.test(name)) violations.push(`运行时线闭包混入${rule.label}：${name}（opt-in 层必须不在 F 内，否则装不上）`)
    }
  }

  if (treeNames !== null) {
    const treeSet = new Set(treeNames)
    const missing = names.filter((name) => !treeSet.has(name))
    const extra = treeNames.filter((name) => !nameSet.has(name))
    const unexpectedMissing = missing.filter((name) => !PLATFORM_NATIVE_RE.test(name))
    if (unexpectedMissing.length > 0) {
      violations.push(`运行时树缺少闭包中的非平台分包：${unexpectedMissing.join(', ')}（枚举派生与锁文件派生不等价）`)
    }
    if (extra.length > 0) {
      violations.push(`运行时树出现闭包外的 @deepseek-ai/*：${extra.join(', ')}`)
    }
    const platformOnly = missing.filter((name) => PLATFORM_NATIVE_RE.test(name))
    notes.push(`C11 等价性校验：闭包 ${names.length} / 树 ${treeNames.length}（允许的平台分包差：${platformOnly.length}）`)
  } else {
    notes.push('C11 等价性校验跳过：活动运行时树未物化（仅校验锁文件闭包；CI 打包腿会交叉校验）')
  }

  if (sourceTreeNames !== null) {
    const optIn = sourceTreeNames.filter((name) => FAMILY_FORBIDDEN.some((rule) => rule.pattern.test(name)))
    if (optIn.length > 0) {
      notes.push(`C11 提醒：源码线 vendor 树含 ${optIn.length} 个 opt-in/dev 包（${optIn.slice(0, 3).join(', ')}…）——**它绝不是 F 的来源**`)
    }
  }

  return { violations, notes }
}

// ---------------------------------------------------------------------------
// C12 —— profile 契约锚（上游源码；空白归一后做子串命中）
// ---------------------------------------------------------------------------

/**
 * 上游 profile 契约的锚点集合。每条 = 一个概念 + 命中任一候选即算通过。
 * 空白归一（连续空白 → 单空格）后再匹配，因此只对**词法**漂移敏感，不对缩进/换行敏感。
 * 全部锚点在 pin 住的上游源码上实测命中（2026-12）：
 * `packages/boot/app-boot/src/profile.ts`、`apps/cli/src/plugin.ts`。
 */
export const PROFILE_CONTRACT_ANCHORS = [
  { file: 'profile', label: 'web 模板默认组合（B₀ 快照的对拍对象）', needles: ["web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']"] },
  { file: 'profile', label: '模板表存在', needles: ['PROFILE_TEMPLATES'] },
  { file: 'profile', label: '无模板 profile 的默认组合常量', needles: ['DEFAULT_PROFILE_BUNDLES'] },
  { file: 'profile', label: 'profile workspace 链接器', needles: ['nodeLinker: hoisted'] },
  { file: 'profile', label: 'profile workspace 不自动装 peer', needles: ['autoInstallPeers: false'] },
  { file: 'profile', label: '层列表落盘键 dsh.profile.bundles', needles: ['dsh: { profile: { bundles:'] },
  { file: 'plugin', label: '层由 dsh.bundle.patch 声明', needles: ['dsh?.bundle?.patch'] },
  { file: 'plugin', label: '层列表按已安装状态 reconcile', needles: ['dsh?.profile?.bundles'] },
  { file: 'plugin', label: 'init 走模板组合', needles: ['DEFAULT_PROFILE_BUNDLES'] },
  { file: 'plugin', label: '非层依赖的既有告警语义', needles: ['declares no dsh.bundle'] },
]

/** 空白归一：只压空白，不改字符。 */
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ')
}

/**
 * C12 判据。
 *
 * @param {{ profileSource: string | null, pluginSource: string | null }} input
 *   两个上游源码文本；null = 子模块未物化（调用方给出 note，不当违规——
 *   C1/C3/C5 已经会对缺失子模块响亮失败）。
 * @returns {{ violations: string[], notes: string[] }}
 */
export function profileContractFindings({ profileSource, pluginSource }) {
  const violations = []
  const notes = []
  const sources = { profile: profileSource, plugin: pluginSource }
  let checked = 0
  for (const anchor of PROFILE_CONTRACT_ANCHORS) {
    const raw = sources[anchor.file]
    if (raw === null || raw === undefined) continue
    checked += 1
    const haystack = normalizeWhitespace(raw)
    if (!anchor.needles.some((needle) => haystack.includes(normalizeWhitespace(needle)))) {
      violations.push(`上游 ${anchor.file} 源码缺少 profile 契约锚「${anchor.label}」（候选：${anchor.needles.join(' | ')}）`)
    }
  }
  if (checked === 0) notes.push('C12 跳过：vendor/harness-checkout 未物化（CI 在 Bootstrap 后硬门）')
  return { violations, notes }
}

// ---------------------------------------------------------------------------
// C13 —— 播种注册表结构（S 分量的失真门）
// ---------------------------------------------------------------------------

/** 取 `export const NAME = '…'` 形式的字符串常量。 */
function stringConstants(source, namePattern) {
  const out = new Map()
  const re = new RegExp(`export const (${namePattern})\\s*(?::[^=]+)?=\\s*'([^']+)'`, 'g')
  for (const match of source.matchAll(re)) out.set(match[1], match[2])
  return out
}

/**
 * C13 判据：`HOST_*_PACKAGE_NAME` 常量 ↔ `HOST_*_INSERT` 行 ↔ `CHAMBER_HOST_PACKAGES`
 * 注册表三面一一对应。任一面向量不等（漏登记 / 孤儿常量 / 注册表引用了不存在的行）
 * 都意味着 S 分量与播种机制脱节。
 *
 * @param {{ seedSource: string }} input - `control-plane/src/host-graph-seed.ts` 文本。
 * @returns {{ violations: string[], notes: string[] }}
 */
export function seedRegistryFindings({ seedSource }) {
  const violations = []
  const notes = []

  const packageNames = stringConstants(seedSource, 'HOST_[A-Z0-9_]+_PACKAGE_NAME')
  if (packageNames.size === 0) {
    violations.push('未找到任何 HOST_*_PACKAGE_NAME 常量——播种注册表被改名或搬走了')
    return { violations, notes }
  }
  for (const [constant, value] of packageNames) {
    if (!value.startsWith('@dsh-chamber/')) violations.push(`${constant} = ${value} 不在 @dsh-chamber/* 域内`)
  }

  const inserts = new Map()
  // 行形态容忍换行/缩进（真实源是多行字面量）：只钉 id/name 两个键与它们的取值。
  const insertRe = /export const (HOST_[A-Z0-9_]+_INSERT): HostPackageInsert = \{\s*id:\s*[A-Z0-9_]+,\s*name:\s*([A-Z0-9_]+),?\s*\}/g
  for (const match of seedSource.matchAll(insertRe)) {
    inserts.set(match[1], match[2])
  }
  if (inserts.size === 0) {
    violations.push('未找到任何 HOST_*_INSERT 行声明——播种行形态变了（C13 需同步改判据）')
    return { violations, notes }
  }
  for (const [insert, nameConstant] of inserts) {
    if (!packageNames.has(nameConstant)) {
      violations.push(`${insert} 引用了未声明的包名常量 ${nameConstant}`)
    }
  }
  const referencedNames = new Set(inserts.values())
  for (const constant of packageNames.keys()) {
    if (!referencedNames.has(constant)) {
      violations.push(`${constant} 没有任何 HOST_*_INSERT 行引用它（S 分量声明了但播种机制不认）`)
    }
  }

  const registryStart = seedSource.indexOf('export const CHAMBER_HOST_PACKAGES')
  if (registryStart === -1) {
    violations.push('未找到 CHAMBER_HOST_PACKAGES 注册表——S 分量的单一来源消失了')
    return { violations, notes }
  }
  // 声明行自带 `Descriptor[]` —— 必须从 `=` 之后再找数组字面量，否则会把类型
  // 标注里的 `[]` 当成注册表体。
  const registryAssign = seedSource.indexOf('=', registryStart)
  const bodyStart = seedSource.indexOf('[', registryAssign)
  let depth = 1
  let bodyEnd = -1
  for (let i = bodyStart + 1; i < seedSource.length; i += 1) {
    const ch = seedSource[i]
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) { bodyEnd = i; break }
    }
  }
  if (bodyEnd === -1) {
    violations.push('CHAMBER_HOST_PACKAGES 注册表数组未闭合（解析失败）')
    return { violations, notes }
  }
  const body = seedSource.slice(bodyStart, bodyEnd)
  const registered = new Set([...body.matchAll(/insert:\s*(HOST_[A-Z0-9_]+_INSERT)/g)].map((m) => m[1]))
  for (const insert of inserts.keys()) {
    if (!registered.has(insert)) violations.push(`${insert} 未出现在 CHAMBER_HOST_PACKAGES 注册表（播种了但 S 分量看不到）`)
  }
  for (const name of registered) {
    if (!inserts.has(name)) violations.push(`CHAMBER_HOST_PACKAGES 引用了未声明的行 ${name}`)
  }
  notes.push(`C13 播种注册表：${registered.size} 行 / ${packageNames.size} 个包名常量一一对应`)
  return { violations, notes }
}

// ---------------------------------------------------------------------------
// C14 —— manifest 三方字段集镜像
// ---------------------------------------------------------------------------

/** 去掉注释（字符串感知：引号内的 `//`/`/*` 不是注释）。 */
export function stripComments(source) {
  let out = ''
  let quote = null
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote !== null) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 1
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

/**
 * 提取 `interface <name> { … }` 的顶层**成员文本**（`name?: type`，保持出现顺序）。
 * 与 {@link interfaceFields} 同一套分段逻辑，但保留类型文本——C14 的行类型镜像要比较
 * role/owner 的**字面量并集**，只有字段名是不够的（2026-12 review）。
 *
 * @param {string} source - TS/TSX 源码文本。
 * @param {string} interfaceName - 接口名。
 * @returns {string[] | null} 成员文本数组；接口不存在时 null。
 */
export function interfaceMembers(source, interfaceName) {
  const code = stripComments(source)
  const declRe = new RegExp(`\\binterface\\s+${interfaceName}\\b`)
  const decl = declRe.exec(code)
  if (decl === null) return null
  const open = code.indexOf('{', decl.index)
  if (open === -1) return null
  let depth = 0
  let end = -1
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i]
    if (ch === '{' || ch === '[' || ch === '(') depth += 1
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) return null
  return splitMembers(code.slice(open + 1, end))
}

/** 顶层成员分段（`;`/`,`/换行，括号深度 0 处）——interfaceFields 与 interfaceMembers 共用。 */
function splitMembers(body) {
  const segments = []
  const push = (segment) => {
    const trimmed = segment.trim()
    if (/^(?:readonly\s+)?[A-Za-z_$][\w$]*\s*\??\s*:/.test(trimmed)) segments.push(trimmed)
  }
  let segStart = 0
  let inner = 0
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === '{' || ch === '[' || ch === '(') inner += 1
    else if (ch === '}' || ch === ']' || ch === ')') inner -= 1
    else if (inner === 0 && (ch === ';' || ch === ',' || ch === '\n')) {
      push(body.slice(segStart, i))
      segStart = i + 1
    }
  }
  push(body.slice(segStart))
  return segments
}

/**
 * 提取 `interface <name> { … }` 的顶层字段名（保持出现顺序）。
 * 括号深度跟踪：字段类型里的对象字面量/数组/函数签名不会污染顶层字段集。
 *
 * @param {string} source - TS/TSX 源码文本。
 * @param {string} interfaceName - 接口名。
 * @returns {string[] | null} 字段名数组；接口不存在时 null（调用方判为违规）。
 */
export function interfaceFields(source, interfaceName) {
  const code = stripComments(source)
  const declRe = new RegExp(`\\binterface\\s+${interfaceName}\\b`)
  const decl = declRe.exec(code)
  if (decl === null) return null
  const open = code.indexOf('{', decl.index)
  if (open === -1) return null
  let depth = 0
  let end = -1
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i]
    if (ch === '{' || ch === '[' || ch === '(') depth += 1
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) return null
  const body = code.slice(open + 1, end)
  return splitMembers(body).map(member => /^(?:readonly\s+)?([A-Za-z_$][\w$]*)/.exec(member)[1])
}

/** C14 的三方对照表：同一 wire 事实的三处声明。 */
export const MANIFEST_MIRRORS = [
  { fact: 'RemotePluginManifest', producer: 'RemotePluginManifest', preload: 'SshRemotePluginManifest', renderer: 'RemotePluginManifest' },
  { fact: 'LocalPluginManifest', producer: 'LocalPluginManifest', preload: 'SshLocalPluginManifest', renderer: 'LocalPluginManifest' },
]

/**
 * C14 的**嵌套行类型**对照表：`rows` 元素的三处声明（producer 在 control-plane
 * 的 `PluginRow`，wire 两处是 `PluginRowProjection`，渲染端自持 `PluginRowShape`）。
 * 宿主接口的字段名一致并不能保证行内的字段集一致（2026-12 review：删掉
 * `owner?` 或收窄 role 字面量并集，原先 0 违规）。
 */
export const ROW_MIRRORS = [
  { fact: 'PluginRow', producer: 'PluginRow', preload: 'PluginRowProjection', renderer: 'PluginRowProjection' },
]

/** 从一条字段签名里取出字面量并集（`role: 'a' | 'b'` → ['a','b']；无引号 → null）。 */
function literalUnionOf(signature) {
  const literals = [...signature.matchAll(/'([^']*)'/g)].map(match => match[1])
  return literals.length === 0 ? null : literals.sort()
}

/**
 * 嵌套行类型的字段名 + 字面量并集对照。比宿主接口那层**浅一层**：
 * 字段名集合必须一致；值域是字面量并集的字段（role / owner）并集也必须一致；
 * 其余字段的类型文本允许命名类型与字面量并集不同（`PluginRowRole` vs `'composition' | …`），
 * 但仍要求字段名存在。
 */
export function rowMirrorFindings({ producerSource, preloadSource, rendererSource }) {
  const violations = []
  for (const mirror of ROW_MIRRORS) {
    const producer = interfaceMembers(producerSource, mirror.producer)
    const preload = interfaceMembers(preloadSource, mirror.preload)
    const renderer = interfaceMembers(rendererSource, mirror.renderer)
    if (producer === null || preload === null || renderer === null) {
      violations.push(`C14 ${mirror.fact}：行类型在 ${producer === null ? 'producer' : preload === null ? 'preload' : 'renderer'} 侧找不到声明`)
      continue
    }
    const nameOf = (field) => field.split(':')[0].trim()
    const producerNames = producer.map(nameOf)
    const preloadNames = preload.map(nameOf)
    const rendererNames = renderer.map(nameOf)
    const setOf = (list) => new Set(list)
    const diff = (a, b) => [...a].filter(name => !b.has(name))
    for (const [leftName, left, rightName, right] of [
      ['producer', producerNames, 'preload', preloadNames],
      ['preload', preloadNames, 'renderer', rendererNames],
    ]) {
      const onlyLeft = diff(setOf(left), setOf(right))
      const onlyRight = diff(setOf(right), setOf(left))
      if (onlyLeft.length > 0 || onlyRight.length > 0) {
        violations.push(`C14 ${mirror.fact}：${leftName} ↔ ${rightName} 行字段漂移（${leftName} 独有 ${onlyLeft.join(',') || '—'}；${rightName} 独有 ${onlyRight.join(',') || '—'}）`)
      }
    }
    // 字面量并集字段（role / owner）：把三处的并集对齐，删值/加值都必须红。
    for (const fieldName of ['role', 'owner']) {
      const producerField = producer.find(field => nameOf(field) === fieldName)
      if (producerField === undefined) continue
      const preloadField = preload.find(field => nameOf(field) === fieldName)
      const rendererField = renderer.find(field => nameOf(field) === fieldName)
      const unions = [
        ['producer', producerField === undefined ? null : literalUnionOf(producerField)],
        ['preload', preloadField === undefined ? null : literalUnionOf(preloadField)],
        ['renderer', rendererField === undefined ? null : literalUnionOf(rendererField)],
      ]
      const present = unions.filter(([, union]) => union !== null)
      if (present.length < 2) continue
      const reference = present[0][1].join('|')
      for (const [side, union] of present) {
        if (union.join('|') !== reference) {
          violations.push(`C14 ${mirror.fact}.${fieldName}：${side} 的字面量并集与 ${present[0][0]} 不一致（${union.join(',')} vs ${present[0][1].join(',')}）`)
        }
      }
    }
  }
  return { violations, notes: violations.length === 0 ? [`C14 行类型镜像：${ROW_MIRRORS.length} 组字段名/值域一致`] : [] }
}

/**
 * C14 判据：producer ↔ preload ↔ renderer 的字段集必须逐字一致
 * （ipc-surface-mirror.test.ts 只覆盖 preload ↔ renderer 两道门，producer 侧裸奔）。
 * 宿主接口之后还要过 {@link rowMirrorFindings}（`rows` 的**元素**类型）。
 *
 * @param {{ producerSource: string, preloadSource: string, rendererSource: string }} input
 * @returns {{ violations: string[], notes: string[] }}
 */
export function manifestMirrorFindings({ producerSource, preloadSource, rendererSource, rowProducerSource = producerSource }) {
  const violations = []
  const notes = []
  for (const mirror of MANIFEST_MIRRORS) {
    const producer = interfaceFields(producerSource, mirror.producer)
    const preload = interfaceFields(preloadSource, mirror.preload)
    const renderer = interfaceFields(rendererSource, mirror.renderer)
    for (const [side, fields] of [['producer', producer], ['preload', preload], ['renderer', renderer]]) {
      if (fields === null) violations.push(`C14 ${mirror.fact}：${side} 侧找不到接口声明`)
    }
    if (producer === null || preload === null || renderer === null) continue
    const producerSet = new Set(producer)
    const preloadSet = new Set(preload)
    const rendererSet = new Set(renderer)
    const diff = (a, b) => [...a].filter((field) => !b.has(field))
    const onlyProducer = diff(producerSet, preloadSet)
    const onlyPreload = diff(preloadSet, producerSet)
    if (onlyProducer.length > 0 || onlyPreload.length > 0) {
      violations.push(`C14 ${mirror.fact}：producer ↔ preload 字段集漂移（producer 独有 ${onlyProducer.join(',') || '—'}；preload 独有 ${onlyPreload.join(',') || '—'}）`)
    }
    if (preload.join('|') !== renderer.join('|')) {
      violations.push(`C14 ${mirror.fact}：preload ↔ renderer 字段集/顺序漂移（preload ${preload.join(',')}；renderer ${renderer.join(',')}）`)
    }
  }
  const rows = rowMirrorFindings({ producerSource: rowProducerSource, preloadSource, rendererSource })
  violations.push(...rows.violations)
  if (violations.length === 0) {
    notes.push(`C14 manifest 三方镜像：${MANIFEST_MIRRORS.length} 组宿主字段集一致`)
    notes.push(...rows.notes)
  }
  return { violations, notes }
}
