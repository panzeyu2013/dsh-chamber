# 02 · 宿主管理（web profile）：本地 dsh 宿主进程的托管与部署形态

> **范围横幅（2026-11 用户裁决；窄横幅，不整篇归档）**：Electron flavor 已冻结归档（见 [`../progress/electron-frozen.md`](../../progress/electron-frozen.md)）。本文中 **Electron/Chromium 专属段**（spawn-dsh 的 Electron 分支、运行期指纹、safeStorage、electron-updater 等）随 flavor 归档；**control-plane 宿主生命周期契约（spawn / 就绪 / 健康 / reaper / 日志 / host 包 seed）仍现行**，Swift sidecar 继续按本文执行。**本地实例托管与部署形态**——控制面以 dsh 内置 web profile拉起本地宿主，并独占其生命周期（spawn → 就绪 → 健康 → 重启 → 优雅停止 →孤儿回收）；开放状态见 `docs/progress/STATUS.md`。
> - **profile 形态**：`dsh --profile web --host 127.0.0.1
>   --port <port> --trusted-host 127.0.0.1:<port>`——不生成/维护自建 profile 目录、业务 patch  stack 或 glue 插件；端口固定（非随机），占用时按 port+1 有界退让。唯一例外是设计 08/09/20/24  的**宿主包 loader overlay**（见 §2.6），不接管宿主组装权威。
> - **契约范围**：spawn 生命周期、端口占用重试、pid 记录、instance-id 仲裁、readiness、健康七态状态机、
>   reaper、host-logs 滚动日志、systemd 单元、优雅停止（字段见 §3.3）。
> - **移出的旧体系（不得回流）**：slim profile 生成与维护、glue 插件、旧业务补丁层
>   HMR 分类与 `POST /api/config/reload`、external 接管 / claim、部署五形态（收为桌面  一体一形态）、README 快速连接承诺。权威契约：`05-connection-manager.md`（架构 / PlaneHandle）；管理面端点见`04-control-plane-api-data.md`；连接模型见 `03-connections-proxy.md`；服务端部署形态（gateway 单元 / http 直连）与远程连接模型 v2 见 `17-server-side-gateway.md`。

---

## 1. 目标与范围

### 1.1 目标

1. 控制面在同机以 **dsh 内置 web profile** 拉起本地宿主（`--profile web--host 127.0.0.1 --port <port> --trusted-host 127.0.0.1:<port>`），该实例即连接模型的`local` 连接（connectionId `'local'`，03 §2.1）；
2. 宿主进程生命周期完全由控制面管辖：spawn（detached）→ 就绪探测 → 健康监控 → 失败重启（带背压）→ 优雅关闭；控制面崩溃后遗留的孤儿宿主可被安全回收；
3. 用户的宿主配置/设置变更由 dsh 原生机制处理（web profile 自带配置平面），控制面不介入；chamber host 包的 loader 附着仅走 §2.6 的独立、确定性 seed，不成为配置权威；
4. 明确部署形态（桌面一体）与 systemd 单元（远程实例部署参考形态）。

### 1.2 范围

- **in**：local 实例托管（spawn / 就绪 / 健康 / 重启 / 回收 / 仲裁）、pid 记录、host-logs滚动日志、systemd 单元、优雅停止；chamber host 包的确定性分发与 loader overlay（§2.6）。
- **out**：会话/目标/终端等宿主能力（宿主原生，前端经每实例反代消费，03 §3）；dsh 连接协议（wire 以 vendor 源码为权威，控制面仅用统一身份握手/健康探活面，见 §3.2/§3.5）；认证/审计（匿名 loopback 控制面随 v1 收敛整体移除；gateway 部署的认证/凭据/审计见17 §7/§13.4）；远程实例的隧道与 systemd 编排（03 §2.2：桌面主进程transport-manager（ssh provider）+ 注册表）。

### 1.3 原则

- **复用而非重造**：web profile 是 dsh 官方装配（base + web-app），控制面零代码复用其 webserver、`/api` 桥与浏览器信任栅栏；控制面只编排：解析 binary、spawn、读输出、端口重试、探活、计数、重启、回收。
- **只杀自管进程**：reaper 的三重校验（记录在案 / 身份重验 / owner 已死）是安全底线。
- **诚实失败**：端口占用、启动超时、探测失败一律显式报错（fail-loud），绝不静默降级。
- **只附着，不下沉业务**：控制面可复制 chamber 自带 host 包并挂 loader row，但不解析其业务数据，也不执行 Git；Git worktree 事实与命令始终属于实例内`@dsh-chamber/dsh-chamber-seed-git-worktree`（设计 08）。

---

## 2. 设计思路与关键决策

### 2.1 为什么用内置 web profile（而不是自建 slim / 裸进程）
- **选定** `dsh --profile web --host 127.0.0.1 --port <port> --trusted-host 127.0.0.1:<port>`：官方装配已含 API 面 + 前端 + 信任栅栏 + 端口覆盖；`--trusted-host` 保证经控制面反代到达的浏览器请求（Host=127.0.0.1:<port>、Origin 同源）通过 `/api` 信任栅栏（`dsh web` 是 `--profile web` 硬别名；`--host 0.0.0.0` 被 dsh 拒绝）。
- **被否**：自建 slim profile（v2 `dsh-control` patch stack + glue 插件）——让控制面持有宿主组装权威并需外发 glue 插件；理由：v4 界面 = dsh 官方前端源码复用，进程形态收敛为官方命令。

### 2.2 端口占用重试（port+1）：固定端口 + 确定性退让
web profile 的 `--port` 固定（非 0 随机）。起始端口本地默认 17510（桌面 `DSH_CHAMBER_DSH_PORT_BASE`、gateway `--dsh-port`/`DSH_GATEWAY_DSH_PORT`）；`POST /api/connections` body 只收 kind/label/accentColor，不可指定端口（04 §3）。重试：spawn → 就绪探测（TCP + 统一身份探针 §3.2）成功即用 P；TCP 通但身份探针失败 = 端口被无关服务占用 → 杀子进程、按 P+1（至多 `MAX_SPAWN_ATTEMPTS=5` 次）→ 全败显式报错（含启动输出）；spawn 立即退出/启动超时 = 启动失败（fail-loud，附诊断）。每次重试同时更新 `--port` 与 `--trusted-host`（恒一致）。spawn 前不做 `net.listen(0)` 预占（释放到绑定仍有竞态），冲突一律后验处理。复制：`dshPort` 进 pid ledger 与 live PlaneHandle 投影、不写 catalog。
- **Rejected alternatives（覆盖形态）**：①占用时自动换空闲基址——冲突被藏起、可预测范围失效、第二个实例静默漂端口；②配置文件级端口偏移——为 dev/验收并存新增持久化面与迁移成本；③选定：仅 env 覆盖基址，未知/越界 fail-loud 后回落默认，绝不半生效。
- **与在跑安装并存**：dev/验收实例经 `DSH_CHAMBER_DSH_PORT_BASE` 错开在跑安装的 17510..17514。

