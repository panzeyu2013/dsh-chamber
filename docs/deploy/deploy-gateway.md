# dsh-chamber Gateway 部署指南

> 一键安装脚本 `scripts/install-gateway.sh`（交互向导/非交互）；子命令install / update / restart / status / logs / uninstall。

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

向导为「欢迎页 + 8步配置」（版本通道 → 访问方式 → 登录凭据 → 端口 → 服务方式 → dsh运行时 →
安装位置 → 预览确认），非法输入红字重问，`q` 退出、`ESC`/`back` 返回上一步；**「精确版本」先列出
GitHub Releases全部可用版本**（稳定/预发布标记、发布日期、gateway资产标记），输入序号或版本号
（可带 `v` 前缀）选中。执行前有完整预览（落盘路径与访问地址）；装完询问是否把
`~/.dsh-chamber/bin` 加入PATH（幂等写 `~/.bashrc` / `~/.zshrc`），并把脚本复制到该目录。默认值：

|项|默认|
|---|---|
|安装通道|最新稳定版（可选beta / 精确版本 / 离线包；精确版本列出全部可用版本或手动输入）|
|访问方式|仅本机（127.0.0.1，免凭据；可选反向代理 / 直连 / 高级）|
|登录凭据|外部形态必须设置：密码（默认）/ Token / 两者；`--no-auth` 交互模式需输入YES二次确认（-y时flag即显式放行）|
|对外端口|30801（dsh内部端口30800一并说明，可改）|
|安装方式|local（`~/.dsh-chamber`，gateway自管程序与dsh；可选npm全局）|
|服务形态|root + systemd；非root + `systemctl --user`；无systemd自动前台|
|dsh版本|与发布绑定的 `DSH_CHAMBER_DSH_VERSION`（当前 0.1.7-rc.2，单一来源 `packages/desktop/vendor/dsh/pnpm-lock.yaml`；可改；运行期 `/chamber/runtime` 可切换）|
|npm镜像|国内镜像registry.npmmirror.com（可选官方源 / 跟随系统）。仅用于dsh内建锚安装；运行期 `/chamber/runtime` 安装源独立（默认npmjs，安装器不播种，可在设置页改）|

## 2. 安装流程（脚本自动完成）

1. dsh先行：探测已有dsh（受控锚 / `--dsh-path` / npm全局），受控锚直接复用；非受管dsh提示是否接管；无则按确认版本装到受控锚目录 `~/.dsh-chamber/gateway/dsh-anchor`（镜像按所选源）。dsh未就绪不装gateway。
2. 下载gateway：解析release资产（latest稳定 / `--channel beta` 预发布 / `--version` 精确pin）→ 下载tgz + **`.sha256` 校验**（失败即中止）。
3. 安装：local（默认，`~/.dsh-chamber/gateway/versions/<v>` + `current` 指针，旧版可回滚） 或npm全局（非 `--local`）。
4. 配置落盘：`~/.dsh-chamber/gateway/gateway.conf`（配置与凭据，0600）+ `gateway.env` （凭据，0600，systemd经 `EnvironmentFile` 引用）。凭据不进argv/历史。
5. 服务：root + systemd（`enable --now`）；非root自动 `systemctl --user`（登出即停，常驻请 `loginctl enable-linger <用户>`）；无systemd自动前台（nohup + pid文件）。可选 `--service-user <专用用户>` 以非root运行系统服务（见 §9）。
6. 健康检查：`/health` 轮询至ready；失败中止、可重试（仅 `update` 失败自动回滚）。

## 3. 从直连 dsh 迁移到 Gateway（无缝延续旧数据）

> 适用场景：此前按 [remote-dsh-instance.md](remote-dsh-instance.md) 以systemd直连部署dsh（数据在单元运行账号的 `~/.dsh`），现改由同一服务器的Gateway托管，旧会话 / 工作区 / 设置延续。

先明确两件事，避免误以为数据丢失：

