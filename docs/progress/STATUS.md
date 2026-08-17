# 模块完成状态总览（STATUS）

> 本文档只追踪**进度状态**：未完成项与范围契约。已实现基线以 git 历史与
> `docs/design/`（设计契约与样式定稿）为准，工程细节在代码注释——不记录
> 历史日志/每日验证记录。本文档是 dsh-chamber 进度追踪的唯一记录。

## 未完成 / 待执行

- **SSH 密码认证（05 §8 例外，2026-08 落地）**：表单密码字段 +
  `desktop_ssh_set_password` → `SSH_ASKPASS_REQUIRE=force` + 临时
  0600 askpass 助手注入系统 ssh（隧道与 systemd exec 均覆盖；助手按提示文本
  区分主机密钥确认/密码）。**持久化 = 明文文件兜底（用户决策）**：密码镜像到
  `<userData>/ssh-passwords.json`（0600、原子写、启动加载——密码主机重启后
  自动连接可用；损坏保留 `*.corrupt` 响亮报告；不进注册表/日志/renderer）。
  askpass 注入已随隧道链路端到端实机验证（见下「已实机验证」）；
  **仍待实机**：错误密码终态、重启后自动连接；**Windows 门禁**
  （`sshPasswordSupported()` 为 false 时 IPC 显式拒绝，密钥/agent 兜底）需
  实机确认 Win32-OpenSSH 行为（Windows 首版整体暂缓，见下）。已单测覆盖：
  助手脚本转义/主机密钥 yes/0600 权限/清理、buildStartEnv 环境合并与
  disposeAuth、env 异常落地 error、密码文件持久化往返/0600/损坏保留。
  未做（后续可选）：一键免密引导、系统钥匙串。
- **侧边栏 pending 交互徽标（06 §4.3 修订，方案 A）实机验证**：本地实例
  触发 `ask_user_question` → 侧边栏该会话行出现问号徽标（区别于运行环），
  回答后消失；远端来源会话 pending 时本地侧边栏同步呈现。静态检查（sidebar
  typecheck / build:renderer / verify:i18n）已绿，运行时呈现待实机。
- **设置壳交互与 GUI 内手动操作待实机**（背景：esbuild bundle + 真实本地
  host 的运行时验证已覆盖子 ctx 装配的 ledger 事实——general 5 行（含
  bridge-rows 的 composer-enter / permission）、plugins 3 卡、onboarding 2 项、
  dispose 清理、官方控制器可驱动（ModelsSettingsStore/AgentPreset 控制器
  ready））；壳交互（下拉 roving、nav 投影、连接导航、懒装配时序）与 GUI 内
  手动操作待实机（onboarding 2 项是子 ctx 装配事实，壳不渲染 onboarding；
  bridge-rows 两行的读写落盘待实机——单测覆盖控制器状态机，schema 解码为
  数据驱动，实机验证 describe/mutate wire）。
- **Windows 首版支持暂缓**（detached/进程组/lsof 降级路径）——暂无 Windows
  设备，维持「未验证」状态；Unix 为契约目标。
- **模型额外参数 + 默认推理等级**（设计 07）：需求定稿、链路查清、实现
  蓝本已写入 `docs/design/07-models-params.md`；**实现推迟**——wire 白名单
  无泛化透传、host 组合不可注入、`agent-default-model` 未对客户端暴露，
  均待上游解锁（解锁条件与 harness.commit 升级复查清单见 07 §3/§4）。
- **Git Worktree 插件**（设计 08）：范围决策已定稿（2026-08-16，01 §4 的
  git/GitHub 由移出项改写为插件化——不进控制面/本体，允许 chamber 强制打包
  的客户端插件形态），设计稿已写入 `docs/todo/08-todo-git-worktree-plugin.md`
  （2026-08-16 自 docs/design/ 移入 docs/todo/）；
  **实现未排期**（M1–M5 分期见 08 §8）。
- **dsh 客户端插件运行时加载（设计 09）**：设计草案已写入
  `docs/todo/09-todo-client-plugin-runtime-loading.md`（每实例合并宿主 boot
  图：图通道方案 A/B、union+id 去重、信任边界、分期）；**实现未排期**。
  现状（2026-08 核实）：客户端插件（`dsh.client` 行）无法运行时加载——chamber
  前端 `__DSH_BOOT__` 清单构建期写死单 entry（`gen-boot-manifest.mjs`），官方
  机制（`dsh-client-modules` 组合图 + `/plugins/<id>/client.js` + 反代透传）完整
  保留但无人消费；功能型（宿主侧）插件可经 profile `cordis.patch.yml` 正常安装。
