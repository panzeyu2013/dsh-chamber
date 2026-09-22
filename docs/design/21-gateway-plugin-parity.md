# 21 · 统一插件管理模型与 gateway 连接对齐

> **状态：现行（单一插件管理模型（ssh/gateway 双后端）+ B/C 连接页接线，2026-12）**——插件管理全仓只有一份模型（UI、流程、差异语义、状态机、文案、恢复），ssh 与 gateway 是同一模型下的两个执行后端，分叉只发生在最终执行阶段；本文是模型与双后端契约的收敛权威，ssh 后端既有行为权威在 design 13。未完成门禁见 docs/progress/STATUS.md。
>
> 相关设计：13（ssh 远端插件管理）、17（gateway 形态与 /chamber 面）、18（runtime 管理）、05（连接设备页）、02（seed 与 spawn 语义）；与 13/17/18/05 的关系见 §8，02 的 seed/spawn 语义关系见 §2.4。

## 1. 目标与决策

三个用户诉求（来自 connections 连接设备页）：**A** gateway 连接缺 ssh+dsh 那样的第三方插件「添加/同步/移除」闭环（“使用 gateway 功能反而退化”）；**B** gateway 卡上「日志 / 主机日志」两个入口无法区分；**C** connections 页缺 gateway「重启 dsh」按钮（runtime 受控重启机制已就绪，连接页无入口）。

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
| 18 | 掩码语义 | gateway readManifest 的远端**路径类值一律掩码**（`MATERIALIZED_VALUE_MASK`，单一来源 = control-plane `PLUGIN_MATERIALIZED_VALUE_MASK`，保留 `file:` 前缀供 name 基 diff 与分类器；2026-12 review 起判据是共享的 `isMaterializedValue`，不再只掩 `file:` —— `link:`/相对/绝对/`~` 同样会暴露机器本地路径）。**已知偏差**：ssh 清单已挂接掩码（`redactRemotePluginManifest`，plugin-sync.ts）；本地 LOCAL_PLUGIN_LIST 仍**原样透传**（本地绝对路径可进 renderer，`dependencies` 与 §6.11 新增的 `rows[].spec` **两个通道**都是）——本地侧 `redactLocalPluginManifest` 已同步掩 `rows` 但仍零生产调用点，登记在 STATUS |
| 19 | 受保护集合（**2026-12 修订；用户拍板**） | 拒绝集**不再按域名前缀猜**，改由**派生的受保护集合** `P = B₀ ∪ S ∪ F` 按事实判定（§6.11）：`B₀` = profile 安装自带组合（模板默认快照，**不含**用户后加的层）、`S` = `CHAMBER_HOST_PACKAGES` 播种名、`F` = 运行时线族（**已提交**的 `packages/desktop/vendor/dsh/pnpm-lock.yaml` 闭包中的 `@deepseek-ai/*`）。判定按 op 分相：**install / remove 同判 P，remove 永不判版本**；官方 scope 的 install 另需**精确同代**（无版本、`^`/`~`/dist-tag 一律拒；预发布必须字符串全等）。官方 opt-in 层（`@deepseek-ai/dsh-experimental-*`）不在 P 内 ⇒ 可装可卸，**其依赖闭包同样不在 P 内**：闭包里的族外官方 scope 名不因 `outside-family` 判违例（闭包口径见 §6.11.4）。渲染端**不再持有镜像谓词**，改由投影行 `role`/`protected` 驱动（§6.2/§6.6/§6.7）。ssh 的 F 无远端源 ⇒ 装面保守、卸面按 `B₀ ∪ S` 判（design 13） |
| 20 | 信任声明 | “已安装代码 = gateway 用户级等价”（进程隔离≠主体隔离）；OS 用户分离列二期硬化 |

## 2. 插件管理基线（本地 / ssh 远端 / UI / 宿主包 seed / 受控重启）

### 2.1 本地 profile 插件管理
`desktop_local_plugin_list / add / add_file / remove`；主进程 `runLocalDshPlugin`（desktop/plugin-sync.ts）固定 argv 执行 `dsh plugin add <spec>` / `add file:<path>` / `remove <name>`，showMessageBox 确认，取消 = `{ok:true, cancelled:true}`（design 13 §5/§7.0）。本地清单 = 读本地 `<home>/profiles/web/package.json` 依赖投影 + 分类 + chamber 注入态版本。

### 2.2 ssh 远端插件管理
`desktop_ssh_plugin_list / plugin_apply / seed_host_graph / plugin_materialize_add(_pick)`、`restart_service`——插件 exec 面（list/apply/seed/materialize）仅服务 `{kind:'dsh', transport:'ssh'}`（main.ts 门控、design 13 §1）；systemd exec（含 restart_service）**只按 ssh transport 门控**、gateway-over-ssh 亦可用（§3）。远端清单 = ssh cat 远端 profile
package.json → `parseRemoteManifest` 投影（**原始 spec 值**，plugin-sync.ts）；差异由 `computePluginDiff`
计算；apply = 主进程二次白名单 → 远端 `dsh plugin add/remove`（registry spec 或 materialize `add file:`），
remove 先于 add、可 defer 重启；write-file 上限 50 MiB；spec/name 白名单常量单一来源 = control-plane 共享纯模块 `plugin-spec.ts`（desktop 经双路径 facade 消费），渲染端 ADD_SPEC 为**锁步测试守护的手写镜像**（§6.2）；受保护集合 `P` 的判定与投影见 §6.11（单一来源 = control-plane `protected-plugins.ts`，与 `plugin-spec.ts` 同族）。

