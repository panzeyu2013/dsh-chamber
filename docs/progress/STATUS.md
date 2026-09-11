# 模块完成状态总览（STATUS）

> 本文档只追踪**未完成 / 部分完成**项（含剩余实机门禁）、**设计未决**与**必要取舍**
> （范围决策 / 已知偏差 / 已知降级）。已实现基线以 git 历史、`CHANGELOG.md` 与
> `docs/design/`（设计契约与样式定稿）为权威，不在此复述实现过程、历史轮次、验证
> 计数或执行台账（历次轮次记录已随收口从工作文档移除，留存 git 历史）。本文档是
> dsh-chamber 进度追踪的唯一记录。

## 未完成 / 部分完成（剩余验收）

- **实机门禁（未验证；缺真实实例 / 打包态环境）**：
  - 多来源 sleep/wake 与隐藏恢复、版本歪斜容忍、gateway 形态回归；
  - 右侧栏栈在真实 profile 下的装载时序与 `provideRoot` 时序（`useResource` /
    `usePanelInfo` / `chamberFileApiBase`）、session v3 迁移在真实存储上的行为；
  - open-in：实例进程内的 chamber host 包（`@dsh-chamber/dsh-chamber-seed-open-in`，本地形态
    专用）的**两代 runtime 装载探针**（`ctx.subprocess` 在旧 runtime 的 web profile 是否挂载是
    当前最大未验证风险）、真实图标抽取一致性与 `openInApp/icon` 的 base64/缓存/CSP 实测、
    远程无 cookie 下 fence 行为、remote cwd 填充（设计 20 §6/§10、
    `docs/progress/todo/open-in-ownership-and-enhancements.md` §1/§2）；
  - **写入期终止失败后闩锁只能靠重启应用再证明（2026-09-10，02 §3.4）**：扫描判定类
    阻塞已可在会话内再证明，并可由连接页「清理并接管」显式清障（owner 仍活的另一实例
    永不受影响）；但 `onWriterQuiescenceUnknown`（刚杀过的进程组无法证实已退出）**没有任何
    扫描证据**可依——记录可能已删——该闩锁对本平面生命周期粘滞，诊断只提示重启应用。
    触发面：受管进程组信号被拒（受限沙箱、加固运行时）或子进程终止超时。
  - **实例写者静默门拦住自动启动后的恢复路径（同上验收）**：shell 被 `SIGKILL`/孤儿 dsh
    占住 DSH_HOME 时，控制面如实拒绝（`409 connection_busy`：writer quiescence is not
    proven）+ connections 页就地解释，但「启动/停止」按钮在此状态下**点不动**（状态停在
    `starting`、端口 0），实际恢复 = 优雅重启应用（reaper 才 prove quiescence）。
    优雅退出本身正常（日志 `will-quit 清理完成`），仅硬杀后出现。（本条说的是**实例本身**
    起不来；视图侧「半死挂载」已由取图等就绪 + 降级自愈覆盖，见 design 09 §3.2。）
- **ssh/http dsh 目标无 cookie 注入（实例侧 401）**：五处同源绝对 URL 由构建期 vendor
  补丁集走本实例前缀（design 09 §3.6）；ssh/http dsh 目标的 cookie 注入属既有认证面，
  未覆盖。
- **gateway 来源的插件播种被拒（HTTP 400 `invalid_input`，2026-09-10 实机）**：dev 实例接
  `test`（`http://192.168.110.172:30801`）时启动日志三连
  `gateway plugin sync: uploading @dsh-chamber/dsh-chamber-seed-{client-graph,git-worktree,archive-cleanup} failed (HTTP 400: invalid_input)`。
  根因 = 该 gateway 是 2026-09「Batch 1 naming unification」之前的构建：`GET /chamber/plugins`
  实测只返回 `@dsh-chamber/dsh-host-client-graph`、`@dsh-chamber/dsh-host-git-worktree`
  （v0.2.4，两项），而现仓清单名是 `dsh-chamber-seed-*` 三项
  （`packages/gateway/src/plugins.ts:49-56` 从 control-plane 的 `CHAMBER_HOST_PACKAGES`
  派生并做命名钉死）——未知包名即 400。gateway 会在 body 里回 sanitized 原因
  （`unsyncableMessage`，`plugins.ts:144-147`（抛出点 `:186`/`:221`）→
  `routes.ts:1045-1057`；`sanitizeRouteError` 的 `keep` 词表保证 scoped 包名不被路径
  规则抹成 `[path]`，`sanitize-route-error.ts:20-26`），桌面侧把该原因经 sanitize 并入
  失败（`gateway-provider.ts:1448-1460`，`error` 于 `:1487-1488` 返回，经
  `GATEWAY_PLUGIN_SYNC` IPC `main.ts:3462-3464` 到渲染器），诊断不再断在 code。
  剩余 open = **就地重建旧 gateway 未排期**（改名后的种子包只能等该 gateway 升到带
  `dsh-chamber-seed-*` 清单的版本；桌面侧不做旧名回退播种）。

- **dsh 运行时版本管理（design 18 §3.6/§9）**：剩余——macOS 打包态 `.app` 内共享 dsh-runtime/内嵌 pnpm/koffi 与完整激活-故障回退-恢复链的实机；Linux
  server 同款端到端；Gateway 重启窗口的前端重连与 connections 的 SSH
  `restart_service` systemd IPC 端到端；`restartLocal()` 在真实 1s SIGTERM→SIGKILL
  grace 与健康计时器交错的覆盖；settings-bridge 的 gateway React 组件级交互仍以纯
  函数/API 客户端测试代证；ZFS 下全新 pnpm store 克隆偶发 `ERR_PNPM_EAGAIN`
  （失败投影诚实可重试，系统化并发缓解未排期）。
- **`protobufjs` / `@google/genai` 放行与上游裁决分歧（待 M2 首装门禁证据，2026-12
  登记）**：上游 `vendor/harness-checkout/pnpm-workspace.yaml:40-43` 对两者记 `false`
  并注明其生命周期脚本是 no-op（原文「those are no-ops we don't need, so we deny
  them」），本仓运行时 `ALLOW_BUILDS` 记 `true`（`packages/dsh-runtime/src/allow-builds.mjs:18-19`，
  差异理由见同文件 `:41-43`）。**对齐需一次真实 M2 全新安装的实测证据**（脚本是否真
  no-op、运行时闭包是否真需要执行），在此之前保留放行；`allow-builds.mjs` 的注释已指向
  本条。
- **连接 fork 的 `ownsGeneration()` 守卫是"无行为见证"的纵深防御（2026-12 登记）**：
  `packages/dsh-client-connection/src/client/index.ts` 的 liveness 接线层已由
  `test/client-start-liveness-wiring.test.ts` 覆盖（resume 绕过离线门、stop 拆卸全部监听、
  两道单飞门响亮失败、唤醒 burst 收敛），但 :387 的 `if (!ownsGeneration()) return` 无法被
  任何测试见证：其唯一可能生效的路径是 `registerGenerationSource` 的 disposer（`:336-341`
  释放 owner 却不拆触发器），而该路径必经 `releaseOwner`（`:298-305`）调 `controller.stop()`，
  `ConnectionController.reconnect()` 在 `!running` 时首行即返回（`connection.ts:130-131`）⇒
  删掉守卫行为逐字节相同（实测：删守卫后 7/7 全绿、专用探针输出 `diff` 无差异）。**不要为它补
  测试**（那会是新的假绿）；待裁决：留作纵深防御，或按死代码评估删除（`:354`/`:361` 两处同类）。
- **隐藏 span 的阈值语义只由触发器单元覆盖（2026-12 登记）**：接线层不断言
  `visibilitychange` 隐藏 ≥30s 的真时序（`start()` 不传 `now`/`hiddenReconnectThresholdMs`，
  `index.ts:379-401`），真测需实等 ≥30s。接线层只覆盖该 listener 的装配/拆卸；阈值语义由
  `test/liveness-triggers.test.ts` 单元覆盖。漂移面为零（接线不传该选项），如需接线层也见红则
  需给该调用加可选注入——按缺口严重性未做。
- **gateway 运维页缺三个变更入口（design 21 §7 runbook 口径，2026-12 登记）**：
  `packages/gateway/src/routes.ts` 内嵌运维页的 `RUNTIME_PATHS`（`:224-236`）只含
  status/versions/select/apply/apply-now/rollback/restore-builtin/retry-apply/
  retry-restore/restart/start/registry，**没有 `recover-metadata` / `cleanup-version` /
  `restore-pre-rollback`**（页面上亦无按钮），而三条路由本身存在
  （`packages/gateway/src/runtime-routes.ts:346`/`:362`/`:376`，路由表 `:498` 也列出）。
  后果：FATAL metadata 阻塞下 `recover-metadata` 是唯一不被拒的变更路由
  （`runtime-routes.ts:164-194` 门文本即「only recover-metadata is allowed」、
  `:203`），无头部署只能 curl 该端点——UI 入口待补。
