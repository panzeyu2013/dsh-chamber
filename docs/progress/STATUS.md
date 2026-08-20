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
  **2026-08 插件 Modal 两处修复**：① 浅色主题下 Modal 内容（portal 到 body）未显式
  设色的文本继承 renderer 基样式的近白 body color（`--text:#e6e9ef`）→ 白底白字——
  `.dialogContent` 锚定 `color: var(--dsw-alias-label-primary)`（`.pluginName`/
  `.pluginCellSpec`/`.pluginChamberRow` 等全部随之修复）；② 本地实例 `phase` 恒为
  `loading` → footer「关闭」按钮恒 disabled 的死控件——footer 关闭按钮全部移除
  （Modal 自带头部 X/Escape/遮罩关闭，loading/error/done 只留 retry/refresh，
  ready 保留 cancel+apply）。
- **客户端插件运行时加载（设计 09，已实现）**：设计见
  `docs/design/09-client-plugin-runtime-loading.md`。遗留：图通道失败仅 console.error
  无 UI 信号（可观测性待补）。**union-table 补全（2026-08）**：覆盖包缺失模块表
  factory 导致额外 bundle 的同步 require 边落空（官方 store-engine 豁免
  `require("@deepseek-ai/dsh-client-runtime/client")`，默认 web profile 的
  `dsh-session-log-export` 行实机触发 boot 失败）——chamber-entry.ts 现为每个首屏
  静态导入的覆盖包注册模块表 factory（返回复合 bundle 内联命名空间，require 边与
  ctx 服务同实例），`COVERED_FACTORIES` 与 `CHAMBER_COVERED_FACTORY_IDS`
  （chamber-covered.ts leaf 契约）精确一致断言 + `CHAMBER_COVERED_IDS` 覆盖断言 +
  CI 锁步单测（host-graph.test.ts：每个工厂 id 必被覆盖）。**首启竞态修复
  （2026-08，05 §4）**：模块表经 boot.ts 幂等 `ensureWebModuleSystem` 在
  collectExtraRows 预加载之前装好（首个带额外行的 boot 不再让官方 bundle 在
  sink 安装前求值）；shell.ts bootError 分支经测试 loader + fixture 单测覆盖
  （`shell.test.ts`，`--import scripts/test-shell-register.mjs`）。
  详见设计 09 §3.2。**版本容忍与 rc.8 后端适配（2026-08，v0.1.2 回归修复）**：
  - **额外行 apply 失败降级**（boot.tsx 对 extraRows 容错 + sweep 排除，替代
    "任一额外行失败即整 boot 失败"——版本漂移 = 特性缺席而非损坏，见设计 09 §3.3
    修订）：rc.8 后端新增的 `dsh-client-ui-attachment` 等核心 client half 作为
    额外行无法在本壳运行时降级为特性缺席，实例照常 boot（此前 seed 遮蔽 factory
    会整 boot 崩溃）；
  - **壳种子词表对齐 rc.8 官方**（平台词 = 永不成为图行的包；`dsh-client-ui-
    attachment` 出种子词表——seed 遮蔽 factory 是 rc.8 后端 boot 崩溃的根因之一）；
  - **chamber entry 装载去 `?rev=`**（vite chunk 图裸引用与 boot 加载同 URL →
    延迟 ui-* 族不再二次执行入口 bundle → duplicate factory 消失，tool-call 兜底
    渲染修复）；
  - **app-shell renderer 安装容错**（后端行已装 renderer 时采纳，不双装报错）。
  无头验证：rc.8 后端（实例 rc.8 官方前端 + rc.7 复合壳）下 chamber 渲染器 boot
  成功、50 个 tool-call 节点零兜底、设置页渲染正常。
  **rc.8 baseline 完整对齐（2026-08，本仓可改面已全部落地）**：harness.commit →
  141eb6fef8（dsh 0.1.0-rc.8）后——复合延迟族 +3 覆盖（ui-attachment /
  ui-brand-official / ui-reference，chamber-entry.ts registerDeferred +
  chamber-covered.ts）、**ui-renderer 归 page-own**（renderer 移入
  dsh-client-ui-renderer 源：chamber-covered.ts 收编 id，dsh-client-web boot.ts
  内核收编其 client half——与 modules 同款 bootstrap 注册 + 内核 loader 行，
  sweep 审计；挂载经 `ctx.uiRenderer`，rc.8 语义）、**boot.tsx 迁 rc.8 模块系统
  bootstrap API**（boot.ts 类结构 AppWebEntry：`window.__ModuleLoader__`
  queue-mode facade 自装（chamber 镜像官方 HTML 注入）+ `createClientModuleSystem`
  bootstrap、BootPage 无框架加载页、prefetchImmediateTier →
  runPluginBoot → assertEntriesActive（chamber 容错版，classifySweepEntry）→
  mountApp）、**web-react/schema-form 深导入随删/迁移**（app-shell/AppRoot/
  app.tsx/DocumentTitle 删除——渲染与装配整体移入 ui-renderer 行；chamber 桌面
  壳本已冻结原生标题栏，标题投影迁移无可见变化；settings 系包的
  `bindSnapshotSelector` 迁 `dsh-client-ui-renderer/src/client/bind`、
  `nodeAtPath/rehydrateSchema` 迁 `SettingsSchemaService`
  （permission-decode.ts 与 rc.8 ui-permission-presets 逐行一致））。
  锁文件已按受管快照流程重生成并验证 frozen（**pnpm 11 剪枝规避**：vendor 源
  物化为仓库内真实目录 `vendor/harness-checkout`——符号链接指向仓库外源时 pnpm
  11 会剪除 vendor importer 记录；本仓已切到仓库内受管快照，
  `pnpm install --frozen-lockfile` 通过）。桌面本地宿主同步升 rc.8
  （`DSH_CHAMBER_DSH_VERSION=0.1.0-rc.8` `bundle:dsh`）。验证：
  `test:client-web`（9）、`test:renderer-shell`（29）、`test:settings-bridge`、
  `typecheck:*` 全套、根 `typecheck`、`build:renderer`、控制面 8 套测试全部通过。
  **rc.8 commands wire 兼容桥（已随 rc.8 baseline 对齐移除，2026-08）**：rc.8
  宿主 `commands.execute` Typert Remote 新增必填 `images` 参数（上游
  8d9fee19f9 起），rc.7 形状客户端缺该参数 → rc.8 宿主拒绝/崩溃 → 经
  `session.command` 的所有斜杠命令（Access 权限芯片 `/permission` 切换在内）
  静默失败。临时桥曾以 `dsh-client-connection` 的 `rc8-commands-compat.ts` +
  `rpc.ts` 按 **`host.describe` 权威版本**（>= 0.1.0-rc.8）为 `commands/execute`
  注入 `images: []`（rc.7 宿主与未知版本一律不注入），并配 `pnpm run
  test:connection`（8 用例：版本门 / 幂等改写 / 非 args 透传）。rc.8 baseline
  对齐（本包 fixture/index/依赖面 re-sync 到 rc.8，rc.8 客户端自带 `images`
  参数）后，桥、其测试与脚本已整体移除——`commands.execute` 不再有版本判定
  注入，见设计 09 §4。
  **v0.1.3 发布前 review（2026-08-20）**：容错判定规则提取为 React-free 纯函数
  模块（`dsh-client-web/src/boot-tolerance.ts`：sweep 逐行裁决 + renderer 安装
  裁决；当时的 boot.tsx/app-shell.ts 接入同一规则，rc.8 对齐后随 boot.ts 迁移），
  新增 `pnpm run test:client-web`
  单测 9 项（含失败报告字符串逐字断言，防重构改规则）并入 CI 与 AGENTS.md 验证
  清单；当时的 app-shell 采纳后端 renderer 的运行中生命周期尾门（行 fiber
  卸载清 `slots._renderer`，rc.8 对齐后该职责随 ui-renderer 行迁出）注释在案；容错日志措辞对齐实际失败类型（materialize 而非
  load）；manifest 预加载去重过滤补 `?rev=` 残留形式；设计 09 §3.3 失败降级语义
  按层表述（加载失败响亮归预加载层，apply 失败降级归 boot 内核层）。复验 ✓
  （typecheck / typecheck:client-web / test:client-web 9 / test:renderer-shell 5 /
  test:sidebar 131 / test:settings-bridge 32 / test:connections 17 /
  build:renderer / verify:i18n；rc.8 后端实机验证同前条无头记录（当时工作区基线
  为 rc.7 99f6f02f，已随 rc.8 baseline 对齐 4371cb7 推进，此处为历史记录）。