### 2.3 插件管理 UI
四个来源（本地 / ssh+dsh / gateway / http 直连）共用 `PluginDialog`（`PluginDialog.tsx`，§6.6；旧 `PluginSyncModal`/`PluginInventoryView` 已删），卡片按 `target.kind` 把数据源喂给同一对话框；gateway/http 直连区**非只读**：含已安装行/移除/撤销/restart 面板/tasks 投影/sync 状态（http 直连无可执行后端，只读）。`plugin-diff.ts` 纯函数族（missing/update/extra/materialize/unsyncable/consistent——**无 scope 逻辑**；受保护行过滤在**输入侧**，见 §6.11：`computePluginDiff` 只吃第三方/materialize 行）、plugin-inventory-text/plugin-diagnostic 纯投影（thirdPartyEntries 过滤 @deepseek-ai/* + chamber 注册表包（含 archive-cleanup），并排除调用方传入的注册表派生 expected 名单（仅 Loader 已加载事实层）——**这两个前缀分类器是 Loader 清单的展示分类，不是安装门，随 §6.11 落地后继续保留**）。测试 = connections 纯模块文件，**无组件级测试**。「chamber 内置（注入）」表行集不写死包名，由控制面 `CHAMBER_HOST_PACKAGES` 经 desktop IPC 投影（`chamber.packages[]`）驱动，UI 逐行映射；`remoteNeedsSeed`/重启提示/seed-cache 漂移/同步包表同样逐包派生（design 13 §6）。行派生收敛为纯函数 `deriveChamberRows`
（plugin-inventory-text.ts，只回 label KEY 与版本 STRING，组件只做 descriptor→JSX 映射），
由 `test/plugin-inventory/chamber-rows.test.ts` 表驱动测试覆盖（含 LOCAL 目标读自身清单、空 expected 不谎报 seed-cache、gateway 客户端行由 Loader inventory 分类派生、inventory 不可用时 unknown 行而非写死包名）。

### 2.4 chamber 宿主包同步与 seed
桌面 ready 自动 `syncGatewayChamberPlugins`（gateway-provider.ts；main.ts 装配）；gateway `PUT/GET /chamber/plugins` 白名单三包缓存（`dsh-chamber-seed-client-graph`、`dsh-chamber-seed-git-worktree`、`dsh-chamber-seed-archive-cleanup`（design 24）；plugins.ts 白名单 + 大小上限；0700/0600/原子 no-follow；上传读体 8 MiB 上限在 routes.ts `readUploadJsonBody`，非 plugins.ts）；seed = extraneous + patch overlay（不进 package.json，control-plane/index.ts），每次 spawn（`start`/`restart` + 健康自动重启）前 seed thunk 重求值自愈（02 §2.6）；激活探针期望集按实际同步包
逐包派生（`syncedHostDomainProbeNames` → `activationProbeNamesForDomains`；无二元
`hasSyncedHostSeed` gate——空缓存 = 基础缩减集，部分同步 = 已挂载域）；
移动端 `dsh-chamber-client-ui-mobile` = 唯一随 gateway 发行物打包 seed 的 chamber 客户端插件（17 §3/§10.2）。

### 2.5 gateway 运行时受控重启
`POST /chamber/runtime/restart`（dispatch 无条件挂载、非 ready-gated；**仅 ready/degraded 可重启**；202 + status 轮询 restart running/ok/failed + operationError，resolve≠success，18 §9.3）；单飞 = manager 标志 + route 409 + restartLocal 与健康重启共用串行化（local-connection.ts）；**激活事务**（startup/apply-now/restore-builtin/回退路径）快照/回退覆盖整棵 dsh-home（runtime-manager.ts `snapshotDshHome` 全树拷贝；`/restart` 本身 = restartLocal 受控 spawn、**无快照**）；settings dsh-runtime 段 gateway 分支经 renderer fetch + `pollGatewayReady`。停机/错误/restart-exhausted 的恢复原语是 `/chamber/runtime/start`（决策 12，§6.2）；`restartLocal` 本身拒绝 stopped/error/restart-exhausted。

## 3. 一致性原则：单一模型，末段执行分叉

> **收敛为一个插件管理模型**（UI、流程、差异语义、状态机、文案、恢复能力全部只有一份），不是“两个通道各一套同权功能”；ssh 与 gateway 是该模型下**两个执行后端**，分叉只发生在**最终执行阶段**；任何界面/逻辑层不得出现“if gateway … else if ssh …”的功能分叉，分叉只允许出现在后端实现内部。

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

**后端矩阵**：local（本地 profile，list+add 语义）、ssh（model 动词 + 已安装列表逐行移除/**受保护集合判定**（装面保守、卸面按 `B₀ ∪ S`）/undo journal）、gateway（§6.2/§6.3）、http+dsh 直连（无执行后端——无 /chamber、无 ssh exec、无管理面（17 §3），只读保留，无法也不应“一致”）。

**目标语境差异**：gateway+ssh 卡的 systemd 「重启实例」按钮属**连接管理面**（重启 gateway 服务本身），保留并改 tooltip/文案区分（B/C 章节）；插件模型内无其他按目标的分叉。

## 4. B · 日志入口可区分

gateway 卡「主机日志」与「日志」并列、插件入口同形、Modal 标题只差前缀——三者互相不可区分。

方案：环形缓冲入口与 Modal 标题「日志」→「连接日志」（说明行：本机侧连接通道事件：隧道/探针/握手验证等
连接过程记录，用于排查连接问题——覆盖 http 直连）；gateway 卡「主机日志」→「网关主机日志」（服务器侧
gateway 进程与托管 dsh spawn 日志）；本地卡折叠区「主机日志」不改名；service 行 Checklist（状态行）保留，但与两个日志入口视觉上明确区分（插件入口改图标后 Checklist 仅剩 service 行与日志入口——日志入口一并换图标）。
图标：插件入口（本地+远端）→ IconFolderOpenOutline16；连接日志入口 → IconSearchOutline16；网关主机日志保留
IconDataOutline16；service 行保留 IconChecklistOutline14（状态行）。图标取仓内既有 primitives 导出（IconFolderOpenOutline16/IconSearchOutline16，先例 sidebar vendor-modules.d.ts）；换点：import + 按钮 + ambient 一行。键名稳定（logs/hostLogs 改值不改键），新增 gatewayHostLogs/logsModalHint/gatewayHostLogsModalHint；zh 源 + en 镜像，词典一致性由 typecheck（`Record<keyof typeof zh>`）保证；README 双语变更需重录 README.i18n.yaml 哈希。B 以键名 + 文案 + 图标三重区分交付。

## 5. C · gateway「重启 dsh」入口

### 5.1 位置与门控
gateway 卡连接/断开按钮旁文本按钮「重启 dsh」，仅 phase ∈ {ready, degraded} 可用，busy[id] 禁用；统一插件模型视图（对话框）chamber 区/动作条提供「重启生效」（同动作）。gateway+ssh 卡 systemd「重启实例」（重启 gateway 服务本身）保留，其 tooltip 注明「重启 gateway 服务（systemd）」，且**两按钮并排文案可见区分**（label 级，非仅 tooltip）；卡片 268px 网格宽度紧张时 systemd 起停并入 foot 图标。多用户文案（P1）：gateway 通道的重启/应用确认必须注明「该 Gateway 上的其他用户会话也会短暂断开」（ssh pluginsRestartWarning 语义的通道加强变体）；该文案在 connections 卡片重启确认与 settings-bridge runtime 段 gateway 源重启确认（专用键 `dshRuntimeRestartGatewayConfirm`，zh/en 成对、含多用户中断披露）两处落地，视图面板「重启生效」为直发动作（不弹确认）。确认 Modal 后：`POST /api/i/gateway-<id>/chamber/runtime/restart`，
仅 202 接受；409/400 → body.error 逐字。轮询语义与 `pollGatewayReady` 精确一致（1s/120s；restart failed /
connectionState ∈ {error, restart-exhausted, stopped} 失败；'ok' 或旧网关 ready/degraded 回退；401/403/404 快失败；超时诚实投影）。每卡单飞（per-id）；成功/失败刷新卡片与视图 Loader 清单。桌面零改动（既有反代，auth 主进程注入）。

### 5.2 共享模块迁移
split 而非 move：`gateway-runtime-api.ts` 中仅 parse/action/gates/error 分类/poll 为纯核心；`remoteRuntimeStatusView` + `RemoteRuntimeStatusView` 引用 SettingsBridgeKey **留在 settings-bridge**（与 REMOTE_PHASES/BLOCKED_PHASES 共享部分以 shared 导出形式回引）。纯核心 + `gateway-runtime-poll.ts` 迁
`@dsh-chamber/dsh-chamber-client-ui-sidebar/shared`（exports "./shared" → src，免构建；renderer/settings-bridge/
connections/layout/git 均为既有消费者；vite 共享单实例）。**不设手写 ambient 镜像**：消费者对**真源**做
typecheck——root tsconfig `paths`（`@dsh-chamber/dsh-chamber-client-ui-sidebar/shared` → 真实
`src/shared/index.ts`）供 git/layout/connections/renderer 继承（各 tsconfig 补 `rootDir: "../.."` 避免
TS6059）；settings-bridge 保留自身 connections-section paths、经 workspace 链接 + sidebar
`exports["./shared"]` 解析。`RemoteRuntimeStatus`（33 字段，30 必填+3 可选）/parse/gates/
Error/poll 符号随 shared 真源直接可见，无需镜像同步。
poll 的英文错误串随迁（connections 会显示未本地化文案，登记接受——见 §7）。**测试**：pollGatewayReady 用例驻 settings-bridge/test/runtime/runtime-management.test.ts；`gateway-runtime-api.test.ts` 按 split 拆（view 留 settings-bridge，核心随迁）；settings-bridge/sidebar 两个 test 清单同步；test:renderer-shell 无迁移文件（测试矩阵见 §9）。

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
- 边界口径取决策表 1/3/4/13/14/20（自动同步仅 chamber 宿主包）；写面互斥与生命周期集成（决策 6/17）见 §6.3。
- 「已安装」列表、**受保护集合判定**、undo/恢复 = 模型统一功能，ssh 与 gateway 后端同权（决策 10/11/19，§6.4）；「同权」指**动词与投影同权**：判定规则逐后端可不同（gateway/local 全功能；ssh 装面保守），但规则本身是同一份 `P` 的定义与同一条 op 分相矩阵（§6.11），不得各自发明拒绝集。

### 6.2 gateway 后端路由契约
| 路由 | 语义 |
|---|---|
| `GET /chamber/plugins` | chamber 宿主包种子缓存投影（§2.4） |
| `GET /chamber/plugins/installed` | 模型 readManifest 的 gateway 实现（packages/gateway/src/plugins-installed.ts）：`{dependencies: name→spec（路径类值以 MATERIALIZED_VALUE_MASK 掩码，保留 file: 前缀供 name 基 diff；gateway 本地路径不进 renderer）, bundles, rows: PluginRow[], profileExists, error?}`（**加性**：`dependencies` 语义不变，`rows` = §6.11 的读面投影 `{name, spec\|null, version\|null, role, protected, owner?}`）；受保护集合由**服务端**计算并投影（服务端是 gateway 目标的判定权威，§6.11）。语义：profile 缺失 → **404** `{error:'managed profile is not initialized', code:'profile_absent'}`；解析失败 → **500** `{error:'managed profile is corrupted', code:'profile_corrupt'}`（细节仅宿主日志）；method GET-only 405；**读与写面共享栅栏**：写面在飞（执行器忙或有 journal `pending` op = profile-write 租约持有期间）→ **409 `runtime_busy`**（可重试，与 /chamber/runtime 的租约拒绝同码；deferred 意图无写者、不算在飞，停机态 read 照常 200/404） |
| `PUT /chamber/plugins/install` | body `{name, spec}`：spec 白名单族（**模型层常量单一来源在 control-plane 共享纯模块** `plugin-spec.ts`：desktop 经双路径 facade control-plane-module.ts 与打包产物同源、gateway 直接引用；渲染端 ADD_SPEC 手写镜像由**锁步测试**守护）；判定码的**本地化文案未做**：渲染端逐字显示服务端 `error`（§7 已登记）；**受保护集合判定 + 代耦合**（§6.11：`name ∈ P` → 400 `protected`；官方 scope 无版本 / `^`·`~`·dist-tag → 400 `needs-version`/`needs-exact-version`（回填建议 `@<runtimeVersion>`）；版本与实例运行时跨代（预发布必须全等）→ 400 `generation-mismatch`；F 读不到 → 503 `protected-set-unavailable`）；202 异步、队列串行 + 单写者栅栏；队列忙 → 409（code 见表）；输入错 → 400；profile 缺失 → deferred；执行失败 → 任务面持久投影；**装后复验**（§6.11.4 两段：先版本——F 名字按运行时提供的版本集合判，后闭包——非 F 名字在用户层闭包内则豁免；违例 = op 响亮失败 + preImage 保留；v1 自动回滚见 STATUS） |
| `PUT /chamber/plugins/materialize` | 文件夹或 `.tgz` 直推：**独立流式上传读体**（不复用 8 MiB readUploadJsonBody；≤32 MiB、413+destroy、解包大小/文件数上限防膨胀）；**归档身份绑定**（2026-12 review：扫描时**有界捕获**包内 `package/package.json`，要求与 `x-plugin-name`/`x-plugin-version` **逐字相等**，否则 400 `identity_mismatch`；无 manifest/超大/不可解析 → 400 `tgz_invalid`）——否则"自称第三方的包，真名是官方受保护名"会作为**直接依赖**落地，绕过装后复验的直接依赖豁免；name/version 形状校验 + **受保护集合判定与官方 scope 代校验**（§6.11：判定用 header 的 `name` + `version`，registry 路径的 spec 语法在这里不适用）；落 `chamber-plugins/third-party/<escaped>/<name>-<hash>.tgz`（0700/0600/原子 no-follow）；idle → `add file:`；否则 **deferred（意图持久化 name/spec/version，drain 时重投）** |
| `POST /chamber/plugins/remove` | body `{name}`：installed 投影内名字 + **受保护集合判定（只判 `name ∈ P`，remove 永不判版本）**（§6.11）；202 异步；**停机态可用**；不在 installed 名单内 → 409 `not_installed`/`no_manifest` |
| `POST /chamber/runtime/start` | 停机恢复原语（决策 12）：仅 connectionState ∈ {stopped, error, restart-exhausted} 允许；202 + status 轮询（复用 restart 语义面：start: running/ok/failed + operationError）；受守卫：canStartLocal/exposureQuarantine/恢复门（recovery phase 只开放各自 retry；restore-builtin 仅限 pending/健康选择，不得被 start 绕过）/单飞与写栅栏；语义 = 受守卫 spawn（同 startup 事务后的 startLocal 路径），失败诚实投影（不伪装成功） |
| `GET /chamber/plugins/tasks` | 任务投影 pending/running/blocked/failed[{name,error}] + 最近完成保留期；持久来源 = 操作 journal（§6.3）；投影删除 `childPid`（内部 journal 保留供崩溃对账）与 file: spec 掩码；独立端点（不并入 installed） |

错误码总表（`{error, code}` 蛇形约定；客户端按 status + code 组合判别）：`invalid_input`/`invalid_name`/`invalid_spec` 400、`body_too_large` 413、`invalid-name` 400（名字形状守卫，与 `invalid_name` 同义）、`protected`/`needs-version`/`needs-exact-version`/`generation-mismatch` 400（§6.11 判定码；**降级码 `protected-set-unavailable`：400（local/ssh）或 503（gateway，可重试）；`runtime-version-unknown` 400**；**旧码 `reserved` 退役**——新服务端不再产生，客户端解读**旧 gateway** 响应时仍须接受并映射同一组文案）、`not_installed`/`no_manifest` 409（`submitRefusalStatus` 默认族）、`profile_absent` = install 路径 deferred（202）/ `GET installed` 404、`profile_corrupt` = `GET installed` 500、`queue_busy`/`queue_full`/`runtime_busy`/`runtime_pending`/`runtime_recovery_required` 409、`too_large` 双档（执行体上传 413 / tgz 扫描 400）、`tgz_invalid`/`too_many_entries`/`identity_mismatch` 400（materialize 归档）、`install_failed`/`remove_failed`/`start_failed`（任务面 code）、`persistence_failed` 500。per-route 验收标准挂在 §9 矩阵的 §6.2 路由行上。

### 6.3 gateway 后端执行器与互斥
- 执行：spawn active runtime dsh CLI（resolveWorkspace）+ env `DSH_HOME=<stateDir>/dsh-home`；**安装子进程 env 纪律**：白名单 env（PATH+代理族，`INSTALL_ENV_WHITELIST` 由 dsh-runtime 导出共享、与 runtime-installer 同源），一切其它环境变量（`DSH_GATEWAY_*`、所有 npm_config_*/NPM_*、NODE_AUTH_TOKEN 等凭据载体）都不得进入安装子进程；XDG_CACHE_HOME/XDG_CONFIG_HOME 钉 stateDir 内私有目录（0700）+ 空 `NPM_CONFIG_USERCONFIG`/`npm_config_userconfig`（双大小写同指 0600 空文件——pnpm 11 config reader 精确读两 casing，不应放行操作者真实 ~/.npmrc；runtime-installer 先例仅钉 HOME/XDG_CACHE_HOME + 显式 `--store-dir` argv，其语境是**版本树安装**、无 profile 跨 store 问题）；**HOME 不钉**（钉 HOME 会把 pnpm store 移离 profile 物化所用 store，pnpm 11 以 store 不一致拒绝变更；executor 与 profile 引导同回落 passwd home 即天然同 store；`store-dir` 对任何 .npmrc（含 userconfig）均为死键，不得用 .npmrc 覆盖 store）。**部署形态约束（由此隐式成立）**：服务环境 HOME 须缺席或等于服务用户 passwd home；不得设置 `PNPM_HOME`/`XDG_DATA_HOME`（pnpm getDataDir 优先读
  之，物化子进程继承而变更子进程被白名单剥离 → 分叉）；操作者全局 `~/.config/pnpm/config.yaml`
  storeDir 不被变更子进程读取（XDG_CONFIG_HOME 已钉私有）而物化时可能被读 → 部署勿配全局
  storeDir。以上为操作者配置边角形态，文档登记而非代码围堵；**profile 内 .npmrc 视为不可信环境配置**（不注入令牌；脚本默认允许下此为凭据最小化而非脚本禁行）；
  stderr 脱敏（`sanitizeInstallerOutput` 族：URL userinfo/query 能力令牌 → origin、命名 secret 脱敏、
  绝对路径清除、≤2000 字节有界，journal error 与 tasks 投影同界）；stdout 有界；超时/取消 kill 进程组；
  变更前磁盘空闲预检（镜像 runtime disk soft-limit）；
