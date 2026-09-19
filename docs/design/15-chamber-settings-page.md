# 15 · Chamber 设置呈现（settings 壳固定入口）

> **状态：现行（settings 壳平铺固定入口，v1 范围）**——chamber 全局设置落 settings 壳的固定入口区，
> 与实例配置平面严格分离；**统一 Chamber 设置页 / 两级分组导航推迟（不排期）**；未完成门禁见
> `docs/progress/STATUS.md`。
> 范围契约：固定入口只有 `__connections`（连接）与 `__general`（**客户端 / Desktop**——命名避免与官方
> `general.nav`（通用设置 / General）同名；含设计 11 的更新块、设计 14 的运行设置、通知与会话待办区
> 控制组）；**移除 B 项**（插件管理提级、新插件包、OpenChamber 式完整子分区）。
> 本文是 chamber 设置的**呈现面与权威边界**契约（数据权威见 D3）；设计 14 是睡眠/运行设置的来源，
> 设计 11 是更新块，设计 19 是通知组，设计 06 §8 是会话待办区。

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
  boot/extra-row 诊断通道）。退役原因（契约依据）：该报告的 subject 是单个来源、owner 是壳——既不属于该来源
  账本里的 `settings.section` 贡献（第一组的定义 = 来源自己贡献了什么），也不是与服务器无关的 chamber 全局状态
  （第二组的契约），放进任何一组都会破坏该组语义。
- 插件管理在连接页内（`PluginSyncModal`/`PluginAddView`，经 `desktop_ssh_plugin_*` IPC）——**不搬家**。

## 2. 决策与契约（平铺形态）

### D1 固定入口平铺扩展

- divider 下固定入口为 2 个：`__connections` / `__general`（**客户端 / Desktop**，`clientNav`；命名与官方
  分节 `general.nav` 区分——同名会让两个不同的面在 nav 上不可分辨。本页是 chamber 全局的桌面客户端设置：
  关闭行为 / 自启 / 保持唤醒 / 退出确认 / 更新。nav 单元与页面自身 `<h2>` 共用这一个键，不出现
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
  - **更新**（设计 11，并入；组标题 + 导语 + 版本行 + 「检查更新」按钮 + 相位状态行）。
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
    内容行写死的；照抄会让 28px 关闭控件的内容盒被 `min-height` 撑高）。这是对齐关键字而非光学位置，
    完全复刻官方光学位置需要官方那颗 26px 关闭控件；④ 服务器下拉**密度用 chamber、圆角背景参考官方**
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

「客户端」（`__general`）在「运行」与「通知」组之间是「会话待办区」组（sidebar todo area，交互与派生契约见
设计 06 §8）：主开关（无边框披露行）+ 展开后三类事件开关（会话完成时 / 代理提问时 / 审批请求时——与「通知」组
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
- 消费者：侧边栏 `ui-sidebar/src/shared/todo-prefs.ts` 只读镜像（get + onChanged，未水合回落默认——本块默认值
  本身就是开，与「绝不假 off」占位纪律不冲突）。

## 3. 与既有设计的衔接

- 设计 11（更新）：更新块并入 `__general`；「检查更新」按钮经 `dsh-chamber:update-check` IPC（主进程同一条静默
  检查路径）。
- 设计 09 §5（设置面装载边界）：完整桥接修订后设置面**不装载插件**，组装诊断块随之退役；**这不是「插件提级」**
  （§D2 仍推迟不排期），提级指把官方 `settings.section` 的 plugins 段抬成独立入口。
- 设计 14（睡眠/后台常驻）：全部运行设置落 `__general`。
- 设计 05 §5：连接设置插件（`settings.section` id `connections`）注册不变；chamber 固定入口是壳层结构，
  不新增官方 `settings.section` 注册。
- 设计 13（插件管理）：IPC 面不动，视图维持现状。

## 4. i18n 与验证门

- **i18n**：扩展 `dsh-chamber.settings.bridge` 命名空间（客户端页文案，zh/en；`verify:i18n` 必须通过）。
- **测试**：`test:settings-bridge`（`__general` 入口渲染/active 解析/固定项集合/壳装配隔离不变式/每实例面注册表与
  完整桥接/`cell-dispatch`（槽单元派发：胜出、fallback、占用但无胜出者的死单元、未声明）/`onboarding`
  （协调器真值表：blank 或缺席才活跃、有序取第一个未完成、完成集推进）/`update-gate`（检查按钮相位门）
  /会话待办区与通知设置纯函数）；`test:connections`（plugin-diff 等）；`typecheck:settings-bridge`、
  `typecheck:connections`、`build:renderer`。（源码文本锁已按既有裁决不在正式测试面内。）
- **推迟（不排期）**：两级分组导航、插件提级、关于页。
- 验证清单：两个固定入口渲染、chamber 入口在服务器未连接时可用、设置读写经主进程 store、与官方段互不污染、
  选中来源自己的分节台账渲染（第三方分节与官方分节同形）、i18n 无 DRIFTED。

## 5. 关联

- 设计 14（睡眠/后台常驻）：`__general` 的内容来源；
- 设计 11（自动更新）：更新块并入 `__general`；
- 设计 06 §8（会话待办区交互/派生契约）、设计 19 §3.4（通知组并入通用的先例：事件类别 vocabulary 复用
  complete/ask/request）；
- `docs/progress/STATUS.md`（进度唯一记录）。
