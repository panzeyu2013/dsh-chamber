# TODO · 未排期计划与想法

> 本文件只记「未排期 / 未定稿」的计划与想法，**不记进度状态**；进度、验收门与取舍在 [STATUS.md](./STATUS.md)，
> [deviations.md](./deviations.md) = 冻结前的双 flavor 历史登记（Electron 已冻结，不再维护），契约在 `docs/design/`。
>
> **版本范围与冻结清单**：唯一出货 flavor = macOS Swift 原生壳；Electron/Windows/Linux 桌面腿冻结、不发布（本文件相关计划一律标「冻结，不排期」，只在复活时执行）。范围、共享契约、禁用面与复活清单见 [electron-frozen.md](./electron-frozen.md) §1/§6 与根 [`AGENTS.md`](../../AGENTS.md)。
> 四部分：A 上游（A 类）、B 平台（B 类）、C 功能（C 类）、D 工程（D 类）。文中 `§N` 指本部分内编号；
> 跨部分引用写 `A§N` / `B§N` / `C§N` / `D§N`。
> 条目内的「剩余 / 未做 / 待…」是**计划范围**，不是进度状态；状态以 [STATUS.md](./STATUS.md) 为准。
> 新增：先判断阻塞来源；设计定稿移入 `docs/design/0X-*.md`，落地或明确不做则移出并在 STATUS 留结论。

## 索引

|部|内容|入口|
|---|---|---|
|A 上游|§1–§13 上游提案、§14 漂移收口、§15 UI 对齐、§16 pin 升级管线|A§1–A§16|
|B 平台|macOS Swift 壳、Windows v1（冻结，不排期）|B§1–B§2|
|C 功能|账户登录、侧栏 subagents、open-in 超集|C§1–C§3|
|D 工程|结构性重构、产物新鲜度、页面性能 P2、多实例常驻后续研究|D§1–D§4|

## A. 上游依赖（A 类）

> 阻塞来源 = 上游：等 deepseek-harness 落地/裁决或与之对齐；chamber 不等待、不绕过。

### A 部索引（内部 §N = A§N）

|节|主题|触发 / 说明|
|---|---|---|
|§1|N-壳 selection 作用域|上游 scope API 落地；chamber 侧另见 STATUS|
|§2|设置面声明式贡献通道（T3）|其他宿主需要声明式贡献|
|§3|归档 wire：删除 + 可见查询|上游 delete/查询 wire 落地|
|§4|会话事实「静默丢帧」自愈|上游提供自愈/心跳/期限/契约|
|§5|图标资源 id 实例私有|上游两族改用 useId|
|§6|只读观察者与持久 unread/pending|上游提供 observer 角色/投影|
|§7|子代理生命周期/计数与完整性信号|上游提供完整性位/生命周期边沿|
|§8|载波 open 的稳定 episode 身份|上游提供 episodeId 或宿主期限|
|§9|桌面专属家族门按宿主能力|上游按能力门/加载期限收敛|
|§10|bundle rev 由内容派生|上游改内容哈希|
|§11|座席声明可转移|上游声明可委托/页面级座席|
|§12|workspace 删除 order/remove 原子化|上游原子化 order/remove|
|§13|插件管理页可嵌入|上游提供 surface=embedded|
|§14|漂移剩余、待退役块、工程债|打包态/下一 pin|
|§15|UI 对齐候选与维持差异|UI 裁决触发时|
|§16|pin 升级管线自动化|下次 pin 升级|

### 1. N-壳宿主下持久化 selection 需要按 shell/入口作用域

- 事实：选择 store 仍是页面级 `persist: { name: 'dsh.sessions.current' }`（无 scope）；store 工厂已支持 `create(scopeKey)`，
  缺的是调用点传 scope。后果 = A 的 current 被 B 读到、B 校验失败清空共享键；冷 boot 无可恢复会话 ⇒
  `connectWorkspace()` 在远程宿主最近工作区造空白会话。
- 改法：scope 来源 = 每 entry/壳一份（chamber 用 `chamberBasePath`）；持久化名加 scope 后缀；`current === undefined`
  只清自己的 scope。开放 = scope 权威来源、旧单键迁移、是否把会话/工作区 UI 选择整体纳入。
- chamber 现状：design 05 §2.2.1 的 open 意图本地回显 + `early-open.ts` 只抢时间；vendor store 无法根治。
- 退出：上游落地 scope 后删早开臂与本文。

### 2. 设置面的上游声明式贡献通道（T3）

- 三条硬边界：贡献是代码非数据（`dsh.client` 只有 inject/platform）；无设置面服务契约；泛型 Remote 不可行
  （descriptor 无上线通道）。
- 提议：P1 `dsh.client.contributes.settings`（sections/seats/requires）；P2 最小可注入服务集；P3 typert descriptor 目录。
- 退出：完整桥接（design 05 §5/09 §4）不依赖它；其他宿主可参照，上游落地后简化。

### 3. 已归档会话的 wire 契约（根治，对齐 OpenCode）

- 现状：dsh 无 delete-session、无归档可见查询；单条 `workspace.unarchiveSession` 已有；归档集在
  `workspace.json` 的 `global.archivedSessionIds`，投影按 `!archived.has(id)` 排除。
- 需补：`sessions.delete({ sessionId })`（删目录 + 级联子会话 + workspace 账目自愈 + 清 archived，复用
  `host/session-removed`）；可选 `sessions.list` 行带 `archived` 标志/查询参数。
- 退出：上游 delete 落地后 design 24 的清理域退役；浏览区 A/控制面直删 B 见 STATUS。

### 4. 会话事实通道的「静默丢帧」自愈

- 驱动面：`chat.deepDiving` 由 `api-session/status`（emit 型）驱动；emit 无重传、开场帧不重放，唯一收敛
  `handleConnected → refreshList` 只挂连接代际 ⇒ 丢帧/静默半死时 running 永久 true。chamber 用 tier-1.5 本地判定 +
  tier-3 写回把症状确定性收敛，但源端仍丢帧。
- 上游改法：①事实自愈（周期性 summary 或 running 真但 `$events` 静默 ≥N 秒则 `session.list` 对账）；②应用级
  keepalive item（现只有 WS ping/pong，浏览器观测不到）；③`session/follow` 首帧/空闲期限，期限到期写
  `openState='error'`（chamber 单档 30s 只补客户端）；④`refresh()` 显式返回 `{ok,error}`；⑤把
  `listState/listError` 投影进 store 快照；⑥把 `handleSessionStatus` 写进 `ISessions` 契约；⑦把 `openState` +
  在途标志写进 `SessionSnapshot`。
- chamber 现状：tier-1.5 + tier-3（只写 false、写后自校验、无 TTL）；第 1/5/6 落地后可删写回与探针；第 2/3 是正交
  可见面/期限。seed 包再断言 `api-session/status`（只覆盖可 seed 实例、需重启），暂缓。
- 开放：keepalive 的旧客户端兼容（未知 item 会被 `failAll` 关 socket）、隐私/体积、`session.list` 对账成本。
- 退出：上游落地 1/5/6 后删 chamber 写回与探针。

### 5. 图标资源 id 应实例私有（useId）

- 事实（机制与实测见 design 05 §4.4）：仍写死文档级 id 的只剩 `BrandWordmark` 的 whale/badge clip 与附件 `dshDropOverlayClip`；N-ctx 同文档重复定义，WKWebView 首次绘制可能整块失绘并缓存。
- 改法：两族也用 `useId()` 前缀，或 clip/mask 只依赖 viewBox/路径。退出：上游两族私有化后删 chamber 侧 `svg-resource-scope.ts` 的改名缓解与 scope 安装。

