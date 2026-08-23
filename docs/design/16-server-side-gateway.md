# 16 · 服务端接入层（gateway）：dsh-chamber 单仓库内的服务端形态

> 状态：**详设版（已通过 4 子代理交叉核对 + P0-1 结论 A）**。本文在架构方案基础上展开到
> 执行级：复用契约（精确签名）、gateway 包结构与文件清单、配置面、HTTP 中间件链、认证、
> 反代、通道注册表、feature host、前端中间件、数据模型、安全不变量（S1–S15）、分阶段验收、
> 决策日志、桌面连接（§6.5）、server 端部署（§6.6）。P0-1 已核对（§8.1，结论 A）；P0-2
> （真 dsh 反代冒烟）、P1–P4 代码待执行（见 STATUS）。
>
> **单仓库原则**：gateway 不是独立软件，而是 `dsh-chamber` 仓库内的新包
> `packages/gateway`，与桌面端 `packages/desktop` 共享控制面核心与复用前端。

---

## 1. 定位与目标（不变）

`packages/gateway` 是 dsh-chamber 的服务端形态：把每台设备上 loopback 的 dsh 暴露成
一个**带认证的网址**（浏览器/手机访问），同时作为桌面端 `packages/desktop` 的可连接
目标。三个角色：**接入层**（认证 + 通道）、**编排层**（feature host）、**前端中间件**。

三个痛点 → 解法（不变）：

| 痛点 | gateway 解法 |
|---|---|
| dsh 只开 localhost 且被信任栅栏拒绝 | 复用 `instance-proxy` 的 Host/Origin 改写 |
| 复用前端需额外注入 package | 编排下沉到 gateway，用 dsh `/api` 驱动 |
| 不支持移动端 | 前端中间件注入 viewport/PWA/UA（远期） |

### 1.1 仓库结构（单仓库，不叉）

```
dsh-chamber
├─ packages/control-plane   # 共享核心（下面 §3 的复用来源）
├─ packages/renderer        # 复用 dsh 官方前端（复合 entry + N-ctx，桌面端用）
├─ packages/desktop         # 桌面形态：Electron 壳 + SSH transport
├─ packages/cli             # CLI 薄壳
├─ packages/gateway         # 【新增】服务端形态（本文）
├─ packages/transport       # 【远期，非 MVP】SSH transport 抽取（仅当 gateway 未来聚合远程 dsh 才需要）
├─ packages/dsh-client-connection / dsh-client-web / dsh-chamber-client-ui-* / ...
└─ ...
```

---

## 2. 复用契约：gateway 直接 import 的 control-plane 模块（精确签名）

> 来源：`packages/control-plane/src/*`（feat/server-side 分支，head 7e2a7a2）。这些
> 接口是**已存在**的，gateway 不做重实现，只做「组合 + 新增」。
> 标记 `[需改动]` 的是 gateway 落地时需要对 control-plane 做的**最小改动**。
> 行号引用以 head 7e2a7a2 为准，随 commit 漂移；落地时以**函数名/常量名**为准，行号仅作定位提示。

### 2.1 `createControlPlane(options)` → `PlaneHandle`

```ts
interface ControlPlaneOptions {
  port?: number                 // 默认 17500
  host?: string                 // 默认 '127.0.0.1' —— gateway 传 '0.0.0.0'
  stateDir?: string             // 默认 $DSH_CHAMBER_STATE ?? ~/.dsh-chamber
  dshWorkspacePath?: string
  webDistDir?: string           // 静态前端 dist；gateway 单实例形态不用（改走反代 /）
  logger?: Logger               // {log, warn, error}
  corsOrigins?: string[]        // 显式跨源 allowlist
  localConnectionDeps?: ...     // 测试缝
  hostGraphPackageSourceDir?: string
  hostGitWorktreePackageSourceDir?: string
}
interface PlaneHandle {
  start(): Promise<void>; stop(): Promise<void>
  readonly port: number | null
  readonly connectionState: string          // 七态机
  readonly localProcessAlive: boolean
  readonly instanceId: string
  getLocalDshPort(): number | null          // [需改动·新增] gateway-proxy 目标解析用（当前未暴露）
  registerInstanceTransport(connectionId: string, baseUrl: string): void
  unregisterInstanceTransport(connectionId: string): void
  startLocal(): Promise<void>               // 幂等预启动
}
```

**gateway 的用法**：`createControlPlane({ host: '0.0.0.0', stateDir, dshWorkspacePath, logger, ... })`，
得到本地 dsh 托管（spawn/health/reaper/logs）+ 管理 REST + `/api/i/<id>/*` 反代。
gateway 在此基础上**新增**：认证、`/`/`/plugins/*`/`/api/*`(非管理路由) 的全量反代、
通道注册表、feature host、前端中间件。

**`[需改动·control-plane 3 处 + gateway 层 1 处]`**：① `PlaneHandle` 增 `getLocalDshPort()`
（gateway-proxy 解析本地 dsh 目标用，当前未暴露）；② `registerTransport` 放宽非 loopback +
可附加请求头（§6.4）；③ 从 `createControlPlane.start()` 抽出「server 壳」（安全头 + CSP +
URL 解析 + socket 参数 + WS upgrade 骨架），把 **dispatch 变为可注入**——`createControlPlane`
用默认 dispatch，gateway 注入自己的 dispatch（auth → 分派 → proxy/api/features）；
④ 认证中间件**不落在 control-plane**（gateway 层实现，经 ③ 的注入点挂载，**不计入 control-plane 改动数**）。

### 2.2 `spawnDsh` / `webProfileArgs`（dsh 子进程精确形状）

```ts
// webProfileArgs(port, patchPath?):
['--profile','web','--host','127.0.0.1','--port',String(port),'--trusted-host',`127.0.0.1:${port}`]
// 有 patchPath 时：['--profile','web','--patch',patchPath,'--host',...]
```

spawn 常量（**gateway 直接继承，不改**）：`BASE_DHSPORT=17510`、`MAX_SPAWN_ATTEMPTS=5`、
`EARLY_EXIT_GRACE_MS=15000`、`LISTEN_WAIT_MS=90000`、`TERMINATE_GRACE_MS=1000`。
env 钉死：`DSH_HOME`、`DSH_TELEMETRY_DISABLED=1`、`DSH_PERMISSION_MODE=workspace-write`、
`SSH_CONNECTION='127.0.0.1 0 127.0.0.1 0'`（browse 交互钉）。node 可执行解析
（Electron / 纯 node / PATH / known-root）、detached 独立进程组、pid 记录原子写。

**gateway 关键点**：dsh 恒 loopback（`--host 127.0.0.1`），`0.0.0.0` 由 gateway 自己绑。
`--trusted-host 127.0.0.1:<P>` 对 loopback 而言**是冗余的**——dsh 栅栏对 `Host: 127.0.0.1:<P>`
的放行来自 loopback 判定（`api-request-trust.ts` 的 `isLoopbackHostname`），不依赖
`--trusted-host`；保留它仅为与 chamber 现有 spawn 参数一致（无副作用）。真正让反代放行的是
gateway-proxy 把 Host/Origin 改写为 loopback 权威（§6.3）。

### 2.3 `createInstanceProxy(deps)` → `InstanceProxy`（Host/Origin 改写的权威实现）

```ts
createInstanceProxy({ logger, getLocalState, getLocalDshPort, ... })
  → { handleHttp, handleUpgrade, registerTransport, unregisterTransport, getDiagnostics, closeAllStreams }
```

权威事实（gateway 反代必须逐条复用，见 §6）：
- `forwardHttp` 转发头构造：`headers = { host: target.host }`；`STRIPPED_REQUEST_HEADERS`
  剥掉 `host/cookie/authorization/connection/content-length/...`；**Origin 改写为
  `http://${target.host}`**（`instance-proxy.ts:474-491`）。
- `forwardUpgrade` 只带 `upgrade/connection/sec-websocket-*` 头，**不带 Origin**，Host
  改写为上游 loopback（`:614`）。
- 错误语义（`{error, code}`）：`instance_not_found` 404 / `instance_unavailable` 503 /
  `upstream_failed` 502 / `upstream_timeout` 504 / `body_too_large` 413 /
  `resource_exhausted` 503 / `request_timeout` 408。
