# 参与 dsh-chamber 贡献

感谢你参与贡献！dsh-chamber 是 dsh 的本地桌面**连接管理器**：本地 dsh 实例（web profile）由控制面托管，远程实例经 SSH 隧道接入，界面 = dsh 官方前端源码复用自建。本指南涵盖环境搭建、开发、验证，以及一份合格的 PR 长什么样。

> English version: [CONTRIBUTING.md](../CONTRIBUTING.md)

## 环境搭建

```bash
git clone <REPO-URL>
cd dsh-chamber
pnpm install
```

要求：Node.js 22+（推荐 LTS，见 `.nvmrc`）。本仓库使用 pnpm workspaces；`vendor/harness-packages` 是指向外部 dsh 源码 checkout 的只读符号链接（见 README 安装说明）。

## 仓库结构

```
packages/
  control-plane/    控制面核心（web profile 宿主托管、
                    管理 REST、每实例反代、前端服务）
  renderer/         自建 dsh 前端（源码复用：纯 dsh 首屏桥接宿主 +
                    N-ctx 编排、启动图清单）
  dsh-chamber-client-ui-sidebar/  自研侧边栏插件（多来源会话导航 + chamberBridge；
                    替换官方 ui-sidebar 注册）
  dsh-chamber-client-ui-settings-connections/
                    自研连接设置插件（本地实例卡 + 远程主机 CRUD/连接/
                    systemd/日志，settings.section）
  dsh-chamber-client-ui-settings-bridge/
                    自研设置壳插件（shadow 官方 SettingsRoot 注册；所选实例
                    官方设置分区上的服务器下拉）
  desktop/          Electron 壳（单 frame、transport-manager + ssh provider、实例注册表、IPC）
  cli/              CLI 薄壳
docs/
  design/           设计文档（01-overview.md 为入口；
                    05-connection-manager.md 为表面/架构契约）
  progress/         模块完成状态（STATUS.md 为总览）
```

## 开发脚本

除非另有说明，均在仓库根目录运行。

| 脚本 | 说明 |
|---|---|
| `pnpm run dev:control-plane` | 启动控制面（管理 REST + 静态前端），端口 17500 |
| `pnpm run dev:desktop` | Electron 壳：完整窗口（控制面 + dsh 前端 + 桌面壳） |
| `pnpm run build:renderer` | 构建 dsh 前端 bundle |
| `pnpm run build:desktop` | renderer 构建 + 控制面编译 + dsh 运行时封装 |
| `pnpm run dist:desktop:mac` | 打包 macOS 应用（dmg + zip） |
| `pnpm run cli -- --help` | CLI 薄壳 |
| `pnpm run smoke` | 控制面集成冒烟 |
| `pnpm run typecheck` | Strict `tsc --noEmit`（0 错误） |
| `pnpm run verify:i18n` | EN ↔ 中文对漂移时报错（同步后用 `-- --write` 重新记录） |

### 测试

单测直接以 node 运行（当前无测试框架）：

```bash
node packages/control-plane/test/protocol.ts       # dsh 客户端协议
node packages/control-plane/test/storage.ts        # 存储与恢复
node packages/control-plane/test/m1-dsh-client.ts  # describe/health 客户端行为
node packages/control-plane/test/host-logs.ts      # 宿主日志环形缓冲
node packages/control-plane/test/manager-api.ts    # 管理 REST（/health、/api/connections）
node packages/control-plane/test/instance-proxy.ts # 每实例反代（HTTP/WS/SSE、503）
pnpm run smoke                                      # 集成冒烟
```

这六个控制面测试文件正是 CI `test` job 执行的那套（见 `.github/workflows/ci.yml`），连同桌面传输层测试（`packages/desktop/transport-manager.test.ts`、`ssh-provider.test.ts`、`ssh-config.test.ts`）与客户端插件测试一起——与 CI 同一套，经根脚本驱动：

```bash
pnpm run test:desktop        # 桌面传输/ssh 单测
pnpm run test:sidebar        # 侧边栏 derive/view-prefs 单测
pnpm run test:settings-bridge  # 设置壳策略单测
```

