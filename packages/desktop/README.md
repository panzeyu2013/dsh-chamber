# @dsh-chamber/desktop

dsh-chamber 的 Electron 壳（v4 连接管理器形态）：单 frame 加载控制面 origin 上的 dsh 官方前端；主进程承担正交目标/传输管理（`dsh|gateway × ssh|http`）、实例注册表、write-only 凭据事务与 IPC。

## 目录

- `main.ts` — Electron 主进程的唯一装配与 IPC 注册入口：单窗口单 frame、control-plane、connection v2 transport/plugin/open-in/deep-link/通知/设置/运行时/更新接线，以及退出清理。避免并存一套未导入的 handler 实现。
- `ipc-events.ts` — IPC 通道名常量（`IPC_CHANNELS`，主进程侧单一来源；preload 重复字面量由 `ipc-surface-mirror.test.ts` 守卫）
- `control-plane-module.ts` — `@dsh-chamber/control-plane` 双路径门面（dev/测试 → workspace 源码；打包态 → `dist/control-plane/` 编译产物），导出 `createControlPlane` 与共享协议工具（rpc-envelope / cordis-inserts）
- `updater.ts` — 更新控制器（设计 11）：stable 走 GitHub provider；beta 按应用自身版本自动锁定，经有界 Releases API 选择最高 canonical published beta 后切 exact-tag Generic feed（发现失败绝不回退 `latest*`）；静默检查（启动延迟 + 6h 周期）+ 状态机 + 用户确认后下载（autoDownload=false）+ 退出时安装；非秘密状态投影
- `preload.cts` — 沙箱 preload 源码，经 contextBridge 暴露 `window.dshChamber`；运行时使用编译产物 `dist/preload.cjs`（见 `scripts/build-preload.mjs`）
- `renderer-trust.ts` — IPC 围栏（`createTrustedIpc`：sender/frame/origin 校验，语义不变抛 `ipc_sender_forbidden`）+ 渲染进程 URL 信任判定
- `transport-provider.ts` — TransportProvider 接口（来源无关契约：spec 校验 / 可选传输 argv / stderr 分类 / 可选 exec + verifyUp；缺省为无子进程的 direct-endpoint 模式，SSH provider 才拥有本地隧道）
- `transport-manager.ts` — 通用传输运行时：实例注册表 + phase 机 + 两段式重连（快速有界 jitter 退避突发 + 慢速周期重探）+ 环形日志 + 子进程监督 + 非秘密投影
- `ssh-provider.ts` — SSH transport：隧道（ssh -N -o ServerAlive… -L）+ 远端 systemd exec + child-scoped askpass leases + RPC 探测（经 control-plane-module 共享信封）
- `gateway-provider.ts` — HTTP direct transport + gateway 认证/SPKI/session；同一 provider 的 dsh 目标分支严格无认证
- `ssh-config.ts` — `~/.ssh/config` 非秘密投影解析
- `chamber-settings.ts` — chamber 全局设置 holder（`chamber-settings.json`，原子写，`dsh-chamber:settings-*` 数据面）
- `notifications.ts` — 通知决策纯逻辑（validateNotificationRequest / decideNotification / claimNotification，electron-free）
- `deep-link.ts` — 深链解析/VS Code 启动（electron-free 决策 + 主进程执行）
- `open-in.ts` — OpenInApp 注册表 + 六步 loud 执行管线（electron-free 决策 + 主进程执行）
- `plugin-sync.ts` — 插件编排纯逻辑：manifest 解析/spec 分类/远端 probe/apply/seed/materialize（cordis insert 渲染经 control-plane-module 共享实现）
- `scripts/bundle-dsh.mjs` — 将官方发布包 `@deepseek-ai/dsh` 安装为本地运行时（`vendor/dsh`）
- `scripts/build-control-plane.mjs` — 打包态将 `@dsh-chamber/control-plane` 编译为 JS（`dist/control-plane/`，见下）
- `scripts/build-preload.mjs` — 将 `preload.cts` 编译为纯 CJS（`dist/preload.cjs`；沙箱 preload 无 TS 类型擦除，`import type` 直接 SyntaxError，dev/打包统一用编译产物）
- `scripts/electron-dev.mjs` — dev 编排：二进制缺失时自动补装（ensure-electron + DSH_CHAMBER_ELECTRON=1）→ 按需构建 renderer/preload → 以进程组方式启动 Electron → 信号/退出时清理子进程
- `dist/` — 渲染层构建产物（由 renderer 包构建输出到这里，不在此提交）