### 6. 会话状态的只读观察者与未读事实

- 现状：gateway watcher 需无界面进程观察完成边沿；当前靠 `$events` + 每条边沿一次 `session/follow` 读尾巴。
- 诉求：①`updatedAt` 语义契约（任意 durable 产出推进 ⇒ 可用内容水位判未读；或明确只用户消息推进）；②`turn/end`
  冻结 + 纳入 `API_REMOTE_FORWARDED_EVENTS`；③observer 角色或 `session/list` pending 投影（避免只读方撞瀑布）；
  ④宿主持久 per-session unread/pending 投影。
- 下游现状：权威 = 官方内存 `completionUnread`（重载即忘）；只读镜像协议
  单源 `packages/dsh-chamber-wire/src/session-state.ts`（浏览器经 client-core 具名面），watcher `packages/gateway/src/session-state.ts`。
- 退出：上游 1–4 落地后删 watcher 的补洞逻辑。

### 7. 子代理生命周期/计数与完整性信号（P5）

- 不确定性：没有完整性信号（缺席 = 没有运行中 or 列表不完整）；没有 start/end 边沿（只能等行离开）。
- 诉求：`session/list`（或 `subagentsByParent` 旁）给 `lineageAsOf/complete`；把子代理 start/end 作为稳定事件或
  纳入转发白名单。
- 现状：`packages/dsh-chamber-client-core/src/derive.ts` 把缺席写成 `unknown`、stale 报告降级；上游给信号后删
  fallback 与对应契约测试。

### 8. 载波 open 的稳定 episode 身份（P3）

- 事实：`$stream({open})` 只给 `AbortSignal`，本地唯一身份 = `streamOpeningKey`（endpoint+payload FNV）；同键异流
  共享超时计数，调用面无法区分重试/新请求。
- 诉求：`open(signal, { episodeId })` 或宿主分配跨重发 token；或宿主承担首帧期限（A§4 第③条）。
- 退出：上游落地后评估退役客户端单档 30s。

### 9. 桌面专属家族门应按宿主能力

- 现象：`dsh-client-ui-settings-account` 门是 `'dshDesktop' in globalThis`；chamber 两 flavor 常驻该载体 ⇒
  家族激活，`desktop-onboarding` 浮层把 `#root` 置 opacity 0 + inert，非官方桌面宿主无表单结算 ⇒ 永久
  「正在加载设置…」。
- 改法：门改宿主能力就绪（`dshOnboarding`/configForms 有值）；loading 态给期限/error 收敛。chamber 侧以构建期
  vendor 补丁关掉 `desktop-onboarding`，并从 DEFERRED 集群加载 `settings-account`；上游落地后
  删补丁门控。

### 10. bundle rev 应由内容派生

- 现象：`artifactRevision = sha1(mtimeMs, ctimeMs, size)` ⇒ 同内容跨宿主 rev 不同 ⇒ first-load-wins 报
  `instance-version-conflict`；重建后旧 URL 404，chamber 需一轮有界恢复。
- 改法：对 bundle 字节求内容哈希。退出：上游落地后删冲突诊断与恢复轮说明（保留超时/迟到语义）。

### 11. 座席声明应可转移

- 现象：`sidebar.session.row.leading/hover` 只能由注册所有者声明，实际渲染者不是它；chamber 自建侧栏不能转交
  声明 ⇒ 官方 schedule 行标记/悬停任务列表必须经本仓自声明座席才渲染（现解法 = 构建期删上游三行、chamber
  自声明并渲染，vendor 补丁 13；occupant 只对本实例求值，外来源行仍不渲染）。
- 改法：①声明可委托/指定 renderer；②提升为页面级座席（同 id 幂等合并）。退出：上游落地后删 vendor 补丁。

### 12. workspace 删除的 order/remove 应原子化

- 现象：宿主 `deleteKnown` 先提交不含该 id 的 order、后删表发 remove；client `installOrder` 把未列项沉底 ⇒
  侧栏行先滑到 section 尾再消失。
- 改法：①pending-delete 的 id 已不在 nextOrder 时同步补发 remove；②`installOrder` 保留未列项原位。
- chamber 现状：删除意图补偿（design 05 §2.2.1）；外部/他端删除未补偿。退出：上游原子化后删补偿与本条。

### 13. 插件管理页可嵌入设置分节

- 现象：PluginManagerPage 是 main 面板整页（居中列/24–48px 侧距/自有 h1+intro）；chamber 以 settings.section 复用，
  容纳层只去 page padding/height/scroll、清 drag inset、给 slot 列宽；宿主列 564px。
- 改法：`surface: 'page' | 'embedded'`（或拆 PluginManagerPanel）。退出：上游落地后删容纳层与三条 seam 锁。

### 14. 漂移收口：剩余项、待退役块与工程环境债

#### 14.1 I-15 实机验收归并

六组矩阵执行序见 `docs/checklists/acceptance/gui-acceptance-checklist.md` §4.1（P6、归档两段式+恢复、通知四缺口、运行位 60/190/310s、I-14
selection scope、I-12 谱系压制）；剩余 = 打包态/真机各跑一次并留记录。判据/关闭见 STATUS §1.1。

#### 14.2 待退役块（上游 wire 落地前不得删）

|块|规模|退役触发|
|---|---|---|
|`dsh-chamber-seed-archive-cleanup/src`（+~2490 测试）|~1560 行|`scripts/upstream/verify/capabilities.json` → `sessions.delete(sessionId).retireWhen`|
|归档管理器逐条展开|~711 行|`sessions.deleteMany/bulk.retireWhen`|
|purge 墓碑机制|~588 行|同单条 delete|

判据门：`node scripts/upstream/verify/verify-capabilities.mjs`（上游落地即红，红即退役）。

#### 14.3 工程环境债

- 下一 pin 落地「真 `WorkspaceRegistry` + 真 binding」lockstep（当前 ad-hoc 形态；CI 走 node_modules 解析）；复核 vendor 补丁 retire 与 `RETIRED_PATCHES`（2 条退役：ReasoningRow sweep、util-values 比较）。
- `node-addon-require-builtin` 指纹表未收录当前 Electron pin ⇒ Electron flavor 托管宿主起不来（Electron 已冻结归档，复活按 `electron-frozen.md` §6.3）；开放事实见 STATUS §三「Electron 运行时指纹」。

#### 14.4 升级期检查两条闭口（待 vendor 物化）

- **P4 首屏 inject 闭合（并入 C4）**：对每个首屏 covered 行读 vendor client 入口 inject，断言成员由 covered id/factory/
  种子词提供；缺失即红（`shortcuts` 事故）。阻塞 = 无「包名→client 入口」映射、worktree 无 vendor 树；前置 =
  在已物化 pin 上写只读探针 + 负例（`test:upgrade-tools`）。
- **P3 侧栏声明−渲染差集**：上游 `sidebar.*` 声明 − 本仓声明/渲染，逐条判定「渲染 / 有意不渲染（带理由）/ 未决」；
  按 registry 声明表 + 实际渲染点 grep 落地；阻塞同 P4。
- 关闭：两条在某个已物化 pin 各跑通一次（含严格模式），负例覆盖「新增键被吞」与「改名假阳性」。

### 15. UI 对齐：候选与维持差异

判据口径：`SB`/`WS` = 安装包内未压缩 `ui-sidebar`/`ui-workspace` `lib/client.js` 行号；本仓 =
`packages/dsh-chamber-client-ui-sidebar`；样式与契约见 design 06 §7、design 05 §2。

#### 15.1 候选（未定稿）

**U1 pinned（残余：块内拖拽 + 跨块守卫 + 账号写入）**

