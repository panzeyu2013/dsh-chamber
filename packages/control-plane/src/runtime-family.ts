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

/**
 * F 里**绝不允许**出现的包：opt-in 层（`dsh-experimental-*`）与 dev/test 段。
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
