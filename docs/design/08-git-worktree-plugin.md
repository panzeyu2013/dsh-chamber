# 08 · Git Worktree 独立插件

> **状态：现行（v1 实现，Design 17 迁移期保留，2026-08-20）**。本文是对原
> 原 todo 记录（`08-todo-git-worktree-plugin.md`）的实施前审计与收敛。原稿的
> “独立插件”边界保留，但 Git 执行从 Desktop/SSH 移到每个 dsh 实例内的
> chamber host plugin；会话创建/打开和工作区注册仍只走 dsh 现有 wire。
> Design 17 的 gateway Git offload 是待实机稳定的替代路线；在其通过 canonical
> path、补偿 provenance、真 dsh/worktree 冒烟与回滚门禁前，本插件不得停止 seed、
> 不得删包。两条路线的记录不互相冒充权威。

## 1. 审计结论

原计划不能直接执行，原因是它与当前仓库和 wire 有五处实质冲突：

1. `TransportExecAction.run`、SSH `run`/`write-file` 和 manager payload 涟漪已由
   设计 13 完整落地；不得再扩一次接口形状。
2. SSH 注册用户不保证等于 dsh systemd 进程用户。工作区权威属于
   dsh 进程的文件系统；Desktop 不能用另一用户的 namespace 冒充它。
3. OpenSSH 会把远程参数再交给 shell 解析。本地 `spawn("git", argv)` 的参数
   安全性不能直接类推到 `ssh host git ...`，含空格/引号路径也无法可靠往返。
4. `workspace.create` 实际返回 `{workspace, created}`，原 wrapper 却丢弃这两个
   补偿所必需的事实；`session.create` 已支持调用方预分配 id 和幂等重试。
5. `requestOpenSession` 是无 ack 的前端通知；归档又是当前不可逆的
   全局隐藏。因此“打开失败就回滚工作树”和“先归档再删工作树”都会
   破坏已持久化的会话事实。

收敛后的原则是：**Git 只是会话工作区的实例内扩展，不是控制面或
Desktop 的新执行面。**

## 2. 边界与部署形态

```text
┌─ @dsh-chamber/dsh-client-ui-git ────────────────────┐
│ sidebar.workspace.git 座位、拓扑、创建/删除 saga、30s 单飞协调器     │
└──────────────────────────┬──────────────────────┘
                           │ 每实例反代 + dsh 现有 unary
                           ▼
┌─ @dsh-chamber/dsh-host-git-worktree ────────────────┐
│ 运行于该 dsh 实例进程；workspaceRegistry/agents 权威校验  │
│ Typert Remote: snapshot / previewCreate / create / rollback / remove │
│ child_process.spawn("git", argv)；不经 shell，不提供网络 Git 动词 │
└─────────────────────────────────────────┘
```

- `packages/renderer` 只把客户端插件静态注册到复合 entry，不拥有 Git 事实、
  轮询或业务 UI。
- `packages/control-plane` 仅与 host-graph 包同型地 seed host 包、挂
  `--patch` 并通用反代 Remote；它不解析 Git 输出、不存拓扑。
- `packages/desktop` 仅在远程实例 ready 时分发同一 host 包。它不暴露
  `desktopGit`，也不运行 `ssh ... git ...`。
- 客户端插件依赖 sidebar 的 `./shared` bridge/unary 面是当前的最小改动。
  已有消费者数早就超过“第三个”；中性 shared 抽包是独立机械重构，
  不伪装成本功能的里程碑。

## 3. Host Remote 契约

namespace 固定为 `gitWorktree`：

| 方法 | 语义 |
|---|---|
| `snapshot()` | 从 `workspaceRegistry.list()` 出发找 repo，按 absolute `git-common-dir` 去重，返回 worktree/branch/HEAD/dirty/locked 以及 workspace/session 关联；单 repo/path 错误与完整 repo 并存 |
| `previewCreate(input)` | 验证 repo id、本地分支、目标 parent/basename 和当前 HEAD，返回短期 capability token；preview 不是最终授权 |
| `create(input)` | 在 common-dir mutex 中重新验证；`operationId` 合并重复请求，响应丢失时同 id 返回同一结果 |
| `rollbackCreate(input)` | 仅对本 operation 创建、尚未被 workspace 注册、身份未变且 clean 的 worktree 有效；不用 `--force` |
| `remove(input)` | fresh 对账后仅删除权威 worktree list 中的 linked worktree；主 checkout、locked、身份变化、关联 running agent 都拒绝；dirty 默认拒绝，仅当 `discardChanges: true`（对话框显式勾选，§6 修订）时以 `git worktree remove --force` 移除；不删分支（除非显式 `deleteBranch`，§11.3） |

RPC 只接受领域 operation，不接受任意 Git argv。所有 mutation 的锁键是
canonical common-dir，不是 renderer 提供的 repo path。

Typert carrier 会把普通业务异常归并为 `internal`，所以 gateway 的五个方法都在
carrier success 内返回第二层领域 envelope：`{ok:true,value}` 或
`{ok:false,error:{code,message,retryable?,details?}}`。客户端必须同时验证两层
envelope，并对每个方法的 success value 做运行时 shape 与请求相关性校验；路径、
operation/workspace/repo/worktree id、branch 或 HEAD 任一错配都不得推进 workspace、
session 或 delete 副作用。

