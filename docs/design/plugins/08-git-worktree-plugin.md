# 08 · Git Worktree 独立插件（seed rail + 官方 forge 同池）

> **目标模型**：工作树是**仓库内的 Git checkout**，不是 dsh workspace。每个 checkout 落在 `<repo>/.agents/worktrees/<name>`（主 checkout 之内、自忽略），会话仍以源主 checkout 为根，创建后经 `gitWorktree/enter` 把 `workingDirectory` 切进 checkout。chamber seed 提供仓库级管理 rail（snapshot/create/enter/remove）；官方 `@deepseek-ai/dsh-experimental-forge-bundle`（opt-in）提供 agent 的 `create_worktree` 工具与 composer/restore UI，两套创建引擎共用同一个池与同一套行/放置。旧 `$DSH_HOME/worktrees` 池**不迁移、不检测、不提示**（§7.4）。开放状态见 [STATUS](../../progress/STATUS.md)。

## 1. 边界与部署形态
**原则：Git 只是会话工作区的实例内扩展，不是控制面或 Desktop 的新执行面。**

1. `TransportExecAction.run`、SSH `run`/`write-file` 与 manager payload 涟漪由 design 13 承担；不得再扩接口形状。
2. SSH 注册用户不保证等于 dsh systemd 进程用户：工作区权威属 dsh 进程的文件系统， Desktop 不能用另一用户 namespace 冒充；Git 不在 Desktop/SSH 侧执行。
3. 控制面不建立 Git 索引、不运行 Git、不持有 checkout 事实；它只 seed 宿主包、挂 `--patch` 并通用反代 Remote。
4. **checkout 不是 workspace**（不变量 I3）：创建只产生 Git 工作树，不调 `workspace.create`、不调 `session.create`、不产生注册表行；侧栏的 checkout 行由 App 从 Git layout **派生**（`kind:'checkout'`，§3）。
5. **同池**：seed 的 `create` 与 forge 的 worktree 服务都写 `<主 checkout>/.agents/worktrees/`，遵守同一自忽略协议；seed 的 snapshot 是两者的唯一 inventory，删除/守卫统一由 seed 负责。
6. **P5b opt-in**：forge bundle 默认不启用；用户在实例前端 Plugins → More 开启“Change requests & worktrees”，启用/关闭需重启。chamber 不预置该 bundle，也不以自定义 profile 冒充默认（§7.2）。
7. **node 已保证，不做回退形态**：Swift 用 sidecar 自带 node（Electron 归档参考由 control-plane 的 PATH shim / string-only 解析提供 `node`，绝不写 `process.execPath`）；远程用 bundle 默认的 `node` + 部署方 PATH。缺失 = fail-fast + 诊断，不设计 E1/E2 回退。
8. **Swift 原生壳与 sidecar 是唯一出货形态**：P5b 在 Swift 壳内验收（§7.3；Electron 冻结归档，不再作为验收形态——见 `../progress/electron-frozen.md`）。
9. **worktree 是目录，不是权限边界（上游语义）**：上游 `workingDirectory.set` 的契约是“切换目录，不改变现有进程或权限”；`sandboxPolicy` 的 `workspaceRoot` 始终取 `session.header.cwd`（会话原始 workspace），池内 checkout 只有落在该根之下才可写。 chamber 不修改这一默认，也不把 worktree 注册成 workspace；会话仍属于源 workspace （官方 UI / mobile / gateway 亦按源 workspace 分组）。fork、subagent、AGENTS.md 与 skills 的目录解析都走 effective `workingDirectory`（fork 另经事件回放继承），与上游一致。

```text
┌─ 侧栏（自建）──────────────────────────────────────────────┐
│ 派生 checkout 行、拖动/折叠/树/glyph、创建对话框、删除确认   │
└───────────────┬───────────────────────────────────────────┘
                │ per-instance unary（/api/i/<id>/api/gitWorktree/*）
                ▼
┌─ @dsh-chamber/dsh-chamber-seed-git-worktree（实例进程内）──┐
│snapshot / branches / previewCreate / create / enter / remove│
│ workspaceRegistry + live agents 权威守卫；spawn("git", argv)│
└───────────────┬───────────────────────────────────────────┘
                │ 同一池（<repo>/.agents/worktrees）
                ▲
┌─ 官方 forge-bundle（P5b，opt-in）──────────────────────────┐
│ 单一 worktree 服务（tool create_worktree）+ 平铺 forge-panel  │
│ composer/创建卡/hold/restore/右栏 tab；GitHub 行 disabled    │
└───────────────────────────────────────────────────────────┘
```
- `packages/renderer` 只把客户端插件静态注册到复合 entry，不拥有 Git 事实、轮询或 UI。
- `packages/desktop` 仅在远程实例 ready 时分发同一 host 包，不暴露 `desktopGit`，也不运行 `ssh ... git ...`。
- `packages/control-plane` 只负责 seed/overlay 与通用反代；P5b-0 的 bundle 行 disable、 node PATH shim 属于控制面，不属于本域执行面。
- **v1 明确不做**：worktree 内 stage/commit/diff 的自研执行面；GitHub PR 面板/行图标；任意 Git 终端；一树一活跃会话锁；自研 restore。

## 2. Host Remote 契约
namespace 固定为 `gitWorktree`：

| 方法 | 语义 |
|---|---|
| `snapshot()` | 从 `workspaceRegistry.list()` 出发找 repo，按 absolute `git-common-dir` 去重，返回 pool 内 worktree/branch/HEAD/dirty/locked 与主 checkout 的 workspace 关联；单 repo/path 错误与完整 repo 并存 |
| `branches(input)` | 只读查询 `{sourceWorkspaceId}`：按 workspaceId 定位已注册 workspace，与 `previewCreate` 同源门禁（workspace 存在 → `assertSourceShape`（非仓库/子目录/submodule 拒绝）→ topology → 主 checkout 断言 `source-not-main-checkout`），现场直读 `git show-ref --heads`，返回回显 `sourceWorkspaceId`、宿主铸造 `repoId`、本地分支名、`checkedOutBranches`（advisory）与 `truncated`；分支名有界（§2.1），失败显式报错而非空数组 |
| `previewCreate(input)` | 验证 repo id、来源必须是主 checkout、本地分支、目标 parent/basename 和当前 HEAD，返回短期 capability token；preview 不是最终授权 |
| `create(input)` | 在 common-dir mutex 中重新验证；`operationId` 合并重复请求；只产生 checkout（无 workspace/session/rollback） |
| `enter(input)` | 薄契约 `{sessionId,path}`：校验会话根、checkout 为权威 topology 中的精确 worktree 根且在会话根之内，然后经宿主 `workingDirectory` 服务切换会话目录；不建会话、不改注册表 |
| `remove(input)` | path-based，只删权威 worktree list 中的 linked worktree；main、locked、registered、嵌套 workspace、身份变化都拒绝；running 读 effective cwd；dirty 默认拒绝，显式 `discardChanges` 才 `--force`；不触碰任何会话/归档 |
RPC 只接受领域 operation，不接受任意 Git argv。`branches` 是只读查询：不产生 mutation、不取 common-dir mutex。所有 mutation 的锁键是 canonical common-dir，不是 renderer 提供的 repo path。**没有 `rollbackCreate`**：创建失败不自动删树（原因见 §2.3 与 §6.2），也没有 registered remove / workspace.delete 分支。

Typert carrier 把普通业务异常归并为 `internal`，故所有方法都在 carrier success 内返回第二层领域 envelope：`{ok:true,value}` 或 `{ok:false,error:{code,message,retryable?,details?}}`。客户端必须同时验证两层 envelope，并对每个 success value 做运行时 shape 与请求相关性校验；路径、operation/worktree/repo id、branch 或 HEAD 任一错配都不得推进 delete 副作用。

