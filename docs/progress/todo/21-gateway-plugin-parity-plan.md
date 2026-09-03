# 21 · gateway-plugin-parity 执行计划（companion to docs/design/21-gateway-plugin-parity.md）

> 按用户要求登记于 todo；随实现推进逐阶段勾销，并同步 `docs/progress/STATUS.md`。
> 依赖设计文档：`docs/design/21-gateway-plugin-parity.md`（v2，评审修订版）——本计划只列“做什么/碰哪些文件/
> 怎么验收”，契约细节一律以 design 21 为准（§号引用即 design 21 节号）。
> 状态标记：【代码】【测试】【门禁】；全部代码阶段前先过 §0。

## 0. 环境与基线门禁（任何代码改动前）

- 在**可运行工作区**（本 worktree 无 node_modules/vendor 未物化，命令无法执行）：
  `pnpm install`（含 vendor 物化与一致性校验）→ 建立**绿基线**并记录输出：
  `test:connections / test:sidebar / test:settings-bridge / test:gateway / test:desktop`（相关子集）、
  `typecheck:connections / :sidebar / :settings-bridge / :gateway`、`pnpm run build:renderer`、
  `pnpm --filter @dsh-chamber/desktop run build:preload`。
- 图标核对：对照 `@deepseek-ai/dsh-client-ui-primitives` 导出确认
  IconCordisPluginOutline14 / IconListPenOutline16 / IconCodeOutline16 / IconDataOutline16 /
  IconChecklistOutline14 存在性；定 B 用图标（缺失取仓内已导入同族，design 21 §4），结果回记 design 21。
- 探针实测（结果回调 design 21 §6.3/§7）：真实 gateway 上 `dsh plugin add` 的 pnpm 行为——
  是否读 profile/.npmrc、是否向安装子进程暴露 npm_config_*/NPM_* 令牌、lifecycle scripts 是否执行；
  据实收紧或确认 §6.3 env 纪律与 §6.1 “scripts 默认允许”登记口径。

## 1. Phase 1 — B 日志命名与图标【代码】【测试】【门禁】（无后端；对应 design 21 §4）✅ 已实现并通过静态门禁（2026-12，零 P0/P1；实现记录见 design 21 §4 与 §10 勘误）

- 文件：`packages/dsh-chamber-client-ui-settings-connections/src/client/ConnectionsSection.tsx`
  （L1355-1364 日志按钮与 Modal 标题走 logs 键值 → 「连接日志」；L1341-1353 网关主机日志 → gatewayHostLogs
  键；两个 Modal 加说明行 logsModalHint/gatewayHostLogsModalHint；插件入口图标 L1109/L1312 更换；确认
  L1265 service 行图标与日志入口视觉区分；aria/tooltip 随键）；
  `…/src/locales.ts`（zh 源 + en 镜像，键名不变只改值 + 新键）；
  `README.i18n.yaml`——**无条件重录**（design 21 §10 勘误：connections 记录哈希已过期
  记录 a400c4ee…/ab811e1d… ≠ 现 424d2982…/51efa467…；sidebar 的同样过期（a9958bbf…/c1559609… ≠
  62c2dbb1…/0ee6b088…），一并重录；README Content 双语若变更同步改文案再哈希）。
- 门禁：`typecheck:connections`；`test:connections` 回归；`verify:i18n`（README 变更时）；
  手动四卡（本地/ssh+dsh/gateway+ssh/gateway+http）hover 与两个日志 Modal 标题/说明行核对。
- 退出条件：B 键表全部落地；图标定案（含 fallback 记录）——**已落地（2026-12）**：插件入口
  IconFolderOpenOutline16、连接日志入口 IconSearchOutline16、网关主机日志 IconDataOutline16、service 行
  Checklist14（Monitor16/Cordis 等候选不在 primitives，design 21 §4 已回记；可运行环境核对后可再换）。

## 2. Phase 2 — C 重启 dsh + 共享迁移【代码】【测试】【门禁】（对应 design 21 §5.1–5.3）✅ 已实现并通过静态门禁（2026-12，零 P0/P1；2.1 共享迁移含 sidebar shared 模块 + settings-bridge 收敛 + 双 ambient 镜像 + 测试随迁/镜像锁步；2.2 卡片/面板「重启 dsh」含每卡单飞 per-id 与启用态 tooltip；P2 修复已合入）