### 2.3 孤儿回收直接移植参考实现安全模型
参考实现 `managed-process-registry.js` 的安全模型（记录在案 → 重验身份 → 仅 owner 死亡才杀）原样移植；差异：身份 = 命令行含 `--profile web --port N` + `lsof -i :port` 监听者 pid；注册表 `<stateDir>/managed-dsh/<pid>.json`（缺省 `~/.dsh-chamber`，`$DSH_CHAMBER_STATE` 覆写，§3.3）；记录 `{pid, ownerPid, ownerInstanceId, port, binary, profile, source, startedAt}`（profile 固定 `'web'`）。每进程一个 JSON 文件（按 pid 命名，每实例只写/删自己的，零写竞争）。

### 2.4 健康监控共享失败计数，避免"重连风暴"误触发重启
沿用 v2（移植 `lifecycle.js`）：周期探活与传输触发走同一 `runHealthCheckCycle`；同一失败窗口（15s）至多计 1 次；探测结果 750ms 缓存与单飞槽归属**探针代**（`healthEpoch`）：start 换代、进入 restart、stop 三处拆代点各自 abort 在途探针、递增代并清缓存/定时器；探针在每个 await 后复检代际，迟到的判词、缓存写入、失败计数与状态迁移一律丢弃，单飞槽带发起代、只由自己的代释放；子进程已退出不计数、直接重启；任何一次成功即清零。**不保留"忙会话宽限"**——控制面不消费会话帧，探活载荷只有统一身份方法 `session/canOpenWorkspacePath`（小体积 boolean，§3.2），健康判定与会话数据量双向解耦；慢响应由请求侧超时面处理。

### 2.5 instance-id 仲裁（多控制面实例并存）
控制面首启以 no-follow `O_EXCL` 在状态目录生成 `instance-id`（规范 UUID、0600），完整写入并 fsync 文件与父目录后才返回；读取固定小体积 single-link 普通文件 + UUID 校验（并发首启 loser 对 winner 空/部分 UUID 有界重读，完整长度非法值立即 fail-loud）；构造 local connection 时捕获该身份，pid 记录携带同一 `ownerInstanceId`（不在 spawn 后重读）。各自 spawn 互不干扰：每实例自己的起始端口 + P+1 重试天然错开、记录按 pid 隔离；reaper 不杀活人（owner 存活即永不回收，两实例并发 reaper 安全）；同端口先就绪者占住，后来者按 P+1 或报冲突，不杀进程。

### 2.6 chamber host 包的 seed 与单一 loader overlay（设计 08/09/20/24；四个 host 包）
官方 web profile 仍是宿主组装权威；chamber 只追加自身拥有、边界明确的 host package（loader id → package → 职责，领域语义见对应 design）：`client-graph`→`@dsh-chamber/dsh-chamber-seed-client-graph`（只读暴露 client module boot graph）；`git-worktree`→`seed-git-worktree`（实例内受限 Git worktree 操作，设计 08）；`archive-cleanup`→`seed-archive-cleanup`（`archiveCleanup/{probe,purge}` 清理归档会话内容，只删不读，设计 24）；`open-in`→`seed-open-in`（`openInApp/{probe,apps,icon,open}` 本机应用打开域，注册表标 `localOnly`——只进本地 profile，远端 seed 与 gateway 上传跳过，设计 20 §6）。
本地托管实例接线（顺序固定）：① `createControlPlane` 接收各 `host*PackageSourceDir`（缺省 `DEFAULT_HOST_*_PACKAGE_SOURCE_DIR`；open-in 单独 seam），仅当该源 `dist/index.js` 存在时把 `package.json + dist/index.js` 按内容 hash 幂等复制到 `<DSH_HOME>/profiles/web/node_modules/@dsh-chamber/<package>/`；② 生成**一个** `<stateDir>/dsh-chamber-graph.patch.yml`，`insert` 只含本次确有产物的 row，全缺时不传 `--patch`（保持原生 web profile 基线）；③ 复制先于 overlay，声明产物却缺必需文件属打包损坏、启动 fail-loud，文件与 overlay 原子写 + 0600；④ seed thunk 在每次 spawn（含自动重启）前重新求值：`dsh plugin` 重链裁掉 extraneous host 包后下次 spawn 自动补回；用户「重启 dsh」（design 18 §3.6 项 8）走同一 spawn 路径。这不是旧 slim profile/业务 patch stack 的回归：控制面不知道各域结果，只做受控文件分发与 loader 挂载。

---

## 3. 详细设计

### 3.1 spawn（detached）与启动命令

```
dsh --profile web [--patch <stateDir>/dsh-chamber-graph.patch.yml] \
  --host 127.0.0.1 --port <P> --trusted-host 127.0.0.1:<P>
```

`--patch` 仅在 §2.6 至少一个 host 包产物可用时出现，位于 web flags 之前，只携带 chamber-owned host rows，不改变官方 web profile 的其它组合层。

- `spawn(..., { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env })`（Unix）——独立进程组，宿主可活过父进程崩溃；Windows 退化见 §5。
- **node 可执行解析**（`resolveNodeExecutable`，spawn-dsh.ts）：控制面可运行在纯 node（standalone serve / 测试）或 Electron 主进程（desktop），而 GUI（Finder）启动的打包 App PATH 极简（`/usr/bin:/bin:/usr/sbin:/sbin`），`spawn('node', …)` 必挂 ENOENT。解析序：
  - 纯 node（含 Swift sidecar 的 payload node；基名 `node`/`node.exe` 由 `BUNDLED_NODE_BASENAMES` 直用）→`process.execPath`（就是运行中的 node）；
  - Electron → `process.execPath` + `ELECTRON_RUN_AS_NODE=1`（官方生产机制；依赖 `runAsNode` fuse，electron-builder 默认开启——**不得关闭该 fuse**），并前置 `--expose-internals`：dsh的 cordis loader 经 `node-addon-require-builtin` 取 `internal/modules/esm/loader`，该addon 的 V8 embedder 探测在 Electron 的 patched Node 下不可用（"no compatible GetAlignedPointerFromEmbedderData symbol"），`--expose-internals` 的官方 require 路径可用。
  - **指纹白名单**：该 addon（`node-addon-require-builtin@0.1.9`）内置运行时指纹表，Electron 侧只认构建时收录的版本（当前表内为 43.0.0 / 44.0.0 / 44.7.0 / 45.0.0-alpha.6）。桌面 Electron pin 不在表内时宿主子进程直接 exit 1（`unsupported Electron runtime fingerprint`）——Electron flavor 的托管宿主可用性因此由 **Electron pin × addon 版本**共同决定，任一侧升级都要实机复核；纯 node 路径（含 Swift sidecar 的 `<Resources>/sidecar/primary-runtime/dependencies/node/bin/node`——单 Node，基名 `node`）不受该白名单约束。
  - **（Electron 冻结归档，2026-11）**上面「Electron 主进程 / Electron 分支 / 运行期指纹白名单」属随flavor 归档的专属段；Swift sidecar 只走纯 node 路径，不受 Electron pin/指纹表约束。
  - 兜底 → PATH 搜索 `node` → 常见安装位置（homebrew、`/usr/local/bin`、nvm/volta/fnm） → 最终退回裸名 `node`（仅作诊断兜底）。
