# 模块完成状态总览（STATUS）

> 本文档只追踪**未完成 / 部分完成**项（含剩余实机门禁）、**设计未决**与**必要取舍**（范围决策 / 已知偏差 /
已知降级），是 dsh-chamber 进度追踪的唯一记录。已实现基线以 git 历史、`CHANGELOG.md` 与 `docs/design/`
为权威；不记完成叙事、测试计数/绿灯清单、提交哈希、批次轮次台账、实现过程复述或临时对齐块。

## 未完成 / 部分完成（剩余验收）

- **实机门禁（未验证；缺真实实例 / 打包态环境）**：
  - 多来源 sleep/wake 与隐藏恢复、版本歪斜容忍、gateway 形态回归；
  - **隐藏/遮挡态节流修订（2026-12，design 14 §D1 修订；S-10 降级后的实机门）**：Chromium 默认节流下需打包态真实实例复核——最小化与被其它窗口完全覆盖（未最小化）两工况下的 rAF/定时器/`visibilityState` 与 App Nap 语义、隐藏 ≥60s 期间 SSE/推送不断、唤醒后即时重连与首帧渲染、两条 30s 兜底轮询隐藏期跳过 + 恢复补偿一轮；统一登记在 [deviations.md](deviations.md) 的 S-10。
  - **vendor 性能补丁（2026-12）可见态 A/B**：待真实 app 同环境复核；跨环境不可比纪律见 `scripts/perf/README.md`。
  - 右侧栏栈真实 profile 装载时序与 `provideRoot` 时序、session v3 迁移真实存储行为；
  - **open-in 实例内 host 包（`dsh-chamber-seed-open-in`，本地形态专用）**：两代 runtime 装载探针（`ctx.subprocess` 在旧 runtime web profile 是否挂载 = 最大未验证风险）、图标抽取一致性与 `openInApp/icon` 的 base64/缓存/CSP 实测、远程无 cookie fence、remote cwd 填充（设计 20 §6/§10）。**macOS 实机验收**
    ：本地等价目录顺序 + 键盘；真实图标一致与缓存命中；Finder/Terminal/iTerm/Cursor/VSCode 拉起且落工作区、
    `DSH_PERMISSION_MODE=workspace-write` 不拦；无应用环境诚实隐藏；ssh 只有 VS Code
    两态、无本地项、图标与本地逐像素同源、本机未装则不渲染；插件管理页行集 4/3
    行与远端无该包目录、注入按钮门与「重启生效」态；N-ctx 三来源同页不串台； 打包态 `dist/host-open-in-package` seed
    成功；内置 0.1.2-rc.1 与 pin 0.1.5-rc.2 装载探针绿（**最大未验证风险**）。 **§2 仍开放**：机器目录 base64 体积/CSP
    实测；Windows 盘符/UNC 的 host 侧口径（design 23）；第三方编辑器 scheme 逐个验证（S1 前置）；上游升级时 fork
    折入流程（`FORKS` 表豁免 + C1/C3 可执行性 + `patched` 是否足够重锚）。
  - **写入期终止失败后闩锁只能靠重启应用再证明（design 02 §3.4）**：`onWriterQuiescenceUnknown` 无扫描证据可依（记录可能已删），对本平面生命周期粘滞；触发 = 受管进程组信号被拒或子进程终止超时。
  - **实例写者静默门拦住自动启动恢复路径（同上验收）**：shell 被 `SIGKILL`/孤儿 dsh 占住 DSH_HOME 时如实拒绝（
    `409 connection_busy`）但「启动/停止」点不动（状态停 `starting`、端口 0），恢复 = 优雅重启应用；仅硬杀后出现。
  - **降级提示目检/实机腿（05 §4，2026-12）**：结构性缺口下三处座位一致性——横幅 ~5s 出现/自愈后以「若仍然如此…」回来、侧栏行不重复播报、连接页卡片不同时出现「正常/能力受限」、提示非阻断与 `role="status"`、与 body portal 叠压；目前只经单测 + 源码锁，**未真机判**（`gui-acceptance-checklist.md` §3）。
  - **boot 死区收敛实机门（05 §4.1，2026-12）**：未连接（idle）远端点击其会话 → 遮罩立即给「连接」+ 切换行且**不启动 boot**（该挂载隐藏满保留宽限后回收；设置面板正在编辑的来源不回收）；`error` 与托管 `stopped`/`restart-exhausted` 来源 → 就绪门 1.5s 宽限后判不可服务（不再等满 60s），`degraded`（重连在途）**不判死**、仍在预算内等，两者都在能退回本地；挂死 boot → **超过**反馈窗（10s）后遮罩给出重试/连接/切换 + ⌘R 提示；502（隧道通、远端端口死）→ 非阻断 `.boot-gap` 横幅 + 每 ready 世代一次自愈。**Swift 打包态**复测遮挡/最小化下仍收敛（与 S-10 同批）。契约与归谬见 design 05 §4.1；判定纯函数与接线锁在 `packages/renderer/src/source-readiness.ts` 与 `packages/renderer/test/lifecycle/source-readiness.test.ts`，通道失败上浮在 `packages/renderer/test/lifecycle/host-graph.test.ts`。

  - **idle 来源点会话排队到 68s 才失败（05 §4.1 推迟 boot 的代价，2026-12）**：`open` 在 `QUEUED_OPEN_TIMEOUT_MS`(68s) 内等不到壳就以打开失败收尾；窗口内点「连接」可在 settle 后补发，但没有"连接成功后自动打开"这条腿。候选收口 = App 记下被推迟的 open 意图并在来源 ready 时重放（须与既有 pending-open 队列语义对齐）。

- **Swift 原生运行期监督（未实现；两条正交缺口，2026-12 复核）**：① **控制面**：原生壳只在首载前探一次 `/health`（S-45）；sidecar 进程活着而事件循环卡住时无人发现（`SidecarSupervisor` 只看进程退出码，stderr 仅作诊断）。候选收口 = 前台有界周期探测 + 「重启 sidecar / 重新加载」动作。**留在 STATUS 而非新增 deviations 行**：它无 Electron 对应面（Electron 控制面在进程内），恢复方向差异已由 P-09/S-02 覆盖。② **渲染器**：`RendererHangWatchdog` 是整页存活探针（`evaluateJavaScript("1")`），需"15s 无输入 + 3 次探测"，任意键鼠即重置，且 `didFinish` 前完全未武装——而窗口在 `didCommit` 就已呈现，于是"首帧脚本求值期冻结"与"用户持续点击期冻结"都没有原生超时（页面侧定时器同样停摆），只剩 ⌘R。与 05 §4.1 的页面级逃生正交；可选收口 = `didCommit` 后武装首载超时。

- **宿主 cwd / 安装根（2026-09-17 实机事故，未修）**：宿主进程 cwd 落在打包 bundle 的 dsh 安装根（Swift 拼写 `…/sidecar/vendor/dsh`，Electron 为 `resourcesPath/vendor/dsh`；`packages/control-plane/src/spawn-dsh.ts:322,735-736`），该 bundle 被原地替换（dev 重装 / 自动更新）后旧 inode 被 unlink，`worker_threads` 共享 `process.cwd()` ⇒ 每个工具调用 `uv_cwd ENOENT`（session worktree 未被删，重启应用从新安装根起宿主后自愈）。修复三件（复核补充：**不是一行改**）：控制面 cwd 不落在可替换路径——但 dev 兜底以裸 `--import tsx/esm` 启动、Node 从 cwd 解析该裸说明符，全局改 cwd 会打断 dev 源码启动，须把说明符绝对化或只改装配态分支；worker 不依赖 `process.cwd()`（vendor 上游 → fork/补丁 + FORKS/C 门，按升级维护）；安装/更新原子化 + 运行中检测（宿主是 detached spawn，会活过控制面，替换前必须先停/重定宿主）。

- **ProMotion / 120Hz 实机验收（未完成；口径与退役判据见 deviations S-48 / design 25 §5.1）**：
  残余 = **打包态**三工况实机验收；另需确认 `POC_DEBUG=1` 的 `[native-fps]` 观测只在调试态
  出现（S14/T-11 调试面纪律）。

- **gateway unit 登录环境真机门（2026-09-15，待 Linux 判）**：`write_unit` 无 `User=`、注入
  `HOME/LOGNAME/USER/XDG_CONFIG_HOME`（`scripts/install-gateway.sh`，design 17 §5）；单测只钉文本/结构。真实 systemd
  上 `systemd-analyze verify` + 服务拿到 HOME（`ghauth status`）须重跑安装器 + `daemon-reload` 后在部署机判——macOS
  开发机无 systemd，未判。

- **ssh/http dsh 目标无 cookie 注入（实例侧 401）**：五处同源绝对 URL 已由 vendor 补丁集走本实例前缀（design 09 §3.6）；cookie 注入属既有认证面，未覆盖。

- **gateway 来源插件播种被拒（400 `invalid_input`，2026-09-10 实机）**：旧 gateway 只认 `dsh-host-*` 旧名 ⇒ 现仓
  `dsh-chamber-seed-*`（`gateway/src/plugins.ts:49-56` 命名钉死）被拒；gateway 回 sanitized 原因（
  `plugins.ts:144-147`/ 抛出点 `:186`/`:221` → `routes.ts:1045-1057`，
  `sanitize-route-error.ts:20-26`），桌面侧并入失败（`gateway-provider.ts:1448-1460`/`:1487-1488` →
  `main.ts:3462-3464`）。剩余 = **就地重建旧 gateway 未排期**（不做旧名回退播种）。

- **`install` 就地重装不同步 dsh 锚基线（`.172` 实机，待裁）**：`install-gateway.sh` 的
  `--dsh-upgrade/--no-dsh-upgrade` 只对 `update` 生效（`:3674-3676`），install 复用已存在锚（`:1137`/`:2292`）⇒
  锚与托管 dsh 可能停旧代；壳升级自愈事务（F4，design 18 §3.5；`gateway/runtime-manager.ts:1049`）发
  `submittedAttachments`（`runtime-probes.ts:25-38`/`:483-495`）对旧代回 `gateway/arguments-invalid` ⇒
  探针必败、实例被停并留 `gatewayruntime startup blocked: swap-attempted; managed dsh left stopped`（
  `gateway/src/index.ts:486`）。就地收口 = 升锚后重跑该事务。**待裁**：`install` 是否该像 `update`
  一样校验/同步锚基线。

- **dsh 运行时版本管理（design 18 §3.6/§9）**：剩余——macOS 打包态 `.app` 内共享dsh-runtime/内嵌 pnpm/koffi 与完整激活-
  回退-恢复链实机；Linux server 端到端；Gateway重启窗口前端重连与 SSH `restart_service` systemd IPC 端到端；
  `restartLocal()` 真实 1sSIGTERM→SIGKILL grace × 健康计时器交错；settings-bridge gateway 组件级交互仍以纯函数/API
  测试代证；ZFS 全新 pnpm store 克隆偶发 `ERR_PNPM_EAGAIN`（系统化并发缓解未排期）。

- **`protobufjs`/`@google/genai` 放行与上游分歧（待 M2 首装证据，2026-12）**：上游 `pnpm-workspace.yaml:40-43` 记
  `false`（脚本 no-op），本仓 `packages/dsh-runtime/src/allow-builds.mjs:18-19` 记 `true`（理由
  `:41-43`）；对齐需一次真实 M2 全新安装证据（是否真 no-op、闭包是否真需要执行），在此之前保留放行。

- **连接 fork `ownsGeneration()` 守卫是「无行为见证」的纵深防御（2026-12）**：
  `dsh-client-connection/src/client/index.ts:387` 的守卫无法被任何测试见证——唯一生效路径必经 `releaseOwner`（
  `:298-305` ）调 `controller.stop()`，而 `reconnect()` 在 `!running` 时首行返回（`connection.ts:130-131`）⇒
  删除行为逐字节相同。 **不要补测试**（会是假绿）；待裁：留作纵深防御或按死代码删除（`:354`/`:361` 同类）。

- **隐藏 span 阈值语义只由触发器单元覆盖（2026-12）**：接线层不断言 `visibilitychange`隐藏 ≥30s 真时序（
  `index.ts:379-401`），真测需实等 ≥30s；语义由 `test/recovery/liveness-triggers.test.ts`
  单元覆盖。漂移面为零；如需接线层见红需加可选注入——按缺口严重性未做。

- **gateway 运维页缺三个变更入口（design 21 §7，2026-12）**：`gateway/src/routes.ts:224-236` 的 `RUNTIME_PATHS` 缺
  `recover-metadata`/`cleanup-version`/`restore-pre-rollback`（页面无按钮），三条路由本身存在（
  `runtime-routes.ts:346`/ `:362`/`:376`，表 `:498`）。FATAL metadata 下 `recover-metadata`
  是唯一不被拒的变更路由（门文本 `runtime-routes.ts:164-194`/`:203`），无头部署只能curl——UI 入口待补。

- **apply-now 立即应用（design 18 addendum 实机门禁）**：macOS 打包 `.app` 运行中全链；Linux server 生产 TLS 下 POST
  apply-now → 202 → 停机窗口轮询 → 探针 → 故障注入回退；`restartLocal()` 真实 grace × 健康计时器交错；Gateway restart
  窗口前端重连；Windows 只读投影。

