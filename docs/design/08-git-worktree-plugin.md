# 08 · Git Worktree 独立插件

> **状态：现行（v1 实现，Design 17 迁移期保留，2026-12）**——Git 执行在每个 dsh
> 实例内的 chamber host plugin；会话创建/打开和工作区注册仍只走 dsh 现有 wire。
> Design 17 的 gateway Git offload 是待实机稳定的替代路线；在其通过 canonical
> path、补偿 provenance、真 dsh/worktree 冒烟与回滚门禁前，本插件不得停止 seed、
> 不得删包。两条路线的记录不互相冒充权威。未完成门禁见 docs/progress/STATUS.md。

## 1. 边界与部署形态

**原则：Git 只是会话工作区的实例内扩展，不是控制面或 Desktop 的新执行面。**

五条边界理由（每条都是当前约束）：

1. `TransportExecAction.run`、SSH `run`/`write-file` 与 manager payload 涟漪已由
   设计 13 完整落地；不得再扩一次接口形状。
2. SSH 注册用户不保证等于 dsh systemd 进程用户。工作区权威属于
   dsh 进程的文件系统；Desktop 不能用另一用户的 namespace 冒充它。
3. OpenSSH 会把远程参数再交给 shell 解析。本地 `spawn("git", argv)` 的参数
   安全性不能直接类推到 `ssh host git ...`，含空格/引号路径也无法可靠往返
   ——因此 Git 不在 Desktop/SSH 侧执行。
4. `workspace.create` 返回 `{workspace, created}`，`session.create` 支持调用方
   预分配 id 与幂等重试：两者是补偿型 saga（§4/§5）必需的事实，wrapper 不得丢弃。
5. `requestOpenSession` 是无 ack 的前端通知，归档又是不可逆的全局隐藏；因此
   「打开失败就回滚工作树」和「先归档再删工作树」都会破坏已持久化的会话事实。

```text
┌─ @dsh-chamber/dsh-chamber-client-ui-git ────────────────────┐
│ sidebar.workspace.git 座位、拓扑、创建/删除 saga、30s 单飞协调器     │
└──────────────────────────┬──────────────────────┘
                           │ 每实例反代 + dsh 现有 unary
                           ▼
┌─ @dsh-chamber/dsh-chamber-seed-git-worktree ────────────────┐
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
  已有消费者数早已超过“第三个”；中性 shared 抽包是独立机械重构，
  不伪装成本功能的里程碑。
- **v1 明确不做**：commit/diff/stash/fetch/push/PR，也不新增任意 Git 终端。
  独立面板座位（`sidebar.git`）与其面板功能、Worktrees 管理页属远期二次开发；
  Git 事实不进行内聚合（§3.2）。

## 2. Host Remote 契约

namespace 固定为 `gitWorktree`：

| 方法 | 语义 |
|---|---|
| `snapshot()` | 从 `workspaceRegistry.list()` 出发找 repo，按 absolute `git-common-dir` 去重，返回 worktree/branch/HEAD/dirty/locked 以及 workspace/session 关联；单 repo/path 错误与完整 repo 并存 |
| `previewCreate(input)` | 验证 repo id、本地分支、目标 parent/basename 和当前 HEAD，返回短期 capability token；preview 不是最终授权 |
| `create(input)` | 在 common-dir mutex 中重新验证；`operationId` 合并重复请求，响应丢失时同 id 返回同一结果 |
| `rollbackCreate(input)` | 仅对本 operation 创建、尚未被 workspace 注册、身份未变且 clean 的 worktree 有效；不用 `--force` |
| `remove(input)` | fresh 对账后仅删除权威 worktree list 中的 linked worktree；主 checkout、locked、身份变化都拒绝；关联 running agent 拒绝，**但已归档（或其祖先已归档）的运行中会话不阻塞**（§5.2；删除不触碰任何会话）；dirty 默认拒绝，仅当 `discardChanges: true`（对话框显式勾选，§5.3）时以 `git worktree remove --force` 移除；不删分支（除非显式 `deleteBranch`，§5.3） |

RPC 只接受领域 operation，不接受任意 Git argv。所有 mutation 的锁键是
canonical common-dir，不是 renderer 提供的 repo path。

Typert carrier 会把普通业务异常归并为 `internal`，所以 gateway 的五个方法都在
carrier success 内返回第二层领域 envelope：`{ok:true,value}` 或
`{ok:false,error:{code,message,retryable?,details?}}`。客户端必须同时验证两层
envelope，并对每个方法的 success value 做运行时 shape 与请求相关性校验；路径、
operation/workspace/repo/worktree id、branch 或 HEAD 任一错配都不得推进 workspace、
session 或 delete 副作用。

### 2.1 快照字段与容量

- **行字段**：除 worktree/branch/HEAD/dirty/locked 与 workspace/session 关联外，
  每行携带 `status`（ready/missing/invalid/not-a-repo：路径缺失、status 报
  "not a git repository"、其它 status 失败）、`headState`
  （branch/detached/unborn：unborn = porcelain 全零 HEAD + branch ref）、
  `attention`（从工作树 git-dir 的 MERGE_HEAD/REBASE_HEAD/rebase-*、
  CHERRY_PICK_HEAD/REVERT_HEAD/BISECT_LOG 探测，经注入的 fs 抽象，
  尽力而为）、`upstream`/`ahead`/`behind`（本地 ref 事实，永不 fetch）。
  客户端解码强制校验这些字段（对旧 host 包 fail-closed）。
- **孤儿 workspace（`orphaned` 是客户端投影，不是快照行字段）**：注册 workspace
  的路径不可解析时，host 在快照 `errors` 里加一条**逐行诊断**错误项——路径消失
  是 `path-unavailable`（`GitWorktreeError` 码），非 `GitWorktreeError` 的**兜底
  码**是 `workspace-path-failed`，两者都带 `workspaceId`；客户端
  （`packages/dsh-chamber-client-ui-git/src/shared/coordinator.ts`）据此把该
  workspace 的 flags **合并**为 `orphaned: true`（保留既有 worktree 身份），
  行显示"已消失"徽标。
- **running 投影（加性）**：`runningSessionIds` 仍是**全部**运行中会话
  （展示事实）；`blockingRunningSessionIds` = 其中**非 INERT** 者（§5.2）。
  只读旧字段的客户端保持保守（任一运行中即阻塞）。
- **状态事实不进行内**：status/headState/attention/upstream/ahead/behind 保留在
  快照，用于删除门控（阻断原因进 title/aria）与未来的 Worktrees 管理页。
- **容量与预算**：Snapshot 共用一个 in-flight：20 秒是 probe launch/Git budget，
  25 秒是对客户端的 wall response deadline；最多 128 workspace、64 repo、
  每 repo 128 且全源合计 256 worktree、16K session memberships。running agent
  cwd 每轮至多 canonicalize 一次；超限/超时返回显式 source error 与已有局部
  事实，不伪装成健康空结果。Node 的既有 FS await 无法安全取消，25 秒时旧 scan
  可在后台继续，但它真正退出前 single-flight 不释放，后续 poll 复用 deadline
  结果，绝不启动重叠扫描。
- **幂等记录 TTL**：preview 最长保留 5 分钟；create/remove operation 最长保留
  24 小时。容量压力下只可淘汰从未进入 mutation、没有外部 effect/provenance 的
  最老 `ready` 记录；`created/uncertain/rollback-uncertain/removed` 等 tombstone
  在 TTL 内不得提前淘汰，否则宁可 fail-closed `operation-capacity`。进程重启会丢
  内存幂等缓存，因此恢复仍以 fresh registry + Git topology 为权威，绝不依赖缓存
  作为安全凭据。
- **发现缓存**：create/remove 提交后必须使该仓库的发现缓存失效（否则新 worktree
  在缓存 TTL 内不可见）；快照每 repo 每轮只跑一次 `show-ref`，branches 从该次
  结果消费（不重复 spawn）。仓库级快照失败时保留（keep）上一快照，flag 不闪失。

### 2.2 worktree 根与分支解析

- **统一 worktree 根**：所有 chamber 创建的 worktree 落在
  `<DSH_HOME>/worktrees/<仓库名>-<sha256(commonDir) 前12位>/<目录名>`——
  集中、跨同名仓库无冲突、完全在仓库工作树外（git status 不受污染）；
  host 自动 mkdir（fs 抽象含 mkdir）；DSH_HOME 缺失兜底 ~/.dsh；
  构造期校验绝对路径。
- **来源分支（startRef）**：新分支从所选本地分支 HEAD 起（`localBranchHead`
  解析为精确 commit 钉死为 baseHead，create 复验——比仅传 ref 名更严格）；
  缺失报 `branch-not-found`；解析层必须放行并保留 `startRef`
  （`parsePreviewInput` 不得丢弃该字段，否则一选来源分支即 `invalid-input`），
  再做 safeBranchName 校验；`localBranchHead` 非零退出且为「分支不存在」
  （exit 128）时按 null 返回，不当作硬错误。
- **upstream/ahead/behind**：快照 status 加 `--branch`（白名单固定形状），
  `parseBranchLine` 解析 `## b...u [ahead N, behind M]`；数字基于本地 refs
  （永不 fetch，如实）；脏检测 = 「表头之后有内容」。

