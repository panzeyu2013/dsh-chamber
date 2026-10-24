# TODO · 未排期计划与想法

> 本文件只记「未排期 / 未定稿」的计划与想法，**不记进度状态**；进度、验收门与取舍在 [STATUS.md](STATUS.md)，
> 双 flavor 差异结论在 [deviations.md](deviations.md)，契约在 `docs/design/`。
> 四部分：A 上游（A 类）、B 平台（B 类）、C 功能（C 类）、D 工程（D 类）。文中 `§N` 指本部分内编号；
> 跨部分引用写 `A§N` / `B§N` / `C§N` / `D§N`。
> 条目内的「剩余 / 未做 / 待…」是**计划范围**，不是进度状态；状态以 [STATUS.md](STATUS.md) 为准。
> 新增：先判断阻塞来源；设计定稿移入 `docs/design/0X-*.md`，落地或明确不做则移出并在 STATUS 留结论。

## 索引

|部|内容|入口|
|---|---|---|
|A 上游|13 条上游提案、漂移收口、UI 对齐、pin 升级管线|A§1–A§16|
|B 平台|macOS Swift 壳、Windows v1|B§1–B§2|
|C 功能|账户登录、侧栏 subagents、open-in 超集|C§1–C§3|
|D 工程|结构性重构、产物新鲜度、页面性能 P2|D§1–D§3|

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
|§7|子代理生命周期/完整性信号|上游提供完整性位/生命周期边沿|
|§8|载波 open 的稳定 episode 身份|上游提供 episodeId 或宿主期限|
|§9|桌面专属家族门按宿主能力|上游按能力门/加载期限收敛|
|§10|bundle rev 由内容派生|上游改内容哈希|
|§11|座席声明可转移|上游声明可委托/页面级座席|
|§12|workspace 删除 order/remove 原子化|上游原子化 order/remove|
|§13|插件管理页可嵌入|上游提供 surface=embedded|
|§14|漂移剩余、待退役块、工程债|打包态/下一 pin|
|§15|UI 对齐待裁与维持差异|下一轮 UI 裁决|
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

- 现状：dsh 无 delete-session、无归档可见查询；单条 `workspace.unarchiveSession` 已在 0.1.7 补齐；归档集在
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
  可见面/期限。曾评估 seed 包再断言 `api-session/status`（只覆盖可 seed 实例、需重启），暂缓。
- 开放：keepalive 的旧客户端兼容（未知 item 会被 `failAll` 关 socket）、隐私/体积、`session.list` 对账成本。
- 退出：上游落地 1/5/6 后删 chamber 写回与探针。

### 5. 图标资源 id 应实例私有（useId）

- 代码图标族已改 `useId`；仍写死文档级 id 的只剩 `BrandWordmark` 的 whale/badge clip 与附件
  `dshDropOverlayClip`。N-ctx 同文档重复定义，WKWebView 首次绘制可能整块失绘并缓存。
- 改法：两族也用 `useId()` 前缀，或 clip/mask 只依赖 viewBox/路径。chamber 侧 `svg-resource-scope.ts` 已改名
  自定∩自用 id；gateway/mobile 独立壳未覆盖。
- 退出：上游两族私有化后删 scope 缓解。

### 6. 会话状态的只读观察者与未读事实

- 现状：gateway watcher 需无界面进程观察完成边沿；当前靠 `$events` + 每条边沿一次 `session/follow` 读尾巴。
- 诉求：①`updatedAt` 语义契约（任意 durable 产出推进 ⇒ 可用内容水位判未读；或明确只用户消息推进）；②`turn/end`
  冻结 + 纳入 `API_REMOTE_FORWARDED_EVENTS`；③observer 角色或 `session/list` pending 投影（避免只读方撞瀑布）；
  ④宿主持久 per-session unread/pending 投影。
- 下游现状：chamber 已移除本地 durable 未读账本，权威 = 官方内存 `completionUnread`（重载即忘）；只读镜像协议
  单源 `session-state-protocol.ts`，watcher `packages/gateway/src/session-state.ts`。
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
- 改法：门改宿主能力就绪（`dshOnboarding`/configForms 有值）；loading 态给期限/error 收敛。chamber 侧已用构建期
  vendor 补丁关掉 `desktop-onboarding`，并从 DEFERRED 集群加载 `settings-account`；上游落地后
  删补丁门控。

### 10. bundle rev 应由内容派生

- 现象：`artifactRevision = sha1(mtimeMs, ctimeMs, size)` ⇒ 同内容跨宿主 rev 不同 ⇒ first-load-wins 报
  `instance-version-conflict`；重建后旧 URL 404，chamber 需一轮有界恢复。
- 改法：对 bundle 字节求内容哈希。退出：上游落地后删冲突诊断与恢复轮说明（保留超时/迟到语义）。

### 11. 座席声明应可转移

- 现象：`sidebar.session.row.leading/hover` 只能由注册所有者声明，实际渲染者不是它；chamber 自建侧栏不能转交
  声明 ⇒ 官方 schedule 行标记/悬停任务列表不渲染。现有解法 = 构建期删上游两行、chamber 自声明并渲染。
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

六组矩阵执行序见 `gui-acceptance-checklist.md` §4.1（P6、归档两段式+恢复、通知四缺口、运行位 60/190/310s、I-14
selection scope、I-12 谱系压制）；剩余 = 打包态/真机各跑一次并留记录。判据/关闭见 STATUS §1.1。

#### 14.2 待退役块（上游 wire 落地前不得删）

|块|规模|退役触发|
|---|---|---|
|`dsh-chamber-seed-archive-cleanup/src`（+~2490 测试）|~1560 行|`capabilities.json` → `sessions.delete(sessionId).retireWhen`|
|归档管理器逐条展开|~711 行|`sessions.deleteMany/bulk.retireWhen`|
|purge 墓碑机制|~588 行|同单条 delete|

判据门：`node scripts/upstream/verify-capabilities.mjs`（真实 vendor 树 6/6；上游落地即红，红即退役）。

#### 14.3 工程环境债

- 下一 pin 落地「真 `WorkspaceRegistry` + 真 binding」lockstep（当前 ad-hoc 8/8；CI 走 node_modules 解析）；复核
  vendor 补丁 retire 与 `RETIRED_PATCHES`（登记时 2 条退役：ReasoningRow sweep、util-values 比较）。
- `node-addon-require-builtin` 指纹表未收录 Electron 43.4.0 ⇒ Electron flavor 托管宿主起不来（STATUS 设计未决）。