- **桌面端更新（design 11 §9）**：真实 Apple 凭据跑通一次发布 CI（Developer ID/公证/stapling/Gatekeeper）+ 双平台清单（确认前不下载、下载后退出安装、mac quitAndInstall原生 quit 语义、打包态端到端与缓存清理）仍未在**签名正式包**确证；缺凭据在 Releasemutation 前阻断，仅 `dry_run` 允许 ad-hoc mac 构建。

- **认证服务端 Gateway（design 17）**：剩余发布前实机门禁——生产 TLS 反代Host/Origin/XFF/Secure-cookie 与 SPKI pin 正负例、真实 dsh `/api/remote.mux` 断线恢复；打包 Desktop 三形态（HTTPS+凭据/HTTP+凭据/`--no-auth`）重启后 safeStorage
  重登与凭据变更撤销 live stream；`/chamber/runtime` 生产 TLS 全链；Linux service 安装升级回退；`--bind 0.0.0.0`/隧道
  /tailscale 负例。凭据管理剩余：desktop settings-bridge 便捷重置（推迟）+ 真实 TLS 改密/轮换/停机态 CLI 恢复。

- **S0/S2 http 直连链路（design 17 §10.5）**：**S2-c（放宽 dsh mux 心跳）未实现**——前置 = 扩展 gateway patch 写入器。剩余验收：打包态实机（浏览器直连 gateway 的 Models/插件设置可写；杀托管 dsh/断网后 sidebar 60–120s 自动恢复；升级 dsh
  后复验钩子存在性）。

- **设计 21 网关插件能力对齐**：剩余 §9 实机 E2E 矩阵（真实 gateway×desktop 双通道门禁、registry 传递依赖/lifecycle、故障注入、journal 中断对账；发布前执行；.172 升级因凭据轮换暂停待恢复）；UI 余留：who/when tooltip 未渲染、拒绝码→本地化映射未做（409 逐字英文）、pollGatewayReady 英文串未本地化；archive-pick 双模式对话框为 **macOS-v1**。

- **产物新鲜度守卫只覆盖两个产物（2026-12 §6.11）**：`desktop/dist/control-plane/**`（
  `control-plane-freshness.test.mjs`）与 `gateway/dist/**`（`build-smoke.test.ts`）已有「存在但缺当前标记 ⇒
  失败」守卫 ；其余陈旧无测试变红——`desktop/dist/web/**`（`electron-shared.test.mjs` 只断路径文本）、
  `dist/preload.cjs`、`dist/host-{graph,git-worktree,archive-cleanup,open-in}-package/**`（
  `build-host-graph-package.test.mjs` 只断言行序 /outDir；C8 守已提交 `dist/index.js`）、
  `gateway/host-packages/**`（仅存在性）、vendor `allowBuilds` 锁步、`renderer/src/generated/**`。G1–G8 见
  `todo/product-freshness-guards.md`，design 21 §7 已登记。失效判据：每个产物有「 陈旧 ⇒ 红」守卫或进入豁免表（G8）。

- **CI 无任何腿能证明 SMOKE PASS**：`control-plane/test/smoke.test.ts` 在 CI 恒 SKIP（不设 `DSH_CHAMBER_DSH_PATH`、无
  `ref-dsh`/vendor 运行时），release.yml 同样没有 smoke；`ci.yml` 只接受显式 `SMOKE PASS` 或显式 `SKIP: …`（静默 exit
  0 会红），绿灯从未代表真跑过安装链。失效判据：至少一条 CI/发布腿真跑出 `SMOKE PASS`（或明确改判「不做」并登记缺席理由）时删除本条。

- **A1 状态呈现面（2026-12 普查；F1 已修，四组合由 `packages/desktop/test/plugins/plugin-sync.test.ts:333/:353` 钉住）
  **：剩余确证项——F2安装提示无条件承诺「下次重启生效」（`PluginDialog.tsx:972/1005/1027/989-992/1069/1994`+
  `locales.ts:226/289/363`）→ 按行分级承诺；F3 materializeLive 把「重启+就绪」当已生效（`PluginDialog.tsx:1058` +
  `locales.ts:301`）；F4 instance-version-conflict 断言版本差异而输入建立不了该差异（
  `client-plugin-loader.ts:206-214` → `host-graph.ts:791-805`，措辞被
  `renderer/test/lifecycle/host-graph.test.ts:787-812` 钉住）；F5 同源 restart-required 报「另一个版本」（
  `host-graph.ts:806-810`）；F6 侧栏 recheck 把 boot已拒的图治成 ok（`plugin-graph-recheck.ts:198-212` vs
  `host-graph.ts:251-266`，应复用boot 校验器并报降级）；F7 ssh bundle 断言用本地 bundleLines 判远端（
  `main.ts:3521-3532` + `plugin-sync.ts:1329-1360`，应读远端自己的 `dsh.bundle`）。疑似未动：S1
  `plugin-graph-recheck.ts:212`；S2 `client-plugin-loader.ts:253/:281-288`；S3 `writer-diagnosis.ts:63-74`；S4
  `plugin-inventory-text.ts:145-172`；S5 `PluginDialog.tsx:883-891` + `gateway-provider.ts:1467-1484`；S6
  `host-graph.ts:836-841`（死/只写 API，清理）。失效判据：其余各条修复或显式裁决（原普查台账已删，本条即权威）。

- **A2 尺度错配（2026-12 普查）剩余**：A2-4 apply-phase 拿内建哨兵与打包 semver 等值比较（
  `dsh-runtime/src/apply-phase.ts:256`、`desktop/main.ts:4700-4703`、`gateway/runtime-manager.ts:1009-1013`）→
  相位边界归一；A2-5 registry-metadata 预发布排序反了（`registry-metadata.ts:289-305` vs
  `dsh-runtime-updater.ts:141-174`）→ 复用同一比较器；A2-7 `dsh-runtime-controller.ts:461-462` 读 raw pending，而
  `:375-377` 与 `override-lifecycle.ts:71-75` 用 effectivePending → 门与动作同源。**潜伏项 A2-6**（
  `host-graph-seed.ts:478` 原始字节 vs utf8 串）非现网缺陷：种子集当前只含文本、图标不进种子，且
  `readPrivateFileNoFollow` 对非 UTF-8 响亮失败；一旦加入二进制种子即踩中。失效判据：各条修复或显式豁免；A2-6 =
  种子集出现二进制文件前改字节级比较并加「非 UTF-8 种子文件」回归。

- **A3 聚合吞未检项 / 读失败当确定结论（2026-12 普查）剩余**：A3-1/2/3/4 保鲜门自证（
  `verify-upstream-touchpoints.mjs:1037-1040` 与 `plugin-protection-gate.mjs:160-189`；`:505-533` 双侧改名 `0===0`；
  `:938`/`:956-1000`/`:996-997` esbuild 缺失仍「全部通过」；`:592-617 --no-artifact-rebuild` 零条目仍 ✓）；A3-5
  `restore-lockfile-vendor-records.mjs:171-188`/`:245-248` 四处假过且 `--check` 未进 CI；A3-6
  `release-preflight.mjs:106` vs `:103` 未读 package 当已覆盖；A3-7 `protected-plugins.ts:790` 零检查与通过不可区分（
  callers `main.ts:2029-2036`、`gateway/src/plugins-exec.ts:855-885`）；A3-10 `plugin-sync.ts:805-808`（+`:1082-1088`/
  `:1376`）manifest 读失败当 plain、bundle 臂跳过仍 `verified:true`；A3-11 `main.ts:2033` 空 familyNames ⇒ `{ok:true}`
  零日志（对照 `protected-plugins.ts:769`）；A3-12 `ssh-plugin-journal.ts:234-265` + `main.ts:3572-3573` +
  `PluginDialog.tsx:680-681`；A3-13 `dsh-runtime-store.ts:1130` catch ⇒ `[]`；A3-15 `snapshot-store.ts:1012-1013`/
  `:1085` 非目录根 ⇒ `[]` 且 `skippedReason 'none'`；疑似 S1–S13（release-preflight/vendor-pin/gateway/desktop/ci
  面各一处；S12 = CI SMOKE 无 PASS 腿，已单列）；**同类高危 A3-14 保留原文**：known-good 的 `.corrupt` 无人读 ⇒
  保护版本可被删。失效判据：读失败/未检必须与「确认无引用 / 空 journal / 通过」可区分（不删任何东西、preImage
  保留、原始字节留证 ），各条由回归测试钉住；逐条修好或显式豁免。

- **bundle 层行拿不到「是否已生效」信号（design 21 §6.6）**：生效格按 Loader 快照 `moduleName===包名` 精确匹配，未命中一律中性（`plugin-inventory-text.ts:252` 的 `thirdPartyLiveState`）；bundle 包名从不是 Loader 行 ⇒ 用户后加的
  `dsh.bundle` 层刚装未重启与已生效同呈现。闭合 = 新增宿主事实
  `Local/RemotePluginManifest.bundleLayers?:Array<{name, patchRows}>`（`patchRows` 取 `dsh.bundle.patch.insert[].name`
  去重保序），渲染端与 Loader 快照求交后才有「生效中/加载中/重启后生效」——属新宿主面，需单独评审（design 21 §7
  已登记）。失效判据：事实落地并被消费，两种真实状态呈现不同且正确。

- **受保护集合与代耦合（design 21 §6.11，决策 19 的 2026-12 修订）**：仍留六项——① ssh 装面保守（无远端来源；放开须按
  design 13 §7.2 exec 纪律评审）；② 代不匹配默认阻断、无跨代 override 入口（不得降级为静默警告）；③ 旧就地 gateway 无
  `rows` 的回退分支（只列第三方 + 版本较低提示；失效 = gateway 全量升级后删除）；④ 装后复验违例的自动回滚未做（复验强制；两端都无还原重装，处置 = runbook 人工卸载/重装；失效 = 任一端具备回滚）；⑤ 本地清单原样返回覆盖 `rows[].spec`（
  `desktop_local_plugin_list` 回未掩码清单，`redactLocalPluginManifest` 无生产调用点；失效 =
  接线遮蔽或判定无风险）；⑥ `owner` 已随行投影但渲染端未消费（tooltip/行级「代」未做）。

- **归档清理与归档管理器（design 24）**：剩余仅测试类——打包版实机目检（幽灵行不再浮现、点击不再 `session/not-found`）、探针依赖实例就绪（fail-closed）、语义接线以源码契约 + 目检代证、集合 >65,536 不清扫；实机 gateway/远程 dsh 形态与打包版 UI 目检（design 24 §6/§13 第 17 条）。**版本歪斜口径（2026-09）**：新客户端向未重启旧宿主发
  `protectSessionIds` 被精确校验整体拒绝、不做形状回退，处置 = 重启该实例；窗口属发布说明。
  **实机验收（§5/§13，保护修正后待跑）**：卡提问/等权限的归档会话 → 归档即终止 → 管理器删除一次成功；无会话打开/来源壳被回收时删除仍可用且顶部出现降级说明行；vendor 未清空选中前删除正在查看的已归档树 → 报 `skippedProtected` 且内容未删（保护输入是活泼 `current`，不做记忆），切换/稍后重试即成功；运行中子代理后代所在树一次删除收敛；3s 未 settle 如实报
  `skippedRunning`。
  **常驻保留链（2026-13 修正后的回归门，待跑）**：归档本进程打开过的会话 → 删除（结果行给出常驻保留文案）→ 侧栏不再出现该普通行、管理器仍带「内容已删除，待实例重启收敛」→ 重启 dsh → 行消失、purge 干净（tombstone 由孤儿清扫收敛，仅当实例已重新产生过至少一条会话记录；空语料时 G1a 永跳，属已知取舍）；反向判据：从未打开过的归档会话删除后照旧立即消失。
  **登记残余**：事件发射为 no-op 直至上游 wire（域随 `sessions.delete` 落地退休）；维护阶段报 `idle`，force 可能删到正在追加的档（缓解：归档即终止 + 删除侧闭包全员 cancel）；归档集合 run 起点快照；保护边界 = 活 `current`（多客户端正在看的会话、掩码窗口内本页会话不在保护集，design 24 §13⑭）。可选增强（未排期）：PluginDialog 三态行、rowError 本地化、已归档浏览区、`preview` 孤儿计数。
  **2026-13 既有缺陷（未修，待裁）**：run 级 `archive-set` 提示与 per-item failure 共用 `errors` 通道，
  `archive-purge.ts` 对 `errors.length > 0` 一律 `kind:'error'` ⇒ 删除成功的 run 也出现红字（可复现：删空实例后重跑，
  G1a 跳过清扫；证据 `core.ts recordError('', 'archive-set', …)` + `retention-properties.test.ts` I5）；修法未决（分通道字段 vs 客户端按 code 归类 info）。
  **清理残留（待裁两条）**：① 单删成功后 `storages/session_projcache/sessions/<id>.json` 仍留 4 KB 档——是否回收未决（
  purge 只处理 `binding.ts:483-488/:524-567` 的代际/暂存/租约，对 `projcache` 零命中，上游无入口）；② **迁移在飞时
  purge 可能留一代窗口**：迁移在同一会话目录由并发 write-open 发布后继代际（`generation.ts:829` 的 `link`），purge 先
  `readdir`（`binding.ts:524`）再 `rm`（`:544-554`），`link` 在枚举后落地则 `rmdir` ENOTEMPTY 被吞（`:556-566`）却仍
  `return 'deleted'`（`:567`）——成员关系清除、内容仍可读且后续 purge
  不收敛。可见症状已被常驻保留覆盖，**磁盘泄漏未裁决 **（守卫选项：写租约删除时机/二次枚举/rmdir 失败不改判）。