### 2.1 快照字段、发布范围与容量
- **行字段**：worktree/branch/HEAD/dirty/locked、`isMain`、`workspaceId`（仅主 checkout / 已注册 workspace 有值）、`sessionIds`、`runningSessionIds`、 `blockingRunningSessionIds`（§2.5）；每行另带 `status`（ready/missing/invalid/not-a-repo）、 `headState`（branch/detached/unborn）、`attention`（MERGE/REBASE/rebase-*/CHERRY_PICK/ REVERT/BISECT 的 git-dir 探测）、`upstream`/`ahead`/`behind`（本地 ref 事实，永不 fetch）。客户端解码强制校验这些字段（对旧 host 包 fail-closed）。
- **只发布池内 checkout**：未注册 checkout 只有落在 `<mainPath>/.agents/worktrees/` 之下才进入客户端 layout；池外未注册 worktree（包括旧 `$DSH_HOME/worktrees` 残留、外部工具手工建的树）既不成行、也不变成 missing 行——“不检测、不提示”是基线形态（§7.4）。已注册 workspace 仍按 workspace 行关联（`workspaceId` 非空）；主 checkout 未注册时该 repo 没有派生行（§3.2）。
- **孤儿/关联诊断**：注册 workspace 路径不可解析时，host 在快照 `errors` 里加一条逐行诊断（路径消失 = `path-unavailable`，兜底码 `workspace-path-failed`，带 `workspaceId`）；客户端据此把该 workspace 的 flags 合并为 `orphaned: true`（保留既有 worktree 身份）。新模型下这是**旧 registered worktree 遗留形态**；新 checkout 不注册，因此不产生该诊断。
- **容量与预算**：Snapshot 共用一个 in-flight：20 秒是 probe launch/Git budget，25 秒是对客户端的 wall response deadline；上限 128 workspace、64 repo、每 repo 128 且全源合计 256 worktree、16K session memberships；running agent cwd 每轮至多 canonicalize 一次。超限/超时返回显式 source error 与已有局部事实，不伪装成健康空结果。Node 的 FS await 无法安全取消，25 秒后旧 scan 可继续，但退出前 single-flight 不释放，后续 poll 复用 deadline 结果，绝不启动重叠扫描。
- **幂等记录 TTL**：preview 最长保留 5 分钟；create/remove operation 最长保留 24 小时。容量压力下只可淘汰从未进入 mutation、无外部 effect/provenance 的最老 `ready` 记录； `created/uncertain/removed` tombstone 在 TTL 内不得提前淘汰，否则宁可 fail-closed `operation-capacity`。进程重启丢内存幂等缓存，恢复仍以 fresh registry + Git topology 为权威，绝不依赖缓存作安全凭据。
- **发现缓存**：create/remove 提交后必须使该仓库发现缓存失效（否则新 worktree 在 TTL 内不可见）；快照每 repo 每轮只跑一次 `show-ref`，快照的 `branches` 字段消费该次结果。仓库级快照失败 keep 上一快照，flag 不闪失。
- **`branches` 按需读取**：`snapshot.branches` 降级为 picker 的旧宿主/读取失败回退，不再是首选数据源；按需读不读也不写发现缓存，也不 join 快照的 single-flight，每次调用现场直读 `git show-ref --heads`。响应有界：本地分支名与 `checkedOutBranches` 各至多 `MAX_BRANCH_CANDIDATES=1024`，任一截断即 `truncated:true`；`checkedOutBranches` 来自同一次 topology 读取，是 advisory 提示，不参与任何校验。该读不取 common-dir mutex——它可能观察到 mutation 的中间态，权威校验仍在锁内的 `previewCreate`/`create`。
- **空与失败必须可区分**：`show-ref` 非零退出且带输出、或输出协议漂移 = 显式错误（复用域内既有错误码，如 `git-command-failed`/`git-protocol-error`），绝不静默返回空数组；空输出（exit 1，或个别 Git 版本的 exit 0，防御性声明）= 真空仓库/无本地 refs 的事实，不是失败。
- **成本与去重**：每次调用 7 个 git 子进程（`assertSourceShape` 3×`rev-parse` + `discover` 2×`rev-parse` + `worktree list` + `show-ref`；旧 Git 的 `-z` 回退会多一次），与 `previewCreate` 的前置同源；registry 读不是 git 子进程。该读**不做跨调用缓存/单飞**——它是对话框的动作型查询，用跨打开的 TTL 缓存换陈旧不可取（每次打开一次读取），加载态因此沿用既有 git RPC 的 60s 预算（慢实例下选择器最长禁用 60s）。

### 2.2 工作树池、来源与分支解析
- **统一池**：`<主 checkout>/.agents/worktrees/<name>`（相对路径，位于源 workspace 之内）。 seed 与 forge 都遵守：root 已存在不覆盖；首次创建幂等写 `<pool>/.gitignore`（内容 `*\n`， create-only；已存在不重写，绝不动仓库自己的 `.gitignore`）；不可写 = `ignore-unavailable` fail-closed，且发生在 mutation 之前。池自忽略使创建后源仓库 `git status --porcelain` 为空。
- **来源必须是主 checkout**：`previewCreate` 与 `create` 双处断言 `existingPath(workspace.path) === topology.mainPath`，否则 `source-not-main-checkout` （linked worktree / 子目录源拒绝）；containment 相对 **canonical source**，不是池根自身（`resolve(pool, basename)` 与池根比较是恒真）。submodule 源另有 commonDir 是否在源根之内的断言（`outside-writable-root`）。
- **来源分支（startRef）**：新分支从所选本地分支 HEAD 起（`localBranchHead` 解析为精确 commit 钉死为 baseHead，create 复验——比仅传 ref 名更严格）；缺失报 `branch-not-found`；解析层必须放行并保留 `startRef`（`parsePreviewInput` 不得丢弃），再做 safeBranchName 校验；`localBranchHead` 非零退出且为「分支不存在」（exit 128）时按 null 返回。
- **分支模式**：`existing` 分支必须存在且未被其它 worktree 检出（`branch-checked-out`）； `new` 分支必须不存在（`branch-exists`）。创建后以权威 topology 复核 branch/HEAD/baseHead。
- **upstream/ahead/behind**：快照 status 加 `--branch`（白名单固定形状）， `parseBranchLine` 解析 `## b...u [ahead N, behind M]`；数字基于本地 refs（永不 fetch）；脏检测 = 「表头之后有内容」。

### 2.3 创建：两段 checkout 与 filters parity
```text
preview -> (common-dir mutex) 复验 -> worktree add --no-checkout
        -> 枚举 filter.* -> reset --hard（GIT_CONFIG_* + GIT_LFS_SKIP_SMUDGE）
        -> 权威 topology 复核 -> created
```
1. **preview 不是授权**：preview 记录 token、commonDir/mainPath、targetPath、branch、 baseHead 与来源 workspace；expires 5 分钟。create 在锁内重新读取 workspace 与 topology， `preview-stale` 覆盖仓库/主 checkout/来源分支/目标身份的任何变化。
2. **只产生 checkout**：不调 `workspace.create` / `session.create` / `rollbackCreate`。创建成功只返回 `{operationId,created,replayed,repoId,worktreeId,commonDir,path,branch,head, branchCreated}`。UI 的“新建会话”是另一条动作（§4.2）。
3. **两段 checkout（forge parity）**：先 `worktree add --no-checkout [--] <path> <branch|baseHead>` 只写 admin 记录；再对目标路径 `git config --null --name-only --get-regexp '^filter\.'` **只读枚举**驱动，随后 `reset --hard --no-recurse-submodules HEAD`，以命令级 `GIT_CONFIG_COUNT/KEY_n/VALUE_n` 覆盖该驱动的 `clean/smudge/process` 为空、`required=false`；runner 另注入 `GIT_LFS_SKIP_SMUDGE=1`（以及 `GIT_NO_LAZY_FETCH=1`）。命令级 `GIT_CONFIG_*` 与 `-c` 同优先级，胜过仓库/系统配置；**不改用户 Git config**。
4. **LFS/clean-smudge 降级（已接受）**：checkout 里 LFS 对象是**指针文件**，clean/smudge/ process 驱动被禁用；用户需要时在 checkout 里手动 `git lfs pull`（或自行恢复驱动）。这是与 forge 对齐的语义，发布说明与 STATUS 登记，不作为发布阻断；发布验收覆盖 LFS/required 夹具。
5. **幂等与不确定结果**：`operationId` 绑定 preview；并发同 id 复用同一 promise；timeout/ 输出超限/非零退出后同 id 重试若 fresh topology 已精确收敛到目标（commonDir/path/branch/ HEAD/baseHead），可作 PUT 式前向成功返回，但 `branchCreated` 只在本 operation 观察到 `git worktree add` exit 0 时为 true。**没有自动回滚**：失败可能留下新分支/空目录，客户端只保留恢复项让用户核对/重试；不用 `--force`，不猜“未创建”。
6. **spawn 失败与 pre-admission 失败**：`git-spawn-failed` 证明 Git 未接受操作；池 `ignore-unavailable` 在 mutation 之前发生；两者可安全重试。其它已存在目标一律 conflict。
7. **argv/环境白名单**：只用 `spawn/execFile` argv 形态、`shell:false`；`git config` 只读枚举、`worktree add --no-checkout`、`reset --hard --no-recurse-submodules HEAD` 三条字面量进白名单；命令 env 只允许 `GIT_CONFIG_COUNT|KEY_n|VALUE_n` 形状（runner 先清空环境里的 `GIT_*` 再重建）。hooks/fsmonitor 以 `-c core.hooksPath=… -c core.fsmonitor=false` 关闭；`GIT_TERMINAL_PROMPT=0`、`LC_ALL=C`。
8. **不访问网络**：v1 无 fetch/pull/push/ls-remote；`worktree add` 仍可能触发仓库已配置的 filter，故按上一条显式禁用并登记 LFS 降级。
9. **目标目录查重**：target 已存在 = `target-exists`（client 的目录重名后缀只是 UI 建议， host 仍为最终守卫）；containment 用 canonical source；不对未存在 target 伪调 `realpath`。

### 2.4 拓扑、缺失记录与守卫
- `topology()` **宽容缺失行**：目录已删的 worktree 行保留 RAW 归一化记录路径并标记 `missing`，不使整个 topology 抛错。缺失行不得被任何文件系统探测触碰（dirty/attention/running）；身份/重复路径/main/locked 判定照旧。该宽容是 mutation 可用性的前提——硬 `realpath` 曾让单条残留记录锁死该仓库**所有** mutation 为 `path-unavailable`；快照路径有自己的宽容循环（行照常显示为 missing）。
- 主 checkout 不会缺失（其缺失即仓库不可达 → not-found）。
- worktree 列表优先 `git worktree list --porcelain -z`（NUL 定界，路径无歧义）；`-z` 于 Git 2.47 才引入，旧 Git 以 usage error（exit 129）拒绝未知开关；host 检测 129 后回退到换行定界的 `--porcelain`（记录语法一致：空行分隔记录）。
- 提交前复查对 missing 行免 dirty/submodule 探针；注册重放与提交前复查同样不新增 status 探针（受测窗口：锁内 preflight 后消失、最终 topology 读时消失、注册重放目标消失）。
- host 包缺失/未生效必须显式错误（§6.3），不把“没有执行面”伪装成空仓库。
- **删除守卫的公共前置**：目标必须仍是权威 topology 中的 linked worktree、身份（repoId/worktreeId/branch/head）与请求一致、不是 main、不是 locked；路径不可解析时按 missing 记录清理（§5.5）；路径本身是已注册 workspace 时拒绝 `workspace-registered` （先解注册，行才会变成 checkout 行）。

