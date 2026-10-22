# Electron ↔ Swift 双 flavor 偏差登记（deviations）

> 文件定位：`docs/progress/STATUS.md`是唯一进度记录（未完成项、设计未决、范围决策）；本文件是
> 双flavor专项登记——用户可感的偏差（S）、有意保留的结构差异（T）、Swift leg接入缺口（P）、
> 门禁/覆盖缺口与文档漂移（G/D）、可达性纪律与盘点。本文件不是进度记录或验证报告：不记完成态、
> 测试计数、提交流水账。
>
> 本表逐行为当前结论：**状态**词即权威。只有 `open`（仍待处理）与 `accepted`（有意保留）留在正文；
> 消解落地（`resolved`）的条目移出正文，只在末尾「id 退役索引」留一行——现象、取舍与证据原文见
> git 历史与 design，不再复述。证据优先写符号锚（path#=literal:… / path#Symbol）；裸行号以当前工作树为准（D15）。
> 本表的 `open` 是**差异结论**，不是进度状态；open 行的进度、验收门与关闭条件以 [STATUS.md](STATUS.md) 为准。
> 状态以各条的「状态」列为准；仍 open 的条目集中在 §1（S 系）与 §4（G/D 系）。

## 0. 更新纪律

1. 每条登记五要素：现象 → 取舍/结论 → 证据（路径:行，双侧） → 状态 → 退役判据；同一差异只登记一次。
2. 状态取值：`open`（仍待处理）/ `accepted`（有意保留，需能解释为什么）/ `resolved`（消解，保留一行说明）。
3. 新双flavor偏差先进本文；未完成/未决的同时在STATUS.md留指针。消解落地即移出正文（含证据原文，见 git 历史），仅在末尾「id 退役索引」留一行 id 与结论，供历史引用解析。
4. 禁止把「实现方式不同但功能等价」写成缺陷——§2专门区分这两类。

## 1. 用户可感的功能偏差（S）

