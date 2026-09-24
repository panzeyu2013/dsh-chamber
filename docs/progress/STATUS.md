# 模块完成状态总览（STATUS）

> 本文档只追踪未完成 / 部分完成项（含剩余实机门禁）、设计未决与必要取舍（范围决策 / 已知偏差 /
已知降级），是dsh-chamber进度追踪的唯一记录。已实现基线以git历史、`CHANGELOG.md` 与 `docs/design/`
为权威；不记完成叙事、测试计数/绿灯清单、提交哈希、批次轮次台账、实现过程复述或临时对齐块。

## 未完成 / 部分完成（剩余验收）

- 会话链重构（design 14 §D4）：**仍开放**
  - **阶梯单源与执行链**：侧栏 190s 回执链与 tier-3 写回 = 纯 reducer（`session-authority.ts`）+ 一条 ladder（probe / reconnect / notice）+ producer 执行端；open-in 健康 chip 与 mobile `session-stall.ts` 的调度也接同一引擎；`session-liveness.ts` planner、`authority-decision.ts`、`usableFacts` 抑制、第二完成入口与本地阈值副本全部删除（契约见 design 14 §D4「会话事实单一权威」，语料见 `packages/dsh-stream-state/test/authority/` 与 `packages/renderer/test/aggregate/notification-projection.test.ts`）。仍开放：阈值真机校准（60s probe / 190s reconnect / 310s notice；程序见 [session-authority-calibration.md](../checklists/session-authority-calibration.md)）、ssh 远端写回时延、macOS 腿、动作的**集中日志面**（机内 Local Storage 有界环 `dsh-chamber.authority-log.v1` 已落、跨重载可回读；控制面集中 verb 未做）。
  - **mobile `session-stall.ts` 的行数验收需重新表述**（范围决策）：原定 ≤150，实测拆分后仍 835，其构成约 9 成为 DOM 与提示运行壳、决策核心约 95 行且已表驱动；继续压行只能把 DOM/运行壳搬到兄弟文件（总行数不变）。待裁决 = 接受「值与规则单源」为判据，或明确接受搬家式收口。
  - **Swift 壳**：`LoadState` 状态机的纯逻辑已落（`packages/dsh-stream-state/src/load-state.ts`，含世代围栏、探针失败记 strike、一次性 give-up 闸门）。未完成：其 Swift 镜像与跨语言锁步断言、`macos/Sources/DSHChamber/RendererRecovery.swift`（181→≤90）与 `RendererHangWatchdog.swift`（105→≤60）的接线、`ShellRecoveryPolicy` 的判定/记账分离、`BridgeClient` 超时携带。判据 `pnpm run test:macos` + `test:swift` 只在 macOS 腿可跑。
  - **等待原语**：`withDeadline` / `waitForCondition` 已替换 5 处手写期限（stream 开帧/握手/重试道、排队期限、serving 轮询）与 shell 的两处手写记账；`host-graph` 的异步探测重试环不适用（同步谓词表达不了 `await`），`journal-stream` 按设计保留 `AbortSignal.timeout`。未完成：`withBootTimeout` / `boundedTailWait` 两个名字是否字面删除（记账已归零）。
  - **收口跑未做**：`run-checks.mjs full` 与 `remote-state-acceptance` 需在 fix+authority 集成分支上复跑；`pnpm run test:macos`（macOS 腿）。
  - **状态更新（集成）**：本分支 = `fix`（反补丁 P0–P6：时间/取证/载波/露屏/来源注册表/子代理三值化/门禁）+ `shell-notify`（会话单一权威）的集成；`run-checks.mjs full` 48/48 与 `remote-state-acceptance` 68/68 只在两条线各自跑过，集成后未复跑（本次只做静态冲突处理）。**净减**：11 模块 5851 → 4991（−860）；`*_MS` 34→32（快照随集成重算）。
  - **反补丁波次（门禁先行）**：不变量契约（I1–I7）与门禁映射见 design 14 §D4。未闭合：①阶梯决策边界：`planLadder` 持调度半，open-in 的 stage 迁移/具象 `resync()` 与 producer 的权威执行端仍在宿主（phase 机不进引擎）；②子代理完整性信号仍是上游依赖（本地已三值化：索引缺席/stale 降 `unknown` 中性呈现，见 upstream-proposals §7）；③载波身份边界仍是请求键（加宽账本/期限装载已归 reducer；per-stream episode token 需上游在 `open` 回调给出或由宿主承担首帧期限，见 upstream-proposals §3/§8）；④P6：上游 `session/follow` 首帧期限/`doOpen` 错误契约仍待落，退役条件由 `verify:upstream-lifecycle-contract`（pin 源两半 + 负控）钉住，落地即删客户端加宽阶梯；移动端 JSC/rAF 与真机语义仍只有实机门禁；G-H 全绿（唯一新增删除面已删，余 23 个聚合/镜像/差分面各自带退役条件登记）。
  - **既有 flaky（非本重构引入）**：`packages/gateway/test/session-state/session-state-observer.test.ts` 的 `the grace window is honoured`（单独重跑可复现，断言 `the mux grace timer delegates after the window`）；另一类只在 `tests` 模式内出现的偶发（`test:gateway` / `test:control-plane`，单独均通过）未定位。
- 结构精简后的平台腿（未验证）：本轮新增/改动的 Swift 单测（RollingWindowLimiter/StrictJSONNumber/PrivateFS/JSLiteralEscaping）与编译态 sidecar/native 走查需 macOS 腿复验（`pnpm run test:swift`；`build:sidecar` + `DSH_CHAMBER_SIDECAR_COMPILED=1 pnpm run test:sidecar:compiled`；`acceptance:gui --flavor native --require-assembly`）。Linux 本机只 loud skip，不得当绿。

- 实机门禁（未验证；缺真实实例 / 打包态环境）：
  - 多来源sleep/wake与隐藏恢复、版本歪斜容忍、gateway形态回归；
  - 隐藏/遮挡态节流修订（design 14 §D1修订；S-10降级后的实机门）：Chromium默认节流需打包态实机复核：最小化/完全覆盖（未最小化）两工况rAF/定时器/`visibilityState` 与App Nap语义、隐藏 ≥60s时SSE/推送不断、唤醒后即时重连与首帧渲染、两条30s兜底轮询隐藏期跳过 + 恢复补偿一轮；见 [deviations.md](deviations.md) S-10。
  - vendor性能补丁可见态A/B：待真实app同环境复核；跨环境不可比见 `scripts/perf/README.md`。
  - 右侧栏栈真实profile装载时序与 `provideRoot` 时序、session v3迁移真实存储行为；
  - **open-in实例内host包（`dsh-chamber-seed-open-in`，本地形态专用）**：两代runtime装载探针（`ctx.subprocess` 在旧runtime web profile是否挂载）、图标抽取一致性、`openInApp/icon` base64/缓存/CSP实测、远程无cookie fence、remote cwd填充（设计20 §6/§10）。macOS实机验收：本地等价目录顺序 + 键盘；真实图标一致与缓存命中；Finder/Terminal/iTerm/Cursor/VSCode拉起落工作区、`DSH_PERMISSION_MODE=workspace-write` 不拦；无应用环境诚实隐藏；ssh只有VS Code两态、无本地项、图标与本地逐像素同源、本机未装则不渲染；插件管理页行集4/3行与远端无该包目录、注入按钮门与「重启生效」态；N-ctx三来源同页不串台；打包态 `dist/host-open-in-package` seed成功；内置0.1.2-rc.1与pin 0.1.5-rc.2装载探针绿（最大未验证风险）。 §2仍开放：机器目录base64体积/CSP实测；Windows盘符/UNC的host侧口径（design 23）；第三方编辑器scheme逐个验证（S1前置）；上游升级时fork折入流程（registry条目豁免 + C1/C3可执行性 + `patched` 是否足够重锚）。
  - 写入期终止失败后闩锁**只**能靠重启应用再证明（design 02 §3.4）：`onWriterQuiescenceUnknown` 无扫描证据可依（记录可能已删），对本平面粘滞；触发 = 受管进程组信号被拒或子进程终止超时。
  - 实例写者静默门拦住自动启动恢复路径（同上验收）：shell被 `SIGKILL`/孤儿dsh占DSH_HOME如实拒绝（`409 connection_busy`）但「启动/停止」点不动（状态停 `starting`、端口0），恢复 = 优雅重启应用；仅硬杀后出现。
  - 降级提示目检/实机腿（05 §4）：结构性缺口下三处座位一致性——横幅 ~5s出现/自愈后以「若仍然如此…」回来、侧栏行不重复播报、连接页卡片不同时出现「正常/能力受限」、提示非阻断与 `role="status"`、与body portal叠压；仅单测 + 源码锁，未真机判（`gui-acceptance-checklist.md` §3）。
  - **切源后侧栏座席/字标与设置导航齿轮空白**（首报场景：切换来源后）：根因、修复契约、被拒方案与残余边界见 design 05 §4.2；回归锁 `packages/renderer/test/svg-resource/`（SVG 自足面）与 `packages/dsh-chamber-client-ui-sidebar/test/visual-lock/`（入场动画面）。（W8/R15③ 收窄部署面：`packages/dsh-chamber-client-ui-mobile/src/client/index.ts` 已装同一 scoper（import 自 renderer 源，不复制），committed `lib/client.js` 由 `packages/dsh-chamber-client-ui-mobile/scripts/artifact-scope-marker.test.mjs` 守卫（缺标记即红，含负控），`packages/desktop/dist/web/assets/*.js` 由 build:renderer 之后的 `packages/dsh-chamber-client-ui-mobile/scripts/assert-scoper-artifact.mjs` 在 CI 断言——仍待真机判据。**开放项**：① 真机验收未做——需在**重新构建的产物**上重放触发序列（切来源数次 + 开设置面板，rail↔wide、字标/座席一并看）确认不再空白；判据与命令见 design 05 §4.2（`node scripts/dev/svg-resource-probe.mjs --expect-artifact`，人工验收工具、不进 CI、需控制面在跑）；② gateway/mobile 独立部署的官方壳未覆盖——chamber 侧可选收口是把 scoper 装进既有打包插件 `packages/dsh-chamber-client-ui-mobile`（需范围决策），否则等上游/runtime 侧修。
  - boot死区收敛实机门（05 §4.1）：idle远端点其会话 → 遮罩立即给「连接」+ 切换行且不启动boot（隐藏满宽限后回收；编辑中来源不回收）；`error`、托管 `stopped`/`restart-exhausted` → 就绪门1.5s宽限后判不可服务（不再等满60s），`degraded`（重连在途）不判死、预算内等，两者都能退回本地；挂死boot → 超过10s反馈窗后遮罩给重试/连接/切换 + ⌘R；502（隧道通、远端端口死）→ 非阻断 `.boot-gap` 横幅 + 每ready世代一次自愈。Swift打包态复测遮挡/最小化仍收敛（与S-10同批）。见design 05 §4.1；纯函数/接线锁 `packages/renderer/src/source-readiness.ts`、`packages/renderer/test/lifecycle/source-readiness.test.ts`，通道失败上浮 `packages/renderer/test/lifecycle/host-graph.test.ts`。

  - idle来源点会话排队到68s才失败（05 §4.1推迟boot的代价）：`open` 在 `QUEUED_OPEN_TIMEOUT_MS`(68s) 内等不到壳即失败；窗口内点「连接」可在settle后补发，但无"连接成功后自动打开"这条腿。候选收口 = App记下推迟open意图、来源ready时重放（须与既有pending-open队列语义对齐）。

  - 遮罩层叠与揭幕修订的实机门（P0–P3，design 05 §2.2.1/§4；未真机判）：①遮罩层叠断言已就位但**未在真机 dev 实例上跑过**——gui-acceptance 新增 W-1b（探针 `VEIL_LAYERING_PROBE_INSTALL/READ` + 纯判据 `veilLayeringVerdict`，装/读接线在 `runWalkthrough` 的 ROOT_MOUNTED 之后与 4s boot 窗之后；判据与真表达式已由 `checks.test.mjs` 在 CI 覆盖），待 `--dev` 实例 + CDP 跑一次走查并确认本次真观察到遮罩帧（无遮罩帧按 INFO 记，不伪绿）；②冷切换的揭幕时延需实机判：会话面 `active` ⇒ ≤1 帧；`absent`（观察不到会话根，降级形态）⇒ 兜底 ≤2s；`hero/settling`（空白新会话 / 载入中）⇒ **保持遮罩**直到 App 释放（只留 70s 外层保险，正常路径不触发——两档上界见 `session-surface.ts` 的 `surfaceHoldBoundMs` 与 design 05 §2.2.1）；③Swift 打包态**无法自动做页面内测量**——release 构建 `isInspectable` 仅 `#if DEBUG`（`macos/Sources/DSHChamber/MainWindowController.swift#=literal:webView.isInspectable = true`），只能 DEBUG 构建 + Safari Web Inspector 人工抽检；两 flavor 共用目录锁，不能并跑。

- Swift原生运行期监督（未实现；两条正交缺口复核）：① 控制面：原生壳只首载前探一次 `/health`（S-45）；sidecar活而事件循环卡住无人发现（`SidecarSupervisor` 仅看退出码）。收口 = 前台周期探测 + 「重启sidecar / 重新加载」；无Electron对应面，差异由P-09/S-02覆盖。② 渲染器：`RendererHangWatchdog` 是整页探针（`evaluateJavaScript("1")`），需"15s无输入 + 3次探测"，键鼠即重置，`didFinish` 前未武装；窗口 `didCommit` 已呈现 ⇒ "首帧求值期冻结"与"持续点击期冻结"都无原生超时，只剩 ⌘R；与05 §4.1的页面级逃生正交；收口 = `didCommit` 后武装首载超时。

- 宿主cwd / 安装根（实机事故，余两条；控制面侧已收口：installed 形态宿主 cwd 由 `packages/control-plane/src/spawn-dsh.ts` 的 `resolveSpawnCwd` 落到 `<stateDir>/dsh-home`）：① vendor `worker_threads` 仍共享 `process.cwd()`（vendor上游 → fork/补丁 + registry/C门，按升级维护）；② 安装/更新原子化 + 运行中检测（宿主detached spawn活过控制面，替换前须先停/重定宿主）。失效判据：两条各有实现或显式豁免。

- ProMotion / 120Hz实机验收（未完成；口径与退役判据见deviations S-48 / design 25 §5.1）：残余 = 打包态三工况实机验收；另需确认 `DSH_CHAMBER_SHELL_DEBUG=1` 的 `[shell-fps]` 观测只在调试态出现（S14/T-11调试面纪律）。

- 原生席位（语言/外观跟随）实机门禁 + W7 待裁决：仍开放——打包态右键菜单语言、Sparkle 标准窗语言与外观、打包态实机目视（`zh-Hans` 与 `zh_CN` 的**匹配已本机实测确认**：`Bundle.preferredLocalizations(["zh-Hans"]) → zh_CN`）、页面内切主题的即时性（契约见 design 25 §5.3、deviations S-11/S-24/S-47/S-53）；**已裁决的语言语义（用户裁决，不再重开）**：保留「族比较 + 同族不覆盖」的两层语义——**壳自建文案跟随应用内设置**（页面语言，切换即生效），**系统与框架面默认跟随系统语言**（Sparkle 标准窗、AppKit 内建串、右键菜单），仅当语言族不同（中文 ↔ 非中文）时才写 `AppleLanguages` 让这些面一起跟随（下次启动生效）；跨族强制跟随与"框架面永远跟系统"两侧均被否决，取舍理由见 design 25 §5.3（含 Rejected alternatives）。**必要取舍两条（审计后仍成立）**：① 本壳只随包 en/zh-Hans，`zh-*` 折叠为 zh ⇒ zh-Hant 页面下壳自建文案为简体、系统框架为繁体（与页面 frame 自身的简体折叠一致，是否收口取决于是否随包 zh-Hant，见 design 25 §5.3）；② A 桥 shim 的六条拒绝文案（随包的 `macos/Sources/DSHChamber/Resources/bridge-shim.js` 的 ERROR_TEXT_BY_CODE）保持英文——它是 Electron renderer-trust 的**逐字镜像**，且运行在页面世界、取不到壳的键表，若要本地化须同时改两 flavor 并注入词典，属产品裁决；W7（更新自动检查与间隔的设置化）待产品裁决——现无设置席位，行为只由能力位与模板常量承担（`macos/Sources/DSHChamber/AppUpdater.swift#AppUpdater`）。

- gateway unit登录环境真机门（待Linux判）：`write_unit` 无 `User=`、注入`HOME/LOGNAME/USER/XDG_CONFIG_HOME`（`scripts/install-gateway.sh`，design 17 §5）；单测只钉文本/结构。真判须重跑安装器 + `daemon-reload`、在部署机验 `systemd-analyze verify` + 服务拿到HOME（`ghauth status`）——macOS开发机无systemd，未判。

- ssh/http dsh目标无cookie注入（实例侧401）：五处同源绝对URL由vendor补丁集走本实例前缀（design 09 §3.6）；cookie注入属既有认证面，未覆盖。

- **gateway来源插件播种被拒（400 `invalid_input`实机）**：旧gateway只认 `dsh-host-*` ⇒ 现仓`dsh-chamber-seed-*`（`gateway/src/plugins.ts:49-56` 钉死）被拒；gateway回sanitized原因（`plugins.ts:144-147`/`:186`/`:221` → `routes.ts:1045-1057`，`sanitize-route-error.ts:20-26`），桌面侧并入失败（`gateway-provider.ts:1448-1460`/`:1487-1488` →`main.ts:3462-3464`）。剩余 = 就地重建旧gateway未排期（不做旧名回退播种）。

- **`install` 就地重装不同步dsh锚基线（`.172` 实机，待裁）**：`install-gateway.sh` 的`--dsh-upgrade/--no-dsh-upgrade` 只对 `update` 生效（`:3674-3676`），install复用旧锚（`:1137`/`:2292`）⇒锚与托管dsh可能停旧代；壳升级自愈事务（F4，design 18 §3.5；`gateway/runtime-manager.ts:1049`）发`submittedAttachments`（`runtime-probes.ts:25-38`/`:483-495`）对旧代回 `gateway/arguments-invalid` ⇒探针必败、实例被停并留 `gatewayruntime startup blocked: swap-attempted; managed dsh left stopped`（`gateway/src/index.ts:486`）。就地收口 = 升锚后重跑该事务。待裁：`install` 是否该像 `update`一样校验/同步锚基线。