## 依赖安装

```sh
# 仓库根目录一次安装（pnpm workspaces 会把 @dsh-chamber/control-plane symlink 进来）
pnpm install
```

- pnpm install 默认不再下载 Electron 二进制（DSH_CHAMBER_ELECTRON=1 或 electron-dev 首启时经 electron_mirror 下载）。
- `@dsh-chamber/control-plane` 是工作区包，`main.ts` 直接 `import` 使用。

## 运行

```sh
# 编译到可运行产物（renderer 构建 + 控制面编译 + dsh 封装），仓库根目录执行：
pnpm run build:desktop

# dev 模式：renderer 产物缺失时自动构建，然后启动 Electron
#（可传 --build 强制重建 renderer 产物；Ctrl+C 退出时级联清理 Electron 进程树）
pnpm run dev:desktop
```

### 打包为可分发的软件

```sh
# macOS（产出 dmg + zip 到 packages/desktop/release/）
pnpm run dist:desktop:mac   # 仓库根目录：build:desktop + electron-builder --mac

# 其他平台
pnpm run dist:desktop
```

## 构建链

### bundle-dsh：dsh 运行时封装（scripts/bundle-dsh.mjs）

- **dsh 运行时 = 官方发布包**：脚本用 `pnpm add @deepseek-ai/dsh@0.1.2-alpha.3`（默认精确 pin；`DSH_CHAMBER_DSH_VERSION` 只接受精确 semver 做显式升级验证，拒绝 `latest`/range/URL；`--force` 仅刷新当前精确版本）。这个 pin **只约束桌面应用内嵌的本地 runtime，不约束远程实例版本**；各远程可独立升级，连接时只检查所需协议能力是否兼容。发布包自带完整插件依赖图 + 已构建 lib，**不克隆源码、不 tsc/tsdown 构建、不需要 tsx**。
- 构建工具固定为 `pnpm@11.21.0`；PATH 不匹配时自动以
  `npx --yes pnpm@11.21.0` 兜底，不解析浮动 major tag。