- **apply-now 立即应用（design 18 addendum 实机门禁）**：macOS 打包态 `.app`
  运行中全链；Linux server gateway 生产 TLS 下 POST apply-now → 202 → 停机窗口轮询
  → 探针 → 故障注入回退；`restartLocal()` 真实 grace × 健康计时器交错；Gateway
  restart 窗口前端重连；Windows 只读投影。
- **桌面端更新（design 11 §9）**：用真实 Apple 凭据跑通一次发布 CI（Developer ID
  签名/公证/stapling/Gatekeeper）+ 双平台检查清单（确认前不下载、下载后退出安装、
  mac quitAndInstall 原生 quit 语义断言）+ 打包态 quitAndInstall 端到端与缓存清理
  （Linux AppImage 更新端到端另见 design 22 清单）。正式 macOS 发布缺凭据会在 Release
  mutation 前阻断；仅 `dry_run` 允许 ad-hoc mac 构建。
- **认证服务端 Gateway（design 17）**：剩余发布前实机门禁——生产 TLS 反代
  Host/Origin/XFF/Secure-cookie 与 SPKI pin 正/负例、真实 dsh `/api/remote.mux`
  断线恢复；打包 Desktop 三种代表形态（HTTPS+凭据 / HTTP+凭据 / 显式可信网络
  `--no-auth`）重启后 safeStorage/密码重登与凭据变更撤销 live stream；`/chamber/runtime`
  在生产 TLS 下全链；Linux system/user service 安装升级与回退；`--bind 0.0.0.0`/
  隧道/tailscale 全链负例。凭据管理剩余：desktop settings-bridge 便捷重置（推迟项）
  + 真实 TLS 下改密/轮换/停机态 CLI 恢复。
- **S0/S2 http 直连链路（design 17 §10.5）**：**S2-c（放宽 dsh mux 心跳，可选增强）
  未实现**——前置 = 扩展 gateway patch 写入器，单列。剩余验收：打包态实机（浏览器直连 gateway 的 Models/插件设置可
  写；杀托管 dsh/断网后 sidebar 60–120s 自动恢复；升级 dsh 版本复验钩子存在性）。
- **设计 21 网关插件能力对齐**：剩余——§9 实机 E2E 矩阵（真实
  gateway×desktop 双通道手动/脚本化门禁、registry 实装传递依赖与 lifecycle scripts、
  故障注入、journal 中断对账；发布前执行；.172 测试机 gateway 侧升级因凭据轮换
  暂停，待用户侧恢复后按 §9 重跑）；UI 余留照实：who/when 归因 tooltip 未渲染、
  gateway 拒绝码→本地化文案映射未做（409 逐字英文）、pollGatewayReady 英文错误串
  未本地化；archive-pick file+folder 双模式对话框为 **macOS-v1**（非 macOS 保持
  文件夹对话框，随 design 22/23）。
- **归档清理与归档管理器（design 24）**：剩余**仅测试类**——打包版实机目检（含
  幽灵行不再浮现、点击不再 `session/not-found`）、探针依赖实例就绪（fail-closed，
  行保持抑制）、语义级接线以源码契约 + 目检代证、集合 >65,536 不清扫（容量边界）；
  以及实机 **gateway/远程 dsh 形态**与打包版 UI 目检（视觉腿偏差/待目检并入该腿，见
  design 24 §6 与 §13 第 17 条）。
  **force 链剩余实机验收（design 24 §13）**：卡在提问的归档会话 → 管理器删除 → 停止 + 强制清理成功；旧宿主（无 `force` 参数）的回退 + 说明；
  运行中子代理后代所在归档树一次删除收敛；本机 5 个「已加载」残留
  （`d8ae9ae5`/`d4d9bdbf`/`c54461f6`/`32b74f4a`/`10d9124a`）一次删除收敛。
  **登记残余**：事件发射为文档化 no-op 直至上游 wire，域随上游 `sessions.delete`
  wire 落地后退休（上游未落地）；维护阶段（compaction/schedule）对外报 `idle`，
  force 可能删到正在追加的档（「读私有 phase 字段」为否决方案）；归档集合在 run
  起点快照、窗口内不重读。可选增强（未排期）：PluginDialog 三态行、rowError
  本地化、已归档浏览区（todo 12 A）、`preview` 暴露孤儿计数。
  **单删确认的空标题文案（2026-09 rc.1 验收实机所见）**：行内归档确认取自会话标题，
  标题为空串（侧栏显示占位「未命名会话」）时渲染成 `归档「」？`——`blank` 标记为假而
  `title` 为空的会话走不到 `t('session.new')` 回退；判据 = `SidebarRoot.tsx:1026` 的
  `t('confirm.archive', { title })` 调用点未对空标题取占位。
  **清理残留（同上验收；design 24 §13 口径，待裁决两条）**：① 单删成功后
  `storages/session_projcache/sessions/<id>.json` 仍留一份 4 KB 缓存档（该档 `title`
  已清、聚合缓存已移除）——主题档是否随清理回收未决（缓存，非权威面）：purge 只处理
  `dirname(persistence.locate(header).path)` 下的代际/发布暂存/迁移暂存/租约文件
  （`packages/dsh-chamber-seed-archive-cleanup/src/binding.ts:483-488` 定位、`:524-567`
  读取目录 + 白名单删除），实测该包 `src/` 对 `projcache` **零命中**，上游该域
  （`packages/session/session-projection-cache`）也没有随会话内容删除回收单档的入口。
  ② **会话迁移在飞时 purge 可能留一代窗口（内容面，尚未登记的窗口）**：迁移不是新建
  目录，而是在**同一会话目录内**由并发 write-open 发布后继代际
  （上游 `session-persistence-jsonl/src/index.ts:363-377` 的 claimWrite→lease→
  `publishStoredMigration`，落地点 `generation.ts:829` 的 `link(staged, currentPath)`）；
  purge 先 `readdir` 一次（`binding.ts:524`）再逐个 `rm`（`:544-554`），该 `link` 若在
  枚举之后落地，则本次删除不覆盖它，随后的 `rmdir` 以 ENOTEMPTY 失败并被**吞掉**
  （`:556-566` 的 try/catch）却仍 `return 'deleted'`（`:567`）——归档成员关系被清除、内容
  仍可读，且成员集不再含它 ⇒ 后续 purge 不再收敛。与 §13⑨（租约面，已登记）、
  §13⑬（force 删除后残档）同族但**是内容面**；判据 = 迁移进行中执行 purge。是否加
  守卫（写租约删除时机 / 二次枚举 / rmdir 失败不改判）待裁决。
