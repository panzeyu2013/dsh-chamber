# 24 · 已归档会话内容清理（server 行 hover 动作 · 第三个 chamber 宿主域）

> **archiveCleanup 宿主域 + 归档管理器 + purge 后会话列表收敛 + 常驻保留**——本文是
> dsh-chamber「删除已归档会话内容」宿主域（wire `archiveCleanup/{probe,purge}`）、
> 归档管理器交互与 purge 后会话列表收敛的权威契约；未完成门禁见 docs/progress/STATUS.md。
>
> 承接并修订原 `docs/progress/todo/12-todo-archived-sessions.md`（归档单向、不可见、
> 上游无 delete/unarchive wire 的事实核实见 git 历史）；该 todo 的方案 B
> （控制面/主进程特权层直删）继续冻结（STATUS「范围决策」），上游 wire 草案移入
> `docs/progress/todo/upstream-proposals.md` §3。方案以「实例进程内的 chamber 宿主域」
> 替代 B 的位置（理由见 §2）。
>
> 交互锚点 = chamber 侧边栏**服务器分组头行（server 行）hover 操作簇**；
> 执行层 = **新增 chamber 宿主域插件**（实例进程内、宿主权威状态执行删除）；
> 本需求对 chamber 桌面与 gateway 部署的所有来源形态（local / gateway-managed /
> 远程 dsh）统一生效。范围声明：移动端（ui-mobile，无 hover 表面）与侧边栏
> rail/窄栏形态**不在 v1 范围**（§6）；未来需要移动端入口则另行设计（触屏确认流与
> 桌面 hover 不同形）。

## 1. 需求与语义

- 归档在 dsh **单向且不可见**（todo 12 §1 代码核实）：唯一 wire 方法
  `workspace.archiveSession` 只把 id 追加进 registry-global 集合；官方与 chamber
  所有表面过滤归档行；上游无 unarchive / 删除会话 / 归档可见查询。归档会话**内容**
  （会话目录 + 其 subagent 起源子会话内容）永久占用实例宿主磁盘且无清除入口，对
  gateway 服务器部署是可观察的磁盘增长来源。
- 本需求 = chamber 前端（桌面 app 与 gateway 的同一套自研 UI）为每个 server 提供
  **「删除已归档内容」**动作：
  - 语义：永久删除该来源实例上**所有已归档会话的内容**，**级联其 subagent 起源
    子会话的内容**（逐条镜像上游 `sessions.delete` 草案语义，映射表见 §4）；
  - 保护：运行中的会话/子代理整棵子树跳过（fail-closed），绝不删除活动 agent 的
    内容；未归档会话永不触碰；操作不可恢复（确认文案明示）；
  - 幂等：逐会话删除，重复执行收敛为空结果；单会话失败不阻断其余（AGENTS「一个
    失败实体不得抹除或阻断无关完整实体」）；
  - **错误绝不静默**：整体失败与**部分失败**（`ok:true` 但 `value.errors` 非空）都
    必须对用户可见（§6/§8）；
  - **超时 ≠ 失败**：purge 是长任务，客户端超时不取消宿主删除；结果不透明时以
    「可能仍在进行，可稍后重新预览/重试（幂等）」诚实呈现（§5）。

## 2. 契约边界与例外动议

相关红线原文与它们真正约束的对象：

| 红线 | 约束对象 | 本方案如何不触碰 |
|---|---|---|
| 05 §2.2「wire 缺失的方法不做（如删除会话），不发明协议」 | chamber 在**官方 unary 面上**为会话伪造客户端可调协议 | 不在官方 controller 面上加方法；新增的是 **chamber 自有宿主域**（同 gitWorktree 先例），命名空间与官方彻底分离 |
| AGENTS「会话业务是 dsh 前端运行时的事；控制面不消费宿主会话」 | control-plane / desktop / renderer 不得成为会话权威或执行面 | 删除执行体是跑在 **dsh 实例进程内**的 chamber 宿主包（同 design 08 信任模型），control-plane / desktop / gateway 主进程零接触会话内容；客户端只提交「删除已归档」意图，不提供路径、不读内容 |
| todo 12 方案 B 冻结（特权层编辑 workspace.json / 删会话目录） | **进程外**特权层直删：运行中宿主内存覆盖、账目分裂、越权 | 本方案在实例进程内、经宿主 ctx 服务（`workspaceRegistry` 等）读权威状态、经宿主自己的持久化/事件路径执行——不存在内存覆盖问题（§4） |
| OpenChamber 范式「manager 只消费 harness API，不自己动 harness 文件」 | manager 层 | 同理成立：chamber 宿主包运行在 harness 进程内（git-worktree 已是先例） |

例外动议的**边界必须收窄**，边界 1–5 为放行条件：

1. 域只做「已归档集合的内容清除（含级联）」一件事；**不做** unarchive、不做普通
   （未归档）会话删除、不做任何会话内容**检索/导出/投影**、不做字节统计。**唯一
   例外（边界修订，§4 step 5 孤儿清扫）**：registry-global 孤儿清扫的
   **存在性探测**（官方 `sessionPersistence.stat(id)`；0.1.3-alpha.1 起取代已退役的
   `inspect(id)`）会读取并解析该会话工件，用途**仅为**回答「该 id 是否仍有可物化
   内容」这一布尔值（`undefined` ⇒ `false`；**任何抛出/能力缺失** ⇒ `true`，fail-closed；
   两分语义见 §13⑦）；读取结果**不进任何返回面、不进日志、不落盘**，只被消费于「该成员是否
   可移出归档集合」这一个成员关系判断。该例外**不扩展**本域内容接触面（无标题/
   路径/正文投影，无检索/导出，无字节统计），也**不构成**新能力的先例（见第 5 条）；
2. 域无读取面：`purge`/`probe` 不返回标题/路径/内容投影（purge 只回计数与逐项错误码）；
3. 删除语义逐条镜像上游 `sessions.delete` 草案（todo 12 §5.2，逐条映射表见 §4），
   **不发明新语义**；上游 wire 落地后本域收敛退役（§11），chamber 不永久 fork 会话域；
4. 该域随 chamber 分发并 seed 到所有实例形态（本地 spawn overlay、远程 dsh
   ready-time seed、gateway managed dsh 桌面同步 seed），任何形态下管理器进程都不
   获得新的会话接触面；
5. **本例外不构成其他会话域动议的先例**：任何新的会话域能力（unarchive、普通删除、
   内容读取、字节统计…）都必须重新走一次例外动议评审，不得援引本设计背书（边界 1
   的存在性探测例外已按本程序单独批准）。

## 3. 宿主域契约（wire）

新宿主包（结构镜像 `packages/dsh-chamber-seed-git-worktree`，含构建期生成的
esbuild 产物 `dist/index.js`；不提交）。**命名**：scoped name 沿用两既有宿主包先例
（`@dsh-chamber/dsh-chamber-seed-client-graph`、`@dsh-chamber/dsh-chamber-seed-git-worktree`
——旧的 `dsh-chamber-host-*` 目录前缀已退役，包名/目录均为
`dsh-chamber-seed-<loader-id>`）：包名
`@dsh-chamber/dsh-chamber-seed-archive-cleanup`，目录
`packages/dsh-chamber-seed-archive-cleanup/`（与 scoped name 对齐，避免第三种命名制）。

- loader insert：`id: archive-cleanup`（loader id 全局唯一，见 cordis-inserts 冲突规则）
- cordis 注入：`static inject = ['workspaceRegistry', 'agents', 'sessions',
  'sessionQuery', 'sessionPersistence']`（**5 个服务**——`sessions`/`sessionQuery`
  供运行位与血统事实，`sessionPersistence` 供内容
  定位与存在性判定，缺任一即 `host-binding-pending`/`registry-unreadable` fail-closed）
- wire 命名空间：`archiveCleanup`（camel，两段式端点）。可达性：控制面反代对
  `/api/i/<id>/api/*` 全量透传、无方法白名单（`instance-proxy.ts`）；gateway 默认代理逐字
  转发非管理 `/api/*`（`dispatch.ts`/`gateway-proxy.ts`）——桌面侧
  `/api/i/gateway-<id>/api/…` 与 gateway 托管 UI `/api/i/local/api/…` 均到达同一宿主面，
  **反代零改动**。

```
archiveCleanup/probe({})          → domain { ok, value: {} }
                                       // 零成本激活探针端点（presence+协议，无 IO）
archiveCleanup/purge({})          → domain { ok, value: {
                                       deletedSessions: number
                                       deletedSubagents: number
                                       skippedRunning: number
                                       skippedLoaded: number   // 仅因已加载被跳过、本次未删（仍留在归档集合）
                                       forcedLoaded: number    // 因 force 授权而「带着已加载成员」删掉**内容**的根数
                                       residentRetainedRoots?: string[] // 常驻保留修正：内容已删除（或本就
                                                                 // missing）、但因会话仍常驻本进程而**保留归档成员关系**的
                                                                 // 树根 id；仅 >0 时出现（客户端据此给管理器行加标注）
                                       skippedProtected: number // 子树闭包含 protectSessionIds（调用方正在查看的
                                                                 // 会话）而整棵跳过的根数；protect 优先于 force
                                       errors: { sessionId, code, message }[]
                                       truncated?: true        // errors 截断标记（>1,000 条）
                                       // registry-global 孤儿清扫计数，仅 >0 时出现；只清集合成员、
                                       // 不删内容，故不进 deletedSessions/Subagents
                                       clearedOrphanMembers?: number
                                     } }
// purge 亦可带可选子集过滤：
archiveCleanup/purge({sessionIds}) → 同上（sessionIds 仅收窄候选集）
// purge 亦可带可选 force：force 只放过「本进程已加载
// （idle/attached）」子树，running 永远拒绝。
// purge 亦可带可选保护集（保护修正）：protectSessionIds 命名的 id 及其
// 子树闭包不得触碰，**优先于 force**，并排除出孤儿清扫与集合移除；无兼容回退
// ——旧宿主按 §8 的「重启实例」口径处理。
archiveCleanup/purge({sessionIds?, force?, protectSessionIds?}) → 同上
```

- 入参：`probe` **零参**（envelope `payload: { args: {} }`——
  `gitWorktree/snapshot`/`clientGraph/graph` 先例）；`purge` 带**可选** `sessionIds`
  JSON 参数（SRC 描述符对缺失 JSON 字段放行 → `undefined` = 全量）与**可选**
  `protectSessionIds`（保护集，保护修正新增）两个 JSON 参数，客户端照 §5 恒发
  `{args:{sessionIds:[…], force:true, protectSessionIds:[…]}}`。可选参仅限唯一标识符
  （无解构/默认值/rest——gateway SRC 签名约束，方法签名不得含默认值）。
- **可选子集过滤语义**：`undefined` = 全量（向后兼容）；数组 = 只把列出的 archived
  集合成员当作候选根（各自整棵可删子树）。**越界结构性不可能**：候选恒 = 权威
  archived 集合 ∩ 请求（core.ts 读时取交集），已离开集合的陈旧 id（并发 purge/陈旧
  列表）静默跳过（幂等），非 archived 会话不可达；过滤校验失败（非串/空串/超
  `MAX_PURGE_SESSIONS`）→ 业务码 `invalid-request`（全量路径容量码 `purge-capacity`
  语义不变；超容量集合仍可做有界子集 purge）；集合收敛语义同 §4 step 9。
- **可选 `protectSessionIds` 语义（保护修正）**：与 `sessionIds` 同规校验
  （非空串数组、≤ `MAX_PURGE_SESSIONS`，畸形 → `invalid-request`，先于任何权威
  读取）；
  未知/陈旧/未归档 id 无操作。**方向性**：只会**缩小**删除集（命中子树闭包即整棵跳过），
  永不放宽安全守卫。命中计数进 `skippedProtected`，分类**优先于** running/loaded/force
  （既运行又受保护只记 protected）。该集合还排除出孤儿清扫与最终集合移除（纵深防御：
  **只读查看中的会话既不在 running 也不在 loaded 集合里**——客户端打开会话是只读观察
  （`sessionQuery.observeSession`），不 attach 进宿主 sessions store，宿主 loaded 守卫
  **兜不住**它，protect 是它唯一的保护）。
- **可选 `force` 语义**：缺省 = 既有 fail-closed 行为，逐字节不变；`force: true` = 只放过
  「**已加载（idle/attached）**」子树，**running 永远拒绝**（含 force）。改动全落在**删除侧**，
  且是「**先停止、再删除**」，不放松任何安全守卫判据。结果口径按 `skippedRunning`/
  `skippedLoaded`/`forcedLoaded` 拆分（定义见上方 wire 注释）。**归档语义不动**（哪些会话被归档、级联与
  wire 面均保持原样；交互形态改为：归档动词移入会话行
  kebab 菜单、不再弹确认——见 design 05 §2.2 / 06 §7）。
