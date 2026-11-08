# dsh-chamber 设计总览（v1：多来源会话统一导航）

> **设计体系入口与索引（v1）**——dsh-chamber = dsh 的
> **桌面连接管理器**：原生壳包装 dsh 官方前端（当前出货 = macOS Swift 原生壳；Electron flavor 已冻结归档，
> 见 [../progress/electron-frozen.md](../progress/electron-frozen.md)），本地实例与远程服务器**同等接入**；
> 界面 = **dsh 官方前端源码复用自建**，首屏即 dsh 主界面，**多来源 session/workspace
> 在 dsh 原生侧边栏平等呈现**（仅按来源分类、远程以颜色标注——
> codex 式"导航统一、执行按来源路由"）；未完成门禁见 `docs/progress/STATUS.md`。
>
> 桌面 v1 认证/审计面**整体移除**；控制面 = 托管 + 反代 + 静态服务，loopback-only、
> 无认证边界。设计 17 另定义需显式启动、带强制认证边界（默认；`--no-auth` 为有界
> 偏差，见 17 §5.1/S1）的 server gateway，不把公网能力塞回匿名控制面。
> 本文档是设计体系入口；逐篇导航与状态见 [INDEX.md](./INDEX.md)，`05-connection-manager.md` 是 v1 权威契约。

---

## 1. 定位：连接管理器，不是"第二套领域超市"，也不是"第二套 UI"

dsh harness（`ref-dsh/docs/architecture.md`）**一切皆插件**：会话/目标/任务/终端/设置/
插件清单及官方 Web 前端宿主全部原生具备；dsh-chamber **不做**第二套实现/界面，只做宿主
插件**结构性做不到**的事：

| # | 核心职责 | 为什么插件做不到 |
|---|---|---|
| 1 | **本地宿主托管** | spawn/就绪/reaper/健康监控是"管理 dsh 自己"——插件随宿主进程一起死 |
| 2 | **前端宿主与每实例反代** | dsh 前端要求同源 `/api` + WS（`location.origin` 硬编码）；跨实例同源访问只能由宿主服务端提供 |
| 3 | **远程实例接入** | SSH 隧道 + systemd 起停，跨服务器的连接编排只能存在于服务器之外 |
| 4 | **管理 REST** | 连接 CRUD、健康、日志——管理器自己的最小面 |
| 5 | **多来源会话统一导航** | dsh 原生侧边栏只认识本连接；"本地+远程同等公民"的导航层必须由宿主提供（侧边栏插件替换 + 桥接层） |

**会话业务完全由各实例 dsh 前端 runtime 承担**（每实例一个完整 shell，N-ctx 共存）：
控制面只接入不消费（会话运行时/索引/交互管线见 §4）；跨来源会话只做导航 + 切换连接，
**不做跨来源数据融合**（v1 不做跨来源移动会话）。

---

## 2. 三条收拢原则

### P1 只开发核心，核心 = 上面五件事

任何"新领域功能"提议先问：**dsh 原生、插件生态或宿主 web 前端有没有？**
有 → 不开发。

### P2 一切能力面委托：宿主自己或宿主前端承接，零开发

| 宿主能力 | dsh-chamber 动作 | 零开发的内容 |
|---|---|---|
| 会话/聊天/目标/任务/终端/设置/插件清单 | **整个前端** = dsh 官方前端（源码复用） | 不写聊天 UI、不做第二套 presenter |
| 会话运行时（帧消费/索引/交互） | **不消费**（N-ctx 前端 runtime 承担） | 不建会话索引、不参与审批仲裁 |
| `settings/credentials/llm/agentPreset` 配置平面 | 反代透传（前端自己调用） | 不做配置权威副本 |
| 远程实例的完整 UI | 隧道 + 反代（`/api/i/<id>/*`） | 远程服务器只需 API 面，无需装 web 前端 |
| 连接/隧道/转发的状态机 | 主进程 transport-manager + 控制面托管 | 前端只见非秘密投影 |

**配置平面按实例权威，无跨来源匹配**：`settings/credentials/llm/agentPreset` 只在实例
自己一侧（本地 = 本机 dsh home；远程 = 远端 dsh home + 远端部署配置）；前端 runtime 每次
读写都经 `/api/i/<id>/*` 反代落到**该实例自己的 API**，session 启动时 chip 的 agent preset
roster 来自该 session 所属实例，选择结果写回该实例。因此"本地与远程 preset 不匹配"无需同
步或合并——控制面只透传、不融合、不做权威副本。编辑远程预设 = 切到该来源的 shell，在其
设置 → Agent presets 页操作（copy/read/remove 经反代写远端文件）；shipped 预设只读，编辑
在远端文件系统完成。

