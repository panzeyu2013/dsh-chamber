# @dsh-chamber/dsh-client-ui-mobile

Chamber 移动端适配插件（design 17 §18）：让官方 dsh Web 前端在手机浏览器（经
gateway 访问）真正可用——窄屏抽屉化布局、触控目标、安全区、PWA 分期。

> 唯一随 gateway 发行物打包 seed 的 chamber 客户端插件（§3 装配矩阵移动例外；
> 链路无桌面，不参与 `/chamber/plugins` 桌面同步）。

## 结构

- `src/index.ts` —— 宿主半空入口（seed gate 需要 `dist/index.js`）；
- `src/client/index.ts` —— 浏览器半：assets 注入（viewport/stylesheet/
  theme-color）、frame 打标（`ROLE_SLOT_KEYS` 把插件角色映射到 alpha.2 槽键
  `sidebar` / `main` / `rightbar`）、layoutFacts 驱动的抽屉滚动锁、
  composer 行为、抽屉点击自愈、设置 sheet 分区切换打磨、
  `shell.overlay` 抽屉开关（官方面板图标）+ 遮罩。该开关**就是**官方控件而非
  仿制品（2026-09-11 upstream-alignment T17a）：渲染 `IconPanelLeftOutline16`
  ——官方侧边栏开关所用的图标，取自 `ui-primitives` 客户端 baseline 模块，
  因此 bundle 无需为此声明依赖——并采用官方 ARIA 形态：带状态的 `aria-label`，
  无 `aria-haspopup`。退役的 CSS 汉堡与其 `aria-haspopup="true"` 断言一并删除；
  触屏档只保留官方控件给不了的部分（44px 浮动盒与吸收误触的遮罩）；
- `src/client/styles.ts` —— 单文件样式（全部媒体查询作用域，桌面零影响；
  只用官方 `--dsw-*`/`--ds-*` token）；
- `src/client/markup.ts` / `composer.ts` / `layout-facts.ts` /
  `drawer-taps.ts` / `settings-sheet.ts` —— 纯逻辑 + 薄安装器（可单测）；
- `scripts/build.mjs` —— esbuild 两半构建（`dist/index.js` + `lib/client.js`）。

## 会话头部适配（触屏档）

会话头（`conversation.session.header` 出口——官方标题/面包屑行）是桌面宽度
的 chrome，与移动面在三个轴向上冲突，全部以结构化选择器覆盖（不猜哈希类名）：

- **开关重叠**：浮动抽屉开关（左上 44px）压在头部内容上——头部预留左侧 gutter
  （`padding-left`）；
- **面包屑被裁**：官方 crumbs 行 nowrap + overflow hidden，长标题链与
  谱系 chip（「N 个子代理」目录触发器）会被静默截断——改为换行而非裁切
  （单段省略号保留）；
- **「Session 日志」导出胶囊**：alpha.2 重锚时**退役**——上游已把该控件改为
  会话头 more-actions 菜单里的 28×28 图标按钮，插件不再按文案打标。右列的移动
  呈现同样交给上游：`ui-sidebar-right` 在 <768px 自动全屏，插件只保留第三轨的
  网格锁，不再自绘覆盖层。

## 设置页适配（手机档）

官方设置壳（`ui-settings-general` 的 `sidebar.settings` 座——gateway/移动
链上的唯一设置面；chamber settings-bridge 与官方 settings document 均仅桌面）
是 800px 的 flex-row 弹窗：固定 188px 竖排 nav + 内容列。手机档规则以结构
锚点（slot/role）重排：

- **纵向堆叠全屏 sheet**：panel 改 `flex-direction: column`；nav rail 变
  顶部横条——标题 + **可横向滚动的分区 chips**（44px 触控目标，顶部安全区）；
- **chrome 固定、选项区滚动**：内容列 header（actions + Close）不再随内容
  滚走——只有分区 options 区滚动（底部安全区补边）。固定行锚定在文档化的
  `[data-slot="settings.action"]` + `[data-slot="settings.close"]` 缝上，而非
  位置化的首个子元素（2026-09-11 upstream-alignment T17c）；
- **分区内网格降级**：只有 Models 的 provider 行（两输入 + 两图标一行的 4 列
  grid）降为 2×2，使用文档化的**局部名后缀**例外
  `:is([class$="_<local>"], [class*="_<local> "])`——实例 bundle 的生产命名是
  `[hash]_[local]`（上游 cssModules 规则，
  `vendor/harness-checkout/packages/client/tsdown.client.ts:517`；产物实测
  `JObwrW_row`/`zGbnIq_modelRow`/`qSYn7G_cards`），只有后缀臂能命中。
  `_<local>_<hash>_<idx>` 是 **chamber 自建壳（Vite）**的命名，从不属于实例
  bundle；此前的 `[class*="_<local>_"]` infix 形式因此命中不到任何东西，命名
  翻转时 fail-soft——保持官方网格。卡片网格不再覆盖：上游
  `PluginInventorySettingsTab` 自己就在 `max-width: 680px` 把 `.cards` 收为
  单列，chamber 旧有的 681–768px 单列臂只与上游自己的两列几何相矛盾，已删除
  （2026-09-11 upstream-alignment T17b）；