- **常驻保留**：官方会话列表 live 优先（`sessionQuery.listSessions()` =
  持久化重扫 ∪ `ctx.sessions.list()`，见 §10⑤），内容删除后**只有归档集合成员关系遮着
  该行**，清掉它 = 把刚删掉的会话以普通行推回侧栏（F2 权威探针也会列出它）。因此
  **删除瞬间仍常驻本进程（liveness `loaded`，或根自己被 binding 报告 resident）的树，
  归档成员关系一律保留**：整棵树（含被覆盖的 archived 后代）不进 `clearIds`，id 列进
  `residentRetainedRoots`。判据两个来源任一成立即保留：(a) 树级 liveness 重读（force
  路径常见）；(b) binding `deleteSessionContent` 返回的**删除瞬间**常驻位——覆盖「plan 时
  clear、删除前被别的客户端打开」与「后代在树级重读后才 attach」两类竞态（**根或任一
  成员**都成立；只看根会漏后者，自查）。方向单一且 fail-closed：保留只可能让行
  继续隐藏，绝不可能浮出。**幂等**：重跑对已无内容的常驻成员报 `missing`——语料是
  `sessionQuery.listSessions() ∪ persistence.list()` 并集，live 腿在内容删除后**仍克隆供出
  该 header**，故每次 plan 照建该树、报 `missing`、成员关系**再次**保留（客户端文案必须自足，
  见 §13⑳）；实例重启后该 id 才真正「无记录」，孤儿清扫按 G3 `stat` 证明无
  内容而收敛（仍 live 的成员被 live 排除挡在清扫之外，属 fail-closed）。**收敛前提是实例至少还有一条会话记录**：语料为空时 G1a（空语料
  不可信）永久跳过清扫，tombstone 留存（行不存在 ⇒ 用户不可见，每次 run 只多一条
  `archive-set` 注记；§13⑳(a) 已知取舍，真要收敛需另行裁决放行 G3 单 id 探针）。
  **批量写前有一次最终 live 复核**：仍 live 的 id 不写（完成的根改列
  `residentRetainedRoots`、被覆盖后代静默保留），复核读失败则整批不写并记 run 级注记——
  固定写窗口比删除瞬间晚数分钟（含最多 `MAX_SWEEP_CONTENT_PROBES` 次 `stat`），晚窗口内
  attach 的会话否则仍会被摘掉成员关系，可能留下**部分保留**（同树非常驻成员照常摘除），
  方向仍是 fail-closed。收敛时机：被覆盖但**从未 attached** 的后代在**下一次 run** 被孤儿
  清扫摘掉；**仍常驻的成员自身**只在**实例重启后**的某次 run 收敛。
- `purge` 开头重读权威状态；管理器列表**不来自本域**（来自会话快照投影的
 archivedSessions，§6），UI 文案避免
  「恰好 N 个」暗示）。
- **已归档集合在 purge 开始时一次性快照**（`archivedAtStart`，core.ts）：run 期间不再
  重读——用户中途「取消归档」某成员，本次 run 仍按快照当已归档处理（可能已删或已清
  标记），**宿主是权威**，不因客户端视图变化而中断；反之 run 期间新归档的成员不进入本次
  候选集。单飞（`busy`）保证同进程内不会有两个 run 同时改集合。
- 返回值走 `domainResult` `{ok,value}|{ok:false,error}` 载体（generic gateway 不保留
  thrown business 字段，同 git-worktree 理由）。`ok:false` code 枚举（最小集）：`busy`
  （本域另一 purge 在途——**宿主侧单飞**，跨 N-ctx 并发 purge 靠它收敛）、
  `registry-unreadable`（整体前提失败；probe 的 `assertHostSurface` 结构检查亦覆盖会话
  枚举/存储面——把官方 `sessionPersistence.stat` 列为必备面，**最低宿主版本
  0.1.3-alpha.1**（`stat` 取代退役的 `inspect`），更旧宿主上 `archiveCleanup/probe` 恒
  `ok:false` ⇒ 激活门 observe→fail（可触发自动回退），
  运行期降级与能力门的分工见 §13⑪）、`host-binding-pending`（§10 宿主能力尚未接线——域未启用，非重试）、
  `purge-capacity`（archived 集合超过单次上限 65,536——**不可重试**（`retryable: false`），
  无逃生口直至上游 wire 收敛，见 §13）、`invalid-request`（子集过滤畸形/超限——非重试，
  过滤校验先于任何权威读取）。逐项失败收进
  `value.errors`（item code：`missing` 内容已不在 / `running` 删除瞬间转入运行（竞态）/
  `loaded` 已加载但未授权 force / `storage` 宿主存储失败；最终批量写失败记
  `archive-set`），不中断、不 throw；`errors` 超过 1,000 条截断并置 `truncated: true`
  （core.ts 常量 MAX_PURGE_SESSIONS / MAX_PURGE_ERROR_RECORDS）。
- **容量口径**：容量门按权威 archived 集合成员总数计（registry-global，含被归档的 subagent 起源行）；上限 `MAX_PURGE_SESSIONS`）；`archive-set` 注记与逐项错误共享同一
  条目上限（MAX_PURGE_ERROR_RECORDS）。
- **宿主审计**：purge 起止行走实例 logger（`[archiveCleanup] …`）。purge 是产品
  唯一的持久内容销毁原语、local 匿名 loopback 也可到达——**UI 确认只是点击保护，wire 本身
  才是信任边界**（与官方 archiveSession wire 同一条边界）。
- `probe` 是**零成本激活探针端点**（presence + 协议、不读会话数据、无 IO、响应与会话量
  解耦）；`assertHostSurface` 对已挂载但结构异常/面缺失的宿主答 `ok:false`（域在位但异常
  = fail-closed，同 git-worktree 的确定性业务拒绝）。
- **404 语义**：宿主对未认领方法答 404（vendored gateway unclaimed-route 行为，
  ssh-provider/gateway 均有注记）= 域未挂载/宿主包未加载/版本过旧；客户端处理（含
  **不做 legacy 回退、不静默降级**的裁决）见 §5。

## 4. 宿主内算法与守卫

纯核心 `core.ts`（fixture 驱动单测，同 git `core.test.ts` 模式——不依赖
vendor 源码）+ 薄 Remote 门面（`index.ts`），编排逻辑：

1. **候选集**：每次 purge 从权威 `workspaceRegistry` 重读 archived 集合
   （registry-global，todo 12 §1）与各 workspace 账目；**孤儿 id**（成员关系消失或
   内容已不在）按 missing 幂等跳过。性能契约：**单遍快照**（候选 + 各自 cwd）逐成员
   用快照 cwd 做 O(1) 直删，每树仅**一次** live 重读；无 cwd 成员的逐删全库重列是
   稀有路径（代码注释登记）；`resolveDeletableTree` 用显式栈迭代后序，消除递归深度
   = 链深的风险；
2. **级联枚举**：对每个已归档顶层会话，按 `parentSessionId` 链枚举 subagent 起源后代
   （等价于 `packages/dsh-chamber-client-core/src/subagent-lineage.ts` 的 `indexSubagentDescendants`，但基于
   权威存储而非投影）；可枚举性（含 header 索引对归档行/子会话的可见性）见 §10。header
   读取走 `assertHeaderShape` **逐字段**（id/cwd/parentSession/origin）loud 校验：字段
   漂移记 fail-loud `registry-unreadable` 并点名会话与字段——**绝不逐条静默跳过**而把级联
   清空（该谓词严格弱于 pinned vendor 写入期校验——origin 仅 absent/'subagent'、cwd 恒非空
   绝对串、parentSession 恒字符串，vendor 自身拒绝损坏行，故无真实数据误伤面）；
3. **运行保护**：任一节点是 live agent（`ctx.agents`）→ 整棵子树跳过并计数
   `skippedRunning`；仅**已加载（idle/attached）**者计 `skippedLoaded`，可由调用方
   显式 `force` 放行（§3/§5）；运行位事实来源见 §10。**运行是唯一硬底线**：`force`
   也**不**放过 running（活跃 writer 会在删除后经 `open(path,"a")` 重建无头残档）
   ——客户端因此在删除前先 `session/cancel` 停回合（§5），归档动作本身也停一次。
   **live facts 读取面 fail-loud**：agents 条目/状态与 live store
   （`ctx.sessions.list()`）的**数组形状与条目 id** 任一漂移都拒绝整次读取
   （`registry-unreadable`，一个字节都不删），同 `listSessionStates` 的「did not answer
   an array」政策——静默丢弃条目会把 loaded 守卫与常驻保留判据推向**不安全方向**；
3b. **保护（保护修正，先于 3 分类）**：候选根的**子树闭包**与运行期
   `protectSessionIds` 相交 → **整棵跳过**并计 `skippedProtected`（优先于
   running/loaded/force，见 §3）。`core.resolvePlan` 先算闭包、再判保护、最后判
   liveness；删除循环开始前**再查一次**（plan 出错时也绝不部分剪枝——前缀删除不可回滚）；
   `binding.
   deleteSessionContent` 拿到同一集合，命中即 `protected` 拒绝（最后一道不变量守卫）；
   清扫候选与最终 `clearIds` 同样排除 protect。**该集合由客户端提供**（它知道自己在显示
   哪个会话），宿主在**全量语料**上做闭包判定（旧客户端自证闭包 pre-flight 门因此整体
   删除）；

4. **删除顺序（崩溃一致性）**：**children-first**——先删 subagent 起源后代、再删顶层会话
   目录；**archived 集合成员最后移除**（顶层 id 在整棵删完前保持 archived，崩溃后续跑才能
   重新枚举到残留后代，不产生清不掉的孤儿）；完成树覆盖的**已归档后代成员**（archived 集合
   中的 subagent 行）随同一次最终批量写清除，无跨轮 marker 滞后；
5. **registry-global 孤儿清扫**：每次 purge 与候选集过滤**正交地**再清一遍**整个归档
   集合**里无会话记录的成员（旧版遗留 / 最终写失败产生的「无目录成员」，管理器只列
   「行 ∩ 集合」故永不可达）。零新增删除语义：孤儿无内容，唯一操作是移除其集合成员
   关系；有记录的成员（含 running）绝不触碰。**fail-closed**：
   - 谓词只在成功枚举后运行，输出只是**候选**——「两次批量枚举都没记录」不构成「无内容」的
     证明（上游枚举会**静默收窄**：jsonl 跳过不可解析/空工件、根缺失返回 []，persistence 未
     绑定时 session-query 只回 live 行且不报错）；
   - 每个候选必须再经**官方单 id 权威读**（`sessionPersistence.stat(id)`；未知 cwd 也按 id
     跨项目目录、跨代际解析）确认：**只有 `undefined` 才清**（上游对「无日志」与「工件不可
     物化」都答 `undefined`，见 §13⑦），任何抛出/能力缺失一律保留成员关系（fail-closed，
     绝不 abort 已完成的内容删除）；
   - 枚举为 `sessionQuery.listSessions()` ∪ `sessionPersistence.list()` 的**按 id 并集**
     （两侧同口径 loud 形状校验；任一侧抛错即整轮拒绝），杜绝「query 侧收窄」丢失记录；
   - 可信度门：快照记录数为 0 而归档集合非空 ⇒ 跳过；确认读记录数从非空塌缩为 0 ⇒ 跳过；
     每次跳过记 run 级 `archive-set` 注记；
   - 候选数受 `MAX_SWEEP_CONTENT_PROBES`（4,096/轮）限流，超限记注记，余量后续轮次收敛；
     清扫 id 与完成树同乘**一次**最终写（去重、仍最后移除），计数独立于
     `deletedSessions`/`deletedSubagents`（`clearedOrphanMembers?`）；集合超过
     `MAX_PURGE_SESSIONS` 时不清扫（该规模全量 purge 本就 `purge-capacity` 拒绝）；仅在
     快照确实含候选时才多一次扫描（已收敛实例保持单次扫描契约）。**空选集不删任何内容，但
     宿主仍要跑该次 run 的孤儿清扫**（清扫与过滤正交）；
6. **执行（分支 b）**：官方进程内**无会话内容删除例程**（§10 #3）→
   `sessionPersistence.locate(header)` 给出官方绝对产物路径，作为**唯一目录锚**；
   目录内**全部不可变代际工件**（`session.jsonl`、`session.vN.jsonl`，含可选
   `.zstd` 与遗留 `.tmp` 发布临时件、迁移暂存件）连同写租约 `session.lock` 一并
   删除，未知条目/符号链接/子目录**整单拒绝**（不半删），目录仅在清空后尽力回收
   （rmdir 非递归）。**一切状态写经宿主自身 setState/持久化原语**，文件写遵守宿主
   原子写纪律；布局知识零复制（依赖 locate/format 官方导出）。可删条目白名单见
   §13⑩。
7. **事件发射**：删除路径调用官方事件发射口（`host/session-removed` 与
   `host/archived-sessions-changed`，todo 12 §5.2 精确名）——宿主内消费者本应据此自愈；
   pinned 树无宿主域可用的公开事件面（§10 #4），故实现为**文档化 no-op**（binding.ts emit
   空实现）；投影刷新链见 §10 #4，不可绕过事件直接改投影。`emitSessionRemoved` 的实现
   契约：失败必须包 `ArchiveCleanupError`（裸 throw 会杀死整轮 purge 且不留逐项记录）；
   删除成功后事件失败的「双重呈现」为接受语义，rerun 经 `missing` 收敛。
8. **逐会话隔离与复检**：单会话失败记入 `errors` 不 throw、不阻断其它树；每会话删除瞬间经
   binding 删除时 live 守卫复检（非 running 才删；`force` 只放行 loaded）——逐成员 O(1)
   running 预检是死代码（整树级 live recheck 已证非 running），**binding 删除时的 live 守卫
   是唯一 mid-window 门**并承载中止语义；同一次读取同时产出**删除瞬间的常驻位**
   （`SessionContentDeletion.resident`），供步骤 9 的保留判据使用；幂等（内容已不在
   = `missing` 跳过；不在 archived 集合 = 不枚举）；崩溃窗口收敛 = 遗留会话仍属 archived，
   下次 purge 续跑清掉。
   **运行窗口 —— 成员失败中止整树**：整棵跳过保证截至每成员的删除瞬间——成员在树内删除间隙
   转 running（binding live 守卫拒删，item 码 `running`）或删除报存储错误时（**首个树内
   失败**即触发），**中止本树剩余删除**：该成员与其未删祖先（含根）保持原样、根保持
   archived，前序已删成员不回滚，本树不进入最终集合移除——根会话记录位于其自身内容目录内，
   越过失败成员删根会让下次 purge 把根当孤儿清出集合、不再重枚举幸存成员（静默内容泄漏，故
   整条祖先链保留待重跑）；下次 purge 从根重新枚举收敛，一棵树的中止不阻断其它可删树。