- dsh运行时版本管理（design 18 §3.6/§9）：剩余——macOS打包态 `.app` 内共享dsh-runtime/内嵌pnpm/koffi与完整激活-回退-恢复链实机；Linux server端到端；Gateway重启窗口前端重连与SSH `restart_service` systemd IPC端到端；`restartLocal()` 真实1sSIGTERM→SIGKILL grace × 健康计时器交错；settings-bridge gateway组件级交互仍以纯函数/API测试代证；ZFS全新pnpm store克隆偶发 `ERR_PNPM_EAGAIN`（系统化并发缓解未排期）。

- **`protobufjs`/`@google/genai` 放行与上游分歧（待M2首装证据）**：上游 `pnpm-workspace.yaml:40-43` 记`false`（脚本no-op），本仓 `packages/dsh-runtime/src/allow-builds.mjs:18-19` 记 `true`（理由`:41-43`）；对齐需真实M2全新安装证据（是否真no-op、闭包是否真需要执行），此前保留放行。

- **连接fork `ownsGeneration()` 守卫是「无行为见证」的纵深防御**：`dsh-client-connection/src/client/index.ts:387` 守卫无法被任何测试见证——唯一生效路径必经 `releaseOwner`（`:298-305`）调 `controller.stop()`，而 `reconnect()` 在 `!running` 时首行返回（`connection.ts:130-131`）⇒删除行为逐字节相同。 不要补测试（会是假绿）；待裁：留作纵深防御或按死代码删除（`:354`/`:361` 同类）。

- 隐藏span阈值语义**只**由触发器单元覆盖：接线层不断言 `visibilitychange`隐藏 ≥30s真时序（`index.ts:379-401`），真测需实等 ≥30s；语义由 `test/recovery/liveness-triggers.test.ts`单元覆盖。漂移面为零；接线层见红需加可选注入——按严重性未做。

- gateway运维页缺三个变更入口（design 21 §7）：`gateway/src/routes.ts:224-236` 的 `RUNTIME_PATHS` 缺`recover-metadata`/`cleanup-version`/`restore-pre-rollback`（页面无按钮），三条路由存在（`runtime-routes.ts:346`/`:362`/`:376`，表 `:498`）。FATAL metadata下 `recover-metadata`是唯一不被拒的变更路由（门文本 `runtime-routes.ts:164-194`/`:203`），无头部署只能curl——UI入口待补。

- apply-now立即应用（design 18 addendum实机门禁）：macOS打包 `.app` 运行中全链；Linux server生产TLS下POSTapply-now → 202 → 停机窗口轮询 → 探针 → 故障注入回退；Windows只读投影。

- 桌面端更新（design 11 §9）：真实Apple凭据跑通一次发布CI（Developer ID/公证/stapling/Gatekeeper）+ 双平台清单（确认前不下载、下载后退出安装、mac quitAndInstall原生quit语义、打包态端到端与缓存清理）仍未在签名正式包确证；缺凭据在Releasemutation前阻断，仅 `dry_run` 允许ad-hoc mac构建。

- 认证服务端Gateway（design 17）：剩余发布前实机门禁——生产TLS反代Host/Origin/XFF/Secure-cookie与SPKI pin正负例、真实dsh `/api/remote.mux` 断线恢复；打包Desktop三形态（HTTPS+凭据/HTTP+凭据/`--no-auth`）重启后safeStorage重登与凭据变更撤销live stream；`/chamber/runtime` 生产TLS全链；Linux service安装升级回退；`--bind 0.0.0.0`/隧道/tailscale负例。凭据管理：desktop settings-bridge便捷重置（推迟）+ 真实TLS改密/轮换/停机态CLI恢复。

- S0/S2 http直连链路（design 17 §10.5）：S2-c（放宽dsh mux心跳）未实现——前置 = 扩展gateway patch写入器。剩余验收：打包态实机（浏览器直连gateway的Models/插件设置可写；杀托管dsh/断网后sidebar 60–120s自动恢复；升级dsh后复验钩子存在性）。

- 设计21网关插件能力对齐：剩余 §9实机E2E矩阵（真实gateway×desktop双通道门禁、registry传递依赖/lifecycle、故障注入、journal中断对账；发布前执行；.172升级因凭据轮换暂停待恢复）；UI余留：who/when tooltip未渲染、拒绝码→本地化映射未做（409逐字英文）、pollGatewayReady英文串未本地化；archive-pick双模式对话框为macOS-v1。

- 产物新鲜度守卫（§6.11 / design 21 §7）：`desktop/dist/control-plane/**`（`packages/desktop/scripts/control-plane-freshness.test.mjs`）与 `gateway/dist/**`（`packages/gateway/test/packaging/build-smoke.test.ts`）是「存在但缺当前标记 ⇒失败」的标记守卫；起「陈旧 ⇒红」分两层：**C8（`scripts/upstream/verify-upstream-touchpoints.mjs`）** 对构建期生成物做重建-比对（6 组：`dsh-runtime/dist`、4 个 seed `dist/index.js`、mobile `dist+lib`；清单单源 `scripts/lib/build-artifacts.mjs`，`ensure-artifacts`/freshness 门均 import 它）；**`scripts/gates/verify-artifact-freshness.mjs`**（`scripts/gates/run-checks.mjs` 的 tests/full，经 `ci.yml` 进 CI）覆盖其余四类：`gateway/host-packages/dsh-chamber-client-ui-mobile/**`（与源逐字节）、`desktop/dist/preload.cjs`（tsc 重编比对；`scripts/gates/verify-electron-artifacts.mjs` 另在 macOS 腿/CI 执行编译产物冒烟）、`renderer/src/generated/**`（重跑生成器比对）、`gateway/dist/index.js`（用包自身 `scripts/build.mjs` 在临时副本重建后逐字节比对 新增第 4 类）。仍未守卫：`desktop/dist/web/**`（`packages/desktop/scripts/electron-shared.test.mjs` 只断路径文本；仅 scoper 标记由 `packages/dsh-chamber-client-ui-mobile/scripts/assert-scoper-artifact.mjs` 在 CI 断言）、`dist/host-{graph,git-worktree,archive-cleanup,open-in}-package/**`（只断言行序/outDir）、vendor `allowBuilds` 锁步（G7）。未落地的最小守卫建议 G2/G3/G5/G7/G8（G1 已落地 `verify:test-wiring`）见 `todo/product-freshness-guards.md`，design 21 §7 登记。失效判据：每个产物有「陈旧 ⇒ 红」守卫或进入豁免表（G8）。（scoper 收窄：mobile committed `lib/client.js` 由 `packages/dsh-chamber-client-ui-mobile/scripts/artifact-scope-marker.test.mjs` 守卫；`desktop/dist/web/assets/*.js` 由 `build:renderer` 之后的 `assert-scoper-artifact.mjs` 在 ci.yml 断言——本仓无 node_modules 时该步骤只在 CI 生效。）

- CI无任何腿能证明SMOKE PASS：`control-plane/test/smoke.test.ts` 在CI恒SKIP（不设 `DSH_CHAMBER_DSH_PATH`、无`ref-dsh`/vendor运行时），release.yml同样没有smoke；`ci.yml` 只接受显式 `SMOKE PASS` 或显式 `SKIP: …`（静默exit0会红），绿灯从未代表真跑过安装链。失效判据：至少一条CI/发布腿真跑出 `SMOKE PASS`（或明确改判「不做」并登记缺席理由）时删除本条。

- **A1状态呈现面（普查；F1已修，四组合由 `packages/desktop/test/plugins/plugin-sync.test.ts:333/:353` 钉住）**：剩余：F2安装提示无条件承诺「下次重启生效」（`PluginDialog.tsx:972/1005/1027/989-992/1069/1994`+`locales.ts:226/289/363`）→ 按行分级承诺；F3 materializeLive把「重启+就绪」当已生效（`PluginDialog.tsx:1058` +`locales.ts:301`）；F4 instance-version-conflict断言版本差异而输入建立不了（`client-plugin-loader.ts:206-214` → `host-graph.ts:791-805`，措辞被`renderer/test/lifecycle/host-graph.test.ts:787-812` 钉住）；F5同源restart-required报「另一个版本」（`host-graph.ts:806-810`）；F6侧栏recheck把boot已拒的图治成ok（`plugin-graph-recheck.ts:198-212` vs`host-graph.ts:251-266`，应复用boot校验器并报降级）；F7 ssh bundle断言用本地bundleLines判远端（`main.ts:3521-3532` + `plugin-sync.ts:1329-1360`，应读远端自己的 `dsh.bundle`）。疑似未动：S1`plugin-graph-recheck.ts:212`；S2 `client-plugin-loader.ts:253/:281-288`；S3 `writer-diagnosis.ts:63-74`；S4`plugin-inventory-text.ts:145-172`；S5 `PluginDialog.tsx:883-891` + `gateway-provider.ts:1467-1484`；S6`host-graph.ts:836-841`（死/只写API，清理）。失效判据：其余各条修复或显式裁决（原普查台账已删，本条即权威）。

- A2尺度错配（普查）剩余：A2-4 apply-phase拿内建哨兵与打包semver等值比较（`dsh-runtime/src/apply-phase.ts:256`、`desktop/main.ts:4700-4703`、`gateway/runtime-manager.ts:1009-1013`）→相位边界归一；A2-7 `dsh-runtime-controller.ts:461-462` 读raw pending，而`:375-377` 与 `override-lifecycle.ts:71-75` 用effectivePending → 门与动作同源。潜伏项A2-6（`host-graph-seed.ts:478` 原始字节vs utf8串）非现网缺陷：种子集当前只含文本、图标不进种子，且`readPrivateFileNoFollow` 对非UTF-8响亮失败；一旦加入二进制种子即踩中。失效判据：各条修复或显式豁免；A2-6 =种子集出现二进制文件前改字节级比较并加「非UTF-8种子文件」回归。

- A3聚合吞未检项 / 读失败当确定结论（普查）剩余：A3-1/2/3/4保鲜门自证（`verify-upstream-touchpoints.mjs:1037-1040` 与 `plugin-protection-gate.mjs:160-189`；`:505-533` 双侧改名 `0===0`；`:938`/`:956-1000`/`:996-997` esbuild缺失仍「全部通过」；`:592-617 --no-artifact-rebuild` 零条目仍 ✓）；A3-5`restore-lockfile-vendor-records.mjs:171-188`/`:245-248` 四处假过且 `--check` 未进CI；A3-6`release-preflight.mjs:106` vs `:103` 未读package当已覆盖；A3-7 `protected-plugins.ts:790` 零检查与通过不可区分（callers `main.ts:36`、`gateway/src/plugins-exec.ts:855-885`）；A3-10 `plugin-sync.ts:805-808`（+`:1082-1088`/`:1376`）manifest读失败当plain、bundle臂跳过仍 `verified:true`；A3-11 `main.ts:2033` 空familyNames ⇒ `{ok:true}`零日志（对照 `protected-plugins.ts:769`）；A3-12 `ssh-plugin-journal.ts:234-265` + `main.ts:3572-3573` +`PluginDialog.tsx:680-681`；A3-13 `dsh-runtime-store.ts:1130` catch ⇒ `[]`；A3-15 `snapshot-store.ts:1012-1013`/`:1085` 非目录根 ⇒ `[]` 且 `skippedReason 'none'`；疑似S1–S13（release-preflight/vendor-pin/gateway/desktop/ci面各一处；S12 = CI SMOKE无PASS腿，已单列）；A3-14保留原文：known-good的 `.corrupt` 无人读 ⇒保护版本可被删。失效判据：读失败/未检必须与「确认无引用 / 空journal / 通过」可区分（不删任何东西、preImage保留、原始字节留证），各条由回归测试钉住；逐条修好或显式豁免。

- bundle层行拿不到「是否已生效」信号（design 21 §6.6）：生效格按Loader快照 `moduleName===包名` 精确匹配，未命中即中性（`plugin-inventory-text.ts:252` `thirdPartyLiveState`）；bundle包名从不是Loader行 ⇒ 后加 `dsh.bundle` 层未重启与已生效同现。闭合 = 新增宿主事实 `Local/RemotePluginManifest.bundleLayers?:Array<{name, patchRows}>`（`patchRows` 取 `dsh.bundle.patch.insert[].name` 去重保序），求交方区分「生效中/加载中/重启后生效」——属新宿主面，须单独评审（design 21 §7登记）。失效判据：事实落地并消费，两态呈现不同且正确。

- 受保护集合与代耦合（design 21 §6.11，决策19的修订）：仍留五项——① ssh装面保守（无远端来源；放开须按design 13 §7.2 exec纪律评审）；② 代不匹配默认阻断、无跨代override（不得降级为静默警告）；③ 旧就地gateway无 `rows` 回退分支（只列第三方 + 版本较低提示；失效 = gateway全量升级后删除）；④ 装后复验违例自动回滚未做（复验强制；两端均无还原重装，处置 = runbook人工卸载/重装；失效 = 任一端具备回滚）；⑤ `owner` 已随行投影但渲染端未消费（tooltip/行级「代」未做）。（原第⑤项「本地清单原样返回」已接线：`shell-ipc-plugins-local.ts` 经 `redactLocalPluginManifest` 对 dependencies 与 `rows[].spec` 两通道掩码，失效判据「接线遮蔽」达成，条目退役。）

- 归档清理与归档管理器（design 24）：剩余仅测试类——打包版实机目检（幽灵行不再浮现、点击不再 `session/not-found`）、探针依赖实例就绪（fail-closed）、语义接线以源码契约 + 目检代证、集合 >65,536不清扫；gateway/远程dsh实机形态与UI目检（design 24 §6/§13第17条）。版本歪斜口径：新客户端向未重启旧宿主发 `protectSessionIds` 被精确校验整体拒、不做形状回退，处置 = 重启该实例；窗口属发布说明。
  实机验收（§5/§13，保护修正后待跑）：卡提问/等权限归档会话 → 归档即终止 → 管理器删除一次成功；无会话打开/来源壳回收时删除仍可用且顶部有降级说明行；vendor未清空选中前删除正查看的已归档树 → 报 `skippedProtected` 且内容未删（保护输入为活 `current`，不记忆），切换/稍后重试即成功；运行中子代理后代所在树一次删除收敛；3s未settle如实报 `skippedRunning`。
  常驻保留链（修正后的回归门，待跑）：归档本进程打开过的会话 → 删除（结果行给出常驻保留文案）→ 侧栏不再现该普通行、管理器仍带「内容已删除，待实例重启收敛」→ 重启dsh → 行消失、purge干净（tombstone由孤儿清扫收敛，仅当实例已产生至少一条会话记录；空语料时G1a永跳，属已知取舍）；反向判据：未打开过的归档会话删除后照旧立即消失。
  登记残余：事件发射no-op直至上游wire（域随 `sessions.delete` 落地退休）；维护期报 `idle`，force可能删到正追加的档（缓解：归档即终止 + 删除侧闭包全员cancel）；归档集合run起点快照；保护边界 = 活 `current`（多客户端正看的会话、掩码窗口内本页会话不在保护集，design 24 §13⑭）。可选增强：PluginDialog三态行、rowError本地化、已归档浏览区。
  既有缺陷（未修，待裁）：run级 `archive-set` 提示与per-item failure共用 `errors` 通道，`archive-purge.ts` 对 `errors.length > 0` 一律 `kind:'error'` ⇒ 删除成功的run也现红字（证据 `core.ts recordError('', 'archive-set', …)` + `retention-properties.test.ts` I5）；修法未决（分通道字段vs客户端按code归类info）。
  清理残留（待裁两条）：① 单删成功后 `storages/session_projcache/sessions/<id>.json` 仍留4 KB档——是否回收未决（purge只处理 `binding.ts:483-488/:524-567` 代际/暂存/租约，对 `projcache` 零命中，上游无入口）；② 迁移在飞时purge可能留一代窗口：同目录并发write-open发布后继代际（`generation.ts:829` `link`），purge先 `readdir`（`binding.ts:524`）再 `rm`（`:544-554`），`link` 在枚举后落地则 `rmdir` ENOTEMPTY被吞（`:556-566`）却仍 `return 'deleted'`（`:567`）——成员关系清除、内容仍可读且后续purge不收敛。磁盘泄漏未裁决（守卫选项：写租约删除时机/二次枚举/rmdir失败不改判）。

- 会话列表标签（前任记录愈合域已撤回）：标签链 = 官方 `title → basename(cwd) → 会话id`（侧栏单点resolver）；「未命名会话」只剩归档管理器durable名列与行不在投影时通知回落；`+` 复用workspace空白成员。前任记录愈合域已撤回（规格在git历史）：未归档、标题读不出的历史行仍出现、按项目目录名标注，不需要时用户自行归档；标签修复不再有超出日常的实机验收项。