- 现行形态：写入口、三行面、置顶渲染分区（blank → pinned → 其余；manual 取宿主 pinned 序最近置顶在前，updated 用本仓
  account 序，搜索不分区；`pinSetKnown` 门不变）。
- 缺：①块内拖拽/跨块守卫（上游 `sessionDragOrder` 同分区门）；②写进本地账号（上游 `pinSessionOrder` 领先槽；本仓
  unpin 回自然位 = B2）；③半开 follow 的陈旧标记（归档成功时本地清 id）与未挂载源「发送即忘」。
- 候选：A 完整对齐（引入第三条持久账号，碰 manual=wire）；B 现分区（不写账号/不动拖拽）；C 不做（已否）。证据：
  `pin-partition.test.ts`、`session-row-actions.test.ts`、`vendor-session-fact-contract.test.ts`、`binding.test.ts`。

**U2 会话行时间列**：上游行尾静息 `trailingLabel ?? timeLabel(updatedAt)`，hover 换出；本仓行尾是状态槽（10px/14px），
时间只在卡片。候选 A 状态槽静息分支/B 双尾随/C 不落。

**U3 快捷键回调接线**：四活键 = new/fork/archive 调共享服务、rename 走 `shell.overlay`（官方模态真出现）；三死键 =
search/add 只写被覆盖 store、openLocal 键被消费无反馈（`noPicker` 门因 pin 了 directory-picker-browse 而放行）。
注册表 `register` 对重复 id / 默认键冲突抛错 ⇒ 不能覆盖同名 id、不能沿用同键。候选 C1 维持；C2 实机判定（⌘N/⌥⌘F/
⌥⌘R/⇧⌘A 有效；一次键只出一层；⌘K/⌘O 无反应），再定登记口径。归档走官方两段式，`RowActionToast` 同座席可见。

**U4 重命名**：本仓行内 `ServerSectionRenameForm`（双击，拖拽/pending-click 围着它写）vs 上游 `shell.overlay`
`SessionRenameDialog`；换模态属交互层重写。

**U5 search**：本仓胶囊常驻（展开即挂载）vs 上游 inline `max-width .18s` + `search-skeleton`；动画/骨架会改 design 06 §1。

**U6 侧栏 More**：上游 entry-customization 向 `sidebar.panellist.actions` 注册面板 More（只有 Browse/Create 两项；折叠视图行只属上游
conversation region 分支）；本壳未声明该洞、不渲染，registry 对上游 `panel-pins.ts` 登记 `dropped`。候选 A 采纳（声明洞 + 渲染 More +
消费面板 pin；侧栏新增内容须先交用户裁决）；B 维持不采纳（当前；gateway 官方侧栏仍显示）。证据：`packages/dsh-chamber-client-ui-sidebar/src/client/index.ts` 子洞表、registry `dropped`。

#### 15.2 维持的差异与裁决

- **品牌/文案/workspace 卡**：mark 保持 chamber `BrandWordmark`（rail 用上游 FishLogo）、name 洞空回退；搜索 aria 用 `search.sessions.aria`、workspace 复制用 `action.copy`；workspace 卡维持标题+路径+创建时间，不加会话数行。
- **Windows 标题栏（ARCHIVED，Windows/Electron 冻结归档）**：随 design 23 复活时照抄 `[data-windows-titlebar]`；属性由 win32 preload 写入。
- **路径/命中盒/菜单密度**：绝对路径不缩写；clear 钮 18px；`compact`（24px/11px，比列表行矮 2px），抬到 26px 用 `Menu.listClassName`。
- **布局/交互**：26px 行/13px 标题/20px 命中盒、动作簇 4px/20px、来源 accent、折叠动画删除、`RowHoverCard` 自持、vibrancy 门、`sidebar.workspaces` 只声明、`toggle.badge` 不做、品牌蓝点、默认 manual（B1）、flat/tree/归档过滤 per-source、`data-chamber-row`、归档两段式、面板轴入口按来源下挂（owning=真身；其它已挂载来源=页面级 `panel-axis` 发布；未挂载且 connected=默认组合回落；回落字形表须随上游新 panellist 注册者维护）。
- **会话卡状态行 0–1**：不兜底 `status.idle`。

#### 15.3 清洁项（非裁决）

- 面板轴 boot 竞态 + teardown re-arm（`sidebar/src/client/index.ts` 的 pendingPanelId / arm / tryResolve
  与 cleanup 回灌状态机）目前只有源码文本锁、无行为单测；候选 = 仿 panel-source 抽成纯叶子 + 假 observable
  覆盖「先发布空轴、后注册」与「壳拆除窗口收下再 re-arm」两个窗口。
- 六个小图标命中盒无几何锁；`RowHoverCard.onClickCapture` 无源码锁；marquee 两条分支未覆盖；`row-render-cost`
  的 13 faces 等号与 key==deps 对账是有意收紧。
- C15 `TIMING_PAIRS` 只锁原子默认，两处 `openDelayMs={800}` 是生效值却无锁；design 06 两条上游锚待符号化。
- `ServerSection.tsx` 两处 IIFE/12 空格缩进可无损改写但动行号与源码锁；投影查询四份可收敛 `findProjected`；
  `createdAt` 门只判 undefined（不可达，第二写入点需加 finite）。

#### 15.4 复用准则

1. 上游有源码路径导出 → 经 `types/vendor-modules.d.ts` + registry `vendorSourceConsumers` 消费；
2. 非导出纯函数 → 逐字拷入 + 出处注 + 语义锁（先例 `session-title-marquee.ts`）；
3. 结构不同可见面 → 只复用片段（CSS/JSX/字典键），逐值对照。

### 16. 上游 pin 升级管线自动化

> 不阻断合并，不弱化现有门禁；自动写锚只打印 diff。

- **16.1 update-vendor 首跑失败**：只切 submodule/`harness.commit`、不写 index gitlink，差量建链对拍失败；catch 指引与 checklist 相反。修 = step 5 专用豁免 `DSH_CHAMBER_VENDOR_SKIP_GITLINK=1` + 文案改 `git add` 重跑。
- **16.2 bundle:dsh ZFS EAGAIN**：`ERR_PNPM_EAGAIN` 失败、二次成功；修 = `bundle-dsh.mjs` 一次有界重试（staging 可弃、安装幂等）；hardlink 未实测，不推荐。
- **16.3 机械面单批管线**：16.1/16.2 + 由 tag 推导六锚/3 fork 字面量（打印 diff）+ `registry-views --write` / `verify:i18n --write` + 收尾 `verify-upstream-touchpoints`；不自动提交/改判据。
- **16.4 restore-lockfile 只增不减**：HEAD 版 vendor importer 与 `packages`/`snapshots` 条目会被并集补回；但当前 `package.json` 新增 specifier 边丢失时仍无修复（frozen 失败、无自动补边）。修 =「旧记录 ∪ 当前 package.json 新边」并集（多复活边会被 frozen 判红，fail-closed）。

## B. 平台与外部门禁（B 类）

> 阻塞来源 = 真机 / runner / 凭据 / 产物；每条的现行验证面 = macOS Swift 腿（Windows 仅在复活后适用）。契约见 design 25、design 23（ARCHIVED）。
>
> **范围**：只有 macOS Swift 腿继续排期；Windows v1 与 Electron 腿冻结归档（见 [electron-frozen.md](./electron-frozen.md)），B§2 仅在复活时执行。

### 1. macOS Swift 原生壳 v1