- **侧边栏聚合改事件驱动（设计 10）**：实现未排期——改动 05 §3 契约，需评审确认；详见
  `docs/todo/10-todo-event-driven-aggregation.md`。
- **桌面端更新提示（设计 11，已实现，2026-08）**：M1–M3 全部落地——主进程
  `updater.ts`（electron-updater，autoDownload=false + 退出时安装 + 静默失败日志 +
  mac 安装腿 `installBlockedReason` 探测）、preload `update` IPC 面、settings 壳
  chamber 全局「更新」入口（`__update` + `UpdateSection`，zh/en）、desktop build
  配置（publish/mac zip/differentialPackage）、release.yml 双 leg 更新产物
  （`--publish=always` + GH_TOKEN；channel 由版本 prerelease 后缀推导；公开发布
  缺 Developer ID/公证或 Authenticode 凭据即在创建 draft 前失败，产物再验签）、
  `DSH_CHAMBER_UPDATE_CHANNEL=beta`。设计见 `docs/design/11-auto-update.md`
  （2026-08 自 docs/todo/ 移入）。**2026-08 修订（用户拍板）**：`__update` 固定
  入口并入「通用」段（`GeneralView` 底部 `UpdateSection` 控制组，样式对齐官方设置段
  控制组/胶囊词汇），新增「检查更新」按钮（`dsh-chamber:update-check` →
  `updater.checkNow()`，与周期静默检查同一条 `runCheck()` 路径，linux 显式拒绝；
  `update-gate.ts` 相位门 + 纯逻辑测试）。剩余：配置真实签名秘密后的 release CI
  上传/公证/验签实测，以及双平台实机检查/下载/退出安装；mac 安装腿未配置
  Developer ID 时 settings 响亮提示手动安装。
