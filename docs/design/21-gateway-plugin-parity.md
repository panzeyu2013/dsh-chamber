# 21 · 统一插件管理模型与 gateway 连接对齐

> **状态：现行（单一插件管理模型（ssh/gateway 双后端）+ B/C 连接页接线，2026-12）**——
> 插件管理全仓只有一份模型（UI、流程、差异语义、状态机、文案、恢复能力），ssh 与 gateway
> 是同一模型下的两个执行后端，分叉只发生在最终执行阶段；本文是模型与双后端契约的收敛
> 权威，ssh 后端的既有行为权威在 design 13。未完成门禁见 docs/progress/STATUS.md。
>
> 相关设计：13（ssh 远端插件管理）、17（gateway 形态与 /chamber 面）、18（runtime 管理）、05（连接设备页）、
> 02（seed 与 spawn 语义）。本文档与 13/17/18/05 的关系见 §8（02 的 seed/spawn 语义关系见 §2.4）。

## 1. 目标与决策

三个用户诉求（来自 connections 连接设备页）：
- **A**：gateway 连接缺 ssh+dsh 那样的第三方插件「添加/同步/移除」闭环——“使用 gateway 功能反而退化”；
- **B**：gateway 卡上「日志 / 主机日志」两个入口无法区分；
- **C**：connections 页缺 gateway「重启 dsh」按钮（runtime 受控重启机制已就绪，连接页无入口）。

决策（用户拍板）：

| # | 决策 | 口径 |
|---|---|---|
| 1 | A 联网装包出网 | **允许**——联网添加包本就访问 registry；「零出网」仅指受控实例子进程的凭据面（host 进程出网面登记见 design 18 §6；安装子进程随宿主受控出网按 design 18 §4 env 纪律——保留代理、钉 `--registry`——与 runtime 安装引擎同例） |
| 2 | A v1 安装 | **registry spec 直装 + 本地文件夹直推**（spec 白名单族；文件夹 ≤32 MiB 独立流式上传） |
| 3 | A registry 来源 | 不限定（默认官方源） |
| 4 | A 自动同步边界 | 仅 chamber 宿主包 ready 自动同步；第三方一律手动勾选应用 |
| 5 | A 执行/确认 | 批量勾选 → 一次主进程确认 → 队列逐行串行（先 remove 后 add），失败即停并如实投影 completed/failed |
| 6 | A 互斥 | runtime 单写者栅栏 `runExclusiveProfileWrite()`（与 restart/apply 共用串行化），健康自动重启经 `beforeSpawnCheckpoint` 检查同一把锁 |
| 7 | A 执行窗口 | connectionState ∈ {ready, degraded, stopped, error, restart-exhausted}；仅拒绝 starting/restarting/applying 窗口与 runtime 事务/restart 在飞 |
| 8 | A deferred | profile 缺失 → 意图/字节缓存 → ready 边沿空闲窗口排空 → 装完自动受控重启一次 |
| 9 | A 一致性原则 | **收敛为单一插件管理模型**（同一 UI/流程/契约/状态机），**仅在最终执行阶段分叉**：gateway 后端 = 宿主 spawn 执行；ssh 后端 = 桌面主进程 ssh exec。不是“双通道同权”，是一个模型、末段分叉 |
| 10 | A 显式移除 | 「已安装」列表 + 每行移除 = 模型统一功能，ssh/gateway 两后端同权落地（补 consistent 行不可移除缺口） |
| 11 | A 恢复能力 | 停机态可移除；pre-mutation package.json 备份 + 持久操作 journal（任务面 + 撤销最近变更）+ profile_corrupt 恢复——按后端持久化（gateway：宿主 stateDir；ssh：桌面主进程侧 + 远端变更前备份） |
| 12 | A 恢复原语 | `POST /chamber/runtime/start`（仅 stopped/error/restart-exhausted；202+poll；受守卫：canStartLocal/恢复门/单飞）——停机移除后回到可启动的 UI 入口 |
| 13 | A 安装期脚本 | **默认允许**（与 ssh/桌面一致，不限制——避免用户困扰）；风险登记（安装代码=gateway 用户级）；二期提供 ignore-scripts/逐包放行配置与 OS 用户隔离（硬化） |
| 14 | A 服务端 admission | **不加**——主进程确认是桌面通道纪律而非服务端门；服务端信任 = 全权 auth 直连（与既有 /chamber/runtime 动作面同级暴露，如实登记） |
| 15 | C 共享模块 | gateway-runtime 纯核心（parse + poll）迁 `@dsh-chamber/dsh-chamber-client-ui-sidebar/shared`（split 边界，见 §5.2） |
| 16 | B 命名/图标 | 「连接日志」「网关主机日志」+ 图标去重；本地卡折叠区不改名 |
| 17 | A 生命周期 writer barrier | gateway 后端 executor 挂入 runtime-manager tracked-writers（activeOperations/单飞门），dispose()/dispatch.quiesce() 排空、stop 杀安装子进程、锁释放前 writer 证明——见 §4.1/§12 与 design 18 §9.3 |
| 18 | 掩码语义 | gateway readManifest 的远端 file: 值**一律掩码**（`MATERIALIZED_VALUE_MASK` 同常量：保留 file: 前缀供 name 基 diff、gateway 本地路径不进 renderer，§6.2）。**已知偏差**：ssh 清单已挂接掩码（`redactRemotePluginManifest`，plugin-sync.ts）；本地 LOCAL_PLUGIN_LIST 仍**原样透传**（本地 file: 绝对路径可进 renderer）——本地侧 `redactLocalPluginManifest` 仍零生产调用点，模型层 readManifest 挂接时统一收敛 |
| 19 | scope 过滤统一 | 第三方行过滤与移除/安装拒绝集合在**模型层**单一定义（官方域 + chamber 域 + seed/overlay 名）：对话框行、两后端 remove、gateway install 拒绝集一致（ssh 后端补官方/chamber 域拒绝 = 与 gateway 同权） |
| 20 | 信任声明 | “已安装代码 = gateway 用户级等价”（进程隔离≠主体隔离）；OS 用户分离列二期硬化 |

## 2. 插件管理基线（本地 / ssh 远端 / UI / 宿主包 seed / 受控重启）

### 2.1 本地 profile 插件管理
`desktop_local_plugin_list / add / add_file / remove`；主进程 `runLocalDshPlugin`（desktop/plugin-sync.ts）
固定 argv 执行 `dsh plugin add <spec>` / `add file:<path>` / `remove <name>`；showMessageBox 确认，
取消 = `{ok:true, cancelled:true}`（design 13 §5/§7.0）。本地清单 = 读本地 `<home>/profiles/web/package.json`
依赖投影 + 分类 + chamber 注入态版本。

