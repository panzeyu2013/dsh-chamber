# 15 · Chamber 设置呈现（v1 平铺形态已实现；统一设置页推迟，2026-08）

> **状态：已实现（v1 范围，2026-08）——设计见本文；实现基线以 git 历史与
> CHANGELOG 为准**。2026-08 范围缩减（用户拍板）：**移除 B 项**
> （插件管理提级、新插件包、OpenChamber 式完整子分区），**两级分组导航推迟**；
> v1 仅把设计 14 的 chamber 全局设置（A 项）**平铺**进 settings 壳的固定入口区。
> **2026-08 修订 1（用户拍板）**：固定入口由 3 个收为 2 个——**更新并入「通用」**
> （设计 11 的更新状态 + 「检查更新」按钮随 `__update` 入口一并迁入 `__general`
> 视图，设计 11 §3.2 同步修订）。
> **2026-08 修订 2（用户拍板）**：`__general` 内部按 OpenChamber 式控制组组织
> （启动与关闭 / 运行 / 更新）；「退出确认」由只读说明改为可设开关
> `quitConfirmation`（默认开，仅本地实例运行中时确认，远程隧道不影响关闭）。

## 1. 现状

- `SettingsShell`（`packages/dsh-chamber-client-ui-settings-bridge`）：服务器下拉
  （local 默认 + 远程按连接态着色）→ 选中实例官方段（models/agent-presets/
  plugins/…，child ctx 桥）→ `navDivider` → **固定 chamber 全局入口平铺**：
  `__connections`（连接）、`__general`（通用——含设计 11 的更新块）。
- chamber 全局组件内嵌渲染（不占 child ctx、不依赖选中服务器连接）。
- 插件管理在连接页内（`PluginSyncModal`/`PluginAddView`，经 `desktop_ssh_plugin_*`
  IPC）。

## 2. v1 决策（平铺形态）

### D1 固定入口平铺扩展

- divider 下固定入口为 2 个：`__connections` / `__general`（通用设置）。
  **更新（设计 11）不再单列入口**——并入 `__general` 视图底部（`UpdateSection`
  控制组：当前版本 + 「检查更新」按钮 + 低调状态行，见设计 11 §3.2）。
- `__general` 视图（`GeneralView`，settings-bridge 壳内）：**设计 14 全部设置
  落点**，按 OpenChamber 式**控制组**组织（组标题 + 平铺行，settings-panel
  设计语言）——
  - **启动与关闭**：关闭窗口行为（`windowCloseBehavior`：hide-to-tray / quit，
    可设）；登录自启（`launchAtLogin`，可设；macOS/Windows/Linux，design 23 M4 win 已解锁）；
  - **运行**：保持唤醒（`keepAwake`，默认关）；退出确认（`quitConfirmation`，
    2026-08 新增可设开关，默认开——仅本地实例运行中时确认，远程隧道不影响
    关闭，更新已下载时豁免，见设计 14 D2 修订）；
  - **更新**（设计 11，2026-08 并入；组标题 + 导语 + 版本行 + 「检查更新」按钮
    + 相位状态行）。
  - 样式与官方设置段一致（settings-panel 设计语言：标题 + 导语 + 分组标题 +
    平铺行 + 胶囊按钮，`--dsw-alias-*` tokens）。
  - 读主进程 `chamber-settings.json`（`dsh-chamber:settings-get/set` IPC + 变更 push）。
- 插件管理维持现状（连接页内 Modal），**不搬家**；「关于」页 v1 不做。

### D2 推迟（不排期）：统一 Chamber 设置页 / 两级分组

- 原「Chamber 组 + 服务器设置组」两级分组导航**整体推迟**（Chamber 组子条目
  连接/插件/通用/更新/关于的设想保留为后续形态）。
- **移除 B 项**：插件管理提级（`__chamber.plugins`）、拆新插件包、OpenChamber 式
  完整 app 设置子分区（visual/chat/sessions/git/github/notifications/voice/
  tunnel 等——对应功能域多为 01 §4 移出项，git/GitHub 已插件化）。

### D3 数据与权威边界（硬纪律，v1 即生效）

- Chamber 全局设置（含 `__general` 全部项）→ 主进程 `chamber-settings.json`
  （非秘密、原子写、`dsh-chamber:settings-get/set` IPC + push）；**绝不进任何实例的
  dsh home**（01 §2 P2：每实例配置平面权威，控制面只透传、不做权威副本）。
- 选中实例的设置 = 实例自己的配置，仍经 `/api/i/<id>/*` 反代落实例 dsh home。
- 两组永不交叉：chamber 设置不进实例 dsh home；实例配置不投影到 chamber 固定
  入口。这是「更好的区分」的契约基础（即使 v1 只是平铺，区分依然成立）。

## 3. 与既有设计的衔接

- 设计 11（更新）：更新块并入 `__general`（原 `__update` 固定入口移除）；
  「检查更新」按钮经 `dsh-chamber:update-check` IPC（主进程同一条静默检查路径）。
- 设计 14（睡眠/后台常驻）：全部运行设置落 `__general`。
- 设计 05 §5：连接设置插件（`settings.section` id `connections`）注册不变；
  chamber 固定入口是壳层结构，不新增官方 `settings.section` 注册。
- 设计 13（插件管理）：IPC 面不动，视图维持现状。

## 4. i18n / 测试 / 分期

- **i18n**：扩展 `dsh-chamber.settings.bridge` 命名空间（通用设置文案，
  zh/en；`verify:i18n` 必须通过）。
- **测试**：`test:settings-bridge` 扩展（`__general` 入口渲染/active 解析/
  壳装配隔离不变式；`update-gate`：检查按钮相位门）；`test:connections`
  （plugin-diff）不变；`typecheck:settings-bridge`、`build:renderer`。
- **M1**：`__general` 视图 + 平铺入口（接设计 14 M1–M3 设置项，随 14 各期
  填充：M1 关窗行为 → M2 防休眠 → M3 登录自启）。
- **推迟（不排期）**：两级分组导航、插件提级、关于页。
- 验证清单：两个固定入口渲染、chamber 入口在服务器未连接时可用、设置读写经
  主进程 store、与官方段互不污染、i18n 无 DRIFTED。

## 5. 关联

- 设计 14（睡眠/后台常驻）：`__general` 的内容来源；
- 设计 11（自动更新）：更新块并入 `__general`；
- `docs/progress/STATUS.md`（进度唯一记录）。