### P3 移出范围 = 永久不排期（清单见 §4）

---

## 3. 设计索引

设计文档的逐篇导航、领域分组、生命周期状态（current / deferred / archived / superseded）与 owner 在 [INDEX.md](./INDEX.md)；跨域决策在 [decisions/](./decisions/README.md) 的 ADR。本文件只保留定位、收拢原则、移出项与全局原则，不重复目录。

---

## 4. 移出项（P3 硬纪律，永不回流）

**已被移除的域**（不得以"后续版本"名义回到 backlog）：

| 域 | 处置 | 依据 |
|---|---|---|
| 认证/审计（统一登录/Passkey/会话 cookie/client token/审计 SQLite） | **从桌面/control-plane 移除；gateway 入口认证 + 桌面 S22/S24 受限形态为有界例外** | loopback-only 是桌面 v1 安全面；design 17 的独立公网进程必须有认证（默认；`--no-auth` 为有界偏差），但不提供 control-plane 审计域。**design 17 有界例外**：S22——桌面凭据经 safeStorage 加密落盘（`<userData>/gateway-secrets.json` schema v3 target binding，不可用时回退 0600 明文）；S24——桌面/gateway 轻量非秘密审计（连接/认证事件）。两者都不构成域回流：凭据仅表单瞬时 write-only 输入，永不由主进程返回/回填或持久化到 renderer，也不进注册表/日志；审计永不回流匿名控制面 |
| 控制面薄壳聊天/会话列表/审批弹窗 | **移除** | dsh 官方前端复用取代 |
| 控制面会话运行时/统一索引/交互管线 | **移除** | 各实例前端 runtime 自有（N-ctx） |
| 连接注入适配器 / broker / 绑定 | **移除** | 远程实例由桌面主进程注册表管理，不再 seed 控制面 |
| 协议层深挖文档/委托映射独立文档 | **移除（文档）** | 协议细节以 dsh 自身 wire 与 vendor 源码为权威；处置映射并入本文 §4 |
| walkthrough、通知中心、MCP、文件夹/笔记、web 预览、目标/终端渲染等宿主 UI 职责面 | **仍移出**；「web 预览」裁决见下：design 28 v2 是**右栏内嵌 iframe 的有界例外**（2026-11 用户裁决），不是 web 预览域回流 | 宿主原生覆盖，控制面只接入/服务 |
| 跨会话调度/审批通知投影 | **桌面移出；gateway 有界例外** | design 17 只消费控制帧/权威摘要并驱动既有 dsh API；不消费 session 内容、不实现聊天 runtime。gateway 编排面整体剥离——审批/提问经侧边栏既有事实通道呈现（与本地/ssh 实例同一通道），调度/会话索引/服务器侧 worktree 记录/功能开关全部移除；gateway 只剩认证壳 + 反代 + runtime 管理（design 18 §9）+ 凭据面板 + 种子注册表（宿主包由桌面同步；移动适配包已退役，design 17 §10/§18）+ **只读插件投影**（`GET …/installed`；install/remove/materialize/tasks 写面已退役，读契约见 design 21 §6.2/§6.3） |
| git/GitHub | **插件化** | design 08 的 seed Git Remote 是唯一实现（本地/ssh/gateway 同通道，宿主包由控制面/远程同步/gateway 种子注入）；P5b 的官方 `forge-bundle` 是实例内**官方工作树 UI 面**（opt-in；GitHub provider 由 overlay 关闭；仅 worktree UI/本地 diff，不新增 chamber 执行面）；gateway 服务器侧 worktree 记录已随编排面剥离 |

> **有界例外（与 AGENTS.md 同列：designs 08 / 17 / 19 / 20 / 24 / 28）**：design 08 实例内 Git 插件、
> design 17 独立 gateway、design 19 桌面原生边沿通知投影、design 20 可信 open-in 边缘能力、
> design 24 实例内归档清理宿主域、design 28 右栏浏览器（v2 内嵌 iframe）——各自窄边界见对应 design；
> design 18 §9 是 17/18 的有界扩展（gateway 获得与桌面同源的 dsh 运行时版本管理，不新增执行面）。
> 这些范围的**当期取舍、偏差与证据**按 owning design 与 [`docs/progress/STATUS.md`](../progress/STATUS.md)/[`deviations.md`](../progress/deviations.md) 记录，本节不重复台账。