- 限流：`MAX_REQUEST_BODY_BYTES=300MiB`、`MAX_RESPONSE_BODY_BYTES=300MiB`、
  `MAX_CONCURRENT_HTTP_REQUESTS=64`、`MAX_CONCURRENT_WS_STREAMS=64`、
  `MAX_PENDING_WS_HANDSHAKES=16`、`UPSTREAM_TIMEOUT_MS=10000`。
- 响应头白名单 `RESPONSE_HEADER_WHITELIST`（content-type/cache-control/x-next-cursor/x-ratelimit-*）、
  WS 响应白名单、WS 心跳（30s ping，1 次未 pong 撕断）。

**[需改动]** `registerTransport(connectionId, baseUrl)` 当前强制 loopback origin
（`instance-proxy.ts:849-856`：hostname ∈ 127.0.0.1/localhost/::1）。gateway 的
`gateway`/`direct` 连接 kind 需 `https://` 非 loopback + token。**改动**：给
`registerTransport` 加一个 `allowRemoteOrigin`（或新增 `registerRemoteTransport`），
仅对 `gateway:` 前缀的 connectionId 放开非 loopback `https://` baseUrl，并允许附加
`Authorization` 头（token 只在 gateway 主进程，不进 renderer）。

### 2.4 `createApi(deps)` → `ApiSurface`（管理 REST，gateway 复用 + 加认证前置）

```ts
createApi({ logger, corsOrigins, getHealth, getConnectionRow, startConnection,
            updateConnectionProfile, stopConnection, hostLogs, instanceProxy,
            subscribeHealthEvents })
  → { handle(req,res), getCorsHeaders(req) }
```

- 路由：`GET /health`、`/api/connections`（GET/POST/PATCH/DELETE）、`/api/host/logs`、
  `/api/host/health-events`（SSE）、`/api/i/<id>/*`（代理，ownBody）。
- **CORS/origin 栅栏**（`corsFor`）：Host 必须是 loopback 权威；带 Origin 的请求必须
  同源或命中 `corsOrigins`；`Origin: null` 拒绝；不合法 → 403 `origin_forbidden`。
- **[需改动]** 这是 v1 的「匿名面」。gateway 需要在 `api.handle` **之前**加认证中间件，
  `createApi` 本身不动（认证是 gateway 层，不是 control-plane 层）。

### 2.5 `dsh-client.ts`（gateway feature-host 驱动 dsh 的 wire 层）

```ts
call(baseUrl, method, payload, {signal?, timeoutMs?, generationSignal?, pendingCap?})
  → { rpcId, result }                    // POST /api/<method>，业务错误抛 RpcBusinessError
respond(baseUrl, {rpcId, result}, opts)  // POST /api/respond（审批/提问）
openEventStream(baseUrl, '/api/events.mux'|'/api/events.host', signal)
  → AsyncGenerator<ServerRequest>        // WS 下行，逐帧 JSON ServerRequest
describeCapabilities(baseUrl, opts)      // host.describe，generation 级缓存
// 错误：RpcBusinessError{code, details} / RpcTransportError{code, status} /
//       PendingCapExceededError
```

> gateway 的 feature host **不 new 自己的 HTTP 客户端**，全部复用这套（已含 rpcId、
> 信封、30s 超时、每会话 pending 软上限 64、generation 失效、连接离线语义）。

### 2.6 `createJsonStore({filePath, logger, initial, onLoadValidate})` → `JsonStore`

gateway 自有数据（连接/设备/token/通道）持久化直接复用：`load/getDoc/getSnapshot/
mutate/mutateIfMatch/persist/getStatus`；backup-first 原子写（.bak→.tmp→rename，fsync）、
revision 计数器、corrupt 恢复态（main→.bak→initial，双重损坏抛错，绝不 fake-empty）。

---

## 3. gateway 包结构与文件清单（精确）

```
packages/gateway/
├─ package.json                # 依赖：@dsh-chamber/control-plane（workspace）、ws（已存在）
├─ src/
│  ├─ index.ts                 # createGateway(options) → GatewayHandle（组合根）
│  ├─ config.ts                # GatewayConfig + parseConfig + env 解析 + 校验
│  ├─ auth.ts                  # AuthProvider 接口 + password/token/none 三个实现
│  ├─ gateway-proxy.ts         # 单目标全量反代（/、/plugins/*、/api/* 非管理路由）
│  ├─ channels.ts              # ChannelProvider 接口 + 注册表 + direct/ssh provider
│  ├─ middleware.ts            # 前端 HTML 注入（viewport/PWA/UA）
│  ├─ routes.ts                # /chamber/* 编排路由（git/connections/channels/health）
│  ├─ store.ts                 # gateway 数据模型（json-store 包装）
│  └─ features/
│     ├─ git.ts                # git worktree offload（§8.1）
│     ├─ index.ts              # 会话索引（events.mux 投影，只索引不消费帧）
│     ├─ notify.ts             # 通知（approval/question 帧 → SSE/push）
│     └─ schedule.ts           # cron 调度（session.prompt）
├─ assets/                     # 静态前端：登录页、/chamber/* 轻面、manifest.webmanifest、sw-register.js、mobile.html(远期)
└─ test/                       # 见 §12 验证清单
```

`createGateway` 组合根（对照 `createControlPlane`）：

```ts
function createGateway(options: GatewayOptions): GatewayHandle {
  const plane = createControlPlane({ host: options.host /* '0.0.0.0' */, ...options.plane })
  const auth = createAuth(options.auth)                    // §5
  const channels = createChannelRegistry(options.channels) // §7
  const store = createGatewayStore(options.stateDir)       // §10
  const proxy = createGatewayProxy({
    getLocalDshPort: () => plane.getLocalDshPort(),        // [需改动] §2.1
    getLocalState: () => plane.connectionState,
  })                                                       // §6
  const features = createFeatureHost({
    getDshBaseUrl: () => {
      const p = plane.getLocalDshPort()
      return p === null ? null : `http://127.0.0.1:${p}`   // feature-host 直连 dsh loopback，不经 proxy
    },
  })                                                       // §8
  const middleware = createHtmlMiddleware(options.ui)      // §9
  // 组装 HTTP 服务器（§4 中间件链：auth → 分派 → proxy/api/features/静态）
}
```

> 关键澄清：**feature-host 直连 dsh 的 loopback**（`http://127.0.0.1:<P>`，走 §2.5 的
> `call/respond/openEventStream`），**不经 gateway-proxy**——避免自反代（gateway 调自己）。
> gateway-proxy 只服务**浏览器/桌面**的入站请求（`/`、`/plugins/*`、`/api/*`）。

```ts
// GatewayOptions 与 GatewayHandle（组合根契约，落地时按此实现）
interface GatewayOptions {
  plane: ControlPlaneOptions          // 透传给 createControlPlane（host 传 '0.0.0.0'）
  auth: AuthConfig                    // §5
  channels?: ChannelConfig            // §7（MVP 空）
  ui: { pwa: boolean; shellNav: boolean }   // §9
  corsOrigins: string[]
  tls?: { cert: string; key: string }
}
interface GatewayHandle {
  start(): Promise<void>              // reaper → seed → 绑 HTTP →（host 按需 spawn）
  stop(): Promise<void>               // stop dsh → 关 HTTP（复用 control-plane stop 语义）
  readonly port: number | null
  readonly connectionState: string    // 本地 dsh 七态机（透传 plane.connectionState）
  readonly localProcessAlive: boolean
  readonly instanceId: string
}

### 3.1 配置面（GatewayConfig + CLI + env，精确）

```ts
interface GatewayConfig {
  plane: { port: number; host: '127.0.0.1' | '0.0.0.0'; stateDir: string; dshWorkspacePath: string }
  auth: { kind: 'none' | 'password' | 'token'; password?: string; token?: string }
  channels: { direct?: boolean; ssh?: boolean }
  ui: { pwa: boolean; shellNav: boolean }
  corsOrigins: string[]
  tls?: { cert: string; key: string }   // 可选内置 TLS；默认交给前置 Nginx/Caddy
}
```

**CLI（对齐 `standalone.ts` 风格，`gateway serve`）**：

```
gateway serve [--host 0.0.0.0] [--port 3000] [--state-dir DIR] [--dsh-path PATH]
              [--ui-password PWD] [--api-token TOK]
              [--cors-origin ORIGIN ...] [--no-pwa] [--tls-cert C --tls-key K]