### 2.3 Git 子进程约束

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
- **argv 白名单的额外形状**（每一条都是精确文法，不接受其它形态）：
  `worktree remove --force -- <abs-path>`（`--force` 不能以任何其它形态混入）、
  `branch -D <branch>`（仅经 §5.3 的显式授权）、`show-ref --heads`、
  `status --branch`、`worktree list --porcelain -z`。

### 2.4 拓扑与缺失记录

- `topology()` **宽容缺失行**：目录已删的 worktree 行保留 RAW 归一化记录路径并
  标记 `missing`，不使整个 topology 抛错。缺失行不得被任何文件系统探测触碰
  （dirty/attention/running）；身份/重复路径/main/locked 判定照旧。该宽容是
  mutation 可用性的前提——硬 `realpath` 曾让单条残留记录锁死该仓库的**所有**
  mutation（preview/create/rollback/registered+unregistered remove）为
  `path-unavailable`，而快照路径有自己的宽容循环（行照常显示为 missing）。
- 主 checkout 不会缺失（其缺失即仓库不可达 → not-found）。
- 提交前复查对 missing 行免 dirty/submodule 探针；注册重放与提交前复查同样不对
  missing 行新增 status 探针（受测：锁内 preflight 后消失、最终 topology 读时
  消失、注册重放目标消失三种窗口）。
- host 包缺失/未生效必须显式错误（§6.3），不把“没有执行面”伪装成空仓库。

## 3. 客户端插件：座位、数据流与呈现

### 3.1 座位与协调器

座位是 **`sidebar.workspace.git`**（per-workspace 上下文座位）：sidebar root 对每
来源渲染两次——`workspaceId === ''` 的源级警示条（恢复/动作错误，挂在工作区列表
上方）与每个 workspace 组头部行内的 occupant（**workspace 行本身就是 Git 表面**，
没有独立 git 行）。独立面板座位 `sidebar.git` 不存在（面板功能属远期二次开发）。
源级警示条只承载 recovery/actionError；snapshot 安装类错误**不进侧栏**（归属
connections 插件的 chamber 块，§6.3），not-loaded 源退化为普通无 worktree 视图。

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
- RPC 超时 60s（`RPC_TIMEOUT_MS`）：**高于**反代 upstream idle timeout（45s）与
  host 的 git mutation 预算（30s）——浏览器绝不能在 host 仍合法工作时中止，
  否则已提交的 mutation 会被误读成「结果不明」；反过来，Typert 业务错误是
  确定性判定（不重试），只有传输/超时/无效响应才进入「不确定」分支（§6.2）。

Git 事实不加进 App 的 session aggregate，v1 徽标只在 Git 区内；普通
10s `requestRefresh` 不触发 Git status。未来全屏功能必须新增通用页面
slot，不由 renderer App 直接 import 领域组件。

### 3.2 workspace 行呈现与行内动作

- occupant 渲染进 workspace 头部行内（title 与 rowActions 之间）。**行内不渲染
  分支 chip**：worktree 行 rest 态行尾只保留计数徽标，分支身份随行 hover / 键盘
  焦点 / kebab 揭示的动作与工作区管理对话框呈现；主 checkout 也不显示 chip
  （root 组只显示项目名）。行内动作图标 16px；空 workspace 的组体显示
  "该工作区暂无会话"提示行。
