# Electron / Swift 双 flavor 接入点逐函数核对台账（2026-12）

> 定位：**审计台账**——记录双 flavor 接入点的差异、证据、当前状态与待裁决项。它不是进度记录、不是变更日志、不是验证报告；
> 已消解项的事实由 git 历史与设计文档拥有，本文件只在**仍有裁决价值**时保留条目（裁决完成后按 docs/progress/todo 纪律移出）。
> 基线：`8cbee32f`（swift 分支 --no-ff 合入 main 的落地提交）。对照面：Electron 权威实现（packages/desktop/main.ts、
> shell-core.ts、electron-edges.ts、preload.cts …）与 Swift 原生面（macos/，design 25 路线 A）。
> 方法：六路只读审计分片，逐文件、逐函数/逐通道核对；每条结论带 文件:行号 证据。分类：功能级 / 前端可见（非像素）；
> 纯像素与纯样式差异不计入条目，只计数。逐函数对照表（S1 145 / S2 ≈300 / S3 136 / S4 66 / S5 121 / S6 57 项）是过程产物，
> 不随仓库提交；本文件保留其逐项结论与证据锚点。

## 1. 计数总览

| 分片 | 覆盖文件 | 对照项 | 等价 | 功能级差异 | 前端可见差异 | 待裁决 | 纯像素 |
|---|---|---|---|---|---|---|---|
| S1 A 桥 | 35 | 145 | 133 | 10 | 3 | 3 | 0 |
| S2 B 桥 | 32 | ≈300 | 116 | 16 | 5 | 5 | 0 |
| S3 宿主腿 A | 19 | 136 | 92 | 12 | 9 | 11 | 1 |
| S4 宿主腿 B | 28 | 66 | 49 | 9 | 5 | 7 | 4 |
| S5 装配/数据 | 36 | 121 | 79 | 19 | 7 | 12 | 2 |
| S6 前端可见面 | 40 | 57 | 39 | 2 | 11 | 8 | 1 |
| 合计 | 190 | ≈825 | 508 | 68 | 40 | 46 | 8 |

核对环境边界（本次实机核对，非产品差异）：本机在 DSH workspace-write 沙箱内，`hdiutil` 无法创建设备映像
（`newfs_apfs: /dev/rdisk6s1: Operation not permitted`），因此 `test:macos` 的真实 DMG 用例
（`build-swift-app.test.mjs` ⑬）在本机失败、在 CI macos-latest 上不受影响；其余 17/18 用例通过，
`.app` 装配、ad-hoc 签名、`codesign --verify --deep --strict`、zip 归档均已在实机通过。

## 2. 本次已消解（已改代码 + 已跑门禁）

| # | 差异（分片·编号） | 处理 | 验证 |
|---|---|---|---|
| A-1 | 唤醒事件永不触发：NSWorkspace.didWakeNotification 注册在 NotificationCenter.default（S3·D1，原 MainWindowController.swift:236） | 改注册 `NSWorkspace.shared.notificationCenter` | swift test 166/166 |
| A-2 | keep-awake 连带禁止显示器休眠（S2·F6 / S3·D3，原 SwiftEdgeHostLegs.swift:143） | 只保留 `.idleSystemSleepDisabled`（对齐 Electron prevent-app-suspension 与 design 14 D5） | swift test 166/166 |
| A-3 | showMessage 正文显示两遍（S4·U1；调用点 title 与 message 同文案，原 SwiftEdgeHostLegs.swift:576-579） | title 与 message 相等时不重复渲染 | swift test 166/166 |
| A-4 | 出站响应 > 4MiB 被丢弃却不结算 pending → 渲染端 Promise 永久悬挂（S1·F4，BridgeClient.swift:581；S1·D3 的上限本身仍待裁决） | 超长行 fail-closed：loud 上报并作废全部未决请求（不再永久悬挂） | swift test 166/166 |
| A-5 | sidecar 重启丢弃已缓冲未补发的深链（S4·F2，RendererRecovery.swift:130） | reset 只复位就绪位、保留缓冲，下一 ready 帧 FIFO 补发 | swift test 166/166（新增 `testDeepLinkRelayResetKeepsUnsentBufferAcrossRestart`） |
| A-6 | 装配态仍接受 POC_* 环境覆盖（S5·F13 / S5·D3，AppDelegate.swift:68） | 打包 .app 忽略全部 `POC_*`；dev（swift run/非 .app）路径不变 | swift test 166/166 |
| A-7 | 退出清理未收回 keep-awake / 未清 Dock 角标（S3·D13 / S2·V5，AppDelegate.swift beginTerminationCleanup） | 退出清理起点显式清理，不经 A 桥 no-window 守卫（窗口可能已关） | swift test 166/166 |
| A-17 | 更新检查触发面：Swift 仅手动检查（S5·F3 / S5·U1 / S6·F2） | headless 控制器 `start()` 改为 15s 静默首检 + 6h 周期（常量与 updater.ts 同值并锁步单测），退出时 `stop()` 清表；ready 后按 Electron main.ts 同序启动 | update-headless 15/15（新增假定时器用例）；check:static 9/9 |
| A-18 | 唤醒后 transport 即时重探缺失（S3·D2） | sidecar 侧新增 `reconnectStaleTransports` 叶（判据逐字对齐 main.ts:679-697，复用 core `TransportManager.connect`），在 `__host.systemResume` 入站帧上双腿消费 | sidecar-stdio 16/16（含 systemResume e2e）；node-edges 24/24 |
| A-19 | 损坏 chamber-settings 的 notice 被静默丢弃（S2·F14） | `loaded.notice !== null` 即 loud（与 Electron 同路），读取异常同样 loud 回退默认值 | sidecar-stdio 16/16 |
| A-20 | stdout 重定向在 import 之后（S2·F8） | 抽出零依赖 `sidecar-console-redirect.ts` 并作为入口第一条 import（协议纪律变结构性），`safeStringify` 单源化 | sidecar-stdio 16/16（stdout 零污染行为证明） |
| A-9 | 窗口标题/品牌面仍带 POC 后缀（S3·V8 / S4·U5 / S5·U5 / S6·V6） | 标题冻结为 `dsh-chamber`，失败框/菜单同步；应用名与 bundle 显示名维持 Info.plist | swift test 170/170 |
| A-10 | 应用菜单面缩水、无托盘入口（S3·V4/V5、S4·U3/U4、S6·V3/V5、S5·U6） | App 菜单补 About/服务/隐藏/隐藏其他/显示全部；窗口菜单补缩放/前置全部窗口；新增 NSStatusItem「显示窗口/退出」 | swift test 170/170（菜单断言新增） |
| A-11 | 退出确认默认按钮相反（S3·V2），showMessage 忽略 defaultId/cancelId（S4·F5 / S2·F5） | 退出确认 Enter 命中「取消」（对齐 Electron defaultId/cancelId=1）；showMessage 按 defaultId→Enter、cancelId→Esc 映射 | swift test 170/170 |
| A-12 | 通知音效不同（S3·V7 / S2·V4 / S6·V10） | 用具名系统音效（缺省 Glass，对齐 electron-edges darwin）；新增纯函数 `notificationSoundName` | swift test 170/170（新增音效名/解码用例） |
| A-13 | SIGTERM/SIGINT 未接优雅退出（S3·D12 / S5·F10） | DispatchSourceSignal → NSApp.terminate，走完整退出链 | swift test 170/170 |
| A-14 | 缺 macOS 冷启动 argv 深链扫描（S4·F1） | 启动时按 scheme 扫 argv 并复用同一条深链缓冲；新增纯函数 `commandLineDeepLinks` | swift test 170/170（新增筛选用例） |
| A-15 | sidecar fatal 后应用与死桥长存（S2·F2） | 呈现致命提示后 `exit(1)`（对齐 Electron app.exit(1)） | swift test 170/170；test:macos 17/18（仅本机沙箱 DMG 用例受限） |
| A-16 | 媒体采集权限无门（S3·D11 / S4·F9，部分） | WKUIDelegate 显式拒绝摄像头/麦克风/屏幕共享；剪贴板与网页 Notification 的等价面仍缺（见条目正文） | swift test 170/170 |
| A-8 | 新测试门在开发者机误红：desktop 测试清单锁步扫描到 `packages/desktop/.dev-user-data`（dev 运行态里的他仓 worktree） | `test-runner-lockstep.test.mjs` 与 `verify-test-wiring.mjs` 忽略目录增加 `.dev-user-data` | `test:desktop` 复跑通过 |

## 3. 条目索引

### S1 · A 桥（Web ↔ Swift 注入面）

| # | 条目 | 状态 |
|---|---|---|
| F1 | surface 恒定义 vs preload「先 info 后 expose」：预就绪 invoke 全拒，渲染端「surface 缺失」重试链不适用 | 待裁决 |
| F2 | info 水化只 10 次/≈450ms 且失败后永不重试（preload 为 11 次/≈500ms） | 待裁决 |
| F3 | expectedOrigin=nil 的「就绪门」与「信任拒绝」同码，且 sidecar 重启会对运行中的页面回闸 | 待裁决 |
| F4 | 出站响应 >4MiB 时 pending 永不结算（渲染端 Promise 永久悬挂）；Electron 无上限 | 已消解 |
| F5 | 入站信封 >4MiB 被 frame_too_large 拒绝，Electron 无此上限 | 待裁决 |
| F6 | push 载荷经 JSON 规范化（Swift）vs 结构化克隆（Electron） | 待裁决 |
| F7 | 页面 world 的 __dshChamberResolve/__dshChamberEmit 可被壳文档内任意脚本调用伪造 | 待裁决 |
| F8 | 非壳环境（Safari/浏览器直开）shim 仍定义完整 surface，调用全 reject | 待裁决 |
| F9 | update.download/restartAndInstall 的宿主腿差异（Swift 恒拒绝，无自动安装） | 待裁决 |
| F10 | push 监听器抛错的可见性差异 | 待裁决 |
| V1 | 错误文案与错误对象形态不同（Swift 以「码即消息」/原始 sidecar 文案面世） | 待裁决 |
| V2 | open-in 文件管理器文案在适配器初始化时一次性捕获 platform，可能整会话退化 | 待裁决 |
| V3 | 连接页「dsh vX」与本地实例版本在 info 水化失败时不显示 | 待裁决 |
| D1 | 页面 world 伪造面（F7） | 待裁决 |
| D2 | 就绪窗口的 A 桥语义（F1/F3：拒绝 vs 排队 vs 延迟暴露） | 待裁决 |
| D3 | 4MiB 信封/帧上限（F4/F5） | 待裁决 |

### S2 · B 桥（Swift ↔ Node sidecar）与 sidecar 生命周期

| # | 条目 | 状态 |
|---|---|---|
| F1 | · 退出围栏的 code 字段在 Swift 全链丢失（app_quitting 只剩文案） | 待裁决 |
| F2 | · sidecar fatal / 重启耗尽后应用不退出（Electron 的 fatal = 进程终止） | 待裁决 |
| F3 | · sidecar 入站没有帧长上限（护栏单向） | 待裁决 |
| F4 | · 交互腿 600s 超时在两侧同一时刻到期（用户答案被丢弃） | 待裁决 |
| F5 | · showMessage 忽略 defaultId/cancelId/noLink（NSAlert 语义不等价） | 待裁决 |
| F6 | · keep-awake 在 Swift 额外禁用显示器休眠（Electron 只防系统休眠） | 已消解 |
| F7 | · 宿主腿结果回执缺失（setBadge 乐观成功 + 退役计数恒 0） | 待裁决 |
| F8 | · stdout 重定向在 import 之后（协议纪律非结构性） | 待裁决 |
| F9 | · ready 帧的 port 不被消费也不校验 | 待裁决 |
| F10 | · 两个「保留契约」成员的 Swift 语义与 Electron 不同（当前不可达） | 待裁决 |
| F11 | · 非崩溃退出也消耗 60s 退避配额 | 待裁决 |
| F12 | · 手工/损坏装配下 host 包缺失被降级为警告（构建侧是 fail-closed） | 待裁决 |
| F13 | · 退出清理串行（dispose → cp.stop），可能撞 4.5s 内部硬顶并留下子进程 | 待裁决 |
| F14 | · 损坏的 chamber-settings notice 被静默丢弃（注释声称 loud，代码不 loud） | 待裁决 |
| F15 | · sidecar 自身无内建 dsh workspace 回退解析（dev 态） | 待裁决 |
| F16 | · host 包源目录的 8 层向上启发式探测（当前值与 Electron 相同，风险型） | 待裁决 |
| V1 | · 非交互宿主腿 1s 有界等待，模态打开期间操作静默失败 | 待裁决 |
| V2 | · showError 用 runModal 阻塞主线程（整个 UI 冻结） | 待裁决 |
| V3 | · pickPluginSource 对话框文案/归属/过滤器与 Electron 不一致 | 待裁决 |
| V4 | · 原生通知无具名音效（Electron darwin Glass → 系统默认声） | 待裁决 |
| V5 | · 退出清理前不清 Dock 角标、不停 keep-awake（≤5s 瞬态） | 待裁决 |

### S3 · 宿主腿 A（通知/角标/keep-awake/登录项/唤醒/退出/窗口）

| # | 条目 | 状态 |
|---|---|---|
| D1 | 唤醒事件永不触发（NSWorkspace 通知中心错位） | 已消解 |
| D2 | 唤醒后 transport 即时重探缺失（design 14 D4 ② 未落实） | 待裁决 |
| D3 | keep-awake 语义过强：连带阻止显示器休眠 | 已消解 |
| D4 | sidecar 决策不可得时，关窗/退出方向与 Electron 相反（含 2s 超时面） | 待裁决 |
| D5 | 登录自启启动期 reconcile 缺失 | 待裁决 |
| D6 | 通知/Badge 的「已应用」回执缺失败与超时面 | 待裁决 |
| D9 | renderer unresponsive 恢复腿缺失 | 待裁决 |
| D10 | 通知满额（>16）淘汰语义不同：Swift 不清横幅、旧横幅点击无会话路由 | 待裁决 |
| D11 | 网页 Notification 双路径未处置（B10 已登记） | 待裁决 |
| D12 | SIGTERM/SIGINT 未转优雅退出（design 25 §3.3(5) 要求未落地） | 待裁决 |
| D13 | 退出清理缺 keep-awake 停止与徽标清零 | 已消解 |
| D14 | 宿主事实时效（实时查询 vs 事件缓存） | 待裁决 |
| V1 | 通知授权时机（权限流程） | 待裁决 |
| V2 | 退出确认默认按钮相反（Enter 键行为） | 待裁决 |
| V3 | 取消退出后的窗口恢复方式（状态与时序） | 待裁决 |
| V4 | 托盘/菜单栏入口缺失 | 待裁决 |
| V5 | 应用菜单面缩水（缺 Hide/Services/About/View 等） | 待裁决 |
| V6 | 对话框呈现模态与文案（showMessage/showError/pickPluginSource） | 待裁决 |
| V7 | 通知音效（可听差异） | 待裁决 |
| V8 | 窗口标题文案 | 待裁决 |
| V9 | 关窗决策引入异步延迟（窗口驻留 ≤2s） | 待裁决 |

### S4 · 宿主腿 B（深链/open-in/对话框/外部打开/剪贴板/托盘/菜单）

| # | 条目 | 状态 |
|---|---|---|
| F1 | Swift 缺 macOS 冷启动 argv 深链扫描（scanDeepLinkUrls 无对应） | 待裁决 |
| F2 | sidecar 重启时 DeepLinkRelay.reset() 丢弃已缓冲未发送的深链 | 已消解 |
| F3 | 深链/恢复入口无 quit 在途门（低） | 待裁决 |
| F4 | 直接二次启动：Swift 走 flock fatal 弹窗，Electron 走静默再激活 | 待裁决 |
| F5 | showMessage 忽略 defaultId/cancelId（Esc 归属未定） | 待裁决 |
| F6 | 原生 flavor 本地 open 执行面未对齐（STATUS:731-745 项现状） | 待裁决 |
| F7 | 页面驱动外链打开失败在 Swift 侧被吞掉（诊断面） | 待裁决 |
| F8 | 双 flavor 共存时 `dsh-chamber://` 归属（注册面差异） | 待裁决 |
| F9 | 剪贴板/网页权限模型：Electron 显式白名单 vs Swift 无权限处理 | 待裁决 |
| U1 | showMessage 确认框把 message 显示两遍（所有确认弹窗） | 已消解 |
| U2 | 插件源 picker 的标题/按钮文案与 Electron 不一致 | 待裁决 |
| U3 | Swift 无托盘（菜单栏图标与其「显示窗口/退出」入口缺失） | 待裁决 |
| U4 | 应用菜单项集与文案差异 | 待裁决 |
| U5 | 窗口标题文案不一致（且 Swift 未冻结标题） | 待裁决 |
| U6 | 外链打开冷却/预算拒绝无用户提示（两侧一致，登记为观察项） | 待裁决 |
| Q1 | 深链仅 argv 到达时是否必须补齐（F1） | 待裁决 |
| Q2 | sidecar 重启窗口的深链丢弃策略（F2） | 待裁决 |
| Q3 | 原生 flavor 本地 open 执行面（F6/STATUS:731-745） | 待裁决 |
| Q4 | showMessage 的 defaultId/cancelId 与 Esc 语义（F5） | 待裁决 |
| Q5 | 网页权限（剪贴板读/Notification 等）在 Swift 的口径（F9） | 待裁决 |
| Q6 | 双 flavor 共存时 `dsh-chamber://` 归属（F8） | 待裁决 |
| Q7 | 托盘与应用菜单补齐范围（U3/U4） | 待裁决 |

### S5 · 装配/生命周期/数据面（启动/端口/锁/userData/运行时/更新）

| # | 条目 | 状态 |
|---|---|---|
| F1 | 非法显式控制面端口：Electron 降级，Swift 致命退出 | 待裁决 |
| F2 | dev 端口候选耗尽：Electron 回退系统临时端口，Swift 致命退出 | 待裁决 |
| F3 | 更新检查触发面：Electron 静默首检 + 6h 周期；Swift 仅手动检查 | 待裁决 |
| F4 | 更新安装腿：Electron 可下载 + 退出安装 + 重启并安装；Swift blocked-available（设计有意） | 待裁决 |
| F5 | 退出安装豁免与关窗武装：Swift 恒不存在 | 待裁决 |
| F6 | launchAtLogin 启动 reconcile：Electron 每次启动重放，Swift 不重放 | 待裁决 |
| F7 | 渲染器卡死（unresponsive）：Electron 15s 后重载，Swift 无该腿 | 待裁决 |
| F8 | 进程级故障恢复方向相反（设计使然，但用户可感） | 待裁决 |
| F9 | 单实例/二次启动/argv 深链 | 待裁决 |
| F10 | SIGTERM/SIGINT 未接优雅退出（design 25 §3.3(5) 要求未实现） | 待裁决 |
| F11 | 目录锁获取时序晚于窗口构建与首载 | 待裁决 |
| F12 | dev 内建 dsh 工作区发现 | 待裁决 |
| F13 | POC_* 覆盖在打包（产品）路径仍生效 | 已消解 |
| F14 | 落盘设置文件的读取严格度差异（Swift 更严，方向 fail-closed） | 待裁决 |
| F16 | 崩溃诊断：Crashpad vs 无 | 待裁决 |
| F17 | dev 实根不同：双 flavor 目录锁在 dev 不互斥 | 待裁决 |
| F18 | pre-spawn 时间回退是 Swift 独有 | 待裁决 |
| F19 | 打包 web dist 缺失非 fail-closed | 待裁决 |
| F20 | Swift 布局锁步锚点不全（host 包目录 / pnpm 路径） | 待裁决 |
| U1 | = F3（无静默/周期更新检查） | 待裁决 |
| U2 | = F4（更新只读不装） | 待裁决 |
| U3 | = F7（卡死无自愈、无提示） | 待裁决 |
| U4 | 首载失败没有错误面 | 待裁决 |
| U5 | 文案/Branding 差异（POC 后缀） | 待裁决 |
| U6 | 无托盘入口（Dock 常驻替代） | 待裁决 |
| U7 | 退出确认与关闭隐藏的语义等价但细节不同（无差异项，记录核对结论） | 待裁决 |
| U8 | = F10/F6 的可见面 | 待裁决 |

### S6 · 前端可见面（flavor 传播与非像素用户可见差异）

| # | 条目 | 状态 |
|---|---|---|
| F1 | · Swift flavor 缺失「下载 → 已下载 → 重启并安装 / 退出时安装」整条应用内更新链 | 待裁决 |
| F2 | · Swift flavor 无启动后 15s 与每 6h 的周期检查（“新版本可用”只在手动检查后出现） | 待裁决 |
| V2 | · 原生通知授权弹窗时机：Swift 首启即弹，Electron 延后到首次通知 | 待裁决 |
| V3 | · 应用菜单/快捷键面缺失（View/App 标准项） | 待裁决 |
| V4 | · 无开发者工具/检查器入口 | 待裁决 |
| V5 | · 托盘/菜单栏入口缺失（关窗隐藏后只有 Dock 恢复） | 待裁决 |
| V6 | · 应用名/窗口标题/错误框仍带 POC / "-native"字样 | 待裁决 |
| V7 | · Swift 连接设置页常驻「凭据以 0600 明文存储」提示 | 待裁决 |
| V8 | · A 桥「documentStart 预定义 + ready 前拒绝」与渲染端重试模型的错配 | 待裁决 |
| V9 | · 英文 blocked 文案与中文/稳定通道不一致（共享 UI 文案小瑕） | 待裁决 |
| V10 | · 通知声音不同（已登记） | 待裁决 |
| V11 | · 隐藏窗口的定时器节流（C1） | 待裁决 |
| V12 | · 右键上下文菜单（Swift 侧为平台默认，仓内仅证未覆写） | 待裁决 |

## 4. 逐项明细（按分片）

> 每项为该分片审计的原始结论：差异、证据（文件:行号）、选项；**已消解**项在标题下已标注，
> 其余为待裁决项（选项由报告给出或由本次核对补足）。像素/样式差异只计数，不列条目。

## S1 · A 桥（Web ↔ Swift 注入面）

来源分片：`s1-a-bridge.md.md`（六路只读审计的过程产物，未随仓库提交；以下为该分片"功能级差异"起至结尾的逐项结论，含证据与选项）

## 功能级差异（逐项）

### F1. surface 恒定义 vs preload「先 info 后 expose」：预就绪 invoke 全拒，渲染端「surface 缺失」重试链不适用
- Electron 行为：window.dshChamber 只在 info invoke 成功后才定义（preload.cts:905-922 then 分支）；失败兜底分支才带 null 标量（preload.cts:923-939）。任何 invoke 成功即证明 sender 门已开，后续不会再吃 sender 拒绝。
- Swift 行为：shim 在 documentStart 就定义完整面（bridge-shim.poc.js:112、530-544、594-599），info 只是事后水化（:568-581）；ready 帧前 expectedOrigin() 返回 nil（MainWindowController.swift:139-142）→ MessageHandler.fence 一律回 ipc_sender_forbidden（MessageHandler.swift:187-190）。
- 触发条件：壳文档在 ready 帧被主线程消费之前执行（冷启动窗口；MainWindowController.swift:780-781 自注 sidecar 就绪需 1~2s），或 sidecar 崩溃重启窗口（AppDelegate.swift:295-302 主动 noteSidecarReady(false)）。
- 用户可感后果：design 25 §4.4.1 与 BridgeShimInjector.swift:6-8 假设的「渲染端按 surface 缺失 + 10×50ms 重试自愈」不成立——重试链只在 surface 为 null 时触发（bridge-hydration.ts:163-177）。settings 有慢探测可自愈（settings-store.ts:100-103），runtime 有 20×100ms（runtime-management.ts:669-670,716-722），open-in 有 3×500ms 且失败后 memoize（coordinator.ts:91-113），但 update 没有：一次 update.state() 被拒即 latch 成 unhydrated 且不再重试（bridge-hydration.ts:123-133 slowReProbe=false 直接 return；update-store.ts:73-77）。
- 能否在仓库内消解：能。
- 具体解法：(a) packages/dsh-chamber-client-ui-settings-bridge/src/client/update-store.ts:76 把 slowReProbe 改 true（与 settings 同骨架；Electron 侧只是多一条有界慢探测）；(b) MainWindowController.noteSidecarReady(true)（:712-714）追加一次 evaluateJavaScript 触发 shim 重水化（需 shim 暴露内部 kick，bridge-shim.poc.js:546-581 附近）；(c) 恢复 preload 语义：shim 在首个 info 成功前不定义 dshChamber（把 :594 的 defineWindowGlobal 挪进 fetchInfo 的 then）。
- 风险：(a) 改动共享渲染端代码（有 settings 先例、回归面小）；(c) 回到方案①，与 design 25 D1 定案相反，需同步修订文档与 BridgeShimInjector 注释。
- 是否需产品裁决：否（实现漏洞级）；若取 (c) 需与 design 25 §4.4.1 D1 同步（升级为 D2）。

