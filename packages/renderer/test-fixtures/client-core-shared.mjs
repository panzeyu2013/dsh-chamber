/**
 * `@dsh-chamber/dsh-chamber-client-core` 在 shell 隔离测试里的最小面（test-only）。
 *
 * 面 = 三个 loader 取用测试（shell.test / shell-tail-wait-teardown / session-open-poll）
 * 的**整个模块图**从裸 specifier 取得的名字，不只是 shell.ts 自己的两个：shell.ts 用
 * `chamberBridge`/`describeThrown`，会话打开探针用 `sessionOpenPromiseInFlight`，
 * `host-graph.ts` 用 page-schedule 的 `hadSchedulingGap` 与证据账本的 `recordEvidence`。
 * 测试 loader 刻意不解析整桶 `src/index.ts`——那会把 source-only 的 dsh connection/runtime
 * 包拖进这个不安装、不执行它们的隔离 Node 测试。这里的符号都**重导出真实实现**，不做替身：
 * 新增符号只需在此补一行，漏补会让测试以「does not provide an export named …」响亮失败
 * （实测：删掉 page-schedule/evidence-log 两行会让 shell.test 在 host-graph.ts 处炸）。
 * 真源是那个模块图的裸 specifier 导入（`grep -rn "from '@dsh-chamber/dsh-chamber-client-core'"
 * packages/renderer/src` 再取可达集）；页面通道的面走包 SUBPATH 直连实现，不经这里。
 */
export { chamberBridge } from '../../dsh-chamber-client-core/src/aggregate-store.ts'
export { describeThrown } from '../../dsh-chamber-client-core/src/error-text.ts'
// 会话打开证据读取：open-in 的 stream-health-probe（abstract 侧单源化后新增）。
export { sessionOpenPromiseInFlight } from '../../dsh-chamber-client-core/src/session-open.ts'
// 证据有效性层（design 14 §D4）：页面调度记录 + 有界持久证据账本。两个模块零依赖
// （不链接任何 source-only 的 dsh 包），host-graph.ts 在隔离测试图里直接消费。
export {
  PAGE_SCHEDULE_GAP_MS, hadSchedulingGap, noteFocus, notePageTick, noteVisibility,
  pageScheduleSnapshot, resetPageScheduleForTests, startPageScheduleProbe,
} from '../../dsh-chamber-client-core/src/page-schedule.ts'
export {
  EVIDENCE_LOG_PERSIST_INTERVAL_MS, EVIDENCE_LOG_PERSIST_MAX, EVIDENCE_LOG_RING_MAX,
  EVIDENCE_LOG_STORAGE_KEY, evidenceLogText, readEvidenceLog, readPersistedEvidenceLog,
  recordEvidence, resetEvidenceLogForTests,
} from '../../dsh-chamber-client-core/src/evidence-log.ts'
// 页面级多路复用通道（design 26）：renderer api/App 与 settings 页的健康流消费面。
// 该模块只依赖零依赖的 wire 契约与证据账本，可在隔离测试里直接重导出真实实现。
export {
  installPageChannelEventSourceAudit, subscribePageChannel,
} from '../../dsh-chamber-client-core/src/page-channel.ts'