### 2.5 会话运行事实（effective cwd）
- `runningSessionIds` = 全部运行中会话（展示事实）；`blockingRunningSessionIds` = 其中 **非 INERT** 者（§5.2）。只读旧字段的客户端保持保守（任一运行中即阻塞）。
- 运行位置读会话的 **effective 目录**：`sessionProjections.stateOf(session,'workingDirectory')` 非空即优先，否则回退不可变的 `session.header.cwd`（`pickEffectiveCwd`）；两者都非法（相对路径 / 空串）时进入 `cwdDrift` 诊断并在删除腿上 fail-closed。会话 `cd` 进某棵 checkout 后，该树的删除仍被 running 守卫拒绝。
- 归档集合读取是**响亮失败**：getter 缺失/非数组 = `state-source-unavailable`，元素漂移 = `state-source-invalid`；绝不当作空集合、绝不 `String()` 强转。agent 行的 `origin`/ `status`/`cwd` 三列逐行诊断（未知 status 按 running、不可解析 cwd 保持阻塞）。
- **删除不触碰会话**：不再有“先归档再删”的强制前置；归档在本域只作为 running 的 INERT 判据（§5.2），由归档侧（design 24/05）独立负责。

## 3. 行模型：派生 checkout 行
### 3.1 座位与协调器
座位仍是 **`sidebar.workspace.git`**（per-workspace 上下文座位）：sidebar root 对每来源渲染两次——`workspaceId === ''` 的源级警示条与每个 workspace 组头部行内的 occupant。 **主 checkout 行**是 Git 表面（创建入口、分支动作、健康）；**派生 checkout 行**的 occupant 由同一协调器的 checkout 上下文渲染（新建会话/删除/复制路径），但**不注册自定义 slot**。独立面板座位 `sidebar.git` 不存在（面板功能属远期二次开发）。源级警示条只承载 recovery/actionError；snapshot 安装类错误进 connections 插件的 chamber 块（§6.3）， not-loaded 源退化为普通无 worktree 视图。

sidebar 包声明座位（kind single / scope root / `{wide}` owner）与 `hookContext { sourceId, workspaceId }` + slot 级 `inject.hooks.workspaceGitContext` （工厂必须在 children 表的 slot inject 声明，不能进插件 entry inject）。sidebar 不依赖 Git 类型；Git 插件用 slot inject 占位。窄栏 occupant 返回 `null`，但 slot 不卸载。

插件模块内有一个页面级 singleton coordinator：

- 订阅 neutral `chamberBridge` 获得 `local | dsh-<id> | gateway-<id>`（`ssh-<id>` 为 v2 迁移前 legacy）和 connected 事实；
- 每来源一个 in-flight promise，30s tick **轮转波**（每拍最多刷新 2 个 connected 来源， `pollCursor` 轮转）：单来源仍按 30s 节拍，N>2 时单源有效周期 **≤30s·ceil(N/2)**——页面 6 槽同源池的波控（design 26 §D7），不是每源独立并发；新连接/动作后的即时刷新不受波控；可见性恢复边一拍最多取 4 个来源（当前 active 优先）；
- **分支候选是动作触发的有界只读 unary**：打开创建对话框（含重开）、点重试、`previewCreate` 返回 `branch-not-found`/`branch-checked-out` 时自动重读；Existing 页签激活时，若该仓已 settled 的列表距上次读超过 15s 再读一次（判定只在 effect 依赖变化时发生——打开/切换页签/查询 settle/来源变化——不设 timer，普通重渲染不判定；旧宿主 `unsupported` 后同一对话框不再重探 404）。来源 workspace 在对话框打开时由预填决定（对话框没有独立 repo 选择器）。该读不进 30s 轮询波、不进 busy/recovery 账本，也不进 coordinator 的 facts store（对话框局部状态；多壳各自打开对话框各自读一次，无跨壳去重）。
- 断连立即清该来源事实；迟到响应用 sequence 拒绝；
- `repos` 与 path/repo 级 `errors` 并存，一个失败不抹掉其它完整实体；
- N-ctx 所有 occupant 读同一 facts/action/recovery store，不重复轮询，切换 shell 不丢 busy 或部分失败状态；
- RPC 超时 60s：高于反代 upstream idle timeout（45s）与 host git mutation 预算（30s）；排队 ≤10s、派发 60s（总窗 ≤70s）。预算未派发映射为本地化 `not-dispatched` 确定性拒绝，保留上次快照并有界短退避（3s→6s→12s，最多 3 次），之后由 30s 波控接管。Typert 业务错误为确定性判定（不重试），只有传输/超时/无效响应进「不确定」分支（§6.2）。
- **动作前置刷新的新鲜度判据**（`refreshedSince`）：删除/新建会话在动作前强制刷新，且以「这次刷新的 `updatedAt` ≥ 动作开始时刻」判新鲜；预算拒绝会让刷新返回上一状态而非抛错，只看“有没有抛错”会让动作拿旧事实执行。
- **layout 发布**：coordinator 把每个 repo 投影成 `RepoGitLayout` `{repoKey, mainWorkspaceId, unregistered: UnregisteredWorktreeInfo[]}`（`shared/layout.ts`，纯函数）。`UnregisteredWorktreeInfo` 带 `path`、`locked`、`worktreeId`；比较去重必须覆盖 `path/locked`，否则第二次发布会被丢。layout 是客户端唯一行来源，Git 事实不进 App 的 session aggregate。

### 3.2 派生 checkout 行：身份、放置与呈现
- **行身份**：id = `__checkout__:<canonicalPath>`；title = branch ?? 目录名；字段 `kind:'checkout' | path | repoKey | familyMainId`；**没有** `synthetic`/`ungrouped`/ `createdAt`/`reusableBlankSessionId`。repoKey 是 host 铸造的 repo opaque id， familyMainId 是主 checkout 的 workspace id。
- **生成条件**：该 repo 的主 checkout 是**已注册 workspace 行**（`mainWorkspaceId !== null`）才生成派生行；主 checkout 未注册 ⇒ 无行、无新建会话入口（I9）。registered 的 checkout 路径**不生成**派生行（`path ∈ snapshot.workspaces` ⇒ 以 workspace 行存在；否则同 path 双行、会话重复）。`synthetic` cwd 组不能当族主。
- **放置（I4）**：effective = `workingDirectory ?? cwd`；按**路径段边界**最长前缀落在某 checkout 之下才放置，否则保持 host membership（留在源行/未分组）。仅移动 host 列在**源主 workspace 的 `sessionIds`** 里的会话；sed 子代理行（`origin === 'subagent'`）不放置；跨 workspace 的 session 不改归属。放置**不改 `sessionIds`**、不重排成员；派生行会话保持源成员的宿主序，只是子序列。
- **0..N 会话**：一个 checkout 允许 0..N 会话；行内新建直接建、无默认提示；行内计数被动。
- **触发链**：renderer/App 订阅 `subscribeWorkspaceGitFlags`（或 `getWorkspaceGitFlagsVersion` 作为 memo key），version 变化 → 重跑 derive → 投影签名变化 → 重发；version 也进发布闸。没有这条链，外部（forge/agent）创建不会更新。
- **签名**：生产者 `instanceSnapshotSignature` 包含 `workingDirectory`；App `serversProjectionSignature` 编码派生行（kind/repoKey/title/sessions）。dirty/locked 由 occupant 自读，不进聚合签名（避免每轮 dirty 变化重发整份投影）。
- **flag 查找**：派生行不在 flags store（`retainSourceWorkspaceFlags` 会剪掉非 workspace key），sidebar 的 flag 查找回落到派生行自带的 `repoKey/familyMainId/isMain`； `derivedCheckoutFlag` 是唯一查找口，不发布合成 flag。
- **标题与健康**：分支名优先，detached/unborn 用目录名；健康只到门控/诊断——`status` 非 ready 的行显示 missing/invalid/unhealthy/status-unknown 徽标并进 title/aria； `headState/attention/upstream/ahead/behind` 不进行内（保留给删除门控、创建对话框的 unborn 过滤与未来管理页）。facts 未到时显示骨架/源行回落，不能声称 ready。
- **动作**：宽栏 hover 揭示（与主行同一 `data-git-action` 钩子、键盘焦点同一 `.rowActionsVisible` 路径）；派生行动作 = 新建会话、复制路径、删除；**没有 kebab / rename**，但**有独立折叠钮**（与旧 worktree 行同形：branch 字形 ↔ chevron，`viewPrefs.folded` 按行自己的 id）；主行折叠仍隐藏整族。**行尾静息态只有中性信息**（用户裁决 B+C，对齐上游 dsh 的会话行形态）：中性分支字形 + 计数徽标，**不含状态词**；计数徽标仍是行尾（保每行共享右列），**不显示「无改动」占位**。状态词（`有改动/已锁定/状态未知`）是**揭示簇内成员** ——渲染在 occupant 容器（`data-git-occupant`）**内部**、三个动作**之前**（簇的 2px gap 就是全部间距），`data-git-checkout-status` 只留作 DOM/测试钩子：容器静息 `display:none`， hover / 键盘焦点（`.rowActionsVisible`）揭示时 `inline-flex`，所以状态词静息不可见、随 `+`/复制/删除一起换入，揭示前后动作簇位置不变（design 06 §7）。删除阻断理由（dirty/locked）仍由这条揭示面（状态词 + 删除钮 title）与删除对话框的 dirty 确认承载。 **取舍**：①静息文本胶囊（否决：静息常驻噪声，用户裁决 hover-only）；②状态词与动作簇分两处 state-slot 换出（否决：同一行两套揭示路径，且静态计数徽标仍是行尾、机制重复）；③静息只留一个无文本色点/图标（否决：又引入一个需 hover 才解释的符号；上游静息形态本身就是中性分支字形）。会话行**不画** checkout 分支 glyph。命中盒=视觉盒（20px 动作钮的 24px 偏差与主行同一既有取舍）。occupant 容器 rest 态零布局占用（`data-git-occupant`，只住揭示簇成员：状态词 + 三个动作；**不得**再塞入静息可见元素——那会破坏零占用），与主行同一揭示规则；对话框是 body portal。
- **可访问性**：动作有键盘等价入口（Tab 可达的揭示），拖动有非拖动替代（菜单移动）， aria 名称/描述覆盖分支、路径、健康与动作。

