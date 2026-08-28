# 17 · 服务端接入层（Gateway）与远程连接模型

> 状态：**重写（2026-09，连接模型 v2）**。本版把「远程连接」提升为一等设计面，核心是
> **四维正交模型**：目标类型（dsh/gateway）× 传输方式（ssh/http）× 认证（可空
> token/密码）× 通道（服务器侧 frp/tailscale/zerotier 槽位）。http 明文直连与无认证
> 接入登记为**用户决策有界偏差**（客户端不前置校验，服务器为认证权威）。安全增强按
> 行业最优实践逐项评估：OS keychain（safeStorage）与证书固定（SPKI pin）**集成**，
> mTLS 与每连接网段策略**预留槽位**，访问审计**集成轻量版**（§13.4）。
>
> 原 design 01 的编排规则不再作为本设计依据（已过时部分不引用）；本设计自包含。

## 1. 定位与边界

`packages/gateway` 是 dsh-chamber 仓库内一个**显式启动、可认证**的服务端形态：

1. 托管一份始终监听 loopback 的本地 dsh；
2. 在认证、Host/Origin 和资源边界后反代 dsh 官方 Web 前端与 `/api`；
3. 允许 Desktop 以 gateway 连接（http 或 https、可空认证）接入该入口；
4. 在独立的 `/chamber/*` 面提供有限的服务端编排（dsh 运行时管理、索引、通知、
   调度、Git worktree）。

它不是普通 control-plane 的公网开关。普通 Desktop control-plane 仍保持 loopback-only、
匿名、只负责连接管理与同源反代。Gateway 的网络能力只在 `packages/gateway` 被显式
运行时存在。

### 1.1 传输安全责任划分（本设计的总原则）

- **Gateway 与桌面端都只提供 HTTP 语义**；HTTPS、穿透、隧道全部由**用户自建**（TLS
  反代 / tailscale / SSH 隧道 / frp / zerotier，任选或组合）；
- 客户端对弱模式（http 明文、无认证）**不前置拦截**，但**如实注明**：配置时的安全
  姿态提示 + 连接卡片的常驻徽标 + 文档的责任划分；
- `--no-auth` 完全由**服务器侧**校验与授权（S1 有界偏差），客户端不做模式选择、
  不做推断、不做二次确认——空凭据 = 不带认证直接请求，由 gateway 决定放行或 401。

## 2. 远程连接模型（四维正交）

```
┌──────────────────────────────────────────────────────────────────┐
│ 目标类型 kind ── dsh │ gateway │ (future: 开放联合)               │
│ 传输方式 transport ── ssh │ http │ (future: 开放联合)             │
│ 认证 auth ── none │ token │ password │ token+password             │
│             （凭据存在性的实时投影，非模式选择）                   │
│ 通道 channel（服务器侧）── direct │ (future: frp/tailscale/…)     │
└──────────────────────────────────────────────────────────────────┘
```

四维全部正交、全部开放联合 + 注册表驱动；新增任何一维的取值都只触碰对应槽位，
核心运行时与反代零改动（槽位总表见 §14）。

### 2.1 目标类型（kind）

| kind | 目标 | 认证面 | source id | 反代路径 |
|---|---|---|---|---|
| `dsh` | dsh web profile（loopback-only，无认证） | 无 | `dsh-<id>` | `/api/i/dsh-<id>` |
| `gateway` | gateway 部署（有认证面与 `/chamber/*` 面） | 可空 token/密码 | `gateway-<id>` | `/api/i/gateway-<id>` |

kind 决定**目标语义**：dsh 目标永不注入认证头、永不挂载 `/chamber/*` 能力；gateway
目标可注入认证头、可挂载全部 gateway 能力（§3）。

### 2.2 传输方式（transport）

| transport | 机制 | 适用目标 | 认证注入 |
|---|---|---|---|
| `ssh` | SSH 隧道子进程（共享 ssh-tunnel 模块）+ systemd exec | dsh（默认 30800）/ gateway（默认 30801） | dsh 目标禁；gateway 目标可 |
| `http` | direct endpoint：http(s) 直连，无子进程 | dsh（穿透用户自建）/ gateway | dsh 目标禁；gateway 目标可 |

- **Provider 按 transport 注册**（`providers: { ssh: …, http: … }`），spec 内的 kind
  决定目标语义（verifyUp 是否带认证、能否注入头）——新增一个传输 = 一个 provider，
  同时服务两种目标；
- **UI 槽位**：连接设置插件内维护 transport 表单 schema 注册表——每个 transport 声明
  自己的字段集/校验/提示（ssh 字段组 vs URL 字段组），表单按注册渲染；新增 transport
  只需加 schema + locales，表单骨架零改动；
- **迁移**：旧 `kind:'ssh'` 条目载入时映射为 `{kind:'dsh', transport:'ssh'}`；
  旧 `kind:'gateway'` 条目映射为 `{transport:'http'}`；source id 的 `ssh-` 前缀保留
  legacy 兼容映射（deep link 可用）。

### 2.3 认证模型（可空、不前置、服务器权威）

- **输入**：gateway 目标下 token 与密码两个**独立可空**输入框；dsh 目标无认证字段；
- **语义**：填 token → `Authorization: Bearer`；填密码 → 主进程 `POST /login` →
  持有 12h JWT cookie（`dsh_gateway_session`，HttpOnly，仅 HTTPS 边界附加 Secure）→
  反代注入 `Cookie` 头；**都空 → 无认证头直接请求，由 gateway 校验**（`--no-auth`
  部署直接放行；要求认证的部署回 401，客户端如实分类上报，见 §7.3）；
- **认证不是模式**：spec 不存 auth 模式；凭据存在性（`tokenSet`/`passwordSet`）
  与存储模式（`secretStorage`：`'safeStorage' | 'plaintext'`，S22）是主进程凭据
  存储的**实时非秘密投影**（`instances_get` 读时合并），用于 UI 显示「已配置」、
  卡片徽标与明文回退提示；
- **槽位**：认证 = 可注入头白名单（现为 `Authorization` + `Cookie` 两项，逐项校验）+
  会话管理器接口；未来 passkey（服务器 auth.ts 联合已含）/OIDC/客户端证书 = 增加头项
  或会话实现，反代与 UI 机制不变。

