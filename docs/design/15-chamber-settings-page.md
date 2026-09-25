# 15 · Chamber 设置呈现（settings 壳固定入口）

> **settings 壳平铺固定入口（v1 范围）**——chamber 全局设置与实例配置平面严格分离；
> **统一 Chamber 设置页 / 两级分组导航推迟（不排期）**；未完成门禁见 `docs/progress/STATUS.md`。
> 范围契约：固定入口只有 `__connections`（连接）与 `__general`（**客户端 / Desktop**；命名理据见 D1；含
> 设计 11 的更新块、设计 14 的运行设置、通知与会话待办区控制组）；**移除 B 项**见 D2。
> 本文是 chamber 设置的**呈现面与权威边界**契约（数据权威见 D3；相关面来源见 §5）。

## 1. 壳形态（现状契约）

- `SettingsShell`（`packages/dsh-chamber-client-ui-settings-bridge`）：服务器下拉（local 默认 + 远程按连接态
  着色）→ **选中来源自己 boot ctx 的 `settings.section` 台账**（models/agent-presets/plugins/… 及该来源自己的
  第三方分节，完整桥接见设计 05 §5）→ `navDivider` → **固定 chamber 全局入口平铺**：`__connections`（连接）、
  `__general`（客户端——含设计 11 的更新块）。
- 壳 chrome 与上游对齐（细节见设计 05 §5）：头部不重复分节标题、触发器行 42px、面板圆角 32px、关闭后焦点
  还给触发器。
- chamber 全局组件内嵌渲染（不依赖选中服务器连接）。
- **每来源「设置组装诊断」块已退役**：设置面不再为选中来源二次装载插件，故不存在需要报告的
  「未激活/未落座/能力降级」；仍然可见的是连接页该来源卡片上的「客户端插件状态」（`pluginDiagnostic`，来自
  boot/extra-row 诊断通道）。退役依据：该报告的 subject 是单个来源、owner 是壳——既不是该来源账本里的
  `settings.section` 贡献（第一组 = 来源自己贡献了什么），也不是与服务器无关的 chamber 全局状态（第二组契约），
  放进任何一组都破坏该组语义。
- 插件管理在连接页内（`PluginSyncModal`/`PluginAddView`，经 `desktop_ssh_plugin_*` IPC）——**不搬家**。

## 2. 决策与契约（平铺形态）

### D1 固定入口平铺扩展

- divider 下固定入口为 2 个：`__connections` / `__general`（**客户端 / Desktop**，`clientNav`；命名与官方
  分节 `general.nav` 区分——同名会让两个不同的面在 nav 上不可分辨。本页是 chamber 全局的桌面客户端设置，
  分组见下。nav 单元与页面自身 `<h2>` 共用这一个键，不出现
  「导航一个名字、页面另一个名字」）。`FIXED_SECTION_IDS` 是机器可读的权威（`nav-active.ts`，`nav-active.test.ts` 钉死）。
  **更新（设计 11）不再单列入口**——并入 `__general` 视图底部（`UpdateSection` 控制组：当前版本 +
  「检查更新」按钮 + 低调状态行，见设计 11 §3.2）。
