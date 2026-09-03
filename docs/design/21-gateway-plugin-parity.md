# 21 · 统一插件管理模型与 gateway 连接对齐（A/B/C 定稿 · 评审修订 v2 · 全量实现终稿 2026-12）

> 状态：本文档由 `docs/progress/todo/gateway-plugin-parity.md` 评审稿（2026-12，已移除）独立整合而成，
> 并经四视角评审（架构/安全/可执行/产品）修订至 v2。
> 范围 = **已实现的 chamber 插件管理基线**（本地/ssh 远端/chamber 宿主包同步/runtime 受控重启）
> + A/B/C。实现进度（2026-12，逐阶段静态/执行级 P0/P1 门禁通过，总验收 ACCEPT 零 P0/P1）：B（§4）
> 已实现；C（§5，含 gateway-runtime parse/poll 迁 sidebar/shared 与两处 ambient 镜像）已实现；A0 读面
> （GET /chamber/plugins/installed 路由 + desktop gateway_plugin_sync IPC + 视图 chamber 区同步/漂移）已实现；
> A1 写面（install/remove/materialize/start/tasks/journal/fence/队列 + desktop apply/materialize IPC +
> ssh undo/journal/掩码/保留名拒绝）已实现（§6.2-6.5）；Phase 5 UI（纯模型层 + ssh 模态 list/undo +
> gateway 视图已安装/变更记录/撤销/start 卡片）已实现（§6.6 落地现状与余留见 §10 勘误⑥⑦）。
>
> 状态标记：【已实现】= 现存代码基线（含本文件新增契约的落地）；【待实现】= 仍待排期项（见 §10 勘误
> ⑥⑦ 登记余留）；【重构等保】= 既有面改造须行为等价；【统一增量】= 随模型统一落入 ssh 与 gateway 两后端
> 的对等功能增量；【二期】= 选项。
>
> 相关设计：13（ssh 远端插件管理）、17（gateway 形态与 /chamber 面）、18（runtime 管理）、05（连接设备页）、
> 02（seed 与 spawn 语义）。本文档与 13/17/18/05 的关系见 §8（02 的 seed/spawn 语义关系见 §2.4）。

## 1. 目标与决策记录

三个用户诉求（2026-12，来自 connections 连接设备页）：
- **A**：gateway 连接缺 ssh+dsh 那样的第三方插件「添加/同步/移除」闭环——“使用 gateway 功能反而退化”；
- **B**：gateway 卡上「日志 / 主机日志」两个入口无法区分；
- **C**：connections 页缺 gateway「重启 dsh」按钮（runtime 受控重启机制已就绪，连接页无入口）。

决策记录（2026-12 用户拍板 + 评审定稿；v2 增补项以 ★ 标记）：

| # | 决策 | 口径 |
|---|---|---|
| 1 | A 联网装包出网 | **允许**——联网添加包本就访问 registry；「零出网」仅指受控实例子进程的凭据面（18 §6:625-627 出网面只登记宿主进程访问；安装子进程随宿主受控出网按 18 §4 env 纪律（:519-524 保留代理、钉 --registry）成立、与 runtime 安装引擎同例——显式登记待 §8 执行时写入 18 §6） |
| 2 | A v1 安装 | **registry spec 直装 + 本地文件夹直推**（spec 白名单族；文件夹 ≤32 MiB 独立流式上传） |
| 3 | A registry 来源 | 不限定（默认官方源） |
| 4 | A 自动同步边界 | 仅 chamber 两包 ready 自动同步；第三方一律手动勾选应用 |
| 5 | A 执行/确认 | 批量勾选 → 一次主进程确认 → 队列逐行串行（先 remove 后 add），失败即停并如实投影 completed/failed |
| 6 | A 互斥 | runtime 单写者栅栏 `runExclusiveProfileWrite()`（与 restart/apply 共用串行化），健康自动重启经 `beforeSpawnCheckpoint` 检查同一把锁 ★ |
| 7 | A 执行窗口 | connectionState ∈ {ready, degraded, stopped, error, restart-exhausted}；仅拒绝 starting/restarting/applying 窗口与 runtime 事务/restart 在飞 |
| 8 | A deferred | profile 缺失 → 意图/字节缓存 → ready 边沿空闲窗口排空 → 装完自动受控重启一次 |
| 9 | A 一致性原则 ★ | **收敛为单一插件管理模型**（同一 UI/流程/契约/状态机），**仅在最终执行阶段分叉**：gateway 后端 = 宿主 spawn 执行；ssh 后端 = 桌面主进程 ssh exec。不是“双通道同权”，是一个模型、末段分叉（用户重申的长期要求） |
| 10 | A 显式移除 | 「已安装」列表 + 每行移除 = 模型统一功能，ssh/gateway 两后端同权落地（补 consistent 行不可移除缺口）★ |
| 11 | A 恢复能力 | 停机态可移除；pre-mutation package.json 备份 + 持久操作 journal（任务面 + 撤销最近变更）+ profile_corrupt 恢复——按后端持久化（gateway：宿主 stateDir；ssh：桌面主进程侧 + 远端变更前备份）★ |
| 12 | A r1 闭环 ★ | 新增 `POST /chamber/runtime/start` 原语（仅 stopped/error/restart-exhausted；202+poll；受守卫：canStartLocal/恢复门/单飞）——停机移除后回到可启动的 UI 入口 |
| 13 | A 安装期脚本 ★ | **默认允许**（与 ssh/桌面一致，不限制——避免用户困扰）；风险登记（安装代码=gateway 用户级）；二期提供 ignore-scripts/逐包放行配置与 OS 用户隔离（硬化） |
| 14 | A 服务端 admission ★ | **不加**——主进程确认是桌面通道纪律而非服务端门；服务端信任 = 全权 auth 直连（与既有 /chamber/runtime 动作面同级暴露，如实登记） |
| 15 | C 共享模块 | gateway-runtime 纯核心（parse + poll）迁 `@dsh-chamber/dsh-client-ui-sidebar/shared`（split 边界 + ambient 镜像同步清单，见 §5.2）★ |
| 16 | B 命名/图标 | 「连接日志」「网关主机日志」+ 图标去重；本地卡折叠区不改名 |
| 17 | A 生命周期 writer barrier ★ | gateway 后端 executor 挂入 runtime-manager tracked-writers（activeOperations/单飞门），dispose()/dispatch.quiesce() 排空、stop 杀安装子进程、锁释放前 writer 证明——17 §4.1/§12、18 §9.3 表述随 §8 更新 |
| 18 | 掩码语义 ★ | gateway readManifest 的远端 file: 值**一律掩码**（`MATERIALIZED_VALUE_MASK` 同常量：保留 file: 前缀供 name 基 diff、gateway 本地路径不进 renderer，§6.2）；ssh 现状为**原样透传**（SSH_PLUGIN_LIST main.ts:2860-2870 与 LOCAL_PLUGIN_LIST main.ts:2903-2905 均未掩码；掩码常量与 redactLocalPluginManifest（plugin-sync.ts:663/674-680）存在但**无生产调用点**——A 的掩码投影是新契约，实现时统一挂接模型层 readManifest |
| 19 | scope 过滤统一 ★ | 第三方行过滤与移除/安装拒绝集合在**模型层**单一定义（官方域 + chamber 域 + seed/overlay 名）：对话框行、两后端 remove、gateway install 拒绝集一致（ssh 后端补官方/chamber 域拒绝 = 与 gateway 同权） |
| 20 | 信任声明 ★ | “已安装代码 = gateway 用户级等价”（进程隔离≠主体隔离）；OS 用户分离列二期硬化 |