9. **集合成员移除**：官方**无公开批量裁剪原语**（registry 只有单条
   `unarchiveSession(id)`，见下方 alternatives；无 `unarchiveSessions(ids)`）→ 本域
   需要**一次**写完成批量收敛，故 binding 以文档化结构 seam 执行
   **一次纯 `workspaceRegistry.setState` 的 read-modify-write**：读取官方 live global
   （`registry.state`）后只改本域**唯一拥有**的字段
   `setState({...live, archivedSessionIds: filtered})`，且必须**在官方
   `enqueueOperation` 链内**（与 create/delete/insertBefore 串行，防与
   两阶段删除交错抹掉 marker），官方持久化路径、进程内（todo 12 方案 B 的进程外覆盖
   风险不适用）。seam 带结构守卫（`setState` + live global 为非数组对象）fail-loud
   `registry-unreadable`，并 pin 版本；**boundary 类型对官方字段集合保持不透明**——
   本域对 `WorkspaceDomainState` 的形状一无所知。
   **字段归属铁律（事故锚点）**：官方 `setState` 是**整体替换**（`dsh-storage-domain`
   的 `global.set` 只做 `unit.setGlobal` + 内存赋值，**不跑 `schema.parse`**，故 zod
   `.default([])` 不兜底），因此**任何**在外部重建官方 global 字段表的写法都会在上游
   新增字段时静默丢字段。0.1.7 新增 `pinnedSessionIds`/`defaultWorkspaceId` 即由此复发：
   旧实现写 `{initialized, workspaceIds, archivedSessionIds}` 后，宿主内存态
   `pinnedSessionIds === undefined`，下一次归档在官方
   `archiveSession()` 的 `state.pinnedSessionIds.filter(...)` 抛
   `TypeError: Cannot read properties of undefined (reading 'filter')`，被 api-gateway
   兜成 `gateway/internal`（侧栏降级；Cmd+R 只换渲染进程，宿主内存态仍坏，重启实例才自愈
   ——启动走 `schema.parse` 补默认值）。故 `archivedSessionIds` 之外的字段**一律 spread
   透传**，不得枚举、不得重建。该 spread 同时修正了旧实现的第二个隐患：旧重建会**丢掉
   `pendingMutation` marker**，若在链外执行即抹掉在飞 create/delete 的恢复标记；透传后
   marker 原样保留（链内 `recoverPendingMutation` 仍先于本操作清它）。
   **最终批量写（常驻保留修正后）**：完成树根、完成树覆盖的已归档后代、孤儿
   在同一批官方 setState 写中清除（clearIds 去重；core.ts `purge()` + binding
   `removeArchivedSessionIds`，测试固化）——**唯一例外是常驻保留树**（§3）：该树根与它
   覆盖的 archived 后代**不进 clearIds**，成员关系原样保留，id 列进
   `residentRetainedRoots`。理由同 §3：归档集合在 vendor 即**隐藏集**（`dsh-workspace`
   `archivedSessionIds`: "sessions hidden from every grouping surface"），会话仍常驻本
   进程时摘成员关系就会把刚删掉的会话以**普通行**推回侧栏——「内容
   已删」不构成「必须摘标记」的充分条件。该例外不改变红线段「no unarchive」的
   读法：本域只在其内容删除完成后清除**该已删内容自身**的集合成员，不提供任何恢复/
   浏览/反向操作；A-区（todo 12 方案 A，已归档浏览）若实现，其数据面即当前 archived
   集合（仅含未清理、运行中留存与常驻保留项）。上游 unarchive/delete wire 落地后本域
   退役并按官方语义收敛（§11）。

   **Rejected alternatives（本域唯一官方 global 写入口）**
   - **重建官方字段表**（旧实现：硬编码 `{initialized, workspaceIds, archivedSessionIds}` 再
     `setState`）：`setState` 无 schema 兜底，上游加字段即静默污染宿主内存态（0.1.7
     事故见上）；该写法与 `RegistryDomainState` 镜像类型均已移除。**当前测试即该写法的
     回归闸**：`deepEqual(written, {...写前 live, archivedSessionIds})` 一旦有人重新枚举
     字段就会红，故无需另设字段漂移门禁。
   - **逐条调用官方单条裁剪 `unarchiveSession(id)`**（存在且经
     `api-workspace-controller` 暴露 wire）：**可行**——不嵌在外层 `enqueueOperation` 里
     就没有重入死锁（官方链自己负责串行），且能完全去掉三个私有面。**不采纳**的原因是
     成本与窗口：`MAX_PURGE_SESSIONS`（65536）条 id 即 65536 次串行 durable 写，且失去
     "单次写"对「最后一次 live 复检 → 写入」attach 竞争窗口的保护（§4 step 8）。
   - **上游公开批量裁剪原语**（如 `unarchiveSessions(ids)`）：架构终点，本域届时彻底退役
     私有写（§11）；受上游排期阻塞，作为提案登记，**不在本仓改上游代码**。
10. **跨进程租约**：删除租约即放弃 jsonl 的跨进程互斥（vendor lease 明确警告
    forfeits exclusion），故本域契约要求调用方「**先停运行再清理**」；第二个 dsh
    进程同根写入不在本域可观测范围内（§13⑨）。

**上游草案逐条镜像映射表**（todo 12 §5.2 → 本域承诺 → §10 事实锚点）：

| todo 12 §5.2 语义 | 本域承诺 | 事实/验证锚点 |
|---|---|---|
| 删会话目录（`<sessions-root>/<project>/<id>/`） | §4 step 6 分支 b + 原子写纪律 | §10 #3/#8；core 单测（§9） |
| 级联 subagent 起源子会话 | §4 step 2/4（children-first） | §10 #2/#5；级联/乱序单测 |
| workspace 成员账目自愈（header 索引重建剔除） | §4 step 6 + 官方原语优先 | §10 #1/#3/#8 |
| 从 archived 集合清理 | §4 step 4（最后移除） | §10 #1；幂等单测 |
| 复用 `host/session-removed` 事件 | §4 step 7（文档化 no-op + 收敛链 §12） | §10 #4 |

## 5. 客户端 wire 接入

`packages/dsh-chamber-client-core/src/instance-api.ts`（唯一客户端
接入点，sidebar 插件与 App 层共享）。**现状约束**：`call()` 私有；非 2xx 一律
generic throw（无 status 透出）；503 `instance_unavailable` 有专类特判；默认超时
`DEFAULT_TIMEOUT_MS = 30_000` 且**调用方传 signal 也压不住 30s 上限**
（`AbortSignal.any([timeout, signal])`）。对 `instance-api.ts` 的增量（最小、向后兼容）：

- `call()` 可选参数 `timeoutMs`（默认不变）；可选开关 `notFoundAsDomainMissing`
  （**仅 archiveCleanup 访问器传 true**）。404 判别规则（防双重语义误标）：仅在 404 且
  开关开启时解析响应体——`code === 'instance_not_found'`（control-plane 未知实例 id，
  instance-proxy.ts）→ 保持 generic transport 行为（来源已删/未知，非域问题）；其余 404
  （宿主未认领方法 = 域未挂载/版本过旧）→ 抛 `InstanceDomainMissingError`；
- 新专用错误类 `InstanceDomainMissingError` + `isInstanceDomainMissing()`（镜像
  `InstanceUnavailableError` 模式，放其旁），404 + 开关开启时抛它；wrapper 层据此
  输出 §6 文案；
- wrapper：`purgeArchivedSessions(client, sessionIds?)`（长预算 `PURGE_CALL_TIMEOUT_MS = 5 * 60_000`，
  放 instance-api.ts；`sessionIds` 可选子集过滤，§3）。**wire 上游空闲窗**：代理豁免名单
  `LONG_RPC_PATHS` 已含 `/api/archiveCleanup/purge`（03 §3.4），30 分钟保险丝覆盖上游
  静止容忍——5 分钟客户端预算是唯一先到截止，诚实超时文案（下条）不再被代理 45s 窗的
  误导性 504 抢先；
- wrapper 的 `undefined`（整集）legacy 形状**保留**为已测的 wire 层契约（测试仍
  覆盖「no filter keeps the zero-arg shape」），但**无 UI 调用者**：管理器永远携带
  显式 id 列表（§6）；
- **双层域载体 + fail-loud 解码**：载体缺失/非对象、`ok` 非布尔、`ok:true` 无对象
  `value` 一律 loud throw，不静默折算 0/空结果；404 判别体改**有界读取**
  （`decodeDomainResult` + `readNotFoundBody`）；
- **常驻保留字段的解码与文案**：`purgeArchivedSessions` 额外解
  `residentRetainedRoots`（`optionalIdList`：缺键/非数组 → 缺席；条目只收非空
  字符串、**去重**，**绝不伪造 id**——它只驱动行标注，计数仍是权威结果）；note 装配
  （`archivePurgeNote`）在该字段非空时输出 `archive.purge.note.residentRetained`（「其中
  {count} 项内容已删除，但会话仍在本实例内存中——继续保持隐藏，重启该实例后彻底消失」），
  **取代** `archive.purge.note.forcedLoaded`（旧文案读起来像"列表里也没了"）；旧宿主不发
  该字段时（版本歪斜）回退旧键，不静默。**id 必须由宿主回传**：客户端近似式
  「本次提交的根 ∩ run 后仍在归档集合」会把**中止/被保护/运行中跳过的树**误标成"内容已
  删除"，只有宿主知道哪棵树是**完成**的；
- **超时文案**（诚实，zh 硬编码先例）：「清理超时——可能仍在进行，请稍后重新预览/
  重试（重复执行是安全的）」；预览超时给「预览超时，请重试」；504/网络中断同样走
  诚实文案；
- 503 `instance_unavailable` 沿用 `wrapWireError` 既有文案与 `isInstanceUnavailable`
  语义；
- 行内错误文案**沿用 zh 硬编码先例**（现有一切 wrapWireError/rowError 文本均为 zh
  硬编码）——按钮 aria/title 与确认对话框文案走 locale 键（§6），行内错误/信息行走
  zh 硬编码 + 与既有错误同构；如需本地化列为后续增强。
- **桥契约（05 §3 `ChamberServerAggregate`）**：投影字段 `archivedSessions`（+ 归档集
  权威性标记 `archiveSetKnown`）：已归档行的**元数据**（id/title/cwd/updatedAt）随实例快照
  投递（官方会话投影本就携带归档行），管理器 UI 由此列示已归档会话而**零新增宿主读取面**；
  unary 兜底视图归档集未知（KNOWN DEGRADATION），
  `archiveSetKnown:false` 防「无已归档会话」误报；`serversProjectionSignature` 纳入
  `archivedSessions` 与 `archiveSetKnown`，保证 purge 后 bridge 重发布、对话框列表随
  刷新收敛（选中集按幸存行修剪；签名只取 id+updatedAt——归档行标题/目录无 UI 变更面）。
