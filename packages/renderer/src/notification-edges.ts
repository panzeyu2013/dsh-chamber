/**
 * 每会话事实（运行时事实通道 report.sessions 的行，合并后）与通知边沿的类型面。
 *
 * 边沿判定的**唯一现役实现**在 completion-observation.ts（observeSource 的壳边沿
 * 候选 + 每会话转移记忆；reconcile 负责裁决与去重）；旧 planner 导出面与只被它
 * 们调用的纯函数检测/去重实现（连同其测试专有孤岛）已删除，本模块只剩类型。
 *
 * `running` 已由生产者按官方 `status?.running ?? row.running` 解析；`completed` 由
 * App 账本在 `mergeRuntimeFacts` 注入——通道自身永不携带该位（官方 store 行没有
 * `completed`，官方完成位 `sessionStatus.completionUnread` chamber 今日不消费，
 * design 19 §2）。
 */
export interface SessionFacts {
  running?: boolean
  completed?: boolean
  pending?: 'approval' | 'plan-review' | 'question'
  /** 运行中子代理计数（>0 稀疏）；现役通知链的压制走 completion-observation 的子代理三值。 */
  runningSubagents?: number
  /** Host activity time of this row. */
  updatedAt?: number
}
export type NotificationKind = 'complete' | 'ask' | 'request'
export interface NotificationEdge { sessionId: string; kind: NotificationKind }


