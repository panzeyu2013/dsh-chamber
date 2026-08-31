# 02 · 宿主管理（web profile）：本地 dsh 宿主进程的托管与部署形态

> 本地 dsh 宿主进程的托管与部署形态（v1 定稿 2026-08-14；设计 08/09
> host-package seed 接线更新 2026-08-20）：
>
> - **profile 改用 dsh 内置 web profile**：`dsh --profile web --host 127.0.0.1
>   --port <port> --trusted-host 127.0.0.1:<port>`——不再生成/维护自建 profile
>   目录、业务 patch stack 或 glue 插件，端口不再随机分配，改为固定端口 +
>   占用重试（port+1）。唯一例外是设计 08/09 的**宿主包 loader overlay**：它只
>   把 chamber 自带的两个 host 包挂入官方 web profile，不接管宿主组装权威（§2.6）。
> - **保留沿用**：spawn 生命周期、端口占用重试、pid 记录
>   （ownerPid/ownerInstanceId/port/binary/profile/source/startedAt）、
>   instance-id 仲裁、readiness（TCP + `host.describe`）、健康七态状态机、
>   reaper、host-logs 滚动日志、systemd 单元（部署形态，远程实例参考）、优雅停止。
> - **删除**：slim profile 生成与维护、glue 插件、旧业务补丁层 HMR 分类与
>   `POST /api/config/reload`、external 接管 / claim、部署五形态（收为
>   桌面一体一形态）、README 快速连接承诺。
>
> 权威契约：`05-connection-manager.md`（架构 / PlaneHandle）；管理面端点见
> `04-control-plane-api-data.md`；连接模型见 `03-connections-proxy.md`。
> 服务端部署形态（gateway 单元 / http 直连）与远程连接模型 v2 见
> `17-server-side-gateway.md`（2026-09 v2）。

---

## 1. 目标与范围

### 1.1 目标

1. 控制面在同机以 **dsh 内置 web profile** 拉起本地宿主（`--profile web
   --host 127.0.0.1 --port <port> --trusted-host 127.0.0.1:<port>`），该实例
   即连接模型的 `local` 连接（connectionId `'local'`，03 §2.1）；
2. 宿主进程生命周期完全由控制面管辖：spawn（detached）→ 就绪探测 → 健康
   监控 → 失败重启（带背压）→ 优雅关闭；控制面崩溃后遗留的孤儿宿主可被
   安全回收；
3. 用户的宿主配置/设置变更由 dsh 原生机制自行处理（web profile 自带配置
   平面），控制面不介入；chamber 自带 host 包的 loader 附着仅走 §2.6 的
   独立、确定性 seed，不成为配置权威；
4. 明确部署形态（桌面一体）与 systemd 单元（远程实例的部署参考形态）。

### 1.2 范围

- **in**：local 实例的托管（spawn / 就绪 / 健康 / 重启 / 回收 / 仲裁）、
  pid 记录、host-logs 滚动日志、systemd 单元、优雅停止；chamber 自带 host
  包的确定性分发与 loader overlay（§2.6）。
- **out**：会话/目标/终端等宿主能力（宿主原生，前端经每实例反代消费，
  03 §3）；dsh 连接协议（wire 以 vendor dsh-host-apiproxy 为权威，控制面仅用
  describe/健康探活面）；认证/审计
  （匿名 loopback 控制面随 v1 收敛整体移除；gateway 部署的认证/凭据/审计
  见 17 §7/§13.4）；远程实例的隧道与 systemd 编排（03 §2.2：桌面
  主进程 transport-manager（ssh provider）+ 注册表）。

### 1.3 原则

- **复用而非重造**：web profile 是 dsh 官方装配（base + web-app），控制面
  零代码复用其 webserver、`/api` 桥与浏览器信任栅栏；控制面只编排：解析
  binary、spawn、读输出、端口重试、探活、计数、重启、回收。
- **只杀自管进程**：reaper 的三重校验（记录在案 / 身份重验 / owner 已死）
  是安全底线。
- **诚实失败**：端口占用、启动超时、探测失败一律显式报错（fail-loud），
  绝不静默降级。
- **只附着，不下沉业务**：控制面可复制 chamber 自带 host 包并挂 loader row，
  但不解析其业务数据，也不执行 Git；Git worktree 事实与命令始终属于实例内
  `@dsh-chamber/dsh-host-git-worktree`（设计 08）。

---

## 2. 设计思路与关键决策

### 2.1 为什么用内置 web profile（而不是自建 slim / 裸进程）

