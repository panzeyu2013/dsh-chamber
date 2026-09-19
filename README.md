# dsh-chamber（中文说明）

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-brightgreen)]()

dsh（DeepSeek Harness）的桌面连接管理器：把本机与多台服务器的dsh实例收进一个原生窗口——本地打开即用，远程一键接入。

## 用户界面

![dsh-chamber用户主界面](assets/page.png)

*用户主界面——单窗口，dsh原生侧边栏按来源列出（本地 + 远程）session/workspace，主区为活动实例的dsh shell。*

> English: [README.en-US.md](docs/README.en-US.md) · 开发文档 [DEVELOPMENT.md](docs/DEVELOPMENT.md) · 设计入口 [01-overview.md](docs/design/01-overview.md) · 进度 [STATUS.md](docs/progress/STATUS.md)

## 快速开始

### 1 · 下载安装

各平台安装包见 [GitHub Releases](https://github.com/panzeyu2013/dsh-chamber/releases)：

- macOS：`dsh-chamber-<version>-<arch>.dmg`
- Windows：NSIS安装器（`.exe`）
- Linux：`dsh-chamber-<version>.AppImage`（x64；需FUSE或
  `APPIMAGE_EXTRACT_AND_RUN=1`；自动更新需从可写路径启动AppImage，
  见 `docs/design/22-linux-desktop.md`）

### 2 · 启动应用

启动后本地dsh实例自动托管（web profile自动启动/守护/健康检查，无需命令行），首屏即其完整dsh界面。

### 3 · 部署服务器端（连接远程之前）

要接入远程服务器上的dsh，需先在服务器完成部署，桌面端才能连接。两种方式任选：

#### 方式一：一键脚本安装 Gateway（推荐）

Gateway在服务器上托管dsh实例，提供统一认证入口。一条命令启动交互式向导（选项均带说明与校验，`q` 退出，`ESC` 或 `back` 返回上一步）：

```bash
curl -fsSL -o install-gateway.sh \
  https://raw.githubusercontent.com/panzeyu2013/dsh-chamber/main/scripts/install-gateway.sh
bash install-gateway.sh
```

脚本自动完成（默认仅本机访问、安装到 `~/.dsh-chamber`、gateway监听30801、托管dsh监听30800，均可修改）：

1. dsh就绪 — 探测本机dsh：受管版本直接复用，非受管版本询问是否接管，没有则自动安装
2. 下载 + 校验 — 从GitHub Release拉取安装包并做sha256校验
3. 安装 — 默认local安装；gateway自管dsh版本，运行期可在 `/chamber/runtime` 切换
4. 凭据 — 双重输入 + 字符计数，写入0600权限的配置文件
5. 服务化 — systemd单元（root系统单元；非root默认 `systemctl --user`；无systemd自动前台运行）
6. 健康检查 — 轮询 `/health` 直至就绪

安装完成后：

- 日常管理：`install-gateway.sh status|logs|restart|update|uninstall`
- 公网接入：用Nginx/Caddy将HTTPS反代到 `127.0.0.1:30801`，见 [docs/deploy/deploy-gateway.md](docs/deploy/deploy-gateway.md)
- 桌面接入：「设置 → 连接」添加Gateway来源（HTTP transport + 反代地址），按需配置共享token / 登录密码

#### 方式二：远程 dsh 实例 + systemd

不装gateway时，可用systemd（系统或user单元，非root用户运行）持久化服务器上的dsh实例，桌面端经SSH隧道接入；完整配置与排障见 [docs/deploy/remote-dsh-instance.md](docs/deploy/remote-dsh-instance.md)。

已有直连实例、想改用Gateway？旧数据不会自动跟随；安装Gateway后按 [deploy-gateway.md §3「从直连dsh迁移到Gateway」](docs/deploy/deploy-gateway.md) 迁移一次即可。

### 4 · 添加远程主机

「设置 → 连接」按目标（`dsh` / `gateway`）× 传输（`ssh` / `http`）四组合接入：SSH由应用自动建隧道并管理远端systemd；HTTP(S) 由主进程直连（默认HTTPS，显式HTTP常驻风险提示）。

## 功能特性

- 本地dsh一键托管 — 本地实例自动启动、就绪检测、守护/回收、健康状态与宿主日志；首屏即完整dsh界面
- 运行时版本管理（热重载） — 设置页按实例切换/升级/回滚运行时即时生效，插件更新无需重启桌面应用（本地与gateway均可）
- 远程实例SSH接入 — 添加主机后自动建立SSH隧道并管理远端systemd服务；支持密钥或密码认证
- 认证Gateway接入 — 部署gateway后将其作为 `gateway` 来源接入，共享token / 登录密码按需配置，默认HTTPS
- 统一侧边栏多来源导航 — 本地 + 远程各实例的session/workspace在同一dsh原生侧边栏按来源分组、平等列出（远程带颜色徽标）；单击打开、双击重命名
- 侧边栏折叠 / 拖拽 / 强调色 — 来源级折叠开关一键收拢该来源workspace列表；server分组可拖拽排序（跨实例持久化）；来源/workspace带柔和强调色条
- Git Worktree生命周期 — 侧边栏按实例展示仓库拓扑并闭环创建worktree → workspace → session；删除采用Git-first可重试事务：主工作树/locked/运行中目标硬阻断，dirty目标须显式勾选「丢弃未提交更改」后才以force移除（分支与已提交内容保留），可选删除本地分支
- 多实例并行（N-ctx） — 一个窗口内多个dsh shell共存，随时切换活动实例
- open-in打开注册表 — 会话头部统一打开面：本地来源在Finder/文件管理器显示目录；本地或SSH远程来源可拉起VS Code（本地 `vscode://file/`、远程Remote-SSH）；支持 `dsh-chamber://` 深链
- 桌面通知 — 会话完成 / 提问 / 审批时推送桌面通知，点击直达会话；设置「通知」分组可开关
- 桌面端更新 — stable与beta配置和feed独立；静默检查，设置页「更新」展示，确认后下载、退出时安装（低打扰、无弹窗）
- 睡眠/后台常驻 — 关窗可隐藏到托盘继续运行（或退出并确认）；登录自启（macOS/Windows/Linux）；OS唤醒即时重连；保持唤醒开关
- Chamber设置页 — 设置壳固定入口：连接 / 通用；chamber全局设置与各实例配置严格分离
- 后端版本容忍 — 实例后端dsh前端版本与chamber壳不同步时照常可用：壳未覆盖的额外插件行降级为「特性缺席」（绝不整boot崩溃）

## 常见问题

- **`pnpm run smoke` 为什么打印SKIP？** — 冒烟测试需要dsh安装；找不到时打印SKIP并以0退出，属正常而非失败。
- 远程实例需要什么？ — dsh目标需要可达的API profile；gateway目标需要已部署的 `@dsh-chamber/gateway`。两者均可经SSH隧道或显式HTTP(S) 直连；远端无需单独装web前端，UI复用本地前端并经同源反代。
- agent preset / profile在各实例间怎么工作？ — 按实例权威：每个实例的 `settings`/`credentials`/`llm`/`agentPreset` 配置平面只在该实例一侧（本地 = 本机，远程 = 远端）。编辑远程预设须切到该来源shell的「设置 → Agent presets」页。
- 前端从哪来？ — dsh官方前端源码复用自建；每个实例保持原生UI。
- Windows安装慢 / 卡在"正在安装"？ — Defender逐文件实扫 ~33k个运行时文件所致，属已知取舍（design 23 F3）：等待完成或对 `%APPDATA%\dsh-chamber` 加Defender排除目录提速；安装/更新状态行有明示。
- Windows上SSH连接能用密码吗？ — 不能（askpass需要PE可执行）。请用密钥或ssh-agent（Pageant）——保存连接时拒绝密码并有引导提示。
- Windows上dsh运行时版本管理？ — 推进中（design 23）：默认只读投影；开发验证经 `DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1` 开启，正式解锁以真实Windows验证记录为准。
- Windows版为什么有SmartScreen提示？ — 安装包尚未Authenticode签名（已知取舍，design 23 F6）；sha512校验只证明下载完整性。从本仓库Release下载时选「更多信息 → 仍要运行」即可。

## 文档

|文档|用途|
|---|---|
|[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)|开发文档：架构总览/环境搭建/构建打包/CI发布/仓库结构|
|[docs/deploy/deploy-gateway.md](docs/deploy/deploy-gateway.md)|Gateway服务器端部署指南|
|[docs/deploy/remote-dsh-instance.md](docs/deploy/remote-dsh-instance.md)|远程dsh实例的systemd持久化说明|
|[CONTRIBUTING.md](CONTRIBUTING.md)|贡献指南（测试/Commit/PR契约）|
|[AGENTS.md](AGENTS.md)|开发约束（常驻仓库规则）|
|[CHANGELOG.md](CHANGELOG.md)|版本变更记录|
|[docs/design/01-overview.md](docs/design/01-overview.md)|设计入口：收拢原则、范围、移除映射|
|[docs/progress/STATUS.md](docs/progress/STATUS.md)|完成状态、剩余偏差与验证记录|
|[docs/README.en-US.md](docs/README.en-US.md)|English README|

## 相关项目

- [deepseek-harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) — 被管理的宿主
- [OpenChamber](https://github.com/openchamber/openchamber) — dsh-chamber的N-ctx设计灵感与命名来源，感谢启发！

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)；开发约束见 [AGENTS.md](AGENTS.md)，环境与构建见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## License

MIT — 见 [LICENSE](LICENSE)。