- **侧边栏聚合改事件驱动（设计 10，2026-08 记录）**：10s REST 聚合轮询改为各
  来源 ctx 经 chamberBridge 推送投影（轮询降级为未挂载来源兜底）；动机/机制/
  契约影响（05 §3）/风险/分期见 `docs/todo/10-todo-event-driven-aggregation.md`；
  **实现未排期**——改动 05 §3 契约，需评审确认。
- **桌面端自动更新 + 通道灰度（设计 11，2026-08 记录）**：dsh-chamber 自身
  升级能力（升级目标不是远端 dsh）——方案讨论收敛：feed = GitHub Releases；
  灰度 = 通道模型 beta → stable；macOS 降级为「检测 + 提示手动下载」（不投入
  Developer ID 签名，自动安装硬阻塞）；UX = 提示后下载 → 退出时安装。设计稿已
  写入 `docs/todo/11-todo-auto-update.md`；**实现未排期**（M1–M3 分期见 11 §9）。
- **设计未决**（见 02 §5 / 04 §7）：starting port 偏移、trusted-host
  自定义 Host、restart-exhausted 手动恢复入口、多控制面 `$DSH_HOME` 冲突、
  响应头白名单双处同步、`__DSH_BOOT__` 随 dsh 版本漂移。
- **外部编辑风险**：`packages/desktop/`（transport-manager / ssh-provider /
  ssh-config / main.ts）存在未提交的进行中改动，其间的 typecheck/测试
  结果可能波动（已多次观测 0↔2↔25 错误波动；最近一次 typecheck 0 错误）。

## 已实机验证（2026-08 确认）

- **真实远端实例 SSH 隧道链路端到端验证已完成**：exec 通道、就绪身份握手
  （host.describe 探测）、askpass 注入等已在真实远端实例上实测通过。
- **打包应用实启 GUI 复验已完成**：v1 收敛（认证/审计移除）后的新构建已
  实机启动验证。
- **偶发主进程冻结未再复现，关闭**：曾 4 次（实例未启动且前端重试期），
  其后约 20 次实启未再出现，根因未最终定位——不再留待排查。

## 代码收敛（2026-08-16，评审驱动修复）

以下为 2026-08 仓库评审发现问题的修复（均已含测试或构建验证）：

- **Windows 安装卡死修复（2026-08，用户报告「安装一直卡在安装界面 + 进度条来回反复 + 任务管理器持续写盘」）**：根因（三层，均为实测/源码级验证）——① `extraResources` 的 `vendor/dsh` 用 pnpm isolated 布局，打包时**符号链接被展开成实体副本**，NSIS 安装器要逐文件解压 **92,070 个条目 / ~1.1GB**（远非表面 1.4 万文件），Windows Defender 实时扫描每新建文件放大耗时；② electron-builder NSIS 的 7z 路径是「解压到临时目录 → CopyFiles 到目标 → 失败自动重试 5 次 → 弹窗后**整体重解压**」（`app-builder-lib@26.15.3 templates/nsis/include/extractAppPackage.nsh`）——文件被锁（Defender 持有句柄/旧版残留/应用运行中）即进入重试/重解压循环，进度条走满→清零→重走、磁盘持续写入、永远装不完；③ 覆盖安装时 `installUtil.nsh` 的旧卸载器重试循环同理。修复：① `packages/desktop/package.json` `build.nsis.useZip: true`——应用包改 zip，模板走 `nsisunz::Unzip` **单趟直解到目标目录**（`extractUsing7za` 整条路径消失，磁盘写入约减半）；② `bundle-dsh.mjs` 的 pnpm 安装加 `--config.node-linker=hoisted`——扁平布局无符号链接展开复制，随包条目 92,070 → ~32,700（实测）；③ 裁剪逻辑抽为 `packages/desktop/scripts/prune-runtime.mjs`（可对任意目录直接验证）并扩展（测试/示例/CI/文档/许可/dotfiles 等），hoisted + 裁剪后 vendor = **11,707 文件 / ~132MB**（展开体积约为原 1/8）；④ README 增 Windows 安装排障（Defender 排除项、关闭旧版/清理残留安装）。**验证状态**：`node --check` 通过；裁剪规则 dry-run 与真实裁剪数值吻合；isolated 裁剪树与 hoisted 裁剪树（含裁剪后）均对真实 dsh web profile 跑过控制面冒烟 **SMOKE PASS**；macOS 交叉构建 Windows 安装器实测通过——安装器内嵌 `app-64.zip` + `nsisunz.dll`（7za 列出，无 Nsis7z/7z-out），`useZip` 生效；**Windows 实机安装验证仍待做**（无 Windows 设备，与「Windows 首版支持暂缓」状态一致）——CI `build-windows` 会跑 `dist:desktop:win` 但只验产物存在，不实启安装。注意：`pnpm add` 直装当前会因 registry 元数据漂移（`@deepseek-ai/dsh-skill@^0.1.0-rc.7` 已不可解析）失败，需用 vendor 内 lockfile 或等上游修正——与本修复无关的既有问题。**风险记录**：`nsis.useZip` 是 electron-builder 标注“仅供差分更新包内部使用”的选项（非公开 API，26.15.3 schema 接受、实测生效）——升级 electron-builder 时若被移除/改名，失败为**响亮的构建期配置校验错误**（非静默），升级后需回归 `dist:desktop:win`；届时可改用「hoisted 布局 + 7z」组合（循环仍在但文件数已降 8 倍，或接受差分模式）。

