#!/usr/bin/env bash
# ============================================================================
# dsh-chamber Gateway 一键安装器（design 17 服务器部署 + design 18 运行时管理）
#
# 用途：从 GitHub release 拉取 gateway 包（npm 未发布也能装），交互式确认
# 每个配置（默认值合理、全部可改、非交互 -y 供 CI），探测/安装 dsh，
# 生成 systemd 单元（root）或 systemctl --user / 前台（非 root），
# 提供 install / update / restart / status / logs / uninstall 管理子命令。
#
# dsh 定位（design 18 §9，2026-09 受控锚决策）：dsh 内建/回退锚安装在
# gateway 自己的受控目录 ${BASE_DIR}/gateway/dsh-anchor（workspace 形态，
# 经 --dsh-path / DSH_GATEWAY_DSH_PATH 提供给 gateway），不使用 npm 全局
# 安装——dsh 运行时由 gateway 拥有，锚与版本树都在受控位置。
# 安装完成后 dsh 版本可在 gateway 的 /chamber/ 页面（或 /chamber/runtime API）
# 运行期管理（安装/切换/回滚）；运行期安装由 gateway 嵌入式 pnpm 落到
# DSH_GATEWAY_STATE（默认 ${BASE_DIR}/gateway/data）下的 dsh-runtime/ 目录。
#
# 端口模型（服务器部署默认，均可改；安装器只认 flag，运行期环境变量见 design 17）：
#   gateway 监听  :30801   （--gateway-port，运行期 env DSH_GATEWAY_PORT）
#   托管 dsh 监听 :30800   （--dsh-port，运行期 env DSH_GATEWAY_DSH_PORT，spawn-dsh 基口）
#
# 用法：
#   install-gateway.sh [install] [选项]     安装（默认子命令）
#   install-gateway.sh update [--version X] 升级（保留配置，失败自动回滚；
#     local 安装（VERSION=local）可用 --tgz FILE 以离线包更新：内容指纹一致
#     则幂等跳过，同版本但内容不同（重打包修复/测试循环）允许替换）
#   install-gateway.sh restart              重启 gateway（systemd/user/前台）
#   install-gateway.sh status|logs|uninstall
#   选项：-y/--yes 非交互（用默认值+flags）；--version V 精确 pin；
#         --channel beta 预发布通道；--tgz FILE 离线本地包；
#         --gateway-port N --dsh-port N --dsh-path DIR --skip-dsh
#         --bind HOST --origin URL --trusted-proxy IP
#         --ui-password P --api-token T
#         --no-auth --local --foreground --purge
#         --service-user USER 以专用系统用户运行 gateway（unit 加 User=，
#           运行数据目录 dsh-anchor/data/run 移交该用户；仅 root + systemd）
#
# 交互向导（小白主线 8 步，每步有说明与校验循环，q 退出 / ESC/back 返回上一步）：
#   1 版本通道（稳定/beta/精确列出全部可用版本/离线） → 2 访问方式（本机/反代/直连/高级）
#   → 3 登录凭据（外部形态：密码/Token/两者/--no-auth 需 YES 确认；
#     密码与 Token 双重输入 + 实时字符计数 + 长度校验，留空自动生成并显示一次）
#   → 4 端口（对外 + dsh 内部） → 5 服务方式 → 6 dsh 运行时（版本/镜像/接管）
#   → 7 安装位置（默认 local，gateway 自管 dsh 版本）→ 8 完整预览确认。
# 安装完成后询问是否把 ${BASE_DIR}/bin 加入 PATH（幂等写入 ~/.bashrc 或
# ~/.zshrc），并把本脚本自身复制到 ${BASE_DIR}/bin/ 供后续管理调用。
# ============================================================================
set -euo pipefail
# 私有契约基线：本脚本创建的一切目录/文件默认 0700/0600（0700 目录内的
# 文件即便显式 chmod +x 也只有 owner 可见）。需要对外可读/可执行的产物
# （systemd unit 0644、bin 启动器）由各自的显式 chmod 覆盖。
umask 077
# ---------------------------------------------------------------------------
# 常量（发布 checklist 锁定：dsh 版本变更必须同步这里与 release.yml）
# DSH_CHAMBER_DSH_VERSION 是「内建/回退锚」默认版本（design 18 §9）：运行期
# 可经 /chamber/runtime 切换，此常量仅决定本脚本安装的锚版本。
# ---------------------------------------------------------------------------
DSH_CHAMBER_DSH_VERSION="${DSH_CHAMBER_DSH_VERSION:-0.1.2-alpha.5}"
GITHUB_REPO="${DSH_CHAMBER_GITHUB_REPO:-panzeyu2013/dsh-chamber}"
BASE_DIR="${DSH_CHAMBER_BASE_DIR:-${HOME:?HOME 环境变量未设置（可用 DSH_CHAMBER_BASE_DIR 指定安装位置）}/.dsh-chamber}"
# 从自复制位置反推 BASE_DIR（C 区 #9）：install_self 把本脚本复制到
# <BASE_DIR>/bin/install-gateway.sh，自定义 DSH_CHAMBER_BASE_DIR 安装后
# 管理命令无需每次手传 env 也能定位安装（仅当 conf 确实存在于推导位置）。
if [[ -z "${DSH_CHAMBER_BASE_DIR:-}" && -f "$0" && ! -L "$0" ]] \
  && [[ "$(basename "$0" 2>/dev/null || true)" == "install-gateway.sh" ]]; then
  _self_dir=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P) || _self_dir=""
  if [[ -n "$_self_dir" && "$(basename "$_self_dir")" == "bin" ]] \
    && [[ -f "$(dirname "$_self_dir")/gateway/gateway.conf" ]]; then
    BASE_DIR="$(dirname "$_self_dir")"
  fi
  unset _self_dir
fi
GATEWAY_DIR="${BASE_DIR}/gateway"
CONF_FILE="${GATEWAY_DIR}/gateway.conf"
ENV_FILE="${GATEWAY_DIR}/gateway.env"
LOCAL_BIN_DIR="${BASE_DIR}/bin"
VERSIONS_DIR="${GATEWAY_DIR}/versions"
DEFAULT_GATEWAY_PORT=30801
DEFAULT_DSH_PORT=30800
ASSET_PREFIX="dsh-chamber-gateway"

# ---------------------------------------------------------------------------
# 全局状态
# ---------------------------------------------------------------------------
NONINTERACTIVE=0
VERSION=""
CHANNEL="stable"
OFFLINE_TGZ=""
SPIN_PID=""   # spinner 后台进程（交互美化）
RELEASE_LIST=""    # fetch_available_versions 输出：<版本>|<预发布:0/1>|<有gateway资产:0/1>|<日期>，最新在前
GATEWAY_PORT=""
DSH_PORT=""
BIND_HOST=""
PUBLIC_ORIGIN=""
TRUSTED_PROXY=""
UI_PASSWORD=""
API_TOKEN=""
NO_AUTH=0
INSTALL_METHOD=""               # global | local（向导默认 local；空 = 未定）
SERVICE_MODE="auto"             # systemd | user | foreground
SERVICE_USER=""                 # --service-user：专用系统用户（空 = 以安装用户运行）
SKIP_DSH=0
DSH_FOUND=""
DSH_WS=""
DSH_VER=""
ENV_ANCHOR=0        # 锚来自用户显式 DSH_GATEWAY_DSH_PATH（env 恒最高，仅此时才写回 env）
npm_mirror=""
MIRROR_CHOICE=""        # 镜像选择(选项值 cn/official/system),back 导航幂等用
# 向导阶段跳过标记：对应值由 CLI flag 提供时置 1（该阶段问题不再询问）。
FLAG_VERSION=0      # --version / --channel / --tgz
FLAG_ACCESS=0       # --bind / --origin / --trusted-proxy
FLAG_CRED=0         # --ui-password / --api-token / --no-auth
FLAG_PORTS=0        # --gateway-port / --dsh-port
FLAG_INSTALL=0      # --local
# 凭据自动生成标记（完成页提示"只显示一次"）
AUTO_GEN_PASSWORD=0
AUTO_GEN_TOKEN=0

