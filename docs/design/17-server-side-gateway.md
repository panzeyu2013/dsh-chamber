# 17 · 服务端接入层（Gateway）

> 状态：**验收候选（2026-08-23）**。代码、自动化门禁和发布链路已收敛；真实 dsh
> 的 ready/UI/API 基线及 macOS ad-hoc DMG/ZIP 已验证。双 WebSocket 断线恢复、生产 TLS
> 反向代理、打包 Desktop 的 Gateway 交互、真 Git 竞态和正式签名安装仍是发布前门禁，见 §12。
>
> 编号说明：主分支的 Design 16 是 VS Code 深链；服务端 Gateway 在 rebase 后使用
> **Design 17**，不复用或覆盖 Design 16。

## 1. 定位与边界

`packages/gateway` 是 dsh-chamber 仓库内一个**显式启动、强认证**的服务端形态：

1. 托管一份始终监听 loopback 的本地 dsh；
2. 在认证、Host/Origin 和资源边界后反代 dsh 官方 Web 前端与 `/api`；
3. 允许 Desktop 以 `gateway` transport 连接该 HTTPS 入口；
4. 在独立的 `/chamber/*` 面提供有限的服务端编排。

它不是普通 control-plane 的公网开关。普通 Desktop control-plane 仍保持
loopback-only、匿名、只负责连接管理与同源反代。Gateway 的公网能力只在
`packages/gateway` 被显式运行时存在。

### 1.1 Gateway 可以做什么

| 能力 | 权威与边界 |
|---|---|
| dsh 托管、健康、reaper、日志 | 复用 `packages/control-plane` |
| 官方前端、HTTP/WS/SSE 反代 | 复用共享 `proxy-forward` 内核 |
| 密码登录、Bearer token | Gateway 自有入口认证 |
| 派生会话摘要 | `session.list` + host/mux 控制流重建，绝不消费会话正文 |
| 审批与提问转发 | 只投影 pending 控制帧，回答仍提交给 dsh `/api/respond` |
| 跨会话定时触发 | Gateway 自有任务定义，到点调用 dsh `session.prompt` |
| 同 OS 用户 Git worktree | 受 dsh workspace 权威和安全 saga 约束 |

### 1.2 Gateway 不做什么

- 不实现聊天、会话内容存储、工具执行或第二套 dsh runtime；
- 不把公网认证面塞回匿名 control-plane；
- 不从 renderer 接收上游 URL、Authorization 或任意 Git argv；
- 不把派生索引当作 dsh 权威；流 generation 失效时立即清空旧活性；
- 不在进程内终止 TLS。生产 HTTPS 必须由可信反向代理提供；
- 不在本阶段退役 Design 08 Git 插件。两条路线在实机稳定门禁前并行。

## 2. 组合架构与生命周期

