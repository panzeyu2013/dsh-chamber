# 13 · 远程实例插件管理（ssh 后端编排）

> 本文是 **ssh 后端**（`{kind:'dsh', transport:'ssh'}`）插件管理与 chamber 宿主包分发的行为权威：经桌面主进程的 provider exec 通道驱动远端 `dsh plugin` CLI 与受限文件写入，并在实例 ready 时幂等分发 chamber 自有宿主包。统一插件模型与双后端契约的收敛权威是 [21-gateway-plugin-parity.md](./21-gateway-plugin-parity.md)（§3）；连接模型与注册表 schema 见 [03-connections-proxy.md](../control-plane/03-connections-proxy.md) §2.2，gateway 形态见 [17-server-side-gateway.md](./17-server-side-gateway.md)，进程托管见 [02-host-management-deployment.md](../runtime/02-host-management-deployment.md)。

## 1. 范围与边界

- **目标类型**：只服务 `{kind:'dsh', transport:'ssh'}`；gateway 目标（http/ssh）没有插件写面，只有桌面同步的 seed cache 与 `/chamber/plugins/installed` 读投影（[21](./21-gateway-plugin-parity.md) §2.4/§6.2），不经本 exec 通道；dsh 的 http 直连无任何插件管理面（[17](./17-server-side-gateway.md) §3）。
- **来源 id**：规范 id `local` / `dsh-<raw-id>` / `gateway-<raw-id>`，legacy `ssh-<raw-id>` 仅作迁移兼容（[17](./17-server-side-gateway.md) §2.2/§9.1）；本面只服务 ssh 的 dsh 目标（`{kind:'dsh', transport:'ssh'}`，main 侧门控）。
- **保留的只读/供给面**：`desktop_ssh_plugin_list` / `desktop_local_plugin_list` 清单读取、行投影 `rows[]`（`role`/`protected`，由后端计算）、官方只读清单 `pluginInventory/list`、chamber 宿主包 capability 探针（installed/patched/live）。写面由上游 `@deepseek-ai/dsh-plugin-manager`（`packages/boot/plugin-manager`）与其官方客户端行承载。受保护集合判定（读面 `protected` 的唯一含义 = `name ∈ P`）权威在 [21](./21-gateway-plugin-parity.md) §6.11。
- **只做编排**：驱动远端 `dsh plugin` CLI 与文件分发，不重造 dsh 宿主插件系统；Git worktree 的 RPC、校验与子进程全部在远端实例内由 `@dsh-chamber/dsh-chamber-seed-git-worktree` 执行（[08](../plugins/08-git-worktree-plugin.md)），Desktop 既不接收 Git argv 也不读 Git topology，绝不出现 `ssh ... git ...`。
- **用户插件写面不在本仓**：chamber 不提供远端/本地插件的安装、卸载、物化、撤销、npm 搜索写面，也不注册 gateway 写路由或 `gateway_plugin_apply`/`gateway_plugin_materialize` IPC；用户写面由上游 `@deepseek-ai/dsh-plugin-manager`（宿主包）与官方 `@deepseek-ai/dsh-client-ui-plugin-manager`（客户端行）承载。保留的只读/供给面见 §5。

## 2. 通道：provider exec

`TransportExecPayload.op`（契约见 [05](../control-plane/05-connection-manager.md) §7.6）：

- `'exec'`：systemctl `start/stop/is-active/restart`；远端命令 `run`——命令名白名单 `dsh|cat|printf`（可分发命令；`base64`/`mkdir` 仅内联于 write-file 管线 `mkdir -p && base64 -d`，不可单独分发）+ argv/路径白名单 + shell 元字符拒绝（§7.1）。成功结果同时携带 stdout（UTF-8 视图）与 stdoutBytes（原始 Buffer），二进制内容校验在字节域进行。
- `'write-file'`：stdin base64 流式写 + **字节域流式 SHA-256 回读校验** + 目标前缀白名单 + **50 MiB 大小上限**；回读不保留 Buffer/UTF-8 副本，成功仅返回 status。
- `run` 的 stdout 在追加 Buffer 前执行 50 MiB 总字节上限；stderr、隧道与 systemd 输出先按完整行重组再脱敏，每条未终止行最多 64 Ki 字符，超限整行丢弃且只记固定摘要；失败详情在接收每行时即限制为 2048 字符，不得先无界积累再在退出时截断。