- **「先停止、再删除」编排（force 路径）**：管理器删除前用官方 `session/cancel` 停止
  选中项中运行中的会话（`agent.cancel({kind:'user'},
  {keepInbox:true})`；对 idle agent 是 no-op），等 `session/list` 的 running 集合清空
  （有界），再 `purge({sessionIds, force:true, protectSessionIds})`。
  - **闭包 = 选中根 + 全部 subagent-origin 传递后代**：血统只沿 `session/list` 行上
    `origin === 'subagent'` 的边；**缺 `origin` 的 `parentSessionId` 是 fork
    lineage**（上游 `session/fork` 只写 `parentSessionId`、不写 `origin`），fork 后代
    **不在**宿主 purge tree 里，既不取消也不清理，边**终止**闭包。无血统事实时闭包
    退化为「仅根」，绝不猜测父链。`stopSessionsForPurge` 从**同一次** `session/list`
    读取「运行位 + `parentSessionId` 父子边」（`fetchSessionRunningLineage`），对**冻结
    选中集合**的**闭包内每个成员**发 cancel——不只 observed-running 的：维护相位
    （compaction/schedule）对观察者报 `idle`（vendor agent loop 只有 running/maintenance
    两相）却仍在追加写日志，cancel 是客户端唯一能中止它的手段——再等待闭包内不再有运行
    成员；`stillRunning` 报闭包内仍在运行者。闭包计算对畸形/自环父链有界（`seen` 守卫），
    父子边索引每趟只建一次（`sessionChildrenIndex`，O(V+E)）。
  - **保护代替拒绝（保护修正）**：**运行期无"整体拒绝"腿**。客户端把**活**
    `runtime.current`（vendor `SessionListSnapshot.current`）作为 `protectSessionIds`
    交给宿主，宿主在**全量语料**上闭包判定并整棵跳过（`skippedProtected`）；该 id
    **在请求时**从 bridge 活投影解析（`chamberBridge.getServers()`，不是渲染快照
    ——`current` 可在上一次 publish 与点击之间移动），缺失时回退渲染 prop。已知 viewed
    整棵树绝不触碰；**未知 viewed**（未选中/壳被回收/瞬时列表缺口）**照删**，只是没有
    protect——是**保护降级**，不是能力丧失。**不做 sticky 记忆**：
    vendor 快照**无法区分**"掩码"与"清空"（两者都是 `list.current === undefined`，
    `service.js` 的 `persisted` 分支；请求态 selection 与 `watched` 私有），而
    `ui-workspace.clearArchivedCurrent()` 恰在**当前会话被归档**时调 `sessions.clear()`，
    故"记住最近一次 current"会把**用户刚归档的会话**保护到切换会话或重启——正是本节要
    消灭的死端。掩码窗口登记为残余（§13⑭）；归档后短暂窗口内首次删除可能收到
    `skippedProtected`（通常一次 store 更新即自愈），文案已写明"切换会话后重试，或稍后
    重试"。
  - **血统只服务"停回合范围"，不再服务拒绝**：vendor 列表会跳过无 cwd 的冷记录
    （`list.ts` 过滤 `record.header.cwd === undefined`），中间层祖先行可能缺失。客户端
    因此只用血统决定**取消范围**：`exclude`（viewed）里的 id 永不取消；
    `upwardChainComplete` 不成立时**整趟停回合都不执行**（无法证明哪些选中根含 viewed，
    取消一棵"宿主根本不会删"的树会白杀活回合），随后**照常 purge**。
  - **读失败 → 只跳过停止，不拒绝删除**：初始 `session/list` 读失败 →
    `unavailable: true`，不发任何 cancel，直接进入 purge；宿主 running 守卫是安全网
    （真在跑的树被跳过并如实计数）。
  - **扇出与记账**：cancel 按**有界并发**（4）扇出、按**输入序**记账（远程大树
    付 N/4 次往返，文案计数仍确定），扇出被完整 await，返回时**每个 cancel RPC 都已
    resolve**（维护相位的确认就是它的 resolve），随后才发 purge。用户可见计数只算**观察到
    的 running** 成员；**失败**则对 observed-running **与** listed 成员都上报（listed 者
    可能正处维护相位，其取消失败不可吞），无列表行（cold）成员的机会性 cancel 是文档化
    no-op（`session/not-found`）。
  - **归档即终止（user motion「已归档的对话应该终止」）**：chamber 的归档动词在
    `workspace.archiveSession` 成功后**就地**执行同一趟停止（`stopArchivedSubtree` =
    无排除的闭包停止，含全部 subagent 后代）。归档会清空"正在查看"的选中（vendor
    `clearArchivedCurrent`），卡在提问/权限的回合永远等不到回答——不终止就是永久 running
    的僵尸，之后任何删除都被 running 守卫整树跳过。停止是 advisory（归档已生效，失败只
    告警、不回滚），删除侧再停一次兜底（别的客户端归档的会话也走这条）。
  - **停止未生效 / 子代理仍在跑** → 宿主照旧整树跳过（fail-closed），note 提示可稍后
    重试。
  - **版本歪斜：不做兼容回退**：客户端**恒发**
    `{sessionIds, force:true, protectSessionIds}`，**没有**"去掉新字段重试一次"的旧宿主
    腿（回退的代价见 §8）。`session/cancel` 是官方 wire，不受本域版本影响。
  - **已接受的残余（TOCTOU）**：判据基于删除前的一次 `session/list` 读；两步流程（先读、
    后 `purge`）之间若用户**切换到**某个选中归档根的子代理后代，force 清理仍可能删除
    被查看会话的内容（宿主 purge 只按服务端语料判定）。缓解 = 删除前不要切换会话；彻底
    闭合需上游把「当前会话排除」下沉到宿主删除语义（§13）。
- **错误码不得当原因判据**：删除失败时的 code 可能是**来源失败码**而不是本域的语义
  code——git 宿主侧在归档面损坏时报 `state-source-unavailable`（getter 抛错）或
  `state-source-invalid`（非数组 / 非字符串元素 / 空元素），四例均有测试钉住（归档面
  元素形状也校验，不被静默强转）。客户端只按 code 区分「确定性拒绝」与「结果不确定」，
  **不据此推断原因**；原因按 message + 刷新后的权威状态处理。
- **工作树侧判据（design 08 §5.2 同源）**：工作树删除**不停、不取消、不隐式归档、也不
  删除任何会话**；运行中的会话**仍阻塞**删除，**除非它已归档（或它经 subagent-origin
  边链到的祖先已归档）**——宿主守卫为归档感知（`runningSessionIds` 是全部展示事实，
  `blockingRunningSessionIds` 只列非 INERT 者）。INERT 只沿 **subagent-origin** 边
  （`session.header.origin === 'subagent'`）判定，与本域 purge tree 同构——**fork 边终止
  链条，fork 永不因其来源会话被归档而 INERT**（独立会话且不在 purge tree 内）；成环规则：
  先判归档、后判成环（不含已归档成员的环永不 INERT；环上出现已归档成员按已归档祖先规则
  INERT）；父 id 未加载且未归档、或 subagent-origin 行缺父 → fail closed 照旧阻塞。该
  判据在**每条** mutation 腿重读归档集合（首次删除、rollbackCreate 的 path 腿、remove 的
  receipt / reconcile 重放腿），期间取消归档立即恢复阻塞。因此**归档管理器是唯一「先停止
  运行中的回合、再清理已归档内容」的入口**（归档动作本身也停一次）；工作树侧
  无任何停止编排，本域也不因工作树删除获得新执行权。
- **i18n**：`packages/dsh-chamber-client-ui-sidebar/src/client/archive-purge.ts` 只返回**字典键 + 参数**（`PurgeNoteLine { key, params }`，
  `archivePurgeNote` 返回 `{ kind, lines }`），**不内联任何文案**；对话框用
  `t(key, params)` 渲染（`src/client/locales.ts` 的 zh/en 双字典，zh 为键集源、
  `en satisfies Record<SidebarKey, string>` 由 tsc 强制完整）。该模块与字典的唯一耦合
  是**类型导入** `SidebarKey`（运行时擦除，`locales.ts` 无 import，故无环）——`shared/`
  不含字典值，键编译期受检。
- **无 UI 预检门（保护修正）**：删除控件只在 `busy`/武装确认/未选中时禁用——
  **未知当前会话不再是禁用理由**（它只是"保护降级"）。列表可见时若
  `server.runtime?.current` 缺失，对话框在列表顶部渲染一行可见说明
  （`archive.manager.unprotected`，role=status），而不是把控件置灰并只挂在 `title` 上——
  用户能看到"这次不排除任何会话（运行中的仍不会被删除）"且**仍可删**。

## 6. 侧边栏 UI（server 行 hover 动作与归档管理器）

位置与行为（`packages/dsh-chamber-client-ui-sidebar/src/client/SidebarRoot.tsx`
+ `ArchiveManagerDialog.tsx`）：

- 锚点：来源分组头（server 行）hover 操作簇——现状三枚（排序菜单 / add-workspace `+` /
  搜索，`cc.sourceActions`）；在簇尾一枚删除图标按钮（`IconTrashOutlineRegular`，size 14 与
  workspace 删除一致），点击**打开归档管理器对话框**。簇宽 64→86px、header 28px 定高
  不变，「无 reflow（垂直）」声明成立。
- 呈现/隐藏条件与同簇按钮**逐字一致**：`server.connected && (server.aggregateError ===
  undefined || search?.expanded === true)`；断连/聚合错误时不显示；折叠态 header 常驻、
  按钮仍可达。
- 交互流（**全流程 per-server 单飞**）：
  1. 点击 → `stopPropagation` + `suppressClickRef` 检查 + `clearPendingClick()`（照抄
     同簇三件套；拖拽豁免/keydown target 守卫为泛型机制，自动覆盖新按钮）——需维护的只是
     **注释清单**：SidebarRoot dragstart 按钮豁免注释、pending-click.ts 顶部注释、CSS 簇
     内容描述，archive-cleanup 已列名；
  2. 单飞守卫：per-server in-flight，在途时按钮 `disabled`（disabled 瞬时不可聚焦，与键盘
     纪律并存）；跨 N-ctx 并发由**宿主侧单飞**（`busy` code，§3）兜底；
  3. 对话框打开（**不发任何新读取**：行元数据 = 桥投影的 `archivedSessions` ∩
     `archivedSessionIds`，`deriveArchivedSessions`；仅元数据）；
  4. 对话框状态：**挂载基线就绪且 `archiveSetKnown:true`** 才列行；空列表（权威）时 footer
     删除钮 disabled（`listVisible` 的 `rows.length>0` 非冗余：同派生同时门控 footer）；
     `archiveSetKnown:false`（unary 兜底，KNOWN DEGRADATION）与快照未落地（loading/拉取
     错误）分支只呈现说明性文本（degraded/listUnavailable/loading），**无任何破坏性动作**；
     自愈：来源挂载基线就绪后 bridge 重新发布，对话框从 server prop 自动重新派生为列表视图；
  5. 列表 = 顶部全选行 + 每工作区一个可折叠组段。全选 checkbox = 选中**当前列出的全部行
     （含折叠组）**；组头 = 组复选框（原生，部分选中经 ref 设 `indeterminate` 三态 + 显式
     `aria-checked="mixed"`）+ 折叠钮 + 标题（600 字重、省略号）+ 「已归档 N 个会话」计数
     （复用 rowCount 键）。折叠为**对话框本地视图态**（默认展开、不持久化、不与导航 folded
     互扰、只藏行不改选中）；
  6. 破坏性动作只有一处：footer 的**条件渲染「删除选中（N）」**（列表视图且选中数 > 0）。
     **没有独立「删除全部」按钮**——整集清理的唯一路径 = 用户显式全选后再确认带计数的
     「删除选中」，`runPurge` 必带 `sessionIds` 数组，UI 不存在 `purge(undefined)`（整集）
     调用路径；确认文案携带实际计数（`confirmSelected`），对**所选行树（含其子代理内容）**
     负责；
  7. **两段式确认门（对话框内武装态）**：破坏性动作不走 OS 原生弹窗、也不叠第二层 Modal
     （官方 Modal 每开一次注册一个 document 级 BUBBLE Escape 监听、互不知晓——叠层一次 Esc
     双关，且无嵌套先例）。改为对话框内 `confirming` 状态：id 列表在武装瞬间冻结 +
     单行标题或计数文案 → 行输入
     全冻结（`inputLocked`：checkbox/行删除钮/全选禁用；折叠钮保持可用
     ——视图态）+ 面板顶部**风险条**（官方 Warning 图标 error 墨 + color-mix error 9% 底 +
     陈述式不可恢复文案 + 官方 Button sm 对：取消/确认删除）。取消或 **Esc 解除武装**（Esc
     经 document CAPTURE 相位 stopPropagation，官方 Modal 的 bubble 监听不触发——武装期 Esc
     绝不关对话框；解除后 Esc 恢复默认关闭
     语义）；确认删除 → 解除武装 → `runPurge(冻结 ids)`。
     焦点：武装落**取消**（条内首个 button，安全默认）；取消/Esc 焦点回**武装源控件**（行
     删除钮/footer 钮，`isConnected` 兜底 panel；解除后经 `requestAnimationFrame` 延迟回焦
     ——武装期 opener 仍带 `disabled`，对禁用控件的 focus() 是规范 no-op）；确认后条卸载致
     焦点落 body → busy/rows 双依赖的既有焦点兜底 effect 接管。文案为陈述式（非问句），
     `archive.manager.confirmDelete`/`confirmSingle`/计数键 chrome；`role="alert"` 挂在
     **纯文本消息 span**（容器首钮同 commit 抢焦点 → SR 播报竞态，APG 文本性 alert 惯例）。
     单选与多选共用同一条，只换主体文案；
  8. **关闭策略统一**：Esc/X/遮罩任意时刻可关；关闭**不取消**宿主 purge；
     `chamberBridge.requestRefresh(server.id)` 仍无条件发出——对 live 来源是即时
     mutation-pull（App.tsx 无条件拉取并合并会话行，见 §4 step 7），两者都不改变可见列表
     （归档/子代理行本就不可见），属惯例性调用，与 archive 动作一致；§12 的会话列表刷新请求
     不因关闭丢失；焦点圈闭（Tab）+ 关闭后焦点还原；武装期关闭（X/mask/
     非武装态 Esc）只丢弃武装、绝不删除任何内容；武装期 footer「删除选中」隐藏（防双入口）；
     bridge publish 把列表收成空/降级视图时风险条仍在（渲染在视图模式条件外）——accept 仍按
     冻结 id 执行，宿主交集语义保证安全方向，空结果走「没有可删除…」兜底；焦点丢失守卫在
     列表视图消失后的 accept 也能落 panel；`server === null` 时自动解除武装（旧冻结 id
     不得随新列表复现）。
- **列表分组**：归属在 App 派生层计算（derive.ts，零新增宿主读取、零 wire 改动）：
  `ArchivedSessionMetaRow` 带可选 `workspace?: { id, title }`；`deriveArchivedSessions`
  建立归属索引——**权威成员关系优先**（snapshot workspaces 的 sessionIds，registry header
  索引：归档不摘除成员、内容清理才自愈账目），其次**规范 cwd==path 回退**（尾分隔符归一化
  的等值比较——`canonicalPathKey` 提升为模块级、与 projectInstanceSnapshot 的 cwd 合成
  共享同款文档化限制），皆不中 = 无归属（已删除 workspace 的孤儿会话 → 管理器「未分组」桶）。纯函数
  `groupArchivedRows`（导出、node 单测）：组按**组内最新会话倒序**、组内按 recency 倒序、
  未分组桶恒尾置（导航 trailing-bucket parity）。`deriveArchivedSessions` 带零行快速路径
  （`archivedSessionIds` 空或过滤零行直接返回，不建 Set/索引/排序）。
- **缩进与容器**：分组列表的 session 行相对组头**嵌套一级**：每个展开组把行渲染进专用嵌套
  容器 `.archiveManagerGroupRows`（`padding-left: 24px`，祖先侧缩进——不用结构子选择器 +
  子级 margin，行类同时被顶部全选行复用，层级语义不由 DOM 位置推导）。几何：组头标题
  x = 8 pad + w + 8 gap + 16 折叠钮 + 8 gap = **40 + w**；嵌套行标题 x = 24 step + 8 pad
  + w + 8 gap = **40 + w**——原生 checkbox 宽度 w 在两边抵消，任何平台下**行标题列与所属
  组标题精确同列**，层级由 checkbox rail 台阶（8 → 32）+ 折叠钮表达。全选行与组头保留
  外列；未分组桶行同规。
