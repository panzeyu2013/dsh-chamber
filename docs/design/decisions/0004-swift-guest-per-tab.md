# ADR-0004：右栏浏览器 v3 = Swift 原生 guest 载体（每 tab 子 WKWebView）+ SSH 反代

- 状态：accepted
- 日期：2026-11-10

## 背景

v2（ADR-0003）以「上游 `ui-sidebar-browser` iframe 路径的忠实 fork」为契约：面板内是壳 document 的一个 `<iframe>`。它以「唯一行为差异 = SSH 反代」为目标，但参照物是上游的 **iframe 分支**——该分支只在桌面 carrier 缺失时兜底，官方 web profile 直接禁用该插件，上游真实用户看到的始终是 Electron `<webview>` guest。用户裁决（2026-11-10）：本地 dsh-chamber 的右栏 Browser 与**上游 Electron 桌面端行为一致**，远程目标的 loopback 增加自动转发，其余行为一致。

以该基线的偏差审计（24 条）显示 v2 的载体差异直接造成 P0 缺陷：目标站 `X-Frame-Options`/`frame-ancestors` 拒绝时静默白屏（iframe 原理）、失败不可见（iframe 无 `did-fail-load` 对等面）、站点数据与壳同 store/同进程、站内 `target=_blank` 点击无反应（上游在面板内开新 tab）。这些不能在 iframe 内闭合。

## 决定

右栏 Browser 的载体改为 **Swift 壳每 tab 一个子 `WKWebView`（native guest）**：独立 web content process、`WKWebsiteDataStore.nonPersistent()` per（source 身份, workspace 键）、main 侧 lease/分区/全部门（复刻上游 `apps/desktop/src/browser-guests.ts` 语义）、renderer 只保留上游 UI/地址/历史/store 与占位几何。**唯一功能 delta = SSH 反代**（forward alias 加载、external alias 投影、远端 loopback 导航期协商）。iframe 载体退役（生产注册删除）；桌面壳 CSP `frame-src` 收窄回 `blob:`；guest 控制经新 `browser` 桥命名空间（Swift-only A 桥白名单登记）。契约正文见 [`design 28`](../client/28-remote-browser.md)。

## 被否方案

- **保留 v2 iframe + 只补失败可见性**：XFO 站点仍不可见，与「与上游桌面一致」冲突；失败提示治标不治本。
- **同版本双载体（iframe 兜底）**：与 CSP 收窄互斥（兜底触发即被 CSP 全拒），且 Swift 恒有 native 桥，「无桥」在出货面不成立；双载体带来双验收/双文档/双安全面。
- **Electron 复活以复用官方 webview 实现**：与 ADR-0002（只出货 Swift）冲突。
- **服务端抓取渲染（控制面代理取页再内嵌）**：新域（登录态/JS/证书/安全边界全部重做），且把控制面变成任意 URL 抓取面。
- **gateway 隧道承载**：把控制面变成任意远端端口的执行/转发面。

## 后果

- 契约面：design 28 重写为 v3；ADR-0003 标 `superseded`；deviations 的 T-31/S-57 关闭并新增引擎上限/子帧不可拦/popup POST 不可查/z-order 与几何/分区键/remote-source 可驱动面等登记。
- 代码面：新增 Swift guest registry/层视图/策略/键盘桥与 `browser` 桥（白名单 + manifest 三件重生成）；renderer 新增 native carrier 并删除 iframe 载体；CSP `frameSources` 启动点停传；`forward.list` 的 embedding/frameErrors 纸面契约删除。
- 验收面：W-13…W-15b 换 guest 判据（W-15 反转为「XFO 站点必须可见」），新增失败可见性/安全门/新窗/z-order/几何/存储/进程/键盘/localhost 转发判据。
- 残余：WebKit ↔ Chromium 引擎差异不可闭合（UA/媒体/CSS/错误码词汇表），「与上游桌面一致」以载体语义为界。