|#|现象（用户可感）|取舍 / 结论|证据（Electron ↔ Swift）|状态 / 退役判据|
|---|---|---|---|---|
|S-01|原生壳应用内更新链（下载→安装→重启）|Sparkle 2 实现（AppUpdater/菜单/Info.plist/framework/appcast）；不接 willInstallUpdateOnQuit（Electron autoDownload=false 下不触发）；退出安装走 Sparkle resumable。仅余外部门禁：EdDSA 密钥真实值、CI 编译证明、一次真实签名分发安装验收|E `updater.ts:947-948`、`main.ts:1102-1115`、`sidecar-entry.ts:505-521` ↔ S `AppUpdater.swift:34-43,182-216,360-366`、`Info.plist.template:73-92`、`release.yml:1069-1153`|open（外部门禁 + 实机）；退役 = 密钥/CI 生效且真实安装通过|
|S-04|双壳dsh-chamber:// 归属可能被Electron抢占|accepted（潜伏）：两flavor共用目录锁 ⇒ 同机只跑一个；被抢占 = 链接进另一flavor而其因锁退出；无生产者，不新增scheme；模板注释按该决定记录共存语义（D14 resolved）|E `package.json:35-39`、`main.ts:1011-1015`↔S `Info.plist.template:10-18,93-103`、`AppDelegate.swift:50-51,453`|accepted（实机观察项）|
|S-09|通知音效：Swift用具名系统音效（缺省Glass），非标准名由系统回落|accepted（功能等价；不做音效名映射表）|E `electron-edges.ts:157-162`↔S `SwiftEdgeHostLegs.swift:93-101,268-274`|accepted|
|S-10|隐藏窗口定时器节流|部分修复：Electron 恢复 Chromium 默认、Swift 仅 `WKWebViewConfiguration()` 默认；两 flavor 隐藏态同向无测量支撑（occlusionState 仅用于 hang watchdog 跳过，不是节流观测/配置；无 App Nap 观测；覆盖 vs App Nap 机制不同）|E `main.ts:855-870`（rAF 0、<1s 钳 1Hz、SSE 不受影响）↔ S `MainWindowController.swift#=literal:WKWebViewConfiguration()`|open；判据 = 打包态最小化/完全遮挡两工况的 rAF/定时器/`visibilityState`、hide ≥30s SSE/WS、唤醒重连与 CPU，回写本行|
|S-11|右键上下文菜单：Electron完全没有，Swift保留系统默认项集（macOS 不可定制）|accepted（方向与旧登记相反）：全仓0处context-menu处理器 + 从未setApplicationMenu ⇒ Electron不弹右键菜单（无右键复制/粘贴原生入口，Cmd+C/V仍可用）；WKWebView（macOS）公开面无右键菜单定制 API（`contextMenu*` 修饰符属 UIKit/SwiftUI 控件层、不作用于网页右键菜单；AppKit `NSView` 的 `willOpenMenu:withEvent:`/`didCloseMenu:withEvent:` 是视图自有 NSMenu 的回调，对网页内部菜单是否生效未验证——实机待确认）⇒ 保持平台默认项集（剪切/拷贝/粘贴/查询/翻译/服务…），不改项、不禁用；页面自绘菜单三处自行preventDefault 不变。语言随进程本地化（菜单文案走 NativeText；`AppleLanguages` 仅在与系统语言不同时写、启动期生效），外观随 `NSApp.appearance`；语义命令（Cmd+C/V/全选）由 Edit 主菜单承担，不依赖右键菜单存在|E packages/desktop grep context-menu = 0、`main.ts:519-541`（Menu唯一用法 = 托盘）↔S `macos/Sources/DSHChamber/MainWindowController.swift#setupWindow`（无 menu/contextmenu 覆写，保持平台默认项集）、`macos/Sources/DSHChamber/AppDelegate.swift#installMainMenu`（语义命令 Edit 主场）、`macos/Sources/DSHChamber/NativeText.swift#NativeText`（文案本地化）、`macos/Sources/DSHChamber/AppDelegate.swift#applyLanguage`（进程级语言）|accepted；退役判据 = Apple 在 macOS 侧为 WKWebView 放出右键菜单 API（或 NSView 回调对网页菜单确实生效）时重评并回写本行；另：任一侧改自定义/禁用右键菜单时复核。实机门禁 = 右键菜单语言（STATUS 与 S-53）|
|S-12|崩溃诊断无Crashpad（Electron有）|accepted（不引入新依赖）；要上报需单独立项|E `main.ts:279-293`↔S无对应面（仅Supervisor fatal文案）|accepted|
|S-13|目录锁获取晚于窗口构建（二次启动有极短空窗闪现）|accepted：重排收益过低；深链转发修复。更正：`activateExistingInstance`的`NSRunningApplication.activate`本身不带出隐藏/最小化窗口——该缺口由S-40的私有显窗通知补齐（先post恢复请求再activate）；本条只余取锁晚于建窗的空窗|E `main.ts:1011-1015`（取锁）先于`:4043`（建窗）↔S `AppDelegate.swift:336-339`（建窗）先于`:379-381`（supervisor.start取锁）|accepted|
|S-15|就绪门（ipc_not_ready）先于origin判定|accepted：expectedOrigin == nil时无可比较的可信origin，且该分支不授予能力；渲染端据码重试|E `main.ts:1388-1397`（窗口创建即固定expectedOrigin，无就绪码）↔S `MessageHandler.swift:192-203`、`MainWindowController.swift:163-166`、`bridge-hydration.ts:102`|accepted|
|S-17|sidecar起不来/宿主决策不可得/装配态host包缺失时，关窗与退出方向与Electron相反|accepted（fast-fail姿态）：Swift终态 = NSAlert（含原因）+ exit(1)，非静默崩溃。挂死子项：sidecar挂死致quitFacts 2s超时不再静默取消Cmd+Q——弹「dsh sidecar未响应退出请求」框，「继续等待」（默认/Enter）取消该次退出并恢复窗口，「强制退出」走既有 ≤5s清理链；动作映射单源见证据列|E `main.ts:1041-1113`（同步判据 + 确认框；will-quit 5s硬顶）↔S `AppDelegate.swift:528-575,652-679`、`QuitCoordinator.swift:83-96`、`:249-252`（host包缺失fatal）|accepted（挂死子项处理）；退役判据满足（loud提示 + 强制退出分支）|
|S-18|入站信封 >4MiB被frame_too_large拒绝；深度512/NaN归一化亦拒（Electron结构化克隆无）|accepted（防管道内存放大）；影响面仅极端行/载荷|E `preload.cts`无长度检查、结构化克隆无上限↔S `TrustGuard.swift:32,132-134`、`MessageHandler.swift:234,303-345`（frame_too_large拒绝 + 深度/NaN预扫描）、`sidecar-entry.ts:47,331`（入站上限在JSON.parse之前）|accepted|
|S-20|下载/安装的二次确认与窗口形态|accepted（可用、交互更重）：Swift需在Sparkle窗内再确认（下载/安装/跳过版本），Electron点击即下载；updateNativeAction现按kind分派（S-39），忙/不可用/未知kind诚实拒绝、不再回假ok:true；页面按钮始终只是入口，实际下载/安装在标准窗内二次确认（P-15 resolved）|E `updater.ts:1208-1269`↔S `SwiftEdgeHostLegs.swift:476-497`、`AppUpdater.swift:111-126,227-248`、design 25:715-720|accepted|
|S-28|凭据静态保护降级：Swift恒0600明文，无OS加密|accepted（Electron-free sidecar降级）：Electron safeStorage可用则加密、否则loud明文 + 渲染器secretStorage:plaintext；Swift无适配器（传undefined）⇒ 恒明文 + loud，macos全树Keychain/SecItem引用 = 0（仅 .build的Sparkle工具含），设置页恒显示明文存储；SSH密码两端同为0600明文|E `main.ts:1485-1499,1509-1540`、`shell-core.ts:1265-1281`↔S `sidecar-ctx.ts:346`、`gateway-provider.ts:783`、`ConnectionsSection.tsx:1457-1460`|accepted；退役判据 = 原生侧经壳Keychain提供crypto adapter，或维持accepted|
|S-33|首次关窗隐藏最多延迟2s（sidecar忙/挂死时）|accepted（健康路径ms级不可感）。机制更正：Swift并非「无缓存→每次B桥往返」——`cachedQuitFacts`命中时即时决策并顺手后台刷新（`AppDelegate.swift:586-597`）；无缓存/失效时才2s等待，超时保守隐藏|E `main.ts:927-933`（同步判定无往返）↔S `AppDelegate.swift:580-617,649-687`、`sidecar-entry.ts:250-264`|accepted|
|S-44|通知授权不对称：Swift首次投递显式requestAuthorization、denied诚实回错；Electron路径无授权查询/申请面|收窄为运行时**不可**达的残余（open）：Electron的诚实拒绝面在位——OS明确拒绝（failed）或限时无回执（timeout）被`describeNativeNotificationFailure`表述为「可能未授权/可能被系统抑制」并保留OS原文（`notifications.ts:467-530,532-559`、`electron-edges.ts:215-228`）。但Electron 43.4.0主进程确实无法预检查询/申请：`Notification`只有`isSupported/show`等、`getMediaAccessStatus`只接受microphone/camera/screen，typings无`requestAuthorization`/授权查询成员，其macOS实现`cocoa_notification.mm`的ScheduleNotification也从不requestAuthorization（`notifications.ts:532-543`引证）——授权状态只能由`addNotificationRequest`的completion handler回话（非nil error → failed事件）。Swift侧保持denied→fail、notDetermined→首次投递请求一次|E `electron-edges.ts:180-238`、`notifications.ts:467-559`、`electron.d.ts:10279,10534,14102`↔S `SwiftEdgeHostLegs.swift:107-110,427-457`、`AppDelegate.swift:93-103`|open（残余 = Electron预检查询/申请不可达）；退役判据 = Electron上游给出授权查询/申请API（或在实机证明系统弹框/拒绝面与Swift等价后记录为accepted）|
|S-48|ProMotion 120Hz 被 WebKit 偏好压到 60fps（低电模式 30）|壳侧独立 C target + `RefreshRatePolicy`，在创建 WKWebView 前关闭偏好；低电量 ×2 accepted（无公开开关，不做注入）|E 无对照（desktop 全树 refreshRate/preferredFramesPerSecond/prefer-60 = 0；Chromium 无该偏好）↔ S `DSHChamberWebKitSupport.m:72-87`、`RefreshRatePolicy.swift#=literal:static func apply(to preferences: WKPreferences)`、`MainWindowController.swift#=literal:RefreshRatePolicy.apply(to: configuration.preferences)`|open；判据 = 插电 120/低电 60/60Hz 外屏不回退三工况实机|
|S-50|根级回弹：固定区跟整页平移再弹回|壳以 WKUserScript（documentStart/仅主 frame）注入 `html, body { overscroll-behavior: none !important; }`；只落文档根，不动滚动容器/不加 contain。守卫 = CSP `style-src 'unsafe-inline'`（删/加 nonce/加 style-src-elem 都会复现）|E 未处理（`base.css` 无根级 overscroll）↔ S `ShellOverscrollPolicy.swift`、`MainWindowController.swift:233-241`|open（实机门）；判据 = 打包 .app 顶栏/会话栏/内容区两端零位移，滚动/惯性/键盘/缩放/拖拽无回归；macOS 14.4 复验|
|S-51|Swift 关窗决策线缺 `updateRestartArmed`|accepted（不可达）：Sparkle 安装链从不关应用窗口（发 stage2 后 `sendTerminationSignal`；InstallerProgress 只发 quit 事件），Swift 终止恒走 `applicationShouldTerminate`，故 Electron 的「更新器先关窗」时刻无对应物；接线零收益且会引入错误 armed 语义|E `main.ts#=literal:updateRestartArmed`、`chamber-settings.ts#shouldHideToTray` ↔ S `sidecar-entry.ts#=literal:quitFacts`（第 4 参默认 false）、`AppDelegate.swift#=literal:HostInboundMethod.quitFacts`|accepted；复核 = Sparkle 升级或改 user driver；若接线须 bump 关窗缓存世代|
|S-52|关窗决策在飞时吞 Sparkle quit 事件|open（非阻塞）：`applicationShouldTerminate` 在 `quitGate.beginDecision()` 失败时回 `.terminateCancel`，Sparkle 无超时等待；可达 = cache-miss ≤2s 窗与 quit 相撞（~0.6，未实机）；可经检查更新/下次退出自愈。修 = 区分「在飞决策」与「重复退出」，前者 `terminateLater`|S `AppDelegate.swift#=literal:退出决策在途，忽略重复退出请求` ↔ E 无对应面；Sparkle `SPUStandardUserDriver.m:862-880`|open；验收 = 实机复现后安装不再被吞|
|S-53|壳级语言/主题跟随不同|Swift = 页面事实 + 进程级重启生效（菜单/托盘/对话框即时重建；`AppleLanguages` 仅在不同于系统时写；外观默认跟系统）；Electron = 英文默认菜单 + 硬编码中文对话框（从不 `setApplicationMenu`），与页面语言/主题无关联|E `main.ts#=literal:buttons: [copy.quitButton, copy.cancelButton],`、desktop 全树 `setApplicationMenu` 零命中 ↔ S `ShellPageFacts.swift#ShellPageFactsScript`、`AppDelegate.swift#=literal:private func installMainMenu()`、`AppDelegate.swift#=literal:static func applyLanguage(`|accepted（有意差异）；实机 = Sparkle 标准窗语言/外观、zh-Hans 匹配、切主题即时性|
|S-54|原生快捷键服务输入源不同|Electron = 主进程 `before-input-event`（组合投递、`setIgnoreMenuShortcuts`、blur/导航复位；偏好 `keybindings.json` 0600）；Swift = documentStart DOM 桥（keydown/keyup 归一、revision；偏好仅会话内存）。Swift 边界：无 preventDefault/子 frame/原生菜单源/`closeWindow` A 桥通道|E `shortcuts-bridge.ts`、`preload.cts` ↔ S `bridge-shim.js`|open（accepted；可选加固：close 方法/偏好落盘/子 frame）|
|S-56|Swift/WKWebView 取不到 DOM File 宿主路径|Swift = 拖拽板快照 × 事件批次相关性：目录按名（size=0 优先）、文件精确字节数、各消费一次、批次门 5s、目录快照无 TTL、上限 256、配不到即 ''；入稿归属 = vendor 补丁给 ui-attachment 加本壳 `[data-instance]` containment；两 flavor 共用 painted 门控。Electron = `webUtils.getPathForFile`，行为同上游|E `preload.cts`、`upstream-seats.test.ts` ↔ S `HostPathCatalog.swift`、`bridge-shim.js`、`host-path-scope.ts`、`bridge-shim-host-paths.test.ts`|open；残余 = 打包态实机（拖入/回形针/慢悬停/远端回退/浏览器文案）、painted 是协作标记非安全边界、Swift 不覆盖粘贴、同名歧义回退上传、远端文件夹整批作废、壳外 drop 不入稿、150ms 轮询隐藏态仍唤醒；判据见 design 25 §5.7|

