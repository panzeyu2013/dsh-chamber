# 03 · 连接模型与每实例通用反代（v1 定稿）

> 连接模型与每实例通用反代（v1 定稿，2026-08-14；**连接模型随 design 17
> 升级为 2026-09 v2**）：**连接模型**（本地 =
> 控制面 catalog 单行；远程 = 桌面主进程注册表）+ **每实例通用反代**
> `/api/i/<id>/*`（HTTP/WS/SSE 全量透传）。
> **远程连接模型以 `17-server-side-gateway.md`（2026-09 v2）为权威**：
> 目标类型 kind（dsh|gateway）× 传输方式 transport（ssh|http）× 认证 ×
> 通道四维正交（17 §2）；本文 §2.2 注册表 schema 即 17 §9.1 的 v2 形态。
> 薄壳时代 project 目录 / 适配器 / broker / 绑定 / 会话索引体系随 v2 整体
> 退役（§1.3）。
> 权威契约：`05-connection-manager.md`（架构 / 路径 / PlaneHandle / IPC）；
> 管理面端点与数据文件见 `04-control-plane-api-data.md`；进程托管见
> `02-host-management-deployment.md`。
> **[v1 收敛（2026-08-14）]** 无认证边界：`/api/i/*` 匿名可达（仅 loopback
> 监听），反代不再是认证边界，而是诚实失败面（05 §8 安全不变量）。

---

## 1. 目标与范围

### 1.1 目标

1. 统一的连接模型：本地实例一条 catalog 行；远程实例一条桌面注册表行——
   两种形态边界清晰，控制面 catalog **绝不 seed 远程实例**；
2. 每实例同源反代：`/api/i/<id>/*` 全量透传（HTTP 任意方法 / WS upgrade /
   SSE），前端 N-ctx 访问自己实例的唯一通道（05 §1/§7.1）；
3. 反代是诚实失败面（无隧道 503，fail-loud）——v1 无认证门禁（匿名可达，
   loopback-only）。

### 1.2 范围

- **in**：catalog 单行（local）的 schema 与 CRUD 语义；远程注册表
  （`ssh-instances.json`）schema 与 IPC 契约；每实例反代的路径映射 /
  失败与收敛语义。
- **out**：宿主进程托管（02）；管理 REST 端点全表（04）；认证/审计
  （匿名 loopback 控制面随 v1 收敛整体移除；桌面/gateway 连接的认证、
  凭据与审计见 17 §7/§13.4）；隧道 / systemd 实现（desktop transport-manager
  （ssh provider），本文只定契约边界）。

### 1.3 连接模型边界（旧体系删除项，01 §4/§5）

- 无 project / 绑定 / 适配器 / broker / 会话索引——v2 的 catalog 多行、
  kind 分支、lease 生命周期、session-index 全部退役；会话业务归 dsh 前端
  runtime（N-ctx，每实例一个完整 dsh shell）。
- 远程实例不再经注入适配器 seed 控制面（连接注入适配器 / broker / 绑定 →
  移除，处置映射见 01 §4）。

---

## 2. 连接模型

### 2.1 本地实例：控制面 catalog 单行（connectionId 'local'）

文件：`<stateDir>/catalog.json`（缺省 `~/.dsh-chamber`，`$DSH_CHAMBER_STATE`
可覆写；04 §6）：

```jsonc
{
  "schemaVersion": 2,          // CATALOG_SCHEMA_VERSION
  "revision": 7,               // 每次持久化递增（原子写协议，§2.1 末）
  "connections": [
    {
      "connectionId": "local",
      "kind": "local",
      "label": "Local dsh",
      "accentColor": "#1a1a2e"
    }
  ]
}
```

- **单行固定**：`local` 恒存在（不可删除；DELETE = 停止实例，§2.1.1）；
  无 kind 分支、无 projects 子表——"本地实例"就是唯一一行。