- **视觉与焦点**：组头折叠钮复用导航同款 chrome（本 css module 的
  `foldToggle*`/`foldChevron`/`foldFolder` 类 + `workspaceAccentStyle(server.id, key,
  gitFlag)`，git flag 已加载时同 seed——accent 与导航同工作区一致）；行删除钮并入模块
  `.actionIcon` 家族（`actionIconDanger` 修饰 hover 转 error ink，20px 命中 + 纯色 hover，
  disabled 与焦点环随基类）；焦点环常数合并为
  `.actionIcon:focus-visible, .archiveManagerGroupHeader .foldToggle:focus-visible` 单一规则表（+1px 外扩）；
  `workspaceHeader:hover`/`archiveManagerGroupHeader:hover` 与
  `sessionRow:hover`/`archiveManagerRow:hover` 并入导航共享选择器表；busy 整头 60% 变暗
  改为**仅复选框**变暗（折叠钮 busy 期仍可用，视图态）；purge 刷新卸载聚焦行后焦点落 body
  的**回焦 panel 兜底 effect**（非 trap）；danger 动作 = 官方 Button outline + error ink；
  原生 checkbox + accent-color（官方无 Checkbox 组件）——**勾选取色 = dsh 业务蓝**
  `--dsw-alias-state-business-primary`（官方中性
  `--dsw-alias-brand-primary` 浅色主题下近黑，勾选态会发黑。证据：
  `sidebar-chamber.module.css .archiveManagerCheck`）；footer Button/icon/字体均走 alias
  token；spinner 13px（导航 12px）随所在行高；在途 spinner + `aria-busy`。
- **运行结果内联呈现**（`role=status`/`role=alert`，zh 硬编码）：完成摘要
  （`deletedSessions+deletedSubagents > 0` 时「清理完成：删除 X 个会话 / Y 个子代理内容。」）、
  运行跳过（`skippedRunning > 0` 无论有无 errors 都补「已跳过 N 项运行中的会话（未删除）」）、
  部分失败（`deleted>0 && errors>0` 走 `role="alert"` 错误行 + 完成摘要 + 「N 项失败，可
  重试（重复执行安全）」，明细前 3 条）、全失败（`deleted===0`）按错误呈现、busy、域缺失
  404、超时/网络中断诚实文案、`truncated` 提示、孤儿清扫计数（`clearedOrphanMembers`）、
  `skippedLoaded`/`skippedProtected`（"已跳过 N 个归档树：其中包含你正在查看的会话"）与
  列表顶部 `archive.manager.unprotected`（无法点名 viewed 时的诚实降级说明）的如实呈现。
  **错误绝不静默**；**成功无系统级横幅**，成功/空态为中性 `cleanupNote` 样式。
- **常驻保留行的标注**：run 返回的 `residentRetainedRoots` 存进对话框本地状态
  （`residentPurged`，对话框生命周期内**取并集**——后一次不报告不代表前一次删的内容回来了），
  命中行在标题后渲染 `archive.manager.residentPurged`（「内容已删除，待实例重启收敛」，`role`
  中性、非控件、非错误）：这类行**必然继续列在这里**（宿主保留成员关系，官方列表也还供着
  这一行），标注是"删掉了、等重启"，不是报失败。标注随行集合被动 prune（实例重启后行消失
  ⇒ 标注一起消失）；不进任何持久层、不改选中/计数/删除语义。**a11y**：
  标签是独立 `span`，只在浏览模式被读到——聚焦复选框时读屏只听到标题，故命中行把状态并入
  复选框可访问名（`archive.manager.rowAriaResidentPurged`，`rowAriaLabel()` 单点生成）。
  **布局（同轮）**：列表行是 nowrap flex 线，标签必须**先让位**——`.archiveManagerRowTag`
  带 `max-width: 45%` + ellipsis + `title` 全文，避免窄卡上把会话名挤没（§13⑰ 的窄卡残余
  因此不再被新元素放大）；
- **勾选清理的判据**：只有本次 run **真的移除了内容**
  （`purgeRemovedContent`：删除的会话/子代理或清扫的孤儿成员 > 0）才清空勾选。纯跳过/纯
  保护的 run 一行未动，清空勾选会把"切换会话后重试"变成"重新勾选再重试"；行集合真正收敛
  时那条被动 prune（`pruneSet`）照旧收敛勾选。
- 空态：`deletableSessions === 0 && deletableSubagents === 0`（双零）时不进确认，改在
  对话框信息行呈现提示：`skippedRunning > 0` → 「没有可删除的
  已归档会话（N 项因运行中被跳过）」，否则「没有可删除的已归档会话」。
- 键盘可达：真实 `<button>` + **title 属性 + aria-label**（簇内按钮全部用 title 属性，无
  Tooltip 组件——Tooltip 仅用于 rail/New Session 区域）。
- **locale 键**（en/zh；对称由 `locales.ts` 的 `SidebarKey = keyof typeof zh` +
  `en satisfies Record<SidebarKey, string>` 类型门禁保证——**typecheck:sidebar**；
  `verify:i18n` 只校验顶层双语文档对，与此无关）：`action.purgeArchived`、管理器按键
  （`archive.manager.*`：`groupSelectAria`、`selectAllAria`、`confirmDelete`/`confirmSingle`/
  计数键、`degraded`、`listUnavailable`、`loading`、`residentPurged`）、复用既有
  `workspace.expand/collapse`、`list.ungrouped`、`rowCount`；行内错误/信息（domainMissing /
  超时 / 空态 / 部分失败 / 跳过 / force 回退说明）按 §5 走 zh 硬编码，不进 locale。
  `archive.manager.deleteAll`/`confirmAll` 不存在（独立「删除全部」已退役）。
- 范围：**v1 不做**搜索/目录过滤/恢复（无 unarchive wire）；rail/窄栏与移动端
  不做（范围声明见头部）。

## 7. 宿主包接线与分发面

> 每个枚举 chamber 宿主包的位置都有断言/测试——**先改断言让测试红，再接线**，不会静默
> 漏挂。本清单按类别列全：常量/seed 面、探针契约面、分发/打包面、门禁面、文档面。

**A. 新包本体**：`packages/dsh-chamber-seed-archive-cleanup/`（src/index.ts +
src/core.ts + src/binding.ts + scripts/build.mjs + test/*.test.ts + **构建期生成的 dist（不提交）**）。
产物移出 git 后 `.gitignore` **不再**逐包写 dist 否定行（根 `dist/` 规则直接覆盖；历史的
「chamber host 包提交态产物」否定块已删除）；clean checkout 由 `pnpm run build:artifacts`
自举（design 05 §6），seed 前产物缺失只跳过对应行，不再有「CI 缺产物 → 激活失败」的入库依赖。

**B. control-plane seed 面**：`host-graph-seed.ts` 新增 `HOST_ARCHIVE_CLEANUP_*` 常量
（PACKAGE_NAME / INSERT_ID / INSERT）；`index.ts` `seedEntries()` 第三行 +
`probeDomains: ['archiveCleanup/probe']` + 新
`DEFAULT_HOST_ARCHIVE_CLEANUP_PACKAGE_SOURCE_DIR`；`ControlPlaneOptions` 新增
`hostArchiveCleanupPackageSourceDir`（desktop main 传 dist 打包路径，缺省 REPO_ROOT 源码
目录；absent 时 ensureSeedPackage 静默跳过——安全）；`host-graph-seed.test.ts` /
`cordis-inserts.test.ts` 常量数组。`probeDomains` 是**纯元数据、无代码消费方**（与激活探针集
靠人肉同步）——新增行必须同步本清单里的三处。

**C. 探针契约面（design 18 §3.4）**：
- `dsh-runtime/src/activation-gate.ts`：`REQUIRED_ACTIVATION_PROBES` 含
  `'archiveCleanup/probe'`（激活探针打零成本 `probe` 端点：不读会话数据、无 IO、响应与会话量解耦）；`HOST_DOMAIN_PROBE_NAMES` 含
  第三域（typed subtraction 守卫保留——拼错域名的行在缩减集断言处红）；
- **期望集按实际 seed 派生**：（`syncedHostDomainProbeNames` 逐包派生 → `activationProbeNamesForDomains`；
  二元 `hostDomains` 布尔与 `hasSyncedHostSeed` 同删；seed 清单逐条 `probeDomains` 为源；
  空缓存 = 空域集，兼容 gateway 未同步形状）；
  local/desktop 与 gateway runtime-manager 共用该派生。等价性：空缓存派生集 ≡ 基础探针集
  `PROBE_NAMES_WITHOUT_HOST_DOMAINS`（4 项，不含 chamber 域）；部分缓存派生 = 对已挂载域
  做强于旧语义的验证（2-of-3 部分同步不会与静态期望集错配而 observe→fail→回退）；
- **探针 accept 语义**（新域无 gitWorktree 式「确定性业务拒绝」输入可依赖）：accept =
  generic envelope `ok:true` 且 domain 结果形态良好（value 为对象）；`ok:false` = 在位但异常 → fail-closed；
- 构建期生成产物：**`packages/dsh-runtime/dist/index.js`（承载探针常量；包 main 指向 dist；
  不提交，clean checkout 由 `pnpm run build:artifacts` 自举）**
  ——desktop 经 runtime-probes shim 消费包 main，test/ipc/cross-package-contract.test.ts
  钉生成物 dist，dist-sync.test.ts 锁定同步；
- **rollout 顺序（激活是硬门）**：desktop 启动事务/暴露门控跑全量探针
  （main.ts startAndProbeWorkspace），fail→observe→fail→回退——探针集改动、
  seed 行与 dsh-runtime 源改动 **必须同 commit 落地**（产物由构建重建），否则本地启动事务失败；
- 测试：runtime-probes.test.ts（精简集/顺序断言 + 第三域与部分派生 fixture）、
  desktop/gateway 锁步断言。

**D. desktop 分发/打包面**：`plugin-sync.ts`（CLIENT_GRAPH/GIT_WORKTREE/
ARCHIVE_CLEANUP 常量 + `seedRemoteChamberHostPackages` + main.ts
`chamberHostPackageSeeds`/`localChamberHostPackageSources`/打包路径）、
`scripts/build-host-graph-package.mjs`（packages 数组含第三包 → desktop `dist/` 内嵌包源）、
`test/plugins/plugin-sync.test.ts`（含并入的 seed 模板/回滚锁）/ `test/transport/ssh-provider-endpoint-auth.test.ts` /
`test/gateway/gateway-chamber-apply-materialize.test.ts`（上传清单 fixture）。**门禁面**：根
`package.json`（`build:host-*` 并入 `build:host-packages`、
`typecheck:host-archive-cleanup`、`test:host-archive-cleanup` 别名）、
`.github/workflows/ci.yml` 与 `release.yml` 的逐包 typecheck/test/host-build 步骤、
`scripts/release/release-preflight.mjs` 逐包步骤。

**E. gateway 面**：`plugins.ts` `SYNCABLE_HOST_PACKAGES` 第三行 + `index.ts`
`extraSeedEntries` 第三行（desktop-synced sourceDir）；`runtime-manager.ts` 探针期望走
C 的派生实现；测试数组（feature-lifecycle / chamber-installed / runtime-routes——真探针
fixture 需答第 7 端点 / plugin-spec-lockstep：新包名是否受保护改由**注册表派生**
（design 21 §6.11：`S` = `CHAMBER_HOST_PACKAGES` 名集，C13 三面一致门守住）——新增种子
包**必须同时进注册表**才受保护；「`@dsh-chamber/*` 前缀自动覆盖」的旧口径已废止）。
gateway build.mjs **不改**（宿主包已不在 gateway 内嵌，mobile 是唯一打包例外）。

**F. settings-connections**：PluginDialog 内建组件表**不新增 archive-cleanup 三态行**
（v1 取舍）：v1 仅做**常量级归类修正**——`plugin-inventory-text.ts` 的
`classifyInventoryEntry`/`chamberKindOf` 加第三包，否则该包在 gateway 插件清单
（Loader inventory 驱动）里会以 **third-party** 误标显示（现只认
client-graph/git-worktree/mobile）。域状态诊断 = 侧边栏 404 文案 + 插件清单归类。三态行
代价清单（后续可选增强，未排期）：(a) `plugin-sync.ts` `ChamberInjectionState` chamber
块第三键 + `localPluginList`/`probeRemoteChamber` 实时探针 + 主进程
`LOCAL_PLUGIN_LIST`/`SSH_PLUGIN_LIST` live adapter；(b) IPC 类型镜像三处：renderer /
settings-connections 两侧 `global.d.ts` + `preload.cts` `ChamberInjectionState` 镜像位
（`test/ipc/ipc-surface-mirror.test.ts` 断言三镜像位）；(c) `ChamberSeedDriftState` /
`plugin-inventory-text` 两键形状第三键；(d) 测试 fixture（desktop plugin-sync/
gateway-provider、settings chamber-rows/control-plane）。**IPC 面**：v1（仅常量归类）
**不新增任何 IPC channel / 管理 REST / 反代改动**；后续采纳三态行时上述清单即为增量。

**G. 零改动面**：control-plane 反代、gateway 默认代理、桥契约
（ChamberServerAggregate）、derive/聚合投影、CLI。

**H. 文档面**：枚举宿主包/域的位置都必须含第三包——design 05 §6
（宿主包 2→3）、design 02（loader id 表 / 宿主包附着表）、design 18 §3.4（域枚举文字，
随常量同 commit）、designs 09/13/16/17 中枚举宿主包的表述、design 01 §3 地图行、
STATUS.md。

## 8. 兼容与降级

- 老/未挂域实例：端点 404（含「方法不在该域」）→ 行内诚实文案（§5/§6），
  **无 legacy 回退、不静默**；404 开关限定 archiveCleanup 访问器，不与 control-plane 的
  未知实例 id 404（`instance_not_found`）混淆；
- **版本歪斜 = 重启实例（无兼容腿，决定）**：`sessionIds`/`force`/
  `protectSessionIds` 任一不被旧宿主描述符承认，泛型网关就以 `gateway/arguments-invalid`
  整体拒绝——客户端**不做任何形状回退**（回退要么失去 protect 保护、要么失去 force
  能力，都是本设计要消灭的降级），按错误行原样呈现并提示重启该实例的 dsh（宿主包随应用
  seed，重启即同版）。**结果字段方向的歪斜**：旧客户端 + 新宿主安全
  （`residentRetainedRoots` 是可选加字段，旧客户端忽略之，行照样隐藏、不产生 shrink/墓碑）；
  **新客户端 + 未重启的旧宿主会复现修正前症状**（旧宿主仍摘标记 ⇒ 已加载会话的行回流，
  客户端按 §5 回退旧文案、F2 探针按 §12 主动放行）——正是「重启该实例」口径覆盖的窗口，
  **不做客户端兜底修补**（sticky 抑制会引入新死端，见 §13⑭）；
- 无已归档内容：会话快照投影的 archivedSessions 为空 → 空态提示，不进入确认（empty 与全被跳过子句的优先级
  见 §6；投影不可信 / `archiveSetKnown:false` 时走 §6 的
 非破坏性降级分支，不调用本域）；
- **无挂载基线的来源**：`archiveSetKnown:false` / 快照未落地的降级窗口内**无法清理任何
  已归档内容**（非破坏性降级分支，§6）。登记的范围后果：v1 全量 purge 曾在未挂载来源可用，
  能力回归被接受；未来需要时须等 unary 归档集 wire 或上游 delete wire（§11 退役
  条件同源）；
- 断连来源：按钮不呈现；not-ready 503 由 wrapWireError 给既有文案；重连后
  不弹陈旧计数（对话框从 server prop 重新派生）；**重连双确认窗口**：断连清理 effect 清掉
  本地 in-flight 标记而宿主 purge 可能仍在运行——重连后再次确认与先行 run 重叠属接受
  窗口，由宿主 `busy` 单飞兜底 + purge 幂等收敛，不引入新防护门；
- purge 超时/中止：客户端超时不取消宿主删除；以「可能仍在进行、可重试、重复执行安全」
  诚实呈现（§5/§6），**不诱导用户误判为失败**。

## 9. 测试与验证

- `core.test.ts`（纯 fixture，不依赖 vendor，同 git core 模式）：候选集 /
  孤儿 id / 级联枚举 / 运行子树跳过 / **children-first 顺序与崩溃乱序收敛** /
  幂等重跑 / 逐项错误隔离 / 账目自愈 / archived 成员最后移除 / 每会话复检 /
  子集过滤（covered 祖先同选、archived subagent 行独选、重复 id、畸形过滤
  零读取）/ 树中止与 rerun 收敛 / **常驻保留**：loaded 树 force 删除
  后成员关系保留 + `residentRetainedRoots` 如实上报、保留树覆盖的 archived 后代
  一并保留（无部分成员）、重跑对已无内容的常驻成员保留且不误报 `forcedLoaded`、
  **plan 时 clear、删除瞬间被 attach 的竞态仍保留**、非常驻树照旧摘除 / 孤儿清扫
  （§4 step 5 各 fail-closed 腿均有 fixture：确认读列出即不清、空语料与塌缩语料门、并发
  purge 不重复清、probe 失败/缺失/非布尔、并集枚举保住仅 persistence 可见的记录、预算截断
  注记）；
- 域门面：方法名与 envelope、零参 `{args:{}}` 形状、`sessionIds`/`force`
  payload 形状、domainResult 载体、**busy 单飞**（并发 purge 第二个调用得
  `ok:false busy`）；
- binding：真 binding/RunGate 单测（无装饰器直测）——`assertHeaderShape` 通过/全缺/缺
  存储三态、`locate` 接收者调用（this 敏感 fake，见 §10）、`stat` 语义 fail-closed、
  running/loaded/force 三态 + status 漂移拒绝 + facts 拆分、`stat`/`locate` 面缺失三态、
  **删除瞬间常驻位报告**（idle agent / attached session / 无 live facts 三态 + **真
  binding×真 core 的端到端保留**——成员关系一笔不写）、**live facts 漂移 fail-loud**
  （`sessions.list()` 非数组 / 条目无字符串 id / agent 状态未知一律 `registry-unreadable`，
  review）；**protect 全套**（§3/§4 step 3b 每条规则各有 fixture：受保护根/受保护
  subagent 后代整棵跳过、优先分类、未知 id 无操作、受保护孤儿不清扫、畸形/超限在权威读取前
  拒绝、空集合逐字节等价、二次保护复查不产生前缀删除、binding 原语 `protected` 拒绝）；
  **集合写字段归属不变量**（§4 step 9 铁律）：fake registry 的 live global 携带本域**不
  拥有**的字段（pin 新增项 + 一个代表未来字段的占位），断言写入对象**除 `archivedSessionIds`
  外逐字段等于写前 global**——该全对象 `deepEqual` 即事故回归闸（连"照着 0.1.7 字段表完整
  重建"也会被未来字段占位抓到），取代历史上"写入键集 == 3 个"的固定形状断言（后者正是漏网
  原因）；**注册表面守卫负向用例**：`state` 缺失 / `null` / 数组三态在**其余面完整**的 ctx 下
  被拒（同 ctx 配合法 `state` 必须通过，作为正控制，使拒绝可归因于 `state` 本身而非别的缺面），
  且写入口同样拒绝；
- retention 不变量（逐条落于 `test/core.test.ts`，I4 于 :92、I1/I2/I3/I5 于 :88-236；原 fixed-seed xorshift32 × 2,000 轮组合生成未恢复，组合空间回归仅剩逐例）——I1 任何"删除瞬间仍常驻"
  的根绝不离集合（用户要求本体）、I2 上报的保留集不 phantom、I3 `forcedLoaded` 只计真的
  删了内容的保留根、I4 force 从不跳过 loaded 树、I5 重跑不删内容/不报 item 失败/**绝不摘
  live 成员**/只摘无记录成员（原组合生成器的失败消息带迭代号与全量状态快照、种子固定 ⇒ 不引入 flake；该生成器未恢复）；
