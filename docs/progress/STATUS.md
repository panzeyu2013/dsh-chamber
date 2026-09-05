# 模块完成状态总览（STATUS）

> 本文档只追踪**未完成 / 部分完成**项与范围契约。已实现基线以 git 历史、
> `CHANGELOG.md` 与 `docs/design/`（设计契约与样式定稿）为权威，不在此复述
> 实现过程、历史用例数或每日验证日志。本文档是 dsh-chamber 进度追踪的唯一记录。

## 未完成 / 待执行

> **2026-09 dsh 基线对齐记录（0.1.2-rc.1，临时驻留；发布收口时并入 CHANGELOG 后移除）**：
> 源码线 pin → dsh-v0.1.2-rc.1（a66e4702，`update-vendor.mjs` 原子升级，tag 与远程一致；
> 锁文件重生成后 frozen 稳定、零 diff——本轮上游相对 alpha.5 **零代码改动**：全仓 252 个
> package.json 仅版本行 bump（alpha.5 → rc.1，diff 复核），客户端/wire/存储/DOM 面无任何增量）。
> fork 副本（connection/web/api-gateway）零源码重放（rc.1 与 a5 同码），版本标记
> 同步 rc.1；运行时线常量同代（bundle 锁文件 / bundle-dsh 兜底 / release.yml env /
> install-gateway.sh 锚，`bin.js --version` 冒烟 = 0.1.2-rc.1）。a5→rc.1 无任何改动
> → DOM 锚点审计基线（a4 双 pin，alpha.5 复核）与 wire 契约结论直接继承；回归测试套件见 rc.1 分支提交说明。

**0.2.2 发布前审查跟进项（2026-09-05 三合并 review round；三路 P0/P1 = 0，
放行 0.2.2。部分 P2 已在发布前落实：e10a2c7（settings-dshruntime ①②③）、
9b2aeb8（settings-plugin close 门控），见各面标注；design 08 §11.1 的 chip
契约 stale 已以注记修正（5a41ebe）。其余 P2/P3 排入下一修复 round）**：
- sidebar-folder 面（合并 dca181c）：① 拖拽 after 锚扫描基于 registry 序
  （SidebarRoot.tsx commitWorkspaceDrag）而非 override 感知的渲染序——仅
  乐观提交→聚合确认瞬态窗口内可能差一行（存量错位，未扩大）；修向：扫描改
  在 renderedOrder 上求下一可见 id 或抽共享 helper。② 会话行动作仍 hover-only
  揭示（sidebar-chamber.module.css `.sessionRow:hover`），键盘/触屏无揭示路径
  （存量；workspace 头已 pointer-safe）。③ 仓库组折叠 × 会话待办条带
  （SessionTodoArea 纯投影无 fold 输入）：主行折叠后派生行会话的注意力条目
  仍钉条带顶部，与 docstring「不声称行指示器未显示的注意力」张力——确认产品
  意图后过滤或文档化。④ 折叠过滤/拖拽扫描无组件级测试（谓词单测充分）。
- settings-plugin 面（合并 16f7f27）：① **已落实（9b2aeb8）——close()
  busy 门控（2026-12 review P2-2）**：installing/folderBusy/
  undoBusy/seedBusy/restartBusy/syncing 在跑时禁止关框（restarting 受管
  重启有 unmount abort 属例外）。② 添加区互斥矩阵单向（PluginDialog
  安装/导入/搜索只查 installing/folderBusy；ssh undo/seed/apply、gateway
  restarting/syncing 在跑时仍可并发提交，且 undo/seed 与 apply 不共享主进程
  单飞 key——plugin-sync.ts 只拦 apply×apply）；主进程 loud 拒绝兜底，无数据
  损坏路径。③ chamber 表 en 最坏徽标组合 ≈516px 静态估算超容器临界（CSS
  minmax 144px 版本轨），窄窗可能横向撑破——实机目检后定（版本轨放宽/徽标
  换行）。④ P3 族：en n=1 单数文案（locales `There are 1 differences`）、
  行移除 aria-label 覆盖可见文本、行无 <label>、ssh done 态 stale 行按钮可用、
  无 PluginDialog DOM 测试、对账空态双提示。
- settings-dshruntime 面（合并 acc8ece）：①②③ **已落实（e10a2c7）**——
  同帧冻结洞（runRemoteAction/onApplyRegistry 围栏并入 checkIntent）、
  gateway 重启窗口检查禁用并入 restarting prop、新检查起始清旧 versionsError。
  ④ PUT registry 成功不 bump versionsEpoch（旧源数据直到下次自然刷新）；
  ⑤ 30s 超时文案对后台拉取也生效且与「不可用」外层文案双重措辞；
  ⑥ swap-attempted 相位检查可用性与 desktop runtimeBlocked 投影对照复核
  （注释自述逐相位镜像的准确性）；⑦ 围栏/超时逻辑内联组件 effect，未入
  node-harness 可测纯层（可测性债务）。窗口级残余均服务端读侧无害、≤3s 自愈。

**探针与随会话数据量增长的响应体彻底解耦（2026-12 定稿并实施；方案见
design 18 §3.4 探针集、design 02 §3.2/§3.5 就绪/健康探测）**：chamber 身份/健康
探针统一到固定小体积契约（激活探针集与会话数据解耦；settings/describe 与
data.settings 两行按文件上限放宽，见下 B1）——`session/canOpenWorkspacePath`
（SessionController `session` namespace 零参 boolean Typert Remote，钉住上游
0.1.2-rc.1 实证存在）：纯同步平台检测、不读会话数据、不激活 Agent、无 IO；
value true/false 均健康（只验方法存在/协议正确/控制器装配）。响应上限 64 KiB
（探针专用 per-call cap；control-plane probeHostIdentity 与 desktop node:http
身份探针均按调用设置；dsh-runtime 激活身份行无独立 cap、走载体默认 1 MiB 上限——
响应仍受内存界约束，见挂账⑥）。HTTP 404（部分 0.1.2-alpha.x 早期树 /
dsh < 0.1.2-rc.1 无此方法；是否真为 legacy 由回退结果判定）→ 自动回退 legacy
`session/list`（默认 1 MiB 上限，与今日语义逐位一致，老版本不劣化），**回退
成功**必须写 warning（失败路径已各自 loud：双 404/非 404 透传——时机与节流见
挂账⑦）；404 之外（401/5xx/超时/畸形）如实失败不回退。方法名
与 payload 构造单源在 `control-plane/src/rpc-envelope.ts`（cross-package，desktop
SSH 探针经 control-plane-module 引用同一常量）。**选项 A 已执行**：`data.sessions`
探针移除（探针不再读会话数据，会话存储健康不在激活契约内）、`session/list` 退出
激活 6 项探针集（`REQUIRED_ACTIVATION_PROBES` = commands/execute ·
session/canOpenWorkspacePath · clientGraph/graph · settings/describe ·
gitWorktree/previewCreate · data.settings，hostDomains=false 形状派生 4 项）。
`describeCapabilities`/`capabilityCache`/`CapabilitySnapshot` 删除（生产无消费者；
health/readiness 走 `probeHostIdentity`）。B1：settings/describe 探针 per-call 上限
放宽至 16 MiB（与 `SETTINGS_FILE_MAX_BYTES` 对齐，合法大配置永不误伤；
`RuntimeProbeRpcOptions.maxResponseBytes` 透传；desktop runtime 激活直连
control-plane `call` 自动生效；gateway runtime-manager 两处 call seam 亦转发——
两端一致生效，见挂账⑧）。**挂账**：① 上游 `session.list` 的分页/裁剪/删除能力（归档
瘦身的事实源头）仍待上游，chamber 不落地实现；② 归档「不能瘦身」事实维持——
归档仅影响列表体积，探针不再读列表后不影响探针健康语义；③ dsh-runtime
runtime-probes 的 legacy 回退 warn 为可选注入 `warn` sink——桌面 main.ts 与
gateway runtime-manager 按定稿不加逻辑改动，未注入即静默（control-plane
probeHostIdentity 两生产调用点均已注入真实 logger，回退必 warn）；
④ desktop SSH attach 底线随探针迁移**上移至 ≥ 0.1.2-rc.1**（2026-12 审查修订口径：
非「保持」——旧 session/list 主探针时代凡 200 ok:true 即 attach-ready，含
[alpha.1, rc.1) 老树）：新方法 404 的旧版 dsh 由 signature 路径给出确定性
terminal「check or upgrade」（先答新方法、404 时再答 legacy session/list 识别——
远端不自动收编 legacy 树，旧版需手动升级）；legacy 识别臂预算为剩余预算的角落
（超大会话列表序列化 >2s 的老树落 generic「not a dsh instance」，同为 terminal、
信息更差，接受）；⑤ 探针契约要求上游方法不再漂移——未来上游若再删/改名该方法：
本地/健康层（probeHostIdentity，两生产点均注入 logger）在回退成功时 warn 可见；
激活层（runRuntimeActivationProbes）owner 未注入 warn sink（挂账③），若上游仅删
身份方法而 session/list 仍在，激活行将静默通过、双 404 时 fail-loud——漂移的
激活层可见性以失败路径为准（design 05 §7.6 文案同步）。
⑥ 64 KiB cap 的覆盖面：control-plane probeHostIdentity（spawn 就绪 + 健康）与
desktop node:http 身份探针按调用设置 64 KiB；dsh-runtime 激活 session 身份行未透传
per-call cap，受注入载体默认 1 MiB 上限约束（accept boolean 语义不受影响）。
⑦ legacy 回退 warn 的触发时机 = **回退成功后**（成功即真 legacy 信号；现代树
transient 404/双 404 保持安静）——避免每次 500ms 重试/每 30s 健康周期的重复
warn 与错误前提文案（2026-12 独立审查 A-P1 采纳：原实现 warn 先于回退结果、
逐次重试重复且前提可假——已修复）。作用域：control-plane `probeHostIdentity`
（spawn 就绪 + 健康）按 baseUrl 节流（每连续 legacy 期至多一条：identity 成功
应答时清除标记——审查 R2-P2-1）；dsh-runtime 激活行同一「成功后」时机、无节流
（按激活事务触发，每事务至多一次；owner 未注入 sink 即静默，见挂账③）。
⑧ gateway runtime-manager 两处 call seam 现转发 `maxResponseBytes`
（定稿「无代码改动」按审查 B-P1 有意修订：不转发则 B1 的 16 MiB
settings/describe cap 只在 desktop 生效，服务器端合法大配置仍会
response_too_large → 激活回退——seam 各加一行转发，行为无其他变化；
gateway 端到端钉测已补：runtime-routes.test.ts「real manager: the B1 16 MiB
settings/describe cap reaches the wire carrier」用 fake dsh host 应答 >1 MiB
settings/describe，实测摘除转发即红）。
⑨ 提交态 `packages/dsh-runtime/dist/index.js` 已重建（审查 R2-P1-a：提交态
bundle 仍是迁移前旧 7 项探针语义，而 desktop/gateway 经包 main→dist 消费——
src/dist 语义分裂可两套测试同时全绿）；护栏升级：dist-sync.test.ts 增加
常量值级 deepEqual（探针集/settings cap）+ 行为标记（**激活探针集导出值**
不得含 session/list/data.sessions——dist 为 legacy 回退保留 session/list
字符串是正常的，护栏按导出值断言，勿当字符串约束误读），desktop
cross-package-contract.test.ts 增加
dsh-runtime 激活集 ↔ control-plane 身份常量跨包锁步断言（防 dist 再陈旧或
方法漂移）；desktop/README.md 身份握手文案同步。
⑩ 第二轮审查决定与登记（2026-12，全 5 路 P0/P1=0）：warn 文案「per legacy
episode」与 dsh-client 标记复位语义一致；VERIFY_UP_MAX_BODY_BYTES 注释修正为
「verifyUp 非身份主臂的 200-body 默认 cap」（legacy session/list 臂 + gateway
/status 臂共用）；design 02 §3.2/§3.5 与 STATUS 头部补「回退成功」限定词。
**P2-1 设计取舍登记（不改语义）**：远端瞬时重启/路由挂载窗口内（HTTP 已
listen、session 路由未挂）identity+legacy 双 404 → 通用 terminal "not dsh"、
terminal 不自动重探——该粘滞窗口**先于本次改动存在**（旧 session/list 主探针
404 同样 terminal）且与「已答即确定性」分类原则一致（ECONNREFUSED 才瞬态）；
ready 心跳期对「404+legacy 负面」降级为瞬态的改法会引入无关服务接管端口的
60s 慢重探 churn，取舍留给未来设计。**P2-2 契约**：transport-provider.ts
verifyUp JSDoc 已写明「必须在自有限期内 settle」（transport 层裸 await，无外层
超时）。可选覆盖登记：签名臂 64 KiB cap 数值的判别性用例已补（>64 KiB 合法
envelope padding——cap 抬至 1 MiB 即变 'dsh'，必红）；ready 心跳真探针端到端、
204/206/3xx 身份臂状态表为可选后续。