- pnpm 11 两个坑（bundle-dsh 已处理）：① 默认拦截依赖构建脚本 → 生成的 `pnpm-workspace.yaml` 用 `allowBuilds` 白名单放行 node-pty/koffi/protobufjs/@google/genai/@deepseek-ai/dsh-subprocess-local（原生模块）；② 默认发布年龄策略可能过滤指定版本 → 临时 workspace 使用 `minimumReleaseAge: 0`，但输入仍必须是精确 semver，不引入浮动解析。
- **安装后清理运行期不需要的内容**（`pruneRuntimeArtifacts`）：node-pty 的构建源料（deps/third_party/src/scripts/typings/binding.gyp）与**异平台**预编译归档——运行时按 build/Release → build/Debug → `prebuilds/<platform>` 顺序加载，因此**保留当前平台的 prebuilds 子目录**，只删其余平台；mistralai/openai 的 TS 源码/示例/测试；全树 `*.d.ts`/`*.d.cts`/`*.d.mts`/`*.map`。正确性由安装后冒烟兜底。
- 控制面 spawn 入口统一为 `<node> <workspace>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web`（`resolveDshEntry` + `resolveNodeExecutable`，spawn-dsh.ts）。node 可执行不假设在 PATH 上：Electron 主进程内用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`（另前置 `--expose-internals`，dsh loader 需要），纯 node 环境用 `process.execPath`，兜底 PATH 搜索——打包 App 从 Finder 启动时 PATH 极简，裸 `spawn('node')` 会 ENOENT。
- 封装完成后 `vendor/dsh/package.json` 记录实际解析到的精确版本（`dependencies["@deepseek-ai/dsh"]`）与封装平台（`dsh.platform`）；已封装且**平台一致**时再次 bundle 跳过（跨平台复用会打进错误平台的原生二进制，自动重封装），`--force` 刷新当前 pin。重新封装期间保留 last-known-good 目录；只有安装、裁剪、版本核验与 smoke 全部通过后才交换目录，交换失败自动回滚，进程中断后的下次运行会恢复备份。

### build:control-plane：打包态控制面编译（scripts/build-control-plane.mjs）

- `build:desktop` 先执行 `build:control-plane`（tsc emit + `rewriteRelativeImportExtensions` 把 `.ts` 导入重写为 `.js`，产物 `dist/control-plane/`），再执行 `build:preload`（`preload.cts` → `dist/preload.cjs`）。
- 打包态 `main.ts` 条件导入该编译产物；开发态仍走 workspace 符号链接零构建直接运行源码（`pnpm run dev:desktop` 不需要编译步骤）。
- 原因：Node 类型擦除不覆盖 node_modules，workspace 包的 raw TS 无法在 asar 内运行，打包态必须用编译产物；沙箱 preload 没有类型擦除，必须预编译为纯 CJS（`main.ts` 优先加载 `dist/preload.cjs`，`electron-dev.mjs` 缺失时自动编译）。

### electron-builder 配置要点（packages/desktop/package.json 的 `build` 键）

- `files` 只收主进程/预加载/transport/settings/plugin-sync 源文件、package.json 与 dist（vendor 与 scripts 不进 asar；`node_modules/@dsh-chamber/control-plane` 显式排除）；`vendor/dsh` 经两个精确的 `extraResources` FileSet 拷入产物：根 manifest/lock/workspace 文件一组，`vendor/dsh/node_modules` 作为独立复制根一组（electron-builder 会无条件忽略任一 FileSet 根下名为 `node_modules` 的直接子目录，不能只复制 `vendor/dsh`）。`afterPack` 在生成 DMG/ZIP/NSIS 前校验 dsh package manifest、版本与目标平台，缺失/漂移直接使打包失败；暂存树和交换备份不会进入产物。
- `electronLanguages: ["en-US", "zh-CN"]` 裁剪 locales。
- **更新 feed（设计 11 §6）**：stable 使用 package 默认 GitHub publish 配置且只产 `latest.yml`/`latest-mac.yml`；SemVer beta 使用独立 `electron-builder.beta.yml`（经 `electron-builder.base.cjs` 继承同一 files/signing/runtime 配置）且只产 `beta.yml`/`beta-mac.yml`，发布策略测试同时做另一通道缺失断言。mac target 增加 `zip`（electron-updater mac 需要，dmg 保留首装）；`nsis.differentialPackage: false`（Windows 无 exe blockmap，更新全量下载）。`--publish=never` 不生成 update-info yml。
- **公开 release fail-closed**：正式 macOS 缺少五项签名/公证凭据时在任何 Release mutation 前阻断；构建后必须通过 Developer ID、公证、stapler 与 spctl 才能公开 finalize。dry-run 即使正式 secrets 已配置也强制清空签名/Apple 环境与 `GH_TOKEN`，只产 ad-hoc 包，且不创建/修改 Release、不上传资产。Windows 首版未签名，SmartScreen 是明确让步（设计 11 §7）。

## 主进程

### 单 frame

- `BrowserWindow` 1280x800，`loadURL` 控制面 origin（`http://127.0.0.1:<port>`，默认 17500）；webPreferences 无 `webviewTag`——N-ctx 是同窗口内 ctx 切换，不是 webview 嵌套。
- `contextIsolation: true`、`nodeIntegration: false`，默认 sandbox。

### 控制面