- **行内动作揭示 pointer-safe**：动作按钮的样式钩子是 **`data-git-action` 属性**
  （主行「分支+」创建 / worktree 行删除，`SidebarWorkspaceGitLine.tsx:387,400`），
  由 sidebar 侧的 hover / `:has(:focus-visible)` / kebab 展开
  （`.rowActionsVisible`）三条规则揭示（`sidebar-chamber.module.css:958-960`，禁用
  态 `.42` 同钩子见 974-976），occupant 自身也在 `:has(:focus-visible)` 下按同一
  钩子揭示（`SidebarGit.module.css:192`）。**不用字面量类名**：属性选择器不被
  CSS Modules 哈希，跨包模块才能匹配同一钩子（本仓既有规则见
  `packages/dsh-chamber-client-ui-mobile/src/client/styles.ts:10-20`；
  2026-09-11 upstream-alignment，原 `git-ws-action` 全局类名已退役）。
  它与**折叠字形交换**（workspace folder/branch ↔ chevron、
  source monitor ↔ chevron、rename 期抑制）的触发都是 **`:has(:focus-visible)`**
  而非 `:focus-within`——揭示状态只有三种：hover、kebab 展开
  （`.rowActionsVisible`）、键盘焦点。原因：Chromium
  在 mousedown 时聚焦被点按钮，点击折叠钮后焦点留在行内 → `:focus-within` 持续
  命中 → 鼠标移开后折叠行右端仍常驻「计数徽标 + 动作图标」、左端字形停留在换出态
  （chevron），计数徽标也不再贴行尾。静止时动作 `display:none`（零布局占用、
  移出 Tab 序）；揭示时 chip/计数与动作**成对原位换入换出**；禁用态 hover 保持
  .42。
- **计数徽标右对齐**：`.workspaceCount` 用 `text-align: right`——徽标内容盒
  `min-width: 16px` 的钳位使居中数字的右缘随位数浮动（1 位约 10px、2/3 位约
  5-6px），右对齐后 1/2/3 位数字右缘共享同一 x。
- **折叠区图标交换**：worktree（派生）workspace 的折叠按钮常态显示 **git-branch
  图标**、hover 才换回折叠箭头（展开=向下/折叠=向右，旋转移至 chevron 元素避免
  旋转分支图标）；普通 workspace 常态 **folder 图标**、hover 换折叠箭头。侧栏
  通过共享存储（`shared/workspace-git-flags.ts`，插件发布、侧栏读布尔值——保持
  零 git 类型依赖）感知派生 workspace。
- **图标与字体层级**：两类图标 14px（project 行对等）；workspace 标题
  **14px/600 主色**，**派生 workspace 标题降级次级色**——图标语言 + 墨色阶梯 +
  会话行 26px 缩进构成三级视觉引导；组间距 3px（行高 26px 防 flicker 约束保持）。
- **派生 workspace 行简化**：worktree 行**移除省略号（kebab）与重命名**（双击改名
  同样禁用），hover 只保留**删除**（git occupant）与 **"+"**（新建会话）；行内
  不显示分支名（分支身份由折叠区分支图标 + 目录名表达）。
- **注册/创建后的定位**：dsh registry 对新建 workspace 是 **prepend（头部）**——
  注册流程在提交成功后立即 `workspace.insertBefore` 把新工作树移到其主 checkout
  之后（注册表顺序持久化，重启后仍在组内；失败 best-effort 不回滚已提交的
  workspace）；adopt 的 workspace 标题按分支派生（目录 basename 可能与主同名）。
- **禁止二次派生**：创建入口只在仓库**主 checkout** 行（worktree 行只有删除）；
  创建对话框的来源下拉只提供主 checkout workspace（`createSourceOptions`
  优先 `isMain`）。`isProjectStart` 按 repoKey 级判定。
- **occupant 按钮纳入拖拽尾随 click 抑制**（`suppressClickRef`），与列表行一致。
- **行内事实呈现只到门控与诊断**：行内渲染的是**健康/阻断**信息（`status`
  非 ready 的行显示 unhealthy/missing/invalid 徽标与阻断原因，进 title/aria）
  和未注册块的健康徽标；`headState`/`attention`/`upstream`/`ahead`/`behind`
  **不在行内呈现**（保留在快照，用于删除门控、创建对话框的 unborn 过滤
  [`headState !== 'unborn'`] 与未来的 Worktrees 管理页）。

### 3.3 仓库家族、折叠与拖拽顺序

- **连续家族不变式**：主 checkout 与同仓库派生 workspace 构成**连续家族**
  （main 居首、派生随后；注册表顺序持久）。家族内外不存在按仓库分隔的 CSS 间距
  （各组一律 `.workspaceGroup` 4px 组距）——分组完全由顺序不变式表达。
- **单一纯裁决器** `shared/workspace-drag-order.ts`：marker 渲染 / onDragOver 门 /
  onDrop / 提交四处同源（单测 `workspace-drag-order.test.ts`）：
  - 外部 workspace **不得落入连续家族的内部空隙**（after main / 两派生
    之间等全部 blocked）；
  - 派生 workspace 只能在**自己家族内**重排，且**绝对不得排到主 checkout
    之前**——家族因旧数据已破损时该条仍生效（禁止加深破损；只有 main
    的拖拽能把整组拉回合拢）；
  - 拖动 **main = 整组搬迁**：乐观序直接采用裁决结果，wire 对每个成员
    依次 `workspace.insertBefore` 同一锚点（成员序 = 块序，失败丢乐观
    序并刷新收敛部分移动）；
  - 列表**顶部落点**以显示序首行（override 感知、折叠感知）为界。
- **折叠主 checkout = 折叠整个仓库组**：主行折叠按钮点击后，同仓库的派生
  （worktree）workspace 行**整组隐藏**（渲染级过滤，像源折叠那样整组收起），
  展开主行即恢复——各派生行自己的折叠状态保留。实现：纯谓词
  `hiddenByMainWorkspaceFold`（`workspace-git-flags.ts`，渲染过滤器与拖拽锚点
  共用）按 `mainWorkspaceId` 归属判定，主行 `viewPrefs.folded[mainKey] === true`
  时跳过其派生行（不写派生行的 folded 偏好，纯展示派生）。**主行存在性守卫**：
  主行注册从聚合消失（外部删除）而旧 folded 偏好残留时，谓词要求主行仍在列表中
  ——消失的主行没有折叠钮可点，派生行不得被锁在隐藏态（git 快照随后重发布会去掉
  `mainWorkspaceId` 关联，窗口有界且自愈）。隐藏行不携带破坏性在途状态：
  git saga 进度/错误经 coordinator 源级条带浮现、sidebar 行错误展开后原样恢复。
  **折叠态拖放锚点**：派生行隐藏期间，任意可见行的 after 半区落点会跳过其后被
  隐藏的派生行、锚到下一可见行——裁决器 `hidden()` 走位与渲染过滤共用
  `hiddenByMainWorkspaceFold` 谓词，视图与提交不漂移；想插到主行与派生行之间
  需先展开该组。未注册 worktree 块（Plan A）与主未注册（无主行可折叠）的派生行
  不受影响。

### 3.4 未注册工作树与孤儿 workspace（Plan A：显示全部 worktree）

