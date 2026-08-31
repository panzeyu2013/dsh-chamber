# dsh-chamber Gateway 部署指南

> 一键安装脚本：`scripts/install-gateway.sh`（交互向导 + 非交互模式）。
> 支持 install / update / restart / status / logs / uninstall 子命令。

## 1. 快速开始

```bash
# 方式 A：从仓库获取脚本（推荐，可审计）
curl -fsSL -o install-gateway.sh \
  https://raw.githubusercontent.com/panzeyu2013/dsh-chamber/main/scripts/install-gateway.sh
bash install-gateway.sh

# 方式 B：克隆仓库后本地执行
git clone https://github.com/panzeyu2013/dsh-chamber.git
cd dsh-chamber && bash scripts/install-gateway.sh
```

向导为「欢迎页 + 8 步配置」（版本通道 → 访问方式 → 登录凭据 → 端口 → 服务方式 → dsh 运行时 →
安装位置 → 预览确认），**每步都有白话说明**，输入非法会红字提示重问，`q` 退出、`ESC` 或 `back`
返回上一步；**「精确版本」会先列出 GitHub Releases 上全部可用版本**（稳定/预发布标记、
发布日期、gateway 资产标记），输入序号即可选中，也可直接输入版本号（可带 `v` 前缀）；
执行前有完整预览（含主要落盘路径与访问地址）。安装完成后询问是否把
`~/.dsh-chamber/bin` 加入 PATH（幂等写入 `~/.bashrc` / `~/.zshrc`），并把脚本自身
复制到该目录供后续管理。默认值：

| 项 | 默认 |
|---|---|
| 安装通道 | 最新稳定版（可交互选 beta / 精确版本：列出全部可用版本供选择或手动输入 / 离线包） |
| 访问方式 | 仅本机（127.0.0.1，免凭据；可交互选反向代理 / 直连 / 高级） |
| 登录凭据 | 外部形态必须设置：密码（默认）/ Token / 两者；`--no-auth` 交互模式下需输入 YES 二次确认（-y 时 flag 本身即显式放行） |
| 对外端口 | **30801**（dsh 内部端口 **30800** 一并说明，可改） |
| 安装方式 | **local**（`~/.dsh-chamber`，gateway 自管程序与 dsh 版本；可改 npm 全局） |
| 服务形态 | root + systemd；非 root + `systemctl --user`；无 systemd 自动前台 |
| dsh 版本 | 与发布绑定的 `DSH_CHAMBER_DSH_VERSION`（当前 0.1.2-alpha.2，可改；运行期可在 `/chamber/runtime` 切换） |
| npm 镜像 | 国内镜像 registry.npmmirror.com（可交互选官方源 / 跟随系统） |

## 2. 安装流程（脚本自动完成）

1. **dsh 先行**：探测已有 dsh（受控锚 / `--dsh-path` / npm 全局），受控锚直接
   复用；本机有非受管 dsh 时提示"是否由 gateway 接管管理"；无则按确认版本安装
   到受控锚目录 `~/.dsh-chamber/gateway/dsh-anchor`（镜像按所选源）。**dsh 未
   就绪不装 gateway**。
2. **下载 gateway**：解析 GitHub release 资产（latest 稳定 / `--channel beta`
   预发布 / `--version` 精确 pin；交互「精确版本」先列出全部可用版本供选择）→
   下载 tgz + **`.sha256` 校验**（校验失败即中止）。
3. **安装**：local（默认，`~/.dsh-chamber/gateway/versions/<v>` + `current` 指针，
   旧版保留可回滚）或 npm 全局（`--local` 之外的选择）。
4. **配置落盘**：`~/.dsh-chamber/gateway/gateway.conf`（生效配置与凭据，**0600**）+ `gateway.env`
   （凭据，**0600**，systemd 单元经 `EnvironmentFile` 引用）。凭据不进 argv/历史。
5. **服务**：systemd 单元（root，`enable --now`）或前台（nohup + pid 文件）。
6. **健康检查**：`/health` 轮询至 ready；失败则中止并报错，可重试（仅 `update` 有失败自动回滚）。

## 3. 端口模型

| 端口 | 含义 | 默认 | 配置 |
|---|---|---|---|
| gateway 监听 | 对外服务端口（建议经反代 HTTPS 暴露） | 30801 | `--gateway-port`（安装器只认 flag；运行期环境变量见 design 17） |
| 托管 dsh | gateway 托管的 loopback dsh | 30800 | `--dsh-port`（同上） |