### 2.2 ssh 远端插件管理
`desktop_ssh_plugin_list / plugin_apply / seed_host_graph / plugin_materialize_add(_pick)`、`restart_service`
（插件 exec 面（list/apply/seed/materialize）仅服务 `{kind:'dsh', transport:'ssh'}`，main.ts 门控、
design 13 §1 范围；systemd exec（含 restart_service）**只按 ssh transport 门控**、gateway-over-ssh 亦可用——
属连接管理面，见 §3 目标语境差异）。远端清单 = ssh cat 远端 profile
package.json → `parseRemoteManifest` 投影（**原始 spec 值**，plugin-sync.ts）；差异由 `computePluginDiff`
计算；apply = 主进程二次白名单 → 远端 `dsh plugin add/remove`（registry spec 或 materialize `add file:`），
remove 先于 add、可 defer 重启；write-file 上限 50 MiB；spec/name 白名单常量的单一来源是
control-plane 共享纯模块 `plugin-spec.ts`（desktop 经双路径 facade 消费），渲染端 ADD_SPEC 为
**锁步测试守护的手写镜像**（§6.2）。

### 2.3 插件管理 UI
四个来源（本地 / ssh+dsh / gateway / http 直连）共用同一个 `PluginDialog`
（`PluginDialog.tsx`，§6.6）——旧的双组件分流（`PluginSyncModal` + `PluginInventoryView`）
已删除，卡片按 `target.kind` 把数据源喂给同一个对话框；gateway/http 直连区
**非只读**：含已安装行/移除/撤销/restart 面板/tasks 投影/sync 状态（http 直连本身无可执行后端，只读）。
`plugin-diff.ts` 纯函数族
（missing/update/extra/materialize/unsyncable/consistent——**无 scope 逻辑**）、plugin-inventory-text/plugin-diagnostic
纯投影（thirdPartyEntries 过滤 @deepseek-ai/* + chamber 注册表包（含 archive-cleanup），
并额外排除调用方传入的注册表派生 expected 名单，仅用于 Loader 已加载事实层）。测试 = connections 纯模块文件，**无组件级测试**。
「chamber 内置（注入）」表的行集不写死包名——由控制面
`CHAMBER_HOST_PACKAGES` 注册表经 desktop IPC 投影（`chamber.packages[]`）驱动，UI 逐行映射；
`remoteNeedsSeed`/重启提示/seed-cache 漂移/同步包表同样逐包派生（design 13 §6）。
行派生收敛为纯函数 `deriveChamberRows`
（plugin-inventory-text.ts，只回 label KEY 与版本 STRING，组件只做 descriptor→JSX 映射），
由 `test/chamber-rows.test.ts` 表驱动测试覆盖（含 LOCAL 目标读自身清单、空 expected 不谎报
seed-cache、gateway 客户端行由 Loader inventory 分类派生、inventory 不可用时 unknown 行
而非写死包名）。

### 2.4 chamber 宿主包同步与 seed
桌面 ready 自动 `syncGatewayChamberPlugins`（gateway-provider.ts；main.ts 装配）；
gateway `PUT/GET /chamber/plugins` 白名单三包缓存（`dsh-chamber-seed-client-graph`、
`dsh-chamber-seed-git-worktree`、`dsh-chamber-seed-archive-cleanup`（design 24）；
plugins.ts 白名单 + 大小上限；0700/0600/原子
no-follow；上传读体 8 MiB 上限在 routes.ts `readUploadJsonBody`，非 plugins.ts）；
seed = extraneous + patch overlay（不进 package.json，control-plane/index.ts），每次 spawn（含健康自动重启，
local-connection.ts `start`/`restart` 两路径）前 seed thunk 重求值自愈（02 §2.6）；激活探针期望集按实际同步包
逐包派生（`syncedHostDomainProbeNames` → `activationProbeNamesForDomains`；无二元
`hasSyncedHostSeed` gate——空缓存 = 基础缩减集，部分同步 = 已挂载域）；
移动端 `dsh-chamber-client-ui-mobile` = 唯一随 gateway 发行物打包 seed 的 chamber 客户端插件（17 §3/§10.2）。

### 2.5 gateway 运行时受控重启
`POST /chamber/runtime/restart`（dispatch 无条件挂载、非 ready-gated；**仅 ready/degraded
可重启**；202 + status 轮询 restart running/ok/failed + operationError，
resolve≠success，18 §9.3）；单飞 = manager 标志 + route 409 + restartLocal 与健康重启共用串行化
（local-connection.ts）；**激活事务**（startup/apply-now/restore-builtin/回退路径）快照/回退覆盖整棵
dsh-home（runtime-manager.ts `snapshotDshHome` 全树拷贝；`/restart` 本身 = restartLocal 受控 spawn、
**无快照**）；settings dsh-runtime 段 gateway 分支经 renderer fetch + `pollGatewayReady`。
停机/错误/restart-exhausted 的恢复原语是 `/chamber/runtime/start`（决策 12，§6.2）；`restartLocal`
本身拒绝 stopped/error/restart-exhausted。

## 3. 一致性原则：单一模型，末段执行分叉

> 不是“两个通道各一套同权功能”，而是**收敛为一个插件管理模型**：UI、流程、差异语义、状态机、文案、
> 恢复能力全部只有一份；ssh 与 gateway 是同一个模型下**两个执行后端**，分叉只发生在**最终执行阶段**
> （怎么拿到远端 profile 事实、怎么把 add/remove/restart 落到目标上）。任何界面/逻辑层不得出现
> “if gateway … else if ssh …”的功能分叉——分叉只允许出现在后端实现内部。

**模型动词（后端无关，UI 与流程只依赖它们）**：

| 动词 | 语义与投影 | 分叉点（末段执行） |
|---|---|---|
| readManifest | 远端 profile 依赖投影（单一定义：name→spec（file: 掩码）+ bundles + profileExists + corrupt/absent 码） | ssh：cat+parse；gateway：读自身 profile |
| apply({add[], remove[], defer}) | 批量一次确认；先 remove 后 add；失败即停；completed/failed 投影 | ssh：远端 `dsh plugin add/remove`（applyPlugins）；gateway：宿主 spawn 执行（§6.3） |
| materialize | 本地文件夹 pick → pack → 目标安装（file: 语义） | ssh：pack→write-file→add file:；gateway：pack→上传→宿主 add file: |
| chamberProvision | chamber 宿主包与目标一致 | ssh：ready 自动 + seed_host_graph 手动补种；gateway：ready 自动 PUT + 「立即同步」兜底 |
| restartToApply | 安装/移除后让运行实例装载 | ssh：`restart_service`（systemd）；gateway：`POST /chamber/runtime/restart`（202+poll）；本地实例在 dsh-runtime 段 |
| startFromStopped | 停机/错误/restart-exhausted 后回到可启动（恢复 r1 闭环） | gateway：`POST /chamber/runtime/start`；ssh：`restart_service`（systemd 可启停）；本地：dsh-runtime/连接面 |
| undoJournal | 撤销最近一次变更（preImage 恢复或等价） | ssh：桌面主进程侧 journal + 变更前远端 package.json 备份；gateway：宿主 journal + preImage（§6.3） |
| loadedFacts | 已加载 Loader 事实行（只读、诊断） | gateway/http：实例代理 pluginInventory；ssh：无该面（Loader 不可达时不渲染，模型允许后端缺省可选面） |

**后端矩阵**：local（本地 profile，list+add 语义）、ssh（model 动词 + 已安装列表逐行移除/保留名拒绝/
undo journal）、gateway（§6.2/§6.3）、
http+dsh 直连（无任何执行后端——无 /chamber、无 ssh exec、无管理面（17 §3），只读保留，
无法也不应“一致”）。

**目标语境差异（不再是功能差异，登记为唯一可见差异）**：gateway+ssh 卡的 systemd 「重启实例」按钮属**连接
管理面**（重启 gateway 服务本身，非插件模型动词），保留并改 tooltip/文案区分（B/C 章节）；插件模型内无其他
按目标的分叉。

## 4. B · 日志入口可区分

gateway 卡「主机日志」与「日志」并列、插件入口同形、Modal 标题只差前缀——三者互相不可区分。

方案：环形缓冲入口与 Modal 标题「日志」→「连接日志」（说明行：本机侧连接通道事件：隧道/探针/握手验证等
连接过程记录，用于排查连接问题——覆盖 http 直连）；gateway 卡「主机日志」→「网关主机日志」（服务器侧
gateway 进程与托管 dsh spawn 日志）；本地卡折叠区「主机日志」不改名；service 行 Checklist（状态行）保留但
与两个日志入口在视觉上明确区分（插件入口改图标后 Checklist 仅剩 service 行与日志入口——日志入口一并换图标）。
图标：插件入口（本地+远端）→ IconFolderOpenOutline16；连接日志入口 → IconSearchOutline16；网关主机日志保留
IconDataOutline16；service 行保留 IconChecklistOutline14（状态行）。图标取仓内既有 primitives 导出
（IconFolderOpenOutline16/IconSearchOutline16，先例 sidebar vendor-modules.d.ts）；可运行环境核对
出新候选时可再换（换点：import + 按钮 + ambient 一行）。键名保持稳定（logs/hostLogs 改值不改键），新增
gatewayHostLogs/logsModalHint/gatewayHostLogsModalHint；zh 源 + en 镜像，词典一致性由 typecheck
（`Record<keyof typeof zh>`）保证（verify:i18n 只管 docs 双语对）；README 双语变更时需重录 README.i18n.yaml 哈希。
B 以键名 + 文案 + 图标三重区分交付。

## 5. C · gateway「重启 dsh」入口

### 5.1 位置与门控
gateway 卡连接/断开按钮旁文本按钮「重启 dsh」，仅 phase ∈ {ready, degraded} 可用，busy[id] 禁用；
统一插件模型视图（对话框）chamber 区/动作条提供「重启生效」（同动作函数）。gateway+ssh 卡 systemd
「重启实例」（重启 gateway 服务本身）保留；为防混淆，该按钮 tooltip 注明「重启 gateway 服务（systemd）」，
且**两按钮并排文案可见区分**（label 级，非仅 tooltip）；卡片 268px 网格宽度紧张时 systemd 起停并入 foot 图标。
多用户文案（P1）：gateway 通道的重启/应用确认必须注明「该 Gateway 上的其他用户会话也会短暂断开」（ssh
pluginsRestartWarning 语义的通道加强变体）；该文案在 connections 卡片重启确认与 settings-bridge
runtime 段 gateway 源重启确认（专用键 `dshRuntimeRestartGatewayConfirm`，zh/en 成对、含多用户中断披露）
两处落地，视图面板「重启生效」为直发动作（不弹确认）。确认 Modal 后：`POST /api/i/gateway-<id>/chamber/runtime/restart`，
仅 202 接受；409/400 → body.error 逐字。轮询语义与 `pollGatewayReady` 精确一致（1s/120s；restart failed /
connectionState ∈ {error, restart-exhausted, stopped} 失败；'ok' 或旧网关 ready/degraded 回退；401/403/404
快失败；超时诚实投影）。每卡单飞（per-id）；成功/失败刷新卡片与视图 Loader 清单。桌面零改动（写走既有反代，
auth 主进程注入）。

### 5.2 共享模块迁移
split 而非 move：`gateway-runtime-api.ts` 中仅 parse/action/gates/error 分类/poll 为纯核心；
`remoteRuntimeStatusView` + `RemoteRuntimeStatusView` 引用 SettingsBridgeKey **留在 settings-bridge**
（与 REMOTE_PHASES/BLOCKED_PHASES 共享部分以 shared 导出形式回引）。纯核心 + `gateway-runtime-poll.ts` 迁
`@dsh-chamber/dsh-chamber-client-ui-sidebar/shared`（exports "./shared" → src，免构建；renderer/settings-bridge/
connections/layout/git 均为既有消费者；vite 共享单实例）。**不设手写 ambient 镜像**：消费者对**真源**做
typecheck——root tsconfig `paths`（`@dsh-chamber/dsh-chamber-client-ui-sidebar/shared` → 真实
`src/shared/index.ts`）供 git/layout/connections/renderer 继承（各 tsconfig 补 `rootDir: "../.."` 避免
TS6059）；settings-bridge 保留自身 connections-section paths、经 workspace 链接 + sidebar
`exports["./shared"]` 解析。`RemoteRuntimeStatus`（33 字段，30 必填+3 可选）/parse/gates/
Error/poll 符号随 shared 真源直接可见，无需镜像同步。
poll 的英文错误串随迁（connections 会显示未本地化文案，登记接受——见 §7）。**测试**：pollGatewayReady 用例驻
settings-bridge/test/runtime-management.test.ts；`gateway-runtime-api.test.ts` 按 split 拆：view 部分留
settings-bridge，核心随迁；settings-bridge/sidebar 两个 test 清单同步；
test:renderer-shell 无迁移文件（其清单无 gateway-runtime 用例；测试矩阵见 §9）。

### 5.3 键表（zh 源；en 镜像）
> 注意：settings-bridge 有同族键 dshRuntimeRestartAction/Restarting/Restarted/RestartConfirm
> ——统一模型下两处入口语义同族，新键与既有键不得重复造词（文案对齐）。
restartManagedDsh 重启 dsh / restartManagedDshTip（受控重启 gateway 托管的 dsh；刷新插件挂载；运行时版本与
数据不动）/ restartManagedDshConfirmTitle / restartManagedDshConfirmDescription（含**该 Gateway 上其他用户
会话**短暂断开）/ restartManagedDshBusy / restartManagedDshOk / restartManagedDshAccepted / restartNotConnected /
restartApplyInPanel 重启生效 / restartGatewayService 重启网关服务（gateway+ssh systemd 按钮 label，与 dsh 目标
的 restartInstance 区分）/ restartServiceTip 重启 gateway 服务（systemd，整个服务；仅 ssh 传输可用）。
gateway 源在 settings-bridge runtime 段另有 `dshRuntimeRestartGatewayConfirm`（含多用户中断披露）。
http+dsh 直连无按钮。

## 6. A · 统一插件管理模型

### 6.1 边界与姿态
- 自动同步仅 chamber 宿主包；第三方手动（决策 4）；联网出网允许、registry 不限定（决策 1/3）；
- **安装期 lifecycle scripts 默认允许**（决策 13：与 ssh/桌面一致；用户明确不限制）。风险如实登记：
  安装/移除子进程与宿主插件代码以 gateway 用户执行（“已安装代码 = gateway 用户级等价”，决策 20）；
  二期硬化选项：ignore-scripts/逐包放行配置、OS 用户分离——均为二期，不默认做；
- 服务端信任 = 既有全权 auth；**不加 admission**（决策 14）：主进程确认是桌面通道纪律，
  同源前端代码可驱动 /chamber 写面 = 与既有 /chamber/runtime 动作面（select/apply-now/restart…）同级暴露，
  如实登记、不新增机制；
- 写面互斥与生命周期集成（决策 6/17）：见 §6.3；
- 「已安装」列表、域拒绝、undo/恢复 = 模型统一功能，ssh 与 gateway 后端同权（决策 10/11/19，§6.4）。

### 6.2 gateway 后端路由契约
| 路由 | 语义 |
|---|---|
| `GET /chamber/plugins` | chamber 宿主包种子缓存投影（§2.4） |
| `GET /chamber/plugins/installed` | 模型 readManifest 的 gateway 实现（packages/gateway/src/plugins-installed.ts）：`{dependencies: name→spec（file: 值以 MATERIALIZED_VALUE_MASK 掩码，保留 file: 前缀供 name 基 diff；gateway 本地路径不进 renderer）, bundles, profileExists, error?}`；scope 过滤由**模型层**做（UI 与路由同源，见 §6.7）。语义：profile 缺失 → **404** `{error:'managed profile is not initialized', code:'profile_absent'}`；解析失败 → **500** `{error:'managed profile is corrupted', code:'profile_corrupt'}`（细节仅宿主日志）；method GET-only 405；**读与写面共享栅栏** |
| `PUT /chamber/plugins/install` | body `{name, spec}`：spec 白名单族（**模型层常量单一来源在 control-plane 共享纯模块** `plugin-spec.ts`：desktop 经双路径 facade control-plane-module.ts 与打包产物同源、gateway 直接引用；渲染端 ADD_SPEC 手写镜像由**锁步测试**守护）；**保留名拒绝**（@dsh-chamber/*、seed/overlay 名与官方域，与 remove 拒绝集一致、与对话框行过滤一致）；202 异步、队列串行 + 单写者栅栏；队列忙 → 409（code 见表）；输入错 → 400；profile 缺失 → deferred；执行失败 → 任务面持久投影 |
| `PUT /chamber/plugins/materialize` | 文件夹或 `.tgz` 直推：**独立流式上传读体**（不复用 8 MiB readUploadJsonBody；≤32 MiB、413+destroy、解包大小/文件数上限防膨胀）；name/version 校验 + 保留名拒绝；落 `chamber-plugins/third-party/<escaped>/<name>-<hash>.tgz`（0700/0600/原子 no-follow）；idle → `add file:`；否则 deferred |
| `POST /chamber/plugins/remove` | body `{name}`：installed 投影内名字 + 保留名拒绝（模型层一致）；202 异步；**停机态可用**；不在 installed 名单内 → 409 `not_installed`/`no_manifest` |
| `POST /chamber/runtime/start` | 停机恢复原语（决策 12）：仅 connectionState ∈ {stopped, error, restart-exhausted} 允许；202 + status 轮询（复用 restart 语义面：start: running/ok/failed + operationError）；受守卫：canStartLocal/exposureQuarantine/恢复门（recovery phase 只开放各自 retry；restore-builtin 仅限 pending/健康选择，不得被 start 绕过）/单飞与写栅栏；语义 = 受守卫 spawn（同 startup 事务后的 startLocal 路径），失败诚实投影（不伪装成功） |
| `GET /chamber/plugins/tasks` | 任务投影 pending/running/blocked/failed[{name,error}] + 最近完成保留期；持久来源 = 操作 journal（§6.3）；投影删除 `childPid`（内部 journal 保留供崩溃对账）与 file: spec 掩码；独立端点（不并入 installed） |

错误码总表（遵循既有 `{error, code}` 蛇形约定；客户端按 status + code 组合判别）：
`invalid_input`/`invalid_name`/`invalid_spec` 400、`body_too_large` 413、`reserved` 400、
`not_installed`/`no_manifest` 409（`submitRefusalStatus` 的默认拒绝族，与 queue/runtime 拒绝一致）、
`profile_absent` = install 路径 deferred（202）/ `GET installed` 404、`profile_corrupt` = `GET installed` 500、
`queue_busy`/`queue_full`/`runtime_busy`/`runtime_pending`/`runtime_recovery_required` 409、
`too_large` 双档（执行体上传 413 / tgz 扫描 400）、`install_failed`/`remove_failed`/`start_failed`（任务面 code）、
`persistence_failed` 500。per-route 验收标准挂在 §9 矩阵的 §6.2 路由行上。

### 6.3 gateway 后端执行器与互斥
- 执行：spawn active runtime dsh CLI（resolveWorkspace）+ env `DSH_HOME=<stateDir>/dsh-home`；
  **安装子进程 env 纪律**：白名单 env（PATH+代理族，`INSTALL_ENV_WHITELIST` 由 dsh-runtime 导出共享、
  与 runtime-installer 同源），一切其它环境变量（`DSH_GATEWAY_*`、所有 npm_config_*/NPM_*、
  NODE_AUTH_TOKEN 等凭据载体）都不得进入安装子进程；XDG_CACHE_HOME/XDG_CONFIG_HOME 钉 stateDir 内私有目录
  （0700）+ 空 `NPM_CONFIG_USERCONFIG`/`npm_config_userconfig`（双大小写同指 0600 空文件——pnpm 11
  config reader 对两 casing 均做精确读取，任一 pnpm minor 都不应放行操作者真实 ~/.npmrc；
  runtime-installer 先例仅钉 HOME/XDG_CACHE_HOME + 显式 `--store-dir` argv，且其语境是**版本树安装**、
  无 profile 跨 store 问题）；
  **HOME 不钉**（钉 HOME 会把 pnpm 默认 store 移离 managed profile
  物化时所用 store，pnpm 11 以 store 不一致拒绝全部变更——profile 由 dsh 子进程引导安装，pnpm 回落
  passwd home；executor 同样回落即天然同 store。pnpm 11 中 `store-dir` 对任何 .npmrc（含 userconfig）
  均为死键，不得用 .npmrc 覆盖 store）。**部署形态约束（由此隐式成立）**：服务环境 HOME
  须缺席或等于服务用户 passwd home；不得设置 `PNPM_HOME`/`XDG_DATA_HOME`（pnpm getDataDir 优先读
  之，物化子进程继承而变更子进程被白名单剥离 → 分叉）；操作者全局 `~/.config/pnpm/config.yaml`
  storeDir 不被变更子进程读取（XDG_CONFIG_HOME 已钉私有）而物化时可能被读 → 部署勿配全局
  storeDir。以上均为操作者配置边角形态，文档登记而非代码围堵；
  **profile 内 .npmrc 视为不可信环境配置**（不向其注入令牌；脚本默认允许的裁定下，此项为凭据最小化而非脚本禁行）；
  stderr 脱敏（`sanitizeInstallerOutput` 族：URL userinfo/query 能力令牌 → origin、命名 secret 脱敏、
  绝对路径清除、≤2000 字节有界，journal error 与 tasks 投影同界）；stdout 有界；超时/取消 kill 进程组；
  变更前磁盘空闲预检（镜像 runtime disk soft-limit）；