## 2. 已实现插件管理基线（纳入范围，引用为准）

### 2.1 本地 profile 插件管理【已实现】
`desktop_local_plugin_list / add / add_file / remove`；主进程 `runLocalDshPlugin`（desktop/plugin-sync.ts:1846；
main.ts:3044-3083）固定 argv 执行 `dsh plugin add <spec>` / `add file:<path>` / `remove <name>`；showMessageBox 确认，
取消 = `{ok:true, cancelled:true}`（design 13 §5/§7.0）。本地清单 = 读本地 `<home>/profiles/web/package.json`
依赖投影 + 分类 + chamber 注入态版本。

### 2.2 ssh 远端插件管理【已实现】
`desktop_ssh_plugin_list / plugin_apply / seed_host_graph / plugin_materialize_add(_pick)`、`restart_service`
（插件 exec 面（list/apply/seed/materialize）仅服务 `{kind:'dsh', transport:'ssh'}`，main.ts:2064/2364/2445 门控、
design 13 scope 13:7-9；systemd exec（含 restart_service）**只按 ssh transport 门控**、gateway-over-ssh 亦可用——
属连接管理面，见 §3 目标语境差异）。远端清单 = ssh cat 远端 profile
package.json → `parseRemoteManifest` 投影（**原始 spec 值**，plugin-sync.ts:477-496）；差异由 `computePluginDiff`
计算；apply = 主进程二次白名单 → 远端 `dsh plugin add/remove`（registry spec 或 materialize `add file:`），
remove 先于 add、可 defer 重启；write-file 上限 50 MiB；spec/name 白名单常量现驻 desktop/ssh-provider.ts:130-171
（渲染端 PluginAddView ADD_SPEC 为**无锁步测试的手写镜像**——v2 补锁步，见 §6.2）。