- **随包 pnpm 供给**（`withPnpmShim`，pnpm-shim.ts）：上游插件管理器在**托管宿主进程**里spawn 字面量 `pnpm`（execa 默认命令；shipped CLI 侧没有 `packageManager` 入口），而打包自带的pnpm 是 node 脚本（0644、shebang `#!/usr/bin/env node`），宿主 PATH 上既没有 node 也没有它，PATH 查找永远命中不了。控制面因此在 `<stateDir>/pnpm-shim/` 生成可执行的 `pnpm`（win32 `pnpm.cmd`）wrapper：exec 上面解析出的 node + 随包 pnpm 入口，**每次 spawn 校对、必要时重写**（内容与权限幂等；App 迁移/运行树更新后自愈），**仅当该次 spawn 的宿主 PATH 解析不出可执行pnpm 时**前置；用户 PATH 上已有的 pnpm（含项目 corepack 语义）逐字不动、永不被遮蔽。探测镜像子进程自己的解析（PATH 顺序、win32 PATHEXT、空/相对项按宿主 cwd 解析、win32 引号与 App Execution Alias、只认常规可执行文件）。

wrapper 准备失败只响亮记一行、PATH 原样保留（上游的ENOENT/127 保持诚实）；供给面是宿主进程树（插件管理器与会话 shell），用户自己的终端不受影响，且只覆盖打包形态（desktop 两 flavor、gateway）：standalone/CLI 运行在有依赖树的 node 安装里，不接此面（`ControlPlaneOptions.pnpmEntry` 缺省即不做供给）。被否：① 只靠 `plugin-manager.config.pnpmCommand`/`--patch` 指定 wrapper——只覆盖服务面，`dsh plugin` CLI 与脚本递归仍走字面量 `pnpm`，且把供给耦合到上游行 id；② 无条件前置——遮蔽用户工具链；③ 构建期生成 wrapper——同样要把目录注入宿主 PATH，只是把机制搬到构建面；④ 把系统 pnpm 当唯一来源——Finder 启动的 PATH 里本就没有，且版本随机器漂移（18 §9.2）；本方案只在宿主 PATH 无 pnpm 时兜底，此时版本语义随用户。直接执行 `pnpm.cjs` 不可行：非可执行位 + shebang 依赖宿主 PATH 上的 node。追加式兜底（不探测、恒追加）被否：不遮蔽是结构性成立，但会让已满足的宿主 PATH 也变样，并使 wrapper 落盘于每个宿主；探测版以"逐字不动"换取可验证的不遮蔽，代价是镜像上面的解析规则。
- **cwd 决策**：installed 布局（桌面打包态 `vendor/dsh` 运行时树）**不以安装树为 cwd**——就地替换会让宿主持有已 unlink 的工作目录（`uv_cwd ENOENT` 事故），改用 `<stateDir>/dsh-home`（控制面所有、0700、宿主整个生命周期稳定存在）为 cwd；source 布局保持 `dshWorkspacePath`（开发态 `ref-dsh` 检出根）为 cwd，其 loader（`--import tsx/esm`）经工作区自身 `node_modules` 解析。入口始终以绝对路径传入，两分支都不依赖cwd 解析 dsh CLI；会话级工作区由前端 runtime 决定，与宿主 cwd 解耦。
- **环境固定**（确定性 + 隐私）：`DSH_TELEMETRY_DISABLED=1`（任意非空值即禁用）——**只关`session-telemetry-otel`**（上游 telemetry 贡献者的开关），**不覆盖**上游 base profile 默认挂载的`session-log-deepseek`（会话日志贡献者）；后者按裁决「不影响功能就与上游行为一致」保持默认挂载，chamber 不写 `disabled: true` patch，也不在控制面/渲染端复制或上报其内容（日志落在实例宿主 home）；`DSH_PERMISSION_MODE=workspace-write`（显式固定默认）；`SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0`（目录选择交互 pin：托管宿主恒以应用内目录对话框服务，绝不弹 OS 选择器——05 §4）。该标记按 `launchedThroughSsh`（vendor `dsh-launch-environment`：非空 `SSH_CONNECTION` 或 `SSH_TTY`）被上游三处消费：①`host/directory-picker-auto` 解析 `browse`（本 pin 目的）；② `bundle/web-app` 关闭浏览器自启 handoff（`handoffBrowser = openBrowser && !launchedThroughSsh`）；③ `host/open-in-app`在 SSH 标记下不解析任何本机应用（`resolveOpenInAppApps` 返回空表）——**该消费者与我们无关**：本地打开面由实例进程内的 chamber host 包提供（设计 20 §2.2/§6，fork & supersede）；官方宿主行由 local-host-seeding 在 seed 生效时以 overlay `disabled`停用（`OFFICIAL_OPEN_IN_DISABLE`，`packages/control-plane/src/host-graph-seed.ts`），故标记回到「仅目录选择 pin」的唯一目的。其余环境继承控制面；`DSH_HOME` **显式 pin 到 `<stateDir>/dsh-home`**（覆盖继承，控制面私有宿主 home，与系统用户 `~/.dsh` 不共享）；Electron 分支额外注入`ELECTRON_RUN_AS_NODE=1`。
- **首启默认（seedDshHomeDefaults，index.ts）**：未初始化的 `<stateDir>/dsh-home` 同时无`settings.yaml` 和 `settings.yaml.imported` 时，写入一次 `locale.preference: zh`（0600）。dsh ≥0.1.7 首启把旧文件导入活跃 Profile 并改名为 `.imported`；后续 start() 不再重建旧文件，避免再次导入默认值覆盖用户在设置页中的选择。
- **日志**：stdout/stderr 管道接入控制面 host-logs 滚动日志（§3.8），同时是启动诊断与就绪失败的证据（登记字段：binary、args、cwd、env 键数、PATH 项数；spawn-dsh 以注册表字段承载，非独立结构化 `lastSpawnDiagnostics` 对象）。

- **登录 shell 环境（rc.2 对齐；控制面 `login-shell-env.ts`）**：Dock/Finder/桌面启动只继承session manager 的环境，用户写在 `~/.zprofile`/`~/.zshrc` 的 PATH、代理与 API key 不会进入托管宿主与它的 agent shell/终端（与随包 pnpm shim 同一病根）。两个桌面入口（Electron main（**已冻结归档**）、Swift sidecar）**各发起一次** `startLoginShellEnvironment(log, { signal })`（`login-shell-env.ts` 的共享接线：内部走进程级一次读取 `readLoginShellEnvironmentOnce(process.env)`，逐条失败交给入口的 log、异常回退继承环境），把它作为 `hostEnv` 选项交下去：控制面与窗口构造不等它，`spawn-dsh` 在**首次 spawn 前才 await**（上游同序）。候选 = 账号记录的登录 shell → `/bin/zsh` → `/bin/bash` → `/bin/sh`，各跑一次`<shell> -ilc`，以两个标记包住 `command env -0 || exit` 的输出（不等待 stdout 关闭；cwd = 用户home）。shell 值覆盖继承值，但**探测环境键集（PROBE_ENVIRONMENT：DISABLE_AUTO_UPDATE /ZSH_TMUX_AUTOSTART / ZSH_TMUX_AUTOSTARTED，绝不泄进宿主）**、探测会话变量（PWD/OLDPWD/SHLVL/_）与 `DSH_*`/`ELECTRON_*` 命名空间除外。单候选预算默认 10s，可用 `DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS`覆盖（非 1000..2147483647 的整数 = 配置错误，入口告警并回退）；超时/中止杀**进程组**后换下一候选，**成功候选不杀**（让它自行退出，不动用户 rc 拉起的后台作业）。全部失败返回继承环境并逐条告警（含 exit/signal），绝不阻塞启动；Windows 跳过。gateway/standalone 不调用（服务由服务管理器供给环境）。失败列表进启动日志；托管宿主 env 的其余卫生规则（DSH_HOME 显式 pin 等）不变。