- `__general` 视图（`GeneralView`，settings-bridge 壳内）：**设计 14 全部设置落点**，按 OpenChamber 式
  **控制组**组织（组标题 + 平铺行，settings-panel 设计语言）——
  - **启动与关闭**：关闭窗口行为（`windowCloseBehavior`：hide-to-tray / quit，可设）；登录自启
    （`launchAtLogin`，可设；macOS/Windows/Linux）；
  - **运行**：保持唤醒（`keepAwake`，默认关）；退出确认（`quitConfirmation`，可设开关，默认开——仅本地实例
    运行中时确认，远程隧道不影响关闭，更新已下载时豁免，见设计 14 D2）；VS Code 新窗口
    （`vscodeOpenInNewWindow`，默认开——在 VS Code 新窗口打开会话目录，避免其运行中复用/替换最近活动窗口；
    见设计 16 §3.3）；
  - **会话待办区**（sidebar todo area，契约见 D4 与设计 06 §8）；
  - **通知**（设计 19 §3.4：主开关 + 通知时机 + 事件开关 + 发送测试通知）；
  - **更新**（设计 11，并入；组标题 + 导语 + 版本行 + 「检查更新」按钮 + 相位状态行 + **调试模式**
    开关——位置由用户裁决放在本组内（与更新行为不耦合，只是同一低矮分组的邻居），契约见设计 25 §5.1.1：
    默认关、仅 Swift 原生壳支持（Electron 腿未接线 → 禁用 + 原因）、状态行只报宿主 `debugRuntime` 回读）。
  - 样式与官方设置段一致（标题 + 导语 + 分组标题 + 平铺行 + 胶囊按钮，`--dsw-alias-*` tokens）；控制组之间以
    `--dsw-alias-border-l2` hairline 分隔。
  - **控件用官方原语**：所有动作胶囊是 `ui-primitives` `Button`（`variant="outline|primary" size="sm"`）；
    **顶层开关行**是官方 `Switch`（36×20 轨道 / 圆形 thumb / 120ms / `aria-checked` 选中色 / **必填 `label`**，
    即本行的可访问名）。卡片网格与通知事件行里的勾选框仍是原生 `<input type="checkbox">`
    （`ToggleCard` / `ToggleEvent`），整行 `<label>` 即命中区。
  - **已知取舍（chamber 适配）**：`Switch` 不透传任意属性（只收 `checked`/`onChange`/`label`/`disabled`/
    `title`/`className`），而「通知主开关」与「会话待办区开关」是**披露行**（展开下方子设置卡），需要
    `aria-expanded`/`aria-controls`——这对属性不挂外层包装盒（无 role 的 `<span>` 不支持 `aria-expanded`，
    而支持它的包装 role 会在开关外再套一层可交互控件、触发 `nested-interactive`）。故由 `DisclosureSwitch`
    在挂载/披露态变化时经 `disclosure-attrs.ts` 的 `applyDisclosureAttributes` **命令式写到官方 `Switch` 自己的
    `[role="switch"]` 按钮上**（`useLayoutEffect`，从不渲染出缺关系的帧；`aria-expanded` 恒写，`aria-controls`
    只在卡片存在时写，避免指向已不存在的 id）。未读角标开关不展开任何东西，直接用原语本身。**收口**：仍需上游
    给原语加属性透传，届时删掉该模块。
  - **控件语言与几何（收口状态）**：① 面板内容区最后一个自绘动作胶囊「前往连接管理」也换成官方 `Button`
    （`css.inlineAction` 只留布局 `margin-top/align-self`）——「所有动作胶囊是官方 `Button`」至此无例外（壳 chrome
    的下拉触发器/选项行、nav 单元、关闭钮与轨道触发器仍按 §1 自绘）；② 开关/单选的**「开」色 = dsh 业务蓝**
    `--dsw-alias-state-business-primary`（`--dsw-static-deepseek-500`/`-400`）——**不采用**官方
    `--dsw-alias-brand-primary`（该 token 落中性档，浅色主题下整页「开/选中」态发黑，与 dsh 蓝及侧栏选中态、
    Git 面板滑块的既有语言不一致）。落点：复选框 `accent-color`（`.generalCardCheck`）、分段滑块
    （`.SegmentedControl .thumb`）、官方 `Switch` 的开启轨道
    （`.panel [role='switch'][aria-checked='true']` 覆盖——特异性 0,3,0 胜过原语 0,2,0，不依赖打包顺序，
    面板内由**来源自己 ctx** 渲染的官方分节同样覆盖；原语结构/轨道/thumb 位移/过渡/禁用透明度/焦点环一概保留）；
    连接页选中的筛选胶囊（`.pluginPillActive`）与「dsh 运行时」段进度填充（定宽 `.runtimeProgressBar` / 滑动条纹
    `.runtimeProgressBarIndeterminate`；6px 轨道仍是 `--dsw-alias-border-l2`）同取该蓝。分段控件**几何保持 chamber 档**
    （26px/12px），只换色；③ 面板头取官方 `SettingsRoot .header` 的**对齐关键字**（`align-items:flex-start`）与
    54px 盒高下限，但**纵向内距保留 chamber 的 `12px 14px 10px`**（官方的 `20px 14px 8px 10px` 是围绕其 26px
    内容行写死的；照抄会让 28px 关闭控件的内容盒被 `min-height` 撑高；对齐关键字而非光学位置，完全复刻需
    官方那颗 26px 关闭控件）；④ 服务器下拉**密度用 chamber、圆角背景参考官方**
    （`padding:7px 10px` + 13px 字号，行框显式 18px；item r10、列表 r20、`bg-layer-3` + elevation）。
  - 读主进程 `chamber-settings.json`（`dsh-chamber:settings-get/set` IPC + 变更 push）。