### 2.4 通道（服务器侧暴露面，channel）

- `direct`（bind 0.0.0.0/127.0.0.1）与桌面 ssh 隧道**不是通道**，不进 ChannelKind；
- `ChannelRegistry`（`packages/gateway/src/channels.ts`）已定型：
  `ChannelKind = 'frp' | 'tailscale' | 'zerotier' | (string & {})`，
  `ChannelProvider { start/stop/resolveEndpoint/probe }`；MVP 零实装，
  `/chamber/channels` 恒空、活性永远来自 live probe（S9）；
- **发现流槽位**（未来）：桌面可经认证的 `/chamber/channels` 列出通道、请求启动并
  解析端点，自动填充连接表单——接口已定义，本期不实装。

## 3. 能力差异与设置挂载（gateway vs dsh 直连）

**依赖 gateway 的功能（dsh 运行时管理、编排、通知/审批）只能经 gateway 连接触达；
直连 dsh（无论 ssh 隧道还是 http 直连）物理上不存在 `/chamber/*` 面，无法挂载。**
settings-bridge 按来源 kind 装配子 ctx，同一设置页对不同来源显示不同分区：

| 能力 | dsh（ssh 隧道） | dsh（http 直连） | gateway |
|---|---|---|---|
| dsh-runtime 设置分节（design 18 §3.6） | 挂载，**版本只读**投影 | **不挂载**（无管理面、无 ssh 通道、无 `/chamber`） | 挂载，**代理 `/chamber/runtime`** 全功能（status/versions/select/apply/rollback/restore-builtin/registry/restart） |
| 重启 dsh 动作 | `restart_service`（systemd IPC） | 无 | `/chamber/runtime/restart`（事务化受控重启，刷新插件挂载） |
| 网关编排入口（settings-bridge 导航） | 不挂载 | 不挂载 | 挂载：git/notifications/schedule 功能开关、待处理审批/提问、channel 投影、修订号 |
| 通知与审批转发 | 无 | 无 | 有（`/chamber/notifications`、`/chamber/approvals`，poll/SSE） |
| 派生会话摘要（sidebar 分组） | 无（会话业务由 dsh 前端直接呈现） | 无 | 有（索引经事件流重建，绝不消费会话正文） |
| 跨会话调度 | 无 | 无 | 有（`/chamber/schedule`，默认关闭） |
| Git worktree 编排 | 无（design 08 实例内插件为迁移期并行路线） | 无 | 有（`/chamber/git/worktrees`，默认关闭） |

装配规则（design 17 契约）：**gateway 连接** → 额外挂载上述全部 gateway 能力分区，
路径由 canonical `gateway-<id>` 派生为 `/api/i/gateway-<id>/chamber/*`（同源代理，
token 永不出主进程）；**dsh 直连** → 只挂 dsh 自身能力，任何 `/chamber/*` 请求
必须稳定返回 404/403 且不伪装。各资源独立失败，单一路由错误不抹掉其他已加载数据。

## 4. 组合架构与生命周期

```text
Browser / Desktop
        │ HTTPS/HTTP（用户自建：TLS 反代 / tailscale / SSH 隧道 / frp）
        ▼
Gateway request policy ── auth ── fixed route dispatch
        │                         ├─ /chamber/* → feature host
        │                         ├─ management → control-plane API
        │                         └─ dsh UI/API/WS → gateway proxy
        ▼
managed dsh (127.0.0.1:<dynamic port>)
```

`createGateway()` 组合而不复制以下核心：

- `createControlPlane()`：HTTP server 壳、本地 dsh 托管、管理 API、实例代理；
- `proxy-forward.ts`：HTTP/WS 转发、限额、头收敛、流生命周期；
- `dsh-client.ts`：unary RPC、answer receipt、两条 WebSocket 事件流；
- `createJsonStore()`：备份优先、原子写、revision 和损坏恢复。

control-plane 的非 loopback 能力是显式 capability：同时提供 Gateway 的 HTTP middleware、
upgrade middleware 和 CORS evaluator 才能越过 loopback 构造门。

### 4.1 启停顺序

启动成功必须满足完整链路，而不只是监听端口：

1. 校验 materialized config，拒绝 JS 调用者绕过 CLI 安全门；
2. 打开 Gateway/control-plane server；
3. 注册本地状态订阅；
4. 执行 dsh 运行时启动事务（design 18 §9.3）：残留 install 清理 → 逐出 →
   interrupted-restore 幂等补完 →（有 pending 时）快照 `<stateDir>/dsh-home`
   → 原子切指针 → 经 `startLocal()` spawn 候选（`canExposeLocal` 隔离）→
   全量只读探针 + ≤60s 窗口 + 延迟裁决；无 pending 时仅清理/补完；
5. 探针裁决通过后等待 dsh `ready`；
6. 仅在 `ready` generation 启动索引、通知和 scheduler；
7. 任一步失败都会停止已打开的 server，下一次 `start()` 可重试。

停止时先回收 runtime install 子进程（design 18 §9.3），再关闭 Gateway 自有
WS/feature consumers，最后停止 control-plane 与 managed dsh。
dsh 从 ready 离开时 feature host（**dsh 派生** consumers：index/notify/scheduler/git）
立即 detach；scheduler 保留定义但清除 timer，下一代 ready 后重新 arm。**例外**：
`/chamber/runtime` 是 gateway 自有 runtime 控制器（挂在 dispatch 面，不随 ready
detach）——dsh 停机/重启/applying 窗口内必须持续可轮询进度（design 18 §9.3）。

## 5. 配置与部署

主要 CLI：

```text
gateway serve [--host 127.0.0.1|0.0.0.0] [--port 3000]
              [--state-dir DIR] [--dsh-path DIR]
              [--ui-password PASSWORD] [--api-token TOKEN]
              [--public-origin https://gateway.example.com]
              [--trusted-proxy IP ...] [--cors-origin ORIGIN ...]
              [--no-auth]
```

