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
| npm 镜像 | 国内镜像 registry.npmmirror.com（可交互选官方源 / 跟随系统）。**仅用于 dsh 内建锚安装**；运行期 `/chamber/runtime` 的版本安装源是独立的（默认 npmjs，安装器不随此选择播种，可在运行期设置页改） |

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
5. **服务**：root + systemd 单元（`enable --now`）；非 root 自动 `systemctl --user`
   用户态服务（登出会停止，常驻请 `loginctl enable-linger <用户>`）；无 systemd
   自动前台（nohup + pid 文件）。可选 `--service-user <专用用户>` 以非 root
   身份运行系统服务（见 §8 常见问题）。
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
- **配置不生效（服务按二进制内置默认 127.0.0.1:3000 / auth=none 启动，而不是
  安装时配置的端口/绑定/凭据）**：注意 3000 是 gateway 二进制的内置默认端口，
  安装器通过 env 注入 30801——若出现 3000 说明环境没加载。最常见原因：旧版
  安装器生成的 unit 里 `EnvironmentFile="/path/gateway.env"` 带引号——systemd
  的 `EnvironmentFile=` 不支持引号（`ExecStart=` 才支持），带引号路径加载静默
  失败（journal 有 warning，服务照常启动），服务以空环境运行。修复（root
  安装；非 root 用户态服务把路径换成 `~/.config/systemd/user/…` 并把
  `systemctl` 换成 `systemctl --user`）：

  ```bash
  sed -i 's|^EnvironmentFile="\(.*\)"$|EnvironmentFile=\1|' /etc/systemd/system/dsh-chamber-gateway.service
  systemctl daemon-reload && systemctl restart dsh-chamber-gateway
  journalctl -u dsh-chamber-gateway -n 5   # 应显示 bind 0.0.0.0:30801 auth=password+token
  ```

  或重跑新版安装器（已修复模板）。两点提醒：① `~/.dsh-chamber/bin/install-gateway.sh`
  若是旧版自拷贝，下次 `update` 会重新写入带引号 unit（修复被静默回退）——
  请一并更新脚本副本；② env 生效后 `DSH_GATEWAY_STATE` 才会加载，state 目录从
  bug 窗口期的默认 `~/.dsh-chamber` 切回 `~/.dsh-chamber/gateway/data`——窗口期
  产生的凭据/会话/运行时不会自动迁移（旧字节保留，新实例看不到）。
- **`--no-auth` 何时生效**：仅当服务没有任何凭据（密码/Token）时才有意义；若
  env/argv 同时给了凭据，`--no-auth` 是惰性的（凭据为准，boot 行打印真实生效
  的 auth 类型）。外部绑定（0.0.0.0）+ 无凭据 + `--no-auth` = 匿名公网暴露，
  仅限可信网络。
- **启动即崩：`private directory must already have mode 0700: ~/.dsh-chamber`**
  （systemd 无限重启）：旧版网关对已存在的私有 state 根目录要求严格 0700
  （fail-closed），旧安装用默认 umask 建出的 0755 根目录会触发。修复：
  `chmod 700 ~/.dsh-chamber && systemctl restart dsh-chamber-gateway`。
  较新版本启动时自动把既有根目录收紧到 0700（含属主校验，异主目录仍会
  fail-closed），无需手动 chmod；安装器也会直接以 0700 创建该目录及全部
  自有子目录。**升级请走 `install-gateway.sh update`**（会把旧布局一并收敛，
  不要手动替换二进制）。
- **root 与非 root**：文件统一落在 `~/.dsh-chamber`；root 仅用于 systemd 与
  npm 全局；非 root 自动用 `systemctl --user` 或前台。注意 npm 全局安装形态
  下，安装器以 owner-only（0700/0600）创建全局树与 `gateway` 命令——多用户
  机器上其他用户无法执行，符合单用户部署定位。
- **以专用系统用户运行（`--service-user <用户>`）**：gateway 及其 spawn 的
  dsh/Git 全部以该用户运行（数据仍由 gateway 控制在 `~/.dsh-chamber` 布局，
  dsh 的 `DSH_HOME` 在 state 目录下，不依赖该用户 home）。用法（root +
  systemd 服务形态）：

  ```bash
  useradd -m -r -s /usr/sbin/nologin dsh-chamber        # 一次性建号
  bash install-gateway.sh install --service-user dsh-chamber   # 其余选项照常
  ```

  安装器会：unit 加 `User=dsh-chamber`、把 `~/.dsh-chamber` 全部数据属主移交
  该用户（`chown -R`）、该配置写入 `gateway.conf`（`update` 时保持）。注意：
  ① 用户必须**预先存在**（安装器不建号）；② 手工改 unit 加 `User=` 会被下次
  `update` 重写丢失，请用 `--service-user` 或直接编辑 `gateway.conf` 的
  `SERVICE_USER=`；③ 切换运行用户后 `~/.dsh-chamber` 属主必须匹配，否则
  gateway 启动时对异主目录 fail-closed。