### 2.1 共享迁移（先行、零行为变化；design 21 §5.2）
- `packages/dsh-chamber-client-ui-sidebar/src/shared/` 新增 `gateway-runtime.ts`（自
  settings-bridge gateway-runtime-api.ts **split**：parse/action/gates/error 分类与类型迁入，
  `remoteRuntimeStatusView` 及 SettingsBridgeKey 耦合**留在 settings-bridge** 改从 shared 导入）与
  `gateway-runtime-poll.ts`；`shared/index.ts` 导出。
- settings-bridge：`src/client/gateway-runtime-api.ts` 收窄为 view 映射 + 装配；import 改 shared。
- **ambient 镜像同步**：settings-bridge `src/ambient/chamber-bridge.d.ts`、connections
  `src/ambient/sidebar-shared.d.ts`（+ renderer `src/vendor-modules.d.ts` 若引用）镜像新导出符号集
  （RemoteRuntimeStatus 等，MIRROR WARNING 头）——git/layout 不消费迁移符号 → 其 ambient 不动。
- 测试：`settings-bridge/test/gateway-runtime-api.test.ts` 按 split 拆（view 用例留 settings-bridge、核心用例
  随迁至 sidebar 测试文件）；`settings-bridge/test/runtime-management.test.ts` 中 pollGatewayReady 用例
  （L124-217）仅把 import 改为 shared 路径（用例留在原地）；settings-bridge `src/client/gateway-runtime-poll.ts`
  随迁删除（import 改 shared 路径）；sidebar 测试文件承载迁移的 parse/gates/error 用例 + “镜像导出集锁步”
  测试；两包 package.json test 清单同步。
- 门禁：typecheck:sidebar/:settings-bridge/:connections；test:sidebar/test:settings-bridge；
  settings dsh-runtime 段手动回归（local + gateway 分支）。

### 2.2 卡片/面板「重启 dsh」（design 21 §5.1；桌面零改动）
- connections：gateway 卡（ssh/http）连接按钮旁文本按钮（键表 §5.3）——门控 phase ∈ {ready,degraded}、
  busy[id]、tooltip restartNotConnected；确认 Modal（含多用户中断文案）；`POST /api/i/gateway-<id>/
  chamber/runtime/restart`（仅 202；409/400 body.error 逐字）→ shared `pollGatewayReady`（1s/120s 语义）→
  ok/失败（operationError）/超时诚实投影；结果刷新卡片状态。
- PluginInventoryView（现状 gateway 入口）加「重启生效」按钮（同一动作函数；Phase 5 统一视图迁移时保留）。
- gateway+ssh systemd「重启实例」label/tooltip 区分（restartServiceTip「重启 gateway 服务」）。
- 门禁：ssh+dsh 卡行为零回归（既有按钮不动 + test:connections）；真实 gateway ready/degraded/stopped 三态
  点击矩阵（stopped = 禁用态 + restartNotConnected tooltip；仅 stale-ready 投影竞争窗口的点击才落 409
  逐字）；settings 段与卡片双入口同一轮询语义核对。

## 3. Phase 3 — A0 读面 + 手动 chamber 同步【代码】【测试】【门禁】（design 21 §6.2/6.5；无写栅栏）✅ 已实现并通过汇总静态门禁（2026-12，零 P0/P1；3a installed 读路由 + 锁步测试；3b gateway_plugin_sync IPC（registry/ready 复核/五处镜像，联合类型 GatewayPluginSyncIpcResult）；3c 视图 chamber 同步/漂移（gatewaySource 门控））

> 注（对 design §6.9 ③ 的有意调整）：tasks 读路由依赖 journal，自 A0 移入 Phase 4.4。

- gateway：新增 profile 读模块（readManifest 的 gateway 实现：解析 `<stateDir>/dsh-home/profiles/web/
  package.json` → deps（file: 值以 MATERIALIZED_VALUE_MASK 掩码）+ bundles + profileExists +
  absent/corrupt 码）；routes.ts 在 /chamber/plugins 块内、404 fallthrough（L920-922）前 claim
  `GET /chamber/plugins/installed`（method 纪律）。
- desktop：`gateway_plugin_sync(id)`（syncGatewayChamberPluginsFor 自 main.ts:2152 抽为可重入，参数取当前
  transport 注册态）；**镜像五处**：preload.cts + ipc-events.ts + main.ts handler + renderer global.d.ts +
  ipc-surface-mirror.test.ts golden（connections global.d.ts re-export 型，仅新命名类型时动）。