### 3.3 家族、折叠、树、拖动与会话拖动
- **折叠**：派生行带 `familyMainId`；`hiddenByMainWorkspaceFold` 读派生行字段，主行折叠隐藏同族 checkout，展开恢复；主行消失时谓词要求主行仍在列表，避免旧 folded 偏好把派生行锁死；隐藏行不携带破坏性在途状态。派生行**有自己的 folded 状态**（行头折叠钮，与旧 worktree 行同形）：只隐藏本行会话，不影响同族其它行。
- **树（家族优先）**：`workspaceTreeParents` 接受 `kind:'checkout'`，派生行的显示父级取它 main 的父级；池在 `<repo>/.agents/worktrees` 时纯前缀本可落在 repo 之内，但派生行不是注册 workspace，树仍以 familyMain 归位。无 git 家族信息时退化为纯前缀；树只改缩进、不解顺序（同级顺序仍由 wire 序与家族约束决定）。
- **行拖动 = checkoutOrder 子序（本地持久化）**：`view-prefs` 的独立字段 `checkoutOrder: Record<string,string[]>`，key = `__checkout__:<sourceId>/<canonicalMainPath>`，value = checkout 的 canonical path 数组（与 `ungroupedOrder` 同型）。checkout 行只在**自己族内**移动；跨族/跨库 blocked；主行拖拽仍由现有 family 机制移动整族；`resolveWorkspaceDrop`/`commitWorkspaceDrag` **零改动**。未知名跳过、新行按派生序追加；view-prefs 只在本机 localStorage 持久化，不写宿主、不跨实例同步；回滚/清理见 §7.4。**不发布 flags 合成行、不把派生行 id 写进 workspace order**。
- **会话拖动**：`accountKey = source workspace id`；锚点用 **source full order**（放置前的 `snapshot.workspaces[].sessionIds`，作为源行非渲染字段 `allSessionIds` 随 derive 输出、参与签名）；before=target、after=full order 中 target 的下一个、无=append； `insertSessionBefore(sourceId, dragged, anchor)`；跨 checkout 行 no-op；pinned/blank/ archived 门不变。
- **pin/归档/计数**：placed session 随行进入 checkout 行分区；源行只显示未放置；宿主集合不变；归档集/可见性仍按源 workspace。
- **flat/窄栏**：flat 不渲染 checkout 行（会话在 flat 列表）；窄栏无 Git 动作。
- **0 会话行（空态）**：行照常渲染（行头 / 折叠钮 / 动作簇 / 计数徽标显示 0），会话区为空且 **不出现任何占位文案**——与 0 会话的宿主 workspace 行同形；整源空态仍只由源级 `empty` 键承担（0..N 会话是行的合法形态，不是来源为空）。**取舍**：①保留「该工作树暂无会话」提示（否决：计数徽标已表达「0 合法」，静态占位只增噪）；②整行不渲染（否决：该行同时是折叠钮、家族锚点、Git 动作面与 0 会话创建会话的入口，Git 事实就挂在它上面）；③改用源级空态框（否决：它是某来源下的一行，不是空来源）。
- **行激活**：有独立折叠钮；无 kebab/rename；动作 hover 揭示；与主行共用同一套家族树缩进变量（`--chamber-tree-depth`）。

### 3.4 池内边界、去重与旧池
- **只报池内**：见 §2.1。旧 `$DSH_HOME/worktrees` 残留不在 layout，不生成行，不显示 missing；它们是发布前必须清空的数据（§7.4）。
- **池被注册成 workspace**：以 workspace 行存在（不生成派生行、不双显）；先经侧栏的 workspace 删除解注册，下一轮 facts 后变为 checkout 行。反过来，checkout 行上的删除是 path-based Git removal，**不会**删注册；host 对“路径仍是 workspace”的删除 fail-closed `workspace-registered`。
- **没有 registered remove**：不存在 workspace.delete/归档前置的 Git 删除路径；旧 profile 里的 registered worktree 由 §7.4 的升级步骤处理，不由本插件提供第二套入口。
- **missing 行**：目录被外部删掉但 admin 记录仍在时，派生行显示 missing 并可走残留记录清理（§5.5）；它不会被当作健康行提供新建会话。
- **遗留 registered worktree（旧池）**：升级前未清空的旧池行仍是 workspace 行，不生成派生行；路径消失时按既有 orphaned 诊断与“仅注销注册”流程处理（design 06 §11），Git occupant 读取同一套 facts。本设计的 path-based remove 不接管已注册路径（先解注册，§3.4）。

## 4. 创建与进入会话
### 4.1 创建对话框与来源分支候选
- **New Branch / Existing Branch 双 tab**（active-pill）；分支名打开时自动双词 slug （10×10 组合，查重避开已有分支与工作树目录名，8 次重 roll）；目录随分支名同步直至编辑（“重置为分支名”）；来源分支下拉（本地分支，localStorage 按仓库记忆上次选择）；已有分支为可选框（host `gitWorktree/branches` 按需读，`show-ref --heads` 白名单；§2）。
- **单击直接创建**：无预览屏——客户端内部串行 previewCreate→createFromPreview（host 校验链完整保留），错误直接显示。创建**永不提交会话**；成功后 refresh，行由 layout 派生出现。
- **候选来源**：首选是本次对话框内最近一次 `gitWorktree/branches` 的 fresh 列表（`shared/branch-query.ts` 的 `branchChoices()` 直接采用，取代 `snapshot.branches`）；快照回退路径仍用 `sourceBranchChoices()`（`shared/git-facts.ts`）消费 `snapshot.branches` 与已检出分支。主 checkout 当前分支可选；detached 时默认 base 是 detached commit；unborn 行从回退集跳过；不得把主 checkout 分支过滤掉（单分支仓库会候选必空）。`snapshot.branches` 保留为旧宿主与读取失败的回退（§6.3）。
- **读取触发**：创建对话框打开（含重开）时、点重试、`previewCreate` 返回 `branch-not-found`/`branch-checked-out` 时自动重读；Existing 页签激活且已 settled 的列表距上次读超过 15s 再读一次（无 timer，只在 effect 依赖变化时判定；旧宿主 404 后同一对话框不再重探，重开时再读一次）。关闭/卸载 abort 在飞读取。来源 workspace 由打开时的预填决定（无 repo 选择器）。读是一次动作型 unary，不进 30s 轮询波（§3.1）。
- **三态与禁用**：loading/ready/error 三态；loading 时分支选择器禁用，不退化为手输。fresh 列表取代 `snapshot.branches`；Existing 页签把 `checkedOutBranches` 中的分支禁用并标注；New Branch 的来源分支下拉不受此限制——主 checkout 分支必须保持可选。快照回退列表（旧宿主/读取失败）没有 checked-out 事实，不 disable——这是旧宿主的能力上限，host 的 `previewCreate` 仍以 `branch-checked-out` 拒绝。
- **失败与旧宿主**：读取失败显示本地化错误条 + 重试；确定性拒绝（缺失域、source-shape/workspace 拒绝）不给重试。有快照回退时 Existing 页签选择器保持可用（回退列表 + 错误条），无回退候选时退化为禁用选择器（阻断的是该页签的 fresh 分支选择；New 页签仍可创建，创建仍由 host 的 `previewCreate`/`create` 校验）。旧宿主（已挂载域上的未知方法 → 客户端 `git-host-not-loaded`，且本来源已有成功 snapshot）回退到 `snapshot.branches`，不弹重启指引、不显示错误条；无 snapshot 的 404 仍是真域缺失文案（§6.3）。
- **目录重名自动加数字后缀**（`resolveCandidateDirectory`：name-2/name-3…）；host `target-exists` 仍是最终守卫——已存在目录不得静默覆盖。
- **已知边界**：unborn 仓库分支候选必空（`show-ref` 空输出是真空仓库事实，不是读取失败）；读取成功但候选为空（unborn 仓 / 旧宿主空快照）时 Existing 页签保留既有的手输回退（host 仍以 `branch-not-found` 拒绝，与改动前一致）；detached/unborn 主 checkout 记过分支后 MenuSelect 无“回到默认”；快照回退路径的既有边界是 host `show-ref` 失败静默返回 `[]`，选择器可能只剩已 checkout 分支——按需读的失败走显式错误 + 重试，不经过该静默路径；非 git 工作区不渲染入口是设计行为。