# M8:颜色仅 TTY 输出(管道/重定向零 ANSI 污染 CI 日志)
log()  { if [[ -t 1 ]]; then printf '\033[1;34m[gateway]\033[0m %s\n' "$*"; else printf '[gateway] %s\n' "$*"; fi; }
warn() { if [[ -t 1 ]]; then printf '\033[1;33m[gateway]\033[0m %s\n' "$*"; else printf '[gateway] %s\n' "$*"; fi; }
die()  { spinner_stop; if [[ -t 2 ]]; then printf '\033[1;31m[gateway]\033[0m %s\n' "$*" >&2; else printf '[gateway] %s\n' "$*" >&2; fi; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Indirect assignment without eval. Interactive values include passwords,
# origins and filesystem paths, so a quote in user input must remain data even
# when the installer is running as root.
assign_var() {
  local var="$1" value="${2-}"
  [[ "$var" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || die "非法内部变量名：$var"
  printf -v "$var" '%s' "$value"
}

# ---------------------------------------------------------------------------
# v2 向导交互原语
# ---------------------------------------------------------------------------
# 交互模式 = 显式非交互（-y）未开且 stdin 是 TTY；否则一律走默认值。
interactive() { [[ "$NONINTERACTIVE" != "1" && -t 0 ]]; }

# 清屏（仅交互模式；非 TTY 时无操作）
wiz_clear() { interactive && clear 2>/dev/null || true; }

# 阶段标题：[N/总数] 标题 + 清屏 + 空行
stage_header() {
  local n="$1" total="$2" title="$3"
  wiz_clear
  printf '\n\033[1;36m[%s/%s] %s\033[0m\n' "$n" "$total" "$title"
  printf '%s\n' '────────────────────────────────────────────────────'
}

# 帮助文本：每行 ≤80 列缩进输出（交互模式）
wiz_help() {
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] && printf '    %s\n' "$line" || true
  done <<< "$1"
}

# ---------------------------------------------------------------------------
# 展示美化（2026-09）：spinner + 分隔线。spinner 仅交互 TTY 生效，非交互/管道
# 不产生任何额外输出（不污染 CI 日志）；die() 与 EXIT trap 双保险回收后台
# spinner 进程，避免残留进程与残缺状态行。
# ---------------------------------------------------------------------------
SPIN_FRAMES=('-' '\' '|' '/')
spinner_start() {
  SPIN_PID=""
  interactive || return 0
  printf '%s ' "$1"
  (
    local i=0
    while :; do
      printf '\b%s' "${SPIN_FRAMES[$((i % 4))]}"
      i=$((i + 1))
      sleep 0.1
    done
  ) &
  SPIN_PID=$!
}
spinner_stop() {
  if [[ -n "${SPIN_PID:-}" ]]; then
    kill "$SPIN_PID" 2>/dev/null || true
    # wait 对被 SIGTERM 的 spinner 返回 143:set -e 下会静默中断脚本(die 的
    # 错误红字都被吞),必须 || true(DIFF #1)
    wait "$SPIN_PID" 2>/dev/null || true
    printf '\b \b\n'
    SPIN_PID=""
  fi
}
LOCK_DIR=""      # install/update 互斥锁目录（F9）
LOCK_OWNED=0     # 本进程是否持有锁(仅属主才在 EXIT trap 清理,F1)
on_exit_cleanup() {
  # bash 3.2 实测:注册 EXIT trap 后,展开类致命错误(缺值 ${2:?}、set -u
  # 未绑定变量)进入 trap 时 $? 已被抹成 0——把崩溃伪装成 exit 0(CI/set -e
  # 链静默"成功")。对策:非 0 原样保留;为 0 时必须已走到正常结束标记
  # (EXITED_OK=1),否则一律按失败 exit 1(fail-closed)。
  local rc=$?
  if [[ -n "${SPIN_PID:-}" ]]; then
    kill "$SPIN_PID" 2>/dev/null || true
    printf '\n'
  fi
  if [[ "${LOCK_OWNED:-0}" == "1" && -n "${LOCK_DIR:-}" && -d "$LOCK_DIR" ]]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
    LOCK_OWNED=0
  fi
  if (( rc != 0 )); then exit "$rc"; fi
  if [[ "${EXITED_OK:-0}" != "1" ]]; then exit 1; fi
  exit 0
}
trap on_exit_cleanup EXIT

# F9：install/update 互斥（并发双跑会交错切指针）；持有到函数结束由 EXIT trap 释放。
acquire_lock() {
  LOCK_DIR="${BASE_DIR}/.install.lock"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    # 陈旧锁探测:锁内 pid 已死(kill -9/断电残留)→ 自动回收后重试 mkdir
    local lpid="" reclaimed=0
    [[ -f "$LOCK_DIR/pid" ]] && lpid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    if [[ "$lpid" =~ ^[0-9]+$ ]] && ! kill -0 "$lpid" 2>/dev/null; then
      warn "清理陈旧安装锁（持有进程 $lpid 已不存在）"
      rm -rf "$LOCK_DIR"
      if mkdir "$LOCK_DIR" 2>/dev/null; then
        reclaimed=1
      fi
    fi
    if [[ "$reclaimed" != "1" ]]; then
      # 未持有锁:清空 LOCK_DIR 并清属主标记,EXIT trap 绝不删持有方的锁(F1)
      LOCK_OWNED=0
      LOCK_DIR=""
      die "另一个 install/update/restart/uninstall 正在运行（${BASE_DIR}/.install.lock）；请等待其结束后重试（若确无进程在跑且锁内 pid 无效，可删除该目录）"
    fi
  fi
  LOCK_OWNED=1
  printf '%s\n' "$$" > "$LOCK_DIR/pid" 2>/dev/null || true
  # 崩溃残留卫生(锁在手即无并发写入者):离线 stage/退避树/版本 stage/mv_T
  # aside 目录(.stage.*/.mv-t.* 为各版本切换临时产物,B-L11/D-L5)
  rm -rf "$VERSIONS_DIR"/.offline.* "$VERSIONS_DIR"/.local.prev.* \
         "$VERSIONS_DIR"/.*.stage.* "$VERSIONS_DIR"/*.mv-t.* \
         "$GATEWAY_DIR"/*.mv-t.* 2>/dev/null || true
}
prune_version_trees() {
  # F9：release 版本树只增不减——保留最近 N 个（current 指向的树在其中；
  # 'local' 与隐藏临时目录不裁剪）。回滚/降级到被裁旧版本时 update 会重新下载。
  [[ -d "$VERSIONS_DIR" ]] || return 0
  local keep=4 keep_list="" t bn=""
  keep_list=$(ls -td "$VERSIONS_DIR"/*/ 2>/dev/null | head -n "$keep")
  for t in "$VERSIONS_DIR"/*/; do
    [[ -d "$t" ]] || continue
    bn=$(basename "$t")
    [[ "$bn" == "local" || "$bn" == .* ]] && continue
    # current 指针指向的树永不清(即使它不在最新 4 棵里)。
    # 注意 glob 带尾斜杠、readlink 不带,须剥掉再比(DIFF #4)
    [[ "$(readlink "$GATEWAY_DIR/current" 2>/dev/null || true)" == "${t%/}" ]] && continue
    if ! grep -qF "${t%/}" <<< "$keep_list" 2>/dev/null; then
      log "清理旧 gateway 版本树：$t"
      rm -rf "$t"
    fi
  done
}

# 校验器：返回 0 = 通过；失败打印红字原因并返回 1（ask_text 进入重试循环）
valid_port() {
  [[ "$1" =~ ^[0-9]+$ && "$1" -ge 1 && "$1" -le 65535 ]] || {
    printf '\033[1;31m✗ 端口必须是 1-65535 的数字\033[0m\n'; return 1
  }
}
valid_semver() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]] || {
    printf '\033[1;31m✗ 版本必须是 canonical SemVer（如 0.1.5 或 0.2.0-beta.4）\033[0m\n'; return 1
  }
}
# 同 valid_semver，但先剥掉可选的 v 前缀（与交互帮助文本"可带 v 前缀"及
# CLI --version 的 v 前缀语义一致）。dsh 版本输入（stage6）仍用不带 v 的
# valid_semver——dsh 版本树按精确 semver 落盘，v 前缀会污染路径。
valid_semver_v() {
  valid_semver "${1#v}"
}
valid_bind() {
  [[ "$1" == "127.0.0.1" || "$1" == "0.0.0.0" ]] || {
    printf '\033[1;31m✗ bind host 只允许 127.0.0.1（仅本机）或 0.0.0.0（全部网卡）\033[0m\n'; return 1
  }
}
# origin / proxy 允许留空（= 仅内网 / 无反代）
valid_origin() {
  [[ -z "$1" ]] && return 0
  [[ "$1" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || {
    printf '\033[1;31m✗ 公网地址必须是 http(s)://域名[:端口]，不含路径（如 https://gateway.example.com）\033[0m\n'; return 1
  }
}
# 反向代理形态下 origin 必填（留空无法构成"反代对外"）
valid_origin_required() {
  [[ -n "$1" ]] || {
    printf '\033[1;31m✗ 反向代理形态必须填写公网域名（回车取消可改选其他访问方式）\033[0m\n'; return 1
  }
  valid_origin "$1"
}
valid_ip_list() {
  [[ -z "$1" ]] && return 0
  # 去逗号两侧空白（"1.2.3.4, 5.6.7.8" 也可接受）
  local item octet cleaned
  cleaned=$(printf '%s' "$1" | tr -d ' \t')
  local IFS=','
  for item in $cleaned; do
    [[ "$item" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || {
      printf '\033[1;31m✗ 反代 IP 必须是精确 IPv4 地址，逗号分隔（如 1.2.3.4,5.6.7.8）\033[0m\n'; return 1
    }
    local IFS='.'
    for octet in $item; do
      # 前导零会按八进制求值（010=8 误通过、08 误报），剥零后按十进制比较
      octet=${octet#0}
      (( 10#${octet:-0} <= 255 )) || {
        printf '\033[1;31m✗ IPv4 每段必须在 0-255：%s\033[0m\n' "$item"; return 1
      }
    done
  done
  return 0
}

# 离线包路径校验器（ask_text 第五参：失败红字原地重问，不再弹回通道菜单）。
# 支持 ~/ 展开（字面 ~ 在 [[ -f ]] 里不展开是此前"文件不存在"误报的根因之一）；
# 要求非空、.tgz 结尾、存在且为普通文件。调用方在通过后再存展开值。
valid_tgz_path() {
  local p="$1"
  [[ "$p" == \~/* ]] && p="$HOME/${p#\~/}"
  [[ "$p" == \~ ]] && p="$HOME"
  if [[ -z "$p" ]]; then
    printf '\033[1;31m✗ 路径为空：请输入 .tgz 文件路径（或 ESC/back 返回改选其它通道）\033[0m\n'
    return 1
  fi
  if [[ "$p" != *.tgz ]]; then
    printf '\033[1;31m✗ 不是 .tgz 包：%s（期望 dsh-chamber-gateway-<版本>.tgz）\033[0m\n' "$p"
    return 1
  fi
  if [[ ! -e "$p" ]]; then
    printf '\033[1;31m✗ 文件不存在：%s（支持 ~/ 展开与绝对/相对路径；~user 形式请写完整路径）\033[0m\n' "$p"
    return 1
  fi
  if [[ ! -f "$p" ]]; then
    printf '\033[1;31m✗ 不是普通文件（目录/设备？）：%s\033[0m\n' "$p"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# wiz_read_line —— 交互式单行输入（仅 TTY；非 TTY/无 stty 退化为普通行读）。
# 修复（2026-09 PTY 实测）：普通 `read -r` 是 canonical 行读，裸 ESC 键要等
# 回车才送达——帮助文案承诺的"ESC 返回上一步"实际失效。本函数用 bash
# `read -n1` 逐字节读取（bash 自行管理 termios，不要额外 stty -icanon——
# 实测会令回车变成空字节；Enter 在 bash 3.2 下恒为"读取成功但值为空"，
# 这正是提交信号）：裸 ESC 即时返回 1（无需回车，其后 0.1s 内的 ESC 序列
# 残余如方向键/Delete 被整体吸收，不污染下一次输入也不误判）；Ctrl-D
# （空行）返回 2；回车返回 0，REPLY = 输入行（可为空）。可见模式由终端
# 天然回显（ESC 的 ^[ 与退格的 ^? 伪影在检测后立即擦除）；隐藏模式
# （参数 1）关闭回显并在提交时补换行，raw 期间被 INT/TERM/HUP/QUIT 打断
# 会先恢复 stty 再退出。退格删除最后一个完整 UTF-8 序列（LC_ALL=C 字节
# 语义，函数内生效、返回自动恢复）。q/back 行级语义由调用方处理。
# ---------------------------------------------------------------------------
wiz_read_line() {
  REPLY=""
  if [[ ! -t 0 ]] || ! have stty; then
    IFS= read -r REPLY || return 2
    return 0
  fi
  local hidden="${1:-0}"
  local saved="" ch="" code=0 nx="" i=0 b=0 len=0 drop=0
  local LC_ALL=C
  saved=$(stty -g 2>/dev/null) || saved=""
  local saved_hidden=""
  if (( hidden == 1 )); then
    stty -echo 2>/dev/null || { IFS= read -r REPLY || return 2; return 0; }
    # 保存 -echo 之后的完整 termios：ESC 探测恢复用这份，避免"恢复回显→再
    # 关回显"两步窗口内密码字符泄漏（DIFF #12）
    saved_hidden=$(stty -g 2>/dev/null) || saved_hidden="$saved"
  fi
  # raw 窗口(ESC 探测的 -icanon)期间被 Ctrl-C/TERM 打断先恢复 termios:
  # 可见模式同样需要(否则终端残留非 canonical 态,L1)
  if (( hidden == 1 )); then
    trap 'stty "${saved_hidden:-$saved}" 2>/dev/null; printf "\033[1;31m已中断\033[0m\n" >&2; exit 130' INT TERM HUP QUIT
  else
    trap 'stty "$saved" 2>/dev/null; exit 130' INT TERM HUP QUIT
  fi
  while :; do
    if ! IFS= read -r -n1 ch; then
      break    # EOF（真实读失败）
    fi
    if [[ -z "$ch" ]]; then
      break    # Enter：bash read -n1 下回车=读取成功但值为空
    fi
    printf -v code '%d' "'$ch" 2>/dev/null || code=0
    if (( code == 27 )); then
      # 可见模式下先擦除终端对 ESC 的 ^[ 回显（2 列）
      if (( hidden != 1 )); then printf '\b \b\b \b'; fi
      # 探测 0.1s 内是否紧跟序列字节（方向键/Home/Delete 等以 ESC [ 或
      # ESC O 开头）：bash 3.2 不支持小数 read -t，改用 dd + VMIN/VTIME；
      # 探测后恢复完整保存的 termios（避免 -icanon 残留到后续输入）。
      stty -icanon min 0 time 1 2>/dev/null
      nx=$(dd bs=1 count=1 2>/dev/null)
      if (( hidden == 1 )); then stty "$saved_hidden" 2>/dev/null; else stty "$saved" 2>/dev/null; fi
      if [[ "$nx" == "[" || "$nx" == "O" ]]; then
        # 编辑键序列：整体吸收（≤6 字节，均已就绪不会阻塞），继续编辑
        i=0
        while (( i < 6 )); do
          stty -icanon min 0 time 1 2>/dev/null
          nx=$(dd bs=1 count=1 2>/dev/null)
          if (( hidden == 1 )); then stty "$saved_hidden" 2>/dev/null; else stty "$saved" 2>/dev/null; fi
          [[ -n "$nx" ]] || break
          i=$((i + 1))
        done
        continue
      fi
      if [[ -n "$nx" ]]; then
        # ESC 后紧跟普通字符（快速连击/粘贴）：该字节已被读取且（可见模式）
        # 已由终端回显，收进输入行继续
        REPLY+="$nx"
        continue
      fi
      # 裸 ESC：返回上一步(恢复 termios 并解除 trap)
      stty "$saved" 2>/dev/null
      trap - INT TERM HUP QUIT
      return 1
    elif (( code == 127 || code == 8 )); then
      # 退格：删除最后一个完整 UTF-8 序列（LC_ALL=C 字节运算）；可见模式
      # 先擦除 ^? 伪影（2 列）再按字节擦除（CJK 宽字符可能多擦 1 列，
      # 仅显示瑕疵，下一字符会覆盖）
      if [[ -n "$REPLY" ]]; then
        printf -v b '%d' "'${REPLY: -1}" 2>/dev/null || b=0
        # H2:bash 3.2 的 printf %d 对 ≥0x80 字节返回带符号值(0xE4→-28),
        # 不归一化则 (( b >= 128 )) 恒假,UTF-8 序列删除成为死代码
        (( b < 0 )) && b=$((b + 256))
        drop=1
        if (( b >= 128 )); then
          i=0
          while (( i < 3 )); do
            printf -v b '%d' "'${REPLY: -(i + 2):1}" 2>/dev/null || break
            (( b < 0 )) && b=$((b + 256))
            (( b >= 128 && b < 192 )) || break
            i=$((i + 1))
          done
          printf -v b '%d' "'${REPLY: -(i + 2):1}" 2>/dev/null || b=0
          (( b < 0 )) && b=$((b + 256))
          len=1
          (( b >= 240 )) && len=4
          (( b >= 224 && b < 240 )) && len=3
          (( b >= 192 && b < 224 )) && len=2
          drop=$((len < i + 1 ? i + 1 : len))
        fi
        drop=$((drop > ${#REPLY} ? ${#REPLY} : drop))
        REPLY="${REPLY:0:${#REPLY} - drop}"
        if (( hidden != 1 )); then
          i=0
          while (( i < drop + 2 )); do printf '\b \b'; i=$((i + 1)); done
        fi
      fi
    elif (( code == 4 )); then
      # Ctrl-D：空行 = EOF（返回 2）；已有内容 = 提交（与 readline 略异但无害）
      if [[ -z "$REPLY" ]]; then
        stty "$saved" 2>/dev/null
        trap - INT TERM HUP QUIT
        return 2
      fi
      break
    else
      # 可打印字节/UTF-8 序列：终端（可见模式）已自动回显
      REPLY+="$ch"
    fi
  done
  stty "$saved" 2>/dev/null
  trap - INT TERM HUP QUIT
  if (( hidden == 1 )); then printf '\n'; fi
  return 0
}

# ask_text VAR 标签 帮助 默认值 校验器 —— 文本输入：
#   回车 = 默认；q = 退出；ESC（即时）或 back = 返回上一步（返回 1）；非法输入红字重问。
ask_text() {
  local var="$1" label="$2" help="$3" def="${4:-}" validator="${5:-}"
  local cur="${!var-}"
  [[ -n "$cur" ]] && def="$cur"
  if ! interactive; then
    assign_var "$var" "$def"
    return 0
  fi
  [[ -n "$help" ]] && wiz_help "$help"
  while true; do
    printf '%s' "$label"
    [[ -n "$def" ]] && printf ' [\033[1m%s\033[0m]' "$def"
    printf ': '
    local input="" rc=0
    wiz_read_line
    rc=$?
    if (( rc == 1 )); then return 1; fi        # 裸 ESC：返回上一步
    if (( rc == 2 )); then die "已退出（EOF）——未做任何修改，可随时重新运行"; fi
    input="$REPLY"
    case "$(lower "${input:-}")" in
      q) die "已退出（q）——未做任何修改，可随时重新运行" ;;
      back) return 1 ;;
    esac
    input="${input:-$def}"
    if [[ -n "$validator" ]] && ! "$validator" "$input"; then continue; fi
    assign_var "$var" "$input"
    return 0
  done
}

# 小写化（macOS bash 3.2 无 ${var,,}，用 tr）
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
# 首尾空白剥离(仅用于选择/确认类输入的比对,文本值不做)
trim_str() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}
# 服务方式中文展示
service_mode_desc() {
  case "${SERVICE_MODE:-}" in
    systemd) printf 'systemd 系统服务' ;;
    user) printf '当前用户 systemd（user）' ;;
    *) printf '前台进程（nohup）' ;;
  esac
}

# ask_choice VAR 标题 帮助 选项行… 默认值 —— 单选：
#   选项行格式 "字母) 显示文本|值"；输入字母或值（大小写不敏感）；
#   非法输入红字重问；q 退出；ESC/back 返回上一步（返回 1）——
#   选项字母优先于返回语义（如 b) beta 仍可选）。
ask_choice() {
  local var="$1" title="$2" help="$3" def="${4:-}"
  shift 4
  local -a option_lines=("$@")
  local cur="${!var-}"
  [[ -n "$cur" ]] && def="$cur"
  # def 若传的是选项值(如 stage5/7 的 "systemd"/"global")先规范成字母:
  # 提示默认列、"(默认)"灰标与输入匹配逻辑保持一致
  if [[ -n "$def" ]]; then
    local _dl _dl2 _dv2
    for _dl in "${option_lines[@]+"${option_lines[@]}"}"; do
      _dl2="${_dl%%\)*}"
      _dv2="${_dl#*) }"; _dv2="${_dv2##*|}"
      [[ "$def" == "$_dv2" ]] && { def="$_dl2"; break; }
    done
  fi
  if ! interactive; then
    # 非交互：把默认字母/值解析为选项值（不能把 'a' 原样赋给变量）
    local dval="" line2 letter2 value2
    for line2 in "${option_lines[@]}"; do
      letter2="${line2%%\)*}"
      value2="${line2#*) }"; value2="${value2##*|}"
      if [[ "$def" == "$letter2" || "$def" == "$value2" ]]; then
        dval="$value2"; break
      fi
    done
    assign_var "$var" "${dval:-$def}"
    return 0
  fi
  [[ -n "$help" ]] && wiz_help "$help"
  while true; do
    printf '\033[1m%s\033[0m\n' "$title"
    local line letter text value
    for line in "${option_lines[@]+"${option_lines[@]}"}"; do
      letter="${line%%\)*}"
      text="${line#*) }"
      value="${text##*|}"
      text="${text%|*}"
      if [[ -n "$def" && "$letter" == "$def" ]]; then
        printf '  \033[1m%s\033[0m) %s  \033[2m(默认)\033[0m\n' "$letter" "$text"
      else
        printf '  \033[1m%s\033[0m) %s\n' "$letter" "$text"
      fi
    done
    printf '选择 [\033[1m%s\033[0m]: ' "$def"
    local input="" rc=0
    wiz_read_line
    rc=$?
    if (( rc == 1 )); then return 1; fi        # 裸 ESC：返回上一步
    if (( rc == 2 )); then die "已退出（EOF）——未做任何修改，可随时重新运行"; fi
    input=$(trim_str "$REPLY")
    case "$(lower "${input:-}")" in
      q) die "已退出（q）——未做任何修改，可随时重新运行" ;;
    esac
    input="${input:-$def}"
    local il
    il=$(lower "$input")
    local match="" line2 letter2 value2
    for line2 in "${option_lines[@]+"${option_lines[@]}"}"; do
      letter2="${line2%%\)*}"
      value2="${line2#*) }"; value2="${value2##*|}"
      if [[ "$il" == "$(lower "$letter2")" || "$il" == "$(lower "$value2")" ]]; then
        match="$value2"; break
      fi
    done
    if [[ -z "$match" && "$(lower "$input")" == "back" ]]; then
      return 1    # 输入 back 返回上一步（裸 ESC 已在读取层处理）
    fi
    if [[ -z "$match" ]]; then
      printf '\033[1;31m✗ 无效选项：%s（输入字母 a/b/c…、选项值、q 退出或 ESC/back 返回上一步）\033[0m\n' "$input"
      continue
    fi
    assign_var "$var" "$match"
    return 0
  done
}

# 隐藏输入 + 字符计数（macOS bash 3.2 下 read -n1 逐字符不可靠，改用
# stty raw + 逐字节读取：终端无回显，回车后立即显示字符数；裸 ESC 即时
# 返回（REPLY=$'\e'，由 ask_secret2 转成"返回上一步"）。
# 输入到 REPLY；Ctrl-C 走 trap 中断（wiz_read_line 恢复 stty 后退出）。
read_secret_counted() {
  local rc=0
  if ! have stty; then
    warn "stty 不可用，输入将明文回显"
    local buf=""
    IFS= read -r buf || true
    REPLY="$buf"
    printf '已输入 %d 字符\n' "${#buf}"
    return 0
  fi
  wiz_read_line 1
  rc=$?
  if (( rc == 1 )); then
    REPLY=$'\e'      # 裸 ESC：由 ask_secret2 按"返回上一步"处理
    return 0
  fi
  if (( rc == 2 )); then REPLY=$'\004'; fi    # EOF：哨兵 \004 由 ask_secret2 转退出
  printf '已输入 %d 字符\n' "${#REPLY}"
}

# ask_secret2 VAR 标签 帮助 最小长度 最大长度 —— 隐藏输入 + 实时计数 +
# 双重确认 + 长度校验：不一致或过短进入重试循环；留空 = 请求自动生成
# （返回 2，调用方负责生成并显示一次）；Ctrl-C 中断。
ask_secret2() {
  local var="$1" label="$2" help="$3" min="$4" max="$5" ascii_only="${6:-0}"
  if ! interactive; then
    return 2    # 非交互：交由调用方自动生成（-y 语义）
  fi
  [[ -n "$help" ]] && wiz_help "$help"
  while true; do
    local first=""
    printf '%s（%s-%s 字符）\n' "$label" "$min" "$max"
    printf '输入不显示，回车后确认字符数；留空 = 自动生成并显示一次。\n'
    printf '%s: ' "$label"
    read_secret_counted
    first="$REPLY"
    case "$first" in
      $'\004') die "已退出（EOF）——未做任何修改，可随时重新运行" ;;
      q) die "已退出（q）——未做任何修改，可随时重新运行" ;;
      $'\e'|back) return 1 ;;   # ESC/back 返回上一步
    esac
    if [[ -z "$first" ]]; then
      return 2    # 请求自动生成
    fi
    if (( ${#first} < min || ${#first} > max )); then
      printf '\033[1;31m✗ 长度需在 %s-%s 字符之间（当前 %s 字符）\033[0m\n' "$min" "$max" "${#first}"
      continue
    fi
    # M10:Token 类要求可见 ASCII(与 flag 侧校验一致)
    if [[ "${ascii_only:-0}" == "1" ]] \
      && [[ -n "$(printf '%s' "$first" | LC_ALL=C tr -d '[:print:]' 2>/dev/null)" ]]; then
      printf '\033[1;31m✗ 必须是可见 ASCII 字符（无空格/中文/控制字符）\033[0m\n'
      continue
    fi
    printf '请再次输入确认: '
    read_secret_counted
    if [[ "$REPLY" == $'\004' ]]; then die "已退出（EOF）——未做任何修改，可随时重新运行"; fi
    if [[ "$REPLY" == $'\e' ]]; then return 1; fi    # 第二次确认 ESC：同样返回上一步
    if [[ "$REPLY" != "$first" ]]; then
      printf '\033[1;31m✗ 两次输入不一致，请重新输入（Ctrl-C 可中断）\033[0m\n'
      continue
    fi
    assign_var "$var" "$first"
    return 0
  done
}

# 危险确认：必须输入 YES（大小写不敏感）才放行（交互）；非交互直接拒绝。
confirm_yes() {
  local label="$1"
  if ! interactive; then return 1; fi
  printf '\033[1;31m%s\033[0m\n' "$label"
  printf '输入 \033[1mYES\033[0m 确认继续（回车取消）: '
  local input="" rc=0
  wiz_read_line
  rc=$?
  (( rc == 1 )) && return 1    # 裸 ESC = 取消
  (( rc == 2 )) && return 1    # EOF/Ctrl-D = 取消
  input=$(trim_str "$REPLY")
  [[ "$(lower "$input")" == "yes" ]]
}

confirm() {
  local label="$1" def="${2:-y}"
  if [[ "$NONINTERACTIVE" == "1" ]]; then
    [[ "$def" == "y" || "$def" == "Y" ]]
    return $?
  fi
  local input
  if [[ ! -t 0 ]]; then
    # 管道输入（如 echo y | …）：读取管道而非直接按默认值
    IFS= read -r input || true
    case "${input:-$def}" in
      y|Y|yes|YES) return 0 ;;
      *) return 1 ;;
    esac
  fi
  printf '%s [%s]: ' "$label" "$def"
  local input="" rc=0
  wiz_read_line
  rc=$?
  if (( rc == 1 )); then return 1; fi    # 裸 ESC = 取消（不执行）
  if (( rc == 2 )); then return 1; fi    # EOF/Ctrl-D = 取消（H2：不落默认值）
  input=$(trim_str "$REPLY")
  case "${input:-$def}" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# 端口探测（/dev/tcp，bash 内建）
# ---------------------------------------------------------------------------
port_free() {
  local host="$1" port="$2"
  # GNU timeout 缺失时（如 macOS）退化为直接探测：连接失败 = 端口空闲。
  # Linux 服务器目标下 timeout 仍用于给 /dev/tcp 兜底超时。
  if have timeout; then
    if ! timeout 2 bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null; then
      return 0
    fi
    return 1
  fi
  if ! bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null; then
    return 0
  fi
  return 1
}

suggest_port() {
  # 两个 local 必须分开：同语句 `local base="$1" p="$base"` 里 `$base` 在
  # 赋值生效前展开——set -u 下直接 unbound variable 崩溃（或静默取到外层
  # 陈旧值）。与 SERVICE_USER 事故同类的 set -u 隐患。
  local base="$1"
  local p="$base"
  while ! port_free 127.0.0.1 "$p"; do
    (( p >= 65535 )) && { warn "端口 $base-65535 全部被占用，无法建议空闲端口"; printf '%s' "$base"; return 1; }
    p=$((p + 1))
  done
  printf '%s' "$p"
}

# ---------------------------------------------------------------------------
# 版本/资产解析（GitHub Releases API）
# ---------------------------------------------------------------------------
github_api() {
  curl -fsSL --connect-timeout 10 -m 30 "$1" 2>/dev/null || return 1
}

validate_gateway_version() {
  local version="$1"
  [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]] \
    || die "gateway 版本必须是 canonical SemVer：$version"
}

# 语义化版本比较（F3 降级防护）：a < b 返回 0。主/次/补丁数值比较；
# prerelease 整体小于正式版；同为 prerelease 时按标识符字典序（够用且诚实）。
# 纯数字串比较(任意长度,避免 64 位回绕):剥前导零后比长度,同长比字典序
numstr_lt() {
  local a="$1" b="$2"
  a=${a#"${a%%[!0]*}"}; b=${b#"${b%%[!0]*}"}
  [[ -z "$a" ]] && a=0
  [[ -z "$b" ]] && b=0
  if (( ${#a} != ${#b} )); then (( ${#a} < ${#b} )) && return 0 || return 1; fi
  [[ "$a" < "$b" ]] && return 0 || return 1
}

version_lt() {
  local a="$1" b="$2"
  local LC_ALL=C    # 字典序比较钉 C locale,避免 strcoll 大小写次序漂移
  local amain bmain ap bp
  # 先剥 +build 元数据（validate 允许 +build；不剥会进入 10# 算术求值）再取主版本
  amain="${a%%+*}"; amain="${amain%%-*}"
  bmain="${b%%+*}"; bmain="${bmain%%-*}"
  ap=""; bp=""
  [[ "$a" == *-* ]] && ap="${a#*-}"
  [[ "$b" == *-* ]] && bp="${b#*-}"
  ap="${ap%%+*}"; bp="${bp%%+*}"
  local IFS='.'
  local am1 am2 am3 bm1 bm2 bm3
  read -r am1 am2 am3 <<< "$amain"
  read -r bm1 bm2 bm3 <<< "$bmain"
  # 数值主段比较(任意长度安全)
  if [[ "$am1" != "$bm1" ]]; then numstr_lt "$am1" "$bm1" && return 0 || return 1; fi
  if [[ "$am2" != "$bm2" ]]; then numstr_lt "$am2" "$bm2" && return 0 || return 1; fi
  if [[ "$am3" != "$bm3" ]]; then numstr_lt "$am3" "$bm3" && return 0 || return 1; fi
  # 同版本号:prerelease < 正式
  if [[ -z "$ap" && -n "$bp" ]]; then return 1; fi
  if [[ -n "$ap" && -z "$bp" ]]; then return 0; fi
  if [[ -n "$ap" && -n "$bp" ]]; then
    # prerelease 标识符逐段比较：全数字段按数值（beta.10 > beta.9），
    # 数字段 < 字母段，其余字典序
    local ia ib
    while :; do
      ia="${ap%%.*}"; ib="${bp%%.*}"
      if [[ "$ia" != "$ib" ]]; then
        if [[ "$ia" =~ ^[0-9]+$ && "$ib" =~ ^[0-9]+$ ]]; then
          numstr_lt "$ia" "$ib" && return 0 || return 1
        elif [[ "$ia" =~ ^[0-9]+$ ]]; then
          return 0     # 数字标识符 < 字母标识符
        elif [[ "$ib" =~ ^[0-9]+$ ]]; then
          return 1
        else
          [[ "$ia" < "$ib" ]] && return 0 || return 1
        fi
      fi
      # 段耗尽规则：a 无剩余段而 b 有 → a < b；两者同时耗尽 → 相等
      if [[ "$ap" != *.* ]]; then
        if [[ "$bp" == *.* ]]; then return 0; else return 1; fi
      fi
      if [[ "$bp" != *.* ]]; then return 1; fi
      ap="${ap#*.}"; bp="${bp#*.}"
    done
  fi
  return 1   # 相等
}

# 树内容指纹:全部普通文件按相对路径排序逐个 sha256,再聚合哈希。
# 用于同版本离线包的幂等判断——内容一致=无需重装;内容不同(同版本重打包
# 修复/测试循环)=允许替换。符号链接本身不计(其目标文件计入)。
# sha256sum 优先、shasum 兜底(与 verify_offline_tgz 同款;Linux 常无 shasum,
# 缺工具时返回空——调用点按"内容不同"方向处理,方向安全)。
tree_fingerprint() {
  local dir="$1" percmd="" aggcmd=""
  if have sha256sum; then percmd="sha256sum"; aggcmd="sha256sum"
  elif have shasum; then percmd="shasum -a 256"; aggcmd="shasum -a 256"
  else return 1; fi
  ( cd "$dir" 2>/dev/null || exit 1
    LC_ALL=C find . -type f 2>/dev/null | LC_ALL=C sort \
      | while IFS= read -r f; do
          printf '%s  ' "$f"
          $percmd "$f" 2>/dev/null | awk '{print $1}'
        done | $aggcmd | awk '{print $1}' ) 2>/dev/null
}

# F12:离线包可选强校验——同目录存在 <包>.sha256 时强制校验;缺失仅警告
verify_offline_tgz() {
  local tgz="$1"
  [[ -f "$tgz" ]] || return 1
  if [[ ! -f "$tgz.sha256" ]]; then
    warn "未找到 $tgz.sha256，跳过强校验（离线自供包；建议随包附带 .sha256）"
    return 0
  fi
  if ! have sha256sum && ! have shasum; then
    die "缺少 sha256 校验工具（需要 sha256sum 或 shasum），无法校验离线包：$tgz"
  fi
  local ok=0
  if have sha256sum; then
    ( cd "$(dirname "$tgz")" && sha256sum -c "$(basename "$tgz").sha256" >/dev/null 2>&1 ) && ok=1
  elif have shasum; then
    ( cd "$(dirname "$tgz")" && shasum -a 256 -c "$(basename "$tgz").sha256" >/dev/null 2>&1 ) && ok=1
  fi
  if (( ok != 1 )); then
    die "离线包 sha256 校验失败：$tgz"
  fi
  log "离线包 sha256 校验通过：$tgz"
}

# 拉取 GitHub Releases 全部可用版本（最新在前，最多 100 个）写入 RELEASE_LIST：
#   每行 <版本>|<预发布:0/1>|<有gateway资产:0/1>|<发布日期>，仅收录 canonical SemVer。
# 用 node 解析（preflight 已保证 node ≥22；脚本 read_systemd_env_value 已有同款先例），
# 对 GitHub 的美化（多行缩进）与压缩 JSON 都健壮——旧 sed 按 '},{' 切分对美化 JSON
# 完全不生效（release 之间实际是 '},  {' 带缩进），曾导致 beta 通道实际取到"文档里
# 第一个 tag"即最新任意 release，而不是真正的预发布。成功且非空返回 0；网络失败或
# 无合法版本返回 1（调用方决定报错或回退手动输入）。
fetch_available_versions() {
  local json rc=0
  spinner_start "正在从 GitHub 获取可用版本列表 "
  json=$(github_api "https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100") || rc=1
  spinner_stop
  (( rc != 0 )) && return 1
  RELEASE_LIST=$(printf '%s' "$json" | node -e '
let s = ""
process.stdin.on("data", d => { s += d })
process.stdin.on("end", () => {
  const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/
  try {
    const rels = JSON.parse(s)
    const out = []
    for (const r of rels) {
      const tag = String(r.tag_name || "").replace(/^v/, "")
      if (!SEMVER.test(tag)) continue
      const asset = (r.assets || []).some(a => a.name === "dsh-chamber-gateway-" + tag + ".tgz")
      const date = String(r.published_at || "").slice(0, 10)
      out.push([tag, r.prerelease ? 1 : 0, asset ? 1 : 0, date].join("|"))
    }
    process.stdout.write(out.join("\n"))
  } catch (_) { /* 非 JSON 响应（限流页等）：空输出，调用方回退 */ }
})
') || return 1
  if [[ -n "$RELEASE_LIST" ]]; then return 0; fi
  return 1
}

print_version_list() {
  printf '\033[1m可用版本（GitHub Releases，最新在前；最多 100 个）\033[0m\n'
  local n=0 tag pre asset date flag note
  while IFS='|' read -r tag pre asset date; do
    n=$((n + 1))
    flag="稳定"; note=""
    [[ "$pre" == "1" ]] && flag="预发布"
    [[ "$asset" == "1" ]] || note="（无 gateway 资产）"
    printf '  %2d) %-18s %s %s %s\n' "$n" "$tag" "$flag" "$date" "$note"
  done <<< "$RELEASE_LIST"
}

# 精确版本选择器：先列出全部可用版本（含预发布/资产标记），输入序号直接选，
# 或手动输入版本号（可带 v 前缀，自动去除）。q 退出；ESC/back 返回上一步；
# 回车重新展示列表。列表获取失败时回退纯文本输入（离线/限流场景仍可用）。
# 注意：内部局部变量用 val 而不用 v——调用方（stage1）的变量名就是 v，
# assign_var 按名 printf -v 赋值时会撞上同名局部变量导致外层拿不到值。
pick_version() {
  local var="$1" val=""
  if ! interactive; then
    if ! ask_text val "请输入精确版本" \
      "版本号需是 canonical SemVer，可带 v 前缀（如 0.1.5 / v0.1.5）。" "" valid_semver_v; then return 1; fi
    if [[ -z "$val" ]]; then
      die "版本号为空：请用 --version 显式提供（如 --version 0.1.5）；交互环境请直接重新输入"
    fi
    assign_var "$var" "${val#v}"
    return 0
  fi
  if ! fetch_available_versions; then
    warn "无法获取版本列表（GitHub Releases API 不可达），请手动输入版本号"
    if ! ask_text val "请输入精确版本" \
      "版本号需是 canonical SemVer，可带 v 前缀（如 0.1.5 / v0.1.5）。" "" valid_semver_v; then return 1; fi
    if [[ -z "$val" ]]; then
      die "版本号为空：请用 --version 显式提供（如 --version 0.1.5）；交互环境请直接重新输入"
    fi
    assign_var "$var" "${val#v}"
    return 0
  fi
  print_version_list
  while true; do
    printf '输入序号选择，或直接输入版本号（q 退出，ESC/back 返回上一步）: '
    local input="" rc=0
    wiz_read_line
    rc=$?
    if (( rc == 1 )); then return 1; fi        # 裸 ESC：返回上一步
    if (( rc == 2 )); then
      die "已退出（EOF）——未做任何修改，可随时重新运行"
    fi
    input="$REPLY"
    case "$(lower "${input:-}")" in
      q) die "已退出（q）——未做任何修改，可随时重新运行" ;;
    esac
    if [[ -z "$input" ]]; then
      print_version_list    # 回车：重新展示列表
      continue
    fi
    if [[ "$(lower "$input")" == "back" ]]; then return 1; fi
    if [[ "$input" =~ ^[0-9]+$ ]]; then
      val=$(printf '%s\n' "$RELEASE_LIST" | awk -F'|' -v n="$input" 'NR==n {print $1; exit}' || true)
      if [[ -n "$val" ]]; then
        valid_semver "$val" || { val=""; continue; }
        assign_var "$var" "$val"
        return 0
      fi
      printf '\033[1;31m✗ 无效序号：%s（1-%s）\033[0m\n' \
        "$input" "$(printf '%s\n' "$RELEASE_LIST" | wc -l | tr -d ' ')"
      continue
    fi
    val="${input#v}"
    if valid_semver "$val"; then
      assign_var "$var" "$val"
      return 0
    fi
    # valid_semver 已打印红字原因，继续重问
  done
}