- 「关于」页 v1 不做。

### D2 推迟（不排期）：统一 Chamber 设置页 / 两级分组

- 原「Chamber 组 + 服务器设置组」两级分组导航**整体推迟**（Chamber 组子条目连接/插件/通用/更新/关于的设想
  保留为后续形态）。
- **移除 B 项**：插件管理提级（`__chamber.plugins`）、拆新插件包、OpenChamber 式完整 app 设置子分区
  （visual/chat/sessions/git/github/notifications/voice/tunnel 等——对应功能域多为 01 §4 移出项，git/GitHub 已插件化）。

### D3 数据与权威边界（硬纪律，v1 即生效）

- Chamber 全局设置（含 `__general` 全部项）→ 主进程 `chamber-settings.json`（非秘密、原子写、
  `dsh-chamber:settings-get/set` IPC + push）；**绝不进任何实例的 dsh home**（01 §2 P2：每实例配置平面权威，
  控制面只透传、不做权威副本）。
- 选中实例的设置 = 实例自己的配置，仍经 `/api/i/<id>/*` 反代落实例 dsh home。
- 两组永不交叉：chamber 设置不进实例 dsh home；实例配置不投影到 chamber 固定入口。这是「更好的区分」的
  契约基础（即使 v1 只是平铺，区分依然成立）。

### D4 会话待办区设置组（settings 契约）

「客户端」（`__general`）在「运行」与「通知」组之间是「会话待办区」组（D1；交互与派生契约见设计 06 §8）：
主开关（无边框披露行）+ 展开后三类事件开关（会话完成时 / 代理提问时 / 审批请求时——与「通知」组
事件开关共用同一组文案与事件行视觉）。两类事件开关**措辞统一**（不用「已完成未读的会话 / 等待你回答的会话 /
等待你批准的会话」等长句）；待办区主开关与未读角标开关下不渲染说明行（开关标题自明）；事件行勾选框紧跟所属
选项文字、宽布局下列间以竖分隔线分割（窄窗降列时无竖线）。对应 chamber 全局设置嵌套块：

```ts
ChamberSettings.sessionTodo: {
  enabled: boolean      // 默认 true（被动呈现，空时零占用）
  onComplete: boolean   // 默认 true
  onAsk: boolean        // 默认 true（pending 'question'）
  onRequest: boolean    // 默认 true（pending 'approval' | 'plan-review'）
}
```

- 持久化：主进程 `<userData>/chamber-settings.json`（`chamber-settings.ts`：类型/默认/白名单/嵌套归一与损坏
  校验/`validatePatch` 同 notifications 纪律；`main.ts` `applySettingsPatch` 嵌套 deep-merge，绝不全组替换）；
- 类型镜像三处：`desktop/chamber-settings.ts`（store 权威）、`desktop/preload.cts`、`renderer/src/global.d.ts`
  （preload↔renderer 由 `test/ipc/ipc-surface-mirror.test.ts` 守护，含嵌套类型签名比对；desktop store 为手工镜像）；
- 渲染端助手：`settings-bridge/src/client/session-todo-settings.ts`（`sessionTodoOf`/`sessionTodoPatch`/
  `SESSION_TODO_DEFAULTS`，partial 嵌套 patch 只带改动的键上 wire）；`settings-store.ts` 乐观 overlay 的
  `mergeSettings` 同步嵌套 deep-merge；