- **桌面窗口生命周期与崩溃恢复（2026-08-17，用户报告「前端消失后点 Dock
  图标回不来」）**：`packages/desktop/main.ts` 三处补齐——① macOS
  `app.on('activate')`（Dock 图标点击）+ `second-instance`/托盘「显示窗口」
  统一走 `showMainWindow()`：窗口被关闭后（darwin 的 `window-all-closed`
  不退出应用）按控制面 origin **重建窗口**（`createMainWindow` 启动/重建
  共用），不再出现无窗常驻、点任何入口都无反应；② 渲染进程有界自动恢复
  （`installRendererRecovery`）：`render-process-gone`（clean-exit 除外）
  或 15s 无响应 → 60s 窗口内至多重载 3 次，超出大声失败（错误框一次），
  绝不静默白屏；③ 诊断留痕：`crashReporter` 本地落盘
  （`uploadToServer:false` → `<userData>/Crashpad`）+ GPU/Utility
  `child-process-gone` 日志。排查依据：2026-08-14 22:40 打包版**主进程**
  SIGTRAP 崩溃（`DiagnosticReports/Retired/dsh-chamber-2026-08-14-224045.ips`，
  V8 CHECK in CrBrowserMain）与 2026-08-16 23:17 dev 实例启动即崩溃
  （Electron Helper .ips ×5）——崩溃全部静默、无恢复路径。验证：
  `typecheck` 0 错误、`test:desktop` 90 用例全绿；**未实启验证**（用户运行
  中的实例不便打扰，实启回归待下次发布前复验）。

- **侧边栏每来源搜索状态共享化修复（06 §1.2 修订，2026-08）**：搜索状态
  （胶囊/查询/结果）与防抖 job 此前是 per-shell 组件状态——可见侧边栏随
  活动视图换 shell，A 里发起的对 B 的搜索在激活 B 后消失；且若简单共享
  状态会让 N 个 shell 各自对同一查询重复发起 job。修复：`shared/
  search-state.ts` 共享控制器（单一所有者：状态 + job/timer/AbortController
  全部进模块单例），组件只镜像渲染与持有 DOM ref；P2-6 语义原样保留
  （单来源击键不打扰其他来源在途搜索、30s 超时与「被替换」区分），断连
  来源状态裁剪不变。单测覆盖 expand/collapse/clear/setQuery 转换、
  通知幂等与断连裁剪；typecheck:sidebar / test:sidebar / build:renderer
  已绿。

