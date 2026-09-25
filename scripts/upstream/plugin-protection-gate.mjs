import {
  RUNTIME_FAMILY_CORE,
  RUNTIME_FAMILY_FORBIDDEN,
  RUNTIME_FAMILY_OPT_IN_ALLOWED,
  RUNTIME_FAMILY_OPT_IN_PATTERN,
  familyNamesFromLockfileClosure,
  runtimeFamilyNameFindings,
} from '../../packages/control-plane/src/runtime-family.ts'

/**
 * plugin-protection-gate.mjs — C11–C14 的纯判据（docs/checklists/upstream-touchpoints.md
 * §6 的机器侧；design 21 §6.11「受保护集合与代耦合」的保鲜门）。
 *
 * 为什么单独成模块：`verify-upstream-touchpoints.mjs` 是顶层过程式程序、不可被
 * 测试 import（与 verify-upstream-touchpoints-args.mjs 同一拆法）。这里只放
 * **纯函数**（无 fs、无 process）：调用方读文件/读目录，把文本与名字数组传进来，
 * 拿回 `{violations, notes}`，再由调用方决定 fail/warn。于是每条判据都能用合成
 * 夹具做**负例**测试（改坏派生来源/契约/播种/镜像 → 必须变红）。
 *
 * 判据的**单一来源**：C11 的核心锚/禁名判据与锁文件解析器都直接 import 运行时 leaf
 * `packages/control-plane/src/runtime-family.ts`（node 24 直接跑 TS，零 workspace
 * 裸依赖——本门在 CI 的 `pnpm install` 之前运行，必须不触达 wire 等裸包名），
 * 所以"门禁判据"与"运行时判据"不可能再漂移。
 *
 * 四门的语义（design 21 §6.11）：
 * - C11 运行时线族集合：受保护集合的 F 分量只有一个权威来源——**已提交**的
 *   `packages/desktop/vendor/dsh/pnpm-lock.yaml` 闭包；实例树枚举只作等价性
 *   交叉校验。dev/test 包与源码线 harness 段**绝不**属于 F。官方 opt-in 段自
 *   dsh 0.1.6-alpha.2 起不再是无条件禁名（运行时根包自己声明了这些依赖），判据
 *   收窄为**登记白名单**（`RUNTIME_FAMILY_OPT_IN_ALLOWED`）：未登记的
 *   experimental 名字仍红（取错来源 / 上游新提升），已登记名字不再出现在闭包里
 *   也红（上游移除/改名）——两条都逼出「重新从锁文件 derive 并显式登记」。锁文件
 *   原文出现 `@dsh-chamber/` 引用也红（F 的唯一来源被污染；解析器只取
 *   `@deepseek-ai/*`，故只能按原文判定）。
 * - C12 profile 契约锚：上游仍以 `dsh.profile.bundles` 承载层列表、以
 *   `dsh.bundle.patch` 声明层、web 模板默认组合不变、profile workspace 仍是
 *   hoisted + 不自动装 peer。三个锚点文件（profile 读取/初始化、plugin-manager
 *   的 reconcile、CLI 的 init 入口）都必须可读。任一漂移 ⇒ 停升级、改派生（B₀ 快照）。
 * - C13 播种注册表结构：`HOST_*_PACKAGE_NAME` 常量 ↔ `HOST_*_INSERT` 行 ↔
 *   `CHAMBER_HOST_PACKAGES` 注册表三面一一对应（漏登记即 S 分量失真）。
 * - C14 plugin-row 单源 + manifest 三方镜像：行形状的唯一声明在 wire 的
 *   `./plugin-row` 面（字段集与 role 并集 = 本门预期锚），五个消费方
 *   （control-plane / client-core face / preload / renderer / settings-connections）
 *   只许 import/type 引用；manifest 宿主接口另做 producer ↔ preload ↔ renderer
 *   字段集对照（ipc-surface-mirror 只覆盖后两者，本门补上 producer 侧）。
 */

/**
 * 核心锚与禁名形态**不在本文件声明**：运行时（`protected-plugins.ts` 的
 * `runtimeFamilyFindings`）与 C11 必须用同一份判据，否则"门禁绿而运行时另有一套"
 * 就没有意义。这里只做再导出，保持一致与向后兼容。
 */
export const FAMILY_CORE = RUNTIME_FAMILY_CORE

/** 绝不属于 F 的名字形态（同源，label 也在模块里，避免两套文案）。 */
export const FAMILY_FORBIDDEN = RUNTIME_FAMILY_FORBIDDEN