## 2. 结构性 / 有意差异（T，非缺陷；除注明外均 accepted）

|#|维度|Electron flavor|Swift flavor|结论 / 状态（为什么可以不同）|
|---|---|---|---|---|
|T-01|页面桥|preload + contextBridge（隔离world）|documentStart注入shim + window.webkit.messageHandlers|两侧契约（通道/形状/错误码）一致；A桥面按命名空间逐成员程序化比对。accepted|
|T-02|IPC编码|结构化克隆|JSON（envelope ≤4MiB，深度512/NaN拒绝）|协议可见形状相同；超限行为见S-18。accepted|
|T-03|宿主进程|Electron main + electron-updater|Swift壳 + Node sidecar（stdio NDJSON JSON-RPC）|宿主语言不同；sidecar复用core注册体；runtime core吃同一提交物。accepted|
|T-04|更新实现|electron-updater（latest-mac.yml/beta-mac.yml）|headless控制器（GitHub releases查询）+ Sparkle 2（appcast-swift.xml + EdDSA）|D-1=B后安装腿由Sparkle承担；两端更新源/密钥独立；发现单源化成立（S-21），beta滚动通道enclosure可下载且beta可见final（S-22/S-36）；节奏差异见S-37会话依赖残余。accepted|
|T-05|签名与entitlements|Developer ID + 公证 + stapler/spctl；主app entitlements含JIT/unsigned-exec-memory/disable-library-validation|dry-run为ad-hoc；主app仅disable-library-validation，捆绑node单独JIT entitlements|凭据门禁两侧fail-closed、属外部依赖；主壳不需要JIT是有意最小权限。accepted|
|T-06|目录锁|Darwin O_EXLOCK加O_NONBLOCK（`chamber-lock.ts:33,88-175`）|flock(LOCK_EX/LOCK_NB)（`SidecarSupervisor.swift:32,60-144`）|同一 .dsh-chamber.lock；锁文件仅诊断，内核锁是唯一裁决（design 25 §6.3）。accepted|
|T-07|打包布局|electron-builder（asar/extraResources；vendor/dsh版本一致断言）|.app + Contents/Resources/sidecar（内建node + dist/web；.modules.yaml断言）|锁步由packaging-manifest + build-swift-app断言；两侧断言并集才完整；web dist过滤与vendor/dsh断言由装配门禁覆盖（G39/G40 resolved）。accepted|
|T-08|页面surface暴露次序（成功路径）|preload info 1+10次重试，成功后exposeInMainWorld（`preload.cts:885-886,905-922`）|shim同1+10次，仅成功后expose（`bridge-shim.js:606-627,653-661`）；ready后壳触发一次rehydrate（`MainWindowController.swift:924-932`）|正常序（ready先于页面、首轮info成功）同序即等价；preload失败分支仍暴露null标量面，见T-12。accepted|
|T-09|非交互宿主腿|每次调用都发生；dialog异步不占主进程|状态型腿合流、事件型腿逐条排队（上限8），放弃前补发最新队首并loud；NSAlert/NSOpenPanel runModal占主线程，模态在屏时非交互腿最多延迟 ~25s或loud丢弃（`SwiftEdgeHostLegs.swift:205,539-598,643-680`）|合流会让事件静默丢失，排队是等价的可见性保证；「模态是阻塞源」是有意取舍。accepted|
|T-10|开发者工具|打包态默认菜单仍可开DevTools|发布态默认无检查器；用户在设置 → 通用 → 更新区内的「调试模式」开关显式开启后，运行期置 `macos/Sources/DSHChamber/MainWindowController.swift#=literal:webView.isInspectable = enabled`（Safari「开发」菜单据此可附着），关闭立即收回并写 `[shell]` 行（请求值 + 实测值都记）；`#if DEBUG` 构建仅在**无设置文件或文件级损坏（不动作）**时保留默认开（开发便利）——合法文件（含缺 `debug` 键的，按 Electron 默认 false）下一次启动即按持久值覆盖|从「构建期常量、发布态零入口」改为「运行期、持久化、显式用户裁决」：调试面在发布包可达是本次的产品决定（本地调试难点 = 默认全关），代价是本机可读写页面；默认仍关。accepted|
|T-14|bundle 标识/应用名|Electron appId `com.dshchamber.desktop`/productName `dsh-chamber-electron`；Swift `com.dshchamber.native`/CFBundleName `dsh-chamber`/可执行 `dsh-chamber`，可见名统一 `dsh-chamber`（窗口/失败页/提示框单源 displayName）；About 读 CFBundleName；日志前缀 `[shell]`|E `packages/desktop/package.json`、`main.ts:title` ↔ S `Info.plist.template`、`MainWindowController.swift#=literal:static let displayName = "dsh-chamber"`、`ShellIdentityTests`|有意（T-14/T-17 同源）；改名须同步 T-14/T-17/T-22 与两侧测试|
|T-15|托盘/状态栏创建门与tooltip|仅app.isPackaged且icon.png存在才建；tooltip含控制面URL + 连接态（`packages/desktop/main.ts#=literal:function maybeCreateTray(cp: PlaneHandle)`）|恒建NSStatusBar.statusItem（`macos/Sources/DSHChamber/AppDelegate.swift#=literal:NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)`），图标=应用图标（自持 18pt 图：`macos/Sources/DSHChamber/StatusItemIcon.swift#=literal:static func make(from source: NSImage?) -> NSImage`），tooltip恒dsh-chamber，无destroy|dev态Swift有图标而Electron无；tooltip文案非契约。accepted|
|T-16|宿主事实缓存|notificationSupported/badgeCountApiAvailable每次实时探测（`electron-edges.ts:202-208,223-225`）|缓存常量true，无推送路径（hostFacts只收布尔键，`node-edges.ts:199-202,384-386,410-412,600-614`）|macOS恒true；失败在调度/写dock时loud。accepted（低优先）|
|T-18|Web存储/session隔离|默认持久session落userData（`main.ts:1221`）；DevTools面板可见jar|默认持久WKWebsiteDataStore（macos不设store覆写；落 ~/Library/WebKit/DSHChamber/WebsiteData，打包态随com.dshchamber.native）|Web存储不跨flavor：localStorage的布局/宽度偏好各自独立（`ConversationRoot.tsx:30,230`、`ui-layout stores.ts:11-20`）；登录态不在渲染端jar——上行cookie恒剥离（`proxy-forward.ts:215-222`）、响应头白名单不含set-cookie（`:189-206`）、实例鉴权cookie由控制面自铸且仅内存（`browser-auth-cookie.ts:24-40`），两侧同政策。§4的jar观察项闭环。accepted|
|T-19|文件选择器 accept 过滤|Chromium 原生按 accept 过滤|Swift 侧运行期取 `allowedContentTypes` selector（`FileOpenPanel.swift#=literal:static func allowedContentTypes`）；当前 SDK 未暴露 ⇒ 空过滤器、不过滤，未来暴露即按类型过滤|现前端无 `accept` 消费者 ⇒ 零可见影响；上游引入 accept 后自动生效。accepted（潜伏，零消费者）|
|T-20|媒体自动播放默认|默认`autoplayPolicy='no-user-gesture-required'`（`electron.d.ts:19204-19207`），未覆写|未设`mediaTypesRequiringUserActionForPlayback`（macos树grep=0）→ WebKit默认生效|前端全树无audio/video/new Audio/.play() 消费点 ⇒ 零影响；引入媒体时需复核两侧默认。accepted（潜伏，零消费者）|
|T-21|JS对话框（alert/confirm/prompt）|Chromium/Electron弹原生模态对话框|WKUIDelegate三个`runJavaScript*Panel`均未实现（macos树grep=0）⇒ WebKit默认confirm=false、prompt=null、alert静默|出货前端零消费者（dist 0处`window.alert/confirm/prompt`）⇒ 当前零影响。触发条件 = 前端引入任一API；影响 = 该交互在原生壳静默取默认值（不弹窗），与Electron分叉。accepted（潜伏，零消费者；引入前先实现三回调或改自绘对话框）|
|T-23|WebKit ITP（ResourceLoadStatistics）活跃|Chromium无对应的script-writable存储清理策略|本机`~/Library/WebKit/DSHChamber/WebsiteData/ResourceLoadStatistics/observations.db`有表且持续更新（打包态随`com.dshchamber.native`）|触发条件 = WebKit对长期不交互站点的script-writable存储清理生效；影响 = native侧localStorage UI偏好（布局宽度、open-in选项、git源分支）回默认，无数据丢失。无公开API关闭（私有`_setResourceLoadStatisticsEnabled`不采用）。accepted（潜伏；长期实机观察或T-18的jar策略变更时复核）|
|T-24|媒体采集用途描述（`NS*UsageDescription`）|产物Info.plist带Camera/Microphone/AudioCapture/Bluetooth四键|`macos/Info.plist.template`零`NS*UsageDescription`；媒体权限回调一律deny（`MainWindowController.swift:1319`起）|当前零可达路径（采集恒拒，前端0处getUserMedia）。触发条件 = 放行任一采集能力；影响 = macOS因缺用途描述由TCC终止进程。accepted（潜伏；放行前必须先补用途描述）|
|T-26|旧系统（<14.4）兜底面在新支持矩阵下不可达|Electron与本仓同一下限14.4（`build.mac.minimumSystemVersion`）；其自带V8/Chromium运行时、不依赖OS WebKit，无「旧WebKit缺API」类退化路径|支持矩阵14.4（精确值由`Info.plist.template:54-62`承担）；design 25 §5 E14提到的「旧系统NSLoginItem兜底」没有实现代码——`setLoginItem`叶只走`SMAppService.mainApp`（`SwiftEdgeHostLegs.swift:605-618`），`macos/Sources` 4处旧下限注释与E14按新下限改写|触发条件 = 按旧注释或旧E14以为存在 <14.4退化路径；影响 = 仅注释/文档层面不可达（<14.4连`LSMinimumSystemVersion`都过不了），无功能差异。accepted（注释层面）|
|T-28|渲染引擎差异（Chromium 150 ↔ WKWebView/Safari 17.4）|corner-shape `@supports` 在 Safari 整块跳过（保持正圆角）；裸 `scrollbar-width:none` 无 `::-webkit` 兜底会露滚动条；`field-sizing`/`text-autospace` 被忽略。①corner-shape 待 vendor 单点裁决；②tooltip/appearance 待补；③④引擎降级登记；⑤发丝边框/字体光栅 accepted|E ui-theme `corner-shape.css:16-25`、`scrollbar.css:44-58` ↔ S 同包 `@supports` 跳过；U1 证据 0.3.1/native beta.2 CSS/JS 逐字节相同|open/accepted 混合；退役 = ①落 accepted 或 vendor 裁决，③④有兜底或随 14.4 退役|
|T-29|发布命名后缀归属|Electron腿的app/DMG/zip/安装器名 = `dsh-chamber-electron`（`build.productName`；`release.yml`的`BASE`/`APP_DIR`同步）；Swift原生腿 = 裸名`dsh-chamber`（`--app-name`/`--artifact-basename`）|与更早的归属相反（旧：Electron裸名、Swift `dsh-chamber-native`）。不动的面：appId `com.dshchamber.desktop`、原生CFBundleIdentifier `com.dshchamber.native`、共享userData身份（顶层`name` = `@dsh-chamber/desktop`，见T-14）、目录锁路径、深链scheme `dsh-chamber`、Electron `latest*/beta*` feed名与Sparkle `appcast-swift*.xml`名。迁移面：旧 .app目录名不会自动改写（更新只替换当前bundle）；bundle id与用户数据路径不变，权限/凭据/共享锁不受影响，清爽目录名需重装。统一名称（T-17）：Swift壳可执行名由`DSHChamberPoc`改为`dsh-chamber`、模块/target改`DSHChamber`（资源包随之`DSHChamber_DSHChamber.bundle`），同样重装后生效|有意（用户指令）；证据 = `scripts/release/release-artifacts.mjs`单源 + `release-workflow-policy.test.mjs` + `build-swift-app.test.mjs` + `ShellIdentityTests`|
|T-30|窗口拖拽实现|`-webkit-app-region` 由 Chromium 消费（`base.css:55-58`；标记行 = ui-theme CHROME_ROWS），页面零 JS；WKWebView 不认且 `mouseDownCanMoveWindow=false` ⇒ 壳注入 mousedown，命中 `[data-window-drag]` 且未命中控件时 preventDefault + 合成 leftMouseDown/performDrag；同一批标记与 INTERACTIVE_SELECTOR 锁步|E `base.css`、`upstream-seats.test.ts` ↔ S `ShellWindowDrag.swift`、`regions.ts`|accepted；退役 = WebKit 放出等价 API（届时只余几何盒序差异）|