### 3.1 Git 子进程约束

- 只用 `spawn/execFile` argv 形态，`shell:false`；设置超时、stdout/stderr 字节上限。
- 只读路径设 `GIT_OPTIONAL_LOCKS=0`；禁止凭据 prompt，v1 没有
  `fetch/pull/push/ls-remote/remote`。
- “没有网络 Git 动词”不等于 checkout 绝不访问网络：`worktree add` 仍会遵从
  同一 OS 用户在该仓库配置的 `clean/smudge/process` filter（例如 Git LFS）。
  这些 filter 属于实例用户/仓库配置的受信边界，创建确认必须明示；chamber 禁用
  checkout hooks，但不重写用户的 filter 语义。
- worktree 列表优先 `git worktree list --porcelain -z`（NUL 定界，路径无歧义）；
  `-z` 于 Git 2.47 才引入，旧 Git 以 usage error（exit 129）拒绝未知开关——host
  检测到 129 后回退到换行定界的 `--porcelain` 形式（记录语法一致：空行分隔记录）。
- 分支经 `check-ref-format --branch` 校验；用户值不能成为 option。
- 新目标尚不存在，因此 canonicalize 其已存在 parent，再校验单段
  basename 和 containment；不对未存在 target 伪调 `realpath`。
- 创建/删除后再读权威 topology 确认 common-dir/path/branch/HEAD。

## 4. 客户端数据流与座位

座位在 2026-08 对齐轮改为 **`sidebar.workspace.git`**（per-workspace 上下文
座位，v0.1.4）：sidebar root 对每来源渲染两次——`workspaceId === ''` 的源级
警示条（恢复/动作错误，挂在工作区列表上方）与每个 workspace 组头部行内的
occupant（OpenChamber 式：**workspace 行本身就是 Git 表面**，没有独立
git 行）。独立面板座位 `sidebar.git` 已移除（面板功能属远期二次开发）。

sidebar 包声明座位（kind single / scope root / `{wide}` owner）与
`hookContext { sourceId, workspaceId }` + slot 级 `inject.hooks.workspaceGitContext`
（工厂必须在 children 表的 slot inject 声明，**不能**进插件 entry inject——
entry inject 的 hooks 会被当 observable 绑定而崩溃，slot-contract 测试守卫）。
sidebar 不依赖 Git 类型；Git 插件用 slot inject 占位。窄栏 occupant 返回 `null`，
但 slot 不卸载，避免切换宽度丢操作状态。

插件模块内有一个页面级 singleton coordinator：

- 订阅 neutral `chamberBridge` 获得 `local | dsh-<id> | gateway-<id>`（`ssh-<id>`
  为 v2 迁移前 legacy，17 §2.2/§9.1）和 connected 事实；
- 每来源一个 in-flight promise，30s 轮询，新连接/动作后即时刷新；
- 断连立即清该来源事实；迟到响应用 sequence 拒绝；
- `repos` 与 path/repo 级 `errors` 同时保留，一个失败不抹掉其它完整实体；
- N-ctx 的所有 occupant 读同一 facts/action/recovery store，不重复轮询，
  切换 shell 不丢 busy 或部分失败状态。

Git 事实不加进 App 的 session aggregate，v1 徽标只在 Git 区内；普通
10s `requestRefresh` 不触发 Git status。未来全屏功能必须新增通用页面
slot，不由 renderer App 直接 import 领域组件。

## 5. 创建事务（补偿型 saga）

```text
preflight -> git-creating -> workspace-adopting -> session-creating
          -> committed -> opening-requested
```

1. UI 确认时生成 `operationId` 和预分配 `sessionId`，所有重试复用。
2. Host create 幂等身份为 common-dir + target + branch + expected HEAD。结果分两类：
   - 本次观察到 `git worktree add` exit 0：返回 `rollbackAuthorized:true`，host
     才持有可自动补偿的 operation provenance；
   - timeout、输出超限或非零退出后，同 `operationId` 重试若 fresh topology 已精确
     收敛到目标，可作为 PUT 式前向成功返回，但必须是
     `rollbackAuthorized:false`。它不能被宣称为本 operation 创建，也绝不能自动删除。
     明确的 spawn/pre-admission 失败不进入此收敛；其它已存在目标一律 conflict。
   已完成 create 的同 `operationId` 重放也不能只返回缓存 receipt：host 必须在
   common-dir mutex 内 fresh 复核 common-dir/main/path/branch/HEAD；目标被外部删除、
   替换或漂移时 fail-closed，不得让 client 继续创建 workspace/session。
3. `workspace.create({path})` 必须保留 `{workspaceId,path,created}`。
   只有 `created:true` 才证明该 workspace 归本操作所有。
4. `session.create({workspaceId,sessionId})` 可幂等重试。一旦发出这个请求，
   就不再自动回滚：响应丢失或 `workspace-attach-failed` 都可能已发布 Session，
   而当前没有 session delete wire。
5. Session 成功是 durable commit。`requestOpenSession` 仅发送打开意图；它无 ack，
   不被宣称为 bootstrap 成功，也不属于回滚边界。