- **未注册工作树按仓库分散到 repo 组末尾**（名称=目录 basename、与派生
  workspace 一致的行样式：26px 行 / r8 / 名称 14px-600-次级色 + 20px 行内动作钮
  ——2026-09 batch 1 G1 收口，其中 20px 命中 < WCAG 2.2 2.5.8 的 24px 属模块
  图标按钮语言的既有权衡；**2026-09 阶段 3 G1-4 起不再低于 WCAG 2.2 2.5.8**：
  `.headerGitAction` 与 `.unregisteredAction` 视觉盒仍 20px，但用不可见 `::after
  { inset: -2px }` 把命中区扩到 24px（`.headerGit` 的簇间距同步 2px → 4px，保证两个
  24px 盒不相交），见 design 24 §13 第 17 条与 design 06 §7；
  行内动作钮命中区见 `SidebarGit.module.css` 的 `.unregisteredAction`：分支图标 +
  名称 + 健康徽标；非 ready 行的状态胶囊是
  官方 `Tag tone="warning"`（`SidebarWorkspaceGitLine.tsx:208`，官方 11px/17px
  胶囊词汇，本模块只保留占位类 `.unregisteredStatus`）——原先手写胶囊的中性
  填充与行自身 hover 填充同值，指针悬停时整块消失，2026-09-11 upstream-alignment），
  无已注册 workspace 的仓库在列表末尾渲染其未注册块；数据经 flags 存储的每来源
  仓库布局
  （`RepoGitLayout`）发布，侧栏以 `repoKey` 上下文第三次挂载该座位，
  occupant 渲染行与动作（"新建会话"= adopt 懒注册、"删除"= 未注册删除）。
- **未注册删除**：host `RemoveInput.workspaceId` 可选 + `path` 必填，
  git-first 移除保留身份/脏/锁/主守卫，`RemoveResult.next: 'none'` 时客户端
  跳过 workspace.delete 与归档（无会话）；operationId 幂等/重放复用。
- **孤儿 workspace**：快照以带 `workspaceId` 的逐行诊断（路径消失是
  `path-unavailable`，兜底 `workspace-path-failed`）报告；客户端据此投影
  `orphaned: true`（见 §2.1），行显示"已消失"徽标；删除弹专门确认（"工作树已不
  存在，仅删除其注册，会话保留并转未分组"）后仅 `workspace.delete`。
- **竞态**：adopt 前 fresh 快照复核；未注册外部删除自愈消失；注册后外部删除
  进入孤儿流程。
- **注册/删除预检的宽容度**：预检对路径不可解析的无关 workspace 宽容跳过
  （孤儿不再阻塞该来源所有删除，否则 retryable 错误会把来源锁死在 recovery）；
  missing 工作树行按 raw 路径回链 workspace（不双显进未注册块）；
  确定性领域拒绝不铸 recovery（降级 actionError）。

## 4. 创建事务（补偿型 saga）

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

### 4.1 已有 worktree 作为新会话目标（adopt saga）

每个工作树行（含主 checkout）提供「在此新建会话」——**只读采纳式 saga**
（`runAdoptSessionSaga`）：无 Git mutation，`workspace.create` 注册/复用路径后以
预分配 id 提交会话，session 尝试后永不补偿（无 session-delete wire）；失败沿用
同 id 重试，恢复类型 `session-adopt`。UI 对不健康工作树（`status !== 'ready'`）
禁用该入口（`canTargetSession` 门控）。

### 4.2 创建对话框与来源分支候选

- **New Branch / Existing Branch 双 tab**（active-pill）；分支名打开时自动
  双词 slug（10×10 组合，查重：避开已有分支与工作树目录名，8 次重roll）；
  目录随分支名同步直至编辑（"重置为分支名"）；来源分支下拉（本地分支，
  localStorage 按仓库记忆上次选择）；已有分支为**可选框**（host 快照
  `branches`，`show-ref --heads` 白名单新增）。
- **单击直接创建**：无预览屏——客户端内部串行
  previewCreate→createFromPreview（host 校验链完整保留），错误直接显示。
- **创建永不提交会话**：`createSession: false` 显式传入；
  recovery 记录携带 `createSession` 标志，重试尊重原意图（无会话创建重试
  不建会话、不跳转）。existing tab 不得残留 new 模式的建议分支。
- **来源分支候选**：候选 = `sourceBranchChoices()`（纯函数在
  `packages/dsh-chamber-client-ui-git/src/shared/git-facts.ts`）——host 分支表
  原样放行，
  **主 checkout 当前分支可选**（host 侧 `localBranchHead` 把它解析为该分支
  HEAD；**仅当主 checkout 附着在分支上时**才与省略 `startRef` 等价，detached
  时默认 base 是 detached commit）。host 侧 `gitWorktree/snapshot` 经
  `listBranches`（`git show-ref --heads`）下发**完整**分支表，客户端不得再过滤；
  host 表缺失时回退所选仓库自身 worktree 分支
  去重集；unborn（零提交）行在回退集里被跳过（其分支名解析不到 commit，给出来
  只会把空选择器变成必败选择）。不得把主 checkout 分支从候选中过滤掉、也不得
  只把它当占位符——那会让单分支仓库候选必空、并让 localStorage 记过的分支把主
  checkout 分支永久遮蔽且 MenuSelect 无清除项。
- 对话框几何与文案：删除对话框不写长篇说明文字（会话/分支语义由勾选项与确认
  按钮承载），工作树路径用主色（原继承的透明墨色近不可见）；创建/删除对话框宽度
  560px；创建对话框不再有"来源仓库"下拉（入口即确定派生源，内部仍锁定主
  checkout 来源）；字段间距 14px、标签内距 6px。
- **目录重名自动加数字后缀**（`resolveCandidateDirectory`：打开/切换 tab/
  失焦同步/提交时均查重，`name-2`/`name-3`…，host target-exists 仍为最终守卫
  ——已存在目录不得被静默覆盖，一律确定性拒绝）。
- **已知边界**：unborn 仓库 `branches` 必空 + 默认 base 40 零直送 git 且无
  preview 门（代码面已知，实机无此形态）；detached/unborn 主 checkout 一旦记过
  分支，MenuSelect 仍无"回到默认"入口（只影响这两种形态）；host 侧
  `show-ref` 失败静默返回 `[]` 时，new-branch 页签的选择器只剩"已 checkout 的
  分支"且无自由输入回退（existing 页签已有 Input 回退）。非 git 注册工作区不
  渲染入口是**设计行为**，非缺陷。

## 5. 删除事务（不隐式归档）

```text
fresh-preflight -> git-removing -> git-removed
                -> workspace-deleting -> done
                                      \-> workspace-delete-pending (retry)
```

### 5.1 状态机与守卫

