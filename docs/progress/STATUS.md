# 模块完成状态总览（STATUS）

> 本文档只追踪**进度状态**：未完成项与范围契约。已实现基线以 git 历史与
> `docs/design/`（设计契约与样式定稿）为准，工程细节在代码注释——不记录
> 历史日志/每日验证记录。本文档是 dsh-chamber 进度追踪的唯一记录。

## 未完成 / 待执行

- **SSH 密码认证（05 §8 例外，已落地）**：未做（可选）：一键免密引导、系统钥匙串。
- **Windows 首版支持暂缓**：detached/进程组/lsof 降级路径；Unix 为契约目标。
- **模型额外参数 + 默认推理等级（设计 07）**：实现推迟——wire 白名单无泛化透传、
  host 组合不可注入、`agent-default-model` 未对客户端暴露，待上游解锁（07 §3/§4）。
- **Git Worktree 插件（设计 08）**：范围决策已定稿（git/GitHub 插件化——不进控制面/
  本体，允许 chamber 强制打包的客户端插件形态），设计稿见
  `docs/todo/08-todo-git-worktree-plugin.md`；实现未排期。
- **远程实例插件管理 / 一键应用本地插件清单 + 可视化添加（设计 13）**：**M1–M4 已落地**
  （exec `restart`/`run`/`write-file` + §7.2 白名单、`remoteDshHome` 贯穿 schema/投影/
  IPC/双 ambient 类型、`plugin-sync.ts` 编排、10 个 IPC 通道、前端
  PluginSyncModal/PluginAddView/plugin-diff）。**chamber 内建注入可见化（2026-08）**：
  插件管理 UI（远端同步视图 + 本地列表视图）新增 chamber 内建组件行
  （`@dsh-chamber/dsh-host-client-graph` 的 installed/patched 状态；远端未注入时提供
  「注入」按钮），远程注入不再是无知修改；远端 seed 已接入连接就绪时的自动注入
  （设计 09 遗留 1 接线，幂等 hash-skip，主进程日志 + UI 实时探测，手动按钮为失败
  重试路径）；注入结果同时写入实例环形缓冲日志（transport-manager 新增公开
  `appendLog`，连接设置页的远端日志面板可见）。installed 语义本地/远端一致：两文件
  定义（package.json + dist/index.js，SEED_FILES）；ENOENT 在原始 stderr 上分类
  （`.ssh*` 命名的 remoteDshHome 不再因整行脱敏而把"文件不存在"误判为 ssh 故障）。
  **chamber 内建注入可见化增强（2026-08）**：chamber 行现在显示模块 A 包版本号
  （本地/远端均解析 seeded package.json，远端复用探测已抓回的 manifest，零额外
  往返）；远端生效状态经主进程隧道 RPC 探测（`probeClientGraphLive`，POST
  `clientGraph/graph`——renderer module C 同款只读调用，复用 verifyUp 探测纪律：
  应答才分类）区分三态——「已注入并已生效」/「已注入（重启后生效）」/「生效状态
  未知」（无 ready 隧道或探测不可分类时），不再永久声称"重启后生效"；本地侧按
  设计不单独探测（本地实例即 chamber 页面，boot 自身证明图通道）。
  剩余：本地 `dsh plugin`/`pnpm pack`
  依赖本机 pnpm（`resolvePnpmBinDir` 扫描 PATH + nvm/volta/homebrew，打包态 best-effort）。
- **客户端插件运行时加载（设计 09，已实现）**：设计见
  `docs/design/09-client-plugin-runtime-loading.md`。遗留：图通道失败仅 console.error
  无 UI 信号（可观测性待补）。**union-table 补全（2026-08）**：覆盖包缺失模块表
  factory 导致额外 bundle 的同步 require 边落空（官方 store-engine 豁免
  `require("@deepseek-ai/dsh-client-runtime/client")`，默认 web profile 的
  `dsh-session-log-export` 行实机触发 boot 失败）——chamber-entry.ts 现为每个首屏
  静态导入的覆盖包注册模块表 factory（返回复合 bundle 内联命名空间，require 边与
  ctx 服务同实例），COVERED_FACTORIES 与 CHAMBER_COVERED_IDS 执行期断言锁步
  （详见设计 09 §3.2）。