兼容别名为 `dsh-chamber-gateway`。环境变量包括 `DSH_GATEWAY_HOST`、
`DSH_GATEWAY_PORT`、`DSH_GATEWAY_STATE`、`DSH_GATEWAY_DSH_PATH`、
`DSH_GATEWAY_PASSWORD`、`DSH_GATEWAY_TOKEN`、`DSH_GATEWAY_PUBLIC_ORIGIN` 和
`DSH_GATEWAY_TRUSTED_PROXIES`。

生产建议用 owner-only 的 systemd `EnvironmentFile` 或 secret manager 注入凭据。Gateway
会从 managed dsh 和 Git 子进程环境中按大小写不敏感规则剥离全部 `DSH_GATEWAY_*`。

### 5.1 配置硬门

- bind host 只允许 `127.0.0.1` 或 `0.0.0.0`；port 必须为 1–65535；
- 非 loopback bind、配置 `publicOrigin` 或配置 trusted proxy，任一成立即视为外部部署，
  必须有密码或 token；
- **有界偏差（2026-08 用户决策，延续）**：`--no-auth` 显式覆盖上述 S1 门，允许
  无认证的外部绑定。仅当显式传参才生效（默认仍 fail closed），启动时打印醒目安全
  告警；**客户端不前置校验该模式**（§2.3），服务器是唯一授权方；
- 密码长度 12–1024；token 长度 32–4096 且必须为 visible ASCII；
- 密码与 token 可以同时启用，不互相遮蔽（`password+token` 形态要求两者齐备）；
- `publicOrigin` 必须是无 path/query/userinfo 的 canonical HTTP(S) origin；
- trusted proxy 只接受精确 IP，不接受网段或主机名；
- `--tls-cert/--tls-key` 即使成对提供也会 fail closed，因为内置 TLS 未实现
  （TLS 一律由用户自建的外部边界提供）。

推荐形态是 Gateway 监听 loopback，Caddy/Nginx 负责 HTTPS，并配置：

- `--public-origin https://gateway.example.com`；
- `--trusted-proxy <反代的精确 IP>`；
- 反代覆盖而不是追加 `X-Forwarded-For/Host/Proto`；
- 只把 Gateway 的监听端口暴露给该反代。

可信网络替代形态（本设计一等支持，风险自担）：`--bind 0.0.0.0` 明文 HTTP 直连，
或经 tailscale/SSH 隧道/frp 到达——加密由隧道层保证（tailscale WireGuard / SSH
加密 / frp 隧道），认证由 gateway 的 token/密码（或显式 `--no-auth`）保证。

`install-gateway.sh` 一键安装器（design 17 部署 + design 18 运行时管理）覆盖上述
形态：交互向导确认 bind/凭据/服务形态，`--no-auth` 有二次确认步骤；提供
install/update/status/logs/uninstall 子命令与 `--purge`。

## 6. 单一公网请求策略

HTTP、OPTIONS 与 WebSocket upgrade 使用同一个 request policy，执行顺序固定为：

1. 只接受 origin-form request-target；拒绝 absolute-form、`//`、反斜杠 authority 和 fragment；
2. 解析立即 socket peer；只有精确命中的 trusted proxy 才可提供 forwarded facts；
3. 校验有效 authority；公网 authority 必须精确等于 `publicOrigin`；
4. 私网/loopback authority 只允许相应私网/loopback client；
5. 校验 Origin；`Origin: null`、重复/畸形头和跨站无 Origin 导航均 fail closed；
6. 完成边界判定后才进入认证；
7. 认证后按固定白名单分派，不做“未知管理路由自动透传”。

trusted proxy 缺失、重复、含逗号或非法的 XFF 时，client identity 是 unknown，不回退到
反代自己的私网地址。`corsOrigins` 只是允许的**调用方 Origin**，绝不提升为 Host authority。

| 路径 | 处理方 | 认证 |
|---|---|---|
| `GET /health` | control-plane health | 公开 |
| `GET/HEAD/POST /auth/login` | Gateway 登录 | 公开；仅 password 形态存在 |
| `/api/connections*`、`/api/host/*` | control-plane 管理 API | 必须 |
| `/api/i/<source>/*` | 注册 transport 的实例代理 | 必须 |
| 其余 `/api/*`、`/plugins/*`、`/`、dsh assets | 单目标 Gateway proxy | 必须 |
| `/chamber/*` | Gateway 编排/API/页面 | 必须 |
| `/chamber/runtime*` | Gateway runtime 控制器（design 18 §9.3；不随 ready detach） | 必须 |
| `/api/events.mux`、`/api/events.host` upgrade | 单目标 Gateway proxy | 必须且同一 Host/Origin 策略 |

## 7. 认证与凭据生命周期

### 7.1 Password

- 登录页提交 form-urlencoded；API 客户端也可提交 JSON；
- scrypt 在有界并发队列中异步执行，失败尝试按边界派生 client IP 限流；
- 成功后签发 12 小时 HS256 cookie：`HttpOnly; SameSite=Strict; Path=/`，只有边界确认
  HTTPS 时附加 `Secure`；
- 登录页 CSP 只允许 self form 和 inline style，不开放脚本；
- 持久化 salted credential verifier。进程重启时若密码增加、删除或改变，先旋转
  `jwt-secret`，旧 cookie 立即失效。

### 7.2 Bearer token

- token 只以 salted hash 存在于 Gateway state；常量时间校验；
- 只接受一个有界 `Authorization: Bearer …`；
- Desktop renderer 永远看不到 token；token 由主进程注入到注册 transport 的请求；
- token 更新、清除、kind 切换或 transport unregister 会关闭该 transport 已建立的
  HTTP/SSE/WS 流，旧凭据不能继续读取数据。

### 7.3 入口失败语义（含桌面客户端三态）

- 未认证 API/asset/WS 返回 401；
- password 形态下，未认证的普通 HTML 文档导航跳转登录页；
- Host 错误返回 421，Origin 错误返回 403；
- 登录过载返回 503，限流返回 429；登录 body 上限为 16 KiB，超限返回 413、立即释放
  已收字节并进入 drain-only；凭据和内部错误不进入日志或响应。

桌面端对 401 的**可行动三态分类**（探针层，非秘密 detail）：

