# 模块完成状态总览（STATUS）

> 本文档只追踪**未完成 / 部分完成**项与范围契约。已实现基线以 git 历史、
> `CHANGELOG.md` 与 `docs/design/`（设计契约与样式定稿）为权威，不再在此
> 复述实现过程与验证日志。本文档是 dsh-chamber 进度追踪的唯一记录。

## 未完成 / 待执行

- **已归档会话管理（设计 12）**：方案 A（前端已归档浏览区先行）+ C（上游
  wire 根治）；实现未排期。设计见 `docs/todo/12-todo-archived-sessions.md`。
- **模型额外参数 + 默认推理等级（设计 07）**：实现推迟——wire 白名单无泛化
  透传、host 组合不可注入、`agent-default-model` 未对客户端暴露，待上游
  解锁（07 §3/§4）。设计见 `docs/design/07-models-params.md`。
- **SSH 密码认证可选增强（05 §8 例外主体已落地）**：未做（可选）——一键
  免密引导、系统钥匙串。
- **Windows 首版支持暂缓**：detached/进程组/lsof 降级路径；Unix 为契约
  目标。

## 部分完成（剩余验收 / 剩余实现）

- **桌面通知（设计 19，已实现）**：剩余 macOS 系统通知权限实机验收（M3，
  打包态冒烟）。契约见 `docs/design/19-notifications.md`。
- **VS Code 深链 + open-in 打开注册表（设计 16/17，M0–M3 已实现）**：
  剩余实机验收——macOS 深链冷/热启动、打包态、托盘/退出在途、N-ctx、
  VS Code 缺失、sshPort≠22、dev 深链 argv 注入测试路径、Finder 下拉在
  vendor 头部的定位/层叠、远程来源仅 vscode。契约见
  `docs/design/16-vscode-deeplink.md` / `docs/design/17-open-in-registry.md`。
  （2026-09 打磨：下拉行改为 图标 + 短应用名，OpenChamber OpenInAppButton
  样式；Finder 使用系统 Finder 图标（darwin，finder-icon.png），非 darwin
  保留中性文件夹标记；按钮组 hover 一体化 + 图标圆角微调；主按钮
  tooltip/aria-label 长句文案不变，无契约变化。）
- **Git Worktree 插件（设计 08，v1 已落地）**：M4 尚余真实远程 Linux +
  Git 仓库的端到端验收（含首次 ready-time seed 后重启生效、Git LFS/filter
  提示边界）。契约见 `docs/design/08-git-worktree-plugin.md`。
- **远程实例插件管理（设计 13，M1–M4 已落地）**：剩余——本地 `dsh plugin`/
  `pnpm pack` 依赖本机 pnpm（`resolvePnpmBinDir` 扫描 PATH + nvm/volta/
  homebrew，打包态 best-effort）。契约见 `docs/design/13-remote-plugin-management.md`。
- **桌面端更新（设计 11，已实现）**：剩余——配置真实签名秘密后的 release
  CI 上传/公证/验签实测，双平台实机检查/下载/退出安装；mac 安装腿未配置
  Developer ID 时 settings 响亮提示手动安装。契约见 `docs/design/11-auto-update.md`。

## 设计未决（02 §5 / 04 §7）

- **起始端口偏移**：本地默认起始端口（17510）与控制面端口（17500）相邻；
  是否可配 / 每实例偏移未定——当前以"固定起始端口 + P+1 重试 + 记录仲裁"
  落地（02 §5.2）。
- **trusted-host 自定义 Host**：`--trusted-host 127.0.0.1:<port>` 对应反代
  转发 Host 头（保持实例自身 host:port，不改写）；若引入自定义 Host 场景需
  同步扩展 trusted-host 集（05 §7.5 固定形态）。
- **多控制面 `$DSH_HOME` 冲突**：宿主 `DSH_HOME` 固定 `<stateDir>/dsh-home`，
  多控制面共享 stateDir 才共享 home——会话 JSONL 追加式多写安全，settings
  last-writer-wins 由 dsh `settings-conflict` 仲裁；不同 stateDir 互不相干
  （02 §5.6）。
- **响应头白名单双处同步**：上游引入新必需响应头需同步 03 §3.4 与 04 §4.3
  （一处契约两处表述）——建议单源化（04 §7.1）。
- **`__DSH_BOOT__` 随 dsh 版本漂移**：manifest 形状随 dsh `parseBootManifest`
  契约（vendor 源码为准）维护；构建链变更见 05 §6（04 §7.2）。

## 范围决策与剩余偏差（不做 / 推迟 / 移出）

- **移出项**（P3 硬纪律，永不回流）：认证/审计（密码/Passkey/会话 cookie/
  client token/限流/审计 SQLite）、控制面薄壳聊天/会话列表/审批弹窗、控制面
  会话运行时/统一索引/交互管线、连接注入适配器/broker/绑定、walkthrough、
  通知中心、cron、文件夹/笔记、web 预览、MCP、目标/终端等宿主 UI 职责面
  （处置映射见 01 §4；git/GitHub 例外：插件化，见 01 §4 / 设计 08）。
- **不做（v1）**：跨来源移动会话、单 store 真融合（fork runtime）、会话
  实时推送同步、远程实例管理 UI 外壳。
- **推迟**：flat 单列表模式（与「仅按来源分类」呈现原则张力）。
- **设置壳偏差（持续成立）**：未连接实例不装配子 ctx（配置在目标机器上，
  物理不可达）；stub remote 无 WS 失效流；设置壳不渲染官方 SettingsRoot；
  子 ctx 懒装配；服务器选择器使用 body portal + viewport 翻转/钳位（含窄
  视口缩放）+ 名称/实例 ID 搜索，超长 roster 内部纵向滚动；在线/离线状态
  同时使用文字与色点，搜索输入位于 listbox 外；离线远端仍可选并显示明确
  不可达占位与「前往连接管理」动作；chrome 跟随宿主 locale、子 ctx 跟随
  目标实例 locale。
- **默认排序 manual（06 §3.1）**：每来源会话排序默认 `manual`（保持 wire
  序），与官方默认 `updated` 不同——有意取舍；`orderBy[sourceId]` 持久化于
  `dsh-chamber.sidebar.v1`。
- **窗口标题冻结（桌面壳故意偏差）**：桌面壳冻结原生标题栏为 `dsh-chamber`
  （单 frame 品牌恒定），会话名仍在应用内呈现。
- **dev 实例隔离（dev 契约）**：`electron-dev.mjs` 以独立 `--user-data-dir`
  （`packages/desktop/.dev-user-data`）+ dev 控制面端口 17520
  （`DSH_CHAMBER_CP_PORT` 覆盖）启动，并清除继承的 `ELECTRON_RUN_AS_NODE`——
  dev 与运行中的打包版实例（同一应用名 → 同 userData/单实例锁、占 17500）
  可共存；打包版默认端口/数据路径不变。
