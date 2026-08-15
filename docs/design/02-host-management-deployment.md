# 02 · 宿主管理（web profile）：本地 dsh 宿主进程的托管与部署形态

> 本地 dsh 宿主进程的托管与部署形态（v1 定稿，2026-08-14）：
>
> - **profile 改用 dsh 内置 web profile**：`dsh --profile web --host 127.0.0.1
>   --port <port> --trusted-host 127.0.0.1:<port>`——不再生成 profile 目录 /
>   patch 层 / glue 插件，端口不再随机分配，改为固定端口 + 占用重试（port+1）。
> - **保留沿用**：spawn 生命周期、端口占用重试、pid 记录
>   （ownerPid/ownerInstanceId/port/binary/profile/source/startedAt）、
>   instance-id 仲裁、readiness（TCP + `host.describe`）、健康七态状态机、
>   reaper、host-logs 滚动日志、systemd 单元（部署形态，远程实例参考）、优雅停止。
> - **删除**：slim profile 生成与维护、glue 插件、补丁层 HMR 分类与
>   `POST /api/config/reload`、external 接管 / claim、部署五形态（收为
>   桌面一体一形态）、README 快速连接承诺。
>
> 权威契约：`05-connection-manager.md`（架构 / PlaneHandle）；管理面端点见
> `04-control-plane-api-data.md`；连接模型见 `03-connections-proxy.md`。

---

## 1. 目标与范围

### 1.1 目标

1. 控制面在同机以 **dsh 内置 web profile** 拉起本地宿主（`--profile web
   --host 127.0.0.1 --port <port> --trusted-host 127.0.0.1:<port>`），该实例
   即连接模型的 `local` 连接（connectionId `'local'`，03 §2.1）；
2. 宿主进程生命周期完全由控制面管辖：spawn（detached）→ 就绪探测 → 健康
   监控 → 失败重启（带背压）→ 优雅关闭；控制面崩溃后遗留的孤儿宿主可被
   安全回收；
3. 宿主侧配置/设置变更由 dsh 原生机制自行处理（web profile 自带配置平面），
   控制面不介入（§1.3 边界）；
4. 明确部署形态（桌面一体）与 systemd 单元（远程实例的部署参考形态）。

### 1.2 范围

- **in**：local 实例的托管（spawn / 就绪 / 健康 / 重启 / 回收 / 仲裁）、
  pid 记录、host-logs 滚动日志、systemd 单元、优雅停止。
- **out**：会话/目标/终端等宿主能力（宿主原生，前端经每实例反代消费，
  03 §3）；dsh 连接协议（wire 以 vendor dsh-host-apiproxy 为权威，控制面仅用
  describe/健康探活面）；认证/审计
  （随 v1 收敛整体移除）；远程实例的隧道与 systemd 编排（03 §2.2：桌面
  主进程 transport-manager（ssh provider）+ 注册表）。

### 1.3 原则

- **复用而非重造**：web profile 是 dsh 官方装配（base + web-app），控制面
  零代码复用其 webserver、`/api` 桥与浏览器信任栅栏；控制面只编排：解析
  binary、spawn、读输出、端口重试、探活、计数、重启、回收。
- **只杀自管进程**：reaper 的三重校验（记录在案 / 身份重验 / owner 已死）
  是安全底线。
- **诚实失败**：端口占用、启动超时、探测失败一律显式报错（fail-loud），
  绝不静默降级。

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
（本地默认如 17501；`POST /api/connections` 幂等启动可显式指定）后：