- 移动端Web访问面（design 17 §18；契约 §18.3–§18.5、门禁 §18.6）：
  未实施：移动中量化 + 静止吸附精确值（现16px固定量化）；设置分区滚动位置记忆（现一律复位；无稳定section id、异步高度不足会钳顶）；宽屏触控（iPad横屏1024px+）键盘补偿（行为层与CSS同在1023px触屏档，扩展需设计决策）；原生 `title` 长按气泡不抑制（刻意手势，部分title是截断行唯一入口）。
  composer 可见性守卫（layer-5 实测修订，design 17 §18.4.4）：台架为真实上游 CSS/DOM + 本包产物（Chromium），**WebKit 侧未验证**——sticky `bottom` 内缩在 iOS Safari 的实际落位、真实键盘事件序列下的 arm 时机与死区待真机；判据 = 真机读 `[data-mobile-frame][data-mobile-kbd-state]`（出现 `still-covered` 即该引擎不认 inset，需启用备选执行器：spacer-only 抬升 / seat 内 transform）且输入区底边不落在键盘之下。
  复审开放项（判据待实机）：
  ① 触屏档右栏全屏与抽屉让位（`mobile/src/client/styles.ts:175-230`，锚点 `data-sidebar-right-panel`）；让位靠两臂——上游轨道标志 `data-rightbar-collapsed`（手机档面板展开同样track=false）加 `[data-rightbar-fullscreen]`；规则含iOS安全区与 `box-sizing:border-box`；768–1023档隐藏自带模式控件（钉死全屏），面板子树 `overscroll-behavior:contain`。待判：769–1023观感、44px退出控件够用否、关闭后抽屉回原态、刘海/home indicator压内容否、键盘弹起时开面板是否blur composer。
  ② 新并入44px底线：会话头视图tab（恒两个，`styles.ts:430-448`）后头部增高、tab条改换行后「第三个视图」可达性；dockkit条（`styles.ts:470-520`；chip 20px关闭控件刻意排除、条内按钮border-box、chips保持content-box，否则chip最小值100→80px而放宽分屏判定）；会话头座席底线仍在内容盒（图标按钮约56px）。待真机判48px行观感、≤480/≤360排布、横滑与谱系hover-open互扰、横向平移对抽屉边缘手势。
  ③ 未适配官方浮面（只登记）：dockkit面板出生矩形380×300 @ (160,120)、无视图夹取、宿主z-60高于本插件所有层（`ui-dockkit/.../constraints.ts`）；`ContextMeter` 固定264px贴trigger右侧（`ContextMeter.module.css:41-58`）窄屏余量未实测。
  ④ 上游 `touch-action:none` 与chips横滚冲突（dockkit条与chips行都为拖拽保留）⇒ chips溢出无法滚动；是否补chamber补丁待设计决策。
  ⑤ 真机抽检与模拟边界：走查：`mobile-walkthrough.mjs`/`mobile-checks.test.mjs`/`verify-mobile-anchors.mjs`；模拟层三条不能当真机结论——`setEmulatedMedia` pointer/hover被Chromium忽略、`mobile:true` 让 `scrollWidth<=innerWidth` 恒真（须用 `clientWidth`）、iOS/WebKit语义造不出。仍开放：真实手机/打包态抽检（几何观感、横滑与谱系、平移与抽屉手势）、走查只读（抽屉/设置/键盘补偿与其余44px座席未断言）、会话打开停滞的WS帧证据。锚点门无上游树时fail-soft跳过；`--require-anchor-root` 对缺根/无client产物/抽不到源码/语料不完整/pin身份不可判定/版本不一致exit 1（与 `--simulate-rename` 互斥）；pin身份仅版本级，内容级需仓内快照，CI常态生效需生成式快照。
  ⑥ pin前瞻：npm `next` `0.1.5-rc.2`（client已发布，`latest` 仍 `0.1.5-rc.1`）——pin前移须按 `mobile/README.md`「Anchor baseline」重审（风险在ui-layout frame与settings/composer结构）。
  ⑦ iOS键盘补偿期「回到底部」控件仍在键盘后（`ui-chat` 按 `--dsh-composer-height`+16px定位而补偿改seat sticky `bottom` 高度不变）；该控件无属性锚点（禁按 `aria-label` 匹配）——候选：请上游补锚点或插件arm期改写变量（与上游ResizeObserver竞态，需设计决策）。
  ⑧ 回车换行caret reveal时序（iOS待判）：`execCommand` 后立即测量caret，Lexical DOM归并在mutation microtask——归并若改caret则揭示落空（composer撑满后回车新行须在可视区）。
  ⑨ layer-2恢复在WebKit blur语义下可能不可达（CANNOT-VERIFY，静默失效仅少一层保险）。
  ⑩ iPad接触控板/鼠标的档位（假设待验）：整层以 `pointer:coarse` 门控，若iPadOS报主指针fine则移动档整体退场（回落上游窄窗）——实机确认一次。
  ⑪ 档位边界与多任务（待实机）：768/1024在Split View/Stage Manager/旋转连续拖拽中可中途翻转；768–979且抽屉展开时上游解得 `cols.rightbar=0`、面板0宽并自收起（`SidebarRight.tsx` 的 `canShow`）——需确认观感。
  ⑫ 让位与官方模态叠加（待判）：设置页在侧边栏DOM内，面板在其打开时展开 ⇒ 抽屉子树 `visibility:hidden`，文档停在「有 `aria-modal` 但对话框不可见」；面板展开时composer持焦则iOS键盘不收起、输入进入面板后的composer——需真机决定是否补处理。
  剩余实机门禁（§18.6）：真机触控目标比例/抽屉开合/键盘遮挡（iOS时序与Android WebView盲区、聚焦缩放后打字正例、缩放态平移不抖动、捏合缩放负例、提交窗口不闪落、重挂re-arm、死区 ≤23px）/安全区/抽屉开关不重叠/crumbs条官方nowrap后横向平移手感（谱系计数span不许退回换行；平移与抽屉边缘手势互扰仍需真机）/iOS单击切换/设置手机档走查/刘海横屏/深层谱系高度。
  登录页阶段预热（design 17 §10.6；评审重写）：capability 改走 HttpOnly cookie（实测 URL 包装形与 App 的真实 URL 不共享 HTTP 缓存项，旧 token-in-URL 写法为空转），发现腿带 spawn 期 browser-auth cookie（上游 index 需浏览器认证，否则登录页 0 条链接）。剩余门禁——① 真机/真实托管链路验证（真实手机 prefetch 命中 HTTP 缓存、登录后首屏不再以约4.35 MiB gzip 走关键路径、`connect-src 'self'` 不误伤既有页面、路由不得追加 `vary: cookie`、`--no-warmup`/发现失败时逐字节回旧模板）；② 滥用度量（`warmup_rate_limited`/`warmup_capacity` 拒绝率、预热腿 502/503 比例、预热流量占出网带宽比）尚无采集面；③ 边界复核：`/plugins/**` 的两种 bundle 形态在带 cookie 时 pre-auth 可取（与上游「非 index 资源公开」一致），其余 `/plugins/**` 与 kill switch 关闭态保持 401。失效判据 = 三项各有真机/度量证据或显式裁决不做。
  移动端git侧边栏：桌面链座席为桌面专有，接入需装配矩阵第二客户端例外 + 移动交互设计（下一阶段）。DOM锚点审计剩余：details打标接线仅实机可验、composer锚点fixture化、Android键盘盲区真机门禁。P2：PWA安装 + SW壳离线（per-instance scope，尊重官方「不完整离线」）。P3：公网认证流转正式化 + Web Push；先行形态 = 内网/可信网络 `--no-auth`/tailscale。
  - 连接稳定性（未修复，取证中；）：唯一长连接 `/api/remote.mux`；实例侧心跳2s×2（硬编码）⇒ 静默4–6s `terminate`，gateway侧无日志；代理浏览器腿30s/1 miss（拆链同毁upstream腿）；客户端指数退避（500ms×2上限10s）重连 + baseline replay；pending approval/question在generation结束被abort、重投换新key ⇒ 草稿丢失/弹窗重建。仅1次拆链 ⇒ 代理心跳非主因；无周期性整页重载/SW。取证日志（`proxy-forward.ts` 的 `WebSocket stream <id> closed (<cause>, <ms>ms)`）区分实例判死与客户端重连（代理主动撤销亦记 `upstream close`）。下一步：DevTools抓close code + 节奏（1006/4000）；若为实例心跳，最小改动 = patch overlay加config行（现 `cordis-inserts.ts` 仅id/name）调宽 `websocketHeartbeatIntervalMs`（宿主 `api-gateway` 的 `Config.websocketHeartbeatIntervalMs` 默认2s）。① 取证日志 `WebSocket upgrade <id> abandoned (downstream close before upstream handshake, Nms)`（`revokeTransportTraffic`/`closeAllStreams` 亦走此行，不可单据此判定「浏览器主动离开」）；② 上游腿代答宿主pong已评估并整体回退：RFC 6455 §5.3掩码要求（pinned `ws` 未掩码帧1002）、pong插 `pipe` 劈帧均协议级硬约束 ⇒ 不做字节注入（见design 14 §D4触发面小节）。否决替代：解析close帧（实例侧 `terminate()` 不发）；改用上游ping间隔计数（~15行）。另：桌面idle重连看门狗只按transport过滤（`App.tsx:1824-1865`，阈值 `aggregate-refresh.ts:119-123`：http 120s/ssh 300s/local跳过），gateway目标（同属direct-http）也吃 ~2min bounce——解释「桌面也发生」。
  - 会话运行位卡死（ui-chat「深度求索中」）的剩余门：**P2 已把机制改为单一权威链**
    （纯 reducer `session-authority.ts` + probe ladder + producer 执行端 + `notification-projection` 单通知投影；
    旧 planner / 190s 回执链 / `authority-decision` / 双通知入口已删除，见 design 14 §D4「会话事实单一权威」）。
    下列子项按新形态复核后仍开放；其中 ⑨「整行缺席一律 unknown」已裁决替换为「全量 unary 读缺席 +
    N=2 一致 ⇒ stale 并可写回」，残余只剩宿主返回不完整列表（无完整性信号），由 N=2 与 host-wins 兜底。未闭合：
    ① 实机/浏览器lane端到端复现未跑——fixture的 `__fxTiming.appendSilent` 与 `breakStreams` 两个timing hook可确定性回归，未接CI（失效判据 = 该场景进CI）；
    ② HTTP通路健康而WS逻辑流半盲时运行位收敛但transcript不收敛（已落 fork 级杠杆：`RemoteJournalStream` 静默 ≥45s 时开旁路 sibling follow 只比对 opening cursor、仅当前进才重订阅，见 design 14 §D4「逻辑流开帧丢失与首帧期限」；宿主 `session/list` `projections.asOfSeq` 对账仍为可选收紧路径（未做）；`Session.resync()` 已作为**用户触发**的座席控制落地（见 ⑫），自动重放仍不做——失效判据 = `appendSilent` 场景进 CI 车道 + 真机校准）。`openState='error'` 与 `'loading'` 两个可观测变体已由健康臂收口（见 ⑫），「流仍open而静默」未闭合（见 ⑬）；
    ③ 官方 `session.list` **单飞悬挂**时 L2 无效、store 的 `listState` 永久 loading；tier-3 写回已能纠正**事实**（侧栏/聊天面立即脱离陈旧位），但 store 级悬挂仍只能靠
    「重新加载」收口（需上游给 fetch 超时或客户端可清除 in-flight——失效判据 = 悬挂后重连能恢复，
    且写回路径在真机上被验证为「不依赖 store 收敛」）；
    ④ 子代理会话（`origin==='subagent'`）不在事实通道 ⇒ 该臂看不见（失效判据 = 该行进入事实通道，或裁决为接受的盲区）；
    ⑤ 隐藏期watchdog不tick；恢复后首个补偿tick按累计running时长判定（隐藏时长计入 `since`，非「重新起算120s」；若要后者须显式重置时段计时，当前不做）；
    ⑥ 阈值（L1 门槛 60s / 等回执 190s / L2 退避 300s / L3 120s）与 新增的 N=2 确认、
    写回链**未经实机校准**（60s 门槛的语义已由 `packages/dsh-chamber-client-ui-sidebar/test/session-state/session-authority-escalation.test.ts` 钉住，但
    真机抖动/慢宿主下的误报率未测）；L1 配额为滚动窗口（10 分钟 ≤3 次）；
    ⑦ 上游语义依赖（refresh 回灌 / emit 无重传 / 失败也 resolve / `mergeOrderedBaseline` 缺席即移除，
    以及 `ClientSessions.handleSessionStatus` 公开且一次写 summaries、物化 Session 与 catalog
    activity）由 `packages/dsh-chamber-client-ui-sidebar/test/session-state/vendor-session-fact-contract.test.ts`
    读 pin 住的 vendor 源逐条钉住（语义一变即红，守卫/写回须重推）；该文件在 vendor 树未物化的检出里
    **默认失败**（只有显式 `DSH_CHAMBER_VENDOR_ABSENT=skip` 才跳过，CI 不设该变量），升级 tag 时仍按
    `docs/checklists/upstream-touchpoints.md` §7 人工复验；
    ⑧ 控制面 `<stateDir>/logs/control-plane.log` 与原生壳 `<userData>/logs/sidecar.log` 取证价值未在一次真机事故验证（失效判据 = 事故后能从这两处检索到 `WebSocket stream … closed` / `heartbeat lost …` 行）；
    ⑨ **权威判定对「整行缺席」一律按无结论处理**（`uncoveredRunningIds` + `decideAfterFirstAuthorityRead`）——严重性已下调
    （读 vendor 源码核实：`refreshList()` 的 `mergeOrderedBaseline` **会移除权威列表里
    缺席的 id**，缺席行被 refresh 从 store 清掉，不会留下永久 running 的行；残留只是「缺席不触发
    升级」这一保守方向；五轮复核补充：「未覆盖的 running 行」**一律**按无结论（`unknown`）处理——官方 refresh 的失败会 resolve 成 `ok:false`（reconciliation 侧观察不到），不能按 refresh 成败 gate；成功的 refresh 会用 `mergeOrderedBaseline` 清掉缺席行，留下的未覆盖行本身就说明官方对账没落地）。若宿主返回**不完整列表**，这才是残余出口（失效判据 = 上游给权威读一个
    完整性信号（`asOfSeq`/游标）后把缺席升级为「未收敛」；判成未收敛前会引入假升级，故刻意保留）；
    ⑩ 动作取证（收口）：每个动作（probe/read-failed/correct/correct-failed/complete/recovered）
    落 renderer console + 机内 Local Storage 有界环（`dsh-chamber.authority-log.v1`，每来源 32 条、
    最多 16 个来源，跨重载/重启可回读）；**控制面集中日志面**（renderer 可写 verb 或经 notify 通道落
    sidecar/native 日志）未做——可选增强，真机取证已可按上方环回读；
    ⑪ **两处「更省形态」候选未落地**（下轮首选；三轮复核把论据改写成硬约束，免得照旧方案重做踩同一个 race）：(a) 挂到 App 每 30s 兜底 unary pull 的提交点——
    ① 挂载源的 `aggregates` 会被 producer push **整块覆盖**（push 与 runtimeFacts 同源于官方 store ⇒ 两份事实不独立，卡住的 running 会被写回）；② push 会作废在途 pull；③ 该 pull 只在源 stale 时发生，推流存活的源根本不拉——故它只在「源完全静默」子场景成立，覆盖本缺陷必须另加旁路采样面，净省 ≈450–500 行。(b) 用官方 store 自己暴露的 `state`/`phase`/`error` 替代独立 unary 探针以省一半 host 调用——
    读 vendor 源码**否掉**：`projectList()` 只把 ids/byId/current/phase/subagentsByParent/
    jobsBySession/currentAddress 写进 store 快照，**`state`/`error` 不暴露**（`phase` 是到达生命周期），
    故探针是「refresh 是否真的把位回灌」的唯一证据面，必须保留；该成本改由 ①b 的本地判定
    （store 已无 running 行 ⇒ 本轮不发探针）收回。
    失效判据 = 任一形态落地并删掉相应生产端通道（并补上被删面的等价证据），或复核确认现形态更优并写回 design 14 §D4。
     ⑫ **对话流健康臂（design 14 §D4）的实机验收未做**（治因已由 ⑬ 的 fork 补丁承担，本臂只兜 `ended(false)` 等剩余终局）：自动 stage 迁移重开
     （`error` 满 8s、冷却 120s、滚动窗口 10 分钟 ≤3 次；已执行的 heal 过 settle 窗仍
     `error` 即 latch「对话通道未恢复 + 重新加载」按钮——判据是 settle 时钟而非相位，
     `loading` 驻留不清 latch）与 `loading` 20s 提示阈值均只在
     headless 复现与单测里验过，未在真机抖动下校准（杠杆所依赖的三条 vendor 事实已由
     `test/session-health/vendor-heal-contract.test.ts` 锁住：pin 升级若改了 stage/open/error
     语义，该测试即红，届时恢复臂须重推而不是静默失效）；`error` 的自动重开还会让聊天面重挂载
     （滚动回尾）——是否需要「保持滚动位置」取决于实机观感。失效判据 = 真机拆链后自查恢复
     该臂的动作**只呈现在 chip 上**：包内既有 ui-lock 源文本锁禁止 `src/client/**` 出现任何
     `console.*`，所以它与 ⑩ 同源、仍无落盘面；`presented` 判据是 document 级 `[data-chat-flow]`
     **存在性**（非「实际可见」，多实例壳下可能把隐藏实例的 ChatView 也算作已呈现——放宽只让动作多
     发生一次，收窄会静默废掉恢复臂，故刻意取宽；失效判据 = 确认隐藏实例的 conversation 树是否常驻
     DOM 后改为按实例判定）；stage 迁移有前置条件：target 必须仍是 **current 且在列表**，因此
     address-only 子代理会话与 masked gap 都不能走 stage 迁移（设计取舍，不是缺陷）：两者都保留「重新加载」，address-only 另有下述用户触发的 resync 兜底；masked gap 只留「重新加载」；新增**用户触发**的「重建对话通道」控制（具象 `Session.resync()` 能力守卫、计划只 arm、点击唯一执行、与自动 heal 共用 cooldown + 滚动预算），在 `loading` 停滞与 address-only（current 但未 listed）的 `error` 两臂都可用（error 臂 armed 时同时给出 `heal-failed` 提示，chip 的动作区才渲染），不再只剩「重新加载」；`neighborAvailable` 同步收紧为 current ∧ listed ∧ 有邻居。失效判据 = 真机拆链后自查恢复
     且判据写回 design 14 §D4。
     ⑬ **静默半死（`openState === 'open'` 而事件不再投递）**：起有 fork 级杠杆——静默 ≥45s 开旁路 sibling follow（20s 期限）只比对 opening cursor，**仅当宿主确已前进**才替换物理世代（design 14 §D4）；不设形状超时（合法长静默 TTFT 75s 起、工具可数分钟，盲超时必然误报）。治因（fork 载波重试不再终局）与信号面（`dsh-chamber:stream-carrier-failed` 页面事实 → 健康臂 chip「对话流正在重新连接…」）属已实现基线，契约（含拒绝替代）见 design 14 §D4。**仍未闭合**：①宿主侧流级 keepalive+游标未做；⑤首帧期限（30s 起，连续超时 30→60→120→240→300s）与探针阈值（45s/20s）未经真机校准；②真机抖动验收（判据 = 拆链后 `openState` 不落 `error`，且 churn 提示在真实 mux 抖动下出现并自行消退）；③churn 提示窗口（10s）与「按来源而非按会话」的粗粒度归属均未经真机校准（多会话同源时提示会同时出现在该源各会话上——刻意接受）；④`ended(false)`（正常结束而未收下 opening item）仍是终局，由健康臂兜底。失效判据 = ②③任一校准或裁决落地并写回 design 14 §D4。
    ⑭ **彻底修复链（tier-1.5 本地判定 + 权威相位 + tier-3 写回，design 14 §D4 ①b）的未闭合项**：
    ① 写回押在**非 `ISessions` 契约**的 `ClientSessions.handleSessionStatus` 上（运行时能力守卫 +
    接线锁已就位；pin 升级移除/改名即降级为 WARN + 升级阶梯）；两个上游诉求（store 快照暴露
    `state`/`error`；把该写面提升为契约）已写入 `docs/progress/todo/upstream-proposals.md` §4。
    ② 未挂载/已回收来源没有 producer ⇒ 不在守卫输入内（其事实由 30s unary 兜底直供，本来就是权威读）：
    保留视图按 90s 界限清位（design 05 §2.3；复用会话停滞横幅，三条出口同权）；
    该界限**只在失败拉取分支里求值**（隐藏窗口/未到期的轮询不触发），残余 = 真机上「宿主其实仍在跑、
    读路径坏掉」时用户会暂时无环；该出口只对**仍持有壳**的来源有效——已回收来源的「重新连接」是 no-op（可靠出口 = 「重新加载」/「忽略」），未经真机判。
    ③ 门槛/预算（60s L1、190s 等回执、N=2 两次串行探针）与写回链的端到端时延、远端（ssh）实机
    行为未跑（与 ⑥ 同批）。④ 两处已知窄缝：probe→写回之间可能有**新的**宿主 `running=true` 落地
    （与该 id 的旧位不可区分，下一轮 L1 自愈，≤~200s）；`refresh()` 方法面缺失仍按永久失败结算
    （不进权威相位）⇒ 该构建失去唯一的仓内纠正路径（上游契约若移除 `refresh` 须重裁）。
    ⑤ App 侧与 producer 侧另有若干不变量**只有源码文本锁 + 纯函数单测**（无 DOM/React 环境跑
    行为测试）：恢复路径的「记水位 + 撤标记」、dismiss 剪枝、来源退役清理、探针的两次独立读、
    N=2 接线、未覆盖的 running 行 ⇒ `unknown` 的判定（五轮复核补齐了其中原先缺失的
    三条锁）；真实交互待 build 后的浏览器车道回归。
    ⑥ 写回相位的 5s 上限之外仍有一处窄窗：`correct()` 若慢于上限，回执可能已按 `unknown`
    发布而 store 已被写入（写幂等、无二次写，下一轮 L1 的 tier-1.5 即收敛）——真机未观测。
    ⑦ 「官方基线里消失但移除事件丢失」时，侧栏行会被下一次 refresh 清掉，而**物化 Session
    的聊天面 running 位**可能留着（`refreshList` 只对仍在 summaries 的会话下推 running，
    移除靠事件）——仓内无纠正入口（缺失行不作证），登记待上游或真机。
    ⑧ 保留视图的 90s 界限只清**聚合**的 running 位，不触碰 producer 的 runtimeFacts（蓝点/
    通知边沿仍可能读到 running）：语义由守卫横幅与对话流健康臂覆盖，但两者口径不同，真机未判。