- **侧边栏聚合改事件驱动（设计 10）**：实现未排期——改动 05 §3 契约，需评审确认；详见
  `docs/todo/10-todo-event-driven-aggregation.md`。
- **桌面端更新提示（设计 11，已实现，2026-08）**：M1–M3 全部落地——主进程
  `updater.ts`（electron-updater，autoDownload=false + 退出时安装 + 静默失败日志 +
  mac 安装腿 `installBlockedReason` 探测）、preload `update` IPC 面、settings 壳
  chamber 全局「更新」入口（`__update` + `UpdateSection`，zh/en）、desktop build
  配置（publish/mac zip/differentialPackage）、release.yml 双 leg 更新产物
  （`--publish=always` + GH_TOKEN；channel 由版本 prerelease 后缀推导）、
  `DSH_CHAMBER_UPDATE_CHANNEL=beta`。设计见 `docs/design/11-auto-update.md`
  （2026-08 自 docs/todo/ 移入）。剩余：mac 安装腿需 Developer ID 签名（未配置 →
  settings 响亮提示手动安装）、release CI 上传路径实测、双平台实机检查/下载/退出安装。
- **已归档会话管理（设计 12）**：方案 A（前端已归档浏览区先行）+ C（上游 wire 根治）；
  实现未排期；详见 `docs/todo/12-todo-archived-sessions.md`。
- **睡眠/后台常驻（设计 14，设计待评审）**：关窗行为可设（`windowCloseBehavior`：
  托盘 / 退出，hide 不杀进程，控制面/隧道/dsh 实例继续运行）+ 登录自启可设
  （`launchAtLogin`，mac/linux，win 门控）+ 退出确认 + 唤醒即时重连（powerMonitor
  resume）+ 防休眠（默认关）；OpenChamber 桌面端实现已调研（本地源码），设计见
  `docs/todo/14-todo-sleep-background.md`；实现未排期。
- **Chamber 设置呈现（设计 15，设计待评审；2026-08 范围缩减）**：v1 平铺形态——
  settings 壳固定入口扩为 连接/更新/通用（`__general` 为设计 14 设置落点）；
  两级分组、插件提级、新插件包、关于页**推迟不做**；chamber 全局设置仍统一走
  主进程 `chamber-settings.json`（非秘密），与实例配置平面严格分离；设计见
  `docs/todo/15-todo-chamber-settings-page.md`；实现未排期。
- **设计未决**（02 §5 / 04 §7）：starting port 偏移、trusted-host 自定义 Host、多控制面
  `$DSH_HOME` 冲突、响应头白名单双处同步、`__DSH_BOOT__` 随 dsh 版本漂移。

## 范围决策与剩余偏差（不做 / 推迟 / 移出）

- **chamber 合成包懒加载（LCP/perf pass P4，2026-08）**：非首屏 ui-* 家族（commands、
  input-trigger、jobs、goal、skill、tool、trajectory、workflow-run、deliverables、subagent、
  message-feedback、plan、user-questions、agent-preset、permission-presets）在
  chamber-entry.ts 中改为动态 `import()` 并按 fire-and-forget 注册：`apply` 同步注册首屏
  家族后立即返回（entry 根 fiber ACTIVE，boot 的 loader.await + assertEntriesActive 通过），
  迟注册的子 fiber 不阻塞首屏（cordis inject-waiting + reflect 通知驱动已渲染 UI 渐进出现
  迟到的槽位/服务）。契约边界：apply 返回 thenable 会被 `_execute` await（fiber.ts
  `_execute`），因此 apply 必须保持同步返回；sweep 只检查 loader entry 根 fiber，不含子
  fiber。首块 chamber bundle 934KB → 605KB（gzip 175.6KB）；settings-bridge 的
  agent-preset settings 段改为装配子 ctx 时动态导入。设计/验证细节见 chamber-entry.ts 头注。