- **生命周期 writer barrier（决策 17）**：managed profile 单写者 = runtime-manager
  `beginProfileWrite()`/`ProfileWriteLease`（count 制租约；refuse 矩阵与 `assertMutationIdle`
  在租约持有期间拒绝一切 runtime mutation）——插件队列每个
  accepted op 持一把租约、per-op 终态钩子释放（**终态钩子必须在 journal 终态写失败或记录丢失时
  仍以合成最小 terminal 记录触发**，profile-write 租约不得泄漏）；
  每次 spawn（start、restart 与健康自动重启两条路径）经 control-plane DI 缝
  `beforeSpawnCheckpoint`（local-connection.ts，**gateway 为唯一生产接线**：
  index.ts → spawn-checkpoint.ts 检查 profile-write 租约）——健康自动重启与 pnpm 写互斥（消除
  TOCTOU）；executor 在 manager dispose 之后 dispose（两 stop 路径，租约门封死间隙）；
  执行器 add/remove 前后双检 connectionState；插件串行队列与 executor 子进程纳入
  dispatch.quiesce/stop 证明（stop 杀安装子进程）；
- **写入序**：① journal pending（ts/kind/name/spec/preImage 引用/操作者标签/子进程 pid）→ ② 原子备份 package.json
  （+lockfile，两文件成对校验）到 `chamber-plugins/third-party/backups/<op-id>/`（0600）→ ③ 执行 → ④ journal
  终态（ok/failed/blocked + restart/start 结果，终态清除 childPid）；启动对账把残留 pending → failed
  （附 preImage 可恢复），并对带回 childPid 的 pending op 击杀进程组/pid（先 `-pid` 后 `pid`）；
  journal/备份保留策略（默认：最近 50 笔、**无时间窗**，备份随 op 保留、队列深度 ≤8、单 op 超时 10 分钟、
  blocked 等待上限 120s、失败可重试），队列深度/配额镜像 runtime disk 软限；
  remove 的 installed 名单**执行时**再校验（非入队时）；