- 渲染进程在 JavaScriptCore 崩溃 → 静默整页重载（实证）：WebContent 在代码块替换/JIT tier-up 路径 trap 或空指针（EXC_BREAKPOINT `WTFCrashWithInfoImpl ← CodeBlock::setOptimizationThresholdBasedOnCompilationResult`；EXC_BAD_ACCESS 0x78 `ScriptExecutable::newReplacementCodeBlockFor`），入口为 **rAF 回调内被 OSR 编译的热函数**（当前构建 2 份报告，分别在页面加载完成后 **21.0s / 33.9s**）与 **嵌套 async generator 驱动链**（更早构建 8 份）。崩溃后 shell 秒级重载（`渲染恢复（crashed），0.50s 后重载（1/3）`）→ 页面重新 boot → 用户看到「载入历史…」+ 20s 健康 chip；10 份 WebContent 报告里只有 2 份留下 shell 侧 `crashed` 痕迹，其余静默——这是「有概率一直加载历史」的第二个独立机制，前几轮流层兜底修不到。**未闭合**：①JSC 崩溃是引擎缺陷（WebKit 22625），仓内只能收敛触发面与可见化，**不能消除**（收敛项见 design 14 §D4「第三次排查」；壳侧归因见 design 25 §5 E19）；②vendor 侧自身 rAF 循环（chat/conversation/layout/trajectory）未收敛；③崩溃→静默重载缺用户可见提示（当前只有日志）；④页面事实的持久消费面仍缺（见下方「会话打开停滞」残余项 ⑥），本次仍靠 Apple 崩溃报告 + `shell.log` 事后对齐；⑤ 10:19 那次**没有**崩溃报告的流层卡死与本次是两个独立机制（见下条），各自未闭合。

- 会话打开停滞（「载入历史…」永久停留实机）：大会话（`session-28e9eb86`）经gateway打开只显示 `chat.loadingHistory`。根因未证实（宿主侧实测健康：经代理 `$events` 就绪 25ms、普通快照 57ms、已结束子代理快照 73ms）；唯一同构状态 = mux socket正常而 `session/follow` 逻辑流永久无首帧，客户端侧已有 fork 首帧期限（30s 起，连续超时 30→60→120→240→300s）+ 开帧发送前校验（design 14 §D4），宿主侧仍无；收口需设备侧帧证据（CDP WS Frames/抓包），入口 `mobile-walkthrough.mjs`（`mobile-ws-frames.json` 落盘前脱敏）。插件侧「停滞提示 + 主动重载」兜底（`session-stall.ts`）判据全为属性锚点，45s阈值未经真机校准；桌面侧同形兜底 = `session-stream-health.ts` `loading` 臂（20s阈值，同未经真机校准），另加 `error` 臂自动stage迁移重开（见 ⑫）；形态取值/误报边界见 `session-stall.ts` 头注与 `README.md`「Anchor baseline」。客户端侧已有开帧校验 + 首帧期限（30s 起，连续超时 30→60→120→240→300s；design 14 §D4）；追加**静默载波升级**（首帧期限到期而当前 socket 一帧未收 ⇒ 走 `replaceSocket()` 换掉物理 socket；teardown 分支：任意逻辑流在其整个生命期内该 socket 零帧且生命期 ≥ 共享表 `SILENT_TEARDOWN_MIN_MS`=15s ⇒ 同一条 `replaceSocket()`，覆盖「20s 探针 abort 早于 30s 预算」的已开启会话形态；第二个入口：同一请求连续第 2 次超时（socket 仍在供帧 ⇒ 零帧判据不成立）也走同一条 `replaceSocket()` 重建载波，由 `shouldEscalateOpeningStall` 以 60s 冷却限速。专治「浏览器视角 OPEN 而载波静默」这一类——判定阈值未经真机校准，误报代价 = 多一次载波重启 + 基线重放；`socket-silent` 事实的持久消费面仍缺，宿主「socket 活着但 follow 永不回答」仍只能靠座席出口）；另有一条**同症状的 vendor 窄缝**（仓内不可修，仅登记）：`Session.doOpen()` 只把 `isRemoteFailure` 的错误写成 `error`，非 RemoteFailure 抛出、或 `events.open()` 成功返回时 `openGeneration`/`events` 已被推进（dispose/resync 竞争），都会**静默 return 且把 `openState` 留在 `loading`**，而 `followCurrent()` 只在 stage 移动时才再次调用 `open()`——恢复面因此仍只有座席出口（真机未观测到该分支，判据 = 事故后能在 renderer console 里把「loading 驻留」与「open 抛错」对上）。追加座席**证据门自动重建**：`loading` 且 probe 读到具象 `openPromise` 为空（无在途 open）⇒ 自动 `resync()`（共用同一 cooldown/预算账本），在途 open **绝不打断**（慢宿主）；`loadingFailedMs`=90s 后提示改为「会话内容未载入」并保留重建/重新加载，手动出口不再受账本约束（design 14 §D4「进入会话必须收敛」）。**仍未 100% 的残余 = 宿主侧**：`session/follow` 无首帧期限、`doOpen` 可把 `loading` 静默留下，两条均已登记 `docs/progress/todo/upstream-proposals.md` §4.3/§4.7；阈值 90s/20s 与载波升级阈值（零帧、连续 2 次超时 / 60s 冷却）未经真机校准；移动端 `session-stall.ts` 已接同一证据门自动臂（`sessionStallFace` 读具象 `openPromise`；触屏档无 chamber fork ⇒ 载波层升级不覆盖该档，其恢复面 = 该自动臂 + 手动重载）。`loading` 卡死另有座席「重建对话通道」用户出口，不再只有 ⌘R。（同族见上方「会话运行位卡死」与design 14 §D4；本首帧期限与之同缺口——上游提案见 `docs/progress/todo/upstream-proposals.md` §4。）

  **仍未闭合（复核后）**：① **触屏档无载波层**：桌面「已开启会话的载波半死」已由 teardown 升级收口（任意逻辑流在 socket 全程零帧且生命期 ≥15s ⇒ `replaceSocket()`，design 14 §D4），但移动档跑实例自带客户端栈、没有 chamber fork ⇒ 首帧期限与该升级都不存在，其载波半死仍无页面级恢复；桌面 `open` 臂在那 ~20s 窗口内也没有任何按钮（静默 socket 不发 carrier-churn 事实）。② 承载 `loading` 观察的 header 内容在 `session.blank && phase==='blank'` 时上游不渲染 ⇒ 该子形态可能既无 chip 也无出口（静态链路已核，待真机判定）。③ 移动端产物缺 source↔artifact lockstep 断言（先例见 `official-hover-card.test.ts`）：C8 门抓到一次真实过期（`lib/client.js` 未随 src 重建）并已由重建提交修复，断言本身仍缺。④ 开帧预算键是 32 位 FNV（约 16 万次抽样一次跨会话碰撞，只共享预算不等价）。⑤ 不可 JSON 序列化的 payload 让 `open()` 抛 TypeError 而非 carrier 类（「载波永不终局」的例外，生产不可达存疑）。⑥ `socket-silent` 事实的持久消费面仍缺。⑦ `presented` 是 document 级近似（renderer 非活动来源靠 CSS visibility 保活 ⇒ 隐藏实例的 chip 仍满足 presented，可能对用户没在看的会话执行 auto-resync/stage 迁移，账本有界 1–3 次/10min）。⑧ **设计未决**：unary 引导通道（`session/control` baseline `asOfSeq` 作合法 `throughSeq` + 冷读 `session/page`）是否新写成兜底内容引导——本轮未采纳（救不了宿主卡死、属非契约窗口写入面），见 design 14 §D4 与 `docs/progress/todo/upstream-proposals.md` §4.3。

- **本地实例 mux 周期性抖动（实测，触发源未钉死）**：
  `<stateDir>/logs/control-plane.log` 3 天 233 次 `WebSocket stream local closed`；09:04:44–09:10:56 七分钟内 15 次 `browser close`、寿命 17.4–21.1 s（远端实例同时段 socket 活数分钟），且 09:03:48 WKWebView WebContent 崩溃自动重载后进入该节奏。同一宿主经控制面代理实测：`$events` 就绪 25 ms、普通会话快照 57 ms、已结束子代理快照 73 ms ⇒ 抖动既不是握手慢、也不是宿主不答，而是页面侧每次 generation 结束后 `RemoteStreamMuxClient.reconnect()` 关掉该 socket 上全部逻辑流（本地 15s readiness 期限 vs 远端 45s override 的差异与之相符；触发源仍需 `dsh-chamber:stream-forensics` 真机回读钉死）。
  已落取证事实 `dsh-chamber:stream-forensics`（socket lost/reconnect/disposed、opening-timeout、generation ready/lost，design 14 §D4）。失效判据 = 一次真机回读把触发源定位到具体调用路径，且修复后该节奏不再周期性出现。

- 上游装载面三项待办（只登记，不改upstream）：① `dsh-client-modules` 的 `compose()`把全部非bootstrap行打成application批次、只按URL 3 KiB切分（不按字节）⇒ 首屏~10.65 MiB响应（`ui-sidebar-documentpreview` 内嵌PDF.js占6.57 MiB）；懒加载需连带chunk供给方案（combo URL下发时相对动态chunk 404；chamber `seedFiles` 也带chunk）——低优先级，不裁功能；② `ui-subagent` 的 `SubagentHeaderLineage` 类字典缺 `count` 键 ⇒ 计数span无class、仅靠继承 `nowrap`，应补class/nowrap；③ 会话打开流应加首帧超时、失败落成可见错误态（现永久loading）。

- **受管dsh应用日志取证（opt-in，默认关闭；启用见 `gateway --help` 与 `host-log-bridge.ts` 头部）**：真机启用验收（未对运行中网关实例端到端；boot耦合「加载失败即spawn失败」——profile多一行loader row）；隐私代价：日志可能含会话内容/prompt/路径，脱敏仅覆盖 `?token=`/`&token=` ⇒ 共享主机不得长期开启；`warn ⊃ info` 单调阈值易误读；仅本地web-profile spawn，不含desktop远程SSH。

- Windows首版（design 23）：剩余全为外部门禁，台账 `docs/progress/todo/windows-v1.md`：Windows runner首跑绿（test-windows腿；submodule物化 +
  junction建链）；M0.5上游dsh win32/NSIS protocols/Defender/原生依赖实证；M2a runner事务矩阵；M2b UI翻转（纪律：M2a真实win32全绿前不做）；M3/M4实机矩阵与打包验证；M5/M6发布面决策/演练待发布前。

- Linux桌面（design 22）：剩余实机门禁按 §7清单（GNOME X11+Wayland/KDE抽验：XDG自启、深链冷/热与
  CHROME_DESKTOP/xdg-mime路由及升级后重注册、托盘/通知点击、safeStorage keyring、SSH密码全链、运行时打包态全链、自动更新端到端、AppImage沙箱与Wayland焦点；另复核before-quit无头挂住）；release.yml dry_run全链（需GitHub可达）；deb/arm64后续；未动项见design 22 §5。

- 桌面通知 / 未读徽标（design 19）：通知剩余macOS权限/拒绝行为的打包态实机走查（见design 19 §3.3/§4.1）、点击打开、关窗/托盘/后台三形态；徽标剩余macOS Dock打包态三态（武装/解除/退役 + 重载与退出清零）实机；Linux仅Unity launcher家族可见；Windows任务栏overlay已接线能力位（`supported.badgeSupported` 在 win32 为 false，设置页据此禁用并给出原因），其实机可见性随 design 23 M3 矩阵复核。

- 会话待办区（design 06 §8）：剩余实机门禁——通用页开关即时生效、同源/跨来源/未常驻跳转与权威移除、折叠来源中目标、断连→重连重现、rail不渲染、「还有N项」展开/收起与自动收起、展开内滚动（8行上限）、拖拽尾随点击不误开、同会话内联重命名不打断、打包态。

- open-in超集分批口径（复核裁决，design 20 §7.2）：裁决：S3收窄为「复制路径」（侧栏悬停卡复制：`ServerSection.tsx:2088`/`copyText:2107` 复制会话标题而非路径；`SessionRow.cwd` ⇒ 零新IPC、纯渲染层）；**复制 `ssh user@host` / VS Code深链与S4（侧栏入口、快捷键）不做**——header按钮与目标会话同排、会话行动作已全在kebab菜单（`ServerSection.tsx:1952-1977`；无kebab的是worktree派生workspace行，`:1288-1290`）、快捷键缺vendor keybinding基建；完整形态留档 `docs/progress/todo/open-in-superset-batches.md` §3附录A/B。

- VS Code深链 + open-in（designs 16/20）：剩余macOS实机验收——深链冷/热启动、打包态、托盘/退出在途、N-ctx、VS
  Code缺失、`sshPort != 22`、本地应用下拉在vendor会话头部定位/层叠、远程来源仅VS Code（新窗口/复用两态打包态确认）。

- Git Worktree插件（design 08）：剩余真实远程Linux + Git仓库端到端（首次ready-time seed后重启生效、并发
  session删除竞态、Git LFS/filter与恢复边界）；实机验收——运行中会话（未归档）→ 删除被拒并给出诚实文案；同会话归档后 → 工作树删除成功且该会话未被停止/删除、其cwd消失后日志仍可读；运行中子代理位于已归档根下 → 不阻塞。

- 远程实例插件管理（design 13）：本地 `dsh plugin`/`pnpm pack` 依赖 `resolvePnpmBinDir` 对PATH/nvm/volta/homebrew
  探测 ⇒ 需打包态实机。剩余验收：四来源chamber表行数（注册表4行：client-graph/git-worktree/archive-cleanup/open-in；open-in为 `localOnly` ⇒ 本地4行、远程/gateway/http 3行；该行不参与ssh needs-seed/restart门，不进注入预检/远端日志/桌面侧gateway
  上传源清单（`portableChamberHostPackageSeeds` 唯一判定；白名单 `SYNCABLE_HOST_PACKAGES` 仍含该行，design 20 §9 / design 17 §10.2；缺行时「注入」可成功）、远端注入未生效显示「重启生效」、ssh本地列不再恒「未知」）、archive-cleanup的installed/patched/live三态与「注入/重启」按钮、gateway seed-cache漂移列。

