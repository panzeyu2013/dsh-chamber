# dsh-chamber 设计总览（v1：多来源会话统一导航）

> 本文是 dsh-chamber 设计体系的**入口与索引**。v1 定稿（2026-08-14）：
> 软件 = dsh 的**桌面连接管理器**——Electron 包装 dsh 官方前端（避免纯
> 浏览器形态），本地实例与远程服务器**同等接入**；界面 = **dsh 官方前端
> 源码复用自建**，首屏直接进入 dsh 主界面（纯 dsh UI），**多来源的
> session/workspace 在 dsh 原生侧边栏内平等呈现**（仅按来源分类，远程
> 来源以颜色标注——codex 式"导航统一、执行按来源路由"）。
>
> 认证/审计面已随 v1 收敛**整体移除**；控制面 = 托管 + 反代 + 静态服务，
> loopback-only、无认证边界。
> 本文档是唯一入口；`05-connection-manager.md` 是 v1 权威契约。

---

## 1. 定位：连接管理器，不是"第二套领域超市"，也不是"第二套 UI"

dsh harness 的设计哲学（`ref-dsh/docs/architecture.md`）是**一切皆插件**：
会话/目标/任务/终端/设置/插件清单，以及承载这一切的官方 Web 前端，宿主
全部原生具备。因此 dsh-chamber **不做**这些领域的第二套实现，也**不写**
第二套界面。它只做宿主插件**结构性做不到**的事：

| # | 核心职责 | 为什么插件做不到 |
|---|---|---|
| 1 | **本地宿主托管** | spawn/就绪/reaper/健康监控是"管理 dsh 自己"——插件随宿主进程一起死 |
| 2 | **前端宿主与每实例反代** | dsh 前端要求同源 `/api` + WS（`location.origin` 硬编码）；跨实例同源访问只能由宿主服务端提供 |
| 3 | **远程实例接入** | SSH 隧道 + systemd 起停，跨服务器的连接编排只能存在于服务器之外 |
| 4 | **管理 REST** | 连接 CRUD、健康、日志——管理器自己的最小面 |
| 5 | **多来源会话统一导航** | dsh 原生侧边栏只认识本连接；"本地+远程同等公民"的导航层必须由宿主提供（侧边栏插件替换 + 桥接层） |

**会话业务完全由各实例的 dsh 前端 runtime 承担**（每实例一个完整 shell，
N-ctx 共存）：控制面不消费任何宿主帧、不建会话索引、不参与聊天/审批；
跨来源会话只做"导航 + 切换连接"，**不做跨来源数据融合**（v1 明确不做跨
来源移动会话）。

---

## 2. 三条收拢原则

### P1 只开发核心，核心 = 上面五件事

任何"新领域功能"提议，先回答：**dsh 原生、dsh 插件生态、或宿主 web 前端
有没有？** 有 → 不开发。

### P2 一切能力面委托：宿主自己或宿主前端承接，零开发

| 宿主能力 | dsh-chamber 动作 | 零开发的内容 |
|---|---|---|
| 会话/聊天/目标/任务/终端/设置/插件清单 | **整个前端** = dsh 官方前端（源码复用） | 不写聊天 UI、不做第二套 presenter |
| 会话运行时（帧消费/索引/交互） | **不消费**（N-ctx 前端 runtime 承担） | 不建会话索引、不参与审批仲裁 |
| `settings/credentials/llm/agentPreset` 配置平面 | 反代透传（前端自己调用） | 不做配置权威副本 |
| 远程实例的完整 UI | 隧道 + 反代（`/api/i/<id>/*`） | 远程服务器只需 API 面，无需装 web 前端 |
| 连接/隧道/转发的状态机 | 主进程 transport-manager + 控制面托管 | 前端只见非秘密投影 |

