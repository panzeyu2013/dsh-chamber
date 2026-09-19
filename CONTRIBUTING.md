# 参与 dsh-chamber 贡献

感谢贡献！dsh-chamber是dsh的本地桌面连接管理器：控制面托管本地dsh实例（web profile），远程连接正交组合 `dsh|gateway` 目标与 `ssh|http` 传输；界面为dsh官方前端源码复用自建；显式启动的Gateway是认证默认开启的独立server形态。本指南涵盖流程、验证与合格PR标准。

> English: [docs/CONTRIBUTING.en-US.md](docs/CONTRIBUTING.en-US.md)

## 开发环境

环境搭建（要求、clone、vendor引导、`pnpm install`、`bundle:dsh`）、运行、构建/打包、CI/发布与仓库结构见开发文档 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

```bash
git clone <REPO-URL> --recurse-submodules
cd dsh-chamber
node scripts/dev/ensure-harness-vendor.mjs   # 必须在 pnpm install 之前
pnpm install
pnpm run dev:desktop                     # 完整窗口（控制面 + dsh 前端 + 桌面壳）
```

## 测试

根 `package.json` 脚本是CI测试清单的唯一权威，勿手工维护控制面测试文件枚举：

```bash
pnpm run test:control-plane
pnpm run test:runtime
pnpm run test:desktop
pnpm run test:gateway
pnpm run test:renderer-shell
pnpm run test:git && pnpm run test:host-git
pnpm run test:sidebar && pnpm run test:layout
pnpm run test:settings-bridge && pnpm run test:connections
pnpm run test:client-web && pnpm run test:connection
pnpm run test:open-in && pnpm run test:cli
pnpm run test:release-workflow
pnpm run smoke
```

`pnpm run smoke` 未安装dsh时打印SKIP并退出0，属正常而非失败。

## 提交前验证

```bash
pnpm run typecheck                            # tsc --noEmit（0 错误）
pnpm run typecheck:runtime
pnpm run typecheck:gateway
pnpm run typecheck:host-graph
pnpm run typecheck:host-git
pnpm run typecheck:sidebar                    # 客户端插件类型检查
pnpm run typecheck:layout
pnpm run typecheck:git
pnpm run typecheck:open-in
pnpm run typecheck:connections
pnpm run typecheck:settings-bridge
pnpm run typecheck:client-web                 # dsh-client-web 拷贝类型检查
pnpm run typecheck:connection                 # dsh-client-connection 拷贝类型检查
pnpm run test:control-plane && pnpm run test:runtime
pnpm run test:desktop && pnpm run test:gateway
pnpm run test:renderer-shell
pnpm run test:git && pnpm run test:host-git
pnpm run test:sidebar && pnpm run test:layout
pnpm run test:settings-bridge && pnpm run test:connections
pnpm run test:client-web && pnpm run test:connection
pnpm run test:open-in && pnpm run test:cli
pnpm run test:release-workflow
pnpm run smoke                                # PASS（或 SKIP，属正常）
pnpm run build:renderer                       # 渲染层构建成功
pnpm run build:gateway                        # gateway + dsh-runtime 构建成功
pnpm --filter @dsh-chamber/desktop run build:preload
pnpm run verify:i18n
pnpm run verify:styles
```

改动涉及运行时、认证、协议或桌面壳行为时，请补充或更新聚焦测试——静态检查不能证明运行时正确性。

## 代码风格

- 仅Erasable语法TypeScript（`"type": "module"`、零构建，源码经Node类型擦除原生运行，见 `tsconfig.json`）；契约校验手写TS（zod复用偏差见设计文档）。
- 遵循 `src/` 下既有结构：单职责文件 + 顶部文档注释。
- 错误处理与命名跟随邻近代码。
- 不做无关重构，保持diff聚焦。

## Commit 提交信息

提交遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 约定：

```
type(scope): subject
```