### 4.2 在 checkout 新建会话（source + enter）
`createSessionHere`（行内“+”）：fresh facts → `canTargetSession` 健康门 → 主 checkout 的 workspace id → `session.create(sourceWorkspaceId, {sessionId, origin:'user', workingDirectory:path})` → `requestOpenSession` → `gitWorktree/enter`。

- 顺序是**先 open 后 enter**：打开是单向 UI 意图，先让 agent 开始加载，再把 workingDirectory 移进 checkout。enter 失败时会话已提交：不发终止/回滚（无 session delete wire），会话留在源根；错误如实上报，行不会消失。
- enter 校验：`agent-not-ready`（retryable，client 在 open 后重试一次）、`not-a-repo`、 `worktree-not-listed`（含 missing）、`outside-writable-root`（target 在 `header.cwd` 之下）。 **不查 commonDir**（池注册边界冲突，Git facts 已足够），不检查 idle/blank，无 changed/session-busy/invalid-input。
- 新会话的 echo 带可选 `workingDirectory`（放置意图），App merge 后 derive 立即放置，不先落源行再跳。 **宿主事实**：`working-directory` 投影的 `init` 是 `header.cwd`（该 client-visible unit 默认进 session summary），所以会话行**从创建那一刻起**就带 `workingDirectory = 源主 workspace 路径`； `gitWorkTree/enter` 只让这个值**偏离**创建种子。因此意图的退休点是「权威 `workingDirectory` **已偏离创建种子**」——既不是成员位（`enter` 是第二次 unary），也不是「字段存在」（创建种子会让意图在第一条 push 就被提前退休，正是本条要避免的「先落源行再跳」缺陷）。意图存活期间 `withSessionEcho` 只覆盖**缺失**或**仍等于创建种子**的 `workingDirectory`（其它宿主值永远优先，按 canonical 路径比较）。`enter` 成功侧不直接发 settle（权威事实即收敛点）：由 create/enter 触发的官方 session-list 刷新把壳 summary 里陈旧的种子值换掉（design 05 §2.2.1——projection-only 的目录变化不会重发 `api-session/added`，故必须主动重读）；失败侧发 `reportSessionPlacementFailed` 立刻作废意图（会话已提交在源根，行立即跟随权威 cwd）；回声 TTL 只是丢事实时的泄漏兜底。 **取舍**：①按成员位退休（否决：即本条的「先落源行再跳」缺陷，动效从根组开始）；②按「字段存在」退休（否决：宿主创建即投影源根种子，等于第一条 push 就退休，同一缺陷变形成「一条 push 后跳」）； ③按固定时间窗持有（否决：`enter` 时长无客户端上界，辩护成本是把一次晚跳变成常驻错误位置；仓内 workspace 放置意图已有「失败事实 + TTL 兜底」的同一形态）；④`session.create` 直接带 `cwd` 建在 checkout（否决：宿主 `cwd` 创建不挂 workspace 成员位，违反 I1「会话根 = 源主 checkout」且行会落未分组）。
- **已知边界**：放置意图的退休依赖「观察到宿主值偏离创建 seed」；若用户在创建后、客户端首次观察到偏离之前又把会话目录切回源根（反向 cd），意图会把行暂留 checkout，直到下一次权威重读（create/enter 收敛臂或重连）或 10min TTL 生效——窗口极小，接受并登记。
- 同一 checkout 可被多个会话进入；不引入宿主互斥，不做“一树一活跃会话”提示；计数被动。

### 4.3 forge composer、agent 工具与 restore（P5b）
- forge 的 composer “New worktree”/创建卡/hold/取消/重试/不带工作树继续、右栏 tab、toast、行 hover 都保留；它创建的是同一个池里的 checkout，会话放置/行表现由本设计统一。
- 官方 agent 工具 `create_worktree` 由 forge bundle 的 `worktree` + `tool-worktree` 行提供，产物自动成行/放置；linked 源不可用；工具树可被侧栏删除（running 守卫读 effective cwd）。
- **restore 仅 forge record**：forge 的 missing 树可 restore/continue；seed 自建的树没有 restore（不对称，接受并写入发布说明）。seed 删除 forge 树后 forge 显示 missing/restore，我们的派生行不显示幽灵；反向删除后行消失。
- 同一池的三条断言：forge 创建 → 侧栏在单源有效周期（≤30s·ceil(N/2)，§3.1）内成行且会话 placed；seed 创建 → forge tab 可见； seed 删除 forge 树 → forge missing/restore 且反向行消失。

## 5. 删除事务（path-based，不隐式归档）
```text
fresh facts -> 客户端守卫 -> host remove（mutex 内复验）-> refresh
```
### 5.1 状态机与守卫
- 删除只有 **`removeUnregisteredWorktree(sourceId, {repoId, worktreeId, path, branch, head}, options)`**：先 fresh refresh（预算拒绝的旧状态不算 fresh），再在 host 内按路径发现仓库、校验身份、跑守卫、path-based remove；返回 `next:'none'`，**没有 workspace.delete 分支**。
- 客户端守卫（`checkoutRemoveBlockReason`）：`main`、`current`（仅当当前会话正在该树运行）、 `running`（非 INERT）、`locked`、`unhealthy`、`dirty`（需显式丢弃）、`status-unknown`； `unregistered` 不是 block——它是 path-based 删除的**前提**。没有 `runtime-unknown` 腿： checkout 行没有 workspace membership，不存在“运行时通道缺失掩盖 running”的问题；host 在 mutation mutex 内重读 running 事实并 fail-closed。
- **idle 当前会话允许删除**：当前会话若 idle，删除后下一次消息由宿主 `workingDirectory.ensure()` 回落到源项目；只有运行中的当前会话阻塞。blank/从未提交的当前会话同样按 idle 处理（没有内容可保护）。
- 删除**默认不**停止、不取消、不归档、不删除任何会话；宿主 `remove` 本身不碰归档。“同时归档这些会话（含子会话）”是 §5.4 的可选、默认关闭的**客户端**授权，在 remove 之前执行官方两段式归档，不是删除的前置。归档只通过 running 的 INERT 判据影响阻塞（§5.2），归档动作归侧栏/归档管理器。
- 身份/锁/主 checkout/注册前置全保留；`remove` 对已注册路径 fail-closed `workspace-registered`（§3.4），不做 registration-only 删除。
- 响应丢失后以权威 topology 已无该 worktree 为成功对账条件；删除后不反向重建 Git 树，也不隐藏会话。

### 5.2 running 判据（INERT）与 current
- **判据（宿主侧 `assertNoRunningAtPath`；所有 mutation 腿共用）**：运行中的会话 **INERT** （不阻断）当且仅当 `workspaceRegistry.archivedSessionIds` 含其 id，**或**它经 **subagent-origin 边**链到的祖先在该集合中。lineage 只走 subagent-origin 边（与 design 24 的 purge tree 同构）；缺 `origin` 的边是 fork lineage，**fork 边终止链条**（照旧阻塞）；先判归档、后判成环；不含已归档成员的环永不 INERT；无法解析的链条绝不 INERT（fail closed）。
- **集合读取的响亮失败**：读不到 = `state-source-unavailable`，元素漂移 = `state-source-invalid`；snapshot 以响亮 `sourceError` 返回、mutation 腿直接抛错，绝不当作空集合。该判据不缓存、不降级，每次 `readSource` 都重读。
- **默认行为**：未归档的运行中会话报 `running-agent`；其余守卫（main/locked/身份/expected/dirty/submodule/嵌套 workspace）照旧。
- **current**：读当前会话的 effective cwd；运行中的当前会话同时被客户端 `current` 与 host running 守卫拒绝；idle 当前会话只受客户端“这是当前行”的确认提示影响（删除后 ensure 回源）。

### 5.3 显式授权：dirty / 子模块 / 删分支
- **dirty**：默认拒绝（`worktree-dirty`，retryable 的对话框路径）；用户在确认框勾选后带 `discardChanges: true`，host 用 `git worktree remove --force`。`--force` 只丢弃工作区文件（已修改/未跟踪），不触碰分支/提交/HEAD。argv 白名单为精确文法 `worktree remove --force -- <abs-path>`，`--force` 不能以其它形态混入；`discardChanges` 参与输入指纹，恢复重放必须携带原值。
- **子模块**：git 自身拒绝不带 `--force` 的删除（`validate_no_submodules`，变更前 die）； host 在最终变更前镜像该守卫：未授权 → 确定性 `worktree-submodules`（`retryable:false`），不发起任何 Git 变更；确认后同一 `discardChanges: true` → `--force`。守卫 best-effort： `.git` 指针不可读时读作“无子模块”；git 自身仍拒绝时在失败后复查 topology，同一目标仍在、目录仍在、仍干净 ⇒ 改判确定性；stderr 明确为子模块拒绝时升级为同一 typed 码。 `domainResult` 显式序列化 `retryable:false` 作为“已证明未变更”的线上信号；客户端据此把未决 git-remove 恢复判为“未删除”并清除——仅限 host 可证明的变更前拒绝，歧义失败与 definitive conflict 行为不变。
- **可选删除本地分支**：显式勾选才 `git branch -D <branch>`（白名单），尽力一次，失败返回 `branchDeleteFailed` 不阻断已删工作树；target-absent 重放路径同样执行。
- **目录残留**：force 下 git 先递归删工作目录，即使失败也继续删 admin entry——权限等失败时可能残留空目录；重试按“topology 已无该 worktree”收敛成功，与“topology 为成功对账条件”一致，不做目录存在性反向校验。