## 3. 宿主包 seed 编排（`plugin-sync.ts`）

`seedRemoteChamberHostPackages(exec, spec, seeds)` 经受限 `cat`/`write-file` 原语，把本次**实际有 `dist/index.js` 构建产物**的 chamber 宿主包（loader id 与包名一一对应：`client-graph` / `git-worktree` / `archive-cleanup`；`HOST_*_PACKAGE_NAME` ↔ `HOST_*_INSERT` ↔ `CHAMBER_HOST_PACKAGES` 三面一致由 C13 锁，open-in 为 `localOnly` 不进远端 seed；清单唯一来源 = `packages/control-plane/src/host-graph-seed.ts`）落到远端 install-level fallback `profiles/node_modules`，并按实例 home 写到 `profiles/web/node_modules/@dsh-chamber/<package>/`，再合并 web profile 的 `cordis.patch.yml`；单包/多包走同一条路径，手动 IPC `desktop_ssh_seed_host_graph` 复用同一实现。序列与失败语义固定：

1. 先在本机预检所有可用包的 `package.json + dist/index.js`；任一包损坏时远端零调用。未构建的包被排除，绝不产生悬空 loader row。
2. 第一条远端调用只读 `<remoteDshHome>/profiles/web/cordis.patch.yml`；文件缺失（profile 未初始化）或不是可安全追加的顶层 YAML list 时，在任何远端写入前 fail-loud。
3. 对全部目标包的全部目标文件先做 quiet `cat` 与字节域 hash 比较；任一非 ENOENT 读取失败发生在第一笔写入之前。随后只写缺失/漂移文件到 `<remoteDshHome>/profiles/node_modules/@dsh-chamber/<package>/`。
4. 包文件全部成功后，才对 patch 做**一次**合并写。去重必须在同一 loader row 内精确匹配 id/name pair，不能把两条交叉 row 误判为已存在；用户已有顶层 list 保留，只追加缺失的 chamber rows。
5. SSH transport 每次进入 `ready` 都在实例单飞守卫下重跑该幂等流程；重连是廉价 hash-skip，不持久化可能漂移的 "seeded" 标记。

自动 seed **不替用户重启远端 dsh**：已运行实例的宿主行须重启后才装载新增 row，日志标注「重启后生效」。这些包全是 host-only（无 `dsh.client` 半身、不进活图），页面侧无需窗口重载；[09](../client/09-client-plugin-runtime-loading.md) §3.7 的 live 热同步只承运 client 行，与本段无关。唯一的页面侧跟随是**图回归**：`client-graph` 本身就是图端点，装它之前该来源取图是 `not-injected`（boot 无图、不 arm）⇒ seed 生效后 App 按 09 §3.7 的有界探测（每来源每 60s 至多一次；ssh 重启不动隧道相位，世代计数在此不成立）发现图已就绪并重挂该实例一次（重新取图、装 profile 的 client 行、arm），仍不需要整页重载；插件管理器/配置编辑路径另见 09 §3.7，原始文件编辑不触发 `applied` 帧。

该通道只复制 chamber 自有构建产物。

## 4. 数据与投影

### 4.1 远端插件清单

`desktop_ssh_plugin_list` → 远端 `cat <home>/profiles/web/package.json` + 主进程本地 JSON 解析（`remotePluginList`；白名单固定 cat 目标，无远端命令分发面）。`chamber.hostGraph.installed` 投影的本地/远端语义保持**两文件定义**（package.json + dist/index.js，`SEED_FILES`）；清单投影同时供 `rows[]` 行模型与 `pluginInventory/list` 官方只读面使用（行类型单源 = `@dsh-chamber/dsh-chamber-wire/plugin-row`，C14）；Git host 包不进普通插件 manifest schema。Git 客户端以每实例 `gitWorktree` Remote 的实际应答判定执行面是否可用，缺包/未重启必须显式报错而不是显示空仓库。