- **会话列表标签（前任记录愈合域已撤回）**：标签链 = 官方 `title → basename(cwd) → 会话id`（侧栏单点 resolver）；「未命名会话」只剩归档管理器 durable 名列与行不在投影时的通知回落；`+` 复用 workspace 既有空白成员。原计划实例内前任记录愈合宿主域发布前撤回（规格留 git 历史）：未归档、标题读不出的历史行仍会出现、按项目目录名标注，不需要时须用户自行归档；标签修复本身不再有超出日常的实机验收项。

- **移动端 Web 访问面（design 17 §18；契约 §18.3–§18.5、门禁 §18.6）**：
  **复核提出但未实施**：移动中量化 + 静止吸附精确值（现 16px 固定量化）；设置分区滚动位置记忆（现一律复位；无稳定
  section id、异步高度不足会钳顶）；宽屏触控（iPad 横屏 1024px+）键盘补偿（行为层与 CSS 同在 1023px 触屏档，扩展需设计决策）；原生 `title` 长按气泡不抑制（刻意手势，且部分 title 是截断行唯一全文入口）。
  **2026-09-13 复审开放项（代码已调整，判据待实机）**：
  ① 触屏档右栏全屏呈现与抽屉让位（`mobile/src/client/styles.ts:175-230`，锚点 `data-sidebar-right-panel`）；让位需两条臂——上游轨道标志 `data-rightbar-collapsed`（手机档已展开面板同样 track=false）加 `[data-rightbar-fullscreen]`；规则带 iOS 安全区与 `box-sizing:border-box`；768–1023 档面板自带模式控件被隐藏（该档钉死全屏）且面板子树
  `overscroll-behavior:contain`。待判：769–1023 观感、退出控件（44px）够用否、关闭后抽屉回原态、刘海/home indicator
  是否压内容、键盘已弹起时打开面板是否 blur composer。
  ② 新并入 44px 底线：会话头视图 tab（恒两个，`styles.ts:430-448`）后头部增高、tab 条改换行后「第三个视图」可达性；
  dockkit 条（`styles.ts:470-520`；chip 的 20px 关闭控件刻意排除、条内按钮 border-box、chips 保持 content-box 否则
  chip 最小值 100→80px 而放宽分屏判定）；会话头座席底线仍在内容盒（图标按钮约 56px）。待真机判 48px 行观感、≤480/≤360
  排布、横滑与谱系 hover-open 互扰、横向平移对抽屉边缘手势。
  ③ 未适配官方浮面（只登记）：dockkit 面板出生矩形 380×300 @ (160,120)、无视图夹取、宿主 z-60 高于本插件所有层（
  `ui-dockkit/.../constraints.ts`）；`ContextMeter` 固定 264px 贴 trigger 右侧（
  `ContextMeter.module.css:41-58`）窄屏余量未实测。
  ④ 上游 `touch-action:none` 与 chips 横滚冲突（dockkit 条与 chips 行都为拖拽保留）⇒ chips 溢出无法滚动；是否补
  chamber 补丁待设计决策。
  ⑤ 真机抽检与模拟边界：走查在 `mobile-walkthrough.mjs`/`mobile-checks.test.mjs`/`verify-mobile-anchors.mjs`；模拟层三条不能当真机结论——`setEmulatedMedia` 的 pointer/hover 被 Chromium 忽略、`mobile:true` 让 `scrollWidth<=innerWidth`
  恒真（须用 `clientWidth`）、iOS/WebKit 语义造不出。仍开放：真实手机/打包态抽检（几何观感、横滑与谱系、平移与抽屉手势）、走查只读（抽屉/设置/键盘补偿与其余 44px 座席未断言）、**会话打开停滞的 WS 帧证据**。锚点门无上游树时 fail-soft
  跳过；`--require-anchor-root` 对缺根/无 client 产物/抽不到源码/语料不完整/pin 身份不可判定/版本不一致 exit 1（与
  `--simulate-rename` 互斥）；pin 身份只是版本级，内容级需仓内快照，CI 常态生效需生成式快照。
  ⑥ pin 前瞻：npm `next` 已 `0.1.5-rc.2`（client 已发布，`latest` 仍 `0.1.5-rc.1`）——pin 前移须按 `mobile/README.md`「
  Anchor baseline」重审（风险在 ui-layout frame 与 settings/composer 结构）。
  ⑦ iOS 键盘补偿期「回到底部」控件仍在键盘后（`ui-chat` 按 `--dsh-composer-height`+16px 定位而补偿改 seat sticky
  `bottom` 高度不变）；该控件无属性锚点（禁按 `aria-label` 文案匹配）——候选：请上游补锚点或插件 arm
  期改写变量（与上游 ResizeObserver 竞态，需设计决策）。
  ⑧ 回车换行 caret reveal 时序（iOS 待判）：`execCommand` 后立即测量 caret，而 Lexical DOM 归并在 mutation microtask——
  归并若改变 caret 则揭示落空（composer 撑满后回车新行须在可视区）。
  ⑨ layer-2 恢复在 WebKit blur 语义下可能不可达（CANNOT-VERIFY，静默失效仅少一层保险）。
  ⑩ iPad 接触控板/鼠标的档位（假设待验）：整层以 `pointer:coarse` 门控，若 iPadOS 报主指针 fine 则移动档整体退场（回落上游窄窗）——实机确认一次。
  ⑪ 档位边界与多任务（待实机）：768/1024 在 Split View/Stage Manager/旋转连续拖拽中可中途翻转；768–979 且抽屉展开时上游解得 `cols.rightbar=0`、面板 0 宽并自收起（`SidebarRight.tsx` 的 `canShow`）——需确认观感。
  ⑫ 让位与官方模态叠加（待判）：设置页在侧边栏 DOM 内，面板在其打开时展开 ⇒ 抽屉子树 `visibility:hidden`，文档停在「有
  `aria-modal` 但对话框不可见」；面板展开时 composer 持焦则 iOS 键盘不收起、输入进入面板之后的 composer——需真机决定是否补处理。
  **剩余实机门禁（§18.6）**：真机触控目标比例/抽屉开合/键盘遮挡（iOS 时序与 Android WebView 盲区、聚焦缩放后打字正例、缩放态平移不抖动、捏合缩放负例、提交窗口不闪落、重挂 re-arm、死区 ≤23px）/安全区/抽屉开关不重叠/crumbs 条官方 nowrap
  后横向平移手感（谱系计数 span 不许退回换行；平移与抽屉边缘手势互扰仍需真机）/iOS 单击切换/设置手机档走查/刘海横屏/深层谱系高度。
  **移动端 git 侧边栏**：桌面链座席为桌面专有，接入需装配矩阵第二客户端例外 + 移动交互设计（下一阶段）。**DOM 锚点审计剩余**：details 打标接线仅实机可验、composer 锚点 fixture 化、Android 键盘盲区真机门禁。**P2**：PWA 安装 + SW 壳离线（per-instance scope，尊重官方「不完整离线」）。**P3**：公网认证流转正式化 + Web Push；先行形态 = 内网/可信网络
  `--no-auth`/tailscale。
  - **连接稳定性（未修复，取证中；2026-12）**：唯一长连接 `/api/remote.mux`；实例侧心跳 2s×2（硬编码）⇒ 静默 4–6s
    `terminate` 且 gateway 侧无日志；代理浏览器腿 30s/1 miss（拆链同时销毁 upstream 腿）；客户端指数退避（500ms×2
    上限 10s）重连 + baseline replay；pending approval/question 在 generation 结束被 abort、重投换新 key ⇒
    草稿丢失/弹窗重建。日志复核：浏览器腿心跳拆链只 1 次 ⇒ 代理心跳非主因；无周期性整页重载/SW。有界取证日志（
    `proxy-forward.ts` 的
    `WebSocket stream <id> closed (<cause>, <ms>ms)`）区分实例判死与客户端重连；归因边界：代理主动撤销也记
    `upstream close`。下一步：DevTools 抓 close code + 节奏（1006/4000）；若为实例心跳，最小改动 = patch overlay 加
    config 行（ 现 `cordis-inserts.ts` 仅 id/name）调宽 `websocketHeartbeatIntervalMs`。否决替代：解析 close
    帧（实例侧 `terminate()` 不发）——日志不足改用上游 ping 间隔计数（~15 行）。另：桌面 idle 重连看门狗只按 transport
    过滤（S2 臂在 `App.tsx:1824-1865`，阈值 `aggregate-refresh.ts:119-123`：http 120s/ssh 300s/local
    跳过），**gateway 目标（ 同属 direct-http）也吃 ~2min 连接 bounce**——「桌面也发生」若指桌面 App，此即解释。
  - **会话运行位卡死（ui-chat「深度求索中」）的剩余门**：机制与取舍见 design 14 §D4
    （运行位只由 `$events` 上 emit 型 `api-session/status` 递送、无重传；官方无周期性
    收敛触发点）。**未闭合（均为未判门，非已完成项）**：
    ① 实机/浏览器 lane 的端到端复现未跑——fixture 已有 `__fxTiming.appendSilent` 与
    `breakStreams` 两个 timing hook 可做确定性回归，未接 CI（失效判据 = 该场景进 CI）；
    ② **HTTP 通路健康而 WS 逻辑流半盲**时运行位会收敛但 transcript 不收敛（需 fork 逐流交付
    统计 + 宿主 `session/list` 的 `projections.asOfSeq` 对账，再以官方 `Session.resync()`
    做单会话重放——失效判据 = 该对账落地并由 `appendSilent` 场景钉住）；
    ③ 官方 `session.list` **单飞悬挂**时 L2 与横幅「重新连接」均无效，只有「重新加载」有效
    （需上游给 fetch 超时或客户端可清除 in-flight——失效判据 = 悬挂后重连能恢复）；
    ④ 子代理会话（`origin==='subagent'`）不在事实通道 ⇒ 该臂看不见（失效判据 = 该行进入
    事实通道，或裁决为接受的盲区）；
    ⑤ 隐藏期 watchdog 不 tick；恢复后首个补偿 tick 按**累计** running 时长判定（隐藏时长计入
    `since`，不是「重新起算 120s」；若要后者须显式重置时段计时，当前不做）；
    ⑥ 阈值（L1 门槛 120s / 等回执 150s / L2 退避 300s / L3 120s）未经实机校准，L1 配额为滚动窗口
    （10 分钟 ≤3 次）；
    ⑦ 上述三条上游语义依赖（refresh 回灌 / emit 无重传 / 失败也 resolve）只有接线测试
    与语义测试，**尚无读 vendor 源的 lockstep 测试**（checklist §4 已登记，仿
    locale-vendor-contract 的形态；失效判据 = 该测试落地并被 CI 运行）；
    ⑧ 控制面 `<stateDir>/logs/control-plane.log` 与原生壳 `<userData>/logs/sidecar.log`
    的取证价值未在一次真机事故里验证（失效判据 = 事故后能从这两处检索到
    `WebSocket stream … closed` / `heartbeat lost …` 行）；
    ⑨ **权威判定对「整行缺席」不作证**（`sessionFactsConverged` 的保守取舍）：官方
    running=true 而独立 unary 权威快照里没有该行时判为收敛——若宿主返回的是**不完整
    列表**，这就是「官方位卡住」的一个残余出口（失效判据 = 上游给权威读一个完整性信号
    （`asOfSeq`/游标）后把缺席升级为「未收敛」；判成未收敛前会引入假升级，故刻意保留）；
    ⑩ **守卫自己的动作（L1/L2/L3）只落 renderer console**，不进 `control-plane.log`
    （后者只收控制面 logger）：下一场真机事故仍无法回答「L1 有没有触发、位有没有掉落」。
    失效判据 = 三类动作与结果各写一行到某个持久面（实例环形日志新增 renderer 可写 verb，
    或经既有 notify 通道落到 sidecar/native 日志）；
    ⑪ **两处「更省形态」候选未落地**（下轮首选；2026-12 三轮复核把论据改写成硬约束，免得照旧方案重做踩同一个 race）：(a) 挂到 App 每 30s 兜底 unary pull 的提交点——
    ① 挂载源的 `aggregates` 会被 producer push **整块覆盖**（push 与 runtimeFacts 同源于官方 store ⇒ 两份事实不独立，卡住的 running 会被写回）；② push 会作废在途 pull；③ 该 pull 只在源 stale 时发生，推流存活的源根本不拉——故它只在「源完全静默」子场景成立，覆盖本缺陷必须另加旁路采样面，净省 ≈450–500 行。(b) 用官方 store 自己暴露的 `state/phase/error`（`buildListSnapshot` 已带）替代独立 unary 探针：省一半 host 调用，但丢掉「refresh 成功而 running 未回灌」这一上游回归的检测面。
    失效判据 = 任一形态落地并删掉相应生产端通道（并补上被删面的等价证据），或复核确认现形态更优并写回 design 14 §D4。

- **会话打开停滞（「载入历史…」永久停留，2026-09-14 实机）**：大会话（`session-28e9eb86`）经 gateway 打开只显示
  `chat.loadingHistory`。根因未证实；唯一同构状态 = mux socket正常而 `session/follow`
  逻辑流永久无首帧，客户端与宿主都没有首帧超时；收口需设备侧帧证据（CDP WS Frames/抓包），入口
  `mobile-walkthrough.mjs`（`mobile-ws-frames.json` 落盘前脱敏）。插件侧「停滞提示 + 主动重载」兜底（
  `session-stall.ts`）判据全为属性锚点，**45s 阈值未经真机校准**；形态取值/误报边界见 `session-stall.ts` 头注与
  `README.md`「Anchor baseline」。（同族另一面见上方「会话运行位卡死」条与 design 14 §D4；
  本条的首帧期限与它共享同一类缺口——上游侧提案见 `docs/progress/todo/upstream-proposals.md` §4。）