- 确认时重拉 snapshot 和 session aggregate；UI 拒绝当前正在阅读的 Session
  （**唯一例外**：该会话是 blank/从未提交的新会话——`currentSessionIsBlank`：
  无内容可保护，不构成硬阻断），host 核心拒绝任一关联 running agent
  （**唯一例外**：该会话已归档，或它经 **subagent-origin 边**链到的祖先已归档
  ——§5.2；未归档者与默认行为不变，且删除不触碰任何会话）。
- Git remove 先执行且不用 force（未经显式授权时）。响应丢失后以权威 topology 已无
  该 worktree 为成功对账条件。
- 然后调 `workspace.delete`：它只解注册，会话日志保留并转 Ungrouped。
- workspace delete 失败时保留完整的 `operationId + workspaceId + opaque expected + path`
  恢复项。首次及每次重试 registry delete 前，都先重放 host remove 终态验证：目标仍
  不存在，且 workspace 已不存在或仍为同 path/同 membership、没有 running agent；
  目标重现或 registry 身份漂移一律 conflict，绝不继续 delete。通过后才把
  `workspace/not-found` 视为前次 delete 已提交；不反向重建 Git 工作树，也不隐藏会话。
- v1 不删分支。特别是不使用 `branch -D`（删除对话框的「同时删除本地分支」
  是 §5.3 的显式用户授权例外，与 `discardChanges` 无关）。

这是两个持久化域（Git FS + dsh registry）之间的可重试 saga，不是原子
事务。紧邻 delete 的终态验证只能缩小可控的 TOCTOU 窗口，不能把两次 RPC 变成原子
提交；它也无法感知另一个外部客户端正在查看但没有运行的 idle Session。这些剩余
边界必须显式呈现在确认文案中。

### 5.2 归档感知 running 判据（INERT）

工作树删除**不停、不取消、不隐式归档、也不删除任何会话**（「先归档（含子会话）」
是删除对话框里**显式、默认关闭**的独立勾选项，§5.4）；**运行中的会话仍然阻塞
删除，除非它已归档（或其经 subagent-origin 边链到的祖先已归档）**——归档即
「已了结」，其运行不再挡住工作树删除，而它的停止与内容清理只属于归档管理器（design
24 §5）。

- **判据（宿主侧，`assertNoRunningSessions` / `assertNoRunningAtPath` 共用；
  同一条判据作用于所有 mutation 腿——首次删除、rollbackCreate 的 path 腿
  （`assertNoRunningAtPath(facts.path)`）、以及 remove 的 receipt / reconcile
  重放腿（`assertRemovedWorkspaceReceipt`、`reconcileBoundRemove`）；每条腿都
  重新读归档集合，因此两次尝试之间**取消归档**会立即恢复阻塞）**：
  运行中的会话 **INERT**（不阻塞）当且仅当 `workspaceRegistry.archivedSessionIds`
  含其 id，**或**它经 **subagent-origin 边**链到的祖先在该集合中。
  **lineage 只走 subagent-origin 边**（与 design 24 的 purge tree 同构）：链条经
  **所有已加载 agent**（含 idle）的 `session.header.origin` +
  `session.header.parentSession` 走；只有 `origin === 'subagent'` 的行是 delegation
  子会话。**缺 `origin` 的边是 fork lineage**（上游 `session/fork` /
  `SessionStore.fork` 只写 `parentSession`、不写 `origin`；`packages/api/session-controller/src/commands.ts`
  + `packages/core/session/src/index.ts` 核实）：fork 是**独立会话**，归档它
  fork 自的会话不使其运行 INERT，且 purge tree
  永不含 fork 后代——因此 **fork 边终止链条**（照旧阻塞）。运行中的子代理因此可
  因已归档的根而 INERT。
  **成环规则（与实现一致，顺序有意）**：**先判归档、后判成环**——**不含已归档
  成员的环永不 INERT**（成环只证明 lineage 记录畸形；畸形证据不能放行运行中的
  会话，fail closed）；**环上出现已归档成员则按已归档祖先规则 INERT**（已归档是
  "已了结"的正证，正证优先于畸形证据）。**链条无法解析（父 id 既未加载也未归档，
  或 subagent-origin 行缺父）→ 绝不 INERT，照旧阻塞**（fail closed，不猜）；
  **已归档但未加载的祖先仍然胜出**（父 id 不在 agents 列表但在归档集合里，
  照常 INERT）。
- **默认行为**：未归档的运行中会话报同一 `running-agent` 码与同一消息；
  其余守卫（main/locked/身份/expected/dirty/submodule/
  `assertNoOtherWorkspaceWithin`）一律照旧。
- **集合读取的响亮失败**：归档集合读不到（getter 缺失/非数组
  或读取抛错）→ `state-source-unavailable`，集合元素漂移（非字符串/空串）→
  `state-source-invalid`：snapshot 以响亮 `sourceError`
  返回、mutation 腿直接抛错，**绝不当作空集合**（空集合会把每个已归档会话重新
  变成阻塞项），集合元素也**绝不 `String()` 强转**（强转会把漂移元素伪装成合法
  成员）。该判据**绝不缓存、绝不降级**：每次 `readSource` 都重新读
  `workspaceRegistry.archivedSessionIds`。
  **agent 行的列漂移不在此列**：`origin`/`status`/`cwd` 三列都**逐行**处理
  （`agent-origin-unknown`/`agent-status-unknown`/`agent-cwd-unknown`
  SnapshotError），未知 `status` 按 running、不可解析的 `cwd` 保持阻塞（§6.4）。
- **起因（保留为语义依据）**：归档是**软隐藏**（上游 `archiveSession` 只把 id
  追加进 `archivedSessionIds`），**不会**停止运行；会话卡在 `ask_user_question`
  （agent 相位持续 running）时归档反而让它从侧边栏消失、失去任何停止入口，
  于是工作树既删不掉、归档清理也清不掉。已归档的运行中会话因此不该再挡住工作树
  删除；它的停止与清理在归档管理器里处理。

### 5.3 显式授权：dirty / 子模块 / 删分支

