# 21 · 统一插件管理模型与 gateway 连接对齐

> 插件管理在全仓只有**一份模型**（UI / 流程 / 差异语义 / 状态机 / 文案 / 恢复），ssh 与 gateway 是同一模型下的两个**执行后端**，分叉只发生在最终执行阶段。本文是模型与双后端**读面**契约的收敛权威；ssh 后端行为权威是 [13-remote-plugin-management.md](./13-remote-plugin-management.md)，gateway 形态见 [17-server-side-gateway.md](./17-server-side-gateway.md)，运行时管理见 [18-dsh-runtime-version.md](../runtime/18-dsh-runtime-version.md)，连接页/设置壳见 [05-connection-manager.md](../control-plane/05-connection-manager.md) §5/§7.4，seed 与 spawn 语义见 [02-host-management-deployment.md](../runtime/02-host-management-deployment.md) §2.6。

> **现行范围：本模型只有读面与供给面。** 用户插件写面（install / remove / materialize / undo / tasks）已从 chamber 代码整体移除，由上游 `@deepseek-ai/dsh-plugin-manager`（宿主包）与官方 `@deepseek-ai/dsh-client-ui-plugin-manager`（客户端行）承载；本仓保留 `GET /chamber/plugins/installed` 读投影、`GET/PUT /chamber/plugins` seed-cache、`desktop_*_plugin_list` 清单读取、`role`/`protected` 行投影与 `/chamber/runtime/{restart,start}` 动作。写面退役的发布叙事在 [`CHANGELOG.md`](../../../CHANGELOG.md)，不属本文契约。

## 1. 决定（现行口径）

编号是跨文档引用锚（其他设计按「design 21 决策 12/18/19」引用），不重排。

| # | 决定 | 口径 |
|---|---|---|
| 4 | 自动同步边界 | 仅 chamber 宿主包 ready 自动同步（供给面，§2.4）；第三方插件没有自动同步。 |
| 9 | 一致性原则 | 收敛为**单一模型、末段执行分叉**：不是「双通道各一套同权功能」，界面/逻辑层不得出现「if gateway … else if ssh …」的功能分叉，分叉只允许出现在后端实现与数据源内部。 |
| 12 | 停机恢复原语 | `POST /chamber/runtime/start`：仅 `stopped/error/restart-exhausted` 放行，202 + status 轮询（`start: running/ok/failed` + `operationError`，resolve ≠ success）；受 canStartLocal / exposureQuarantine / 恢复门（只开放各自 retry；restore-builtin 仅限 pending/健康选择，不得被 start 绕过）/ 单飞守卫；语义 = 受守卫 spawn，失败诚实投影。 |
| 15 | 共享模块 | gateway-runtime 纯核心（parse/action/gates/error 分类/poll）迁 `@dsh-chamber/dsh-chamber-client-core`（§5.2）。 |
| 16 | B 命名/图标 | 「连接日志」「网关主机日志」+ 图标去重；本地卡折叠区不改名（§4）。 |
| 18 | 掩码语义 | 读面把**路径类依赖值一律掩码**为 `MATERIALIZED_VALUE_MASK`，单一来源 = `@dsh-chamber/dsh-chamber-wire` 的 `plugin-manifest`（`PLUGIN_MATERIALIZED_VALUE_MASK` + `isMaterializedValue`；control-plane 公开面为其 re-export，desktop 经 facade 消费），保留 `file:` 前缀供 name 基 diff 与分类器；判据是共享的 `isMaterializedValue`，不只掩 `file:`——`link:`/相对/绝对/`~` 同样会暴露机器本地路径。生效点：gateway `readManifest`、ssh `redactRemotePluginManifest`、本地 IPC 经 `redactLocalPluginManifest`（`dependencies` 与 `rows[].spec` 两通道）。 |
| 19 | 受保护集合 | 拒绝集不按域名前缀猜，由**派生的受保护集合** `P = B₀ ∪ S ∪ F` 按事实判定（§6.11）：`B₀` = profile 安装自带组合（模板默认快照）、`S` = `CHAMBER_HOST_PACKAGES` 播种名、`F` = 运行时线族（已提交 `packages/desktop/vendor/dsh/pnpm-lock.yaml` 闭包中的 `@deepseek-ai/*`）。读面 `protected` 的唯一含义 = `name ∈ P`：官方 scope 的装面保守是写面/传输能力事实，不是读面事实；渲染端只消费投影 `role`/`protected`，不持有镜像谓词（§6.11.3/§6.11.5）。 |
| 20 | 信任声明 | 「已安装代码 = gateway 用户级等价」（进程隔离 ≠ 主体隔离）；OS 用户分离与安装期脚本硬化是二期。 |

## 2. 插件管理基线（只读面）

### 2.1 本地 profile 读面

`desktop_local_plugin_list`：主进程读本地 `<home>/profiles/web/package.json` 依赖投影 + `dsh.profile.bundles` 分类 + chamber 注入态版本，行集与保护位由 `derivePluginRows` 生成（§6.11.5）；IPC 层对 `dependencies` 与 `rows[].spec` 的路径类值掩码（决策 18）。写面 IPC（`desktop_local_plugin_add/add_file/remove` 与 `runLocalDshPlugin` 的 `dsh plugin add/remove` 执行）不存在，不得恢复。

### 2.2 ssh 远端读面

`desktop_ssh_plugin_list`：ssh `cat` 远端 profile `package.json` → `parseRemoteManifest` 投影（原始 spec 值，掩码在投影层）→ `derivePluginRows`；受保护集合只有 `B₀ ∪ S`（F 无远端来源）。远端 seed/exec 编排见 [13](./13-remote-plugin-management.md) §2/§3；ssh 的 apply/materialize/undo 不存在。

### 2.3 插件管理 UI（只读）