- **设置 sheet 之外的弹层不再改写**：手机档不再给 `aria-modal` 弹层限宽
  `100vw - 24px`（2026-09-11 upstream-alignment T6）：全树恰好三个
  `role="dialog"` + `aria-modal="true"` 产出点，各自负责自己的视口适配——
  本 sheet、ui-primitives `Modal`（root 补 24px 内边距、dialog 为
  `min(380px, 100%)`）、以及 `ui-attachment` 的 `ImageLightbox`（`inset: 0`
  的 fixed 全幅背板，遮罩是 absolute `inset: 0` 层）。`inset: 0` 旁边再给
  `max-width` 是过约束：灯箱背板被压成 `100vw - 24px` 且左对齐，右侧留下
  24px 未变暗、可点击穿透的条带；
- **iOS 聚焦缩放**：弹窗内可编辑字段套用 composer 同款 16px 底线
  （`max(16px, var(--dsh-content-font-size, 16px))`）。

平板（触屏档 >768px）保留桌面弹窗几何——只有手机档用堆叠 sheet。

设置 sheet 行为（`settings-sheet.ts`，手机档）：官方壳的 options 滚动容器
在分区之间**共享一个**——切换 chips 会保留上一分区的滚动位置，长列表滚到
中途后切到较短分区就落在视口中段。点击分区 **chip** 后（rAF 于分区重渲染
之后）把 options 滚动器（它的直接父元素）与 sheet 的兜底内容滚动器复位到
顶部；chip 判定是纯函数且带单测的 `isSectionChipClick`（最近 `nav` 祖先为
设置 nav 的 `button`），因此点击 nav 标题、选项区或对话框 chrome 一律不复位。
该行为门控在**手机档**而非触屏档：769–1023px 的触控平板保留官方弹窗几何与
官方跨分区滚动行为。

## Tooltip 与悬停 chrome（粗指针档）

官方 ui-primitives `Tooltip` 气泡（`[role="tooltip"]`）是粗指针永远无法干净
关闭的悬停/聚焦 chrome：一次点按会合成 trigger 的 mouseenter，但 mouseleave
要等下一次在别处点按才到——于是延迟（200–500ms）的发送/停止/暂停气泡在点按
之后弹出并**常驻**在刚用过的按钮上。这是粗指针（而非窄视口）的产物，因此规则
以 `(pointer: coarse) and (hover: none)` 门控（iPad 横屏 1024px+ 同样会点按；
接上鼠标时 hover 翻转为 hover，规则自动让位、悬停气泡恢复），并且只针对**与可
访问名重复**的气泡——`button[aria-label] + [role="tooltip"][data-side]`（该组件
把气泡渲染为 trigger 的紧邻下一兄弟，并带自身的 `data-side` 标记）。官方 31 处
Tooltip 用法中 27 处是带 aria-label 的按钮，标签命名同一动作（composer 的发送/
停止/指令/ContextMeter、队列 dock、目标栏、侧边栏、消息反馈、工作区行、聊天
复制/分支；其中 3 处措辞略有差异——工作区搜索 ×2、轨迹加载更早——语义相同）。
四处信息型气泡**刻意不隐藏**——聊天统计行、代理预设卡片描述（截断到 4 行）、
轨迹时间轴 span（`aria-hidden`、无点击路径）、≤620px 时的轨迹 kind 标签（可见
标签被收起）：它们保留 sticky-hover 的小瑕疵，而不是丢掉触控用户无法从别处读到
的内容。第五处 `role="tooltip"`（轨迹 turn-rail 预览，被 `aria-describedby`
引用）没有 `data-side`，被规则结构性排除。桌面零影响（媒体查询作用域）。

## 抽屉点击与键盘（触屏档）

- **点击自愈**（`drawer-taps.ts`）：iOS Safari 会抑制抽屉内点击的合成
  click（hover 展开令命中行位移），单击会话行此前无反应——稳定点击后若真实
  click 在 120ms 宽限内未到达，自愈从 pointerup 目标重发一个非受信 click；
  React 委托的行处理器照常执行，单击即可切换。自愈后 150ms 内同坐标到达的
  受信 click 视为迟到的真实 click 被抑制（不双重激活）；起点按 pointerId
  分别跟踪（多点触控安全、响应 pointercancel）。平移/滚动意图（超出 slop
  的位移）、表单控件（含任意非 false 态 contenteditable）、抽屉之外一律
  不触发；桌面路径不受影响（仅 touch/pen + 触屏档门禁）。