`pnpm run smoke` 在未安装 dsh 时打印 SKIP 并退出 0，属正常而非失败。

### 桌面壳

```bash
pnpm --prefix packages/desktop run bundle:dsh   # 将官方 @deepseek-ai/dsh 发布包安装到 vendor/dsh
pnpm run dev:desktop
```

## 提交前验证

```bash
pnpm run typecheck                            # tsc --noEmit（0 错误）
pnpm run typecheck:sidebar                    # 客户端插件类型检查
pnpm run typecheck:connections
pnpm run typecheck:settings-bridge
node packages/control-plane/test/protocol.ts  # 聚焦单测（见上方"测试"节）
node packages/control-plane/test/storage.ts
node packages/control-plane/test/m1-dsh-client.ts
node packages/control-plane/test/host-logs.ts
node packages/control-plane/test/manager-api.ts
node packages/control-plane/test/instance-proxy.ts
pnpm run test:desktop                         # 桌面传输/ssh 单测
pnpm run test:sidebar                         # 侧边栏单测
pnpm run test:settings-bridge                 # 设置壳单测
pnpm run smoke                                # PASS（或 SKIP，属正常）
pnpm run build:renderer                       # 渲染层构建成功
```

改动涉及运行时、认证、协议或桌面壳行为时，请补充或更新聚焦测试——静态检查不能证明运行时正确性。

## 代码风格

- 仅 Erasable 语法 TypeScript（`"type": "module"`、零构建——源码由 Node 类型擦除原生运行，见 `tsconfig.json`）。契约校验为手写 TS（zod 复用偏差已在设计文档中记录）。
- 遵循 `src/` 下既有结构：单职责文件 + 顶部文档注释。
- 错误处理与命名与邻近代码保持一致。
- 不做无关重构，保持 diff 聚焦。

## 范围纪律

- 凡 dsh 宿主、插件生态或复用的 dsh 前端已提供的能力，控制面只做**接入或服务，绝不重造**。
- 被移出范围的域（git/GitHub 执行、walkthrough、通知中心、终端渲染/输入、web 预览、MCP、薄壳聊天 UI、控制面会话运行时等）**以任何形式不得回流**。
- 任何新领域功能提案先回答：dsh 原生、插件生态或宿主 web 前端是否已覆盖？有 → 不开发。

## Pull Requests

PR 是评审交接件，不是单纯 diff。评审者必须能在不重构你工作的情况下理解意图、评估风险、验证结果。

开 PR 之前：

1. 阅读 [`AGENTS.md`](../AGENTS.md) 与相关设计/进度文档（`docs/design/01-overview.md` 为入口）。
2. 保持改动聚焦：清理或重构拆到独立 PR。
3. 运行改动所需的验证，而不只是上述宽泛命令。
4. 按 PR 模板填写针对最终 HEAD 的具体证据。

### PR 契约

每个 PR 必须说明：

- **Intent（意图）**：解决什么用户/维护者问题，行为如何变化。
- **Non-goals（非目标）**：范围有歧义时，明确哪些邻近行为刻意不动。
- **Affected surfaces（受影响面）**：涉及的 packages、运行时、持久化/外部契约、用户可见状态。
- **Repository guidance（仓库指引）**：适用的 AGENTS.md 规则与所属设计/进度文档、为何适用、实现如何满足其约束。
- **Validation（验证）**：执行的确切命令与人工检查及其结果，以及未验证什么。只写命令名不算证据。
- **Risk and failure behavior（风险与失败行为）**：失败、回滚、清理、兼容性、安全、性能、跨运行时问题。

不得仅凭静态检查声称运行时、认证、协议或平台正确性。若无法执行必要验证，需明确说明原因。

## 不是开发者？

你仍然可以帮忙：

- 报告 bug 或 UX 问题——"这里感觉很困惑"也是有价值的反馈
- 在不同平台/环境测试（本地宿主、SSH、不同操作系统）
- 通过 issue 提功能建议
- 在 issue 里提问并帮助他人

## 问题？

打开一个 [issue](https://github.com/<YOUR-ORG>/dsh-chamber/issues)，或阅读 [`docs/design/`](design/) 下的设计文档。
