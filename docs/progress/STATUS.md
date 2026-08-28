# 模块完成状态总览（STATUS）

> 本文档只追踪**未完成 / 部分完成**项与范围契约。已实现基线以 git 历史、
> `CHANGELOG.md` 与 `docs/design/`（设计契约与样式定稿）为权威，不再在此
> 复述实现过程与验证日志。本文档是 dsh-chamber 进度追踪的唯一记录。

## 未完成 / 待执行

- **已归档会话管理（设计 12）**：方案 A（前端已归档浏览区先行）+ C（上游
  wire 根治）；实现未排期。设计见 `docs/todo/12-todo-archived-sessions.md`。
- **模型额外参数 + 默认推理等级（设计 07）**：实现推迟——wire 白名单无泛化
  透传、host 组合不可注入、`agent-default-model` 未对客户端暴露，待上游
  解锁（07 §3/§4）。设计见 `docs/design/07-models-params.md`。
- **SSH 密码认证可选增强（05 §8 例外主体已落地）**：未做（可选）——一键
  免密引导、系统钥匙串。
- **Windows 首版支持暂缓**：detached/进程组/lsof 降级路径；Unix 为契约
  目标。
- **dsh 运行时版本管理（设计 18，M5–M7 已落地，含 gateway 完整管理面）**：
  `/chamber/runtime` JSON reader 已按累计字节强制 64 KiB 上限（超限立即释放 retained
  chunks、后续事件 no-op、先 413 再 destroy，并有 poison-chunk 回归）；Gateway 的
  restore-builtin 完整激活事务、registry 损坏 fail-loud/离线缓存、固定身份与完整
  failure/restore/snapshot/progress/disk 投影、独立 `/chamber/` runtime 管理块均已锁步；
  gateway staged selection 以 `selectedOnly` 区分合法 builtin 空 pointer 与用户树指针
  丢失，install 与 activation quarantine 分离（下载不下线现有 proxy/features），候选
  ready 在探针 verdict 前不 attach；env override 健康投影，普通 pending 在 core/
  route/settings/dashboard 仅允许 restore-builtin；
  剩余——
  - 打包态实机验收：`dist:desktop:mac` 实跑（dist/asar 含共享
    `packages/dsh-runtime`，afterPack 校验已显式化）；macOS/Linux 可管理，
    Windows 只读（M1/M3 partial）。
  - gateway 实机门禁残余：gateway restart 窗口前端重连实机、ssh
    `restart_service` systemd IPC
    端到端回归（分支仅 `deriveRuntimeSource` 有派生测试）。
  - restart-local 测试用立即 resolve 的 stop mock，未覆盖真实 1s
    SIGTERM→SIGKILL 窗口与 grace 期间健康计时器交互。
  - React 组件级缺口：gateway 分支（服务器切换重取/取消、动作失败链路）与
    ssh 分支 hostId 截取均无组件单测（纯函数与 API 客户端已测：
    `gateway-runtime-api` 的状态视图映射/错误分类/settle 轮询/解析器；
    server 切换重取/取消经 keyed remount + effect cancelled 守卫实现）。
  - 该机 ZFS 下 pnpm 全新 store 克隆偶发 `ERR_PNPM_EAGAIN`（瞬时、失败投影
    诚实、重试恢复）；系统化缓解（克隆并发上限）留待后续。
  契约见 `docs/design/18-dsh-runtime-version.md` §9/§3.6。
- **发布基础设施长期目标态**：ci.yml 的 test job 抽 reusable workflow 供
  release.yml 的 validation 直接复用；当前 release validation 已补齐 gateway/
  runtime typecheck+tests、关键 control-plane 用例与 CLI/policy 门禁，但两份 YAML
  仍为人工同步，新增 CI 门禁时仍有漂移风险。