四个来源（本地 / ssh+dsh / gateway / http 直连）共用唯一 `PluginDialog`（`PluginDialog.tsx`，§6.6）。卡片按 `target.kind` 把数据源喂给同一对话框；gateway/http 直连区只读：已安装行投影 + sync 状态，无可执行后端。**插件差异/写面对账不存在**（`plugin-diff` 随「C 分层」写面退役，`computePluginDiff` 等无现行实现与消费者；受保护行只在读面 `rows[]` 只读呈现，§6.11.5）；`plugin-inventory-text` / `plugin-diagnostic` 纯投影（thirdPartyEntries 过滤 `@deepseek-ai/*` 与 chamber 注册表包，并排除调用方传入的注册表派生 expected 名单——这两个前缀分类器是 Loader 清单的展示分类，不是安装门）。「chamber 内置（注入）」表行集不写死包名，由控制面 `CHAMBER_HOST_PACKAGES` 经 desktop IPC 投影（`chamber.packages[]`）驱动；`remoteNeedsSeed`/重启提示/seed-cache 漂移/同步包表同样逐包派生（[13](./13-remote-plugin-management.md) §6）。行派生收敛为纯函数 `deriveChamberRows`（`plugin-inventory-text.ts`，只回 label KEY 与版本 STRING，组件只做 descriptor→JSX 映射），由 `test/plugin-inventory/chamber-rows.test.ts` 表驱动覆盖（含 LOCAL 目标读自身清单、空 expected 不谎报 seed-cache、不写死包名）。测试 = connections 纯模块文件，无组件级测试。

### 2.4 chamber 宿主包同步与 seed（供给面）

桌面 ready 自动 `syncGatewayChamberPlugins`（`gateway-provider.ts`；main 装配）；gateway `PUT/GET /chamber/plugins` 白名单缓存 chamber 宿主包（loader id 与包名一一对应：`client-graph` / `git-worktree` / `archive-cleanup`，`HOST_*_PACKAGE_NAME` ↔ `HOST_*_INSERT` ↔ `CHAMBER_HOST_PACKAGES` 三面一致由 C13 锁；gateway 侧 `plugins.ts` 白名单 + 大小上限；0700/0600/原子 no-follow；上传读体 8 MiB 上限在 `routes.ts` 的 `readUploadJsonBody`，不在 `plugins.ts`）。seed = extraneous + patch overlay（不进 package.json，`control-plane/index.ts`），每次 spawn（`start`/`restart` + 健康自动重启）前 seed thunk 重求值自愈（[02](../runtime/02-host-management-deployment.md) §2.6）；激活探针期望集按实际同步包逐包派生（`syncedHostDomainProbeNames` → `activationProbeNamesForDomains`；无二元 `hasSyncedHostSeed` gate——空缓存 = 基础缩减集，部分同步 = 已挂载域）。gateway 不打包任何 chamber 客户端插件；移动布局由上游 dsh 前端提供（[17](./17-server-side-gateway.md) §3/§10.2/§18）。

### 2.5 gateway 运行时受控重启

`POST /chamber/runtime/restart`（dispatch 无条件挂载、非 ready-gated；仅 ready/degraded 可重启；202 + status 轮询 restart running/ok/failed + operationError，resolve ≠ success，[18](../runtime/18-dsh-runtime-version.md) §9.3）：单飞 = manager 标志 + route 409 + `restartLocal` 与健康重启共用串行化（`local-connection.ts`）；激活事务（startup/apply-now/restore-builtin/回退路径）快照/回退覆盖整棵 dsh-home（`snapshotDshHome` 全树拷贝；`/restart` 本身 = `restartLocal` 受控 spawn、无快照）；settings dsh-runtime 段 gateway 分支经 renderer fetch + `pollGatewayReady`；其余 `/chamber/runtime/*` 动作面（status/versions/select/apply/apply-now/rollback/cleanup/restore-* 等）由 [18](../runtime/18-dsh-runtime-version.md) §9 拥有，本模型只链接。**互斥与生命周期**：runtime 写租约 `ProfileWriteLease`（`beginProfileWrite()` / `assertMutationIdle`，`runtime-manager.ts`）串行化 restart/apply 与健康自动重启，健康重启经 `beforeSpawnCheckpoint`（`spawn-checkpoint.ts`）检查同一把锁；激活事务（startup/apply-now/restore-builtin/回退）由 `executeStartupTransaction`（`runtime/startup-transaction.ts`）执行、以整棵 dsh-home 快照/回退收口。停机/错误/restart-exhausted 的恢复原语是 `/chamber/runtime/start`（决策 12，§6.2）；`restartLocal` 自身拒绝这三种状态。**托管 home**：gateway 托管实例的 home 固定为 `DSH_HOME=<stateDir>/dsh-home`（与桌面本地实例同构、互不共享）；profile 读为 `profiles/web`。

## 3. 一致性原则：单一模型，末段执行分叉

模型动词是后端无关的，UI 与流程只依赖它们；写动词（apply / materialize / undoJournal）不存在，用户写面由上游承载。

| 动词 | 语义与投影 | 分叉点（末段执行） |
|---|---|---|
| readManifest | profile 依赖投影（单一定义：name→spec（路径类值掩码）+ bundles + profileExists + corrupt/absent 码） | ssh：cat+parse；gateway：读自身 profile；local：读本地 profile |
| chamberProvision | chamber 宿主包与目标一致（供给面，不是插件模型写面） | ssh：ready 自动 + `seed_host_graph` 手动补种；gateway：ready 自动 PUT + 「立即同步」兜底 |
| restartToApply | 让运行实例装载宿主行变化 | ssh：`restart_service`（systemd）；gateway：`/chamber/runtime/restart`（202+poll）；本地实例在 dsh-runtime 段 |
| startFromStopped | 停机/错误/restart-exhausted 后回到可启动 | gateway：`/chamber/runtime/start`；ssh：`restart_service`（systemd 可启停）；本地：dsh-runtime/连接面 |
| loadedFacts | 已加载 Loader 事实行（只读、诊断） | gateway/http：实例代理 `pluginInventory`；ssh：无该面（Loader 不可达时不渲染，模型允许后端缺省可选面） |

**后端矩阵**：local（本地 profile，list 语义）、ssh（readManifest / seed / 只读已安装列表 / 受保护集合 `B₀ ∪ S`）、gateway（§6.2/§6.3 读面 + 供给面）、http+dsh 直连（无执行后端——无 `/chamber`、无 ssh exec、无管理面（[17](./17-server-side-gateway.md) §3），只读保留）。**目标语境差异**：gateway+ssh 卡的 systemd「重启实例」按钮属**连接管理面**（重启 gateway 服务本身），保留并改 tooltip/文案区分（§4/§5）；插件模型内无其他按目标的分叉。

## 4. B · 日志入口可区分