- **移出项**（P3 硬纪律，永不回流）：认证/审计（密码/Passkey/会话 cookie/client token/
  限流/审计 SQLite）、控制面薄壳聊天/会话列表/审批弹窗、控制面会话运行时/统一索引/
  交互管线、连接注入适配器/broker/绑定、walkthrough、notifications、cron、文件夹/笔记、
  web 预览、MCP、目标/终端等宿主 UI 职责面（处置映射见 01 §4；git/GitHub 例外：插件化，
  见 01 §4 / 设计 08）。
- **默认排序 manual（06 §3.1）**：每来源会话排序默认 `manual`（保持 wire 序），与官方
  默认 `updated` 不同——有意取舍；`orderBy[sourceId]` 持久化于 `dsh-chamber.sidebar.v1`。
  **2026-08 C档对齐**：排序按钮改为显式菜单（官方 ViewOptionsMenu 模式，勾选当前项）；
  `updated` 实现官方 **手动序 + 活动置顶** 语义（`nextUpdatedOrder` account 推导：首次
  观测/切回整列 recency 排序一次，此后仅置顶自上次观测以来更新的会话，置顶经
  `updatedOrder`/`sessionUpdatedAtByAccount` 持久化；updated 下拖拽只写共享 account 序、
  不落 wire）；`serversProjectionSignature` 纳入会话 `updatedAt` 以驱动置顶重发布。
- **侧边栏交互对齐 OpenChamber（2026-08）**：会话行单击**立即打开**（零延迟），350ms 内
  同会话第二次点击进入内联改名——`shared/pending-click.ts` 全局 pending 单例（跨 N-ctx
  shell 共享，替代原"延迟单击"模型；05 §2.2 / 06 §2.2 已同步）。**2026-08 review
  加固**：任何 stopPropagation 控件（含来源头排序/加工作区/搜索）自行 clearPendingClick；
  空白"新建会话"行双击被 blank 门控（不进内联改名）；空白行离开 current 后 450ms ghost
  宽限（`derive.ts armBlankGhost`/`sessionVisible` + `.sessionGhost` 非交互占位）——双击
  窗口内列表不位移，杜绝二次点击误开下方另一会话。跨 shell 滚动位置锚点
  同步（`renderer/src/sidebar-scroll-sync.ts`，App selectView 接线）。**第三波 review
   加固（2026-08）**：ghost 行另带 `data-chamber-ghost`，滚动锚点捕获跳过之（仅 arming
   shell 渲染该行，入站 shell 没有——锚到 ghost 会空转到 8s 截止）；恢复在入站 shell 仍
   `content-visibility:hidden` 时按 `checkVisibility` 门控重试（首个尝试在过渡 apply
   回调内、视图翻可见之前，退化 rect 会让一次性落位错位），模块级 generation 取消被取代的
   重试链（快速 A→B→A→B 不再并发多条 8s 链）；`derive.ts` 注册共享单例守卫
   （`blankGhostUntil` 跨 bundle 共享态，防打包漂移静默分裂）；rename 表单 stopPropagation
   同步 `clearPendingClick`（闭合 pending-click 不变式）；工作区头计数排除 ghost（宽限内
   不再 +1）；ghost 过期条目读时惰性清扫 + 定时器触发后裁剪。侧栏宽度全局化：
  新 chamber 自持包 `@dsh-chamber/dsh-client-ui-layout`（ui-layout fork，仅替换 store 层：
  从 view-prefs 播种/回写），`sidebarWidth` 持久化于 `dsh-chamber.sidebar.v1`（[264,420]
  钳位），官方 ui-layout bundle 保持 covered（one-declarer 规则）。