**0.1.2 线已知降级（仍有效）**：
- **远端/直连 0.1.2 dsh 附加被硬阻断**（launch token 为远端进程内存随机数、隧道不可恢复；verify 探针 401 诚实分类；上游提供 token 检索机制前保持阻断）。**2026-09：dsh×http 组合已在连接表单与主进程校验禁用**（http 只服务 gateway；ssh 为 dsh 唯一传输——设计 17 §3 记有恢复点）。
- **版本芯片**：本地实例已接线（desktop 桥运行时版本），远端实例隐藏（D2 兜底）。
- **cookie Max-Age=30 天无会话中重换**：过期后约 10 分钟健康失败窗口触发重启换新（自愈，后续排期「cookie 过期即重交换」）。
- **remote-stream 接收面帧校验宽松于上游 exactKeys**（接受未知键，前向兼容容差）。
- **settings-bridge agentPresets/select 以合成 `{agentId:'',agentPreset}` 发出**（typert wire 将 Agent 参数投影为 agentId 键）：一旦被调必响亮失败（当前无调用点，潜伏面）。
- **端口碰撞理论面**：本地实例同端口 cookie 覆盖（实际不可达，登记不修）。
- **设计 07 §3 #3（agent-default-model 回显）已解锁**、实现另行排期。
- **unary 兜底归档过滤无 wire 源**（0.1.2 删 workspace.list；归档集仅存在于 follow baseline）——仅影响未挂载来源与首次 baseline 前窗口（KNOWN DEGRADATION，见 `instance-api.ts` fetchInstanceSnapshot）。
- **推送通道死亡期间侧边栏成员关系/归档集冻结在最后推送**（sessions 仍刷新、恢复推送自愈；冻结窗口内新归档/取消归档不可见；mounted 源在 store 未 withdraw 的断连→重连窗口同样落入全量兜底视图直至下一次真实推送——见 `aggregate-refresh.ts` commitAggregatePull 注释）。
- **兜底 cwd 派生分组的已知限制**：符号链接拼写（如 macOS /tmp vs /private/tmp）可能不匹配 canonical-cwd 索引，会话落未分组桶（诚实兜底）；未挂载（兜底）来源的新建**空工作区**不可见（无会话即无组，fail-closed 语义）。
- **git 工作树删除时 runtime 通道缺席 fail-closed**（'runtime-unknown'）。

**性能整改（2026-09，P0–P2 执行完毕；已批准方案全文缺失、按仓库痕迹重建执行，
计划/决策台账与测量数据见 `docs/progress/performance-baseline.md` §0/§1；进度只
记状态，数据与方法不在此复述）**：
- **P0 ✅**：T1（H1 卸几何 veil，D1=A——骨架不再模仿 dsh 布局几何，改全屏同底色
  veil；T13 并入 T1）+ T2（view-transition 键控单槽合并：同键最新意图胜出、跨键
  FIFO、startViewTransition 异常防御）——门禁 build:renderer / test:renderer-shell /
  typecheck 全绿；场景①同环境 A/B wall ≈880–1162ms（PRE run1 1162 / 中位 890↔888）、
  长任务形态 0–2×80–105ms/启（PRE run1 105ms 为上限，AFTER 4/6 run 为 0）、
  CLS<0.002；design 05 §4 已同步修订注记。
- **2026-09 review 处置**（5 面独立审查，修复已并入分支提交）：sidebar 拖拽-防抖竞态
  （F1，写前 flush）、文档 3 处 P1（boot-after-final 交代/PRE 长任务数字/T7–T12
  去向对账，见 performance-baseline.md §9）、渲染层 P2 硬化（catch try/finally、
  直通路径统一入队）、maxReruns 文档与代码对齐 + 边界测试、gateway 测试 race
  兜底、嵌套 ENOENT 竞态注释精确化、yieldEvery 钳制、多处注释/README 措辞；
  次轮补齐（2026-09 review 收口）：F4 flush 陈旧守卫（缓存 TS 超越 pending 的
  账户整条跳过）、coalescer 单次请求 `{rerunOnJoin:false}` 静默 join（gateway
  非 force 冷缓存路径接线，消除长遍历期轮询补跑长尾）与配套测试（F8 缺口 ×3、
  F4、maxReruns=1 边界）。
- **P1 ✅**：T3（D8：`runtimeDiskSummaryAsync` 异步分批单遍遍历 + `createCoalescedRefresher`
  节流/单飞/终态一次，接线 desktop main、gateway runtime-manager；桌面控制器 DI
  `store.runtimeDiskSummary` 契约改 Promise——安装闸口等待同墙钟但进程不冻结）——
  test:runtime/typecheck:runtime/test:desktop/typecheck:gateway/build:gateway 全绿，
  合成曲线 425k 项 51.0s→42.2s、中小规模 ±4–18%、全程不冻结；T4（M4 置顶写回防抖：
  updated-mode promotion 簿记 250ms 防抖窗 + `updateViewPrefs` 等值写不落盘不通知）——
  test:sidebar/typecheck:sidebar 绿；T5（M1 事务证据刷新调度收口，**D7**：progress
  相位 downloading/installing/applying 跳过全树磁盘遍历、复用最近投影；终态/content
  相位永远现场重走）typecheck 绿；T6（**D3**：H3 主 bundle 求值长任务实验——eval 归因
  探针 `scripts/perf/eval-measure.mjs` 落地；归因结果：每启两段结构任务（13–21ms 起
  72–96ms 主图求值、100–120ms 起 57–62ms 实例启动图）；安全懒加载边界审计结论：
  首屏急切图与实例启动图内无 chamber 自建可动边界 → 负面结论，真实机复查清单见
  基线文档 §7）。
- **P2 ✅**：perf 工具卫生（scripts/perf/README.md、CDP 超时守卫、H3 探针）；全量
  门禁重扫（含 T5 后的 test:desktop、verify:i18n、test:release-workflow）；dev 实例
  烟测（新 main 代码冷启 + 本地实例 ready + 运行时设置页磁盘证据面）；本文档条目 +
  基线文档完成态（`docs/progress/performance-baseline.md`）。
- **范围契约变更（随 T3）**：dsh-runtime 新增异步磁盘统计 API 与共享节流原语；
  `ControllerDeps.store.runtimeDiskSummary` 由同步改 Promise——desktop 是唯一接线方
  （gateway runtime-manager 为独立实现、不消费该 DI）。同步 `runtimeDiskSummary`
  保留为兼容面，两实现逐字段对等（测试钉死）。
- 遗留真实机清单（②⑤ 宽侧栏冷 settle CLS、⑥ 版本事务主进程阻塞采样、H3 真机懒
  加载验证）：步骤见基线文档 §7——需打包版或带会话的 dev 实例复测。

- **已归档会话管理（设计 12）**：方案 A（前端已归档浏览区先行）+ C（上游
  wire 根治）；实现未排期。设计见 `docs/progress/todo/12-todo-archived-sessions.md`。