- **desktop 打包闭包已知 P2（非阻塞）**：托盘图标死候选（`tray.png` 两处
  路径永不存在，仅靠第三条兜底）；`dist/**/*.map` 未排除；preload 回退分支
  （`dist/preload.cjs` 缺失时回退 `preload.cts`）打包态沙箱内会 SyntaxError，
  建议回退改 loud 报错；共享 dist 目录（vite `emptyOutDir` 会清空
  desktop/dist，单跑 `build:renderer` 会删其他产物，dev 有懒构建自愈）。
- **打包闭包自检脚本（长期建议）**：CI 加「main.ts 模块闭包 vs build.files
  清单」自检，替代手工核对。

## 部分完成（剩余验收 / 剩余实现）

- **桌面通知（设计 19）**：剩余 macOS 系统通知权限实机验收（打包态冒烟）。
  契约见 `docs/design/19-notifications.md`。
- **VS Code 深链 + open-in（设计 16/20）**：剩余实机验收——macOS 深链冷/热
  启动、打包态、托盘/退出在途、N-ctx、VS Code 缺失、sshPort≠22、dev 深链
  argv 注入测试路径、Finder 下拉在 vendor 头部的定位/层叠、远程来源仅 vscode。
  契约见 `docs/design/16-vscode-deeplink.md` / `docs/design/20-open-in-registry.md`。
- **Git Worktree 插件（设计 08，v1 已落地）**：M4 尚余真实远程 Linux + Git
  仓库的端到端验收（含首次 ready-time seed 后重启生效、Git LFS/filter 提示
  边界）。契约见 `docs/design/08-git-worktree-plugin.md`。
- **远程实例插件管理（设计 13）**：剩余——本地 `dsh plugin`/`pnpm pack`
  依赖本机 pnpm（`resolvePnpmBinDir` 扫描 PATH + nvm/volta/homebrew，打包态
  best-effort）。契约见 `docs/design/13-remote-plugin-management.md`。
- **桌面端更新（设计 11）**：剩余——配置真实签名秘密后的 release CI 上传/
  公证/验签实测，双平台实机检查/下载/退出安装；mac 安装腿未配置 Developer ID
  时 settings 响亮提示手动安装。契约见 `docs/design/11-auto-update.md`。
- **会话创建/fork 侧边栏收敛延迟修复**：剩余本地 + 远程 SSH 实例实机验收
  （行出现延迟、状态图标延迟、位置跳动三类症状的改善确认）。