`createControlPlane({ stateDir: <userData>/state, dshWorkspacePath })`：`stateDir` 固定为 `app.getPath('userData')/state`；`dshWorkspacePath` 为 dsh 工作区解析结果（打包态 `<resources>/vendor/dsh`；开发态环境变量 `DSH_CHAMBER_DSH_PATH` → `<repoRoot>/ref-dsh` → `<pkg>/vendor/dsh`；找不到时为 null，控制面内部回退到默认解析）。port 默认 17500、host 默认 127.0.0.1，start 后经 `controlPlane.port` 读取实际绑定端口。**dev 隔离**：`electron-dev.mjs` 以独立 `--user-data-dir`（`packages/desktop/.dev-user-data`，gitignored）启动，且 dev 模式控制面端口回落为 17520（`DSH_CHAMBER_CP_PORT` 可覆盖）——与运行中的打包版实例（共享同一应用名 `@dsh-chamber/desktop` → 同一 userData 与单实例锁、占用 17500）互不冲突；dev 的注册表/密码/状态独立存放，绝不触碰打包版线上数据。

### transport-manager + providers（transport-provider.ts / transport-manager.ts / ssh-provider.ts / gateway-provider.ts）

- **来源无关运行时**：目标 kind（`dsh|gateway`）与 transport（`ssh|http`）正交；provider 按 transport 注册。`buildStartArgs` 缺省 = **direct endpoint 模式**（无子进程，运行时探测 `probeTarget()`、暴露 `endpointUrl()`）。
- **SSH 隧道**：`ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 [-p <sshPort>] -L <localPort>:127.0.0.1:<remotePort> <user@host>`；localPort 由 `net listen(0)` 分配。dsh 目标以 `session/list`（斜杠）unary 身份握手；gateway 目标以认证后 `/chamber/runtime/status` 固定 marker 握手，使 managed dsh blocked/down 时恢复面仍可达。gateway tunnel 的 HTTP Host/session authority 固定远端 `127.0.0.1:<remotePort>`，绝不复用 SSH alias。非目标服务均显式失败，绝不呈现假 ready。
- **phase 机**：`idle → connecting → ready ⇄ degraded → error`，**两段式重连**：快速**半开 jitter** 指数退避突发（保留下界 0.5×、上界 1×，多实例/唤醒后错峰；至多 5 次 ≈31s）+ 突发耗尽后落 error（诚实红态）但进入**慢速周期重探**（每 ~60s 一次全新隧道尝试，无上限——瞬时故障是时变的，「放弃」绝不停摆，条件修复自动恢复；手动 connect/disconnect 取消在途重探）。认证失败置 `requiresUserAction`，**终态不自动重试**（用户须修复凭据/host key）。**确定性验证失败免重试**：`verifyUp` 结果带 `terminal` 分类——目标**应答了**探测但证明不是（兼容的）dsh（HTTP 非 200 / 错误信封 / 版本过老）→ 第一次失败即 error 终态（requiresUserAction，重试无法改变应答）；仅连接错误/超时等瞬时失败走重连。投影的 `userActionKind` 区分终态类别（`'auth'` = 传输层认证/主机密钥/spawn；`'endpoint'` = 实例层确定性探测失败——SSH 隧道本身正常，连接设置页展示实例提示而非 SSH 认证失败提示，杜绝误导）。子进程监督 per-child：SIGTERM → 宽限后 SIGKILL。
- **远端 systemd exec**：`ssh user@host systemctl <action> -- <serviceName>`——固定参数数组 spawn（**无 shell**，`--` 终止 option 解析），serviceName 先过白名单 `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`（首字符必须为字母或数字）再执行；有界超时（`execTimeoutMs`，默认 15s）；失败写入实例环形日志并作为错误结果返回（响亮，绝不吞掉）；认证失败复用 `AUTH_FAILURE_PATTERNS`，只经结果错误显式返回（**不写隧道终态**）。结果按需写入状态投影的 `serviceActive`（不轮询）。`systemctl` 默认目标为远端 system 级 unit 管理器。
- stderr 按行缓冲后脱敏 + 终态认证判定（跨 chunk 不绕过）；每实例环形日志（约 200 行）。
- **可选密码认证**（design 05 §8 例外，明文文件兜底——用户决策）：密码只在主进程内存 + `<userData>/ssh-passwords.json`（schema v2：password + SSH endpoint binding；no-follow/普通文件/inode 校验、读前收紧 0600、原子写）。非空 legacy v1 无可信 binding，唯一 `.unbound-*` 保留并禁用至重录。askpass helper 位于每进程 `mkdtemp` 私有 0700 目录，复验 uid/type/inode/mode，O_EXCL 创建且完整 fsync 后才设 0700；历史共享 tmp 目录永不写入，EPERM/异主 fail closed。每个 tunnel/systemd/run child 独占 helper lease，只有真实 exit/error/spawn-fail 才释放；disconnect/removal/clear 请求 purge，但仍在途的 lease 延迟至引用归零，崩溃残留由下一启动回收。元数据与 SSH password/gateway token/password 由 `desktop_ssh_save_connection` 在主进程 crash-safe 提交；renderer 不读旧秘密。Gateway token 限 32–4096 visible ASCII，Gateway 登录密码允许 12–1024 Unicode JavaScript 字符。`sshPasswordSupported()`（非 win32）为 false 时显式拒绝。
- **Gateway session / SPKI 门**：Cookie key = 网络 origin + `Host` authority + 稳定 connection-id/target scope，localPort 不代表 ownership；scope invalidation 的 generation 在登录、Cookie probe、Bearer fallback 与 401 relogin 每次 await 后拦截迟到结果。session provider 六个 hooks 必须 all-or-none；当前 generation 的 `cookie|bearer` proof 门控 ready 注册，缺失时 fail closed。refresh arm/disarm/dispose 另提升按 id epoch，并在提交前复验凭据、URL、pin、authority 与 scope。Gateway+HTTPS 配置 pin 时，登录/探针在 peer SPKI 匹配前不 `write/end`、不发送凭据或 body；control-plane 的 HTTP/WS 反代遵循同一零应用字节门。