6. 只有在尚未尝试创建 Session、`rollbackAuthorized:true`，且 host 仍能证明
   worktree 由本 operation 创建、clean、未注册时，才可 `rollbackCreate`；不使用
   force。`rollbackAuthorized:false` 的 workspace adopt 失败只进入 forward-only
   recovery，复用同 operation/session id 继续注册，永不以“补偿”为名删除来源不明的
   worktree。

## 6. 删除事务（无归档）

```text
fresh-preflight -> git-removing -> git-removed
                -> workspace-deleting -> done
                                      \-> workspace-delete-pending (retry)
```

- 确认时重拉 snapshot 和 session aggregate；UI 拒绝当前正在阅读的 Session，
  host 核心拒绝任一关联 running agent。
- Git remove 先执行且不用 force。响应丢失后以权威 topology 已无
  该 worktree 为成功对账条件。
- **2026-08 修订（用户拍板）**：dirty 工作树不再硬性阻断删除——删除对话框
  列出该工作树有未提交更改（host 快照 `dirty` 事实），要求用户勾选
  「丢弃未提交更改并移除（保留分支）」后，客户端才发送 `discardChanges: true`，
  host 以 `git worktree remove --force` 移除（§11.3）。**force 只经显式授权**：
  - 分支/提交/HEAD 永不触碰：`--force` 只丢弃工作树工作区文件
    （已修改/未跟踪文件），`branchPreserved: true` 无条件成立；
  - 身份/锁/主 checkout/running-agent 守卫全部保留，force 只放行 dirty。
    **2026-09 事实修正（对照 git 源码 2.39→master 复核）**：
    `git worktree remove --force` 并**不**绕过 git 自身的锁检查——remove
    的锁 die 需 `-f -f`（force ≥ 2）才放行，单 `--force` 仍被 git 拒绝；
    因此 finalTopology 读取与 git 调用之间被外部 `git worktree lock` 的窄
    窗口内，git 会在**变更前** die 拒绝（属 §7 声明的外部 Git TOCTOU
    剩余边界），2026-09 起该拒绝经失败后拓扑复查被改判为确定性错误
    （可关闭、不锁来源），host 层 `worktree-locked` 守卫无条件保留不变；
  - argv 白名单新增精确文法 `worktree remove --force -- <abs-path>`，
    `--force` 不能以任何其它形态混入；
  - `discardChanges` 参与输入指纹：恢复重放必须携带原值，否则
    `operation-conflict`（恢复永久卡死的反面：明确报错而非静默换语义）；
  - 剩余边界（§7 既有，force 下略更常见；**2026-09 对照 git 源码修正删除
    顺序**）：git 先删**工作目录**（递归），即便目录删除失败也继续删
    admin entry——若递归删除目录因权限等失败，git 退出非零、admin entry
    已不在 list——重试对账按"topology 无此 worktree"收敛成功，但**目录
    可能残留**（如 2026-08 实机 `server-side/` 空目录），需用户手动清理；
    收敛语义与 §6「topology 已无该 worktree 为成功对账条件」一致，不做
    目录存在性反向校验。
- **2026-09 修订（子模块拒绝，实机报告）**：git 自身拒绝不带 `--force`
  的 `git worktree remove` 删除**含子模块检出**的工作树——builtin/worktree.c
  `validate_no_submodules` 在变更前 die（exit 128，"working trees
  containing submodules cannot be moved or removed"），`--force` 是唯一
  绕过（linked worktree 的子模块 gitdir 位于其 admin git dir 的
  `modules/` 下，与 git 判据一致）。host 在最终变更前镜像该守卫：
  - 含子模块工作树未授权丢弃 → 确定性拒绝码 `worktree-submodules`
    （`retryable: false` 显式标记），**不发起任何 git 变更**；对话框就地
    呈现子模块丢弃授权（勾选后 `discardChanges: true` → `--force`，
    §11.3）——子模块工作区文件与 dirty 文件同属「显式授权才丢弃」的一类
    （gitlink 已提交，内容可重新检出），分支/提交/HEAD、身份/锁/
    running 守卫全部不变；
  - 守卫 best-effort：`.git` 指针不可读时读作"无子模块"；git 的 index
    回退判据（admin `modules/` 缺失但 index 中有已检出 gitlink——历史/共享
    gitdir 布局）**不镜像**。git 自身仍拒绝时 host 在失败后复查 topology：
    **同一个**目标（同仓库身份且 branch/HEAD 相同）仍在列出、目录仍存在
    且工作树仍干净 ⇒ 必然**变更前拒绝** ⇒ 改判确定性（`retryable:
    false`）；git 的 stderr 明确为子模块拒绝时升级为同一 typed 码
    `worktree-submodules`（git 子进程固定 LC_ALL=C，文本稳定），对话框
    授权流同样可用。目标已消失/身份漂移/变脏等无法证明的失败保持原
    retryable 语义，恢复重放照旧；
  - `domainResult` 显式序列化 `retryable: false`（区别于"不在
    RETRYABLE_CODES 因而省略该字段"）作为"已证明未变更"的线上信号；
    客户端凭该信号把未决的 git-remove 恢复判为已解决（"未删除"）并清除
    ——§7「UI 保留未决」的有界例外（仅限 host 可证明的变更前拒绝；
    歧义失败与 definitive conflict 行为不变）。