### 2.3 插件管理 UI【已实现】
卡片分流（ConnectionsSection.tsx:1307-1310）：ssh+dsh → PluginSyncModal（远程 sync/add）；本地 → PluginSyncModal
（spec=null，list/add）；gateway/http 直连 → PluginInventoryView（只读）。PluginSyncModal 921 行双模式组件、
PluginAddView、plugin-diff.ts 纯函数族（missing/update/extra/materialize/unsyncable/consistent——**无 scope 逻辑**）、
plugin-inventory-text/plugin-diagnostic 纯投影（thirdPartyEntries 过滤 @deepseek-ai/* + chamber 两包，仅用于
Loader 已加载事实层）。测试 = connections 8 个纯模块文件，**无组件级测试**。

### 2.4 chamber 宿主包同步与 seed【已实现】
桌面 ready 自动 `syncGatewayChamberPlugins`（gateway-provider.ts:1408+；main.ts:2152-2182 装配）；
gateway `PUT/GET /chamber/plugins` 白名单两包缓存（plugins.ts:38-41 白名单 + :43-45 大小上限；0700/0600/原子
no-follow；上传读体 8 MiB 上限在 routes.ts readUploadJsonBody:57-109/:62，非 plugins.ts）；
seed = extraneous + patch overlay（不进 package.json，control-plane/index.ts:393-398），每次 spawn（含健康自动重启，
local-connection.ts:599-613）前 seed thunk 重求值自愈（02 §2.6）；激活探针 shape gate（hasSyncedHostSeed）；
移动端 `dsh-chamber-client-ui-mobile` = 唯一随 gateway 发行物打包 seed 的 chamber 客户端插件（17 §3/§10）。
注：17 §3:119 的 dsh(http 直连)“远程 seed（同左）”行与代码不符（seed 门控 `kind==='dsh' && transport==='ssh'`，
main.ts:2064/2364/2445）——既有文档瑕疵，§8 列入勘误。

### 2.5 gateway 运行时受控重启【已实现】
`POST /chamber/runtime/restart`（dispatch 无条件挂载、非 ready-gated，dispatch.ts:644-648；**仅 ready/degraded
可重启**，runtime-routes.ts:264-285；202 + status 轮询 restart running/ok/failed + operationError，
resolve≠success，18 §9.3）；单飞 = manager 标志 + route 409 + restartLocal 与健康重启共用串行化
（local-connection.ts:947-964）；**激活事务**（startup/apply-now/restore-builtin/回退路径）快照/回退覆盖整棵
dsh-home（runtime-manager.ts:769/792，snapshotDshHome 全树拷贝；`/restart` 本身 = restartLocal 受控 spawn、
**无快照**）；settings dsh-runtime 段 gateway 分支已实现
（DshRuntimeSection.tsx:977-994：renderer fetch + `pollGatewayReady`）。
**缺口（v2 依据）**：受控面**无 start 原语**——“managed dsh is not running…restore the builtin or retry…”
(runtime-routes.ts:275-279)；restartLocal 拒绝 stopped/error/restart-exhausted（local-connection.ts:956-963）。
恢复闭环需要新增 start（决策 12）。

## 3. 一致性原则 v2：单一模型，末段执行分叉（用户重申的长期要求）

> 不是“两个通道各一套同权功能”，而是**收敛为一个插件管理模型**：UI、流程、差异语义、状态机、文案、
> 恢复能力全部只有一份；ssh 与 gateway 是同一个模型下**两个执行后端**，分叉只发生在**最终执行阶段**
> （怎么拿到远端 profile 事实、怎么把 add/remove/restart 落到目标上）。任何界面/逻辑层不得出现
> “if gateway … else if ssh …”的功能分叉——分叉只允许出现在后端实现内部。

**模型动词（后端无关，UI 与流程只依赖它们）**：

| 动词 | 语义与投影 | 分叉点（末段执行） |
|---|---|---|
| readManifest | 远端 profile 依赖投影（单一定义：name→spec（file: 掩码）+ bundles + profileExists + corrupt/absent 码） | ssh：cat+parse（既有）；gateway：读自身 profile |
| apply({add[], remove[], defer}) | 批量一次确认；先 remove 后 add；失败即停；completed/failed 投影 | ssh：远端 `dsh plugin add/remove`（既有 applyPlugins）；gateway：宿主 spawn 执行（§6.3） |
| materialize | 本地文件夹 pick → pack → 目标安装（file: 语义） | ssh：pack→write-file→add file:（既有）；gateway：pack→上传→宿主 add file: |
| chamberProvision | chamber 两包与目标一致 | ssh：ready 自动 + seed_host_graph 手动补种（既有）；gateway：ready 自动 PUT + 「立即同步」兜底 |
| restartToApply | 安装/移除后让运行实例装载 | ssh：`restart_service`（systemd）；gateway：`POST /chamber/runtime/restart`（202+poll）；本地实例在 dsh-runtime 段 |
| startFromStopped | 停机/错误/restart-exhausted 后回到可启动（恢复 r1 闭环） | gateway：新 `POST /chamber/runtime/start`；ssh：`restart_service`（systemd 可启停）；本地：dsh-runtime/连接面 |
| undoJournal | 撤销最近一次变更（preImage 恢复或等价） | ssh：桌面主进程侧 journal + 变更前远端 package.json 备份【统一增量】；gateway：宿主 journal + preImage（§6.3） |
| loadedFacts | 已加载 Loader 事实行（只读、诊断） | gateway/http：实例代理 pluginInventory（既有）；ssh：无该面（Loader 不可达时不渲染，模型允许后端缺省可选面） |

**后端矩阵**：local（本地 profile，list+add 语义，既有）、ssh（既有 + 【统一增量】已落地）、gateway（已实现）、
http+dsh 直连（无任何执行后端——无 /chamber、无 ssh exec、无管理面（17 §3），PluginInventoryView 只读保留，
无法也不应“一致”）。

**目标语境差异（不再是功能差异，登记为唯一可见差异）**：gateway+ssh 卡的 systemd 「重启实例」按钮属**连接
管理面**（重启 gateway 服务本身，非插件模型动词），保留并改 tooltip/文案区分（B/C 章节）；插件模型内无其他
按目标的分叉。

## 4. B · 日志入口可区分（定稿）

现状（ConnectionsSection.tsx:1341-1364）：gateway 卡「主机日志」（IconDataOutline16）与「日志」
（IconChecklistOutline14，L1363）并列；插件入口同形（L1109 本地、L1312 远端；服务行 L1265 亦同图标）；
Modal 标题只差前缀（L1774 vs L1816）。

方案：环形缓冲入口与 Modal 标题「日志」→「连接日志」（说明行：本机侧连接通道事件：隧道/探针/握手验证等
连接过程记录，用于排查连接问题——覆盖 http 直连）；gateway 卡「主机日志」→「网关主机日志」（服务器侧
gateway 进程与托管 dsh spawn 日志）；本地卡折叠区「主机日志」不改名；service 行 Checklist（状态行）保留但
与两个日志入口在视觉上明确区分（插件入口改图标后 Checklist 仅剩 service 行与日志入口——日志入口一并换图标）。
图标：插件入口（本地+远端）→ IconFolderOpenOutline16；连接日志入口 → IconSearchOutline16；网关主机日志保留
IconDataOutline16；service 行保留 IconChecklistOutline14（状态行）。**实现定案记录（2026-12）**：候选名
IconCordisPluginOutline14/IconListPenOutline16/IconCodeOutline16/IconMonitorOutline16 均不在 primitives
（IconMonitorOutline16 由 sidebar 本地自绘佐证缺失），按 fallback 规则取仓内既有 primitives 导出
（IconFolderOpenOutline16/IconSearchOutline16，先例 sidebar vendor-modules.d.ts L162/177）；可运行环境核对
出新候选时可再换（换点：import + 按钮 + ambient 一行）。键名保持稳定（logs/hostLogs 改值不改键），新增
gatewayHostLogs/logsModalHint/gatewayHostLogsModalHint；zh 源 + en 镜像，词典一致性由 typecheck
（`Record<keyof typeof zh>`）保证（verify:i18n 只管 docs 双语对）；README.i18n.yaml 双哈希已按 §10 勘误
重录（connections + sidebar），后续仅当 README 双语变更时再重哈希。B 先行以键名 + 文案 + 图标三重区分交付。

## 5. C · gateway「重启 dsh」入口（定稿）

### 5.1 位置与门控
gateway 卡连接/断开按钮旁文本按钮「重启 dsh」，仅 phase ∈ {ready, degraded} 可用，busy[id] 禁用；
统一插件模型视图（对话框）chamber 区/动作条提供「重启生效」（同动作函数）。gateway+ssh 卡 systemd
「重启实例」（重启 gateway 服务本身）保留；为防混淆，该按钮 tooltip 注明「重启 gateway 服务（systemd）」，
且**两按钮并排文案可见区分**（label 级，非仅 tooltip）；卡片 268px 网格宽度紧张时 systemd 起停并入 foot 图标。
多用户文案（P1）：gateway 通道的重启/应用确认必须注明「该 Gateway 上的其他用户会话也会短暂断开」（ssh
pluginsRestartWarning 语义的通道加强变体）。确认 Modal 后：`POST /api/i/gateway-<id>/chamber/runtime/restart`，
仅 202 接受；409/400 → body.error 逐字。轮询语义与 `pollGatewayReady` 精确一致（1s/120s；restart failed /
connectionState ∈ {error, restart-exhausted, stopped} 失败；'ok' 或旧网关 ready/degraded 回退；401/403/404
快失败；超时诚实投影）。成功/失败刷新卡片与视图 Loader 清单。桌面零改动（写走既有反代，auth 主进程注入）。

### 5.2 共享模块迁移（定稿；工作量修正版 ★）
split 而非 move：`gateway-runtime-api.ts`（778 行）中仅 parse/action/gates/error 分类/poll 为纯核心；
`remoteRuntimeStatusView` + `RemoteRuntimeStatusView` 引用 SettingsBridgeKey（L22/546-551）**留在 settings-bridge**
（与 REMOTE_PHASES/BLOCKED_PHASES 共享部分以 shared 导出形式回引）。纯核心 + `gateway-runtime-poll.ts` 迁
`@dsh-chamber/dsh-client-ui-sidebar/shared`（exports "./shared" → src，免构建；renderer/settings-bridge/
connections/layout/git 均为既有消费者；vite 共享单实例）。**ambient 镜像同步清单**：消费者并非对真源做
typecheck——四个插件经各自 tsconfig paths 引用手写 ambient 声明（connections `src/ambient/sidebar-shared.d.ts`；
settings-bridge `src/ambient/chamber-bridge.d.ts`（含 MIRROR WARNING）；git `src/ambient/sidebar-shared.d.ts`；
layout `src/ambient/chamber-view-prefs.d.ts`），renderer 无 tsconfig paths、经 `vendor-modules.d.ts` `declare
module`（:208-510）——git/layout 不走 vendor-modules.d.ts；迁移须
同步扩展这些镜像（RemoteRuntimeStatus 现 **30 字段**/parse/gates/Error/poll 符号），并在 sidebar 增加“镜像导出
集锁步”测试；
poll 的英文错误串随迁（connections 会显示未本地化文案，登记接受）。**测试迁移**：pollGatewayReady 用例现驻
settings-bridge/test/runtime-management.test.ts:124-217（import 迁移而非补建）；gateway-runtime-api.test.ts
（~700 行）按 split 拆：view 部分留 settings-bridge，核心随迁；settings-bridge/sidebar 两个 test 清单同步；
test:renderer-shell 无迁移文件（其清单无 gateway-runtime 用例；测试矩阵见 §9）。

### 5.3 键表（zh 源；en 镜像；【已实现 · 2026-12】）
> 注意：settings-bridge 已实现同族键 dshRuntimeRestartAction/Restarting/Restarted/RestartConfirm
> （locales zh L145-148 / en L336-339）——统一模型下两处入口语义同族，新键与既有键不得重复造词（文案对齐）。
restartManagedDsh 重启 dsh / restartManagedDshTip（受控重启 gateway 托管的 dsh；刷新插件挂载；运行时版本与
数据不动）/ restartManagedDshConfirmTitle / restartManagedDshConfirmDescription（含**该 Gateway 上其他用户
会话**短暂断开）/ restartManagedDshBusy / restartManagedDshOk / restartManagedDshAccepted / restartNotConnected /
restartApplyInPanel 重启生效 / restartGatewayService 重启网关服务（gateway+ssh systemd 按钮 label，与 dsh 目标
的 restartInstance 区分）/ restartServiceTip 重启 gateway 服务（systemd，整个服务；仅 ssh 传输可用）。
> 落地记录（2026-12）：connections locales 261+261 键；卡片按钮/确认 Modal/每卡单飞 per-id/共享 pollGatewayReady/
> 面板「重启生效」（gatewaySource 门控）均已实现（§4.2 轮询语义精确一致）；http+dsh 直连无按钮。

## 6. A · 统一插件管理模型 v1