- 消费者：侧边栏经 `packages/dsh-chamber-client-core/src/todo-prefs.ts` 只读镜像（get + onChanged，未水合回落默认——本块默认值
  本身就是开，与「绝不假 off」占位纪律不冲突）。

## 3. 与既有设计的衔接

- 设计 11（更新）：入口并入见 D1；「检查更新」按钮经 `dsh-chamber:update-check` IPC（主进程同一条静默
  检查路径）。
- 设计 09 §5（设置面装载边界）：完整桥接修订后设置面**不装载插件**，组装诊断块随之退役；**这不是「插件提级」**
  （§D2 仍推迟不排期），提级指把官方 `settings.section` 的 plugins 段抬成独立入口。
- 设计 05 §5：连接页是设置壳的**固定 nav 入口**（`__connections`，分隔线之下、不占 ledger order），**不是**
  官方 `settings.section` 注册——id `connections` 的 host-ctx 注册已随完整桥接修订移除
  （`packages/dsh-chamber-client-ui-settings-connections/src/client/index.ts` 只提供分节组件与字典命名空间）；
  该格式的注册保留给 chamber 自研分节「dsh 运行时」（设置壳在该来源自己的 boot ctx 上注册）。
- 设计 13（插件管理）：IPC 面不动，视图维持现状。

## 4. i18n 与验证门

- **i18n**：扩展 `dsh-chamber.settings.bridge` 命名空间（客户端页文案，zh/en；`verify:i18n` 必须通过）。
- **测试**：`test:settings-bridge`（`__general` 入口渲染/active 解析/固定项集合/壳装配隔离不变式/每实例面注册表与
  完整桥接/`cell-dispatch`（槽单元派发：胜出、fallback、占用但无胜出者的死单元、未声明）/`onboarding`
  （协调器真值表：blank 或缺席才活跃、有序取第一个未完成、完成集推进）/`update-gate`（检查按钮相位门）
  /会话待办区与通知设置纯函数）；`test:connections`（plugin-diff 等）；`typecheck:settings-bridge`、
  `typecheck:connections`、`build:renderer`。（源码文本锁已按既有裁决不在正式测试面内。）
- 验证清单：两个固定入口渲染、chamber 入口在服务器未连接时可用、设置读写经主进程 store、与官方段互不污染、
  选中来源自己的分节台账渲染（第三方分节与官方分节同形）、i18n 无 DRIFTED。

## 5. 关联

- 设计 14（睡眠/后台常驻，`__general` 内容来源）、设计 11（自动更新，更新块并入 `__general`）；
- 设计 06 §8（会话待办区交互/派生契约）、设计 19 §3.4（通知组并入通用的先例：事件类别 vocabulary 复用
  complete/ask/request）；
- `docs/progress/STATUS.md`（进度唯一记录）。

## 6. 完整桥修订（2026-12）

> 本节补写选中来源设置面的实现契约；权威分类仍以 §2（D1 固定入口 / D3 两组不交叉 / D4 会话待办区）为准，
> §1 的壳形态描述保持。落点均在 `packages/dsh-chamber-client-ui-settings-bridge/src/client/`。