- 然后调 `workspace.delete`：它只解注册，会话日志保留并转 Ungrouped。
- workspace delete 失败时保留完整的 `operationId + workspaceId + opaque expected + path`
  恢复项。首次及每次重试 registry delete 前，都先重放 host remove 终态验证：目标仍
  不存在，且 workspace 已不存在或仍为同 path/同 membership、没有 running agent；
  目标重现或 registry 身份漂移一律 conflict，绝不继续 delete。通过后才把
  `workspace/not-found` 视为前次 delete 已提交；不反向重建 Git 工作树，也不隐藏会话。
- v1 不删分支。特别是不使用 `branch -D`（删除对话框的「同时删除本地分支」
  是 §11.3 的显式用户授权例外，与 `discardChanges` 无关）。

这是两个持久化域（Git FS + dsh registry）之间的可重试 saga，不是原子
事务。紧邻 delete 的终态验证只能缩小可控的 TOCTOU 窗口，不能把两次 RPC 变成原子
提交；它也无法感知另一个外部客户端正在查看但没有运行的 idle Session。这些剩余
边界必须显式呈现在确认文案中。

## 7. 失败、并发与安全不变量

- 渲染层不提供任意路径或 argv 给 mutation；opaque id/token 也不是信任来源，
  host 每次仍从 registry + Git 重新解析。
- 一 repo 一 mutation 链，键是 absolute common-dir；轮询永不重叠。
- Git 子进程 timeout/输出超限时先 kill，但 common-dir mutex 必须等 child `close`
  后才释放；仓库 filter 的更深层后代无法跨平台可靠 group-kill，属于 §3.1 已披露的
  受信配置剩余边界。
- 一个工作区/repo 失败不撤掉其它成功实体。Git 二进制缺失是来源级
  错误；非 Git 工作区不被误报为整源失败。
- Snapshot 共用一个 in-flight：20 秒是 probe launch/Git budget，25 秒是对客户端的
  wall response deadline；最多 128 workspace、64 repo、每 repo 128 且全源合计
  256 worktree、16K session memberships。running agent cwd 每轮至多 canonicalize
  一次；超限/超时返回显式 source error 与已有局部事实，不伪装成健康空结果。
  Node 的既有 FS await 无法安全取消，25 秒时旧 scan 可在后台继续，但它真正退出前
  single-flight 不释放，后续 poll 复用 deadline 结果，绝不启动重叠扫描。
- preview 最长保留 5 分钟；create/remove operation 最长保留 24 小时。容量压力下
  只可淘汰从未进入 mutation、没有外部 effect/provenance 的最老 `ready` 记录；
  `created/uncertain/rollback-uncertain/removed` 等 tombstone 在 TTL 内不得提前淘汰，
  否则宁可 fail-closed `operation-capacity`。进程重启会丢内存幂等缓存，因此恢复仍以
  fresh registry + Git topology 为权威，绝不依赖缓存作为安全凭据。
- 浏览器 recovery 只在当前页面/进程内持有。host 重启或外部 identity 改变可令旧
  operation 永久 definitive conflict；UI 保留未决并阻止同目标新动作，不提供把
  “放弃”伪装成成功的按钮。用户需 reload 后依据 fresh topology 手工核对。
  **2026-09 有界例外**：host 显式 `retryable: false` 的拒绝 = 已证明变更前
  未动（目标仍在、目录仍在、仍干净，见 §6）——同一删除的未决性已被解决为
  “未删除”，客户端清除该 git-remove 恢复并呈现可关闭错误，不再要求
  无出口的重试；definitive conflict（身份漂移等）仍按上文保留未决。
  **2026-09 补充（既有残余，非本次回归）**：脏竞态（git 因树变脏在变更前
  die）因复查的"仍干净"条件不成立而保持 retryable，其恢复重试随后撞上
  确定性 `worktree-dirty`（不带证明标记，恢复保留）——脏需外部清理后
  重试收敛，与 identity 漂移同属"原因可修/需外部核对"的类别。
- 绝不记录命令输出中的凭据/URL；v1 不提供网络 Git 动词。仓库配置的 checkout
  filter 可能自行访问网络，按 §3.1 的受信边界处理。
- 远程与本地运行同一 host 包，所以同一套路径/参数/运行会话守卫生效；
  不存在两套 Desktop adapter 差异。
- host 包缺失/未生效必须显式错误，不把“没有执行面”伪装成空仓库。

## 8. 工程接线与验证

- host 包与 client-graph 包一起进入本地 profile seed、远程 ready-time seed、
  desktop 打包资源和 loader patch；seed 继续只经已实现的受限
  `run/write-file` 通道。
- loader id 与 package name 在 profile 中是全局身份：单个 exact 既有 row 复用，
  同 id/异包、同包/异 id 或重复 exact row 都在写包/启动前 fail-loud，不追加出一个
  下一次重启才暴露的 Cordis 冲突。
- client 包是首屏静态覆盖行：Vite aliases、`chamber-entry` apply +
  module factory、`CHAMBER_COVERED_IDS`、`CHAMBER_COVERED_FACTORY_IDS` 必须锁步。
- 专属验证门：`typecheck:git`、`typecheck:host-git`、`test:git`、
  `test:host-git`；同时运行 sidebar/renderer-shell/desktop/control-plane 回归。
- 打包前必须重建两个 host 产物，再拷贝到 desktop `dist/`。