### 4.2 remoteDshHome（远端 dsh home 路径基准）

- 非秘密元数据：`~/.dsh` 或绝对路径，`null` = 远端默认 `~/.dsh`；每个路径段只含 `[a-zA-Z0-9._-]` 且不得为 `.` / `..`，不接受空段或尾随 `/`。
- 贯穿 schema（`TransportInstanceSpec.remoteDshHome`）/ 状态投影 / IPC / 双 ambient 类型；所有远端路径从它派生（白名单、shell 安全值，见 §7.1）。
- 编辑 `remoteDshHome` 是 transport + exec identity 的 generation 边界：旧隧道、重连/探针与 exec child 先被撤销，迟到的多步 exec spawn、日志、投影与结果均被 generation fence 丢弃，非 idle 的连接按新路径重启。
- ENOENT 在原始 stderr 上分类：`.ssh*` 命名的 remoteDshHome 不因整行脱敏而把「文件不存在」误判为 ssh 故障。

- **来源 id 与旧 IPC 口径**：规范 id `local` / `dsh-<id>` / `gateway-<id>`，legacy `ssh-<id>` 仅迁移兼容；ssh 清单/分发走受限 `cat` 与 `write-file` 原语（`cat/write-file` 组合）。远端 seed 的宿主包全名 = `@dsh-chamber/dsh-chamber-seed-client-graph` / `@dsh-chamber/dsh-chamber-seed-git-worktree` / `@dsh-chamber/dsh-chamber-seed-archive-cleanup`（open-in 为 `localOnly`）。**已退休且不得恢复**：`desktop_local_plugin_add/remove/add_file`（只留 `desktop_local_plugin_list`）、`desktop_ssh_plugin_materialize_add(_pick)`、`desktop_local_plugin_*` 写面、`plugin_mutation_executor`、`applyPlugins`/`buildSshApplyRows`、materialize（`add file:`、`pnpm pack`、`--config.ignore-scripts=true`）、`desktop_pick_directory`、主进程写确认（`dialog.showMessageBox`/`SshPluginApplyIpcResult`/`describe*Confirmation`）与本地插件子进程退出腿（`taskkill /T /F`）——退役叙事在 `CHANGELOG.md`。

## 5. IPC 面

- 远程：`desktop_ssh_plugin_list`（只读清单）、`desktop_ssh_seed_host_graph`（宿主包补种）。
- 本地：`desktop_local_plugin_list`（只读清单）。
- gateway：`desktop_gateway_plugin_sync`（seed-cache 手动同步，[21](./21-gateway-plugin-parity.md) §6.5）。

写面 IPC（`desktop_ssh_plugin_apply` / `desktop_ssh_plugin_materialize_add(_pick)` / `desktop_local_plugin_add/remove/add_file` / `desktop_npm_search`）不存在，不得恢复。

## 6. UI（连接设置页 · 插件管理）

