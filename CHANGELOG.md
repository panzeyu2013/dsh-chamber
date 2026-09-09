# Changelog（变更日志）

本文件记录 dsh-chamber 的全部重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目遵循[语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

发布产物与各版本的发布说明同时发布在 GitHub Releases 页面
（`https://github.com/panzeyu2013/dsh-chamber/releases`）。

> English: [docs/CHANGELOG.en-US.md](docs/CHANGELOG.en-US.md)


## [Unreleased]

### 变更

- **修复 N-ctx 同源壳下四处同源绝对 URL（D3 裁决：构建期 vendor 补丁集）** —— 官方客户端假定自己由 dsh 源提供，但 chamber 单页多实例（N-ctx）下页面 origin 是控制面，而控制面只代理 `/api/i/<id>/*`。三轮全仓扫描出**四处**（二轮只发现一处）：① `ui-chat` 的 `/api/file`（Markdown 本地图片，坏图）；② `client-file-upload` 的 `/api/session/uploadFileBinary`（**composer 附件上传 404**）；③④ `ui-deliverables` 的 `/api/present.host|open`（交付卡「打开/定位」404）。裁决（以上游为准 + 最小侵入）：**不为几行 URL fork 整个 `ui-chat`**（82 文件 / ~11.3k 行），改为**登记式构建期补丁集**——`packages/renderer/scripts/vendor-patches.mjs` 由 renderer 的 `deepseekSource().transform` 按**精确上游锚点**改写（当前 4 条 / 5 文件 / 18 处锚点），vendor 文件零写入，锚点漂移即构建失败：`ui-chat` 读新增 root 标准 prop `chamberFileApiBase`（layout fork 经 `ctx.slots.provideRoot({ props })` 提供 = 本 entry 的 `ctx.chamberBasePath`）、`client-file-upload` 从服务自身的 ctx 读同一事实、`ui-deliverables` 控制器构造时接收；base path 缺失（官方布局部署）回落上游行为。为让补丁覆盖上传客户端，`client-file-upload` **转为 composite covered**（covered/factory 54/26；extra-row bundle 由实例提供、不经过我们的构建），同时消除该 extra-row 依赖（探针清单收敛为 `sidebarRight` 一条）。保鲜门：触点表 **C9**（锚点唯一命中，硬失败）+ `scripts/vendor-patches.test.mjs`（锚点/改写后行为/id 形态）+ `build:renderer` 末步 `verify-vendor-patch-applied.mjs`（**构建产物**里必须出现补丁形状，防 transform 静默 no-op）。**已知边界**：本地与 gateway 来源经控制面注入 cookie 后可用；ssh/http dsh 目标仍无 cookie 注入（实例侧 401），属既有认证面待办。
- **dsh 双线重锚 0.1.5-alpha.2（源码线 + 运行时线同代）** —— 构建期 vendor 源（submodule pin）与捆绑运行时同时推进到 `dsh-v0.1.5-alpha.2`（b2e3b2a01258，上游 master HEAD；vendor 链接 271→**284**，上游 +17/−4 包：新增 `apps/desktop`、`apps/desktop-host`、`native/system` 家族、`api/workspace-files`、`client/resources`、`ui-dockkit`、`ui-sidebar-{right,files,documentpreview}`、`session-format-v2-to-v3`、`fs/tool-present`、`util/chunked-list`，移除 landlock 家族）。上游在本区间重写了客户端外壳的两代槽位模型（`details`→`rightbar` 且 scope 由 session 改 root；中心列 `conversation`→**keyed `main`**；新增 `sidebar.panellist` 全局面板轴、`usePanelInfo`/`useResource` 全局座、`ctx.layout.selectPanel`/`beginNavigation`），chamber 自建物随之全量重放：
  - **layout fork（P0）**：`children` 改为 `sidebar`/`main`(keyed,root)/`rightbar`(single,root)/`shell.overlay`（否则官方 ui-conversation 的 `slots.inject('main')` 永不解析、对话面整体不注册）；store 嵌套为 `{panelInfo:{activePanelId}, layoutInfo:{…}}` 并补齐 `selectPanel`/`retainMainPanels`；`apply` 改为 eager 单实例 + `LayoutController(actions, hasMainPanel)`（上游已删 `attachPanels`）+ `provideRoot({hooks:{panelInfo}})`；两条 chamber 增值保留——sidebarWidth 共享持久化（`trackLayoutInstance` 显式登记取代失效的 `handle.create` 猴补丁）与单一 document theme 投影；`layoutFacts` 增加 `getCollapsed()`（AppFrame 派生下沉，插件不再复制断点常量）。
  - **sidebar fork**：补齐 `sidebar.brand.mark`/`brand.name`/`panellist` 三处声明与渲染（品牌行 fallback 保留 chamber 字标；面板行按 alpha.2 的 `{id,order,label}` 元数据渲染，点击直调 `ctx.layout.selectPanel`——chamber fork 与 alpha.2 官方 ui-layout 都声明该方法，缺失即误配置，故响亮失败而非探测降级），新增 `panel-source.ts` 投影（locale thunk 读取时解析 + 变更才通知）与 5 例单测。
  - **mobile 插件**：列锚点改为 `ROLE_SLOT_KEYS`（conversation→`main`、details→`rightbar`），`layoutFacts.getCollapsed()` 取代本地推导；退役两套上游已解决/重复的机制——Session 日志胶囊按文案打标（上游改为 28×28 图标按钮 + 菜单）与自绘右栏覆盖层（上游 `<768px` 自动全屏）；层级重排为 74/75/76 以压在 dockkit 与官方全屏之上；修正 `[class$=…]` 死规则并隐藏触摸端 dockkit 分栏件。
  - **settings bridge**：子 ctx 声明台账补齐 brand/panellist 键，kit 补 `usePanelInfo` 空座。
  - **三个 fork 副本**：connection 纯文件照抄（`src/index.ts` 实测 fork-pure，宿主半 webServer 可选注入无需人工合并）+ 版本行；client-web 版本行与 dockkit 偏差注释（**不 seed**）；api-gateway 仅版本行。
  - **renderer**：`ui-dockkit` 走 covered factory（seed 会把 docking kit 拉进主图 eval，同 ui-primitives 的 C3 先例），covered/factory **54/26**（三轮起含 `client-file-upload`）；C4 typert remote 装配契约 **13→15**（+`command-feedback`、+`workspace-files`）并同步锁步测试；新增 `assertRequiredExtraRowServices` 有界探针（`required-extra-rows.ts` + `chamber-entry.ts`）——首屏 `ui-chat` 的 cordis inject 依赖 extra row 提供的 `sidebarRight`，缺失时 5s 内 `console.error` 点名 instance 与服务（**诊断而非启动门**：gateway/移动形态可合法不加载该行，探针只消除“静默消失”）。
  - **设计 24 四项修复（真机缺陷）**：① `sessionPersistence.list()` 自 0.1.3-alpha.1 起返回快照数组，旧代码当 header 用 → 真机 preview/purge 全挂（单测夹具掩盖），改为读 `snapshot.header`；② 存在性探针 `inspect(id)` 已退役 → 改用官方 `stat(id)`（跨全部 project dir/全部代际，`undefined` 即无内容，任何异常仍 fail-closed）；③ purge 只删当前代 → 改为删除目录内**全部代际**文件 + `session.lock`，并对未识别条目/符号链接/子目录整单拒绝（不再半删）；④ 删除已无消费者的 `isPersistenceNotFoundError`。design 24 §2 与 AGENTS 的边界措辞同步为 `stat(id)`。
  - **运行时线六锚**：`bundle-dsh` 兜底常量、`vendor/dsh` 锁文件（`bundle:dsh --force --refresh-lockfile`）、release.yml env、install-gateway.sh、gateway `dshAnchorVersion`、release-preflight `FORK_VERSION` → 0.1.5-alpha.2；`bin.js --version` 冒烟 = 0.1.5-alpha.2。
  - **未验证（[UNVERIFIABLE]）**：实机多来源 sleep/wake 与隐藏恢复、gateway 形态回归、右侧栏栈在真实 profile 下的装载时序、`useResource`/`usePanelInfo` 的 provideRoot 时序、session v3 迁移在真实存储上的行为。
- **dsh 源码线升级至 0.1.3-alpha.1** —— 构建期 vendor 源（submodule pin）推进到 dsh-v0.1.3-alpha.1（d347e7039）：上游相对 rc.1 是实质内容版本（328 commits、6 个新包），fork 副本随之重放——connection 采纳上游流式 body 上传路由与 fixture 的 session-format v2 / live assistant-stream 重构（chunk-rows 面移除，tsconfig 补 `dsh-llm/assistant-stream` 别名）、api-gateway 采纳 journal-stream 的无游标 notification 帧、web 仅版本行；激活探针 `commands/execute` 载荷按 0.1.3 wire 改名 `images` → `attachments`。**运行时线未动**：`@deepseek-ai/dsh@0.1.3-alpha.1` 尚未发布 npm，捆绑运行时四锚仍为 0.1.2-rc.1（双线门待 npm 发布后收口）。
- **dsh 源码线升级至 0.1.3-alpha.2 + 运行时线收口（双线同代）** —— 构建期 vendor 源（submodule pin）推进到 dsh-v0.1.3-alpha.2（82a5fd61a7，vendor 链接 267→271，新增 `client/ui-open-in-app`、`host/open-in-app`、`util/package-manifest` 三包）；fork 副本随之重放——connection 采纳上游 recovery-config 抽取（重连/就绪时序默认值迁入共享 schema：3s 慢握手告警 + 15s 硬期限中止代次、达到上限后持续重试取代「终态 disconnected」，chamber 的 loopEpoch 代际守卫与 `CONNECTION_BACKOFF_MAX_MS` 导出当时保留（**Batch 2 重锚已退役**，见下条）、`basePath` 收敛为 chamber apply 配置成员）、api-gateway 与 web 仅版本行；三副本版本标记 → 0.1.3-alpha.2。**运行时线收口**：`@deepseek-ai/dsh@0.1.3-alpha.2` 已发布 npm → bundle-dsh 兜底常量、desktop vendor 锁文件（`bundle:dsh --force --refresh-lockfile`）、release.yml env、install-gateway.sh、gateway `dshAnchorVersion` 四锚 rc.1→alpha.2，`bin.js --version` 冒烟 = 0.1.3-alpha.2（双线门关闭）。chamber-covered 增 `@deepseek-ai/dsh-client-ui-open-in-app` 一行（官方 open-in client 行随 host-graph 出现时保持 covered，官方按钮在 chamber 壳内 availability 失败自隐藏——T3 双保险）。
- **chamber 自建包命名统一（Batch 1 / T2，原子单批）** —— 命名收口为「目录 == 包名非 scope 段」：6 个 client 插件包名 `@dsh-chamber/dsh-client-ui-*` → `@dsh-chamber/dsh-chamber-client-ui-*`（目录不变）；3 个宿主种子包的目录与包名 → `dsh-chamber-seed-<loader-id>`（`@dsh-chamber/dsh-chamber-seed-client-graph` / `-git-worktree` / `-archive-cleanup`；loader id、激活探针域与发布计数不变）；`dsh-client-ui-mobile`（client-kind 例外）、三个 fork 副本（shadow 机制）与基建包不动。同批：`.gitignore` 的 committed-dist 负规则随 `git mv` 落地、全树引用（脚本 / renderer 表 / gateway 同步表 / 桌面 seed / 测试夹具 / 锁文件 importer / 文档）一次替换、两处种子登记处加 fail-loud 命名断言（`kind === 'host'` ⇒ `@dsh-chamber/dsh-chamber-seed-<loader-id>`：控制面注册表在 start 与每次 spawn 解析时校验，gateway 可同步列表在模块加载时校验）。**远端过渡例外**：旧名 `cordis.patch.yml` 行一次性 fold（同 loader id 的 `@dsh-chamber/dsh-host-*` 行原地改写为规范名，仅限种子写入器产出的精确行字节；手写 flow/inline 变体仍硬失败）——否则升级后远端 seed 会因 id-bound 冲突永久硬失败。已提交的宿主包 `dist/index.js` 产物字节不变（包名不内嵌于 bundle），锁文件重生成后 frozen 稳定且 vendor importer 记录完整。
- **fork 重锚 alpha.2 + 补丁最小化（Batch 2）** —— 三个 fork 副本以 dsh-v0.1.3-alpha.2 为锚逐文件复核，能纯的恢复逐字节、该补的收敛到最小：
  - **connection**：`src/client/connection.ts` 收敛为「上游内容 + erasableSyntaxOnly 显式字段改写 + 头部说明」（`src/browser-auth.ts` 恢复逐字节上游）——退役 loopEpoch 代际守卫与 stop()+start() 重连路径（上游原生 `reconnect()`/`setNetworkAvailable()` 已覆盖同一语义，且不存在第二个泵循环的竞态），`CONNECTION_BACKOFF_MAX_MS` 导出删除，活性触发去抖值改为 `liveness-triggers.ts` 内部的 `DEFAULT_MIN_RESTART_INTERVAL_MS`（10s == recovery schema 默认 `backoffMaxMs`）并加离线门（离线时上游已挂起重试，触发忽略）；`basePath` 收敛为 `apply(ctx)` 读 `ctx.chamberBasePath`（与 api-gateway 对称，chamber-entry 不再传插件 config），`createWebConnectionRpc` 去掉兼容重载只留 chamber 选项对象；新增 `client-apply` 行为门（ctx→载波/handle）并扩展测试桩 loader（fixture / recovery-config）。
  - **client-web**：`src/base.css` 恢复逐字节上游，五份 ui-theme token 表改由 renderer 入口 CSS（`packages/renderer/src/styles.css`）引入——head CSS 顺序不变，token 仍在插件 CSS 之前；seed/platform/index 的 rebase 散文收敛为「不变量 + 指路」，5 个不可替代 seam（模块表宿主 / extraRows / configureContext / boot 容忍 / 异步 dispose）不动。
  - **api-gateway**：`apply(ctx)` 直接读 `ctx.chamberBasePath`（去掉 `ClientRemoteOptions` 参数），流载波补丁不变。
  - 上游触点登记同步（pure：connection 15→16、client-web 4→5、api-gateway 6；C1 逐字节门覆盖新纯文件），design 05/14/20 措辞随之修订。
- **open-in 统一 · Phase 0 纯门控（Batch 3）** —— 新增 per-source 视图模型 `packages/dsh-chamber-client-ui-open-in/src/shared/open-in-view-model.ts`：把「官方宿主目录（official）」与「桌面主进程提供方（main）」两个池按来源矩阵（local = 两池全量；`dsh-*`/`gateway-*` + ssh = 仅 main 的 remote-capable；http/畸形来源 = 空）折成单一决策面，每个被拒候选都带显式抑制原因（`unknown-source`/`transport-not-ssh`/`source-not-local`/`app-unavailable`/`app-not-remote-capable`/`duplicate-app-id`），并给出 channel 优先级的去重与默认选中项；既有 `usableOpenInApps`/`usableAppsForSource` 改为该视图模型的薄适配层（行为不变，单一决策面）。单测钉矩阵/去重/抑制原因（8 例）。Phase 2 见下条。
- **连接恢复加固（2026-09，Batch 2 后续）** —— 针对「上游连接管理只按本地/单实例设计，chamber 需面对隧道/慢链路/唤醒」的专项调研结论：
  - **每来源就绪期限**（新增 `dsh-client-connection/src/client/recovery-policy.ts`）：chamber 页面拿不到宿主注入的 `__DSH_CONNECTION_RECOVERY__` 页面全局，一直吃 15s 硬期限；现由 api-gateway fork 经上游支持的 `connection.start(sinks, config)` 为 ssh/http 来源传 45s 期限 / 5s 告警，本地与未知来源保持上游默认——冷 SSH 隧道或慢链路不再因握手超期被反复取消。
  - **唤醒事件旁路离线门**：页面跨挂起/恢复被冻结时可能整体错过 `online` 事件并持续误报 offline，而离线门会连 `system-resume` 一起挡掉。现 `system-resume` 旁路门（`reconnect()` 的 `immediateRetry` 跳过挂起分支，只强制一次有界尝试，真离线则快速失败重挂），`online`/可见性仍受门约束，三者共享 10s 去抖。
  - **职责边界登记**：连接层是 push 通道（`/api/remote.mux`）唯一重开者（各 chamber 层只发现/撤销/重注册传输；mux 客户端自身无退避）；禁止同实例 `stop()+start()`（如重新引入须恢复代际守卫）。
  - **上游动向（只读调研，未升级）**：最新 tag `dsh-v0.1.5-alpha.1`，但三个 fork 的客户端恢复模型**零改动**（仅 fixture/宿主半 `webServer` 可选注入重构/平台词新增 `dsh-client-ui-dockkit`）——故本次加固无上游等价物可采纳，全部走上游稳定接缝；升级注意项已记入触点表 §2.4。
- **open-in 统一 · Phase 2（Batch 3 核心，红线修订）** —— 单一 header 入口改为消费 per-source 视图模型（Phase 0 已落地），本地来源吸收官方 client：
  - **本地来源（official 通道）**：实例自身官方宿主目录（`dsh-host-open-in-app`，随 a2 默认 web bundle 在）经每实例代理 `<basePath>/open-in-app/{apps,icon/<id>,open}` 提供全量本地应用拾取器——catalog 协议（`shared/open-in-app-protocol.ts`，与 vendor `shared.ts` 逐字锁步测试）、真实 bundle 图标（404 回退中性方框）、官方 `app.*` 标签表与按钮文案（并入单一 chamber locale NS）、选择持久化（官方 key `dsh.open-in-app.choice`，storage 不可用降级内存）、busy/error 呈现（250ms 延迟 busy、2s 错误衰减）全部吸收；桌面主进程的 VS Code 覆盖项按 §5.1「vscode 全家走 IPC 覆盖」+ r6「展示并集 + IPC 兜底」裁决：主进程该项可用时胜出（vscode 走 IPC，保留 `vscodeOpenInNewWindow`、来源代 proof 与深链 intent 推送），不可用时官方条目兜底（走实例路由）。
  - **远程 ssh 来源**：仅主进程 remote-capable 项（VS Code Remote-SSH，主进程构造 `vscode://vscode-remote` URL）；**http/未知来源**：无入口。
  - **桌面主进程瘦身（红线）**：`OpenInApp` 注册表 vscode-only；`OpenInLaunchContext` 移除 `stat`/`openPath`/`showItemInFolder`，finder provider 与 `classifyLocalPath`/`invokeOpenPath`/`normalizeOpenPathError`/`shouldRevealDirectoryInsteadOfOpen` 一并退役。本地 launch 的信任界由 trusted IPC 迁至实例官方路由（实例连接栅栏 + 官方 resolver 白名单/存在性校验），控制面仍零执行面（逐字透传 + browser-auth cookie 注入）；VS Code 深链语义、来源代 proof 与 OS 深链 `dsh-chamber://open-vscode` 入口不变。
  - 红线修订登记：design 16/20/05 + AGENTS 同步（最终设计验收由用户完成）。
  - **未实机验证（[UNVERIFIABLE]）**：官方 host 行随 a2 默认 profile 进入托管实例、远程无 cookie 下 fence 行为、remote cwd 填充、图标缓存/CSP。
- **升级工具 + 连接恢复收尾（W1/W2/W3，2026-09；源码线/运行时线 pin 仍 0.1.3-alpha.2）** —— 与 0.1.5 升级**版本无关**的三件收尾，全部在当前 pin 上验证：
  - **升级前 pin 预检（新增 `scripts/dev/preflight-vendor-pin.mjs`，只读）**：对目标 tag 与当前 pin 做 diff，一次给出「三个 fork 副本按 pure/需人工重放/dropped 分类 + chamber 深引的 vendor seam 文件 + 上游包集合增删 + 新增 client 行 + 运行时是否已发布 npm」，支持 `--offline`/`--json`/`--fail-on-replay`（advisory 工具，不改工作树、不动 submodule HEAD）。对 `dsh-v0.1.5-alpha.1` 实测：变更 2552 文件 → pure 5 / 重放 6 / dropped 6、**seam 16（全部落在 `packages/client/ui-layout/*`）**、包 +15 / −4（landlock）、新增 client 行 5。这把 0.1.5 踩过的坑（先升 pin 才发现三栏模型重写 → `typecheck:layout` 立刻红）提前成「动 pin 前先看清单」的流程第 0 步。
  - **锁文件 vendor 记录修复脚本加移除守卫（修复）**：`restore-lockfile-vendor-records.mjs` 原先无条件从 HEAD 复活被 pnpm 剪掉的 importer 记录；上游在 0.1.5 移除 workspace 成员（landlock 4 条）后，脚本会把已不存在的成员补回，frozen 安装随即以「锁文件有、链接缺」失败。现按 `vendor/harness-packages/@deepseek-ai/<name>` 链接存在性（含断链）跳过并打印清单。新增根脚本 `pnpm run test:upgrade-tools`（两个脚本测试）+ CI 步骤。
  - **聚合刷新陈旧阈值按传输分级（H3）**：sidebar 聚合的 S2 重连 watchdog 原为单一 120s 且**只覆盖 direct-http 来源**；现按来源传输取阈值——http 保留 120s（浏览器腿有控制面 30s WS ping，上游腿无应用心跳、仅约 10min OS TCP keepalive，需较紧的自愈），**ssh 新增 300s 兜底**（隧道已有三层独立探测器：代理 30s/1 miss WS ping、宿主 mux 2s/2 misses、SSH keepalive 30×3≈90s，该臂只补「应用级冻结」这一层，阈值必须显著长于 http 以免空闲健康隧道每两分钟付一次基线重放），本地/未知来源不武装（`AGGREGATE_RECONNECT_HTTP_STALE_MS`/`AGGREGATE_RECONNECT_SSH_STALE_MS` + `reconnectStalenessMsForTransport`）；unary 30s 拉取节奏不变，watchdog 始终是「拉取的补充」。新增单测 2 例（http/ssh 阈值与 local/未知跳过）。

### 修复

- **归档清理后已删会话在侧边栏反复浮现（design 24 §21）**：purge 删除已归档
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
  设计与进度见 design 24 §20/§21 与 `docs/progress/STATUS.md`。
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
- **plugin sync/install QA 收口（design 21 §10 ⑱–㉒）** —— 同步 400 原因
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

- **N-ctx 视图保留/回收 + 可见性门控（design 05 §1 注记/performance-baseline
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

- **归档管理器按工作区分组、可折叠（design 24 §18/§19）** —— 移除独立
  「删除全部」：整集清理必须先显式全选再确认带计数的「删除选中」，purge
  永远携带明确 id 列表（降级/pending 视图无任何销毁动作）；列表按工作区
  分组（权威成员关系 → canonical cwd 兜底 → 未分组桶），组头复用导航折叠
  chrome + workspace accent + 三态组复选框，折叠为对话框本地视图态。
- **归档管理器整体匹配轮（design 24 §19-6..9，dsh/仓库惯例对齐）** ——
  危险确认改**对话框内两段式**（武装冻结列表输入 + 风险条：计数不可恢复
  文案/取消/确认删除；Esc 只解除武装绝不关框——capture 相位仲裁官方 Modal
  的 bubble Escape；取消/Esc 焦点回武装源控件）替代 OS window.confirm 与
  嵌套 Modal 方案（官方 Modal 无层级，叠层一次 Esc 双关）；session 行
  session/workspace 树形嵌套容器化（`.archiveManagerGroupRows`，标题列与组
  标题精确同列）；行删除钮并入模块 `.actionIcon` 语言（20px 纯色 hover +
  error ink 修饰）、hover/焦点环/小字号族共享规则表收口；四方只读分面评审
  （正确性/完整性/最优性/a11y）修复落地（焦点 rAF 回退、aria-checked=mixed
  全选行、role=alert 文本化等），偏差与待目检项登记 §19-9。

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
- **侧边栏 Git 仓库组折叠与行尾 rest 态清理（design 08 §11.7，2026-09
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
