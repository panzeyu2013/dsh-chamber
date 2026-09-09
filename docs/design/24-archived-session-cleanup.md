# 24 · 已归档会话内容清理（server 行 hover 动作 · 第三个 chamber 宿主域）

> 状态：**已实现（delete-archived 分支落地并经合并 989534a 合入 main，
> 2026-12）**；定稿 v3 后的两道
> 实现门均已通过：① 宿主包例外评审——2026-12 用户拍板**跳过人工评审直接
> 执行**（§2 动议，AGENTS.md 例外清单与 design 01 地图随 M0 即改，台账
> D1–D7 按推荐值生效）；② vendor 源码前置核对——§10 已按 pinned vendor
> （dsh-v0.1.2-rc.1 a66e4702）执行完毕、host binding 分支 b 落地。2026-12
> 合入修订轮闭合评审残留（§14 残余定案 M1 / M2–M5 处置 / N1–N5，见 §15），
> 代码、测试与提交态 dist 同步；M4 实机 E2E 待验（见 STATUS）。2026-09
> 合入后修复轮（评审遗留闭合：成员失败中止语义/header 字段级 loud 校验/
> 客户端载体 fail-loud/注释对齐/死代码移除，代码与测试已落地于工作树未提交
> 态——处置登记见 §16）。
>
> **2026-09 修订轮（§17，用户驱动）**：M4 本地形态实跑完成——修复删除
> 失效根因（binding 脱绑调用官方 locate → `this` 丢失，实机每项删除报
> `reading 'root'`）；wire 修订 `purge(sessionIds?)` 子集过滤；交互升级为
> 归档管理器对话框（列示已归档会话 + 逐条/多选/清空全部）。§3/§5/§6 的
> 零参与确认按钮流表述以 §17 为准。
>
> **2026 用户修订（§18/§19，delete-archived 分支）**：归档管理器移除独立
> 「删除全部」按钮——整集清理必须先显式全选再确认带计数的「删除选中」，
> purge 永远携带明确 id 列表；降级/pending 视图不再提供任何删除动作；
> 列表按工作区分组、可折叠（§19）。§17.3/§17.6 中「删除全部仍可用/放行/
> 去计数」的表述以 §18/§19 为准。§19 条目 6–9（缩进容器化、整体匹配轮、
> 全面重构轮、四方分面评审处置轮）为合入后继续修订——wire/UI 表述以
> §19 最新条目为准；§20（purge 幽灵行收敛轮）为最新修订，交互表述以
> §20 为准。
>
> **2026 purge 幽灵行收敛轮（§20，delete-archived 分支续）**：purge 后已删
> 会话以普通行浮出侧边栏、点击报 `session/not-found` 的实机缺陷——根因为
> 官方客户端 ctx 会话行 summaries 仅连接代数刷新、purge 事件为 no-op，
> 归档集合移除后行失去过滤覆盖；§20 落地「官方会话列表刷新 seam」
> （chamberBridge `requestSessionListRefresh` + App 归档集合收缩检测 +
> 对话框 settle 即时请求），并修正 §15-② 的「chamber 可见行不受影响」
> 断言（实机证伪）。
>
> v2/v3 修订：2026-12 由三个只读 subagent 分面评审（客户端 UI/wire、宿主
> 域与分发接线、契约治理）+ 作者自审 + 一轮 v2 合规复核（闭合矩阵 12 项
> 全部核实），结论零 Blocker；全部 [Major] 与高优 [Minor] 已并入本版
> （§0 修订记录）。代码级引用（行号）均经评审逐条核实。
>
> 承接并修订 `docs/progress/todo/12-todo-archived-sessions.md`（归档单向、
> 不可见、上游无 delete/unarchive wire 的事实核实仍以该文为准）；todo 12 的
> 方案 B（控制面/主进程特权层直删）继续冻结，本方案用「实例进程内的 chamber
> 宿主域」替代它的位置——不是 B 的翻版，理由见 §2。
>
> 用户决策记录（2026-12）：交互锚点 = chamber 侧边栏**服务器分组头行
> （server 行）hover 操作簇**；执行层 = **新增 chamber 宿主域插件**（实例
> 进程内、宿主权威状态执行删除）；本需求面向 chamber 桌面与 gateway 部署
> 的所有来源形态（local / gateway-managed / 远程 dsh）统一生效。范围声明：
> 移动端（ui-mobile，无 hover 表面）与侧边栏 rail/窄栏形态**不在 v1 范围**
> （§6）；若未来需要移动端入口，另行设计（触屏确认流与桌面 hover 不同形）。

## 0. 评审修订记录（v1 → v3）

| 来源 | 发现（要点） | 处置 |
|---|---|---|
| C-Major-1 / A-M1 | purge 被 `instance-api.call()` 固定 30s 上限硬切，超时文案裸奔 | §5 超时预算 seam + 诚实超时文案 |
| C-Major-2 | `ok:true + errors[]` 部分失败在「成功无横幅」下静默 | §1/§6/§8 部分失败带警告呈现规则 |
| C-Major-3 / B-M3 | 激活探针期望集是二元 hostDomains；第三域 2-of-3 部分同步会期望错配回退 | §7 期望集按本次 spawn 实际 seed 域派生 + 探针 accept 语义 |
| C-Major-4 | 删除顺序未定义则「崩溃收敛」不成立 | §4 children-first + archived 成员最后移除 + 乱序测试 |
| C-Major-5 / B-m3 | 文档同步清单不全且全押 M4 | §12 文档同步时点表（M0/M1/M2/M3/M4 分摊） |
| C-Major-6 | 「镜像上游草案」缺可验证锚点；收敛承诺未机制化 | §4 逐条映射表 + §10 核对项 + §11 机制化 |
| A-M2 / B-m1 | 404 域缺失文案无处落（call() 私有、generic throw、404 双重语义） | §5 call() 可选开关 + 专用错误类 + 消费点定稿 |
| A-M3 | server 级错误渲染点不存在；照抄 add-workspace 先例在折叠/搜索态静默吞错 | §6 header 下方新渲染点（fold 门之外）+ 全流程单飞 |
| B-M1 | 「IPC 面零改动」与内建表三态行矛盾 | §6/§7 v1 决策：不新增 PluginDialog 内建行（M4+ 可选增强，代价清单列明） |
| B-M2 | 根脚本/CI/release/preflight/.gitignore 逐包面遗漏 | §7 补全 |
| B-M4 | §10 缺事件名精确化/归档行可枚举性/running 位来源 | §10 扩充 |
| A-m4 | 「verify:i18n 纪律」标签错误（仅校验顶层双语文档） | §6/§9 改为 typecheck:sidebar 的 satisfies 对称门禁 |
| A-m8 | requestRefresh 对 live 来源非 no-op（App.tsx mutation-pull） | §5/§6 双通道语义注记 |
| A-m5/m6/m7/m10 | 守卫「清单」实为注释、Tooltip→title、confirm 计数语义、`server.aggregateError` | §6 逐条修正 |
| 合规复核 M-1 | M1/M2 边界缺 runtime-probes 第三域执行腿归属 | §7 C/§12 M1 明示执行腿 + accept 语义归 M1，18 §3.4 文字随 M1 |
| 合规复核 M-2 | §12 M3 文档同步漏 05 §2.3 同源陈旧注记 | §12 M3 补 05 §2.3 |
| 合规复核 M-3 | 404 开关缺 body-code 判别规则（instance_not_found 两义） | §5 判别规则 |
| 合规复核 M-4 | §7 F 代价清单不全；gateway 清单 third-party 误标前提 | §7 F 归类常量修正 + 全量代价清单 |
| 合规复核 N-1/N-2/N-3 | .gitignore 行号 / skipped 无呈现 / 自指残留 | §7 A/§6 step 5/§6 措辞 |

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

## 2. 契约动议：为什么可以在 chamber 内补这个 wire

相关红线原文与它们真正约束的对象：

| 红线 | 约束对象 | 本方案如何不触碰 |
|---|---|---|
| 05 §2.2「wire 缺失的方法不做（如删除会话），不发明协议」 | chamber 在**官方 unary 面上**为会话伪造客户端可调协议 | 不在官方 controller 面上加方法；新增的是 **chamber 自有宿主域**（同 gitWorktree 先例），命名空间与官方彻底分离 |
| AGENTS「会话业务是 dsh 前端运行时的事；控制面不消费宿主会话」 | control-plane / desktop / renderer 不得成为会话权威或执行面 | 删除执行体是跑在 **dsh 实例进程内**的 chamber 宿主包（同 design 08 信任模型），control-plane / desktop / gateway 主进程零接触会话内容；客户端只提交「删除已归档」意图，不提供路径、不读内容 |
| todo 12 方案 B 冻结（特权层编辑 workspace.json / 删会话目录） | **进程外**特权层直删：运行中宿主内存覆盖、账目分裂、越权 | 本方案在实例进程内、经宿主 ctx 服务（`workspaceRegistry` 等）读权威状态、经宿主自己的持久化/事件路径执行——不存在内存覆盖问题（§4） |
| OpenChamber 范式「manager 只消费 harness API，不自己动 harness 文件」 | manager 层 | 同理成立：chamber 宿主包运行在 harness 进程内（git-worktree 已是先例） |

例外动议的**边界必须收窄**，评审据此放行：

1. 域只做「已归档集合的内容清除（含级联）」一件事；**不做** unarchive、不做
   普通（未归档）会话删除、不做任何会话内容读取/检索/导出、不做字节统计；
2. 域无读取面：`preview` 只返回计数，不返回标题/路径/内容投影；
3. 删除语义逐条镜像上游 `sessions.delete` 草案（todo 12 §5.2，逐条映射表见
   §4），**不发明新语义**；上游 wire 落地后本域收敛退役（§11），chamber 不
   永久 fork 会话域；
4. 该域随 chamber 分发并 seed 到所有实例形态（本地 spawn overlay、远程 dsh
   ready-time seed、gateway managed dsh 桌面同步 seed），任何形态下管理器
   进程都不获得新的会话接触面；
5. **本例外不构成其他会话域动议的先例**：任何新的会话域能力（unarchive、
   普通删除、内容读取、字节统计…）都必须重新走一次例外动议评审，不得援引
   本设计背书。

评审不批准 → 回退 todo 12 方案 A（已归档浏览区）+ C（等上游 wire），本设计
保留为已决策的前置方案，不落地。

## 3. 宿主域契约（wire）

新宿主包（结构镜像 `packages/dsh-chamber-seed-git-worktree`，含提交态
esbuild 产物 `dist/index.js`）。**命名**（评审修正）：scoped name 遵循两既有
宿主包先例（`@dsh-chamber/dsh-chamber-seed-client-graph`、`@dsh-chamber/dsh-chamber-seed-git-worktree`
——git-worktree 的 `dsh-chamber-host-*` 前缀只出现在目录名，是历史不一致）：
包名 `@dsh-chamber/dsh-chamber-seed-archive-cleanup`，目录
`packages/dsh-chamber-seed-archive-cleanup/`（目录与 scoped name 对齐，避免第三种命名制）。

- loader insert：`id: archive-cleanup`（loader id 全局唯一，见 cordis-inserts
  冲突规则；全仓无此 id/namespace 占用，已 grep 核实）
- cordis 注入：`static inject = ['workspaceRegistry', 'agents']`（同
  git-worktree 的结构性依赖；会话存储/registry 其余服务按 §10 核对补充）
- wire 命名空间：`archiveCleanup`（camel，两段式端点）。可达性已核实：控制面
  反代对 `/api/i/<id>/api/*` 全量透传、无方法白名单（`instance-proxy.ts`）；
  gateway 默认代理逐字转发非管理 `/api/*`（`dispatch.ts`/`gateway-proxy.ts`）
  ——桌面侧 `/api/i/gateway-<id>/api/…` 与 gateway 托管 UI
  `/api/i/local/api/…` 两条路径均到达同一宿主面，**反代零改动**。

```
archiveCleanup/probe({})          → domain { ok, value: {} }
                                       // 零成本激活探针端点（2026-12 perf
                                       // 评审加入：presence+协议，无 IO）
archiveCleanup/preview({})        → domain { ok, value: {
                                       archived: number         // 已归档集合成员总数（registry-global；成员口径——含被归档的 subagent 起源行）
                                       deletableSessions: number     // 本次可删的集合成员根数（整棵可删的已归档根行）
                                       deletableSubagents: number    // 可删的级联 subagent 起源成员数（非根成员）
                                       skippedRunning: number        // 运行中被整棵跳过的子树数（每根计 1）
                                     } }
archiveCleanup/purge({})          → domain { ok, value: {
                                       deletedSessions: number
                                       deletedSubagents: number
                                       skippedRunning: number
                                       errors: { sessionId, code, message }[]
                                     } }
// purge 亦可带可选子集过滤（2026-09 修订，§17）：
archiveCleanup/purge({sessionIds}) → 同上（sessionIds 仅收窄候选集）
```