- **status / dshPort / error 只在 wire 投影**：由当前 PlaneHandle 内存状态派生，
  从不写回 catalog；文件只持久化 `label / accentColor`（用户可改项）。legacy 行里的
  运行态字段加载时剥离，避免第二个 control-plane 用 stale lifecycle 覆盖共享元数据
  （01 §5 原则 4：宿主事实只服务、不背书）。
- **原子写**：同步 write-through 事务 + 随机 O_EXCL temp + file/parent fsync + rename；
  普通失败回滚并向调用者抛错；rename 已在线但 parent fsync 报错时以 exact readback
  保留在线 revision、仍向调用者报告 durability unknown。损坏 → 大声失败（绝不冒充
  空行）并从备份恢复（04 §6 同一协议）。
- **跨进程边界**：单个 JsonStore 只串行本进程事务，revision 不是文件系统 CAS。
  共享同一 stateDir 的两个 control-plane 同时修改 label/accentColor 仍是 last-writer-wins；
  高可靠多 writer 需要另行批准 kernel-backed 跨平台锁 + 锁内 reload/字段 intent，不能
  用可陈旧 pidfile/mkdir lock 冒充。

#### 2.1.1 CRUD 语义（管理面端点全表见 04 §3.2）

模型视角：`local` 恒存在、不可删除（`DELETE` = 优雅停止实例，02 §3.7，
行保留）；`POST /api/connections` 仅接受 `kind:'local'`（幂等启动，远程实例
不在此面）；`PATCH` 只改 `label / accentColor`；`status / dshPort` 是运行态
投影。端点、请求/响应与幂等细节以 04 §3.2 为准。

### 2.2 远程实例：桌面主进程注册表（ssh-instances.json，schema v2）

- **位置与所有权**：`<userData>/ssh-instances.json`，由**桌面主进程**
  （main.ts 的 transport-manager + 实例注册表）读写；**不进控制面 catalog**
  （05 §1 架构图）。
- **schema v2**（17 §9.1 同源；05 §7.4 的 IPC spec 同源）：`kind` 是
  **目标类型**（dsh|gateway，17 §2.1），`transport` 独立成维（ssh|http，
  开放联合，provider 按 transport 注册，17 §2.2）：

```jsonc
{
  "id": "dsh-inst-7",            // 反代 id = dsh-<id>（ssh-<id> legacy 映射保留，17 §2.2）
  "kind": "dsh",                 // 目标类型：dsh | gateway（kind 决定目标语义，17 §2.1）
  "transport": "ssh",            // 传输：ssh | http（开放联合，17 §2.2）
  "label": "home-server",
  "host": "192.0.2.10",        // 文档保留网段占位（RFC 5737）
  "user": "root",                // transport=ssh 时必填
  "sshPort": 2222,               // SSH 守护端口（null = ssh 默认 22 / config Port）
  "remotePort": 30800,           // ssh 隧道远端端口 / http 直连端口（02 §3.9 部署参考；
                                 //  dsh 缺省 30800 / gateway 缺省 30801，17 §2.2）
  "serviceName": "dsh-chamber",  // ssh 时：远端 systemd 单元（dsh.service /
                                 //  dsh-chamber-gateway.service；null = 不托管起停）
  "remoteDshHome": null,         // 远端 dsh home（$DSH_HOME），插件同步/seed 的远端路径基准
                                 // （null = ssh 默认 home；白名单见 13 §7.2）
  "insecureHttp": false,         // transport=http：true = http 明文（缺省 false = https，17 §9.1）
  "spkiPin": null                // S23 可选 SPKI pin：hex sha256 of SPKI DER（^[0-9a-fA-F]{64}$）；
                                 //  仅 gateway+https 有效，http 明文拒绝（17 §9.1）
}
```

- **注册表写入原子性**：renderer 提交的是完整候选集；任一条目非法、kind
  不匹配或 id 重复时，主进程在写盘/断连/内存替换前拒绝**整个**候选集，原
  文件、运行中隧道与内存注册表均保持不变。只有启动加载旧文件时采用容错恢复：
  非法/kind 不匹配/重复条目响亮告警后丢弃（重复 id 首胜）。写路径不得复用
  加载路径的“尽量恢复”语义，否则一次非法编辑会把既有主机静默删掉。现行 add/edit
  只走精确单行 `desktop_ssh_save_connection`，bulk `instances_set` 为 exact no-op-only；
  该原则仍约束主进程规范化与 metadata-last 提交。