- **生命周期 writer barrier（决策 17）**：managed profile 单写者 = runtime-manager `beginProfileWrite()`/`ProfileWriteLease`（count 制租约；refuse 矩阵与 `assertMutationIdle` 在租约持有期间拒绝一切 runtime mutation）——插件队列每个 accepted op 持一把租约、per-op 终态钩子释放（**终态钩子必须在 journal 终态写失败/记录丢失时仍以合成最小 terminal 记录触发**，租约不得泄漏）；每次 spawn（`start`、`restart` 与健康自动重启两条路径）经 control-plane DI 缝
  `beforeSpawnCheckpoint`（local-connection.ts，**gateway 为唯一生产接线**：
  index.ts → spawn-checkpoint.ts 检查 profile-write 租约）——健康自动重启与 pnpm 写互斥（消除
  TOCTOU）；executor 在 manager dispose 之后 dispose（两 stop 路径，租约门封死间隙）；执行器 add/remove 前后双检 connectionState；插件串行队列与 executor 子进程纳入 dispatch.quiesce/stop 证明（stop 杀安装子进程）；
- **写入序**：① journal pending（ts/kind/name/spec/preImage 引用/操作者标签/子进程 pid）→ ② 原子备份 package.json
  （+lockfile，两文件成对校验）到 `chamber-plugins/third-party/backups/<op-id>/`（0600）→ ③ 执行 → ④ journal
  终态（ok/failed/blocked + restart/start 结果，终态清除 childPid）；启动对账把残留 pending → failed
  （附 preImage 可恢复），并对带回 childPid 的 pending op 击杀进程组/pid（先 `-pid` 后 `pid`）；journal/备份保留策略（默认最近 50 笔、**无时间窗**，备份随 op 保留、队列深度 ≤8、单 op 超时 10 分钟、blocked 等待上限 120s、失败可重试），队列深度/配额镜像 runtime disk 软限；remove 的 installed 名单**执行时**再校验（非入队时）；
- **暂存归档的生命周期**：`chamber-plugins/third-party/<escaped>/<name>-<hash>.tgz` 在 op 终态后**不删除**——dsh CLI 会把 `file:<staged>` 永久写进 profile manifest + pnpm lockfile，删除会令清单悬挂；submit 被拒（从未执行、无引用）与 deferred 意图清除两处仍删。boot 时机（journal 对账后、executor 空闲、路由未并发 stage）按「profile manifest file: 引用 ∪ deferred 意图 ∪ live(pending) op」保留集清扫无引用 `*.tgz`（不影响 `backups/`、`deferred.json`；根缺失静默），有界增长 = 引用集 + 在途工作；
- deferred：ready 边沿（observeLocalState）空闲窗口排空（quarantine/激活过滤），**波浪续排**
  （队列满时等槽位再排下一波，`DRAIN_DEADLINE` 10 分钟兜底），本轮**全部**排空意图 op 终态
  （且至少一个 ok）后请求一次受控 restart（请求点不在首个 ok 终态——否则会撞上仍在途的租约被门控跳过）；
  门闭时 skip 不报错并登记；
- 安装后自动「重启生效」：apply 默认 defer=false → 队列尾自动 restart（受 C 轮询语义）；defer=true 仅落盘不重启。

### 6.4 ssh 后端收敛
ssh 后端动词映射到既有 IPC（readManifest=plugin_list、apply=plugin_apply、materialize=plugin_materialize_add_pick、chamberProvision=seed_host_graph、restartToApply/startFromStopped=restart_service）；模型统一要求（ssh/gateway 同权，决策 10/11/19）：
- 「已安装」列表逐行移除（consistent 行缺口修复）：ssh 后端的 remove 走 plugin_apply remove；
- **受保护集合判定的 ssh 形态（2026-12 修订，§6.11）**：`F` 无远端来源 ⇒ **装面保守**（官方 scope 一律拒，理由 = 无法用事实界定「会不会 shadow 远端锚点 release 包」）、**卸面按 `B₀ ∪ S` 事实判**（F 缺失只收紧不放松；B₀ 与 S 都可离线判定）；判定在主进程 `ssh-apply-rows` + `applyPlugins` 双侧落地（整批拒绝语义不变）+ 测试。
  **这是相对决策 19 旧口径（ssh 与 gateway 同集）的显式不对称**：注册的偏差见 §7 与 STATUS；
  二期若给 ssh 增加远端 family 读（扩 exec 面）再单独评审放开装面（design 13 §7.2 纪律）；
- undoJournal：桌面主进程侧持久化（userData 0700 JSON）+ 变更前远端 package.json 备份（cat 读 → 本地存），
  撤销 = 恢复备份 + 必要 remove；journal op 记录目标指纹（operationalFingerprint：host/user/service/home），
  undo 只认当前目标指纹一致的最近 ok op；实例删除与操作指纹变更（同 id 编辑换目标）两条路径清 journal；
- 恢复引导 UI 与 gateway 一致（r0-r4 通用文案，后端差异仅在“启动/重启”动作映射）。
改动均落在主进程/纯函数层，ssh 路径行为由既有纯测试 + 模型层测试守护。