- **侧边栏折叠/未分组序跨 ctx 实时联动修复（06 §3 修订，2026-08）**：
  视图偏好此前是每 ctx 一份内存副本（mount 读一次 + 变化时合并写回），
  在实例 A 展开的 workspace 切到实例 B 后仍显示折叠（06 §5 曾接受
  「刷新生效」）；且 B 任意一次写回会把 A 刚展开的键用陈旧值**复活**。
  修复：`shared/view-prefs.ts` 新增共享实时存储（`getViewPrefs`/
  `subscribeViewPrefs`/`updateViewPrefs`——模块级单例缓存，vite shared
  chunk 下所有 ctx 的侧边栏共享同一实例；写透 localStorage + 通知全部
  订阅者），任一来源的折叠/未分组序变更实时反映到所有来源。裁剪规则
  收紧为**安全裁剪**：空投影不裁剪（未就绪投影绝不抹用户偏好）、只裁
  「来源已从投影消失」的键（断连来源的偏好保留、重连恢复）——顺带消除
  原「mount 时按未就绪投影全量裁剪」与「断连来源折叠被裁」两个潜伏
  隐患。单测覆盖存储单例/通知/裁剪规则；typecheck:sidebar /
  test:sidebar / build:renderer 已绿。

- **侧边栏远程完成未读蓝点缺失修复（06 §4 修订，2026-08）**：`completed`
  蓝点此前只由各来源已挂载 ctx 的 vendor 提醒产生——后台来源 shell 的
  `selected` 保持「最后打开」会话不随活动视图切换更新，该会话后续完成被
  误判为「正在阅读」而永久压制蓝点（远程来源最常见）；且渲染时聚合
  `running`（10s 轮询）可瞬时/长时间滞后，让运行环压制蓝点。修复：
  （1）**蓝点状态机上移到 App 层**——上报端（sidebar 插件）退化为无状态
  投影（`current` + 每会话实时 `running` 位 + vendor 已武装
  `completed`/`pending`）；App 自持 `completedBySource` + `prevRunning`，
  从上报里的实时 running 位推导 running→idle 边沿武装蓝点，「正在阅读」
  取 App 侧事实（活动视图的 current 会话），解除规则与 vendor 同构
  （重跑/移除/阅读）；不再依赖各来源 shell 的 selected，也不碰任何来源
  的 selection（无竞态、会话保活不受影响）。对账为纯函数
  `reconcileCompletedFacts`（shared/derive.ts），App 在函数式 updater 内
  调用并各自捕获 prevRunning 快照——同来源两次上报落同一渲染周期时按序
  组合不丢蓝点（复查修复）；（2）`sessionStateDot`/`sessionStateLabel`
  改为 pending 徽标 > completed 点 > running 环（实时通道为真，聚合 stale
  不再压制）。单测覆盖 `projectRuntimeFacts` 全量 running 投影与
  `reconcileCompletedFacts` 武装/解除/阅读/移除/组合规则；typecheck:sidebar
  / test:sidebar / build:renderer 已绿。残留（记录于 06 §5）：完成发生在
  来源 shell 首次观察之前（预热窗口）仍无蓝点；App 侧蓝点跨断连保留
  （断连期间完成的会话重连后仍武装）。

- **侧边栏后台子 agent 运行中蓝点误亮修复（06 §4.5 新增，2026-08）**：
  父会话的 running 位只反映「agent 回合进行中」——subagent 工具后台模式
  （run_in_background: true / continuable 默认）下工具立即返回、父回合先
  结束（running=false），子 agent 继续在后台工作；官方 sessionStatuses
  把「有运行中子 agent」（runningSubagentCount > 0）排在 node.completed
  之前，而我们的状态链此前没有 subagent 信号——后台模式下完成蓝点在子
  agent 仍在干活时提前亮起。修复：（1）插件在 vendor 边界复用纯函数
  `indexSubagentDescendants(snapshot.byId)`，把每父会话的 runningCount
  （>0 稀疏）经 `projectRuntimeFacts` 参数注入并入事实通道
  （`InstanceRuntimeReport.sessions[].runningSubagents`，官方 tree.ts 的
  `runningSubagentCount` 同一算法同一输入，语义不可能漂移；shared 层保持
  纯、import 图不引入未构建 vendor 包）；（2）渲染优先级改为 pending
  徽标 > runningSubagents 运行环 > completed 点 > running 环——子 agent
  存活期间绝无完成蓝点，全部结束后蓝点正常浮现（App 的
  completedBySource 状态机无需改动：蓝点在子 agent 运行期间保持武装但被
  渲染压制，与官方「completed 保持武装、subagents 分支优先呈现」同构）；
  tooltip/aria 新增 `status.subagentsRunning.one/other`（官方 copy）。
  单测覆盖 `projectRuntimeFacts` 的 runningSubagents 稀疏投影（无图/零值
  省略、与 completed/pending 共存）；typecheck / typecheck:sidebar /
  test:sidebar / build:renderer / verify:i18n 已绿。残留（记录于 06 §4.5）：
  one-shot 前台等待窗口单点只显示子 agent 计数文案（官方为「运行中」主
  标签 + 计数次标签），圆环同形，仅 tooltip 单值取舍。

