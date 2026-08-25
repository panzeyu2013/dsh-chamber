# 参与 dsh-chamber 贡献

感谢你参与贡献！dsh-chamber 是 dsh 的本地桌面**连接管理器**：本地 dsh 实例（web profile）由控制面托管，远程实例经 SSH 隧道接入，界面 = dsh 官方前端源码复用自建。本指南涵盖贡献流程、验证与一份合格的 PR 长什么样。

> English: [docs/CONTRIBUTING.en-US.md](docs/CONTRIBUTING.en-US.md)

## 开发环境

环境搭建（要求、clone、vendor 引导、`pnpm install`、`bundle:dsh`）、运行、构建/打包、CI/发布与仓库结构见**开发文档 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**。快速入场：

```bash
git clone <REPO-URL>
cd dsh-chamber
node scripts/ensure-harness-vendor.mjs   # 必须在 pnpm install 之前
pnpm install
pnpm run dev:desktop                     # 完整窗口（控制面 + dsh 前端 + 桌面壳）
```

## 测试

单测直接以 node 运行（当前无测试框架）：

```bash
node packages/control-plane/test/protocol.ts       # dsh 客户端协议
node packages/control-plane/test/storage.ts        # 存储与恢复
node packages/control-plane/test/m1-dsh-client.ts  # describe/health 客户端行为
node packages/control-plane/test/host-logs.ts      # 宿主日志环形缓冲
node packages/control-plane/test/manager-api.ts    # 管理 REST（/health、/api/connections）
node packages/control-plane/test/instance-proxy.ts # 每实例反代（HTTP/WS/SSE、503）
node packages/control-plane/test/static-serving.ts # 首屏静态服务与 boot manifest
node packages/control-plane/test/host-graph-seed.ts # chamber host 包 seed/overlay
pnpm run smoke                                      # 集成冒烟
```

这八个控制面测试文件正是 CI `test` job 执行的那套（见 `.github/workflows/ci.yml`），连同桌面传输层、renderer shell 与客户端/host 插件测试一起——与 CI 同一套，经根脚本驱动：

```bash
pnpm run test:desktop        # 桌面传输/ssh 单测
pnpm run test:renderer-shell # 复合 entry / host graph 锁步
pnpm run test:sidebar        # 侧边栏 derive/view-prefs 单测
pnpm run test:git            # Git worktree 客户端/事务单测
pnpm run test:host-git       # 实例内 Git host core 单测
pnpm run test:settings-bridge  # 设置壳策略单测
```

`pnpm run smoke` 在未安装 dsh 时打印 SKIP 并退出 0，属正常而非失败。

## 提交前验证

```bash
pnpm run typecheck                            # tsc --noEmit（0 错误）
pnpm run typecheck:host-graph
pnpm run typecheck:host-git
pnpm run typecheck:gateway                    # gateway 包类型检查
pnpm run typecheck:sidebar                    # 客户端插件类型检查
pnpm run typecheck:layout
pnpm run typecheck:git
pnpm run typecheck:open-in
pnpm run typecheck:connections
pnpm run typecheck:settings-bridge
pnpm run typecheck:client-web                 # dsh-client-web 拷贝类型检查
node packages/control-plane/test/protocol.ts  # 聚焦单测（见上方"测试"节）
node packages/control-plane/test/storage.ts
node packages/control-plane/test/m1-dsh-client.ts
node packages/control-plane/test/host-logs.ts
node packages/control-plane/test/manager-api.ts
node packages/control-plane/test/instance-proxy.ts
node packages/control-plane/test/static-serving.ts
node packages/control-plane/test/host-graph-seed.ts
pnpm run test:desktop                         # 桌面传输/ssh 单测
pnpm run test:gateway                         # gateway 传输/包单测
pnpm run test:cli                             # CLI 薄壳单测
pnpm run test:renderer-shell                  # renderer shell/覆盖表锁步
pnpm run test:sidebar                         # 侧边栏单测
pnpm run test:git                             # Git 客户端单测
pnpm run test:host-git                        # Git host 单测
pnpm run test:settings-bridge                 # 设置壳单测
pnpm run test:connections                     # 连接设置插件单测
pnpm run test:client-web                      # dsh-client-web 拷贝单测
pnpm run test:connection                      # 连接客户端 base-path 单测
pnpm run smoke                                # PASS（或 SKIP，属正常）
pnpm run build:renderer                       # 渲染层构建成功
```

改动涉及运行时、认证、协议或桌面壳行为时，请补充或更新聚焦测试——静态检查不能证明运行时正确性。

## 代码风格

- 仅 Erasable 语法 TypeScript（`"type": "module"`、零构建——源码由 Node 类型擦除原生运行，见 `tsconfig.json`）。契约校验为手写 TS（zod 复用偏差已在设计文档中记录）。
- 遵循 `src/` 下既有结构：单职责文件 + 顶部文档注释。
- 错误处理与命名与邻近代码保持一致。
- 不做无关重构，保持 diff 聚焦。

## Commit 提交信息

提交遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 约定：

```
type(scope): subject
```

- **type（类型）**——取以下之一：`feat`（新功能）、`fix`（缺陷修复）、`chore`（构建/工具/维护）、`docs`、`refactor`、`test`、`ci`、`perf`、`style`（仅格式调整）、`revert`。
- **scope（范围）**——可选，但建议写受影响的包或领域：`control-plane`、`renderer`、`desktop`、`sidebar`、`settings-bridge`、`cli`、`ci`、`docs`、`packaging`。
- **subject（主题）**——祈使语气、句末不加句号、≤ 72 字符（用 "fix"，不用 "fixed"；用 "add"，不用 "adds"）。
- **body（正文）**——改动非自明时，空一行后说明**做了什么、为什么**；适用时引用相关设计/进度文档或 issue 编号。
- **破坏性变更**——在 type/scope 后加 `!`（如 `feat(desktop)!: ...`）或加 `BREAKING CHANGE:` 脚注，并在正文说明迁移影响。

示例：

```
feat(control-plane): add per-instance health endpoint
fix(desktop): await tunnel dispose before quit
chore(ci): ad-hoc sign the macOS app in the afterPack hook
docs: document the commit message convention
```

一次提交只做一件逻辑变更，保持 diff 聚焦；捆绑无关改动的提交应拆分。

## 范围纪律

- 凡 dsh 宿主、插件生态或复用的 dsh 前端已提供的能力，控制面只做**接入或服务，绝不重造**。
- 被移出范围的域（walkthrough、通知中心、终端渲染/输入、web 预览、MCP、薄壳聊天 UI、控制面会话运行时等）**以任何形式不得回流**。唯一例外是设计 08 已定稿的 Git worktree 插件：只能是 chamber 强制打包的 client 插件 + 实例内领域限定 host Remote，绝不能回流为控制面/Desktop 的 Git 执行面。
- 任何新领域功能提案先回答：dsh 原生、插件生态或宿主 web 前端是否已覆盖？有 → 不开发。

## Pull Requests

PR 是评审交接件，不是单纯 diff。评审者必须能在不重构你工作的情况下理解意图、评估风险、验证结果。

开 PR 之前：

1. 阅读 [`AGENTS.md`](AGENTS.md) 与相关设计/进度文档（`docs/design/01-overview.md` 为入口）。
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

打开一个 [issue](https://github.com/<YOUR-ORG>/dsh-chamber/issues)，或阅读 [`docs/design/`](docs/design/) 下的设计文档。
