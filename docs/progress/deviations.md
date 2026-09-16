# 行为偏差与取舍登记（deviations & trade-offs）

> **文件定位**：本文件是**合并检索索引 + 双 flavor 专项登记**。`docs/progress/STATUS.md` 继续承担
> 「唯一进度记录」职责（只留未完成 / 未决 / 仍成立的取舍，并在落地时删除）；本文件把 **STATUS、
> design 文档、CHANGELOG、审计台账与历史提交里记载过的偏差与取舍**收敛成一张可检索的登记表，
> 并对 **Electron ↔ macOS Swift 双 flavor** 的偏差做专项（这是当前最大的偏差来源）。
> 本文件**不是**进度记录、不是验证报告：不记完成态、不记测试计数、不记提交哈希的流水账。

## 0. 更新纪律

1. 每条登记必须有六要素：**现象 → 取舍/偏差 → 原因 → 证据（路径 / design 节 / 设计裁决） → 状态 → 退役判据**。
2. 状态取值：`open`（仍待处理）/ `accepted`（有意保留，需有人能解释为什么）/ `retired`（已不成立，保留一行说明退役原因）。
3. 新的偏差**先**进 STATUS.md（若仍属未完成/未决），同时在本文件补一行索引；已落地的偏差从 STATUS 删除、在本文件标 `retired`。
4. 禁止把「实现方式不同但功能等价」写成缺陷——本文件专门区分这两类（见 §2）。

## 1. Electron ↔ Swift 双 flavor：功能偏差（当前仍成立）

> 判据：**功能一致即可，实现方式可以不同**。下表的「状态」= 是否仍需裁决；已消解项见
> `docs/progress/todo/electron-swift-parity-audit.md`（§2 汇总表 + §6 裁决清单）。

| # | 现象（用户可感） | 取舍 / 推荐 | 状态 |
|---|---|---|---|
| S-01 | 原生壳缺整条应用内更新安装链（下载 → 已退出安装 → 重启并安装） | **已按 Sparkle 2 落地代码**（`AppUpdater` + 菜单 + Info.plist 注入 + framework 嵌入 + appcast 签名步 + sidecar/页面转发）；**外部门禁未闭**：EdDSA 密钥（`SPARKLE_PUBLIC_ED_KEY`/`SPARKLE_PRIVATE_KEY`）与 CI 编译验证（本机沙箱取不到 SwiftPM 二进制制品） | 代码就绪且本机验证通过（swift test 177/177、打包嵌入 ⑯ 通过） / 外部门禁 open（EdDSA secrets + 实机安装验收） |
| S-02 | 原生壳渲染器卡死无自愈（Electron 15s 重载） | 推荐页面心搏探测（限 3 次、仅无输入时重载） | open（需裁决） |
| S-03 | 非法显式端口 / dev 端口耗尽：Electron 降级，Swift 致命退出 | 推荐对齐降级 + loud 提示 | open（需裁决） |
| S-04 | 双壳 `dsh-chamber://` 归属可能被 Electron 抢占 | 推荐 Swift 增注册 `dsh-chamber-native://`（保留原 scheme 兼容） | open（需裁决） |
| S-05 | 原生壳无本地 open 执行面（Finder/launchApp 一类动作） | 推荐登记为设计边界（改 design 25 E11/E12），open-in 走页面/window.open | open（需裁决） |
| S-06 | page world 可伪造 `__dshChamberResolve/__dshChamberEmit`（无 contextBridge 隔离） | 推荐注入随机 token 校验（低成本可测） | open（需裁决） |
| S-07 | 网页权限：媒体采集已显式拒绝；剪贴板读 / 网页 Notification 无等价面 | 推荐登记并实机复核；必要时只做权限「查询面」shim | open（需裁决） |
| S-08 | 取消退出后的窗口恢复时序与 Electron 不同 | 推荐对齐（确保可见 + 激活） | open（需裁决） |
| S-09 | 通知音效：Swift 用具名系统音效（缺省 Glass），非标准名由系统回落 | 接受（功能等价；不做音效名映射表） | accepted |
| S-10 | 隐藏窗口的 WebKit 定时器节流（无 `backgroundThrottling:false` 等价物） | 接受，实机门禁验证后台 SSH 流不受影响 | accepted |
| S-11 | 右键上下文菜单为平台默认（未覆写） | 接受（Electron 亦为系统默认 + 应用菜单） | accepted |
| S-12 | 崩溃诊断无 Crashpad（Electron 有） | 接受（不引入新依赖）；如要上报需单独立项 | accepted |
| S-13 | 目录锁获取晚于窗口构建（二次启动会有极短空窗闪现） | 接受（用户体验问题已由「激活已有实例 + 转发深链」修好）；重排主装配顺序收益过低 | accepted（2026-12 复核） |
| S-14 | sidecar 业务错误的 `code` 字段在 Swift 链路上只剩文案（A 桥围栏码已带 `.code`） | 部分消解：A 桥围栏码已等价；edge 回执要真 code 需先把契约异步化 | open（低优先） |
| S-15 | 就绪门（`ipc_not_ready`）先于 origin 判定 | 有意排序：`expectedOrigin == nil` 时没有可比较的可信 origin，且该分支不授予任何能力 | accepted（已注释 + 台账） |
| S-16 | `--skip-web-dist` 之外的装配一律要求 `dist/web/index.html`（打包 fail-closed） | 有意：白屏 .app 比构建失败更贵；release 腿本就先 build:renderer | accepted（门禁） |