- **「chamber 内置（注入）」表不得写死包名**：唯一权威清单是 `CHAMBER_HOST_PACKAGES`（insert id + 包名 + 存活探测 Remote）；desktop 的本地/远端注入态投影为逐包列表 `ChamberHostPackageState[]`（含 `insertId/name/probe/installed/patched/version/live/localOnly`），UI 直接映射该列表；本地探测、ssh 探测、gateway seed-cache 漂移、gateway 同步包表、远端 seed 清单全部由同一清单派生。新增宿主包 = 注册表加一行（页面、探测、同步自动覆盖）；写死包名的行集会让已 seed 的包不可见，并让 `remoteNeedsSeed` 误报「已注入」。
- **按目标适用性列行（`localOnly`，[20](../desktop/20-open-in-registry.md) §6）**：标 `localOnly` 的注册表行只为本地形态存在；非本地目标（ssh/gateway/http）的行集 = 该目标适用行，判据是注册表标志而非观测状态——适用但尚未注入的行必须保留（它是「注入」动作的判据）。同一过滤 `applicableChamberPackages` 同时供给 ssh 的两个目标级门 `sshChamberGates`（needs-seed / restart-pending），因为远端探针对 `localOnly` 行合成 `installed:false`（**一次远端调用都不发**，「没问」不等于「远端没有」）。main 进程侧凡判定「那台机器上该有什么」的路径（手动注入预检、ready-time 注入日志、桌面侧 gateway 上传源清单 `host-assembly.ts` 的 `localChamberHostPackageSources`）一律读 `portableChamberHostPackageSeeds`，绝不读完整注册表投影（`sourceDir` 为空的 localOnly 行会被误判为「构建产物缺失」；出货判定另用 `builtChamberHostPackageSeeds`，空 `sourceDir` 先被拒——否则 `join('','dist','index.js')` 会落到进程 CWD）；网关侧由注册表派生的 `SYNCABLE_HOST_PACKAGES` 白名单按设计仍含该行（[20](../desktop/20-open-in-registry.md) §9 / [17](./17-server-side-gateway.md) §10.2）。
- **行派生为纯函数**：`deriveChamberRows`（`plugin-inventory-text.ts`，locale-free：只回 label KEY 与版本 STRING，绝不回 JSX/本地化文本），由 `test/plugin-inventory/chamber-rows.test.ts` 表驱动覆盖完整输入矩阵（local/ssh/gateway/http × 清单有/无 × installed/patched/live × seed-cache 漂移/缺项/整盘缺/未读 × 空 expected）。**数据源矩阵是契约**：LOCAL 目标的 expected 与本地列都读它自己的 profile 清单（`localList.chamber`）；gateway/http/ssh 读桌面本机清单投影（ssh 一份来自 `loadSync` 已取的本地清单，gateway/http 一份来自专用的本地清单读取），ssh 在远端探测成功时优先远端清单；**空 expected 列表不得声称「seed cache 不存在」**。gateway 不再有 packaged client plugin，客户端插件行为为零；不渲染 unknown 行，绝不显示写死的包名。
- 远端同步视图 + 本地列表视图；`plugin-diff` 一键应用本地清单（对账模型见 [21](./21-gateway-plugin-parity.md) §6.11.5）。
- chamber 内建注入可见化：`@dsh-chamber/dsh-chamber-seed-client-graph` 行显示 installed/patched 状态 + 模块 A 包版本号（本地/远端均解析 seeded package.json）；远端未注入时提供「注入」按钮。
- 远端生效状态三态：经主进程隧道 RPC 探测（`probeChamberHostLive`——方法与参数取自注册表描述符 `CHAMBER_HOST_PACKAGES[].probe`，每个宿主包走同一条通用路径）——「已注入并已生效」/「已注入（重启后生效）」/「生效状态未知」（无 ready 隧道或探测不可分类）。本地侧不单独探测：本地实例即 chamber 页面，boot 自身证明图通道。
- 注入结果写入实例环形缓冲日志（transport-manager `appendLog`，连接设置页远端日志面板可见）。
- 弹窗顶部承载客户端插件运行时加载诊断详情（[09](../client/09-client-plugin-runtime-loading.md) §3.5：状态 + 插件 id + 原因；`instance-version-conflict` 为问题态（跨实例认领 → 复用页面已有 factory、**不阻止 boot**；同发布的 `@deepseek-ai/*` 或内容逐字节一致的 profile 插件复用且不报），`restart-required` 为同实例重建 → 该行本次 boot 缺席，live 分支保留旧 entry）。09 §3.7 的 live 写入（`bundle-load-failed`/`restart-required`/`instance-version-conflict`）也经同一单槽与 provenance CAS，详情面同源、无第二套投影。
- Git worktree 客户端是 renderer 复合 entry 的首屏 covered package；它不复用 host-graph 的 installed 投影冒充自身状态，而是按来源调用 `gitWorktree` Remote。缺包或尚未重启生效时保留明确的来源错误；ready-time 注入日志说明「重启后生效」，不得把 RPC 不可达渲染成空仓库。
- **单一模型视图**：插件管理对话框是唯一 `PluginDialog`（connections 包）——local / ssh+dsh / gateway / http 直连四来源按后端能力矩阵渲染同一组件，分叉仅在数据源与动作分发（[21](./21-gateway-plugin-parity.md) §3/§6.6）。ssh 面保留同步差异、只读已安装列表与撤销记录展示；gateway 只读行 + seed 同步状态；http 直连只读。§5 是现行只读通道的权威清单。