方案：环形缓冲入口与 Modal 标题「日志」→「连接日志」（说明行：本机侧连接通道事件——隧道/探针/握手验证等连接过程记录，覆盖 http 直连）；gateway 卡「主机日志」→「网关主机日志」（服务器侧 gateway 进程与托管 dsh spawn 日志）；本地卡折叠区「主机日志」不改名；service 行 Checklist（状态行）保留，但与两个日志入口视觉上明确区分。图标：插件入口（本地+远端）→ `IconFolderOpenOutlineRegular`；连接日志入口 → `IconSearchOutlineRegular`；网关主机日志保留 `IconDataOutlineRegular`；service 行保留 `IconChecklistOutlineRegular`（图标取仓内既有 primitives 导出）。键名稳定（`logs`/`hostLogs` 改值不改键），新增 `gatewayHostLogs`/`logsModalHint`/`gatewayHostLogsModalHint`；zh 源 + en 镜像，词典一致性由 typecheck（`Record<keyof typeof zh>`）保证；双语 README 变更需重录哈希。B 以键名 + 文案 + 图标三重区分交付。

## 5. C · gateway「重启 dsh」入口

### 5.1 位置与门控

gateway 卡连接/断开按钮旁文本按钮「重启 dsh」，仅 phase ∈ {ready, degraded} 可用，busy[id] 禁用；统一插件模型视图（对话框）chamber 区/动作条提供「重启生效」（同动作）。gateway+ssh 卡 systemd「重启实例」（重启 gateway 服务本身）保留，tooltip 注明「重启 gateway 服务（systemd）」，且**两按钮并排文案可见区分**（label 级，非仅 tooltip）；卡片 268px 网格宽度紧张时 systemd 起停并入 foot 图标。多用户文案（P1）：gateway 通道的重启确认必须注明「该 Gateway 上的其他用户会话也会短暂断开」；该文案在 connections 卡片重启确认与 settings-bridge runtime 段 gateway 源重启确认（专用键 `dshRuntimeRestartGatewayConfirm`，zh/en 成对、含多用户中断披露）两处落地；视图面板「重启生效」为直发动作（不弹确认）。确认 Modal 后 `POST /api/i/gateway-<id>/chamber/runtime/restart`，仅 202 接受；409/400 → `body.error` 逐字。轮询语义与 `pollGatewayReady` 精确一致（1s/120s；restart failed / connectionState ∈ {error, restart-exhausted, stopped} 失败；`ok` 或旧网关 ready/degraded 回退；401/403/404 快失败；超时诚实投影）。每卡单飞（per-id）；成功/失败刷新卡片与视图 Loader 清单。桌面零改动（既有反代，auth 主进程注入）。

### 5.2 共享模块迁移

split 而非 move：`gateway-runtime-api.ts` 中仅 parse/action/gates/error 分类/poll 为纯核心；`remoteRuntimeStatusView` + `RemoteRuntimeStatusView` 引用 SettingsBridgeKey 留在 settings-bridge（与 REMOTE_PHASES/BLOCKED_PHASES 共享部分以 shared 导出形式回引）。纯核心 + `gateway-runtime-poll.ts` 迁 `@dsh-chamber/dsh-chamber-client-core`（`exports` 具名面 → `src/*.ts`，免构建；renderer/settings-bridge/connections/layout/git 均为既有消费者；vite 共享单实例）。**不设手写 ambient 镜像**：消费者对真源做 typecheck（root tsconfig 不为它声明 `paths`；workspace 链接 + client-core `exports` 直接解析到 `packages/dsh-chamber-client-core/src/index.ts`，各 tsconfig 补 `rootDir: "../.."` 避免 TS6059）；settings-bridge 保留自身 connections-section paths。`RemoteRuntimeStatus`（33 字段，30 必填+3 可选）/parse/gates/Error/poll 符号随 shared 真源直接可见。poll 的英文错误串随迁（connections 会显示未本地化文案，见 §7 已知偏差）。测试：`pollGatewayReady` 用例驻 settings-bridge/test/runtime/runtime-management.test.ts；`gateway-runtime-api.test.ts` 按 split 拆（view 留 settings-bridge，核心随迁）；settings-bridge/sidebar 两个 test 清单同步；test:renderer-shell 无迁移文件（测试矩阵见 §9）。

### 5.3 键表

键的单一来源是 connections 与 settings-bridge 的 zh locale 词典（en 镜像；`verify:i18n` 校验）。语义契约：重启动作键族 `restartManagedDsh*` 覆盖「重启 dsh」按钮/提示/标题/确认（确认描述含**该 Gateway 上其他用户会话**短暂断开披露）/busy/ok/accepted/未连接态；`restartApplyInPanel` = 视图面板「重启生效」；`restartGatewayService` / `restartServiceTip` = gateway+ssh 的 systemd 按钮（label 与 tooltip 均与 dsh 目标的 `restartInstance` 区分）；settings-bridge 的 `dshRuntimeRestartGatewayConfirm` 另含多用户中断披露，与既有 `dshRuntimeRestartAction/Restarting/Restarted/RestartConfirm` 同族、不得重复造词。http+dsh 直连无按钮。

## 6. A · 统一插件管理模型（读面）

### 6.1 边界与姿态

- 自动同步仅 chamber 宿主包（§2.4）；第三方插件没有自动同步。
- 读面统一：受保护集合投影与「已安装」行集在三端是同一份 `P` 定义与同一条投影契约（§6.11/§6.11.5；ssh 读面收敛见 §6.4），不得各自发明拒绝集。
- 用户插件写面由上游承载，本模型不含安装/卸载/撤销动作与执行器。

### 6.2 gateway 后端路由契约（只读 + 供给 + 运行时动作）

| 路由 | 语义 |
|---|---|
| `GET /chamber/plugins` | chamber 宿主包种子缓存投影（§2.4） |
| `PUT /chamber/plugins` | 桌面同步 chamber 宿主包的供给面（白名单 + 大小上限；上传读体 8 MiB 上限在 `routes.ts` `readUploadJsonBody`，见 §2.4） |
| `GET /chamber/plugins/installed` | 模型 `readManifest` 的 gateway 实现（`packages/gateway/src/plugins-installed.ts`）：`{dependencies: name→spec（路径类值以 wire 单源的 MATERIALIZED_VALUE_MASK / isMaterializedValue 掩码，保留 `file:` 前缀供 name 基 diff；gateway 本地路径不进 renderer）, rows: PluginRow[], profileExists, error?}`（**加性**：`dependencies` 语义不变；`rows` = §6.11.5 的读面投影 `{name, spec\|null, version\|null, role, protected}`；`dsh.profile.bundles` 只作服务端 role 分类器，不随投影下发）。**只读**：200 profile 存在 / 404 `{error:'managed profile is not initialized', code:'profile_absent'}` / 500 `{error:'managed profile is corrupted', code:'profile_corrupt'}`（细节仅宿主日志）；method GET-only 405；不查询写栅栏、不产生 `runtime_busy`/`write_fence_unavailable`；停机/错误实例照常 200/404（manifest 读，不是运行时状态）。受保护集合由**服务端**计算并投影（服务端是 gateway 目标的判定权威，§6.11）。 |
| `POST /chamber/runtime/start` | 停机恢复原语（决策 12）：仅 `stopped/error/restart-exhausted` 允许；202 + status 轮询（复用 restart 语义面）；受 canStartLocal/exposureQuarantine/恢复门/单飞守卫；语义 = 受守卫 spawn，失败诚实投影。 |