- type（类型）——以下之一：`feat`（新功能）、`fix`（缺陷修复）、`chore`（构建/工具/维护）、`docs`、`refactor`、`test`、`ci`、`perf`、`style`（仅格式）、`revert`。
- scope（范围）——可选；建议写受影响的包或领域：`control-plane`、`renderer`、`desktop`、`sidebar`、`settings-bridge`、`cli`、`ci`、`docs`、`packaging`。
- subject（主题）——祈使语气、句末不加句号、≤ 72字符（"fix" 而非 "fixed"；"add" 而非 "adds"）。
- 语言（强制）——提交信息一律用英文：subject与body都必须英文（下列示例即规范形态）。仓库历史中文提交为既有事实，非先例；本规则起新增提交必须英文，便于上游/外部贡献者检索。代码注释、设计文档与PR正文不受此限，仍可用中文。
- body（正文）——改动非自明时，空一行说明做了什么、为什么；适用时引用相关设计/进度文档或issue编号。
- 破坏性变更——在type/scope后加 `!`（如 `feat(desktop)!: ...`）或加 `BREAKING CHANGE:` 脚注，并在正文说明迁移影响。

示例：

```
feat(control-plane): add per-instance health endpoint
fix(desktop): await tunnel dispose before quit
ci(release): enforce channel-specific update assets
docs: document the commit message convention
```

一次提交只做一件逻辑变更；捆绑无关改动应拆分。

## 范围纪律

- 凡dsh宿主、插件生态或复用的dsh前端已提供的能力，控制面只做**接入或服务，绝不重造**。
- 被移出范围的域（walkthrough、通知中心/历史、终端渲染/输入、web预览、MCP、薄壳聊天UI、控制面会话运行时等）以任何形式**不得**回流。已定稿的有界例外：设计08的实例内Git worktree插件；设计17的独立gateway（shell/host职责/种子注册表）；设计18的共享dsh运行时管理核心；设计19的Electron原生通知边缘投影；设计20的可信open-in边缘能力（含仅本地形态的实例内host域 `openInApp`，边界见design 20 §6.3）；设计24的实例内归档清理宿主域 `archiveCleanup/{preview,purge,probe}`（只删不读、运行中整棵跳过、幂等；最窄边界见design 24 §2）。它们不得把执行面、session消费者、通知历史或事实权威带进 `packages/control-plane` 或renderer。
- 任何新领域功能提案先回答：dsh原生、插件生态或宿主web前端是否已覆盖？有 → 不开发。

## Pull Requests

PR是评审交接件，不是单纯diff：评审者须能不重构你的工作即理解意图、评估风险、验证结果。

开PR之前：

1. 阅读 [`AGENTS.md`](AGENTS.md) 与相关设计/进度文档（`docs/design/01-overview.md` 为入口）。
2. 保持改动聚焦：清理或重构拆到独立PR。
3. 运行改动所需的验证，而不只是上述宽泛命令。
4. 按PR模板填写针对最终HEAD的具体证据。

### PR 契约

每个PR必须说明：

- Intent（意图）：解决什么用户/维护者问题，行为如何变化。
- Non-goals（非目标）：范围有歧义时，明确哪些邻近行为刻意不动。
- Affected surfaces（受影响面）：涉及的packages、运行时、持久化/外部契约、用户可见状态。
- Repository guidance（仓库指引）：适用的AGENTS.md规则与所属设计/进度文档、为何适用、如何满足其约束。
- Validation（验证）：执行的确切命令与人工检查及其结果，以及未验证什么。只写命令名不算证据。
- Risk and failure behavior（风险与失败行为）：失败、回滚、清理、兼容性、安全、性能、跨运行时问题。

不得仅凭静态检查声称运行时、认证、协议或平台正确性。若无法执行必要验证，需明确说明原因。

## 不是开发者？

你仍然可以帮忙：

- 报告bug或UX问题——"这里感觉很困惑"也是有价值的反馈
- 在不同平台/环境测试（本地宿主、SSH、不同操作系统）
- 通过issue提功能建议
- 在issue里提问并帮助他人

## 问题？

打开一个 [issue](https://github.com/panzeyu2013/dsh-chamber/issues)，或阅读 [`docs/design/`](docs/design/) 下的设计文档。