```

**env（优先级 CLI > env > 默认）**：`DSH_GATEWAY_HOST` / `DSH_GATEWAY_PORT` /
`DSH_GATEWAY_PASSWORD` / `DSH_GATEWAY_TOKEN` / `DSH_GATEWAY_STATE` / `DSH_GATEWAY_DSH_PATH`。

**校验（`config.ts`，失败 exit 2）**：
- `host` 仅 `'127.0.0.1'` | `'0.0.0.0'`；`port` 1..65535。
- `host === '0.0.0.0'` 且 `auth.kind === 'none'` → 失败（S1，提示 `--ui-password`/`--api-token`）。
- `host === '0.0.0.0'` 时 `password` 或 `token` 至少其一非空。
- `--tls-cert`/`--tls-key` 必须成对出现；不同时给定则 gateway 只做明文 HTTP，TLS 交给前置反代。

---

## 4. HTTP 服务器与中间件链（精确顺序）

gateway 的 HTTP 服务器 = `createControlPlane` 内 `start()` 的服务器逻辑的**扩展**，
不是重写。每个请求的精确执行顺序：

```
1. 安全头 + CSP           setHeader 复用 CONTROL_PLANE_SECURITY_HEADERS + CSP(nonce, 'unsafe-eval')
                          （'unsafe-eval' 必留：dsh loader 用 new Function 求值 __jsExpr）
2. URL 解析               new URL(req.url, 'http://localhost')；解析失败 → 400 invalid-url
3. 认证门（新增）          auth.verify(req) → principal 或 401 unauthorized
                          公开路由豁免（仅三个）：GET /health（探活）、GET /auth/login（登录页）、
                          POST /auth/login（密码登录，仅 password provider 提供时存在）
4. 路由分派（按 surface）
   surface='health'       → api.handle（管理：GET /health）
   surface='auth'         → authRoutes.handle（GET 登录页 / POST 登录，仅 password provider 挂载）
   surface='api' 且 path ∈ 管理路由集 → api.handle
                        （管理路由集：/api/connections、/api/host/logs、/api/host/health-events、/api/i/<id>/*）
   surface='api' 其他     → gatewayProxy.handleHttp → dsh（含 /api/session.*、/api/events.*、Typert /<ns>/<method> 等）
   surface='plugins'      → gatewayProxy → dsh（客户端插件 bundle，/plugins/<id>/client.js）
   surface='chamber'      → routes.handle（编排，/chamber/*）
   其他（/、assets）       → gatewayProxy → dsh（dsh 官方前端 index.html + assets，需认证）
5. WS upgrade（server 'upgrade' 事件）
   1) 认证门（同 HTTP：Authorization/cookie）
   2) origin 栅栏（复用 api.getCorsHeaders，403 origin_forbidden）
   3) /api/events.mux|host → gatewayProxy.handleUpgrade → dsh（Host 改写，不带 Origin）
   4) /chamber/*           → routes.handleUpgrade（编排自己的 WS，若有）
```

服务器 socket 参数（继承 control-plane）：`headersTimeout=10s、requestTimeout=35s、
keepAliveTimeout=5s、maxRequestsPerSocket=1000、maxConnections=192`。

**关键分歧点（必须写死，否则执行偏差）**：`/api/*` 分三类——
- **gateway 管理路由**（固定白名单，走 `api.handle`）：`connections`、`host/logs`、
  `host/health-events`（三者均为 gateway 自己权威的管理面）。
- **每实例反代前缀**（走 `api.handle` → instance-proxy）：`/api/i/<id>/*`（L0 单实例时无
  transport，命中即 404/503；L1 多实例时供桌面 N-ctx 用）。
- **其余一切 `/api/*`**（`session.*`、`workspace.*`、`goal.*`、`events.mux/host`、Typert
  `/<ns>/<method>`…）→ `gatewayProxy` 透传给 dsh。
分派用**固定白名单**而非「未知即透传」的兜底，避免未来 dsh 新增管理语义端点被误透传。

**route 全量清单（gateway 自有 vs 复用 vs 透传）**：

| 路径 | 归属 | 是否需认证 |
|---|---|---|
| `GET /health` | 复用 `api.handle` | 公开 |
| `GET/POST /auth/login` | gateway `authRoutes`（登录页 + 登录） | 公开 |
| `/api/connections`、`/api/host/logs`、`/api/host/health-events` | 复用 `api.handle` | 需认证 |
| `/api/i/<id>/*` | 复用 `api.handle`→instance-proxy | 需认证 |
| `/api/*` 其余 | gateway-proxy → dsh | 需认证 |
| `/plugins/*`、`/`、assets | gateway-proxy → dsh（`/` 加 HTML 注入） | 需认证 |
| `/chamber/*` | gateway `routes`（编排） | 需认证 |

---

## 5. 认证（精确，可插拔，后置实现）

```ts
interface AuthPrincipal { kind: 'password' | 'token' | 'passkey' | 'none'; id: string; issuedAt: number }

interface AuthProvider {
  readonly kind: string
  /** 从请求提取并校验身份；未认证返回 null。绝不在日志/响应体回显凭据。 */
  verify(req: { headers: Record<string, string|string[]|undefined>; socketAddr: string }): Promise<AuthPrincipal | null>
  /** 登录端点（仅 password/passkey 提供）；返回可序列化的 session 凭据。 */
  login?(body: unknown): Promise<{ setCookie?: string; token?: string }>
  /** 变更密码/撤销 token 时使既有会话失效（可选）。 */
  revoke?(principal: AuthPrincipal): Promise<void>
}