- **移动端 Web 访问面（design 17 §18；实现契约见 §18.3–§18.5，门禁见 §18.6）**：
  **复核提出但尚未实施**（待实机证据或设计决策，均已登记 §18.6 门禁）：
  「移动中量化 + 静止吸附精确值」（现 16px 固定量化，实机看抖动再定）、
  设置分区滚动位置记忆（现为一律复位——tab 惯例，非严格更优：无稳定 section
  id、异步内容高度不足会钳到顶）、宽屏触控设备（iPad 横屏 1024px+）的键盘
  补偿（行为层与 CSS 同在 1023px 触屏档，扩展需设计决策）、原生 `title`
  长按气泡不抑制（刻意手势，且部分 title 是截断行的唯一全文入口）。
  **两处几何残留（2026-12 审查登记，需真机判定）**：① **769–1023px 触屏档第三轨被
  压 0**——触屏档 `@media (max-width: 1023px) and (pointer: coarse)` 把 grid 钉成
  `0 minmax(0,1fr) 0` 且 details 落第三轨
  （`packages/dsh-chamber-client-ui-mobile/src/client/styles.ts:128-144`），但上游的
  全屏替身只在 `<768px` 成立
  （`vendor/harness-checkout/packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx:364`
  的 `autoFullscreen = viewportWidth < 768`、`:371` 的 `track = shown && !autoFullscreen`）
  ⇒ 该档内展开的右栏既占不到全屏也不占轨道宽度；插件头注只声明了 `<768px` 那一半。② **`<768px` 全屏右栏（z-40）
  盖住 `shell.overlay`（z-20）内的汉堡/抽屉**——已按「官方全屏面拥有屏幕、抽屉让步」
  登记为有意（`styles.ts:61-69`），但真机上是否读作损坏未判。
  剩余——**实机门禁**（§18.6：真机触控目标比例/抽屉开合/键盘遮挡
  （含新补偿层的 iOS 时序与 Android WebView 盲区、**聚焦缩放后的打字正例**、
  缩放态平移不得引起抖动、捏合缩放负例、提交窗口不闪落、重挂 re-arm、
  死区 ≤23px）/安全区/汉堡不重叠/crumbs 换行/Session 日志图标化/iOS 单击
  切换/设置手机档走查（含分区切换重置）/刘海横屏/深层谱系高度等）；
  **移动端 git 侧边栏**（桌面链 chamber sidebar + `sidebar.workspace.git`
  座席为桌面专有形态，gateway 链官方 sidebar 无该座席；接入需装配矩阵第二
  客户端例外 + 移动交互设计，列为下一阶段）；DOM 锚点审计剩余（details 打标
  缺口修复的**接线仅实机可验**、composer
  锚点 fixture 化、Android 键盘盲区真机门禁）；P2（PWA 安装 + SW 壳离线，
  per-instance scope，尊重官方「不完整离线」立场）；P3（公网认证流转
  正式化 + Web Push；先行形态 = 内网/可信网络 `--no-auth`/tailscale）。
  - **连接稳定性（未修复，取证中；2026-12 评审证据）**：机制已源码级确认——
    唯一长连接 `/api/remote.mux`；实例侧官方 api-gateway 心跳 2s ×
    `MAX_MISSED_HEARTBEATS=2`（**硬编码不可配**，见安装树
    `dsh-api-gateway/lib/types/stream-server.js:4`）⇒ 静默 4–6s 即 `terminate`，
    且**在 gateway 侧完全无日志**；代理浏览器腿 30s / 1 miss（
    `WS_PING_MISSES_BEFORE_TEARDOWN=1`，拆链会同时销毁 upstream 腿）；客户端
    按 `dsh-client-connection` 指数退避（500ms×2 上限 10s）重连并 baseline
    replay；pending approval/question 在 generation 结束时被
    `remote-events.ts` abort、重投时**换新 key** ⇒ 草稿丢失、弹窗重建（命令
    菜单不关）。**本机日志复核结论**：gateway journal（9/04–9/09）只有 1 次
    浏览器腿心跳拆链 ⇒ 代理心跳不是主因；`audit.log` 无周期性 login（
    127.0.0.1 的 50–70s 突发为本机测试流量）；无周期性整页重载/SW 行为。
    有界**取证日志**（`proxy-forward.ts`：`WebSocket stream <id>
    closed (<cause>, <ms>ms)`，cause 无括号、logger 抛异常不锁死拆链）用于区分
    实例侧判死与客户端主动重连；**归因边界**：cause 记「先观察到哪条腿结束」，
    代理主动撤销也会记成 `upstream close`。下一步：浏览器 DevTools 抓
    `remote.mux` 的 **close code + 节奏**（1006 链路断 / 4000 客户端重连）；
    若为实例心跳，最小改动是给 patch overlay 增加 `config` 行能力（现
    `cordis-inserts.ts` 仅发 id/name）以调宽 `websocketHeartbeatIntervalMs`。
    复核否决的替代：**解析 close 帧（opcode 0x8）**——实例侧用
    `socket.terminate()` 不发 close 帧，解析器对目标场景盲；若日志不足，改用
    上游 ping 间隔计数（~15 行，复用 PongScanner）。另注意：桌面渲染器的 idle
    重连看门狗只按 transport 过滤（`packages/renderer/src/App.tsx:1459` 注释、
    `:1482` 轴说明，判据落 `:1502` 调 `reconnectStalenessMsForTransport`，
    阈值表 `aggregate-refresh.ts:119-123`：http 120s / ssh 300s / local 与未知
    跳过），**gateway 目标（dsh 与 gateway 两种 kind 同为 direct-http）也吃
    ~2min 一次的连接 bounce**——「桌面也发生」若指桌面 chamber App，此即现成解释。
- **Windows 首版（design 23）**：剩余全为**外部门禁**，台账见 `docs/progress/todo/windows-v1.md`  （已剪为剩余项清单；windows-baseline.md 首跑数据待填）：真实 Windows runner
  首跑绿（test-windows 腿，含 submodule 物化 + junction 建链）；M0.5 上游 dsh
  win32/NSIS protocols/Defender/原生依赖实证；M2a runner 事务矩阵；**M2b UI 翻转
  （纪律：M2a 真实 win32 全绿前不做）**；M3/M4 实机矩阵与打包验证。M5/M6 发布面
  决策/演练待发布前（另见桌面端更新、发布/CI 条）。
- **Linux 桌面（design 22）**：剩余实机门禁按 design 22 §7
  清单（GNOME X11+Wayland/KDE 抽验：XDG 自启、深链冷/热与 CHROME_DESKTOP/xdg-mime
  路由及升级后重注册、托盘/通知点击、safeStorage keyring、SSH 密码全链、运行时
  打包态全链、自动更新端到端、AppImage 沙箱与 Wayland 焦点；另复核 before-quit
  无头挂住行为）；release.yml dry_run 全链（需 GitHub 可达）；deb/arm64 后续。
  已知未动项登记于 design 22 **§5**（裸 CLI stateDir 提示、pnpm home 边角、
  private-fs 严格 fsync 审计结论等）。
- **桌面通知 / 未读徽标（design 19）**：通知剩余 macOS 权限/拒绝行为、点击打开、
  关窗/托盘/后台三形态与打包态实机；徽标剩余 macOS Dock 打包态三态（武装/解除/退役
  + 重载与退出清零）实机；Linux 仅 Unity launcher 家族可见（文档化平台限制）；Windows
  任务栏 overlay v1 门控未接线（design 23 实机矩阵排期）。
- **会话待办区（design 06 §8）**：剩余实机门禁——通用页开关即时生效、
  同源/跨来源/未常驻跳转与权威移除、折叠来源中目标、断连→重连重现、rail 不渲染、
  「还有 N 项」展开/收起与自动收起、展开内滚动（8 行上限）、拖拽尾随点击不误开、
  同会话内联重命名不打断、打包态。
- **open-in 超集分批口径（2026-09-11 复核裁决，design 20 §7.2）**：官方两份原先都没有"无应用出口"
  与"第二入口"（上游客户端只有一处槽位注册、无剪贴板面，读取失败即不渲染按钮），因此这两项是
  新增能力而非缺失回填。裁决：**S3 收窄为「复制路径」**（侧栏既有 `HoverCard` 复制模式
  `ServerSection.tsx:1892` + 会话行已带 `SessionRow.cwd`（`shared/instance-api.ts`）⇒ 零新 IPC、
  纯渲染层）；**复制 `ssh user@host` / VS Code 深链与 S4（侧栏入口、快捷键）不做** —— 依据：
  header 按钮与目标会话同排相邻、会话行**刻意无 kebab**（OpenChamber parity，
  `ServerSection.tsx:1188,1305`，加右键菜单需推翻既定决定）、快捷键缺基建（vendor 无 keybinding
  注册表，客户端只有聊天输入框自己的 keymap），且三处"今天无按钮"的来源
  （gateway-over-http、无本地 VS Code 的 ssh 来源、零目录应用的本地实例）都不在主流程
  （远程 dsh + VS Code Remote）上。完整形态留档
  `docs/progress/todo/open-in-ownership-and-enhancements.md` §5 附录 A/B。
- **VS Code 深链 + open-in（designs 16/20）**：剩余 macOS 实机
  验收——深链冷/热启动、打包态、托盘/退出在途、N-ctx、VS Code 缺失、`sshPort != 22`、
  本地应用下拉（实例内 host 包）在 vendor 会话头部的定位/层叠、远程来源仅 VS Code
  （新窗口/复用两态在打包态真机确认）。
- **Git Worktree 插件（design 08）**：剩余真实远程 Linux + Git 仓库端到端（首次
  ready-time seed 后重启生效、并发 session 删除竞态、Git LFS/filter 与恢复边界）；
  剩余实机验收——运行中会话（未归档）→ 删除被拒并给出诚实文案；同会话归档后 →
  工作树删除成功且该会话未被停止/删除、其 cwd 消失后日志仍可读；运行中子代理位于
  已归档根下 → 不阻塞。归档管理器是唯一「停止运行中回合 → 清理已归档内容」的入口。
- **远程实例插件管理（design 13）**：本地 `dsh plugin`/`pnpm pack` 依赖
  `resolvePnpmBinDir` 对 PATH/nvm/volta/homebrew 的 best-effort 探测——需打包态实机。
  剩余实机验收：本地/ssh/gateway/http 四来源的 chamber 表行数=3、archive-cleanup 的
  installed/patched/live 三态与「注入/重启」按钮行为、gateway seed-cache 漂移列。
- **会话创建/fork 侧边栏收敛延迟修复**：剩余本地 + 远程 SSH 实例实机验收（行出现
  延迟、状态图标延迟、位置跳动）。
- **发布/CI 基础设施**：test job 抽 reusable workflow 供 release.yml 复用（长期目标，
  现靠策略测试与人工同步，有漂移风险）；vendor submodule 剩余验收（Windows runner
  物化 + junction 建链、CI 真跑、release.yml 改动后 workflow_dispatch dry_run）；
  Gateway npm 分发未决策（现仅 GitHub Release `.tgz` 分发）；打包闭包自检（CI 增加
  「主进程传递模块闭包 vs build.files 清单」机械检查，长期建议）。
- **性能遗留真实机清单（P0–P2 轮）**：`docs/progress/performance-baseline.md`
  §7 五条实机复测全开放（宽侧栏冷 settle CLS、连点冷挂载切换、版本事务主进程阻塞
  采样、更新模式侧栏写频、H3 懒加载验证——需打包版或带会话 dev 实例）。
