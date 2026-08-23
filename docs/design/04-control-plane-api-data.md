# 04 · 控制面 API 与数据模型（v1 定稿）

> v2 薄壳 API 面（sessions / projects / project-sessions / interactions / events
> SSE / config / external / runtime 透传族）**全部删除**——这些业务由 dsh
> 前端 runtime 经每实例反代消费（03 §3），控制面不再持有。
> v1 控制面 API 面 = **管理 REST**（health / connections / host logs）+
> **每实例反代**（契约与 03 §3 共享，本文 §4 给 HTTP 形状）+ **前端服务**
> （静态 dist + `__DSH_BOOT__` 启动图清单）。
> **[v1 收敛（2026-08-14）]** 认证/审计面（`/api/auth/*`、`/api/passkeys*`、
> `/api/audit`）随模块整体移除——v1 无认证边界，全部端点匿名可达（仅
> loopback 监听，05 §8 安全不变量）。
> 权威契约：`05-connection-manager.md` §7（控制面/桌面契约）；连接模型见
> `03-connections-proxy.md`。

---

## 1. 目标与范围

**范围**：控制面对外暴露的全部 API 面与持久化数据模型，分三块：

1. **管理 REST**：`/health`、`/api/connections`（仅 local）、
   `/api/host/logs`——桌面 chamber 插件（侧栏 / 管理视图）与 CLI 的消费面；
2. **每实例反代**：`/api/i/<id>/*` 的 HTTP 形状（错误码 / 收敛），
   契约定义在 03 §3；
3. **前端服务**：静态 dist + `__DSH_BOOT__` 启动图清单。

**明确不在本文档范围**：宿主进程托管（02）、连接模型细节（03）、
会话业务（dsh 前端 runtime，本仓不承载）、远程隧道与 systemd（desktop
transport-manager（ssh provider），03 §2.2）。**认证机制（scrypt / Passkey / 限流 / JWT / 审计）
随 v1 收敛整体移除**，不再有对应文档。

---

## 2. 设计要点

### D1 · 统一错误契约

- 所有错误响应 `{ "error": string, "code"?: string }`；4xx 携带可展示的
  安全消息；**5xx 永不回显上游细节**（host:port、URL、凭据、路径）；
- 控制面码 snake_case 带域前缀（`connection_*` / `host_*` / `system_*`）；
  dsh 业务码（kebab-case）只出现在反代透传面，原样透传不做重映射。

### D2 · v1 无认证边界

- v1 收敛移除全部认证/审计面（`/api/auth/*`、`/api/passkeys*`、`/api/audit`
  及 cookie/bearer 门禁）——管理面 `/api/*` 与反代面 `/api/i/*` 一律匿名；
- 暴露面不变量：控制面 HTTP 仅监听 loopback（127.0.0.1）；API/upgrade 的
  Host 必须是 loopback authority（拒绝 DNS rebinding），HTTP 在路由与
  body/副作用前、WS 在 upgrade 转发前再执行同一 Origin 门禁（当前 Host
  精确同源或显式 `corsOrigins` allowlist；其他回环端口与 `null` 均拒绝），
  非法来源 403 `origin_forbidden`。
  响应不带 CORS 头本身不是写操作防线。

### D3 · 连接唯一：catalog 单行（local）

- 数据权威 = `connections.json` 单行（03 §2.1）；status / dshPort 为
  PlaneHandle 投影（02 §3.5），控制面只持久化 label / accentColor；
- `POST` 只接受 `kind:'local'`（幂等启动）；远程实例在桌面注册表，不进本面。

### D4 · 前端服务 = 静态 dist + `__DSH_BOOT__` 清单

- 控制面在 `/` 服务 dsh 官方前端构建产物（dist/）并注入启动图清单
  （§5）；静态壳匿名加载。

### D5 · 反代 = 与 03 共享定义

- 契约定义于 03 §3；本文 §4 只补 HTTP 形状（路径 / 方法 / 错误码），
  两处引用同一语义，变更须同步（03 §4）。