- **gateway 连接插件能力对齐（A/B/C，2026-12 用户提出；Phase 1-5 已实现 + 质量审核修复轮已落地，见 design 21/本段）**：
  gateway 连接缺 ssh+dsh 的第三方插件「添加/同步」（design 17 §3/§10 收窄的
  副作用）、connections 页缺 gateway 受控重启入口、日志/主机日志按钮不可区分。
  B（连接日志/网关主机日志改名 + 图标去重）与 C（gateway 卡 + 插件面板「重启
  dsh」，经实例代理 `/chamber/runtime/restart` + 202/status 轮询；gateway-runtime
  parse/poll 纯核心迁 sidebar/shared）已定稿；A v1 已拍板：**单一插件管理模型、
  仅最终执行阶段分叉**（gateway 宿主 spawn vs ssh exec，非双通道同权）；registry
  spec 直装 + 文件夹直推双通道（出网允许、registry 来源不限定、lifecycle scripts
  默认允许），第三方同步仅手动、批量一次确认，runtime 单写者栅栏 + ready 边沿
  deferred 排空；含远端「已安装」列表显式移除（模型统一、ssh/gateway 同权）、
  `POST /chamber/runtime/start` 停机恢复原语、journal/备份撤销最近操作、故障域
  恢复（评审 P1 修正已并入 v2）。契约见
  `docs/design/21-gateway-plugin-parity.md`（原 todo 评审稿已并入该 design）；执行计划见
  `docs/progress/todo/21-gateway-plugin-parity-plan.md`（Phase 0-6，逐阶段门禁）。
  **实现进度（2026-12，执行级门禁零 P0/P1）**：Phase 1 B ✅、Phase 2（C + gateway-runtime parse/poll 迁
  sidebar/shared + ambient 镜像 + 卡片/面板「重启 dsh」）✅、Phase 3 A0（gateway installed 读路由 +
  desktop `gateway_plugin_sync` IPC + 视图 chamber 同步/漂移）✅、Phase 4 A1 写面 ✅、Phase 5 UI 全闭环
  ✅（详情见下三段）；
  其中 Phase 4.3 的白名单族前置已先行落地：spec/name/materialize 白名单 + MAX 字符 +
  WRITE_FILE/RUN_STDOUT 上限迁 `control-plane/src/plugin-spec.ts`（design 21 §6.2 单一来源；desktop
  经 control-plane-module.ts 双路径 facade 与原 ssh-provider 再导出消费、gateway 经包导出直引），新增
  `isDeniedPluginName` 保留名谓词（@deepseek-ai/* + @dsh-chamber/*，decision 19），渲染端 ADD_SPEC 镜像
  锁步测试落地（gateway/test/plugin-spec-lockstep.test.ts；ssh 侧 applyPlugins 保留名拒绝接线随统一增量）；
  运行级验证（typecheck/test/实机）待可运行工作区执行（登记残余风险，不虚报）。
  **运行级验证状态更新（2026-12 后期）**：本工作树已可用 `~/.nvm/versions/node/v24.20.0` + pnpm 装入
  node_modules（vendor/harness-checkout 子模块仍缺失，仅影响需 vendor 源码的构建如 build:renderer/打包）——
  已落地内容在可运行子集上**已执行验证**：test:gateway 全绿、test:connections 10/10、test:sidebar（含镜像
  锁步 5/5）、test:settings-bridge、desktop 受触套件（gateway-sync-registry/plugin-sync/ssh-provider/
  transport-manager/ipc-surface-mirror/renderer-trust/cross-package-contract/gateway-provider）全绿；
  typecheck:gateway/:connections/:sidebar/:settings-bridge 0 错误；Phase 4 起门禁以执行级为准（子代理默认 shell
  无 nvm PATH——命令需显式 export 或在父代理侧运行）。
  **Phase 4 进度（2026-12，执行级验证）**：4A 白名单共享迁移、journal+串行执行器（含 XDG_CONFIG_HOME pin/
  前后双检/onTerminal）、写栅栏 beginProfileWrite（双向互斥）+ start 原语 + beforeSpawnCheckpoint 生产接线、
  plugins-tasks 编排器（lease/deferred.json/单飞 drain）与 install/remove/materialize(流式 32MiB+tgz 上限)/
  tasks 四条写路由均已实现——gateway 全套 481 测试（478 通过 0 失败 3 平台跳过）+ typecheck 0 错误；
  Phase 4 已勾销（2026-12，执行级门禁零 P0/P1：汇总门禁 FAIL 1 P1 → I4 修复 → P1 关闭复核 CLOSED；
  gateway 487/484/0fail/3 平台跳过、desktop 全链 724/724 26 文件、root typecheck 0）：4G apply/materialize
  IPC、F7×租约串行化（waitForProfileWriteIdle 先于 restore）、executor canRun 窗口复核（等待-再-阻断）、
  code 族统一（reserved）、remove-before-add（decision 5）、256MiB 解包上限对齐均落地。Phase 6 归口登记：
  remove not_installed/no_manifest 409-vs-400 定夺、dispatch/routes 陈旧注释清扫、journal 保留窗口、
  'too_large' 双档、任务面措辞回写。
  **Phase 5 进度②③（2026-12，执行级）**：② ssh 模态新增远程「已安装」list tab（逐行移除确认 + 撤销
  undo IPC、fail-loud verified/ready 标记照实呈现；等价表逐键保持、local 模式零改动）；③ gateway 统一视图
  增量（PluginInventoryView：已安装行/移除/撤销/变更记录 tasks 投影（deferred 意图+busy+recovery 提示）/
  profile_absent-corrupt 横幅/停机 chamber 区降级标签；修复 Phase-3 遗留 seed-cache 双前缀真 bug）+ 卡片
  「启动实例」start 动作（runtime 探测门控 stopped/error/restart-exhausted、202+poll）；A 键表 34+1 键
  （296/296）。connections 全链 112/0、typecheck 0。Phase 6 归口（2026-12 settings 两页微调 round 已收口，见下段；
  统一单组件合体完成、变更记录区移除、恢复化撤销、add 双通道、缺陷①修复；
  余留 who/when 归因与拒绝码本地化（照实）。
  **Phase 5 进度①（2026-12，执行级）**：纯模型层 plugin-model.ts（deny 镜像/orderApplyOps/
  ApplyOutcome 分类（含 ssh fail-loud verified/ready/readyNote 诚实携带）/projectTasks/undoForLatest/
  分派表/BATCH_FAILURE_POLICY 单一取舍；35 测试 + 控制面 lockstep）✅ 门禁修复后零 P0/P1；ssh 统一增量
  （readManifest 掩码统一挂接 SSH_PLUGIN_LIST、保留名整批拒绝（decision 19 同集）、ssh-plugin-journal +
  SSH_PLUGIN_UNDO IPC（撤销=恢复语义、file-backed/out-of-model 不投影）、undo 诚实面）✅ 门禁 PASS +
  两条 P2 修复（upgrade-restore 对称恢复、executed-but-not-effective 投影）。
  **质量审核修复轮（2026-12，审核后执行；全量验证绿）**：4×P1 已修复——executor
  租约泄漏（journal 终态写失败/记录丢失仍触发终态钩子，plugins-exec complete()）、
  executor env 白名单化（INSTALL_ENV_WHITELIST 共享常量，同 dsh-runtime 源）、
  deferred 排空后自动受控 restart 一次（全部排空 op 终态后请求——首 op 终态请求会撞后续
  op 租约门，第二轮扫描修正为末 op 终态点；index.ts restartManaged 门控镜像 /restart 同步
  拒绝族）、ssh undo journal 操作目标指纹绑定（latestOkForTarget + 删除/编辑
  转换路径 clear 接线）；8×P2 已修复——错误脱敏升级（sanitizeInstallerOutput 族 +
  2000B 有界）、tasks/deferred 投影 file: 掩码、崩溃孤儿子进程 pid journal + 启动
  对账击杀、手动 chamber 同步失败显式化 ok:false（both-false 遗留 P2 勾销）、
  gateway_plugin_apply 确认后重检、deferred drain 波浪续排（>8 积压自清）、staged
  tgz 三处 GC、persistence_failed 500 错误码族；均带失败注入/行为测试。文档归位
  本次补全：design 17（§3 表 F4 勘误 + §10 写面 + §4.1 barrier 语言）、design 18
  （§6 出网登记 + §9.3 start 行/互斥矩阵/兜底链更正）、design 05 §5（F4 勘误 +
  design 21 增补）、design 13（收敛表述）、sidebar/settings-bridge README 双语文档
  与哈希重录——修复明细见 design 21 §10「质量审核修复补录」。
  第二轮扫描修正（复核修复轮自身，⑭–⑰）：drain 自动重启请求点改为本轮全部排空 op 终态后
  （原首 op 终态会撞在途租约门）、materialize 路由 500 分支补 staged GC、tasks 投影删除
  childPid（活进程 pid 不出网）、波浪测试强化（200ms 慢关 + 租约授予时序证明，5 次连跑稳定）。
   **settings 两页微调 round（plan 24，2026-12；`docs/progress/todo/24-settings-ui-polish.md` 已实施）**：
   Phase 6 归口收口——统一单组件合体**已完成**（`PluginDialog.tsx` 单对话框取代 PluginSyncModal/
   PluginInventoryView 功能等价双面，分叉收敛至数据源与动作分发；chamber 内建表三行 badge 化
   （client-graph/git-worktree/mobile 移动端行，仅 gateway 源显示）、诊断横幅去重（状态名 +
   message，pluginId 仅无 message 时兜底）、「重新同步 chamber 组件」按钮语义、http 直连只读不变）；
   「变更记录」tasks 区已移除（后端 journal/备份保留，journal 仅供 undoForLatest 派生）；撤销
   **恢复化仅 gateway**（runtimeDown 恢复横幅入口；ssh list tab 撤销按钮保留原样——范围偏差登记）；
   gateway 添加双通道已接线（registry spec → gateway_plugin_apply、文件夹 → gateway_plugin_materialize）；
   缺陷① `desktop_local_plugin_add_file` 已修复（allowFileSpec 补传 + plugin-sync 门测试）。余留照实：
   who/when 归因 tooltip 未渲染、gateway 拒绝码→本地化文案映射未做（409 逐字英文）；实机 E2E 矩阵仍
   不可在本树执行（design 21 §10 勘误⑦ 未勾销）。验证与偏差见 plan 24 实施偏差登记。
- **模型额外参数 + 默认推理等级（设计 07）**：实现推迟——wire 白名单无泛化
  透传、host 组合不可注入、`agent-default-model` 未对客户端暴露，待上游
  解锁（07 §3/§4）。设计见 `docs/design/07-models-params.md`。
- **SSH 密码认证可选增强（05 §8 例外主体已落地）**：一键免密引导与系统
  钥匙串尚未实现；现行 SSH 密码镜像仍是 endpoint-bound 0600 明文文件。
- **Windows 首版支持推进中（design 23；台账 `docs/progress/todo/windows-v1.md`，
  基线 `docs/progress/windows-baseline.md`）**：M0（ci.yml `test-windows` 契约腿）
  与 M1 生命周期契约（`win-probes.ts`：PowerShell CIM 身份 / netstat 端口 /
  taskkill 树终止；reaper 与 spawn-dsh 平台自适应接线；win32-only 集成测试）已
  代码就绪，POSIX 单测绿；M2a 运行时管理后台能力（env 门控
  `DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1`、supervisor 树终止、icacls/rename 续作、
  C16 safeStorage-only）与 M3 代码项（AUMID、托盘候选路径、preload loud 失败）、
  M4 代码解锁（登录自启 win32、深链打包态注册、open-in 本地盘符路径、NSIS 卸载
  清理 include、SSH 密码门引导）均已落地（本地纯模块测试全绿）。**外部门禁**：
  真实 Windows runner 首跑（含 submodule 物化 + junction 建链）、M0.5 上游/NSIS/
  Defender 实证、M2a 事务矩阵与 M2b UI 翻转（纪律：能力先于开关）、M3/M4 实机
  矩阵。仍保留的语义事实：detached/进程组/SIGTERM dispose 在 Windows 不可等价
  （硬终止 + 事务恢复，妥协 F1）；dsh-runtime mutation 与 SSH askpass 密码认证
  保持只读/禁用门控直至 M2a 验证完成。Gateway owner-private 目录在 Windows 只
  验证 real-dir/no-follow/identity 并继承 OS ACL（icacls 显式收紧已接线）：
  Node 的 mode/chmod 无法诚实证明 POSIX 0700，不能把该让步写成已有等价权限保障。
- **Linux 桌面首版支持（设计 22，2026-12 落地）**：AppImage（x64）发行 + 形态门
  自动更新 + 桌面集成修复已入库（打包配置；updater 形态门——探针按
  AppImageUpdater 真实替换语义校验启动形态/绝对常规文件/父目录可写，2026-12
  review 加固；XDG（仅绝对路径）/APPIMAGE 自启与协议 .desktop 每启重写 +
  CHROME_DESKTOP 指回；node 兜底平台分表 + X_OK；目录 fsync EINVAL/ENOTSUP
  平台无关容错；resolvePnpmBinDir Linux 根；release.yml build-linux 腿与策略
  测试 4 腿）。**无头验证（Ubuntu 22.04 测试机）**：Linux 原生 CI 对齐全量套件
  全绿（node 24.20、非 root runner 形态）；`dist:desktop:linux` 产物与 feed
  （url/size/sha512）、AppImage 内 .desktop 身份、afterPack 断言全部通过；
  双形态无头冒烟（AppImage 提取运行 / 解包目录）验证协议 .desktop 指向、
  形态门开关与本地 dsh 实例全链。细节入 CHANGELOG/发布笔记。
  **剩余实机门禁**（真实桌面矩阵 GNOME X11+Wayland、KDE 抽验，清单见设计 22
  §8）：XDG 定制自启、深链冷/热启动与 **CHROME_DESKTOP/xdg-mime 路由**及
  AppImage 升级后重注册、托盘可见性、通知点击、safeStorage 有无 keyring、
  SSH 密码全链、运行时安装/切换/apply-now/restartLocal 打包态全链、
  **自动更新端到端（已下载→退出→$APPIMAGE 原位替换→重启；stable+beta；
  二次更新）**、AppImage 沙箱与 Wayland 焦点、before-quit 确认框的无头挂住行为
  确认；另有 release.yml dry_run 全链验证（需 GitHub 可达，见下方 submodule
  剩余验收同纪律）与 deb/arm64 后续排期。
- **Linux 桌面已知未动项（登记）**：托盘图标候选两死路径见既有「desktop 打包
  闭包已知 P2」条目（同事实）；gateway 裸 CLI 默认 stateDir ~/.dsh-chamber 与
  control-plane standalone 同目录（裸跑形态运维提示待加；安装器形态
  DSH_GATEWAY_STATE 无此问题）；不做独立 verify-linux-appimage 脚本（取舍见
  设计 22 §5，以 afterPack + workflow 内联 + 无头冒烟覆盖）；XDG_DATA_HOME 偏移
  的 pnpm home 与 macOS ~/Library/pnpm 未纳入 resolvePnpmBinDir（低优）；
  dsh-runtime private-fs.ts syncPinnedDirectory 保持严格目录 fsync（设计 22 §6
  审计结论，未并入容错）；userData 实测 ~/.config/@dsh-chamber/desktop（可选
  优化 app.setName，未做）；electron-builder desktopName/syncDesktopName 提示
  （WM_CLASS 关联，低优）。
- **chamber shell 内官方 bundle 的实例相对绝对路径（已知缺陷类，2026-08）**：
  官方客户端 bundle 若绕过 patched connection carrier、以实例 origin 相对
  路径直接请求（读 `location.origin` 或硬编码 `/…`），在 chamber 页面（控制面
  origin）会打到控制面自己。已知实例：`@deepseek-ai/dsh-session-log-export`——
  `HEAD /api/session.export` 打到控制面 404 JSON，chamber 视图「导出会话日志」
  不可用（实例官方 UI 正常）；**记录缓办**：用户决策不逐个临时 fork（版本漂移 +
  UI 重复 + AGENTS.md 可改源码边界扩张），待出现第二个同类特性时一次性建立
  patched-copy 基础设施（共享 base-path helper）再统一处理。（`dsh-client-hmr`
  同类问题已断链修复。）
- **dsh 运行时版本管理（设计 18，M5–M7 已落地）**：剩余验证与实现缺口：
  - macOS 打包态实机：真实 `.app` 内共享 `packages/dsh-runtime`、内嵌 pnpm、
    koffi/dsh CLI 与完整激活/故障回退/数据恢复链；Linux server 同款端到端记录；
  - Gateway restart 窗口的前端重连，以及 connections 的 SSH `restart_service`
    systemd IPC 端到端回归（settings 的 dsh-runtime 段已移除 ssh 分支）；
  - `restartLocal()` 在真实 1s SIGTERM→SIGKILL grace 窗口与健康计时器交错的覆盖；
  - settings-bridge 的 gateway React 组件级交互（切换取消、失败链）仍主要由
    纯函数/API 客户端测试代证；
  - 该机 ZFS 下全新 pnpm store 克隆偶发 `ERR_PNPM_EAGAIN`；当前失败投影诚实且
    可重试，系统化并发缓解未排期。
  契约见 `docs/design/18-dsh-runtime-version.md` §3.6/§9。
- **apply-now 立即应用（18 增补）**：pending 相位新增用户触发的「立即应用」
  （复用既有激活事务与 restartLocal 停机窗口，零新终态、零新崩溃窗口）。契约
  见 `docs/design/18-addendum-apply-now.md`。**剩余验收（§9.2 实机门禁）**：
  macOS 打包态 `.app` 运行中「立即应用」全链；Linux server gateway 生产 TLS 下
  POST apply-now → 202 → 停机窗口轮询 → 探针 → 故障注入回退；`restartLocal()`
  真实 1s grace × 健康计时器交错；Gateway restart 窗口前端重连；Windows 只读投影。
- **发布基础设施长期目标态**：把 `ci.yml` 的 test job 抽为 reusable workflow，
  由 `release.yml` validation 直接复用。当前两份 YAML 已覆盖 gateway/runtime、
  control-plane、desktop、renderer、插件、CLI 与 policy 关键门，但仍靠策略测试和
  人工同步，新增 CI 门禁存在漂移风险。
- **Gateway npm 分发延后**：现行正式分发只有 GitHub Release 中的 gateway `.tgz`
  与同名 `.tgz.sha256`；workflow 会 pack、安装到干净前缀并执行 `gateway --help`，
  **不会**执行 npm publish 或维护 dist-tag。是否开放 npm 正式发布需另行决策与门禁。
- **desktop 打包闭包 P2（2026 修复轮已全闭环）**：托盘图标候选路径已收敛（只留
  extraResources 真实资源）；打包态缺 `dist/preload.cjs` 已改 loud 失败（对话框 +
  exit(1)，不再静默回退 `preload.cts`）；`dist/**/*.map` 已排除出包；`build:renderer`
  输出已隔离到 `dist/web`（vite emptyOutDir 只清 web/，不再触碰共享 dist/ 下的
  preload/control-plane/host 包产物）。2026-09-03 修订：`gen-boot-manifest.mjs`
  随迁 `dist/web`（manifest/预载/CSS 全部读写 web/，与 webDistDir 服务根一致；
  此前读根 `.vite` 只在残留旧产物下假绿，干净构建会失败）。打包验证以 CI
  build:renderer + Desktop build sub-steps 及 release 产物为准。
- **打包闭包自检（长期建议）**：CI 增加"desktop 主进程传递模块闭包 vs
  `build.files` 清单"机械检查，替代纯手工核对。

## 部分完成（剩余验收）

- **vendor 源码树 submodule 化（2026-09）**：已迁移为固定 commit 的 git
  submodule（`ensure-harness-vendor.mjs` 硬校验 submodule HEAD == `harness.commit`
  并断言链接集合 == 锁文件 vendor importer 集合；升级唯一入口
  `scripts/dev/update-vendor.mjs <tag>`）。**剩余验收**：Windows runner 上
  submodule 物化 + `ensure-harness-vendor.mjs` junction 建链（ci.yml `test-windows`
  腿即该验收；release `build-windows` 腿同步覆盖）、CI 真跑（push 后 ci.yml 全绿）、release.yml 改动后的 `workflow_dispatch` dry_run 全链验证
  （release-checklist §7b 纪律）。
- **桌面通知（设计 19）**：自动化主链已完成；**2026-09 实机修复**——macOS 横幅
  进入通知中心后不触发 Electron close（通常仅用户手动清除才触发），16 条未清除
  的存量横幅曾占满 `activeNotifications` 16 条硬上限，导致后续通知（含设置页
  「发送测试通知」，UI 报「测试通知发送失败」且 OS 侧无任何请求记录）被永久
  拒发；已改为 `BoundedActiveNotifications` 满员按插入序 loud 淘汰最旧一条并
  close 退役、新通知照常登记显示（硬上界不变，仅最旧条目 click 失效）。
  剩余 macOS 系统通知权限/拒绝行为、点击打开、关窗/托盘/后台三形态与打包态实机验收。
- **未读徽标（设计 19 §3.7，2026-12 M1–M2 已落地）**：Dock/任务栏应用图标红气泡
  ——renderer `projectBadgeCount`（完成未读蓝点集跨来源计数，`badge-count.ts`）→
  `dsh-chamber:badge-count` trustedIpc → 主进程白名单（有限非负整数 ≤9999）+
  `badgeEnabled` 裁决（关闭强制清零、重开 reconcile 恢复）+ 平台门
  `app.setBadgeCount`；设置新增 `notifications.badgeEnabled`（默认 true，通用页
  「通知」组独立开关行，zh/en i18n）。**子代理压制修复**：父回合结束但后台
  子代理仍存活（`runningSubagents > 0`，06 §4.5 后台模式）的武装蓝点不再计入
  徽标——`projectBadgeCount` 增加运行时事实压制参数（App badge effect 同时依赖
  `runtimeFacts`，子代理计数归零即重推），与窗口内运行环压制/complete 通知抑制
  同规，修复「主分支闲置等待子代理期间 Dock 误亮红气泡」误报；子代理全部结束后
  蓝点正常浮现计入。已知呈现边界（设计 19 §3.7 计数语义，文档化取舍）：徽标只计
  App 账本武装的完成——vendor completed 兜底行仅窗口内呈现（首观察/撤回窗口）；
  断连窗口徽标按保留账本计数、子代理压制数据随来源事实清空而短暂缺失（重连后
  事实行带回 runningSubagents 自动归零，自愈）。自动化覆盖：`badge.test.ts`
  （desktop）、`badge-count.test.ts`
  （renderer，含子代理压制用例）、chamber-settings 与 notifications-settings
  新键用例。**剩余实机门禁**：macOS Dock 红气泡打包态实机（武装/阅读解除/来源
  退役三态 + 重载清零 + 退出清零）；Linux 仅 Unity launcher 家族可见（GNOME 的
  Dash to Dock 消费同一 DBus API 可见；默认 GNOME/KDE 无效果，文档化平台限制）；
  Windows 任务栏 overlay（`setOverlayIcon` 数字角标图）v1 门控未接线——设计 23
  实机矩阵排期。
- **open-in 的 VS Code 窗口策略（2026-12 核查 + 修复）**：核查确认 dsh-chamber
  以 `vscode://` URL 拉起会话目录时，若 VS Code 已在运行，其默认策略是**复用
  最近活动窗口并替换其内容**（`window.openFoldersInNewWindow` 默认 `default`，
  外部协议 URL 无 new-window 指令 → 主进程 `handleProtocolUrl` 走 reuse 分支；
  已在本机 VS Code 1.135 主进程 bundle 源码逐级核实；CLI `code <path>` 因
  preferNewWindow 默认新开，故按钮与 CLI 体感不同）。修复：新增 chamber 设置
  `vscodeOpenInNewWindow`（默认开；chamber-settings.json + 通用页「运行」组
  开关，zh/en）——开 → 本地 `vscode://file/` 与远程 `vscode://vscode-remote/`
  两种目标统一追加 `?windowId=_blank`（VS Code 在复用决策前强制新窗口分支；
  目标文件夹已开在某窗口时仍聚焦旧窗口不重复开）；关 → 保持裸 URL 交还 VS
  Code 自身策略。按钮与 OS 深链同管线（wiredCtx 每次拉起惰性读取）。
  自动化覆盖（2026-12 实测）：desktop chamber-settings / deep-link / open-in /
  ipc-surface-mirror 套件 + desktop tsc（含 main.ts 接线）+ build:preload +
  typecheck:settings-bridge（GeneralView/类型镜像）；build:renderer 与三列布局
  的整窗视觉待 vendor 树就绪后补跑。**剩余实机门禁**：见『VS Code 深链 +
  open-in（design 16/20）』条目的 macOS 实机验收（新窗口/复用两态在打包态
  VS Code 的真机确认仍属外部门）。