- **认证服务端 Gateway（设计 17）**：剩余发布前实机门禁（17 §16.2）——生产
  TLS 反代（Caddy 等）Host/Origin/XFF/Secure-cookie 实机验证、真实 dsh 的
  events.mux/host 双 WS 断线恢复与插件 bundle；**打包 Desktop 三形态新增
  Gateway**（https+凭据 / http 明文+凭据 / http 无认证）、重启后自动连接
  （safeStorage 解密 + 密码会话重登）、token/密码更新/清除撤销既有流、N-ctx
  与 gateway 完整运行时管理面（版本选择/状态/快照/更新/回滚/恢复内建/
  registry/restart 与轮询，STATUS design 18 条目同口径）；生产
  TLS 反代下 `/chamber/runtime` 的 SSE/poll
  与认证行为（design 18 §9.5）；`--bind 0.0.0.0` 明文 HTTP 直连（带凭据 /
  `--no-auth`）、SSH 隧道回环直连、tailscale 直连——四组合全链路 + 401/421/403
  负例；真 Git 仓库的并发 session 删除竞态与恢复、macOS Developer ID 公证安装
  及 Windows 签名安装。session.list→Git mutation 的 TOCTOU 已以 realpath
  fail-closed + 两次 live check + non-force 缩小（上游根治待原子 session
   lease）。**已实现（PR2/PR3 落地，17 §2.3/§5.1/§12/§13.4/S21–S24 决策）**：S21
   （http 明文 `insecureHttp` + 客户端不前置校验）保持既有实现；S22/S23/S24
   与密码登录会话（`/auth/login` + cookie 注入 + 401 重登）已落地，逐项如下。
   - **S22 凭据存储 v3（safeStorage + target binding + 0600 明文回退）**：
     `gateway-secrets.json` schema v3 tokens+passwords 双表、各维度
     gateway-domain binding + 文件级 `storage:'safeStorage'|'plaintext'`
     权威判别（密文绝不按 base64 字符启发式当明文）；`SecretCryptoAdapter` 接线 Electron
     safeStorage（`isEncryptionAvailable()` 为真时 encrypt/decrypt 为 base64
     密文 blob，否则 0600 明文回退）；token/密码清除互不影响（§2.3 独立
     可空维度），整实例双清走显式 `setInstanceSecrets(id, null, null)`
     （main-owned delete/save transaction）；密码允许 12–1024 Unicode JavaScript
     字符，token 保持 32–4096 visible ASCII；双表
     corrupt 检测（非空无 discriminator 的历史 v2 fail closed、`.corrupt` 保留）；
     plaintext 在 keychain 后来可用时立即原子升级，只有成功落盘后才投影
     `safeStorage`，失败继续响亮显示 plaintext；gateway/SSH 两类凭据文件载入均
     no-follow/普通文件/inode 复验并在读取前以打开 fd 收紧 0600；
     当前配置路径内结构合法的 gateway v1、带合法 storage 的非空 v2 与 SSH
     password v1 无法证明目标，均以唯一 `.unbound-*` 保留、禁用并要求显式重录；
     旁路旧 `gateway-tokens.json` 非空 v1 原地保留并禁用，不猜测绑定；
     **`instances_get` 投影合并
     `secretStorage`（`'safeStorage' | 'plaintext'`）**——safeStorage 不可用时
     main 侧 loud registration + UI 设置页可见明文回退路径。
   - **S23 SPKI 证书固定（https 直连可选门）**：`TransportInstanceInput`/`Spec` 可选
     `spkiPin`（hex sha256 of SPKI DER，`^[0-9a-fA-F]{64}$`，validateSpec 拒绝非法值
     与 http 模式 + pin）；verifyGatewayEndpoint https + pin → socket 层
     'secureConnect' SPKI 校验（Node 22 实测 checkServerIdentity 错误在
     rejectUnauthorized:false 下被忽略、内部 CA 链在 rejectUnauthorized:true 下
     先失败——故 pin 作为信任锚：rejectUnauthorized:false + agent:false + 校验器，
     不匹配 terminal「证书固定不匹配（SPKI）——gateway 证书已更换或 pin 错误」）；
     instance-proxy registerTransport 第 4 参 `opts.tls.spkiPin`（仅 gateway+https，
     dsh/http 拒绝），TransportRecord 携带，proxy-forward forwardHttp/forwardUpgrade
     带 pin 转发（不匹配 → 显式 502 upstream_failed）。desktop 登录/探针与
     control-plane HTTP/WS 反代共享 pre-write 门：TLS `secureConnect` 匹配 peer SPKI
     前不调用请求 `write/end`、不发送 upgrade handshake/header/credential/password
     body 或任何应用层字节，mismatch 时上游 server handler/upgrade 均为零；main.ts 注册时传
     `opts.tls.spkiPin = spec.spkiPin`；transport-manager transportFieldsChanged 纳入
     spkiPin（pin 编辑重启活动传输）；真实 node:https 自签证书 fixture 测试
     （pin 匹配探针成功 / 不匹配 terminal / 无 pin 正常；registerTransport 校验；
     带 pin 转发 HTTP/WS）。
   - **S24 轻量非秘密审计（桌面 audit.log + gateway 登录事件投影）**：桌面
     `packages/desktop/audit-log.ts`（JSONL 追加 + fsync、0600（遗留松权限回紧）、
     5 MiB 轮转到 `<file>.1`（删旧 .1）、白名单序列化——凭据字段即使被误传也绝不
     落盘）+ main.ts DI（`configureAuditLog(<userData>/audit-log.jsonl)`）：phase
     迁移（connecting/ready/error 含 requiresUserAction terminal）、transport
     注册/注销（认证存在性标记 token+password|token|password|none + insecureHttp，不记值）、
     `save_connection` / clear-only setters 的 credential_set/credential_cleared
     （不记值）；
     `packages/gateway/src/audit.ts` 同款 + index.ts 配置 `<stateDir>/audit.log`
     （0700 stateDir 内）+ dispatch.ts login 分支记成功/invalid_credentials/
     rate_limited/busy 分类（含客户端来源，绝不含密码与 cookie）；双端单元测试
     （追加/轮转/0600/无凭据字段 + login 事件分类）。
   - **密码登录会话（`/auth/login` + cookie 注入 + 401 重登）**：gateway 侧
     `/auth/login`（GET 最小登录页 / POST 校验密码 → `dsh_gateway_session`
     cookie → 302 `/`）；桌面侧 `gateway-session.ts` 管理器（12h
     `dsh_gateway_session` cookie，仅主进程内存，按 **网络 origin + `Host` authority +
     stable connection-target scope** 键控；scope = connection id + 目标摘要，SSH 摘要含
     host/user/sshPort/remotePort 且不含易变 localPort，direct 摘要含 host/remotePort；
     authority 只负责路由，不代表 ownership，因此同 origin 的不同 direct id、复用
     localPort/authority 的不同 SSH 目标也不共享 Cookie）经
     `configureGatewaySessionProvider` 接线：verifyUp 对密码型 gateway 目标独立
     ensureSession → 带 Cookie 探针（缓存会话快速路径，401 → invalidate + 有界重登）；
     `ensureSession`/`generation`/`registrationAuthProof`/`setRegistrationAuthProof`/
     `cachedCookie`/`invalidate` 六个 hooks 强制 all-or-none；exact-scope
     invalidation 覆盖全部历史 origin、提升每个观察 key 的 generation 并取消 active login，
     登录/Cookie probe/Bearer fallback/401 relogin 每次 await 后复验，旧结果不能继续联网或
     改 cache/backoff/auth proof。verifyUp 记录当前 generation 的 `cookie|bearer` proof；
     密码型 ready 注册必须同时有 Cookie + cookie proof，只有已验证 Bearer fallback 的
     token+password 目标可 Bearer-only，proof/Cookie 丢失则 fail closed 重连而非无头注册；
     token/password 同时配置时探针与 ready/refresh 注册同时携带 Bearer+Cookie，
     gateway 以 OR principal 裁决（任一有效即成功，不存在 token 优先；token scrypt
     gate `auth_busy` 时有效 Cookie 仍成功，无效 Cookie 才保留 503）；都空→0 头（0..2 白名单
     由 instance-proxy 复验）；**预过期会话刷新（TTL−60s 定时重登+重注册，
     `gateway-session-refresh.ts`）**：每个已注册密码型目标在缓存会话过期前
     ~60s 定时重登并以新 cookie 重注册 transport、重 arm（armed on ready /
     disarmed on 离开 ready/移除/退出；每次 arm/disarm/dispose 提升按 id refresh epoch；
     await 后、retry/register/reconnect 前复验 epoch 与 password/token/URL/pin/authority/
     scope；隧道重连换端点 → 新 origin 重新登录），
     刷新失败保持旧注册、过期时刻重试、已过期仍失败如实告警走有界重连
     （verifyUp 用存储密码重登）；main.ts 使用
     `configureGatewaySecretStore(<userData>/gateway-secrets.json)`；非空 token/密码
     仅随 `desktop_ssh_save_connection` 提交（密码 12–1024 Unicode 字符门），legacy
     `desktop_gateway_set_password`/token setter 仅 clear，清密码同时撤销缓存会话；
     write-only preload/两处 global.d.ts 锁步；`instances_get` 合并 `tokenSet`+`passwordSet`+
     `secretStorage` 三项非秘密投影。Gateway transport 身份改为认证后
     `/chamber/runtime/status` 精确 marker，managed dsh blocked/down 时 desktop
     反代仍 ready 可恢复；SSH tunnel 的 Host/session authority 固定远端
     `127.0.0.1:<remotePort>`，不再误用 SSH alias 触发 421 或 session-key 漂移。
   - **连接保存与 SSH askpass 信任边界**：renderer 表单只调用一次
     `desktop_ssh_save_connection`；主进程对 registry + SSH password + gateway token/
     password 拍 write-only 快照并补偿提交，gateway 凭据只绑定 kind+host+remotePort，
     SSH 密码单独绑定 host+user+sshPort；binding 与 secret 同次落盘并在注入前复验
     registry，崩溃窗口 fail closed；进入/离开/retarget 留空也清隐藏半事务值。
     删除只走精确 `desktop_ssh_delete_connection(id)`：先断开、撤销 exact scope 的全部
     历史 origin 会话、清 secret 后删 metadata，不存在 id 为幂等 no-op；legacy
     `instances_set` 只接受与当前规范化 roster 同长度/同顺序/逐字段相同的 exact no-op，
     三个 setter clear-only。ssh↔http 不再误清/强制重录 gateway 凭据。
     askpass helper 改入每进程 `mkdtemp` 私有 0700 目录并复验 uid/inode/mode，历史
     可跨用户预占的共享 `/tmp/dsh-chamber-ssh` 永不用于写入，EPERM/属主异常 fail closed；
     每个 tunnel/systemd/run child 持有独立 lease，真实退出才清对应 helper，移除/clear
     对仍在途 lease 延迟 purge，不再以固定代际 cap 误删。
     `serviceName`/`remoteDshHome` 编辑同时提升 transport generation 与 `execEpoch`，撤销
     旧 live/retry/probe 和 exec child（SIGTERM→SIGKILL），下一次多步 spawn 与迟到日志/
     投影/结果均复验 generation；原连接非 idle 才按新参数重启。systemd 固定 argv
     `systemctl <action> -- <serviceName>`，白名单
     `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` 强制首字符为字母或数字。
   - **dsh HTTP 直连注册边界**：canonical
     `{kind:'dsh', transport:'http'}` 显式携带 transport 维度注册，允许用户配置的
     公网 `http(s)` origin，但仍禁止鉴权头与 `/chamber/*`；dsh SSH 与 legacy
     未声明 transport 的注册继续强制 loopback，不扩大既有信任边界。
   **待执行**：重启后自动连接的实机验收。
  **有界偏差（2026-08 用户决策）**：
  `--no-auth` 显式开关允许无认证外部绑定覆盖 S1 硬门（默认 fail closed，
  仅显式传参放行并打印醒目安全告警，仅限可信网络）；**已记录风险**：N-ctx
  单文档模型使'连接一个远端服务器'的信任边界扩大到'同一渲染文档内所有实例'
  （恶意远端实例前端可同源读取/操作其他实例），`--no-auth` 误用于不可信网络
  同理——产品形态决策，待中期缓解（per-ctx 会话令牌/实例隔离）。契约见
  `docs/design/17-server-side-gateway.md`。