### F2. info 水化只 10 次/≈450ms 且失败后永不重试（preload 为 11 次/≈500ms）
- Electron 行为：requestAppInfo 初始 1 次 + 最多 10 次重试（preload.cts:885-903，attempts < INFO_MAX_ATTEMPTS），失败后仍 expose（标量 null + console.error，:923-939）。
- Swift 行为：fetchInfo(10) 是 10 次总尝试（bridge-shim.poc.js:117-118,568-581：attemptsLeft>1 才重试），失败只 console.warn，标量保持 null（:578），此后无任何再水化路径（push 通道不含标量）。
- 触发条件：ready 门持续 >≈450ms（冷启动、sidecar 慢启动、主线程繁忙延迟 ready 消费）。
- 用户可感后果：platform/dshVersion/version/controlPlaneUrl 整会话 null：open-in 文件管理器文案在适配器初始化时一次性捕获（packages/dsh-chamber-client-ui-open-in/src/client/index.ts:111 → shared/coordinator.ts:136-138 → OpenInButton.tsx:187-192），非 darwin/win32 退化为通用「文件管理器」；连接页「dsh vX」不显示（packages/dsh-chamber-client-ui-settings-connections/src/client/ConnectionsSection.tsx:1437-1482）；本地实例 hostFacts 无 dshVersion（packages/renderer/src/App.tsx:3497-3502）。
- 能否在仓库内消解：能。
- 具体解法：fetchInfo 改为有界慢重试直到成功（如 50ms×10 后 500ms 退避、上限 2s，成功即停）或对齐 preload 的 11 次；更稳的是 ready 后由 MainWindowController.noteSidecarReady 主动 kick。改 bridge-shim.poc.js:568-581 + MainWindowController.swift:712-714。
- 风险：慢重试保留长期 pending 请求；kick 需新增 shim 内部函数（不改对外面）。
- 是否需产品裁决：否。

### F3. expectedOrigin=nil 的「就绪门」与「信任拒绝」同码，且 sidecar 重启会对运行中的页面回闸
- Electron 行为：ipc_sender_forbidden 只在真违规时出现（不可信 sender/frame/非壳文档，renderer-trust.ts:106-110）；主进程生命周期内不存在「整体 IPC 面回闸」状态（dsh runtime 重启不重启 Electron main）。
- Swift 行为：expectedOrigin() 在 ready 前为 nil（MainWindowController.swift:139-142），所有 invoke 回 ipc_sender_forbidden；sidecar 重启排期时主动 noteSidecarReady(false)（AppDelegate.swift:295-302），已水化、正在使用的页面会再次进入全员拒绝态直到新 ready 帧。
- 触发条件：(a) 冷启动就绪窗口内任何 invoke；(b) sidecar 崩溃重启窗口内用户点击的任何操作（连接、设置、通知 ack、深链 ack 等）。
- 用户可感后果：正常启动/重启被呈现为「IPC sender forbidden」信任错误；(b) 期间用户操作失败且文案误导；latch 型消费者（F1）可能被永久留在未水化态。
- 能否在仓库内消解：能（区分状态码）。
- 具体解法：MessageHandler.swift:226 增 codeBridgeNotReady（如 bridge_not_ready）并让 fence:187-190 用该码（真正 origin 不符仍回 ipc_sender_forbidden）；Swift 侧重启窗口保持拒绝（安全设计），渲染端对 bridge_not_ready 走重试而非信任异常分支。
- 风险：新增错误码是跨语言契约（既有重试/错误面可吸收）。
- 是否需产品裁决：是（选项见 D2）。

### F4. 出站响应 >4MiB 时 pending 永不结算（渲染端 Promise 永久悬挂）；Electron 无上限

> 状态：**已消解**（本次核对后已改代码并跑门禁，见 §2 对照表）。
- Electron 行为：invoke 响应经结构化克隆，无尺寸上限（preload.cts 无长度判定）。
- Swift 行为：BridgeClient.handleIncomingLine 对超长行只 loud 记录并 return（BridgeClient.swift:580-584），pending 不清理、continuation 不 resume；FrameCodec.maxFrameBytes=4MiB（FrameCodec.swift:54），sidecar 一帧一行（sidecar-entry.ts:176-178）。
- 触发条件：任一通道单次响应 JSON >4MiB（如 desktop_ssh_logs 大日志数组、plugin_list/local_plugin_list 大清单）。
- 用户可感后果：该 invoke 的 Promise 永不 settle（shim 无超时，bridge-shim.poc.js:186-207），UI 永久 in-flight；Electron 下能正常返回。
- 能否在仓库内消解：能。
- 具体解法：BridgeClient.swift:581-584 超长行分支改为按会话 failAllPending(reason:) 或按可解析 id 单独 resume throw；或提高 B 桥帧上限（与 design 25 §4.4.2 帧长上限一并修订）。
- 风险：提高上限放大单帧内存；failAllPending 会连带作废其他在飞请求（按 id 更精确）。
- 是否需产品裁决：否（阈值见 D3）。

### F5. 入站信封 >4MiB 被 frame_too_large 拒绝，Electron 无此上限
- Electron 行为：ipcRenderer.invoke 实参结构化克隆，主进程不做尺寸/可序列化判定。
- Swift 行为：MessageHandler.fence 先 JSON 规范化再按 UTF-8 字节数判 ≤4MiB（MessageHandler.swift:200-205；TrustGuard.swift:32,132-134），超限回 frame_too_large。
- 触发条件：超大 desktop_ssh_instances_set 数组或 save_connection 输入、极大 plugin_apply 清单。
- 用户可感后果：Electron 可完成的批量操作在 Swift 直接失败（frame_too_large）。
- 能否在仓库内消解：能（调阈值/文档化）。
- 具体解法：需要则提高 TrustGuard.maxMessageBytes（现与 FrameCodec 同为 4MiB）；否则在 design 25 §4.4.1 明示有意收紧并给量级边界。
- 风险：提高上限削弱「受信页面也不能用超大信封打爆 Swift 序列化」的护栏（深度 512 护栏 MessageHandler.swift:282-290 仍独立成立）。
- 是否需产品裁决：是（阈值，D3）。

### F6. push 载荷经 JSON 规范化（Swift）vs 结构化克隆（Electron）
- Electron 行为：electron-edges.rendererPush 直接 webContents.send(channel, payload)（electron-edges.ts:138-142），undefined 值键、NaN/±Infinity、Date 等按结构化克隆语义保留。
- Swift 行为：node-edges.rendererPush 先 jsonSafe(payload)（node-edges.ts:150-158,215）→ NDJSON → AnyCodable → MainWindowController.jsonLiteral（MainWindowController.swift:464-476,584-590）：undefined 键丢弃、NaN/±Infinity 变 null、非 JSON 值退化。
- 触发条件：任一 push 载荷含 undefined 值键或非有限数（当前 8 通道 core 载荷均 JSON 安全，未观察到）。
- 用户可感后果：页面拿到的对象键集/数值可能不同（渲染端若用 hasOwnProperty / Number.isFinite 分支）。
- 能否在仓库内消解：能（无需改动，或写成显式契约）。
- 具体解法：design 25 §4.4.1 把 JSON-safe 载荷写成契约；或 node-edges.ts:150-158 对非 JSON 值 loud 报错而非静默 jsonSafe。
- 风险：loud 化可能让既有载荷意外炸出（需先审计 8 通道生产点）。
- 是否需产品裁决：否（低危）。

### F7. 页面 world 的 __dshChamberResolve/__dshChamberEmit 可被壳文档内任意脚本调用伪造
- Electron 行为：contextBridge.exposeInMainWorld 只暴露白名单 API（preload.cts:907-921），ipcRenderer 与响应关联在隔离 world，页面脚本无法伪造 invoke 结果或 push。
- Swift 行为：shim 在 .page world 定义 window.dshChamber + __dshChamberResolve + __dshChamberEmit（bridge-shim.poc.js:585-596；BridgeShimInjector.swift:35-37 无 world 参数 = page world）。非可配置只防覆盖、不防调用；任意页面脚本可 __dshChamberResolve(id, 任意值, null) 伪造在飞 invoke 返回值、或 __dshChamberEmit 伪造推送，在渲染层伪造设置/更新/运行时状态。
- 触发条件：壳文档内任意第三方/注入脚本（或前端 bundle 被 XSS）。
- 用户可感后果：渲染层信任被降级（Electron 无该面）；Swift 侧护栏（origin/白名单/尺寸）不受影响，故只影响渲染层状态展示与后续动作输入。
- 能否在仓库内消解：部分（完全等价需隔离 world + 双向消息协议，架构级）。
- 具体解法：(a) 接受为 POC 风险并登记（shim:100-103 已承认）；(b) per-subscription 随机 token 私有回调（提升伪造成本，不能根除）；(c) M2 评估 .defaultClient world + 页面侧纯 postMessage 面（需重验 resolve/emit 可达性与 hydration，BridgeShimInjector.swift:28-34 已注明）。
- 风险：(c) 改动大且与「shim 与页面同 context」现状冲突；(b) 复杂度收益比低。
- 是否需产品裁决：是（D1）。

### F8. 非壳环境（Safari/浏览器直开）shim 仍定义完整 surface，调用全 reject
- Electron 行为：无 preload → window.dshChamber 为 undefined，渲染端可选链守卫得到「桥不存在」。
- Swift 行为：shim 无论是否在 WKWebView 内都定义面（bridge-shim.poc.js:112,594-599），仅把每次 invoke reject 为 no-native-bridge（:164-182）。于是 openInBridgeReady() 返回 true（coordinator.ts:117-119）而 apps() 必失败；runtimeBlocksLocalStart(state, surfacePresent=true) 在 state null 时 fail-closed 阻断本地启动（runtime-management.ts:776-784）；badge 兜底 effect 认为桥已存在（App.tsx:3731-3743）。
- 触发条件：页面在非 WKWebView 外壳中打开（Safari 对照/调试），或 messageHandlers 尚未注册。
- 用户可感后果：原本「无桥→优雅降级」的路径变成「有桥但全失败」，与 Electron 不一致（Safari 对照排障尤甚）。
- 能否在仓库内消解：能。
- 具体解法：bridge-shim.poc.js:585-592 之前检测 window.webkit 与 messageHandlers.dshChamber 不存在时不定义 dshChamber（仅 warn 一次）。
- 风险：handler 注册若晚于 documentStart 会误判无桥（当前不会：MainWindowController.swift:154 在构造 configuration 时注册，先于导航），需真机验证。
- 是否需产品裁决：否。

### F9. update.download/restartAndInstall 的宿主腿差异（Swift 恒拒绝，无自动安装）
- Electron 行为：dsh-chamber:update-download 真下载（autoDownload=false + 用户确认），update-restart 走 electron-updater quitAndInstall（preload.cts:373-395 注、shell-core.ts:3797-3799）。
- Swift 行为：sidecar headless 更新控制器真实 check（GitHub releases 列表 API）但 installBlockedReason 恒为「原生壳不支持自动安装」（update-headless.ts:39,130），download/restartAndInstall 核心层显式拒绝（update-headless.ts:52,54,225-233）→ A 桥如实 resolve {ok:false,error}。
- 触发条件：设置「更新」区点「更新」/「重启并安装」。
- 用户可感后果：Swift 壳只能提示手动下载，无自动更新/安装；check 与 openReleasePage 仍可用。
- 能否在仓库内消解：否（需原生安装腿）。
- 具体解法：已由 design 25 §7/W-22 裁决为 v1 blocked-available；自动安装需新增 Swift 安装腿 + 签名/公证链（M4+）。
- 风险：—。
- 是否需产品裁决：已裁决（design 25 §7）。

### F10. push 监听器抛错的可见性差异
- Electron 行为：preload 各 on* listener 直接 callback(payload)（preload.cts:659,665-683,705,723,735,832-859），回调抛错沿 ipcRenderer 事件派发冒泡成页面未捕获异常。
- Swift 行为：emitToListeners 逐个 try/catch，抛错只 console.error 并继续派发（bridge-shim.poc.js:236-244）。
- 触发条件：任一订阅回调抛错。
- 用户可感后果：Swift 下错误不再冒泡到 window.onerror（POC_DEBUG 的 pocConsole 只转发 console.*，MainWindowController.swift:163-188），异常更隐性；单个坏监听器不会中断同事件其余监听器（Electron 会）。
- 能否在仓库内消解：能（现状更稳，属有意改进）。
- 具体解法：若要求逐字对齐可去掉 try/catch；否则在 design 25 登记为有意差异。
- 风险：去掉后一个坏监听器可吞掉同事件后续派发。
- 是否需产品裁决：否（建议保留并文档化）。

### F11（备注，不计入功能级计数）. 未知方法/未注册通道拒绝文案不同 + save_connection 凭据跨 B 桥
- 未注册通道：Electron 由框架拒绝；Swift manifest 内未注册 → sidecar-unknown-channel（sidecar-entry.ts:307-313），manifest 外 → method_not_allowed（MessageHandler.swift:206-208）。渲染端不可达，不构成可见差异。
- save_connection 的 credentials 在 Swift flavor 会经 A 桥（web→Swift postMessage）与 B 桥（Swift→sidecar NDJSON）两段进程边界；Electron 全程留在 main 进程（preload.cts:628 / shell-core 注册体）。两者都不落盘、不进日志（BridgeClient 只打印 method 名，POC_DEBUG 下 MainWindowController.swift:445-447），但 Swift 面多一条本机管道暴露面，建议在 design 25 §4.4.2 显式登记。

## 前端可见差异（逐项，非像素）

### V1. 错误文案与错误对象形态不同（Swift 以「码即消息」/原始 sidecar 文案面世）
- Electron：ipc_sender_forbidden → Error(forbidden IPC sender)（带 .code）；app_quitting → Error(app is quitting)（带 .code）（renderer-trust.ts:106-115）。
- Swift：MessageHandler.reject 把码字符串直接作为 JS 错误消息（MessageHandler.swift:226-238 + shim:216-220 → new Error(ipc_sender_forbidden) / new Error(app_quitting)）；sidecar 业务失败经 NSError.localizedDescription 上抛（BridgeClient.swift:870-878）→ MainWindowController 原样 JSON 化（:453-458）→ new Error(sidecar 文案)。
- 触发条件：任何失败 invoke，尤其 F1/F3 的正常启动/重启窗口。
- 用户可感后果：设置保存失败、连接失败等以机器码/原始文案呈现（渲染端多处直接把 error 字符串显示/上报，如 settings-store 失败补丁路径），与 Electron 文案不一致。
- 能否在仓库内消解：能。
- 具体解法：MainWindowController.handleInvoke 的 catch（:453-458）按已知码映射为 Electron 同文案；映射表与 renderer-trust.ts 单一来源对齐（可加跨语言锁步测试）。
- 风险：码→文案映射表需维护。
- 是否需产品裁决：否。

### V2. open-in 文件管理器文案在适配器初始化时一次性捕获 platform，可能整会话退化
- Electron：platform 在 expose 时已填好（preload.cts:911），适配器初始化读到 darwin（index.ts:111）→ Finder 文案。
- Swift：platform 由 info 水化（F2），初始化早于水化则 null → adapter.platform=null（source-adapter.ts:153）→ OpenInButton.finderLabel 落到通用「文件管理器」（OpenInButton.tsx:187-192），adapter 构造后不再重读（index.ts:111 在插件装配时求值一次）。
- 触发条件：open-in 客户端插件装配早于 info 水化成功（host-graph 在 kernel 启动前 preload 额外 entry，packages/renderer/src/host-graph.ts:520 注；窗口即 F1/F2 的 ≤450ms）。
- 用户可感后果：macOS 上「在 Finder 中显示」退化为通用文案，整会话不恢复（除插件重载/刷新）。
- 能否在仓库内消解：能。
- 具体解法：platform 改为渲染期读取（bridgePlatform() 已是 window 读取，coordinator.ts:136-138），或 shim 水化 info 后广播一次刷新。
- 风险：改动 open-in 客户端 props 面（有测试基座）。
- 是否需产品裁决：否。

### V3. 连接页「dsh vX」与本地实例版本在 info 水化失败时不显示
- Electron：dshVersion 在 expose 时已存在（preload.cts:910），直接渲染（ConnectionsSection.tsx:1482）。
- Swift：dshVersion 由 info 水化（F2），失败则整会话 null → span 不渲染（ConnectionsSection.tsx:1482），App.tsx:3497-3502 也不为本地实例写 dshVersion。
- 触发条件：同 F2（ready 门 >≈450ms）。
- 用户可感后果：版本信息缺失（信息性文案，非阻断）。
- 能否在仓库内消解：能（同 F2）。
- 风险：—。
- 是否需产品裁决：否。

## 待裁决候选

### D1. 页面 world 伪造面（F7）
- 选项 A：接受为已文档化风险（design 25 §4.4.1 注记 + POC 期声明），M2/M3 再评估隔离 world；成本 0，风险=渲染层伪造面保留。
- 选项 B：per-subscription token/私有回调协议（提升成本，不能根除），或评估 .defaultClient world + 页面侧纯 postMessage 面（架构级，需重验注入可达性与 hydration）。
- 建议：A + 在 STATUS/design 登记为开放风险。

### D2. 就绪窗口的 A 桥语义（F1/F3：拒绝 vs 排队 vs 延迟暴露）
- 选项 A：保留「documentStart 预定义 + ready 前一律拒绝」（design 25 D1 方案②现状），只修消费者：update-store slowReProbe=true + shim info 慢重试 + ready 后 kick。
- 选项 B：回到 preload 语义「成功水化后再暴露」（方案①）：ready 前 window.dshChamber 缺失，ready 后由 Swift evaluateJavaScript 触发 shim 暴露；渲染端既有 surface-缺失重试链原样生效，Electron/Swift 行为逐字一致，但需修订 design 25 §4.4.1 与 BridgeShimInjector 注释，并处理 ready 前使用 bridge 的渲染端路径（badge/notifications 已有重试链）。
- 建议：A（改动最小、保留已定案），B 作为 M2 候选。

### D3. 4MiB 信封/帧上限（F4/F5）
- 选项 A：维持 4MiB 双门（A 桥入站 + B 桥帧），补「超长出站帧必须结算 pending」的失败路径，并在 design 25 明示为有意收紧。
- 选项 B：提高 B 桥/A 桥上限（如 16MiB）或按通道差异化（如 logs），贴近 Electron 无上限的实际可用性。
- 建议：A + F4 的结算修复（挂起比拒绝更糟）。

## 纯像素或纯样式差异计数
0 项（A 桥为纯逻辑/协议面，未发现任何仅像素或纯样式差异）。

## 备注：文档漂移（不计入差异清单）
1. bridge-shim.poc.js:63-75 头部注记称「update.restartAndInstall：Swift flavor 无 updater 宿主（sidecar ctx updateController 为 loud stub）→ invoke 错误如实上抛（W-22 flavor 接 v1 blocked-available）」与 runtime「Swift flavor 装配面落地前错误如实上抛」——与 sidecar-ctx.ts:2654-2670（真实 createHeadlessUpdateController，W-22 已真化）及 runtime 注册体事实不符；实际行为是 resolve {ok:false,error} 的 blocked-available 信封。
2. BridgeShimInjector.swift:6-8 称渲染端按「surface 缺失 + 10×50ms 有界重试」自愈——见 F1，该机制对 pre-ready invoke 拒绝不适用。
3. packages/desktop/preload.cts:692 注释仍写 onStateChanged（实际方法名 onChanged，preload.cts:703）——仅注释，无别名残留。W-04 别名检查结论：shim 内零残留（bridge-shim-surface.test.ts:170-190 断言 no-extra；全仓 onStateChanged 只出现在注释与镜像测试说明中）。

---

## S2 · B 桥（Swift ↔ Node sidecar）与 sidecar 生命周期

来源分片：`s2-b-bridge.md.md`（六路只读审计的过程产物，未随仓库提交；以下为该分片"功能级差异"起至结尾的逐项结论，含证据与选项）

## 功能级差异（逐项：Electron 行为 / Swift 行为 / 触发条件 / 用户可感后果 / 能否仓库内消解 + 具体解法 / 风险 / 是否需产品裁决）

### F1 · 退出围栏的 code 字段在 Swift 全链丢失（app_quitting 只剩文案）
- Electron：trustedIpc 抛 `Error('app is quitting')` 且 `error.code='app_quitting'`（renderer-trust.ts:111-115）；sidecar 侧同码同文案（node-edges.ts:97-100，QUIT_INBOUND_ERROR）。
- Swift：sidecar-entry 写出 `{id,ok:false,error,code}`（sidecar-entry.ts:270-277），但 FrameCodec 的信封没有 code 成员（FrameCodec.swift:61-68），BridgeClient 只把 error 折成 NSError.message（BridgeClient.swift:861-879），controller 只回传 localizedDescription（MainWindowController.swift:456），shim 再 `new Error(String(err))`（bridge-shim.poc.js:216-217）。
- 触发条件：退出清理已开始（SIGTERM/关闭）后渲染器仍发起 invoke。
- 用户可感后果：前端只能按文案字符串判别；任何按 code 分支的 UI（区分「正在退出」与一般失败、决定是否重试）在 Swift flavor 失效或降级为文案匹配。当前 shim 两侧都只传 message，故实际可见影响=文案差异（Electron 侧 invoke 拒绝文案带通道前缀），不是本次最严重项，但契约字段确已丢失。
- 仓库内消解：可以。FrameCodec.Envelope 增 `code: String?`，BridgeFrame.response 增 code；BridgeClient.deliverResponse 把 code 放进 NSError.userInfo；MainWindowController.handleInvoke 把 `{message, code}` JSON 化传给 shim；shim resolveInvocation 在 err 为对象时挂 `error.code`。同步补 FrameCodecTests 与 bridge-shim-surface 锁步。
- 风险：低（协议增量、两侧同提交改）。需产品裁决：否。

### F2 · sidecar fatal / 重启耗尽后应用不退出（Electron 的 fatal = 进程终止）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- Electron：主进程 uncaughtException/unhandledRejection = `fatalMainError → app.exit(1)`（main.ts:246-266）；没有「宿主崩溃后继续运行」的形态。
- Swift：sidecar 非零退出（1）→ Supervisor 500ms/60s 窗口 ≤3 次退避重启（SidecarSupervisor.swift:435-449）；耗尽或 exit 3/70 → `markFatal`（:416-426、:436-437、:468-474）→ AppDelegate 只弹 NSAlert（AppDelegate.swift:610-622，非阻塞 sheet），应用与窗口继续存活，bridge 未运行。
- 触发条件：sidecar 60s 内 4 次崩溃；或运行期控制面启动失败（exit 70）/锁冲突（exit 3）。
- 用户可感后果：窗口留在屏幕上但所有 invoke 立即失败（BridgeClient code 2「未在运行」，MainWindowController.swift:444-460 回错误），用户得不到明确「应用已失效」的终态，只能自行退出；Electron 同场景应用直接终止。
- 契约注记：design 25 §3.3(4) 本身规定「cp.start 失败 = fatal 退出；运行中崩溃 = 退避重启」与「Supervisor 据码分流 NSAlert 文案」，并未要求运行期 fatal 后退出应用——本项是**契约未覆盖处的双 flavor 行为差**，不是实现违背契约。
- 仓库内消解：可以。Option A（保留现状）在 fatal 后提供「退出应用/重试」按钮并禁用页面交互；Option B 与 Electron 对齐：fatal 提示后 `NSApp.terminate(nil)`（走确认链）。另：若产品要求可用性，可对 exit 70 做有限重试而非立即 fatal。
- 风险：B 会改变「崩溃后还能看日志/导出」的现状；A 需补交互门。需产品裁决：**是**（见 D1）。

### F3 · sidecar 入站没有帧长上限（护栏单向）
- Electron：无 B 桥对端；协议纪律只约束 stdout 方向。
- Swift：入站（Swift→sidecar）受 4MiB 限制（FrameCodec.swift:54、110-112；BridgeClient.swift:581-584），但 sidecar-entry 的 readline 对每行无长度门（sidecar-entry.ts:562-568），JSON.parse 直接吃整行；出站方向 Swift 只对超长行打印丢弃（BridgeClient.swift:581-597），无反向约束。
- 触发条件：Swift 壳回归/被篡改后发送 >4MiB 行；或 sidecar 被其它写端注入超长行。
- 用户可感后果：受信通道内的内存无界增长（sidecar 进程 OOM 崩溃 → 触发 F2 的重启/fatal 链）。正常产品路径不可达（Swift 只有 encode 后的 ≤4MiB 帧）。
- 仓库内消解：可以。sidecar-entry 在 rl.on('line') 前加字节长度检查（>4MiB 直接 stderr + 丢弃/断连），并导出常量与 Swift 的 maxFrameBytes 做跨语言锁步（CrossLanguageLockstepTests）。
- 风险：低（需与 FrameCodec 常量同源，避免两侧调值漂移）。需产品裁决：否。

### F4 · 交互腿 600s 超时在两侧同一时刻到期（用户答案被丢弃）
- Electron：对话框与 handler 在同一进程，无跨进程超时，结果必定回传（electron-edges.ts:338-343）。
- Swift：node 侧从发出 edge 起 600s（sidecar-entry.ts:186-197），Swift 侧从**收到 edge 起** 600s（SwiftEdgeHostLegs.swift:542-561）；Swift 起点更晚 → node 先超时 reject（"host edge 应答超时（600000ms）"），随后用户的模态答案到达时 sidecar 只记一条「迟到的 edge 应答」（sidecar-entry.ts:284-287），操作失败。
- 触发条件：用户在 NSOpenPanel/NSAlert 上停留超过 10 分钟（大目录浏览、开会挂起）。
- 用户可感后果：用户点下「选择/确认」后返回失败（或插件导入被取消），操作结果被静默丢弃；Electron 无此问题。
- 仓库内消解：可以。① node 侧交互腿不设超时（靠 Swift 腿必有界应答）；或 ② 把 node 侧交互上限抬到 Swift 上限 + 缓冲（如 610s）并在 CrossLanguageLockstepTests 断言 `nodeTimeout > swiftTimeout`。
- 风险：① 若 Swift 腿真的挂起（main-thread-busy 分支已覆盖超时），node 侧无线会悬挂；② 只把竞态窗口推后。需产品裁决：**是**（见 D4）。