- **凭据不进注册表**：`sshPasswordSet`/`tokenSet`/`passwordSet` 是主进程凭据存储的实时
  **非秘密投影**（`instances_get` 读时合并，仅供 UI 徽标与编辑页“已设置”提示；
  secret 值绝不回填）；
  凭据 retarget 按域比较而非复用 transport 全字段：gateway auth 绑定
  kind+host+remotePort，SSH password 绑定 host+user+sshPort；元数据与三凭据由
  主进程单次补偿事务保存（17 §9.1）。两类 durable mirror 把 binding 与 secret
  同次原子写，读取/注入时复验当前 registry；因此 secret→registry 两次 fsync 间崩溃
  只会隐藏新值，不会把它发给旧目标。同 id 新增/进入/离开/retarget 留空也会强制
  clear/rebind，防止半事务 secret 复活；非空 legacy 无 binding 文件 fail closed 并保留
  唯一 `.unbound-*` 恢复副本、要求重录。
- **迁移规则（17 §2.2/§9.1）**：旧 `kind:'ssh'` 条目载入时映射为
  `{kind:'dsh', transport:'ssh'}`；旧 `kind:'gateway'` 条目映射为
  `{transport:'http'}`；source id 的 `ssh-` 前缀保留 legacy 兼容映射
  （deep link 可用）。

- **生命周期（transport=ssh）**：SSH 隧道（`ssh -N [-p <sshPort>] -L
  <localPort>:127.0.0.1:<remotePort> <user@host>`，sshPort null 时不传
  `-p`，走 ssh 默认/config）+ systemd exec（`start/stop/is_active`，
  固定 argv `systemctl <action> -- <serviceName>`，serviceName 校验
  `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`、首字符必须为字母或数字；复用 host-logs 的
  RING_BUFFER 日志环与 AUTH_FAILURE_PATTERNS）；**transport=http 无子进程**——直接 http(s) 访问
  目标端点（dsh 目标需用户自建穿透，gateway 目标即其入口，17 §2.2/§9.2）；
  隧道 / 服务 / 直连状态 → **phase** 投影给 renderer
  （idle / connecting / ready / degraded / error）；
  **隧道 URL 与直连端点 URL 永不进 renderer**——renderer 只见
  localPort / phase 投影（05 §7.4；直连端点仅主进程持有，17 §9.3）。
- **连接/exec generation**：`serviceName` 与 `remoteDshHome` 的编辑同时属于 transport
  与 exec identity 变化。主进程先提升 generation/`execEpoch`，撤销旧 live transport、
  重连/探针与全部 exec child（SIGTERM→SIGKILL），再按旧连接是否非 idle 决定以新参数
  重启；多步 exec 每次下一次 spawn 前复验 generation，迟到日志、状态投影、
  `serviceActive` 与结果都不能跨代提交。kind/serviceName 变化还会把旧
  `serviceActive` 复位为未知。
- **IPC 白名单**（renderer ↔ main，preload 限定）：全集见 05 §7.4（2026-08
  已扩展插件编排面 `desktop_ssh_plugin_*`、`restart_service`、
  `seed_host_graph`、`status_changed` 等，不再在此枚举）。要点：
  `desktop_ssh_save_connection` 是 add/edit/非空凭据写的唯一入口；删除只走精确
  id-addressed `desktop_ssh_delete_connection(id)`（不存在 id 为幂等 no-op）；legacy
  `desktop_ssh_instances_set` 只接受与当前规范化 roster 同长度、同顺序、逐字段完全相同
  的 exact no-op，任何删除/add/edit/reorder 都拒绝；三个 legacy 单项 setter
  `desktop_ssh_set_password` / `desktop_gateway_set_token` /
  `desktop_gateway_set_password` 均只接受 clear（主进程内存 + 0600 文件兜底，05 §8 例外）、
  `desktop_ssh_config_list`（`~/.ssh/config` 自动发现，非秘密投影：
  alias/hostName/user/port；SSH config 中的 IdentityFile/ProxyCommand/凭据材料绝不投影
  renderer；连接表单瞬时 write-only 凭据例外仍按上条事务处理）。