| 场景 | 分类 | 文案要点 |
|---|---|---|
| 未配置凭据/密码会话过期 | terminal（重登一次后仍失败） | 「gateway 要求认证（401）——配置共享 token 或密码」 |
| 配置了错误 token | terminal | 「gateway 拒绝了 token（401）——检查共享 token」 |
| 密码被拒 | terminal | 「gateway 拒绝了密码认证——重新输入密码」 |

## 8. 反代内核与资源边界

Gateway proxy 与 per-instance proxy 共用 `proxy-forward.ts`，从而保持相同的协议行为：

- 上游 Host 固定改写为目标 origin；浏览器 Origin 改写为目标同源；
- 请求剥离 cookie、authorization、hop-by-hop、`Forwarded`、`Via`、全部
  `X-Forwarded-*` 和 `X-Real-IP`；只有注册 transport 的受控 extra header 可重新注入；
- WS 只转发握手白名单；30 秒 ping/pong，漏一次 pong 即回收；
- 响应保留 content encoding、location、vary 等表示/跳转元数据，并重写同源 redirect；
- 45 秒为 idle timeout；响应 chunk 会重置 timer；SSE/WS 是长流；
- 写入尊重 backpressure；client 断开会取消上游；
- 错误明确映射 400/408/413/502/503/504，不伪装空成功。

资源上限：

| 资源 | 上限 |
|---|---|
| 单请求已声明 body | 300 MiB |
| 未声明/chunked body | 32 MiB |
| 全进程同时缓冲的请求 body | 300 MiB（Gateway 与 instance proxy 真正共享） |
| 每个 proxy HTTP 并发 | 64 |
| 每个 proxy WS streams | 64 |
| pending WS handshakes | 16 |
| dsh event 单帧原始 payload | 8 MiB |
| 每条 dsh event 预解析队列 | 16 MiB 且最多 256 帧 |

已声明 body 预分配单一 buffer，避免 chunks + `Buffer.concat` 的双倍峰值；进程预算在
上游完成消费或流被撤销前不提前释放。事件流上限发生在 JSON/正文过滤之前；任一上限
超出都会清空 raw queue、终止该 generation 并由索引/notifier 重连，不能以快速或超大
session/event 绕过净化后的 baseline buffer。

## 9. Desktop 远程 transport（连接模型落地）

### 9.1 注册表 schema

```jsonc
{
  "id": "gw-172",
  "kind": "gateway",            // 目标类型：dsh | gateway
  "transport": "http",          // 传输：ssh | http（开放联合）
  "host": "192.168.110.172",
  "user": null,                 // transport=ssh 时必填
  "sshPort": null,              // ssh 守护端口；null = ssh 默认
  "remotePort": 30801,          // ssh 隧道远端端口 / http 直连端口
  "serviceName": null,          // ssh 时：远端 systemd 单元（dsh.service / dsh-chamber-gateway.service）
  "remoteDshHome": null,
  "insecureHttp": false,        // transport=http：true = http 明文（缺省 false = https）
  "spkiPin": null               // S23 可选 SPKI pin：hex sha256 of SPKI DER（^[0-9a-fA-F]{64}$）；
                                //  仅 gateway+https 有效，http 明文拒绝
}
```

- 凭据**不进注册表**：`tokenSet`/`passwordSet` 是主进程凭据存储的实时非秘密投影
  （`instances_get` 读时合并），用于 UI 徽标与编辑回填；
- `transportTargetChanged` 不含 `insecureHttp` 与凭据投影（同一 host:port:kind 目标
  不变则凭据仍有效）；协议切换保留 token；显式清除/切换认证方式由表单调用
  `set_gateway_token/set_gateway_password` 完成；
- 迁移：旧 `kind:'ssh'` → `{kind:'dsh', transport:'ssh'}`；旧 `kind:'gateway'` →
  `{transport:'http'}`；`ssh-<id>` source id 保留 legacy 映射。

### 9.2 Provider 结构

```
ssh-tunnel.ts       共享：隧道 argv、askpass、systemd exec、stderr 分类/脱敏
endpoint-verify.ts  共享：host.describe 握手 over http(s)，可选 Authorization/Cookie 头
providers: { ssh: sshTransport, http: httpTransport }    // 按 transport 注册
```

探针认证矩阵（verifyUp 按 `spec.kind` 决定是否带认证）：

| kind | transport | verifyUp |
|---|---|---|
| dsh | ssh | 隧道端点 host.describe，无认证头 |
| dsh | http | 直连端点 host.describe，无认证头（用户自建穿透） |
| gateway | ssh | 隧道端点 host.describe，可选认证头 |
| gateway | http | 直连端点 host.describe，可选认证头 |

**ssh 隧道 gateway 目标的密码会话路径**：密码型 gateway 目标的登录会话按
**隧道端点 origin 键控**（ssh 隧道 = loopback http 端点 origin；http 直连 =
用户配置 origin）——`gateway-session.ts` 的缓存 key 与 verifyUp/ready 注册共用
同一派生（`gatewaySessionOriginForUrl`），cookie 只注入该 origin 的 transport；
隧道重连换了本地端口 → 新端点 origin 重新登录，旧 origin 会话不跨端点复用
（预过期刷新的重 arm 亦跟随新 origin，见 §9.3）。

### 9.3 反代注册规则（instance-proxy）

- connectionId：`${kind}:${id}`（`dsh:<id>` / `gateway:<id>`；kind 段字符集白名单）；
- baseUrl：ssh 隧道 = loopback http origin；http 直连 = 用户配置的 http(s) origin
  （非 loopback 放行——穿透由用户自建，SSRF 面 = 用户配置面，§13.4）；
- 头注入：**dsh 目标禁注入**；**gateway 目标 0..2 个**（`Authorization` Bearer /
  `Cookie` `dsh_gateway_session`），白名单逐项校验，绝不允许其他头；
- gateway 目标登录会话：主进程 `POST /login` → 捕获 `setCookie` → 仅内存持有 →
  仅注入本连接；401（12h 过期）→ 用存储密码自动重登一次（尊重 429 退避）→
  仍失败才 terminal；应用重启后凭已存凭据重登；
