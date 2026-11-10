# 设计索引

> 27 篇设计文档与 ADR 的单一导航。设计正文只写现行契约；**状态只在本索引维护**（`current / deferred / archived / superseded`），文档内不再写进度状态词。设计体系入口是 [`01-overview.md`](./01-overview.md)（定位 / 收拢原则 / 移出项 / 全局原则）。

## runtime — dsh 宿主与运行时

| ID | 文档 | 状态 | 主题 | Owner |
|---|---|---|---|---|
| 02 | [02-host-management-deployment.md](./runtime/02-host-management-deployment.md) | current | 本地 dsh 宿主进程托管与部署（spawn / 健康 / reaper / 日志 / systemd） | control-plane |
| 14 | [14-sleep-background.md](./runtime/14-sleep-background.md) | current | 睡眠 / 后台常驻：关窗、托盘、登录自启、唤醒重连、防休眠、退出保护 | desktop |
| 18 | [18-dsh-runtime-version.md](./runtime/18-dsh-runtime-version.md) | current | dsh 运行时版本管理：source-bound 安装、探针门控激活、回退、快照与磁盘治理、gateway 宿主扩展 | dsh-runtime |
| 18a | [18-addendum-apply-now.md](./runtime/18-addendum-apply-now.md) | current | 运行时「立即应用」增补 | dsh-runtime |

## control-plane — 连接管理与反代

| ID | 文档 | 状态 | 主题 | Owner |
|---|---|---|---|---|
| 03 | [03-connections-proxy.md](./control-plane/03-connections-proxy.md) | current | 连接模型（本地 catalog 单行 + 远程注册表）+ 每实例通用反代 | control-plane |
| 04 | [04-control-plane-api-data.md](./control-plane/04-control-plane-api-data.md) | current | 管理 REST、反代 HTTP 形状、前端服务（`__DSH_BOOT__`）、数据模型 | control-plane |
| 05 | [05-connection-manager.md](./control-plane/05-connection-manager.md) | current（v1 权威） | 多来源会话统一导航、侧边栏插件、桥接层、N-ctx、控制面/桌面契约、安全不变量 | control-plane |
| 27 | [27-network-io-resilience.md](./control-plane/27-network-io-resilience.md) | current | WAN 网络 IO 韧性：link health、失败分级、503、注册边沿、上传预算、link epoch | control-plane |

## gateway — 服务端接入层

| ID | 文档 | 状态 | 主题 | Owner |
|---|---|---|---|---|
| 13 | [13-remote-plugin-management.md](./gateway/13-remote-plugin-management.md) | current | 远程实例插件管理：一键应用清单、provider exec、spec 白名单、remoteDshHome | gateway |
| 17 | [17-server-side-gateway.md](./gateway/17-server-side-gateway.md) | current | 独立启动、认证默认的 server 形态：单本地 dsh 公网接入、gateway target、认证/反代/runtime 管理 | gateway |
| 21 | [21-gateway-plugin-parity.md](./gateway/21-gateway-plugin-parity.md) | current | 统一插件管理模型与 gateway 连接对齐（A/B/C） | gateway |

## client — 前端、侧边栏与设置

| ID | 文档 | 状态 | 主题 | Owner |
|---|---|---|---|---|
| 06 | [06-sidebar-enhancements.md](./client/06-sidebar-enhancements.md) | current | 侧边栏增强：搜索 / 拖拽排序 / 视图持久化 / 运行时事实通道 | client |
| 07 | [07-models-params.md](./client/07-models-params.md) | deferred | 模型额外参数与默认推理等级（deferral 记录） | client |
| 09 | [09-client-plugin-runtime-loading.md](./client/09-client-plugin-runtime-loading.md) | current | 每实例客户端插件运行时加载、活实例热同步、信任边界 | renderer |
| 15 | [15-chamber-settings-page.md](./client/15-chamber-settings-page.md) | current | Chamber 设置呈现：settings 壳固定入口、全局/实例配置分离 | client |
| 19 | [19-notifications.md](./client/19-notifications.md) | current | 桌面通知与未读徽标；Swift 原生边沿投影，Electron 呈现腿归档 | renderer / desktop |
| 26 | [26-page-channel.md](./client/26-page-channel.md) | current | 页面级多路复用通道：长活流、instanceId、信用窗口、I-1、HTTP 预算 | control-plane |
| 28 | [28-remote-browser.md](./client/28-remote-browser.md) | current | 右栏浏览器 v3：Swift 原生 guest 载体（每 tab 子 WKWebView）+ SSH 反代 alias | client-ui-browser |

## desktop — 桌面壳与系统集成

| ID | 文档 | 状态 | 主题 | Owner |
|---|---|---|---|---|
| 11 | [11-auto-update.md](./archive/11-auto-update.md) | archived-reference（Swift 更新链见 25 §7） | 桌面更新提示与通道（Electron/electron-updater 半边归档） | desktop |
| 16 | [16-vscode-deeplink.md](./desktop/16-vscode-deeplink.md) | current | VS Code OS 深链：`dsh-chamber://` → 远端目录；主进程注册表与可用性探测 | desktop |
| 20 | [20-open-in-registry.md](./desktop/20-open-in-registry.md) | current | open-in 打开面（fork & supersede 官方两份）：seed 宿主半 + 客户端插件超集 | desktop |
| 25 | [25-macos-swift-native-shell.md](./desktop/25-macos-swift-native-shell.md) | current（唯一出货 flavor） | macOS Swift 原生壳：WKWebView + Node sidecar、A/B 桥、目录锁、原生边沿 | desktop |

## plugins — 实例内 chamber 宿主包

| ID | 文档 | 状态 | 主题 | Owner |
|---|---|---|---|---|
| 08 | [08-git-worktree-plugin.md](./plugins/08-git-worktree-plugin.md) | current（opt-in） | Git worktree 插件：seed host Remote + 打包客户端插件 + `sidebar.workspace.git` 座位 | client-ui-git |
| 24 | [24-archived-session-cleanup.md](./plugins/24-archived-session-cleanup.md) | current | 已归档会话内容清理：`archiveCleanup/{probe,purge}` + 归档管理器对话框 | client-ui-git |

## archive — 冻结归档

| ID | 文档 | 状态 | 主题 | Owner |
|---|---|---|---|---|
| 22 | [22-linux-desktop.md](./archive/22-linux-desktop.md) | archived | Linux 桌面支持（Electron 冻结） | archive |
| 23 | [23-windows-support.md](./archive/23-windows-support.md) | archived | Windows 支持（Electron 冻结） | archive |

## 决策记录

跨域/架构决策以 [`decisions/`](./decisions/README.md) 的 ADR 记录；ADR 只记录决定与理由，契约正文仍在 owning design。被取代的 ADR 标 `superseded`，不重写。

## 维护规则

- 新增 / 改名 / 删除 design 时同批更新本索引与所有链接；被取代的设计标 `superseded` 并链接新文档；冻结设计标 `archived`。
- `current` 文档只写当前契约；历史与进度归 `progress/`、`CHANGELOG` 或 ADR。
- 状态变更与 owner 变更在本表维护，不在 design 正文里写状态横幅（冻结横幅属例外，保留在文首）。