#### Rejected alternatives（宿主登录 shell 环境）

- **读 `$SHELL`**：Dock 启动继承的是 launchd 的 `$SHELL`，不是 `chsh` 后的当前选择。
- **只跑 `<shell> -lc`**：多数用户把 PATH 追加写在 `~/.zshrc`（只有交互式 shell 读它），非交互式读不到。
- **允许 shell 覆盖 `DSH_*`**：控制面在读取之前已解析 `DSH_HOME`，让启动文件改它会指向另一个 home。
- **等待 stdout 关闭**：启动文件拉起的后台进程会一直占着 stdout，等于每次读取都超时。
- **在控制面无条件读取**：gateway/systemd 由服务管理器提供环境，读账号登录 shell 会把服务错误绑定到某个用户配置。

#### Rejected alternatives（首启设置迁移）

- **每次缺 `settings.yaml` 就重播种**：0.1.7 的正常导入会使该路径永久缺席；重播种导致每次启动重新导入默认中文，覆盖用户后续选择。

### 3.2 就绪探测与端口占用判定（TCP + 统一身份探针）

```
starting ──① TCP connect 127.0.0.1:P（250ms 间隔轮询，总窗口 90s = LISTEN_WAIT_MS）
              └─ 失败/超时 → 若子进程已退出：启动失败；否则继续轮询
          ──② 统一身份探针（90s 窗口内无限重试；浏览器鉴权 cookie 刚 mint 的
             第一次重试立即发起，其余失败按 500ms 退避）→ 成功 = ready
              └─ 失败（非 JSON / 非 200 / 契约不匹配）→ 重试
                 —— TCP 通但身份探针失败 = 端口被无关服务占用（协议不匹配），
                    杀子进程 → 按 §2.2 以 P+1 重试
ready
```

- 就绪成功：`dshPort = P` 写入进程记录，仅从当前 PlaneHandle 投影到 REST/SSE（status `ready`，03 §2.1）；不把运行态写回共享 catalog。
- 就绪失败（超时 / 进程退出 / 重试耗尽）：显式启动失败，附完整启动输出与 `--dump-config`建议（`dsh --profile web --dump-config` 检查组合树）。
- **探针 = 统一身份契约（rpc-envelope.ts 单源；`probeHostIdentity`）**：POST `/api/session/canOpenWorkspacePath`（SessionController `session` namespace 零参 boolean Remote，钉住上游 dsh ≥ 0.1.2-rc.1；纯同步平台检测，不读会话数据、不激活 Agent、无 IO），200 + rpcId 回显 + `result.ok === true` + boolean value（**true/false 均健康**）即通过；响应上限 64 KiB（探针专用 per-call cap）。HTTP 404 = 部分 0.1.2-alpha.x 早期树 / dsh < 0.1.2-rc.1（无此方法）→ 自动回退 legacy `session/list`（默认 1 MiB 上限，与旧版语义逐位一致，老树不劣化）；**回退成功后**写 warning（双 404/transient 安静；每连续 legacy 期至多一条——STATUS 挂账⑦），使上游未来方法漂移可见、不静默；404 之外（401 认证门、5xx、超时、畸形）一律如实失败、不回退。
- 身份探针响应为固定小体积 boolean，只用于就绪与健康探活，不作任何会话级消费（协议细节以 dsh wire /vendor 源码为权威）——探针体积与宿主会话数量彻底解耦；控制面 unary fetch carrier 对单个 JSON 响应实施流式字节上限（身份探针 64 KiB / legacy 回退 1 MiB），声明长度与实际流均受约束，异常宿主不能借探活把响应无界缓冲进控制面。

**Rejected alternatives（重试节奏）**：① 统一去掉 500ms 退避——未就绪或端口被无关服务占用时会把有界重试变成热自旋，故只免「cookie 刚 mint」这一次；② 把退避降到 100ms——对 401 之外的真实失败（5xx/畸形）没有收益，只是把重试次数抬高一个量级。

### 3.3 进程记录文件（managed-dsh/<pid>.json）

目录：`<stateDir>/managed-dsh/`（缺省 `~/.dsh-chamber`，`$DSH_CHAMBER_STATE`可覆写；04 §6）。

```json
{
  "pid": 31415,
  "ownerPid": 27182,
  "ownerInstanceId": "3f2b…-uuid",
  "port": 17510,
  "binary": "/opt/deepseek/node_modules/@deepseek-ai/dsh/lib/bin.js",
  "profile": "web",
  "source": "spawn",
  "startedAt": "2000-01-01T00:00:00.000Z"
}
```

- 写文件：`writeFileSync(tmp-<pid>) + renameSync` 原子替换；**写入失败时**清理已 spawn 的子进程（`killFailedSpawn`：进程组 SIGKILL → 确认退出 → 删记录）并使本次 spawn 失败——绝不遗留无记录可追踪的 detached 进程；
- 读取：跳过非 `.json`；解析失败或 `pid` 非整数 → 删文件（损坏即丢，不猜测）；
- 注销：`removePidRecord(pid)` 只在**确认进程已退出**后调用（存活幸存者留在注册表等下次 reaper）。

### 3.4 reaper（孤儿回收）

启动时（spawn 前）对每个条目执行：

```
1. 仅处理本目录记录 —— 用户的 dsh 实例从未入册，永不是候选
2. 条目解析失败 / pid 非整数 → 删文件
3. pid 已死（kill(pid,0) 失败且非 EPERM）→ 删文件，无事可做
4. 身份重验（Unix：ps -p <pid> -o ppid=,command=）：
   a. 记录的 `binary` 必须是绝对路径，且只认可两个受管入口后缀：安装产物
      `node_modules/@deepseek-ai/dsh/lib/bin.js` 或源码 dev
      `apps/cli/src/bin.ts`；该**完整绝对路径**必须作为独立 argv token 出现在
      活命令串中。旧版 basename-only（`dsh` / `bin.ts`）记录无法证明身份，
      fail-closed 保留不杀；
   b. profile/port token 必须与记录逐项一致：命令含精确
      `--profile web` 与 `--port <recordedPort>`（不做 substring 猜测）；
   c. 端口归属：探测该端口的监听 pid == 记录 pid
      （lsof → ss → /proc 三级探测；全部不可用或 port 缺失/非法时 **fail-closed
      保留不杀**——无法证明归属就不动；Windows 身份判定见 §5.1（CIM 表；tasklist 无父进程信息故不用））
      —— 防 pid 复用：回收的 pid 指向无关进程（哪怕它恰巧也是 dsh）时放行
   d. a/b/c 任一不成立 → 不杀，保留文件；诊断只记 pid/判定，不回显被复用
      pid 的完整命令行（它可能属于无关进程并携带凭据）
5. 孤儿判定：ppid == 1（被 reparent 到 init）或 ownerPid 已死
   —— 不成立（owner 仍活）→ 不杀，保留文件【多实例安全】
6. 杀：进程组 SIGTERM → 轮询 1.5s → SIGKILL（killOrphan 序列）；删文件
```