## 3. Swift leg 接入缺口 / 待裁（P）

|#|现象 / 缺口|证据（E ↔ S）|可达性 / 状态 / 退役判据|
|---|---|---|---|
|P-08|宿主事实时效：Swift读事件缓存|E `electron-edges.ts:231-239,257-287`（live）↔S `node-edges.ts:194-207,437-455`、`MainWindowController.swift:414-461,697-741`|accepted（登记的近似语义）；关键裁决前同步round-trip会阻塞IPC，不采纳|
|P-09|进程级故障恢复方向相反|E `main.ts:249-273`↔S `SidecarSupervisor.swift:386-457`|accepted（路线A的结构性收益）|
|P-10|dev实根不同 ⇒ dev双flavor目录锁不互斥|E `electron-dev.mjs:14-23`、`launch.mjs:121`↔S `ChamberResources.swift:200-207`|accepted（dev隔离有意；打包态同根由chamber-lock.test.ts锁步）|
|P-14|外链冷却/预算拒绝无提示|E `shell-core.ts:1288-1291`↔S `MainWindowController.swift:827-833`|accepted（两侧等价，观察项）|

## 4. 门禁与覆盖缺口（G）+ 文档漂移（D）

> resolved项保留一行说明；其余为open（测试/门禁/文档可信度缺口）或部分修复（行内注明残余）；退役判据 = 被测试或门禁钉住，或明确豁免并说明理由。

