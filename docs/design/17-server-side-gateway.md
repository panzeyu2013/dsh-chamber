# 17 · 服务端接入层（Gateway）与远程连接模型

> **服务端接入层 + 四维正交远程连接模型 + 移动端 Web 访问面**——
> `packages/gateway` 是显式启动、可认证的服务端形态：托管一份 loopback dsh，在认证、Host/Origin
> 与资源边界之后反代官方 Web 前端与 `/api`，并以独立的 `/chamber/*` 面提供受限运维面；
> 桌面按四维正交模型接入，客户端对弱模式（http 明文、无认证）不前置拦截，服务器是唯一授权方；
> 未完成门禁见 docs/progress/STATUS.md。本设计自包含：原 design 01 的编排规则不再作为本设计依据。

> **实现状态（2026-09 C 分层裁决，已落地为本仓基线）**：gateway 的**插件模型写路由已退役**——
> `/chamber/plugins/install|remove|undo|tasks|materialize` 不再存在，桌面不再有
> `gateway_plugin_apply` / `gateway_plugin_materialize` IPC；保留 `/chamber/plugins`
> （seed-cache GET/PUT，桌面供给面）、`/chamber/plugins/installed`（只读行投影）与
> `/chamber/runtime/*` 控制器。本文涉及写操作的段落为历史记录。

## 1. 定位与边界

`packages/gateway` 是 dsh-chamber 仓库内一个**显式启动、可认证**的服务端形态：

1. 托管一份始终监听 loopback 的本地 dsh；
2. 在认证、Host/Origin 和资源边界后反代官方 Web 前端与 `/api`；
3. 允许 Desktop 以 gateway 连接（http 或 https、可空认证）接入该入口；
4. 在独立的 `/chamber/*` 面提供受限运维面：dsh 运行时管理（design 18 §9.3）、
   凭据面板、插件同步种子缓存与通道投影（编排面剥离后仅剩这些）。

它不是普通 control-plane 的公网开关：普通 Desktop control-plane 仍 loopback-only、匿名、
只负责连接管理与同源反代，网络能力只在 `packages/gateway` 显式运行时存在。

### 1.1 传输安全责任划分（本设计的总原则）

- **Gateway 与桌面端都只提供 HTTP 语义**；HTTPS、穿透、隧道全部由**用户自建**（TLS
  反代 / tailscale / SSH 隧道 / frp / zerotier，任选或组合）；
- 客户端对弱模式（http 明文、无认证）**不前置拦截**，但**如实注明**：配置时的安全
  姿态提示 + 连接卡片的常驻徽标 + 文档的责任划分；
- `--no-auth` 完全由**服务器侧**校验与授权（S1 有界偏差），客户端不做模式选择——空凭据
  = 不带认证直接请求，由 gateway 决定放行或 401。

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

四维全部正交、开放联合 + 注册表驱动；新增任一维取值只触碰对应槽位，核心运行时与反代零改动（槽位总表见 §14）。

### 2.1 目标类型（kind）

| kind | 目标 | 认证面 | source id | 反代路径 |
|---|---|---|---|---|
| `dsh` | dsh web profile（loopback-only，无认证） | 无 | `dsh-<id>` | `/api/i/dsh-<id>` |
| `gateway` | gateway 部署（有认证面与 `/chamber/*` 面） | 可空 token/密码 | `gateway-<id>` | `/api/i/gateway-<id>` |

kind 决定**目标语义**：dsh 目标永不注入认证头、永不挂载 `/chamber/*`；gateway 目标可注入认证头、可挂载全部 gateway 能力（§3）。

### 2.2 传输方式（transport）

| transport | 机制 | 适用目标 | 认证注入 |
|---|---|---|---|
| `ssh` | SSH 隧道子进程（共享 ssh-tunnel 模块）+ systemd exec | dsh（默认 30800）/ gateway（默认 30801） | dsh 目标禁；gateway 目标可 |
| `http` | direct endpoint：http(s) 直连，无子进程 | dsh（穿透用户自建）/ gateway | dsh 目标禁；gateway 目标可 |

- **Provider 按 transport 注册**（`providers: { ssh: …, http: … }`），spec 内的 kind
  决定目标语义（verifyUp 是否带认证、能否注入头）——新增一个传输 = 一个 provider，同时服务两种目标；
- **UI 槽位**：连接设置插件维护 transport 表单 schema 注册表——每个 transport 声明自己的
  字段集/校验/提示（ssh 字段组 vs URL 字段组），表单按注册渲染；新增 transport 只需加 schema + locales；
- **迁移**：旧 `kind:'ssh'` 条目映射为 `{kind:'dsh', transport:'ssh'}`；旧 `kind:'gateway'`
  条目映射为 `{transport:'http'}`；source id 的 `ssh-` 前缀保留 legacy 兼容映射（deep link 可用）。

### 2.3 认证模型（可空、不前置、服务器权威）

- **输入**：gateway 目标下 token 与密码两个**独立可空**输入框；dsh 目标无认证字段；
- **语义**：填 token → `Authorization: Bearer`；填密码 → 主进程 `POST /auth/login` →
  持有 12h JWT cookie（`dsh_gateway_session`，HttpOnly，仅 HTTPS 边界附加 Secure）→
  反代注入 `Cookie` 头；两者同时存在时登录与 bearer 是**独立 OR principal**，客户端
  同时注入 `Authorization` + `Cookie`，gateway 接受任一合法身份（token 轮换不遮蔽有效密码会话，密码登录失败可由有效 token 继续）；**都空 → 无认证头直接请求，由 gateway 校验**（`--no-auth`
  部署直接放行；要求认证的部署回 401，客户端如实分类上报，见 §7.3）；
- **认证不是模式**：spec 不存 auth 模式；凭据存在性（`tokenSet`/`passwordSet`）与存储模式
  （`secretStorage`：`'safeStorage' | 'plaintext'`，S22）是主进程凭据存储的**实时非秘密投影**
  （`instances_get` 读时合并），用于 UI 显示「已配置」、卡片徽标与明文回退提示；
- **槽位**：认证 = 可注入头白名单（现为 `Authorization` + `Cookie` 两项，逐项校验）+ 会话管理器接口；
  未来 passkey（服务器 auth.ts 联合已含）/OIDC/客户端证书 = 增加头项或会话实现，反代与 UI 机制不变。

### 2.4 通道（服务器侧暴露面，channel）

- `direct`（bind 0.0.0.0/127.0.0.1）与桌面 ssh 隧道**不是通道**，不进 ChannelKind；
- `ChannelRegistry`（`packages/gateway/src/channels.ts`）已定型：
  `ChannelKind = 'frp' | 'tailscale' | 'zerotier' | (string & {})`，
  `ChannelProvider { start/stop/resolveEndpoint/probe }`；MVP 零实装，
  `/chamber/channels` 恒空、活性永远来自 live probe（§2.4 / §10.1；design 01 §5 权威边界纪律）；
- **发现流槽位**（未来）：桌面可经认证的 `/chamber/channels` 列通道、请求启动并解析端点、
  自动填充连接表单——接口已定义，本期不实装。

## 3. 能力差异与设置挂载（gateway vs dsh 直连）

**依赖 gateway 的功能（dsh 运行时管理、凭据面板、插件同步）只能经 gateway 连接触达；
直连 dsh（无论 ssh 隧道还是 http 直连）物理上不存在 `/chamber/*` 面，无法挂载。**
**dsh×http 组合禁用**——直连 dsh 的宿主被
browser-auth 门硬阻断（launch token 为远端进程内存随机数、不可远程恢复），无法
验证/附加；连接表单不提供该组合（http 传输 schema 只服务 gateway），
主进程 http provider `validateSpec` 拒绝 dsh kind（保存即拒绝、旧条目按无效丢弃）。
ssh 是 dsh 唯一传输。上游提供 token 检索机制后，恢复点 =
connection-form http schema `targetKinds` + http provider `validateSpec` 两处。
settings-bridge 按来源 kind 装配子 ctx，同一设置页对不同来源显示不同分区：

| 能力 | dsh（ssh 隧道） | dsh（http 直连） | gateway |
|---|---|---|---|
| dsh-runtime 设置分节（design 18 §3.6） | **不挂载**（与 http 直连列一致——远端运行时 systemd 部署、无 `/chamber` 管理面；重启经 connections 卡服务操作） | **不挂载**（无管理面、无 ssh 通道、无 `/chamber`） | 挂载，**代理 `/chamber/runtime`** 全功能（status/versions/select/apply/apply-now/rollback/cleanup-version/restore-pre-rollback/recover-metadata/restore-builtin/retry-apply/retry-restore/registry/restart/start，与 desktop 动作对齐；`start` = design 21 决策 12 的停机/错误/restart-exhausted 恢复原语） |
| 重启 dsh 动作 | `restart_service`（systemd IPC，连接管理面） | 无 | `/chamber/runtime/restart`（事务化受控重启，刷新插件挂载）；停机/错误/restart-exhausted 恢复 = `/chamber/runtime/start`（design 21 决策 12） |
| 第三方插件管理（install/remove/materialize/tasks/undo） | **已退役**（2026-09 C 分层；design 13 写面删除，仅剩 `plugin_list`/`local_plugin_list` 读面） | 无（无执行后端） | **已退役（design 21 A1 写面 2026-09 删除**）：install/remove/materialize/tasks/undo 路由与执行器全部删除；仅剩 `/chamber/plugins/installed` 读面与 `/chamber/plugins` seed-cache 供给面） |
| 网关编排入口（settings-bridge 导航） | 不挂载 | 不挂载 | **不挂载**——桌面设置不重放网关编排，审批/提问经侧边栏既有事实通道呈现 |
| 通知与审批转发 | 无（dsh 原生审批，前端承担） | 无（同左） | **无（随编排面剥离**——聚合视图是重复呈现，官方前端已覆盖审批全流程） |
| 派生会话摘要 | 无（会话业务由 dsh 前端直接呈现） | 无 | **无（随编排面剥离**——索引随 feature host 移除） |
| 跨会话调度 | 无 | 无 | **无（随编排面剥离**——dsh 没有定时能力，gateway 不添加） |
| Git worktree 编排 | 有（design 08 实例内插件） | 有（同左） | **无服务器侧记录（随编排面剥离**；侧边栏走 design 08 实例内插件——托管 dsh 由网关 seed chamber 宿主包，本地/gateway 同一通道） |
| chamber 宿主包 seed（client-graph / git-worktree / archive-cleanup；open-in 为 `localOnly`，桌面从不上传） | 远程 seed（design 13 插件同步） | **无**（seed 门控 `kind==='dsh' && transport==='ssh'`，http 直连无 ssh 通道） | **桌面同步**：`PUT /chamber/plugins` 上传 → 缓存 `<stateDir>/chamber-plugins/` → 每次 spawn 经控制面 seed 注入托管 profile；版本跟随连接的桌面 |
| 移动适配插件（`dsh-chamber-client-ui-mobile`） | 不适用 | 不适用 | **打包 seed（例外**：移动访问绑定 gateway、无桌面在场，插件随 gateway 发行物分发） |

装配规则（design 17 契约）：**gateway 连接** → 仅挂载 dsh-runtime 代理分节
（design 18 §3.6/§9.3：`/chamber/runtime`，路径由 canonical `gateway-<id>` 派生为
`/api/i/gateway-<id>/chamber/*` 同源代理，token 永不出主进程）；编排分区不挂载到桌面设置
——审批/提问经侧边栏既有事实通道呈现；网关自有的编排面整体剥离（§10），仅保留 runtime
控制器、凭据面板与插件同步。**dsh 直连** → 只挂 dsh 自身能力，任何 `/chamber/*` 请求
稳定返回 404/403。各资源独立失败，单一路由错误不抹掉其他已加载数据。

**就绪语义**：gateway 来源的 desktop `ready` 只证明
**gateway 进程**活着——就绪探针读的就是 `/chamber/runtime/status`，托管 dsh 是
独立进程（design 18 §9）。侧栏必须消费该响应的 `connectionState`，否则托管
dsh 停机窗口里来源"可点但背后不可用"（`+` 建会话必失败、运行环/pending/完成点
等挂载期事实缺失）。现行为：gateway 来源由 App 每 15s（仅前台）探一次
`/api/i/<id>/chamber/runtime/status`（`packages/dsh-chamber-client-core/src/managed-runtime.ts`）——终态停机
`stopped`/`error`/`restart-exhausted` 投影为该源 `phase`（状态点与
`status.stopped/error/restartExhausted` 文案复用）并置 `connected=false`
——按既有"断连来源"语义**整棵来源子树（行列表 + 归档入口）隐藏**、动作入口
随之禁用（有意的诚实投影：托管 dsh 停机时其会话数据
不可用），**并在来源头下方就地给出一行原因 + 恢复提示**
（`source.managedDown`，状态词复用既有 `status.*`；提示"前往 设置 → 连接 启动该
实例"，实际入口是设置面板的「管理连接」/connections 页的「启动实例」）。该说明
是**该来源在有说明时唯一的常驻 live region**（`role="status" aria-live="polite"`，空文本
零高）：容器常驻、只换文本；此时状态点
不再兼任 live region，非交互头部改用 `aria-describedby` 指向
该行而不是给它一个对 generic 角色无效的 `aria-label`。实测该状态下点击来源头
**到不了失败覆盖层**（壳能 boot、body 渲染空面板），因此该形态下**头部不再是
可激活入口**（无 role/tabIndex，点击/键盘处理器由 `headerActivatable` 直接短路，title 改为
说明原因）；设置面板同一状态
改用 `managedDshDown` 文案（"网关可达但托管 dsh 未运行"）。
`starting`/`restarting` 同样投影进 `phase` 并**一并折叠进 `connected=false`**——
dsh 尚未服务，动作入口只会 503，与终态
停机同一理由禁用（忙碌点仍显示）；`degraded` 按既有语义呈现为**未连接**
（`instanceConnected` 只认 `ready`），本投影不改
该语义；探针缺失/非 200/代理失败 **fail open**。

**判定事实的独立性**：托管态**不得**从合并后的 `phase`
反推——`phase` 是"托管态 ∪ 传输态"，两套词表都含 `error`，反推会把 SSH/隧道
失败误诊为"托管 dsh 停机"。聚合里新增**独立字段** `managedRuntimeDown`
（仅当 `kind==='gateway'`、传输 `ready|degraded`、且探针报告终态停机时为 true），
侧栏与设置面板只消费该字段。停机态与 connections 页「启动实例」的可启动三元组是同一个
（`stopped|error|restart-exhausted`），恢复入口仍在。
dsh 直连目标无此投影需求：其就绪探针直接探 dsh 本体。

## 4. 组合架构与生命周期