> 路线 A：Swift 写壳 + Node sidecar；契约见 `docs/design/desktop/25-macos-swift-native-shell.md`。本节只留 W-xx 索引与未闭合外部门的指针；
> 决策 D1–D7、双线防漂移门禁的明细按收口删除（原文存 git 历史）；W1–W7 判定已迁入 design 25 §8.5；A1–A8 中止点、性能/产物体积 A/B 协议与 dev 约定的明细同样按收口删除（原文存 git 历史），
> 现行判据 = design 25 §8–§10、`docs/checklists/acceptance/gui-acceptance-checklist.md` §4.2 与 `scripts/perf/README.md`；开放状态归 STATUS。

#### 1.1 决策结果索引（D1–D7）
D1–D7 取向（路线 A、双壳共存 `com.dshchamber.native`、更新 v1 blocked-available→Sparkle、`macos/` SwiftPM、原生 UI 渐进不做、Node 版本与架构、静态凭据 0600 明文）见 design 25 §10（正式签核仍开放）。

#### 1.2 外部门禁
- M5 实机门禁 W-28…W-32（含 W1–W7 判定矩阵）：状态/范围见 STATUS §三「macOS Swift 壳 M5 实机矩阵未闭合」行，矩阵 design 25 §8.5。
- 双端 harness 未实施（需 GUI 会话，design 25 §8.3/§8.6）；Apple 凭据（Developer ID/公证/stapler）缺失时 dry-run 全链绿可推进，不得声称「完成」（design 25 §7）；其余实机项（通知权限时序、SMAppService 登录项、LaunchServices 深链、唤醒恢复、SSE/WS 心跳、ATS、通知音效差异）在 STATUS 未完成项。
- **（Electron 冻结归档，2026-11）**Electron 不再出包，「同 tag 双端发布回滚」语义只作复活参考；当前发布面 = Swift 腿（见 [electron-frozen.md](./electron-frozen.md) §4/§6）。

#### 1.3 WBS 任务号索引（W-01…W-32 → 契约落点）
|任务|内容|契约落点|
|---|---|---|
|W-01…W-05|M0 决策签核与文档同步；Swift 壳脚手架；A 桥雏形（shim/MessageHandler/TrustGuard）；P0 竖切（FrameCodec/BridgeClient/sidecar-stub）|design 25 §3.2、§4.4、§8.1|
|W-06…W-08|P0 走查与门禁（G1–G5、C1/C2 判定）|design 25 §8.1|
|W-09…W-13|core seam（node-edges/shell-core、IPC 面镜像、core 禁 electron 门）；sidecar 入口与 stdio JSON-RPC（sidecar-entry/sidecar-ctx/bridge manifest 管道）|design 25 §3.2、§4.1|
|W-14/W-15|Electron 零回归证明（分层 gate）；SidecarSupervisor（退避重启 + 退出码分级）与目录锁|design 25 §4.1、§3.3、§6.3、§8.2|
|W-16…W-18|B 桥客户端（FrameCodec + 生命周期）；bridge-manifest 生成物（JSON + Swift 白名单 + stub）与 shim 表面锁步|design 25 §4.4.2、§4.4.3|
|W-19/W-20|HostEdges 原生腿（SwiftEdgeHostLegs：对话/面板/文件/通知）|design 25 §5 E1–E20、§4.5|
|W-21|窗口/菜单/通知/深链/渲染器恢复（MainWindowController/RendererRecovery）|design 25 §4.5、§5|
|W-22/W-25|更新 v1（blocked-available）→ Sparkle 预研/实现（S-01）|design 25 §7|
|W-23/W-24|sidecar 打包（payload node + dist/web）与 .app 组装/Info.plist/ATS|design 25 §3.2、§4.3|
|W-26/W-27|CI（`test-macos`）与发布产物（`-native` 命名、appcast、回滚）|design 25 §8.4|
|W-28…W-32|M5 实机门禁与验收|design 25 §8.5；开放状态见 STATUS|

### 2. Windows v1（**冻结，不排期**）

> 契约与决策：`docs/design/archive/23-windows-support.md`（ARCHIVED）。本文只留未实现/外部门禁、基线登记口径与取舍；
> 每条须真实 Windows/CI 验证才算完成。
>
> **冻结归档**：Windows 桌面腿随 Electron flavor 冻结、不发布、不排期（见 [electron-frozen.md](./electron-frozen.md)）；本节只在按 §6 复活时执行，原文保留为复活基线。

#### 2.1 外部门禁（需真实 Windows runner / 实机 / 产物；**冻结原表，复活后执行**）

- M0：push 后 `test-windows` 首跑绿（连续 3 次）；按 §2.2 基线口径把首份真实数据填入下表。
- M0.5：上游 `@deepseek-ai/dsh` win32-x64 最小复现 spawn + ready（阻断级 R1）；NSIS 是否写
  `HKCU\\Software\\Classes`（决定 C17，需 windows-2022 最小构建实证）；Defender 实扫计时；原生依赖预构建核对
  （koffi 称预构建随包，仍以安装实测为准）。
- M1：test-windows 腿上 `win32-lifecycle` 集成测试真实跑绿（CIM/netstat/taskkill 实证）；design 02 §5.1 契约改写；
  mac/linux 全量回归。
- M2a：Windows runner 上事务矩阵（安装→切换→探针失败→回滚→恢复，env 门控开启态）+ `win32-readonly-rm` 决策门
  （Node rm 对只读树行为）+ icacls 实机输出核对。（私有状态读写的 win32 身份回退存在，事务首步不再因缺
  `O_NOFOLLOW` 抛错；矩阵本身仍需 runner。）
- M2b（纪律门禁：M2a 全绿前不做）：`DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS` 门控翻转
  （main.ts/dsh-runtime-controller/apply-now-gate/UI/i18n/版本 chip）；win32 测试 diff 对照基线全归因；
  Windows 11 实机故障注入全链 + 只读投影文案移除。
- M3：design 23 §7 实机矩阵全勾（托盘/关窗/唤醒/SSH 密钥隧道/updater stable+beta/深链特殊字符 URL/
  防火墙 loopback 无弹窗/ACL 查询）+ 打包产物核对（图标/preload）。
- M4：登录自启注册表实测/卸载残留（nsis-uninstall-cleanup）、深链冷热启动 + `&` 字符 URL、open-in 盘符实机、
  NSIS protocols 实证（与 M0.5 合并）。
- M5：Azure Trusted Signing/MSIX 形态评估（需凭据/发行决策）；dry-run 全链 + 实机 Release 安装 + 更新链路演练
  （design 23 §8）。
- M6：妥协清单、支持矩阵文档与 CHANGELOG 条目随正式版本落定（design 23 §1 分期表）。
- 遗留低优（记录在案）：supervisor win32 sendSignal 无宽限重试（方向 fail-closed）；双模块解析器重复
  （win-probes/windows-process 互注 + 双端 CI 测试）；decideDeepLink platform 入参保留为显式契约。

#### 2.2 基线登记口径（M0 首跑后填写；**冻结基线，复活后填写**）

> 用途：Windows 首版修复前基线。第一次 `test-windows` CI 腿跑绿后，把每个测试在 win32 的 pass/skip 集合与每个
> 平台门控的拒绝行为填入下表；此后每个里程碑的 win32 测试变化必须对照本表归因（diff = 预期解锁集，不允许
> 「顺手改绿」）。锚 = 测试文件 + 用例名/描述，不记行号（行号会随实现漂移）。

|套件|win32 pass|win32 skip（用例锚理由）|首跑日期/commit|
|---|---|---|---|
|test:runtime|待填|待填|—|
|test:control-plane|待填|待填|—|
|test:desktop|待填|待填|—|
|test:gateway|待填|待填|—|
|typecheck 全组|待填|—|—|

**已知 skip 清单（翻转前的登记快照）**