- **dirty 工作树不硬性阻断删除**（用户拍板）：删除对话框列出该工作树有未提交
  更改（host 快照 `dirty` 事实），要求用户勾选「丢弃未提交更改并移除（保留分支）」
  后，客户端才发送 `discardChanges: true`，host 以 `git worktree remove --force`
  移除。**force 只经显式授权**：
  - 分支/提交/HEAD 永不触碰：`--force` 只丢弃工作树工作区文件
    （已修改/未跟踪文件），`branchPreserved: true` 无条件成立；
  - 身份/锁/主 checkout/running-agent 守卫全部保留，force 只放行 dirty。
    `git worktree remove --force` 并**不**绕过 git 自身的锁检查——remove
    的锁 die 需 `-f -f`（force ≥ 2）才放行，单 `--force` 仍被 git 拒绝；
    因此 finalTopology 读取与 git 调用之间被外部 `git worktree lock` 的窄
    窗口内，git 会在**变更前** die 拒绝（属 §6.4 声明的外部 Git TOCTOU
    剩余边界），该拒绝经失败后拓扑复查被改判为确定性错误
    （可关闭、不锁来源），host 层 `worktree-locked` 守卫无条件保留；
  - argv 白名单新增精确文法 `worktree remove --force -- <abs-path>`，
    `--force` 不能以任何其它形态混入（§2.3）；
  - `discardChanges` 参与输入指纹：恢复重放必须携带原值，否则
    `operation-conflict`（明确报错而非静默换语义）；
  - 剩余边界（force 下略更常见）：git 先删**工作目录**（递归），即便目录删除
    失败也继续删 admin entry——若递归删除目录因权限等失败，git 退出非零、
    admin entry 已不在 list——重试对账按"topology 无此 worktree"收敛成功，
    但**目录可能残留**（如实机见过的 `server-side/` 空目录），需用户手动清理；
    收敛语义与 §5.1「topology 已无该 worktree 为成功对账条件」一致，不做
    目录存在性反向校验。
- **含子模块的工作树**：git 自身拒绝不带 `--force`
  的 `git worktree remove` 删除**含子模块检出**的工作树——builtin/worktree.c
  `validate_no_submodules` 在变更前 die（exit 128，"working trees
  containing submodules cannot be moved or removed"），`--force` 是唯一
  绕过（linked worktree 的子模块 gitdir 位于其 admin git dir 的
  `modules/` 下，与 git 判据一致）。host 在最终变更前镜像该守卫：
  - 含子模块工作树未授权丢弃 → 确定性拒绝码 `worktree-submodules`
    （`retryable: false` 显式标记），**不发起任何 git 变更**；对话框（经官方
    `RiskConfirmation`，§5.4）呈现子模块丢弃授权（勾选后 `discardChanges: true`
    → `--force`）——子模块
    工作区文件与 dirty 文件同属「显式授权才丢弃」的一类（gitlink 已提交，
    内容可重新检出），分支/提交/HEAD、身份/锁/running 守卫全部不变；
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
    ——§6.2「UI 保留未决」的有界例外（仅限 host 可证明的变更前拒绝；
    歧义失败与 definitive conflict 行为不变）。
- **可选同时删除本地分支**（显式用户授权，是 §5.1「不删分支」的例外）：
  `git branch -D` 白名单新增，尽力一次，失败如实
  返回 `branchDeleteFailed` 且不阻断已删工作树（结果必须解码上报，不得静默丢弃）；
  target-absent 重放路径同样执行分支删除（`attemptBranchDelete` 三路径）。

### 5.4 删除对话框与文案

- 会话闭包统计 + **会话标题列表**（≤5 + "还有 N 条"，取自侧栏 aggregate）；
  「先归档（含子会话）」是**显式勾选项、默认关闭**（`archiveSessions` 初值
  `false`，每次打开/换目标重置）——**不勾选即不隐式归档/不自动归档**；另可选
  「同时删除本地分支」（§5.3）。
- **dirty**：删除图标不再禁用（仅 dirty），点击进入对话框后显示醒目警示
  （"该工作树有未提交的更改，将被永久丢弃；分支与已提交内容不受影响"）；
  授权由**官方 `RiskConfirmation`** 收集（`RemoveWorktreeDialog.tsx:411`，
  2026-09-11 upstream-alignment；单手势与撤销语义按 2026-09-11 review-fix F1 校正）：
  对话框内不再有勾选框，点「移除」时若尚缺授权先弹出官方风险确认（警示图标 + 同上
  说明 + 自动聚焦的勾选框「我了解这些更改将被丢弃，仅移除工作树（保留分支）」，
  主按钮在勾选前不可用），**该门自己的 Confirm 就地执行这次删除**——一次手势即
  `移除 → 勾选 → 确认`，确认后以 `discardChanges: true` 跑同一条删除路径，不需要
  第二次「移除」。门本身**不**从「还缺哪个授权」推导开关（那个推导在勾选当刻即回到
  空值，门会自灭、Confirm 成死代码）：它由点击「移除」时选定的**授权种类**
  （`discard-gate.ts` 的 `nextDiscardGate`：先 dirty、后 submodule）持有，
  `onConfirm`/`onCancel` 才释放（`RemoveWorktreeDialog.tsx:411-439`）。
  **取消即撤销**：Cancel / 关闭 / 遮罩 / Escape 都会把这次门正在收集的那个授权
  复位为未授权（`onCancel`，`RemoveWorktreeDialog.tsx:425-434`），因此退出确认
  绝不会留下一个"已授权但没删"的脏状态——下一次「移除」重新打开同一门，用户不会
  在事后被静默丢弃文件。授权对话框打开期间删除对话框忽略关闭（两个对话框各自在
  document 上监听 Escape，`RemoveWorktreeDialog.tsx:215-222`）。
- **含子模块**：行事实不含子模块信息，首次删除被 host 确定性拒绝
  （`worktree-submodules`，变更前、`retryable: false`、可关闭、不锁来源）后，
  对话框就地显示警示，点击「移除」重新打开同一官方 `RiskConfirmation`
  （勾选框「丢弃该工作树中的子模块检出」）；勾选后同一 `discardChanges` 授权重试
  → host `--force`
  一步删除（主路径）。终端备选需删除该工作树残留的子模块 git 目录——
  **实测（git 2.50.1）`git submodule deinit -f --all` 不会清空 admin `modules/`，
  守卫依旧拒绝**，文案如实提示。
- **运行中会话**：`blocked === 'running'` 时删除图标不再禁用（与 dirty 同型），
  也**没有勾选框**——删除不询问、也不触碰会话。是否阻塞由宿主的归档感知事实
  `blockingRunningSessionIds` 决定（§5.2）：**未归档**的运行中会话照旧阻塞
  （行标题/aria 用 `runningRemoveTitle` 说明「有未归档的会话正在运行，无法移除；
  已归档的运行中会话不会阻塞，请在归档管理器中处理」），**已归档**的运行中会话
  不阻塞。对话框在存在未归档运行中会话时显示非阻断说明
  （`runningRemoveBlockNote`），另有已归档运行中会话时追加
  `runningRemoveArchivedNote`（不阻塞、不会被停止/删除，归档管理器中处理）。
- **硬阻断（locked/current/unhealthy/status-unknown）保留**（`current` 的例外
  是 blank/从未提交的当前会话——该行 `blank === true`，§5.1）；main/unregistered 仍不可从此入口删除。
