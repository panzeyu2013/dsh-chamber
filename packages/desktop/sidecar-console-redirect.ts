/**
 * sidecar-console-redirect —— Swift flavor sidecar 的 stdout 纪律叶：
 * stdout 只允许协议写（sidecar-entry 的 writeProtocolLine），其余 console
 * 输出一律走 stderr，绝不污染 B 桥协议流。
 *
 * 在任何模块体求值时把 console.log/info/debug 覆盖为带 [sidecar] 前缀的
 * stderr 写；warn/error 保持 stderr 原去向。**必须在 sidecar-entry.ts 的
 * 第一条 import 位置被求值**：本模块零 import，重定向先于其余依赖的模块体
 * 生效，被 bundle 模块的顶层 console 输出同样走 stderr。
 *
 * 导出 safeStringify 供 sidecar-entry 的协议行序列化复用（单一实现）。
 */
import process from 'node:process'

/** JSON 序列化兜底：不可序列化值（循环引用/BigInt/函数）绝不抛，返回文本。 */
export function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/** stderr 行写（[sidecar] 前缀 + 单行；字符串原样、其余经 JSON）。 */
function stderrLine(prefix: string, args: readonly unknown[]): void {
  process.stderr.write(
    `[sidecar] ${prefix} ${args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ')}
`,
  )
}

// warn/error 保持 stderr；显式绑定原始实现，防未来替换 console 时递归覆盖。
const originalWarn = console.warn.bind(console)
const originalError = console.error.bind(console)
console.log = (...args: unknown[]) => stderrLine('console:', args)
console.info = (...args: unknown[]) => stderrLine('console:', args)
console.debug = (...args: unknown[]) => stderrLine('console:', args)
// Node 的 dir/table/count/countReset/group/groupEnd/time*/trace 默认写 stdout，
// 这里一并钉到 stderr；取舍：count/group*/time* 退化为普通日志行（不维护状态），
// 仓内无调用点，stdout 纪律优先。
console.dir = (...args: unknown[]) => stderrLine('console:', args)
console.table = (...args: unknown[]) => stderrLine('console:', args)
console.count = (...args: unknown[]) => stderrLine('console:', args)
console.countReset = (...args: unknown[]) => stderrLine('console:', args)
console.group = (...args: unknown[]) => stderrLine('console:', args)
console.groupCollapsed = (...args: unknown[]) => stderrLine('console:', args)
console.groupEnd = (...args: unknown[]) => stderrLine('console:', args)
console.time = (...args: unknown[]) => stderrLine('console:', args)
console.timeLog = (...args: unknown[]) => stderrLine('console:', args)
console.timeEnd = (...args: unknown[]) => stderrLine('console:', args)
console.trace = (...args: unknown[]) => stderrLine('console:', args)
// assert 遵循 Node 语义：仅当首参为假才打印（无条件打印会把每次断言变成噪声）。
console.assert = (condition?: unknown, ...args: unknown[]) => {
  if (condition) return
  stderrLine('console:', ['Assertion failed:', ...args])
}
console.warn = (...args: unknown[]) => originalWarn(...args)
console.error = (...args: unknown[]) => originalError(...args)