### 6.1 边界与姿态
- 自动同步仅 chamber 两包；第三方手动（决策 4）；联网出网允许、registry 不限定（决策 1/3）；
- **安装期 lifecycle scripts 默认允许**（决策 13：与 ssh/桌面一致；用户明确不限制）。风险如实登记：
  安装/移除子进程与宿主插件代码以 gateway 用户执行（“已安装代码 = gateway 用户级等价”，决策 20）；
  二期硬化选项：ignore-scripts/逐包放行配置、OS 用户分离——均为二期，不默认做；
- 服务端信任 = 既有全权 auth；**不加 admission**（决策 14）：主进程确认是桌面通道纪律（main.ts:3064-3078），
  同源前端代码可驱动 /chamber 写面 = 与既有 /chamber/runtime 动作面（select/apply-now/restart…）同级暴露，
  如实登记、不新增机制；
- 写面互斥与生命周期集成（决策 6/17）：见 §6.3；
- 「已安装」列表、域拒绝、undo/恢复 = 模型统一功能，ssh 与 gateway 后端同权（决策 10/11/19，§6.4）。

### 6.2 gateway 后端路由契约（已实现；落地语义与裁定见 §10 勘误②③④）
| 路由 | 语义 |
|---|---|
| `GET /chamber/plugins` | 不变：chamber 两包种子缓存投影（已实现基线） |
| `GET /chamber/plugins/installed` | 模型 readManifest 的 gateway 实现（**已实现 2026-12**，packages/gateway/src/plugins-installed.ts）：`{dependencies: name→spec（file: 值以 MATERIALIZED_VALUE_MASK 掩码，保留 file: 前缀供 name 基 diff；gateway 本地路径不进 renderer）, bundles, profileExists, error?}`；scope 过滤由**模型层**做（UI 与路由同源，见 §6.7）；落地语义：profile 缺失 → **404** `{error:'managed profile is not initialized', code:'profile_absent'}`；解析失败 → **500** `{error:'managed profile is corrupted', code:'profile_corrupt'}`（细节仅宿主日志；route 头注释登记——design 原“{ok:false} 语义另行定义”由此裁定）；method GET-only 405；**读与写面共享栅栏**（写面落地时实现） |
| `PUT /chamber/plugins/install` | body `{name, spec}`：spec 白名单族（**模型层常量单一来源迁 control-plane 共享纯模块**：desktop 经双路径 facade control-plane-module.ts 与打包产物同源、gateway 直接引用；渲染端 ADD_SPEC 手写镜像保留并**新增锁步测试**）；**保留名拒绝**（@dsh-chamber/*、seed/overlay 名与官方域，与 remove 拒绝集一致、与对话框行过滤一致）；202 异步、队列串行 + 单写者栅栏；队列忙 → 409（code 见表）；输入错 → 400；profile 缺失 → deferred；执行失败 → 任务面持久投影 |
| `PUT /chamber/plugins/materialize` | 文件夹直推：**独立流式上传读体**（不复用 8 MiB readUploadJsonBody；≤32 MiB、413+destroy、解包大小/文件数上限防膨胀）；name/version 校验 + 保留名拒绝；落 `chamber-plugins/third-party/<escaped>/<name>-<hash>.tgz`（0700/0600/原子 no-follow）；idle → `add file:`；否则 deferred |
| `POST /chamber/plugins/remove` | body `{name}`：installed 投影内名字 + 保留名拒绝（模型层一致）；202 异步；**停机态可用** |
| `POST /chamber/runtime/start` ★ | **新原语**（决策 12）：仅 connectionState ∈ {stopped, error, restart-exhausted} 允许；202 + status 轮询（复用 restart 语义面：start: running/ok/failed + operationError）；受守卫：canStartLocal/exposureQuarantine/恢复门（recovery phase 只允许既有 retry/restore-builtin，不得被 start 绕过）/单飞与写栅栏；语义 = 受守卫 spawn（同 startup 事务后的 startLocal 路径），失败诚实投影（不伪装成功） |
| `GET /chamber/plugins/tasks` | 任务投影 pending/running/blocked/failed[{name,error}] + 最近完成保留期；持久来源 = 操作 journal（§6.3）；默认独立端点（并入 installed 的合并决定在 A1 起点定死） |

错误码总表（新增，遵循既有 `{error, code}` 蛇形约定）：`invalid_input` 400、`body_too_large` 413、
`reserved_name` 400、`not_installed` 400、`profile_absent` 200(deferred)/404 语义另行定义、`profile_corrupt` 500 或 409
（实现时定，配文案）、`queue_busy` 409、`runtime_busy/runtime_pending/runtime_recovery_required` 409（复用）、
`install_failed/remove_failed/start_failed`（任务面 code）、`persistence_failed` 500。per-route 验收标准挂在
§6.9 实现序与 §9 矩阵的 §6.2 路由行上（随执行计划逐阶段落地）。

### 6.3 gateway 后端执行器与互斥（已实现；评审 P1 修正版）
- 执行：spawn active runtime dsh CLI（resolveWorkspace）+ env `DSH_HOME=<stateDir>/dsh-home`；
  **安装子进程 env 纪律（升级）**：白名单 env（PATH+代理族），剥离全部 `DSH_GATEWAY_*` **及所有 npm_config_*/NPM_***
  环境变量，HOME/XDG_CACHE_HOME/XDG_CONFIG_HOME 钉 stateDir 内私有目录（注：runtime-installer 既有先例仅钉
  HOME/XDG_CACHE_HOME，XDG_CONFIG_HOME 为 executor 新增项），空 `NPM_CONFIG_USERCONFIG`，
  **profile 内 .npmrc 视为不可信环境配置**（不向其注入令牌；脚本默认允许的裁定下，此项为凭据最小化而非脚本禁行）；
  stderr 脱敏（复用 runtime-installer sanitizeInstallerOutput 族）；stdout 有界；超时/取消 kill 进程组；
  变更前磁盘空闲预检（镜像 runtime disk soft-limit）；
- **生命周期 writer barrier（决策 17，落地形态）**：managed profile 单写者 = runtime-manager
  `beginProfileWrite()`/`ProfileWriteLease`（count 制租约，runtime-manager.ts:1112+；refuse 矩阵
  :596-602；`assertMutationIdle` :1016 在租约持有期间拒绝一切 runtime mutation）——插件队列每个
  accepted op 持一把租约、per-op 终态钩子释放（executor dispose/终态写失败也释放，见 §10 补录①）；
  每次 spawn（start :720 / restart 与健康自动重启 :599 两路径）经 control-plane DI 缝
  `beforeSpawnCheckpoint`（local-connection.ts:85-90，**gateway 为唯一生产接线**：
  index.ts → spawn-checkpoint.ts 检查 profile-write 租约）——健康自动重启与 pnpm 写互斥（消除
  TOCTOU）；executor 在 manager dispose 之后 dispose（两 stop 路径，租约门封死间隙）；
  执行器 add/remove 前后双检 connectionState；
- **写入序**：① journal pending（ts/kind/name/spec/preImage 引用/操作者标签）→ ② 原子备份 package.json
  （+lockfile，两文件成对校验）到 `chamber-plugins/third-party/backups/<op-id>/`（0600）→ ③ 执行 → ④ journal
  终态（ok/failed/blocked + restart/start 结果）；启动对账残留 pending → failed（附 preImage 可恢复）；
  journal/备份保留策略（默认：最近 50 笔/7 天、备份随 op 保留、队列深度 ≤8、单 op 超时 10 分钟、失败可重试），
  队列深度/配额镜像 runtime disk 软限；remove 的 installed 名单**执行时**再校验（非入队时）；