### 6.5 桌面 IPC / 渲染层
- 模型动词经渲染层统一调用点（主进程按目标解析后端）：`gateway_plugin_sync(id)`（手动同步兜底）——desktop 维护 gateway-sync-registry.ts、main.ts handler（id 白名单 + ready 复核 + `{ok:true,uploaded,skipped}|{ok:false,error}`）、preload/renderer 双镜像 + mirror golden（`GatewayPluginSyncIpcResult`，区别于 gateway-provider 同名 interface）；同步失败必须显式化：GET/PUT 非 200 与网络异常返回 `{failed:true,error}` 并映射 `ok:false`（「已是最新」不得吞失败）；网关 `PUT /chamber/plugins` 的校验拒绝回显脱敏原因（sanitizeRouteError，≤300B，不落裸 HTTP 400）；读侧经实例代理 GET `/chamber/plugins` 与 `/chamber/plugins/installed`（§6.2）驱动 chamber 区版本漂移显示与「立即同步」（gatewaySource 门控、http+dsh 只读不变）；seed-cache 键由 wrapper 统一加前缀一次（禁双前缀）；`gateway_plugin_apply(id, {add[], remove[], defer})` / `gateway_plugin_materialize(id)`（pick-only，取消 = {ok:true, cancelled:true}）——全部主进程执行 + showMessageBox 确认 + 经注册 origin（SPKI/隧道 Host 纪律同 syncGatewayChamberPlugins）；apply = remove 先于 add + settle-then-restart + partial 诚实（GatewayPluginApplyIpcResult）；materialize =
  本机 `.tgz` 归档或文件夹 → tarball（plugin-tarball.ts `classifyPluginPick`，容量与 gateway 路由锁步）→ 202/deferred；
        **直连 202（opId）后在桌面侧等 op 终态（tasks 轮询，1s×120s，复用 apply 的 waitForOpsToSettle）+ 请求受控重启并轮询 status**（与 apply 同一 settle 纪律），返回 `{ok:true,outcome:{executed,restarted}} | {ok:true,deferred:true} | {ok:false,error,outcome?}`（outcome 仅在「已执行但重启失败」类部分失败携带）；deferred 意图即时返回（网关就绪边沿排空并自动重启一次）。settle/status 轮询必须用纯 auth 头——误带 materialize 上传的 content-length 会让网关等待不存在的 body；确认后、执行前重读注册态与 ready/实例，漂移即 `ok:false`「连接在确认期间变化」，绝不按确认前快照执行；ssh 后端沿用既有 IPC 方法名，含 ssh undo journal/IPC（ssh_plugin_undo）与 SSH_PLUGIN_LIST 掩码挂接（§6.4）；归档导入选择器：local/ssh/gateway 三通道都接受**现成 `.tgz`**（npm-pack 布局）与插件源码文件夹
  （macOS NSOpenPanel 单对话框 file+folder 双模式；Windows FOS_PICKFOLDERS / GTK 无法混用 → 非 macOS 保持
    文件夹对话框，archive-pick 为 macOS-v1，Windows/Linux 腿随 design 22/23 排期）；local = `file:<归档绝对路径>`（allowFileSpec 通道），ssh = `materializeArchiveAndAdd`（免本地 pnpm pack，复用
  write-file → 远端 `$HOME` → `add file:`），gateway = 原样 PUT（headers 取归档自身 manifest，
  网关二次白名单）；按钮文案「从文件夹导入」→「从本地导入」（UI 键名不变）；
    **`desktop_local_plugin_add_file` 的 `{allowFileSpec:true}` 门**已接（本地文件夹/归档导入走主进程选择器），渲染端提交的 file: spec 仍被拒；
- **镜像面（IPC 新增写方法时的真实编辑集）**：preload.cts（方法+invoke 字面量）+ ipc-events.ts（3 通道）+ main.ts（3 个 trustedIpc handler）+ renderer global.d.ts + test/ipc/ipc-surface-mirror.test.ts（golden 方法/字段清单 + 结果联合形状；apply 的 batch+cancelled 联合需形状守卫）+ connections global.d.ts（**re-export 型**，仅新命名类型落新文件时改动）。
- 读侧（installed/tasks/status/Loader）全经实例代理 GET。

### 6.6 UI：单一模型视图
`PluginDialog.tsx`（connections 包）是唯一插件对话框：local / ssh+dsh / gateway / http 直连四来源共用同一组件，
后端分叉仅在数据源与动作分发；区域顺序 = 诊断横幅（bannerProjection 去重）→
chamber 内建表（registry 驱动的宿主包行——注册表现有四行 client-graph / git-worktree / archive-cleanup /
open-in，其中 open-in 标 `localOnly`：**该行只列在本地目标**，非本地目标的行集 = 该目标适用行
（`applicableChamberPackages` ⇒ local 4 行、ssh/gateway/http 3 行；2026-12 用户裁决，退役
「非本地目标渲染『本地形态专用』」的 badge 方案；状态列本身仍按 badge 渲染），
移动客户端行 mobile 仅 gateway 源显示、标注网关随发行物注入）→ 第三方区（已安装 + 逐行卸载 + 添加：
spec 输入 + npm 搜索 + 本地导入）→ 恢复/动作行；
http 直连只读。
- 区域语义：chamber 区（状态源 = 后端 chamberProvision/loadedFacts；
  gateway 实例停机时 Loader 不可达 → 明确的降级标签，不静默）；差异区（profile_absent → 「实例尚未初始化，
  将缓存安装意图，实例就绪后自动安装」横幅；队列/任务态文案键）；结果与失败面（partial「已完成 n/m」、
  blocked、409 逐字、任务行）；恢复面（r0-r4 文案见 §6.8）——每区 ssh 与 gateway 共用一套文案与流程，
  仅执行来源不同；
- 「失败即停」与 ssh 逐行 materialize 隔离在模型层只有**单一定义**：批量内 registry/remove 失败即停，逐行 materialize 保持隔离（AGENTS 单实体失败不阻塞），文案如实呈现；
- **变更记录区不渲染 task 行**（后端 journal/备份保留，journal 仅供 undoForLatest 派生）；撤销恢复化
  **仅 gateway**（runtimeDown（stopped/error/restart-exhausted）且 undoForLatest 有动作时在恢复横幅显示
  恢复撤销入口）；ssh list tab 的「撤销最近变更」按钮保留原样——登记为范围偏差（见 §7）；
- **第三方行生效状态**：local/gateway/http 已安装列表含「生效状态」chips（Loader pluginInventory 快照按 moduleName===包名**精确匹配**：生效中/加载中/加载失败/已停用；本地实例经 /api/i/local 读快照，读失败静默置中性——清单文件永远不作 live 断言）。**无同名 entry 一律中性**：bundle 层行（localList.bundles / installed.bundles）也不例外——bundle 包名**从不是 Loader 行**，树由各 bundle 的 `dsh.bundle.patch`（`cordis.patch.yml`）叠在空 entry 根上，行是 `insert:` 名字而非 bundle 自己（如 `@deepseek-ai/dsh-experimental-agent-team-profile` 插入 `@deepseek-ai/dsh-experimental-agent-team` 与 `@deepseek-ai/dsh-experimental-tool-agent-team`），故「查无同名行」不携带「重启后生效」信息；plain/client-only 依赖同样中性。bundle 层行「是否已生效」没有可判事实，**中性是当前上限**（闭合路径见 §7 与 STATUS）；
  gateway 导入成功文案按 outcome 区分（materializeLive / restartNeededHint / deferredOfflineNote）；
  local add/import 成功不谎报「已应用」（只改本地 profile，重启后挂载）；ssh doApply 成功后自动重载已安装列表；
- ssh 分支默认不呈现整盘 diff 表：与 gateway/local 同骨架的主视图（已安装列表 + 添加区 + 范围注），
  legacy diff 折叠为「与本地插件组合存在 {n} 处差异 — 展开对账」次级入口；展开后 rows/filter/apply/undo
  语义与按钮逐字保留，应用动作仅在展开态出现在 footer（纯模型层与后端行为不变，仅默认呈现与入口层级改变）；
- A 键表（zh/en；代码↔键覆盖靠实现清单）：partial/blocked/queue_busy 文案、多桌面移除确认、他人会话中断（C 复用）、deferred 离线执行确认（「将缓存并在实例就绪后自动安装，可能在你断开后执行」）、task 行（pending/running/blocked/failed + 上次失败）、preImage 恢复（撤销最近变更）文案、journal 横幅、停机态动作文案、startFromStopped 文案、profile_corrupt 恢复引导、**受保护行的只读呈现**
  （角色徽标 + 受保护提示 + 无移除按钮；判定码→本地化文案映射**未做**，服务端 `error` 逐字显示——§7 已登记）、
  「gateway 版本较低」回退提示、who/when
  归因 tooltip（「由 <连接 label> 于 <时间> 安装/移除」，未知时「另一桌面」）。
  **已知余留**：who/when 归因 tooltip 尚未渲染（TaskRow 未投影 initiator）；预置未用键
  （blockedTask/queueBusy/lastFailedHint/**reservedNameRefused（随旧码 `reserved` 退役一并删除）**/opAttribution*/startManagedDshConfirmTitle）
  待归口接线或删除；gateway 拒绝码→本地化文案映射未做（409 逐字英文，登记接受）——见 §7。

### 6.7 安全模型
- 既有全权 auth；渲染层不持凭据（主进程注入）；**主进程确认 = 桌面通道纪律（不加服务端 admission，决策 14）**。
- 写面：spec/name 白名单族单一来源（control-plane 共享模块）+ 渲染镜像锁步测试；**受保护集合判定单一实现**（control-plane `protected-plugins.ts`，§6.11：install/remove 同判 `P`、remove 不判版本、官方 install 精确同代 + 装后复验；**渲染端不再持有判定镜像**，只消费投影 `role`/`protected`——后端才是权威）；单写者栅栏 + 生命周期排空（决策 17）；日志脱敏（凭据零进入，含 npm 令牌类环境）。
- 信任声明（决策 20）：「已安装代码 = gateway 用户级等价」（进程隔离 ≠ 主体隔离；同用户可读 stateDir 0600 jwt-secret 等）；scripts 默认允许（决策 13）风险登记；二期硬化：ignore-scripts/逐包放行、OS 用户分离。
- 多桌面：last-writer-wins + 队列串行 + 移除确认（全局影响文案）+ who/when 归因（连接 label 级，不进日志）；移动例外不参与；per-principal 角色扩展时插件写路由与 runtime 写路由同属 operator-scope（18 先例）。