## 设计未决（02 §5 / 04 §7）

- **起始端口偏移**：本地默认起始端口（17510）与控制面端口（17500）相邻；
  是否可配 / 每实例偏移未定——当前以"固定起始端口 + P+1 重试 + 记录仲裁"
  落地（02 §5.2）。
- **trusted-host 自定义 Host**：`--trusted-host 127.0.0.1:<port>` 对应反代
  转发 Host 头（保持实例自身 host:port，不改写）；若引入自定义 Host 场景需
  同步扩展 trusted-host 集（05 §7.5 固定形态）。
- **多控制面 `$DSH_HOME` 冲突**：宿主 `DSH_HOME` 固定 `<stateDir>/dsh-home`，
  多控制面共享 stateDir 才共享 home——会话 JSONL 追加式多写安全，settings
  last-writer-wins 由 dsh `settings-conflict` 仲裁；不同 stateDir 互不相干
  （02 §5.6）。
- **响应头白名单双处同步**：上游引入新必需响应头需同步 03 §3.4 与 04 §4.3
  （一处契约两处表述）——建议单源化（04 §7.1）。
- **`__DSH_BOOT__` 随 dsh 版本漂移**：manifest 形状随 dsh `parseBootManifest`
  契约（vendor 源码为准）维护；构建链变更见 05 §6（04 §7.2）。

