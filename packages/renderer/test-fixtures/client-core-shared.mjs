/**
 * `@dsh-chamber/dsh-chamber-client-core` 在 shell 隔离测试里的最小面（test-only）。
 *
 * `shell.ts` 只消费 `chamberBridge` 与 `describeThrown` 两个符号。测试 loader 刻意
 * 不解析整桶 `src/index.ts`——那会把 source-only 的 dsh connection/runtime 包
 * 拖进这个不安装、不执行它们的隔离 Node 测试。两个符号都**重导出真实实现**，不做替身，
 * 因此新增符号时只需在此补一行；漏补会让 shell 测试以「does not provide an export named …」
 * 响亮失败。
 */
export { chamberBridge } from '../../dsh-chamber-client-core/src/aggregate-store.ts'
export { describeThrown } from '../../dsh-chamber-client-core/src/error-text.ts'