### 6.8 故障域与恢复
- 故障域：插件代码执行在托管 dsh 实例进程/前端（进程隔离）；/chamber 管理面挂宿主、非 ready-gated——实例崩溃/停机时管理面存活；可能伤宿主的仅机器级资源、安装期脚本、profile 元数据损坏——逐类登记（r3/r4 域）。
- 分层兜底：client 插件页面级（Loader fiber failed）；host 插件进程级（健康自动重启窗口 → restart-exhausted）；
  装完即崩（非 env 源自动回退 known-good + dsh-home 快照恢复 = 重锤，插件级轻恢复优先）；corrupt →
  profile_corrupt；seed（chamber 宿主包/移动端 extraneous + 每次 spawn 前 seed thunk 自愈，免疫）。
- 恢复阶梯（用户可见文案 + 动作均双后端同权）：
  - **r0 实例存活**：视图列表/diff 移除 → 「重启 dsh」（C）生效；
  - **r1 停机（stopped/error/restart-exhausted）**：停机态移除（执行窗口含停机态；installed 纯文件读）→
    **「启动实例」= start 原语（决策 12）**——卡片/视图给出明确动作 + 文案「已移除 <name>，正在重新引导…」；
    失败 → 诚实回 error + 提示（可再次移除/查看连接日志）；ssh 后端同动作映射 restart_service；
    - **r2 profile 损坏（profile_corrupt）——v1 只有前半段，回滚面列二期**：v1 = 诚实投影 `profile_corrupt`（GET installed 500）+ 视图横幅（journal 最近一笔）+ 停机态 remove/start（r1）；
    **「撤销最近变更」/ 停机 → preImage 回滚（两文件成对校验）/ 残留名字 remove → start/restart
        属二期，v1 未实现**：gateway 无 undo 路由，journal 的 preImage 备份只有写入方、零运行时恢复消费方（plugins-journal.ts）——与 §7「r2 走 runbook」、STATUS 的 C-F7 条目同口径，不得读作已实现。
    无备份（外部损坏）→ **正确兜底链**：
            restore-builtin **不能**治愈 corrupt profile（探同一 dsh-home——`executeStartupTransaction` 共用，dsh-home 不随目标版本更换）——v1 兜底 = operator runbook（从 `<stateDir>/dsh-runtime/snapshots/` 手工恢复 dsh-home 快照）；恢复路由（snapshot restore / preImage 回滚）二期；
  - r3 脚本风险：登记（决策 13/20），恢复阶梯不承诺覆盖安装在 dsh-home 之外的持久物（cron/rc 等）——如实说明；
    - r4 宿主不可达：机器级 runbook；二期提供 `gateway plugin` 操作员子命令（list/remove/rollback 复用同一 executor+journal 核心；现 CLI 除 serve 外只有 auth 操作子命令 status/reset-password/clear）。
- 恢复判据：视图「已加载」Loader 事实行 + 状态行（重启前 active / 移除后消失）为细节证据；成功文案用自然语言（「已移除 X，实例已重新就绪」），不把 Loader 行当面向用户的判据。

### 6.9 工程默认与配额
- 202 异步 + 任务面；队列深度 ≤8、单 op 超时 10 分钟、blocked 等待上限 120s（`CAN_RUN_WAIT_MAX_MS=120_000`，plugins-exec.ts）、journal 最近 50 笔（无时间窗）、上传前磁盘预检；文件夹 ≤32 MiB 独立流式路由 + 解包上限（≤4096 文件/解压 ≤256 MiB）；**受保护集合/代耦合判定模型层单一实现 + C11–C14 上游保鲜门**（§6.11；判据谓词登记在 docs/checklists/upstream-touchpoints.md §6，**判据散文与代码判据同步**；结构数据单一来源 = scripts/upstream/registry.json，checklist §2/§9 由其生成）；tasks 独立端点（不并入 installed）；执行窗口含停机态；暂存 tgz 保留语义见 §6.3。

### 6.10 明确不做
http+dsh 直连插件管理（无执行后端）；gateway 编排面回流；控制面实现执行面；非插件资产远程写；chamber 移动端参与第三方管理；安装期脚本默认禁行与 OS 用户隔离（二期硬化，非 v1）。

### 6.11 受保护集合与代耦合（2026-12 修订；决策 19 的新口径）

**动机**：旧规则按域名前缀拒绝（`@deepseek-ai/*` + `@dsh-chamber/*`）——挡住了官方 opt-in 层（`@deepseek-ai/dsh-experimental-*` 装不上），又挡不住组合被拆/族成员被跨代副本 shadow，且随上游改名、换 scope、加产品族失真。新规则**按事实判**：拒绝集从目标实例的**可验证事实**派生，规则对 install/remove 分相。

#### 6.11.1 受保护集合 P 的定义（唯一权威）

```
P(instance) = B₀ ∪ S ∪ F
```

| 分量 | 定义 | 单一来源 | 明确排除（易混淆项） |
|---|---|---|---|
| **B₀** | profile 的**安装自带组合**：web 模板默认 + installation-owned 元组 | 本仓快照常量 `PROFILE_BUNDLES_SNAPSHOT = ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']`，对拍上游 `PROFILE_TEMPLATES.web.bundles`（C12） | **live `dsh.profile.bundles` 不参与保护判定**（见 6.11.2） |
| **S** | chamber 播种物包名 | `CHAMBER_HOST_PACKAGES[].insert.name`（`control-plane/src/host-graph-seed.ts`，双端可达；结构门 C13） | 旧别名 `@dsh-chamber/dsh-host-*` 不在 S 内（历史遗留，非播种面） |
| **F** | 运行时线族：运行时闭包中的 `@deepseek-ai/*` | **已提交**的 `packages/desktop/vendor/dsh/pnpm-lock.yaml` 闭包（平台无关，C11）；实例侧 `node_modules/@deepseek-ai/*` 仅作**等价性交叉校验**（允许差集 = 其他平台 `node-addon-system-*`） | ❌ 源码线 `vendor/harness-packages`（含 opt-in 段与 dev 包）❌ `<dsh-home>/profiles/node_modules` 的 module-fallback 农场（上游 `healProfilesModuleFallback` 维护，会残留上一代死名）❌ profile 自己的 node_modules |

**事实源可达性**：local/gateway 两侧都能算出完整 P（B₀/S 是常量与注册表，F 由活动 workspace 派生，版本由 `resolveActiveRuntime()` / gateway `resolveWorkspace()` 给出）；**ssh 只有 B₀ ∪ S**（F 无远端来源）。
F 在**名字集合**之外同时携带 **name→version 事实**（运行时线为每个名字提供的版本**集合**——同一名字可能被
pin 多个版本；锁文件来源按 `name@version(peer 依赖后缀)` 取版本段，树枚举来源读该包自己的 `package.json`，读不到就不登记该名字的版本、绝不猜；键缺席或空集 = 没有版本事实）。它只服务 §6.11.3 的代口径与 §6.11.4 的复验，**不参与 P 的名字集合**——C11 的判据仍是名字集。

**来源选择与可信性判据**：F 按候选顺序取（**内建锚锁文件 → 活动树自己的 `pnpm-lock.yaml` → 树枚举兜底**），
候选必须过硬判据：核心锚齐全、不含禁名（与 C11 同源），**且名称解析出的闭包必须也解析出版本**——两解析器对同一批键矛盾（`the name and version parsers disagree about the same keys`）即拒绝该来源。**树枚举是刻意的例外**：不要求版本事实（目录名即其用途；"空目录树可作 F"的既有 pin 依赖它）——在树上也拒绝会让 `familyNames` 变 null ⇒ 写面进 `protected-set-unavailable`、挡死官方 opt-in 安装。内建锚（`pinnedLockfilePath`）只在**活动运行时与内建线同版**时才交给 `resolveRuntimeFamily`（`shouldPreferPinnedRuntimeLockfile`，`plugin-sync.ts`）；用户选装运行时（design 18 §3.6）用活动树自己锁文件。**唯一例外 = 显式 env 覆盖兜底**（`desktop/main.ts` 的 `localProtectionFacts`）：活动树与内建线**不同版**、自身事实源**解析失败**、且 `resolved.source === 'env'`（`DSH_CHAMBER_DSH_PATH` 开发者覆盖）时带内建锚**重试一次**（否则本地写面整体进 `protected-set-unavailable`）；`'user'`（用户自选已发布运行时）**永不**享受。gateway 没有内建锚，直接用自身 workspace 锁文件。

#### 6.11.2 为什么 B 取 B₀ 而不取 live bundles

上游 `dsh plugin` 是 pnpm 转发器：解析到 `dsh.bundle.patch` 的依赖会被重算进 `dsh.profile.bundles`（上游 `apps/cli/src/plugin.ts`，C12 守此契约），故 `B = live bundles` 会让**每次安装都把被装物变成受保护项**：

```
装层 → 层进入 bundles → name ∈ P → remove 被拒 ⇒ 装得上、卸不掉
```

故：**live bundles 只用于渲染 `role`**（`∈ B₀ → composition`；`∈ liveBundles \ B₀ → layer`），
保护判定用 B₀。即「不许拆组合」只保护**安装自带的基线组合**，不保护用户自己加的层。

#### 6.11.3 判定规则（写面唯一入口；op 分相）

```
decide({op, name, version, runtimeVersion, P, profileState, source}):

  # R0 profile 未初始化：保留既有 deferred 语义，绝不 fail-closed
  if profileState == absent:                      return defer()

  # R1 保护（install / remove 同判，只看名字）；B₀ ∪ S 永远可得 ⇒ 先于降级阶梯
  if name ∈ P:                                    return refuse('protected')
  # 降级阶梯（**在 R1 之后**）：无 F 事实源（ssh）或 F 派生失败（降级）
  if source != 'runtime' and op == 'install' and officialScope(name):
     return refuse(source == 'none' ? 'protected' : 'protected-set-unavailable')

  # R2 仅 install：官方 scope 必须精确同代
  if op == 'install' and officialScope(name):
     if version == null:                          return refuse('needs-version',        suggest(name@runtimeVersion))
     if !isExactVersion(version):                 return refuse('needs-exact-version',  suggest(name@runtimeVersion))
     if !isExactVersion(runtimeVersion):          return refuse('runtime-version-unknown')
     if !sameGeneration(version, runtimeVersion): return refuse('generation-mismatch')

  return allow()
```