- **liveness 纪律**（AGENTS.md 正确性不变量）：隧道 / 服务事实只来自
  "隧道相位 + systemd is-active"的实时判定，从不持久化"已连接"状态。
- **就绪 = 隧道 TCP + dsh 身份握手**：TCP accept 只证明目标端口上有服务
  在听，不证明是 dsh。置 ready 前经 provider `verifyUp`（`host.describe`
  信封探测，与本地实例就绪判据同源，02 §3.2；**按 `spec.kind` 决定是否带
  认证头**——dsh 目标无认证头、gateway 目标可选认证头，探针认证矩阵见
  17 §9.2）验证远端真是目标——目标端口上跑非 dsh 服务时显式报错/降级，
  **绝不呈现已连接**（假连接修复）。**确定性失败免重试**：目标**应答了**
  探测但证明不是（兼容的）目标（HTTP 非 200 / 错误信封 / 版本过老）→
  验证结果带 `terminal` 标记，第一次失败即落 error 终态（重试无法改变
  应答）；仅连接错误/超时等瞬时失败走重连。
- **SPKI pin 的 pre-write 门**：gateway+HTTPS 配置 pin 时，桌面登录/探针与控制面
  HTTP/WS 反代都必须在 TLS `secureConnect` 后先匹配 peer SPKI，匹配前不调用请求
  `write/end`、不发送 HTTP/WS handshake/header/credential/body 等任何应用层字节；
  mismatch 显式失败，目标服务看不到请求。无 pin 的标准 CA 路径不改变。
- **两段式重连（2026-08 修订）**：瞬时失败先走**快速有界突发**（半开
  jitter 指数退避，1s→30s，至多 N=5 次），突发耗尽落 error（诚实红态）
  **但不停摆**——进入**慢速周期重探**（每 ~60s 一次全新隧道尝试，无上限）：
  瞬时故障是**时变**的（网络恢复、远端重启、服务拉起），「放弃」绝不能是
  永久状态，条件修复后无需用户操作自动恢复；error 终态只属于终态失败
  （认证 / spawn / 确定性验证——failTerminal，绝不自动重试）。手动
  connect/disconnect 取消在途慢速重探；成功即 ready 并清零计数。UI 侧
  点击来源（侧边栏激活 / 打开会话）对 error/degraded 来源即时再试一次
  （renderer ensureRemoteConnected），慢速重探是自动兜底。

### 2.3 两形态对照

| 维度 | 本地（local） | 远程（dsh-<id> / gateway-<id>） |
|---|---|---|
| 权威位置 | 控制面 catalog 单行（§2.1） | 桌面主进程注册表（§2.2） |
| 进程所有权 | 控制面 spawn / reaper（02） | 远程 systemd（ssh provider exec）；http 直连无子进程（17 §2.2） |
| 反代目标 | 本机 web profile `127.0.0.1:dshPort` | 隧道 localPort / 直连端点 origin |
| 实例 id（`/api/i/<id>`） | `local` | `dsh-<id>`（ssh-<id> legacy）/ `gateway-<id>`（17 §9.3） |
| 管理面可见性 | `/api/connections`（04 §3.2） | 不可见（renderer 经 IPC 投影） |

---

## 3. 每实例通用反代（/api/i/<id>/*）

### 3.1 挂载与路径映射

- 控制面挂载 `/api/i/<id>` 前缀；`id ∈ {local, dsh-<id>, gateway-<id>}`
  （`ssh-<id>` 为 legacy 兼容段，17 §2.2/§9.1；connectionId 由
  `${kind}:${id}` 派生，17 §9.3）。