1. Gateway托管的dsh是全新实例，数据目录固定 `<stateDir>/dsh-home`（默认 `~/.dsh-chamber/gateway/data/dsh-home`），与直连实例（单元运行账号的 `~/.dsh`）互不相干；
2. 安装向导第1步的「接管」**只**接管dsh程序（版本锚/workspace），从不读取或迁移旧数据——装好Gateway打开，旧数据不会出现（旧字节原样保留）。

无缝延续 = 安装后做一次停机态数据迁移（约一分钟，需两实例停止）：

1. 停旧直连实例（数据静止；避免与托管实例争30800端口）：
   - 形态A（系统单元）：`sudo systemctl stop dsh && sudo systemctl disable dsh`
   - 形态B（用户单元）：`systemctl --user stop dsh && systemctl --user disable dsh`
   - 确认inactive（`systemctl status dsh` / `systemctl --user status dsh`）再继续。

2. 停Gateway——安装器默认已enable并启动服务：
   - `sudo systemctl stop dsh-chamber-gateway`
   - 非root用户态安装：`systemctl --user stop dsh-chamber-gateway`

3. 把旧数据拷入托管home（按形态二选一；源目录留作回退，确认后删）：

   root + systemd系统服务（默认）——root shell（`sudo -i`）内执行，`~` 即root home：

   ```bash
   # <旧账号> = 旧实例单元运行账号（形态 A 通常 = 你的登录账号）；
   # 旧实例显式设过 DSH_HOME 时，把 /home/<旧账号>/.dsh 换成那个路径
   mkdir -p ~/.dsh-chamber/gateway/data/dsh-home
   cp -a /home/<旧账号>/.dsh/. ~/.dsh-chamber/gateway/data/dsh-home/
   chown -R root:root ~/.dsh-chamber/gateway/data/dsh-home   # cp -a 保留旧属主，统一移交
 ```

   以 `--service-user <用户>` 运行时把最后一行换成 `chown -R <该用户> ~/.dsh-chamber/gateway/data/dsh-home`——属主**必须**移交：托管home顶层与gateway自有目录均校验属主，异主fail-closed；目录权限无需处理（顶层每次spawn按0700收敛）。

   非root用户态服务——以安装账号执行（无sudo）：

   ```bash
   mkdir -p ~/.dsh-chamber/gateway/data/dsh-home
   cp -a ~/.dsh/. ~/.dsh-chamber/gateway/data/dsh-home/      # 旧实例也以该账号运行时
 ```

   旧数据在其他账号/机器时，先用 `rsync`/`scp` 取回 `~/.dsh` 再按上述命令拷入；改过 `DSH_GATEWAY_STATE` 的以 `grep DSH_GATEWAY_STATE ~/.dsh-chamber/gateway/gateway.env` 为准。

4. 启动并验证：

   ```bash
   sudo systemctl start dsh-chamber-gateway      # 或 systemctl --user start dsh-chamber-gateway
 ```

   等 `/health` ready后打开实例：旧会话 / 工作区 / 设置应已可见。

版本提示（通常无需处理）：同属当前发布版本时直接可读；读不了/异常时先启动Gateway，在
`/chamber/runtime` 把托管版本切到与旧实例一致（需该版本在registry或缓存可用；重启生效，
切换前自动快照）。跨版本格式兼容责任属dsh官方（design 18 §3.7诚实边界）。

收尾：旧单元已停用并disable；新实例正常后删除旧数据目录
（`sudo rm -rf /home/<旧账号>/.dsh`；非root去掉sudo），并在桌面「设置 → 连接」删除旧的
`dsh + ssh` 来源、改用Gateway来源。想移除旧单元文件再执行
`sudo rm /etc/systemd/system/dsh.service && sudo systemctl daemon-reload`
（形态B：`rm ~/.config/systemd/user/dsh.service`；按实际单元名调整）。

不要做：

- **不要把 `DSH_GATEWAY_STATE` 指到旧 `~/.dsh`** 让托管实例直读——托管home必须由Gateway独占（快照 / 回滚 / 权限收敛的前提），直读外部目录不在支持面内；
- 旧单元运行时不要拷贝（可能正在写）；迁移完成前不要让两者同时常驻写数据。