#### 14.4 升级期检查两条闭口（待 vendor 物化）

- **P4 首屏 inject 闭合（并入 C4）**：对每个首屏 covered 行读 vendor client 入口 inject，断言成员由 covered id/factory/
  种子词提供；缺失即红（rc.2 `shortcuts` 事故）。阻塞 = 无「包名→client 入口」映射、worktree 无 vendor 树；前置 =
  在已物化 pin 上写只读探针 + 负例（`test:upgrade-tools`）。
- **P3 侧栏声明−渲染差集**：上游 `sidebar.*` 声明 − 本仓声明/渲染，逐条「已渲染/有意不渲染（带理由）/待裁」；
  按 `verify-mobile-anchors.mjs` 的 fail-soft + `--require-anchor-root` 落地。阻塞同 P4。
- 关闭：两条在某个已物化 pin 各跑通一次（含严格模式），负例覆盖「新增键被吞」与「改名假阳性」。

### 15. UI 对齐：待裁面与维持差异

判据口径：`SB`/`WS` = 安装包内未压缩 `ui-sidebar`/`ui-workspace` `lib/client.js` 行号；本仓 =
`packages/dsh-chamber-client-ui-sidebar`。已落地面见 design 06 §7、design 05 §2。

#### 15.1 待裁决

**U1 pinned（残余：块内拖拽 + 跨块守卫 + 账号写入）**

- 已落：写入口、三行面、置顶渲染分区（blank → pinned → 其余；manual 取宿主 pinned 序最近置顶在前，updated 用本仓
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

**U6 侧栏 More（rc.3）**：上游 entry-customization 向 `sidebar.panellist.actions` 注册面板 More
（只有 Browse/Create 两项；折叠视图行只属 conversation region，见 `EntryMenuContent.tsx` 的 `region === 'conversation'` 分支）；本壳未声明该洞、不渲染，`panel-pins.ts` 登记 `dropped`。候选 A 采纳
（声明洞 + 渲染 More + 消费面板 pin；侧栏新增内容须先交用户裁决）；B 维持不采纳（当前；gateway 官方侧栏仍显示）。
证据：`packages/dsh-chamber-client-ui-sidebar/src/client/index.ts` 子洞表、registry `dropped`。

#### 15.2 维持的差异与裁决

- **品牌**：mark 保持 chamber `BrandWordmark`（rail 用上游 FishLogo）；name 洞空回退（无构建版本事实）。
- **Windows 标题栏**：随 design 23 落地时照抄 `[data-windows-titlebar]`；属性已由 win32 preload 写入。
- **会话卡状态行 0–1**：不兜底 `status.idle`。
- **文案键**：搜索 aria 用 `search.sessions.aria`；workspace 复制用 `action.copy`；搜索占位/ tooltip 已逐字对齐。
- **workspace 卡**：维持标题+路径+创建时间，不加 chamber 会话数行。
- **路径/命中盒/菜单密度**：绝对路径不缩写；clear 钮 18px；`compact`（24px/11px，比列表行矮 2px），抬到 26px 用
  `Menu.listClassName`。
- **布局/交互**：26px 行/13px 标题/20px 命中盒、动作簇 4px/20px、来源 accent、折叠动画删除、`RowHoverCard` 自持、
  vibrancy 门、`sidebar.workspaces` 只声明、`toggle.badge` 不做、品牌蓝点、默认 manual（B1）、flat/tree/归档过滤
  per-source、`data-chamber-row`、归档两段式、面板轴入口按来源下挂。

#### 15.3 清洁项（非裁决）

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

> 来源 = alpha.3→alpha.4 五轴复核；不阻断合并，不弱化现有门禁；自动写锚只打印 diff。

- **16.1 update-vendor 首跑失败（M2）**：只切 submodule/`harness.commit`、不写 index gitlink，差量建链对拍失败；
  catch 指引与 checklist 相反。修 = step 5 专用豁免 `DSH_CHAMBER_VENDOR_SKIP_GITLINK=1` + 文案改 `git add` 重跑。
- **16.2 bundle:dsh ZFS EAGAIN（L1）**：`ERR_PNPM_EAGAIN` 失败、二次成功；修 = `bundle-dsh.mjs` 一次有界重试
  （staging 可弃、安装幂等）；hardlink 未实测，不推荐。
- **16.3 文档基线/手写计数无门（L2/L3）**：C10 不扫 docs；修 = docs 引 `harness.commit` 或计数进生成视图或 checklist
  加 grep；不建议并入 C10。
- **16.4 机械面单批管线（S1）**：16.1/16.2 + 由 tag 推导六锚/3 fork 字面量（打印 diff）+ `registry-views --write` /
  `verify:i18n --write` + 收尾 `verify-upstream-touchpoints`；不自动提交/改判据。
- **16.5 流程（L4）**：无 swiftc 先 `DSH_CHAMBER_SWIFT_PARITY_SKIP=1`；本地回归用 `run-checks tests --continue`（默认
  fail-fast 会掩盖后续步骤）。
- **16.6 预检 seam 不含相对深引（C16）**：只匹配裸说明符；chamber 经 `../../../vendor/...` 的 C16 深引不在内；修 =
  把 `vendorSourceConsumers` 相对 import 并入；checklist §7 第 8 步已加目检。
- **16.7 restore-lockfile 只增不减**：只复活旧 importer，新 specifier 边丢失时 frozen 失败且无修复；修 =「旧记录 ∪
  当前 package.json 新边」并集（多复活边会被 frozen 判红，fail-closed）。


## B. 平台与外部门禁（B 类）

> 阻塞来源 = 真机 / runner / 凭据 / 产物；每条须真实 macOS 或 Windows 验证。契约见 design 25、design 23。

### 1. macOS Swift 原生壳 v1

> 路线 A：Swift 写壳 + Node sidecar；契约见 `docs/design/25-macos-swift-native-shell.md`。本文只留双端验收协议/
> 中止条件与 W-xx 索引（代码与测试注释按编号引用契约）；开放门禁状态归 STATUS（矩阵 design 25 §8.5）。

#### 1.1 决策结果索引（D1–D7）