### F5 · showMessage 忽略 defaultId/cancelId/noLink（NSAlert 语义不等价）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- Electron：`dialog.showMessageBox(win, opts)` 原样使用 type/title/message/detail/buttons/defaultId/cancelId/noLink（electron-edges.ts:338-343）。
- Swift：showMessageBody 只读 type/title/message/detail/buttons，忽略 defaultId/cancelId/noLink（SwiftEdgeHostLegs.swift:565-600），按钮序按添加顺序，返回值 = 原始 raw-1000 夹紧（:597-599）。
- 触发条件：任何需要 defaultId/cancelId 语义的对话框，尤其用户按 Esc/关闭框时。
- 用户可感后果：当前三处调用（shell-core.ts:2850-2857、3900-3907、sidecar-ctx.ts:2539-2546）都取 buttons[0]='取消'、defaultId=0、cancelId=0，因此现状无害；但这是**巧合而非契约**——一旦新增「确认按钮在 0 号位」的对话框，关闭对话框会被读成确认，属高危复制路径。
- 仓库内消解：可以。showMessageBody 显式处理 defaultId/cancelId（NSAlert 的 firstButton 默认可控；给 cancelId 对应按钮设 `keyEquivalent = "\\u{1b}"`，返回 index 时映射 cancelId），并在 HostMessageOptions 注释里声明 noLink 的 mac 等价（无）。
- 风险：低（改的是边缘 UI 语义，需 SwiftEdgeHostLegsTests 补两条用例）。需产品裁决：否（但建议登记为必修）。

### F6 · keep-awake 在 Swift 额外禁用显示器休眠（Electron 只防系统休眠）

> 状态：**已消解**（本次核对后已改代码并跑门禁，见 §2 对照表）。
- Electron：`powerSaveBlocker.start('prevent-app-suspension')`（main.ts:612-626）——防系统睡眠，允许显示器休眠。
- Swift：`ProcessInfo.beginActivity(options: [.idleDisplaySleepDisabled, .idleSystemSleepDisabled])`（SwiftEdgeHostLegs.swift:140-150）——**同时禁止显示器休眠**。
- 触发条件：chamber-settings 的 keepAwake 开启（启动期 reconcile AppDelegate.swift:326-328，或设置面 SETTINGS_SET）。
- 用户可感后果：开启 keep-awake 后屏幕不再自动熄灭（耗电、烧屏、夜间扰人），与 Electron 版同一设置的可见行为不同。
- 仓库内消解：可以。去掉 `.idleDisplaySleepDisabled`，只保留 `.idleSystemSleepDisabled`（对齐 prevent-app-suspension）。
- 风险：低；若原意就是要「保持屏幕可见」（例如长时间监控），则应反向统一 Electron。需产品裁决：**是**（见 D3）。

### F7 · 宿主腿结果回执缺失（setBadge 乐观成功 + 退役计数恒 0）
- Electron：`setBadge` 返回真实 `{applied:true}|{applied:false,reason}`（electron-edges.ts:212-219）；`retireNotificationsForSources` 返回实际关闭的横幅数（electron-edges.ts:291-300）。
- Swift：`setBadge` 同步契约无法跨进程，node-edges 发 notify 后恒回 `{applied:true}`（node-edges.ts:274-279），dock 写失败只在 Swift 侧 loud（SwiftEdgeHostLegs.swift:305-312 注释自证）；`retireNotificationsForSources` 恒返回 0（node-edges.ts:328-340，注释声明调用方丢弃）。
- 触发条件：NSApp.dockTile 写失败（mac 正常不可见）/ 通知退役路径被调用。
- 用户可感后果：core 记「已应用」而 dock 实际未变（角标与未读数不符，直到下一次推送纠正）；退役返回值无消费方，当前无可见后果。
- 仓库内消解：可以。setBadge 改为 edge（异步 await 应答）或 notify+ACK 回执后 invalidate；retire 走 edge 取回真实条数。
- 风险：中（把 fire-and-forget 改 ACK 会触碰退出时序；退役计数在 mac 上本就不可能等于「关闭的原生通知数」语义，可改为返回登记表驱逐数并注明语义）。需产品裁决：否。

### F8 · stdout 重定向在 import 之后（协议纪律非结构性）

> 状态：**已消解**（本次功能对齐批次：sidecar 宿主路径补齐）。
- Electron：无 B 桥；console 去向不与协议冲突。
- Swift：sidecar-entry.ts 顶部先 import 全部依赖（36-63 行，ESM 依赖模块体在入口体之前求值），再在 82-88 行覆盖 console.log/info/debug；esbuild 的 ESM bundle 保持该求值序（build-sidecar.mjs:485-507）。任何依赖模块的顶层 console.log/process.stdout.write 都会在重定向生效前写进协议流。
- 触发条件：未来任一被 bundle 的模块（shell-core/control-plane/dsh-runtime）新增顶层日志或直接写 stdout。
- 用户可感后果：Swift 侧把该行判为「非协议帧」loud 丢弃（BridgeClient.swift:594-597）——帧序不坏，但日志丢失且合规性依赖「没人这么写」；若泄漏内容恰好形如协议帧还会被误分发。
- 仓库内消解：可以。把重定向抽成 `sidecar-console-redirect.ts` 并在 sidecar-entry 首行 import；或构建时在 bundle 头部注入重定向（esbuild banner）；或 sidecar.js 的入口改为短 wrapper（先重定向再动态 import 业务）。
- 风险：低（wrapper 方案会改变入口文件形状，需同步 AppDelegate 的 sidecar.js 判定与 build-swift-app 装配）。需产品裁决：否。

### F9 · ready 帧的 port 不被消费也不校验
- Electron：控制面在进程内，`loadURL` 用实际绑定端口（cp.port），端口是单一事实源。
- Swift：控制面 URL 由 argv 预解析（AppDelegate.swift:166-178、235-252），sidecar 的 ready 帧 port 只被打印（AppDelegate.swift:258-266），既不与 cpURL 交叉校验也不用于驱动 webView（MainWindowController.swift:281-282 用 cpURL）。测试反而在断言两者一致（BridgeClientEdgeIntegrationTests.swift:325）。
- 触发条件：sidecar 以非 argv 端口提供服务（自定义 POC_SIDECAR 形状、或未来引入端口退避）。
- 用户可感后果：白窗（webView 加载无人监听的端口）且 ready 帧已到，看起来「已就绪」；无 fail-loud 保护。
- 仓库内消解：可以。AppDelegate.onReady 里断言 `port == cpURL.port`，不一致则 fatalStartup（或用 ready.port 重写 cpURL 后再 loadURL）；补 ShellStartupTests 一条纯逻辑用例。
- 风险：低。需产品裁决：否。

### F10 · 两个「保留契约」成员的 Swift 语义与 Electron 不同（当前不可达）
- Electron：`notifyClicked(openIntent)`（shell-core.ts:704）由 main 的通知 click 腿等价消费；`resolveResource(kind)`（shell-core.ts:761）由 main 的参数化路径解析消费。
- Swift：`notifyClicked` 发 notify（node-edges.ts:268-272），但 MainWindowController.routeNotify 把 notifyClicked 归为 unexpectedClick 并忽略（MainWindowController.swift:538-542）；`resolveResource` 依赖 Swift 推送的 resources 映射，而 MainWindowController 的 pushHostFacts 只接受 `[String: Bool]`（MainWindowController.swift:372-378），结构上无法推送 string 路径（resources 全文件 grep 0 命中），恒抛 `sidecar-edges:resource-not-cached`（node-edges.ts:394-398）。
- 触发条件：core 或后续批开始经 Pick 消费这两个成员（当前 shell-core.ts:1802-1821 的 Pick 不含它们，两端都不可达）。
- 用户可感后果：当前无；一旦有人使用即静默失效（notifyClicked）或 loud 抛错（resolveResource）。
- 仓库内消解：可以。删除死契约或补齐 Swift 侧实现（click notify 路由到与 `__host.notifyClicked` 同一处理器；resources 快照随 hostFacts 推送）。design 25 §4.1 注记为「有意保留」，建议至少把 resolveResource 的 resources 推送补上或把成员从契约移除。
- 风险：低。需产品裁决：**是**（保留 vs 删除，见 D5 备选）。

### F11 · 非崩溃退出也消耗 60s 退避配额

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- Electron：无 Supervisor。
- Swift：handleTermination 在退出码分级**之前**无条件 `policy.decide(now:attempts:)`（SidecarSupervisor.swift:400-402），随后 exit 3/70/0 分支直接 return，decision 被丢弃但 attempts 已写入时间戳（:408-433）。
- 触发条件：同一 Supervisor 实例在 60s 窗口内先经历 3 次 exit 0/3/70，再 start 后首次真实崩溃 → `giveUp`（文案「连续崩溃 3 次」与事实不符）；当前 AppDelegate 在 .stopped/.fatal 后不再 start，故被接线掩盖。
- 用户可感后果：潜在（当前不可达）：崩溃重启被误判为耗尽，直接 fatal。
- 仓库内消解：可以。把 decide 移到「仅非零、非 3/70、已提交」分支内调用。
- 风险：低。需产品裁决：否。

### F12 · 手工/损坏装配下 host 包缺失被降级为警告（构建侧是 fail-closed）
- Electron：electron-builder extraResources 与渲染器构建链在缺产物时不被静默接受（构建即失败）。
- Swift：build-sidecar.mjs 对 host 包 fail-closed（142-154、709），但 AppDelegate 装配态发现 `<sidecar>/dist/<pkg>` 缺失时只 `print("[poc] 警告：host 包缺失 …")` 并继续（AppDelegate.swift:206-211）——结果是一个能启动、却整体缺少 client-graph/git/archive/open-in 宿主域的 .app。
- 触发条件：手工改包、签名/拷贝损坏、或有人绕过 build:sidecar 直接拼 .app。
- 用户可感后果：设置/插件页缺少 Git worktree、归档清理等入口，只有 stderr 警告、无 fatal 提示（对照 design 25 §3.2/§4.4.3 把四包列为随 .app 必发资产，未规定缺失时的应用侧行为）。
- 仓库内消解：可以。装配态缺包 → fatalStartup（或在 ready 前 fail-loud 并在 UI 显式 banner）。风险：低。需产品裁决：**是**（严格 fatal vs 可见降级，见 D5 备选）。


### F13 · 退出清理串行（dispose → cp.stop），可能撞 4.5s 内部硬顶并留下子进程
- Electron：will-quit 把插件子进程、传输层、控制面、运行时安装器、运行时事务全部放进**一个** `Promise.allSettled` 并行等待（main.ts:1149-1155），硬顶 5s 到点 `app.exit(1)`（main.ts:1137-1146）。
- Swift：sidecar-entry 的 cleanup 先 `await headless?.dispose()` 再 `await controlPlaneInstance?.stop()`（sidecar-entry.ts:528-537），与 4.5s 硬顶（sidecar-entry.ts:516；QUIT_CLEANUP_TIMEOUT_MS 5000 − 500）做 Promise.race（:540-548）。
- 触发条件：存在 SSH 隧道/在途 exec/本地 dsh/插件子进程时收到 SIGTERM/SIGINT/stdin EOF。
- 用户可感后果：退出耗时为两者之和而非 max；一旦超过 4.5s，controlPlane.stop()（负责回收本地 dsh 子进程）可能**还没开始**就被 process.exit 强退，打印「可能有子进程残留」——孤儿本地 dsh/ssh 进程正是 5s 预算要避免的形态（对照 BridgeClientStopGraceTests 防的同类回归）。
- 仓库内消解：可以。改成 `await Promise.allSettled([headless?.dispose(), controlPlaneInstance?.stop()])`（cp.stop 幂等，shell-core/control-plane 的 stop 语义与 main 的并行调用同源）。sidecar-stdio.test.ts D1c 用例（:542-571）可继续量测硬顶不变。
- 风险：中低（改动退出链；需确认 cp.stop 与 dispose 之间无顺序依赖——main 的并行实现即证据）。需产品裁决：否。

### F14 · 损坏的 chamber-settings notice 被静默丢弃（注释声称 loud，代码不 loud）

> 状态：**已消解**（本次功能对齐批次：sidecar 宿主路径补齐）。
- Electron：`readSettingsFile(...)` 的 notice 非空即 `console.error`（main.ts:1430-1432），损坏文件被保留为 `*.corrupt` 且有解释。
- Swift：sidecar-ctx 的启动加载只取 `loaded.settings`，`loaded.notice` 被丢弃（sidecar-ctx.ts:497-505）——而紧邻注释（:495-496）写着「损坏 loud…绝不静默假默认」；`readSettingsFile` 恒返回 notice 而非抛错（chamber-settings.ts:267-300）。
- 触发条件：chamber-settings.json 损坏/不可读/叶被换成符号链接。
- 用户可感后果：用户设置被静默重置为默认（例如 windowCloseBehavior/quitConfirmation/keepAwake/badgeEnabled 回到默认），stderr 无任何解释，用户无从知道设置为何变了。
- 仓库内消解：可以。`loaded.notice !== null` 时 `console.error('[sidecar] ' + loaded.notice)`；顺便对齐注释与实现。
- 风险：低。需产品裁决：否。

### F15 · sidecar 自身无内建 dsh workspace 回退解析（dev 态）
- Electron：main.ts:305-317 有三级候选解析（打包 resourcesPath/vendor/dsh、repo ref-dsh、pkgDir/vendor/dsh）。
- Swift：`builtinDshWorkspace = inputs.builtinDshWorkspace ?? null`（sidecar-ctx.ts:401），只有 `--dsh-path` 一个来源（AppDelegate.swift:187-193 只在 PackagedLayout 解析到才注入；ChamberResources.swift:211-223 只认 POC_DSH_PATH/打包位）。
- 触发条件：`swift run` dev 态未设 POC_DSH_PATH/POC_DSH_WORKSPACE。
- 用户可感后果：Swift dev 壳的本地实例不可用（启动事务 blocked），而 Electron dev 能自动找到仓库内 dsh 树；打包态由 Swift 显式注入，无影响。
- 仓库内消解：可以。`inputs.builtinDshWorkspace === null` 时按 main 同款候选解析（或让 AppDelegate 在 dev 态解析仓库 ref-dsh）。风险：低（dev-only）。需产品裁决：否。

### F16 · host 包源目录的 8 层向上启发式探测（当前值与 Electron 相同，风险型）
- Electron：repoRoot 确定性直拼（main.ts:295-296/1756-1765）。
- Swift：`hostPackageSourceDir` 自 moduleDir 逐级向上 probe `packages/<pkg>/package.json`，首个命中即返回（sidecar-ctx.ts:707-721）；显式 `--host-*-dir` 时不受影响（sidecar-ctx.ts:708）。
- 触发条件：模块祖先链上存在另一个同名 `packages/<pkg>/package.json`。
- 用户可感后果：理论上可能 seed 到错误的 host 包源；当前 dev/打包布局下两侧解析值相同，打包态由 AppDelegate 显式传参。
- 仓库内消解：可以。把检索根限定到带仓库标记（pnpm-workspace.yaml）的目录。风险：低。需产品裁决：否。

## 前端可见差异（非像素；逐项）

### V1 · 非交互宿主腿 1s 有界等待，模态打开期间操作静默失败
- Electron：无该超时（electron-edges.ts:212-219/321-323 等直接执行）。
- Swift：performUI 非交互腿超时 1s（SwiftEdgeHostLegs.swift:168、503-535），主线程忙（NSAlert/NSOpenPanel 模态、退出收尾轮询）→ `swift-edge-ui-unavailable:<method>:main-thread-busy`；notify 消费侧只打印（MainWindowController.swift:507-513）。
- 触发条件：任一交互模态（插件源 picker 最长 10min、退出确认、注册表源切换确认）在屏，期间发生 setBadge/showItemInFolder/showError 等腿。
- 用户可感后果：角标不更新、Finder 揭示无反应、错误框不弹（只有 stderr），用户看不到失败原因；showError 是深链/更新错误路径的可见面，正落在「用户等待结果」时。
- 消解：把 notify 类腿（setBadge/showItemInFolder）改为 async（不占管道线程，无 1s 门）或排队到主线程空闲重放；showError 至少提高界或走非阻塞 sheet。风险：中（队列需有界并处理退出竞态）。产品裁决：**是**（D2）。

### V2 · showError 用 runModal 阻塞主线程（整个 UI 冻结）
- Electron：`dialog.showErrorBox` 不阻塞渲染器绘制（electron-edges.ts:327-329；main 进程被阻塞但 UI 不冻）。
- Swift：`alert.runModal()` 在 Swift 进程主线程，WKWebView 同步停摆（SwiftEdgeHostLegs.swift:354-360）。
- 触发条件：深链目标实例不存在、更新/远端操作失败等 showError 腿（sidecar-stdio.test.ts:451-458 实测该路径存在）。
- 用户可感后果：错误框在屏期间页面完全无响应、动画冻结，且同进程其它 UI 腿排队/超时（V1）。
- 消解：有可见主窗时改用 `beginSheetModal(for:)`（AppDelegate.presentFatalAlert 已有同款先例，AppDelegate.swift:617-621），无窗才 runModal。风险：低。产品裁决：否。

### V3 · pickPluginSource 对话框文案/归属/过滤器与 Electron 不一致
- Electron：`dialog.showOpenDialog(win, ...)`（窗 sheet）、title "Import a dsh plugin — source folder or .tgz archive"、buttonLabel "Import"、filters tgz（electron-edges.ts:350-364）。
- Swift：NSOpenPanel `runModal()`（应用级模态，非 sheet）、title「选择 chamber 插件源」、无 buttonLabel/prompt、allowedContentTypes=[folder, tgz]（SwiftEdgeHostLegs.swift:604-635）。
- 触发条件：任何插件源导入。
- 用户可感后果：同一功能两种语言/两种窗口归属（sheet vs 应用级模态）；与 Electron 版截图对拍必然不同（非像素级：英文/中文文案差异 + 模态归属/焦点行为）。
- 消解：对齐文案与 `beginSheetModal(for: mainWindow)`；allowedContentTypes 可保留（比扩展名过滤更强）。风险：低。产品裁决：**是**（中文文案是否 product 选择，见 D5）。

### V4 · 原生通知无具名音效（Electron darwin Glass → 系统默认声）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- Electron：`sound: spec.sound ?? 'Glass'`（electron-edges.ts:157-162）。
- Swift：`content.sound = silent ? nil : .default`，无 Glass（SwiftEdgeHostLegs.swift:229-235，注释已登记平台等价物差异）。
- 触发条件：非 silent 通知。
- 用户可感后果：提示音不同（可听差异）；通知横幅行为/点击链一致。
- 消解：可在 .app 内嵌 Glass 音效并用 `UNNotificationSound(named:)`；或接受为已登记平台差异。风险：低（需资源与签名）。产品裁决：**是**（D5 备选）。

### V5 · 退出清理前不清 Dock 角标、不停 keep-awake（≤5s 瞬态）
- Electron：will-quit 先 `setKeepAwakeActive(false)` + `clearBadgeIntentForQuit→app.setBadgeCount(0)` + tray.destroy（main.ts:1097-1121）。
- Swift：AppDelegate.beginTerminationCleanup 只抑制渲染恢复 + 置 app_quitting 门 + stop sidecar（AppDelegate.swift:490-510）；角标/keep-awake 随进程退出才消失。
- 触发条件：带未读角标/keep-awake 时退出且清理耗时（最长 5s）。
- 用户可感后果：点退出后角标与「保持常亮」在最长 5s 内仍可见/生效；无功能损失。
- 消解：beginTerminationCleanup 里补 `NSApp.dockTile.badgeLabel = nil` 与 keep-awake 释放（需要 legs 暴露释放点）。风险：低。产品裁决：否。

## 待裁决候选（每项给选项 A/B）

- **D1（F2）· fatal/重启耗尽后的应用终态**：A = 保持窗口存活 + NSAlert + 提供「退出/重试」操作（现状 + 补交互门，保住崩溃现场可诊断性）；B = 与 Electron 对齐，fatal 提示后走完整确认链 `NSApp.terminate`（形态一致，但用户无法在失效壳里导出/查看）。推荐 A 并补「退出」按钮。
- **D2（V1）· 非交互宿主腿超时策略**：A = 保留 1s 硬界（诚实失败 + core 可重试，代价是模态期间丢失）；B = 改为异步/排队（等待主线程空闲后执行，无丢失，代价是需要有界队列与退出竞态处理）。推荐 B（仅对 notify 类腿）。
- **D3（F6）· keep-awake 是否禁止显示器休眠**：A = 保持现状（屏幕常亮，偏离 Electron）；B = 去掉 `.idleDisplaySleepDisabled` 与 Electron 的 prevent-app-suspension 对齐。推荐 B，除非产品明确要屏保常亮。
- **D4（F4）· 交互腿 600s 双边竞态**：A = 维持两侧同值 600s（保留现契约，接受极端场景答案被丢）；B = node 侧放宽（≥Swift 上限 + 缓冲）或对交互腿取消 node 侧超时（由 Swift 腿保证有界应答）。推荐 B。
- **D5（V3/V4/F10/F12 打包与可见面）**：A = 接受为平台差异并在 STATUS/design 登记（文案/音效/host 包降级），只修高风险项（F1/F5/F9/F11）；B = 逐项对齐（对话文案 sheet 化、嵌 Glass、host 包缺位 fatal、死契约清理）。推荐 A + 单独登记 B 的子项为后续批。

## 纯像素/纯样式差异计数

**0 项。** 本分片未发现仅像素或纯样式的差异（本分片不含菜单/窗口外观/图标等纯样式面；V5 是状态-时序差异，已计入前端可见差异而非此计数）。

## 审计发现（非四类差异；覆盖缺口/测试门/注释漂移）

- **A1（测试门）Swift XCTest 无本地/check:full 入口**：根 `test:macos` 只跑 3 个 JS 文件（package.json:75；packages/desktop/scripts/test.mjs:133-138 MACOS_FILES），`swift test` 全仓仅出现在 ci.yml:435；run-checks.mjs 的 darwin 腿同样只挂 test:macos。后果：本地按 AGENTS.md 验证 Swift 壳时，54 个 XCTest 一例不跑。
- **A2（测试门）8 个真 sidecar 集成用例可整体 XCTSkip 而 CI 绿**：BridgeClientIntegrationTests.swift:74/84、BridgeClientEdgeIntegrationTests.swift:89/99 的 XCTSkip 兜底；ci.yml:433 `export POC_NODE_BIN="$(command -v node)"` 无 `test -x` 硬断言，也无 skipped==0 守卫（对照 JS 侧 test.mjs:140-149 的 ZERO_TEST_ALLOWLIST）。
- **A3（弱断言）60 通道冒烟只有二值判定**：BridgeClientEdgeIntegrationTests.swift:356-384 只把「ok 或 BridgeClient code 1 带非空文案」记为通过，:419-420 断言总数；ok 结果的结构/字段不断言 → 60/60 绿 ≠ 60 契约成立（sidecar-ctx 未实现字段抛 `sidecar-ctx-unavailable:*` 也算过）。
- **A4（覆盖缺口）没有任何测试执行装配产物 sidecar.js**：sidecar-stdio.test.ts:34/72 只 spawn `sidecar-entry.ts` 源；`DSH_CHAMBER_SIDECAR_COMPILED` 仅出现在 control-plane-module.ts:65 与 build-sidecar.mjs:38，测试零命中；build-sidecar.test.mjs:372-373 只 `existsSync`。esbuild 产物/相对入口/facade 打包分支无端到端保护。
- **A5（测试门）build-sidecar.test.mjs 硬编码默认架构 arm64**：:77 `assert.equal(defaults.arch, 'arm64')`、:111 arm64 URL 断言，而实现按宿主自适应（build-sidecar.mjs:388）→ x64 Mac 上该 macOS 腿假红。
- **A6（装配风险）缺源不清旧产物**：copyVendorDsh 的 `rmSync` 在 early return 之后（build-sidecar.mjs:273-275），copyPnpm 同形（:297-299）；runBuildSidecar 缺源只 warn 继续（:728-737）→ 持久装配目录会把上一轮 vendor/dsh、pnpm 带进 .app（release.yml 只 `test -f` 存在性）。
- **A7（跨语言锁步缺口）退出码 3/70 无锁步**：sidecar-exit-codes.ts:17-18 是单源，但 SidecarSupervisor.swift:416/423/427 硬编码字面量，SidecarSupervisorTests 用同样字面量喂假进程；CrossLanguageLockstepTests 只读 main.ts/shell-core.ts/sidecar-entry.ts（:82 起），不读 exit-codes 文件。
- **A8（潜在缺陷，对应 F11）Supervisor.decide 先于退出码分级**：SidecarSupervisor.swift:400-402 vs :408-433。
- **A9（覆盖缺口）LineReader/handleIncomingLine 读路径零测试**：BridgeClient.swift:60-130、553-597 的超长/非协议/非 UTF-8/overflow/EOF 残尾分支在 macos/Tests 无任何用例（A2 的 60 通道冒烟只发合法帧）。
- **A10（注释漂移）BridgeClient.stop 注释写 ≤2s**（BridgeClient.swift:426）与同函数 :430 的 5.0s 宽限矛盾；BridgeClientStopGraceTests.swift:32-35 记录的正是「按注释改回 2s」的历史回归。
- **A11（覆盖缺口）真实 BridgeClient.onTerminated→Supervisor 接线无测试**：BridgeClient.swift:377-379/501 与 SupervisorTests 的 FakeSidecar（:13-40）各自闭环；集成测试全走 stop()（主动摘 terminationHandler，:424）。
- **A12（弱断言）AppDelegate 5s 硬顶断言恒真**：CrossLanguageLockstepTests.swift:77 比较 `AppDelegate.quitCleanupTimeout == BridgeClient.quitCleanupGracePeriod`，而 AppDelegate.swift:25 本身就是该表达式；:504-508 的 asyncAfter 强退无行为断言。
- **A13（文档/注释漂移）design 25 §3.1 的 CLI 形状未实现**：design 25:193-195 写 `--pnpm-dir <dir> [--stdio|--socket <path>]`，而 sidecar-entry.parseArgs 只解析 user-data-dir/dsh-path/web-dist-dir/port/host-*-dir（sidecar-entry.ts:93-122）；pnpm 实际由布局相对解析（sidecar-ctx.ts:1258-1267；build-sidecar.mjs:156-171），stdio 恒为 stdin/stdout NDJSON（sidecar-entry.ts:175-178/562-572）。另 sidecar-ctx.ts:9-10 自述行号基于旧基线，:17/:21/:22 注释的 main.ts 行号已漂移（实测对应 main.ts:1564-1596/1580/1561）。
- **A14（无持久差异，注记）渲染器投递门多一道 webViewContentAlive**：node-edges.ts:206-218 的 delivered 判据比 electron-edges.ts:138-143 多一个 webViewContentAlive；WKWebView 内容崩溃但窗口对象仍在时 Swift 保守跳过 + loud，Electron 照发（消息丢），两端最终都靠渲染器重拉收敛。
- **A15（文案差异，renderer 不可感）事务 abort 文案**：sidecar-ctx.ts:2767 `sidecar is shutting down` vs main.ts:1129 `application is quitting`；进程同期退出，用户不可见，仅日志措辞不同。
- **A16（注释与实现矛盾）**：sidecar-ctx.ts:495-496 注释称设置损坏 loud，:497-505 实际丢弃 notice（= F14）。