- **remove 永不判版本**（remove 无 spec；跨代库存越歪斜越该能卸）。
- `isExactVersion`：只认 `X.Y.Z[-pre][+build]`；拒绝 `^`、`~`、`latest`、`next` 等 dist-tag（movable target）。
- `sameGeneration`：任一侧带预发布 ⇒ **字符串全等**（`0.1.5-rc.1 ≠ 0.1.5-rc.2`；tuple 相同而预发布代不同不算通过——实测踩过的坑）；两侧皆稳定 ⇒ 比较 tuple。
- **「代」的适用面**：`sameGeneration` 比的是**发布族世代串**，只对随发布族版本号的名字成立；改域 vendored 包（`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery`）与随上游版本走的 `@deepseek-ai/cordis*` 版本由上游决定、与世代串**永远不等**，比 `runtimeVersion` 只会假阳性。
  这类名字的判据是 §6.11.1 的 **name→version 事实**（运行时线为这个名字提供的版本集合），与世代串无关。
    R2 仍是**直接 spec 的保守粗筛**（官方 scope + 精确版本 + 与实例世代同形），对改域包只拒；按名字版本事实的判定在 §6.11.4 装后复验。
- **播种不是「插件模型写面」**：chamber 注入机制（本地 overlay `control-plane/src/host-graph-seed.ts`、远端 `plugin-sync.seedRemoteChamberHostPackages`）正是 **S 的来源**、不受判定约束（否则自锁）；判定只约束「用户/脚本经插件模型发起」的 install/remove（local IPC、gateway 路由、ssh apply/undo）。
- **不设「必须是层」的门**：非层包按普通依赖处理（上游 CLI 已有 `declares no dsh.bundle — installed as a plain dependency, not a profile layer` 告警），UI 类别列如实呈现；用「是否层」当门会引入装前/装后探测状态机。
- **降级是「只收紧不放松」的逐后端阶梯**。F 读不到时**保护效果**统一为：官方 scope 的 install **一律拒**（比 R2 同代校验**更强**，因此不可能静默放行拆组合）、`B₀ ∪ S` 照常保护（R1 不变）、第三方 install 与 **remove 面**（只判 `B₀ ∪ S`）不受影响：

| 后端 | 事实源 | F 读不到时的行为 | 拒绝码 |
|---|---|---|---|
| local | `resolveActiveRuntime()` | 官方 scope 装面全拒（`familySource:'unavailable'`），第三方照常 | `protected-set-unavailable` |
| gateway | `manager.resolveWorkspace()` | 同上 | `protected-set-unavailable`（HTTP 503，属网关自身状态，可重试） |
| ssh | 无 | 官方 scope 装面全拒（`familySource:'none'`，**常态而非降级**） | `protected` |

      三种形态的差别只在**拒绝码与文案**：`'none'` = 「这个后端没有族事实源」，`'unavailable'` = 「本该有、这次读不到」。**绝不**把「派生失败」退化成"没有保护"（设计禁止的静默放行）。空集同样按派生失败处理：`P` 三个分量全空时 `deriveProtectedSet` 答 `ok:false`，绝不返回 "有效的空保护集"（否则 remove 面会连组合成员一起静默放行——2026-09-13 复核）。**判序**（2026-12 review 明确）：`B₀ ∪ S` 判名（R1）**先于**这条降级阶梯——那份事实永远可得，所以降级态下一个组合成员的 install 仍答 `protected`（不是 `protected-set-unavailable`），只有官 scope 且不在 `B₀ ∪ S` 内的名字才落到阶梯上。`profile_absent` 的 defer（R0）仍在两者之前，但延迟意图在 drain 时若撞上永不成立的决定会被**丢弃并记为失败 op**（绝不静默僵尸）。「永不成立」只指名字/版本面的决定（`protected`/`needs-version`/`needs-exact-version`/`generation-mismatch`/`runtime-version-unknown`/格式类）；**网关自身的状态**（`protected-set-unavailable` = F 暂不可读、租约/队列窗口）不进这一集合，留在队列等下一条 ready/degraded 边重试——与 §6.2 的 503 口径一致（2026-09-13 复核）。

#### 6.11.4 代耦合的完整兑现：装后复验（覆盖传递闭包）

R2 只看**直接 spec**；官方层的**依赖闭包**同样进入实例树（实测 `…-profile` 闭包含 `@deepseek-ai/dsh-brand@^…`、`@deepseek-ai/schemastery@^…` 等 range 族成员）；闭包里也会出现**不在 F 内**的官方 scope 名（官方 opt-in 层 `@deepseek-ai/dsh-experimental-agent-team` / `-tool-agent-team` / `-client-ui-agent-team` 的传递依赖；F 按 C11 不含 `dsh-experimental-*`），由用户显式安装的层带来，正是闭包豁免对象。官方 scope 的 install 因此必须：

1. **装前**：精确版本（R2）；
2. **装后复验（强制）**：读 profile 的 `package.json` + 顶层 `node_modules/@deepseek-ai/*`（闭包臂另读各包自己的 `package.json`），逐条按**先版本、后闭包归属**两段判：
   - **直接依赖**（用户显式请求、已由 R2 判定，层自己通常就是族外官方 scope 名）豁免；
   - **版本臂（先）**：名字 ∈ F ⇒ 实例树里的版本必须**落在 §6.11.1 name→version 事实里该名字的版本集合**中
          （同名字被 pin 多版本时是集合成员关系；实例版本读不出 ⇒ 同样判 `generation-mismatch`）；该名字**没有版本事实**（键缺席或空集）时退回 `sameGeneration(版本, runtimeVersion)`，连实例世代也未知 ⇒ 该臂没跑成，计入下面的 `skipped`。
                    **复核结论**（2026-12）：曾考虑缺表即报 `skipped`，实测**否决**——会让缺版本事实的跨代副本从响亮失败退化成"跳过放行"（设计禁止的"静默放行拆组合"）；缺事实照旧退回世代比较（极窄场景误报属**可接受的保守方向**）。
               - **闭包臂（后）**：名字 ∉ F ⇒ 属于「用户显式安装层的依赖闭包」则豁免，否则 ⇒ `outside-family`。**判序不可交换**：闭包内 F 名字版本不符仍报 `generation-mismatch`。**闭包口径（两段）**：(a) **种子只取官方 scope 的直接依赖**——第三方层于自己的 `dependencies` 写官方名**不再**豁免，照旧报 `outside-family`（实测源码线官方包 284 / 运行时线 F 244，差集 42 里 33 个连 opt-in 段都不是）；(b) **walk 只展开官方 scope 的节点**：非官方中介**进入集合但不展开**（官方层真实闭包含 `zod@4.6.4`、`react@18.2.0`），若允许一个第三方
   中介解释官方名，等于给「官方层 → 第三方层 → 官方名」留静默放行。两段合起来的可判形态：官方层 →
   官方层 → 非 F 官方名 ⇒ **仍豁免**；官方层 → 第三方层 → 非 F 官方名 ⇒ 报 `outside-family`；真实安装树
   （8 个顶层条目）仍判 `ok/checked 6`。
         从这些官方直接依赖出发，沿 `node_modules/<name>/package.json` 的 `dependencies ∪ optionalDependencies` 递归（**只对官方节点读清单**；`peerDependencies` **不纳入**——`autoInstallPeers: false`）；只接受合法包名字面量（`../` 之类不参与）且清单读取有上限：**宁可少豁免，不放宽**。违例 ⇒ 该 op **响亮失败**（local：`{ok:false,error}`；gateway：op 记 failed + preImage 保留），文案带确切 finding（`outside-family` / `generation-mismatch`；后者的文案要说清"与运行时为该名字提供的版本不一致"，不能只报世代串）。复验**没能执行**时返回 `skipped` + 理由并**响亮记日志**——"跳过"永远不等于"通过"；**族名字有没能比对的**同样计入 `skipped`（全部只报聚合，部分逐一点名）。**v1 自动回滚未做**：回滚需「还原 package.json + lockfile 再重装」，两端只有 preImage 快照（缺口见 `docs/progress/STATUS.md`）。
3. **既有前提登记**：profile 的 `pnpm-workspace.yaml` 为 `nodeLinker: hoisted` + `autoInstallPeers: false`（上游 `initProfile` 写）——「peer 不会把族成员复制进 profile」的前提，由 C12 守；上游改默认值即红。

#### 6.11.5 读面投影契约（读写分离）

- 三端各新增 **`rows: PluginRow[]`**（加性；**`dependencies` 语义不变**，避免污染 name 基 diff）：
  `{ name, spec: string|null, version: string|null, role: 'composition'|'seed'|'layer'|'third-party'|'materialized'|'unknown', protected: boolean, owner?: 'installation'|'chamber'|'user' }`。
- **谁能算 P 谁投影 `protected`**：local = desktop main；gateway = **服务端**（判定权威；desktop 侧只做形状校验 + 消费投影，提交前重取一次投影，不自行重算 P——F 在服务端）；ssh = desktop main（P = B₀ ∪ S，F 无远端来源）。
- **`protected` 的唯一含义是「name ∈ P」**（install 与 remove 都被写面拒），**不是**"这个后端装不了它"（2026-12 review 定稿）：ssh/降级态对官方 scope 的**装面**保守是**写面/传输能力**事实——写面用 `protected`（ssh）/`protected-set-unavailable`（降级）拒绝 install，**不在读面撒谎**。因此 ssh 上不在 P 内的官方行仍 `protected: false`（remove 只判 B₀ ∪ S ⇒ **可卸**），对账批次由 UI 的 ssh 传输过滤 `sshSyncableDependencies` 排除官方 scope 保证安全；三端因此对同一份事实投影**同一组** `protected` 值。
- 渲染端**只渲染**：删除 `plugin-model.ts` 的 `isDeniedPluginName` 手镜像、`filterDeniedRows` 与其锁步测试；**保留** `plugin-inventory-text.ts` 的 `OFFICIAL_SCOPE` / `CHAMBER_CLIENT_PREFIX`（Loader 清单展示分类，非安装门）。
- **受保护行只读可见**（当它确实在依赖表里时）：无移除按钮（`—` + 提示文案）+ 角色徽标；
  `owner`（installation / chamber / user）已随行投影但 v1 **未渲染**，来源 tooltip 与"代"提示未做（§7 登记）。