- deferred：ready 边沿（observeLocalState，index.ts:318）空闲窗口排空（quarantine/激活过滤），装完自动受控
  restart 一次；
- 安装后自动「重启生效」：apply 默认 defer=false → 队列尾自动 restart（受 C 轮询语义）；defer=true 仅落盘不重启。

### 6.4 ssh 后端收敛（【已实现】收敛 + 【统一增量】）
ssh 后端动词映射到既有 IPC（readManifest=plugin_list、apply=plugin_apply、materialize=plugin_materialize_add_pick、
chamberProvision=seed_host_graph、restartToApply/startFromStopped=restart_service）——既有行为不变；
模型统一新增（【统一增量】，ssh/gateway 同权，决策 10/11/19）：
- 「已安装」列表逐行移除（consistent 行缺口修复）：ssh 后端的 remove 走 plugin_apply remove；
- remove/install 保留名拒绝集合与 gateway 一致（apply 白名单之外增补官方域/chamber 域/seed 名拒绝；
  applyPlugins 主进程侧落地 + 测试）；
- undoJournal：桌面主进程侧持久化（userData 0700 JSON）+ 变更前远端 package.json 备份（cat 读 → 本地存），
  撤销 = 恢复备份 + 必要 remove；
- 恢复引导 UI 与 gateway 一致（r0-r4 通用文案，后端差异仅在“启动/重启”动作映射）。
改动均落在主进程/纯函数层，PluginSyncModal 的 ssh 路径行为由既有纯测试 + 新增模型层测试守护。

### 6.5 桌面 IPC / 渲染层
- 模型动词经渲染层统一调用点（主进程按目标解析后端）；gateway 后端 IPC（命名待实现确认 → 落地记录）：
  **`gateway_plugin_sync(id)` 已实现（2026-12）**——手动 chamber 两包同步兜底：desktop 新增
  gateway-sync-registry.ts（ready 注册参数留存/离开 ready 与实例删除即清）、main.ts handler（id 白名单 +
  ready 复核 + `{ok:true,uploaded,skipped}|{ok:false,error}`）、preload/renderer 双镜像 + mirror golden
  （IPC 联合类型名 `GatewayPluginSyncIpcResult`，与 gateway-provider 内部同名 sync 结果 interface 区分）；
  读侧经实例代理 GET `/chamber/plugins`（种子缓存投影）与 `/chamber/plugins/installed`（§6.2）驱动 chamber
  区版本漂移显示与「立即同步」（视图层实现，§6.6 前驻 PluginInventoryView、gatewaySource 门控、http+dsh
  只读不变）。
  `gateway_plugin_apply(id, {add[], remove[], defer})` / `gateway_plugin_materialize(id)`（pick-only，取消 =
  {ok:true, cancelled:true}）**已实现（2026-12，Phase 4.6/5B）**——全部主进程执行 + showMessageBox 确认
  （apply 默认取消）+ 经注册 origin（SPKI/隧道 Host 纪律同 syncGatewayChamberPlugins）；apply = remove 先于
  add（decision 5）+ settle-then-restart + partial 诚实（GatewayPluginApplyIpcResult）；materialize =
  pick-only 文件夹→tarball（plugin-tarball.ts，容量与 gateway 路由锁步）→ 202/deferred；ssh 后端沿用既有
  IPC 方法名（surface 命名属后端实现细节，不强制重命名），并新增 ssh undo journal/IPC（ssh_plugin_undo，
  撤销=恢复语义）与 SSH_PLUGIN_LIST 掩码挂接（§6.4 统一增量）；
- **镜像面修正（评审 P1）**：新增写方法的真实编辑集 = preload.cts（方法+invoke 字面量）+ ipc-events.ts
  （3 通道）+ **main.ts（3 个 trustedIpc handler——文档原漏，B8 类测试使其缺失必红）** + renderer global.d.ts +
  ipc-surface-mirror.test.ts（golden 方法/字段清单 + 结果联合形状；gateway_plugin_apply 的 batch+cancelled 联合
  需要精确形状守卫）+ connections global.d.ts（**re-export 型**，仅新命名类型落新文件时改动）——共 5 处代码 +
  1 测试 + 条件性 re-export；
- 读侧（installed/tasks/status/Loader）全经实例代理 GET。

### 6.6 UI：单一模型视图（【重构等保】ssh 等价 + 【统一增量】双后端）
- 方向：PluginSyncModal 演进为单一模型视图（不再“ssh 版 + gateway 新统一版”两份叙述）——远程模式
  sync（chamber 区 + 差异区）+ add + **list（已安装列表，含逐行移除与撤销最近变更入口）**；本地模式 list+add
  不变；gateway 卡片改开同一视图；PluginInventoryView 收窄为 http+dsh 直连只读；
- **区域可见状态对照（取代旧“四处差异”框架）**：chamber 区（状态源 = 后端 chamberProvision/loadedFacts；
  gateway 实例停机时 Loader 不可达 → 明确的降级标签，不静默）；差异区（profile_absent → 「实例尚未初始化，
  将缓存安装意图，实例就绪后自动安装」横幅；队列/任务态文案键）；结果与失败面（partial「已完成 n/m」、
  blocked、409 逐字、任务行）；恢复面（r0-r4 文案见 §6.8）——每区 ssh 与 gateway 共用一套文案与流程，
  仅执行来源不同；
- 重构次序（评审 P1 修正）：① **先抽纯模型层**（intent 构建：remove 先于 add、defer、勾选保留规则；结果分类：
  partial/blocked/cancelled/失败行；task 投影 → 行模型；adapter/后端分派表含不支持组合）——纯 node 可测、
  无依赖即可先行；② 抽共享子组件保持 ssh 现状等价；③ 后端分叉接入 + gateway 卡片改开同一视图；ssh 回归 =
  既有纯测试 + 每步手动/脚本化回归门（步骤 ③ 前必须一次显式 E2E 门禁）；「失败即停」与 ssh 逐行
  materialize 隔离的取舍在模型层给出**单一定义**（批量内 registry/remove 失败即停；逐行 materialize 保持隔离，
  与 AGENTS 单实体失败不阻塞原则一致，文案如实呈现）；
- A 键表清单（新增，zh/en；类型门锁 zh/en，代码↔键覆盖靠实现清单）：partial/blocked/queue_busy 文案、
  多桌面移除确认、他人会话中断（C 复用）、deferred 离线执行确认（「将缓存并在实例就绪后自动安装，可能在你
  断开后执行」）、task 行（pending/running/blocked/failed + 上次失败）、preImage 恢复（撤销最近变更）文案、
  journal 横幅、停机态动作文案、startFromStopped 文案、profile_corrupt 恢复引导、保留名拒绝文案、who/when
  归因 tooltip（「由 <连接 label> 于 <时间> 安装/移除」，未知时「另一桌面」）。

### 6.7 安全模型（评审修订版）
- 既有全权 auth；渲染层不持凭据（主进程注入）；**主进程确认 = 桌面通道纪律（不加服务端 admission，决策 14）**；
- 写面：spec/name 白名单族单一来源（control-plane 共享模块）+ 渲染镜像锁步测试；保留名拒绝（模型层一致）；
  单写者栅栏 + 生命周期排空（决策 17）；日志脱敏（凭据零进入，含 npm 令牌类环境）；
- 信任声明（决策 20）：「已安装代码 = gateway 用户级等价」（进程隔离 ≠ 主体隔离；同用户可读 stateDir 0600
  jwt-secret 等）；scripts 默认允许（决策 13）风险登记；二期硬化：ignore-scripts/逐包放行、OS 用户分离；