|决策|结果|契约|
|---|---|---|
|D1 路线确认 + P0 先行|按路线 A；G1–G5 + C1/C2 判定随 M5 复跑|design 25 §8.1|
|D2 双壳共存 + bundle id|共存；bundle id `com.dshchamber.native`（改动 = 通知授权重来 + 打包身份返工）|design 25 §1|
|D3 更新路线|v1 `blocked-available` 由 Sparkle 2 取代（D-1 = B）|design 25 §7|
|D4 仓库落位|`macos/`（SwiftPM，同 design 25 §3.2 布局）|design 25 §3.2|
|D5 原生 UI 渐进（路线 B/C）|不做；HostEdges 边界即未来接缝|design 25 §5|
|D6 Node 版本/架构/来源|构建期 fetch 固定版本 + SHA-256 校验（`DEFAULT_NODE_VERSION` 24.18.1，大版本对齐 Electron 43.4.0 内置 Node）；v1 arm64-only|`packages/desktop/scripts/build-sidecar.mjs`|
|D7 静态凭据加密|不做：诚实 0600 明文 + 旧 safeStorage「保留禁用待重录」|design 25 §6|

#### 1.2 待验收门禁

- M5 实机门禁 W-28…W-32：状态/范围见 STATUS「macOS Swift 原生壳」条；矩阵 design 25 §8.5，判定标准见 §1.7。
- 双端 harness 未实施：`swift-harness-driver.test.ts`（真实窗口/桥/通信/深链）需 GUI 会话，不进普通 push 链
  （design 25 §8.3/§8.6）。
- A6 外部阻断：Apple 凭据（Developer ID 签名/公证/stapler）缺失时 dry-run 全链绿即可推进代码，但不得声称
  「完成」（design 25 §7）。
- 其余实机项（通知权限时序、SMAppService 登录项、LaunchServices 深链、唤醒恢复、SSE/WS 心跳、ATS、通知音效差异）
  在 STATUS 未完成项。

#### 1.3 WBS 任务号索引（W-01…W-32 → 契约落点）

|任务|内容|契约落点|
|---|---|---|
|W-01/W-02|M0 决策包签核与文档同步|§1.1、design 25 §0.1|
|W-03|Swift 壳脚手架（Package.swift/main/AppDelegate/MainWindowController）|design 25 §3.2、§8.1|
|W-04|A 桥雏形（shim 注入/MessageHandler/TrustGuard/bridge-shim.js）|design 25 §4.4.1、§4.4.3|
|W-05|竖切（AnyCodable/FrameCodec/BridgeClient/sidecar-stub + 集成测试）|design 25 §4.4.2、§8.1|
|W-06…W-08|P0 走查与门禁（G1–G5、C1/C2 判定）|design 25 §8.1|
|W-09/W-10|core seam（node-edges/shell-core/IPC 面镜像与「core 禁 electron」门）|design 25 §4.1|
|W-11/W-12/W-13|sidecar 入口与 stdio JSON-RPC（sidecar-entry/sidecar-ctx/bridge manifest 管道）|design 25 §3.2、§4.1|
|W-14|Electron 零回归证明（分层 gate）|design 25 §4.1、§8.2|
|W-15|SidecarSupervisor（退避重启 + 退出码分级）与目录锁|design 25 §3.3、§6.3|
|W-16|B 桥客户端（FrameCodec 协议 + 连接生命周期）|design 25 §4.4.2|
|W-17/W-18|bridge-manifest 生成物（JSON + Swift 白名单 + stub）+ shim 表面锁步|design 25 §4.4.3|
|W-19/W-20|HostEdges 原生腿（SwiftEdgeHostLegs：对话/面板/文件/通知）|design 25 §5 E1–E20、§4.5|
|W-21|窗口/菜单/通知/深链/渲染器恢复（MainWindowController/RendererRecovery）|design 25 §4.5、§5|
|W-22|更新 v1（blocked-available）→ 由 Sparkle 取代|design 25 §7|
|W-23/W-24|sidecar 打包（内建 node + dist/web）与 .app 组装/Info.plist/ATS|design 25 §3.2、§4.3|
|W-25|Sparkle 预研 → S-01 实现|design 25 §7|
|W-26/W-27|CI（ci.yml `test-macos`）与发布产物（`-native` 命名、appcast、回滚）|design 25 §8.4|
|W-28…W-32|M5 实机门禁与验收|design 25 §8.5；开放状态见 STATUS|

#### 1.4 双线防漂移门禁清单（压缩索引；断言细节见各文件与 design 25 §8.4）

|门禁|落点|断言什么|
|---|---|---|
|IPC 面镜像锁步|`packages/desktop/test/ipc/ipc-surface-mirror.test.ts`|main handle/send 集合 == preload invoke/on 集合；无裸字面量；preload/renderer global.d.ts/settings-connections 结构镜像|
|bridge-manifest 一致|`bridge-manifest.test.ts` + `packages/desktop/scripts/emit-bridge-manifest.mjs` + 提交物 JSON/Swift/stub|重生成 == 提交物；通道数守恒 70=61+9；manifest 只承载通道 + 方向|
|A 桥 shim 表面|`bridge-shim-surface.test.ts`|shim 每个命名空间方法集 == preload；method→channel 映射一致；无 W-04 别名残留|
|A 桥 stub 锁步|`bridge-shim.test.ts`|重生成逐字节 == 提交物；invoke/push 计数；信封 `{id,method,payload}`|
|core 禁 electron|`electron-free-gate.test.ts`|fail-closed 传递闭包：core 家族无 electron import；白名单四文件有|
|sidecar 全通道冒烟|`sidecar-stdio.test.ts`|假 Swift 驱动 52 invoke 回包 + 9 push 面的代表采样（真处理器）|
|release 腿策略/打包清单同源|`scripts/release/release-workflow-policy.test.mjs`、`packaging-manifest-lockstep.test.mjs`|staple 先于归档；`ARTIFACT_ARGS` 展开恰 2 次；产物名 `dsh-chamber-<ver>-macos-arm64`；host 包清单五处一致|
|Swift 负例护栏|`macos/Tests`（XCTest，ci.yml `test-macos`）|伪造 frame/超大帧/非协议流/伪造事件名/越 origin 全拒|
|双端 harness|`swift-harness-driver.test.ts`（未实施）|真实窗口/桥/通知/深链（需 mac + GUI，见 §1.2）|

Swift 产品代码**禁止**手写通道字符串（测试 fixture 除外）。通道增删改 = 一次 PR 内三侧同改：
`ipc-events`/preload（+ renderer 镜像）→ bridge-manifest 重生成 → Swift 引用点。

#### 1.5 同 tag 双端发布：回滚预案