- **预过期会话刷新（TTL−60s 定时重登+重注册）**：每个已注册的密码型 gateway
  目标在缓存会话过期前 ~60s 定时重登（`gateway-session-refresh.ts`，
  `expiresAt − 60s` 触发；缓存会话寿命 = 12h − 5min 歪斜），重登成功后以新
  cookie **重注册** transport（替换既有 baseUrl/headers）并为新会话重 arm——
  健康 transport 永不骑过期 cookie（否则注册期注入的旧 Cookie 会在残余窗口内
  持续 401 直到重连）；armed on ready、disarmed on 离开 ready/移除/退出；
- **刷新失败→有界重连走 verifyUp**：预过期重登失败（网络/429/503）保持旧注册
  （旧 cookie 到期前仍有效）并在过期时刻重试；已过期后仍失败则如实告警，残余
  窗口交给断开→重连路径（verifyUp 用存储密码重登），绝不静默。

### 9.4 密码会话专项

登录响应/失败**永不含密码或 cookie 进日志**；cookie 仅主进程内存、仅注入本连接目标；
重登有界（一次 + 429 退避），不成为爆破放大器（服务器侧已有 scrypt work gate +
登录限流）；session cookie 为 HttpOnly，桌面仅作代理转发头，renderer 永不可见。

## 10. Gateway 编排面

### 10.1 会话索引

索引只包含 `sessionId/title/metadata/running/blank/cwd/updatedAt`。每一 generation：

1. 同时打开 `events.mux` 和 `events.host`；
2. 等到两个 WebSocket upgrade 完成、listener 已安装的真实 ready barrier；
3. 缓冲此后的流帧；
4. 获取权威 `session.list` baseline；
5. 按 seq/generation 规则重放缓冲帧；
6. 任一流死亡即清空投影，再重连，绝不跨代暴露旧 `running:true`。

索引忽略 `session/event` 正文和审批/提问帧。mux 只复制经过长度与形状校验的
subscribed/title/sessionListMetadata；host 流只复制 added/status/removed。baseline
窗口最多保留 4096 个已经净化的控制帧，超限会放弃整代并重连，正文与未知字段不会
进入缓冲区。

### 10.2 审批、提问和通知

`/chamber/approvals` 提供 JSON poll、SSE 和 POST answer。pending 以 request `rpcId`
去重；`approval/resolved`、`question/resolved` 与 generation reset 会向所有 SSE 客户端
广播撤回，避免多设备残留 stale row。

回答必须检查 dsh 的 `RpcReceipt.accepted`。`accepted:false` 返回 409，并保留 pending
供重试；只有确认 accepted 才删除。approval 只允许 `allowed-once | rejected`，question
使用严格的结构化 answers 形状。

### 10.3 Schedule

`/chamber/schedule` 存储跨会话 job，并调用已有 `session.prompt`。delay/interval 都不
能超过 Node/libuv 的 `2^31-1` 毫秒上限；interval 采用 single-flight 的 fixed-delay
递归，不允许前一次 RPC 未结束时重叠触发。一次性 job 只有 dsh 调用和持久化删除都成功
才消费；失败按 1–60 秒有界退避重试，不能复用 `delayMs=0` 形成热循环。timer callback
同时校验 run generation、job identity 与 in-flight 状态，cancel/detach 后不能幽灵重建。
Feature detach 只停 timer，不丢定义。

### 10.4 Settings 与界面

Gateway 自有 JSON API：

- `/chamber/settings`：GET/PUT 已知编排设置；
- `/chamber/sessions`、`/chamber/channels`：只读投影；
- `/chamber/approvals`、`/chamber/notifications`：poll/SSE/answer；
- `/chamber/schedule`：list/create/delete；
- `/chamber/git/worktrees`：list/create/delete；
- `/chamber/runtime`：dsh 运行时版本管理（design 18 §9.3）——
  `status`/`versions` 投影、`select`/`apply`/`rollback`/`restore-builtin`/
  `retry-apply`/`retry-restore`/`restart` 动作、`registry` 源设置（owner-only
  0600）；`restart` = 事务化受控重启托管 dsh 刷新插件挂载（design 18 §3.6
  项 8/§9.3：202 + status 轮询/SSE，指针不动、无快照/探针）；该面挂在 dispatch
  的 runtime 控制器上、**不随 ready detach**（dsh 停机窗口可轮询进度）。

`git`、`notifications`、`schedule` 三个能力默认关闭；开关是服务端执行门而不是 UI
提示。禁用能力的所有读写路由稳定返回 `403 feature_disabled`。Settings PUT 必须先
完成 owner-only 持久化，再在同一串行临界区即时 attach/detach。

浏览器可在 `/chamber/` 打开 Gateway 自有编排页；页面只使用同源 cookie/fetch，不接收
或持久化 token。Desktop settings-bridge 仅对选中的 `gateway` server 显示固定编排入口
与 dsh-runtime 代理分节（§3 装配规则），同样不接触 token。

## 11. Git worktree 安全 saga

Git 在 Gateway OS 用户下执行，但客户端不能指定任意仓库执行：

1. 调 `workspace.list` 获取 live workspace 权威；
2. `repo` 必须 realpath 为某个 live workspace 的 canonical 主 checkout，不接受 linked worktree；
3. `newPath` 必须是该 checkout 同层、尚不存在的路径；branch 通过严格 ref 字符白名单；
4. Git 子进程有并发、输出和 timeout 上限，环境剥离 Gateway secrets 与全部继承的
   `GIT_*` 覆盖变量，只显式重建安全的 Git 环境；
5. `git worktree add` 后调用 `workspace.create`，解码
   `value.workspace.workspaceId + created`；再调用 `session.create`；
6. 只有每一步的归属与提交状态确定时才允许补偿。

网络/协议失败可能发生在服务端已提交之后。遇到 `workspace.create` 或 `session.create`
的歧义结果时，Gateway 保留 Git 路径并写 recovery；绝不猜测失败后强删。
`created:false` 不会删除既有 workspace，`ownership:'unverified'` 的记录禁止 DELETE，
必须人工 reconcile。

删除契约：

- 只接受持久化且 `ownership:'owned'` 的记录；DELETE body 必须为空；
- canonical path、主 checkout、锁定和运行中 session 都会硬拒；session cwd 比较前
  realpath，解析失败 fail closed；Git mutation 前后都重查 live session；
