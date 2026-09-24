/**
 * dsh 运行时 override 生命周期——纯逻辑、无 electron、无文件 IO。
 *
 *   - 失效规则（覆盖 override 与 pending）：启动时 shellVersion ≠ 当前壳版本 → 两者
 *     **一并失效**。失效 = **标记失效**（保留记录、版本树与快照）而非删除——「自动恢复
 *     上一 override 树」依赖记录存活；「恢复内建」才是显式删除（上层做）。
 *   - 回落保护：回落内建树后跑数据可读性探测；失败 → 自动恢复上一 override 树 + 响亮
 *     提示（恢复编排在上层）。
 *   - swap-attempted：换树失败后置位 → 不重试；阻塞消失后清除并重试一次。
 *   - pending 清除与重放：与探针裁决同一次原子写；当前指针版本 == pending → 直接探针。
 */
import type { OverrideRecord } from './dsh-runtime-store.ts';

/**
 * override 是否应失效：启动时记录的 shellVersion ≠ 当前壳版本。仅精确比较两版本串
 * （写入路径已强制精确 semver）。返回 true 意味着 override 与 pending 一并失效——失效后
 * 的记录仍存活（见 invalidate），只有 effectivePending 把它投影为「无 pending 生效」。
 */
export function shouldInvalidate(record: OverrideRecord, currentShellVersion: string): boolean {
  return record.invalidatedAt != null || record.shellVersion !== currentShellVersion;
}

/**
 * 标记失效：保留记录（chosenVersion / resolvedVersion / pending / shellVersion 原样），
 * 仅复位 swapAttempted=false，返回新对象、绝不修改入参。这不是删除——「恢复内建」才是
 * 显式删除。记录存活是「自动恢复上一 override 树」的前提；swapAttempted 复位是因为失效
 * 开启了新的壳生命周期，旧标记不得抑制新生命周期里的重试。
 */
export function invalidate(
  record: OverrideRecord,
  reason = 'shell-version-changed',
  now = new Date(),
): OverrideRecord {
  const invalidatedAt = record.invalidatedAt ?? now.toISOString();
  const invalidatedReason = record.invalidatedReason ?? reason;
  return {
    ...record,
    swapAttempted: false,
    invalidatedAt,
    invalidatedReason,
    lastInvalidatedAt: record.lastInvalidatedAt ?? invalidatedAt,
    lastInvalidatedReason: record.lastInvalidatedReason ?? invalidatedReason,
    lastInvalidatedFromVersion: record.lastInvalidatedFromVersion
      ?? record.resolvedVersion
      ?? record.chosenVersion,
    lastInvalidationRecovered: record.lastInvalidationRecovered ?? false,
  };
}

/**
 * 生效中的 pending：未失效时返回 record.pending；已失效（shellVersion ≠ 当前壳版本）或
 * record 为 null 时返回 null。调用方据此决定「未决切换是否还要重放」。
 */
export function effectivePending(record: OverrideRecord | null, currentShellVersion: string): string | null {
  if (record === null) return null;
  if (shouldInvalidate(record, currentShellVersion)) return null;
  return record.pending;
}