| 方案 | 结论 |
|---|---|
| 自建 slim profile（v2 `dsh-control` patch stack + glue 插件） | **v4 放弃**：生成/维护 profile 目录与补丁层 = 控制面持有"宿主组装权威"，还需出树插件（glue）发布端口；而 dsh 官方 `web` profile 已把"API 面 + 前端 + 信任栅栏 + 命令行端口"整体打包 |
| **`dsh --profile web --host 127.0.0.1 --port <port> --trusted-host 127.0.0.1:<port>`（选定）** | 官方装配（`apps/cli/reference/README.md`：`web` profile 首次使用自动初始化；`--host/--port` 覆盖组合行；可重复 `--trusted-host` 向 `/api` 浏览器信任栅栏加入权威；`--host 0.0.0.0` 被 dsh 拒绝）。v4 前端本就复用 dsh 官方前端（单 frame 加载控制面同源），进程携带 web bundle 正是所需 |

**决策理由**：v4 的界面 = dsh 官方前端（源码复用），本地实例的进程形态随之
收敛为官方 web profile——"控制面要一个什么样的宿主"由 dsh 官方命令直接表达，
不再维护私有组装层。`--trusted-host 127.0.0.1:<port>` 保证经控制面反代到达
的浏览器请求（`Host: 127.0.0.1:<port>`，Origin 为控制面同源）通过 `/api`
信任栅栏（`dsh web` 是 `--profile web` 的硬别名，两者等价）。

### 2.2 端口占用重试（port+1）：固定端口 + 确定性退让

web profile 的 `--port` 是**固定端口**（非 0 随机）。控制面选定起始端口
（本地默认如 17510；端口不可在 `POST /api/connections` 中显式指定——body
仅收 kind/label/accentColor，见 04 §3）后：

```
尝试端口 P：
  spawn 后就绪探测（TCP + host.describe，§3.2）成功 → 使用 P
  TCP 通但 host.describe 失败 → 端口被无关服务占用（协议不匹配）→ 杀子进程，
    按 P+1 重试（至多 N 次，如 5 次——MAX_SPAWN_ATTEMPTS）→ 全部失败 → 显式报错（含启动输出）
  spawn 立即退出 / 启动超时 → 启动失败（fail-loud，附诊断）
每次重试必须同时更新 --port 与 --trusted-host（两者恒一致：127.0.0.1:<P>）
```

- 与 v2 的"port 0 随机 + stdout 读端口"相比，固定端口的代价是占用冲突，
  收益是确定性（`dshPort` 进 catalog、systemd/防火墙/隧道无需动态发现）。
- **TOCTOU 说明**：spawn 前不做 `net.listen(0)` 预占（释放到绑定之间仍有
  竞态）；冲突一律以"就绪探测失败 → P+1"的后验方式处理，语义确定。
- 就绪判定里"TCP 通但 describe 失败"正是端口被占的判据（§3.2）。

### 2.3 孤儿回收直接移植参考实现安全模型

参考实现 `managed-process-registry.js` 的安全模型（记录在案 → 重验身份 →
仅 owner 死亡才杀）原样移植，差异点：

| 参考实现（被管 agent） | 本设计（dsh web profile 宿主） |
|---|---|
| 命令行含 `--port N`，可直接查命令串 | 命令行含 `--profile web --port N`，端口匹配可查命令串 + `lsof -i :port` 监听者 pid |
| 注册表 `<参考实现状态目录>/managed-agent/<pid>.json` | `<stateDir>/managed-dsh/<pid>.json`（缺省 `~/.dsh-chamber`，`$DSH_CHAMBER_STATE` 覆写，§3.3） |
| 记录 `{pid, ownerPid, port, binary, runtime, startedAt}` | 记录 `{pid, ownerPid, ownerInstanceId, port, binary, profile, source, startedAt}`（profile 固定 `'web'`，§3.3） |

每进程一个 JSON 文件（按 pid 命名，每个实例只写/删自己的文件，零写竞争），
理由直接继承 v2。

### 2.4 健康监控共享失败计数，避免"重连风暴"误触发重启

沿用 v2（移植参考实现 `lifecycle.js`）：

1. **共享一个失败计数**：周期探活与传输触发走同一个 `runHealthCheckCycle`；
2. **计频节流**：同一失败窗口（15s）内至多计 1 次；探测结果 750ms 缓存 +
   单飞行合并——突发失败只算一次；
3. **进程死亡分支**：子进程已退出时不计数、直接重启；
4. **任何一次成功即清零计数**。

**不保留**"忙会话宽限"——控制面不再消费会话帧（协议细节以
dsh 自身 wire / vendor 源码为权威），
探活载荷只有 `host.describe`，健康判定与宿主业务负载解耦；宿主因模型调用
繁忙导致的慢响应由请求侧超时面处理，控制面只判定进程级健康。

### 2.5 instance-id 仲裁（多控制面实例并存）

- 控制面首次运行在状态目录生成 `instance-id`（UUID）并持久化；所有 pid
  记录携带 `ownerInstanceId`——多实例并存时的可读诊断基础。
