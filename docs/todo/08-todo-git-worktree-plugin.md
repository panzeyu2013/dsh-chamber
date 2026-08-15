# 08 · Git Worktree 独立插件（todo：设计定稿，实现未排期）

> **状态：todo**——范围决策已定稿（2026-08-16），本文为设计契约草案，实现
> 未排期（分期见 §8）。范围修订：`01-overview.md` §4 将 git/GitHub 由移出项
> 改写为**插件化**（不进控制面/本体，允许 chamber 强制打包的客户端插件形态），
> AGENTS.md / AGENTS.zh-CN.md / `docs/progress/STATUS.md` 已同步。
>
> 2026-08-16：本文档自 `docs/design/` 移入 `docs/todo/`（未实现功能记录区），
> "08" 编号沿用历史引用（AGENTS / 01-overview / STATUS 中的"设计 08"）。

## 1. 范围决策（2026-08-16 修订）

- 原 `01-overview.md` §4 将 git/GitHub 列为移出项（"P3 硬纪律，永不回流"，依据
  "宿主原生覆盖，控制面只接入/服务"）。核 vendor dsh（232 包）**无任何
  git/GitHub 包**——宿主并不覆盖 worktree 管理，排除前提不成立。
- **修订**：git/GitHub **不进控制面、不进本体**；允许以 **chamber 强制打包的
  客户端插件**形态提供（本插件 = 第一个实例：worktree 生命周期；未来 diff/
  commit 为插件内 feature 模块）。插件不重造 dsh 宿主执行面（宿主无此面，
  无重复风险）；控制面仍不消费宿主会话、不建立 git 索引。
- 本插件的服务对象是 **session**：为会话提供 worktree 切换与目录关联
  （workspace ↔ git 拓扑），是会话工作流的一部分，不是独立 git 工具面。

## 2. 形态总览（三层）

```
┌─ packages/dsh-chamber-client-ui-git（新，独立 chamber 客户端插件）────────┐
│  UI + 动作：侧栏 Git 区（v1）→ 未来任意屏幕位置（diff 面板等）               │
│  组件、状态机、i18n 命名空间、feature 模块（worktree/status/diff…）         │
└──────────┬─────────────────────────────────────────────────────────────┘
           │ 消费 chamberBridge 投影 + window.dshChamber.git.* + instance unary
┌─ packages/renderer（App 层，非插件）────────────────────────────────────┐
│  git 事实单点拉取（refreshAggregate 并行）→ 合入投影 server.git             │
└──────────┬─────────────────────────────────────────────────────────────┘
           │ preload contextBridge（新 desktop_git_* IPC 面）
┌─ packages/desktop（能力层，非插件）──────────────────────────────────────┐
│  git-runner.ts：local = child_process git（argv 数组/子命令白名单）        │
│  ssh-provider exec 新增 run action：remote = ssh host git …               │
└─────────────────────────────────────────────────────────────────────────┘
```

决策依据：git 插件保持纯 chamber 客户端插件形态（apply(ctx)、SlotMap 注册、
每 ctx 挂载一份），随 chamber 前端出现在任何 dsh 实例；未来 diff/commit 面板
只是插件注册的第二个座位（或由 renderer 直接挂载其导出组件），不依赖侧栏包。

## 3. 包结构

```
packages/dsh-chamber-client-ui-git/   # 包名 @dsh-chamber/dsh-client-ui-git
├── package.json            # exports "." / "./client" / "./shared"（对齐 sidebar 包模式）+ dsh.client.inject
├── src/
│   ├── index.ts            # host loader 桩（浏览器插件 apply 为空，对齐 sidebar 包）
│   ├── client/
│   │   ├── index.ts        # 插件注册 apply(ctx)：locale 命名空间 + slots.register('sidebar.git')
│   │   ├── SidebarGitSection.tsx   # v1 侧栏座位 occupant
│   │   ├── NewWorktreeDialog.tsx   # 创建对话框（preview → confirm）
│   │   ├── worktree-state.ts       # 创建流程状态机（pending→ready/failed，lifecycle version）
│   │   ├── git-facts.ts            # 投影 → 行内事实（branch/dirty/拓扑分组，纯函数）
│   │   ├── locales.ts              # i18n 命名空间 "sidebar-git"（zh/en）
│   │   └── *.module.css
│   └── shared/
│       ├── git-api.ts              # window.dshChamber.git.* 守卫封装 + 错误折叠
│       └── types.ts                # WorktreeInfo/GitRepoTopology/GitExecResult 等 wire 形状
└── test/
```

- 依赖：`@dsh-chamber/dsh-client-ui-sidebar`（**仅 `./shared`**：chamberBridge +
  instance-api，不碰其 UI）+ dsh 标准 peer 集（slots/primitives/locale/runtime）。