- transport 注册在写入路由表前校验完整 origin/协议与目标类型：隧道目标只能是
  无 userinfo/path/query/hash 的 loopback HTTP；gateway 直连可为经边界评估的
  HTTP(S)，HTTPS pin 在任何应用字节写出前验证。未知协议/target kind 必须
  fail-loud，不能先呈现“已注册”再在首请求失败。
- **HTTP 全量透传**：任意方法（**无方法白名单**——05 §1），保持
  method/body/headers；**WS upgrade** 直通（`events.mux` / `events.host`
  双下行流）；**SSE 直通**（`text/event-stream` 响应不缓冲、不逐条解析、
  不重封装）。
- **前缀剥离后转发**：剩余路径锚定到实例的 `/api` 根——实例只认 `/api`
  前缀（dsh connection 的 node half 以 `API_PATH = '/api'` 注册整棵路由树，
  其余路径 webserver 404）。前端连接客户端 base 路径参数化（05 §6，唯一
  dsh 源码修改面）保证其全部 RPC/WS 路径落在该前缀下：

```
POST /api/i/<id>/api/session.list  → 实例 POST /api/session.list
WS   /api/i/<id>/api/events.mux    → 实例 WS  /api/events.mux
WS   /api/i/<id>/api/events.host   → 实例 WS  /api/events.host
```

- 反代不改写上游内容；**认证头按 kind 白名单注入（17 §9.3）**：**dsh 目标
  禁注入**——实例信任栅栏由 loopback + trusted-host 满足（02 §2.1），Host
  头保持实例自身 `127.0.0.1:<port>`（与 `--trusted-host` 一致）；
  **gateway 目标 0..2 个**可注入头（`Authorization` Bearer /
  `Cookie` `dsh_gateway_session`），白名单逐项校验、绝不允许其他头；
  Cookie 按网络 origin + `Host` authority + stable connection-target scope 隔离，
  authority 只负责路由；session generation、current `cookie|bearer` auth proof 与 refresh
  epoch 阻止 invalidate/retarget/delete 后的迟到登录/探针/fallback/刷新注册。密码型
  gateway 若当前 Cookie/proof 消失且无已验证 Bearer fallback，注册 fail closed 重连，
  绝不静默变成 headerless；provider session hooks 必须 all-or-none；
  上游 Host 改写为目标 origin（ssh 隧道 = loopback origin；http 直连 =
  用户配置的 http(s) origin，非 loopback 放行——穿透由用户自建，
  SSRF 面 = 用户配置面，17 §13.4）。

### 3.2 可达性（v1 无认证边界）

- v1 收敛移除登录会话 cookie 门禁：`/api/i/*` 与管理面 `/api/*` 对获准来源
  **匿名可达**。来源门禁（Host 必须为规范 loopback authority、Origin 必须与
  当前 `scheme://Host` 精确同源或命中显式开发 allowlist；其他回环端口与
  `null` 均拒绝；非法来源统一 403 `origin_forbidden`）与暴露面
  不变量（loopback-only 监听）的完整定义见 **04 D2**（管理面 + 反代面统一
  适用；05 §8 安全不变量）。反代面要点：Host 门禁覆盖浏览器同源 DNS
  rebinding 读；静态壳（`/`、dist、`/assets/*`、`/manifest.json`）匿名加载，
  无敏感面。
- 不再有认证/审计中间件（`/api/auth/*`、`/api/audit` 随 v1 收敛整体移除）——
  **该匿名边界只约束普通 loopback 控制面**；gateway 部署的认证边界、
  请求策略与 401/403/421 分类见 17 §6/§7.3。

### 3.3 失败语义（fail-loud）

原则：实例传输失败**绝不伪装成空成功**——无隧道/未就绪 → **503**（code
`instance_unavailable`）；上游连接拒绝/超时 → 502 / 504 显式错误（脱敏，
不泄上游 host:port）；实例 id 未知 → 404。错误码与响应形状的完整表见
**04 §4.2**（本文不再枚举）。

### 3.4 响应收敛与体积上限