- **各自 spawn 互不干扰**：每个实例从自己的起始端口（缺省同一起始端口，
  可配置偏移）拉起 → 固定端口 + P+1 重试天然错开；记录文件按 pid 隔离。
- **reaper 不杀活人**：owner 仍存活（`process.kill(pid, 0)` 成功）的条目
  永不回收——两个实例同时跑 reaper 也安全。
- **同端口仲裁**：同一起始端口时，先成功就绪者占住端口；后来者探测到
  `dshPort` 已属于另一活着的托管记录 → 按 P+1 继续重试或报告冲突，**不杀
  进程**（先注册先托管）。

### 2.6 两个 chamber host 包的 seed 与单一 loader overlay（设计 08/09）

官方 web profile 仍是宿主组装权威；chamber 只追加两个自身拥有、边界明确的
host package：

| loader id | package | 实例内职责 |
|---|---|---|
| `client-graph` | `@dsh-chamber/dsh-host-client-graph` | 只读暴露该实例的 client module boot graph |
| `git-worktree` | `@dsh-chamber/dsh-host-git-worktree` | 在该实例进程/用户/文件系统内执行受限 Git worktree 领域操作（设计 08） |

本地托管实例的接线如下：

1. `createControlPlane` 分别接收 `hostGraphPackageSourceDir` 与
   `hostGitWorktreePackageSourceDir`；只有该源的 `dist/index.js` 实际存在时，
   才把 `package.json + dist/index.js` 以内容 hash 幂等复制到
   `<DSH_HOME>/profiles/web/node_modules/@dsh-chamber/<package>/`。
2. 控制面只生成**一个** `<stateDir>/dsh-chamber-graph.patch.yml`。其 `insert`
   列表只含本次确有构建产物的 package row：两包俱全则两行，只构建一包则
   只有对应一行；两包都缺时不传 `--patch`，保持原生 web profile 基线。
3. 复制在 overlay 写入之前完成；已声明构建产物却缺少另一必需文件属于打包
   损坏，启动 fail-loud。文件与 overlay 都原子写入并保持 0600。
4. seed thunk 在**每次 spawn（含自动重启）之前**重新求值。`dsh plugin`
   导致 pnpm 重链并裁掉 extraneous host 包后，下一次 spawn 会自动补回；overlay
   也按当时实际可用产物重建，不留下悬空 row。用户触发的「重启 dsh」动作
   （design 18 §3.6 项 8，刷新插件挂载）走同一条 spawn 路径：seed 重求值与
   overlay 重建语义一致，插件挂载在每次 dsh 进程 boot 时重新确定——不是
   Electron 会话级事实，重启 dsh 即刷新，无需重启壳。

这不是旧 slim profile/业务 patch stack 的回归：控制面不知道 `clientGraph`
或 `gitWorktree` 的领域结果，只做受控文件分发与 loader 挂载。

---

## 3. 详细设计

### 3.1 spawn（detached）与启动命令

```
dsh --profile web [--patch <stateDir>/dsh-chamber-graph.patch.yml] \
  --host 127.0.0.1 --port <P> --trusted-host 127.0.0.1:<P>
```

`--patch` 仅在 §2.6 至少一个 host 包产物可用时出现，并位于 web flags 之前；
它只携带 chamber-owned host rows，不改变官方 web profile 的其它组合层。

- `spawn(..., { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env })`
  （Unix）——独立进程组，宿主可活过父进程崩溃；Windows 退化见 §5。
- **node 可执行解析**（`resolveNodeExecutable`，spawn-dsh.ts）：控制面可能
  运行在纯 node（standalone serve / 测试）或 Electron 主进程内（desktop），
  而 GUI（Finder）启动的打包 App PATH 极简（`/usr/bin:/bin:/usr/sbin:/sbin`），
  `spawn('node', …)` 必挂 ENOENT。解析序：
  - 纯 node → `process.execPath`（就是运行中的 node）；
  - Electron → `process.execPath` + `ELECTRON_RUN_AS_NODE=1`（Electron 官方
    生产机制：应用二进制以纯 node 模式运行；依赖 `runAsNode` fuse，electron-
    builder 默认开启——**不得关闭该 fuse**，否则宿主拉不起来），并前置
    `--expose-internals`：dsh 的 cordis loader 经 `node-addon-require-builtin`
    取 `internal/modules/esm/loader`，该 addon 的 V8 embedder 探测在 Electron
    的 patched Node 下不可用（"no compatible GetAlignedPointerFromEmbedderData
    symbol"），而 `--expose-internals` 的官方 require 路径可用；
  - 兜底 → PATH 搜索 `node` → 常见安装位置（homebrew、`/usr/local/bin`、
    nvm/volta/fnm）→ 最终退回裸名 `node`（保留历史行为，仅作诊断兜底）。
