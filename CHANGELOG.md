# Changelog（变更日志）

本文件记录 dsh-chamber 的全部重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目遵循[语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

发布产物与各版本的发布说明同时发布在 GitHub Releases 页面
（`https://github.com/panzeyu2013/dsh-chamber/releases`）。

> English: [docs/CHANGELOG.en-US.md](docs/CHANGELOG.en-US.md)


## [0.3.2-beta.4] - 2026-09-20

### 新增
- **本地来源缺图端点现在给出病因，而不只是后果** —— 新增 boot-gap 事实 `local-graph-not-injected`（仅本地实例；远程与 gateway 逐字保留）：本机实例没有注入 chamber 的客户端图通道时，横幅先报「安装 / seed 完整性」这一病因，并以优先级压过 5 秒后到达的 `required-services-missing` 后果；同一 ready 世代内可撤销、可复查（判词后 +30s 有界复查，provider 迟到即清事实），不再长期挂着并白烧一次冷重挂。
- **诊断点名缺失的提供方** —— 控制台诊断行由只报「等待者 ui-chat」升级为同时给出缺失提供方（`sidebarRight → @deepseek-ai/dsh-client-ui-sidebar-right`）；未登记的服务显式写 "provider row unknown"，缺行的病因不再零日志。
- **Windows 腿开始跑前端契约，发布证明要求 Windows 打包彩排** —— ci.yml 的 Windows 腿新增 renderer 与 sidebar 的 `test:win32` 清单（根 `test:win32` 扇出到 5 个包，每包一个可点名的步骤），每个清单带「零测试即失败」守卫；`verify-release-ci-proof.mjs` 的 `REQUIRED_JOB_STEPS` 同步要求这两步与 Windows 打包彩排，删步/改名即红。
- **通知失败不再是无解的死路（design 19 §3.3/§4.1）** —— `dsh-chamber:notify` 由布尔改为 `{ shown, error? }`：宿主/系统的拒绝原因与裁决侧抑制原因穿过 IPC 保留；新增 `dsh-chamber:open-notification-settings`（固定主进程侧 URL，不接受渲染端传入），设置页据此渲染原因、权限提示与「打开系统设置」按钮（中英）；映射纯函数有单测，Swift 壳把授权裁决与投递失败写入 native-shell.log。
- **会话流健康臂（design 14 §D4）** —— api-gateway 流载体改为重试而非终态失败并投影页级 `stream-carrier-failed` 事实；open-in 插件渲染会话流健康 chip 座位；控制面记录被放弃的升级以便归因；修复被判定失败后立即**锁存**重载动作（判据挂在 settle 时钟而非相位，`loading` 驻留与隐藏期都不再吞掉它），载体重连的抖动也不再只留在闭包里。
- **macOS Swift 原生壳（design 25 路线 A，预览）** —— macOS 上新增第二只壳：Swift/AppKit 只做壳（窗口、WKWebView、菜单/通知/角标/深链/对话框/外部打开/隐藏恢复），**壳内不承载任何业务**；业务由打包成独立 Node 可执行文件的 sidecar 承载（现有 control-plane 与 desktop 的纯 Node 业务模块族原样运行），Swift 与 sidecar 之间走一条受信的 stdio JSON-RPC 通道，页面侧用与 preload 等价的注入 shim 顶替 `window.dshChamber`，web UI 100% 复用。与原 Electron 版**共存**：产物为 `dsh-chamber-<版本>-macos-arm64.dmg/.zip`（本版起命名归属反转，见「变更」），bundle id `com.dshchamber.native`（通知授权身份独立），双 flavor 共用同一 userData 根与目录锁（`<userData>/.dsh-chamber.lock`，darwin `flock`/`O_EXLOCK`，锁本身是唯一仲裁权威），并保证关窗决策只吃**本世代**的关闭语境事实：取消退出后不再沿用旧决定，设置变更与 sidecar 重启各失效一次、重启后再预热一次以保住 ms 级关窗。
- **原生 flavor 的应用内更新链（design 25 §7，D-1 = B）** —— 改为 Sparkle 2：检查真实 appcast（EdDSA 签名；公钥/私钥由发布链配置），支持应用内下载、安装与重启，并保留用户手动的「检查更新…」；beta 通道用滚动 appcast 同时收当前 beta 与最新 final，让 beta 客户端也能看到 final（S-22/S-23/S-36）。更新面不可用、坏 feed/坏公钥或忙态点击都返回诚实错误而不是静默吞掉（S-37–S-39）。
- **双 flavor 防漂移锁步与新 CI 腿** —— IPC 面镜像（main/preload 两侧字面量与结构）、桥 manifest（`bridge-manifest.json` ↔ 生成的 Swift 白名单，通道 68 = 60 invoke + 8 push）、注入 shim 表面、core 的 electron-free 传递闭包、打包清单与产物命名（`-native` 不含碰撞、更新 feed 归属唯一）各有独立门禁；新增 macOS CI 腿 `test-macos`（Swift 构建 + XCTest + 打包干跑 + darwin 目录锁与打包脚本套件），发布证明要求 linux/windows/macos 三腿同时通过。
- **打包链** —— `build:sidecar`（官方 Node 归档按仓库固定 SHA-256 校验后捆绑，基名必须是 `node`；内置 dsh 工作区与内嵌 pnpm）与 `build:swift-app`（组装 → ad-hoc 或 Developer ID 签名 → 公证 → stapler 装订 → 归档，任一缺失即 fail-closed），同一 tag 下与 Electron 产物并行发布、互不覆盖。
- **原生壳本地落盘日志（design 25 排障面，T-25）** —— 原生壳此前双击态白屏/退出没有任何本地 dump 可考古；现在关键行（启动、sidecar spawn/退出、导航失败、更新相位、退出链）同写 `<userData>/logs/native-shell.log`，256 KiB 单份轮转（`.1`）、0600/0700，写不进静默退回 stdout。它**不**复用 Electron 的 `<userData>/state/host-logs/<port>.log`——那是控制面按端口寻址的宿主 stdout/stderr 管道，两条日志面不同目录、不能混用；唤醒与「壳→页面」推送的每一跳（含失败分支）也走这条日志，真机上能分清「没发」与「没消费」。
- **Electron mac 打包演练进 push CI（G41）** —— main push 的 `test-macos` 腿新增 ad-hoc、`--publish=never`、无凭据/无公证/无上传的 `electron-builder --mac --arm64` 演练，并紧跟 `verify-electron-artifacts.mjs` 对真实 `.app` 校验；发布证明（`verify-release-ci-proof.mjs` 的 `REQUIRED_JOB_STEPS`）同步要求该步名，删步/改名即红。代价 = macos 腿每次 push 真跑一次打包（时间变长），换取 files/extraResources/beforePack/afterPack/entitlements 的破坏在 push 即暴露，而不是等到 release（draft 已建、凭据已加载）才失败。
- **更新链 fail-closed 门禁（G42）** —— 正式发布中 Sparkle 公钥在而私钥缺 = FAIL（壳会轮询没人签的 feed）；私钥在而 beta/stable appcast 缺失 = FAIL（不再静默跳过滚动发布）；`/releases/latest` 解析失败（非 404）或 final 有 native zip 但下载失败 = FAIL；新增 `verify-native-appcast.mjs` 断言本版本 appcast 条目同时带 `shortVersionString`=本版本、`sparkle:version`=本 `.app` 的 CFBundleVersion、enclosure 指向本版本 zip（appcast 步与滚动刷新两处都跑）。两把钥匙都缺仍是 loud 降级（照常出包、客户端看不到更新）；仓库尚无 final release 或最新 final 确实没有 native zip 时保留 loud 警告。
- **原生壳跟随显示器刷新率（S-48）** —— 原生 flavor 此前把渲染上限压在接近 60Hz：面板是 ProMotion/高刷时会明显比 Electron 侧"钝"。现在按所在显示器的刷新率取整跟随（低电量模式减半），偏好必须在 web view 构造前应用，且**先读回确认可写**再改；实测原生壳 114–120fps。
- **原生壳视口弹性回弹消除（S-50）** —— macOS WebKit 在视口层做橡皮筋：指针停在不可滚动 chrome（顶栏、会话栏头部）上滚动、或某个滚动器到端点继续滚时，整页（含 `position: fixed` 层）会被整体平移再弹回。壳在 configuration 段以 documentStart、仅主 frame 注入一条根级 `overscroll-behavior: none !important` 规则关掉它，不动任何滚动容器的滚动语义。
- **控制面与 sidecar 的诊断也落盘（T-25 扩展）** —— 继原生壳本地日志之后，控制面日志与 sidecar 诊断同样按 0600 落盘：双击态出问题不再只能靠系统日志猜。
- **未就绪来源的 boot 死区可以逃出去（design 05 §4.1）** —— 远程来源未就绪时点开会话，此前会停在全窗遮罩上等最长 135s 的收割臂，期间没有任何导航出口。现在遮罩按相位给动作：未连接（idle）立即给「连接」+ 切换行且**不启动 boot**；`error` 与托管 `stopped`/`restart-exhausted` 在 1.5s 宽限后判不可服务（不再等满 60s）；`degraded`（重连在途）不判死、仍在预算内等；挂死 boot 超过反馈窗（10s）后给重试/连接/切换 + ⌘R 提示；502（隧道通、远端端口死）是非阻断横幅并按 ready 世代自愈一次。
- **侧栏会话 running 位陈旧会自愈** —— 会话已被判定结束、running 位却没收敛时，聊天面此前会一直不渲染：现在由侧栏会话事实与渲染位活性守卫三层收敛，聊天面恢复挂载。
- **gateway 登录页阶段预热（design 17 §10.6）** —— 未登录访客在输入密码时即预取**真实的** `/plugins` bundle URL（HTTP 缓存按 URL 建键，包装 URL 拿不到收益），登录后首屏直接取用整册前端 bundle（实测约 4.35 MiB gzip），不再落在关键路径上；能力由一枚短时 HttpOnly cookie 承载（HMAC、客户端地址绑定、120 s），该路由在认证门之前被咨询，但只认两种真实 bundle 形态 + 有效 capability，缺/过期/篡改/他人 cookie 一律落回原有 401/session 判定与类别审计，其余 `/plugins/**` 不放开；限速与容量 fail-closed（超限 429/503，且限速只对已验签的 capability 生效），并带 `--no-warmup` / `DSH_GATEWAY_WARMUP=0` 关闭开关（关闭时登录页 HTML 逐字节回旧模板）。

### 变更
- **win32 私有状态读写不再要求 `O_NOFOLLOW`** —— 平台没有该旗标时改为身份回退：open 前后 lstat 拒符号链接并以 dev/ino 复验，不可证即 fail-closed（不再在事务首步抛错）；Windows 上 `<userData>/dsh-runtime` 已存在也不再被误判为 corrupt 而永久阻断。登记为 design 23 F8（身份回退的 TOCTOU 残余）。
- **win32 插件打包改用 node 启动 pnpm** —— Windows 上不再直接 spawn `pnpm.cmd`（Node ≥ 20.12 拒绝 `.cmd`），改为 `node <pnpm.cjs>`，POSIX 保持裸 `pnpm`；`resolvePnpmBinDir` 补上 win32 候选与随包 pnpm。
- **打包闭包 fail-closed** —— afterPack 对所有平台断言打包运行时树含 `ui-sidebar-right` / `client-resources` / `ui-chat`，启动期再做一次可执行路径抽检并 loud 记录；缺件的运行时不再能出厂。
- **任务栏徽标开关按能力位门控** —— `supported.badgeSupported` 在 win32 为 false，设置页据此禁用开关并给出原因（此前是一个无解释的无效开关）。
- **原生壳页路径的主线程序列化成本下降** —— `writeJSONString` 由逐标量拼接改为一次 UTF-8 扫描（纯 ASCII 约 10.9×，密集转义仍有 2–5×），信封先取可靠上界、只在边界回落精确测量（1 MB 信封的门禁 3.01 ms → 1.57 ms），输出逐字节不变。
- **文档修正** —— README（中英）的 userData 路径改为 `%APPDATA%\@dsh-chamber\desktop`；DEVELOPMENT（中英）的用户可见 Windows 打包目标改为仅 nsis；打包清单计数校正。
- **桌面主进程拆分为 electron-free 核心 + 两套宿主边沿实现** —— `main.ts` 的编排与业务逻辑抽到与 Electron 无关的 `shell-core.ts`，Electron 原生边沿留在 `electron-edges.ts`，Node/sidecar 侧边沿在 `node-edges.ts`；Electron 版行为不变（真实依赖 Electron 的仅 4 个文件，由传递闭包门禁断言），原生 flavor 复用同一业务代码。
- **`dsh-chamber:info` 与宿主事实面提供 flavor 判别位**（页面可按 flavor 分支），宿主事实（焦点/窗口显示/系统唤醒）在两侧同源推送。
- **macOS 最低支持版本抬到 14.4（S-30）** —— Electron `build.mac.minimumSystemVersion` 与原生壳 `LSMinimumSystemVersion` 同写精确 14.4，`Package.swift` 写 `.macOS(.v14)`（SwiftPM 只能写 major）。原因：原生壳跑 OS WebKit，出货 bundle 在审批决策、用户提问/计划评审、PDF 预览构造路径直接调用 `Promise.withResolvers`，该 API 自 Safari 17.4 / macOS 14.4 才存在，13.x 与 14.0–14.3 会构造期 `TypeError`；Electron 自带 V8 不受影响，但同一支持矩阵只保留一个下限（不加 polyfill）。
- **原生壳窗口几何向 Electron 收窄（S-49）** —— 原生壳与 Electron 的窗口高度差距收窄到显式折中值（1280×786），并把该折中登记为可复核的偏差条目。
- **协议写侧与帧上限收严** —— sidecar 出站帧加上限、协议写侧改为有界写：超大响应 fail-closed 结算全部未决请求并响亮上报，不再让渲染端请求永久悬挂或让缓冲无界增长。
- **原生壳热路径成本下降（性能）** —— 去掉热路径上的重复工作与每帧分配，实测原生壳稳定在 114–120fps。
- **发布命名归属反转：Swift 原生壳 = `dsh-chamber`，Electron = `dsh-chamber-electron`** —— 原生腿的 .app/DMG/zip/卷名去掉 `-native` 后缀改用裸名，Electron 腿的 app/安装器/产物名加上 `-electron`。appId、原生 CFBundleIdentifier、共享 userData 身份（`@dsh-chamber/desktop`）、目录锁与深链 scheme `dsh-chamber` 全部不变，因此权限、凭据与双 flavor 共存语义不受影响；既有安装的旧 .app 目录名不会自动改写（更新只替换当前 bundle），要清爽目录名需重装。

### 修复
- **win32 存活探针不再只认英文 `LISTENING`** —— 新增 `Get-NetTCPConnection -State Listen` JSON 主探针（纯解析器有测试）+ 大小写不敏感的 netstat 回退，共用 500ms 缓存；非英文 Windows 不再把活着的端口判死。
- **残余后代按 PID 直杀前先复验身份** —— 击杀前用同一张 CIM 表核对 ProcessId + CreationDate/CommandLine，不匹配跳过、不可证 fail-closed；`kill(pid, 0)` 在 win32 不再当作存活证据。
- **icacls 校验不再恒假** —— flags 改为 token 集解析（真实 `(OI)(CI)(F)` 与 `/grant` 旧式渲染同集），ACE 尾按最后一个 `:` 锚定、空格路径不再污染 principal；继承 ACE、Everyone/Users/SYSTEM 与 DENY 一律判失败，隐私校验重新有判别力。
- **win32 安装器的发布/备份 rename 走重试路径** —— 与运行时共用 `renameWithWindowsRetry`，不再因瞬时占用失败回滚整个事务。
- **seed 产物缺件不再静默跳过** —— 源目录在而 `dist/index.js` 缺时点名 id/包/路径与后果（打包 host 条目按 error 记），全缺仍清 overlay 并返回 null。
- **无法验证的 running 位不再长期保留** —— 事实读持续失败到界限后只清 running 断言（行/分组保留、不触发归档回流），并把来源交给既有的会话停滞横幅「无法确认会话状态」，下一次成功读取（push 或 unary）立即恢复；侧栏的陈旧远程 running 位由本地裁决清除（本地判词 + 独立 unary 权威读，确认后经上游公开的 `handleSessionStatus(id, false)` 写回），不再需要上游补丁。
- **流抖动下聊天面与侧栏座位保持可见** —— 四个 `from-opacity:0` 入场动画在隐藏/被遮挡的 N-ctx 壳里可能冻在第一帧，让 HARNESS 标记与设置齿轮「不可见但仍可点」；这些动画已退役，隐藏壳门禁同步收紧。
- **WebKit 下设置页的服务器选项按压不再丢失** —— WKWebView 不在 mousedown 聚焦按钮，下拉的搜索框随即 blur（relatedTarget: null）并关闭 portal，切换服务器的 click 到不了已卸载的行；现在抑制 mousedown 默认行为直到 click 生效（与上游 MenuView 同一手法），键盘 Enter、外部 pointerdown、遮罩与 Escape 语义不变。
- **原生 dmg 带上拖拽安装提示** —— 原生 dmg 此前只有 app 与 /Applications 软链，Finder 打开是白面板；现在由 `macos/scripts/dmg.mjs` 统一产出带 electron-builder 同款背景与图标坐标的 UDZO 镜像，并在装配时做**内容级**自检：读 `.DS_Store` 断言背景类型、指向卷内背景的别名、图标尺寸、窗口尺寸与两条图标坐标，缺提示或坐标错的 dmg 不再能出厂。
- **系统唤醒后原生 flavor 的立即重连与补发从未生效** —— 唤醒通知此前注册在错误的通知中心，现已注册到 `NSWorkspace.shared.notificationCenter`。
- **keep-awake 不再连带阻止显示器休眠** —— 与 Electron 的 `prevent-app-suspension` 语义（以及 design 14 D5）对齐：只防系统休眠。
- **确认对话框不再把正文显示两遍**（调用点把标题与正文传同一文案时，原生壳此前两处都渲染）。
- **sidecar 重启不再丢弃已缓冲未发送的深链** —— 复位只落就绪位，缓冲保留并在下一个 ready 帧按 FIFO 补发。
- **超大响应不再让渲染端请求永久悬挂** —— 超过帧上限的响应改为 fail-closed 结算全部未决请求并响亮上报。
- **退出清理显式收回 keep-awake 与 Dock 角标**。
- **打包 .app 忽略 `POC_*` 环境覆盖** —— 这些 dev/POC 开关此前在装配态仍生效，可被环境变量重定向到任意 node、sidecar 脚本、web dist、userData 或控制面 origin；dev（`swift run` / 非 .app）路径不受影响。
- **测试门的本地误红与 CI 首跑暴露的 `build-sidecar` 缺陷** —— desktop 测试清单锁步此前会扫描到 `packages/desktop/.dev-user-data`（dev 运行态里的另一份 worktree）导致本地 `check:tests` 失败，现已忽略该目录；`build-sidecar` 在干净 checkout 的「缺内置 dsh 工作区」警告分支因注入 io 缺 `warn` 抛 `TypeError`，现已回落控制台。
- **原生壳下载落盘与 Electron 对齐（S-26）** —— 此前 Swift 弹 NSSavePanel（可取消），而 Electron 全仓没有 `will-download`/`setSavePath`、走 Chromium 默认静默写 `~/Downloads`；现在 Swift 经 `DownloadDestination` 静默落盘：目录缺失即建、重名按 Chromium ` (n)` 去重、在途路径预留防同批撞名，解析/创建失败诚实取消并落盘原因（绝不静默换路径）。已知小偏差（accepted）：WebKit 无 `.crdownload` 中间态，下载中崩溃可能留下带最终名的半成品（Electron 留 `.crdownload` 不冒充成品）。
- **原生壳页面缩放跨重启保持（T-22）** —— `WKWebView.pageZoom` 此前只活实例、每次启动回 100%；现在按 origin 存 UserDefaults（装配时恢复、zoomIn/zoomOut/reset 写回，坏值 normalize+clamp），与 Electron 的按 origin 持久化同向；存储介质仍是各 flavor 自己的偏好存储，不跨 flavor 共享。
- **打包态 zh 本地化资源不再被静默删除（S-47）** —— mac 腿的 `electronLanguages` 改写成 Electron 真实目录拼写 `["en","zh_CN"]`（app-builder-lib 只做精确/前缀匹配，`"zh-CN"` 永远匹配不到 `zh_CN.lproj`，于是中文 `locale.pak` 被删、Chromium 级文案回退英文；顶层连字符值保留给 win/linux `.pak` 腿）；afterPack 与产物门禁对真实 `.app` 断言每个声明的 locale 都带出且 `locale.pak` 非空。
- **一个瞬时的 unknown 判定不再触发唯一一次 L2 重连** —— 当结果刷新窗（150s）短于合并窗（200s）时，单次瞬时探测失败会被当成确定失败、把该 spell 唯一的一次 L2 重连烧掉。现在首次 `unknown` 只顺延一次截止时间（有界升级，第二次不再顺延），并且 App 把共享重连台账喂给规划器，被推迟的 L2 不再让守卫沉默一个退避窗。
- **日志不再穿过符号链接写** —— 控制面与 Swift sidecar 两侧都拒绝符号链接的叶子/目录（此前只在构造时校验一次，`start()` 的无条件重开会重新激活降级 sink）；权限在每次打开时重申（0700/0600 只在创建时生效）；外部删除后有界自愈；轮转被阻塞时降级到 stdout，不再把水位清零导致文件每轮涨约 2 倍。
- **失败覆盖层出现时把遮罩移出 DOM** —— 此前遮罩按钮留在 DOM 里仍可聚焦/被读出；队列提示不再挂在 `aria-busy` 下；遮罩切换失败会如实上报，不再留下粘住的放弃标记。
- **渲染位活性边界按决定性结算取水位** —— 迟到/乱序的结算不再把已经推进的失败判定拉回，也不再把同一 tick 的边界判定误判。
- **重放器不再认领身份未验证的遗留 token** —— 控制面回收器对遗留 token 的接管要求条目自身的 dsh 身份可识别，否则保留并记为 identity-unverified，避免误杀他人进程。
- **CSP 的 style 源按生效链求值** —— 有效 style 源按 CSP3 回退链（`style-src-elem` → `style-src` → `default-src`）与大小写不敏感 nonce/hash 求值，注入的根规则因此不会被"别处还有一条 style-src"骗过。
- **跨语言锁步测试不再被注释骗过** —— 两处装配锁步此前匹配原始源码，把 apply/install 调用注释掉仍然绿；现在先剥离注释行再匹配。
- **移动端 composer 不再被键盘盖住** —— 旧的键盘补偿靠 `innerHeight` 与 visualViewport 推断键盘高度，并把偏移同时写成 sticky bottom 与滚动器 padding（滚动器又是 sticky 的包含块，实测越顶 368px、另有被盖 +336px）；现在直接量会话滚动器边框盒的重叠——这个量在本守卫自己的写入下不变，验证环因此有不动点——只写 frame 自定义属性 + 一个 in-flow spacer 提供滚动余量，配 96/72px 迟滞、有界复测（≤2 步）与 `data-mobile-kbd-state` 诊断面；载体若反常地随写入移动则锁存并如实上报，不再爬升。
- **Git 工作树删除对话框不再自相矛盾** —— 风险确认此前声称「分支不受影响」，而同一流程另有「同时删除本地分支」勾选；现在只陈述将被丢弃的内容，分支去留交给那个勾选项。

## [0.3.1] - 2026-09-15

### 新增
- **托管宿主的应用日志桥（opt-in；design 18 §3.4 诊断面）** —— 托管 dsh 此前没有任何可打开的应用日志面：web CLI 只有 `--host/--no-open/--port/--trusted-host`，运行时也不装 exporter（`LoggerService` 只有 1000 条内存环），进程内的事故无法从外部定位。现由 `DSH_CHAMBER_HOST_LOG_LEVEL` 开启：不设/off 时 profile overlay 字节不变，设为级别名取该 Cordis 阈值，未知值按保守 `warn` 挂载并**响亮告警**（阈值是单调的：`warn` 含 info）。实现是 chamber 自己生成的一个无依赖 Cordis 插件、挂到既有 seed 通道，把消息写到 stderr，再由既有的子进程输出管线脱敏并滚入 `host-logs/<port>.log`；脱敏规则同时抽成可单测的纯函数。它**不**进 `CHAMBER_HOST_PACKAGES`——无 Typert Remote 域，注册表行会因为缺探针域而激活失败。
- **移动端会话打开面重做（design 17 §18.6）** —— ① 会话头拥挤（面包屑条被强制换行，未分类的子代理计数跨 CJK 词断成五行、把 30px 行推到约 96px）改为官方单行 + 横向平移：手机档 48px 行高 + 顶部/右侧安全区，写明收缩顺序（当前面包屑先让宽，谱系 chip 不缩——它是子代理目录的唯一入口），谱系触发起码 44px 触摸底线，两个图标座按 border-box（否则刘海侧画到视口外）；480/360 两档约束 agent-preset 标签，此前那条 `> button > span` 规则没有任何注册方渲染，是死代码。② frame 打章改为**全有或全无**：会话列缺失就不打章，vendor 改中心槽位名时样式表的列锁不会把转录钉死在 0px 首轨；抽屉开关/背幕只在真的找到 sidebar 角色时渲染（无死控件、无孤立遮罩），探针把结果记进 `data-mobile-roles`。③ **会话打开卡死提示**：客户端与宿主都不给会话打开设期限，流卡住时转录会永远停在「加载历史」。现用一个纯属性判定的提示（active/settling 会话根、无锚点行的聊天流、已渲染的会话头，持续 45s **可见**时间），只提供一个**用户主动**的刷新动作，绝不自行重载或重开会话；提示自身的文案节点从不被匹配。
- **仓库门禁、单入口检查与移动端走查工具箱** —— 新增三个此前不可见的门（`verify:test-wiring`：磁盘上每个测试都必须可达；`verify:md-links`：自有文档的相对链接与锚点必须可解析；`verify:workflow-yaml-scalars`：形如 `single entry: ...` 的步骤名是非法 YAML，而纯文本检查全绿）与一个 `pnpm run check` 单入口（`scripts/dev/run-checks.mjs` 的 static/tests/typecheck 模式，本地与 CI 同源，不再维护平行清单）；`release-preflight` 现在会扫描 `packages/` 与 `scripts/` 的 `FIXME` 并在未决时阻断发布（须显式 `--allow-fixme` 才放行，让「带着 FIXME 发布」变成记录在案的决定，`TODO`/`XXX` 仍只作背压标签）。验收面新增 **CDP 移动端走查**（`Emulation.setDeviceMetricsOverride` + 触摸模拟 + WebSocket 帧捕获；判定以设备宽度为准，因为 `mobile:true` 的 shrink-to-fit 会让 `scrollWidth <= innerWidth` 自证成立；凭证只从命令行点名的环境变量读、经脱敏后才落任何输出）与**移动端插件锚点保鲜门**（逐条声明的锚点必须仍被钉住的上游发出，19 项最小集合兜底；无上游树时 fail-soft 并打印跳过了什么），并给 control-plane / dsh-runtime / renderer / gateway / cli 五个核心包补契约 README。

### 变更
- **gateway 安装单元补全登录环境（design 17 §5）** —— 默认服务形态（`SERVICE_USER` 为空）不渲染 `User=`，而 systemd 只对带 `User=`/`DynamicUser=`/`PAMName=` 的单元设置 `$HOME/$LOGNAME/$SHELL`，于是 gateway 与它拉起的每个子进程（托管 dsh → 代码运行时 → bash 工具 → gh / npm / git credential helper）都在**空 HOME** 下运行：gh 报未登录、npm 找不到缓存、git 凭据助手读不到 token。`write_unit` 现在只为该形态注入 `HOME/LOGNAME/USER/XDG_CONFIG_HOME`，取值来自**运行用户的 passwd 条目**（绝不是安装者的 `$HOME`，sudo 可能把它带过来），取不到就是硬失败；`--service-user` 形态保持 systemd 自己的推导、不注入。**迁移**：就地部署需重跑一次 `install` 以重写单元（会同时重新生成凭据）。
- **代理压缩协商（design 17 §8、design 03）** —— 此前每个被代理请求都被剥掉 `accept-encoding`，强制托管宿主以 identity 应答，而钉住的 gzip 中间件本可压缩：官方前端首屏是单个约 10.65 MiB 的 client-module combo（内嵌 document-preview 的 pdfjs-dist），实测按配置级别 1 压到 4.16 MiB。现在**只有**代理自身需要原始字节的两处保留 identity：HTML 文档导航（S0 信任注入要前插脚本并重算 content-length）与 `Accept: text/event-stream`；其余交给上游协商（其自身过滤器已拒绝 event-stream 与 content-range）。同一提交落地窄接口 `ProxyForwardDeps.onUpstreamResponseHeaders`（在重算 content-length 之前调用、fail-soft）并导出 `isHashedStaticAssetPath` 供 gateway 复用。
- **gateway 的 CSP 允许上游 `<base href="/">`** —— `@deepseek-ai/dsh-host-frontend-static` 会给每个渲染的 index 文档重新注入 `<base href="/">`（它的 SPA 深链修复）。在 `base-uri 'none'` 下浏览器直接拒绝该元素，深链于是把自身的 `./assets/...` 解析到深链路径、404、白屏；代理无法重写流式 HTML（正如无法回填 nonce），故 `base-uri` 跟随 `script-src` 取同源允许值，其余指令逐字节不变。
- **gateway 对内容哈希静态资源给 immutable 缓存** —— 官方前端由 `dsh-host-frontend-static` 提供，它只写 content-type（没有 Cache-Control/ETag/Last-Modified），于是即使 Vite 给每个文件名带了内容哈希，重复访问仍可能整包重下。现在对**恰好** `/assets/<name>-<8 位哈希>.(js|css|woff2?|svg)` 的普通 200（无 content-range）补 `cache-control: public, max-age=31536000, immutable`，并按证据判定而不只看路径：上游没有自带 cache-control/etag/expires、路径无百分号转义或点段、content-type 是该扩展名真能产出的类型；`favicon.svg`、`manifest.webmanifest`、`index.html`、`.map` 与任何 range 响应永不匹配。接口在代理重算 content-length 之前运行，不会破坏 framing。
- **auth 拒绝审计按窗口合并** —— 每个被拒请求此前都要追加一行并 fsync；一次无凭证的手机加载会打出成串记录（manifest/图标/service worker 全部无凭证），一次页面浏览要付若干次同步 fsync，还产出若干行完全相同、读者读不出额外信息的记录。现在按 `(client, code, path category)` 分窗：首个事件仍立即落盘（「确实发生了」这个证据不能等计时器），窗内重复只计数，窗口关闭时写一行带 `count:<n>`（含首个锚记录）；不同 client/code/路径类永不合并。窗口状态在 dispatch 闭包里（不是模块单例），计时器 `unref()` 以免拖住进程，`quiesce()` 释放所有权前排空所有窗口；不同客户端身份是无界的，故窗口表有上限，到顶时提前发布最旧的窗口而不是无限增长。
- **受保护集合加入版本维度（design 21 §6.11.1）** —— 安装后校验此前把每个顶层拷贝都按 dsh 代际串判定，于是安装官方 opt-in 层会以四条 finding 响亮失败：它的传递 experimental 包是官方 scope 但不在 F（C11 禁止该段），而被改 scope 的 vendor 包（cosmokit、schemastery）保留上游版本、永远不等于代际串。现在 F 在名字集合旁另带 **name→version 事实**，并有一条第二信任判据：当名字与版本两个解析器对同一批键说法不一致时拒绝该来源（而不是静默丢掉版本维度、把误报放回来）。校验按固定顺序跑两条臂：命中 F 的名字按本运行线**能提供**的版本判定（无事实表的调用方保留代际臂，§6.11.4），不在 F 的名字仅在**官方直接依赖**的闭包能到达它时才豁免——闭包只展开官方节点，第三方中间人无法为官方名字背书。桌面主进程与 gateway 执行器都传事实；内建锚仅当它就是当前活动运行线时使用，环境提供的 dev 树可回落到锚以免写面降级。
- **工作区创建/接管走单一事实通道（design 05 §2.2.1、design 08 §4.2）** —— Git worktree 插件此前用自己的 unary `workspace.create` 创建/接管工作区，只有侧栏的加工作区对话框会发布工作区回声事实；对**未挂载 shell** 的来源，全新（0 会话）工作区没有别的读通道（unary 兜底从会话 cwd 派生分组，已推送过的来源其工作区集合是冻住的），于是那一行只有用户点开该服务器才出现。现在 create/delete/rename 统一经 `shared/workspace-mutations.ts` 包装：每个包装既发线调用又发布对应的一次性事实，调用方无从遗漏；Git 创建携带放置锚（回声行直接落在主检出下面而不是尾部）并在发布**之前**完成装饰（`beforePublish`，worktree 标记与未注册折叠在同一同步续段里写入），接管也携带分支标题，于是行一出生就是最终形态与位置。同批修掉回声规则的两个审阅发现：锚放置改为按锚分组并重新查位（原游标存绝对下标，插入的锚会把下一行提前一格），接管装饰跳过主检出（此前会把主行标成派生 worktree）。

### 修复
- **重启 dsh 后新装/重打包的客户端插件不出现（design 18 §3.6 项 8）** —— 窗口的 client 插件集在每个实例壳 boot 时固定（宿主图每 boot 取一次、页面模块表按 id first-load-wins），重启 dsh 只刷新宿主侧，于是新装或重打包的 `dsh.client` 半身（例如设置分节）要等**整个应用重启**才出现。现在由 sidebar 共享面的 **page-owned completion** 收尾：按来源 key（`local`/`gateway-<id>`/`dsh-<id>`）单飞、**发起面板卸载不取消**、就绪预算内未恢复则**不重载**并如实报错（绝不把失败藏进一次新 boot）、结算后可重试再 arm。接线范围：「重启 dsh」两种形态、本地「立即应用/重试应用/重试恢复」三类重启事务（仅成功时）、本地卡「启动」/写者接管、gateway 卡「重启 dsh」/「启动实例」、插件对话框 footer 重启与全部 restart-to-apply（行删/加/导入/撤销/批量应用）、ssh 卡「重启实例」（仅 dsh 目标）；「重启网关服务」（systemd）不改变实例插件集，**有意不接**。设计 18 §3.6 项 8 记下契约、接线清单与被拒替代。
- **gateway 不再把「读不出来」当作「没有要保留的」** —— 两条写面路径曾把读取失败折叠成「空」，后果是**删除证据**：① profile manifest 超过读取上限、父目录是符号链接或不是合法 JSON 时引用集合为空，暂存的每个 `.tgz` 都会被当作孤儿删掉——现在非 ENOENT 的读失败、非法 JSON 与损坏 journal 都会**阻断**清扫并响亮告警，只有真正的 ENOENT 保留原清理语义；② 损坏的 journal 解析成空列表，于是对账报告「没有待处理操作结转」、从不回收已记录的子进程，随后的 prune 还会删掉丢失操作的 preImage——现在损坏与空 journal 可区分、原始字节保留为 `.corrupt-<ts>` 旁证、证据未决期间 prune 保留所有 preImage、无法改名旁置的文件绝不被覆写。
- **插件归档完整性（构建与扫描两侧）** —— ① ustar 的 name 字段是 **100 字节**，而构建器按 UTF-16 码元比较，CJK 路径能通过检查却在头里被截断、构建器仍报告完整名字；现在按 UTF-8 字节长度度量，边界钉在 100 vs 101 字节。② tar 读取器此前返回归档顺序里第一个可解析的 manifest，而 pnpm 安装的是 `package/package.json`，构造一个带诱饵根 manifest 的归档就能让写面判错包名；现在优先安装路径、根 manifest 只作兜底，申报与安装身份不一致时带两个名字响亮失败。③ gateway 扫描器的 manifest 捕获没有关闭，manifest 之后的任何条目都会被追加进捕获字节、把合法归档判为 `tgz_invalid`，且超大候选是粘滞的、捕获没有上限；现在捕获随候选数据区关闭、超大按候选判定、只保留有界的申报字节。
- **控制面代理的响应头白名单与日志桥卸载** —— ① `onUpstreamResponseHeaders` 回调之后重新施加 `RESPONSE_HEADER_WHITELIST`：回调写 `content-length`/`transfer-encoding`（或任何非表示头）不再能上到线缆（JSDoc 声称 framing 不可触碰，但 `content-length` 不在白名单里、且只在上游声明过它且响应不是 SSE 时才被重新推导）；chunked 与 SSE 两种形态都有测试。② 生成的日志桥 exporter 改为经插件**自己的** `ctx.effect` 挂载：cordis 的 `LoggerService.exporter()` 把 effect 注册在服务 ctx（app root）并返回该 disposer，直接注册会在插件卸载后存活，loader remount 会叠第二个 exporter、把每行应用日志写两遍。③ 不可变缓存规则改用共享的 `isHashedStaticAssetPath` 而不是裸 `/assets/` 前缀（后者会把未来某个未哈希条目钉住一年）。
- **连接页 live-state 单元格不再把 bundle 层误报为待重启** —— 该单元格按精确模块名匹配 Loader 快照，而 `dsh.bundle` 包永远不是 Loader 行（组合树是空根条目列表 + 各 bundle `cordis.patch.yml` 的插入行），于是每个 bundle 层都匹配不到东西、永远显示「重启后生效」——包括在一次真的激活了它的重启之后。现在没有同名 Loader 条目的行一律中性，死掉的语言键也删掉；其余诚实上限不变（快照不可读、protected/composition/seed 行、disabled/failed/loading 各有自己的答案，manifest 仍绝不作为存活来源）。
- **桌面本地 patched 探针按两个挂载来源判定** —— 本地 chamber 行来自两处：profile 自己的 `cordis.patch.yml` 用户层（app-boot 组合到根条目列表之上）与传给 spawn 的 `--patch` overlay。探针只读 overlay 文件，于是组合树里明明有该行却报 false，而一次不再传 overlay 的 spawn 又会从残留文件继续报 true。现在探针回答「这一行是否到达组合树」（profile patch 里的精确插入行，或 overlay 里的），读不到或缺失的事实保持 false 而不靠猜；生产者侧让 overlay 文件的存在只意味「上一次 spawn 传了它」：任何不传 overlay 的解析都会删掉残留文件，overlay 解析器导出以便用真实文件系统测试而不是源码文本钉。
- **移动端卡死提示的相位、身份与「继续等待」** —— ① 相位集合：上游 `ConversationRoot` 往 `[data-phase]` 写 `settling`/`hero`/`active`，旧的 `['active','engaging']` 有一个永远到不了该属性的成员、又漏掉 `settling`（正在载入历史、头部可见的会话打开）；现为 `['settling','active']`，`hero`（无会话）仍在集合外，头部可见门继续排除空壳。② 会话身份：相位节点**不是**会话作用域的（`main` 槽按 entry 身份键控，会话切换时 `div.root[data-phase]` 原地重渲染），身份改取已渲染的 `<header>`（会话作用域的 `conversation.session.header` 子树会重挂），于是计时与已显示的提示不会带进下一个会话。③ 消除方式：第二个控件（「继续等待」）只对**当前连续卡死**隐藏提示，不再逼用户要么忽略要么中断一次慢但健康的加载；抑制随该次卡死结束（DOM 形状破坏**或**页面被隐藏——后者同时清零计时），应用恢复后回到仍卡死的会话会再被告知一次。④ 安装所有权改为引用计数：第二个上下文此前拿到的是已死的 disposer，释放第一个就停掉了第二个的监听。
- **打包产物陈旧即失败** —— `dist/control-plane` 与 gateway bundle 内联源码逻辑，而行为测试跑的是 workspace 源码，于是旧构建能在测试全绿的同时让打包应用发布**上一轮的判定**（上一轮受保护集合校验就这样在 dist 里活到被手工重建）。现在两个守卫在**已存在**的 bundle 缺少当前标记时直接失败，只在产物缺失时才构建；静默重建会让检查恰好治好它本该抓到的漂移。
- **gateway 审计窗口在关停时二次排空并设上限** —— `flushAuditWindows()` 在 HTTP listener 关闭后再排空一次：`quiesce()` 在准入栅栏排空，但栅栏与关闭之间被接受的拒绝会打开一个再无人发布的窗口，那条记录就丢了。窗口表同时有了上限（`MAX_AUTH_REJECTION_WINDOWS`）：不同客户端身份无界，到顶时提前发布最旧窗口而不是无限增长。

## [0.3.0] - 2026-09-14

### 新增
- **启动降级提示：结构性缺口不再是静默空栏（design 05 §4「降级呈现」）** —— 来源可以「启动成功」却整面缺席（复合首屏需要的 `sidebarRight` 只由可选宿主图行提供时，fiber 停在 pending、会话面从不注册，主栏只剩 composer），此前只有控制台一行日志。现在降级是**结构化事实**（kind + 载荷）并有三处如实呈现：主栏横幅（仅当前视图、`role=status`、控制面不可达时让位）、侧栏来源行提示（并入该行唯一的 live region，优先级 managed-down > gap > transient > baseline）、连接页卡片与插件对话框（缺口期抑制图状态，因为图通道恰在此时是健康的），三者共用同一个重试入口；settle 之前到达的判定按 boot serial 挂起、settle 时补发。

- **GUI 验收工具箱与流程清单（`pnpm run acceptance:gui`；清单见 `docs/checklists/gui-acceptance-checklist.md`）**：GUI 验收此前没有规范化文档或可复用步骤——判据散在 `docs/design/*`（各域门禁）、`docs/progress/STATUS.md`（开放实机项）与 `scripts/perf`（性能尺子，非功能验收），每轮都要重新发明且无法回归。清单只写**流程 + 指针**（四条腿：机械 A/B、目检、打包态；每行给检查 id 与 design/STATUS 依据，不复述判据，避免出现第二份会漂移的台账）；工具箱**零新依赖**（Node 内置 `WebSocket`/`fetch`），分纯判据层 `checks.mjs`与驱动层 `probe`（`--live` 只读探测运行中的应用，安装态亦可）/`walkthrough`（`--attach`/`--dev` 的 CDP 走查 + 截图）/`launch`/`run`。断言只用仓库既有 DOM 契约（`[data-instance]`、`[data-chamber-section|row]`、`[data-slot]`/`[data-slot-error]`、设置导航 `dialog nav [class*="navList"] > button`），不新增测试钩子、不靠文案匹配；点击白名单只含设置导航项与首启关闭动作，按不到任何变更控件。已登记容忍（冷启动 `clientGraph/graph` 503 = design 09 §3.2、页面自身重订阅的 `net::ERR_ABORTED`、上游 cordis 启动日志、实例未就绪时实例面转 INFO = design 18 §3.4）写在工具箱 README——要放宽先改文档，不在代码里猜。
- **open-in 宿主半 fork 为实例内 seed 包（design 20 §2.1、§6.3）**：Phase 2 的「让官方两份在 N-ctx 壳里跑通」被三条独立证据否掉（托管实例注入的 `SSH_CONNECTION` 目录选择 pin 被上游三处共用、官方客户端半假定同源绝对路径、官方行依赖实例 runtime 版本），改为 **fork & supersede**：新增 `packages/dsh-chamber-seed-open-in/`（上游 `host/open-in-app` 的 fork；`catalog`/`resolver`/`icons` 逐字节 pure），三条有意分歧写进源码首页——删 SSH 休眠门、HTTP 路由 + 自建连接栅栏换成 typert Remote `openInApp/{probe,apps,icon,open}` 域载体、Config schema 换成常量；客户端本地池改走实例自身通用 RPC。这是既有注册表纪律的又一有界例外。
- **设置面改为完整桥接（design 05 §5，2026-12 修订）**：设置壳不再为选中来源装配「缩小版前端」，而是渲染**该来源自己 boot ctx** 的 `settings.section` 台账，条目用该 ctx 自己渲染器绑定的标准座渲染——插件在实例自身前端 active，在这里就同样 active（真 remote WS 事件流、实时 settings 失效通知、真的 `useSessions`/`useWorkspaces`/`usePanelInfo`/`useResource` 座），上游 `ui-agent-preset` 的创作入口因此与实例本地一致。由每实例面注册表（`settings-source-face.ts`）两半齐备才可渲染，化身指纹须与权威 roster 相同；面板打开期间保证该来源壳保持挂载（**不切 active view**），关闭即撤除，离线来源仍显示不可达占位且不触发挂载。
- **侧栏：未挂载来源新建的工作区立即可见 + 打开意图契约**：真机反馈「在 A 来源给 B 来源新建工作区，该行不出现，必须点开 B 才刷新」。改法是把侧栏自己那次 unary `workspace.create` 的成功结果当作「该工作区现在存在于那个宿主上」的唯一可信事实上报（`chamberBridge.reportWorkspaceCreated`），并在投影的**唯一汇合点**并入（不新增第二个权威，权威仍是挂载壳的 follow 基线），附三类退休条件：同 `workspaceId`/同路径的真实 push、来源离开注册表、10 分钟 TTL（挂在本次 create、权威 push、30s unary 兜底拉取三处时钟）。同批加固打开意图三闸门：早开臂持续读意图、校验来源身份、工作区回声的会话归属（契约登记于 design 05 §2.2.1）。
- **归档清理：force purge、归档感知的 worktree 移除与单一宿主包注册表（design 24 §22、design 08）**：归档清理新增 force/loaded 语义（运行中与已加载的会话整棵跳过，`resolvePlan` 除 `skippedRunning` 外同时报 `skippedLoaded`），并与 registry-global 孤儿清扫共用一次运行（`readAuthoritativeState` 同时给出 `liveFacts` 与 `snapshotRecordCount`，存活排除集取 running ∪ loaded）；Git worktree 的删除改为归档感知；三个 chamber 宿主包（client-graph / git-worktree / archive-cleanup）统一到**单一注册表**来源，gateway 与控制面的清单不再各写一份。
- **上游触点登记表与保鲜门、上游设计 token 合规门**：新增 `docs/checklists/upstream-touchpoints.md`（逐文件纯度登记 [pure]/[patch-add]/[patch-mod]/[patch-comment]/[own-divergent]/[own]/[dropped]、dropped 表、深引/roster 段、契约镜像表、产物登记、每 tag 的 8 步维护环）与 `scripts/dev/verify-upstream-touchpoints.mjs`（C1 pure 字节相等 / C2 tag 间重放报告 / C3 完整性 / C4 roster 哨兵 / C5 锚点扫描 / C6 排除目录存在性 / C7 种子域锁步 / C8 产物陈旧度 / C9-C10 锚点与活字面量 / C11–C14 插件受保护集合门 / C15 悬停卡退役门），两个维护面互为镜像、CI 两腿都在 vendor 引导后即跑；release 工作流的 validation 腿改为证明发布提交已在 `main` 上通过完整 CI（linux `test` + `test-windows` 两腿），不再在 tag 上重跑测试；另有 `verify:styles`（上游设计 token 合规门：发丝线 / 浮层阴影 / 命名空间）与 `PULL_REQUEST_TEMPLATE` 的触点自检段。
- **写者静默闩锁的会话内再证明与「清理并接管」（design 02 §3.4）**：启动扫描只在「零 kept 且零 errors」时打开闩锁，且**只在启动时跑一次**——记录一旦在会话中途变陈旧，闩锁再也打不开，表现为硬杀后「本地实例起不来」（`POST /api/connections` 恒 409、启动/停止点不动、只能重启应用）。现将两种关闭原因分开：**扫描判定**类在拒绝启动前做有界再证明（单飞 + 2s 冷却；孤儿已退出的常见情形无需任何用户动作即恢复），**写入期终止失败**类（`onWriterQuiescenceUnknown`）任何扫描都无法证明、对本平面生命周期粘滞并明确提示重启；`runReaper` 增 `takeover` 模式与条目级结论（`reason`/`takeOverAvailable`），只清**本状态目录自己**的陈旧/孤儿写者，owner 仍活的另一实例永不受影响；连接页据此提供显式「清理并接管」。
- **插件受保护集合：拒绝集按目标实例的运行时事实判定（design 21 §6.11；决策 19 的 2026-12 修订）** —— 不按域名前缀猜：那样既挡住不该挡的（官方 opt-in 层 `@deepseek-ai/dsh-experimental-*` 装不上），又挡不住真正要防的（组合被拆、族成员被跨代副本 shadow），且上游改名/换 scope 就会失真。受保护集合 `P = B₀ ∪ S ∪ F` 全部来自目标实例的**可验证事实**：`B₀` = 安装自带组合快照（对拍 C12 门）、`S` = chamber 播种注册表名（C13 门）、`F` = **已提交**运行时锁文件闭包（C11 门，含核心、不含 opt-in 与 dev/test 包）；install/remove 分相判定（remove 永不判版本），官方 scope 的 install 另需**精确同代**，`F` 读不到时按保守阶梯只收紧不放松（gateway 侧 503 可重试）。同一判定贯穿三条写面：控制面谓词、gateway 的 install/materialize/remove 三条路由（含延迟意图排空与执行时复判、装后复验）、桌面壳的三条本地通道（文件夹/归档拾取、renderer 提交 spec、移除）+ ssh 申请与就地物化（整批拒绝，绝不绕过被拒行执行）。设置页「已安装」列表改为**服务端投影行** `{role, protected, owner?}` 驱动，渲染端不再持有镜像谓词。四道保鲜门 C11–C14（运行时线族集合 / profile 契约锚 / 播种注册表结构 / manifest 三方镜像 + rows 行类型）随 `pnpm run test:upgrade-tools` 在 CI 两腿运行。
- **归档清理：常驻会话删除内容后不再回流 workspace（design 24 §4 step 9）** —— 删除一个**本进程仍持有**的已归档会话的内容，会连它的归档成员关系一起清掉；而官方会话列表是 live 优先的（`listSessions()` = 持久化重扫 ∪ `ctx.sessions.list()`），宿主仍照供这一行，于是刚删掉的会话以普通行重新出现在 workspace 里，看起来像"内容被恢复了"。现在：删除瞬间仍常驻（本进程 attached）的完成树**保留**归档成员关系（内容照删），行继续隐藏；归档管理器对这些行标注「内容已删除，待实例重启收敛」（并写进行复选框的可访问名），purge 结果新增加性字段 `residentRetainedRoots`（旧客户端忽略未知字段）；实例重启后该行不存在，无内容的成员由后续 run 的孤儿清扫收敛。同批加固：live 事实读取对任何形状漂移**响亮拒绝**（此前静默丢弃条目会把 loaded 守卫与常驻判据同时推向不安全方向）；批量写之前再做一次 live 复核，写窗口内才 attach 的会话其成员关系同样不被摘除（复核读失败则整批不写）。

### 变更
- **chamber 界面按官方非密度 token 与几何取值** —— 若干按「密度档」推导的取值改取官方非密度值；所有 chamber 弹层菜单（会话/工作区 kebab、排序、Git 创建对话框的字段下拉、open-in 应用菜单、设置页服务器下拉）统一取原语 `compact` 档（26px / 12px 行），与「菜单密度 = chamber 档」的全仓裁决一致；设置页服务器下拉圆角对齐官方 20px。
- **open-in：目录与图标改由本机实例的页级机器目录回答，呈现取官方分体按钮** —— 应用目录、图标与拉起描述的是**这台机器**而非屏幕上的来源，故由渲染壳对本地实例建**唯一一份**机器目录并注入每个 entry（本地与远程一视同仁，远程来源的条目也显示本机真图标），传输复用本地 entry 自己的 `/api/i/local` 通用 RPC，插件侧不再持有连接载波；图标缺失一律回落官方圆角方块，chamber 自有位图全部删除（选图规则收敛成官方那一条）。header 控件的呈现同时彻底取官方 open-in 分体按钮（28px / `border-l4` / r14 容器、主按钮 15px mark、设计系统 chevron、菜单行 18px mark）；官方没有单条目形态，本入口也不再保留纯图标按钮形态。

- **dsh 推进到 `0.1.5-rc.2` 一代（构建期 vendor 源 + 捆绑运行时同代）** —— 相对上一正式版，源码 pin、捆绑运行时、三个 fork 副本（`dsh-client-connection` / `dsh-client-web` / `dsh-api-gateway`）与安装脚本 / gateway 的 `dshAnchorVersion` 同处 `0.1.5-rc.2`。上游在本区间重写了客户端外壳的两代槽位模型（`details`→`rightbar` 且 scope 由 session 改为 root；中心列 `conversation`→keyed `main`；新增 `sidebar.panellist` 轴与 `usePanelInfo`/`useResource` 全局座），chamber 的 layout / sidebar / mobile / settings 自建物随之全量重放，外观与交互仍为 chamber 形态。
  - **经运行时线进入受管实例的上游可见变化**：base bundle 默认模型 `deepseek-v4-flash` → **`deepseek-flash`**（V41 Flash；catalog 3→4 条，保留 V4 Flash / V4 Pro / V4 Flash Vision Exp），该条目声明 `systemPromptUpdate: 'in-history'`（V4 系不声明、行为不变）；上游自带告诫——网关未启用该 id 前请求可能 `INVALID_REQUEST`，可在设置里改回 V4 系。
  - **版本歪斜登记**：实例侧 documentpreview 的代码预览自该代起行为依赖同代 `ui-primitives`（`CodeBlock` 的 `contentRef` 是其唯一滚动/行定位锚点），旧代 composite 服务新 instance 时该预览失去独立滚动区与行定位——登记于 STATUS 的平台词偏差条。

- **修复 N-ctx 同源壳下五处同源绝对 URL** —— 官方客户端假定自己由 dsh 源提供，但 chamber 单页多实例（N-ctx）下页面 origin 是控制面、只代理 `/api/i/<id>/*`，于是五处动作实测失效：`ui-chat` 的 `/api/file`（Markdown 本地图片坏图）、`client-file-upload` 的 `/api/session/uploadFileBinary`（**composer 附件上传 404**）、`ui-deliverables` 的 `/api/present.host|open`（交付卡「打开/定位」404）、`session-log-export` 的 `/api/session.export`（**/export 下载 404**）。修法为登记式**构建期 vendor 补丁集**（`packages/renderer/scripts/vendor-patches.mjs`，按精确上游锚点改写、vendor 文件零写入，锚点漂移即构建失败；补丁覆盖上传与导出客户端，官方 layout 部署下缺失 base path 时回落上游行为）。**已知边界**：本地与 gateway 来源经控制面注入 cookie 后可用；ssh/http dsh 目标仍无 cookie 注入（实例侧 401），属既有认证面待办。
- **chamber 自建包命名统一** —— 命名收口为「目录 == 包名非 scope 段」：6 个 client 插件包名 `@dsh-chamber/dsh-client-ui-*` → `@dsh-chamber/dsh-chamber-client-ui-*`（目录不变）；3 个宿主种子包的目录与包名 → `dsh-chamber-seed-<loader-id>`（`@dsh-chamber/dsh-chamber-seed-client-graph` / `-git-worktree` / `-archive-cleanup`；loader id、激活探针域与发布计数不变）；`dsh-client-ui-mobile`（client-kind 例外）、三个 fork 副本与基建包不动。**兼容性**：本版桌面壳按新清单名同步宿主包，而 ≤0.2.4 的就地 gateway 只认旧名——就地部署需先把 gateway 更新到本版；远端过渡把旧名 `cordis.patch.yml` 行按同 loader id 一次性改写，避免升级后 seed 因 id-bound 冲突硬失败。
- **连接恢复加固（2026-09）** —— 针对「上游连接管理只按本地/单实例设计，chamber 需面对隧道/慢链路/唤醒」的专项结论：
  - **每来源就绪期限**（新增 `dsh-client-connection/src/client/recovery-policy.ts`）：chamber 页面拿不到宿主注入的 `__DSH_CONNECTION_RECOVERY__` 页面全局，一直吃 15s 硬期限；现由 api-gateway fork 经上游支持的 `connection.start(sinks, config)` 为 ssh/http 来源传 45s 期限 / 5s 告警，本地与未知来源保持上游默认——冷 SSH 隧道或慢链路不再因握手超期被反复取消。
  - **唤醒事件旁路离线门**：页面跨挂起/恢复被冻结时可能整体错过 `online` 事件并持续误报 offline，而离线门会连 `system-resume` 一起挡掉。现 `system-resume` 旁路门（`reconnect()` 的 `immediateRetry` 跳过挂起分支，只强制一次有界尝试，真离线则快速失败重挂），`online`/可见性仍受门约束，三者共享 10s 去抖。
- **open-in 统一：单一 header 入口消费 per-source 视图模型** —— 本地来源吸收官方 client：
  - **本地来源（official 通道）**：实例自身官方宿主目录（`dsh-host-open-in-app`，随 a2 默认 web bundle 在）经每实例代理 `<basePath>/open-in-app/{apps,icon/<id>,open}` 提供全量本地应用拾取器——catalog 协议（`shared/open-in-app-protocol.ts`，与 vendor `shared.ts` 逐字锁步测试）、真实 bundle 图标（404 回退中性方框）、官方 `app.*` 标签表与按钮文案（并入单一 chamber locale NS）、选择持久化（官方 key `dsh.open-in-app.choice`，storage 不可用降级内存）、busy/error 呈现（250ms 延迟 busy、2s 错误衰减）全部吸收；桌面主进程的 VS Code 覆盖项按 §5.1「vscode 全家走 IPC 覆盖」+ r6「展示并集 + IPC 兜底」裁决：主进程该项可用时胜出（vscode 走 IPC，保留 `vscodeOpenInNewWindow`、来源代 proof 与深链 intent 推送），不可用时官方条目兜底（走实例路由）。
  - **远程 ssh 来源**：仅主进程 remote-capable 项（VS Code Remote-SSH，主进程构造 `vscode://vscode-remote` URL）；**http/未知来源**：无入口。
  - **桌面主进程瘦身（红线）**：`OpenInApp` 注册表 vscode-only；`OpenInLaunchContext` 移除 `stat`/`openPath`/`showItemInFolder`，finder provider 与 `classifyLocalPath`/`invokeOpenPath`/`normalizeOpenPathError`/`shouldRevealDirectoryInsteadOfOpen` 一并退役。本地 launch 的信任界由 trusted IPC 迁至实例官方路由（实例连接栅栏 + 官方 resolver 白名单/存在性校验），控制面仍零执行面（逐字透传 + browser-auth cookie 注入）；VS Code 深链语义、来源代 proof 与 OS 深链 `dsh-chamber://open-vscode` 入口不变。
  - 红线修订登记：design 16/20/05 + AGENTS 同步（最终设计验收由用户完成）。
- **升级工具收尾（2026-09）** —— 与 dsh 升级版本无关的三件收尾：
  - **升级前 pin 预检（新增 `scripts/dev/preflight-vendor-pin.mjs`，只读）**：对目标 tag 与当前 pin 做 diff，一次给出「三个 fork 副本按 pure/需人工重放/dropped 分类 + chamber 深引的 vendor seam 文件 + 上游包集合增删 + 新增 client 行 + 运行时是否已发布 npm」，支持 `--offline`/`--json`/`--fail-on-replay`（advisory 工具，不改工作树、不动 submodule HEAD）。把「先升 pin 才发现上游重写了外壳模型」这类坑提前成「动 pin 前先看清单」的流程第 0 步。
  - **锁文件 vendor 记录修复脚本加移除守卫（修复）**：`restore-lockfile-vendor-records.mjs` 原先无条件从 HEAD 复活被 pnpm 剪掉的 importer 记录；上游在 0.1.5 移除 workspace 成员（landlock 4 条）后，脚本会把已不存在的成员补回，frozen 安装随即以「锁文件有、链接缺」失败。现按 `vendor/harness-packages/@deepseek-ai/<name>` 链接存在性（含断链）跳过并打印清单。新增根脚本 `pnpm run test:upgrade-tools`（两个脚本测试）+ CI 步骤。
  - **聚合刷新陈旧阈值按传输分级**：sidebar 聚合的 S2 重连 watchdog 原为单一 120s 且**只覆盖 direct-http 来源**；现按来源传输取阈值——http 保留 120s（浏览器腿有控制面 30s WS ping，上游腿无应用心跳、仅约 10min OS TCP keepalive，需较紧的自愈），**ssh 新增 300s 兜底**（隧道已有三层独立探测器：代理 30s/1 miss WS ping、宿主 mux 2s/2 misses、SSH keepalive 30×3≈90s，该臂只补「应用级冻结」这一层，阈值必须显著长于 http 以免空闲健康隧道每两分钟付一次基线重放），本地/未知来源不武装（`AGGREGATE_RECONNECT_HTTP_STALE_MS`/`AGGREGATE_RECONNECT_SSH_STALE_MS` + `reconnectStalenessMsForTransport`）；unary 30s 拉取节奏不变，watchdog 始终是「拉取的补充」。

- **设置面来源标记退役与归属判定**：nav 行的「插件」来源标记退役，回到上游形态；归属判定改按 npm scope。
- **提交信息语言（贡献规范）**：`CONTRIBUTING.md` 明确**提交信息一律英文**（subject 与 body 都是英文），历史中文提交是既有事实、不作先例；代码注释、设计文档与 PR 正文不受此限。

### 修复
- **会话行标签按官方链解析，「未命名会话」不再出现** —— 标签链为 `durable title → cwd 目录名 → 会话 id`，单点解析并随两个快照构造下发（进发布签名，标签单独变化也重发布）；行标签、悬停卡、可访问名、复制文本、搜索结果与其匹配、待办条、通知标题与 worktree 移除确认列表全部消费同一标签，宿主读不到标题的历史行按项目目录名标注。「未命名会话」只剩声明的例外（归档管理器的 durable 名列，以及行完全不在投影时的字典化兜底）。同批把「+」改为复用 workspace 中既有的空白成员（与上游 `connectWorkspace` 同谓词），双击不再新建出第二个隐形空行。
- **归档内容在任何状态下都可删（design 24 §5）** —— 归档管理器此前要求客户端能说出「正在查看的会话」并解析其向上子代理链，而这两个事实恰恰经常不可得（没开会话、vendor 在列表间隙掩码 `current`、来源壳被回收、冷行缺 cwd），于是删除控件对**最需要 force 的那些会话**（运行中归档，例如停在提问/审批）恒为禁用。现在只有一种形态：STOP 取消选择闭包全体成员（减去正在查看的会话；有限扇出、按输入顺序记账）且失败不再拒绝运行；PURGE 恒带 `force`，正在查看的会话改以「保护集」随请求下发并如实报 `skippedProtected`；无法解析当前会话时降级为顶部可见说明行，而不是禁用控件；归档动作本身在被归档的会话上**终止该会话及其子代理子树**。
- **移动端触控档：右栏面板、抽屉让位与 30s 自愈门（design 17 §18.6）** —— 右栏面板的强制全屏呈现与抽屉让位原先挂在 frame 的 `data-rightbar-collapsed` 上，而该标志的含义是「无保留轨道」（`cols.rightbar === 0`），手机档上面板已展开时它仍为假，两条规则正好在面板盖住屏幕时失效；现锚在面板自身的 `[data-sidebar-right-panel]`（关闭动画期间也保留盒），让位同时认两个已展开信号，面板补 `env(safe-area-inset-*)` 且为 border-box（否则刘海侧画到视口外），无作用的模式控件只在 768–1023px 带隐藏，面板内部不再把 overscroll 串到背后文档。composer 的 30s 卡死自愈原先只看 busy 相位，会把提交期间合法到来的锁（owner block / 离线父级 / 移除中）强行解开，现同时要求官方 `aria-disabled` 标记缺席，判定抽成纯谓词并导出两个 MutationObserver 选项集（缺 `attributeOldValue` 时该层静默失效）。视图标签条改为换行（滚动容器会裁掉上游画在标签盒外 1px 的激活条）且 44px 底线为 border-box；dockkit 条随控件增高，chip 保持 content-box。

- **归档清理后已删会话在侧边栏反复浮现（design 24 §12）**：purge 删除已归档
  会话内容后，官方客户端 `SessionManager.summaries` 不会刷新（宿主会话事件为
  文档化 no-op），而归档集合的收缩经官方 workspace follow 即时到达客户端，于是
  生产端推送把「收缩后的集合 + 陈旧的行」一起提交，已删会话以普通行渲染（点击报
  `session/not-found`）；30s unary 兜底拉取又把它清掉，形成「推送装回、拉取清掉」
  的闪烁。修复分四层：① 生产端**墓碑抑制**（离开权威归档集合的 id 从上报快照与
  运行时事实通道中过滤，直至官方 summaries 收敛或该 id 重新入集合）；②
  **校验式收敛链**（以方法调用官方 `ctx.sessions.refresh()`——此前的脱绑调用每次
  抛 `TypeError` 被吞掉、从未真正发出请求——resolve/reject/hung 三类结果均有界
  重试，终态用 chamber unary `session.list` 权威探针，只释放服务端仍存在的 id）；
  ③ App 侧**权威归档集记忆**（失去权威时作为收缩基线，并让降级 unary 视图继续
  过滤已归档行；`archiveSetKnown` 仍为 false，管理器保持非破坏性降级分支）；
  ④ 宿主**registry-global 孤儿清扫**（每次 purge 收尾清全集合无会话记录的成员：
  逐候选官方单 id 存在性校验 + 查询/持久化枚举并集 + 空/塌缩语料可信度门，
  只清集合成员、零新增删除语义，双重确认与 fail-closed）。
  设计与进度见 design 24 §12 与 `docs/progress/STATUS.md`。
- **移动端 Web 访问面（design 17 §18）**：四类真机反馈的复修与加固。
  - **tooltip 悬停残留**：官方 ui-primitives `Tooltip` 的 tap 会合成
    mouseenter 而没有配对 mouseleave（sticky hover），延迟气泡（200–500ms）
    常驻在刚用过的发送/停止键上。规则改为 `(pointer: coarse) and (hover: none)`
    门控（宽屏触控设备同样会点按；接鼠标时 hover 翻转为 hover、自动让位）且只
    针对**与可访问名重复**的气泡
    （`button[aria-label] + [role="tooltip"][data-side]`，气泡是 trigger 的紧邻
    下一兄弟且带组件自身的 `data-side` 标记）；四处信息型气泡（聊天统计行、
    代理预设卡片描述、轨迹时间轴 span、≤620px 的轨迹 kind 标签）**刻意保留**
    ——它们的 trigger 没有可访问的等价文本，隐藏等于让触控用户失去唯一可读
    来源；第五处 `role="tooltip"`（轨迹 turn-rail 预览）无 `data-side`，结构性
    排除。
  - **键盘补偿加固**：arm 以 frame 元素为单位幂等（renderer 重挂替换 AppFrame
    时重新打标，且旧 frame 的插件属性被清理）；新增**可编辑焦点**（focusin +
    focusout 打点 + composer 选区兜底）守卫；**缩放策略**改为「只服务 composer」
    ——原先的 `scale > 1.01` 一票否决会在 iOS 聚焦缩放后（抽屉 13px 搜索框是
    常见触发源）让 composer 永久留在键盘后，现在缩放 + 焦点在
    `[data-composer-seat]` 内照常补偿，非 composer 字段在缩放态仍否决；
    同时从源头消除聚焦缩放（抽屉内输入框补 16px 底线）；量化步进 48px → 16px
    （死区从 8–55px 收窄到 8–23px）；arm 期间归零 seat 的底部安全区 padding
    （消除刘海机 0–34px 双重间距）；focusin 纳入重同步通道。
  - **设置 sheet**：分区切换的滚动复位改为只认**分区 chip** 点击（判定抽为
    纯函数），并门控在**手机档**（769–1023px 触控平板保留官方弹窗
    几何与官方跨分区滚动行为）。
  - **连接稳定性取证（未修复）**：gateway/控制面共用的 WS splice 拆链新增一行
    有界日志（`WebSocket stream <id> closed (<cause>, <ms>ms)`），使**实例侧**
    mux 心跳判死与客户端主动重连在日志中可区分（此前只有代理自身心跳有日志，
    实例侧判死完全无痕；cause 为无括号 token，整行可解析，logger 抛异常不会
    锁死拆链）；修复动作仍待浏览器侧 close code 取证，取证结论与候选修复见
    `docs/progress/STATUS.md`。

- **网关管理页的可访问性与请求边界**：确认控件改为**页内可访问对话框**（不再用夺焦的原生 confirm），待决期保持焦点封闭并修正 `aria-busy` 归属；请求边界收口——400 原因保真（不被改写成笼统码）、读面栅栏、auth 审计；`dsh plugin` 子进程的 `PATH` 上提供 gateway 自带的 pnpm，宿主无 pnpm 时插件任务不再失败。
- **Git worktree 改用上游原语**：自绘确认控件与自绘标签换成官方确认对话框与标签原语（外观/键盘/语义随上游一致）；风险确认闸门改为**一次手势生效**并加锁（原先连续确认会把同一次操作反复要求确认）。
- **桌面：打包钩子与 dev 启动**：`beforePack` 会把 `node_modules/@dsh-chamber/dsh-runtime` 从 workspace 链接换成 dist-only 实体目录（Windows junction 上 electron-builder 不跟随链接），但此前没有任何钩子还原——打包后工作区丢类型面，根 `typecheck` 与 `typecheck:gateway` 级联 TS7016、`build:preload` 失败，且 `pnpm install --frozen-lockfile` 修不回来。现 materialize/restore 拆为可测函数并在 exit/SIGINT/SIGTERM/SIGHUP 还原（SIGKILL 留下的污染由下一次打包治愈，目标已是实体目录时同样注册）；`dev` 启动不再每次重建渲染层。
- **CLI 与 dsh 运行时探针对齐真实契约**：`cli` 的运行期门与读面按真实契约修正；`dsh-runtime` 的 `commands/execute` 探针线名对齐并透出探针失败原因、UNC 路径脱敏、终止裁决点名失败探针（探针文本的保留词覆盖 legacy 方法名），`gateway` 的壳升级事务据此可判读失败原因。
- **renderer / sidebar / settings 审查轮修复**：失败呈现改走设计系统并统一外壳文案；打开意图与揭示门的接线加固（切换来源时不再露出目标壳自建的空白会话）；侧栏早开臂持续读意图并校验来源身份、工作区回声的会话归属修正；设置面归属判定改按 **npm scope**（而非枚举本仓 id），服务器设置行不再被误标「插件」，并恢复设置面板 Escape 关闭。
- **测试可移植性与 CI 形态**：`test:host-archive-cleanup` 的「大写后缀 near-miss」用例在**大小写不敏感文件系统**（macOS APFS 默认 / Windows NTFS）上本就不成立，现按运行时探测分支；两个测试专用 ESM loader 原先把 specifier 映射到裸 submodule 路径或工作区成员路径，使单测依赖**本机 vendor 安装形态**（CI 上 `zustand` 解析失败、`Cannot find package`），现将「跑真实 vendor 源码」的用例改为按契约的 store double，真实解析仍由源码锁与 `build:renderer` 把关；`purged-tracker` 的「到此为止恰好一次刷新」否定断言原先与真实 `retryMs` 计时器赛跑（CI 上 `2 !== 1`），现全部走注入时钟并把「无遗留计时器」钉进断言；另修 `test-windows` 门禁崩溃与 `host-open-in` 的 undici 类型落点。
- **移动端卡片网格口径与 ARIA 说明修正**（承接 design 17 §18 移动面）。
- **会话行悬停卡片改由 chamber 自己持有状态机（design 06 §7）** —— vendor `HoverCard` 以**已提交的 `open`** 决定是否 arm 关闭宽限（`ui-primitives/HoverCard.tsx:183-188`），而本壳一个页面跑所有实例的 React root：dwell 触发到提交之间实测 502–504ms（空闲）/501–551ms（主线程忙），落在该窗口的 `pointerleave` 什么都不 arm，卡片随后挂载而指针已离开，此后再无事件能关掉它（实测症状：鼠标快速扫过后卡片一直挂在页面上）。现由 `shared/hover-intent.ts` 的**指针在场标志**作唯一权威（dwell 触发时复查、leave 无条件 arm 宽限），可见性由机器经 `useSyncExternalStore` 直读、不再镜像进组件 state（否则 press/禁用 与 dwell 错序提交仍会 mount 出机器认为已关的卡片）；卡片盒、8px 偏移、夹取与「点卡片复制」契约照搬官方原子。相对官方原子另有**两处有意增量**：同一文档只允许一张行卡片可见（页面级 slot，跨 N-ctx 壳共享 —— 这同时是「leave 根本没送达」的自愈路径：窗口失焦、承载壳被隐藏/遮挡、列表在静止指针下移动），窗口 blur / 文档 hidden 时关闭可见卡片。
- **open-in 在生产里答出空目录（design 20 §4.2）** —— 页级机器目录只读了 wire 两层信封中的一层：`callUnary` 回答的是通用 RPC 结果（`{ok,value}`），其 `value` 才是宿主域自己的 `domainResult` 载体，`parseApps`/`parseIcon` 于是拿到载体而不是它的载荷 —— 生产里 `apps()` 恒答空目录、图标恒为 null（运行中的应用看不到访达、VS Code 条目画兜底方块）。现在两层都在拥有 wire 解析的模块里读（与 git、archiveCleanup 客户端同约定），并把通用 RPC 的拒绝投影到域载体的失败臂（拉起失败如实报 RPC 层原话，而不是「unrecognizable」）。gateway 来源按设计 `localOnly`（宿主无该域）不留任何入口。
- **chamber 的「开/选中」色回到 dsh 业务蓝（design 15 §D1②、design 24 §6）** —— 设置面、连接页插件筛选 pill、归档管理器复选框与运行时安装进度填充此前取官方中性 `--dsw-alias-brand-primary`（浅色近黑、深色近白），「开/选中」态在浅色主题下画成黑色；现统一取 `--dsw-alias-state-business-primary`（deepseek-500/400），与侧栏选中/拖放指示、Git 面板滑块的既有业务蓝一致，并用一条面板作用域规则（特异性 0,3,0）重画原语的已选轨道，避免依赖打包顺序。
- **重启进入已下载更新不再被「关窗到托盘」吞掉（design 11）** —— macOS 上 `quitAndInstall()` 会先关闭全部窗口再退出，而默认的 hide-to-tray 要等 `before-quit`（关窗**之后**）才放行关窗，于是更新退出腿的关窗被 hide 吞掉：页面消失、进程连同本地 dsh 与隧道永久留存、更新永不安装（实测确认）。现在重启武装期间关窗放行、宿主兜底在 5s 后强制退出，且停滞 watchdog 在原生退出事件上**重锚**而不是被清除——退出腿不会中途误报停滞，腿走不完时又仍有如实文案与就地重试（清除会让"重启中"永久卡住）。
- **移动端三条按类名的布局规则此前一个元素都匹配不到** —— 官方 pinned 产物发出的是 local-first `_<local>_<hash>_<idx>` 名，而规则只有 hash-first 后缀臂，于是 composer 行强制单行、model 触发截断、设置 Models 行三条规则全部静默失效（正是该审计要修的"手机档按桌面几何渲染"回归）。现在补上中缀臂，并把 model 触发从共享的 `_trigger_` 局部名收窄到 model seat 锚点（该局部名在复合构建里有四个模块，含 ContextMeter 的 28px 圆环，避免连坐覆盖它的 `flex:none`）。
- **侧栏行动作簇间距统一（2026-09 用户报告）** —— 官方 `Rows .rowActions` 的 12px 落在**同一个**簇内部（git 工作区分支动作是该簇最左成员、坐在 header 的 4px 间距里），`+` 与省略号因此读起来像被分开；现整簇取 4px 节奏。同批：设置卡片复选框轻推限定在 head 行、致命覆盖层的服务器行分组修正、设置页在本机之外的来源上不再显示本机专属行（localOnly 投影）。
- **设置页「已安装」列表只列已声明的插件** —— 该视图此前投影的是「依赖表 ∪ 实际加载的 bundle ∪ 安装自带组合 ∪ 播种注册表」的名字并集，于是**什么都没声明**的 profile 也会显示六行（两个安装自有的组合成员 + 四个 chamber 宿主包）：两者都不是任何人安装的插件，组合行本身还自相矛盾（官方树提升到 `profiles/node_modules`，其版本探针恒答「—」），而 chamber 宿主包早已由「chamber 受管组件」表（探针状态 + 版本 + 手动重同步）负责。现在按依赖表**每项一行**投影：组合与播种名仍照旧参与 role/owner 分类与受保护判定，只是不再自造行；**已声明**的受保护名仍只读渲染并带角色徽标，写面两个方向都仍然拒绝。登记取舍：只存在于 live `dsh.profile.bundles` 的层不再有行（页内无移除入口，只能走 CLI），该状态只在手改 profile 时出现。
- **gateway 托管实例的运行时切换不再静默失效** —— `shouldInvalidate()` 把非空 `invalidatedAt` 当作永久失效标记，而没有任何宿主清除它；`select()`/`apply()`/`rollback()` 都以展开旧记录的方式写盘，于是**在一次 gateway 壳升级之后**选定的 dsh 运行时版本一写下来就是失效的：pending 被永久忽略、`apply-now` 以 `no_selection` 拒绝，留下的 version-switch intent journal 与仍带戳的记录一起被判为 `selection-corrupt`。现在 `select()` 与 `rollback()` 消费活动失效戳（置空，并把时间/原因折进 `lastInvalidated*` 历史供 F4 回显保留），`apply()` 补上与 `apply-now` 相同的失效门——失效的选择被如实拒绝（409 `no_selection`），而不是返回一个核心会静默丢弃的 pending；已经搁浅的实例重新选择一次即可恢复（此前只能删除运行时记录）。桌面端不受影响：其控制器在安装与缓存回滚时写全新字面量记录。


## [0.3.0-beta.4] - 2026-09-13
### 新增
- **插件受保护集合：拒绝集从「按域名前缀猜」改为按运行时事实判定（design 21 §6.11；决策 19 的 2026-12 修订）** —— 旧规则既挡住不该挡的（官方 opt-in 层 `@deepseek-ai/dsh-experimental-*` 装不上），又挡不住真正要防的（组合被拆、族成员被跨代副本 shadow），且上游改名/换 scope 就会失真。现在受保护集合 `P = B₀ ∪ S ∪ F` 全部来自目标实例的**可验证事实**：`B₀` = 安装自带组合快照（对拍 C12 门）、`S` = chamber 播种注册表名（C13 门）、`F` = **已提交**运行时锁文件闭包（C11 门，含核心、不含 opt-in 与 dev/test 包）；install/remove 分相判定（remove 永不判版本），官方 scope 的 install 另需**精确同代**，`F` 读不到时按保守阶梯只收紧不放松（gateway 侧 503 可重试）。同一判定贯穿三条写面：控制面谓词、gateway 的 install/materialize/remove 三条路由（含延迟意图排空与执行时复判、装后复验）、桌面壳的三条本地通道（文件夹/归档拾取、renderer 提交 spec、移除）+ ssh 申请与就地物化（整批拒绝，绝不绕过被拒行执行）。设置页「已安装」列表改为**服务端投影行** `{role, protected, owner?}` 驱动，渲染端不再持有镜像谓词。四道保鲜门 C11–C14（运行时线族集合 / profile 契约锚 / 播种注册表结构 / manifest 三方镜像 + rows 行类型）随 `pnpm run test:upgrade-tools` 在 CI 两腿运行。
- **归档清理：常驻会话删除内容后不再回流 workspace（design 24 §4 step 9）** —— 删除一个**本进程仍持有**的已归档会话的内容，会连它的归档成员关系一起清掉；而官方会话列表是 live 优先的（`listSessions()` = 持久化重扫 ∪ `ctx.sessions.list()`），宿主仍照供这一行，于是刚删掉的会话以普通行重新出现在 workspace 里，看起来像"内容被恢复了"。现在：删除瞬间仍常驻（本进程 attached）的完成树**保留**归档成员关系（内容照删），行继续隐藏；归档管理器对这些行标注「内容已删除，待实例重启收敛」（并写进行复选框的可访问名），purge 结果新增加性字段 `residentRetainedRoots`（旧客户端忽略未知字段）；实例重启后该行不存在，无内容的成员由后续 run 的孤儿清扫收敛。同批加固：live 事实读取对任何形状漂移**响亮拒绝**（此前静默丢弃条目会把 loaded 守卫与常驻判据同时推向不安全方向）；批量写之前再做一次 live 复核，写窗口内才 attach 的会话其成员关系同样不被摘除（复核读失败则整批不写）。
### 修复
- **重启进入已下载更新不再被「关窗到托盘」吞掉（design 11）** —— macOS 上 `quitAndInstall()` 会先关闭全部窗口再退出，而默认的 hide-to-tray 要等 `before-quit`（关窗**之后**）才放行关窗，于是更新退出腿的关窗被 hide 吞掉：页面消失、进程连同本地 dsh 与隧道永久留存、更新永不安装（实测确认）。现在重启武装期间关窗放行、宿主兜底在 5s 后强制退出，且停滞 watchdog 在原生退出事件上**重锚**而不是被清除——退出腿不会中途误报停滞，腿走不完时又仍有如实文案与就地重试（清除会让"重启中"永久卡住）。
- **侧栏悬停卡片不再搁浅（design 06 §7）** —— vendor 的 `HoverCard` 以**上一次已提交的 `open`** 决定是否 arm 宽限关闭：dwell 定时器触发到 React 提交之间落下的 pointerleave 什么都不 arm，卡片随后挂载而指针已经离开，此后**再无事件能关掉它**（CDP 复现：45 次采样残留 7 次）。本仓改用自己的 `RowHoverCard` + `hover-intent` 状态机消除该竞态，并补齐其余搁浅路径（视图隐藏、行卸载、越界、按下即关）；粗指针档点按官方悬停卡片本身即关闭它。新增 C15 保鲜门在冻结 pin 上锁住竞态的**两侧**形状与两个时间常数（退役条件 = 上游修掉该竞态，形状漂移即硬失败逼出裁决）。
- **移动端三条按类名的布局规则此前一个元素都匹配不到** —— 官方 pinned 产物发出的是 local-first `_<local>_<hash>_<idx>` 名，而规则只有 hash-first 后缀臂，于是 composer 行强制单行、model 触发截断、设置 Models 行三条规则全部静默失效（正是该审计要修的"手机档按桌面几何渲染"回归）。现在补上中缀臂，并把 model 触发从共享的 `_trigger_` 局部名收窄到 model seat 锚点（该局部名在复合构建里有四个模块，含 ContextMeter 的 28px 圆环，避免连坐覆盖它的 `flex:none`）。
- **侧栏行动作簇间距统一（2026-09 用户报告）** —— 官方 `Rows .rowActions` 的 12px 落在**同一个**簇内部（git 工作区分支动作是该簇最左成员、坐在 header 的 4px 间距里），`+` 与省略号因此读起来像被分开；现整簇取 4px 节奏。同批：设置卡片复选框轻推限定在 head 行、致命覆盖层的服务器行分组修正、设置页在本机之外的来源上不再显示本机专属行（localOnly 投影）。
### 变更
- **上游触点登记表扩到 C1–C15**（新增 C11–C14 插件受保护集合门、C15 悬停卡退役门；登记表与 `scripts/dev/verify-upstream-touchpoints.mjs` 两侧同步，CI 两段都跑）；release 工作流的 validation 腿改为**证明发布提交已在 `main` 上通过完整 CI**（linux `test` + `test-windows` 两腿），不再在 tag 上重跑测试。

## [0.3.0-beta.3] - 2026-09-13
### 新增
- **启动降级提示：结构性缺口不再是静默空栏（design 05 §4「降级呈现」）** —— 来源可以「启动成功」却整面缺席（复合首屏需要的 `sidebarRight` 只由可选宿主图行提供时，fiber 停在 pending、会话面从不注册，主栏只剩 composer），此前只有控制台一行日志。现在降级是**结构化事实**（kind + 载荷）并有三处如实呈现：主栏横幅（仅当前视图、`role=status`、控制面不可达时让位）、侧栏来源行提示（并入该行唯一的 live region，优先级 managed-down > gap > transient > baseline）、连接页卡片与插件对话框（缺口期抑制图状态，因为图通道恰在此时是健康的），三者共用同一个重试入口；settle 之前到达的判定按 boot serial 挂起、settle 时补发。

- **GUI 验收工具箱与流程清单（`pnpm run acceptance:gui`；清单见 `docs/checklists/gui-acceptance-checklist.md`）**：GUI 验收此前没有规范化文档或可复用步骤——判据散在 `docs/design/*`（各域门禁）、`docs/progress/STATUS.md`（开放实机项）与 `scripts/perf`（性能尺子，非功能验收），每轮都要重新发明且无法回归。清单只写**流程 + 指针**（四条腿：机械 A/B、目检、打包态；每行给检查 id 与 design/STATUS 依据，不复述判据，避免出现第二份会漂移的台账）；工具箱**零新依赖**（Node 内置 `WebSocket`/`fetch`），分纯判据层 `checks.mjs`（16 个单测进 linux test job）与驱动层 `probe`（`--live` 只读探测运行中的应用，安装态亦可）/`walkthrough`（`--attach`/`--dev` 的 CDP 走查 + 截图）/`launch`/`run`。断言只用仓库既有 DOM 契约（`[data-instance]`、`[data-chamber-section|row]`、`[data-slot]`/`[data-slot-error]`、设置导航 `dialog nav [class*="navList"] > button`），不新增测试钩子、不靠文案匹配；点击白名单只含设置导航项与首启关闭动作，按不到任何变更控件。已登记容忍（冷启动 `clientGraph/graph` 503 = design 09 §3.2、页面自身重订阅的 `net::ERR_ABORTED`、上游 cordis 启动日志、实例未就绪时实例面转 INFO = design 18 §3.4）写在工具箱 README——要放宽先改文档，不在代码里猜。
- **open-in 宿主半 fork 为实例内 seed 包（design 20 §2.1、§6.3）**：Phase 2 的「让官方两份在 N-ctx 壳里跑通」被三条独立证据否掉（托管实例注入的 `SSH_CONNECTION` 目录选择 pin 被上游三处共用、官方客户端半假定同源绝对路径、官方行依赖实例 runtime 版本），改为 **fork & supersede**：新增 `packages/dsh-chamber-seed-open-in/`（上游 `host/open-in-app` 的 fork；`catalog`/`resolver`/`icons` 逐字节 pure），三条有意分歧写进源码首页——删 SSH 休眠门、HTTP 路由 + 自建连接栅栏换成 typert Remote `openInApp/{probe,apps,icon,open}` 域载体、Config schema 换成常量；客户端本地池改走实例自身通用 RPC。这是既有注册表纪律的又一有界例外。
- **设置面改为完整桥接（design 05 §5，2026-12 修订）**：设置壳不再为选中来源装配「缩小版前端」，而是渲染**该来源自己 boot ctx** 的 `settings.section` 台账，条目用该 ctx 自己渲染器绑定的标准座渲染——插件在实例自身前端 active，在这里就同样 active（真 remote WS 事件流、实时 settings 失效通知、真的 `useSessions`/`useWorkspaces`/`usePanelInfo`/`useResource` 座），上游 `ui-agent-preset` 的创作入口因此与实例本地一致。由每实例面注册表（`settings-source-face.ts`）两半齐备才可渲染，化身指纹须与权威 roster 相同；面板打开期间保证该来源壳保持挂载（**不切 active view**），关闭即撤除，离线来源仍显示不可达占位且不触发挂载。
- **侧栏：未挂载来源新建的工作区立即可见 + 打开意图契约**：真机反馈「在 A 来源给 B 来源新建工作区，该行不出现，必须点开 B 才刷新」。改法是把侧栏自己那次 unary `workspace.create` 的成功结果当作「该工作区现在存在于那个宿主上」的唯一可信事实上报（`chamberBridge.reportWorkspaceCreated`），并在投影的**唯一汇合点**并入（不新增第二个权威，权威仍是挂载壳的 follow 基线），附三类退休条件：同 `workspaceId`/同路径的真实 push、来源离开注册表、10 分钟 TTL（挂在本次 create、权威 push、30s unary 兜底拉取三处时钟）。同批加固打开意图三闸门：早开臂持续读意图、校验来源身份、工作区回声的会话归属（契约登记于 design 05 §2.2.1）。
- **归档清理：force purge、归档感知的 worktree 移除与单一宿主包注册表（design 24 §22、design 08）**：归档清理新增 force/loaded 语义（运行中与已加载的会话整棵跳过，`resolvePlan` 除 `skippedRunning` 外同时报 `skippedLoaded`），并与 registry-global 孤儿清扫共用一次运行（`readAuthoritativeState` 同时给出 `liveFacts` 与 `snapshotRecordCount`，存活排除集取 running ∪ loaded）；Git worktree 的删除改为归档感知；三个 chamber 宿主包（client-graph / git-worktree / archive-cleanup）统一到**单一注册表**来源，gateway 与控制面的清单不再各写一份。
- **上游触点登记表与保鲜门、上游设计 token 合规门**：新增 `docs/checklists/upstream-touchpoints.md`（逐文件纯度登记 [pure]/[patch-add]/[patch-mod]/[patch-comment]/[own-divergent]/[own]/[dropped]、dropped 表、深引/roster 段、契约镜像表、产物登记、每 tag 的 8 步维护环）与 `scripts/dev/verify-upstream-touchpoints.mjs`（C1 pure 字节相等 / C2 tag 间重放报告 / C3 完整性 / C4 roster 哨兵 / C5 锚点扫描 / C6 排除目录存在性 / C7 种子域锁步 / C8 产物陈旧度 / C9-C10 锚点与活字面量），两个维护面互为镜像、CI 两腿都在 vendor 引导后即跑；另有 `verify:styles`（上游设计 token 合规门：发丝线 / 浮层阴影 / 命名空间）与 `PULL_REQUEST_TEMPLATE` 的触点自检段。
- **写者静默闩锁的会话内再证明与「清理并接管」（design 02 §3.4）**：启动扫描只在「零 kept 且零 errors」时打开闩锁，且**只在启动时跑一次**——记录一旦在会话中途变陈旧，闩锁再也打不开，表现为硬杀后「本地实例起不来」（`POST /api/connections` 恒 409、启动/停止点不动、只能重启应用）。现将两种关闭原因分开：**扫描判定**类在拒绝启动前做有界再证明（单飞 + 2s 冷却；孤儿已退出的常见情形无需任何用户动作即恢复），**写入期终止失败**类（`onWriterQuiescenceUnknown`）任何扫描都无法证明、对本平面生命周期粘滞并明确提示重启；`runReaper` 增 `takeover` 模式与条目级结论（`reason`/`takeOverAvailable`），只清**本状态目录自己**的陈旧/孤儿写者，owner 仍活的另一实例永不受影响；连接页据此提供显式「清理并接管」。

### 变更
- **chamber 界面按官方非密度 token 与几何取值** —— 上一轮按「密度档」推导的若干取值回到官方非密度值；所有 chamber 弹层菜单（会话/工作区 kebab、排序、Git 创建对话框的字段下拉、open-in 应用菜单、设置页服务器下拉）统一取原语 `compact` 档（26px / 12px 行），与「菜单密度 = chamber 档」的全仓裁决一致；图标按钮保留原视觉盒并补 24px 命中区；设置页服务器下拉圆角对齐官方 20px。
- **open-in：目录与图标改由本机实例的页级机器目录回答，呈现取官方分体按钮** —— 应用目录、图标与拉起描述的是**这台机器**而非屏幕上的来源，故由渲染壳对本地实例建**唯一一份**机器目录并注入每个 entry（本地与远程一视同仁，远程来源的条目也显示本机真图标），传输复用本地 entry 自己的 `/api/i/local` 通用 RPC，插件侧不再持有连接载波；图标缺失一律回落官方圆角方块，chamber 自有位图全部删除（选图规则收敛成官方那一条）。header 控件的呈现同时彻底取官方 open-in 分体按钮（28px / `border-l4` / r14 容器、主按钮 15px mark、设计系统 chevron、菜单行 18px mark）；官方没有单条目形态，本入口也不再保留纯图标按钮形态。

- **dsh 推进到 `0.1.5-rc.2` 一代（构建期 vendor 源 + 捆绑运行时同代）** —— 相对上一正式版，源码 pin、捆绑运行时、三个 fork 副本（`dsh-client-connection` / `dsh-client-web` / `dsh-api-gateway`）与安装脚本 / gateway 的 `dshAnchorVersion` 同处 `0.1.5-rc.2`。上游在本区间重写了客户端外壳的两代槽位模型（`details`→`rightbar` 且 scope 由 session 改为 root；中心列 `conversation`→keyed `main`；新增 `sidebar.panellist` 轴与 `usePanelInfo`/`useResource` 全局座），chamber 的 layout / sidebar / mobile / settings 自建物随之全量重放，外观与交互仍为 chamber 形态。
  - **经运行时线进入受管实例的上游可见变化**：base bundle 默认模型 `deepseek-v4-flash` → **`deepseek-flash`**（V41 Flash；catalog 3→4 条，保留 V4 Flash / V4 Pro / V4 Flash Vision Exp），该条目声明 `systemPromptUpdate: 'in-history'`（V4 系不声明、行为不变）；上游自带告诫——网关未启用该 id 前请求可能 `INVALID_REQUEST`，可在设置里改回 V4 系。
  - **版本歪斜登记**：实例侧 documentpreview 的代码预览自该代起行为依赖同代 `ui-primitives`（`CodeBlock` 的 `contentRef` 是其唯一滚动/行定位锚点），旧代 composite 服务新 instance 时该预览失去独立滚动区与行定位——登记于 STATUS 的平台词偏差条。

- **修复 N-ctx 同源壳下五处同源绝对 URL** —— 官方客户端假定自己由 dsh 源提供，但 chamber 单页多实例（N-ctx）下页面 origin 是控制面、只代理 `/api/i/<id>/*`，于是五处动作实测失效：`ui-chat` 的 `/api/file`（Markdown 本地图片坏图）、`client-file-upload` 的 `/api/session/uploadFileBinary`（**composer 附件上传 404**）、`ui-deliverables` 的 `/api/present.host|open`（交付卡「打开/定位」404）、`session-log-export` 的 `/api/session.export`（**/export 下载 404**）。修法为登记式**构建期 vendor 补丁集**（`packages/renderer/scripts/vendor-patches.mjs`，按精确上游锚点改写、vendor 文件零写入，锚点漂移即构建失败；补丁覆盖上传与导出客户端，官方 layout 部署下缺失 base path 时回落上游行为）。**已知边界**：本地与 gateway 来源经控制面注入 cookie 后可用；ssh/http dsh 目标仍无 cookie 注入（实例侧 401），属既有认证面待办。
- **chamber 自建包命名统一** —— 命名收口为「目录 == 包名非 scope 段」：6 个 client 插件包名 `@dsh-chamber/dsh-client-ui-*` → `@dsh-chamber/dsh-chamber-client-ui-*`（目录不变）；3 个宿主种子包的目录与包名 → `dsh-chamber-seed-<loader-id>`（`@dsh-chamber/dsh-chamber-seed-client-graph` / `-git-worktree` / `-archive-cleanup`；loader id、激活探针域与发布计数不变）；`dsh-client-ui-mobile`（client-kind 例外）、三个 fork 副本与基建包不动。**兼容性**：本版桌面壳按新清单名同步宿主包，而 ≤0.2.4 的就地 gateway 只认旧名——就地部署需先把 gateway 更新到本版；远端过渡把旧名 `cordis.patch.yml` 行按同 loader id 一次性改写，避免升级后 seed 因 id-bound 冲突硬失败。
- **连接恢复加固（2026-09）** —— 针对「上游连接管理只按本地/单实例设计，chamber 需面对隧道/慢链路/唤醒」的专项结论：
  - **每来源就绪期限**（新增 `dsh-client-connection/src/client/recovery-policy.ts`）：chamber 页面拿不到宿主注入的 `__DSH_CONNECTION_RECOVERY__` 页面全局，一直吃 15s 硬期限；现由 api-gateway fork 经上游支持的 `connection.start(sinks, config)` 为 ssh/http 来源传 45s 期限 / 5s 告警，本地与未知来源保持上游默认——冷 SSH 隧道或慢链路不再因握手超期被反复取消。
  - **唤醒事件旁路离线门**：页面跨挂起/恢复被冻结时可能整体错过 `online` 事件并持续误报 offline，而离线门会连 `system-resume` 一起挡掉。现 `system-resume` 旁路门（`reconnect()` 的 `immediateRetry` 跳过挂起分支，只强制一次有界尝试，真离线则快速失败重挂），`online`/可见性仍受门约束，三者共享 10s 去抖。
- **open-in 统一：单一 header 入口消费 per-source 视图模型** —— 本地来源吸收官方 client：
  - **本地来源（official 通道）**：实例自身官方宿主目录（`dsh-host-open-in-app`，随 a2 默认 web bundle 在）经每实例代理 `<basePath>/open-in-app/{apps,icon/<id>,open}` 提供全量本地应用拾取器——catalog 协议（`shared/open-in-app-protocol.ts`，与 vendor `shared.ts` 逐字锁步测试）、真实 bundle 图标（404 回退中性方框）、官方 `app.*` 标签表与按钮文案（并入单一 chamber locale NS）、选择持久化（官方 key `dsh.open-in-app.choice`，storage 不可用降级内存）、busy/error 呈现（250ms 延迟 busy、2s 错误衰减）全部吸收；桌面主进程的 VS Code 覆盖项按 §5.1「vscode 全家走 IPC 覆盖」+ r6「展示并集 + IPC 兜底」裁决：主进程该项可用时胜出（vscode 走 IPC，保留 `vscodeOpenInNewWindow`、来源代 proof 与深链 intent 推送），不可用时官方条目兜底（走实例路由）。
  - **远程 ssh 来源**：仅主进程 remote-capable 项（VS Code Remote-SSH，主进程构造 `vscode://vscode-remote` URL）；**http/未知来源**：无入口。
  - **桌面主进程瘦身（红线）**：`OpenInApp` 注册表 vscode-only；`OpenInLaunchContext` 移除 `stat`/`openPath`/`showItemInFolder`，finder provider 与 `classifyLocalPath`/`invokeOpenPath`/`normalizeOpenPathError`/`shouldRevealDirectoryInsteadOfOpen` 一并退役。本地 launch 的信任界由 trusted IPC 迁至实例官方路由（实例连接栅栏 + 官方 resolver 白名单/存在性校验），控制面仍零执行面（逐字透传 + browser-auth cookie 注入）；VS Code 深链语义、来源代 proof 与 OS 深链 `dsh-chamber://open-vscode` 入口不变。
  - 红线修订登记：design 16/20/05 + AGENTS 同步（最终设计验收由用户完成）。
- **升级工具收尾（2026-09）** —— 与 dsh 升级版本无关的三件收尾，均在当前 pin 上验证：
  - **升级前 pin 预检（新增 `scripts/dev/preflight-vendor-pin.mjs`，只读）**：对目标 tag 与当前 pin 做 diff，一次给出「三个 fork 副本按 pure/需人工重放/dropped 分类 + chamber 深引的 vendor seam 文件 + 上游包集合增删 + 新增 client 行 + 运行时是否已发布 npm」，支持 `--offline`/`--json`/`--fail-on-replay`（advisory 工具，不改工作树、不动 submodule HEAD）。把「先升 pin 才发现上游重写了外壳模型」这类坑提前成「动 pin 前先看清单」的流程第 0 步。
  - **锁文件 vendor 记录修复脚本加移除守卫（修复）**：`restore-lockfile-vendor-records.mjs` 原先无条件从 HEAD 复活被 pnpm 剪掉的 importer 记录；上游在 0.1.5 移除 workspace 成员（landlock 4 条）后，脚本会把已不存在的成员补回，frozen 安装随即以「锁文件有、链接缺」失败。现按 `vendor/harness-packages/@deepseek-ai/<name>` 链接存在性（含断链）跳过并打印清单。新增根脚本 `pnpm run test:upgrade-tools`（两个脚本测试）+ CI 步骤。
  - **聚合刷新陈旧阈值按传输分级**：sidebar 聚合的 S2 重连 watchdog 原为单一 120s 且**只覆盖 direct-http 来源**；现按来源传输取阈值——http 保留 120s（浏览器腿有控制面 30s WS ping，上游腿无应用心跳、仅约 10min OS TCP keepalive，需较紧的自愈），**ssh 新增 300s 兜底**（隧道已有三层独立探测器：代理 30s/1 miss WS ping、宿主 mux 2s/2 misses、SSH keepalive 30×3≈90s，该臂只补「应用级冻结」这一层，阈值必须显著长于 http 以免空闲健康隧道每两分钟付一次基线重放），本地/未知来源不武装（`AGGREGATE_RECONNECT_HTTP_STALE_MS`/`AGGREGATE_RECONNECT_SSH_STALE_MS` + `reconnectStalenessMsForTransport`）；unary 30s 拉取节奏不变，watchdog 始终是「拉取的补充」。新增单测 2 例（http/ssh 阈值与 local/未知跳过）。

- **设置面来源标记退役与归属判定**：nav 行的「插件」来源标记退役，回到上游形态；归属判定改按 npm scope。
- **提交信息语言（贡献规范）**：`CONTRIBUTING.md` 明确**提交信息一律英文**（subject 与 body 都是英文），历史中文提交是既有事实、不作先例；代码注释、设计文档与 PR 正文不受此限。

### 修复
- **会话行标签按官方链解析，「未命名会话」不再出现** —— 标签链为 `durable title → cwd 目录名 → 会话 id`，单点解析并随两个快照构造下发（进发布签名，标签单独变化也重发布）；行标签、悬停卡、可访问名、复制文本、搜索结果与其匹配、待办条、通知标题与 worktree 移除确认列表全部消费同一标签，宿主读不到标题的历史行按项目目录名标注。「未命名会话」只剩声明的例外（归档管理器的 durable 名列，以及行完全不在投影时的字典化兜底）。同批把「+」改为复用 workspace 中既有的空白成员（与上游 `connectWorkspace` 同谓词），双击不再新建出第二个隐形空行。
- **归档内容在任何状态下都可删（design 24 §5）** —— 归档管理器此前要求客户端能说出「正在查看的会话」并解析其向上子代理链，而这两个事实恰恰经常不可得（没开会话、vendor 在列表间隙掩码 `current`、来源壳被回收、冷行缺 cwd），于是删除控件对**最需要 force 的那些会话**（运行中归档，例如停在提问/审批）恒为禁用。现在只有一种形态：STOP 取消选择闭包全体成员（减去正在查看的会话；有限扇出、按输入顺序记账）且失败不再拒绝运行；PURGE 恒带 `force`，正在查看的会话改以「保护集」随请求下发并如实报 `skippedProtected`；无法解析当前会话时降级为顶部可见说明行，而不是禁用控件；归档动作本身在被归档的会话上**终止该会话及其子代理子树**。
- **移动端触控档：右栏面板、抽屉让位与 30s 自愈门（design 17 §18.6）** —— 右栏面板的强制全屏呈现与抽屉让位原先挂在 frame 的 `data-rightbar-collapsed` 上，而该标志的含义是「无保留轨道」（`cols.rightbar === 0`），手机档上面板已展开时它仍为假，两条规则正好在面板盖住屏幕时失效；现锚在面板自身的 `[data-sidebar-right-panel]`（关闭动画期间也保留盒），让位同时认两个已展开信号，面板补 `env(safe-area-inset-*)` 且为 border-box（否则刘海侧画到视口外），无作用的模式控件只在 768–1023px 带隐藏，面板内部不再把 overscroll 串到背后文档。composer 的 30s 卡死自愈原先只看 busy 相位，会把提交期间合法到来的锁（owner block / 离线父级 / 移除中）强行解开，现同时要求官方 `aria-disabled` 标记缺席，判定抽成纯谓词并导出两个 MutationObserver 选项集（缺 `attributeOldValue` 时该层静默失效）。视图标签条改为换行（滚动容器会裁掉上游画在标签盒外 1px 的激活条）且 44px 底线为 border-box；dockkit 条随控件增高，chip 保持 content-box。

- **归档清理后已删会话在侧边栏反复浮现（design 24 §12）**：purge 删除已归档
  会话内容后，官方客户端 `SessionManager.summaries` 不会刷新（宿主会话事件为
  文档化 no-op），而归档集合的收缩经官方 workspace follow 即时到达客户端，于是
  生产端推送把「收缩后的集合 + 陈旧的行」一起提交，已删会话以普通行渲染（点击报
  `session/not-found`）；30s unary 兜底拉取又把它清掉，形成「推送装回、拉取清掉」
  的闪烁。修复分四层：① 生产端**墓碑抑制**（离开权威归档集合的 id 从上报快照与
  运行时事实通道中过滤，直至官方 summaries 收敛或该 id 重新入集合）；②
  **校验式收敛链**（以方法调用官方 `ctx.sessions.refresh()`——此前的脱绑调用每次
  抛 `TypeError` 被吞掉、从未真正发出请求——resolve/reject/hung 三类结果均有界
  重试，终态用 chamber unary `session.list` 权威探针，只释放服务端仍存在的 id）；
  ③ App 侧**权威归档集记忆**（失去权威时作为收缩基线，并让降级 unary 视图继续
  过滤已归档行；`archiveSetKnown` 仍为 false，管理器保持非破坏性降级分支）；
  ④ 宿主**registry-global 孤儿清扫**（每次 purge 收尾清全集合无会话记录的成员：
  逐候选官方单 id 存在性校验 + 查询/持久化枚举并集 + 空/塌缩语料可信度门，
  只清集合成员、零新增删除语义，双重确认与 fail-closed）。
  设计与进度见 design 24 §12 与 `docs/progress/STATUS.md`。
- **移动端 Web 访问面（design 17 §18）**：四类真机反馈的复修与加固（含独立
  交叉复核轮：6 条 lane 的代码/症状/控制面/文档/复现/最优性审查，P1 已修）。
  - **tooltip 悬停残留**：官方 ui-primitives `Tooltip` 的 tap 会合成
    mouseenter 而没有配对 mouseleave（sticky hover），延迟气泡（200–500ms）
    常驻在刚用过的发送/停止键上。规则改为 `(pointer: coarse) and (hover: none)`
    门控（宽屏触控设备同样会点按；接鼠标时 hover 翻转为 hover、自动让位）且只
    针对**与可访问名重复**的气泡
    （`button[aria-label] + [role="tooltip"][data-side]`，气泡是 trigger 的紧邻
    下一兄弟且带组件自身的 `data-side` 标记）；四处信息型气泡（聊天统计行、
    代理预设卡片描述、轨迹时间轴 span、≤620px 的轨迹 kind 标签）**刻意保留**
    ——它们的 trigger 没有可访问的等价文本，隐藏等于让触控用户失去唯一可读
    来源；第五处 `role="tooltip"`（轨迹 turn-rail 预览）无 `data-side`，结构性
    排除。
  - **键盘补偿加固**：arm 以 frame 元素为单位幂等（renderer 重挂替换 AppFrame
    时重新打标，且旧 frame 的插件属性被清理）；新增**可编辑焦点**（focusin +
    focusout 打点 + composer 选区兜底）守卫；**缩放策略**改为「只服务 composer」
    ——原先的 `scale > 1.01` 一票否决会在 iOS 聚焦缩放后（抽屉 13px 搜索框是
    常见触发源）让 composer 永久留在键盘后（复核 P1），现在缩放 + 焦点在
    `[data-composer-seat]` 内照常补偿，非 composer 字段在缩放态仍否决；
    同时从源头消除聚焦缩放（抽屉内输入框补 16px 底线）；量化步进 48px → 16px
    （死区从 8–55px 收窄到 8–23px）；arm 期间归零 seat 的底部安全区 padding
    （消除刘海机 0–34px 双重间距）；focusin 纳入重同步通道。
  - **设置 sheet**：分区切换的滚动复位改为只认**分区 chip** 点击（判定抽为
    纯函数并加单测），并门控在**手机档**（769–1023px 触控平板保留官方弹窗
    几何与官方跨分区滚动行为）。
  - **连接稳定性取证（未修复）**：gateway/控制面共用的 WS splice 拆链新增一行
    有界日志（`WebSocket stream <id> closed (<cause>, <ms>ms)`），使**实例侧**
    mux 心跳判死与客户端主动重连在日志中可区分（此前只有代理自身心跳有日志，
    实例侧判死完全无痕；cause 为无括号 token，整行可解析，logger 抛异常不会
    锁死拆链）；修复动作仍待浏览器侧 close code 取证，取证结论与候选修复见
    `docs/progress/STATUS.md`。
  - 测试：移动插件 **60** 用例（0.2.4 时为 67；alpha.2 迁移重写 markup/drawer 用例后为 60——arm 决策/档位
    常量/设置 chip 判定/粗指针 tooltip 规则与声明体/抽屉 16px 底线）、
    control-plane `instance-proxy` 72 用例（+1，拆链日志契约）。

- **网关管理页的可访问性与请求边界**：确认控件改为**页内可访问对话框**（不再用夺焦的原生 confirm），待决期保持焦点封闭并修正 `aria-busy` 归属；请求边界收口——400 原因保真（不被改写成笼统码）、读面栅栏、auth 审计；`dsh plugin` 子进程的 `PATH` 上提供 gateway 自带的 pnpm，宿主无 pnpm 时插件任务不再失败。
- **Git worktree 改用上游原语**：自绘确认控件与自绘标签换成官方确认对话框与标签原语（外观/键盘/语义随上游一致）；风险确认闸门改为**一次手势生效**并加锁（原先连续确认会把同一次操作反复要求确认）。
- **桌面：打包钩子与 dev 启动**：`beforePack` 会把 `node_modules/@dsh-chamber/dsh-runtime` 从 workspace 链接换成 dist-only 实体目录（Windows junction 上 electron-builder 不跟随链接），但此前没有任何钩子还原——打包后工作区丢类型面，根 `typecheck` 与 `typecheck:gateway` 级联 TS7016、`build:preload` 失败，且 `pnpm install --frozen-lockfile` 修不回来。现 materialize/restore 拆为可测函数并在 exit/SIGINT/SIGTERM/SIGHUP 还原（SIGKILL 留下的污染由下一次打包治愈，目标已是实体目录时同样注册）；`dev` 启动不再每次重建渲染层。
- **CLI 与 dsh 运行时探针对齐真实契约**：`cli` 的运行期门与读面按真实契约修正；`dsh-runtime` 的 `commands/execute` 探针线名对齐并透出探针失败原因、UNC 路径脱敏、终止裁决点名失败探针（探针文本的保留词覆盖 legacy 方法名），`gateway` 的壳升级事务据此可判读失败原因。
- **renderer / sidebar / settings 审查轮修复**：失败呈现改走设计系统并统一外壳文案；打开意图与揭示门的接线加固（切换来源时不再露出目标壳自建的空白会话）；侧栏早开臂持续读意图并校验来源身份、工作区回声的会话归属修正；设置面归属判定改按 **npm scope**（而非枚举本仓 id），服务器设置行不再被误标「插件」，并恢复设置面板 Escape 关闭。
- **测试可移植性与 CI 形态**：`test:host-archive-cleanup` 的「大写后缀 near-miss」用例在**大小写不敏感文件系统**（macOS APFS 默认 / Windows NTFS）上本就不成立，现按运行时探测分支；两个测试专用 ESM loader 原先把 specifier 映射到裸 submodule 路径或工作区成员路径，使单测依赖**本机 vendor 安装形态**（CI 上 `zustand` 解析失败、`Cannot find package`），现将「跑真实 vendor 源码」的用例改为按契约的 store double，真实解析仍由源码锁与 `build:renderer` 把关；`purged-tracker` 的「到此为止恰好一次刷新」否定断言原先与真实 `retryMs` 计时器赛跑（CI 上 `2 !== 1`），现全部走注入时钟并把「无遗留计时器」钉进断言；另修 `test-windows` 门禁崩溃与 `host-open-in` 的 undici 类型落点。
- **移动端卡片网格口径与 ARIA 说明修正**（承接 design 17 §18 移动面）。
- **会话行悬停卡片改由 chamber 自己持有状态机（design 06 §7）** —— vendor `HoverCard` 以**已提交的 `open`** 决定是否 arm 关闭宽限（`ui-primitives/HoverCard.tsx:183-188`），而本壳一个页面跑所有实例的 React root：dwell 触发到提交之间实测 502–504ms（空闲）/501–551ms（主线程忙），落在该窗口的 `pointerleave` 什么都不 arm，卡片随后挂载而指针已离开，此后再无事件能关掉它（实测症状：鼠标快速扫过后卡片一直挂在页面上）。现由 `shared/hover-intent.ts` 的**指针在场标志**作唯一权威（dwell 触发时复查、leave 无条件 arm 宽限），可见性由机器经 `useSyncExternalStore` 直读、不再镜像进组件 state（否则 press/禁用 与 dwell 错序提交仍会 mount 出机器认为已关的卡片）；卡片盒、8px 偏移、夹取与「点卡片复制」契约照搬官方原子。相对官方原子另有**两处有意增量**：同一文档只允许一张行卡片可见（页面级 slot，跨 N-ctx 壳共享 —— 这同时是「leave 根本没送达」的自愈路径：窗口失焦、承载壳被隐藏/遮挡、列表在静止指针下移动），窗口 blur / 文档 hidden 时关闭可见卡片。验证：机器单测 16 例 + 接线锁 6 例、复现探针（enter 后 492–570ms 落 leave）本版 **0/45 残留**（vendor 版 7/45）、双来源真机（本地 + `192.168.110.172:30801` gateway 源）真实鼠标套件与**跨壳自愈**（本地壳残留卡在切到 gateway 壳后被新卡清掉）、GUI 走查新增 `W-4b`。
- **open-in 在生产里答出空目录（design 20 §4.2）** —— 页级机器目录只读了 wire 两层信封中的一层：`callUnary` 回答的是通用 RPC 结果（`{ok,value}`），其 `value` 才是宿主域自己的 `domainResult` 载体，`parseApps`/`parseIcon` 于是拿到载体而不是它的载荷 —— 生产里 `apps()` 恒答空目录、图标恒为 null（运行中的应用看不到访达、VS Code 条目画兜底方块），而直接喂域载体的单测桩全绿。现在两层都在拥有 wire 解析的模块里读（与 git、archiveCleanup 客户端同约定），并把通用 RPC 的拒绝投影到域载体的失败臂（拉起失败如实报 RPC 层原话，而不是「unrecognizable」）。验证：对**真机抓取的两层应答**做 A/B（旧模块 `load()` → `[]`，修后 → `finder/vscode/xcode/iterm/terminal` 五条 + 五张互不相同的 PNG 图标）、应用内菜单实测五项各带自有图标、gateway 来源（按设计 `localOnly`、宿主无该域）不留任何入口。
- **chamber 的「开/选中」色回到 dsh 业务蓝（design 15 §D1②、design 24 §6）** —— 设置面、连接页插件筛选 pill、归档管理器复选框与运行时安装进度填充此前取官方中性 `--dsw-alias-brand-primary`（浅色近黑、深色近白），「开/选中」态在浅色主题下画成黑色；现统一取 `--dsw-alias-state-business-primary`（deepseek-500/400），与侧栏选中/拖放指示、Git 面板滑块的既有业务蓝一致，并用一条面板作用域规则（特异性 0,3,0）重画原语的已选轨道，避免依赖打包顺序。


## [0.3.0-beta.2] - 2026-09-13

### 新增
- **启动降级提示：结构性缺口不再是静默空栏（design 05 §4「降级呈现」）** —— 来源可以「启动成功」却整面缺席（复合首屏需要的 `sidebarRight` 只由可选宿主图行提供时，fiber 停在 pending、会话面从不注册，主栏只剩 composer），此前只有控制台一行日志。现在降级是**结构化事实**（kind + 载荷）并有三处如实呈现：主栏横幅（仅当前视图、`role=status`、控制面不可达时让位）、侧栏来源行提示（并入该行唯一的 live region，优先级 managed-down > gap > transient > baseline）、连接页卡片与插件对话框（缺口期抑制图状态，因为图通道恰在此时是健康的），三者共用同一个重试入口；settle 之前到达的判定按 boot serial 挂起、settle 时补发。

- **GUI 验收工具箱与流程清单（`pnpm run acceptance:gui`；清单见 `docs/checklists/gui-acceptance-checklist.md`）**：GUI 验收此前没有规范化文档或可复用步骤——判据散在 `docs/design/*`（各域门禁）、`docs/progress/STATUS.md`（开放实机项）与 `scripts/perf`（性能尺子，非功能验收），每轮都要重新发明且无法回归。清单只写**流程 + 指针**（四条腿：机械 A/B、目检、打包态；每行给检查 id 与 design/STATUS 依据，不复述判据，避免出现第二份会漂移的台账）；工具箱**零新依赖**（Node 内置 `WebSocket`/`fetch`），分纯判据层 `checks.mjs`（16 个单测进 linux test job）与驱动层 `probe`（`--live` 只读探测运行中的应用，安装态亦可）/`walkthrough`（`--attach`/`--dev` 的 CDP 走查 + 截图）/`launch`/`run`。断言只用仓库既有 DOM 契约（`[data-instance]`、`[data-chamber-section|row]`、`[data-slot]`/`[data-slot-error]`、设置导航 `dialog nav [class*="navList"] > button`），不新增测试钩子、不靠文案匹配；点击白名单只含设置导航项与首启关闭动作，按不到任何变更控件。已登记容忍（冷启动 `clientGraph/graph` 503 = design 09 §3.2、页面自身重订阅的 `net::ERR_ABORTED`、上游 cordis 启动日志、实例未就绪时实例面转 INFO = design 18 §3.4）写在工具箱 README——要放宽先改文档，不在代码里猜。
- **open-in 宿主半 fork 为实例内 seed 包（design 20 §2.1、§6.3）**：Phase 2 的「让官方两份在 N-ctx 壳里跑通」被三条独立证据否掉（托管实例注入的 `SSH_CONNECTION` 目录选择 pin 被上游三处共用、官方客户端半假定同源绝对路径、官方行依赖实例 runtime 版本），改为 **fork & supersede**：新增 `packages/dsh-chamber-seed-open-in/`（上游 `host/open-in-app` 的 fork；`catalog`/`resolver`/`icons` 逐字节 pure），三条有意分歧写进源码首页——删 SSH 休眠门、HTTP 路由 + 自建连接栅栏换成 typert Remote `openInApp/{probe,apps,icon,open}` 域载体、Config schema 换成常量；客户端本地池改走实例自身通用 RPC。这是既有注册表纪律的又一有界例外。
- **设置面改为完整桥接（design 05 §5，2026-12 修订）**：设置壳不再为选中来源装配「缩小版前端」，而是渲染**该来源自己 boot ctx** 的 `settings.section` 台账，条目用该 ctx 自己渲染器绑定的标准座渲染——插件在实例自身前端 active，在这里就同样 active（真 remote WS 事件流、实时 settings 失效通知、真的 `useSessions`/`useWorkspaces`/`usePanelInfo`/`useResource` 座），上游 `ui-agent-preset` 的创作入口因此与实例本地一致。由每实例面注册表（`settings-source-face.ts`）两半齐备才可渲染，化身指纹须与权威 roster 相同；面板打开期间保证该来源壳保持挂载（**不切 active view**），关闭即撤除，离线来源仍显示不可达占位且不触发挂载。
- **侧栏：未挂载来源新建的工作区立即可见 + 打开意图契约**：真机反馈「在 A 来源给 B 来源新建工作区，该行不出现，必须点开 B 才刷新」。改法是把侧栏自己那次 unary `workspace.create` 的成功结果当作「该工作区现在存在于那个宿主上」的唯一可信事实上报（`chamberBridge.reportWorkspaceCreated`），并在投影的**唯一汇合点**并入（不新增第二个权威，权威仍是挂载壳的 follow 基线），附三类退休条件：同 `workspaceId`/同路径的真实 push、来源离开注册表、10 分钟 TTL（挂在本次 create、权威 push、30s unary 兜底拉取三处时钟）。同批加固打开意图三闸门：早开臂持续读意图、校验来源身份、工作区回声的会话归属（契约登记于 design 05 §2.2.1）。
- **归档清理：force purge、归档感知的 worktree 移除与单一宿主包注册表（design 24 §22、design 08）**：归档清理新增 force/loaded 语义（运行中与已加载的会话整棵跳过，`resolvePlan` 除 `skippedRunning` 外同时报 `skippedLoaded`），并与 registry-global 孤儿清扫共用一次运行（`readAuthoritativeState` 同时给出 `liveFacts` 与 `snapshotRecordCount`，存活排除集取 running ∪ loaded）；Git worktree 的删除改为归档感知；三个 chamber 宿主包（client-graph / git-worktree / archive-cleanup）统一到**单一注册表**来源，gateway 与控制面的清单不再各写一份。
- **上游触点登记表与保鲜门、上游设计 token 合规门**：新增 `docs/checklists/upstream-touchpoints.md`（逐文件纯度登记 [pure]/[patch-add]/[patch-mod]/[patch-comment]/[own-divergent]/[own]/[dropped]、dropped 表、深引/roster 段、契约镜像表、产物登记、每 tag 的 8 步维护环）与 `scripts/dev/verify-upstream-touchpoints.mjs`（C1 pure 字节相等 / C2 tag 间重放报告 / C3 完整性 / C4 roster 哨兵 / C5 锚点扫描 / C6 排除目录存在性 / C7 种子域锁步 / C8 产物陈旧度 / C9-C10 锚点与活字面量），两个维护面互为镜像、CI 两腿都在 vendor 引导后即跑；另有 `verify:styles`（上游设计 token 合规门：发丝线 / 浮层阴影 / 命名空间）与 `PULL_REQUEST_TEMPLATE` 的触点自检段。
- **写者静默闩锁的会话内再证明与「清理并接管」（design 02 §3.4）**：启动扫描只在「零 kept 且零 errors」时打开闩锁，且**只在启动时跑一次**——记录一旦在会话中途变陈旧，闩锁再也打不开，表现为硬杀后「本地实例起不来」（`POST /api/connections` 恒 409、启动/停止点不动、只能重启应用）。现将两种关闭原因分开：**扫描判定**类在拒绝启动前做有界再证明（单飞 + 2s 冷却；孤儿已退出的常见情形无需任何用户动作即恢复），**写入期终止失败**类（`onWriterQuiescenceUnknown`）任何扫描都无法证明、对本平面生命周期粘滞并明确提示重启；`runReaper` 增 `takeover` 模式与条目级结论（`reason`/`takeOverAvailable`），只清**本状态目录自己**的陈旧/孤儿写者，owner 仍活的另一实例永不受影响；连接页据此提供显式「清理并接管」。

### 变更
- **chamber 界面按官方非密度 token 与几何取值** —— 上一轮按「密度档」推导的若干取值回到官方非密度值；所有 chamber 弹层菜单（会话/工作区 kebab、排序、Git 创建对话框的字段下拉、open-in 应用菜单、设置页服务器下拉）统一取原语 `compact` 档（26px / 12px 行），与「菜单密度 = chamber 档」的全仓裁决一致；图标按钮保留原视觉盒并补 24px 命中区；设置页服务器下拉圆角对齐官方 20px。
- **open-in：目录与图标改由本机实例的页级机器目录回答，呈现取官方分体按钮** —— 应用目录、图标与拉起描述的是**这台机器**而非屏幕上的来源，故由渲染壳对本地实例建**唯一一份**机器目录并注入每个 entry（本地与远程一视同仁，远程来源的条目也显示本机真图标），传输复用本地 entry 自己的 `/api/i/local` 通用 RPC，插件侧不再持有连接载波；图标缺失一律回落官方圆角方块，chamber 自有位图全部删除（选图规则收敛成官方那一条）。header 控件的呈现同时彻底取官方 open-in 分体按钮（28px / `border-l4` / r14 容器、主按钮 15px mark、设计系统 chevron、菜单行 18px mark）；官方没有单条目形态，本入口也不再保留纯图标按钮形态。

- **dsh 推进到 `0.1.5-rc.2` 一代（构建期 vendor 源 + 捆绑运行时同代）** —— 相对上一正式版，源码 pin、捆绑运行时、三个 fork 副本（`dsh-client-connection` / `dsh-client-web` / `dsh-api-gateway`）与安装脚本 / gateway 的 `dshAnchorVersion` 同处 `0.1.5-rc.2`。上游在本区间重写了客户端外壳的两代槽位模型（`details`→`rightbar` 且 scope 由 session 改为 root；中心列 `conversation`→keyed `main`；新增 `sidebar.panellist` 轴与 `usePanelInfo`/`useResource` 全局座），chamber 的 layout / sidebar / mobile / settings 自建物随之全量重放，外观与交互仍为 chamber 形态。
  - **经运行时线进入受管实例的上游可见变化**：base bundle 默认模型 `deepseek-v4-flash` → **`deepseek-flash`**（V41 Flash；catalog 3→4 条，保留 V4 Flash / V4 Pro / V4 Flash Vision Exp），该条目声明 `systemPromptUpdate: 'in-history'`（V4 系不声明、行为不变）；上游自带告诫——网关未启用该 id 前请求可能 `INVALID_REQUEST`，可在设置里改回 V4 系。
  - **版本歪斜登记**：实例侧 documentpreview 的代码预览自该代起行为依赖同代 `ui-primitives`（`CodeBlock` 的 `contentRef` 是其唯一滚动/行定位锚点），旧代 composite 服务新 instance 时该预览失去独立滚动区与行定位——登记于 STATUS 的平台词偏差条。

- **修复 N-ctx 同源壳下五处同源绝对 URL** —— 官方客户端假定自己由 dsh 源提供，但 chamber 单页多实例（N-ctx）下页面 origin 是控制面、只代理 `/api/i/<id>/*`，于是五处动作实测失效：`ui-chat` 的 `/api/file`（Markdown 本地图片坏图）、`client-file-upload` 的 `/api/session/uploadFileBinary`（**composer 附件上传 404**）、`ui-deliverables` 的 `/api/present.host|open`（交付卡「打开/定位」404）、`session-log-export` 的 `/api/session.export`（**/export 下载 404**）。修法为登记式**构建期 vendor 补丁集**（`packages/renderer/scripts/vendor-patches.mjs`，按精确上游锚点改写、vendor 文件零写入，锚点漂移即构建失败；补丁覆盖上传与导出客户端，官方 layout 部署下缺失 base path 时回落上游行为）。**已知边界**：本地与 gateway 来源经控制面注入 cookie 后可用；ssh/http dsh 目标仍无 cookie 注入（实例侧 401），属既有认证面待办。
- **chamber 自建包命名统一** —— 命名收口为「目录 == 包名非 scope 段」：6 个 client 插件包名 `@dsh-chamber/dsh-client-ui-*` → `@dsh-chamber/dsh-chamber-client-ui-*`（目录不变）；3 个宿主种子包的目录与包名 → `dsh-chamber-seed-<loader-id>`（`@dsh-chamber/dsh-chamber-seed-client-graph` / `-git-worktree` / `-archive-cleanup`；loader id、激活探针域与发布计数不变）；`dsh-client-ui-mobile`（client-kind 例外）、三个 fork 副本与基建包不动。**兼容性**：本版桌面壳按新清单名同步宿主包，而 ≤0.2.4 的就地 gateway 只认旧名——就地部署需先把 gateway 更新到本版；远端过渡把旧名 `cordis.patch.yml` 行按同 loader id 一次性改写，避免升级后 seed 因 id-bound 冲突硬失败。
- **连接恢复加固（2026-09）** —— 针对「上游连接管理只按本地/单实例设计，chamber 需面对隧道/慢链路/唤醒」的专项结论：
  - **每来源就绪期限**（新增 `dsh-client-connection/src/client/recovery-policy.ts`）：chamber 页面拿不到宿主注入的 `__DSH_CONNECTION_RECOVERY__` 页面全局，一直吃 15s 硬期限；现由 api-gateway fork 经上游支持的 `connection.start(sinks, config)` 为 ssh/http 来源传 45s 期限 / 5s 告警，本地与未知来源保持上游默认——冷 SSH 隧道或慢链路不再因握手超期被反复取消。
  - **唤醒事件旁路离线门**：页面跨挂起/恢复被冻结时可能整体错过 `online` 事件并持续误报 offline，而离线门会连 `system-resume` 一起挡掉。现 `system-resume` 旁路门（`reconnect()` 的 `immediateRetry` 跳过挂起分支，只强制一次有界尝试，真离线则快速失败重挂），`online`/可见性仍受门约束，三者共享 10s 去抖。
- **open-in 统一：单一 header 入口消费 per-source 视图模型** —— 本地来源吸收官方 client：
  - **本地来源（official 通道）**：实例自身官方宿主目录（`dsh-host-open-in-app`，随 a2 默认 web bundle 在）经每实例代理 `<basePath>/open-in-app/{apps,icon/<id>,open}` 提供全量本地应用拾取器——catalog 协议（`shared/open-in-app-protocol.ts`，与 vendor `shared.ts` 逐字锁步测试）、真实 bundle 图标（404 回退中性方框）、官方 `app.*` 标签表与按钮文案（并入单一 chamber locale NS）、选择持久化（官方 key `dsh.open-in-app.choice`，storage 不可用降级内存）、busy/error 呈现（250ms 延迟 busy、2s 错误衰减）全部吸收；桌面主进程的 VS Code 覆盖项按 §5.1「vscode 全家走 IPC 覆盖」+ r6「展示并集 + IPC 兜底」裁决：主进程该项可用时胜出（vscode 走 IPC，保留 `vscodeOpenInNewWindow`、来源代 proof 与深链 intent 推送），不可用时官方条目兜底（走实例路由）。
  - **远程 ssh 来源**：仅主进程 remote-capable 项（VS Code Remote-SSH，主进程构造 `vscode://vscode-remote` URL）；**http/未知来源**：无入口。
  - **桌面主进程瘦身（红线）**：`OpenInApp` 注册表 vscode-only；`OpenInLaunchContext` 移除 `stat`/`openPath`/`showItemInFolder`，finder provider 与 `classifyLocalPath`/`invokeOpenPath`/`normalizeOpenPathError`/`shouldRevealDirectoryInsteadOfOpen` 一并退役。本地 launch 的信任界由 trusted IPC 迁至实例官方路由（实例连接栅栏 + 官方 resolver 白名单/存在性校验），控制面仍零执行面（逐字透传 + browser-auth cookie 注入）；VS Code 深链语义、来源代 proof 与 OS 深链 `dsh-chamber://open-vscode` 入口不变。
  - 红线修订登记：design 16/20/05 + AGENTS 同步（最终设计验收由用户完成）。
- **升级工具收尾（2026-09）** —— 与 dsh 升级版本无关的三件收尾，均在当前 pin 上验证：
  - **升级前 pin 预检（新增 `scripts/dev/preflight-vendor-pin.mjs`，只读）**：对目标 tag 与当前 pin 做 diff，一次给出「三个 fork 副本按 pure/需人工重放/dropped 分类 + chamber 深引的 vendor seam 文件 + 上游包集合增删 + 新增 client 行 + 运行时是否已发布 npm」，支持 `--offline`/`--json`/`--fail-on-replay`（advisory 工具，不改工作树、不动 submodule HEAD）。把「先升 pin 才发现上游重写了外壳模型」这类坑提前成「动 pin 前先看清单」的流程第 0 步。
  - **锁文件 vendor 记录修复脚本加移除守卫（修复）**：`restore-lockfile-vendor-records.mjs` 原先无条件从 HEAD 复活被 pnpm 剪掉的 importer 记录；上游在 0.1.5 移除 workspace 成员（landlock 4 条）后，脚本会把已不存在的成员补回，frozen 安装随即以「锁文件有、链接缺」失败。现按 `vendor/harness-packages/@deepseek-ai/<name>` 链接存在性（含断链）跳过并打印清单。新增根脚本 `pnpm run test:upgrade-tools`（两个脚本测试）+ CI 步骤。
  - **聚合刷新陈旧阈值按传输分级**：sidebar 聚合的 S2 重连 watchdog 原为单一 120s 且**只覆盖 direct-http 来源**；现按来源传输取阈值——http 保留 120s（浏览器腿有控制面 30s WS ping，上游腿无应用心跳、仅约 10min OS TCP keepalive，需较紧的自愈），**ssh 新增 300s 兜底**（隧道已有三层独立探测器：代理 30s/1 miss WS ping、宿主 mux 2s/2 misses、SSH keepalive 30×3≈90s，该臂只补「应用级冻结」这一层，阈值必须显著长于 http 以免空闲健康隧道每两分钟付一次基线重放），本地/未知来源不武装（`AGGREGATE_RECONNECT_HTTP_STALE_MS`/`AGGREGATE_RECONNECT_SSH_STALE_MS` + `reconnectStalenessMsForTransport`）；unary 30s 拉取节奏不变，watchdog 始终是「拉取的补充」。新增单测 2 例（http/ssh 阈值与 local/未知跳过）。

- **设置面来源标记退役与归属判定**：nav 行的「插件」来源标记退役，回到上游形态；归属判定改按 npm scope。
- **提交信息语言（贡献规范）**：`CONTRIBUTING.md` 明确**提交信息一律英文**（subject 与 body 都是英文），历史中文提交是既有事实、不作先例；代码注释、设计文档与 PR 正文不受此限。

### 修复
- **会话行标签按官方链解析，「未命名会话」不再出现** —— 标签链为 `durable title → cwd 目录名 → 会话 id`，单点解析并随两个快照构造下发（进发布签名，标签单独变化也重发布）；行标签、悬停卡、可访问名、复制文本、搜索结果与其匹配、待办条、通知标题与 worktree 移除确认列表全部消费同一标签，宿主读不到标题的历史行按项目目录名标注。「未命名会话」只剩声明的例外（归档管理器的 durable 名列，以及行完全不在投影时的字典化兜底）。同批把「+」改为复用 workspace 中既有的空白成员（与上游 `connectWorkspace` 同谓词），双击不再新建出第二个隐形空行。
- **归档内容在任何状态下都可删（design 24 §5）** —— 归档管理器此前要求客户端能说出「正在查看的会话」并解析其向上子代理链，而这两个事实恰恰经常不可得（没开会话、vendor 在列表间隙掩码 `current`、来源壳被回收、冷行缺 cwd），于是删除控件对**最需要 force 的那些会话**（运行中归档，例如停在提问/审批）恒为禁用。现在只有一种形态：STOP 取消选择闭包全体成员（减去正在查看的会话；有限扇出、按输入顺序记账）且失败不再拒绝运行；PURGE 恒带 `force`，正在查看的会话改以「保护集」随请求下发并如实报 `skippedProtected`；无法解析当前会话时降级为顶部可见说明行，而不是禁用控件；归档动作本身在被归档的会话上**终止该会话及其子代理子树**。
- **移动端触控档：右栏面板、抽屉让位与 30s 自愈门（design 17 §18.6）** —— 右栏面板的强制全屏呈现与抽屉让位原先挂在 frame 的 `data-rightbar-collapsed` 上，而该标志的含义是「无保留轨道」（`cols.rightbar === 0`），手机档上面板已展开时它仍为假，两条规则正好在面板盖住屏幕时失效；现锚在面板自身的 `[data-sidebar-right-panel]`（关闭动画期间也保留盒），让位同时认两个已展开信号，面板补 `env(safe-area-inset-*)` 且为 border-box（否则刘海侧画到视口外），无作用的模式控件只在 768–1023px 带隐藏，面板内部不再把 overscroll 串到背后文档。composer 的 30s 卡死自愈原先只看 busy 相位，会把提交期间合法到来的锁（owner block / 离线父级 / 移除中）强行解开，现同时要求官方 `aria-disabled` 标记缺席，判定抽成纯谓词并导出两个 MutationObserver 选项集（缺 `attributeOldValue` 时该层静默失效）。视图标签条改为换行（滚动容器会裁掉上游画在标签盒外 1px 的激活条）且 44px 底线为 border-box；dockkit 条随控件增高，chip 保持 content-box。

- **归档清理后已删会话在侧边栏反复浮现（design 24 §12）**：purge 删除已归档
  会话内容后，官方客户端 `SessionManager.summaries` 不会刷新（宿主会话事件为
  文档化 no-op），而归档集合的收缩经官方 workspace follow 即时到达客户端，于是
  生产端推送把「收缩后的集合 + 陈旧的行」一起提交，已删会话以普通行渲染（点击报
  `session/not-found`）；30s unary 兜底拉取又把它清掉，形成「推送装回、拉取清掉」
  的闪烁。修复分四层：① 生产端**墓碑抑制**（离开权威归档集合的 id 从上报快照与
  运行时事实通道中过滤，直至官方 summaries 收敛或该 id 重新入集合）；②
  **校验式收敛链**（以方法调用官方 `ctx.sessions.refresh()`——此前的脱绑调用每次
  抛 `TypeError` 被吞掉、从未真正发出请求——resolve/reject/hung 三类结果均有界
  重试，终态用 chamber unary `session.list` 权威探针，只释放服务端仍存在的 id）；
  ③ App 侧**权威归档集记忆**（失去权威时作为收缩基线，并让降级 unary 视图继续
  过滤已归档行；`archiveSetKnown` 仍为 false，管理器保持非破坏性降级分支）；
  ④ 宿主**registry-global 孤儿清扫**（每次 purge 收尾清全集合无会话记录的成员：
  逐候选官方单 id 存在性校验 + 查询/持久化枚举并集 + 空/塌缩语料可信度门，
  只清集合成员、零新增删除语义，双重确认与 fail-closed）。
  设计与进度见 design 24 §12 与 `docs/progress/STATUS.md`。
- **移动端 Web 访问面（design 17 §18）**：四类真机反馈的复修与加固（含独立
  交叉复核轮：6 条 lane 的代码/症状/控制面/文档/复现/最优性审查，P1 已修）。
  - **tooltip 悬停残留**：官方 ui-primitives `Tooltip` 的 tap 会合成
    mouseenter 而没有配对 mouseleave（sticky hover），延迟气泡（200–500ms）
    常驻在刚用过的发送/停止键上。规则改为 `(pointer: coarse) and (hover: none)`
    门控（宽屏触控设备同样会点按；接鼠标时 hover 翻转为 hover、自动让位）且只
    针对**与可访问名重复**的气泡
    （`button[aria-label] + [role="tooltip"][data-side]`，气泡是 trigger 的紧邻
    下一兄弟且带组件自身的 `data-side` 标记）；四处信息型气泡（聊天统计行、
    代理预设卡片描述、轨迹时间轴 span、≤620px 的轨迹 kind 标签）**刻意保留**
    ——它们的 trigger 没有可访问的等价文本，隐藏等于让触控用户失去唯一可读
    来源；第五处 `role="tooltip"`（轨迹 turn-rail 预览）无 `data-side`，结构性
    排除。
  - **键盘补偿加固**：arm 以 frame 元素为单位幂等（renderer 重挂替换 AppFrame
    时重新打标，且旧 frame 的插件属性被清理）；新增**可编辑焦点**（focusin +
    focusout 打点 + composer 选区兜底）守卫；**缩放策略**改为「只服务 composer」
    ——原先的 `scale > 1.01` 一票否决会在 iOS 聚焦缩放后（抽屉 13px 搜索框是
    常见触发源）让 composer 永久留在键盘后（复核 P1），现在缩放 + 焦点在
    `[data-composer-seat]` 内照常补偿，非 composer 字段在缩放态仍否决；
    同时从源头消除聚焦缩放（抽屉内输入框补 16px 底线）；量化步进 48px → 16px
    （死区从 8–55px 收窄到 8–23px）；arm 期间归零 seat 的底部安全区 padding
    （消除刘海机 0–34px 双重间距）；focusin 纳入重同步通道。
  - **设置 sheet**：分区切换的滚动复位改为只认**分区 chip** 点击（判定抽为
    纯函数并加单测），并门控在**手机档**（769–1023px 触控平板保留官方弹窗
    几何与官方跨分区滚动行为）。
  - **连接稳定性取证（未修复）**：gateway/控制面共用的 WS splice 拆链新增一行
    有界日志（`WebSocket stream <id> closed (<cause>, <ms>ms)`），使**实例侧**
    mux 心跳判死与客户端主动重连在日志中可区分（此前只有代理自身心跳有日志，
    实例侧判死完全无痕；cause 为无括号 token，整行可解析，logger 抛异常不会
    锁死拆链）；修复动作仍待浏览器侧 close code 取证，取证结论与候选修复见
    `docs/progress/STATUS.md`。
  - 测试：移动插件 **60** 用例（0.2.4 时为 67；alpha.2 迁移重写 markup/drawer 用例后为 60——arm 决策/档位
    常量/设置 chip 判定/粗指针 tooltip 规则与声明体/抽屉 16px 底线）、
    control-plane `instance-proxy` 72 用例（+1，拆链日志契约）。

- **网关管理页的可访问性与请求边界**：确认控件改为**页内可访问对话框**（不再用夺焦的原生 confirm），待决期保持焦点封闭并修正 `aria-busy` 归属；请求边界收口——400 原因保真（不被改写成笼统码）、读面栅栏、auth 审计；`dsh plugin` 子进程的 `PATH` 上提供 gateway 自带的 pnpm，宿主无 pnpm 时插件任务不再失败。
- **Git worktree 改用上游原语**：自绘确认控件与自绘标签换成官方确认对话框与标签原语（外观/键盘/语义随上游一致）；风险确认闸门改为**一次手势生效**并加锁（原先连续确认会把同一次操作反复要求确认）。
- **桌面：打包钩子与 dev 启动**：`beforePack` 会把 `node_modules/@dsh-chamber/dsh-runtime` 从 workspace 链接换成 dist-only 实体目录（Windows junction 上 electron-builder 不跟随链接），但此前没有任何钩子还原——打包后工作区丢类型面，根 `typecheck` 与 `typecheck:gateway` 级联 TS7016、`build:preload` 失败，且 `pnpm install --frozen-lockfile` 修不回来。现 materialize/restore 拆为可测函数并在 exit/SIGINT/SIGTERM/SIGHUP 还原（SIGKILL 留下的污染由下一次打包治愈，目标已是实体目录时同样注册）；`dev` 启动不再每次重建渲染层。
- **CLI 与 dsh 运行时探针对齐真实契约**：`cli` 的运行期门与读面按真实契约修正；`dsh-runtime` 的 `commands/execute` 探针线名对齐并透出探针失败原因、UNC 路径脱敏、终止裁决点名失败探针（探针文本的保留词覆盖 legacy 方法名），`gateway` 的壳升级事务据此可判读失败原因。
- **renderer / sidebar / settings 审查轮修复**：失败呈现改走设计系统并统一外壳文案；打开意图与揭示门的接线加固（切换来源时不再露出目标壳自建的空白会话）；侧栏早开臂持续读意图并校验来源身份、工作区回声的会话归属修正；设置面归属判定改按 **npm scope**（而非枚举本仓 id），服务器设置行不再被误标「插件」，并恢复设置面板 Escape 关闭。
- **测试可移植性与 CI 形态**：`test:host-archive-cleanup` 的「大写后缀 near-miss」用例在**大小写不敏感文件系统**（macOS APFS 默认 / Windows NTFS）上本就不成立，现按运行时探测分支；两个测试专用 ESM loader 原先把 specifier 映射到裸 submodule 路径或工作区成员路径，使单测依赖**本机 vendor 安装形态**（CI 上 `zustand` 解析失败、`Cannot find package`），现将「跑真实 vendor 源码」的用例改为按契约的 store double，真实解析仍由源码锁与 `build:renderer` 把关；`purged-tracker` 的「到此为止恰好一次刷新」否定断言原先与真实 `retryMs` 计时器赛跑（CI 上 `2 !== 1`），现全部走注入时钟并把「无遗留计时器」钉进断言；另修 `test-windows` 门禁崩溃与 `host-open-in` 的 undici 类型落点。
- **移动端卡片网格口径与 ARIA 说明修正**（承接 design 17 §18 移动面）。


## [0.3.0-beta.1] - 2026-09-12

### 新增

- **GUI 验收工具箱与流程清单（`pnpm run acceptance:gui`；清单见 `docs/checklists/gui-acceptance-checklist.md`）**：GUI 验收此前没有规范化文档或可复用步骤——判据散在 `docs/design/*`（各域门禁）、`docs/progress/STATUS.md`（开放实机项）与 `scripts/perf`（性能尺子，非功能验收），每轮都要重新发明且无法回归。清单只写**流程 + 指针**（四条腿：机械 A/B、目检、打包态；每行给检查 id 与 design/STATUS 依据，不复述判据，避免出现第二份会漂移的台账）；工具箱**零新依赖**（Node 内置 `WebSocket`/`fetch`），分纯判据层 `checks.mjs`（16 个单测进 linux test job）与驱动层 `probe`（`--live` 只读探测运行中的应用，安装态亦可）/`walkthrough`（`--attach`/`--dev` 的 CDP 走查 + 截图）/`launch`/`run`。断言只用仓库既有 DOM 契约（`[data-instance]`、`[data-chamber-section|row]`、`[data-slot]`/`[data-slot-error]`、设置导航 `dialog nav [class*="navList"] > button`），不新增测试钩子、不靠文案匹配；点击白名单只含设置导航项与首启关闭动作，按不到任何变更控件。已登记容忍（冷启动 `clientGraph/graph` 503 = design 09 §3.2、页面自身重订阅的 `net::ERR_ABORTED`、上游 cordis 启动日志、实例未就绪时实例面转 INFO = design 18 §3.4）写在工具箱 README——要放宽先改文档，不在代码里猜。
- **open-in 宿主半 fork 为实例内 seed 包（design 20 §2.1、§6.3）**：Phase 2 的「让官方两份在 N-ctx 壳里跑通」被三条独立证据否掉（托管实例注入的 `SSH_CONNECTION` 目录选择 pin 被上游三处共用、官方客户端半假定同源绝对路径、官方行依赖实例 runtime 版本），改为 **fork & supersede**：新增 `packages/dsh-chamber-seed-open-in/`（上游 `host/open-in-app` 的 fork；`catalog`/`resolver`/`icons` 逐字节 pure），三条有意分歧写进源码首页——删 SSH 休眠门、HTTP 路由 + 自建连接栅栏换成 typert Remote `openInApp/{probe,apps,icon,open}` 域载体、Config schema 换成常量；客户端本地池改走实例自身通用 RPC。这是既有注册表纪律的又一有界例外。
- **设置面改为完整桥接（design 05 §5，2026-12 修订）**：设置壳不再为选中来源装配「缩小版前端」，而是渲染**该来源自己 boot ctx** 的 `settings.section` 台账，条目用该 ctx 自己渲染器绑定的标准座渲染——插件在实例自身前端 active，在这里就同样 active（真 remote WS 事件流、实时 settings 失效通知、真的 `useSessions`/`useWorkspaces`/`usePanelInfo`/`useResource` 座），上游 `ui-agent-preset` 的创作入口因此与实例本地一致。由每实例面注册表（`settings-source-face.ts`）两半齐备才可渲染，化身指纹须与权威 roster 相同；面板打开期间保证该来源壳保持挂载（**不切 active view**），关闭即撤除，离线来源仍显示不可达占位且不触发挂载。
- **侧栏：未挂载来源新建的工作区立即可见 + 打开意图契约**：真机反馈「在 A 来源给 B 来源新建工作区，该行不出现，必须点开 B 才刷新」。改法是把侧栏自己那次 unary `workspace.create` 的成功结果当作「该工作区现在存在于那个宿主上」的唯一可信事实上报（`chamberBridge.reportWorkspaceCreated`），并在投影的**唯一汇合点**并入（不新增第二个权威，权威仍是挂载壳的 follow 基线），附三类退休条件：同 `workspaceId`/同路径的真实 push、来源离开注册表、10 分钟 TTL（挂在本次 create、权威 push、30s unary 兜底拉取三处时钟）。同批加固打开意图三闸门：早开臂持续读意图、校验来源身份、工作区回声的会话归属（契约登记于 design 05 §2.2.1）。
- **归档清理：force purge、归档感知的 worktree 移除与单一宿主包注册表（design 24 §22、design 08）**：归档清理新增 force/loaded 语义（运行中与已加载的会话整棵跳过，`resolvePlan` 除 `skippedRunning` 外同时报 `skippedLoaded`），并与 registry-global 孤儿清扫共用一次运行（`readAuthoritativeState` 同时给出 `liveFacts` 与 `snapshotRecordCount`，存活排除集取 running ∪ loaded）；Git worktree 的删除改为归档感知；三个 chamber 宿主包（client-graph / git-worktree / archive-cleanup）统一到**单一注册表**来源，gateway 与控制面的清单不再各写一份。
- **上游触点登记表与保鲜门、上游设计 token 合规门**：新增 `docs/checklists/upstream-touchpoints.md`（逐文件纯度登记 [pure]/[patch-add]/[patch-mod]/[patch-comment]/[own-divergent]/[own]/[dropped]、dropped 表、深引/roster 段、契约镜像表、产物登记、每 tag 的 8 步维护环）与 `scripts/dev/verify-upstream-touchpoints.mjs`（C1 pure 字节相等 / C2 tag 间重放报告 / C3 完整性 / C4 roster 哨兵 / C5 锚点扫描 / C6 排除目录存在性 / C7 种子域锁步 / C8 产物陈旧度 / C9-C10 锚点与活字面量），两个维护面互为镜像、CI 两腿都在 vendor 引导后即跑；另有 `verify:styles`（上游设计 token 合规门：发丝线 / 浮层阴影 / 命名空间）与 `PULL_REQUEST_TEMPLATE` 的触点自检段。
- **写者静默闩锁的会话内再证明与「清理并接管」（design 02 §3.4）**：启动扫描只在「零 kept 且零 errors」时打开闩锁，且**只在启动时跑一次**——记录一旦在会话中途变陈旧，闩锁再也打不开，表现为硬杀后「本地实例起不来」（`POST /api/connections` 恒 409、启动/停止点不动、只能重启应用）。现将两种关闭原因分开：**扫描判定**类在拒绝启动前做有界再证明（单飞 + 2s 冷却；孤儿已退出的常见情形无需任何用户动作即恢复），**写入期终止失败**类（`onWriterQuiescenceUnknown`）任何扫描都无法证明、对本平面生命周期粘滞并明确提示重启；`runReaper` 增 `takeover` 模式与条目级结论（`reason`/`takeOverAvailable`），只清**本状态目录自己**的陈旧/孤儿写者，owner 仍活的另一实例永不受影响；连接页据此提供显式「清理并接管」。

### 变更

- **dsh 推进到 `0.1.5-rc.1` 一代（构建期 vendor 源 + 捆绑运行时同代）** —— 相对上一正式版，源码 pin、捆绑运行时、三个 fork 副本（`dsh-client-connection` / `dsh-client-web` / `dsh-api-gateway`）与安装脚本 / gateway 的 `dshAnchorVersion` 同处 `0.1.5-rc.1`。上游在本区间重写了客户端外壳的两代槽位模型（`details`→`rightbar` 且 scope 由 session 改为 root；中心列 `conversation`→keyed `main`；新增 `sidebar.panellist` 轴与 `usePanelInfo`/`useResource` 全局座），chamber 的 layout / sidebar / mobile / settings 自建物随之全量重放，外观与交互仍为 chamber 形态。
  - **经运行时线进入受管实例的上游可见变化**：base bundle 默认模型 `deepseek-v4-flash` → **`deepseek-flash`**（V41 Flash；catalog 3→4 条，保留 V4 Flash / V4 Pro / V4 Flash Vision Exp），该条目声明 `systemPromptUpdate: 'in-history'`（V4 系不声明、行为不变）；上游自带告诫——网关未启用该 id 前请求可能 `INVALID_REQUEST`，可在设置里改回 V4 系。
  - **版本歪斜登记**：实例侧 documentpreview 的代码预览自该代起行为依赖同代 `ui-primitives`（`CodeBlock` 的 `contentRef` 是其唯一滚动/行定位锚点），旧代 composite 服务新 instance 时该预览失去独立滚动区与行定位——登记于 STATUS 的平台词偏差条。

- **修复 N-ctx 同源壳下五处同源绝对 URL** —— 官方客户端假定自己由 dsh 源提供，但 chamber 单页多实例（N-ctx）下页面 origin 是控制面、只代理 `/api/i/<id>/*`，于是五处动作实测失效：`ui-chat` 的 `/api/file`（Markdown 本地图片坏图）、`client-file-upload` 的 `/api/session/uploadFileBinary`（**composer 附件上传 404**）、`ui-deliverables` 的 `/api/present.host|open`（交付卡「打开/定位」404）、`session-log-export` 的 `/api/session.export`（**/export 下载 404**）。修法为登记式**构建期 vendor 补丁集**（`packages/renderer/scripts/vendor-patches.mjs`，按精确上游锚点改写、vendor 文件零写入，锚点漂移即构建失败；补丁覆盖上传与导出客户端，官方 layout 部署下缺失 base path 时回落上游行为）。**已知边界**：本地与 gateway 来源经控制面注入 cookie 后可用；ssh/http dsh 目标仍无 cookie 注入（实例侧 401），属既有认证面待办。
- **chamber 自建包命名统一** —— 命名收口为「目录 == 包名非 scope 段」：6 个 client 插件包名 `@dsh-chamber/dsh-client-ui-*` → `@dsh-chamber/dsh-chamber-client-ui-*`（目录不变）；3 个宿主种子包的目录与包名 → `dsh-chamber-seed-<loader-id>`（`@dsh-chamber/dsh-chamber-seed-client-graph` / `-git-worktree` / `-archive-cleanup`；loader id、激活探针域与发布计数不变）；`dsh-client-ui-mobile`（client-kind 例外）、三个 fork 副本与基建包不动。**兼容性**：本版桌面壳按新清单名同步宿主包，而 ≤0.2.4 的就地 gateway 只认旧名——就地部署需先把 gateway 更新到本版；远端过渡把旧名 `cordis.patch.yml` 行按同 loader id 一次性改写，避免升级后 seed 因 id-bound 冲突硬失败。
- **连接恢复加固（2026-09）** —— 针对「上游连接管理只按本地/单实例设计，chamber 需面对隧道/慢链路/唤醒」的专项结论：
  - **每来源就绪期限**（新增 `dsh-client-connection/src/client/recovery-policy.ts`）：chamber 页面拿不到宿主注入的 `__DSH_CONNECTION_RECOVERY__` 页面全局，一直吃 15s 硬期限；现由 api-gateway fork 经上游支持的 `connection.start(sinks, config)` 为 ssh/http 来源传 45s 期限 / 5s 告警，本地与未知来源保持上游默认——冷 SSH 隧道或慢链路不再因握手超期被反复取消。
  - **唤醒事件旁路离线门**：页面跨挂起/恢复被冻结时可能整体错过 `online` 事件并持续误报 offline，而离线门会连 `system-resume` 一起挡掉。现 `system-resume` 旁路门（`reconnect()` 的 `immediateRetry` 跳过挂起分支，只强制一次有界尝试，真离线则快速失败重挂），`online`/可见性仍受门约束，三者共享 10s 去抖。
- **open-in 统一：单一 header 入口消费 per-source 视图模型** —— 本地来源吸收官方 client：
  - **本地来源（official 通道）**：实例自身官方宿主目录（`dsh-host-open-in-app`，随 a2 默认 web bundle 在）经每实例代理 `<basePath>/open-in-app/{apps,icon/<id>,open}` 提供全量本地应用拾取器——catalog 协议（`shared/open-in-app-protocol.ts`，与 vendor `shared.ts` 逐字锁步测试）、真实 bundle 图标（404 回退中性方框）、官方 `app.*` 标签表与按钮文案（并入单一 chamber locale NS）、选择持久化（官方 key `dsh.open-in-app.choice`，storage 不可用降级内存）、busy/error 呈现（250ms 延迟 busy、2s 错误衰减）全部吸收；桌面主进程的 VS Code 覆盖项按 §5.1「vscode 全家走 IPC 覆盖」+ r6「展示并集 + IPC 兜底」裁决：主进程该项可用时胜出（vscode 走 IPC，保留 `vscodeOpenInNewWindow`、来源代 proof 与深链 intent 推送），不可用时官方条目兜底（走实例路由）。
  - **远程 ssh 来源**：仅主进程 remote-capable 项（VS Code Remote-SSH，主进程构造 `vscode://vscode-remote` URL）；**http/未知来源**：无入口。
  - **桌面主进程瘦身（红线）**：`OpenInApp` 注册表 vscode-only；`OpenInLaunchContext` 移除 `stat`/`openPath`/`showItemInFolder`，finder provider 与 `classifyLocalPath`/`invokeOpenPath`/`normalizeOpenPathError`/`shouldRevealDirectoryInsteadOfOpen` 一并退役。本地 launch 的信任界由 trusted IPC 迁至实例官方路由（实例连接栅栏 + 官方 resolver 白名单/存在性校验），控制面仍零执行面（逐字透传 + browser-auth cookie 注入）；VS Code 深链语义、来源代 proof 与 OS 深链 `dsh-chamber://open-vscode` 入口不变。
  - 红线修订登记：design 16/20/05 + AGENTS 同步（最终设计验收由用户完成）。
- **升级工具收尾（2026-09）** —— 与 dsh 升级版本无关的三件收尾，均在当前 pin 上验证：
  - **升级前 pin 预检（新增 `scripts/dev/preflight-vendor-pin.mjs`，只读）**：对目标 tag 与当前 pin 做 diff，一次给出「三个 fork 副本按 pure/需人工重放/dropped 分类 + chamber 深引的 vendor seam 文件 + 上游包集合增删 + 新增 client 行 + 运行时是否已发布 npm」，支持 `--offline`/`--json`/`--fail-on-replay`（advisory 工具，不改工作树、不动 submodule HEAD）。把「先升 pin 才发现上游重写了外壳模型」这类坑提前成「动 pin 前先看清单」的流程第 0 步。
  - **锁文件 vendor 记录修复脚本加移除守卫（修复）**：`restore-lockfile-vendor-records.mjs` 原先无条件从 HEAD 复活被 pnpm 剪掉的 importer 记录；上游在 0.1.5 移除 workspace 成员（landlock 4 条）后，脚本会把已不存在的成员补回，frozen 安装随即以「锁文件有、链接缺」失败。现按 `vendor/harness-packages/@deepseek-ai/<name>` 链接存在性（含断链）跳过并打印清单。新增根脚本 `pnpm run test:upgrade-tools`（两个脚本测试）+ CI 步骤。
  - **聚合刷新陈旧阈值按传输分级**：sidebar 聚合的 S2 重连 watchdog 原为单一 120s 且**只覆盖 direct-http 来源**；现按来源传输取阈值——http 保留 120s（浏览器腿有控制面 30s WS ping，上游腿无应用心跳、仅约 10min OS TCP keepalive，需较紧的自愈），**ssh 新增 300s 兜底**（隧道已有三层独立探测器：代理 30s/1 miss WS ping、宿主 mux 2s/2 misses、SSH keepalive 30×3≈90s，该臂只补「应用级冻结」这一层，阈值必须显著长于 http 以免空闲健康隧道每两分钟付一次基线重放），本地/未知来源不武装（`AGGREGATE_RECONNECT_HTTP_STALE_MS`/`AGGREGATE_RECONNECT_SSH_STALE_MS` + `reconnectStalenessMsForTransport`）；unary 30s 拉取节奏不变，watchdog 始终是「拉取的补充」。新增单测 2 例（http/ssh 阈值与 local/未知跳过）。

- **设置面来源标记退役与归属判定**：nav 行的「插件」来源标记退役，回到上游形态；归属判定改按 npm scope。
- **提交信息语言（贡献规范）**：`CONTRIBUTING.md` 明确**提交信息一律英文**（subject 与 body 都是英文），历史中文提交是既有事实、不作先例；代码注释、设计文档与 PR 正文不受此限。

### 修复

- **归档清理后已删会话在侧边栏反复浮现（design 24 §12）**：purge 删除已归档
  会话内容后，官方客户端 `SessionManager.summaries` 不会刷新（宿主会话事件为
  文档化 no-op），而归档集合的收缩经官方 workspace follow 即时到达客户端，于是
  生产端推送把「收缩后的集合 + 陈旧的行」一起提交，已删会话以普通行渲染（点击报
  `session/not-found`）；30s unary 兜底拉取又把它清掉，形成「推送装回、拉取清掉」
  的闪烁。修复分四层：① 生产端**墓碑抑制**（离开权威归档集合的 id 从上报快照与
  运行时事实通道中过滤，直至官方 summaries 收敛或该 id 重新入集合）；②
  **校验式收敛链**（以方法调用官方 `ctx.sessions.refresh()`——此前的脱绑调用每次
  抛 `TypeError` 被吞掉、从未真正发出请求——resolve/reject/hung 三类结果均有界
  重试，终态用 chamber unary `session.list` 权威探针，只释放服务端仍存在的 id）；
  ③ App 侧**权威归档集记忆**（失去权威时作为收缩基线，并让降级 unary 视图继续
  过滤已归档行；`archiveSetKnown` 仍为 false，管理器保持非破坏性降级分支）；
  ④ 宿主**registry-global 孤儿清扫**（每次 purge 收尾清全集合无会话记录的成员：
  逐候选官方单 id 存在性校验 + 查询/持久化枚举并集 + 空/塌缩语料可信度门，
  只清集合成员、零新增删除语义，双重确认与 fail-closed）。
  设计与进度见 design 24 §12 与 `docs/progress/STATUS.md`。
- **移动端 Web 访问面（design 17 §18）**：四类真机反馈的复修与加固（含独立
  交叉复核轮：6 条 lane 的代码/症状/控制面/文档/复现/最优性审查，P1 已修）。
  - **tooltip 悬停残留**：官方 ui-primitives `Tooltip` 的 tap 会合成
    mouseenter 而没有配对 mouseleave（sticky hover），延迟气泡（200–500ms）
    常驻在刚用过的发送/停止键上。规则改为 `(pointer: coarse) and (hover: none)`
    门控（宽屏触控设备同样会点按；接鼠标时 hover 翻转为 hover、自动让位）且只
    针对**与可访问名重复**的气泡
    （`button[aria-label] + [role="tooltip"][data-side]`，气泡是 trigger 的紧邻
    下一兄弟且带组件自身的 `data-side` 标记）；四处信息型气泡（聊天统计行、
    代理预设卡片描述、轨迹时间轴 span、≤620px 的轨迹 kind 标签）**刻意保留**
    ——它们的 trigger 没有可访问的等价文本，隐藏等于让触控用户失去唯一可读
    来源；第五处 `role="tooltip"`（轨迹 turn-rail 预览）无 `data-side`，结构性
    排除。
  - **键盘补偿加固**：arm 以 frame 元素为单位幂等（renderer 重挂替换 AppFrame
    时重新打标，且旧 frame 的插件属性被清理）；新增**可编辑焦点**（focusin +
    focusout 打点 + composer 选区兜底）守卫；**缩放策略**改为「只服务 composer」
    ——原先的 `scale > 1.01` 一票否决会在 iOS 聚焦缩放后（抽屉 13px 搜索框是
    常见触发源）让 composer 永久留在键盘后（复核 P1），现在缩放 + 焦点在
    `[data-composer-seat]` 内照常补偿，非 composer 字段在缩放态仍否决；
    同时从源头消除聚焦缩放（抽屉内输入框补 16px 底线）；量化步进 48px → 16px
    （死区从 8–55px 收窄到 8–23px）；arm 期间归零 seat 的底部安全区 padding
    （消除刘海机 0–34px 双重间距）；focusin 纳入重同步通道。
  - **设置 sheet**：分区切换的滚动复位改为只认**分区 chip** 点击（判定抽为
    纯函数并加单测），并门控在**手机档**（769–1023px 触控平板保留官方弹窗
    几何与官方跨分区滚动行为）。
  - **连接稳定性取证（未修复）**：gateway/控制面共用的 WS splice 拆链新增一行
    有界日志（`WebSocket stream <id> closed (<cause>, <ms>ms)`），使**实例侧**
    mux 心跳判死与客户端主动重连在日志中可区分（此前只有代理自身心跳有日志，
    实例侧判死完全无痕；cause 为无括号 token，整行可解析，logger 抛异常不会
    锁死拆链）；修复动作仍待浏览器侧 close code 取证，取证结论与候选修复见
    `docs/progress/STATUS.md`。
  - 测试：移动插件 **60** 用例（0.2.4 时为 67；alpha.2 迁移重写 markup/drawer 用例后为 60——arm 决策/档位
    常量/设置 chip 判定/粗指针 tooltip 规则与声明体/抽屉 16px 底线）、
    control-plane `instance-proxy` 72 用例（+1，拆链日志契约）。

- **网关管理页的可访问性与请求边界**：确认控件改为**页内可访问对话框**（不再用夺焦的原生 confirm），待决期保持焦点封闭并修正 `aria-busy` 归属；请求边界收口——400 原因保真（不被改写成笼统码）、读面栅栏、auth 审计；`dsh plugin` 子进程的 `PATH` 上提供 gateway 自带的 pnpm，宿主无 pnpm 时插件任务不再失败。
- **Git worktree 改用上游原语**：自绘确认控件与自绘标签换成官方确认对话框与标签原语（外观/键盘/语义随上游一致）；风险确认闸门改为**一次手势生效**并加锁（原先连续确认会把同一次操作反复要求确认）。
- **桌面：打包钩子与 dev 启动**：`beforePack` 会把 `node_modules/@dsh-chamber/dsh-runtime` 从 workspace 链接换成 dist-only 实体目录（Windows junction 上 electron-builder 不跟随链接），但此前没有任何钩子还原——打包后工作区丢类型面，根 `typecheck` 与 `typecheck:gateway` 级联 TS7016、`build:preload` 失败，且 `pnpm install --frozen-lockfile` 修不回来。现 materialize/restore 拆为可测函数并在 exit/SIGINT/SIGTERM/SIGHUP 还原（SIGKILL 留下的污染由下一次打包治愈，目标已是实体目录时同样注册）；`dev` 启动不再每次重建渲染层。
- **CLI 与 dsh 运行时探针对齐真实契约**：`cli` 的运行期门与读面按真实契约修正；`dsh-runtime` 的 `commands/execute` 探针线名对齐并透出探针失败原因、UNC 路径脱敏、终止裁决点名失败探针（探针文本的保留词覆盖 legacy 方法名），`gateway` 的壳升级事务据此可判读失败原因。
- **renderer / sidebar / settings 审查轮修复**：失败呈现改走设计系统并统一外壳文案；打开意图与揭示门的接线加固（切换来源时不再露出目标壳自建的空白会话）；侧栏早开臂持续读意图并校验来源身份、工作区回声的会话归属修正；设置面归属判定改按 **npm scope**（而非枚举本仓 id），服务器设置行不再被误标「插件」，并恢复设置面板 Escape 关闭。
- **测试可移植性与 CI 形态**：`test:host-archive-cleanup` 的「大写后缀 near-miss」用例在**大小写不敏感文件系统**（macOS APFS 默认 / Windows NTFS）上本就不成立，现按运行时探测分支；两个测试专用 ESM loader 原先把 specifier 映射到裸 submodule 路径或工作区成员路径，使单测依赖**本机 vendor 安装形态**（CI 上 `zustand` 解析失败、`Cannot find package`），现将「跑真实 vendor 源码」的用例改为按契约的 store double，真实解析仍由源码锁与 `build:renderer` 把关；`purged-tracker` 的「到此为止恰好一次刷新」否定断言原先与真实 `retryMs` 计时器赛跑（CI 上 `2 !== 1`），现全部走注入时钟并把「无遗留计时器」钉进断言；另修 `test-windows` 门禁崩溃与 `host-open-in` 的 undici 类型落点。
- **移动端卡片网格口径与 ARIA 说明修正**（承接 design 17 §18 移动面）。


## [0.2.4] - 2026-09-09

### 修复

- **N-ctx 文档级主题投影（问题 E：checkbox 深浅错位）**：文档级
  `html{color-scheme}` / `body[data-ds-dark-theme]` 原先由**每个挂载中的实例**各写
  一份（官方 `ThemePresenter` 的 `dispose()` 还无条件回收），隐藏视图的 apply 会
  重绘可见视图、其 teardown 会抹掉可见视图的投影 ⇒ 浅色调色板配深色原生控件。
  现由**活动视图独占**：`chamberBridge` 新增 `setActiveSource/getActiveSource/
  onActiveSource`，App 在 `useLayoutEffect` 中发布活动视图，ui-layout fork 用
  `document-theme.ts` 按 `ctx.chamberInstanceId` 门控、teardown 永不回收、全页单例
  presenter；`styles.css` 的 `:root{color-scheme}` 兜底与浅色默认调色板对齐。
- **首屏整源降级（问题 A）**：ready 但从未挂载的来源只剩 unary 兜底视图（合成分组 +
  空归档集 ⇒ 已归档会话按普通行浮出、无真实工作区动作），而所有自愈臂都要求
  `mounted===true`。新增**基线收割**：在同一个后台预热槽里挂一次、首个权威推送即
  回收；尝试上限 2、退避 120s、截止= boot 预算 +15s、绝对放弃上限（同时按挂载时刻
  独立看管每个挂载视图；shell 对"等待上一代 boot"设绝对上限、页面 producer 注册表
  按代际栅栏，挂死 boot 既不占槽、不卡住后续重挂，也不会清空健康后继的通道）
  回收并停用挂死壳、
  收割候选独占槽位（且收割有独立预算线，不被用户保留的隐藏温壳永久挡死）、托管停机
  源不收割、用户点开即采用；最后收割的壳保留为温壳并在出现新候选时让位。
- **gateway 托管 dsh 停机不可见（问题 B）**：desktop 的 `ready` 只证明 gateway 进程
  活着，侧栏不消费 `/chamber/runtime/status` 的 `connectionState` ⇒ 停机窗口里来源
  可点而背后不可用。现由 15s 前台探针（单飞 + 10s 超时）投影：终态停机三态换成该源
  `phase` 并置 `connected=false`（判定走独立字段 `managedRuntimeDown`，只在该源传输
  可用且探针报终态停机时为 true——不从合并后的 `phase` 反推，两套词表都含 `error`），
  来源头下方就地给出一行原因与恢复提示（前往 设置 → 连接 启动该实例）且该形态下
  头部不再是可激活入口，设置面板同状态
  改用"网关可达但托管 dsh 未运行"、瞬态用"托管 dsh 正在启动"文案；`starting/
  restarting` 同样投影、禁用动作并给出 `source.managedStarting` 说明行（dsh 尚未
  服务），`degraded` 保持传输态（按既有语义呈现为未连接），探针缺失一律 fail open。
- **Git 来源分支无法以主 checkout 为 base（问题 C）**：host 一直下发完整分支表，排除
  发生在客户端选择器（把主 checkout 当前分支过滤掉、只作占位符），单分支仓库候选
  必空、localStorage 记忆值永久遮蔽 main。候选改为纯函数 `sourceBranchChoices()`
  （host 表原样放行、unborn 行跳过），并加源码级回归钉子。
- **`test:gateway` 会停掉宿主 gateway 服务**：安装器 D2 跨形态清理直接调用裸
  `systemctl stop/disable dsh-chamber-gateway.service`（写死单元名），而相关测试只
  mock 了 `systemctl_for_mode` ⇒ 真实 systemctl 逃逸。全部 harness 改经
  `harnessSource()` 注入宿主安全桩（仅当存在真实 systemctl 时生效），并加源码级
  不变量测试；实机验证：修复前垫片记录 3 次真实调用，修复后 0 次（Linux 腿 45/45；macOS 腿 43 通过 + 2 条 Linux 专用跳过）。
- 降级列表诚实标注（`source.baselinePending`）、设置面板托管停机文案、前台恢复补偿
  先刷托管探针、活动来源发布改用 `useLayoutEffect`（消除切换一帧旧主题）等一并收口。

## [0.2.3] - 2026-09-07

### 修复

- **断连保留已推送聚合 + 降级视图限流自愈（design 05 §2.3 语义修订，
  aggregate-refresh.ts）** —— 远程断连后重连时 sidebar 不再出现已归档会话
  回流（点击落入官方空会话页）的根因修复：断连分支对已推送过的挂载来源
  保留其 ok 聚合（行渲染以 connected 为门，断连不显示），ready-edge 拉取
  走 sessions-only merge，归档集/工作区不丢失（`shouldRetainPushedAggregate`）；
  兜底看门狗新增限流自愈臂——卡在降级视图（合成行）的挂载来源触发 ctx
  连接重连、重放 follow baseline 使 producer 重发带归档集的真实基线
  （`shouldRebaselineFallbackView`/`isFallbackDerivedView`，沿用 60s
  backoff；合并入 watchdog 回调后自动继承 2026 性能整改的可见性门控与
  恢复补偿）。纯函数抽入 aggregate-refresh.ts，单测 +7。
- **长 RPC 代理豁免：45s 空闲窗不再误杀慢 unary 宿主业务（design 03 §3.4）**
  —— 手动 `/compact`（LLM 摘要重放全部可压缩历史）与 design 24 的
  `archiveCleanup/purge` 等无上游时长上限的 POST 请求改走 30 分钟保险丝窗
  （非 SLA）：实测 ~62.7 万 token 会话在 45 001 ms 被切断并伪造客户端断连
  的根因消除；其余路径 45s 语义不变；豁免命中/触发计数入双 owner 诊断
  （list-liveness 探针），决策表与回归测试入列。
- **gateway F4 启动门补齐 fresh shell-version mismatch 武装（design 18
  §3.5；0.2.2 发布版缺口）** —— gateway 侧原只在 activation journal 缺失时
  武装，带「已应用 override + 稳态 applied-monitoring journal」的健康升级
  （0.2.1→0.2.2 实机复现）永不武装、首个 startLocal 崩溃 → 安装器自动回滚
  旧网关；现与 desktop 对齐：fresh mismatch 在 journal 为 missing /
  applied-monitoring / intent 时武装，仅 live 事务 phase（prepared/switched/
  restoring…）不武装（旧壳在途事务保持 journal-mismatch 阻塞语义），回归
  测试 ×3。
- **plugin sync/install QA 收口（design 21 §6.2/§6.3/§6.6 ⑱–㉒）** —— 同步 400 原因
  透传（旧网关不认识新宿主域不再裸 400，拒绝文案给升级指引；桌面把网关
  原因并入失败串）；materialize 202 后桌面侧 settle/受控重启对账（op 终态
  轮询 → POST 受控重启 → 就绪轮询，IPC outcome `{executed,restarted}`，
  preload/global.d.ts/ipc-surface-mirror golden 三处镜像同步——上传后列表
  即时更新、插件随流程生效；settle/status JSON 请求用纯 auth 头的坑位单测
  锁定）；op 终态暂存归档**保留**（profile manifest 的 `file:` 引用不得
  悬挂）+ boot 期孤儿清扫（保留集 = manifest 引用 ∪ deferred 意图 ∪ live
  op，有界）；第三方行生效状态列（Loader 快照按 moduleName 匹配、类别
  诚实——仅 bundle-layer 行示「重启后生效」）+ 安装结果文案诚实
  （materializeLive/restartNeededHint/deferredOfflineNote，本地 add 不再
  谎报「已应用」；ssh doApply 后自动重载已安装列表）。

### 变更

- **N-ctx 视图保留/回收 + 可见性门控（design 05 §4 注记/performance-baseline
  §10；性能第二阶段代码面 A/C/D）** —— 早期「booted 壳无限常驻（视图生命周期
  = 注册表条目生命周期）」收窄为 chamber 保留策略：local 恒留，隐藏壳最多
  保留 1 个（`RETAINED_HIDDEN_VIEWS`），超限回收「已 settle + 连续隐藏
  ≥60s」的最久者（`retention.ts` 纯函数 + App.tsx 回收原语，与注册表删除同
  原语——dispose shell + 卸载 UI 壳；实例进程/隧道/后台任务不受影响，重开走
  冷 boot + entry 重放）；预热 3→1/仅前台；hidden 期停 30s watchdog、S2
  reconnect、3s 重试等后台拉取链（可见性门控 + 恢复补偿）。取舍登记：被回收
  壳内运行中任务的完成蓝点/通知边沿暂停至该源重开（runtime-facts 通道撤回），
  侧栏聚合落既有 30s unary 兜底（05 §2.3）。
- **侧栏会话行窗口化 + publish 收口加固（design 05 §2.3；性能第二阶段 B）**
  —— 每工作区首屏渲染上限 200 行 + 「还有 N 个会话」展开条
  （`session-row-window.ts` 纯函数 + ServerSection 接线，locale zh/en 成对）；
  aggregate publish 入口补引用相等防御（订阅侧去重之外的发布收口）。新增
  `scripts/perf/measure-ui.mjs` 稳态基线尺子（schema `measure-ui/v1`：
  DOM 节点分壳/堆/空闲长任务/合成输入帧间隔）。

- **归档管理器按工作区分组、可折叠（design 24 §6）** —— 移除独立
  「删除全部」：整集清理必须先显式全选再确认带计数的「删除选中」，purge
  永远携带明确 id 列表（降级/pending 视图无任何销毁动作）；列表按工作区
  分组（权威成员关系 → canonical cwd 兜底 → 未分组桶），组头复用导航折叠
  chrome + workspace accent + 三态组复选框，折叠为对话框本地视图态。
- **归档管理器整体匹配轮（design 24 §6，dsh/仓库惯例对齐）** ——
  危险确认改**对话框内两段式**（武装冻结列表输入 + 风险条：计数不可恢复
  文案/取消/确认删除；Esc 只解除武装绝不关框——capture 相位仲裁官方 Modal
  的 bubble Escape；取消/Esc 焦点回武装源控件）替代 OS window.confirm 与
  嵌套 Modal 方案（官方 Modal 无层级，叠层一次 Esc 双关）；session 行
  session/workspace 树形嵌套容器化（`.archiveManagerGroupRows`，标题列与组
  标题精确同列）；行删除钮并入模块 `.actionIcon` 语言（20px 纯色 hover +
  error ink 修饰）、hover/焦点环/小字号族共享规则表收口；四方只读分面评审
  （正确性/完整性/最优性/a11y）修复落地（焦点 rAF 回退、aria-checked=mixed
  全选行、role=alert 文本化等），偏差与待目检项登记 §13（第 17 条）。

## [0.2.2] - 2026-09-05

### 新增

- **侧栏会话待办区（设计 06 §8）** —— 注意力会话（待交互 approval / plan-review /
  question ∪ 完成未读）以固定条带钉在会话列表上方：纯投影派生（不读宿主
  事实、对 chamberBridge 只读），点击权威打开、移除即「已读」解除的投影
  结果（非乐观、与会话行可见性解耦）；条带仅在有内容时占用空间，超过 3 条
  收进「还有 N 项」展开。配套 chamber 全局 `sessionTodo` 设置块（主开关 +
  三类事件门，默认全开，与桌面设置默认镜像）；行尾条带标记与会话行右缘对齐
  （2026-09 复审）。实现：`packages/dsh-chamber-client-ui-sidebar`（
  SessionTodoArea 等）与 settings-bridge 设置项；design 06 §8.2/§8.5 注释同步。
- **open-in：VS Code 默认新窗口策略（设计 15/16/20）** —— 核查确认
  `vscode://` 拉起默认复用最近窗口（VS Code 1.135 主进程 bundle 逐级核实）
  后，新增 chamber 设置 `vscodeOpenInNewWindow`（默认开）：开 → 本地/远程
  URL 统一追加 `?windowId=_blank` 强制新窗口（已开窗口仍聚焦、不重复开），
  侧栏按钮与 OS 深链同管线；设置行收紧为标题式开关并保留可选卡片提示。
- **chamber 探针与随会话数据量彻底解耦（design 02 §3.2/§3.5、design 18
  §3.4，2026-12 定稿并实施）** —— 身份/健康/就绪/激活探针统一到固定小体积
  契约：`session/canOpenWorkspacePath`（零参 boolean Typert Remote，纯平台
  检测、不读会话数据、不激活 Agent、无 IO）入列激活探针集（现 6 项），
  `data.sessions` 探针与 `session/list` 退出激活契约、`describeCapabilities`
  /能力缓存删除——会话/归档列表膨胀不再影响实例健康语义；探针响应上限
  64 KiB（per-call），HTTP 404 自动回退 legacy `session/list`（1 MiB 上限，
  **回退成功才**按连续 legacy 期节流 warn），其余失败如实报错不回退；
  settings/describe 探针上限放宽至 16 MiB（与配置上限对齐，gateway 两处
  call seam 同步转发）；desktop SSH attach 底线随之上移至 ≥ 0.1.2-rc.1，
  旧版 dsh 由签名路径给出确定性 terminal「check or upgrade」；提交态
  dsh-runtime dist 重建并补跨包常量锁步护栏（探针集/settings cap
  deepEqual + 激活集 ↔ 控制面常量断言）。
- **性能治理批次（2026-09 整改 P0–P2 完成；台账与基线见
  docs/progress/performance-baseline.md）** —— 渲染器首屏骨架几何改为全屏
  同底色 veil（骨架不再猜测侧栏持久化宽度，settle 不再挪动主边），视图
  过渡改键控单槽合并（同键最新意图胜出、跨键先入先出）；dsh-runtime 磁盘
  证据改异步单遍核算（`runtimeDiskSummaryAsync`）+ 合并刷新原语
  （`createCoalescedRefresher`：单飞、progress 相位复用最近投影、终态相位
  现场重走），desktop 与 gateway 两 owner 共用同一原语——合成 42.5 万项
  磁盘账目下不再有整树同步遍历冻结主进程；侧栏 updated-mode 置顶顺序写回
  250ms 防抖、等值写不落盘不通知；新增 CDP 测量工具箱与基线快照
  （scripts/perf：boot/switch/eval/disk-walk）。

### 变更

- **移动端触控适配轮（gateway 移动插件，design 17 §18.4/§18.6）** ——
  会话头三轴适配（汉堡 gutter、crumbs 换行不裁切、Session 日志导出按钮
  手机档图标化）；抽屉切换 iOS 合成 click 自愈（120ms+150ms 双向判定、
  per-pointerId、尊重 pointercancel）；导航后不弹键盘（IME layer-1 内
  pointerdown 才算输入意图）；设置页手机档整页堆叠（nav 横条 chips、
  Close 固定、grid 降级、16px 聚焦底线）。
- **连接插件管理对话框打磨（settings/connections）** —— 插件管理对话框
  8 项重构：三类列表（chamber/本地/远端）表头常驻、列严格对齐（chamber
  单共享 grid、列表行 subgrid 滚动体），行尾按钮 icon+文字可见化并补
  「操作」列头；安装/导入/搜索 busy 拆分并纳入互斥矩阵（`pluginsAddInstalling`
  /`pluginsImporting` 等键），移除确认链动词统一（复数风险文案）；本地
  列表补保留域过滤、`file:` 掩码 chip 化；spec 输入与安装/从文件夹导入
  同排、统一 28px 控件高；a11y 补齐（useId 关联、aria-label/aria-pressed/
  aria-busy、role=status、焦点 ring）；gateway/http 读失败横幅、reload
  保旧帧与 in-flight 禁用、恢复面置顶；术语分层（删除=连接域、插件域=
  移除/卸载）写入 locale 注释约定；chamber 表空态/零命中文案补齐。连接
  表单 kind/transport 下拉铺满列宽、chevron 保持在框内（与运行时 select
  同节奏），禁用时与本体同步淡化。
- **dsh-runtime 设置页「检查更新」行为统一（本地 × gateway）** ——
  gateway：「检查更新」忙碌态仅用户点击点亮（checkingVersions +
  checkIntent 同步围栏 + versionsController identity 围栏，settle 前保持
  busy），后台拉取静默；版本拉取加 30s 传输级兜底（超时回显中性文案）；
  检查在途冻结变更控件与重启、镜像本地动作集清空语义并显示检查中徽标；
  检查按钮按本地口径逐相位禁用（常驻显示而非隐藏）；PUT registry 成功后
  以服务端回显立即更新只读行。本地：检查按钮常驻显示、逐相位禁用而非
  隐藏，补同帧双击围栏（testInFlight），restarting 计入禁用。登记偏差：
  gateway 检查失败不进机器 error 相位（读取失败不改运行状态）。

### 修复

- **长 RPC 代理豁免修复 45s 误杀（design 03 §3.4）** —— chamber 反代的 45s
  上游空闲窗会把经 unary `POST /api/commands/execute` 执行的上游长业务
  （手动 `/compact` = LLM 摘要重放全部可压缩历史；实测 ~62.7 万 token 会话在
  45 001 ms 被切断、宿主压缩被取消、会话无变化）误报为
  `transport failure for /api/commands/execute: HTTP 504` 并伪造一次从未发生
  的客户端断连；现对 POST 且精确命中 `LONG_RPC_PATHS` 的请求（
  commands/execute 与设计 24 的 archiveCleanup/purge）改用 30 分钟保险丝窗
  （非 SLA），其余路径 45s 语义不变；豁免命中/保险丝触发计数入诊断，决策表
  与回归测试入列（instance-proxy.test.ts）。
- **Dock/任务栏未读徽标子代理误报（design 19 §3.5/§3.7 增量）** ——
  父回合结束但后台子代理仍存活（runningSubagents > 0）的武装蓝点不再计入
  徽标（与窗口内运行环压制/通知抑制同规），子代理全部结束后蓝点自动浮现；
  无压制信息时照旧计入；badge 抑制事实类型随行镜像真实报告行修复。
- **Git 删除阻断提示可行动化（design 08）** —— 不可删除 tooltips 按行状态
  分流：registered missing → 侧栏孤儿徽标 + `git worktree repair`；
  present-but-broken / 未注册 missing → repair/prune；locked →
  `git worktree unlock`；未注册行按因分发。
- **侧边栏 Git 仓库组折叠与行尾 rest 态清理（design 08 §3.3，2026-09
  用户决策）** —— 折叠 git main workspace 即整体隐藏其派生 worktree 行
  （纯展示派生、不写派生行折叠偏好；`hiddenByMainWorkspaceFold` 谓词带主行
  存在性守卫——主行注册消失时陈旧折叠偏好绝不锁死派生行）；折叠态拖放
  after 锚点跳过隐藏行锚到下一可见行（视图与提交一致）；git occupant 动作、
  会话计数与折叠字形交换改 pointer-safe 揭示（hover / kebab / 键盘焦点，
  修 Chromium 点击焦点残留导致折叠行 rest 态常驻动作图标与计数列跳动）；
  计数徽标右对齐共享右缘。
- **跨五合并复审加固（mobile/desktop/sidebar，2026-09）** —— 抽屉自愈
  双向判定与输入意图收紧、desktop IPC 面镜像 L3 自动护栏（chamber-settings
  权威 store）、VS Code 开关文案与管线说明同步、ssh 无 systemd 服务时移除
  确认保留插件名、badge 测试钉 runningSubagents:0 语义修正、todo-attention
  直连无运行时用例等复审修复随行落地。

## [0.2.1] - 2026-09-04

### 新增

- **Linux 桌面首版支持（设计 22）** —— AppImage（x64）发行形态（electron-builder linux target / desktop.entry / executableName）、可写 `$APPIMAGE` 形态门的 Linux 自动更新（dev / 解包 / deb 形态保持历史 inert 文案与设置按钮门，零 UX 回退）、每次打包态启动重写的用户级协议 `.desktop` 与 XDG 规范自启（尊重 XDG_CONFIG_HOME、补 Icon/StartupWMClass）、node 兜底平台分表 + X_OK 校验、目录 fsync EINVAL/ENOTSUP 平台无关容错（NFS/FUSE 家庭目录）、resolvePnpmBinDir 增补 Linux 安装根、release.yml `build-linux` 腿（ubuntu-22.04 基线）与发布策略测试 4 腿。契约与剩余实机门禁见 `docs/design/22-linux-desktop.md`。
- **Windows 首版支持推进（设计 23）** —— M0–M6 代码落地：CI `test-windows` 契约腿与 win32 生命周期探针（PowerShell CIM 身份 / netstat 端口 / taskkill 树终止；reaper 与 spawn-dsh 平台自适应接线）、`win-acl.ts` 启动路径 ACL 收紧、NSIS 卸载清理、win32 登录自启与深链打包态注册、open-in 本地盘符路径、SSH 密码门引导；dsh-runtime 新增 `windows-process.ts`（supervisor 树终止）/ `rename-retry.ts`（Windows 重命名重试），快照发布/恢复/stash 全改走重试路径。运行时管理在 Windows 默认只读投影（`DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1` 为开发/验证门）；真实 Windows runner 首跑与实机矩阵仍为外部门禁。
- **Gateway 与 SSH 插件管理统一（设计 21）** —— gateway 新增 `/chamber/plugins` install/remove/materialize/tasks 写面 + journal/队列与 `/chamber/plugins/installed` 读面、tgz 扫描 + 插件 spec 校验；桌面侧 plugin-tarball 构建/同步与 SSH 后端同模型（apply-rows/journal）；managed profile 写租约与运行时事务互斥，新增 `/chamber/runtime/start` 原语（停机/错误/restart-exhausted 恢复）。契约见 `docs/design/21-gateway-plugin-parity.md`。
- **dsh 运行时设置面统一（本地 × gateway 同构）** —— 彩色状态徽标词表、快照/磁盘并入「当前状态」组、registry 只读行 + 编辑态统一、常驻「清理已安装版本」；gateway 补齐 `cleanup-version` / `restore-pre-rollback` / `recover-metadata` 路由；FATAL 元数据损坏改 blocked-alive（gateway 存活、托管 dsh 停机、管理面可轮询）；status 增 metadata 健康投影；desktop env/只读平台放行「重启 dsh」；设置面细节打磨与插件对话框统一（2026-12）。
- **「内建版本」行引导（2026-12 用户决策）** —— 桌面与 gateway 设置中选中与内建（随应用/部署锚）同版本的行且该版本尚未装成受管树时，主按钮引导「恢复内建」（清除用户选择回到内建副本/锚，零下载）；「仍下载并安装为受管版本」为显式次要动作；已缓存（曾装树）时保持普通切换。
- **Dock/任务栏未读徽标（设计 19 §3.7）** —— 应用图标红数字气泡：renderer 未读计数投影经 `dsh-chamber:badge-count` IPC 送达主进程，主进程白名单校验 + 设置裁决（`notifications.badgeEnabled`，默认开，关闭强制清零）与平台门（darwin Dock 红气泡；Windows 任务栏 overlay 门控未接线，设计 23 排期）。
- **gateway update 默认同步升级 dsh 内建锚（设计 17/18 一致性）** —— `install-gateway.sh update` 新增 `--dsh-upgrade/--no-dsh-upgrade`（**默认升级**）：目标 gateway 资产携带发行线配套 dsh 基线（`dshAnchorVersion`，release-preflight 硬断言与脚本常量、release.yml env 三者同步；旧资产无该字段时回退运行脚本常量），热切换后把 `dsh-anchor` **staging + 原子交换**升级到该基线——升级后首次启动的 F4 壳失效回落即落到新基线，托管 dsh 与 gateway 保持一致；`--no-dsh-upgrade` 保持升级前的 dsh 版本（pin）。失败（npm 安装/验证/交换）随 update 统一回滚（旧锚退避换回）；INT/TERM 中断尽力复原锚，崩溃残余 `.anchor.*` 由下次 acquire_lock 清理；安装时选择的 npm 镜像自本版起持久化进 gateway.conf（NPM_REGISTRY），update 锚同步沿用同一源。

### 变更

- **desktop 打包配置** —— `build.linux` 目标从 `dir` 改为 `AppImage`；新增 `dist:desktop:linux` / `dist:linux` 脚本。
- **updater.ts Linux 门控形态化** —— `platform==='linux'` 无条件硬门改为「可写 AppImage 运行形态」门（`probeLinuxAppImage`）；非 AppImage 形态的 blocked 文案与 settings-bridge 按钮门保持不变。
- **Electron 二进制惰性安装（每机器共享 dist）** —— 根 postinstall 默认跳过 Electron 下载，`DSH_CHAMBER_ELECTRON=1` 或 dev 首启按需物化到平台缓存共享 dist（多 worktree 并行开发共用一份）；dev 控制面端口自 17520 自动退避到首个空闲端口（`DSH_CHAMBER_CP_PORT` 可固定覆盖）。
- **dsh 基线升级至 0.1.2-rc.1** —— 源码线（submodule pin）与捆绑运行时（`@deepseek-ai/dsh`）双线同步至 dsh-v0.1.2-rc.1（a66e4702）；上游 rc.1 相对 alpha.5 **零代码改动**——全仓 252 个 `package.json` 仅版本行 bump（alpha.5 → rc.1，diff 复核），客户端/wire/存储/DOM 面无任何增量——in-repo fork 副本（connection/web/api-gateway）零源码重放、仅版本标记同步，DOM 锚点与 wire 契约沿用 alpha.5 审计基线。
- **gateway 运行时客户端核心重构（design 21 §5.2）** —— 纯核心（解析/动作门/错误分类/轮询）迁入 sidebar 共享面，settings-bridge 仅保留 view 映射；consumer ambient 镜像同步并由 lockstep 测试锁定。

### 修复

- **渲染器 extra-bundle 跨重启加载恢复** —— 实例重启窗口内到达的 extra-bundle 加载不再被丢弃：重启完成后正确续载，避免该行插件静默缺失。
- **gateway 升级中断后崩溃循环自愈（设计 18 F4）** —— F4 壳升级回落事务被中断且其 intent journal 丢失（如安装器健康检查超时回滚到旧壳、旧壳消费了新壳的 journal）会把 durable 状态卡在「current 指针仍指向旧树 + override 已失效 + 无 journal」：启动事务报干净、首个 startLocal 的 resolveWorkspace 却抛 `gateway runtime current pointer has no matching active override`，进程硬退 + systemd 崩溃循环且无任何 HTTP 恢复面。现在网关/桌面启动 F4 门在指针存在 + override 已失效 + 无可续 journal 时自动重新武装 shell-invalidation 事务（快照 + 探针门控的内建回落），自我修复而不是每启崩溃；陈旧失败标记（lastOutcome=snapshot-failed/swapAttempted）按 fresh-transaction-supersedes 清除——journal 在途 + 快照持续失败的 F4 也会每启重试、病因消除即自愈。

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