- 不 archive session、不使用 `--force`、不删除 branch；
- create/delete 在紧邻任何 Git mutation 前都重取并完整重验 live workspace；同一路径、
  其子路径或 realpath/symlink alias 被不同 workspaceId 重占时硬拒，旧 deleting 记录
  不能授权删除新主体；
- 先持久化 `state:'deleting'`，再执行可恢复 saga；Git 路径已不存在时只重试
  `workspace.delete`；旧 workspaceId 已消失但路径仍存在时硬拒，只有 workspace 与路径
  都消失才视为已收敛；workspace 删除未确认时不会继续删文件；
- store 失败不会反向删除已经发布的 session/worktree。

现有 host API 没有“检查 session + 删除 worktree”的原子 lease，因此两次 live check 只能
把 TOCTOU 窗口压缩而不能数学上消除。发布前实机并发测试是强制门禁；长期根治需要 dsh
host 提供原子 guard/lease。

## 12. 持久化与恢复

Gateway state 与 dsh `$DSH_HOME` 分离。主要文件：

```text
<stateDir>/
├─ gateway.json
├─ tokens.json                 # salted token hash, 0600
├─ jwt-secret                  # 0600
├─ password-credential         # salted verifier, 0600
├─ dsh-runtime/                # design 18 §9.3：版本树/current 指针/override/快照（0700）
└─ gateway/
   ├─ settings.json
   ├─ worktrees.json
   └─ schedule.json
```

`stateDir` 与 `gateway/` 目录每次启动都收敛为 `0700`；所有 JSON main/backup/tmp 与
secret 文件每次加载和写入都收敛为 `0600`。已有 secret 先以 no-follow/inode 校验拒绝
symlink 与非普通文件，再收紧权限并读取。JSON 文档经 `createJsonStore` 的 owner-only
原子写路径持久化，写操作串行化，避免并发请求以旧 snapshot 覆盖新值。corrupt 主文件
会先尝试 backup；双重损坏会响亮失败，不伪装成空配置。

**桌面凭据存储（`<userData>/gateway-secrets.json`，schema v2）**：

```jsonc
{ "schemaVersion": 2,
  "tokens":   { "<id>": "<safeStorage 加密 blob | 0600 明文回退>" },
  "passwords":{ "<id>": "<同上>" } }
```

- **OS keychain 集成（Electron `safeStorage`）**：加密优先——macOS Keychain /
  Windows DPAPI / Linux libsecret（kwallet/gnome-keyring）；落盘内容为加密 blob，
  密钥由 OS 保管（§13.4.1）；
- `safeStorage.isEncryptionAvailable()` 不可用（如 Linux 无后端、无登录会话）时，
  回退当前 0600 明文镜像（登记为既有用户决策的延续）；
- 其余纪律不变：原子写、corrupt 响亮失败（保留 `.corrupt`）、删除实例/显式清除即删、
  永不进注册表/日志/renderer。

## 13. 安全模型

### 13.1 我们保证（软件纪律，可验证）

| 保证 | 机制 |
|---|---|
| 认证不减配 | 配置了凭据就一定注入且被 gateway 强制；401/403/421 如实分类（§7.3），绝无静默降级 |
| 秘密纪律 | token/密码仅主进程内存 + safeStorage 加密落盘（0600 明文回退）；永不进注册表/日志/renderer；write-only IPC；删除/清除即删；头注入仅作用于本连接注册的反代目标，不跨连接泄漏 |
| 默认安全 | 缺省 https + 凭据；http 必须显式写 `http://` 前缀（`insecureHttp` 归一） |
| 诚实状态 | `insecureHttp`/凭据存在性进入非秘密投影；配置时安全姿态提示 + 卡片常驻徽标（`HTTP 明文`红标 / `无认证`灰标），配完不忘 |
| 边界诚实 | 探针/反代失败显式（503/401/421/403 分类），错配的 no-auth 网关绝不伪装成 ready |
| 不削弱既有门 | S12：普通 control-plane 仍 loopback-only 匿名；S1：服务器外部绑定仍默认要求凭据 |

### 13.2 用户自担（文档与 UI 注明，不拦截）

- 传输加密：TLS 反代 / tailscale（WireGuard）/ SSH 隧道 / frp 隧道，任选或自建；
- 网络穿透：可达性由用户保证；
- 不可信介质上的明文风险：http 模式下凭据可被嗅探（姿态提示明示）；
- 服务器部署卫生：`--no-auth` 部署在何种网络上运行，由用户决定（服务器启动告警不变）。

### 13.3 四种组合威胁分析

| 组合 | 机密性 | 完整性 | 认证 | 实际风险面 |
|---|---|---|---|---|
| https + 凭据 | ✓ TLS | ✓ TLS | ✓ | 凭据被偷（本机/钓鱼）——safeStorage + write-only 缓解；证书固定可对抗 MITM |
| http + 凭据 | ✗ | ✗（无 TLS） | ✓ | 凭据嗅探 = 完全接管；**安全等级 = 网络等级**，姿态提示明示 |
| https + 无认证 | ✓ | ✓ | ✗ | 可达即可用——等价于可信网段上的开放服务 |
| http + 无认证 | ✗ | ✗ | ✗ | 完全开放明文——仅限可信网络；红标注明，服务器 `--no-auth` 是授权决策方 |

### 13.4 安全增强（行业最优实践评估与集成决策）

#### 13.4.1 OS keychain 集成 —— **集成**

- **机制**：Electron `safeStorage.encryptString/decryptString`（macOS Keychain /
  Windows DPAPI / Linux libsecret）。加密 blob 仍存既有 0600 JSON 文件，密钥由 OS
  会话保管；
- **价值**：静态磁盘拷贝/文件窃取不再能直接读出凭据；破解门槛从「读文件」提升到
  「同 OS 登录会话 + 调 API」——与浏览器/1Password 的保管模型一致；
- **决策**：集成（§12 桌面凭据存储 v2）；`isEncryptionAvailable()` 为 false 时回退
  0600 明文（登记延续既有用户决策）；回退路径在 UI 设置页可见。