- **已归档会话管理（设计 12）**：方案 A（前端已归档浏览区先行）+ C（上游 wire 根治）；
  实现未排期；详见 `docs/todo/12-todo-archived-sessions.md`。
- **睡眠/后台常驻（设计 14，v1 范围已实现，2026-08）**：关窗行为可设
  （`windowCloseBehavior`：托盘 / 退出，hide 不杀进程，控制面/隧道/dsh 实例继续
  运行，**托盘可用门控**——dev/无托盘回退关窗即退）+ 登录自启可设（`launchAtLogin`，
  mac `setLoginItemSettings` / linux XDG autostart，win 门控）+ 退出确认
  （`quitConfirmation` 可设开关，**2026-08 修订（用户拍板）**：仅本地实例运行中
  时确认——远程隧道不影响关闭，`computeQuitRisk` 弃 remoteReadyCount；**更新已下载
  时豁免** + 单飞）+ 唤醒即时重连（powerMonitor
  resume → `system-resume` 推送 + 主进程对 error/degraded 即时重探，绝不触碰
  idle）+ 防休眠（`powerSaveBlocker`，默认关）+ `chamber-settings.json` 主进程
  存储（0600 原子写、损坏 *.corrupt 保留、非秘密）+ `backgroundThrottling: false`
  （隐藏窗口不节流）。渲染侧：App 层分发 window `dsh-chamber:system-resume` 事件，
  dsh-client-connection chamber 补丁（stop+start 立即重连）。实现：`chamber-settings.ts`
  （纯逻辑）+ `main.ts`/`preload.cts`；验证：根 typecheck ✓、`test:desktop`（含新增
  12 用例）✓、`build:preload` ✓。设计见 `docs/design/14-sleep-background.md`。
   **2026-08 review 轮修复（3 subagent 独立审查 + 独立验证）**：P0 退出时序——
   退出确认移至 `before-quit`（原在 will-quit 内置位 `quitRequested` 过晚，
   hide-to-tray 默认下 Cmd+Q/托盘退出被 close 吞掉、确认与更新退出安装不可达；
   取消不丢窗口）；P0 重连竞态——`ConnectionController` 加 loop epoch 守卫
   （stop()+start() 同步重启不再产生双并发 pump loop/重复 onConnected，chamber
   patch 标注）；P1 打包——electron-builder `files` 补 `chamber-settings.ts`；
   P2：`localRunning` 口径放宽（含 starting/restarting）、确认框重入拦截、
   lastResume 已发送即清、持久化失败回滚副作用、`__general` 导航解析抽纯函数
   `nav-active.ts` + 3 用例、GeneralView 桥未水合禁用控件 + 错误行 aria-live、
   文档通道名 `dsh-chamber:settings-*` 同步（设计 14/15/05 §7.4）。修复后全量
   复验 ✓（typecheck / 双测试套件 / build:preload / build:renderer / verify:i18n）。
   **2026-08 review 轮 2（渲染层审查）**：P0 竞态修复经**真实仓库文件复现验证**
   （/tmp/race-verify.mts 重放 B 场景 A：stop()+start() 后 `delta=1` 干净重连、
   无残留 loop/重复 onConnected）；P2 补齐——`SYSTEM_RESUME_EVENT` 共享常量
   （dsh-client-connection 导出，App.tsx 字面量以注释锁定同步；renderer tsconfig
   无法解析该包深路径导出，故不跨包 import）、GeneralView radio 组 useId 命名 +
   `role="group"`/aria-labelledby、桥未水合禁用已含。复验 ✓（typecheck /
   test:settings-bridge / build:renderer / verify:i18n 全绿）。
   **2026-08 review 轮 3（终审，3 subagent）**：结论可发布；修复 2 条 P1——
   ① `behavior='quit'` + X 关窗（非 darwin）取消确认后窗口已销毁 → 取消/对话框
   失败分支检测 `mainWindow` 销毁即 `showMainWindow()` 重建（不再无窗滞留）；
   ② `reconnectStaleTransports` 跳过 `requiresUserAction=true` 终态实例（05 §7.6
   「确定性验证失败免重试」，唤醒不再对认证失败等重复 spawn）。P2 顺手修：
   before-quit `preventDefault` 移至风险计算后（意外异常不吞退出）、
   `applySettingsPatch` 副作用包 try + best-effort 回滚、托盘注释与 resume 补丁
   注释表述修正。复验 7/7 ✓（typecheck / 双测试套件 / build:preload /
   build:renderer / verify:i18n）。
   **2026-08 退出不彻底实机排查（dev:build + CDP/信号触发关闭流程）**：
   优雅退出（app.quit() 路径，CDP Browser.close 等价 Cmd+Q）资源回收干净
   （主进程 code=0，控制面/本地 dsh/ssh 隧道全部无残留）；**强停（SIGTERM/
   job_kill）路径主进程直接终止、不走 will-quit 清理 → detached 的本地 dsh
   实例残留占端口**（机器上 67995@17511、75891@17512 即历史孤儿实证）。修复：
   主进程监听 SIGTERM/SIGINT → 置位 quitConfirmed 后 app.quit()（信号本身即
   明确退出意图，跳过确认框），will-quit 完整回收。实机复验：进程组 SIGTERM
   与 dev launcher job_kill 两条路径均 `dsh process exited (0)` →
   `local connection → stopped` → `electron 已退出（code 0）`，端口/隧道零残留。
   **2026-08 实测修正**：macOS Electron 43 主进程的 `process.on('SIGTERM')`
   **不触发**（Chromium 消费信号走自身默认优雅退出，同样触发 before-quit →
   will-quit，资源回收完整）——上述"干净退出"实际由 Electron 默认行为 +
   quitConfirmation=false 测试设置共同呈现；handler 保留为 linux/win 平台兜底；
   macOS 信号场景（quitConfirmation=true 且本地实例在跑）会走正常确认框等待
   用户（非卡死）。
   **2026-08 退出误弹确认实机排查（dev:build + CDP/端口占位触发）**：确认判定
   改「状态机 running **且实际有存活进程**」（`localProcessAlive`，控制面新增
   `hasLiveProcess`）——restart 序列里 `restarting` 期间新进程尚未 spawn
   （backoff 1s→60s）、死亡进程在下次探活前滞留 ready/degraded，状态字符串不是
   存活事实，此前"本地明明没有实例在运行"也会误弹确认。同时修复**退出半滞留**：
   `cp.stop()` 的 `server.close()` 在残留连接（页面 SSE/WS/代理，如本地宿主崩溃
   后页面重连中）上挂起 → 主进程"窗口已关、进程仍在"；stop 增加
   `closeAllConnections()` 强制断开 + will-quit 清理 15s 超时强制 `app.exit()`
   兜底。实机复验：杀 dsh + 占满候选端口 → 状态 restarting 无进程 → 退出 code=0
   不弹确认（修复前 HUNG）；实例 ready（有进程）→ 仍弹确认（不过度）。
   **2026-08 review 轮（3 subagent 分区审查：桌面退出生命周期 / 设置桥前端与
   更新链路 / 连接插件 Modal；全部 P0=0）**。修复 P1：① 控制面 `startImpl`
   spawn 后置检查只信 `stopping`（stop() finally 复位）→ stop 在途 spawn 竞态
   "复活"、退出留孤儿 dsh——改 epoch 守卫（对齐 triggerRestart）+ manager-api
   回归测试「DELETE during in-flight start」；② `onChildExit` 无 `startPromise`
   守卫 → startImpl 拆旧 child 的 exit 触发伪 restart、双 spawn 泄漏——加守卫；
   ③ connections 镜像 `UpdateSurface` 缺 `check()`（接口合并漂移，两路交叉
   确认）——补行；④ 插件 Modal 嵌套子 Modal 时 Escape 连主 Modal 一起关
   （primitives Modal 各实例都注册 document keydown）——`close` 门补子 Modal
   状态；⑤ seed 注入与 apply 可并发 + seed 后 loadSync 重置勾选——`doApply`
   加 seedBusy 门、apply 按钮 disabled、seed 后保留勾选（keepChecked）；
   ⑥ linux「检查更新」死键（主进程拒绝未镜像到 UI）——`updateCheckPlatformBlocked`
   + 测试；⑦ 本地列表失败无重试入口——error 分支加 retry 按钮。修复 P2：
   before-quit 无风险路径 `app.quit()` 重入改 return、确认框取消分支加
   `!quitRequested` 守卫（SIGTERM 退出在途不重建窗口）、`showMessageBox` 包
   try/catch（失败必复位 confirmingQuit，防退不出）、15s 超时日志补「更新安装
   被跳过」、`starting` 装饰性条目注释、死 CSS `.updateActions/.updateActionRow`
   删除、quitConfirmation 未水合按默认 true 占位。遗留（记录在案）：apply 卡死
   无出口（需 main abort 支持）、update-store `state()` reject 水合边界（概率
   极低）、GeneralView save busy 闪烁（无正确性影响）。复验 ✓（根 typecheck、
   插件 2 typecheck、test:desktop、test:settings-bridge、test:connections、
   控制面 8 测试 + 新增 stop-race 回归、build:renderer、verify:i18n 全绿）。
   **2026-08 v0.1.2 release review（5 subagent 分区审查 + 独立验证）**：结论
   可发 v0.1.2；修复——① macOS `windowCloseBehavior='quit'` 关窗不退出
   （window-all-closed 在 darwin 不 quit → 无窗常驻、D2 确认不可达；现 quit
   设置下 darwin 也走 app.quit()，取消分支重建窗口）；② `isAllowedReleaseUrl`
   编码穿越绕过白名单（`..%2f`/`%2e%2e%2f` 经 decode 归一化后拒绝 +
   userinfo 拒绝）；③ updater 下载在途与 6h 周期复查竞态（downloadInFlight
   闸：复查不再把 `downloaded` 打回 `available`，丢失「已下载，退出时安装」
   与退出豁免）；④ `sanitizeErrorText` 路径脱敏扩展至任意 POSIX 根（/opt、
   /usr/local、/Library、/run、/root…，URL 保留）；⑤ chamber-entry 懒加载
   契约修订——vendor ui-model-selection 的 ROOT inject 含 `commandUi`（由
   commands 提供，commands 又依赖 input-trigger 的 `inputTriggers`），原头注
   声称"嵌套 inject 不阻塞"不成立：commands + input-trigger 移回首屏静态组
   （模型座位不再等 deferred chunk，chunk 失败也不丢模型选择器），头注契约
   重写 + COVERED_FACTORIES 锁步；⑥ 侧边栏 rowActions 两个 stopPropagation
   未配对 `clearPendingClick()`（pending-click INVARIANT，误触进入重命名）；
   ⑦ remotePluginList 的 manifest cat 补 `quiet`（未初始化远端 profile 不再
   污染日志面板）。发布准备：6 包版本一致 bump 0.1.1 → 0.1.2（根/desktop/
   control-plane/renderer/cli/dsh-host-client-graph——host-graph 补入设计 11
   §8 版本集），release.yml 断言扩至全部 6 包 + concurrency 守卫；README 特
   性列表补 11/14/15 用户面；connections `global.d.ts` 声明镜像补
   settings/systemResume（接口合并契约）。复验 ✓（根 typecheck、
   插件 4 typecheck、test:desktop 186、test:sidebar 131、test:settings-bridge
   28、test:connections 17、static-serving 6、test:renderer-shell 5、
   build:renderer、build:preload、verify:i18n、frozen-lockfile 全绿）。
   记录在案（NIT，非阻塞）：updatedOrder/sessionUpdatedAtByAccount 只按来源
   不按 workspace 修剪（官方 retainAccountKeys 逐 workspace；有界、渲染不可
   见，契约变更留后续）；settings-store/update-store 未加 singleton 守卫
   （需跨包导出 + ambient 镜像，为诊断引入耦合不划算）；GeneralView 保存无
   在途闸（主进程串行 + 推送收敛）；web 构建无桥时 hydration 重试链空转
   （有界 2s）。