- **会话待办区（sidebar todo area，2026-12 已落地）**：侧边栏宽栏滚动区上方固定
  待办块（仅在有内容时出现、零占用；最多 3 条 +「还有 N 项」展开——展开侧有界：
  行区内部滚动，「收起」常驻，条目回落即自动收起）——对 chamberBridge 投影的
  **纯派生**（`shared/todo-attention.ts`：完成未读 ∪ 待交互 approval/plan-review/
  question，与行尾指示同一优先级纪律 pending > 子代理 > completed > 运行环
  （completed 优先于环，通道错位窗口不漏报）；断连不臆造、重连随真实状态重现；
  正在查看的会话排除，同高亮 currentId 单选纪律）。点击 = 权威 open 路径（跨来源
  切 shell + 打开会话；经 SidebarRoot 守卫回调——拖拽尾随 click 抑制 + 同会话内联
  重命名保护）；**移除 = 已读/pending 解除的投影驱动结果，从不乐观、与列表可见性
  解耦**——点击即跳转，不做自动展开/滚动（不触碰共享折叠偏好）。设置新增 chamber
  全局 `sessionTodo` 嵌套块（主开关 + 完成/提问/审批三类事件开关，**默认全开**——
  被动呈现非打扰，与通知默认关不同）；通用页新组「会话待办区」
  （`session-todo-settings.ts` 镜像助手 + `settings-store.ts` 乐观 overlay 嵌套合并
  扩展 + zh/en i18n）；desktop store/preload/renderer 三处类型镜像（preload↔renderer
  由 ipc-surface-mirror 守护；desktop store 手工镜像，同 notifications 纪律）+ main
  applySettingsPatch 嵌套 deep-merge；sidebar `shared/todo-prefs.ts` 只读订阅（未水合
  回落默认）+ `todo.*` zh/en 文案。自动化覆盖：desktop chamber-settings 用例、
  settings-bridge session-todo-settings/settings-store 用例、sidebar
  todo-attention/todo-prefs 用例。
  **剩余实机门禁**：运行级验收——通用页开关即时生效、同源/跨来源/未常驻跳转与权威
  移除、折叠来源中目标会话、断连→重连条目重现、rail 不渲染、「还有 N 项」展开/收起
  与自动收起、展开后内部滚动（8 行上限）、拖拽尾随点击不误开、同会话内联重命名期间
  点击不打断、打包态。