```text
Browser / Desktop
        │ HTTPS (production reverse proxy)
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
upgrade middleware 和 CORS evaluator 才能越过 loopback 构造门。仅传宽松 CORS 回调不能
把匿名 control-plane 暴露到网络。

### 2.1 启停顺序

启动成功必须满足完整链路，而不只是监听端口：

1. 校验 materialized config，拒绝 JS 调用者绕过 CLI 安全门；
2. 打开 Gateway/control-plane server；
3. 注册本地状态订阅；
4. 调用 `startLocal()` 并等待 dsh `ready`；
5. 仅在 `ready` generation 启动索引、通知和 scheduler；
6. 任一步失败都会停止已打开的 server，下一次 `start()` 可重试。

停止时先关闭 Gateway 自有 WS/feature consumers，再停止 control-plane 与 managed dsh。
dsh 从 ready 离开时 feature host 立即 detach；scheduler 保留定义但清除 timer，下一代
ready 后重新 arm。

## 3. 配置与部署

主要 CLI：

```text
gateway serve [--host 127.0.0.1|0.0.0.0] [--port 3000]
              [--state-dir DIR] [--dsh-path DIR]
              [--ui-password PASSWORD] [--api-token TOKEN]
              [--public-origin https://gateway.example.com]
              [--trusted-proxy IP ...] [--cors-origin ORIGIN ...]
```

兼容别名为 `dsh-chamber-gateway`。环境变量包括 `DSH_GATEWAY_HOST`、
`DSH_GATEWAY_PORT`、`DSH_GATEWAY_STATE`、`DSH_GATEWAY_DSH_PATH`、
`DSH_GATEWAY_PASSWORD`、`DSH_GATEWAY_TOKEN`、`DSH_GATEWAY_PUBLIC_ORIGIN` 和
`DSH_GATEWAY_TRUSTED_PROXIES`。

生产建议用 owner-only 的 systemd `EnvironmentFile` 或 secret manager 注入凭据，避免把
真实 token 写入命令历史或 unit argv。Gateway 会从 managed dsh 和 Git 子进程环境中按
大小写不敏感规则剥离全部 `DSH_GATEWAY_*`。

### 3.1 配置硬门

- bind host 只允许 `127.0.0.1` 或 `0.0.0.0`；port 必须为 1–65535；
- 非 loopback bind、配置 `publicOrigin` 或配置 trusted proxy，任一成立即视为外部部署，
  必须有密码或 token；
- **有界偏差（2026-08，用户决策）**：`--allow-anonymous-external` 显式覆盖上述 S1 门，
  允许无认证的外部绑定。仅当显式传参才生效（默认仍 fail closed），且启动时打印
  醒目安全告警；仅限可信网络使用。见 `docs/progress/STATUS.md` 偏差记录；
- 密码长度 12–1024；token 长度 32–4096 且必须为 visible ASCII；
- 密码与 token 可以同时启用，不互相遮蔽；
- `publicOrigin` 必须是无 path/query/userinfo 的 canonical HTTP(S) origin；
- trusted proxy 只接受精确 IP，不接受网段或主机名；
- `--tls-cert/--tls-key` 即使成对提供也会 fail closed，因为内置 TLS 未实现。

推荐形态是 Gateway 监听 loopback，Caddy/Nginx 负责 HTTPS，并配置：

- `--public-origin https://gateway.example.com`；
- `--trusted-proxy <反代的精确 IP>`；
- 反代覆盖而不是追加 `X-Forwarded-For/Host/Proto`；
- 只把 Gateway 的监听端口暴露给该反代。

## 4. 单一公网请求策略

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
| `/api/events.mux`、`/api/events.host` upgrade | 单目标 Gateway proxy | 必须且同一 Host/Origin 策略 |

## 5. 认证与凭据生命周期

### 5.1 Password

- 登录页提交 form-urlencoded；API 客户端也可提交 JSON；
- scrypt 在有界并发队列中异步执行，失败尝试按边界派生 client IP 限流；
- 成功后签发 12 小时 HS256 cookie：`HttpOnly; SameSite=Strict; Path=/`，只有边界确认
  HTTPS 时附加 `Secure`；
- 登录页 CSP 只允许 self form 和 inline style，不开放脚本；
- 持久化 salted credential verifier。进程重启时若密码增加、删除或改变，先旋转
  `jwt-secret`，旧 cookie 立即失效。

### 5.2 Bearer token

- token 只以 salted hash 存在于 Gateway state；常量时间校验；
- 只接受一个有界 `Authorization: Bearer …`；
- Desktop renderer 永远看不到 token；token 由主进程注入到注册 transport 的请求；
- token 更新、清除、kind 切换或 transport unregister 会关闭该 transport 已建立的
  HTTP/SSE/WS 流，旧凭据不能继续读取数据。

### 5.3 入口失败语义

- 未认证 API/asset/WS 返回 401；
- password 形态下，未认证的普通 HTML 文档导航跳转登录页；
- Host 错误返回 421，Origin 错误返回 403；
- 登录过载返回 503，限流返回 429；登录 body 上限为 16 KiB，超限返回 413、立即释放已收字节
  并进入 drain-only；凭据和内部错误不进入日志或响应。

## 6. 反代内核与资源边界

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

已声明 body 预分配单一 buffer，避免 chunks + `Buffer.concat` 的双倍峰值；进程预算在上游
完成消费或流被撤销前不提前释放。事件流上限发生在 JSON/正文过滤之前；任一上限超出都会
清空 raw queue、终止该 generation 并由索引/notifier 重连，不能以快速或超大 session/event
绕过净化后的 baseline buffer。

## 7. Desktop Gateway transport

Desktop registry 的远程 kind 为 `ssh | gateway`：

| kind | source id | base path | transport |
|---|---|---|---|
| `ssh` | `ssh-<id>` | `/api/i/ssh-<id>` | loopback SSH tunnel |
| `gateway` | `gateway-<id>` | `/api/i/gateway-<id>` | credential-free HTTPS origin |

Gateway URL 必须是无 path/query/fragment/userinfo 的 HTTPS origin。token 经 preload 的专用
write-only IPC 交给 main，保存在内存和 `<userData>/gateway-tokens.json`（0600、原子写）；
registry、renderer projection、日志均不含 token。

live credential 更新是事务：disconnect/unregister → 持久化 secret → reconnect；写失败时
用旧凭据恢复。kind 切换先停止并注销旧 provider，再启动新 provider；删除实例会清理 SSH
password 与 Gateway token。Gateway 5xx 都按瞬态处理，允许有界重连。

## 8. Gateway 编排面

### 8.1 会话索引

索引只包含 `sessionId/title/metadata/running/blank/cwd/updatedAt`。每一 generation：

1. 同时打开 `events.mux` 和 `events.host`；
2. 等到两个 WebSocket upgrade 完成、listener 已安装的真实 ready barrier；
3. 缓冲此后的流帧；
4. 获取权威 `session.list` baseline；
5. 按 seq/generation 规则重放缓冲帧；
6. 任一流死亡即清空投影，再重连，绝不跨代暴露旧 `running:true`。

索引忽略 `session/event` 正文和审批/提问帧。mux 只复制经过长度与形状校验的
subscribed/title/sessionListMetadata；host 流只复制 added/status/removed。baseline 窗口最多
保留 4096 个已经净化的控制帧，超限会放弃整代并重连，正文与未知字段不会进入缓冲区。

### 8.2 审批、提问和通知

`/chamber/approvals` 提供 JSON poll、SSE 和 POST answer。pending 以 request `rpcId` 去重；
`approval/resolved`、`question/resolved` 与 generation reset 会向所有 SSE 客户端广播撤回，
避免多设备残留 stale row。

回答必须检查 dsh 的 `RpcReceipt.accepted`。`accepted:false` 返回 409，并保留 pending 供重试；
只有确认 accepted 才删除。approval 只允许 `allowed-once | rejected`，question 使用严格的
结构化 answers 形状。

### 8.3 Schedule

`/chamber/schedule` 存储跨会话 job，并调用已有 `session.prompt`。delay/interval 都不能超过
Node/libuv 的 `2^31-1` 毫秒上限；interval 采用 single-flight 的 fixed-delay 递归，不允许前一次
RPC 未结束时重叠触发。一次性 job 只有 dsh 调用和持久化删除都成功才消费；失败按 1–60 秒
有界退避重试，不能复用 `delayMs=0` 形成热循环。timer callback 同时校验 run generation、job
identity 与 in-flight 状态，cancel/detach 后不能幽灵重建。Feature detach 只停 timer，不丢定义。

### 8.4 Settings 与界面

Gateway 自有 JSON API：

- `/chamber/settings`：GET/PUT 已知编排设置；
- `/chamber/sessions`、`/chamber/channels`：只读投影；
- `/chamber/approvals`、`/chamber/notifications`：poll/SSE/answer；
- `/chamber/schedule`：list/create/delete；
- `/chamber/git/worktrees`：list/create/delete。

`git`、`notifications`、`schedule` 三个能力默认关闭；开关是服务端执行门而不是 UI 提示。
禁用能力的所有读写路由稳定返回 `403 feature_disabled`。Settings PUT 必须先完成 owner-only
持久化，再在同一串行临界区即时 attach/detach；关闭 notifications 会撤回 pending 并关闭 SSE，
关闭 schedule 会停 timer 但保留 job 定义，重启按持久化开关恢复。

浏览器可在 `/chamber/` 打开 Gateway 自有编排页；页面只使用同源 cookie/fetch，不接收或
持久化 token。Desktop settings-bridge 仅对选中的 `gateway` server 显示固定编排入口，路径
从 canonical `gateway-<id>` 派生为 `/api/i/gateway-<id>/chamber/*`，同样不接触 token。
各资源独立失败，单一路由错误不会抹掉其他已加载数据。

## 9. Git worktree 安全 saga

Git 在 Gateway OS 用户下执行，但客户端不能指定任意仓库执行：

1. 调 `workspace.list` 获取 live workspace 权威；
2. `repo` 必须 realpath 为某个 live workspace 的 canonical 主 checkout，不接受 linked worktree；
3. `newPath` 必须是该 checkout 同层、尚不存在的路径；branch 通过严格 ref 字符白名单；
4. Git 子进程有并发、输出和 timeout 上限，环境剥离 Gateway secrets 与全部继承的
   `GIT_*` 覆盖变量，只显式重建安全的 Git 环境；
5. `git worktree add` 后调用 `workspace.create`，解码
   `value.workspace.workspaceId + created`；再调用 `session.create`；
6. 只有每一步的归属与提交状态确定时才允许补偿。

网络/协议失败可能发生在服务端已提交之后。遇到 `workspace.create` 或 `session.create` 的
歧义结果时，Gateway 保留 Git 路径并写 recovery；绝不猜测失败后强删。`created:false` 不会
删除既有 workspace，`ownership:'unverified'` 的记录禁止 DELETE，必须人工 reconcile。

删除契约：

- 只接受持久化且 `ownership:'owned'` 的记录；DELETE body 必须为空；
- canonical path、主 checkout、锁定和运行中 session 都会硬拒；session cwd 比较前 realpath，
  解析失败 fail closed；Git mutation 前后都重查 live session；
- 不 archive session、不使用 `--force`、不删除 branch；
- create/delete 在紧邻任何 Git mutation 前都重取并完整重验 live workspace；同一路径、
  其子路径或 realpath/symlink alias
  被不同 workspaceId 重占时硬拒，旧 deleting 记录不能授权删除新主体；
- 先持久化 `state:'deleting'`，再执行可恢复 saga；Git 路径已不存在时只重试
  `workspace.delete`；旧 workspaceId 已消失但路径仍存在时硬拒，只有 workspace 与路径都消失
  才视为已收敛；workspace 删除未确认时不会继续删文件；
- store 失败不会反向删除已经发布的 session/worktree。

现有 host API 没有“检查 session + 删除 worktree”的原子 lease，因此两次 live check 只能
把 TOCTOU 窗口压缩而不能数学上消除。发布前实机并发测试是强制门禁；长期根治需要 dsh host
提供原子 guard/lease，而不是在 Gateway 继续增加启发式。

Design 08 插件在 Gateway Git 真机稳定、分支合并并完成数据/回滚计划之前继续 seed；本设计不
提前删除该包或既有数据。

## 10. 持久化与恢复

Gateway state 与 dsh `$DSH_HOME` 分离。主要文件：

```text
<stateDir>/
├─ gateway.json
├─ tokens.json                 # salted token hash, 0600
├─ jwt-secret                  # 0600
├─ password-credential         # salted verifier, 0600
└─ gateway/
   ├─ settings.json
   ├─ worktrees.json
   └─ schedule.json
```

`stateDir` 与 `gateway/` 目录每次启动都收敛为 `0700`；所有 JSON main/backup/tmp 与 secret
文件每次加载和写入都收敛为 `0600`。已有 secret 先以 no-follow/inode 校验拒绝 symlink 与
非普通文件，再收紧权限并读取。JSON 文档经 `createJsonStore` 的 owner-only 原子写路径
持久化，写操作串行化，避免并发请求以旧 snapshot 覆盖新值。corrupt 主文件会先尝试 backup；
双重损坏会响亮失败，不伪装成空配置。

## 11. 包、CI 与发布

`@dsh-chamber/gateway` 构建为 `dist/index.js` 与带 shebang 的 `dist/cli.js`，要求 Node 22+；
package export 不指向源码 TypeScript。根脚本包含 `build:gateway`、`typecheck:gateway`、
`test:gateway`。

CI 运行 Gateway typecheck、完整测试、release workflow policy 和 pack/install CLI smoke。release workflow 在 macOS 与
Windows Desktop 产物门禁完成后才 pack Gateway、安装 tgz、执行 `gateway --help`，随后使用
`NPM_TOKEN` 发布 npm，并把同一 tgz 上传 GitHub Release。版本门同时检查 root、Desktop 和
Gateway package，防止发布漂移。npm publish 以本地 tgz 与 registry `dist.integrity` 做可恢复
幂等判断：同版本同完整性视为已完成，不同完整性硬失败；只有 registry 明确 E404 才允许首次
publish，网络、权限和未知查询错误全部 fail closed。版本只经环境变量进入 shell，并先校验
canonical SemVer、八包一致性和 tag peeled commit 等于 checkout SHA；manual dispatch 创建新 tag
时显式绑定该 SHA。所有发布全局串行且不取消运行中事务，npm 稳定版只推进 `latest`、预发布只
推进 `beta`，并用 SemVer 单调门拒绝 channel 回退；同包重跑会核验或修复 dist-tag。已公开的
GitHub Release 永不删除，只有 stale draft 可替换；dry-run 不创建或修改 release。正式构建不使用
仓库内固定的第三方 Electron mirror。

## 12. 验收门禁

### 12.1 自动化门禁

合并前必须全部通过：

- root、Gateway、所有 chamber client/host 包 typecheck；
- control-plane 协议、存储、托管、管理 API、静态服务、实例代理测试；
- Gateway config/auth/request-policy/dispatch/proxy/lifecycle/feature/真实 socket 测试；
- Desktop 全量 transport/provider/secret/plugin/deep-link 测试；
- renderer shell、sidebar、connections、settings-bridge、Git 插件回归；
- renderer 与 Gateway build；Gateway pack/install/CLI smoke；
- frozen lockfile、i18n、`git diff --check`、冲突标记扫描。
- release workflow 的 commit/tag 绑定、公开 release 不可变、dry-run 零写入和 npm channel 策略测试。

### 12.2 发布前实机门禁

自动化全绿仍不能替代以下实机证据：

1. 安装的真实 dsh：Gateway 启动等待 ready，登录后 `/`、普通 `/api`、events.mux/host
   HTTP/WS、插件 bundle 与 `/chamber/` 全部可用；
2. 生产型 TLS 反代：publicOrigin、Host、Origin、XFF、Secure cookie、WebSocket upgrade、
   未认证/错误 authority 行为逐项验证；
3. 打包 Desktop：新增 Gateway、重启后自动连接、token 更新/清除撤销既有流、N-ctx 和
   Gateway settings 页面；
4. 真 Git 仓库：创建/歧义恢复/删除重试、dirty/locked/主 checkout、运行中 session 与
   并发启动 session 的安全验证；
5. macOS 发布产物完成签名/公证/安装；Windows 产物完成签名与安装。

PWA 安装、离线缓存和 UA 移动轻面不属于本轮验收；不再暴露无实现的 CLI flag。它们如需推进，
必须作为独立设计与测试面进入 STATUS。

## 13. 安全不变量摘要

| # | 不变量 |
|---|---|
| S1 | 外部部署无认证不能启动 |
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

## 14. 相关文档

- `01-overview.md`：产品边界与 Design 17 有界例外；
- `03-connections-proxy.md`：共享 HTTP/WS proxy 契约；
- `04-control-plane-api-data.md`：管理 API、静态服务和数据边界；
- `05-connection-manager.md`：Desktop transport 与 N-ctx；
- `08-git-worktree-plugin.md`：迁移期保留的实例内 Git 路线；
- `docs/progress/STATUS.md`：当前验证证据和剩余实机门禁。