```text
Browser / Desktop
        │ HTTPS/HTTP（用户自建：TLS 反代 / tailscale / SSH 隧道 / frp）
        ▼
Gateway request policy ── auth ── fixed route dispatch
        │                         ├─ /chamber/* → gateway 自有面（channels/plugins/runtime/仪表盘）
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
6. 无 feature host 可启动：ready 过渡订阅仅把权威状态转发给 runtime 管理器
   （`syncFeatures`，design 18 §9.3）；
7. 任一步失败都会停止已打开的 server，下一次 `start()` 可重试。

停止时先同步关闭 credential mutation admission，并撤销
dispatch 追踪的下游 HTTP/WS（未读完 body 的请求不会卡住 drain）；同时中止
runtime transaction/install。已经越过 admission 的凭据写入不强行打断，而是持有
stateDir lock 等待其完整 promise、审计尾与持久化 tail 收敛；credential、runtime
两类 writer（插件同步缓存是同步 put，随请求收敛）都静止后才停止 control-plane、
managed dsh 并释放 state 根租约（`<stateRoot>/owner.json`）。启动失败回滚走同一屏障，绝不让旧 handler 在
新 gateway 取得锁后继续写；同一 handle 再次 `start()` 时才重新开放 admission。**例外**：
`/chamber/runtime` 是 gateway 自有 runtime 控制器（挂在 dispatch 面，不随 ready
detach）——dsh 停机/重启/applying 窗口内必须持续可轮询进度（design 18 §9.3）。
**design 21 写面扩展（已退役）**：`/chamber/plugins/*` 写路由与 executor 串行队列已随
2026-09 C 分层裁决删除，生命周期 writer barrier 不再有插件 executor 子进程纳入
quiesce/dispose；保留的 `/chamber/runtime` 写路由属 operator-scope。

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
（password/token 是否配置、`source` 与最后写入时间，永不含值）——**无锁只读**，运行中的
gateway 也可读；只读路径验证既有凭据文件已经是 `0600`，权限过宽时按不安全/未配置投影
且绝不以 `chmod` 修改文件；`reset-password --new PASSWORD` 以
`source:'runtime'` 写入新密码并先旋转 `jwt-secret`（12–1024 字符）；`clear` 删除
密码与 token，下次启动由部署配置重新播种（`--no-auth` 部署恢复匿名并打印 S1
告警）。后两者取 stateDir 的 state 根租约，**运行中的 gateway 会响亮拒绝**（结构化错误
`state_root_locked` + holder pid/flavor）并提示改用 Web UI（`/chamber/` 凭据面板）或
`/auth/change-*` API；用法错误退出 2，运行失败退出 1。
`serve` 的 boot 行打印**播种后的有效 auth kind**（§7.4）——runtime 凭据生效时
不再误报 `auth=none`。

兼容别名为 `dsh-chamber-gateway`。环境变量包括 `DSH_GATEWAY_HOST`、
`DSH_GATEWAY_PORT`、`DSH_GATEWAY_STATE`、`DSH_GATEWAY_DSH_PATH`、
`DSH_GATEWAY_PASSWORD`、`DSH_GATEWAY_TOKEN`、`DSH_GATEWAY_PUBLIC_ORIGIN` 和
`DSH_GATEWAY_TRUSTED_PROXIES`。

生产建议用 owner-only 的 systemd `EnvironmentFile` 或 secret manager 注入凭据；Gateway
从 managed dsh 与 Git 子进程环境按大小写不敏感规则剥离全部 `DSH_GATEWAY_*`。

### 5.1 配置硬门

- bind host 只允许 `127.0.0.1` 或 `0.0.0.0`；port 必须为 1–65535；
- 非 loopback bind、配置 `publicOrigin` 或配置 trusted proxy，任一成立即视为外部部署，
  必须有密码或 token；
- **有界偏差**：`--no-auth` 显式覆盖上述 S1 门，允许
  无认证的外部绑定，仅显式传参才生效（默认 fail closed），启动打印醒目安全
  告警；**客户端不前置校验该模式**（§2.3），服务器是唯一授权方；
- 密码长度 12–1024 个 JavaScript 字符（JSON 传输，允许 Unicode）；token 长度
  32–4096 且必须为 visible ASCII；
- 密码与 token 可以同时启用，不互相遮蔽（`password+token` 形态要求两者齐备）；
- `publicOrigin` 必须是无 path/query/userinfo 的 canonical HTTP(S) origin；
- trusted proxy 只接受精确 IP，不接受网段或主机名；
- `--tls-cert/--tls-key` 即使成对提供也 fail closed（内置 TLS 未实现，
  TLS 一律由用户自建的外部边界提供）。

**凭据播种语义（§7.4/§12）**：启动时 `seedCredentialsFromConfig` 把 `--ui-password`/`--api-token` 或 `DSH_GATEWAY_*` 播种进持久化凭据，四规则与来源冲突见 §7.4 播种表；runtime 来源保留。因此「改配置 → 重启」流程
不变；`--no-auth` 部署若已有 runtime 凭据则**有效形态已认证**——告警按播种后的有效 kind 判定（§7.4）。

**S1 门与 runtime 凭据的交互**：外部绑定的 S1 硬门在**播种之前**按**部署配置**判定——持久化 runtime
凭据不满足该门，此类部署必须显式 `--no-auth` 才能启动；loopback 绑定下 runtime 凭据正常生效。

推荐形态是 Gateway 监听 loopback，Caddy/Nginx 负责 HTTPS，并配置：

- `--public-origin https://gateway.example.com`；
- `--trusted-proxy <反代的精确 IP>`；
- 反代覆盖而不是追加 `X-Forwarded-For/Host/Proto`；
- 只把 Gateway 的监听端口暴露给该反代。

可信网络替代形态（本设计一等支持，风险自担）：`--bind 0.0.0.0` 明文 HTTP 直连，
或经 tailscale/SSH 隧道/frp 到达——加密由隧道层保证，认证由 token/密码（或显式 `--no-auth`）保证。

`install-gateway.sh` 一键安装器（design 17 部署 + design 18 运行时管理）覆盖上述
形态：交互向导确认 bind/凭据/服务形态，`--no-auth` 有二次确认步骤；「精确版本」
步骤列出 GitHub Releases 全部可用版本（稳定/预发布 + gateway 资产标记，经 node
解析，不依赖 release 顺序）供序号选择或手动输入（可带 `v` 前缀），beta 通道按
`prerelease` 标记解析最新预发布；提供 install/update/restart/status/logs/uninstall
子命令与 `--purge`。

安装形态的**登录环境**：unit 带 `User=` 时 systemd 按 passwd 推导 `$HOME/$LOGNAME/$SHELL`；
「当前用户运行」（`--service-user` 缺省）的 unit 不带 `User=`，systemd 什么都不设（systemd.exec
`SetLoginEnvironment=` 的默认真值只对 `User=`/`DynamicUser=`/`PAMName=` 成立），故安装器生成 unit
时显式注入**运行用户**的 `HOME/LOGNAME/USER/XDG_CONFIG_HOME`——缺了它，gateway 及每个子进程
（managed dsh → 代码运行时 → bash 工具 → gh / npm / git credential.helper）从空 HOME 起步：gh 报
「未登录」、npm 找不到缓存、git 凭据助手取不到 token。注入值取自 passwd，不读安装者环境的 `$HOME`
（`sudo` 会带入调用者 HOME，正是要避免的错值）。

**被否方案**：`SetLoginEnvironment=yes`（语义等价）不在 systemd v253 的 systemd.exec 指令表里，
写进旧发行版的 unit 只会得到「未知指令」告警、环境照旧为空——静默失效正是本次缺陷的同类；
无条件注入 `Environment=HOME=…` 会把安装者的 HOME 写进 `--service-user` 的 unit，
而服务用户的家目录必须由 systemd 按 passwd 推导。

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
| `/chamber/*` | Gateway 运维/API/页面 | 必须 |
| `/chamber/runtime*` | Gateway runtime 控制器（design 18 §9.3；不随 ready detach） | 必须 |
| `/api/remote.mux` upgrade | 单目标 Gateway proxy（0.1.2 wire；旧 events.mux/events.host 下行已随上游删除） | 必须且同一 Host/Origin 策略 |

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
- 代理到 dsh 前端的响应头取自 `packages/gateway/src/dispatch.ts` 的
  `GATEWAY_PROXY_CSP`（gateway-only 放宽）：`script-src` 放开 inline（被代理的文档是
  上游自己的内联 `__DSH_BOOT__`/loader 脚本不带 nonce，本进程只插入 S0 头补丁（信任声明与 WebKit 原生源码归一）、不为不属于
  自己的脚本回填 nonce）；`base-uri` 取 `'self'` 而非 `'none'`——上游
  `@deepseek-ai/dsh-host-frontend-static` 每个 renderIndex 文档都注入 `<base href="/">`，
  `'none'` 会让浏览器拒绝该元素。该放宽按「元素必须生效」记账：固定 pin 下 `serveStatic`
  只在 dist 根与 index 路径渲染 HTML（其余路径是文件读取，miss 即 404），相对资源 URL 本就
  解析正确；只有上游真的用 index 回答深链（其注释所称的 "SPA-fallback paths"）时，该元素才
  决定 `./assets/…` 是否按站点根解析。其余指令与 shell 的 nonce CSP 逐字一致。

桌面端对 401 的**可行动三态分类**（探针层，非秘密 detail）：

| 场景 | 分类 | 文案要点 |
|---|---|---|
| 未配置凭据/密码会话过期 | terminal（重登一次后仍失败） | 「gateway 要求认证（401）——配置共享 token 或密码」 |
| 配置了错误 token | terminal | 「gateway 拒绝了 token（401）——检查共享 token」 |
| 密码被拒 | terminal | 「gateway 拒绝了密码认证——重新输入密码」 |

当 token 与密码同时配置时，失败分类以**联合探针最终结果**为准：一项凭据失败而另一项身份
有效仍是成功，不能因“token 优先”或“密码优先”遮蔽可用的独立 principal。该 OR 契约也覆盖
token scrypt work gate 饱和：Bearer 校验返回 `auth_busy` 时仍先验证现有 Cookie；有效即成功，
否则才保留 503 `auth_busy`，不能把过载伪装成 401。

### 7.4 运行时凭据管理

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
都不再暴露。原子 rename 已经发布、但父目录 fsync 报错时，Gateway 以稳定 exact-hash
readback 判定在线 token 确已生效：生成型 token 仍必须返回这一次明文，响应额外带
`durability:'unknown'`，提示崩溃持久性未获证明；无法 exact readback 时仍返回 500。

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
凭据。dispatch 认证门将成功 principal 捕获为同 provider、同 generation 的进程内
proof，凭据变更与审计直接复用它（bearer 每请求只做一次 verifier）；排队期间跨
generation 的 proof 拒绝 401，绕过 dispatch 的内部直调未提供 proof 时仍完整复验。

**last-credential 门 + config revert**：删除最后一个凭据（另一维度也不存在时）
拒绝 409，除非部署配置提供替代——此时**回退**为 config 凭据（响应
`source:'config'`，旧 cookie 因 rotate-first 已死）。S1 门不可在运行时削弱：
none↔auth 双向转换仍仅部署期（config 播种 + 重启）；删除最后凭据只能停机态
`gateway auth clear`。**config 管理维度的 remove 语义**：删除 config 来源维度
成功，但**下次重启会被播种恢复**——面板如实提示
「removed for now … re-seeded on the next restart」。

**rotate-first（S13）**：密码变更先旋转 `jwt-secret` 再持久化——持久化失败也绝不
留下「新 verifier + 旧 cookie」混合态；旧 cookie 在变更瞬间立即失效。

dispatch 认证边界按 credential generation 统一追踪所有已认证 HTTP response 与 WS
socket；generation 在首个凭据 store side effect **之前**提升，因此成功提交与
「rename 已发布但 durability unknown」/密码 rotate-first 后续失败都会关闭旧
generation 的全部长连接（management、instance fallthrough、gateway proxy），
仅排除变更请求自身 response 以完整返回一次性 token 或错误。
Gateway 停机则先关闭 credential mutation admission、销毁当前认证流，再等待已经进入
的 change route 完整收敛（包括错误路径与审计 append）；stateDir owner 不会先于凭据
writer 释放。
proxy 不再承担 credential-only 关闭回调；其 close primitive 只服务自身
stop/lifecycle 清理，避免重复 teardown 与覆盖遗漏。

**审计（S24）**：`credential_changed` / `credential_change_rejected`——detail 仅含
维度、set/remove、source、认证门已确认的变更前 principal kind（成功事件）与
客户端来源；拒绝事件 detail 含维度 +
wire code + 客户端来源；任何值永不进入审计。`audit.log` append/rotation 绑定
single-link inode，O_NOFOLLOW/O_APPEND、完整写 + file fsync，archive 也在 rename 前
验证 leaf identity 并在发布后 fsync parent；审计 I/O 失败非业务致命，但不允许
跟随 active/archive symlink 或修改外部 victim。

**与 desktop 客户端的关系**：凭据变更后旧 cookie/bearer 立即失效，desktop 的 401 三态分类（§7.3）覆盖「凭据被换」后的行为；token 仅一次性返回，轮换方须就地保存；desktop settings-bridge 侧的凭据便捷重置入口为**推迟项**（变更一律走 `/chamber/` 凭据面板）。

## 8. 反代内核与资源边界

Gateway proxy 与 per-instance proxy 共用 `proxy-forward.ts`，协议行为相同：

- 上游 Host 固定改写为目标 origin；浏览器 Origin 改写为目标同源；
- 请求剥离 cookie、authorization、hop-by-hop、`Forwarded`、`Via`、全部
  `X-Forwarded-*` 和 `X-Real-IP`；只有注册 transport 的受控 extra header 可重新注入；
- `accept-encoding` 只对**必须 identity 的两类请求**剥离（判定 `proxy-forward.ts`
  `requiresIdentityUpstreamEncoding` = `isHtmlDocumentNavigation` ∨ `acceptsEventStream`）：
  ① HTML 文档导航（GET/HEAD + `Accept` 含 `text/html`，路径不在 `/api`、`/plugins`、`/auth/…`、
  `/chamber/<subpath>`，且不是内容寻址的 `/assets/<name>-<hash>.<ext>`）——S0 头补丁注入的前提：
  `htmlInjectable` 要求上游 `text/html` 未被编码，`html-inject.ts` 依赖它写入
  `__DSH_TRANSPORT__` 与原生源码归一脚本；② `Accept` 含 `text/event-stream` 的 SSE 请求——**不是文档导航，而是传输层
  保险**（远端/旧版实例未必带 pinned gzip filter，长流被压缩即被缓冲）。其余请求把压缩协商交给
  上游 gzip 中间件（dsh-host-webserver `createGzipMiddleware` 自身拒绝 `text/event-stream` 与
  `content-range`），回程 `content-encoding`/`vary` 已在响应白名单内——该取舍修订 2026 audit M3b
  的「一律剥离」；
- 响应头组装提供窄 seam `ProxyForwardDeps.onUpstreamResponseHeaders(pathname, status, headers)`
  （`forwardHttp`，默认 `undefined` = 零变化）：owner 可补上游缺失的表示元数据，gateway 用它给
  内容寻址静态资源加 immutable `cache-control`（上游 dsh-host-frontend-static 只写 `content-type`；
  命名判定 `isHashedStaticAssetPath`，绝不匹配 `favicon.svg`/`manifest.webmanifest`/`index.html`）。
  **seam 的两条硬边界**：其一，回调返回后响应头映射会被 `RESPONSE_HEADER_WHITELIST` 再过滤一次，
  回调写入的 `content-length`/`transfer-encoding` 或任何非表示元数据都到不了线上，framing 始终是
  代理自己的（`content-length` 过滤后按上游声明重算）；其二，gateway 侧只在「200 + 命名命中 +
  上游未给 `cache-control`/`etag`/`expires` + `content-type` 与该扩展名相符」时才盖章——路径本身
  不是载荷证明：把 miss 回退成 index 的 dsh（旧版 frontend-static 就是）会用 `text/html` 200 回答
  资源 URL，给它 immutable 等于把 HTML 按脚本 URL 缓存一年并跨版本回滚存活；
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

已声明 body 预分配单一 buffer，避免 chunks + `Buffer.concat` 的双倍峰值；进程预算在
上游完成消费或流被撤销前不提前释放。

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
- 上述域绑定**持久化在凭据文件中并在每次读取/注入时与当前 registry 精确复验**：
  secret 先 fsync、registry 后 fsync 的崩溃窗口只令新值暂时不可见，绝不把新目标
  凭据发给仍在 registry 中的旧目标；新增/进入/离开/retarget 即使表单留空也强制写入或
  清除该维度，防止同 id + 同域重建复活半事务 secret；
- 删除只走精确 id-addressed `desktop_ssh_delete_connection(id)` main-owned transaction：
  先断开并撤销该 connection-target scope 的全部历史 origin 会话、清两类 durable secret，
  最后删 registry；不存在 id 为幂等 no-op。三个单项 credential setter 只接受
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
endpoint-verify.ts  dsh：session/canOpenWorkspacePath 统一身份（零参 boolean Remote；老树 404 → legacy session/list 签名回退）；gateway：认证后 runtime status identity
providers: { ssh: sshTransport, http: httpTransport }    // 按 transport 注册
```

探针认证矩阵（verifyUp 按 `spec.kind` 决定是否带认证）：

| kind | transport | verifyUp |
|---|---|---|
| dsh | ssh | 隧道端点 session/canOpenWorkspacePath（固定小体积 boolean，64 KiB cap；404 → signature 回退 legacy session/list，识别为 "check or upgrade"），无认证头 |
| dsh | http | 直连端点 session/canOpenWorkspacePath，无认证头（用户自建穿透；dsh×http 组合已禁用，表行保留为契约记录） |
| gateway | ssh | `GET /chamber/runtime/status` + 精确 `kind:'dsh-chamber-gateway-runtime'`，可选 0..2 认证头 |
| gateway | http | 同上（直连 http(s)）；托管 dsh blocked/down 时 gateway 仍可 serviceable |

Gateway 身份判据不依赖 managed dsh 的会话面：runtime controller 不随
dsh ready detach，故 blocked/applying/restart 窗口仍可注册反代、打开恢复动作；
dsh 目标仍用统一身份握手（`session/canOpenWorkspacePath`，与本地就绪同
契约），两层健康不得混为一个 ready 位。

**gateway 密码会话 ownership**：`gateway-session.ts` 的 key 由三部分构成：网络 origin、
HTTP `Host` authority、稳定的 connection-target scope。scope = connection id + 目标摘要
（SSH：transport/host/user/sshPort/remotePort；direct：http transport/host/remotePort），
刻意不含易变的 tunnel localPort；故不同 direct id 即使同 origin 也不共享 Cookie，同一
localPort/远端 loopback authority 被不同 SSH 主机或 id 复用也不串会话，同 id retarget 进入
新 scope。authority 只负责路由，不代表 ownership：SSH 固定为远端真实监听 `127.0.0.1:<remotePort>`，
`spec.host` 只是 SSH destination（可为 ssh-config alias/DNS 名），绝不能触发 gateway Host
policy 421。隧道重连的新 origin 会重新登录；scope invalidation 覆盖该连接目标的全部历史
localPort/origin。

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
  健康 transport 永不骑过期 cookie（否则旧 Cookie 在残余窗口持续 401 直到重连）；
  armed on ready、disarmed on 离开 ready/移除/退出。每个 id 的
  arm/disarm/dispose 都提升 refresh epoch；任一 await 后、retry/register/reconnect 前
  复验 epoch 与当前 password/token/URL/SPKI pin/authority/scope，阻止同 id 重建或
  retarget 的迟到刷新提交；
- **刷新失败→有界重连走 verifyUp**：预过期重登失败（网络/429/503）保持旧注册
  并在过期时刻重试；已过期后仍失败则如实告警，残余
  窗口交给断开→重连路径（verifyUp 用存储密码重登），绝不静默。
- **ready 态周期再验证 + 用户意图即时探测（transport-manager）**：
  预过期刷新只覆盖"缓存 TTL 到期"，**服务端提前吊销**（远端改密轮换
  jwt-secret、gateway 重启、auth:none→要认证）与 **http 直连/隧道后实例死亡**
  在刷新定时器触发前长期呈现为 ready（绿点 + 401/502 洪流，无自动恢复）。
  因此每个 READY 传输以 `READY_VERIFY_INTERVAL_MS`（60s）周期重跑 provider
  `verifyUp`：gateway 密码目标经
  `verifyGatewayPasswordSession` 的"缓存 Cookie 探测 → 401 → 失效 → 用存储密码
  单次自动重登"流，仅被吊销的会话**无感自愈**（会话轮换后经 `onVerified`
  按注册认证头指纹差异重注册代理——`registerInstanceTransport` 会撤销在途流量，
  故只有 Cookie 真变化才替换）；重登仍被拒 → 终态
  `error:requires_user_action`（红点 + 连接页「重新输入密码」）；瞬态失败 →
  复用隧道掉线同款 `scheduleReconnect`（degraded → 有界重试 → error + 慢速重探）。
  生命周期锚点 = transport-manager `transition()`：进 ready 武装、离开 ready
  取消，无独立 arm/disarm 面；单飞 + epoch 围栏，探测结果不跨代提交。
  用户点击来源头/打开会话（renderer `selectView` 单点）经
  `desktop_ssh_reverify` 立即触发一次探测（`READY_VERIFY_MIN_INTERVAL_MS` 10s
  静默窗 + 单飞防叠）。
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

> **编排面已整体剥离，不得回流**：审批/提问（dsh 原生，官方前端
> 承担）、跨会话调度（dsh 没有定时能力，gateway 不添加）、会话索引（唯一消费者
> 是仪表盘）、Git worktree 服务器侧记录（侧边栏走 design 08 实例内插件，托管 dsh
> 由种子机制注入宿主包）、功能开关（`/chamber/settings`）与 feature host 全部移出
> 范围——这些域在 gateway **没有任何管理 API 或 UI**（相关路由一律 404，§10.5）；
> 重建它们等于把 dsh 宿主能力复制进控制面，违反 AGENTS.md 边界。存活的编排面
> 只有四件事：

### 10.1 `/chamber/channels`

通道注册表只读投影（§2.4；MVP 空实现）。

### 10.2 `/chamber/plugins`（桌面同步的宿主包种子缓存）

三个 chamber
宿主包（`dsh-chamber-seed-client-graph`、`dsh-chamber-seed-git-worktree`、`dsh-chamber-seed-archive-cleanup`
（design 24）；`dsh-chamber-seed-open-in`（design 20 §6）虽在派生白名单里，但注册表标
`localOnly`，桌面从不上传——其缓存目录恒缺席，spawn 时按既有规则跳过）不随 gateway 发行物
分发——连接的桌面经 `PUT /chamber/plugins` 上传自己的副本（包名白名单 + 文件
大小上限 + `package.json` 名称/版本校验，原子 0600 写入 `<stateDir>/
chamber-plugins/<scope 剥离 slug>/`（如 `chamber-plugins/dsh-chamber-seed-client-graph`，
不落全限定包名），`GET /chamber/plugins` 返回非秘密投影（name +
version）。每次 spawn 时控制面种子注册表从缓存注入托管 profile，因此：

- **版本语义**：托管 dsh 的宿主包 = 最后一次同步的桌面版本（多桌面不同版本 =
  后同步者覆盖，`instance-version-conflict` 继续兜底）；双发布线漂移消除；
- **激活探针形态化**（design 18 §9.3）：缓存缺包（fresh gateway 未同步）时托管
  dsh 是纯 dsh，探针跳过 `clientGraph/graph` + `gitWorktree/previewCreate` 两域
  （`hostDomains=false` + 缩减期望集），缓存就绪后恢复全域验证；
- **首连时序**：桌面 ready 注册后自动同步（幂等），有变更时请求
  `/chamber/runtime/restart` 让运行中的托管 dsh 刷新挂载（失败仅告警，下次自然
  spawn 自动补上）；
- **移动例外**：`dsh-chamber-client-ui-mobile` 不参与同步——移动访问绑定
  gateway（链路无桌面），插件随 gateway 发行物打包 seed（§3 装配矩阵）。

**第三方插件管理（写面已退役，2026-09 C 分层）**：托管 profile 的第三方插件写面
（design 21 A1：`PUT …/install`、`POST …/remove`、`PUT …/materialize`、`GET …/tasks`、
`POST …/undo` 及串行队列/持久 journal/executor）已全部删除。**仅保留读面**：
`GET …/installed` = readManifest 投影（`dependencies` + **加性 `rows`**（role/protected）、
file: 值掩码、profile_absent 404 / profile_corrupt 500）。

### 10.3 `/chamber/runtime` 与 `/chamber/` 仪表盘
dsh 运行时版本管理（design 18 §9.3）——`status`/`versions` 投影、`select`/`apply`/`rollback`/
`restore-builtin`/`retry-apply`/`retry-restore`/`restart`/`start` 动作（`start` = design 21 决策 12 停机恢复
原语：仅 stopped/error/restart-exhausted，恢复门不可绕过，202 + status 轮询）、`registry` 源设置（owner-only
0600）；`restart` = 事务化受控重启托管 dsh 刷新插件挂载（design 18 §3.6 项 8/§9.3：202 + status 轮询，指针
不动、无快照/探针）；该面挂在 dispatch 的 runtime 控制器上、**不随 ready detach**（dsh 停机窗口可轮询进度）。
仪表盘 = **Credentials 面板 + Runtime 块**（settings/approvals/sessions/schedule/worktrees 区块随编排面删除）。

浏览器可在 `/chamber/` 打开 Gateway 自有运维页；runtime 块完整呈现版本/来源、选择与
apply/rollback/restore/retry/restart 动作、失败/快照/磁盘与 registry，且在 managed dsh blocked/down 时仍可
轮询恢复。页面只使用同源 cookie/fetch，**不持久化** token（轮换明文仅一次性展示、复制或 60 秒后自动清空）。
桌面 settings-bridge 不挂载网关编排分区（§3 装配规则），仅保留 dsh-runtime 代理分节（design 18 §9.3），
同样不接触 token。仪表盘不再展示 settings 文档修订号（json-store 内部写入计数器，无运维信息量）。

Credentials 面板（驱动 §7.4 三个端点）：两行投影（password/token 的 `source`/`updatedAt`，来自
`GET /auth/credentials`，绝不含值）+ 改密/删密码/轮换 token/删 token 动作。轮换后的 token 明文在只读
textarea **一次性展示**（成功复制后即清空，60 秒未复制自动清空；不落 localStorage、不进审计）；403
`ambient_principal_rejected`、409 `last_credential`、429 等错误按 wire code 映射为可读文案（「输入当前密码以
变更凭据」「不能移除最后一个凭据——先配置替代」等）；删除 **config 管理**维度时如实提示「removed for now —
重启后重新播种」。

**页面内确认对话框（补齐 `aria-modal` 的
承诺）**：本页破坏性动作不走浏览器原生 `confirm`，而是页面自带的一层：

- **标记**（`routes.ts:227-236`）：`#confirm-backdrop.dialog-backdrop[hidden]` 内含 `#confirm-dialog`
  （`tabindex="-1"` + `role="dialog"` + `aria-modal="true"` + `aria-labelledby="confirm-title"` /
  `aria-describedby="confirm-description"`）= 标题 + 正文 + `#confirm-pending`（`role="status"
  `aria-live="polite"`）+ 动作行 `#confirm-actions`（Cancel + 危险色 Confirm）。两个背景地标
  `<header id="page-header">` / `<main id="page-main">` 带 id，专供脚本施加 `inert`。
- **控制器**（`chamber-assets.ts:556`，`confirmArmed` 单飞）：`armConfirmDialog` 填充文案——**全部经
  `textContent` 写入**（插值不会被当作 HTML 解析）并把焦点移入对话框（Cancel，最不破坏性的控件）；
  `acceptConfirmDialog` 恰好启动一次 runner，随后对话框变成不可取消的进度面；`dismissConfirmDialog`
  （Cancel / Escape / 遮罩点击）**什么都不做**：runner 在被调用前就被丢弃，不会有请求离开页面。
- **`inert` + Tab 陷阱覆盖整个武装期**（F1）：武装即给两个地标置 `inert`，关闭时**先**解除再交还焦点
  （`inert` 的调用控件拿不回焦点）；Tab 陷阱在动作 pending 期间**仍然生效**（两个控件已 disabled、对话框内无
  环可绕，焦点被送到对话框容器自身）。`aria-modal="true"` 是页面必须兑现的承诺：此前实现在确认被接受当刻
  就关掉陷阱，Tab 于是走到页背后（`#open-dsh`、`#refresh`、`#cred-change-password` 这个自身无确认的 POST
  门，以及运行时的全部控件）。
- **`aria-busy` 挂在动作行而非对话框**（F2）：`#confirm-pending` 是对话框的后代，辅助技术可能不播报 busy
  子树内的变化，把忙碌标记挂在祖先会吞掉它本该伴随的那条播报。
- **使用面 = 凭据移除的两处**（`removePassword` / `removeToken`，`chamber-assets.ts:701`/`:756`）；本页其余动作
  （apply-now / restart / registry…）仍由各自控件直接触发，没有确认对话框。

### 10.4 桌面连接卡的 gateway 主机日志

gateway 自己的控制面复用 control-plane 管理面（dispatch 在 dsh 代理 fallthrough
之前认领 `/api/host/*`，§8 反代内核），因此桌面 connections 设置页对
`kind==='gateway'` 的主机提供「主机日志」入口，经实例代理取
`GET /api/i/gateway-<id>/api/host/logs`（`limit`/`offset` 参数、
`{port, lines, truncated}` 响应形状与本地卡完全一致，主进程注入 sanctioned
Authorization/Cookie，renderer 不持 token）；内容为 gateway 进程 + 托管 dsh spawn
的滚动日志（gateway stateDir）。会话内容日志仍属宿主前端域，控制面不消费
（AGENTS.md 边界），不在此面暴露。

### 10.5 浏览器直连的能力边界

浏览器直接访问 gateway 根路径 `/`（经认证入口的同源页面）得到**托管 dsh 实例自身的官方前端**：
`/`、`/plugins/*`、`/api/*` 经 gateway-proxy 反代到托管 dsh（§8），浏览器侧不加载任何
chamber 代码。chamber 插件（sidebar/layout/settings-bridge/git/open-in 等）只随桌面复合 bundle
分发，不注入 gateway 托管前端，故浏览器直连没有「连接管理 / 设置壳 / 侧边栏」等扩展面。

- **官方设置页的 loopback 门控由 gateway 出口信任声明解除**（S0）：官方 `dsh-client-ui-settings` 以
  `ctx.remote.$host.isLoopback` 决定持久化模式——`isLoopback=false`（非 loopback 主机名访问）→ `persistence='memory'`
  → 设置 scope 终态 `unavailable`。gateway 代理出口对托管 dsh 的 `text/html` 文档（≤64KiB、identity 编码、
  幂等、fail-soft）注入 `window.__DSH_TRANSPORT__={ownsHost:true}`（上游文档化钩子契约，
  `packages/gateway/src/html-inject.ts`），使官方前端 `connection.isLoopback=true` → 设置持久化进入
  host 模式，浏览器直连（任意 origin）的 settings/models/插件面可用并写宿主。**信任决策**：auth 门在先、
  能登录即受信（`--no-auth` 可信网络部署同语义）——非鉴权绕过（服务端 RPC 不区分来源，该门是纯
  客户端 UI 策略）；上游移除钩子/改压缩行为则注入静默失效（fail-soft，设置退回受限态，升级 dsh 版本需
  复验）。实现与验收见 STATUS.md「http 连接链路修复（S0/S2）」。
- **WebKit 原生源码归一（S0 头补丁之二，design 14 §D4）**：同一个 `html-inject.ts` 出口还把**只作用于内建函数**的
   `Function.prototype.toString` 空白归一脚本插进同一批文档（与信任声明**各自幂等**：已声明 transport 钩子的文档仍会得到它）。
   JavaScriptCore 对**内建函数**打印多行 `{ [native code] }`，而 pin 住的 `@deepseek-ai/dsh-util-values`
   `hasIntrinsicConstructor` 与单行模板严格比较 ⇒ 判定恒假 ⇒ `snapshotJsonValue` 对普通对象/数组返回 `undefined`
   ⇒ 官方前端的会话 raw-chunk 校验抛普通 TypeError，`doOpen` 只对远程失败写 `error`，页面永停 `loading`。
   chamber 自建前端由 renderer 构建期的第三类 vendor 补丁覆盖（design 14 §D4）；**代理的官方前端无法在这里重建**，
   故在出口做等价归一（V8 无变化；只有整段源码就是原生标记的函数被改写，用户函数原样返回）。
   **取舍**：该页面的原生函数源码文本变为规范单行；**删除条件** = 上游携带引擎无关判定
   （`docs/progress/todo/upstream-proposals.md` §9）或支持的 WebKit 基线已打印单行形式。
- **`/chamber/` 运维仪表盘**是浏览器侧的运维面（§10）：同源 cookie 会话、Credentials 面板与 dsh
  运行时管理（版本 / 选择 / apply / rollback / restore / retry / restart / registry）；它是 gateway
  自有的运维入口，与托管前端并列，不依赖桌面插件，且**不随 ready detach**（dsh 停机窗口可轮询恢复）。
  编排投影与功能开关已随编排面整体剥离（§10），仪表盘只剩凭据与 runtime 两块。
- **token-only 部署浏览器无法登录 `/chamber/`**：仪表盘只用同源 cookie（`/auth/login` 密码会话），
  不消费 bearer token（token 只作桌面客户端的 `Authorization` 头，§7.2）——仪表盘面向配置了密码的
  浏览器管理员；桌面客户端仅经 settings-bridge 的 dsh-runtime 代理分节触达 `/chamber/runtime`
  （§10.3/design 18 §9.3）。**后果**：调度、worktree、settings 等编排域已整体删除，相关路由
  （`PUT /chamber/settings`、`POST/DELETE /chamber/schedule`、`DELETE /chamber/git/worktrees/…`）
  一律 404；存活的 `/chamber/*` 面只有通道投影（`GET /chamber/channels`）、
  插件同步缓存（`GET/PUT /chamber/plugins`）、runtime 控制器（`/chamber/runtime/*`）与仪表盘静态资源。

### 10.6 登录页阶段预热（pre-auth warm-up）

**是什么**：未认证访客停留在 `/auth/login` 期间，登录页在 `<head>` 为每个已发现的客户端 bundle 渲染
一条**真实 URL** 的 `<link rel="prefetch" as="script" href="/plugins/??<pkg>/client.js,…&rev=<token>">`
（开关默认开：`--no-warmup` / `DSH_GATEWAY_WARMUP=0` 关），并**只在这一个页面**下发一枚短时 HttpOnly
capability cookie `dsh_gateway_warmup`（HMAC(`exp|warmup|<client>`)，密钥自 stateDir 的 jwt-secret 派生，
域分隔标签 `dsh-gateway/warmup-cookie/v1`，TTL/Max-Age 120 s，`Path=/`、`HttpOnly`、`SameSite=Lax`、
安全请求再加 `Secure`）。登录成功后的首屏从 HTTP 缓存取用整册前端 bundle（实测约 4.35 MiB gzip），
这份下载不再落在关键路径上。登录页自身仍无脚本（C1 不变），`connect-src 'self'` 是唯一的 CSP 增量；
它是**静态常量**：kill switch 关闭或发现失败时 HTML 逐字节回到旧模板，但该指令仍在响应头里（页面无脚本，
inert；复核实测）——要让响应头也条件化需把「是否下发了链接」穿到模板层，刻意不做。

**为什么必须是"真实 URL + cookie 门"**（评审实测，两条硬事实）：

1. **HTTP 缓存按 URL 键**。实测（Chrome 152）：预取真实 URL 后 App 自己的 `<script src>` **不再回源**
   （命中缓存）；预取 `/chamber/warmup/<token>?u=…` 包装 URL 后 App 取真实 URL **仍回源**——两条 URL
   是两条缓存项，包装形永远不可能等价。故**任何把 token 放进 URL 的写法都拿不到收益**，capability 只能走
   cookie（同一实验中：带 cookie 的真实 URL 预取被浏览器发送并在 App 用**不同的 session cookie** 取同一
   URL 时仍命中；对照实验里一旦路由追加 `vary: cookie`，命中立刻失效 ⇒ 本路由不得追加该头）。
2. **托管 dsh 的 index 文档需要浏览器认证**：上游 `@deepseek-ai/dsh-host-frontend-static` 明确
   "Every index response first passes Connection's browser authentication … **Non-index assets stay public**"。
   发现腿若不带 spawn 期换取的 browser-auth cookie，`GET /` 会 401 ⇒ 登录页渲染 0 条链接（功能在生产中
   静默失效）。现在发现腿带上该 cookie（`WarmupDeps.getAuthCookie` 注入，`index.ts` 用
   `authCookieFor('http://127.0.0.1:'+port)`），并保持失败软退 + 500 ms 上限 + **60 s 成功缓存 / 10 s 失败
   缓存**（负缓存短，已就绪的 dsh 不会被藏一分钟）。发现腿按 dsh 端口**单飞**（在途共享同一个 Promise，
   并发登录页只触发一次 loopback index 拉取，在途数受聚合并发上界约束），超限直接无链接渲染而不是排队。
   上游把**非 index 资源视为公开**，故本路由放开的 bundle 形态与上游自身边界一致。

**路由与边界**（§7 认证边界、§13.1 不变量不变）：

- **形状允许列表**：只认两类**真实路径**——组合包 `^/plugins/\?\?[^?#]*$` 与单行 bundle
  `^/plugins/[^/]+/client\.(js|css)$`；其余 `/plugins/**`（插件 HTTP 路由）不放开。仍拒绝 `%`、`//`、
  反斜杠、`#`、点段、控制字符、绝对/authority 形与超长目标（≤8 KiB）。仅 GET/HEAD（其余 405）。
- **capability cookie 门**：路由在认证门**之前**被咨询，但**只有**形状命中且 cookie 验签通过（含客户端
  地址绑定、过期、`timingSafeEqual`）时才 claim；缺/过期/篡改/他人 cookie ⇒ `unclaimed` ⇒ 落回认证门
  （既有 session 照常，否则统一 401 + 仅类别审计）。**`/plugins/**` 不再有任何 blanket 公开豁免**，
  kill switch 关闭时该前缀与改动前一样 401。
- **限速与容量**：按客户端地址的有界 token bucket（容量 128 > 单页链接数（≤64）、5/s 补充、≤1024 键），
  超预算 429 `warmup_rate_limited`；并发与聚合缓冲另有上界（在途 ≤8、聚合 ≤64 MiB，超限 503
  `warmup_capacity`）——评审实测 40 条并发重放 8 MiB bundle 曾把 RSS 推高约 581 MiB。
  **限速只对「已出示且验签通过」的 capability 生效**（复核 MAJOR）：无 cookie 的请求连令牌都不
  消费——否则任何人（无需 grant）都能按 5 req/s 把同地址的桶抽干，让已登录 session 的 bundle 请求被这条
  **预鉴权**腿判 429、连认证门裁决与审计都不再发生，与「缺/篡改/他人 cookie ⇒ unclaimed」直接冲突。
  **发现腿**同样有界：按端口单飞 + 流式读取（超 `MAX_WARMUP_INDEX_CHARS` 立即 cancel，不再 `text()` 读满
  12.5 MiB 才判超限）——单条未认证连接曾实测放大成 100 次并发 loopback index 拉取。
- **无用户凭据上行**：上游请求只带 `accept-encoding` 与 spawn 期换取的 browser-auth cookie（非用户凭据、
  永不回给客户端）；调用方 cookie/authorization 一律丢弃；回程只透传
  content-type/content-encoding/cache-control/vary/content-length，其中 `vary` 与策略已设值**合并**
  （不覆盖 `vary: Origin`）。
- **可关断 + 软退**：kill switch 同时关掉发现、链接渲染、cookie 与路由；关闭或发现失败时登录页与既有模板
  逐字节一致（`warmup-login-page.test.ts` 以改动前哈希钉住）。托管端口只接受 1..65535。
- **审计与日志**：路由级拒绝复用 `auth_rejected` 助手（code = 客户端收到的 code + 客户端 + 路径**类别**），
  cookie 值与 URL 永不落盘、永不进日志。

**发现顺序按"浏览器真的会拉哪些"排**（实测 index：2 条文档级 URL（`<link rel=preload>` + `<script src>`）+
57 条 inline boot manifest 行 `url`，去重后 57 条真机册目，上限 64；该实测也说明顺序修正在上限 64 下通常
不生效，保留排序是为了册目更大或不含组合包的形态）：`<script src>`/`<link … href>` 这类**文档自己加载**的 URL（shell
在 mount 前 await 的 parser-preload/application 批）排在前面，manifest 的每行 URL 随后；仅按文档顺序会在
上限处先塞满 manifest 行、可能把最重的 application 组合包挤掉——而那份组合包正是预取存在的理由。同一类内
保持文档顺序。真机对照：用户网关实抓的 3 次真实 bundle 请求（组合包 preload 的解码形 + 组合包所在的
`phase:"application"` 行 + 组合包不含的 `dsh-chamber-mcp` 行）在修正后**全部被覆盖**（修正前只覆盖 1 条）。

**失败封闭**：无端口/未就绪 503 `instance_unavailable`，上游错误 502 `upstream_failed`，
调用方看不到上游正文。

**Rejected alternatives**：

- **token 放 URL（`/chamber/warmup/<token>?u=…`，已废除）**：实测缓存不等价（见上事实 1），
  且把登录页链接拉长（最长约 6.5 KB、整页 +25.7 KB）——预取的全额流量并未替关键路径省下任何字节。
- **pre-auth 放开任意路径**：等于把托管 dsh 的完整请求面（管理 REST、会话 API、插件路由）交给匿名流量，
  违反 S1/S2；只放开 `/plugins/` 的两种 bundle 形态是能拿到缓存收益的最小暴露面。
- **把整个应用放到登录页之后**（未登录不发现，或登录成功后再预取）：预取的全部价值就是利用「用户正在
  输密码」的等待时间；放到登录之后等于没做，关键路径一分不少。
- **禁用重量级客户端插件**：那是用删功能换流量，不是缓存；预热让同一份 bundle 首次出现在关键路径之外，
  功能集不动。

### 10.7 只读会话状态镜像（裁决：carve-out）

> §10 开头的「不得回流」针对的是**编排**（审批/提问代理、跨会话调度、会话索引、功能开关、feature host）。
> 本节只开一条**只读事实镜像**：gateway 观察它托管的本地 dsh 的会话状态并向外提供只读投影，供桌面在
> 「未挂载该来源」时仍能正确显示运行 / 等待 / 完成未读。它不写、不发命令、不代替用户响应，也不是 dsh
> 事实的权威（权威永远是 dsh 宿主与其前端）。实现面见 `packages/gateway/src/session-state.ts` 与 `packages/control-plane/src/session-state-protocol.ts`；仍开放的实机/CI 权威验收见 `docs/progress/STATUS.md`「远端完成未读 / 切源体验」条。

**边界（review 判据，任一不成立即越界）**：

- 只读镜像：只订阅宿主事件流与只读 unary（`session/list`），**没有任何写面**（不 create/cancel/approve/answer）；
- 不成为控制路径：桌面缺此能力时行为不劣化（能力协商 + 优雅降级），镜像不可用时全部功能仍在；
- 观察者纪律：作为 `$events` 的 waterfall 交付目标时，**仅当另有下游 mux 客户端在线且过 1.5s grace 才回 `next` 委派，否则保持等待**——不得自行 settle 审批/提问；
- 只存状态元数据：**不存标题 / cwd / 消息 / 审批与提问载荷**；状态文件 0600、目录 0700；
- 路由全部落在既有 `/chamber/*` 鉴权门内；宿主停机时返回 200 + `serviceable:false`（不 5xx，避免被误判为「未升级」）。

**接口摘要**：`GET /chamber/session-state`（快照 + `protocol` / `features` / `cursor`）、
`GET /chamber/session-state/stream`（SSE 增量，单调 `id`，`Last-Event-ID` 续传或快照兜底）、
`POST /chamber/session-state/read` 与 `/read-all`（幂等、只升不降）。

**P2a 增量面：goal 事实（2026-12 落地，design 19 §3.2.1）**

- **`session/list` 白名单扩 goal**：`session-mux.ts` 从每行
  `projections.values.goal` 只取 `goalId/revision/phase/updatedAt`（嵌套形
  `{ goal: { id, revision, phase }, updatedAt }`，`id` 映射为 `goalId`）；
  `objective`/`blockedReason`/`maxGoalRounds`/`roundsStarted` 与其余投影键
  （title/cwd/todos/inbox…）在**解析处**即被丢弃，绝不进 observer/持久文档/wire。三值：
  键缺席或形状不符 = 字段缺席（unknown，绝不臆造「无 goal」）；`null` = 宿主明确无
  goal；对象 = 当前 goal。`session/list` 依旧不激活 agent（只读 unary，冷会话可见）。
- **`$events` 的 activation（身份绑定，2026-12 收敛）**：`goal/activation-changed`
  （emit 帧，无重放）在 mux 解析边界归一为 `SessionStateGoalActivationEvent` 三变体：
  bound `{goalId, activation}` / unbound `{goalId: null, activation}` / no-goal
  `{goalId: null, activation: null}`；形状漂移（`activation` 非词表）丢弃不猜。
  gateway 进程内按 goalId **保留边**（`pendingGoalActivations`，每会话至多一条、最新
  覆盖）：bound 边仅在行 `goal.goalId === 事件 goalId` 时落行；**绑定 id 与基线不符、
  行尚未出现或投影仍 unknown/null 时一律保留待匹配（不直接 drop）**，由后续 baseline/added
  携带匹配 identity 时消费，**换 id 不继承**旧 activation（把新 goal 的 armed 落到旧 goal
  行上正是要防的 `complete+armed` 污染）；unbound 边作用于行当前已知 goal（镜像
  renderer P2b 的宽松解析）。保留边纪律 P2b/P1 同规（2026-12/F14 统一）：绑定 id 与基线
  不符一律保留待匹配、不直接 drop，不再设第三 goalId 出口——P1 有壳插件
  （`goal-activation.ts`；每会话至多一条、新事件覆盖，只随会话/行离开、显式 no-goal、
  reset/dispose 清除，绑定守卫绝不落到别的 goal 上，design 19 §3.2.2）、P2b
  `source-mux-facts.ts` 的 `goalActivations`（design 19 §3.5）见各自文档。**no-goal 事件
  只清已知对象 goal**：丢该会话保留边，行有**已知对象** goal 才清成 `null`；unknown 行
  绝不因此被伪造成「无 goal」（activation 可能先于基线到达），行缺席也不新建行、不缓存到
  迟到的行上。而 baseline/added 的显式 `goal:null` **不丢保留边**（create 可能仍在追这份
  基线的在途快照竞态安全，刻意不对称）。**清边路径**（保留边是进程内易失信息，任何「行不再
  可信」的收口都连边一起清）：`applyRemoved` **无条件清边**——在行存在性早退**之前**
  删除（边可能跑在 create 之前、行从未存在；重建同 id 不得继承）；baseline **二次缺失**
  prune 删行时随行清边（第一次缺失只标 absent）；行容量淘汰（`MAX_SESSIONS`，flush 时按
  `observedAt` 最旧优先）删行时随行清边并计入 `dropped.goalActivations`（被淘汰行带边
  时），`dropped.sessions` 照计；**该淘汰同时补发 delta**（`deltaRemoved` +
  `commitDelta()`，进 replay ring）——淘汰是删除而不是静默抹掉，否则 SSE 客户端会永久
  保留幻影行。`$events` ready 的**任意跳变**（`status.ready !== lastReady`）触发
  `clearGoalActivations`，连同**尚未找到投影的保留边**一起清（F27：不能只看
  false→true）。**容量与诊断**：
  `MAX_PENDING_GOAL_ACTIVATIONS = MAX_SESSIONS`（2000）；同一会话的最新边覆盖旧边不算
  淘汰，为新会话登记边而超限时淘汰**最久未更新**的一条（LRU：更新已有键用 delete+set
  刷新保留序，不按首次登记序）并 warn，`dropped.goalActivations` 计数（绝不静默）。
  **计数口径**：只有两处容量淘汰计数——保留边 cap 淘汰与行容量淘汰随行清边；
  `applyRemoved`、baseline 二次缺失 prune、no-goal 事件与 `clearGoalActivations` 的清边
  都**不计**（不是容量损失）。`dropped.goalActivations` 是**加法诊断键**（协议声明在
  `packages/control-plane/src/session-state-protocol.ts` 的 `SessionStateDiagnostics.dropped`；
  `status().dropped` 与持久文档 `dropped` 同形，旧客户端不进 diagnostics）：flush 把当时
  的进程内累计值写进持久文档，但加载校验把 `readMarks`/`goalActivations` **一律归一为
  0**（缺键/坏值与携带非零值同路，重启不继承）；保留边本身**不落盘**。旧端矩阵 fixture
  （`support/compat/route-table-0.4.0.fixture.json`）把
  `diagnostics.dropped.goalActivations` 以 dotted path 记进
  `anchor.postFreezeAdditions` + `nested.diagnosticsDropped` 键表（负控制删/改名该键必红）。
  路由级 `/chamber/session-state/stream` 的 delta 与
  快照共用 wire row 投影，`sessions[]` 携带完整 goal（含进程内 activation）；旧客户端只读
  冻结键、忽略该加法字段。
- **activation 永不落盘**：它是进程内缓存，持久文档经 `persistedGoalFact` 剥掉
  activation；进程重启后已知 goal 只有 identity/phase/水位，activation 回到 unknown。
  `$events` ready 的**任意跳变**（`status.ready !== lastReady`）整体
  `clearGoalActivations`——它连同**尚未找到投影的保留边**一起清。两个方向都是事件代边界
  （F27）：false→true = 首连/重连/静默重订，间隙使旧边不可信；true→false = socket 死亡 /
  host end/error / 握手超时，紧随其后的 poll 窗口会从死代取出陈旧 armed/disarmed。emit 帧
  无重放，陈旧 armed/disarmed 不得跨任一侧存活（否则会永久压制或凭空补发）；换 goalId 时
  基线刷新保留身份/相位但不得继承旧 activation。
- **能力协商**：`session-state.goal` 是**可选** feature（`SESSION_STATE_FEATURES` 新增，
  **绝不进** `SESSION_STATE_BASE_FEATURES`/required）：旧桌面或旧 gateway 缺它不降级，只是
  该来源没有 goal 事实（现状）。它在 `sse` 与 `poll` 两种 mode 都宣告（只读
  `session/list` 在两种 mode 都存在，不是 event-only）。旧桌面矩阵 fixture
  （`support/compat/route-table-0.4.0.fixture.json`）按 additive 形状登记：
  `features.addedAfterFreeze` + `sessionRowAdditive`（goal）+ 嵌套 `goal` 白名单键 +
  `anchor.postFreezeAdditions`。`nested.goal` 键表已含 `activation`（进程内加法字段），
  矩阵 seed 行带 bound activation 并断言其经 wire row 往返；negative control 删掉
  `activation` 键必红（冻结键集 tripwire 的可失败性自证）。桌面侧
  `session-facts-source.ts` 防御性解析该加法字段
  （字段缺席 = unknown），**不按 capability 门控**（capability 只宣告能力，不改变解析）。
- **只读边界不变**：仍是只读事实镜像，不写、不发命令；activation 的唯一来源是转发事件，
  `goals/get` **永不调用**（其 lookup 覆写为 resolveAgent→resume，冷会话会被拉起 = 写面，
  见 design 19 §3.2.2）；观察者纪律与隐私条（不存标题/cwd/消息/载荷）原样。
- **P2b 不消费本镜像**：SSH/dsh 来源走 `packages/renderer/src/source-mux-facts.ts` 讲实例
  **自己的**远程协议（`session/list` 投影 + `$events` + 每边沿一次 `session/follow`），
  与 gateway 的 `/chamber/session-state` 无关；两条事实源只在 renderer 侧汇成同一份
  `SessionFactsSnapshot` 形状（design 19 §3.5）。其 `goalActivations` 保留边同本节纪律：
  绑定 id 与基线不符保留待匹配、no-goal 只清已知对象 goal（design 19 §3.2.2/§3.5）。
- **验证与开放**：goal 白名单投影/activation 身份绑定路由/能力可选/旧端矩阵/持久化剥
  activation 的定向用例由 `test:control-plane` / `test:gateway` 覆盖；实机/CI 权威验收
  仍见 `docs/progress/STATUS.md` 的「远端完成未读 / 切源体验」条（本地环境伪象与轮次叙事不属设计契约）。

完成分类由每次 true→false 边沿持有的读尾身份结算：新一轮 running、新提示水位或移除会撤销旧身份，迟到的 `session/follow` 不得写回。`session/list.updatedAt` 在当前宿主是最近用户提示时间；`false→false` 且水位前进时，旧完成事实必须撤销，但没有可信运行轮次证据便保持未知。读尾失败只生成 `reconstructed` 未读，不可触发原生完成通知；同一边沿在后续可信基线继续读尾，直到分类或被新活动取代。

**Rejected alternatives**：用 `updatedAt` 的前进直接补出完成会混淆用户停止与完成；让读尾失败保留 `observed` 会把未知结果当完成通知；迟到读尾只检查当前 `running=false` 会把上一轮结果写进另一轮已停的会话。

## 11. Git worktree：服务器侧范围外

服务器侧 Git worktree saga（server 侧 `workspace.list`/`workspace.create`/
`session.create` 补偿与删除 lease、两次 live check 的 TOCTOU 压缩等）已随编排面
剥离整体删除，**不得回流**。Git worktree 由 **design 08 的实例内插件**承担——侧边栏
经同一通道触达本地/托管 dsh（托管 dsh 的宿主包由种子机制注入），其安全契约、
删除竞态与实机验收见 design 08 与 STATUS.md。

## 12. 持久化与恢复

Gateway state 与 dsh `$DSH_HOME` 分离。主要文件：

```text
<stateDir>/
├─ tokens.json                 # v2 信封 {schemaVersion:2, source, updatedAt, hash}, 0600
├─ jwt-secret                  # 0600
├─ password-credential         # v2 信封 {schemaVersion:2, source, updatedAt, verifier}, 0600
├─ owner.json # state 根租约 {schemaVersion,pid,startedAt,token,scope,flavor}, O_EXCL + 回读终验, 0600
└─ dsh-runtime/                # design 18 §9.3：版本树/current 指针/override/快照（0700）
```

> 编排面剥离后 store 只拥有凭据（tokens.json / password-credential）与
> `owner.json`（state 根租约，`scope`/`flavor` 区分 state-root/host-root 与写者）；`gateway/settings.json`、`gateway/worktrees.json`、
> `gateway/schedule.json` 三文档随编排面删除。

Gateway 拒绝把文件系统根、用户 HOME 或系统 temp 根本身作为 `stateDir`（专用子目录仍合法）。POSIX 上
新建专用 `stateDir` 为 `0700`；既有 `stateDir` 启动时经 pinned no-follow 描述符收紧到 `0700`
（自动收紧替代 fail-closed `require`——旧 0755 布局不再崩溃循环，且绝不碰 broad root）；
`dsh-runtime/` 同样收敛 `0700`。Windows 的 Node `chmod/stat.mode` 无法诚实证明 POSIX `0700`——该
目录边界仅保留 real-dir/no-follow/identity 校验并继承 OS ACL，既不伪报 `0700` 也不改 ACL（Windows
代码面可用、真实 runner/实机门禁未过——design 23；让步登记见 design 23 §5（C1/C2 审计标识表）
与 STATUS）。所有 JSON main/backup/tmp 与 secret 写入收敛 `0600`；正常 store 加载可显式迁移合法
legacy secret 到 `0600`，而 `gateway auth status` 只验证不改权限。secret 读取以 KiB 级上限约束，并
先以 no-follow/inode 校验拒绝 symlink 与非普通文件。凭据 JSON 经 `createJsonStore` 的 owner-only
原子写路径持久化，写操作串行化，避免并发请求以旧 snapshot 覆盖新值（编排面剥离后经此路径的只有
凭据文档与锁）。corrupt 主文件先试 backup；双重损坏响亮失败，不伪装成空配置。早期预留但无生产
消费者的 `gateway.json`/devices/channels 文档已删除；旧文件仅忽略，不做破坏性清理，未来能力必须按
真实领域 validator 重引入。

**凭据信封（v2）**：`password-credential` 与 `tokens.json` 均为
`{schemaVersion:2, source:'config'|'runtime', updatedAt:<epoch ms>, verifier|hash}`（0600 原子写，
无 tmp 残留）；`source` 记录部署播种还是运行时变更（播种策略见 §7.4）。legacy v1（密码裸
`scrypt$salt$hash` 字符串、token `{"hash":…}`）读为 `source:'config'`（updatedAt = 文件 mtime），
下次写入自动迁移 v2。v2 的 verifier/hash 必须匹配 `scrypt$salt$hash` 规范形状
（`/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/i`）——形状合法但内容垃圾按 corrupt v2 处理（**每进程告警
一次**，按未配置处理），杜绝「垃圾 verifier 静默废认证」。

**state 根租约（`<stateRoot>/owner.json`）**：`createGateway`（gateway 形态）或 `createControlPlane`（desktop/cli，取锁严格在首次 store 写之前）经 `acquireStateRootLease` 以 **no-follow O_EXCL** 创建
`{schemaVersion,pid,startedAt,token,scope,flavor}`（0600，stateRoot 0700 内）+ **回读终验**持有该根：活 pid 的租约**响亮拒绝启动**
（结构化错误 `state_root_locked` + holder pid/flavor）；同进程同根重复取 = `state_root_duplicate`；死 pid 的陈旧租约以 **rename 认领 + 字节/identity 证明**接管：
rename 到唯一 `.stale-<pid>-<hex>` 名（仅一个竞争者成功，其余见 ENOENT 重试），再校验被移动的正是
读到的陈旧记录；若移动了**新鲜记录**则还原（覆盖间隙中第三方的新租约——先到者胜，被覆盖者的
**创建后所有权终验**检出位移并 fail-closed）并响亮失败。不可读的租约文件（非普通文件/symlink/inode 竞态）响亮失败（绝不销毁意外内容）；**可读但 pid 缺失/损坏或撕裂**的记录按陈旧**认领并告警**（最可能是崩溃残留）；未知 `schemaVersion` fail-closed。`release` 双重守卫：未实际持有不删，且 on-disk 完整 bytes + **token+inode** 必须仍与本次获取一致才删（仅比 pid 不足以区分同进程重取/后继者；不匹配即 `state_root_not_owner` 且绝不删除）；**exit 监听器仅在获取
成功后注册**（模块级单一监听器只遍历已持有租约）——获取失败的进程退出时绝不删除活写者的租约。创建后**所有权终验**（回读 + identity 与刚写入一致）——被并发接管位移的获取者立即失败，绝不无锁运行。采用语义：gateway/plane/runtime-manager 共享同一 handle、只 `assertCurrent` 不释放，仅顶层 owner 在其写者静止后 `release`；`start` 自持且已释放时 `reacquire`。逃生口唯一实现 `resolveStateRoot`：`--state-dir` > `DSH_<FLAVOR>_STATE` > `DSH_CHAMBER_STATE` > `~/.dsh-chamber`（一个 state 根一个写者，第二写者 fail-closed 退出 1）。旧 `.gateway.lock` / `dsh-runtime/owner.json` 由 `retireLegacyStateLocks` 一次性退役（一个 minor 后删除该函数）。已知残差：三个进程同时接管同一
陈旧租约时，第三个可能在还原间隙创建新租约并被覆盖——与所有 pidfile 锁相同，无内核 flock 时不可能数学
消除；双进程场景（生产现实：systemd + 手动启动）由上述校验**证明地**闭合（`control-plane/test/state/state-root-lease.test.ts` 的 T1/T2/⑦/T9 与 13 条单进程矩阵锁定，含 T3–T6 四条生产入口 end-to-end）。

**桌面凭据存储（`<userData>/gateway-secrets.json`，schema v3）**：

```jsonc
{ "schemaVersion": 3,
  "storage": "safeStorage", // 或 "plaintext"；文件级权威判别，禁止猜测 blob
  "tokens":   { "<id>": "<safeStorage 加密 blob | 0600 明文回退>" },
  "passwords":{ "<id>": "<同上>" },
  "tokenBindings":   { "<id>": "<sha256 gateway-domain fingerprint>" },
  "passwordBindings":{ "<id>": "<同上>" } }
```

- **OS keychain 集成（Electron `safeStorage`）**：加密优先——macOS Keychain / Windows DPAPI / Linux
  libsecret（kwallet/gnome-keyring）；落盘为加密 blob，密钥由 OS 保管（§13.4.1）；
- `safeStorage.isEncryptionAvailable()` 不可用（Linux 无后端、无登录会话等）时回退当前 0600 明文
  镜像（登记为既有的延续）；
- `storage` 是落盘事实而非当前 capability：密文永不以字符形状猜成明文；非空但缺 discriminator 的
  历史 v2 fail closed 并保留 `.corrupt`；plaintext 文件在 keychain 后来可用时立即原子升级，成功后才
  投影 `safeStorage`，失败则继续诚实显示明文；
- token/password binding 与各自值同一次原子写；读取/注入必须匹配当前 registry 的 gateway domain。
  非当前 schemaVersion 的文件（旧 v1/v2 或缺失版本）一律 fail closed：保留为 `.corrupt`、禁用并要求显式
  重录（无就地迁移）；旧 `gateway-tokens.json` 兄弟文件不再读取/迁移，残留原样保留；
- 载入 gateway/SSH 凭据镜像先 no-follow + regular-file + inode 校验，以已打开 fd `fchmod 0600`
  后才读 secret bytes；宽权限旧文件不再原样使用，symlink 不跟随；
- 其余纪律不变：原子写、corrupt 响亮失败（保留 `.corrupt`）、删除实例/显式清除即删；凭据仅表单
  瞬时 write-only 输入，永不由主进程返回/回填或持久化到 renderer，也不进注册表/日志。

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
- **价值**：静态磁盘拷贝/文件窃取不再能直接读出凭据；破解门槛提升到
  「同 OS 登录会话 + 调 API」；
- **决策**：集成（§12 桌面凭据存储 v3）；`isEncryptionAvailable()` 为 false 时回退
  0600 明文（登记延续既有）；回退路径在 UI 设置页可见。

#### 13.4.2 mTLS 与证书固定 —— **证书固定集成，mTLS 槽位**

- **证书固定（SPKI pin）**：https 直连的可选高级字段——用户提供期望服务器证书的
  SPKI 指纹，desktop 登录/探针与 control-plane HTTP/WS 反代校验，不匹配即
  terminal/502。pin 是该连接的信任锚，pre-write 门见 §9.3（匹配前不发送任何应用层
  字节；mismatch 的上游 handler/upgrade 观察为零）。
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
- **去抖**（`packages/gateway/src/dispatch.ts` 的 `AUTH_REJECTION_DEBOUNCE_MS`）：
  认证边界拒绝按 (客户端, code, 路径类别) 做 1 s 短窗口去抖——窗口内**首条立即落盘**
  （事件不延迟到窗口结束），其后同类重复只累加内存计数，窗口结束时落一条带
  `count:<n>`（该窗口同类总数）的合并记录；不同客户端/code/路径类别永不合并，
  拒绝码本身不变，`login_*`/`credential_*` 不经该路径；停机 drain（`quiesce`）会先
  把未结束窗口的计数落盘。动机：每次 append 含同步 fsync（实测 ≈3.3 ms），
  无凭据的根类子资源洪峰（manifest/图标族）会钉住单线程事件循环；
- **消费**：CLI/日志查询即可；不进入设置 UI（v1）；
- **价值**：可信网络 + 无认证模式下接入事实可追溯。

### 13.5 密码会话专项

会话 ownership、generation/refresh epoch 复验、provider hooks all-or-none 与 `cookie|bearer` proof 规则见
§9.3/§9.4：登录响应/失败永不含密码或 cookie 进日志；cookie 仅主进程内存、仅注入 exact
connection-target scope 所有的目标；重登有界（一次 + 429 退避）；session cookie 为 HttpOnly，renderer
永不可见。配置 HTTPS pin 时密码请求 body 也受 §13.4.2 pre-write 门保护。

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
覆盖 pnpm 依赖安装成功与 `gateway --help`。移动插件产物（`dist/index.js` 与
`lib/client.js`(+map)/`lib/index.js`）为构建期生成、不提交；clean checkout 由
`pnpm run build:artifacts` 自举（取舍见 design 05 §6）。

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
- Gateway config/auth/request-policy/dispatch/proxy/lifecycle/chamber-surface/真实 socket 测试；
- Gateway 运行时凭据面：auth 运行时变更/播种四规则/legacy
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

1. 安装的真实 dsh：Gateway 启动等待 ready，登录后 `/`、普通 `/api`、`/api/remote.mux`
   HTTP/WS、插件 bundle 与 `/chamber/` 全部可用；
2. 生产型 TLS 反代：publicOrigin、Host、Origin、XFF、Secure cookie、WebSocket
   upgrade、未认证/错误 authority 行为逐项验证；SPKI pin 正/负例；
3. 打包 Desktop：新增 Gateway（https+凭据 / http 明文+凭据 / http 无认证三种形态）、
   重启后自动连接（safeStorage 解密 + 密码会话重登）、token/密码更新/清除撤销既有流、
   N-ctx 与 Gateway settings 页面（dsh-runtime 分节挂载差异验证：gateway 完整管理面
   （版本选择/状态/快照/更新/回滚/恢复内建/registry/restart/start/apply-now 与轮询）
   / **dsh 直连（ssh/http）均不挂载**——与 §3 能力表/design 18 §9.3 一致）；
4. macOS 发布产物完成 Developer ID 签名/公证/安装；Windows 未签名产物验证安装与
   SmartScreen 已知提示（v1 不把 Authenticode 当完成条件）；
5. 服务端 dsh runtime 实机：安装候选版本 → 重启 Gateway → 探针 → 故障注入回退 →
   `<stateDir>/dsh-home` 数据恢复；生产 TLS 反代下 `/chamber/runtime` 的 status 轮询
   与认证行为（design 18 §9.5）；
6. 可信网络形态实机：`--bind 0.0.0.0` 明文 HTTP 直连（带凭据 / `--no-auth`）、
   SSH 隧道回环直连、tailscale 直连——四种组合全链路 + 401/421/403 负例。
7. 运行时凭据实机：生产 TLS 反代下浏览器/API 改密与 token 轮换（旧 cookie/bearer
   立即失效、`GET /auth/credentials` 投影、409/403/429 负例），以及停机态
   `gateway auth status` / `reset-password` / `clear` 的恢复链路。

PWA 安装、离线缓存和 UA 移动轻面是 §18 的独立设计面；实现按 §18.7 分期推进，
不暴露无实现的 CLI flag。

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
| S9 | 会话索引随编排面整体剥离（§10），本不变量空置（原：派生 session/pending 状态不跨 stream generation） |
| S10 | 服务器侧 Git worktree saga 已删除（§11），作用域移至 design 08 实例内插件（原：Git 只作用于 dsh live workspace 派生的 canonical 路径） |
| S11 | 同 S10——保留与 recovery 语义由 design 08 实例内插件承担（原：不确定的 Git 提交/归属永远选择保留与 recovery，不选择破坏性补偿） |
| S12 | Gateway 不能削弱普通 control-plane 的 loopback-only 门 |
| S13 | 编排功能与 feature flag 随编排面整体剥离（§10）——调度/worktree/审批聚合不再存在，开关机制随之移除 |
| S14 | dsh 会话正文永不进入 gateway 持久层；编排面剥离后连控制帧投影也不再保留 |
| S15 | POSIX：Gateway 新建 state 目录为 0700、既有 stateDir 经 pinned no-follow 描述符收紧为 0700（拒绝 broad root；自动收紧替代 fail-closed `require`）；Windows 目录保留继承 ACL 且只做 no-follow/identity；JSON/secret 为 0600，status 只读验证 |
| S16 | release 必须 commit-bound、公开记录不可变；desktop stable/beta feed 独立，Gateway 本阶段只发布 GitHub tgz+SHA256、不得隐式发布 npm |
| S17 | dsh runtime：无快照不切指针；切换/恢复中断由 durable journal/marker 幂等补完（design 18 §9.7） |
| S18 | dsh runtime：探针全绿才宣布 applied 并开放代理；回退目标 = 切换前版本或最近 known-good，绝不两棵坏树间交替 |
| S19 | dsh runtime：状态/凭据（registry 源、失败记录、install 子进程 env）不进日志；状态文件 0600/0700；install 源钉死 + env scrubbing |
| S20 | dsh runtime：切换不得削弱 S12（普通 control-plane loopback 门）；`/chamber/runtime` 全部认证后 |
| S21 | http 明文/无认证接入是显式决策（URL 协议 + 凭据留空）；UI 与文档如实注明风险，绝不静默降级 |
| S22 | 桌面凭据（token/密码）经 safeStorage 加密落盘；不可用时回退 0600 明文并登记；仅表单瞬时 write-only 输入，永不返回/回填或持久化到 renderer，也不进注册表/日志 |
| S23 | 证书固定（SPKI）为 https 直连可选门：peer 匹配前 desktop 登录/探针与 control-plane HTTP/WS 反代不得发送任何应用层字节；不匹配即 terminal/502，http 模式不得声称任何 TLS 保护 |
| S24 | 审计日志只记非秘密事件（时间/来源/认证结果），绝不包含凭据、cookie 与会话正文 |
| S25 | 运行时凭据变更需非环境性证明（bearer principal 自证或 currentPassword 校验，仅 cookie principal 拒绝 403）；运行时拒绝删除最后一个凭据（S1 不可在运行时削弱；none↔auth 双向转换仍仅部署期） |

## 18. 移动端 Web 访问面（UA 移动轻面）

### 18.1 背景、动机与目标形态

§16.2 曾把本面列为远期（P4）后预留的独立设计与测试面；移动例外（唯一随 gateway 发行物打包 seed 的
chamber 客户端插件）见 §3 装配矩阵与 §10.2。

- **目标场景**：内网/可信网络形态（显式 `--no-auth` 可信网络或 tailscale 隧道）先行；
  公网认证入口（§7 认证边界）与 PWA 安装/离线能力设计上预留、分期实现。
- **实证基线**：官方 dsh 前端（当时 0.1.2-alpha.3 web profile）在 375×812 视口下**几乎
  不可用**：92% 可交互目标 < 40px（触控标准 44px；侧边栏图标 36×36、模式选择 28px 高、指令 28×28、
  发送 34×34）；侧边栏退化为 36px 图标 rail 仍占左侧 56px，聊天区仅剩 ~300px；模态弹窗（内测声明 +
  API Key 配置 327×246）连续遮挡首屏；创建工作区在 28px 触控目标上难以完成。官方 index.html 已自带
  viewport meta（middleware.ts 注记属实）——问题不在缺 viewport，而在**布局与交互范式本身是桌面形态**。
- **社区现状（调研结论）**：GitHub 已有多种方案（详见 §18.4，五仓库四形态），最成熟的是 **dsh 客户端
  插件**（`dsh-ui-mobile` / `dsh-client-ui-mobile-adapt` / `dsh-mobile-shell` / `dsh-web-ui-mobile`），均以
  窄屏 media query + CSS 覆盖 + 组件重排实现，桌面宽度下与官方布局一致；网关形态（`dsh-pocket` 872★ 等）
  只做暴露/认证/隧道、不做内容转换——**没有任何项目在网关层改写官方 HTML**，与本章架构纪律一致。

### 18.2 职责边界（与仓库纪律的关系）

移动端适配拆两层，各落在既有职责边界内：

| 层 | 承担者 | 职责 | 与仓库纪律的关系 |
|---|---|---|---|
| 移动适配（覆盖层） | chamber 自研 dsh 客户端插件（`packages/dsh-chamber-client-ui-mobile-*`） | 窄屏下对官方前端做布局/触控/PWA 适配 | 复用 dsh 官方插件机制（design 09 方案 A `--patch` seed / bundle），**不改官方源码**；不写第二套聊天 UI、不消费会话内容（P1/P2/P3 均不触碰） |
| 暴露与入口（路由层） | gateway | UA 体验分流（可选）、认证边界（§7）、PWA 资产、反代 | 保持流式透传（**无 HTML 改写**——S0 头补丁注入除外，§10.5，非布局改写）；UA 只是体验分流，**不是安全边界**（认证仍是唯一边界，S1/S2） |

**移动例外（契约）**：`dsh-chamber-client-ui-mobile` 是唯一随 gateway 发行物打包 seed 的 chamber 客户端插件（§10.5、§3 矩阵、§10.2「不参与桌面同步」）；桌面侧 chamber 插件（sidebar/layout/settings-bridge/git/open-in）依旧不注入。机制同 host-graph-seed `--patch` overlay（design 09 §3.1 方案 A），与两个宿主 seed 包同构，区别只在**分发来源**：宿主包经桌面 `PUT /chamber/plugins` 同步（版本锁定到连接桌面），移动插件随 gateway 打包（链路无桌面在场）。

认证、凭据、会话边界与访问控制归 **gateway 管理职责**（§7、§10 凭据面板、UA 分流门），移动插件
**不触碰也不感知**；插件只做**官方前端呈现适配**（布局/触控/行为层/视觉 token），不持有也不消费任何
认证态、凭据或会话管理能力。不变量：

| 域 | 归属 | 插件侧纪律 |
|---|---|---|
| 认证/授权/凭据/会话边界 | **gateway 独占**（§7：password/token/cookie、S1/S2/S5/S6） | 插件 `src/` 零认证/凭据/登录引用（grep 验证）；UA 分流开关是 gateway 配置（默认关），插件无 UA 逻辑 |
| 登录流转（未认证移动访问 → 登录页 → 回移动入口） | **gateway 独占**（dispatch `shouldRedirectToLogin`，与桌面浏览器同流转） | 插件不注入、不重定向、不感知认证状态 |
| UA 体验分流 | **gateway 独占**（dispatch step 4.5，认证门后，仅体验分流） | 插件不读 UA |
| PWA 资产挂载与 SW 纪律 | gateway 占位 + 插件 P2 期 node 半部（§18.7） | SW 不缓存认证响应（§18.5） |
| 布局/触控/行为层/视觉 | **插件独占** | gateway 不注入样式、不改写 HTML（流式透传；S0 头补丁注入除外，§10.5） |
| dsh 运行时版本管理、seed registry、`/chamber/*` 运维面 | **gateway 独占**（§10.2/§10.3、design 18 §9） | 插件不感知运行时状态 |

### 18.3 方案结构

```
手机浏览器 ──(UA 路由，可选)──▶ gateway 认证边界（§7，唯一安全边界）
                                   │ 反代（流式透传，无改写；S0 头补丁注入除外，§10.5）
                                   ▼
                          gateway 托管的本地 dsh（web profile）
                                   │ 打包 seed（§3 矩阵移动例外：插件随
                                   │ gateway 发行物分发，spawn 时注入）
                                   ▼
                    chamber 移动适配插件（窄屏 media query 生效）
                       ├─ 布局覆盖：三栏 → 单栏、侧边栏 → 抽屉
                       ├─ 触控：目标 ≥44px、touch-action、100dvh/安全区
                       ├─ 弹层/设置/轨迹：全屏、可滚动（弹层限宽归官方几何）
                       └─ PWA：manifest/SW/安装引导（分期）
```

**gateway 侧（路由层）**：

- UA 体验分流（可选、默认关闭）：移动 UA 访问 `/` 时可 302 到移动入口；UA 可伪造，故**仅作体验分流，
  不承载任何安全语义**（认证边界不变，S1/S2）。
- PWA 资产：**插件侧为权威**——`dsh-chamber-client-ui-mobile` 的 node 半部在托管实例内注册 `/pwa/*` 与
  `/sw.js`（§18.4.5 双半部机制），gateway-proxy 全量透传使其在 gateway origin 下直接可达；gateway
  现有 `/chamber/manifest.webmanifest`、`/chamber/sw-register.js`、`/chamber/sw.js`（空）、
  `/chamber/mobile.html` 为 P4 占位——**插件注入实例后 gateway 侧不再注册 SW/manifest**（避免双注册与
  "假离线"承诺，§18.5），mobile.html 保留为未注入形态的移动入口占位。SW scope：单目标反代下托管实例即
  gateway origin，`scope: "/"` 天然实例专属；多实例同源代理（桌面 N-ctx，`/api/i/<id>/*`）才需要
  per-instance 路径（§18.4.5）。
- 认证交互：未认证移动访问 → 登录页（login-page 已带 viewport） → 登录后回到
  移动入口；流转与桌面浏览器一致，无新认证面。

**客户端插件侧（覆盖层）**：断点、抽屉、弹层、输入行、设置面板等机制以 §18.4 社区实现为基线，chamber
自研版保持同等能力集并纳入 chamber 插件治理（typecheck/test、i18n、dsh 版本对齐）。

### 18.4 社区实现借鉴

调研基线（源码级复核）：`dsh-client-ui-mobile-adapt`、`dsh-mobile-shell`（派生自
dsh-web-mobile）、`dsh-ui-mobile`（npm 已发布）、`dsh-web-ui-mobile`、`dsh-mobile-pwa`
（五者 MIT、均已停更）与 `dsh-meow-smooth`（唯一活跃、键盘/IME 机制最完整）。
**实现纪律：零代码复制、完整重写**——只吸收设计决策，不 fork/搬运社区文件。重写输入：
① dsh 基线 `v0.1.7-rc.2`（`harness.commit`），走 chamber 现有模板与构建体系；② N-ctx 多实例：
打标/样式按实例根作用域化，行为层 effect 为 document 级单实例设计（多 shell renderer 挂载时
必须作用域化）；③ layout 事实源在 `dsh-chamber-client-ui-layout`，不注入 gateway 托管实例
（mobile 的唯一部署），只观察官方 `data-sidebar-collapsed`；④ 选择器锚自研 DOM + fork 内
`data-*` 钩子，不猜官方哈希类名；⑤ 断点带触屏守卫 `(max-width:1023px) and (pointer: coarse)`
+ 768px 手机档（社区 "PC leak" 教训）；⑥ 能力取舍：行为层必做，社区宿主路由（删除/推理等级/
插件市场/GitHub token）v1 不做。

**18.4.1 挂载机制（社区已证明零成本）**：标准三件套 = `package.json` 的 `dsh.bundle.patch`
→ `cordis.patch.yml` 单行 insert → `dsh.client.inject`；产物为
`window.__ModuleLoader__.load({id, factory})` + 运行时注入 `<style data-plugin-css>`。
chamber 已有完全同构先例（design 09 方案 A + host-graph-seed `--patch` overlay），**无需新机制**；
宿主侧能力走 dsh 实例自己的 host 插件，不越控制面边界（v1 不引入删除类）。选择器三条路线中
chamber 走第三条：已 fork `dsh-client-web`/`ui-layout`，在 fork 内加 `data-*` 钩子；唯一
类名例外是**局部名后缀契约**（实例 bundle 为 `[hash]_[local]`，只能用
`:is([class$="_<local>"], [class*="_<local> "])` 形态；`_<local>_<hash>_<idx>` 是 chamber 自建壳
命名、不属于实例 bundle）。

**18.4.3 布局覆盖要点（实证坑）**：
- 三栏→单栏：`@media` 内 Grid 覆盖 `0 minmax(0,1fr) 0` + 侧栏 `position:fixed` 脱离流；
- 抽屉 containing-block 陷阱：官方设置面板 portal 挂在 fixed 侧栏内，任何 `transform`/
  `will-change`/`contain` 都会把它裁进抽屉 ⇒ **ui-layout fork 把设置对话框移出该 portal 即根除**；
- 弹层不统一限宽：曾对所有非设置 `aria-modal` 加 `max-width`，把全幅 `ImageLightbox` 限出未变暗的
  可点穿条带；树里三个 `role="dialog" aria-modal` 生产者各自已带视口适配 ⇒ 已删除；
- 设置面板全屏：`fixed inset:0` + 纵向滚动 + safe-area；粘滞行按官方
  `[data-slot="settings.header"]`/`settings.action`/`settings.close` 缝定位，不用位置索引；
  手机档 nav 变横向 chips（44px）；分区网格只剩 Models provider 一处 4 列→2×2（后缀契约例外锚点，
  fail-soft 回官方网格）；plugin-inventory / agent-preset 两张卡片网格几何归上游，chamber 不覆盖；
- 会话头部：抽屉开关（官方 `IconPanelLeftOutlineRegular` + 官方 label 对，自写 `aria-expanded`、
  无 `aria-haspopup`）与头部内容重叠 ⇒ 头部预留左 gutter；crumbs 行改换行不裁切；
  「Session 日志」胶囊上游已改 more-actions 28×28 图标，插件不再按文案打标；
- 安全区一次做全：`viewport-fit=cover` + `env(safe-area-inset-*)` + `100dvh` + `theme-color`
  跟随主题 + `interactive-widget=resizes-content`；textarea 恢复 `touch-action:auto`；
- 右栏/轨迹：769–1023px 档上游不全屏且第三轨钉 0 ⇒ 触屏档给面板全屏呈现
  （`[data-mobile-role="details"] [data-sidebar-right-panel]` → `fixed inset:0; z-index:40`），
  网格锁不变、**刻意不加「已展开」门控**（动画同刻 `shown:false` 会让全屏盒中途失效）；抽屉/
  遮罩/开关挂官方 `shell.overlay`（独立栈上下文），面板展开期显式让位，需轨道臂 +
  `data-rightbar-fullscreen` 两条臂；锚点注意 slot 出口是 `display:contents`，对「列的子元素」
  定位是静默 no-op；跨栈真正解需 body portal（未做）。

**18.4.4 行为层（移动端复杂度核心）**：IME 恢复（focus 丢弃循环 / editability 翻转 / pointerup
refocus / visualViewport 判定 / 键盘补偿五层）、回车=换行、composer 自愈（30s busy 强解锁 +
遮挡中和 + 44px 触控下限）、包装官方方法必须保持 Promise 链（返回 `originalSink()`，否则输入框
永久卡死）、`:has()` 每 DOM 变更重算是卡顿源（改 MutationObserver + microtask）；这些补丁的
合法落点是 `dsh-client-web` fork。
- **composer 可见性守卫**（390×844 真机台架实测两处硬缺陷）：① 双倍抬升——sticky `bottom` 与
  滚动器 `padding-bottom` 两臂叠加（滚动器同时是 seat 的 sticky 包含块）⇒ 只保留 seat 的
  sticky `bottom`，余量用流内 spacer；② 不 arm——按 `isKeyboardOpen` 推断在事件缺失时不动作 ⇒
  改为**只测量遮挡**（`covered = scrollport.bottom − (vv.offsetTop + vv.height)`，同布局坐标系）；
- 守卫取舍：可编辑焦点打点（收缩不是充分条件）；缩放策略只服务 composer（一刀切否决会让 iOS
  聚焦缩放永久留在后面）；量化 16px；arm 期间归零 seat 安全区；按 frame 元素幂等；滞回 96/72；
  有界验证（写后复测 ≤2 步、容差 24px，不达标只报 `still-covered` 不追）；自推锁存防空转；
  诊断面 `data-mobile-kbd`/`data-mobile-kbd-state`；触达 = vv/window resize + focusin
  （1200ms 宽限）+ visibilitychange + pointerdown + `[data-phase]` observer + 250ms 有界轮询；
  editability 恢复只吃目标为 composer 自身的 record；
- 被否决：滚动器 padding + seat inset 两臂、调阈值/延迟重试仍走推断、`html[data-mobile-kbd]`
  第二 CSS 载体、任何可编辑焦点都抬升、插件层禁用 PDF.js、懒加载重客户端包（改上游 ⇒ 上游提案）；
- tooltip 粘滞：官方 `Tooltip` 只有 mouseenter/leave/focus/blur，粗指针 tap 无配对 leave ⇒
  `(pointer: coarse) and (hover: none)` 门控、只隐藏 `button[aria-label] + [role="tooltip"][data-side]`
  （官方 31 处用法中 27 处匹配；4 处信息型气泡保留，第 5 处无 `data-side` 结构性排除）；
  原生 `title` 长按气泡不抑制（登记 STATUS）；
- 抽屉点击自愈：iOS 抑制抽屉内点击的合成 click ⇒ 稳定 tap 后 120ms 内无真实 click 时从 pointerup
  目标重发非受信 bubbling click，迟到真实 click 被抑制（防双激活）；平移/滚动/表单控件/抽屉外
  不触发（`drawer-taps.ts`）。导航后不弹键盘：IME layer-1 gesture 改按**导航区语义**丢弃程序化
  回焦（抽屉与会话头起始的手势），composer 内/发送键/硬键盘/portal 选择器保留。

**18.4.5 官方机制确认与 PWA**：官方**不存在 ui-mobile 插件**（窄视口策略是流内换行，移动布局
有意留给第三方）；官方两 manifest 体系即 chamber 走的规范（`dsh.bundle.patch` 的 YAML 数组按
`id` 整行替换 + `dsh.client` → `clientModules` → `__DSH_BOOT__` → 不可变缓存组合脚本；加载
顺序 bundles → profile patch → 机器级 patch → `--patch`）；纯 client 包不可被 `dsh plugin` 安装。
官方 Web Shell 无 `viewport-fit=cover`/safe-area，只有 `manifest.webmanifest`（fullscreen），且
**刻意不提供 service worker**（避免"误导性的不完整离线约定"）⇒ gateway 的空 `sw.js` 占位不得
演变为假离线承诺。社区 PWA 机制（`dsh-ui-mobile`，API 面已随基线漂移，仅作参照）：node host 半
`webServer.tapIndex` 注入 + 浏览器半 data-attribute stamping（可复用于 N-ctx）；三栏→单栏用
`!important` 对抗宿主内联；SW 是 origin 级、N-ctx/gateway 必须 per-instance 路径（否则缓存互相
污染）；Web Push 走 `pushManager` + 幂等对账 + 404/410 清订阅，chamber 需要自己的移动端通知投影
（design 19 延伸），不消费会话内容。

### 18.5 安全与边界

- UA 不是安全边界：路由仅体验分流，认证/授权唯一边界（S1/S2）不变；
- 插件注入信任：chamber 插件 seed 沿用 design 09 既有信任模型（仅 chamber 自有
  包、fail-loud、版本对齐），移动插件不引入第三方运行时依赖；
- SW/缓存纪律：Service Worker 不得缓存认证后响应/凭据；离线能力仅限壳资源与
  公开资产，会话内容离线另议（分期）；**secure-context 约束**：
  SW 只能在 HTTPS 或 localhost 注册——先行形态（内网/可信网络明文 HTTP、SSH
  隧道）下 P2 的 SW/离线不可用；P2 仅覆盖 HTTPS 形态（公网 TLS 反代或 tailscale
  HTTPS），内网 http 形态无离线能力（与官方「不完整离线」立场一致，不制造假离线）；
- 公网形态：`--no-auth` 只存在于显式可信网络形态（S21），移动访问不改变该门。

### 18.6 验收门禁

- 自动化：移动插件 typecheck/test（布局纯函数、断点、编辑态门控与自愈时钟、SW 注册逻辑）、
  gateway UA 路由测试（含伪造 UA 负例）、插件 PWA 资产经 gateway 透传后的 HEAD/GET 测试
  （`/pwa/*`、`/sw.js` 可达且内容正确、未注入形态下 gateway 占位不注册 SW）；
- 实机（移动视口清单，CDP 设备模拟 + 真机抽检）：**设备模拟部分已有工具**——
  `scripts/gui-acceptance/mobile-walkthrough.mjs`（设备尺寸 + 触控模拟 ⇒ 真实 `pointer:coarse`；
  结构化断言：无横向溢出、会话头首行高度、「单字换行」行盒、命中盒；**并抓 WebSocket 帧**，
  是会话打开停滞取证的入口；判定语义由 `mobile-checks.test.mjs` 以合成事实锁定，含已知边界：
  `Emulation.setEmulatedMedia` 的 `pointer/hover` 被 Chromium 忽略、`mobile:true` 的收缩适配会让
  `scrollWidth <= innerWidth` 恒真因而判定以 `clientWidth` 为准）与
  `scripts/upstream/verify-mobile-anchors.mjs`（锚点新鲜度门）。**真机抽检仍不可省**（iOS
  键盘/安全区/`100dvh`/聚焦缩放、惯性滚动与 hover 观感；走查只读，抽屉/设置/键盘补偿未断言）：
  - 触控目标 ≥44px 比例（**座席清单**：composer bar / sidebar / 会话头
    actions+utilities+corner / settings.section / 右栏 dockkit 条 chips+按钮 / menuitem+option）、
    无横向溢出、抽屉开合、弹层不出屏、设置全屏可滚动、输入行单行、安全区/100dvh、键盘不遮挡输入区；
  - 右栏与抽屉（决策的实机判据）：展开的右栏在 769–1023px 档**全屏**呈现、面板自带
    退出控件可点、面板展开期间抽屉与开关不可见且**不在 Tab 序**——**两档都要走查**：<768（上游
    自身全屏、本插件补齐 inset、让位靠 `data-rightbar-fullscreen` 臂）与 769–1023（本插件全屏 +
    轨道臂）；768–1023 档内面板自带的**模式控件不可见**（翻转是 no-op）、关闭面板后
    抽屉回到原开合态可接受、dockkit 条并入 44px 后条高与观感（chips 保持 content-box 以免放宽分屏
    判定；**chips 行由上游 `touch-action:none` 持有，不得期望手指横滚**，越界 chip 只能靠激活邻居
    滚入视野）、面板子树 `overscroll-behavior:contain` 生效（滚动到底不得带动身后文档/工具栏）、
    会话头座席底线落在内容盒（图标按钮约 56px，过厚则三条臂一起改 border-box）、官方浮动面板
    （380×300 @ (160,120)、z-60）与 `ContextMeter` 264px 面板在窄屏是否出屏（已登记未适配，见
    STATUS ③④）、**iOS 安全区**：横屏刘海不得压住面板内容、home indicator 不得压住底部行（面板已带
    `env(safe-area-inset-*)` 且 `box-sizing:border-box`，`viewport-fit=cover` 由本插件注入；真机先读
    `getComputedStyle(panel).boxSizing` 与 `getBoundingClientRect().width` 对比 `visualViewport.width`）、
    键盘已弹起时打开面板的焦点归属（现沿用上游：焦点与输入留在面板之后，是否补 blur 待判）、面板在
    抽屉已展开的 768–979 档是否被上游 `canShow` 自收起（观感待判）、设置页在抽屉内被让位隐藏时的
    「不可见 `aria-modal`」组合（见 STATUS ⑪）、Split View / Stage Manager / 旋转跨越 768 与 1024
    边界时呈现不得在手势中途跳变（见 STATUS ⑩）；
  - 键盘补偿：键盘弹出后 composer 停在键盘顶上方且**不常驻气泡**；捏合缩放（双指放大）**不得**抬升
    composer（缩放守卫）；键盘服务于设置/提问字段时不得抬升 composer（焦点守卫）；**iOS 聚焦缩放后的
    打字**必须仍被补偿（正例：抽屉搜索框 13px 聚焦缩放）；**缩放
    页面上的平移不得引起 seat/滚动范围抖动**（缩放态只服务 composer 的取舍需实机确认）；提交
    （`submitting`）窗口内 seat 不得闪落；会话切换/reconnect settle 重挂 seat 后 composer 仍在键盘
    上方（幂等 arm）；**arm 期间 seat 与键盘顶之间的死区应 ≤23px**（16px 量化的正例，刘海机还须
    确认安全区归零无双重间距）；arm 期间「回到底部」控件必须仍可点到（现落在 `--dsh-composer-height`
    之后，见 STATUS ⑥）；Android WebView 无 `interactive-widget` 时同样生效；无工作区态按 Enter
    **打开工作区选择器**（编辑态门控的正例）、**iPad 接硬件键盘时 Ctrl/Cmd+Enter 仍走官方加速提交**
    （不得被换成换行）、**卡住的提交**（不可编辑 + `data-phase` 为 adjudicating/submitting 满 30s）
    点按可自愈，而**合法锁定态**（owner 阻断 / 父端离线 / 无会话选择器节点）点按**不得**被强解锁
    （自愈范围的正/负例）；carry 一个待判：撑满后的回车换行必须把新行带进可视区（caret reveal 与
    Lexical 归并的时序，见 STATUS ⑦）；
  - 外设与档位：iPad 接触控板/鼠标时本档是否仍以 `pointer: coarse` 成立（文档假设只翻转 `hover`；
    若翻转 `pointer`，移动档退场回落上游窄窗形态，见 STATUS ⑨）；
  - tooltip：点按发送/停止/指令/ContextMeter/队列/侧边栏等带 aria-label 的按钮后**无**残留气泡；
    聊天统计行/代理预设卡片描述/轨迹时间轴与 kind 标签的悬停气泡仍可读（信息型气泡保留）；轨迹
    turn-rail 预览（901–1023px 触控平板）不受影响；接鼠标的触控设备 hover 气泡恢复；桌面宽度零变化；
    **原生 `title` 长按气泡为已登记取舍**（刻意手势，不抑制）；
  - 会话头：抽屉开关不重叠头部内容、crumbs 长链/chip 换行不裁切、视图 tab（chat+trajectory 常驻）
    44px 且**换行**不裁切——活动 tab 那条外伸 1px 的指示条必须仍与头部底线齐平（`overflow-x:auto` 的连带裁切）、头部随 tab 盒增高；抽屉里单击会话行即切换（iOS
    Safari 自愈生效）、切换不弹键盘（composer 意图焦点不受影响）；
  - 设置（手机档）：竖排 nav 变顶部横向 chips 且分类可达/可滚动、Close 固定不随内容滚走（粘滞行仍由
    两条 `data-slot` 缝锚定）、各分区（General/Models/Agent presets/Plugins+inventory）无横向溢出且
    **Models 行 2×2 降级生效**（折叠归上游几何：两张网格均不覆盖，详 §18.4.3）、
    **弹层不出屏且官方几何自足**（含全幅图像 lightbox 不得被限宽裁切）、输入框聚焦不触发页面
    缩放、键盘弹出不遮输入、深浅色与横竖屏走查、**分区 chip 切换后 options 从顶部开始（且点 nav 标题/
    选项区不复位）**；
  - PWA：manifest 生效、SW 注册、安装引导（分期验收）。

### 18.7 分期

- **P1（内网/可信网络形态）**：移动适配插件布局/触控覆盖（抽屉、单栏、
  弹层、设置、输入行、安全区）+ gateway UA 路由开关；
- **P2（未实现）**：PWA 安装 + SW（壳资源离线）；
- **P3（未实现）**：公网认证流转正式化（登录页 ↔ 移动入口）、Web Push 通知（参考社区
  实现，评估 dsh 侧能力）。

## 19. 相关文档

- `03-connections-proxy.md`：共享 HTTP/WS proxy 契约；
- `04-control-plane-api-data.md`：管理 API、静态服务和数据边界；
- `05-connection-manager.md`：Desktop transport 与 N-ctx（kind/transport 扩展面）；
- `08-git-worktree-plugin.md`：实例内 Git 路线（§11 服务器侧 saga 的作用域落点）；
- `09-client-plugin-runtime-loading.md`：chamber 插件 seed/挂载机制（§18 移动插件注入路径）；
- `19-notifications.md`：桌面原生通知投影（§18 P3 Web Push 触发侧的参考面）；
- `18-dsh-runtime-version.md`：dsh 运行时版本管理的权威行为契约；§3.6 = per-server
  设置分节（local/gateway/ssh 三态挂载差异）、§9 = gateway 宿主实现设计；
- `docs/progress/STATUS.md`：当前验证证据和剩余实机门禁。

## 20. 已否决的替代方案

改动触及既有契约或已交付行为时，按 `AGENTS.md` 的 PR 纪律记下「还考虑过什么、为什么落选」：

- **移动停滞提示的控制面**（实现与锚点见 `packages/dsh-chamber-client-ui-mobile/README.md`）：
  - 只留「重载」一个按钮（review 前形态）——**否决**：45s 阈值未经真机校准，健康但缓慢的打开与
    停滞同形，误报时用户只能在「无视提示」与「中断一次合法加载」间二选一；补「继续等待」把误报
    代价降到零，代价是多一个控件。
  - 超时后**无条件**自动重载或自动重开会话——**否决**：违反「只观察、不代替用户决定」的边界，
    慢链路下会把可完成的一次加载变成永久循环。
  - 修订（「进入会话必须有内容，不允许静默无限加载」）：**证据门**自动重开被采纳。
    仅当具象 `Session.openPromise` 明确为空（**无在途 open** ⇒ 慢宿主绝不被中断）且该会话的 cooldown/滚动预算
    账本允许时，模块才调用一次 pinned `resync()`；证据不可读（缺失/抛错/宿主形态漂移）一律 `unknown` fail-closed，
    因此上面那条「无条件」否决仍然成立。文案在 `STALL_FAILED_MS`（180s）后转硬失败面，避免把已失败的加载
    描述成进行中。桌面档同形且更强（另有载波层升级：开帧校验 + 首帧期限 + 静默 socket 替换，design 14 §D4）。
- **只读会话状态镜像的实现形态**（§10.7 carve-out，`packages/gateway/src/session-state.ts`）：
  - 在 gateway 内 headless 运行官方客户端半（`dsh-client-connection` + 会话控制器 + ui-session 插件图）——**否决**：
    需要 cordis + typert 服务图与 location/存储 stub，等于把编排面的依赖重新搬回服务端，且信任面（整张客户端插件图）
    远大于一个只读订阅者；最小 mux 订阅 + 只读 unary 已能取得同一事实。
  - 只做 HTTP 轮询（`session/list`）当主路径——**否决**：粒度受限、看不到短任务与实时等待态，且 design 06 §5 已
    否决「轮询级完成推导」；轮询只保留为能力降级档（`mode:'poll'`）。
  - 让桌面渲染端从聚合 wire 自行推导完成——**否决**：双权威（design 06 §4.3 既有裁决），且旧 pin `0.1.5-rc.2` 实测（历史证据）
    `updatedAt` 只随 user-authored 消息推进，agent 完成根本推不出来。
  - 把该镜像扩成控制路径（gateway 代答审批/提问，或代替桌面决定已读）——**否决**：正是 §10 开头禁止的回流；
    审批是 dsh 原生的，镜像只能看。
  - 未挂载来源的完成状态**只等上游**（host 持久 unread/pending）——**否决**为唯一路径：来源以 gateway 为主时
    镜像可立即闭合绝大多数窗口；上游提案作为长期根治并行推进，前提是降级路径不劣化（§10.7）。
  - 用 `conversationPhase()` 的内部名字（`blank`/`engaging`）当判据——**否决**：它们从不到达
    `[data-phase]`，匹配等于写死一条永不成立（或永不恢复）的规则；DOM 值空间
    （`settling`/`hero`/`active`）才可锚定。
  - 只用 `[data-phase]` 节点当会话身份——**否决**：该节点属于按条目 key 的 root 作用域槽，切会话
    原地复用，计时、提示与「继续等待」被带进下一个会话；会话作用域的 header 子树才是上游实际重挂
    的边界。
- **网关的不可变缓存标记**（§8 附近的资产缓存段）：只按路径形状（`-<hash>.<ext>`）打标——
  **否决**：实测 0.1.0-rc.5 的 frontend-static 会把 miss SPA 回退到渲染后的 index（`text/html`
  200），「JS URL 上的一年期 HTML」会跨版本回滚长期驻留；标记必须同时看内容类型与上游缓存元数据。
  反过来「只在上游声明长缓存时打标」——**否决**：上游对资产不发任何缓存头，等于该优化永远不生效。
- **宿主日志导出器的卸载归属**（`packages/control-plane/src/host-log-bridge.ts`）：直接注册、靠模块
  释放或「同 ctx 二次挂载」自证——**否决**：cordis 的 `LoggerService.exporter()` 把 effect 注册在
  **服务**上下文（应用根），插件卸载不会移除；重新物化 loader 会叠加第二个导出器并把每行应用日志
  写两遍。挂到插件自己的 `ctx.effect` 是唯一由插件生命周期管辖的位置。
- **锚点保鲜门的 fail-soft 默认**（`scripts/upstream/verify-mobile-anchors.mjs`）：缺锚点树直接
  exit 1——**否决**：CI 与裸 clone 上没有上游树（`packages/desktop/vendor/dsh` 只提交 lockfile），
  常态红会把门变成噪声；改为默认 fail-soft + 升级流程 §7 显式 `--require-anchor-root`（缺根、无
  client 产物、锚点树版本与 pin 不符都 exit 1），让「真的查过」可断言。

## 被否方案（单源化：gateway token/password 写入驱动）

`setGatewayToken` / `setGatewayPassword`（design 17 §2.3 的相互独立 nullable 凭据）原为逐字同形的实现。
本次抽出描述符 + 共享驱动 `setGatewayCredential`（ARCH-IMPL-026），并在改造前先补了**两维交叉矩阵**测试
（`packages/desktop/test/gateway/gateway-credential-matrix.test.ts`，7 例：只写一维 / 两维都写 / 两向清除互不触碰 /
清除不存在维度是磁盘 no-op / 非法 id 与校验失败分维 / 无绑定时两维各自拒绝且不落盘）。

被否方案：

- **共享函数 + `kind`/布尔开关**：会让「token 与 password 相互独立」从类型面上消失，N8 明文禁止——
  一次 `kind` 传错就会写错维度。本实现改为每个维度一个描述符（各自的 `validate`/`has`/`write`/`clear`），
  另一维度的表在类型上根本不出现在该描述符里。
- **把清除体也合并**（用 `dimension` 分派到统一分支）：三维语义不同（SSH 传输重建 / token 撤销 / 网关会话失效），
  以及 token 与 password 的表各不相同，合并会在共享函数里重新引入「按维度分派」的开关。
- **只在调用点加注释而不抽共享**：本次重复的正是「校验顺序 + no-op 语义 + 单次持久化 + 提交」这条不变量，
  留下两份副本会随任一侧修复而漂移。

独立性由三组负控锁定：①清除 token 顺手删 password；②本维度 `has` 去查另一维度；③清除不存在维度不再 no-op——
三者都会让矩阵测试变红。