per-route 读面验收见 gateway 既有测试（`packages/gateway/test/chamber-surface/`）与 [`gui-acceptance-checklist.md`](../../checklists/acceptance/gui-acceptance-checklist.md)。

### 6.3 gateway 读面实现（无执行器）

`plugins-installed.ts` 是纯读实现：不取租约、不排空队列、无 journal/备份/tasks/undo，也不起安装子进程；读面失败只有 `profile_absent`/`profile_corrupt` 两码。写面执行器、环境白名单、preImage 备份与插件 writer-barrier 都不存在（写面退役记录见 `CHANGELOG.md`）。

### 6.4 ssh 后端读面收敛

ssh 读面与 gateway/local 同形：`readManifest` = `plugin_list` IPC（cat 远端 profile `package.json` → `parseRemoteManifest` 投影，路径类值掩码同 §6.11.5）。本地 `local_plugin_list` 经 `shell-ipc-plugins-local.ts` 的 `redactLocalPluginManifest` 掩 `dependencies` 与 `rows[].spec` 两通道。写动词与 ssh 形态的受保护集合判定不存在（[13](./13-remote-plugin-management.md) §1/§5）。

### 6.5 桌面 IPC / 渲染层（读面与供给面）

保留：`gateway_plugin_sync(id)`（手动同步兜底：id 白名单 + ready 复核 + `{ok:true,uploaded,skipped}|{ok:false,error}`）、`desktop_ssh_plugin_list`、`desktop_local_plugin_list`、`desktop_ssh_seed_host_graph`，以及实例代理 `GET /chamber/plugins`、`GET /chamber/plugins/installed`（驱动 chamber 区版本漂移与「立即同步」；gatewaySource 门控，http+dsh 只读）。同步失败必须显式化：非 200 与网络异常返回 `{failed:true,error}` 并映射 `ok:false`（「已是最新」不得吞失败）；`PUT /chamber/plugins` 的校验拒绝回显脱敏原因（`sanitizeRouteError`，≤300B，不落裸 HTTP 400）。`gateway_plugin_apply`/`gateway_plugin_materialize` 与 ssh undo journal/IPC 不存在。新增 IPC 仍按镜像面纪律同批改 preload/ipc-events/global.d.ts 与 ipc-surface-mirror golden（[05](../control-plane/05-connection-manager.md) §7.4）。

### 6.6 UI：单一模型视图（只读行/诊断）

`PluginDialog.tsx`（connections 包）是唯一插件对话框：local / ssh+dsh / gateway / http 直连四来源共用同一组件，区域顺序 = 诊断横幅（bannerProjection 去重）→ chamber 内建表（registry 驱动的宿主包行，清单 = `CHAMBER_HOST_PACKAGES`；其中 `localOnly` 行：该行只列在本地目标，非本地目标的行集 = 该目标适用行（`applicableChamberPackages` ⇒ local 4 行、ssh/gateway/http 3 行）→ 第三方区（已安装只读行 + 生效状态 chips）→ 状态/诊断行；http 直连只读。

- **受保护行只读呈现**：角色徽标 + 受保护提示 + 无移除按钮；判定码→本地化文案映射未做，服务端 `error` 逐字显示（§7）。
- **第三方行生效状态**：local/gateway/http 已安装列表含生效状态 chips（Loader `pluginInventory` 快照按 `moduleName === 包名` **精确匹配**：生效中/加载中/加载失败/已停用；本地实例经 `/api/i/local` 读快照，读失败静默置中性——清单文件永远不作 live 断言）。**无同名 entry 一律中性**：bundle 层行（本地 `localList.bundles` / 服务端 `rows[].role` 分类的行）也不例外——bundle 包名从不是 Loader 行，树由各 bundle 的 `dsh.bundle.patch` 叠在空 entry 根上，行是 `insert:` 名字而非 bundle 自己，故「查无同名行」不携带「重启后生效」信息；plain/client-only 依赖同样中性。bundle 层行「是否已生效」没有可判事实，**中性是当前上限**（闭合路径见 §7）。
- **已知边界**：who/when 归因 tooltip 尚未渲染（TaskRow 未投影 initiator）；预置未用键（`blockedTask`/`queueBusy`/`lastFailedHint`/`reservedNameRefused`/`opAttribution*`/`startManagedDshConfirmTitle`）待归口接线或删除；gateway 拒绝码→本地化文案映射未做（逐字英文，登记接受）——见 §7。

### 6.7 安全模型

- 既有全权 auth；渲染层不持凭据（主进程注入）；主进程确认 = 桌面通道纪律，不加服务端 admission。
- 读面：manifest 路径类值按 wire 单源掩码（§6.11.5）；受保护集合判定单一实现（control-plane `protected-plugins.ts`，§6.11，只服务 `rows` 投影）；渲染端只消费投影 `role`/`protected`，后端才是权威；日志脱敏（凭据零进入）。
- 信任声明（决策 20）：「已安装代码 = gateway 用户级等价」（进程隔离 ≠ 主体隔离；同用户可读 stateDir 0600 jwt-secret 等）；安装期脚本风险登记；二期硬化：ignore-scripts/逐包放行、OS 用户分离。
- 多桌面：last-writer-wins 与 who/when 归因（连接 label 级，不进日志）；per-principal 角色扩展时插件读取面与 runtime 写路由同属 operator-scope（[18](../runtime/18-dsh-runtime-version.md) 先例）。

### 6.8 故障域与恢复