- **Chamber 设置呈现（设计 15，v1 范围已实现，2026-08；范围缩减）**：v1 平铺形态——
  settings 壳固定入口扩为 连接/通用（`__connections` / `__general` + `GeneralView`：
  关窗行为 / 登录自启 / 保持唤醒 / 退出确认，zh/en i18n）；**2026-08 修订 1**：
  更新并入「通用」段（原 `__update` 固定入口移除，`UpdateSection` + 「检查更新」
  按钮）；**2026-08 修订 2（用户拍板）**：`__general` 按 OpenChamber 式控制组组织
  （启动与关闭 / 运行 / 更新，组标题 + 平铺行，替换描边卡片），「退出确认」由只读
  说明改为可设开关（`quitConfirmation`，默认开，仅本地实例运行中时确认）；两级分组、
  插件提级、新插件包、关于页**推迟不做**；chamber 全局设置统一走主进程
  `chamber-settings.json`
  （`dsh-chamber:settings-get/set` + `settings-changed` 推送，非秘密），与实例配置
  平面严格分离（01 §2 P2）。验证：根 typecheck ✓、`typecheck:settings-bridge` ✓、
  `test:settings-bridge`（5 文件 31 用例）✓、`test:desktop`（chamber-settings 13 用例
  更新）✓、`build:renderer` ✓、`verify:i18n` ✓。
  设计见 `docs/design/15-chamber-settings-page.md`。