- **VS Code 深链 + open-in（设计 16/20）**：剩余 macOS 深链冷/热启动、打包态、
  托盘/退出在途、N-ctx、VS Code 缺失、`sshPort != 22`、Finder 下拉在 vendor
  会话头部的定位/层叠，以及远程来源仅 VS Code 的实机验收。
- **Git Worktree 插件（设计 08）**：M4 尚余真实远程 Linux + Git 仓库端到端
  验收（首次 ready-time seed 后重启生效、并发 session 删除竞态、Git LFS/filter
  提示与恢复边界）。
- **远程实例插件管理（设计 13）**：本地 `dsh plugin` / `pnpm pack` 仍依赖
  `resolvePnpmBinDir` 对 PATH、nvm、volta、homebrew 的 best-effort 探测；需打包态
  实机验证。
- **桌面端更新（设计 11）**：feed 隔离与 beta 版本自锁已实现（stable 仅
  `latest*.yml`，beta 仅 `beta*.yml`；仅 canonical `X.Y.Z-beta.N` 自锁 beta，
  `alpha`/`rc`/其他 prerelease fail closed；发现失败不调用 updater 或回退 stable）。
  剩余：用真实 Apple 凭据跑通一次发布 CI、Developer ID 签名/公证/stapling/
  Gatekeeper 验证，以及双平台检查、确认前不下载、下载后退出安装。正式 macOS
  发布缺凭据会在 Release mutation 前阻断；凭据或签名/公证无效会阻断 draft 公开
  finalize。只有 `dry_run` 允许 ad-hoc mac 构建（无条件清空签名/公证环境与
  `GH_TOKEN`，不创建/修改 Release、不上传产物）。
- **会话创建/fork 侧边栏收敛延迟修复**：剩余本地 + 远程 SSH 实例实机验收
  （行出现延迟、状态图标延迟、位置跳动三类症状）。
- **移动端 Web 访问面（design 17 §18，2026-09 提出 / 2026-12 随编排面剥离修订）**：
  **P1 实现已落地（2026-12）**：`packages/dsh-chamber-client-ui-mobile`（移动适配
  插件本体——触屏档抽屉化布局/44px 触控/safe-area/设置全屏/弹层限宽/输入行单行、
  回车换行与 editability 恢复行为层、layoutFacts 双源驱动的抽屉滚动锁（gateway 官方 ui-layout 回退属性观察，§18.4 项 3 部署例外）、shell.overlay
  汉堡+backdrop；零代码复制、按 v0.1.2-alpha.3 基线重写；typecheck/29 测试/
  构建全绿）+ `dsh-chamber-client-ui-layout` fork 订阅面（`ctx.layoutFacts`：
  getLayoutSnapshot/subscribeLayout，回归全绿）+ gateway 接线（build.mjs
  host-packages 拷贝、seedFiles 含 lib/client.js、UA 分流开关默认关闭——
  `--mobile-ua-redirect`/`--mobile-entry`，13 个 UA 用例 + 4 个 config 用例全绿，
  test:gateway 全绿（fail 0，含 13 UA + 4 config + build 产物断言））
  **P1.5 已完成（2026-12）**：IME 恢复完整五层（程序化 focus 丢弃循环/
  editability 翻转/pointerup 手势 refocus/visualViewport 键盘判定/键盘钉住）、
  composer 30s busy 自愈、共享 layout source（滚动锁/Esc 单实例）、
  职责区分显式化（§18.2 管理面 vs 适配面矩阵——认证/凭据/会话边界/UA 分流/
  登录流转为 gateway 独占，插件零认证引用已 grep 验证）。
  **移动适配轮（2026，mobile-adaption 工作树，实机门禁 §18.6 项 2）**：
  会话头三轴适配已落地——汉堡 gutter（`conversation.session.header` 出口
  直接子结构 `> header` padding-left，覆盖 titleRow 与 tab 行）、crumbs
  换行不裁切（官方 nowrap+overflow hidden 静默截断标题链/「N 个子代理」
  谱系 chip）、「Session 日志」导出胶囊手机档 44px 图标化（markup.ts 按
  官方双语文案+下载图标打标 `data-mobile-dismiss="session-log-export"`，
  幂等且剪枝搜索不遍历聊天滚动体）；抽屉导航两条行为补丁——iOS 合成
  click 抑制自愈（`drawer-taps.ts`：稳定 tap 的 pointerup 后 120ms 宽限内真实
  click 未达则重发非受信 click，单击即切换；平移/表单/抽屉外不触发）+
  导航后不弹键盘（IME layer-1 gesture 判定改为导航区语义：仅抽屉/会话头导航手势丢弃回焦，
  seat 内手势、发送键、鼠标/硬键盘与 portal 选择器流程保留输入意图）。
  设置页手机档整页适配同轮落地：官方壳（800px flex-row、188px 竖排 nav
  rail）改全屏堆叠——panel `flex-direction: column`、nav rail 变顶部横条
  （标题+横向滚动分区 chips）、Close 固定（P1"整列滚动"会让 Close 滚出屏，
  已收回到 options 区滚动并补底部安全区）、Models 行 4 列 grid→2×2 与
  Plugins inventory 两列卡片→单列（官方内部格子无稳定属性，两处启用
  `[class*="_<local>_"]` 哈希不敏感局部名匹配——命名翻转 fail-soft，
  属记录在案的例外锚点族，与 `[class$=_…]` 后缀契约同待实机固定）、
  其他 aria-modal 弹层限宽 100vw-24px、弹窗内可编辑字段套用 composer
  16px 聚焦缩放底线。
  **Review 轮加固（2026，四路独立 review 后执行，typecheck/test/build 全绿）**：
  抽屉自愈防双激活（愈合后 150ms 内同坐标受信 click 抑制；起点按 pointerId
  跟踪并响应 pointercancel；contenteditable 任意非 false 态均排除）；会话头
  胶囊打标补晚挂载路径（`isStructuralTarget` 有界 4 跳祖先走查——frame > col
  > conversation outlet > .root > 会话头出口可达，聊天滚动体 ≥6 跳仍过滤）；
  拖拽把手死规则替换为官方属性锚点（`[data-width-handle]` /
  `[data-side]:not([role="tooltip"])`），清理已证伪的 `[class$="_titleRow"]`
  死规则并刷新样式表头部旧锚点声明。
  **五合并复审加固（2026-12，合并后 multi-agent 审查轮，typecheck/test 全绿）**：
  抽屉自愈单击清除改**双向判定**——真实 click 落在 pointerup 目标或其子树上
  清除 pending，落在其**祖先**上同样清除（iOS 把迟到的合成 click 重定向到
  down/up 目标的最近共同祖先，hover-reveal 位移后祖先点击已冒泡激活行，不再
  由 heal 双激活；`shouldClearPendingHeal` 纯谓词化 + 边界单测）；heal 起点
  防漏——pointerdown 起点也须在抽屉内（backdrop 边缘 12px 内起手滑入的 tap
  不得叠在 backdrop 关闭动作上 heal）；晚到受信 click 抑制窗判定抽为
  `isSuppressedLateClick` 纯函数并补边界用例（负时间/超窗/超 slop）；
  IME layer-1 输入意图收紧为**仅 composer seat 内 pointerdown**（导航后 500ms
  窗口内消息区滚动/点按既不再被当作输入意图、也不再取消进行中的导航回焦
  丢弃——「切会 + 快速滚动」子场景不再弹键盘；seat 内手势/发送键/鼠标与
  硬键盘输入意图保留，picker 流在键盘开启态不受影响）；breakpoints 测试
  锚点收紧为 `selector {` 定位（前缀假阳），常量钉改名并标注 device-gated；
  anchor/产物注释刷新（rc.1 复核注与 `[data-side]` 审计注）。
  **剩余**：实机门禁（§18.6：真机抽检——触控目标比例/抽屉开合/弹层不出屏/
  键盘遮挡/安全区；本轮新增：汉堡不重叠、crumbs 换行、Session 日志图标化
  可点、iOS 单击切换生效、切换不弹键盘且输入意图焦点不回归、设置各分区
  手机档走查——顶部 chips 可达/Close 固定/无横向溢出/输入聚焦不缩放、
   刘海横屏左右安全区、深层谱系标题高度、composer 工具栏遗留死规则
   （`.row/.trigger` 后缀）、composer 覆盖层自愈增强（周期扫掠/遮罩中和，
   Yui 模式）、layer-3 聚焦态+键盘关同击分支、769-1023 粗指针弹窗带、
   设置 chips 尾项可窥/换行、抽屉行点击不自动关闭的 UX 复核（社区
   one-tap-close 预期）、自动聚焦弹层搜索框）；
  P2（PWA
  安装 + SW 壳离线，per-instance scope，尊重官方
  "不完整离线"立场）；**0.1.2-alpha.4 DOM 锚点重审计**（布局壳部分已执行：
   双 pin（a3=dd6322d6 / a4=4e84901e）的 ui-layout **AppFrame 组件源码逐字节一致**
   （组件级 git diff 空；ui-layout 包内另有 AppFrame.module.css 纯视觉边框微调，不影响锚点）；审计发现 **details 打标缺口**——官方 details 列壳自首帧常驻、其
  `[data-slot=details]` 出口按会话门控后挂，观察器原谓词漏"出口挂入常驻列壳"
  （frame 孙级挂载）→ **已修（2026-09）**：(a) 谓词补孙级分支（markup.ts
  `isStructuralTarget`）+ (b) frame 属性观察双保险（`data-sidebar-collapsed`/
  `data-details-collapsed` 变更→重打标，独立通路；**其接线仅实机可验**——单测无 DOM 观察器基建，只覆盖纯函数谓词/批决策）；谓词/批决策纯函数化，
  markup.test.ts 补 boot 空壳 + 晚挂载回归用例；代码注释与 README 出处已刷新为
  a4。缺口定性：潜伏（官方当前无可达的 details 打开路径——`panels.details`
  默认 0、`openDetails` 注入面为死代码、官方 ui-layout spec 仅证 details 为 session scope 且无 UI 消费方；
  手机 <996px 让步链上开不了；恒关时打标/不打标视觉等价），非 a4 回归（自插件
  首提交即携带）。**剩余**：`[class$=_…]` 后缀选择器命名契约的测试固定、
  composer 锚点 fixture 化、Android 键盘盲区真机门禁（`interactive-widget=
  resizes-content` 下 visualViewport 键盘判定恒 false——IME 层 1 可能关掉发送后
  刚开着的键盘，iOS 不受影响，§18.6 项））；P3（公网认证流转正式化、Web Push）。先行形态 =
  内网/可信网络（`--no-auth` 显式可信网络或 tailscale）。契约：§3 装配矩阵 +
  §10 项 2 的移动例外——`dsh-chamber-client-ui-mobile` 是唯一随 gateway
  发行物打包 seed 的 chamber 客户端插件（链路无桌面，不参与 `/chamber/plugins`
  桌面同步）。
