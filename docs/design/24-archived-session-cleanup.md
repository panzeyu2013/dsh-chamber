# 24 · 已归档会话内容清理（server 行 hover 动作 · 第三个 chamber 宿主域）

> **状态：现行（archiveCleanup 宿主域 + 归档管理器 + purge 后会话列表收敛，2026-12）**——本文是
> dsh-chamber「删除已归档会话内容」宿主域（wire `archiveCleanup/{probe,preview,purge}`）、
> 归档管理器交互与 purge 后会话列表收敛的权威契约；未完成门禁见 docs/progress/STATUS.md。
>
> 承接并修订 `docs/progress/todo/12-todo-archived-sessions.md`（归档单向、
> 不可见、上游无 delete/unarchive wire 的事实核实仍以该文为准）；todo 12 的
> 方案 B（控制面/主进程特权层直删）继续冻结，本方案用「实例进程内的 chamber
> 宿主域」替代它的位置——不是 B 的翻版，理由见 §2。
>
> 交互锚点 = chamber 侧边栏**服务器分组头行（server 行）hover 操作簇**；
> 执行层 = **新增 chamber 宿主域插件**（实例进程内、宿主权威状态执行删除）；
> 本需求面向 chamber 桌面与 gateway 部署的所有来源形态（local /
> gateway-managed / 远程 dsh）统一生效。范围声明：移动端（ui-mobile，无 hover
> 表面）与侧边栏 rail/窄栏形态**不在 v1 范围**（§6）；若未来需要移动端入口，
> 另行设计（触屏确认流与桌面 hover 不同形）。

## 1. 需求与语义

- 归档在 dsh 是**单向且不可见**的（todo 12 §1 代码核实）：唯一 wire 方法
  `workspace.archiveSession` 只把 id 追加进 registry-global 集合；官方与
  chamber 所有表面过滤归档行；上游无 unarchive / 删除会话 / 归档可见查询。
  归档会话的**内容**（会话目录 + 其 subagent 起源子会话内容）永久占用
  实例宿主磁盘，无任何清除入口。对 gateway 服务器部署，这是可观察的磁盘
  增长来源。
- 本需求 = 在 chamber 前端（桌面 app 与 gateway 服务的同一套自研 UI）为
  每个 server 提供**「删除已归档内容」**动作：
  - 语义：永久删除该来源实例上**所有已归档会话的内容**，**级联其
    subagent 起源子会话的内容**（逐条镜像上游 `sessions.delete` 草案语义，
    映射表见 §4）；
  - 保护：运行中的会话/子代理整棵子树跳过（fail-closed），绝不删除活动
    agent 的内容；未归档会话永不触碰；操作不可恢复（确认文案明示）；
  - 幂等：逐会话删除，重复执行收敛为空结果；单会话失败不阻断其余
    （AGENTS「一个失败实体不得抹除或阻断无关完整实体」）；
  - **错误绝不静默**：整体失败与**部分失败**（`ok:true` 但
    `value.errors` 非空）都必须对用户可见（§6/§8）；
  - **超时 ≠ 失败**：purge 是长任务，客户端超时不取消宿主删除；结果
    不透明时以「可能仍在进行，可稍后重新预览/重试（幂等）」诚实呈现（§5）。

## 2. 契约边界与例外动议

相关红线原文与它们真正约束的对象：

| 红线 | 约束对象 | 本方案如何不触碰 |
|---|---|---|
| 05 §2.2「wire 缺失的方法不做（如删除会话），不发明协议」 | chamber 在**官方 unary 面上**为会话伪造客户端可调协议 | 不在官方 controller 面上加方法；新增的是 **chamber 自有宿主域**（同 gitWorktree 先例），命名空间与官方彻底分离 |
| AGENTS「会话业务是 dsh 前端运行时的事；控制面不消费宿主会话」 | control-plane / desktop / renderer 不得成为会话权威或执行面 | 删除执行体是跑在 **dsh 实例进程内**的 chamber 宿主包（同 design 08 信任模型），control-plane / desktop / gateway 主进程零接触会话内容；客户端只提交「删除已归档」意图，不提供路径、不读内容 |
| todo 12 方案 B 冻结（特权层编辑 workspace.json / 删会话目录） | **进程外**特权层直删：运行中宿主内存覆盖、账目分裂、越权 | 本方案在实例进程内、经宿主 ctx 服务（`workspaceRegistry` 等）读权威状态、经宿主自己的持久化/事件路径执行——不存在内存覆盖问题（§4） |
| OpenChamber 范式「manager 只消费 harness API，不自己动 harness 文件」 | manager 层 | 同理成立：chamber 宿主包运行在 harness 进程内（git-worktree 已是先例） |

例外动议的**边界必须收窄**，边界 1–5 为放行条件：

1. 域只做「已归档集合的内容清除（含级联）」一件事；**不做** unarchive、不做
   普通（未归档）会话删除、不做任何会话内容**检索/导出/投影**、不做字节统计。
   **唯一例外（用户批准的边界修订，§4 step 5 孤儿清扫）**：registry-global
   孤儿清扫的**存在性探测**（官方 `sessionPersistence.stat(id)`；0.1.3-alpha.1 起取代
   已退役的 `inspect(id)`）会在官方
   持久化层读取并解析该会话工件，用途**仅为**回答「该 id 是否仍有可物化内容」
   这一布尔值（官方 `stat(id)` 返回 `undefined` ⇒ `false`；**任何抛出/能力缺失**
   ⇒ `true`，fail-closed。注意 `undefined` 同时覆盖「无日志」与「工件不可物化」
   两种情况——见 §13⑦）；读取结果**不进任何返回面、不进日志、不落盘**，只被消费于
   「该成员是否可移出归档集合」这一个成员关系判断。该例外**不扩展**本域的
   内容接触面（无标题/路径/正文投影，无检索/导出，无字节统计），也**不构成**
   新能力的先例（见第 5 条）；
2. 域无读取面：`preview` 只返回计数，不返回标题/路径/内容投影；
3. 删除语义逐条镜像上游 `sessions.delete` 草案（todo 12 §5.2，逐条映射表见
   §4），**不发明新语义**；上游 wire 落地后本域收敛退役（§11），chamber 不
   永久 fork 会话域；
4. 该域随 chamber 分发并 seed 到所有实例形态（本地 spawn overlay、远程 dsh
   ready-time seed、gateway managed dsh 桌面同步 seed），任何形态下管理器
   进程都不获得新的会话接触面；
5. **本例外不构成其他会话域动议的先例**：任何新的会话域能力（unarchive、
   普通删除、内容读取、字节统计…）都必须重新走一次例外动议评审，不得援引
   本设计背书（边界 1 的存在性探测例外已按本程序单独批准）。

## 3. 宿主域契约（wire）

新宿主包（结构镜像 `packages/dsh-chamber-seed-git-worktree`，含提交态
esbuild 产物 `dist/index.js`）。**命名**：scoped name 遵循两既有
宿主包先例（`@dsh-chamber/dsh-chamber-seed-client-graph`、`@dsh-chamber/dsh-chamber-seed-git-worktree`
——旧的 `dsh-chamber-host-*` 目录前缀已退役，包名/目录均为
`dsh-chamber-seed-<loader-id>`）：
包名 `@dsh-chamber/dsh-chamber-seed-archive-cleanup`，目录
`packages/dsh-chamber-seed-archive-cleanup/`（目录与 scoped name 对齐，避免第三种命名制）。

- loader insert：`id: archive-cleanup`（loader id 全局唯一，见 cordis-inserts
  冲突规则）
- cordis 注入：`static inject = ['workspaceRegistry', 'agents', 'sessions',
  'sessionQuery', 'sessionPersistence']`（**5 个服务**——`sessions`/`sessionQuery`
  供运行位与血统事实，`sessionPersistence` 供内容定位与存在性判定，缺任一即
  `host-binding-pending`/`registry-unreadable` fail-closed）
- wire 命名空间：`archiveCleanup`（camel，两段式端点）。可达性：控制面
  反代对 `/api/i/<id>/api/*` 全量透传、无方法白名单（`instance-proxy.ts`）；
  gateway 默认代理逐字转发非管理 `/api/*`（`dispatch.ts`/`gateway-proxy.ts`）
  ——桌面侧 `/api/i/gateway-<id>/api/…` 与 gateway 托管 UI
  `/api/i/local/api/…` 两条路径均到达同一宿主面，**反代零改动**。

```
archiveCleanup/probe({})          → domain { ok, value: {} }
                                       // 零成本激活探针端点（presence+协议，无 IO）
archiveCleanup/preview({})        → domain { ok, value: {
                                       archived: number         // 已归档集合成员总数（registry-global；成员口径——含被归档的 subagent 起源行）
                                       deletableSessions: number     // 本次可删的集合成员根数（整棵可删的已归档根行）
                                       deletableSubagents: number    // 可删的级联 subagent 起源成员数（非根成员）
                                       skippedRunning: number        // 运行中被整棵跳过的子树数（每根计 1）
                                       skippedLoaded: number         // 仅因「本进程已加载（idle/attached）」被整棵跳过的子树数（每根计 1；force 可删）
                                     } }
archiveCleanup/purge({})          → domain { ok, value: {
                                       deletedSessions: number
                                       deletedSubagents: number
                                       skippedRunning: number
                                       skippedLoaded: number   // 仅因已加载被跳过、本次未删（仍留在归档集合）
                                       forcedLoaded: number    // 因 force 授权而「带着已加载成员」被删掉的根数
                                       errors: { sessionId, code, message }[]
                                       truncated?: true        // errors 截断标记（>1,000 条）
                                       // registry-global 孤儿清扫计数，仅 >0 时出现；只清集合成员、
                                       // 不删内容，故不进 deletedSessions/Subagents
                                       clearedOrphanMembers?: number
                                     } }
// purge 亦可带可选子集过滤：
archiveCleanup/purge({sessionIds}) → 同上（sessionIds 仅收窄候选集）
// purge 亦可带可选 force：force 只放过「本进程已加载
// （idle/attached）」子树，running 永远拒绝；旧宿主整体拒收该字段，客户端按
// §5 的「去掉 force 重试一次 + 如实说明」处理。
archiveCleanup/purge({sessionIds?, force?}) → 同上
```

- 入参：`preview` 与 `probe` **零参**（envelope `payload: { args: {} }`——
  `gitWorktree/snapshot`/`clientGraph/graph` 零参先例）；`purge` 带**可选**
  `sessionIds` JSON 参数（SRC 描述符对缺失 JSON 字段放行 → `undefined` = 全量，
  老客户端 `{args:{}}` 零改动）。客户端照 §5 发 `{args:{}}` 或
  `{args:{sessionIds:[…]}}`。可选参仅限唯一标识符（无解构/默认值/rest——
  gateway SRC 签名约束，方法签名不得含默认值）。