- 会话创建/fork/归档的侧边栏收敛修复（会话回声 + 归档墓碑真机反馈；design 05 §2.2.1）：唯一出口
  `shared/session-mutations.ts`（`withSessionEcho`、`withPendingArchives`、官方session-list）。剩余本地/远程SSH实机验收：① A会话点B workspace「+」或对B fork：侧栏 <1s
  出新行（blank随current、fork子行按普通行）、居工作区头部、不「先落未分组桶/尾部再跳位」；② 归档B旧会话（B未挂载）⇒ 行即消失、不留可点空视图入口；③ 权威归属/归档集到达后无重复行，切走切回/刷新后仍一行；④
  别处变更与归档墓碑租约到期（10min无观测）回浮的行仍需点开该来源才收敛——已登记整源降级面。

- 打开意图 / 工作区回声两项真机反馈的实机验收（design 05 §2.2.1）：① 本地会话点远程来源会话行：揭幕期只显加载层、无高亮「新会话」行、不切新会话主页；② 远程来源新建工作区（来源头「添加工作区」与workspace行尾
  git「创建worktree」两入口）：该分组下 <1s出新行、同目录无第二行，git入口行落主checkout之后、首帧即worktree形态；③ 温壳切换无多余加载层（幂等重开保持高亮）；④ 冷boot连点同一来源两会话只打开最后点的（不回翻）；重命名/拖拽/归档管理器/通知/深链/git adopt照旧。**阶段0插桩（dev构建 +
  临时日志，不提交）**：包装 `sessions.open` 打调用栈+`performance.now()`、打印 `runtimeFacts[id].current`、看 `localStorage['dsh.sessions.current']`；期望冷boot先 `session.create` 后目标id、早开臂抢在
  `session.create` 前、投影门窗口内「新会话」行不入列表。若早开臂从**不能**抢先，`client/early-open.ts` 可整体拆除（独立effect + 测试），只保留投影/揭示两闸门。

- 发布/CI基础设施：test job抽reusable workflow供release.yml复用；vendor submodule剩余验收（Windows runner物化 +junction建链、CI真跑、release.yml改动后workflow_dispatch
  dry_run）；Gateway npm分发未决策（现仅GitHub Release `.tgz`）；打包闭包自检（CI加「主进程传递模块闭包vsbuild.files清单」机械检查，长期建议）。

- 性能遗留实机清单（P0–P2 + 第二阶段A/B）：五条实机复测全开放（打包版/带会话dev实例）——①曾拖宽侧栏实例冷
  settle veil失配/CLS；②连点 ×10冷挂载切换的单槽收敛 ≤2节；③版本事务sample主进程无同步全树冻结；④更新模式侧栏写频T4防抖250ms窗；⑤H3懒加载两段结构长任务真机复核；入口 `scripts/perf/`。第二阶段（视图保留/后台门控/行窗口）同环境A/B：`measure-ui.mjs`（DOM分壳/堆/空闲长任务/合成输入帧/预热壳数）+「打开→切走→重开 ×3堆无净增长」。验收目标：全视图DOM ≤13,000（按 `dom.perInstanceNodes[]` 分壳对照）；JS堆无净增长且随视图数线性下降；×3堆无净增长；空闲15s无 >100ms长任务（首启基线收割窗口不计入）；合成输入帧间隔无 >500ms；预热1壳且仅前台（与基线收割共享唯一槽位）。已知取舍：回收壳内运行中任务的完成蓝点/通知边沿暂停至该源重开（60s安全窗 +
  `RETAINED_HIDDEN_VIEWS=1` 限制损失面）；被回收源聚合降级到既有30s unary兜底（05 §2.3）。证据 `retention.ts`、`App.tsx`、`measure-ui.mjs`、design 05 §4。

- Swift原生壳性能整改的实机同环境A/B未闭合：启动t0→首帧 / 大载荷invoke p95 / 空闲wakeups的同环境A/B仍需打包态实例。观测入口 `macos/Sources/DSHChamber/ShellPerf.swift`（`[perf] boot …` 行）与 `DSH_CHAMBER_SHELL_DEBUG=1` 的 `[perf] invoke` 行；A/B纪律见 `scripts/perf/README.md`。

- B桥出站帧护栏的范围边界：出站4 MiB门只覆盖产品入口 `packages/desktop/sidecar-entry.ts` 的
  `writeProtocolLine`（`node-edges.ts` 的 `MAX_PROTOCOL_FRAME_BYTES`，与入站P-01同源）；POC桩 `packages/desktop/sidecar-stub.ts` 仍裸stdout写，只服务测试夹具（`BridgeClientIntegrationTests`）。证据：全仓 `process.stdout.write` 审计——产品路径仅 `writeProtocolLine` 内not-serializable / too-large /
  backpressure三处回错帧 + 一处正常写，均在出站门与有界缓冲内。

- sidecar的console通道退化：`sidecar-console-redirect.ts` 把可能写stdout的console方法钉到stderr；
  `count/countReset/group/groupCollapsed/groupEnd/time/timeLog/timeEnd` 退化为普通日志行（不维护计数/计时/缩进状态）。`assert` 已恢复Node语义（仅首参假时打印，带Assertion failed前缀）。仓内无调用点；要用需改带状态实现。证据 `sidecar-console-redirect.ts:45-70`。

- B桥协议写端的验证面：出站帧门、快判与有界缓冲（8 MiB字节 + 4096帧/轮双上限，拒发回帧每轮 ≤64条）只在本机做
  真解析门（`stripTypeScriptTypes`，见 `sidecar-stdio.test.ts` P-03）+ 逐字运行时探针（`node --check` 对ESM .ts静默no-op，不可作门；门：恰4 MiB放行 / +1拒绝 / 无id零写出 / 多字节中间带走精确路径；缓冲：300k小帧排队恰4096帧、RSS 100k→300k持平、SIGTERM立即处理；edge帧拒发node内直接reject，不等30s/660s超时）。CI `sidecar-stdio.test.ts` 仅静态锚点断言，行为级用例仍缺（补用例需能暂停stdout消费的夹具）。

- SSH密码一键免密引导与系统钥匙串（05 §8）：未实现（现行为endpoint-bound 0600明文镜像，见取舍）。

- 模型额外参数 + 默认推理等级（design 07）：wire白名单无泛化透传、host组合不可注入——待上游解锁；
  `agent-default-model` 客户端可读可写（`settings.describe` 不过滤namespace，旧 `exposedNamespaces` 在当前pin已不存在，见design 07 §2.4），回显/设置入口不在本蓝本范围，实现未排期。

- 跨边界诊断文案：框架那一半已本地化，剩下的在框架之下（轮；范围按review-fix F4b收窄，未排期）：框架渲染的chrome文案（`renderer/src/locales.ts`）与别包渲染、框架拼好的三处（`App.tsx:455` 经 `ServerSection.tsx:1257-1262`；`App.tsx:2754`/`:2783` 经 `reportOpenSessionOutcome`；`:2818` 通知重放拒绝文本）已本地化。仍开放：`{detail}` 装框架之下文本（`shell.ts` 打开失败诊断与dsh
  运行时错误），无locale席位 ⇒ 英文文档下该从句仍中文（`App.tsx:2774-2782` BOUNDARY注释）；对齐 = reason code协议 + 渲染包侧映射。增补：框架之下只剩活动视图横幅诊断行（`.boot-gap-detail`，产出方中文原文），不翻译不解析。

- 变更文件覆盖率门未接：`scripts/gates/run-checks.mjs` 的 `tests` 模式是每文件一个 `node` 子进程，V8覆盖率须跨进程合并，而仓内无 `c8` 类工具、新增devDependency需显式请求。待裁决二选一：引入devDependency或把runner改成单进程 `node --test`（动到现有进程隔离语义）。

- 根级弹性回弹（deviations S-50）：仍open = 打包态 `.app` 实机走查（顶栏、会话栏顶部、内容区中段、内容区两端；含滚动/惯性/键盘/滚动条/缩放/拖拽选择无回归）与最低支持版本macOS 14.4复验；Electron未同步属双flavor有意差异（S-50 ①，accepted，理由见该行）。

- 远端完成未读 / 切源体验（design 17 §10.7 只读镜像 carve-out；实现面已闭合，仍开放的是实机/CI 权威）：
  ① 实机矩阵：`node scripts/perf/measure-ui.mjs`（`prewarm` 命中率与 `watcher` 字段）、
  `node scripts/perf/switch-measure.mjs 2 --require-switch`（未绘制目标实例即失败）与白屏/切换目检序列，需打包态 Electron + ≥2 可切换来源；
  **实测的精确阻断点**：没有带 CDP 的 Electron 实例——`curl http://127.0.0.1:9333/json/version` → 000，
  安装态 `/Applications/dsh-chamber.app` 为 Swift 原生壳（无 Electron/asar，结构上无 CDP）；`ws` 经
  `NODE_PATH=<sidecar>/vendor/dsh/node_modules` 已可解析，不再是阻断。同一实测下**已跑绿**的只读腿：
  `node scripts/gui-acceptance/run.mjs --live --out /tmp/gui-live` → 25 pass / 0 fail / 26 checks；
  ② W6 无壳观察者实机：真实 SSH 远端 + 关闭该来源的壳后，完成仍落蓝点/todo（无壳可观测）；
  ③ W8 双版本实机门：旧版 gateway + 新版桌面同跑，验证 404 / 503 `session_state_disabled` / 无 `protocol` 三种降级形态。
  **已实测一半**：本机 6 个真实 gateway 来源 `/chamber/runtime/status` → 200（进程活着）而
  `/chamber/session-state*` → 404 `not_found`（= 本次改动前的构建），本地 dsh 来源 → 404 `capability_not_found`；
  即「404 = 版本事实」这一形态已在真实部署上验证。**仍缺**：503 `session_state_disabled`、
  「2xx 无 `protocol`」两种形态（仅夹具验证），以及**新版 gateway（带镜像）**与新版桌面的端到端联通；
  ③a W7 上游提案的**提交与跟踪**：仓内文本已落（`todo/upstream-proposals.md` §6 四项），但向 GitHub 提交/跟踪需外部凭据 未做——
  出口判据已改为「仓内提案文本」，提交属开放的外部动作；
  ③b R12 的**真机 abort 样本**仍未捕获：`aborted+cause=user`（用户停止不得产生未读）目前只有夹具样本，
  真机无该样本时应判 **INCONCLUSIVE 而不是 PASS**（不得用中立项或夹具样本替代；负例判据见 `packages/renderer/test/session-state/unread-derivation.test.ts:60`）；
  ④ 移动端 scoper 产物绿：需 `build:renderer` 产物（`packages/dsh-chamber-client-ui-mobile/scripts/assert-scoper-artifact.mjs`；
  无产物时该守卫 exit 1 并写明前置，已实测）；⑤ vendor 树 lockstep：需物化 `vendor/harness-packages`（CI 的 `ensure-harness-vendor` 前置）。
  另四条开放验收（同属实机/CI 权威）：⑥ W5 跨端已读的真实双客户端 E2E——两端单元均 live，但缺两个真实 clientId 的端到端对照；
  ⑦ 场景级时序判据（`t_c + 2s`、≤2s 等）目前只有单元/纯函数代理，没有场景级执行器；
  ⑧ I1/I2/I5/I13 的 DOM 层断言现为源码正则 + 生产代码路径（本环境无 DOM），真判据在 GUI 腿；
  ⑨ `measure-ui` 尚无 `switchFrameMs`（该字段只在 `switch-frame-probe`），也没有同环境 A/B 基线落入 `perf/data`。

## 一致性债务与开放登记（低–中，未排期；均指回代码面注释/design 登记）

- **结构性重构与清理（未闭合；计划与实测证据见 [todo/refactor-plan.md](todo/refactor-plan.md)）**：
  核心指标 = 消除补丁式修改；行数删减经用户裁决**不强制**（仅参考，原 −9,000 指标作废）。
  机械化三门已落地：`verify:import-cycles`（值环 0；类型环仅 1 条显式 allowance =
  desktop shell-core ⇄ shell-ipc-*，须先拆 shell-core）、`verify:file-budgets`（15 个 God 文件
  只降不升）、`verify:no-dead-exports`（零消费者导出即红，含 desktop/renderer 的 entryless 面）。
  顶层 11 对 state/ref 镜像**全部收口**（roster/facts/echo/remotes/mounted/completed/view
  各为单源 store + 回归锁）；第 16 轮独立审计补掉 `watchdogRuntimeFactsRef`（第三个
  runtimeFacts 权威）并加固了 `verify-file-budgets` 的 schema/负控与 `use-deadline` 的
  stale/null 语义。旧版本兼容清理（第 18 轮，用户裁决「不保留」）：ssh 凭据 v1/v2 迁移、
  gateway-tokens v1/v2 + 旧兄弟文件迁移、catalog schema-less v1 迁移、json-store 的就地迁移机件
  （`migrated`/`backupDoc`）、`foldLegacyHostInserts`、`canonicalizeTransportInstanceInput`
  的 pre-v2 输入映射与 `resolveProvider` 的 legacy kind 键全部删除——非当前 schema 的
  凭据/catalog 文件 fail closed（保留 `*.corrupt`、响亮、要求重录），旧 `gateway-tokens.json`
  不再读取，registry 载入/保存要求条目自带当前 `kind`+`transport`（旧行响亮丢弃）。
  **未收口**：① renderer 外三处同类镜像（`sidebar-root-projection` / `InstanceView` /
  `DshRuntimeSection`）；② `ssh-<id>`/`ssh:<id>` 别名（design 17 §2.2 深链契约）与旧
  dsh/gateway 上游版本探测——经用户裁决明确保留。
  跨包逐字重复复核口径见计划 §6.1（31 组多行体，24 组为 3–5 行守卫、≥8 行 4 组全为
  win-probes parity 锁；既有约束下可删 0 组）。


- **测试运行器并发上限（未闭合）**：`run-checks tests` 的全局文件池默认 `min(8, 核数)`——同窗口实测 c12 文件总工作 217s vs c8 141s（每文件膨胀），吞吐收益递减，默认不动。并发暴露的两处**测试自身缺陷已根治**：`manager-api` 的「占满候选端口」改为整段区间重试；`sidecar-stdio.test.ts` 的固定端口（17910/17921/17922/17924/17926/17931）全部改为 `--port 0`（OS 分配 + ready 帧回传真实端口）——固定端口是跨进程共享资源，并发下 EADDRINUSE 会在 ready 前 exit 70（4 路同端口必现、6 路并行套件可复现；修复后 24 轮并行 0 失败）。仍未定位：`carrier-assembly.test.ts` 的 c16 零汇总。失效判据 = c12/c16 连续跑绿（或端口/资源隔离落地）。

- **消息来源判定依赖 `isMainFrame`：`parent.`/`top.` 上的 handler 会把子 frame 消息归属成主 frame（第三轮审查；真实 WKWebView 实测）**：
  同源 `blob:`/`about:srcdoc` 子 frame 调 `parent.webkit.messageHandlers.<name>.postMessage(...)` 时，WebKit 投递的 `frameInfo.isMainFrame=true` 且 `frameInfo.request.url` 为主 frame URL（归属随 `parent.` 取到的 handler 对象而非调用脚本；走 `self.` 时归属正确）——`macos/Sources/DSHChamber/MessageHandler.swift#ChamberMessageHandler`（A 桥）与 `macos/Sources/DSHChamber/MainWindowController.swift#ShellPageFactsMessageHandler`（事实通道）都受影响；加 `sandbox="allow-scripts"`（不含 `allow-same-origin`）后 `parent.`/`top.` 抛 SecurityError。
  同路子 frame 还可用 `parent.document.write(...)` 改写主 frame 文档，此后 `frameInfo.request.url` 保持**过期的旧主 frame URL**（读 frameInfo 的门据此被绕过），而 `message.webView.url`/`location.href` 变为 `blob:`——A 桥读 `message.webView.url` 故仍拒；事实通道的三个门（`#isSameOriginDocument`、`#acceptsReconcile`、handler `accepts`）按同一更严来源取值。
  可达性取决于「同源子 frame 内能否执行脚本」：`blob:` 非主 frame 正是 S-35 放行的预览形态、控制面 CSP 只补最窄 `frame-src blob:`；逐字 CSP 复现中 blob 子 frame 的内联/`'self'`/复制 nonce 脚本**均未执行**（机制未查清）⇒ 需真实壳（真实 CSP + 预览文档）复验；若能执行，根治 = 预览文档必须 sandbox（不含 `allow-same-origin`，opaque origin）或换源，登记并入 S-35 残余实机项。

- docs证据锚点过期（D15实测；低–中，未排期）：`docs/**` 的 `文件:行` 证据锚点实测743处（`check-anchors --report` 口径；666不可复现），分布deviations.md 493 / STATUS.md 117 / design 20 40 / design 25 37（**二轮 review 复测**：本树合计 **690**、deviations.md **443**——即历史快照与本 worktree 之间另有既存漂移；anchors-budget.json 的基线已按「只降不升」同步收到 690，见其 note 的对账口径。**整合后复测**：合计 **669**（deviations.md 429 / STATUS.md 109 / design 20 40 / design 25 38）；remote-status 分支并入 7 份计划/蓝图后实测 1275，预算同步上调。**progress 清理**：该 7 份已实施计划/蓝图删除后本树实测 **665**（deviations.md 421 / STATUS.md 111），预算按「只降不升」收到 665、零余量；收预算到实测值留给 D15 的批量语义化重锚那一批）；位移后大面积错位、偏移不均（同一文件净增128行，偏移 +5…+128）。工具：`check-anchors.mjs`（`anchors-budget.json` 棘轮，基线743只降不升；两次整合实测main 788c6d55 +4 / ui-chat-render-fix +8；`--report`/`--fix`）+ `verify-registry.mjs` 已进 `check:static` 与CI。测试面45处注释 + 4处非注释（3处runtime-lockstep标题 + 1处真实断言：`WebPermissionPolicyTests.swift#testMediaCaptureIsDeniedLikeElectronsPermissionPolicy`（D13）；夹具另7处命中（5个示例字面量）不计入；`--report` 打印 注释45 / 字符串10 / 断言或其它1）；需同步的测试锚点只有这1处。退役动作 = 待合并分支（timeout-loading / ui-chat-not-render / windows-slide / swift-sidebar-update等）落地后按符号grep分批语义化重锚、逐批调低预算；登记见 [deviations.md](deviations.md) D15。