- **认证服务端 Gateway（设计 17）**：自动化与打包面已完成，剩余发布前实机门禁：
  - 生产 TLS 反代的 Host/Origin/XFF/Secure-cookie、HTTP/WS 一致策略与 SPKI pin
    正/负例；真实 dsh 的 `/api/remote.mux` 断线恢复和插件 bundle；
  - 打包 Desktop 的三种代表形态（HTTPS+凭据、HTTP+凭据、显式可信网络
    `--no-auth`），重启后 safeStorage 解密/密码重登、凭据变更撤销 live stream、
    N-ctx 与完整 gateway runtime 管理面；
  - `/chamber/runtime` 在生产 TLS 下的 SSE/poll/auth，以及真实版本安装→探针→
    故障回退→DSH_HOME 恢复；
  - Linux 真实 system/user service 与 foreground 安装升级：目标版本/新 boot identity
    健康证明、restart 失败回滚、local/global artifact 回退及凭据/env anchor 保留；
  - `--bind 0.0.0.0` 带凭据/显式 `--no-auth`、SSH 隧道回环、tailscale 等可信
    网络形态的全链路及 401/421/403 负例。
  - **运行时凭据管理（design 17 §7.4）**：自动化面已完成（v2 凭据信封、
    `/auth/change-password` `/auth/change-token` `/auth/credentials`、stateDir
    独占锁、`gateway auth` 停机态 CLI、`/chamber/` 凭据面板与 S25 不变量，2026-09
    全量修复轮已完成）。**剩余**：desktop settings-bridge 便捷重置（Phase 4
    推迟项）、真实 TLS 反代下改密/轮换/停机态 CLI 恢复的实机门禁。
  - **http 连接链路修复（S0/S2，2026-09，本地单测全绿，待实机部署验证）**：
    - S0：gateway 代理出口对托管 dsh 的 HTML 注入 `__DSH_TRANSPORT__.ownsHost`
      （上游文档化钩子契约），解除官方设置页在非 loopback 页面上的
      memory 持久化门控（"settings are unavailable in this browser"）——网页直连
      settings/models/插件可用；**2026 audit 勘误：design 17 §10.5 已含 S0 全文
      （≤64KiB/identity/fail-soft/钩子契约），本行「文档待同步」已过期**；属
      "能登录即受信"的信任边界决策（auth 门在先，非鉴权绕过）。
    - S2：control-plane 对**非 loopback 上游腿**（direct-http(s)，含 gateway 与
      dsh 两种 kind；判别轴为解析后目标的 host 而非来源 id——ssh 隧道恒为
      loopback 本地腿）启用 OS 级 TCP keepalive（30s，对齐 ssh
      `ServerAliveInterval` 语义）；renderer staleness 看门狗对
      **transport=http 来源**（registry spec 判别）的静默 mounted 推送触发轻量
      `connection.reconnect()` 自愈（staleness 120s / 退避 60s；mounted=本代曾
      推送；不作用于 local/ssh 隧道来源）。稳态代价如实记录：健康空闲
      direct-http 来源约每 2 分钟一次轻量连接重连（依赖撤稿→重发链刷新
      新鲜度；链不浮现则退化为退避门 ~60s），真死 channel 自 stale 后每
      ~60s 重试一次——均为治愈冻结局的固有取舍（App 层无法区分冻结与
      空闲；活跃来源不受影响）。
    - S2-c：调宽 dsh 2s/2miss mux 心跳为可选增强，**未实现**。可行性已确认：
      补丁层格式本就支持 id-targeted config override（既有
      cordis.patch.yml 机制，desktop plugin-sync 保留用户行；形如
      `{id: typert-gateway, config: {websocketHeartbeatIntervalMs}}`，
      匹配不到 warn+skip）——但 chamber 代码零引用 typert-gateway id，
      需先扩展 gateway 的 patch 写入器，故单列。
    - **剩余验收**：打包态实机——浏览器直连 gateway 的 Models/插件设置可写；
      杀托管 dsh / 断网注入后 sidebar 60–120s 自动恢复；升级 dsh 版本复验
      （`__DSH_TRANSPORT__` 钩子与 typert-gateway id 跨版本存在性）。

## 设计未决（02 §5 / 04 §7）

- **起始端口偏移**：本地默认 17510、控制面默认 17500；当前固定起始端口 +
  P+1 重试 + 记录仲裁，是否开放配置仍未决。
- **trusted-host 自定义 Host**：当前反代 Host 与实例自身
  `127.0.0.1:<port>` 一致；未来引入自定义 Host 时须同步扩 trusted-host 集。
- **多控制面 `$DSH_HOME` 冲突**：同 stateDir 共享 home 时会话 JSONL 可追加，
  settings 由 dsh 的 `settings-conflict` 仲裁；是否进一步隔离未决。
- **多控制面 catalog metadata 无跨进程 CAS**：runtime status/dshPort/error 已完全移出
  catalog，消除了高频 stale lifecycle 写回覆盖；但两个进程同 stateDir 并发修改
  label/accentColor 仍是 last-writer-wins。可靠保持多 writer 需要 kernel-backed、
  跨平台 lifetime/document lock + 锁内 reload + 字段 intent；若不引入该能力，则需正式
  改 design 02 为"并发 plane 必须不同 stateDir"。普通 pidfile/mkdir stale lock 存在
  三方 takeover 双持，不能作为修复。
- **响应头白名单双处同步**：权威在 04 §4.3，仍建议把代码/文档表述进一步
  单源化。
- **`__DSH_BOOT__` 随 dsh 版本漂移**：manifest 形状继续以 vendor
  `parseBootManifest` 为准维护。

## 范围决策与剩余偏差（不做 / 推迟 / 移出）

- **`--no-auth` 是醒目的可信网络有界例外**：Gateway 外部部署默认必须认证；
  只有服务器显式传 `--no-auth` 才可覆盖，启动器二次确认并打印安全告警。它不是
  静默 fallback，也不授权普通匿名 control-plane 绑定公网。
- **Gateway state 根目录自动收紧（2026-09 用户决策）**：`createGatewayStore`
  对既有 `stateDir` 由 fail-closed `require 0700`（启动崩溃循环）改为经 pinned
  no-follow 描述符自动收紧到 `0700`，并新增属主 uid 校验（异主 fail-closed）；
  broad root 拒绝与 Windows 继承 ACL 让步不变（17 §12 目录边界、§17 S15）。安装器同步以
  0700 创建 `~/.dsh-chamber` 全部自有目录。
- **safeStorage 的诚实回退**：Gateway token/密码优先 safeStorage；OS 加密不可用
  时按用户决策回退 target-bound 0600 明文文件并在非秘密投影/UI 中如实显示，
  不把 plaintext 冒充密文。SSH 密码仍采用 endpoint-bound 0600 明文镜像。
  **Windows 分支例外（design 23 C16）**：win32 上 DPAPI（safeStorage）不可用时
  拒绝明文落盘——凭据仅本次会话内存驻留（file=null），每次连接需重录；S22
  明文兜底仅适用于非 win32 平台（0600 语义在 Windows 不可诚实表达）。
- **Windows 发布身份让步**：Windows x64 安装包当前未做 Authenticode 签名，
  SmartScreen 提示是已知取舍；update feed 的 sha512 只证明下载完整性，不等价于
  发行者签名。
- **N-ctx 单文档信任域**：连接一个远端实例会让其前端代码与同一 renderer 文档内
  其他实例及高权限 preload bridge 共域。现有 main-frame/origin/proof/主进程确认
  只能缓解，真正横向隔离推迟到每实例独立 WebContents 架构。
- **移出项**（P3 硬纪律）：匿名 control-plane 的认证/审计、薄壳聊天/会话列表/
  审批弹窗、控制面会话 runtime/统一索引、连接 broker/绑定、walkthrough、通知中心/
  历史、MCP、文件夹/笔记、web 预览、目标/终端等不得回流。设计 17 的独立
  Gateway 认证/派生编排、设计 18 的共享 dsh 运行时核心、设计 19 的 Electron 原生
  边沿通知、设计 08 的实例内 Git 插件和设计 20 的可信 open-in 边缘能力是边界明确的
  例外，不得泄入匿名 control-plane、引入 session 消费者/通知历史，或变成第二套执行面。
- **不做（v1）**：跨来源移动会话、单 store 真融合、控制面会话实时同步、远程
  实例管理 UI 外壳。