## 范围决策与剩余偏差（不做 / 推迟 / 移出）

- **移出项**（P3 硬纪律，永不回流）：认证/审计（密码/Passkey/会话 cookie/
  client token/限流/审计 SQLite）——**永不回流限定为匿名控制面**（design 17
  有界例外：gateway 入口认证面 + 桌面 S22 safeStorage 凭据存储 / S24 轻量非
  秘密审计，见 17 §12/§13.4；凭据仅表单瞬时 write-only 输入，永不由主进程
  返回/回填或持久化到 renderer，也不进注册表/日志；审计不回流
  匿名控制面）；控制面薄壳聊天/会话列表/审批弹窗、控制面
  会话运行时/统一索引/交互管线、连接注入适配器/broker/绑定、walkthrough、
  通知中心、cron、文件夹/笔记、web 预览、MCP、目标/终端等宿主 UI 职责面
  （处置映射见 01 §4；git/GitHub 例外：插件化，见 01 §4 / 设计 08）。
- **不做（v1）**：跨来源移动会话、单 store 真融合（fork runtime）、会话
  实时推送同步、远程实例管理 UI 外壳。
- **P0 信任域残余（09 §4，v1 已缓解）**：远端 bundle 与 chamber 页面共享
  高权限 bridge 的上下文；v1 缓解已落地（主进程确认对话框 + 路径脱敏）；
  bridge 全局面与横向实例数据面隔离推迟到每实例独立 WebContents 架构版
  （本阶段明确不做）。