- **响应头白名单**（收敛上游头，防 hop-by-hop / 凭据泄露）：完整列表见
  **04 §4.3**（WS upgrade 101 所需头除外）。
- **体积上限**：带可信 `Content-Length` 的请求体 ≤ 300MiB；未知长度/chunked 请求体
  ≤ 32MiB（避免 chunks + concat 的双份峰值）；响应体 ≤ 300MiB（与上游 dsh 0.1.1-rc.2
  的 300MiB 请求体上限 / 200MiB 图片准入对齐：200MiB 图片 base64 膨胀
  ~267.7MiB 后仍留余量；沿用 v2 runtime-proxy 语义；超限 → 413 / 取消上游
  流，显式而非截断静默）；请求体分片空闲超过
  30s → 408 并取消底层请求 iterator，不能用慢速上传长期占用代理槽位。
- **请求头收敛**：剥离 cookie、authorization、proxy authentication、客户端
  `content-length` 与 hop-by-hop framing；代理完成有界缓冲后，仅按实际接收字节
  重建 `content-length`。**压缩协商不跨代理（2026 audit M3b）**：请求侧剥离
  `accept-encoding`（上游恒 identity），响应白名单放行 `content-encoding`
  ——压缩标签必须随行，浏览器才能正确解码；反代不经手压缩字节。
- **进程级资源预算**：并发 HTTP ≤ 64、活动 WS ≤ 64、待完成 WS 握手 ≤ 16、
  所有 proxy owner 共享的进程级缓冲请求体预算 ≤ 300MiB；健康 SSE ≤ 32。超额统一 503
  `resource_exhausted`，计数在断连/超时/错误/完成时幂等释放；HTTP server 在
  路由前另设 10s header、35s request、5s keep-alive 与 192 连接上限。
- 非 SSE 上游响应使用 45s **空闲**超时（每个数据块重新计时；2026-08 由 10s
  调高：chamber Git worktree host 的同步 git mutation 预算 30s，旧 10s 空闲
  计时会在 host 已提交后截断慢速 `git worktree remove` 为 504，见设计 08
  §6 修订与 STATUS），既阻止停滞流，也不误杀持续有进展的大响应；SSE/已
  升级 WS 保持长连接语义。
- **代理 WS 心跳（仅下游浏览器腿）**：splice 建立后向浏览器周期发免掩码
  ping（`WS_PING_INTERVAL_MS=30s`、`WS_PING_MISSES_BEFORE_TEARDOWN=1`，
  与 `ws` README 官方心跳示例对齐）；PongScanner 被动扫描、不消费字节；
  上游（宿主）腿刻意无心跳（活性由 SSH keepalive / socket error 覆盖）——
  契约与参数见 14-sleep-background.md D4 扩展与 `ws-frames.ts`/`ws-heartbeat.ts`。
- 写路径背压（Node 双流适配，`res.write === false → waitForDrain`）；
  浏览器断连 → abort 上游（不泄漏 socket / 流资源）。

---

## 4. 与其他文档的关系

- `05-connection-manager.md`：架构契约（路径 / PlaneHandle / IPC / 补丁面）
  ——本文是其"连接模型 + 反代"的细化；
- `04-control-plane-api-data.md`：管理 REST 全表（含 connections CRUD）与
  反代的 HTTP 形状——**04 §4 是反代错误码与响应头白名单的权威**（03 §3
  只保留原则并指向之，不再枚举具体码表/头列表）；
- `02-host-management-deployment.md`：local 实例进程托管（本文只引用其
  状态投影与端口语义）；
- `05-connection-manager.md` §8：安全不变量（loopback-only；隧道 URL、私钥与
  代理配置永不进 renderer/日志；密码仅表单瞬时 write-only 输入且绝不返回/回填）；
- `17-server-side-gateway.md`：远程连接模型 v2 的权威（kind × transport ×
  认证 × 通道四维正交，§2；注册表 schema §9.1；反代头注入规则 §9.3；
  凭据 / safeStorage / 审计 §12/§13.4；安全不变量 S21–S24 §17）。