- **暂存归档的生命周期**：`chamber-plugins/third-party/<escaped>/<name>-<hash>.tgz` 在 op 终态后
  **不删除**——dsh CLI 会把 `file:<staged>` 永久写进 profile manifest + pnpm lockfile，终态删除会令清单
  悬挂；submit 被拒（从未执行、无引用）与 deferred 意图清除两处仍删。boot 时机（journal 对账后、
  executor 空闲、路由尚未并发 stage）按「profile manifest file: 引用 ∪ deferred 意图 ∪ live(pending) op」
  保留集清扫无引用 `*.tgz`（`backups/` 与 `deferred.json` 不受影响；根缺失静默），有界增长 = 引用集 + 在途工作；
- deferred：ready 边沿（observeLocalState）空闲窗口排空（quarantine/激活过滤），**波浪续排**
  （队列满时等槽位再排下一波，`DRAIN_DEADLINE` 10 分钟兜底），本轮**全部**排空意图 op 终态
  （且至少一个 ok）后请求一次受控 restart（请求点不在首个 ok 终态——否则会撞上仍在途的租约被门控跳过）；
  门闭时 skip 不报错并登记；
- 安装后自动「重启生效」：apply 默认 defer=false → 队列尾自动 restart（受 C 轮询语义）；defer=true 仅落盘不重启。