- **上游装载面三项待办（只登记，不改 upstream）**：① `dsh-client-modules` 的 `compose()`把全部非 bootstrap 行打成一个
  application 批次、只按 URL 3 KiB 切分（不按字节）⇒ 首屏~10.65 MiB 响应（`ui-sidebar-documentpreview` 内嵌 PDF.js 占
  6.57 MiB）；懒加载需连带chunk 供给方案（combo URL 下发时相对动态 chunk 会 404；chamber `seedFiles` 也要带chunk）——已列**低优先级**，不裁功能；② `ui-subagent` 的 `SubagentHeaderLineage` 类字典缺 `count` 键 ⇒ 计数 span 无 class、只能靠继承 `nowrap`，应补 class/nowrap；③ 会话打开流应加首帧超时并把失败落成可见错误态（现永久 loading）。

- **受管 dsh 应用日志取证（opt-in，默认关闭；启用见 `gateway --help` 与 `host-log-bridge.ts` 头部）**：上游无日志开关
  /exporter，chamber 注入 Cordis exporter（应用日志 → 子进程 stderr → 既有脱敏/环形轮转管线）。仍开放：真机启用验收（未对运行中网关实例端到端，含「加载失败即 spawn 失败」boot 耦合——profile 多一行 loader row）；隐私代价（日志可能含会话内容/prompt/路径，脱敏只覆盖 `?token=`/`&token=`，共享主机不得长期开启）；`warn ⊃ info` 单调阈值语义易误读；只覆盖本地 web-profile spawn，不含 desktop远程 SSH 路径。

- **Windows 首版（design 23）**：剩余全为**外部门禁**，台账见 `docs/progress/todo/windows-v1.md`（已剪为剩余项清单；原
  windows-baseline.md 的基线登记口径已并入同文件）：真实 Windows runner 首跑绿（test-windows 腿，含 submodule 物化
  +junction 建链）；M0.5 上游 dsh win32/NSIS protocols/Defender/原生依赖实证；M2a runner事务矩阵；**M2b UI 翻转（纪律：M2a 真实 win32 全绿前不做）**；M3/M4 实机矩阵与打包验证；M5/M6 发布面决策/演练待发布前。

- **Linux 桌面（design 22）**：剩余实机门禁按 §7 清单（GNOME X11+Wayland/KDE 抽验：XDG自启、深链冷/热与
  CHROME_DESKTOP/xdg-mime 路由及升级后重注册、托盘/通知点击、safeStorage keyring、SSH 密码全链、运行时打包态全链、自动更新端到端、AppImage 沙箱与Wayland 焦点；另复核 before-quit 无头挂住行为）；release.yml dry_run 全链（需 GitHub可达）；deb/arm64 后续。已知未动项登记于 design 22 §5（裸 CLI stateDir 提示、pnpm home边角、private-fs 严格 fsync 审计结论等）。

- **桌面通知 / 未读徽标（design 19）**：通知剩余 macOS 权限/拒绝行为、点击打开、关窗/托盘/后台三形态与打包态实机；徽标剩余 macOS Dock 打包态三态（武装/解除/退役 + 重载与退出清零）实机；Linux 仅 Unity launcher 家族可见（文档化平台限制）；Windows 任务栏 overlayv1 门控未接线（design 23 实机矩阵排期）。

- **会话待办区（design 06 §8）**：剩余实机门禁——通用页开关即时生效、同源/跨来源/未常驻跳转与权威移除、折叠来源中目标、断连→重连重现、rail 不渲染、「还有 N 项」展开/收起与自动收起、展开内滚动（8 行上限）、拖拽尾随点击不误开、同会话内联重命名不打断、打包态。

- **open-in 超集分批口径（2026-09-11 复核裁决，design 20 §7.2）**：官方两份原先都没有「无应用出口」与「第二入口」，故这两项是新增能力而非缺失回填。裁决：**S3 收窄为「复制路径」**（侧栏既有悬停卡复制模式——会话行本体
  `ServerSection.tsx:2088`/`copyText:2107`，复制的是会话标题而非路径；会话行已带 `SessionRow.cwd` ⇒ 零新
  IPC、纯渲染层 ）；**复制 `ssh user@host` / VS Code 深链与 S4（侧栏入口、快捷键）不做**——header
  按钮与目标会话同排相邻、会话行动作已全在一个 kebab 菜单里（`ServerSection.tsx:1952-1977`；刻意无 kebab的是 worktree
  派生的 workspace 行，`:1288-1290` ）、快捷键缺 vendor keybinding
  基建，且三处「今天无按钮」来源都不在主流程上。完整形态留档 `docs/progress/todo/open-in-superset-batches.md` §5 附录
  A/B。

- **VS Code 深链 + open-in（designs 16/20）**：剩余 macOS 实机验收——深链冷/热启动、打包态、托盘/退出在途、N-ctx、VS
  Code 缺失、`sshPort != 22`、本地应用下拉（实例内 host 包）在 vendor 会话头部的定位/层叠、远程来源仅 VS Code（新窗口/
  复用两态在打包态真机确认）。

- **Git Worktree 插件（design 08）**：剩余真实远程 Linux + Git 仓库端到端（首次ready-time seed 后重启生效、并发
  session 删除竞态、Git LFS/filter 与恢复边界）；剩余实机验收——运行中会话（未归档）→ 删除被拒并给出诚实文案；同会话归档后 → 工作树删除成功且该会话未被停止/删除、其 cwd 消失后日志仍可读；运行中子代理位于已归档根下 → 不阻塞。归档管理器是唯一「停止运行中回合 → 清理已归档内容」的入口。

- **远程实例插件管理（design 13）**：本地 `dsh plugin`/`pnpm pack` 依赖 `resolvePnpmBinDir` 对 PATH/nvm/volta/homebrew
  的探测——需打包态实机。剩余实机验收：四来源 chamber 表行数（注册表 **4 行**：
  client-graph/git-worktree/archive-cleanup/open-in；open-in 为 `localOnly` ⇒ 本地 4 行、远程/gateway/http 注册表 3 行（gateway 另有Loader 派生移动客户端行）；该行不参与 ssh needs-seed/restart 门、不进注入预检/远端日志/桌面侧 gateway
  上传源清单（`portableChamberHostPackageSeeds` 唯一判定；网关派生白名单 `SYNCABLE_HOST_PACKAGES` 仍含该行，design 20 §
  9 / design 17 §10.2；缺行时「注入」可成功）、远端已注入未生效显示「重启生效」、ssh 本地列不再恒「未知」）、
  archive-cleanup 的installed/patched/live 三态与「注入/重启」按钮、gateway seed-cache 漂移列。

- **会话创建/fork/归档的侧边栏收敛修复（会话回声 + 归档墓碑，2026-12 真机反馈；design 05 §2.2.1）**：唯一出口
  `shared/session-mutations.ts`；`withSessionEcho`、`withPendingArchives`、事实到达时的官方 session-list
  **剩余本地 + 远程 SSH 实机验收**：① 在来源 A 会话里点 B workspace「+」或对 B fork：侧栏 **<1s**
  出现新行（blank 随 current、fork 子行按普通行）、位置在工作区头部、不出现「先落未分组桶/尾部再跳位」；② 归档
  B的旧会话（B 未挂载）→ 行驶即消失、不留可点空视图入口；③ 权威归属/归档集到达后无重复行，切走切回/刷新后仍一行；④
  别处（另一客户端、宿主直接改 ）变更与归档墓碑租约到期（10min
  无观测）回浮的行仍需点开该来源才收敛——已登记的整源降级面。

- **打开意图 / 工作区回声两项真机反馈的实机验收（design 05 §2.2.1，2026-12）**：① 本地会话中点远程来源会话行：揭幕期只显示加载层，不出现高亮「新会话」行、不切到新会话主页；② 给远程来源新建工作区（来源头「添加工作区」与workspace 行尾
  git「创建 worktree」两入口）：该来源分组下 **<1s** 出现新行、同目录不出现第二行，git 入口的行落在主 checkout 之后、首帧即 worktree 形态；③ 温壳切换无多余加载层（幂等重开保持高亮）；④ 冷 boot 连点同一来源两会话只打开最后点的（被取代请求静默 resolve，不出现回翻）；双击重命名/拖拽/归档管理器/通知/深链/git adopt回归照旧。**阶段 0 插桩配方（dev 构建
  + 临时日志，不提交）**：包装 `sessions.open` 打调用栈与 `performance.now()`、打印 `runtimeFacts[id].current` 序列并观察 `localStorage['dsh.sessions.current']`；期望冷 boot 先 `session.create` 后目标 id、早开臂应抢在
  `session.create` 前、投影门窗口内「新会话」行不得入列表。**若早开臂从不能抢先**，`client/early-open.ts`
  可整体拆除（独立 effect + 测试），只保留投影/揭示两闸门。

- **发布/CI 基础设施**：test job 抽 reusable workflow 供 release.yml 复用（长期目标，现靠策略测试与人工同步，有漂移风险）；vendor submodule 剩余验收（Windows runner 物化 +junction 建链、CI 真跑、release.yml 改动后 workflow_dispatch
  dry_run）；Gateway npm 分发未决策（现仅 GitHub Release `.tgz`）；打包闭包自检（CI 增加「主进程传递模块闭包
  vsbuild.files 清单」机械检查，长期建议）。

- **性能遗留实机清单（P0–P2 + 第二阶段 A/B）**：五条实机复测全开放（打包版或带会话 dev 实例）——①曾拖宽侧栏实例冷
  settle 的 veil 失配/CLS；②连点 ×10 冷挂载切换的单槽收敛 ≤2 节；③版本事务 sample 主进程无同步全树冻结；④更新模式侧栏写频 T4 防抖 250ms 窗；⑤H3 懒加载两段结构长任务真机复核；入口 `scripts/perf/`。**第二阶段（视图保留/后台门控/行窗口）剩余同环境 A/B**：`measure-ui.mjs`（DOM 分壳/堆/空闲长任务/合成输入帧/预热壳数）+「打开→切走→重开 ×3 堆无净增长」。**验收目标**：全视图 DOM ≤13,000（按 `dom.perInstanceNodes[]` 分壳对照）；JS 堆无净增长且随视图数线性下降；×3 堆无净增长；空闲 15s 无 >100ms 长任务（**首启基线收割窗口不计入**）；合成输入帧间隔无 >500ms；预热 1 壳且仅前台（与基线收割共享唯一槽位）。**已知取舍**：被回收壳内运行中任务的完成蓝点/通知边沿暂停至该源重开（60s 安全窗 +
  `RETAINED_HIDDEN_VIEWS=1` 限制损失面）；被回收源聚合降级到既有 30s unary兜底（05 §2.3）。证据：`retention.ts` +
  `App.tsx`、`measure-ui.mjs`、design 05 §4。

- **Swift 原生壳性能整改的实机同环境 A/B 未闭合**（2026-12）：**启动 t0→首帧 / 大载荷 invoke p95 / 空闲 wakeups 的同环境 A/B 仍需打包态实例**（本机缺 node workspace 依赖，real-sidecar 集成用例环境阻塞）；本批次触达的桥热路径与空闲开销改动的实现契约散见对应源文件头注（信封尺寸门
   Data 化、payload 单遍转换 + 深度上限、B 桥入站每行单次解析 + 严格判型、页面字面量单遍写出、POCDebug 启动期缓存、LineReader 游标化、
   stderr 读取/环形独立锁）。观测入口 `macos/Sources/DSHChamberPoc/ShellPerf.swift`（`[perf] boot …` 行）与 `POC_DEBUG=1` 的 `[perf] invoke` 行；A/B 纪律见 `scripts/perf/README.md`。

- **B 桥出站帧护栏的范围边界**：出站 4 MiB 门只覆盖产品入口 `packages/desktop/sidecar-entry.ts` 的
  `writeProtocolLine`（`node-edges.ts` 的 `MAX_PROTOCOL_FRAME_BYTES`，与入站 P-01 同源）；POC 桩入口
  `packages/desktop/poc-sidecar.ts` 仍是裸 stdout 写——它只服务测试夹具（`BridgeClientIntegrationTests`），
  产品路径不经它。证据：全仓 `process.stdout.write` 审计（产品路径仅 `writeProtocolLine` 内三处回错帧：not-serializable / too-large /
  backpressure，加一处正常写，全部在出站门与有界缓冲之内）。

- **sidecar 的 console 通道退化**：`sidecar-console-redirect.ts` 把所有可能写 stdout 的 console 方法钉到 stderr
  （stdout 纪律优先）；其中 `count/countReset/group/groupCollapsed/groupEnd/time/timeLog/timeEnd` 退化为普通日志行
  （不维护计数/计时/缩进状态）。`assert` 已恢复 Node 语义（仅首参为假时打印、带 Assertion failed 前缀）。仓内无这些
  方法的调用点；将来要用需改为带状态实现。证据：`sidecar-console-redirect.ts:45-70`。