- **cwd 决策**：以 `dshWorkspacePath`（= 桌面打包态 `vendor/dsh` 或开发态
  `ref-dsh` 检出根）为 cwd spawn——spawn 的 dsh 以该工作根解析自身入口；
  会话级工作区由前端 runtime 决定，与宿主 cwd 解耦。
- **环境固定**（确定性 + 隐私）：`DSH_TELEMETRY_DISABLED=1`（任意非空值
  即禁用）；`DSH_PERMISSION_MODE=workspace-write`（显式固定默认）；
  `SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0`（目录选择交互 pin：宿主
  directory-picker-auto 在 SSH 启动标记下解析 `browse`，托管宿主恒以
  应用内目录对话框服务，绝不弹 OS 选择器——05 §4；dsh 源码中仅
  directory-picker-auto 读取该变量，已核实无其他影响）；其余
  继承控制面环境；`DSH_HOME` **显式 pin 到 `<stateDir>/dsh-home`**
  （覆盖环境继承——控制面私有宿主 home，与系统用户 `~/.dsh` 不共享；
  首启缺省与 seedDshHomeDefaults 见下）；Electron 分支额外注入
  `ELECTRON_RUN_AS_NODE=1`。
- **首启默认（seedDshHomeDefaults，index.ts）**：首次 start() 在
  `<stateDir>/dsh-home` 不存在 `settings.yaml` 时写入
  `locale.preference: zh`（0600）——本地实例 dsh UI 默认中文，不再跟随
  浏览器/系统语言；仅缺文件时写，用户显式选择（settings 页或手改文件）
  永不被覆盖。
- **日志**：stdout/stderr 管道接入控制面 host-logs 滚动日志（§3.8），同时
  是启动诊断与就绪失败的证据（host-logs 登记 spawn 诊断字段：binary、args、
  cwd、env 键数、PATH 项数——设计文档曾称 `lastSpawnDiagnostics` 结构，
  spawn-dsh 现以注册表字段形式承载，非独立结构化对象）。

### 3.2 就绪探测与端口占用判定（TCP + host.describe）

```
starting ──① TCP connect 127.0.0.1:P（250ms 间隔轮询，总窗口 90s = LISTEN_WAIT_MS）
              └─ 失败/超时 → 若子进程已退出：启动失败；否则继续轮询
          ──② host.describe unary（每轮 500ms 超时，90s 窗口内无限重试）→ 成功 = ready
              └─ 失败（非 JSON / 非 200 / 契约不匹配）→ 重试
                 —— TCP 通但 describe 失败 = 端口被无关服务占用（协议不匹配），
                    杀子进程 → 按 §2.2 以 P+1 重试
ready
```

- 就绪成功：`dshPort = P` 写入进程记录，并投影到 catalog 连接行
  （status `ready`，03 §2.1）。
- 就绪失败（超时 / 进程退出 / 重试耗尽）：显式启动失败，附完整启动输出与
  `--dump-config` 建议（`dsh --profile web --dump-config` 检查组合树）。
- `host.describe` 响应（version / cwd / attachedSessions …）仅用于就绪与
  健康探活，不作任何会话级消费（协议细节以 dsh wire / vendor 源码为权威）；
  控制面 unary fetch carrier 对单个 JSON 响应实施 1 MiB 流式字节上限，声明
  长度与实际流均受约束，异常宿主不能借探活把响应无界缓冲进控制面。

### 3.3 进程记录文件（managed-dsh/<pid>.json）

目录：`<stateDir>/managed-dsh/`（缺省 `~/.dsh-chamber`，`$DSH_CHAMBER_STATE`
可覆写；04 §6）。

```json
{
  "pid": 31415,
  "ownerPid": 27182,
  "ownerInstanceId": "3f2b…-uuid",
  "port": 17510,
  "binary": "/opt/deepseek/node_modules/@deepseek-ai/dsh/lib/bin.js",
  "profile": "web",
  "source": "spawn",
  "startedAt": "2026-08-14T07:00:00.000Z"
}
```

- 写文件：`writeFileSync(tmp-<pid>) + renameSync` 原子替换；**写入失败时
  （2026 audit H3）**清理已 spawn 的子进程（`killFailedSpawn`：进程组
  SIGKILL → 确认退出 → 删记录）并使本次 spawn 尝试失败——绝不遗留无记录可
  追踪的 detached 进程；
- 读取：跳过非 `.json`；解析失败或 `pid` 非整数 → 删文件（损坏即丢，不猜测）；
- 注销：`removePidRecord(pid)` 只在**确认进程已退出**后调用（存活幸存者留在
  注册表等下次 reaper）。

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
      保留不杀**——无法证明归属就不动；Windows：tasklist 镜像名匹配，见 §5）
      —— 防 pid 复用：回收的 pid 指向无关进程（哪怕它恰巧也是 dsh）时放行
   d. a/b/c 任一不成立 → 不杀，保留文件；诊断只记 pid/判定，不回显被复用
      pid 的完整命令行（它可能属于无关进程并携带凭据）
