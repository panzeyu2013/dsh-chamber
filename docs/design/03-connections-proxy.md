# 03 · 连接模型与每实例通用反代（v4 详细设计）

> 连接模型与每实例通用反代（v1 定稿，2026-08-14）：**连接模型**（本地 =
> 控制面 catalog 单行；远程 = 桌面主进程注册表）+ **每实例通用反代**
> `/api/i/<id>/*`（HTTP/WS/SSE 全量透传）。
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
  （随 v1 收敛整体移除）；隧道 / systemd 实现（desktop transport-manager（ssh provider），
  本文只定契约边界）。

### 1.3 连接模型边界（旧体系删除项，01 §4/§5）

- 无 project / 绑定 / 适配器 / broker / 会话索引——v2 的 catalog 多行、
  kind 分支、lease 生命周期、session-index 全部退役；会话业务归 dsh 前端
  runtime（N-ctx，每实例一个完整 dsh shell）。
- 远程实例不再经注入适配器 seed 控制面（连接注入适配器 / broker / 绑定 →
  移除，处置映射见 01 §4）。

---

## 2. 连接模型

### 2.1 本地实例：控制面 catalog 单行（connectionId 'local'）

文件：`$XDG_STATE_HOME/dsh-chamber/connections.json`（04 §6）：

```jsonc
{
  "schemaVersion": 1,
  "connection": {
    "id": "local",
    "label": "Local dsh",
    "accentColor": "#1a1a2e",
    "status": "ready",            // PlaneHandle.connectionState 投影（05 §7.3）
    "dshPort": 17501              // 实际监听端口（就绪后写入）
  }
}
```

- **单行固定**：`local` 恒存在（不可删除；DELETE = 停止实例，§2.1.2）；
  无 kind 分支、无 projects 子表——"本地实例"就是唯一一行。
- **status / dshPort 是投影**：status 派生自 PlaneHandle（02 §3.5 七态），
  `dshPort` 在就绪后写入；控制面在文件里只持久化 `label / accentColor`
  （用户可改项），运行态字段以内存 / PlaneHandle 为准（01 §6 原则 4：
  宿主事实只服务、不背书）。
- **原子写**：串行变更队列 + `tmp + fsync + rename`；损坏 → 大声失败
  （绝不冒充空行）并从备份恢复（04 §6 同一协议）。

#### 2.1.1 CRUD 语义（管理面端点全表见 04 §3.2）

| 操作 | 端点 | 语义 |
|---|---|---|
| 读 | `GET /api/connections` | 连接行投影（status / dshPort / label / accentColor） |
| 启动 | `POST /api/connections` `{kind:'local'}` | **幂等启动**：`stopped` → spawn（02）；`starting/ready/…` → 200 返回既有状态；`kind ≠ 'local'` → 400（远程实例不在此面） |
| 改 | `PATCH /api/connections/local` | 仅 label / accentColor |
| 停 | `DELETE /api/connections/local` | 优雅停止实例（02 §3.7）；行保留 |

### 2.2 远程实例：桌面主进程注册表（ssh-instances.json）

- **位置与所有权**：`<userData>/ssh-instances.json`，由**桌面主进程**
  （main.ts 的 transport-manager + 实例注册表）读写；**不进控制面 catalog**
  （05 §1 架构图）。
- **schema**（05 §7.4 的 IPC spec 同源）：

```jsonc
{
  "id": "ssh-inst-7",            // 反代 id = ssh-<id>
  "label": "home-server",
  "host": "192.0.2.10",        // 文档保留网段占位（RFC 5737）
  "user": "root",
  "sshPort": 2222,               // SSH 守护端口（null = ssh 默认 22 / config Port）
  "remotePort": 3080,            // 远程 dsh web profile 端口（02 §3.9 部署参考）
  "serviceName": "dsh-chamber"   // 远程 systemd 单元名（exec 目标）
}
```

- **生命周期**：SSH 隧道（`ssh -N [-p <sshPort>] -L <localPort>:127.0.0.1:
  <remotePort> <user@host>`，sshPort null 时不传 `-p`，走 ssh 默认/config）+
  systemd exec（`start/stop/is_active`，serviceName 校验
  `^[a-zA-Z0-9_.-]+$`；复用 host-logs 的 RING_BUFFER 日志环与
  AUTH_FAILURE_PATTERNS）；隧道 / 服务状态 → **phase** 投影给 renderer
  （idle / connecting / ready / degraded / error）；
  **隧道 URL 永不进 renderer**——renderer 只见 localPort / phase 投影
  （05 §7.4）。
- **IPC 白名单**（renderer ↔ main，preload 限定）：
  `desktop_ssh_instances_get/set`、`desktop_ssh_set_password`（内存级密码，
  05 §8 例外）、`desktop_ssh_config_list`（`~/.ssh/config`
  自动发现，非秘密投影：alias/hostName/user/port；IdentityFile/ProxyCommand/
  凭据绝不进 renderer）、`desktop_ssh_connect/disconnect/status/
  logs/logs_clear`、`desktop_ssh_start_service/stop_service/is_active`
  （05 §7.4）。