- **B 桥协议写端的验证面**：出站帧门、快判与有界缓冲（8 MiB 字节 + 4096 帧/轮双上限，拒发回帧每轮 ≤64 条）只在本机做
  真解析门（`stripTypeScriptTypes`，见 `sidecar-stdio.test.ts` P-03）+ 逐字运行时探针验证（`node --check` 对 ESM .ts 是静默
  no-op，不可作门——第七轮验证 BUG 即由此假绿交付过；门：恰 4 MiB 放行 / +1 拒绝 / 无 id 零写出 / 多字节中间带走精确路径；缓冲：300k 小帧下
  排队恰 4096 帧、RSS 100k→300k 持平、SIGTERM 立即处理；edge 帧拒发时 node 内直接 reject，不再等 30s/660s 超时）。CI 里
  `sidecar-stdio.test.ts` 目前只有静态锚点断言，**行为级用例仍缺**（补用例需能暂停 stdout 消费的夹具）。

- **SSH 密码一键免密引导与系统钥匙串（05 §8）**：未实现（现行为 endpoint-bound 0600 明文镜像，见取舍）。

- **模型额外参数 + 默认推理等级（design 07）**：wire 白名单无泛化透传、host 组合不可注入——待上游解锁；
  `agent-default-model` 客户端**可读可写**（`settings.describe` 不过滤namespace，旧 `exposedNamespaces` 在当前 pin
  已不存在，见 design 07 §2.4），但回显/设置入口不在本蓝本范围内，**实现未排期**。

- **跨边界诊断文案：框架那一半已本地化，剩下的在框架之下（2026-09-11 轮；范围按 review-fix F4b 收窄，未排期）**：框架自己渲染的 chrome 文案已进 typed 字典（`renderer/src/locales.ts`）；由别包渲染、框架拼好的三处也按文档语言取值（
  `App.tsx:455` 经侧栏 `ServerSection.tsx:1257-1262` 渲染；`App.tsx:2754`/`:2783` 经 `reportOpenSessionOutcome`
  回侧栏 ；`:2818` 通知重放拒绝文本）。**仍开放**：`{detail}` 装框架之下文本（`shell.ts` 打开失败诊断与 dsh
  运行时错误），无 locale 席位 ⇒ 英文文档下该从句仍中文（`App.tsx:2774-2782`BOUNDARY 注释）；对齐 = **reason code 协议
  + 渲染包侧映射** 。**2026-12
  增补**：降级事实的侧栏行与连接页卡片只收结构化事实；仍留在框架之下的只有活动视图横幅诊断行（
  `.boot-gap-detail`，产出方中文原文），框架不翻译不解析。

- **变更文件覆盖率门未接**：`scripts/gates/run-checks.mjs` 的 `tests` 模式是每文件一个 `node` 子进程，V8 覆盖率须跨进程合并，而仓内无 `c8` 类工具、新增 devDependency 需显式请求。待裁决二选一：引入 devDependency 或把 runner 改成单进程
  `node --test`（动到现有进程隔离语义）。

- **根级弹性回弹（deviations S-50）**：**仍 open** = 打包态 `.app` 实机走查（顶栏、会话栏顶部、内容区中段、内容区两端；含滚动/惯性/键盘/滚动条/缩放/拖拽选择无回归）与最低支持版本 macOS 14.4 复验；Electron 未同步属双 flavor 有意差异（S-50 ①，accepted，理由见该行）。

## 一致性债务与开放登记（低–中，未排期；均指回代码面注释/design 登记）

- **docs 证据锚点过期（D15，2026-12 实测；低–中，未排期）**：`docs/**` 的 `文件:行` 证据锚点共 666 处（32 处指向 `MainWindowController.swift`），代码位移后大面积错位且偏移不均匀（同一文件净增 128 行，实测偏移 +5…+128），抽检 10 处全部错位。退役动作 = 待合并分支全部落地后按符号 grep 做一次语义化重锚；登记见 [deviations.md](deviations.md) D15。

- **设置面残余登记（design 05 §5，2026-12 完整桥接修订后剩余项）**：壳渲染选中来源自己 boot ctx 的 `settings.section`
  台账与该 ctx 绑定的标准座（`settings-source-face.ts`）；原 child ctx 残余随其删除。剩余：①面板要求该来源壳处于挂载中（`setSettingsTarget` 保证后台挂载/不被回收；代价 = 付一次该来源 boot，失败只显示不可达/启动中，无独立降级面）；②
  `settings.trigger/header/close` 属壳 chrome、`settings.action` 仅本地；`settings.onboarding` 不再缺失（壳统筹自己
  ctx 首启 + active-view 门，隐藏壳不弹）；③ 组装诊断块退役（`toAssemblyReport` 等已删；真实诊断在连接页
  `pluginDiagnostic`）；④ `contributes.settings` 等仍为上游提案（未排期，不再是前置），见
  `todo/upstream-proposals.md`；⑤ 完整桥接与首启阶段只经单测 + 源码锁 + `build:renderer`
  门确认，真实多来源/打包态冒烟待执行。

- 私有文件纪律三实现（cp `private-file.ts` 抛错式 vs dsh-runtime `private-fs.ts` kind 结果式，同名异签）——统一需依赖方向裁定（design 18 §9.1）。

- **`install-gateway.sh` 的 dsh 锚走 npm 安装（design 18 §4 单一来源域外点，2026-12）**：
  `scripts/install-gateway.sh:1180`（升级路径 `:1271`）以 `npm install` 装内建锚——npm无 pnpm 11
  `strictDepBuilds`，不经过 `allow-builds.mjs` 单源裁决（另两个生成点 `runtime-installer.ts:1129`、
  `bundle-dsh.mjs:128` 都经
  `renderAllowBuildsBlock()`）。触发：该脚本装到带安装期脚本的新依赖时放行/否认集不可见；一致性靠
  `dsh-upgrade-checklist.md` 人工复核，无机械锁步。

- **`client-web` fork 未使用依赖 `@deepseek-ai/dsh-client-ui-theme`（待锁文件窗口，2026-12）**：
  `packages/dsh-client-web/package.json:29` 仍声明，但 fork `src/` 引用已退役（token 表改由 `renderer/src/styles.css`
  引入）。**不能只删一行**：锁文件 importer（`pnpm-lock.yaml:452` 起含 `link:` 条目 `:466-468`）不匹配会让 frozen 安装失败 ⇒ 删除须与锁文件重生成同批。

- **layout fork 共享 `ThemePresenter` 永不回收（2026-12）**：`layout/src/client/index.ts:52-56` 模块级单例，teardown
  不 dispose——有意（vendor `dispose()` 会收回全部文档级写入并抹掉活动视图调色板，`document-theme.ts:5-9`）。残留：最后一个壳卸载后文档仍留 `html{color-scheme}`、theme token 与 theme-colormeta（「投影属于下一个活动视图」的代价）。

- **`sidebar.workspaces` 声明但壳从不渲染（2026-12 审查）**：`slots.ts:44-49` 声明、`src/client/index.ts:50-52` claim
  （注明只是为 ui-workspace 注册不失败），但 `SidebarRoot.tsx` 只渲染既有座席（`:1534/1556/1540/316/1684/1687/347`），浏览区由自有多来源列表取代 occupant（`:1598`）。触发：第三方往该座注册——成功且无报告、页面永不出现。待裁：撤声明（不
  claim、让注册响亮失败）或在诊断面报告注册者；需 slot 语义裁定。

- wire 载体（A–F）登记维持：P4-3 A↔C 传输层合并**裁定不合并**（前置 ①–⑦，任一项未决前不动）；E（git-api）禁改（
  `wire-common.ts` 注，P4-1/2/3/N6）。

- sanitize 语义矩阵（core/desktop/gateway/installer 四成员）与 win-probes↔windows-process 孪生：互注无机械锁步。

- dashboard（gateway 浏览器运维页）仍为独立第三份运行时 UI，不共享 sidebar 的 parse/poll核心（D-2，共享核心迁移列后续）。

- C-F7 undo 语义不对称：ssh「撤销=恢复」vs gateway v1 `undoForLatest`（仅最新 ok install→remove，
  `settings-connections/src/client/plugin-model.ts:488-499`）；服务端 `preImage` 只被保留与引用计数回收（
  `gateway/src/plugins-journal.ts:13-22`/`:241-247`），**无运行时恢复消费方**——r2 preImage 回滚与 r4 操作员子命令都是
  **design 21 §6.8 r2/r4 二期，未实现**（兜底是 operator runbook）。

- C-F8 `GET /chamber/plugins/installed` 裸读未入写栅栏（撕裂读仅 loud 500）。

- C-F12 desktop 本地 plugin add 子进程 env 未 scrub（gateway executor 与共享 runtimeinstaller 已白名单化）。

- C-F13 readManifest 三后端无共享联合（design 21 §3「单一定义」未兑现）。

- A-U3 desktop `SETTINGS_SET` 无 busy/pending/env 门（env 维度放行为有意；busy/pending对称性待决策）；A-F16 `DSH_HOME`
  布局默认偏 desktop（共享推导点防误读登记）。

- dual-host 语义下沉延后：activation-facts/startup-verdict 映射、restart 拒绝织、apply-now 门（整门合并不做）、
  identity-probe 腿——只有 3 处以 ruling 注释登记（`desktop/main.ts:4360` ACTIVATION-FACTS DIVERGENCE +
  `gateway/runtime-manager.ts:950`、`runtime-probes.ts:390`），restart 拒绝织与 apply-now 门无代码注记；统一需新
  dsh-runtime 导出（dist 锁）或行为裁定。

- 0.2.2 审查跟进残留（低优 UX）：会话行动作仍 hover-only（键盘/触屏无揭示路径）；仓库组折叠 × 会话待办条带张力；
  chamber 表最坏徽标组合窄窗可能横向撑破；en 单数文案、行移除 aria-label 覆盖可见文本、行无 `<label>`、sshdone 态
  stale 行按钮可用、无 PluginDialog DOM 测试、对账空态双提示；settings-dshruntime：PUT registry 成功不bump
  versionsEpoch、30s 超时文案双层措辞、围栏/超时逻辑内联 effect（可测性债务）。

- **`test:gateway` 宿主服务隔离（2026-12 实机定位）**：D2 跨形态清理的固定单元名是安装器设计行为；
  `install-script.test.ts` 仍有 2 处直接 spawn 真实安装器（`--help`/
  `install--version`，当前只走用法/解析即退出），若未来走更远会再次逃逸；`03:16:06` 同签名停机未被钉死（/tmp
  证据被容器重启清掉），01:22 非优雅死亡与 01:35 陈旧锁接管已解释为容器被外部终止 + 网关锁接管，09-07 23:45:29
  已解释为手工 install/update。

- **N-ctx 文档级主题投影归属（design 06 §4.6）**：剩余=打包态实机目检——首屏、视图切换与回收窗口的 checkbox 深浅、预热视图不再互踩主题（验收前须 `pnpm run dist:desktop:mac`重打包）。

- **页面语言归属（design 06 §4.6）**：剩余=实机目检——一次冷启动里 `document.lang` 的**语言类**变化 ≤1 且必由屏上实例设置面敲定引起；预热/收割/后台壳 boot 期间变化 = 0。打包版无 CDP，需 `pnpm run acceptance:gui -- --dev` 起隔离 dev 实例并挂 `MutationObserver`（至少注册一个远程源）。同轮确认：① **跨语言切换同一帧性**——若看到一帧陈旧框架文案，改为从
  `owner.languageOf()` 取值或在该 effect 内强制渲染；② **持续未敲定的降级姿态**——`settings.describe` 持续失败时
  namespace scope 停 `loading`（vendor 镜像回 `idle`），屏上实例用浏览器兜底值而页面停服务端默认（`zh-CN`）：刻意选择，不是缺陷。

- **构建后回填（design 06 §4.6）**：`check-chunk-budgets.mjs` 的 `chamberEntry` 基线（warn 余量薄）要在真实
  `pnpm run build:renderer` 后重新取样并回填脚本头部；本环境无node_modules 不能构建。

- **Git 来源分支候选（design 08 §4.2 尾条）**：剩余=打包态实机目检；unborn（零提交）仓库 `branches` 必空 + 默认 base 40
  零直送 git 无 preview 门仍为代码面已知残留（实机无此形态）。

- **样式门 `verify:styles` 扫描面之外需人工纪律（2026-09）**：S1–S7 只扫 `packages/`＋`scripts/` 的
  `.css|.ts|.tsx|.html`；两类不在覆盖内——① `docs/**/*.md` token 引用（三处旧名/旧值已人工改正，但无门禁再拦）；② 包级
  `README.i18n.yaml` 哈希记录（`verify:i18n` 只管根目录 5 对；复核 = 逐包 `sha256sum README.mdREADME.zh.md`
  对比，四个 sha256
  包当前一致；改任一侧必须同步另一侧并重录）。三种格式并存加剧漂移（四包sha256，client-web/connection 用 git blob
  SHA-1 且注释指向仓内不存在的写命令）；统一并入门禁是后续候选。

- **gateway 运维页失败分支不被夹具覆盖（2026-09-11 review-fix F4b）**：`dashboard-harness.ts:432-435` 的 fetch spy 对未挂起请求一律回 200，页面脚本自己的 `request()` 非 2xx 分支（`routes.ts:316-326` 拼 `Request failed (HTTP <n>)` 并挂 `code`/`httpStatus`）无夹具驱动；失败路径测试改为直接供给该分支产出的确切 Error 形状（
  `feature-lifecycle.test.ts:479-486`）——要覆盖构造面需给夹具 `respond` 增加 non-ok 能力。