## 2. 结构性 / 实现方式差异（**有意**，非缺陷）

| # | 维度 | Electron flavor | Swift flavor | 为什么可以不同 |
|---|---|---|---|---|
| T-01 | 页面桥 | preload + `contextBridge`（隔离 world） | documentStart 注入 shim + `window.webkit.messageHandlers` | 两侧契约（通道/形状/错误码）一致即可；隔离能力差异另登记为 S-06 |
| T-02 | IPC 编码 | 结构化克隆 | JSON（envelope ≤4MiB） | 协议可见形状相同；超限行为已在台账登记 |
| T-03 | 宿主进程 | Electron main + electron-updater | Swift 壳 + Node sidecar（stdio NDJSON JSON-RPC） | 宿主语言不同；sidecar 复用 core 注册体（60 invoke 同一实现） |
| T-04 | 更新实现 | electron-updater（Squirrel/NSIS/AppImage） | headless 控制器（GitHub releases 查询）+ 手动安装 | 见 S-01；标准做法是 Sparkle 2 |
| T-05 | 签名 | release.yml 走 Developer ID + 公证（需凭据） | dry-run 形态为 ad-hoc 签名 | 凭据门禁是外部依赖，非代码差异 |
| T-06 | 目录锁 | Darwin `O_EXLOCK|O_NONBLOCK` | `flock(LOCK_EX|LOCK_NB)`（同一 `.dsh-chamber.lock`） | 锁文件仅诊断；内核锁本身是唯一裁决者（design 25 §6.3） |
| T-07 | 打包布局 | electron-builder（asar/extraResources） | `.app` + `Contents/Resources/sidecar`（内建 node + dist/web） | 锁步由 packaging-manifest + build-swift-app 断言 |

## 3. 已在 STATUS / design / CHANGELOG 中记载的偏差与取舍（历史索引）

> 下面是 `docs/progress/STATUS.md` §范围决策与必要取舍 的**全量标题索引**（含 2026-09 起的历史登记）。
> 每条的原因、失效判据与证据以 STATUS 原文为准——这里只做「一处可检索」的收敛，不复制正文。