- 多桌面：last-writer-wins + 队列串行 + 移除确认（全局影响文案）+ who/when 归因（连接 label 级，不进日志）；
- 移动例外不参与；future per-principal 角色扩展时，插件写路由与 runtime 写路由同属 operator-scope（18 先例）。

### 6.8 故障域与恢复（终版；评审 P1 修正）
- 故障域：插件代码执行在托管 dsh 实例进程/前端（进程隔离）；/chamber 管理面挂宿主、非 ready-gated——实例崩
  溃/停机时管理面存活；可能伤宿主的仅：机器级资源、安装期脚本（默认允许下以 gateway 用户执行）、profile
  元数据损坏——逐类登记（r3/r4 域）。
- 分层兜底：client 插件页面级（Loader fiber failed）；host 插件进程级（健康自动重启窗口 → restart-exhausted）；
  装完即崩（非 env 源自动回退 known-good + dsh-home 快照恢复 = 重锤，插件级轻恢复优先）；corrupt →
  profile_corrupt；seed（chamber 两包/移动端 extraneous + 每次 spawn 前 seed thunk 自愈，免疫）。
- 恢复阶梯（用户可见文案 + 动作均双后端同权）：
  - **r0 实例存活**：视图列表/diff 移除 → 「重启 dsh」（C）生效；
  - **r1 停机（stopped/error/restart-exhausted）**：停机态移除（执行窗口含停机态；installed 纯文件读）→
    **「启动实例」= start 原语（决策 12）**——卡片/视图给出明确动作 + 文案「已移除 <name>，正在重新引导…」；
    失败 → 诚实回 error + 提示（可再次移除/查看连接日志）；ssh 后端同动作映射 restart_service；
  - **r2 profile 损坏（profile_corrupt）**：视图横幅（journal 最近一笔 + 「撤销最近变更」）→ 停机 → preImage
    回滚（两文件成对校验）→ 残留名字 remove → start/restart；无备份（外部损坏）→ **正确兜底链**：
    restore-builtin **不能**治愈 corrupt profile（它探同一 dsh-home；restoreBuiltin 全程 runtime-manager.ts:1608-1665，
    探针走共用 executeStartupTransaction（:1630），dsh-home 不随目标版本更换 :521）——兜底改为
    operator runbook（从 `<stateDir>/dsh-runtime/snapshots/` 手工恢复 dsh-home 快照）；可选恢复路由列二期；
  - r3 脚本风险：登记（决策 13/20），恢复阶梯不承诺覆盖安装在 dsh-home 之外的持久物（cron/rc 等）——如实说明；
  - r4 宿主不可达：机器级 runbook；二期提供 `gateway plugin` 操作员子命令（list/remove/rollback 复用同一
    executor+journal 核心，现 CLI（除 serve 外）仅 auth 操作子命令（AUTH_HELP cli.ts:70-101，子命令段 :83-92：
    status/reset-password/clear））；
- 恢复判据：视图「已加载」Loader 事实行 + 状态行（重启前 active / 移除后消失）为细节证据；成功文案用自然语言
  （「已移除 X，实例已重新就绪」），不把 Loader 行当面向用户的判据。

### 6.9 分期、工程默认与实现序
- 实现序（依赖序）：**① §5.2 共享迁移（parse+poll split + ambient 镜像 + 测试搬迁）→ ② C（含 start 原语路由）→
  ③ A0 读面（installed/tasks 读路由 + gateway_plugin_sync + 视图 gateway 读面——无需写栅栏）→
  ④ A1 写面单元**：runtime-manager fence API（runExclusiveProfileWrite + beforeSpawnCheckpoint 接线 +
  activeOperations drain）→ journal/备份 → 串行队列执行器（**纯 node 单测单元：journal 状态机/门矩阵/队列模型/
  injectable spawn+env 断言**）→ tasks 面 → apply/materialize IPC + 确认链 → ⑤ UI 全闭环（先纯模型层测试后接线）；
  每步独立验收（per-route 验收挂 §6.2 路由行与 §9 矩阵）。
- 工程默认（可否决）：202 异步 + 任务面；队列深度 ≤8、单 op 超时 10 分钟、blocked 上限 5 分钟、journal 最近
  50 笔/7 天、上传前磁盘预检；文件夹 ≤32 MiB 独立流式路由 + 解包上限（≤4096 文件/解压 ≤256 MiB 默认值）；
  保留名/scope 拒绝模型层单一实现；tasks 默认独立端点（A1 起点定死合并决定）；执行窗口含停机态。

### 6.10 明确不做
http+dsh 直连插件管理（无执行后端）；gateway 编排面回流；控制面实现执行面；非插件资产远程写；
chamber 移动端参与第三方管理；安装期脚本默认禁行与 OS 用户隔离（二期硬化，非 v1）。

## 7. 决策遗留 / 开放项
- scripts 默认允许下的 env 最小化实测（v1 门禁）：`dsh plugin add` 的 pnpm 是否读取 profile/.npmrc、是否向
  子进程暴露 npm 令牌环境——据实收紧 §6.3 纪律（实测结果可回调，不允许扩大暴露）；
- tasks 并入 installed 的决定（A1 起点）；恢复路由（snapshot restore）进 v1 与否（默认二期，r2 走 runbook）；
- journal 操作者归因的 UI 呈现粒度（默认 tooltip 级）。

## 8. 与既有文档的关系及更新清单（实现时执行）
- design 17：§3 能力表增补第三方插件管理行并**勘误 dsh(http 直连) seed 行**（与 13/code 不符，见 §2.4）；
  §3 dsh-runtime 分节行（ssh 挂载“版本只读”）与 §16.2 同款表述**勘误为“dsh（ssh/http 直连）不挂载”**
  （与 18 §3.6/STATUS/AGENTS 一致，见审计 F4）；
  §10「/chamber/plugins」扩展 + 修订「无异步尾 → 无 admission fence」；**§4.1/§12 生命周期 writer barrier 语言
  扩展**（插件队列与 executor 子进程纳入 quiesce/dispose/stop 证明与 kill）；
- design 18：§6 出网面登记“安装子进程随宿主受控出网”（§1 决策 1 落实）；§9.3 增 `start` 原语行 + connections
  入口 + 插件写互斥矩阵（含 beforeSpawnCheckpoint）+ 与 restart-exhausted 自动回退衔接 + recovery-restore
  兜底链更正；
- design 05 §5：内容清单（日志命名、重启/启动按钮、单一模型视图与已安装列表、恢复提示行）+ **“三种来源均含
  重启 dsh 动作 / ssh = 版本只读行”表述改写为 dsh 直连（ssh/http）不挂载 dsh-runtime 段**（审计 F4）；
- design 13：§6/§7 收敛表述（单一模型、末段分叉；白名单单一来源归属变化；ssh 面新增统一增量），
  既有章节保持权威；
- 代码注释同步：routes.ts:801-810、dispatch.ts:649-653、gateway index.ts ~394-400/451-455（“同步 put 无 drain
  项”“read-only 无 fence”表述随写面落地改写）；ipc-events.ts/preload.cts 头注释；settings-connections
  global.d.ts re-export 增补（新命名类型时）；
- sidebar/settings-bridge README（共享模块迁移）；connections README 双语对 → README.i18n.yaml 重哈希；
- docs/progress/STATUS.md 实现进度登记。