- connections：gateway 视图 chamber 区「立即同步」按钮 + chamber 版本漂移显示（local manifest chamber
  版本 vs installed/缓存投影）。
- 测试：test:gateway 读路由子矩阵（absent/corrupt/掩码/profileExists/bundles）；desktop sync IPC
  （上传/跳过无本地包/取消 no-op/SPKI/--no-auth/隧道 Host 四态沿用族）；mirror/golden。
- 门禁：真实 gateway fresh（无 profile）与有 profile 两态投影核对；自动同步失败 → 手动「立即同步」兜底闭环。

## 4. Phase 4 — A1 服务端写面单元（单一测试单元；start 原语并入）【代码】【测试】【门禁】（design 21 §6.2-6.4）✅ 已实现并通过执行级门禁（2026-12，零 P0/P1：汇总门禁 FAIL 1 P1 → I4 修复 → P1 关闭复核 CLOSED；gateway 487/484/0fail/3 平台跳过 + desktop 全链 724/724 + root typecheck 0）

按 design 21 §6.9 序，以**纯 node 单测单元**先行（journal 状态机/门矩阵/队列/executor 注入式 spawn）：

> 注（对 design §6.9 ② 的有意调整）：start 原语（§6.9 与 C 并列）推迟至 4.5——依赖 A1 写栅栏/journal 先就绪；
> UI 层入口随 Phase 5 恢复 UX 呈现。

### 4.1 runtime 单写者栅栏与生命周期接线
- 注：`runExclusiveProfileWrite` 为 A1 **新建符号**（现仓库无此 API）；`beforeSpawnCheckpoint` 现为
  test-only 调度缝（local-connection.ts:87-90，生产不提供；当前 spawn 期 DSH_HOME 写面栅栏由
  canSpawn/assertSpawnAllowed 复核承担）——本步完成“新建锁 + 接线”。
- runtime-manager：`runExclusiveProfileWrite()`（profileWriteInFlight + assertMutationIdle 成员化 +
  activeOperations 注册（L1993-1999）→ dispose 排空（L2005-2006））；local-connection
  `beforeSpawnCheckpoint`（L90/599/720）接线：锁持有期间健康自动重启/spawn 拒绝或排队；
- 停路径：dispose/quiesce 后释放锁；install 子进程 kill 挂点；路由/manager 单飞门更新；
- 注释同步：routes.ts:801-810、dispatch.ts:649-653、gateway index.ts:395-409/451-455。

### 4.2 journal + 备份模块
- 新模块（gateway/src 插件区）：写入序 pending（ts/kind/name/spec/preImage/操作者标签）→ 原子备份
  package.json+lockfile（**成对校验**）→ 执行 → 终态；启动对账残留 pending → failed（附 preImage）；
  保留策略默认（最近 50 笔/7 天；队列深 ≤8；op 超时 10 分钟；blocked 上限 5 分钟）；磁盘预检（镜像
  runtime disk soft-limit）；非秘密（0700/0600/no-follow 复用 private-file 原语）。

### 4.3 串行队列执行器
- spawn active runtime dsh CLI（resolveWorkspace）固定 argv `add/remove`，env `DSH_HOME=<stateDir>/dsh-home`
  + **升级版纪律**：白名单 env（PATH+代理族）、剥 `DSH_GATEWAY_*` 与全部 `npm_config_*/NPM_*`、HOME/XDG 钉
  stateDir 内、空 NPM_CONFIG_USERCONFIG、profile .npmrc 不可信、stderr 脱敏（复用 sanitizeInstallerOutput 族）、
  stdout 有界、超时/取消进程组 kill；**scripts 默认允许**（design 21 决策 13，不限制）；
- 保留名拒绝集 + spec/name 白名单族：迁 **control-plane 共享纯模块**（desktop 经 control-plane-module.ts
  双路径 facade 与打包产物同源；plugin-sync/ssh-provider import 改址；渲染端 ADD_SPEC 镜像保留并**新增
  锁步测试**——现无任何锁步）；remove 的 installed 名单**执行时**复核；
- 执行器 add/remove 前后各双检一次 connectionState（非 {starting, restarting}），后检失败如实报错留重试。