- 故障域：插件代码执行在托管 dsh 实例进程/前端（进程隔离）；`/chamber` 管理面挂宿主、非 ready-gated——实例崩溃/停机时管理面存活；可能伤宿主的仅机器级资源与 profile 元数据损坏。
- 分层兜底：client 插件页面级（Loader fiber failed）；host 插件进程级（健康自动重启窗口 → restart-exhausted）；corrupt → `profile_corrupt`；seed（host 包 extraneous + 每次 spawn 前 seed thunk 自愈，免疫）。
- 恢复阶梯：r0 实例存活（读面照常）；r1 停机（stopped/error/restart-exhausted）→ `POST /chamber/runtime/start`（决策 12；卡片/视图给明确动作，失败诚实回 error + 提示，可再次查看连接日志）；r2 profile 损坏 → 诚实投影 `profile_corrupt`（GET installed 500）+ 视图横幅 + 停机态 `start`；无备份时走 operator runbook（从 `<stateDir>/dsh-runtime/snapshots/` 手工恢复 dsh-home 快照）；r3 脚本风险登记（决策 20；恢复阶梯不承诺覆盖安装在 dsh-home 之外的持久物）；r4 宿主不可达 = 机器级 runbook（`gateway plugin` 操作员子命令仍二期；现 CLI 除 serve 外只有 `gateway auth` 的 status/reset-password/clear）。
- 恢复判据：视图「已加载」Loader 事实行 + 状态行（重启前 active / 移除后消失）为细节证据；成功文案用自然语言（「实例已重新就绪」），不把 Loader 行当面向用户的判据。

### 6.9 工程默认与配额

读面不设任务面/队列/上传配额；受保护集合判定模型层单一实现 + C11–C14 上游保鲜门（§6.11；判据散文与代码判据同步，结构数据单一来源 = `scripts/upstream/registry/registry.json`，[`upstream-touchpoints.md`](../../checklists/upgrade/upstream-touchpoints.md) §2/§9 由其生成）；profile 读的掩码/行投影与本地同判据（§6.11.5）。

### 6.10 明确不做

http+dsh 直连插件管理（无执行后端）；gateway 编排面回流；控制面实现执行面；非插件资产远程写；chamber 移动端参与第三方管理；安装期脚本默认禁行与 OS 用户隔离（二期硬化，非 v1）。

### 6.11 受保护集合与代耦合

**动机**：拒绝集不能按域名前缀猜（挡住官方 opt-in 层、挡不住组合被拆/族成员被跨代副本 shadow，且随上游改名失真）。规则按**目标实例的可验证事实**派生，对 install/remove 分相；现行只服务读面 `role`/`protected` 投影。

#### 6.11.1 P 的定义（唯一权威）

```
P(instance) = B₀ ∪ S ∪ F
```

| 分量 | 定义 | 单一来源 | 明确排除（易混淆项） |
|---|---|---|---|
| **B₀** | profile 的**安装自带组合**：web 模板默认 + installation-owned 元组 | 本仓快照常量 `PROFILE_BUNDLES_SNAPSHOT = ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']`，对拍上游 `PROFILE_TEMPLATES.web.bundles`（C12） | live `dsh.profile.bundles` 不参与保护判定（见 6.11.2） |
| **S** | chamber 播种物包名 | `CHAMBER_HOST_PACKAGES[].insert.name`（`control-plane/src/host-graph-seed.ts`，双端可达；结构门 C13） | 旧别名 `@dsh-chamber/dsh-host-*` 不在 S 内（非播种面） |
| **F** | 运行时线族：运行时闭包中的 `@deepseek-ai/*` | **已提交**的 `packages/desktop/vendor/dsh/pnpm-lock.yaml` 闭包（平台无关，C11）；实例侧 `node_modules/@deepseek-ai/*` 仅作等价性交叉校验（允许差集 = 其他平台 `node-addon-system-*` / `libreoffice-kit-*`） | 源码线 `vendor/harness-packages`（含 opt-in 段与 dev 包）；`<dsh-home>/profiles/node_modules` 的 module-fallback 农场（上游 `healProfilesModuleFallback` 维护，会残留上一代死名）；profile 自己的 node_modules |

**事实源可达性**：local/gateway 两侧都能算出完整 P（B₀/S 是常量与注册表，F 由活动 workspace 派生，版本由 `resolveActiveRuntime()` / gateway `manager.resolveWorkspace()` 给出）；ssh 只有 `B₀ ∪ S`（F 无远端来源）。派生入口：local = `shell-core.ts` 的 `localProtectionFacts()`（产出 `PluginProtectionFacts{ familyNames, familySource: 'runtime' | 'none' }`）；ssh = `sshProtectionFacts()`（`{ familyNames: null, familySource: 'none' }`）；gateway = `plugins-installed.ts` 的 `protectedSetFromFamily(resolveRuntimeFamily(facts.path))`。F 解析失败 ⇒ `familyNames` 缺席 ⇒ 读面降级到 `B₀ ∪ S`（`protectedSetState` 的 `degraded` 位，只收紧不放松），绝不把空集当「没有保护」。`familyNames` 是**名字集合**；F 读不到时 `familyNames: null` —— 绝不把「派生失败」退化成「没有保护」。

#### 6.11.2 为什么 B 取 B₀ 而不取 live bundles

上游 `dsh plugin` 是 pnpm 转发器：解析到 `dsh.bundle.patch` 的依赖会被重算进 `dsh.profile.bundles`（上游 `apps/cli/src/plugin.ts`，C12 守此契约），故 `B = live bundles` 会让每次安装都把被装物变成受保护项：装层 → 层进入 bundles → `name ∈ P` → remove 被拒 ⇒ 装得上、卸不掉。故 live bundles 只用于渲染 `role`（`∈ B₀ → composition`；`∈ liveBundles \ B₀ → layer`），保护判定用 B₀——「不许拆组合」只保护安装自带的基线组合，不保护用户自己加的层。

#### 6.11.3 读面判定规则（`role`/`protected`）