- 探针契约：期望集**部分派生 fixture**（2-of-3、空缓存、全量三态）、
  accept 语义、dist-sync / cross-package-contract 锁步——先红后绿；
- 接线面：host-graph-seed / cordis-inserts / desktop plugin-sync / gateway 列表断言扩展
  （先红后绿）；根脚本/CI/release/preflight 逐包腿；生产端调用形状与顺序、常驻保留对话框
  glue（结果字段 → 并集标签集 → 随行 prune 等）的源码文本锁均由该裁决移除（§12）；
- 客户端 wire：`instance-api.test.ts`（client 对象 stub + global fetch stub）：404/503/超时
  分类、畸形双层载体 fail-loud、有界 404 判别体、wrapper 层错误类映射、**唯一 wire 形状**
  （`{sessionIds, force:true, protectSessionIds}` 恒发、无重试腿）、旧宿主 args 拒绝原样
  上抛、`session/cancel` 请求形状、`stopArchivedSubtree` 的 advisory 语义、
  **`residentRetainedRoots` 解码**（正常列表 / 缺席 / 非数组 / 空数组 / 混入非字符串条目
  一律不伪造 id / **重复 id 收敛**）；
- 客户端编排纯函数：`archive-purge.test.ts`（**未知 viewed 仍照删**（死端回归）、
  已知 viewed 进 protect、lineage 读失败只跳过停止、note 键集与顺序、空态不静默、
  **常驻保留行文案**与**旧宿主（无该字段）回退旧键**）；
- 停止回合：`stopSessionsForPurge` 的**闭包全员 cancel**（含维护相位覆盖）、
  观察到的 running 才计数、失败对 running∪listed 上报（cold 吞掉）、有界并发的
  **输入序记账**、`requireCompleteExcludeChain` 整趟闸、排除 viewed、
  `session/not-found` 幂等、`stopArchivedSubtree` 的 advisory 语义；
- UI 逻辑（纯函数可测部分）：per-server 单飞状态机、empty/skipped 优先级、
  部分失败警告文案装配、`deriveArchivedSessions`/`groupArchivedRows`（成员
  归属优先于 cwd 的冲突 fixture、cwd 回退 + 尾分隔符归一、组序与未分组尾置、
  空输入与自洽排序）、`serversProjectionSignature` 参与
  archivedSessions/archiveSetKnown；该包无 DOM/UI 测试基建（test 脚本全 node
  纯模块）——**不承诺**「pending-click 守卫清单测试」；对话框渲染面验证 = typecheck + 打包版
  目检（§13）；
- git host/client 侧配套（design 08）：归档感知 running 守卫（未归档运行中
  会话阻塞、已归档不阻塞、已归档祖先使子代理 INERT、链条不可解析
  fail-closed、cwd 腿同规则、快照双字段投影）、客户端
  `blockingRunningSessionIds` 判定与旧宿主回退、快照解码；
- locale：对称由 typecheck:sidebar 门禁（机制见 §6）；
- 门禁：`test:sidebar` / `test:host-archive-cleanup` / `test:renderer-shell` /
  `test:control-plane` / `test:desktop` / `test:gateway` / 对应 `typecheck:*` /
  `build:renderer` / `build:host-archive-cleanup`；
- 实机 E2E（vendor 树就绪 + 打包态，§13）：本地实例归档若干会话（含 subagent）
  → hover 动作 → 管理器列示/勾选 → 确认 → 磁盘/registry/事件验证 → 再跑幂等；
  **常驻保留链**：归档一个**本进程打开过**的会话 →
  管理器删除（内容真的消失）→ 侧栏**不得**出现普通行、管理器仍列出该行并带
  「内容已删除，待实例重启收敛」标注 → 重启该实例的 dsh → 行彻底消失、再跑
  一次 purge 干净；
  gateway 形态（桌面同步 → managed dsh 重启 → 同链）；远程 dsh（ssh）同链；
  并发（两 ctx 同时 purge → busy）；超时续跑；
- 如实报告纪律：vendor 子模块缺失时哪些腿无法执行（build:renderer / 打包
  依赖 vendor 源码），不虚报。

## 10. 宿主面事实（vendor 核对结论）

vendor/harness-packages（pinned submodule，当前 pin dsh-v0.1.7-rc.2 477b4f4205）核对的宿主面
事实，binding 与算法以此为准。§4 step 9 的字段归属铁律即由此得出：**面**（服务方法/属性）
自 alpha.2 b2e3b2a0 审计以来未变，但**全局字段集合**在 0.1.7 长过（新增
`pinnedSessionIds`/`defaultWorkspaceId`），故本域不再镜像字段：

1. `workspaceRegistry` ctx 服务：`archivedSessionIds`（public getter）/ `archiveSession`
   （仅增向）/ 单条 `unarchiveSession`（public，本域未用）可用；本域写集合另需三个
   **私有**面——实例字段 `state`（官方 live global 本体，`setState` 换的就是它）、
   `setState`（**整体替换**且 `dsh-storage-domain` 的 `global.set` **不跑 `schema.parse`**，
   故 zod 默认值不兜底 → 只能 read-modify-write）、`enqueueOperation`（官方串行链，集合写
   必须在其内）。`list()` 公开可用但**本域已不再使用**（不再重建 `workspaceIds`）。
   **成员 `sessionIds` 是 header 索引派生的
   getter**（启动/实时按 `sessionPersistence.list()` 重建）——内容删除后
   成员账目自动自愈，无需也不可手工改账目；
2. **归档顶层行可枚举**：官方 `sessionQuery.listSessions()`（live 优先 + 持久化
   合并，含 `header.origin`/`parentSession`/`cwd`），`archivedSessionIds` 为
   registry-global 集合；单侧枚举都会
   静默收窄，故 binding 取 `sessionQuery.listSessions()` ∪
   `sessionPersistence.list()` 的按 id 并集（§4 step 5）；binding 的
   `persistence.list` 回退守卫的是「已挂载但方法不全」的表面漂移并服务单测
   直用，**不是**缺失服务路径（cordis inject 语义下缺失服务根本不会启动）；
3. **官方进程内无会话内容删除例程**（persistence 抽象只有 create/open/flush/stat/list；
   公开面自 0.1.3-alpha.1 起为 `stat`（`inspect` 已退役），`locate` 降为后端**私有**
   方法但可经服务对象调用）→ **分支 b**（§4 step 6）：`sessionPersistence.locate(header)`
   给出官方绝对产物路径，作为**唯一目录锚**；
4. **事件**：pinned 树无宿主域可用的 archived-set/session-removed 公开事件面
   → `emitSessionRemoved`/`emitArchivedSessionsChanged` 为**文档化 no-op**；
   投影刷新 = 客户端 mutation-pull（App 层对 live 来源无条件拉取）+ 官方
   启动 header 索引重建 + §12 收敛链；
5. `agents` 服务覆盖面：`listLiveAgentIds()` → `listLiveSessionFacts(): { running[], loaded[] }`
   ——`agents.list()` 中 `status === 'running'` → running，agents 任意状态 +
   `sessions.list()` → loaded；agent status 非 `idle`/`running` →
   `registry-unreadable`（fail-closed：状态漂移绝不能把 running 误判为 idle）。
   `AgentRegistry.resume` 的 owner 是 agents 服务自身 ctx → 会话一旦被打开过
   就常驻至进程结束（故判据是「本进程已加载」而非「正在运行」，§13）；