- **设计未决**（02 §5 / 04 §7）：starting port 偏移、trusted-host 自定义 Host、多控制面
  `$DSH_HOME` 冲突、响应头白名单双处同步、`__DSH_BOOT__` 随 dsh 版本漂移。

## 范围决策与剩余偏差（不做 / 推迟 / 移出）

- **chamber 合成包懒加载（LCP/perf pass P4，2026-08）**：非首屏 ui-* 家族（jobs、
  goal、skill、tool、trajectory、workflow-run、deliverables、subagent、
  message-feedback、plan、user-questions、agent-preset、permission-presets；2026-08
  v0.1.2 review 后 commands/input-trigger 移回首屏——见 design 11 §8 旁的 review
  记录）在 chamber-entry.ts 中改为动态 `import()` 并按 fire-and-forget 注册：
  `apply` 同步注册首屏
  家族后立即返回（entry 根 fiber ACTIVE，boot 的 loader.await + assertEntriesActive 通过），
  迟注册的子 fiber 不阻塞首屏（cordis inject-waiting + reflect 通知驱动已渲染 UI 渐进出现
  迟到的槽位/服务）。契约边界：apply 返回 thenable 会被 `_execute` await（fiber.ts
  `_execute`），因此 apply 必须保持同步返回；sweep 只检查 loader entry 根 fiber，不含子
  fiber。首块 chamber bundle 934KB → 650KB（gzip 188KB；commands/input-trigger 于
  v0.1.2 review 移回首屏后 +44KB）；settings-bridge 的
  agent-preset settings 段改为装配子 ctx 时动态导入。设计/验证细节见 chamber-entry.ts 头注。
