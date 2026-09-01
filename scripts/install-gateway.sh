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
#   install-gateway.sh update [--version X] 升级（保留配置，失败自动回滚）
#   install-gateway.sh restart              重启 gateway（systemd/user/前台）
#   install-gateway.sh status|logs|uninstall
#   选项：-y/--yes 非交互（用默认值+flags）；--version V 精确 pin；
#         --channel beta 预发布通道；--tgz FILE 离线本地包；
#         --gateway-port N --dsh-port N --dsh-path DIR --skip-dsh
#         --origin URL --trusted-proxy IP --ui-password P --api-token T
#         --no-auth --local --foreground --purge
#         --service-user USER 以专用系统用户运行 gateway（unit 加 User=，
#           chown 全部数据目录；仅 root + systemd 服务形态可用）
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
DSH_CHAMBER_DSH_VERSION="${DSH_CHAMBER_DSH_VERSION:-0.1.2-alpha.3}"
GITHUB_REPO="${DSH_CHAMBER_GITHUB_REPO:-panzeyu2013/dsh-chamber}"
BASE_DIR="${DSH_CHAMBER_BASE_DIR:-${HOME:?HOME 环境变量未设置（可用 DSH_CHAMBER_BASE_DIR 指定安装位置）}/.dsh-chamber}"
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

log()  { printf '\033[1;34m[gateway]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[gateway]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[gateway]\033[0m %s\n' "$*" >&2; exit 1; }

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
# 交互工具
# ---------------------------------------------------------------------------
# prompt VAR 提示语 默认值 —— 回车接受默认，输入即覆盖；非交互时直接默认
prompt() {
  local var="$1" label="$2" def="${3:-}"
  local cur="${!var-}"
  # 已通过命令行 flag 提供的值优先作为默认（用户仍可在交互中修改）
  [[ -n "$cur" ]] && def="$cur"
  if [[ "$NONINTERACTIVE" == "1" || ! -t 0 ]]; then
    assign_var "$var" "$def"
    return 0
  fi
  local input
  if [[ -n "$def" ]]; then
    printf '%s [\033[1m%s\033[0m]: ' "$label" "$def"
  else
    printf '%s: ' "$label"
  fi
  IFS= read -r input || true
  if [[ "${input:-}" == "q" ]]; then die "已退出（q）——未做任何修改，可随时重新运行"; fi
  assign_var "$var" "${input:-$def}"
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
}

# 帮助文本：每行 ≤80 列缩进输出（交互模式）
wiz_help() {
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] && printf '    %s\n' "$line" || true
  done <<< "$1"
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
  local item octet
  local IFS=','
  for item in $1; do
    [[ "$item" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || {
      printf '\033[1;31m✗ 反代 IP 必须是精确 IPv4 地址，逗号分隔（如 1.2.3.4,5.6.7.8）\033[0m\n'; return 1
    }
    local IFS='.'
    for octet in $item; do
      (( octet <= 255 )) || {
        printf '\033[1;31m✗ IPv4 每段必须在 0-255：%s\033[0m\n' "$item"; return 1
      }
    done
  done
  return 0
}

# ask_text VAR 标签 帮助 默认值 校验器 —— 文本输入：
#   回车 = 默认；q = 退出；ESC 或 back = 返回上一步（返回 1）；非法输入红字重问。
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
    local input
    IFS= read -r input || true
    case "${input:-}" in
      q) die "已退出（q）——未做任何修改，可随时重新运行" ;;
      $'\e'|back) return 1 ;;
    esac
    input="${input:-$def}"
    if [[ -n "$validator" ]] && ! "$validator" "$input"; then continue; fi
    assign_var "$var" "$input"
    return 0
  done
}

# 小写化（macOS bash 3.2 无 ${var,,}，用 tr）
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

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
      printf '  \033[1m%s\033[0m) %s\n' "$letter" "$text"
    done
    printf '选择 [\033[1m%s\033[0m]: ' "$def"
    local input
    IFS= read -r input || true
    case "${input:-}" in
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
    if [[ -z "$match" && ( "$input" == $'\e' || "$input" == "back" ) ]]; then
      return 1    # ESC/back 返回上一步（选项字母优先：如 b) beta 仍可选）
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
# stty -echo 整行读取：终端原生退格编辑，回车后立即显示字符数）。
# 输入到 REPLY；Ctrl-C 走 trap 中断。
read_secret_counted() {
  local buf=""
  if ! have stty; then
    warn "stty 不可用，输入将明文回显"
    IFS= read -r buf || true
  else
    trap 'stty echo 2>/dev/null; die "已中断"' INT TERM HUP QUIT
    stty -echo
    IFS= read -r buf || true
    stty echo
    trap - INT TERM HUP QUIT
  fi
  printf '已输入 %d 字符\n' "${#buf}"
  REPLY="$buf"
}