|位置|内容|翻转后去向|
|---|---|---|
|control-plane `test/protocol/protocol.test.ts`（`terminateChild waits past leader exit and kills a stubborn same-group descendant`、`unproven attempt termination aborts port retries and preserves the pid ledger`）|Unix detached 进程组契约|win32 等价测试（M1 `win32-lifecycle.integration`）或 POSIX-only 注释|
|dsh-runtime `test/install/runtime-installer.test.ts`（`RuntimeInstallerSupervisor` 进程组回收组：abort/timeout、daemonized descendants、stubborn descendant；`published tree is recursively read-only`）|进程组契约/不可变树/symlink fixture|实现类（树回收/清属性）后 win32 等价；symlink 类标 POSIX-only|
|dsh-runtime `test/store/metadata-authority.test.ts`（authority-reader symlink、replaced-parent 用例）、`snapshot-store.test.ts`、`known-good-monitor.test.ts`、`runtime-metadata-recovery.test.ts`、`dsh-runtime-store.test.ts`（eviction 只读不可变树）|symlink/权限/只读不可变树 fixture|junction 或普通文件替代后 win32 等价；eviction 由 `win32-readonly-rm` 决策门（清属性实现或 Node rm 自带）决定|
|gateway `test/auth/store-permissions.test.ts`（POSIX 0700 组：stateDir/子目录/文档 owner-only）|POSIX 0700|有 win32 ACL 保留测试替代，保持 skip|
|control-plane `test/host-lifecycle/reaper.test.ts`（`reaper: a symlinked pid record is kept as unsafe evidence and never drives a signal`）|symlink fixture（权限与平台相关）|POSIX-only 注释|

**平台门控拒绝码基线（现状断言，翻转时逐个销号）**

|门控|现状（win32）|断言位置|目标|
|---|---|---|---|
|dsh 运行时 mutation|`platform_read_only`|gateway runtime-manager；desktop `runtimeManagementSupported=false`（env `DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1` 开启验证态）|desktop 解锁（仅 M2a 真实 win32 验证后，M2b）；gateway 保持|
|SSH 密码|IPC 拒存（引导 keys/Pageant）|`ssh-provider.ts` sshPasswordSupported/main 门消息|保持；一键免密 UI = 后续特性|
|登录自启|已解锁（代码）：supported=true、`setLoginItemSettings`（HKCU Run）|`chamber-settings.ts` computeSupported/`main.ts` applyLaunchAtLogin|runner/实机验证注册表与卸载清理|
|深链注册|已解锁（代码）：打包态 register(no-args)，dev skip|`deep-link.ts` decideDeepLinkProtocolRegistration|runner 实测注册表 + 冷热启动|
|open-in 本地路径|已解锁（代码）：local 走 validateLocalPath（盘符/UNC）|`open-in.ts` runOpenInLaunch/finder|实机盘符路径打开验证|
|0700/0600 语义|继承 ACL + no-follow/identity + icacls 启动收紧|store-permissions/private-file/win-acl.ts（main 接线）|runner/实机 ACL 查询核对|

#### 2.3 仍生效的取舍

取舍唯一权威是 `docs/design/archive/23-windows-support.md` §5「妥协点（发布附注，唯一权威）」与
`docs/progress/STATUS.md`「范围决策与必要取舍」：F1 无进程组等价、能力先于开关（M2a 前只读/禁用）、
Windows ACL 权限语义、C16 凭据仅内存、未签名发布身份均登记在彼，本文不复述（避免第三份副本漂移）。

## C. 未实现功能想法（C 类）

> 阻塞来源 = 产品优先级/需求触发；未排期。设计定稿移入 design，落地或明确不做则移出。

### 1. 账户 / 登录面（DeepSeek 账号 + 余额）

> 优先级：**低优先，未排期**。触发条件 = 出现「要用官方 DeepSeek 账号的凭据/额度给 dsh 用」的真实需求（API key / 自定义 provider 路径不受影响）。状态权威：STATUS §4.2「设置/账户」的桌面账户登录项。

**目标**：在具备账户能力的来源的设置面板内提供完整回路：未登录 → 登录（浏览器 PKCE）→ 等待浏览器 → 已登录（资料 + 普通/赠金钱包 + 充值·用量外链）→ 退出。凭据只落在**该来源宿主**的凭据库（`dsh-credentials-local`），渲染端只见 profile / 余额，不碰 token。

**非目标**（三条路都不做）：官方桌面首启浮层（`desktop-onboarding`）、`WelcomePage` 欢迎页、Electron 账户后端、应用内平台视图、`dshDesktop` 载体扩展、把账号 token 带进渲染端。

**剩余工作**：控制面根路径 `/oauth/callback` → 活动实例反代 + 可达 origin（多实例归属需裁决；`settings.launcher` 座被设置壳阴影后无渲染点）。UI 面（DEFERRED 载入 + vendor 补丁门控）、桌面 flavor 现状与残余见 design 09 §3.5③ 与 STATUS §4.2「设置/账户」，本节不复述。关联：design 05 §5（分节注册形状）、§7.4（传输 URL 不进 renderer）；上游最小改法见 A§9。

### 2. session 的 subagents 在侧边栏中的显示

> 未设计、未排期。

**动机**：侧边栏现只展示 session/workspace 行（`docs/design/client/06-sidebar-enhancements.md`）；会话运行时的 subagents（子代理）仅会话内可见，望侧边栏给出子层级/计数/状态。

**现状对照**：侧边栏 = 每来源分组 + workspace/未分组桶 + session 行；行尾状态槽表达 running/completed/pending；每父会话 `runningSubagents` 计数徽标与 tooltip 由 design 06 §4.5 承担（经运行时事实通道上报、vendor `indexSubagentDescendants` 路由）。剩余开放 = 会话行下嵌套子层级（subagent 行缩进显示状态/会话）、层级折叠/截断、跨会话总览视图；逐子代理的可浏览行级列表 wire/store/UI 仍不存在，形态评估（chamber 插件 vs 不做）按 design 08 先例留待设计。

**开放问题（设计时再定）**

- 事实来源与拉取节奏：聚合轮询 / 运行时通道（06 §4.2 chamberBridge runtime report）/ 会话详情按需。
- 呈现形态：会话行下嵌套 subagent 行（缩进）、行尾徽标计数，还是仅当前会话内面板（会话内若已有，侧边栏是否必要）。
- 层级深度（subagent 的 subagent）与大量 subagent 时的折叠/截断。
- 跨来源投影（远程实例的 subagent 在本地侧边栏的呈现）与断连清理。

**关联**：`docs/design/client/06-sidebar-enhancements.md`（侧边栏形态、运行时事实通道）；STATUS §4.2「连接/来源」的 v1 不做清单。

### 3. open-in：超集分批（S1/S2/S3）

> fork & supersede 的契约见 `docs/design/desktop/20-open-in-registry.md`（§4 契约、§6 host 包与八处接线、§8 文件清单、§9 验证门）；实机验收与实施后开放项在 STATUS（design 20 §1 指向）。本节只留未排期超集分批与不做的边界。

#### 3.1 超集分批（S1/S2 未排期；S3 残余；S4 不做）

每批独立 PR、各自测试、不引入新运行时依赖。优先级与范围：