**门禁 / 覆盖**

- G19 部分修复（open）：CI中启动签名/公证的打包 .app仍不可达（凭据 + GUI会话）；现仅静态校验（`.github/workflows/release.yml:635-667,1125-1189`），双击 → sidecar spawn → dist/web装载仍属release/实机验收项。

- G43 accepted：`packages/dsh-api-gateway` 是第二实现型 fork——4 个上游 client 文件约 4,600 行 + 4 个 chamber 文件 + `@dsh-chamber/dsh-stream-state` 依赖；registry 已按 fork 登记（authority: chamber、deviations: [G43]、gates = test/typecheck:api-gateway + typecheck:connection + verify:upstream-lifecycle-contract + 3 条 patch-lock），升级按 fork 重放。退役 = 上游提供等价可靠面；F1 开帧相位机已整体退役，保留补丁面 = 载波重试、30s 首帧期限、journal 看门狗、mux 自查。

**文档漂移（D）**

- D15 open：docs 的 `文件:行` 锚点写死（`docs/**` 迁移后实测 678 处），代码增删即过期且位移不均匀；**不按偏移批量刷**。退役 = 待合并分支落地后按符号 grep 语义重锚、新登记优先写 `path#=literal:…`，并调低锚点预算。工具已进 `check:static`；具体快照与样例存 git 历史。