### 4.4 任务面与安装路由
- `GET /chamber/plugins/tasks`（journal 持久；tasks 并入 installed 的决定在本步起点定死）；
  `PUT /chamber/plugins/install`（202 异步/队列忙 409/400/保留名/reserved_name）；
  `PUT /chamber/plugins/materialize`（**独立流式上传读体** ≤32MiB、413+destroy、解包上限 ≤4096 文件/
  ≤256MiB、保留名拒绝）；`POST /chamber/plugins/remove`（停机态可用）；
  错误码总表落地（design 21 §6.2）；deferred：ready 边沿（observeLocalState，index.ts:318）空闲排空 +
  quarantine 过滤 → 装完自动受控 restart 一次（defer=false 时队列尾自动 restart）；读面与写栅栏一致。

### 4.5 start 原语（design 21 决策 12）
- runtime-routes：`POST /chamber/runtime/start`——仅 connectionState ∈ {stopped, error, restart-exhausted}；
  恢复门不可绕过（recovery phase 只允许既有 retry/restore-builtin）；canStartLocal/exposureQuarantine/单飞/
  写栅栏；202 + status 轮询 start: running/ok/failed + operationError（resolve≠success 语义）；
  manager：受守卫 startLocal 路径；r1 恢复闭环与 F7 auto-rollback 衔接（不重复触发）。

### 4.6 desktop 写 IPC + 确认链
- `gateway_plugin_apply(id, {add[], remove[], defer})`、`gateway_plugin_materialize(id)`（pick-only，取消
  `{ok:true, cancelled:true}`）；主进程 showMessageBox 确认 + 经注册 origin（auth/SPKI/隧道 Host 同
  syncGatewayChamberPlugins）；镜像面同 Phase 3（含 batch+cancelled 联合形状精确守卫）。

- 测试：journal 状态机/启动对账幂等（fake fs）；门矩阵（执行窗口 × 动作 × 在飞标志）；队列模型（先 remove
  后 add/失败即停/blocked 超时）；executor injectable spawn（exit-code 夹具 + env 纪律断言 + 保留名）；
  白名单/保留名迁 control-plane 后 gateway+desktop 双端跑 + 渲染锁步；读/写 fence 一致；dispose/quiesce/
  stop 排空与子进程 kill；start 门矩阵（停机三态放行/恢复门不可绕过/202/poll/失败诚实）；上传流式上限与
  解包；corrupt → preImage 回滚（原子对）；`test:gateway / test:desktop / test:control-plane（回归）`。
- 门禁：真实 gateway 全链手动 + 脚本化：装/卸/文件夹/批量 partial/409/停机移除/start 恢复/deferred→ready/
  故障注入（坏插件 boot 失败 → restart-exhausted → 停机移除 → start 恢复；corrupt → preImage 回滚；
  gateway 重启后 journal 对账）。

## 5. Phase 5 — UI 全闭环 + ssh 统一增量（单一模型视图）【代码】【测试】【门禁】（design 21 §3/§6.6）✅ 已实现并通过执行级门禁（2026-12，零 P0/P1：汇总门禁 PASS + 3 条 P3 卫生项已归入 Phase 6；E2E 矩阵未勾销——不可在本树执行，发布前按 design §9 执行）

- **纯模型层先行**（connections client 纯模块）：intent 构建（remove 先 add/defer/勾选保留规则）、结果分类
  （partial「已完成 n/m」/blocked/cancelled/失败行）、task 投影 → 行模型、后端分派表（含不支持组合与
  http 直连无后端）、**批量内 registry/remove 失败即停 vs 逐行 materialize 隔离的单一取舍定义**
  （design 21 §6.6）——单测先行，无依赖可先写。