- **归档保护「候选根闭包」方向缺一条测试（2026-09 审查，低）**：保护集只与候选根**自己的**子树闭包比对（design 24 §4
  step 3b），**被保护会话的 archived 子代**若自己也是候选根不会被祖先保护覆盖，可能被单独删除——合同写明的单向性，不是缺陷；客户端也表达不出该组合（`sessionIds` 必填且对话框要求非空，无过滤全删进不来，隐藏子代理行不可选）。缺口只在测试：两个方向各有用例，唯独「受保护祖先 + 其 archived 子代候选」没有——**将来若开放无过滤清理、或让子代理行可选，先补这条锁再放行**。

## 设计未决

- **Electron / Swift 双 flavor 接入点 parity（2026-12 八路逐函数复核 + 打包/引擎专项）**：**仍 open：S-01（纯外部门禁：EdDSA 双密钥真实值、Sparkle 编译证明、实机安装验收）、G19（CI 内启动签名打包 `.app`：凭据 + GUI 会话）、S-44（收窄残余：Electron 43.4.0 无授权查询/申请面，只剩实机确认系统提示等价）、S-10（隐藏态节流代码已对齐，遮挡/App Nap 无实测，见上文实机门禁）、T-28（U1 引擎差异：open-in 观感差异已证伪版本偏差，可对齐两项已改；`corner-shape` 超椭圆待 vendor `ui-theme` 单点裁决，裸 `scrollbar-width`/`field-sizing`/`text-autospace` 引擎降级已登记）**；实机核验清单（第二轮启动恢复、**打包态冷启动首载复验（宿主不占用 17500）**、首帧时序、beta 真机下载安装、坏密钥页面态、Sparkle 节奏、ATS loopback、登录项回读、工具链 native gate 的 WKWebView 段、隐藏/遮挡态）见 §4；统一登记在 `docs/progress/deviations.md` §1/§3/§4，可达性纪律与盘点见 §6。

- **原生窗口高度折中待裁决（2026-09，open）**：Swift 内容区取 1280×786（外框 ~814）对 Electron 外框 1280×800（视口 772）两侧各偏 ~14pt；单侧对齐（原生取 772，或 Electron 开 `useContentSize` 后两端同取 800）未决。登记见 deviations.md S-49；宽度偏好仍是 per-flavor 页面存储（T-18）。

- **macOS Swift 原生壳（design 25，路线 A）开放门禁**：计划期的 D1–D7 正式签核未走形式流程（实现按推荐默认值落位；其中 D3 的更新路线经用户 2026-12 裁决改为 Sparkle 2），M5 门禁未闭合。剩余：① **实机/GUI 验收（打包 `.app` + 真实实例）**——打包态冷启动首载（宿主不占用 17500：首载等 sidecar ready + 有界退避、失败页携带真实原因与端口占用提示）与同 bundle 二次启动的单实例流程、通知权限时机与点击激活会话、SMAppService 登录项、LaunchServices
  深链冷/热启动、关窗隐藏与恢复、唤醒补发、ATS loopback、最小化/被完全覆盖与 App Nap 语义（S-10），以及 WKWebView 无 `backgroundThrottling:false` 等价物下的
  SSE/WS 心跳与恢复（design 25 §8.1 C1/C2、§8.5 W1–W6；判定标准见 `todo/macos-swift-v1.md` §七）；② **凭据 /
  runner-only 发布证明**——Developer ID 签名、公证、stapler、spctl 各臂与 arch（lipo）断言实跑，以及首个正式
  `build-swift` 发布腿（release.yml 已 fail-closed；缺 Apple 凭据 = 外部阻断，design 25 §7 / companion A6）；③**M5
  实机矩阵**——W-28（打包态全链矩阵）…W-32（R1–R13 复盘 + D1–D7 复核）未执行（W-29W1–W6 逐项判定、W-30
  双端性能/体积对比见 companion §七/WBS）；**双端 harness 未实施**（`swift-harness-driver.test.ts`，需 mac + GUI）；④
  **有意保留的零 core 消费者契约面**——`resolveResource`/`isPackaged`/`notifyClicked`/`trayAvailable`/
  `focusMainWindow`/`launchApp` 与 HostEdges 同步 `setKeepAwake`/`setLoginItem` 在 `desktop/shell-core.ts:679-762`
  只有声明与 doc、无调用点（settings 走装配 ctx 的 async叶）——flavor 契约，不是死代码；⑤ **`BridgeClient`
  事件帧入站面保留**——`onEvent` 派发（`macos/Sources/DSHChamberPoc/BridgeClient.swift` 的 `onEvent` 声明与
  `processStdoutOutcome` → `handleIncomingLine` 分发点）无生产接线，仅为
  `BridgeClientIntegrationTests` 夹具保留， 删除前须先处理该测试；⑥ **通知音效平台等价物**——Swift
  `silent → 无声`、否则系统默认声（`SwiftEdgeHostLegs.swift:219-222`），Electrondarwin 具名
  `Glass`，UNUserNotificationCenter 无该资源，差异已登记。

- **起始端口偏移**：本地默认 17510、控制面默认 17500；当前固定起始端口 + P+1 重试 + 记录仲裁，是否开放配置仍未决。

- **trusted-host 自定义 Host**：当前反代 Host 与实例自身 `127.0.0.1:<port>` 一致；未来引入自定义 Host 时须同步扩
  trusted-host 集。

- **多控制面 `$DSH_HOME` 冲突**：同 stateDir 共享 home 时会话 JSONL 可追加，settings 由dsh 的 `settings-conflict` 仲裁；是否进一步隔离未决。

- **多控制面 catalog metadata 无跨进程 CAS**：label/accentColor 并发修改last-writer-wins。design 25 §6.3 的
  `<userData>/.dsh-chamber.lock` 只做 flavor/实例互斥（仲裁权威是 flock 本身，pid/时间仅诊断），**不能**当字段级
  CAS； 可靠多 writer 需锁内 reload + 字段 intent，否则应正式改为「并发 plane 必须不同 stateDir」。普通pidfile/mkdir
  stale lock 存在三方 takeover 双持，不能作为修复。

- **响应头白名单双处同步**：权威在 04 §4.3，仍建议把代码/文档表述进一步单源化。

- **`__DSH_BOOT__` 随 dsh 版本漂移**：manifest 形状继续以 vendor `parseBootManifest` 为准维护。

- **未挂载来源是否需要只读 `workspace/follow` 流（2026-12 提出，未决）**：一次性消灭「未挂载来源整源降级」的架构级解法（相关登记：合成 cwd 分组/空归档集、首屏整源降级、工作区集合滞后）。代价真实：侧栏对未挂载来源用的是纯 fetch unary
  客户端，流需新增 WS/SSE 传输 + 世代/重连/`baseline`-once 语义 + 与挂载推送去重；且等于在侧栏再实现一份「前端运行时会话/工作区读通道」，触碰「控制面/侧栏不重实现执行面」边界。**当前不走**（本地回声已覆盖可感现象），定位 owner 级设计决策。

## 范围决策与必要取舍（不做 / 推迟 / 移出 / 偏差）

> 双 flavor 专项登记（用户可感偏差 S、有意结构差异 T、Swift leg 接入缺口 P、门禁/覆盖缺口 G 与文档漂移 D，外加可达性纪律与盘点）见 [deviations.md](deviations.md)；本节继续持有 chamber 对上游/平台的取舍、偏差与降级，仍开放的工作见上文与 deviations.md 的 open 条目。（原文：本文件仍是「未完成 / 未决 /
仍成立取舍」的权威记录；已落地的偏差从本文件删除、在deviations.md 标 retired。

- **重启即重载：用户发起的插件刷新入口已全部接线（2026-12）**：页面侧 client 插件集在窗口 boot 时固定，用户发起的实例/
  托管 dsh 重启必须附带一次窗口重载，否则新装/重打包的客户端半身不出现。**有意不接**：gateway「重启网关服务」（systemd
  ，不改变实例插件集）。**仍不覆盖**：不经 chamber 界面的插件集变更（外部改 profile 且实例未重启）只能手动刷新窗口（
  Cmd/Ctrl+R）。失效判据：新增重启/生效入口必须接同一 completion（或注明不接理由），且
  `sidebar/shared/restart-window-reload.ts` 用例覆盖「就绪即重载/预算内未就绪不重载/同 key 单飞/卸载不取消」四路径。

- **降级事实覆盖边界（2026-12）**：已覆盖活动视图横幅、侧栏来源行、连接页卡片与插件对话框（事实 =
  `ChamberServerAggregate.bootGap`，design 05 §4）。仍不覆盖：② 未激活/未预热来源无壳无事实；③
  壳回收时缺口行随shellStates 清除、重挂后 5s 探针重报；④
  事实单槽、后报覆盖先报（改列表会外溢投影/渲染/重试计划，暂不做；`shell.test.ts` seam 钉住）；⑤
  侧栏来源行只有说明没有动作（新增跨包请求通道不做）。

- **侧栏行悬停卡片由本仓自持（2026-09-13 偏差；上游修掉竞态即可退役）**：vendor `HoverCard` 是否 arm 宽限关闭由**上一次已提交的 `open`** 决定（`ui-primitives/src/HoverCard.tsx:183-188`），本仓每实例一个大 React root、dwell 触发到提交可差数十毫秒，窗口内 pointerleave 漏 arm ⇒ 卡片挂载后无法关闭。改由 `RowHoverCard.tsx` + `shared/hover-intent.ts` 渲染（状态机替换，契约与上游等价）。有意偏差与内容差异见 design 06 §7（页面级单卡、blur/hidden 关闭、锚点滚出即关、
  `ResizeObserver` 重算、copyEpoch；workspace 卡只读，会话卡状态行 0–1）。**退役条件 = 上游修掉竞态**；
  `verify-upstream-touchpoints.mjs` **C15** 断言竞态两侧形状 + 时间常数锁步，**上游一修升级 pin 时本门先红**。证据：
  `sidebar/test/session-rows/hover-intent.test.ts`；实机走查 W-4b/-race/-swap/-dismiss。

- **连接页手写 tooltip 未走 vendor `Tooltip`（2026-09-13 偏差；a11y 仍 open）**：
  `ConnectionsSection.module.css:320-375` 用 `data-tip` + `::after` 自绘（13 处），气泡无 `role="tooltip"`/
  `aria-describedby`；站点均有 `aria-label` 故可访问名不丢，缺的是气泡文本与触发按钮的程序化关联。触屏抑制已覆盖
  `[data-tip]::after`（`mobile/src/client/styles.ts:147-167`）。**未决**：补 ARIA 关联或改用 vendor `Tooltip`。

- **sidebar/layout 的 `bundle` 在 chamber 树内不可运行（2026-12 偏差）**：两包 `tsdown.config.ts` 是官方模板拷贝，
  `clientBundle` 属上游树（`packages/client/tsdown.client.ts`），只在包位于 `packages/client/<name>/` 时可解析；
  `pnpm --filter … run bundle` 因缺该文件与 `tsdown` 依赖必然失败。本仓不构建也不消费两包 `lib/`（树内消费走
  source），C8 与 CI 不含它们；要打通发布路径须先定「谁构建、在哪构建」，故不在本仓补无法验证且面向 public
  包的构建契约（配置文件头已写明）。

- **git 客户端与宿主错误码重叠是有意的显式例外（design 08，2026-12）**：`path-unavailable`/
  `workspace-path-unavailable` 同时是宿主可重试码与客户端确定性拒绝码——客户端把它们从宿主 `RETRYABLE_CODES`（
  `git-worktree/src/core.ts:392,400`） 提升为确定性（`client-ui-git/src/shared/git-api.ts:95-98`，理由
  `:79-94`）：两者都出自宿主 `existingPath` 探针，重放只会再跑同一失败探针。宿主保留可重试是因为同一码也会在已提交删除后的 `reconcileBoundRemove` 出现（
  `core.ts:2504-2595`）。重叠由 `host-client-lockstep.test.ts:286-296` 钉死 ⇒ 是取舍不是缺陷。

- **移出项（P3 硬纪律）**：匿名 control-plane 的认证/审计、薄壳聊天/会话列表/审批弹窗、控制面会话 runtime/统一索引、连接 broker/绑定、walkthrough、通知中心/历史、MCP、文件夹/笔记、web 预览、目标/终端等不得回流。设计 17/18/19/08/20/24
  的独立边界例外不得泄入匿名 control-plane、引入 session 消费者/通知历史或变成第二套执行面（design 24 例外随上游delete
  wire 退休，不作他域先例）。

- **`--no-auth` 是醒目的可信网络有界例外**：Gateway 外部部署默认必须认证，只有显式传 `--no-auth` 才可覆盖（启动器二次确认并打印安全告警），不是静默 fallback，也不授权匿名control-plane 绑公网。

- **Gateway state 根目录自动收紧**：既有 stateDir 经 pinned no-follow 描述符收紧 0700 +属主 uid 校验（异主 fail-closed
  ）；broad root 拒绝与 Windows 继承 ACL 让步不变（design17 §12）。

- **safeStorage 的诚实回退**：Gateway 凭据优先 safeStorage；OS 加密不可用时按用户决策回退 target-bound 0600 明文并如实显示。SSH 密码为 endpoint-bound 0600 明文镜像。**Windows 例外（C16）**：DPAPI 不可用时拒绝明文落盘，凭据仅内存驻留——
  S22 明文兜底仅限非 win32。