**安全总结**：杀进程须同时满足"本产品记录过 + 身份重验通过（binary/profile 命令串 +端口监听者 pid）+ owner 死亡/reparent"，三者缺一不动手。

**闩锁的两种关闭原因与会话内再证明**：启动扫描只在"零 kept 且零 errors"时打开 `localWritersQuiescent`；关闭原因两类，只一类可再证明：

- **扫描判定**（记录被保留：身份探测不可用、身份不匹配、端口不可核对、残留进程组…）——可被**再一次扫描**推翻，故拒绝启动前做一次有界再证明（单飞行 + 2s 冷却）：孤儿在此期间退出的常见情形**无需用户动作**、也无需重启应用即恢复。取消启动被拒时抛 409，结构化阻塞清单（`writers[]`：pid/原因/`takeOverAvailable`）随 `detail` 上浮。
- **写入期终止失败**（`onWriterQuiescenceUnknown`：刚杀过的进程组无法证实已退出）——本平面把这次失败记录为 `writerSuspect{pid, since, lastError}`（`LocalWriterSuspect`）：**`hasLiveProcess()` 把"存活子进程 或 suspect 非空"一律判为可能仍在写 DSH_HOME**（退出确认、写租约释放与下一次 start 的闸都用这一判据；失败路径丢掉 child 引用不等于写者已静止），`/api/connections/local/writers` 投影结构化 suspect；**任何扫描都无法证明它不在**，故该闩锁对本平面生命周期**粘滞**，只有重启应用重走启动扫描才可能恢复；诊断文本明确点名"需重启应用"。

**显式接管（`takeover` 模式，入口 04 §3.2 `POST /api/connections/local/reclaim`）**：默认扫描 fail-closed 保留的条目里，两类属于**本状态目录自己的**陈旧/孤儿写者，由用户显式点击「清理并接管」时清除（`runReaper({takeover:true})`）：

- **ps 证明该 pid 已不是记录的托管 dsh**（pid 复用或进程已退出）→ **只删记录，绝不向该进程发信号**；
- **身份不可探测但 owner 已死、且记录 pid 仍持有记录的监听端口** → 视为本目录的孤儿托管宿主（同目录 ⇒ 同 DSH_HOME 族），按第 6 步杀（`takeover-reclaimed`）；身份探测成功但监听端口核对不可用时同样允许杀。
- **永不接管**：owner 仍活（另一个应用实例正用它）、端口探测答"不是它"（证据自相矛盾）、记录损坏/pid 不可信（删记录等于让闩锁谎报静止——留给人工处理并在诊断里点名）、残留进程组。

### 3.5 健康监控：七态状态机

```
stopped ──spawn──► starting ──ready(§3.2)──► ready ──fail(1..N-1)──► degraded
   ▲                    │                        │  │                    │success
   │                    └─失败/退出──────────────┼──┼───────────────────► ready
   │                                            │  └──fail(N)┐
   │                                            └─────restarting──────┐
   └──── graceful stop ────────────────────────────────────────────────┘
                                  └─ kill → 端口释放 → respawn → ready（spawnDsh 内建 TCP+统一身份探针就绪探测，§3.2）
   spawn 失败 ──► error（fail-loud）──start() 重试──► starting
```

| 态 | 含义 | 进入 | 离开 |
|---|---|---|---|
| `stopped` | 未运行 | 初始 / 优雅停止完成 | spawn |
| `starting` | 已 spawn，未就绪 | spawn | 就绪 → `ready`；失败/退出 → 重启或 `stopped` |
| `ready` | 可服务 | 就绪探测成功 | 探测失败累积计数 |
| `degraded` | 失败计数 ≥1 且 < 阈值，仍在服务 | 失败 | 任意成功（清零）→ `ready`；阈值 → `restarting` |
| `restarting` | 单飞行重启中 | fail(N) / 进程死亡 | 重启成功 → `starting`；耗尽且退出已证明 → `restart-exhausted`；退出证明 unknown → `error` |
| `restart-exhausted` | 停止自动重启，等待人工（**只在退出证明 proven 后进入**） | 窗口内重启次数超限且本代进程组退出已证明 | 人工介入（幂等启动 / 停止） |
| `error` | spawn 启动失败或写者静止未证明（fail-loud，不静默） | spawn 失败 / 不可恢复 / 退出证明 unknown | `start()` 重试 → `starting`（证明已恢复时）；或停止 → `stopped` |

探测（两通道共享一个计数，§2.4）：

| 通道 | 触发 | 实现 |
|---|---|---|
| 周期 | 定时器（缺省 30s，可配） | 统一身份探针 `session/canOpenWorkspacePath`（`probeHostIdentity`，§3.2），5s 超时；老树 404 → legacy `session/list` 回退，回退成功才 warn（每连续 legacy 期至多一条，§3.2/STATUS ⑦） |
| 传输触发 | （设计预留；反代侧连接异常触发健康检查**未实现**——`InstanceProxyDeps` 无健康回调，当前仅周期通道驱动） | — |

- 单飞行探测：并发触发共享一个 in-flight promise，结果带 750ms 缓存；
- 计频节流：两次计数至少间隔一个窗口 W（独立于探活周期，缺省 15s）；
- 进程死亡分支：探活失败且子进程已退出 → 不计数，立即重启；
- 阈值：N=20（连续计数，可经构造参数覆写）；
- 检出预算：30s 周期 × N=20 ≈ 10min 才累计到挂起判定；child-exit（立即重启）与传输触发（设计预留）兜底；身份探针固定小体积、不读会话列表——健康判定与宿主会话量增长彻底解耦；
- 成功 → 清零计数 + 状态回 ready。

### 3.6 重启序列与背压