## 方法说明与剩余不确定

- 逐函数覆盖：Electron 9 个主文件全部逐行读完（sidecar-ctx.ts 只核对与 B 桥/HostEdges/生命周期相关的段，已在覆盖清单声明）；Swift 7 个指定源文件 + 7 个指定 XCTest 全部逐行读完，另读了 AppDelegate/MainWindowController/SwiftEdgeHostLegs/NotificationDeliveryRegistry 作为接线证据。
- 并行分审计：本报告由 3 个并行只读分审计 + 主线复核合成——①Swift XCTest 全量（54 用例逐条）；②build-sidecar 装配链与打包测试；③sidecar-ctx.ts 全文（顶层导出 5 个、B 桥/HostEdges 交点、生命周期/资源路径/其余共享叶全量函数清单与逐函数镜像表）。三份分审计的每条结论均在主线抽查复核（关键行号已二次 read）。
- 未验证面（明确声明）：① 实机 GUI 行为（NSAlert sheet 归属、模态期间 WKWebView 冻结程度）只有代码证据，无实机截图；② Electron 的 ipcRenderer.invoke 拒绝对象是否保留 `code` 未在仓库内找到断言（F1 的「Electron 行为」按 renderer-trust.ts 的抛出点描述，页面侧两侧都以 message 为主）；③ 打包产物 release/sidecar 的存在性与布局由子审计核对了本机已有产物与 release.yml 断言，本次未重跑装配；④ sidecar-ctx.ts 的非 B 桥业务装配（约 2200 行）属 S-C 分片范围。

---

## S3 · 宿主腿 A（通知/角标/keep-awake/登录项/唤醒/退出/窗口）

来源分片：`s3-host-legs-a.md.md`（六路只读审计的过程产物，未随仓库提交；以下为该分片"功能级差异"起至结尾的逐项结论，含证据与选项）

## 功能级差异（逐项：证据 + 解法）

共 12 项（D1-D6、D9-D14；D7/D8 是评审中先编号后按类别改归前端可见差异 V1/V7 的两项——授权时机与通知音效，编号保留空位以免与后续分片串号）。每项含 Electron 行为 / Swift 行为 / 触发条件 / 用户可感后果 / 仓库内可消解性 / 具体解法 / 风险 / 是否需产品裁决。

### D1 唤醒事件永不触发（NSWorkspace 通知中心错位）

> 状态：**已消解**（本次核对后已改代码并跑门禁，见 §2 对照表）。
- Electron：`packages/desktop/electron-edges.ts:119-131`（powerMonitor.on('resume') → callback(Date.now())）→ `packages/desktop/shell-core.ts:887-894`（handleSystemResume：立即推 SYSTEM_RESUME，无窗则 held）。
- Swift：`macos/Sources/DSHChamberPoc/MainWindowController.swift:236-237` 在 **NotificationCenter.default** 上注册 NSWorkspace.didWakeNotification；SDK 头 `NSWorkspace.h:33-34` 明文：All notifications in this header file must be registered on this notification center. If you register on other notification centers, you will not receive the notifications.（NSWorkspaceDidWakeNotification 同头 `:323`）→ `hostWakeUp`(`:244-257`) 永不执行，`__host.systemResume` 永不发出。
- 触发：任意一次系统睡眠→唤醒。
- 用户可感后果：唤醒后 renderer 永不收到 `dsh-chamber:system-resume`（design 14 D4 ①「立即重连」失效，只能等 online/visibilitychange/120s staleness 看门狗）；held lastResume（`shell-core.ts:854/898-903`）恒为空 → 「无窗口常驻期间 resume 补发」在 Swift flavor 实际不可能发生；G5/§5 E6 验收项无法通过。
- 仓库内可消解：可以，纯代码缺陷。
- 具体解法：`MainWindowController.swift:236` 改为 `NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(hostWakeUp(_:)), name: NSWorkspace.didWakeNotification, object: nil)`；`appDidBecomeActive`(`:238-239`) 保持 NotificationCenter.default（NSApplication 通知本就投递在 default center）。
- 风险：修正后唤醒与 app 激活顺序不定，core `handleSystemResume`/`handleMainWindowShown` 幂等，无重复/漏发风险。
- 产品裁决：否（缺陷修复，建议本批必修）。

### D2 唤醒后 transport 即时重探缺失（design 14 D4 ② 未落实）

> 状态：**已消解**（本次功能对齐批次：sidecar 宿主路径补齐）。
- Electron：`packages/desktop/main.ts:1451-1453` 第二条 powerMonitor('resume') 监听 → `reconnectStaleTransports()`(`:679-697`：quitRequested 门 + 只碰 phase error/degraded 且 requiresUserAction!==true，绝不碰 idle)。
- Swift：`packages/desktop/node-edges.ts:416-420` 的 `__host.systemResume` 只调用 `onSystemResumeCb`（= `shell-core.ts:1934-1936` 注册的 handleSystemResume）；全仓 grep `reconnectStaleTransports` 仅 main.ts 命中，sidecar-ctx/sidecar-entry 无等价叶。
- 触发：睡眠/网络切换后 SSH 隧道或实例进入 error/degraded（半开隧道）。
- 用户可感后果：唤醒后远程连接不立即重探，只能等慢速重探；design 14 D4 ②未落实（即便 D1 修好，该腿仍缺）。
- 仓库内可解：可以。
- 具体解法：在 `packages/desktop/sidecar-ctx.ts` 增加导出叶 `reconnectStaleTransports()`（判据逐字对齐 `main.ts:679-697`：`sm.listInstances()` → `status.phase ∈ {error,degraded}` → `requiresUserAction!==true` → `sm.connect(id)`，失败 loud），并在 `packages/desktop/sidecar-entry.ts:190-255` 的 createNodeEdges deps 外，把 systemResume 入站做成双腿：`handleHostInbound` 的 `HOST_INBOUND.systemResume`（node-edges.ts:416-420）之后由一个装配侧订阅调用该叶（或把该叶作为可注入 deps`onSystemResume` 的第二回调）。
- 风险：sidecar 侧 transportManager 晚绑定（`sidecar-ctx.ts:432` bindPlane），叶需容忍 plane===null；quit 在途必须早退（对应 main.ts:683），否则 dispose 后重连产生孤儿 ssh。
- 产品裁决：否（补齐设计）。

### D3 keep-awake 语义过强：连带阻止显示器休眠

> 状态：**已消解**（本次核对后已改代码并跑门禁，见 §2 对照表）。
- Electron：`packages/desktop/main.ts:613-626` `powerSaveBlocker.start('prevent-app-suspension')`；design 14 D5（`docs/design/14-sleep-background.md:220-222`）明文「仅防应用挂起，不阻止显示器关闭」。
- Swift：`macos/Sources/DSHChamberPoc/SwiftEdgeHostLegs.swift:140-150` `beginActivity(options: [.idleDisplaySleepDisabled, .idleSystemSleepDisabled], ...)`——`.idleDisplaySleepDisabled` 明确阻止显示器休眠。
- 触发：设置 keepAwake=on（或启动 reconcile 读到 keepAwake=true，`AppDelegate.swift:322-328`）。
- 用户可感后果：屏幕不再按系统设置自动熄灭（耗电/烧屏风险），与 Electron 及设计相反。
- 仓库内可解：可以。`SwiftEdgeHostLegs.swift:142-144` 去掉 `.idleDisplaySleepDisabled`，仅保留 `.idleSystemSleepDisabled`（ProcessInfo 无 prevent-app-suspension 逐字等价物，最小对齐=只防系统空闲休眠）。
- 风险：若产品本意是「演示时屏幕常亮」，则属有意增强；需确认 design 14 D5 文案是否改。
- 产品裁决：**是**（见待裁决 2）。

### D4 sidecar 决策不可得时，关窗/退出方向与 Electron 相反（含 2s 超时面）
- Electron：关窗裁决在进程内同步（`main.ts:918-924` → `chamber-settings.ts:364-371`）；before-quit 决策同样进程内（`main.ts:1025-1052`），唯一近似分支 = 控制面未就绪 `cp === null` 直接放行退出（`main.ts:1026`）；清理挂起由 5s 硬顶 `app.exit(1)` 兜底（`main.ts:1137-1146`）。
- Swift：关窗决策 = 一次 B 桥往返（`AppDelegate.swift:438-459` + `533-566`，2s 超时）；facts 为 nil 时**一律** orderOut 隐藏（`:444-448`），即使 windowCloseBehavior='quit'；退出决策 nil 且 supervisor running/restarting 时**取消退出**并恢复窗口（`:403-420`）。
- 触发：sidecar 卡死/无应答（>2s）时用户关窗或 Cmd+Q。
- 用户可感后果：① 设置=quit 时关窗不退出而隐藏——与设置语义矛盾；② sidecar 卡死时应用退不掉（Cmd+Q 被取消），用户只能强制退出；Electron 在同样异常下仍能退出（清理超时硬顶）。
- 仓库内可解：部分（决策判据 localRunning 只有 sidecar 知道，宿主无法复制）。
- 具体解法（可解部分）：把 `windowCloseBehavior`/`quitConfirmation` 两个设置值随 `__host.hostFacts` 推给 Swift 缓存（`node-edges.ts:461-475` 现有通道即可承载），超时/失败时用缓存值同步裁决「隐藏还是转退出」，仅在「可能有本地实例」这一无法判定的 dim 上保持保守；对退出增加用户可见的超时提示（NSAlert：sidecar 无应答，强制退出/等待）。
- 风险：放宽退出违背 design 25 §4.4.2「宿主拿不到决策时必须走保守路径，绝不静默放行退出」；须以显式用户确认代替静默放行。
- 产品裁决：**是**（见待裁决 1）。

### D5 登录自启启动期 reconcile 缺失
- Electron：`packages/desktop/main.ts:1434-1440` 每次启动执行 `applyLaunchAtLogin(chamberSettings.launchAtLogin)`。
- Swift：`AppDelegate.swift:322-328` 只 reconcile keepAwake；`StartupSettings.swift:8-9` 明文「本文件补 keepAwake 一项」；`sidecar-ctx.ts:506-511` 声明启动期 reconcile 归 Swift 宿主。
- 触发：系统侧登录项被用户/系统移除（System Settings 关闭、app 迁移/改名、macOS 升级），或上次 register 未成功。
- 用户可感后果：chamber-settings.json 里 launchAtLogin=true 但系统无登录项；设置页仍显示开启（`chamberSettingsStatus` 读持久化值，`shell-core.ts:1942-1947`），下次重启不自启且无任何提示。
- 附带失败面方向差异：Electron 的 `setLoginItemSettings` 无返回/无异常，`applyLaunchAtLogin` 调用后恒 `{ok:true}`（`main.ts:640-641`）——注册失败也会持久化并显示成功；Swift 的 `register()` 抛错 → `{ok:false,error}`（`SwiftEdgeHostLegs.swift:446-449`）→ `applySettingsPatch` 回滚且不持久化（`shell-core.ts:1998-2005`）。Swift 更严格，两 flavor 在「失败时设置是否落地」上相反。
- 仓库内可解：可以。
- 具体解法：`StartupSettings.swift` 增 `readLaunchAtLogin`（复用同一整文件校验 `decodeKeepAwake`/`invalidSettingsReason` 的解析结果，只多取一个键），`AppDelegate.swift:326-328` 追加一次 `legs.respond(method: "setLoginItem", payload: .object(["enabled": .bool(v)]))`；Swift leg 已有 status 幂等预检（`SwiftEdgeHostLegs.swift:438-444`）与 no-bundle 守卫（`:434-436`）。
- 风险：dev/无 bundle 态会打印 no-bundle（可接受）；`.requiresApproval` 状态下 register 返回值语义需实机确认（不改变「已注册就不重复调用」的幂等性）。
- 产品裁决：否。

### D6 通知/Badge 的「已应用」回执缺失败与超时面
- Electron：通知以原生 show 事件为准，failed/早 close/5s 超时 = shown:false（`notifications.ts:470-516`，超时常量 `:262`），失败释放去重 claim 并 loud（`shell-core.ts:2151-2156`）；Badge 失败折算 `{applied:false,reason}`（`electron-edges.ts:212-219`）→ core 压一次 loud（`shell-core.ts:2045-2052`）。
- Swift：`SwiftEdgeHostLegs.swift:247-265` 的 `add` 完成回调只要无 error 即 `completion(nil,nil)`（shown:true），**没有超时面**；Badge 走 notify 单向（`node-edges.ts:274-279` 乐观 `{applied:true}` + `MainWindowController.swift:499-514` 失败只本侧 loud）。
- 触发：通知权限被拒/系统抑制（专注模式、通知中心关闭）、`add` 回调不返回；或 dockTile 写失败。
- 用户可感后果：renderer 丢弃该布尔值（`packages/renderer/src/App.tsx:3623-3631` 只 `.catch`），故 UI 不可见；实际后果 = core 的去重 claim 永不释放（5s TTL 内重试被吞）、失败 loud 日志缺失、Badge 失败在 core 的 `badgeApplyErrorLogged` 一次性日志永不触发。
- 仓库内可解：可以。
- 具体解法：`SwiftEdgeHostLegs.swift:239-265` 在 add 前查 `UNUserNotificationCenter.current().getNotificationSettings` 的 authorizationStatus（.denied/.notDetermined 视作不可展示）并加有界超时（对齐 node 侧 30s 或 Electron 5s），超时/拒绝 → completion error（node-edges 折算 shown:false）；Badge 若要回执需把 setBadge 从 notify 升为 edge（node-edges.ts:274 改 sendEdge），但 core 的 `applyBadgePresentation` 已不向 renderer 回执，收益仅日志。
- 风险：授权状态查询本身异步；.provisional/.ephemeral 状态下可能误报失败，需按状态白名单放行。
- 产品裁决：**是**（见待裁决 3）。

### D9 renderer unresponsive 恢复腿缺失
- Electron：`main.ts:774-786`（unresponsive → 仅 loadedOnce 后开始 15s 计时；responsive 取消 l786）→ reload。
- Swift：`RendererRecovery.swift:9-12` 明文「15s unresponsive 探测腿不可移植（WKWebView 无 unresponsive 事件）」；`MainWindowController.swift:735-771` 只实现 `webViewWebContentProcessDidTerminate`。
- 触发：渲染进程挂死（非崩溃：主线程死循环/长阻塞）。
- 用户可感后果：前端冻结时无自动重载、无错误框，用户只能手动重启；Electron 15s 后自动 reload、超限弹框。
- 仓库内可解：可以但需新机制（design 25 §5 E19 允许「或换心跳探测」）。
- 具体解法：renderer 侧已有 A 桥 invoke 面，可在注入 shim 里加周期心跳（如 `__dshChamberEmit` 反向 `pong` 或在 shim 内 setInterval 调一个轻量 invoke），宿主侧 N 秒无 pong 且非 quit/非 giveUp 窗口 → 复用 `recoveryPolicy.decide` 重载。
- 风险：误判会打断正常长任务（须保留 loadedOnce 门与滚动窗口）；心跳本身耗电/噪音。
- 产品裁决：**是**（见待裁决 4）。

### D10 通知满额（>16）淘汰语义不同：Swift 不清横幅、旧横幅点击无会话路由
- Electron：`electron-edges.ts:168-172` 满员 `evicted.close()` 真正关闭最旧活跃通知（`notifications.ts:404-440` 解释「不拒发、退役最旧」）。
- Swift：`node-edges.ts:220-231` 满 16 只 `clickRoutes.delete(oldest)`（横幅仍在通知中心）；`NotificationDeliveryRegistry.swift:36/88-98` 的 16 上限只管退役登记。
- 触发：同 profile 累计 >16 条未清除投递后点击最旧横幅。
- 用户可感后果：最旧横幅点开只激活窗口、不打开对应会话（`node-edges.ts:409-412` 未知 id 静默 ok；`AppDelegate.swift:757-762` 仍激活窗口）；Electron 侧该横幅已被 close 消失。
- 仓库内可解：可以。
- 具体解法：`node-edges.ts:227-231` 淘汰路由时改发一条按 identifier 的清除（新增 notify 事件或在 retireNotifications 载荷里携带 `notificationIds`），Swift `MainWindowController.swift:515-537` 对应消费 `removeDeliveredNotifications(withIdentifiers:)`；identifier 需由 Swift 侧解析/回带（`NotificationDispatch.identifier(sequence:)` 已在腿内生成，可让腿在登记时把 identifier 回执给 sidecar）。
- 风险：跨 sidecar 重启的 identifier 重用（`NotificationDeliveryRegistry.swift:12-17/157-162` 已登记该坑），按 identifier 清必须带壳内单调序号前缀。
- 产品裁决：否（可选对齐）。

### D11 网页 Notification 双路径未处置（B10 已登记）

> 状态：**部分消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）（见正文保留部分）。
- Electron：`main.ts:3751-3753` `session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'))` → 网页 Notification 权限被显式拒绝。
- Swift：`MainWindowController.swift` 只实现 `decidePolicyFor`(603-639)、`didCommit`(641)、导航回调与 `createWebViewWith`(803-820)，无任何 WebKit 权限回调或预拒绝；全仓无 Notification 权限处理。
- 触发：页面脚本 `Notification.requestPermission()` / `new Notification()`（官方 UI 若存在入口）。
- 用户可感后果：潜在绕过 chamber 裁决直发系统通知（与 `__host` 通知双路）、首次触发系统权限框，且宿主拿不到任何裁决点。
- 仓库内可解：无公开 WebKit API 可预拒绝（design 25 §5 E4/B10 明文「WKWebView 无等价预拒绝 API」）；可选注入 shim 覆盖 `window.Notification`（改变页面语义）。
- 具体解法：P0 实机先判定官方 UI 是否有网页通知入口与其行为；若必须阻断，在 `BridgeShimInjector.install`(`BridgeShimInjector.swift`) 的注入脚本里以 `Object.defineProperty(window,'Notification',...)` 覆写为 no-op 并 loud 上报（需产品确认不改页面既有 capability 探测语义）。
- 风险：覆盖 Notification 可能让页面的 permission UI 状态错乱。
- 产品裁决：**是**（见待裁决 6）。

### D12 SIGTERM/SIGINT 未转优雅退出（design 25 §3.3(5) 要求未落地）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- Electron：`main.ts:989-996` SIGTERM/SIGINT → `quitRequested/quitConfirmed` 置位 → `app.quit()`（跳过确认，走 will-quit 清理；注释并说明 macOS Electron 上该 handler 是死代码、Chromium 自行走优雅退出）。
- Swift：`macos/` 全树无 signal handler（grep SIGTERM/SIGINT 仅命中 BridgeClient.swift:363 的 `signal(SIGPIPE, SIG_IGN)` 与 kill 调用）；`main.swift:10-15` 直接 `NSApplication.shared` + `app.run()`；被信号杀死时 sidecar 靠 stdin EOF(`sidecar-entry.ts:569-572`) 走优雅回收。
- 触发：Activity Monitor「退出」（SIGTERM）/终端 kill。
- 用户可感后果：宿主侧无 `applicationWillTerminate`/无确认跳过/无 5s 清理窗口保证；sidecar 仍经 EOF 回收（cp.stop 兜底），孤儿风险低，但与设计 E9/§3.3(5) 不符。
- 仓库内可解：可以。
- 具体解法：`AppDelegate.swift:47` 装配期安装 `DispatchSource.makeSignalSource(signal: SIGTERM/SIGINT)` + `signal(SIGTERM, SIG_IGN)`，回调里 `quitGate.markConfirmed()` 后 `NSApp.terminate(nil)`（语义对齐 `main.ts:989-996`）。
- 风险：须先置 confirmed 否则会弹退出确认；与 AppKit 默认终止竞争需在主线程执行。
- 产品裁决：否。

### D13 退出清理缺 keep-awake 停止与徽标清零

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。

> 状态：**已消解**（本次核对后已改代码并跑门禁，见 §2 对照表）。
- Electron：`main.ts:1102 setKeepAwakeActive(false)`、`:1112-1114 clearBadgeIntentForQuit(() => app.setBadgeCount(0))`、`:1116-1121 tray.destroy()`。
- Swift：`AppDelegate.swift:490-510` 只做 suppressRendererRecovery/noteQuitting/supervisor.stop；无 endActivity、无 `NSApp.dockTile.badgeLabel = nil`；`clearBadgeIntentForQuit` 在 Swift flavor 无任何调用方（grep 全仓：仅 main.ts:1112）。
- 触发：keepAwake=on 或存在未读角标时退出。
- 用户可感后果：清理窗口（≤5s）内 Dock 角标保留（进程退出即消失，残留可感极弱）；keep-awake activity 由进程退出释放，无功能残留。
- 仓库内可解：可以。
- 具体解法：`AppDelegate.beginTerminationCleanup`(`:490-499`) 增加 `legs.updateKeepAwake(enabled:false)`（需把 updateKeepAwake 提升为 internal 供 AppDelegate 调）与 `NSApp.dockTile.badgeLabel = nil`；core 侧意图清零可在 sidecar-entry 的 `shutdown()`(`:518-527`) 内调用 `clearBadgeIntentForQuit(() => {})`（host 侧清零已足够；sidecar 意图随进程消亡）。
- 风险：无。
- 产品裁决：否。

### D14 宿主事实时效（实时查询 vs 事件缓存）
- Electron：`electron-edges.ts:231/257/268/279` 每次决策实时查询 `isVisible/isFocused/isLoading/isCrashed/isDestroyed`。
- Swift：`node-edges.ts:180-188/308-326` 读 `__host.hostFacts` 缓存；Swift 在窗口/导航事件时 push（`MainWindowController.swift:372-392/400-419/647-702`），存在「事件已发生、帧未到 sidecar」的窗口。
- 触发：关窗/失焦/导航开始与 hostFacts 帧到达 sidecar 之间的窄窗口（管道写+读取线程+主线程派发，负载下可放大）。
- 用户可感后果：该窗口内的通知裁决可误判（多看一条已聚焦时的通知，或漏一条失焦通知）；量级小、无实测证据，属同步门跨进程的结构性代价（`packages/desktop/node-edges.ts:14-21` 已声明「缓存近似为 v1 语义」）。
- 仓库内可解：无法完全消解（同步契约）；可缩小（关键裁决前同步 round-trip，但会阻塞 IPC 处理器）。
- 具体解法：接受（登记）；若实机 P0 复现，可在渲染器侧把「正在看的会话」豁免（`App.tsx:3619-3622` requireHidden）继续作为第二道防线。
- 风险：—
- 产品裁决：否（登记）。

## 前端可见差异（非像素）

共 9 项。每项：Electron 行为 / Swift 行为 / 触发 / 用户可感 / 消解。

### V1 通知授权时机（权限流程）
- Electron：无 `requestAuthorization`（全仓 grep 仅 `main.ts:3751` 的 web session handler）——首次 `new Notification().show()` 时才触发系统权限提示。
- Swift：`AppDelegate.swift:55-64` 启动即 `center.requestAuthorization(options: [.alert,.sound,.badge])`。
- 触发：新 bundle id 首装/首次启动。
- 用户可感：一启动就吃系统权限弹窗（Electron 是首次通知时）；design 25 §5 E4（`:575`）要求「授权请求时机与现状一致」——当前实现偏离设计。
- 消解：懒请求（第一次 scheduleNotification 前），见待裁决 7。

### V2 退出确认默认按钮相反（Enter 键行为）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- Electron：`main.ts:1064-1067` `buttons ['退出','取消'], defaultId: 1, cancelId: 1, noLink: true` → 回车=取消。
- Swift：`AppDelegate.swift:470-471` 先 addButton('退出') 再 addButton('取消')，NSAlert 默认按钮=第一个 → 回车=退出（响应判定 `:474`）。
- 触发：Cmd+Q 且本地实例在跑。
- 用户可感：习惯「回车取消」的用户会意外退出；两个 flavor 的键盘语义相反。
- 消解：`alert.buttons[1].keyEquivalent = "\r"`（并把第一个按钮 keyEquivalent 置空），或加按钮顺序对调后反转 response 映射。