**待实机核验（盘点未覆盖，不计条目）**

- Electron默认菜单项集可由pinned上游`default-menu.ts`/`menu-item-roles.ts`核对（M4）；WKWebView右键菜单项集/禁用可行性属实机（S-11）；缩放 ± 步进语义（0.5 zoomLevel vs ±0.10 pageZoom）属纯像素比对（T-22 resolved）。
- 文件拖拽（W3-2）的实机行为——S-25回形针/下载腿实现，拖拽是剩余摄入路径。
- ATS loopback（S-45残余实机）：macOS 14+ 真机验证Swift首载HTTP loopback（双侧ATS逐键相同）；例外域不含`::1`——`DSH_CHAMBER_CP_URL`指IPv6环回时native落失败页、Electron正常（A3）。Electron safeStorage在目标机Keychain恒可用的假设（`main.ts:1509-1540`）。
- 隐藏/遮挡态（S-10的开放实机门）：最小化与完全遮挡（未最小化）两工况的rAF/定时器/`visibilityState`/App Nap语义、hide ≥30s的SSE/WS心跳、唤醒重连、隐藏期CPU（W6-3/design 25 §8.1 C1·§8.5 G5）。存储jar与登录态闭环（T-18：登录态不在渲染端jar，控制面自铸内存cookie；仅localStorage UI偏好不跨flavor）。
- S-32（Dock/托盘恢复最小化窗口）、S-35（放行CSP后的blob文档预览渲染）、S-40（隐藏窗口二次启动的恢复）、S-42（首帧/首个已提交内容时序；打包态首载复验——宿主须不占用17500，否则先命中共享目录锁）、S-43（Return/小键盘Enter/Esc在真实退出确认框）各自的实机观察；S-23版本键映射、S-34 loadedOnce门由单测闭合。
- 通知：S-44残余——Electron无授权预检/申请，实机看首次投递的弹框/拒绝面是否与Swift等价；授权重置后不主动重问（§5）、已拒绝时add的错误文案与`{shown:false,error}`复核、P-07多横幅淘汰。
- 纯像素不计条目：字体/文本渲染、滚动条、窗口初始位置（`main.ts:842-845`不center vs `MainWindowController.swift:245-256` center）、backdrop-filter在目标macOS的渲染。（根级回弹单列S-50。）
- S-24 菜单入口（Cmd+? → 项目页外部打开预算；File/Force Reload/Substitutions响应链）与「检查更新…」并存观察；打包态菜单无DevTools项（检查器改由设置页开关开启，T-10）。
- S-21/S-37/S-38/S-39原生更新整链（页面「检查更新」→ `updateNativeAction kind=check` → Sparkle appcast → 页面相位；坏feed/坏密钥、忙态拒绝与标准窗聚焦）实机观察；S-37会话依赖节奏（scheduled投影后到重启前不再后台检查）；S-36真实beta下载+安装（beta.N → beta.N+1 → final可见）——归S-01外部门禁。
- S-41/P-20打包态登录项read-back（损坏设置不动登录项、requires-approval诚实错误）；G19的CI内签名 .app启动/双击 → sidecar spawn → dist/web装载不可达（凭据 + GUI会话，归release/实机）；native GUI装配验收由G33进CI，剩余 .app双击与WKWebView页面。