- **行集 = profile 的依赖表，一行一条**（2026-09 用户修订，取代原「并集投影」口径）：`bundles` / B₀ / S 只作为 `role`/`owner` 分类器与保护判定输入，**不再凭空造行**。「已安装」= 我们装进去的插件；chamber 播种物在**「chamber 受管组件」表**里已有自己的行（探针状态 + 版本 + 手动重推），官方组合是运行时基线而非插件行——组合成员在 profile 目录里不存在（官方族 hoist 到 `profiles/node_modules`），版本列只能显示 `—`；空 `dependencies` 的 profile 也曾凭空列出 B₀ ∪ S 整组「自带」包（本机实测 6 行）。受保护名若**确实**在依赖表里仍是行且只读可见——保护判定与写面拒绝不受本条影响。只存在于 live `bundles` 而不在依赖表里的条目不成行、页内也不给移除入口：上游 `reconcilePlugins`（`apps/cli/src/plugin.ts`，C12 同源）**只把依赖表里的包按 `dsh.bundle.patch` 并入 `dsh.profile.bundles`**，且明说模板自带组合「are not dependencies and are never touched」——「用户装的层一定在依赖表里、自带组合一定不在」正是本条依据。
- **diff/apply 边界（硬要求）**：`computePluginDiff` 的输入只吃**后端判非 `protected`** 的行（`protected === false`）。若把受保护行并进 diff 输入，`missing` 行默认勾选 ⇒ 一次普通第三方对账会把 `@deepseek-ai/dsh-base@…` 当 add 提交、后端整批拒绝——普通对账失效；必须有单测断言受保护名字**不出现在 `diff.rows`**，`hasLocal` 与对账 pill 计数随之修正。
  - **角色不参与该判据**：`layer`（用户自己加的层）同样必须可同步；按角色收窄只留 `{third-party, materialized}` 会把用户后加的层从对账视图里静默抹掉（**2026-12 review 修正的功能回归**）。
  - **ssh 面另加传输能力过滤**（`sshSyncableDependencies`）：**官方 scope 行不得进 ssh 对账批次**（否则整次对账失效）——这是传输能力而非保护判定，保护判定唯一来源始终是后端投影的 `rows[].protected`。
- **undo 也是写面**：gateway `undoForLatest` 与 ssh `doUndo` 的 remove 由 journal 派生，必须**在提交前过同一条 `decide`**（或后端拒绝该 op）——否则它们是绕过保护判定的旁路。

#### 6.11.6 抗漂移门禁（把「担心」变成会红的东西）

挂在既有 C 门家族（`scripts/upstream/verify-upstream-touchpoints.mjs`，判据纯函数 `scripts/upstream/plugin-protection-gate.mjs`，负例测试随 `pnpm run test:upgrade-tools`；登记表镜像在 `docs/checklists/upstream-touchpoints.md` §6）：

| 门 | 断言 | 红意味着 |
|---|---|---|
| **C11** | 运行时线闭包含核心（`dsh`/`dsh-base`/`dsh-web-app`）、**不含** `dsh-experimental-*` 与 dev/test 包；实例树物化时枚举 == 闭包 − 其他平台 `node-addon-system-*`。核心/禁名判据与锁文件解析器**直接 import 运行时模块**（`protected-plugins.ts`，单一来源），门禁另有 ≥200 名的**解析健全性下限**（CI 专属，运行时判据是"核心锚齐全 + 无禁名"的可信性判据）。F 同时携带 §6.11.1 的 name→version 事实，但**本门判据只判名字集**（名字集合语义不变，版本事实不进 C11） | F 的来源选错（如误用含 opt-in 段的源码线 vendor 树）或上游族集合漂移 ⇒ 停升级、改派生 |
| **C12** | 上游源码仍以 `dsh.profile.bundles` 承载层列表、以 `dsh.bundle.patch` 声明层、web 模板默认组合不变、profile workspace 仍是 hoisted + 不自动装 peer | 上游改了 profile 格式/默认组合/链接器 ⇒ 停升级，改 B₀ 快照与派生 |
| **C13** | `HOST_*_PACKAGE_NAME` ↔ `HOST_*_INSERT` ↔ `CHAMBER_HOST_PACKAGES` 三面一一对应 | 策略与播种机制脱节（S 分量失真） |
| **C14** | `plugin-sync.ts`（producer）↔ `preload.cts` ↔ `renderer/src/global.d.ts` 的 manifest 字段集一致，**且** `rows` 的**元素类型**三方一致（control-plane `PluginRow` ↔ preload/renderer `PluginRowProjection`：字段名 + `role`/`owner` 字面量并集） | 约束投影与 wire 镜像漂移（ipc-surface-mirror 只覆盖宿主接口的后两者；行类型曾经"文档说守护、实际 0 违规也绿"） |

**四层合起来的效果**：上游怎么变，最坏情况是「装卸暂停 + 门禁红」，不会是「静默拆组合」。

#### 6.11.7 兼容与版本歪斜

- 新字段**加性**：新 desktop + 旧 gateway ⇒ 无 `rows` ⇒ 渲染端走旧过滤回退路径：**官方/chamber 行整行不列出**，只列第三方行并提示「gateway 版本较低」——绝不给一个必然 400 的按钮；旧 desktop + 新 gateway ⇒ 忽略新字段。与 §6.11.5 新口径的差异（2026-09）：新 gateway 的依赖行里若确实含受保护名，它**会**作为只读行出现；回退路径按前缀整行不列，属只收紧的保守差异，随 gateway 全量升级消失。
- 就地部署需先把 gateway 更新到本版；兼容声明写在 `CHANGELOG.md` 发布时（版本歪斜窗口属发布说明，STATUS 口径）。

#### 6.11.8 注册在案的偏差（与 6.11 同源）

- **ssh 装面保守**（6.11.3 的 ssh 行）：相对决策 19 旧口径是显式不对称；放开需先给 ssh 加远端 family 读（扩 exec 面，design 13 §7.2 纪律）。
- **代不匹配默认阻断**（跨代试验需显式 override 入口，v1 未提供）、**闭包豁免只从官方 scope 的直接依赖起步且 walk 只展开官方节点**（2026-12 复核收紧；第三方夹带官方名、官方层经第三方中介（真实闭包含 `zod`/`react`）均报 `outside-family`）、**旧 gateway 无 `rows` 的回退路径**见 §7。
- **行投影 `owner` 未渲染**见 §6.6。
- **bundles-only 层只走 CLI**（2026-09 行集修订的必然结果，§6.11.5）：只在 live `dsh.profile.bundles` 而不在依赖表里的层**不成行**，页内无移除入口（CLI `dsh plugin remove` 照旧可用），但仍会被 Loader 挂载；上游 `reconcilePlugins` 只从依赖表补层、模板自带组合 "never touched"，故只可能命中手工编辑过 profile 的历史条目（本机 profile 带 3 个上一代 `@dsh-chamber/dsh-host-*` 遗留目录）。放开条件 = 页内补一条只读的 bundles-only 行。

## 7. 决策遗留 / 开放项
- **受保护集合与代耦合的剩余开放项**（§6.11；**权威清单在 `docs/progress/STATUS.md`「受保护集合与代耦合」条，共六项**）：ssh 装面放开（需先给 ssh 增加远端 family 读——扩 exec 面，design 13 §7.2 纪律，届时单独评审）、跨代 override 入口（v1 默认阻断且**不提供**；若确需跨代试验另开显式入口（含审计与行级「已知跨代」标记），不得把阻断降级为静默警告）、旧 gateway 无 `rows` 的回退分支（gateway 全量升级到本版后删除，失效判据写入 STATUS）、**装后复验违例的自动回滚**（v1 只做强制复验 + 响亮失败：gateway preImage 保留、op 记 failed；local 无 profile 备份；自动回滚 = gateway 的 r2 回滚列 / local 的 `package.json` + lockfile 备份还原，**未实现**）、**本地清单原样返回（含新增的 `rows[].spec` 通道；`redactLocalPluginManifest` 仍无生产调用点）**、**`owner` 未渲染 / 来源 tooltip 与「代」提示未做**；恢复路由（snapshot restore / r2 的 preImage 回滚）默认二期，v1 的 r2 走 runbook（见 §6.8 r2），开放状态与失效判据见 STATUS。
- scripts 默认允许下的 env 最小化实测：`dsh plugin add` 的 pnpm 是否读取 profile/.npmrc、是否向子进程暴露 npm 令牌环境——据实收紧 §6.3 纪律（实测结果可回调，不允许扩大暴露）。
- `GET /chamber/plugins/installed` 的写面在飞 409 `runtime_busy`（§6.2）：栅栏与客户端消费方均已接线（readManifest 对该 409 短退避有界重试、仍忙时专用本地化忙态，不谎报成功；桌面 apply 路径另等 op 终态 `gateway-provider.ts waitForOpsToSettle`）。仍开放**长时栅栏**不在前端轮询，只交给既有「刷新」节奏——是否需要轮询面未决。
- ssh 端 `plugin_apply` / `seed_host_graph` / `materialize_add(_pick)` 的主进程确认对话框缺口（design 13 §7.0 设计意图；确认链只覆盖 gateway apply/undo 与 ssh undo）——补齐并登记。
- 实机 E2E 矩阵（ssh+gateway 双通道）未勾销——发布前按 §9 执行；archive-pick 的 Windows/Linux 腿（非 macOS 保持文件夹对话框）随 design 22/23 排期。
- 已发布 gateway 发行树的 `dist/index.js` 可能仍是旧的 executor env pin（重装/重打包即复发）——正式修复须随 HEAD 版本树部署后按 §9 矩阵复跑；
- **产物新鲜度的守卫覆盖面**（本轮 §6.11 漂移暴露；2026-12 progress 清理复核）：`packages/desktop/dist/control-plane/**` 与
  `packages/gateway/dist/**` 有"**存在但缺当前标记 ⇒ 失败**"的标记守卫（缺失才按需构建，绝不静默自愈）；
  `scripts/gates/verify-artifact-freshness.mjs`（`run-checks tests/full`，经 `ci.yml:179` 进 CI）另覆盖 seed
  `dist/index.js` ×4、`gateway/host-packages/**`、`dist/preload.cjs`、`renderer/src/generated/**` 的「重跑/重建比对」，
  `verify-electron-artifacts.mjs`（macOS 腿/CI）执行编译产物冒烟。仍无守卫：`dist/web/**`、`dist/host-*-package/**`、
  vendor `allowBuilds` 锁步；CI 也从未真跑出 `SMOKE PASS`（smoke 恒 SKIP）。仍未落地的最小守卫建议（G2/G3/G5/G7/G8；
  G1 已落地 `verify:test-wiring`）见 `docs/progress/todo/product-freshness-guards.md`，开放状态与失效判据见 STATUS；
