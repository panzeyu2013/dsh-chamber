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
| dsh 版本 | 与发布绑定的 `DSH_CHAMBER_DSH_VERSION`（当前 0.1.2-alpha.5，可改；运行期可在 `/chamber/runtime` 切换） |
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
   身份运行系统服务（见 §9 常见问题）。
6. **健康检查**：`/health` 轮询至 ready；失败则中止并报错，可重试（仅 `update` 有失败自动回滚）。

## 3. 从直连 dsh 迁移到 Gateway（无缝延续旧数据）

> **适用场景**：此前按 [remote-dsh-instance.md](remote-dsh-instance.md) 用
> systemd **直连**部署过 dsh（数据在单元运行账号的 `~/.dsh`），现在同一台
> 服务器改由 Gateway 托管，希望旧会话 / 工作区 / 设置无缝延续。

**先明确两件事，避免误以为数据丢失：**

1. Gateway 托管的 dsh 是**全新实例**，数据目录固定为 `<stateDir>/dsh-home`
   （默认 `~/.dsh-chamber/gateway/data/dsh-home`），与直连实例的数据目录
   （单元运行账号的 `~/.dsh`）是**两套互不相干的目录**；
2. 安装向导第 1 步的「接管」**只接管 dsh 程序**（版本锚/workspace），
   **从不读取或迁移旧数据**——装好 Gateway 直接打开，旧数据不会出现
   （旧字节原样保留，并未丢失）。

无缝延续 = 安装完成后做一次**停机态数据迁移**（一次性，约一分钟）。整个迁移在数据静止（两个实例都已停止）时进行：

1. **停旧直连实例**（数据静止；也避免与托管实例双跑、争 30800 端口）：
   - 形态 A（系统单元）：
     `sudo systemctl stop dsh && sudo systemctl disable dsh`
   - 形态 B（用户单元）：
     `systemctl --user stop dsh && systemctl --user disable dsh`
   - 确认已停止（`systemctl status dsh` / `systemctl --user status dsh` 显示
     inactive）再继续。

2. **停 Gateway**——安装器默认已把服务 enable 并启动（含健康检查），装完即在运行：
   - `sudo systemctl stop dsh-chamber-gateway`
   - 非 root 用户态安装：`systemctl --user stop dsh-chamber-gateway`

3. **把旧数据拷入托管 home**（按安装形态二选一；源目录保留作回退，确认后删除）：

   **root + systemd 系统服务（默认形态）**——在 root shell（`sudo -i`）里执行，
   `~` 即 root 的 home：

   ```bash
   # <旧账号> = 旧实例单元运行账号（形态 A 通常 = 你的登录账号）；
   # 旧实例显式设过 DSH_HOME 时，把 /home/<旧账号>/.dsh 换成那个路径
   mkdir -p ~/.dsh-chamber/gateway/data/dsh-home
   cp -a /home/<旧账号>/.dsh/. ~/.dsh-chamber/gateway/data/dsh-home/
   chown -R root:root ~/.dsh-chamber/gateway/data/dsh-home   # cp -a 保留旧属主，统一移交
   ```

   以 `--service-user <用户>` 运行时，把最后一行换成
   `chown -R <该用户> ~/.dsh-chamber/gateway/data/dsh-home`——**属主必须移交**：
   托管 home 顶层与 gateway 自有目录都做属主校验，异主目录会 fail-closed。
   目录权限无需手工处理（dsh-home 顶层在每次 spawn 时按 0700 收敛，内容不动）。

   **非 root 用户态服务**——以安装账号执行（无 sudo）：

   ```bash
   mkdir -p ~/.dsh-chamber/gateway/data/dsh-home
   cp -a ~/.dsh/. ~/.dsh-chamber/gateway/data/dsh-home/      # 旧实例也以该账号运行时
   ```

   旧实例数据在别的账号或别的机器上时，先把旧 `~/.dsh` 取到本机
   （`rsync`/`scp`）再按上述命令拷入。state 目录默认如上；改过
   `DSH_GATEWAY_STATE` 的部署以
   `grep DSH_GATEWAY_STATE ~/.dsh-chamber/gateway/gateway.env` 为准。

4. **启动并验证**：

   ```bash
   sudo systemctl start dsh-chamber-gateway      # 或 systemctl --user start dsh-chamber-gateway
   ```

   等 `/health` ready 后打开实例：旧会话 / 工作区 / 设置应已可见。

**版本提示（通常无需处理）**：托管 dsh 与旧实例同属 chamber 当前发布版本时
数据直接可读；若两者差异较大且出现读不了/异常，先启动 Gateway，在
`/chamber/runtime` 把托管版本切到与旧实例一致（需该版本在 registry 或缓存中
可用；选择后重启生效——切换前会自动快照保护已迁移数据）。数据格式的跨版本
兼容迁移责任属 dsh 官方（design 18 §3.7 诚实边界）。

**确认无误后的收尾**：旧单元已在上文停用并 disable；确认新实例数据正常后，
删除旧数据目录（`sudo rm -rf /home/<旧账号>/.dsh`；非 root 形态去掉 sudo），
并在桌面「设置 → 连接」删除旧的 `dsh + ssh` 来源、改用 Gateway 来源。想彻底
移除旧单元文件，再执行 `sudo rm /etc/systemd/system/dsh.service && sudo
systemctl daemon-reload`（形态 B：`rm ~/.config/systemd/user/dsh.service`；
按你的实际单元名调整）。