- **性能整改第二阶段（视图保留/后台门控/行窗口，2026 A/B/C/D）剩余实机验收**：
  剩余——打包版/带会话 dev 实例同环境 A/B（measure-ui：DOM 节点分壳/堆/空闲长任务/合成
  输入帧/预热壳数）+「打开→切走→重开 ×3 堆无净增长」（×3 需多次快照序列）；
  验收表与语义偏差见 performance-baseline.md §10 与 design 05 §4 注记。已知取舍
  （登记）：被回收壳内运行中任务完成蓝点/通知边沿暂停至源重开（冷 boot 首报重
  播种）；侧栏聚合落 30s unary 兜底（05 §2.3）。
- **SSH 密码一键免密引导与系统钥匙串（05 §8）**：未实现（现行为 endpoint-bound 0600
  明文镜像，见取舍）。
- **模型额外参数 + 默认推理等级（design 07）**：wire 白名单无泛化透传、host 组合不
  可注入——待上游解锁；`agent-default-model` 客户端**可读可写**（`settings.describe`
  不过滤 namespace，旧 `exposedNamespaces` 机制在当前 pin 已不存在，见 design 07 §2.4），
  但回显/设置入口不在本蓝本范围内，**实现未排期**。

## 一致性债务与开放登记（低–中，未排期；均指回代码面注释/design 登记）

- **设置面图驱动贡献集残余（design 05 §5 / 09 §4·§5；剩余登记）**：
  桌面设置壳对选中来源的贡献集 = 「基础集 + 该来源自己的客户端插件图」
  （`clientGraph/graph` − `CHAMBER_COVERED_IDS`，经页面级 union 模块表装载，与 boot
  同一 kernel）。剩余与有意偏差：
  - **T2（真实 WS remote）未接线**：child ctx 的 `remote` 仍是手工 unary 面 +
    `$on` no-op；三种能力面（`$on` 订阅 / `$mount` / `$stream`）由 stub 按调用者归属
    记录并在「插件设置」诊断页**如实逐条报告**（`CAPABILITY_REMOTE_EVENTS` /
    `CAPABILITY_REMOTE_MOUNT` / `CAPABILITY_REMOTE_STREAM`，`$mount`/`$stream` 为具名
    抛出占位——`$dispatch` 已删，官方 remote 从无该成员）。全量接线需在 child ctx 内挂载官方 connection /
    api-gateway / api-remotes（第二条 WS/来源 + 生命周期 fencing），且失败模式从
    「面板降级」变成「基础链 5s 门失败 → 整个面板失败」——故按需推进，触发条件与
    取舍见 design 09 §4 与 T3 提案；未接线期间不得声称保真等价。
    **未接线的具体后果（2026-12 登记，用户问询后补全）**：
    ① **面板常开期间数据不自动刷新**——官方 settings 镜像的刷新触发点是
    `settings/document-updated` / `connection/reset`（vendor ui-settings index.ts:62-69），
    两者在 child ctx 都不发生，且**无轮询**；面板内 child ctx 按来源缓存复用，故
    「切走再切回」同样不刷新，唯一自动恢复路径是**关闭面板重开**（重新装配 →
    重新 `settings.describe`）。影响面**含官方分节**（不只是第三方插件）：别处
    （另一窗口 / CLI / gateway 其他用户 / 该实例自身前端）的改动在面板内不可见。
    这是**预先存在**的降级（旧 stub 同为 no-op），非本次引入。
    ② **13 个 Remote 命名空间缺席**（官方客户端挂 15 份生成 Remote / 19 个命名空间：
    `workspace`/`commands`/`goals`/`skills`/`subagents`/`fileUploads`/`fileReferences`/
    `directoryPicker`/`dynamicCordisRunner`/`messageFeedback`/`sessionReferenceResolver`/
    `sessionFeedback`/`workspaceFiles`——前 15 份贡献见
    `vendor/harness-checkout/packages/api/remotes/src/client/index.ts:150-159` 与本地锁步表
    `packages/renderer/scripts/typert-remote-contract.mjs:21-37`；19 = 这 15 个包内带
    `@Remote` 的 `TypertRemoteService` 子类总数（三份贡献各带多个命名空间：
    `api/session-controller` 3 个 = `session`/`fileReferences`/`skills`、
    `api/settings-controller` 2 个 = `settings`/`credentials`、
    `api/workspace-controller` 2 个 = `workspace`/`directoryPicker`）），
    child ctx 只有 6 个（`packages/dsh-chamber-client-ui-settings-bridge/src/client/bridge-context.ts`
    的 `remoteFaces()` 与其后的 `ctx.provide('remote.*')` 六项：`settings`/
    `credentials`/`llm`/`agentPresets`/`session`/`pluginInventory`）且
    `session`/`pluginInventory` 为子集 → inject 缺失可**事前**
    报告（fiber PENDING + 缺失服务名），不 inject 直接调用则**调用时**失败（contained +
    渲染崩溃报告）。
    ③ **`connection` 是假面**：无 `state` 可观察量、`rpc` 为空对象、`start()` 为 no-op、
    `$host.home` 为 undefined → 读连接状态/走 generic RPC 的插件表现同上（缺服务或崩溃）。
    ④ **与官方前端/gateway 链不对称**：同一插件在实例自身前端（真 remote）可用、在桌面
    设置页不可用或陈旧（17 §10.5 同源）。
    **不是后果**：设置读写仍落目标宿主（`isLoopback` 固定 true → `persistence='host'`）；
    官方分节功能完整；每来源贡献来自自身图（本主题的设计目标）；扩展插件侧无静默。
    **残余盲区**：①"渲染了但一直为空"且未调 `$on`、未崩溃的插件，与"该插件没有设置"
    不可区分；②官方分节的陈旧**不产生任何提示**（能力报告只覆盖扩展插件）。
    **不做 T2 的低成本缓解（候选，未实施）**：面板加「重新读取数据」动作（重跑
    `settings.describe`；现有「重新加载」只重取插件图）；并把"面板内不自动刷新"的语义
    写进组装诊断块文案（现仅对第三方 `$on` 订阅提示）。
  - **依赖闭包扩展默认关**（`DEPENDENCY_CLOSURE_ENABLED=false`，机制与测试已就绪）：
    把扩展行 `inject` 声明的 covered 依赖作为 provider 先挂进同一 ctx；默认关闭是
    有意决策（未激活插件已如实列出缺失服务），按实测证据逐个放行。
  - **模块级状态共享**：页面模块表按 id first-load-wins，同一模块实例可支撑多来源/
    多 fiber（宿主实例另有 boot ctx 副本 = 双挂载）。契约 = 插件模块级无状态；跨来源
    共享事实在组装诊断块（设置 → 连接 → 该来源卡片）报告，但不构成隔离保证。
  - **bundle CSS 页面驻留**：模块表只给 `<style>` 打 `data-plugin` 标记，回收仅发生在
    被 chamber 排除的 HMR 行 → 来源插件的样式一旦加载即驻留到页面结束（与 boot 路径
    同一事实，不假装可隔离）。
  - **执行面扩张已登记**：装载发生在「设置面板打开的来源」（原先仅「已打开 shell 的
    来源」）；面板关闭 / 切换来源即 dispose。design 09 §4 已写为契约。
  - **壳不渲染的座位**：`settings.trigger/header/close/onboarding` 刻意不渲染，第三方
    贡献只报告不呈现；`settings.action` 保持「仅本地来源」限定。
  - **未实机验证**：无真实实例/打包态环境，第三方插件装载、双挂载副作用、遮蔽看门狗
    与 `onEntryError` 诊断均只经单测与静态走查确认，待实机冒烟。
  - **上游提案未排期**：`contributes.settings` 声明式描述符 + 设置面服务契约 +
    descriptor 上线通道见 `docs/progress/todo/settings-surface-upstream-contributions.md`。
- 私有文件纪律三实现（cp `private-file.ts` 抛错式 vs dsh-runtime `private-fs.ts` kind
  结果式，同名异签）——统一需依赖方向裁定（design 18 §9.1）。
- **`install-gateway.sh` 的 dsh 锚走 npm 安装（design 18 §4 单一来源的域外点，2026-12
  登记）**：`scripts/install-gateway.sh:1180`（升级路径另见 `:1271`）以
  `npm install --prefix <anchor_dir> @deepseek-ai/dsh@<version>` 安装内建锚——npm 没有
  pnpm 11 的 `strictDepBuilds`，故**不经过** `packages/dsh-runtime/src/allow-builds.mjs`
  的单源裁决（另两个同源生成点：`packages/dsh-runtime/src/runtime-installer.ts:1129` 与
  `packages/desktop/scripts/bundle-dsh.mjs:128` 都经 `renderAllowBuildsBlock()`）。触发
  条件：该脚本安装到带安装期脚本的新依赖时，放行/否认集在此路径上不可见；一致性靠
  `dsh-upgrade-checklist.md` 的人工复核条，无机械锁步。