```
尝试端口 P：
  spawn 后就绪探测（TCP + host.describe，§3.2）成功 → 使用 P
  TCP 通但 host.describe 失败 → 端口被无关服务占用（协议不匹配）→ 杀子进程，
    按 P+1 重试（至多 N 次，如 10 次）→ 全部失败 → 显式报错（含启动输出）
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
| 注册表 `<参考实现状态目录>/managed-agent/<pid>.json` | `$XDG_STATE_HOME/dsh-chamber/managed-dsh/<pid>.json` |
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

---

## 3. 详细设计

### 3.1 spawn（detached）与启动命令

```
dsh --profile web --host 127.0.0.1 --port <P> --trusted-host 127.0.0.1:<P>
```

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
- **cwd 决策**：以配置的默认工作根（缺省 `$HOME`）为 cwd spawn——模型侧
  文件面落在可预期位置；会话级工作区由前端 runtime 决定，与宿主 cwd 解耦。
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
  是启动诊断与就绪失败的证据（`lastSpawnDiagnostics` 式结构：binary、args、
  cwd、env 键数、PATH 项数）。

### 3.2 就绪探测与端口占用判定（TCP + host.describe）

```
starting ──① TCP connect 127.0.0.1:P（300ms 间隔轮询，15s 超时）
              └─ 失败/超时 → 若子进程已退出：启动失败；否则继续轮询
          ──② host.describe unary（5s 超时）→ 成功 = ready
              └─ 失败（非 JSON / 非 200 / 契约不匹配）→ 重试（400ms 间隔，≤2 次）
                 —— TCP 通但 describe 失败 = 端口被无关服务占用（协议不匹配），
                    杀子进程 → 按 §2.2 以 P+1 重试
ready
```

- 就绪成功：`dshPort = P` 写入进程记录，并投影到 catalog 连接行
  （status `ready`，03 §2.1）。
- 就绪失败（超时 / 进程退出 / 重试耗尽）：显式启动失败，附完整启动输出与
  `--dump-config` 建议（`dsh --profile web --dump-config` 检查组合树）。
- `host.describe` 响应（version / cwd / attachedSessions …）仅用于就绪与
  健康探活，不作任何会话级消费（协议细节以 dsh wire / vendor 源码为权威）。

### 3.3 进程记录文件（managed-dsh/<pid>.json）

目录：`$XDG_STATE_HOME/dsh-chamber/managed-dsh/`（`XDG_STATE_HOME` 缺省
`~/.local/state`；测试/部署可用环境变量覆写）。

```json
{
  "pid": 31415,
  "ownerPid": 27182,
  "ownerInstanceId": "3f2b…-uuid",
  "port": 17501,
  "binary": "/opt/deepseek/dsh/bin/dsh",
  "profile": "web",
  "source": "spawn",
  "startedAt": "2026-08-14T07:00:00.000Z"
}
```

- 写文件：`writeFileSync(tmp-<pid>) + renameSync` 原子替换；**best-effort**
  ——注册失败绝不阻断 spawn/关闭；
- 读取：跳过非 `.json`；解析失败或 `pid` 非整数 → 删文件（损坏即丢，不猜测）；
- 注销：`unregisterManagedProcess(pid)` 只在**确认进程已退出**后调用（存活
  幸存者留在注册表等下次 reaper）。

### 3.4 reaper（孤儿回收）

启动时（spawn 前）对每个条目执行：

```
1. 仅处理本目录记录 —— 用户的 dsh 实例从未入册，永不是候选
2. 条目解析失败 / pid 非整数 → 删文件
3. pid 已死（kill(pid,0) 失败且非 EPERM）→ 删文件，无事可做
4. 身份重验（Unix：ps -p <pid> -o ppid=,command=）：
   a. 命令串包含 binary 的 basename（'dsh'）且含 '--profile web'
      （固定 profile 形态，可直接命令串匹配）
   b. 端口归属：记录的 port 存在时，lsof -i :port -sTCP:LISTEN 的 pid == 记录 pid
      —— 防 pid 复用：回收的 pid 指向无关进程（哪怕它恰巧也是 dsh）时放行
      （lsof 不可用 → 退化为仅 a；Windows：tasklist 镜像名匹配，见 §5）
   c. a/b 任一不成立 → 不杀，保留文件
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
   └──── graceful stop / 不可恢复 ─────────────────────────────────────┘
                                  └─ kill → 端口释放 → respawn → starting
