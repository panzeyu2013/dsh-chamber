# Changelog（变更日志）

本文件记录 dsh-chamber 的全部重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目遵循[语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

发布产物与各版本的发布说明同时发布在 GitHub Releases 页面
（`https://github.com/panzeyu2013/dsh-chamber/releases`）。

> English: [docs/CHANGELOG.en-US.md](./docs/CHANGELOG.en-US.md)

## [0.4.6-beta.1] - 2026-11-26

### 变更
- **捆绑 dsh 基线升至 0.2.3-alpha.2（4b399c39）** —— 上游 rc.3 → alpha.2 的差异集中在包版本 bump 与少量注释级源文件（`src/` 下仅 4 个真实源文件变化：3 个仅注释 TS 与 1 个 python 包初始化文件），alpha.2 的运行期闭包修复了 alpha.1 的 `EntryValidationError` 导出断链。chamber 同批适配：covered/extra 行的宿主同步客户端配置、`ui-session-status` 首屏行与自挂 HMR remote、HMR live sync 改为每实例 `pluginEvents` Remote 流、`ui-theme` 补丁退役、Office 资产收敛与 pypdf 载荷、remote-connection/forge-gitlab 行禁用、官方 worktree entered 记录、sidebar/layout/seed fork 重放（design 02/09/19；现行值单源 = `harness.commit` 与 `packages/desktop/vendor/dsh/pnpm-lock.yaml`）。
- **Node 引擎范围端到端收紧为 `^24.22.3 || >=26.13.1`** —— gateway `engines`、安装脚本的版本下限（按 major.minor.patch 解析而非固定 24.9）、`verify-pin-alignment` 的交叉校验（根 engines、gateway、安装脚本常量、upstream vendor engines 与 `.nvmrc`/payload/工作流 `node-version` 镜像）同批对齐，旧的 Node 22/24.9 口子移除（design 18；README、DEVELOPMENT 与远端实例文档同步）。
- **连接生命周期、意图归属与来源名册整代加固** —— 本地 start/stop/restart/exhaustion/cancel 走单一进程组退出证明与 generation 健康探针，writer 未证明时 fail-closed（`stop()` 返回 409，不发布 restart-exhausted）；手动断连由 sidecar 按 app session 持有（row-local 元数据原子写、补偿安全、degraded roster 拒绝），只有显式 IPC 才改意图；ready/re-verify/refresh/revoke 走同一 commit 入口（accept-then-publish、健康探针不重注册、认证失败 fail-closed、incarnation 与 transport-generation tombstone）；移除独立的 gateway-sync 镜像；roster 的 commit 变更集统一驱动 transport/exec/forward/seed revoke 与来源退役，逻辑来源身份 = kind+host+remotePort（entry-level identityScheme 迁移保留既有证明）；手动断连改为 session 级、机制切换保留历史并重挂壳、远端 dsh HTTP 401 映射到 instance-auth 提示（design 05/18/21/26）。
- **通知、关注与完成投递按应用激活与后台完成重构** —— 通知焦点由 app 激活派生、页面不可见时后台会话完成仍投递、durable 通知在部分 roster 上不再丢失；renderer 侧按 v3 attention 模型补齐 notification/attention 门禁（design 06、design 19）。
- **文档与门禁面收敛** —— 文档集瘦身并补齐包 README 契约、移除代码与测试注释里的状态记录、CI 在 typecheck 模式运行 seed 与 gateway 的类型检查、浏览器上游文件按 vendor 树校验（文档规则与 gate-surfaces 单源）。

### 修复
- **chamber host seed 迁到 profile fallback 层** —— seed 不再落在 pnpm 管理的 `profiles/web/node_modules`：`dsh plugin add/remove` 重链不再把 client-graph/git-worktree/archive-cleanup/open-in 挪进 `.ignored`；每次解析先删除旧位置遗留副本再按 fallback 重种，desktop 本地插件探测与验收 fixture 同批改读 fallback（design 09 §3.5、design 02 §2.6）。
- **页面 boot 的 store 双注册** —— seed 在模块系统创建时已注册 `@deepseek-ai/dsh-client-store`，复合 bundle 又从 `COVERED_FACTORIES` 注册同一 id，触发 `duplicate factory registration` 并中断其余覆盖 factory 的注册；store 仅保留在去重集，新增 `SEED_PLATFORM_IDS` 计入不可满足依赖谓词，设计文档与双向测试锁同批更新（design 09 §3.2/§3.5）。
- **从源码构建缺 `process.platform`** —— 内置 loader 的 `EntryTree.import` 读取 `process.platform`，而 Vite 只折叠 `process.env.*`，导致每个 loader entry 抛 `ReferenceError` 并 fiberless；按上游 `apps/web` 同款补 define，并加“注释掉的 define 不算满足”的回归锁。
- **boot 冲突与加载失败合并为一条报告**、持久通知在部分 roster 上保留、来源证明跨宿主重启持久化、stream-state 来源 epoch 在退役中保持单调、验收条目与 frozen artifact 新鲜度修复。
- **侧栏 fork 命名跳过已用标题**、文档预览图片按每 entry 的 base 路径解析。
- **macOS 壳** —— phase-plan 测试传入 active fact，design 25 的崩溃反汇编说明与 XCTest 锁同步。

### 文档
- 设计文档与进度记录同批更新：design 02/05/06/09/18/19/21/25/26、checklists 与 i18n 记录。

## [0.4.5] - 2026-11-16

### 新增
- **Swift 本地实例内置 Office 技能与完整 primary-runtime 载荷** —— 本地 Swift spawn 经既有 `--patch` overlay 挂载 `dsh-skill-office` 与 `dsh-tool-workspace-dependencies`，随包携带全量 `primary-runtime`（node + pnpm + python）与 `office-skills` 资产；渲染/转换/重算由上游原生工具 `office_render` / `office_convert` / `office_recalculate` 承担，应用内因此是 `office` / `office-docx` / `office-pptx` / `office-xlsx` 4 个技能目录。首次工具调用把只读载荷安装到 `<DSH_HOME>/dsh-runtimes/dsh-primary-runtime`，应用内文件不被改写；缺载荷/资产时宿主照常启动、能力如实缺席。这些能力只服务本地实例——gateway 与 SSH 远端实例不挂载（deviations 记录），真机/打包态验收见发布检查单（design 18 §4.2、design 25 §4.3/§3.2）。
- **设置 → 通用新增「性能与内存」只读组（含手动释放）** —— 常驻来源表逐行显示状态（活动 / 常驻 / 启动中 / 失败 / 已释放）、隐藏时长与 DOM 节点估算，面板下方显示最近一次释放的来源与原因，并给每个来源一个两次点击确认的「释放 UI」动作；页面 JS 堆与整机内存读数只呈现平台确实可得的读数，不可得时显示「不可得」而不是猜数。该组只在调试模式开启时挂载，释放只拆 UI 壳，不动实例进程、隧道与后台任务（design 15 §D5、design 05 §4.1）。
- **侧栏各来源的面板入口按该来源自己的注册渲染** —— 每个已挂载壳把自己的 `sidebar.panellist` 快照发布到页面级单例（`{id, order, label}`，未知 id 隐藏），非活动来源的 header 因此显示它自己的面板条目；未挂载但仍连接的来源回落固定默认组合（时钟）。点击先激活目标来源，再把一次性 `selectPanel` 意图交给该来源自己的壳：意图跨 boot 挂起、TTL 从点击时刻起算，目标只对自己真正注册过的面板调用 selectPanel（design 05 §2、design 06 §4.3/§4.7、design 09 §3.6）。
- **设置页的更新入口新增状态指示器与技术详情** —— 设置 → 客户端（`__general`）的更新触发行在宽布局下渲染一个只有图标的指示器（Tooltip + aria 标签，无可见文案）：`none` 不渲染、`busy` 转圈且 `aria-disabled`、`available` 下载字形、`error` 红点；点击打开设置并落在「更新」组，状态行仍是唯一的进度面。更新失败行新增可折叠的「技术详情」（复用已脱敏的 `update.error`，空错误不渲染入口），两者都从本页已共享的 update-store 投影派生（design 05 §5、design 15 §1、design 25 §7）。
- **深链 `dsh-chamber://open` 可唤醒已有窗口** —— 新增免参数深链：只接受 hostname 恰为 `open`、path 为空或 `/`、且无 userinfo/端口/query/fragment 的 URL（其余变体 loud 拒绝）；sidecar 经既有 brokered host 把意图交给 Swift 壳，壳恢复/激活已有窗口并聚焦；冷启动尚无窗口时走既有深链缓冲路径，sidecar ready 后按序补发（design 16 §3.1）。

### 变更
- **捆绑 dsh 基线升至 0.2.2-rc.3（38a6a5c9）** —— 本版跨 rc.1 → rc.2 → rc.3 两代上游：rc.2 是 76 条 release note 的界面/契约代次（官方 forge 审阅面、SubAgent 具名多层协作与 AgentTeam 成员/任务面板、聊天向上回看加载更早消息与带增删配色/按文件语言高亮的 diff、模型请求重试条件与次数/等待时间、DeepSeek Search API 默认网页搜索、Gemini 原生提供方与推理等级、Office 原生工具），rc.3 在官方 New Session 行新增 `sidebar.session.action` HOC 装饰座并带来实验性 DeepSeek 会话导入插件；源码线、运行期、三份 `@deepseek-ai/*` fork 副本与发布锚同批换锚（现行值单源 = `harness.commit` 与 `packages/desktop/vendor/dsh/pnpm-lock.yaml`）。chamber 同批适配：侧栏按上游同形声明并渲染 `sidebar.session.action` 座、Office 启动行与 bundle 行按 rc.2 资产面/Config 重排、会话流自动恢复改锚 `ISessions.binding(id)`、chat-import 上传在插件装载缝补 base 锚点、Swift 壳窗口拖拽面与「粘贴并匹配样式」按 rc.2 口径对齐（design 02 §3.1、design 09、design 19）。
- **右栏「浏览器」改为 Swift 原生 guest 载体（每 tab 一个子 `WKWebView`）** —— 0.4.4 的系统浏览器启动器与 v2 的 iframe 载体整代退役：每个 tab occurrence 独占一个由 Swift 壳持有的子 `WKWebView`（独立 web content process、按（source 身份, workspace 键）分区的非持久 `WKWebsiteDataStore`），renderer 只保留上游的地址栏/历史/store/标题/恢复/失败条与占位几何；8 个上游 UI 文件逐字节同源并 SHA-256 冻结，`BrowserPage` 是唯一 fork-diff 面。目标站的 XFO/`frame-ancestors` 不再造成白屏、站内 `_blank` 在面板内开新 tab（按 tab occurrence 6 次/60s 限流）；唯一功能差异仍是 SSH 反代（forward wire 升到 v3、逻辑 URL 与 alias 投影分离、关 tab 释放 consumer），桌面壳 CSP 的 `frame-src` 收窄回 `blob:`（design 28 §1/§3/§5/§9、ADR-0004）。
- **N-ctx 壳改为 keep-all 常驻** —— 用户打开过的来源壳在页面生命周期内保持挂载，旧「隐藏壳最多保留 1 个 + 连续隐藏 60s 回收」机制整体删除；系统投机壳（空闲预热 / 首屏收割）仍只占 1 个后台槽。释放只剩显式路径（来源退役、boot 失败、135s 挂死、遮罩放弃、收割让位、手动释放、硬上限 12、平台内存压力阀），内存压力阀按 30s 采样的整机可用内存分档（`constrained` 保留至多 1 个最近使用的常驻壳、`critical` 释放全部可释放壳，按档连续 2 次判定、250ms 错峰）。代价如实登记：每壳字节内存读不到（单 renderer 架构），`critical` 下后台壳里未提交的草稿可能随释放丢失（design 05 §4.1）。
- **Electron flavor 冻结归档，唯一出货 flavor = macOS Swift 原生壳（破坏性，分发范围）** —— Electron 主进程入口/edge/preload 迁入 `packages/desktop/electron/` 归档（文件保留、可复活；范围清单与复活检查表见 `docs/progress/electron-frozen.md`），Electron 打包/更新腿、Windows/Linux 桌面腿与 Electron-only 测试冻结；发布只出 Swift 与 gateway 产物，macOS Swift 用户是唯一仍收到本版的桌面用户（macOS Electron 与 Windows/Linux 用户停留在 0.4.4）。共享 sidecar 业务核心、host 契约与 Swift 腿共用的代码继续维护，恢复需重开范围（AGENTS.md、design 25）。
- **更新通道改为用户偏好：设置页可订阅预览版（beta）更新** —— 版本后缀不再决定通道；native 发布构建都在装配期成对注入 stable 与滚动 beta 两条 appcast URL，运行期由设置 → 通用「更新」组的「接收预览版（beta）更新」开关（或 `DSH_CHAMBER_UPDATE_CHANNEL=beta`）二选一，默认 stable——因此 beta 构建默认也走稳定通道，打开开关后 beta 订阅跨版本保留。未注入两条通道 feed 的旧构建里该开关禁用并说明原因（design 25 §7、design 15 §2）。
- **随包运行时 pin 与上游对齐（Node 24.21.0、pnpm 11.28.5）** —— primary-runtime 载荷的 Node 升到 24.21.0（archive sha256 逐字取自上游 pin 锁），内嵌 pnpm 升到 11.28.5；载荷锁、锁文件与第三方声明同批刷新。用户可见面 = 随包 Node/pnpm 版本与运行时版本行。
- **隐藏或遮挡的窗口不再推进前台渲染、轮询与补偿** —— Swift 壳在可见性变化时向页面派发 `dsh-chamber:shell-visibility`（`{visible, occluded}`，覆盖 orderOut/最小化/Cmd+H/失去 key/遮挡与另一可见 Space/恢复/导航重放；同值去重、派发失败 loud 不阻断），页面把它与页面可见性合成统一前台相位门 `background-phase.ts#shouldRunBackgroundPhase`：轮询、看门狗、keep-awake、通知压制、常驻壳内存压力阀与恢复补偿（250ms 去重窗）都经该门判定，恢复可见（且未遮挡）时经同一去重窗补偿一轮。keep-awake 同步收紧为「设置开启且窗口可见」才持有 `ProcessInfo.beginActivity`；壳侧拖拽板轮询与渲染看门狗也停表（design 25 §5.7、design 14 §D1）。
- **事实发布的重复帧与每秒抖动被消除** —— 网关与直连 mux 两侧的事实观察者改为单一 `emit()` 出口的内容摘要去重：行 wire 内容与来源级渲染/判定输入（hostState/serviceable/mode/stale）都没变、只有 cursor 或 lastEventAt 前进的空帧不再发布；运行时上报签名里的渲染字段 `factAt` 量化到 1s 桶（原始 `factAt` 仍原样进入 report 与证据锚）。用户可见面 = 多来源页面里徽标与侧栏的逐帧重渲染、App 提交与电池开销下降，身份/投影两条签名路径同批收敛（design 14）。
- **多壳页面只保留一份主题样式与图标 sprite** —— `ui-theme` 的 8 张 theme 样式表与 icon sprite 此前由每个实例壳各自安装同一份（隐藏壳也不卸载）；现在补丁用 `Symbol.for` 把 registry 挂在 document 上，跨壳共享、按 refcount 到最后一个 owner 释放才移除，sprite 的 markup map 共享且同主题重复应用为 no-op（跨壳 `theme/change` 以最后一次为准）。多来源页面的 document 级样式表与 SVG symbol 不再随壳数线性增长（design 09 §3.6）。
- **首屏体积因 simple-icons 改走 ESM 入口而下降** —— vendor 的图标表此前经 CJS 入口把全量图标带进复合构建的首屏图；现在 vite 在通用 `require` 解析之前把裸 `simple-icons` 解析到包声明的 `exports["."].import` ESM 入口（`resolveSimpleIconsEsmEntry`，缺入口或指向不存在的文件 loud 失败）。同一工作树 A/B 实测 chamber 入口原始体积 −60.8%、gzip −72.1%，只有 chamber 入口变化，图标渲染结果不变（预算阈值未因这次下降重定）。
- **聊天滚动几何、侧栏行位移与实例代理解析不再逐帧重复计算** —— `ui-chat` 的滚动交付合并为每帧一次几何读（`onScrollEnd` 先同步 flush、detach 取消、无 rAF 时同步 fallback）；侧栏的悬停门控子树扫描只在行键序列变化时才做，行位移动画（FLIP）把两次起始批的最小间隔定为 250ms、只给本帧正在位移且扫描时不在 `:hover` 的行加 `data-hover-gate`。同批 WebSocket 帧扫描不再逐字节：非 CLOSE 帧一步越过 payload（跨 chunk 只扣剩余长度），CLOSE 仍走字节路径取关闭码。
- **原生壳窗口几何对齐上游视口** —— 内容区取上游桌面视口 1280×792、最小 520×572（上游外框 1280×820 / 520×600 减 28pt 标题栏），尺寸单源 = `WindowMetrics`，与红绿灯/标题栏重排同批（design 25 §5.6）。
- **后台更新检查在回前台/唤醒时补一次，安装前先退出全屏** —— 复用既有 noteActivity 判据（相位门 + 距上次完成检查 ≥ `SUScheduledCheckInterval`（缺省 600s）+ 60s 合并窗）补一次 `checkForUpdatesInBackground`，检查周期与退避不变；「重启并安装」在执行前做全屏退出准备（判据单源 = 壳的全屏标记，最多等 5s），超时返回稳定错误码 `fullscreen-timeout` 供页面给出可重试提示（design 25 §7）。
- **checkout 行与工作树对话框的交互面收敛** —— checkout 行的「有改动 / 已锁定 / 状态未知」只在行内动作揭示时出现（状态胶囊移入 `data-git-occupant` 容器，静息行只留中性分支字形与计数徽标）；新建工作树对话框的分支候选改为打开时现场读取新增的只读 `gitWorkTree/branches`（与 `previewCreate` 同源门禁、失败显式报错而不是空数组、旧宿主 404 回落 `snapshot.branches`）；新建会话与 `gitWorkTree/enter` 后强制一次会话列表重读，新 id 一个 RTT 进壳、揭幕即刻结算（design 08 §2.1/§4.1）。
- **托管宿主继承用户登录 shell 环境（rc.2 对齐）** —— Dock/Finder 启动只继承 session manager 的环境；现在两个桌面入口各发起一次进程级读取（账号记录的登录 shell → `/bin/zsh` → `/bin/bash` → `/bin/sh`，`<shell> -ilc` 包住 `command env -0`），shell 值覆盖继承值但探测环境键、探测会话变量与 `DSH_*`/`ELECTRON_*` 命名空间除外。控制面与窗口构造不等它，单候选默认 10s、超时/中止换下一候选、全部失败回退继承环境并逐条告警；gateway/standalone 不读（design 02 §3.1）。
- **系统注销/关机不再被退出确认挂住** —— `NSWorkspace.willPowerOffNotification` 到达即置 sessionEnding 门：`applicationShouldTerminate` 首行豁免该门、直接放行，不再弹「退出确认」或让系统等待 `.terminateLater`；随后 `didBecomeActive` 复位该门，正常退出的确认与在飞决策合并语义不变（design 14 §D2）。

### 修复