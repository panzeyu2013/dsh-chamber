/**
 * 后台相位门控：文档隐藏（Electron 最小化/隐藏到托盘/后台标签）时不推进空闲预热 boot、
 * watchdog 拉取/reconnect、失败重试与收割/挂死清扫；恢复可见由 App 的 visibilitychange
 * 补偿一轮。不门控已回收源的 30s unary 兜底——兜底走 watchdog 周期，隐藏窗暂停、恢复补偿。
 *
 * 原属 N-ctx 视图保留策略模块；该策略随常驻重构 D1 退役后，本函数迁出为独立叶子，
 * 被健康流 / 聚合刷新 / 托管运行时 / 视图调度四个 hook 共用。
 */
export function shouldRunBackgroundPhase(visibilityState: DocumentVisibilityState): boolean {
  return visibilityState === 'visible'
}