- **shared 抽取决策**：chamberBridge/instance-api 的消费者 = renderer、sidebar、
  本插件（引入即第三个）——"第三个消费者才抽取"的判据已被本设计自身触发。
  v1（M1–M4）**刻意延后**：抽取是纯机械重构（搬文件 + 改 import + vite 共享
  chunk），不与功能交付混排；与 M5（diff 面板铺开、出现第四个消费者）一并
  执行，抽成 `@dsh-chamber/shared`（chamberBridge + instance-api + derive +
  view-prefs）。M5 前依赖方向固定为 git 插件 → sidebar 包 shared（单向，与
  renderer 同款消费面）。

## 4. 挂载机制（sidebar.git 座位 + 未来扩展）

- sidebar 包（`dsh-chamber-client-ui-sidebar`）`slots.ts` 新增座位声明：
  `'sidebar.git': { kind: 'single'; scope: 'root'; owner: SidebarGitOwnerProps }`；
  `SidebarRoot` 在**多来源列表区之后、foot（sidebar.settings /
  sidebar.footer.action）之前**渲染该座位（折叠态隐藏，与 wide 联动，沿用
  现有 wide/expandSidebar inject 惯例）。
- git 插件 `apply(ctx)` 注册进该座位：
  `ctx.slots.register({ name: 'sidebar.git', locale: 'sidebar-git' }, SidebarGitSection)`
  （座位声明经 declare module 合并，sidebar 包对 git 插件类型零依赖）。
- 未来扩展路径（不提前实现，结构上留好）：
  - 每个 feature 是插件内独立模块（worktree-lifecycle、git-status、未来
    git-diff、git-commit）；
  - 全屏 diff 面板 = 插件导出 GitPanel 组件 + renderer App 层（页面宿主的挂载
    权）在任意屏幕位置挂载——renderer 经 **vite workspace alias 直接 import**
    插件导出组件（与 `@dsh-chamber/dsh-client-ui-sidebar/shared` 同款机制），
    与 v1 座位无关；
  - 若未来要跨实例统一面板，走 chamberBridge 已有模式（App 发布、插件订阅），
    无需新协议。
- **徽标数据所有权**：sidebar 行徽标默认读同一投影——`server.git` 字段
  **声明在 sidebar 包的 `aggregate-store.ts`**（非 git 插件包），sidebar 渲染
  徽标不依赖 git 插件类型；git 插件消费同一字段（依赖方向仍为 git 插件 →
  sidebar shared）。若想完全解耦，徽标可只放 git 插件区内——二选一，默认投影
  徽标（成本最低）。

## 5. 数据流（单点拉取，App 层唯一 fetcher）

```
refreshAggregate(instanceId)（现有，10s 聚合轮询）
  ├─ fetchInstanceSnapshot()          # 现有 workspace/session 快照
  └─ fetchGitFacts(instanceId, paths) # 新增：window.dshChamber.git.topology(instanceId, paths)
       # paths = 该来源快照的 workspace 路径集（无 git 目录的路径静默跳过）
       └─ 合入投影：ChamberServerAggregate.git   # {repos: GitRepoTopology[], error?}
```

- 投影扩展（sidebar 包 `aggregate-store.ts` 声明）：
  - `ChamberServerWorkspace.git?: { branch: string | null; dirty: boolean; linked: boolean; repoRoot: string }`
  - `ChamberServerAggregate.git?: { repos: GitRepoTopology[]; error?: string }`
- **拉取节奏（v1 定稿）**：git 事实**独立于 10s 聚合轮询**，走 **30s 节奏**
  （`git status --porcelain` 在大仓与远端 ssh 往返上不便宜，10s 过密）；git
  动作成功后 requestRefresh 即时重拉；区段折叠/隐藏时跳过拉取（v1 可选优化）。
- 失效纪律（沿用现有模式）：来源断连 → 清 `server.git`；拉取失败 →
  `git.error` 显式呈现（不静默）；git 动作成功 → `chamberBridge.requestRefresh`
  触发 App 层重拉（元数据与快照同周期刷新，动作后立即）。
- git 事实与动作不混：事实由 App 层拉取发布；动作（preview/create/remove）由
  插件直调 IPC + instance unary，成功后仅请求刷新。

## 6. 执行层（能力层，非插件）

desktop main：`git-runner.ts`

- **local**：`child_process` 跑 git，argv 数组拼装（绝无 shell 字符串），子命令
  白名单（`worktree|rev-parse|status|branch|show-ref|ls-remote|remote`），目录
  参数 realpath 规范化 + 必须存在，stderr 脱敏复用现有纪律。
- **选项注入防护（本地与远端同款）**：所有参数禁 `-` 前缀（白名单内显式允许
  的标志除外，如 `--porcelain`）；分支/路径等自由参数经 `--` 分隔符或显式拒绝；
  `ls-remote` 带 `GIT_TERMINAL_PROMPT=0` + 超时（无 tty 主进程凭据提示挂起防护）。