流程本体（凭据 fail-closed 门、两条 mac 腿、Swift 腿命名与独立 EdDSA appcast）见 design 25 §8.4 与 release.yml。
回滚：Swift 产物出问题 ⇒ draft 不 publish、Electron 照发（共存主通道，Swift 可晚一 tag）；Electron 出问题 ⇒
同 tag Swift 不单独发（防版本错位）；Win/Linux 不受影响。

#### 1.6 风险与中止条件

**风险登记**（design 25 §9 R1–R13 的展开；措辞以 design 25 为准）：

- R10 开发期双后端竞态：Electron dev（17520 起探测）与 Swift dev 共享控制面起始端口族 ⇒
  `DSH_CHAMBER_CP_PORT`/`DSH_CHAMBER_SHELL_PORT` 分别钉死 + 双 userData（或先后启动）。
- R11 人手单点：壳 + 桥 + 护栏 ≈25–35 个 Swift 文件长期维护；缓解 = 护栏集中单 target、XCTest 覆盖率门、
  Generated 产物。
- R12 manifest 生成脚本解析脆弱性：新写法（模板串/别名）漏检 ⇒ 生成脚本复用 mirror 解析 + 「通道数守恒」断言（70=61+9）。
- R13 devtools：默认关；发布态由设置页运行期开关显式开启（design 25 §5.1.1）。debug 构建的默认开只在
  「无设置文件或文件级损坏（不动作）」时存活；合法文件（哪怕缺 debug 键，按 Electron 默认 false）会覆盖它。
  inspector 属信任边界。

**中止/回退触发点**（任一失败即回 design 25 §10 决策 1 重审，不硬着头皮继续）：

- A1：P0 G1 主界面实质功能缺口（非 minor 样式）⇒ WKWebView 承载面证伪。
- A2：P0 G2 剪贴板/拖拽硬伤（W1/W3 不过；G3=侧栏插件不受影响）⇒ 试 1–2 天归因，仍不过重审。
- A3：B 桥护栏负例被击穿（伪造 frame/超大帧/非协议流/伪造事件名任一）⇒ fail-closed 信任模型不成立：
  立即停止，P2 出口前必须闭合。
- A4：P1 拆分后 `test:desktop` 连续 2 批不收敛绿 ⇒ 回退上一绿 commit 重排批次。
- A5：M3 双端 harness 真实窗口不稳定（排除环境后 >1 周）⇒ 重审壳层策略（Electron 退守不受影响）。
- A6：M4/M5 发布门因 Apple 凭据缺失挂起 ⇒ 不中止路线：dry-run 全链绿即可推进代码，发布登记外部阻断，
  不得声称「完成」。
- A7：P4 性能基线结构性不达标且非修复可解 ⇒ 回 D1 重审。
- A8：bridge-manifest 生成物 ≠ 提交物连续 3 个 PR 反复红 ⇒ 暂停 Swift 大 PR，先修 manifest 流程。

#### 1.7 WKWebView 实测项 W1–W7 判定标准（M5 / W-29 用）

|项|过|不过|不过处置|
|---|---|---|---|
|W1 剪贴板（富文本复制/粘贴）|会话复制富文本（代码块/表格）粘贴进外部富文本 app 保结构；页内粘贴正常|仅纯文本/结构丢/粘贴被吞；或写剪贴板需弹权限而 UI 无流程|归因（渲染 vs 权限），修复预算 ≤2–3 人-日；超预算或 P0 期失败→中止 A2|
|W2 菜单快捷键|Cmd+C/V/A/全选与 Electron 一致|快捷键无响应（first-responder 断）|必修（design 25 明示）|
|W3 富文本粘贴 + 文件拖拽|拖文件进 composer 成附件；拖进归档对话框入口可用|拖拽无反应或触发导航|同 W1|
|W4 打印/查找|Cmd+P 弹系统打印对话框且内容合理；Cmd+F 若 dsh UI 未实现查找则 N/A（登记不视为失败）|打印无对话框/空白|N/A 不阻断；真失败按渲染差异排查|
|W5 字体/滚动/IME|中文输入无吞字/乱序；长会话滚动无感卡顿；无方块字|IME 丢字；滚动明显劣于 Electron；字体破损|归因 WebKit 渲染差异→按 W1 预算|
|W6 后台节流对 SSE/WS|隐藏/失焦后 SSE/WS 心跳不断、恢复即时（≤现 Electron 语义）|后台 WS 掉线且无法自动重连或恢复 >30s|归因 WebKit 节流→改 keep-alive/唤醒补发（core 具备）|
|W7 刷新率三工况|打包态：插电 120fps；电池 + 低电量模式 60fps（系统级帧间隔 ×2）；60Hz 外接屏不回退|任一工况达不到，或启动日志与 `[shell-fps]` 实测矛盾|归因（渲染侧偏好 vs 系统节流）；日志标「面板上限」时以 `[shell-fps]` 实测为准；判据见 design 25 §5.1/deviations S-48|

#### 1.8 双端性能与产物体积验收协议（P0 预检 / M4–M5 定标）

> 同环境 A/B 纪律见 `scripts/perf/README.md`：前后对照**只**在同环境 A/B 内可信，跨环境绝对值**不可比**；
> 双端对比必须同机、同脚本顺序、同会话窗口，数据落 `scripts/perf/data/*.json` 同族。

方法学平移（不换尺）：`scripts/perf/{boot,switch,eval,cdp-lib}-measure.mjs` 为 CDP 驱动（Electron 专属）；
Swift 侧以 **WKUserScript 注入同一套 PerformanceObserver 探针 + `evaluateJavaScript` 驱动合成 MouseEvent**
（同源、引擎无关），四场景平移：boot（wall/长任务/CLS）、跨来源切换、rapid×10 连点、eval 归因；
驱动与 schema 双端共用，差异只在注入通道（CDP ↔ WKUserScript）。

|形态|指标|建议预算（P0 首测后校准，不作跨环境承诺）|
|---|---|---|
|相对门（同机 A/B）|boot wall/切换/rapid×10|原生 ≤ Electron × 1.3/× 1.5（长任务与 CLS 结构只登记不设硬门）|
|绝对预算|IPC invoke p95（60 通道抽测代表组）|≤ 20ms|
|绝对预算|事件推送突发|100 事件/秒不丢序（core 有界队列语义）|
|能力门|后台隐藏 ≥30s SSE/WS 心跳 + 唤醒恢复（C1）|心跳不断、恢复 ≤ 现 Electron 语义；不过→keep-alive/唤醒补发，登记已知降级或修复|
|能力门|内存峰值/空闲唤醒次数与进程数|内存 ≤ Electron × 0.7；进程数/唤醒登记对比|
|能力门|产物体积（M5 定标；M0 起可 dry-run 先采 Electron 基线）|.app 安装体积/dmg/zip/磁盘展开 ≤ Electron × 0.75（口径 `du -sh` + 文件大小）|