5. 孤儿判定：ppid == 1（被 reparent 到 init）或 ownerPid 已死
   —— 不成立（owner 仍活）→ 不杀，保留文件【多实例安全】
6. 杀：进程组 SIGTERM → 轮询 1.5s → SIGKILL（killOrphan 序列）；删文件
```

**安全总结**：杀掉一个进程需要同时满足"本产品记录过 + 身份重验通过
（binary/profile 命令串 + 端口监听者 pid）+ owner 死亡/reparent"，三者缺一
不动手。

### 3.5 健康监控：七态状态机

```
stopped ──spawn──► starting ──ready(§3.2)──► ready ──fail(1..N-1)──► degraded
   ▲                    │                        │  │                    │success
   │                    └─失败/退出──────────────┼──┼───────────────────► ready
   │                                            │  └──fail(N)┐
   │                                            └─────restarting──────┐
   └──── graceful stop ────────────────────────────────────────────────┘
                                  └─ kill → 端口释放 → respawn → ready（spawnDsh 内建 TCP+describe 就绪探测）
   spawn 失败 ──► error（fail-loud）──start() 重试──► starting
```

| 态 | 含义 | 进入 | 离开 |
|---|---|---|---|
| `stopped` | 未运行 | 初始 / 优雅停止完成 | spawn |
| `starting` | 已 spawn，未就绪 | spawn | 就绪 → `ready`；失败/退出 → 重启或 `stopped` |
| `ready` | 可服务 | 就绪探测成功 | 探测失败累积计数 |
| `degraded` | 失败计数 ≥1 且 < 阈值，仍在服务 | 失败 | 任意成功（清零）→ `ready`；阈值 → `restarting` |
| `restarting` | 单飞行重启中 | fail(N) / 进程死亡 | 重启成功 → `starting`；耗尽 → `restart-exhausted` |
| `restart-exhausted` | 停止自动重启，等待人工 | 窗口内重启次数超限 | 人工介入（幂等启动 / 停止） |
| `error` | spawn 启动失败（fail-loud，不静默） | spawn 失败 / 不可恢复 | `start()` 重试 → `starting`；或停止 → `stopped` |

探测（两通道共享一个计数，§2.4）：

| 通道 | 触发 | 实现 |
|---|---|---|
| 周期 | 定时器（缺省 30s，可配） | `host.describe` unary，5s 超时 |
| 传输触发 | （设计预留；反代侧连接异常触发健康检查**未实现**——`InstanceProxyDeps` 无健康回调，当前仅周期通道驱动） | — |

- 单飞行探测：并发触发共享一个 in-flight promise；结果带 750ms 缓存；
- 计频节流：两次计数至少间隔一个窗口 W（独立于探活周期，缺省 15s）；
- 进程死亡分支：探活失败且子进程已退出 → 不计数，立即重启；
- 阈值：N=20（连续计数，可经构造参数覆写）；
- 检出预算：30s 周期 × N=20 ≈ 10min 才累计到挂起判定；child-exit（进程死亡
  分支立即重启）与传输触发（设计预留）提供兜底，探测周期拉长不放大挂起风险；
- 成功 → 清零计数 + 状态回 ready。

### 3.6 重启序列与背压

```
1. 单飞行守卫（currentRestartPromise 去重，并发触发共享同一重启）；
   停止过程（优雅停止进行中）直接返回
2. 终止：进程组 SIGTERM（dsh profile-boot 对 SIGTERM 优雅退出，exit 0）
   → 1s 未退 → SIGKILL；确认退出后才 unregisterManagedProcess
3. 端口释放等待：固定端口场景下新宿主仍用同端口——旧进程死透才能复用
   （实现：无独立等待轮询——spawn 侧端口预检 + P+1 退让覆盖占用窗口，§2.2）
4. respawn（§3.1，同端口 P；若端口仍被占走 §2.2 的 P+1 路径）
   → 新 pid.json → 就绪探测（§3.2）
5. 健康失败计数 N 清零（注意：与 restart 背压窗口 M 不同——design 18
   §9.3(5) 的 M 对每次重启（含成功）计数）；失败 → 指数退避（1s→60s，jitter）
6. 窗口内（10min）重启次数 ≥ M（5）→ restart-exhausted：停止自动重启，
   状态对 surface 暴露（catalog status），等待人工介入（POST /api/connections
   幂等启动或桌面设置页操作）；绝不无限重启循环
7. **迟到的健康判定（2026 audit H2，契约）**：stop()/start() abort 在途健康
   探针（`generationSignal`）并等待其落定；任何在 `stopped`/`error` 态或
   start 在途时到达的失败判定一律惰性（不计数、不触发重启——start 在途时
   重启被抑制，防止双 spawn）；spawn 失败落在 stop() 之后（epoch 已变）也不得
   把 `stopped` 改回 `error`。