### 5.4 删除对话框与文案
- 对话框是应用内 `CheckoutRemoveDialog`（`Modal` + `Button` 原语；三个选择需要同框，故不是单一 `RiskConfirmation`）。身份行给路径与分支；**会话闭包标题列表** （≤5 + “还有 N 条”，unary snapshot 的标题；未命名会话用占位）在勾选归档后展示。
- **归档 roots = 物理在该 checkout 内的会话**（`workingDirectory ?? cwd` 按路径段边界），再加 `parentSessionId` 的 fork 闭包；**不依赖轮询的 workspace membership**（宿主 canonical-cwd 索引退化或 30s 轮询窗口内新建的会话也能被归档）。归档集用 mounted aggregate 的权威集（`archiveSetKnown === true`）跳过已归档；unary 的未知集不冒充。
- **blank（未首发）会话不计数也不归档**：`session.list` 的 `blank` 事实（首回合 `turn/start` 前为真）标出的行是建而未用的“新建会话”默认占位——checkout 行「+」的 `createSessionHere` 建出、`workingDirectory = checkout path` 且 echo `blank:true` 的行即此形态（宿主建而未用的空行同形）：无内容、无 durable 标题，弹窗里只会落到「未命名会话」占位（用户报告的默认会话即此形态）。它既不是 root 也不进 closure 输出：不计入归档计数/标题列表，也不发起归档调用；fork 闭包遍历仍可穿过它到达有内容的 descendant。冷行无投影时 `blank` 不可知按 false 处理（fail-open：宁可多算，不误删有内容的历史行）； wire 重命名不会清 `blank`，所以被外部改名的空会话仍按空会话排除（语义不变）。
- **归档勾选默认关闭**：这是客户端 consumer 的一步，不是宿主 remove 的一部分，也不改变“删除默认不归档”的语义。勾选后**确认时重新拉取 unary 并重算**（对话框打开时的预览只用于计数/标题；可能已过期）；先 plain `archiveSession`，`workspace/session-active` 拒绝时由用户确认（停止对话框逐类列出 turn/subagent/job/schedule）再带 `stopActivity` 重发；归档失败/确认取消则中止删除。归档与删除非原子（已归档的保持归档）。另有“同时删除本地分支”勾选（§5.3）。
- **dirty**：删除图标不禁用（仅 dirty），点击进对话框显示警示；对话框内勾选后以 `discardChanges: true` 跑同一删除路径。**关闭/遮罩/Escape 在删除进行中被忽略**（footer Cancel 也禁用），避免“看起来取消、实际继续删”；取消只在未开始时复位授权。
- **含子模块**：首次删除被 host 确定性拒绝 `worktree-submodules` 后，对话框就地显示警示并 **重新武装**“丢弃子模块检出”的勾选；勾选后同一授权以 `discardChanges: true` 重试。 dirty 在快照之后才发生时同理（`worktree-dirty` 重新武装 dirty 勾选）。
- **运行中会话**：`blocked === 'running'` 时删除图标不禁用（与 dirty 同型），对话框给出归档勾选；不勾选时由宿主 `running-agent` 拒绝（客户端不预判），勾选后走上游两段式归档，归档即 INERT，删除可通过。删除本身不询问、不停、不归档、不删除会话；标题/aria 用 `runningRemoveTitle` 说明“有未归档会话在运行；可勾选归档后移除，或先结束这些会话”。旧宿主（无 `blockingRunningSessionIds`）用中性 legacy 文案，不得声称归档状态。
- **硬阻断**：main/locked/unhealthy/status-unknown 保留；已注册路径走 workspace 删除（先解注册），不在本对话框。
- **会话事实拉取失败**：对话框打开时拉取 unary；失败时归档勾选禁用、就地显示错误并提供“重试”，但**不阻断**删除本身（path-based remove 不依赖会话事实；旧 registered 流程的硬阻断随该流程一起退役）。
- **未注册/缺失行删除**：同一应用内对话框（行内按钮只武装确认，确认后才发）。缺失行不显示分支/归档勾选，文案明示这是“残留记录清理”（等效 `git worktree prune`，不涉及任何文件或分支）；新建会话对 missing 行禁用。

### 5.5 missing 记录清理
- 目录被手工删除（`rm -rf` 而非 `git worktree remove`/`prune`）后，admin 记录存于主 checkout 的 `.git/worktrees/<name>/`（`git worktree list --porcelain` 继续列出并标 `prunable gitdir file points to non-existent location`）。未注册删除预检对 `path-unavailable` 路由到 `removeMissingUnregistered`：目录不存在则从注册 workspace 反查所属仓库（`locateMissingRecord`：逐一 discover + `worktree list`，按 RAW 路径与 expected repoId 匹配；孤儿 workspace 跳过不阻塞），再在 common-dir mutex 内复验（身份/locked/main/ghost-workspace raw 相等守卫全保留；无目录则 dirty/submodule/running 探测天然免检）后执行普通 `git worktree remove -- <记录路径>`（实测 git 2.50 对缺失目录 exit 0，仅清 admin 记录、不用 `--force`）。更老 git 拒绝时走确定性 `retryable:false` 重分类，不产生重试环。
- 幂等/重放沿用既有对账链（`verifyRemovedReplay`/`reconcileBoundRemove` 同路径收敛）；目录在预检与提交之间**重现**时确定性拒绝 `worktree-invalid`（证明未变更，绝不清除已恢复的树）；“目录重现”判定在锁内 topology 读时刻。未注册删除在锁内遇 topology 解析为 missing 的行即按 `path-unavailable` 当次降级残留记录清理（不留到同 id 下次重试才收敛）。
- ghost workspace（raw 路径等于缺失路径）拥有该记录，一律拒绝未注册清理（registration-first）；错误码全部落在客户端既有确定性拒绝集合内（`expected-mismatch`/`worktree-locked`/`main-worktree`/`workspace-registered`/ `worktree-invalid`/`worktree-not-found`），不产生新的 recovery 死锁类别。

## 6. 失败、并发与安全不变量
### 6.1 不变量
- 渲染层不提供任意路径或 argv 给 mutation；opaque id/token 也不是信任来源，host 每次仍从 registry + Git 重新解析。
- 一 repo 一 mutation 链，键是 absolute common-dir；轮询永不重叠。
- Git 子进程 timeout/输出超限时先 kill，但 common-dir mutex 须等 child `close` 后才释放；仓库 filter 的更深层后代无法跨平台可靠 group-kill，属 §2.3 已披露的受信配置剩余边界。
- 一个工作区/repo 失败不撤掉其它成功实体；Git 二进制缺失是来源级错误，非 Git 工作区不被误报为整源失败。
- 远程与本地运行同一 host 包，同一套路径/参数/运行会话守卫生效，不存在两套 Desktop adapter 差异。
- 绝不记录命令输出中的凭据/URL；v1 不提供网络 Git 动词，filter 的网络访问按 §2.3 受信边界处理。
- **会话事实不被 Git 域改写**：checkout 不是 workspace；删除/创建都不改 `sessionIds`、不归档、不移动会话归属。

### 6.2 恢复与未决（recovery）
- 浏览器 recovery 只在当前页面/进程内持有；host 重启或外部 identity 改变可令旧 operation 永久 definitive conflict；UI 保留未决并阻止同目标新动作，不提供把“放弃”伪装成成功的按钮，用户需 reload 后依据 fresh topology 手工核对。
- `git-create`：同 operationId + preview 重放缓存在，host 重新核验身份；创建无自动回滚。
- `git-remove`：同 operationId 重放；host 显式 `retryable:false` 的拒绝 = 已证明变更前未动，客户端清除恢复并呈现可关闭错误；definitive conflict 仍保留未决。
- **既有残余**：`path-unavailable` 的客户端确定性覆盖只阻止**新铸**恢复项；已存在的 git-remove 恢复在重放得到该码时仍保留（目录消失可能意味着上次删除已提交）。 `git-timeout`/`git-spawn-failed`/`state-source-*` 同样保留；终态 receipt 重放的失败也仍按原 retryable 语义。证明失败本身（目标消失、行 missing、身份漂移、无法定位仓库、超过 `PROOF_DEADLINE_MS`）保持 retryable——证明不了“未删除”就不得清除。以上出口均为 reload 后按 fresh topology 核对；登记在 STATUS。
- **enter 失败**：会话已提交后没有 session rollback；会话留在源根，用户可继续或重新“新建会话”。这是无 session delete wire 的既定取舍，不是可恢复的取消。

### 6.3 host 包缺失与一键重启
- 404 = 确定性 `git-host-not-loaded`（git RPC 404，host 包缺失或未生效）：客户端判定为确定性失败——不建恢复、不重试，按来源指引重启：本地实例在“dsh 运行时”点“重启 dsh”；远程 ssh 在连接设置重新下发 chamber host 包并点“重启生效”；gateway 经 `/chamber/runtime/restart` 后重试。该错误归属 connections 插件的插件管理面，不进侧栏。
- **分支候选的兼容窗口**：`branches` 是新增方法，新客户端 + 旧宿主调用得到 404（已挂载域上的未知方法）；若本来源已有成功 snapshot，按旧宿主回退到 `snapshot.branches`，不显示重启指引，无 snapshot 的 404 仍按上一条判为真域缺失。旧客户端 + 新宿主不受影响；两半可任意顺序上线/回滚，重启 dsh/seed 同步后按需读自然生效。
- **重启入口**：连接卡“重启实例”按来源区分（ssh `restart_service`、gateway `/chamber/runtime/restart`、本地 control-plane `restartLocal()`）；seed 写/补 patch 后的“重启生效”态由 `PluginDialog` 承载。`remoteNeedsSeed` = 宿主图包未 (installed && patched)，或 gitWorktree 行未安装。

