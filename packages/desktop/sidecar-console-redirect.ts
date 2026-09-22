/**
 * sidecar-console-redirect.ts —— Swift flavor sidecar 的 stdout 纪律叶
 * （design 25 §3.1「stdout = B 桥协议流，stderr = 日志」）
 *
 * 硬约束：stdout 只允许协议写（sidecar-entry 的 writeProtocolLine）。本模块
 * 在任何模块体求值时把 console.log/info/debug 覆盖为带 [sidecar] 前缀的
 * stderr 写；warn/error 保持原去向（stderr）。
 *
 * **必须在 sidecar-entry.ts 的第一条 import 位置被求值**：ESM 按 import 顺序
 * 先求值依赖模块体，而本模块自身零 import——因此它的重定向先于 sidecar-entry
 * 的其余依赖（shell-core / control-plane facade / dsh-runtime / …）生效，被
 * bundle 的任何模块的顶层 console 输出也一律走 stderr，绝不污染 B 桥协议流。
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

// warn/error 原样保留（Node 的 console.warn/error 本就写 stderr；这里显式绑定
// 原始实现，防未来有人替换 console 时的递归覆盖）。
const originalWarn = console.warn.bind(console)
const originalError = console.error.bind(console)
console.log = (...args: unknown[]) => stderrLine('console:', args)
console.info = (...args: unknown[]) => stderrLine('console:', args)
console.debug = (...args: unknown[]) => stderrLine('console:', args)
// stdout 纪律要对**所有**会写 stdout 的方法成立——Node 的
// console.dir/table/count/countReset/group/groupEnd/time/timeLog/timeEnd/trace
// 默认都写 stdout（dir 走 util.inspect），这里一并钉到 stderr。
// 取舍：count/group*/time* 退化为普通日志行（不维护计数/计时/缩进状态）——仓内无
// 调用点，且 stdout 纪律优先；将来要用这些方法时需改为带状态实现（见 STATUS 登记）。
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
// assert 遵循 Node 语义：**仅当首参为假**才打印；无条件打印会把每次 assert
// 都变成噪声（Node 只在断言失败时输出并带前缀）。
console.assert = (condition?: unknown, ...args: unknown[]) => {
  if (condition) return
  stderrLine('console:', ['Assertion failed:', ...args])
}
console.warn = (...args: unknown[]) => originalWarn(...args)
console.error = (...args: unknown[]) => originalError(...args)