## 9. 实施里程碑

| 里程碑 | 纵向闭环 |
|---|---|
| M0 | 修正 workspace/session wrapper，定稿 host-in-instance 边界、幂等键与无归档删除 saga |
| M1 | host snapshot + 远程/本地分发 + singleton 30s facts + `sidebar.workspace.git` 只读拓扑（座位 2026-08 对齐轮后为 workspace 行内，独立面板座位 `sidebar.git` 已移除，见 §4） |
| M2 | preview/create/workspace/session/open-intent 创建闭环，含丢响应重试和安全补偿 |
| M3 | fresh guard + Git-first + workspace-delete retry 删除闭环，不归档、不删分支；force 仅经 `discardChanges` 显式授权（§6 修订） |
| M4 | N-ctx/断连/局部失败/无 Git/打包回归与远程实机验收 |

v1 明确不做 commit/diff/stash/fetch/push/PR，也不新增任意 Git 终端。

## 10. 落地扩展（2026-08-20，主分支合并后）

M0–M3 合并进 main 后追加的三处能力（对齐 OpenChamber 的会话↔worktree 深度，
未改变 §9 的范围排除）：

1. **已有 worktree 作为新会话目标（§4/§5 扩展）**：每个工作树行（含主 checkout）
   提供「在此新建会话」——只读采纳式 saga（`runAdoptSessionSaga`）：无 Git
   mutation，`workspace.create` 注册/复用路径后以预分配 id 提交会话，session
   尝试后永不补偿（无 session-delete wire）；失败沿用同 id 重试，恢复类型
   `session-adopt`。UI 对不健康工作树（`status !== 'ready'`）禁用该入口。
2. **会话↔worktree 附着状态模型（§3 snapshot 扩展）**：快照每行新增
   `status`（ready/missing/invalid/not-a-repo：路径缺失、status 报
   "not a git repository"、其它 status 失败）、`headState`
   （branch/detached/unborn：unborn = porcelain 全零 HEAD + branch ref）、
   `attention`（从工作树 git-dir 的 MERGE_HEAD/REBASE_HEAD/rebase-*、
   CHERRY_PICK_HEAD/REVERT_HEAD/BISECT_LOG 探测，经注入的 fs 抽象，
   尽力而为）。客户端解码强制校验新字段（对旧 host 包 fail-closed）；
   侧栏呈现健康/HEAD/attention/「当前会话」徽标；删除守卫新增
   `unhealthy` 阻断；`canTargetSession` 门控新会话入口。
3. **删除级联语义对齐（§6 扩展，不改无归档默认）**：删除确认时递归枚举
   （`collectSessionClosure`：`parentSessionId` 闭包，环安全）直接 + 全部子
   会话并显式呈现；文案明示「会话保留并转未分组，不删除」。提供「先归档
   （含子会话）」选项：归档在**任何 Git mutation 之前**执行，任一归档失败
   即中止且不删除任何工作树（显式报错，可重试）。

验证：`test:git`（31→46 用例）、`test:host-git`（42→59 用例）、
`typecheck:git`/`typecheck:host-git`、`build:renderer`、sidebar/renderer-shell
回归全部通过；host 产物 `dist/index.js` 已重建并提交。

## 11. OpenChamber 对齐轮（2026-08-21，v0.1.4）

按"前端实现方式也一并对齐"的要求完成的呈现/交互/能力对齐，以及多轮
subagent 复查的修复。除仓库特性外，前端形态与 OpenChamber 一致。

### 11.1 呈现：workspace 行即 Git 表面（移除独立 git 行）

- occupant 渲染进 workspace 头部行内（title 与 rowActions 之间）：worktree-
  workspace 显示**分支 chip**（仅分支名文本、无图标、12px/500/次级色、截断，
  常显——它就是该 worktree 的身份）；主 checkout 不显示 chip（与
  OpenChamber 一致：root 组只显示项目名）。行内动作图标 16px（OpenChamber
  同款）；空 workspace 的组体显示"该工作区暂无会话"提示行（OpenChamber
  空组文案对齐）。
- 行内动作（创建/删除）与 "+"/kebab 同触发源：字面量类 `git-ws-action`
  由侧栏 `.workspaceHeader:hover/focus-within/:has(.rowActionsVisible)` 统一
  揭示；静止时 `display:none`（零布局占用、移出 Tab 序）；**hover 时 chip
  （`git-ws-chip`）原位隐藏、动作在同一位置换入**（镜像侧栏
  count→rowActions 的原位换入，无布局漂移）；禁用态 hover 下保持 .42。
  （本节为 2026-08 轮实现记录；揭示触发语义后经 §11.7 修订为 pointer-safe
  ——hover / kebab 展开 / 键盘焦点，鼠标点击产生的普通 focus 不再揭示。）
  **禁止二次派生（OpenChamber 对齐）**：创建入口只在仓库**主 checkout**
  行（worktree 行只有删除）；创建对话框的来源下拉也只提供主 checkout
  workspace（`createSourceOptions` 优先 `isMain`）。