- **可选子集过滤语义**：`undefined` = 全量（旧形状，向后兼容）；数组 = 只把
  列出的 archived 集合成员当作候选根（各自整棵可删子树）。**越界结构性不可能**：
  候选恒 = 权威 archived 集合 ∩ 请求（core.ts，读时取交集），已离开集合的
  陈旧 id（并发 purge/陈旧列表）静默跳过（幂等），非 archived 会话不可达；
  过滤校验失败（非串/空串/超 `MAX_PURGE_SESSIONS`）→ 业务码 `invalid-request`
  （全量路径容量码 `purge-capacity` 语义不变；超容量集合仍可做有界子集 purge）。
  子集模式下集合收敛语义不变（completed 根 + covered archived 后代 + orphan
  同一收尾批量写移除）。
- **可选 `force` 语义**：缺省 = 既有 fail-closed 行为，逐字节不变；
  `force: true` = 只放过「**已加载（idle/attached）**」子树，**running 永远拒绝**
  （含 force）。**归档交互不动**（侧边栏归档按钮、确认文案、归档语义均保持原样）；
  force 的改动全部落在**删除侧**，并且是「**先停止、再删除**」——不放松任何
  安全守卫的判据。结果口径按 `skippedRunning`（真 running）/`skippedLoaded`
  （已加载未运行）/`forcedLoaded`（本次强制删除的树根）拆分，`PreviewResult`
  同步带 `skippedLoaded`。
- `preview` 是**执行时快照**：只回计数（归档管理器列表来自会话快照投影，
  不调用 preview）；`purge` 开头重新读取权威状态，**不信任** preview 结果，
  两者之间状态可变化（UI 文案避免「恰好 N 个」暗示）。
- **已归档集合在 purge 开始时一次性快照**（`archivedAtStart`，core.ts）：run
  期间集合本身不再重读——用户在 run 进行中「取消归档」某个成员，本次 run 仍按
  快照把它当已归档处理（可能已删或已清标记），**宿主是权威**，不因客户端视图
  变化而中断；反之 run 期间新归档的成员不进入本次候选集。单飞（`busy`）保证
  同一进程内不会有两个 run 同时改集合；跨进程/跨 N-ctx 的集合变化由下一次
  run 收敛（重跑幂等）。
- 返回值走 `domainResult` `{ok,value}|{ok:false,error}` 载体（generic
  gateway 不保留 thrown business 字段，同 git-worktree 理由）。
  `ok:false` 的 code 枚举（最小集）：`busy`（本域另一 purge/preview
  在途——**宿主侧单飞**，跨 N-ctx 的并发 purge 靠它收敛）、`registry-unreadable`
  （整体前提失败；probe 的 `assertHostSurface` 结构检查亦覆盖会话枚举/存储面
  ——该检查把官方 `sessionPersistence.stat` 列为必备面，**最低宿主版本
  0.1.3-alpha.1**（`stat` 取代退役的 `inspect`），更旧宿主上
  `archiveCleanup/probe` 恒 `ok:false` ⇒ 激活门 observe→fail（可触发自动回退），
  而运行期 `hasStoredContent` 对同一缺失是「跳过清扫」降级；能力门与降级的
  有意分工见 §13⑪）、`host-binding-pending`（§10 的宿主能力尚未接线——域未
  启用，非重试）、`purge-capacity`（archived 集合超过单次上限 65,536——
  **不可重试**（`retryable: false`），无逃生口直至上游 wire 收敛，见 §13）、
  `invalid-request`（子集过滤畸形/超限——非重试，过滤校验先于任何权威读取）。
  逐项失败收进 `value.errors`（item code 枚举：`missing` 内容已不在 /
  `running` 删除瞬间转入运行（竞态）/ `loaded` 已加载但未授权 force /
  `storage` 宿主存储失败；收尾批量写失败记 `archive-set`），不中断、不 throw；
  `errors` 超过 1,000 条截断并置 `truncated: true`（core.ts 常量
  MAX_PURGE_SESSIONS / MAX_PURGE_ERROR_RECORDS）。
- **计数口径**：`archived` = 集合成员总数（含被归档的 subagent 起源行）；
  `deletableSessions` = 可删集合成员根数（archived subagent 行若自身为可删根
  则计入此桶而非 `deletableSubagents`）；`deletableSubagents` = 被完成树覆盖的
  非根成员——UI 不列 subagent 行，该桶仅 wire 可达。容量门按 `archived` 集合
  成员计；`archive-set` 注记与逐项错误共享同一条目上限
  （MAX_PURGE_ERROR_RECORDS）。
- **宿主审计**：preview/purge 起止行走实例 logger（`[archiveCleanup] …`）。
  purge 是本产品唯一的持久内容销毁原语，local 匿名 loopback 也可到达——
  **UI 确认只是点击保护，wire 本身才是信任边界**（与官方 archiveSession
  wire 同一条边界）。
- 域**没有**任何读取方法；`preview` 是唯一的辅助面且只回计数。`probe` 是
  **零成本激活探针端点**：presence + 协议、不读会话数据、无 IO、响应与会话量
  解耦；`assertHostSurface` 对已挂载但结构异常/面缺失的宿主答 `ok:false`（域
  在位但异常 = fail-closed，同 git-worktree 的确定性业务拒绝）。
- **404 语义**：宿主对未认领方法答 404（vendored gateway unclaimed-route
  行为，ssh-provider/gateway 均有注记）= 域未挂载或方法不存在，与「宿主包
  未加载/版本过旧」同义，客户端按 §5 处理；**不做 legacy 回退、不静默降级**
  （与 runtime-probes 对 chamber 域不做 legacy 降级的先例一致）。

## 4. 宿主内算法与守卫

纯核心 `core.ts`（fixture 驱动单测，同 git `core.test.ts` 模式——不依赖
vendor 源码）+ 薄 Remote 门面（`index.ts`），编排逻辑：

1. **候选集**：每次 purge 从权威 `workspaceRegistry` 重读 archived 集合
   （registry-global，todo 12 §1）与各 workspace 账目；**孤儿 id**（workspace
   成员关系已消失或内容已不在）按 missing 幂等跳过，不阻断。性能契约：
   **单遍快照**（候选 + 各自 cwd），逐成员用快照 cwd 做 O(1) 直删（不逐成员
   全库重列），每树仅做**一次** live 重读（原每成员全库重列已除）；无 cwd
   成员的逐删全库重列是稀有路径（代码注释登记）；`resolveDeletableTree` 用
   显式栈迭代后序，消除递归深度 = 链深的风险；
2. **级联枚举**：对每个已归档顶层会话，按 `parentSessionId` 链枚举 subagent
   起源后代（宿主侧等价于 `sidebar/shared/subagent-lineage.ts` 的
   `indexSubagentDescendants`，但基于权威存储，不基于投影）。归档顶层行的
   可枚举性（含 header 索引对归档行/子会话的可见性）见 §10。header 读取走
   `assertHeaderShape` **逐字段**（id/cwd/parentSession/origin）loud 校验：
   字段漂移记 fail-loud `registry-unreadable` 并点名会话与字段——**绝不逐条
   静默跳过**而把级联/删除级联清空（该谓词严格弱于 pinned vendor 写入期校验：
   origin 仅 absent/'subagent'、cwd 恒非空绝对串、parentSession 恒字符串，
   vendor 自身拒绝损坏行，故无真实数据误伤面）；
3. **运行保护**：任一节点是 live agent（`ctx.agents`）→ 整棵子树跳过并计数
   `skippedRunning`；仅**已加载（idle/attached）**者计 `skippedLoaded`，可由
   调用方显式 `force` 放行（§3/§5）。运行位的事实来源见 §10；
4. **删除顺序（崩溃一致性）**：**children-first**——先删 subagent 起源后代、
   再删顶层会话目录；**archived 集合成员最后移除**（顶层 id 在整棵删完前
   保持 archived，崩溃后续跑才能重新枚举到残留后代，不会产生清不掉的孤儿）；
   完成树所覆盖的**已归档后代成员**（本身在 archived 集合中的 subagent 行）
   随同一次收尾批量写清除，无跨轮 marker 滞后；
5. **registry-global 孤儿清扫**：每次 purge
   与候选集过滤**正交地**再清一遍**整个归档集合**里无会话记录的成员（旧版
   遗留 / 收尾写失败产生的「无目录成员」，管理器只列「行 ∩ 集合」故永不可达）。
   零新增删除语义：孤儿无内容，唯一操作是移除其集合成员关系；有记录的成员
   （含 running）绝不触碰。**fail-closed**：
   - 谓词只在成功枚举后运行，且谓词输出只是**候选**——「两次批量枚举都没
     记录」不构成「无内容」的证明（上游枚举会**静默收窄**：jsonl 跳过
     不可解析/空工件、根缺失返回 []，session-query 在 persistence 未绑定时
     只回 live 行且不报错）；
   - 每个候选必须再经**官方单 id 权威读**（`sessionPersistence.stat(id)`；
     未知 cwd 也按 id 跨项目目录、跨代际解析）确认：**只有 `undefined` 才清**
     （上游对「无日志」与「工件不可物化」都答 `undefined`，见 §13⑦），
     任何抛出/能力缺失一律保留成员关系（fail-closed，绝不 abort 已完成的内容删除）；
   - 枚举为 `sessionQuery.listSessions()` ∪ `sessionPersistence.list()`
     的**按 id 并集**（两侧同口径 loud 形状校验；任一侧抛错即整轮拒绝），
     杜绝「query 侧收窄」丢失记录；
   - 可信度门：快照记录数为 0 而归档集合非空 ⇒ 跳过；确认读记录数从非空
     塌缩为 0 ⇒ 跳过；每次跳过记 run 级 `archive-set` 注记；
   - 候选数受 `MAX_SWEEP_CONTENT_PROBES`（4,096/轮）限流，超限记注记，
     余量后续轮次收敛；清扫 id 与完成树同乘**一次**收尾写（去重、仍最后
     移除），计数独立于 `deletedSessions`/`deletedSubagents`
     （`clearedOrphanMembers?`）；集合超过 `MAX_PURGE_SESSIONS` 时不清扫
     （该规模的全量 purge 本就 `purge-capacity` 拒绝）；仅在快照确实含候选时
     才多一次扫描（已收敛实例保持单次扫描契约）。**空选集不删任何内容，但宿主
     仍要跑该次 run 的孤儿清扫**（清扫与过滤正交）；
6. **执行（分支 b）**：官方进程内**无会话内容删除例程**（§10 #3）→
   `sessionPersistence.locate(header)` 给出官方绝对产物路径，作为**唯一目录锚**；
   目录内的**全部不可变代际工件**（`session.jsonl`、`session.vN.jsonl`，含可选
   `.zstd` 与遗留 `.tmp` 发布临时件、迁移暂存件）连同写租约 `session.lock`
   一并删除，未知条目/符号链接/子目录**整单拒绝**（不半删），目录仅在清空后
   尽力回收（rmdir 非递归）。**一切状态写经宿主自身 setState/持久化原语**，
   文件写遵守宿主原子写纪律；布局知识零复制（依赖 locate/format 官方导出）。
   可删条目白名单见 §13⑩。