6. generic gateway：零参 Remote 的 envelope 要求（chamber 侧先例：`clientGraph/graph`
   客户端 `{args:{}}`、git-api snapshot）；宿主侧参数名约束；`assertExactArguments` 对
   描述符外键**严格拒绝**（实测 `unexpected "sessionIds"` / `unexpected "force"` /
   `unexpected "protectSessionIds"`）——新客户端请求到旧宿主绝无「静默全量删除」分支，
   形状回退与处置见 §8；
7. cordis patch insert 三行共存无冲突（id/name 全局唯一）；
8. 会话存储布局（format.ts / sessions-root / header 索引）与原子写/持久化原语：`locate`/
   `format` 官方导出即足够，**布局知识零复制**；可删条目白名单见 §13⑩；每次 append 按
   路径重新 `open(path, "a")`、头行只在创建时原子写入（§13 force 语义依据）；
9. `refresh()` 存在且 `mergeOrderedBaseline` 丢弃服务端缺失行（§12 收敛原语）；官方
   客户端 `SessionManager.summaries` 只在连接代数或显式 `refresh()` 时更新——**任何会话
   列表刷新都必须以方法调用形态发起**（脱绑调用读 `this.manager` 会抛 TypeError 并被吞掉）。

## 11. 风险与上游收敛

- **上游未来落地 unarchive / sessions.delete**：收敛路径**机制化**——上游 wire 随 vendor
  bump 出现即登记为独立 STATUS 跟踪项：客户端 wrapper 单点切到官方 wire（批量编排），宿主
  包按发行周期从 seed 清单退役，双协议不永久并存；§3 命名空间与官方分离保证切换无碰撞；
- **seam 退役**：上游 wire 落地即退役 `state`/`setState`/`enqueueOperation` 三个私有面 +
  probe 端点 + seed 行。该 seam 的漂移**不靠人工清单兜底**：缺失/改名的 `state`/`setState`
  由激活探针（`assertHostSurface`）拒绝，缺失的 `enqueueOperation` 在写入口拒绝（§4 step 9，
  注意**不在**激活期），两处都是 fail-loud `registry-unreadable`。**检测边界要说清**：守卫是
  **存在性/形状**检查，只覆盖"面缺失或改名"，**不覆盖语义漂移**——若 `state` 保留了名字却
  不再是 `setState` 所替换的那个对象，或 `enqueueOperation` 不再串行，两道守卫都会通过而
  回到静默损坏（即 0.1.7 同类）。这正是 STATUS 保留"待上游批量原语后退役"这一开放项的理由：
  语义漂移在运行时不可判，只能靠消费公开原语来根除。该 seam 对官方 global 的
  **字段集合零知识**（§4 step 9 的字段归属铁律），不随上游加字段而更新。**代价要说清**：
  本域因此从"公开 getter + 公开 `list()`"改为依赖一个**私有实例字段** `state`（公开面换私有
  面，私有面 2→3）——换来的是对字段形状零知识、不再随上游 schema 漂移，这是有意为之的取舍；
  单条公开 `unarchiveSession` 存在但需 N 次写，故不作为替代（§4 step 9 alternatives）；
- **探针部分同步**（老桌面↔新 gateway 交替同步）：§7 C 的期望集派生消除静态错配，是第三域
  上线的必要条件；
- **并发与漂移防护**：只经宿主 service / 持久化原语 + live agents 守卫 + 每会话复检，崩溃
  窗口由 children-first 顺序 + archived 集合收敛兜底（§4 step 4/8）；官方存储布局漂移由锁步
  测试 + 目录内白名单 fail-closed 防住（§13⑩）；事件面缺失的差距由 mutation-pull + 启动
  header 索引重建 + §12 收敛链闭合；域错误只经 domain 返回/宿主日志，不进 renderer 之外的
  表面（「错误绝不静默」由 §6 槽位与部分失败警告保证）；
- **本例外无先例效力**（§2 边界 5，其他会话域动议须重新评审）；**B 路径风险**（进程外直删的
  内存覆盖/账目分裂）在方案中不存在（§2），仍是冻结项，不做任何形式的复活。

## 12. 会话列表收敛契约（purge 后幽灵行抑制）

**问题（shape of the defect）**：宿主删除对官方运行时不可见——`emitSessionRemoved` 等为
文档化 no-op（§4 step 7），但归档集合收缩经官方 `domain/changed` → workspace follow
`{type:'archived'}` 立即到达客户端（`api/workspace-controller` 的 `feed.ts` → `client/model.ts`
`replaceArchived`）；而官方客户端 ctx 的 `SessionManager.summaries` 只在
其 ctx 连接代数重建（`handleConnected` → `refreshList`）、本地 mutation 帧或显式 `refresh()`
时更新。于是生产端推送「收缩后的集合 + 陈旧的行」→ chamber 可见性过滤（archived ∩ rows）失去
覆盖 → **已删会话以普通行浮现**，点击即官方
`session/not-found`；运行中投影字段变化
（running 位、活动时间、标题、blank、成员/分组）会把仍脏的行重新推送，而 unary pull 又清掉
⇒「推送装回、拉取清掉」的稳态振荡。服务端读取面本身即时自愈
（`session-persistence-jsonl.list()` 每次重扫磁盘，`session-query` 的
`SessionCorpus.listSessions()` = 持久化重扫 + live 合并），滞留点只在官方客户端 ctx 的
`summaries`。相关宿主事实：vendor `sessionIds` 为**内存 header 索引派生**，内容删除后至
重启/下次实体写前，官方 workspaceView 仍含该 id 的**占位成员**——故收敛必须显式做。

收敛机制（客户端零宿主改动；**无会话内容读取、无新 wire 端点**）：

- **桥通道**：`chamberBridge.requestSessionListRefresh(sourceId)` 广播 +
  `onRequestSessionListRefresh` 订阅（aggregate-store.ts，与 requestRefresh 同构；05 §3
  通道表同源）。挂载 ctx 的 sidebar 插件按 `chamberInstanceId === sourceId` 匹配后**以方法
  调用形态**调用官方公开面 `ctx.sessions.refresh()`（ClientSessions；脱绑调用是本机制的致命
  缺陷——`ClientSessions.refresh` 是读 `this.manager` 的原型方法，脱绑即 TypeError 且 RPC
  从未发出）。运行时守卫：方法缺失与调用失败均 console.warn——失效绝不静默；桥监听器抛错被
  同步防御包裹，不得中断 App 推送处理。刷新完成后 summaries 丢弃已删行 → store notify → 生产者
  queueSnapshot → 推送干净
  快照 → App 全量提交替换聚合。未挂载来源无订阅者也不需要
  （走 unary，服务端逐调重扫）。
- **触发 1（App 收敛状态机）**：mounted 推送提交前对**每一次** ready 推送评估
  `planSessionListRefresh`（renderer `aggregate-refresh.ts` 纯函数）：(a) 检测**归档集合
  收缩**（`archiveSetShrink`：无 unarchive wire ⇒ 收缩 = 宿主 purge 完成集合移除的唯一客户端
  可观测信号；仅两侧 `archiveSetKnown:true` 才产生，降级空集永不误报）；(b) 收缩移除的 id ∪
  上一轮未收敛（pending）id 中**仍以行存在于本推送**者 = 幽灵候选；(c) 幽灵候选非空即请求
  会话列表刷新，并按来源以 5s 冷却封底重发节流（`SESSION_LIST_REFRESH_COALESCE_MS`；官方
  refreshList 单飞兜底并发）；(d) 行消失即收敛——pending 清空、状态机自终止。**覆盖超时续跑、
  跨壳/他处 purge、未来任何删除入口**；刷新瞬时失败由后续推送在冷却后重发收敛，被冷却压下的
  请求不丢 id（留在 pending）。行渲染的最终兜底：安静来源（推送停止）由 30s staleness 看门狗
  的 unary merge 拉取在 ≤1 个周期内把聚合 session 行换成服务端干净列表（行自隐）。仅推送侧
  评估是完备的：mounted 的 pull 提交保留当前归档集合（`commitAggregatePull` merge）、
  full-fallback 提交被 provenance 门挡住，pull 不可能先于推送观察到收缩。
- **触发 2（对话框即时路径）**：ArchiveManagerDialog 每次 purge settle（成功路径与 catch——
  超时/网络/busy 亦可能已有宿主侧删除落地）均请求一次，覆盖「收缩推送到达前」的窗口，且对话
  框关闭也不丢请求。对话框请求不进 App 的冷却戳（跨包解耦）；与触发 1 在单次 purge 上重叠
  （≈2 次 session.list RPC，第二次通常空转）——purge 罕见、RPC 廉价，属有意双通道冗余。
- **F1 墓碑抑制**（`packages/dsh-chamber-client-core/src/purged-rows.ts` 纯函数 + `packages/dsh-chamber-client-core/src/purged-tracker.ts` 状态机 +
  `client/index.ts` 接线）：生产端自己跟踪工作区 store 的权威归档集合（原始数组引用比对短路：
  官方 `installArchived` 仅在集合内容变化时安装新数组，稳态成本 = 一次引用比较）；发生**严格
  收缩**时把离开集合的 id 记为墓碑，并从**上报的 snapshot.sessions** 与**运行时事实通道**
  （含 `current`）中过滤，直到原始 summaries 不再列出该 id、或它重新入集合（**无**「resolve
  即释放」阀，见 F2）。诚实性依据：宿主 `core.ts` 的 `clearIds` 只含**内容删除成功**的树与
  无记录孤儿（集合写失败时 id 留在集合 ⇒ 永不布防），故「离开归档集合 ⇔ 内容已不存在」；
  首次 archive-set 观测本身永不推断集合收缩；跨 renderer 重启或首次升级的 summaries 另由 F5 的
  session.list 基线校验处理。过滤在签名计算**之前**完成；无过滤时
  返回同一数组引用。**与常驻保留的关系**：常驻保留的根**从不离开集合** ⇒ 不收缩、
  不布防墓碑；它们的行由归档过滤（`sessionVisible` / 官方导航同款）继续遮住。F1/F2 仍覆盖
  非常驻幽灵行（清标记 + 官方 summaries 滞留）。
- **F2 校验式收敛链**（`packages/dsh-chamber-client-core/src/purged-convergence.ts`）：收缩与桥请求都触发链——**方法调用**
  官方 `ctx.sessions.refresh()`，随后按 `ctx.sessions.list.byId` 校验墓碑 id 是否已消失：
  - resolve 且仍有残留 ⇒ 重试（官方 `refreshList` 单飞会把 purge 前的在途响应回给新调用者）；
  - reject ⇒ 重试（瞬时 RPC 失败且 summaries 未动）；
  - 每次尝试都有看门狗（默认 2×重试间隔）⇒ hung 刷新不会永久禁用 seam；
  - 达到 `PURGED_REFRESH_MAX_ATTEMPTS`（3，间隔 1.5s）后进入**权威探针**终态：用 chamber
    自己的 unary `session.list`（经实例代理、每次调用重扫磁盘，无官方单飞、无客户端缓存）
    独立取一次行集合，**只释放它仍列出的 id**（这些会话服务端确实存在 ⇒ 该次收缩并非内容
    删除），其余保持抑制并如实 warn；探针失败/超时一律保持抑制。**刻意不设「resolve 即释放」
    阀**：`refreshList` 在拉取失败时同样 resolve（summaries 未动）且单飞会把 purge 前响应回给
    新调用者——按 resolve 释放会重新打开幽灵行缺陷。
  - 链**单飞**（同来源请求加入进行中的链，不重启尝试预算），`dispose` 取消挂起定时器；每探针
    独立句柄（探针迟到不得取消下一次尝试/探针的看门狗）；探针在飞期间新布的墓碑不得被释放。
- **F3 App 侧权威归档集记忆**（`App.tsx` + `renderer/aggregate-refresh.ts`）：App 记住每来源
  最后一次**权威**推送的归档集合（随来源生命周期回收），两处使用——(a) 已提交聚合失去归档集
  权威时作为收缩基线（否则「workspace 基线先到、sessions 基线在途」窗口内完成的 purge 永久
  不可见）；(b) 降级 full 提交（unary 兜底视图）携带该记忆集合而 `archiveSetKnown` 仍为
  false（侧边栏据此继续过滤已归档行，管理器保持降级分支、不获得破坏性动作）。记忆集合永不
  单独构成权威。**顺序是承重的**：基线必须是**覆盖前**的旧值，否则 remembered ≡ 本次
  快照集合 ⇒ `archiveSetShrink` 恒为 []（F3(a) 死代码）。
- **F4 宿主 registry-global 孤儿清扫**：见 §4 step 5（`clearedOrphanMembers?` 计数在管理器
  settle 文案呈现）。
- **F5 跨重启与首升级幽灵行收敛**（`purged-tracker.ts` + sidebar 的
  `purged-session-store.ts`）：mounted summaries 到达 `ready` 后，以来源自己的 unary
  `session.list` 校验旧行；连接重置会重新校验，失败最多重试 4 次，仍失败只告警、不删除行，并等待
  下次连接代。archive-shrink 墓碑与上次 host-authoritative session id 集合按
  `(instanceId, sourceFingerprint)` 保存于 renderer 本地存储，id 数量有界、不存会话内容或凭据；墓碑在
  官方 summaries 真正移除该行或归档集重新包含该 id 时才释放。首次升级尚无已保存 baseline 时，候选行取
  官方当前 summaries 与 host `session.list` 的差集，但仅限非运行、非空白、且非最近 60 秒活跃的行；这能清掉
  旧版本留下的已删除/已 purge 摘要，同时避开新建/活跃会话的短暂落盘竞态。被保护的差集行在最近活动宽限
  结束后再做一次权威核验；运行中/空白行等官方 summary 状态变化后再核验，不做常驻轮询。识别出的幽灵行在
  bridge 快照与 runtime facts 发布前过滤，并触发官方 `sessions.refresh()` 有界收敛；探测暂不可用时保留
  可见行，下一次 connection/reset 再试。
  **Rejected alternatives**：只用页内墓碑会在 renderer 重启后重现；直接改官方私有 summaries 会令官方
  store 与 chamber 快照分裂；无条件隐藏首轮扫描差集会误伤正在创建的会话。选择来源隔离的有界 id 状态、
  首升级候选保护与宿主权威 scan；对宽限保护项只做活动截止驱动的复核，不以常驻扫描换取收敛。