- **折叠区图标交换（OpenChamber SessionGroupSection 对齐）**：worktree
  （派生）workspace 的折叠按钮常态显示 **git-branch 图标**、hover 才换回
  折叠箭头（展开=向下/折叠=向右，旋转移至 chevron 元素避免旋转分支图标）；
  普通 workspace 保持纯折叠箭头。侧栏通过共享存储
  （`shared/workspace-git-flags.ts`，插件发布、侧栏读布尔值——保持零 git
  类型依赖）感知派生 workspace。**注册/创建后的定位（2026-08 修正）**：
  dsh registry 对新建 workspace 是 **prepend（头部）** 而非 append——注册
  流程在提交成功后立即 `workspace.insertBefore` 把新工作树移到其主
  checkout 之后（注册表顺序持久化，重启后仍在组内；失败 best-effort 不
  回滚已提交的 workspace）；adopt 的 workspace 标题按分支派生（目录
  basename 可能与主同名）。
- **派生 workspace 行简化（OpenChamber 对齐，用户决策 2026-08）**：worktree
  行**移除省略号（kebab）与重命名**（双击改名同样禁用），hover 只保留
  **删除**（git occupant）与 **"+"**（新建会话）；行内不再显示分支名
  （最右侧不显示 worktree 名称——分支身份由折叠区分支图标 + 目录名表达）。
- **图标与字体层级（OpenChamber 调研对齐，用户决策 2026-08）**：普通
  workspace 折叠区常态 **folder 图标**（14px，project 行对等）、worktree
  常态 **git-branch 图标**、hover 均换 14px 折叠箭头；workspace 标题
  **14px/600 主色**（project 标签对等），**派生 workspace 标题降级次级色**
  （worktree 组标签 muted 对等）——图标语言 + 墨色阶梯 + 会话行 26px 缩进
  构成三级视觉引导；组间距 2px→3px（组间分隔增强，行高 26px 防 flicker
  约束保持）。
- **派生 workspace 的排序边界与项目分隔（用户决策 2026-08）**：flags 携带
  `mainWorkspaceId`——派生 workspace **拖拽不能排到其主 checkout 之前**
  （乐观序 clamp + 拖拽指示器在越界位置抑制，wire anchor 按 clamp 后顺序
  推导）；**项目（repo 组）起始 workspace 的上间距加大**（3px→10px：
  非 git workspace、主 checkout、或上一个 workspace 属于其它仓库的派生
  workspace 视为项目起始），同仓库的派生组保持紧凑间距。
- **对话框调整（用户决策 2026-08）**：删除对话框移除长说明文字（会话/
  分支语义由勾选项与确认按钮承载），工作树路径颜色提为主色（原继承的
  透明墨色近不可见）；创建/删除对话框宽度 480px→560px；创建对话框移除
  "来源仓库"下拉（入口即确定派生源，内部仍锁定主 checkout 来源）；字段
  间距 12px→14px、标签内距 5px→6px；**目录重名自动加数字后缀**
  （OpenChamber resolveCandidateDirectory 对等：打开/切换 tab/失焦同步/
  提交时均查重，`name-2`/`name-3`…，host target-exists 仍为最终守卫）。
- **显示全部 worktree（Plan A，用户决策 2026-08）**：
  - **未注册工作树按仓库分散到 repo 组末尾**（名称=目录 basename、与派生
    workspace 一致的行样式：分支图标 + 名称 + 健康徽标），无已注册 workspace
    的仓库在列表末尾渲染其未注册块；数据经 flags 存储的每来源仓库布局
    （`RepoGitLayout`）发布，侧栏以 `repoKey` 上下文第三次挂载该座位，
    occupant 渲染行与动作（"新建会话"= adopt 懒注册、"删除"= 未注册删除）；
  - **未注册删除**：host `RemoveInput.workspaceId` 可选 + `path` 必填，
    git-first 移除保留身份/脏/锁/主守卫，`RemoveResult.next: 'none'` 时客户端
    跳过 workspace.delete 与归档（无会话）；operationId 幂等/重放复用；
  - **孤儿 workspace**：快照 `workspace-path-failed` 标记 `orphaned: true`，
    行显示"已消失"徽标；删除弹专门确认（"工作树已不存在，仅删除其注册，
    会话保留并转未分组"）后仅 `workspace.delete`；
  - 竞态：adopt 前 fresh 快照复核；未注册外部删除自愈消失；注册后外部删除
    进入孤儿流程。
- **注册/删除全链路修复（4 子代理复查 2026-08）**：adopt/创建提交后
  `insertWorkspaceBefore` 把新工作树移到主 checkout 之后（registry 实为
  PREPEND，原假设 append 已更正）；adopt 标题按分支派生；注册删除预检对
  路径不可解析的无关 workspace 宽容跳过（孤儿不再阻塞该来源所有删除，
  否则 retryable 错误会把来源锁死在 recovery）；missing 工作树行按 raw 路径
  回链 workspace（不双显进未注册块）；确定性领域拒绝不铸 recovery（降级
  actionError）；仓库级快照失败时 keep 继承上一快照（flag 不闪失）；删除
  对话框会话事实失败可重试；isProjectStart 改 repoKey 级判定。
- **状态事实不进行内**（OpenChamber 对齐）：status/headState/attention/
  upstream/ahead/behind 保留在快照，用于删除门控（按钮阻断原因进
  title/aria）与未来的 Worktrees 管理页；上游信息仅在 chip tooltip
  （`路径 → 上游`）呈现。