- **S1 远程 provider 家族**：主进程 open-in 注册表（`packages/desktop/open-in.ts`）当前只有 vscode；待加 Insiders/Cursor/Windsurf/JetBrains Gateway/`ssh://` 终端——只构造 URL 交 OS、不启动进程；每项需实机 scheme 语义验证。实例侧本地目录（`packages/dsh-chamber-seed-open-in` 的 catalog）已覆盖这些应用，但与主进程远程注册表不是同一面。
- **S2 远程文件级打开**：远程来源允许文件路径（纯 URL 构造，不经 host 包）；本地仍目录限定。
- **S3 复制路径（残余）**：工作区悬停卡复制 `workspace.path`（`ServerSection.tsx` 的 `copyText`）；会话行仍只复制标题（`ServerSectionRows.tsx`），待补 `cwd` 复制或裁决只保留工作区。零新 IPC/依赖；「复制 `ssh user@host`/复制 VS Code 深链」不做（结论见 STATUS §1.4「open-in/Git/深链/只读镜像」）。
- **S4 多入口**：不做（理由登记 STATUS）：header 按钮与目标会话同排相邻，侧栏入口边际价值有限；会话行动作在行菜单（置顶/重命名/分叉/归档）+ 行内悬停归档钮与置顶钮（`packages/dsh-chamber-client-ui-sidebar/src/client/ServerSectionRows.tsx`），新增入口要么重复要么推翻它——不要把「会话行刻意没有 kebab」当理由（会话行有 kebab；刻意无 kebab 的是 worktree 派生的 workspace 行）。快捷键缺基建（vendor 无 keybinding 注册表，只有聊天输入框 keymap），自建 document 级监听还要处理「哪个 entry 是活跃视图」与 chord 冲突。边界（不做，design 20 §7.3 唯一权威）：远端宿主侧打开、扩本地执行面、主进程自行枚举本机应用。

## D. 工程债（D 类）

> 阻塞来源 = 工程优先级（重构/性能/门禁）；未排期。范围 = `packages/**`；行数单一来源 =
> `scripts/gates/registry/file-budgets.json`；核心指标 = 消除补丁式修改（根因、单源、先锁后删）。

### 1. 结构性重构与清理

#### 1.1 开放工作（按优先级）

|#|工作|现状|验收判据|
|---|---|---|---|
|1|三处 state/ref 镜像：`packages/dsh-chamber-client-ui-sidebar/src/client/sidebar-root-projection.ts`（serversRef）、`packages/renderer/src/components/InstanceView.tsx`（activeRef/settledRef）、`packages/dsh-chamber-client-ui-settings-bridge/src/client/DshRuntimeSection.tsx`（confirmLaunchRef）|未收口；其余镜像的基线在 git 历史与各 host store 注释|渲染值走 useSyncExternalStore 小 store（单源）、事件回调读 store 的 getSnapshot()，删 ref 镜像；不引入状态库/新包|
|2|settings 两分支合流：`DshRuntimeSection` 的 gateway/local 共享 controller|未动|runtime-management / 设置桥套件绿；先补 parity 测试再合并|
|3|逐包棘轮收尾：file-budgets.json 只降不升（含新叶、`kind:ceiling` 单列与 FROZEN 行；行数与缺口**以表为准**，不在文档里复写）|目标与缺口一律看 node scripts/gates/checks/verify-file-budgets.mjs --report|verify:file-budgets 恒绿；**未决**：新模块仍需人工登记；host-assembly 成对抽取与 transport exec 的取舍见 STATUS §三|
|4|§1.5 的审计开放项|未动|各自条目内|
|5|`packages/desktop/host-assembly.ts` 的 `sm.onStatusChanged` 订阅回调（~204 行，28 个自由变量）→ 与 `onVerified` 成对抽成同一工厂|未动|判据见 STATUS §三（预计 −158 行）；file-budgets 记为 FROZEN|
|6|App 残余编排的依赖容器化（`retireSources`+`refreshRemotes`+`JSX` 共 ≈75 个自由标识符）|未决：逐字搬会得到 ≈75 字段的入参对象，不如现状；需先裁决「单一 AppRuntime 容器」是否值得（会改变模块边界而非减少耦合）|裁决后要么引入容器并继续切，要么把「App 编排核心」登记为有意保留的边界|

#### 1.2 不做与保留（结论）

- **vendor 声明成员并集**：上界 ≈100 行、需动 8 个 tsconfig，ROI 低 → 不做（入档）。
- **有意的保留**：安全清理类残留（`.tmp` 残留 / askpass 旧目录 / autostart）保留，不删。

#### 1.3 门禁与用法

- 证据选择：`node scripts/gates/runners/run-checks.mjs <static|tests|typecheck|full>`（`--list` 看计划）；模式名与 ci.yml/release 一致；模式之外的门及其归属以 `docs/progress/STATUS.md` §1.6 为准（本文件不复述清单）。
- 门成员资格单源 = `scripts/gates/registry/gate-surfaces.json`（loader `gate-registry.mjs`，`run-checks` 只派生模式）；`ci.yml`/`release.yml` 的 static 步骤由 `gate-workflow-views.mjs` 从 registry 生成（四个标记块 + `--check` 保鲜）；不变量与生成视图细节归该单源；文档写作规则见 `docs/AGENTS.md`。
- 本重构三门：`verify:import-cycles`（值环 0 + 类型环 allowance——现为空）、`verify:file-budgets`（只降不升，清单与阈值以 `scripts/gates/registry/file-budgets.json` 为准）、`verify:no-dead-exports`（零消费者导出即红）；执行面见 STATUS §1.6。

#### 1.4 边界与不做

- 不新增 utils/抽象包；不引入状态库；不做全仓重写。
- 不动 design 14 会话权威链、上游 fork（dsh-client-connection / dsh-client-web / dsh-api-gateway / vendor）、
  Swift 业务面与已移出项（design 01 §4/§5）。
- 不把「再导出/转发」当成减量；不把格式化折叠当减量。

#### 1.5 审计开放项（未排期）

- **renderer reconnect 记账**：`App.tsx` 的 `retireSources` 仍缺 `sessionListRefreshAt/Pending`、
  `authoritativeArchiveSet`（同 id 换代泄漏）。收口 = 单一 `reconnectSource(id)` + 生命周期参与者注册表。
- **session-state 语义单源（A-1/A-2/A-3）**：协议常量、wire 类型、descriptor 解析、capability 分类与 turn-end 分类单源在 `packages/dsh-chamber-wire/src/session-state.ts`；mux 路径、`$events` 端点、follow 载荷、goal 投影白名单与 `goal/activation-changed` 归一化单源在 `packages/dsh-chamber-wire/src/mux-frame.ts`；`isPlainRecord`/`isRecord`/`isWatermark` 单源在 `packages/dsh-chamber-wire/src/json-guards.ts`（浏览器经 client-core 的 `./session-state`、`./mux-frame`、`./json-guards` 具名面）。**刻意的残余差异（不得「顺手统一」）**：①外层 frame 容器解析仍分两处（`parseMuxServerFrame` ⇄ `parseMuxFrame`，容器与返回形状不同，只共享内层语义）；②status args 的对象形仍只有 renderer 接受；③`packages/desktop/store-file-hygiene.ts` 的同名守卫是**宽松**变体（任意非数组对象），已在文件内注明；④fork `dsh-api-gateway/src/stream-protocol.ts` 按 pin 重放纪律保留；源码文本锁步测试只保留 fork 侧与瀑布字面量两类。
- **插件三链路流水线**：local/ssh/gateway 各自 validate→confirm→remove/add→restart→verify；desktop
  `plugin-sync.ts` 与客户端行投影（settings-connections 的 `plugin-model.ts`/`save-host.ts`）仍两套。
  收口方向 = 一个 `PluginMutationPlan` + 三个薄执行器。
- **未纳棘轮的 god 文件**：control-plane `index.ts`/`proxy-forward.ts`/`spawn-dsh.ts`、gateway
  `dispatch.ts`/`plugins.ts`、dsh-runtime 多个 `runtime-*` 文件、desktop `updater.ts`/`main.ts`、Swift
  `MainWindowController`/`AppDelegate`/`BridgeClient`、`install-gateway.sh`——后续按包逐个纳入棘轮。