8. **手工启动代次（2026-08 merge review）**：候选端口预检和 TCP 就绪轮询的
   每次 loopback connect 均有 1s 上限；预检超时按“端口归属不明/忙”保守跳过，
   不在未知端口上拉 detached host。stop() abort 当前 spawn 代次（端口预检、
   TCP 等待、`host.describe` 就绪等待及最后 browse 能力探测均消费同一取消
   信号、销毁在途 socket 并清理 detached 尝试），等待旧代收尾后释放该代的
   single-flight 槽；迟到结果以
   epoch 判旧，若已产出子进程则
   自行终止，若失败则不得清空新代的 `child/dshPort`。因此
   start→stop→start 会创建全新 spawn，不复用旧 promise，也不被旧代反写。
```

### 3.7 优雅停止

- `DELETE /api/connections/local`（04 §3.2）/ 桌面退出 / systemd stop：
  SIGTERM 进程组 → 1s → SIGKILL；确认退出后注销记录，状态回 `stopped`；
- stop 单飞行：并发或紧邻的停止调用共享同一 promise；已完全静止时为无日志的
  no-op，因此同一代生命周期只落一条 `state=stopped`；
- 停止同时取消在途手工 spawn，等待其 owner 清理后释放 single-flight 槽；任何不响应取消的迟到
  测试 seam/适配器仍由 epoch 守卫隔离，不能复活或覆盖随后启动的新代；
- **崩溃路径**：控制面被 SIGKILL → 宿主成为孤儿 → 下次启动 reaper 回收
  （§3.4）——`detached: true` 保证宿主不连带，孤儿回收保证不泄漏；
- **会话数据不丢**：dsh 侧 JSONL 持久化在 `$DSH_HOME/sessions`，重启后由
  前端 runtime 经会话基线完整恢复（控制面不持有任何会话权威——01 §5 原则 4）。

### 3.8 host-logs 滚动日志

- 宿主 stdout/stderr 行写入控制面**滚动缓冲**（RING_BUFFER，如 500 行 /
  按字节上限），启动诊断字段（binary/args/cwd/env 键数/PATH 项数）随
  注册表进程记录登记（host-logs 以注册表字段承载，见 §3.1 日志条）；
- 写入面按 backing path 共享一条**异步串行 lane**：stdout/stderr 与 lifecycle
  writer 共用队列及 compaction ring，append 与临界 rename 绝不并行；child
  `data` 回调先在 Buffer 层截为最多 64 KiB、添加固定截断摘要，再只解码一次供
  logger/writer 共用；writer 只入队，不执行同步文件 I/O，并在 child `close`
  （stdio 已关闭）后退役。每 host 在途最多 256 条 / 512 KiB，
  达到任一高水位即丢弃**最新**诊断条目（原控制面 logger 已持有该行），绝不
  反向暂停或阻塞宿主 pipe；未跨行数 cap 的批次只 append，跨 cap 的批次直接
  原子替换为尾部 ring（不先 append 再整文件重写）；`flush/close` 可等待调用前
  已接纳条目落定；
- 读取面：`GET /api/host/logs`（04 §3.3，local-only）——桌面
  chamber-settings 插件展示"本地实例日志"；远程实例日志经
  `desktop_ssh_logs` IPC（03 §2.2）；
- 写入或压缩失败会丢弃失败批次及其后已排队诊断并切换到新的日志代次
  （清空旧内存 ring/计数并重新 setup）；只有失败后到达的**新写入**发起一次
  新 setup，永久磁盘故障不会形成无限重试队列；
  旧 backing file 被删除后绝不由临界压缩把历史 ring 复活，失败写也不在下次
  重建时重复；
- 纪律：日志永不含凭据/令牌（05 §8 安全不变量）。

### 3.9 systemd 单元（远程实例部署参考）

远程服务器的 dsh 实例以 systemd 单元持久化（loopback 固定端口；无需 web
前端——UI 由本地复用前端经隧道提供）：

```ini
[Unit]
Description=dsh web profile (remote instance)
After=network.target