交互向导在安装前探测占用并建议空闲端口、强制互斥；`--gateway-port/--dsh-port` 直给时仅校验合法性。本地桌面形态（dsh-chamber 桌面应用）不受
影响：spawn-dsh 基口默认仍 17510。

## 4. 公网接入（TLS 反代）

Gateway 不内置 TLS（传入 TLS 配置会 fail closed）。生产形态：

```
Caddy/Nginx (HTTPS :443)
   └─→ 127.0.0.1:30801（gateway，loopback）
          └─→ 127.0.0.1:30800（托管 dsh）
```

Caddy 示例：

```
gateway.example.com {
  reverse_proxy 127.0.0.1:30801
}
```

安装时配置 `--origin https://gateway.example.com` 与
`--trusted-proxy <反代精确 IP>`（Caddy/Nginx 所在机 IP；多个逗号分隔）。
外部形态（`0.0.0.0` 绑定 / origin / trusted-proxy 任一）**强制要求凭据**
（S1）：安装时自动生成并写入 0600 env，或 `--ui-password/--api-token` 显式
提供。`--no-auth` 是显式危险开关（二次确认 + 启动警告），仅限可信网络。

## 5. 管理命令

| 命令 | 行为 |
|---|---|
| `install-gateway.sh status` | 版本/端口/服务状态/健康 |
| `install-gateway.sh logs` | journalctl / 前台日志 tail -f |
| `install-gateway.sh restart` | 重启 gateway（systemd 重启单元 / 前台按 pid 记录重启） |
| `install-gateway.sh update [--version X] [--channel beta]` | 升级：下载+校验→热切换→健康检查→失败自动回滚（旧版保留） |
| `install-gateway.sh uninstall [--purge]` | 卸载：停服务→删单元→npm 卸载；默认保留数据，`--purge` 全清 |

已有安装时直接运行脚本会重走完整向导（预览页会提示"检测到已有安装，将原地复用数据并覆盖配置"）；日常管理用子命令（status/logs/restart/update/uninstall）。

## 6. 非交互 / CI

- `--skip-dsh`：不自动安装 dsh（已有受控锚时自动复用；否则需 `--dsh-path` 或 `DSH_GATEWAY_DSH_PATH`）。
- `-y uninstall` 免二次确认（`--purge` 仅 uninstall 有效）。

```bash
bash install-gateway.sh install -y \
  --channel beta \
  --gateway-port 30801 --dsh-port 30800 \
  --origin https://gw.example.com --trusted-proxy 10.0.0.1 \
  --ui-password '<PWD>' --api-token '<TOKEN>'
```

`-y/--yes`：全部使用默认值 + 命令行 flag（flag 优先于默认、可被交互覆盖）。
非 TTY（管道/CI）自动进入非交互，不会挂起等待输入。

## 7. 离线安装

- `update` 在离线模式（`--tgz`）下拒绝执行。

```bash
bash install-gateway.sh install -y \
  --tgz /path/to/dsh-chamber-gateway-<v>.tgz \
  --dsh-path /opt/dsh-ws   # 已有 dsh workspace；无则需本地 npm 缓存
```

## 8. 常见问题

- **下载失败**：确认网络可达 github.com（可设 `HTTPS_PROXY` 代理）；稳定通道
  若无 gateway 资产（v0.2.0 之前），用 `--channel beta`。
- **dsh 安装构建失败**：koffi/node-pty 等原生模块 postinstall 需要
  make/g++/python3（常见平台走 prebuild 可免）；安装日志会显式报错。
- **端口冲突**：向导探测占用并建议下一空闲口；两端口必须互异。
- **升级后不可用**：`update` 健康检查失败自动回滚到旧版本并保留现场日志。
- **启动即崩：`private directory must already have mode 0700: ~/.dsh-chamber`**
  （systemd 无限重启）：网关对已存在的私有 state 根目录要求严格 0700（fail-closed，
  绝不静默放宽）；旧安装用默认 umask 建出的 0755 根目录会触发。修复：
  `chmod 700 ~/.dsh-chamber && systemctl restart dsh-chamber-gateway`
  （新版安装器已自动收紧该目录，此条仅用于旧安装升级现场）。
- **root 与非 root**：文件统一落在 `~/.dsh-chamber`；root 仅用于 systemd 与
  npm 全局；非 root 自动用 `systemctl --user` 或前台。