```
1. 单飞行守卫（currentRestartPromise 去重，并发触发共享同一重启）；
   停止过程（优雅停止进行中）直接返回
2. 回收 = 单一回收原语（五入口全走它：start 预清理、restart 循环、restart-exhausted、stop 的第二次回收、取消的 spawn）：
   进程组 SIGTERM（dsh profile-boot 对 SIGTERM 优雅退出，exit 0）→ 1s 未退 → SIGKILL
   → 轮询整个 detached 进程组退出（判据 = leader 与组内后代都已不在；`exitCode`/`signalCode`
   任一非空只证明 leader 死了，不再作为跳过组证明的理由）；**先证明、再清引用/改状态/发布**，
   确认退出后才注销进程记录
3. 端口释放等待：固定端口场景下新宿主仍用同端口——旧进程死透才能复用
   （实现：无独立等待轮询——spawn 侧端口预检 + P+1 退让覆盖占用窗口，§2.2）
4. respawn（§3.1，同端口 P；若端口仍被占走 §2.2 的 P+1 路径）
   → 新 pid.json → 就绪探测（§3.2）
5. 健康失败计数 N 清零（注意：与 restart 背压窗口 M 不同——design 18
   §9.3(5) 的 M 对每次重启（含成功）计数）；失败 → 指数退避（1s→60s，jitter）
6. 窗口内（10min）重启次数 ≥ M（5）→ **先证明本代进程组退出，再发布 `restart-exhausted`**：
   停止自动重启，状态由 live surface 暴露（不落 catalog），等待人工介入（POST /api/connections
   幂等启动或桌面设置页操作）；绝不无限重启循环。退出证明 unknown ⇒ 不发布 `restart-exhausted`
   （自动运行时回退不得起跑，设计 18 §3.4），落 `error` + suspect 闩锁
7. **迟到的健康判定（契约）**：start 换代、进入 restart、stop() 三个拆代点都取消在途健康
   探针（abort + `healthEpoch` 递增 + 清缓存/定时器）并等待其落定；判词、缓存与单飞槽
   只归发起代（迟到的失败不计、迟到者只释放自己的槽）；任何在 `stopped`/`error` 态或
   start 在途时到达的失败判定一律惰性（不计数、不触发重启——start 在途时
   重启被抑制，防止双 spawn）；spawn 失败落在 stop() 之后（epoch 已变）也不得
   把 `stopped` 改回 `error`。
8. **手工启动代次**：候选端口预检和 TCP 就绪轮询的
   每次 loopback connect 均有 1s 上限；预检超时按“端口归属不明/忙”保守跳过，
   不在未知端口上拉 detached host。stop() abort 当前 spawn 代次（端口预检、
   TCP 等待、身份探针就绪等待及最后 browse 能力探测均消费同一取消
   信号、销毁在途 socket 并清理 detached 尝试），等待旧代终结后释放该代的
   single-flight 槽；迟到结果以
   epoch 判旧，若已产出子进程则
   自行终止，若失败则不得清空新代的 `child/dshPort`。因此
   start→stop→start 会创建全新 spawn，不复用旧 promise，也不被旧代反写。
```

**退出证明 unknown 的语义（fail-closed）**：回收原语只在 detached 进程组退出已证实时返回成功；无法证明（终止调用抛错、组存活轮询超预算、取消代的孩子无法确认）⇒ 记录 `writerSuspect`（`LocalWriterSuspect`）、置粘滞闩锁、向调用方抛 typed 错误 `dsh_writer_quiescence_unknown`（`DSH_WRITER_QUIESCENCE_UNKNOWN_CODE`），且**不清 `child`/`dshPort`、不改状态、不发布 `restart-exhausted`/ready/stopped**。调用方语义：start 预清理失败 ⇒ `error` 并让启动请求失败；restart 失败 ⇒ `error`，`restartLocal()`/`stop()` 的等待者看到拒绝；耗尽分支失败 ⇒ `error`（不是 restart-exhausted，故自动运行时回退不触发，见设计 18 §3.4）；stop 失败 ⇒ 拒绝（永不报告 `stopped`），`PlaneHandle` 不释放写租约、闩锁保持关闭。逃生阀维持"重启应用重走启动扫描"，不提供强制回收入口。

**child-exit 监听属于启动代**：只在把 spawn 结果采纳为当前代时挂 exit 监听并记录 owner；回收原语先摘监听再证明（迟到的 exit 既不能另排一次 restart，也不能与本代回收竞态）；回调再按 owner 判代，已被替换的旧代 exit 一律惰性（无 `off` 的结构替身也安全）。

#### Rejected alternatives（本地回收与写者静止）

- **无证明也释放**（先清 child、发布 `restart-exhausted`/stopped，失败只记日志）：会让自动运行时回退与"可能仍在写 DSH_HOME 的进程"并发（快照恢复/指针切换/数据恢复），把证据缺口洗成"已停止"；安全不变量取"未证明静止就不释放"。拒绝。
- **新增强制 kill / 强制解锁 API**：进程组归属不可证时（PTY/后代逃逸 PGID、pid 复用、探测不可用）再发一次更强的信号也不产生退出证明，只是把风险搬进 IPC 并给"绕过闩锁"一个官方入口；可证明的残留已由 reaper 的 takeover 覆盖，其余维持"重启应用再证明"。拒绝。
- **leader `exitCode` 非空即视为已退出**：leader 被信号杀死或先死后代仍活时会假阳性；统一用 detached 进程组的退出证明。拒绝。
- **每次读时重建/轮询组证据代替 suspect 记录**：无法把"某一时刻没看到"变成"不会再有写"；fail-closed 地记录一次 suspect 才是可判定状态。拒绝。

### 3.7 优雅停止

- `DELETE /api/connections/local`（04 §3.2）/ 桌面退出 / systemd stop：SIGTERM 进程组 → 1s → SIGKILL；确认退出后注销记录，状态回 `stopped`；退出证明 unknown ⇒ DELETE 路由映射 **409**（code `dsh_writer_quiescence_unknown` + detail `{pid, since, reason}`），绝不折成 500/503，stop 拒绝并保持写租约；`GET /api/connections/local/writers` 暴露同一诊断结构；
- stop 单飞行：并发或紧邻的停止调用共享同一 promise；已完全静止（无 child、无在途 start/restart、无 `writerSuspect`）时为无日志 no-op，故同一代生命周期只落一条 `state=stopped`；
- 停止同时取消在途手工 spawn，等待其 owner 清理后释放 single-flight 槽；不响应取消的迟到测试seam/适配器仍由 epoch 守卫隔离，不能复活或覆盖随后启动的新代；
- **崩溃路径**：控制面被 SIGKILL → 宿主成为孤儿 → 下次启动 reaper 回收（§3.4）——`detached: true`保证宿主不连带，孤儿回收保证不泄漏；
- **会话数据不丢**：dsh 侧 JSONL 持久化在 `$DSH_HOME/sessions`，重启后由前端 runtime 经会话基线完整恢复（控制面不持有任何会话权威——01 §5 原则 4）。

### 3.8 host-logs 滚动日志