- `protected = name ∈ P`，且**唯一含义**是「name ∈ P」（不是「这个后端装不了它」）：官方 scope 的装面保守是写面/传输能力事实，写面不存在后不在读面撒谎；因此 ssh 上不在 P 内的官方行仍 `protected: false`。
- `role` 分类（`derivePluginRows`，输入 `dependencies`/`bundles`/B₀/S）：`seed`（name ∈ S）→ `composition`（name ∈ B₀）→ `layer`（name ∈ live bundles）→ `materialized`（spec 是 materialize 值）→ `third-party`。
- P 不可派生时：行仍按事实投影（role 照算，`protected` 全 false；`derivePluginRows({protectedSet:null})`），读面不因缺 F 而静默扩大或收窄保护面。
- **P 的分量示例**：`B₀` = 模板默认组合快照（`PROFILE_BUNDLES_SNAPSHOT`，如 `@deepseek-ai/dsh-base` / `dsh-web-app`）；`S` = `@dsh-chamber/*` 播种包；`F` = 运行时闭包中的 `@deepseek-ai/*`；官方 opt-in 层 `@deepseek-ai/dsh-experimental-*` 由 C11 白名单判据（`runtime-family.ts` 的 `RUNTIME_FAMILY_OPT_IN_ALLOWED`）判定是否可信进入闭包；渲染端不持有镜像谓词，只消费投影 `rows[].protected`。
- `deriveProtectedSet` 失败判据：任一分量出现非字符串/空名、F 为空集、或三分量全空 ⇒ `ok:false`（绝不返回「有效的空保护集」）。

#### 6.11.4 F 事实源与可信性

- 来源选择（候选顺序）：**内建锚锁文件 → 活动树自己的 `pnpm-lock.yaml` → 树枚举兜底**。内建锚（`pinnedLockfilePath`）只在**活动运行时与内建线同版**时交给 `resolveRuntimeFamily`（`shouldPreferPinnedRuntimeLockfile`，`plugin-sync.ts`）；用户选装运行时（[18](../runtime/18-dsh-runtime-version.md) §3.6）用活动树自己的锁文件。**唯一例外 = 显式 env 覆盖兜底**（`shell-core.ts` 的 `localProtectionFacts`）：活动树与内建线不同版、自身事实源解析失败、且 `resolved.source === 'env'`（`DSH_CHAMBER_DSH_PATH` 开发者覆盖）时带内建锚重试一次；`'user'`（用户自选已发布运行时）永不享受。gateway 没有内建锚，直接用自身 workspace 锁文件。
- 可信性判据：核心锚齐全、不含禁名（与 C11 同源），且名称解析出的闭包必须也解析出版本——两个解析器对同一批键矛盾（`the name and version parsers disagree about the same keys`）即拒绝该来源。树枚举是刻意例外：不要求版本事实（目录名即其用途；「空目录树可作 F」的既有 pin 依赖它）。
- 家族版本事实（name→version 集合）随解析保留，但读面只消费名字集合（`protected` 判定不需要版本）。
- F 的**版本事实**：锁文件来源按 `name@version(peer 依赖后缀)` 取版本段、树枚举来源读该包自己的 `package.json`，读不到就不登记该名字的版本（绝不猜）；名称解析出的闭包必须也解析出版本，两解析器对同一批键矛盾即拒绝该来源。读面只消费名字集合，版本事实不参与 `protected`。
- 本地读面每次清单 IPC 读取时求值，锁文件解析（≤512 KiB）由 memo 挡住（key = 活动树 + 版本 + 来源、锚选择、两个候选锁文件的 mtime+size）。

#### 6.11.5 读面投影契约（读写分离）

- 三端都投影 **`rows: PluginRow[]`**（加性；`dependencies` 语义不变，避免污染 name 基 diff；远端 manifest 不再下发 `bundles`——gateway/ssh 只把它当服务端 role 分类器，本地 `localPluginList.bundles` 仍作本地行分类输入）：`{ name, spec: string|null, version: string|null, role: 'composition'|'seed'|'layer'|'third-party'|'materialized'|'unknown', protected: boolean }`。
- **谁能算 P 谁投影 `protected`**：local = desktop main；gateway = 服务端（判定权威；desktop 侧只做形状校验 + 消费投影，不自行重算 P——F 在服务端）；ssh = desktop main（P = B₀ ∪ S）。
- **行集 = profile 的依赖表，一行一条**（取代并集投影）：`bundles` / B₀ / S 只作 `role` 分类器与保护判定输入，**不凭空造行**。「已安装」= 装进 profile 的插件；chamber 播种物在「chamber 受管组件」表里已有自己的行（探针状态 + 版本 + 手动重推）；官方组合是运行时基线而非插件行（组合成员在 profile 目录里不存在，版本列只能显示 `—`）；空 `dependencies` 的 profile 不列 B₀ ∪ S 整组「自带」包。受保护名若确实在依赖表里仍是行且只读可见。
- **路径类值掩码两通道一致**：`dependencies` 与 `rows[].spec` 用同一条 mask 规则（后端各传自己的 maskSpec；local 的 IPC 层在 `redactLocalPluginManifest` 后投影）。role 恒按**原值**分类。
- 渲染端只渲染：不持有 `isDeniedPluginName` 之类镜像；`plugin-inventory-text.ts` 的 `OFFICIAL_SCOPE`/`CHAMBER_CLIENT_PREFIX` 保留为 Loader 清单展示分类（非安装门）。受保护行只读可见（无移除按钮 + 提示 + 角色徽标）。
- `rows` 缺失/非数组按**显式空投影**处理（绝不回落到 `dependencies` 过滤——那会让渲染端重新持有保护判定镜像）。

#### 6.11.6 抗漂移门禁（C11–C14）

判据纯函数 `scripts/upstream/verify/plugin-protection-gate.mjs`，登记在 [`upstream-touchpoints.md`](../../checklists/upgrade/upstream-touchpoints.md) §6，负例测试随 `pnpm run test:upgrade-tools`：