### 6.4 ssh 后端收敛
ssh 后端动词映射到既有 IPC（readManifest=plugin_list、apply=plugin_apply、materialize=plugin_materialize_add_pick、
chamberProvision=seed_host_graph、restartToApply/startFromStopped=restart_service）；模型统一要求（ssh/gateway 同权，决策 10/11/19）：
- 「已安装」列表逐行移除（consistent 行缺口修复）：ssh 后端的 remove 走 plugin_apply remove；
- remove/install 保留名拒绝集合与 gateway 一致（apply 白名单之外增补官方域/chamber 域/seed 名拒绝；
  applyPlugins 主进程侧落地 + 测试）；
- undoJournal：桌面主进程侧持久化（userData 0700 JSON）+ 变更前远端 package.json 备份（cat 读 → 本地存），
  撤销 = 恢复备份 + 必要 remove；journal op 记录目标指纹（operationalFingerprint：host/user/service/home），
  undo 只认当前目标指纹一致的最近 ok op；实例删除与操作指纹变更（同 id 编辑换目标）两条路径清 journal；
- 恢复引导 UI 与 gateway 一致（r0-r4 通用文案，后端差异仅在“启动/重启”动作映射）。
改动均落在主进程/纯函数层，ssh 路径行为由既有纯测试 + 模型层测试守护。