**配置平面按实例权威，不存在跨来源匹配**：`settings/credentials/llm/
agentPreset` 配置**只存在于每个实例自己一侧**（本地 = 本机 dsh home；远程 =
远端 dsh home + 远端部署配置）。前端 runtime 的每次读取/写入都经
`/api/i/<id>/*` 反代落到**该实例自己的 API**：启动 session 前选择 agent
preset 时，chip 的 roster 来自该 session 所属实例（远程 session 读远程预设、
本地 session 读本地预设），选择结果同样写回该实例。因此"本地与远程 preset
不匹配"不需要同步或合并——每实例对自己的配置平面权威，控制面只透传、不融合、
不做权威副本。编辑远程预设 = 切到该远程来源的 shell，在其 设置 → Agent
presets 页操作（copy/read/remove 经反代写远端文件）；部署内置（shipped）预设
只读，编辑在远端文件系统上完成。

### P3 移出范围 = 永久不排期（清单见 §4）

---

## 3. 文档地图

| # | 文档 | 状态 | 主题 |
|---|---|---|---|
| 01 | 本文 | 现行（入口） | 收拢原则 + 定位 + 移出项 |
| 02 | [02-host-management-deployment.md](02-host-management-deployment.md) | 现行（核心） | web profile spawn、健康、reaper、日志、部署形态 |
| 03 | [03-connections-proxy.md](03-connections-proxy.md) | 现行（核心） | 连接模型（本地 + 远程注册表）+ 每实例通用反代 |
| 04 | [04-control-plane-api-data.md](04-control-plane-api-data.md) | 现行（核心） | 管理 REST、反代契约、前端服务（`__DSH_BOOT__`） |
| 05 | [05-connection-manager.md](05-connection-manager.md) | 现行（表面/架构，v1 权威） | 多来源会话统一导航、侧边栏插件、桥接层、N-ctx、控制面/桌面契约（§7）、安全不变量（§8） |
| 06 | [06-sidebar-enhancements.md](06-sidebar-enhancements.md) | 现行（已实现，2026-08） | 侧边栏增强：搜索 / 拖拽排序 / 视图持久化 / 运行时事实通道 |
| 07 | [07-models-params.md](07-models-params.md) | 推迟（设计定稿，待上游解锁） | 模型额外参数 + 默认推理等级：链路事实、上游阻塞点、更新复查清单、实现蓝本 |
| 08 | [08-git-worktree-plugin.md](08-git-worktree-plugin.md) | 现行（v1 实现，2026-08-20 自 docs/todo/ 移入） | git worktree 独立插件：实例内 host Remote + 强制打包客户端插件 + `sidebar.git` 座位 + 安全创建/无归档删除 saga |
| 09 | [09-client-plugin-runtime-loading.md](09-client-plugin-runtime-loading.md) | 现行（已实现，2026-08 方案 A；自 docs/todo/ 移入） | dsh 客户端插件运行时加载：断点定位（官方机制完整、chamber 前端断链）+ 每实例合并宿主 boot 图（chamber host 包 `clientGraph/graph` + 控制面 `--patch` seed + 去重预加载 + boot.ts extraRows seam）+ 信任边界/分期 |
| 10 | [../todo/10-todo-event-driven-aggregation.md](../todo/10-todo-event-driven-aggregation.md) | 已实现（2026-08；历史设计记录仍在 todo/） | 侧边栏聚合改事件驱动：各来源 ctx 推投影取代 10s REST 轮询（30s 兜底仅覆盖无完整生产者来源）+ 05 §3 契约修订；不改上游 dsh |
| 11 | [11-auto-update.md](11-auto-update.md) | 现行（已实现，2026-08；自 docs/todo/ 移入） | 桌面端更新提示（dsh-chamber 自身，无弹窗、低打扰）：settings chamber 全局「更新」部分 + 静默检查、用户确认后下载、退出时安装（win/mac 一致，mac 安装腿需 Developer ID）、beta → stable 通道 |
| 12 | [../todo/12-todo-archived-sessions.md](../todo/12-todo-archived-sessions.md) | todo（设计待评审，实现未排期；2026-08） | 已归档会话管理（归档单向且不可见；A 前端浏览区先行 + C 上游 wire 根治，B 特权层冻结） |
| 13 | [13-remote-plugin-management.md](13-remote-plugin-management.md) | 现行（已实现，2026-08；M1–M4 落地） | 远程实例插件管理：一键应用本地插件清单 + 可视化添加（provider exec 通道 + spec 白名单 + remoteDshHome 远端路径基准） |
| 14 | [14-sleep-background.md](14-sleep-background.md) | 现行（已实现（v1 范围），2026-08；自 docs/todo/ 移入） | 睡眠/后台常驻：关窗行为（托盘/退出）、登录自启、唤醒即时重连、防休眠、退出保护 |
| 15 | [15-chamber-settings-page.md](15-chamber-settings-page.md) | 现行（已实现（v1 范围），2026-08；自 docs/todo/ 移入） | Chamber 设置页：settings 壳固定入口（连接/通用/更新），chamber 全局设置与实例配置平面分离 |
| 16 | [16-vscode-deeplink.md](16-vscode-deeplink.md) | 已实现（M0–M2，2026-08） | VS Code 深链插件：`dsh-chamber://` OS 深链 + `shell.overlay` 主区右上按钮快速拉起本机 VS Code Remote-SSH 打开对应 server 目录；主进程 DeepLinkHandler 注册表 + VS Code 可用性探测 + 打包门控协议注册；无 host 插件/seed，现有包改动 = 0 |
| 17 | [17-dsh-runtime-version.md](17-dsh-runtime-version.md) | 现行（M0/M2/M4 done；M1/M3 packaged evidence partial；2026-08，详见 STATUS） | dsh 运行时版本管理：一次 source-bound tarball 下载 + SRI + pnpm `file:` 安装（唯一获取方式，无 Provider B）、settings 版本选择/回滚 + registry 源用户自设、探针门控激活 + 自动回退、快照/失败现场与磁盘治理；macOS/Linux 可管理，Windows 只读 |