- **`client-web` fork 的未使用依赖 `@deepseek-ai/dsh-client-ui-theme`（待锁文件窗口，
  2026-12 登记）**：`packages/dsh-client-web/package.json:29` 仍声明该 workspace 依赖，
  但 fork 的 `src/` 对它的引用已全部退役（token 表改由 `packages/renderer/src/styles.css`
  引入，见 CHANGELOG「五份 ui-theme token 表」条）。**不能只删 package.json 一行**：
  锁文件 importer（`pnpm-lock.yaml:452` 起的 `packages/dsh-client-web` 段含该
  `link:` 条目，`:466-468`）不匹配会让 frozen 安装失败 ⇒ 删除必须与锁文件重生成同批。
- **layout fork 的共享 `ThemePresenter` 永不回收（登记残留，2026-12）**：
  `packages/dsh-chamber-client-ui-layout/src/client/index.ts:52-56` 用模块级单例
  `documentThemePresenter ??= new ThemePresenter()`，实例 teardown 不 dispose——有意
  （vendor `dispose()` 会无条件收回全部文档级写入并抹掉活动视图的调色板，见
  `document-theme.ts:5-9`）。残留事实：最后一个壳卸载后文档仍留 `html{color-scheme}`、
  `body[data-ds-dark-theme]` token 与 theme-color meta（正是「投影属于下一个活动视图」
  的代价）。
- **`sidebar.workspaces` 声明但壳从不渲染（2026-12 审查登记）**：
  `packages/dsh-chamber-client-ui-sidebar/src/client/contract/slots.ts:44-49` 声明该座、
  `src/client/index.ts` 的 `ctx.slots.register` 子键表里 claim（`:50-52` 注明保留声明
  只是为了 ui-workspace 的注册不失败），但 `SidebarRoot.tsx` 只渲染
  `sidebar.brand.mark/brand.name/panellist/footer.action/settings` 与 `sidebar.workspace.git`
  （`:291`/`:1371`/`:1377`/`:1393`/`:1491`/`:1494`，workspace-git 见 `:321`），
  浏览区由自有多来源列表取代官方 occupant（`:1434-1436` 注释）。触发条件：任何第三方
  插件往该座注册——注册**成功且无报告**，页面上永不出现（与设置面「壳不渲染的座位
  必须报告」的纪律相反）。待裁决：撤掉该声明（改为不 claim，让注册响亮失败）或在
  诊断面报告该座的注册者；两条都需要 slot 语义裁定。
- wire 载体（A–F）登记维持：P4-3 A↔C 传输层合并**裁定不合并**（前置 ①–⑦，任一项
  未决前不动 A/C 传输面）；E（git-api）禁改（见 `wire-common.ts` 注，P4-1/2/3/N6）。
- sanitize 语义矩阵（core/desktop/gateway/installer 四成员）与 win-probes↔
  windows-process 孪生：互注无机械锁步。
- dashboard（gateway 浏览器运维页）仍为独立第三份运行时 UI，不共享 sidebar 的
  parse/poll 核心（D-2，共享核心迁移列后续）。
- C-F7 undo 语义不对称：ssh「撤销=恢复」vs gateway v1 undoForLatest（仅最新 ok
  install→remove，`dsh-chamber-client-ui-settings-connections/src/client/plugin-model.ts:488-499`
  的 `undoForLatest`）；服务端 `preImage` 备份只被保留与引用计数回收
  （`packages/gateway/src/plugins-journal.ts:13-22`、`:241-247`），**没有任何运行时
  恢复消费方**——r2 的 preImage 回滚与 r4 的操作员子命令都是 **design 21 §6.8 r2/r4
  二期，未实现**（§6.8 r2 与 §7 的措辞已对齐：兜底是 operator runbook，恢复路由
  默认二期）。
- C-F8 `GET /chamber/plugins/installed` 裸读未入写栅栏（撕裂读仅 loud 500）。
- C-F12 desktop 本地 plugin add 子进程 env 未 scrub（gateway executor 与共享 runtime
  installer 已白名单化）。
- C-F13 readManifest 三后端无共享联合（design 21 §3「单一定义」措辞未兑现）。
- A-U3 desktop `SETTINGS_SET` 无 busy/pending/env 门（env 维度放行为有意；busy/pending
  维度对称性待决策）；A-F16 `DSH_HOME` 布局默认偏 desktop（共享推导点防误读登记）。
- dual-host 语义下沉延后：activation-facts/startup-verdict 映射、restart 拒绝织、
  apply-now 门（整门合并不做，见下取舍）、identity-probe 腿——其中**只有 3 处以
  ruling 注释登记在代码面**（activation-facts 孪生对
  `packages/desktop/main.ts` 的 `readActivationFacts()`「ACTIVATION-FACTS DIVERGENCE」
  注（`:4360`）+ `packages/gateway/src/runtime-manager.ts:950`，
  identity-leg `packages/dsh-runtime/src/runtime-probes.ts:390`），restart 拒绝织与
  apply-now 门无代码注记（后者取舍只在本文档下条）；统一需新 dsh-runtime 公开导出
  （dist 锁）或行为裁定。
- 0.2.2 审查跟进残留（低优 UX）：会话行动作仍 hover-only（键盘/触屏无揭示路径）；
  仓库组折叠 × 会话待办条带张力（确认产品意图后过滤或文档化）；chamber 表最坏徽标
  组合窄窗可能横向撑破（实机目检后定）；en 单数文案、行移除 aria-label 覆盖可见
  文本、行无 `<label>`、ssh done 态 stale 行按钮可用、无 PluginDialog DOM 测试、
  对账空态双提示；settings-dshruntime：PUT registry 成功不 bump versionsEpoch（旧源
  数据至下次自然刷新）、30s 超时文案双层措辞、围栏/超时逻辑内联组件 effect（可测性
  债务；窗口级残余服务端读侧无害 ≤3s 自愈）。
- **`test:gateway` 宿主服务隔离（2026-12 实机定位）**：残留/约束——
  D2 跨形态清理的固定单元名是安装器设计行为（跨形态迁移必须停旧形态）；
  `install-script.test.ts` 仍有 2 处直接 spawn 真实安装器（`--help`/
  `install --version`，当前只走用法/解析即退出），若未来让它们走更远会再次逃逸
  （宿主安全桩只覆盖库切片 harness）；`03:16:06` 的同签名停机未被钉死（/tmp 证据被
  容器重启清掉），01:22 的非优雅死亡与 01:35 陈旧锁接管已解释为容器被外部非正常
  终止 + 网关自身的锁接管恢复，09-07 23:45:29 已解释为手工 install/update。
- **N-ctx 文档级主题投影归属（design 06 §4.6）**：剩余=打包态实机目检——首屏、视图
  切换与回收窗口的 checkbox 深浅，以及预热视图不再互踩主题（验收前须
  `pnpm run dist:desktop:mac` 重打包：安装态 `.app` 可能落后仓库一个构建）。
- **Git 来源分支候选（design 08 §4.2 尾条）**：剩余=打包态实机目检（判别期 harness
  gateway 停机，wire 快照仅由 host 代码路径 + 宿主 git 事实推断）；unborn（零提交）
  仓库 `branches` 必空 + 默认 base 40 零直送 git 无 preview 门仍为代码面已知残留
  （实机无此形态）。
- **样式门 `verify:styles` 的扫描面之外：非代码引用需人工纪律（2026-09 风格对齐轮登记）**：
  S1–S7 只扫 `packages/`＋`scripts/` 的 `.css|.ts|.tsx|.html`（`scripts/dev/verify-style-tokens.mjs`
  的 `STYLE_FILE`），故两类引用不在覆盖内，改名/改值后必须手工跟：
  - **`docs/**/*.md` 的 token 引用**：本轮把 `--dsh-source-accent`/`--dsh-workspace-accent`/
    `--dsh-mobile-kbd-offset` 改为 `--chamber-*` 后，`docs/design/06-sidebar-enhancements.md:572,580`
    与 `docs/design/17-server-side-gateway.md:1385` 仍写着旧名；`OpenInButton` 描边
    1px→0.5px 后 `docs/design/16-vscode-deeplink.md:266` 仍写 1px——三处均已人工改正，
    但**没有门禁会再拦下一次**（`.md` 不在 `STYLE_FILE`，且设计文档不是 i18n 对）。
  - **包级 `README.i18n.yaml` 哈希记录**：`verify:i18n` 只管根目录 5 对文档，包级记录
    是纯人工纪律（文件头自述），故**已漂移**：`dsh-chamber-client-ui-settings-bridge`
    的 `README.md`、`dsh-chamber-client-ui-settings-connections` 与
    `dsh-chamber-client-ui-sidebar` 的两侧，记录哈希与文件不符（**先于本轮改动**，已用
    `git status` 确认这 3 包的 README 本轮未被触碰）。修复前提是**先人工复核该包中英
    两版内容仍对等**再重录——直接按当前文件重算等于给未经复核的内容盖章。
  - 三种记录格式并存加剧漂移：mobile/settings-bridge 用 sha256（前者嵌套 `en:`/`zh:`、
    后者平铺），client-web/connection 用 git blob SHA-1 且注释指向**仓内不存在**的
    `pnpm run verify-translation-pairing --write`。统一格式并纳入门禁是后续候选。

## 设计未决