- 设置面残余登记（design 05 §5完整桥接修订后剩余项）：壳渲染选中来源自己boot ctx的 `settings.section`
  台账与绑定标准座（`settings-source-face.ts`）。剩余：①面板要求该来源壳挂载中（`setSettingsTarget` 保证后台挂载/不被回收；代价 = 一次该来源boot，失败只显示不可达/启动中，无独立降级面）；②
  `settings.trigger/header/close` 属壳chrome、`settings.action` 仅本地；`settings.onboarding` 不再缺失；③ 组装诊断块退役（`toAssemblyReport` 已删；诊断在连接页
  `pluginDiagnostic`）；④ `contributes.settings` 等仍为上游提案（未排期，不再是前置），见
  `todo/upstream-proposals.md`；⑤ 完整桥接与首启阶段只经单测 + 源码锁 + `build:renderer`
  门确认，真实多来源/打包态冒烟待执行。

- 私有文件纪律三实现（cp `private-file.ts` 抛错式vs dsh-runtime `private-fs.ts` kind结果式，同名异签）——统一需依赖方向裁定（design 18 §9.1）。

- **`install-gateway.sh` 的dsh锚走npm安装（design 18 §4单一来源域外点）**：
  `scripts/install-gateway.sh:1180`（升级路径 `:1271`）以 `npm install` 装内建锚——npm无pnpm 11
  `strictDepBuilds`，不经过 `allow-builds.mjs` 单源裁决（另两个生成点 `runtime-installer.ts:1129`、
  `bundle-dsh.mjs:128` 都经 `renderAllowBuildsBlock()`）。触发：装到带安装期脚本的新依赖时放行/否认不可见；一致性靠
  `dsh-upgrade-checklist.md` 人工复核，无机械锁步。

- **`client-web` fork未使用依赖 `@deepseek-ai/dsh-client-ui-theme`（待锁文件窗口）**：
  `packages/dsh-client-web/package.json:29` 仍声明，但fork `src/` 引用已退役（token表改由 `renderer/src/styles.css` 引入）。不能**只**删一行：锁文件importer（`pnpm-lock.yaml:452` 起含 `link:` 条目 `:466-468`）不匹配会让frozen安装失败 ⇒ 删除须与锁文件重生成同批。

- **layout fork共享 `ThemePresenter` 永不回收**：`layout/src/client/index.ts:52-56` 模块级单例，teardown
  不dispose——有意（vendor `dispose()` 会收回全部文档级写入并抹掉活动视图调色板，`document-theme.ts:5-9`）。残留：末个壳卸载后文档仍留 `html{color-scheme}`、theme token与theme-colormeta。

- **`sidebar.workspaces` 声明但壳从不渲染（审查）**：`slots.ts:44-49` 声明、`src/client/index.ts:50-52` claim
  ，但 `SidebarRoot.tsx` 只渲染既有座席（`:1534/1556/1540/316/1684/1687/347`），浏览区由自有多来源列表取代occupant（`:1598`）。触发：第三方往该座注册——成功且无报告、页面永不出现。待裁：撤声明（不
  claim、让注册响亮失败）或在诊断面报告注册者；需slot语义裁定。

- wire载体（A–F）登记维持：P4-3 A↔C传输层合并裁定不合并（前置 ①–⑦，任一项未决前不动）；E（git-api）禁改（`wire-common.ts` 注，P4-1/2/3/N6）。

- sanitize语义矩阵（core/desktop/gateway/installer四成员）与win-probes↔windows-process孪生：互注无机械锁步。

- dashboard（gateway浏览器运维页）仍为独立第三份运行时UI，不共享sidebar的parse/poll核心（D-2，共享核心迁移列后续）。

- A-U3 desktop `SETTINGS_SET` 无busy/pending/env门（env维度放行为有意；busy/pending对称性待决策）；A-F16 `DSH_HOME`
  布局默认偏desktop。

- dual-host语义下沉延后：activation-facts/startup-verdict映射、restart拒绝织、apply-now门（整门合并不做）、
  identity-probe腿——仅3处以ruling注释登记（`desktop/main.ts:4360` ACTIVATION-FACTS DIVERGENCE +
  `gateway/runtime-manager.ts:950`、`runtime-probes.ts:390`），restart拒绝织与apply-now门无代码注记；统一需新
  dsh-runtime导出（dist锁）或行为裁定。

- 0.2.2审查跟进残留（低优UX）：会话行动作仍hover-only（键盘/触屏无揭示路径）；仓库组折叠 × 会话待办条带张力；
  chamber表最坏徽标组合窄窗可能横向撑破；en单数文案、行移除aria-label覆盖可见文本、行无 `<label>`、sshdone态
  stale行按钮可用、无PluginDialog DOM测试、对账空态双提示；settings-dshruntime：PUT registry成功不bump
  versionsEpoch、30s超时文案双层措辞、围栏/超时逻辑内联effect。

- **`test:gateway` 宿主服务隔离（实机定位）**：D2固定单元名属设计行为；
  `install-script.test.ts` 仍有2处直接spawn真实安装器（`--help`/`install--version`，当前只走用法/解析即退出），若未来走更远会再次逃逸；`03:16:06` 同签名停机未被钉死，01:22/01:35与09-07 23:45:29已解释。

- N-ctx文档级主题投影归属（design 06 §4.6）：剩余=打包态实机目检：首屏/视图切换/回收窗口checkbox深浅、预热视图不互踩主题（验收前须`pnpm run dist:desktop:mac`重打包）。

- 页面语言归属（design 06 §4.6）：剩余=实机目检——一次冷启动内`document.lang` 语言类变化≤1且必由屏上实例设置面敲定；预热/收割/后台壳boot期变化= 0。须`pnpm run acceptance:gui -- --dev`起隔离dev实例+ `MutationObserver`（≥1远程源）。另验：① 跨语言切换同一帧性——见陈旧框架文案帧即改取`owner.languageOf()`或该effect内强制渲染；② 持续未敲定降级姿态——`settings.describe`持续失败时namespace scope停`loading`（vendor镜像回`idle`），屏上实例用浏览器兜底值、页面停服务端默认（`zh-CN`）：刻意选择而非缺陷。

- 构建后回填（design 06 §4.6）：`check-chunk-budgets.mjs`的`chamberEntry`基线须在`pnpm run build:renderer`后重取样、回填脚本头部。

- Git来源分支候选（design 08 §4.2尾条）：剩余=打包态实机目检；unborn（零提交）仓库`branches`必空+默认base 40零直送git无preview门为代码面已知残留。

- **样式门 `verify:styles` 扫描面之外需人工纪律**：S1–S7只扫`packages/`＋`scripts/`的`.css|.ts|.tsx|.html`；两类不在覆盖内——① `docs/**/*.md` token引用；②包级`README.i18n.yaml`哈希记录（`verify:i18n`只管根目录5对；复核=逐包`sha256sum README.mdREADME.zh.md`对比，四个sha256包当前一致；改任一侧须同步另一侧并重录）。三种格式并存漂移；统一并入门禁是后续候选。

- gateway运维页失败分支不被夹具覆盖（review-fix F4b）：`dashboard-harness.ts:432-435`的fetch spy对未挂起请求一律回200，页面脚本`request()`非2xx分支（`routes.ts:316-326`拼`Request failed (HTTP <n>)`并挂`code`/`httpStatus`）无夹具驱动；失败路径测试改直接供给该分支产出的Error形状（`feature-lifecycle.test.ts:479-486`）；覆盖构造面需给夹具`respond`加non-ok能力。

- 归档保护「候选根闭包」方向缺一条测试（审查，低）：保护集只与候选根自己的子树闭包比对（design 24 §4 step 3b），被保护会话的archived子代若自身亦为候选根不会被祖先保护覆盖，可能被单独删除（合同单向性，非缺陷）；客户端也表达不出该组合（`sessionIds`必填）。缺口只在测试：两方向各有用例，唯缺「受保护祖先+其archived子代候选」——将来若开放无过滤清理、或让子代理行可选，先补这条锁再放行。

## 设计未决

- C15 hover 触发降级（提案，待CI/产品裁决）：把 hover 判据从每次 push 4 次调用降为 pin 变更 / workflow_dispatch / 升级清单触发；同批需改 `AGENTS.md:77-78`、`docs/checklists/upstream-touchpoints.md:4/§7`、`release-workflow-policy.test.mjs`（release 恰好两次 gate 调用的锁）、`static-gate-parity.mjs` 豁免表与 `verify-release-ci-proof.mjs` REQUIRED_JOB_STEPS。判据代码 0 删除。

- Electron / Swift双flavor接入点parity（八路逐函数复核 + 打包/引擎专项）：**仍open：S-01（外部门禁：EdDSA双密钥真实值、Sparkle编译证明、实机安装验收、增量delta实机验收——相邻版本走`.delta`、跳版本自动回退整包）、G19（CI内启动签名打包`.app`：凭据+ GUI会话）、S-44（Electron 43.4.0无授权查询/申请面；仅剩实机确认系统提示等价）、S-10（遮挡/App Nap无实测）、T-28（`corner-shape`超椭圆待vendor `ui-theme`裁决；裸`scrollbar-width`/`field-sizing`/`text-autospace`引擎降级已登记）；核验清单（启动恢复、打包态冷启动首载复验（宿主不占用17500）**、首帧时序、beta真机下载安装、坏密钥页面态、Sparkle节奏、ATS loopback、登录项回读、工具链native gate的WKWebView段、隐藏/遮挡态）见§4；登记`docs/progress/deviations.md` §1/§3/§4，可达性纪律与盘点见 §6。

- 原生窗口高度折中待裁决：Swift内容区1280×786（外框~814）对Electron外框1280×800（视口772）各偏~14pt；单侧对齐（原生取772，或Electron开`useContentSize`后同取800）未决。登记deviations.md S-49；宽度偏好仍per-flavor页面存储（T-18）。

- macOS Swift原生壳（design 25，路线A）开放门禁：D1–D7未走形式签核，M5未闭合。剩余：① **实机/GUI验收（打包`.app` +真实实例）**——打包态冷启动首载（宿主不占用17500）、同bundle二次启动的单实例流程、通知权限时机与点击激活会话、SMAppService登录项、LaunchServices深链冷/热启动、关窗隐藏与恢复、唤醒补发、ATS loopback、最小化/被完全覆盖与App Nap语义（S-10），及WKWebView无`backgroundThrottling:false`等价物下的SSE/WS心跳与恢复（design 25 §8.1 C1/C2、§8.5 W1–W7；判定标准见`todo/macos-swift-v1.md` §七）；② 凭据/ runner-only发布证明——Developer ID签名、公证、stapler、spctl各臂与arch（lipo）断言实跑，及首个正式`build-swift`发布腿（release.yml已fail-closed；缺Apple凭据=外部阻断，design 25 §7/companion A6）；③ M5实机矩阵——W-28（打包态全链矩阵）…W-32（R1–R13复盘+ D1–D7复核）未执行（W-29 W1–W7逐项判定、W-30双端性能/体积对比见companion §七/WBS）；双端harness未实施（`swift-harness-driver.test.ts`，需mac+GUI）；④ 零core消费者契约面有意保留——`resolveResource`/`isPackaged`/`notifyClicked`/`trayAvailable`/`focusMainWindow`/`launchApp`与HostEdges同步`setKeepAwake`/`setLoginItem`在`desktop/shell-core.ts:679-762`只有声明与doc、无调用点——flavor契约，非死代码；⑤ **`BridgeClient`事件帧入站面保留**——`onEvent`（`macos/Sources/DSHChamber/BridgeClient.swift`的`onEvent`声明、`processStdoutOutcome`→`handleIncomingLine`）无生产接线，仅为`BridgeClientIntegrationTests`夹具保留，删除前须先处理该测试；⑥ 通知音效平台等价物——Swift `silent → 无声`、否则系统默认声（`SwiftEdgeHostLegs.swift:219-222`），Electron darwin `Glass`，UNUserNotificationCenter无该资源。

- 起始端口偏移：本地默认17510、控制面默认17500；当前固定起始端口+ P+1重试+记录仲裁；开放配置未决。

- trusted-host自定义Host：当前反代Host与实例自身`127.0.0.1:<port>`一致；未来自定义Host须同步扩trusted-host集。

- **多控制面 `$DSH_HOME` 冲突**：同stateDir共享home时会话JSONL可追加，settings由dsh `settings-conflict`仲裁；进一步隔离未决。

- 多控制面catalog metadata无跨进程CAS：label/accentColor并发修改last-writer-wins。design 25 §6.3的`<userData>/.dsh-chamber.lock`只做flavor/实例互斥（仲裁权威是flock本身，pid/时间仅诊断），不能当字段级CAS；可靠多writer需锁内reload +字段intent，否则应正式改为「并发plane必须不同stateDir」。普通pidfile/mkdir stale lock有三方takeover双持，不可作修复。

- 响应头白名单双处同步：权威在04 §4.3，仍建议把代码/文档表述单源化。

- **`__DSH_BOOT__` 随dsh版本漂移**：manifest形状以vendor `parseBootManifest`为准维护。

- **未挂载来源是否需要只读 `workspace/follow` 流（提出，未决）**：消灭「未挂载来源整源降级」的架构级解法（相关登记：合成cwd分组/空归档集、首屏整源降级、工作区集合滞后）。代价：侧栏对未挂载来源用纯fetch unary客户端，流需新增WS/SSE传输+世代/重连/`baseline`-once语义+与挂载推送去重；等于在侧栏再实现「前端运行时会话/工作区读通道」，触碰「控制面/侧栏不重实现执行面」边界。当前不走（本地回声已覆盖可感现象），定位owner级设计决策。

## 范围决策与必要取舍（不做 / 推迟 / 移出 / 偏差）

>双flavor专项登记（用户可感偏差S、有意结构差异T、Swift leg接入缺口P、门禁/覆盖缺口G与文档漂移D，外加可达性纪律与盘点）见[deviations.md](deviations.md)；开放工作见上文与deviations.md open条目。

- 依赖声明补齐与跨包原语合并暂缓：renderer→6 个 client-ui 包、layout→sidebar 的 devDeps 缺口已确认；linux 上 `pnpm install --lockfile-only` 会剥离跨平台 optional 解析（296 删/31 增，pnpm 以本机平台规范化），本机无法自证 → 待平台正确的 lockfile 重生成 + 人工审 optional churn；在此之前 private-fs/windows-process/semver 的跨包单一实现以 parity/lockstep 门（已常驻测试）代替。

- 构建产物移出 git（；原「提交进仓产物维持现状」登记已不成立）：clean checkout 首次 typecheck/static/test/打包前需 `pnpm run build:artifacts`（`run-checks` 与相关包测试自动前置）；产物不再入库。设计契约与取舍见 design 05 §6 Rejected alternatives 与 design 08 §7 / 09 §3.1 / 17 §15 / 18 §9.6 / 20 §6.1 / 24 §7；`renderer/src/generated` 维持只在本地生成、不提交。

- 测试面精简已到证据化上限：已完成逐删除覆盖复核与最小恢复（恢复落在存活文件）；继续压缩须删除安全/fail-closed、跨包 parity、golden/pin 或 CI 显式引用类测试，属保护面取舍，需显式裁决。

- 统一名称的保留面（用户指令；逐条登记以免被当成漏改再翻一遍）：身份字样（bundle内可执行名、SwiftPM模块/目录/资源包、shim资源名、`DSH_CHAMBER_SHELL_*`环境变量、dev数据根、日志文件/标签、调试通道）对齐`dsh-chamber`（deviations T-17）。以下有意不改：① bundle id `com.dshchamber.native`（Swift壳）/ `com.dshchamber.desktop`（Electron腿）——改动=通知授权重来+打包身份返工（T-14）；②跨进程协议串`--native-updater`、`__host.nativeUpdatePhase`、`no-native-bridge`/`nativeChannelToken`——Swift↔sidecar ↔渲染端shim三侧锁步，改名须协变；③持久化键前缀`native-shell.page-zoom.<origin>`（`macos/Sources/DSHChamber/ZoomPersistence.swift:22`）——改键会静默重置用户缩放偏好（T-22）；④测试夹具loud标记`poc-stub`/`poc: true`/`poc-no-registry`/`poc-unimplemented`（`packages/desktop/sidecar-stub.ts`）与settings-bridge的`'native-shell'`阻塞原因分类id（`packages/dsh-chamber-client-ui-settings-bridge/src/client/blocked-reason.ts:12`；文案跨包锁步、不属改名面）。免改面：`CHANGELOG*`段、`.tmp/**`（含旧`POC_*`脚本与旧名.app，临时区）。失效判据：上述任一被改名须同步T-14/T-17/T-22与两侧测试。

- 重启即重载：用户发起的插件刷新入口已全部接线：页面侧client插件集boot时固定；用户发起的实例/托管dsh重启须附一次窗口重载，否则新装/重打包客户端半身不出现。有意不接：gateway「重启网关服务」（systemd，不改插件集）。仍不覆盖：不经chamber界面的插件集变更（外部改profile且实例未重启）只能手动刷新窗口（Cmd/Ctrl+R）。失效判据：新增重启/生效入口必须接同一completion（或注明不接理由），且`sidebar/shared/restart-window-reload.ts`用例覆盖「就绪即重载/预算内未就绪不重载/同key单飞/卸载不取消」四路径。

- **租客 body portal 不受任何 stacking 边界约束（P0–P3 修订的已登记残余）**：官方 ui-chat 4 处 + chamber 2 处 `createPortal` 渲染到文档 body，z-index ≤1100；遮罩期内这类浮层仍可能可见。顶层幕布可压过 portal，但它是文档全局层，会覆盖全部视图与 chamber chrome（含 `.boot-gap` 非模态横幅），故不做——残余登记（design 05 §4 被否方案⑤、§9）。