7. **事件发射**：删除路径调用官方事件发射口
   （`host/session-removed` 与 `host/archived-sessions-changed`，todo 12 §5.2
   精确名）——mounted ctx 的 workspace follow/基线推送、git 域等宿主内消费者
   本应据此自愈；pinned 树无宿主域可用的公开事件面（§10 #4），故实现为
   **文档化 no-op**（binding.ts emit 空实现）；投影刷新 = 客户端 mutation-pull
   （App 层对 live 来源无条件拉取）+ 官方启动 header 索引重建 + §12 的会话
   列表收敛链。不可绕过事件直接改投影。`emitSessionRemoved` 的实现契约：失败
   必须包 `ArchiveCleanupError`（裸 throw 会杀死整轮 purge 且不留逐项记录）；
   删除成功后事件失败的「双重呈现」为接受语义，rerun 经 `missing` 收敛。
8. **逐会话隔离与复检**：单会话失败记入 `errors` 不 throw、不阻断其它树
   （同树剩余成员的中止语义见下）；每会话删除瞬间经 binding 删除时 live 守卫
   复检（非 running 才删；`force` 只放行 loaded）——逐成员 O(1) running 预检
   是死代码（整树级 live recheck 已证非 running），**binding 删除时的 live
   守卫是唯一 mid-window 门**并承载中止语义；幂等（内容已不在 = `missing`
   跳过；不在 archived 集合 = 不枚举）；崩溃窗口收敛 = 遗留会话仍属 archived，
   下次 purge 续跑清掉。
   **运行窗口 —— 成员失败中止整树**：整棵跳过保证截至每成员的删除瞬间——成员
   在树内删除间隙转 running（binding live 守卫拒删，item 码 `running`）或删除
   报存储错误时（**首个树内失败**即触发），**中止本树剩余删除**：该成员与其
   未删祖先（含根）保持原样、根保持 archived，前序已删成员不回滚（删除瞬间
   本就可删），本树不进入收尾集合移除——根会话记录位于其自身内容目录内，
   越过失败成员删根会让下次 purge 把根当孤儿清出集合、不再重枚举幸存成员
   （静默内容泄漏，故整条祖先链保留待重跑）；下次 purge 从根重新枚举收敛，
   一棵树的中止不阻断其它可删树（逐树隔离）。
9. **集合成员移除**：官方**无公开裁剪原语**（registry 仅 `archiveSession`
   增向；startup/任何路径均不透传裁剪）→ binding 以文档化结构 seam 执行
   **一次纯 `workspaceRegistry.setState({initialized, workspaceIds,
   archivedSessionIds: filtered})`**，且必须**在官方 `enqueueOperation` 链内**
   （与 create/delete/insertBefore 串行，防与两阶段删除交错抹掉 marker），
   官方持久化路径、进程内（todo 12 方案 B 的进程外覆盖风险不适用）；seam 带
   `typeof setState === 'function'` 运行时守卫并 pin 版本。**无「内容删除后保留
   marker」策略**：完成树根、完成树覆盖的已归档后代、孤儿在同一批官方
   setState 写中清除（clearIds 去重；core.ts `purge()` + binding
   `removeArchivedSessionIds`，测试固化）。红线段「no unarchive」的读法 = chamber 域只在其内容删除完成后
   清除**该已删内容自身**的集合成员，不提供任何恢复/浏览/反向操作；A-区
   （todo 12 方案 A，已归档浏览）若实现，其数据面即当前 archived 集合（仅含
   未清理与运行中留存项）。上游 unarchive/delete wire 落地后本域退役并按官方
   语义收敛（§11）。
10. **跨进程租约**：删除租约即放弃 jsonl 的跨进程互斥（vendor lease 明确
    警告 forfeits exclusion），故本域契约要求调用方「**先停运行再清理**」；
    第二个 dsh 进程同根写入不在本域可观测范围内（§13⑨）。

**上游草案逐条镜像映射表**（todo 12 §5.2 → 本域承诺 → §10 事实锚点）：

| todo 12 §5.2 语义 | 本域承诺 | 事实/验证锚点 |
|---|---|---|
| 删会话目录（`<sessions-root>/<project>/<id>/`） | §4 step 6 分支 b + 原子写纪律 | §10 #3/#8；core 单测（§9） |
| 级联 subagent 起源子会话 | §4 step 2/4（children-first） | §10 #2/#5；级联/乱序单测 |
| workspace 成员账目自愈（header 索引重建剔除） | §4 step 6 + 官方原语优先 | §10 #1/#3/#8 |
| 从 archived 集合清理 | §4 step 4（最后移除） | §10 #1；幂等单测 |
| 复用 `host/session-removed` 事件 | §4 step 7（文档化 no-op + 收敛链 §12） | §10 #4 |

## 5. 客户端 wire 接入

`packages/dsh-chamber-client-ui-sidebar/src/shared/instance-api.ts`（唯一
客户端接入点，sidebar 插件与 App 层共享）。**现状约束**：
`call()` 私有；非 2xx 一律 generic throw（无 status 透出）；503
`instance_unavailable` 有专类特判；默认超时 `DEFAULT_TIMEOUT_MS = 30_000`
且**调用方传 signal 也压不住 30s 上限**（`AbortSignal.any([timeout, signal])`）。
据此本设计对 `instance-api.ts` 的增量（最小、向后兼容）：

- `call()` 可选参数 `timeoutMs`（默认不变）；可选开关
  `notFoundAsDomainMissing`（**仅 archiveCleanup 访问器传 true**）。404
  判别规则（防双重语义误标）：仅当 404 且开关开启时解析响应体——
  body `code === 'instance_not_found'`（control-plane 未知实例 id，
  instance-proxy.ts）→ 保持 generic transport 行为（来源已删/未知，非域问题）；
  其余 404（宿主未认领方法 = 域未挂载/版本过旧）→
  抛 `InstanceDomainMissingError`；
- 新专用错误类 `InstanceDomainMissingError` + `isInstanceDomainMissing()`
  （镜像 `InstanceUnavailableError` 模式，放其旁），404 + 开关开启
  时抛它；wrapper 层据此输出 §6 文案；
- wrapper：`previewArchiveCleanup(client)`（默认 30s；UI 不调用——归档管理器
  列表来自会话快照投影——保留为宿主 preview 端点的已测客户端半面）/
  `purgeArchivedSessions(client, sessionIds?)`（长预算，常量
  `PURGE_CALL_TIMEOUT_MS = 5 * 60_000`，放 instance-api.ts；`sessionIds`
  可选子集过滤，§3）。**wire 上游空闲窗**：代理豁免名单
  `LONG_RPC_PATHS` 已含 `/api/archiveCleanup/purge`（03 §3.4），purge 的
  上游静止容忍由 30 分钟保险丝覆盖——5 分钟客户端预算成为唯一先到截止，
  其诚实超时文案（下条）不再被代理 45s 窗的误导性 504 抢先；
- wrapper 的 `undefined`（整集）legacy 形状**保留**为已测的 wire 层契约
  （测试仍覆盖「no filter keeps the zero-arg shape」），但**无 UI 调用者**：
  管理器永远携带显式 id 列表（§6）；
- **双层域载体 + fail-loud 解码**：载体缺失/非对象、`ok` 非布尔、
  `ok:true` 无对象 `value` 一律 loud throw，不静默折算 0/空结果；404 判别体
  改**有界读取**（`decodeDomainResult` + `readNotFoundBody`）；
- **超时文案**（诚实，zh 硬编码先例）：「清理超时——可能仍在进行，请稍后
  重新预览/重试（重复执行是安全的）」；预览超时给「预览超时，请重试」；
  504/网络中断同样走诚实文案；
- 503 `instance_unavailable` 沿用 `wrapWireError` 既有文案与 `isInstanceUnavailable`
  语义；
- 行内错误文案：**沿用 zh 硬编码先例**（现有一切 wrapWireError/rowError 文本
  均为 zh 硬编码）——按钮 aria/title 与确认对话框文案走 locale 键（§6），
  行内错误/信息行走 zh 硬编码 + 与既有错误同构；如需本地化列为后续增强。
- **桥契约（05 §3 `ChamberServerAggregate`）**：归档管理器投影字段
  `archivedSessions`（+ 归档集权威性标记 `archiveSetKnown`）：已归档行的
  **元数据**（id/title/cwd/updatedAt）随实例快照投递（官方会话投影本就携带
  归档行，chamber 此前只在可见性层丢弃），管理器 UI 由此列示已归档会话而
  **零新增宿主读取面**；unary 兜底视图归档集未知（KNOWN DEGRADATION），
  `archiveSetKnown:false` 标记防「无已归档会话」误报；
  `serversProjectionSignature` 纳入 `archivedSessions` 与 `archiveSetKnown`，
  保证 purge 后 bridge 重发布、对话框列表随刷新收敛（选中集按幸存行修剪；
  签名内容只取 id+updatedAt——归档行标题/目录无任何 UI 变更面）。