- **起始端口偏移**：本地默认 17510、控制面默认 17500；当前固定起始端口 + P+1 重试 +
  记录仲裁，是否开放配置仍未决。
- **trusted-host 自定义 Host**：当前反代 Host 与实例自身 `127.0.0.1:<port>` 一致；
  未来引入自定义 Host 时须同步扩 trusted-host 集。
- **多控制面 `$DSH_HOME` 冲突**：同 stateDir 共享 home 时会话 JSONL 可追加，settings
  由 dsh 的 `settings-conflict` 仲裁；是否进一步隔离未决。
- **多控制面 catalog metadata 无跨进程 CAS**：label/accentColor 并发修改是
  last-writer-wins；可靠多 writer 需 kernel-backed 跨平台 lock + 锁内 reload + 字段
  intent，否则应正式改为「并发 plane 必须不同 stateDir」。普通 pidfile/mkdir stale
  lock 存在三方 takeover 双持，不能作为修复。
- **响应头白名单双处同步**：权威在 04 §4.3，仍建议把代码/文档表述进一步单源化。
- **`__DSH_BOOT__` 随 dsh 版本漂移**：manifest 形状继续以 vendor `parseBootManifest`
  为准维护。

## 范围决策与必要取舍（不做 / 推迟 / 移出 / 偏差）

- **git 客户端与宿主的错误码重叠是「有意的显式例外」（design 08，2026-12 登记）**：
  `path-unavailable` / `workspace-path-unavailable` 同时是宿主可重试码与客户端确定性
  拒绝码——客户端把它们从宿主 `RETRYABLE_CODES`
  （`packages/dsh-chamber-seed-git-worktree/src/core.ts:392,400`）提升为确定性
  （`packages/dsh-chamber-client-ui-git/src/shared/git-api.ts:95-98` 的
  `DETERMINISTIC_HOST_RETRYABLE_OVERRIDES`，理由见 `:79-94`）：两者都出自宿主
  `existingPath` 探针，重放只会再跑同一失败探针并把有行动价值的拒绝换成永远重放的
  恢复项。宿主保留可重试是**因为同一码也会在已提交删除之后的
  `reconcileBoundRemove` 里出现**（`core.ts:2504-2595`）。该重叠由
  `packages/dsh-chamber-client-ui-git/test/host-client-lockstep.test.ts:286-296` 显式
  钉死（未登记的漂移即红）⇒ 属性是**取舍**，不是缺陷。
- **移出项（P3 硬纪律）**：匿名 control-plane 的认证/审计、薄壳聊天/会话列表/审批
  弹窗、控制面会话 runtime/统一索引、连接 broker/绑定、walkthrough、通知中心/历史、
  MCP、文件夹/笔记、web 预览、目标/终端等不得回流。设计 17 的独立 Gateway 认证/
  派生编排、设计 18 的共享 dsh 运行时核心、设计 19 的 Electron 原生边沿通知、设计 08
  的实例内 Git 插件、设计 20 的可信 open-in 边缘能力与设计 24 的实例内归档清理宿主
  域是边界明确的例外，不得泄入匿名 control-plane、引入 session 消费者/通知历史，或
  变成第二套执行面（design 24 例外随上游 delete wire 落地退休，不作他域先例）。
- **`--no-auth` 是醒目的可信网络有界例外**：Gateway 外部部署默认必须认证；只有显式
  传 `--no-auth` 才可覆盖，启动器二次确认并打印安全告警。不是静默 fallback，也不
  授权普通匿名 control-plane 绑定公网。
- **Gateway state 根目录自动收紧**：既有 stateDir 经 pinned no-follow 描述符自动收紧
  0700 + 属主 uid 校验（异主 fail-closed）；broad root 拒绝与 Windows 继承 ACL 让步
  不变（design 17 §12）。
- **safeStorage 的诚实回退**：Gateway 凭据优先 safeStorage；OS 加密不可用时按用户
  决策回退 target-bound 0600 明文并如实显示，不把 plaintext 冒充密文。SSH 密码为
  endpoint-bound 0600 明文镜像。**Windows 例外（C16）**：DPAPI 不可用时拒绝明文落盘，
  凭据仅内存驻留（每次连接重录）——S22 明文兜底仅限非 win32。
- **Windows 发布身份让步**：x64 安装包未做 Authenticode 签名，SmartScreen 提示是
  已知取舍；feed sha512 只证明下载完整性，不等价于发行者签名。
- **macOS 平台范围让步（不做 + 推迟）**：GitHub 已退役最后一个公开 Intel runner
  （macos-13，其矩阵腿在每次 v0.1.0 运行中永久排队），v1 **不发布 macOS x64**——
  mac 腿只有 `macos-latest`（arm64）；x64 侧另因 `bundle:dsh` 烘焙宿主平台的 dsh
  运行时、交叉构建需 Rosetta 工具链工作而**推迟**（证据：`release.yml` mac 腿与
  Linux 腿注释）。
- **N-ctx 单文档信任域**：连接远端实例让其前端与同一 renderer 文档内其他实例及高
  权限 preload bridge 共域；现有 main-frame/origin/proof/主进程确认只能缓解，真正
  横向隔离推迟到每实例独立 WebContents 架构。
- **N-ctx 壳常驻语义收窄（2026 性能整改偏差，已登记代码注释与 design 05 §4）**：
  05 §4 的「booted 壳无限常驻 / 视图生命周期 = 注册表条目生命周期」收窄为
  chamber 保留策略——local 恒留，隐藏壳最多保留 RETAINED_HIDDEN_VIEWS=1，超限
  回收「已 settle + 连续隐藏 ≥60s」的最久者（回收 = dispose shell + 卸载壳，
  实例进程/连接不受影响，重开冷 boot）；被回收源不再自动预热直到用户点开。
  运行中任务的完成蓝点/通知边沿随壳回收暂停至重开（取舍登记，见上条目）。
- **不做（v1）**：跨来源移动会话、单 store 真融合、控制面会话实时同步、远程实例
  管理 UI 外壳。**推迟**：flat 单列表模式（与「仅按来源分类」呈现原则有张力）。
- **保留项（2026-09 裁决，仍有效）**：`ALLOW_BUILDS` 的 `fs-ext` **保留**（回滚目标
  0.1.3-alpha.2 仍依赖，删除即安装失败；登记在 `pnpm-workspace.yaml` 与
  `packages/dsh-runtime/src/allow-builds.mjs`）；`runtime-host-adapter` 退役**不采纳**
  （是测试夹具契约，非死代码）。
- **设置壳偏差**：未连接实例不装配子 ctx；stub remote 无 WS 失效流；壳不渲染官方
  SettingsRoot、子 ctx 懒装配；服务器选择器 body portal + viewport 翻转/钳位与内部
  滚动；离线远端仍可选并显示不可达占位与连接管理动作；chrome 跟随宿主 locale，子
  ctx 跟随目标实例 locale。
- **默认排序 `manual`（06 §3.1）**：按 wire 顺序，与官方默认 `updated` 不同，是
  有意产品取舍。**窗口标题冻结**：桌面原生标题固定 `dsh-chamber`。
- **样式 token 对齐后的两处未对齐（2026-09 风格对齐轮登记，均为有意/待裁）**：
  - **菜单圆角 12px vs 上游 20px**：`AccessibleAppMenu.module.css .menu` 与
    `SettingsShell.module.css .dropdownList` 是官方 `ui-primitives/Menu.module.css .list`
    的逐项移植（218/360px 宽、4px 内边距、`--dsw-specific-menu`、l1 stroke 重绑、
    elevated-prominent、z-index 1100/1200 全同），唯余 `border-radius: 12px`
    vs 上游 `20px`（`PopupSelectView` 同为 20px；上游该行注释写 "r12" 属过期注释，
    代码为准）。属圆角而非边框，本轮未动，改 2 行即可。
  - **open-in header pill 规格不对应任何 pinned vendor 面**：`OpenInButton.module.css`
    为 32px / `0.5px border-l2` / r18，而 pinned vendor 的
    `session-query/session-log-export/HeaderAction.module.css` 是 28px 圆形 + `border: none`
    + r28，官方 `ui-open-in-app/OpenInAppAction.module.css` 是 28px / r14 / `border-l4`
    分体按钮——旧注释自称「vendor Session log pill 逐字复用」不属实（**先于本轮**，
    本轮 1px→0.5px 后已把注释改为陈述事实并标注差异）。是否对齐到上游其中一款是
    设计决策，非缺陷修复。
- **Electron 二进制惰性安装**（每机器共享 dist，worktree 并行共用）；**dev 实例隔离**
  （独立 user-data、控制面端口 17520 起自动退避）。
- **内建版本行引导（2026-12 决策，方案 2）**：选中与内建同版本行且未装受管树、
  存在用户选择时主按钮引导「恢复内建」（零下载；树/快照保留），「仍下载并安装为
  受管版本」为显式次要动作；gateway 部署锚分支同款镜像。