### 6.5 桌面 IPC / 渲染层
- 模型动词经渲染层统一调用点（主进程按目标解析后端）：
  `gateway_plugin_sync(id)`（手动 chamber 宿主包同步兜底）——desktop 维护
  gateway-sync-registry.ts（ready 注册参数留存/离开 ready 与实例删除即清）、main.ts handler（id 白名单 +
  ready 复核 + `{ok:true,uploaded,skipped}|{ok:false,error}`）、preload/renderer 双镜像 + mirror golden
  （IPC 联合类型名 `GatewayPluginSyncIpcResult`，与 gateway-provider 内部同名 sync 结果 interface 区分）；
  同步失败必须显式化：GET/PUT 非 200 与网络异常返回 `{failed:true,error}` 并映射为 `ok:false`
  （「已是最新」不得吞失败）；网关 `PUT /chamber/plugins` 的校验拒绝回显脱敏原因（sanitizeRouteError，
  ≤300B）以便旧网关升级指引可见（不落裸 HTTP 400）；
  读侧经实例代理 GET `/chamber/plugins`（种子缓存投影）与 `/chamber/plugins/installed`（§6.2）驱动 chamber
  区版本漂移显示与「立即同步」（gatewaySource 门控、http+dsh 只读不变）；seed-cache 键由 wrapper
  统一加前缀一次（调用点传 raw id，禁双前缀）；
  `gateway_plugin_apply(id, {add[], remove[], defer})` / `gateway_plugin_materialize(id)`（pick-only，取消 =
  {ok:true, cancelled:true}）——全部主进程执行 + showMessageBox 确认
  （apply 默认取消）+ 经注册 origin（SPKI/隧道 Host 纪律同 syncGatewayChamberPlugins）；apply = remove 先于
  add（决策 5）+ settle-then-restart + partial 诚实（GatewayPluginApplyIpcResult）；materialize =
  本机 `.tgz` 归档或文件夹 → tarball（plugin-tarball.ts `classifyPluginPick`，容量与 gateway 路由锁步）→ 202/deferred；
  **直连 202（opId）后在桌面侧等 op 终态（tasks 轮询，1s×120s，复用 apply 的 waitForOpsToSettle）+
  请求受控重启并轮询 status**（与 apply 同一 settle 纪律），返回
  `{ok:true,outcome:{executed,restarted}} | {ok:true,deferred:true} | {ok:false,error,outcome?}`
  （outcome 仅在「已执行但重启失败」类部分失败携带）；deferred 意图即时返回（网关就绪边沿排空并自动重启一次）。
  settle/status 轮询请求必须用纯 auth 头——误带 materialize 上传的 content-length 会让网关等待不存在的 body；
  确认对话框之后、执行之前重读注册态与 ready/实例，漂移即 `ok:false`「连接在确认期间变化」，绝不按确认前快照执行；
  ssh 后端沿用既有 IPC 方法名（surface 命名属后端实现细节），并含 ssh undo journal/IPC（ssh_plugin_undo，
  撤销=恢复语义）与 SSH_PLUGIN_LIST 掩码挂接（§6.4）；
- 归档导入的选择器：local/ssh/gateway 三通道都接受**现成 `.tgz`**（npm-pack 布局）与插件源码文件夹
  （macOS NSOpenPanel 单对话框 file+folder 双模式；Windows FOS_PICKFOLDERS / GTK 无法混用 → 非 macOS 保持
  文件夹对话框，archive-pick 为 macOS-v1，Windows/Linux 腿随 design 22/23 排期）；local =
  `file:<归档绝对路径>`（allowFileSpec 通道），ssh = `materializeArchiveAndAdd`（免本地 pnpm pack，复用
  write-file → 远端 `$HOME` → `add file:`），gateway = 原样 PUT（headers 取归档自身 manifest，
  网关二次白名单）；按钮文案「从文件夹导入」→「从本地导入」（UI 键名不变）；
  **`desktop_local_plugin_add_file` 的 `{allowFileSpec:true}` 门**已接（本地文件夹/归档导入走主进程选择器），
  渲染端提交的 file: spec 仍被拒；
- **镜像面（IPC 新增写方法时的真实编辑集）**：preload.cts（方法+invoke 字面量）+ ipc-events.ts
  （3 通道）+ main.ts（3 个 trustedIpc handler）+ renderer global.d.ts +
  ipc-surface-mirror.test.ts（golden 方法/字段清单 + 结果联合形状；gateway_plugin_apply 的 batch+cancelled 联合
  需要精确形状守卫）+ connections global.d.ts（**re-export 型**，仅新命名类型落新文件时改动）——共 5 处代码 +
  1 测试 + 条件性 re-export；
- 读侧（installed/tasks/status/Loader）全经实例代理 GET。

### 6.6 UI：单一模型视图
`PluginDialog.tsx`（connections 包）是唯一插件对话框：local / ssh+dsh / gateway / http 直连四来源共用同一组件，
后端分叉仅在数据源与动作分发；区域顺序 = 诊断横幅（bannerProjection 去重）→
chamber 内建表（registry 驱动的三个宿主包行 client-graph / git-worktree / archive-cleanup，badge 化；
移动客户端行 mobile 仅 gateway 源显示、标注网关随发行物注入）→ 第三方区（已安装 + 逐行卸载 + 添加：
spec 输入 + npm 搜索 + 本地导入）→ 恢复/动作行；
http 直连只读。
- 区域语义：chamber 区（状态源 = 后端 chamberProvision/loadedFacts；
  gateway 实例停机时 Loader 不可达 → 明确的降级标签，不静默）；差异区（profile_absent → 「实例尚未初始化，
  将缓存安装意图，实例就绪后自动安装」横幅；队列/任务态文案键）；结果与失败面（partial「已完成 n/m」、
  blocked、409 逐字、任务行）；恢复面（r0-r4 文案见 §6.8）——每区 ssh 与 gateway 共用一套文案与流程，
  仅执行来源不同；