function createAuth(cfg: AuthConfig): AuthProvider
```

### 5.1 三个实现（浏览器 MVP = password + none；桌面连接 MVP = token 共享）

| provider | 校验 | 凭据 | 持久化 |
|---|---|---|---|
| `none` | 恒通过 | — | 仅当 `plane.host==='127.0.0.1'` 才允许 |
| `password` | scrypt 校验 → HS256 JWT session cookie（12h；可信设备 7d） | `set-cookie` | secret 持久化 `0600`，盐每次运行随机 |
| `token` | 恒定时间比较 bearer token（hash 存储） | `Authorization: Bearer` | `<stateDir>/tokens.json`（0600，只存 hash） |

> **分层澄清（避免 D2/D7 冲突）**：`password`/`none` 服务于**浏览器**访问（`/` 登录门）；
> `token` 服务于**桌面 chamber 连 gateway**（§6.4，单个共享 token）。二者是同一 `AuthProvider`
> 面下的两个不同 consumer，不是互斥——一个 gateway 可同时配 password（浏览器）+ token（桌面）。

> **登录页（明确）**：因为 `/` 也在认证门后，gateway 必须服务一个最小的登录页——
> `GET /auth/login` 返回 gateway 自带的静态 HTML 表单（public，不经 dsh）；登录成功
> set-cookie 后 302 回 `/`。此页是 gateway 唯一自带的前端资源（除 `/chamber/*` 轻面外）。

### 5.2 精确安全不变量（认证面）

1. **暴露护栏**：`plane.host !== '127.0.0.1'` 且 `auth.kind === 'none'` → **启动即失败**（exit 2），
   提示 `--ui-password` / `--api-token`（对齐 OpenChamber `bind-host.js`）。
2. **WS 鉴权 == HTTP 鉴权**：upgrade 走同一个 `auth.verify`，不允许「HTTP 有认证、WS 裸奔」。
3. **Origin 白名单**：`capacitor://localhost`、`https://localhost`（Android WebView 已知坑）、
   `openchamber-ui://app` 等价物显式列入 `corsOrigins`。
4. **登录限流**：密码登录 10 次/5min → 15min 锁；token 校验恒定时间 `timingSafeEqual`。
5. **URL token（SSE/WS 无法带 header）**：60s 短命 token，仅 GET/WS 白名单路径
   （`events.mux/host`、媒体读）；这是移动端 EventSource 的接入口。
6. **凭据永不进 renderer/日志/持久层**：token 只存 hash；认证失败日志只记 `principal.kind`
   与来源 IP，不记 header 值。
7. **Cookie 安全属性（S12）**：session cookie 固定 `HttpOnly; SameSite=Strict; Secure`。
   `Secure` 条件化：直连 loopback 明文可省略，经 https 反代（`x-forwarded-proto: https`）时必带。
   `SameSite=Strict` 是 CSRF 主防线（与 OpenChamber 一致，无 CSRF token）。
8. **全局签退（S13）**：改密码 / 撤销设备时 **rotate jwt-secret** 使已签发的 12h/7d 会话
   一次性全部作废，并同时 clear URL token Map（内存态）。
9. **限流键（S8 补强）**：反代后所有连接 peer 都是 `127.0.0.1`，限流键优先取**受信前置反代**
   的 `x-forwarded-for` 首段；无 IP（头缺失/伪造被拒）时用低配额 no-IP 桶（对齐 OpenChamber
   `RATE_LIMIT_NO_IP_MAX_ATTEMPTS`），防无限重试。

> 认证的**具体密码学参数**（scrypt N/r/p、JWT 过期、盐策略）落地时对齐 OpenChamber
> `ui-auth.js`（已核：scrypt + HS256 + 12h/7d + 0600 secret + `Path=/; HttpOnly;
> SameSite=Strict; Secure`），本文不重复造轮子。

---

## 6. 反代（精确，复用 instance-proxy 的转发核心）

### 6.1 两种反代，各司其职

| 反代 | 路由 | 目标 | 用途 |
|---|---|---|---|
| **gateway-proxy**（新增，主） | `/`、`/plugins/*`、`/api/*`(非管理) | 恒为本地 dsh `http://127.0.0.1:<P>` | **单实例形态**：浏览器/桌面 URL 直接访问本设备 dsh |
| **instance-proxy**（复用，继承） | `/api/i/<id>/*` | local 状态 / transports 注册表 | 从 `createControlPlane` 继承；**gateway 恒不用**（无 transport，命中即 404/503） |

> **单实例澄清（关键）**：gateway = 每台设备一个，只托管**一台** dsh；多设备聚合是
> `packages/desktop` 的职责（桌面端自己的 control-plane + instance-proxy + N-ctx renderer）。
> 所以 gateway 的主反代是 gateway-proxy（`/api/*` → 唯一本地 dsh）；`/api/i/*` 只是继承
> `createControlPlane` 的顺带产物，gateway 内**永不注册 transport**、命中即 404/503，不参与主链路。

### 6.2 gateway-proxy 与 instance-proxy 的关系（避免 fork 的关键）

`gateway-proxy.ts` 复用 `instance-proxy.ts` 的**转发核心**，差异仅两点：
- 目标解析：instance-proxy 解析 `/api/i/<id>` 前缀 + transports 表；gateway-proxy 恒
  指向 `http://127.0.0.1:<localDshPort>`（单目标，无前缀）。
- 路径：gateway-proxy 原样透传（无前缀剥离）。

**落地方式（已定 A）**：
- **A（已定）**：从 `instance-proxy.ts` 抽出共享 `proxy-forward.ts`（`forwardHttp` /
  `forwardUpgrade` + `STRIPPED_REQUEST_HEADERS` / `RESPONSE_HEADER_WHITELIST` /
  `WS_STREAM_PATHS` / 限流常量 / `writeError` / `rejectUpgrade` / WS splice+心跳），
  `instance-proxy.ts` 与 `gateway-proxy.ts` 都 import 它。改动面：`instance-proxy.ts`
  变为「前缀解析 + 目标解析 + 调共享 forward」；行为不变（现有 12+ 单测必须继续绿）。
- **B（MVP 兜底）**：`gateway-proxy.ts` 独立实现 ~80 行（复制同样的 header 改写与
  WS splice），顶部注释标注「与 instance-proxy.ts 的 forwardHttp 保持逐行一致」+ 一个
  锁步单测断言两者关键行为。**不推荐**（维护漂移风险），仅作为 A 的过渡。

### 6.3 精确的 Host/Origin 改写（gateway-proxy 必须逐条做到）

转发到 dsh 时：
1. `host` = `127.0.0.1:<P>`（dsh 的 loopback 权威）。
2. 剥 `STRIPPED_REQUEST_HEADERS`（host/cookie/authorization/connection/content-length/…）。
3. `origin` 改写为 `http://127.0.0.1:<P>`（否则 dsh 栅栏 `new URL(origin).host === host`
   失败 → 403）。
4. WS upgrade：只带 `upgrade/connection/sec-websocket-*`，**不带 Origin**，`host` 同上。
5. 响应头白名单收敛（`RESPONSE_HEADER_WHITELIST`）；WS 响应白名单。
6. 错误/限流/心跳语义与 instance-proxy 完全一致（§2.3）。

**这就是「0.0.0.0 访问 dsh」的完整机制**：浏览器 → gateway(0.0.0.0, TLS, 认证) →
gateway-proxy 改写 Host/Origin → dsh(loopback) 栅栏放行。dsh 零改动、零参数变化。

> **TLS 归属（明确）**：gateway 本体只做明文 HTTP（`0.0.0.0` 或 loopback）。生产 TLS 交给
> 前置 Nginx/Caddy（对齐 OpenChamber `REVERSE_PROXY.md`：WS 透传、SSE 不缓冲、单层压缩、
> 大 body、长超时）；内置 TLS（`--tls-cert/--tls-key`）列为可选，仅当无前置反代时用。
> `0.0.0.0` + 无 TLS + 无认证 = S1 直接拒绝启动。

> **Host 权威判定（S11，0.0.0.0 暴露的关键防线）**：control-plane 现用的 `corsFor`
> 硬性要求 `Host ∈ loopback`，是给**桌面 loopback v1** 写的；gateway 绑 `0.0.0.0` 后合法
> Host 是 LAN IP/公网域名，**不能直接复用**。gateway 需一个「gateway 版 Host 权威判定」，
> 列为第 4 处 control-plane 改动（与 §2.1 ③ 的 server 壳 dispatch 注入一并落地）：
> 1. 允许的 authority 集合 = ① 显式 `publicOrigin`/`corsOrigins`（用户配置的公网域名）∪
>    ② 仅当 socket peer 为 loopback/私网时的请求 Host（含 LAN IP，做 loopback↔127.0.0.1↔::1
>    归一化）∪ ③ packaged origins（`capacitor://localhost` 等）。
> 2. **未知 Host → 403/421**（Misdirected Request），沿用 `corsFor` 已有的「Host 不得带
>    username/password/path/非规范拼写」强化。
> 3. **公网 peer 送来的私网 Host → 拒绝**（`classifyRequestScope` 等价逻辑，防 DNS rebinding；
>    对齐 OpenChamber `tunnel-auth.js`，测试 `core-routes.test.js`「does not trust a private
>    Host header from a public socket peer」）。

> **sec-fetch-site / Fetch Metadata：保留，不剥**。gateway-proxy 的剥离头清单与
> `instance-proxy` 的 `STRIPPED_REQUEST_HEADERS` 一致（本就**不含** `sec-fetch-site`），即
> **有意保留** Fetch Metadata 头——让 dsh 的 `sec-fetch-site: cross-site` 无条件拒绝继续作为
> 纵深防线生效（gateway 已洗白 Origin，这是 dsh 侧剩下的跨站防线）。非浏览器客户端
> （curl/桌面 Node 转发）本就不发这些头，不受影响。

### 6.4 桌面端连 gateway（`gateway` 连接 kind）

桌面端 renderer 反代 `/api/i/gw-<id>/*` → `https://<gateway>/api/*`。完整链路（写死）：

```
renderer → 桌面 control-plane `/api/i/gw-<id>/api/session.list`
  → 桌面 instance-proxy → `https://<gateway>/api/session.list`（注入 Authorization: Bearer <token>）
  → gateway 认证门（verify token）→ gateway-proxy → `http://127.0.0.1:<P>/api/session.list`
    （Host/Origin 改写 + 剥 Authorization/cookie）
```

**`[需改动·精确]`**：桌面 `instance-proxy.registerTransport` 现强制 loopback，且 `forwardHttp`
会**剥** `authorization`（`STRIPPED_REQUEST_HEADERS`）。要支持 gateway kind，需两项改动：
① `registerTransport(connectionId, baseUrl, { headers? })` 增「每 transport 附加头」参数，
   仅 `gateway:` kind 允许非 loopback `https://` baseUrl；② `forwardHttp` 在剥完
   浏览器自带头之后，**再注入**该 transport 的 `headers`（Authorization 等）。token 由
   桌面主进程持有，只出现在 `registerTransport` 调用点，永不进 renderer/注册表/日志。

**认证（MVP 已定：单个共享 token）**：gateway 侧一个固定 bearer token（hash 存储，
0600）；桌面连接 gateway 时在连接表单里填一次，主进程持有、反代注入，不进 renderer/
注册表/日志。每设备可吊销 token 列为 P2 之后的可选增强（对齐 OpenChamber `client-auth`
模型），MVP 不做。

### 6.5 桌面端安装与连接 gateway（完整流程）

**桌面端自身安装不变**：dsh-chamber 桌面仍走现有 GitHub Releases（macOS DMG / Windows
NSIS），安装/更新与 gateway 无关。gateway 是**独立新增包** `packages/gateway`，部署在设备
server 上，不是桌面端的安装变更——桌面端只是**新增一个「gateway」连接 kind**（P2 的代码
改动，非安装方式变化）。

**连接一个 gateway 的流程**：
1. **设备侧部署 gateway**：`gateway serve --host 0.0.0.0 --api-token <共享token>`，用
   systemd 常驻（复用 README 现有远程 dsh 的 systemd 单元写法；`--api-token` 或
   `--ui-password` 至少其一，否则 S1 拒绝启动）。
2. **桌面添加连接**：「设置 → 连接」新增「gateway」类型，填 label / URL（`https://<设备>`）/
   token。
3. **token 驻留**：桌面主进程持有 URL+token；token 镜像到 `<userData>/gateway-tokens.json`
   （0600、原子写，供重启后自动重连），**不进**连接注册表（`gateway-instances.json` 只存
   非秘密投影 label/URL）、不进 renderer、不进日志——对齐现有 ssh-passwords.json 的密码模型
   （设计 05 §8）。
4. **transport**：桌面新增 `gateway` provider（无子进程、无隧道）：
   `resolveEndpoint() = { baseUrl: 'https://<设备>', headers: { Authorization: 'Bearer <token>' } }`；
   探活 = TCP 通 + 经 gateway 的 `host.describe` 回包（复用 `verifyUp` 语义，绝不把非 dsh 冒充
   为已连接）。
5. **就绪后**：N-ctx renderer 经 `/api/i/gw-<id>/*` 反代到 gateway 的 `/api/*`（§6.4 链路）。

**gateway 可达的三种方式**（对应 §7）：① `direct`——设备绑 `0.0.0.0`，桌面/浏览器直连 URL；
② `ssh`——桌面 SSH 到设备 + `ssh -N -L` 端口转发到 gateway loopback（此时 gateway 可绑
loopback，更安全）；③ frp/tailscale/zerotier 用户自管隧道（远期，gateway 侧无动作）。

**P2 桌面侧剩余接线（spec 已定，实现待用户本机验证）**——这是唯一还触碰「已测试代码」的
改动，因沙箱无 node 无法回归，故只给 spec、不做无验证改写：
1. `transport-manager.ts` 现为单 provider（`createTransportManager({ provider: sshProvider })`）。
   改多 provider：deps 增 `providers?: Partial<Record<TransportKind, TransportProvider>>`，
   运行时按 `spec.kind` 解析 `const provider = providers?.[spec.kind] ?? defaultProvider`
   （`validateSpec` 的 `normalized.kind !== provider.kind` 门禁改为按 kind 解析；约 20 处
   `provider.*` 调用点改为经解析后的 provider）。
2. `main.ts`：`createTransportManager({ provider: sshProvider, providers: { gateway: gatewayProvider } })`；
   就绪回调 `registerInstanceTransport('gateway:<id>', url, { authorization: \`Bearer ${getGatewayToken(id)}\` })`；
   并接线 gateway token store（`configureGatewayTokenStore(<userData>/gateway-tokens.json)`）。

### 6.6 server 端安装与部署（gateway + dsh）

**安装 dsh**（不变，README「服务器端部署」）：`npm install -g @deepseek-ai/dsh`，记下
`which dsh` / `which node` 供 systemd 的 `ExecStart`/`PATH` 使用（nvm 陷阱同 README）。

**安装 gateway**（新，`packages/gateway` 打包产物）：
- 开发态：`pnpm --filter @dsh-chamber/gateway build` → `packages/gateway/dist/cli.js`。
- 发布态：`npm install -g @dsh-chamber/gateway` → `gateway` 命令。
- gateway 依赖 `@dsh-chamber/control-plane`（workspace），打包时把 control-plane 产物一并
  打入（同 desktop 打包 dsh 的方式，`electron-builder` 的 `files`/asar 类比）。

**两种运行形态**：
- **托管形态（MVP 推荐）**：gateway 自己 spawn dsh（loopback 子进程，§2.2），只需跑
  `gateway serve`，一个 systemd 单元管两个进程；dsh 的 `$DSH_HOME` 落在 `<stateDir>/dsh-home`。
- **反代形态（可选，后置）**：dsh 已由独立 systemd 跑着（README 现有远程 dsh 单元），
  gateway 只反代（对应 `--no-spawn` 预留 flag，未来扩展为「attach 外部 dsh」）。

**systemd 单元（托管形态，对齐 README 远程 dsh 单元写法）**：
```ini
[Unit]
Description=dsh-gateway server-side access
After=network.target

[Service]
Type=simple
User=<你的用户名>
# gateway 自己 spawn dsh（dsh 恒 loopback）；0.0.0.0 由 gateway 绑
ExecStart=<GATEWAY_PATH> serve --host 0.0.0.0 --port 3000 --dsh-path <DSH_INSTALL_DIR> --api-token <TOKEN>
Restart=on-failure
RestartSec=3
Environment=PATH=<NODE_BIN>:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=DSH_TELEMETRY_DISABLED=1
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

**认证**：`--api-token`（桌面/自动化）与 `--ui-password`（浏览器）可同时配；绑 `0.0.0.0`
时至少其一（S1）。**TLS**：前置 Nginx/Caddy（生产）；或 `--tls-cert/--tls-key`（无前置时）。

---

## 7. 通道注册表（精确接口 + 状态机）

```ts
type ChannelKind = 'frp' | 'tailscale' | 'zerotier' | (string & {})   // 仅「gateway 可托管的隧道 provider」；direct/ssh 不是通道
type ChannelHealth = 'unknown' | 'starting' | 'ready' | 'reconnecting' | 'failed'

interface ChannelProvider {
  readonly kind: ChannelKind
  start(instance: ChannelInstance): Promise<void>   // 幂等；起 frpc/tailscale up/ssh -N -L…
  stop(instance: ChannelInstance): Promise<void>    // 幂等
  resolveEndpoint(instance: ChannelInstance): { baseUrl: string; headers?: Record<string,string> } | null
  probe(instance: ChannelInstance): Promise<boolean> // 探活（TCP + 可选 dsh host.describe）
}

interface ChannelInstance {
  id: string              // 'ssh-<id>' / 'frp-<id>' / ...（通道实例 id，不含 direct）
  label: string
  kind: ChannelKind
  config: Record<string, string>   // 通道私有配置（frp 服务器/端口、tailscale hostname…）
}

interface ChannelRegistry {
  register(provider: ChannelProvider): void
  start(instance: ChannelInstance): Promise<void>
  stop(instance: ChannelInstance): Promise<void>
  resolve(instance: ChannelInstance): { baseUrl: string; headers?: Record<string,string> } | null
  health(instanceId: string): ChannelHealth
  list(): Array<{ instance: ChannelInstance; health: ChannelHealth; endpoint: string | null }>
}
```

**MVP 现状（避免过度设计，写死）**：
- 接入方式只有两条：① **浏览器/桌面直连 gateway 的 `0.0.0.0`**（`direct`，就是 config 层
  的 `host==='0.0.0.0'`，**不是通道、不进 ChannelKind/channels[]**）；② **桌面 SSH 直连 dsh**
  （chamber 现有 `ssh-provider`，桌面端行为，gateway 侧无动作、不经过 gateway，**也不是通道**）。
- `ChannelProvider`/`ChannelRegistry` 接口是**远期**抽象（gateway 托管 frp/tailscale/zerotier
  子进程，或记录「用户自管隧道」的探活状态），**MVP 不实现任何 provider**，只留类型占位
  （对应 D3「留接口」）。因此 MVP 下 `channels[]` 恒为空。

**设计要点（写死，避免偏差）**：
1. **认证与通道正交**：channel 只负责「把 endpoint 变成可达 URL」；到达后的认证由
   gateway 的 `AuthProvider` 统一做。frp/tailscale/zerotier **不实现协议**，只 spawn/
   探活外部二进制并报可达 URL。
2. **`direct` 与 `ssh` 都不是 provider**：`direct` = `config.host==='0.0.0.0'`（gateway 自身
   监听，`resolveEndpoint()` 恒返回 `{baseUrl:'http://<bind>:<port>'}`，无 start/stop）；
   `ssh` = 桌面端现有 `ssh-provider`（SSH 到设备 + `ssh -N -L` 端口转发到 dsh/gateway
   loopback）——**gateway 侧无动作、不托管 ssh**。二者都不进 `ChannelKind`。
   `frp/tailscale/zerotier` 才是远期 provider，只留类型占位 + 文档说明「用户自管常驻服务更稳」。
   **注意**：这些 provider 都是「把 gateway 的 loopback 端点经外部隧道转发出去」，gateway
   本体恒 loopback 或 0.0.0.0 监听，**从不实现隧道协议本身**。
3. **所有通道收敛到同一契约** `{baseUrl, headers?}`：桌面端与浏览器消费同形状，加新
   通道 = 加一个 provider，不动 gateway 内核。
4. **探活语义**：`ready` = probe 通过（TCP 通 + host.describe 回包）；`reconnecting` =
   上一次 ready 后 probe 失败且仍在重试；`failed` = 超过退避上限（错误不永久化——对齐
   chamber 的两阶段重连语义）。liveness 只来自 live probe，绝不来自持久化状态。

---

## 8. feature host（编排层，精确数据流）

> feature host 全部用 §2.5 的 `call/respond/openEventStream` **直连 dsh loopback**
> （`http://127.0.0.1:<P>`，**不经 gateway-proxy**，避免自反代）驱动 dsh `/api`，+ 同 OS
> 用户直接 fork git/文件操作。dsh 零改动。

### 8.1 git worktree offload（用户例，完整流程）

**数据模型**（gateway 侧，不进入 dsh）：

```ts
interface WorktreeRecord {
  id: string; workspaceId: string; path: string; branch: string
  sessionId?: string; state: 'creating' | 'ready' | 'deleting' | 'failed'
  error?: string; createdAt: number
}
```

**创建流程（精确步骤 + 错误处理）**：

```
1. call(dshBase, 'workspace.list', {})                     → 拿工作区列表（路径/归档集）
   失败：RpcBusinessError → 500 workspace_list_failed（回显 code，不回显内部路径）
2. resolve 主工作区路径（从 step1 的 WorkspaceView.path）
3. spawn 'git', ['-C',<repo>, 'worktree','add','-b',<branch>, <newPath>]（shell:false）
   失败：非零退出 → 500 git_worktree_add_failed（回显 stderr 尾部，截断）
4. ws = call(dshBase, 'workspace.create', { path: <newPath> })   → 取返回值 WorkspaceView.id
   失败：RpcBusinessError → 补偿：git worktree remove <newPath>（best-effort），500
5. call(dshBase, 'session.create', { workspaceId: ws.id, agentPreset?, ... })   // 用 workspaceId 获得归属分组语义
   失败：RpcBusinessError → 补偿：workspace.delete + git remove（best-effort），500
6. 写 WorktreeRecord（json-store，state:'ready'）
```

**删除流程（git-first 事务，对齐 chamber design 08 语义）**：拒绝主工作树 / dirty /
locked / 运行中目标；不归档会话、不 force、不删分支；`workspace.delete` + git remove。

**✅ 已核对（P0-1，2026-08，纯只读）**：**A，纯 `/api` 可完成，无需 host Remote 兜底**。
证据（`deepseek-harness/packages/host/apiproxy/src/api/{workspace,sessions}.ts` + `api-proxy.ts`）：
`WorkspaceView.path` 存在（canonical 目录路径）；`workspace.create({path})` 接受任意**已存在**目录
（git worktree add 先建目录，满足）；`session.create({workspaceId?, cwd?, sessionId?, agentPreset?})`
的 `cwd` 为任意目录、host 侧甚至 `mkdir(cwd,{recursive})`；`workspace.list` 返回
`{items, archivedSessionIds}`，归档是 session 级、不影响 worktree 删除。**结论：D5 的兜底 host
Remote 不需要；git/编排 offload 的可行性成立。**

**两条流程修正（据核对）**：① 步骤 4 的 `session.create` 应传 `workspaceId`（取自步骤 3
`workspace.create` 返回值）而非 `cwd`，以获得「归属该 worktree 的 workspace」分组语义；
② `newPath` 从 `workspace.list` 返回的 canonical（realpath）路径派生。

**兜底注入的失败保障（已定，回答「能否自动注入失败回滚」）**：该只读 host Remote 走
与 `dsh-host-client-graph` 完全相同的 `host-graph-seed.ts` 注入路径，语义逐条继承：
1. **幂等**：content-hash 一致跳过，重复注入不改写。
2. **原子**：0600 + `tmp/rename` 原子写，绝无半写文件。
3. **内容门控**：`dist/index.js` 缺失 → 跳过注入，spawn 保持 baseline 命令行（不挂
   `--patch`，不挂坏行）；present 但损坏（缺 package.json）→ **启动即抛错**，绝不静默。
4. **自愈**：每次 spawn 前重跑 seed，被 profile 内 pnpm 操作剪掉的包会自动重新 seed。
5. **fail-loud 而非静默回滚**：seed 的包行在宿主 boot 无法解析 → **dsh boot 响亮失败**
   （shipped-but-broken = 打包 bug，必须暴露，不是悄悄跳过继续跑）。手动删除
   `--patch` 行/包即回到 baseline。
6. **爆炸半径最小**：该插件只读（只暴露事实，不写、不执行），git 本体在 gateway；即使
   坏，也只会让 boot 失败或该 Remote 调用报错，不会在 dsh 内产生文件副作用。

即：**能保证「注入失败要么干净地不注入、要么响亮失败」，且可手动回滚；但不做「自动
删坏插件继续启动」**——后者会掩盖打包 bug。

> **与 design 08 的关系（取代标注，暂缓执行）**：本 §8.1 的 gateway git offload **取代** design 08 的
> chamber-bundled git 插件路线（`dsh-chamber-host-git-worktree` + `dsh-chamber-client-ui-git`
> 退役）。这是对 08 的一次路线变更（git 从「dsh 插件」迁到「gateway 编排」）。
> **决策（2026-08，用户拍板）**：在 gateway 合并主分支、整体稳定之前**不退役**现有 git 插件——
> control-plane 继续 seed `host-git-worktree`，两套并行走；等功能迁移完成、稳定后再做退役
> 标注与 08 同步，不得静默漂移。

### 8.2 会话索引（只索引，不消费帧）

```ts
// 订阅两条流（都直连 dsh loopback）：
//   openEventStream(dshBase, '/api/events.mux')  → session/subscribed、session/projection（sessionListMetadata/imageLimits；标题另走 session.list 或 rename 投影）
//   openEventStream(dshBase, '/api/events.host') → host/session-added、host/workspace-changed、running 状态翻转
// 只消费这些「控制/投影帧」，绝不解析 session/event 正文（那是 dsh 前端 runtime 的事——chamber 纪律）
```

索引产物：`session.list` 摘要 + 每会话 `title`/`updatedAt`/`blank`，供 gateway 的通知/
调度/移动轻面用。**权威始终是 dsh 的 `session.list`**，gateway 索引只是派生缓存，dsh
重启后重放重建，绝不覆盖权威。

### 8.3 通知 + 自动审批（用 respond）

```ts
// events.mux 的 answerable 帧（rpcId = 该 ServerRequest 信封自身的 rpcId，回响它）：
//   approval/requested {sessionId, approvalId, toolName, callId?, reason?}
//   question/requested {sessionId, questions}
// 自动审批（配置驱动）：
//   respond(dshBase, { rpcId: frame.rpcId, result:{ value:{
//     sessionId, approvalId, outcome:'allowed-once'|'rejected' } } })
// 人工审批：转发到 /chamber/approvals SSE（gateway 轻面），用户点后 respond（echo frame.rpcId）
```

### 8.4 cron 调度（`/chamber/schedule`）

调度器（gateway 自有，存 json-store）+ 到点 `call(dshBase,'session.prompt',{...})`。
**与 dsh `ctx.schedule` 的边界**：dsh 的 schedule 是「会话内后续回合」，gateway 的
cron 是「跨会话的周期触发」，两者不重叠、不互斥。

### 8.5 编排功能的界面（已定：gateway settings + 桌面按 server 加载）

编排配置（git/连接/通道/通知/调度）**不进 dsh 侧边栏**，而是：

1. **gateway 自带 settings 面**：浏览器访问 gateway 时，`/chamber/settings` 提供这些
   编排配置的编辑页（gateway 自己的 settings 文档，与 dsh 的 settings 无关）。
2. **桌面 chamber 按 server 加载**：dsh-chamber 连接 gateway 后，把 gateway 当作一个
   server，**将其 settings（编排配置）加载进本地的 settings 列表**——与现有 chamber
   对每个实例 settings 的「按实例权威、加载进设置页」处理方式一致（`01-overview §2 P2`）。

即：编排配置的**权威在 gateway**；桌面端和浏览器都是「读/写 gateway 的 settings 面」，
不各自维护副本。gateway 的 settings 走自己的 REST（`/chamber/settings.*`），格式对齐
chamber 现有 settings 面的投影（namespace/revision/冲突语义可复用 `json-store`）。

**`/chamber/*` 端点全表（gateway 自有编排面，全部需认证）**：

| 路径 | 方法 | 功能 | 数据源 |
|---|---|---|---|
| `/chamber/settings` | GET/PUT | 编排配置读写（git/连接/通道/通知/调度） | `gateway/settings.json`（json-store） |
| `/chamber/git/worktrees` | GET/POST/DELETE | git worktree 列表/创建/删除（§8.1） | `gateway/worktrees.json` + dsh `/api` |
| `/chamber/channels` | GET | 通道列表/状态（§7，MVP 空） | `gateway.json` channels[] |
| `/chamber/approvals` | SSE + POST | 审批/提问推送 + 人工回答（§8.3） | dsh `events.mux` + `/api/respond` |
| `/chamber/schedule` | GET/POST/DELETE | cron 调度（§8.4） | `gateway/schedule.json` |
| `/chamber/notifications` | SSE | 通知推送（§8.3） | dsh `events.mux` |
| `/chamber/manifest.webmanifest` | GET | PWA manifest（§9，远期） | 静态 |
| `/chamber/sw-register.js` | GET | service worker 注册（§9，远期） | 静态 |
| `/chamber/mobile.html` | GET | 移动轻面（§9，远期） | 静态 |

> `/chamber/connections` **不单独设**——gateway 单实例，本地 dsh 的 connection 走 control-plane
> 的 `/api/connections`（复用）；「通道」才是 gateway 自有的编排实体。

---

## 9. 前端中间件（HTML 注入，精确注入点）

gateway 反代 `/` 拿到 dsh 的 index.html 后，在返回浏览器**之前**注入（dsh 零改动）：

| 注入点 | 内容 | 触发条件 |
|---|---|---|
| `<head>` 首部 | `<meta name="viewport" content="width=device-width, initial-scale=1">` | 恒注入（dsh 已有，幂等去重） |
| **所有 `<script>` 标签** | **回填本次响应的 CSP nonce（`nonce="<n>"`）**，否则 per-response nonce-CSP 会阻断 dsh 前端的内联/loader 脚本（S14） | 恒注入（启用 CSP 时） |
| `<head>` 尾部 | PWA `<link rel="manifest" href="/chamber/manifest.webmanifest">` + `<meta name="theme-color">` | `ui.pwa===true` |
| `</body>` 前 | `<script src="/chamber/sw-register.js" defer>`（service worker 注册，iife） | `ui.pwa===true` |
| `<head>` 内 | 编排入口链接（`/chamber/` 导航，可选） | `ui.shellNav===true` |

注入用 `Buffer` 字符串替换（`</head>`/`</body>` 锚点），与 control-plane 现有
`serveStatic` 的 `__DSH_BOOT__` 注入同款手法（`index.ts:574-577`）。**不注入任何脚本
到 dsh 的模块系统**（那是 `__DSH_BOOT__`/`__ModuleLoader__` 的事，gateway 只在 HTML
层做浏览器增强）。

**UA 分流（远期，P4）**：`mobile` UA → 网关可返回 `/chamber/mobile.html`（移动轻面）；桌面
UA → 完整 dsh 前端。**MVP 只做 viewport 恒注入；PWA 与 UA 分流都属远期（P4）**——§9 表格里
`ui.pwa`/`ui.shellNav` 触发的行不在 MVP 范围内。

---

## 10. 数据模型与持久化（gateway 自有，与 dsh 严格分离）

`<stateDir>/`（gateway 的 state，默认 `~/.dsh-chamber` 复用 control-plane 约定）：
```
stateDir/
├─ dsh-home/                    # dsh 的 $DSH_HOME（复用 control-plane，不混 gateway 数据）
├─ managed-dsh/                 # pid 记录（复用）
├─ gateway.json (+.bak/.tmp)    # gateway 文档：channels/devices（json-store）
├─ tokens.json (+.bak/.tmp)     # 设备/API token（只存 hash，0600）
├─ jwt-secret                   # 会话签名密钥（0600）
└─ gateway/                     # 编排私有：settings.json / worktrees.json / schedule.json / index.json
```

```ts
interface GatewayDocument {
  schemaVersion?: number
  revision?: number
  channels: ChannelInstance[]       // §7（暴露通道；MVP 恒空，因 direct/ssh 都不是通道）
  devices?: DeviceRecord[]          // 后置：每设备可吊销 token（{id, label, platform, tokenHash, createdAt, revokedAt?}）
}
```

> 本地 dsh 的「connection」行在 control-plane 的 `catalog.json`（connectionId `'local'`），
> **不在 `gateway.json`**——gateway 单实例，不维护自己的 connections 数组；多实例是桌面端的
> 概念（chamber catalog + desktop registry）。

**持久化纪律（写死）**：全部走 `createJsonStore`（backup-first + revision + 恢复态）；
token 只存 hash；`jwt-secret`/`tokens.json` 0600；dsh 的 `$DSH_HOME` 与 gateway 的
`stateDir` **物理分离**，gateway 对 dsh 事实永不权威（索引是派生缓存）。

> **json-store 的 dropped 形状（落地注意）**：`createJsonStore` 的 `onLoadValidate` 返回的
> `dropped` 硬编码为 `{connections, projects}`（chamber catalog 专用）。gateway 的域
> （channels/devices）不匹配——MVP 采用「gateway 自己校验、store 只当原子读写用」；
> 若日后想通用化，把 `JsonStoreDroppedCounts` 改为可扩展 shape，属可选 control-plane 改动。

---

## 11. 安全不变量（编号，每条带强制点）

| # | 不变量 | 强制点 |
|---|---|---|
| S1 | `plane.host !== '127.0.0.1'` 且 `auth.kind === 'none'` → 启动失败 exit 2 | `config.ts` 校验 |
| S2 | WS 鉴权 == HTTP 鉴权 | `upgrade` 事件先 `auth.verify` |
| S3 | Host/Origin 改写逐条对齐 instance-proxy（§6.3） | `gateway-proxy.ts` + 锁步单测 |
| S4 | 反代失败显式：无 tunnel/未就绪 → 503，绝不伪装空成功 | 复用 instance-proxy 语义 |
| S5 | 凭据不进 renderer/日志/持久层（token 只存 hash） | `auth.ts`/`store.ts` + 日志审查 |
| S6 | 网关管理路由白名单，其余 `/api/*` 透传（§4） | `routes.ts` 固定白名单 |
| S7 | `registerTransport` 的 `gateway` kind 才允许 https 非 loopback + token | `instance-proxy.ts` `[需改动]` 收紧 |
| S8 | 登录限流 + 恒定时间比较 + URL token 短命白名单 | `auth.ts` |
| S9 | 通道 liveness 只来自 live probe，绝不来自持久化 | `channels.ts` |
| S10 | 编排补偿：git 步骤失败 best-effort 回滚（§8.1） | `features/git.ts` |
| S11 | gateway 版 Host 权威判定：未知 Host / 公网 peer + 私网 Host → 403/421；合法 authority 只来自 `publicOrigin`/`corsOrigins` ∪ 私网 peer 下的 Host ∪ packaged origins | `config.ts` + 请求入口（§6.3） |
| S12 | session cookie 固定 `HttpOnly; SameSite=Strict; Secure(条件化)`（CSRF 主防线 + 防 XSS 窃取） | `auth.ts`（§5.2） |
| S13 | 改密码/撤销设备 ⇒ rotate jwt-secret ⇒ 全员签退 + clear URL token Map | `auth.ts`（§5.2） |
| S14 | 反代 dsh HTML 必须回填本次响应的 CSP nonce，否则不得下发 nonce-CSP（防前端白屏） | `middleware.ts`（§9） |
| S15 | `/api/i/<id>/*` 的 `id` 只能命中 transports 注册表已注册的 connectionId，绝不把 `id` 拼成 URL | `instance-proxy.ts`（复用其既有 resolveTarget 语义） |

---

## 12. 分阶段执行计划（每阶段含交付物 + 验收标准）

### P0 验证（不做产品，只做两个阻断性核对）
- **交付**：`gateway-proxy.ts` 最小原型 + 一段 `call(dshBase,'workspace.list',{})` 探针脚本。
- **验收**：① `workspace.list`/`session.create` 事实面是否够 git offload（§8.1），输出
  核对结论；② 反代 Host/Origin 改写后 dsh 栅栏放行（实际 curl 过 gateway → dsh，
  确认非 403）。

### P1 L0（核心：0.0.0.0 访问 dsh）
- **交付**：`packages/gateway` 骨架 + `auth.ts`（password/none）+ `gateway-proxy.ts`（方案 A
  抽出 `proxy-forward.ts`）+ `config.ts` + CLI 入口 `gateway serve --host 0.0.0.0 --ui-password …`。
- **验收**：`http(s)://<设备>/` 打开 dsh UI；`/api/session.list` 经 gateway 返回；未登录
  打 `/api/*` 得 401；`bind=0.0.0.0` 无密码启动失败 exit 2；`instance-proxy` 现有 12+ 单测
  仍绿（抽取无回归）。

### P2 L1（多设备，可选/后置）
- **交付**：`registerTransport` 放宽（`gateway` kind，§6.4）+ 桌面 `gateway` provider +
  `channels.ts` 类型占位（不实现 provider）。**不含** `packages/transport` 抽取（gateway
  不跑 SSH，桌面 `ssh-provider` 保持原位）。
- **验收**：桌面连 gateway（URL+token）与 SSH 直连 dsh 两种方式都能在 N-ctx 里开同一台
  dsh；token 只在桌面主进程，不进 renderer/日志。

### P3 L2（feature host）
- **交付**：`features/git.ts`（创建/删除 + 补偿）+ `features/index.ts` + `features/notify.ts`
  + `features/schedule.ts` + `/chamber/*` 路由与轻面。
- **验收**：gateway 建 worktree→workspace→session 闭环；dsh 内**无** git host/client 插件
  （`dsh-chamber-host-git-worktree`/`dsh-chamber-client-ui-git` 退役）；审批帧经
  `/chamber/approvals` 可 answer；cron 到点触发 prompt。

### P4 L3（前端中间件，远期）
- **交付**：`middleware.ts` viewport/PWA 注入 + `/chamber/manifest.webmanifest` + sw。
- **验收**：手机浏览器可安装 PWA、视口正常；UA 分流（移动轻面）作为独立后续。

---

## 13. 决策日志（已定 + 待执行）

| # | 决策 | 结论 | 依据 |
|---|---|---|---|
| D1 | 前端复用方式 | **单实例反代 `/`**（gateway-proxy 透传 dsh 前端） | 用户拍板（复用 dsh UI 加载自定义插件前端） |
| D2 | 认证 MVP 范围 | **浏览器 = password + none**；**桌面连 gateway = token（单个共享）**；passkey/每设备 token/配对后置 | 用户「认证后置」+ D7 |
| D3 | 通道 MVP 范围 | **direct + ssh**；frp/tailscale/zerotier 留接口 | 用户「从 chamber 出发，支持 ssh」 |
| D4 | 反代复用 | **抽共享模块 `proxy-forward.ts`**（方案 A） | 用户选「抽成共享模块」 |
| D5 | git 事实面不足兜底 | **极薄只读 host Remote**（先例 host-client-graph）；注入沿用 host-graph-seed 的幂等/原子/门控/自愈/fail-loud 语义（§8.1） | 用户认可方案 1，前提是注入失败有回滚保障 |
| D6 | 编排功能界面 | **gateway 自带 settings 页** + **桌面 chamber 连接后按 server 把 gateway settings 加载进本地 settings 列表**（同现有 per-instance settings 处理） | 用户指定（§8.5） |
| D7 | 桌面连 gateway 认证 | **单个共享 token**（MVP）；每设备可吊销 token 后置 | 用户选「单个共享 token」 |
| D8 | `registerTransport` 放宽 | 加 `{ headers? }` 参数 + 允许非 loopback https；仅 `gateway:` kind 生效（§6.4） | 待执行（实现细节，未定名） |
| D9 | server 壳抽取 | 从 `createControlPlane.start()` 抽出 server 壳 + **可注入 dispatch**（推荐）；或 gateway 绕过 `createControlPlane` 直接 compose `local-connection`/`api`/`instance-proxy` 自建 server | 待执行（推荐前者，§2.1 改动 ③） |

---

## 14. 验证清单（对齐 chamber 现有验证约定）

- **复用回归**：`pnpm run test`（control-plane 现有 protocol/storage/m1-dsh-client/
  host-logs/manager-api/instance-proxy/static-serving/host-graph-seed）在抽 `proxy-forward.ts`
  后必须全绿。
- **gateway 新增单测**：`auth.ts`（verify/登录限流/恒定时间/token hash）、`config.ts`
  （暴露护栏 S1）、`gateway-proxy.ts`（Host/Origin 改写与 instance-proxy 锁步、错误码、
  WS splice）、`channels.ts`（direct/ssh 探活状态机）、`features/git.ts`（创建/删除/补偿）。
- **typecheck**：gateway 入 typecheck 面（加 `typecheck:gateway`，对齐 root typecheck 不含
  自建插件/新包的约定；gateway 不引入 transport，无 `typecheck:transport`）。
- **build**：`pnpm run build:renderer` 不受影响（gateway 不碰 renderer）；gateway 自身
  tsc/tsdown。
- **冒烟**：`gateway serve` 起本地 dsh → curl `/health`、`/api/session.list`（带/不带 token）。
- **安全**：日志 grep 无 token/密码/内部路径；`jwt-secret`/`tokens.json` 权限 0600。

> 静态检查不证明运行时/认证/协议正确；P0 的两项核对 + P1 的 curl 冒烟是唯一的运行时证据。

---

## 15. 相关文档

- 本仓：`01-overview.md`、`03-connections-proxy.md`（instance-proxy）、`05-connection-manager.md`
  （TransportProvider direct-endpoint §7.6）、`08-git-worktree-plugin.md`、`09-client-plugin-runtime-loading.md`。
- 上游：`deepseek-harness/packages/host/apiproxy/src/api/*`（`/api` 契约）、
  `deepseek-harness/packages/client/connection/src/api-request-trust.ts`（信任栅栏）、
  `OpenChamber/packages/web/server/lib/{ui-auth,bind-host,proxy}.js`（认证/暴露/反代范式）。