- gateway 拒绝码→本地化文案映射未做（登记接受），范围是**全部**服务端拒绝码：409 族与
  §6.11 的 400 判定码（`protected`/`needs-version`/`needs-exact-version`/`generation-mismatch`/
  `runtime-version-unknown`/`invalid-name`）以及 503 `protected-set-unavailable` 都逐字显示服务端英文 `error`；
  旧码 `reserved` 只出现在"解读旧 gateway 响应"的路径上（新服务端不再产生）；预置未用键待归口接线或删除（§6.6）。
- 受保护名的 **undo 负例未单列**（两条链路单测已覆盖，见 §6.11 矩阵）。
- **bundle 层「是否已生效」无诚实信号**（§6.6）：无同名 Loader entry 一律中性，刚装未重启与已生效同呈现；闭合路径 = 新增宿主面事实（各 bundle 的 `dsh.bundle.patch` 的 `insert[].name`），渲染端拿它与 Loader 快照求交后才谈得上「生效中 / 重启后生效」——属**新宿主面**，需单独评审（wire 形状与失效判据见 STATUS）；

## 8. 与既有文档的关系
- design 13 是 ssh 后端既有行为的权威契约；本文是模型与双后端契约的收敛权威（§3）——ssh 面新增能力（已安装列表逐行移除、**受保护集合判定（装面保守 / 卸面按 `B₀ ∪ S`）**、undo journal、清单掩码）落在 design 13 前置 blockquote 与 §6/§7。
- 受保护集合与代耦合的**上游保鲜门 C11–C14** 登记在 `docs/checklists/upstream-touchpoints.md` §6（机器侧判据 `scripts/upstream/plugin-protection-gate.mjs`，负例测试随 `pnpm run test:upgrade-tools`；升级流程引用在 `docs/checklists/dsh-upgrade-checklist.md` §0/§6）——与本文 §6.11 同源，改动时三侧同步。
- design 17：§3 能力表含第三方插件管理行与 dsh 直连（ssh/http）不挂载 dsh-runtime 分节；`/chamber/plugins/*` 写面与 §10 编排面剥离后的存活面一致；§4.1/§12 生命周期 writer barrier 含义含插件队列与 executor 子进程。
- design 18：§6 出网面登记“安装子进程随宿主受控出网”（决策 1）；§9.3 含 `start` 原语行、connections 入口、插件写互斥矩阵（含 beforeSpawnCheckpoint）与 restart-exhausted 自动回退衔接。
- design 05 §5：内容清单（日志命名、重启/启动按钮、单一模型视图与已安装列表、恢复提示行）；design 02：seed 与 spawn 语义（§2.4）。

## 9. 验证与测试矩阵
- B/C：test:connections（投影/门控/结果分类）、typecheck:connections、verify:i18n（仅 README 对）；共享模块：test:sidebar + test:settings-bridge（随迁/拆 split/清单同步；renderer-shell 无迁移项）；模型层（纯 node 无依赖）：intent 构建（remove 先 add/defer/勾选保留）、结果分类
  （partial/blocked/cancelled）、task 投影 → 行模型、后端分派表（含不支持组合）、journal 状态机与启动对账
  幂等（fake fs）、执行窗口 × 动作 × 在飞标志门矩阵（镜像 remoteRuntimeActionGates）、串行队列模型、
  executor 注入式 spawn（exit-code 夹具 + env 纪律断言）、白名单（单一来源 gateway+desktop 双跑 + 渲染镜像锁步测试）、pollGatewayReady 用例；
- **受保护集合矩阵（§6.11；纯函数，本地与 gateway 双跑）**：`decide` 的 op 分相
  （受保护名 install/remove 同拒；官方 scope 无版本 / `^` / `~` / dist-tag 拒；`rc.1` vs `rc.2`、
  `alpha` vs `rc`、稳定跨代拒；**remove 永不判版本**）、`profile_absent → defer`（首装不死锁）、
  P 派生失败 → 保守降级（官方 scope 装面拒、第三方照常）、
    **来源可信性**（解析器矛盾 ⇒ 拒来源；树枚举不要求版本事实，空目录树可作 F）、**内建锚仅活动运行时与内建线同版时使用**（`shouldPreferPinnedRuntimeLockfile`；env 覆盖兜底仅自身解析失败时生效，`'user'` 不享受）、
    装后复验（跨代/影子族成员 ⇒ 响亮失败 + gateway preImage 保留；**闭包内族外传递副本**与**版本事实相符的改域包** ⇒ `ok`；**第三方层夹带官方 scope 名 / 官方层经第三方中介带回官方名** ⇒ `outside-family`
  （闭包种子只取官方直接依赖、walk 只展开官方节点；官方层 → 官方层 → 非 F 官方名仍豁免）；
    闭包内 F 名字版本歪斜 ⇒ 仍 `generation-mismatch`（判序）；v1 **无自动回滚**，见 §6.11.4 与 STATUS）、B₀ 与 live bundles 分离（**装完仍可卸**：声明 `dsh.bundle.patch` 的层进 liveBundles 但不进 P）；**判序**（`B₀ ∪ S` 判名先于降级阶梯：降级态组合成员答 `protected`、官方非 P 答 `protected-set-unavailable`）、**降级态与 `runtime-version-unknown` 的码面**、**路径/registry 值判据**（`file:`/`link:`/相对/绝对/`~/`/`C:\` = materialize；`~1.2.0`/`^`/`>=`/`1.x`/dist-tag/workspace/npm 别名/git·url = registry）；**入口覆盖**：local add/remove/file、gateway install/materialize/remove、ssh apply 各一条负例；
  **undo 走同一条判定**（ssh `doUndo` → `applyPlugins` → `buildSshApplyRows` → `decide`；gateway undo 经
  remove 路由 → `validateSubmission` → `decide`）——由这两条链路的既有单测覆盖，**未**单列"受保护名 undo"负例；
- **读面投影**：`rows` 三端形状（role/protected/owner）+ 本地 `localPluginList` **行集 = 依赖表**（§6.11.5：`dependencies: {}` ⇒ 空行集；自己声明的组合/播种名仍是行，role/owner/保护位逐一断言）+ **掩码在 `dependencies` 与 `rows[].spec` 两通道一致**（本地红actor + gateway 投影同判据）+ wire 孪生字段集与**行类型**（producer↔preload↔renderer，C14 判据含字段名 + role/owner 字面量并集负例）+ **`diff.rows` 不含受保护名** + 旧后端无 `rows` 回退路径（golden 缺字段载荷不抛错、**官方/chamber 行整行不列出**）+ 受保护行与 bundle 层行均保持状态格中性；
- **上游保鲜门 C11–C14**：`scripts/upstream/plugin-protection-gate.test.mjs`（真实仓库正向断言 + 改坏派生来源/契约/注册表/镜像的负例），随 `pnpm run test:upgrade-tools` 进 CI；
- A gateway 子矩阵：spec 白名单族/**受保护集合判定（§6.11 的判定码 `protected`/`needs-version`/
  `needs-exact-version`/`generation-mismatch`/`protected-set-unavailable`/`runtime-version-unknown`；
  含降级阶梯与判序）**/**materialize 归档身份绑定**（自称名 ≠ 包内名 ⇒ 400 `identity_mismatch` 且不落盘；
  无 manifest/超大/不可解析 ⇒ 400 `tgz_invalid`）、**延迟意图**（`version` 持久化 → 排空可成；永久拒绝 ⇒
  丢弃意图 + 记 failed op，绝不静默僵尸）、**执行时复判**（提交后运行时切换 ⇒ 以逐 op 事实重判）、
  **装后复验**（跨代影子 ⇒ op 响亮失败、finding 名字存活于错误串、preImage 保留）/
  202 异步/批量 partial/remove 只删 installed 集内且执行时复核/
  profile_absent → deferred/profile_corrupt 诚实投影（r2 的 preImage 回滚列二期，v1 走 runbook）/queue_busy/queue_full/start 原语（停机态门 + 恢复门
  不被绕过 + 202/poll + 失败诚实）/上传流式上限与解包/任务面持久与对账（含投影无 childPid、file: spec 掩码）/
  读面栅栏一致/磁盘预检/生命周期排空
  （dispose/quiesce/stop kill 子进程测试）；并发强度以**慢关 spawn + 租约时序**证明（microtask-close 夹具
  测不到波浪续排与 queue_full）；
- 恢复面：停机态 remove/install、start 闭环、corrupt 回滚、journal 幂等、一致行移除回归（ssh/gateway）、
  故障注入（坏插件 boot 失败 → restart-exhausted → 停机移除 → start 恢复；corrupt → preImage 回滚）；
- desktop：gateway-provider/plugin-sync 扩展（上传+确认+取消 no-op+SPKI/--no-auth/隧道 Host 四态）、ipc-surface-mirror/golden + main handler 清单、ssh 统一增量（已安装列表 remove/受保护集合判定（装面保守）/journal 备份）单测；
- 实机门禁（发布前）：真实 gateway + 打包 desktop 全闭环、TLS+SPKI、多桌面、registry 实装（传递依赖网络 + lifecycle scripts 实测行为）、文件夹上传、partial、deferred、start 恢复、故障注入；scripts/env 实测结果回调 §6.3 纪律（§7 门禁）。