| 门 | 断言 | 红意味着 |
|---|---|---|
| **C11** | 运行时线闭包含核心（`dsh`/`dsh-base`/`dsh-web-app`）、不含 dev/test 包、官方 `dsh-experimental-*` 按登记白名单双向判定（未登记红 / 已登记缺席红）；实例树物化时枚举 == 闭包 − 其他平台 `node-addon-system-*`/`libreoffice-kit-*`。核心/禁名判据与锁文件解析器直接 import 运行时模块（`protected-plugins.ts`，单一来源）；门禁另有 ≥200 名的解析健全性下限（CI 专属）；本门只判名字集 | F 来源选错（如误用含 opt-in 段的源码线 vendor 树）或上游族集合漂移 ⇒ 停升级、改派生 |
| **C12** | 上游源码仍以 `dsh.profile.bundles` 承载层列表、以 `dsh.bundle.patch` 声明层、web 模板默认组合不变、profile workspace 仍是 `nodeLinker: hoisted` + `autoInstallPeers: false`（`pnpm-workspace.yaml`，由上游 `initProfile` 写） | 上游改 profile 格式/默认组合/链接器 ⇒ 停升级，改 B₀ 快照与派生 |
| **C13** | `HOST_*_PACKAGE_NAME` ↔ `HOST_*_INSERT` ↔ `CHAMBER_HOST_PACKAGES` 三面一一对应 | 策略与播种机制脱节（S 分量失真） |
| **C14** | 宿主 manifest 字段集三方一致（`plugin-sync.ts` producer ↔ `preload.cts` ↔ `renderer/src/global.d.ts`）；行类型单源：`@dsh-chamber/dsh-chamber-wire/plugin-row` 是 `PluginRow`/`PluginRowRole` 唯一定义，五个消费方（control-plane、client-core pass-through、`preload.cts`、renderer `global.d.ts`、settings-connections）只 import/export type 且绑定期待名——本地同名重声明或引用面漂移即红 | 约束投影与行模型漂移（ipc-surface-mirror 只覆盖宿主接口面；行类型从三方文本镜像改为单源+禁重声明） |

四层合起来：上游怎么变，最坏是「装卸暂停 + 门禁红」，不会是「静默拆组合」。

#### 6.11.7 兼容与版本歪斜

- 同版本发行裁决：gateway 与前端同源发行，control-plane `derivePluginRows` 恒投影 `rows`；旧就地 gateway 无 `rows` 的回退分支已删除，渲染端把缺失/非数组的 `rows` 读作显式空投影（绝不回落到 `dependencies` 过滤）。旧 desktop + 新 gateway 忽略未知的加性字段。
- 就地部署需先把 gateway 更新到本版；兼容声明写在 `CHANGELOG.md` 发布时。

#### 6.11.8 注册在案的偏差

- **ssh 装面保守**（6.11.3 的 ssh 行）：相对同代口径是显式不对称；放开需先给 ssh 加远端 family 读（扩 exec 面，[13](./13-remote-plugin-management.md) §7.2 纪律，单独评审）。
- **代不匹配默认阻断**（跨代试验需显式 override 入口，v1 未提供）、**闭包豁免只从官方 scope 的直接依赖起步且 walk 只展开官方节点**（收紧；第三方夹带官方名、官方层经第三方中介均报 `outside-family`）。
- **bundles-only 层只走 CLI**（§6.11.5 读面投影契约的必然结果）：只在 live `dsh.profile.bundles` 而不在依赖表里的层不成行，页内无移除入口（CLI `dsh plugin remove` 照旧可用），但仍会被 Loader 挂载；上游 `reconcilePlugins` 只从依赖表补层、模板自带组合 "never touched"，故只可能命中手工编辑过 profile 的历史条目。放开条件 = 页内补一条只读的 bundles-only 行。

**现行细节补遗（单源已列之外的契约级事实）**：本模型只服务 `{kind:'dsh', transport:'ssh'}` 的 ssh 插件面与 gateway 读/供给面；spec/name 白名单族的唯一来源仍是 `packages/control-plane/src/plugin-spec.ts`（desktop 经 facade 消费，ssh-provider 不得重声明——parity 测试锁）。读面清单/行投影的供给：远端 `cordis.patch.yml` 只做 loader insert（`plugin-sync.seedRemoteChamberHostPackages`，绝不经插件模型写面）；readManifest 的 `dependencies` 形状 = `{name, spec}`（spec 为掩码后字符串），`rows` = 依赖表逐行投影（§6.11.5）。插件刷新状态由宿主插件管理器报告 `application:'applied'` / `restart-required`；页面侧热同步（含 `restart-window-reload` 不存在、rev 变化需手动重载）见 [09](../client/09-client-plugin-runtime-loading.md) §3.7。供给面 IPC 结果类型 `GatewayPluginSyncIpcResult`（renderer `global.d.ts` 镜像）承载 `{ok:true,uploaded,skipped}|{ok:false,error}`。上游保鲜门脚本 = `scripts/upstream/verify/verify-upstream-touchpoints.mjs`（C11–C14），判据纯函数 `plugin-protection-gate.mjs`；P 的分量示例（`@deepseek-ai/dsh-base@…` 等）见 §6.11.1。`familySource` 取值 = `'runtime' | 'none'`（缺省 runtime；ssh 恒 none）；F 读不到时降级到 `B₀ ∪ S`（只收紧不放松）。

## 7. 决策遗留 / 开放项

开放项的权威清单与状态在 [`STATUS.md`](../../progress/STATUS.md)；本节只留契约性决策遗留。

- **受保护集合与代耦合**（§6.11）：ssh 装面放开需先给 ssh 加远端 family 读（扩 exec 面，[13](./13-remote-plugin-management.md) §7.2 纪律，单独评审）；跨代 override 入口 v1 默认阻断且不提供；snapshot restore 路由仍二期。
- **本地面载的已知边角**：scripts 默认允许下 `dsh plugin add` 的 pnpm 是否读取 profile/.npmrc、是否向子进程暴露 npm 令牌环境——据实收紧（不允许扩大暴露）。
- **`GET /chamber/plugins/installed` 只读**：不施加 `runtime_busy` 退避（客户端无需短退避重试）。
- **实机 E2E 矩阵（ssh+gateway 双通道）**：发布前按 §9 执行；archive-pick 的 Windows/Linux 腿随桌面腿冻结（[`electron-frozen.md`](../../progress/electron-frozen.md)），不在范围。
- **已发布 gateway 发行树的 `dist/index.js` 可能仍是旧的 executor env pin**（重装/重打包即复发）：正式修复须随 HEAD 版本树部署后按 §9 矩阵复跑。
- **打包与产物面**：`packages/desktop/dist/web/**` 与 `dist/host-*-package/**` 由 packaging closure 与产物新鲜度守卫覆盖；`scripts/gates/checks/compiled-sidecar-smoke.mjs` 以编译 sidecar 启动应答打印 `SMOKE PASS`（冒烟门）；`pnpm-workspace.yaml` 的 `allowBuilds` 只约束依赖构建脚本、不扩到 chamber workspace 包。
- **产物新鲜度守卫覆盖面**：`packages/desktop/dist/control-plane/**` 与 `packages/gateway/dist/**` 有「存在但缺当前标记 ⇒ 失败」的标记守卫（缺失才按需构建，绝不静默自愈）；`scripts/gates/checks/verify-artifact-freshness.mjs`（非注册门：tests/CI 在构建前跑、无产物可比；发布 checklist 在构建后以 `--require-compare` 手动跑一次）覆盖 `dist/preload.cjs`、`renderer/src/generated/**` 与 `gateway/dist/index.js`（包自身 `scripts/build.mjs` 临时副本重建后逐字节比对）；seed `dist/index.js` ×4 + `dsh-runtime/dist/index.js` 的新鲜度由 C8 独占（清单单一来源 `scripts/lib/build-artifacts.mjs`）；`verify-electron-artifacts.mjs` 执行编译产物冒烟。仍未落地的最小守卫建议（G2/G3/G5/G7/G8；G1 `verify:test-wiring`）见 [`TODO.md`](../../progress/TODO.md) D§2。
- **gateway 拒绝码→本地化文案映射未做**（已知偏差，见 §7）：范围是现行读面错误码；预置未用键待归口接线或删除（§6.6）。
- **受保护名的只读行覆盖**：`packages/gateway/test/chamber-surface/chamber-installed.test.ts`（受保护名仍分类为 protected/只读）+ ssh 侧既有链路单测，见 §6.11 矩阵。
- **bundle 层「是否已生效」无诚实信号**（§6.6）：无同名 Loader entry 一律中性，刚装未重启与已生效同呈现；闭合路径 = 新增宿主面事实（各 bundle 的 `dsh.bundle.patch` 的 `insert[].name`），渲染端拿它与 Loader 快照求交后才谈得上「生效中 / 重启后生效」——属新宿主面，需单独评审。

