# ADR-0003：右栏浏览器 v2 = 上游 iframe path fork + SSH alias

- 状态：superseded（由 [ADR-0004](./0004-swift-guest-per-tab.md) 取代）
- 日期：2026-11-08

## 背景

右栏 Browser 需要在 SSH 远程实例内嵌页面；上游 `ui-sidebar-browser` 的 iframe 路径是现成实现。chamber 需要一个与上游样式/行为一致、但能走 SSH 反代的形态。

## 决定

v2 采用**忠实 fork 上游 iframe path**：唯一行为差异是 SSH 反代——本地直连 `target.url`；`dsh`/`gateway` + ssh 且目标 host 为 `127.0.0.1` 时，挂载 forward lease 并使用 main 的 alias `frameUrl`。外部出口、标签关闭、CSP、导航/下载/权限门由 main/Swift 腿维护；Electron 腿冻结归档。该形态是 design 28 §4 的有界例外，不是 web 预览域回流。

## 被否方案

- **自建浏览器 UI**：否决——与上游样式/行为漂移，维护成本高。
- **原生子视图 / 共享 127.0.0.1 回退**：否决——引入第二套渲染路径与安全边界。
- **gateway 隧道承载 wire**：否决——超出右栏浏览器的最小边界。

## 后果

- 契约正文与边界只在 [`client/28-remote-browser.md`](../client/28-remote-browser.md) 维护；本 ADR 只记录形态选择。
- 上游对齐面（fork 差异、alias、租约）变更时同步该 design；有界例外登记保持现状。