## 5. 未决 / 待评估

- S-01 的Sparkle外部门禁：EdDSA密钥secrets、CI编译验证、实机安装验收。密钥缺失的自相矛盾形态由G42在发布链fail-closed（公钥在而私钥缺、私钥在而appcast缺均FAIL；两把都缺仍loud降级）；潜伏钩子子项：`willInstallUpdateOnQuit`删除（理由见S-01；`AppUpdater.swift:37-43`），退出时安装由Sparkle标准resumable路径承担。
- 通知授权的「重置后重问」与Electron预检：当前首次投递时请求，重置后不主动重问；Electron无授权查询/申请API（S-44残余），诚实面只覆盖「OS拒绝/限时无回执」。待评估是否与上游/实机对齐后记accepted。
- 登录自启的替代路径：若`SMAppService`在ad-hoc/未签名分发下失败，launchd LaunchAgent是已知可行替代（无移植实机证据）；Electron read-back补齐（P-20 resolved），只剩打包态实机观察（§4）。
- 打印/页内查找：两端皆无（`electron.d.ts:9653`无print/find role；macos grep printOperation/find = 0）；任一端将来加入口时Swift必须实现`printOperation(with:)`，否则成新缺口。
- 许可文本随包：两端都不随任何顶层许可/第三方声明（Electron mac打包显式删LICENSE/LICENSES.chromium.html：`electronMac.js:219-221`；Swift只解bin/node：`build-sidecar.mjs`；THIRD_PARTY_NOTICES.md只在release校验）——共同缺口，需单独立项。
- CSP frame-src（裁定）：补最窄`frame-src blob:`（`packages/control-plane/src/index.ts#createControlPlane` 的响应头组装处），HTML文档预览的blob: iframe具备渲染条件；Swift只放行非主frame（S-35）。真实渲染仍属实机（§4）。
- test-windows腿的Windows用户路径缺口由`docs/progress/TODO.md` B§2.2 台账承载，不并入本表。

## 6. 可达性优先：纪律与盘点

### 6.1 纪律（所有双端差异核对照此执行）

1. 先查可达性：调用点/消费者（`grep "edges.<member>("`、A桥通道消费者、host包域使用者）；无调用点的差异记为潜伏差异，不进修复队列。
2. **只修「可达且用户可见」的差异**；修复位置优先`macos/`。
3. 跨出`macos/`必须给出调用点证据：只有「新增能力/通道/契约」才允许动共享面，否则只登记不动手。
4. 契约面 ≠ 功能面：接口有成员不等于用户路径有行为。

### 6.2 HostEdges 可达性盘点

> 判据 = core调用点/消费者（全仓grep，排除 .test.ts）；逐成员证据原文留存git历史。

- 可达15（parity必对齐面）：rendererPush、showNativeNotification、notificationSupported、setBadge、badgeCountApiAvailable、onSystemResume、onMainWindowShown、isFocused、webViewLoading、webViewContentAlive、mainWindowAlive、retireNotificationsForSources、openExternal、showError、showMessage。（pickPluginSource 随 2026-09 C 分层插件写面退役删除：宿主腿、edge 契约、Swift picker body 与相关用例同批移除。）
- 潜伏8（零消费者，不进修复队列）：trayAvailable、isPackaged、focusMainWindow、openPath、showItemInFolder、launchApp（对称缺席，S-05）、setKeepAwake、setLoginItem（成员潜伏；能力经ctx `sidecar-ctx.ts:283`可达）。原notifyClicked/resolveResource随P-03删除。
- 附注：模态阻塞源见T-09；宿主事实时效见P-08；trayPresent事实 = `main.ts:1352`的`tray !== null`对照`sidecar-ctx.ts:345`恒true，`chamber-settings.ts:594` darwin短路true。

### 6.3 A 桥面（页面 → 壳）可达性（结论修正）

> 判据同旧：surface方法是否有消费调用点（通道字符串不是判据）。

- 有调用点：restartAndInstall/download/openReleasePage（`update-store.ts` 定义 131/108/150、surface 调用点 140/114/154）、runtime-management八项、onIntent、onResume、desktopSsh的instances_get/delete_connection/save_connection/set_password/set_gateway_*（sidebar）、vscodeOpenInNewWindow。
- 潜伏面：无。`desktopSsh.instances_set` 删除（通道/shim 方法/preload 与 renderer 声明/生成物/pin 计数同步），原「legacy no-op 通道」偏差随之关闭。
- 更新面修正：`kind=check`单源成立（S-21）且页面消费者真实；`kind=download/install`按kind分派到Sparkle标准窗、忙时带回真实原因（P-15/S-39），能力面携带真实error（S-38）。契约对齐由`bridge-manifest.json` + `bridge-shim-surface.test.ts` + `ipc-surface-mirror.test.ts`锁定；payload与shim运行时执行由`verify-shim-payload-shape.mjs`运行时臂锁住（G22 resolved，计数见G34）。

## 附：已消解条目（id 退役索引）

> 消解落地即移出正文（现象/取舍/证据原文见 git 历史与 design）；此处只留 id 与一行结论，供历史引用解析与检索。
> 仍待处理（open）与有意保留（accepted）的条目在上文 §1–§5，可达性纪律与盘点在 §6。