- 源级警示条（recovery/actionError）挂在来源工作区列表上方；snapshot
  安装类错误**不进侧栏**（归属 connections 插件 chamber 块，见 §13 反向
  seed 文档）：not-loaded 源退化为普通无 worktree 视图。

### 11.2 创建对话框（OpenChamber NewWorktreeDialog 对齐）

- New Branch / Existing Branch 双 tab（active-pill）；分支名打开时自动
  双词 slug（10×10 组合，查重：避开已有分支与工作树目录名，8 次重roll）；
  目录随分支名同步直至编辑（"重置为分支名"）；来源分支下拉（本地分支，
  localStorage 按仓库记忆上次选择）；已有分支为**可选框**（host 快照
  `branches`，`show-ref --heads` 白名单新增）。
- **单击直接创建**（用户决策）：无预览屏——客户端内部串行
  previewCreate→createFromPreview（host 校验链完整保留），错误直接显示。
- **创建永不提交会话**（用户决策）：`createSession: false` 显式传入；
  recovery 记录携带 `createSession` 标志，重试尊重原意图（无会话创建重试
  不建会话、不跳转）。

### 11.3 删除对话框

- 会话闭包统计 + **会话标题列表**（≤5 + "还有 N 条"，取自侧栏 aggregate）；
  可选先归档（含子会话）；**可选同时删除本地分支**（用户授权，违背 §6
  "不删分支"的旧立场——`git branch -D` 白名单新增，尽力一次，失败如实
  返回 `branchDeleteFailed` 且不阻断已删工作树；对话框留存说明）。
- **dirty 工作树（2026-08 修订，用户拍板）**：删除图标不再禁用（仅 dirty），
  点击进入对话框后显示醒目警示（"该工作树有未提交的更改，将被永久丢弃；
  分支与已提交内容不受影响"）+ 勾选框「我了解这些更改将被丢弃，仅移除
  工作树（保留分支）」；未勾选时确认按钮禁用，勾选后才发送
  `discardChanges: true`（§6）。
- **含子模块工作树（2026-09 修订）**：行事实不含子模块信息，首次删除被
  host 确定性拒绝（`worktree-submodules`，变更前、`retryable: false`、
  可关闭、不锁来源）后，对话框就地显示警示 + 勾选框「我了解该工作树中的
  子模块检出将被丢弃，仅移除工作树（保留分支）」；勾选后同一
  `discardChanges` 授权重试 → host `--force` 一步删除（主路径）。终端备选
  需删除该工作树残留的子模块 git 目录——**实测（git 2.50.1）`git submodule
  deinit -f --all` 不会清空 admin `modules/`，守卫依旧拒绝**，文案如实
  提示。守卫只镜像 git 的主判据（admin `modules/` 目录）；git 的 index
  回退判据（历史布局）或竞态导致的拒绝经失败后复查**升级为同一 typed
  码**（§6），对话框流程一致可用。未注册行删除（window.confirm，无
  对话框授权流）沿用 dirty 的不对称：确定性拒绝 + host 英文提示（终端
  删除 modules 目录或 --force）。
- 硬阻断（locked/running/current/unhealthy/status-unknown）保留；
  main/unregistered 仍不可从此入口删除。

### 11.4 后端对齐

- **统一 worktree 根**：所有 chamber 创建的 worktree 落在
  `<DSH_HOME>/worktrees/<仓库名>-<sha256(commonDir) 前12位>/<目录名>`——
  集中、跨同名仓库无冲突、完全在仓库工作树外（git status 不受污染）；
  host 自动 mkdir（fs 抽象新增 mkdir）；DSH_HOME 缺失兜底 ~/.dsh；
  构造期校验绝对路径。
- **来源分支（startRef）**：新分支从所选本地分支 HEAD 起（`localBranchHead`
  解析为精确 commit 钉死为 baseHead，create 复验——比 OpenChamber 的
  ref 名语义更严格）；缺失报 `branch-not-found`；解析层放行 + safeBranchName
  校验（P1 修复）。
- **upstream/ahead/behind 只读事实**：快照 status 加 `--branch`（白名单
  新增固定形状），`parseBranchLine` 解析 `## b...u [ahead N, behind M]`；
  数字基于本地 refs（永不 fetch，如实）；脏检测改为"表头之后有内容"。
- **本地分支删除失败语义**：尽力 + 如实上报（OpenChamber 抛错误导，dsh
  更诚实）；target-absent 重放路径同样执行（attemptBranchDelete 三路径）。

### 11.5 修复（多轮 subagent 复查）

- P1：`startRef` 解析层被丢弃（`parsePreviewInput` 不含该字段 → 一选来源
  分支即 `invalid-input`）；exit 128 的缺失分支被当硬错误（localBranchHead
  非零即 null）。
- P2：create 不清发现缓存（新 worktree 快照 30s 不可见）；快照每 repo 每轮
  多跑一次 show-ref（缓存 branches 未消费）；deleteBranch 重放静默跳过；
  无会话创建在恢复路径仍建会话并跳转；existing tab 残留 new 模式建议分支；
  existing 目录被静默覆盖；occupant 按钮未纳入拖拽尾随 click 抑制；分支
  删除结果被解码丢弃。
- P3：死样式/死 locale 清理、`createSourceOptions` 死条件、chip 双击误入
  重命名、detached/unborn 区分、禁用态透明度。