- **view-prefs 安全裁剪启动窗口误删修复（2026-08 复查，双 subagent 审计
  驱动）**：`seenSources` 此前持久化到 localStorage——重启后首个写周期
  （roster 未到、投影仅 local）会把上一会话见过、当前尚未加载的远程来源
  误判为「已删除」而**永久抹掉**其折叠/未分组序偏好（正是安全裁剪要防的
  场景）。修复：seenSources 改为**会话内内存簿记**，载入时一律归零（写入
  路径仍经 sanitize 携带内存值）；上一会话删除、本会话未写过的来源残留
  ghost 键（渲染侧跳过未知 id，接受）。同轮修复：`updateViewPrefs` 缓存
  改存 sanitize 输出（mutator 不得把活缓存对象别名进 store）；侧边栏
  `tsconfig` 纳入 test（修复被类型检查暴露的两处测试缺 `seenSources` 与
  断言签名收窄问题）；`client/index.ts` 结构签名过滤 subagent 起源行
  （子 agent 生灭不再触发无节流聚合重拉）；`mergeRuntimeFacts` 抽为纯函数
  （App deriveServers 合并逻辑获得单测）；search-state 测试改期限轮询
  （消除 350ms 定长 sleep 的抖动余量）并新增失败→error / 被替换→静默 /
  断连中止在途 job 覆盖；view-prefs 测试补 `__resetViewPrefsForTests`
  隔离（安全裁剪测试可独立运行）与 ungroupedOrder/seenSources 断言；
  ambient 修正 `SessionRow.updatedAt` 可选并补齐真实导出；为 seenSources
  会话内簿记与 defaults 新鲜对象补守卫测试（删除修复即测试失败）。单测
  （43+16+7）与 typecheck（含 test）/ typecheck:sidebar / build:renderer /
  verify:i18n 全绿。

- **浏览器来源边界**：管理 API/实例 HTTP 在路由前校验 loopback Host 与
  Origin，WS 在 upgrade 转发前复用同一判定（403 `origin_forbidden`）；
  不再把“无 CORS 响应头”误当成 simple POST/WS 防线，并拒绝同源 DNS
  rebinding Host。回归测试覆盖恶意 `text/plain` POST 无副作用、恶意 WS 在
  代理前拒绝与非 loopback Host。
- **Electron IPC sender/导航边界**：全部 `dsh-chamber:info` / `desktop_ssh_*`
  handler 校验当前主窗口 mainFrame + 精确控制面 origin；窗口禁止 popup，
  `will-navigate` / `will-redirect` 禁止跨 origin。纯信任谓词含单测；
  preload 引导期 `dsh-chamber:info` 短重试（≤10×50ms）消化 mainFrame URL
  提交前的时序拒绝，不弱化门禁。
- **catalog 持久化失败传播**：JSON store 改为同步 write-through，写盘失败
  回滚内存并抛 `json_store_persist_failed`（接口注释明确同步 throw 语义）；
  catalog 行读取返回 clone、更新走不可变事务，消除“内存成功/磁盘失败”假
  成功。单测覆盖 store 与同步 catalog 调用的失败回滚。
- **排队会话打开结果闭环**：shell 未 boot 时的 open 保存原 Promise，只有
  runtime dispatch 成功才 resolve；dispatch/boot/dispose/68s 超时均 reject
  （dispatch 同步 throw 也显式 reject，绝不悬挂），不再提前成功后仅
  console 报错。纯队列单测覆盖成功、失败、同步 throw、释放与超时。
- **桌面应用图标**：`packages/desktop/resources/`（icns/ico/icons）接入
  mac/win/linux 打包图标；`resources/icon.png` 经 extraResources 映射进
  `process.resourcesPath/icon.png`，打包态托盘图标落位（原先仅兜底跳过）。

- **反代上游超时（设计 03 §3.3 的 504 落地）**：`instance-proxy.ts` 增加
  `UPSTREAM_TIMEOUT_MS`（10s，可注入）——上游静默（响应头等不到 / 非 SSE
  body 停顿）→ 显式 504 `upstream_timeout` + abort，不再无限挂住请求；
  SSE / WebSocket 升级后的长连接不受限。新增 3 测试（HTTP / 正常流不受扰 /
  upgrade）。