- **每仓库操作串行化**：worktree add/remove 按 repoRoot 加互斥（同仓并发
  add/remove 竞态防护）。
- **remote**：ssh provider `TransportExecAction` 增加 `'run'`——`ssh [-p port]
  user@host git <argv...>`。**接口涟漪（五处同步）**：`TransportExecAction`
  扩为 `'start'|'stop'|'is-active'|'run'`；`exec(spec, action, deps, payload?)`；
  `TransportExecDeps`；`transport-manager.exec(id, action, payload?)`；IPC 包装
  （`desktop_ssh_run_git`）+ preload。复用现有 host/user 禁 `-` 前缀防护、
  超时/断开、投影纪律；**远端无 git 二进制 → 显式 {error}（不静默）**。
- preload.cts 新面 `desktopGit`：`topology(instanceId, paths)` /
  `worktreePreview(instanceId, repoPath, payload)` / `worktreeCreate(...)` /
  `worktreeRemove(...)`——非 secret 投影形状（WorktreeInfo 只含 path/branch/
  headState/status）。
- **bootstrap 观测（不新增 IPC）**：不做 `worktreeBootstrapStatus` IPC——
  bootstrap 是 dsh 实例事实，不是 git 事实。创建流程成败由插件经既有通道
  观测：chamberBridge open 通道（App 层 open 结果）+ 下一轮快照拉取（新
  workspace 出现/不出现）；失败清理（worktree remove --force）由插件直调
  worktreeRemove。
- web 构建：window.dshChamber 缺失 → git 插件座位渲染空/隐藏（守卫可选链，
  先例：settings-connections）。

## 7. 功能范围（v1 = worktree 生命周期闭环）

| 功能 | 说明 |
|---|---|
| 拓扑展示 | 每来源按 repoRoot 分组（主 checkout + linked worktrees），移植 OpenChamber partitionWorktreesByRegisteredProject 防重复（**复制代码前核对许可证**） |
| 状态徽标 | branch + dirty 点 + pending/invalid/missing 状态（invalid/missing 显式提示） |
| 创建工作树 | 对话框：选仓库、新分支/已有分支、preview 目录名 → worktree add（fast-return）→ workspace.create({path}) → session.create({workspaceId}) → 打开会话（复用现有 open 通道）→ 经既有通道观测 bootstrap（无 setup 命令 → 单阶段 git-ready），失败自动 worktree remove --force 清理 + inline 报错 |
| 删除工作树 | 确认对话框（可选删本地分支）→ 归档会话 → workspace.delete → worktree remove（活跃会话守卫） |
| 无 git 目录 | 静默无徽标（不误报） |
| 远端无 git 二进制 | 来源级显式 git.error（不静默） |

明确不做：commit/diff/stash/PR 等深度 git 面——那是插件内未来 feature 模块
（M5+），本方案只保证其结构空间。

## 8. 实施分期

| 里程碑 | 内容 | 验证 |
|---|---|---|
| M1 | desktop git-runner(local) + desktopGit IPC + App 层 git 事实通道 + server.git 投影（30s 独立节奏） | 单测（argv/白名单/选项注入/脱敏/串行化）、build:renderer、verify:i18n |
| M2 | 插件包骨架 + sidebar.git 座位声明/渲染 + 拓扑展示/徽标（投影字段声明在 sidebar aggregate-store） | 插件单测（git-facts 纯函数）、build、手测 |
| M3 | 创建/删除流程 + worktree-state 状态机 + 清理（bootstrap 经既有通道观测） | worktree-state 单测、手测 |
| M4 | ssh provider run action（exec payload 接口涟漪五处）+ 远程事实/动作 | transport 单测、手测 remote |
| M5（可选） | 插件 feature 模块扩展：diff 面板等，renderer 挂载；`@dsh-chamber/shared` 抽取（chamberBridge/instance-api 中性化） | 届时按需 |

## 9. 风险与边界

- 跨包依赖方向：git 插件 → sidebar 包仅限 shared 模块（chamberBridge /
  instance-api）；sidebar 包不得反向依赖 git 插件（座位声明用 declare module
  合并、投影字段声明在 sidebar aggregate-store，类型上零依赖）。
- 多 ctx 挂载：插件每实例一份，但事实只 App 层拉一次（每来源），插件间无
  状态共享冲突；动作均带 instanceId 路由。
- 幂等：branch 已存在/占用、目录已存在（OpenChamber 错误码移植）创建前校验；
  创建失败无残留（remove --force 清理）。
- 安全：无 secret 进渲染层/日志/持久化（沿用 AGENTS 铁律）；本地与远端同款
  argv 白名单 + 选项注入防护；`ls-remote` 无 tty 挂起防护（GIT_TERMINAL_PROMPT=0
  + 超时）。
- 并发：worktree add/remove 按 repoRoot 串行化；git 事实拉取 30s 独立节奏
  控制大仓/远端开销。
- 合规：OpenChamber partition 逻辑移植前核对许可证。