### 实例注册表

`<userData>/ssh-instances.json`，核心字段：`{id,label,kind,transport,host,user,sshPort,remotePort,serviceName,remoteDshHome,insecureHttp,spkiPin}`；kind=`dsh|gateway` 是目标，transport=`ssh|http` 是机制，旧 kind 载入时迁移。凭据不进注册表，只投影 `sshPasswordSet/tokenSet/passwordSet/secretStorage`。SSH mirror schema v2 与 gateway mirror schema v3 分别持久化 endpoint/target binding，读取/注入时复验当前 registry；secret→registry 崩溃窗口 fail closed。元数据白名单、原子写、损坏保留、重复 id 首胜都在核心强制。`serviceName`/`remoteDshHome` 等 live+exec identity 编辑会提升 transport generation 与 `execEpoch`，先撤销旧传输/重连/探针及 exec child（SIGTERM→SIGKILL），再按旧状态决定是否以新参数重启；多步 exec 下一次 spawn 和迟到日志/投影/结果均复验 generation。

### ~/.ssh/config 发现（ssh-config.ts）

主进程读取 `~/.ssh/config`，**只投影非秘密字段**（alias / hostName / user / port）；IdentityFile、ProxyCommand、密码等一概不进投影。手写行解析（无依赖）：大小写不敏感、`#` 注释与双引号参数、续行折叠（保留内部空白）、通配符 Host 跳过、多别名展开、`Match` 块整体跳过、文件头全局 User/Port 作为条目默认（first-obtained-wins）、端口仅接受十进制。文件缺失 = 空集（ENOENT）；不可读 = 响亮 `{error}`，绝不静默为空。ssh stderr 含密钥/口令路径的行在入环形日志前**脱敏**（`redactSshStderr`，design 05 §8）。

### 运行数据位置

- **打包态**：`userData = ~/Library/Application Support/dsh-chamber`（macOS；Windows `%APPDATA%\dsh-chamber`、Linux `~/.config/dsh-chamber`）。
- **dev 态**：`electron-dev.mjs` 显式传 `--user-data-dir=packages/desktop/.dev-user-data`（gitignored）——**dev 与打包态目录不同、状态互不共享**（注册表/密码/目录各自独立）。
- userData 下内容：`ssh-instances.json`、`ssh-passwords.json`（schema v2 binding）、`gateway-secrets.json`（schema v3 binding；safeStorage 优先、诚实 0600 plaintext fallback）与 `state/` + Electron 自身缓存。
- **不在 userData 下**：askpass 助手位于 `os.tmpdir()/dsh-chamber-ssh-<pid>-<random>/`；独立控制面默认 `~/.dsh-chamber` 或 `$DSH_CHAMBER_STATE`。