数据纪律：P0 只做「数量级异常预检」（灾难性回归早暴露，不定标）；正式定标 M4/M5；跨会话/跨环境数字不得直接作差异结论。

#### 1.9 工具与 dev 侧约定

- ATS：dev 态以 `NSAllowsLocalNetworking` 放行 loopback（生产同值）；WebView 只加载控制面 origin。
- dev 后端：Swift dev 用 `DSH_CHAMBER_SHELL_PORT` 钉死的控制面 + `dsh-chamber-dev` userData（与 Electron dev 的
  `.dev-user-data` 隔离，见 `deviations.md` §3 P-10）。
- 工期估算（三档人-日）与里程碑排期不在本文；量级与关键路径见 design 25 §0。

### 2. Windows v1

> 契约与决策：`docs/design/23-windows-support.md`。本文只留未实现/外部门禁、基线登记口径与取舍；
> 每条须真实 Windows/CI 验证才算完成。

#### 2.1 外部门禁（需真实 Windows runner / 实机 / 产物）

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

#### 2.2 基线登记口径（M0 首跑后填写）

> 用途：Windows 首版修复前基线。第一次 `test-windows` CI 腿跑绿后，把每个测试在 win32 的 pass/skip 集合与每个
> 平台门控的拒绝行为填入下表；此后每个里程碑的 win32 测试变化必须对照本表归因（diff = 预期解锁集，不允许
> 「顺手改绿」）。行号以登记时快照为准，失效后以测试名/描述为锚。

|套件|win32 pass|win32 skip（含文件:行理由）|首跑日期/commit|
|---|---|---|---|
|test:runtime|待填|待填|—|
|test:control-plane|待填|待填|—|
|test:desktop|待填|待填|—|
|test:gateway|待填|待填|—|
|typecheck 全组|待填|—|—|

**已知 skip 清单（翻转前的登记快照）**

|位置|内容|翻转后去向|
|---|---|---|
|control-plane `test/protocol/protocol.test.ts` L738/822/865|Unix detached 进程组契约|win32 等价测试（M1 `win32-lifecycle.integration`）或 POSIX-only 注释|
|dsh-runtime `test/install/runtime-installer.test.ts` L547-686 等、L365|进程组契约/不可变树/symlink fixture|实现类（树回收/清属性）后 win32 等价；symlink 类标 POSIX-only|
|dsh-runtime `test/store/metadata-authority.test.ts`（含 authority-reader symlink、replaced-parent 用例）、`snapshot-store` L398/554、`known-good-monitor` L162、`metadata-recovery` L522/672/733/881、`dsh-runtime-store`（eviction 只读不可变树、原 L440-527/L950）|symlink/权限/只读不可变树 fixture|junction 或普通文件替代后 win32 等价；eviction 由 `win32-readonly-rm` 决策门（清属性实现或 Node rm 自带）决定|
|desktop `test/plugins/plugin-sync-apply.test.ts`（reaper fail-closes on PID identity reuse/kills a daemonized descendant）|本地插件写进程 reaper 杀死守护化后代（进程组契约，POSIX-only）|M1 等价实现：`taskkill /T /F` + CIM 残余清扫（win-probes/win32-lifecycle）|
|gateway `test/auth/store-permissions.test.ts`（0700 组）|POSIX 0700|有 win32 ACL 保留测试替代，保持 skip|
|control-plane `test/host-lifecycle/reaper.test.ts` L95|symlink fixture（权限与平台相关）|POSIX-only 注释|

**平台门控拒绝码基线（现状断言，翻转时逐个销号）**

|门控|现状（win32）|断言位置|目标|
|---|---|---|---|
|dsh 运行时 mutation|`platform_read_only`|gateway runtime-manager；desktop `runtimeManagementSupported=false`（env `DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1` 开启验证态）|desktop 解锁（仅 M2a 真实 win32 验证后，M2b）；gateway 保持|
|SSH 密码|IPC 拒存（引导 keys/Pageant）|`ssh-provider.ts` sshPasswordSupported/main 门消息|保持；一键免密 UI = 后续特性|
|登录自启|已解锁（代码）：supported=true、`setLoginItemSettings`（HKCU Run）|`chamber-settings.ts` computeSupported/`main.ts` applyLaunchAtLogin|runner/实机验证注册表与卸载清理|
|深链注册|已解锁（代码）：打包态 register(no-args)，dev skip|`deep-link.ts` decideDeepLinkProtocolRegistration|runner 实测注册表 + 冷热启动|
|open-in 本地路径|已解锁（代码）：local 走 validateLocalPath（盘符/UNC）|`open-in.ts` runOpenInLaunch/finder|实机盘符路径打开验证|
|0700/0600 语义|继承 ACL + no-follow/identity + icacls 启动收紧|store-permissions/private-file/win-acl.ts（main 已接线）|runner/实机 ACL 查询核对|

#### 2.3 仍生效的取舍

取舍唯一权威是 `docs/design/23-windows-support.md` §5「妥协点（发布附注，唯一权威）」与
`docs/progress/STATUS.md`「范围决策与必要取舍」：F1 无进程组等价、能力先于开关（M2a 前只读/禁用）、
Windows ACL 权限语义、C16 凭据仅内存、未签名发布身份均登记在彼，本文不复述（避免第三份副本漂移）。


## C. 未实现功能想法（C 类）

> 阻塞来源 = 产品优先级/需求触发；未排期。设计定稿移入 design，落地或明确不做则移出。

### 1. 账户 / 登录面（DeepSeek 账号 + 余额）

> 优先级：**低优先，未排期**。触发条件 = 出现「要用官方 DeepSeek 账号的凭据/额度给 dsh 用」的真实需求
> （API key / 自定义 provider 路径不受影响）。状态权威：STATUS「桌面 flavor 账户登录不可闭环」条。