## 9. 验证与测试矩阵
- B/C：test:connections（新增纯投影/门控/结果分类）、typecheck:connections、verify:i18n（仅 README 对）；
  共享迁移：test:sidebar + test:settings-bridge（文件随迁/拆 split/清单同步；renderer-shell 无迁移项）；
- 模型层（先于任何 UI 重构，纯 node 无依赖可先行）：intent 构建（remove 先 add/defer/勾选保留）、结果分类
  （partial/blocked/cancelled）、task 投影 → 行模型、后端分派表（含不支持组合）、journal 状态机与启动对账
  幂等（fake fs）、执行窗口 × 动作 × 在飞标志门矩阵（镜像 remoteRuntimeActionGates）、串行队列模型、
  executor 注入式 spawn（exit-code 夹具 + env 纪律断言）、白名单/保留名（迁 control-plane 后 gateway+desktop
  双跑 + 渲染镜像锁步新测试）、pollGatewayReady 迁移后随迁用例；
- A gateway 子矩阵：spec 白名单族/保留名拒绝/202 异步/批量 partial/remove 只删 installed 集内且执行时复核/
  profile_absent → deferred/profile_corrupt → preImage 回滚（原子对）/queue_busy/start 原语（停机态门 + 恢复门
  不被绕过 + 202/poll + 失败诚实）/上传流式上限与解包/任务面持久与对账/读面栅栏一致/磁盘预检/生命周期排空
  （dispose/quiesce/stop kill 子进程测试）；
- 恢复面：停机态 remove/install、start 闭环、corrupt 回滚、journal 幂等、一致行移除回归（ssh/gateway）、
  故障注入（坏插件 boot 失败 → restart-exhausted → 停机移除 → start 恢复；corrupt → preImage 回滚）；
- desktop：gateway-provider/plugin-sync 扩展（上传+确认+取消 no-op+SPKI/--no-auth/隧道 Host 四态）、
  ipc-surface-mirror/golden + main handler 清单、ssh 统一增量（已安装列表 remove/保留名拒绝/journal 备份）单测；
- 实机门禁（发布前）：真实 gateway + 打包 desktop 全闭环、TLS+SPKI、多桌面、registry 实装（传递依赖网络 +
  lifecycle scripts 实测行为）、文件夹上传、partial、deferred、start 恢复、故障注入；scripts/env 实测结果回调
  §6.3 纪律（§7 门禁）。

## 10. 实现前置条件与勘误记录
- 本工作树依赖未就绪（vendor/node_modules 未物化）：实现/测试前先 pnpm install；候选图标与 primitives 导出
  届时核对（B 不阻塞于字面图标）；
- 勘误记录（2026-12 全量核查期核对，供实现参考）：掩码语义（§1 #18：ssh/local 现状原样透传、掩码 helper 无
  生产调用点）；ADD_SPEC 无锁步测试（§6.2 补）；pollGatewayReady 测试现驻 runtime-management.test.ts:124-217
  （import 迁移）；connections global.d.ts 为 re-export 型；PluginApplyResult2 的 `{ok:true,cancelled:true}` 成员
  **不可生产**（SSH_PLUGIN_APPLY handler 只回 ok/error，main.ts:2871-2902 无取消；ipc-surface-mirror.test.ts
  :259-265 钉死无 cancelled；PluginSyncModal:334 分支为死代码——模型层结果联合收敛时**删除**该成员）；17 §3 seed 行与代码不符（§8 勘误）；`runExclusiveProfileWrite` 为 A1 新建符号、
  `beforeSpawnCheckpoint` 现为 test-only 调度缝（local-connection.ts:87-90）；local 插件 handler 区段
  main.ts:3044-3083；/chamber/plugins 上传读体 8 MiB 上限在 routes.ts:57-109 而非 plugins.ts；XDG_CONFIG_HOME
  不在 runtime-installer 既有先例中（executor 新增）；RemoteRuntimeStatus 现 30 字段；restoreBuiltin 全程
  runtime-manager.ts:1608-1665；gateway CLI 除 serve 外仅 auth 操作子命令（AUTH_HELP cli.ts:70-101）；
  connections README.i18n.yaml 记录哈希已过期（README.md/README.zh.md 均有新值，Phase 1 重录）；
  pollGatewayReady 英文错误串随迁 shared 后为未本地化文案（登记接受）。
  现存代码缺陷登记（全量核查发现，修复另行排期）：① `desktop_local_plugin_add_file` **实际不可用**——main.ts:3049
  调 runLocalDshPlugin 未传 `{allowFileSpec:true}`，plugin-sync.ts:1854-1859 拒绝所有 file: pick（UI 可达，
  PluginAddView.tsx:100）——修复 = 调用点补 allowFileSpec 开关并补测试；② design 13 §7.0 承诺的远端
  plugin_apply/materialize/seed 主进程确认在 main.ts 未实现（仅本地 add/remove 有确认：3064/3076）——设计意图
  保留，A 确认链按 decision 14 落地时补齐并登记该缺口；③ 掩码 helper（redactLocalPluginManifest）注释声称
  “IPC 响应已掩码”但无任何生产调用点（LOCAL/SSH_PLUGIN_LIST 均原样返回，本地 file: 绝对路径可跨 IPC 进
  renderer）——design 13 §7.0 相应表述同样过期，模型层 readManifest 挂接时一并修正。
- **实现勘误与裁定补录（2026-12，Phase 1-5 落地后回写）**：
  ① §10 缺陷登记② 缺口已在 A 确认链落地时**部分**补齐并登记撤销——落地的确认 = gateway
  gateway_plugin_apply/undo + ssh_plugin_undo 主进程对话框（4G/5B）；**ssh 端 plugin_apply /
  seed_host_graph / materialize_add(_pick) 与 gateway 端 materialize 仍无主进程对话框**
  （gateway materialize 为设计意图「pick 即意图」；ssh 端确认缺口登记为开放项，2026-12 质量审核
  复核措辞收紧，不再声称全量补齐）；③ 已由 5B 挂接掩码（SSH_PLUGIN_LIST 经 redactRemotePluginManifest 掩码；LOCAL_PLUGIN_LIST 按
  local 模式保持原样——readManifest 统一挂接即本意，掩码 helper 现有一处生产调用点）；缺陷①
  `desktop_local_plugin_add_file` 仍待修（登记未变）。
  ② remove 路由 not_installed/no_manifest 应答**裁定为 409**（routes submitRefusalStatus；§6.2 表 400 措辞以
  实现为准，409 语义与 queue/runtime 拒绝族一致——客户端按 status+code 判别）。
  ③ 'too_large' code 双档（上传体 413 / tgz 扫描 400）以状态区分，客户端按 status+code 组合判别。
  ④ journal 保留 v1 = 最近 50 笔、无时间窗（design §6.9 措辞以此为准）；解包上限按 §6.9 默认 **256 MiB**
  落地（tgz-scan/tarball 锁步）。
  ⑤ 5C 修复 Phase-3 引入的 seed-cache **双前缀真 bug**（gatewayChamberSeedCache(sourceId) 曾双写
  gateway-gateway-<id>；现全部调用点传 raw id、wrapper 前缀一次）。
  ⑥ unified-view 现状（2026-12）：ssh 模态与 gateway 视图为**功能等价双面**（PluginSyncModal remote
  sync/add/list + PluginInventoryView 已安装/变更记录/撤销/降级），统一单组件合体未做（登记余留）；
  who/when 归因 tooltip 未渲染（TaskRow 未投影 initiator）；A 键表 296/296（34+1 键），预置未用键
  （blockedTask/queueBusy/lastFailedHint/reservedNameRefused/opAttribution*/startManagedDshConfirmTitle）
  待归口文案接线或删除；gateway 拒绝码→本地化文案映射未做（409 逐字英文，登记接受）。
  ⑦ 计划要求的实机 E2E 矩阵（ssh+gateway 双通道手动/脚本化门禁）不可在本工作树执行（无真实
  gateway/desktop），**未勾销**——发布前在可运行环境按 §9 矩阵执行。