- 入参（2026-09 修订，§17）：`preview` 与 `probe` 仍**零参**（envelope
  `payload: { args: {} }`——`gitWorktree/snapshot`/`clientGraph/graph` 零参
  先例）；`purge` 现带**可选** `sessionIds` JSON 参数（SRC 描述符对缺失
  JSON 字段放行 → `undefined` = 全量，老客户端 `{args:{}}` 零改动）。
  客户端照 §5 发 `{args:{}}` 或 `{args:{sessionIds:[…]}}`。可选参仅限
  唯一标识符（无解构/默认值/rest——gateway SRC 签名约束）。
- `preview` 是**执行时快照**：只回计数（归档管理器列表来自会话快照投影，
  不调用 preview）；`purge` 开头重新读取权威状态，**不信任** preview 结果，
  两者之间状态可变化（UI 文案避免「恰好 N 个」暗示）。
- 返回值走 `domainResult` `{ok,value}|{ok:false,error}` 载体（generic
  gateway 不保留 thrown business 字段，同 git-worktree 理由）。
  `ok:false` 的 code 枚举（最小集）：`busy`（本域另一 purge/preview
  在途——**宿主侧单飞**，跨 N-ctx 的并发 purge 靠它收敛）、`registry-unreadable`
  （整体前提失败；2026-12 合入修订轮起 probe 的 `assertHostSurface` 结构
  检查亦覆盖会话枚举/存储面（Minor-3））、`purge-capacity`（archived
  集合超过单次上限 65,536——**不可重试**（`retryable: false`），无逃生口
  直至上游 wire 收敛，2026-12 合入修订轮登记，Minor-5）、`invalid-request`
  （子集过滤畸形/超限——2026-09 修订新增，非重试，过滤校验先于任何权威
  读取）。逐项失败收进
  `value.errors`（item code 枚举：`missing` 内容已不在 / `running` 删除
  瞬间转入运行（竞态） / `storage` 宿主存储失败；收尾批量写失败记
  `archive-set`），不中断、不 throw；`errors` 超过 1,000 条截断并置
  `truncated: true`（core.ts 常量 MAX_PURGE_SESSIONS / MAX_PURGE_ERROR_RECORDS）。
- 域**没有**任何读取方法；`preview` 是唯一的辅助面且只回计数。
- **404 语义**：宿主对未认领方法答 404（vendored gateway unclaimed-route
  行为，ssh-provider/gateway 均有注记）= 域未挂载或方法不存在，与「宿主包
  未加载/版本过旧」同义，客户端按 §5 处理；**不做 legacy 回退、不静默降级**
  （与 runtime-probes 对 chamber 域不做 legacy 降级的先例一致）。

## 4. 宿主内算法与守卫

纯核心 `core.ts`（fixture 驱动单测，同 git `core.test.ts` 模式——不依赖
vendor 源码）+ 薄 Remote 门面（`index.ts`），编排逻辑：

1. **候选集**：每次 purge 从权威 `workspaceRegistry` 重读 archived 集合
   （registry-global，todo 12 §1）与各 workspace 账目；**孤儿 id**（workspace
   成员关系已消失或内容已不在）按 missing 幂等跳过，不阻断；
2. **级联枚举**：对每个已归档顶层会话，按 `parentSessionId` 链枚举 subagent
   起源后代（宿主侧等价于 `sidebar/shared/subagent-lineage.ts` 的
   `indexSubagentDescendants`，但基于权威存储，不基于投影）。归档顶层行的
   可枚举性（含 header 索引对归档行/子会话的可见性）是 §10 前置核对项——
   chamber 侧只有 follow baseline 携带 archivedSessionIds、无 unary 读面；
3. **运行保护**：任一节点是 live agent（`ctx.agents`）→ 整棵子树跳过并计数
   `skippedRunning`。归档顶层自身 running 位的事实来源（`ctx.agents` 是否
   覆盖归档行/subagent 起源行，或需读会话存储记录）列入 §10 核对 #5；
4. **删除顺序（崩溃一致性）**：**children-first**——先删 subagent 起源后代、
   再删顶层会话目录；**archived 集合成员最后移除**（顶层 id 在整棵删完前
   保持 archived，崩溃后续跑才能重新枚举到残留后代，不会产生清不掉的孤儿）；
   完成树所覆盖的**已归档后代成员**（本身在 archived 集合中的 subagent 行）
   随同一次收尾批量写清除，无跨轮 marker 滞后（2026-12 合入修订轮，Nit N1）；
   崩溃乱序场景入单测（§9）；
5. **执行**（§10 核对后二选一）：
   - a) 官方宿主进程内存在可复用的删除例程（未来 delete wire / dispose
     流程所用）→ 直接调用（首选，零布局知识复制）；
   - b) 否则按 pinned vendor 的会话存储布局（`<sessions-root>/<project>/<id>/`
     等，todo 12 §5.2）做有界删除：内容目录删除 + workspace `sessionIds`
     账目自愈 + archived 集合清理；**一切状态写经宿主自身 setState/持久化
     原语**，文件写遵守宿主原子写纪律；
6. **事件发射**：删除经官方事件总线发射 **`host/session-removed`**
   与 **`host/archived-sessions-changed`**（精确名，todo 12 §5.2）——
   mounted ctx 的 workspace follow/基线推送、git 域等宿主内消费者据此
   自愈；不可绕过事件直接改投影。§10 核对（#4/#5）结论：pinned 树无
   宿主域可用的公开事件面 → 实现为**文档化 no-op**（binding.ts emit 空
   实现，投影刷新 = 客户端 mutation-pull + 官方启动 header 索引重建；
   2026-12 合入修订轮把本步骤措辞与 §14 决策 5 / AGENTS.md 登记对齐）；
7. **逐会话隔离与复检**：单会话失败记入 `errors` 不 throw、不阻断其它树
   （同树剩余成员的中止语义见下）；每会话删除瞬间经 binding 删除时 live 守卫
   复检（非 running 才删——逐成员 O(1) 预检为死代码，2026-09 修复轮移除，
   §16-5）；幂等（内容已不在 = `missing` 跳过；不在 archived
   集合 = 不枚举）；崩溃窗口收敛 = 遗留会话仍属 archived，下次 purge 续跑
   清掉。**运行窗口**（2026-12 合入修订轮登记，Minor-4；2026-09 合入后修复
   轮按实现定稿为成员失败中止整树语义，已落地于工作树未提交态，§16-1）：
   整棵跳过保证截至每成员的删除瞬间——成员在树内删除间隙转 running（binding
   live 守卫拒删）或删除报存储错误时（**首个树内失败**即触发），**中止本树
   剩余删除**：该成员与其未删祖先（含根）保持原样、根保持 archived，前序已删
   成员不回滚（删除瞬间本就可删），本树不进入收尾集合移除——根会话记录位于
   其自身内容目录内，越过失败成员删根会让下次 purge 把根当孤儿清出集合、
   不再重枚举幸存成员（静默内容泄漏，故整条祖先链保留待重跑）；下次 purge
   从根重新枚举收敛，一棵树的中止不阻断其它可删树（逐树隔离）。

**上游草案逐条镜像映射表**（todo 12 §5.2 → 本域承诺 → §10 核对锚点）：

| todo 12 §5.2 语义 | 本域承诺 | 核对/验证锚点 |
|---|---|---|
| 删会话目录（`<sessions-root>/<project>/<id>/`） | §4 执行分支 a/b + 原子写纪律 | §10 #3/#8；core 单测 |
| 级联 subagent 起源子会话 | §4 step 2/4（children-first） | §10 #2/#5；级联/乱序单测 |
| workspace 成员账目自愈（header 索引重建剔除） | §4 step 5b + 官方原语优先 | §10 #1/#3/#8 |
| 从 archived 集合清理 | §4 step 4（最后移除） | §10 #1；幂等单测 |
| 复用 `host/session-removed` 事件 | §4 step 6（硬约束） | §10 #4 |

## 5. 客户端 wire 接入

`packages/dsh-chamber-client-ui-sidebar/src/shared/instance-api.ts`（唯一
客户端接入点，sidebar 插件与 App 层共享）。**现状约束**（评审核实）：
`call()` 私有；非 2xx 一律 generic throw（无 status 透出）；503
`instance_unavailable` 有专类特判；默认超时 `DEFAULT_TIMEOUT_MS = 30_000`
且**调用方传 signal 也压不住 30s 上限**（`AbortSignal.any([timeout, signal])`）。
据此本设计对 `instance-api.ts` 的增量（最小、向后兼容）：

- `call()` 增加可选参数 `timeoutMs`（默认不变）；增加可选开关
  `notFoundAsDomainMissing`（**仅 archiveCleanup 访问器传 true**）。404
  判别规则（防双重语义误标）：仅当 404 且开关开启时解析响应体——
  body `code === 'instance_not_found'`（control-plane 未知实例 id，
  instance-proxy.ts L432/L505–509）→ 保持 generic transport 行为（来源
  已删/未知，非域问题）；其余 404（宿主未认领方法 = 域未挂载/版本过旧）→
  抛 `InstanceDomainMissingError`；
- 新专用错误类 `InstanceDomainMissingError` + `isInstanceDomainMissing()`
  （镜像 `InstanceUnavailableError` L103–108 模式，放其旁），404 + 开关开启
  时抛它；wrapper 层据此输出 §6 文案；
- wrapper：`previewArchiveCleanup(client)`（默认 30s；2026-09 修订起 UI 不再
  调用——归档管理器列表来自会话快照投影——保留为宿主 preview 端点的已测
  客户端半面）/ `purgeArchivedSessions(client, sessionIds?)`（长预算，常量
  `PURGE_CALL_TIMEOUT_MS = 5 * 60_000`，放 instance-api.ts；`sessionIds`
  可选子集过滤，见 §17）。**wire 上游空闲窗（2026-09 修订）**：代理豁免名单
  `LONG_RPC_PATHS` 已含 `/api/archiveCleanup/purge`（03 §3.4），purge 的
  上游静止容忍由 30 分钟保险丝覆盖——5 分钟客户端预算成为唯一先到截止，
  其诚实超时文案（下条）不再被代理 45s 窗的误导性 504 抢先；
- **超时文案**（诚实，zh 硬编码先例）：「清理超时——可能仍在进行，请稍后
  重新预览/重试（重复执行是安全的）」；预览超时给「预览超时，请重试」；
- 503 `instance_unavailable` 沿用 `wrapWireError` 既有文案与 `isInstanceUnavailable`
  语义；
- 行内错误文案定稿（评审决策点）：**沿用 zh 硬编码先例**（现有一切
  wrapWireError/rowError 文本均为 zh 硬编码；`domainMissing` 若走 locale 键
  将是首个本地化 rowError，需在组件作用域 catch→t() 翻译，v1 不做）——
  按钮 aria/title 与确认对话框文案走 locale 键（§6），行内错误/信息行走
  zh 硬编码 + 与既有错误同构；如需本地化列为后续增强。
- **桥契约（05 §3 `ChamberServerAggregate`）——2026-09 修订（§17）**：
  新增**归档管理器投影字段** `archivedSessions`（+ 归档集权威性标记
  `archiveSetKnown`）：已归档行的**元数据**（id/title/cwd/updatedAt）随
  实例快照投递（官方会话投影本就携带归档行，此前 chamber 只在可见性层
  丢弃），管理器 UI 由此列示已归档会话而**零新增宿主读取面**；unary 兜底
  视图归档集未知（KNOWN DEGRADATION），`archiveSetKnown:false` 标记防
  「无已归档会话」误报。

## 6. 侧边栏 UI（server 行 hover 动作）

> **2026-09 修订（§17）**：本节的 v1 交互流（preview → window.confirm →
> purge 全部 + header 下错误槽位）已被**归档管理器对话框**取代——§6 正文
> 保留为 v1 历史契约与 UI 位置基线（trash 按钮仍在同簇同门控位置，点击改
> 为打开管理器）。交互细节以 §17 为准（§17 又经 §18/§19 修订：无独立
> 「删除全部」、列表按工作区分组折叠——交互细节以 §18/§19 为准；§19
> 条目 6–9 续修订：缩进、匹配轮、两段式确认重构与分面评审处置）。