- 统一视图重构（design 21 §6.6 次序）：PluginSyncModal 拆共享子组件（chamber 区/差异表/结果区/已安装列表行）
  → tabs sync/add/**list（已安装列表，逐行移除 + 撤销最近变更）**；本地模式 list+add 不变；http 直连保留
  PluginInventoryView 只读；**ssh 行为等价回归门**（步骤③前显式手动/E2E 门禁，含既有纯测试）。
- gateway 卡片改开统一视图 + 后端分派接入；**ssh 统一增量**（design 21 §6.4）：已安装列表 remove、
  保留名拒绝（主进程 applyPlugins 侧，与 gateway 同集）、undo journal（主进程侧持久化 + 远端 package.json
  变更前备份）、**readManifest 投影统一掩码**（决策 18：现 plugin_list 原样透传 raw，main.ts:2860-2870/
  2903-2905；掩码常量/helper 已存在但无生产挂接——本步在模型层挂接并补测试）、恢复引导文案同权。
- A 键表与文案家谱落地：partial/blocked/queue_busy/deferred 离线执行确认（“可能在你断开后自动执行”）/
  多用户中断（C 复用）/start 恢复自然语言成功文案（「已移除 X，实例已重新就绪」）/profile_corrupt 横幅/
  who-when tooltip（连接 label 级）。
- 恢复 UX：卡片 error/restart-exhausted 提示行 + 「移除最近安装」直达 + 「启动实例」（start）动作；
  r0–r4 双后端同文案（design 21 §6.8）。
- 门禁：ssh 与 gateway 同一视图双通道手动矩阵（diff/list/add/remove/undo/restart/start/partial/deferred/
  corrupt/停机 chamber 区降级）；test:connections 模型层单测绿。

## 6. Phase 6 — 文档归位 + 全量验证 + 发布清单【文档】【门禁】（design 21 §8/§9）✅ 已完成（2026-12，总验收 ACCEPT 零 P0/P1；本树可运行子集全链绿 + build:gateway exit 0；build:renderer/实机 E2E 矩阵因 vendor 子模块未初始化与无真实 gateway/desktop 不可在本树执行——发布前按 design §9 矩阵执行，如实登记未虚报）

- design 17（§3 能力表增补 + dsh(http 直连) seed 行勘误 + **ssh 挂载“版本只读”行勘误为不挂载**（审计 F4）；
  §10 扩展 + “无异步尾/无 fence”表述修订；
  §4.1/§12 生命周期 writer barrier 语言）、design 18（§6 出网登记“安装子进程随宿主受控出网”；§9.3 start
  行/互斥矩阵/beforeSpawnCheckpoint/兜底链更正）、design 05 §5（含 dsh（ssh/http）直连不挂载 dsh-runtime
  段改写）、design 13 收敛表述（单一模型/末段分叉/白名单归属）、
  代码注释收尾、sidebar/settings-bridge README、connections README 双语对 → README.i18n.yaml 重哈希。
- 全量验证：typecheck 全相关包 + 各 test 清单 + build:renderer + build:gateway + preload build +
  `pnpm run verify:i18n`。
- 实机门禁（发布前逐项）：真实 gateway（systemd 与 foreground 各一次）+ 打包 desktop 全闭环、TLS+SPKI、
  多桌面（last-writer-wins/队列 409/移除影响文案/归因）、registry 实装（传递依赖网络 + lifecycle scripts
  实测）、文件夹上传上限、partial、deferred、start 恢复、故障注入、journal 中断对账、scripts/env 实测
  结果回调。
- 收尾：STATUS.md 实现进度登记；本计划条目在 todo 表勾销（按 todo 纪律：实现进入 STATUS 跟踪后移除）。

## 横切：阶段内决策点（deadline 前置）

| 决策点 | 定于 | 默认 |
|---|---|---|
| B 图标定案（含 fallback） | Phase 1 内（已定） | 已落地：FolderOpen16（插件）/Search16（连接日志）/Data16（主机日志）；Monitor16 等候选不在 primitives（sidebar 本地自绘佐证）；可运行核对后可换 |
| tasks 并入 installed 与否 | Phase 4.4 起点 | 默认独立端点 |
| 错误码细节（profile_corrupt 语义 409/500、remove 400 文案） | Phase 4.4 | 按 §6.2 表 |
| start × recovery-gate 交互矩阵细化 | Phase 4.5 | 恢复门不可绕过 |
| scripts/env 实测结果回调 §6.3 纪律 | Phase 0 探针 + Phase 4.1 前 | 只收严不收宽；scripts 默认允许口径不改（决策 13） |
| 恢复路由（snapshot restore）进 v1 与否 | Phase 4.2 后 | 默认二期，r2 走 runbook（design §6.8 兜底链） |
| 组件级测试基建（是否引入 .tsx 测试） | Phase 5.1 前 | 维持纯模块 + 手动/E2E 门禁 |
| journal 操作者归因 UI 粒度 | Phase 5 键表 | tooltip 级 |

## 备注与风险

- 本 worktree 无依赖不可执行任何命令：实施须在可运行工作区，先过 §0 绿基线；
- **落地记录（2026-12，静态门禁零 P0/P1）**：Phase 1-3 已实现（见各阶段 ✅）；B 图标定案 FolderOpen16/
  Search16/Data16（Monitor16 等不在 primitives）；C 卡片/面板按钮 + 每卡单飞 + 共享 pollGatewayReady；
  A0 = installed 读路由（404 profile_absent / 500 profile_corrupt 落地裁定）+ gateway_plugin_sync IPC +
  视图 chamber 区同步/漂移；design 21 §5.3/§6.2/§6.5/状态头与 STATUS/todo 已同步。
- **Phase 4 进度（2026-12，执行级）**：4A 白名单族迁 control-plane 共享模块（plugin-spec.ts + facade +
  ADD_SPEC/布局锁步）；4C/4D journal + 串行执行器（含 XDG_CONFIG_HOME pin 与前后双检、onTerminal 钩子，
  7+16+4 测试）；4.1/4.5 写栅栏 beginProfileWrite/assertMutationIdle 双向互斥 + start 原语 + 
  beforeSpawnCheckpoint 生产接线（spawn-checkpoint.ts；runtime-routes +11）；4.2-4.5 集成：plugins-tasks
  编排器（validate→lease→enqueue/deferred.json 持久化→单飞 drain；lease 释放随 enqueue 内注册的 per-op
  terminal 钩子，防同步失败泄漏）+ 四条写路由（install/remove/materialize(流式 32MiB+tgz 上限)/tasks）+
  index 装配（boot reconcile、ready/degraded 边排空、stop 双路径 dispose）。gateway 全套 481 测试 478 通过
  0 失败（3 平台跳过）、typecheck:gateway 0 错误。**待办**：4G desktop gateway_plugin_apply/materialize
  IPC（含 batch+cancelled 联合与五处镜像+golden）、Phase 4 汇总门禁、Phase 5/6。
- **遗留登记（Phase 3 汇总门禁）**：P2 —— 手动同步 both-false 竞态（gateway 在 ready 复核后死亡/拒认被投影为
  「已是最新」）：有界、无错误动作，随 A1 tasks/投影改造修复（syncGatewayChamberPlugins 需区分
  非 200/throw 为显式失败并映射失败文案）；P3 —— design 21 §6.5 阅读裁定：`gateway_plugin_sync` **不设**
  showMessageBox（复制 ready 边沿无人值守语义，A1 review 沿用同一口径）；routes.ts:968-971 与 gateway
  index.ts:205-208 既有陈旧注释随 Phase 6 注释清扫；desktop 自动/手动同步间无单飞（良性重复 PUT，A1 队列
  取代）；connections global.d.ts re-export 排序瑕疵（待修）。
- design 21 v2 的代码锚点以 2026-12 全量核查期核对为准，行号随编辑微移（以实际文件为准）；
- pollGatewayReady 英文错误串随迁 shared 后为未本地化文案（登记接受，Phase 2.2 起 connections 可见）；
- **质量审核修复轮（2026-12，审核后执行；全量验证绿，修复明细与测试见 design 21
  §10「质量审核修复补录」）**：P1-A1 租约泄漏（journal 终态写失败/丢失仍触发租约释放钩子）、
  P1-A2 executor env 白名单化、P1-A3 deferred 排空后自动受控 restart 一次（第二轮扫描修正：请求点 = 本轮全部排空 op 终态且至少一个 ok，而非首个 ok 终态）、P1-B1 ssh
  undo journal 操作目标指纹绑定 + clear 接线（删除与操作指纹变更两转换路径）；
  P2-A1 脱敏升级、P2-A3 tasks/deferred 投影掩码、P2-A7 崩溃孤儿启动对账击杀、
  P2-B1 手动同步失败显式化（Phase 3 遗留登记 P2 勾销）、P2-B2 apply 确认后重检、
  P2-A2 drain 波浪续排、P2-A4 staged tgz GC、P2-A5 persistence_failed 500 码；
  Phase 6 文档归位本次补全（design 17/18/05/13 §8 更新清单 + sidebar/settings-bridge
  README 双语 + README.i18n.yaml 哈希重录——先前仅 STATUS/todo 落地的缺口关闭）。
- 最大风险步骤 = Phase 4 的 runtime-manager fence + executor 集成（design 21 §6.9 的④单元化落地 + 纯单测
  先行可去风险）；次高风险 = Phase 5 ssh 等价重构（纯模型层先行 + 步骤③前显式 E2E 门禁）。