# ask_secret2 VAR 标签 帮助 最小长度 最大长度 —— 隐藏输入 + 实时计数 +
# 双重确认 + 长度校验：不一致或过短进入重试循环；留空 = 请求自动生成
# （返回 2，调用方负责生成并显示一次）；Ctrl-C 中断。
ask_secret2() {
  local var="$1" label="$2" help="$3" min="$4" max="$5"
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
    printf '请再次输入确认: '
    read_secret_counted
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
  local input
  IFS= read -r input || true
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
  IFS= read -r input || true
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

# 拉取 GitHub Releases 全部可用版本（最新在前，最多 100 个）写入 RELEASE_LIST：
#   每行 <版本>|<预发布:0/1>|<有gateway资产:0/1>|<发布日期>，仅收录 canonical SemVer。
# 用 node 解析（preflight 已保证 node ≥22；脚本 read_systemd_env_value 已有同款先例），
# 对 GitHub 的美化（多行缩进）与压缩 JSON 都健壮——旧 sed 按 '},{' 切分对美化 JSON
# 完全不生效（release 之间实际是 '},  {' 带缩进），曾导致 beta 通道实际取到"文档里
# 第一个 tag"即最新任意 release，而不是真正的预发布。成功且非空返回 0；网络失败或
# 无合法版本返回 1（调用方决定报错或回退手动输入）。
fetch_available_versions() {
  local json
  json=$(github_api "https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100") || return 1
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
    assign_var "$var" "${val#v}"
    return 0
  fi
  if ! fetch_available_versions; then
    warn "无法获取版本列表（GitHub Releases API 不可达），请手动输入版本号"
    if ! ask_text val "请输入精确版本" \
      "版本号需是 canonical SemVer，可带 v 前缀（如 0.1.5 / v0.1.5）。" "" valid_semver_v; then return 1; fi
    assign_var "$var" "${val#v}"
    return 0
  fi
  print_version_list
  while true; do
    printf '输入序号选择，或直接输入版本号（q 退出，ESC/back 返回上一步）: '
    local input=""
    if ! IFS= read -r input; then
      die "已退出（EOF）——未做任何修改，可随时重新运行"
    fi
    case "${input:-}" in
      q) die "已退出（q）——未做任何修改，可随时重新运行" ;;
    esac
    if [[ -z "$input" ]]; then
      print_version_list    # 回车：重新展示列表
      continue
    fi
    if [[ "$input" == $'\e' || "$input" == "back" ]]; then return 1; fi
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
    VERSION=$(printf '%s' "$json" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/' || true)
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
  log "下载 gateway v${VERSION} …"
  if ! curl -fL --connect-timeout 10 -m 300 -o "$tmp/$tgz" "$(asset_url)"; then
    rm -rf "$tmp"
    die "下载失败：$(asset_url)（v${VERSION} 可能没有 gateway 资产——gateway 从 0.2.0-beta 起随 release 发布；稳定通道可用 --channel beta 或 --version 精确指定）"
  fi
  log "下载校验和 …"
  if ! curl -fL --connect-timeout 10 -m 30 -o "$tmp/$sha_file" "$(asset_sha_url)"; then
    rm -rf "$tmp"
    die "校验和资产缺失：$(asset_sha_url)（release 应附带 .sha256）"
  fi
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
  if [[ -d "$dst" && ! -L "$dst" ]]; then
    local aside="$dst.mv-t.$$.${RANDOM}"
    if ! mv "$dst" "$aside"; then return 1; fi
    if ! mv "$src" "$dst"; then mv "$aside" "$dst"; return 1; fi
    rm -rf "$aside"
    return 0
  fi
  [[ -e "$dst" || -L "$dst" ]] && rm -f "$dst"
  mv "$src" "$dst"
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
# （与 EnvironmentFile 引号事故同型的无声故障）；把 BASE_DIR 指向 $HOME、
# /tmp、/ 等宽泛根则会被 ensure_private_layout 整体 chmod 700 破坏——gateway
# 侧对 stateDir 有 validateGatewayStateDirPath 同款纪律，安装器必须一致。
validate_base_dir() {
  [[ "$BASE_DIR" == /* ]] \
    || die "BASE_DIR 必须是绝对路径：$BASE_DIR（可用 DSH_CHAMBER_BASE_DIR 指定）"
  case "$BASE_DIR" in
    *%*|*'*'*|*'?'*|*'['*|*']'*) die "BASE_DIR 不能包含 % * ? [ ]（systemd specifier/glob 字符）：$BASE_DIR" ;;
  esac
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
    || die "--service-user 仅支持 systemd 系统服务形态（当前 SERVICE_MODE=$SERVICE_MODE）"
  [[ "$EUID" == "0" ]] || die "--service-user 需要 root 执行（写系统 unit + 移交数据属主）"
  have systemctl || die "--service-user 需要 systemd（未检测到 systemctl）"
  [[ "$SERVICE_USER" =~ ^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$ ]] \
    || die "非法服务用户名（仅限 [A-Za-z0-9_.-]）：$SERVICE_USER"
  id -u "$SERVICE_USER" >/dev/null 2>&1 \
    || die "服务用户不存在：$SERVICE_USER（请先创建：useradd -m -r -s /usr/sbin/nologin $SERVICE_USER）"
}

# 把 BASE_DIR 全部数据移交给服务用户（unit 已有 User=，服务以其身份读写
# gateway.env/配置/版本树/state；root 仍可管理）。幂等，install/update 两线
# 都在重启服务前调用。
apply_service_user_ownership() {
  [[ -n "${SERVICE_USER:-}" ]] || return 0
  log "移交数据目录属主给 $SERVICE_USER …"
  chown -R "$SERVICE_USER" "$BASE_DIR" || die "chown -R $SERVICE_USER $BASE_DIR 失败"
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
  # 抗遍历 + 不保留属主（防恶意 tgz 覆盖任意路径/篡改属主）；旧 tar 不支持
  # 这些标志时降级重试普通解包（release 资产受 .sha256 保护，风险可控）。
  if ! tar --no-same-owner --no-same-permissions --no-absolute-names -xzf "$tgz" -C "$stage" --strip-components=1 2>/dev/null; then
    if ! tar -xzf "$tgz" -C "$stage" --strip-components=1; then
      rm -rf "$stage"
      return 1
    fi
    warn "tar 安全标志不可用（--no-same-owner/--no-absolute-names），已降级为普通解包"
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
  local record identity pid expected extra
  record=$(foreground_record_file)
  [[ -f "$record" ]] || return 0
  # 陈旧记录且进程已死（崩溃/重启后残留）→ 安全清理,不阻塞 install/update/
  # restart/uninstall;仅"存活但身份不符"才拒绝(防 pid 复用误杀)。
  IFS=' ' read -r pid expected extra < "$record" || true
  if [[ "$pid" =~ ^[0-9]+$ ]] && ! kill -0 "$pid" 2>/dev/null; then
    warn "清理陈旧 foreground pid 记录（进程 $pid 已不存在）"
    rm -f "$record"
    return 0
  fi
  identity=$(foreground_identity || true)
  if [[ -z "$identity" ]]; then
    warn "foreground pid 记录身份不匹配，拒绝终止可能无关的进程"
    return 1
  fi
  pid="${identity%%:*}"
  kill "$pid" 2>/dev/null || return 1
  for _ in $(seq 1 10); do
    if [[ "$(process_start_identity "$pid" 2>/dev/null || true)" != "$identity" ]]; then
      rm -f "$record"
      return 0
    fi
    sleep 1
  done
  warn "前台进程未在 10s 内退出，强制终止"
  if [[ "$(process_start_identity "$pid" 2>/dev/null || true)" == "$identity" ]]; then
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
  printf '%s %s\n' "$pid" "$identity" > "$(foreground_record_file)"
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
  if [[ -n "$VERSION" || "$CHANNEL" != "stable" || "$FLAG_VERSION" == "1" ]]; then
    resolve_version
    log "版本已由 --version/--channel 指定：$CHANNEL → $VERSION"
    return 0
  fi
  local choice
  if ! ask_choice choice \
    "gateway 安装包来自 GitHub Releases（下载后 sha256 校验）。选择安装通道：" \
    $'稳定版：最新正式发布（推荐）。\nbeta：预发布版本，尝鲜新功能，可能有变动。\n精确版本：列出所有可用版本供选择，或手动输入（如 0.1.5）。\n离线包：使用已下载的 .tgz 文件（无需网络）。' \
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
      local f=""
      if ! ask_text f "离线包路径" "已下载的 dsh-chamber-gateway-<版本>.tgz 文件的完整路径。" ""; then
        return 1
      fi
      [[ -f "$f" ]] || { printf '\033[1;31m✗ 文件不存在：%s\033[0m\n' "$f"; return 1; }
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
    if [[ -n "$BIND_HOST" ]] && ! valid_bind "$BIND_HOST"; then die "非法 bind host：$BIND_HOST（--bind）"; fi
    if [[ -n "$PUBLIC_ORIGIN" ]] && ! valid_origin "$PUBLIC_ORIGIN"; then die "非法公网 origin：$PUBLIC_ORIGIN（--origin）"; fi
    if [[ -n "$TRUSTED_PROXY" ]] && ! valid_ip_list "$TRUSTED_PROXY"; then die "非法 trusted proxy：$TRUSTED_PROXY（--trusted-proxy）"; fi
    # 只给 origin/proxy 时补 loopback 默认(与交互 proxy 形态一致),避免写出空 host
    if [[ -z "$BIND_HOST" && ( -n "$PUBLIC_ORIGIN" || -n "$TRUSTED_PROXY" ) ]]; then
      BIND_HOST="127.0.0.1"
      log "BIND_HOST 未指定，按 loopback 处理（$BIND_HOST）"
    fi
    return 0
  fi
  local mode=""
  if ! ask_choice mode \
    "别人怎么访问这个 gateway？" \
    $'仅本机：只监听 127.0.0.1，本机浏览器访问，无需登录凭据。\n反向代理：仍监听 127.0.0.1，由 Caddy/Nginx 做 HTTPS 转发（公网推荐形态）。\n直接暴露：监听 0.0.0.0 明文 HTTP，必须设置登录凭据（有安全警告）。\n高级：手动设置 bind/origin/trusted-proxy。' \
    "a" "a) 仅本机使用|loopback" "b) 通过反向代理对外|proxy" "c) 直接暴露到网络|direct" "d) 高级：手动设置|advanced"; then
    return 1
  fi
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
    if [[ -n "$API_TOKEN" && ! "$API_TOKEN" =~ ^[[:print:]]+$ ]]; then
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
      # design 17：--no-auth 是显式覆盖,但交互模式下仍需 YES 二次确认
      # (即便由 flag 提供);-y 非交互由 flag 本身即代表同意。
      if interactive && ! confirm_yes "⚠️  无认证的外部 gateway：任何能访问到该端口的人都可以完全控制这台 gateway 和它托管的 dsh。仅适用于完全可信的网络（内网/隧道）。"; then
        die "已取消（--no-auth 需要输入 YES 确认；可改选密码/Token 后重试）"
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
  if ! ask_choice kind \
    "外部访问必须设置登录凭据。用什么方式登录？" \
    $'密码：浏览器/桌面客户端登录，12-1024 字符。\nToken：程序/API/脚本访问，32-4096 可见 ASCII 字符。\n两者：同时启用，互不遮蔽。\n无需凭据（--no-auth）：仅限完全可信网络，需输入 YES 二次确认。' \
    "a" "a) 密码|password" "b) Token|token" "c) 两者都要|both" "d) 无需凭据（--no-auth）|noauth"; then
    return 1
  fi
  local rc=0
  case "$kind" in
    password|both)
      ask_secret2 UI_PASSWORD "浏览器登录密码" \
        "密码用于浏览器/桌面登录；留空 = 自动生成并显示一次，请立即记录。" 12 1024 || rc=$?
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
        "Token 用于程序/API/脚本访问（32-4096 可见 ASCII）；留空 = 自动生成并显示一次，请立即记录。" 32 4096 || rc=$?
      if (( rc == 1 )); then return 1; fi
      if (( rc == 2 )); then
        API_TOKEN=$(gen_token)
        AUTO_GEN_TOKEN=1
        # 不在生成时显示——后续阶段会清屏;统一在完成页一次性显示
      fi
      ;;
  esac
  if [[ "$kind" == "noauth" ]]; then
    if ! confirm_yes "⚠️  无认证的外部 gateway：任何能访问到该端口的人都可以完全控制这台 gateway 和它托管的 dsh。仅适用于完全可信的网络（内网/隧道）。"; then
      die "已取消（--no-auth 需要输入 YES 确认；可改选密码/Token 后重试）"
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
    valid_port "$GATEWAY_PORT" || die "非法 gateway 端口：$GATEWAY_PORT（--gateway-port）"
    valid_port "$DSH_PORT" || die "非法 dsh 端口：$DSH_PORT（--dsh-port）"
    [[ "$GATEWAY_PORT" != "$DSH_PORT" ]] || die "gateway 端口与 dsh 端口不能相同"
    return 0
  fi
  local def_gw="$DEFAULT_GATEWAY_PORT" def_dsh="$DEFAULT_DSH_PORT"
  if ! port_free 127.0.0.1 "$def_gw"; then
    def_gw=$(suggest_port "$def_gw" || true)
    warn "端口 ${DEFAULT_GATEWAY_PORT} 已被占用，建议使用 ${def_gw}"
  fi
  if ! port_free 127.0.0.1 "$def_dsh"; then
    def_dsh=$(suggest_port "$def_dsh" || true)
    warn "端口 ${DEFAULT_DSH_PORT} 已被占用，建议使用 ${def_dsh}"
  fi
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
    log "服务形态已由 --foreground 指定：$SERVICE_MODE"
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
    log "dsh 锚已指定/复用：$DSH_WS（运行期可在 /chamber/runtime 管理受控版本）"
    return 0
  fi
  if [[ "$SKIP_DSH" == "1" ]]; then
    if [[ -z "${DSH_GATEWAY_DSH_PATH:-}" && -z "$DSH_WS" ]]; then
      die "--skip-dsh 需要显式内建锚（design 18 §9.3）：请提供 --dsh-path <workspace> 或设 DSH_GATEWAY_DSH_PATH，或去掉 --skip-dsh 让脚本自动安装。"
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
    "local" "a) local（推荐）|local" "b) global（npm 全局）|global"; then return 1; fi
  INSTALL_METHOD="$choice"
}

stage8_preview() {
  if ! interactive; then return 0; fi
  stage_header 8 8 "安装预览"
  local cred_desc="无"
  if [[ "$NO_AUTH" == "1" ]]; then
    cred_desc="--no-auth（无认证）"
  else
    local parts=()
    [[ -n "$UI_PASSWORD" ]] && parts+=("密码✓$( [[ $AUTO_GEN_PASSWORD == 1 ]] && printf '(自动生成)' || true )")
    [[ -n "$API_TOKEN" ]] && parts+=("Token✓$( [[ $AUTO_GEN_TOKEN == 1 ]] && printf '(自动生成)' || true )")
    [[ ${#parts[@]} -gt 0 ]] && cred_desc=$(IFS=' '; printf '%s' "${parts[*]}")
  fi
  local access_desc="仅本机"
  [[ -n "$PUBLIC_ORIGIN" ]] && access_desc="反向代理 → $PUBLIC_ORIGIN"
  [[ "$BIND_HOST" == "0.0.0.0" && -z "$PUBLIC_ORIGIN" ]] && access_desc="直接暴露（0.0.0.0）"
  local url="$BIND_HOST:$GATEWAY_PORT"
  [[ -n "$PUBLIC_ORIGIN" ]] && url="$PUBLIC_ORIGIN"
  [[ "$BIND_HOST" == "127.0.0.1" && -z "$PUBLIC_ORIGIN" ]] && url="http://127.0.0.1:$GATEWAY_PORT"
  [[ "$BIND_HOST" == "0.0.0.0" && -z "$PUBLIC_ORIGIN" ]] && url="http://<服务器IP>:$GATEWAY_PORT"
  printf '\n\033[1;36m%s\033[0m\n' "安装预览"
  printf '  安装包   : %s%s\n' "$VERSION" "$([[ "$CHANNEL" == "beta" ]] && printf '（beta 通道）' || true)"
  printf '  访问方式 : %s\n' "$access_desc"
  printf '  登录凭据 : %s\n' "$cred_desc"
  printf '  端口     : 对外 %s / dsh 内部 %s\n' "$GATEWAY_PORT" "$DSH_PORT"
  printf '  服务方式 : %s\n' "$SERVICE_MODE"
  printf '  dsh 版本 : %s%s\n' "${DSH_VER:-$DSH_CHAMBER_DSH_VERSION}" "$([[ -n "$npm_mirror" ]] && printf '（npm 源: %s）' "$npm_mirror" || true)"
  printf '  安装位置 : %s\n' "$INSTALL_METHOD"
  printf '\n\033[1m将写入：\033[0m\n'
  printf '  %s/          程序版本树与配置\n' "$GATEWAY_DIR"
  printf '  %s          凭据文件（0600）\n' "$ENV_FILE"
  printf '  %s          本地命令目录\n' "$LOCAL_BIN_DIR"
  if [[ -f "$CONF_FILE" ]]; then
    printf '\n\033[1;33m注意：检测到已有安装，将原地复用数据并覆盖配置（全新安装请先 uninstall --purge）。\033[0m\n'
  fi
  printf '  访问地址   : %s\n' "$url"
  if [[ "$NO_AUTH" == "1" ]]; then
    printf '\n\033[1;31m⚠  无认证外部绑定：任何能访问该端口的人都可以完全控制。\033[0m\n'
  fi
  printf '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
  if ! confirm "确认执行？" "y"; then die "已取消——未做任何修改，可随时重新运行"; fi
}

# 阶段 0 欢迎页（仅交互）：这是什么 / 装哪 / 得到什么 / 操作说明 / 安全承诺
wizard_welcome() {
  if ! interactive; then return 0; fi
  wiz_clear
  printf '\n\033[1;36m%s\033[0m\n' "dsh-chamber Gateway 安装向导"
  printf '  将要安装: gateway —— 登录门户 + dsh（AI 助手）运行时管理器\n'
  printf '  安装位置: %s\n' "$BASE_DIR"
  printf '  安装后可用: install-gateway.sh status | logs | restart | update | uninstall\n'
  printf '\n操作说明: 回车 = 接受默认值; 输入 = 修改; q = 退出; ESC 或 back = 返回上一步。\n'
  printf '在最后一步确认之前,本向导不会修改系统上的任何文件,可随时安全退出。\n\n'
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

  # 3) 安装方式
  if [[ "$INSTALL_METHOD" == "global" ]]; then
    have npm || die "npm 不可用（npm 全局安装需要 npm）"
    log "npm 全局安装 gateway v${VERSION} …"
    npm install -g "$tgz_src"
    have gateway || die "npm 全局安装后 gateway 不在 PATH"
  else
    log "本地安装到 $GATEWAY_DIR/versions/${VERSION} …"
    if [[ -e "$VERSIONS_DIR/${VERSION}" || -L "$VERSIONS_DIR/${VERSION}" ]]; then
      [[ "$VERSION" != "local" ]] \
        || die "离线版本目录已存在，无法证明新 tgz 与旧 local 树相同，拒绝静默复用：$VERSIONS_DIR/${VERSION}"
      local existing_version
      existing_version=$(gateway_tree_version "$VERSIONS_DIR/${VERSION}" || true)
      [[ -n "$existing_version" && ( "$VERSION" == "local" || "$existing_version" == "$VERSION" ) ]] \
        || die "既有 gateway 版本目录无法验证，拒绝 tar overlay：$VERSIONS_DIR/${VERSION}"
      log "复用已验证的不可变 gateway 版本树：$VERSIONS_DIR/${VERSION}"
    else
      stage_local_version "$tgz_src" "$VERSION" || die "本地 gateway 资产 staging/校验失败"
    fi
    switch_local_current "$VERSIONS_DIR/${VERSION}" || die "切换 gateway/current 失败"
    mkdir -p "$LOCAL_BIN_DIR"
    cat > "$LOCAL_BIN_DIR/gateway" <<EOF
#!/usr/bin/env bash
exec node "$GATEWAY_DIR/current/dist/cli.js" "\$@"
EOF
    chmod +x "$LOCAL_BIN_DIR/gateway"
  fi

  # 4) 配置落盘
  write_config
  write_env
  # 5) 服务（--service-user：属主先移交，unit 带 User= 启动后即可读写）
  apply_service_user_ownership
  local previous_identity
  previous_identity=$(launch_identity || true)
  if [[ "$SERVICE_MODE" == "foreground" ]] || ! have systemctl; then
    SERVICE_MODE="foreground"
    if [[ -f "$(foreground_record_file)" ]]; then
      stop_foreground || die "已有 foreground pid 身份不可验证，拒绝覆盖/终止其他进程"
    fi
    start_foreground "$([[ "$VERSION" == "local" ]] && printf '' || printf '%s' "$VERSION")" "$previous_identity" \
      || die "前台启动失败（见 ${BASE_DIR}/run/gateway.log）"
  else
    write_unit || die "systemd unit 写入/daemon-reload/enable 失败"
    restart_service || die "gateway 服务启动/重启失败"
    health_wait "$GATEWAY_PORT" 30 "$([[ "$VERSION" == "local" ]] && printf '' || printf '%s' "$VERSION")" "$previous_identity" \
      || die "gateway 启动后未通过版本与新进程健康检查（journalctl -u dsh-chamber-gateway）"
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
    if ! ask_choice choice "是否把 $LOCAL_BIN_DIR 加入 PATH？" \
      "写入 ${rc}（幂等不重复追加），之后可直接使用 gateway 与 install-gateway.sh 命令。

不写入：之后用全路径 $LOCAL_BIN_DIR/gateway 调用。" \
      "a" "a) 写入 ${rc}（推荐）|write" "b) 不写入，用全路径|skip"; then
      choice="skip"
    fi
  fi
  if [[ "$choice" == "write" ]]; then
    if [[ -f "$rc" ]] && grep -qF "$line" "$rc" 2>/dev/null; then
      log "PATH 已存在于 ${rc}（跳过）"
    else
      printf '%s\n' "$line" >> "$rc"
      log "已追加到 ${rc}；重新登录终端（或 source ${rc}）后可直接使用 gateway"
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
  fi
  printf '\n\033[1;36m安装完成\033[0m\n'
  printf '  访问地址 : %s %s\n' "$url" "$url_hint"
  if [[ -n "$PUBLIC_ORIGIN" ]]; then
    printf '  提醒     : 请确认反向代理已把 %s 转发到 127.0.0.1:%s（HTTPS 由反代提供）\n' "$PUBLIC_ORIGIN" "$GATEWAY_PORT"
  fi
  if [[ "$NO_AUTH" != "1" && ( -n "$UI_PASSWORD" || -n "$API_TOKEN" ) ]]; then
    printf '  登录方式 : %s%s%s\n' \
      "$([[ -n "$UI_PASSWORD" ]] && printf '密码' || true)" \
      "$([[ -n "$UI_PASSWORD" && -n "$API_TOKEN" ]] && printf ' + ' || true)" \
      "$([[ -n "$API_TOKEN" ]] && printf 'Token' || true)"
    printf '  凭据文件 : %s（0600）\n' "$ENV_FILE"
  fi
  # 自复制成功(普通文件形态)才宣传固定路径;curl | bash 管道形态下脚本
  # 未复制,提示保留当前脚本即可。
  if [[ -f "$0" && ! -L "$0" ]] && grep -q 'SUBCOMMAND="install"' "$0" 2>/dev/null; then
    printf '  管理命令 : %s/bin/install-gateway.sh status | logs | restart | update | uninstall\n' "$BASE_DIR"
  else
    printf '  管理命令 : 保留当前脚本文件，运行 ./install-gateway.sh status | logs | restart | update | uninstall\n'
  fi
  printf '  切换 dsh 版本 : 登录后打开 /chamber/runtime（安装/切换/回滚，无需重装）\n'
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
  [[ -f "$ENV_FILE" ]] || return 1
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
  if [[ ! -O "$CONF_FILE" ]]; then
    die "安装配置不属于当前用户，拒绝加载（可能被篡改）：$CONF_FILE"
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
      [[ "$read_status" == "1" || "$read_status" == "3" ]] \
        || die "gateway.env 格式损坏，拒绝猜测 foreground 密码"
    fi
  fi
  if [[ "$has_token" == "0" ]]; then
    if capture_systemd_env_value DSH_GATEWAY_TOKEN; then
      API_TOKEN="$SYSTEMD_ENV_VALUE"
    else
      read_status=$?
      [[ "$read_status" == "1" || "$read_status" == "3" ]] \
        || die "gateway.env 格式损坏，拒绝猜测 foreground token"
    fi
  fi
  if [[ "$has_env_anchor" == "0" ]]; then
    if capture_systemd_env_value DSH_GATEWAY_DSH_PATH; then
      DSH_WS="$SYSTEMD_ENV_VALUE"
      ENV_ANCHOR=1
    else
      read_status=$?
      if [[ "$read_status" == "1" || "$read_status" == "3" ]]; then
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
  if [[ "$SERVICE_MODE" == "foreground" ]]; then
    local identity
    identity=$(foreground_identity || true)
    if [[ -n "$identity" ]]; then
      printf '状态: 前台运行中（boot %s）\n' "$identity"
    else
      printf '状态: 未运行\n'
    fi
  else
    if [[ "$SERVICE_MODE" == "user" ]]; then
      systemctl --user status dsh-chamber-gateway --no-pager 2>&1 | head -5 || true
    else
      systemctl status dsh-chamber-gateway --no-pager 2>&1 | head -5 || true
    fi
  fi
  curl -fsS -m 3 "http://127.0.0.1:${GATEWAY_PORT}/health" 2>/dev/null && printf '\n健康: OK\n' || printf '\n健康: 不可达\n'
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
    tail -f "${BASE_DIR}/run/gateway.log"
  elif [[ "$SERVICE_MODE" == "user" ]]; then
    journalctl --user -u dsh-chamber-gateway -f
  else
    journalctl -u dsh-chamber-gateway -f
  fi
}

cmd_restart() {
  load_conf
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
      || die "gateway 重启后未通过版本与新进程健康检查（journalctl -u dsh-chamber-gateway）"
  fi
  log "gateway 已重启"
}

cmd_update() {
  # 私有布局与 install 一致收敛 0700（update 不重走向导，单独补齐）。
  ensure_private_layout
  # Preserve the caller's requested target before gateway.conf restores the
  # installed VERSION. An explicit --version must not silently become latest.
  local requested_version="$VERSION"
  load_conf
  validate_service_user
  log "当前版本：$VERSION"
  local old_version="$VERSION"
  if [[ -n "$OFFLINE_TGZ" ]]; then
    die "update 不支持离线模式；离线请用 install（先卸载）"
  fi
  VERSION="$requested_version"
  resolve_version
  if [[ "$VERSION" == "$old_version" ]]; then
    log "已是最新版本 $VERSION"
    return 0
  fi
  local target_version="$VERSION"
  log "升级到 $target_version …"
  local old_identity
  old_identity=$(launch_identity || true)
  if [[ "$SERVICE_MODE" == "foreground" && -f "$(foreground_record_file)" && -z "$old_identity" ]]; then
    die "foreground pid 身份不可验证，拒绝终止可能无关的进程"
  fi
  if [[ "$SERVICE_MODE" != "foreground" ]] \
    && systemctl_for_mode is-active --quiet dsh-chamber-gateway.service \
    && [[ -z "$old_identity" ]]; then
    die "运行中的 systemd gateway 缺少可验证启动身份，拒绝以通用 /health 猜测升级成功"
  fi
  if interactive && ! confirm "确认升级到 $target_version？（失败自动回滚到 $old_version）" "y"; then
    die "已取消——未做任何修改"
  fi
  download_verify "$GATEWAY_DIR"

  local target_tgz="$GATEWAY_DIR/dsh-chamber-gateway-${target_version}.tgz"
  local old_tgz="$GATEWAY_DIR/dsh-chamber-gateway-${old_version}.tgz"
  local old_local_target="" new_local_target=""
  if [[ "$INSTALL_METHOD" == "global" ]]; then
    # A global npm install mutates in place. Secure an exact rollback artifact
    # before touching it; otherwise this cannot honestly be called a
    # transaction.
    [[ "$old_version" != "local" ]] || die "旧版本来自未归档离线包，无法构造可靠回滚；请先重新 install 并保留版本资产"
    # Re-fetch and verify the exact rollback release before mutating the
    # global npm tree. A stale/tampered cached tgz is not transaction proof.
    VERSION="$old_version"
    download_verify "$GATEWAY_DIR"
    VERSION="$target_version"
  else
    [[ -L "$GATEWAY_DIR/current" ]] || die "local 安装的 gateway/current 必须是符号链接，拒绝不确定升级"
    old_local_target=$(readlink "$GATEWAY_DIR/current")
    [[ -d "$old_local_target" ]] || die "gateway/current 指向不存在的旧版本：$old_local_target"
    local old_tree_version
    old_tree_version=$(gateway_tree_version "$old_local_target" || true)
    [[ -n "$old_tree_version" && ( "$old_version" == "local" || "$old_tree_version" == "$old_version" ) ]] \
      || die "gateway/current 旧版本身份与配置不匹配：期望 ${old_version}，得到 ${old_tree_version:-未知}"
    new_local_target="$VERSIONS_DIR/$target_version"
    stage_local_version "$target_tgz" "$target_version" || die "新版本 staging/身份校验失败；旧版本未改动"
  fi

  if [[ "$SERVICE_MODE" == "foreground" ]]; then
    if [[ -f "$(foreground_record_file)" ]]; then
      if ! stop_foreground; then
        [[ -z "$new_local_target" ]] || rm -rf "$new_local_target"
        die "无法安全停止旧 foreground gateway"
      fi
    fi
  fi

  local failure_reason=""
  if [[ "$INSTALL_METHOD" == "global" ]]; then
    npm install -g "$target_tgz" || failure_reason="npm 安装新版本失败"
  else
    switch_local_current "$new_local_target" || failure_reason="原子切换 gateway/current 失败"
  fi

  if [[ -z "$failure_reason" ]]; then
    if [[ "$SERVICE_MODE" == "foreground" ]]; then
      start_foreground "$target_version" "$old_identity" || failure_reason="新 foreground 进程未通过版本/启动身份健康检查"
    else
      write_unit || failure_reason="systemd unit 写入/daemon-reload/enable 失败"
      if [[ -z "$failure_reason" ]]; then
        apply_service_user_ownership
      fi
      if [[ -z "$failure_reason" ]]; then
        restart_service || failure_reason="systemd restart 失败"
      fi
      if [[ -z "$failure_reason" ]] && ! health_wait "$GATEWAY_PORT" 30 "$target_version" "$old_identity"; then
        failure_reason="新 service 未通过目标版本/启动身份健康检查"
      fi
    fi
  fi

  if [[ -z "$failure_reason" ]]; then
    VERSION="$target_version"
    write_config || failure_reason="提交安装配置失败"
    apply_service_user_ownership
  fi

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
    VERSION="$old_version"
    if [[ "$SERVICE_MODE" == "foreground" ]]; then
      start_foreground "$rollback_expected_version" "$rollback_previous" || rollback_ok=0
    else
      write_unit || rollback_ok=0
      apply_service_user_ownership || rollback_ok=0
      restart_service || rollback_ok=0
      health_wait "$GATEWAY_PORT" 20 "$rollback_expected_version" "$rollback_previous" || rollback_ok=0
    fi
    if [[ "$INSTALL_METHOD" == "local" && -n "$new_local_target" && "$local_pointer_restored" == "1" ]]; then
      rm -rf "$new_local_target"
    fi
    if [[ "$rollback_ok" == "1" ]]; then
      die "升级失败，已回滚到 ${old_version}：$failure_reason"
    fi
    die "升级失败且回滚未完全成功，请人工介入：$failure_reason"
  fi

  log "已升级到 $target_version"
}

cmd_uninstall() {
  load_conf
  if [[ "$NONINTERACTIVE" == "1" ]]; then
    :  # -y 显式放行（脚本化卸载）
  elif ! confirm "确认卸载 gateway（保留 state，--purge 才删 dsh-runtime/ 与 dsh-home/）？" "n"; then
    die "已取消"
  fi
  if [[ "$SERVICE_MODE" == "foreground" ]]; then
    if [[ -f "$(foreground_record_file)" ]]; then
      stop_foreground || die "foreground pid 身份不可验证；为避免终止无关进程，卸载已中止"
    fi
  elif [[ "$SERVICE_MODE" == "user" ]]; then
    systemctl --user disable --now dsh-chamber-gateway 2>/dev/null || true
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/dsh-chamber-gateway.service"
  else
    systemctl disable --now dsh-chamber-gateway 2>/dev/null || true
    rm -f /etc/systemd/system/dsh-chamber-gateway.service
  fi
  if [[ "$INSTALL_METHOD" == "global" ]]; then
    npm uninstall -g @dsh-chamber/gateway 2>/dev/null || true
  fi
  # 凭据文件一律删除（活凭据不随卸载保留）；state 数据是否保留由 PURGE 决定。
  rm -f "$CONF_FILE" "$ENV_FILE"
  # 非 purge 卸载仍清掉指向已删程序文件的启动器与运行期痕迹（state 保留）。
  rm -f "${BASE_DIR}/bin/gateway" 2>/dev/null || true
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
    exit 0
  fi
  awk 'NR>=2 { if ($0=="set -euo pipefail") exit; sub(/^# ?/, ""); print }' "$0"
  exit 0
}

SUBCOMMAND="install"
while [[ $# -gt 0 ]]; do
  case "$1" in
    install|update|restart|status|logs|uninstall|help|-h|--help) SUBCOMMAND="$1"; shift ;;
    -y|--yes) NONINTERACTIVE=1; shift ;;
    --version) VERSION="${2:?--version 需要值}"; FLAG_VERSION=1; shift 2 ;;
    --channel) CHANNEL="${2:?--channel 需要值}"; FLAG_VERSION=1
      [[ "$CHANNEL" == "stable" || "$CHANNEL" == "beta" ]] || die "非法安装通道：$CHANNEL（仅 stable | beta）"
      shift 2 ;;
    --tgz) OFFLINE_TGZ="${2:?--tgz 需要值}"; FLAG_VERSION=1; shift 2 ;;
    --gateway-port) GATEWAY_PORT="${2:?--gateway-port 需要值}"; FLAG_PORTS=1; shift 2 ;;
    --dsh-port) DSH_PORT="${2:?--dsh-port 需要值}"; FLAG_PORTS=1; shift 2 ;;
    --dsh-path) DSH_WS="${2:?--dsh-path 需要值}"; DSH_FOUND="explicit"; shift 2 ;;
    --bind) BIND_HOST="$2"; FLAG_ACCESS=1; shift 2 ;;
    --origin) PUBLIC_ORIGIN="${2:?--origin 需要值}"; FLAG_ACCESS=1; shift 2 ;;
    --trusted-proxy) TRUSTED_PROXY="${2:?--trusted-proxy 需要值}"; FLAG_ACCESS=1; shift 2 ;;
    --ui-password) UI_PASSWORD="${2:?--ui-password 需要值}"; FLAG_CRED=1; shift 2 ;;
    --api-token) API_TOKEN="${2:?--api-token 需要值}"; FLAG_CRED=1; shift 2 ;;
    --no-auth) NO_AUTH=1; FLAG_CRED=1; shift ;;
    --local) INSTALL_METHOD="local"; FLAG_INSTALL=1; shift ;;
    --service-user) SERVICE_USER="${2:?--service-user 需要值}"; shift 2 ;;
    --foreground) SERVICE_MODE="foreground"; shift ;;
    --skip-dsh) SKIP_DSH=1; shift ;;
    --purge) PURGE=1; shift ;;
    *) die "未知选项：$1（--help 查看用法）" ;;
  esac
done

# --purge 只对 uninstall 有意义:提前拒绝,避免静默无效
if [[ "${PURGE:-0}" == "1" && "$SUBCOMMAND" != "uninstall" ]]; then
  die "--purge 仅用于 uninstall 子命令（$SUBCOMMAND 忽略该选项）"
fi

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