位置与行为（`packages/dsh-chamber-client-ui-sidebar/src/client/SidebarRoot.tsx`）：

- 锚点：来源分组头（server 行）hover 操作簇——现状为 排序菜单 /
  add-workspace `+` / 搜索 三枚（`cc.sourceActions`，SidebarRoot.tsx
  ~L1927–2041）；在簇尾追加**一枚删除图标按钮**（`IconTrashOutline16`
  已 import 且用于 workspace 删除，size 14 一致）。簇宽 64→86px、header
  28px 定高不变，「无 reflow（垂直）」声明仍成立；label 水平再被挤 22px，
  最小宽度实现时目检（无代码级约束）。
- 呈现/隐藏条件与同簇按钮**逐字一致**：`server.connected &&
  (server.aggregateError === undefined || search?.expanded === true)`；
  断连/聚合错误时不显示；折叠态 header 常驻、按钮仍可达（fold 只藏 header
  之下的内容）——因此**错误呈现点必须在 fold 门之外**（见下）。
- 交互流（**全流程 per-server 单飞**）：
  1. 点击 → `stopPropagation` + `suppressClickRef` 检查 + `clearPendingClick()`
     （照抄同簇按钮三件套 L1976–1983 等；拖拽豁免/keydown target 守卫均为
     泛型机制，自动覆盖新按钮——需维护的只是**注释清单**：SidebarRoot
     dragstart 按钮豁免注释、pending-click.ts 顶部注释、CSS 簇内容描述）；
  2. 单飞守卫：per-server in-flight（如 `purgeBusy: Record<serverId, 'preview'|'purge'>`），
     在途时按钮 `disabled`（disabled 瞬时不可聚焦，与键盘纪律并存说明）；
     同组件无「异步→window.confirm」先例（archive/delete-workspace 均为同步
     confirm），v1 自建该流并单飞化——防双击 → 双 preview → 双 confirm →
     并发双 purge；跨 N-ctx 的并发由**宿主侧单飞**（`busy` code，§3）兜底；
  3. preview（单飞内）→ resolve 后**复查 liveness**（`serversRef` 中该
     server 仍 `connected`）再弹确认（preview 在途断连不弹陈旧计数）。
     2026-12 合入修订轮定稿：复查**不再门控** `server.aggregateError`
     （E-m2）——aggregateError 只反映列表快照拉取，preview 成功本身就是
     wire 健康证明，门控它只会让每次点击变成 30s 浪费后误标「已断连」；
  4. `window.confirm(t('confirm.purgeArchived'))`：**文案不承诺「恰好 N 个」**
     （preview 是快照），以区间/约量措辞 + 不可恢复明示；仅当
     `deletableSessions === 0 && deletableSubagents === 0`（双零）时才
     **不进确认**（2026-09 按实现对齐：单看 `deletableSessions === 0` 不足
     以跳过——可删集合中仍含可删的 subagent 起源成员时进确认；双零守卫 =
     SidebarRoot.tsx 实现行为），改在信息槽位（步骤 6）呈现
     行内提示：`skippedRunning > 0` → 「没有可删除的已归档会话（N 项因
     运行中被跳过）」，否则「没有可删除的已归档会话」；行内提示走 zh
     硬编码（与 §5 定稿统一）；en 复数沿用 `.one/.other` 惯例；
  5. purge（单飞内）→ 成功：`chamberBridge.requestRefresh(server.id)` +
     host-store 事件推送双通道（注：requestRefresh 对 live 来源是即时
     mutation-pull——App.tsx 对每个 live 来源无条件拉取并合并会话行，不是
     no-op；两者都不改变可见列表——归档/子代理行本就不可见——属惯例性
     调用，与 archive 动作一致）；成功且 `deletedSessions+deletedSubagents
     > 0` 时在信息槽位补完成摘要行「清理完成：删除 X 个会话 / Y 个子代理
     内容。」，成功且 `skippedRunning > 0`（无论有无 errors）都补一行
     「已跳过 N 项运行中的会话（未删除）」——skipped 非错误，但用户应能
     得知留存项（行内文案 zh 硬编码，2026-12 合入修订轮定稿）；
  6. 错误呈现（**新槽位**，评审必修）：在 `<header>` **正下方**新增一个
     server 级错误/信息渲染点，**位于 fold 门（`!sourceFolded`）之外、与
     搜索态无关**（唯一既有 server 级先例 add-workspace 错误位于
     `query === ''` 且 fold 门内，照抄会在折叠/搜索态静默吞错）；
     `cc.rowError` 复用（margin 微调）；该槽位统一服务：preview 失败 /
     purge 失败 / 超时（`role="alert"` 错误行，zh 硬编码）、空态提示 /
     完成摘要 / 跳过提示（`role="status"` 信息行，zh 硬编码）、purge
     **部分失败**（`deleted>0 && errors>0`：错误行含完成摘要 + 「N 项失败，
     可重试（重复执行安全）」——2026-12 合入修订轮定稿：部分失败走
     `role="alert"` 错误行，部分失败是失败而非纯信息，见 §15 债务①闭合）；
     purge 全失败（`deleted===0`）按错误呈现；
  7. 错误生命周期：`rowErrors` 无自动清理（断连后陈旧错误会在重连时冒现，
     add-workspace 已有同类 pre-existing 行为）——为 `${server.id}/archive-cleanup`
     key 增加可见性清理（同 sortMenu/rename target 的 cleanup effect 先例）
     或在文档接受；v1 选择加清理（与目标行消失清理同款）。
- 键盘可达：真实 `<button>` + **title 属性 + aria-label**（簇内按钮全部用
  title 属性，无 Tooltip 组件——Tooltip 仅用于 rail/New Session 区域）；
- 成功反馈：**无系统级横幅**（与「归档」动作一致——动作对象不可见）；
  完成摘要/跳过/空态行落在信息槽位（`role="status"` cleanupNote，zh
  硬编码）——2026-12 合入修订轮把「成功无横幅」细化为「无横幅、有槽位
  摘要」，与实现一致（§15 已修复轮：成功/空态中性 cleanupNote 样式）；
- rail/窄栏与移动端不做（范围声明见头部）。

新增 locale 键（en/zh；对称由 `locales.ts` 的 `SidebarKey = keyof typeof zh`
+ `en satisfies Record<SidebarKey, string>` 类型门禁保证——**typecheck:sidebar**；
注意 `verify:i18n` 只校验顶层双语文档对，与此无关）：
`action.purgeArchived`、`confirm.purgeArchived`（含约量措辞与跳过子句所需
插值，实现期定稿具体结构）；行内错误/信息（domainMissing / 超时 / 空态 /
部分失败）按 §5 定稿走 zh 硬编码，不进 locale。

## 7. 宿主包改动面清单（实现期全量接线）

> 每个既有枚举两宿主包的位置都有断言/测试——**先改断言让测试红，再接线**，
> 不会静默漏挂。本清单经三路评审对照（含逐文件行号核实），按类别列全：
> 常量/seed 面、探针契约面、分发/打包面、门禁面、文档面。全部在实现落地时
> 完成；本文档先行定稿契约。

**A. 新包本体**：`packages/dsh-chamber-seed-archive-cleanup/`（src/index.ts +
src/core.ts + scripts/build.mjs + test/core.test.ts + **提交态 dist**）。
根 `.gitignore` 需为 `packages/dsh-chamber-seed-archive-cleanup/dist/` 新增否定
（并入既有「chamber host 包提交态产物」按包否定块——按内容描述：
`# The chamber host packages ship committed esbuild artifacts…` 注释段 +
逐包 `!packages/<pkg>/dist/` 与 `!packages/<pkg>/dist/index.js` 否定行，
**不引用行号**：行布局随包增删变化，2026-09 勘误前文所引 L13–15/L16–19
为两包时代布局）——否则提交态 dist 无法
入库、CI 缺产物 → seed 跳过 → 激活失败。

**B. control-plane seed 面**：`host-graph-seed.ts` 新增 `HOST_ARCHIVE_CLEANUP_*`
常量（PACKAGE_NAME / INSERT_ID / INSERT）；`index.ts` `seedEntries()`（L351–373
局部数组）加第三行 + `probeDomains: ['archiveCleanup/probe']` + 新
`DEFAULT_HOST_ARCHIVE_CLEANUP_PACKAGE_SOURCE_DIR`；`ControlPlaneOptions` 新增
`hostArchiveCleanupPackageSourceDir` 选项（desktop main 传 dist 打包路径，
缺省 REPO_ROOT 下源码目录；absent 时 ensureSeedPackage 静默跳过——安全）；
`host-graph-seed.test.ts` / `cordis-inserts.test.ts` 常量数组。
注：`probeDomains` 是**纯元数据、无代码消费方**（host-graph-seed 注释自我
声明与激活探针集靠人肉同步）——新增行时必须同步 B 面清单里的三处。

**C. 探针契约面（design 18 §3.4 契约修订，评审必修）**：
- `dsh-runtime/src/activation-gate.ts`：`REQUIRED_ACTIVATION_PROBES` 加
  `'archiveCleanup/probe'`（2026-12 perf 评审：激活探针改打零成本 `probe`
  端点而非 `preview`——preview 保持仅用户点击路径；probe 不读会话数据、无
  IO、响应与会话量解耦，恢复 design 18 §3.4 探针契约）；`HOST_DOMAIN_PROBE_NAMES`
  加第三域（typed
  subtraction 守卫保留——拼错域名的行会在缩减集断言处红）；
- **执行腿分期（M-1 边界）**：M1 即落地 runtime-probes 第三域执行腿与
  accept 语义（full-set 形状下 7 条全跑；不落地则 7 期望 vs 6 执行 →
  'probe not wired' 回退，M1「本地形态全链可用」不成立）；M2 再做按域
  派生改造（下两行）；
- **期望集派生改造**（替代二元 `hostDomains` 布尔，M2；2026-09 勘误：M2
  已落地——现实现按实际同步包逐包派生 `syncedHostDomainProbeNames` →
  `activationProbeNamesForDomains`，二元 `hasSyncedHostSeed` 已删除）：
  原基线为全有/全无（runtime-probes.ts expected 二选一；gateway
  runtime-manager 曾以 `hasSyncedHostSeed()` 一个布尔驱动）——第三域引入
  2-of-3 部分同步（老桌面↔新 gateway 交替同步、同步缓存不完整）后，静态
  期望集会与实例实际挂载域错配 → 激活 observe→fail→回退循环。改为：**期望
  探针集与 chamber-domain 探针行按本次 spawn 实际 seed 的宿主条目派生**
  （seed 清单逐条 `probeDomains` 为源；空缓存 = 空域集，兼容现 gateway
  未同步形状）；local/desktop 与 gateway runtime-manager 共用该派生。
  等价性登记（复核确认）：空缓存派生集 ≡ 现
  `PROBE_NAMES_WITHOUT_HOST_DOMAINS` 基础 4 项（基础集不含 chamber 域），
  向后兼容；部分缓存派生 = 对已挂载域做强于现语义的验证，无回退；
- **探针 accept 语义**（新域无 gitWorktree 式「确定性业务拒绝」输入可依赖）：
  accept = generic envelope `ok:true` 且 domain 结果形态良好（value 为对象）；
  `ok:false` = 在位但异常 → fail-closed；
- 提交态产物：**`packages/dsh-runtime/dist/index.js`（dsh-runtime 的提交态
  dist，承载探针常量；包 main 指向 dist）重建并提交**——desktop 经
  runtime-probes shim 消费包 main，cross-package-contract.test.ts 钉提交态
  dist，dist-sync.test.ts 会红（§9）；「dist 重建」指它，不是新包 dist；
- **rollout 顺序（激活是硬门）**：desktop 启动事务/暴露门控跑全量探针
  （main.ts startAndProbeWorkspace，hostDomains 缺省 true），
  fail→observe→fail→回退——探针集改动、seed 行与提交态 dist **必须同
  commit 落地**，否则本地启动事务失败（这正是「先红」机制的来源，设计明示）；
- 测试：runtime-probes.test.ts（精简集/顺序断言，现 L313–460 需扩第三域
  与部分派生 fixture）、desktop/gateway 锁步断言。

**D. desktop 分发/打包面**：`plugin-sync.ts`（CLIENT_GRAPH/GIT_WORKTREE
常量 + `seedRemoteChamberHostPackages` + main.ts
`chamberHostPackageSeeds`/`localChamberHostPackageSources`/打包路径三处）、
`scripts/build-host-graph-package.mjs`（packages 数组加第三包 → desktop
`dist/` 内嵌包源）、`plugin-sync.test.ts` / `ssh-provider.test.ts` /
`gateway-provider.test.ts`（上传清单 fixture）扩展。
**门禁面**：根 `package.json`（`build:host-*` 并入 `build:host-packages`、
`typecheck:host-archive-cleanup`、`test:host-archive-cleanup` 新别名）、
`.github/workflows/ci.yml` 与 `release.yml` 的逐包 typecheck/test/host-build
步骤、`scripts/dev/release-preflight.mjs` 逐包步骤。