## 4. 端口模型

|端口|含义|默认|配置|
|---|---|---|---|
|gateway监听|对外服务端口（建议经反代HTTPS暴露）|30801|`--gateway-port`（安装器只认flag；运行期环境变量见design 17）|
|托管dsh|gateway托管的loopback dsh|30800|`--dsh-port`（同上）|

交互向导安装前探测占用、建议空闲端口并强制互斥；`--gateway-port/--dsh-port` 直给仅校验合法性。
本地桌面形态（dsh-chamber桌面应用）不受影响：spawn-dsh基口仍17510。

## 5. 公网接入（TLS 反代）

Gateway不内置TLS（传TLS配置会fail closed）。生产形态：

```
Caddy/Nginx (HTTPS :443)
   └─→ 127.0.0.1:30801（gateway，loopback）
          └─→ 127.0.0.1:30800（托管 dsh）
```

Caddy示例：

```
gateway.example.com {
  reverse_proxy 127.0.0.1:30801
}
```

安装时配置 `--origin https://gateway.example.com` 与 `--trusted-proxy <反代精确 IP>`
（反代机IP，逗号分隔多个）。外部形态（`0.0.0.0` 绑定 / origin / trusted-proxy任一）
强制要求凭据（S1）：安装时自动生成写入0600 env，或 `--ui-password/--api-token`
显式提供。`--no-auth` 是显式危险开关（二次确认 + 启动警告），仅限可信网络。

## 6. 管理命令

|命令|行为|
|---|---|
|`install-gateway.sh status`|版本/端口/服务状态/健康|
|`install-gateway.sh logs`|journalctl / 前台日志tail -f|
|`install-gateway.sh restart`|重启gateway（systemd单元 / 前台按pid记录）|
|`install-gateway.sh update [--version X] [--channel beta] [--no-dsh-upgrade]`|升级：下载+校验→热切换→健康检查→失败自动回滚（旧版保留）。默认把dsh内建锚同步升级到新gateway配套的dsh基线（staging + 原子交换，失败随update回滚；`--no-dsh-upgrade` 拒绝以保持升级前dsh版本）。`gateway/current` 版本树与配置VERSION不一致（事务中断/回滚残留）时自动对齐实际版本树后继续，不再拒绝执行|
|`install-gateway.sh uninstall [--purge]`|卸载：停服务→删单元→npm卸载；默认保留数据，`--purge` 全清|

已有安装时运行脚本会重走完整向导（预览页提示"检测到已有安装，将原地复用数据并覆盖配置"）；日常管理用子命令（status/logs/restart/update/uninstall）。

> dsh版本一致性（update默认同步锚）：基线随tarball的 `dshAnchorVersion` 携带， 旧资产无此字段则回退脚本内置常量。`update` 默认（`--dsh-upgrade`）把 `dsh-anchor` 升级到 该基线，首次启动的「壳失效回落（F4）」落到新基线；`--no-dsh-upgrade`（交互确认亦可拒绝） 则锚保持升级前版本（pin）。自选的dsh版本树仍在磁盘，可经 `/chamber/runtime` 重新选用。

> 版本树与配置一致性（update自愈）：conf的 `VERSION` 与 `gateway/current` 指针树不一致 （残留方向为conf已写新版本而指针指旧树，或反之）时：plain `update` 重放常规升级（既有目标 树复用），显式 `--version` 走常规升级/降级确认。失败回滚与INT/TERM中断都会把配置写回旧版本； 仅当指针非符号链接、树缺失或身份无法验证时才拒绝并要求人工修复。

## 7. 非交互 / CI

- `--skip-dsh`：不自动装dsh（已有受控锚自动复用；否则需 `--dsh-path` 或 `DSH_GATEWAY_DSH_PATH`）。
- `-y uninstall` 免二次确认（`--purge` 仅uninstall有效）。

```bash
bash install-gateway.sh install -y \
  --channel beta \
  --gateway-port 30801 --dsh-port 30800 \
  --origin https://gw.example.com --trusted-proxy 10.0.0.1 \
  --ui-password '<PWD>' --api-token '<TOKEN>'
```