- **本机信任边界加固（2026-08）**：匿名 loopback 控制面在 HTTP 路由与 WS
  upgrade 前同时校验 loopback Host 与来源；不透明 `Origin: null` 一律拒绝，静态/API/
  代理响应统一带 CSP（内联 boot 脚本逐响应 nonce，script 不开放 unsafe-inline）、
  COOP、no-referrer、nosniff 与 frame deny，Electron renderer 显式启用 sandbox。
  SSH 隧道/systemd/白名单 run 全部强制 `StrictHostKeyChecking=yes`，askpass 不再代答
  主机密钥确认；密码镜像使用 write-through 持久化语义并强制 owner-only 权限。
  桌面 dsh runtime 的精确版本和 frozen lock 只用于可复现的本地内嵌 runtime，不约束
  远程实例版本；远程仅做协议能力兼容检查。
  **2026-08-20 安全/性能复查修复**：Electron IPC 仅接受当前主窗口 main frame 的
  精确 `/` 壳文档；materialize 仅接收插件名，由主进程重读权威 manifest、realpath
  并核验 package name。控制面 Origin 收紧为当前 Host 精确同源或显式 allowlist；
  代理加入 HTTP/WS/SSE/请求体预算、慢上传和上游空闲超时，实例、密码、插件等输入
  均有限额；慢上传失败会取消请求 iterator，重建请求会剥离原始 framing/proxy 头。
  管理面 health-events SSE 将 `write() === false` 作为背压而非断连处理：每客户端
  至多排队 32 个状态帧、`drain` 后按序刷新，溢出/异常/断连统一释放订阅与监听器。
  插件子进程改为异步、有界输出和超时终止；askpass 目录与助手均为 owner-only
  0700（助手由 OpenSSH 直接执行），助手名带 owner PID。聚合轮询并发限制为 4、
  后台预热远端限制为 3，删除实例会释放 client，
  布局共享订阅改为单监听 + WeakRef。boot manifest JSON 做 script-context 转义，WS 101
  只透传握手白名单头，transport 只接受 loopback origin，HTTP server 增加连接与超时
  上限；macOS Developer ID 探测完成前更新下载保持 fail-closed。Actions 固定完整 commit
  SHA，公开 release 缺签名、公证凭据或产物验签失败即不发布。
  发布凭据预检发生在删除同标签旧 Release 之前，缺凭据失败不会先破坏已有发布记录。
  bundle 会清理中断的 `.dsh-src-<pid>` 暂存树，打包只复制 `vendor/dsh`；macOS 产物
  显式关闭 ATS 全局任意加载，仅为 loopback 控制面保留明文 HTTP 例外。runtime 的
  `pnpm-lock.yaml` 是 `packages/desktop/vendor` 中唯一纳入版本控制的文件，保证干净
  checkout 首次封装也能执行 frozen install，其余 runtime 产物仍全部忽略。
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
- **侧边栏交互对齐 OpenChamber（2026-08，已落地）**：会话行单击立即打开、
  350ms 内同会话第二次点击进入内联改名（`shared/pending-click.ts` 全局
  pending 单例，跨 N-ctx 共享）、blank 门控 + 450ms ghost 宽限、跨 shell
  滚动锚点同步（`renderer/src/sidebar-scroll-sync.ts`）、侧栏宽度全局化
  （ui-layout fork，`sidebarWidth` 持久化于 `dsh-chamber.sidebar.v1`，
  [264,420] 钳位）。交互细节与加固（stopPropagation 配对、ghost 守卫、
  checkVisibility 重试等）见 `docs/design/06-sidebar-enhancements.md`
  §2.2 / §3.1——不再在 STATUS 复述。
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
  renderer entry 级 React 面仅剩纯 dsh 桥接宿主；当前来源判定经 knob 注入；拷贝包
  `tests/` 为上游 vitest spec 惰性拷贝（chamber 侧验证走各自 node:test 门）；`chamber-auth` 随认证移除；settings 页 `ns.inject('settings.section')` 通道可用于
  后续插件化。
- **窗口标题冻结（桌面壳故意偏差）**：桌面壳冻结原生标题栏为 `dsh-chamber`（单 frame 品牌
  恒定），会话名仍在应用内呈现。
- **dev 实例隔离（dev 契约，2026-08）**：`electron-dev.mjs` 以独立 `--user-data-dir`
  （`packages/desktop/.dev-user-data`）+ dev 控制面端口 17520（`DSH_CHAMBER_CP_PORT`
  覆盖）启动，并清除继承的 `ELECTRON_RUN_AS_NODE`——dev 与运行中的打包版实例
  （同一应用名 `@dsh-chamber/desktop` → 同 userData/单实例锁、占 17500）可共存；
  打包版默认端口/数据路径不变。
