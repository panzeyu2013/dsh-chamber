# 13 · 远程实例插件管理（远程 dsh plugin 编排；已实现，2026-08）

> **状态：已实现（2026-08，M1–M4 落地）**——实现记录与验证见
> `docs/progress/STATUS.md`（设计 13 条目）。本文档补全此前散落于
> 05 §7.4/§7.6、03 §2.2 与 STATUS 中的契约实体，成为该面的设计权威。
> 范围纪律：只做**编排**（远端 dsh plugin CLI 经 exec 通道驱动），不重造
> dsh 宿主插件系统本身。

## 1. 动机与范围

- 远程 dsh 实例（`ssh-<id>`）的插件管理：远端 `dsh plugin` CLI 无法从 chamber
  前端直接调用——经桌面主进程 + provider exec 通道编排（list / add / remove /
  restart / seed / materialize）。
- 一键应用本地插件清单 + 可视化添加：npm 搜索（best-effort）与本地路径包
  物化（`add file:`）。
- 本地实例插件走控制面侧（`desktop_local_plugin_*`），与远程同 UI 但不同通道。

## 2. 通道：provider exec

`TransportExecPayload.op`（05 §7.6）：

- `'exec'`：systemctl `start/stop/is-active/restart`；远端命令 `run`——命令名
  白名单 `dsh|cat|printf|base64|mkdir` + argv/路径白名单 + shell 元字符拒绝
  （见 §7.2）。成功结果同时携带 stdout（UTF-8 视图）与 stdoutBytes（原始
  Buffer）——二进制内容校验在字节域进行。
- `'write-file'`：stdin base64 流式写 + **字节域 SHA-256 回读校验** + 目标
  前缀白名单 + **50MiB 大小上限**。

## 3. 编排（plugin-sync.ts）

- `apply`：add / remove / restart（restart 需布尔值）；spec 在主进程二次
  白名单校验（`applyPlugins` + `buildRemoteExecArgv`）——renderer 提供
  **绝不信任**。
- `seed`（设计 09 遗留 1 接线）：`seedRemoteHostGraph` 经 exec `write-file`
  原语把模块 A 包（`@dsh-chamber/dsh-host-client-graph`）落到远端平铺
  fallback `profiles/node_modules` + `cordis.patch.yml` 列表 insert + restart；
  幂等 hash-skip；接入连接就绪时的自动注入（主进程日志 + UI 实时探测，手动
  按钮为失败重试路径）。
- `materialize`：本地路径包物化（pack → ssh 传输 → 远端 `add file:`）；
  `add file:` 走独立目录约束白名单分支（仅物化目录内绝对路径）。

## 4. 数据与投影

### 4.1 远端插件清单

`desktop_ssh_plugin_list` → 远端 `dsh plugin --profile web list` 解析；
installed 语义本地/远端一致：**两文件定义**（package.json + dist/index.js，
`SEED_FILES`）。

### 4.2 remoteDshHome（远端 dsh home 路径基准）

- 非秘密元数据：`~/.dsh` 或绝对路径，`null` = 远端默认 `~/.dsh`；
- 贯穿 schema（`TransportInstanceSpec.remoteDshHome`）/ 状态投影 / IPC / 双
  ambient 类型；所有远端路径从它派生（白名单、shell 安全值，见 §7.2）；
- ENOENT 在原始 stderr 上分类：`.ssh*` 命名的 remoteDshHome 不再因整行脱敏
  而把"文件不存在"误判为 ssh 故障。

## 5. IPC 面（preload 白名单，05 §7.4）

- 远程：`desktop_ssh_plugin_list`、`desktop_ssh_plugin_apply`（add/remove/
  restart）、`desktop_ssh_seed_host_graph`、`desktop_ssh_plugin_materialize_add`
  （`add file:`）、`desktop_ssh_plugin_materialize_add_pick`；
- 本地：`desktop_local_plugin_list/add/remove`；
- 其他：`desktop_npm_search`（npm 搜索，best-effort）、`desktop_pick_directory`
  （主进程目录选择）。

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

## 7. 安全

### 7.1 双侧二次校验

renderer 提供的 add/remove spec 在主进程（plugin-sync）+ provider（exec argv）
**双侧重新校验**，绝不信任单一来源。

### 7.2 白名单（权威）

- 远端命令名：`dsh|cat|printf|base64|mkdir`；argv/路径白名单 + shell 元字符
  拒绝（无 shell 拼接，参数数组 spawn）；
- 服务名：`^[a-zA-Z0-9_.-]+$`（systemctl 目标）；
- remoteDshHome：白名单 + shell 安全值（null = 远端默认 `~/.dsh`）；
- `write-file` 目标前缀白名单 + 50MiB 大小上限。

### 7.3 字节域校验

`write-file` 回读 SHA-256 在字节域进行（stdoutBytes 原始 Buffer），不依赖
UTF-8 文本视图。

## 8. 分期

- **M1–M4 已落地（2026-08）**：exec `restart/run/write-file` + §7.2 白名单、
  remoteDshHome 贯穿、plugin-sync 编排、10 个 IPC 通道、前端
  PluginSyncModal/PluginAddView/plugin-diff、chamber 内建注入可见化 +
  生效三态。
- **剩余**：本地 `dsh plugin` / `pnpm pack` 依赖本机 pnpm
  （`resolvePnpmBinDir` 扫描 PATH + nvm/volta/homebrew，打包态 best-effort）。