- **liveness 纪律**（AGENTS.md 正确性不变量）：隧道 / 服务事实只来自
  "隧道相位 + systemd is-active"的实时判定，从不持久化"已连接"状态。
- **就绪 = 隧道 TCP + dsh 身份握手**：TCP accept 只证明目标端口上有服务
  在听，不证明是 dsh。置 ready 前经 provider `verifyUp`（ssh：
  `host.describe` 信封探测，与本地实例就绪判据同源，02 §3.2）验证远端
  真是 dsh——目标端口上跑非 dsh 服务时显式报错/降级，**绝不呈现已连接**
  （假连接修复）。**确定性失败免重试**：目标**应答了**探测但证明不是
  （兼容的）dsh（HTTP 非 200 / 错误信封 / 版本过老）→ 验证结果带
  `terminal` 标记，第一次失败即落 error 终态（重试无法改变应答）；
  仅连接错误/超时等瞬时失败走有界退避重连（§2.2 phase 机）。

### 2.3 两形态对照

| 维度 | 本地（local） | 远程（ssh-<id>） |
|---|---|---|
| 权威位置 | 控制面 catalog 单行（§2.1） | 桌面主进程注册表（§2.2） |
| 进程所有权 | 控制面 spawn / reaper（02） | 远程 systemd（ssh provider exec） |
| 反代目标 | 本机 web profile `127.0.0.1:dshPort` | 隧道 localPort |
| 实例 id（`/api/i/<id>`） | `local` | `ssh-<sshInstanceId>` |
| 管理面可见性 | `/api/connections`（04 §3.2） | 不可见（renderer 经 IPC 投影） |

---

## 3. 每实例通用反代（/api/i/<id>/*）

### 3.1 挂载与路径映射

- 控制面挂载 `/api/i/<id>` 前缀；`id ∈ {local, ssh-<sshInstanceId>}`。
- **HTTP 全量透传**：任意方法（**无方法白名单**——05 §7.1），保持
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

- 反代不改写上游内容（不注入认证头——实例信任栅栏由 loopback +
  trusted-host 满足，02 §2.1）；Host 头保持实例自身
  `127.0.0.1:<port>`（与 `--trusted-host` 一致）。

### 3.2 可达性（v1 无认证边界）

- v1 收敛移除登录会话 cookie 门禁：`/api/i/*` 与管理面 `/api/*` 一律**匿名
  可达**（HTTP 与 WS upgrade 同一语义）——暴露面不变量靠控制面监听仅
  loopback（127.0.0.1）+ CORS（仅回环 origin 与显式 allowlist）维持
  （05 §8 / 04 D2）；
- 静态壳（`/`、dist、`/assets/*`、`/manifest.json`）匿名加载，无敏感面；
- 不再有认证/审计中间件（`/api/auth/*`、`/api/audit` 随 v1 收敛整体移除）。

### 3.3 失败语义（fail-loud）

| 情形 | 结果 |
|---|---|
| 实例无隧道 / 未就绪（phase != ready） | **503** 明确错误（code `instance_unavailable`）——无隧道绝不像"空成功"（AGENTS.md 代理诚实） |
| 上游连接拒绝 / 超时 | 502 / 504 显式错误（脱敏，不泄上游 host:port） |
| 实例 id 未知 | 404 |

### 3.4 响应收敛与体积上限

- **响应头白名单**（收敛上游头，防 hop-by-hop / 凭据泄露）：
  `content-type`、`cache-control`、`x-next-cursor`、`x-ratelimit-*`；
  其余上游头不直通（WS upgrade 101 所需头除外）。
- **体积上限**：请求体 ≤ 50MiB、响应体 ≤ 100MiB（沿用 v2 runtime-proxy
  语义；超限 → 413 / 取消上游流，显式而非截断静默）。
- 写路径背压（Node 双流适配，`res.write === false → waitForDrain`）；
  浏览器断连 → abort 上游（不泄漏 socket / 流资源）。

---

## 4. 与其他文档的关系

- `05-connection-manager.md`：架构契约（路径 / PlaneHandle / IPC / 补丁面）
  ——本文是其"连接模型 + 反代"的细化；
- `04-control-plane-api-data.md`：管理 REST 全表（含 connections CRUD）与
  反代的 HTTP 形状——**本文 §3 与 04 §4 共享同一反代契约定义**（04 §4
  给出请求/响应与错误码细节，两处引用同一语义，变更须同步）；
- `02-host-management-deployment.md`：local 实例进程托管（本文只引用其
  状态投影与端口语义）；
- `05-connection-manager.md` §8：安全不变量（loopback-only、隧道 URL 与
  SSH 材料永不进 renderer/日志）。