### 6.4 已接受的残余
- **旧 subagent 行没有 `origin`**：只能按“非 subagent-origin”处理 ⇒ 该边终止、会话照旧阻塞（fail-closed）。
- **来源面漂移分两类**：agent 行的列漂移逐行诊断（`agent-origin-unknown`/ `agent-status-unknown`/`agent-cwd-unknown`），真正损坏的来源面（归档集非数组/元素非法、 workspace 行畸形）让整次读取以可重试 `state-source-*` 失败；此时没有 mutation 被尝试。
- **外部 Git TOCTOU**：锁检查、目录重现、递归删除失败后的目录残留只能靠紧邻终态验证缩小，不能消除。
- **unary 抛错期间孤儿入口缺席**：一轮 unary 直接抛错时客户端拿不到新快照，新出现的 `path-unavailable` 无从合并出 `orphaned`，直到下一轮成功快照或重启来源。空快照分支由 `effectiveSnapshot` 合并 errors 收口。
- **池外 worktree 不可见**：只报池内是发布前提的反面；用户若在池外手工建树，它不会出现在侧栏（可从主 checkout 的 git 命令或 forge 自身视图查看）。这是“旧池不提示”的必要代价。
- **restore 不对称**：仅 forge record 可 restore，seed 树无 restore（§4.3）。

## 7. 工程接线、P5b 与发布
### 7.1 包与接线
- host 包与 client-graph 包一起进入本地 profile seed、远程 ready-time seed、desktop 打包资源和 loader patch；seed 继续只经既有的受限 `run/write-file` 通道。host 包的 esbuild `dist/index.js`（`@deepseek-ai/*` external）为构建期生成、不提交；clean checkout 由 `pnpm run build:artifacts` 自举。
- loader id 与 package name 在 profile 中是全局身份：单个 exact 既有 row 复用，同 id/异包、同包/异 id 或重复 exact row 都在写包/启动前 fail-loud。
- client 包是首屏静态覆盖行：Vite aliases、`chamber-entry` apply + module factory、 `CHAMBER_COVERED_IDS` 必须锁步。
- 专属验证门：`typecheck:git`、`typecheck:host-git`、`test:git`、`test:host-git`、 `build:renderer`；同时运行 sidebar/renderer-shell/desktop/control-plane 回归。新增 `branches`/`enter` 的 wire 契约由 host-client lockstep 锁步（方法名单/命名空间/真宿主结果↔真客户端解码；旧覆盖不含两者，属新增）。
- 打包前必须重建 host 产物（`build:artifacts` / `build:host-packages`），再拷贝到 desktop `dist/`。

### 7.2 P5b：forge bundle、GitHub 关闭与 node
- **opt-in**：官方 `@deepseek-ai/dsh-experimental-forge-bundle`（OPTIONAL/EXPERIMENTAL）在实例前端 Plugins → More 开启 “Change requests & worktrees”；启用/关闭需重启。chamber 不在默认 profile 里预置该 bundle，也不提供页内开关。启用后其 patch 插入六个包、六个平铺 loader 行：`worktree`、`tool-worktree`、`forge`、`forge-github`、`forge-session`、`forge-panel`（`client-ui-forge`）。当前 pin 起该 bundle 只挂一个 `worktree` 服务（面板与 `create_worktree` 工具共用），原先的 `optional-forge-panel` 组与 `isolate:{worktrees:true}` 已删除，`forge` 与 `forge-panel` 行平铺到顶层。**不能与单独启用 `tool-worktree` 叠加**（同名行重复）。
- **GitHub 关闭（P5b-0）**：chamber 的本地 `--patch` overlay 支持 **id-targeted `disabled`**（bundle 层行，含 group 内行），对 `forge-github` 注入 disabled。语义： **bundle 未启用 ⇒ 跳过 + 诊断（幂等，host 照常启动）**；**bundle 已启用但 id 缺失/绑错包/ patch 不可读/重复 ⇒ fail-closed**（不能让行静默保持启用；pin 升级若改 id，宿主 fail-closed，真实 vendor patch 测试钉住该 id）。`directory` 默认已是 `.agents/worktrees`，不必配；`config` 能力仅作远程/兜底。
- **上游归档清树（当前 pin 的 reclamation，与 design 24 的边界）**：当前 pin 的 `worktree` 服务在 `workspace/session-archived` 时后台清理**它自己 `create()` 且 owned 的** checkout（无未归档会话引用、创建者策略非只读、Git 无 tracked/untracked 改动、无子模块/lock/detached；`git worktree remove` 非 force，分支与提交保留；失败只 warn 并保留分支），开关 `retainOnArchive` 默认 false（Plugins 页可改）。**它只认自己的创建记录**：seed 树、手工树与池外树永不被它清扫，所以 chamber 的池内行、删除确认与保护边界仍由 design 08 拥有；反之，归档任何**由 forge 服务创建**的会话会立刻移除其 checkout（用户可见的「归档」净后果因此变大），design 24 的归档管理器与提示必须按这个事实陈述，不得承诺「归档不动工作树」。
- **node**：由 control-plane 统一保证。优先复用现有 PATH shim（`pnpm-shim.ts`）让默认 `nodeCommand:'node'` 解析到真实 node；若 shim 不在 host PATH，用 **string-only** 的 `resolvePlainNodeExecutable()`（跳过 Electron 分支；null → `node-unavailable`）。 **绝不写 `process.execPath`**（Electron 二进制不是 node）；两实例同一路径；失败 fail-fast
+ 诊断，不设计回退。node 实际创建必须含**打包态 + Finder 启动**。
- **远程**：overlay 只服务本机 spawn；SSH 远程用 bundle 默认 `node` + 部署方 PATH，**不上传本地绝对路径**；远程只做诊断。
- **单服务两入口**：当前 pin 起面板与 `create_worktree` 工具共用一个顶层 `worktree` 服务（无第二个实例）；P0 验收 = 面板与工具各实际建一次，且两次创建都由同一服务记录（session log 的 `plugin:worktree/created` + `worktree` projection）。
- **filters**：forge 与 seed 使用同一两段 + 枚举 + required 语义（§2.3）；LFS/clean-smudge 降级登记，发布说明写明手动 `git lfs pull`。

### 7.3 Swift 腿与 node 来源
- **Swift 原生壳 + sidecar 是唯一出货形态**：node 来自 sidecar 自带（Electron 归档参考用 PATH shim/string-only `resolvePlainNodeExecutable()`，不写 `process.execPath`）；不改 design 25 的宿主结构。
- **P5b 验收**：Swift 打包态（Finder 启动）跑 P0——四项 UI、同池三条、node 实际创建。
- **门禁**：不得删除/弱化既有门禁（`release-workflow-policy.test.mjs`、`gate-surfaces.json`、`package.json`、`compiled-sidecar-smoke.mjs`、`remote-state-acceptance.mjs`、`gui-acceptance/drivers/native.mjs`、`release.yml` 的 Swift 腿、packaging-closure 的 Swift 段）；新增套件按 `gate-surfaces.json` 注册表登记；只加 Swift 腿 P5b 验收。

### 7.4 旧池发布前提与回滚
- **不迁移、不检测、不提示**：旧 `$DSH_HOME/worktrees/<repo>-<hash>/<name>` 池不转成新池、不扫描、不显示 missing/提示。用户必须**在升级前**逐树清理：
1. 对旧池里每个 registered worktree 执行 `workspace.delete`（会话转未分组，**先归档需要保留的会话**——归档是用户选择，不是删除前置）；
2. 再对每棵树 `git worktree remove <path>`（必要时 `--force` 处理 dirty）并 `git worktree prune`；**不是删目录**（删目录只会留下 admin 记录）。旧池清空是升级前的一次性用户操作，发布 checklist 不以之为阻断项；snapshot 只报池内，旧根残留不变成行（§2.1）。升级前验证：升级后旧路径不出现在任何来源的 checkout 行，源仓库 `git worktree list` 无旧根。
- **view-prefs 清理**：回滚/升级脚本清 `__checkout__` 前缀键与 `checkoutOrder`；正常升级无需迁移（旧键若存在，渲染侧跳过未知 path，体积可忽略）。
- **回滚**：P5b 关闭 bundle + 重启；删除不删用户数据；Swift 保留，无 sidecar 回退项。

### 7.5 验收矩阵（V1–V22）
合并/PR 门 = V1/V2/V3/V4/V5/V6/V16 的 dev Swift 子集 + PR CI + build:renderer；其余是发布门（尤其 V8–V15、V17–V22）。未跑项按 release 清单开账，不能用“代码已合”代替。