---

## 4. 移出项（P3 硬纪律，永不回流）

**已被最新设计移除的域**（不得以"后续版本"名义回到 backlog）：

| 域 | 处置 | 依据 |
|---|---|---|
| 认证/审计（统一登录/Passkey/会话 cookie/client token/审计 SQLite） | **移除（v1 收敛）** | dsh 无认证概念；loopback-only 是 v1 安全面 |
| 控制面薄壳聊天/会话列表/审批弹窗 | **移除** | dsh 官方前端复用取代 |
| 控制面会话运行时/统一索引/交互管线 | **移除** | 各实例前端 runtime 自有（N-ctx） |
| 连接注入适配器 / broker / 绑定 | **移除** | 远程实例由桌面主进程注册表管理，不再 seed 控制面 |
| 协议层深挖文档/委托映射独立文档 | **移除（文档）** | 协议细节以 dsh 自身 wire 与 vendor 源码为权威；处置映射并入本文 §4 |
| walkthrough、通知中心、MCP、cron、文件夹/笔记、web 预览、目标/终端渲染等宿主 UI 职责面 | **不变（移出）** | 宿主原生覆盖，控制面只接入/服务 |
| git/GitHub | **插件化（2026-08-16 修订）** | 不进控制面/本体；允许以 chamber 强制打包的客户端插件形态提供（worktree 生命周期等，设计 08），绝不重造 dsh 宿主执行面 |

> **例外（2026-08-16）**：git/GitHub 行经本节修订为插件化，是上表唯一例外
> （"不得以'后续版本'名义回到 backlog"仅约束其余行）。插件形态仍受 §5 原则
> 约束：控制面不建立 git 索引、不消费宿主会话，git 事实与执行只来自各实例内的
> chamber host plugin；Desktop 仅分发该包，不运行 Git（设计 08 §2/§5/§6）。

---

## 5. 全局设计原则（沿用）

1. **复用优先**：凡 dsh 或宿主插件已实现的能力（含整个前端），只复用/接入，绝不重造执行面。
2. **单窗口多实例**：一个前端窗口内 N 个 dsh shell（N-ctx），导航层统一、执行层按来源路由。
3. **同源唯一入口**：所有实例流量经控制面 `/api/i/<id>/*` 同源反代；前端永不直连非 loopback。
4. **权威边界纪律**：凡宿主侧事实，控制面只服务/探活，绝不成为权威；会话列表只来自各实例 API。
5. **信任最小化**：前端只连 127.0.0.1（本地 dsh 端口或隧道 localPort）；隧道 URL 与 SSH 材料永不进 renderer/日志/持久层；监听仅 loopback。
6. **P3 硬纪律**：移出项不回流。