- **会话事实拉取失败 = 硬阻断（fail-closed）**：对话框打开时拉取 instance
  snapshot 以枚举将被孤立的会话树；该拉取失败时 `sessionFactsError` 非空，
  `confirmDisabled` 成立——确认按钮禁用并就地显示错误（未知的会话影响不得用于
  一次破坏性删除；与 `runtime-unknown` 同一纪律；该拉取可重试）。这是独立于
  running 守卫的第三道客户端硬阻断，不得被降级为提示。
- **运行中会话文案的三个键与判定优先级**：归档感知宿主用
  `runningRemoveTitle` + `runningRemoveBlockNote`；旧宿主（无
  `blockingRunningSessionIds` 字段）用中性 `runningRemoveLegacyTitle` +
  `runningRemoveLegacyNote`——**不得声称归档状态**（那是编造事实）；另有已归档、
  或位于已归档会话子代理之下的运行中会话时追加 `runningRemoveArchivedNote`。
  `removeBlockReason` 的判定顺序是 **main → unregistered →
  current（blank 例外）→ runtime-unknown → running → locked → unhealthy → dirty →
  status-unknown**：`current` / `runtime-unknown` 都在 `running` **之前**，因此过时
  或「仅已归档」的 running 事实无法绕过二者。
- **未注册行删除**走**应用内官方 `RiskConfirmation`**（`SidebarWorkspaceGitLine.tsx:262`，
  2026-09-11 upstream-alignment；该行原本用原生 `window.confirm`，无法使用 alias
  token）：行内删除按钮只武装确认（勾选框「我了解该移除不可撤销」，主按钮在勾选前
  不可用，每次关闭都重置），确认后才发出移除。该行**仍无对话框授权流**——dirty 沿用
  不对称：移除不携带 `discardChanges`，确定性拒绝 + host 英文提示（终端删除 modules
  目录或 `--force`）。未注册块的
  **missing 行**（§5.5）删除按钮不再硬禁用：行文案明示这是「残留记录清理」
  （等效该记录的 `git worktree prune`，不涉及任何文件或分支），确认文案单独
  措辞；adopt（新建会话）对 missing 行保持禁用。

### 5.5 级联（先归档）、missing 记录清理与收尾

- **删除级联语义**：删除确认时递归枚举（`collectSessionClosure`：
  `parentSessionId` 闭包，环安全）直接 + 全部子会话并显式呈现；文案明示「会话
  保留并转未分组，不删除」。提供「先归档（含子会话）」选项（显式勾选、默认关闭）：
  归档在**任何 Git mutation 之前**执行，任一归档失败即中止且不删除任何工作树
  （显式报错，可重试）。
- **会话闭包是 FORK 闭包，故意不按 subagent 边对齐（勿再改动）**：
  `collectSessionClosure` 的行源是 `fetchInstanceSnapshot`，而
  `instance-api.ts` 在上游就丢弃 `origin === 'subagent'` 行（`session.origin !==
  'subagent'` 过滤），所以该闭包能看到的每条边都是 **fork 边**；**不要**在此加
  subagent 过滤——那会把闭包塌成根集，静默丢掉「先归档（含子会话）」必须覆盖的
  fork。vendor 依据（`dsh-api-session-controller/lib/index.js`）：`fork()` 把源
  header 的 cwd 复制给子会话（`meta.cwd = source.header.cwd`，~:695-700），并经
  `forkWorkspace(source.header)`（:683；按 `workspaceRegistry.list()` 的
  `sessionIds` 定位源所在工作区，:872-883）＋ `workspace.attachSession(childId)`
  （:712-714）把子会话挂到**同一个工作区**——fork 与源共享工作树 cwd 且同属该
  工作区，归档它正是「归档工作区中会话」的语义（不是无关会话）。subagent 后代不在
  该闭包内：它们经 `worktree.sessionIds` 归档，与可见性过滤无关。subagent-only 的
  清理/停止闭包是侧栏的 `sessionPurgeClosure`（读原始 `session/list` 行，根 + 全部
  传递 **subagent-origin** 后代；归档管理器也复用它做闭包式当前会话拒绝），两者
  职责不同，**不可互换**。
- **missing 记录清理（应用内出口）**：目录被手工删除（`rm -rf` 而非
  `git worktree remove`/`prune`）后，git 的管理记录存活于主 checkout 的
  `.git/worktrees/<name>/`（`git worktree list --porcelain` 持续列出，并打上
  `prunable gitdir file points to non-existent location`）。取证细节：真实记录的
  `HEAD` 文件是**裸 commit id**（detached HEAD）——git 只在分支仍被某 worktree
  检出时才拒绝 `branch -D`，detached 记录不阻止分支删除；「目录被直接删除而未走
  `git worktree remove`/`prune`」才是残留的本质。未注册删除预检对
  `path-unavailable` 路由到 `removeMissingUnregistered`——目录不存在则
  从注册 workspace 反查所属仓库（`locateMissingRecord`：逐一 discover +
  `worktree list`，按 RAW 路径与 expected repoId 匹配；孤儿 workspace 跳过
  不阻塞），随后在 common-dir mutex 内复验（`commitMissingRecordRemove`：
  记录身份/locked/main/ghost-workspace raw 相等守卫全保留；无目录则
  dirty/submodule/running 探测天然免检）后执行普通
  `git worktree remove -- <记录路径>`——**实测（git 2.50）对缺失目录 exit 0，
  仅清除 admin 记录，不用 --force**；更老 git 拒绝时走确定性 `retryable: false`
  重分类（原始 git 文本透出），不产生重试环。幂等/重放语义沿用既有对账链
  （`verifyRemovedReplay`/`reconcileBoundRemove` 同路径收敛）；rollback 对被
  外部删目录的操作创建目标同型收敛（身份/main/locked 守卫保留、dirty 探测
  免检、普通 `git worktree remove` 清记录）。目录在
  预检与提交之间**重现**（外部恢复/移回）时确定性拒绝
  `worktree-invalid`（证明未变更，绝不清除已恢复的树）；「目录重现」判定发生在
  锁内 topology 读时刻；紧贴探测与 git remove 之间的
  外部恢复窗口与既有 registered git-first 删除的 TOCTOU 剖面相同（§6.4
  已声明的外部 Git 剩余边界，不扩大）。未注册删除在锁内遇到 topology 解析为
  missing 的行即按 `path-unavailable` **当次**降级残留记录清理（不留到同 id
  下次重试才收敛）；`commitMissingRecordRemove`
  的 registry/ghost 复查在最终 topology 读之前，收窄目录重现判定与 git
  remove 间的窗口。