- 降级事实覆盖边界：已覆盖活动视图横幅、侧栏来源行、连接页卡片与插件对话框（事实= `ChamberServerAggregate.bootGap`，design 05 §4）。仍不覆盖：②未激活/未预热来源无壳无事实；③壳回收时缺口行随shellStates清除、重挂后5s探针重报；④事实单槽、后报覆盖先报（改列表会外溢投影/渲染/重试计划，暂不做；`shell.test.ts` seam钉住）；⑤侧栏来源行只有说明、无动作（新增跨包请求通道不做）。

- 侧栏行悬停卡片由本仓自持（偏差；上游修掉竞态即可退役）：vendor `HoverCard` arm宽限关闭依赖**上一次已提交的`open`**（`ui-primitives/src/HoverCard.tsx:183-188`），本仓每实例一大React root⇒pointerleave漏arm、卡片无法关闭。改由`RowHoverCard.tsx`+`shared/hover-intent.ts`渲染；有意偏差与内容差异见design 06 §7（`ResizeObserver`重算等）。退役条件=上游修掉竞态；`verify-upstream-touchpoints.mjs` C15断言竞态两侧形状+时间常数锁步，上游一修升级pin时本门先红。证据：`sidebar/test/session-rows/hover-intent.test.ts`；实机走查W-4b/-race/-swap/-dismiss。

- **连接页手写tooltip未走vendor `Tooltip`（偏差；a11y仍open）**：`ConnectionsSection.module.css:320-375`用`data-tip`+`::after`自绘（13处），气泡无`role="tooltip"`/`aria-describedby`；站点均有`aria-label`，可访问名不丢，缺气泡文本与触发按钮程序化关联。触屏抑制覆盖`[data-tip]::after`（`mobile/src/client/styles.ts:147-167`）。未决：补ARIA关联或改用vendor `Tooltip`。

- git客户端与宿主错误码重叠是有意的显式例外（design 08）：`path-unavailable`/`workspace-path-unavailable`同时是宿主可重试码与客户端确定性拒绝码——客户端把它们从宿主`RETRYABLE_CODES`（`git-worktree/src/core.ts:392,400`）提升为确定性（`client-ui-git/src/shared/git-api.ts:95-98`，理由`:79-94`）：两者均出自宿主`existingPath`探针，重放只会再跑同一失败探针；宿主保留可重试因同一码亦会在已提交删除后的`reconcileBoundRemove`出现（`core.ts:2504-2595`）。重叠由`host-client-lockstep.test.ts:286-296`钉死⇒取舍非缺陷。

- 移出项（P3硬纪律）：匿名control-plane的认证/审计、薄壳聊天/会话列表/审批弹窗、控制面会话runtime/统一索引、连接broker/绑定、walkthrough、通知中心/历史、MCP、文件夹/笔记、web预览、目标/终端等不得回流。设计17/18/19/08/20/24的独立边界例外不得泄入匿名control-plane、引入session消费者/通知历史或变成第二套执行面（design 24例外不作他域先例）。

- **`--no-auth` 是醒目的可信网络有界例外**：Gateway外部部署默认必须认证，只有显式传`--no-auth`才可覆盖（启动器二次确认并打印安全告警），不是静默fallback，也不授权匿名control-plane绑公网。

- Gateway state根目录自动收紧：既有stateDir经pinned no-follow描述符收紧0700 +属主uid校验（异主fail-closed）；broad root拒绝与Windows继承ACL让步不变（design17 §12）。

- safeStorage的诚实回退：Gateway凭据优先safeStorage；OS加密不可用时按用户决策回退target-bound 0600明文并如实显示。SSH密码为endpoint-bound 0600明文镜像。Windows例外（C16）：DPAPI不可用时拒绝明文落盘，凭据仅内存驻留——S22明文兜底仅限非win32。

- Windows发布身份让步：x64安装包未做Authenticode签名，SmartScreen提示是已知取舍；feed sha512只证明下载完整性，不等价发行者签名。

- macOS平台范围让步（不做 + 推迟）：v1不发布macOS x64（GitHub已退役最后公开Intel runner；mac腿只有`macos-latest` arm64）；x64侧另因`bundle:dsh`烘焙宿主平台运行时、交叉构建需Rosetta工具链而推迟（证据：`release.yml` mac/Linux腿注释）。

- N-ctx单文档信任域：远端实例前端与同文档内其他实例及高权限preload bridge共域；现有main-frame/origin/proof/主进程确认只能缓解，横向隔离推迟到每实例独立WebContents架构。

- N-ctx壳常驻语义收窄（2026性能整改偏差，design 05 §4）：「booted壳无限常驻」收窄：local恒留，隐藏壳最多保留`RETAINED_HIDDEN_VIEWS=1`，超限回收「已settle+连续隐藏≥60s」最久者（回收= dispose shell +卸载壳，实例进程/连接不受影响，重开冷boot）；被回收源不再自动预热直到用户点开。**起完成边沿不再依赖壳**：蓝点/未读/通知/徽标由 App 派生账本 + 只读事实通道（网关只读镜像 `session-state`、SSH/本地 dsh 的无壳观察者）承载，壳回收不再丢完成（`docs/design/06-sidebar-enhancements.md` §4.2、`docs/design/19-notifications.md` §3.3/§3.7）；仅实机腿未判（见本文件「远端完成未读 / 切源体验」条）。

- 远程来源会话状态与切源白屏（锚 `v0.4.0-beta.1`）：实现面已闭合，被否方案见 `docs/design/17-server-side-gateway.md` §20，读水位/派生契约见 `docs/design/06-sidebar-enhancements.md` §4.2 与 `docs/design/19-notifications.md` §3.3；仍开放的实机/CI 权威项（含 W5 双客户端 E2E、场景级时序判据、DOM 层断言与性能基线）见本文件「远端完成未读 / 切源体验」条。

- **安装态 Swift 版仍是修复前的构建（复查，行动项）**：`/Applications/dsh-chamber.app` = `0.3.2-beta.5`，其 `Resources/dist/web/assets` 对本次修复标记 0 命中（`view-request/view-reveal`、`requestMarkAllRead`、`requestIntentPrewarm`、`__dshChamberSourceMux`、`__chamberSvgScopeInstalled` 等全无）⇒ 要用上本次修复必须重跑 `build:renderer` → `build:sidecar` → `build:swift-app` 并安装。另有待实机判的一项：`document.hasFocus()` ≡ 宿主焦点的假设（`design 19:166-167`，`macos/` 无焦点观测），它驱动「正在阅读」清蓝点与 `requireHidden`。

- Swift 形态的**产物门已补齐、实机门仍开**（复查，design 25）：产物链单源（`build-swift-app.mjs` 从 `packages/desktop/dist/web` 拷入，装配内已加 scoper 标记 fail-closed；`release.yml` 两处补门），Swift XCTest 本机跑得 453 例、450 绿（其余 6 例需 `build:sidecar` 产物，属 CI 的 macos 腿）；**仍开放**：打包态 `.app` 实机验收、WKWebView 无 `backgroundThrottling:false` 等价物下的 SSE/WS 心跳与 App Nap 语义（与下方 S-10 条同源）、真机重放切源白屏判据。详见本文件「远端完成未读 / 切源体验」条与 design 25 §8.5。

- 远端完成未读的**零证据窗口**（审计后登记，design 17 §10.7）：网关**整段停机期间**开始并完成的会话不可恢复——镜像未观察、壳未挂载，重启重建没有任何输入可依。按设计接受（R3 只覆盖「重启后仍可见的事实」），不计为缺陷；判据与边界即本条（零证据窗口不可重建），design 17 §10.7 只定义只读镜像边界。

- 远端宿主上的空白会话残留（design 05 §2.2.1）：N-ctx会话选择是页面级单键（`dsh.sessions.current`，vendor store无scope），壳冷boot无恢复会话，官方即在最近工作区复用/新建（宿主`session.create`）一个blank。chamber三闸门只消除用户可感中间态，不阻止该create；根治须上游给selection加shell/入口作用域（`todo/upstream-proposals.md`）。同工作区复用不增长，按已知降级接受。

- **复合首屏 `ui-chat` 老代实例整面失败：会话面静默缺席（实机，仍成立）**：首屏inject `sidebarRight`，唯一provider是未覆盖extra row `@deepseek-ai/dsh-client-ui-sidebar-right`（覆盖集`renderer/src/chamber-covered.ts`）；图谱缺该行⇒ `ui-chat`永远PENDING ⇒会话面从不注册（仅console `[chamber-entry] … still unprovided after5000ms`），实机仍有gateway来源跑dsh 0.1.2-rc.1（图谱47行，缺`sidebar-right`等六行）⇒ `conversation.session`槽0字符；0.1.5-rc.1与本地正常。无降级通道（不能按来源回落宿主旧行）。收口：①老gateway升到0.1.5-rc.2锚（`install-gateway.sh update`；`test-http`可行）；②chamber侧把代际过旧变成可见诚实提示。

- 未挂载来源的工作区集合只有「回声 + 挂载push」（design 05 §2.2.1）：应用内工作区变更（`shared/workspace-mutations.ts`唯一出口）由回声立即呈现；别处创建/改名/删除与顺序仍要等该来源挂载才收敛。两处具体表现：①改名unary兜底行按`basenameOf(path)`推导、该视图无宿主title字段；②删除后行留到下次挂载（点它`workspace/not-found` fail-closed，行内报错）。不做的收敛臂：每次变更付一次后台挂载（与稳态≤1壳/首启每源一次boot冲突）。彻底解法同属上游读通道（见「设计未决」follow流条）。

- 不做（v1）：跨来源移动会话、单store真融合、控制面会话实时同步、远程实例管理UI外壳。推迟：flat单列表模式。

- 保留项（裁决）：`ALLOW_BUILDS` 的 `fs-ext`保留（回滚目标0.1.3-alpha.2仍依赖；登记在`pnpm-workspace.yaml`与`allow-builds.mjs`）；`runtime-host-adapter`退役不采纳（测试夹具契约，非死代码）。

- 设置壳偏差：壳不渲染官方SettingsRoot（自绘chrome：触发器行42px、面板r32、关闭焦点回触发按钮）；面板渲染选中来源自己boot ctx台账，故该来源壳必须挂载；离线远端仍可选并显示不可达占位与连接管理动作（不触发挂载）；服务器选择器body portal+viewport翻转/钳位与内部滚动。

- 上游对齐轮引入的有意偏差（仍成立）：
  - 设置壳首启阶段：活动视图门只门挂载，完成集重置只跟sessions事实：按「当前会话空/blank」挂首个`settings.onboarding`；chamber另加活动视图门（`SettingsShell.tsx`调`onboardingStage`；`useActiveView`读active-view事实）——防多实例壳时别人的首启弹到当前视图；未发布读作关；代价=隐藏壳首启推迟到被激活。完成集清空只跟sessions事实（`resetsCompleted = !sessionsActive`），否则一次切视图抹掉全部确认（判据`test/bridge/onboarding.test.ts`）。登记残留：完成集组件局部，重挂载仍从空集重跑；证据`SettingsShell.tsx` RESIDUAL注释；收口需跨挂载存活的每实例状态，不在本轮。
  - **`sectionsEmpty` 占位保留**：chamber未发布分节台账是可达的N来源状态；空白列会被读成「这台服务器没有设置」而非「分节还没到」。
  - **框架失败屏深引 `ui-primitives/src/Button.tsx`（不引barrel）——打包预算决策：深引避免barrel把markdown/CodeBlock家族拉进主图。最近实测**（`build:renderer`写`desktop/dist/web/perf-sizes.json`，门值`check-chunk-budgets.mjs`）：主图仍在`mainGraphRaw.warn = 1,350,000`内（余量≈8%）；chamber入口**已越过`chamberEntryRaw.warn = 2,000,000`（无硬门）。待决**：拆出/懒化首屏家族，或上调阈值并把理由写进脚本头注。失效判据：读数回门内或阈值调整与理由落进头注。
  - **`Switch` 披露属性挂原语自己的控制节点（review-fix F3）**：官方`Switch`无属性透传；`aria-expanded/controls`改由`DisclosureSwitch`（`GeneralView.tsx:151-174`）经`applyDisclosureAttributes`写原语`[role="switch"]`。收口需上游加透传；原语根即`role="switch"`由（原源码文本锁，已按裁决移除）tripwire钉住。
  - 「开/选中」色与进度色回到dsh业务蓝（用户裁决）：取`--dsw-alias-state-business-primary`，不用官方中性档`--dsw-alias-brand-primary`。落点六处（设置壳generalCardCheck/SegmentedControl thumb/Switch开启轨道覆盖/连接页pluginPillActive/运行时进度填充/归档管理器勾选）；有意不改：官方`RiskConfirmation`勾选框与`Button variant="primary"`（官方组件+ body portal）。判据：两包（原源码文本锁，已按裁决移除）。
  - 侧栏schedule事实由chamber带过去：`shared/derive.ts:hasActiveScheduleOf`读挂载/unary两路径并进`instanceSnapshotSignature`（不进签名则标记冻在首见值）；`.scheduleIndicator`不带上游`margin-right:6px`（本仓行已有6px gap）。
  - 会话**状态**标记completed/pending都是保留偏差（用户裁决，不改）：运行中=官方`StateDot` 10px环；完成未读= chamber品牌蓝点（不用官方done绿——与来源头连接绿同token；锁在`visual-lock/（原源码文本锁，已按 裁决移除）` T10）；提问/计划待审/请求权限= 14px图标徽标（官方是10px warning圆点，词表取官方`status.waiting*`）。后续对齐轮不得当漏改收掉；判据见06 §4.3。

- **默认排序 `manual`（06 §3.1）**：按wire顺序，与官方默认 `updated` 不同，属有意取舍。窗口标题冻结：Electron固定 `dsh-chamber-electron`（`main.ts:878`，拦 `page-title-updated`），原生壳名 `dsh-chamber`（T-14/T-29）；两侧均不随 `document.title` 变。

- 菜单密度 = chamber档，不跟随官方（裁决）：chamber弹层菜单（session/workspace kebab、排序、git字段下拉、open-in应用菜单）一律用官方原语 `compact`（26px/12px；open-in原dense、git原默认档本轮改判，见design
  20 §1/design 08 §3.3），设置页服务器下拉用自有markup、保留官方圆角/背景。判据见design 06 §7/design 15④；下一轮上游对齐**不得**改回默认/dense，锁在 `sidebar/test/visual-lock/`。

- Electron二进制惰性安装（每机器共享dist，worktree并行共用）；dev实例隔离（独立user-data、控制面端口
  17520起自动退避）。

- 内建版本行引导（决策，方案2）：选中与内建同版本行、未装受管树且有用户选择时主按钮引导「恢复内建」（零下载；树/快照保留），「仍下载并安装为受管版本」为显式次要动作；gateway部署锚分支同款。

- dsh运行时设置面（统一）残余偏差：desktop `SETTINGS_SET` env下允许换registry；恢复期矩阵收窄对齐；
  registry白名单desktop https-only vs gateway http-loopback；desktop 15s+6h周期检查不移植gateway；失败现场清除入口仅本地；metadata health无缓存；pnpm prune不可abort；RUNTIME_RESTART handler内联无单测；env×FATAL预路由desktop
  独有。F4b：gateway侧动作12分钟墙钟上限（超时报 `dshRuntimeActionTimeout`），本地腿仍无abort句柄（本地重启卡死永久pending）——需给IPC事务加取消通道，未排期。

- apply-now门形态取舍：desktop `evaluateApplyNowGate` 是纯投影门、gateway `applyNowPreflight` 是含副作用
  preflight；输入与副作用各异，整门合一即推翻逐轮对齐语义，不做整门合并。

- 探针**契约**残余（design 18 §3.4定稿后）：上游 `session.list` 分页/裁剪/删除待上游（chamber不落地；design 24退休条件同源）；归档「不能瘦身」维持；legacy回退warn为可选注入sink（未注入即静默）；激活层对上游再漂移以失败路径为准（fail-loud）；desktop SSH attach底线 ≥ 0.1.2-rc.1；远端瞬时重启/路由挂载窗双404 → 通用terminal（ready心跳降级为瞬态引入60s慢重探
  churn，取舍留未来设计）；`verifyUp` 必须在自有限期内settle（transport裸await，无外层超时）。