- **host-logs 环形截断（设计 02 §3.8 落地）**：写入侧 `MAX_LOG_LINES`（500）
  超限即压实保留尾部 `COMPACT_KEEP_LINES`（400）并重开写流——长期宿主不再
  积累无界日志文件。新增 1 测试。
- **致命屏时效修复（renderer）**：`App.tsx` 健康错误**持续**超过 10s（或
  首帧从未拉到）才呈现"无法连接控制面"覆盖层——会话中途控制面失联不再被
  陈旧 health 永久掩盖，瞬时抖动/SSE 重连不闪烁。
- **侧边栏搜索超时竞态修复**：30s 调用方超时 abort 后按 job 是否仍持有
  controller 区分「超时」与「被替换/取消」——超时落 `search.unavailable`
  错误态，不再永久停留在转圈（06 §1 fail-loud 语义）。
- **workspace 组头拖拽尾随点击修复**：组头 `dragstart` 同样武装
  `suppressClickRef`（06 §2.2 守卫清单完整化）。
- **侧边栏悬停光标闪烁修复（session/workspace/source 行高固定 + 组内指针一致）**：
  会话行操作（kebab+归档）、workspace 组头操作、来源头操作都是「悬停真替换」——
  行/头为内容自适应高度时，悬停换入 20px 图标使行高 24→26px（来源头 26→28px）
  发生布局位移；在打包 Electron 43 下引擎对移动中指针的 :hover 命中会落后于
  光标下的实际元素 1–3px（实测复现：行顶出现「指针已入行但 :hover 未激活」的
  滞后带，操作图标延迟弹出、行边界随相邻行悬停而漂移，光标在行边界不停
  pointer↔default 切换）。修复分两层：① `.sessionRow`/`.workspaceHeader`
  固定 26px、`.sourceHeader` 固定 28px（border-box，与官方 ui-workspace 固定
  行高同模式），悬停换入换出不再改变布局；② `.workspaceGroup` 加
  `cursor: pointer`（行间 2px margin 命中该容器，否则扫描列表时每行边界都会
  闪回箭头指针；`.workspaceHeader` 非可点击，显式 `cursor: auto` 保留原样）。
  复现页在 Electron 43 下实测：滞后带 2–3px → 0–1px（仅剩行顶边界像素，
  位于图标区之上）、行高恒定、图标列扫描会话行区域（含行间隙）全程
  pointer（仅来源头非操作区/列表底缘为 auto）、图标中心悬停抖动 0 次
  切换。纯 CSS 改动，无逻辑/契约变化；恢复态仅行/头在静止时高 2px。
- **boot 队列超时护栏（renderer）**：`shell.ts` 单个 boot 超过 `BOOT_TIMEOUT_MS`
  （60s）不再阻塞后续实例的 boot（链放行，迟到 settle 仍正常注册视图、会话
  保活）；旋钮清理改为按值守卫（迟到 settle 不误删后续 boot 的旋钮）。
- **quit 等待 SIGKILL 升级（desktop）**：`transport-manager.disposeAsync()` 在
  dispose 后等待全部 kill escalation 清空（至多 grace+1s）；`main.ts`
  will-quit 改为先 await——SIGTERM 忽略的 ssh 子进程不再因 2s 宽限内退出而
  遗留。
- **设置页 roster 新鲜度修复**：`ConnectionsSection` 订阅
  `onInstancesChanged` 即时重拉 roster（本页外注册表增删改即刻可见）。
- **release.yml runner 修复（参考 OpenChamber 踩坑）**：非公开标签
  `macos-26`/`macos-15-intel` → 公开 `macos-14`（arm64）/`macos-13`（x64）；
  node `'22'` → `lts/*`（与 ci.yml 一致）。
- **macOS 打包签名修复（ad-hoc，2026-08-16）**：无 Apple 签名身份时
  electron-builder 完全跳过签名（含 afterSign 钩子），产物继承官方 Electron
  二进制的 linker ad-hoc 签名（`codesign --verify` 报 "code has no resources
  but signature indicates they must be present"），下载隔离后 macOS 报
  "已损坏"且任何 Gatekeeper 设置（允许所有来源）无法绕过——校验发生在签名
  验证层，独立于 spctl。修复：新增 afterPack 钩子
  （`packages/desktop/scripts/after-pack-adhoc-sign.mjs`，注册于 desktop
  package.json `build.afterPack`）在 DMG 构建前对 .app 整体
  `codesign --force --deep --sign -` 并 verify（DMG 内即签名产物；未来配置
  真实身份时 electron-builder 签名步骤在其后执行并覆盖 ad-hoc 签名，安全）；
  ci.yml / release.yml 的 macOS 验证步骤新增 `codesign --verify --deep
  --strict` 防回归。已本地端到端验证：钩子产物
  `Identifier=com.dshchamber.desktop`、`_CodeSignature/CodeResources` 存在、
  verify 通过。治本仍为 Developer ID + 公证（secrets 未配置）。