### V3 取消退出后的窗口恢复方式（状态与时序）
- Electron：close-behavior='quit' 的 X 关窗路径窗口已被销毁（`main.ts:918-924` 放行 → window-all-closed `:1005-1011` → app.quit → before-quit），取消时 `showMainWindow()` 重建窗口（`:1082-1084`）→ 页面重载、渲染器状态重置。
- Swift：`windowShouldClose` 同步返回 false（`MainWindowController.swift:597-599` → `AppDelegate.swift:438-459`），窗口从未关闭；取消时 `restoreMainWindow()`(`:481-485`) 只是 makeKeyAndOrderFront → 现场保留。
- 触发：设置=quit + 本地实例在跑 + 关窗后在确认框选「取消」。
- 用户可感：Electron 取消后界面重新加载（当前视图/滚动/侧栏展开态丢失），Swift 保留原样；两 flavor 行为不一致（Swift 更少破坏，但属差异）。
- 消解：无法在 Swift 内「对齐 Electron 的破坏性」而无意义；可选在 Electron 侧改成 close 拦截（另立产品决定）。

### V4 托盘/菜单栏入口缺失

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- Electron：打包态创建 Tray（`main.ts:497-536`，菜单「显示窗口」`:523`、「退出 dsh-chamber」`:528`）。
- Swift：全仓无 NSStatusItem/NSStatusBar（grep 0 命中）。
- 触发：任意打包态运行。
- 用户可感：Swift flavor 菜单栏无 chamber 入口；恢复只能靠 Dock/二次启动。design 25 §5 E2（`:573`）把 v1 托盘列为「可选」，故属已登记的有意缺失，但仍是缺入口。
- 消解：NSStatusItem + 同两项菜单（可选排期，见待裁决 9）。

### V5 应用菜单面缩水（缺 Hide/Services/About/View 等）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- Electron：从未 `setApplicationMenu`（grep 0 命中），使用 Electron 默认 macOS 菜单（含 App 菜单 About/Services/Hide(H)/Hide Others/Quit、Edit、View、Window、Help）——design 25 §0.1-A8/§5 E3（`:85`/`:574`）自证。
- Swift：`AppDelegate.swift:659-695` 只建 App（退出 dsh-chamber POC）/编辑（撤销/重做/剪切/拷贝/粘贴/全选）/窗口（最小化/关闭）。
- 触发：任意运行。
- 用户可感：Cmd+H（隐藏应用）、Services、关于本应用、View 菜单（重载/缩放/开发者工具）缺失；Cmd+C/V 保留（Edit 在）。
- 消解：补标准 App 菜单项（About/Hide/Hide Others/Show All/Quit）与需要的 View 项。

### V6 对话框呈现模态与文案（showMessage/showError/pickPluginSource）
- Electron：`electron-edges.ts:331-343` `dialog.showMessageBox(win, opts)`（macOS 挂为窗 sheet）、`:325-329` showErrorBox、`:350-365` `dialog.showOpenDialog(win, {buttonLabel:'Import', title:'Import a dsh plugin — source folder or .tgz archive', filters:[tgz]})`。
- Swift：`SwiftEdgeHostLegs.swift:590-591`/`610-622` 均 `runModal()`（app-modal，非窗 sheet）；picker 标题 `选择 chamber 插件源`、无按钮 label（系统默认）。
- 触发：任何确认框/错误框/插件源选择。
- 用户可感：模态归属不同（sheet 贴窗 vs 全应用模态挡所有窗）+ 插件 picker 标题/按钮文案不同（英文 Import vs 系统「打开」+ 中文标题）。
- 消解：`beginSheetModal(for: window)` 替代 runModal（showMessage/showError 已有主窗提供者 `SwiftEdgeHostLegs.swift:566/349`）；picker 的 buttonLabel/title 可对齐英文文案（或统一走本地化）。

### V7 通知音效（可听差异）
- Electron：`electron-edges.ts:157-162` darwin 恒带 `sound: spec.sound ?? 'Glass'`（具名 Glass，不受系统提示音设置影响）。
- Swift：`SwiftEdgeHostLegs.swift:235` `content.sound = silent ? nil : .default`（用户系统提示音）。
- 触发：非 silent 通知。
- 用户可感：音色不同（Glass vs 用户设置声）；silent 路径两边一致（Electron silent:true 抑制 sound；Swift nil）。
- 消解：打包 Glass 音效资产 + `UNNotificationSound(named:)`（授权/体积/许可属产品面）；design 25 §4.5（`:547-549`）已登记为平台等价物。

### V8 窗口标题文案

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- Electron：`main.ts:850` `title: 'dsh-chamber'`（并 `:867-869` 冻结 page-title-updated）。
- Swift：`MainWindowController.swift:213` `window.title = "dsh-chamber POC"`。
- 触发：任意运行（标题栏/任务切换器可见）。
- 用户可感：名称多出 POC 后缀，与 Electron 明示同一产品名不一致。
- 消解：改字面量（1 行）。

### V9 关窗决策引入异步延迟（窗口驻留 ≤2s）
- Electron：`main.ts:918-924` close 事件内同步判定并 `win.hide()`——隐藏零延迟。
- Swift：`windowShouldClose` 返回 false 后等 `__host.quitFacts` 应答（`AppDelegate.swift:441-457` + `533-566`，超时 2s）才 orderOut——正常情况下是毫秒级，但 sidecar 忙/卡时窗口会保持可见最长 2s。
- 触发：每次点红点/Cmd+W 关窗。
- 用户可感：sidecar 卡顿时关窗「点了没反应」2s；正常路径无感。
- 消解：把 windowCloseBehavior/quitConfirmation 随 hostFacts 缓存进 Swift（同 D4 解法），常见路径无需往返；或维持现状并登记。

## 待裁决候选（每项 A/B）

| # | 候选 | A | B |
|---|---|---|---|
| 1 | D4 决策不可得时的关窗/退出 | A：向 Electron 靠——缓存设置值，超时按缓存同步裁决；对「可能有本地实例」的退出用 NSAlert 显示「sidecar 无应答」并让用户选择强制退出（保留诚实） | B：维持保守取消/隐藏，但在超时时 loud 提示 + 提供重试（不做任何静默放行） |
| 2 | D3 keep-awake 语义 | A：去掉 `.idleDisplaySleepDisabled`，只防系统休眠（对齐 Electron/design 14 D5） | B：保留灭屏禁用作为有意增强，并改 design 14 D5 与设置页说明为「保持屏幕常亮」 |
| 3 | D6 通知诚实回执 | A：add 前查授权状态 + 加有界超时，拒绝/超时折算 shown:false（对齐 Electron 诚实面） | B：接受乐观回执（renderer 不消费该布尔），仅补 loud 日志 |
| 4 | D9 unresponsive 腿 | A：v1 接受不可移植（登记 STATUS），发布前实机确认卡死频率 | B：排期心跳探测（renderer ping + 复用 RendererRecoveryPolicy） |
| 5 | D10 满额淘汰 | A：淘汰 click 路由时同步清除对应已投递横幅（对齐 Electron close 最旧） | B：接受旧横幅不可路由（只恢复窗口），登记为平台差异 |
| 6 | D11 网页 Notification | A：P0 实机判定后如需阻断，在注入 shim 覆写 window.Notification（no-op + loud） | B：接受无预拒绝 API 的现状，登记为已声明风险 |
| 7 | V1 授权时机 | A：改懒请求（首次通知前），对齐 Electron 与 design E4 | B：维持启动即请求（首通知更可靠），同步修 design 25 §5 E4 文案为「启动即请求」 |
| 8 | V2 默认按钮 | A：回车=取消（对齐 Electron defaultId:1），Esc=取消 | B：维持回车=退出（更少点击），并在设计登记两 flavor 键位差异 |
| 9 | V4 托盘 | A：补 NSStatusItem（显示窗口/退出），与 Electron 菜单栏入口对齐 | B：v1 仅 Dock（design 25 §5 E2 已允许），STATUS 登记缺入口 |
| 10 | V7 音效 | A：打包 Glass 类音效 + named sound（对齐听感） | B：维持系统默认声（尊重用户提示音设置），设计登记升级为「有意等价」 |
| 11 | V9/D4 关窗延迟 | A：windowCloseBehavior/quitConfirmation 随 hostFacts 缓存，常见路径同步裁决（同时消解 D4 的可解部分） | B：保留每次往返（数据面最简单），登记 ≤2s 极值 |

## 纯像素或纯样式差异计数

计数 = **1**（不计入上述清单）：

| # | 差异 | 证据 | 说明 |
|---|---|---|---|
| P1 | 首帧前窗口底色未设 | Electron `main.ts:846` `backgroundColor: '#0f1115'`（注释明示「消除白屏闪烁」）；Swift `MainWindowController.swift:209-215` 未设 `window.backgroundColor` / WKWebView 的 `underPageBackgroundColor` | 首帧可能白闪；纯观感，不影响功能 |

其余浏览器引擎级观感差异（滚动条、字体、IME 候选窗、右键菜单等）属 WKWebView/Chromium 引擎面，本分片未取证，故不计数；design 25 §8.5 的 W1-W6 走查项另计。

---

## S4 · 宿主腿 B（深链/open-in/对话框/外部打开/剪贴板/托盘/菜单）

来源分片：`s4-host-legs-b.md.md`（六路只读审计的过程产物，未随仓库提交；以下为该分片"功能级差异"起至结尾的逐项结论，含证据与选项）

## 功能级差异（逐项）

### F1. Swift 缺 macOS 冷启动 argv 深链扫描（scanDeepLinkUrls 无对应）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- **Electron 行为**：`whenReady` 内扫 `process.argv`，`for (const url of scanDeepLinkUrls(process.argv)) enqueueDeepLink(url)`（main.ts:1187；扫描器 shell-core.ts:558-564），与 `open-url` 双触发由 core 去重兜底（design 16 §4.2:185-186）。
- **Swift 行为**：只有 `application(_:open:)`（AppDelegate.swift:362-367）；全仓无 argv 扫描（grep `CommandLine.arguments`/argv 无深链消费）。
- **触发条件**：冷启动 URL 只出现在 argv 的形态（macOS LaunchServices 对注册 scheme 的启动 argv 携带 URL 正是 Electron 防御的对象；另含 `open -n/-a --args dsh-chamber://…`、直接执行二进制并带 URL 的脚本/dev 流程）。标准 Finder/浏览器「打开 dsh-chamber://」走 Apple Event，不受影响。
- **用户可感后果**：该形态下深链静默丢失（不进 core，连 `深链解析失败` 日志都没有），VS Code 不打开、renderer 不激活会话；dev 期无法用 argv 复现冷启动深链。
- **能否仓库内消解**：能。在 `AppDelegate.applicationDidFinishLaunching`（约 47-70 行）按 core 同样拼写扫描 `CommandLine.arguments`，对 `dsh-chamber://` 前缀项 `deepLinks.enqueue`，与 open-url 双触发由 core 去重（key=instanceId+path, deep-link.ts:127-136）。Swift 侧可加一条纯函数 + 单测（镜像 scanDeepLinkUrls 的防御语义）。
- **风险**：低（仅新增入队路径；需注意 argv 噪声如 `-psn_` 不匹配前缀即忽略）。
- **需产品裁决**：否。

### F2. sidecar 重启时 DeepLinkRelay.reset() 丢弃已缓冲未发送的深链

> 状态：**已消解**（本次核对后已改代码并跑门禁，见 §2 对照表）。
- **Electron 行为**：`pendingIntents` 是主进程模块级队列（shell-core.ts:1222），控制面/sidecar 重启不触碰它；`enqueueDeepLink` 只受 quit 门约束（1232-1250）。
- **Swift 行为**：`onRestartScheduled` → `deepLinks.reset()`（AppDelegate.swift:295-302），`reset()` 置未就绪并 `_ = buffer.drainAll()` **丢弃全部缓冲**（RendererRecovery.swift:128-131）。
- **触发条件**：sidecar 首次 ready 之前崩溃/重启（Supervisor 重启 500ms/60s≤3），且期间收到深链；缓冲中的 URL 在 reset 时清空且不计入 `droppedCount`。
- **用户可感后果**：冷启动深链（或重启窗口内到达的深链）丢失且无计数/无 loud（只有 `深链缓冲溢出丢弃` 的 droppedCount 上报另一路径，AppDelegate.swift:579-581）。
- **能否仓库内消解**：能。`reset()` 保留 `buffer`（只 `isReady=false`），或把 drainAll 出的 URL 重新 enqueue；同步修正 `testDeepLinkRelayResetRebuffersAfterRestart`（RendererRecoveryTests:173-189 只覆盖 reset 后新到 URL）。
- **风险**：低；但若某 URL 实际已被旧 sidecar 消费（本 relay 只在未就绪时缓冲，故不会）——保留即正确。
- **需产品裁决**：否。

### F3. 深链/恢复入口无 quit 在途门（低）
- **Electron 行为**：`second-instance` 深链在 `quitRequested` 时直接 return（main.ts:966）；`enqueueDeepLink` 首行 `if (quittingLeaf()) return`（shell-core.ts:1233）；`showMainWindow` 经 `canRestoreMainWindow(quitRequested)`（585-586/341-345）。
- **Swift 行为**：`application(_:open:)` 无 quit 判断，一律 `deepLinks.enqueue`（362-367），经 B 桥 invoke 后由 sidecar 的 `app_quitting` 拒绝（sidecar-entry.ts:270-274）；`applicationShouldHandleReopen` 也无 quit 门（349-356）。
- **触发条件**：Cmd+Q 确认/清理进行中收到深链或 Dock 点击。
- **用户可感后果**：主要为退出期噪声日志（`深链转交失败 … app is quitting` AppDelegate.swift:594），不产生新窗口/新拉起；Electron 完全静默。极低风险。
- **能否仓库内消解**：能。给 `DeepLinkRelay`/AppDelegate 增加 `isQuitting` 门，或复用 `quitGate.isConfirmed`。
- **风险**：极低。**需产品裁决**：否。

### F4. 直接二次启动：Swift 走 flock fatal 弹窗，Electron 走静默再激活
- **Electron 行为**：`requestSingleInstanceLock()` 失败 → 第二进程 `app.quit()`；首实例收到 `second-instance` → `showMainWindow()`（main.ts:953-969）。
- **Swift 行为**：`SidecarSupervisor` 的目录锁失败 → `fatalStartup(detail)`（AppDelegate.swift:304-310/642-653）→ `dsh-chamber POC 启动失败` 弹窗后 `exit(1)`；无 NSRunningApplication 再激活分支（design E18:589 依赖 LaunchServices）。
- **触发条件**：`open -n`、或直接执行 .app 内二进制、或在 Finder 里以「新实例」方式启动；正常双击由 LaunchServices 复用现有实例（等价路径）。
- **用户可感后果**：非常规启动下用户看到致命错误框并退出（而非首实例窗口前置）；若用户误以为应用崩溃会重复尝试。
- **能否仓库内消解**：能。锁失败分支先 `NSRunningApplication.runningApplications(withBundleIdentifier:)` 激活已有实例再决定是否 fatal。
- **风险**：低-中（涉及锁语义，须保持「双 flavor 互斥仍 fail-closed」——只对同 bundle id 的自身实例放行激活）。**需产品裁决**：可选（是否接受现状）。

### F5. showMessage 忽略 defaultId/cancelId（Esc 归属未定）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- **Electron 行为**：整个 `HostMessageOptions` 透传 `dialog.showMessageBox`（electron-edges.ts:338-343），显式携带 `defaultId:0/cancelId:0`（shell-core.ts:2856-2857/3906-3907），按钮序 `['取消', X]`。
- **Swift 行为**：只读 `type/title/message/detail/buttons`，`for title in buttons { alert.addButton(...) }` 后 `runModal()`，按 `raw-1000` 回传索引（SwiftEdgeHostLegs.swift:569-599）；`defaultId/cancelId` 无任何读取点。
- **触发条件**：任意确认框（SSH 插件 apply 确认、runtime 变更确认）。
- **用户可感后果**：Enter/首按钮 = 取消两侧一致（首按钮默认）；**Esc 键命中哪个按钮由 AppKit 对 NSAlert 的默认取消判定决定，仓库内无法判定**——若 Esc 命中末个按钮（『继续』），则 `confirmPluginAction` 的 `response===1` 会把 Esc 当成确认，与 Electron 的 cancelId:0 相反。须实机判定。
- **能否仓库内消解**：能。`showMessageBody` 读 `defaultId/cancelId`（0 基）映射到 NSAlert 的 `keyEquivalent`（\r / \u{1b}），与 Electron 显式对齐。
- **风险**：中（若 Esc 语义相反是反向确认，安全相关）。**需产品裁决**：否（按 Electron 对齐即可），但 Esc 现状必须先实机判。

### F6. 原生 flavor 本地 open 执行面未对齐（STATUS:731-745 项现状）
- **Electron 行为**：主进程 open-in 落地已收窄为 **vscode-only**——`OpenInLaunchContext` 无 stat/openPath/showItemInFolder（open-in.ts:64-80），本地目录/图标/拉起由实例内 `seed-open-in` 服务（design 20 §6:285-310）；`launchApp` 从未实现（electron-edges.ts:57-59；Pick 不含）；`openPath`/`showItemInFolder` 叶虽在（314-323）但 core **零调用点**（grep `edges.openPath`/`edges.showItemInFolder`=0；Pick 1800-1821 只有声明）。
- **Swift 行为**：`SwiftEdgeHostLegs` 仍实现 `showItemInFolder`(325-336)、`openPath`(460-473)、`launchApp`(368-418)、`focusMainWindow`(274-282)；`launchApp` 的 appId 映射只有 finder/vscode，且 vscode 分支自建 `vscode://file/`，不经注册表实查、不读 `vscodeOpenInNewWindow`、不做可用性探测（对照 deep-link.ts:713-724 + 882-888）。
- **触发条件**：当前无触发——core 的 HostEdges Pick 未收窄到这些成员且无调用点（shell-core.ts:1800-1821；STATUS:763-767 同结论）。
- **用户可感后果**：**当前无用户可感后果**（本地 open 全走实例内 seed-open-in，STATUS:743-745 已证随包分发）。风险是潜在：一旦出现 core 调用方，Swift 的 launchApp 只支持 2 个 appId 且绕过设置/探测，行为与 Electron 契约（design 25 E12:583 "NSWorkspace 按 bundle id/path"）和实例目录（~30 行 catalog）不一致。
- **能否仓库内消解**：能且推荐二选一（同 STATUS 推荐）：(A) 按 design 20 §6 新契约退役 Swift 的 showItemInFolder/openPath/launchApp 腿与 electron-edges 同名叶，并把 design 25 E11/E12 改写为「实例内 host 包」模型；或 (B) 若保留契约面，写明 design 25 §2 明文边界例外，并把 launchApp 改走 core（注册表/设置/探测）。
- **风险**：(A) 需同步删 node-edges 转发 + MainWindowController 的 showItemInFolder notify 路由 + 相关单测锚点；(B) 会让「本地执行面只在实例内」的边界出现文字例外。**需产品裁决**：是（A/B）。

### F7. 页面驱动外链打开失败在 Swift 侧被吞掉（诊断面）
- **Electron 行为**：`openExternally` 的叶 Promise reject → `console.error('[dsh-chamber] 打开外部链接失败：', …)`（shell-core.ts:1297-1299）。
- **Swift 行为**：macOS 14 分支 `NSWorkspace.shared.open(url, configuration:){_,_ in}` 丢弃 error，旧分支丢返回值（MainWindowController.swift:834-838）；只有预算拒绝有 loud 打印（829）。
- **触发条件**：无外链处理器/系统拒绝打开（如自定义 scheme 但 WKWebView 判外链、打开失败）。
- **用户可感后果**：用户点击外链无反应且日志无线索（Electron 至少日志可查）。非 UI 可见，但错误面不等价。
- **能否仓库内消解**：能。完成回调里 `print("[poc] 外链打开失败 …")`，旧分支判返回值。
- **风险**：极低。**需产品裁决**：否。

### F8. 双 flavor 共存时 `dsh-chamber://` 归属（注册面差异）
- **Electron 行为**：打包态每次启动 `setAsDefaultProtocolClient('dsh-chamber')`（main.ts:547-577），失败 loud；electron-builder `protocols`（package.json:35-40）生成 CFBundleURLTypes，bundle id `com.dshchamber.desktop`。
- **Swift 行为**：仅 Info.plist `CFBundleURLTypes`（Info.plist.template:56-66，bundle id `com.dshchamber.native`），**不在运行时抢占**；模板 10-15 行已把同 scheme 归属登记为 D2 未决。
- **触发条件**：同机同时安装 Electron 打包版与 Swift .app，且 Electron 版在 Swift 版之后启动过（LSSetDefaultHandlerForURLScheme 被 Electron 置为其自身）。
- **用户可感后果**：用户点 `dsh-chamber://` 可能被投递给 Electron 版而非当前使用的 Swift 版（或反之），深链在「非预期 flavor」里打开 VS Code，且 Swift 侧无热启动事件。
- **能否仓库内消解**：部分。要么 Swift 也调用 LSSetDefaultHandlerForURLScheme（会互相抢占，非良策），要么按 design 25 D2 明确「同机不建议双壳并存 / 以最后启动者为准」并写进 STATUS。
- **风险**：中（用户可见的深链错投）。**需产品裁决**：是（D2 决策：是否双壳共存、归属策略）。

### F9. 剪贴板/网页权限模型：Electron 显式白名单 vs Swift 无权限处理

> 状态：**部分消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）（见正文保留部分）。
- **Electron 行为**：`session.defaultSession.setPermissionRequestHandler((_wc,p,cb)=>cb(p==='clipboard-sanitized-write'))` + `setPermissionCheckHandler(...)`（main.ts:3751-3753），注释明确：网页 Notification/geolocation/media/clipboard-read/自定义格式写全部拒绝（3736-3750）。
- **Swift 行为**：无任何权限 handler（grep macos：`setPermissionRequestHandler|setPermissionCheckHandler|requestMediaCapturePermission` = 0），`setupWindow` 只装配 userContentController/导航委托（MainWindowController.swift:123-240）。
- **触发条件**：页面调用 `navigator.clipboard.readText()`、`Notification.requestPermission()`、getUserMedia、geolocation 等。
- **用户可感后果**：两 flavor 由不同机制（应用显式拒绝 vs WebKit 默认）决定；设计已登记两处风险——E16（clipboard 读写，design 25:587）、E4/B10（网页 Notification 绕过 chamber 裁决，:575）、C3（:103）。**具体可感后果须走 W1/C3 实机门**；但代码级差异确定：Electron 的「全部拒绝、只放行 sanitized write」在 Swift 侧没有等价物，Swift 的安全姿态依赖 WebKit 默认值而非自身白名单。
- **能否仓库内消解**：部分。写方向若 WebKit 默认可写即等价（E16 行文）；读/其它权限若要显式拒绝，需在 `WKUIDelegate`/`WKWebViewConfiguration` 层实现（WKWebView 无 Electron 的 session 全权枚举 API，E4/B10 已注明）。
- **风险**：中（安全边界从显式白名单降级为引擎默认）。**需产品裁决**：是（是否接受 E16/E4 的「平台默认」为长期口径，或排 P0 实机判定后补实现）。

---

## 前端可见差异（逐项）

### U1. showMessage 确认框把 message 显示两遍（所有确认弹窗）

> 状态：**已消解**（本次核对后已改代码并跑门禁，见 §2 对照表）。
- **证据**：调用点 `title: copy.message, message: copy.message`（shell-core.ts:2850-2859；3898-3909 同形）→ Swift `alert.messageText = title` + `informativeText = [message, detail].filter{…}.joined("\n")`（SwiftEdgeHostLegs.swift:576-579）。Electron 走 `dialog.showMessageBox`，macOS 不显示 `title` 字段（electron-edges.ts:338-343）。
- **触发**：SSH 插件 apply 确认（`confirmPluginAction`）与 runtime 变更确认（`confirmRuntimeMutation`）。
- **后果**：弹窗正文出现两次同一句（一次粗体标题、一次正文首行），观感像 bug。
- **解法**：`showMessageBody`：`messageText = message`（缺失回落 title），`informativeText` 只放 detail；或当 title==message 去重。**风险**：低。**需产品裁决**：否。

### U2. 插件源 picker 的标题/按钮文案与 Electron 不一致
- **证据**：Electron `title:'Import a dsh plugin — source folder or .tgz archive'` + `buttonLabel:'Import'`（electron-edges.ts:360-361）；Swift `panel.title='选择 chamber 插件源'`、未设 buttonLabel（SwiftEdgeHostLegs.swift:612-616）。
- **触发**：设置/插件页「导入插件源」。
- **后果**：同一操作在 Swift 弹出中文标题 + 系统默认按钮（"打开"），Electron 为英文标题 + "Import"；且 Swift 侧没有 .tgz 过滤器下拉的可见提示（filters vs allowedContentTypes 呈现不同）。
- **解法**：Swift 设 `panel.prompt = "Import"`（或本地化文案）与等价标题；若产品要求中文，则 Electron 侧也同步——以一支为准。**风险**：低。**需产品裁决**：可（文案语言口径）。

### U3. Swift 无托盘（菜单栏图标与其「显示窗口/退出」入口缺失）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- **证据**：Electron `maybeCreateTray` main.ts:497-536（打包态 + icon.png，托盘菜单 519-530）；Swift 全仓无 NSStatusItem（grep 0）。design 25 E2:573 已声明「v1：mac 用 Dock 常驻即可，可选 NSStatusItem」。
- **触发**：打包态日常使用；关窗隐藏后用户寻找菜单栏入口。
- **后果**：Electron 用户可从菜单栏图标显示窗口/退出；Swift 用户只能用 Dock 图标（`applicationShouldHandleReopen` AppDelegate.swift:349-356）与 Cmd+Q。功能可达但入口少一个。
- **解法**：A) 保持 Dock-only（design 已定，建议在 STATUS/design 明文「托盘不做」）；B) 增 NSStatusItem + 同两项菜单。**风险**：B 需托盘图标资产（resources/icon.png 平移）。**需产品裁决**：是（A/B）。