- **其余不变式**：ghost workspace（raw 路径等于缺失路径）拥有该记录，一律拒绝
  未注册清理（registration-first）；注册侧不变——注册 missing 工作树仍走
  「已消失」徽标与仅注销注册流程（先删注册 → 行转为未注册 missing → 应用内清理
  记录，或外部 prune）；错误码全部落在客户端既有确定性拒绝集合内
  （`expected-mismatch`/`worktree-locked`/`main-worktree`/
  `workspace-registered`/`worktree-invalid`/`worktree-not-found`），
  不产生新的 recovery 死锁类别。

## 6. 失败、并发与安全不变量

### 6.1 不变量

- 渲染层不提供任意路径或 argv 给 mutation；opaque id/token 也不是信任来源，
  host 每次仍从 registry + Git 重新解析。
- 一 repo 一 mutation 链，键是 absolute common-dir；轮询永不重叠。
- Git 子进程 timeout/输出超限时先 kill，但 common-dir mutex 必须等 child `close`
  后才释放；仓库 filter 的更深层后代无法跨平台可靠 group-kill，属于 §2.3 已披露的
  受信配置剩余边界。
- 一个工作区/repo 失败不撤掉其它成功实体。Git 二进制缺失是来源级
  错误；非 Git 工作区不被误报为整源失败。
- 远程与本地运行同一 host 包，所以同一套路径/参数/运行会话守卫生效；
  不存在两套 Desktop adapter 差异。
- 绝不记录命令输出中的凭据/URL；v1 不提供网络 Git 动词。仓库配置的 checkout
  filter 可能自行访问网络，按 §2.3 的受信边界处理。

### 6.2 恢复与未决（recovery）

- 浏览器 recovery 只在当前页面/进程内持有。host 重启或外部 identity 改变可令旧
  operation 永久 definitive conflict；UI 保留未决并阻止同目标新动作，不提供把
  “放弃”伪装成成功的按钮。用户需 reload 后依据 fresh topology 手工核对。
- **有界例外**：host 显式 `retryable: false` 的拒绝 = 已证明变更前
  未动（目标仍在、目录仍在、仍干净，§5.3）——同一删除的未决性已被解决为
  “未删除”，客户端清除该 git-remove 恢复并呈现可关闭错误，不再要求
  无出口的重试；definitive conflict（身份漂移等）仍按上文保留未决。
- **既有残余（非回归）**：脏竞态（git 因树变脏在变更前
  die）因复查的"仍干净"条件不成立而保持 retryable，其恢复重试随后撞上
  确定性 `worktree-dirty`（不带证明标记，恢复保留）——脏需外部清理后
  重试收敛，与 identity 漂移同属"原因可修/需外部核对"的类别。

### 6.3 host 包缺失与一键重启

- **404 = 确定性 `git-host-not-loaded`**（git RPC 404，host 包缺失或未生效）：
  客户端判定为**确定性失败**——不建恢复（recovery 会永久死循环）、不重试，
  文案指引按来源区分重启路径：本地实例请重启桌面端；远程 ssh 实例请在连接设置
  中重新下发 chamber host 包并点击「重启生效」（`restart_service` systemd IPC）
  后重试；gateway 实例请经 `/chamber/runtime/restart`（事务化受控重启，刷新
  插件挂载，design 17 §3 / design 18 §3.6）后重试。该错误归属 connections
  插件的插件管理面（`PluginDialog`，design 21 §6.6），不进侧栏：`ChamberInjectionState` 是按
  注册表包的状态数组（`{ok:true, packages[]}`），`gitWorktree` 是注册表行探针
  （`gitWorktree/previewCreate`，经 `probeRemoteChamber` 逐行探测）。
- **重启入口**：连接卡的「重启实例」按钮按来源区分重启路径（ssh 来源
  `runServiceOp('restart_service')`（systemd IPC）；gateway 来源
  `/chamber/runtime/restart`（design 17 §3 / design 18 §3.6）；本地来源走
  control-plane `restartLocal()`，design 18 §9.3）；seed 写/补 patch 后的
  「重启生效」（pendingRestart）态由 `PluginDialog` 承载。
  `remoteNeedsSeed` 条件 = 宿主图包未 (installed && patched)，或 gitWorktree
  行未安装。

### 6.4 已接受的残余

- **pre-#1569 的 subagent 行没有 `origin`**：没有判别子可用，只能按「非
  subagent-origin」处理 ⇒ 该边终止、会话照旧阻塞（fail-closed，且与上游一致：
  缺 `origin` 的上游同样无法证明是 delegation 子会话）。代价是这类历史子会话不会
  因已归档祖先而 INERT，其停止/清理需在归档管理器或会话侧处理。
- **来源面漂移分两类**：agent **行**的列漂移**逐行**处理并留响亮诊断——
  `origin` 值（`agent-origin-unknown`）、`status` 值（`agent-status-unknown`，
  按 running 读取）、`cwd` 值（`agent-cwd-unknown`；该行位置未知，故在严格删除
  腿上以 `running-agent-cwd-unavailable` 拒绝任何删除，绝不假设它不在目标内），
  都不会拖垮整个域；而**真正损坏的
  来源面**（`archivedSessionIds` 非数组/元素非字符串、workspace 行畸形等）仍让整次
  读取以可重试的 `state-source-*` 失败告终——此时没有任何 mutation 被尝试；若同一
  删除此前已产生「未决（uncertain outcome）」恢复项，该恢复项保留到来源面修好
  为止（用户需按 §6.2 恢复纪律重试或手工核对 fresh topology）。
- **外部 Git TOCTOU**：§5.1/§5.3/§5.5 声明的窄窗口（锁检查、目录重现、递归删除
  失败后的目录残留）只能靠紧邻终态验证缩小，不能消除。

## 7. 工程接线与验证

- host 包与 client-graph 包一起进入本地 profile seed、远程 ready-time seed、
  desktop 打包资源和 loader patch；seed 继续只经已实现的受限
  `run/write-file` 通道。两个 host 包都提交 esbuild `dist/index.js`
  （`@deepseek-ai/*` external）。
- loader id 与 package name 在 profile 中是全局身份：单个 exact 既有 row 复用，
  同 id/异包、同包/异 id 或重复 exact row 都在写包/启动前 fail-loud，不追加出一个
  下一次重启才暴露的 Cordis 冲突。
- client 包是首屏静态覆盖行：Vite aliases、`chamber-entry` apply +
  module factory、`CHAMBER_COVERED_IDS`、`CHAMBER_COVERED_FACTORY_IDS` 必须锁步。
- 专属验证门：`typecheck:git`、`typecheck:host-git`、`test:git`、
  `test:host-git`、`build:renderer`；同时运行
  sidebar/renderer-shell/desktop/control-plane 回归。
- 打包前必须重建两个 host 产物，再拷贝到 desktop `dist/`。