/** 官方 opt-in 段：只允许登记白名单内的名字（同源）。 */
export const FAMILY_OPT_IN_ALLOWED = RUNTIME_FAMILY_OPT_IN_ALLOWED

/** 平台分包：允许「闭包有、本平台树无」——`node-addon-system-*`（原生插件）与
 *  `libreoffice-kit-*`（office-to-pdf 带的办公套件运行时，含一个 `-wasm` 包）。 */
const PLATFORM_PACK_RE = /^@deepseek-ai\/(?:node-addon-system-|libreoffice-kit-)/

/** 闭包解析的健全性下限（当前运行时线 ≈ 291；解析坏了必须响亮）。 */
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
 * @param {{ names: string[], treeNames: string[] | null, sourceTreeNames?: string[] | null, lockfileText?: string | null }} input
 *   `names` = `runtimeFamilyNames()` 结果；`treeNames` = 活动运行时树
 *   `node_modules/@deepseek-ai/*` 的枚举（未物化传 null ⇒ 只跳过等价性校验）；
 *   `sourceTreeNames` = 可选：源码线 `vendor/harness-packages/@deepseek-ai/*` 枚举，
 *   仅用于产出一条提醒性 note（源码线不是 F 的来源）；`lockfileText` = 可选：
 *   产生 `names` 的锁文件原文，传了就扫描 `@dsh-chamber/` 引用（F 来源污染），
 *   不传（合成夹具）则跳过。
 * @returns {{ violations: string[], notes: string[] }}
 */
