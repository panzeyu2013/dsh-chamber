# 24 · 已归档会话内容清理（server 行 hover 动作 · 第三个 chamber 宿主域）

> 状态：**已实现（delete-archived 分支落地，2026-12）**；定稿 v3 后的两道
> 实现门均已通过：① 宿主包例外评审——2026-12 用户拍板**跳过人工评审直接
> 执行**（§2 动议，AGENTS.md 例外清单与 design 01 地图随 M0 即改，台账
> D1–D7 按推荐值生效）；② vendor 源码前置核对——§10 已按 pinned vendor
> （dsh-v0.1.2-rc.1 a66e4702）执行完毕、host binding 分支 b 落地。2026-12
> 合入修订轮闭合评审残留（§14 残余定案 M1 / M2–M5 处置 / N1–N5，见 §15），
> 代码、测试与提交态 dist 同步；M4 实机 E2E 待验（见 STATUS）。
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

新宿主包（结构镜像 `packages/dsh-chamber-host-git-worktree`，含提交态
esbuild 产物 `dist/index.js`）。**命名**（评审修正）：scoped name 遵循两既有
宿主包先例（`@dsh-chamber/dsh-host-client-graph`、`@dsh-chamber/dsh-host-git-worktree`
——git-worktree 的 `dsh-chamber-host-*` 前缀只出现在目录名，是历史不一致）：
包名 `@dsh-chamber/dsh-host-archive-cleanup`，目录
`packages/dsh-host-archive-cleanup/`（目录与 scoped name 对齐，避免第三种命名制）。

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
                                       archived: number         // 已归档顶层总数
                                       deletableSessions: number     // 可删顶层
                                       deletableSubagents: number    // 可删级联子代理
                                       skippedRunning: number        // 运行中被整棵跳过的子树数
                                     } }
archiveCleanup/purge({})          → domain { ok, value: {
                                       deletedSessions: number
                                       deletedSubagents: number
                                       skippedRunning: number
                                       errors: { sessionId, code, message }[]
                                     } }
```

- 两个方法均**无入参**：零参 Remote 先例已核实——宿主侧
  `gitWorktree/snapshot`（零参 @Remote）、客户端侧同形 envelope
  `payload: { args: {} }`（`clientGraph/graph` 调用，renderer/host-graph.ts；
  git-api.ts 带参方法才用 `{args:{input}}`）。§5 客户端照此发 `{args:{}}`。
- `preview` 是**执行时快照**：只用于确认文案与空态提示；`purge` 开头重新
  读取权威状态，**不信任** preview 结果，两者之间状态可变化（§6 文案避免
  「恰好 N 个」暗示）。
- 返回值走 `domainResult` `{ok,value}|{ok:false,error}` 载体（generic
  gateway 不保留 thrown business 字段，同 git-worktree 理由）。
  `ok:false` 的 code 枚举（最小集）：`busy`（本域另一 purge/preview
  在途——**宿主侧单飞**，跨 N-ctx 的并发 purge 靠它收敛）、`registry-unreadable`
  （整体前提失败；2026-12 合入修订轮起 probe 的 `assertHostSurface` 结构
  检查亦覆盖会话枚举/存储面（Minor-3））、`purge-capacity`（archived
  集合超过单次上限 65,536——**不可重试**（`retryable: false`），无逃生口
  直至上游 wire 收敛，2026-12 合入修订轮登记，Minor-5）。逐项失败收进
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
7. **逐会话隔离与复检**：单会话失败记入 `errors` 继续；每会话删除前复检
   （仍在 archived 集合 / 非 running / 非 blank / 非 current）；幂等（已删/
   已不在集合 = 跳过）；崩溃窗口收敛 = 遗留会话仍属 archived，下次 purge
   续跑清掉。**运行窗口**（2026-12 合入修订轮登记，Minor-4）：整棵跳过
   保证截至每成员的删除瞬间——成员在树内删除间隙转 running 时，由逐成员
   O(1) 预检 / binding 删除时 live 守卫拒删该成员并保持根 archived，其前序
   已删成员不回滚（删除瞬间本就可删），下次 purge 收敛。

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
- wrapper：`previewArchiveCleanup(client)`（默认 30s）/ `purgeArchivedSessions(client)`
  （长预算，常量如 `PURGE_CALL_TIMEOUT_MS = 5 * 60_000`，常量放 instance-api.ts）；
- **超时文案**（诚实，zh 硬编码先例）：「清理超时——可能仍在进行，请稍后
  重新预览/重试（重复执行是安全的）」；预览超时给「预览超时，请重试」；
- 503 `instance_unavailable` 沿用 `wrapWireError` 既有文案与 `isInstanceUnavailable`
  语义；
- 行内错误文案定稿（评审决策点）：**沿用 zh 硬编码先例**（现有一切
  wrapWireError/rowError 文本均为 zh 硬编码；`domainMissing` 若走 locale 键
  将是首个本地化 rowError，需在组件作用域 catch→t() 翻译，v1 不做）——
  按钮 aria/title 与确认对话框文案走 locale 键（§6），行内错误/信息行走
  zh 硬编码 + 与既有错误同构；如需本地化列为后续增强。
- **桥契约（05 §3 `ChamberServerAggregate`）零改动**：计数由宿主 preview
  实时提供，不把 archived 行重新投进聚合（归档行仍被投影丢弃——本动作
  不要求「看到」归档会话）。

## 6. 侧边栏 UI（server 行 hover 动作）

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
     （preview 是快照），以区间/约量措辞 + 不可恢复明示；
     `deletableSessions === 0` 时**不进确认**，改在信息槽位（步骤 6）呈现
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

**A. 新包本体**：`packages/dsh-host-archive-cleanup/`（src/index.ts +
src/core.ts + scripts/build.mjs + test/core.test.ts + **提交态 dist**）。
根 `.gitignore` 需为 `packages/dsh-host-archive-cleanup/dist/` 新增否定
（既有按包否定块：注释 L13–15、否定行 L16–19）——否则提交态 dist 无法
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
- **期望集派生改造**（替代二元 `hostDomains` 布尔，M2）：现实现为全有/全无
  （runtime-probes.ts expected 二选一；gateway runtime-manager 以
  `hasSyncedHostSeed()` 一个布尔驱动，L936/1026/2374）——第三域引入
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
  文档随 M2：design 18 §3.4 派生契约修订段 + §9.3、STATUS.md 头部探针段
  （L36–37 与挂账①口径）；
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
E-m2 理由入文）；② 占位/幽灵窗口措辞：vendor `sessionIds` 为内存
header 索引派生，内容删除后至重启/下次实体写前，官方 workspaceView 仍含
占位 id（chamber 可见行不受影响；A-区/上游 wire 前置登记——§14 残余
定案后该窗口仅指 UI 幽灵行，与 archived 集合无关）；③ §3 错误码枚举
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
运行窗口登记，上）；M5（purge-capacity 不可重试 + 无逃生口登记入 §3）；
N1（完成树覆盖的已归档后代同批清除 + core 单测）；N2
（`resolveDeletableTree` 改显式栈迭代后序，消除递归深度=链深风险）；
N3（binding 删除产物 rm 的 ENOENT 竞态 → 幂等 `missing`）；N4（无 cwd
成员的逐删全库重列确认为稀有路径，代码注释登记）；N5（AGENTS.md 事件
表述改为「文档化 no-op」）；pending-click.ts 守卫清单注释补齐
archive-cleanup；host 包提交态 dist 随代码重建（esbuild 0.25 确定性比对
通过）。

**编号说明**：§13 空号（历史修订留空），后续章节接 §14/§15。