- **「先停止、再删除」编排（force 路径）**：管理器删除前用官方
  `session/cancel` 停止选中项中运行中的会话（`agent.cancel({kind:'user'},
  {keepInbox:true})`；对 idle agent 是 no-op），等 `session/list` 的 running
  集合清空（有界），再 `purge({sessionIds, force:true})`。
  - **闭包 = 选中根 + 全部 subagent-origin 传递后代**：血统只沿
    `session/list` 行上 `origin === 'subagent'` 的边；**缺 `origin` 的
    `parentSessionId` 是 fork lineage**（上游 `session/fork` 只写
    `parentSessionId`、不写 `origin`），fork 后代**不在**宿主 purge tree 里，
    因此既不取消、也不清理，边**终止**闭包。无血统事实（行无 subagent 边）时闭包
    退化为「仅根」，绝不猜测父链。`stopSessionsForPurge` 从**同一次**
    `session/list` 读取「运行位 + `parentSessionId` 父子边」
    （`fetchSessionRunningLineage`），取消的是**冻结选中集合**的**闭包**中
    **运行中**的成员，并等待闭包内不再有运行成员；`stillRunning` 报闭包内
    仍在运行者。闭包计算对畸形/自环父链有界（`seen` 守卫）。
  - **当前会话排除覆盖整个闭包**：当前正在查看的会话（其 live writer 会在
    删除后重建残档）既从选中根里剔除，也让**闭包含它的每个选中根整体跳过**
    ——不取消、不清理，note 逐因如实说明（只剔根不查闭包会让「被查看的会话
    是某已归档根的子代理后代」这一情形把它连同整棵树一起 force 删除）。
    排除按**冻结的选中集合**计算；选中集合在打开确认时冻结，run 期间新出现的
    行不进入本次 run（下一次 run 收敛）。
  - **force 路径要求「已知当前会话」**：vendor 会在选中会话
    瞬时离开列表时把 `current` **掩码为 undefined**（`SessionListSnapshot.current`
    文档，api-session-controller `client/sessions/manager.ts`；`client/sessions/
    service.ts` 的 `followCurrent` 把该缺口当作「舞台保持」）。因此
    `current === undefined` 是**未知**而不是「没有在查看会话」：运行时报告缺失
    （含来源为 null）由预检门 `purgeRefusalReason` 拒绝；报告存在但无 `current`
    时**同样拒绝**（「无法确认当前查看的会话（会话列表可能瞬时缺口或未打开会话），
    已取消清理；请打开任意会话后重试」）。**没有建议性「照删不误」路径**。
  - **读失败 → 整体拒绝（fail-closed）**：初始 `session/list`
    读失败时闭包未知，无法证明当前会话不在任一选中根的归档树内，因此**取消整次
    清理**（不取消、不清理），如实提示「无法确认当前会话是否在所选归档树内
    （会话列表读取失败），已取消清理；请稍后重试」（`closureUnknown: true`）。
    停止环节的 wire 调用仍**只捕获不抛出**（建议性 = 永不把原始 wire 文本抛给
    用户）。该门与预检门 `purgeRefusalReason`（**在停止回合之前**运行，只知道
    `server.runtime === undefined` 时无法知道闭包，故只拒该情形）是**两个独立**
    的 fail-closed 门：一个挡「当前会话未知」（预检），一个挡「闭包未知」
    （读后）。两条规则都由 `shared/archive-purge.ts` 的纯函数实现（§9）。
  - **血统链不完整 → 整体拒绝**：vendor 列表会跳过无 cwd 的
    冷记录（`list.ts` 过滤 `record.header.cwd === undefined`），而子代理只有父有
    cwd 时才继承 cwd——于是**中间层**祖先行可能缺失，其边被静默丢弃。客户端因此从
    `runtime.current` **向上走** subagent 边：任一环缺失/不可解析（含成环、无父链的
    subagent 行、当前会话本身不在列表）都视为**未知并整体拒绝**（「无法确认当前查看
    的会话是否在所选删除范围内，请先切换到其他会话后重试」）；完整链未触及任何选中
    根时照常清理。宿主（全量语料、无 cwd 过滤）不会做这个过滤，所以客户端不能把
    「读不到边」当作「没有边」。
  - **运行时通道缺失 → 不使用 force 路径**：`server.runtime === undefined`
    （来源重连 / 生产器未注册）时客户端**无法知道**当前会话 → 管理器
    fail-closed：不使用 force 路径，如实提示「无法确认当前会话状态」，行保持
    不动（与 git 插件 `runtime-unknown` 同一纪律）。
  - **停止未生效 / 子代理仍在跑** → 宿主照旧整树跳过（fail-closed），note 提示
    可稍后重试。
  - **旧宿主 + 新客户端（force 回退）**：`force` 被泛型网关的精确参数校验拒绝
    （`gateway/arguments-invalid`）→ 客户端**去掉 force 重试一次**（旧宿主接受的
    形状；「先停止再删除」的意图已由调用方的停止回合满足），结果携带
    `forceUnsupported:true`，管理器追加如实说明（本进程已加载（空闲）的会话被
    跳过、需重启该实例的 dsh）。**绝不静默降级**：若去掉 force 仍被拒（该宿主
    连按条删除都不支持），按「版本过旧 + 重启」提示 fail-closed。
    `session/cancel` 是官方 wire，不受本域版本影响。
  - **已接受的残余（TOCTOU）**：上述判据基于删除前的一次
    `session/list` 读；两步流程（先读、后 `purge`）之间若用户**切换到**某个选中
    归档根的子代理后代，该切换不会被这次读看到，force 清理仍可能删除被查看会话的
    内容。这是两步编排的固有残余（宿主 purge 只按服务端语料判定），缓解手段是
    删除前不要切换会话；彻底闭合需要上游把「当前会话排除」下沉到宿主删除语义（§13）。
- **错误码不得当原因判据**：删除失败时的 code 可能是**来源失败码**而不是本域的
  语义 code——git 宿主侧在归档面损坏时报 `state-source-unavailable`（getter
  抛错）或 `state-source-invalid`（非数组 / 非字符串元素 / 空元素），四例均有
  测试钉住（归档面元素形状也校验，不被静默强转）。客户端只按 code 区分
  「确定性拒绝」与「结果不确定」，**不据此推断原因**；原因按 message + 刷新后
  的权威状态处理。
- **工作树侧判据（design 08 §5.2 同源）**：工作树删除**不停、不取消、不隐式归档、
  也不删除任何会话**；运行中的会话**仍然阻塞**删除，**除非它已归档（或它经
  subagent-origin 边链到的祖先已归档）**——宿主守卫为归档感知
  （`runningSessionIds` 是全部展示事实，`blockingRunningSessionIds` 只列非
  INERT 者）。INERT 判据只沿 **subagent-origin** 边
  （`session.header.origin === 'subagent'`），与本域 purge tree 完全同构——
  **fork 边终止链条，fork 永远不因其来源会话被归档而 INERT**（fork 是独立
  会话，且不在 purge tree 内）；成环规则：先判归档、后判成环（不含已归档成员
  的环永不 INERT；环上出现已归档成员按已归档祖先规则 INERT）；父 id 未加载且
  未归档、或 subagent-origin 行缺父 → fail closed 照旧阻塞。该判据在**每条**
  mutation 腿重读归档集合（首次删除、rollbackCreate 的 path 腿、remove 的
  receipt / reconcile 重放腿），期间取消归档立即恢复阻塞。因此**归档管理器是
  唯一「先停止运行中的回合、再清理已归档内容」的入口**，工作树侧没有任何停止
  编排，本域也不因工作树删除而新增任何执行权。
- **i18n**：`shared/archive-purge.ts` 只返回
  **字典键 + 参数**（`PurgeNoteLine { key, params }`，`archivePurgeNote` 返回
  `{ kind, lines }`，`purgeRefusalReason` 返回键），**不内联任何文案**；对话框
  用 `t(key, params)` 渲染（`src/client/locales.ts` 的 zh/en 双字典，zh 为键集
  源、`en satisfies Record<SidebarKey, string>` 由 tsc 强制完整）。该模块与字典的
  唯一耦合是**类型导入** `SidebarKey`（运行时擦除，`locales.ts` 无 import，故无环），
  既保持 `shared/` 不含字典值，又让键在编译期受检查。
- **UI 预检**：管理器在**渲染时**用同一个
  `purgeRefusalReason` 禁用行内与底部的删除控件，并把拒绝原因作为控件的
  `title` 就地说明（镜像 git 对话框的 `runtime-unknown` 预提示）；
  `runPurge` 内保留同一门作为兜底，禁用态竞态也到不了 wire。

## 6. 侧边栏 UI（server 行 hover 动作与归档管理器）

位置与行为（`packages/dsh-chamber-client-ui-sidebar/src/client/SidebarRoot.tsx`
+ `ArchiveManagerDialog.tsx`）：

- 锚点：来源分组头（server 行）hover 操作簇——现状为 排序菜单 /
  add-workspace `+` / 搜索 三枚（`cc.sourceActions`）；在簇尾一枚删除图标按钮
  （`IconTrashOutline16`，size 14 与 workspace 删除一致），点击**打开归档管理器
  对话框**。簇宽 64→86px、header 28px 定高不变，「无 reflow（垂直）」声明成立。
- 呈现/隐藏条件与同簇按钮**逐字一致**：`server.connected &&
  (server.aggregateError === undefined || search?.expanded === true)`；
  断连/聚合错误时不显示；折叠态 header 常驻、按钮仍可达（fold 只藏 header
  之下的内容）。
- 交互流（**全流程 per-server 单飞**）：
  1. 点击 → `stopPropagation` + `suppressClickRef` 检查 + `clearPendingClick()`
     （照抄同簇按钮三件套；拖拽豁免/keydown target 守卫均为泛型机制，自动覆盖
     新按钮——需维护的只是**注释清单**：SidebarRoot dragstart 按钮豁免注释、
     pending-click.ts 顶部注释、CSS 簇内容描述，archive-cleanup 已列名）；
  2. 单飞守卫：per-server in-flight，在途时按钮 `disabled`（disabled 瞬时不可
     聚焦，与键盘纪律并存）；跨 N-ctx 的并发由**宿主侧单飞**（`busy` code，§3）
     兜底；
  3. 对话框打开（**不发任何新读取**：行元数据 = 桥投影的
     `archivedSessions` ∩ `archivedSessionIds`，`deriveArchivedSessions`，仅
     元数据、不读会话内容）；
  4. 对话框状态：**挂载基线就绪且 `archiveSetKnown:true`** 才列行；
     空列表（权威）时 footer 删除钮 disabled（`listVisible` 的 `rows.length>0`
     并非冗余：同派生同时门控 footer，化简会让权威空态露出 disabled 删除钮）；
     `archiveSetKnown:false`
     （unary 兜底，KNOWN DEGRADATION）与快照未落地（loading/拉取错误）分支只
     呈现说明性文本（degraded/listUnavailable/loading），**无任何破坏性动作**；
     自愈路径：来源挂载基线就绪后 bridge 重新发布，对话框从 server prop 自动
     重新派生为列表视图（无需重开）；
  5. 列表 = 顶部全选行 + 每工作区一个可折叠组段。全选 checkbox 语义 =
     选中**当前列出的全部行（含折叠组）**；组头 = 组复选框（原生，部分选中经
     ref 设 `indeterminate` 三态 + 显式 `aria-checked="mixed"`）+ 折叠钮 +
     标题（600 字重、省略号）+ 「已归档 N 个会话」计数（复用 rowCount 键）。
     折叠为**对话框本地视图态**（默认展开、不持久化、不与导航 folded 互扰、
     只藏行不改选中）；  6. 破坏性动作只有一处：footer 的**条件渲染「删除选中（N）」**（列表视图且
     选中数 > 0）。**没有独立「删除全部」按钮**——整集清理的唯一路径 = 用户
     显式全选后再确认带计数的「删除选中」，`runPurge` 必带 `sessionIds`
     数组，UI 不存在 `purge(undefined)`（整集）调用路径；确认文案携带实际
     计数（`confirmSelected`），对**所选行树（含其子代理内容）**负责——不再有
     「不限于当前列表」的整集承诺；
  7. **两段式确认门（对话框内武装态）**：破坏性动作不走 OS 原生弹窗、也不叠
     第二层 Modal（官方 Modal 每开一次注册一个 document 级 BUBBLE Escape
     监听、互不知晓——叠层时一次 Esc 双关，且无官方嵌套先例）。改为对话框内
     `confirming` 状态：id 列表在武装瞬间冻结 + 单行标题或计数文案 → 行输入
     全冻结（`inputLocked`：checkbox/行删除钮/全选禁用；折叠钮保持可用——视图态）
     + 面板顶部**风险条**（官方 Warning 图标 error 墨 + color-mix error 9%
     底 + 陈述式不可恢复文案 + 官方 Button sm 对：取消/确认删除）。取消或
     **Esc 解除武装**（Esc 经 document CAPTURE 相位 stopPropagation，官方 Modal
     的 bubble 监听不触发——武装期 Esc 绝不关对话框；解除后 Esc 恢复默认关闭
     语义）；确认删除 → 解除武装 → `runPurge(冻结 ids)`。焦点：武装落**取消**
     （条内首个 button，安全默认）；取消/Esc 焦点回**武装源控件**（行删除钮/
     footer 钮，`isConnected` 兜底 panel；解除后经 `requestAnimationFrame` 延迟
     回焦——武装期 opener 仍带 `disabled`，对禁用控件的 focus() 是规范 no-op）；
     确认后条卸载致焦点落 body → busy/rows 双依赖的既有焦点兜底效应接管。
     文案为陈述式（非问句），`archive.manager.confirmDelete`/`confirmSingle`/
     计数键 chrome；`role="alert"` 挂在**纯文本消息 span**（容器首钮同 commit
     抢焦点 → SR 播报竞态，APG 文本性 alert 惯例）。单选与多选共用同一条，
     只换主体文案；
  8. **关闭策略统一**：Esc/X/遮罩任意时刻可关；关闭**不取消**宿主 purge；
     `chamberBridge.requestRefresh(server.id)` 仍无条件发出——注：requestRefresh
     对 live 来源是即时 mutation-pull（App.tsx 对每个 live 来源无条件拉取并
     合并会话行，不是 no-op），两者都不改变可见列表（归档/子代理行本就不可见），
     属惯例性调用，与 archive 动作一致；§12 的会话列表刷新请求同样不因关闭
     丢失；焦点圈闭（Tab）+ 关闭后焦点还原；
     武装期关闭（X/mask/非武装态 Esc）只丢弃武装、绝不删除任何内容；
     武装期 footer「删除选中」隐藏（防双入口）；bridge publish 把列表收成
     空/降级视图时风险条仍在（渲染在视图模式条件外）——accept 仍按冻结 id
     执行，宿主交集语义保证安全方向，空结果走「没有可删除…」兜底；
     焦点丢失守卫在列表视图消失后的 accept 也能落 panel；`server === null`
     时自动解除武装（旧冻结 id 不得随新列表复现）。