- **单一权威数据源 = 所选来源自己 boot ctx 的 `settings.section` 台账**：面板不持有第二套设置模型——它读该来源自己的 cordis ctx（`AppWebEntry` 的 boot ctx）的注册表，`section-rows.ts` 只把台账投影成 nav 行（id/order/label，不渲染 `registrant`：第三方分节与官方分节同形），条目的组件、`store`、`inject` 与生命周期都归该来源自己；官方 settings 全族、该来源第三方 extra rows 分节与 chamber 在该 ctx 注册的「dsh 运行时」（order 31）同台。
- **面（face）注册表**：每个实例的桥接插件在该 ctx `apply` 发布 `{ slots, locale, chamberSourceFingerprint }`（`index.ts` / `settings-source-face.ts`），该实例的设置壳（`sidebar.settings` occupant，唯一被渲染器交付完整标准座的 chamber 条目）发布 `useSessions`/`useWorkspaces`/`usePanelInfo`/`useResource`/`useSessionPendingInteraction` 与 root `props`（`chamberFileApiBase`）。两半齐（`settingsSourceFaceReady`）且 face 的 `sourceFingerprint` 与权威 roster 同字段相等才渲染；半发布，以及同 id replacement / 传输身份变更后的旧 face，一帧都不渲染。
- **源下拉（N 源切换）**：行集来自 `chamberBridge` 投影（`bridge-servers.ts`；渲染签名 `serverProjectionSignature` 含 `sourceFingerprint` 与连接页所渲染的诊断字段，时间戳刷新被抑制），可搜索（label + id）、离线来源可选（进入不可达占位 + 连接管理入口）；默认选中 hosting instance → 首个 connected → 首行。切换来源不改当前分节：chamber 全局 id 优先，服务端分节 id 离开新来源台账时回落首行（`nav-active.ts`）。面板打开期间 `chamberBridge.setSettingsTarget(selectedId)` 让 App 保证该来源壳挂载（未挂载则后台挂载、不切 active view）并排除出回收路径，关闭/卸载即撤除。
- **渲染绑定座位**：条目 kit = 该 ctx 的标准座 + `t`（该来源 locale face 的命名空间绑定，按 revision 缓存）+ 条目自己的 `useStore`/`actions`（`store.create()` per entry 缓存）+ `renderSlot`（仅 root list/keyed；未声明或非 root 子座抛 `BridgeAssemblyError`）+ 条目 `inject` 面 + owner props；缺席的座保持缺席，绝不伪造空 observable。每个槽渲染点恒有 `[data-slot="<key>"]` 锚点（`display:contents`），胜出条目、fallback、占用但无胜出者的死单元与未声明槽都在内渲染，死单元给 `[data-slot-error]`（`cell-dispatch.ts`）；每个出口由 `BridgeEntryBoundary containAll` 收口，外来条目的渲染/装配错误永不 abdicate chamber shell。
- **staged 保存与权威分类**：各分节的保存语义由条目自己的 store/组件持有（官方分节的草稿→校验→提交原样保留；桥只物化 `useStore`/`actions`/`inject`，不拦截、不重实现、不代持）。chamber 全局 `__general` 仍是主进程 `chamber-settings.json` 的乐观 overlay（`settings-store.ts`：同帧可见、失败回滚、最新保存替换在途）；`__connections` 为草稿（`connection-form.ts` 的 `HostDraft`，秘密字段仅瞬时）→ 渲染端校验 → 一次 `desktop_ssh_save_connection` 事务提交，失败以 `formError`/字段错误行如实呈现；凭据只以 `sshPasswordSet`/`tokenSet`/`passwordSet` 存在性投影回读、清除恒为 clear-only（`clear-credential.ts`，凭据值永不进 renderer）。三组权威（chamber 全局 / 选中实例自己 ctx / 连接注册表与凭据）互不交叉。
- **`settings.launcher` 座（壳 chrome 渲染点）**：上游 `ui-settings` 声明的 single 座由官方 `SettingsRoot` 在触发行渲染（无注册者回落普通设置按钮），owner props `{ wide, settingsOpen, openSettings, openOnboarding, settingsShortcut? }`——`settingsOpen` 的 false→true 边沿 = 一次进入设置，`settingsShortcut` 未绑定即缺席，`openOnboarding(id)` 直达该 id 的注册步骤。chamber 壳遮蔽官方 shell 后，触发行由 `SettingsShell.tsx` 自绘 trigger（`aria-haspopup="dialog"`/`aria-expanded`，关闭后焦点还给触发器）；打开面板与 `settings.onboarding` 协调器（`onboarding.ts`）分别是 `openSettings`/`openOnboarding` 动作面的对应实现。
- **与 §2 的关系**：本节不改写 D1/D2/D3/D4——固定入口 `__connections`/`__general`（`FIXED_SECTION_IDS`）、两组永不交叉、会话待办区设置契约继续以 §2 为准；本节只补写「选中来源设置面的数据来源、座位与写路径」。连接页自身仍是设置壳的固定 nav 入口（不经官方 host-ctx `settings.section` 注册，见 §3）。