## 8. 与既有文档的关系

- [13](./13-remote-plugin-management.md) 是 ssh 后端既有行为的权威契约；本文是模型与双后端读面契约的收敛权威（§3）——ssh 读面（只读已安装列表、受保护集合 `B₀ ∪ S`、清单掩码）落在 13 §4/§6/§7。
- 受保护集合与代耦合的上游保鲜门 C11–C14 登记在 [`upstream-touchpoints.md`](../../checklists/upgrade/upstream-touchpoints.md) §6（机器侧判据 `scripts/upstream/verify/plugin-protection-gate.mjs`，负例测试随 `pnpm run test:upgrade-tools`；升级流程引用在 [`dsh-upgrade-checklist.md`](../../checklists/upgrade/dsh-upgrade-checklist.md) §0/§6）——与本文 §6.11 同源，改动时三侧同步。
- [17](./17-server-side-gateway.md)：§3 能力表含第三方插件管理行与 dsh 直连（ssh/http）不挂载 dsh-runtime 分节；`/chamber/plugins/*` 写面与 §10 编排面剥离后的存活面一致。
- [18](../runtime/18-dsh-runtime-version.md)：§6 出网面登记「安装子进程随宿主受控出网」；§9.3 含 `start` 原语行、connections 入口与 restart-exhausted 自动回退衔接。
- [05](../control-plane/05-connection-manager.md) §5：内容清单（日志命名、重启/启动按钮、单一模型视图与已安装列表、恢复提示行）；[02](../runtime/02-host-management-deployment.md)：seed 与 spawn 语义（§2.4）。

## 9. 验证与测试矩阵

- B/C：`test:connections`（投影/门控/结果分类）、`typecheck:connections`、`verify:i18n`（仅 README 对）；共享模块：`test:sidebar` + `test:settings-bridge`（随迁/拆 split/清单同步；renderer-shell 无迁移项）；模型层（纯 node 无依赖）：后端分派表（含不支持组合）与 `pollGatewayReady` 用例。
- **受保护集合矩阵（§6.11；纯函数，本地与 gateway 双跑）**：读面 `protected` 判定（name ∈ P ⇒ protected）；来源可信性（解析器矛盾 ⇒ 拒来源；树枚举不要求版本事实，空目录树可作 F）；内建锚仅活动运行时与内建线同版时使用（`shouldPreferPinnedRuntimeLockfile`；env 覆盖兜底仅自身解析失败时生效，`'user'` 不享受）；B₀ 与 live bundles 分离；P 不可派生的降级（行照投、protected 全 false）；路径/registry 值判据（`file:`/`link:`/相对/绝对/`~/`/`C:\` = materialize；`~1.2.0`/`^`/`>=`/`1.x`/dist-tag/workspace/npm 别名/git·url = registry）。
- **读面投影**：`rows` 三端形状（role/protected）+ 本地 `localPluginList` 行集 = 依赖表（`dependencies: {}` ⇒ 空行集；自己声明的组合/播种名仍是行，role/保护位逐一断言）+ 掩码在 `dependencies` 与 `rows[].spec` 两通道一致 + wire 孪生字段集与行类型（producer↔preload↔renderer，C14 判据含字段名 + role 字面量并集负例）+ rows 缺失按显式空投影（不回退、不列行）+ 受保护行与 bundle 层行均保持状态格中性。
- **上游保鲜门 C11–C14**：`scripts/upstream/verify/plugin-protection-gate.test.mjs`（真实仓库正向断言 + 改坏派生来源/契约/注册表/镜像的负例），随 `pnpm run test:upgrade-tools` 进 CI。
- gateway 读面/动作面子矩阵：`GET /chamber/plugins/installed` 的 200/404/500/405 与投影形状（`packages/gateway/test/chamber-surface/chamber-installed.test.ts`）、掩码两通道、`profile_corrupt` 诚实投影、停机实例照常 200/404；`POST /chamber/runtime/start` 停机态门 + 恢复门不被绕过 + 202/poll + 失败诚实。
- 恢复面：start 闭环（停机 → start → ready）、`profile_corrupt` 诚实投影 + operator runbook、故障注入（坏插件 boot 失败 → restart-exhausted → start 恢复）。
- desktop：gateway-provider/plugin-sync（上传 + 取消 no-op + SPKI/`--no-auth`/隧道 Host 四态）、ipc-surface-mirror/golden + main handler 清单、`gateway_plugin_sync` 失败显式化；ssh 已安装列表只读投影单测。
- 实机门禁（发布前）：真实 gateway + 打包 desktop 全闭环、TLS+SPKI、多桌面、registry 实装（传递依赖网络 + lifecycle scripts 实测行为）、start 恢复、故障注入；scripts/env 实测结果回调 §6.7 纪律。