- **推迟**：flat 单列表模式（与「仅按来源分类」呈现原则张力）。
- **设置壳偏差（持续成立）**：未连接实例不装配子 ctx（配置在目标机器上，
  物理不可达）；stub remote 无 WS 失效流；设置壳不渲染官方 SettingsRoot；
  子 ctx 懒装配；服务器选择器使用 body portal + viewport 翻转/钳位（含窄
  视口缩放）+ 名称/实例 ID 搜索，超长 roster 内部纵向滚动；在线/离线状态
  同时使用文字与色点，搜索输入位于 listbox 外；离线远端仍可选并显示明确
  不可达占位与「前往连接管理」动作；chrome 跟随宿主 locale、子 ctx 跟随
  目标实例 locale。
- **默认排序 manual（06 §3.1）**：每来源会话排序默认 `manual`（保持 wire
  序），与官方默认 `updated` 不同——有意取舍；`orderBy[sourceId]` 持久化于
  `dsh-chamber.sidebar.v1`。
- **窗口标题冻结（桌面壳故意偏差）**：桌面壳冻结原生标题栏为 `dsh-chamber`
  （单 frame 品牌恒定），会话名仍在应用内呈现。
- **Electron 二进制惰性安装（2026-08 用户决策）**：根 postinstall
  `ensure-electron.mjs` 默认 SKIP，仅 `DSH_CHAMBER_ELECTRON=1`（或
  `electron-dev` 首启自动补装）时经 electron_mirror 下载；server 部署
  （gateway/control-plane/CLI）不携带桌面二进制；electron-builder 打包走
  自身缓存。
- **dev 实例隔离（dev 契约）**：`electron-dev.mjs` 以独立 `--user-data-dir`
  （`packages/desktop/.dev-user-data`）+ dev 控制面端口 17520
  （`DSH_CHAMBER_CP_PORT` 覆盖）启动，并清除继承的 `ELECTRON_RUN_AS_NODE`——
  dev 与运行中的打包版实例（同一应用名 → 同 userData/单实例锁、占 17500）
  可共存；打包版默认端口/数据路径不变。