| ID | 场景 | 判据 | 门 |
|---|---|---|---|
| V1 | 主 checkout 创建/新建/提交 | in-repo 创建后源 git status 干净；workspace-write 下 commit 成功 | Merge |
| V2 | 同一 checkout 多会话 | 行内直接新建两个会话，无默认提示，计数=2 | Merge |
| V3 | running 所在 checkout 删除 | 被拒（当前/其它 running 均命中） | Merge |
| V4 | idle 所在 checkout 删除 | 删除成功；下次消息 ensure 回源 | Merge |
| V5 | dirty checkout 删除 | 先确认 discard，删除成功 | Merge |
| V6 | linked/子目录源 | source-not-main-checkout；submodule 源被拒 | Merge |
| V7 | 空仓库/detached HEAD | 可创建并展示短 commit | Release |
| V8 | forge/tool 创建 | 产物成行、会话按 workingDirectory 放置 | Release |
| V9 | forge New Session 开关/创建卡/hold | 四项 UI 可点，hold 生效 | Release |
| V10 | forge restore/删除互操作 | restore 只恢复 forge record；反向行消失 | Release |
| V11 | 未挂载 connected | facts/行仍出现，交互可用 | Release |
| V12 | 冷会话放置 | 投影到达后落 checkout，不闪源行 | Release |
| V13 | 多来源 local+SSH | 行/事实/操作互不串源 | Release |
| V14 | Windows/macOS 路径 | 大小写/分隔符/规范化不丢行与序 | Release |
| V15 | 源 workspace 删除 | 行消失，不出现幽灵 | Release |
| V16 | 拖动/折叠/树/pin | 族内拖动、刷新保持；fold/tree/pin 一致 | Merge |
| V17 | 窄栏/flat/空态/status-unknown | 无动作/不渲染行/空态/保守健康 | Release |
| V18 | node 实际创建 | Swift 打包态 + Finder 各建一次（node 来自 sidecar） | Release |
| V19 | LFS/clean-smudge/required | 指针降级可解释，手动 git lfs pull 后可用 | Release |
| V20 | 主 checkout 未注册/池注册 | 无行/无入口；池注册以 workspace 行存在 | Release |
| V21 | Swift 腿完整验收 | 四项 UI、同池三条、node 创建（Electron 归档参考，不验收） | Release |
| V22 | 分支候选按需读取 | 外部新建本地分支后打开对话框即可见；Existing 页签已检出分支禁用（旧宿主回退列表不具备该事实，豁免）；读取失败显式错误 + 重试；旧宿主回退快照列表；local/ssh/gateway 三形态一致（404 分类/线格式/状态机由单测前置覆盖；旧宿主回退行为在实机 V22 复核） | Release |
## 8. Rejected alternatives（统一模型与 P5b）
- **worktree 作为 workspace（旧模型：`workspace.create` + `session.create` + 补偿 saga + 删除时 `workspace.delete`）**：否决。会话/工作区是两个持久化域，创建要补偿、删除要归档前置与 registered 删除；未挂载来源还要回声/位置意图才能看见空工作区；而 workspace-write 沙盒仍要求 checkout 在源 checkout 内。统一模型把 checkout 降为 Git 事实、会话留在源根，用一条 thin `enter` 完成放置，删掉了 workspace/session 生命周期、rollback、echo 与 registered remove。代价 = 旧池必须清空（§7.4）且池外树不可见；接受。
- **自研 forge / 自建 restore**：否决。forge 已有 composer 开关、创建卡/hold、restore/ continue、右栏 tab 与 agent `create_worktree`；自研等于复制一套执行面与会话耦合，还要自己维护 restore 记录。保留 seed 只做仓库级 inventory/删除/enter，UI 交给 forge；代价 = restore 仅 forge record，seed 树无 restore（接受的不对称）。
- **把 worktree 根继续放在 `$DSH_HOME/worktrees`**：否决。仓库外 = 不在源 checkout 的 workspace-write 沙盒内，会话无法 `git add/commit`；且旧池无法与 forge 共用。改为 `<repo>/.agents/worktrees` + 自忽略；代价 = 池内目录会出现在仓库工作树中（必须自忽略，不可写就 fail-closed）。
- **保留 registered remove / 先归档再删**：否决。checkout 不是 workspace，registered 删除只会把“删 Git 树”与“删注册/归档会话”两个域重新耦合；归档是用户对会话的选择，不应成为删除工作树的**默认前置**。改为 path-based remove + running/current 守卫；已注册路径先解注册。旧 registered 池由发布前提清空（§7.4）。**可选的**客户端归档勾选（默认关闭，§5.4）是显式用户授权，不改变默认语义，故保留。
- **在 flags store 发布合成 checkout flag / 把派生行 id 写进 workspace order**：否决。 `retainSourceWorkspaceFlags` 会剪掉非 workspace key；派生行自带 `repoKey/familyMainId/isMain`，flag 查找回落即可。拖动用独立 `checkoutOrder` 子序， `resolveWorkspaceDrop`/`commitWorkspaceDrag` 零改动，避免把派生 id 送进宿主的 workspace order（会 404/污染注册表序）。
- **恢复“trailing”行尾 glyph / GitHub PR 行图标**：否决。trailing 座席与行几何冲突（旧裁决不变）；P5b 关闭 GitHub provider，行图标/PR 卡暂缓。会话行**不画** checkout 分支 glyph （旧 worktree 会话显示同形，避免每行标题左移）。
- **P5b 默认启用**：否决。forge 仍是 EXPERIMENTAL，启用会改变 composer/restore 面并引入两实例配置；改为 opt-in + 重启，GitHub 行 disabled 由 overlay 保证。
- **node 写 `process.execPath`（Electron 二进制当 node）**：否决。forge 的 `nodeCommand` 是单字符串、无 args/env；Electron 二进制跑 `--input-type=module` 必败且不是 `node-unavailable`。改为 PATH shim / string-only 真实 node，Swift 用 sidecar node。
- **旧池自动迁移/提示**：否决。检测旧根会把“升级前清空”变成代码里的兼容分支，且旧根残留会被 snapshot 变成 missing 行（被动提示）。改为发布前提 + 只报池内。
- **归档 roots 仍取主 workspace membership / 复用打开时的预览**：否决。membership 是轮询 + 可退化视图（canonical-cwd 索引为空时 roots=0），且打开后新建/进入的会话不在其中；物理 `workingDirectory ?? cwd` + 确认时重算才是 checkout 的权威。
- **归档闭包按「无 durable 标题」排除默认会话（而不是按 `blank`）**：否决。无标题也可能是有内容的历史行（冷缓存未带 title 投影，标题只是显示投影），按标题排除会漏归档真实内容； `blank` 是宿主首回合事实，恰好等价于“未首发、无内容”，即“新建会话”默认占位的形态（checkout 行「+」的 `createSessionHere` 是典型来源；宿主/客户端建而未用的空行同形）。冷行未知按非 blank（fail-open）：宁可多算一个，不误删有内容的历史行。
- **删除进行中允许 X/Escape 关闭以“取消”**：否决。异步删除没有取消语义，关闭只会造成“看起来取消、实际继续”；改为删除中忽略关闭，停止确认仍可单独取消归档。
- **子模块 refusal 只显示错误、不重新武装勾选**：否决。host 的强制移除需要显式 `discardChanges`；不重新武装会让用户永远无法越过该拒绝。
- **归档对话框复用单一 `RiskConfirmation`**：否决。分支/归档/确认三个选择无法塞进单框；改为自定义 `Modal` + 停止对话框，仍只用原语组件。
- **打开创建对话框时刷全量 snapshot 以取新分支**：否决。快照会重扫描全部 repo/worktree，并受 30s 发现缓存与 20–25 秒 single-flight 约束，为一仓库的本地分支名触发全量扫描，成本不匹配；改为独立的按需只读 unary（§2、§4.1）。**打开时强制失效发现缓存**的变体同样否决：仍要全量重扫，且 snapshot 的 single-flight 在飞时会复用旧 deadline 结果，失败面只有整源 `sourceError`，没有窄范围的缓存失效面。
- **给 snapshot 加 `fresh`/`bypass` 参数**：否决。那等于把发现缓存变成人人可绕过的开关，缓存的存在意义被契约否定，且“picker 要新鲜分支”这一便利会扩散成 snapshot 的通用刷新语义；按需读用独立方法承担，不污染快照契约。
- **Existing 页签在读取失败时允许手输分支名**：否决。手输把“存在且未被检出”的校验推到 `previewCreate` 才失败，用户单击创建后才发现错误；loading 禁用选择器、error 给本地化错误 + 重试，才把校验留在同一个位置（§4.1）。（读取成功但候选为空时保留既有手输回退，不属于本条。）
- **缩短 30s tick 或加大轮询波以刷新分支列表**：否决。轮询波受页面同源槽池预算约束（design 26 §D7），缩短 tick/加波是全局事实刷新成本，不是“打开 picker 时读一次分支”的解法；按需读不进波（§3.1）。
- **snapshot 增加 capability 字段告知客户端是否支持 `branches`**：否决。只为省一次 404 探测就扩快照契约，还要求新旧两半对 capability 字段 lockstep；方法缺失的 404 + 本来源已有成功 snapshot 已足以判定旧宿主并回退（§6.3）。
- **用 refs 指纹让 `snapshot.branches` 每轮新鲜**：否决。指纹只让宿主在 TTL 内提前失效发现缓存，治不了客户端 30s 波与多来源轮转带来的新鲜度问题；按需读同时绕开宿主 TTL 与客户端波。
- **fs.watch / 事件推送分支变化**：否决。实例域没有 server→client 通道，为此新建推送面与监听器的成本远超 picker 的一次动作读取；外部 forge/agent 创建的 checkout 行仍按既有轮询波出现，不为此加事件面。
- **现在退役 `snapshot.branches`**：否决。它是旧宿主与按需读失败时 picker 的唯一回退源，退役会断掉兼容窗口与降级路径（§6.3）；保留为回退，首选数据源改为按需读。退役条件（连接面不再有旧 host）单独裁决，不在本设计内自证。