**目标**：在具备账户能力的来源的设置面板内提供完整回路：未登录 → 登录（浏览器 PKCE）→ 等待浏览器 →
已登录（资料 + 普通/赠金钱包 + 充值·用量外链）→ 退出。凭据只落在**该来源宿主**的凭据库
（`dsh-credentials-local`），渲染端只见 profile / 余额，不碰 token。

**非目标**（三条路都不做）：官方桌面首启浮层（`desktop-onboarding`）、`WelcomePage` 欢迎页、Electron
`account-backend.ts`、应用内平台视图（`platform-view.ts` WebContentsView）、`dshDesktop` 载体扩展、
把账号 token 带进渲染端。

**现状**

- **UI 已接入**：官方 `@deepseek-ai/dsh-client-ui-settings-account` 行由复合壳 DEFERRED 集群加载
  （covered+deferred）。构建期 vendor 补丁把桌面 `shell.overlay#desktop-onboarding` 及其
  `desktopOnboardingVisible` 初值门控为 `globalThis.__dshChamberAccountOverlay === true`（默认关闭），
  设置分节与 `settings.models.sign-in` / `shell.quota-notice` / `settings.launcher` 座位随之注册。
- **桌面 flavor 登录仍不可闭环**（STATUS 已登记，静态链实证）：`desktop=true` 下客户端不打开授权页；
  回调 origin = 控制面 origin，而 `/oauth/callback` 只注册在实例 host、控制面对未知路径走 SPA 回退
  （仅反代 `/api/i/<id>/*`）；`settings.launcher` 座在被设置壳阴影后无渲染点。**待做** = 控制面根路径
  `/oauth/callback` → 活动实例反代 + 可达 origin（多实例归属需裁决）。web/gateway flavor 不受此限。
- **凭据配置**当前仍走 models API-key 路径（不受影响）。

**关联**：`docs/design/09-client-plugin-runtime-loading.md` §3.5③（补丁门控与 Rejected alternatives）、
`docs/design/05-connection-manager.md` §5（分节注册形状）、§7.4（传输 URL 不进 renderer）；
上游最小改法见 `TODO.md` A§9。

### 2. session 的 subagents 在侧边栏中的显示

> 未设计、未排期。

**动机**：侧边栏现只展示 session/workspace 行（`docs/design/06-sidebar-enhancements.md`）；
会话运行时的 subagents（子代理）仅会话内可见，望侧边栏给出子层级/计数/状态。

**现状对照**

- 侧边栏 = 每来源分组 + workspace/未分组桶 + session 行（06 定稿）；行尾状态槽表达 running/completed/pending。
- 计数/状态解读由 06 §4.5 的 `runningSubagents` 计数徽标承担（会话行尾「N 个子代理运行中」圆环 + tooltip，
  经运行时事实通道上报；逐父会话计数经 vendor `indexSubagentDescendants` 路由）。
- 剩余开放（06 未做）：会话行下嵌套子层级（subagent 行缩进显示其状态/会话）、层级折叠/截断、跨会话总览视图。
- 宿主覆盖（原「需调研」项）：逐子代理的可浏览行级列表面仍不存在（未发现其他命名暴露逐项事实的 wire/store/UI）；
  形态评估（chamber 插件 vs 不做）按 08 先例留待设计。

**开放问题（设计时再定）**

- 事实来源与拉取节奏：聚合轮询 / 运行时通道（06 §4.2 chamberBridge runtime report）/ 会话详情按需。
- 呈现形态：会话行下嵌套 subagent 行（缩进）、行尾徽标计数，还是仅当前会话内面板（会话内若已有，侧边栏是否必要）。
- 层级深度（subagent 的 subagent）与大量 subagent 时的折叠/截断。
- 跨来源投影（远程实例的 subagent 在本地侧边栏的呈现）与断连清理。

**关联**：`docs/design/06-sidebar-enhancements.md`（侧边栏形态、运行时事实通道）；STATUS「不做（v1）」清单。

### 3. open-in：超集分批（S1/S2/S3）与降级留档形态

> fork & supersede 的契约见 `docs/design/20-open-in-registry.md`（§4 契约、§6 host 包与八处接线、§8 文件清单、
> §9 验证门）；实机验收与实施后开放项在 STATUS（design 20 §1 指向）。本节只留未排期超集分批、不做的边界与
> 两份降级留档形态。

#### 3.1 超集分批（S1/S2 未排期；S3 残余待裁；S4 不做）

每批独立 PR、各自测试、不引入新运行时依赖。优先级与范围：

- **S1 远程 provider 家族**：主进程 open-in 注册表（`packages/desktop/open-in.ts`）当前只有 vscode；待加
  Insiders/Cursor/Windsurf/JetBrains Gateway/`ssh://` 终端——只构造 URL 交 OS、不启动进程；每项需实机 scheme
  语义验证。实例侧本地目录（`packages/dsh-chamber-seed-open-in` 的 catalog，34 个 id）已覆盖这些应用，但与
  主进程远程注册表不是同一面。
- **S2 远程文件级打开**：远程来源允许文件路径（纯 URL 构造，不经 host 包）；本地仍目录限定。
- **S3 复制路径（残余）**：工作区悬停卡已复制 `workspace.path`（`ServerSection.tsx` 的
  `copyText`）；会话行仍只复制标题（`ServerSectionRows.tsx`），待补 `cwd` 复制或裁决只保留工作区。零新 IPC/
  依赖；「复制 `ssh user@host`/复制 VS Code 深链」不做（结论在 STATUS「open-in 超集口径」条）。
- **S4 多入口**：不做（理由登记 STATUS）：header 按钮与目标会话同排相邻，侧栏入口边际价值有限；会话行动作
  在行菜单（置顶/重命名/分叉/归档）+ 行内悬停归档钮与置顶钮（`packages/dsh-chamber-client-ui-sidebar/src/client/ServerSectionRows.tsx`），
  新增入口要么重复要么推翻它——不要把「会话行刻意没有 kebab」当理由（该行自 T2a 起就有 kebab；刻意无 kebab
  的是 worktree 派生的 workspace 行）。快捷键缺基建（vendor 无 keybinding 注册表，只有聊天输入框 keymap），
  自建 document 级监听还要处理「哪个 entry 是活跃视图」与 chord 冲突。

#### 3.2 边界（不做，登记在 design 20 §7.3）

- 远端宿主侧打开（需 ssh/http cookie 注入 + UI 明示，与「远程只用 vscode 部分」契约冲突）；
- fork 官方 catalog 再扩本地应用集合之外的本地执行面（如「在终端里打开」的本地实现）；
- 主进程自行枚举本机应用（重开 Batch 3 Phase 2 关闭的红线）。