- **dsh 运行时设置面（2026-12 统一）残余偏差（有意保留）**：desktop `SETTINGS_SET`
  在 env 下允许更换 registry（设计文字禁、代码有意更宽）；恢复期矩阵两侧已收窄对齐
  ——swap-attempted/snapshot-failed/restore-blocked/FATAL 只开放各自 retry 与
  recover-metadata，restore-builtin 仅限 pending/健康选择（armed reset 在持久恢复
  标记下必然复阻，旧矩阵格不可执行）；registry 白名单形状 desktop https-only vs
  gateway http-loopback（共享 canonical 更宽，桌面层收紧）；desktop 15s+6h 周期检查
  不移植 gateway（避免周期出网）；失败现场清除入口仅本地（gateway 无对应路由）；
  `status()` metadata health 检测无缓存；metadata 恢复期 pnpm prune 子进程不可 abort
  （退出延迟）；desktop main.ts 的 RUNTIME_RESTART 等 handler 内联无单测（renderer
  镜像 + lockstep 代证）；env×FATAL（dormant corrupt selection）预路由为 desktop 独有
  （gateway env override 经共享核心等效处理 + 激活探针门）。
- **apply-now 门形态取舍**：desktop `evaluateApplyNowGate` 是纯投影门、gateway
  `applyNowPreflight` 是含副作用 preflight——输入与副作用各异，整门合一将推翻逐轮
  对齐语义，**不做整门合并**（两 owner 保留各自投影/执行层）。
- **探针契约残余（design 18 §3.4 定稿后）**：上游 `session.list` 分页/裁剪/删除能力
  仍待上游（chamber 不落地实现；设计 24 退休条件同源）；归档「不能瘦身」事实维持
  （探针不再读列表，归档仅影响列表体积）；legacy 回退 warn 为可选注入 sink（desktop
  与 gateway 未注入即静默；control-plane 两生产点已注入）；激活层对上游再漂移的
  可见性以失败路径为准（fail-loud）；desktop SSH attach 底线 ≥ 0.1.2-rc.1（旧树由
  signature 路径给出确定性 terminal「check or upgrade」）；远端瞬时重启/路由挂载窗
  口双 404 → 通用 terminal（粘滞窗口先于探针改动存在，与「已答即确定性」分类一致；
  ready 心跳降级为瞬态的改法引入 60s 慢重探 churn，取舍留给未来设计）；
  `verifyUp` 必须在自有限期内 settle（transport 层裸 await，无外层超时）。
- **0.1.2 线已知降级（仍有效）**：
  - 远端/直连 0.1.2 dsh 附加被硬阻断（launch token 为远端进程内存随机数、隧道不可
    恢复；上游提供 token 检索机制前保持）。dsh×http 组合已在表单与主进程校验禁用
    （http 只服务 gateway；ssh 为 dsh 唯一传输——design 17 §3 记有恢复点）。
  - 版本芯片：本地已接线，远端隐藏（D2 兜底）。
  - cookie Max-Age=30 天无会话中重换：过期后约 10 分钟健康失败窗口触发重启换新
    （自愈；「cookie 过期即重交换」另行排期）。
  - remote-stream 接收面帧校验宽松于上游 exactKeys（接受未知键，前向兼容容差）。
  - settings-bridge agentPresets/select 以合成 `{agentId:'',agentPreset}` 发出：
    一旦被调必响亮失败（当前无调用点，潜伏面）。
  - 端口碰撞理论面：本地实例同端口 cookie 覆盖（实际不可达，登记不修）。
  - unary 兜底归档过滤无 wire 源（归档集仅存在于 follow baseline）——仅影响未挂载
    来源与首次 baseline 前窗口（KNOWN DEGRADATION，`archiveSetKnown:false` 诚实三态；
    2026-09 归档回流修复后：已推送过的挂载来源断连期间保留其推送视图
    ——`shouldRetainPushedAggregate`——重连 ready-edge 不再整提交兜底降级视图；
    残留/历史降级视图由兜底看门狗限流触发 ctx 连接重连（`shouldRebaselineFallbackView`）
    重放 follow baseline 自愈）。
  - **首屏「整源降级直到被点击」的登记残留（design 05 §2.3「首屏基线收割」；机制见
    `packages/renderer/src/baseline-harvest.ts` 与 App 接线）**：0.2.3 性能整改移除
    「每个 ready 来源最终串行挂载」旧通道后，首启只有 local 挂载 + 1 个预热槽且不
    轮转、被回收来源在用户点击前禁预热，于是 N-1 个 ready 远程源**稳态停留**在
    unary 兜底视图（合成工作区分组 + 空归档集 ⇒ 已归档会话按普通行浮出、无真实
    工作区动作），直到用户点该服务器（`selectView` 重挂载 → follow baseline）；
    **全部自愈臂都要求 `mounted===true`**（`shouldRebaselineFallbackView`、S2 stale
    臂、`planSessionListRefresh`），对首屏未挂载源永不生效，30s 看门狗只重复提交
    同一份全量兜底。首屏基线收割即针对该形态：ready 未挂载源在后台预热槽挂一次、
    首个权威推送即回收（尝试上限 2、失败退避 120s；存在收割候选时独占后台槽，
    托管 dsh 停机的 gateway 源不预热/不收割）。
    **剩余验收=打包态实机**：首启 N-1 源在收割窗内出现真实分组与归档过滤、稳态无
    驻留壳、慢隧道/失败源退避不卡 boot 链、收割期用户点击不被回收。
    **登记残留**：①尝试耗尽仍未拿到基线的源（`harvestParked`）**不再退回普通预热**
    （否则白拿第三次 boot 并长期占用唯一后台槽），保持未挂载并停在兜底视图，只能
    靠用户点击自愈；②已收割源的归档集在两次收割之间冻结（外部客户端变更 / 未挂载
    源的设计 24 purge 需**用户点开（重挂载）**才可见——已满足基线的源不再回到收割
    队列，与下条同族）；③首启每个 ready 源各付一次后台 boot（稳态 ≤1 壳不变，属
    性能取舍；启动窗口内用户首次点击的排队概率上升，最坏受 60s boot 预算约束；
    **收割有独立预算线**——用户保留的隐藏温壳不再永久挡死收割，代价是收割窗口内
    最坏多一个隐藏壳）；④**最后收割的壳被保留为温壳**（省掉一次预热 boot，且该源
    的挂载期状态事实保持在线），遇到新收割候选时由 `shouldReclaimHarvestedShell`
    让位；⑤**降级列表的诚实标注**（`source.baselinePending`：`connected &&
    aggregateReady && archiveSetKnown !== true` 时就地提示"基线未就绪/降级列表"），
    托管 dsh 停机另有就地原因 + 恢复入口提示（`source.managedDown`，状态词复用既有
    `status.*`）。
  - **gateway 形态 `ready` 不蕴含托管 dsh 就绪的登记残留（sidebar `shared/managed-runtime.ts`
    + App 15s 前台探针）**：desktop 的 ready 只证明 gateway 进程活着
    （`ssh-provider.ts` 的 `verifyUp` 只探 `/chamber/runtime/status`），侧栏**不消费**
    该响应的 `connectionState`，因此托管 dsh 停机/重启窗口内 UI 无降级投影：`+`
    建会话入口只在非 synthetic 真实工作区行渲染、状态显示（运行环/pending/完成点）
    只存在于挂载 producer 推送，"transport ready 而 dsh 已停"的窗口里按钮可点而
    背后不可用（dsh 直连目标无此问题——verify 直接探 dsh 本体）。现行投影：判定走
    **独立字段** `managedRuntimeDown`（只在该源传输 `ready|degraded` 且探针报终态
    停机时为 true——绝不从合并后的 `phase` 反推，两套词表都含 `error`，反推会把
    隧道失败误诊为托管停机）；终态停机（`stopped`/`error`/`restart-exhausted`）把
    phase 换成该状态并置 `connected=false`（动作入口按既有语义禁用）；`starting`/
    `restarting` 同样投影并折叠进 `connected=false`（dsh 未服务，动作只会 503；
    侧栏另有 `source.managedStarting` 说明行）；`degraded` 保持传输态、呈现为
    **未连接**（`instanceConnected` 只认 `ready`，会话子树隐藏）；探针缺失/非 200/
    代理失败一律 **fail open**（绝不拿缺失探针隐藏健康来源）。
    **剩余验收=打包态实机**：真停托管 dsh 后侧栏由绿转红且 `+` 禁用、重启后自动
    恢复；探针周期与 `/api/connections` 轮询叠加的请求量目检。
    **登记残留**：①托管 dsh 停机**不门控 unary 兜底 watchdog**——从未挂载的 down
    源仍每 30s 拉一次（503 + 3s×5 重试突发），行已隐藏；接进 `collectReadySourceIds`
    需单独裁定（该谓词多处共用）；②托管停机源的来源头**不再是可激活入口**（无
    role/tabIndex/onClick，title/aria 改为说明原因）——该路径原本到不了失败覆盖层
    （boot 成功、body 渲染空壳，vendor ConnectionBanner 无 owner），故就地补一行
    原因 + 恢复入口（`source.managedDown`）；深链/通知仍可激活该源（App 侧按注册表
    权威放行，落空则由失败覆盖层呈现）；③settings-bridge 在 `connected=false` 时把
    整个设置面板换成 `targetUnavailable`；"托管 dsh 停机但隧道正常"形态已改用
    `managedDshDown`（"网关可达但托管 dsh 未运行"），「管理连接」按钮既有；
    **剩余** = 托管 dsh 停机的恢复原语（`/chamber/runtime/start`）仍未从设置面板
    直达（现需走 connections 页的「启动实例」）。
  - **同一份文档的其它逐实例全局量（2026-12 复查登记，design 06 §4.6「同族残留」）**：
    主题投影为活动视图独占，但同族还有六处——①**文档级 `drop` 扇出（真实
    缺陷，未修）**：vendor `ui-attachment/ComposerAttachments` 在 document 上挂
    drop 且无归属判定，两个壳同时挂载时一张图会同时附到两个实例的草稿；②**`<html
    lang>` last-writer-wins（真实缺陷，未修，且被收割放大）**：vendor `locale` 每次
    boot 写且无 teardown 回收，预热/收割实例的 en locale 会把可见文档翻成 `lang=en`；
    ③`document.title` 竞争写（被桌面主进程冻结标题掩盖，当前不可见）；④
    `--dsh-content-font-size` 播种读到上一个 applier 的值（下次投影自愈）；
    ⑤**portal 逃逸（真实缺陷，未修）**：vendor `ui-primitives/Modal`（含 backdrop）
    与 chamber SettingsShell/AppMenu portal 到 `document.body`，`.instance-hidden`
    只隐藏视图子树——A 的模态在程序化切换后仍盖住 B；同族 `DropOverlay` 每壳一份
    （N 层遮罩，隐藏壳的禁用副本可能盖住活动壳的启用副本）；⑥主题样式表每壳各插
    6 个 `<style>`（同内容、随 fiber 移除，良性重复）。①②的修法同主题：按活动来源
    门控（②可纯 chamber 侧实现），需 seed/patch 路线裁定后实施。
  - **活跃视图的"数据面拉活"仍缺席（2026-12 评估，未实施）**：对**当前活跃**来源，
    点会话行不触发任何聚合刷新（`openSession` 只做导航分发；`selectView` 对活跃
    视图早退），其新鲜度完全依赖后台通道（30s 兜底 watchdog / producer 推送 /
    `requestRefresh`）。推送与 unary 同时失效时视图**静默冻结在最后一次推送**
    （App onInstanceSnapshot 的保留分支），且无错误提示——恢复只能靠重挂载/页面
    刷新。**评估结论**：交接建议的"ready 且上次推送超阈值就对活跃源强制 ctx 重连"
    **不宜直接照做**——ssh 目标被 S2 臂**有意排除**（隧道 keepalive + loopback 稳定
    已保护，空闲源超过 120s 无推送是常态，按 recency 重连会对所有活跃 ssh 源产生
    周期性白 churn，见 App.tsx S2 臂注释 M1）。正确判别信号是**推送视图与 unary
    权威列表的分歧**（合并拉取时若 unary 会话行与推送视图不一致 ⇒ follow 流已陈旧
    ⇒ 触发一次限流 ctx 重连重放 baseline），需要新的分歧判定 + 限流记账；与
    design 24 §12 幽灵行收敛共用"以 unary 为权威"的语义。排期未定。
  - 推送通道死亡期间侧边栏成员关系/归档集冻结在最后推送（sessions 仍刷新、恢复推送
    自愈；冻结窗口内新归档/取消归档不可见）。
  - 兜底 cwd 派生分组限制：符号链接拼写（macOS /tmp vs /private/tmp）可能不匹配
    canonical-cwd 索引；未挂载来源的新建空工作区不可见（fail-closed 语义）。
  - git 工作树删除时 runtime 通道缺席 fail-closed（'runtime-unknown'）。
  - unary 长命令豁免残余与治本（design 03 §3.4；豁免本体见 CHANGELOG
    [0.2.2]/[0.2.3]，不在此复述）：超 30 分钟保险丝的极端业务仍被
    **显式截断（504 + abort）、操作未完成、会话一致性无损**（保险丝计数发布
    中非零即复访取值）；治本——上游把 `commands.execute` 改为受理即回、结果
    经会话事件流交付（验收：受理回执形状、终态错误分类、对等待 unary 语义的
    官方客户端影响；退役：上游落地并经 chamber 验证后名单与保险丝一并退役）
    ——宿主非 chamber 可写范围，登记上游跟踪项；上游若异步化，dsh-runtime
    激活/身份探针（runtime-probes 以伪 session 直连宿主期待同步
    `session/not-found` 信封）须平行迁移（探针走直连端口不经代理、与豁免窗口
    无交集）。