#### 13.4.2 mTLS 与证书固定 —— **证书固定集成，mTLS 槽位**

- **证书固定（SPKI pin）**：https 直连的可选高级字段——用户提供期望服务器证书的
  SPKI 指纹，探针与反代校验，不匹配即 terminal。**价值：直接解决内部 CA 信任痛点**
  ——Caddy `tls internal` 场景不再需要 `NODE_EXTRA_CA_CERTS` 全局注入，改为在单条
  连接上钉住 Caddy 证书；同时对抗 MITM；
- **mTLS**：https 连接的可选客户端证书（cert+key，私钥走 safeStorage）。价值在
  「客户端证书 + token/密码」双因子；成本高（依赖反代层配置配合、证书生命周期管理、
  UI 字段与代理 TLS 扩展）。**决策：预留槽位，本期不实装**；
- **http 模式两者天然不可用**（无 TLS 层，无证书可固定/呈现）——文档明示，姿态
  提示不声称任何 TLS 保护（S23）。

#### 13.4.3 每连接网络策略 —— **现状内建 + 槽位**

- **已内建**：host 白名单（无冒号/IPv4/括号 IPv6，253 字符上限）+ 端口 1–65535 +
  connectionId 白名单 + 控制面 loopback-only（S12）+ 反代 baseUrl origin 校验；
  SSRF 面 = 用户自己的配置面（目标由用户显式填写，与 https 模式一致）；
- **槽位**（未来可选）：每连接「仅限这些网段/IP」限制字段，防误配场景（把公网
  gateway 地址填成内网）。价值中等、UI 成本高，本期不做；如有需要按独立设计进入。

#### 13.4.4 访问审计 —— **集成轻量版**

- **范围**：只记非秘密事件——连接建立/断开、认证成功/失败（401/403 分类）、凭据
  变更、http 明文/无认证连接的使用；**绝不包含凭据、cookie 与会话正文**（S24）；
- **落点**：桌面主进程本地审计日志（`<userData>/audit-log.jsonl`，0600 JSONL
  追加文件）+ gateway 服务器侧登录事件投影（成功/失败/限流，与既有限流器
  同源）；控制面仍无审计路由（不回流匿名控制面）；
- **消费**：CLI/日志查询即可；不进入设置 UI（v1）；
- **价值**：可信网络 + 无认证模式下，接入事实可追溯——「谁在什么时候连过、
  认证结果如何」的责任记录。

### 13.5 密码会话专项

登录响应/失败永不含密码或 cookie 进日志；cookie 仅主进程内存持有、仅注入本连接
目标；重登有界（一次 + 429 退避），不成为爆破放大器；session cookie 为 HttpOnly，
桌面仅作代理转发头，renderer 永不可见。

## 14. 扩展槽位总表

| 维度 | 槽位 | 现取值 | 未来扩展动作 |
|---|---|---|---|
| 目标类型 kind | `TransportKind` 开放联合 + source id 派生 | `dsh` / `gateway` | 新 provider + 类型槽，反代/渲染前缀自动派生 |
| 传输方式 transport | transport 注册表 + UI schema 注册表 | `ssh` / `http` | 新 provider + 表单 schema + locales |
| 认证 | 头注入白名单 + 会话管理器接口 | `Authorization` / `Cookie` | passkey/OIDC/客户端证书 = 新头项或会话实现 |
| 通道 channel（服务器侧） | `ChannelRegistry` | direct（非通道） | frp/tailscale/zerotier provider 实现 + `/chamber/channels` 发现流 |
| TLS 增强 | SPKI pin 字段（集成）；mTLS 槽位 | 无 | mTLS 客户端证书 + 代理 TLS 扩展 |
| 网络策略 | 目标网段限制槽位 | host/端口/loopback 白名单 | 每连接网段限制字段 |
| 审计 | 本地审计日志（集成轻量版） | 连接/认证事件 | 设置页只读入口（可选） |

## 15. 包、CI 与发布

`@dsh-chamber/gateway` 构建为 `dist/index.js` 与带 shebang 的 `dist/cli.js`，要求
Node 22+；package export 不指向源码 TypeScript。根脚本包含 `build:gateway`、
`typecheck:gateway`、`test:gateway`。

运行时版本管理（design 18 §9）：`@dsh-chamber/dsh-runtime` 以 workspace devDependency
经 `scripts/build.mjs` 与 control-plane 一起打入 `dist/`；gateway 另新增钉版本运行时
依赖 `pnpm@11.21.0`（与 desktop 同源，design 18 §9.2 D1）。pack/install smoke 必须
覆盖 pnpm 依赖安装成功与 `gateway --help`。

CI 运行 Gateway typecheck、完整测试、release workflow policy 和 pack/install CLI
smoke。release workflow 在 macOS 与 Windows Desktop 产物门禁完成后才 pack Gateway、
安装 tgz、执行 `gateway --help`，随后使用 `NPM_TOKEN` 发布 npm，并把同一 tgz 上传
GitHub Release。版本门同时检查 root、Desktop 和 Gateway package，防止发布漂移。
npm publish 以本地 tgz 与 registry `dist.integrity` 做可恢复幂等判断：同版本同完整性
视为已完成，不同完整性硬失败；只有 registry 明确 E404 才允许首次 publish，网络、
权限和未知查询错误全部 fail closed。版本只经环境变量进入 shell，并先校验 canonical
SemVer、八包一致性和 tag peeled commit 等于 checkout SHA；manual dispatch 创建新 tag
时显式绑定该 SHA。所有发布全局串行且不取消运行中事务，npm 稳定版只推进 `latest`、
预发布只推进 `beta`，并用 SemVer 单调门拒绝 channel 回退；同包重跑会核验或修复
dist-tag。已公开的 GitHub Release 永不删除，只有 stale draft 可替换；dry-run 不创建
或修改 release。正式构建不使用仓库内固定的第三方 Electron mirror。

## 16. 验收门禁

### 16.1 自动化门禁

合并前必须全部通过：

- root、Gateway、所有 chamber client/host 包 typecheck；
- control-plane 协议、存储、托管、管理 API、静态服务、实例代理测试
  （含 gateway http 直连注册、头注入 0..2、dsh 直连禁注入用例）；