export function familyFindings({ names, treeNames, sourceTreeNames = null, lockfileText = null }) {
  const violations = []
  const notes = []

  if (names.length < MIN_FAMILY_SIZE) {
    violations.push(`运行时线闭包只解析出 ${names.length} 个 @deepseek-ai/*（< ${MIN_FAMILY_SIZE}）——锁文件格式变了或解析失配`)
    return { violations, notes }
  }

  const nameSet = new Set(names)
  // 名字集合判据的唯一实现在运行时 leaf 模块（核心锚 / 禁名 / opt-in 登记白名单），这里
  // 只把它映射成门禁文案——门禁与运行时不可能再各自漂移。
  for (const finding of runtimeFamilyNameFindings(names)) {
    if (finding.kind === 'missing-core') {
      violations.push(`运行时线闭包缺少核心包 ${finding.name}`)
    } else if (finding.kind === 'forbidden') {
      violations.push(`运行时线闭包混入${finding.label}：${finding.name}（dev/test 与源码线 harness 段必须不在 F 内）`)
    } else {
      violations.push(`运行时线闭包混入未登记的官方 opt-in 包：${finding.name}（要么取错来源，要么上游把新 opt-in 层提成了运行时依赖——必须重新裁决后登记）`)
    }
  }
  // 白名单保鲜的第二臂：已登记名字必须仍出现在闭包里（上游移除/改名 ⇒ 删登记，不静默留白名单）。
  for (const allowed of FAMILY_OPT_IN_ALLOWED) {
    if (!nameSet.has(allowed)) {
      violations.push(`运行时线闭包不再包含已登记的官方 opt-in 包 ${allowed}——上游已移除/改名；重新从锁文件 derive 并删除本登记（白名单只登记实测在闭包里的名字）`)
    }
  }
  // F 的来源本身必须是上游锁文件。解析器按 scope 只取 `@deepseek-ai/*`，所以
  // 「chamber 包混进 names」按构造不可能；能真实发生的污染形态是锁文件**文本**里出现
  // `@dsh-chamber/` 引用（取错锁文件 / 被 chamber workspace 锁文件覆盖），故这里扫原文。
  // 不传文本（合成夹具）即跳过：没有原文就无法区分「干净」与「没检查」以外的结论。
  if (lockfileText !== null && lockfileText.includes('@dsh-chamber/')) {
    violations.push('运行时线锁文件的文本里出现 @dsh-chamber/ 引用——F 的唯一来源被污染（取错锁文件/混入 chamber workspace 条目）；恢复上游运行时锁文件后重跑')
  }

  if (treeNames !== null) {
    const treeSet = new Set(treeNames)
    const missing = names.filter((name) => !treeSet.has(name))
    const extra = treeNames.filter((name) => !nameSet.has(name))
    const unexpectedMissing = missing.filter((name) => !PLATFORM_PACK_RE.test(name))
    if (unexpectedMissing.length > 0) {
      violations.push(`运行时树缺少闭包中的非平台分包：${unexpectedMissing.join(', ')}（枚举派生与锁文件派生不等价）`)
    }
    if (extra.length > 0) {
      violations.push(`运行时树出现闭包外的 @deepseek-ai/*：${extra.join(', ')}`)
    }
    const platformOnly = missing.filter((name) => PLATFORM_PACK_RE.test(name))
    notes.push(`C11 等价性校验：闭包 ${names.length} / 树 ${treeNames.length}（允许的平台分包差：${platformOnly.length}）`)
  } else {
    notes.push('C11 等价性校验跳过：活动运行时树未物化（仅校验锁文件闭包；CI 打包腿会交叉校验）')
  }

  if (sourceTreeNames !== null) {
    // 源码线是 opt-in 层的家，也是 dev/test 包的家——两者都算进这条提醒（运行时闭包侧
    // 才需要白名单判定）。
    const optIn = sourceTreeNames.filter((name) => RUNTIME_FAMILY_OPT_IN_PATTERN.test(name)
      || FAMILY_FORBIDDEN.some((rule) => rule.pattern.test(name)))
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
 * 全部锚点在 pin 住的上游源码上实测命中，三个来源：
 * - `profile` = `packages/boot/app-boot/src/profile.ts`（manifest 模型、init 与加载）；
 * - `manager` = `packages/boot/plugin-manager/src/operations.ts`（rc.2 起 `dsh plugin`
 *   的 pnpm 转发与 reconcile 落在这里，apps/cli/src/plugin.ts 只剩入口壳）；
 * - `plugin` = `apps/cli/src/plugin.ts`（CLI 入口：init 走模板组合）。
 */
export const PROFILE_CONTRACT_ANCHORS = [
  { file: 'profile', label: 'web 模板默认组合（B₀ 快照的对拍对象）', needles: ["web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']"] },
  { file: 'profile', label: '模板表存在', needles: ['PROFILE_TEMPLATES'] },
  { file: 'profile', label: '无模板 profile 的默认组合常量', needles: ['DEFAULT_PROFILE_BUNDLES'] },
  { file: 'profile', label: 'profile workspace 链接器', needles: ['nodeLinker: hoisted'] },
  { file: 'profile', label: 'profile workspace 不自动装 peer', needles: ['autoInstallPeers: false'] },
  { file: 'profile', label: '层列表落盘键 dsh.profile.bundles', needles: ['dsh: { profile: { bundles:'] },
  { file: 'profile', label: 'bundle 的层声明键 dsh.bundle.patch（profile 加载侧）', needles: ['dsh?.bundle', 'dsh.bundle.patch must be a file path or a list of file paths'] },
  { file: 'manager', label: '层由 dsh.bundle.patch 声明', needles: ['dsh?.bundle?.patch'] },
  { file: 'manager', label: '层列表按已安装状态 reconcile', needles: ['dsh?.profile?.bundles'] },
  { file: 'manager', label: '非层依赖的既有告警语义', needles: ['declares no dsh.bundle'] },
  { file: 'plugin', label: 'init 走模板组合', needles: ['DEFAULT_PROFILE_BUNDLES'] },
]

/** 空白归一：只压空白，不改字符。 */
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ')
}

/**
 * C12 判据。
 *
 * @param {{ profileSource: string | null, pluginSource: string | null,
 *   managerSource: string | null }} input
 *   三个上游源码文本（profile / plugin-manager / CLI 入口）；null = 该文件读不到。
 *   **全部**读不到 = 子模块未物化（调用方给出 note，不当违规——C1/C3/C5 已经会对缺失
 *   子模块响亮失败）；**部分**读不到 = 改名/搬移，是违规（任一文件搬走时，它所属的锚点
 *   会被静默丢掉且连 note 都没有）。
 * @returns {{ violations: string[], notes: string[] }}
 */
export function profileContractFindings({ profileSource, pluginSource, managerSource }) {
  const violations = []
  const notes = []
  const sources = { profile: profileSource, plugin: pluginSource, manager: managerSource }
  const owners = new Map()
  for (const anchor of PROFILE_CONTRACT_ANCHORS) {
    owners.set(anchor.file, (owners.get(anchor.file) ?? 0) + 1)
  }
  const unreadable = [...owners.keys()]
    .filter((file) => sources[file] === null || sources[file] === undefined)
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
  if (checked === 0) {
    notes.push('C12 跳过：vendor/harness-checkout 未物化（CI 在 Bootstrap 后硬门）')
  } else if (unreadable.length > 0) {
    const lost = unreadable.reduce((sum, file) => sum + (owners.get(file) ?? 0), 0)
    violations.push(
      `C12 上游锚点所属文件读不到（${unreadable.join(', ')}）——${lost} 条锚点无法判定；`
      + '树已部分物化，故按改名/搬移处理：核对 docs/checklists/upstream-touchpoints.md §6 的锚点登记'
      + '与上游新路径后更新本门，绝不按通过处理',
    )
  }
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

/** 去掉注释（字符串感知：引号内的 `//`/`/*` 不是注释）。
 *
 * 刻意不复用 `scripts/dev/test-support/source-text.ts` 的同名助手：本门要在**未安装的工作区**
 * （CI 的静态步骤、以及 preflight 的裸 checkout 路径）里独立运行，不能依赖任何 dev 侧模块；
 * 且这里只需要「代码投影」，不需要保行/归一化。两处实现由各自的用例锁定。 */
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
 * 与 {@link interfaceFields} 同一套分段逻辑，但保留类型文本——C14 的 plugin-row
 * 单源判据要逐字比较字段签名（字段名、可选性、类型），只有字段名是不够的。
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

/** C14 的宿主接口三方对照表：manifest 字段集（producer ↔ preload ↔ renderer）。
 *  行类型（rows 元素）不再三方对照——它已收敛为单源，由
 *  {@link pluginRowSingleSourceFindings} 按「单源 + 消费方只引用不重声明」判定。 */
export const MANIFEST_MIRRORS = [
  { fact: 'RemotePluginManifest', producer: 'RemotePluginManifest', preload: 'SshRemotePluginManifest', renderer: 'RemotePluginManifest' },
  { fact: 'LocalPluginManifest', producer: 'LocalPluginManifest', preload: 'SshLocalPluginManifest', renderer: 'LocalPluginManifest' },
]

/**
 * plugin-row 的**唯一**声明（wire 的 ./plugin-row 面）：文件、引用面与预期内容锚。
 * 单源文件本身也必须与这里的预期逐字一致——字段缺失/改名/顺序漂移/role 并集收窄都会红。
 */
export const PLUGIN_ROW_SINGLE_SOURCE = Object.freeze({
  path: 'packages/dsh-chamber-wire/src/plugin-row.ts',
  specifier: '@dsh-chamber/dsh-chamber-wire/plugin-row',
  interface: 'PluginRow',
  roleAlias: 'PluginRowRole',
  members: [
    'name: string',
    'spec: string | null',
    'version: string | null',
    'role: PluginRowRole',
    'protected: boolean',
  ],
  role: ['composition', 'seed', 'layer', 'third-party', 'materialized', 'unknown'],
})

/**
 * plugin-row 的消费方表：每一处必须从指定**引用面**类型引用指定本地名，且不得在本地
 * 声明行形状。引用面 = wire 面（packages with a declared wire dependency）或 client-core
 * 的浏览器面（preload / renderer / settings-connections：包内没有 wire link，只能经
 * client-core 的 pass-through 面到达同一单源）。
 *
 * C14 的强度 = 单源声明 = 预期 且 每个消费方只有 import/type 引用：
 * 「本地重声明字段」「引用面漂移」「单源字段缺失」任一发生都硬失败。
 */
export const PLUGIN_ROW_CONSUMERS = Object.freeze([
  {
    side: 'control-plane',
    source: 'packages/control-plane/src/protected-plugins.ts',
    specifier: '@dsh-chamber/dsh-chamber-wire/plugin-row',
    names: ['PluginRow', 'PluginRowRole'],
  },
  {
    side: 'client-core-face',
    source: 'packages/dsh-chamber-client-core/src/plugin-row.ts',
    specifier: '@dsh-chamber/dsh-chamber-wire/plugin-row',
    names: ['PluginRow', 'PluginRowRole'],
  },
  {
    side: 'preload',
    source: 'packages/desktop/preload.cts',
    specifier: '@dsh-chamber/dsh-chamber-client-core/plugin-row',
    names: ['PluginRowProjection'],
  },
  {
    side: 'renderer',
    source: 'packages/renderer/src/global.d.ts',
    specifier: '@dsh-chamber/dsh-chamber-client-core/plugin-row',
    names: ['PluginRowProjection'],
  },
  {
    side: 'settings-connections',
    source: 'packages/dsh-chamber-client-ui-settings-connections/src/client/plugin-model.ts',
    specifier: '@dsh-chamber/dsh-chamber-client-core/plugin-row',
    names: ['PluginRowShape', 'PluginRowRoleShape'],
  },
])

/** 消费方一律不得本地声明的名字（含历史别名；*Shape 只许来自 import 别名）。 */
const PLUGIN_ROW_LOCAL_DECLARATION_NAMES = [
  'PluginRow',
  'PluginRowRole',
  'PluginRowProjection',
  'PluginRowShape',
  'PluginRowRoleShape',
]

/** 成员签名归一：连续空白 → 单空格（与 interfaceMembers 的 trim 衔接）。 */
function normalizeMember(member) {
  return member.replace(/\s+/g, ' ').trim()
}

/** specifier → 正则字面量（specifier 只含 @ / - . 字符；转义 . 即足够，保持本门零依赖）。 */
function quoteSpecifier(specifier) {
  return specifier.split('.').join('\\.')
}

/**
 * 取同名类型别名的字面量并集（找不到 / 读不出返回 null——调用方按漂移处理，
 * 绝不把「读不出」当作「这一侧不算数」）。别名体在下个顶层声明或空行处结束
 * （本仓风格省略分号，不能按 ; 截断）。
 */
function typeAliasLiterals(source, aliasName) {
  const code = stripComments(source)
  const decl = new RegExp(
    '\\btype\\s+' + aliasName + '\\b\\s*=([\\s\\S]*?)(?=\\n\\s*\\n|\\n\\s*(?:export|type|interface|declare|const|function|\\/\\*)|$)',
  ).exec(code)
  if (decl === null) return null
  const literals = [...decl[1].matchAll(/'([^']*)'/g)].map((match) => match[1])
  return literals.length === 0 ? null : literals
}

/**
 * 从一条 import/export type 语句里取「从该 specifier 绑定的本地名」。
 * 支持 "import type { A, B as C } from '…'" 与 "export type { A } from '…'" 两种形态
 * （control-plane 的纯再导出没有 from，引用面由它自己的 import 语句承担）。
 */
function boundNamesFromFace(code, specifier) {
  const re = new RegExp(
    '(?:import|export)\\s+type\\s*\\{([^}]*)\\}\\s*from\\s*[\'"]' + quoteSpecifier(specifier) + '[\'"]',
    'g',
  )
  const bound = new Set()
  for (const match of code.matchAll(re)) {
    for (const part of match[1].split(',')) {
      const clause = part.trim().replace(/^type\s+/, '')
      if (clause === '') continue
      const [imported, local] = clause.split(/\s+as\s+/)
      bound.add((local === undefined ? imported : local).trim())
    }
  }
  return bound
}

/**
 * C14 的 plugin-row 单源判据（design 21 §6.11.5 单一定义）：
 * ① 单源文件 {@link PLUGIN_ROW_SINGLE_SOURCE} 的声明必须逐字等于预期字段集与 role
 *    并集（单源字段缺失 / 改名 / 漂移即红）；
 * ② 每个消费方必须从自己的引用面**类型**引用期待本地名（引用面漂移即红）；
 * ③ 每个消费方都不得本地声明任何 wire 行名（本地重声明字段即红）。
 *
 * @param {{ singleSource: string, consumers: Record<string, string> }} input
 *   singleSource = wire ./plugin-row 源文本；consumers = side → 消费方源文本。
 * @returns {{ violations: string[], notes: string[] }}
 */
export function pluginRowSingleSourceFindings({ singleSource, consumers }) {
  const violations = []
  const notes = []
  const anchor = PLUGIN_ROW_SINGLE_SOURCE
  const members = interfaceMembers(singleSource, anchor.interface)
  if (members === null) {
    violations.push('C14 plugin-row 单源：' + anchor.path + ' 里找不到 interface ' + anchor.interface + ' 声明——唯一来源被改名/搬走')
  } else {
    const actual = members.map(normalizeMember)
    const expected = anchor.members.map(normalizeMember)
    const missing = expected.filter((member) => !actual.includes(member))
    const extra = actual.filter((member) => !expected.includes(member))
    if (missing.length > 0 || extra.length > 0 || actual.join('|') !== expected.join('|')) {
      violations.push(
        'C14 plugin-row 单源：' + anchor.interface + ' 字段集与预期不一致（缺失 ' + (missing.join(' / ') || '—')
        + '；漂移/多出 ' + (extra.join(' / ') || '—') + '；实际 ' + actual.join(' / ') + '）',
      )
    }
  }
  const role = typeAliasLiterals(singleSource, anchor.roleAlias)
  if (role === null) {
    violations.push('C14 plugin-row 单源：读不出 ' + anchor.roleAlias + ' 的字面量并集——单一来源被改成不透明类型')
  } else if (role.join('|') !== anchor.role.join('|')) {
    violations.push('C14 plugin-row 单源：' + anchor.roleAlias + ' 并集与预期不一致（' + role.join(', ') + '）')
  }

  for (const consumer of PLUGIN_ROW_CONSUMERS) {
    const source = consumers === undefined || consumers === null ? undefined : consumers[consumer.side]
    if (typeof source !== 'string' || source === '') {
      violations.push('C14 plugin-row 消费方 ' + consumer.side + '：读不到 ' + consumer.source)
      continue
    }
    const code = stripComments(source)
    const bound = boundNamesFromFace(code, consumer.specifier)
    if (bound.size === 0) {
      violations.push(
        'C14 plugin-row 消费方 ' + consumer.side + '：引用面漂移——没有从 \'' + consumer.specifier
        + '\' 的 import/export type（单源只能经该面到达）',
      )
    } else {
      for (const name of consumer.names) {
        if (!bound.has(name)) {
          violations.push('C14 plugin-row 消费方 ' + consumer.side + '：\'' + consumer.specifier + '\' 面未绑定本地名 ' + name)
        }
      }
    }
    for (const name of PLUGIN_ROW_LOCAL_DECLARATION_NAMES) {
      if (new RegExp('\\b(?:interface|type)\\s+' + name + '\\b').test(code)) {
        violations.push('C14 plugin-row 消费方 ' + consumer.side + '：本地重声明 ' + name + '——字段集只允许存在于单源文件')
      }
    }
  }

  if (violations.length === 0) {
    notes.push('C14 plugin-row 单源：字段集 = 预期；' + PLUGIN_ROW_CONSUMERS.length + ' 个消费方只引用不重声明')
  }
  return { violations, notes }
}

/**
 * C14 判据（宿主 manifest 层）：producer ↔ preload ↔ renderer 的字段集必须逐字一致
 * （test/ipc/ipc-surface-mirror.test.ts 只覆盖 preload ↔ renderer 两道门；本门把 producer
 * 侧也纳入）。行类型层由 {@link pluginRowSingleSourceFindings} 单独判定，调用方分别调用后合并。
 *
 * @param {{ producerSource: string, preloadSource: string, rendererSource: string }} input
 * @returns {{ violations: string[], notes: string[] }}
 */
export function manifestMirrorFindings({ producerSource, preloadSource, rendererSource }) {
  const violations = []
  const notes = []
  for (const mirror of MANIFEST_MIRRORS) {
    const producer = interfaceFields(producerSource, mirror.producer)
    const preload = interfaceFields(preloadSource, mirror.preload)
    const renderer = interfaceFields(rendererSource, mirror.renderer)
    for (const [side, fields] of [['producer', producer], ['preload', preload], ['renderer', renderer]]) {
      if (fields === null) violations.push('C14 ' + mirror.fact + '：' + side + ' 侧找不到接口声明')
    }
    if (producer === null || preload === null || renderer === null) continue
    const producerSet = new Set(producer)
    const preloadSet = new Set(preload)
    const diff = (a, b) => [...a].filter((field) => !b.has(field))
    const onlyProducer = diff(producerSet, preloadSet)
    const onlyPreload = diff(preloadSet, producerSet)
    if (onlyProducer.length > 0 || onlyPreload.length > 0) {
      violations.push('C14 ' + mirror.fact + '：producer ↔ preload 字段集漂移（producer 独有 ' + (onlyProducer.join(',') || '—') + '；preload 独有 ' + (onlyPreload.join(',') || '—') + '）')
    }
    if (preload.join('|') !== renderer.join('|')) {
      violations.push('C14 ' + mirror.fact + '：preload ↔ renderer 字段集/顺序漂移（preload ' + preload.join(',') + '；renderer ' + renderer.join(',') + '）')
    }
  }
  if (violations.length === 0) {
    notes.push('C14 manifest 三方镜像：' + MANIFEST_MIRRORS.length + ' 组宿主字段集一致')
  }
  return { violations, notes }
}