- App 状态机与归档管理器触发点**全部保留**：正常 purge 路径下 F1 过滤后
  `planSessionListRefresh` 看不到行（`kept=[]` ⇒ 不再请求），但它与 F3 一起覆盖「生产端未
  布防 / 首次观测即 post-purge」的形态。

**不变量**：桥通道契约不变（不新增通道、请求只带 sourceId、无会话内容）；`archiveSetKnown`
三态/撤回/代际栅栏语义不变；无周期 RPC（墓碑与链都是事件驱动、有界）；identity-preserving
（无过滤时同引用）；每 ctx 生命周期独立（`dispose` 清定时器与订阅）。

## 13. 已知偏差与残余

1. **实机门禁**（打包版 UI 目检，无自动化基建可替代）：purge → 切会话/任务
   完成不再浮现；点击不再 `session/not-found`；归档正常会话仍隐藏；两次连续 purge；purge
   后回收再打开；purge 后断隧道恢复；local/ssh/gateway 三形态；30s 合并窗口观测；对话框的
   视觉与键盘实感（缩进几何、组头折叠、武装态交互、回焦）与 `force` 链（卡在提问的归档会话 → 管理器删除 → 停止
   + 强制清理成功）；**归档即终止**（归档动作后就地停止含 subagent 闭包；之后删除不再出现
   "仍在运行"跳过）；**保护修正三态**（无会话打开时照删 + 顶部降级说明行；正在查看的会话
   所在树被 `skippedProtected` 跳过；被回收来源可删）；工作树侧「只对 INERT 会话放行」的
   实机验收（design 08 §5.2）——未归档的运行中会话仍阻塞，已归档者不阻塞也不被触碰（跳过的
   是 INERT 成员，不是整个 RUNNING 守卫）；
2. **探针依赖实例就绪**：官方刷新与 unary 探针都失败时保持抑制（fail-closed），实例长期不可达
   时官方 summaries 的收敛延后到连接代数——行不可见，属验证类缺口；
3. **语义级接线**以目检代证（无自动化断言）；
4. **归档集合 > `MAX_PURGE_SESSIONS`（65,536）** 时宿主不清扫（该规模全量 purge 本就
   `purge-capacity` 拒绝，不可重试，见 §3）；
5. **未对构建后的 vendor backend 跑过真实 `stat`**（本 worktree 的 vendor 为源码态）：其
   `undefined`/抛出语义由 pinned 源码阅读 + 形状一致的 fake 确立；
6. **合法空语料**（全部会话已删）下可信度门跳过清扫，历史无记录成员不收敛（管理器不可见、
   无用户影响）——fail-closed 的代价；
7. **官方 `stat(id)` 的两分语义**（vendor `session-persistence-jsonl/src/index.ts` 复核）：
   **答 `undefined`** 仅限「无任何工件（ENOENT）」「首行为空/无法 JSON.parse」「header
   畸形」；其余**抛错**（非 ENOENT 的 IO/权限错误、**损坏的 zstd 帧**、代际文件名与 header
   版本不一致、**存储格式版本过新** `SessionFormatUnsupportedError`）。`undefined` 判
   「无内容」而**清掉成员关系**，字节不被本域删除（purge 只处理仍可枚举的会话）——跟随上游
   「是否还有会话」语义的代价，登记为已知偏差；**抛错**则 `hasStoredContent`
   fail-closed 返回 `true`（保留成员关系），purge 因无记录也删不了——需人工处理；
8. **并集枚举每次多一次 `persistence.list()`**（可后续记忆化）；
9. **租约**：purge 删除 `session.lock` 即放弃该会话的跨进程写互斥（vendor lease 明确警告
   forfeits exclusion）；本域以「先停运行再清理」约束调用方，跨进程场景不做探测（无 flock
   依赖，见 §2 红线）；
10. **目录内出现未知条目**（上游布局漂移）时整单拒绝，该会话在修复前无法清理——fail-closed
    的代价。**可删条目白名单**：规范代际名 `session[.vN].jsonl[.zstd]`、发布临时名
    `session[.vN].jsonl[.zstd].<12hex>.tmp`（vendor `link()+unlink()` 发布路径）、**迁移
    暂存名 `session.migration.<16hex>.jsonl[.zstd].tmp`**（vendor `generation.ts` 迁移路径，
    `randomBytes(8).toString('hex')`；含本会话自己的迁移后日志）与写租约 `session.lock`。
    识别迁移暂存名是必需的：否则中断的迁移会让该会话**永久不可清理**
    （fail-closed 拒绝且无人工入口），而它本就是这个会话的内容副本；
11. **最低宿主版本**：存在性权威 `stat` 与产物定位 `locate` 都是官方 `sessionPersistence`
    的面，`stat` 自 0.1.3-alpha.1 起才有（pre-0.1.3 为 `inspect`）。`assertHostSurface` 在
    激活探针里要求 `stat` ⇒ 旧宿主探针 `ok:false`（activation gate fail，走 §7 C 的回退/拒绝
    语义），`hasStoredContent` 在运行期对同一缺失返回 `true`（跳过清扫、不清成员）——**能力门
    响亮失败 + 运行期 fail-closed 降级**：域的正确性依赖 `stat`，但绝不因面缺失而误清成员。
    当前支持基线（0.1.7-rc.2）与回滚目标（0.1.3-alpha.2）都满足该面；
12. **force 路径与维护相位（不声称已解决）**：dsh 在**维护相位**期间对外仍报
    `status === 'idle'`（vendor `packages/core/agent-loop/src/agent.ts`），一次 `force` purge
    因此可能删掉**维护任务仍会继续追加写入**的档。`session/cancel` 能中止**活着的**维护相位，
    但新的维护相位可在 purge 之前或过程中启动（宿主侧无法在一次 purge 内原子阻止）。**宿主侧
    没有廉价检测器**：维护相位不是「已加载 agent / attached session」这类公开事实，
    `liveSessionFacts` 看不到它。**REJECTED 备选**：读 vendor 私有 phase 字段——依赖上游内部
    形状、一改即静默失效（且把内部实现变成跨仓契约），不采纳。force 路径**不保证**对维护相位
    安全，收敛路径是官方 delete wire 落地后本域退役（§11）；在此之前三条缓解：归档即终止、
    删除侧对**闭包全员**发 cancel、管理器的 viewed 保护（`protectSessionIds`）——最佳缓解，
    不是保证；
13. **force 删除后残档机制**：`force` 删的是「本进程已加载」的会话档而宿主进程仍持有其内存
    对象——之后任一写事件会重建**无头残档**（写机制见 §10 #8）。四条缓解：(a) 归档时停一次 +
    删除前再停一次（闭包全员
    `session/cancel`）；(b) 宿主按 `protectSessionIds` 整棵跳过**正在查看**的会话所在树
    （保护修正：判定已下沉到宿主，覆盖全量语料）；(c) 已归档会话无任何 UI 路径开始
    新回合；**running 不能裸删**的理由同此机制（`force` 也不放过 running）；(d) **常驻保留
    **常驻保留的成员关系**：这类树的成员关系不再被摘掉，即便残档被重建、甚至迁移竞态把整份内容写回
    （§4 step 10 / STATUS 清理残留②），行也仍被归档集合遮住——本修正顺带封住那条内容面残留
    的**可见症状**（磁盘泄漏本身仍需单独裁决）；
14. **保护的边界（两条同族残余）**：保护输入是本页各来源壳上报的**活** `current`，因此
    (a) **多客户端**——另一个窗口/客户端正在查看的会话不在保护集内，删除可能剪掉它所在的
    树；(b) **掩码窗口**——vendor 把瞬时离列表的选中 `current` 掩码为 undefined
    （`SessionListSnapshot.current`；`manager.current` 私有、`watched` 私有），与"清空"在
    公开面上不可区分，本页在该窗口内也不会保护它（见 §5）。两者与两步编排（先读
    `session/list`、后 `purge`）同族：旧口径"整体拒绝"（代价是死锁与"归档后删不掉"），新
    口径"照删 + 宿主全量保护 + 如实报告"。彻底闭合需上游把「当前被查看」暴露为宿主/客户端
    公开事实（vendor 无公开观察面枚举 API，已核对）；**不**采用 sticky 记忆（理由见 §5）；
15. **无挂载基线的来源在降级窗口内无法清理**（v1 能力回归，§8）；
16. **desktop 激活恒全量 vs seed 产物门**为设计内取舍（构建期 preflight 兜底），不修；
17. **归档管理器 a11y/视觉残余**（模块级偏差，视觉腿复核；**「命中区 < WCAG 2.2
    2.5.8」重新登记**：本表的行删除钮与侧栏/git 的 16/18/20px 图标钮回到"命中区 = 视觉盒"
    （回退命中盒 pass `33238ffe` 的 rims 与它加宽的两处 gap）；机制、实测数据与
    "缓解而非根治"的边界见 `sidebar-chamber.module.css` 的 `.actionIcon` 注释块（唯一权威
    处）、design 06 §7 与 design 08 §3.4。**取舍**：24px 目标尺寸让位于悬停可用性（
    「按照 v0.2.4 恢复」），本次回退不触及本表行删除钮的 20px 视觉盒与 30px 内容撑高。残余
    照旧）：武装期行 dim 0.6 × trash .42 ≈ 0.25 复合（token 对比度仍 ≥ AA）；9% wash 强度与
    深浅主题可读性；风险条 SR 播报顺序（NVDA/VO）；窄卡换行与矮视口裁剪（<~480-540px）；
    行 aria 标签在重复/未命名标题下的非唯一性（追加 project label 或容器 group 语义待 SR 腿
    验证后定）；两处「取消」标签同现（条内取消 vs 头 X=action.cancel——X 语义为关整个对话框，
    保持）；held-Escape 连发无害；dark 主题 danger ink ~4.25:1 为 token 级共享惯例；折叠钮
    aria label 追加组名与初始焦点改列表首控件暂缓（需打包版目检）；组内排序保留为纯函数自洽
    防御；
18. **`deriveArchivedSessions` 每源派生缓存未做**：App 侧按 identity-preserving aggregate
    对象缓存未采纳（跨 mounted push/merged pull 双生产路径的缓存失效管理复杂化收益面窄），
    65k 规模 + 高频 derive 场景再现时再议；
19. **可选增强**：PluginDialog 归档清理三态行（§7 F）、rowError 本地化（§5）；若上游
    Modal 获得层级（stack/优先级/Escape 仲裁），确认弹层可迁官方 `RiskConfirmation`。
20. **常驻保留的四条残余（均为"不可见、自愈、不影响正确性"）**：
    (a) **无内容的归档 tombstone**——保留的成员不再有会话记录，需孤儿清扫（F4/G3 `stat` 证明
    无内容）才摘除；时点与代价见 §3「常驻保留」。**重跑的文案面（登记，待
    目检）**：这类成员既无树可删（plan 无记录）又被 live 排除挡在清扫外，run 落到空态文案
    （`archive.manager.empty`）而**不报错**——行与标注保持原样（幂等），但空态文案与列表里仍
    有的行同现，需打包版目检确认读起来不困惑；
    (b) **管理器标注只在对话框生命周期内**——`residentPurged` 是对话框本地状态（不持久化，
    与 F5 独立的幽灵行 id 状态无关）：重开对话框后那行仍在列表里但没有标注（内容确已删除，
    只是少了说明）；跨开关持久须另行设计（方向：宿主把"内容已清理"做成可读事实，属本域"无
    读取面"边界之外的动议，需重新走 §2 例外评审）；
    (c) **多客户端各自为政（仅标注面）**——保留发生在宿主、对所有客户端一致（选宿主方案的
    理由），但**标注**只出现在执行删除的那个客户端；另一窗口里那行同样保持隐藏，只是没有
    "待重启"说明；
    (d) **`residentRetainedRoots` 无独立 cap（决定：不加）**——上界由请求给出：
    数组只装**本次候选根**（⊆ 归档集合 ∩ 调用方 `sessionIds`），规模与调用方已提交的选择同
    量级；病态上界 = 手写 wire 全集 force purge × 数万同时常驻会话（≈ 每 id 47 B，65,536 时
    ≈3 MB），UI 路径永不带全集（§6 无「删除全部」）。加 cap 需**额外诚实计数键**（静默截断
    会让文案与标注数量对不上），收益仅在该病态场景 ⇒ 已接受的边界，不引入新字段。

### Rejected alternatives（架构调整）

- **archiveCleanup 契约继续两端手抄 + 宽容解码**：否决——客户端对缺失计数字段静默取 0（「已删除 0 个」的静默错误），且方法名/入参键/结果字段没有跨包锁步；改为中立契约包 `@dsh-chamber/dsh-chamber-wire`（唯一声明；seed esbuild 内联；行为锁步测试解析真实 `purge(` 签名比对键序），必需计数（6 项）缺失或非法即 loud，可选计数缺省 = 合法旧宿主。
- **保留 `preview` 端点**（原文曾描述 wrapper）：否决——§5 已写明管理器列表来自会话快照投影且不调用 preview，wrapper 从未存在；删除宿主方法/core/类型/测试并同步本文，而不是补一个没有调用方的 RPC 面。