**E. gateway 面**：`plugins.ts` `SYNCABLE_HOST_PACKAGES`（L38–41）第三行 +
`index.ts` `extraSeedEntries`（L317–339）第三行（desktop-synced sourceDir）；
`runtime-manager.ts` 探针期望改 C 的派生实现；测试数组（feature-lifecycle /
chamber-installed / runtime-routes——真探针 fixture 需答第 7 端点 /
plugin-spec-lockstep：新包名 `@dsh-chamber/*` 在保留名拒绝集内（scope 前缀
判断），自动覆盖）。gateway build.mjs **不改**（宿主包已不在 gateway 内嵌，
mobile 是唯一打包例外）。

**F. settings-connections（v1 决策，评审修正）**：PluginDialog 内建组件表
**不新增 archive-cleanup 三态行**（v1 取舍）：与既有宿主包行同构的三态徽标
行需要扩展整条链（代价清单如下），为诊断面引入整链成本不值 v1。v1 仅做
**常量级归类修正**：`plugin-inventory-text.ts` 的
`classifyInventoryEntry`/`chamberKindOf` 加第三包——否则 M1/M2 落地后该包
在 gateway 插件清单（Loader inventory 驱动）里会以 **third-party** 误标显示
（现只认 client-graph/git-worktree/mobile）。域状态诊断 = 侧边栏 404 文案 +
插件清单归类。
三态行代价清单（M4+ 可选增强；评审在 M0 可否决本取舍改选三态行）：
(a) `plugin-sync.ts` `ChamberInjectionState` chamber 块第三键 +
`localPluginList`/`probeRemoteChamber` 实时探针 + 主进程
`LOCAL_PLUGIN_LIST`/`SSH_PLUGIN_LIST` live adapter；(b) IPC 类型镜像三处：
renderer / settings-connections 两侧 `global.d.ts` + `preload.cts`
`ChamberInjectionState` 镜像位（`ipc-surface-mirror.test.ts` 断言三镜像位）；
(c) `ChamberSeedDriftState` / `plugin-inventory-text` 两键形状第三键；
(d) 测试 fixture（desktop plugin-sync/gateway-provider、settings
chamber-seed-drift/control-plane）。
**IPC 面修正表述**：v1（不含三态行、仅常量归类）**不新增任何 IPC channel /
管理 REST / 反代改动**；若 M4+ 采纳三态行，§F 代价清单即为增量。

**G. 零改动面**：control-plane 反代、gateway 默认代理、桥契约
（ChamberServerAggregate）、derive/聚合投影、CLI。

## 8. 兼容与降级

- 老/未挂域实例：端点 404（含「方法不在该域」）→ 行内诚实文案（§5/§6），
  与激活探针的「check or upgrade」同精神，**无 legacy 回退、不静默**；404
  开关限定 archiveCleanup 访问器，不与 control-plane 的未知实例 id 404
  （`instance_not_found`）混淆；
- 无已归档内容：preview 空计数 → 空态提示，不进入确认（empty 与全被跳过
  子句的优先级见 §6 流程第 4 步）；
- 断连来源：按钮不呈现（与同簇一致）；not-ready 503 由 wrapWireError 给
  既有文案；preview 在途断连 → 确认前复查（§6）不弹陈旧计数；
  **重连双确认窗口**（2026-09 修复轮 F9，SidebarRoot 注记同文）：断连清理
  effect 会清掉本地 in-flight 标记，而宿主侧 purge 可能仍在运行——重连后
  的再次 preview→confirm 与先行 run 重叠属接受窗口，由宿主 `busy`
  单飞兜底 + purge 幂等收敛，不引入新防护门；
- purge 超时/中止：客户端超时不取消宿主删除；以「可能仍在进行、可重试、
  重复执行安全」诚实呈现（§5/§6），**不诱导用户误判为失败**。

## 9. 测试与验证

- `core.test.ts`（纯 fixture，不依赖 vendor，同 git core 模式）：候选集 /
  孤儿 id / 级联枚举 / 运行子树跳过 / **children-first 顺序与崩溃乱序收敛** /
  幂等重跑 / 逐项错误隔离 / 账目自愈 / archived 成员最后移除 / 每会话复检；
- 域门面：方法名与 envelope、零参 `{args:{}}` 形状、domainResult 载体、
  **busy 单飞**（并发 purge 第二个调用得 `ok:false busy`）；
- 探针契约：期望集**部分派生 fixture**（2-of-3、空缓存、全量三态）、
  accept 语义、dist-sync / cross-package-contract 锁步——先红后绿；
- 接线面：host-graph-seed / cordis-inserts / desktop plugin-sync /
  gateway 列表断言扩展（先红后绿）；根脚本/CI/release/preflight 逐包腿；
- 客户端 wire：`instance-api.test.ts` 现状为 client 对象 stub、无 fetch/HTTP
  harness——404/503/超时分类测试需 global fetch stub 或把 call() 错误分类做
  成可注入 seam（§5 实现时二选一，如实不虚报）；wrapper 层错误类映射单测；
- UI 逻辑（纯函数可测部分）：per-server 单飞状态机、empty/skipped 优先级、
  部分失败警告文案装配；该包无 DOM/UI 测试基建（test 脚本全 node 纯模块）
  ——**不承诺**「pending-click 守卫清单测试」（注释清单维护即可）；
- locale：en/zh 对称由 typecheck:sidebar 门禁（satisfies 机制），非
  verify:i18n；
- 门禁：`test:sidebar` / `test:host-archive-cleanup` / `test:control-plane` /
  `test:desktop` / `test:gateway` / 对应 `typecheck:*` / `build:renderer`；
- 实机 E2E（vendor 树就绪 + 打包态）：本地实例归档若干会话（含 subagent）
  → hover 动作 → preview 计数 → 确认 → 磁盘/registry/事件验证 → 再跑幂等；
  gateway 形态（桌面同步 → managed dsh 重启 → 同链）；远程 dsh（ssh）同链；
  并发（两 ctx 同时 purge → busy）；超时续跑；
- 如实报告纪律：vendor 子模块缺失时哪些腿无法执行（build:renderer / 打包
  依赖 vendor 源码），不虚报。

## 10. 实现前置核对（vendor 源码清单，决策门）

在 vendor/harness-packages（pinned submodule）核对并记录到实现注记：

1. `workspaceRegistry` ctx 服务面：list / archived 集合读写 / sessionIds
   账目 mutation / 持久化 setState 路径 / archiveSession 实现；
2. **归档顶层行可枚举性**：归档会话（含其 parentSessionId 链、subagent
   起源行）能否从宿主存储层/header 索引枚举（chamber 侧无 unary 读面，
   仅 follow baseline 有 archivedSessionIds——instance-api.ts 注记）——
   决定 §4 step 2 的可行形态；
3. **官方进程内可复用的会话删除例程**（决定 §4 a/b 分支；点名核查
   `workspace.delete` 对成员会话/目录的处置语义——todo 12 §5.2 提「header
   索引重建即剔除已删 id」，git 客户端 remove saga 以 workspace.delete
   收尾）；
4. 事件精确名与发射面：`host/session-removed`（现由 session/disposed 驱动）、
   `host/archived-sessions-changed`——删除路径能否复用/触发；
5. `agents` 服务覆盖面：是否含 subagent 起源会话；**归档行自身 running 位**
   的事实来源（ctx.agents vs 会话存储记录）——决定 §4 step 3 实现；
6. generic gateway：零参 Remote 的 envelope 要求（chamber 侧先例：
   `clientGraph/graph` 客户端 `{args:{}}`、git-api snapshot；宿主侧参数名
   约束只影响带参方法）；unary 客户端断连后宿主侧 Remote 执行是否继续
   （决定超时语义的宿主侧事实）；
7. cordis patch insert 三行共存无冲突（id/name 全局唯一）；
8. 会话存储布局（format.ts / sessions-root / header 索引）与原子写/持久化
   原语（b 分支需要；布局常量钉测防漂）。

决策门：核对结果决定 §4 a/b；若连 b 的安全编排原语都缺失 → 方案冻结回退
todo 12 C（§2 已记），不得在核对前凭 §4 的实现猜测落地。

## 11. 风险与上游收敛

- **上游未来落地 unarchive / sessions.delete**：收敛路径**机制化**——上游
  wire 随 vendor bump 出现即登记为独立 STATUS 跟踪项：客户端 wrapper 单点
  切到官方 wire（批量编排），宿主包按发行周期从 seed 清单退役，双协议不
  永久并存；§3 命名空间与官方分离保证切换无碰撞；
- **本例外无先例效力**：§2 边界 5——其他会话域动议须重新评审；
- **探针部分同步**（老桌面↔新 gateway 交替同步）：§7 C 的期望集派生改造
  消除静态错配；改造前不得上线第三域；
- **官方存储布局漂移**：锁步测试 + 布局常量钉测防漂（b 分支才需要）；
- **与运行中官方写路径并发**：只经宿主 service / 持久化原语 + live agents
  守卫 + 每会话复检；崩溃窗口由 children-first 顺序 + archived 集合收敛
  （§4 step 4/7）；
- **事件/投影一致性**：删除必须经官方事件总线（§4 step 6 硬约束），mounted
  来源推送与宿主内消费者不落后；v1 可见列表不受影响（归档/子代理行不可见）；
- **域错误可见性**：只经 domain 返回/宿主日志，不进 renderer 之外的任何
  表面；客户端「错误绝不静默」由 §6 槽位与部分失败警告保证；
- **B 路径风险**（进程外直删的内存覆盖/账目分裂）在本方案中不存在（§2），
  但仍是冻结项，不做任何形式的复活。

## 12. 分期与文档同步时点

- **M0 评审**：宿主包例外动议（§2）+ vendor 前置核对（§10）通过。
  **文档随 M0 批准即改（不等实现）**：AGENTS.md 例外清单与宿主包清单、
  design 01 §3 地图行 12（仍标 2026-08 todo，过期随本设计修）——闭式例外
  清单与代码/设计保持同步，避免 M1–M3 合入代码后 AGENTS 明文矛盾；
- **M1 宿主域**：新包 + core + 门面 + 单测 + 提交态 dist + control-plane
  seed/probe 接线（含 probeDomains 元数据三处同步 + activation-gate 常量 +
  **dsh-runtime 提交态 dist 重建**，同 commit）。M1 明细含
  **runtime-probes 第三域执行腿与 accept 语义**（full-set 布尔形状下 7 条
  全跑——只加常量不加执行腿会 7 期望 vs 6 执行 → 'probe not wired' →
  observe→fail 回退，M1「本地形态全链可用」不成立）；按域派生改造归 M2。
  文档随 M1：design 05 §6（宿主包 2→3）、design 02（loader id 表 / 宿主包
  附着表）、design 18 §3.4 域枚举文字（随常量同 commit；M2 仅补派生契约
  段）、09/13/16/17 中枚举宿主包的表述、STATUS.md 更新；
- **M2 探针契约 + 分发面**：期望集派生改造（§7 C）+ desktop plugin-sync /
  打包嵌入 / 根脚本 / CI / release / preflight 腿 + gateway syncable 列表
  + settings `plugin-inventory-text` 归类常量第三包（§7 F，gateway 清单防
  third-party 误标）。
  文档随 M2：design 18 §3.4 派生契约修订段（2026-09 勘误：§9.3 未单独改动
  ——design 18 §9 的探针文字经 §3.4 生效，无独立 §9.3 编辑）、STATUS.md
  头部探针段（L36–37 与挂账①口径）；
- **M3 客户端 + UI**：instance-api 增量（timeoutMs/404 开关/错误类/wrapper）、
  侧边栏 header 下错误槽位 + server 行 hover 动作 + 全流程单飞 + locales +
  注释清单维护。文档随 M3：design 05 §2.2（交互表 + 例外注）、05 §3 与
  §2.3 的两处同源陈旧注记（requestRefresh/mounted 推送语义与 App.tsx
  不符——§2.3 L131–133 与 §3 L216–217 同句重复，一并修正）；
- **M4 收口**：实机 E2E（§9）、CHANGELOG、desktop README、todo 12 结项
  （B 冻结结论保留并指回本设计 §2）、M4+ 可选增强登记（PluginDialog 三态行
  §7 F、rowError 本地化 §5）。