## D. 工程债（D 类）

> 阻塞来源 = 工程优先级（重构/性能/门禁）；未排期。范围 = `packages/**`；行数单一来源 =
> `scripts/gates/file-budgets.json`；核心指标 = 消除补丁式修改（根因、单源、先锁后删）。

### 1. 结构性重构与清理

#### 1.1 开放工作（按优先级）

|#|工作|现状|验收判据|
|---|---|---|---|
|1|三处 state/ref 镜像：`packages/dsh-chamber-client-ui-sidebar/src/client/sidebar-root-projection.ts`（serversRef）、`packages/renderer/src/components/InstanceView.tsx`（activeRef/settledRef）、`packages/dsh-chamber-client-ui-settings-bridge/src/client/DshRuntimeSection.tsx`（confirmLaunchRef）|未收口（其余已收口，基线在 git 历史与各 host store 注释）|渲染值走 useSyncExternalStore 小 store（单源）、事件回调读 store 的 getSnapshot()，删 ref 镜像；不引入状态库/新包|
|2|settings 两分支合流：`DshRuntimeSection` 的 gateway/local 共享 controller|未动|runtime-management / 设置桥套件绿；先补 parity 测试再合并|
|3|逐包棘轮收尾：`file-budgets.json` 的 16 个文件只降不升|逐轮下降中|`verify:file-budgets` + `check:static`/`check:tests` 恒绿|
|4|§1.5 的审计开放项|未动|各自条目内|

#### 1.2 已核结论（不再排期）

- **跨包逐字重复**：见 §1.6——既有约束下**可删 0 组**，登记而非强改。
- **vendor 声明成员并集**：上界 ≈100 行、需动 8 个 tsconfig，ROI 低 → 不做（入档）。
- **有意的保留**：安全清理类残留（`.tmp` 残留 / askpass 旧目录 / autostart）保留，不删。

#### 1.3 门禁与用法

- 证据选择：`node scripts/gates/run-checks.mjs <static|tests|typecheck|full>`（`--list` 看完整计划）——
  模式名与 ci.yml / release 验证一致，本地通过即同一份证据。
- 本重构相关三门：`verify:import-cycles`（值环 0 + 类型环 allowance——现为空）、`verify:file-budgets`
  （16 个 God 文件只降不升）、`verify:no-dead-exports`（零消费者导出即红）。
- 执行面：`verify:import-cycles` / `verify:file-budgets` 及包边界门 `verify:package-boundaries` 在本地、
  普通 CI、发布验证同跑；`verify:no-dead-exports` 仍为本地辅助门。`static-gate-parity` 校验两侧集合，
  架构三门不得进入本地专属豁免。

#### 1.4 边界与不做

- 不新增 utils/抽象包；不引入状态库；不做全仓重写。
- 不动 design 14 会话权威链、上游 fork（dsh-client-connection / dsh-client-web / dsh-api-gateway / vendor）、
  Swift 业务面与已移出项（design 01 §4/§5）。
- 不把「再导出/转发」当成减量；不把格式化折叠当减量。

#### 1.5 审计开放项（未排期）

- **renderer reconnect 记账**：`App.tsx` 的 `retireSources` 仍缺 `sessionListRefreshAt/Pending`、
  `authoritativeArchiveSet`（同 id 换代泄漏）。收口 = 单一 `reconnectSource(id)` + 生命周期参与者注册表。
- **session-state 语义多实现**：协议在 control-plane（`session-state-protocol.ts` + `session-mux.ts`）、
  gateway（`session-state.ts`）、renderer（`session-facts-source.ts` + `source-mux-facts.ts`）各有一份；
  守卫/助手跨包重复（登记时 `isWatermark` 命中 11 个文件、`isPlainRecord` 7 个），锁步只有源码文本测试；
  `classifyTurnEndWire` 仍与 `classifyTurnEnd` 成对。死面已部分消失（`effectiveReadMark`、
  `SESSION_STATE_PROBE_TIMEOUT_MS` 已不存在），仍在的 `sessionStateNoteKey` / `SESSION_STATE_ROUTES`
  由单测锁住。收口方向 = 共享协议叶子（或生成物）+ 删死面。
- **插件三链路流水线**：local/ssh/gateway 各自 validate→confirm→remove/add→restart→verify；desktop
  `plugin-sync.ts` 与客户端行投影（settings-connections 的 `plugin-model.ts`/`save-host.ts`）仍两套。
  收口方向 = 一个 `PluginMutationPlan` + 三个薄执行器。
- **未纳棘轮的 god 文件**：control-plane `index.ts`/`proxy-forward.ts`/`spawn-dsh.ts`、gateway
  `dispatch.ts`/`plugins.ts`、dsh-runtime 多个 `runtime-*` 文件、desktop `updater.ts`/`main.ts`、Swift
  `MainWindowController`/`AppDelegate`/`BridgeClient`、`install-gateway.sh`——下一轮按包逐个纳入棘轮。
- **死导出门覆盖洞**：client-ui 包整包在 `RUNTIME_LOADED_PACKAGES`（`verify-no-dead-exports.mjs`），
  `./client/**` 不受判；已知零消费者导出 `isFixedSectionId`、`transportTargetChangedSpec`
  （`sourceFingerprintIsCurrent`/`staleOwnedSessionIds`/`orderApplyOps`/`BATCH_FAILURE_POLICY` 已随实现消失，
  勿再寻找）。
- **真实第二实现**：`openPromise` 三态证据在 mobile `session-stall.ts` 与 open-in
  `session-stream-health-probe.ts` 仍是两份；`safeStorage` 访问器 5 份（gateway-provider / host-assembly /
  main / registry-projection / sidecar-ctx）；spec 分类的客户端对照文件（原 `plugin-diff.ts`）已不存在——
  下一轮先重新取证再收口。
- **client/seed god 文件与形态**：`PluginDialog.tsx`（约 32 个 useState）、`ConnectionsSection.tsx`、
  `ServerSection.tsx`（JSX 内派生状态残留）等已在棘轮内；`packages/dsh-chamber-seed-git-worktree/src/core.ts`、
  `packages/dsh-chamber-seed-archive-cleanup/src/core.ts`、`packages/dsh-chamber-client-ui-mobile/src/client/composer.ts`、
  `packages/dsh-chamber-client-ui-mobile/src/client/styles.ts`、`packages/renderer/src/live-graph.ts` 待下一轮裁决是否纳入棘轮。