- **Windows 发布身份让步**：x64 安装包未做 Authenticode 签名，SmartScreen 提示是已知取舍；feed sha512 只证明下载完整性，不等价发行者签名。

- **macOS 平台范围让步（不做 + 推迟）**：v1 **不发布 macOS x64**（GitHub 已退役最后一个公开 Intel runner；mac 腿只有
  `macos-latest` arm64）；x64 侧另因 `bundle:dsh` 烘焙宿主平台运行时、交叉构建需 Rosetta 工具链而**推迟**（证据：
  `release.yml` mac/Linux 腿注释）。

- **N-ctx 单文档信任域**：远端实例前端与同文档内其他实例及高权限 preload bridge 共域；现有 main-frame/origin/proof/主进程确认只能缓解，真正横向隔离推迟到每实例独立WebContents 架构。

- **N-ctx 壳常驻语义收窄（2026 性能整改偏差，design 05 §4）**：「booted 壳无限常驻」收窄为保留策略——local 恒留，隐藏壳最多保留 `RETAINED_HIDDEN_VIEWS=1`，超限回收「已 settle+ 连续隐藏 ≥60s」的最久者（回收 = dispose shell + 卸载壳，实例进程/连接不受影响，重开冷 boot）；被回收源不再自动预热直到用户点开；运行中任务完成蓝点/通知边沿随壳回收暂停至重开。

- **远端宿主上的空白会话残留（2026-12，design 05 §2.2.1）**：N-ctx 下当前会话选择是**页面级单键**（
  `dsh.sessions.current`，vendor store 无 scope），每个壳冷 boot
  都「没有可恢复会话」，官方随即在其最近工作区复用/新建 （宿主 `session.create`）一个 blank 并打开——后台预热/基线收割
  boot 同样如此。chamber 三闸门只消除用户可感中间态，不阻止那次create；根治须上游给 selection 加 shell/入口作用域（
  `todo/upstream-proposals.md`）。同工作区复用使其不增长， 故按已知降级接受。

- **复合首屏 `ui-chat` 老代实例整面失败：会话面静默缺席（2026-09-12 实机，仍成立）**：composite 首屏 inject
  `sidebarRight`，唯一 provider 是未覆盖的 extra row `@deepseek-ai/dsh-client-ui-sidebar-right`（覆盖集
  `renderer/src/chamber-covered.ts`）；实例图谱缺该行 ⇒ `ui-chat` 永远 PENDING ⇒ 会话面从不注册（侧栏/头部/composer
  正常，主栏只剩 composer，无用户可见错误，仅 console
  `[chamber-entry] … still unprovided after5000ms`），降级自愈对结构性缺席无效。实机：仍有 gateway 来源跑 dsh
  0.1.2-rc.1（图谱 47 行，缺 `sidebar-right` 等六行）⇒ `conversation.session` 槽 0 字符；0.1.5-rc.1
  与本地正常。**无降级通道**（不能按来源回落宿主旧行）。**收口**：① 老 gateway 升到 0.1.5-rc.2 锚（
  `install-gateway.sh update`；`test-http` 已证可行）；②chamber 侧把代际过旧变成可见诚实提示（未排期）。

- **未挂载来源的工作区集合只有「回声 + 挂载 push」（2026-12，design 05 §2.2.1）**：应用内工作区变更（
  `shared/workspace-mutations.ts`
  唯一出口）由回声立即呈现；**别处**创建/改名/删除与顺序仍要等该来源挂载才收敛。两处具体表现（同因，不单独修）：①
  改名的 unary 兜底行按 `basenameOf(path)` 推导、该视图没有宿主 title 字段；② 删除后行留到下次挂载（点它
  `workspace/not-found` fail-closed，行内报错）。**不做**的收敛臂：每次变更付一次后台挂载（与稳态 ≤1 壳 /首启每源一次
  boot 冲突）。彻底解法同属上游读通道（见「设计未决」follow 流条）。

- **不做（v1）**：跨来源移动会话、单 store 真融合、控制面会话实时同步、远程实例管理 UI外壳。**推迟**：flat 单列表模式（与「仅按来源分类」有张力）。

- **保留项（2026-09 裁决）**：`ALLOW_BUILDS` 的 `fs-ext` 保留（回滚目标 0.1.3-alpha.2 仍依赖；登记在
  `pnpm-workspace.yaml` 与 `allow-builds.mjs`）；`runtime-host-adapter` 退役不采纳（测试夹具契约，非死代码）。

- **设置壳偏差**：壳不渲染官方 SettingsRoot（自绘 chrome；触发器行 42px、面板 r32、关闭焦点回触发按钮——上游规则）；面板渲染选中来源自己 boot ctx 台账，故该来源壳必须挂载；离线远端仍可选并显示不可达占位与连接管理动作（不触发挂载）；服务器选择器 body portal +viewport 翻转/钳位与内部滚动。

- **2026-09-11 上游对齐轮引入的有意偏差（仍成立）**：
  - **设置壳首启阶段：活动视图门只门挂载，完成集重置只跟 sessions 事实**：官方只按「当前会话空/blank」挂首个
    `settings.onboarding`；chamber 另加活动视图门（`SettingsShell.tsx` 调 `onboardingStage`，两坐标各由独立 hook
    读取； `useActiveView` 读既有 active-view 事实）——防多实例壳时别人的首启弹到当前视图；未发布读作关；代价 =
    隐藏壳首启推迟到被激活。完成集清空只跟 sessions 事实（
    `resetsCompleted = !sessionsActive`），否则一次切视图抹掉全部确认（判据
    `test/bridge/onboarding.test.ts`）。**登记残留**：完成集是组件局部的，壳重新挂载仍从空集重跑；证据
    `SettingsShell.tsx` RESIDUAL 注释；收口需跨挂载存活的每实例状态，不在本轮范围。
  - **`sectionsEmpty` 占位保留**：chamber 未发布分节台账是可达的 N 来源状态；空白列会被读成「这台服务器没有设置」而非「分节还没到」。
  - **框架失败屏深引 `ui-primitives/src/Button.tsx`（不引 barrel）——打包预算决策**：barrel 会连带 markdown/CodeBlock
    家族进主图；深引让它们留在 chamber 入口。**最近实测**（`build:renderer` 写 `desktop/dist/web/perf-sizes.json`，门值 `check-chunk-budgets.mjs`）：主图仍在 `mainGraphRaw.warn = 1,350,000` 内（余量 ≈8%）；chamber 入口 **已越过
    `chamberEntryRaw.warn = 2,000,000`**（无硬门）。**待决**：拆出/懒化首屏家族，或上调阈值并把理由写进脚本头注。失效判据：读数回门内或阈值调整与理由落进头注。
  - **`Switch` 披露属性挂原语自己的控制节点（review-fix F3）**：官方 `Switch` 无属性透传；`aria-expanded/controls` 不挂无 role 的包装 span，改由 `DisclosureSwitch`（`GeneralView.tsx:151-174`）经 `applyDisclosureAttributes` 写到原语
    `[role="switch"]` 上。收口需上游加透传；原语根即 `role="switch"` 由 （原源码文本锁，已按 2026-12 裁决移除） tripwire 钉住。
  - **「开/选中」色与进度色回到 dsh 业务蓝（2026-09 用户裁决）**：取 `--dsw-alias-state-business-primary`，不用官方中性档 `--dsw-alias-brand-primary`。落点六处（设置壳 generalCardCheck/SegmentedControl thumb/Switch 开启轨道覆盖/连接页 pluginPillActive/运行时进度填充/归档管理器勾选）；**有意不改**：官方 `RiskConfirmation` 勾选框与
    `Button variant="primary"`（官方组件 + body portal）。判据：两包 （原源码文本锁，已按 2026-12 裁决移除）。
  - **侧栏 schedule 事实由 chamber 带过去**：`shared/derive.ts:hasActiveScheduleOf` 读挂载/unary 两路径并进
    `instanceSnapshotSignature`（不进签名则标记冻在首见值）；`.scheduleIndicator` 不带上游
    `margin-right:6px`（本仓行已有 6px gap）。
  - **会话状态标记 completed/pending 都是保留偏差（2026-09 用户裁决，不改）**：运行中 = 官方 `StateDot` 10px 环；完成未读 = chamber 品牌蓝点（不用官方 done 绿——与来源头连接绿同 token；锁在 `visual-lock/（原源码文本锁，已按 2026-12 裁决移除）`
    T10）；提问/计划待审/请求权限 = 14px 图标徽标（官方是 10px warning 圆点，保留图标刻意；词表取官方
    `status.waiting*`）。**后续对齐轮不得当漏改收掉**；判据见 06 §4.3。

- **默认排序 `manual`（06 §3.1）**：按 wire 顺序，与官方默认 `updated` 不同，是有意产品取舍。**窗口标题冻结**：Electron 固定 `dsh-chamber-electron`（`main.ts:878`，`page-title-updated` 被拦），原生壳可见名 `dsh-chamber`（T-14/T-29）；两侧标题都不随页面 `document.title` 变化。

- **菜单密度 = chamber 档，不跟随官方（2026-09 裁决）**：所有 chamber 弹层菜单（session/workspace kebab、排序、git 字段下拉、open-in 应用菜单）一律走官方原语 `compact`（26px/12px；open-in 原 dense、git 原默认档均本轮改判，见 design
  20 §1/design 08 §3.3），设置页服务器下拉用自己的 markup 而保留官方圆角/背景。判据见 design 06 §7/design 15④；**下一轮上游对齐不得**改回默认/dense，锁在 `sidebar/test/visual-lock/`。

- **Electron 二进制惰性安装**（每机器共享 dist，worktree 并行共用）；**dev 实例隔离**（独立 user-data、控制面端口
  17520 起自动退避）。

- **内建版本行引导（2026-12 决策，方案 2）**：选中与内建同版本行且未装受管树、存在用户选择时主按钮引导「恢复内建」（零下载；树/快照保留），「仍下载并安装为受管版本」为显式次要动作；gateway 部署锚分支同款镜像。

- **dsh 运行时设置面（2026-12 统一）残余偏差**：desktop `SETTINGS_SET` env 下允许换 registry；恢复期矩阵收窄对齐；
  registry 白名单 desktop https-only vs gateway http-loopback；desktop 15s+6h 周期检查不移植 gateway；失败现场清除入口仅本地；metadata health 无缓存；pnpm prune 不可 abort；RUNTIME_RESTART handler 内联无单测；env×FATAL 预路由 desktop
  独有。**F4b**：gateway 侧动作 12 分钟墙钟上限（超时报 `dshRuntimeActionTimeout`），**本地腿仍无 abort 句柄**（本地重启卡死永久 pending）——需给 IPC 事务加取消通道，未排期。

- **apply-now 门形态取舍**：desktop `evaluateApplyNowGate` 是纯投影门、gateway `applyNowPreflight` 是含副作用
  preflight——输入与副作用各异，整门合一将推翻逐轮对齐语义，**不做整门合并**。

- **探针契约残余（design 18 §3.4 定稿后）**：上游 `session.list` 分页/裁剪/删除仍待上游（chamber 不落地；design 24 退休条件同源）；归档「不能瘦身」事实维持；legacy 回退 warn为可选注入 sink（desktop/gateway 未注入即静默）；激活层对上游再漂移以失败路径为准（fail-loud）；desktop SSH attach 底线 ≥ 0.1.2-rc.1（旧树给确定性 terminal「check orupgrade」）；远端瞬时重启/路由挂载窗双 404 → 通用 terminal（粘滞窗口先于探针改动存在；ready 心跳降级为瞬态会引入 60s 慢重探
  churn，取舍留未来设计）；`verifyUp` 必须在自有限期内 settle（transport 裸 await，无外层超时）。

