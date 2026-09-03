# dsh-chamber（中文说明）

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-brightgreen)]()

**dsh（DeepSeek Harness）的桌面连接管理器**：一个原生桌面应用，把本机与多台服务器上的 dsh 实例统一收进同一个窗口——本地打开即用，远程一键接入。

**为什么选择 dsh-chamber？**

- **原生桌面体验，打开即用** — 本地 dsh 实例自动托管（启动、守护、健康检查），无需命令行；单窗口内多个 dsh shell 并行（N-ctx），随时切换
- **dsh 运行时版本管理 + 热重载** — 每个实例的 dsh 运行时独立管理：切换版本、更新插件即时生效，桌面应用无需重装、无需重启
- **桌面端多设备连接** — 一台电脑管理本机与任意多台服务器上的 dsh：SSH 隧道自动建立、远端 systemd 服务自动托管；也可经认证 Gateway 安全接入
- **更好的侧边栏与远程功能** — 本地与远程的 session/workspace 在同一个原生侧边栏内平等列出、按来源分组：支持折叠、拖拽排序、Git worktree 拓扑、会话完成/提问/审批的桌面通知，以及一键打开 Finder/VS Code

## 用户界面

![dsh-chamber 用户主界面](assets/page.png)

*用户主界面——单窗口，dsh 原生侧边栏平等列出各来源（本地 + 远程实例）的 session/workspace，主区为活动实例的纯 dsh shell。*

> English: [docs/README.en-US.md](docs/README.en-US.md) · 开发文档 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) · 设计入口 [docs/design/01-overview.md](docs/design/01-overview.md) · 进度 [docs/progress/STATUS.md](docs/progress/STATUS.md)

## 快速开始

### 1 · 下载安装