- **macOS v1 仅 arm64（2026-08-16）**：GitHub 退役最后一个公开 Intel
  runner `macos-13` 后，release.yml 的 x64 矩阵腿在 v0.1.0 全部 5 次运行中
  均排队等不到 runner（finalize 因 needs 不满足从未触发，release 为手动
  发布；资产只有 arm64 DMG + Windows exe）。决策：**v1 放弃 macOS x64**，
  release.yml 移除矩阵改为单一 `macos-14` arm64 构建（ci.yml 本就只出
  arm64），Intel Mac 暂不支持（README 中英已注明）。恢复 x64 的路径（未
  排期）：自托管 Intel runner；或 arm64 runner 上 Rosetta 交叉构建
  （bundle:dsh 的 darwin-x64 原生模块需在 Rosetta 下编译，可行性未验证）。

### 2026-08 性能排查（INP 232ms / 长时间运行卡顿）

排查结论：① 会话列表**不虚拟化**（vendor ChatView 渲染全部节点，长会话
DOM/内存无界增长）；② N-ctx 常驻 + **shell 销毁不停止 cordis ctx**（chamber
泄漏本体）；③ 10s 聚合轮询无条件 publish → 每 shell 侧边栏全量重渲染（放大
因素）。其中②③为 chamber 可改，已落地如下（②③含测试/构建验证；会话行 CSS 为纯样式注入）：

- **shell 销毁时拆除 cordis ctx（修泄漏本体）**：`AppWebEntry.dispose()`
  （`packages/dsh-client-web/src/boot.tsx`）在 `root.unmount()` 之后停止该 ctx
  的全部 loader entry 纤维（`entry.fiber.dispose()`，级联运行所有插件 effect
  teardown——连接循环 stop、sidebar 退订、`clearInstanceRuntime` 等）。此前
  移除实例只卸载 React DOM，僵尸 shell 的 2 条 WS + 无限重连（退避上限 10s、
  每次重试 `console.warn`）+ 全部 store/会话数据 + 桥订阅永久存活；`runtimeReports`
  模块级记录因 teardown 不执行而永久泄漏。拆除为幂等 + fire-and-forget（重加
  实例 boot 全新 ctx）；类型经 `as unknown as` 收口。验证：`build:renderer` 绿。
- **publish 签名闸 + identity-preserving 状态（消除 10s 全量重渲染）**：
  `shared/derive.ts` 新增 `instanceSnapshotSignature`/`runtimeReportSignature`/
  `serversProjectionSignature`（纯函数，单测覆盖）；`App.tsx` 的
  `refreshAggregate`/`onRuntimeReport` 内容未变即复用旧 state 对象，publish 前
  以投影签名去重（排除无人消费的 `server.updatedAt`）；`SidebarRoot` 订阅同款
  去重作纵深（对齐设置桥 `subscribeServers` 既有模式）。效果：10s 轮询/状态推送
  不再触发 N×侧边栏全量重渲染。验证：`test:sidebar`（derive.ts）48 用例（含 5 个
  新签名用例）/ `typecheck:sidebar` / `typecheck:settings-bridge` / `typecheck`
  （renderer）/ `build:renderer` 全绿。
- **会话行 `content-visibility` 注入（缓解长会话 INP）**：`styles.css` 对 vendor
  会话行（`[data-chat-flow-key]`——vendor 契约锚点，升级 harness.commit 时若该
  属性改名，规则静默失效（安全降级但收益消失无信号），需留意）注入
  `content-visibility:auto` + `contain-intrinsic-size:auto 320px`（前置固定 320px
  兜底行，防不支持 `auto <length>` 的旧 Chromium 高度塌缩）——视口外行跳过
  style/layout/paint。纯 CSS，不减少 DOM/内存（上游虚拟化是根治，见 todo 10 §6
  记录的上游诉求）；若实测底部跟随/滚动锚定回归，优先调整估算值或收窄选择器。