**不要做**：

- **不要把 `DSH_GATEWAY_STATE` 指到旧 `~/.dsh`** 让托管实例直接读旧目录——
  托管 home 必须由 Gateway 独占（快照 / 回滚 / 权限收敛纪律的前提），直读
  外部目录不在支持面内；
- 旧单元仍在运行时不要拷贝（数据可能正在被写）；迁移完成前不要让旧单元与
  Gateway 同时常驻写数据。

## 4. 端口模型

| 端口 | 含义 | 默认 | 配置 |
|---|---|---|---|
| gateway 监听 | 对外服务端口（建议经反代 HTTPS 暴露） | 30801 | `--gateway-port`（安装器只认 flag；运行期环境变量见 design 17） |
| 托管 dsh | gateway 托管的 loopback dsh | 30800 | `--dsh-port`（同上） |

交互向导在安装前探测占用并建议空闲端口、强制互斥；`--gateway-port/--dsh-port` 直给时仅校验合法性。本地桌面形态（dsh-chamber 桌面应用）不受
影响：spawn-dsh 基口默认仍 17510。

## 5. 公网接入（TLS 反代）

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

## 6. 管理命令

| 命令 | 行为 |
|---|---|
| `install-gateway.sh status` | 版本/端口/服务状态/健康 |
| `install-gateway.sh logs` | journalctl / 前台日志 tail -f |
| `install-gateway.sh restart` | 重启 gateway（systemd 重启单元 / 前台按 pid 记录重启） |
| `install-gateway.sh update [--version X] [--channel beta]` | 升级：下载+校验→热切换→健康检查→失败自动回滚（旧版保留） |
| `install-gateway.sh uninstall [--purge]` | 卸载：停服务→删单元→npm 卸载；默认保留数据，`--purge` 全清 |

已有安装时直接运行脚本会重走完整向导（预览页会提示"检测到已有安装，将原地复用数据并覆盖配置"）；日常管理用子命令（status/logs/restart/update/uninstall）。

## 7. 非交互 / CI

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

## 8. 离线安装（--tgz）

离线包（GitHub Release 的 `dsh-chamber-gateway-<v>.tgz`）用于无外网/内网环境：

```bash
bash install-gateway.sh install -y \
  --tgz /path/to/dsh-chamber-gateway-<v>.tgz \
  --dsh-path /opt/dsh-ws   # 已有 dsh workspace；无则需本地 npm 缓存
```

- 离线安装即 `VERSION=local` 的 local 形态（版本树归档于 `versions/local`，
  内容指纹记录）。
- **离线更新**：`update --tgz <同形态包>`（仅支持 local 安装的 local 版本；
  其它形态请走在线通道或先 uninstall）：内容指纹一致 → 幂等跳过；同版本但
  内容不同（重打包修复/测试循环）→ 允许替换（旧树退避保留，失败自动回滚）；
  重跑 `install --tgz` 语义相同。降级等目标低于当前版本仍需显式确认。
- 包同目录存在 `.sha256` 时强制校验；解包拒绝越界路径、绝对路径与外部符号
  链接成员。

## 9. 常见问题

- **下载失败**：确认网络可达 github.com（可设 `HTTPS_PROXY` 代理）；正式版走
  稳定通道，预览/测试版用 `--channel beta`。
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
  dsh/Git 全部以该用户运行（数据仍由 gateway 控制在 `$BASE_DIR` 布局，dsh 的
  `DSH_HOME` 在 state 目录下，不依赖该用户 home）。用法（root + systemd
  服务形态）：

  ```bash
  useradd -m -r -s /usr/sbin/nologin dsh-chamber        # 一次性建号
  DSH_CHAMBER_BASE_DIR=/var/lib/dsh-chamber \
    bash install-gateway.sh install --service-user dsh-chamber   # 其余选项照常
  ```

  `BASE_DIR` 必须在 root 家目录之外（服务用户无法穿越 `/root` 家目录，安装器
  在 preflight 即拒绝）——用 `DSH_CHAMBER_BASE_DIR=/var/lib/dsh-chamber` 等
  可达位置。安装器会：unit 加 `User=dsh-chamber`、把
  `gateway/data`（`DSH_GATEWAY_STATE`：dsh-runtime/ 版本树与 dsh-home/ 会话
  数据）、`gateway/dsh-anchor` 与 `run/` 属主移交该用户，版本树与启动器放开
  traverse/读/执行（`a+rX`）；`gateway.conf`/`gateway.env` 保持 root 0600
  （root 管理命令与 systemd 读取需要，服务用户无需读凭据），`SERVICE_USER=`
  写入 `gateway.conf`（`update` 时保持）。注意：① 用户必须**预先存在**
  （安装器不建号）；② 手工改 unit 加 `User=` 会被下次 `update` 重写丢失，请
  用 `--service-user` 或直接编辑 `gateway.conf` 的 `SERVICE_USER=`；③ 切换
  运行用户后 `$BASE_DIR` 下移交目录的属主必须匹配，否则 gateway 启动时对异主
  目录 fail-closed。