[Service]
Type=simple
# 专用非 root 服务账号（示例；建号须带家目录，见下方「目录归属」）。
# dsh 默认把 home 放在运行账号自己的 ~/.dsh，无需设置 DSH_HOME。
User=dsh
Group=dsh
# --port 与 --trusted-host 恒一致（127.0.0.1:<P>）：浏览器信任栅栏只认
# chamber 隧道转发来的 Host 头（`dsh web` 是 `--profile web` 的硬别名）。
# 将 <DSH_PATH> 换成远程机上 `which dsh` 的路径 —— npm 全局
# 安装在用户 npm prefix 下（如 /usr/local/bin/dsh），不是 /usr/bin。
ExecStart=<DSH_PATH> --profile web --host 127.0.0.1 --port 30800 --trusted-host 127.0.0.1:30800
Restart=on-failure
RestartSec=3
# dsh 是 node 脚本（shebang `#!/usr/bin/env node`），systemd 默认 PATH 不含
# nvm 的 node → 服务 status=127 崩溃重启（"/usr/bin/env: 'node': No such
# file or directory"）。将 <NODE_BIN> 换成 `which node` 的目录。注意
# Environment= 是整行字面赋值（无追加语法），ExecStart 无变量展开——写全路径。
Environment=PATH=<NODE_BIN>:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=DSH_TELEMETRY_DISABLED=1
Environment=DSH_PERMISSION_MODE=workspace-write
# 目录选择交互 pin（与本地 spawn 同款，05 §4）：directory-picker-auto 在
# SSH 启动标记下解析 browse——远程实例恒以应用内目录对话框服务。不带此
# 行的远程 darwin/win32 或有显示会话的 linux 宿主会解析 native，此时
# host.listDirectory 返回 directory-picker/unavailable、新建工作区对话框
# 不可用（headless linux 服务器无显示会话，缺行也天然 browse）。
Environment=SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

目录归属与无 root 形态（2026-08 重审，与 README「服务器端部署」一致）：

- **归属不变量**：dsh 默认把 home 放在运行账号自己的家目录（`~/.dsh`，
  即 `${DSH_HOME:-$HOME/.dsh}`）——**无需设置 `DSH_HOME`**，也不再有
  `/var/lib` 路径与 root 属主问题。单元运行账号（示例 `dsh`）只需有真实
  家目录：建号用 `sudo useradd --system --create-home dsh`
  （`useradd --system` 默认**不创建**家目录，必须加 `--create-home`）。
  以 root 运行则写到 `/root/.dsh`（归 root，不推荐）。
- **无 root 形态**：服务器无 root 时改用 systemd 用户单元
  （`~/.config/systemd/user/dsh.service` + `systemctl --user` 管理，
  `loginctl enable-linger` 一次性启用保证开机自启与登出存活）。注意
  ssh-provider 的 systemd exec 恒为系统管理器（无 `--user`），用户单元
  对 chamber 桌面起停按钮不可见——实例靠 linger 常驻、隧道照常，管理走
  服务器端 `systemctl --user`。

编排语义：

- **起停/状态**：经桌面 transport-manager（ssh provider）的 systemd exec IPC
  （`desktop_ssh_start_service/stop_service/is_active`，serviceName 白名单
  `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`，首字符必须为字母或数字）驱动（03 §2.2）；
  provider 固定以参数数组执行 `systemctl <action> -- <serviceName>`，`--` 明确终止
  option 解析——控制面不直连远程进程，只经隧道消费其 API 面；
- **停止**：`systemctl stop` → SIGTERM → dsh profile-boot 优雅退出（exit 0）；
- **崩溃**：`Restart=on-failure` + `RestartSec=3` 拉起；用户侧单元示例与
  README「服务器端部署」一节一致。常见崩溃原因：systemd 默认 PATH 不含 nvm
  node → `status=127`（`/usr/bin/env: 'node': No such file or directory`），
  须显式 `Environment=PATH=<node-bin-dir>:/usr/local/sbin:...`（整行字面赋值，
  无追加语法、无变量展开）；
- **绑定面**：恒 `--host 127.0.0.1`（loopback）——chamber 隧道是唯一入口，
  不额外暴露面；绕过隧道直连（0.0.0.0）须配套鉴权（v1 实例匿名）或反代前置
  （dsh 目标匿名 loopback 直连须反代/TLS 前置；gateway 目标自带认证边界与
  公网请求策略，17 §5.1/§6）。
- **远端 chamber host 包**：SSH transport 进入 `ready` 后，桌面主进程调用
  `seedRemoteChamberHostPackages`，把本次实际已构建的 host-graph + Git worktree
  两包写到 `<remoteDshHome>/profiles/node_modules/@dsh-chamber/<package>/`，并对
  `<remoteDshHome>/profiles/web/cordis.patch.yml` 做一次合并写。它复用受限
  `cat/write-file` 通道，仅做分发，**不经 SSH 执行 Git**；已运行的远端 dsh
  需重启后才加载新 row，完整原子顺序、去重与失败语义见设计 13 §3。

**gateway 目标单元形态（design 17，2026-09 v2）**：远程 gateway 部署以
`dsh-chamber-gateway.service` 单元持久化（`install-gateway.sh` 一键安装器
生成，17 §5），默认监听远端 30801（gateway 目标 `remotePort` 缺省；dsh 目标
30800 不变，17 §2.2）：`ExecStart=<GATEWAY_BIN> serve --host 127.0.0.1
--port 30801 …`，服务账号 / `NoNewPrivileges` / `PrivateTmp` / PATH 环境
要求同本单元；凭据经 owner-only systemd `EnvironmentFile` 注入（17 §5）。
ssh transport 的 systemd exec 起停目标按 `serviceName` 在该单元与
`dsh.service` 间选择（03 §2.2 schema v2 注）。

