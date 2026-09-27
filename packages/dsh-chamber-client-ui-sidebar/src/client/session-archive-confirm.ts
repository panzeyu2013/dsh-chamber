/**
 * 归档确认相位的纯逻辑（无可视依赖）：把首次 archive 的失败分类成「需确认」或「照旧上报」，
 * 并把宿主拒绝时列出的活动家族映射成文案行。对话框组件与行菜单动作都只是它的薄壳
 * （测试直接 import 本模块，不为一个纯映射拉起 React/CSS）。
 *
 * 语义对照上游 dsh-client-ui-workspace 的 archiveInjected / archiveConfirmInjected：
 * 首调不带 stopActivity，`workspace/session-active` 拒绝列出将被停止的工作并请用户
 * 确认；确认后带 stopActivity 重发，停止由宿主自己的 provider 完成。
 */
import {
  sessionArchiveRefusal,
  type SessionArchiveActivity,
} from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import type { SidebarKey } from './locales.ts'

/** 首次归档调用的结局：可确认的拒绝（列出活动）或原样上报。 */
export type SessionArchiveAttempt =
  | { readonly kind: 'confirm'; readonly activity: readonly SessionArchiveActivity[] }
  | { readonly kind: 'reject' }

/**
 * 首个 archive 失败分类。只有「确为 session-active 拒绝**且** details 可解码」才进入确认
 * 相位：本地化列表是对话框的承诺（将要停止的工作），解不出就保留原始拒绝，绝不弹空/残缺
 * 列表。其它失败（网络、unknown session）保持调用方既有表面。
 */
export function classifyArchiveFailure(error: unknown): SessionArchiveAttempt {
  const activity = sessionArchiveRefusal(error)
  return activity === undefined ? { kind: 'reject' } : { kind: 'confirm', activity }
}

/** 一行「将被停止的工作」：字典 key 与已解析的参数。 */
export interface ArchiveActivityLine {
  readonly key: SidebarKey
  readonly params: Readonly<Record<string, string | number>>
}

/**
 * 活动家族 → 字典行，逐分支对照上游 SessionArchiveConfirmDialog 的 `activityLine`：
 * turn 无条目；subagent/job/schedule 带计数与名单；未知家族（provider 包可扩展 kind map）
 * 走 generic 行，绝不丢行。名单分隔符由调用方用 locale 提供。
 */
export function archiveActivityLines(
  activity: readonly SessionArchiveActivity[],
  joinNames: (names: readonly string[]) => string,
): ArchiveActivityLine[] {
  // 显式数组（而非 map 的联合推断）：turn 的空 params 也必须按 ArchiveActivityLine 的
  // params 签名检查——联合推断会把它推成 { names?: undefined } 并拒绝赋值给索引签名。
  const lines: ArchiveActivityLine[] = []
  for (const entry of activity) {
    const names = entry.items.map(item => item.label ?? item.id)
    const n = names.length
    const plural = n === 1 ? 'one' : 'other'
    switch (entry.kind) {
      case 'turn':
        lines.push({ key: 'archive.confirm.turn', params: {} })
        break
      case 'subagent':
        lines.push({ key: `archive.confirm.subagents.${plural}`, params: { n, names: joinNames(names) } })
        break
      case 'job':
        lines.push({ key: `archive.confirm.jobs.${plural}`, params: { n, names: joinNames(names) } })
        break
      case 'schedule':
        lines.push({ key: `archive.confirm.schedules.${plural}`, params: { n, names: joinNames(names) } })
        break
      default:
        // 上游 generic 行只带 kind 与计数（不带名单）。
        lines.push({ key: `archive.confirm.other.${plural}`, params: { kind: entry.kind, n } })
    }
  }
  return lines
}

/** 对话框武装目标：标题在点击时解析（行可能在确认仍开着时卸载）。 */
export interface SessionArchiveConfirmRequest {
  readonly sourceId: string
  readonly sessionId: string
  readonly displayTitle: string
  readonly activity: readonly SessionArchiveActivity[]
}