| # | 已登记的偏差 / 取舍（标题） | 原文位置 | 状态 |
|---|---|---|---|
| H-01 | 重启即重载：用户发起的插件刷新入口已全部接线（2026-12；唯一有意例外 = 「重启网关服务」） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-02 | 降级事实的覆盖边界（2026-12，做完全部座位后仍成立的取舍） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-03 | 侧栏行悬停卡片由本仓自持（2026-09-13 登记，偏差；上游修掉竞态即可退役） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-04 | 连接页手写 tooltip 未走 vendor `Tooltip`（2026-09-13 登记，偏差；a11y 仍 open） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-05 | sidebar / layout 的 `bundle` 在 chamber 树内不可运行（2026-12 登记，偏差） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-06 | git 客户端与宿主的错误码重叠是「有意的显式例外」（design 08，2026-12 登记） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-07 | 移出项（P3 硬纪律） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-08 | `--no-auth` 是醒目的可信网络有界例外 | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-09 | Gateway state 根目录自动收紧 | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-10 | safeStorage 的诚实回退 | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-11 | Windows 发布身份让步 | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-12 | macOS 平台范围让步（不做 + 推迟） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-13 | N-ctx 单文档信任域 | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-14 | N-ctx 壳常驻语义收窄（2026 性能整改偏差，已登记代码注释与 design 05 §4） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-15 | 远端宿主上的空白会话残留（2026-12 登记，design 05 §2.2.1） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-16 | 未挂载来源的工作区集合只有"回声 + 挂载 push"（2026-12 登记，design 05 §2.2.1） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-17 | 不做（v1） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-18 | 保留项（2026-09 裁决，仍有效） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-19 | 设置壳偏差 | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-20 | 2026-09-11 上游对齐轮引入的有意偏差（仍成立；各带理由与判据） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-21 | 默认排序 `manual`（06 §3.1） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-22 | 菜单密度 = chamber 档，不跟随官方（2026-09 裁决） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-23 | Electron 二进制惰性安装 | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-24 | 内建版本行引导（2026-12 决策，方案 2） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-25 | dsh 运行时设置面（2026-12 统一）残余偏差（有意保留） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-26 | apply-now 门形态取舍 | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-27 | 探针契约残余（design 18 §3.4 定稿后） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-28 | 0.1.2 线已知降级（仍有效） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-29 | 代理 300MiB 响应体上限 ⇒ 大会话导出为已知降级（2026-12 登记） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-30 | 插件页不检测「远端真的带了 `localOnly` 包」这一偏差（2026-12，偏差：接受不检测） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-31 | 轨道来源点多于可视高度时被裁掉、无滚动入口（2026-09-13 审计登记，未修） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-32 | footer 动作行 `gap: 4px` 是 chamber 对官方复制块的增量（2026-09-13 审计登记，偏差） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-33 | 根治该漏事件类的补丁未落地（2026-09-14 登记，未做） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-34 | 导轨开关没有稳定 DOM 锚点、也不带 `aria-expanded`（2026-09-15 登记，取舍） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-35 | 悬停几何/墨色没有真指针验收腿（2026-09-14 登记，未做） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-36 | 不做 git 钩子（2026-12 决定） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-37 | 推迟：工程门禁的 P2 项（2026-12 登记） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |
| H-38 | 上游纯镜像 README 的失效链接被链接门显式跳过（2026-12 登记） | STATUS.md §范围决策与必要取舍 | accepted / 以原文失效判据为准 |

## 4. 社区 Swift 原生化仓库对照（2026-12 检索 GitHub）

> 检索方式：GitHub 搜索 API（`deepseek-harness language:Swift`、`dsh macos language:Swift`、
> `deepseek dsh native macos` 等）+ 各仓库 raw 源码。结论按「能不能被**双 flavor 共存 + 功能对齐**这个目标吸收」分类。
> 注意：这些都是**独立原生壳**（只包官方 Web UI，不承担 Electron 契约对齐），因此它们的大多数取舍对我们只有参考价值。

### 4.1 仓库清点

