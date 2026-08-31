# dsh-chamber（中文说明）

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-brightgreen)]()

**[dsh](https://github.com/deepseek-ai/deepseek-harness) 的本地桌面连接管理器。**

## 用户界面

![dsh-chamber 用户主界面](assets/page.png)

*用户主界面——单窗口，dsh 原生侧边栏平等列出各来源（本地 + 远程实例）的 session/workspace，主区为活动实例的纯 dsh shell。*

> [!WARNING]
> **公开 Beta（v0.2.0-beta.x）**——协议与 API 仍在迭代，可能存在破坏性变更。

> English: [docs/README.en-US.md](docs/README.en-US.md) · 开发文档 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) · 设计入口 [docs/design/01-overview.md](docs/design/01-overview.md) · 进度 [docs/progress/STATUS.md](docs/progress/STATUS.md)

## 快速开始

### 1 · 下载安装

从 [GitHub Releases](https://github.com/panzeyu2013/dsh-chamber/releases) 下载对应平台的安装包：

- **macOS**：`dsh-chamber-<version>-<arch>.dmg`
- **Windows**：NSIS 安装器（`.exe`）——安装慢/卡"正在安装"的排障见「常见问题」

### 2 · 打开应用

启动后**本地 dsh 实例自动托管**（web profile 自动启动/守护/健康检查），首屏即本地实例的完整 dsh 界面。

### 3 · 添加远程主机

「设置 → 连接」以目标 `dsh|gateway` × 传输 `ssh|http` 四组合接入。SSH 由应用建立
隧道并可管理远端 systemd；HTTP(S) 由主进程直连（默认 HTTPS，显式 HTTP 会常驻风险
提示）；Gateway token/密码可独立配置。服务器部署见「服务器端部署」。

### 4 · 从源码运行？

见开发文档 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 功能特性

- **本地 dsh 一键托管** — 打开即用：本地实例自动启动、就绪检测、守护/回收、健康状态与宿主日志；首屏就是本地实例的完整 dsh 界面
- **远程实例 SSH 接入** — 连接设置页添加主机后，自动建立 SSH 隧道并管理远端 systemd 服务；支持可选的主机密码认证（安全存储，见「安全」）
- **认证 Gateway 接入** — 可把同一台设备上的 loopback dsh 通过独立 gateway 安全发布为 HTTPS 服务，并在桌面 N-ctx 中作为 `gateway` 来源接入；token 仅进入主进程拥有且绑定目标的秘密存储（safeStorage 优先，不可用时诚实回退为 0600 明文文件），不进注册表或日志
- **统一侧边栏多来源导航** — 本地 + 远程各实例的 session/workspace 在同一个 dsh 原生侧边栏内平等列出、按来源分组（远程来源带颜色徽标）；单击打开会话、双击重命名
- **侧边栏折叠 / 拖拽 / 强调色** — 来源级折叠开关一键收拢该来源的 workspace 列表；server 分组可拖拽排序（跨实例持久化）；来源/workspace 携带柔和强调色条（design 06 §2.4/§3.1）
- **Git Worktree 生命周期** — chamber 内建独立插件在侧边栏按实例展示仓库拓扑，并闭环创建 worktree → workspace → session；删除采用 Git-first 可重试事务：主工作树/locked/运行中目标硬阻断，dirty 目标须在对话框中显式勾选「丢弃未提交更改」后才以 force 移除（分支与已提交内容保留），删除对话框还可选同时删除本地分支
- **多实例并行（N-ctx）** — 一个窗口内多个 dsh shell 共存，随时切换活动实例
- **open-in 打开注册表** — 会话头部统一打开面：本地来源在 Finder/文件管理器显示目录，本地来源或经 SSH transport 接入的远程来源可拉起 VS Code（本地 `vscode://file/`、远程 Remote-SSH；HTTP 直连无 SSH authority，故不显示远程按钮；`dsh-chamber://` OS 深链，需本机安装 VS Code）；可用性实探、失败全 loud（design 20）
- **桌面通知** — 会话完成 / 提问 / 审批时推送桌面原生通知，点击直达该会话；可在设置「通知」分组开关（design 19）
- **桌面端更新** — stable 与 beta 使用彼此独立的配置和 feed；静默检查新版本，设置页「更新」展示，确认后下载、退出时安装（低打扰、无弹窗）
- **睡眠/后台常驻** — 关窗可隐藏到托盘继续运行（或退出并确认）；登录自启（mac/linux）；OS 唤醒即时重连；保持唤醒开关
- **Chamber 设置页** — 设置壳固定入口：连接 / 通用；chamber 全局设置与各实例配置严格分离
- **后端版本容忍（rc.2 兼容）** — 实例后端 dsh 官方前端版本与 chamber 壳不同步时照常可用：壳未覆盖的额外插件行以「特性缺席」降级（绝不整 boot 崩溃），rc.2 后端已无头验证
- **安全与隐私** — 普通桌面控制面仅监听 loopback（127.0.0.1）；SSH 密码经
  owner-only askpass lease 注入 ssh；Gateway token 只进有界 Authorization 头，原始
  登录密码只进绑定 gateway 的 `/auth/login` JSON body，反代仅注入派生 Cookie。凭据仅
  表单瞬时输入、永不回填/返回 renderer，并以绑定目标的 owner-only
  镜像保存，永不进入注册表或日志；公网能力只存在于显式启动且强制认证的独立 gateway
  （默认；`--no-auth` 为可信网络的有界偏差）

## 服务器端部署

### 认证 Gateway（Design 17）

Gateway 自己托管一个 loopback dsh，并通过认证边界统一代理 HTTP/WS/SSE。生产环境应让
gateway 仍监听 loopback，由 Nginx/Caddy 终止 TLS；Desktop 默认 HTTPS，显式 HTTP
仅作为可信网络的有界选择并持续显示明文风险。

**安装（一键脚本）**——从 GitHub release 拉取安装包（npm 未发布也能装），
8 步交互向导（每个选项都有说明与校验，默认：仅本机访问、local 安装到
`~/.dsh-chamber`、gateway 监听 **30801**、托管 dsh 监听 **30800**，均可改）：

```bash
curl -fsSL -o install-gateway.sh \
  https://raw.githubusercontent.com/panzeyu2013/dsh-chamber/main/scripts/install-gateway.sh
bash install-gateway.sh          # 交互向导（q 退出 / ESC 或 back 返回上一步）
```

脚本自动完成：dsh 探测/安装（已有则复用或提示接管）→ 下载 + sha256 校验 →
local 安装（默认；gateway 自管 dsh 版本，运行期可在 `/chamber/runtime` 切换）
→ 凭据写入 0600 env（外部形态；双重输入 + 回车后显示字符计数）→ systemd 单元（root；非 root 默认 systemctl --user，无 systemd 自动前台）→ 健康检查；完成后可选把 `~/.dsh-chamber/bin` 加入 PATH；
管理命令 `install-gateway.sh status|logs|restart|update|uninstall`。
公网接入：反代将 HTTPS 转到 `127.0.0.1:30801` 并配置 `--origin` 与
`--trusted-proxy`（详见 [docs/deploy/deploy-gateway.md](docs/deploy/deploy-gateway.md)）。
Desktop 接入：「设置 → 连接」选择 Gateway + HTTP transport，填反代地址，并按需配置
共享 token 和/或登录密码（默认 HTTPS；明文 HTTP 必须显式选择）。

### 远程 dsh 实例（systemd）

远程服务器上的 dsh 实例可用 **systemd** 持久化（系统单元或 user 单元，以
非 root 用户运行，文件落在该用户自己的家目录）。完整单元配置、SSH
transport 说明与排障见 [docs/deploy/remote-dsh-instance.md](docs/deploy/remote-dsh-instance.md)；
服务器端部署统一入口见 [docs/deploy/deploy-gateway.md](docs/deploy/deploy-gateway.md)。

## 安全

- **v1 无认证边界** — 控制面仅监听 loopback（127.0.0.1）；全部 `/api/*` 路由与每实例反代匿名可达；HTTP/WS 来源必须与当前 Host 精确同源或命中显式开发 allowlist，其他回环端口与 `Origin: null` 均拒绝
- **传输 URL 不进 renderer；凭据仅瞬时写入** — renderer 的返回值、事件与投影
  均非秘密。受限 write-only 例外（[设计 05 §8](docs/design/05-connection-manager.md) / [设计 17 §12](docs/design/17-server-side-gateway.md)）：SSH 密码镜像到 0600 `ssh-passwords.json`
  schema v2 endpoint binding，并由每个真实 ssh child 独占的 0700 askpass lease 注入；
  Gateway token/密码镜像到 `gateway-secrets.json` schema v3 target binding
  （safeStorage 优先、诚实 0600 回退），只注入对应 gateway transport。两者均瞬时
  表单输入、主进程持有、注入前复验 registry，永不由主进程返回/回填或持久化到
  renderer，也永不上命令行/日志/注册表；
  非空无 binding 旧文件 fail closed 并要求重录。Gateway cookie 会话按网络 origin、
  `Host` authority 与稳定的「连接 id + 目标」scope 共同隔离；generation/刷新 epoch
  会拦住撤销后的迟到登录、fallback 与 refresh 结果。配置 HTTPS SPKI pin 时，登录、
  探针及 HTTP/WS 反代必须先完成证书匹配，匹配前不发送任何应用层请求字节。
  add/edit/非空凭据写走主进程 `desktop_ssh_save_connection`；删除走精确
  `desktop_ssh_delete_connection(id)`（不存在 id 为幂等 no-op）；legacy
  `instances_set` 只允许当前规范化 roster 的 exact unchanged no-op，三个旧 setter
  只允许 clear。
  Windows v1 关闭 SSH 密码门。
- **systemctl 用参数数组 spawn**（无 shell），固定 argv 为
  `systemctl <action> -- <serviceName>`；serviceName 白名单为
  `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`（首字符必须为字母或数字）
- **插件动作主进程确认（[设计 09 §4](docs/design/09-client-plugin-runtime-loading.md)）**：materialize 外传、本地/远端插件安装与卸载均须用户确认对话框；本地插件清单依赖值路径脱敏
- **Git 不经过 Desktop/SSH 命令转发** — Git host 插件运行在每个 dsh 实例进程内，与 workspace 权威使用同一 OS 用户和文件系统；只开放固定 worktree 领域操作、`shell:false` 参数数组和有界输出/超时，不提供 fetch/pull/push 等网络 Git 动词。创建时的 checkout 仍会遵从该 OS 用户已配置的仓库 filter（例如 Git LFS，可能访问网络），确认界面会显式提示这一受信边界

## 常见问题

- **`pnpm run smoke` 为什么打印 SKIP？** — 冒烟测试需要 dsh 安装；找不到时打印 SKIP 并以 0 退出。这属正常，不是失败。
- **远程实例需要什么？** — dsh 目标需要可达的 API profile；gateway 目标需要已部署
  `@dsh-chamber/gateway`。两者都可经 SSH 隧道或显式 HTTP(S) 直连；远端无需单独安装
  web 前端，UI 来自本地复用前端并经 `/api/i/dsh-<id>/*` 或
  `/api/i/gateway-<id>/*` 同源反代。
- **agent preset / profile 在各实例间怎么工作？** — 按实例权威。每个实例的 `settings`/`credentials`/`llm`/`agentPreset` 配置平面只存在于该实例一侧（本地 = 本机，远程 = 远端服务器）。所有读写都经 `/api/i/<id>/*` 反代落到该实例自己的 API——新会话界面的 preset 选择器列出的是该 session 所属实例的 roster，选择也写回该实例。不存在跨来源的 profile 匹配/融合；编辑远程预设 = 切到该来源的 shell，在其 设置 → Agent presets 页操作。
- **前端从哪来？** — dsh 官方前端源码复用自建；每个实例保持原生 UI。

> **Windows 安装卡在"正在安装"界面/进度条来回反复的排障**
>
> 安装器内置的 dsh 运行时文件数较多，Windows Defender 实时防护会对每个新建文件
> 扫描，把解压拖到几十分钟；文件被锁时安装器还会进入"解压→拷贝失败→整体重解压"
> 的重试循环（进度条走满→清零→重走、任务管理器持续写盘），看起来就像永远卡死。
> 打包侧已做修复（zip 单趟直解 + hoisted 扁平布局 + 运行时裁剪）。若仍遇到卡住：
>
> 1. 安装前**关闭旧版 dsh-chamber**；若此前有过失败/中断的安装，先在"设置 → 应用 → 已安装的应用"里卸载残留版本（残留的旧卸载器会让新安装器卡在"等待旧版本卸载"的重试循环里）。
> 2. 安装期间为安装器与安装目录（默认 `%LOCALAPPDATA%\Programs\dsh-chamber`）临时添加 **Windows 安全中心 → 病毒和威胁防护 → 排除项**（或临时关闭实时防护，装完恢复）——这是"卡死"最快的解药。
> 3. 安装完成后可移除排除项。

## 文档

| 文档 | 用途 |
|---|---|
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发文档：架构总览/环境搭建/构建打包/CI 发布/仓库结构 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南（测试/Commit/PR 契约） |
| [AGENTS.md](AGENTS.md) | 开发约束（常驻仓库规则） |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |
| [docs/design/01-overview.md](docs/design/01-overview.md) | 设计入口：收拢原则、范围、移除映射 |
| [docs/design/05-connection-manager.md](docs/design/05-connection-manager.md) | 表面/架构契约（v1） |
| [docs/progress/STATUS.md](docs/progress/STATUS.md) | 完成状态、剩余偏差与验证记录 |
| [docs/README.en-US.md](docs/README.en-US.md) | English README |
| [docs/deploy/remote-dsh-instance.md](docs/deploy/remote-dsh-instance.md) | 远程 dsh 实例的 systemd 持久化完整说明 |

## 相关项目

- [deepseek-harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) — 被管理的宿主
- [OpenChamber](https://github.com/openchamber/openchamber) — dsh-chamber 的 N-ctx 多实例设计与命名灵感来源，感谢启发！

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。开发约束见 [AGENTS.md](AGENTS.md)，开发环境与构建见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## License

MIT — 见 [LICENSE](LICENSE)。