#### 1.6 跨包逐字重复复核（口径与结论）

- 口径：多行函数体（≥3 行）逐字相同且跨包为重复；台账只统计较大函数体，两者差异属**口径**而非新增重复。
- 结论：在既有约束（不新增抽象包、不动 fork、不引入反向依赖）下**可删 0 组**，登记而非强改。唯一成组的是
  control-plane `win-probes.ts` ⇄ dsh-runtime `windows-process.ts` 的 parity 锁
  （`test/protocol/win-probes-parity.test.ts` 钉住，删除即红）；其余为 3–5 行守卫/错误串助手与 fork 内部重复。

#### 1.7 未删项与判面/锁步依据（非漏做）

- `sessionStateNoteKey` / `SESSION_STATE_ROUTES`：单测锁住读水位规则与路由字面量；需先做 §1.5 的 session-state
  协议单源，否则删除只减锁不减实现。（`effectiveReadMark` / `SESSION_STATE_PROBE_TIMEOUT_MS` 已不存在，勿再寻找。）
- `pendingStats`（现 control-plane `dsh-client.ts`，原 gateway）：已注释的测试诊断缝，删除即失去 settle-once
  覆盖——属 seam，不是未接线泄漏。（原条目中的 `deferredIntentsFilePath`/`plugins-tasks.ts` 已不存在。）
- `transportTargetChangedSpec`（settings-connections `save-host.ts`）：跨端镜像缝，删除即失去覆盖。
- `dsh-stream-state/swift` 的 Swift 镜像现只剩 `CarrierDecision.swift`；`LoadState` 镜像已按 design 14 §D4 退役，
  勿再寻找。
- client-ui `./client/**` 仍在死导出门判面之外（整包在 `RUNTIME_LOADED_PACKAGES`）：扩判面需逐包注册客户端半
  seam，独立一轮。
- `safeStorage` 访问器 5 份 / spec 分类两套 / session-row 三转换 / reconnect 第四臂：属 §1.5 单源条目，
  需各自先补跨端锁步测试。

### 2. 产物新鲜度守卫（G2/G3/G5/G7/G8；未排期）

> `desktop/dist/control-plane/**`（标记守卫）、`gateway/dist/**`（标记守卫）、
> `gateway/host-packages/dsh-chamber-client-ui-mobile/**`、`desktop/dist/preload.cjs`、
> `renderer/src/generated/**` 与 `gateway/dist/index.js`（用包自身 build.mjs 重建-比对）已有「陈旧/缺失 ⇒ 红」的
> 比对门（`scripts/gates/verify-artifact-freshness.mjs` 的 tests/full，经 `ci.yml` 进 CI）；seed `dist/index.js` ×4 +
> `dsh-runtime/dist/index.js` + mobile `dist`/`lib` 的新鲜度归 C8（`scripts/upstream/verify-upstream-touchpoints.mjs`
> 重建-比对，清单单一来源 `scripts/lib/build-artifacts.mjs`）；`scripts/gates/verify-electron-artifacts.mjs`
> 的 macOS 腿/CI 另执行编译产物冒烟。G1=`verify:test-wiring`、G4/G6 同属该门。本节只留仍无守卫的产物与最小
> 守卫建议；开放状态见 STATUS「产物新鲜度」条，design 21 §7 登记。

#### 2.1 仍无守卫的产物

|产物|生成者|提交？|当前守卫|陈旧后果|
|---|---|---|---|---|
|`packages/desktop/dist/web/**`|renderer `build`（vite `build.outDir = ../desktop/dist/web`，三处路径契约见 `packages/desktop/scripts/electron-shared.mjs`）|忽略|只有路径契约文本断言（`scripts/electron-shared.test.mjs`）与 CI 的 scoper 标记断言|打包发行旧前端壳（IPC 名/槽位可能漂移）|
|`packages/desktop/dist/host-{graph,git-worktree,archive-cleanup,open-in}-package/**`|`scripts/build-host-graph-package.mjs`（各 seed 包 `dist` cpSync）|忽略|只有行序/outDir 断言（`scripts/release/packaging-manifest-lockstep.test.mjs`）|打包 seed 旧宿主包|
|vendor `allowBuilds` 锁步（根 `pnpm-workspace.yaml` ↔ `packages/dsh-runtime/src/allow-builds.mjs`）|人工同步|提交|无|新增原生依赖漏登或漏 deny 会静默漂移|

`dist/` 整族在 `.gitignore`：干净 checkout 的「缺失」是正常态——首批 host/dsh-runtime/mobile 产物须先由
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

> 本文件只承载 2026-02 页面侧性能修订（A1–A6）中**未实现**的 P2 三项（侧栏 T2、factAt 量化、前置仪表）；
> 已实现部分的契约见 `docs/design` 的 05 §3（发布门与投影缓存）、14 §8（隐藏期不采样）、19 §3.2.4（桥探测长尾）、
> 24 F5（purged 孤儿键收敛）。三项都保留证据与设计以便下次决策，落地前不进入任何提交面。

#### 3.1 侧栏 T2：更细的上下文拆分与按来源缓存

**证据（代码）**：sidebar 的行状态把 menuOpen/renaming/rowErrors 与全量字段 ctxValue 放在同一条更新通道上，
任何一处的交互都会走到全部 ServerSection 与全部行；搜索通道（client-core 的 search-state.ts）每个按键立即
notify，menus.ts 与 ServerSection.tsx 都订阅它，所以一次键入会重渲染所有壳的全部行；
sessionsOf/orderedWorkspaces/dropEnv 每次渲染按来源重算。

**已知前置（2026-02 落地时记录的实测缺口）**：T1 已给 ctxValue 加 useMemo（全量字段逐项覆盖），但各 hook 提供的
动作回调（toggleMenu/closeMenu/commitSessionDrag/onNewSession 等）目前仍是每次渲染重建的普通函数，因此
ctxValue 只在回调身份恰好不变时命中；要拿到完整收益需先把这些回调 useCallback 化。

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

**预期收益**：把 P2 的收益判定从「结构性倍数」升级为实测数字；也是「回收壳蓝点/通知暂停」这类既有取舍的复核依据。

**风险**：仪表本身不能成为新的热路径成本（计数要无分配、无字符串拼接）；诊断面不得进入打包产物的用户可见 UI。

**验证**：开发档读一次计数；打包档确认计数器被编译掉或不暴露。
