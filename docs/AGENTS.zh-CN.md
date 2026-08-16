# dsh-chamber Agent 指南（中文版）

## 定位

dsh-chamber 是 dsh 的本地桌面**连接管理器**：本地 dsh 实例（web profile）由控制面托管；远程服务器上的 dsh 实例经 SSH 隧道接入。界面 = **dsh 官方前端源码复用自建**（单窗口、单 frame，多实例以 N-ctx shell 共存）。控制面负责连接管理、每实例同源反代与静态前端服务（**v1 无认证/审计面**——随 2026-08-14 收敛移除）。宿主原生能力（goals、jobs、terminals、schedule、settings、pluginInventory…）仍是宿主与宿主前端的职责——控制面只接入、不重造。**会话业务完全由 dsh 前端 runtime 承担；控制面不消费任何宿主帧。**

本文件只含常驻仓库规则与路由。详细设计在 `docs/design/`，进度在 `docs/progress/`，未实现功能想法在 `docs/todo/`。

## 指令顺序

编辑前**必须**按顺序执行：

1. 遵循本根指南。
2. 阅读相关设计文档（`docs/design/0X-*.md`）与进度总览（`docs/progress/STATUS.md`——唯一进度记录）。
3. 遵循 `docs/design/01-overview.md` 的收拢原则：凡 dsh 宿主或其前端已覆盖的事项，控制面只接入/服务——**绝不重造执行面**；控制面不消费宿主会话；已移出范围域（walkthrough、notifications、MCP、薄壳聊天 UI、控制面会话运行时…）**以任何形式不得回流**。唯一例外（2026-08-16，设计 08）：git/GitHub 不进控制面/本体，但允许以 chamber 强制打包的客户端插件形态提供（worktree 生命周期等，见 08）——插件绝不重造 dsh 宿主执行面。
4. 遵守各模块文档中的已文档化偏差。

若以上来源实质冲突，停下解决冲突，不得静默二选一。

## 运行时边界

- `packages/control-plane` — 连接管理器核心：本地宿主托管（web profile spawn/就绪/回收/健康/日志）、管理 REST（`/health`、`/api/connections` 仅本地、`/api/host/logs`）、每实例通用反代（`/api/i/<id>/*` HTTP/WS/SSE 透传；v1 匿名、仅 loopback——无认证/审计面）、静态前端服务（dist + `__DSH_BOOT__` 清单）。
- `packages/renderer` — 自建 dsh 前端（源码复用）：入口构建（chamber 复合 entry）、纯 dsh 首屏桥接宿主（entry 级 React：本地 auto-start / 注册表 auto-connect / chamberBridge publish & onOpenSession）、N-ctx 多实例编排、启动图清单生成。
- `packages/dsh-client-connection` — 官方连接客户端的仓库内拷贝 + base 路径补丁（遮蔽 vendor workspace 条目）。
- `packages/dsh-client-web` — 官方 web shell 的仓库内拷贝 + boot.tsx N-ctx 模块表共享 seam + runtimeCtx getter（遮蔽 vendor workspace 条目）。
- `packages/dsh-chamber-client-ui-sidebar` — 自研侧边栏插件（拷贝 ui-sidebar 结构改造）：多来源会话导航 + chamberBridge（`shared/aggregate-store.ts` + 每实例 unary 客户端 `shared/instance-api.ts`），替换官方 ui-sidebar 注册（见 05 §6）。
- `packages/dsh-chamber-client-ui-settings-connections` — 自研连接设置插件：本地实例卡 + 远程主机 CRUD/连接/systemd/日志（settings.section、dsh 设计 token，见 05 §5）。
- `packages/dsh-chamber-client-ui-settings-bridge` — 自研设置壳插件：以 priority -1 shadow 官方 SettingsRoot 注册（sidebar.settings）——服务器下拉 + 所选实例官方设置分区（子 cordis ctx 桥接）+ 固定的 chamber 全局连接导航项（05 §5 同源设计讨论 2026-08）。
- `packages/desktop` — Electron 壳：单 frame（`loadURL` 控制面 origin）、transport-manager（通用传输运行时；`transport-provider.ts` 接口 + `ssh-provider.ts` 的 ssh provider——隧道 + systemd exec，v1 kind `ssh`）、实例注册表（`<userData>/ssh-instances.json`）、IPC。
- `packages/cli` — CLI 薄壳（serve/status/connections/host logs）。
- `docs/design/` — 设计文档（01 是入口；05 是表面/架构契约（v1）；v2 时代薄壳文档（旧 05/10）随 v4 收口移除）。
- `docs/progress/` — STATUS.md 是总览的唯一写入者。

## 常驻约束