resolve_version() {
  if [[ -n "$OFFLINE_TGZ" ]]; then
    VERSION="local"
    return 0
  fi
  if [[ -n "$VERSION" ]]; then
    VERSION="${VERSION#v}"                      # 允许带 v 前缀
    validate_gateway_version "$VERSION"
    return 0
  fi
  if [[ "$CHANNEL" == "beta" ]]; then
    # 最新预发布：从完整版本列表中取第一个 prerelease（优先带 gateway 资产）。
    # 旧实现按 '},{' 切分 JSON 对 GitHub 美化输出无效，实际取到"文档里第一个 tag"
    # 即最新任意 release；一旦最新发布是稳定版就会静默装错版本。
    fetch_available_versions || die "无法访问 GitHub Releases API（可设 HTTPS_PROXY 代理）"
    VERSION=$(printf '%s\n' "$RELEASE_LIST" | awk -F'|' '$2==1 && $3==1 {print $1; exit}' || true)
    if [[ -z "$VERSION" ]]; then
      # 回退：仍接受无 gateway 资产的预发布（下载阶段会诚实报资产缺失）
      VERSION=$(printf '%s\n' "$RELEASE_LIST" | awk -F'|' '$2==1 {print $1; exit}' || true)
    fi
    [[ -n "$VERSION" ]] || die "未找到 beta 预发布版本（prerelease）"
  else
    local json
    json=$(github_api "https://api.github.com/repos/${GITHUB_REPO}/releases/latest") \
      || die "无法访问 GitHub Releases API（可设 HTTPS_PROXY 代理）"
    # 单 sed 剥可选 v 前缀:无 v tag 不再产出 JSON 垃圾串(B-L1/A-M2)
    VERSION=$(printf '%s' "$json" | sed -nE 's/.*"tag_name": *"v?([^"]*)".*/\1/p' | head -1 || true)
    [[ -n "$VERSION" ]] || die "未找到最新 release"
  fi
  validate_gateway_version "$VERSION"
}

asset_url() { printf 'https://github.com/%s/releases/download/v%s/%s-%s.tgz' "$GITHUB_REPO" "$VERSION" "$ASSET_PREFIX" "$VERSION"; }
asset_sha_url() { printf '%s.sha256' "$(asset_url)"; }

# ---------------------------------------------------------------------------
# 下载 + sha256 校验
# ---------------------------------------------------------------------------
download_verify() {
  local dest_dir="$1"
  local tmp tgz sha_file
  tmp=$(mktemp -d)
  # RETURN trap 在部分 bash（3.2 及若干 4.x/5.x）上不会随函数返回被清除：
  # 首次在 download_verify 返回时触发（tmp 仍有效）后，还会随调用栈上移，
  # 在外层函数（如 do_install）返回时再次触发——此时 $tmp 已随局部作用域
  # 销毁，set -u 下直接 'tmp: unbound variable' 崩溃（实机复现：安装完成页
  # 全部输出之后报 line 1733: tmp: unbound variable，安装已完成但脚本以
  # 错误退出）。处理：触发时先自解除（trap - RETURN），并仅在 tmp 仍有效
  # 时才清理——陈旧触发变成无害空操作，任何 bash 版本行为一致。
  trap 'trap - RETURN; if [[ -n "${tmp:-}" ]]; then rm -rf "$tmp"; fi' RETURN
  # release 的 .sha256 条目名与资产同名 dsh-chamber-gateway-<ver>.tgz：
  # 下载目标必须与条目一致，sha256sum -c 才能命中（否则必然 fail）。
  tgz="dsh-chamber-gateway-${VERSION}.tgz"
  sha_file="${tgz}.sha256"
  if interactive; then spinner_start "正在下载 gateway v${VERSION} "; else log "下载 gateway v${VERSION} …"; fi
  if ! curl -fL --connect-timeout 10 -m 300 -o "$tmp/$tgz" "$(asset_url)"; then
    rm -rf "$tmp"
    die "下载失败：$(asset_url)（v${VERSION} 可能没有 gateway 资产——gateway 从 0.2.0-beta 起随 release 发布；稳定通道可用 --channel beta 或 --version 精确指定）"
  fi
  spinner_stop    # 收掉上一段"下载 gateway"的 spinner(DIFF #6)
  if interactive; then spinner_start "正在下载校验和 "; else log "下载校验和 …"; fi
  if ! curl -fL --connect-timeout 10 -m 30 -o "$tmp/$sha_file" "$(asset_sha_url)"; then
    rm -rf "$tmp"
    die "校验和资产缺失：$(asset_sha_url)（release 应附带 .sha256）"
  fi
  spinner_stop
  # macOS ≤15 无 sha256sum（只有 shasum -a 256），两者都支持 "hash  filename" 的 -c 格式
  local sha_ok=0
  if have sha256sum; then
    ( cd "$tmp" && sha256sum -c "$sha_file" >/dev/null 2>&1 ) && sha_ok=1
  elif have shasum; then
    ( cd "$tmp" && shasum -a 256 -c "$sha_file" >/dev/null 2>&1 ) && sha_ok=1
  else
    rm -rf "$tmp"
    die "缺少 sha256 校验工具（需要 sha256sum 或 shasum）"
  fi
  if [[ "$sha_ok" != "1" ]]; then
    rm -rf "$tmp"
    die "sha256 校验失败：下载包与 release 资产不一致，已中止（临时文件已清理，可重试）"
  fi
  mkdir -p "$dest_dir"
  mv_T "$tmp/$tgz" "$dest_dir/$tgz" || {
    rm -rf "$tmp"
    die "无法原子发布已校验资产：$dest_dir/$tgz"
  }
  rm -rf "$tmp"
}

# ---------------------------------------------------------------------------
# dsh 探测 / 安装
# ---------------------------------------------------------------------------
dsh_workspace_has_entry() {
  local ws="$1"
  [[ -f "$ws/node_modules/@deepseek-ai/dsh/lib/bin.js"
    || -f "$ws/apps/cli/src/bin.ts" ]]
}

detect_dsh() {
  # 用户显式 --dsh-path 优先，跳过探测
  if [[ "$DSH_FOUND" == "explicit" ]]; then
    dsh_workspace_has_entry "$DSH_WS" \
      || die "--dsh-path 既没有已构建 dsh CLI，也不是 dsh 源码 workspace：$DSH_WS"
    return 0
  fi
  # back 导航重跑时保留"复用外部 dsh"的选择，其余情况重置
  if [[ "$DSH_FOUND" != "external" ]]; then
    DSH_WS=""
    DSH_FOUND=""
  fi
  # env 锚（design 18 §9.3 解析链恒最高）：无 --dsh-path 时捕获
  # DSH_GATEWAY_DSH_PATH 作为锚，避免 write_env 覆写成空串。
  if [[ -n "${DSH_GATEWAY_DSH_PATH:-}" ]]; then
    DSH_WS="$DSH_GATEWAY_DSH_PATH"
    DSH_FOUND="env"
    ENV_ANCHOR=1
    return 0
  fi
  # 受控锚复用（2026-09 实机决策）：gateway 自己的 dsh-anchor 目录存在且
  # 有效即复用；不探测/复用 npm 全局安装——dsh 运行时由 gateway 拥有，
  # 锚与版本树都应在受控位置（<GATEWAY_DIR>/dsh-anchor 与
  # <stateDir>/dsh-runtime/）。检测先于 SKIP_DSH：--skip-dsh 语义是
  # "不安装"，已有受控锚时仍应复用，而不是报错。
  if dsh_workspace_has_entry "${GATEWAY_DIR}/dsh-anchor"; then
    DSH_WS="${GATEWAY_DIR}/dsh-anchor"
    DSH_FOUND="controlled"
    return 0
  fi
  if [[ "$SKIP_DSH" == "1" ]]; then return 0; fi
  return 0
}

verify_dsh() {
  local ws="$1"
  dsh_workspace_has_entry "$ws" || return 1
  local ver
  if [[ -f "$ws/node_modules/@deepseek-ai/dsh/lib/bin.js" ]]; then
    ver=$(node "$ws/node_modules/@deepseek-ai/dsh/lib/bin.js" --version 2>/dev/null | head -1 || true)
  else
    # A source checkout keeps the CLI at the workspace root, not beneath the
    # published @deepseek-ai/dsh package. Resolve tsx from that workspace by
    # running with it as cwd, matching the control-plane spawn path.
    ver=$(cd "$ws" && node --import tsx/esm "$ws/apps/cli/src/bin.ts" --version 2>/dev/null | head -1 || true)
  fi
  printf '%s' "$ver"
}

install_dsh() {
  have npm || die "缺少 npm：安装 dsh 内建锚需要 npm（离线 gateway 包不包含 dsh）"
  local target_version="$1"
  # 受控锚（design 18 §9.3 / 2026-09 实机决策）：dsh 内建锚安装在 gateway
  # 自己的受控目录（workspace 形态 <anchor>/node_modules/@deepseek-ai/dsh），
  # 不使用 npm 全局安装——全局树不属于 gateway 部署、卸载/升级不可控，且
  # 与「运行时状态由 gateway 拥有」的边界冲突。版本切换的运行期安装仍由
  # /chamber/runtime/select 的嵌入式 pnpm 落到 <stateDir>/dsh-runtime/。
  local anchor_dir="${GATEWAY_DIR}/dsh-anchor"
  log "安装 dsh 内建锚 @${target_version}（受控位置 ${anchor_dir}）…"
  local registry
  registry=$(npm config get registry 2>/dev/null || printf 'https://registry.npmjs.org')
  if [[ -n "$npm_mirror" ]]; then registry="$npm_mirror"; fi
  log "使用 npm 镜像：$registry"
  if ! npm install --prefix "$anchor_dir" "@deepseek-ai/dsh@${target_version}" --registry "$registry"; then
    die "dsh 安装失败（若为构建脚本错误，请确认服务器有 make/g++/python3，或改用带 prebuild 的平台）"
  fi
  DSH_WS="$anchor_dir"
  local ver
  ver=$(verify_dsh "$DSH_WS" || true)
  [[ -n "$ver" ]] || die "dsh 安装后验证失败：$DSH_WS"
  log "dsh 内建锚就绪：${ver}（${DSH_WS}）"
}

# ---------------------------------------------------------------------------
# 配置落盘
# ---------------------------------------------------------------------------

# GNU `mv -T` emulation for macOS (BSD mv has no -T): replace the target
# entry itself, never move INTO it. An existing directory target is moved
# aside first (best-effort, rolled back on failure); a regular file or
# symlink target is removed then replaced — never followed.
mv_T() {
  local src="$1" dst="$2"
  # 目录目标（含指向目录的符号链接，[[ -d ]] 会跟随）：aside 双 mv 交换
  if [[ -d "$dst" ]]; then
    local aside="$dst.mv-t.$$.${RANDOM}"
    if ! mv "$dst" "$aside"; then return 1; fi
    if ! mv "$src" "$dst"; then mv "$aside" "$dst"; return 1; fi
    rm -rf "$aside"
    return 0
  fi
  # 叶目标（普通文件/符号链接）：单次 rename 原子替换——mv 对既有文件/符号
  # 链接目标走 rename(2)，绝不先 rm 后 mv（C 区 #2：崩溃不再留下目标缺失窗口）
  mv -f "$src" "$dst"
}

# Publish a fully-written sibling with one rename. Refuse a pre-planted
# symlink/non-regular leaf loudly; even if the leaf races after this check,
# `mv_T` replaces that directory entry and never follows it to a victim.
publish_staged_file() {
  local staged="$1" target="$2" mode="$3"
  if [[ -L "$target" || ( -e "$target" && ! -f "$target" ) ]]; then
    warn "拒绝覆盖符号链接或非普通文件：$target"
    rm -f "$staged"
    return 1
  fi
  chmod "$mode" "$staged" || { rm -f "$staged"; return 1; }
  mv_T "$staged" "$target" || { rm -f "$staged"; return 1; }
}