### IPC 清单（preload 白名单）

| 通道 | 方向 | 说明 |
|---|---|---|
| `dsh-chamber:info` | invoke | `{controlPlaneUrl, dshVersion, version, platform}`（不向 renderer 暴露本机工作区/状态目录） |
| `desktop_ssh_instances_get` | invoke | 实例列表 |
| `desktop_ssh_instances_set` | invoke | legacy exact-no-op-only：只接受与当前规范化 roster 同长度、同顺序、逐字段完全相同的列表；delete/add/edit/reorder 全部拒绝 |
| `desktop_ssh_save_connection` | invoke | add/edit/非空凭据写唯一入口；元数据 + 三类 write-only 凭据的主进程 crash-safe binding/补偿事务，旧值不返回 renderer |
| `desktop_ssh_delete_connection` | invoke | 精确 id-addressed 删除；先断开/撤销 exact-scope session/清凭据，再删 metadata；不存在 id 为幂等 no-op |
| `desktop_ssh_set_password` | invoke | legacy clear-only：仅接受 '' / null 清除 SSH 密码；非空写必须走 save_connection，未知 id → `{error}` |
| `desktop_gateway_set_token` / `desktop_gateway_set_password` | invoke | legacy clear-only：仅清除单个 gateway 凭据维度；非空写必须走 save_connection |
| `desktop_ssh_config_list` | invoke | `~/.ssh/config` 非秘密投影 `{hosts:[{alias,hostName,user,port}]}` 或 `{error}` |
| `desktop_ssh_connect` | invoke | 启动/重启隧道 |
| `desktop_ssh_disconnect` | invoke | 停止隧道（SIGTERM → 宽限后 SIGKILL） |
| `desktop_ssh_status` | invoke | 非秘密状态投影 `{kind, transport, phase, localPort, sshPort, remotePort, retryAttempt, requiresUserAction, serviceActive, logSummary}` |
| `desktop_ssh_logs` / `desktop_ssh_logs_clear` | invoke | 环形日志读取/清空 |
| `desktop_ssh_start_service` / `stop_service` / `is_active` / `restart_service` | invoke | 远端 systemctl 起停/查询/重启 |
| `desktop_ssh_plugin_list` | invoke | 远端插件清单投影（cat 远端 manifest + 本地解析） |
| `desktop_ssh_plugin_apply` | invoke | 远端插件增删（**registry add/remove 须主进程确认**，设计 09 §4；取消 `{ok,cancelled}`） |
| `desktop_ssh_seed_host_graph` | invoke | 向远端注入 chamber host 包（idempotent，hash-skip） |
| `desktop_ssh_plugin_materialize_add` | invoke | 本地 manifest 依赖打包上传远端（**主进程确认**；name-only，路径由主进程解析） |
| `desktop_ssh_plugin_materialize_add_pick` | invoke | 文件夹选择器打包上传远端（pick-only） |
| `desktop_local_plugin_list` | invoke | 本地插件清单（依赖值路径**脱敏**为 `file:<hidden>`） |
| `desktop_local_plugin_add` / `local_plugin_remove` | invoke | 本地插件安装/卸载（**主进程确认**；`file:` 拒收，走 picker） |
| `desktop_local_plugin_add_file` | invoke | 本地文件夹选择器安装（pick-only） |
| `desktop_npm_search` | invoke | npm registry 搜索（主进程 fetch，best-effort） |
| `dsh-chamber:update-state` | invoke | 更新状态快照（设计 11）：`{phase, currentVersion, latestVersion, channel, downloadPercent, releaseUrl, installBlockedReason, error}`——非秘密投影 |
| `dsh-chamber:update-check` | invoke | 用户主动检查；复用周期检查路径，只做 feed 发现、不下载 |
| `dsh-chamber:update-download` | invoke | 用户确认的「更新」动作：触发后台下载（`autoDownload=false`，不点击永不下载）；`{ok}` 或 `{error}` |
| `dsh-chamber:open-release` | invoke | 「前往下载页」：经主进程 `shell.openExternal` 打开，仅允许本仓库 GitHub 页（严格白名单） |
| `dsh-chamber:update-state-changed` | 主进程推送 | 更新状态变化（检查/下载/就绪/失败），renderer 订阅刷新 settings「更新」部分 |
| `desktop_ssh_status_changed` | 主进程推送 | 状态变化事件 `{id, status}` |
| `desktop_ssh_instances_changed` | 主进程推送 | 注册表增删改后触发（renderer 重拉 roster；另有 30s 轮询兜底） |