宿主已覆盖的“通知中心”UI/历史/管理域属移出面；设计 19 的桌面原生边沿通知只投影
renderer 已有的每实例运行时事实，不建立控制面通知消费者/历史/中心，不属该移出域。

> **P5b 工作树统一（有界边界）**：design 08 把工作树收成仓库内 checkout（`<repo>/.agents/worktrees/<name>`，
> 自忽略；会话仍以源主 checkout 为根），侧栏行由 App 派生 `kind:'checkout'` 而非注册 workspace；
> 官方 `forge-bundle`（opt-in）与 seed 共用同一池，GitHub provider 由 overlay 关闭。
> 开放取舍（Swift/sidecar 并存、opt-in 默认关、旧池不迁移、filters parity、restore 边界等）与判据的
> 当期记录见 [`docs/progress/STATUS.md`](../progress/STATUS.md) §4.2，细节归 design 08 §3/§5/§7。

---

## 5. 全局设计原则（沿用）

1. **复用优先**：dsh 或宿主插件已有的能力（含整个前端）只复用/接入，绝不重造执行面。
2. **单窗口多实例**：一个前端窗口内 N 个 dsh shell（N-ctx），导航层统一、执行层按来源路由。
3. **同源唯一入口**：实例流量一律经控制面 `/api/i/<id>/*` 同源反代；前端永不直连非 loopback。
4. **权威边界纪律**：宿主侧事实控制面只服务/探活，绝不成为权威；会话列表只来自各实例 API。
5. **信任最小化**：桌面前端只连 127.0.0.1（本地 dsh 端口或隧道 localPort）；隧道 URL、私钥与代理配置永不进 renderer/日志/持久层；密码/token 仅表单瞬时 write-only 输入，绝不返回/回填。普通 control-plane 仅 loopback；design 17 的 gateway 可非 loopback，但必须同时启用认证（默认；`--no-auth` 为有界偏差）、Host/Origin/peer evaluator 与 HTTP/WS 一致门禁。
6. **P3 硬纪律**：移出项不回流。

> 上述原则的**当期取舍、偏差与证据**记录在 owning design 与 [`docs/progress/STATUS.md`](../progress/STATUS.md)/[`deviations.md`](../progress/deviations.md)；本节只保留设计口径，不重复台账。

### Rejected alternatives（架构调整）

- **架构三门只在本地执行**：否决——循环依赖、包边界和文件预算是演进约束，不能依赖每位提交者手动执行。三门在普通 CI 与发布验证中无条件执行，本地 `static/full` 保持同一实现；其余文档与样式辅助门仍按已有本地策略运行（i18n 对为唯一例外：已进 CI/release 的 pre-install 生成块）。
- **保留 `./src/*` 通配出口与 `sidebar/shared` 面**：否决——包依赖图不是机制（跨包相对 import 可穿过任何出口），且 `sidebar/shared` 被 7 个包 49 处消费、无单一归属；改为 11 包去通配、具名面从生产消费方反推，`sidebar/src/shared` 提升为 `@dsh-chamber/dsh-chamber-client-core`（浏览器安全的共享客户端核心），并以 `scripts/gates/verify-package-boundaries.mjs`（A 禁生产面跨包相对 import、B exports 白名单双向一致）作为零容忍门。
- **测试面跨包相对 import 一并禁止**：否决——测试不是发布契约，文本锁与夹具需要直读源文件；门只判生产面，48 条测试面例外按 §8.3 的误报边界显式列出并由 `--self-test` 锁死。
- **为消除 renderer↔settings-* 反向边而给 renderer 补导出面**：否决——`runtime-management.ts`/`semver.ts`/`svg-resource-scope.ts` 是纯叶子（零依赖或仅 `semver`），迁入 client-core 后 6 条穿包与未声明反向边一并消失；renderer 只保留 `./global.d.ts` 一个 type-only 面（settings 两包以 devDependency 声明该面）。
- **vendor 深路径 import 本地重实现**：否决——上游的 boot-graph wire 校验器（`dsh-client-modules/src/client/manifest.ts`）不手工重写；保留相对路径 + registry `vendorSourceConsumers` 登记 + C16 保鲜门 + 边界门 A 放行。