### U4. 应用菜单项集与文案差异

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- **证据**：Electron 从不 `setApplicationMenu`（grep 0；design 25:85 A8/574 也确认「未自定义应用菜单（默认菜单含 Edit role，Cmd+C/V 靠它）」）→ 项集 = Electron 官方默认模板（App/Edit/View/Window/Help；仓库内证据仅为「未自定义 + 默认菜单含 Edit role」，具体项以 Electron 运行时为准）。Swift `makeMainMenu` 只有：App 菜单（仅「退出 dsh-chamber POC」Cmd+Q）、编辑（撤销/重做/剪切/拷贝/粘贴/全选）、窗口（最小化 Cmd+M/关闭 Cmd+W）（AppDelegate.swift:659-695）。
- **触发**：任何菜单栏使用。
- **后果**（缺入口清单）：① 无「隐藏 dsh-chamber」（Cmd+H）与 Services/About；② 无 View 菜单（重载 Cmd+R、强制重载、开发者工具、实际大小/放大/缩小、全屏）；③ 无「缩放/Zoom」「全部置于前台」；④ 菜单文案中文（编辑/撤销/拷贝…）vs Electron 默认英文（Edit/Undo/Copy…），App 菜单退出项名字为「退出 dsh-chamber POC」（与产品名/POC 后缀不一致）。
- **解法**：按产品口径补齐删除项：至少加 Hide（Cmd+H，`NSApplication.hide:`）与 Zoom/Bring All to Front；View 的 Reload/DevTools 是否要带入需产品定（Swift 壳无 devtools 面）；菜单文案与 App 名统一（与 U5 同一改动点）。**风险**：低-中（View 项涉及 Swift 壳能力边界）。**需产品裁决**：是（哪些项是产品要求）。

### U5. 窗口标题文案不一致（且 Swift 未冻结标题）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- **证据**：Electron `title:'dsh-chamber'`（main.ts:850）且 `page-title-updated` 一律 preventDefault（867-869）；STATUS:1099 记载产品口径「桌面原生标题固定 dsh-chamber」。Swift `window.title = "dsh-chamber POC"`（MainWindowController.swift:213），无标题冻结代码。
- **触发**：看窗口标题栏。
- **后果**：品牌文案不一致（多出 "POC"）；另外若 WKWebView 将 `document.title` 同步到窗口标题（macOS 行为需实机判），会话名会污染标题栏，而 Electron 已被显式冻结。
- **解法**：Swift 改为 "dsh-chamber"；若要冻结，覆写 `NSWindow` 的 title 更新路径或监听 `NSWindow.title` 变化复原（或确认 WKWebView 不会同步）。**风险**：低。**需产品裁决**：否（与 STATUS:1099 既有裁决对齐）。

### U6. 外链打开冷却/预算拒绝无用户提示（两侧一致，登记为观察项）
- **证据**：Electron `console.warn` 后静默丢弃（shell-core.ts:1288-1291）；Swift `print` 后丢弃（MainWindowController.swift:827-833）。
- **后果**：用户连续点外链超 8 次/10s 后 30s 内点击无反应且无 UI 提示（两 flavor 同）。**列为观察项，不计差异**（行为等价）。

---

## 待裁决候选（每项给选项 A/B）

### Q1. 深链仅 argv 到达时是否必须补齐（F1）
- 现状：Swift 无 argv 扫描；标准 Apple Event 路径不受影响。
- A（推荐）：在 Swift 补 argv 扫描（纯函数 + 单测），与 Electron 双路径对齐，消除唯一静默丢失形态。
- B：明确只支持 LaunchServices/open-url，把「argv 冷启动深链」写进 design 25 §4.5 为已批准差异（并登记 dev 无法用 argv 复现）。

### Q2. sidecar 重启窗口的深链丢弃策略（F2）
- A（推荐）：reset 时保留缓冲（只落就绪位），ready 后按 FIFO 补发；补测试断言「reset 前缓冲项在下次 markReady 时仍发出」。
- B：维持丢弃，但把丢弃数计入 `droppedCount` 并 loud 上报（至少可观测）。

### Q3. 原生 flavor 本地 open 执行面（F6/STATUS:731-745）
- A（推荐，STATUS 首选）：按 design 20 §6 退役 Swift 的 launchApp/openPath/showItemInFolder 腿与 Electron 同类叶，design 25 E11/E12 改写为实例内 host 包模型。
- B：保留共享契约面，在 design 25 §2 写入明文边界例外，并把 launchApp 收编为 core 调用路径（注册表实查 + 设置/可用性门）。

### Q4. showMessage 的 defaultId/cancelId 与 Esc 语义（F5）
- A（推荐）：Swift 读 defaultId/cancelId 并将其映射为 NSAlert 首按钮/ Escape keyEquivalent；先实机确认现状 Esc 命中（含对 『继续』的反向确认风险）。
- B：维持 AppKit 默认，但把两个调用点的按钮序改成「确认在前、取消在末」（Electron 侧同步）以让 Esc 语义天然安全——会改变两侧按钮序契约，需同步测试。

### Q5. 网页权限（剪贴板读/Notification 等）在 Swift 的口径（F9）
- A：把「写=sanitized write 放行、读/其它=WebKit 默认」登记为长期平台差异；仅在 W1/C3 实机失败时再补实现。
- B：显式实现 WKUIDelegate/配置层的能力门（能拒的都拒），把「读写与 Electron 白名单语义等价」列为 P0 门禁后再收 A2。

### Q6. 双 flavor 共存时 `dsh-chamber://` 归属（F8）
- A：明文「同机不建议双壳并存」；Swift 不抢占 LSSetDefaultHandler，按最后启动者归属并登记（改动最小，建议）。
- B：Swift 也在启动时注册（幂等覆盖），接受两 flavor 互相抢占——用户以「最后启动的壳」为准。

### Q7. 托盘与应用菜单补齐范围（U3/U4）
- A（推荐）：托盘维持不做（design E2）；菜单补齐 Hide/About/Services 与 Zoom/Bring All to Front，View 菜单按 Swift 壳能力裁剪并在 design 25 E3 写明项集。
- B：完整对齐 Electron 默认菜单语义（含 Reload/DevTools 决策），并为托盘实现 NSStatusItem。

---

## 纯像素/纯样式差异计数（不计入清单，仅统计）

1. **确认框形态**：Electron 以主窗为父的 macOS sheet（electron-edges.ts:336-337）vs Swift `NSAlert.runModal()` 应用级模态（SwiftEdgeHostLegs.swift:359）——同一内容/按钮/返回值的呈现形态差异。
2. **picker 形态**：Electron 主窗 sheet + 过滤器下拉（filters + buttonLabel，350-362）vs Swift 独立 NSOpenPanel 应用模态、allowedContentTypes 灰显（SwiftEdgeHostLegs.swift:611-617）。
3. **菜单项字面**：Electron 默认英文菜单（系统本地化外观）vs Swift 中文手写标题（AppDelegate.swift:672-691）——已在 U4 计入文案差异，此条只计「字形/宽度」层。
4. **窗口部件**：无边框差异之外，WKWebView 首帧窗口底色未设置（Electron `backgroundColor:'#0f1115'` main.ts:846 vs Swift NSWindow 默认底）——潜在首帧闪色，属像素级（未做实测，仅登记形状）。

计数：**4 项**（其中第 3 项与 U4 文案项部分重叠，已在正文说明避免双计）。

---

## S5 · 装配/生命周期/数据面（启动/端口/锁/userData/运行时/更新）

来源分片：`s5-assembly-data.md.md`（六路只读审计的过程产物，未随仓库提交；以下为该分片"功能级差异"起至结尾的逐项结论，含证据与选项）

## 功能级差异（逐项）

> 每条：Electron 行为 / Swift 行为 / 触发条件 / 用户可感后果 / 能否在仓库内消解 / 具体解法 / 风险 / 是否需产品裁决。