- 「失败即停」与 ssh 逐行 materialize 隔离在模型层给出**单一定义**（批量内 registry/remove 失败即停；
  逐行 materialize 保持隔离，与 AGENTS 单实体失败不阻塞原则一致，文案如实呈现）；
- **变更记录区不渲染 task 行**（后端 journal/备份保留，journal 仅供 undoForLatest 派生）；撤销恢复化
  **仅 gateway**（runtimeDown（stopped/error/restart-exhausted）且 undoForLatest 有动作时在恢复横幅显示
  恢复撤销入口）；ssh list tab 的「撤销最近变更」按钮保留原样——登记为范围偏差（见 §7）；
- **第三方行生效状态**：local/gateway/http 已安装列表含「生效状态」chips（Loader pluginInventory 快照按
  moduleName===包名匹配：生效中/加载中/加载失败/已停用/重启后生效；本地实例经 /api/i/local 读快照，
  读失败静默置中性——清单文件永远不作 live 断言）。快照无条目时仅 bundle-layer 行
  （localList.bundles / installed.bundles）显示「重启后生效」，plain/client-only 依赖状态格中性
  （dsh plugin add 只把声明 dsh.bundle 的包提升为 layer，防「重启也不会生效」的假承诺）；
  gateway 导入成功文案按 outcome 区分（materializeLive / restartNeededHint / deferredOfflineNote）；
  local add/import 成功不谎报「已应用」（只改本地 profile，重启后挂载）；ssh doApply 成功后自动重载已安装列表；
- ssh 分支默认不呈现整盘 diff 表：与 gateway/local 同骨架的主视图（已安装列表 + 添加区 + 范围注），
  legacy diff 折叠为「与本地插件组合存在 {n} 处差异 — 展开对账」次级入口；展开后 rows/filter/apply/undo
  语义与按钮逐字保留，应用动作仅在展开态出现在 footer（纯模型层与后端行为不变，仅默认呈现与入口层级改变）；
- A 键表（zh/en；类型门锁 zh/en，代码↔键覆盖靠实现清单）：partial/blocked/queue_busy 文案、
  多桌面移除确认、他人会话中断（C 复用）、deferred 离线执行确认（「将缓存并在实例就绪后自动安装，可能在你
  断开后执行」）、task 行（pending/running/blocked/failed + 上次失败）、preImage 恢复（撤销最近变更）文案、
  journal 横幅、停机态动作文案、startFromStopped 文案、profile_corrupt 恢复引导、保留名拒绝文案、who/when
  归因 tooltip（「由 <连接 label> 于 <时间> 安装/移除」，未知时「另一桌面」）。
  **已知余留**：who/when 归因 tooltip 尚未渲染（TaskRow 未投影 initiator）；预置未用键
  （blockedTask/queueBusy/lastFailedHint/reservedNameRefused/opAttribution*/startManagedDshConfirmTitle）
  待归口接线或删除；gateway 拒绝码→本地化文案映射未做（409 逐字英文，登记接受）——见 §7。

### 6.7 安全模型
- 既有全权 auth；渲染层不持凭据（主进程注入）；**主进程确认 = 桌面通道纪律（不加服务端 admission，决策 14）**；
- 写面：spec/name 白名单族单一来源（control-plane 共享模块）+ 渲染镜像锁步测试；保留名拒绝（模型层一致）；
  单写者栅栏 + 生命周期排空（决策 17）；日志脱敏（凭据零进入，含 npm 令牌类环境）；
- 信任声明（决策 20）：「已安装代码 = gateway 用户级等价」（进程隔离 ≠ 主体隔离；同用户可读 stateDir 0600
  jwt-secret 等）；scripts 默认允许（决策 13）风险登记；二期硬化：ignore-scripts/逐包放行、OS 用户分离；
- 多桌面：last-writer-wins + 队列串行 + 移除确认（全局影响文案）+ who/when 归因（连接 label 级，不进日志）；
- 移动例外不参与；future per-principal 角色扩展时，插件写路由与 runtime 写路由同属 operator-scope（18 先例）。

### 6.8 故障域与恢复
- 故障域：插件代码执行在托管 dsh 实例进程/前端（进程隔离）；/chamber 管理面挂宿主、非 ready-gated——实例崩
  溃/停机时管理面存活；可能伤宿主的仅：机器级资源、安装期脚本（默认允许下以 gateway 用户执行）、profile
  元数据损坏——逐类登记（r3/r4 域）。
- 分层兜底：client 插件页面级（Loader fiber failed）；host 插件进程级（健康自动重启窗口 → restart-exhausted）；
  装完即崩（非 env 源自动回退 known-good + dsh-home 快照恢复 = 重锤，插件级轻恢复优先）；corrupt →
  profile_corrupt；seed（chamber 宿主包/移动端 extraneous + 每次 spawn 前 seed thunk 自愈，免疫）。
- 恢复阶梯（用户可见文案 + 动作均双后端同权）：
  - **r0 实例存活**：视图列表/diff 移除 → 「重启 dsh」（C）生效；
  - **r1 停机（stopped/error/restart-exhausted）**：停机态移除（执行窗口含停机态；installed 纯文件读）→
    **「启动实例」= start 原语（决策 12）**——卡片/视图给出明确动作 + 文案「已移除 <name>，正在重新引导…」；
    失败 → 诚实回 error + 提示（可再次移除/查看连接日志）；ssh 后端同动作映射 restart_service；
  - **r2 profile 损坏（profile_corrupt）**：视图横幅（journal 最近一笔 + 「撤销最近变更」）→ 停机 → preImage
    回滚（两文件成对校验）→ 残留名字 remove → start/restart；无备份（外部损坏）→ **正确兜底链**：
    restore-builtin **不能**治愈 corrupt profile（它探同一 dsh-home——restoreBuiltin 走共用
    `executeStartupTransaction`，dsh-home 不随目标版本更换）——兜底改为
    operator runbook（从 `<stateDir>/dsh-runtime/snapshots/` 手工恢复 dsh-home 快照）；可选恢复路由列二期；
  - r3 脚本风险：登记（决策 13/20），恢复阶梯不承诺覆盖安装在 dsh-home 之外的持久物（cron/rc 等）——如实说明；
  - r4 宿主不可达：机器级 runbook；二期提供 `gateway plugin` 操作员子命令（list/remove/rollback 复用同一
    executor+journal 核心；现 CLI 除 serve 外只有 auth 操作子命令 status/reset-password/clear）；