- **结构性项（记录待办，未实现）**：事件驱动聚合取代 10s 轮询（todo 10）；
  会话虚拟化 / 单前端多适配器（上游诉求，见 todo 10 §6，chamber 不可改）。

## 范围决策与剩余偏差（不做 / 推迟 / 移出）

- **移出项**（P3 硬纪律，永不回流）：认证/审计（密码/Passkey/会话
  cookie/client token/限流/审计 SQLite）、控制面薄壳聊天/会话列表/审批
  弹窗、控制面会话运行时/统一索引/交互管线、连接注入适配器/broker/
  绑定、walkthrough、notifications、cron、文件夹/笔记、
  web 预览、MCP、目标/终端等宿主 UI 职责面（处置映射见 01 §4；git/GitHub
  例外：插件化，见 01 §4 / 设计 08）。
- **已覆盖（侧边栏不做）**：fork 会话——官方 conversation 回合尾部分支
  动作（ui-conversation turn-tail `forkAt`）在 boot 图内常驻可用，侧边栏
  行内 fork 仅 UI 覆盖缺口。
- **推迟**：flat 单列表模式（与"仅按来源分类"呈现原则张力）。
- **已实现（2026-08 修订）**：当前空白"新会话"行——活动来源的当前空白
  会话按官方 `(!blank || current)` 规则投影为 New Session 行（仅活动来源
  投影，与 06 §4.3 全局单选门控一致；其他来源空白行仍不入导航列表）；
  壳内新建会话（New Session 按钮等 ctx 内入口）与首条消息后 blank→real
  翻转触发该来源聚合即时重拉（插件会话列表结构签名变化 →
  chamberBridge.requestRefresh，不等 10s 轮询）。
- **06 §4.3 修订（2026-08，方案 A）**：待交互（pending）状态不再与运行中
  同形——会话行尾状态槽对 pending 渲染**可辨识图标徽标**（`question` 问号
  / `plan-review` 清单 / `approval` 警示三角；business 蓝 / warn 琥珀两级
  配色），运行中仍为蓝色 ongoing 环；通道与数据源不变（仅渲染分支 +
  样式）。悬停替换（状态槽 ↔ 行操作）语义不变。
- **不做（v1）**：跨来源移动会话、单 store 真融合（fork runtime）、会话
  实时推送同步、远程实例管理 UI 外壳。
- **设置壳偏差**：未连接实例不装配子 ctx（配置在目标机器上，物理
  不可达）；stub remote 无 WS 失效流（外部改动不实时推送到桥接页，刷新
  依赖重进/切换）；设置壳不渲染官方 SettingsRoot（自建壳，onboarding
  步骤与 settings.header/action 席位省略）；子 ctx 懒装配（仅面板打开且
  服务器已连接时，关闭即释放——首次打开有一次短暂加载）；下拉列表为
  in-panel 定位（非 portal），nav 滚动 + 超长 roster 时尾部可能被 nav
  裁剪（已知项，后续可换 portal）；面板 chrome 跟随宿主 boot 的 UI
  locale 而子 ctx 内容跟随目标实例 locale.preference（两服务器语言偏好
  不同时混排——符合"配置事实留在目标主机"哲学，预期行为）。
- **v1 实现形态（代码内声明，与 05 契约无实质偏差）**：自研侧边栏 + 纯
  dsh 首屏即基线；renderer 的 entry 级 React 面仅剩纯 dsh 桥接宿主
  （`App.tsx`：auto-start/auto-connect、chamberBridge publish、
  onOpenSession/onActivateSource/onRefresh/onRuntimeReport）；当前来源
  判定经 knob 注入（`chamber-knob.ts` ↔ `ctx.chamberInstanceId`）；拷贝
  包 `tests/` 未拷贝；`chamber-auth` 随认证移除；settings 页
  `ns.inject('settings.section' …)` 通道可用于后续插件化。
- **窗口标题冻结（桌面壳故意偏差）**：官方前端 `DocumentTitle` 会把当前
  会话名投影进 `document.title`（浏览器标签语义）；桌面壳在
  `packages/desktop/main.ts` 以 `title: 'dsh-chamber'` + 拦截
  `page-title-updated` 冻结原生标题栏（单 frame 品牌恒定），会话名仍在
  应用内呈现——不改前端、不重实现。
