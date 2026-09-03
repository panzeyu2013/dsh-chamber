# Changelog（变更日志）

本文件记录 dsh-chamber 的全部重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目遵循[语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

发布产物与各版本的发布说明同时发布在 GitHub Releases 页面
（`https://github.com/panzeyu2013/dsh-chamber/releases`）。

> English: [docs/CHANGELOG.en-US.md](docs/CHANGELOG.en-US.md)

## [0.2.1-beta.1] - 2026-09-03

### 新增

- **Linux 桌面首版支持（设计 22）** —— AppImage（x64）发行形态（electron-builder
  linux target/desktop.entry/executableName）、Linux 自动更新解锁（形态门：
  打包且从可写 $APPIMAGE 启动才启用；dev/解包/deb 形态保持历史 inert 文案与
  settings 按钮门，零 UX 回退）、每次打包态启动重写的用户级协议 .desktop
  （MimeType=x-scheme-handler，Exec 指向 $APPIMAGE）与 XDG 规范自启（尊重
  XDG_CONFIG_HOME、补 Icon/StartupWMClass）、node 兜底平台分表 + X_OK 校验、
  目录 fsync EINVAL/ENOTSUP 平台无关容错（NFS/FUSE 家庭目录）、
  resolvePnpmBinDir 增补 Linux 安装根、release.yml `build-linux` 腿
  （ubuntu-22.04 基线）与发布策略测试 4 腿。契约与剩余实机门禁见
  `docs/design/22-linux-desktop.md`。
- **Windows 首版支持推进（设计 23）** —— M0–M6 代码落地：CI `test-windows`
  契约腿与 win32 生命周期探针（`win-probes.ts`：PowerShell CIM 身份 /
  netstat 端口 / taskkill 树终止；reaper 与 spawn-dsh 平台自适应接线）、
  `win-acl.ts` 启动路径 ACL 收紧、NSIS 卸载清理、win32 登录自启与深链打包态
  注册、open-in 本地盘符路径、SSH 密码门引导；dsh-runtime 新增
  `windows-process.ts`（supervisor 树终止）/ `rename-retry.ts`（Windows
  重命名重试），快照发布/恢复/stash 全改走重试路径。运行时管理在 Windows
  默认只读投影，`DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1` 为开发/验证门
  （严格 '1'、默认关）。真实 Windows runner 首跑与实机矩阵仍为外部门禁，
  见 `docs/design/23-windows-support.md` 与台账。
- **Gateway 与 SSH 插件管理统一（设计 21）** —— gateway 新增
  `/chamber/plugins` install/remove/materialize/tasks 写面 + journal/队列与
  `/chamber/plugins/installed` 读面、tgz 扫描 + 插件 spec 校验；桌面侧
  plugin-tarball 构建/同步与 SSH 后端同模型（apply-rows/journal）；managed
  profile 写租约与运行时事务互斥，新增 `/chamber/runtime/start` 原语
  （停机/错误/restart-exhausted 恢复，决策 12）。契约见
  `docs/design/21-gateway-plugin-parity.md`。
- **dsh 运行时设置面统一（本地 × gateway 同构）** —— 彩色状态徽标词表、
  快照/磁盘并入「当前状态」组、registry 只读行 + 编辑态统一、常驻「清理已
  安装版本」；gateway 补齐 `cleanup-version` / `restore-pre-rollback` /
  `recover-metadata` 路由；FATAL 元数据损坏改 blocked-alive（gateway 存活、
  托管 dsh 停机、管理面可轮询，恢复面 = recover-metadata）；status 增
  metadata 健康投影；desktop env/只读平台放行「重启 dsh」。
- **「内建版本」行引导（2026-12 用户决策）** —— 桌面与 gateway 设置中选中
  与内建（随应用/部署锚）同版本的行且该版本尚未装成受管树时，主按钮引导
  「恢复内建」（清除用户选择回到内建副本/锚，零下载）；「仍下载并安装为
  受管版本」为显式次要动作；已缓存（曾装树）时保持普通切换。

### 变更

- **desktop 打包配置** —— `build.linux` 目标从 `dir` 改为 `AppImage`；新增
  `dist:desktop:linux` / `dist:linux` 脚本。
- **updater.ts Linux 门控形态化** —— `platform==='linux'` 无条件硬门改为
  「可写 AppImage 运行形态」门（`probeLinuxAppImage`）；非 AppImage 形态的
  blocked 文案 `'auto-update is not supported on this platform'` 与
  settings-bridge 按钮门保持不变。
- **Electron 二进制惰性安装（每机器共享 dist）** —— 根 postinstall 默认跳过
  Electron 下载，`DSH_CHAMBER_ELECTRON=1` 或 dev 首启按需物化到平台缓存共享
  dist（多 worktree 并行开发共用一份）；dev 控制面端口自 17520 自动退避到
  首个空闲端口（`DSH_CHAMBER_CP_PORT` 可固定覆盖）。
- **dsh 基线升级至 0.1.2-rc.1** —— 源码线（submodule pin）与捆绑运行时（`@deepseek-ai/dsh`）双线同步至 dsh-v0.1.2-rc.1（a66e4702）；上游 rc.1 相对 alpha.5 **零代码改动**——全仓 252 个 `package.json` 仅版本行 bump（alpha.5 → rc.1，diff 复核），客户端/wire/存储/DOM 面无任何增量——in-repo fork 副本（connection/web/api-gateway）零源码重放、仅版本标记同步，DOM 锚点与 wire 契约沿用 alpha.5 审计基线。
- **gateway 运行时客户端核心重构（design 21 §5.2）** —— 纯核心（解析/
  动作门/错误分类/轮询）迁入 sidebar 共享面，settings-bridge 仅保留 view
  映射；consumer ambient 镜像同步并由 lockstep 测试锁定。

### 修复

- **渲染器 extra-bundle 跨重启加载恢复** —— 实例重启窗口内到达的
  extra-bundle 加载不再被丢弃：重启完成后正确续载，避免该行插件静默缺失。

## [0.2.0] - 2026-09-03

### 新增

- **认证服务端 Gateway** —— 新增可独立部署的 `@dsh-chamber/gateway`：托管单个 loopback dsh 实例，经默认全量认证的统一 HTTP/WS 请求边界（密码登录 + bearer token）与有界反代暴露官方前端与 API；登录页与请求边界诊断页采用官方 dsh 蓝设计语言并跟随浏览器显示模式，被拒的浏览器请求收到同状态码的本地化解释页（回显值 HTML 转义、无脚本），API 客户端保持 `{error, code}` 形状；对外部署默认认证，`--no-auth` 仅为显式可信网络例外。配套 `install-gateway.sh` 一键安装器：交互向导（ESC 返回、校验循环、离线包自动探测）、离线 `--tgz` 安装与内容指纹更新、`update` 事务与失败自动回滚、`--service-user` 专用运行用户、systemd/用户态/前台三形态与 state 目录 0700 收敛。Gateway 经 GitHub Release 的 `.tgz` 分发（npm 发布暂缓）。
- **dsh 运行时版本管理** —— 运行期安装/切换/回滚 dsh 运行时：registry origin 绑定 + SRI 校验、内嵌 pnpm `file:` 安装、探针门控的原子激活事务与两阶段回滚/恢复、journal/快照/stash 的数据安全闭环；支持用户触发的「立即应用」（apply-now）。核心抽取为共享纯 Node 包 `packages/dsh-runtime`，桌面与 Gateway 的设置共用同一运行时管理面（settings 的 `dsh-runtime` 分节：本地全量管理，gateway 经 `/chamber/runtime` 代理，ssh/http 直连目标不挂载）；安装脚本内置「受控锚」dsh，运行期可经 `/chamber/runtime` 切换。
- **统一打开注册表 open-in** —— 原 VS Code 深链演进为统一打开面：会话头部的打开入口经主进程 OpenInApp provider 注册表（Finder、本地与远程 VS Code）与六步 loud 执行管线打开，来源生命周期证明防串扰；远程 VS Code 经 SSH 隧道；插件包重命名为 `dsh-chamber-client-ui-open-in`。
- **桌面原生通知** —— 会话完成/代理提问/审批请求推送桌面通知（设置可开关）：渲染器复用运行时事实通道做边沿检测，主进程 Electron Notification 呈现，点击打开对应会话；多实例（N-ctx）按实例代际正确路由。
- **侧边栏增强** —— 会话/工作区按来源分组与整来源收拢、跨实例实时联动的拖拽排序（显示偏好持久化）、工作区就地改名（折叠态可见可改）、Git worktree 拓扑与按身份的家族色；会话创建/fork 的收敛延迟修复（行出现/状态图标/位置不再跳动），提问/审批 pending 指示与通知边沿恢复。
- **连接模型 v2 与直连目标** —— 桌面传输与目标解耦：`ssh | http` × `dsh | gateway` 组合（http 直连 dsh 因 0.1.2 线硬阻断在正式发布前禁用，见变更——ssh 为 dsh 唯一传输）；连接失败提示区分「SSH 传输错误」与「dsh 实例探测失败」；连接设置页新增插件清单视图与服务器运行时分节。
- **Gateway 运行时凭据管理** —— v2 凭据信封、`/auth/change-password` `/auth/change-token` `/auth/credentials` 与停机态 `gateway auth` CLI；桌面凭据面板与「修改密码/轮换 Token」入口。
- **移动端 Web 访问面** —— `dsh-chamber-client-ui-mobile` 移动适配插件：窄视口抽屉化布局、44px 触控目标、safe-area、输入行单行 + IME 完整恢复、`layoutFacts` 双源驱动的抽屉滚动锁；UA 分流开关默认关闭；随 Gateway 发行物作为唯一打包的 chamber 客户端插件种子。
- **chamber host 插件种子注册表** —— 桌面把 chamber host 包（host graph、Git worktree）经 `PUT /chamber/plugins` 同步进服务器 state 目录并版本锁定到连接桌面，受管 dsh 实例每次 spawn 即获得 chamber 宿主扩展（激活探针在同步存在前跳过 chamber 宿主域）。

### 变更

- **dsh 基线升级至 0.1.2-alpha.5** —— 0.2 线把 dsh 基线从 v0.1.5 时代的 0.1.x 线迁到 0.1.2：破坏性 wire 变化（`workspace.list`、`SessionSummary.pendingInteraction`、`host.describe` 删除，smooth-corners 视觉等）由 chamber 侧显式适配——侧边栏归档集/状态改走推送通道、pending 改接官方 ui-session 注册表、通知边沿与宿主事实改接新通道；alpha.5 增量全在 host 侧存储面（session-projection-cache/storage 跨版本读兼容：`session_projcache` v5 声明 `compatibleVersions` [3,4]、损坏记录 `backup-and-skip` salvage，修复从 0.1.1-rc.2 / 0.1.2-alpha.3 升级时的启动失败与会话列表标题丢失）——客户端/wire/协议面零改动，in-repo fork 副本（connection/web/api-gateway）零源码重放、仅版本标记同步，DOM 锚点与 wire 契约无需重审计（diff 复核）。
- **dsh×http 直连组合禁用** —— 0.1.2 线 http 直连 dsh 目标被硬阻断（宿主无 spawn 期 browser-auth launch token 即回 401、远端不可恢复）：连接表单不再为 dsh 提供 http（kind 切至 dsh 时 http 草稿自动落 ssh），主进程 http provider 在注册表变更点拒绝 kind dsh；ssh 为 dsh 唯一传输、http 仅服务 gateway。
- **Gateway 形态收口** —— 编排面整体剥离：Gateway = 认证 + 反代壳 + 宿主职责 + 种子注册表；桌面「网关编排」分区移除，跨会话调度/审批代理/会话索引等不再存在于服务端，会话业务完全由官方 dsh 前端承担。
- **凭据与连接安全收紧** —— 桌面凭据存储升级 safeStorage v3（按目标绑定、诚实 0600 明文回退），SSH 密码镜像与 Gateway 密钥同纪律；SPKI 证书固定下握手前零应用字节转发；连接重配置按代际隔离，陈旧凭据/会话不串扰；新增轻量非秘密审计。
- **安装与运行面加固** —— Gateway state 根目录自动收紧 0700 + 属主校验（异主 fail-closed）；安装器私有布局 0700；systemd unit `EnvironmentFile=` 去引号模板修复；实例反代能力边界与请求体有界读取；插件动作主进程确认与本地路径脱敏（v1 安全缓解）。
- **构建与发布基础设施** —— 构建期 vendor 源 submodule 化（固定 commit pin + 链接集断言）；发布流水线引入 dry_run 全链验证、action SHA 预检与 stable/beta 更新通道严格隔离；Electron 二进制惰性安装（桌面安装不再默认下载约 100MB）。

### 修复

- **反代断连检测误杀修复** —— 控制面实例反代曾把无 body 请求与 WS 握手误判为客户端断连（Node `IncomingMessage 'close'` 在请求体消费完即触发），经反代的 GET/HEAD 与 WS 升级被误 abort：bundle 加载超时、web-runtime 无限重连、实例 boot 失败；断连检测改挂响应腿与浏览器 socket 后健康流量不再误杀（含 SSE 同款修复与真实流集成回归）。
- **浏览器登录 Gateway 必然 403（实机定位）** —— `Referrer-Policy: no-referrer` 使同源表单的 Origin 被浏览器序列化为 null、被请求策略 fail-closed 拒绝；登录页与控制面响应改 `same-origin`（无跨站出站文档请求，隐私意图不变），回归锁定。
- **被吊销的 Gateway 会话不再长期呈现「已连接」** —— ready 态 60s 周期身份再验证 + 密码会话「缓存 Cookie 探测 → 401 → 单次自动重登」无感自愈；重登被拒显式落 `requires_user_action`（红点 + 连接页指引），代理注册按认证头指纹差异自动重注册、健康流量不无谓撤销；用户点击来源/打开会话即触发一次即时探测。
- **侧边栏 0.1.2 迁移回归收尾** —— 已归档会话/工作区误复活、提问/审批 pending 指示缺失、通知边沿撤回窗口误报、折叠工作区改名静默 no-op、死通道残留清理。
- **Gateway state 权限契约修复** —— 既有宽松权限（0755）state 根目录由 fail-closed 启动崩溃改为自动收紧 + 属主校验，安装器同契约收敛。

## [0.1.5] - 2026-08-23

### 新增

- **VS Code 深链插件** —— `dsh-chamber://` OS 深链 + 应用内按钮
  快速拉起本机 VS Code Remote-SSH 打开对应 server 实例目录（本地走
  `vscode://file/`、远程走 `ssh-remote+`）；按钮位于官方会话头部 utilities
  槽（session-log 左侧），图标取自本机 VS Code 官方资源。
- **Git 工作树删除增强** —— dirty 工作树不再
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

- **Git Worktree 插件 OpenChamber 呈现对齐** —— **workspace
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

- **Git Worktree 独立插件** —— 新增实例内
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
- **「检查更新」按钮与更新设置段** —— 设置「通用」段并入
  `UpdateSection`，用户可显式触发更新检查（与启动/周期静默检查同一条路径，
  从不自动下载）；`update-gate` 相位门 + 单测。

- **rc.8 后端版本容忍** —— 实例后端 dsh 官方前端版本与
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


- **退出流程加固** —— 退出确认仅在本地 dsh 进程实际
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


- **全量对齐 dsh rc.8 baseline** —— `harness.commit` →
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
- 失败降级语义按层表述：加载失败响亮归预加载层（collectExtraRows），
  apply/materialize 失败降级归 boot 内核层。

## [0.1.2] - 2026-08-19

### 新增

- **桌面自动更新** —— 静默更新检查（启动延迟 + 6 小时周期）、设置页低调的「更新」分区、仅在用户明确确认后下载、退出时安装。双平台更新源已随发布提供（`latest.yml` / `latest-mac.yml`；beta 频道经 semver 预发布版本）。macOS 安装环节在缺少 Developer ID 签名时如实提示（给出手动安装指引，绝不假报成功）。
- **睡眠/后台常驻** —— 关窗行为可配置（隐藏到托盘让 dsh 继续运行，或退出；退出前若会停掉活动隧道或本地实例则先确认）、登录自启（mac/linux）、OS 唤醒即时重连（不等心跳 watchdog）、保持唤醒开关。设置持久化于主进程 `chamber-settings.json`（0600、原子写、损坏文件保留）。
- **Chamber 设置页（v1 平铺表单）** —— 设置壳固定入口 Connections / General / Update；chamber 全局设置与实例配置平面严格分离。
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
- 客户端插件运行时加载：每实例 host-graph 合并、额外 entry 预加载、covered 集去重。
- 经 SSH exec 通道的远程插件管理（list / add / remove / restart、spec 白名单）。
- 多来源侧边栏增强批次（workspace 分组、信息卡、运行中 subagent 指示、跨 ctx 实时同步）。
- 可信 IPC + 导航围栏到控制面主 frame；拒绝非 loopback 的 HTTP/WS origin。
- Windows 单趟精简安装器；应用/托盘图标；打包 dev 实例隔离。

### 修复

- 瞬时隧道失败经慢速重探重试；渲染层崩溃窗口恢复；N-ctx cordis ctx 在 dispose 时拆除；排队中的会话打开保持 pending 直到 runtime 接受；行操作上光标闪烁；chamberBridge 发布以投影签名门禁（保持身份一致的聚合状态）。

### 变更

- 集成 dsh 0.1.0-rc.7（harness 固定 + CI bundle 固定 + lockfile 同步）。
- v1 放弃 macOS x64 CI 构建（仅 arm64）。
- 自动更新重设计为低调的设置流。

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
