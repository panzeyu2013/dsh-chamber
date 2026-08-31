# dsh-chamber Gateway 部署指南

> 一键安装脚本：`scripts/install-gateway.sh`（交互向导 + 非交互模式）。
> 支持 install / update / status / logs / uninstall 子命令。

## 1. 快速开始

```bash
# 方式 A：从仓库获取脚本（推荐，可审计）
curl -fsSL -o install-gateway.sh \
  https://raw.githubusercontent.com/panzeyu2013/dsh-chamber/dev/scripts/install-gateway.sh
bash install-gateway.sh

# 方式 B：克隆仓库后本地执行
git clone https://github.com/panzeyu2013/dsh-chamber.git
cd dsh-chamber && bash scripts/install-gateway.sh
```

向导逐步确认（回车 = 接受默认值，输入 = 修改，`q` = 退出），执行前有完整
预览并可回改。默认值：

| 项 | 默认 |
|---|---|
| gateway 监听端口 | **30801** |
| 托管 dsh 监听端口 | **30800** |
| 安装方式 | npm 全局（`gateway` 进 PATH） |
| 安装位置 | `~/.dsh-chamber/`（root 与非 root 一致） |
| 服务形态 | root + systemd；非 root + `systemctl --user`；无 systemd 自动前台 |
| dsh 版本 | 与发布绑定的 `DSH_CHAMBER_DSH_VERSION`（当前 0.1.2-alpha.2，可改） |
| npm 镜像 | 跟随 `npm config get registry`（可交互覆盖） |

## 2. 安装流程（脚本自动完成）

1. **dsh 先行**：探测已有 dsh（`which dsh` / `npm root -g` / `--dsh-path`），
   有则复用并验证；无则按确认版本 `npm install -g`（镜像跟随 npm 设置），
   装完立即 `--version` 验证。**dsh 未就绪不装 gateway**。
2. **下载 gateway**：解析 GitHub release 资产（latest 稳定 / `--channel beta`
   预发布 / `--version` 精确 pin）→ 下载 tgz + **`.sha256` 校验**（校验失败
   即中止）。
3. **安装**：npm 全局（默认）或本地 `~/.dsh-chamber/gateway/versions/<v>`
   （`--local`，旧版保留可回滚）。
4. **配置落盘**：`~/.dsh-chamber/gateway/gateway.conf`（生效配置）+ `gateway.env`
   （凭据，**0600**）。systemd 单元经 `EnvironmentFile` 引用，凭据不进 argv/历史。
5. **服务**：systemd 单元（root，`enable --now`）或前台（nohup + pid 文件）。
6. **健康检查**：`/health` 轮询至 ready；失败自动回滚并报错。

## 3. 端口模型

| 端口 | 含义 | 默认 | 配置 |
|---|---|---|---|
| gateway 监听 | 对外服务端口（建议经反代 HTTPS 暴露） | 30801 | `--gateway-port` / `DSH_GATEWAY_PORT` |
| 托管 dsh | gateway 托管的 loopback dsh | 30800 | `--dsh-port` / `DSH_GATEWAY_DSH_PORT` |

两端口安装前探测占用、强制互斥。本地桌面形态（dsh-chamber 桌面应用）不受
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
| `install-gateway.sh update [--version X] [--channel beta]` | 升级：下载+校验→热切换→健康检查→失败自动回滚（旧版保留） |
| `install-gateway.sh uninstall [--purge]` | 卸载：停服务→删单元→npm 卸载；默认保留数据，`--purge` 全清 |

已有安装时直接运行脚本进入管理菜单（升级/重装/卸载/退出）。

## 6. 非交互 / CI

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
- **root 与非 root**：文件统一落在 `~/.dsh-chamber`；root 仅用于 systemd 与
  npm 全局；非 root 自动用 `systemctl --user` 或前台。
