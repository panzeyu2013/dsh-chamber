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
- **语义**：填 token → `Authorization: Bearer`；填密码 → 主进程 `POST /auth/login` →
  持有 12h JWT cookie（`dsh_gateway_session`，HttpOnly，仅 HTTPS 边界附加 Secure）→
  反代注入 `Cookie` 头；两者同时存在时登录与 bearer 是**独立 OR principal**，客户端
  同时注入 `Authorization` + `Cookie`，gateway 接受任一合法身份（token 轮换不遮蔽
  仍有效的密码会话，密码登录失败也可由有效 token 继续）；**都空 → 无认证头直接请求，由 gateway 校验**（`--no-auth`
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

停止时先同步关闭 feature 与 credential mutation admission，并撤销 dispatch 追踪的
下游 HTTP/WS（未读完 body 的请求因此不会卡住 drain）；同时中止 runtime
transaction/install。已经越过 admission 的 Git/settings/schedule saga 或凭据写入不
强行打断，而是持有 stateDir lock 等待其完整 promise、审计尾与持久化 tail 收敛；
feature、credential、runtime 三类 writer 都静止后才停止 control-plane、managed dsh
并释放 `.gateway.lock`。启动失败回滚走同一屏障，绝不让旧 handler 在新 gateway
取得锁后继续写；同一 handle 再次 `start()` 时才重新开放 admission。
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
gateway auth status [--state-dir DIR]
gateway auth reset-password --new PASSWORD [--state-dir DIR]
gateway auth clear [--state-dir DIR]
```

`gateway auth` 子命令在**停机态**管理持久化凭据（§7.4）：`status` 输出非秘密投影
（password/token 是否配置、`source` 与最后写入时间，永不含值）——它是**无锁只读**
命令，运行中的 gateway 也可正常读取；只读路径验证既有凭据文件已经是 `0600`，
权限过宽时按不安全/未配置投影且绝不以 `chmod` 修改文件；`reset-password --new PASSWORD` 以
`source:'runtime'` 写入新密码并先旋转 `jwt-secret`（12–1024 字符）；`clear` 同时
删除密码与 token，下次启动由部署配置重新播种（`--no-auth` 部署恢复匿名并打印 S1
告警）。后两者取 stateDir 独占锁，**运行中的 gateway 会响亮拒绝**（结构化错误
`gateway_locked` + 运行中 pid）并提示改用 Web UI（`/chamber/` 凭据面板）或
`/auth/change-*` API；用法错误退出 2，运行失败（gateway 运行中/state 错误）退出 1。
`serve` 的 boot 行打印的是**播种后的有效 auth kind**（§7.4）——runtime 凭据生效时
不再误报 `auth=none`。

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
- 密码长度 12–1024 个 JavaScript 字符（JSON 传输，允许 Unicode）；token 长度
  32–4096 且必须为 visible ASCII；
- 密码与 token 可以同时启用，不互相遮蔽（`password+token` 形态要求两者齐备）；
- `publicOrigin` 必须是无 path/query/userinfo 的 canonical HTTP(S) origin；
- trusted proxy 只接受精确 IP，不接受网段或主机名；
- `--tls-cert/--tls-key` 即使成对提供也会 fail closed，因为内置 TLS 未实现
  （TLS 一律由用户自建的外部边界提供）。

**凭据播种语义（Phase 1，§7.4/§12）**：启动时 `seedCredentialsFromConfig` 把部署
配置（`--ui-password`/`--api-token` 或 `DSH_GATEWAY_*`）播种进持久化凭据。config
凭据只在「无持久化」或「持久化 `source='config'`」时断言（值变化先旋转
`jwt-secret`，未变化不写）；持久化 `source='runtime'` 的凭据**权威**——config 被
忽略并响亮告警（含运行时更新时刻与回退指引），绝不静默覆盖。config 未提供且
持久化为 config 来源时删除（先旋转），runtime 来源保留。因此「改配置→重启」流程
在无 runtime 覆盖时行为与从前完全一致；`--no-auth` 部署若已存在 runtime 凭据则
**有效形态已认证**——启动告警按播种后的有效 kind 判定（§7.4），不再误报匿名。

**S1 门与 runtime 凭据的交互**：外部绑定（非 loopback / publicOrigin / trusted
proxy）的 S1 硬门在**播种之前**按**部署配置**判定——持久化 runtime 凭据不满足该
门，此类部署必须显式 `--no-auth` 才能启动（此时按播种后的有效 kind 判定告警：
已认证则不打印匿名告警）。loopback 绑定下 runtime 凭据正常生效。

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
   `rawHeaders` 中重复 Authorization 在 HTTP/WS 共用策略、任何 hash/scrypt 前即 400；
6. 完成边界判定后才进入认证；
7. 认证后按固定白名单分派，不做“未知管理路由自动透传”。

trusted proxy 缺失、重复、含逗号或非法的 XFF 时，client identity 是 unknown，不回退到
反代自己的私网地址。`corsOrigins` 只是允许的**调用方 Origin**，绝不提升为 Host authority。

| 路径 | 处理方 | 认证 |
|---|---|---|
| `GET/HEAD /health` | control-plane health | 公开 |
| `GET/HEAD/POST /auth/login` | Gateway 登录 | 公开；仅 password 形态存在（token-only 部署 404） |
| `POST /auth/change-password` | 运行时改密/删密码（§7.4） | 必须 |
| `POST /auth/change-token` | 运行时轮换/删 token（§7.4） | 必须 |
| `GET /auth/credentials` | 非秘密凭据投影（§7.4） | 必须 |
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
- JWT 验签除签名外强制 `exp` 为 safe integer、严格晚于当前秒且不超过当前+12h；
  缺失/字符串/null/Infinity/小数/unsafe/过期/超窗均拒绝；
- 登录页 CSP 只允许 self form 和 inline style，不开放脚本；
- 持久化 salted credential verifier。启动播种或运行时变更时，若密码增加、删除或
  改变，先旋转 `jwt-secret`，旧 cookie 立即失效（运行时路径见 §7.4）。

### 7.2 Bearer token

- token 只以 salted hash 存在于 Gateway state；常量时间校验；
- 只接受一个 `Authorization: Bearer …`；token wire 值须为 32–4096 visible ASCII，
  重复/数组/31/4097/控制字符在读取 hash 或进入高成本认证前拒绝；
- Desktop renderer 永远看不到 token；token 由主进程注入到注册 transport 的请求；
- token 更新、清除、kind 切换或 transport unregister 会关闭该 transport 已建立的
  HTTP/SSE/WS 流，旧凭据不能继续读取数据。

### 7.3 入口失败语义（含桌面客户端三态）

- 未认证 API/asset/WS 返回 401；
- password 形态下，未认证的普通 HTML 文档导航跳转登录页；
- Host 错误返回 421，Origin 错误返回 403；
- 登录过载返回 503，限流返回 429；登录 body 上限为 16 KiB，超限返回 413 并
  **销毁请求 socket**（不排空、不继续消费，防止慢速匿名上传钉住连接；login 与
  change 路由同纪律）；凭据和内部错误不进入日志或响应。

桌面端对 401 的**可行动三态分类**（探针层，非秘密 detail）：

| 场景 | 分类 | 文案要点 |
|---|---|---|
| 未配置凭据/密码会话过期 | terminal（重登一次后仍失败） | 「gateway 要求认证（401）——配置共享 token 或密码」 |
| 配置了错误 token | terminal | 「gateway 拒绝了 token（401）——检查共享 token」 |
| 密码被拒 | terminal | 「gateway 拒绝了密码认证——重新输入密码」 |

当 token 与密码同时配置时，上述失败分类以**联合探针最终结果**为准：一项凭据失败而
另一项身份有效仍是成功，不能因“token 优先”或“密码优先”遮蔽可用的独立 principal。
该 OR 契约也覆盖 token scrypt work gate 饱和：Bearer 校验返回 `auth_busy` 时仍先验证
现有 Cookie；Cookie 有效即成功，否则才保留 503 `auth_busy`，不能把过载伪装成 401。

### 7.4 运行时凭据管理（Phase 1–4）

> Phase 锚点：Phase 1 = store/auth 核心（v2 信封 + 动态 facade + 播种 + stateDir
> 锁）；Phase 2 = HTTP 面（三条路由 + 审计 + 告警/close/reacquire 接线）；Phase 3 =
> `/chamber/` 凭据面板 + `gateway auth` CLI；Phase 4 = 文档与验收。desktop
> settings-bridge 便捷重置为推迟项（见 STATUS）。

凭据是**服务器状态**而非部署配置：`<stateDir>/password-credential` 与 `tokens.json`
以 v2 JSON 信封持久化 `{schemaVersion:2, source:'config'|'runtime', updatedAt,
verifier|hash}`（0600，§12）。legacy v1（密码裸 `scrypt$…` / token `{"hash":…}`）
读为 `source:'config'`（updatedAt = 文件 mtime）并在下次写入迁移。动态 AuthProvider
facade 的 `kind` 每请求按**当前持久化状态**计算（password / token / password+token /
none），verify/login 按有效状态分派；`login` 恒存在，无密码时抛 `no_password`
（dispatch 映射 404——登录路由仅 password 形态存在）。

**播种规则**（启动时 `seedCredentialsFromConfig`；密码与 token 两个维度同规则，
密码维度写入/删除前先旋转 `jwt-secret`，token 维度无 session-cookie 关联故不旋转）：

| 配置提供 | 持久化状态 | 动作 |
|---|---|---|
| 有 | 无 / `source='config'` | 写入 v2（source='config'）；值未变化不写不旋转 |
| 有 | `source='runtime'` | **忽略 config**，响亮告警（含运行时更新时刻与回退指引） |
| 无 | `source='config'` | 删除（先旋转） |
| 无 | `source='runtime'` | 保留，不告警 |

**变更 API**（全部在认证门后，永不落入 dsh 反代；body 16 KiB 上限，超限 413 并
销毁请求 socket；成功响应 `no-store`）：

| 端点 | 语义 | 成功响应 |
|---|---|---|
| `POST /auth/change-password` | `{newPassword}`（12–1024）或 `{remove:true}`；可带 `currentPassword` | `{changed:true, kind:'password', source, removed?}` |
| `POST /auth/change-token` | `{newToken}`（32–4096 visible ASCII）、`{}`（服务端 CSPRNG 生成）或 `{remove:true}` | `{changed:true, kind:'token', source, token?, removed?, durability?:'unknown'}` |
| `GET /auth/credentials` | 非秘密投影（S5）；HEAD 为无体孪生 | `{password: {set, source, updatedAt}\|null, token: …}` |

请求校验：`{remove:true}` 与 `newPassword`/`newToken` **互斥**（并存 → 400
`bad_request`）；非字符串 `currentPassword` → 400；change 路由 body 以 JSON 为准
（16 KiB 上限——极端 form-urlencoded 双 1024 非 ASCII 密码可能超限 413，面板与
API 客户端一律用 JSON）。未认证的 HTML-accept 导航到 `/auth/*` 返回 401 JSON
（不跳登录页）。

新 token 明文在变更响应中**只返回一次**，此后任何面（含 `GET /auth/credentials`）
都不再暴露；`/auth/login` 仅 password 形态存在，token-only 部署 404。原子 rename
已经发布、但父目录 fsync 报错时，Gateway 以稳定 exact-hash readback 判定在线 token
确已生效：生成型 token 仍必须返回这一次明文，响应额外带 `durability:'unknown'`，
提示崩溃持久性未获证明；无法 exact readback 时仍返回 500，绝不猜测提交成功。

错误码→HTTP（change 路由）：

| code | HTTP | 说明 |
|---|---|---|
| `bad_request` | 400 | body 形状/长度/字符集非法 |
| `invalid_credentials` | 401 | 无证明 principal 且未提供或错误 currentPassword |
| `ambient_principal_rejected` | 403 | 仅 cookie principal 且未提供 currentPassword（S25） |
| `last_credential` | 409 | 拒绝删除最后一个凭据（除非 config 提供替代 → revert） |
| `rate_limited` | 429 | currentPassword 经共享登录限流器；连续错误尝试触发锁 |
| `auth_busy` | 503 | scrypt work gate 饱和 |
| `body_too_large` | 413 | 超 16 KiB；先回 413 再销毁 socket |
| 其他 | 500 | `internal_error` |

**非环境性证明（S25）**：凭据变更要求非环境性 principal——bearer-token principal
自证，或 `currentPassword` 经共享登录限流器 + 有界 scrypt work gate 校验。仅
cookie principal 且未带正确 currentPassword 拒绝 403；currentPassword 错误为 401
（连续失败按登录限流 → 429）。因此匿名（`--no-auth`）部署无法经 API 种植/变更
凭据——无既有凭据可证明。dispatch 认证门将成功 principal 捕获为同 provider、同
generation 的进程内 proof，凭据变更与审计直接复用它（bearer 每请求只做一次
verifier）；排队期间跨 generation 的 proof 拒绝 401，绕过 dispatch 的内部直调未提供
proof 时仍完整复验。

**last-credential 门 + config revert**：删除最后一个凭据（另一维度也不存在时）
拒绝 409，除非部署配置提供替代——此时**回退**为 config 凭据（响应
`source:'config'`，旧 cookie 因 rotate-first 已死）。S1 门不可在运行时削弱：
none↔auth 双向转换仍仅部署期（config 播种 + 重启）；删除最后凭据只能停机态
`gateway auth clear`。**config 管理维度的 remove 语义**：删除 config 来源维度
（另一维仍在）成功，但**下次重启会被播种恢复**——面板对该情形如实提示
「removed for now … re-seeded on the next restart」。

**rotate-first（S13）**：密码变更先旋转 `jwt-secret` 再持久化——持久化失败也绝不
留下「新 verifier + 旧 cookie」混合态；旧 cookie 在变更瞬间立即失效。

dispatch 认证边界按 credential generation 统一追踪所有已认证 HTTP response 与 WS
socket；generation 在首个凭据 store side effect **之前**提升，因此成功提交与
「rename 已发布但 durability unknown」/密码 rotate-first 后续失败都会关闭旧
generation 的全部长连接（management、instance fallthrough、gateway proxy、feature
SSE），仅排除变更请求自身 response 以完整返回一次性 token 或错误。
Gateway 停机则先关闭 credential mutation admission、销毁当前认证流，再等待已经进入
的 change route 完整收敛（包括错误路径与审计 append）；stateDir owner 不会先于凭据
writer 释放。
proxy/feature 不再各自承担 credential-only 关闭回调；它们的 close primitive 只服务自身
stop/lifecycle 清理，避免重复 teardown 与覆盖遗漏。

**审计（S24）**：`credential_changed` / `credential_change_rejected`——detail 仅含
维度、set/remove、source、认证门已经确认的变更前 principal kind（成功事件）与
客户端来源；拒绝事件 detail 含维度 +
wire code + 客户端来源；任何值永不进入审计。`audit.log` append/rotation 绑定
single-link inode，O_NOFOLLOW/O_APPEND、完整写 + file fsync，archive 也在 rename 前
验证 leaf identity 并在发布后 fsync parent；审计 I/O 失败仍非业务致命，但不允许
跟随 active/archive symlink 或修改外部 victim。

**与 desktop 客户端的关系**：运行时凭据变更后旧 cookie/bearer 立即失效，desktop
的 401 三态分类（§7.3）已覆盖「凭据被换」后的行为——重登/重输 token 后恢复；
token 仅一次性返回意味着轮换方必须就地保存；`--no-auth` 部署不可经 API 种植凭据，
删除最后凭据必须停机态 `gateway auth clear`。

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
  （`instances_get` 读时合并），仅用于 UI 徽标与编辑页“已设置”提示，secret 值绝不回填；
- 凭据绑定按域比较，不能复用 transport 全字段启发式：gateway token/password 只绑定
  `kind + host + remotePort`（ssh↔http、scheme、SPKI 与 SSH-only 字段变化均保留）；
  SSH password 单独绑定 `transport=ssh + host + user + sshPort`。真正 retarget 时 write-only
  旧值不能静默跨目标复用，必须重录或显式清除；
- 元数据与三类凭据由主进程单次 `desktop_ssh_save_connection` 事务提交：先拍 registry 与
  write-only secret 快照，逐步写入，任一步失败即在主进程补偿恢复；补偿也失败时安全
  scrub 相关凭据并响亮返回，renderer 不串联多个无法读回旧值的 setter；
- 上述域绑定同时**持久化在凭据文件中并在每次读取/注入时与当前 registry 精确复验**：
  secret 先 fsync、registry 后 fsync 的硬崩溃窗口只会令新值暂时不可见，绝不能把新目标
  凭据发给仍在 registry 中的旧目标；新增/进入/离开/retarget 即使表单留空也强制写入或
  清除该维度，防止同 id + 同域重建把无当前行时隐藏的半事务 secret 复活；
- 删除只走精确 id-addressed `desktop_ssh_delete_connection(id)` main-owned transaction：
  先断开并撤销该 connection-target scope 的全部历史 origin 会话、清两类 durable secret，
  最后删 registry；不存在 id 为幂等 no-op。保留的 legacy
  `desktop_ssh_instances_set` 只接受与当前规范化 roster 同长度、同顺序、逐字段完全相同的
  exact no-op，任何删除/add/edit/reorder 都拒绝；三个单项 credential setter 只接受
  clear，新增/编辑/非空写一律必须走 save transaction；
- 迁移：旧 `kind:'ssh'` → `{kind:'dsh', transport:'ssh'}`；旧 `kind:'gateway'` →
  `{transport:'http'}`；`ssh-<id>` source id 保留 legacy 映射。
- `serviceName` 与 `remoteDshHome` 都是 transport + exec identity 的 generation 字段；
  编辑时先提升 transport generation/`execEpoch`，撤销旧 live transport、重连/探针与
  全部 exec child（SIGTERM→SIGKILL），多步 exec 的下一次 spawn 及迟到日志/投影/结果
  全部复验 generation；原连接非 idle 才以新参数重启，kind/serviceName 变化会清空旧
  `serviceActive` 投影。

### 9.2 Provider 结构

```
ssh-tunnel.ts       共享：隧道 argv、askpass、systemd exec、stderr 分类/脱敏
endpoint-verify.ts  dsh：host.describe；gateway：认证后 runtime status identity
providers: { ssh: sshTransport, http: httpTransport }    // 按 transport 注册
```

探针认证矩阵（verifyUp 按 `spec.kind` 决定是否带认证）：

| kind | transport | verifyUp |
|---|---|---|
| dsh | ssh | 隧道端点 host.describe，无认证头 |
| dsh | http | 直连端点 host.describe，无认证头（用户自建穿透） |
| gateway | ssh | `GET /chamber/runtime/status` + 精确 `kind:'dsh-chamber-gateway-runtime'`，可选 0..2 认证头 |
| gateway | http | 同上（直连 http(s)）；托管 dsh blocked/down 时 gateway 仍可 serviceable |

Gateway 身份判据刻意不再依赖 managed dsh `host.describe`：runtime controller 不随
dsh ready detach，因此 blocked/applying/restart 窗口仍可注册反代、打开恢复动作；
dsh 目标仍严格使用 `host.describe`，两层健康不得混为一个 ready 位。

**gateway 密码会话 ownership**：`gateway-session.ts` 的 key 由三部分共同构成：网络
origin、HTTP `Host` authority、稳定的 connection-target scope。scope = connection id +
目标摘要（SSH：transport/host/user/sshPort/remotePort；direct：http transport/host/
remotePort），刻意不含易变的 tunnel localPort；因此不同 direct id 即使同 origin 也不
共享 Cookie，同一 localPort/远端 loopback authority 被不同 SSH 主机或 id 复用也不会
串会话，同 id retarget 则进入新 scope。authority 只负责路由，不代表 ownership：SSH
固定为远端真实监听 `127.0.0.1:<remotePort>`，`spec.host` 只是 SSH destination，可为
ssh-config alias/DNS 名，绝不能拿来触发 gateway Host policy 421。隧道重连的新 origin
会重新登录；scope invalidation 同时覆盖该连接目标的全部历史 localPort/origin。

### 9.3 反代注册规则（instance-proxy）

- connectionId：`${kind}:${id}`（`dsh:<id>` / `gateway:<id>`；kind 段字符集白名单）；
- baseUrl：ssh 隧道 = loopback http origin；http 直连 = 用户配置的 http(s) origin
  （非 loopback 放行——穿透由用户自建，SSRF 面 = 用户配置面，§13.4）；
- 头注入：**dsh 目标禁注入**；**gateway 目标 0..2 个**（`Authorization` Bearer /
  `Cookie` `dsh_gateway_session`），白名单逐项校验，绝不允许其他头；
- gateway 目标登录会话：主进程 `POST /auth/login` → 捕获 `setCookie` → 仅内存持有 →
  仅注入本连接；401（12h 过期）→ 用存储密码自动重登一次（尊重 429 退避）→
  仍失败才 terminal；应用重启后凭已存凭据重登；
- delete/retarget/进入 gateway 生命周期会在任何 secret/metadata 提交前按 exact scope
  撤销所有历史 origin；每个观察过的 session key 都有单调 generation，invalidate 会同步
  提升 generation 并取消 active login。登录、Cookie 探针、Bearer fallback、401 重登在
  每次 await 后复验 generation，旧结果不得继续 probe/fallback/relogin，也不得改写 cache、
  429 backoff 或 registration auth proof；故同 id、同目标重建也不能继承上一代异步结果；
- `configureGatewaySessionProvider` 的 `ensureSession` / `generation` /
  `registrationAuthProof` / `setRegistrationAuthProof` / `cachedCookie` / `invalidate`
  必须 all-or-none，partial wiring 直接抛错；
- token 与密码同时存在时，ready 注册和刷新重注册通常携带 Bearer + Cookie；verifyUp 为
  当前 generation 记录 `cookie|bearer` 非秘密 auth proof。密码型目标 ready 注册要求
  Cookie 与 `cookie` proof 同时存在；只有登录失败且 verifyUp 已证明 Bearer fallback 的
  token+password 目标可有意以 Bearer-only 注册。Cookie/proof 在 verify→register 间消失
  就 fail closed 重连，绝不注册成 headerless；
- **预过期会话刷新（TTL−60s 定时重登+重注册）**：每个已注册的密码型 gateway
  目标在缓存会话过期前 ~60s 定时重登（`gateway-session-refresh.ts`，
  `expiresAt − 60s` 触发；缓存会话寿命 = 12h − 5min 歪斜），重登成功后以新
  cookie **重注册** transport（替换既有 baseUrl/headers）并为新会话重 arm——
  健康 transport 永不骑过期 cookie（否则注册期注入的旧 Cookie 会在残余窗口内
  持续 401 直到重连）；armed on ready、disarmed on 离开 ready/移除/退出。每个 id 的
  arm/disarm/dispose 都提升 refresh epoch；任一 await 后、retry/register/reconnect 前
  复验 epoch 与当前 password/token/URL/SPKI pin/authority/scope，阻止同 id 重建或
  retarget 的迟到刷新提交；
- **刷新失败→有界重连走 verifyUp**：预过期重登失败（网络/429/503）保持旧注册
  （旧 cookie 到期前仍有效）并在过期时刻重试；已过期后仍失败则如实告警，残余
  窗口交给断开→重连路径（verifyUp 用存储密码重登），绝不静默。
- **SPKI pre-write 门**：gateway+HTTPS 配置 pin 时，desktop 登录与 verifyUp 探针、
  control-plane HTTP/WS 反代均先在 TLS `secureConnect` 匹配 peer SPKI，再调用请求
  `write/end` 或发送 upgrade handshake；匹配前不发送 header、Bearer/Cookie、密码 body
  或任何应用层字节，mismatch 显式 terminal/502，目标 server handler/upgrade 均不可见。

### 9.4 密码会话专项

登录响应/失败**永不含密码或 cookie 进日志**；cookie 仅主进程内存、仅注入 exact
connection-target scope 所有的目标；
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
新 job 先以未武装 identity admission 进入内存，同一持久化串行临界区写盘成功后才 arm
（包括 `delayMs=0`）；自动删除以 identity mutation intent 在该临界区内对 current list
重算并提交，旧 callback 不得覆盖更新 snapshot。Feature detach 只停 timer，不丢定义。

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

浏览器可在 `/chamber/` 打开 Gateway 自有编排页；其中 runtime 块完整呈现版本/来源、
选择与 apply/rollback/restore/retry/restart 动作、失败/快照/磁盘与 registry，且在 managed
dsh blocked/down 时仍可轮询恢复。页面只使用同源 cookie/fetch，**不持久化** token
（轮换明文仅一次性展示、复制或 60 秒后自动清空）。Desktop settings-bridge 仅对选中的
`gateway` server 显示固定编排入口与 dsh-runtime 代理分节（§3 装配规则），同样不接触 token。

编排页另含 **Credentials 面板**（Phase 3，驱动 §7.4 三个端点）：两行投影
（password/token 的 `source`/`updatedAt`，来自 `GET /auth/credentials`，绝不含值）
+ 改密/删密码/轮换 token/删 token 动作。轮换后的 token 明文在只读 textarea
**一次性展示**（成功复制后即清空，60 秒未复制自动清空；不落 localStorage、不进
审计）；403 `ambient_principal_rejected`、409 `last_credential`、429 等错误按 wire
code 映射为可读文案（「输入当前密码以变更凭据」「不能移除最后一个凭据——先配置
替代」等）；删除 **config 管理**维度时如实提示「removed for now — 重启后重新播种」。

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
- 同一 `workspaceId` 的 DELETE 在读取记录前取得进程内 owner-token lease，并覆盖
  deleting intent、Git/workspace mutation 与成功/失败 outcome 持久化；第二个请求在
  任一阶段稳定返回 409，只有完整 saga settle 后才精确释放 lease。

现有 host API 没有“检查 session + 删除 worktree”的原子 lease，因此两次 live check 只能
把 TOCTOU 窗口压缩而不能数学上消除。发布前实机并发测试是强制门禁；长期根治需要 dsh
host 提供原子 guard/lease。

## 12. 持久化与恢复

Gateway state 与 dsh `$DSH_HOME` 分离。主要文件：

```text
<stateDir>/
├─ tokens.json                 # v2 信封 {schemaVersion:2, source, updatedAt, hash}, 0600
├─ jwt-secret                  # 0600
├─ password-credential         # v2 信封 {schemaVersion:2, source, updatedAt, verifier}, 0600
├─ .gateway.lock               # 独占锁 JSON {pid, createdAt}, O_EXCL + 0600
├─ dsh-runtime/                # design 18 §9.3：版本树/current 指针/override/快照（0700）
└─ gateway/
   ├─ settings.json
   ├─ worktrees.json
   └─ schedule.json
```

Gateway 拒绝把文件系统根、用户 HOME 或系统 temp 根本身作为 `stateDir`（其专用子目录
仍合法）。POSIX 上，新建的专用 `stateDir` 与 `gateway/` 创建为 `0700`；既有
`stateDir` 必须已是 `0700`，启动只验证而不替调用者 `chmod`，避免把宽泛共享目录静默
收窄；gateway 自有子目录仍收敛为 `0700`。Windows 的 Node `chmod/stat.mode` 只能表达
有限的只读属性，不能诚实证明 POSIX `0700`；该目录边界仅保留 real-dir/no-follow/identity
校验并继承 OS ACL，既不伪报 `0700` 也不改 ACL（Windows 首版整体支持仍按 STATUS
暂缓）。所有 JSON main/backup/tmp 与 secret 写入收敛为 `0600`；正常
store 加载可显式迁移合法 legacy secret 到 `0600`，而 `gateway auth status` 只验证不
改权限。secret 读取以 KiB 级上限约束，并先以 no-follow/inode 校验拒绝 symlink 与
非普通文件。JSON 文档经 `createJsonStore` 的 owner-only 原子写路径持久化，写操作
串行化，避免并发请求以旧 snapshot 覆盖新值。settings/worktrees/schedule 各自校验
document root/schema/revision：错误主文档回退有效 backup；合法 collection 内的坏行
单独隔离并告警，不能抹掉其他完整行。corrupt 主文件会先尝试 backup；双重损坏会响亮
失败，不伪装成空配置。早期预留但从无生产消费者的 `gateway.json`/devices/channels
文档已删除；旧文件仅忽略，不做破坏性清理，未来能力必须按真实领域 validator 重引入。

**凭据信封（v2，Phase 1）**：`password-credential` 与 `tokens.json` 均为
`{schemaVersion:2, source:'config'|'runtime', updatedAt:<epoch ms>, verifier|hash}`
（0600 原子写，无 tmp 残留）；`source` 记录凭据来自部署播种还是运行时变更，播种
策略见 §7.4。legacy v1（密码裸 `scrypt$salt$hash` 字符串、token `{"hash":…}`）读为
`source:'config'`（updatedAt = 文件 mtime），下次写入自动迁移为 v2。v2 的
verifier/hash 必须匹配 `scrypt$salt$hash` 规范形状
（`/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/i`）——形状合法但内容垃圾的文件按 corrupt
v2 处理（**每进程告警一次**，按未配置处理），杜绝「垃圾 verifier 静默废认证」。

**stateDir 独占锁（`.gateway.lock`，Phase 1 + 修复轮）**：`createGatewayStore` 以
**O_EXCL 优先**创建 `{"pid":…,"createdAt":…}`（0600，stateDir 0700 内）持有该目录：
活 pid 的锁**响亮拒绝启动**（结构化错误 `gateway_locked` + 属主 pid）；死 pid 的
陈旧锁以 **rename 认领 + 移动内容校验**接管：先 rename 到唯一 `.stale-*` 名（原子
认领，仅一个竞争者成功，其余见 ENOENT 重试），再校验被移动的正是读到的陈旧锁；
若移动了**新鲜锁**（读与 rename 之间另一竞争者完成了接管）则 rename 还原（覆盖
间隙中第三方的新锁——先到者胜，被覆盖者的**创建后所有权终验**会检出位移并
fail-closed）并响亮失败。不可读的锁文件（非普通文件/symlink/inode 竞态）响亮失败
（绝不销毁意外内容）；**可读但 pid 缺失/损坏**的锁文件按陈旧锁**接管并告警**
（`owner pid unreadable`）——它最可能是崩溃进程的残缺残留，接管后目录仍被独占
（fail-safe）。
`releaseLock` 双重守卫：未实际持有不删，且 on-disk 完整 bytes + inode identity 必须
仍与本次获取一致才删（仅比较 pid 不足以区分同进程重取/后继者）；**exit 监听器仅在
获取成功后注册**——获取失败的进程退出时绝不删除活网关的锁。创建后**所有权终验**
（回读 pid+createdAt + inode 必须与刚写入一致）——
被并发接管位移的获取者立即失败，绝不无锁运行。`GatewayStore.close()` 幂等释放，
`reacquire()` 供 start() 重试路径重取（design 17 §4.1）；进程 exit 也 best-effort
释放——同 stateDir 的重开必须先 close（测试与 `gateway auth` CLI 均依赖此语义）。
已知残差（诚实声明）：三个进程同时接管同一陈旧锁时，第三个进程可能在还原间隙
创建新锁并被覆盖——与所有 pidfile 锁相同，无内核 flock 时不可能数学消除；双进程
场景（生产现实：systemd + 手动启动）由上述校验**证明地**闭合（双进程压力测试锁定）。

**桌面凭据存储（`<userData>/gateway-secrets.json`，schema v3）**：

```jsonc
{ "schemaVersion": 3,
  "storage": "safeStorage", // 或 "plaintext"；文件级权威判别，禁止猜测 blob
  "tokens":   { "<id>": "<safeStorage 加密 blob | 0600 明文回退>" },
  "passwords":{ "<id>": "<同上>" },
  "tokenBindings":   { "<id>": "<sha256 gateway-domain fingerprint>" },
  "passwordBindings":{ "<id>": "<同上>" } }
```

- **OS keychain 集成（Electron `safeStorage`）**：加密优先——macOS Keychain /
  Windows DPAPI / Linux libsecret（kwallet/gnome-keyring）；落盘内容为加密 blob，
  密钥由 OS 保管（§13.4.1）；
- `safeStorage.isEncryptionAvailable()` 不可用（如 Linux 无后端、无登录会话）时，
  回退当前 0600 明文镜像（登记为既有用户决策的延续）；
- `storage` 是落盘事实而非当前 capability：密文永不以字符形状猜成明文；非空但缺少
  discriminator 的历史 v2 fail closed 并保留 `.corrupt`；plaintext 文件在 keychain
  后来可用时立即原子升级，升级成功后才投影 `safeStorage`，失败则继续诚实显示明文；
- token/password binding 与各自值同一次原子写；读取/注入必须匹配当前 registry 的
  gateway domain。当前配置路径内结构合法的 v1、带合法 storage 的非空 v2 没有可信
  target binding，启动时移动为唯一 `.unbound-<time>-<pid>[-n]` 恢复文件、禁用并
  要求显式重录；旁路旧 `gateway-tokens.json` 非空 v1 保留原路径并禁用，绝不从当前
  registry 猜绑定；
- 载入 gateway/SSH 凭据镜像均先 no-follow + regular-file + inode 校验，以已打开 fd
  `fchmod 0600` 后才读 secret bytes；宽权限旧文件不再原样使用，symlink 不跟随；
- 其余纪律不变：原子写、corrupt 响亮失败（保留 `.corrupt`）、删除实例/显式清除即删；
  凭据仅表单瞬时 write-only 输入，永不由主进程返回/回填或持久化到 renderer，也不进
  注册表/日志。

## 13. 安全模型

### 13.1 我们保证（软件纪律，可验证）

| 保证 | 机制 |
|---|---|
| 认证不减配 | 配置了凭据就一定注入且被 gateway 强制；401/403/421 如实分类（§7.3），绝无静默降级 |
| 秘密纪律 | token/密码仅以表单瞬时 write-only 输入进入 IPC，随后只在主进程内存 + safeStorage 加密落盘（0600 明文回退）；永不返回/回填或持久化到 renderer，也不进注册表/日志；删除/清除即删；头注入仅作用于本连接注册的反代目标，不跨连接泄漏 |
| 默认安全 | 缺省 https + 凭据；http 必须显式写 `http://` 前缀（`insecureHttp` 归一） |
| 诚实状态 | `insecureHttp`/凭据存在性进入非秘密投影；配置时安全姿态提示 + 卡片常驻徽标（`HTTP 明文`红标 / `无认证`灰标），配完不忘 |
| 边界诚实 | 探针/反代失败显式（503/401/421/403 分类），错配的 no-auth 网关绝不伪装成 ready |
| 不削弱既有门 | S12：普通 control-plane 仍 loopback-only 匿名；S1：服务器外部绑定仍默认要求凭据 |
| 凭据变更纪律 | 运行时凭据变更要求非环境性证明（bearer principal 自证或 currentPassword 校验，S25）；拒绝删除最后一个凭据（409，除非 config 提供替代 → revert）；变更与拒绝均审计（S24），值永不进日志/审计/投影 |

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
- **决策**：集成（§12 桌面凭据存储 v3）；`isEncryptionAvailable()` 为 false 时回退
  0600 明文（登记延续既有用户决策）；回退路径在 UI 设置页可见。

#### 13.4.2 mTLS 与证书固定 —— **证书固定集成，mTLS 槽位**

- **证书固定（SPKI pin）**：https 直连的可选高级字段——用户提供期望服务器证书的
  SPKI 指纹，desktop 登录/探针与 control-plane HTTP/WS 反代校验，不匹配即
  terminal/502。pin 是该连接的信任锚；请求必须等 `secureConnect` peer SPKI 匹配后
  才调用 `write/end` 或发 upgrade handshake，匹配前不发送 HTTP header、认证凭据、
  登录 body 或任何应用层字节，mismatch 的上游 handler/upgrade 观察为零。
  **价值：直接解决内部 CA 信任痛点**——Caddy `tls internal` 场景不再需要
  `NODE_EXTRA_CA_CERTS` 全局注入，改为在单条连接上钉住 Caddy 证书；同时对抗 MITM；
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

登录响应/失败永不含密码或 cookie 进日志；cookie 仅主进程内存持有、仅注入网络
origin + `Host` authority + exact connection-target scope 所有的目标，authority 从不
单独代表 ownership。scope invalidation 提升 generation 并使在途登录/探针/fallback/
重登结果失效；refresh epoch 及当前凭据/URL/pin/authority/scope 复验阻止同 id 重建的
迟到提交。provider hooks 必须 all-or-none，当前 generation 的 `cookie|bearer` proof
决定 ready 注册能否携带 Cookie 或经已验证 Bearer fallback；否则 fail closed，绝不
headerless。重登有界（一次 + 429 退避），不成为爆破放大器；session cookie 为
HttpOnly，桌面仅作代理转发头，renderer 永不可见。配置 HTTPS pin 时密码请求 body
也受 §13.4.2 pre-write 门保护。

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
smoke。release workflow 只在 macOS 与 Windows Desktop 产物门禁完成后 pack Gateway，
把 tgz 安装到干净临时前缀并执行 `gateway --help`，生成同名 `.tgz.sha256`，再把这两项
上传同一个 GitHub draft Release。**本阶段不执行 npm publish、不持有 `NPM_TOKEN`、
不维护 npm dist-tag；npm 正式分发明确延后。**版本门以数据驱动方式检查 root 与全部
非 fork `@dsh-chamber/*` 包，防止发布漂移；版本只经受校验的 workflow output 进入
shell，并先校验 canonical SemVer、tag peeled commit 等于 checkout SHA。所有发布全局
串行且不取消运行中事务；已公开的 GitHub Release 永不删除，只有 stale draft 可替换；
dry-run 无条件清空签名/公证环境变量与 `GH_TOKEN`（即使仓库已配置正式 secrets），
使用 `--publish=never`，不创建/修改 Release、不上传任何产物，只做 ad-hoc 本地验证。
正式构建不使用
仓库内固定的第三方 Electron mirror。

## 16. 验收门禁

### 16.1 自动化门禁

合并前必须全部通过：

- root、Gateway、所有 chamber client/host 包 typecheck；
- control-plane 协议、存储、托管、管理 API、静态服务、实例代理测试
  （含 gateway http 直连注册、头注入 0..2、dsh 直连禁注入用例）；
- Gateway config/auth/request-policy/dispatch/proxy/lifecycle/feature/真实 socket 测试；
- Gateway 运行时凭据面（Phase 1–3 + 修复轮）：auth 运行时变更/播种四规则/legacy
  迁移/stateDir 锁（活锁拒绝、陈旧锁 rename 接管、**失败获取不删活锁（子进程回归）**、
  releaseLock bytes+inode 复验、close/reacquire）、S25 匿名禁种（单元 + wire）、并发 remove
  串行化（永不双 null）、`{remove:true}`+新值互斥 400、`GET /auth/credentials` 投影
  与 HEAD twin、`/auth/*` 不跳登录页、dispatch 凭据路由与审计事件、`gateway auth`
  停机态 CLI；
- dsh-runtime 共享核心 typecheck/测试；Gateway runtime 启动事务/路由权限测试与
  fake-registry acceptance（design 18 §9.5）；
- Desktop 全量 transport/provider/secret/plugin/deep-link 测试
  （含 http 探针真实 server 测试、401 三态、SPKI pin 校验、safeStorage 回退）；
- renderer shell、sidebar、connections、settings-bridge、Git 插件回归；
- renderer 与 Gateway build；Gateway pack/install/CLI smoke；
- frozen lockfile、i18n、`git diff --check`、冲突标记扫描；
- release workflow 的 commit/tag 绑定、公开 release 不可变、dry-run 零写入、
  stable/beta desktop feed 隔离与 Gateway GitHub tgz+SHA256（零 npm publish）策略测试。

### 16.2 发布前实机门禁

自动化全绿仍不能替代以下实机证据：

1. 安装的真实 dsh：Gateway 启动等待 ready，登录后 `/`、普通 `/api`、events.mux/host
   HTTP/WS、插件 bundle 与 `/chamber/` 全部可用；
2. 生产型 TLS 反代：publicOrigin、Host、Origin、XFF、Secure cookie、WebSocket
   upgrade、未认证/错误 authority 行为逐项验证；SPKI pin 正/负例；
3. 打包 Desktop：新增 Gateway（https+凭据 / http 明文+凭据 / http 无认证三种形态）、
   重启后自动连接（safeStorage 解密 + 密码会话重登）、token/密码更新/清除撤销既有流、
   N-ctx 与 Gateway settings 页面（dsh-runtime 分节挂载差异验证：gateway 完整管理面
   （版本选择/状态/快照/更新/回滚/恢复内建/registry/restart 与轮询）/ dsh ssh
   版本只读 / dsh http 直连不挂载）；
4. 真 Git 仓库：创建/歧义恢复/删除重试、dirty/locked/主 checkout、运行中 session 与
   并发启动 session 的安全验证；
5. macOS 发布产物完成 Developer ID 签名/公证/安装；Windows 未签名产物验证安装与
   SmartScreen 已知提示（首版不把 Authenticode 当完成条件）；
6. 服务端 dsh runtime 实机：安装候选版本 → 重启 Gateway → 探针 → 故障注入回退 →
   `<stateDir>/dsh-home` 数据恢复；生产 TLS 反代下 `/chamber/runtime` 的 SSE/poll
   与认证行为（design 18 §9.5）；
7. 可信网络形态实机：`--bind 0.0.0.0` 明文 HTTP 直连（带凭据 / `--no-auth`）、
   SSH 隧道回环直连、tailscale 直连——四种组合全链路 + 401/421/403 负例。
8. 运行时凭据实机：生产 TLS 反代下浏览器/API 改密与 token 轮换（旧 cookie/bearer
   立即失效、`GET /auth/credentials` 投影、409/403/429 负例），以及停机态
   `gateway auth status` / `reset-password` / `clear` 的恢复链路。

PWA 安装、离线缓存和 UA 移动轻面不属于本轮验收；不再暴露无实现的 CLI flag。它们如需
推进，必须作为独立设计与测试面进入 STATUS。

## 17. 安全不变量摘要

| # | 不变量 |
|---|---|
| S1 | 外部部署无认证不能启动（默认；`--no-auth` 为有界偏差，服务器为唯一授权方） |
| S2 | HTTP 与 WS 使用同一 request policy 和认证 |
| S3 | 未经信任的 forwarded headers 永不影响 authority/client/TLS 判断 |
| S4 | 上游不可用显式 5xx，绝不 empty success |
| S5 | 密码/token 仅作表单瞬时 write-only 输入；不由主进程返回/回填、不进日志或子进程环境 |
| S6 | token/密码变更会撤销旧 cookie 或 live streams |
| S7 | transport id 只查注册表，不能拼接成 URL |
| S8 | 全进程 body 预算真实共享，backpressure 期间不提前释放 |
| S9 | 派生 session/pending 状态不跨 stream generation |
| S10 | Git 只作用于 dsh live workspace 派生的 canonical 路径 |
| S11 | 不确定的 Git 提交/归属永远选择保留与 recovery，不选择破坏性补偿 |
| S12 | Gateway 不能削弱普通 control-plane 的 loopback-only 门 |
| S13 | feature flag 是默认关闭的服务端能力门，禁用后停止后台 consumer/timer |
| S14 | dsh raw event queue 与 session 索引净化 buffer 都有硬上限，绝不持久保留会话正文 |
| S15 | POSIX：Gateway 新建 state 目录为 0700、既有 stateDir 只验证 0700（拒绝 broad root，绝不代 chmod）；Windows 目录保留继承 ACL 且只做 no-follow/identity；JSON/secret 为 0600，status 只读验证 |
| S16 | release 必须 commit-bound、公开记录不可变；desktop stable/beta feed 独立，Gateway 本阶段只发布 GitHub tgz+SHA256、不得隐式发布 npm |
| S17 | dsh runtime：无快照不切指针；切换/恢复中断由 durable journal/marker 幂等补完（design 18 §9.7） |
| S18 | dsh runtime：探针全绿才宣布 applied 并开放代理；回退目标 = 切换前版本或最近 known-good，绝不两棵坏树间交替 |
| S19 | dsh runtime：状态/凭据（registry 源、失败记录、install 子进程 env）不进日志；状态文件 0600/0700；install 源钉死 + env scrubbing |
| S20 | dsh runtime：切换不得削弱 S12（普通 control-plane loopback 门）；`/chamber/runtime` 全部认证后 |
| S21 | http 明文/无认证接入是显式用户决策（URL 协议 + 凭据留空）；UI 与文档如实注明风险，绝不静默降级 |
| S22 | 桌面凭据（token/密码）经 safeStorage 加密落盘；不可用时回退 0600 明文并登记；仅表单瞬时 write-only 输入，永不返回/回填或持久化到 renderer，也不进注册表/日志 |
| S23 | 证书固定（SPKI）为 https 直连可选门：peer 匹配前 desktop 登录/探针与 control-plane HTTP/WS 反代不得发送任何应用层字节；不匹配即 terminal/502，http 模式不得声称任何 TLS 保护 |
| S24 | 审计日志只记非秘密事件（时间/来源/认证结果），绝不包含凭据、cookie 与会话正文 |
| S25 | 运行时凭据变更需非环境性证明（bearer principal 自证或 currentPassword 校验，仅 cookie principal 拒绝 403）；运行时拒绝删除最后一个凭据（S1 不可在运行时削弱；none↔auth 双向转换仍仅部署期） |

## 18. 相关文档

- `03-connections-proxy.md`：共享 HTTP/WS proxy 契约；
- `04-control-plane-api-data.md`：管理 API、静态服务和数据边界；
- `05-connection-manager.md`：Desktop transport 与 N-ctx（kind/transport 扩展面）；
- `08-git-worktree-plugin.md`：迁移期保留的实例内 Git 路线；
- `18-dsh-runtime-version.md`：dsh 运行时版本管理的权威行为契约；§3.6 = per-server
  设置分节（local/gateway/ssh 三态挂载差异）、§9 = gateway 宿主实现设计；
- `docs/progress/STATUS.md`：当前验证证据和剩余实机门禁。