从 [GitHub Releases](https://github.com/panzeyu2013/dsh-chamber/releases) 下载对应平台的安装包：

- **macOS**：`dsh-chamber-<version>-<arch>.dmg`
- **Windows**：NSIS 安装器（`.exe`）
- **Linux**：`dsh-chamber-<version>.AppImage`（x64；需要 FUSE 或
  `APPIMAGE_EXTRACT_AND_RUN=1`，自动更新需从可写路径启动 AppImage，
  见 `docs/design/21-linux-desktop.md`）

### 2 · 启动应用

启动后**本地 dsh 实例自动托管**（web profile 自动启动/守护/健康检查），首屏即本地实例的完整 dsh 界面。

### 3 · 部署服务器端（连接远程之前）

要接入远程服务器上的 dsh，请先在其中一台服务器上完成部署，桌面端才能连接。两种方式任选：

#### 方式一：一键脚本安装 Gateway（推荐）

Gateway 在服务器上托管一个 dsh 实例，并提供统一的认证访问入口。一条命令启动交互式向导（每个选项都有说明与校验，`q` 退出，`ESC` 或 `back` 返回上一步）：

```bash
curl -fsSL -o install-gateway.sh \
  https://raw.githubusercontent.com/panzeyu2013/dsh-chamber/main/scripts/install-gateway.sh
bash install-gateway.sh
```

脚本自动完成（默认：仅本机访问、安装到 `~/.dsh-chamber`、gateway 监听 30801、托管 dsh 监听 30800，均可修改）：

1. **dsh 就绪** — 探测本机 dsh：已有受管版本直接复用，非受管版本询问是否接管，没有则自动安装
2. **下载 + 校验** — 从 GitHub Release 拉取安装包并做 sha256 校验
3. **安装** — 默认 local 安装；gateway 自管 dsh 版本，运行期可在 `/chamber/runtime` 切换
4. **凭据** — 双重输入 + 字符计数，写入 0600 权限的配置文件
5. **服务化** — systemd 单元（root 系统单元；非 root 默认 `systemctl --user`；无 systemd 自动前台运行）
6. **健康检查** — 轮询 `/health` 直至就绪

安装完成后：

- **日常管理**：`install-gateway.sh status|logs|restart|update|uninstall`
- **公网接入**：用 Nginx/Caddy 将 HTTPS 反代到 `127.0.0.1:30801`，详见 [docs/deploy/deploy-gateway.md](docs/deploy/deploy-gateway.md)
- **桌面接入**：「设置 → 连接」添加 Gateway 来源（HTTP transport + 反代地址），按需配置共享 token / 登录密码

#### 方式二：远程 dsh 实例 + systemd

不装 gateway 时，可直接把服务器上的 dsh 实例用 **systemd** 持久化（系统单元或 user 单元，以非 root 用户运行），桌面端经 SSH 隧道接入。完整配置与排障见 [docs/deploy/remote-dsh-instance.md](docs/deploy/remote-dsh-instance.md)。

已有该直连实例、想改用 Gateway？旧数据不会自动跟随，安装 Gateway 后按 [deploy-gateway.md §3「从直连 dsh 迁移到 Gateway」](docs/deploy/deploy-gateway.md) 做一次数据迁移，即可无缝延续。

### 4 · 添加远程主机

「设置 → 连接」按目标（`dsh` / `gateway`）× 传输（`ssh` / `http`）四组合接入：SSH 由应用自动建立隧道并可管理远端 systemd；HTTP(S) 由主进程直连（默认 HTTPS，显式选择 HTTP 会常驻风险提示）。

## 功能特性

- **本地 dsh 一键托管** — 打开即用：本地实例自动启动、就绪检测、守护/回收、健康状态与宿主日志；首屏就是本地实例的完整 dsh 界面
- **运行时版本管理（热重载）** — 设置页按实例管理 dsh 运行时：切换版本、升级/回滚即时生效，插件更新无需重启桌面应用（本地实例与 gateway 均可）
- **远程实例 SSH 接入** — 连接设置页添加主机后，自动建立 SSH 隧道并管理远端 systemd 服务；支持密钥或密码认证
- **认证 Gateway 接入** — 服务器部署 gateway 后，桌面端将其作为 `gateway` 来源接入，共享 token / 登录密码按需配置，默认 HTTPS
- **统一侧边栏多来源导航** — 本地 + 远程各实例的 session/workspace 在同一个 dsh 原生侧边栏内平等列出、按来源分组（远程来源带颜色徽标）；单击打开会话、双击重命名
- **侧边栏折叠 / 拖拽 / 强调色** — 来源级折叠开关一键收拢该来源的 workspace 列表；server 分组可拖拽排序（跨实例持久化）；来源/workspace 携带柔和强调色条
- **Git Worktree 生命周期** — 侧边栏按实例展示仓库拓扑，闭环创建 worktree → workspace → session；删除采用 Git-first 可重试事务：主工作树/locked/运行中目标硬阻断，dirty 目标须在对话框中显式勾选「丢弃未提交更改」后才以 force 移除（分支与已提交内容保留），删除时还可选同时删除本地分支
- **多实例并行（N-ctx）** — 一个窗口内多个 dsh shell 共存，随时切换活动实例
- **open-in 打开注册表** — 会话头部统一打开面：本地来源在 Finder/文件管理器显示目录；本地或经 SSH 接入的远程来源可拉起 VS Code（本地 `vscode://file/`、远程 Remote-SSH）；支持 `dsh-chamber://` 深链
- **桌面通知** — 会话完成 / 提问 / 审批时推送桌面原生通知，点击直达该会话；可在设置「通知」分组开关
- **桌面端更新** — stable 与 beta 使用彼此独立的配置和 feed；静默检查新版本，设置页「更新」展示，确认后下载、退出时安装（低打扰、无弹窗）
- **睡眠/后台常驻** — 关窗可隐藏到托盘继续运行（或退出并确认）；登录自启（mac/linux）；OS 唤醒即时重连；保持唤醒开关
- **Chamber 设置页** — 设置壳固定入口：连接 / 通用；chamber 全局设置与各实例配置严格分离
- **后端版本容忍** — 实例后端 dsh 官方前端版本与 chamber 壳不同步时照常可用：壳未覆盖的额外插件行以「特性缺席」降级（绝不整 boot 崩溃）

## 常见问题

- **`pnpm run smoke` 为什么打印 SKIP？** — 冒烟测试需要 dsh 安装；找不到时打印 SKIP 并以 0 退出。这属正常，不是失败。
- **远程实例需要什么？** — dsh 目标需要可达的 API profile；gateway 目标需要已部署的 `@dsh-chamber/gateway`。两者都可经 SSH 隧道或显式 HTTP(S) 直连；远端无需单独安装 web 前端，UI 来自本地复用前端并经同源反代。
- **agent preset / profile 在各实例间怎么工作？** — 按实例权威。每个实例的 `settings`/`credentials`/`llm`/`agentPreset` 配置平面只存在于该实例一侧（本地 = 本机，远程 = 远端服务器）。编辑远程预设 = 切到该来源的 shell，在其「设置 → Agent presets」页操作。
- **前端从哪来？** — dsh 官方前端源码复用自建；每个实例保持原生 UI。

## 文档

| 文档 | 用途 |
|---|---|
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发文档：架构总览/环境搭建/构建打包/CI 发布/仓库结构 |
| [docs/deploy/deploy-gateway.md](docs/deploy/deploy-gateway.md) | Gateway 服务器端部署完整指南 |
| [docs/deploy/remote-dsh-instance.md](docs/deploy/remote-dsh-instance.md) | 远程 dsh 实例的 systemd 持久化完整说明 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南（测试/Commit/PR 契约） |
| [AGENTS.md](AGENTS.md) | 开发约束（常驻仓库规则） |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |
| [docs/design/01-overview.md](docs/design/01-overview.md) | 设计入口：收拢原则、范围、移除映射 |
| [docs/progress/STATUS.md](docs/progress/STATUS.md) | 完成状态、剩余偏差与验证记录 |
| [docs/README.en-US.md](docs/README.en-US.md) | English README |

## 相关项目

- [deepseek-harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) — 被管理的宿主
- [OpenChamber](https://github.com/openchamber/openchamber) — dsh-chamber 的 N-ctx 多实例设计与命名灵感来源，感谢启发！

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。开发约束见 [AGENTS.md](AGENTS.md)，开发环境与构建见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## License

MIT — 见 [LICENSE](LICENSE)。