- 宿主 stdout/stderr 行写入控制面**滚动缓冲**（RING_BUFFER，如 500 行 / 按字节上限）；启动诊断字段（binary/args/cwd/env 键数/PATH 项数）随注册表进程记录登记（见 §3.1）；
- 写入面按 backing path 共享一条**异步串行 lane**（stdout/stderr 与 lifecycle writer 共用队列及compaction ring，append 与临界 rename 绝不并行）：child `data` 回调先在 Buffer 层截为最多 64 KiB、加固定截断摘要，再解码一次供 logger/writer 共用；writer 只入队、不同步文件 I/O，在 child `close`（stdio 已关闭）后退役。每 host 在途最多 256 条 / 512 KiB，达任一高水位即丢弃**最新**诊断条目，绝不反向暂停/阻塞宿主 pipe；未跨行数 cap 的批次只 append，跨 cap 的批次直接原子替换为尾部 ring（不先 append 再整文件重写）；`flush/close` 可等待调用前已接纳条目落定。append 绑定 no-follow `O_APPEND` active inode，首次创建 O_EXCL 0600，完整写 + file fsync；compaction 用随机同目录O_EXCL temp、identity 复验、rename + parent fsync；active leaf 被删/换即切新 generation 并丢弃旧ring，绝不穿越 symlink/硬链接或复活被移除 backing；
- 读取面：`GET /api/host/logs`（04 §3.3，local-only）——桌面 chamber-settings 插件展示"本地实例日志"；远程实例日志经 `desktop_ssh_logs` IPC（03 §2.2）；
- 写入或压缩失败即丢弃失败批次及其后已排队诊断并切到新日志代次（清空旧内存 ring/计数并重新 setup）；只有失败后到达的**新写入**发起一次新 setup，永久磁盘故障不会形成无限重试队列；旧 backing file 被删除后绝不由临界压缩把历史 ring 复活，失败写也不在下次重建时重复；
- **控制面自身日志落盘**（取证缺口修复）：`createControlPlane` 无条件给注入的`options.logger`（默认 console）加文件 sink，写 `<stateDir>/logs/control-plane.log`（JSONL `{ts,level,line}`；单文件 2 MiB、3 份轮转环（最小 2 份）；目录 0700、文件 0600、**常驻句柄 + O_NOFOLLOW**——与本节 host-logs 的 no-follow/0600 纪律同族）。动机：控制面是`proxy-forward` WS splice 取证行（`WebSocket stream <id> closed (<cause>, Nms)`、`heartbeat lost …`）的**权威**来源，而打包态由 Finder/Dock 启动时 console 不落盘（design 14 §D4 实测）；控制面拥有 stateDir，故 Electron 与 Swift 壳**共用同一实现**（Electron 壳已冻结归档，共享实现仍现行、Swift 腿继续使用）。写失败/轮转失败只降级为「不落盘 + 告警一次」，日志绝不能成为新失败面；`stop()` 关句柄、`start()` 重开（plane 支持 stop→start 重启）。**被否替代**：①写进 `host-logs/<port>.log`——那是**被管理宿主**的stdout/stderr 管道（按端口寻址、有读侧 API），混入会冒充宿主日志；②只依赖 stdout——打包态不落盘，正是本条动机；③两 flavor 各写一份——多的只是漂移面；④删原生壳 `sidecar.log` 只留`control-plane.log`——两链生命周期不同步：`sidecar.log` 覆盖控制面 sink 建立**之前**的 stderr（含 fatal 启动输出），兜底价值大于重复成本（保留量差异登记 deviations T-25）。**与原生壳的关系**：原生壳另有 `<userData>/logs/sidecar.log`（design 25 §3.1）作**兜底**；同一批 console 行两处各存一份、保留量不同（Electron 腿冻结归档，其 `2 MiB × 3` = 6 MiB 为历史值；原生壳另有 `256 KiB × 2` = 512 KiB，合计6 MiB + 512 KiB），该 flavor 偏差登记在 deviations。
  - **写入面纪律**：①日志行**同步**追加（每行一次 `writeSync`，无 fsync）——与本节 host-logs 的"只入队、不阻塞"不同，取舍是"崩溃前最后几行必须在页缓存里"（取证价值）换"每行一次系统调用"，开销有界；若实测到事件循环停顿，改法是入队 + 批量 flush（代价：崩溃时丢队列里的行）。②`logs/` 与 `control-plane.log` 的 0700/0600 在**每次打开时显式收紧**（`mode` 只在创建时生效），且**先判符号链接再 chmod**（chmod 跟随链接）；best-effort——chmod/fchmod 失败的平台继续落盘，不把日志变成新失败面。③常驻句柄每 64 行做一次 dev/ino 巡检：文件被外部删除/替换即重开（否则会一直写进已 unlink 的 inode，最多丢掉整个上限的日志而不自知）。④**多进程共享**同一 stateDir时不做跨进程锁：桌面两 flavor 由目录锁串行，`dsh serve`/standalone 没有——整行 O_APPEND 保证行不撕裂，但轮转环可能出现两份水位（影响限于日志内容）。
  - **重复面（有意，不是双写缺陷）**：被管理宿主的 stdout/stderr 每行都经控制面 logger，**同时**进入 `host-logs/<port>.log`（宿主面、按端口寻址、有读侧 API）与 `control-plane.log`（控制面面、统一时间线）。
- 纪律：日志永不含凭据/令牌（05 §8 安全不变量）。

### 3.9 systemd 单元（远程实例部署参考）

远程服务器的 dsh 实例以 systemd 单元持久化（loopback 固定端口；无需 web 前端——UI 由本地复用前端经隧道提供）：

```ini
systemd 单元完整示例（User/Group/PATH/Environment、gateway 单元形态、用户单元与 linger）见 [remote-dsh-instance.md](../../deploy/remote-dsh-instance.md) 与 [deploy-gateway.md](../../deploy/deploy-gateway.md)；硬契约 = `--host 127.0.0.1`、`--port` 与 `--trusted-host` 恒一致、`Environment=PATH=<node-bin-dir>:…` 整行字面赋值。
```

目录归属与无 root 形态（完整单元示例见 docs/deploy/remote-dsh-instance.md，与 README「服务器端部署」一致）：

- **归属不变量**：dsh 默认把 home 放在运行账号自己的家目录（`~/.dsh`，即 `${DSH_HOME:-$HOME/.dsh}`）——**无需设置 `DSH_HOME`**，也不再有 `/var/lib` 路径与 root 属主问题。单元运行账号（示例 `dsh`）只需有真实家目录：建号用 `sudo useradd --system --create-home dsh`（`useradd --system` 默认**不创建**家目录，必须加 `--create-home`）；以 root 运行则写到 `/root/.dsh`（归 root，不推荐）。
- **无 root 形态**：服务器无 root 时改用 systemd 用户单元（`~/.config/systemd/user/dsh.service`+ `systemctl --user` 管理，`loginctl enable-linger` 一次性启用保证开机自启与登出存活）。ssh-provider 的 systemd exec 恒为系统管理器（无 `--user`），用户单元对 chamber 桌面起停按钮不可见——实例靠 linger 常驻、隧道照常，管理走服务器端 `systemctl --user`。

编排语义：