```

| 态 | 含义 | 进入 | 离开 |
|---|---|---|---|
| `stopped` | 未运行 | 初始 / 优雅停止完成 | spawn |
| `starting` | 已 spawn，未就绪 | spawn | 就绪 → `ready`；失败/退出 → 重启或 `stopped` |
| `ready` | 可服务 | 就绪探测成功 | 探测失败累积计数 |
| `degraded` | 失败计数 ≥1 且 < 阈值，仍在服务 | 失败 | 任意成功（清零）→ `ready`；阈值 → `restarting` |
| `restarting` | 单飞行重启中 | fail(N) / 进程死亡 | 重启成功 → `starting`；耗尽 → `restart-exhausted` |
| `restart-exhausted` | 停止自动重启，等待人工 | 窗口内重启次数超限 | 人工介入（幂等启动 / 停止） |
| `shutting-down` | 优雅停止中 | 停止命令 | 进程确认退出 → `stopped` |

探测（两通道共享一个计数，§2.4）：

| 通道 | 触发 | 实现 |
|---|---|---|
| 周期 | 定时器（缺省 10s，可配） | `host.describe` unary，5s 超时 |
| 传输触发 | 反代侧连接异常（WS 握手失败、连续 5xx） | 同一 `runHealthCheckCycle('transport')` |

- 单飞行探测：并发触发共享一个 in-flight promise；结果带 750ms 缓存；
- 计频节流：两次计数至少间隔一个窗口 W（= 周期间隔，缺省 15s）；
- 进程死亡分支：探活失败且子进程已退出 → 不计数，立即重启；
- 阈值：N=20（连续计数，可环境变量覆写）；
- 成功 → 清零计数 + 状态回 ready。

### 3.6 重启序列与背压

```
1. 单飞行守卫（currentRestartPromise 去重，并发触发共享同一重启）；
   shutting-down 直接返回
2. 终止：进程组 SIGTERM（dsh profile-boot 对 SIGTERM 优雅退出，exit 0）
   → 2.5s 未退 → SIGKILL；确认退出后才 unregisterManagedProcess
3. 端口释放等待：固定端口场景下新宿主仍用同端口——旧进程死透才能复用
   （5s 超时，150ms 轮询）
4. respawn（§3.1，同端口 P；若端口仍被占走 §2.2 的 P+1 路径）
   → 新 pid.json → 就绪探测（§3.2）
5. 计数清零；失败 → 指数退避（1s→60s，jitter）
6. 窗口内（10min）重启次数 ≥ M（5）→ restart-exhausted：停止自动重启，
   状态对 surface 暴露（catalog status），等待人工介入（POST /api/connections
   幂等启动或桌面设置页操作）；绝不无限重启循环
```

### 3.7 优雅停止

- `DELETE /api/connections/local`（04 §3.2）/ 桌面退出 / systemd stop：
  SIGTERM 进程组 → 2.5s → SIGKILL；确认退出后注销记录，状态回 `stopped`；
- **崩溃路径**：控制面被 SIGKILL → 宿主成为孤儿 → 下次启动 reaper 回收
  （§3.4）——`detached: true` 保证宿主不连带，孤儿回收保证不泄漏；
- **会话数据不丢**：dsh 侧 JSONL 持久化在 `$DSH_HOME/sessions`，重启后由
  前端 runtime 经会话基线完整恢复（控制面不持有任何会话权威——01 §6 原则 4）。

### 3.8 host-logs 滚动日志

- 宿主 stdout/stderr 行写入控制面**滚动缓冲**（RING_BUFFER，如 500 行 /
  按字节上限），同时保留 `lastSpawnDiagnostics` 结构（binary/args/cwd/env
  键数/PATH 项数）供启动失败诊断；
- 读取面：`GET /api/host/logs`（04 §3.3，local-only）——桌面
  chamber-settings 插件展示"本地实例日志"；远程实例日志经
  `desktop_ssh_logs` IPC（03 §2.2）；
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
# 专用非 root 服务账号（示例）：
User=dsh
Group=dsh
# --port 与 --trusted-host 恒一致（127.0.0.1:<P>）：浏览器信任栅栏只认
# chamber 隧道转发来的 Host 头（`dsh web` 是 `--profile web` 的硬别名）。
# 将 <DSH_PATH> 换成远程机上 `which dsh` 的路径 —— npm 全局
# 安装在用户 npm prefix 下（如 /usr/local/bin/dsh），不是 /usr/bin。
ExecStart=<DSH_PATH> --profile web --host 127.0.0.1 --port 3080 --trusted-host 127.0.0.1:3080
Restart=on-failure
RestartSec=3
# dsh 是 node 脚本（shebang `#!/usr/bin/env node`），systemd 默认 PATH 不含
# nvm 的 node → 服务 status=127 崩溃重启（"/usr/bin/env: 'node': No such
# file or directory"）。将 <NODE_BIN> 换成 `which node` 的目录。注意
# Environment= 是整行字面赋值（无追加语法），ExecStart 无变量展开——写全路径。
Environment=PATH=<NODE_BIN>:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# 服务器部署形态建议独立 DSH_HOME（§5.6）：
Environment=DSH_HOME=/var/lib/dsh/dsh-home
Environment=DSH_TELEMETRY_DISABLED=1
Environment=DSH_PERMISSION_MODE=workspace-write
# 目录选择交互 pin（与本地 spawn 同款，05 §4）：directory-picker-auto 在
# SSH 启动标记下解析 browse——远程实例恒以应用内目录对话框服务。不带此
# 行的远程 darwin/win32 或有显示会话的 linux 宿主会解析 native，此时
# host.listDirectory 返回 directory-picker-unavailable、新建工作区对话框
# 不可用（headless linux 服务器无显示会话，缺行也天然 browse）。
Environment=SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