## 14. 实现注记（2026-12，§10 核对结果与 binding 落地）

§10 决策门已按 pinned vendor（dsh-v0.1.2-rc.1 a66e4702）执行，结论与实现：

1. `workspaceRegistry` ctx 服务：`list()`/`archivedSessionIds`（public getter）/
   `archiveSession`（仅增向）可用；**成员 `sessionIds` 是 header 索引派生的
   getter**（启动/实时按 `sessionPersistence.list()` 重建）——内容删除后
   成员账目自动自愈，无需也不可手工改账目；
2. 归档顶层行枚举：官方 `sessionQuery.listSessions()`（live 优先 + 持久化
   合并，含 `header.origin`/`parentSession`/`cwd`）——与官方 session/list
   投影同源，`archivedSessionIds` 为 registry-global 集合；
3. 官方进程内**无会话内容删除例程**（persistence 抽象只有
   create/append/load/inspect/list/listSnapshots/locate…，无 remove）→
   **分支 b 落地**：`sessionPersistence.locate(header)` 给出官方绝对产物
   路径（零布局知识复制），删除产物文件 + 空目录回收（rmdir 非递归，
   余留文件 fail-closed）；运行保护 = `agents.list()` ∪ live
   `sessions.list()`；
4. **归档集合成员移除无公开原语**（registry 仅 archiveSession 增向；
   startup/任何路径均不透传裁剪）→ binding 以文档化结构 seam 执行**一次
   纯 `workspaceRegistry.setState({initialized, workspaceIds,
   archivedSessionIds: filtered})`**（官方 insertBefore 同款单写形态，
   官方持久化路径，进程内——todo12 B 的进程外覆盖风险不适用）；
   seam 带 `typeof setState === 'function'` 运行时守卫并 pin 版本；
5. 事件：pinned 树无宿主域可用的 archived-set/session-removed 公开事件面
   → `emitSessionRemoved`/`emitArchivedSessionsChanged` 为**文档化 no-op**；
   投影刷新 = 客户端 mutation-pull（App 层对 live 来源无条件拉取）+ 官方
   启动 header 索引重建；
6. 零参 envelope 先例与 404 语义沿用 §3/§5（host-graph/git-api 实证）；
7. cordis 三 insert 行共存无冲突（cordis-inserts 断言先红后绿批次已绿）；
8. 布局知识零复制（依赖 locate/format 官方导出）；dist 提交态已构建。

**残余定案（2026-12 合入修订轮，评审 M1；取代旧「占位 id 保留至上游
wire」草稿）**：archived 集合成员按 §4 step 4 语义随 purge 收尾**移除**
——完成树根、完成树覆盖的已归档后代、孤儿在同一批官方 setState 写中
清除（core.ts `purge()` + binding `removeArchivedSessionIds`，测试固化）。
**无「内容删除后保留 marker」策略**：早期草案的保留措辞与 §4/实现/测试
冲突，以 §4 为准废弃。红线段「no unarchive」的读法 = chamber 域只在其
内容删除完成后清除**该已删内容自身**的集合成员，不提供任何恢复/浏览/
反向操作；A-区（todo12 方案 A，已归档浏览）若实现，其数据面即当前
archived 集合（仅含未清理与运行中留存项）。上游 unarchive/delete wire
落地后本域退役并按官方语义收敛（§11）。

## 15. 多轮评审处置与文档债务登记（2026-12，附加于 §14）

六路只读评审（架构/安全/实现/性能/交互/一致性）后处置落点与残余登记：

**已修复（本轮）**：probe 端点改名批次（§3/§7B/§7C/§14 同步 + 双 dist
重建——原子启用 commit 同一批）；零成本 `probe` 单层载体；purge 快照单遍 +
逐成员 O(1) 快照 cwd 直删 + 每树仅 live 重读（原每成员全库重列已除）；归档
集移除移入官方 `enqueueOperation` 链 + 收尾单次批量单写；FS 错误→item 码
`storage` 逐项隔离 + symlink/非目录 fail-closed；宿主审计日志（preview/purge
起止行）；客户端双层域载体解码（busy 不再静默变空计数）、504/超时/断连
诚实文案、成功/空态中性 `cleanupNote` 样式（role=status）、在途 spinner +
aria-busy、confirm 零值/单复数拆键、truncated 端到端、写时 liveness 检查；
真 binding/RunGate 单测（binding.ts 无装饰器直测）；503 分类测试；错误码
清单下移（见下）。

**文档债务（登记；①③ 已于 2026-12 合入修订轮闭合）**：① §6 正文已按
实现对齐（部分失败走 `role="alert"` 错误行 + step3 复查仅 connected 的
E-m2 理由入文）；② **占位/幽灵窗口措辞（2026 实机证伪并修正，见 §20）**：
vendor `sessionIds` 为内存 header 索引派生，内容删除后至重启/下次实体写
前，官方 workspaceView 仍含占位 id——原断言「chamber 可见行不受影响」不
成立：§14 残余定案后 purge 收尾把完成树根移出 archived 集合，官方客户端
ctx 的会话行 summaries（仅连接代数刷新）在集合移除后不再被归档过滤覆盖，
被删会话以普通行浮出、点击即 `session/not-found`；§20 的会话列表刷新
seam 为该窗口的收敛机制；③ §3 错误码枚举
已并入 `purge-capacity`/`archive-set`/`truncated`（含 65,536 上限与
不可重试登记，Minor-5）；④ desktop 激活恒全量 vs seed 产物门为设计内取舍
（构建期 preflight 兜底），登记不修；⑤ seam 退役机制化：上游 unarchive/
delete wire 落地即退役 enqueueOperation/setState seam + probe 端点 + seed
行，且结构 seam 核对列入每次 harness pin 升级清单（STATUS 跟踪项）。

**合入修订轮处置（2026-12，合入前闭合）**：M1（§14 残余定案，见上）；
M2（binding `listHeaders` 回退意图注释：cordis inject 全量服务语义下，
persistence.list 回退守卫的是「已挂载但方法不全」的表面漂移并服务单测
直用，非缺失服务路径）；M3（probe 面扩展：`assertHostSurface` 增加会话
枚举/存储面结构检查，binding 测试补通过/全缺/缺存储三态）；M4（§4 step7
运行窗口登记，上——2026-09 修复轮按实现定稿为成员失败中止整树语义，§16-1）；
M5（purge-capacity 不可重试 + 无逃生口登记入 §3）；
N1（完成树覆盖的已归档后代同批清除 + core 单测）；N2
（`resolveDeletableTree` 改显式栈迭代后序，消除递归深度=链深风险）；
N3（binding 删除产物 rm 的 ENOENT 竞态 → 幂等 `missing`）；N4（无 cwd
成员的逐删全库重列确认为稀有路径，代码注释登记）；N5（AGENTS.md 事件
表述改为「文档化 no-op」）；pending-click.ts 守卫清单注释补齐
archive-cleanup；host 包提交态 dist 随代码重建（esbuild 0.25 确定性比对
通过）。

## 16. 合入后修复轮（2026-09，评审遗留闭合登记）

合并 989534a 后的评审轮处置登记：代码与测试**已落地于工作树（未提交态，
随本修复轮 commit 合入）**，本文档与台账/README 同轮收口；域外配套
（git-worktree / desktop updater）见 design 08 §11.8 与 design 11 §9。

1. **purge 树中成员失败中止语义（含新测试）**：首个树内成员失败（删除瞬间
   `running` 拒绝 / `storage` 存储错误 / 事件发射失败）即**中止本树剩余
   删除**——失败成员与全部未删祖先（含根）保持原样、根保持 archived，前序
   已删成员不回滚；根会话记录位于其自身内容目录内，删根会让下次 purge 把
   根当孤儿清出、不重枚举幸存成员（静默泄漏），故整链保留待重跑收敛
   （core.ts `purge()` 树中止 + core.test.ts 新增 mid-tree running/storage
   中止与 rerun 收敛用例；§4 step 7 措辞已按此定稿）；
2. **binding header 字段级 loud 校验（防 vendor 字段漂移静默化）**：
   `assertHeaderShape` 逐字段（id/cwd/parentSession/origin）校验，漂移记录
   fail-loud `registry-unreadable` 并点名会话与字段——绝不逐条静默跳过而把
   级联/删除级联清空（binding.ts + binding.test.ts F3 用例 ×5）；
3. **客户端畸形嵌套载体 fail-loud**（与宿主探针 accept 语义/git 客户端
   一致）：双层域载体形状契约——载体缺失/非对象、ok 非布尔、ok:true 无
   对象 value 一律 loud throw，不再静默折算 0/空结果；404 判别体改有界读取
   （instance-api.ts `decodeDomainResult` + `readNotFoundBody`；instance-api
   .test.ts 新增 fail-loud 与有界 404 用例）；
4. **预览计数/容量/archive-set 截断注释对齐**：core.ts 注释按成员口径修正
   （archived = 集合成员总数、含被归档 subagent 行；deletableSessions = 可删
   集合成员根数）+ 容量门注释（上限按 archived 集合成员计，review F5）+
   收尾 archive-set 记录共享条目上限的截断注（review F4）；design 24 §3
   wire 注记同轮对齐；
5. **死代码 per-member 预检移除**：逐成员 O(1) running 预检为死代码（整树
   级 live recheck 已证非 running）→ 移除；binding 删除时 live 守卫成为
   唯一 mid-window 门并承载中止语义（core.ts/binding.ts 注释，review F2）；
6. **git-worktree missing 行探针门（design 08 §11.8 配套，另见 08 文档）**：
   §11.8「缺失行不得被任何文件系统探测触碰」承诺在删除/重放路径强制执行
   ——vanished-cwd 行免 dirty/submodule 探针、未注册删除降级残留记录清理
   （dsh-chamber-seed-git-worktree/src/core.ts + test/core.test.ts 新增 3 例）；
7. **updater 重启失败恢复（design 11 §9 配套）**：desktop 重启腿失败显式化
   ——`restartFailureText` 一次性失败携带 + 重启 stall watchdog（未 arm/
   超时复位单飞并放行重试），失败不再静默滞留（desktop/updater.ts +
   updater.test.ts；另见 design 11 §9 与其文档轮登记）；
8. **台账/README 前文收口**：本文件头部状态、§4 step 7/§6/§7 A/§12 措辞、
   §15 Minor-4 指针与 todo 台账（§0/§2/§3–§5/§8 标注、头部状态）及 README
   目录行 5 按执行态对齐（本 commit）。

（同轮代码侧另含：SidebarRoot 卸载守卫与断连双确认窗口注记（review F9，
代码注释声明 §6 step-2/§8 接受——§8 已补「重连双确认窗口」接受句，见上）、
客户端 404 判别有界读取（F10，见条目 3）。）

**编号说明**：§13 空号（历史修订留空）；§14/§15 为合入前实现与评审登记，
§16（2026-09 合入后修复轮）接于其后；§17（2026-09 修订轮：M4 本地实跑 +
归档管理器 revision）为 wire/UI 表述基线；§18（2026 用户修订轮：移除
独立「删除全部」按钮）与 §19（2026 分组实施轮：工作区分组折叠）为最新
修订——§17.3/§17.6 的「删除全部」相关表述以 §18/§19 为准；§19 条目
6–9（合入后修订：缩进容器化、整体匹配轮、全面重构轮、四方分面评审处置
轮）续接——交互/样式表述以 §19 最新条目为准。

**§16 补记（2026-09 第二波回扫）**：三路只读回扫零新 Blocker/Major；本域
复核结论——`assertHeaderShape` 谓词严格弱于 pinned vendor 写入期校验
（origin 仅 absent/'subagent'、cwd 恒非空绝对串、parentSession 恒字符串，
vendor 自身拒绝损坏行），无真实数据误伤面；purge 中止语义与截断/计数/
rerun 收敛互操作经代码追踪成立；dist 已镜像。补强落点：`emitSessionRemoved`
实现契约注（必须包 `ArchiveCleanupError`；删除成功后事件失败的「双重呈现」
为接受语义，rerun 经 'missing' 收敛）。桌面复原性补强与文档/文案勘误登记
见 STATUS「2026-09 修复轮第二波」与 design 11 §9 / design 08 §11.8 配套注。

## 17. 2026-09 修订轮：M4 本地实跑处置 + 归档管理器 revision（wire 修订）