---

## 3. 管理 REST 全表

> v1 无认证：以下全部端点匿名可达（仅 loopback 监听）。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | 存活 / 自检（§3.1） |
| `/api/host/health-events` | GET | SSE 状态推送流（§3.1.1） |
| `/api/connections` | GET | 连接行投影（§3.2） |
| `/api/connections` | POST | 幂等启动 `{kind:'local'}`（§3.2） |
| `/api/connections/local` | PATCH | 仅 label / accentColor（§3.2） |
| `/api/connections/local` | DELETE | 优雅停止实例（§3.2） |
| `/api/host/logs` | GET | host-logs 滚动日志（§3.3） |

### 3.1 GET /health

```
200 { "ok": true, "dsh": { "status": "ready", "port": 17501 } }
200 { "ok": true, "dsh": { "status": "starting", "error": "spawn 失败：端口 17501 被占用（P+1 重试 10 次后放弃）" } }
500 { "error": "internal" }   // 控制面自身异常
```

- `dsh.status` ∈ 02 §3.5 七态（stopped / starting / ready / degraded /
  restarting / restart-exhausted / error）；`port` 为 0 时即未就绪；
  `error` 仅在非 ready 时出现（原因摘要，脱敏）。

### 3.1.1 GET /api/host/health-events（SSE 状态推送）

- `text/event-stream`；连接即发当前快照（`{ok:true, dsh:{...}}`，形状与
  §3.1 相同），此后**每次机器状态迁移**推一帧；每 20s 发 `: keepalive`
  注释帧；客户端断开即摘除监听（不泄漏）；写入失败（连接已死）同样触发
  拆除。`write() === false` 仅表示 Node 已接收当前帧但下游发生背压：该客户端
  暂停写入并按序保留至多 32 个后续状态帧，`drain` 后继续；背压期间不排队
  keepalive，状态队列溢出则拆除该慢客户端。所有拆除路径都会取消状态订阅、
  清空队列并移除待定 `drain` 监听——写错误/慢客户端永不逃逸进状态机或造成
  无界内存增长（监听器隔离在 local-connection 扇出点）。
  连接行/标签等低频字段不走此流（仍由 §3.2 轮询，30s 兜底）。
- 动机（05 §2.3）：本地实例由控制面直接托管，状态本来就发生在主进程——
  推送让 stopped → starting → ready 即时可见，渲染层不为本地状态轮询；
  远程来源本就经桌面 `desktop_ssh_status_changed` 推送，两形态对称。
- 帧错误容错：畸形帧由客户端忽略，下一帧快照覆盖。

### 3.2 /api/connections（仅 local）

| 端点 | 请求 | 响应 | 错误 |
|---|---|---|---|
| GET | — | `{connection: {id:'local', label, accentColor?, status, dshPort?, error?}}` | 404 `connection_not_found`（无连接行） |
| POST | `{kind:'local', label?, accentColor?}` | `{connection, spawned: bool}` | 400 `connection_kind_unsupported`（kind ≠ local）；400 `connection_invalid_input`；503 `dsh_not_ready`（spawn 失败） |
| PATCH `/local` | `{label?, accentColor?}` | `{connection}` | 400 `connection_invalid_input`；404 `not_found` |
| DELETE `/local` | — | `{stopped: true}` | 409 `connection_busy`（restarting 中）；404 `not_found` |

- **POST 幂等启动**：`stopped` → spawn（02 §3.1），同步返回 `starting` 态
  （`spawned: true`），就绪经 GET 轮询；`starting/ready/degraded/…` →
  返回既有状态（`spawned: false`），绝不重复 spawn；
- `kind: 'local'` 以外的值一律 400——远程实例由桌面注册表管理
  （03 §2.2），不在本 API 面；
- DELETE = 优雅停止（02 §3.7），行保留（local 不可删）。

### 3.3 GET /api/host/logs