preload 暴露 `window.dshChamber = {controlPlaneUrl, dshVersion, version, platform, desktopSsh, update, settings, systemResume, openIn, deepLink, notifications}`（`update` 为设计 11 的更新面：`state/download/openReleasePage/onChanged`）。

### 退出 / 单实例 / 错误处理

- 退出时 `will-quit` 中 `transportManager.disposeAsync()`（终止所有隧道与在途 exec，等待 SIGKILL 升级完成，传输生命周期归运行时）与 `cp.stop()` 级联终止 dsh 子进程以 `Promise.allSettled` **并行**执行。
- 单实例锁：`requestSingleInstanceLock`；二次启动只 focus 已存在的窗口。
- 出错不静默：控制面启动失败 / 渲染层产物（`dist/index.html`）缺失 / 打包态控制面编译产物（`dist/control-plane/index.js`）缺失 / 前端 loadURL 失败时 `dialog.showErrorBox` 并以退出码 1 退出；损坏实例文件先改名保留 `*.corrupt` 再置空。
- 打包态且图标资源存在时创建托盘（状态 tooltip + 显示/退出菜单）；任何失败只记日志，不阻塞启动。

## 安全

- **传输 URL 只在主进程**：`readyUrl()` 仅限内部使用，永不经过 `status()` 或 IPC 面；renderer 只见 phase/localPort 投影，自行用 localPort 构造访问 URL。
- **systemctl 无 shell 拼接**：固定参数数组 `systemctl <action> -- <serviceName>`；serviceName 以 `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` 校验，首字符必须为字母或数字。
- **凭据由主进程拥有（表单瞬时 write-only 输入例外）**：默认 ssh key/agent；可选 SSH 密码与 gateway token/password 只由表单瞬时采集并经 write-only IPC 进入主进程及上述 owner-only 镜像，永不返回/回填或由 renderer 持久化；askpass 永不上命令行，Gateway 仅向 exact connection-target scope 对应的注册 transport 注入白名单头；generation/proof/refresh epoch 阻止撤销后的迟到认证结果。HTTPS pin 匹配前登录/探针/HTTP/WS 反代发送零应用层字节；日志只含非秘密存在性/主机端口。
- **插件动作主进程确认（设计 09 §4 v1 缓解）**：materialize 外传、本地插件安装/卸载、远端 `plugin_apply` registry 增删均须用户确认对话框（取消 `{ok,cancelled}`；无窗口 fail-closed；单飞防堆叠）；`local_plugin_list` 依赖值路径脱敏。

## 桌面环境验收清单

1. 运行 `pnpm run dev:desktop` 后出现 1280x800 主窗口，本地实例的 dsh Web UI 加载（v1 无登录面）。
2. DevTools 无报错：Menu > View > Toggle Developer Tools（或 Ctrl/Cmd+Shift+I）查看 console，无 error。
3. chamber 侧栏可见（管理 | 本地 dsh | 远程实例列表），实例分区展开显示 workspace/session 聚合，点击会话行打开该实例 shell（N-ctx 切换正常）。
4. chamber 管理视图中远程实例 CRUD/连接/断开/日志可用；配了 `serviceName` 时 systemd 起停生效。
5. 退出应用后无残留进程（`ps aux | grep dsh` 无 dsh 相关子进程、无 ssh -N 隧道进程）。
6. 再次启动应用只 focus 已有窗口，不重复开新窗口。
