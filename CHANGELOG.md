# Changelog（变更日志）

本文件记录 dsh-chamber 的全部重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目遵循[语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

发布产物与各版本的发布说明同时发布在 GitHub Releases 页面
（`https://github.com/panzeyu2013/dsh-chamber/releases`）。

> English: [docs/CHANGELOG.en-US.md](docs/CHANGELOG.en-US.md)

## [Unreleased]

### 变更

- **Gateway 编排面整体剥离 + 桌面「网关编排」分区移除（2026-12 用户拍板）** ——
  审批/提问回归 dsh 原生（侧边栏既有事实通道按会话呈现，琥珀点 + 等待分类，
  与本地/ssh 实例同一通道）；跨会话调度移除（dsh 没有定时能力，gateway 不添加）；
  会话索引、服务器侧 Git worktree 记录、功能开关与 feature host 全部删除——
  `/chamber/approvals|notifications|schedule|sessions|git/worktrees|settings` 六个
  编排路由与 `features/` 五文件（git/notify/schedule/index 四模块 + remote-stream
  客户端）不复存在，仪表盘缩为 Credentials + dsh runtime
  两块，`store.ts` 只保留凭据与锁。桌面 settings-bridge 的「网关编排」分区随之
  移除（`GatewayOrchestrationView` 与 API 客户端删除）。
- **种子注册表与桌面同步（2026-12 Phase 3）** —— 两个 chamber 宿主包
  （`dsh-host-client-graph`、`dsh-host-git-worktree`）不再随 gateway
  发行物分发：连接的桌面经认证的 `PUT /chamber/plugins` 上传自己的副本，
  gateway 校验（包名白名单 + 大小上限 + manifest 名称/版本）后缓存到
  `<stateDir>/chamber-plugins/`，每次 spawn 经控制面种子注册表注入托管 profile——
  托管 dsh 的宿主包版本锁定连接的桌面，双发布线漂移从根上消除；激活探针形态化
  （缓存缺包时跳过 chamber 宿主域，`hostDomains`/`probeExpectedNames`）。
  `dsh-chamber-client-ui-mobile` 为唯一打包例外（移动访问绑定 gateway、链路无
  桌面），包未落地前为警告跳过的 stub 条目，接口已留好。
- **修订号显示移除** —— 编排面剥离后 settings 文档与修订号显示随之消失；
  计数器语义保留于 json-store 协议层（加载校验与 If-Match 原语不变）。
- **移动端 Web 访问面设计定稿（design 17 §18）** —— 将 §16.2 远期项「PWA 安装、
  离线缓存和 UA 移动轻面」转正为独立设计面（2026-09 提出；2026-12 随编排面剥离
  修订）：chamber 自研移动适配客户端插件（窄屏布局/触控/PWA，机制以社区调研为
  参照——挂载零成本、data-attribute 打标、抽屉 containing-block 陷阱、SW
  per-instance 化等），gateway 只承担 UA 路由开关（默认关闭，仅体验分流、非安全
  边界）与 PWA 资产挂载，保持流式透传无 HTML 改写；先行形态 = 内网/可信网络。
  契约：§3 装配矩阵 + §10 项 2 移动例外——`dsh-chamber-client-ui-mobile` 唯一
  随 gateway 发行物打包 seed（链路无桌面，不参与 `/chamber/plugins` 桌面同步）。
  分期与验收门禁见 §18.6/§18.7；已注册进 STATUS。
- **连接失败提示区分「SSH 传输错误」与「dsh 实例探测失败」** —— 状态投影新增
  `userActionKind`（`'auth' | 'endpoint' | null`）区分 `requiresUserAction`
  终态的类别：认证/主机密钥/spawn 失败是**传输层**问题（连接设置页保留「请检查
  主机密钥 / 设置 SSH 密码」提示）；而确定性身份探测失败（远端**应答了**探测但
  不是兼容的 dsh——版本过旧 / 破坏性变更 / 端口上是非 dsh 服务）是**实例层**
  问题——SSH 隧道本身正常，设置页不再展示「认证失败：请检查主机密钥…」的误导性
  提示，改为「SSH 隧道正常，但远端 dsh 实例未通过身份探测——请检查端口/版本，
  或升级远端 dsh」。终态/免重试语义不变（03 §2.2）。
- **dsh 基线升级 0.1.2-alpha.2 → 0.1.2-alpha.3** —— 构建期源码
  （`harness.commit` / submodule gitlink = `dd6322d6`）与捆绑运行时
  （`@deepseek-ai/dsh@0.1.2-alpha.3`）双线同步：in-repo fork 副本基线
  0.1.2-alpha.3——`dsh-client-connection` 重放上游 tolerate-stalled-hosts
  两 hunk（就绪握手超时只 warn 不再取消 generation，慢后端不再被误判为
  断网；chamber 的 loopEpoch/liveness 补丁不受影响），`dsh-client-web` 与
  `dsh-api-gateway` 为纯版本号同步（上游两包 a3 无源码变更）。上游 a3 移除
  SQLite 会话持久化后端（`dsh-session-persistence-sqlite`）与
  `dsh-agent-spine-demo`，锁文件孤儿 importer 记录已清理；新增 vendor 包
  `dsh-session-turn-outline` 自动纳入。上游 `dsh-client-ui-primitives`
  markdown 渲染重构（视口懒高亮、代码块 32 行分组、流式→settled DOM 保留）
  为行为性变化，chamber 无直接使用点。
- **客户端插件诊断降噪（连接设置页）** —— `instance-version-conflict`（实例间
  插件版本不同）从红色问题样式+完整长消息降为中性信息态短标记（卡片只显示状态，
  不再显示插件 id 与原因），完整详情（状态 + 插件 id + 原因）移到每实例的插件
  管理弹窗顶部；诊断纯函数（状态 → 文案/色调）抽出为可测模块并补齐单元测试。

## [0.2.0-beta.5] - 2026-09-01

> 聚合 0.2.0-beta.1 → beta.4 的全部迭代（桌面连接管理器 + 认证
> Gateway（design 17）+ dsh 运行时版本管理（design 18），完整演进记录见下方各
> beta 节）与以下收尾变更：

### 修复

- **Gateway state 根目录权限契约：fail-closed `require 0700` → 自动收紧 + 属主校验** ——
  `createGatewayStore` 对已存在的 state 根不再因非 0700 直接拒绝启动（旧安装以默认
  umask 建出的 0755 根目录会导致 systemd 无限重启崩溃循环），改为经 pinned
  no-follow 描述符自动收紧到 0700；同时新增属主 uid 校验（异主目录 fail-closed，
  杜绝 root 服务把凭据/运行时写进他人目录后被投毒安装输入），fchmod 后复核 mode
  以在静默忽略 chmod 的文件系统上保持 fail-closed（2026-09 用户决策）。
- **install-gateway.sh 私有布局收敛 0700** —— 脚本入口统一 `umask 077`，新增
  `ensure_private_layout()` 把 BASE_DIR/gateway/versions/dsh-anchor/bin/run 全部
  收敛 0700（覆盖 install/update/前台 restart 三流程），消除安装早期 BASE_DIR/
  GATEWAY_DIR 的 0755 窗口期。
- **systemd unit `EnvironmentFile=` 去引号** —— 该指令不支持引号，旧模板产出的
  带引号路径会按字面查找、环境文件静默不加载（服务以空环境/默认值启动）；现按
  字面路径写入。
- **control-plane 递归 mkdir 显式 0700** —— `ensurePrivateDirectoryNoFollow` 与
  `createJsonStore` 的祖先目录创建显式 `mode: 0o700`（防御性）。
- **install-gateway.sh 收紧自检与回归测试** —— BASE_DIR 专用目录校验（拒绝
  相对路径 / `% * ? [ ]` / 文件系统根 / HOME / 临时目录），环境文件值不再转义
  `$`（systemd ≤v246 兼容），unit 模板与 0700 布局的回归测试补齐。
- **Gateway `--service-user`** —— 以专用系统用户运行 gateway（unit `User=` +
  数据目录属主移交，root + systemd 形态）。

### 变更

- **scripts/ 目录重组** —— 开发者/维护者/测试脚本全部归入 `scripts/dev/`（含
  `update-vendor.mjs`，新路径 `node scripts/dev/update-vendor.mjs <tag>`）；
  `scripts/` 仅保留用户面脚本 `install-gateway.sh` 与目录约定 README。
- **install-gateway.sh 全面重构** —— 8 阶段交互向导（欢迎页 + 版本通道/访问方式/
  登录凭据/端口/服务方式/dsh 运行时/安装位置/预览确认；q 退出、ESC 或 back 返回，
  每步有白话说明与校验循环、非交互 `-y` 全默认）；默认 **local 安装**
  （gateway 自管 dsh 版本，运行期 `/chamber/runtime` 切换）；新增 `restart`
  子命令；凭据双重输入 + 字符计数 + 留空自动生成并在完成页一次性显示（仅 TTY，
  非 TTY 指引 0600 文件）；`--no-auth` 交互模式需 YES 二次确认；npm 镜像三选
  （国内镜像默认）；本机已有 dsh 的接管建议；完成后 PATH 幂等写入与脚本自复制；
  前置检查（node/curl）与 flag 值校验（端口/bind/origin/proxy/凭据长度/通道）。
- **部署文档迁移** —— `docs/deploy-gateway.md` 移入新目录 `docs/deploy/`；
  README「远程 dsh 实例（systemd）」长章节提取为 `docs/deploy/remote-dsh-instance.md`
  并在 README 保留简短说明与链接；全部引用路径同步。

### 修复

- **CI：host-graph typecheck 在全新安装下解析不到 `compression`/`negotiator`** ——
  pnpm 对符号链接型 vendor workspace 成员的注册表依赖按逻辑路径计算相对深度、
  却把 node_modules 实体建在 checkout 内（链接断），上游 `dsh-host-webserver`
  （0.1.2-alpha.2）新增的这两个导入在 fresh install 后无法解析；按
  `@standard-schema/spec` 先例在 host-graph tsconfig `paths` 中映射到 @types 包
  （类型专用，无运行面）。

## [0.2.0-beta.4] - 2026-08-30

### 新增

- **Gateway 运行时凭据管理（design 17 §7.4）** —— 凭据从部署配置升级为**服务器
  状态**：`<stateDir>/password-credential` 与 `tokens.json` 升级 v2 JSON 信封
  `{schemaVersion:2, source:'config'|'runtime', updatedAt, verifier|hash}`（0600
  原子写；legacy v1 裸 `scrypt$…` / `{"hash":…}` 读为 `source:'config'` 并在下次
  写入迁移）。**播种规则**（`seedCredentialsFromConfig`）：config 凭据只在无持久化
  或 `source='config'` 时断言（值变化先旋转 jwt-secret），`source='runtime'` 凭据
  权威、config 被忽略并响亮告警，config 未提供时按 source 删除或保留；动态 auth
  facade 每请求按持久化状态计算有效 kind（`--no-auth` 部署存在 runtime 凭据时
  按有效形态判定告警，不再误报匿名）。**运行时 API**（全部认证门后）：
  `POST /auth/change-password`（`{newPassword}` 12–1024 或 `{remove:true}`）、
  `POST /auth/change-token`（`{newToken}` 32–4096 visible ASCII、`{}` 服务端
  CSPRNG 生成或 `{remove:true}`，明文仅一次性返回）、`GET /auth/credentials`
  （非秘密投影 source/updatedAt，永不含值）；错误码→HTTP 映射
  `bad_request` 400 / `invalid_credentials` 401 / `ambient_principal_rejected` 403 /
  `last_credential` 409 / `rate_limited` 429 / `auth_busy` 503 / `body_too_large`
  413（先回 413 再销毁 socket）。**非环境性证明（S25）**：凭据变更要求 bearer-token
  principal 自证或 currentPassword 校验（共享登录限流器 + 有界 scrypt work gate），
  仅 cookie principal 拒绝 403。**rotate-first**：密码变更先旋转 jwt-secret 再
  持久化；删除最后一个凭据拒绝 409，除非 config 提供替代（revert 语义，
  `source:'config'`）。**stateDir 独占锁** `.gateway.lock`（O_EXCL + pid：活锁
  响亮拒绝 / 陈旧接管 / `close()` 幂等释放，进程 exit best-effort）。
  **CLI** `gateway auth status` / `reset-password --new PASSWORD` / `clear`
  （停机态；运行中响亮拒绝并提示 Web UI；reset 写 `source:'runtime'`；clear 后
  下次启动按部署配置重新播种）。**审计（S24）** `credential_changed` /
  `credential_change_rejected`（非秘密 detail，永不含值）。
  **`/chamber/` 编排页 Credentials 面板**（投影行、改密/删密码/轮换 token 一次性
  readonly 展示（60 秒自动清空）/删 token，403/409/429 等错误按 wire code 可读化；
  config 管理维度的删除如实提示「重启后重新播种」）。新增不变量
  **S25**（运行时凭据变更需非环境性证明；运行时拒绝删除最后一个凭据，none↔auth
  双向转换仍仅部署期）。**全量修复轮**：stateDir 锁重写（O_EXCL 优先 +
  rename 认领 + 移动内容校验接管陈旧锁（双进程场景证明地无双持；被移动的新鲜锁
  rename 还原 + **创建后所有权终验**，被位移者 fail-closed）、releaseLock 双重守卫
  （未持有不删 + on-disk pid 复验）、**exit 监听器仅获取成功后注册**（失败的
  `gateway auth` 不再删除运行中网关的锁）、`reacquire()` 供 start() 重试路径重取）；
  `{remove:true}` 与 `newPassword`/`newToken` 互斥（并存 400）；非字符串
  `currentPassword` → 400；v2 verifier 形状校验（垃圾 verifier 按 corrupt 处理，
  杜绝静默废认证）与 corrupt 告警去重（每进程一次）；`gateway auth status` 为无锁
  只读（文档同步）；serve boot 行打印播种后有效 auth kind；`/auth/*` 未认证
  HTML-accept 导航返回 401 JSON（不再跳登录页）；`GET /auth/credentials` 支持
  HEAD；审计探测失败记为 `probe-error:<code>`；S25 匿名禁种、播种规则 3、并发
  remove 串行化（永不双 null）等安全测试补齐。

### 修复

- **chamber shell 不再加载官方 dev-only `dsh-client-hmr` 条目** —— 该条目的
  client fiber 无条件打开 `new EventSource('/plugins/events')`（实例 origin 相对
  路径），在 chamber 页面（控制面 origin）会命中控制面 SPA fallback 返回的
  index.html（`text/html`），每次 boot 与每次 EventSource 重连都触发
  "MIME type is not text/event-stream" 中止报错刷屏；web profile 无可用 hmr
  client channel（设计 09），现将其加入 `CHAMBER_COVERED_IDS`（page-own，无
  factory）跳过加载。同类已知问题 `dsh-session-log-export`（chamber 视图
  导出会话日志不可用，实例官方 UI 正常）经决策记录缓办，见 `STATUS.md`。
- **宿主图 503 重试预算从 6 次扩到 10 次（2.5s → 4.5s 延迟和）** —— 实测
  本地实例 spawn→ready 约 2.8–3.0s（控制面 host 日志），原预算无法覆盖
  "shell 恰在 spawn 窗口内启动"的场景，耗尽后按既有契约静默降级（本次 boot
  无 extra 插件）；非 503 通道失败仍快速失败，预算只影响快速 503 路径。

- **控制面 reaper 防止误删被替换的 ledger** —— 回收器在发送信号或删除前复验
  记录文件的设备/inode 与内容；路径被替换、PID 重用或记录不再匹配时
  fail-closed，避免误杀进程或误删新记录。

- **CI 与发布构建确定性** —— Gateway 测试在洁净检出缺少被忽略的 dist 时按同一
  构建脚本生成两个 bundle；fake-registry 验收先创建安全的 user-data 根；第三方
  notices 按实际直接声明依赖生成，避免本地 hoisted 残留污染 CI。

### 变更

- **dsh 运行时「立即应用」（设计 18 增补）** —— pending 相位新增用户触发的
  「立即应用」动作：在当前会话内执行既有激活事务（停机 → 快照 → 切指针 → 探针
  门控 → 裁决/回退），不再等待下次启动；desktop 宿主原生二次确认，gateway 宿主
  新增 `POST /chamber/runtime/apply-now`（202 + status 轮询），gateway 单目标
  proxy 增加激活感知门（探针窗口内不把在线请求转发到未裁决候选）。零新终态、
  零新崩溃窗口。见 `docs/design/18-addendum-apply-now.md`。

- **Gateway 登录页与 dsh 设计语言全面对齐** —— `/auth/login` 预认证页从最小裸表单
  升级为自包含深色卡片页（`--dsw-alias-*` token 层取值与 `/chamber/` 管理页同源）：
  密码管理器输入卫生（`autocomplete="current-password"`、`required`、
  `maxlength=1024`）、en/zh 双语文案（`Accept-Language` 前缀匹配）、内联 SVG
  favicon（登录页 CSP 增补 `img-src data:`，`script-src` 继续缺席）。登录失败按内容
  协商为浏览器表单渲染同状态码 HTML 错误页（401 密码错误 / 429 限流附 `Retry-After`
  与等待秒数 / 503 繁忙），API 与桌面客户端 JSON 形状逐字节不变；http 明文连接如实
  显示警告横幅、HTTPS 显示加密徽标（与条件 `Secure` cookie 同源事实）；过期会话经
  `/auth/login?expired=1` 提示；token-only 部署浏览器获得 404 HTML 说明页。保持无
  脚本、密码永不回显（S5）、审计事件与失败状态码矩阵不变（design 17 §7.1/§7.3）。

## [0.2.0-beta.3] - 2026-08-29

### 新增

- **凭据存储 safeStorage v3（S22）** —— `<userData>/gateway-secrets.json` schema
  v3：tokens+passwords 双表、各维度 gateway-target binding + 文件级
  `storage:'safeStorage'|'plaintext'` 权威判别
  （密文不再按字符形状猜测），`SecretCryptoAdapter` 接线 Electron safeStorage
  （`isEncryptionAvailable()` 不可用时 0600 明文回退）；密码允许 12–1024 Unicode
  JavaScript 字符，token 保持 32–4096 visible ASCII；双表
  corrupt 检测（`.corrupt` 保留）；凭据仅作为表单瞬时 write-only 输入，永不由主进程
  返回/回填或持久化到 renderer，也不进注册表/日志。**token 与
  密码两个独立可空维度**（17 §2.3，清除互不影响），整实例双清走显式
  `setInstanceSecrets(id, null, null)`；**`instances_get` 投影合并
  `secretStorage`（`'safeStorage' | 'plaintext'`）**。plaintext 镜像在 keychain 后来
  可用时立即原子升级，只有落盘成功才声称 safeStorage；非空无 discriminator 的旧 v2
  fail closed。gateway/SSH 凭据载入都先拒绝 symlink/非普通文件、复验 inode，并以
  打开 fd 收紧 0600 后才读取秘密。当前配置路径内结构合法的 v1、带合法 storage 的
  非空 v2 与 SSH password v1 因缺少可信目标 binding 均 fail closed，唯一
  `.unbound-*` 保留并要求显式重录；旁路旧 `gateway-tokens.json` 非空 v1 保留原文件并
  禁用，不猜测绑定。
- **密码登录会话** —— gateway `/auth/login`（GET 最小登录页 / POST 校验密码 →
  `dsh_gateway_session` cookie → 302 `/`）；桌面 `gateway-session.ts` 管理器
  （12h `dsh_gateway_session` cookie，仅主进程内存，按网络 origin + `Host` authority +
  稳定 connection-id/target scope 键控；localPort 不参与 ownership）经
  `configureGatewaySessionProvider` 六个 all-or-none hooks 接线：verifyUp 独立维护密码
  会话、带 Cookie 探针（缓存会话快速路径，401 → invalidate + 有界重登）。scope
  invalidation 覆盖全部历史 origin 并提升 generation；登录、Cookie probe、Bearer
  fallback、401 relogin 每次 await 后都拦截迟到结果，不能继续联网或改 cache/backoff/
  auth proof。当前 generation 的 `cookie|bearer` proof 为 ready 注册门：密码型目标缺
  Cookie/proof 时 fail closed，只有已验证的 Bearer fallback 可有意 Bearer-only；token
  与密码同时存在时探针、
  ready 与 refresh 重注册同时携带 Bearer+Cookie，gateway 接受任一合法 principal，
  不再由 token 遮蔽密码；都空→0 头（0..2 白名单由 instance-proxy 复验）；凭据
  IPC（write-only，变更撤销缓存会话）。**预过期会话刷新
  （`gateway-session-refresh.ts`，TTL−60s 定时重登+重注册）**——每个已注册
  密码型目标在缓存会话过期前 ~60s 定时重登并以新 cookie 重注册 transport、
  重 arm（armed on ready / disarmed on 离开 ready/移除/退出，每个动作提升按 id epoch；
  await 后复验 password/token/URL/pin/authority/scope；隧道重连换端点 → 新 origin
  重新登录）；刷新失败保持旧注册并在过期时刻重试，已过期仍失败如实
  告警、残余窗口走有界重连（verifyUp 用存储密码重登），绝不静默。
- **SPKI 证书固定（S23）** —— 可选 `spkiPin`（hex sha256 of SPKI DER）作为
  https 直连信任锚：verifyGatewayEndpoint socket 层 'secureConnect' 校验，不匹配
  terminal「证书固定不匹配（SPKI）——gateway 证书已更换或 pin 错误」；
  instance-proxy registerTransport / forwardHttp / forwardUpgrade 带 pin 转发
  （不匹配 → 显式 502 upstream_failed）。desktop 登录/探针与 control-plane HTTP/WS
  反代都在 peer 匹配后才 `write/end`/发送 upgrade；匹配前不发送 header、凭据、密码
  body 或任何应用层字节，mismatch 的上游 handler/upgrade 为零；http 模式拒绝 pin；真实 node:https
  自签证书 fixture 测试（pin 匹配探针成功 / 不匹配 terminal / 无 pin 正常）。
- **轻量非秘密审计（S24）** —— 桌面 `packages/desktop/audit-log.ts`（JSONL 追加
  + fsync、0600（遗留松权限回紧）、5 MiB 轮转到 `<file>.1`、白名单序列化——
  凭据字段即使误传也绝不落盘）记 phase 迁移（connecting/ready/error 含
  requiresUserAction terminal）/ transport 注册注销（认证存在性 token+password|
  token|password|none + insecureHttp，不记值）/ 凭据 set-clear（不记值）；gateway
  `packages/gateway/src/audit.ts`（`<stateDir>/audit.log`，0700 stateDir 内）+
  dispatch.ts login 事件分类（成功/invalid_credentials/rate_limited/busy，含
  客户端来源，绝不含密码与 cookie）；双端单元测试。

### 修复

- **连接保存的主进程 crash-safe 事务** —— renderer 不再串联多个 write-only setter；
  `desktop_ssh_save_connection` 在主进程快照 registry 与 SSH password/gateway token/
  gateway password，任一步失败即补偿全部旧值，补偿失败则安全 scrub 并响亮返回。
  gateway 凭据只绑定 kind+host+remotePort，SSH 密码单独绑定 host+user+sshPort，
  binding 与 secret 同次落盘且每次注入复验 registry，因而 secret→registry 两次 fsync
  间硬崩溃也不会把新值发给旧目标；新增/进入/离开/retarget 留空会清隐藏半事务值。
  删除只走精确 `desktop_ssh_delete_connection(id)`：先断开/撤销 exact scope session/
  清 secret 再删 metadata，不存在 id 为幂等 no-op；legacy `instances_set` 收窄为仅接受
  当前规范化 roster 的 exact unchanged no-op，三个单项 setter 收窄为 clear-only。真实 gateway ssh↔http 切换不会被
  SSH-only 字段误判为认证 retarget。
- **连接重配置代际隔离与 systemd 参数边界** —— `serviceName`、`remoteDshHome` 编辑
  同时提升 transport generation 与 `execEpoch`，撤销旧 live/retry/probe 和 exec child；
  多步 exec 下一次 spawn 与迟到日志/投影/结果都复验 generation，旧连接非 idle 才按
  新参数重启。systemd 固定使用 `systemctl <action> -- <serviceName>` 参数数组，服务名
  采用 `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`，首字符必须为字母或数字。
- **Gateway 恢复面与认证正交性** —— gateway transport 以认证后
  `/chamber/runtime/status` 固定 identity 判定服务边界，不再被 managed dsh
  `host.describe` 的 blocked/down 反向闸死；SSH tunnel 的 Host/session authority
  固定远端 `127.0.0.1:<remotePort>`，SSH alias/DNS 不再触发 421 或缓存 key 漂移。
  token+password 联合注入和 OR-principal 回退均有 direct/SSH/refresh 回归。
- **SSH askpass 跨用户目录抢占** —— 移除可由其他 OS 用户预建的共享
  `<tmp>/dsh-chamber-ssh` 写入路径；helper 改入 `mkdtemp` 每进程不可猜 0700 私有目录，
  复验 uid/type/inode/mode，EPERM 或属主异常 fail closed；helper 以 O_EXCL 创建，完整
  fsync 后才设为 0700 可执行。每个 tunnel/systemd/run child 独占 lease，真实
  exit/error/spawn-fail 才删对应 helper；移除/clear 延迟清理仍在途 lease，不再用固定
  代际上限提前删除并发子进程仍引用的路径。启动清理只处理本用户可信目录。
- **实例反代能力边界** —— local/dsh/legacy 来源对规范化后的 `/chamber/*`（含编码、
  点段、反斜杠变体）统一拒绝，仅 gateway 来源可访问；与 dsh HTTP 直连的无认证边界
  一起防止目标 kind/transport 混淆扩大能力。
- **Gateway 认证协议硬化** —— HTTP/WS 共用 request policy 基于 `rawHeaders` 在认证前
  拒绝重复 Authorization；Bearer 在 hash/scrypt 前严格限制单值、32–4096 visible
  ASCII。JWT `exp` 必须是未过期且不超过当前+12h 的 safe integer，缺失/非数字/
  Infinity/小数/unsafe/越界全部拒绝。桌面 instance-proxy 同步复验 Bearer 下限，且
  gateway+ssh 只接受必填远端 `127.0.0.1:<port>` authority（含端口范围门）。token
  scrypt work gate 饱和产生 `auth_busy` 时仍验证独立 Cookie：有效密码会话继续成功，
  Cookie 无效才保留 503，落实任一 principal 有效即成功。

- **dsh HTTP 直连注册边界** —— canonical
  `{kind:'dsh', transport:'http'}` 将显式 transport 维度贯穿到 instance-proxy
  注册，允许用户配置的公网 `http(s)` origin；目标仍严格禁止鉴权头与
  `/chamber/*` 能力。`{kind:'dsh', transport:'ssh'}` 与未提供 transport 的 legacy
  注册继续强制 loopback，绝不把原 SSH/本地信任边界静默放宽。
- **Gateway runtime JSON 请求体有界读取** —— `/chamber/runtime` 的 64 KiB
  JSON reader 改为累计字节计数；一旦超限立即释放已保留 chunks，后续 `data`
  事件 no-op，并保持先返回 413 再销毁请求。消除逐块 `reduce` 带来的 O(n²)
  扫描及 poison chunk 后继续占用 CPU/内存的风险，补充恶意后续 chunk 回归。
- **Gateway runtime 恢复与状态完整性** —— `restore-builtin` 不再直接删除选择元数据，
  而是复用停机、快照、原子指针切换、全量探针及失败回滚/数据恢复事务，仅成功后清理
  override/journal。registry 配置只有真实缺失时才回默认源，损坏/符号链接/硬链接会
  隔离保留并响亮失败，写入原子化且安装期间禁止换源；离线版本列表保留全部有效缓存。
  `/chamber/runtime/status` 以固定 identity 投影实际 env/override/current/builtin 来源、
  failure/restore/pre-rollback、快照、进度与全分类磁盘统计；Desktop settings 与独立
  `/chamber/` 管理页均提供完整动作和状态，managed dsh blocked/down 时恢复面仍可达。
  builtin 上 staged selection 以持久 `selectedOnly` 区分合法空 pointer，活跃用户树丢
  pointer 仍 fail closed；install writer single-flight 与 activation quarantine 分离，
  下载期间现有 proxy/features 不下线，候选 ready 在探针裁决前不 attach；健康 env
  override 不再误报 blocked。普通 pending 在 core/route/两套 UI 仅允许 restore-builtin。

### 变更

- **构建期 vendor 源 submodule 化** —— `vendor/harness-checkout` 从多源回退
  （env 覆盖 / 兄弟检出 / codeload 下载）迁移为固定 commit 的 git submodule：
  gitlink 即 pin（单一事实来源），`ensure-harness-vendor` 硬校验 submodule
  HEAD == `harness.commit`、幂等差量建链（集合未变零操作）、断言链接集合与
  锁文件 vendor importer 集合一致（`--check`）；`verifyDepsBeforeRun: false`
  掐断 pnpm 隐式非 frozen install；CI 各构建腿 checkout 改为 submodules 物化
  并在 frozen install 后断言锁文件零漂移；新增 `scripts/update-vendor.mjs
  <tag>` 作为上游 pin 唯一升级入口。
- **设计 17 重写（2026-09，连接模型 v2）** —— `docs/design/17-server-side-gateway.md`
  全面重写：远程连接提升为一等设计面，四维正交模型（目标类型 dsh/gateway × 传输
  ssh/http × 认证可空 token/密码 × 通道服务器侧槽位）；http 明文/无认证登记为用户
  决策有界偏差（S21，客户端不前置校验，服务器为认证权威）；安全增强逐项评估决策
  （S22 safeStorage 集成 / S23 SPKI 证书固定集成 / S24 轻量非秘密审计集成，mTLS
  与每连接网段策略预留槽位）；原 design 01 编排规则不再作为本设计依据，本设计
  自包含（17 §1）。
- **连接模型 v2 迁移决策（17 §2.2/§9.1）** —— 来源 id 由 `ssh-<id>` 迁移为
  `dsh-<id>` / `gateway-<id>`（`ssh-` 前缀保留 legacy 兼容映射，deep link 可用）；
  旧 `kind:'ssh'` → `{kind:'dsh', transport:'ssh'}`、旧 `kind:'gateway'` →
  `{transport:'http'}`；kind 决定目标语义（dsh 目标永不注入认证头/挂载
  `/chamber/*`；gateway 目标可注入可空 token/密码）。外围文档同步：01 文档地图/
  引用与移出项 S22/S24 有界例外注记、08/19 来源 id 枚举、11 版本包计数与 userData
  保留清单、14 托盘「连接 N」口径与退出确认矛盾修复、16/20 legacy 标注。
  **S22/S23/S24 与密码登录会话已在本版本落地**（见上方「新增」条目）；
  剩余发布前实机门禁如实登记于 `docs/progress/STATUS.md` 设计 17 条目。
- **发布通道与 Gateway 分发收口** —— stable 桌面构建使用 package 配置且只生成
  `latest.yml` / `latest-mac.yml`；beta 使用独立
  `packages/desktop/electron-builder.beta.yml` 且只生成 `beta.yml` /
  `beta-mac.yml`，两条 feed 互不覆盖并有反向缺失断言。发布门仅接受 canonical
  stable `X.Y.Z` 或 beta `X.Y.Z-beta.N`，`alpha`/`rc`/其他 prerelease fail closed；
  只有精确 `-beta.N` 应用按自身版本自动进入 beta。每次检查从有界 Releases API 仅选最高的规范 published
  `vX.Y.Z-beta.N`，再切精确 tag Generic feed，发现失败即停止而不触发 stable
  `latest*` fallback。正式 macOS 发布在任何
  Release mutation 前检查五项签名/公证凭据，并在公开 finalize 前强制通过
  Developer ID、stapler 与 Gatekeeper；只有 `dry_run` 允许 ad-hoc mac 构建。它即使
  面对已配置的正式 secrets 也无条件清空签名/公证环境与 `GH_TOKEN`，不创建/修改
  Release、不上传产物。Gateway 仅在 GitHub Release 发布经
  clean-prefix 安装冒烟的 `.tgz` 与同名 `.tgz.sha256`；npm publish/dist-tag 延后。

## [0.2.0-beta.2] - 2026-08-27

### 新增

- **Gateway 运行时版本管理服务化（设计 18 M5–M7）** —— `/chamber/runtime` 认证管理表面
  （status / versions / select / apply / rollback / restore-builtin / retry-apply /
  retry-restore / restart / registry，not-ready 门禁豁免）：启动事务（清理 → 快照 →
  原子指针切换 → spawn 候选 → 全量激活探针）与两阶段回滚/恢复闭环；runtime-manager
  （env → override → 内建锚解析链、intent journal、owner 抢占 fail-loud、并发互斥 409、
  阻止但存活 / FATAL 状态投影）；restart 端点白名单（ready / degraded）+ 失败诚实
  （resolve ≠ 成功：stopped / restart-exhausted 永不报 ok）。
- **dsh 运行时核心抽取为共享纯 Node 包 `packages/dsh-runtime`** —— desktop 主进程与
  gateway 服务器两个 owner 经真实 DI 接缝（StartupDeps / ApplyDeps / InstallerDeps /
  ControllerDeps；`RuntimeHostAdapter` 仅为文档草图）适配；运行时状态与版本树
  互不共享。
- **settings 的 `dsh-runtime` 分节（design 18 §3.6）** —— local = 完整运行时管理、
  gateway = 代理 `/chamber/runtime`、ssh = 版本只读；每个来源都有「重启 dsh」动作
  （control-plane `restartLocal()` / `/chamber/runtime/restart` / `restart_service`
  systemd IPC），无需重启 Electron 壳即刷新插件挂载。
- **安装脚本受控锚** —— install-gateway.sh 将 dsh 内建锚安装到 gateway 受控目录
  （`${BASE_DIR}/gateway/dsh-anchor`，`npm install --prefix` workspace 形态），不再
  使用 npm 全局安装；运行期版本仍由 gateway 嵌入式 pnpm 经 `/chamber/runtime/select`
  安装到 `<stateDir>/dsh-runtime/`。
- **Gateway 打包随附 chamber host 包** —— 构建将 `dsh-host-client-graph` /
  `dsh-chamber-host-git-worktree`（package.json + committed dist）复制进 gateway 包并
  经 `hostGraphPackageSourceDir` / `hostGitWorktreePackageSourceDir` 注入控制面 seed；
  托管 dsh 具备 chamber RPC，全量激活探针集可在服务器端通过（实机切换验证）。

### 修复

- **install-gateway.sh npm 全局锚路径语义** —— `verify_dsh` 期望 workspace 形态
  （`<ws>/node_modules/@deepseek-ai/dsh`），全局分支与安装后传入的是 `npm root -g`
  （本身即 node_modules 目录）导致安装后验证必失败、且锚位置错误；统一转换
  `dirname(npmRoot)`（实机测试发现）。
- **响应腿断连检测（main 6791f84 并入）** —— 请求体消费后 `IncomingMessage 'close'`
  立即触发（无体 GET 更甚），按请求腿检测会误杀所有 GET/WS 转发与 SSE；改在响应腿
  （`res 'close'` + `writableEnded` 守卫、WS 原始 socket、SSE 同理）。
- **M3b 压缩头** —— 上游请求剥离 `accept-encoding`（代理永不协商压缩）；响应
  `content-encoding` 白名单放行，浏览器正确解码。
- **插件操作主进程确认（design 09 §4）** —— 本地/远端插件安装与移除、materialize
  传输需主进程确认对话框；取消永不报告成功（`{ok:true, cancelled:true}`）。
- **H2 生成中止健康探针 / killFailedSpawn 主机日志写入 / reaper 命令身份 /
  fsync 原子写**（审计轮并入）。
- **spawn pid 记录失败 fail-closed** —— 发布失败即回收子进程并抛
  `dsh_spawn_non_retryable`（绝不换端口重试；与 main 侧可重试语义合并时定夺保留）。
- **侧边栏 create/fork 收敛（无未分组闪现）**、**open-in 下拉图标 + 短应用名**。
- **发布门禁修复（2026-09 beta.2 事故）** —— preload.cts 恢复
  `ChamberInjectionState` 本地声明（L3 lockstep 守卫回归）；workflow action SHA
  校验门禁（`release-preflight --actions-only`）+ 脚本路径修正；**共享核心 F4
  修复**：`writeActivationIntent`/journal 回读接受 `builtin-anchor` 哨兵（否则带
  override 的机器升级 shell 启动即崩溃）；测试硬编码版本号解耦。


## [0.2.0-beta.1] - 2026-08-25

### 新增

- **认证服务端 Gateway（设计 17）** —— 新增可独立发布的
  `@dsh-chamber/gateway`：托管 loopback dsh，经统一 HTTP/WS Host/Origin、强认证与
  有界反代暴露官方前端/API；Desktop 新增 `gateway` transport、write-only token 和按
  server 编排设置；Gateway 自带浏览器编排页、派生会话索引、审批/提问、schedule 与
  受 workspace 权威约束的 Git worktree saga。CI/release 已覆盖 build、typecheck、测试
  与 tgz 打包安装冒烟（npm 发布暂缓，2026-08）。
- **dsh 运行时版本管理（设计 18）** —— 运行期安装/切换 dsh 运行时：registry origin
  绑定 + SRI 校验 + 内嵌 pnpm `file:` 安装，探针门控切换与两阶段回滚/恢复闭环
  （M0/M2/M4 done，M1/M3 partial：打包态实机验收待真实 `.app`）；数据安全缺口修复
  ——journal-mismatch 归入 `selection-corrupt`、pre-rollback stash 恢复、
  `incomplete` 恢复放行 `recover-metadata`。
- **open-in 打开注册表（设计 20）** —— 原 VS Code 深链（设计 16）演进为统一打开面：
  Finder/本地/远程 VS Code 经主进程 OpenInApp provider 注册表 + 六步 loud 执行管线打开；
  插件包重命名为 `dsh-chamber-client-ui-open-in`，旧 vscode IPC 收敛删除。
- **桌面通知（设计 19）** —— 会话完成/代理提问/审批请求推送原生通知（设置可选项）；
  检测 = renderer 复用运行时事实通道边沿检测，呈现 = 主进程 Electron Notification +
  点击打开会话；设置并入通用页「通知」控制组。
- **侧边栏增强（design 06 §2.4/§3.1）** —— 来源级收拢（来源头折叠开关，收拢整来源
  workspace 列表）+ server 拖拽排序（显示偏好，持久化于 `dsh-chamber.sidebar.v1`，
  跨 ctx 实时联动）+ workspace 图标按身份着色（色相按 `(serverId, 家族种子)` 哈希派生
  稳定 accent，worktree 与主检出共享家族色）。
- **Electron 二进制惰性安装** —— 根 postinstall 默认不再下载 Electron 二进制（约 100MB）；
  仅 `DSH_CHAMBER_ELECTRON=1`（或 `electron-dev` 首启自动补装）时下载；server 部署
  （gateway/control-plane/CLI）安装不再携带桌面依赖。

### 修复

- **反代误杀全部无 body 请求与 WS 握手（03 §3.3 断连检测）** —— 控制面
  `instance-proxy` 的 HTTP 转发与 WS upgrade 路径把 `req.on('close')` 当作
  客户端断连信号，但 Node 16+ 的 `IncomingMessage 'close'` 在请求体消费完
  时即触发（无 body GET/HEAD 立即触发），导致每个经反代的 GET/HEAD 请求与
  WS 握手都在发出后被误 abort：bundle 加载 30s 超时（「实例启动失败」）、
  web-runtime 无限 `connection lost, retry #N`、实例 boot 全部超时——local
  与远程无差别受害。POST 因 `'close'` 在 `readBody` await 期间触发（监听器
  尚未注册）而侥幸正常，使问题长期掩盖在「POST 探测一切正常」之下。修复：
  断连检测改挂响应腿（`res 'close'` + `writableEnded` 守卫，与 api.ts SSE
  同纪律）、WS upgrade 改挂浏览器 socket `'close'`（101 前仅真实断开触发，
  101 后由 splice tearDown 接管）；api.ts health-events SSE 同款修复。
  新增 4 个真实 Node 流集成回归测试（fake 请求不模拟真实 `'close'` 语义，
  红-绿验证过：还原 bug 即挂起超时）。
- **插件动作主进程确认（09 §4 v1 安全缓解）** —— `desktop_ssh_plugin_materialize_add` /
  `desktop_local_plugin_add` / `desktop_local_plugin_remove` 增加主进程确认
  对话框：远端 bundle 与 chamber 页面同上下文，脚本不能静默驱动本地源码外传、
  任意 registry 包安装（持久执行面）或破坏性卸载。取消返回 `{ok:true,
  cancelled:true}`；无窗口 fail-closed；单飞防堆叠；UI 侧三个消费点补齐
  `cancelled` 分支（不再把取消误报为成功）。
- **本地插件清单路径脱敏（09 §4 v1 安全缓解）** —— `desktop_local_plugin_list`
  的依赖值投影不再回显本地绝对路径：file:/link:/相对/绝对/`~/` 值掩码为
  `file:<hidden>`（保持 materialize 分类与名称匹配语义，客户端 diff 不变）。
- **控制面生命周期竞态守卫（2026 audit H2）** —— 健康探针携带代次
  AbortSignal：stop()/start() abort 在途探针并等待其落定；`stopped`/`error`
  态或 start 在途时到达的失败判定一律惰性（不复活连接、不双 spawn）；spawn
  失败落在 stop() 之后（epoch 已变）不再把 `stopped` 改回 `error`。
- **spawn 失败统一清理（2026 audit H3）** —— spawnAttempt 全部失败路径（含
  PID 记录写入失败）统一收敛到 `killFailedSpawn`：进程组 SIGKILL → 确认退出
  → 删除记录（对齐设计 02 §3.3），不再遗留无记录可追踪的 detached 进程。
- **catalog 持久化不再阻断状态机（2026 audit M13）** —— status/dshPort/error
  运行时投影写盘改为 best-effort：磁盘失败 loud log、状态照常迁移、下次迁移
  自愈；用户可编辑字段（label/accentColor）保持严格写穿。
- **反代压缩一致性（2026 audit M3b）** —— 请求侧剥离 `accept-encoding`（上游
  恒 identity），响应头白名单放行 `content-encoding`（压缩标签随行，浏览器
  正确解码）。
- **boot 预算取消 + 串行链（2026 audit H1）** —— 整个 boot 任务（含宿主图
  通道与 `AppWebEntry.run()` 各阶段）受超时预算约束：超时即取消（dispose
  已构造 entry、拒绝排队 opens），调用方与 admission 链都在预算内 settle；
  超时 entry 的底层异步工作可能迟到恢复，因此路由事实固化在每个 entry 自己
  的 Cordis root context，connection 收到显式 basePath，绝不共享页面级可变
  旋钮；dispose 作为取消信号阻止迟到 mount，并重复 root sweep。任务先
  settle 时清除计时器，成功 boot 不会被过期计时器误取消。
- **dispose 串行化（2026 audit M1）** —— `AppWebEntry.dispose()` 是异步
  teardown：同 ID 重 boot 必须先 await 旧 teardown 完成（pendingDisposes），
  同 entry 重复 dispose 共享同一 Promise、不会用已完成 Promise 覆盖真实
  teardown；shell 在异步 boot 开始/取消时预留 producer generation floor，
  runtime 与 snapshot producer 均携带显式 boot generation，旧 ctx 的迟到
  注册/report/clear 均不能抢占或清掉新 shell 的共享状态。
- **exec 子进程退出等待（2026 audit M2）** —— 退出时 exec 子进程（systemd/
  远端命令 ssh）与隧道子进程同款 SIGTERM→SIGKILL 升级，`disposeAsync` 等待
  全部退出，SIGTERM 忽略型 ssh 不再残留孤儿进程。
- **预热队列解卡（2026 audit M8）** —— 删除正在预热的实例时同步清除
  inflight 标记并立即推进队列（此前卸载后 settle 被丢弃、标记永久残留，
  预热队列整体卡死）。
- **端口分配失败自动恢复（2026 audit M10）** —— 隧道本地端口瞬时分配失败
  进入慢速周期重探（与 max-retry 同款），不再永久停在 error 等待人工。
- **插件缺失可见化（2026 audit M6）** —— 宿主启动图通道失败（graph-unreachable/
  not-injected）时 boot 仍成功但 settle 状态携带 `pluginDegraded`，实例视图
  显示警告条（"部分插件未能加载"），不再与完全成功同态。
- **搜索可见集语义修正（2026 audit M7）** —— `mergeSearchResults` 增加
  `projectionReady`（`aggregateReady`）：投影就绪后可见集是权威，空集过滤
  全部远程命中（archived/subagent/blank 不再回流可点击结果）；仅未就绪时
  保留不过滤降级。
- **主机保存补偿式原子性（2026 audit M9，2026 merge review 修正）** —— 新增
  与编辑统一先提交并核验权威注册表，只有元数据确实落地才写密码；注册表
  拒绝/抛错时密码保持不变，密码失败则回滚提交前完整注册表快照；回滚返回值
  同样核验，静默拒绝或抛错时按权威注册表保留编辑态（不再被 duplicate 校验
  拒绝）。主进程注册表保存也
  改为 whole-set 校验：任一非法/kind 不匹配/重复 id 即整体拒绝，避免非法编辑
  静默删除既有主机；加载旧文件仍容错丢弃并告警。
- **architecture 合并安全审查修复（2026-08-28）** —— reaper 仅凭 pid 记录中
  受管 CLI 的完整绝对路径、精确 `--profile web`/`--port` token、端口归属和
  owner 死亡四重证据回收（basename/任意 `bin.ts` 均 fail-closed，身份不匹配
  日志不回显无关进程 argv）；本地
  start→stop→start 释放旧 single-flight 代次且迟到失败不能清新代；host-logs
  写/压缩失败切新代，不再复活已删除 backing file；`stopped` 生命周期行只写
  一次；fork parent-accounted 隐藏改为 3s first-observation 有界宽限，attach
  部分成功最终显式落未分组；连接表单路径/长度门禁与 desktop 权威对齐；
  CI/release action pin 增加离线一致性检查并修复无效 setup-node SHA。后续彻底
  复审进一步收紧：本地 spawn 端口预检/TCP 就绪与 unary body 读取全链可取消；
  transport 只注册 loopback HTTP；SSH 未终止行、捕获 stdout 与 stderr detail
  均有增量内存上界；本地插件 pack 禁生命周期脚本且 pack/install 子进程纳入
  will-quit 进程组/树回收；renderer 会话打开、聚合重试/来源删除及删除→同 ID
  重建的 source-generation ABA、恢复 timer 与 quit 代次隔离；深链队列/协议注册、
  Windows 本地路径、外部打开错误与设置副作用回滚均 fail-loud 且不向 renderer
  泄露宿主路径；release concurrency 将 tag `vX` 与手动 version `X` 归到同一
  写入组（不同版本仍可并行）。
- **来源域键（2026 audit L2）** —— 双击 pending 与 blank-ghost 宽限按
  `(serverId, sessionId)` 建键：克隆实例相同 UUID 跨来源点击/幽灵槽不再串
  状态（跨来源双击改名仍工作——两次点击键到行所属来源）。
- **IPC 镜像防漂移（2026 audit L3，最终审查强化）** ——
  `ipc-surface-mirror.test.ts` 在方法集比对之外增加**字段集比对**（覆盖
  manifest/chamber/gitWorktree/notifications 等辅助类型），并修复了三处
  真实漂移（preload 两个 manifest 缺 `chamber`、renderer
  `ChamberInjectionState` 缺 `gitWorktree`、settings `ChamberSettings` 缺
  `notifications`）。
- **远端插件 apply 主进程确认（2026 final review）** ——
  `desktop_ssh_plugin_apply` 的 registry add/remove 增加主进程确认对话框
  （远端持久执行面，与本地安装同门控）；`SshPluginApplyIpcResult` 增补
  `{ok:true,cancelled:true}`（三处镜像同步），同步/添加视图两处消费方处理
  取消为跳过而非误报。
- **退出守卫（2026 final review）** —— `trustedIpc` 在 quit 在途时拒绝全部
  IPC（`app_quitting`）；transport-manager `dispose()` 置内部门，`exec()`/
  `connect()` 退出后拒绝新工作（不再有 quit 在途理论孤儿 spawn 窗口）。
- **双端 materialize 分类一致性（2026 final review）** —— 客户端 `isPathSpec`
  的 file:/link: 前缀改为大小写不敏感，与主进程 `isMaterializeSpec` 对齐
  （远端 manifest 大写 `FILE:`/`LINK:` 不再双端分类偏差）。
- **遗留问题修复轮（2026 cleanup-review）** —— `settings-set` 校验失败
  形状统一为 `{ok:false,error}`；隧道 stdout 入环形日志前同样过提供者脱敏；
  `writeSettingsFile` 补 fsync+显式 0600（原子写纪律对齐）；`bundle-dsh` 的
  默认 dsh 版本改为**从已提交 runtime lockfile 派生**（与 release.yml 的
  硬编码不再可能漂移）；管理面 body 补 10s 逐块 idle 超时（不再占连接槽到
  35s 总限）；pid 记录与 seed overlay 原子写补 fsync；shell.ts 的
  `pluginDegraded` 声明移到闭包之前（消除 TDZ 脆弱点）；sidebar 拖拽提交
  改用活 store/活 roster（两处排序模式 + server 拖拽）；connections 保存/
  删除改为**对权威注册表读-改-写**（消除渲染闭包快照竞态）；git 未注册工作树
  删除前刷新失败显式上浮（不再吞错）；镜像测试 `stripComments` 行首锚定
  （字符串字面量内 `//` 不再误删）。实机冒烟仍待真实环境。
- **独立检查轮修复（2026 independent-review）** —— 桌面：askpass 助手改为
  密码不变即复用（不再每次删除重建——并发隧道+exec 互删对方在用助手的虚假
  认证失败竞态消除），清密码/删实例即清除已落盘助手；`desktop_ssh_seed_
  host_graph` 手动路径补主进程确认（自动路径不受影响），结果类型增补
  `{ok,cancelled}`（三处镜像同步 + UI 静默处理）；`connect`/`instances_set`
  对未知/非法输入收敛为 null/现状形状（不再 throw→rejection）；`TransportRun
  Command` 收窄为实际可分发集。验证体系：release.yml 新增 `validation` job
  并接入两个打包 job 的 needs（tag 发布无法再绕过验证门禁）；ci.yml 补桌面
  构建子步骤（control-plane/preload/host-graph-package）与第三方声明一致性
  校验；shell 串行化测试消除假阴性（B 清零旋钮 + 宏任务让出）；spawn 清理
  测试补进程表级断言（pid 日志方案与 SIGKILL 竞态，改用 ps）；镜像测试补
  Update/SettingsSurface 金基线；host 包构建校验产物存在；boot-rows 补
  extras 去重边界测试；`instance-mutation-values` 登记归位 test:sidebar。
  文档：05 §7.6 白名单与 13 §7.2 对齐、02 §3.4 补 dev 路径身份、09 §4 基线
  标注历史、desktop README 退出语义/字段清单、spawn-dsh 注释修正。
- **全新审查轮修复（2026 fresh-review）** —— 控制面：spawn 补 `error` 监听
  （ENOENT/Electron fuse 等异步 spawn 失败不再以未捕获异常崩溃整个进程）；
  反代 body 内存预算持有到上游请求完成（原先 readBody 后即释放，64×300MiB
  并发可耗尽进程内存）；进入 starting 前清 `dshPort`（投影不再短暂携带死
  端口）；`noteHealthFailure` 补 `signalCode` 死亡判定。类型面：settings-
  connections 的整套 IPC 声明改为从 renderer `global.d.ts` **re-export**（消除
  三处手工镜像漂移源）；settings-bridge 的 `chamber-bridge` 镜像对齐真实
  `ChamberServerAggregate`（删幻影 `hint`、补 workspaces/aggregate*/runtime）；
  `connections-section` 镜像补真实消费的 `pluginDiagnostics`；layout
  view-prefs 镜像补 4 个缺失可选字段；preload 暴露值归一化为 `null`；
  enter-row 采纳校验 wire 值（越界回退默认行为）；`composeBootRows` 对
  extraIds 去重；镜像测试适配 re-export 模型（9/9）。
- **第三轮审查修复（2026 round-3 review）** —— 控制面：存活判定补
  `signalCode`（信号杀死的子进程不再误报存活）；restart-exhausted 落地前
  终止残留子进程并清 `child/dshPort`（与「stops automatically」契约对齐）；
  `setState` 的 `error` 显式删除（内存/磁盘投影一致）；`→ stopped` 终态行
  经 `setState` 单一路径落滚动日志；reaper 身份匹配兼容源码 tsx 启动路径；host-logs 改同步追加写
  + 内存环带压缩（消除异步流缓冲/异步打开与压缩 rename 的竞态——原先会重复并
  交错内容）并修空行分隔；offset 越界返回空；
  proxy 对带 body 的 GET/HEAD 排空（keep-alive 复用不串帧）。桌面/客户端：
  save-host 密码失败后的回滚抛错不再串扰报错文案（保留密码错误）；连接客户端
  `stop()` 现在中止在途退避睡眠；App 回收 effect 同步裁剪其余 per-instance
  refs。验证体系：CI tag 推送（v*）触发全量验证链 + host 包 esbuild 构建进
  入 push 路径；shell 新增跨实例串行 boot 测试；镜像测试补 25 方法金基线。
- **第二轮审查加固（2026 round-2 review）** —— 镜像测试升级为**类型敏感**
  比对（字段名之外还比对 `name:type` 签名，覆盖 PluginApplyResult /
  ChamberNotificationSettings / ChamberSettings 等）并修复解析脆弱性
  （`\b` 锚定防 `ChamberSettingsStatus` 前缀错配）；settings-connections 的
  `Window.dshChamber` 改导入权威 `DshChamberBridge`（不再自述镜像却缺 4 字段）；
  transport-manager 的 M2 测试改为真验证 `disposeAsync` 在 SIGKILL 前不 settle、
  新增 M10「分配期间断连不臂慢重探」守卫用例；shell 迟到 settle 测试时序裕量
  加宽（80ms 预算 / 250ms 延迟）。
- **session runtime 导出收敛（2026 audit M12）** —— 控制面 index 只 re-export
  生产符号（call/RpcBusinessError/RpcTransportError），respond/openEventStream
  不再对外（测试仍经 dsh-client.ts 直连）。
- **审计复核登记（2026 audit S19）** —— 以下审计项经复核确认**已修复、
  无需改动**：H7（Origin:null 已被 corsFor 拒绝，403）、M3a（proxy 空闲
  超时每 chunk 刷新、45s）、M5（pnpm pack/本地插件 CLI 均为异步 runChild）、
  M11（uncaughtException fail-closed 退出）、L1（layout WeakRef 扇出）、
  L4（CI 全部 action 以 commit SHA 固定）。
- **打包完整性** —— `notifications.ts` 补入 electron-builder `build.files`
  （此前打包产物缺该模块会启动失败）；preload 编译改为临时目录 emit 只搬入
  `preload.cjs`（消除 3 个死文件进 asar）；`build.files` 排除 `dist/.vite/**`。
- **死依赖清理** —— 移除控制面 `@simplewebauthn/server`（v1 认证面移除后的
  残留），锁文件与第三方声明同步。
- **Gateway ESM bundle require shim** —— ws 静态 `require('events')` 在纯 ESM 产物中触发
  "Dynamic require not supported"，派生会话索引/审批流无限重连、`/chamber/sessions` 恒空
  （Linux + macOS 实机发现）；build.mjs banner 注入 `createRequire` 修复，构建冒烟测试锁定。
- **schedule 的 `session.prompt` wire 形状** —— 旧 `{sessionId, prompt}` 载荷被 dsh
  0.1.1-rc.2 拒绝（实机反推 schema：判别字段 `mode`）；改为
  `{sessionId, mode:'queue', content:[{type:'text',text}]}` 并锁回归测试。
- **审查加固轮（2026-08 全量审查）** —— schedule 业务拒绝终止 job（不再无限退避）；
  git 脏工作树删除回退 ready + error 字段（可重试）；`removedSessionIds` 上限；请求体超限
  销毁流；WS upgrade `auth_busy` → 503；JWT alg 显式校验；schedule 作业数/长度上限；
  gateway 来源的 open-in 按钮 fail-closed（不再渲染死控件）；open-in/layout 客户端包补
  测试（29 例）；askpass 代际退役语义（disconnect 保留在途 helper，移除才最终删除）；
  exec epoch 防迟到投影污染；settings 文件校验纳入 notifications 子块；EPERM 降级等。

### 安全

- Gateway 拒绝 absolute/protocol-relative/backslash authority、伪造 forwarded identity、
  弱凭据和匿名外部部署（匿名外部默认拒绝；`--no-auth` 是显式、带醒目告警的可信网络运维覆盖）；密码改变跨重启撤销旧 cookie，token 更新会关闭已建立流。凭据值仅作为
  连接表单瞬时 write-only 输入；除此之外不由主进程返回/回填、不由 renderer 持久化，
  也不进入日志、managed dsh 或 Git 环境。共享 proxy 采用真正的全进程 300 MiB 请求体预算
  （未知/chunked 单请求 32 MiB）、backpressure 生命周期与 forwarding-header 清洗；登录 body、
  dsh event 原始帧/队列和派生索引均有过滤前硬上限，Gateway state 全部 owner-only。
- Git 补偿改为“歧义即保留并记录 recovery”：只允许 live workspace 派生的 canonical
  主 checkout；Git 子进程清空继承的 `GIT_*`，create/delete 紧邻 mutation 二次验证 live
  权威；unverified 记录不可删除，运行中/符号链接 cwd fail-closed，删除不 force、不删分支，
  不允许 deleting 恢复记录删除被新 workspaceId 重占或在 workspace 消失后残存的路径；审批/提问只有 dsh
  receipt 明确 accepted 才从 pending 移除。Feature flags 默认关闭并在服务端执行；scheduler
  具备 timer 上限、single-flight、失败退避和取消/重连代际保护。
- Release workflow 绑定 tag/checkout SHA，拒绝不可信版本 shell 注入、删除已发布 release、dry-run
  写入与 npm channel 回退（npm 发布暂缓期间该步骤已注释，恢复时启用）；稳定版/预发布分别使用
  `latest`/`beta`，正式构建不固定第三方 Electron mirror。已有 Gateway secret 读取前拒绝
  symlink/非普通文件并收敛至 0600。
- notify answer/approval 的 client-response 信封形状实机验证（未知 rpcId → `not-pending`
  回执，失败形态显式 409 + pending 保留）。

### 变更

- **文档收口** —— `docs/progress/STATUS.md` 重写为只记录未完成/部分完成项与
  范围偏差（已实现基线以 git 历史与 CHANGELOG 为准）；AGENTS.md 与设计文档
  同步（open-in 包、ws-frames 测试、打包完整性 checklist 新增）。

## [0.1.5] - 2026-08-23

### 新增

- **VS Code 深链插件（设计 16）** —— `dsh-chamber://` OS 深链 + 应用内按钮
  快速拉起本机 VS Code Remote-SSH 打开对应 server 实例目录（本地走
  `vscode://file/`、远程走 `ssh-remote+`）；按钮位于官方会话头部 utilities
  槽（session-log 左侧），图标取自本机 VS Code 官方资源。
- **Git 工作树删除增强（设计 08 §6 修订，用户拍板）** —— dirty 工作树不再
  硬性阻断删除：删除对话框警示「未提交更改将被丢弃、分支保留」+ 勾选框，
  勾选后以 `git worktree remove --force` 移除；**分支/提交/HEAD 永不触碰**，
  身份/锁/主 checkout/running 守卫全部保留。

### 修复

- **Git 删除 504 竞态与 workspace 残留** —— 控制面实例反代上游空闲超时
  10s→45s（高于 host git mutation 预算 30s）、浏览器 git RPC 超时 30s→60s：
  慢速 `git worktree remove`（node_modules 重型目录）不再被 504 截断、
  不再残留"普通 workspace"。
- **Git host** —— pre-2.47 Git 回退换行定界 `--porcelain`（`-z` 未知开关
  exit 129 时自动降级）；以最高优先级 `-c core.hooksPath` 禁用 worktree
  hooks（防仓库自身 `core.hooksPath` 重新启用 `post-checkout`）。
- **控制面加固** —— 代理剥离转发身份头；keep-alive 超大 JSON 请求体排空
  （防连接被长请求体长期占用）；reaper 端口不可验证时 fail-closed；强制
  仅回环绑定地址。
- **桌面端安全** —— 拒绝渲染层注入的 `file:` 插件 spec；默认拒绝 web
  权限请求（剪贴板写入豁免）。
- **渲染器** —— pre-ready 503 预加载额外行有界重试（实例启动窗口内不再
  静默丢失 profile 安装的插件）；host-graph bundle 仅加载 root-relative
  形态。
- **侧边栏** —— 移除死的 `sessions.state` 完备性检查（修复 session 状态
  图标滞后一轮轮询周期的断链）。
- **设置桥** —— 搜索聚焦时服务器下拉保持打开；客户端插件诊断迁移到
  connections 插件的 chamber 块。
- **VS Code 插件** —— 按钮入位官方 `conversation.session.header.utilities`
  槽（不再与 utilities 行重叠）；图标换官方资源、排序在 session-log 左侧。

### 变更

- **发布流水线** —— macOS Developer ID 签名/公证接线（fail-closed：缺
  凭据或验签失败即不发布，删除旧 Release 之前先预检凭据）。
- **性能** —— 侧边栏拖拽目标未变化时跳过重渲染。

## [0.1.4] - 2026-08-21

### 新增

- **Git Worktree 插件 OpenChamber 呈现对齐（设计 08 §11）** —— **workspace
  行即 Git 表面**：occupant 渲染进 workspace 头部行内（分支 chip 常显、
  行内创建/删除动作与 "+"/kebab 同 hover 触发、状态徽标 dirty/↑↓
  ahead-behind/健康/attention），独立 git 行与独立面板座位移除
  （`sidebar.workspace.git` 上下文座位替代 `sidebar.git`）。创建对话框对齐
  OpenChamber：New/Existing 双 tab、分支名双词 slug 查重、目录同步/重置、
  来源分支下拉（localStorage 按仓库记忆）、已有分支可选框（快照 branches）、
  **单击直接创建**（无预览屏，host 校验链保留）、**创建永不提交会话**
  （recovery 携带 createSession 标志）。删除对话框列出关联会话标题（≤5 +
  "还有 N 条"）+ **可选同时删除本地分支**（用户授权，失败如实上报且不阻断
  已删工作树）。
- **Git Worktree 后端对齐** —— 统一 worktree 根
  `<DSH_HOME>/worktrees/<仓库>-<hash12>/<目录>`（集中、跨同名仓库无冲突、
  仓库工作树外）；**来源分支 startRef**（新分支从所选分支 HEAD 起，精确
  commit 钉死 + create 复验）；快照 **upstream/ahead/behind 只读事实**
  （status `--branch`，基于本地 refs 永不 fetch）；发现缓存 30s TTL +
  workspace 签名失效；`show-ref --heads`/`branch -D` 白名单新增。
- **显示全部 worktree（Plan A）** —— 未注册工作树按仓库分散到 repo 组
  末尾（名称=目录 basename，行样式与派生 workspace 一致），"新建会话"即
  adopt 懒注册、"删除"走未注册删除（host `workspaceId` 可选 + `path`，
  git-first 保留全部守卫，`next: 'none'` 跳过 workspace 删除）；孤儿
  workspace（路径已消失）显示"已消失"徽标，删除弹专门确认（仅清理注册、
  会话保留转未分组）；关联会话计数只统计可见会话（排除已归档/子代理）。
- **对话框细节** —— 创建对话框双 tab 改**滑块式切换**、来源分支/已有分支
  下拉复用仓库 Menu 原语（自定义样式，弃用系统 select）、**目录重名自动
  加数字后缀**（`name-2`/`name-3`…，打开/切换/失焦/提交四处查重，同仓库
  范围）；删除对话框移除长说明文字、工作树路径颜色提为主色。

### 修复

- Git host：**startRef 解析层被丢弃**（一选来源分支即 `invalid-input`，
  P1）；缺失分支 exit 128 被当硬错误（`localBranchHead` 非零即 null）；
  create 不清发现缓存（新工作树快照 30s 不可见）；快照每仓库每轮多余
  show-ref（缓存 branches 未消费）；deleteBranch 重放路径静默跳过。
- Git 客户端：无会话创建在恢复重试时仍建会话并跳转；existing tab 残留
  new 模式建议分支；existing 目录被静默覆盖；occupant 按钮未纳入拖拽
  尾随 click 抑制；分支删除结果被解码丢弃；attention/upstream 等新字段
  对旧 host 包按"缺省降级 + 未知值仍拒"解码（不再整源静默消失）；blur
  规范化保留非 ASCII（中文分支名不再被改写成 `-`）；死样式/死 locale
  清理。
- **Git host 404 语义**：git RPC 404 判定为确定性的
  `git-host-not-loaded`（host 包缺失或未生效，不建恢复、不重试）——本地
  重启桌面端、远程在连接设置中重下发 chamber host 包并"重启生效"。
- **一键重启远程实例**：connections 插件的 chamber 块新增"重启实例"按钮
  （`restart_service`）与 seed 后的"重启生效"（pendingRestart）态；同时
  chamber 双包 seed 新增 `gitWorktree` 探测。
- **窗口重建崩溃根因**：desktop 用带尾斜杠的 rendererOrigin 重建窗口产生
  `//` 双斜杠 URL，control-plane 的 `new URL` 解析在 Node 22 抛异常导致
  致命退出——两端修复（URL 归一化 + 解析 try/catch 返回 400）。

### 变更

- **dsh 基线升级 0.1.0-rc.8 → 0.1.1-rc.2** —— 构建期源码（`harness.commit` /
  vendor 树）、捆绑运行时（`@deepseek-ai/dsh`）与兄弟检出统一到 rc.2；
  in-repo fork 副本重基于上游 rc.2：`dsh-client-connection`（RPC 签名合并
  同时容纳上游 transport override、HTTP body 上限 160→300 MiB、
  `__DSH_TRANSPORT__` 传输钩子接线且完整保留 chamber per-instance basePath
  补丁）、`dsh-client-web`（boot 内核 `__DSH_TRANSPORT__.loadBundle` 接线 +
  预取跳过）。上游 rc.2 的图片/Files 管线（200MiB 图片准入）经 chamber 代理
  可达（见下条）。
- **控制面代理体积上限 50/100 → 300 MiB** —— per-instance 代理
  （instance-proxy）请求体/响应体上限与进程级缓冲预算对齐上游 rc.2 的
  300MiB 请求体上限（200MiB 图片 base64 膨胀 ~267.7MiB 后仍留余量）；
  413/503 语义与 30s 分片空闲超时不变。

## [0.1.3] - 2026-08-20
### 新增

- **Git Worktree 独立插件（设计 08）** —— 新增实例内
  `@dsh-chamber/dsh-host-git-worktree` Remote 与首屏静态
  `@dsh-chamber/dsh-client-ui-git`：30 秒单飞拓扑、`sidebar.git` 座位、创建
  worktree/workspace/session 补偿事务，以及 Git-first/workspace-delete 可重试删除。
  Git 与 workspace 权威同进程/同用户；主工作树、dirty、locked、运行中目标硬拒绝，
  全程不归档、不 force、不删分支，也不开放 fetch/pull/push 等网络 Git 动词；创建
  checkout 仍遵从该用户已配置的仓库 filter（例如 Git LFS，可能访问网络），并在确认
  界面明示。host-graph 与 Git host 包使用同一 overlay；本地 profile 和远程
  ready-time seed 均先完整预检两个包，再逐文件写入并一次合并 overlay（不是跨文件
  原子事务，失败会响亮并在下次 ready 幂等重试）。
- **Git Worktree 插件三处扩展（2026-08-20 合并后）** —— ① 每个工作树行新增
  「在此新建会话」：对**已有工作树**做只读采纳式会话创建（无 Git mutation；
  workspace 复用/注册 + 预分配会话 id，session 尝试后永不补偿）；② 会话↔工作树
  附着状态模型：host 快照按行分类 `ready/missing/invalid/not-a-repo`、
  `branch/detached/unborn` HEAD 与进行中 Git 操作（merge/rebase/cherry-pick/
  revert/bisect，从工作树 git-dir 探测），侧栏呈现健康/HEAD/attention/当前会话
  徽标，删除对不健康工作树显式阻断；③ 删除级联语义对齐：删除确认时递归枚举
  （`parentSessionId` 闭包）直接 + 全部子会话，文案明示「会话保留并转未分组，
  不删除」，并可选先归档整棵会话树（归档失败即中止，不删任何工作树）。
- **「检查更新」按钮与更新设置段**（design 11 修订）——设置「通用」段并入
  `UpdateSection`，用户可显式触发更新检查（与启动/周期静默检查同一条路径，
  从不自动下载）；`update-gate` 相位门 + 单测。

- **rc.8 后端版本容忍（设计 09 §3.3 修订）** —— 实例后端 dsh 官方前端版本与
  chamber 壳不同步时不再整 boot 崩溃：壳未覆盖的宿主图额外行（含 rc.8 新增
  `dsh-client-ui-attachment` client half 等核心行）apply/materialize 失败降级为
  **特性缺席**（console.error + status `failed`，shell 照常 boot）；壳种子词表对齐
  rc.8 官方平台集（平台词 = 永不成为图行的包）；app-shell renderer 安装容错（后端
  `ui-renderer` 行先装则采纳）；chamber 入口 bundle 装载去 `?rev=`（与 vite chunk
  图裸引用同 URL → 延迟 ui-* 族不再二次执行入口 bundle，duplicate factory 消失）。
- **boot 容错决策规则单测（`pnpm run test:client-web`）** —— 版本容忍判定规则
  提取为纯函数模块（`dsh-client-web/src/boot-tolerance.ts`）并纳入 CI 单测面，
  后续改动不再靠人工回归。


### 修复


- **退出流程加固**（design 14 review 轮）——退出确认仅在本地 dsh 进程实际
  存活时弹出（`localProcessAlive`，状态串独立事实）；SIGTERM/SIGINT 走优雅
  退出路径（will-quit 完整回收，强停不再残留 detached 孤儿进程占端口）；
  控制面 stop 先强关连接再 close（滞留 SSE/WS 不再挂死退出）；设置壳重构为
  「连接/通用」两固定入口 + `quitConfirmation` 开关。
- **插件管理 Modal 两处修复**——浅色主题白底白字（内容锚定
  label-primary）；本地实例恒 loading 导致 footer「关闭」死控件（移除）。


- 实例运行 rc.8 官方前端时 chamber 渲染器 boot 崩溃（seed 词表遮蔽 factory →
  "invalid plugin"），现降级为特性缺席、实例照常可用。
- 延迟加载的 ui-* 族导致 tool-call 节点渲染"未知 surface 事件"兜底文案（chamber
  入口 bundle 因 `?rev=` 与 chunk 图裸引用被浏览器视为不同模块而二次执行）。
- 后端 `ui-renderer` 行先装 slot-renderer 时 app-shell 整 boot 失败，现采纳已装
  renderer。
- boot 容错日志措辞与实际失败类型对齐；manifest 预加载行去重过滤覆盖旧的 `?rev=`
  残留形式。


### 变更


- **全量对齐 dsh rc.8 baseline（设计 09 §4）** —— `harness.commit` →
  141eb6fef8（dsh 0.1.0-rc.8）：vendor 源物化为仓库内受管快照
  `vendor/harness-checkout`（规避 pnpm 11 锁文件剪枝，`--frozen-lockfile` 通过）；
  boot 内核迁 rc.8 模块系统 bootstrap（`boot.ts` 类结构 + `__ModuleLoader__`
  facade + BootPage 加载页，挂载经 `ctx.uiRenderer`）；复合延迟族 +3 覆盖
  （`ui-attachment` / `ui-brand-official` / `ui-reference`）、`ui-renderer` 归
  page-own；web-react/schema-form 深导入随删/迁移（渲染装配移入 ui-renderer 行，
  settings 系迁 `SettingsSchemaService`）；本地宿主同步升 rc.8（vendor dsh
  0.1.0-rc.8）。rc.8 客户端自带 `commands.execute` 的 `images` 参数，临时兼容桥
  随对齐移除；rc.7 宿主随对齐移出支持面。



- 壳种子词表移除 rc.7 遗留平台词（`dsh-client-web-react` /
  `dsh-client-ui-attachment` / `dsh-client-schema-form`），与 rc.8 官方一致。
- 设计 09 失败降级语义按层表述：加载失败响亮归预加载层（collectExtraRows），
  apply/materialize 失败降级归 boot 内核层。

## [0.1.2] - 2026-08-19

### 新增

- **桌面自动更新（设计 11）** —— 静默更新检查（启动延迟 + 6 小时周期）、设置页低调的「更新」分区、仅在用户明确确认后下载、退出时安装。双平台更新源已随发布提供（`latest.yml` / `latest-mac.yml`；beta 频道经 semver 预发布版本）。macOS 安装环节在缺少 Developer ID 签名时如实提示（给出手动安装指引，绝不假报成功）。
- **睡眠/后台常驻（设计 14）** —— 关窗行为可配置（隐藏到托盘让 dsh 继续运行，或退出；退出前若会停掉活动隧道或本地实例则先确认）、登录自启（mac/linux）、OS 唤醒即时重连（不等心跳 watchdog）、保持唤醒开关。设置持久化于主进程 `chamber-settings.json`（0600、原子写、损坏文件保留）。
- **Chamber 设置页（设计 15，v1 平铺表单）** —— 设置壳固定入口 Connections / General / Update；chamber 全局设置与实例配置平面严格分离。
- **首屏性能（P4）** —— 服务 HTML 中的静态骨架 + 关键 CSS、并行 boot、host-graph 拉取与 boot 链重叠、非首屏 ui-* 系列拆为懒加载 chunk（入口 chunk 934KB → 650KB）、与清单 URL 匹配的绝对 modulepreload、控制面 `/assets/*` 即时 gzip + 不可变缓存。
- **侧边栏 UX 批量改进** —— 单击立即打开会话、双击重命名；经 chamber ui-layout fork 跨 shell 与重启持久化侧边栏宽度；N-ctx 切换服务器时保留侧边栏滚动位置；显式排序菜单 + 官方 updated-order 语义（手动顺序 + 活动提升）。
- **Host-graph 可见性** —— chamber 注入的宿主包行展示模块 A 版本与实时生效三态（已生效 / 重启后生效 / 未知），经隧道 RPC 探测。
- **Boot 加固** —— covered 包的联合表补全、chamber 级失败遮罩（报告 + 重试 + 切换服务器）、首次启动模块系统竞态修复。

### 修复

- macOS：`windowCloseBehavior='quit'` 现在真正退出（此前在 darwin 上会永远停留在无窗口状态）；唤醒重探不再在退出拆除期间生成传输。
- `isAllowedReleaseUrl` 拒绝百分号编码的路径穿越与 userinfo —— 白名单不再能被指向任意 github.com 路径。
- 更新器：下载进行中时周期重检不再覆盖 `downloaded` 状态；错误文本路径脱敏覆盖任意 POSIX 绝对路径。
- 侧边栏：两个 rowActions 包裹 span 现在把 `stopPropagation` 与 `clearPendingClick` 配对（残留的 pending 可能误入重命名）。
- 远程插件列表刷新不再为未初始化的远程 profile 写 ERROR 日志（静默 manifest 探测）。
- 设置壳 keyed-slot 支持（插件页不再弃置 chamber 壳）；子 ctx 错误在宿主 seam 处收口。
- 连接设置：chamber-block 可读性恢复；刷新操作区分开。
- 渲染层/侧边栏滚动同步排除 ghost 行；排序推导收敛不再写循环。

### 变更

- **macOS 发布构建现在面向 macOS 26**（`macos-latest` runner）—— macos-14 已弃用（2026-07）且到 2026-11 不再受支持。
- 发布工程：版本断言覆盖全部 6 个 chamber 包；发布 workflow 并发守卫；CI 打包显式 `--publish=never`（否则 electron-builder 26 在 CI 环境中隐式发布）。
- **发布产物不再附带 `.blockmap`** —— Windows `nsis.differentialPackage` 恢复为 `false`；mac zip 硬编码的 `.zip.blockmap` 在 finalize 前从 draft 移除。更新源永不引用 blockmap，更新回退为全量下载（功能不变）。
- 中文 README 提升为主版本（`docs/README.en-US.md` 镜像）。

## [0.1.1] - 2026-08-18

### 新增

- Chamber host-graph 注入在插件管理中可见（本地/远程 seed 接线、`--patch` 覆盖、安装级回退）。
- 客户端插件运行时加载（设计 09）：每实例 host-graph 合并、额外 entry 预加载、covered 集去重。
- 经 SSH exec 通道的远程插件管理（list / add / remove / restart、spec 白名单）。
- 多来源侧边栏增强批次（workspace 分组、信息卡、运行中 subagent 指示、跨 ctx 实时同步）。
- 可信 IPC + 导航围栏到控制面主 frame；拒绝非 loopback 的 HTTP/WS origin。
- Windows 单趟精简安装器；应用/托盘图标；打包 dev 实例隔离。

### 修复

- 瞬时隧道失败经慢速重探重试；渲染层崩溃窗口恢复；N-ctx cordis ctx 在 dispose 时拆除；排队中的会话打开保持 pending 直到 runtime 接受；行操作上光标闪烁；chamberBridge 发布以投影签名门禁（保持身份一致的聚合状态）。

### 变更

- 集成 dsh 0.1.0-rc.7（harness 固定 + CI bundle 固定 + lockfile 同步）。
- v1 放弃 macOS x64 CI 构建（仅 arm64）。
- 自动更新重设计为低调的设置流（设计 11 范围）。

## [0.1.0] - 2026-08-15

初始发布 —— dsh 的本地桌面连接管理器：

- 控制面连接核心：web profile 宿主托管、管理 REST（`/health`、`/api/connections`、`/api/host/logs`）、每实例同源反代、静态前端服务。
- 自建渲染层（dsh 官方前端源码复用）：N-ctx 多实例、chamber 侧边栏 / 连接设置 / 设置壳客户端插件。
- SSH 传输（隧道 + 远端 systemd）、实例注册表、Electron 单 frame 壳、CLI。

v1 范围：无认证/审计面（仅 loopback 控制面）。

[0.1.5]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.5
[0.1.4]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.4
[0.1.3]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.3
[0.1.2]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.2
[0.1.1]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.1
[0.1.0]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.0