### F1. 非法显式控制面端口：Electron 降级，Swift 致命退出
- 证据：Electron \`shell-core.ts:429-432\`：
  \`\`\`ts
  const fallback = process.env.DSH_CHAMBER_ELECTRON_DEV === '1' ? 'dev 自动退避端口' : '默认端口 17500';
  console.error(\`[dsh-chamber] 忽略非法 DSH_CHAMBER_CP_PORT="\${fromEnv}"（须为 1–65535 整数），使用\${fallback}\`);
  \`\`\`
  Swift \`ControlPlanePort.swift:63-72\`：
  \`\`\`swift
  if let raw = env["DSH_CHAMBER_CP_PORT"], !raw.isEmpty {
      guard let port = parsePort(raw) else {
          throw ResolutionError.invalidExplicitPort(key: "DSH_CHAMBER_CP_PORT", value: raw)
  \`\`\`
  调用点 \`AppDelegate.swift:173-177\` → \`fatalStartup\`（弹窗+exit(1)）。
- 触发：用户/包装脚本设置了 \`DSH_CHAMBER_CP_PORT=abc\` / \`70000\` / \`-1\`。
- 后果：Electron 照常启动（17500 或 dev 退避）；Swift 直接弹「启动失败」并退出。
- 可解：可。改 \`ControlPlanePort.resolve\`：非法显式值 → 记录警告并走缺省分支（packaged 17500 / dev 探测），与 Electron 同向。风险：丢掉「显式配置错误必须可见」的 fail-closed 语义；建议保留 loud 日志 + 弹窗提示但不阻断启动，或至少与 Electron 对齐为 warn。
- 产品裁决：是（fail-closed vs parity）。

### F2. dev 端口候选耗尽：Electron 回退系统临时端口，Swift 致命退出
- 证据：Electron \`shell-core.ts:436-441\`：\`console.warn(…回退到系统临时端口（0）)；return 0;\`；Swift \`ControlPlanePort.swift:81-83\`：\`guard let free = probeDevPort(devDefault) else { throw ResolutionError.noFreeDevPort(...) }\`，调用点同上 fatal。
- 触发：17520…17719 全被占用（并行 worktree / 异常环境）。
- 后果：Electron 起得来（端口由 OS 分配）；Swift 起不来。
- 可解：可。Swift 侧在 \`probeFreePort\` 失败时返回 0（系统分配）并允许 \`--port 0\`（control-plane 已支持 port 0：\`createControlPlane\` 监听 0 后 \`cp.port\` 回读实际端口——但 Swift 侧派生的 CP URL 是解析前端口，需要等 ready 帧的 \`port\` 值再建/改 URL，见 F2 解法附注）。风险：需把「URL 由 ready 帧 port 定稿」落到 \`AppDelegate.onReady\` 与 \`MainWindowController\`（当前 URL 在 controller init 时固定 \`AppDelegate.swift:267\`）。
- 产品裁决：否（可直接对齐），但涉及 ready 帧到 URL 的回填，属功能改动。

### F3. 更新检查触发面：Electron 静默首检 + 6h 周期；Swift 仅手动检查

> 状态：**已消解**（本次功能对齐批次：sidecar 宿主路径补齐）。
- 证据：Electron \`updater.ts:651,653,1193,1195\`：
  \`\`\`ts
  const CHECK_DELAY_MS = 15_000
  const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
  const initial = setTimeout(() => void runCheck(), CHECK_DELAY_MS)
  const interval = setInterval(() => void runCheck(), CHECK_INTERVAL_MS)
  \`\`\`
  由 \`main.ts:3958 updater.start()\` 调用。Swift \`update-headless.ts:216-218\`：
  \`\`\`ts
  start() {
    deps.logger.log('[updater-headless] 周期检查未启用（v1 blocked-available：仅用户主动「检查更新」触发）')
  },
  \`\`\`
  \`sidecar-entry.ts\` 全文无 \`updateController.start()\` 调用（唯一 \`.start()\` = \`controlPlane.start()\` 421）。
- 触发：用户从不打开设置页点「检查更新」。
- 后果：Swift 用户完全不会得知有新版本（Electron 会静默检查并在设置页/更新态里反映）。
- 可解：可。\`sidecar-entry.boot()\` 在 ready 后调用 \`headless.ctx.updateController.start()\`，并把 \`update-headless.start\` 改为与 Electron 同参数（15s + 6h，可复用 updater.ts 常量）；注意 ready 推送门（无主窗时 rendererPush 跳过，靠 UPDATE_STATE pull 兜底）。
- 风险：headless 控制器是真实出网检查，周期化会引入常驻网络请求；出网失败只进 error 态不弹窗（现状同样）。
- 产品裁决：是（design 25 §7 明确「设计 25 §7 未要求周期检查 parity」——需确认是否仍维持该有意差异）。

### F4. 更新安装腿：Electron 可下载 + 退出安装 + 重启并安装；Swift blocked-available（设计有意）
- 证据：Electron 下载/完成/安装 \`updater.ts:1216-1251, 1041-1043, 939 autoInstallOnAppQuit=true\`，重启 \`updater.ts:1252-1411\`；Swift \`update-headless.ts:225-233\`：
  \`\`\`ts
  return { ok: false, error: NATIVE_SHELL_DOWNLOAD_REFUSAL }
  ...
  restartAndInstall() { return { ok: false, error: NATIVE_SHELL_RESTART_REFUSAL } }
  \`\`\`
  \`installBlockedReason\` 恒为「原生壳不支持自动安装」（\`update-headless.ts:39,130\`）。
- 触发：Swift 用户发现更新后点「更新」/「重启并安装」。
- 后果：只能手动去 release 页下载；UI 以 blocked 行 + releaseLink 诚实呈现（design 25 §7 E1 批准的形态）。
- 可解：仓库内无法消解安装能力本身（需 Sparkle/EdDSA，design 25 §10 决策 3）；可在 Swift v1 范围内保持。
- 风险：无（有意 + 已登记）。
- 产品裁决：是（v1 保持 blocked-available vs v2 Sparkle）。

### F5. 退出安装豁免与关窗武装：Swift 恒不存在

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- 证据：Electron \`main.ts:1031-1044\`（updateDownloadReady 计算 + computeQuitRisk 豁免）、\`main.ts:918-924\`（updaterQuitArmed 关窗豁免）、\`main.ts:405-466\`（武装/兜底）；Swift \`sidecar-ctx.ts:2798 updateDownloadReady: false\`，\`sidecar-ctx.ts:2631 disarmUpdaterQuit: () => {}\`。design 25 §7 第 689 行明示「updateDownloadReady 豁免恒 false」。
- 触发：Swift 用户更新过下载（不可能发生，相位永不 downloaded）。
- 后果：无实际用户差异（安装腿本就不存在）；仅说明契约差异已文档化。
- 可解：随 F4 一起解决；单独消解无意义。
- 产品裁决：随 F4。

### F6. launchAtLogin 启动 reconcile：Electron 每次启动重放，Swift 不重放
- 证据：Electron \`main.ts:1434-1440\`：
  \`\`\`ts
  const loginItemResult = applyLaunchAtLogin(chamberSettings.launchAtLogin);
  if (!loginItemResult.ok) console.warn(...)
  \`\`\`
  Swift 启动只做 keepAwake：\`AppDelegate.swift:322-328\` 仅 \`StartupSettings.apply(StartupSettings.readKeepAwake(...))\`；\`setLoginItem\` 只在设置写入时经 \`SwiftEdgeHostLegs.swift:419-432\`（SMAppService.mainApp）执行。
- 触发：设置文件 \`launchAtLogin=true\`，但系统侧登录项缺失（用户从 Electron 迁移 userData、系统重置登录项、首次以 Swift 打开既有 userData、SMAppService 注册被清理）。
- 后果：Swift 启动不补登录自启，用户设置静默失效；Electron 每次启动把它补回来。
- 可解：可。在 \`AppDelegate.applicationDidFinishLaunching\` 的 StartupSettings reconcile 段（326-328）追加一次按 \`StartupSettings\` 同规读取的 \`launchAtLogin\` 并通过 \`legs.respond(method: "setLoginItem", …)\` 应用；需把 StartupSettings 的 \`ReadOutcome\` 扩为整文件读数或新增 \`readLaunchAtLogin\`（读写严格度与 F14 同源）。
- 风险：SMAppService.mainApp 在无 bundle（swift run）下返回 ui-unavailable（诚实降级），打包态会真实改登录项；幂等。
- 产品裁决：是（若认为 SMAppService 持久化已足够，可登记为有意差异）。

### F7. 渲染器卡死（unresponsive）：Electron 15s 后重载，Swift 无该腿
- 证据：Electron \`main.ts:774-785\` \`if (!loadedOnce) … unresponsiveTimer = setTimeout(() => { … reload(); }, 15_000)\`；Swift \`RendererRecovery.swift:9-14\` 明示「15s unresponsive 探测腿不可移植（WKWebView 无 unresponsive 事件，design 25 §0.1-B5/D5 已登记）」。
- 触发：renderer 主线程长挂（死循环/长任务）且未崩溃。
- 后果：Electron 自动恢复；Swift 白屏/冻结永久保持，无任何提示或恢复动作。
- 可解：可（工作量大）。在 Swift 侧加心跳探测（A 桥 ready 位 + \`watchdog\` 定期 evaluateJavaScript ping，超时按 \`RendererRecoveryPolicy\` 走 reload），或在 \`WKWebView\` 里用 \`webView.isLoading\` 之外的应用级心跳。
- 风险：心跳误判（正常长任务）；需与渲染器协作定义心跳点。
- 产品裁决：是（design 25 已登记为显式不可移植项，若要 parity 需裁决换心跳方案）。

### F8. 进程级故障恢复方向相反（设计使然，但用户可感）
- 证据：Electron 主进程未捕获异常 = 终止：\`main.ts:249-273\` \`fatalMainError\` → \`app.exit(1)\`（无自动重启）；Swift 控制面在独立 sidecar 中崩溃 → \`SidecarSupervisor.swift:386-449\` 退避重启（0.5s/60s ≤3；\`SidecarRestartPolicy.decide\` 203），exit 3/70 fatal 不重启（416-425）。
- 触发：控制面/主进程崩溃。
- 后果：Electron 整个应用退出（用户需手动重开）；Swift 窗口仍在、sidecar 自动重启后 A 桥门重落/深链重缓冲（\`AppDelegate.swift:295-302\`），用户感知为短暂断连后自愈。
- 可解：无法在 Electron 侧仓库内消解（Electron 主进程崩溃不可原地重启）；属路线 A 的结构性收益。
- 产品裁决：否（登记为已知形态差异）。

### F9. 单实例/二次启动/argv 深链
- 证据：Electron \`main.ts:953-969\`：
  \`\`\`ts
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) { app.quit(); } else { app.on('second-instance', …) }
  \`\`\`
  Swift 无该 API（grep \`requestSingleInstanceLock\` / \`second-instance\` 在 \`macos/\` 为 0 命中）；二次进程只会在 \`SidecarSupervisor.start\` 的目录锁上失败 → \`fatalStartup\`（\`AppDelegate.swift:304-310, 642-653\`）。argv 深链：Electron \`main.ts:1187\`；Swift \`main.swift:10-15\` 不解析 argv，AppDelegate 仅 \`application(_:open:)\` 362。
- 触发：同一用户二次直接启动可执行文件/带 \`dsh-chamber://\` argv 启动；Finder/LaunchServices 的正常二次激活不受影响（系统转给已运行实例）。
- 后果：直接二次启动看到「sidecar 异常/启动失败」弹窗后退出，而不是聚焦既有窗口；argv 深链被静默忽略。
- 可解：可。① 在 Swift 侧实现 pid 文件/NSRunningApplication 检查，二次启动则激活既有实例并退出（或复用目录锁记录 pid + NSRunningApplication）；② \`main.swift\` 扫描 \`CommandLine.arguments\` 里的 \`dsh-chamber://\` 并走 DeepLinkRelay（与 Electron \`scanDeepLinkUrls\` 对齐）。
- 风险：LaunchServices 语义下冗余；pid 复用误判需以锁为准。
- 产品裁决：是（是否要求 CLI 二次启动 parity）。

### F10. SIGTERM/SIGINT 未接优雅退出（design 25 §3.3(5) 要求未实现）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- 证据：design 25:332「5. SIGTERM/SIGINT：Swift 捕获后转 terminate 优雅路径」；grep \`SIGTERM|SIGINT\` 在 \`macos/Sources\` 仅命中注释与 \`BridgeClient.swift:363 signal(SIGPIPE, SIG_IGN)\`，无 handler。侧车自身有：\`sidecar-entry.ts:574-578 process.on('SIGTERM'|'SIGINT')\`。
- 触发：Activity Monitor「退出」/ \`kill <app pid>\`。
- 后果：Swift 进程被信号直接终止，\`applicationWillTerminate\`（AppDelegate.swift:369-376）不执行；sidecar 因 stdin EOF 自行优雅回收（\`sidecar-entry.ts:569-572\`），本地 dsh/隧道不孤儿化，但 Swift 宿主的 keep-awake/badge/退出日志/5s 硬顶语义不运行，退出码与崩溃不可区分。
- 可解：可。在 \`main.swift\`/\`AppDelegate\` 安装 \`signal(SIGTERM/SIGINT, handler)\`，handler 内 \`DispatchQueue.main.async { NSApp.terminate(nil) }\`（AppKit 安全的转接）。
- 风险：信号处理器异步安全；需避免在 handler 内触碰 AppKit（转主线程）。
- 产品裁决：否（可直接补齐；design 25 已列为合同）。

### F11. 目录锁获取时序晚于窗口构建与首载
- 证据：Electron 取锁在 whenReady 首个业务步（\`main.ts:1201-1211\`；wiring test \`chamber-lock-wiring.test.ts:23-33\` 断言先于任何 writer）；Swift 在 \`AppDelegate.swift:267 let controller = MainWindowController(cpURL:bridge:)\` 之后（\`MainWindowController.swift:105-108 setupWindow + startLoadingIfNeeded → webView.load\`），再到 \`AppDelegate.swift:304-310 supervisor.start()\` 内 \`SidecarDirectoryLock.acquire\`。
- 触发：另一 flavor 已持有锁（同一 userData），且其控制面在 17500 上应答。
- 后果：Swift 侧在得知锁冲突前已向另一 flavor 的控制面发起壳文档 GET（窗口未显示、A 桥 expectedOrigin 为 nil 全部拒绝，故无 IPC 泄漏）；表现为多余请求与「先加载后失败」的顺序，不影响 fail-closed 结果。
- 可解：可。把 \`SidecarDirectoryLock\` 的 acquire 提到 \`MainWindowController\` 构造之前（例如 AppDelegate 在解析 lockDir 后先建锁/取锁，再把已持有的锁注入 Supervisor；Supervisor.start 改为「已有锁则跳过 acquire」）。
- 风险：Supervisor 的「锁随 stop 释放」所有权模型需调整（锁生命周期上移到 AppDelegate）。
- 产品裁决：否（低危，建议在 v1 收口）。

### F12. dev 内建 dsh 工作区发现
- 证据：Electron \`main.ts:305-317\` 自动探测 \`<repoRoot>/ref-dsh\`、\`<pkgDir>/vendor/dsh\`；Swift \`ChamberResources.swift:211-223\`：
  \`\`\`swift
  if let explicit = env["POC_DSH_PATH"], !explicit.isEmpty { return explicit }
  if isPackaged, let resourcesDir { … }
  return nil
  \`\`\`
  dev 无 POC_DSH_PATH → \`--dsh-path\` 不注入（AppDelegate.swift:187-193）→ \`sidecar-ctx.ts:421 bundledVersion=null\` → 启动事务恒 blocked。
- 触发：\`swift run\`/\`POC main\` 未设 POC_DSH_PATH。
- 后果：dev Swift 壳没有本地实例（连接页显示 blocked/错误），Electron dev 有；打包态两者等价（各有随包 vendor/dsh）。
- 可解：可。\`PackagedLayout.resolveDshWorkspace\` dev 分支加入 Electron 同款候选（自 cwd/可执行文件向上找 \`packages/desktop/vendor/dsh\` 或 \`ref-dsh\`），或由 runbook 统一注入 POC_DSH_PATH。
- 风险：dev 探测顺序引入环境耦合；与 F13 的「POC_DSH_PATH 在打包态仍生效」一并收口。
- 产品裁决：否（dev 体验，建议对齐）。

### F13. POC_* 覆盖在打包（产品）路径仍生效

> 状态：**已消解**（本次核对后已改代码并跑门禁，见 §2 对照表）。
- 证据（全部无 \`isPackaged\` 前置）：\`ChamberResources.swift:146-151\` POC_NODE_BIN；\`:191\` POC_SIDECAR；\`:205\` POC_USER_DATA；\`:217\` POC_DSH_PATH（env 优先于打包自带树）；\`AppDelegate.swift:147\` POC_WEB_DIST；\`:84-85\` POC_PORT；\`:239\` POC_CP_URL。对照：Electron 无等价「任意脚本/任意 origin」覆盖面；其 dev 门集中在 DSH_CHAMBER_*，且 \`DSH_SIDECAR_LEGACY_START\` 在装配态被显式拒绝（\`sidecar-entry.ts:383-387\`）。
- 触发：以 POC_* 环境变量启动已打包的 \`dsh-chamber-native.app\`。
- 后果：可把壳指向任意 node 二进制/任意 sidecar 脚本/任意 userData 根/任意控制面 origin（ready 后 A 桥把该 origin 当信任锚）；对一个本地用户可自行启动的应用不构成提权，但构成产品化缺口与支持面（误设 POC_* 会静默改变数据根/远端 origin）。
- 可解：可。\`AppDelegate\` 在 \`isPackaged\` 时忽略 POC_SIDECAR/POC_NODE_BIN/POC_CP_URL（或至少要求显式 \`--allow-poc-overrides\`），并对 POC_USER_DATA/POC_DSH_PATH 保持显式但 loud；同时登记为 STATUS 取舍。
- 风险：POC 调试/验收依赖这些开关（runbook 用），需要保留非装配路径。
- 产品裁决：是（安全/产品边界，建议 A 收口）。

### F14. 落盘设置文件的读取严格度差异（Swift 更严，方向 fail-closed）
- 证据：Swift \`StartupSettings.swift:32-44\` 自述差异（重复键/非 UTF-8/>1MiB/RTL 主机等判损坏），实现 \`97-121, 263-275, 327-367\`；Electron 侧 \`chamber-settings.ts:222-262 isValidSettingsFile\` + JSON.parse（重复键取最后）。
- 触发：userData 中存在 Electron 接受而 Swift 拒绝的 \`chamber-settings.json\`（如重复键、UTF-16、>1MiB）。
- 后果：Swift 判 corrupt → keepAwake 按默认 off 且 loud；Electron 会按其解析取值。仅影响 keepAwake 启动 reconcile（其余设置由 sidecar 的同一 readSettingsFile 读取，两 flavor 相同）。
- 可解：可（放宽到与 Electron 逐字一致），但会丢掉已登记的 fail-closed 安全姿态。
- 产品裁决：是（维持更严 vs 逐字 parity）。

### F16. 崩溃诊断：Crashpad vs 无
- 证据：Electron \`main.ts:275-283\`：
  \`\`\`ts
  crashReporter.start({ productName: 'dsh-chamber', companyName: 'dsh-chamber', uploadToServer: false })
  \`\`\`
  以及 \`main.ts:287-293\` child-process-gone 日志；Swift 无 crashReporter/Crashpad（grep 0 命中），仅 \`fatalStartup\` 的 stderr 一行（AppDelegate.swift:643）与 macOS DiagnosticReports。
- 触发：渲染/GPU/主进程崩溃。
- 后果：Swift 现场只在 \`<userData>/Crashpad\`（不存在）之外；售后取证能力弱于 Electron。
- 可解：可（接入 Crashpad/PLCrashReporter 或写明仅依赖系统报告）；成本/收益需裁决。
- 产品裁决：是（诊断能力范围）。

### F17. dev 实根不同：双 flavor 目录锁在 dev 不互斥
- 证据：Electron dev 由 `packages/desktop/scripts/electron-dev.mjs` 传 `--user-data-dir=<repo>/.dev-user-data`（comment `:14-23`；`launch.mjs:121` 同域），Swift dev 固定 `<home>/Library/Application Support/dsh-chamber-poc-dev`（`ChamberResources.swift:206`）；打包态两者同根（`ChamberResources.swift:86-88` vs `app.getPath('userData')`，`chamber-lock.test.ts` 末段 lockstep 断言）。
- 触发：dev 同时跑 Electron dev 与 `swift run`/`POC main`。
- 后果：两 dev 实例各写各的 userData，目录锁不互斥（文件面不同）；只有打包态同名根才互斥。dev 并发污染不跨 flavor，但同名文件（registry/runtime 树）不在同一目录，不构成产品缺陷。
- 可解：可不改（dev 隔离是有意的）；若要与打包同语义，可在 runbook 让 Swift dev 也指向同一个 dev userData（POC_USER_DATA），但会与 `electron-dev.mjs` 的隔离目的冲突。
- 产品裁决：否（登记即可）。

### F18. pre-spawn 时间回退是 Swift 独有
- 证据：\`sidecar-entry.ts:467-486\`：
  \`\`\`ts
  if (args.dshPath !== null) {
    const maybeStartLocal = async () => { … await controlPlane.startLocal() }
    setTimeout(() => void maybeStartLocal(), 5000).unref?.()
    setTimeout(() => void maybeStartLocal(), 12000).unref?.()
  \`\`\`
  Electron 无等价 host 计时器：本地实例由启动事务 \`cp.startLocal()\`（main.ts:2722）或渲染器自动启动 POST（main.ts:3728-3735 注）拉起。
- 触发：启动事务完成但没有驻留本地实例（Swift 注释自述 dev 观察），且 \`--dsh-path\` 存在。
- 后果：Swift 可在渲染器未 boot/未发起 POST 时也把本地实例拉起（例如首屏静态资源失败但 sidecar 活着）；Electron 在同样情形下没有本地实例。反向：若 canStartLocal 门被运行时事务置阻塞，回退只是 loud 失败（无副作用）。
- 可解：可（删除该回退或与 Electron 对齐为「只由渲染器 POST/启动事务拉起」），但会回归 dev 观察到的「事务不驻留实例」问题——需先修事务驻留。
- 产品裁决：是（保留 dev 便利 vs 语义 parity）。

### F19. 打包 web dist 缺失非 fail-closed
- 证据：\`build-swift-app.mjs:428-431\`：
  \`\`\`js
  if (existsSync(options.webDistDir)) { cpSync(options.webDistDir, layout.webDist, { recursive: true }) … }
  \`\`\`
  无 else；同文件对 node/sidecar.js 是 throw（\`388-404\`）。消费侧 \`AppDelegate.swift:150-157\` 仅警告并仍传 \`--web-dist-dir\`；控制面 \`index.ts:1057-1062\` 抛 \`webDistDir is not a directory\` → \`sidecar-entry.ts:420-425 process.exit(70)\` → 首次启动即死。
- 触发：先跑 \`build:swift-app\` 而 \`packages/desktop/dist/web\` 未构建。
- 后果：签名/公证完成的 .app 首次启动即失败（只有 release.yml:998 的 CI 门禁兜底）。
- 可解：可。给 \`build-swift-app.mjs:428\` 加 else throw（对齐 node/sidecar.js 的 fail-closed），或在 \`--skip-web-dist\` 显式开关下才允许缺位。
- 风险：本地只想快速迭代 Swift 壳时会多一个前置构建步骤（可用显式 skip 开关表达）。
- 产品裁决：否。

### F20. Swift 布局锁步锚点不全（host 包目录 / pnpm 路径）
- 证据：\`PackagedLayoutTests.swift:35-42\` 只锚 \`sidecarDir\`、\`webDist\`、\`path.join(layout.sidecarDir,'sidecar.js')\`、\`vendor/dsh\`；host 目录是手写拼接 \`AppDelegate.swift:199-206\`，pnpm 只在 JS 内解析 \`sidecar-ctx.ts:1258-1262\`；产出在 \`build-sidecar.mjs:165,169-170\`。
- 触发：改名 host 包目录或 pnpm 落位。
- 后果：Swift 侧静默走「host 包缺失」警告路径（AppDelegate.swift:209-211）或 pnpm 回落，只有 release.yml:993-1002 的发布门禁会红。
- 可解：可。把 host 目录/pnpm 入口收进 \`PackagedLayout\` 具名函数并扩展 \`PackagedLayoutTests\` 锚点（读 build-sidecar.mjs 源文本）。
- 产品裁决：否。

## 前端可见差异（非像素）

### U1 = F3（无静默/周期更新检查）

> 状态：**已消解**（本次功能对齐批次：sidecar 宿主路径补齐）。
设置页「更新」区块在 Swift 侧只有用户主动点「检查更新」才会离开 idle；Electron 15s 后静默检查。Swift 用户不会自动看到「有可用更新」。

### U2 = F4（更新只读不装）
Swift 侧可显示 available + releaseUrl + blocked 行「原生壳不支持自动安装」；没有「更新」下载按钮（installBlockedReason≠null）、永远不会有「已下载，退出时安装」行与「重启并安装」按钮。证据：\`UpdateSection.tsx:108-129,158,210\`；\`blocked-reason.ts:10-17\`；\`update-headless.ts:39,130,225-233\`。

### U3 = F7（卡死无自愈、无提示）
WKWebView 内容进程未崩溃但无响应时，Swift 无 15s 重载、无对话框；用户看到长时间冻结。Electron 有 15s 重载与超限错误框（\`main.ts:774-785\`）。

### U4. 首载失败没有错误面
Electron 启动期加载失败 → \`dialog.showErrorBox('dsh-chamber 启动失败', …)\` + \`app.exit(1)\`（\`main.ts:942-945\`；控制面启动失败同理 1369-1374）。Swift 首载失败只重试 25 次（每次 0.5s）后打印日志（\`MainWindowController.swift:782-798\`，非连接类错误仅在 697-706 打印），窗口保持空白且无弹窗。触发：控制面进程活着但 5xx/端口被顶，或侧车启动失败时。后果：白窗无解释。可在仓库内消解：在重试耗尽分支加 NSAlert + 显式退出或在页面内注入错误占位（F19 的构建侧 fail-closed 只解决打包缺资源）。

### U5. 文案/Branding 差异（POC 后缀）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
- 窗口标题：Electron \`title: 'dsh-chamber'\`（\`main.ts:850\`，并 preventDefault page-title-updated 867-869）vs Swift \`window.title = "dsh-chamber POC"\`（\`MainWindowController.swift:213\`）。
- 菜单退出项：「退出 dsh-chamber」（\`main.ts:528\`）vs「退出 dsh-chamber POC」（\`AppDelegate.swift:665\`）。
- 启动失败对话框标题：「dsh-chamber 启动失败」（\`main.ts:943,1371\`）vs「dsh-chamber POC 启动失败」（\`AppDelegate.swift:648\`）；sidecar 异常：「dsh-chamber sidecar 异常」（\`AppDelegate.swift:615\`）。
- 触发：任何 screenshot/窗口标题对照。
- 后果：品牌名不一致（同一 tag 发布的两个 flavor 用户可见文案不同）。可解：\`MainWindowController.swift:213\`、\`AppDelegate.swift:648,665\` 改为与 Electron 相同文案；保留 POC 文案亦可视为 P0 期标识。产品裁决：是（POC 标识保留 vs 统一）。

### U6. 无托盘入口（Dock 常驻替代）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。
Electron 打包态有托盘（图标 + 「显示窗口」「退出」菜单，\`main.ts:497-536\`，仅在 \`resourcesPath/icon.png\` 存在时创建）；Swift 无托盘，靠 Dock 图标重开（\`applicationShouldHandleReopen\` 349-356）。关闭窗口两 flavor 都保留进程（Electron hide；Swift orderOut，\`MainWindowController.swift:918-924\` / \`AppDelegate.swift:438-459\`），恢复入口分别为托盘 + Dock vs 仅 Dock。设计 25 §5 明确写 Dock 常驻，故属有意的入口差异，但用户可感。

### U7. 退出确认与关闭隐藏的语义等价但细节不同（无差异项，记录核对结论）
Swift \`requestQuitFacts\` 走 sidecar \`__host.quitFacts\`（\`AppDelegate.swift:533-566\`；\`sidecar-entry.ts:228-248\`），事实源与 Electron \`before-quit\` 同源（LOCAL_RUNNING_STATES × localProcessAlive + computeQuitRisk），文案/按钮一致（\`AppDelegate.swift:466-472\` vs \`main.ts:1057-1067\`）。差异：Swift 决策超时 2s（\`AppDelegate.swift:27,546-551\`），Electron 同步本地计算无超时；sidecar 无应答时 Swift 分「sidecar live → 取消退出」/「非 live → 放行」（\`AppDelegate.swift:408-420\`），Electron \`before-quit\` 在 \`cp===null\` 时直接放行（\`main.ts:1026\`）。判定：等价（有界超时 + 诚实分支），仅 time 语义不同。

### U8 = F10/F6 的可见面
- F6：登录自启失配时「开机自启」设置与实际系统状态不一致（用户看不到错误，Electron 启动时补写）。
- F10：SIGTERM 退出不触发退出确认与清理日志（用户从 Activity Monitor 退出时 Swift 秒退，Electron 会先走确认/清理）。

## 待裁决候选（每项 A/B）

| # | 议题 | 选项 A | 选项 B | 建议 |
|---|---|---|---|---|
| D1 | 更新路线 | A：维持 v1 blocked-available（设计 25 §7），无静默/周期检查、无安装；登记差异 | B：v2 起用 Sparkle（appcast + EdDSA），补齐周期检查、下载、重启安装 | 建议 A（本期），B 另立 v2 计划 |
| D2 | 非法/耗尽端口 | A：与 Electron 对齐（非法值 warn 回落、dev 耗尽回退系统临时端口，ready 帧回填 URL） | B：保持 Swift fail-closed（现状），并在文档/STATUS 明示 | 建议 A（parity 成本可控） |
| D3 | POC_* 覆盖 | A：装配态忽略 POC_SIDECAR/POC_NODE_BIN/POC_CP_URL（保留 POC_USER_DATA/POC_DSH_PATH 但 loud） | B：保持现状并把 POC_* 记为公开调试开关 | 建议 A（产品边界） |
| D4 | launchAtLogin reconcile | A：Swift 启动补 reconcile（复用 StartupSettings 读取 + setLoginItem 腿） | B：不改，依赖 SMAppService 持久化并登记差异 | 建议 A（成本低，语义对齐 Electron） |
| D5 | SIGTERM 优雅退出 | A：加 signal handler 转 \`NSApp.terminate\`（design 25 §3.3(5)） | B：保持由 stdin EOF 侧车自清，登记偏离 | 建议 A |
| D6 | 卡死恢复 | A：加心跳探测腿并对齐 15s 重载 | B：维持 design 25 §0.1-B5/D5 的显式不可移植登记 | 建议 B（本期）→ A（后续） |
| D7 | 单实例/argv 深链 | A：实现二次启动激活既有实例 + argv 深链扫描 | B：依赖 LaunchServices 语义，登记 CLI 行为差异 | 建议 A（小改动） |
| D8 | 首载失败错误面 | A：重试耗尽后弹错误框并退出（或注入错误页） | B：保持仅日志、空白窗口 | 建议 A |
| D9 | POC 文案/Branding | A：窗口标题/菜单/弹窗统一为 \`dsh-chamber\` | B：保留 POC 后缀直至正式发布 | 建议 A（发布前必改，否则 screenshot 差异常驻） |
| D10 | dev 内建工作区发现 | A：Swift dev 增加 ref-dsh / vendor-dsh 自动发现 | B：runbook 强制 POC_DSH_PATH | 建议 A（dev 体验对齐） |
| D11 | pre-spawn 5s/12s 回退 | A：删除回退，只由启动事务/渲染器 POST 拉起（先修事务驻留） | B：保留并登记为 Swift 独有 dev 便利 | 建议 B（本期）→ A |
| D12 | 崩溃诊断 | A：接入 Crashpad/等价物 | B：仅系统 DiagnosticReports，登记差异 | 建议 B（成本/收益） |

## 纯像素差异计数

**计数：2。**

1. 窗口背景色：Electron 设 \`backgroundColor: '#0f1115'\`（\`main.ts:846\`），Swift \`NSWindow\`/WKWebView 未设底色（\`MainWindowController.swift:202-214\`）→ 首帧前可能有浅色闪一下（纯样式，不计入清单）。
2. 托盘/菜单栏图标：Electron 打包态有 \`resources/icon.png\` 托盘（\`main.ts:506-517\`）与 \`icon.icns\`；Swift 只有 \`.app\` 图标（\`build-swift-app.mjs:357-362\`），无菜单栏图标资产（该差异的用户入口语义已计入 U6，图标本身仅像素）。

另：窗口默认尺寸两 flavor 均为 1280×800（\`main.ts:843-844\` / \`MainWindowController.swift:49\`），无差异。

---

### 附：断言/文档漂移（不构成功能差异，供 Lead 收口）

1. \`docs/design/25-macos-swift-native-shell.md:699\` 引 \`sidecar-ctx.ts:2618\` 为 \`disarmUpdaterQuit\` 惰性叶，实际实现于 \`sidecar-ctx.ts:2631\`（缓存行号漂移）。
2. \`macos/Sources/DSHChamberPoc/Resources/bridge-shim.poc.js:64-67,437\` 仍把 Swift 更新控制器描述为「loud stub/updater 宿主落地前」，W-22 已真化（\`sidecar-ctx.ts:2663-2670\`）。
3. design 25 §0.1-E2（:110）/§7（:692-696）要求 UI 加 flavor 条件门；实际 UI 按 \`installBlockedReason\`/platform 决定（\`UpdateSection.tsx:108-129,158,210\`；\`blocked-reason.ts:10-17\`），行为等价但契约面不同。
4. design 25 §3.3(2) 写「打包态固定 17500、无退避（main.ts:253-281…）」——现 main.ts 的端口解析已迁至 \`shell-core.ts:425-442\`，行号引用过期。
5. \`AppDelegate.swift:150-153\` 的 \`<sidecar>/dist/web\` web 候选是死分支：build-sidecar 的 \`dist/\` 只重建 \`{control-plane, <host 包>}\`（\`build-sidecar.mjs:679-687,709-719\`；测试 \`build-sidecar.test.mjs:435\` 断言 skip 场景 readdir == ['control-plane']）。
6. \`build-sidecar.mjs\` 的 \`--help\` 未列 \`--skip-host-packages/--vendor-dsh/--pnpm-dir\`（:762-766 vs 解析 :399-410），且 \`--arch\` 未校验（:414）而 build-swift-app 校验（:134-138）。

---

## S6 · 前端可见面（flavor 传播与非像素用户可见差异）

来源分片：`s6-frontend.md.md`（六路只读审计的过程产物，未随仓库提交；以下为该分片"功能级差异"起至结尾的逐项结论，含证据与选项）

## 功能级差异（逐项）

### F1 · Swift flavor 缺失「下载 → 已下载 → 重启并安装 / 退出时安装」整条应用内更新链

- **Electron 行为**：检查到新版本后 available 行提供「更新」按钮；下载走 electron-updater（autoDownload=false，用户点击才下），下载中显示百分比、完成后显示「已下载，退出时安装」+「重启并安装」（quitAndInstall），退出时安装兜底。证据 `updater.ts:1216-1251`、`updater.ts:1252-1300`、`main.ts:3958`。
  ```ts
  // packages/desktop/updater.ts:1216-1229
  async download() {
    if (state.latestVersion === null || (state.phase !== 'available' && state.phase !== 'error')) {
      return { ok: false, error: 'no update available' }
  ```
- **Swift 行为**：真实 check 只到 `phase='available'` + `installBlockedReason='原生壳不支持自动安装'` + releaseUrl；`download()`/`restartAndInstall()` 在核心逻辑层显式拒绝（不是 UI 隐藏），phase 永不进入 downloading/downloaded。证据 `update-headless.ts:130`、`update-headless.ts:225-233`。
  ```ts
  // packages/desktop/update-headless.ts:225-233
  async download() {
    if (state.latestVersion === null || (state.phase !== 'available' && state.phase !== 'error')) {
      return { ok: false, error: 'no update available' }
    }
    return { ok: false, error: NATIVE_SHELL_DOWNLOAD_REFUSAL }
  },
  ```
- **触发条件**：设置 → 通用 → 更新 →「检查更新」且有更高版本。
- **用户可感后果**：Electron 用户可在应用内一键升级/退出安装；Swift 用户只看到「原生壳不支持自动安装，请前往下载页手动安装」+「前往下载页」，必须手动下载并替换 .app。
- **能否在仓库内消解**：否（需 Sparkle 或自建安装腿，design 25 §7 定案 v2 排期）。
- **具体解法**：保持现设计；若必须 v1 内升级，唯一现实路径是接 Sparkle（appcast + EdDSA），涉及发布管线和宿主腿，不属 S6 前端面。
- **风险**：用户留存/升级率；两 flavor 版本漂移。**需产品裁决：是（design D1–D7 未签核，STATUS「设计未决」）。**

### F2 · Swift flavor 无启动后 15s 与每 6h 的周期检查（“新版本可用”只在手动检查后出现）

> 状态：**已消解**（本次功能对齐批次：sidecar 宿主路径补齐）。

- **Electron 行为**：`updater.start()` 在 `main.ts:3958` 调用；首次 15s 后检查、之后每 6h（`updater.ts:1193-1197`），无需用户操作即可把 UI 推进到 available/up-to-date/error。
- **Swift 行为**：`start()` 只记一行日志，不排任何定时器（`update-headless.ts:216-218`）。
  ```ts
  // packages/desktop/update-headless.ts:216-218
  start() {
    deps.logger.log('[updater-headless] 周期检查未启用（v1 blocked-available：仅用户主动「检查更新」触发）')
  },
  ```
- **触发条件**：应用启动后不进入设置页、不点检查更新。
- **用户可感后果**：Electron 约 15s 后设置页/更新区已有「新版本可用」态；Swift 永远是 idle（连"已是最新"都不显示），用户不知道有新版本。
- **能否在仓库内消解**：可。
- **具体解法**：在 `update-headless.ts:216-218` 内复刻有界周期检查（`setTimeout(runCheck, 15_000)` + `setInterval(6h)`，timer.unref()，runCheck 内部已有 checking/phase 单飞门），复用 `updater.ts:651-653` 的同值常量。
- **风险**：blocked-available 下周期出网只产出信息态（设计原意不排期）；实现量极小、无安装风险。
- **是否需产品裁决**：是（设计 §7 明文"未要求周期检查 parity"，需确认接受或补齐）。

## 前端可见差异（逐项）

> 编号自 V2 起：原 V1「flavor 字段缺失（design §7 E2 未落地）」已并入 V8 末尾附注，避免与
> 逐函数对照表的引用编号漂移。

### V2 · 原生通知授权弹窗时机：Swift 首启即弹，Electron 延后到首次通知

- **Electron 行为**：全仓无 `requestAuthorization` 调用；原生通知只在首次构造/展示时由系统触发权限（`electron-edges.ts:157` `new Notification(...)`），且网页 Notification 被权限 handler 显式拒绝（`main.ts:3751-3753`）。
- **Swift 行为**：`applicationDidFinishLaunching` 里无条件请求授权（有 bundle id 时），失败/拒绝只打日志、不阻断。
  ```swift
  // macos/Sources/DSHChamberPoc/AppDelegate.swift:55-58
  if Bundle.main.bundleIdentifier != nil {
      let center = UNUserNotificationCenter.current()
      center.delegate = self
      center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
  ```
- **触发条件**：首次启动 Swift .app（通知设置默认关闭，用户根本没打算用通知）。
- **用户可感后果**：首启即弹系统授权框，且显示的应用名是「dsh-chamber-native」（与 V6 叠加）；用户若先拒绝，之后在设置里打开通知开关也不会再弹（macOS 只允许一次），只能去系统设置手工开启；Electron 首启无打扰。
- **能否在仓库内消解**：可。
- **具体解法**：把 `requestAuthorization` 从 launch 移到首次实际投递前（`SwiftEdgeHostLegs.scheduleNotification` 入口，`SwiftEdgeHostLegs.swift:217-228`）或用户打开通知主开关时；delegate 仍需在 launch 期设置（`center.delegate = self` 保留）。
- **风险**：延后请求会让首次通知弹出授权框并延迟横幅（UNUserNotificationCenter.add 在授权未知时会失败/挂起），需要"先请求→再 add"的两段；实现小、语义澄清成本低。
- **是否需产品裁决**：建议否（按"与 Electron 对齐"直接消解）；若产品希望提前征得同意，则保留现状并记为有意差异。

### V3 · 应用菜单/快捷键面缺失（View/App 标准项）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。

- **Electron 行为**：未调用 `Menu.setApplicationMenu`（全仓唯一 `Menu.buildFromTemplate` 是托盘菜单 `main.ts:520`，design 25:574 也自证"未自定义应用菜单"）→ 走 Electron 内置默认菜单（Edit role 提供 Cmd+C/V，design 25:574 明示依赖它；默认模板另含 View/Window 等标准 role）。
- **Swift 行为**：显式替换为最小菜单：App（仅「退出」⌘Q）+ 编辑（撤销/重做/剪切/拷贝/粘贴/全选）+ 窗口（⌘M/⌘W），共 10 项；无 About/Services、无隐藏（⌘H）、无 View（重载/缩放/全屏）。
  ```swift
  // macos/Sources/DSHChamberPoc/AppDelegate.swift:685-691
  windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
  windowMenu.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
  ```
- **触发条件**：任何菜单栏/快捷键使用。
- **用户可感后果**：Swift 用户失去 ⌘H 隐藏、⌘R 重载、⌘0/⌘+/⌘- 缩放页面、⌃⌘F 全屏、About；三组菜单之外没有任何入口（含"关于 dsh-chamber 版本"）。Electron 默认菜单具体项以实机为准（本仓无 dist 可证），但"未裁剪"与"显式 10 项"的落差是确定的。
- **能否在仓库内消解**：可（部分）。
- **具体解法**：`AppDelegate.makeMainMenu()`（:659-695）增补 App 菜单标准项（关于/隐藏/隐藏其他/显示全部）与 View 菜单；缩放/全屏需自行实现 `WKWebView.pageZoom` 与 `window.toggleFullScreen` 的 selector，不能用 role。
- **风险**：zoom/fullscreen 的 selector 需在 WKWebView 上实机验证；误加 devtools 类入口会扩大攻击面（见 V4）。
- **是否需产品裁决**：是（哪些标准项是发布必须）。

### V4 · 无开发者工具/检查器入口

- **Electron 行为**：默认菜单含 Toggle Developer Tools（未裁剪，证据同 V3）。
- **Swift 行为**：`WKWebView` 构造处未设置 `isInspectable`，也无任何 devtools 入口。
  ```swift
  // macos/Sources/DSHChamberPoc/MainWindowController.swift:202-206
  let webView = WKWebView(frame: NSRect(origin: .zero, size: Self.windowSize),
                          configuration: configuration)
  webView.navigationDelegate = self
  webView.uiDelegate = self
  ```
- **触发条件**：开发者/支持场景需要查看页面状态、Console、网络。
- **用户可感后果**：Swift 版无法打开 Web Inspector（即便 `isInspectable` 也只能经 Safari 开发菜单，不是应用内入口）；排障只能靠 POC_DEBUG=1 的 console 回传（`MainWindowController.swift:156-188`，默认关闭）与 /tmp 快照。
- **能否在仓库内消解**：可（有限）。
- **具体解法**：发布态本就不该开检查器；若需要，`if #available(macOS 13.3, *) { webView.isInspectable = true }` 并用 DEBUG 条件编译包住；应用内 devtools 面板无现成等价物。
- **风险**：检查器能触达 60 个 IPC 通道（页面世界），开启即降低信任边界；必须限定在开发构建。
- **是否需产品裁决**：是（是否随发布提供"开发者模式"）。

### V5 · 托盘/菜单栏入口缺失（关窗隐藏后只有 Dock 恢复）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。

- **Electron 行为**：打包态创建 Tray，菜单栏图标有「显示窗口」「退出 dsh-chamber」；关窗隐藏后可从菜单栏恢复/退出（`main.ts:497-536`）。
- **Swift 行为**：全树无 `NSStatusItem`（grep `NSStatusItem|statusItem` 在 `macos/Sources` 零命中）；关窗走 orderOut 隐藏，恢复入口 = Dock 点击（`AppDelegate.swift:349-355` `applicationShouldHandleReopen`）。
- **触发条件**：用户以 hide-to-tray 模式关窗后想恢复/退出。
- **用户可感后果**：功能上仍可恢复（Dock 常驻，`chamber-settings.ts:325-330` 判定 darwin 恒可恢复），但少一个入口与"关窗=隐藏到托盘"的语义预期（设置页文案仍是 hide-to-tray）；Electron 托盘还提供不激活窗口的「退出」快路。
- **能否在仓库内消解**：可。
- **具体解法**：`AppDelegate` 加 `NSStatusItem`（`显示窗口`/`退出` 两项，同 `main.ts:520-529` 文案），或把设置页文案改成"隐藏到 Dock"。
- **风险**：素材/图标资源与 Dock 常驻并存的生命周期；v1 设计 E2 明确"可选 NSStatusItem"。
- **是否需产品裁决**：是（E2 已列为可选项）。

### V6 · 应用名/窗口标题/错误框仍带 POC / "-native"字样

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。

- **Electron 行为**：productName `dsh-chamber`（`packages/desktop/package.json:34`）；窗口标题固定 `dsh-chamber` 并冻结 `page-title-updated`（`main.ts:850`、`867-869`）；错误框标题「dsh-chamber 启动失败」「dsh-chamber 前端异常」（`main.ts:839/736`）。
- **Swift 行为**：`CFBundleName = dsh-chamber-native`（`Info.plist.template:36-37`，bundle id `com.dshchamber.native` :32-33 是登记过的有意差异）；窗口标题 `dsh-chamber POC`（`MainWindowController.swift:213`）；菜单「退出 dsh-chamber POC」（`AppDelegate.swift:665`）；启动失败框「dsh-chamber POC 启动失败」（`AppDelegate.swift:648`）。
  ```swift
  // macos/Sources/DSHChamberPoc/MainWindowController.swift:213
  window.title = "dsh-chamber POC"
  ```
- **触发条件**：一切用户接触点（Dock/菜单栏/通知横幅/权限弹窗/窗口标题/错误框）。
- **用户可感后果**：Swift 版看起来仍是 POC；通知与权限弹窗的"来源应用"显示 dsh-chamber-native，与 Electron 版（dsh-chamber）不一致，双 flavor 同机时用户难以分辨。
- **能否在仓库内消解**：可。
- **具体解法**：`MainWindowController.swift:213` 标题改 `dsh-chamber`（或运行时读 `CFBundleDisplayName`）；`AppDelegate.swift:648/665` 去 POC；`Info.plist.template:37` CFBundleName 改 `dsh-chamber`（bundle id 不动以免破坏通知授权/WebKit 存储/目录锁语义）。
- **风险**：改 CFBundleName 会改变通知授权身份与 WebKit 存储目录名（bundle id 不变时一般不变，需实机确认）；属命名类低风险。
- **是否需产品裁决**：是（展示名定名）。

### V7 · Swift 连接设置页常驻「凭据以 0600 明文存储」提示

- **Electron 行为**：gateway 凭据经 Electron safeStorage（macOS keychain）加密，`instances_get` 投影 `secretStorage:'safeStorage'`（`main.ts:1496-1519`；只有 keychain 不可用时才 'plaintext' 并打印 loud 警告）。
- **Swift 行为**：sidecar 无 safeStorage，一律走 0600 明文回退并把 `secretStorage:'plaintext'` 投到每个实例行（`sidecar-ctx.ts:531-548`）。
- **前端行为（共享）**：连接设置页只要任一行是 plaintext 就渲染提示（`ConnectionsSection.tsx:1457-1461`，文案 `locales.ts:138`）。
  ```tsx
  // packages/dsh-chamber-client-ui-settings-connections/src/client/ConnectionsSection.tsx:1459-1460
  {instances.some(spec => spec.secretStorage === 'plaintext')
    ? <p className={css.hint} role="status">{t('secretStoragePlaintextHint')}</p>
  ```
- **触发条件**：Swift flavor 有任一连接实例时打开连接设置。
- **用户可感后果**：Swift 用户永久看到一条安全降级提示，Electron 用户看不到；提示本身诚实（design 17 §13.4.1 / 25 §6.4 已定案明文回退），但文案未说明是"原生壳无 keychain 集成"，用户可能误以为系统环境异常。
- **能否在仓库内消解**：可。
- **具体解法**：按 flavor 分支文案（前置 `dsh-chamber:info.flavor`——但该字段未进桥，见 V8 附注）或在 Swift flavor 用专用字典键说明；最小改动是在 `update-headless` 式的能力投影里增加 flavor 感知。
- **风险**：flavor 字段扩散到 preload/shim/global.d.ts/L3 镜像测试（design §7 E2 原计划），改动面中等。
- **是否需产品裁决**：是（是否常驻提示 / 是否补充说明）。

### V8 · A 桥「documentStart 预定义 + ready 前拒绝」与渲染端重试模型的错配

- **Electron 行为**：preload 只有在 info 往返成功（或 10 次失败兜底）后才 `exposeInMainWorld`（`preload.cts:905-941`），而所有 IPC handler 在窗口创建前就绪 → **surface 一旦存在，invoke 必成功**；渲染端靠「surface 缺失」轮询（`bridge-hydration.ts:161-178` 100ms×20、`App.tsx:1969-1978` 500ms）自愈。
- **Swift 行为**：shim 在 documentStart 立刻定义完整 API（scalars 暂 null，后台再拉 info），ready 帧前/重启窗口内所有 invoke 被 Swift 拒绝（`MessageHandler.swift:187-190` 回 `ipc_sender_forbidden`）。此时渲染端 **看不到"surface 缺失"**，于是：settings-store（slowReProbe=true）会慢重试自愈，runtime-store 在 reject 时也重试（`runtime-management.ts:716-722`），但 **update-store `slowReProbe:false`**：首次 `state()` 被拒后 latch 已置位、不再重取，只能等后续 `update-state-changed` 推送或组件重挂载。
  ```ts
  // packages/dsh-chamber-client-ui-settings-bridge/src/client/update-store.ts:76
  slowReProbe: false,
  ```
  ```js
  // macos/Sources/DSHChamberPoc/Resources/bridge-shim.poc.js:594，documentStart 即挂出
  defineWindowGlobal('dshChamber', dshChamberApi)
  ```
- **触发条件**：Swift 壳在 sidecar 未就绪窗口内完成页面加载/重载——实际存在该窗口：窗口与 WKWebView 在 `bridge.start()` **之前**创建并首载（`AppDelegate.swift:267` vs :284-320），首载失败按 500ms×25 重试（`MainWindowController.swift:783-796`），sidecar 侧 `controlPlane.start()`（:421）先于 ready 帧（:438）——页面可在"CP 已监听、ready 未发"的毫秒窗口加载成功；监管重启期间 `noteSidecarReady(false)`（`AppDelegate.swift:300`）也会关闸。
- **用户可感后果**：命中的用户打开设置→更新，看到「当前版本：—」与**完全没有状态行**（`update !== null` 不成立），点检查更新也可能只得到 rejected promise（UI 只监听 push，不显示该错误）——直到某次状态推送才恢复；Electron 不会出现该态。这是**状态/时序面**的 flavor 差异，非崩溃。
- **能否在仓库内消解**：可。
- **具体解法**（择一，推荐最小改动）：① `update-store.ts:76` `slowReProbe` 改 `true`（复用 settings 的 100ms→2s 有界慢探测；只影响重试节奏，不动契约）；② `bridge-shim.poc.js` 改为 info 成功后再 `defineWindowGlobal`（与 preload 同序）或 ready 前 hold（`MessageHandler.swift:187-190`）——触碰 D1 定案；③ `AppDelegate` 改为 ready 后才创建窗口（触碰启动序列）。
- **风险**：① 低；②/③ 需复核 design §4.4.1 D1 与首屏时间。
- **是否需产品裁决**：否（建议按 ① 消解）；若改为 ②/③，需 D1 复核。**附注**：design §7 E2 要求把 `flavor: 'electron'|'swift'` 加进 info 载荷并同步 preload/global.d.ts 镜像测试——现状是 **core 已经返回 `flavor`（`shell-core.ts:2170`）但 preload（:907-921）与 shim（`INFO_SCALAR_KEYS:134`）都丢弃它、global.d.ts 的 DshChamberBridge（:754-768）也没有该字段**；任何"按 flavor 分支"的 UI 能力门（V7 等）目前都缺这个位。

### V9 · 英文 blocked 文案与中文/稳定通道不一致（共享 UI 文案小瑕）

- **Electron 行为**：mac 未签名时 stable 行英文含 "(missing signature)"（`locales.ts:327`），beta 行英文不含（`:328`），而 zh beta 行含「（未配置签名）」（`:76`）。
- **Swift 行为**：走 native-shell 行，文案完整（`:79/331`）。
- **触发条件**：英文界面 + mac 未签名 + beta 通道 + 更新可用。
- **用户可感后果**：英文 beta 用户看到"自动安装不可用"却不知道原因（同状态的 stable 行有原因）。
- **能否在仓库内消解**：可（一行文案）。**具体解法**：`locales.ts:328` 补 "(missing signature)"。**风险**：无。**需产品裁决**：否。

### V10 · 通知声音不同（已登记）

> 状态：**已消解**（本次功能对齐批次 b4decfaa：Swift 侧功能补齐）。

- **Electron**：darwin 用具名 `Glass`；**Swift**：系统默认声（UNNotificationContent 无 Glass 资源），silent 则无声。证据 `SwiftEdgeHostLegs.swift:232-235`、STATUS:771。**后果**：同一通知两端音色不同。**可消解**：否（平台资源差异；可捆绑自定 sound 文件近似，但需素材与签名）。**需产品裁决**：已登记，维持。

### V11 · 隐藏窗口的定时器节流（C1）

- **Electron**：`backgroundThrottling:false`（`main.ts:861`），隐藏后 SSE/WS 心跳与重连计时器不被节流。
- **Swift**：WKWebView 无等价开关（design 25 §5 E19/§8.1 C1 明示），隐藏态下页面定时器可能被系统降频；App 侧有 `visibilitychange` 补偿（`App.tsx:1874-1878`）与唤醒补发。
- **触发条件**：关窗隐藏 ≥30s 后。
- **用户可感后果**：Swift 版隐藏期间会话运行态/心跳更新可能变慢；唤醒/重开时才补齐。**能否消解**：设计层未定（keep-alive/唤醒补发方案 C1）；**需产品裁决**：是（STATUS 已挂实机门禁）。

### V12 · 右键上下文菜单（Swift 侧为平台默认，仓内仅证未覆写）

- **Electron**：全仓无 `context-menu`/`contextmenu` 处理器（grep 0 命中），页面右键无原生菜单。
- **Swift**：`MainWindowController` 未覆写 WKWebView 的默认菜单；WKWebView 在 macOS 上有 AppKit 提供的默认上下文菜单（复制/查询/服务等，具体项随系统版本）。
- **触发条件**：在 Web 内容上右键。
- **用户可感后果**：Swift 出现 Electron 没有的系统菜单（含"重新载入/检查元素"之外的系统项），交互面不一致。
- **能否在仓库内消解**：难（WKWebView 无公开 API 完全禁用；需子类化/覆写 `menu(for:)`，有平台 hack 风险）。
- **是否需产品裁决**：是（接受 vs 尝试对齐）；**标注**：Swift 侧结论基于平台默认行为，需实机截图确认后才可升级为定论。

### 潜伏差异（当前无用户触发路径，列出备查）

- **V-L1 网页 Notification 权限（B10）**：Electron 显式拒绝（`main.ts:3751-3753`）；Swift 无对应裁决面。仓内当前无 `Notification.requestPermission`/`new Notification` 使用点（vendor 与 packages 全 grep 零命中）→ **当前不可感**；一旦官方前端新增网页通知入口，两端行为分叉（Electron 静默拒绝 vs Swift 系统授权）。解法：WKUIDelegate/WKWebView 无预拒绝 API，需在页面世界加 shim 层拦截（`bridge-shim.poc.js` 是唯一注入点），或接受。
- **V-L2 剪贴板读**：Electron 拒绝 `clipboard-read`（`main.ts:3751-3753`）；WKWebView 无预拒绝（系统授权/手势）。仓内当前无 `navigator.clipboard.readText` 使用点 → 不可感。

## 待裁决候选（每项给选项 A/B）

| # | 议题 | 选项 A | 选项 B | 关联 |
|---|---|---|---|---|
| D-A | Swift v1 更新形态 | 维持 blocked-available + 手动下载，且不排周期检查（现状/design §7） | 至少补周期检查（F2），安装腿仍留 v2 | F1/F2 |
| D-B | 应用菜单与开发者能力 | 维持最小菜单（App/编辑/窗口），不加 devtools | 补齐 App/View 标准项 + 受限 `isInspectable`（仅开发构建） | V3/V4 |
| D-C | 托盘入口 | Dock 唯一恢复入口（现状，E2） | 增 NSStatusItem（显示窗口/退出，同 Electron 文案） | V5 |
| D-D | 展示名 | 维持 `dsh-chamber-native` / 保留 POC 字样 | 统一展示为 `dsh-chamber`（CFBundleName/窗口标题/菜单/错误框；bundle id 不变） | V6 |
| D-E | 通知授权时机 | 启动即请求（现状） | 延后到首次通知或用户打开通知开关（与 Electron 对齐，需"先请求后 add"两段） | V2 |
| D-F | 双 flavor 同 `dsh-chamber://` scheme | 维持同 scheme，由 LaunchServices 归属决定（现状，Info.plist.template:12-15 已标注 D2 未决） | Swift 用独立 scheme（如 `dsh-chamber-native://`）并同步深链调用方 | 深链用户路径 |
| D-G | 明文存储提示 | 常驻提示（现状，诚实） | 按 flavor 文案改写（说明"原生壳无 keychain 集成"），需先落地 info.flavor | V7/V8 附注 |
| D-H | 隐藏节流 | 接受 C1 降级，靠唤醒补发（现状） | 实施 keep-alive/心跳方案（需实机定标） | V11 |

## 纯像素差异计数

**计数 = 1（候选，需实机确认）**，另 **0** 项可静态定性的 flavor 条件样式：

1. 设置面板遮罩模糊：`packages/dsh-chamber-client-ui-settings-bridge/src/client/SettingsShell.module.css:79` 使用无前缀 `backdrop-filter: var(--dsw-mask-blur)`，全仓无 `-webkit-backdrop-filter` 回退（token 定义 `ui-theme/.../gradient-shadow-text.css:19`）；Chromium（Electron）支持无前缀，macOS 13/14 的 WKWebView（Safari<18 引擎）可能不渲染模糊，表现为遮罩无毛玻璃。属纯视觉，按规则不计入清单，仅计数。证据侧：`Info.plist.template:44` `LSMinimumSystemVersion 13.0`。

补充：全仓 CSS 无任何 flavor/platform 条件分支（grep `darwin|platform|electron` 仅命中注释文本），故不存在由 CSS 造成的结构性像素差异；字体栅格化/滚动条等引擎级渲染差异不属本仓可判范围，未计数。

## 待实机核验（不计入差异数）

- WKWebView 默认右键菜单具体项与禁用可行性（V12 的 Swift 侧前提）。
- Electron 默认应用菜单的确切项集（本机 node_modules 未下载 electron dist，无法在仓内取证；V3 的 Electron 侧只断言"未自定义"）。
- `SMAppService` 登录项在打包/非 /Applications 路径下的用户可见状态（`SwiftEdgeHostLegs.swift:419-450` 已实现，语义待实测）。
- backdrop-filter 在目标 macOS 版本的实际渲染（像素计数唯一候选）。
- C1 隐藏节流对 SSE/WS 的量化影响（STATUS 已挂 M5 实机门禁）。


## 5. 审计发现、门禁缺口与未覆盖面（跨分片）

> 这些不是「双端差异」，而是本次核对顺带发现的门禁/覆盖缺口与仍需实机判定的面；它们与 §4 的待裁决项共同构成后续工作。

### 5.1 S3 分片结论摘要

## 分片结论摘要

| 项 | 数 |
|---|---|
| 覆盖文件 | 19（Electron 3 + Swift 生产 7 + Swift flavor 线协议 3 + XCTest 6） |
| 逐函数/接入点对照行 | 136 |
| 等价（含「等价·机制不同」） | 92 |
| 功能级差异 | 12（D1-D6、D9-D14；原 D7/D8 为免双重计数已改归 V1/V7） |
| 前端可见差异（非像素） | 9（V1-V9） |
| 待裁决候选 | 11 |
| 纯像素/样式差异 | 1（P1） |
| 零消费者 HostEdges 契约面 | 8 成员（两 flavor 一致） |

Top 严重度排序（详细见功能级差异节）：D1 唤醒事件永不触发 > D2 唤醒重探缺失 > D4 决策不可得的退出/关窗 > D3 keep-awake 灭屏 > D5 登录项 reconcile 缺失。

### 5.2 S2 审计发现（覆盖缺口 / 测试门 / 注释漂移）与方法说明

## 审计发现（非四类差异；覆盖缺口/测试门/注释漂移）

- **A1（测试门）Swift XCTest 无本地/check:full 入口**：根 `test:macos` 只跑 3 个 JS 文件（package.json:75；packages/desktop/scripts/test.mjs:133-138 MACOS_FILES），`swift test` 全仓仅出现在 ci.yml:435；run-checks.mjs 的 darwin 腿同样只挂 test:macos。后果：本地按 AGENTS.md 验证 Swift 壳时，54 个 XCTest 一例不跑。
- **A2（测试门）8 个真 sidecar 集成用例可整体 XCTSkip 而 CI 绿**：BridgeClientIntegrationTests.swift:74/84、BridgeClientEdgeIntegrationTests.swift:89/99 的 XCTSkip 兜底；ci.yml:433 `export POC_NODE_BIN="$(command -v node)"` 无 `test -x` 硬断言，也无 skipped==0 守卫（对照 JS 侧 test.mjs:140-149 的 ZERO_TEST_ALLOWLIST）。
- **A3（弱断言）60 通道冒烟只有二值判定**：BridgeClientEdgeIntegrationTests.swift:356-384 只把「ok 或 BridgeClient code 1 带非空文案」记为通过，:419-420 断言总数；ok 结果的结构/字段不断言 → 60/60 绿 ≠ 60 契约成立（sidecar-ctx 未实现字段抛 `sidecar-ctx-unavailable:*` 也算过）。
- **A4（覆盖缺口）没有任何测试执行装配产物 sidecar.js**：sidecar-stdio.test.ts:34/72 只 spawn `sidecar-entry.ts` 源；`DSH_CHAMBER_SIDECAR_COMPILED` 仅出现在 control-plane-module.ts:65 与 build-sidecar.mjs:38，测试零命中；build-sidecar.test.mjs:372-373 只 `existsSync`。esbuild 产物/相对入口/facade 打包分支无端到端保护。
- **A5（测试门）build-sidecar.test.mjs 硬编码默认架构 arm64**：:77 `assert.equal(defaults.arch, 'arm64')`、:111 arm64 URL 断言，而实现按宿主自适应（build-sidecar.mjs:388）→ x64 Mac 上该 macOS 腿假红。
- **A6（装配风险）缺源不清旧产物**：copyVendorDsh 的 `rmSync` 在 early return 之后（build-sidecar.mjs:273-275），copyPnpm 同形（:297-299）；runBuildSidecar 缺源只 warn 继续（:728-737）→ 持久装配目录会把上一轮 vendor/dsh、pnpm 带进 .app（release.yml 只 `test -f` 存在性）。
- **A7（跨语言锁步缺口）退出码 3/70 无锁步**：sidecar-exit-codes.ts:17-18 是单源，但 SidecarSupervisor.swift:416/423/427 硬编码字面量，SidecarSupervisorTests 用同样字面量喂假进程；CrossLanguageLockstepTests 只读 main.ts/shell-core.ts/sidecar-entry.ts（:82 起），不读 exit-codes 文件。
- **A8（潜在缺陷，对应 F11）Supervisor.decide 先于退出码分级**：SidecarSupervisor.swift:400-402 vs :408-433。
- **A9（覆盖缺口）LineReader/handleIncomingLine 读路径零测试**：BridgeClient.swift:60-130、553-597 的超长/非协议/非 UTF-8/overflow/EOF 残尾分支在 macos/Tests 无任何用例（A2 的 60 通道冒烟只发合法帧）。
- **A10（注释漂移）BridgeClient.stop 注释写 ≤2s**（BridgeClient.swift:426）与同函数 :430 的 5.0s 宽限矛盾；BridgeClientStopGraceTests.swift:32-35 记录的正是「按注释改回 2s」的历史回归。
- **A11（覆盖缺口）真实 BridgeClient.onTerminated→Supervisor 接线无测试**：BridgeClient.swift:377-379/501 与 SupervisorTests 的 FakeSidecar（:13-40）各自闭环；集成测试全走 stop()（主动摘 terminationHandler，:424）。
- **A12（弱断言）AppDelegate 5s 硬顶断言恒真**：CrossLanguageLockstepTests.swift:77 比较 `AppDelegate.quitCleanupTimeout == BridgeClient.quitCleanupGracePeriod`，而 AppDelegate.swift:25 本身就是该表达式；:504-508 的 asyncAfter 强退无行为断言。
- **A13（文档/注释漂移）design 25 §3.1 的 CLI 形状未实现**：design 25:193-195 写 `--pnpm-dir <dir> [--stdio|--socket <path>]`，而 sidecar-entry.parseArgs 只解析 user-data-dir/dsh-path/web-dist-dir/port/host-*-dir（sidecar-entry.ts:93-122）；pnpm 实际由布局相对解析（sidecar-ctx.ts:1258-1267；build-sidecar.mjs:156-171），stdio 恒为 stdin/stdout NDJSON（sidecar-entry.ts:175-178/562-572）。另 sidecar-ctx.ts:9-10 自述行号基于旧基线，:17/:21/:22 注释的 main.ts 行号已漂移（实测对应 main.ts:1564-1596/1580/1561）。
- **A14（无持久差异，注记）渲染器投递门多一道 webViewContentAlive**：node-edges.ts:206-218 的 delivered 判据比 electron-edges.ts:138-143 多一个 webViewContentAlive；WKWebView 内容崩溃但窗口对象仍在时 Swift 保守跳过 + loud，Electron 照发（消息丢），两端最终都靠渲染器重拉收敛。
- **A15（文案差异，renderer 不可感）事务 abort 文案**：sidecar-ctx.ts:2767 `sidecar is shutting down` vs main.ts:1129 `application is quitting`；进程同期退出，用户不可见，仅日志措辞不同。
- **A16（注释与实现矛盾）**：sidecar-ctx.ts:495-496 注释称设置损坏 loud，:497-505 实际丢弃 notice（= F14）。

## 方法说明与剩余不确定

- 逐函数覆盖：Electron 9 个主文件全部逐行读完（sidecar-ctx.ts 只核对与 B 桥/HostEdges/生命周期相关的段，已在覆盖清单声明）；Swift 7 个指定源文件 + 7 个指定 XCTest 全部逐行读完，另读了 AppDelegate/MainWindowController/SwiftEdgeHostLegs/NotificationDeliveryRegistry 作为接线证据。
- 并行分审计：本报告由 3 个并行只读分审计 + 主线复核合成——①Swift XCTest 全量（54 用例逐条）；②build-sidecar 装配链与打包测试；③sidecar-ctx.ts 全文（顶层导出 5 个、B 桥/HostEdges 交点、生命周期/资源路径/其余共享叶全量函数清单与逐函数镜像表）。三份分审计的每条结论均在主线抽查复核（关键行号已二次 read）。
- 未验证面（明确声明）：① 实机 GUI 行为（NSAlert sheet 归属、模态期间 WKWebView 冻结程度）只有代码证据，无实机截图；② Electron 的 ipcRenderer.invoke 拒绝对象是否保留 `code` 未在仓库内找到断言（F1 的「Electron 行为」按 renderer-trust.ts 的抛出点描述，页面侧两侧都以 message 为主）；③ 打包产物 release/sidecar 的存在性与布局由子审计核对了本机已有产物与 release.yml 断言，本次未重跑装配；④ sidecar-ctx.ts 的非 B 桥业务装配（约 2200 行）属 S-C 分片范围。

### 5.3 S6 待实机核验（不计入差异数）

## 待实机核验（不计入差异数）

- WKWebView 默认右键菜单具体项与禁用可行性（V12 的 Swift 侧前提）。
- Electron 默认应用菜单的确切项集（本机 node_modules 未下载 electron dist，无法在仓内取证；V3 的 Electron 侧只断言"未自定义"）。
- `SMAppService` 登录项在打包/非 /Applications 路径下的用户可见状态（`SwiftEdgeHostLegs.swift:419-450` 已实现，语义待实测）。
- backdrop-filter 在目标 macOS 版本的实际渲染（像素计数唯一候选）。
- C1 隐藏节流对 SSE/WS 的量化影响（STATUS 已挂 M5 实机门禁）。