```
200 { "port": 17501, "lines": [ { "ts": 1720000000000, "stream": "stdout|stderr", "line": "…" } ],
      "truncated": false }
参数：?port=（缺省取 local 最近 spawn 记录）&limit=（默认 200，上限 1000）&offset=（跳过最新 N 行）
```

- 纪律：日志永不含凭据/令牌（05 §8 安全不变量）；`stream` 与 `line` 原样，
  时间戳服务端打；无托管记录/日志文件 → 404 `not_found`，参数非法 →
  400 `invalid_argument`。

### 3.4 管理面错误码表

| code | HTTP | 条件 |
|---|---|---|
| `dsh_not_ready` | 503 | POST 启动时 spawn/就绪失败 |
| `connection_kind_unsupported` | 400 | POST 非 local kind |
| `connection_invalid_input` | 400 | label / accentColor 校验失败 |
| `connection_not_found` | 404 | GET 无连接行 |
| `connection_busy` | 409 | restarting 等过渡态中拒绝停止 |
| `origin_forbidden` | 403 | HTTP/WS 的浏览器 Origin 不在本机/显式 allowlist |
| `invalid_argument` | 400 | host-logs 参数非法 |
| `not_found` | 404 | host-logs 无托管记录/日志文件；未知路径 |
| `internal` | 500 | 兜底（脱敏消息） |

---

## 4. 每实例反代（HTTP 形状）

> 契约定义与 `03-connections-proxy.md` §3 **共享**；本节给出 HTTP 侧
> 请求/响应形状与错误码（两处变更须同步）。

### 4.1 路径与方法

```
挂载：/api/i/<id>/*      id ∈ {local, ssh-<sshInstanceId>}
任意方法（GET/POST/PATCH/DELETE/…）全量透传，无方法白名单（05 §1）
WS upgrade：/api/i/<id>/api/events.mux | events.host（剥前缀 → 实例 /api/…）
SSE：text/event-stream 响应直通（不缓冲、不解析、不重封装）
```

### 4.2 错误码（v1 无门禁）

> v1 收敛移除登录会话 cookie 门禁：`/api/i/*` 对获准来源匿名可达（仅
> loopback 监听 + HTTP/WS 来源门禁，03 §3.2 / 05 §8），不再有 401 认证
> 失败面。

| 情形 | 结果 |
|---|---|
| Origin 非当前 Host 精确同源且不在显式 allowlist（包括 `null` 或其他回环端口） | 403 `{error, code:'origin_forbidden'}`（转发前拒绝） |
| 实例 phase != ready（无隧道 / 未就绪） | 503 `{error, code:'instance_unavailable'}`（fail-loud，03 §3.3） |
| 上游连接拒绝 / 超时 | 502 / 504 `{error, code:'upstream_failed'}`（脱敏） |
| id 未知 | 404 `{error, code:'instance_not_found'}` |
| 已声明请求体 > 300MiB、未知长度请求体 > 32MiB / 响应体 > 300MiB | 413 `{error, code:'body_too_large'}` / 取消上游流 + 413 |

### 4.3 响应头白名单

`content-type`、`cache-control`、`x-next-cursor`、`x-ratelimit-*`；
其余上游头不直通（WS upgrade 101 所需头除外）。

---

## 5. 前端服务契约

- **静态服务**：控制面在 `/` 服务 dsh 官方前端构建产物（`dist/`）——
  index.html、assets（`/assets/chamber-*.js` 等）、`/manifest.json`；
  匿名加载（v1 无认证面）；SPA 回退（未知路径 → index.html，缺资产仍
  404）。
- **`__DSH_BOOT__` 启动图清单**：构建链产出 `dist/manifest.json`
  （renderer 的 gen-boot-manifest.mjs），控制面在响应 index.html 时注入
  `window.__DSH_BOOT__`（与 dsh-client-modules 的 parseBootManifest 契约
  一致，vendor `dsh-client-modules/src/client/manifest.ts` 为权威）：