**http 直连形态（transport=http）**：无隧道子进程、无 systemd exec——桌面
直接以 http(s) 访问目标端点。dsh 目标需**用户自建穿透**（TLS 反代 /
tailscale / SSH 隧道 / frp，17 §1.1）把 loopback 实例暴露为可直连端点；
gateway 目标即其入口本身（自带认证边界，17 §5.1/§6）。该形态下 systemd
单元只作服务器侧部署参考，桌面侧不再编排远端服务起停（`serviceName`
留空，03 §2.2）。

---

## 4. 复用映射表

| 控制面需要的功能 | 复用来源（dsh / 参考实现） | 控制面做的编排 |
|---|---|---|
| web profile 装配（webserver + `/api` 桥 + 前端 + 信任栅栏） | dsh `apps/cli`（`--profile web`、`--host/--port/--trusted-host`） | 拼命令行 + spawn；`--trusted-host 127.0.0.1:<port>` |
| `/api` 浏览器信任栅栏 | dsh connection（loopback / trustedHosts） | 反代源 127.0.0.1 loopback 直连（03 §3） |
| `host.describe` 协议握手 | dsh apiproxy 契约（zod schema 可 import） | 就绪探测第二段 + 健康探活（§3.2/§3.5） |
| 孤儿回收安全模型 | 参考实现 `managed-process-registry.js`（记录在案 → 重验 → owner 死才杀） | 移植 + 改造：命令串含 `--profile web`、lsof 端口归属校验（§3.4） |
| 健康监控 / 重启 / 背压 | 参考实现 `lifecycle.js`（共享失败计数、节流、单飞行重启、端口释放） | 探活载荷换 `host.describe`；删"忙会话宽限"（§2.4/§3.5） |
| 优雅退出 | dsh profile-boot（SIGTERM dispose） | SIGTERM 进程组 → SIGKILL 兜底（§3.7） |
| chamber host 包附着 | `@dsh-chamber/dsh-host-client-graph` + `@dsh-chamber/dsh-host-git-worktree` | 按构建产物 seed + 单一 loader overlay；只分发，不消费 graph/Git 业务（§2.6） |

---

## 5. 边界与未决问题

> 各条目以 5.x 编号供外部引用（STATUS「设计未决」按此引用）。

### 5.1 Windows 路径退化

`detached` 语义、进程组信号、`lsof` 均不可用——
Windows 上退化为：reaper 仅"owner 死亡 + tasklist 镜像名"判定、终止走
`taskkill /T` 序列。是否支持 Windows 首版存疑，先以 Unix 为契约目标。

### 5.2 起始端口选择

本地默认起始端口（17510）与控制面端口（17500）相邻；
是否可配 / 每实例偏移未定——先以"固定起始端口 + P+1 重试 + 记录仲裁"落地。

### 5.3 trusted-host 与反代 Host 头

`--trusted-host 127.0.0.1:<port>` 对应
反代转发时的 Host 头（转发保持实例自身 host:port，不改写）；若未来引入
自定义 Host 场景需同步扩展 trusted-host 集（05 §7.5 固定形态）。

### 5.4 restart-exhausted 后的恢复策略

重试入口与计数重置见 §3.6（连接 API
幂等启动或桌面设置页操作；一次成功就绪即清零）。

### 5.5 host-logs 容量

RING_BUFFER 行数/字节上限取桌面场景经验值（如
500 行），滚动丢弃；长期留存/导出不在范围。

### 5.6 `$DSH_HOME` 与多用户冲突

宿主 `DSH_HOME` 固定为
`<stateDir>/dsh-home`（§3.1），多控制面实例共享同一 stateDir 时才
共享该 home——会话 JSONL 追加式多写安全，settings 为 last-writer-wins
文档由 dsh `settings-conflict` 仲裁；不同 stateDir 的实例互不相干。
**服务器远程形态（§3.9）不再设置独立 `DSH_HOME`**（2026-08 重审）：
远程实例以单元运行账号的身份直启 dsh，home 即该账号自己的 `~/.dsh`——
dsh 本就是「一账号一 home、多 profile 共存」的模型
（`$DSH_HOME/profiles/<name>`），web profile 与同账号其他 profile
共享 home 是上游支持的常态（settings 仲裁同前）。独立 home 的诉求
只存在于控制面托管宿主（stateDir 生命周期/可移植性，§3.1），不适用于
systemd 直启形态；若确有「同账号多 profile 必须互不共享配置」的罕见
诉求，仍可显式 `Environment=DSH_HOME=...` 隔离。
