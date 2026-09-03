# 13 · 远程实例插件管理（远程 dsh plugin 编排；已实现，2026-08；设计 08 双包 seed 更新 2026-08-20）

> **状态：已实现（2026-08，M1–M4 落地）**——实现基线以 git 历史与
> CHANGELOG 为准；剩余项（本机 pnpm 依赖）见 `docs/progress/STATUS.md`。
> 本文档补全此前散落于
> 05 §7.4/§7.6、03 §2.2 与 STATUS 中的契约实体，成为该面的设计权威。
> **范围（连接模型 v2，17 §2/§9.1）**：本面只服务
> `{kind:'dsh', transport:'ssh'}` 目标——gateway 目标（http/ssh）的插件与
> 编排面走 gateway 自身编排面（17 §10），不经本 exec 通道。
> 范围纪律：只做**编排**（远端 dsh plugin CLI 经 exec 通道驱动），不重造
> dsh 宿主插件系统本身。设计 08 增加的 Git 执行仍在远端 dsh 实例内；本设计
> 只负责把 chamber 自带的 host package 分发过去，绝不增加 `ssh ... git ...`。
>
> **2026-12 收敛表述（design 21 §3，用户重申口径）**：ssh 与 gateway 不是
> 「双通道各一套同权功能」，而是**单一插件管理模型、末段执行分叉**——UI、
> 流程、差异语义、状态机、文案与恢复能力全仓只有一份（ssh = 桌面主进程
> exec 后端；gateway = 宿主 spawn 后端）；本设计各节是 ssh 后端的既有行为
> 权威，design 21 是模型与双后端契约的收敛权威。**统一增量已落地**：ssh 已
> 安装列表逐行移除（consistent 行缺口修复，经 apply remove）、remove/install
> 保留名拒绝（@deepseek-ai/* + @dsh-chamber/*，与 gateway 同集，applyPlugins
> 整批拒绝）、撤销 journal（SSH_PLUGIN_UNDO：变更前远端 spec 快照 +
> 操作目标指纹绑定）、SSH_PLUGIN_LIST 掩码投影（redactRemotePluginManifest，
> design 21 决策 18）；spec/name 白名单族单一来源迁
> `control-plane/src/plugin-spec.ts`（desktop 经 control-plane-module.ts 双路径
> facade 与原 ssh-provider 再导出消费、gateway 经包导出直引——§7.2 权威归属
> 变化，常量不可再在 ssh-provider 内重声明）。

## 1. 动机与范围

- 远程 dsh 实例（`dsh-<id>`，`ssh-<id>` legacy）的插件管理：远端 `dsh plugin` CLI 无法从 chamber
  前端直接调用——经桌面主进程 + provider exec 通道编排（list / add / remove /
  restart / seed / materialize）。
- 一键应用本地插件清单 + 可视化添加：npm 搜索（best-effort）与本地路径包
  物化（`add file:`）。
- 本地实例插件走控制面侧（`desktop_local_plugin_*`），与远程同 UI 但不同通道。
- chamber 自带 host package 的远端 ready-time 分发：host-graph 与 Git
  worktree 两包共用一个严格 seed 算法；这不是远端 Git 执行面。

## 2. 通道：provider exec

`TransportExecPayload.op`（05 §7.6）：

- `'exec'`：systemctl `start/stop/is-active/restart`；远端命令 `run`——命令名
  白名单 `dsh|cat|printf`（可分发命令；`base64`/`mkdir` 仅内联于 write-file
  的固定远端管线 `mkdir -p && base64 -d`，不可单独分发）+ argv/路径白名单 +
  shell 元字符拒绝
  （见 §7.2）。成功结果同时携带 stdout（UTF-8 视图）与 stdoutBytes（原始
  Buffer）——二进制内容校验在字节域进行。
- `'write-file'`：stdin base64 流式写 + **字节域流式 SHA-256 回读校验** + 目标
  前缀白名单 + **50MiB 大小上限**；回读不保留 Buffer/UTF-8 副本，成功仅返回
  status。
- `run` 捕获 stdout 在追加 Buffer 前执行 50MiB 总字节上限；stderr/隧道与
  systemd stdout/stderr 先按完整行重组再脱敏，每条未终止行最多 64Ki 字符，
  超限整行丢弃且只记固定摘要。失败详情在接收每行时即限制为 2048 字符，不能
  先无界积累再在进程退出时截断。

## 3. 编排（plugin-sync.ts）

- `apply`：add / remove / restart（restart 需布尔值）；spec 在主进程二次
  白名单校验（`applyPlugins` + `buildRemoteExecArgv`）——renderer 提供
  **绝不信任**。
- `seed`（设计 08/09 接线）：`seedRemoteChamberHostPackages` 经现有受限
  `cat/write-file` 原语，把本次**实际有 `dist/index.js` 构建产物**的两个包
  `@dsh-chamber/dsh-host-client-graph`（loader id `client-graph`）与
  `@dsh-chamber/dsh-host-git-worktree`（loader id `git-worktree`）落到远端
  install-level fallback `profiles/node_modules`，再合并 web profile 的
  `cordis.patch.yml`。`seedRemoteHostGraph` 保留为旧手动 IPC 的单包兼容 wrapper。
- `materialize`：本地路径包物化（pack → ssh 传输 → 远端 `add file:`）；
  `add file:` 走独立目录约束白名单分支（仅物化目录内绝对路径）。本地
  `pnpm pack` 固定 `--config.ignore-scripts=true`，选择目录只授权读取/传输，
  不授权执行包的 prepack/prepare/postpack 生命周期脚本。

双包 seed 的顺序与失败语义固定：

1. 先在本机预检所有可用包的 `package.json + dist/index.js`；第二包损坏时远端
   零调用。未构建的包被排除，也绝不产生悬空 loader row。
2. 第一条远端调用只读
   `<remoteDshHome>/profiles/web/cordis.patch.yml`；文件缺失（profile 未初始化）
   或不是可安全追加的顶层 YAML list 时，在任何远端写入前 fail-loud。
3. 对两包全部目标文件先做 quiet `cat` 与字节域 hash 比较；任一非 ENOENT
   读取失败发生在第一笔写入之前。随后只写缺失/漂移文件到
   `<remoteDshHome>/profiles/node_modules/@dsh-chamber/<package>/`。
4. 包文件全部成功后，才对 patch 做**一次**合并写。去重必须在同一 loader row
   内精确匹配 id/name pair，不能把两条交叉 row 误判为已存在；用户已有顶层
   list 保留，只追加缺失的 chamber rows。
5. SSH transport 每次进入 `ready` 都在 instance 单飞守卫下重跑该幂等流程；
   重连是廉价 hash-skip，不持久化可能漂移的 “seeded” 标记。自动 seed **不替
   用户重启远端 dsh**：已运行实例须重启后才装载新增 row，日志明确标注
   “重启后生效”。

该通道只复制 chamber 自有构建产物。Git worktree RPC/校验/子进程全部由远端
实例加载后的 `@dsh-chamber/dsh-host-git-worktree` 执行（设计 08），Desktop
既不接收 Git argv，也不读 Git topology。

## 4. 数据与投影

### 4.1 远端插件清单

`desktop_ssh_plugin_list` → 远端 `cat <home>/profiles/web/package.json` +
主进程本地 JSON 解析（`remotePluginList`；白名单固定 cat 目标，无远端命令
分发面）。现有
`chamber.hostGraph.installed` 投影的本地/远端语义保持**两文件定义**
（package.json + dist/index.js，`SEED_FILES`）；设计 08 没有把 Git host 包塞进
普通插件 manifest schema。Git 客户端以每实例 `gitWorktree` Remote 的实际应答
判定执行面是否可用，缺包/未重启必须显式报错而不是显示空仓库。

### 4.2 remoteDshHome（远端 dsh home 路径基准）

- 非秘密元数据：`~/.dsh` 或绝对路径，`null` = 远端默认 `~/.dsh`；每个路径段
  只含 `[a-zA-Z0-9._-]` 且不得为 `.` / `..`，不接受空段或尾随 `/`；
- 贯穿 schema（`TransportInstanceSpec.remoteDshHome`）/ 状态投影 / IPC / 双
  ambient 类型；所有远端路径从它派生（白名单、shell 安全值，见 §7.2）；
- 编辑 `remoteDshHome` 是 transport + exec identity 的 generation 边界：旧隧道、
  重连/探针与 exec child 先被撤销，迟到的多步 exec spawn、日志、投影与结果均被
  generation fence 丢弃，原先非 idle 的连接再用新路径重启；
- ENOENT 在原始 stderr 上分类：`.ssh*` 命名的 remoteDshHome 不再因整行脱敏
  而把"文件不存在"误判为 ssh 故障。

## 5. IPC 面（preload 白名单，05 §7.4）

- 远程：`desktop_ssh_plugin_list`、`desktop_ssh_plugin_apply`（add/remove/
  restart）、`desktop_ssh_seed_host_graph`、`desktop_ssh_plugin_materialize_add`
  （`add file:`）、`desktop_ssh_plugin_materialize_add_pick`；
- 本地：`desktop_local_plugin_list/add/remove` + `desktop_local_plugin_add_file`
  （本地路径包物化——目录选择收敛后取代旧 `desktop_pick_directory` 通道，
  2026-08 起不存在）；
- 其他：`desktop_npm_search`（npm 搜索，best-effort）。

## 6. UI（连接设置页 · 插件管理）

- 远端同步视图 + 本地列表视图；`plugin-diff` 一键应用本地清单。
- chamber 内建注入可见化：`@dsh-chamber/dsh-host-client-graph` 行显示
  installed/patched 状态 + 模块 A 包版本号（本地/远端均解析 seeded
  package.json）；远端未注入时提供「注入」按钮。
- 远端生效状态三态：经主进程隧道 RPC 探测（`probeClientGraphLive`，POST
  `clientGraph/graph`——renderer module C 同款只读调用，复用 verifyUp 探测
  纪律：应答才分类）——「已注入并已生效」/「已注入（重启后生效）」/「生效
  状态未知」（无 ready 隧道或探测不可分类时）。本地侧按设计不单独探测
  （本地实例即 chamber 页面，boot 自身证明图通道）。
- 注入结果写入实例环形缓冲日志（transport-manager `appendLog`，连接设置页
  远端日志面板可见）。
- 弹窗顶部承载客户端插件运行时加载诊断详情（design 09 §3.5：状态 + 插件 id +
  原因；`instance-version-conflict` 为中性信息态）——实例卡片只保留状态标记，
  弹窗是 chamber 诊断的详情面。
- Git worktree 客户端是 renderer 复合 entry 的首屏 covered package；它不复用
  host-graph 的 installed 投影冒充自身状态，而是按来源调用 `gitWorktree`
  Remote。缺包或尚未重启生效时保留明确的来源错误；ready-time 注入日志说明
  “重启后生效”，不得把 RPC 不可达渲染成空仓库。

## 7. 安全

### 7.0 主进程确认与路径脱敏（2026-11 审计复核，09 §4 v1 缓解）

- `desktop_ssh_plugin_materialize_add` / `desktop_local_plugin_add` /
  `desktop_local_plugin_remove` 在真正动作前须经主进程 `dialog.showMessageBox`
  确认（远程 bundle 与 chamber 页面同上下文，脚本不能静默驱动外传/安装/卸载）；
  取消返回 `{ok:true,cancelled:true}`（与 picker 取消同形）；无窗口 fail-closed；
  单飞防弹窗堆叠。文案构造为纯函数（`describe*Confirmation`，可单测）。
- `desktop_ssh_plugin_apply` 的 **registry add/remove**（2026 final review）同样
  须主进程确认——远端安装是持久执行面，与本地安装同类；取消返回
  `{ok:true,cancelled:true}`（`SshPluginApplyIpcResult` 增补该变体，三处镜像
  同步）。空 add/remove 的 apply 是 **no-op**（`applyPlugins` 仅在存在变更时
  重启），脚本无法借 plugin_apply 触发无变更重启。
  > **2026-12 落地状态勘误（design 21 §10 ①）**：ssh plugin_apply/seed_host_
  > graph/materialize_add(_pick) 主进程对话框**仍未实现**（仅 gateway
  > gateway_plugin_apply/undo 与 ssh_plugin_undo 有确认；gateway materialize
  > 为「pick 即意图」设计）——本节为设计意图（决策 14 桌面通道纪律），缺口
  > 登记开放项，勿按已落地理解。
- `desktop_local_plugin_list` 的依赖值投影脱敏：materialize 类（file:/link:/
  相对/绝对/`~/`）值掩码为 `file:<hidden>`（保持双端 materialize 分类与名称
  匹配语义），本地绝对路径不回显 renderer。主进程内部仍持有完整 manifest
  （`resolveLocalMaterializeDirectory` 等不受影响）。
  > **2026-12 落地状态勘误（design 21 §10 ①/缺陷③）**：本地清单（LOCAL_PLUGIN_LIST）
  > **保持原样透传**（本地 file: 绝对路径可经 IPC 进 renderer——登记缺陷③，修复另
  > 行排期）；ssh 远端清单（SSH_PLUGIN_LIST）已经 redactRemotePluginManifest 掩码
  > （与 gateway readManifest 同纪律）。

### 7.1 双侧二次校验

renderer 提供的 add/remove spec 在主进程（plugin-sync）+ provider（exec argv）
**双侧重新校验**，绝不信任单一来源。

### 7.2 白名单（权威）

- 可分发远端命令名：`dsh|cat|printf`（`buildRemoteExecArgv` 按命令分发并
  逐参数白名单）；`base64 -d`/`mkdir -p` 仅内联于 write-file 管线（固定
  `mkdir -p <dir> && base64 -d > <path>` 形状，非可分发命令）。argv/路径白名单
  + shell 元字符拒绝。OpenSSH 的远端命令最终仍由远端 shell 解释，因此安全性
  来自固定命令形状与 shell-safe 值白名单，不能把本地 argv 数组本身当成安全
  边界；
- 服务名：`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`（首字符必须为字母或数字）；systemd
  固定 argv 为 `systemctl <action> -- <serviceName>`，以 `--` 终止 option 解析；
- remoteDshHome：`^~?(?:\/(?!\.{1,2}(?:\/|$))[a-zA-Z0-9._-]+)+$` +
  1024 字符上限（null = 远端默认 `~/.dsh`）；renderer UX 门禁与主进程权威
  由 parity 测试防漂移；
- `write-file` 目标前缀白名单 + 50MiB 大小上限。

### 7.3 字节域校验

`write-file` 回读 SHA-256 在字节域增量计算，不依赖 UTF-8 文本视图，也不把
整份远端内容保留为 stdoutBytes；普通白名单 `exec` 读取才返回 stdout/
stdoutBytes。

## 8. 分期

- **M1–M4 已落地（2026-08）**：exec `restart/run/write-file` + §7.2 白名单、
  remoteDshHome 贯穿、plugin-sync 编排、10 个 IPC 通道（远端
  plugin_list/plugin_apply/seed_host_graph/materialize_add/materialize_add_pick
  + 本地 local_plugin_list/add/remove/add_file + npm_search）、前端
  PluginSyncModal/PluginAddView/plugin-diff、chamber 内建注入可见化 +
  生效三态。
- **设计 08 扩展已落地（2026-08-20）**：通用双 host-package seed、精确
  id/name pair merge、ready-time 单飞注入与 packaged 双包复制；未改变
  TransportExecAction/run 形状或普通插件 manifest schema。
- **退出所有权（2026-08-28 merge review）**：本地 `pnpm pack` / `dsh plugin`
  子进程由 plugin-sync 独立跟踪；will-quit 先注销 ready-time seed listener，
  再终止并等待全部本地子进程（POSIX 独立进程组，Windows `taskkill /T /F`
  进程树）。退出开始后拒绝新 local child；与 transport-manager 对远端 SSH
  exec 的 disposeAsync 并行，统一受桌面 5s 退出硬上限兜底。
- **剩余**：本地 `dsh plugin` / `pnpm pack` 依赖本机 pnpm
  （`resolvePnpmBinDir` 扫描 PATH + nvm/volta/homebrew，打包态 best-effort）。