- **抽屉导航不再拉起键盘**：官方 composer 会在会话切换后把焦点还给输入框，
  在 iOS 上等于切换后立刻弹键盘——IME 阶梯 layer-1 的 gesture 判定现在只在
  手势起始于**导航区**（抽屉会话行、会话头面包屑）时丢弃程序化回焦；点输入
  框、发送键、鼠标/硬键盘聚焦以及 portal 型选择器流程（工作区/代理预设菜单）
  仍保留键盘与输入意图。
- **键盘可见期的 composer 补偿**（IME 阶梯 layer 5，
  `composer.ts` `installKeyboardCompensation`）：忽略
  `interactive-widget=resizes-content` 的引擎（iOS Safari、旧 Android
  WebView）在键盘弹出时保持 **layout 视口**满高，而官方 composer seat 是
  会话滚动器的**流内子元素**，于是钉在 layout 底部、落在键盘背后。键盘打开
  期间把 seat 的 sticky `bottom` 抬到键盘顶，并给会话滚动器加等量底部
  padding（frame 级 `data-mobile-kbd` + `--chamber-mobile-kbd-offset`，
  styles.ts）；原本贴底的会话按同一差值向下滚，消息尾保持贴在抬升后的 seat
  上方（外层滚动跟随由官方 chat 的 seat ResizeObserver 负责，本安装器只管
  键盘驱动的几何变化）。arm 期间 seat 的底部安全区 padding 归零（键盘弹起时
  该 inset 位于键盘之后，会多出 0–34px 死区）。偏移量化（16px 步进 → 死区
  8–23px，48px 时为 8–55px），并由 visualViewport resize/scroll、window
  resize、focusin/focusout 与 visibilitychange 重同步。**arm 需要**：visual
  viewport 收缩 + 可编辑焦点（focusin/focusout 打点 + 提交期 composer 选区
  兜底 + 1.2s 宽限窗口）。**缩放策略**：缩放态只服务 composer——一刀切的
  `scale ≈ 1` 否决会在 iOS 聚焦缩放后（抽屉 13px 搜索框是常见触发源）让
  composer 永久留在键盘后，因此抽屉内输入框也补上 16px 底线从源头消除聚焦
  缩放；缩放 + 非 composer 字段仍然否决（缩放页面的平移不得驱动偏移）。
  arm 以 **frame 元素**为单位幂等：renderer 重挂替换 AppFrame 而键盘仍开着时，
  新 frame 会被重新打标（旧 frame 的插件属性被清理），不会把 composer 留在
  键盘后面。
- **Enter 换行的光标揭示**：移动端 Enter=换行路径插入的换行绕过了官方
  keymap 管线，其 caret reveal 不会执行——composer 超过最大高度后新行可能
  落在其内部滚动窗的折叠线以下。每次插入后在 `[data-input-scroll]` 内揭示
  光标（已可见或无内部溢出时为 no-op）。

## 构建 / 测试

```sh
pnpm --filter @dsh-chamber/dsh-client-ui-mobile run build
pnpm run typecheck:mobile
pnpm run test:mobile
```

## 锚点基线

官方 dsh **v0.1.5-rc.1** DOM 实测（CDP 审计在 v0.1.5-alpha.2 完成，随 vendored pin
迁移重锚）——下列锚点在 rc.1 树中仍全部成立；rc.1 的客户端改动（`ui-sidebar-*` 的
guide/preview 行、`ui-primitives` 的 `CodeBlock` 包装层、`ui-chat` 统计对话框、
`ui-dockkit` CSS 的两处 `z-index`、slot-catalog 文档指针）既不涉及下述锚点的产出源，
也不改变本插件叠层所对位的层：
`data-sidebar-collapsed` 折叠=存在/展开=移除；中心列为 keyed **`main`** 槽、右列为
**`rightbar`**（两个列壳及其 `[data-slot=…]` 出口包裹层都自首帧常驻——渲染器无条件
输出该包裹层，只有其中的 docking 面按注册挂载，故打标在列壳上即收敛，见 markup.ts
`isStructuralTarget` 与 `ROLE_SLOT_KEYS`）；composer 为 Lexical `[data-composer-input]`（无 textarea）；
设置对话框渲染在侧边栏 DOM 内（无 body portal），抽屉打开态必须用
`transform: none`（identity transform 仍是 containing block）。

当前 vendored 基线为 **v0.1.5-rc.1**（harness pin 183f08e9c6dd）；上述锚点已对
alpha.2 源码复核（2026-09 重锚），并在 rc.1 上复验成立（rc.1 的客户端改动见上，
不触及这些锚点与本插件的叠层对位），复核同时确认：composer seat 是
`[data-conversation-scroll]` 的流内子元素（仅内容溢出时才 sticky）、
`[data-input-scroll]` 是 composer 的内部滚动器（`max-height: 336px`）、官方
`revealSelection` 只在 `draft !== ""` 布尔翻转时运行、官方设置对话框**没有**
任何宽度媒体查询、服务端 viewport meta 从不带 `interactive-widget`（由本
插件客户端注入，触屏档门控）。