- **死导出门覆盖洞**：client-ui 包整包在 `RUNTIME_LOADED_PACKAGES`（`verify-no-dead-exports.mjs`），`./client/**` 不受判；已知零消费者导出 `isFixedSectionId`、`transportTargetChangedSpec`。
- **第二实现复核**：`openPromise` 三态证据在 `packages/dsh-chamber-client-ui-open-in/src/client/session-stream-health-probe.ts`；`safeStorage` 访问器 5 份（gateway-provider / host-assembly / main / registry-projection / sidecar-ctx）；spec 分类的客户端对照文件需先重新取证再收口。
- **client/seed god 文件与形态**：`PluginDialog.tsx`（约 32 个 useState）、`ConnectionsSection.tsx`、
  `ServerSection.tsx`（JSX 内派生状态残留）等已在棘轮内；`packages/dsh-chamber-seed-git-worktree/src/core.ts`、
  `packages/dsh-chamber-seed-archive-cleanup/src/core.ts`、`packages/renderer/src/live-graph.ts` 是否纳入棘轮由后续裁决定。

#### 1.6 跨包逐字重复复核（口径与结论）

- 口径：多行函数体（≥3 行）逐字相同且跨包为重复；台账只统计较大函数体，两者差异属**口径**而非新增重复。
- 结论：在既有约束（不新增抽象包、不动 fork、不引入反向依赖）下**可删 0 组**，登记而非强改。唯一成组的是
  control-plane `win-probes.ts` ⇄ dsh-runtime `windows-process.ts` 的 parity 锁
  （`test/protocol/win-probes-parity.test.ts` 钉住，删除即红）；其余为 3–5 行守卫/错误串助手与 fork 内部重复。

#### 1.7 未删项与判面/锁步依据（非漏做）

- 需先补跨端锁步测试再收口的 seam：`sessionStateNoteKey` / `SESSION_STATE_ROUTES`（读水位与路由字面量锁，待 §1.5 单源）、`pendingStats`（control-plane `dsh-client.ts`，settle-once 诊断缝）、`transportTargetChangedSpec`（settings-connections `save-host.ts`，跨端镜像缝）；删前依据见各文件注释与对应测试。
- `dsh-stream-state/swift` 的 Swift 镜像只剩 `CarrierDecision.swift`（`LoadState` 镜像归 design 14 §D4）；client-ui `./client/**` 整包在 `RUNTIME_LOADED_PACKAGES`，扩死导出门需逐包注册客户端 seam，独立一轮；`safeStorage` 访问器 5 份 / spec 分类两套 / session-row 三转换 / reconnect 第四臂归 §1.5 单源条目。

#### 1.8 重构脚手架退役（B1/B7 收口后）

- **B1 收口**（`DIVERGENCE.md` 退役条件满足：三条旧替换入口删除、`CarrierSupervisor` 单一所有者）：整批删除差分门 `scripts/refactor/equivalence.mjs` + `gate-surfaces.json` 的 `refactor.equivalence` 条目 + `packages/dsh-stream-state/test/refactor/*` + `DIVERGENCE.md`，并同步 `scripts/README.md`。
- **B7 收口**：删除 `scripts/refactor/stream-state-metrics.mjs`、`stream-state-baseline.json` 与其 `metrics-tool.test.ts`，并移除 design 14 §D4 ⑤ 的 `--check` 引用。
- 两条均为未排期；触发 = 对应收口裁决落地。

### 2. 产物新鲜度守卫（G2/G3/G5/G7/G8；未排期）

> 现有守卫：`desktop/dist/control-plane/**`、`gateway/dist/**`（标记守卫）、`preload.cjs`、`renderer/src/generated/**`、`gateway/dist/index.js`（重建-比对，`scripts/gates/checks/verify-artifact-freshness.mjs`；**非注册门**，发布 checklist §4 构建后手动 `--require-compare`）；seed `dist/index.js` ×4 + `dsh-runtime/dist/index.js` 归 C8（`scripts/lib/build-artifacts.mjs` 单源）；G1/G4/G6 = `verify:test-wiring`。本节只留仍无守卫的产物与最小守卫建议；开放状态见 STATUS §1.5「发布/CI」的产物新鲜度项，design 21 §7 登记。

#### 2.1 仍无守卫的产物

|产物|生成者|提交？|当前守卫|陈旧后果|
|---|---|---|---|---|
|`packages/desktop/dist/web/**`|renderer `build`（vite `build.outDir = ../desktop/dist/web`，三处路径契约见 `packages/desktop/scripts/electron-shared.mjs`（**ARCHIVED**：Electron 冻结，保留为复活参考；其测试在 FROZEN 组））|忽略|只有路径契约文本断言（`packages/desktop/scripts/electron-shared.test.mjs`，FROZEN 组）与 CI 的 scoper 标记断言|打包发行旧前端壳（IPC 名/槽位可能漂移；Electron 打包已冻结）|
|`packages/desktop/dist/host-{graph,git-worktree,archive-cleanup,open-in}-package/**`|`packages/desktop/scripts/build-host-graph-package.mjs`（各 seed 包 `dist` cpSync）|忽略|只有行序/outDir 断言（`scripts/release/preflight/packaging-manifest-lockstep.test.mjs`）|打包 seed 旧宿主包|
|vendor `allowBuilds` 锁步（根 `pnpm-workspace.yaml` ↔ `packages/dsh-runtime/src/allow-builds.mjs`）|人工同步|提交|无|新增原生依赖漏登或漏 deny 会静默漂移|

`dist/` 整族在 `.gitignore`：干净 checkout 的「缺失」是正常态——首批 host/dsh-runtime 产物须先由
`pnpm run build:artifacts` 自举，其余按需构建；要防的是本地/打包态的「存在但陈旧」——CI 每次全新构建，
看不到这一类。上表 `scripts/*` 指 `packages/desktop/scripts/*`（Electron 构建脚本；gateway 侧
`packages/gateway/scripts/*`），非仓库根 `scripts/`。

#### 2.2 最小守卫建议

- **P0 G2 产物新鲜度登记表**：产物 ↔ 生成者 ↔ 守卫或豁免一张表，门禁断言每个产物都有守卫或显式豁免（§2.1 全部）。
  成本低–中（表 + 纯函数）；收益：杜绝静默。
- **P0 G8 豁免表**：不需要守卫的产物显式记理由（§2.1 全部）。成本低；收益：防止 G2 表被「全部豁免」掏空——
  豁免也要有人签。
- **P1 G3 `.build-manifest.json` 输入摘要**：构建时写 `{inputsHash, toolVersion, outputs[]}`，测试比对；
  比标记串强——无文案产物（web/host-package）也能判。适用全部忽略态产物。成本中（每构建脚本一处 + 比对函数）。
- **P1 G5 `before-pack` 打包前兜底**：当前 `packages/desktop/scripts/before-pack.mjs` 只 materialize dsh-runtime
  core，**不**断言 `dist/web`/`preload.cjs`/`host-*-package`/`control-plane` 的存在与新鲜度；建议补存在 + mtime/
  输入摘要断言（fresh checkout 缺失另判）。
- **P2 G7 vendor allowBuilds 锁步**：断言根 `pnpm-workspace.yaml` 的 `allowBuilds` 与
  `packages/dsh-runtime/src/allow-builds.mjs` 的 `ALLOW_BUILDS`/`DENY_BUILDS` 镜像关系。成本低；收益：把 AGENTS
  的硬事实从人工同步变成门。

#### 2.3 开放问题

- 标记串（现状）vs 输入摘要（G3）是否并存值得。
- 失败信息**必须**给重建命令，否则操作者只看到红、不知下一步。
- CI 腿的边界：CI 每次全新构建，「陈旧」只在本地/打包态出现——要真覆盖得在打包作业跑 G5。

