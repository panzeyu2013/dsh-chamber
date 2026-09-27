/**
 * 每会话事实（运行时事实通道 report.sessions 的行，合并后）与通知边沿的类型面。
 *
 * 边沿判定的**唯一现役实现**在 completion-observation.ts（observeSource 的壳边沿
 * 候选 + 每会话转移记忆；reconcile 负责裁决与去重）；旧 planner 导出面与只被它
 * 们调用的纯函数检测/去重实现（连同其测试专有孤岛）已删除，本模块只剩类型。
 *
 * `running` 已由生产者按官方 `status?.running ?? row.running` 解析；`completed` 是官方
 * `sessionStatus.completionUnread`（内存 Set），由侧栏生产者写进通道行；App 只在
 * `mergeRuntimeFacts` 追加 N-ctx 修正臂（design 06 §4，通知观察面不读该位）。
 */
export interface SessionFacts {
  running?: boolean
  completed?: boolean
  pending?: 'approval' | 'plan-review' | 'question'
  /** 运行中子代理计数（>0 稀疏）；现役通知链的压制走 completion-observation 的子代理三值。 */
  runningSubagents?: number
  /** Host activity time of this row. */
  updatedAt?: number
  /**
   * I3 correction provenance（见 client-core InstanceRuntimeReport）：true = 本行的
   * running 刚被侧栏 tier-3 权威写回压假，不是宿主完成。通知候选门在无 host 域
   * observed 完成证据时不把它当完成；旧壳不写 ⇒ fail-open。
   */
  corrected?: boolean
}
export type NotificationKind = 'complete' | 'ask' | 'request'
export interface NotificationEdge { sessionId: string; kind: NotificationKind }
