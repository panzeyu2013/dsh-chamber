/**
 * dsh 运行时 override 生命周期（design 18 §3.5）——纯逻辑、无 electron、无文件 IO
 * （M3：失效规则 / 回落保护 / swap-attempted / pending 重放）。
 *
 * 权威规则（design 18 §3.5）：
 *   - 失效规则（覆盖 override 与 pending）：启动时 shellVersion ≠ 当前壳版本 →
 *     override 与 pending **一并失效**。失效 = **标记失效**（保留记录、版本树与
 *     快照）而非删除——F4「自动恢复上一 override 树」依赖记录存活；「恢复内建」
 *     才是显式删除（上层做）。
 *   - 回落保护（F4）：回落内建树后跑数据可读性探测；探测失败 → 自动恢复上一
 *     override 树（受保护类，仍在）+ 响亮提示。本模块只提供失效判定/标记原语，
 *     恢复编排在上层。
 *   - swap-attempted：换树（指针写）失败后置位 → 不重试（避免每启重复警告）；
 *     阻塞消失（用户再次操作）清除后重试一次。置位/清除由上层在尝试与恢复时做，
 *     本模块只回答「现在能否尝试」。
 *   - pending 清除与重放：pending 清除与探针裁决同一次原子写（override.json 单一
 *     事务，上层做）；重放幂等——当前指针版本 == pending 版本 → 跳过切换直接探针。
 *
 * 本模块刻意 electron-free / IO-free，可用 node:test 直接单测
 * （override-lifecycle.test.ts）。
 */
import type { OverrideRecord } from './dsh-runtime-store.ts';

/**
 * override 是否应失效：启动时记录的 shellVersion ≠ 当前壳版本。
 *
 * 仅依赖两版本串的精确比较（写入路径已强制精确 semver，无需再 trim/校验）。
 * 返回 true 意味着 override 与 pending **一并失效**——注意「失效」是启动时的
 * 判定，失效后的记录仍存活（见 invalidate），只有 effectivePending 才把它
 * 投影为「无 pending 生效」。
 */
export function shouldInvalidate(record: OverrideRecord, currentShellVersion: string): boolean {
  return record.invalidatedAt != null || record.shellVersion !== currentShellVersion;
}

/**
 * 标记失效：保留记录（chosenVersion / resolvedVersion / pending 原样、
 * shellVersion 原样），仅复位 swapAttempted=false。返回新对象，绝不修改入参。
 *
 * 这不是删除——「恢复内建」才是显式删除（上层做）。记录存活是 F4「自动恢复
 * 上一 override 树」的前提（原选择/实际解析/未决切换全部保留，供恢复与 UI
 * 回显「原选择 vY 保留，可重新选用」）。swapAttempted 复位是因为失效开启
 * 了一个新的壳生命周期：旧的「换树已尝试」标记不得抑制新生命周期里的重试。
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
 * 生效中的 pending（pending 一并失效的投影）：未失效时返回 record.pending；
 * 已失效（shellVersion ≠ currentShellVersion）返回 null；record 为 null
 * （无 override 记录）返回 null。调用方据此决定「未决切换是否还要重放」。
 */
export function effectivePending(record: OverrideRecord | null, currentShellVersion: string): string | null {
  if (record === null) return null;
  if (shouldInvalidate(record, currentShellVersion)) return null;
  return record.pending;
}