用户驱动 revision：M4 实机验证在真实本地 dsh 实例执行（此前 M4 待验），
同时按用户要求把交互从「v1 server 行 hover 确认按钮流（preview →
window.confirm → purge 全部）」升级为**归档管理器对话框**（列出具体已归档
会话，支持逐条 / 多选 / 清空全部〔2026 修订：独立「清空全部」已随 §18
退役，整集删除 = 显式全选；列表按工作区分组折叠见 §19〕），并据此修订
宿主 wire。处置登记：

1. **删除失效根因（M4 实跑发现并修复）**：`binding.ts` `deleteSessionContent`
   先解构 `const locate = persistence?.locate` 再脱绑调用——官方
   `SessionPersistence` 实现是实例状态类（jsonl `locate` 读 `this.root` /
   `this.compression`），脱绑调用使 `this === undefined`，**每次删除**都以
   `Cannot read properties of undefined (reading 'root')` 失败（真实实例
   18/18 项 storage 错；隔离复刻实例同样复现）。修复 = 保持方法接收者调用
   （`persistence.locate(header)`）；回归单测用 this 敏感 fake（读
   `this.root` 的 locate 方法）钉死——修复前必红。旧单测全部用箭头函数
   fake（this 无关），是漏网的直接原因（§16-2 同族教训）。
2. **wire 修订：purge 可选 `sessionIds` 子集过滤**（§3 契约修订）：
   `archiveCleanup/purge(sessionIds?)`——`undefined` = 全量（旧形状
   `{args:{}}`，向后兼容，老客户端零改动）；数组 = 只把列出的 archived
   集合成员当作候选根（各自整棵可删子树）。**越界结构性不可能**：候选
   恒 = 权威 archived 集合 ∩ 请求（core.ts，读时取交集），已离开集合的
   陈旧 id（并发 purge/陈旧列表）静默跳过（幂等），非 archived 会话不可
   达；过滤校验失败（非串/空串/超 `MAX_PURGE_SESSIONS`）→ 新业务码
   `invalid-request`（全量路径容量码 `purge-capacity` 语义不变；超容量
   集合仍可做有界子集 purge）。客户端 wrapper
   `purgeArchivedSessions(client, sessionIds?)` 相应传参（无过滤仍发
   `{args:{}}`）。子集模式下 set 收敛语义不变（completed 根 + covered
   archived 后代 + orphan 同一收尾批量写移除）。
3. **归档管理器 UI（替代 §6 v1 流程）**：server 行 trash 按钮 → 打开
   对话框：列出该源已归档会话（标题 + 目录标签），逐行 checkbox 多选 +
   全选，逐行删除、删除选中、删除全部（2026 修订：独立「删除全部」按钮
   **已移除**，整集清理 = 显式全选 + 确认删除选中，见 §18）；销毁动作保持
   confirm 门（不可恢复文案，逐条/选中两形态）；运行结果内联呈现
   （role=status/alert）：完成摘要、运行跳过、部分失败（明细前 3 条）、
   busy、域缺失 404、超时/网络中断诚实文案——错误绝不静默。v1 的 header
   下错误槽位、purgeInFlight/cleanupNotes 状态与 preview→confirm 流整体
   移除。数据源：**对话框不发任何新读取**——行元数据（id/title/cwd/
   updatedAt）走 bridge 新投影字段 `ChamberServerAggregate.archivedSessions`
   （`deriveArchivedSessions`：快照 sessions ∩ archivedSessionIds，仅元
   数据、不读会话内容；服务器端官方行本就携带归档行，chamber 只是此前在
   可见性层丢弃）。**归档集权威性三态**（2026-09 评审修复轮）：
   `archiveSetKnown:true`（挂载基线）的空列表 = 真「无已归档」；unary 兜底
   快照（KNOWN DEGRADATION，无 wire 源）标记 `archiveSetKnown:false` →
   对话框走**降级分支**：不声称空态、不列行；2026 修订后此分支**不再提供
   任何删除动作**（原「仍保留删除全部」随独立按钮一并退役——见 §18）；
   快照未落地的 `pending` 分支显示加载/拉取错误（原「错误态放行删除全部」
   同样退役）。
   `serversProjectionSignature` 纳入 archivedSessions 与 archiveSetKnown
   保证 purge 后 bridge 重发布、对话框列表随刷新收敛（选中集按幸存行
   修剪；签名内容只取 id+updatedAt——归档行标题/目录无任何 UI 变更面）。
   范围：v1 不做搜索/目录过滤/恢复（无 unarchive wire）；rail/窄栏不做。
4. **§2 边界口径更新**：purge 的 caller-supplied id 输入只可能收窄删除集
   （读时交集），「域无读取面/不返回标题」维持——对话框行元数据来自官方
   会话投影（客户端既有快照），不新增宿主读取端点。AGENTS/§3 的「零参」
   表述由本修订取代（§3 wire 块与 §5 客户端接入段随本修订更新）。
5. **验证**：host core/binding 51 例（35 core + 16 binding；含子集过滤
   15 例与 locate-this 回归）、sidebar 全套 284 例（含 deriveArchivedSessions、
   purge 过滤转发、签名参与、降级标记）、根 typecheck + typecheck:sidebar/
   host-archive-cleanup + verify:i18n + build:renderer 绿；提交态 host dist
   重建；隔离复刻实例 E2E（全量 purge 修复前红/后绿、子集 purge、陈旧 id
   幂等）。剩余实机腿：gateway/远程 dsh 形态、打包版 UI 目检（登记 STATUS）。
6. **评审修复轮（2026-09，4 个只读 subagent 分面评审 + 作者裁决）**：
   - **降级视图诚实性**：归档集权威三态（`archiveSetKnown`）落地（§17.3），
     消除 unary 兜底下的「没有可删除的已归档会话」误报与删除全部能力回归
     （v1 全量 purge 在未挂载来源本可用）；
   - **core 收口**：子集过滤校验先于权威读取（畸形请求不付全库扫描）、
     空选集短路（零读取）、clearIds 去重、桶语义注记（archived subagent 行
     单独成根计 deletedSessions；被覆盖时计 deletedSubagents——UI 不列
     subagent 行，仅 wire 可达）；
   - **版本错配实证**：generic gateway `assertExactArguments` 对描述符外
     键**严格拒绝**（复刻实例实测 `unexpected "sessionIds"`）——新客户端子集
     请求到旧宿主绝无「静默全量删除」分支；该 `gateway/arguments-invalid`
     在 purge wrapper 重映射为 zh 重启提示（删除全部仍可用）〔2026 修订：该括注后缀已随 §18-3 移除——提示仅建议重启 dsh〕；
   - **UI 收口**：关闭策略统一（Esc/X/遮罩任意时刻可关——关闭不取消宿主
     purge、requestRefresh 仍无条件发出）、Tab 焦点圈闭 + 关闭焦点还原、
     snapshot 拉取错误呈现（替代永恒 loading）、删除全部确认文案去计数〔2026 修订：独立「删除全部」与去计数确认已随 §18 退役〕
     （宿主删除集可大于列表：subagent 成员从不入列）、空列表（权威）时
     disabled 与 v1 一致；
   - **死代码/注释清理**：旧 `confirm.purgeArchived*` locale 键、
     `.cleanupNote`/`.archiveManagerActions` CSS、过时注释、未用
     data 属性；`previewArchiveCleanup` 保留并注明为宿主 preview 端点已测
     客户端半面；
   - **测试补强**：covered 祖先同选（N1 语义子集化）、archived subagent 行
     独选（祖先不删）、子集 F1 树中止、重复过滤 id、畸形/空过滤零读取、
     `[]` 载荷形状端到端、旧宿主拒绝 zh 文案、serversProjectionSignature
     参与 archivedSessions/archiveSetKnown 的回归测试。

## 18. 2026 用户修订轮：移除独立「删除全部」按钮（delete-archived 分支）

用户驱动修订（delete-archived 分支，2026）：归档管理器当前同时存在
「删除选中（N）」与「删除全部」两个破坏性按钮——**移除独立「删除全部」**
按钮，整集清理的唯一路径 = 用户先显式勾选全选、再确认带计数的
「删除选中（N）」。同时按用户要求落地「按工作区分组、可折叠」的列表形态
（§19）。本节取代 §17.3/§17.6 中「删除全部
仍可用/放行/去计数」的一切表述。处置：

1. **UI 语义收窄为「列表即唯一可删面」**（ArchiveManagerDialog.tsx）：
   footer 只剩条件渲染的「删除选中（N）」（列表视图且选中数 > 0 时）；
   `deleteAll`/`deleteAllDisabled` 与「删除全部」按钮整体移除；
   `runPurge` 收窄为必带 `sessionIds` 数组——UI 不再有任何
   `purge(undefined)`（整集）调用路径；对话框模块文档的 VIEW MODES 同步
   改写。全选 checkbox（顶部行）保留且语义不变：勾选 = 选中**当前列出的
   全部行**，随后「删除选中」的 confirm 携带实际计数（`confirmSelected`），
   文案对所选行树（含其子代理内容）负责——不再有「不限于当前列表」的
   整集承诺。
2. **降级/错误视图不再放行删除**：`archiveSetKnown:false`（unary 兜底，
   KNOWN DEGRADATION）与快照未落地（loading/拉取错误）分支只呈现说明性
   文本（degraded/listUnavailable/loading），**无任何破坏性动作**——原
   「删除全部是列表无关的逃生口」（§17.3，`purge(undefined)` 直击权威
   整集）随按钮一并退役。自愈路径保留：来源的挂载基线就绪后 bridge 重新
   发布，对话框从 server prop 自动重新派生为列表视图（无需重开）。登记
   的范围后果：**无挂载基线的来源（从未推送/未挂载窗口，含部分远程形态）
   在其降级窗口内无法清理任何已归档内容**（v1 能力回归，用户决策接受；
   若未来需要，须等 unary 侧出现归档集 wire 或上游 delete wire——§11
   退役条件同源）。
3. **版本错配提示对齐**（instance-api.ts）：旧宿主（零参 purge）拒绝子集
   过滤的 zh 重启提示删除「（删除全部仍可用）」后缀——新 UI 下旧宿主拒绝
   管理器的**每一次**按条删除，提示如实改为仅建议重启 dsh；wrapper 的
   `undefined`（整集）legacy 形状**保留**为已测的 wire 层契约（测试仍覆盖
   「no filter keeps the zero-arg shape」），但注明无 UI 调用者。
4. **locale 清理**：`archive.manager.deleteAll`/`archive.manager.confirmAll`
   两键从 zh/en 双字典移除（typecheck:sidebar 的 satisfies 对称门禁）；
   `degraded` 文案改写为
   「基线就绪后自动列出、届时可勾选/全选删除」，不再承诺「仍可删除全部」。
5. **测试面**：既有单测无直接引用已删 locale 键；`deriveArchivedSessions`/
   `serversProjectionSignature`/purge 转发测试不变（wrapper 契约未动，仅
   注释与文案）；旧宿主拒绝用例的断言（`includes('版本过旧')`）继续成立。
   组件行为（无独立删除全部按钮、降级分支无动作）为对话框渲染面，验证 =
   typecheck + 人工目检（登记 STATUS 的打包版 UI 目检腿一并覆盖）。

**工作区分组方向（用户提出）**：已按 §19 实施落地（同轮：移除独立「删除
全部」按钮——见上 1–5 与本段上一句）。

## 19. 2026 分组实施轮：归档管理器按工作区分组、可折叠（delete-archived 分支）

§18 同轮落地（用户批准修订方案；先经既有组件/样式 review——复用结论见
下 4）。既有审查面：导航工作区折叠样式与 accent（同 css module 内可复用）、
PluginDialog 多选行（跨包不可复用，仅交互先例）、官方 DisclosureRow
（24px 设置流式行、title `flex:none` 不可省略号、无尾部插槽，语义不符，
弃用）、官方 FoldToggle（带 hidden 计数的文字折叠钮、无 icon 槽，官方
ui-workspace 用，弃用）、
官方 Checkbox 不存在（原生 input + accent-color 为四插件共用惯例）。处置：

1. **归属在 App 派生层计算**（derive.ts，零新增宿主读取、零 wire 改动）：
   `ArchivedSessionMetaRow` 增可选 `workspace?: { id, title }`；
   `deriveArchivedSessions` 建立归属索引——**权威成员关系优先**
   （snapshot workspaces 的 sessionIds，registry header 索引：归档不摘除
   成员、内容清理才自愈账目），其次**规范 cwd==path 回退**（尾分隔符
   归一化的等值比较——`canonicalPathKey` 提升为模块级、与
   projectInstanceSnapshot 的 cwd 合成共享同款文档化限制），两者皆不中 =
   无归属（删除的 workspace 的孤儿会话 → 管理器「未分组」桶）。纯函数
   `groupArchivedRows`（导出、node 单测）：组按**组内最新会话倒序**、
   组内按 recency 倒序、未分组桶恒尾置（导航 trailing-bucket parity）。
   `serversProjectionSignature` **无需加字段**：workspace 标题/成员变化已由
   workspaces 块驱动重发布，归档行随之重派生。