- 恢复判据：视图「已加载」Loader 事实行 + 状态行（重启前 active / 移除后消失）为细节证据；成功文案用自然语言
  （「已移除 X，实例已重新就绪」），不把 Loader 行当面向用户的判据。

### 6.9 工程默认与配额
- 202 异步 + 任务面；队列深度 ≤8、单 op 超时 10 分钟、blocked 等待上限 120s
  （`CAN_RUN_WAIT_MAX_MS=120_000`，plugins-exec.ts）、journal 最近
  50 笔（无时间窗）、上传前磁盘预检；文件夹 ≤32 MiB 独立流式路由 + 解包上限（≤4096 文件/解压 ≤256 MiB）；
  保留名/scope 拒绝模型层单一实现；tasks 独立端点（不并入 installed）；执行窗口含停机态；
  暂存 tgz 保留语义见 §6.3。

### 6.10 明确不做
http+dsh 直连插件管理（无执行后端）；gateway 编排面回流；控制面实现执行面；非插件资产远程写；
chamber 移动端参与第三方管理；安装期脚本默认禁行与 OS 用户隔离（二期硬化，非 v1）。

## 7. 决策遗留 / 开放项
- scripts 默认允许下的 env 最小化实测：`dsh plugin add` 的 pnpm 是否读取 profile/.npmrc、是否向
  子进程暴露 npm 令牌环境——据实收紧 §6.3 纪律（实测结果可回调，不允许扩大暴露）；
- 恢复路由（snapshot restore）进 v1 与否（默认二期，r2 走 runbook）；
- journal 操作者归因的 UI 呈现粒度（默认 tooltip 级；当前未渲染，见 §6.6 已知余留）；
- ssh 端 `plugin_apply` / `seed_host_graph` / `materialize_add(_pick)` 的主进程确认对话框缺口
  （design 13 §7.0 的设计意图；确认链只覆盖 gateway apply/undo 与 ssh undo）——补齐并登记；
- 计划要求的实机 E2E 矩阵（ssh+gateway 双通道手动/脚本化门禁）未勾销——发布前在可运行环境按 §9 执行；
- archive-pick 的 Windows/Linux 腿（非 macOS 保持文件夹对话框）随 design 22/23 排期；
- 已发布 gateway 发行树的 `dist/index.js` 可能仍是旧的 executor env pin（重装/重打包即复发）——正式修复须
  随 HEAD 版本树部署后按 §9 矩阵复跑；
- gateway 拒绝码→本地化文案映射未做（409 逐字英文，登记接受）；预置未用键待归口接线或删除（§6.6）。

## 8. 与既有文档的关系
- design 13 是 ssh 后端既有行为的权威契约；本文是模型与双后端契约的收敛权威（§3）——ssh 面新增能力
  （已安装列表逐行移除、保留名拒绝、undo journal、清单掩码）落在 design 13 §6/§7；
- design 17：§3 能力表含第三方插件管理行与 dsh 直连（ssh/http）不挂载 dsh-runtime 分节；`/chamber/plugins/*`
  写面与 §10 编排面剥离后的存活面一致；§4.1/§12 生命周期 writer barrier 语言含插件队列与 executor 子进程；
- design 18：§6 出网面登记“安装子进程随宿主受控出网”（决策 1）；§9.3 含 `start` 原语行、connections 入口、
  插件写互斥矩阵（含 beforeSpawnCheckpoint）与 restart-exhausted 自动回退衔接；
- design 05 §5：内容清单（日志命名、重启/启动按钮、单一模型视图与已安装列表、恢复提示行）；
- design 02：seed 与 spawn 语义（§2.4）。

## 9. 验证与测试矩阵
- B/C：test:connections（纯投影/门控/结果分类）、typecheck:connections、verify:i18n（仅 README 对）；
  共享模块：test:sidebar + test:settings-bridge（文件随迁/拆 split/清单同步；renderer-shell 无迁移项）；
- 模型层（纯 node 无依赖）：intent 构建（remove 先 add/defer/勾选保留）、结果分类
  （partial/blocked/cancelled）、task 投影 → 行模型、后端分派表（含不支持组合）、journal 状态机与启动对账
  幂等（fake fs）、执行窗口 × 动作 × 在飞标志门矩阵（镜像 remoteRuntimeActionGates）、串行队列模型、
  executor 注入式 spawn（exit-code 夹具 + env 纪律断言）、白名单/保留名（control-plane 单一来源在 gateway+desktop
  双跑 + 渲染镜像锁步测试）、pollGatewayReady 用例；
- A gateway 子矩阵：spec 白名单族/保留名拒绝/202 异步/批量 partial/remove 只删 installed 集内且执行时复核/
  profile_absent → deferred/profile_corrupt → preImage 回滚（原子对）/queue_busy/queue_full/start 原语（停机态门 + 恢复门
  不被绕过 + 202/poll + 失败诚实）/上传流式上限与解包/任务面持久与对账（含投影无 childPid、file: spec 掩码）/
  读面栅栏一致/磁盘预检/生命周期排空
  （dispose/quiesce/stop kill 子进程测试）；并发强度以**慢关 spawn + 租约时序**证明（microtask-close 夹具
  测不到波浪续排与 queue_full）；
- 恢复面：停机态 remove/install、start 闭环、corrupt 回滚、journal 幂等、一致行移除回归（ssh/gateway）、
  故障注入（坏插件 boot 失败 → restart-exhausted → 停机移除 → start 恢复；corrupt → preImage 回滚）；
- desktop：gateway-provider/plugin-sync 扩展（上传+确认+取消 no-op+SPKI/--no-auth/隧道 Host 四态）、
  ipc-surface-mirror/golden + main handler 清单、ssh 统一增量（已安装列表 remove/保留名拒绝/journal 备份）单测；
- 实机门禁（发布前）：真实 gateway + 打包 desktop 全闭环、TLS+SPKI、多桌面、registry 实装（传递依赖网络 +
  lifecycle scripts 实测行为）、文件夹上传、partial、deferred、start 恢复、故障注入；scripts/env 实测结果回调
  §6.3 纪律（§7 门禁）。