`-y/--yes`：全部使用默认值 + 命令行flag（flag优先）。非TTY（管道/CI）自动非交互，不会挂起等待输入。

## 8. 离线安装（--tgz）

离线包（Release的 `dsh-chamber-gateway-<v>.tgz`）用于无外网/内网环境：

```bash
bash install-gateway.sh install -y \
  --tgz /path/to/dsh-chamber-gateway-<v>.tgz \
  --dsh-path /opt/dsh-ws   # 已有 dsh workspace；无则需本地 npm 缓存
```

- 离线安装即 `VERSION=local` 的local形态（版本树在 `versions/local`，记录内容指纹）。
- 离线更新：`update --tgz <同形态包>`（仅限local的local版本；其它形态走在线通道或先uninstall）：指纹一致 → 幂等跳过；同版本内容不同（重打包修复/测试循环）→ 允许替换（旧树退避 保留，失败自动回滚）；重跑 `install --tgz` 语义相同。目标版本更低仍需显式确认。
- 包同目录有 `.sha256` 时强制校验；解包拒绝越界/绝对路径与外部符号链接成员。

## 9. 常见问题

- 下载失败：确认可达github.com（可设 `HTTPS_PROXY`）；正式版走稳定通道，预览/测试版用 `--channel beta`。
- dsh安装构建失败：koffi/node-pty等原生模块postinstall需make/g++/python3（常见平台有prebuild）；日志会显式报错。
- 端口冲突：向导探测占用并建议空闲口；两端口必须互异。
- 升级后**不可**用：`update` 健康检查失败自动回滚旧版本并保留现场日志。
- 配置不生效（服务按内置默认127.0.0.1:3000 / auth=none启动，而非配置的端口/绑定/凭据）：3000是二进制内置默认端口，安装器经env注入30801；出现3000即环境没加载。 最常见原因：旧版unit的 `EnvironmentFile="/path/gateway.env"` 带引号——systemd的 `EnvironmentFile=` 不支持引号（`ExecStart=` 才支持），带引号路径静默加载失败（journal有warning，服务照常启动），服务以空环境运行。修复（root；非root用户态把路径换成 `~/.config/systemd/user/…`、`systemctl` 换成 `systemctl --user`）：

  ```bash
  sed -i 's|^EnvironmentFile="\(.*\)"$|EnvironmentFile=\1|' /etc/systemd/system/dsh-chamber-gateway.service
  systemctl daemon-reload && systemctl restart dsh-chamber-gateway
  journalctl -u dsh-chamber-gateway -n 5   # 应显示 bind 0.0.0.0:30801 auth=password+token
 ```

  或重跑新版安装器（模板已修复）。提醒：① `~/.dsh-chamber/bin/install-gateway.sh` 若为旧版 自拷贝，下次 `update` 会重写带引号unit（修复被静默回退），请一并更新副本；② env生效后 `DSH_GATEWAY_STATE` 才加载，state目录从bug窗口期的 `~/.dsh-chamber` 切回 `~/.dsh-chamber/gateway/data`——窗口期数据不自动迁移（旧字节保留，新实例看不到）。
