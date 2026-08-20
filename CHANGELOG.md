# Changelog（变更日志）

本文件记录 dsh-chamber 的全部重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
本项目遵循[语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

发布产物与各版本的发布说明同时发布在 GitHub Releases 页面
（`https://github.com/panzeyu2013/dsh-chamber/releases`）。

> English: [docs/CHANGELOG.en-US.md](docs/CHANGELOG.en-US.md)

## [Unreleased]

### 新增

- **「检查更新」按钮与更新设置段**（design 11 修订）——设置「通用」段并入
  `UpdateSection`，用户可显式触发更新检查（与启动/周期静默检查同一条路径，
  从不自动下载）；`update-gate` 相位门 + 单测。

### 修复

- **退出流程加固**（design 14 review 轮）——退出确认仅在本地 dsh 进程实际
  存活时弹出（`localProcessAlive`，状态串独立事实）；SIGTERM/SIGINT 走优雅
  退出路径（will-quit 完整回收，强停不再残留 detached 孤儿进程占端口）；
  控制面 stop 先强关连接再 close（滞留 SSE/WS 不再挂死退出）；设置壳重构为
  「连接/通用」两固定入口 + `quitConfirmation` 开关。
- **插件管理 Modal 两处修复**——浅色主题白底白字（内容锚定
  label-primary）；本地实例恒 loading 导致 footer「关闭」死控件（移除）。

### 变更

- **全量对齐 dsh rc.8 baseline（设计 09 §4）** —— `harness.commit` →
  141eb6fef8（dsh 0.1.0-rc.8）：vendor 源物化为仓库内受管快照
  `vendor/harness-checkout`（规避 pnpm 11 锁文件剪枝，`--frozen-lockfile` 通过）；
  boot 内核迁 rc.8 模块系统 bootstrap（`boot.ts` 类结构 + `__ModuleLoader__`
  facade + BootPage 加载页，挂载经 `ctx.uiRenderer`）；复合延迟族 +3 覆盖
  （`ui-attachment` / `ui-brand-official` / `ui-reference`）、`ui-renderer` 归
  page-own；web-react/schema-form 深导入随删/迁移（渲染装配移入 ui-renderer 行，
  settings 系迁 `SettingsSchemaService`）；本地宿主同步升 rc.8（vendor dsh
  0.1.0-rc.8）。rc.8 客户端自带 `commands.execute` 的 `images` 参数，临时兼容桥
  随对齐移除；rc.7 宿主随对齐移出支持面。

## [0.1.3] - 2026-08-20

### 新增

- **rc.8 后端版本容忍（设计 09 §3.3 修订）** —— 实例后端 dsh 官方前端版本与
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

- 实例运行 rc.8 官方前端时 chamber 渲染器 boot 崩溃（seed 词表遮蔽 factory →
  "invalid plugin"），现降级为特性缺席、实例照常可用。
- 延迟加载的 ui-* 族导致 tool-call 节点渲染"未知 surface 事件"兜底文案（chamber
  入口 bundle 因 `?rev=` 与 chunk 图裸引用被浏览器视为不同模块而二次执行）。
- 后端 `ui-renderer` 行先装 slot-renderer 时 app-shell 整 boot 失败，现采纳已装
  renderer。
- boot 容错日志措辞与实际失败类型对齐；manifest 预加载行去重过滤覆盖旧的 `?rev=`
  残留形式。

### 变更

- 壳种子词表移除 rc.7 遗留平台词（`dsh-client-web-react` /
  `dsh-client-ui-attachment` / `dsh-client-schema-form`），与 rc.8 官方一致。
- 设计 09 失败降级语义按层表述：加载失败响亮归预加载层（collectExtraRows），
  apply/materialize 失败降级归 boot 内核层。

## [0.1.2] - 2026-08-19

### 新增

- **桌面自动更新（设计 11）** —— 静默更新检查（启动延迟 + 6 小时周期）、设置页低调的「更新」分区、仅在用户明确确认后下载、退出时安装。双平台更新源已随发布提供（`latest.yml` / `latest-mac.yml`；beta 频道经 semver 预发布版本）。macOS 安装环节在缺少 Developer ID 签名时如实提示（给出手动安装指引，绝不假报成功）。
- **睡眠/后台常驻（设计 14）** —— 关窗行为可配置（隐藏到托盘让 dsh 继续运行，或退出；退出前若会停掉活动隧道或本地实例则先确认）、登录自启（mac/linux）、OS 唤醒即时重连（不等心跳 watchdog）、保持唤醒开关。设置持久化于主进程 `chamber-settings.json`（0600、原子写、损坏文件保留）。
- **Chamber 设置页（设计 15，v1 平铺表单）** —— 设置壳固定入口 Connections / General / Update；chamber 全局设置与实例配置平面严格分离。
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
- 客户端插件运行时加载（设计 09）：每实例 host-graph 合并、额外 entry 预加载、covered 集去重。
- 经 SSH exec 通道的远程插件管理（list / add / remove / restart、spec 白名单）。
- 多来源侧边栏增强批次（workspace 分组、信息卡、运行中 subagent 指示、跨 ctx 实时同步）。
- 可信 IPC + 导航围栏到控制面主 frame；拒绝非 loopback 的 HTTP/WS origin。
- Windows 单趟精简安装器；应用/托盘图标；打包 dev 实例隔离。

### 修复

- 瞬时隧道失败经慢速重探重试；渲染层崩溃窗口恢复；N-ctx cordis ctx 在 dispose 时拆除；排队中的会话打开保持 pending 直到 runtime 接受；行操作上光标闪烁；chamberBridge 发布以投影签名门禁（保持身份一致的聚合状态）。

### 变更

- 集成 dsh 0.1.0-rc.7（harness 固定 + CI bundle 固定 + lockfile 同步）。
- v1 放弃 macOS x64 CI 构建（仅 arm64）。
- 自动更新重设计为低调的设置流（设计 11 范围）。

## [0.1.0] - 2026-08-15

初始发布 —— dsh 的本地桌面连接管理器：

- 控制面连接核心：web profile 宿主托管、管理 REST（`/health`、`/api/connections`、`/api/host/logs`）、每实例同源反代、静态前端服务。
- 自建渲染层（dsh 官方前端源码复用）：N-ctx 多实例、chamber 侧边栏 / 连接设置 / 设置壳客户端插件。
- SSH 传输（隧道 + 远端 systemd）、实例注册表、Electron 单 frame 壳、CLI。

v1 范围：无认证/审计面（仅 loopback 控制面）。

[0.1.3]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.3
[0.1.2]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.2
[0.1.1]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.1
[0.1.0]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.0