- 不得修改外部仓库。`vendor/harness-packages` 是指向 dsh 源码 checkout 的只读符号链接树——由 root `preinstall`（`scripts/ensure-harness-vendor.mjs`）按固定提交（`harness.commit`，可用 `DSH_CHAMBER_HARNESS_ROOT` / `DSH_CHAMBER_HARNESS_COMMIT` 覆盖；兄弟目录 `../deepseek-harness` 存在时优先使用，零网络）自动引导；`ref-dsh` 与 `ref-upstream` 仅为本地参考符号链接，**永不提交**。
- 除非用户明确要求，不得运行 git 或 GitHub 命令。
- 包管理器为 **pnpm**（`pnpm install`；脚本定义在 `package.json`——用 `pnpm run` 执行）。未经明确要求不得新增运行时依赖（当前集合：`ws`、`@simplewebauthn/server`、React/Vite、Electron、以及 dsh client workspace 包）。TypeScript 工具链（`typescript`、`@types/*`）为许可的 devDependency 集合。
- 唯一可修改的 dsh 源码是我们的五个 chamber 包：仓库内拷贝 `packages/dsh-client-connection`（base 路径补丁）与 `packages/dsh-client-web`（boot.tsx N-ctx 模块表共享 seam + runtimeCtx getter），以及自研的 `packages/dsh-chamber-client-ui-sidebar`（替换官方 ui-sidebar 注册，见 05 §6）、`packages/dsh-chamber-client-ui-settings-connections` 与 `packages/dsh-chamber-client-ui-settings-bridge`（见 05 §5）；`vendor/harness-packages` 下的一切均为未触碰的上游源码。
- 隧道 URL 与**私密 SSH 材料**（凭据、私钥、代理配置）永不进 renderer/日志/持久层——只进**非秘密元数据投影**（host/user/端口、localPort/phase）；控制面监听仅 loopback。**许可例外**（05 §8，2026-08；**明文文件兜底**——用户决策）：可选的主机 SSH 密码在连接表单中瞬时收集、经 IPC 转发；主进程内存持有并镜像到 `<userData>/ssh-passwords.json`（0600、原子写、启动时加载，密码主机重启后自动连接可用）——永不进注册表、永不记日志、永不回传 renderer；经临时 0600 askpass 助手注入 ssh（传输停止即删）；实例删除或显式清除时丢弃条目。无可靠 askpass 支持的平台（v1 的 Windows）在 IPC 门禁处拒绝密码认证。
- 改动保持最小，保留无关的未提交改动。
- 安全与正确性要在核心/运行时逻辑中落实，而非仅靠 UI 隐藏或提示。
- 更新所属文档：模块归属、契约或不变量变更时，更新 `docs/progress/STATUS.md`。

## 正确性不变量

- 权威状态优先于启发式：宿主持久化的事实，控制面只接入/服务——绝不成为权威。
- 活性来自实时通道而非持久化历史（远程活性 = 隧道 phase + 探活，绝不是保存的状态）。
- 临时回退要有窄作用域，权威状态到达即清除。
- 代理诚实性：实例传输失败绝不伪装成空成功——无隧道 → 明确 503；代理错误显式，绝不静默。
- 一个实体的失败不得抹掉或阻塞无关的完整实体。
- 运行时差异必须是有意的、在代码中可见的（如本地 vs SSH 适配器差异）。

## 文档发现

修改模块前，阅读对应的设计与进度文档：

- `docs/design/01-overview.md` — 入口与收拢原则
- `docs/design/02-host-management-deployment.md` — 宿主管理（web profile）
- `docs/design/03-connections-proxy.md` — 连接与每实例反代
- `docs/design/04-control-plane-api-data.md` — 管理 API 与数据模型
- `docs/design/05-connection-manager.md` — 表面与架构契约（v1）
- `docs/progress/STATUS.md` — 完成状态、剩余偏差与验证记录

## 验证

- 以 `package.json` 脚本为命令事实源（用 `pnpm run` 运行）。
- 单测（与 CI 同一套）：控制面 `node packages/control-plane/test/protocol.ts`、`storage.ts`、`m1-dsh-client.ts`、`host-logs.ts`、`manager-api.ts`、`instance-proxy.ts`；桌面 `pnpm run test:desktop`（transport-manager / ssh-provider / ssh-config / renderer-trust）；renderer shell `pnpm run test:renderer-shell`；客户端插件 `pnpm run test:sidebar` + `pnpm run test:settings-bridge`。
- 客户端插件类型检查：`pnpm run typecheck:sidebar`、`typecheck:connections`、`typecheck:settings-bridge`（根 `typecheck` 程序**不包含**自研插件——ambient `declare module` 条目将其遮蔽）。
- 集成：`pnpm run smoke`（dsh 未安装时自动 SKIP——正常）。
- 前端：`pnpm run build:renderer` 必须成功（vite 构建 dsh workspace 源码）。
- 打包：`pnpm run dist:desktop:mac`。
- i18n：`pnpm run verify:i18n` 不得报告 DRIFTED 对。
- 不得因没有 JS 类型检查就认为无需验证；对触及面运行定向测试、语法检查、构建或运行时验证。
- 如实报告哪些验证过、哪些没有。静态检查不能证明运行时、认证、协议或平台正确性。

## PR 交接

创建或更新 PR 前，阅读 `CONTRIBUTING.md` 与 `.github/PULL_REQUEST_TEMPLATE.md`。以最终 PR HEAD 的具体、现行证据完成模板；不要让 reviewer 仅凭 diff 重构意图、受影响面、适用指引、验证与失败/回滚考量。