- **`--no-auth` 何时生效**：仅当服务无任何凭据（密码/Token）时有意义；env/argv同时给了凭据时它惰性（凭据为准，boot行打印实际auth类型）。外部绑定（0.0.0.0）+ 无凭据 + `--no-auth` = 匿名公网暴露，仅限可信网络。
- **启动即崩：`private directory must already have mode 0700: ~/.dsh-chamber`** （systemd无限重启）：旧版要求私有state根目录严格0700（fail-closed），默认umask建出的0755根目录会触发。修复： `chmod 700 ~/.dsh-chamber && systemctl restart dsh-chamber-gateway`。较新版启动时自动收紧到0700（含属主校验，异主仍fail-closed），安装器也以0700创建该目录及全部自有子目录。 **升级请走 `install-gateway.sh update`**（收敛旧布局，勿手动换二进制）。
- **服务里 `gh auth status` 说"未登录"、npm找不到缓存、git凭据助手取不到token**： 这些工具按 `$HOME` 找配置与缓存，而unit不带 `User=`（默认"当前用户运行"）时systemd不设置登录环境（`systemd.exec` 的 `SetLoginEnvironment=` 只对 `User=`/`DynamicUser=`/ `PAMName=` 为真）——gateway及全部子进程（managed dsh → 代码运行时 → bash → gh/npm/git） 从空HOME起步，旧版unit因此没有 `Environment=HOME=…`。修复：先更新脚本副本（含自拷贝） 再让unit重新生成——新版模板为"当前用户运行"注入 `HOME/LOGNAME/USER/XDG_CONFIG_HOME`， `--service-user` 形态不注入（按 `User=` 推导）：

  ```bash
  curl -fsSL -o install-gateway.sh \
    https://raw.githubusercontent.com/panzeyu2013/dsh-chamber/main/scripts/install-gateway.sh
  bash -n install-gateway.sh && cp install-gateway.sh ~/.dsh-chamber/bin/install-gateway.sh
  # 重跑 install 会按 flags 重新生成凭据（install 路径不读既有 conf）：
  # 照原安装补齐 flags（--gateway-port/--bind/--origin/--ui-password …），或走 update
  bash ~/.dsh-chamber/bin/install-gateway.sh install -y <原 flags>
  systemctl daemon-reload && systemctl restart dsh-chamber-gateway
  systemctl show dsh-chamber-gateway -p Environment | tr ' ' '\n' | grep '^HOME='
 ```

  提醒：① 自拷贝副本不同步时，下次 `update` 会用旧模板重写unit、修复被静默回退（与 `EnvironmentFile` 同源）；② unit路径root为 `/etc/systemd/system/dsh-chamber-gateway.service`、非root为 `~/.config/systemd/user/dsh-chamber-gateway.service`。只改unit也可把四行插到 `EnvironmentFile=` 前再 `daemon-reload` + `restart`。
- root与非root：文件统一落在 `~/.dsh-chamber`；root仅用于systemd与npm全局，非root自动 `systemctl --user`/前台。npm全局形态下，安装器以owner-only（0700/0600）创建全局树与 `gateway` 命令——多用户机器上他人无法执行，符合单用户部署定位。
- **以专用系统用户运行（`--service-user <用户>`）**：gateway及其spawn的dsh/Git全部以该用户运行（数据仍由gateway控制在 `$BASE_DIR` 布局，dsh的 `DSH_HOME` 在state目录下， 不依赖该用户home）。用法（root + systemd服务形态）：

  ```bash
  useradd -m -r -s /usr/sbin/nologin dsh-chamber        # 一次性建号
  DSH_CHAMBER_BASE_DIR=/var/lib/dsh-chamber \
    bash install-gateway.sh install --service-user dsh-chamber   # 其余选项照常
 ```

  `BASE_DIR` 必须在root家目录之外（服务用户无法穿越 `/root`，安装器preflight即拒绝），用 `DSH_CHAMBER_BASE_DIR=/var/lib/dsh-chamber` 等可达位置。安装器会：unit加 `User=dsh-chamber`； 把 `gateway/data`（`DSH_GATEWAY_STATE`：dsh-runtime/ 版本树与dsh-home/ 会话数据）、 `gateway/dsh-anchor` 与 `run/` 属主移交该用户，版本树与启动器放开traverse/读/执行（`a+rX`）； `gateway.conf`/`gateway.env` 保持root 0600（root管理命令与systemd读取需要，服务用户无需凭据），`SERVICE_USER=` 写入 `gateway.conf`（`update` 时保持）。注意：① 用户必须预先存在 （安装器不建号）；② 手工改unit加 `User=` 会被下次 `update` 重写丢失，请用 `--service-user` 或编辑 `gateway.conf` 的 `SERVICE_USER=`；③ 切换运行用户后 `$BASE_DIR` 下移交目录属主必须 匹配，异主则启动fail-closed。