- 0.1.2线已知降级（仍有效）：
  - 远端/直连0.1.2 dsh附加硬阻断（launch token为远端内存随机数、隧道不可恢复；上游给检索机制前保持）；dsh×http禁用（恢复点design 17 §3）。
  - 版本芯片：本地接线、远端隐藏（D2）。
  - cookie Max-Age=30天无会话中重换：过期后约10分钟健康失败窗口重启换新（自愈；「过期即交换」另行排期）。
  - remote-stream帧校验宽松于上游exactKeys（前向兼容容差）。
  - settings-bridge agentPresets/select合成 `{agentId:'', agentPreset}`：被调必响亮失败（潜伏面）。
  - 端口碰撞理论面：本地实例同端口cookie覆盖（实际不可达，登记不修）。
  - unary兜底归档过滤无wire源（仅未挂载来源与首次baseline前窗口；`archiveSetKnown:false` 三态；断连期保留推送视图）。
  - **首屏「整源降级直到被点击」（design 05 §2.3；`baseline-harvest.ts`）**：首启local挂载 + 1预热槽不轮转、被回收源点击前禁预热 ⇒ N-1个ready远程源停unary兜底视图直到点击；自愈臂须 `mounted===true`。收割
    （上限2、失败退避120s；托管dsh停机源不收割）。**剩余验收=打包态实机
    （真实分组与归档过滤、稳态无驻留壳、慢隧道/失败源不卡boot链、收割期点击不被回收）。登记残留**：①
    `harvestParked` 不再退回普通预热，只能点击自愈；② 已收割源归档集两次收割间冻结；
    ③ 每ready源各付一次后台boot（稳态 ≤1壳；收割独立预算线）；④
    最后收割的壳保留为温壳（`shouldReclaimHarvestedShell` 让位）；⑤ `source.baselinePending` 诚实标注，托管停机另有
    `source.managedDown` + 恢复入口。
  - **gateway `ready` 不蕴含托管dsh就绪（`managed-runtime.ts` + App 15s探针）**：verifyUp只探 `/chamber/runtime/status`，侧栏不消费 `connectionState` ⇒ 停机/重启窗口无降级投影。投影 = 独立字段 `managedRuntimeDown`（绝不从合并phase反推）；终态停机置换phase且
    `connected=false`；starting/restarting折叠；degraded呈现未连接；探针缺失/非200 fail
    open。剩余验收=打包态实机 （真停后转红且 `+` 禁用、重启恢复；请求量目检）。登记残留：① 停机不门控unary
    watchdog（未挂载down源仍30s拉一次；接进 `collectReadySourceIds` 需裁定）；②
    停机源来源头不再可激活（深链/通知仍可，落空由失败覆盖层）；③ settings-bridge换 `targetUnavailable`；
    `/chamber/runtime/start` 未从设置面板直达。
  - 同一文档其它逐实例全局量（design 06 §4.6）：① 文档级 `drop` 扇出（真缺陷，未修；
    `ui-attachment/ComposerAttachments` 无归属判定 ⇒ 一图附两实例草稿）；② `document.title`
    竞争写；③ `--dsh-content-font-size` 播种读到上一applier值（投影自愈）；④ portal
    逃逸（真缺陷，未修；vendor `Modal`/ 官方 `Menu` portal/SettingsShell下拉/未注册行 `RiskConfirmation`
    切换后仍盖住B；`.boot-gap-layer` 同样被盖；缓解 = 固定inset遮罩，非活动视图门控）；⑤ 主题样式表每壳6个
    `<style>`（良性重复）。①修法 = 按活动来源门控（vendor源码，待seed/patch裁定）。
  - 活跃视图数据面拉活缺席（评估，未实施）：点会话行不触发聚合刷新；推送与unary同失效即静默冻结在最后推送。结论：「ready超阈值即强制ctx重连」不宜照做（ssh源被S2臂排除、recency重连白churn）；正确信号 = 推送视图与unary权威列表分歧（需新判定 + 限流记账，与design 24 §12共用语义）。排期未定。
  - 推送通道死亡期侧栏成员关系/归档集冻结在最后推送（恢复推送自愈）。
  - 兜底cwd派生分组限制：符号链接拼写可能不匹配canonical索引；未挂载来源新建空工作区不可见（fail-closed）。
  - git工作树删除时runtime通道缺席fail-closed（`'runtime-unknown'`）。
  - unary长命令豁免残余与治本（design 03 §3.4）：超30分钟保险丝显式截断（504 + abort）、会话一致性无损；治本 = 上游 `commands.execute` 改受理即回、结果经会话事件流（宿主非chamber可写范围，登记上游跟踪项）；上游异步化时dsh-runtime激活/身份探针须平行迁移。

- 代理300MiB响应体上限 ⇒ 大会话导出为已知降级：控制面非SSE响应体上限
  `MAX_RESPONSE_BODY_BYTES = 300 * 1024 * 1024`（`proxy-forward.ts:50`）；声明长度超限 `:877-884` 直接413
  `body_too_large`，流式超限 `:951-960` 销毁upstream并按headers定413/断链。上游 `session-log-export` 的
  `/api/session.export` 返回完整ZIP流（`vendor/.../session-log-export/src/index.ts:42`/`:150-166`），chamber
  触发：单会话响应体（DEFLATE后ZIP，含全部subagent代际）> 300MiB
  ⇒下载中断/413，无分片逃生口。不修：抬高上限同抬内存/带宽预算，待上游分片/可恢复下载。

- 平台词偏差C3（性能审计，已登记platform.ts/seed.ts/chamber-entry.ts/shell.ts注释）：上游
  `PLATFORM_MODULES` 仍列 `@deepseek-ai/dsh-client-ui-primitives`，chamber自建平台集不再seed
  该词，改由composite coveredfactory回答
  extra行同步require边，前置保证 = chamber入口先于任何extra bundle装载（shell.ts C3门 + host-graph.ts
  `awaitBeforeLoad`）。残余窄竞态 = shell prefetch失败后create期并发materialize（extra loud
  降级、重试自愈，非静默）。跨代依赖：实例侧 `ui-sidebar-documentpreview` 代码预览依赖composite同代
  `ui-primitives`（`CodeBlock` 的 `contentRef` 经 `[data-code-block-content]` 是唯一滚动/行定位锚点）；composite
  比实例旧一代时该行失去独立滚动区、行定位失效（纯文本仍可用）。

- settings簇deferred C4（性能审计，已登记chamber-entry.ts/chamber-covered.ts注释）：官方ui-settings保留首屏（locale/ui-theme root-inject `settingsScope`，defer即瘫痪壳）；后移4个官方settings section + chamber
  settings shell/connections。可观测瞬态仅「设置入口缺席 ≈1chunk往返」；每服设置面板即该来源boot ctx自有台账，未挂载完成来源显示「正在启动该实例的前端」。失败面（登记）：任一import失败 → 整簇本boot缺失（含connections CRUD、dsh-runtime管理与更新），console loud无重试、靠
  shell重boot；按家族allSettled独立注册为候选改进。

- **插件页不检测「远端真的带了 `localOnly` 包」（接受不检测）**：受管组件表按目标适用性列行（
  `applicableChamberPackages`：local 4行、ssh/gateway/http 3行），判据是注册表标志而非观测状态；远端真带
  `dsh-chamber-seed-open-in` 时该表不显示（`classifyInventoryEntry`
  不漏进第三方区）。「确实存在才列」须在远端探针加overlay检查 + 偏差分支（`plugin-sync.ts`
  已读到，但须为不可达状态新增呈现路径）；该门与包同期落地、无已发布播种路径，故不做。证据：design 20
  §6.2/§9、`chamber-rows.test.ts`（分类兜底由 `chamber-seed-drift.test.ts` 钉住）。

- 会话行/搜索结果标题墨色不照官方：静止次级、hover主色（用户指令，偏差）：官方 `Rows .title` 继承行墨从不降级；本仓恢复v0.2.4两级——`.sessionTitle` 静止 `label-secondary`、hover转 `label-primary`，`.searchResult*`
  与 `.todoRow` 同规则、`.todoTitle` 行外两级同为次级。**理由**：A1改常驻主色致hover仅剩低对比底色。下一轮上游对齐不得改回常驻主色；锁在 `sidebar/（原源码文本锁，已按 裁决移除）` A1一例。

- workspace头部行尾动作簇间距 = 4px，不跟随官方12px（用户报告，偏差）：官方12px指无git
  occupant的两项簇，本仓可见簇三项（`.headerGit` 揭示态落头部自身4px），12px会把一簇切成4px + 12px。`.headerGit`/`.sourceActions` 的4px已随命中盒回退到2px（见命中区条）。下一轮上游对齐**不得**改回12px；锁在 （源文本锁已按裁决移除）A8b（`.rowActions` =4px；`.workspaceHeader` 的4px作为簇左边界一并入锁）。

- 轨道来源点多于可视高度时被裁掉、无滚动入口（未修）：`SidebarRoot.module.css` 的 `.regionArea`（
  `flex:1` + `overflow:hidden`）下的 `.railDots` 无overflow/min-height ⇒ rail态无滚动容器。已把命中盒pass的 `gap` 退回12px（buttonization的 `margin: -4px 0` 保留）⇒ 点距回20px，不再有「少约
  1/6」。不做：rail滚动呈现是设计面，加 `overflow-y:auto` 引入自绘滚动条；判据
  （源文本锁已按裁决移除）V1一例（gap + margin两半都钉住）。

- **footer动作行 `gap: 4px` 是chamber对官方复制块的增量（偏差）**：`sidebar.footer.action` 是list座，官方 `.footerActions` 只有 `display:flex` 无gap，本仓补4px；当前无注册者故发布态不可见，但
  重抄官方块时**必须**带上；判据 （源文本锁已按裁决移除） 的 `.footerActions{gap:4px}` 一例（纵向间距仍由
  occupant自有margin承担）。

- 侧栏/git图标钮命中区回到视觉盒，重新低于WCAG 2.2 2.5.8的24px（用户指令，偏差）：命中盒
  pass加的不可见 `::after` rim与加宽gap整体回退（命中区 = 视觉盒，gap回2px）；缓解而非根治（无指针位移触发、快速甩动跨 ≈3px纯行带仍漏）；重低于24px（「同类偏差全部收口」撤销）。重加rim前**必须**重测命中盒与纯行带；判据两包V1一例。

- 根治该漏事件类的补丁未落地（未做）：上条只是缓解；根治 = 给悬停卡一条不依赖React合成enter/leave
  的投递通道。不做原因 = 用户指令「按
  v0.2.4恢复」；复发时再落，方案与验证点见 `.tmp/audit2/fix-design.json`。

- **导轨开关没有稳定DOM锚点、也不带 `aria-expanded`（取舍）**：侧栏头部折叠钮只有会翻转的 `aria-label`；移动档替代品自补 `aria-expanded`，理由见其头注。`W-4` 只能结构定位（`checks.mjs` 的 `pickRailToggle`，候选空/并列即FAIL）+ 效果锚定（`[data-sidebar-collapsed]` 出现/消失）；`W-4a` 写持久化偏好 `sourceFolded`，只在 `--dev` 执行。改身份锚定需先按design 06 §7的a11y名单加属性并同步 `upstream-touchpoints.md`——设计裁决。

- 悬停几何/墨色没有真指针验收腿（未做）：`gui-acceptance` 的W-4b四腿都从行中心离开，覆盖不到「从动作钮离开」路径，也无腿读标题墨色两级；证据 = CSS锁 +打包页注入实测（`.tmp/band-after-report.json`、
  `.tmp/ink-report.json`）。新腿须在打包应用实跑（本轮无法构建）；发布前补W-4b-`cluster`（kebab上5px
  步进离开）与墨色腿。

- 不做git钩子（决定）：`core.hooksPath` 不随clone携带，装钩子即要求每个clone重配；`pnpm run check:static` 一条命令跑全。本仓不提供、不安装任何钩子，不引入husky/lefthook
  类托管层。
- 上游触点registry单一来源（决定）：`scripts/upstream/registry.json` 是触点登记的单一机器来源（路径/分类/判据id/偏差id/一句话原因）；`verify-upstream-touchpoints.mjs` 启动即读它，`upstream-touchpoints.md` §2/§9的 `GENERATED` 块是生成视图（禁手改，`registry-views.mjs --write` 重生成，`verify:registry` 保鲜）。新增两道普通门禁：`verify:registry`（schema/canonical/引用存在性/deviations id/覆盖面网/生成块）与 `verify:anchors`（符号锚 + 遗留 `文件:行` 预算棘轮），已进 `pnpm run check:static`；ci.yml只在ubuntu `test` 作业与release validation跑（release proof要求registry步骤名；win/mac腿不跑），两门的路径/JSON解析因此没有Windows执行覆盖，属登记在案的残余盲区（同registry的Windows无覆盖由C1–C15触点门在win腿部分补足）。C4/C7–C15判据实现刻意留代码里，只按id引用。

- 推迟：工程门禁P2项：观察型CI job（非阻塞只报数）、术语表、文档字数预算、`docs/checklists/*` 过程文件转可调用动作、`README.i18n.yaml` 三元组译文一致性门（现只有哈希记录）——均未排期。

- 上游纯镜像README的失效链接被链接门显式跳过：`dsh-client-connection`的 `README.md`/`README.zh.md` 是上游逐字节纯镜像（C1冻结），文内10条相对链接在chamber树内不存在；改镜像违反C1，故 `verify-md-links.mjs` 以
  `MIRRORED_DOCUMENTS` 显式排除并每次打印跳过清单（不静默）；修复面在上游。

- 插件域「单一定义」剩余开放项：① gateway undo **无主进程确认弹窗**（renderer 直发 POST，先例 `/chamber/runtime/restart`；补确认需新增 IPC 面，而 `preload.cts`/`renderer global.d.ts` 的投影受 C14 与 ipc-surface-mirror 门约束）；② undo 在 ready/degraded 时**不自动请求受控 restart**（入口本就只在 runtimeDown 显示，恢复后走既有「重启生效」路径）；③ **装后复验违例的自动回滚**仍未实现（v1 = 强制复验 + 响亮失败；现可用 undo 路由人工恢复）；④ r4 的 `gateway plugin` **操作员子命令**仍二期（executor+journal 核心已共享）；⑤ 新增拒绝码 `no_undoable_op`/`journal_unavailable`/`write_fence_unavailable` **未本地化**（客户端逐字显示服务端 `error`）。

- sidebar/layout 的 `main`/`types` 仍指向无人构建的 `lib/`（R4 P6 有意保留）：两包 `exports` 全指 `src`、仓内无解析者（vite alias / workspace 源导出 / test shell loader 均走 src），上游家族形态照旧；若未来判定这两项也是死声明，随「包清单发布面」另开条目（P6 只授权删除 `tsdown.config.ts` + `scripts.bundle/watch` + `files`）。

- 上游镜像包的 exports 保持 `lib` 目标而磁盘无 `lib/`（裁决，与上一条区分）：`dsh-api-gateway` / `dsh-client-connection` / `dsh-client-web` 的 `.`/`./client` 面**确有按包名消费方**（`renderer/src/chamber-entry.ts`、`renderer/src/shell.ts`、`api-gateway/src/client/*`），解析链 = vite alias / tsconfig paths / ambient 声明到本包 `src`（不依赖磁盘 `lib/`）；三包的 `files`/`main`/`types` 三无死发布面已删除（本仓无 npm 发布路径，release-policy 断言禁 publish），exports 因消费方存在而**有意保留**；registry 备注已如实同步。

- 元工程余量（R10）：`preload.cts` 的 payload 形状尚未收敛到单一机器源（现由 `verify-shim-payload-shape.mjs` 文本锁保证 preload ↔ bridge-shim 一致）；「源文本锁改可 import 断言」未全量执行（仍有 161 个测试文件读生产源文本），审计明确不建议继续加门，需显式范围裁决（保留何种文本锁体裁、以何key登记）。

- desktop 跨包接入受 Swift 锚点约束（R11 余量）：desktop 的 pnpm 入口/内建版本读取/dsh CLI entry 仍为包内单源，未改指 `@dsh-chamber/dsh-runtime` 的共享原语；`macos/Tests/DSHChamberTests/PackagedLayoutTests.swift:156-205` 以源文本锁 `sidecar-ctx.ts` 的七个布局助手与 `resolvePnpmEntry` 候选顺序（packaged > legacy > dev + dev 回落），锚点迁移属 macOS 门（当前断言集已被父代理静态复核 17/17 满足，XCTest 待 darwin 实跑）。

- state 根租约的 legacy 退役时点（R2）：`retireLegacyStateLocks`（旧 `.gateway.lock` / `dsh-runtime/owner.json` 的死记录清理）为独立函数 + `acquireStateRootLease` 内单一调用点，``（一个 minor 后）删除该函数、调用点、常量与对应单测条目；证据命令 `grep -rnE "gateway[.]lock|dsh-runtime/owner.json" packages/*/src` + `node scripts/gates/run-checks.mjs static`。

- Windows 覆盖缺口（R2/R14）：`control-plane/test/state/state-root-lease.test.ts` 的 T4/T5/T6（spawn 生产入口、双 scope）与 `host-domain-wiring-lockstep.test.ts` 未登记进 WIN32_FILES；实现只用 `node:child_process` + O_EXCL 语义，理论跨平台，Windows CI 当前不执行，待实机后再进清单。

- chamber-named 副本的 preflight 覆盖边界（R15）：`ui-layout` 以 registry `type=seed`（chamber-named 形态，与 `seed.dsh-chamber-seed-open-in` 同规）登记——schema 禁止把它记成 shadow fork（`fork` 的 upstream 必须 ∈ `excludedUpstreamDirs`，且 shadow 化会把深引面从 vendor-seam 降级为 fork-missing）；preflight 的 `FORK_PATHS` 只收 shadow 副本，故其上游改动由「C2 tag 间报告 + 预检 vendor-seam 包级报告 + C1/C3 分类表」覆盖，非逐文件 fork-replay；若要逐文件语义须改 `preflight-vendor-pin.mjs` 或改 shadow 形态（须同改 `ensure-harness-vendor.mjs` 的 EXCLUDED）。

- ssh 三腿确认缺口：desktop 的 `plugin_apply` / `seed_host_graph` / `materialize_add(_pick)` 主进程确认对话框尚未落地（design 13 §7.0 与 design 21 §7 点名）；三个 `describe*Confirmation` 是该契约唯一纯文案源（保留，勿按死码删）；接线被 renderer IPC 类型镜像阻塞（`packages/renderer/src/global.d.ts` 的 result 联合无 `cancelled` 臂，IPC 镜像测试钉住三处）。

- god module 残余：`gateway/src/runtime-manager.ts` 的 `createGatewayRuntimeManager` 仍为约 2,380 行单闭包，审计严重度表列为 P0 结构债、不在 R1–R15 建议内；未拆分，登记为已知结构债（后续单独设计与评审）。

- App.tsx 未拆簇（R7 余量）：boot/bridge/roster 簇（perf 埋点、health+SSE boot、桥就绪轮询、roster 重试、桌面桥订阅 effect、local 自启、远端自动连接）未抽——订阅 effect 的 notification 处理器前向引用后声明的 `openSession`/`enqueueNotificationOpen`，逐字搬移需 lazy getter 或桥就绪 state 在 App↔hook 往返，风险不值；渲染树与 `deriveServers`/`factsOverlay` 可作为后续独立 selectors 搬运。

- host 域接线仍逐域手写（R14 的 b 方案未做）：runtime-probes 每域闭包/accept predicate、control-plane 每域 option+常量、`main.ts` chamberHostSourceDirs 键表、sidecar `--host-*-dir` 参数面均未从注册表派生；保证手段 = `host-domain-wiring-lockstep.test.ts` 8 例「漏登记即红」（含 ghost 行 5 例红与 wantsDomain typo 单例红的双向负控）。