- **设置桥 keyed 插槽（2026-08）**：bridge-outlet 现支持 root+keyed（`settings.plugin.item`，
  镜像官方 scoped-slots 契约，entryKey 分发 + fallback），修复 Plugins 页黑屏；所有桥接出口
  （本地专属 `settings.action` + 选中实例 `settings.section` 内容出口）在 child-ctx → host
  接缝 `<BridgeEntryBoundary containAll>` 内全量隔离（含 BridgeAssemblyError）——子 ctx 内容
  永不整体 abdicate 到官方 SettingsRoot，壳自持装配错误仍 fail loud。**会话装配自动重试
  （W2 补）**：选中实例 mid-boot/restart 的 not-ready 突发会使子 ctx 装配瞬时失败，壳现以有界
  退避（1s/2s/4s/8s，最多 5 次尝试、~15s 等待封顶）自动重试同一装配路径（`mount-retry.ts`），
  面板保持打开也能自愈，不再只能靠重新点击/连接切换/重开恢复；成功/卸载/关面板/切换选中即清
  账并清定时器。**部署注意**：PRE-fix 状态下已 abdicate 到官方 SettingsRoot 的设置壳需对本地
  实例/应用**重启一次**方可恢复（vendor one-shot retirement——槽系统不再重试已退役的壳注册；
  全新启动不受影响）。
- **推迟**：flat 单列表模式（与「仅按来源分类」呈现原则张力）。
- **06 §4.3 修订（方案 A）**：pending 状态会话行尾渲染可辨识图标徽标（question/plan-review/
  approval），运行中仍为蓝色 ongoing 环。
- **不做（v1）**：跨来源移动会话、单 store 真融合（fork runtime）、会话实时推送同步、
  远程实例管理 UI 外壳。
- **设置壳偏差**：未连接实例不装配子 ctx（配置在目标机器上，物理不可达）；stub remote 无
  WS 失效流；设置壳不渲染官方 SettingsRoot；子 ctx 懒装配；下拉列表 in-panel 定位（超长
  roster 尾部可能被裁剪）；chrome 跟随宿主 locale、子 ctx 跟随目标实例 locale。
- **实例失败呈现修订（2026-08，05 §4）**：boot 失败不再由各 InstanceView 自绘（旧
  `.instance-fatal` 只有重试、无导航——失败视图的 shell 从未挂载、侧边栏不可用，用户被
  困在当前视图只能整页刷新），改由 App 在活动视图上统一渲染 `.fatal-overlay` 覆盖层：
  失败报告 + 重试（`retryToken` 递增 → InstanceView 复位重 boot）+ 服务器切换行
  （`.fatal-servers`，chamber 级逃生通道，不依赖任何 shell 挂载）。dsh 壳内 fail-loud
  报告统一经 `AppWebEntry.bootError`（拷贝包 seam）上浮为 chamber 可见失败态（shell.ts
  失败分支 dispose entry，重试干净重 boot）。
- **v1 实现形态（代码内声明，与 05 契约无实质偏差）**：自研侧边栏 + 纯 dsh 首屏即基线；
  renderer entry 级 React 面仅剩纯 dsh 桥接宿主；当前来源判定经 knob 注入；拷贝包 `tests/`
  未拷贝；`chamber-auth` 随认证移除；settings 页 `ns.inject('settings.section')` 通道可用于
  后续插件化。
- **窗口标题冻结（桌面壳故意偏差）**：桌面壳冻结原生标题栏为 `dsh-chamber`（单 frame 品牌
  恒定），会话名仍在应用内呈现。
- **dev 实例隔离（dev 契约，2026-08）**：`electron-dev.mjs` 以独立 `--user-data-dir`
  （`packages/desktop/.dev-user-data`）+ dev 控制面端口 17520（`DSH_CHAMBER_CP_PORT`
  覆盖）启动，并清除继承的 `ELECTRON_RUN_AS_NODE`——dev 与运行中的打包版实例
  （同一应用名 `@dsh-chamber/desktop` → 同 userData/单实例锁、占 17500）可共存；
  打包版默认端口/数据路径不变。