编排语义：

- **起停/状态**：经桌面 transport-manager（ssh provider）的 systemd exec IPC
  （`desktop_ssh_start_service/stop_service/is_active`，serviceName 白名单
  `^[a-zA-Z0-9_.-]+$`）驱动（03 §2.2）——控制面不直连远程进程，只经隧道
  消费其 API 面；
- **停止**：`systemctl stop` → SIGTERM → dsh profile-boot 优雅退出（exit 0）；
- **崩溃**：`Restart=on-failure` + `RestartSec=3` 拉起；用户侧单元示例与
  README「服务器端部署」一节一致。常见崩溃原因：systemd 默认 PATH 不含 nvm
  node → `status=127`（`/usr/bin/env: 'node': No such file or directory`），
  须显式 `Environment=PATH=<node-bin-dir>:/usr/local/sbin:...`（整行字面赋值，
  无追加语法、无变量展开）；
- **绑定面**：恒 `--host 127.0.0.1`（loopback）——chamber 隧道是唯一入口，
  不额外暴露面；绕过隧道直连（0.0.0.0）须配套鉴权（v1 实例匿名）或反代前置。

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

---

## 5. 边界与未决问题

1. **Windows 路径退化**：`detached` 语义、进程组信号、`lsof` 均不可用——
   Windows 上退化为：reaper 仅"owner 死亡 + tasklist 镜像名"判定、终止走
   `taskkill /T` 序列。是否支持 Windows 首版存疑，先以 Unix 为契约目标。
2. **起始端口选择**：本地默认起始端口（17501）与控制面端口（17500）相邻；
   是否可配 / 每实例偏移未定——先以"固定起始端口 + P+1 重试 + 记录仲裁"落地。
3. **trusted-host 与反代 Host 头**：`--trusted-host 127.0.0.1:<port>` 对应
   反代转发时的 Host 头（转发保持实例自身 host:port，不改写）；若未来引入
   自定义 Host 场景需同步扩展 trusted-host 集（05 §7.5 固定形态）。
4. **restart-exhausted 后的恢复策略**：重试入口 = 连接 API（POST
   /api/connections 幂等启动）或桌面设置页操作；自动重启计数由一次成功就绪
   清零（成功即重置）。
5. **host-logs 容量**：RING_BUFFER 行数/字节上限取桌面场景经验值（如
   500 行），滚动丢弃；长期留存/导出不在范围。
6. **`$DSH_HOME` 与多用户冲突**：宿主 `DSH_HOME` 固定为
   `<stateDir>/dsh-home`（§3.2.1），多控制面实例共享同一 stateDir 时才
   共享该 home——会话 JSONL 追加式多写安全，settings 为 last-writer-wins
   文档由 dsh `settings-conflict` 仲裁；不同 stateDir 的实例互不相干；
   服务器远程形态建议独立 `DSH_HOME`（§3.9 的 `Environment=` 行）。