## 7. 安全

### 7.1 清单脱敏与 IPC 边界

- `desktop_local_plugin_list` 的依赖值投影脱敏：materialize 类（`file:` / `link:` / 相对 / 绝对 / `~/`）值掩码为 `file:<hidden>`（保持双端 materialize 分类与名称匹配语义），本地绝对路径不回显 renderer；主进程内部仍持有完整 manifest。判据单一来源 = wire `plugin-manifest` 的 `isMaterializedValue` / `PLUGIN_MATERIALIZED_VALUE_MASK`（[21](./21-gateway-plugin-parity.md) §1 决策 18）。
- ssh 远端清单（SSH_PLUGIN_LIST）由 `redactRemotePluginManifest` 掩码（与 gateway readManifest 同纪律）；本地 LOCAL_PLUGIN_LIST 同样经 `redactLocalPluginManifest` 对 `dependencies` 与 `rows[].spec` 两通道掩码。
- IPC 白名单契约见 [05](../control-plane/05-connection-manager.md) §7.4。

### 7.2 白名单（权威）

- 可分发远端命令名：`dsh|cat|printf`（`buildRemoteExecArgv` 按命令分发并逐参数白名单）；`base64 -d`/`mkdir -p` 仅内联于 write-file 管线（固定 `mkdir -p <dir> && base64 -d > <path>` 形状，非可分发命令）。argv/路径白名单 + shell 元字符拒绝。OpenSSH 的远端命令最终仍由远端 shell 解释，故安全性来自固定命令形状与 shell-safe 值白名单，不能把本地 argv 数组本身当作安全边界。
- 服务名：`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`（首字符必须为字母或数字）；systemd 固定 argv 为 `systemctl <action> -- <serviceName>`，以 `--` 终止 option 解析。
- remoteDshHome：`^~?(?:\/(?!\.{1,2}(?:\/|$))[a-zA-Z0-9._-]+)+$` + 1024 字符上限（null = 远端默认 `~/.dsh`）；renderer UX 门禁与主进程权威由 parity 测试防漂移。
- `write-file` 目标前缀白名单 + 50 MiB 大小上限。
- spec/name 白名单族的**单一来源**是 `packages/control-plane/src/plugin-spec.ts`（desktop 经 control-plane-module.ts 双路径 facade 与 ssh-provider 再导出消费、gateway 经包导出直引）——常量不可再在 ssh-provider 内重声明。
- 本节只管白名单（形状/注入面）；受保护集合判定（语义面，读面 `role`/`protected` 投影）的权威在 [21](./21-gateway-plugin-parity.md) §6.11：`P = B₀ ∪ S ∪ F`，ssh 只有 `B₀ ∪ S`（F 无远端来源），`protected` 的唯一含义 = `name ∈ P`；单一来源 `packages/control-plane/src/protected-plugins.ts`。`$DSH_HOME` 的托管实例 home 由控制面固定（`<stateDir>/dsh-home`），本面只读/分发，绝不改写用户 profile 的 `dsh.bundle.patch` 语义。

### 7.3 字节域校验

见 §2：`write-file` 回读 SHA-256 在字节域增量计算，不依赖 UTF-8 文本视图，也不把整份远端内容保留为 stdoutBytes；普通白名单 `exec` 读取才返回 stdout/stdoutBytes。

### 7.4 退出所有权

ready-time seed listener 在退出开始时先注销；远端 SSH exec 子进程由 transport-manager 的 `disposeAsync` 终止并等待，统一受桌面 5 s 退出硬上限兜底。