- **质量审核修复补录（2026-12，审核后执行，全部带失败注入/行为测试并全量验证绿）**：
  ① **租约泄漏修复**（审核 P1-A1）：executor `complete()` 在 journal 终态写失败（markTerminal
  抛错）或记录丢失（markTerminal null，journal 被 aside）时仍触发 per-op 终态钩子（合成最小
  terminal 记录）——profile-write 租约永不过期问题消除（plugins-exec.ts；plugins-exec.test.ts
  新增 stub-journal 抛错与 corrupt-aside 两注入测试）；journal `markTerminal` 同时清除 childPid。
  ② **env 白名单化**（审核 P1-A2）：executor `scrubInstallEnv` 由前缀黑名单改为真白名单
  （PATH+代理族，INSTALL_ENV_WHITELIST 由 dsh-runtime 导出共享，与 runtime-installer 同源），
  一切其它环境变量（含 NODE_AUTH_TOKEN 等）不得进入安装子进程（§6.3 原文即白名单，代码此前
  为黑名单——现一致）；env 测试改为白名单断言。
  ③ **deferred 排空后自动受控 restart 一次落地**（审核 P1-A3）：drain 轮内**全部**排空意图 op
  终态（且至少一个 ok）后经 `restartManaged` 注入钩子请求一次受控重启——请求点定在末个 op
  终态而非首个 ok 终态，避免撞上仍在途的后续 op 租约被门拒后单次尝试丢失（第二轮扫描修正）；
  index.ts 门控镜像 /restart 同步拒绝族（recovery/pending 相位、applying/installing、非
  ready/degraded、租约与 restart 单飞——门闭即 skip 不报错，若并发外部写者仍持租约则跳过并
  登记）；另补 drain 波浪续排（审核 P2-A2：queue_full 等待槽位再排下一波，DRAIN_DEADLINE 10
  分钟兜底），>8 积压意图在健康实例上可自清。
  ④ **ssh undo journal 目标绑定**（审核 P1-B1）：journal op 记录 `fingerprint`
  （operationalFingerprint：host/user/service/home 等操作目标），undo 只认
  `latestOkForTarget`（当前目标指纹一致才可撤销；旧/无绑定 op 不可撤销）；主进程在实例删除与
  **操作指纹变更**（同 id 编辑换目标）两条转换路径上 clear journal（main.ts 转换钩子）。
  ⑤ **stderr/错误脱敏升级**（审核 P2-A1）：executor 默认 sanitize 换为共享核心
  `sanitizeInstallerOutput` 族（URL userinfo/query 能力令牌 → origin、命名 secret 脱敏、
  绝对路径清除、≤2000 字节有界——journal error 与 tasks 投影同界）。
  ⑥ **tasks/deferred 投影掩码**（审核 P2-A3）：file: spec 在 GET /chamber/plugins/tasks 与
  deferredIntents 投影掩码（MATERIALIZED_VALUE_MASK，与 readManifest 同纪律）；内部意图/记录
  保留真实路径供执行与 GC。
  ⑦ **崩溃孤儿重放**（审核 P2-A7）：executor spawn 时把子进程 pid 记入 pending journal op
  （markChildPid），启动 reconcile 时对带回 childPid 的 pending op 击杀进程组/pid（先 -pid 后
  pid；持久化失败记录清除 childPid，reconcile 只在其返回拷贝上保留）。
  ⑧ **手动 chamber 同步失败显式化**（审核 P2-B1，plan 遗留登记 P2 勾销）：syncGatewayChamberPlugins
  对 GET/PUT 非 200 与网络异常返回 `{failed:true, error}`；`gateway_plugin_sync` 把 failed 映射为
  ok:false——「已是最新」不再吞失败（both-false 仅余真·全匹配场景）。
  ⑨ **gateway_plugin_apply 确认后重检**（审核 P2-B2）：确认对话框之后、执行之前重读注册态与
  ready/实例（materialize 同款模式），漂移即 ok:false「连接在确认期间变化」，绝不按确认前快照执行。
  ⑩ **staged tgz GC**（审核 P2-A4）：materialize 暂存归档在 op 终态（submitWithLease 终态钩子）、
  submit 拒绝（route 侧）与 deferred 意图清除（clearIntent）三处删除——stateDir 不再无界增长。
  ⑪ **persistence_failed 500 码落地**（审核 P2-A5）：deferred 持久化失败经路由包转 500
  `persistence_failed`；executor journal append 失败由 queue_busy 改判 `persistence_failed`，
  submitRefusalStatus 增 500 映射。
  ⑫ 代码注释同步：routes.ts 头注释、plugins-exec/plugins-tasks/index.ts 相关注释随上述修复改写；
  dsh-runtime `INSTALL_ENV_WHITELIST`/`sanitizeInstallerOutput` 升为共享导出（dist 产物随
  build:dsh-runtime 重建，字节级确定性）。
  ⑬ 多用户中断提示范围裁定（审核 P2-C1，登记不实改）：多用户文案只在 connections 卡片
  重启确认（restartManagedDshConfirmDescription）落地；视图面板「重启生效」为直发动作、
  settings-bridge runtime 段 gateway 重启确认沿用 design-18 既有文案（dshRuntimeRestart
  Confirm）——两处差异为**已登记的有意范围**（§5.3 落地记录只认卡片入口），后续如需
  统一按此条补键/补文案。
- **第二轮扫描修正补录（2026-12，复核修复轮自身；全量验证绿）**：
  ⑭ drain 自动重启请求点修正（第一轮 ③ 的实现缺陷）：原在首个 ok op 终态即请求，会撞上
  同一轮仍在途排空 op 的 profile-write 租约而被 index 门控跳过且永不重试——现改为本轮
  **全部**排空 op 终态（且至少一个 ok）后请求一次；测试改为手动 close 逐步终态并断言
  首个终态后不请求、末个终态后才恰一次（plugins-tasks.test.ts）。
  ⑮ materialize 路由 500 分支补暂存档 GC（第二轮扫描 P1）：submit 抛错（deferred 持久化失败）
  路径原先不删已 stage 的 ≤32 MiB 归档（无 op/intent 引用 → 无界增长）——现与拒绝分支同样
  rmSync（routes.ts）。
  ⑯ tasks 投影 childPid 掩码（第二轮扫描 P2）：pending op 的存活宿主进程 pid 不得经
  GET /chamber/plugins/tasks 出网——投影删除 childPid（内部 journal 保留供崩溃对账）；
  新测试断言投影无 childPid 而 journal 有（plugins-tasks.test.ts）。
  ⑰ 波浪测试强化（第二轮扫描 P2，测试强度）：原 10 意图测试用 microtask-close spawn，
  op 终态与提交交错、queue_full 从不触发（实测峰并发租约 =1，波浪代码未被锻炼）——改
  200ms 慢关 + 租约授予时序证明：wave1 全 10 意图尝试（8 持租约 + 2 queue_full 释放）、
  第 11 次授予须等首波终态腾槽（gap ≥100ms 断言），5 次连跑稳定。
- 代码行号以 2026-12 评审期核对为准，实现以实际文件为准。
- 代码行号以 2026-12 评审期核对为准，实现以实际文件为准。