| 仓库 | 形态 | 规模/热度 | 关键做法 |
|---|---|---|---|
| [summer-521/deepseek-harness-swift](https://github.com/summer-521/deepseek-harness-swift) | AppKit+SwiftUI+WKWebView，含设置中心 / 版本管理 / 插件管理 / 通知 | ★3，76 个 Swift 文件 | **Sparkle 2 更新**；`#if DEBUG` 开发者工具；`flock` 实例锁（锁文件仅诊断）；`updateValidationContext(nil)` 就绪前禁用桥；校验按 launch/进程代际 |
| [SteveTanSaMa/DSH-Studio](https://github.com/SteveTanSaMa/DSH-Studio) | Xcode 工程式原生壳，管理本地 Harness Runtime（首启初始化） | ★1，约 21MB | 运行时生命周期 + loopback-only 访问 + 运行时版本管理 |
| [DanielW203/native-harness](https://github.com/DanielW203/native-harness) | SwiftUI 外壳，自带运行时供给与插件市场 | ★1 | **自发供给运行时**（npm registry 拉 `@deepseek-ai/dsh` + 缺 Node 时装私有 Node）；**安全启动/恢复模式**（先摘插件 → 再摘 home → 恢复窗口可回滚上次健康启动）；微信 IM 通道与远控 |
| [wheam/deepseek-harness-mac-app](https://github.com/wheam/deepseek-harness-mac-app) | 零外部依赖的 Swift+AppKit+WKWebView | ★5 | **复用已在跑的 `dsh web`（3080），退出时绝不杀它**；只在语义 DOM 上注入少量原生交互；标题栏与页面双色条带连续 |
| [zyf2492313716-cloud/dsh-desktop-mac](https://github.com/zyf2492313716-cloud/dsh-desktop-mac) | 纯 Swift + WKWebView，无 Go/Wails | ★1 | **固定端口**保证 WKWebView origin 稳定；后端命令解析优先级（`DSH_WEB_CMD` → …）；工具栏状态指示 |
| [sljdxde/deepseek-harness-launcher](https://github.com/sljdxde/deepseek-harness-launcher) | 菜单栏启动器（不内嵌浏览器） | ★0，约 9MB | 起 `web` profile → 就绪后用系统默认浏览器打开；自动更新 |
| [Cheddaran/dsh-tray](https://github.com/Cheddaran/dsh-tray) | 极简菜单栏控制器 | ★0 | **launchd LaunchAgent 做登录自启（ad-hoc 签名下也能工作）**；端口被别人占用时标为 *unmanaged* 且拒绝停它；从 `~/.dsh/storages/session_projcache.json` 读用量 |
| [NeU-dev/harness-pocket](https://github.com/NeU-dev/harness-pocket) | iOS 原生客户端 | ★0 | 移动端形态（与本仓无关，列此说明生态范围） |
| [Shane-Jay/dsh-self-update](https://github.com/Shane-Jay/dsh-self-update) | TypeScript | ★120 | 社区主流的「git 源码安装的自更新」方案（非 Swift） |

### 4.2 逐项吸收判断

| 维度 | 社区做法 | 我们的结论 |
|---|---|---|
| **应用更新** | 仅 summer-521 用 Sparkle 2（`SPUStandardUpdaterController(startingUpdater:false)` + `automaticallyChecksForUpdates=false` + 菜单 `canCheckForUpdates` + `willInstallUpdate` 里停受管服务 + `appcast` + 签名脚本）；其余多为「周期比对版本号」或自更新脚本 | **采纳 Sparkle 路线作为 S-01 的 v2 方案**（需批准新依赖）；短期维持「检查 + 提示 + 手动安装」——与社区多数做法一致 |
| **开发者工具** | `#if DEBUG` 开、release 关 | **已采纳**（本批） |
| **登录自启** | Cheddaran 用 **launchd LaunchAgent**（ad-hoc 签名可用）；summer-521 未见该腿 | **可借鉴**：我们走 `SMAppService`；若 ad-hoc/未签名分发下失败，LaunchAgent 是已知可行的替代（记入待评估） |
| **运行时供给** | native-harness 从 npm 拉 dsh 并自带 Node；wheam 复用已运行实例；zyf… 固定端口 | **不采纳**：我们内建（bundle 内 node + 固定 SHA）是刻意的供应链选择（W-23）；复用他人实例与独占目录锁（design 25 §6.3）冲突 |
| **恢复/回滚** | native-harness：安全模式（无插件）→ 干净 home → 回滚上次健康启动，且菜单栏可开恢复窗口 | **可借鉴（超出本轮）**：我们目前是 sidecar 退避重启 + fatal 提示，没有「配置层面的回滚」；作为独立议题登记 |
| **标题栏/视觉融合** | wheam：无分割线双色条带、随侧栏宽度实时移动 | **不采纳（本轮）**：属像素级外观差异，用户已明确「除像素级外」才算问题 |
| **页面桥** | 社区一律不模拟 Electron preload 面（summer-521 用 `window.dshDesktop`；wheam 用语义 DOM 注入） | **不采纳**：我们的目标是双 flavor 功能一致，必须保持 60 invoke + 8 push 契约 |
| **端口/origin** | 固定端口让 origin 稳定 | **已具备**：控制面 origin 由 sidecar 端口解析 + ready 帧固定（重启落闸） |
| **托盘/菜单栏** | 多家以菜单栏为主入口 | **已具备**：本批已补 NSStatusItem「显示窗口 / 退出」 |
| **打包与签名** | 签名/公证不进托管 CI；hermetic 测试单独 workflow | **已一致**（release.yml + test-macos 腿） |
## 5. 2026-12 这一批新增 / 撤回的取舍

| # | 变更 | 理由 | 状态 |
|---|---|---|---|
| B-01 | **撤回**：更新 store 的 `slowReProbe` 改回设计值 `false` | 那是为补偿 shim「早暴露」而改共享前端；根因修在 shim 后不再需要（见 B-03） | retired（本批撤回） |
| B-02 | **撤回**：open-in 注入对象改回一次性 `bridgePlatform()`（撤掉 getter）；渲染器版本读取撤回有界重读 | 同上：共享插件不应承担 Swift 私有缺陷；根因修在 shim | retired（本批撤回） |
| B-03 | **根因修法**：shim 只在 `dsh-chamber:info` 成功后才暴露 `dshChamber`（与 `preload.cts` 的 `requestAppInfo().then(exposeInMainWorld)` 同序）；内部管路（resolve/emit/rehydrate）仍立即定义；sidecar ready 后由壳触发一次 rehydrate | 修掉「surface 在但 scalars 全 null」与「预就绪 invoke 被拒」两个形态；页面在 surface 缺失时走 Electron 同款重试链 | accepted（新基线） |
| B-04 | 慢探针背退：**成功才复位** + 连续失败 ≥2 次不再复位（100→…→2s，≤0.5Hz） | 既保留一次性失败的自愈（100ms 级），又消除「surface 在但恒 reject」的 10Hz 风暴 | accepted（新基线） |
| B-05 | 非交互宿主腿：状态型腿（setBadge）合流、事件型腿（showError/showItemInFolder）逐条排队（上限 8），放弃前补发最新队首并 loud 记账 | Electron 每次调用都会发生；合流会让事件静默丢失 | accepted（新基线） |
| B-06 | 打包 fail-closed：只有显式 `--skip-web-dist` 才允许缺 web dist，判据是 `dist/web/index.html` | release 正式腿用 `--no-zip --no-dmg` 组装，按「是否产出归档」判定会漏 | accepted（门禁） |
| B-07 | 开发者工具：`#if DEBUG` 开 `isInspectable` | 参考实现通行做法；release 不暴露检查器 | accepted（新基线） |
| B-08 | 台账新增 §6 裁决清单（D-1…D-17）与 §7 参考实现对照 | 把「需要人判断的点」从代码注释里提出来集中裁决 | accepted |
| B-09 | 引入 **Sparkle 2.10.0**（本包唯一第三方依赖，SwiftPM 二进制制品） | 用户裁决 D-1 选 B：安装腿必须由 bundle 外 helper 完成，自研=重写迷你 Sparkle；签名/公证替代不了更新通道 | accepted（原始「零第三方依赖」不变式由该裁决显式取代） |
| B-10 | 原生壳更新源 = `appcast-swift.xml`（release 资产，EdDSA 签名） | Sparkle 的标准分发形态；Squirrel 的 `latest-mac.yml` 仍只归 Electron 腿（策略测试已更新为「允许 appcast、仍禁止 Squirrel feed」） | accepted |

## 6. 未决 / 待评估

- **S-01 Sparkle 迁移**：需要新依赖（Sparkle 2）与密钥/公证基建，属需批准的运行时依赖变更；在批准前只保留手动检查。
- **通知授权的「重置后重问」**：参考实现用 `.notDetermined` + post-ready 请求覆盖；我们当前在首次投递时请求，用户重置权限后不会主动重问（可接受，待评估）。
- **S-02 心搏自愈**：任何方案都要先定义「允许丢弃多少页面内状态」；未定前不做。