- **0.1.2 线已知降级（仍有效）**：
  - 远端/直连 0.1.2 dsh 附加硬阻断（launch token 为远端内存随机数、隧道不可恢复；上游给检索机制前保持）；dsh×http 已禁用（design 17 §3 记恢复点）。
  - 版本芯片：本地已接线，远端隐藏（D2）。
  - cookie Max-Age=30 天无会话中重换：过期后约 10 分钟健康失败窗口触发重启换新（自愈；「过期即交换」另行排期）。
  - remote-stream 帧校验宽松于上游 exactKeys（前向兼容容差）。
  - settings-bridge agentPresets/select 合成 `{agentId:'', agentPreset}`：被调必响亮失败（无调用点，潜伏面）。
  - 端口碰撞理论面：本地实例同端口 cookie 覆盖（实际不可达，登记不修）。
  - unary 兜底归档过滤无 wire 源（仅未挂载来源与首次 baseline 前窗口；`archiveSetKnown:false` 三态；断连期间保留推送视图、残留降级视图由看门狗重连重放 baseline 自愈）。
  - **首屏「整源降级直到被点击」（design 05 §2.3；`baseline-harvest.ts`）**：首启 local 挂载 + 1 预热槽不轮转、被回收来源点击前禁预热 ⇒ N-1 个 ready 远程源停在 unary 兜底视图直到用户点击；自愈臂都要求 `mounted===true`。收割：ready
    未挂载源后台挂一次、首个权威推送即回收（尝试上限 2、失败退避 120s；托管 dsh 停机源不收割）。**剩余验收=打包态实机
    **（真实分组与归档过滤、稳态无驻留壳、慢隧道/失败源不卡 boot 链、收割期点击不被回收）。**登记残留**：①
    `harvestParked` 不再退回普通预热，只能点击自愈；② 已收割源归档集两次收割间冻结（外部变更/未挂载源 purge
    需点开才可见；应用内侧栏归档已由墓碑立即呈现）；③ 每 ready 源各付一次后台 boot（稳态 ≤1 壳；收割独立预算线）；④
    最后收割的壳保留为温壳（`shouldReclaimHarvestedShell` 让位）；⑤ `source.baselinePending` 诚实标注，托管停机另有
    `source.managedDown` + 恢复入口。
  - **gateway `ready` 不蕴含托管 dsh 就绪（`managed-runtime.ts` + App 15s 探针）**：desktop ready 只证 gateway 进程活着（verifyUp 只探 `/chamber/runtime/status`），侧栏不消费 `connectionState` ⇒ 停机/重启窗口无降级投影（按钮可点而背后不可用）。投影 = 独立字段 `managedRuntimeDown`（绝不从合并 phase 反推）；终态停机置换 phase 且
    `connected=false`；starting/restarting 折叠；degraded 呈现未连接；探针缺失/非 200 fail
    open。**剩余验收=打包态实机 **（真停后转红且 `+` 禁用、重启恢复；请求量目检）。**登记残留**：① 停机不门控 unary
    watchdog（未挂载 down 源仍 30s 拉一次；接进 `collectReadySourceIds` 需裁定）；②
    停机源来源头不再可激活（深链/通知仍可，落空由失败覆盖层）；③ settings-bridge 换 `targetUnavailable`；
    `/chamber/runtime/start` 未从设置面板直达。
  - **同一文档其它逐实例全局量（design 06 §4.6）**：① 文档级 `drop` 扇出（真实缺陷，未修；
    `ui-attachment/ComposerAttachments` 无归属判定 ⇒ 一图附两实例草稿）；② `document.title`
    竞争写（被冻结标题掩盖）；③ `--dsh-content-font-size` 播种读到上一 applier 值（下次投影自愈）；④ portal
    逃逸（真实缺陷，未修；vendor `Modal`/ 官方 `Menu` portal/SettingsShell 下拉/未注册行 `RiskConfirmation`
    切换后仍盖住 B；`.boot-gap-layer` 同样被盖；缓解 = 固定 inset 遮罩，非活动视图门控）；⑤ 主题样式表每壳 6 个
    `<style>`（良性重复）。①修法 = 按活动来源门控（vendor 源码，待 seed/patch 裁定）。
  - **活跃视图数据面拉活缺席（2026-12 评估，未实施）**：点会话行不触发聚合刷新；推送与 unary 同时失效即静默冻结在最后推送。**结论**：「ready 超阈值即强制 ctx 重连」不宜照做（ssh 源被 S2 臂排除，recency 重连造成周期白 churn）；正确信号 = 推送视图与 unary 权威列表分歧（需新判定 + 限流记账，与 design 24 §12 共用语义）。排期未定。
  - 推送通道死亡期间侧栏成员关系/归档集冻结在最后推送（恢复推送自愈）。
  - 兜底 cwd 派生分组限制：符号链接拼写可能不匹配 canonical 索引；未挂载来源新建空工作区不可见（fail-closed）。
  - git 工作树删除时 runtime 通道缺席 fail-closed（`'runtime-unknown'`）。
  - unary 长命令豁免残余与治本（design 03 §3.4）：超 30 分钟保险丝仍显式截断（504 + abort）、操作未完成、会话一致性无损；治本 = 上游 `commands.execute` 改受理即回、结果经会话事件流（宿主非 chamber 可写范围，登记上游跟踪项）；上游异步化时 dsh-runtime 激活/身份探针须平行迁移。

- **代理 300MiB 响应体上限 ⇒ 大会话导出为已知降级（2026-12）**：控制面非 SSE 响应体上限
  `MAX_RESPONSE_BODY_BYTES = 300 * 1024 * 1024`（`proxy-forward.ts:50`）；声明长度超限 `:877-884` 直接 413
  `body_too_large`，流式超限 `:951-960` 销毁 upstream 并按 headers 决定 413/断链。上游 `session-log-export` 的
  `/api/session.export` 返回完整 ZIP 流（`vendor/.../session-log-export/src/index.ts:42`/`:150-166`），chamber
  已补丁到本实例前缀故 UI 可触发。触发：单会话响应体（DEFLATE 后 ZIP，含全部 subagent 代际）> 300MiB
  ⇒下载中断/413，无分片逃生口。不修：抬高上限同时抬内存/带宽预算 ，待上游分片/可恢复下载。

- **平台词偏差 C3（2026-09 性能审计，已登记platform.ts/seed.ts/chamber-entry.ts/shell.ts 注释）**：上游
  `PLATFORM_MODULES` 仍列 `@deepseek-ai/dsh-client-ui-primitives`，chamber 自建平台集不再 seed
  该词（其整包命名空间导入把 markdown/高亮栈拖进 App 挂载前 main-graph 求值），改由 composite coveredfactory 回答
  extra 行同步 require 边，前置保证 = chamber 入口先于任何 extra bundle 装载（shell.ts C3 门 + host-graph.ts
  `awaitBeforeLoad`）。残余窄竞态 = shell prefetch 失败后 create 期并发 materialize（extra loud
  降级、重试自愈，非静默）。**跨代依赖**：实例侧 `ui-sidebar-documentpreview` 的代码预览行为依赖与 composite 同代的
  `ui-primitives`（`CodeBlock` 的 `contentRef` 经 `[data-code-block-content]` 成为唯一滚动/行定位锚点）；composite
  比实例旧一代时该行失去独立滚动区、行定位失效（纯文本仍可用）。

- **settings 簇 deferred C4（2026-09 性能审计，已登记chamber-entry.ts/chamber-covered.ts 注释）**：官方 ui-settings 保留首屏（locale/ui-theme 首屏 root-inject `settingsScope`，defer 会瘫痪壳）；后移 4 个官方settings section + chamber
  settings shell/connections。可观测瞬态仅「设置入口缺席 ≈1chunk 往返」（首个实例首冷启一次性；六家同 tick 注册，无中间空壳帧）；每服设置面板内容就是该来源 boot ctx 自己的台账，未挂载完成的来源显示「正在启动该实例的前端」。失败面（登记）：任一 import 失败 → 整簇本 boot 缺失（含 connections CRUD、dsh-runtime 管理与更新），console loud 无重试、靠
  shell 重 boot；按家族 allSettled 独立注册为候选改进。

- **插件页不检测「远端真的带了 `localOnly` 包」（2026-12，接受不检测）**：受管组件表按目标适用性列行（
  `applicableChamberPackages`：local 4 行、ssh/gateway/http 3 行），判据是注册表标志而非观测状态；远端真带
  `dsh-chamber-seed-open-in` 时该表不显示（实例自己的插件页仍显示；`classifyInventoryEntry`
  不漏进第三方区）。「确实存在才列」须在远端探针加 overlay 检查 + 偏差分支（overlay 文本 `plugin-sync.ts`
  已读到，成本近零，但为不可达状态新增呈现路径）；该门与包同期落地、无已发布播种路径，故不做。证据：design 20
  §6.2/§9、`chamber-rows.test.ts`（分类兜底由 `chamber-seed-drift.test.ts` 钉住）。

- **会话行/搜索结果标题墨色不照官方：静止次级、hover 主色（2026-09-14 用户指令，偏差）**：官方 `Rows .title` 继承行墨从不降级；本仓恢复 v0.2.4 两级——`.sessionTitle` 静止 `label-secondary`、hover 转 `label-primary`，`.searchResult*`
  与 `.todoRow` 同规则、`.todoTitle` 在行外两级同为次级。**理由**：A1 曾改常驻主色，行 hover 只剩极低对比底色wash、悬停卡出现前无可读反馈。**副作用（接受）**：静止列表更暗（当前会话行也不例外），亮度差本身就是 hover 反馈。**下一轮上游对齐不得**改回常驻主色；锁在 `sidebar/（原源码文本锁，已按 2026-12 裁决移除）` A1 一例。

- **workspace 头部行尾动作簇间距 = 4px，不跟随官方 12px（2026-09-13 用户报告，偏差）**：官方 12px 描述的是无 git
  occupant 的两项簇，而本仓该处可见簇是三项（occupant 揭示态 `.headerGit` 落在头部自身 4px 间距上），12px 会落进簇内部把一簇切成 4px + 12px。`.headerGit`/`.sourceActions` 的 4px 已随 2026-09-14 命中盒回退到 2px（见命中区条）。**下一轮上游对齐不得**改回 12px；锁在 （原源码文本锁，已按 2026-12 裁决移除） A8b（`.rowActions` =4px；`.workspaceHeader` 的 4px 作为簇左边界一并入锁）。

- **轨道来源点多于可视高度时被裁掉、无滚动入口（2026-09-13，未修）**：`SidebarRoot.module.css` 的 `.regionArea`（
  `flex:1` + `overflow:hidden`）下的 `.railDots` 无自己的 overflow/min-height ⇒ rail 态没有滚动容器。2026-09-14
  已把命中盒pass 的 `gap` 退回 12px（buttonization 的 `margin: -4px 0` 保留）⇒ 点距回 20px，不再有「少约
  1/6」。**不做**： rail 滚动呈现是设计面（官方 rail 无此层），加 `overflow-y:auto` 会引入自绘滚动条；判据
  （原源码文本锁，已按 2026-12 裁决移除） V1 一例（gap + margin 两半都钉住）。

- **footer 动作行 `gap: 4px` 是 chamber 对官方复制块的增量（2026-09-13，偏差）**：`sidebar.footer.action` 是 list 座，官方 `.footerActions` 只有 `display:flex` 无 gap，多 occupant 零间距相接，本仓补 4px；当前无注册者故发布态不可见，但
  **重抄官方块时必须带上**；判据 （原源码文本锁，已按 2026-12 裁决移除） 的 `.footerActions{gap:4px}` 一例（纵向间距仍由
  occupant 自己的 margin 承担）。

- **侧栏/git 图标钮命中区回到视觉盒，重新低于 WCAG 2.2 2.5.8 的 24px（2026-09-14 用户指令，偏差）**：2026-09命中盒
  pass 加的不可见 `::after` rim 与加宽 gap 整体回退（命中区 = 视觉盒，gap 回 2px）；这是对「指针从动作钮上离开该行」的缓解而非根治（无指针位移触发与快速甩动跨 ≈3px 纯行带仍会出现）；代价是重新低于 24px（「同类偏差全部收口」撤销）。卡片实现未回退（几何恢复、chamber 机器保留）。**重加 rim 前必须重测命中盒与纯行带**；判据两包 V1 一例。

- **根治该漏事件类的补丁未落地（2026-09-14，未做）**：上条只是缓解；根治 = 给悬停卡一条不依赖 React 合成 enter/leave
  的投递通道（wrapper 与 portaled 卡各绑原生pointerenter/leave + dwell 期几何否决）。**不做**原因 = 用户当前指令是「按
  v0.2.4 恢复」，该补丁是新机制；复发时再落，方案与验证点见 `.tmp/audit2/fix-design.json`。

- **导轨开关没有稳定 DOM 锚点、也不带 `aria-expanded`（2026-09-15，取舍）**：侧栏头部折叠钮只有会翻转的 `aria-label`；移动档替代品自行补 `aria-expanded` 的理由写在其头注。`W-4` 只能结构定位（`checks.mjs` 的 `pickRailToggle`，候选空/并列即 FAIL）+ 效果锚定（`[data-sidebar-collapsed]` 出现/消失）；`W-4a` 会写持久化偏好 `sourceFolded`，只在 `--dev` 执行。改身份锚定需先按 design 06 §7 的 a11y 名单加属性并同步 `upstream-touchpoints.md`——属设计裁决。

- **悬停几何/墨色没有真指针验收腿（2026-09-14，未做）**：`gui-acceptance` 的 W-4b 四腿都从行中心离开，覆盖不到「从动作钮离开」路径，也无腿读标题墨色两级；当前证据 = CSS 锁 +打包页注入实测（`.tmp/band-after-report.json`、
  `.tmp/ink-report.json`）。**不做**原因= 新腿须在打包应用实跑（本轮无法构建）；发布前补 W-4b-`cluster`（kebab 上 5px
  步进离开）与墨色腿。

- **不做 git 钩子（2026-12 决定）**：`core.hooksPath` 不随 clone 携带，装钩子等于要求每个 clone 重配；而钩子本要跑的检查都已是 CI 背书的普通门禁，`pnpm run check:static` 一条命令跑全。本仓不提供也不安装任何钩子，不引入 husky/lefthook
  类托管层。

- **推迟：工程门禁 P2 项（2026-12）**：观察型 CI job（非阻塞只报数）、术语表、文档字数预算、`docs/checklists/*` 过程文件转可调用动作、`README.i18n.yaml` 三元组译文一致性门（现只有哈希记录）——均未排期。

- **上游纯镜像 README 的失效链接被链接门显式跳过（2026-12）**：`dsh-client-connection`的 `README.md`/`README.zh.md` 是上游逐字节纯镜像（C1 冻结），文内 10 条相对链接在chamber 树内不存在；改镜像违反 C1，故 `verify-md-links.mjs` 以
  `MIRRORED_DOCUMENTS` 显式排除并每次打印跳过清单（不静默）；真正修复面在上游。
