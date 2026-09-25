/**
 * runtime-family.ts — 运行时线族闭包的锚、禁名判据与锁文件名字解析：**leaf 模块**。
 *
 * 门禁在 `pnpm install` 之前运行，裸 workspace 包名尚不可解析，因此锚与名字解析必须零
 * import（只用 RegExp，node 24 可直接运行 TS）；protected-plugins.ts 从这里 import 并原样
 * re-export，门禁判据与运行时判据因此是同一份。
 */

/** 运行时线闭包的核心锚：F 少了任何一个都说明取错了来源（源码线/裁剪过的树/外来锁文件）。 */
export const RUNTIME_FAMILY_CORE: readonly string[] = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
]

/** 官方 opt-in 段（`dsh-experimental-*`）的名字形态：不再是无条件禁名（见白名单）。 */
export const RUNTIME_FAMILY_OPT_IN_PATTERN = /^@deepseek-ai\/dsh-experimental-/

/**
 * 允许出现在 F 里的官方 opt-in 包（rc.2 运行时锁文件闭包实测）。
 *
 * 事实来源：运行时根包 `@deepseek-ai/dsh` 把 opt-in 能力声明为自己的运行时依赖
 * （agent-team / voice-input / speech-to-text / auto-review 家族；其余名字由这些依赖边
 * 引入），上游同时把它们登记进 `OPTIONAL_BUNDLES`——语义是「运行时依赖 + 不被任何
 * shipped 模板选中 + 由插件管理器提供开关」。因此它们**确实是运行时线提供的模块**，
 * 按 F 的语义（运行时提供 ⇒ 受保护）应当在场：experimental 名字不再等于「取错了来源」。
 *
 * 维护纪律：本表只登记**已在闭包里实测出现**的名字，且双向受 C11 判定——上游新增 ⇒
 * 未登记名字红；上游移除/改名 ⇒ 已登记名字不再出现也红。两条都逼出「重新从锁文件
 * derive 并显式登记」的人工裁决，绝不静默放行。
 */
export const RUNTIME_FAMILY_OPT_IN_ALLOWED: readonly string[] = [
  '@deepseek-ai/dsh-experimental-agent-team',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-api-speech-to-text',
  '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-client-ui-agent-team',
  '@deepseek-ai/dsh-experimental-client-ui-voice-input',
  '@deepseek-ai/dsh-experimental-speech-to-text',
  '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice',
  '@deepseek-ai/dsh-experimental-tool-agent-team',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
]

/**
 * F 里**绝不允许**出现的包：dev/test 段与源码线 harness 段。出现即说明用了源码线闭包
 * （design 21 §6.11.1 明确排除）。官方 opt-in 段由 {@link RUNTIME_FAMILY_OPT_IN_ALLOWED}
 * 单独判定，不属于本表。
 */
export const RUNTIME_FAMILY_FORBIDDEN: readonly { pattern: RegExp; label: string; why: string }[] = [
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

/** 一条名字集合判据的 finding：运行时拒绝理由与 C11 门禁违规文案共用同一份判定。 */
export interface RuntimeFamilyNameFinding {
  kind: 'missing-core' | 'forbidden' | 'unregistered-opt-in'
  /** 触发判定的名字（missing-core 为缺失的核心锚名）。 */
  name: string
  /** 面向人的短语（dev/test 规则取规则自己的 label）。 */
  label: string
  /** 为什么这是坏形态。 */
  why: string
}

/**
 * 名字集合的族判据（**唯一实现**）：核心锚齐全 + 不含 dev/test 与源码线 harness 段 +
 * 官方 opt-in 只许登记白名单内的名字。运行时（`protected-plugins.ts` 的
 * `runtimeFamilyFindings`）与 C11 门禁都经这里判定，杜绝两套逻辑漂移；门禁额外做
 * 解析健全性下限、白名单保鲜与实例树等价性校验，那些不属于「闭包是否可信」。
 *
 * @param names - 一个候选闭包的 `@deepseek-ai/*` 名字集合（未排序也可）。
 * @returns 每条命中判据的 finding（按先核心锚、再名字顺序）；空数组 = 这个名字集合可信。
 */
export function runtimeFamilyNameFindings(names: readonly string[]): RuntimeFamilyNameFinding[] {
  const findings: RuntimeFamilyNameFinding[] = []
  const set = new Set(names)
  for (const core of RUNTIME_FAMILY_CORE) {
    if (!set.has(core)) {
      findings.push({
        kind: 'missing-core',
        name: core,
        label: 'the runtime family closure is missing the core anchor',
        why: 'the closure is not the runtime line',
      })
    }
  }
  const allowed = new Set(RUNTIME_FAMILY_OPT_IN_ALLOWED)
  for (const name of names) {
    for (const rule of RUNTIME_FAMILY_FORBIDDEN) {
      if (rule.pattern.test(name)) findings.push({ kind: 'forbidden', name, label: rule.label, why: rule.why })
    }
    if (RUNTIME_FAMILY_OPT_IN_PATTERN.test(name) && !allowed.has(name)) {
      findings.push({
        kind: 'unregistered-opt-in',
        name,
        label: 'unregistered official opt-in package in the runtime closure',
        why: 're-derive the family source or register the promotion deliberately',
      })
    }
  }
  return findings
}

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