- **列表分组**：归属在 App 派生层计算（derive.ts，零新增宿主读取、零 wire
  改动）：`ArchivedSessionMetaRow` 带可选 `workspace?: { id, title }`；
  `deriveArchivedSessions` 建立归属索引——**权威成员关系优先**
  （snapshot workspaces 的 sessionIds，registry header 索引：归档不摘除
  成员、内容清理才自愈账目），其次**规范 cwd==path 回退**（尾分隔符
  归一化的等值比较——`canonicalPathKey` 提升为模块级、与
  projectInstanceSnapshot 的 cwd 合成共享同款文档化限制），两者皆不中 =
  无归属（删除的 workspace 的孤儿会话 → 管理器「未分组」桶）。纯函数
  `groupArchivedRows`（导出、node 单测）：组按**组内最新会话倒序**、
  组内按 recency 倒序、未分组桶恒尾置（导航 trailing-bucket parity）。
  `deriveArchivedSessions` 带零行快速路径（`archivedSessionIds` 空或过滤零行
  直接返回，不建 Set/索引/排序）。
- **缩进与容器**：分组列表的 session 行相对组头**嵌套一级**：每个展开组把行
  渲染进专用嵌套容器 `.archiveManagerGroupRows`（`padding-left: 24px`，祖先侧
  缩进——不用结构子选择器 + 子级 margin：行类同时被顶部全选行复用，层级语义
  不应由 DOM 位置推导，容器 padding 对包裹/虚拟化天然兼容）。几何：组头标题
  x = 8 pad + w + 8 gap + 16 折叠钮 + 8 gap = **40 + w**；嵌套行标题
  x = 24 step + 8 pad + w + 8 gap = **40 + w**——原生 checkbox 宽度 w 在两边
  抵消，任何平台下**行标题列与所属组标题精确同列**，层级由 checkbox rail
  台阶（8 → 32）+ 折叠钮表达。全选行与组头保留外列；未分组桶行同规。
- **视觉与焦点**：组头折叠钮复用导航同款 chrome（本 css module 的
  `foldToggle*`/`foldChevron`/`foldFolder` 类 + `workspaceAccentStyle(server.id,
  key, gitFlag)`，git flag 已加载时同 seed——accent 与导航同工作区一致）；
  行删除钮并入模块 `.actionIcon` 家族（`actionIconDanger` 修饰 hover 转 error
  ink，20px 命中 + 纯色 hover，disabled 与焦点环随基类）；焦点环常数合并为
  `.actionIcon:focus-visible, .archiveManagerGroupHeader .foldToggle:focus-visible`
  单一规则表（+1px 外扩）；`workspaceHeader:hover`/`archiveManagerGroupHeader:hover`
  与 `sessionRow:hover`/`archiveManagerRow:hover` 并入导航共享选择器表；
  busy 整头 60% 变暗改为**仅复选框**变暗（折叠钮 busy 期仍可用，视图态）；
  purge 刷新卸载聚焦行后焦点落 body 的**回焦 panel 兜底 effect**（非 trap）；
  danger 动作 = 官方 Button outline + error ink；原生 checkbox +
  accent-color（官方无 Checkbox 组件）；footer Button/icon/字体均走 alias token；
  spinner 13px（导航 12px）随所在行高；在途 spinner + `aria-busy`。
- **运行结果内联呈现**（`role=status`/`role=alert`，zh 硬编码）：完成摘要
  （`deletedSessions+deletedSubagents > 0` 时「清理完成：删除 X 个会话 /
  Y 个子代理内容。」）、运行跳过（`skippedRunning > 0` 无论有无 errors 都补
  「已跳过 N 项运行中的会话（未删除）」）、部分失败（`deleted>0 && errors>0`
  走 `role="alert"` 错误行 + 完成摘要 + 「N 项失败，可重试（重复执行安全）」，
  明细前 3 条）、全失败（`deleted===0`）按错误呈现、busy、域缺失 404、超时/
  网络中断诚实文案、`truncated` 提示、孤儿清扫计数（`clearedOrphanMembers`）、
  `skippedLoaded`/`forceUnsupported` 的如实说明。**错误绝不静默**；
  **成功无系统级横幅**（与「归档」动作一致——动作对象不可见），成功/空态为
  中性 `cleanupNote` 样式。
- 空态：`deletableSessions === 0 && deletableSubagents === 0`（双零）时不进
  确认，改在对话框信息行呈现提示：`skippedRunning > 0` → 「没有可删除的
  已归档会话（N 项因运行中被跳过）」，否则「没有可删除的已归档会话」。
- 键盘可达：真实 `<button>` + **title 属性 + aria-label**（簇内按钮全部用
  title 属性，无 Tooltip 组件——Tooltip 仅用于 rail/New Session 区域）。
- **locale 键**（en/zh；对称由 `locales.ts` 的 `SidebarKey = keyof typeof zh`
  + `en satisfies Record<SidebarKey, string>` 类型门禁保证——**typecheck:sidebar**；
  注意 `verify:i18n` 只校验顶层双语文档对，与此无关）：
  `action.purgeArchived`、管理器按键（`archive.manager.*`：选择/组选
  `groupSelectAria`、`selectAllAria`、确认 `confirmDelete`/`confirmSingle`/
  计数键、`degraded`、`listUnavailable`、`loading`）、复用既有
  `workspace.expand/collapse`、`list.ungrouped`、`rowCount`；行内错误/信息
  （domainMissing / 超时 / 空态 / 部分失败 / 跳过 / force 回退说明）按 §5 定稿走
  zh 硬编码，不进 locale。`archive.manager.deleteAll`/`confirmAll` 不存在
  （独立「删除全部」已退役）。
- 范围：**v1 不做**搜索/目录过滤/恢复（无 unarchive wire）；rail/窄栏与移动端
  不做（范围声明见头部）。

## 7. 宿主包接线与分发面

> 每个枚举 chamber 宿主包的位置都有断言/测试——**先改断言让测试红，再接线**，
> 不会静默漏挂。本清单按类别列全：常量/seed 面、探针契约面、分发/打包面、
> 门禁面、文档面。