# ---------------------------------------------------------------------------
# 私有布局
# ---------------------------------------------------------------------------
# BASE_DIR 必须是一个专用绝对路径：相对路径/含 systemd specifier(%) 或 glob
# 字符的路径会让 unit 的 EnvironmentFile/ExecStart 指令被 systemd 静默丢弃
# （与 EnvironmentFile 引号事故同型的无声故障）；把 BASE_DIR 指向 ${HOME}、
# /tmp、/ 等宽泛根则会被 ensure_private_layout 整体 chmod 700 破坏——gateway
# 侧对 stateDir 有 validateGatewayStateDirPath 同款纪律，安装器必须一致。
validate_base_dir() {
  [[ "$BASE_DIR" == /* ]] \
    || die "BASE_DIR 必须是绝对路径：${BASE_DIR}（可用 DSH_CHAMBER_BASE_DIR 指定）"
  case "$BASE_DIR" in
    *%*|*'*'*|*'?'*|*'['*|*']'*) die "BASE_DIR 不能包含 % * ? [ ]（systemd specifier/glob 字符）：$BASE_DIR" ;;
  esac
  # F8：空白/引号会破坏 systemd EnvironmentFile 词法（无引号解析），前置拒绝
  if [[ "$BASE_DIR" == *" "* || "$BASE_DIR" == *$'\t'* || "$BASE_DIR" == *'"'* || "$BASE_DIR" == *"'"* ]]; then
    die "BASE_DIR 不能包含空白或引号（systemd EnvironmentFile 限制）：$BASE_DIR"
  fi
  local base_canon home_canon tmp_canon
  if [[ -d "$BASE_DIR" ]]; then
    base_canon=$(cd "$BASE_DIR" && pwd -P) || true
  else
    base_canon="$(cd "$(dirname "$BASE_DIR")" 2>/dev/null && pwd -P)/$(basename "$BASE_DIR")"
  fi
  home_canon=$(cd "$HOME" 2>/dev/null && pwd -P) || true
  tmp_canon=$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P) || true
  [[ -n "$base_canon" && "$base_canon" != "/" && "$base_canon" != "$home_canon" && "$base_canon" != "$tmp_canon" ]] \
    || die "BASE_DIR 必须是专用子目录，不能是文件系统根/用户 HOME/系统临时目录：$BASE_DIR"
}

# 一次性创建 gateway 全部自有目录并收敛 0700：BASE_DIR（state 根）、
# GATEWAY_DIR、VERSIONS_DIR、dsh-anchor、LOCAL_BIN_DIR、run。全局 umask 077
# 已保证新建目录天然 0700，此处 chmod 是对「目录先于本函数以松散 umask
# 存在」的第二道保险（也覆盖 update/restart 等不重走向导的流程），并消除
# npm install --prefix / mkdir -p 早期把 BASE_DIR/GATEWAY_DIR 建成 0755 的窗口期。
ensure_private_layout() {
  validate_base_dir
  local dir
  for dir in "$BASE_DIR" "$GATEWAY_DIR" "$VERSIONS_DIR" "${GATEWAY_DIR}/dsh-anchor" "$LOCAL_BIN_DIR" "${BASE_DIR}/run"; do
    mkdir -p "$dir"
    chmod 700 "$dir"
  done
}

# --service-user：以专用系统用户运行 gateway（systemd 系统服务形态）。
# 校验：仅 systemd 服务形态；必须 root（写 /etc/systemd/system + 移交属主）；
# 用户名必须满足 systemd User= 的字符集；用户必须已存在（安装器不负责建号，
# 避免未授权提权面——建号命令见部署文档）。
validate_service_user() {
  [[ -n "${SERVICE_USER:-}" ]] || return 0
  [[ "$SERVICE_MODE" == "systemd" ]] \
    || die "--service-user 仅支持 systemd 系统服务形态（当前 SERVICE_MODE=${SERVICE_MODE}）"
  [[ "$EUID" == "0" ]] || die "--service-user 需要 root 执行（写系统 unit + 移交数据属主）"
  [[ "$BASE_DIR" == "$HOME" || "$BASE_DIR" == "$HOME"/* ]] \
    && die "--service-user 时 BASE_DIR 不能在 $HOME 下（服务用户无法进入家目录）：请用 DSH_CHAMBER_BASE_DIR 指定可达位置（如 /var/lib/dsh-chamber）"
  have systemctl || die "--service-user 需要 systemd（未检测到 systemctl）"
  [[ "$SERVICE_USER" =~ ^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$ ]] \
    || die "非法服务用户名（仅限 [A-Za-z0-9_.-]）：$SERVICE_USER"
  id -u "$SERVICE_USER" >/dev/null 2>&1 \
    || die "服务用户不存在：${SERVICE_USER}（请先创建：useradd -m -r -s /usr/sbin/nologin ${SERVICE_USER}）"
}

# 把 BASE_DIR 全部数据移交给服务用户（unit 已有 User=，服务以其身份读写
# gateway.env/配置/版本树/state；root 仍可管理）。幂等，install/update 两线
# 都在重启服务前调用。
apply_service_user_ownership() {
  [[ -n "${SERVICE_USER:-}" ]] || return 0
  log "移交运行权限给 $SERVICE_USER …"
  # F1/F2 + C-DIFF #3：conf/env 保持 root:0600（root 管理的 -O 校验前提；
  # systemd 以 root 读 EnvironmentFile，服务用户无需读凭据）。服务用户需要
  # 整条路径可 traverse + 版本树/启动器可读可执行 + data/run 可写。
  # 失败返回 1 由调用方处理（install die；update 纳入 failure_reason/
  # rollback_ok，绝不撕裂事务）。
  local ok=1 target="" d=""
  # 1) DSH_GATEWAY_STATE 目录先建（若等 gateway 首启自建，svc 无法在
  #    root:0700 的 GATEWAY_DIR 下创建），再整体移交
  mkdir -p "$GATEWAY_DIR/data" 2>/dev/null || ok=0
  for target in "$GATEWAY_DIR/data" "$GATEWAY_DIR/dsh-anchor" "${BASE_DIR}/run"; do
    [[ -e "$target" ]] || continue
    chown -R "$SERVICE_USER" "$target" 2>/dev/null || ok=0
  done
  mkdir -p "${BASE_DIR}/run" 2>/dev/null || ok=0
  chown "$SERVICE_USER" "${BASE_DIR}/run" 2>/dev/null || ok=0
  # 2) 代码路径 traverse+读/执行（a+rX 保留既有 x 位；不触碰 conf/env 0600）
  for d in "$BASE_DIR" "$GATEWAY_DIR" "$VERSIONS_DIR" "$LOCAL_BIN_DIR" "${GATEWAY_DIR}/current"; do
    [[ -e "$d" ]] || continue
    chmod o+x "$d" 2>/dev/null || ok=0
  done
  chmod -R a+rX "$VERSIONS_DIR" 2>/dev/null || ok=0
  chmod a+rx "$LOCAL_BIN_DIR/gateway" 2>/dev/null || ok=0
  # 3) 可达性自证（尽力而为：无 su 时跳过，靠 1/2 权限保证）
  if command -v su >/dev/null 2>&1; then
    if ! su "$SERVICE_USER" -s /bin/sh -c \
      "test -r '$LOCAL_BIN_DIR/gateway' && test -r '$GATEWAY_DIR/current/dist/cli.js' && test -w '$GATEWAY_DIR/data'" 2>/dev/null; then
      warn "服务用户 $SERVICE_USER 无法访问安装路径：请确认 BASE_DIR 祖先目录可达（root 家目录下不可用——用 DSH_CHAMBER_BASE_DIR 指定 /var/lib 等位置）"
      return 1
    fi
  fi
  (( ok == 1 )) || {
    warn "移交运行权限给 $SERVICE_USER 失败（请检查目录权限）"
    return 1
  }
  return 0
}

# 配置落盘（该文件由 bash source，故使用 bash 自己的 %q 语法）。
write_config() {
  # 私有布局统一收敛（幂等；全局 umask 077 之外的显式保险）。
  ensure_private_layout
  local tmp
  tmp=$(mktemp "${CONF_FILE}.tmp.XXXXXX")
  if ! {
    printf '# dsh-chamber gateway 安装配置（install-gateway.sh 生成，0600）\n'
    printf 'VERSION=%q\n' "$VERSION"
    printf 'INSTALL_METHOD=%q\n' "$INSTALL_METHOD"
    printf 'GATEWAY_PORT=%q\n' "$GATEWAY_PORT"
    printf 'DSH_PORT=%q\n' "$DSH_PORT"
    printf 'BIND_HOST=%q\n' "$BIND_HOST"
    printf 'PUBLIC_ORIGIN=%q\n' "$PUBLIC_ORIGIN"
    printf 'TRUSTED_PROXY=%q\n' "$TRUSTED_PROXY"
    printf 'SERVICE_MODE=%q\n' "$SERVICE_MODE"
    printf 'SERVICE_USER=%q\n' "${SERVICE_USER:-}"
    printf 'DSH_WS=%q\n' "$DSH_WS"
    printf 'NO_AUTH=%q\n' "$NO_AUTH"
    # foreground 不读取/执行 systemd EnvironmentFile；把其重启所需的
    # write-only 部署值保存在同一个 owner-only、由 %q 生成的受控配置中。
    printf 'ENV_ANCHOR=%q\n' "$ENV_ANCHOR"
    printf 'UI_PASSWORD=%q\n' "$UI_PASSWORD"
    printf 'API_TOKEN=%q\n' "$API_TOKEN"
  } > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  publish_staged_file "$tmp" "$CONF_FILE" 600
}

# 服务环境落盘（EnvironmentFile 引用，0600）。DSH_GATEWAY_STATE 指向的 state
# 目录承载 design 18 运行时状态：dsh-runtime/（版本树、current 指针、快照）与
# dsh-home/（会话数据），gateway 启动相位收敛为 0700；普通 uninstall 保留，
# 仅 --purge 删除。
write_env() {
  ensure_private_layout
  local tmp
  tmp=$(mktemp "${ENV_FILE}.tmp.XXXXXX") || return 1
  if ! {
    printf '# dsh-chamber gateway 服务环境（EnvironmentFile 引用，0600）\n'
    systemd_env_assignment DSH_GATEWAY_PORT "$GATEWAY_PORT"
    systemd_env_assignment DSH_GATEWAY_DSH_PORT "$DSH_PORT"
    systemd_env_assignment DSH_GATEWAY_HOST "$BIND_HOST"
    printf '# state 目录：dsh-runtime/（版本树/快照）+ dsh-home/（会话数据），仅 --purge 删除\n'
    systemd_env_assignment DSH_GATEWAY_STATE "${BASE_DIR}/gateway/data"
    # 锚默认走 --dsh-path（内建/回退锚，运行期可切换）；仅当用户显式以
    # DSH_GATEWAY_DSH_PATH 提供（env 恒最高）时才写回 env 行，否则写 env 会
    # 把实例永久钉在 env 源、静默禁用版本切换/回滚（design 18 §9.3）。
    if [[ -n "$DSH_WS" && "$ENV_ANCHOR" == "1" ]]; then
      systemd_env_assignment DSH_GATEWAY_DSH_PATH "$DSH_WS"
    fi
    if [[ -n "$PUBLIC_ORIGIN" ]]; then
      systemd_env_assignment DSH_GATEWAY_PUBLIC_ORIGIN "$PUBLIC_ORIGIN"
    fi
    if [[ -n "$TRUSTED_PROXY" ]]; then
      systemd_env_assignment DSH_GATEWAY_TRUSTED_PROXIES "$TRUSTED_PROXY"
    fi
    # `--no-auth` is only a bounded fallback when there are no credentials.
    # Once either credential exists, gateway treats this flag as inert.
    if [[ -n "$UI_PASSWORD" ]]; then
      systemd_env_assignment DSH_GATEWAY_PASSWORD "$UI_PASSWORD"
    fi
    if [[ -n "$API_TOKEN" ]]; then
      systemd_env_assignment DSH_GATEWAY_TOKEN "$API_TOKEN"
    fi
    # NO_AUTH 记录（gateway CLI 无对应 env，实际生效靠 serve argv 的 --no-auth）
    printf '# NO_AUTH=%s\n' "$NO_AUTH"
  } > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  publish_staged_file "$tmp" "$ENV_FILE" 600
}

# systemd EnvironmentFile is shell-like but does not understand bash's $'…'
# emitted by printf %q. Double-quote every value using systemd.syntax escapes;
# this also prevents a quote/newline in a credential from creating a new key.
systemd_env_assignment() {
  local name="$1" value="${2-}"
  [[ "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]] || die "非法环境变量名：$name"
  # EnvironmentFile 一行一条目:值含换行会破坏/注入后续条目。
  # systemd 引号语法无法表示换行,直接拒绝(与 read_systemd_env_value 的
  # 数据式解析保持一致,避免语义分叉)。
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    die "凭据/配置值不能包含换行符（EnvironmentFile 单行条目限制）：$name"
  fi
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  # `$` 不转义：env 文件里的 `$` 在任何 systemd 版本都无特殊含义；v247+ 的
  # reader 虽把 `\$` 解回 `$`，但原样 `$` 读回仍是 `$`；而 ≤v246 双引号内只
  # 解 `\"`，转义 `\$` 反而让含 `$` 的凭据带上反斜杠（静默认证失败）。不转义
  # 在所有版本 round-trip 一致。（含 `\` 的凭据在 ≤v246 仍会带反斜杠——仅
  # 影响 2021 年前的发行版，v247+ 正确。）
  printf '%s="%s"\n' "$name" "$value"
}


gateway_exec() {
  if [[ "$INSTALL_METHOD" == "global" ]]; then
    local resolved
    resolved=$(type -P gateway 2>/dev/null || true)
    [[ -n "$resolved" ]] || return 1
    if [[ "$resolved" != /* ]]; then
      resolved="$(cd "$(dirname "$resolved")" && pwd -P)/$(basename "$resolved")"
    fi
    printf '%s' "$resolved"
  else
    printf '%s/gateway' "$LOCAL_BIN_DIR"
  fi
}

gateway_tree_version() {
  local tree="$1"
  [[ -f "$tree/package.json" && -f "$tree/dist/cli.js" ]] || return 1
  node -e '
const manifest = require(process.argv[1])
if (manifest.name !== "@dsh-chamber/gateway" || typeof manifest.version !== "string") process.exit(1)
process.stdout.write(manifest.version)
' "$tree/package.json"
}

# Extract into a brand-new sibling and publish only after validating the
# package identity. Existing version trees are immutable: refusing them avoids
# tar overlay retaining files removed by the new artifact.
stage_local_version() {
  local tgz="$1" version="$2"
  local target="$VERSIONS_DIR/$version"
  [[ ! -e "$target" && ! -L "$target" ]] || {
    warn "目标版本目录已存在，拒绝覆盖：$target"
    return 1
  }
  mkdir -p "$VERSIONS_DIR"
  local stage
  stage=$(mktemp -d "$VERSIONS_DIR/.${version}.stage.XXXXXX")
  # 解包前显式拒绝越界成员：../ 路径与绝对路径（无论 tar 实现是否原生拦截）
  if tar -tzf "$tgz" 2>/dev/null | grep -qE '(^|/)\.\.(/|$)|^/'; then
    warn "离线包包含越界路径成员，拒绝解包：$tgz"
    rm -rf "$stage"
    return 1
  fi
  # F12：拒绝指向包外/绝对路径的符号链接成员（防"链接成员 + 后续成员穿透写入"）
  if tar -tvzf "$tgz" 2>/dev/null | sed -nE 's/^.* -> //p' | grep -qE '^/|(^|/)\.\.(/|$)'; then
    warn "离线包包含越界符号链接成员，拒绝解包：$tgz"
    rm -rf "$stage"
    return 1
  fi
  # 抗遍历 + 不保留属主（防恶意 tgz 覆盖任意路径/篡改属主）；旧 tar 不支持
  # 这些标志时降级重试普通解包（release 资产受 .sha256 保护，风险可控）。
  if ! tar --no-same-owner --no-same-permissions --no-absolute-names -xzf "$tgz" -C "$stage" --strip-components=1 2>/dev/null; then
    if ! tar -xzf "$tgz" -C "$stage" --strip-components=1; then
      rm -rf "$stage"
      return 1
    fi
    warn "tar 安全标志不可用（--no-same-owner/--no-absolute-names），已降级为普通解包"
  fi
  # local 路径「解包即用」从不安装 gateway 依赖（与 global 的 npm install -g
  # 不同），运行期 pnpm 只能来自包内 dist/pnpm 副本（scripts/build.mjs 构建时
  # 打入，design 18 §9.2 D1）。缺失时启动即报 Cannot find module 'pnpm'，
  # 在解包阶段就显式拒绝，而不是等 `gateway current` 启动才炸。
  if [[ ! -f "$stage/dist/pnpm/bin/pnpm.cjs" ]]; then
    warn "gateway 资产缺少内嵌 pnpm（dist/pnpm/bin/pnpm.cjs），local 安装无法运行，拒绝发布"
    rm -rf "$stage"
    return 1
  fi
  local artifact_version
  artifact_version=$(gateway_tree_version "$stage" || true)
  if [[ -z "$artifact_version" || ( "$version" != "local" && "$artifact_version" != "$version" ) ]]; then
    warn "gateway 资产版本不匹配：期望 ${version}，得到 ${artifact_version:-未知}"
    rm -rf "$stage"
    return 1
  fi
  if ! mv_T "$stage" "$target"; then
    rm -rf "$stage"
    return 1
  fi
}

# `current` may only be absent or a symlink. Create the replacement beside it
# and rename over the old symlink so readers see either complete target.
switch_local_current() {
  local target="$1"
  [[ -d "$target" ]] || { warn "gateway 目标版本目录不存在：$target"; return 1; }
  if [[ -e "$GATEWAY_DIR/current" && ! -L "$GATEWAY_DIR/current" ]]; then
    warn "gateway/current 不是符号链接，拒绝静默写入其内部"
    return 1
  fi
  local next="$GATEWAY_DIR/.current.$$.${RANDOM}"
  [[ ! -e "$next" && ! -L "$next" ]] || return 1
  ln -s "$target" "$next" || return 1
  if ! mv_T "$next" "$GATEWAY_DIR/current"; then
    rm -f "$next"
    return 1
  fi
  [[ -L "$GATEWAY_DIR/current" && "$(readlink "$GATEWAY_DIR/current")" == "$target" ]]
}

# Quote one literal systemd directive argument. Bash printf %q is not valid
# here (`\ ` is an unknown systemd escape), and `%`/`$` would otherwise be
# interpreted as unit specifiers/environment expansion.
systemd_quote_arg() {
  local value="${1-}"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "systemd 参数不得包含换行"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\$\$}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

systemd_exec_start() {
  local exec_path="$1"
  local line
  line="$(systemd_quote_arg "$exec_path") serve"
  # 内建锚以 argv 而非 env 提供，保留运行期切换；显式 env 锚无需重复。
  if [[ -n "$DSH_WS" && "$ENV_ANCHOR" != "1" ]]; then
    line+=" --dsh-path $(systemd_quote_arg "$DSH_WS")"
  fi
  # --no-auth 无对应 env，必须保留在服务 argv。
  if [[ "$NO_AUTH" == "1" ]]; then line+=" --no-auth"; fi
  printf '%s' "$line"
}

unit_wanted_by() {
  case "$SERVICE_MODE" in
    user) printf 'default.target' ;;
    systemd) printf 'multi-user.target' ;;
    *) die "不能为服务形态生成 systemd WantedBy：$SERVICE_MODE" ;;
  esac
}

# 目录属主 uid（跟随符号链接）。必须**先试 GNU stat 的 -c**：GNU/Linux 的
# `stat -f` 是"文件系统状态"模式，若先试 BSD 语法 `stat -f '%u'`，GNU stat
# 会把 %u 当文件操作数报错（stderr 被 2>/dev/null 吞掉），同时把目录所在文件
# 系统的完整列表打进 stdout，使捕获值变成多行垃圾——曾导致 /etc/systemd/system
# 的 owner 被误判为不可信、systemd 单元写入失败。BSD stat 不认 -c，会立即报错
# 退出（无 stdout 污染），自然落入 -f 分支。
dir_owner_uid() {
  local dir="$1" out
  if out=$(stat -Lc '%u' "$dir" 2>/dev/null); then
    printf '%s' "$out"
    return 0
  fi
  out=$(stat -L -f '%u' "$dir" 2>/dev/null) || return 1
  printf '%s' "$out"
}

write_unit() {
  local unit_name="dsh-chamber-gateway.service"
  local exec_path
  exec_path=$(gateway_exec) || die "找不到 gateway 可执行文件（global 安装需要 PATH 中有 gateway；local 安装不受影响）"
  local unit_file
  if [[ "$SERVICE_MODE" == "user" ]]; then
    mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    unit_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${unit_name}"
  else
    unit_file="/etc/systemd/system/${unit_name}"
  fi
  local unit_dir owner expected_owner
  unit_dir=$(dirname "$unit_file")
  owner=$(dir_owner_uid "$unit_dir") || return 1
  expected_owner="$EUID"
  [[ "$SERVICE_MODE" != "systemd" ]] || expected_owner=0
  if [[ "$owner" != "$expected_owner" ]]; then
    warn "systemd unit 目录 owner 不可信：${unit_dir}（uid=${owner}，期望 ${expected_owner}）"
    return 1
  fi
  local content
  content=$(cat <<EOF
[Unit]
Description=dsh-chamber gateway (design 17 server shape)
After=network.target

[Service]
Type=simple
# 以专用系统用户运行（--service-user；validate_service_user 已保证该用户
# 存在且为 systemd 系统服务形态；数据目录由 apply_service_user_ownership
# 移交属主）。systemd 会按 passwd 为用户设置 HOME/LOGNAME/USER。
${SERVICE_USER:+User=${SERVICE_USER}}
# systemd 的 EnvironmentFile= 指令**不支持引号**（与 ExecStart= 不同）：带引号的
# 路径会被按字面（含引号字符）查找，文件加载静默失败、服务以空环境启动——
# 曾导致配置全不生效（gateway 以纯默认 127.0.0.1:3000/auth=none 启动）。
EnvironmentFile=$ENV_FILE
ExecStart=$(systemd_exec_start "$exec_path")
Restart=on-failure
RestartSec=3

[Install]
WantedBy=$(unit_wanted_by)
EOF
  )
  local tmp
  tmp=$(mktemp "${unit_file}.tmp.XXXXXX") || return 1
  if ! printf '%s\n' "$content" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  publish_staged_file "$tmp" "$unit_file" 644 || return 1
  if [[ "$SERVICE_MODE" == "user" ]]; then
    systemctl --user daemon-reload >/dev/null 2>&1 || return 1
    systemctl --user enable "$unit_name" >/dev/null 2>&1 || return 1
  else
    systemctl daemon-reload >/dev/null 2>&1 || return 1
    systemctl enable "$unit_name" >/dev/null 2>&1 || return 1
  fi
}

systemctl_for_mode() {
  if [[ "$SERVICE_MODE" == "user" ]]; then
    systemctl --user "$@"
  else
    systemctl "$@"
  fi
}

restart_service() {
  systemctl_for_mode restart dsh-chamber-gateway.service
}

process_start_identity() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  if [[ -r "/proc/$pid/stat" ]]; then
    local ticks
    ticks=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)
    [[ "$ticks" =~ ^[0-9]+$ ]] || return 1
    printf '%s:%s' "$pid" "$ticks"
    return 0
  fi
  local started checksum
  started=$(ps -o lstart= -p "$pid" 2>/dev/null || true)
  [[ -n "$started" ]] || return 1
  checksum=$(printf '%s' "$started" | cksum | awk '{print $1}')
  [[ "$checksum" =~ ^[0-9]+$ ]] || return 1
  printf '%s:%s' "$pid" "$checksum"
}

service_identity() {
  local pid started
  pid=$(systemctl_for_mode show dsh-chamber-gateway.service --property=MainPID --value 2>/dev/null || true)
  [[ "$pid" =~ ^[0-9]+$ && "$pid" != "0" ]] || return 1
  started=$(systemctl_for_mode show dsh-chamber-gateway.service --property=ExecMainStartTimestampMonotonic --value 2>/dev/null || true)
  if [[ -n "$started" && "$started" != "0" && "$started" != "n/a" ]]; then
    printf '%s:%s' "$pid" "$started"
  else
    process_start_identity "$pid"
  fi
}

foreground_record_file() { printf '%s/run/gateway.pid' "$BASE_DIR"; }

foreground_identity() {
  local record pid expected extra actual
  record=$(foreground_record_file)
  [[ -f "$record" ]] || return 1
  IFS=' ' read -r pid expected extra < "$record" || return 1
  [[ "$pid" =~ ^[0-9]+$ && -n "$expected" && -z "${extra:-}" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  actual=$(process_start_identity "$pid" || true)
  [[ "$actual" == "$expected" ]] || return 1
  printf '%s' "$actual"
}

launch_identity() {
  if [[ "$SERVICE_MODE" == "foreground" ]]; then
    foreground_identity
  else
    service_identity
  fi
}

installed_gateway_version() {
  local exec_path
  exec_path=$(gateway_exec) || return 1
  "$exec_path" --version 2>/dev/null | head -1
}

health_wait() {
  local port="$1" tries="${2:-30}" expected_version="${3:-}" previous_identity="${4:-}"
  log "等待 gateway /health（端口 ${port}）…"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -m 2 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      local identity actual_version
      identity=$(launch_identity || true)
      actual_version=$(installed_gateway_version || true)
      if [[ -n "$identity"
        && ( -z "$previous_identity" || "$identity" != "$previous_identity" )
        && ( -z "$expected_version" || "$actual_version" == "$expected_version" ) ]]; then
        # Do not accept a transient process that is about to exit because an
        # old/unrelated listener owns the port. The same launch identity must
        # remain alive across a second HTTP/version observation.
        sleep 1
        local stable_identity stable_version
        stable_identity=$(launch_identity || true)
        stable_version=$(installed_gateway_version || true)
        if [[ "$stable_identity" == "$identity"
          && "$stable_version" == "$actual_version"
          && ( -z "$expected_version" || "$stable_version" == "$expected_version" ) ]] \
          && curl -fsS -m 2 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
          log "gateway 健康：http://127.0.0.1:${port}（version=${actual_version:-unknown}, boot=${identity}）"
          return 0
        fi
      fi
    fi
    sleep 1
  done
  return 1
}

stop_foreground() {
  local record pid expected extra now_id
  record=$(foreground_record_file)
  [[ -f "$record" ]] || return 0
  IFS=' ' read -r pid expected extra < "$record" || true
  # 格式损坏（无法可靠识别进程）：拒绝自动处理，避免误杀（C 区 #3）
  if [[ ! "$pid" =~ ^[0-9]+$ || -z "$expected" || -n "${extra:-}" ]]; then
    warn "foreground pid 记录格式损坏，拒绝自动处理：${record}（请人工检查后删除）"
    return 1
  fi
  # 记录进程已死（崩溃/重启残留）→ 安全清理,不阻塞 install/update/restart/uninstall
  if ! kill -0 "$pid" 2>/dev/null; then
    warn "清理陈旧 foreground pid 记录（进程 $pid 已不存在）"
    rm -f "$record"
    return 0
  fi
  # 存活但身份不符 = 记录进程已死且 pid 被无关进程复用（starttime 不匹配可证明）：
  # 终止会误伤,清除记录放行（C 区 #3:不再永久卡死）
  now_id=$(process_start_identity "$pid" 2>/dev/null || true)
  if [[ -z "$now_id" || "$now_id" != "$expected" ]]; then
    warn "foreground pid 记录身份与进程 $pid 不符（记录过期或 pid 被复用），已清除记录"
    rm -f "$record"
    return 0
  fi
  kill "$pid" 2>/dev/null || return 1
  for _ in $(seq 1 10); do
    if [[ "$(process_start_identity "$pid" 2>/dev/null || true)" != "$now_id" ]]; then
      rm -f "$record"
      return 0
    fi
    sleep 1
  done
  warn "前台进程未在 10s 内退出，强制终止"
  if [[ "$(process_start_identity "$pid" 2>/dev/null || true)" == "$now_id" ]]; then
    kill -9 "$pid" 2>/dev/null || return 1
  fi
  rm -f "$record"
}

start_foreground() {
  local expected_version="${1:-}" previous_identity="${2:-}"
  local exec_path
  exec_path=$(gateway_exec) || return 1
  log "前台模式启动：$exec_path serve（nohup + pid 文件）"
  ensure_private_layout
  local out="${BASE_DIR}/run/gateway.log"
  local -a args=(serve)
  if [[ -n "$DSH_WS" && "$ENV_ANCHOR" != "1" ]]; then
    args+=(--dsh-path "$DSH_WS")
  fi
  if [[ "$NO_AUTH" == "1" ]]; then args+=(--no-auth); fi
  # 前台模式不解析 systemd EnvironmentFile。EnvironmentFile 与 Bash 的
  # quoting 语法并不等价（例如反引号在 systemd 中是普通字符、被 source
  # 时却会执行命令替换），所以直接从已经过参数/向导解析的内存值导出。
  export DSH_GATEWAY_PORT="$GATEWAY_PORT"
  export DSH_GATEWAY_DSH_PORT="$DSH_PORT"
  export DSH_GATEWAY_HOST="$BIND_HOST"
  export DSH_GATEWAY_STATE="${BASE_DIR}/gateway/data"
  if [[ -n "$DSH_WS" && "$ENV_ANCHOR" == "1" ]]; then
    export DSH_GATEWAY_DSH_PATH="$DSH_WS"
  else
    unset DSH_GATEWAY_DSH_PATH
  fi
  if [[ -n "$PUBLIC_ORIGIN" ]]; then export DSH_GATEWAY_PUBLIC_ORIGIN="$PUBLIC_ORIGIN"; else unset DSH_GATEWAY_PUBLIC_ORIGIN; fi
  if [[ -n "$TRUSTED_PROXY" ]]; then export DSH_GATEWAY_TRUSTED_PROXIES="$TRUSTED_PROXY"; else unset DSH_GATEWAY_TRUSTED_PROXIES; fi
  if [[ -n "$UI_PASSWORD" ]]; then export DSH_GATEWAY_PASSWORD="$UI_PASSWORD"; else unset DSH_GATEWAY_PASSWORD; fi
  if [[ -n "$API_TOKEN" ]]; then export DSH_GATEWAY_TOKEN="$API_TOKEN"; else unset DSH_GATEWAY_TOKEN; fi
  nohup "$exec_path" "${args[@]}" >"$out" 2>&1 &
  local pid=$!
  local identity=""
  for _ in $(seq 1 20); do
    identity=$(process_start_identity "$pid" 2>/dev/null || true)
    [[ -n "$identity" ]] && break
    sleep 0.05 2>/dev/null || true
  done
  if [[ -z "$identity" ]]; then
    warn "无法取得前台进程启动身份，拒绝写入裸 PID"
    kill "$pid" 2>/dev/null || true
    return 1
  fi
  # pid 记录原子发布（mktemp+mv_T）：崩溃不留半截记录（C 区 #5）
  local pid_tmp=""
  pid_tmp=$(mktemp "${BASE_DIR}/run/gateway.pid.tmp.XXXXXX") || { kill "$pid" 2>/dev/null || true; return 1; }
  printf '%s %s\n' "$pid" "$identity" > "$pid_tmp"
  if ! mv_T "$pid_tmp" "$(foreground_record_file)"; then
    rm -f "$pid_tmp"
    kill "$pid" 2>/dev/null || true
    return 1
  fi
  if ! health_wait "$GATEWAY_PORT" 30 "$expected_version" "$previous_identity"; then
    warn "前台进程未通过健康检查，日志：$out"
    stop_foreground || true
    return 1
  fi
}

# ---------------------------------------------------------------------------
# 向导（交互；-y 时全部用默认）
# ---------------------------------------------------------------------------
external_deployment() {
  [[ "$BIND_HOST" != "127.0.0.1" || -n "$PUBLIC_ORIGIN" || -n "$TRUSTED_PROXY" ]]
}

# ---------------------------------------------------------------------------
# v2 向导（阶段化；交互模式 q 退出 / ESC/back 返回上一步；-y 全部走默认+flags）
# ---------------------------------------------------------------------------

# 本机已有、但不属于 gateway 受控锚的 dsh（npm 全局等）——仅供接管建议，
# 不做权威探测（design 18 §9.3：gateway 只认自己的锚与 env）。
detect_external_dsh() {
  local g=""
  if have npm; then
    g=$(npm root -g 2>/dev/null || true)
    if [[ -n "$g" && -d "$g/@deepseek-ai/dsh" ]]; then
      dsh_workspace_has_entry "$g" && { printf '%s' "$g"; return 0; }
    fi
  fi
  if have dsh; then
    local p="" dir=""
    p=$(command -v dsh)
    dir=$(cd "$(dirname "$p")" 2>/dev/null && pwd -P 2>/dev/null || true)
    if [[ -n "$dir" ]]; then
      local cand="${dir%/bin}"
      if [[ -n "$cand" ]] && dsh_workspace_has_entry "$cand"; then
        printf '%s' "$cand"; return 0
      fi
    fi
  fi
  return 1
}

# 自动生成凭据（openssl 优先，退化为 /dev/urandom；空结果即失败）
gen_password() {
  local out=""
  if have openssl; then out=$(openssl rand -base64 18 2>/dev/null | tr -d '\n' || true)
  else out=$(head -c 24 /dev/urandom | base64 2>/dev/null | tr -d '\n' || true); fi
  [[ -n "$out" ]] || die "无法自动生成密码（缺少 openssl/base64）"
  printf '%s' "$out"
}
gen_token() {
  local out=""
  if have openssl; then out=$(openssl rand -hex 32 2>/dev/null | tr -d '\n' || true)
  else out=$(head -c 32 /dev/urandom | od -An -tx1 2>/dev/null | tr -d ' \n' || true); fi
  [[ -n "$out" ]] || die "无法自动生成 token（缺少 openssl/od）"
  printf '%s' "$out"
}
stage1_version() {
  stage_header 1 8 "安装包版本"
  if [[ -n "$OFFLINE_TGZ" ]]; then
    if [[ -n "$VERSION" ]]; then
      warn "离线模式与 --version 同时指定：忽略 --version（版本取自离线包）"
    fi
    VERSION="local"
    log "离线模式：使用本地包 $OFFLINE_TGZ"
    return 0
  fi
  if [[ "$FLAG_VERSION" == "1" || "$NONINTERACTIVE" == "1" ]]; then
    resolve_version
    log "版本已由 --version/--channel 指定：$CHANNEL → $VERSION"
    return 0
  fi
  if [[ -n "$VERSION" || "$CHANNEL" != "stable" || -n "$OFFLINE_TGZ" ]]; then
    # back 重入:清除向导产生的选择(离线包/已解析版本/通道),允许改选
    VERSION=""; CHANNEL="stable"; OFFLINE_TGZ=""
  fi
  local choice
  if ! ask_choice choice \
    "gateway 安装包来自 GitHub Releases（下载后 sha256 校验）。选择安装通道：" \
    $'稳定版：最新正式发布（推荐）。\nbeta：预发布版本，尝鲜新功能，可能有变动。\n精确版本：列出所有可用版本供选择，或手动输入（如 0.1.5）。\n离线包：使用已下载的 .tgz 文件（gateway 无需网络；dsh 锚安装仍需网络或预先存在）。' \
    "a" "a) 最新稳定版|stable" "b) 最新 beta 版|beta" "c) 精确版本|exact" "d) 离线包 .tgz|offline"; then
    return 1
  fi
  case "$choice" in
    stable) CHANNEL="stable" ;;
    beta) CHANNEL="beta" ;;
    exact)
      local v=""
      if ! pick_version v; then
        return 1
      fi
      VERSION="$v"
      ;;
    offline)
      local f="" cand=""
      # 自动候选：当前目录 / 桌面 / 下载目录里已下载的 gateway 包（回车即用）
      for cand in \
        "$PWD"/dsh-chamber-gateway-*.tgz \
        "$HOME"/Desktop/dsh-chamber-gateway-*.tgz \
        "$HOME"/Downloads/dsh-chamber-gateway-*.tgz; do
        if [[ -f "$cand" ]]; then f="$cand"; break; fi
      done
      if [[ -n "$f" ]]; then
        printf '\033[2m检测到候选离线包（回车即用）：%s\033[0m\n' "$f"
      fi
      if ! ask_text f "离线包路径" \
        $'已下载的 dsh-chamber-gateway-<版本>.tgz 文件的完整路径。\n支持 ~/ 与绝对/相对路径；若已在当前目录 / Desktop / Downloads 探测到候选包，会显示为默认值，回车即用。' \
        "$f" valid_tgz_path; then
        return 1
      fi
      # 校验器内已按展开值判定；这里存展开后的值供后续使用
      [[ "$f" == \~/* ]] && f="$HOME/${f#\~/}"
      [[ "$f" == \~ ]] && f="$HOME"
      OFFLINE_TGZ="$f"
      ;;
  esac
  resolve_version
  log "安装版本：$VERSION"
}

stage2_access() {
  stage_header 2 8 "访问方式"
  if [[ "$FLAG_ACCESS" == "1" ]]; then
    log "访问方式已由 --bind/--origin/--trusted-proxy 指定"
    # flag 值同样过校验，避免垃圾配置
    if [[ -n "$BIND_HOST" ]] && ! valid_bind "$BIND_HOST"; then die "非法 bind host：${BIND_HOST}（--bind）"; fi
    if [[ -n "$PUBLIC_ORIGIN" ]] && ! valid_origin "$PUBLIC_ORIGIN"; then die "非法公网 origin：${PUBLIC_ORIGIN}（--origin）"; fi
    if [[ -n "$TRUSTED_PROXY" ]] && ! valid_ip_list "$TRUSTED_PROXY"; then die "非法 trusted proxy：${TRUSTED_PROXY}（--trusted-proxy）"; fi
    # 只给 origin/proxy 时补 loopback 默认(与交互 proxy 形态一致),避免写出空 host
    if [[ -z "$BIND_HOST" && ( -n "$PUBLIC_ORIGIN" || -n "$TRUSTED_PROXY" ) ]]; then
      BIND_HOST="127.0.0.1"
      log "BIND_HOST 未指定，按 loopback 处理（${BIND_HOST}）"
    fi
    return 0
  fi
  local mode=""
  # back 重入时以已选形态为默认（ACCESS_MODE 记录选项值），避免盲回车静默改回默认
  if ! ask_choice mode \
    "别人怎么访问这个 gateway？" \
    $'仅本机：只监听 127.0.0.1，本机浏览器访问，无需登录凭据。\n反向代理：仍监听 127.0.0.1，由 Caddy/Nginx 做 HTTPS 转发（公网推荐形态）。\n直接暴露：监听 0.0.0.0 明文 HTTP，必须设置登录凭据（有安全警告）。\n高级：手动设置 bind/origin/trusted-proxy。' \
    "${ACCESS_MODE:-a}" "a) 仅本机使用|loopback" "b) 通过反向代理对外|proxy" "c) 直接暴露到网络|direct" "d) 高级：手动设置|advanced"; then
    return 1
  fi
  ACCESS_MODE="$mode"
  case "$mode" in
    loopback)
      BIND_HOST="127.0.0.1"; PUBLIC_ORIGIN=""; TRUSTED_PROXY=""
      log "仅本机使用：无需登录凭据"
      ;;
    proxy)
      BIND_HOST="127.0.0.1"
      if ! ask_text PUBLIC_ORIGIN "公网域名" \
        $'用户在浏览器输入的地址，必须是完整 http(s) origin，不含路径。\n例如 https://gateway.example.com（由反代提供 HTTPS）。' \
        "" valid_origin_required; then return 1; fi
      if ! ask_text TRUSTED_PROXY "反代服务器 IP" \
        $'反代的精确出口 IP（逗号分隔可多个）。只接受精确 IP，不接受网段或主机名。' \
        "" valid_ip_list; then return 1; fi
      log "反向代理形态：origin=$PUBLIC_ORIGIN proxy=$TRUSTED_PROXY"
      ;;
    direct)
      BIND_HOST="0.0.0.0"; PUBLIC_ORIGIN=""; TRUSTED_PROXY=""
      warn "直接暴露形态：明文 HTTP 监听 0.0.0.0，请确认网络可信（内网/隧道），并务必设置登录凭据"
      ;;
    advanced)
      if ! ask_text BIND_HOST "bind host" "只允许 127.0.0.1（仅本机）或 0.0.0.0（全部网卡）。" "127.0.0.1" valid_bind; then return 1; fi
      if ! ask_text PUBLIC_ORIGIN "公网 origin" "https 反代地址（留空 = 仅内网）。" "" valid_origin; then return 1; fi
      if ! ask_text TRUSTED_PROXY "trusted proxy" "反代精确 IP，逗号分隔（留空 = 无）。" "" valid_ip_list; then return 1; fi
      ;;
  esac
}

stage3_credentials() {
  stage_header 3 8 "登录凭据"
  # FLAG 分支先行:flag 提供的凭据在这里校验(交互路径的值已在 ask_secret2 校验过,
  # 不受此分支影响);校验与部署形态无关,避免安装完成后才被 gateway 拒绝。
  # 错误消息只报长度,不回显凭据值(secrets 不进日志)。
  if [[ "$FLAG_CRED" == "1" ]]; then
    if [[ -n "$UI_PASSWORD" && ( ${#UI_PASSWORD} -lt 12 || ${#UI_PASSWORD} -gt 1024 ) ]]; then
      die "密码长度需在 12-1024 字符之间（当前 ${#UI_PASSWORD} 字符）——--ui-password 提供的值不合法"
    fi
    if [[ -n "$API_TOKEN" && ( ${#API_TOKEN} -lt 32 || ${#API_TOKEN} -gt 4096 ) ]]; then
      die "Token 长度需在 32-4096 字符之间（当前 ${#API_TOKEN} 字符）——--api-token 提供的值不合法"
    fi
    if [[ -n "$API_TOKEN" ]] \
      && [[ -n "$(printf '%s' "$API_TOKEN" | LC_ALL=C tr -d '[:print:]' 2>/dev/null)" ]]; then
      die "Token 必须是可见 ASCII 字符——--api-token 提供的值不合法"
    fi
    if [[ -n "$UI_PASSWORD" && ( "$UI_PASSWORD" == *$'\n'* || "$UI_PASSWORD" == *$'\r'* ) ]]; then
      die "密码不能包含换行符（EnvironmentFile 单行条目限制）——--ui-password 提供的值不合法"
    fi
    if [[ -n "$API_TOKEN" && ( "$API_TOKEN" == *$'\n'* || "$API_TOKEN" == *$'\r'* ) ]]; then
      die "Token 不能包含换行符（EnvironmentFile 单行条目限制）——--api-token 提供的值不合法"
    fi
    log "凭据已由 --ui-password/--api-token/--no-auth 指定"
    if [[ "$NO_AUTH" == "1" ]]; then
      # design 17：--no-auth 是显式覆盖,但仍需 YES 二次确认——只有 -y 代表同意;
      # 非 TTY 且未加 -y(如 cron/ssh 调用)同样拒绝,避免静默绕过确认门。
      if [[ "$NONINTERACTIVE" != "1" ]] \
        && ! confirm_yes "⚠  无认证的外部 gateway：任何能访问到该端口的人都可以完全控制这台 gateway 和它托管的 dsh。仅适用于完全可信的网络（内网/隧道）。"; then
        die "已取消（--no-auth 需要输入 YES 确认；脚本化请加 -y，或改选密码/Token 后重试）"
      fi
      if [[ -n "$UI_PASSWORD" || -n "$API_TOKEN" ]]; then
        warn "--no-auth 与凭据同时指定：gateway 以凭据为准（--no-auth 失效，部署实际为已认证形态）"
      fi
    fi
    return 0
  fi
  if ! external_deployment; then
    # 形态回退(如 back 导航从外部改回本机)时清掉残留凭据,保证
    # "本机形态 = 无凭据" 的配置一致性;同时重置自动生成标记。
    UI_PASSWORD=""; API_TOKEN=""; NO_AUTH=0
    AUTO_GEN_PASSWORD=0; AUTO_GEN_TOKEN=0
    log "本机/loopback 形态：无需登录凭据"
    return 0
  fi
  # 交互分支：重置上次导航残留的状态,保证选择与配置一致（凭据随 kind 重选,
  # 不残留上一轮输入的密码/Token,避免"显示一种认证、实际双认证"）
  NO_AUTH=0
  UI_PASSWORD=""; API_TOKEN=""
  AUTO_GEN_PASSWORD=0; AUTO_GEN_TOKEN=0
  local kind=""
  # back 重入时以已选 kind 为默认(CRED_KIND 记忆)，避免盲回车静默改回密码
  if ! ask_choice kind \
    "外部访问必须设置登录凭据。用什么方式登录？" \
    $'密码：浏览器/桌面客户端登录，12-1024 字符。\nToken：程序/API/脚本访问，32-4096 可见 ASCII 字符。\n两者：同时启用，互不遮蔽。\n无需凭据（--no-auth）：仅限完全可信网络，需输入 YES 二次确认。' \
    "${CRED_KIND:-a}" "a) 密码|password" "b) Token|token" "c) 两者都要|both" "d) 无需凭据（--no-auth）|noauth"; then
    return 1
  fi
  CRED_KIND="$kind"
  local rc=0
  case "$kind" in
    password|both)
      ask_secret2 UI_PASSWORD "浏览器登录密码" \
        "密码用于浏览器/桌面客户端登录。自动生成的密码只在安装完成页显示一次，请立即记录。" 12 1024 || rc=$?
      if (( rc == 1 )); then return 1; fi
      if (( rc == 2 )); then
        UI_PASSWORD=$(gen_password)
        AUTO_GEN_PASSWORD=1
        # 不在生成时显示——后续阶段会清屏;统一在完成页一次性显示
      fi
      ;;
  esac
  rc=0
  case "$kind" in
    token|both)
      ask_secret2 API_TOKEN "共享 Token" \
        "Token 用于程序/API/脚本访问。自动生成的 Token 只在安装完成页显示一次，请立即记录。" 32 4096 1 || rc=$?
      if (( rc == 1 )); then return 1; fi
      if (( rc == 2 )); then
        API_TOKEN=$(gen_token)
        AUTO_GEN_TOKEN=1
        # 不在生成时显示——后续阶段会清屏;统一在完成页一次性显示
      fi
      ;;
  esac
  if [[ "$kind" == "noauth" ]]; then
    if ! confirm_yes "⚠  无认证的外部 gateway：任何能访问到该端口的人都可以完全控制这台 gateway 和它托管的 dsh。仅适用于完全可信的网络（内网/隧道）。"; then
      # 取消不丢全部答案：回上一步(访问方式)重选，而非中止向导
      warn "已取消 --no-auth（需输入 YES 确认）；可返回改选密码/Token"
      return 1
    fi
    # no-auth 形态下凭据必须为空,避免"显示无认证、实际要密码"的不一致
    UI_PASSWORD=""; API_TOKEN=""
    NO_AUTH=1
    warn "--no-auth 已放行：外部绑定无认证运行（仅限可信网络）"
  fi
}

stage4_ports() {
  stage_header 4 8 "端口设置"
  if [[ "$FLAG_PORTS" == "1" ]]; then
    # 部分指定时补齐默认，避免写出空端口
    [[ -n "$GATEWAY_PORT" ]] || { GATEWAY_PORT="$DEFAULT_GATEWAY_PORT"; log "gateway 端口未指定，使用默认 $GATEWAY_PORT"; }
    [[ -n "$DSH_PORT" ]] || { DSH_PORT="$DEFAULT_DSH_PORT"; log "dsh 端口未指定，使用默认 $DSH_PORT"; }
    valid_port "$GATEWAY_PORT" || die "非法 gateway 端口：${GATEWAY_PORT}（--gateway-port）"
    valid_port "$DSH_PORT" || die "非法 dsh 端口：${DSH_PORT}（--dsh-port）"
    [[ "$GATEWAY_PORT" != "$DSH_PORT" ]] || die "gateway 端口与 dsh 端口不能相同"
    return 0
  fi
  local def_gw="$DEFAULT_GATEWAY_PORT" def_dsh="$DEFAULT_DSH_PORT"
  local conf_gw="" conf_dsh="" conf_ports=0
  # 重装时沿用既有配置端口(不因旧实例占端口而擅自改端口;D2 会先停旧实例)
  if [[ -f "$CONF_FILE" ]]; then
    conf_gw=$(sed -nE "s/^GATEWAY_PORT='?([0-9]+)'?\$/\1/p" "$CONF_FILE" | head -1)
    conf_dsh=$(sed -nE "s/^DSH_PORT='?([0-9]+)'?\$/\1/p" "$CONF_FILE" | head -1)
    if [[ -n "$conf_gw" || -n "$conf_dsh" ]]; then
      conf_ports=1
      if [[ -n "$conf_gw" ]]; then def_gw="$conf_gw"; log "沿用既有配置 gateway 端口 $def_gw"; fi
      if [[ -n "$conf_dsh" ]]; then def_dsh="$conf_dsh"; log "沿用既有配置 dsh 端口 $def_dsh"; fi
    fi
  fi
  if [[ "$conf_ports" == "0" ]]; then
  if ! port_free 127.0.0.1 "$def_gw"; then
    def_gw=$(suggest_port "$def_gw" || true)
    warn "端口 ${DEFAULT_GATEWAY_PORT} 已被占用，建议使用 ${def_gw}"
  fi
  if ! port_free 127.0.0.1 "$def_dsh"; then
    def_dsh=$(suggest_port "$def_dsh" || true)
    warn "端口 ${DEFAULT_DSH_PORT} 已被占用，建议使用 ${def_dsh}"
  fi
  fi

  # 双默认同号(如 30800/30801 均忙且建议落同值)时抬升 dsh 端口,避免非交互死循环
  [[ "$def_gw" == "$def_dsh" ]] && def_dsh=$((def_dsh + 1))

  local port_help=""
  if [[ -n "$PUBLIC_ORIGIN" ]]; then
    port_help="安装完成后通过 $PUBLIC_ORIGIN 访问。"
  elif [[ "$BIND_HOST" == "127.0.0.1" ]]; then
    port_help="安装完成后在本机浏览器打开 http://127.0.0.1:<端口>。"
  else
    port_help="安装完成后访问 http://<服务器IP>:<端口>（用服务器实际 IP 替换）。"
  fi
  while true; do
    if ! ask_text GATEWAY_PORT "对外端口" \
      "浏览器/客户端访问 gateway 的端口。$port_help" \
      "$def_gw" valid_port; then return 1; fi
    if ! ask_text DSH_PORT "dsh 内部端口" \
      $'gateway 托管的 dsh 后端通信端口，一般不需要修改；\n仅在与 gateway 端口冲突或已被占用时才需要调整。' \
      "$def_dsh" valid_port; then return 1; fi
    if [[ "$GATEWAY_PORT" == "$DSH_PORT" ]]; then
      printf '\033[1;31m✗ gateway 端口与 dsh 端口不能相同，请重新设置\033[0m\n'
      continue
    fi
    break
  done
}

stage5_service() {
  stage_header 5 8 "服务方式"
  if [[ "$SERVICE_MODE" != "auto" ]]; then
    # 值已定(flag 或向导先前选择,back 重入保留)——不再重问,文案不冒充 flag
    log "服务形态保持：${SERVICE_MODE}（如需修改请重新运行 install）"
    return 0
  fi
  if ! have systemctl; then
    SERVICE_MODE="foreground"
    log "未检测到 systemd，使用前台模式"
    return 0
  fi
  local choice=""
  if [[ "$EUID" -eq 0 ]]; then
    if ! ask_choice choice "安装后 gateway 如何运行？" \
      $'systemd：开机自启、崩溃自动重启，卸载时自动移除（推荐）。\n前台：由本脚本后台托管运行（nohup + pid 记录），适合临时试用；服务器重启后需手动 restart。' \
      "systemd" "a) systemd 服务|systemd" "b) 前台运行|foreground"; then return 1; fi
  else
    if ! ask_choice choice "安装后 gateway 如何运行？" \
      $'当前用户 systemd：登录后自启（user 服务），无需 root。\n前台：由本脚本后台托管运行（nohup + pid 记录），适合临时试用。' \
      "user" "a) 当前用户 systemd|user" "b) 前台运行|foreground"; then return 1; fi
  fi
  SERVICE_MODE="$choice"
}

stage6_dsh() {
  stage_header 6 8 "dsh 运行时"
  detect_dsh
  if [[ "$DSH_FOUND" == "controlled" ]]; then
    log "检测到受控锚 dsh：复用 ${GATEWAY_DIR}/dsh-anchor（运行期可在 /chamber/runtime 切换版本）"
    return 0
  fi
  if [[ "$DSH_FOUND" == "explicit" || "$DSH_FOUND" == "env" || "$DSH_FOUND" == "external" ]]; then
    log "dsh 锚已指定/复用：${DSH_WS}（运行期可在 /chamber/runtime 管理受控版本）"
    return 0
  fi
  if [[ "$SKIP_DSH" == "1" ]]; then
    if [[ -z "${DSH_GATEWAY_DSH_PATH:-}" && -z "$DSH_WS" ]]; then
      # 解析后 preflight 已先行拒绝;此处兜底(如检测分支改过状态)不中止向导
      warn "--skip-dsh 缺少显式内建锚（design 18 §9.3）：请提供 --dsh-path 或 DSH_GATEWAY_DSH_PATH"
      return 1
    fi
    log "已指定 --skip-dsh"
    return 0
  fi
  # 本机已有 dsh 但不归 gateway 管理 → 接管建议
  local ext=""
  ext=$(detect_external_dsh || true)
  if [[ -n "$ext" ]]; then
    local takeover=""
    if ! ask_choice takeover \
      "检测到本机已有 dsh，但它不在 gateway 管理范围内。" \
      "位置：$ext

推荐由 gateway 统一管理，之后可在 /chamber/runtime 页面切换/回滚版本。" \
      "a" "a) 使用 gateway 安装受管版本（推荐）|managed" "b) 继续复用现有 dsh|reuse"; then return 1; fi
    if [[ "$takeover" == "reuse" ]]; then
      DSH_WS="$ext"
      DSH_FOUND="external"
      DSH_VER=""; npm_mirror=""   # 清掉 pass1 可能输入的版本/镜像选择,避免预览谎报安装版本
      log "复用现有 dsh：${ext}（不在 gateway 管理内，无法在 /chamber/runtime 切换版本）"
      return 0
    fi
  fi
  local v="${DSH_VER:-}"
  if ! ask_text v "dsh 版本" \
    $'dsh 是由 gateway 托管运行的 AI 助手运行时，版本由 gateway 统一管理。\n回车 = 跟随本次发布；也可输入指定版本。\n安装后随时可在 /chamber/runtime 页面安装/切换/回滚，无需重装。' \
    "${v:-$DSH_CHAMBER_DSH_VERSION}" valid_semver; then return 1; fi
  DSH_VER="$v"
  # back 导航重跑时以已选镜像为默认（MIRROR_CHOICE 记录选项值）
  local mirror="${MIRROR_CHOICE:-}"
  if ! ask_choice mirror "安装 dsh 时使用哪个 npm 源？" \
    $'国内镜像：registry.npmmirror.com，国内服务器推荐，下载更快。\n官方源：registry.npmjs.org。\n跟随系统：使用 npm 现有配置。' \
    "${mirror:-a}" "a) 国内镜像|cn" "b) 官方源|official" "c) 跟随系统|system"; then return 1; fi
  MIRROR_CHOICE="$mirror"
  case "$mirror" in
    cn) npm_mirror="https://registry.npmmirror.com" ;;
    official) npm_mirror="https://registry.npmjs.org" ;;
    *) npm_mirror="" ;;
  esac
}

stage7_location() {
  stage_header 7 8 "安装位置"
  if [[ "$FLAG_INSTALL" == "1" ]]; then
    INSTALL_METHOD="local"
    log "安装方式已由 --local 指定：local"
    return 0
  fi
  local choice=""
  if ! ask_choice choice "安装位置与更新方式？" \
    "local（推荐）：安装到 ${BASE_DIR}，gateway 自己管理程序版本与 dsh 版本，卸载干净，不碰系统 npm 全局。

global：npm 全局安装，适合已有 npm 全局管理习惯的用户。" \
    "${INSTALL_METHOD:-local}" "a) local（推荐）|local" "b) global（npm 全局）|global"; then return 1; fi
  INSTALL_METHOD="$choice"
}

stage8_preview() {
  if ! interactive; then
    # 管道输入同样可取消（与 uninstall 的 confirm() 语义一致，A8）；
    # -y 由 confirm() 的 NONINTERACTIVE 分支放行。
    if ! confirm "确认执行？" "y"; then die "已取消——未做任何修改，可随时重新运行"; fi
    return 0
  fi
  stage_header 8 8 "安装预览"
  local cred_desc="无"
  local parts=()
  [[ -n "$UI_PASSWORD" ]] && parts+=("密码$( (( AUTO_GEN_PASSWORD == 1 )) && printf '（自动生成）' || true )")
  [[ -n "$API_TOKEN" ]] && parts+=("Token$( (( AUTO_GEN_TOKEN == 1 )) && printf '（自动生成）' || true )")
  if [[ ${#parts[@]} -gt 0 ]]; then
    cred_desc=$(IFS=' '; printf '%s' "${parts[*]}")
    # 凭据存在时 gateway 以凭据为准,--no-auth 实际失效:预览必须如实展示
    [[ "$NO_AUTH" == "1" ]] && cred_desc+="（--no-auth 被凭据覆盖，实际已认证）"
  elif [[ "$NO_AUTH" == "1" ]]; then
    cred_desc="--no-auth（无认证）"
  fi
  local access_desc="仅本机"
  if [[ -n "$PUBLIC_ORIGIN" ]]; then
    if [[ "$BIND_HOST" == "0.0.0.0" ]]; then
      access_desc="直接暴露 0.0.0.0（origin 已设：$PUBLIC_ORIGIN）"
    else
      access_desc="反向代理 → $PUBLIC_ORIGIN"
    fi
  elif [[ -n "$TRUSTED_PROXY" ]]; then
    # D3:仅有 trusted-proxy(无 origin)= 反代直连内网形态,不是"仅本机"
    access_desc="反代直连（trusted proxy: $TRUSTED_PROXY，origin 未设）"
  elif [[ "$BIND_HOST" == "0.0.0.0" ]]; then
    access_desc="直接暴露（0.0.0.0）"
  fi
  local url="${BIND_HOST:-127.0.0.1}:$GATEWAY_PORT"
  [[ -n "$PUBLIC_ORIGIN" ]] && url="$PUBLIC_ORIGIN"
  [[ "$BIND_HOST" == "127.0.0.1" && -z "$PUBLIC_ORIGIN" && -z "$TRUSTED_PROXY" ]] && url="http://127.0.0.1:$GATEWAY_PORT"
  [[ "$BIND_HOST" == "127.0.0.1" && -z "$PUBLIC_ORIGIN" && -n "$TRUSTED_PROXY" ]] && url="http://127.0.0.1:$GATEWAY_PORT"
  [[ "$BIND_HOST" == "0.0.0.0" && -z "$PUBLIC_ORIGIN" ]] && url="http://<服务器IP>:$GATEWAY_PORT"
  printf '  安装包   : %s%s\n' "$VERSION" "$([[ "$CHANNEL" == "beta" ]] && printf '（beta 通道）' || true)"
  printf '  访问方式 : %s\n' "$access_desc"
  printf '  登录凭据 : %s\n' "$cred_desc"
  printf '  端口     : 对外 %s / dsh 内部 %s\n' "$GATEWAY_PORT" "$DSH_PORT"
  printf '  服务方式 : %s\n' "$(service_mode_desc)"
  printf '  绑定地址 : %s\n' "$BIND_HOST"
  printf '  反代 IP  : %s\n' "${TRUSTED_PROXY:-无}"
  printf '  服务用户 : %s\n' "${SERVICE_USER:-无（当前用户运行）}"
  if [[ -z "$DSH_VER" && -n "$DSH_WS" ]]; then
    printf '  dsh 锚   : %s（复用，本次不安装）\n' "$DSH_WS"
  else
    printf '  dsh 版本 : %s%s\n' "${DSH_VER:-$DSH_CHAMBER_DSH_VERSION}" "$([[ -n "$npm_mirror" ]] && printf '（npm 源: %s）' "$npm_mirror" || true)"
  fi
  printf '  安装位置 : %s\n' "$INSTALL_METHOD"
  printf '\n\033[1m将写入：\033[0m\n'
  printf '  %s/          程序版本树与配置\n' "$GATEWAY_DIR"
  printf '  %s          凭据文件（0600）\n' "$ENV_FILE"
  printf '  %s          本地命令目录\n' "$LOCAL_BIN_DIR"
  if [[ -f "$CONF_FILE" ]]; then
    printf '\n\033[1;33m注意：检测到已有安装，将原地复用数据并覆盖配置（全新安装请先 uninstall --purge）。\033[0m\n'
  fi
  printf '  访问地址 : %s\n' "$url"
  if [[ "$NO_AUTH" == "1" && -z "$UI_PASSWORD" && -z "$API_TOKEN" ]]; then
    printf '\n\033[1;31m⚠  无认证外部绑定：任何能访问该端口的人都可以完全控制。\033[0m\n'
  fi
  printf '%s\n' '────────────────────────────────────────────────────'
  printf '确认执行？ [\033[1my\033[0m]: '
  REPLY=$(trim_str "$REPLY")
  local _confirm_rc=0
  wiz_read_line
  _confirm_rc=$?
  if (( _confirm_rc == 1 )); then return 1; fi    # ESC：回第 7 步（与向导其它步骤一致）
  if (( _confirm_rc == 2 )); then die "已退出（EOF）——未做任何修改，可随时重新运行"; fi
  case "$(lower "$REPLY")" in
    ""|y|yes) : ;;
    q) die "已退出（q）——未做任何修改，可随时重新运行" ;;
    back) return 1 ;;    # 字面 back 与 ESC 同义(欢迎页承诺,M9)
    *) die "已取消——未做任何修改，可随时重新运行" ;;
  esac
}

# 阶段 0 欢迎页（仅交互）：这是什么 / 装哪 / 得到什么 / 操作说明 / 安全承诺
wizard_welcome() {
  if ! interactive; then return 0; fi
  wiz_clear
  printf '\n\033[1;36m%s\033[0m\n' "dsh-chamber Gateway 安装向导"
  printf '%s\n' '────────────────────────────────────────────────────'
  printf '  将要安装 : gateway —— 登录门户 + dsh（AI 助手）运行时管理器\n'
  printf '  安装位置 : %s\n' "$BASE_DIR"
  printf '  管理命令 : install-gateway.sh status | logs | restart | update | uninstall\n'
  printf '\n操作说明:\n'
  printf '  回车    接受默认值 / 继续下一步\n'
  printf '  输入    修改当前项（非法输入红字提示并原地重问）\n'
  printf '  ESC     返回上一步（即时生效，无需回车；也可输入 back）\n'
  printf '  q       退出（不会做任何修改）\n'
  printf '  Ctrl-C  中断\n'
  printf '\n在最后一步确认之前，本向导不会修改系统上的任何文件，可随时安全退出。\n\n'
  printf '按回车开始配置…'
  IFS= read -r _ || true
}

wizard() {
  if [[ "$NONINTERACTIVE" != "1" && ! -t 0 ]]; then
    warn "stdin 不是终端：将按默认值继续安装（如需完全自动请加 -y，如需交互请直接在终端运行）"
  fi
  wizard_welcome
  local -a stages=(stage1_version stage2_access stage3_credentials stage4_ports stage5_service stage6_dsh stage7_location stage8_preview)
  local i=0
  while (( i < ${#stages[@]} )); do
    if ! "${stages[$i]}"; then
      # ESC/back 返回上一步（第一步时提示后重问，不退出）
      if (( i > 0 )); then
        i=$((i - 1))
        log "返回上一步"
      else
        log "已是第一步，无法返回"
      fi
      continue
    fi
    i=$((i + 1))
  done
}
do_install() {
  # 先建布局再取锁:全新安装 BASE_DIR 尚不存在,锁目录 mkdir 会失败(DIFF #2)
  ensure_private_layout
  acquire_lock
  # 非 purge 卸载会保留 GATEWAY_DIR（state 数据），重新安装应当允许原地
  # 复用；仅当目录存在且无任何安装/状态痕迹时才视为外来冲突。
  if [[ -d "$GATEWAY_DIR" ]]; then
    if [[ -f "$CONF_FILE" || -d "$GATEWAY_DIR/data" || -d "$VERSIONS_DIR" ]]; then
      log "检测到保留的 gateway state（非 purge 卸载或既有安装）：原地复用；程序版本树仅校验复用或全新发布"
    else
      die "检测到外来目录 ${GATEWAY_DIR}（无安装/状态痕迹）。请先清空或改名该目录。"
    fi
  fi

  # 0) 私有布局：全部自有目录先以 0700 就位（消除 npm/mkdir 的 0755 窗口期）
  ensure_private_layout
  validate_service_user

  # 1) dsh 内建锚（探测 → 安装 → 验证；激活版本运行期经 /chamber/runtime 切换）
  if [[ -z "$DSH_WS" && "$SKIP_DSH" != "1" ]]; then
    install_dsh "${DSH_VER:-$DSH_CHAMBER_DSH_VERSION}"
  elif [[ -n "$DSH_WS" ]]; then
    local v
    v=$(verify_dsh "$DSH_WS" || true)
    [[ -n "$v" ]] || die "dsh workspace 验证失败：${DSH_WS}（缺少 node_modules/@deepseek-ai/dsh）"
    log "dsh 内建锚验证通过：${v}（${DSH_WS}）"
  fi

  # 2) gateway 包
  local tgz_src=""
  if [[ -n "$OFFLINE_TGZ" ]]; then
    [[ -f "$OFFLINE_TGZ" ]] || die "本地包不存在：$OFFLINE_TGZ"
    VERSION="local"
    tgz_src="$OFFLINE_TGZ"
    log "离线安装：$OFFLINE_TGZ"
  else
    download_verify "$GATEWAY_DIR"
    tgz_src="$GATEWAY_DIR/dsh-chamber-gateway-${VERSION}.tgz"
  fi

  # 2.5) 覆盖安装快照：在 3) 的任何树/npm 变更之前读取（S3/S4：失败回滚必须
  # 还原真正的旧指针/旧身份/旧配置——指针切换后再读只会拿到新树）。
  local previous_identity="" old_conf_txt="" old_env_txt="" old_cur="" old_mode="" old_ver="" had_old=0
  previous_identity=$(launch_identity || true)
  if [[ -f "$CONF_FILE" ]]; then
    had_old=1
    old_conf_txt=$(cat "$CONF_FILE" 2>/dev/null || true)
    # conf 由 %q 写出（简单值不带引号）；兼容历史带引号格式（S1）。
    old_mode=$(printf '%s' "$old_conf_txt" | sed -nE "s/^SERVICE_MODE='?([A-Za-z_][A-Za-z0-9_]*)'?\$/\1/p" | head -1)
    old_ver=$(printf '%s' "$old_conf_txt" | sed -nE "s/^VERSION='?([^#[:space:]']+)'?\$/\1/p" | head -1)
  fi
  [[ -f "$ENV_FILE" ]] && old_env_txt=$(cat "$ENV_FILE" 2>/dev/null || true)
  [[ -L "$GATEWAY_DIR/current" ]] && old_cur=$(readlink "$GATEWAY_DIR/current" 2>/dev/null || true)

  # 3) 安装方式
  if [[ "$INSTALL_METHOD" == "global" ]]; then
    have npm || die "npm 不可用（npm 全局安装需要 npm）"
    log "npm 全局安装 gateway v${VERSION} …"
    # S3:全局 npm 原地变更前先保全精确的旧版回滚资产(镜像 cmd_update 事务语义)。
    # local 标记(离线包)无在线资产可重取,无法构造可靠回滚 → 拒绝无回滚覆盖。
    if [[ "$had_old" == "1" && -n "$old_ver" ]]; then
      [[ "$old_ver" != "local" ]] || die "既有安装为 local（离线包）形态，npm 全局覆盖无法构造可靠回滚；请改用 local 安装或先 uninstall"
      local saved_ver="$VERSION"
      VERSION="$old_ver"
      if ! download_verify "$GATEWAY_DIR"; then
        VERSION="$saved_ver"
        die "旧版回滚资产（v${old_ver}）拉取/校验失败，拒绝无回滚的全局覆盖"
      fi
      VERSION="$saved_ver"
    fi
    npm install -g --no-audit --no-fund "$tgz_src"
    rm -f "$LOCAL_BIN_DIR/gateway" 2>/dev/null || true    # 清遗留 local 启动器,防 PATH 遮蔽(D-M2)
    have gateway || die "npm 全局安装后 gateway 不在 PATH"
  else
    log "本地安装到 $GATEWAY_DIR/versions/${VERSION} …"
    if [[ -e "$VERSIONS_DIR/${VERSION}" || -L "$VERSIONS_DIR/${VERSION}" ]]; then
      if [[ "$VERSION" == "local" ]]; then
        # 既有 local 树（重装/同版本重打包测试循环）：临时解包→内容指纹比较。
        # 一致→复用不动；不同→退避替换（与 update --tgz 语义一致）。
        local l_stage="" l_ver="" l_oldfp="" l_newfp="" l_prev=""
        l_stage=$(mktemp -d "$VERSIONS_DIR/.offline.XXXXXX")
        if tar -tzf "$tgz_src" 2>/dev/null | grep -qE '(^|/)\.\.(/|$)|^/'; then
          rm -rf "$l_stage"
          die "离线包包含越界路径成员，拒绝解包：$tgz_src"
        fi
        if tar -tvzf "$tgz_src" 2>/dev/null | sed -nE 's/^.* -> //p' | grep -qE '^/|(^|/)\.\.(/|$)'; then
          rm -rf "$l_stage"
          die "离线包包含越界符号链接成员，拒绝解包：$tgz_src"
        fi
        if ! tar --no-same-owner --no-same-permissions --no-absolute-names -xzf "$tgz_src" -C "$l_stage" --strip-components=1 2>/dev/null \
          && ! tar -xzf "$tgz_src" -C "$l_stage" --strip-components=1; then
          rm -rf "$l_stage"
          die "离线包解包失败：$tgz_src"
        fi
        l_ver=$(gateway_tree_version "$l_stage" || true)
        [[ -n "$l_ver" ]] || { rm -rf "$l_stage"; die "离线包不是有效 gateway 资产（缺 package.json/dist/cli.js）：$tgz_src"; }
        # 与 stage_local_version/cmd_update 同款:拒绝缺内嵌 pnpm 的资产(F3)
        [[ -f "$l_stage/dist/pnpm/bin/pnpm.cjs" ]] || { rm -rf "$l_stage"; die "离线包缺少内嵌 pnpm（dist/pnpm/bin/pnpm.cjs），local 安装无法运行：$tgz_src"; }
        l_oldfp=$(tree_fingerprint "$VERSIONS_DIR/local" || true)
        l_newfp=$(tree_fingerprint "$l_stage" || true)
        if [[ -n "$l_oldfp" && "$l_oldfp" == "$l_newfp" ]]; then
          rm -rf "$l_stage"
          log "离线包与既有 local 树内容一致，复用（v${l_ver}，无需重装程序版本）"
        else
          log "离线包内容与既有 local 树不同：替换 local 树（v${l_ver}）"
          l_prev="$VERSIONS_DIR/.local.prev.$$"
          rm -rf "$l_prev"
          if ! mv_T "$VERSIONS_DIR/local" "$l_prev"; then
            rm -rf "$l_stage" 2>/dev/null || true
            die "旧 local 树退避失败（原安装未改动）"
          fi
          if ! mv_T "$l_stage" "$VERSIONS_DIR/local"; then
            mv_T "$l_prev" "$VERSIONS_DIR/local" 2>/dev/null || true
            rm -rf "$l_stage" 2>/dev/null || true
            die "local 树替换失败（旧树已还原）"
          fi
          do_prev="$l_prev"    # 服务健康确认前保留退避旧树(F3),失败时尽力还原
        fi
      else
        local existing_version
        existing_version=$(gateway_tree_version "$VERSIONS_DIR/${VERSION}" || true)
        [[ -n "$existing_version" && ( "$VERSION" == "local" || "$existing_version" == "$VERSION" ) ]] \
          || die "既有 gateway 版本目录无法验证，拒绝 tar overlay：$VERSIONS_DIR/${VERSION}"
        log "复用已验证的不可变 gateway 版本树：$VERSIONS_DIR/${VERSION}"
      fi
    else
      stage_local_version "$tgz_src" "$VERSION" || die "本地 gateway 资产 staging/校验失败"
    fi
    switch_local_current "$VERSIONS_DIR/${VERSION}" || die "切换 gateway/current 失败"
    mkdir -p "$LOCAL_BIN_DIR"
    local node_bin=""
    node_bin=$(command -v node 2>/dev/null || printf "node")   # 绝对路径:systemd 默认 PATH 可能不含 nvm 等
    cat > "$LOCAL_BIN_DIR/gateway" <<EOF
#!/usr/bin/env bash
exec "$node_bin" "$GATEWAY_DIR/current/dist/cli.js" "\$@"
EOF
    chmod +x "$LOCAL_BIN_DIR/gateway"
  fi

  # 4) D2:跨形态覆盖安装先收拾旧形态残留(旧 systemd unit/旧前台进程;快照已于 2.5 读取)
  if have systemctl; then
    systemctl stop dsh-chamber-gateway.service 2>/dev/null || true
    systemctl disable dsh-chamber-gateway.service 2>/dev/null || true
  fi
  if [[ -f "$(foreground_record_file)" ]]; then
    stop_foreground || die "已有 foreground pid 身份不可验证，拒绝终止可能无关的进程（覆盖已中止：旧配置未写入、进程未停；local 树/指针或 global npm 变更未回滚，请人工核对 ${VERSIONS_DIR}/current 与 ${BASE_DIR}/run/gateway.pid 后重试）"
  fi
  # 5) 回滚助手:还原退避树+旧 conf/env/指针,尽力重启旧部署(D-M1)
  local restore_prev=0
  restore_prev_tree() {
    [[ "${restore_prev}" == "1" && -n "${do_prev:-}" && -e "$do_prev" ]] || return 0
    log "还原退避的旧 local 树"
    mv_T "$do_prev" "$VERSIONS_DIR/local" 2>/dev/null || true
    do_prev=""; restore_prev=0
  }
  restore_overlay_install() {
    restore_prev_tree
    if [[ "$had_old" == "1" && -n "$old_conf_txt" ]]; then
      local t=""
      t=$(mktemp "${CONF_FILE}.rst.XXXXXX") 2>/dev/null && { printf '%s\n' "$old_conf_txt" > "$t"; mv_T "$t" "$CONF_FILE" 2>/dev/null || rm -f "$t"; }
    fi
    if [[ -n "$old_env_txt" ]]; then
      local t2=""
      t2=$(mktemp "${ENV_FILE}.rst.XXXXXX") 2>/dev/null && { printf '%s\n' "$old_env_txt" > "$t2"; mv_T "$t2" "$ENV_FILE" 2>/dev/null || rm -f "$t2"; }
    fi
    if [[ "$INSTALL_METHOD" == "local" && -n "$old_cur" ]]; then
      switch_local_current "$old_cur" >/dev/null 2>&1 || true
    elif [[ "$INSTALL_METHOD" == "global" && -n "${old_ver:-}" && "$old_ver" != "local" ]]; then
      # S3:回滚 npm 全局树到步骤 3 保全的旧版资产(镜像 cmd_update 回滚)。
      npm install -g --no-audit --no-fund "$GATEWAY_DIR/dsh-chamber-gateway-${old_ver}.tgz" >/dev/null 2>&1 \
        || warn "旧版全局资产（v${old_ver}）恢复失败，请手工执行：npm install -g --no-audit --no-fund ${GATEWAY_DIR}/dsh-chamber-gateway-${old_ver}.tgz"
    fi
    local om="${old_mode:-}"
    if [[ -n "$om" && "$om" != "foreground" ]] && have systemctl; then
      SERVICE_MODE="$om"
      restart_service >/dev/null 2>&1 || warn "旧 systemd 服务未能自动重启,请手工:systemctl start dsh-chamber-gateway"
    elif [[ "$om" == "foreground" ]]; then
      local oexp=""
      [[ -n "${old_ver:-}" && "$old_ver" != "local" ]] && oexp="$old_ver"
      start_foreground "$oexp" "$previous_identity" >/dev/null 2>&1 \
        || warn "旧前台实例未能自动重启,日志见 ${BASE_DIR}/run/gateway.log"
    fi
  }
  [[ -n "${do_prev:-}" && -e "$do_prev" ]] && restore_prev=1
  # 6) 配置/凭据落盘(失败即回滚重启旧部署)
  write_config || { restore_overlay_install; die "安装配置写入失败（旧部署已尽力恢复）"; }
  write_env || { restore_overlay_install; die "凭据文件写入失败（旧部署已尽力恢复）"; }
  apply_service_user_ownership || { restore_overlay_install; die "数据目录属主移交失败（--service-user，旧部署已尽力恢复）"; }
  # 7) 启动新形态;失败整体回滚
  if [[ "$SERVICE_MODE" == "foreground" ]] || ! have systemctl; then
    SERVICE_MODE="foreground"
    start_foreground "$([[ "$VERSION" == "local" ]] && printf '' || printf '%s' "$VERSION")" "$previous_identity" \
      || { restore_overlay_install; die "前台启动失败（见 ${BASE_DIR}/run/gateway.log，旧部署已尽力恢复）"; }
  else
    write_unit || { restore_overlay_install; die "systemd unit 写入/daemon-reload/enable 失败（旧部署已尽力恢复）"; }
    restart_service || { restore_overlay_install; die "gateway 服务启动/重启失败（旧部署已尽力恢复）"; }
    health_wait "$GATEWAY_PORT" 30 "$([[ "$VERSION" == "local" ]] && printf '' || printf '%s' "$VERSION")" "$previous_identity" \
      || { restore_overlay_install; die "gateway 启动后未通过版本与新进程健康检查（旧部署已尽力恢复）"; }
  fi
  # 成功:清理退避旧树
  rm -rf "${do_prev:-}" 2>/dev/null || true
  do_prev=""; restore_prev=0
  # F9：安装成功后清理缓存 tgz（两形态；local 另裁剪版本树）
  rm -f "$GATEWAY_DIR"/dsh-chamber-gateway-*.tgz 2>/dev/null || true
  if [[ "$INSTALL_METHOD" == "local" ]]; then
    prune_version_trees
  fi
  log "安装完成。管理命令：install-gateway.sh status | logs | restart | update | uninstall"
  completion
}

# ---------------------------------------------------------------------------
# 安装完成页：访问信息 + PATH 写入（交互询问；-y 默认写入）+ 脚本自复制
# ---------------------------------------------------------------------------
setup_path() {
  mkdir -p "$LOCAL_BIN_DIR"
  local rc=""
  case "${SHELL:-}" in
    *zsh) rc="$HOME/.zshrc" ;;
    *) rc="$HOME/.bashrc" ;;
  esac
  local line="export PATH=\"$LOCAL_BIN_DIR:\$PATH\""
  local choice="write"
  if interactive; then
    if confirm "是否把 $LOCAL_BIN_DIR 加入 PATH？（写入 ${rc}，幂等不重复追加）

之后可直接使用 gateway 与 install-gateway.sh 命令；不写入则用全路径 $LOCAL_BIN_DIR/gateway 调用。" "y"; then
      choice="write"
    else
      choice="skip"   # ESC/EOF/q 均=跳过:安装已完成,不应以失败退出
    fi
  fi
  if [[ "$choice" == "write" ]]; then
    if [[ -f "$rc" ]] && grep -qF "$line" "$rc" 2>/dev/null; then
      log "PATH 已存在于 ${rc}（跳过）"
    elif printf '%s\n' "$line" >> "$rc" 2>/dev/null; then
      log "已追加到 ${rc}；重新登录终端（或 source ${rc}）后可直接使用 gateway"
    else
      # D5:rc 只读等失败只警告,不中断已成功的安装
      warn "无法写入 ${rc}（只读或无权限？）：未追加 PATH；可直接使用全路径 $LOCAL_BIN_DIR/gateway"
    fi
  else
    log "未写入 PATH；可直接使用全路径 $LOCAL_BIN_DIR/gateway"
  fi
}

install_self() {
  mkdir -p "$LOCAL_BIN_DIR"
  # $0 防护:curl | bash / bash <(curl …) 管道形态下 $0=bash,绝不能把
  # bash 二进制复制成 install-gateway.sh。校验 $0 是常规文件且含本脚本特征。
  if [[ ! -f "$0" || -L "$0" ]] || ! grep -q 'SUBCOMMAND="install"' "$0" 2>/dev/null; then
    warn "无法确定当前脚本文件位置（$0），跳过自复制；后续管理请保留当前脚本文件"
    return 0
  fi
  if [[ -f "$LOCAL_BIN_DIR/install-gateway.sh" ]] && cmp -s "$0" "$LOCAL_BIN_DIR/install-gateway.sh"; then
    return 0
  fi
  if cp "$0" "$LOCAL_BIN_DIR/install-gateway.sh" && chmod +x "$LOCAL_BIN_DIR/install-gateway.sh"; then
    log "安装脚本已复制到 $LOCAL_BIN_DIR/install-gateway.sh（后续管理请用该路径或 PATH 内命令）"
  else
    warn "安装脚本复制失败（$LOCAL_BIN_DIR/install-gateway.sh），后续管理请保留当前脚本文件"
  fi
}

completion() {
  local url="http://127.0.0.1:$GATEWAY_PORT"
  local url_hint="（在本机浏览器打开）"
  if [[ -n "$PUBLIC_ORIGIN" ]]; then
    url="$PUBLIC_ORIGIN"
    url_hint=""
  elif [[ "$BIND_HOST" == "0.0.0.0" ]]; then
    url="http://<服务器IP>:$GATEWAY_PORT"
    url_hint="（用服务器实际 IP 替换）"
  elif [[ -n "$TRUSTED_PROXY" ]]; then
    # D3:仅有 trusted-proxy(无 origin):经反代访问,origin 未设
    url="http://127.0.0.1:$GATEWAY_PORT"
    url_hint="（经反向代理访问；origin 未设时请在反代侧配置公网地址）"
  fi
  printf '\n\033[1;32m✔ 安装完成\033[0m\n'
  printf '%s\n' '────────────────────────────────────────────────────'
  printf '  服务方式 : %s\n' "$(service_mode_desc)"
  printf '  访问地址 : %s %s\n' "$url" "$url_hint"
  if [[ -n "$PUBLIC_ORIGIN" ]]; then
    printf '  提醒     : 请确认反向代理已把 %s 转发到 127.0.0.1:%s（HTTPS 由反代提供）\n' "$PUBLIC_ORIGIN" "$GATEWAY_PORT"
  fi
  if [[ "$NO_AUTH" == "1" && -z "$UI_PASSWORD" && -z "$API_TOKEN" ]]; then
    # 非交互/-y 安装从未见过预览页:完成页是唯一的警示面
    printf '\n\033[1;31m⚠  无认证运行：任何能访问到该端口的人都可以完全控制这台 gateway 和它托管的 dsh。仅适用于完全可信网络。\033[0m\n'
  elif [[ -n "$UI_PASSWORD" || -n "$API_TOKEN" ]]; then
    printf '  登录方式 : %s%s%s\n' \
      "$([[ -n "$UI_PASSWORD" ]] && printf '密码' || true)" \
      "$([[ -n "$UI_PASSWORD" && -n "$API_TOKEN" ]] && printf ' + ' || true)" \
      "$([[ -n "$API_TOKEN" ]] && printf 'Token' || true)"
    printf '  凭据文件 : %s（0600）\n' "$ENV_FILE"
    [[ "$NO_AUTH" == "1" ]] && printf '  提醒     : --no-auth 已失效（检测到凭据，实际为已认证形态）\n'
  else
    printf '  登录方式 : 无需凭据（仅本机/可信内网形态）\n'
  fi
  # 自复制成功(普通文件形态)才宣传固定路径;curl | bash 管道形态下脚本
  # 未复制,提示保留当前脚本即可。
  if [[ -f "$0" && ! -L "$0" ]] && grep -q 'SUBCOMMAND="install"' "$0" 2>/dev/null; then
    printf '  管理命令 : %s/bin/install-gateway.sh status | logs | restart | update | uninstall\n' "$BASE_DIR"
  else
    printf '  管理命令 : 保留当前脚本文件，运行 ./install-gateway.sh status | logs | restart | update | uninstall\n'
  fi
  if [[ "$DSH_FOUND" != "external" ]]; then
  printf '  切换 dsh 版本 : 登录后打开 /chamber/runtime（安装/切换/回滚，无需重装）\n'
  else
    printf '  dsh 切换     : 复用外部 dsh，不在 /chamber/runtime 管理范围内\n'
  fi
  # 自动生成凭据的唯一一次显示(生成于阶段 3,但阶段切换会清屏,故在此展示)。
  # 仅 TTY 显示;非交互/管道(如 CI 日志)只给文件路径,避免明文留存日志。
  if [[ "$AUTO_GEN_PASSWORD" == "1" || "$AUTO_GEN_TOKEN" == "1" ]]; then
    if [[ -t 1 ]]; then
      printf '\n\033[1;33m自动生成的登录凭据（只显示这一次，请立即记录；丢失后可用 gateway auth reset-password 重置）：\033[0m\n'
      [[ "$AUTO_GEN_PASSWORD" == "1" ]] && printf '  密码: %s\n' "$UI_PASSWORD"
      [[ "$AUTO_GEN_TOKEN" == "1" ]] && printf '  Token: %s\n' "$API_TOKEN"
    else
      printf '\n\033[1;33m自动生成的登录凭据只写入 %s（0600），请用 cat 查看并妥善保存；丢失后可用 gateway auth reset-password 重置。\033[0m\n' "$ENV_FILE"
    fi
  fi
  setup_path
  install_self
}

# ---------------------------------------------------------------------------
# 管理子命令
# ---------------------------------------------------------------------------
# Parse one assignment written by systemd_env_assignment as data. This is
# intentionally not `source "$ENV_FILE"`: EnvironmentFile quoting is not Bash
# quoting, and credentials may legally contain backticks, dollars or quotes.
read_systemd_env_value() {
  local key="$1"
  # 与 load_conf 对 conf 的纪律一致：拒绝符号链接/非常规文件；非属主且非 root 拒绝
  [[ -L "$ENV_FILE" || ! -f "$ENV_FILE" ]] && return 1
  if [[ ! -O "$ENV_FILE" && "$EUID" != "0" ]]; then return 1; fi
  node -e '
const fs = require("node:fs")
const [file, key] = process.argv.slice(1)
const text = fs.readFileSync(file, "utf8")
let i = 0
while (i < text.length) {
  while (i < text.length && /[ \t\r\n]/.test(text[i])) i += 1
  if (i >= text.length) break
  if (text[i] === "#") {
    const next = text.indexOf("\n", i)
    i = next === -1 ? text.length : next + 1
    continue
  }
  const nameStart = i
  while (i < text.length && /[A-Z0-9_]/.test(text[i])) i += 1
  const name = text.slice(nameStart, i)
  if (name === "" || text[i] !== "=") process.exit(2)
  i += 1
  if (text[i] !== "\"") process.exit(2)
  i += 1
  let value = ""
  let closed = false
  while (i < text.length) {
    const ch = text[i++]
    if (ch === "\\") {
      if (i >= text.length) process.exit(2)
      value += text[i++]
    } else if (ch === "\"") {
      closed = true
      break
    } else {
      value += ch
    }
  }
  if (!closed) process.exit(2)
  while (i < text.length && text[i] !== "\n") {
    if (!/[ \t\r]/.test(text[i])) process.exit(2)
    i += 1
  }
  if (name === key) {
    process.stdout.write(value)
    process.exit(0)
  }
}
process.exit(3)
' "$ENV_FILE" "$key"
}

# Preserve trailing newlines from a legacy password. Plain command
# substitution strips them, so append one private sentinel after the parser
# and remove exactly that final byte in the parent shell. The parser's status
# still distinguishes an absent key/file from malformed data.
SYSTEMD_ENV_VALUE=""
capture_systemd_env_value() {
  have node || return 2    # 缺 node 时无法解析 EnvironmentFile;调用方按"跳过迁移"处理
  local key="$1" raw status
  if raw=$(
    status=0
    read_systemd_env_value "$key" || status=$?
    printf '\036'
    exit "$status"
  ); then
    SYSTEMD_ENV_VALUE="${raw%$'\036'}"
    return 0
  else
    status=$?
    SYSTEMD_ENV_VALUE=""
    return "$status"
  fi
}

load_conf() {
  [[ -f "$CONF_FILE" ]] || die "未检测到安装（$CONF_FILE 不存在）。先运行 install。"
  # source 前校验:非常规文件(符号链接/非普通文件)或非本人所有 → 拒绝。
  # 配置由 write_config 以 0600 写入,若被替换为他人文件,绝不当 shell 执行。
  if [[ -L "$CONF_FILE" || ! -f "$CONF_FILE" ]]; then
    die "安装配置不是普通文件，拒绝加载：$CONF_FILE"
  fi
  if [[ ! -O "$CONF_FILE" && "$EUID" != "0" ]]; then
    # F1:root 管理 --service-user 安装时 conf 属主为 root,root 加载必须放行;
    # 非 root 且非属主仍拒绝(防篡改)。
    die "安装配置不属于当前用户，拒绝加载（可能被篡改）：$CONF_FILE"
  fi
  if ! bash -n "$CONF_FILE" 2>/dev/null; then
    # M3:语法损坏的 conf 在 source 时会裸报 bash 错;预检给出可操作出口
    die "安装配置语法损坏，无法安全加载：$CONF_FILE（卸载可用 uninstall --purge 强制清理后重装）"
  fi
  local has_env_anchor=0 has_password=0 has_token=0
  grep -q '^ENV_ANCHOR=' "$CONF_FILE" && has_env_anchor=1
  grep -q '^UI_PASSWORD=' "$CONF_FILE" && has_password=1
  grep -q '^API_TOKEN=' "$CONF_FILE" && has_token=1
  # shellcheck disable=SC1090
  . "$CONF_FILE"
  # Migrate configurations written before foreground launch values were added
  # to gateway.conf. Decode only our known EnvironmentFile assignments; never
  # execute that file as shell code.
  local read_status
  if [[ "$has_password" == "0" ]]; then
    if capture_systemd_env_value DSH_GATEWAY_PASSWORD; then
      UI_PASSWORD="$SYSTEMD_ENV_VALUE"
    else
      read_status=$?
      [[ "$read_status" == "1" || "$read_status" == "3" || "$read_status" == "2" ]] \
        || die "gateway.env 格式损坏，拒绝猜测 foreground 密码"
    fi
  fi
  if [[ "$has_token" == "0" ]]; then
    if capture_systemd_env_value DSH_GATEWAY_TOKEN; then
      API_TOKEN="$SYSTEMD_ENV_VALUE"
    else
      read_status=$?
      [[ "$read_status" == "1" || "$read_status" == "3" || "$read_status" == "2" ]] \
        || die "gateway.env 格式损坏，拒绝猜测 foreground token"
    fi
  fi
  if [[ "$has_env_anchor" == "0" ]]; then
    if capture_systemd_env_value DSH_GATEWAY_DSH_PATH; then
      DSH_WS="$SYSTEMD_ENV_VALUE"
      ENV_ANCHOR=1
    else
      read_status=$?
      if [[ "$read_status" == "1" || "$read_status" == "3" || "$read_status" == "2" ]]; then
        ENV_ANCHOR=0
      else
        die "gateway.env 格式损坏，拒绝猜测 DSH_GATEWAY_DSH_PATH 锚"
      fi
    fi
  fi
  [[ "$VERSION" == "local" ]] || validate_gateway_version "$VERSION"
  [[ "$INSTALL_METHOD" == "global" || "$INSTALL_METHOD" == "local" ]] || die "安装配置损坏：未知 INSTALL_METHOD=$INSTALL_METHOD"
  [[ "$SERVICE_MODE" == "systemd" || "$SERVICE_MODE" == "user" || "$SERVICE_MODE" == "foreground" ]] || die "安装配置损坏：未知 SERVICE_MODE=$SERVICE_MODE"
}

cmd_status() {
  load_conf
  printf 'gateway %s @ %s:%s（dsh :%s）\n' "$VERSION" "$BIND_HOST" "$GATEWAY_PORT" "$DSH_PORT"
  # F13：local 形态展示指针树版本；与配置分叉时如实警示（配置行不冒充运行态）
  if [[ "$INSTALL_METHOD" == "local" && -L "$GATEWAY_DIR/current" ]]; then
    local cur_tree cur_ver
    cur_tree=$(readlink "$GATEWAY_DIR/current")
    cur_ver=$(gateway_tree_version "$cur_tree" || true)
    if [[ -n "$cur_ver" && ( "$VERSION" == "local" || "$cur_ver" == "$VERSION" ) ]]; then
      printf '版本树: %s（current -> %s）\n' "$cur_ver" "$cur_tree"
    else
      printf '\033[1;33m版本树与配置不一致：current -> %s（树 %s），配置 VERSION=%s；请运行 update 对齐\033[0m\n' \
        "$cur_tree" "${cur_ver:-未知}" "$VERSION"
    fi
  fi
  if [[ "$SERVICE_MODE" == "foreground" ]]; then
    local identity
    identity=$(foreground_identity || true)
    if [[ -n "$identity" ]]; then
      printf '状态: 前台运行中（boot %s）\n' "$identity"
    else
      printf '状态: 未运行\n'
    fi
  else
    if ! have systemctl; then
      # M5:宿主无 systemd 时给出解释而非裸 command-not-found
      printf '状态: 配置为 %s 服务形态，但当前系统没有 systemctl（环境与配置不匹配）\n' "$SERVICE_MODE"
      printf '提示: 无 systemd 的主机安装 gateway 会使用前台形态；本机曾用 systemd 安装请重装或改配置\n'
    elif [[ "$SERVICE_MODE" == "user" ]]; then
      systemctl --user status dsh-chamber-gateway --no-pager 2>&1 | head -5 || true
    else
      systemctl status dsh-chamber-gateway --no-pager 2>&1 | head -5 || true
    fi
  fi
  if have curl; then curl -fsS -m 3 -o /dev/null "http://127.0.0.1:${GATEWAY_PORT}/health" 2>/dev/null && printf '健康: OK\n' || printf '健康: 不可达\n'; else printf '健康: 无法检查（缺少 curl）\n'; fi
  # design 18 §9.3：runtime 状态探测（/chamber/runtime 需认证，design 17 §4）。
  # 无凭据时 401 为诚实结果：提示用户经登录后查看，绝不静默假装成功。
  local rt rt_code
  rt=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${GATEWAY_PORT}/chamber/runtime/status" 2>/dev/null || true)
  rt_code="${rt:-000}"
  if [[ "$rt_code" == "401" || "$rt_code" == "403" ]]; then
    printf 'dsh 运行时: 需认证（%s）——登录后经 /chamber/runtime 查看\n' "$rt_code"
  else
    rt=$(curl -fsS -m 3 "http://127.0.0.1:${GATEWAY_PORT}/chamber/runtime/status" 2>/dev/null || true)
    if [[ -n "$rt" ]]; then
      printf 'dsh 运行时: %s\n' "$rt"
    fi
  fi
}

cmd_logs() {
  load_conf
  if [[ "$SERVICE_MODE" == "foreground" ]]; then
    [[ -f "${BASE_DIR}/run/gateway.log" ]] \
      || die "前台日志不存在：${BASE_DIR}/run/gateway.log（服务尚未启动或已被清理）"
    tail -f "${BASE_DIR}/run/gateway.log"
  elif [[ "$SERVICE_MODE" == "user" ]]; then
    have journalctl || die "当前环境没有 journalctl（user 服务日志需要 systemd）"
    journalctl --user -u dsh-chamber-gateway -f
  else
    have journalctl || die "当前环境没有 journalctl（系统服务日志需要 systemd）"
    journalctl -u dsh-chamber-gateway -f
  fi
}

cmd_restart() {
  load_conf
  acquire_lock
  # F7：local 形态先证明 launcher 与指针树可用——避免重启杀掉健康旧服务后
  # ExecStart 目标缺失；并断言指针树版本与配置一致（restart 兼作"切树确认"工具）
  if [[ "$INSTALL_METHOD" == "local" ]]; then
    [[ -L "$GATEWAY_DIR/current" ]] || die "gateway/current 不是符号链接：$GATEWAY_DIR/current"
    local cur_tree cur_ver
    cur_tree=$(readlink "$GATEWAY_DIR/current")
    [[ -n "$cur_tree" && -d "$cur_tree" && -f "$cur_tree/dist/cli.js" ]] \
      || die "gateway/current 指向不可用树：${cur_tree:-空}（先 update 或手工修复指针）"
    cur_ver=$(gateway_tree_version "$cur_tree" || true)
    [[ -n "$cur_ver" && ( "$VERSION" == "local" || "$cur_ver" == "$VERSION" ) ]] \
      || die "gateway/current 版本(${cur_ver:-未知})与配置($VERSION)不一致：先 update 对齐"
  fi
  log "重启 gateway（服务形态：${SERVICE_MODE}）…"
  local previous
  previous=$(launch_identity || true)
  if [[ "$SERVICE_MODE" == "foreground" ]]; then
    if [[ -f "$(foreground_record_file)" ]]; then
      stop_foreground || die "foreground pid 身份不可验证；为避免终止无关进程，重启已中止"
    fi
    start_foreground "$([[ "$VERSION" == "local" ]] && printf '' || printf '%s' "$VERSION")" "$previous" \
      || die "前台启动失败（见 ${BASE_DIR}/run/gateway.log）"
  else
    restart_service || die "gateway 服务重启失败"
    health_wait "$GATEWAY_PORT" 30 "$([[ "$VERSION" == "local" ]] && printf '' || printf '%s' "$VERSION")" "$previous" \
      || die "gateway 重启后未通过版本与新进程健康检查（journalctl $([[ "$SERVICE_MODE" == "user" ]] && printf '%s' '--user ') -u dsh-chamber-gateway）"
  fi
  log "gateway 已重启"
}

cmd_update() {
  ensure_private_layout
  acquire_lock
  # 私有布局与 install 一致收敛 0700（update 不重走向导，单独补齐）。
  # Preserve the caller's requested target before gateway.conf restores the
  # installed VERSION. An explicit --version must not silently become latest.
  local requested_version="$VERSION"
  load_conf
  validate_service_user
  log "当前版本：$VERSION"
  local old_version="$VERSION"
  local offline_replace=0
  if [[ -n "$OFFLINE_TGZ" ]]; then
    # F5：离线更新只支持 local 安装（VERSION=local）的本地替换：
    # install --tgz 之后可用 update --tgz <同形态包> 更新。
    [[ "$INSTALL_METHOD" == "local" && "$old_version" == "local" ]] \
      || die "离线 --tgz 仅支持 local 安装（VERSION=local）的更新；其它形态请走在线通道或先 uninstall"
    [[ -f "$OFFLINE_TGZ" ]] || die "本地包不存在：${OFFLINE_TGZ}（--tgz）"
    verify_offline_tgz "$OFFLINE_TGZ"
    offline_replace=1
  fi
  VERSION="$requested_version"
  resolve_version
  local target_version="$VERSION"
  local old_identity
  old_identity=$(launch_identity || true)
  if [[ "$SERVICE_MODE" == "foreground" && -f "$(foreground_record_file)" && -z "$old_identity" ]]; then
    # F2:记录进程已死(崩溃/重启残留)→ 放行,后续 stop_foreground 会清记录;
    # 仅"存活但身份不可验证"才拒绝(防 pid 复用误杀)。
    local _rpid="" _rexp="" _rextra=""
    IFS=' ' read -r _rpid _rexp _rextra < "$(foreground_record_file)" || true
    if [[ "$_rpid" =~ ^[0-9]+$ ]] && ! kill -0 "$_rpid" 2>/dev/null; then
      log "清理陈旧 foreground pid 记录（进程 $_rpid 已不存在）"
      rm -f "$(foreground_record_file)"
    else
      die "foreground pid 身份不可验证，拒绝终止可能无关的进程"
    fi
  fi
  if [[ "$SERVICE_MODE" != "foreground" ]] \
    && systemctl_for_mode is-active --quiet dsh-chamber-gateway.service \
    && [[ -z "$old_identity" ]]; then
    die "运行中的 systemd gateway 缺少可验证启动身份，拒绝以通用 /health 猜测升级成功"
  fi

  # ---- 旧版本身份校验前置（F6："已是最新"短路前先证明指针/树与配置一致）----
  local old_local_target="" new_local_target="" old_tree_version="" staged_fresh=0 offline_prev=""
  if [[ "$INSTALL_METHOD" == "local" ]]; then
    [[ -L "$GATEWAY_DIR/current" ]] || die "local 安装的 gateway/current 必须是符号链接，拒绝不确定升级"
    old_local_target=$(readlink "$GATEWAY_DIR/current")
    [[ -d "$old_local_target" ]] || die "gateway/current 指向不存在的旧版本：$old_local_target"
    old_tree_version=$(gateway_tree_version "$old_local_target" || true)
    [[ -n "$old_tree_version" && ( "$old_version" == "local" || "$old_tree_version" == "$old_version" ) ]] \
      || die "gateway/current 旧版本身份与配置不匹配：期望 ${old_version}，得到 ${old_tree_version:-未知}"
  fi
  if [[ "$target_version" == "$old_version" && "$offline_replace" == "0" ]]; then
    log "已是最新版本 ${target_version}（指针/树身份校验通过）"
    return 0
  fi
  # F3：目标低于当前(如 beta 装过、stable 通道取到更旧)必须显式确认——不静默降级
  if [[ "$offline_replace" == "0" && "$old_version" != "local" && "$target_version" != "$old_version" ]] \
    && version_lt "$target_version" "$old_version"; then
    if interactive; then
      if ! confirm "目标版本 ${target_version} 低于当前 ${old_version}（降级）；确认继续？" "n"; then
        die "已取消——未做任何修改（如需降级请重新运行并确认）"
      fi
    else
      die "目标版本 ${target_version} 低于当前 ${old_version}：拒绝非交互降级（请在交互终端运行 update 并确认，或指定更高的 --version 目标）"
    fi
  fi
  log "升级到 $target_version …"
  local confirm_label="确认升级到 ${target_version}？（失败自动回滚到 ${old_version}）"
  if [[ "$offline_replace" == "1" ]]; then
    confirm_label="确认用本地离线包更新当前 local 安装？（失败自动回滚）"
  fi
  if [[ "$NONINTERACTIVE" == "1" ]]; then
    :    # -y 由 flag 代表同意
  elif interactive; then
    if ! confirm "$confirm_label" "y"; then die "已取消——未做任何修改"; fi
  else
    # H2:管道输入可取消(与 install stage8/uninstall 一致)
    warn "stdin 不是终端：升级确认读取管道输入（输入 n 取消；完全自动请加 -y）"
    if ! confirm "$confirm_label" "y"; then die "已取消——未做任何修改"; fi
  fi

  # ---- 目标资产准备 ----
  local target_tgz="$GATEWAY_DIR/dsh-chamber-gateway-${target_version}.tgz"
  local old_tgz="$GATEWAY_DIR/dsh-chamber-gateway-${old_version}.tgz"
  if [[ "$offline_replace" == "1" ]]; then
    new_local_target="$VERSIONS_DIR/local"
  elif [[ "$INSTALL_METHOD" == "global" ]]; then
    # A global npm install mutates in place. Secure an exact rollback artifact
    # before touching it; otherwise this cannot honestly be called a
    # transaction.
    [[ "$old_version" != "local" ]] || die "旧版本来自未归档离线包，无法构造可靠回滚；请先重新 install 并保留版本资产"
    download_verify "$GATEWAY_DIR"
    # Re-fetch and verify the exact rollback release before mutating the
    # global npm tree. A stale/tampered cached tgz is not transaction proof.
    VERSION="$old_version"
    write_config >/dev/null 2>&1 || rollback_ok=0    # D-L1:回滚同步还原已提交的 conf
    download_verify "$GATEWAY_DIR"
    VERSION="$target_version"
  else
    download_verify "$GATEWAY_DIR"
    new_local_target="$VERSIONS_DIR/$target_version"
    if [[ -e "$new_local_target" || -L "$new_local_target" ]]; then
      # F4/A9：与 do_install 一致的"验证后复用不可变树"——更新到曾安装版本不再必死
      local existing_tree_version
      existing_tree_version=$(gateway_tree_version "$new_local_target" || true)
      [[ -n "$existing_tree_version" && "$existing_tree_version" == "$target_version" ]] \
        || die "既有 gateway 版本树无法验证，拒绝复用：$new_local_target"
      log "复用已验证的不可变 gateway 版本树：$new_local_target"
    else
      stage_local_version "$target_tgz" "$target_version" || die "新版本 staging/身份校验失败；旧版本未改动"
      staged_fresh=1
    fi
  fi

  # ---- 离线 local→local 替换：临时解包 → 版本必须不同 → 交换 ----
  if [[ "$offline_replace" == "1" ]]; then
    local offline_stage=""
    offline_stage=$(mktemp -d "$VERSIONS_DIR/.offline.XXXXXX")
    if tar -tzf "$OFFLINE_TGZ" 2>/dev/null | grep -qE '(^|/)\.\.(/|$)|^/'; then
      rm -rf "$offline_stage"
      die "离线包包含越界路径成员，拒绝解包：$OFFLINE_TGZ"
    fi
    # 与 stage_local_version 同款：拒绝越界符号链接成员（F12）
    if tar -tvzf "$OFFLINE_TGZ" 2>/dev/null | sed -nE 's/^.* -> //p' | grep -qE '^/|(^|/)\.\.(/|$)'; then
      rm -rf "$offline_stage"
      die "离线包包含越界符号链接成员，拒绝解包：$OFFLINE_TGZ"
    fi
    if ! tar --no-same-owner --no-same-permissions --no-absolute-names -xzf "$OFFLINE_TGZ" -C "$offline_stage" --strip-components=1 2>/dev/null \
      && ! tar -xzf "$OFFLINE_TGZ" -C "$offline_stage" --strip-components=1; then
      rm -rf "$offline_stage"
      die "离线包解包失败：$OFFLINE_TGZ"
    fi
    [[ -f "$offline_stage/dist/pnpm/bin/pnpm.cjs" ]] || { rm -rf "$offline_stage"; die "离线包缺少内嵌 pnpm（dist/pnpm/bin/pnpm.cjs）"; }
    local offline_new_version
    offline_new_version=$(gateway_tree_version "$offline_stage" || true)
    [[ -n "$offline_new_version" ]] || { rm -rf "$offline_stage"; die "离线包不是有效 gateway 资产（缺 package.json/dist/cli.js）"; }
    if [[ "$offline_new_version" == "$old_tree_version" ]]; then
      # 同版本不再拒绝（重打包修复/测试循环常态）：内容一致→幂等完成；
      # 内容不同→允许替换。
      local old_fp="" new_fp=""
      old_fp=$(tree_fingerprint "$new_local_target" || true)
      new_fp=$(tree_fingerprint "$offline_stage" || true)
      if [[ -n "$old_fp" && "$old_fp" == "$new_fp" ]]; then
        rm -rf "$offline_stage"
        log "离线包与当前 local 树内容一致（v${offline_new_version}），无需更新"
        return 0
      fi
      log "同版本离线包内容有差异：将替换 local 树（v${offline_new_version}）"
    fi
    # 事务：旧树退避保留（回滚用），新树就位
    offline_prev="$VERSIONS_DIR/.local.prev.$$"
    rm -rf "$offline_prev"
    if ! mv_T "$new_local_target" "$offline_prev"; then
      rm -rf "$offline_stage" 2>/dev/null || true
      die "离线版本树交换失败：旧树无法退避（旧版本未改动）"
    fi
    if ! mv_T "$offline_stage" "$new_local_target"; then
      # 第二 mv 失败：先把退避旧树还原，再清理新 stage，current 不会悬空
      mv_T "$offline_prev" "$new_local_target" 2>/dev/null || true
      rm -rf "$offline_stage" 2>/dev/null || true
      die "离线版本树交换失败：新树无法就位（旧树已还原）"
    fi
    staged_fresh=1
  fi

  if [[ "$SERVICE_MODE" == "foreground" ]]; then
    if [[ -f "$(foreground_record_file)" ]]; then
      if ! stop_foreground; then
        if [[ "$staged_fresh" == "1" && -n "$new_local_target" ]]; then rm -rf "$new_local_target"; fi
        if [[ -n "$offline_prev" && -e "$offline_prev" ]]; then mv_T "$offline_prev" "$new_local_target" 2>/dev/null || true; fi
        die "无法安全停止旧 foreground gateway"
      fi
    fi
  fi

  local failure_reason=""
  # F11：指针切换 ↔ 配置提交窗口的信号防护：中断先复原指针再退出
  if [[ "$INSTALL_METHOD" == "local" ]]; then
    if [[ "$offline_replace" == "1" ]]; then
      # 离线替换指针未动（同路径）：中断时把退避旧树 mv 回，不留 .local.prev
      trap 'if [[ -n "$offline_prev" && -e "$offline_prev" ]]; then mv_T "$offline_prev" "$new_local_target" >/dev/null 2>&1 || true; fi; die "升级被中断，旧版本树已还原"' INT TERM
    else
      trap 'switch_local_current "$old_local_target" >/dev/null 2>&1 || true; die "升级被中断，gateway/current 已复原"' INT TERM
    fi
  fi
  local expected_version=""
  [[ "$target_version" == "local" ]] || expected_version="$target_version"
  if [[ "$INSTALL_METHOD" == "global" ]]; then
    npm install -g --no-audit --no-fund "$target_tgz" || failure_reason="npm 安装新版本失败"
  else
    switch_local_current "$new_local_target" || failure_reason="原子切换 gateway/current 失败"
  fi

  if [[ -z "$failure_reason" ]]; then
    if [[ "$SERVICE_MODE" == "foreground" ]]; then
      start_foreground "$expected_version" "$old_identity" || failure_reason="新 foreground 进程未通过版本/启动身份健康检查"
    else
      write_unit || failure_reason="systemd unit 写入/daemon-reload/enable 失败"
      if [[ -z "$failure_reason" ]]; then
        apply_service_user_ownership || failure_reason="数据目录属主移交失败"
      fi
      if [[ -z "$failure_reason" ]]; then
        restart_service || failure_reason="systemd restart 失败"
      fi
      if [[ -z "$failure_reason" ]] && ! health_wait "$GATEWAY_PORT" 30 "$expected_version" "$old_identity"; then
        failure_reason="新 service 未通过目标版本/启动身份健康检查"
      fi
    fi
  fi

  if [[ -z "$failure_reason" ]]; then
    VERSION="$target_version"
    write_config || failure_reason="提交安装配置失败"
    apply_service_user_ownership || failure_reason="数据目录属主移交失败"
  fi
  trap - INT TERM

  if [[ -n "$failure_reason" ]]; then
    warn "${failure_reason}；回滚到 $old_version …"
    local rollback_ok=1 rollback_previous local_pointer_restored=1 rollback_expected_version=""
    [[ "$old_version" == "local" ]] || rollback_expected_version="$old_version"
    rollback_previous=$(launch_identity || true)
    if [[ "$SERVICE_MODE" == "foreground" && -f "$(foreground_record_file)" ]]; then
      stop_foreground || rollback_ok=0
    fi
    if [[ "$INSTALL_METHOD" == "global" ]]; then
      npm install -g "$old_tgz" >/dev/null 2>&1 || rollback_ok=0
    else
      switch_local_current "$old_local_target" || { rollback_ok=0; local_pointer_restored=0; }
    fi
    if [[ "$offline_replace" == "1" && -n "$offline_prev" && -e "$offline_prev" ]]; then
      if mv_T "$offline_prev" "$new_local_target" 2>/dev/null; then
        : # 退避旧树已还原（指针已指向它）
      else
        rollback_ok=0
      fi
    fi
    VERSION="$old_version"
    if [[ "$SERVICE_MODE" == "foreground" ]]; then
      start_foreground "$rollback_expected_version" "$rollback_previous" || rollback_ok=0
    else
      # F13：unit 内容与版本无关，回滚无需重写 unit（避免"unit 目录不可写"
      # 把可干净 restart 的回滚误报成失败）
      apply_service_user_ownership || rollback_ok=0
      restart_service || rollback_ok=0
      health_wait "$GATEWAY_PORT" 20 "$rollback_expected_version" "$rollback_previous" || rollback_ok=0
    fi
    if [[ "$INSTALL_METHOD" == "local" && "$offline_replace" != "1" && "$staged_fresh" == "1" && -n "$new_local_target" && "$local_pointer_restored" == "1" ]]; then
      rm -rf "$new_local_target"
    fi
    if [[ "$rollback_ok" == "1" ]]; then
      die "升级失败，已回滚到 ${old_version}：$failure_reason"
    fi
    die "升级失败且回滚未完全成功，请人工介入：$failure_reason"
  fi

  # 成功后清理（F9）：退避旧树删除；缓存 tgz 两形态都清（回滚资产可网络重取）
  if [[ "$offline_replace" == "1" && -n "$offline_prev" && -e "$offline_prev" ]]; then
    rm -rf "$offline_prev"
  fi
  rm -f "$GATEWAY_DIR"/dsh-chamber-gateway-*.tgz 2>/dev/null || true
  if [[ "$INSTALL_METHOD" == "local" ]]; then
    prune_version_trees
  fi
  if [[ "$offline_replace" == "1" ]]; then
    log "已用离线包完成 local 更新"
  else
    log "已升级到 $target_version"
  fi
}

cmd_uninstall() {
  local conf_bypassed=0
  # M3:--purge 时损坏 conf 不挡卸载——跳过加载,以保守默认进入强制清理
  if [[ "${PURGE:-0}" == "1" && -f "$CONF_FILE" ]] && ! bash -n "$CONF_FILE" 2>/dev/null; then
    warn "安装配置已损坏：跳过加载，进入 --purge 强制清理模式"
    VERSION="local"; INSTALL_METHOD="local"; SERVICE_MODE="foreground"
    GATEWAY_PORT="30801"; DSH_PORT="30800"; BIND_HOST="127.0.0.1"
    NO_AUTH="0"; conf_bypassed=1
  fi
  if [[ "$conf_bypassed" == "0" ]]; then
    load_conf
  fi
  acquire_lock    # F4:purge 会 rm -rf GATEWAY_DIR,必须与 update/install 互斥
  if [[ "$NONINTERACTIVE" == "1" ]]; then
    :  # -y 显式放行（脚本化卸载）
  elif ! confirm "确认卸载 gateway（保留 state，--purge 才删 dsh-runtime/ 与 dsh-home/）？" "n"; then
    die "已取消"
  fi
  if [[ "$conf_bypassed" == "1" ]]; then
    # 损坏 conf 无法得知服务形态:systemd 两形态尽力停(忽略失败,后续删文件)
    systemctl disable --now dsh-chamber-gateway 2>/dev/null || true
    systemctl --user disable --now dsh-chamber-gateway 2>/dev/null || true
    # S5:形态未知时两处 unit 文件一并删除(--purge 强清;disable 只停不删,
    # 旁路下没有后续 rm 分支会执行,陈旧 unit 会令同路径重装/update 误判)。
    rm -f /etc/systemd/system/dsh-chamber-gateway.service 2>/dev/null || true
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/dsh-chamber-gateway.service" 2>/dev/null || true
  fi
  if [[ "$SERVICE_MODE" == "foreground" ]]; then
    if [[ -f "$(foreground_record_file)" ]]; then
      stop_foreground || die "foreground pid 身份不可验证；为避免终止无关进程，卸载已中止"
    fi
  elif [[ "$SERVICE_MODE" == "user" ]]; then
    # 停服失败且服务仍在运行 → 中止卸载（C 区 #8：不对运行中服务删数据）
    if ! systemctl --user disable --now dsh-chamber-gateway 2>/dev/null \
      && systemctl --user is-active --quiet dsh-chamber-gateway 2>/dev/null; then
      die "user 服务停止失败（systemctl --user disable --now）：为避免删除运行中服务的数据，卸载已中止"
    fi
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/dsh-chamber-gateway.service"
  else
    if ! systemctl disable --now dsh-chamber-gateway 2>/dev/null \
      && systemctl is-active --quiet dsh-chamber-gateway 2>/dev/null; then
      die "服务停止失败（systemctl disable --now）：为避免删除运行中服务的数据，卸载已中止"
    fi
    rm -f /etc/systemd/system/dsh-chamber-gateway.service
  fi
  if [[ "$INSTALL_METHOD" == "global" ]]; then
    npm uninstall -g @dsh-chamber/gateway 2>/dev/null || true
  fi
  # 凭据文件一律删除（活凭据不随卸载保留）；state 数据是否保留由 PURGE 决定。
  rm -f "$CONF_FILE" "$ENV_FILE"
  # 非 purge 卸载仍清掉指向已删程序文件的启动器、自复制脚本与运行期痕迹
  # （state 保留；A18：install_self 复制的管理脚本一并移除）。
  rm -f "${BASE_DIR}/bin/gateway" "${BASE_DIR}/bin/install-gateway.sh" 2>/dev/null || true
  rm -f "${BASE_DIR}/run/gateway.pid" "${BASE_DIR}"/run/gateway*.log 2>/dev/null || true
  # 事后验证：systemd 形态下服务应已停止（失败要响亮，不能假装卸载成功）
  if [[ "$SERVICE_MODE" == "user" ]]; then
    if systemctl --user is-active --quiet dsh-chamber-gateway 2>/dev/null; then
      warn "user 服务仍在运行（systemctl --user disable --now 失败？），请检查：systemctl --user status dsh-chamber-gateway"
    fi
  elif [[ "$SERVICE_MODE" == "systemd" ]]; then
    if systemctl is-active --quiet dsh-chamber-gateway 2>/dev/null; then
      warn "服务仍在运行（systemctl disable --now 失败？），请检查：systemctl status dsh-chamber-gateway"
    fi
  fi
  if [[ "${PURGE:-0}" == "1" ]]; then
    rm -rf "$GATEWAY_DIR"
    # A18：--purge 顺带移除安装器写入的 PATH 追加行（仅精确匹配我们写入的行）
    local rc_file path_line="" rc_mode=""
    path_line="export PATH=\"${LOCAL_BIN_DIR}:\$PATH\""
    for rc_file in "$HOME/.bashrc" "$HOME/.zshrc"; do
      [[ -f "$rc_file" ]] || continue
      if grep -qF "$path_line" "$rc_file" 2>/dev/null; then
        # 保留原文件 mode（全局 umask 077 下 tmp 会变 0600,DIFF #11）
        rc_mode=$(stat -f '%Lp' "$rc_file" 2>/dev/null || stat -c '%a' "$rc_file" 2>/dev/null || true)
        if grep -vF "$path_line" "$rc_file" > "$rc_file.tmp.$$" 2>/dev/null && mv_T "$rc_file.tmp.$$" "$rc_file"; then
          [[ -n "$rc_mode" ]] && chmod "$rc_mode" "$rc_file" 2>/dev/null || true
          log "已从 $rc_file 移除 PATH 追加行"
        else
          rm -f "$rc_file.tmp.$$" 2>/dev/null || true
          warn "无法从 $rc_file 移除 PATH 行（只读或无权限？）——可手动删除：$path_line"
        fi
      fi
    done
    rmdir "$LOCAL_BIN_DIR" 2>/dev/null || true
    # uninstall 自身 ensure_private_layout 可能重建 run/ 等空目录:一并清掉
    rmdir "${BASE_DIR}/run" "${BASE_DIR}/bin" "$BASE_DIR" 2>/dev/null || true
    log "已彻底卸载（含 state：dsh-runtime/ 版本树与快照、dsh-home/ 会话数据）"
  else
    log "已卸载（数据保留于 ${GATEWAY_DIR}，含 data/dsh-runtime/ 版本树与快照、data/dsh-home/ 会话数据；凭据已删除，仅 --purge 删除数据）"
  fi
}

# ---------------------------------------------------------------------------
# 参数解析
# ---------------------------------------------------------------------------
usage() {
  # 打印头部注释块（第 2 行起，止于 set -euo pipefail 之前）；
  # 管道形态 $0 不可用时有兜底提示。
  if [[ ! -f "$0" || -L "$0" ]] || ! grep -q 'SUBCOMMAND="install"' "$0" 2>/dev/null; then
    printf '无法读取脚本自身（管道执行形态）；用法请见 https://github.com/panzeyu2013/dsh-chamber 的 docs/deploy/deploy-gateway.md\n'
    EXITED_OK=1
    exit 0
  fi
  awk 'NR>=2 { if ($0=="set -euo pipefail") exit; sub(/^# ?/, ""); print }' "$0"
  EXITED_OK=1
  exit 0
}

SUBCOMMAND="install"
FLAG_PIN=0    # --version/--tgz 显式 pin(与 --channel 区分,DIFF #5)
while [[ $# -gt 0 ]]; do
  case "$1" in
    install|update|restart|status|logs|uninstall) SUBCOMMAND="$1"; shift ;;
    help|-h|--help) SUBCOMMAND="help"; shift; break ;;    # M1：--help 短路,后续参数不再解析
    -y|--yes) NONINTERACTIVE=1; shift ;;
    --version) [[ $# -ge 2 ]] || die "--version 需要值（查询已装 gateway 版本请用 status）"; VERSION="$2"; FLAG_VERSION=1; FLAG_PIN=1; shift 2 ;;
    --channel) [[ $# -ge 2 ]] || die "--channel 需要值"; CHANNEL="$2"; FLAG_VERSION=1
      [[ "$CHANNEL" == "stable" || "$CHANNEL" == "beta" ]] || die "非法安装通道：${CHANNEL}（仅 stable | beta）"
      shift 2 ;;
    --tgz) [[ $# -ge 2 ]] || die "--tgz 需要值"; OFFLINE_TGZ="$2"; FLAG_VERSION=1; FLAG_PIN=1; shift 2 ;;
    --gateway-port) [[ $# -ge 2 ]] || die "--gateway-port 需要值"; GATEWAY_PORT="$2"; FLAG_PORTS=1; shift 2 ;;
    --dsh-port) [[ $# -ge 2 ]] || die "--dsh-port 需要值"; DSH_PORT="$2"; FLAG_PORTS=1; shift 2 ;;
    --dsh-path) [[ $# -ge 2 ]] || die "--dsh-path 需要值"; DSH_WS="$2"; DSH_FOUND="explicit"; shift 2 ;;
    --bind) [[ $# -ge 2 ]] || die "--bind 需要值"; BIND_HOST="$2"; FLAG_ACCESS=1; shift 2 ;;
    --origin) [[ $# -ge 2 ]] || die "--origin 需要值"; PUBLIC_ORIGIN="$2"; FLAG_ACCESS=1; shift 2 ;;
    --trusted-proxy) [[ $# -ge 2 ]] || die "--trusted-proxy 需要值"; TRUSTED_PROXY="$2"; FLAG_ACCESS=1; shift 2 ;;
    --ui-password) [[ $# -ge 2 ]] || die "--ui-password 需要值"; UI_PASSWORD="$2"; FLAG_CRED=1; shift 2 ;;
    --api-token) [[ $# -ge 2 ]] || die "--api-token 需要值"; API_TOKEN="$2"; FLAG_CRED=1; shift 2 ;;
    --no-auth) NO_AUTH=1; FLAG_CRED=1; shift ;;
    --local) INSTALL_METHOD="local"; FLAG_INSTALL=1; shift ;;
    --service-user) [[ $# -ge 2 ]] || die "--service-user 需要值"; SERVICE_USER="$2"; shift 2 ;;
    --foreground) SERVICE_MODE="foreground"; shift ;;
    --skip-dsh) SKIP_DSH=1; shift ;;
    --purge) PURGE=1; shift ;;
    *) die "未知选项：$1（--help 查看用法）" ;;
  esac
done

# --tgz 支持 ~/ 展开（字面 ~ 不会在 [[ -f ]] 中展开，是"文件不存在"误报根因之一）；
# 规范化后由 preflight 快速失败（避免进入向导/dsh 安装后才报路径错误）。
if [[ -n "$OFFLINE_TGZ" ]]; then
  [[ "$OFFLINE_TGZ" == \~/* ]] && OFFLINE_TGZ="$HOME/${OFFLINE_TGZ#\~/}"
  [[ "$OFFLINE_TGZ" == \~ ]] && OFFLINE_TGZ="$HOME"
fi

# --purge 只对 uninstall 有意义:提前拒绝,避免静默无效(--help 除外,usage 优先)
if [[ "${PURGE:-0}" == "1" && "$SUBCOMMAND" != "uninstall" ]] \
  && [[ "$SUBCOMMAND" != "help" && "$SUBCOMMAND" != "-h" && "$SUBCOMMAND" != "--help" ]]; then
  die "--purge 仅用于 uninstall 子命令（$SUBCOMMAND 忽略该选项）"
fi

# 空值选项拒绝:--version= / --gateway-port= 等空串静默走默认是误导
if [[ "${FLAG_PIN:-0}" == "1" && -z "$VERSION" && -z "$OFFLINE_TGZ" ]] \
  && [[ "$SUBCOMMAND" != "help" && "$SUBCOMMAND" != "-h" && "$SUBCOMMAND" != "--help" ]]; then
  die "版本类选项值不能为空（--version / --tgz 至少提供一个非空值）"
fi
if [[ "$FLAG_PORTS" == "1" && -z "$GATEWAY_PORT" && -z "$DSH_PORT" ]]; then
  die "端口类选项值不能为空（--gateway-port / --dsh-port）"
fi
if [[ "$FLAG_ACCESS" == "1" && -z "$BIND_HOST" && -z "$PUBLIC_ORIGIN" && -z "$TRUSTED_PROXY" ]]; then
  die "--bind 需要值（127.0.0.1 或 0.0.0.0）"
fi
if [[ "$FLAG_CRED" == "1" && "$NO_AUTH" == "0" && -z "$UI_PASSWORD" && -z "$API_TOKEN" ]]; then
  die "凭据类选项值不能为空（--ui-password / --api-token）"
fi

# 子命令 × 选项矩阵：仅 install 的形态/向导选项在其它子命令下无意义——
# 警告而非静默忽略（F10）。
case "$SUBCOMMAND" in
  install|help|-h|--help) ;;
  update)
    # update 合法：--version/--channel（离线 --tgz 由 cmd_update 明确拒绝）
    [[ -z "$UI_PASSWORD" && -z "$API_TOKEN" && "$NO_AUTH" == "0" ]] \
      || warn "凭据类选项只影响 install（当前 update 忽略）：--ui-password/--api-token/--no-auth"
    [[ -z "$BIND_HOST" && -z "$PUBLIC_ORIGIN" && -z "$TRUSTED_PROXY" ]] \
      || warn "访问类选项只影响 install（当前 update 忽略，按配置加载）：--bind/--origin/--trusted-proxy"
    [[ -z "$GATEWAY_PORT" && -z "$DSH_PORT" ]] \
      || warn "端口类选项只影响 install（当前 update 忽略，按配置加载）：--gateway-port/--dsh-port"
    [[ -z "$DSH_WS" ]] \
      || warn "--dsh-path 只影响 install（当前 update 忽略，按配置加载）"
    [[ -z "$INSTALL_METHOD" && -z "$SERVICE_USER" && "$SERVICE_MODE" == "auto" && "$SKIP_DSH" == "0" ]] \
      || warn "安装形态选项只影响 install（当前 update 忽略）：--local/--service-user/--foreground/--skip-dsh"
    ;;
  *)
    if [[ "$FLAG_VERSION" == "1" ]]; then
      warn "版本类选项只影响 install/update（当前 $SUBCOMMAND 忽略）：--version/--channel/--tgz"
    fi
    [[ -z "$UI_PASSWORD" && -z "$API_TOKEN" && "$NO_AUTH" == "0" ]] \
      || warn "凭据类选项只影响 install（当前 $SUBCOMMAND 忽略）：--ui-password/--api-token/--no-auth"
    [[ -z "$BIND_HOST" && -z "$PUBLIC_ORIGIN" && -z "$TRUSTED_PROXY" ]] \
      || warn "访问类选项只影响 install（当前 $SUBCOMMAND 忽略）：--bind/--origin/--trusted-proxy"
    [[ -z "$GATEWAY_PORT" && -z "$DSH_PORT" ]] \
      || warn "端口类选项只影响 install（当前 $SUBCOMMAND 忽略）：--gateway-port/--dsh-port"
    [[ -z "$DSH_WS" ]] \
      || warn "--dsh-path 只影响 install（当前 $SUBCOMMAND 忽略）"
    [[ -z "$INSTALL_METHOD" && -z "$SERVICE_USER" && "$SERVICE_MODE" == "auto" && "$SKIP_DSH" == "0" ]] \
      || warn "安装形态选项只影响 install（当前 $SUBCOMMAND 忽略）：--local/--service-user/--foreground/--skip-dsh"
    ;;
esac

# 前置检查:node 是 gateway 运行依赖;curl 仅在线下载需要(离线包可跳过)。
# 检查放在参数解析后、进入向导前,让小白第一时间看到缺什么而不是装到一半才失败。
preflight() {
  have node || die "缺少 node(≥22):gateway 运行依赖 node,请先安装(https://nodejs.org)"
  # 文案声称 ≥22 就必须真的查版本：node 18/20 会在源码树 dsh 路径的
  # `node --import tsx/esm` 或 gateway 本体处中途失败，报错要前置且诚实。
  # 运行时下限与工具链（CI/开发统一 24）分离：产物为 esbuild node22 语法
  # 目标，node 22（maintenance LTS，至 2027-04）仍在官方支持期内。
  local node_ver node_major
  node_ver=$(node --version 2>/dev/null || true)
  node_major=$(printf '%s' "$node_ver" | sed 's/^v\([0-9][0-9]*\).*/\1/' || true)
  [[ "$node_major" =~ ^[0-9]+$ && "$node_major" -ge 22 ]] \
    || die "node 版本过低：${node_ver:-未知}，需要 ≥22（https://nodejs.org）"
  if [[ -z "$OFFLINE_TGZ" ]]; then
    have curl || die "缺少 curl:下载安装包需要 curl(离线包模式可用 --tgz 跳过)"
  else
    # 离线包路径快速失败（此前只在 do_install 的 dsh 锚安装之后才检查）
    [[ -f "$OFFLINE_TGZ" ]] || die "本地包不存在：${OFFLINE_TGZ}（--tgz）"
    verify_offline_tgz "$OFFLINE_TGZ"
  fi
  # --skip-dsh 需要显式内建锚（design 18 §9.3）：进入向导前就拒绝，
  # 避免向导走到第 6 步才 die 丢全部答案（A6）。
  if [[ "$SKIP_DSH" == "1" && -z "${DSH_GATEWAY_DSH_PATH:-}" && -z "$DSH_WS" ]]; then
    die "--skip-dsh 需要显式内建锚：请提供 --dsh-path <workspace> 或设 DSH_GATEWAY_DSH_PATH，或去掉 --skip-dsh 让脚本自动安装。"
  fi
}

case "$SUBCOMMAND" in
  help|-h|--help) usage ;;
  install) preflight; wizard; do_install ;;
  update) cmd_update ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  uninstall) cmd_uninstall ;;
esac
# 脚本自然结束:先捕获最终状态再打正常结束标记(EXIT trap 的 fail-closed 需要),
# 并以显式 exit 透传——避免末尾赋值把子命令的非零返回也抹成 0。
_final_rc=$?
EXITED_OK=1
exit "$_final_rc"