- **起停/状态**：经桌面 transport-manager（ssh provider）的 systemd exec IPC（`desktop_ssh_start_service/stop_service/is_active`，serviceName 白名单`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`，首字符必须为字母或数字）驱动（03 §2.2）；provider 固定以参数数组执行 `systemctl <action> -- <serviceName>`，`--` 明确终止 option 解析——控制面不直连远程进程，只经隧道消费其 API 面；
- **停止**：`systemctl stop` → SIGTERM → dsh profile-boot 优雅退出（exit 0）；
- **崩溃**：`Restart=on-failure` + `RestartSec=3` 拉起（用户侧单元示例见docs/deploy/remote-dsh-instance.md）；常见崩溃原因：node → `status=127`（`/usr/bin/env: 'node': No such file or directory`），须显式`Environment=PATH=<node-bin-dir>:/usr/local/sbin:...`（整行字面赋值，无追加语法、无变量展开）；
- **绑定面**：恒 `--host 127.0.0.1`（loopback）——chamber 隧道是唯一入口，不额外暴露面；绕过隧道直连（0.0.0.0）须配套鉴权（v1 实例匿名）或反代前置（dsh 目标匿名 loopback 直连须反代/TLS 前置；gateway 目标自带认证边界与公网请求策略，17 §5.1/§6）。
- **远端 chamber host 包**：SSH transport 进入 `ready` 后，桌面主进程调用`seedRemoteChamberHostPackages`，把本次实际已构建的 host-graph + Git worktree + archive-cleanup三包写到 `<remoteDshHome>/profiles/node_modules/@dsh-chamber/<package>/`，并对`<remoteDshHome>/profiles/web/cordis.patch.yml` 做一次合并写。它复用受限 `cat/write-file` 通道，仅做分发，**不经 SSH 执行 Git**；已运行的远端 dsh 需重启后才加载新 row，完整原子顺序、去重与失败语义见设计 13 §3。

**gateway 目标单元形态（design 17，v2）**：远程 gateway 部署以`dsh-chamber-gateway.service` 单元持久化（`install-gateway.sh` 一键安装器生成，17 §5），默认监听远端 30801（gateway 目标 `remotePort` 缺省；dsh 目标 30800 不变，17 §2.2）：`ExecStart=<GATEWAY_BIN> serve --host 127.0.0.1 --port 30801 …`，服务账号 / `NoNewPrivileges` / `PrivateTmp` / PATH 环境要求同本单元；凭据经 owner-only systemd `EnvironmentFile` 注入（17 §5）。ssh transport 的 systemd exec 起停目标按 `serviceName` 在该单元与 `dsh.service` 间选择（03 §2.2 schema v2 注）。

**http 直连形态（transport=http）**：无隧道子进程、无 systemd exec——桌面直接以 http(s) 访问目标端点。dsh 目标需**用户自建穿透**（TLS 反代 / tailscale / SSH 隧道 / frp，17 §1.1）把 loopback 实例暴露为可直连端点；gateway 目标即其入口本身（自带认证边界，17 §5.1/§6）。该形态下 systemd 单元只作服务器侧部署参考，桌面侧不再编排远端服务起停（`serviceName` 留空，03 §2.2）。

---

## 4. 复用映射表

| 控制面需要的功能 | 复用来源（dsh / 参考实现） | 控制面做的编排 |
|---|---|---|
| web profile 装配（webserver + `/api` 桥 + 前端 + 信任栅栏） | dsh `apps/cli`（`--profile web`、`--host/--port/--trusted-host`） | 拼命令行 + spawn；`--trusted-host 127.0.0.1:<port>` |
| `/api` 浏览器信任栅栏 | dsh connection（loopback / trustedHosts） | 反代源 127.0.0.1 loopback 直连（03 §3） |
| 统一身份握手（`session/canOpenWorkspacePath` boolean） | dsh SessionController `session` namespace（rpc-envelope.ts 单源契约；legacy `session/list` 404 回退） | 就绪探测第二段 + 健康探活（§3.2/§3.5） |
| 孤儿回收安全模型 | 参考实现 `managed-process-registry.js`（记录在案 → 重验 → owner 死才杀） | 移植 + 改造：命令串含 `--profile web`、lsof 端口归属校验（§3.4） |
| 健康监控 / 重启 / 背压 | 参考实现 `lifecycle.js`（共享失败计数、节流、单飞行重启、端口释放） | 探活载荷换统一身份方法；删"忙会话宽限"（§2.4/§3.5） |
| 优雅退出 | dsh profile-boot（SIGTERM dispose） | SIGTERM 进程组 → SIGKILL 兜底（§3.7） |
| chamber host 包附着 | `@dsh-chamber/dsh-chamber-seed-client-graph` + `@dsh-chamber/dsh-chamber-seed-git-worktree` + `@dsh-chamber/dsh-chamber-seed-archive-cleanup`（design 24）+ `@dsh-chamber/dsh-chamber-seed-open-in`（design 20 §6，仅本地形态） | 按构建产物 seed + 单一 loader overlay；只分发，不消费 graph/Git/归档清理/open-in 业务（§2.6） |

---

## 5. 边界与未决问题

> 各条目以 5.x 编号供外部引用。

### 5.1 Windows 路径退化（契约见 design 23）

`detached` 语义、进程组信号、`lsof` 均不可用——Windows 实现见`packages/control-plane/src/win-probes.ts`(design 23):身份 = PowerShell CIM(命令行/PPID)、端口归属= netstat、树终止 = `taskkill /T /F` + CIM 残余后代清扫;reaper/spawn-dsh 平台自适应接线,全部fail-closed(不可证即保留/拒绝)。残余让步(妥协 F1/C6-C8):无 SIGTERM 握手 → 硬终止 + 事务恢复;身份证明依赖 PowerShell 与同行权限可读 CommandLine。**（Windows 腿已随 Electron 冻结归档、不发布）**win32-only 集成测试见 `win32-lifecycle.integration.test.ts`（冻结保留，不在默认测试组）。

### 5.2 起始端口选择

起始端口经 `DSH_CHAMBER_DSH_PORT_BASE` 覆盖（缺省 17510；非法值 loud 一次后回落，不提供每实例偏移），固定起点 + P+1 有界退让 + pid 记录仲裁，形态与依据见 §2.2。

### 5.3 trusted-host 与反代 Host 头

`--trusted-host 127.0.0.1:<port>` 对应反代转发时的 Host 头（转发保持实例自身 host:port，不改写）；若未来引入自定义 Host 场景需同步扩展 trusted-host 集（05 §7.5 固定形态）。

### 5.4 restart-exhausted 后的恢复策略

重试入口与计数重置见 §3.6（连接 API 幂等启动或桌面设置页操作；一次成功就绪即清零）。

### 5.5 host-logs 容量

RING_BUFFER 行数/字节上限取桌面场景经验值（如 500 行），滚动丢弃；长期留存/导出不在范围。

### 5.6 `$DSH_HOME` 与多用户冲突

宿主 `DSH_HOME` 固定为 `<stateDir>/dsh-home`（§3.1），多控制面实例共享同一 stateDir 时才共享该home——会话 JSONL 追加式多写安全，settings 为 last-writer-wins 文档、由 dsh `settings-conflict`仲裁；不同 stateDir 的实例互不相干。**服务器远程形态（§3.9）不再设置独立 `DSH_HOME`**：远程实例以单元运行账号身份直启 dsh，home 即该账号自己的 `~/.dsh`——dsh 本就是「一账号一 home、多 profile 共存」的模型（`$DSH_HOME/profiles/<name>`），web profile 与同账号其他 profile 共享 home 是上游支持的常态。独立 home 的诉求只存在于控制面托管宿主（stateDir 生命周期/可移植性，§3.1）；若确有「同账号多 profile必须互不共享配置」的罕见诉求，仍可显式 `Environment=DSH_HOME=...` 隔离。