- Gateway config/auth/request-policy/dispatch/proxy/lifecycle/feature/真实 socket 测试；
- dsh-runtime 共享核心 typecheck/测试；Gateway runtime 启动事务/路由权限测试与
  fake-registry acceptance（design 18 §9.5）；
- Desktop 全量 transport/provider/secret/plugin/deep-link 测试
  （含 http 探针真实 server 测试、401 三态、SPKI pin 校验、safeStorage 回退）；
- renderer shell、sidebar、connections、settings-bridge、Git 插件回归；
- renderer 与 Gateway build；Gateway pack/install/CLI smoke；
- frozen lockfile、i18n、`git diff --check`、冲突标记扫描；
- release workflow 的 commit/tag 绑定、公开 release 不可变、dry-run 零写入和 npm
  channel 策略测试。

### 16.2 发布前实机门禁

自动化全绿仍不能替代以下实机证据：

1. 安装的真实 dsh：Gateway 启动等待 ready，登录后 `/`、普通 `/api`、events.mux/host
   HTTP/WS、插件 bundle 与 `/chamber/` 全部可用；
2. 生产型 TLS 反代：publicOrigin、Host、Origin、XFF、Secure cookie、WebSocket
   upgrade、未认证/错误 authority 行为逐项验证；SPKI pin 正/负例；
3. 打包 Desktop：新增 Gateway（https+凭据 / http 明文+凭据 / http 无认证三种形态）、
   重启后自动连接（safeStorage 解密 + 密码会话重登）、token/密码更新/清除撤销既有流、
   N-ctx 与 Gateway settings 页面（dsh-runtime 分节挂载差异验证：gateway 缩减视图
   （版本行+重启+轮询）/ dsh ssh 只读 / dsh http 直连不挂载）；
4. 真 Git 仓库：创建/歧义恢复/删除重试、dirty/locked/主 checkout、运行中 session 与
   并发启动 session 的安全验证；
5. macOS 发布产物完成签名/公证/安装；Windows 产物完成签名与安装；
6. 服务端 dsh runtime 实机：安装候选版本 → 重启 Gateway → 探针 → 故障注入回退 →
   `<stateDir>/dsh-home` 数据恢复；生产 TLS 反代下 `/chamber/runtime` 的 SSE/poll
   与认证行为（design 18 §9.5）；
7. 可信网络形态实机：`--bind 0.0.0.0` 明文 HTTP 直连（带凭据 / `--no-auth`）、
   SSH 隧道回环直连、tailscale 直连——四种组合全链路 + 401/421/403 负例。

PWA 安装、离线缓存和 UA 移动轻面不属于本轮验收；不再暴露无实现的 CLI flag。它们如需
推进，必须作为独立设计与测试面进入 STATUS。

## 17. 安全不变量摘要

| # | 不变量 |
|---|---|
| S1 | 外部部署无认证不能启动（默认；`--no-auth` 为有界偏差，服务器为唯一授权方） |
| S2 | HTTP 与 WS 使用同一 request policy 和认证 |
| S3 | 未经信任的 forwarded headers 永不影响 authority/client/TLS 判断 |
| S4 | 上游不可用显式 5xx，绝不 empty success |
| S5 | 密码/token 不进 renderer、日志或子进程环境 |
| S6 | token/密码变更会撤销旧 cookie 或 live streams |
| S7 | transport id 只查注册表，不能拼接成 URL |
| S8 | 全进程 body 预算真实共享，backpressure 期间不提前释放 |
| S9 | 派生 session/pending 状态不跨 stream generation |
| S10 | Git 只作用于 dsh live workspace 派生的 canonical 路径 |
| S11 | 不确定的 Git 提交/归属永远选择保留与 recovery，不选择破坏性补偿 |
| S12 | Gateway 不能削弱普通 control-plane 的 loopback-only 门 |
| S13 | feature flag 是默认关闭的服务端能力门，禁用后停止后台 consumer/timer |
| S14 | dsh raw event queue 与 session 索引净化 buffer 都有硬上限，绝不持久保留会话正文 |
| S15 | Gateway state 目录与 JSON/secret 文件分别强制 0700/0600 |
| S16 | release 必须 commit-bound、公开记录不可变，npm channel 单调且 stable/beta 隔离 |
| S17 | dsh runtime：无快照不切指针；切换/恢复中断由 durable journal/marker 幂等补完（design 18 §9.7） |
| S18 | dsh runtime：探针全绿才宣布 applied 并开放代理；回退目标 = 切换前版本或最近 known-good，绝不两棵坏树间交替 |
| S19 | dsh runtime：状态/凭据（registry 源、失败记录、install 子进程 env）不进日志；状态文件 0600/0700；install 源钉死 + env scrubbing |
| S20 | dsh runtime：切换不得削弱 S12（普通 control-plane loopback 门）；`/chamber/runtime` 全部认证后 |
| S21 | http 明文/无认证接入是显式用户决策（URL 协议 + 凭据留空）；UI 与文档如实注明风险，绝不静默降级 |
| S22 | 桌面凭据（token/密码）经 safeStorage 加密落盘；不可用时回退 0600 明文并登记，永不进注册表/日志/renderer |
| S23 | 证书固定（SPKI）为 https 直连可选门：配置后不匹配即 terminal；http 模式不得声称任何 TLS 保护 |
| S24 | 审计日志只记非秘密事件（时间/来源/认证结果），绝不包含凭据、cookie 与会话正文 |

## 18. 相关文档

- `03-connections-proxy.md`：共享 HTTP/WS proxy 契约；
- `04-control-plane-api-data.md`：管理 API、静态服务和数据边界；
- `05-connection-manager.md`：Desktop transport 与 N-ctx（kind/transport 扩展面）；
- `08-git-worktree-plugin.md`：迁移期保留的实例内 Git 路线；
- `18-dsh-runtime-version.md`：dsh 运行时版本管理的权威行为契约；§3.6 = per-server
  设置分节（local/gateway/ssh 三态挂载差异）、§9 = gateway 宿主实现设计；
- `docs/progress/STATUS.md`：当前验证证据和剩余实机门禁。