### 3. 页面侧性能 P2 残项（推迟中）

> 本节只承载页面侧性能修订中**未实现**的 P2 三项（侧栏 T2、factAt 量化、前置仪表）；
> 既有实现面契约见 `docs/design` 的 05 §3（发布门与投影缓存）、14 §7（观察者对账与页面恢复：隐藏期不采样）、19 §3.2.4（桥探测长尾）、
> 24 F5（purged 孤儿键收敛）。三项都保留证据与设计以便下次决策，落地前不进入任何提交面。

#### 3.1 侧栏 T2：更细的上下文拆分与按来源缓存

**证据（代码）**：sidebar 的行状态把 menuOpen/renaming/rowErrors 与全量字段 ctxValue 放在同一条更新通道上，
任何一处的交互都会走到全部 ServerSection 与全部行；搜索通道（client-core 的 search-state.ts）每个按键立即
notify，menus.ts 与 ServerSection.tsx 都订阅它，所以一次键入会重渲染所有壳的全部行；
sessionsOf/orderedWorkspaces/dropEnv 每次渲染按来源重算。

**已知前置**：`ctxValue` 的 useMemo 覆盖全量字段，但各 hook 提供的动作回调（toggleMenu/closeMenu/commitSessionDrag/onNewSession 等）仍每次渲染重建，因此 `ctxValue` 只在回调身份恰好不变时命中；要拿到完整收益需先把这些回调 useCallback 化。

**设计**：menuOpen/renaming/rowErrors 拆成独立 context（只有需要它们的行与 section 订阅）；
sessionsOf/orderedWorkspaces/dropEnv 按 (server 身份, 相关 prefs 字段) 加一层按来源缓存；搜索通知合并到一次
（微任务或帧级），把「每键通知」降为「每帧至多一次」。

**预期收益**：交互提交从 O(全部 section x 全部行) 降到 O(1) 行加 O(1) section；搜索键入从壳数 x 全行降到一次通知；
派生对象数按来源从每次渲染 N 个降到变化时才新建。结构性倍数，不承诺毫秒。

**风险**：context 拆分会让「同一事实两个座位」的同步面变多（menuOpen 与 renaming 当前共用一个状态源，拆开要
保持同一行不会出现半开菜单）；搜索通知合帧后，键入的可见反馈上界从「立即」变成「下一帧」，需要实机确认主观延迟。
现有源码文本锁（session-row-state.test.ts 把 7 个侧栏源文件——6 个 tsx + server-section-model.ts——读成文本
正则断言）在拆分时必须同步更新，否则锁会失真。

**验证**：sidebar 包全部测试 + renderer 接线锁；实机用 Web Inspector 记录「单击 kebab 后的重渲染行数」与
「搜索键入一次的通知次数」前后对比。

#### 3.2 factAt 量化（产品取舍）

**证据（代码 + 实机）**：运行时事实里的 factAt（该行事实的观察时刻，host 域 ms）被刻意纳入
runtimeReportSignature（见 client-core 的 derive.ts 中 runtimeReportSignature 的注释与实现），于是每次观测都会
换签名并触发一次发布；实机风暴锚点为 Dock 徽标 1,098 次翻转 / 40.8 秒（约 27 次/秒），静息期趋近 0。
行的 data-chamber-fact-at 就是这条时间戳。

**设计**：把 factAt 量化到固定桶（例如 1 秒）后再进签名，桶内的观测不再改变签名；原始值仍按原样进入 runtime
facts 供渲染，只在「是否需要重发布」的判据上用量化值。

**预期收益**：风暴期发布频率从「每次观测」降到「每桶至多一次」，是当前已知的最大单一项；按 27 次/秒的峰值上界，
量化到 1 秒最多把发布压到 1 次/秒量级（真实收益取决于观测节奏，需仪表）。

**风险**：这是**产品取舍**而非纯性能修复——行的「事实观察时刻」呈现粒度变粗（数据本身不变），任何依赖
「factAt 一变就重发布」的消费面（新鲜度读数、完成边沿的判定）都要逐一复核；derive.ts 里那条「刻意纳入」的注释
是契约，改动必须同时改写它。发布速率目前无仪表，收益需先加计数再谈。

**验证**：derive 单测（量化桶边界、桶内等值不发布、桶外仍发布）；实机风暴复测（发布计数与徽标翻转数）；
真机确认行的新鲜度读数仍可接受。

#### 3.3 搜索通知与 ctx 拆分的前置仪表

**证据**：发布速率、每次发布的订阅者数量、React 提交耗时都没有仪表；风暴 27 次/秒与静息趋零只是两端锚点，
中间的分布（一次交互触发几次发布）不可测。上面两项的收益因此只能给结构性上界。

**设计**：加一个仅开发档可读的计数器（发布次数、每次发布的 servers 变化来源数、签名缓存命中数、侧栏行派生次数），
走既有诊断通道暴露，不新增持久化、不进渲染热路径。

**预期收益**：把 P2 的收益判定从「结构性倍数」升级为实测数字；也是壳常驻后内存/发布速率的复核依据（释放壳的蓝点/通知已由 facts-only 判定侧读回退覆盖，见 STATUS §1.1）。

**风险**：仪表本身不能成为新的热路径成本（计数要无分配、无字符串拼接）；诊断面不得进入打包产物的用户可见 UI。

**验证**：开发档读一次计数；打包档确认计数器被编译掉或不暴露。

### 4. 多实例常驻的后续研究（未排期）

> 本条目的触发条件独立于 v1.1 落地；v1.1 只落 keep-all + 硬上限 + 压力阀（design 05 §4.1），
> 下列工作不提前做。进度状态见 [STATUS.md](./STATUS.md) §1.1/§1.3/§1.6。

| # | 工作 | 触发条件 | 说明 / 验收方向 |
|---|---|---|---|
| 1 | 侧边栏单实例化 / 隐藏壳监听门控 | 来源 ≥8，或实测 p95（切源/首帧/流式）劣化 | N 壳共享一个 renderer：隐藏壳的 React 更新与监听仍跑。先有帧时/输入延迟度量面，再评估「仅屏上壳订阅/暂停隐藏壳监听」；不得改变「会话保活」契约 |
| 2 | `dsh-stream-state` 的 hidden/reclaimed 收窄 | `TEST_ONLY_EXPORT_ALLOWLIST` 清理时（同批） | retention 退役后 `projectHiddenSince` 等成 test-only；与删除无生产者的 `mounted/unmounted/painted/userSelected/reclaimed/retryRequested/harvestStarted/harvestSatisfied` 事件同批，保持 reducer 真值表与 `emission-coverage` 全绿 |
| 3 | 进程 / 视图隔离（`WebContentsView` / 独立 WKWebView） | 来源 >8，或「一个壳的长任务卡住整页」真机复现 | design 05 §9 的重评触发；开做前先取整页卡顿证据（rAF/帧时/长任务），不以猜测开做 |
| 4 | 每壳内存研究 | 面板/实测定标显示 N=5 稳态内存不可接受，或需要按壳归因的统计 | 单 renderer 下无每壳字节读数；方向 = Electron `app.getAppMetrics()`（仅 Electron）与 DOM/节点计数代理，**不伪造**每壳字节；Swift 腿只有整机内存 |
| 5 | upstream freeze（vendor pin 升级冻结） | 常驻改造（D1–D4）未收口前冻结；出现上游安全修复/阻断则解冻单次并回归 | 避免 pin 升级把 vendor 隐藏壳行为/补丁面与常驻改造改动混进同一回归窗口；收口后按既有升级 checklist 恢复 |