- **推迟**：flat 单列表模式（与"仅按来源分类"呈现原则有张力）。
- **设置壳偏差**：未连接实例不装配子 ctx；stub remote 无 WS 失效流；壳不渲染
  官方 SettingsRoot、子 ctx 懒装配；服务器选择器使用 body portal + viewport
  翻转/钳位与内部滚动；离线远端仍可选并显示不可达占位与连接管理动作；chrome
  跟随宿主 locale，子 ctx 跟随目标实例 locale。
- **默认排序 `manual`（06 §3.1）**：按 wire 顺序，与官方默认 `updated` 不同，
  是有意产品取舍。
- **窗口标题冻结**：桌面原生标题固定为 `dsh-chamber`，会话名只在应用内呈现。
- **Electron 二进制惰性安装（每机器共享 dist）**：根 postinstall 默认跳过，仅
  `DSH_CHAMBER_ELECTRON=1` 或 `dev:desktop` 首启按需物化到平台缓存共享 dist
  （macOS `~/Library/Caches/dsh-chamber/electron/v<版本>-<平台>-<架构>/` 等，逻辑见
  `packages/desktop/scripts/electron-shared.mjs`）；worktree 并行开发共用同一份，
  不再每个 worktree 下载/解压 ~300MB。Gateway/control-plane/CLI 不携带 Electron。
- **dev 实例隔离**：dev 使用独立 `packages/desktop/.dev-user-data`；控制面端口从
  17520 起自动退避到首个空闲端口（`DSH_CHAMBER_CP_PORT` 可固定覆盖，退避区间
  全占时回退系统临时端口），多个 dev worktree 可与打包版的 userData/17500 共存。

- **dsh 运行时设置面统一（2026-12 实施，登记契约变更与残余偏差）**：两分支同构
  UI——彩色状态徽标（正常/检查中/下载中/安装中/待应用/应用中/回退中/重启中/切换失败/
  快照失败/恢复受阻/启动受阻/操作失败/错误/元数据异常，四色）取代「已是最新/可用更新」
  claim 文案；快照+磁盘占用移至「版本源」块下方段尾事实块（plan 24 D6-A）；registry 只读行+编辑态统一；常驻
  「清理已安装版本」入口；gateway「部署锚」口径。desktop env/只读平台放行「重启 dsh」
  （design 18 §3.6 落地）。gateway 新增 `cleanup-version` / `restore-pre-rollback` /
  `recover-metadata` 路由、FATAL blocked-alive（不再进程级拒启，status 可轮询 +
  救援路由）、status 的 metadata 健康投影（metadataHealth/metadataComponents/
  canRecoverMetadata）、store-prune 标记消费（消除 10GiB 软上限死锁）。
   plan 24 round（2026-12）：磁盘行改「运行时占用」+ D1-A 真实字节口径（`runtimeDiskSummary` 整树一次
   walk、`(dev, ino)` 去重消除硬链接双计 + `unclassifiedBytes` 未分类残留桶，total = Σ分类含未分类；
   APFS reflink 近似边界登记）；「当前状态」h4 与 `dshRuntimeGroupStatus` 键、「选择版本」字段 label
   移除（select 走 aria-label，键保留）；快照说明句删除、数值 12px/600 加粗、行距收紧；失败现场
   清除入口仅本地（`dsh-chamber:runtime-clear-failure` trustedIpc + 共享核心 `clearRuntimeFailure`；
   gateway 无对应清除路由，偏差登记）。
  残余登记（有意保留）：desktop SETTINGS_SET 在 env 下允许更换 registry（设计文字
  禁，代码行为有意更宽）；~~restore-builtin × restore-half 逃生集 desktop 更保守
  （先 retry-restore）而 gateway 沿用设计允许集~~（**2026 audit R2 修订**：gateway 恢复期
  已与桌面对齐收窄——swap-attempted/snapshot-failed/restore-blocked/FATAL 只开放各自
  retry 与 recover-metadata，restore-builtin 仅限 pending/健康选择；原因：共享核心对
  armed reset 在持久恢复标记下必然复阻，旧矩阵格不可执行且失败会残留 armed reset
  intent 劫持后续 retry 语义）；registry 白名单形状 desktop
  https-only、gateway 允许 http-loopback（共享 canonical 更宽，桌面层收紧）；
  desktop 15s+6h 周期检查不移植 gateway（避免周期出网；进页拉取 + 手动检查）；
  gateway 组件级交互仍以纯函数/API 客户端测试代证（原实机门禁项维持）。

- **「内建版本」行引导（2026-12 用户决策，方案 2，登记桌面本地分支）**：下拉
  选中与随应用内建同版本的行且该版本尚未装成受管树（无 cached 树）、存在用户
  选择（hasOverride）时，主按钮从「更新/切换到 vX」改为引导「恢复内建」（清除
  用户指针回到随应用副本，零下载；树/快照保留）；「仍下载并安装为受管版本」
  保留为显式次要动作。避免把随应用已含字节重复下载成第二棵受管树的同时，不
  剥夺受管树语义（回滚/快照/清理台账、独立于应用更新）。已缓存（曾装树）时
  保持普通切换不变。gateway 分支（部署锚）已按同款条件镜像（2026-12 全面
  统一：选中与内建锚同版本行且未装受管树 + hasOverride → 主按钮「恢复内建」
  = restore-builtin 事务，仍下载并安装为受管版本为显式次要动作；恢复行按钮
  在引导态隐藏避免重复）。

- **2026-12 review 轮次修复与登记（设计 18 §9.3 配套）**：① FATAL 启动块下所有普通
  mutation 拒绝（路由 recovery-gate 增 startupBlockedReason 门，仅放行各自恢复面）；
  ② FATAL×stale-pending 相位投影为 idle+startupBlockedReason（恢复面不被 pending
  门锁死——**2026 audit R3 勘误**：原登记「canRecoverMetadata 与路由可达一致」不成立——
  路由 gate 在 blockedReason 分支放行后落穿 pending 门，recover-metadata 曾被 409
  runtime_pending 拒、restore-builtin 又被 block 分支拒 → 恢复面全锁死；R3 修复为
  block 分支 allowed 即早退 return null（block outranks pending，pending 分支仅
  blockedReason===null 时生效），fake 与 real manager 两层测试补钉）；③ boot 前 `metadataRecoveryPending()`
  预检——引擎归档元数据后 gateway 重启不再绕过探针门直接以内建服务 DSH_HOME；
  ④ recover 成功后 resume-start 失败转入 `metadata-start-failed` 哨兵（可重试）；
  ⑤ store-prune 标记在 boot 边界消费（desktop 同款语义）；⑥ 徽标/registry 编辑复位/
  versions 内嵌 error/恢复行 window.confirm/blocked 原因行等 review 项已修。
  登记（有意保留）：desktop main.ts 的 RUNTIME_RESTART 等 handler 内联无单测
  （renderer 镜像 + lockstep 代证；**2026 audit 勘误**：非「抽取纯函数排期」——apply-now
  门已抽为 apply-now-gate.ts 且有测试，其余 handler 内联仍无单测）；env×FATAL（dormant
  corrupt selection）预路由 `shouldProbeEnvWithDormantCorruptSelection` 为 desktop 独有
  （gateway env pin 经共享核心 env-override 分支等效处理；**A-U2 已补**：gateway env-override
  启动现跑激活探针门，失败 → `env-probe-failed` 停机阻塞，见下段 audit 块）；
  `status()` 的 metadata health 检测无缓存（小文件读；**磁盘投影已有 30s TTL 缓存**——
  DISK_CACHE_TTL_MS，原「TTL 排期」措辞仅指 metadata health，范围限定）；metadata
  恢复期 pnpm prune 子进程不可 abort（退出延迟登记）。

- **settings/connection 插件管理面 UX 重构已落地（2026-12；原「插件管理面 UX 重构」todo 已落地并移出目录）**：P0 文案/空态修正（方向词、空态范围注、未配置服务常驻提示、重启未配置事前警告、版本冲突横幅指引）；P1 ssh 默认视图与 gateway/local 同构、legacy diff 折叠为对账次级入口（design 21 §10 已登记偏离：纯层与后端行为不变，仅默认呈现改变）；P2a 插件入口自绘语义图标；P3 术语收敛（入口=管理插件、chamber 受管组件）。范围：仅 settings-connections 渲染层（PluginDialog/ConnectionsSection）与 locales 文案键值，纯层/IPC/域 deny 零改动。门禁：typecheck:connections、test:connections 已本地通过；build:renderer 由 CI/发布链路执行。

## 2026 分域一致性审计（desktop vs gateway，5 域 60+ 项）验证与修复轮

> 对审计清单逐条只读复核（A/C/B/E/D 五域独立核验 + 主代理抽验），18/19 项 A-F、
> 14/15 项 C-F、13/13 项 B、9/9 项 D-1..D-7、10 项 E-1..E-17（E-5/E-7/E-17 由主代理
> 复核）与清单相符（PARTIAL 6：A-F4/C-F2/D-6 措辞/E-2/E-8/E-13 精确化）。本块登记
> 「修复了什么、确认属实但按现有登记收口、新登记开放项」。验证与测试计数见各条目。

**已修复（本工作树，测试绿；详见 CHANGELOG 待并入）**
- E-7（P1，高）：desktop plugin-tarball.ts 核算改为与 gateway tgz-scan 完全同式
  （512 头 + padded 数据 + 1024 端标记预占），消除「desktop 放行、网关 400 too_large」
  ~254–256MiB 窗口；新增 2 回归测试（含真实调用 gateway scanTgzMetadata 的跨形状
  一致性断言）。desktop plugin-tarball 15/15。
- A-U1（P1，中）：共享核心新增 `pruneRuntimeSnapshots` 组合（cleanupSnapshotArtifacts
  → retention → pruneSnapshots，blocked-marker/retention-corrupt fail-closed 语义内聚）；
  desktop main 收敛为栅栏 + 组合调用（行为不变）；**gateway runtime-manager 每次启动
  事务尾部（boot/apply-now/restore-builtin/F7 全经 executeStartupTransaction）执行同一
  组合**——gateway 从此有快照保留裁剪（keepRecent 3），不再无上限累积。snapshot-store
  32/32（新增组合测试）、runtime-routes 103/103。
- A-U2（P1，中低）：gateway env-override（DSH_GATEWAY_DSH_PATH）启动不再直接归一
  健康——现于 executeStartupTransaction 内对 env 运行时执行激活探针门（hostDomains
  shape gate 与受管树探针同款），失败 → `env-probe-failed` 停机阻塞 + 状态投影 +
  index.ts 组合边界处理（无恢复路由：修 env 目标后重启 gateway）；2 新测试。
- E-5/E-17（P1，高）：会话信任链常量收敛到 control-plane 新单源
  `gateway-session-protocol.ts`（cookie 名/TTL 12h/cookie 值 4096/Bearer 32–4096
  visible-ASCII/密码 12–1024）+ `spki-pin.ts`（SPKI 探针/转发双消费方单源，desktop
  双份副本删除、经 dual-path facade 引用）；gateway auth/config 与 instance-proxy 门
  全部改引共享常量（本地名保持别名）。跨侧漂移由导入关系机械消除。