2. **对话框 UI**（ArchiveManagerDialog.tsx）：列表 = 顶部全选行（语义
   不变：勾选 = 全部已列出行，**含折叠组**）+ 每工作区一个可折叠组段。
   组头 = 组复选框（原生、部分选中经 ref 设 `indeterminate` 三态）+ 折叠钮
   + 标题（600 字重、省略号）+ 「已归档 N 个会话」计数（复用 rowCount 键）。
   折叠为**对话框本地视图态**（默认展开、不持久化、不与导航 folded 互扰、
   只藏行不改选中）。折叠/全选/组选与「删除选中（N）」的关系不变：purge
   仍只携带显式 id 列表。组头折叠钮复用**导航同款 chrome**：本 css module
   的 `foldToggle/foldToggleFolded/foldToggleFolder/foldChevron/foldFolder`
   类 + `workspaceAccentStyle(server.id, key, gitFlag)`（git flag 已加载时
   同 seed——accent 与导航同工作区一致）；不整体复用 `.workspaceHeader`
   （其 hover 隐计数依赖导航动作簇）。新增少量组段 css
   （`.archiveManagerGroup*/…` + folder↔chevron hover 交换规则）。
3. **locale**：仅新增 `archive.manager.groupSelectAria`（zh/en 成对）；
   其余复用既有键（`workspace.expand/collapse`、`list.ungrouped`、
   `rowCount`、`selectAllAria`…）。
4. **测试/验证**：derive 侧新增 4 例（成员归属、cwd 回退 + 尾分隔符归一、
   组序与未分组尾置、空输入与自洽排序）——sidebar 全套 **288/288 绿**、
   `typecheck:sidebar` 绿、根 `typecheck` 唯一报错为 gateway 测试的
   **既存漂移**（public-http.test.ts 缺 `longRpcRequests/longRpcTimeouts`，
   与本轮无关）。对话框渲染面验证 = typecheck + 人工目检（登记 STATUS 的
   打包版 UI 目检腿一并覆盖）。范围外不变：降级/错误视图无动作（§18-2）、
   无搜索/恢复、rail/窄栏不做。
5. **评审修复轮（2026，4 个只读 subagent 分面评审：逻辑正确性 / 完整性 /
   代码质量与最优性 / a11y 与交互——Blocker 0、Major 1；作者裁决）**：
   - **性能（Major M1，部分采纳）**：`deriveArchivedSessions` 位于渲染路径、
     先于签名发布闸，空归档集/零命中行也建索引+排序 → 采纳零行快速路径
     （`archivedSessionIds` 空或过滤零行直接返回，不建 Set/索引/排序）；
     **App 侧按 identity-preserving aggregate 对象做每源派生缓存未采纳**——
     跨 mounted push/merged pull 双生产路径的缓存失效管理复杂化收益面窄，
     登记为后续轮候选（65k 规模+高频 derive 场景再现时再议）。
   - **a11y/交互采纳**：顶部全选行补 indeterminate（与组头三态一致）；组
     复选框在部分选中时显式 `aria-checked="mixed"`（HTML-AAM 对 native
     indeterminate→mixed 无规范保证）；busy 整头 60% 变暗改为**仅复选框**
     变暗（折叠钮 busy 期仍可用，视图态）；行删除钮与组折叠钮补品牌
     `:focus-visible` 环；purge 刷新卸载聚焦行后焦点落 body 的**回焦 panel
     兜底 effect**（非 trap）。
   - **清理/注释/文案采纳**：instance-api.ts 降级 docblock 残留「keeps
     whole-set purge available」与超时文案「重新预览」措辞、SidebarRoot
     挂载注释旧三分法、zh degraded 文案补「逐行删除」、derive.ts 签名注释
     补「无 UI 面可移动/改 cwd 归档行」论证；css hover-swap 规则并入导航
     共享选择器表（消除同体两表）；derive.test.ts 补「成员关系优先于 cwd」
     冲突 fixture（原 fixture 倒置实现也能全绿）。
   - **复核后不改（登记理由）**：wrapper `undefined` 整集 legacy 形状保留
     （已测 wire 契约、注明无 UI 调用者）；组内排序保留为纯函数自洽防御
     （注释点明代价）；`listVisible` 的 `rows.length>0` 并非冗余（同派生
     同时门控 footer，化简会让权威空态露出 disabled 删除钮）；折叠钮 aria
     label 追加组名与初始焦点改列表首控件暂缓（需打包版目检确认读屏语序，
     避免 locale 相关标点拍脑袋）；STATUS.md 登记按仓库惯例随合入 commit
     收口（§16 先例）。
   - **文档对账**：§18-4 门禁表述改「typecheck:sidebar 的 satisfies 对称
     门禁」（verify:i18n 只校验顶层双语文档对）；§17.6 两条历史 bullet 补
     2026 原位标注；§6 引言与 §17 导语补第三跳标注；design 01 地图行同步。
     修复后验证：`typecheck:sidebar` 绿、`test:sidebar` 全绿（冲突 fixture
     并入既有成员归属用例，用例总数不变）。

6. **session/workspace 缩进关系修正（2026 用户提出，delete-archived 合入
   main 后；实现经 §19-7 匹配轮复核改为容器式）**：分组列表的 session 行
   相对组头**嵌套一级**：每个展开组把行渲染进专用嵌套容器
   `.archiveManagerGroupRows`（`padding-left: 24px`，祖先侧缩进——见
   §19-7 对结构选择器/子级 margin 方案的取舍记录）。
   几何：组头标题 x = 8 pad + w + 8 gap + 16 折叠钮 + 8 gap = **40 + w**；
   嵌套行标题 x = 24 step + 8 pad + w + 8 gap = **40 + w**——原生 checkbox
   宽度 w 在两边抵消，任何平台下**行标题列与所属组标题精确同列**，层级由
   checkbox rail 台阶（8 → 32）+ 折叠钮表达。全选行与组头保留外列；未分组
   桶行同规（其合成组头下同样嵌套）。修正前组头标题因 checkbox+折叠钮反而
   比下方 session 标题靠右 ~24px（父子缩进倒置读法）；本规则同时修正该倒置，
   session 不再比自己的 workspace 标题更靠左。

7. **dsh/仓库整体匹配轮（2026，用户发起：选择器设计 + 样式/交互/界面风格
   对照审阅；代码落地 + 维持项登记）**：
   - **缩进选择器方案（答复用户问题）**：`.archiveManagerGroup >
     .archiveManagerRow { margin-left }`（结构子选择器 + 子级 margin）**不是
     行业最优做法**——行类 `.archiveManagerRow` 同时被顶部全选行复用，层级
     语义由 DOM 位置推导：今后任何包裹/虚拟化插入都会静默破坏规则（双向）；
     margin 式缩进把「层级」摊到每个子行上。最优静态树做法 = **祖先容器
     padding 缩进**（一次声明、行类与层级无关、包裹/虚拟化天然兼容；官方/
     仓库惯例里树形容器与行级专用类并存，但复用行类场景下容器是唯一不
     依赖位置的方案）。已按此落地（item 6 重述）。
   - **危险确认门**：对照官方原语 `RiskConfirmation`（Modal 家族、勾选
     acknowledge 才可确认；settings-bridge PermissionRow 已采用——官方设置
     面先例）。本对话框**维持 window.confirm**：官方 Modal 每次 open 都挂
     document 级 Escape 监听且互不知晓 → 确认弹层叠在管理器 Modal 之上时
     **一次 Esc 会同时关闭两层**；双 mask 叠影；仓库内无嵌套 Modal 先例
     （PermissionRow 的确认不在任何 Modal 内）。若上游 Modal 获得层级
     （stack/优先级/Escape 仲裁），再迁 RiskConfirmation——登记不排期。
     **〔原位注：本条已由 §19-8 取代——全面重构轮在本模块范围落地
     对话框内两段式确认（非 OS 弹窗、非第二层 Modal），维持结论中的
     嵌套 Modal 风险分析仍然成立；以 §19-8/§19-9 为准。〕**
   - **键盘焦点环常数对齐**：行删除钮/组折叠钮 focus-visible 由
     `outline-offset: -1px`（内嵌环）改为模块 `.actionIcon` 标准 +1px 外扩
     （原注释声称跟随 actionIcon 但常数并不一致——修正注释与实现；§19-8
     重构后行删除钮直接并入 .actionIcon 基类，专属环表删除）。
   - **复核维持项（理由登记；§19-8 已落地其中可执行者）**：danger 动作 =
     官方 Button outline + error ink（仓库无 danger variant 先例，ui-git
     remove-confirm 惯例）；原生 checkbox + accent-color（官方无 Checkbox
     组件，§19-2 记录）；footer Button/icon/字体均走 alias token；组头
     chrome 复用导航 fold 类已并入共享选择器表；zh 内联文案 §5 纪律；
     spinner 13px（导航 12px）随所在行高，维持。
   - **验证**：`typecheck:sidebar`、`test:sidebar`、`build:renderer` 绿
     （本轮代码改动）；视觉确认仍待打包版目检（STATUS 登记的打包版 UI
     目检腿，design 24 §16/§17 先例）。
   - **武装态行为补记（§19-9 评审追认，实现早已如此）**：武装期关闭对话框
     （X/mask/非武装态 Esc）只丢弃武装、绝不删除任何内容（与关闭期运行中
     purge 照常继续的语义区分开）；武装期 footer「删除选中」隐藏（防双
     入口）；bridge publish 把列表收成空/降级视图时风险条仍在（渲染在
     VIEW MODES 条件外）——accept 仍按冻结 id 执行，宿主交集语义保证安全
     方向，空结果走「没有可删除…」兜底。

8. **全面重构轮（2026 用户发起：按最优方案重构，随后复核）**——落地
   item 7 中可执行项 + 交互重构：
   - **两段式确认门替换 window.confirm（本模块范围）**：破坏性动作不再走
     OS 原生弹窗，也不叠第二层 Modal（官方 Modal 每开一次注册一个
     document 级 BUBBLE Escape 监听、互不知晓——叠层时一次 Esc 双关，且
     无官方嵌套先例，见 item 7）。改为**对话框内武装态**：`confirming`
     状态（id 列表在武装瞬间冻结 + 单行标题或计数文案）→ 行输入全冻结
     （`inputLocked`：checkbox/行删除钮/全选禁用；折叠钮保持可用——
     视图态）+ 面板顶部**风险条**（官方 Warning 图标 error 墨 +
     color-mix error 9% 底 + 陈述式不可恢复文案 + 官方 Button sm 对：
     取消/确认删除）。取消或 **Esc 解除武装**（Esc 经 document CAPTURE
     相位 stopPropagation，官方 Modal 的 bubble 监听不触发——武装期 Esc
     绝不关对话框；解除后 Esc 恢复默认关闭语义）；确认删除 → 解除武装 →
     `runPurge(冻结 ids)`。焦点：武装落**取消**（条内首个 button，安全
     默认）；取消/Esc 焦点回**武装源控件**（行删除钮/footer 钮，`isConnected`
     兜底 panel）；确认后条卸载致焦点落 body → busy/rows 双依赖的既有
     焦点兜底效应接管。文案改为陈述式（原「…继续？」为对话框问句残余），
     新增 `archive.manager.confirmDelete` zh/en 对；`role="alert"` 播报
     风险条。单选与多选共用同一条，只换主体文案。
   - **行删除钮并入模块 `.actionIcon` 家族**：删除 24px 专属样式四段
     （基类/hover bg+error/disabled .5/焦点环）→ `<button class="actionIcon
     actionIconDanger">`：20px 命中 + 纯色 hover 是模块图标按钮语言（行
     pill 已承 hover 底）；`actionIconDanger` 修饰 hover 转 error ink；
     disabled .42 与焦点环随基类（无第二张表可漂移）。
   - **hover 重复规则并入导航共享表**（消除同体两表，item 7 曾登记维持）：
     `.workspaceHeader:hover` + `.archiveManagerGroupHeader:hover` 合一；
     `.sessionRow:hover` + `.archiveManagerRow:hover` 合一（含全选行）——
     值与 token 相同，沿 §19-5「folder↔chevron 共享规则表」先例。
   - **风险登记（如实）**：两段式交互（武装/解除/焦点/Esc 语义）与
     actionIcon 视觉收窄（24→20、hover 去底）仅经 typecheck/单测/构建
     验证——对话框渲染面无组件测试基建（§19-4 已登记同况），视觉与键盘
     实感待打包版目检（STATUS 登记的打包版 UI 目检腿）；若 Esc 捕获与
     其他 surface 的 capture 监听冲突，回退点为武装期仅阻止对话框关闭
     （去掉 stopPropagation 全局语义，改由 disarmConfirm 显式拦截）。