- **S 系**：S-02 渲染器卡死无自愈；S-03 非法显式端口/dev 端口耗尽；S-05 原生壳无本地 open 执行面；S-06 page world 可伪造；S-07 网页权限；S-08 close-behavior=quit 时取消退出后的窗口状态；S-14 A 桥错误对象带 .code 的能力差异；S-16 --skip-web-dist 之外的装配一律要求；S-19 原生更新阶段在页面零呈现；S-21 更新发现双源不一致；S-22 beta 通道无原生安装腿；S-23 CFBundleVersion 去掉 beta 后缀；S-25 composer 回形针；S-26 Session 日志导出；S-27 首载失败终态；S-29 跨 flavor 凭据不可读：先 Electron 后 Swift；S-30 LSMinimumSystemVersion 支持矩阵；S-31 Electron DMG 未公证/装订；S-32 最小化窗口的恢复；S-34 Swift 卡死自愈缺 loadedOnce 门；S-35 子 frame 导航策略；S-36 Swift beta 应用内下载 404；S-37 后台检查节奏**只**数值相等；S-38 坏 EdDSA 公钥/feed**不可**用时页面可永久停在「检查中」；S-39 updateNativeAction 忙时静默 no-op + 菜单；S-41 chamber-settings.json 损坏时 Electron 静默；S-42 启动窗口时序；S-43 退出确认框的 Esc 行为；S-45 ATS loopback 配置不对称；S-46 Swift About 面板缺版权行；S-47 打包态 zh 本地化资源被 electron-builder 静默删除；S-40 同 bundle 二次启动恢复（残余实机观察见 §4）；S-49 初始窗口视口高度单侧对齐（实机目检并入 S-48）。
- **T 系**：T-11 打包态开发环境覆盖面；T-12 info 总失败分支的兜底；T-13 信任谓词严格度；T-17 可执行名/进程名；T-22 页面缩放持久化；T-25 排障日志面；T-27 首帧/重载底色。
- **P 系**：P-01 sidecar 帧长护栏；P-02 ready 帧 port 已校验（不一致 fatal），无消费者的是 shellVersion；P-03 两个保留契约成员 Swift 语义不同；P-04 sidecar 无内建 dsh workspace 回退；P-05 host 包源目录 8 层向上启发式探测；P-06 通知/Badge「已应用」回执缺失败与超时面；P-07 通知满额；P-11 pre-spawn 时间回退；P-12 落盘设置读取严格度；P-13 Swift 布局锁步锚点不全；P-15 update.download/install 在 Swift 零可达消费；P-16 dev 端口退避耗尽的最后一级；P-17 登录自启两条 Swift 侧缺口：reconcile 丢弃应答；P-18 shim 资源缺失 fail-open；P-19 重复注入守卫只在已暴露态惰性；P-20 登录自启失败面的镜像缺口。
- **G 系**：G1 Swift 测试为一等门禁；G2 run-swift-tests.mjs:102-111,130-131；G3 60 通道冒烟按命名空间对代表通道断言 wire 形状；G4 产物门；G5 build-sidecar.test.mjs:76-111,132-136；G6 非 dry-run 的 vendor/dsh 与 pnpm 缺源在任何写盘前 fail；G7 SidecarExitCodeLockstepTests.swift；G8 SidecarSupervisor.swift:386-441 先做退出码分级；G9 BridgeClientLineReadTests.swift:45-158；G10 BridgeClient.stop 注释给出与实现一致的 5s 宽限；G11 SidecarSupervisorTests.swift:400-439；G12 CrossLanguageLockstepTests.swift；G13 design 25 §3.1 与实现形状一致；G14 投递门单源为 rendererPushDelivered；G15 RUNTIME_ABORT_REASON 单源在 shell-core.ts；G16 appcast 步移到 notarize/staple 之后并签最终 zip；G17 POC 桩例更名；G18 assertNodePinTable() 在动网络前执行；G20 新增 scripts/gui-acceptance/native.mjs；G21 渲染器自愈策略抽成共享纯函数并行为测试；G22 verify-shim-payload-shape.mjs 增运行时臂；G23 Swift 门禁跑 release 配置；G24 verify-test-wiring.mjs:61,344-369 覆盖；G25（细节见 git 历史）；G26 packaging 闭包 checklist 增原生壳节；G27 after-pack-adhoc-sign.mjs；G28 Electron 腿加 release-only 步；G29 Swift 上传用精确产物路径；G30 --dry-run 校验并打印已解析计划；G31 默认回退改为 loud {ok:false,error:…}；G32 G4 的产物冒烟；G33 native 装配验收有 CI 机器门；G34 shim 载荷面总数为断言；G35 RUNTIME_ABORT_REASON 接线锁覆盖两侧；G36 Electron release 验证/装订改按精确产物名；G37 ELECTRON_NODE_PINS 固定表把映射变成无条件断言；G38 图标缺件与 electron-builder 同姿态 fail-closed；G39 build-sidecar 的 copyVendorDsh 在拷贝前与落盘后各…；G40 Swift 装配的 dist/web 拷贝；G41 Electron mac 打包演练进 push 门禁；G42 Sparkle 密钥与发布物 fail-closed 门禁。
- **D 系**：D1 bridge-shim.js 头部改述 sidecar；D2 BridgeShimInjector.swift:6-8 注释按实现改写；D3 preload.cts:394,705 注释与实现一致写 onChanged；D4 design 25 的 sidecar-ctx.ts 锚点刷成当前值；D5 bridge-shim.js:64-67,437 的 loud stub 描述删除；D6 design 25 §0.1-E2/:110/§7 与当前 UI 能力门语义一致；D7 装配态 web dist 候选序为「resourcesDir/dist/web → sidecar/dist/web」（AppDelegate.swift 的 resourceURL 优先；dev 走 packages/desktop/dist/web；PackagedLayoutTests 钉住）；D8 锚点校正：行为属实但旧锚点错；D9 模板注释/取值与出货行为一致；D10 design 25:467-472 与实现语义一致；D11 scripts/release/release-artifacts.mjs；D12 锚点校正：行为属实（copyTree 无返回值，直调、无恒假判断）但旧锚点错；D13 权限锚点刷成当前值；D14 Info.plist.template:10-18 的共存注释按 S-04。