- A-U4（P3，低）：gateway restore-builtin 补 hasOverride 前置
  （`runtime_no_override` 409，无 override 不再制造无谓停机+快照）+ 路由 recovery-gate
  （FATAL 阻塞时 restore-builtin 回到 recover-metadata 面，与桌面 blocked 面一致）。
  **R2 扩展（2026 audit 第二轮复审）**：恢复期矩阵进一步与桌面收窄——swap-attempted/
  snapshot-failed/restore-blocked 相位及对应 phase-less blockedReason 只开放各自 retry
  （route gate + manager 直调双重收口：manager.restoreBuiltin 前置守卫覆盖 durable swap/
  snapshot 标记、restore marker、journal/pointer/override corrupt 与内存块，任何 stop 或
  intent 写入之前拒绝）；manager restorePreRollback 'complete' 分支仅当 resume 判决干净
  才清块（restore-pre-rollback/retry-restore 的 env-probe-failed 或 FATAL resume 判决不再
  被吞）；env-probe-failed 路由拒绝文案给出显式无恢复路由指引；新增 3 回归测试
  （durable guards / env-probe-failed resume / gate 矩阵）+ runtime-routes 106/106。
- B-6c：control-plane /health 现接受 HEAD（监控探针 200，与 auth 门豁免注释一致）；
  新增 manager-api 与 public-http 全链断言。
- B-6e：新增 control-plane html-inject-lockstep 测试（64KiB 双常量文本锁步）。
- B-6a/6d/6f：dispatch/middleware 失效「§11 S14」引用改自述；gateway config.ts 删除
  死字段 channels{direct,ssh}（类型+赋值，零消费者零断言）；/api/i/local 双路同达 +
  远端 id 恒 503 结构事实补注释（含两路 CSP/注入文档面不等价注明）。
- C-F4：desktop_local_plugin_add_file 现传 allowFileSpec:true——本地文件夹直装可用
  （设计 21 §10 缺陷①闭环；渲染层提交通道仍拒 file:，安全边界不变）。
- C-F5：删除 `{ok:true,cancelled:true}` 死成员（PluginApplyResult2/SshApplyShape/
  SshSeedHostGraphResult 及对应死分支与测试断言；ssh undo/local add-remove/materialize
  pick/gateway apply 的真实 cancelled 保留）；ipc-surface-mirror 增补
  SshSeedHostGraphResult 漂移护栏。
- D-2 部分：gateway 浏览器运维页补「Start dsh」按钮（RUNTIME_PATHS.start；门控镜像
  服务端 /start 路由 stopped/error/restart-exhausted + 非 blocked），消除停机态
  Restart 409 死胡同文案；dashboard 仍为独立第三份运行时 UI（不共享 sidebar 核心）
  ——共享核心迁移登记为开放项（下）。
- D-3：ambient RemoteRuntimeStatus 注释 30→33 字段；settings-bridge 的
  ChamberServerAggregate workspaces 镜像补齐 `synthetic?: boolean`（2026 audit 复核：
  renderer vendor-modules.d.ts 与 git ambient sidebar-shared.d.ts **早已含**该字段——
  commit 874df40；settings-bridge ambient 是最后补齐者，无遗留待补镜像）。
- D-4/D-5：settings-connections 'connections'(order 30) 宿主 ctx 死注册分析落注释
  （固定 '__connections' 直渲，未来宿主 ledger 渲染路径出现即双份，届时删注册）；
  DshRuntimeSection 多用户中断文案归口注释（CS 卡 Modal 为准）。
- A-F1/A-F13：4 元 FATAL 阻塞集收敛 dsh-runtime `FATAL_STARTUP_BLOCK_REASONS`
  （desktop main / gateway index FATAL_RUNTIME_BLOCKS / manager RECOVERABLE_METADATA_BLOCKS
  同源）；10GiB 磁盘软限收敛 dsh-runtime `RUNTIME_LOGICAL_DISK_LIMIT_BYTES`（两 owner
  常量名保持为别名导出）。
- 文档纠偏：design 21 §1 决策 18 与 §2.3 陈旧段（ssh 已掩码、PIV 非只读、gateway add
  入口缺失为开放项）、§6.9/plan 4.2 的 blocked 上限 5min → 120s（CAN_RUN_WAIT_MAX_MS）；
  STATUS S0「文档待同步」与 RUNTIME handler「抽取纯函数排期」过期措辞修订。

**新登记开放项（核实属实、未做行为修复或归口后续）**
- **R3 遗留登记**：~~运行中静默损坏（无内存块/boot 判决）时 status() 将 resolveWorkspace
  自由文本投影为 startupBlockedReason——gate 视其为未知 sentinel 全路由 409（含
  recover-metadata），重启 gateway 可恢复~~（**2026 audit R4 修订**：路由 gate 现按
  status 的权威 canRecoverMetadata 归类——漂移态 recover-metadata 可达（200，探针 +
  108 测试钉死：real-manager 中运行 current 损坏 + route recover 200 并治愈），其余
  mutation 409 且文案指向「only recover-metadata is allowed」；无恢复面提示的未知文本
  保持 fail-closed 并加「restart the gateway if this persists」指引）；并发 retry 撞在途
  事务时 runtime_pending 文案误导（拒绝对、文案属罕见竞态，登记）；三 UI 面与 R4 门对齐
  （见 R4 登记块）。
- **R4 复审修复与登记（第四轮全量复审，两代理零 MAJOR 复证、一代理 2+1 已修复）**：
  F1——恢复相位线上与 startupBlockedReason 共投影，sidebar 镜像/dashboard 曾把共投影
  reason 再折入 retry 禁用（匹配 retry 死钮）：retry 门改用 phase 为权威选择器（仅
  busy/env/read-only 禁用），测试补共投影夹具（swap/restore/snapshot 相位 retry 开启）；
  F2——FATAL 元数据块的 recover-metadata 行曾被 mutationDisabled 恒禁：新增共享门成员
  recoverMetadataDisabled（canRecoverMetadata 时开启），settings 行改用该成员，dashboard
  无 recover 控件（登记表面缺口）；M1——plugin-diff UI 分类器补 x-wildcard 拒绝（与主
  进程 plugin-sync 同语义 + 钉值测试）；UI 矩阵逐格复核对齐（pending 逃生、FATAL+pending
  全禁仅 recover 开、env-probe-failed 全禁）。登记项：connections 卡 Start/Restart 仅看
  隧道+connectionState、恢复相位/blocked 下点亮收服务端诚实 409（既有 over-offer，登记）；
  202 路由跨客户端竞态下同步前缀拒绝不投影 operationError（单客户端 UI 单飞不自触发）；
  codeToStatus 无 runtime_disposed 兜底 500（窄竞态）；pending 拒绝文案未提 apply-now 同
  为逃生口（复制级 MINOR）；dashboard 无 recover/cleanup/pre-rollback 控件（表面缺口）；
  ipc-surface-mirror 仅锁 preload↔renderer（main 侧无静态绑定）；Windows file: 反斜杠
  直装路径无 e2e（响亮 ok:false，无安全影响）。
- C-F6（中）：gateway 第三方「添加」桌面 UI 无入口——PIV 恒 add:[]、materialize IPC
  渲染层零调用；与 design 21 决策 2 冲突（§10 ⑥已有「双面未合体」登记，add 入口
  缺失本块补点名；UI 闭环列二期）。
- C-F7（中）：undo 语义不对称——ssh「撤销=恢复」（remove/upgrade 可恢复、指纹绑定）
  vs gateway v1 undoForLatest 仅最新 ok install→remove；服务端 preImage 备份无运行时
  恢复消费方（§6.8 r2-r4 列二期）。
- C-F8（低中）：GET /chamber/plugins/installed 裸读未入写栅栏（plugins-installed.ts
  自注释承诺随 A1 executor 落地实现；现撕裂读仅 loud 500——修复列入写面后续）。
- C-F9/C-F11：批量容量三档（ssh ≤64 行 vs gateway IPC 20+20/200 字符 vs 服务端队列
  ≤8）与双份常量族（journal 50 双份/50MiB 本地重声明/SEED_FILES 注释名过期/2000B vs
  2048 字符）——逐项核实，无行为修复（登记）。
- C-F12（低）：desktop 本地 plugin add 子进程 env 未 scrub（gateway executor 与共享
  runtime installer 已白名单化）——desktop 侧接线列后续。
- C-F13：readManifest 三后端形状无共享联合（design 21 §3「单一定义」措辞未兑现，
  已核实的模型层挂接路径）；C-F1（掩码常量双份+单向文本锁步）、C-F3（ssh 确认链
  缺口开放项维持）、C-F10 文档已纠。
- E-3（高，P2 排期）：私有文件纪律三实现——cp private-file.ts（抛错式）/ dsh-runtime
  private-fs.ts（kind 结果式）同名 readPrivateFileNoFollow 异签 + desktop 三处弱化
  原子写（固定 .tmp 无 O_EXCL/父 fsync/.bak）；统一路线（cp 版协议下沉共享或 desktop
  收编）未排期，登记防静默迁移混淆。
- E-8（高）：有界输出族值表（journal 64KiB vs 256KiB 系不同工件、同包 deferred 64KiB
  自洽；2000B vs 2048 字符；exec 512KiB vs 安装 64KiB）逐值核实登记，跨侧统一未排期。
- E-4/E-2/E-10（中）：audit serialize/WRITTEN_FIELDS/5MiB 逐字双份（appendAuditEvent
  签名异）；sanitize 四成员语义矩阵（core 删路径段 → desktop 保 URL / gateway 再删
  query、route 注释「not exported」过期已随本块修订；installer 缩到 origin+[redacted]）；
  win-probes/windows-process 孪生互注 sibling-parity、无机械锁步——对拍/锁步测试排期。
- E-12/E-13/E-14/E-16（低中）：状态字面量族零 pin（SshPhase 5 值/NotificationKind
  'test'/12-phase 静态表/metadataHealth 6 值跨 6 包；runtime kind 常量 5 源值同名异、
  routes.ts 模板内内联逃逸常量体系；sidebar instance-api 信封第 4 份无字节 pin；轮询
  数值靠注释互许）——plugin-spec-lockstep 式文本锁步复用排期。
- D-1（高）：PSM 1252 行（wc -l）vs PIV 854 行 9 类重复未合体（§10⑥/本 STATUS「统一单组件
  双后端合体未做」登记维持；PIV sourceId 前缀推导与 runtime-source 原则不同构，
  本块补点名）。
- D-2 剩余：dashboard 不共享 sidebar parse/poll 核心、错误文案双映射——共享核心
  迁移列后续（start 入口本块已补）。
- A-U3（低）：registry 变更门不对称——desktop SETTINGS_SET 无 busy/pending/env 门
  （env 维度有意放行为既有登记，busy/pending 维度未上锁；gateway PUT /registry 全拒
  env + assertNoPending + assertMutationIdle）——desktop 侧门对称列后续决策。
- A-F16（低）：DSH_HOME 布局默认值偏 desktop（userData/state/dsh-home vs gateway
  stateDir/dsh-home）——共享默认注释已言明，新登记防未来共享代码推导点忘传参会错读。
- A-F14/A-F10/F7 等 wire 形状/周期/哨兵差异：均为设计内形态差异，按上列既有登记
  收口（snapshot-failed 两侧同款非阻塞存活补证）。