**A. 新包本体**：`packages/dsh-chamber-seed-archive-cleanup/`（src/index.ts +
src/core.ts + src/binding.ts + scripts/build.mjs + test/*.test.ts + **提交态 dist**）。
根 `.gitignore` 需为 `packages/dsh-chamber-seed-archive-cleanup/dist/` 新增否定
（并入既有「chamber host 包提交态产物」按包否定块——按内容描述：
`# The chamber host packages ship committed esbuild artifacts…` 注释段 +
逐包 `!packages/<pkg>/dist/` 与 `!packages/<pkg>/dist/index.js` 否定行，
**不引用行号**：行布局随包增删变化）——否则提交态 dist 无法
入库、CI 缺产物 → seed 跳过 → 激活失败。

**B. control-plane seed 面**：`host-graph-seed.ts` 新增 `HOST_ARCHIVE_CLEANUP_*`
常量（PACKAGE_NAME / INSERT_ID / INSERT）；`index.ts` `seedEntries()` 第三行 +
`probeDomains: ['archiveCleanup/probe']` + 新
`DEFAULT_HOST_ARCHIVE_CLEANUP_PACKAGE_SOURCE_DIR`；`ControlPlaneOptions` 新增
`hostArchiveCleanupPackageSourceDir` 选项（desktop main 传 dist 打包路径，
缺省 REPO_ROOT 下源码目录；absent 时 ensureSeedPackage 静默跳过——安全）；
`host-graph-seed.test.ts` / `cordis-inserts.test.ts` 常量数组。
注：`probeDomains` 是**纯元数据、无代码消费方**（host-graph-seed 注释自我
声明与激活探针集靠人肉同步）——新增行时必须同步本清单里的三处。

**C. 探针契约面（design 18 §3.4）**：
- `dsh-runtime/src/activation-gate.ts`：`REQUIRED_ACTIVATION_PROBES` 含
  `'archiveCleanup/probe'`（激活探针打零成本 `probe` 端点而非 `preview`——
  preview 保持仅用户点击路径；probe 不读会话数据、无 IO、响应与会话量解耦，
  恢复 design 18 §3.4 探针契约）；`HOST_DOMAIN_PROBE_NAMES` 含第三域（typed
  subtraction 守卫保留——拼错域名的行会在缩减集断言处红）；
- **期望集按实际 seed 派生**（替代二元 `hostDomains` 布尔）：期望
  探针集与 chamber-domain 探针行按本次 spawn 实际 seed 的宿主条目派生
  （`syncedHostDomainProbeNames` 逐包派生 → `activationProbeNamesForDomains`；
  二元 `hasSyncedHostSeed` 已删除；seed 清单逐条 `probeDomains` 为源；空缓存 =
  空域集，兼容 gateway 未同步形状）；local/desktop 与 gateway runtime-manager
  共用该派生。等价性：空缓存派生集 ≡ 基础探针集
  `PROBE_NAMES_WITHOUT_HOST_DOMAINS`（4 项，不含 chamber 域），向后兼容；
  部分缓存派生 = 对已挂载域做强于旧语义的验证（2-of-3 部分同步不会再与静态
  期望集错配而 observe→fail→回退）；
- **探针 accept 语义**（新域无 gitWorktree 式「确定性业务拒绝」输入可依赖）：
  accept = generic envelope `ok:true` 且 domain 结果形态良好（value 为对象）；
  `ok:false` = 在位但异常 → fail-closed；
- 提交态产物：**`packages/dsh-runtime/dist/index.js`（dsh-runtime 的提交态
  dist，承载探针常量；包 main 指向 dist）**——desktop 经 runtime-probes shim
  消费包 main，cross-package-contract.test.ts 钉提交态 dist，dist-sync.test.ts
  锁定同步；
- **rollout 顺序（激活是硬门）**：desktop 启动事务/暴露门控跑全量探针
  （main.ts startAndProbeWorkspace），fail→observe→fail→回退——探针集改动、
  seed 行与提交态 dist **必须同 commit 落地**，否则本地启动事务失败；
- 测试：runtime-probes.test.ts（精简集/顺序断言 + 第三域与部分派生 fixture）、
  desktop/gateway 锁步断言。

**D. desktop 分发/打包面**：`plugin-sync.ts`（CLIENT_GRAPH/GIT_WORKTREE/
ARCHIVE_CLEANUP 常量 + `seedRemoteChamberHostPackages` + main.ts
`chamberHostPackageSeeds`/`localChamberHostPackageSources`/打包路径）、
`scripts/build-host-graph-package.mjs`（packages 数组含第三包 → desktop
`dist/` 内嵌包源）、`plugin-sync.test.ts` / `ssh-provider.test.ts` /
`gateway-provider.test.ts`（上传清单 fixture）。
**门禁面**：根 `package.json`（`build:host-*` 并入 `build:host-packages`、
`typecheck:host-archive-cleanup`、`test:host-archive-cleanup` 别名）、
`.github/workflows/ci.yml` 与 `release.yml` 的逐包 typecheck/test/host-build
步骤、`scripts/dev/release-preflight.mjs` 逐包步骤。

**E. gateway 面**：`plugins.ts` `SYNCABLE_HOST_PACKAGES` 第三行 +
`index.ts` `extraSeedEntries` 第三行（desktop-synced sourceDir）；
`runtime-manager.ts` 探针期望走 C 的派生实现；测试数组（feature-lifecycle /
chamber-installed / runtime-routes——真探针 fixture 需答第 7 端点 /
plugin-spec-lockstep：新包名 `@dsh-chamber/*` 在保留名拒绝集内（scope 前缀
判断），自动覆盖）。gateway build.mjs **不改**（宿主包已不在 gateway 内嵌，
mobile 是唯一打包例外）。

**F. settings-connections**：PluginDialog 内建组件表
**不新增 archive-cleanup 三态行**（v1 取舍）：v1 仅做
**常量级归类修正**：`plugin-inventory-text.ts` 的
`classifyInventoryEntry`/`chamberKindOf` 加第三包——否则该包
在 gateway 插件清单（Loader inventory 驱动）里会以 **third-party** 误标显示
（现只认 client-graph/git-worktree/mobile）。域状态诊断 = 侧边栏 404 文案 +
插件清单归类。
三态行代价清单（后续可选增强，未排期）：
(a) `plugin-sync.ts` `ChamberInjectionState` chamber 块第三键 +
`localPluginList`/`probeRemoteChamber` 实时探针 + 主进程
`LOCAL_PLUGIN_LIST`/`SSH_PLUGIN_LIST` live adapter；(b) IPC 类型镜像三处：
renderer / settings-connections 两侧 `global.d.ts` + `preload.cts`
`ChamberInjectionState` 镜像位（`ipc-surface-mirror.test.ts` 断言三镜像位）；
(c) `ChamberSeedDriftState` / `plugin-inventory-text` 两键形状第三键；
(d) 测试 fixture（desktop plugin-sync/gateway-provider、settings
chamber-seed-drift/control-plane）。
**IPC 面**：v1（不含三态行、仅常量归类）**不新增任何 IPC channel /
管理 REST / 反代改动**；若后续采纳三态行，上述代价清单即为增量。

**G. 零改动面**：control-plane 反代、gateway 默认代理、桥契约
（ChamberServerAggregate）、derive/聚合投影、CLI。

**H. 文档面**：枚举宿主包/域的位置都必须含第三包（否则出现明文矛盾）——
design 05 §6（宿主包 2→3）、design 02（loader id 表 / 宿主包附着表）、
design 18 §3.4（域枚举文字，随常量同 commit）、designs 09/13/16/17 中枚举
宿主包的表述、design 01 §3 地图行、STATUS.md。

## 8. 兼容与降级

- 老/未挂域实例：端点 404（含「方法不在该域」）→ 行内诚实文案（§5/§6），
  与激活探针的「check or upgrade」同精神，**无 legacy 回退、不静默**；404
  开关限定 archiveCleanup 访问器，不与 control-plane 的未知实例 id 404
  （`instance_not_found`）混淆；
- **旧宿主（零参 purge）**：子集过滤与 `force` 都被泛型网关的精确参数校验
  拒绝（`gateway/arguments-invalid`）——新 UI 下旧宿主拒绝管理器的**每一次**
  按条删除，提示如实改为仅建议重启 dsh（不再有「删除全部仍可用」后缀）；
  force 路径的「去掉 force 重试一次」见 §5；
- 无已归档内容：preview 空计数 → 空态提示，不进入确认（empty 与全被跳过
  子句的优先级见 §6）；
- **无挂载基线的来源**：`archiveSetKnown:false` / 快照未落地的降级窗口内
  **无法清理任何已归档内容**（非破坏性降级分支，§6）。这是登记的范围后果：
  v1 全量 purge 曾在未挂载来源可用，能力回归为用户决策接受；若未来需要，
  须等 unary 侧出现归档集 wire 或上游 delete wire（§11 退役条件同源）；
- 断连来源：按钮不呈现（与同簇一致）；not-ready 503 由 wrapWireError 给
  既有文案；重连后不弹陈旧计数（对话框从 server prop 重新派生）；
  **重连双确认窗口**：断连清理 effect 会清掉本地 in-flight 标记，而宿主侧
  purge 可能仍在运行——重连后的再次确认与先行 run 重叠属接受窗口，由宿主
  `busy` 单飞兜底 + purge 幂等收敛，不引入新防护门；
- purge 超时/中止：客户端超时不取消宿主删除；以「可能仍在进行、可重试、
  重复执行安全」诚实呈现（§5/§6），**不诱导用户误判为失败**。

## 9. 测试与验证

- `core.test.ts`（纯 fixture，不依赖 vendor，同 git core 模式）：候选集 /
  孤儿 id / 级联枚举 / 运行子树跳过 / **children-first 顺序与崩溃乱序收敛** /
  幂等重跑 / 逐项错误隔离 / 账目自愈 / archived 成员最后移除 / 每会话复检 /
  子集过滤（covered 祖先同选、archived subagent 行独选、重复 id、畸形过滤
  零读取）/ 树中止与 rerun 收敛 / 孤儿清扫（两次批量枚举都缺但官方单 id 读
  证明有内容 ⇒ 不清、空语料与塌缩语料门、确认读列出即不清、并发 purge 不
  重复清、probe 失败/缺失/非布尔一律 fail-closed、并集枚举保住仅 persistence
  可见的记录、预算截断注记）；
- 域门面：方法名与 envelope、零参 `{args:{}}` 形状、`sessionIds`/`force`
  payload 形状、domainResult 载体、**busy 单飞**（并发 purge 第二个调用得
  `ok:false busy`）；
- binding：真 binding/RunGate 单测（无装饰器直测）——`assertHeaderShape`
  通过/全缺/缺存储三态、`locate` 接收者调用（this 敏感 fake，见 §10）、
  `stat` 语义 fail-closed、running/loaded/force 三态 + status 漂移拒绝 +
  facts 拆分、`stat`/`locate` 面缺失三态；
- 探针契约：期望集**部分派生 fixture**（2-of-3、空缓存、全量三态）、
  accept 语义、dist-sync / cross-package-contract 锁步——先红后绿；
- 接线面：host-graph-seed / cordis-inserts / desktop plugin-sync /
  gateway 列表断言扩展（先红后绿）；根脚本/CI/release/preflight 逐包腿；
  生产端接线由**源码文本契约守卫**（`producer-purged-wiring` /
  `app-purged-memory-wiring` 钉住调用形状与顺序，不证明运行时语义，§12）；
- 客户端 wire：`instance-api.test.ts`（client 对象 stub + global fetch stub）：
  404/503/超时分类、畸形双层载体 fail-loud、有界 404 判别体、wrapper 层错误
  类映射、`force` payload 形状、`session/cancel` 请求形状、force 回退与
  `forceUnsupported` 标记、旧宿主拒绝文案；
- 客户端编排纯函数：`archive-purge.test.ts`（闭包停止与无血统退化、当前会话
  排除覆盖闭包、`closureUnknown`/预检两门、not-found 幂等）；
- UI 逻辑（纯函数可测部分）：per-server 单飞状态机、empty/skipped 优先级、
  部分失败警告文案装配、`deriveArchivedSessions`/`groupArchivedRows`（成员
  归属优先于 cwd 的冲突 fixture、cwd 回退 + 尾分隔符归一、组序与未分组尾置、
  空输入与自洽排序）、`serversProjectionSignature` 参与
  archivedSessions/archiveSetKnown；该包无 DOM/UI 测试基建（test 脚本全 node
  纯模块）——**不承诺**「pending-click 守卫清单测试」（注释清单维护即可），
  对话框渲染面（无独立「删除全部」、降级分支无动作、缩进几何、武装态交互）
  验证 = typecheck + 打包版目检（§13）；
- git host/client 侧配套（design 08）：归档感知 running 守卫（未归档运行中
  会话阻塞、已归档不阻塞、已归档祖先使子代理 INERT、链条不可解析
  fail-closed、cwd 腿同规则、快照双字段投影）、客户端
  `blockingRunningSessionIds` 判定与旧宿主回退、快照解码；
- locale：en/zh 对称由 typecheck:sidebar 门禁（satisfies 机制），非
  verify:i18n；
- 门禁：`test:sidebar` / `test:host-archive-cleanup` / `test:renderer-shell` /
  `test:control-plane` / `test:desktop` / `test:gateway` / 对应 `typecheck:*` /
  `build:renderer` / `build:host-archive-cleanup`；
- 实机 E2E（vendor 树就绪 + 打包态，§13）：本地实例归档若干会话（含 subagent）
  → hover 动作 → 管理器列示/勾选 → 确认 → 磁盘/registry/事件验证 → 再跑幂等；
  gateway 形态（桌面同步 → managed dsh 重启 → 同链）；远程 dsh（ssh）同链；
  并发（两 ctx 同时 purge → busy）；超时续跑；
- 如实报告纪律：vendor 子模块缺失时哪些腿无法执行（build:renderer / 打包
  依赖 vendor 源码），不虚报。

## 10. 宿主面事实（vendor 核对结论）

在 vendor/harness-packages（pinned submodule，当前 pin dsh-v0.1.5-rc.1 183f08e9c6dd；
下列宿主面自 alpha.2 b2e3b2a0 审计以来未变）核对的宿主面事实，本域的 binding 与算法以此为准：

1. `workspaceRegistry` ctx 服务：`list()`/`archivedSessionIds`（public getter）/
   `archiveSession`（仅增向）可用；**成员 `sessionIds` 是 header 索引派生的
   getter**（启动/实时按 `sessionPersistence.list()` 重建）——内容删除后
   成员账目自动自愈，无需也不可手工改账目；
2. **归档顶层行可枚举**：官方 `sessionQuery.listSessions()`（live 优先 + 持久化
   合并，含 `header.origin`/`parentSession`/`cwd`）——与官方 session/list
   投影同源，`archivedSessionIds` 为 registry-global 集合；单侧枚举都会
   静默收窄，故 binding 取 `sessionQuery.listSessions()` ∪
   `sessionPersistence.list()` 的按 id 并集（§4 step 5）；binding 的
   `persistence.list` 回退守卫的是「已挂载但方法不全」的表面漂移并服务单测
   直用，**不是**缺失服务路径（cordis inject 语义下缺失服务根本不会启动）；
3. **官方进程内无会话内容删除例程**（persistence 抽象只有
   create/open/flush/stat/list；公开面自 0.1.3-alpha.1 起为 `stat`（`inspect`
   已退役），`locate` 降为后端**私有**方法但仍可经服务对象调用）→
   **分支 b**：`sessionPersistence.locate(header)` 给出官方绝对产物路径，作为
   **唯一目录锚**；
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
6. generic gateway：零参 Remote 的 envelope 要求（chamber 侧先例：
   `clientGraph/graph` 客户端 `{args:{}}`、git-api snapshot）；宿主侧参数名
   约束；`assertExactArguments` 对描述符外键**严格拒绝**（实测
   `unexpected "sessionIds"` / `unexpected "force"`）——新客户端请求到旧宿主
   绝无「静默全量删除」分支，该 `gateway/arguments-invalid` 在 purge wrapper
   重映射为 zh 重启提示（§5）；
7. cordis patch insert 三行共存无冲突（id/name 全局唯一）；
8. 会话存储布局（format.ts / sessions-root / header 索引）与原子写/持久化
   原语：`locate`/`format` 官方导出即足够，**布局知识零复制**；目录内可删
   条目白名单见 §13⑩；每次 append 按路径重新 `open(path, "a")`、头行只在
   创建时原子写入（§13 的 force 语义依据）；
9. `refresh()` 存在且 `mergeOrderedBaseline` 丢弃服务端缺失行（§12 收敛
   原语）；官方客户端 `SessionManager.summaries` 只在连接代数或显式
   `refresh()` 时更新——**任何会话列表刷新都必须以方法调用形态发起**
   （脱绑调用读 `this.manager` 会抛 TypeError 并被吞掉）。

## 11. 风险与上游收敛

- **上游未来落地 unarchive / sessions.delete**：收敛路径**机制化**——上游
  wire 随 vendor bump 出现即登记为独立 STATUS 跟踪项：客户端 wrapper 单点
  切到官方 wire（批量编排），宿主包按发行周期从 seed 清单退役，双协议不
  永久并存；§3 命名空间与官方分离保证切换无碰撞；
- **seam 退役**：上游 wire 落地即退役 `enqueueOperation`/`setState` seam +
  probe 端点 + seed 行，且结构 seam 核对列入每次 harness pin 升级清单
  （STATUS 跟踪项）；
- **本例外无先例效力**：§2 边界 5——其他会话域动议须重新评审；
- **探针部分同步**（老桌面↔新 gateway 交替同步）：§7 C 的期望集派生
  消除静态错配；派生实现是第三域上线的必要条件；
- **官方存储布局漂移**：锁步测试 + 目录内白名单 fail-closed（未知条目整单
  拒绝）防漂；
- **与运行中官方写路径并发**：只经宿主 service / 持久化原语 + live agents
  守卫 + 每会话复检；崩溃窗口由 children-first 顺序 + archived 集合收敛
  （§4 step 4/8）；
- **事件/投影一致性**：pinned 树无公开事件面，删除不经事件总线（§4 step 7
  文档化 no-op），mounted 来源推送与宿主内消费者的差距由 mutation-pull +
  官方启动 header 索引重建 + §12 收敛链闭合；收敛链的失效模式与残余见 §12/§13；
- **域错误可见性**：只经 domain 返回/宿主日志，不进 renderer 之外的任何
  表面；客户端「错误绝不静默」由 §6 槽位与部分失败警告保证；
- **B 路径风险**（进程外直删的内存覆盖/账目分裂）在本方案中不存在（§2），
  但仍是冻结项，不做任何形式的复活。

## 12. 会话列表收敛契约（purge 后幽灵行抑制）

**问题（shape of the defect）**：宿主删除对官方运行时不可见——`emitSessionRemoved`
等为文档化 no-op（§4 step 7），但归档集合的收缩经官方 `domain/changed` →
workspace follow `{type:'archived'}` 立即到达客户端（`api/workspace-controller`
的 `feed.ts` → `client/model.ts` `replaceArchived`）；而官方客户端 ctx 的
`SessionManager.summaries` 只在其 ctx 连接代数重建（`handleConnected` →
`refreshList`）或本地 mutation 帧、或显式 `refresh()` 时更新。于是生产端推送
「收缩后的集合 + 陈旧的行」→ chamber 的可见性过滤（archived ∩ rows）失去
覆盖 → **已删会话以普通行浮现**，点击即官方 `session/not-found`；且运行中
投影字段变化（running 位、活动时间、标题、blank、成员/分组）会把仍脏的行
重新推送，而 unary pull 又清掉 ⇒「推送装回、拉取清掉」的稳态振荡。
服务端读取面本身是即时自愈的（`session-persistence-jsonl.list()` 每次重扫
磁盘，`session-query` 的 `SessionCorpus.listSessions()` = 持久化重扫 + live
合并），滞留点只在官方客户端 ctx 的 `summaries`。相关宿主事实：vendor
`sessionIds` 为**内存 header 索引派生**，内容删除后至重启/下次实体写前，
官方 workspaceView 仍含该 id 的**占位成员**——因此「chamber 可见行不受影响」
不是可以依赖的断言，收敛必须显式做。

收敛机制（客户端零宿主改动；**无会话内容读取、无新 wire 端点**）：

- **桥通道**：`chamberBridge.requestSessionListRefresh(sourceId)` 广播 +
  `onRequestSessionListRefresh` 订阅（aggregate-store.ts，与 requestRefresh
  同构；05 §3 通道表同源）。挂载 ctx 的 sidebar 插件按
  `chamberInstanceId === sourceId` 匹配后**以方法调用形态**调用官方公开面
  `ctx.sessions.refresh()`（ClientSessions；脱绑调用是本机制的致命缺陷——
  `ClientSessions.refresh` 是读 `this.manager` 的原型方法，脱绑即 TypeError
  且 RPC 从未发出）。运行时守卫：方法缺失与调用失败均 console.warn——
  失效绝不静默；桥监听器抛错被同步防御包裹，不得中断 App 推送处理。刷新完成
  后 summaries 丢弃已删行 → store notify → 生产者 queueSnapshot → 推送干净
  快照 → App 全量提交替换聚合。未挂载来源无订阅者也不需要（其行走 unary，
  服务端逐调重扫）。
- **触发 1（App 收敛状态机）**：mounted 推送提交前对**每一次** ready 推送评估
  `planSessionListRefresh`（renderer `aggregate-refresh.ts` 纯函数）：
  (a) 检测**归档集合收缩**（`archiveSetShrink`：无 unarchive wire ⇒ 收缩 =
  宿主 purge 完成集合移除的唯一客户端可观测信号；仅两侧 `archiveSetKnown:
  true` 才产生，降级空集永不误报）；(b) 收缩移除的 id ∪ 上一轮未收敛
  （pending）id 中**仍以行存在于本推送**者 = 幽灵候选；(c) 幽灵候选非空即
  请求会话列表刷新，并按来源以 5s 冷却封底重发节流
  （`SESSION_LIST_REFRESH_COALESCE_MS`；官方 refreshList 单飞兜底并发；
  忙碌来源上失败的刷新不会逐推送堆叠 RPC）；(d) 行消失即收敛——pending
  清空、状态机自终止。**覆盖超时续跑（宿主晚完成后的收缩推送）、跨壳/他处
  purge、未来任何删除入口**；刷新瞬时失败由后续推送在冷却后重发收敛，被冷却
  压下的请求不丢 id（留在 pending 随下次推送重估）。行渲染的最终兜底：安静
  来源（推送停止）由 30s staleness 看门狗的 unary merge 拉取在 ≤1 个周期内
  把聚合 session 行换成服务端干净列表（行自隐），无需任何触发。仅推送侧评估
  是完备的：mounted 的 pull 提交保留当前归档集合（`commitAggregatePull`
  merge）、full-fallback 提交被 provenance 门挡住，pull 不可能先于推送观察到
  收缩。
- **触发 2（对话框即时路径）**：ArchiveManagerDialog 每次 purge settle
  （成功路径与 catch——超时/网络/busy 亦可能已有宿主侧删除落地）均请求
  一次，覆盖「收缩推送到达前」的窗口，且对话框关闭也不丢请求。对话框
  请求不进 App 的冷却戳（跨包解耦），与触发 1 在单次 purge 上重叠
  （≈2 次 session.list RPC，第二次通常空转）——purge 罕见、RPC 廉价，
  属有意的双通道冗余，非缺陷。
- **F1 墓碑抑制**（`shared/purged-rows.ts` 纯函数 +
  `shared/purged-tracker.ts` 状态机 + `client/index.ts` 接线）：
  生产端自己跟踪工作区 store 的权威归档集合（原始数组引用比对短路：官方
  `installArchived` 仅在集合内容变化时安装新数组，稳态成本 = 一次引用比较）；
  发生**严格收缩**时把离开集合的 id 记为墓碑，并从**上报的
  snapshot.sessions** 与**运行时事实通道**（含 `current`）中过滤，直到原始
  summaries 不再列出该 id、或它重新入集合（**无**「resolve 即释放」阀，
  见 F2）。诚实性依据：宿主 `core.ts` 的 `clearIds` 只包含**内容
  删除成功**的树与无记录孤儿（集合写失败时 id 留在集合 ⇒ 永不布防），因此
  「离开归档集合 ⇔ 内容已不存在」。首次观测永不布防（新 boot 的 summaries
  本就干净）。过滤在签名计算**之前**完成；无过滤时返回同一数组引用。
- **F2 校验式收敛链**（`shared/purged-convergence.ts`）：收缩与桥请求
  都触发链——**方法调用**官方 `ctx.sessions.refresh()`，随后按
  `ctx.sessions.list.byId` 校验墓碑 id 是否已消失：
  - resolve 且仍有残留 ⇒ 重试（官方 `refreshList` 单飞会把 purge 前的在途
    响应回给新调用者）；
  - reject ⇒ 重试（瞬时 RPC 失败且 summaries 未动）；
  - 每次尝试都有看门狗（默认 2×重试间隔）⇒ hung 刷新不会永久禁用 seam；
  - 达到 `PURGED_REFRESH_MAX_ATTEMPTS`（3，间隔 1.5s）后进入**权威探针**
    终态：用 chamber 自己的 unary `session.list`（经实例代理、每次调用重扫
    磁盘，无官方单飞、无客户端缓存）独立取一次行集合，**只释放它仍列出的
    id**（这些会话服务端确实存在 ⇒ 该次收缩并非内容删除，隐藏会丢活行），
    其余保持抑制并如实 warn；探针失败/超时一律保持抑制。
    **刻意不设「resolve 即释放」阀**：`refreshList` 在拉取失败时同样 resolve
    （summaries 未动）且单飞会把手上的 purge 前响应回给新调用者——按 resolve
    释放会重新打开幽灵行缺陷。
  - 链**单飞**（同来源请求加入进行中的链，不重启尝试预算），`dispose`
    取消挂起定时器；每探针独立句柄（探针迟到不得取消下一次尝试/下一次探针
    的看门狗）；探针在飞期间新布的墓碑不得被释放。
- **F3 App 侧权威归档集记忆**（`App.tsx` + `renderer/aggregate-refresh.ts`）：
  App 记住每来源最后一次**权威**推送的归档集合（随来源生命周期回收），并在
  两处使用——(a) 当已提交聚合失去归档集权威时作为收缩基线（否则「workspace
  基线先到、sessions 基线在途」窗口内完成的 purge 永久不可见）；(b) 降级 full
  提交（unary 兜底视图）携带该记忆集合而 `archiveSetKnown` 仍为 false
  （侧边栏据此继续过滤已归档行，管理器保持诚实的降级分支、不获得任何破坏性
  动作）。记忆集合永不单独构成权威。**顺序是承重的**：基线必须是**覆盖前**的
  旧值，否则 remembered ≡ 本次快照集合 ⇒ `archiveSetShrink` 恒为 []（F3(a)
  死代码）；`test/app-purged-memory-wiring.test.ts` 钉住该顺序。
- **F4 宿主 registry-global 孤儿清扫**：见 §4 step 5——每次 purge 收尾清
  全集合无记录成员，双重确认 + fail-closed + 同一次集合写 + 独立计数
  （`clearedOrphanMembers?`，归档管理器 settle 文案呈现）。
- App 状态机与归档管理器触发点**全部保留**：正常 purge 路径下 F1 过滤后
  `planSessionListRefresh` 看不到行（`kept=[]` ⇒ 不再请求），但它与 F3 一起
  覆盖「生产端未布防 / 首次观测即 post-purge」的形态。

**不变量**：桥通道契约不变（不新增通道、请求只带 sourceId、无会话内容）；
`archiveSetKnown` 三态/撤回/代际栅栏语义不变；无周期 RPC（墓碑与链都是
事件驱动、有界）；identity-preserving（无过滤时同引用）；每 ctx 生命周期
独立（`dispose` 清定时器与订阅）。

## 13. 已知偏差与残余

1. **实机门禁**（打包版 UI 目检，无自动化基建可替代）：purge → 切会话/任务
   完成不再浮现；点击不再 `session/not-found`；归档正常会话仍隐藏；两次连续
   purge；purge 后回收再打开；purge 后断隧道恢复；local/ssh/gateway 三形态；
   30s 合并窗口观测；对话框的视觉与键盘实感（缩进几何、组头折叠、武装态
   交互、回焦）与 `force` 链（卡在提问的归档会话 → 管理器删除 → 停止 + 强制
   清理成功；旧宿主无 `force` 时的回退 + 说明）；工作树侧「只对 INERT 会话
   放行」的实机验收（design 08 §5.2）——未归档的运行中会话仍然阻塞，已归档者
   不阻塞也不被触碰（跳过的是 INERT 成员，不是整个 RUNNING 守卫）；
2. **探针依赖实例就绪**：官方刷新与 unary 探针都失败时保持抑制
   （fail-closed），实例长期不可达时官方 summaries 的收敛延后到连接代数——
   行不可见（用户可见正确性成立），属验证类缺口；
3. **语义级接线**以源码契约测试 + 目检代证（`producer-purged-wiring` /
   `app-purged-memory-wiring` 钉住调用形状与顺序，不证明运行时语义）；
4. **归档集合 > `MAX_PURGE_SESSIONS`（65,536）** 时宿主不清扫（该规模全量
   purge 本就 `purge-capacity` 拒绝，不可重试、无逃生口直至上游 wire 收敛）；
5. **宿主侧未对构建后的 vendor backend 跑过真实 `stat`**（本 worktree 的 vendor
   为源码态）：`stat` 的 `undefined`/抛出语义由 pinned 源码阅读 + 形状一致的
   fake 确立（真机未跑）；
6. **合法空语料**（全部会话已删）下可信度门会跳过清扫，历史无记录成员因此
   不收敛（管理器不可见、无用户影响）——fail-closed 的代价；
7. **官方 `stat(id)` 的两分语义**（按 vendor `session-persistence-jsonl/src/index.ts`
   逐行复核）：**答 `undefined`** 仅限「id 无任何工件（ENOENT）」「首行为空或
   无法 JSON.parse」「header 畸形」；**抛错**的是非 ENOENT 的 IO/权限错误、**损坏的
   zstd 帧（解压失败）**、代际文件名与 header 版本不一致、以及**存储格式版本
   过新**（`SessionFormatUnsupportedError`）。答 `undefined` 的工件会被判
   「无内容」而**清掉成员关系**（成员不再可见），但其字节不会被本域删除
   （purge 只处理仍可枚举的会话）——跟随上游「是否还有会话」语义的代价，
   登记为已知偏差；**抛错**则 `hasStoredContent` fail-closed 返回 `true`
   （保留成员关系），purge 也删不了（无记录）——需人工处理；
8. **并集枚举每次多一次 `persistence.list()`**（可后续记忆化）；
9. **租约**：purge 会删除 `session.lock`，即放弃该会话的跨进程写互斥
   （vendor lease 明确警告 forfeits exclusion）；本域以「先停运行再清理」的契约
   约束调用方，跨进程场景不做探测（无 flock 依赖，见 §2 红线）；
10. **目录内出现未知条目**（上游布局漂移）时整单拒绝，该会话在修复前无法
    清理——fail-closed 的代价。**可删条目白名单**：规范代际名
    `session[.vN].jsonl[.zstd]`、发布临时名 `session[.vN].jsonl[.zstd].<12hex>.tmp`
    （vendor `link()+unlink()` 发布路径）、**迁移暂存名
    `session.migration.<16hex>.jsonl[.zstd].tmp`**（vendor `generation.ts` 迁移路径，
    `randomBytes(8).toString('hex')`；含本会话自己的迁移后日志）与写租约 `session.lock`；
    其余条目仍整单拒绝。识别迁移暂存名是必需的：否则一次中断的迁移会让该会话**永久
    不可清理**（fail-closed 拒绝且无人工入口），而它本就是这个会话的内容副本；
11. **最低宿主版本**：存在性权威 `stat` 与产物定位
    `locate` 都是官方 `sessionPersistence` 的面，`stat` 自 0.1.3-alpha.1 起才有
    （pre-0.1.3 为 `inspect`）。`assertHostSurface` 在激活探针里要求 `stat` ⇒ 旧宿主
    上探针 `ok:false`（activation gate fail，走 §7 C 的回退/拒绝语义），而
    `hasStoredContent` 在运行期对同一缺失返回 `true`（跳过清扫、不清成员）——
    **能力门响亮失败 + 运行期 fail-closed 降级**的分工：域的正确性依赖 `stat`，
    但绝不因为面缺失而误清成员。当前支持基线（0.1.5-rc.1）与回滚目标
    （0.1.3-alpha.2）都满足该面；
12. **force 路径与维护相位（不声称已解决）**：dsh 在**维护相位
    （maintenance phase）**期间对外仍报 `status === 'idle'`（vendor
    `packages/core/agent-loop/src/agent.ts`），因此一次 `force` purge 可能
    删掉一个**维护任务仍会继续追加写入**的档。客户端 `session/cancel` 能中止一个
    **活着的**维护相位，但新的维护相位可以在 purge 之前或 purge 过程中启动（宿主
    侧无法在一次 purge 内原子地阻止它）。**宿主侧没有廉价检测器**：维护相位不是
    「已加载 agent / attached session」这类公开事实，`liveSessionFacts` 看不到它。
    **REJECTED 备选**：读 vendor 的私有 phase 字段来检测维护相位——依赖上游内部
    形状、上游一改即静默失效（且会把「内部实现」变成跨仓契约），故不采纳。
    force 路径**不保证**对维护相位安全，收敛路径是官方 delete
    wire 落地后本域退役（§11）；在此之前，管理器的当前会话排除 + 停止回合是最佳
    缓解，不是保证；
13. **force 删除后残档机制**：`force` 删除的是「本进程已加载」的会话档，而宿主
    进程仍持有其内存对象——之后任一写事件会重建**无头残档**（JSONL 持久化每次
    append 按路径重新 `open(path, "a")`，头行只在创建时原子写入）。三条缓解：
    (a) 删除前先 `session/cancel`；(b) 客户端排除**当前正在查看**的会话（覆盖
    闭包）；(c) 已归档会话没有任何 UI 路径开始新回合。运行时通道缺失时客户端
    无法知道当前会话 → **不使用 force 路径**（§5）。**running 不能裸删**的理由
    同此机制；
14. **TOCTOU 残余**：两步编排（先读 `session/list`、后 `purge`）之间切换到某个
    选中归档根的子代理后代不会被这次读看到（§5）；彻底闭合需要上游把「当前会话
    排除」下沉到宿主删除语义；
15. **无挂载基线的来源在降级窗口内无法清理**（v1 能力回归，用户决策接受，§8）；
16. **desktop 激活恒全量 vs seed 产物门**为设计内取舍（构建期 preflight 兜底），
    不修；
17. **归档管理器 a11y/视觉残余**（模块级偏差，视觉腿复核）：行删除钮 20px 命中
    < WCAG 2.2 2.5.8 的 24px（模块图标按钮语言全局标准，为语言合并的结果）；
    武装期行 dim 0.6 × trash .42 ≈ 0.25 复合（token 对比度仍 ≥ AA——
    冻结核的意图反馈）；9% wash 强度与深浅主题可读性；风险条 SR 播报顺序
    （NVDA/VO）；窄卡换行与矮视口裁剪（<~480-540px）；行 aria 标签在重复/
    未命名标题下的非唯一性（追加 project label 或容器 group 语义待 SR 腿验证后
    定）；两处「取消」标签同现（条内取消 vs 头 X=action.cancel——X 语义为关整个
    对话框，保持）；held-Escape 连发无害；dark 主题 danger ink ~4.25:1 为 token
    级共享惯例；折叠钮 aria label 追加组名与初始焦点改列表首控件暂缓（需打包版
    目检确认读屏语序）；组内排序保留为纯函数自洽防御；
18. **`deriveArchivedSessions` 每源派生缓存未做**：App 侧按 identity-preserving
    aggregate 对象缓存未采纳（跨 mounted push/merged pull 双生产路径的缓存失效
    管理复杂化收益面窄），65k 规模 + 高频 derive 场景再现时再议；
19. **可选增强（未排期）**：PluginDialog 归档清理三态行（§7 F）、rowError 本地化
    （§5）；若上游 Modal 获得层级（stack/优先级/Escape 仲裁），确认弹层可迁官方
    `RiskConfirmation`。