- **代理 300MiB 响应体上限 ⇒ 大会话导出为已知降级（2026-12 登记）**：控制面非 SSE
  响应体上限 `MAX_RESPONSE_BODY_BYTES = 300 * 1024 * 1024`
  （`packages/control-plane/src/proxy-forward.ts:50`，与上游 0.1.2 线 300MiB 请求上限
  同口径）；声明长度超限在 `:877-884` 直接 413 `body_too_large`，流式超限在
  `:951-960` 销毁 upstream 并按 headers 是否已发决定 413 或断链。上游
  `session-log-export` 的 `/api/session.export` 返回**完整 ZIP 流**
  （`vendor/harness-checkout/packages/session-query/session-log-export/src/index.ts:42`
  路径常量、`:150-166` 响应构造），chamber 已把它补丁到本实例前缀（CHANGELOG
  D3 五处之一）故用户在 UI 上可直接触发。触发条件：单会话响应体（DEFLATE 后 ZIP，
  `descendants=true` 时含全部 subagent 代际）> 300MiB ⇒ 下载中断/413，无分片逃生口。
  不修：抬高上限同时抬内存与带宽预算（同文件 `MAX_BUFFERED_REQUEST_BYTES` 口径），
  上游改分片/可恢复下载后才消除。
- **平台词偏差 C3（2026-09 性能审计，已登记 dsh-client-web platform.ts /
  seed.ts / renderer chamber-entry.ts / shell.ts 注释）**：上游 `PLATFORM_MODULES`
  仍列 `@deepseek-ai/dsh-client-ui-primitives`，chamber 自建平台集不再 seed 该词
  （其整包命名空间导入把 markdown/高亮栈拖进 App 挂载前的 main-graph 求值）；
  改由 composite covered factory 回答 extra 行的同步 require 边，前置保证 =
  chamber 入口先于任何 extra bundle 装载（shell.ts C3 门 + host-graph.ts
  `awaitBeforeLoad`）。依赖面：本地/远端 profile 的 extra 行与用户插件 client
  bundle 的 primitives require 由该工厂回答；残余窄竞态 = shell 侧 chamber
  prefetch 失败后 create 期并发 materialize（extra loud 降级、重试自愈，
  见 chamber-entry 头注）——非静默。实测（build 产物快照 2026-09，终版 dist
  见 `packages/desktop/dist/web/perf-sizes.json`（`build:renderer` 产物，被下次
  build 覆写；读取方 `packages/renderer/scripts/check-chunk-budgets.mjs:36`）与
  performance-baseline.md 字节快照节）：主图
  1,403,568 → 1,185,439 raw（−218KB / −77KB gzip），chamber 入口净 +217KB
  → C4 后再 −176KB（分步再着色）；vendor 栈仍经内核 onboarding 静态链留在
  主图（部分收益，剩余面待内核懒化）。
  **跨代依赖（版本歪斜下的可见后果）**：实例侧 `ui-sidebar-documentpreview` 的代码预览
  **行为依赖**与 composite 同代的 `ui-primitives`（`CodeBlock` 的 `contentRef` 经
  `[data-code-block-content]` 成为其唯一滚动/行定位锚点）。composite 比实例旧一代时，
  该行失去独立滚动区、代码行定位失效（纯文本仍可用）——即本条「不 seed、由 covered
  factory 回答」的偏差在歪斜下从体积优化升级为可见功能面。
- **settings 簇 deferred C4（2026-09 性能审计，已登记 chamber-entry.ts /
  chamber-covered.ts 注释）**：官方 ui-settings **保留首屏**（locale/ui-theme
  首屏 root-inject 其 `settingsScope`，defer 会瘫痪壳）；其后移的是 4 个官方
  settings section + chamber settings shell/connections（chamber-entry
  registerDeferred，+6 import 站点）。语义：可观测瞬态仅「设置入口缺席
  ≈1 chunk 往返」（页面首个实例首冷启一次性，其后模块缓存同 tick 解析；
  六家同 tick 注册，无中间「官方 SettingsRoot 空壳」帧）；每服设置面板
  内容经 child ctx（bridge-context mountBridgeSession）独立装载，不受
  boot-ctx 时序影响。失败面（登记）：任一 import 失败 → 整个簇本 boot 缺失
  （含 connections CRUD、dsh-runtime 管理与更新），console loud 无重试、
  靠 shell 重 boot——与既有 deferred 家族同模式；按家族 allSettled 独立
  注册为候选改进（bridge 失败可落官方降级面）。