```ts
interface WebBootGraph {
  rev: string // 全图一致性锚（sha1-12）
  entries: {
    id: string // 条目名 == 包名（插件注册键）
    url: string // bundle 端点（含 ?rev= 缓存锚）
    rev: string // bundle 内容哈希（sha1-12）
    immediately?: boolean // 一阶段预取标记
  }[]
}
```

  - parseBootManifest 消费该 wire 并派生两个视图：`modules[]`（模块表
    预取视图）与 `plugins[]`（entry 组合视图）；chamber chrome 与 dsh
    原生 ui-* 插件的组合图在宿主侧（v4 单 entry：`@dsh-chamber/app`
    chamber composite bundle，自注册进 `window.__ModuleLoader__`）；
    **每实例宿主图额外 entry 另取（设计 09）**：boot 时前端经反代
    （`/api/i/<id>`）调 chamber host 包 `@dsh-chamber/dsh-host-client-graph`
    的 Remote `clientGraph/graph` 取该实例宿主组合的客户端插件 boot 图，按
    `CHAMBER_COVERED_IDS` 去重并预加载剩余 bundle、经 boot.ts `extraRows`
    seam 合并进 boot rows——机制与构建链详见 05 §6 / 设计 09 §3.5；
  - **bundle URL 约定**：vite 产物 `/assets/chamber-<hash>.js?rev=<rev>`
    （gen-boot-manifest 按 `assets/chamber-*.js` 模式定位产物；vendor
    自身的默认路径 `/plugins/<id>/client.js` 仅为参考——wire 只要求
    id/url/rev 为字符串）。
- **N-ctx**：每个实例一个 AppWebEntry（05 §4）；实例流量全部经
  `/api/i/<id>/*`（03 §3）；侧栏会话行点击 → 经 `AppWebEntry.runtimeCtx`
  分发打开动作（05 §2/§4）。

---

## 6. 数据模型

| 载体 | 路径 | 内容 | 权威方 |
|---|---|---|---|
| JSON 单行 | `$XDG_STATE_HOME/dsh-chamber/connections.json` | `{schemaVersion, connection: {id:'local', label, accentColor}}`（status / dshPort 为运行态投影） | 控制面（03 §2.1） |
| JSON 注册表 | `<userData>/ssh-instances.json`（桌面主进程） | 远程实例 `{id, label, kind, host, user, sshPort, remotePort, serviceName, remoteDshHome}`（schema 以 03 §2.2 为准） | 桌面主进程（03 §2.2） |
| JSON 每进程一文件 | `…/managed-dsh/<pid>.json` | `{pid, ownerPid, ownerInstanceId, port, binary, profile:'web', source, startedAt}` | 控制面（02 §3.3） |

- **原子写协议**（connections.json）：同步 write-through + `tmp + fsync +
  rename`；成功后才发布内存状态，失败回滚并抛出
  `json_store_persist_failed`，任何 catalog/API 调用都不得回报成功；损坏 →
  回退备份并进入显式 recovery 态，绝不冒充空行（03 §2.1 同款）。
- **v2/v1 存储删除项**：`project-catalog.json`、`connection-profiles.json`、
  `project-session-bindings.json`、`jwt-secret`、`ui-passkeys.json` 及 SQLite
  的 sessions / interactions / goals / scheduled_tasks / session_folders /
  notes / notifications / push_subscriptions / tunnels / github_accounts /
  audit_log 表——随薄壳面与认证/审计面（v1 收敛）整体退役
  （01 §4/§5），不再读写。

---

## 7. 边界与未决问题

1. **反代响应头白名单演进**：上游若引入新必需响应头，需同步 03 §3.4 与
   本文 §4.3（一处契约两处表述，变更必须两处一致）。
2. **`__DSH_BOOT__` 与 dsh 版本漂移**：manifest 形状随 dsh parseBootManifest
   契约（vendor 源码为准）维护；构建链变更见 05 §6（pnpm + 符号链接 +
   `assets/chamber-*.js` 产物）。