验证（v0.1.4）：`test:host-git` 76、`test:git` 53、sidebar/renderer-shell/
desktop/connection/client-web/settings-bridge/connections 全绿、8 个
typecheck（含根）、verify:i18n、build:host-git（dist 重建且与 src 字节级
一致）、build:renderer。

### 11.6 404 语义与一键重启（悬空引用消除）

- **404 = 确定性 `git-host-not-loaded`**（git RPC 404，host 包缺失或未生效）：
  客户端判定为**确定性失败**——不建恢复（recovery 会永久死循环）、不重试，
  文案指引按来源区分重启路径：本地实例请重启桌面端；远程 ssh 实例请在连接设置
  中重新下发 chamber host 包并点击「重启生效」（`restart_service` systemd IPC）
  后重试；gateway 实例请经 `/chamber/runtime/restart`（事务化受控重启，刷新
  插件挂载，design 17 §3 / design 18 §3.6）后重试。该错误归属 connections
  插件的 chamber 块（`gitWorktree` 双包探测 + pendingRestart），不进侧栏。
- **一键重启**：connections 插件的 chamber 块（PluginSyncModal）新增"重启
  实例"按钮（**按来源区分重启路径**：ssh 来源 `runServiceOp('restart_service')`
  （systemd IPC）；gateway 来源 `/chamber/runtime/restart`（design 17 §3 /
  design 18 §3.6，已落地）；本地来源走 control-plane
  `restartLocal()`，design 18 §9.3）与 seed 写/补 patch 后的
  "重启生效"（pendingRestart）态；`ChamberInjectionState` 新增 `gitWorktree`
  探测（`probeRemoteChamber` 探 pkg+dist），`remoteNeedsSeed` 条件
  = hostGraph 未(installed&&patched) || 未装 gitWorktree。
  （历史基线；chamber 块已由 PluginDialog 收敛——见 design 21 §6.6 落地状态，2026-12）

### 11.7 仓库组折叠与行内动作揭示修复（2026-09，用户报告）

- **折叠主 checkout = 折叠整个仓库组（用户决策）**：主行折叠按钮点击后，
  同仓库的派生（worktree）workspace 行**整组隐藏**（渲染级过滤，像源折叠
  那样整组收起），展开主行即恢复——各派生行自己的折叠状态保留，恢复后
  原样呈现。实现：纯谓词 `hiddenByMainWorkspaceFold`（`workspace-git-flags
  .ts`，渲染过滤器与拖拽锚点共用）按 `mainWorkspaceId` 归属判定，主行
  `viewPrefs.folded[mainKey] === true` 时跳过其派生行（不写派生行的
  folded 偏好，纯展示派生）。**主行存在性守卫**：主行注册从聚合消失（外
  部删除）而旧 folded 偏好残留时，谓词要求主行仍在列表中——消失的主行没
  有折叠钮可点，派生行不得被锁在隐藏态（git 快照随后重发布会去掉
  mainWorkspaceId 关联，窗口有界且自愈）。隐藏行不携带破坏性在途状态：
  git saga 进度/错误经 coordinator 源级条带浮现、sidebar 行错误展开后
  原样恢复。派生行不得排到主 checkout 之前的拖拽钳制不变；**折叠态拖放锚
  点**：派生行隐藏期间，任意可见行的 after 半区落点会跳过其后被隐藏的派
  生行、锚到下一可见行（与标记/视觉一致，纯谓词复用保证视图与提交不漂
  移）——想插到主行与派生行之间需先展开该组。未注册 worktree 块（Plan A）
  与主未注册（无主行可折叠）的派生行不受影响。
- **行内动作揭示 pointer-safe（消除折叠行常驻动作图标）**：git occupant
  （主行「分支+」创建 / worktree 行删除）、计数徽标与**折叠字形交换**
  （workspace folder/branch ↔ chevron、source monitor ↔ chevron、rename 期
  抑制）的触发从 `:focus-within` 统一改为 **`:has(:focus-visible)`**
  （hover / kebab 展开 / 键盘焦点三种触发不变）。原因：Chromium 在
  mousedown 时聚焦被点按钮，点击折叠钮后焦点留在行内 → `:focus-within`
  持续命中 → 鼠标移开后折叠行右端仍常驻「计数徽标 + 动作图标」（主行=
  分支图标、worktree 行=删除图标）、行左端折叠字形也停留在换出态
  （chevron），且计数徽标不再贴行尾、各行数字右缘间距不一。统一后鼠标
  点击在行上不留下任何 hover 态残留（折叠方向在 hover / 键盘焦点 / kebab
  展开时显示，行左端字形常态回到身份图标），键盘 Tab / Enter 的
  `:focus-visible` 揭示与悬停换入完全保留；计数徽标在同一揭示状态下与动
  作原位换出（换入/换出成对）。
- **计数徽标右对齐**：`.workspaceCount` 由 `text-align: center` 改为
  `right`——徽标内容盒 `min-width: 16px` 的钳位使居中数字的右缘随位数
  浮动（1 位数字距徽标右缘约 10px、2/3 位约 5-6px），右对齐后不同位数
  （1/2/3 位）的数字右缘共享同一 x，消除各行计数距右侧间距不齐；hover
  原位换出规则不变。