9. **四方分面评审处置轮（2026，用户发起「subagent 从正确性/完整性/最优性
   等角度彻底检查」；4 个只读 subagent：逻辑正确性 / 完整性 / 代码质量与
   最优性 / a11y 与交互——结论：正确性 1 Major + 2 Minor、完整性零
   Blocker/Major（doc 层若干 Minor/Nit）、最优性 2 Minor + nits、a11y
   1 Major + 6 Minor）**：
   - **Major（三方互证）——取消/Esc 焦点回退在行删除路径静默失效**：
     `disarmConfirm(true)` 原同步调用 `opener.focus()`，但武装期 opener
     仍带 `disabled`（inputLocked，解除提交前不落）→ 对禁用控件的 focus()
     是规范 no-op → 焦点落 body 且 `[rows,busy]` 守卫不触发。修复：解除
     后经 `requestAnimationFrame` 延迟回焦（提交后 opener 已重新可用），
     frame 内重查 `isConnected`，失联则落 panel（关闭窗口期自身卸载时
     no-op）；footer 路径经 isConnected 兜底本就安全。accept 无需显式回焦
     （busy 翻转 + 守卫接管，a11y 分面确认）。回归验证 = 打包版键盘腿
     （行删除武装 → Esc/取消 → 焦点在行删除钮；accept → panel）。
   - **Minor 修复（本轮落地）**：`toggle/toggleAll/toggleGroup` 补
     `confirming` 守卫（武装冻结不再只靠 disabled 属性）；焦点丢失守卫
     去掉 `rows === undefined` 早退（列表视图消失后的 accept 也能落
     panel）；`server === null` 时自动解除武装（旧冻结 id 不得随新列表
     复现）；`role="alert"` 从风险条容器移到**纯文本消息 span**（容器首钮
     同 commit 抢焦点 → SR 播报竞态，APG 文本性 alert 惯例）；全选主
     checkbox 补显式 `aria-checked="mixed"`（组头三态 parity，HTML-AAM
     无规范保证）；焦点环常数合并为 `.actionIcon:focus-visible,
     .archiveManagerGroupHeader .foldToggle:focus-visible` 单一规则表；
     对话框小字号族（NoteRow/Error/ConfirmText）合并共享字体规则；
     `disarmConfirm` 收敛 accept/取消/Esc 三处解除路径（消除重复与死
     参数）。
   - **登记为偏差/待目检（理由登记）**：行删除钮 20px 命中 < WCAG 2.2
     2.5.8 的 24px（模块图标按钮语言全局标准，§19-8 收窄为语言合并的
     结果——登记为模块级偏差，视觉腿复核）；武装期行 dim 0.6 × trash
     .42 ≈ 0.25 复合（评审计算 token 对比度仍 ≥ AA——冻结核的意图
     反馈）；9% wash 强度与深浅主题可读性、风险条 SR 播报顺序（NVDA/
     VO）、窄卡换行与矮视口裁剪（<~480-540px）、行 aria 标签在重复/未
     命名标题下的非唯一性（并入 §19-5 已登记的 SR 语境目检项，追加
     project label 或容器 group 语义待 SR 腿验证后定）、两处「取消」标签
     同现（条内取消 vs 头 X=action.cancel；Shift+Tab 会先触 X——X 语义为
     关整个对话框，保持）、held-Escape 连发无害（解除→关闭良性链）、
     dark 主题 danger ink ~4.25:1 为 token 级共享惯例。
   - **模块 doc/§19-6/7 原位对账（完整性分面）**：§19-7「维持
     window.confirm」条已加原位注（被 §19-8 取代）；头部/§6/编号说明
     跳转补至条目 9；模块 doc 补武装态关闭与 footer 隐藏语义、修正
     window.confirm 动因表述（本模块范围——同包 SidebarRoot 导航流仍走
     window.confirm）、修正孤儿句与「controls disabled」概括；§19-8 增
     验证 bullet 与武装态行为补记。
   - **验证**：修复后 `typecheck:sidebar`、`test:sidebar`、`build:renderer`
     重跑绿（见 §19-8 同款命令）；键盘/视觉项打包版目检腿。

## 20. 2026 purge 幽灵行收敛轮：官方会话列表刷新 seam（delete-archived 分支）

实机现象（用户报告 + 本机数据实证）：归档管理器整集/多选删除后，**已删
会话以普通会话行重新出现在侧边栏**，逐行点击触发官方对话区
「历史加载失败：session "…" not found（session/not-found）」（官方
`chat.loadError`，session-controller 对磁盘重扫无此会话的回答）。现场核
对：purge 内容目录删除与归档集合成员移除均成功（workspace.json 归档集合
已不含目标 id），但官方客户端 ctx 会话行与 workspace 成员账目仍列这些 id
（本机实例 workspace.json 每工作区 13–18 个无目录成员占位）。

**根因（三层，均经 pinned vendor 0.1.2-rc.1 运行时源码核实）**：

1. 宿主删除对官方运行时不可见——`emitSessionRemoved` 等为文档化 no-op
   （§10/§14）；
2. 服务端冷读面**即时自愈**：`session-persistence-jsonl.list()` 每次调用
   重扫磁盘、`session-query` 的 `SessionCorpus.listSessions()` = 持久化重扫
   + live 合并——任何服务端/unary 列表都不会再含已删会话；
3. **滞留点在官方客户端 ctx**：`dsh-api-session-controller` client 的
   `SessionManager.summaries` 只在其 ctx 连接代数重建（`handleConnected` →
   `refreshList`）或本地 mutation 帧时更新，**无事件即无全量重列**；chamber
   的 mounted 快照生产者（sidebar client/index.ts）读的正是这份 store。
   purge 把 id 移出归档集合后，chamber 可见性过滤（archived ∩ rows）不再
   覆盖这些行 → **幽灵行以普通会话渲染**（mounted 推送整体替换聚合，
   App.tsx 提交路径）；`refresh()` 的 `mergeOrderedBaseline` 会丢弃服务端
   已不存在的行——即官方公开的收敛原语，但此前无人触发它。

**修复 seam（本轮的收敛机制，客户端零宿主改动；经 2026 三方只读 review
——正确性/完整性/最优性——修订为收敛状态机，见下）**：

- **桥通道**：`chamberBridge.requestSessionListRefresh(sourceId)` 广播 +
  `onRequestSessionListRefresh` 订阅（aggregate-store.ts，与 requestRefresh
  同构）。挂载 ctx 的 sidebar 插件按 `chamberInstanceId === sourceId`
  匹配后调用**官方公开面** `ctx.sessions.refresh()`（ClientSessions；
  运行时守卫，方法缺失与调用失败均 console.warn——失效绝不静默；同步
  throw 防御包裹——桥监听器异常不得中断 App 推送处理）；刷新完成后
  summaries 丢弃已删行 → store notify → 生产者 queueSnapshot → 推送干净
  快照 → App 全量提交替换聚合。未挂载来源无订阅者也不需要（其行走 unary，
  服务端逐调重扫）。
- **触发 1（App 收敛状态机，正确性主闸）**：mounted 推送提交前对**每一次**
  ready 推送评估 `planSessionListRefresh`（aggregate-refresh.ts 纯函数）：
  (a) 检测**归档集合收缩**（`archiveSetShrink`：无 unarchive wire ⇒ 收缩 =
  宿主 purge 完成集合移除的唯一客户端可观测信号；仅两侧 `archiveSetKnown:
  true` 才产生，降级空集永不误报）；(b) 收缩移除的 id ∪ 上一轮未收敛
  （pending）id 中**仍以行存在于本推送**者 = 幽灵候选；(c) 幽灵候选非空即
  请求会话列表刷新，并按来源以 5s 冷却封底重发节流（官方 refreshList 单飞
  兜底并发；忙碌来源上失败的刷新不会逐推送堆叠 RPC）；(d) 行消失即收敛
  ——pending 清空、状态机自终止。**覆盖超时续跑（宿主晚完成后的收缩推送）、
  跨壳/他处 purge、未来任何删除入口**；刷新瞬时失败由后续推送在冷却后重发
  收敛，被冷却压下的请求不丢 id（留在 pending 随下次推送重估）。行渲染的
  最终兜底：安静来源（推送停止）由 30s staleness 看门狗的 unary merge 拉取
  在 ≤1 个周期内把聚合 session 行换成服务端干净列表（行自隐），无需任何
  触发。仅推送侧评估是完备的：mounted 的 pull 提交保留当前归档集合
  （commitAggregatePull merge）、full-fallback 提交被 provenance 门挡住，
  pull 不可能先于推送观察到收缩。
- **触发 2（对话框即时路径）**：ArchiveManagerDialog 每次 purge settle
  （成功路径与 catch——超时/网络/busy 亦可能已有宿主侧删除落地）均请求
  一次，覆盖「收缩推送到达前」的窗口，且对话框关闭也不丢请求。注：对话框
  请求不进 App 的冷却戳（跨包解耦），与触发 1 在单次 purge 上重叠
  （≈2 次 session.list RPC，第二次通常空转）——purge 罕见、RPC 廉价，
  属有意的双通道冗余，非缺陷。

**修正**：§15-②「chamber 可见行不受影响」断言不成立（占位窗口内行可见），
原文已改为登记并指回本节。设计 05 §3 桥契约随之新增一对通道（同 requestRefresh
形态，非会话数据面，无权威性）——该清单已同步（见 05 §3 通道表）。

**验证与门禁**：`archiveSetShrink`/`shouldRequestSessionListRefresh`/
`planSessionListRefresh`（renderer aggregate-refresh.test.ts，含收敛/携带
pending/未知来源/legacy provenance 用例）与桥通道广播/退订（sidebar
aggregate-store.test.ts）单测绿。本 seam 执行腿（插件调官方 refresh、App
状态机接线、对话框触发点）无单测基建，验证 = typecheck + 人工目检（登记
STATUS 的打包版 UI 目检腿一并覆盖，含「幽灵行不再浮现」断言，§19-4 先例）；
完整工具链门禁（test:sidebar / test:renderer-shell / typecheck:sidebar / 根
typecheck）随合入 commit 收口。pinned vendor 前置事实（`refresh()` 存在且
mergeOrderedBaseline 丢弃服务端缺失行）已在真实运行时源码核验；合入门/实机
腿再验一次（插件 loose 守卫保证形状不符时只 warn 不破坏）。

**残余登记（不随本轮修）**：① 归档集合中的**历史无目录成员**（旧版 purge
保留的集合成员，本机实例 739 成员中 734 无目录）在「删除全部」退役后无 UI
路径可收敛（管理器只列「有行 ∩ 集合」，孤儿清理只在候选集内发生）——建议
后续把孤儿收敛改为每次 purge 收尾对全集合执行（与子集过滤正交、零新增删除
语义），作为独立项排期。**该登记同时覆盖本 seam 放大的一类新形态**：purge
内容删除成功但收尾集合移除写失败（item 码 `archive-set`）时，settle 刷新会
把内容已删的行从 summaries 移除 → 管理器行（∩ 集合）消失 → 残留集合成员
不可达（子集 purge 需有行可选、整集 purge 已退役）；修复前的陈旧 summaries
反而让这些行可重选收敛。与历史成员同类的修复方向（收尾孤儿全集合清扫）一并
覆盖。② 「归档当前活动会话 → 整源落入 unary 降级视图、已归档行（含运行中/
正查看）浮出直至重载」为另一家族（dev-QA 登记于 commit 1b19712，机制 =
官方壳 ctx 代数重建后 chamber 快照生产者首报缺位），本轮的会话列表刷新
seam 不覆盖它（降级视图的问题是归档集知识丢失而非行滞留）；现有缓解（生产
者挂载即首报 + 断连保留推送聚合 + rebaseline 重连自愈）之外是否仍有复现
路径待实机确认后单独修。③ 会话列表刷新瞬时失败的重试由状态机在后续推送
上收敛；「刷新持续失败 + 推送持续流动」的最坏情形下请求以 5s 冷却封底
（≤12 RPC/分/来源）且行可见直至通道恢复——如实接受，不引入退避状态。
④ 对话框与 App 触发重叠（上文注）：多出的一次 session.list 为接受代价。
