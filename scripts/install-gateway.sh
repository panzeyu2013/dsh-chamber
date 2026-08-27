#!/usr/bin/env bash
# ============================================================================
# dsh-chamber Gateway 一键安装器（design 17 服务器部署 + design 18 运行时管理）
#
# 用途：从 GitHub release 拉取 gateway 包（npm 未发布也能装），交互式确认
# 每个配置（默认值合理、全部可改、非交互 -y 供 CI），探测/安装 dsh，
# 生成 systemd 单元（root）或 systemctl --user / 前台（非 root），
# 提供 install / update / status / logs / uninstall 管理子命令。
#
# dsh 定位（design 18 §9）：脚本安装的 npm 全局 dsh 是 gateway 的
# 「内建/回退锚」（经 --dsh-path / DSH_GATEWAY_DSH_PATH 提供给 gateway）。
# 安装完成后 dsh 版本可在 gateway 的 /chamber/ 页面（或 /chamber/runtime API）
# 运行期管理（安装/切换/回滚）；运行时状态与版本树位于 DSH_GATEWAY_STATE
# （默认 ${BASE_DIR}/gateway/data）下的 dsh-runtime/ 目录。
#
# 端口模型（服务器部署默认，均可改）：
#   gateway 监听  :30801   （--port / DSH_GATEWAY_PORT）
#   托管 dsh 监听 :30800   （--dsh-port / DSH_GATEWAY_DSH_PORT，spawn-dsh 基口）
#
# 用法：
#   install-gateway.sh [install] [选项]     安装（默认子命令）
#   install-gateway.sh update [--version X] 升级（保留配置，失败自动回滚）
#   install-gateway.sh status|logs|uninstall
#   选项：-y/--yes 非交互（用默认值+flags）；--version V 精确 pin；
#         --channel beta 预发布通道；--tgz FILE 离线本地包；
#         --gateway-port N --dsh-port N --dsh-path DIR --skip-dsh
#         --origin URL --trusted-proxy IP --ui-password P --api-token T
#         --no-auth --local --foreground --purge
# ============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# 常量（发布 checklist 锁定：dsh 版本变更必须同步这里与 release.yml）
# DSH_CHAMBER_DSH_VERSION 是「内建/回退锚」默认版本（design 18 §9）：运行期
# 可经 /chamber/runtime 切换，此常量仅决定本脚本安装的锚版本。
# ---------------------------------------------------------------------------
DSH_CHAMBER_DSH_VERSION="${DSH_CHAMBER_DSH_VERSION:-0.1.1-rc.2}"
GITHUB_REPO="${DSH_CHAMBER_GITHUB_REPO:-panzeyu2013/dsh-chamber}"
BASE_DIR="${DSH_CHAMBER_BASE_DIR:-$HOME/.dsh-chamber}"
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
GATEWAY_PORT=""
DSH_PORT=""
BIND_HOST=""
PUBLIC_ORIGIN=""
TRUSTED_PROXY=""
UI_PASSWORD=""
API_TOKEN=""
NO_AUTH=0
INSTALL_METHOD="global"        # global | local
SERVICE_MODE="auto"            # systemd | user | foreground
SKIP_DSH=0
DSH_FOUND=""
DSH_WS=""
DSH_VER=""
ENV_ANCHOR=0        # 锚来自用户显式 DSH_GATEWAY_DSH_PATH（env 恒最高，仅此时才写回 env）
npm_mirror=""

log()  { printf '\033[1;34m[gateway]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[gateway]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[gateway]\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# 交互工具
# ---------------------------------------------------------------------------
# prompt VAR 提示语 默认值 —— 回车接受默认，输入即覆盖；非交互时直接默认
prompt() {
  local var="$1" label="$2" def="${3:-}"
  local cur=""
  eval "cur=\${$var:-}"
  # 已通过命令行 flag 提供的值优先作为默认（用户仍可在交互中修改）
  [[ -n "$cur" ]] && def="$cur"
  if [[ "$NONINTERACTIVE" == "1" || ! -t 0 ]]; then
    eval "$var='$def'"
    return 0
  fi
  local input
  if [[ -n "$def" ]]; then
    printf '%s [\033[1m%s\033[0m]: ' "$label" "$def"
  else
    printf '%s: ' "$label"
  fi
  IFS= read -r input || true
  if [[ "${input:-}" == "q" ]]; then die "已退出（q）"; fi
  eval "$var='${input:-$def}'"
}

# prompt_secret VAR 提示语 —— 隐藏输入（stty 不可用时警告后明文）
prompt_secret() {
  local var="$1" label="$2"
  if [[ "$NONINTERACTIVE" == "1" || ! -t 0 ]]; then
    warn "非交互模式：凭据需通过 --ui-password/--api-token 显式提供"
    eval "$var=''"
    return 0
  fi
  local input=""
  printf '%s: ' "$label"
  if have stty; then
    stty -echo
    IFS= read -r input || true
    stty echo
    printf '\n'
  else
    warn "stty 不可用，输入将明文回显"
    IFS= read -r input || true
  fi
  if [[ "${input:-}" == "q" ]]; then die "已退出（q）"; fi
  eval "$var='$input'"
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
  local base="$1" p="$base"
  while ! port_free 127.0.0.1 "$p"; do p=$((p + 1)); done
  printf '%s' "$p"
}

# ---------------------------------------------------------------------------
# 版本/资产解析（GitHub Releases API）
# ---------------------------------------------------------------------------
github_api() {
  curl -fsSL --connect-timeout 10 -m 30 "$1" 2>/dev/null || return 1
}

resolve_version() {
  if [[ -n "$OFFLINE_TGZ" ]]; then
    VERSION="local"
    return 0
  fi
  if [[ -n "$VERSION" ]]; then
    VERSION="${VERSION#v}"                      # 允许带 v 前缀
    return 0
  fi
  if [[ "$CHANNEL" == "beta" ]]; then
    # 最新预发布
    local json
    json=$(github_api "https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10") \
      || die "无法访问 GitHub Releases API（可设 HTTPS_PROXY 代理）"
    VERSION=$(printf '%s' "$json" | tr -d '\n' | sed 's/},{/}\n{/g' | grep '"prerelease": *true' | head -1 | grep -o '"tag_name": *"v[^"]*"' | sed 's/.*"v\([^"]*\)".*/\1/')
    [[ -n "$VERSION" ]] || die "未找到 beta 预发布版本（prerelease）"
  else
    local json
    json=$(github_api "https://api.github.com/repos/${GITHUB_REPO}/releases/latest") \
      || die "无法访问 GitHub Releases API（可设 HTTPS_PROXY 代理）"
    VERSION=$(printf '%s' "$json" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/')
    [[ -n "$VERSION" ]] || die "未找到最新 release"
  fi
}

asset_url() { printf 'https://github.com/%s/releases/download/v%s/%s-%s.tgz' "$GITHUB_REPO" "$VERSION" "$ASSET_PREFIX" "$VERSION"; }
asset_sha_url() { printf '%s.sha256' "$(asset_url)"; }

# ---------------------------------------------------------------------------
# 下载 + sha256 校验
# ---------------------------------------------------------------------------
download_verify() {
  local dest_dir="$1"
  local url sha_url tmp tgz sha_file
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  log "下载 gateway v${VERSION} …"
  if ! curl -fL --connect-timeout 10 -m 300 -o "$tmp/gateway.tgz" "$(asset_url)"; then
    rm -rf "$tmp"
    die "下载失败：$(asset_url)（v${VERSION} 可能没有 gateway 资产——gateway 从 0.2.0-beta 起随 release 发布；稳定通道可用 --channel beta 或 --version 精确指定）"
  fi
  log "下载校验和 …"
  if ! curl -fL --connect-timeout 10 -m 30 -o "$tmp/gateway.tgz.sha256" "$(asset_sha_url)"; then
    rm -rf "$tmp"
    die "校验和资产缺失：$(asset_sha_url)（release 应附带 .sha256）"
  fi
  ( cd "$tmp" && sha256sum -c gateway.tgz.sha256 >/dev/null 2>&1 ) || {
    rm -rf "$tmp"
    die "sha256 校验失败：下载包与 release 资产不一致，已中止（现场保留于 $tmp 之外）"
  }
  mkdir -p "$dest_dir"
  mv "$tmp/gateway.tgz" "$dest_dir/dsh-chamber-gateway-${VERSION}.tgz"
  rm -rf "$tmp"
}

# ---------------------------------------------------------------------------
# dsh 探测 / 安装
# ---------------------------------------------------------------------------
detect_dsh() {
  # 用户显式 --dsh-path 优先，跳过探测
  if [[ "$DSH_FOUND" == "explicit" ]]; then
    [[ -e "$DSH_WS/node_modules/@deepseek-ai/dsh/lib/bin.js" || -e "$DSH_WS/node_modules/@deepseek-ai/dsh/apps/cli/src/bin.ts" ]] || die "--dsh-path 缺少 node_modules/@deepseek-ai/dsh：$DSH_WS"
    return 0
  fi
  DSH_WS=""
  DSH_FOUND=""
  # env 锚（design 18 §9.3 解析链恒最高）：无 --dsh-path 时捕获
  # DSH_GATEWAY_DSH_PATH 作为锚，避免 write_env 覆写成空串。
  if [[ -n "${DSH_GATEWAY_DSH_PATH:-}" ]]; then
    DSH_WS="$DSH_GATEWAY_DSH_PATH"
    DSH_FOUND="env"
    ENV_ANCHOR=1
    return 0
  fi
  if [[ "$SKIP_DSH" == "1" ]]; then return 0; fi
  local root
  if have dsh; then
    root=$(npm root -g 2>/dev/null || true)
    if [[ -n "$root" && ( -e "$root/@deepseek-ai/dsh/lib/bin.js" || -e "$root/@deepseek-ai/dsh/apps/cli/src/bin.ts" ) ]]; then
      DSH_WS="$root"
      DSH_FOUND="global"
      return 0
    fi
    DSH_FOUND="path"      # 有 dsh 但无法定位 workspace，交向导处理
    return 0
  fi
  if have npm; then
    root=$(npm root -g 2>/dev/null || true)
    if [[ -n "$root" && ( -e "$root/@deepseek-ai/dsh/lib/bin.js" || -e "$root/@deepseek-ai/dsh/apps/cli/src/bin.ts" ) ]]; then
      DSH_WS="$root"
      DSH_FOUND="global"
      return 0
    fi
  fi
  return 0
}

verify_dsh() {
  local ws="$1"
  [[ -e "$ws/node_modules/@deepseek-ai/dsh/lib/bin.js" || -e "$ws/node_modules/@deepseek-ai/dsh/apps/cli/src/bin.ts" ]] || return 1
  local ver
  ver=$(node "$ws/node_modules/@deepseek-ai/dsh/lib/bin.js" --version 2>/dev/null | head -1 || true)
  printf '%s' "$ver"
}

install_dsh() {
  local target_version="$1"
  log "安装 dsh 内建锚 @${target_version}（npm 全局）…"
  local registry
  registry=$(npm config get registry 2>/dev/null || printf 'https://registry.npmjs.org')
  if [[ -n "$npm_mirror" ]]; then registry="$npm_mirror"; fi
  log "使用 npm 镜像：$registry"
  if ! npm install -g "@deepseek-ai/dsh@${target_version}" --registry "$registry"; then
    die "dsh 安装失败（若为构建脚本错误，请确认服务器有 make/g++/python3，或改用带 prebuild 的平台）"
  fi
  DSH_WS=$(npm root -g 2>/dev/null || true)
  local ver
  ver=$(verify_dsh "$DSH_WS" || true)
  [[ -n "$ver" ]] || die "dsh 安装后验证失败：$DSH_WS"
  log "dsh 内建锚就绪：$ver（$DSH_WS）"
}

# ---------------------------------------------------------------------------
# 配置落盘
# ---------------------------------------------------------------------------

# 配置落盘（printf %q 安全引用：bash source 与 systemd EnvironmentFile 均兼容）
write_config() {
  mkdir -p "$GATEWAY_DIR"
  umask 077
  {
    printf '# dsh-chamber gateway 安装配置（install-gateway.sh 生成，0600）\n'
    printf 'VERSION=%q\n' "$VERSION"
    printf 'INSTALL_METHOD=%q\n' "$INSTALL_METHOD"
    printf 'GATEWAY_PORT=%q\n' "$GATEWAY_PORT"
    printf 'DSH_PORT=%q\n' "$DSH_PORT"
    printf 'BIND_HOST=%q\n' "$BIND_HOST"
    printf 'PUBLIC_ORIGIN=%q\n' "$PUBLIC_ORIGIN"
    printf 'TRUSTED_PROXY=%q\n' "$TRUSTED_PROXY"
    printf 'SERVICE_MODE=%q\n' "$SERVICE_MODE"
    printf 'DSH_WS=%q\n' "$DSH_WS"
    printf 'NO_AUTH=%q\n' "$NO_AUTH"
  } > "$CONF_FILE"
  chmod 600 "$CONF_FILE"
}

# 服务环境落盘（EnvironmentFile 引用，0600）。DSH_GATEWAY_STATE 指向的 state
# 目录承载 design 18 运行时状态：dsh-runtime/（版本树、current 指针、快照）与
# dsh-home/（会话数据），gateway 启动相位收敛为 0700；普通 uninstall 保留，
# 仅 --purge 删除。
write_env() {
  umask 077
  {
    printf '# dsh-chamber gateway 服务环境（EnvironmentFile 引用，0600）\n'
    printf 'DSH_GATEWAY_PORT=%q\n' "$GATEWAY_PORT"
    printf 'DSH_GATEWAY_DSH_PORT=%q\n' "$DSH_PORT"
    printf 'DSH_GATEWAY_HOST=%q\n' "$BIND_HOST"
    printf '# state 目录：dsh-runtime/（版本树/快照）+ dsh-home/（会话数据），仅 --purge 删除\n'
    printf 'DSH_GATEWAY_STATE=%q\n' "${BASE_DIR}/gateway/data"
    # 锚默认走 --dsh-path（内建/回退锚，运行期可切换）；仅当用户显式以
    # DSH_GATEWAY_DSH_PATH 提供（env 恒最高）时才写回 env 行，否则写 env 会
    # 把实例永久钉在 env 源、静默禁用版本切换/回滚（design 18 §9.3）。
    if [[ -n "$DSH_WS" && "$ENV_ANCHOR" == "1" ]]; then
      printf 'DSH_GATEWAY_DSH_PATH=%q\n' "$DSH_WS"
    fi
    if [[ -n "$PUBLIC_ORIGIN" ]]; then
      printf 'DSH_GATEWAY_PUBLIC_ORIGIN=%q\n' "$PUBLIC_ORIGIN"
    fi
    if [[ -n "$TRUSTED_PROXY" ]]; then
      printf 'DSH_GATEWAY_TRUSTED_PROXIES=%q\n' "$TRUSTED_PROXY"
    fi
    if [[ "$NO_AUTH" != "1" ]]; then
      if [[ -n "$UI_PASSWORD" ]]; then
        printf 'DSH_GATEWAY_PASSWORD=%q\n' "$UI_PASSWORD"
      fi
      if [[ -n "$API_TOKEN" ]]; then
        printf 'DSH_GATEWAY_TOKEN=%q\n' "$API_TOKEN"
      fi
    fi
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}


gateway_exec() {
  if [[ "$INSTALL_METHOD" == "global" ]]; then
    printf 'gateway'
  else
    printf '%s/gateway' "$LOCAL_BIN_DIR"
  fi
}

# 内建锚参数（--dsh-path，非 env）：解析链中为「内建/回退锚」，运行期可经
# /chamber/runtime 切换。ENV_ANCHOR=1（用户显式 env）时锚已由 env 提供。
anchor_args() {
  if [[ -n "$DSH_WS" && "$ENV_ANCHOR" != "1" ]]; then
    printf ' --dsh-path %q' "$DSH_WS"
  fi
}

write_unit() {
  local unit_name="dsh-chamber-gateway.service"
  local exec_path
  exec_path=$(gateway_exec)
  local unit_file
  if [[ "$SERVICE_MODE" == "user" ]]; then
    mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    unit_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${unit_name}"
  else
    unit_file="/etc/systemd/system/${unit_name}"
  fi
  local content
  content=$(cat <<EOF
[Unit]
Description=dsh-chamber gateway (design 17 server shape)
After=network.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
ExecStart=${exec_path} serve$(anchor_args)
Restart=on-failure
RestartSec=3

[Install]
WantedBy=${SERVICE_MODE}${SERVICE_MODE:+.target}
EOF
  )
  if [[ "$SERVICE_MODE" == "user" ]]; then
    content="${content//WantedBy=user.target/WantedBy=default.target}"
  fi
  printf '%s\n' "$content" > "$unit_file"
  chmod 644 "$unit_file"
  if [[ "$SERVICE_MODE" == "user" ]]; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    systemctl --user enable "$unit_name" >/dev/null 2>&1 || true
    systemctl --user start "$unit_name" >/dev/null 2>&1 || true
  else
    systemctl daemon-reload >/dev/null 2>&1 || die "systemctl daemon-reload 失败（是否 root？）"
    systemctl enable "$unit_name" >/dev/null 2>&1 || true
    systemctl start "$unit_name" >/dev/null 2>&1 || true
  fi
  UNIT_NAME="$unit_name"
}

health_wait() {
  local port="$1" tries="${2:-30}"
  log "等待 gateway /health（端口 ${port}）…"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -m 2 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      log "gateway 健康：http://127.0.0.1:${port}"
      return 0
    fi
    sleep 1
  done
  return 1
}

start_foreground() {
  log "前台模式启动：$(gateway_exec) serve（nohup + pid 文件）"
  mkdir -p "${BASE_DIR}/run"
  local out="${BASE_DIR}/run/gateway.log"
  # 前台模式没有 systemd EnvironmentFile：先导入 env 文件让 gateway 读到端口/凭据
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  nohup "$(gateway_exec)" serve$(anchor_args) >"$out" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" > "${BASE_DIR}/run/gateway.pid"
  if ! health_wait "$GATEWAY_PORT" 30; then
    warn "前台进程未通过健康检查，日志：$out"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# 向导（交互；-y 时全部用默认）
# ---------------------------------------------------------------------------
wizard() {
  local dsh_ver
  # [1] 版本
  if [[ -n "$OFFLINE_TGZ" ]]; then
    log "离线模式：使用本地包 $OFFLINE_TGZ"
  else
    resolve_version
    if [[ "$NONINTERACTIVE" != "1" && -t 0 ]]; then
      local input
      printf 'gateway 版本 [\033[1m%s\033[0m]（回车接受 / 输入精确版本 / q 退出）: ' "$VERSION"
      IFS= read -r input || true
      [[ "${input:-}" == "q" ]] && die "已退出"
      [[ -n "${input:-}" ]] && VERSION="${input#v}"
    fi
  fi

  # [2] dsh 内建锚（探测优先；design 18 §9：此为「锚」，激活版本运行期切换）
  detect_dsh
  if [[ "$SKIP_DSH" == "1" && "$DSH_FOUND" != "explicit" && -z "${DSH_GATEWAY_DSH_PATH:-}" ]]; then
    die "--skip-dsh 需要显式内建锚（design 18 §9.3）：gateway 启动必须有 --dsh-path 或 DSH_GATEWAY_DSH_PATH。请提供 --dsh-path <workspace>（含 node_modules/@deepseek-ai/dsh），或设 DSH_GATEWAY_DSH_PATH，或去掉 --skip-dsh 让脚本自动探测/安装 dsh。"
  fi
  if [[ "$DSH_FOUND" == "global" ]]; then
    local v
    v=$(verify_dsh "$DSH_WS")
    log "检测到已有 dsh${v:+（${v}）}：复用 npm 全局工作区 $DSH_WS 作为内建锚（跳过安装；运行期可在 /chamber/runtime 切换激活版本）"
  elif [[ "$DSH_FOUND" == "path" ]]; then
    warn "检测到 dsh 命令但无法定位 npm 全局工作区"
    prompt DSH_WS "请提供 dsh workspace 路径（含 node_modules/@deepseek-ai/dsh，留空=自动安装）" ""
    if [[ -z "$DSH_WS" ]]; then
      prompt DSH_VER "安装 dsh 锚版本（默认与 gateway 发布绑定）" "$DSH_CHAMBER_DSH_VERSION"
    fi
  else
    if [[ "$SKIP_DSH" != "1" ]]; then
      prompt DSH_VER "安装 dsh 锚版本（默认与 gateway 发布绑定）" "$DSH_CHAMBER_DSH_VERSION"
    fi
  fi
  if [[ -z "$DSH_WS" && "$SKIP_DSH" != "1" ]]; then
    prompt npm_mirror "npm 镜像（回车=跟随 npm 设置）" ""
  fi

  # [3] dsh 端口
  local def_dsh_port="$DEFAULT_DSH_PORT"
  if ! port_free 127.0.0.1 "$def_dsh_port"; then
    def_dsh_port=$(suggest_port "$def_dsh_port")
    warn "端口 ${DEFAULT_DSH_PORT} 已被占用，建议使用 ${def_dsh_port}"
  fi
  prompt DSH_PORT "托管 dsh 监听端口" "$def_dsh_port"
  [[ "$DSH_PORT" =~ ^[0-9]+$ && "$DSH_PORT" -ge 1 && "$DSH_PORT" -le 65535 ]] || die "非法 dsh 端口：$DSH_PORT"

  # [4] gateway 端口
  local def_gw_port="$DEFAULT_GATEWAY_PORT"
  if ! port_free 127.0.0.1 "$def_gw_port"; then
    def_gw_port=$(suggest_port "$def_gw_port")
    warn "端口 ${DEFAULT_GATEWAY_PORT} 已被占用，建议使用 ${def_gw_port}"
  fi
  prompt GATEWAY_PORT "gateway 监听端口" "$def_gw_port"
  [[ "$GATEWAY_PORT" =~ ^[0-9]+$ && "$GATEWAY_PORT" -ge 1 && "$GATEWAY_PORT" -le 65535 ]] || die "非法 gateway 端口：$GATEWAY_PORT"
  [[ "$GATEWAY_PORT" != "$DSH_PORT" ]] || die "gateway 端口与 dsh 端口不能相同"

  # [5] 外部形态
  prompt BIND_HOST "bind host（127.0.0.1 | 0.0.0.0）" "127.0.0.1"
  [[ "$BIND_HOST" == "127.0.0.1" || "$BIND_HOST" == "0.0.0.0" ]] || die "bind host 仅允许 127.0.0.1 或 0.0.0.0"
  prompt PUBLIC_ORIGIN "公网 origin（HTTPS 反代地址，留空=仅内网）" ""
  prompt TRUSTED_PROXY "trusted proxy（反代精确 IP，逗号分隔，留空=无）" ""

  # [6] 凭据（S1：外部绑定必须）
  NO_AUTH=0
  if [[ "$BIND_HOST" == "0.0.0.0" || -n "$PUBLIC_ORIGIN" || -n "$TRUSTED_PROXY" ]]; then
    log "外部部署形态：必须配置凭据（S1）"
    if [[ -z "$UI_PASSWORD" && -z "$API_TOKEN" ]]; then
      if [[ "$NONINTERACTIVE" == "1" || ! -t 0 ]]; then
        UI_PASSWORD=$(openssl rand -base64 18 2>/dev/null | tr -d '\n')
        API_TOKEN=$(openssl rand -hex 32 2>/dev/null | tr -d '\n')
        warn "已自动生成凭据（写入 0600 gateway.env）"
      else
        local choice
        printf '凭据：a) 自动生成（推荐） b) 手动输入 [a]: '
        IFS= read -r choice || true
        if [[ "${choice:-a}" == "b" ]]; then
          prompt_secret UI_PASSWORD "浏览器密码（12-1024 字符）"
          prompt_secret API_TOKEN "共享 token（32-4096 visible ASCII）"
        else
          UI_PASSWORD=$(openssl rand -base64 18 2>/dev/null | tr -d '\n')
          API_TOKEN=$(openssl rand -hex 32 2>/dev/null | tr -d '\n')
          log "已自动生成凭据（0600 gateway.env；可在安装后用 cat 查看）"
        fi
      fi
    fi
  fi

  # [7] 安装方式
  prompt INSTALL_METHOD "安装方式（global=npm 全局 / local=本地 ~/.dsh-chamber）" "global"

  # [8] 服务形态
  if [[ "$EUID" -eq 0 ]] && have systemctl; then
    prompt SERVICE_MODE "服务形态（systemd / user / foreground）" "systemd"
  elif have systemctl; then
    prompt SERVICE_MODE "服务形态（非 root：user / foreground）" "user"
  else
    SERVICE_MODE="foreground"
    log "未检测到 systemd，使用前台模式"
  fi

  # [9] 危险项
  if [[ -z "$UI_PASSWORD" && -z "$API_TOKEN" && "$BIND_HOST" == "0.0.0.0" ]]; then
    if [[ "$NO_AUTH" == "1" || "$NONINTERACTIVE" == "1" ]]; then
      NO_AUTH=1
    else
      if confirm "允许 --no-auth 无认证外部绑定？（危险，仅限可信网络）" "n"; then
        NO_AUTH=1
      else
        die "外部绑定必须有凭据；请提供 --ui-password/--api-token 或改 bind 为 127.0.0.1"
      fi
    fi
  fi

  # 汇总
  if [[ "$NONINTERACTIVE" != "1" && -t 0 ]]; then
    printf '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
    printf '安装预览：\n'
    printf '  版本=%s  方式=%s  网关端口=%s  dsh端口=%s\n' "$VERSION" "$INSTALL_METHOD" "$GATEWAY_PORT" "$DSH_PORT"
    printf '  bind=%s  origin=%s  proxy=%s\n' "$BIND_HOST" "${PUBLIC_ORIGIN:-(无)}" "${TRUSTED_PROXY:-(无)}"
    printf '  dsh 锚=%s  服务=%s  no-auth=%s\n' "${DSH_WS:-自动安装}" "$SERVICE_MODE" "$([[ $NO_AUTH == 1 ]] && printf 是 || printf 否)"
    printf '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
    if ! confirm "确认执行？" "y"; then die "已取消"; fi
  fi
}

# ---------------------------------------------------------------------------
# 执行序列（dsh 先行，再 gateway）
# ---------------------------------------------------------------------------
do_install() {
  # 非 purge 卸载会保留 GATEWAY_DIR（state 数据），重新安装应当允许原地
  # 复用；仅当目录存在且无任何安装/状态痕迹时才视为外来冲突。
  if [[ -d "$GATEWAY_DIR" ]]; then
    if [[ -f "$CONF_FILE" || -d "$GATEWAY_DIR/data" || -d "$VERSIONS_DIR" ]]; then
      log "检测到保留的 gateway state（非 purge 卸载或既有安装）：原地复用，程序文件将被覆盖"
    else
      die "检测到外来目录 $GATEWAY_DIR（无安装/状态痕迹）。请先清空或改名该目录。"
    fi
  fi

  # 1) dsh 内建锚（探测 → 安装 → 验证；激活版本运行期经 /chamber/runtime 切换）
  if [[ -z "$DSH_WS" && "$SKIP_DSH" != "1" ]]; then
    install_dsh "${DSH_VER:-$DSH_CHAMBER_DSH_VERSION}"
  elif [[ -n "$DSH_WS" ]]; then
    local v
    v=$(verify_dsh "$DSH_WS" || true)
    [[ -n "$v" ]] || die "dsh workspace 验证失败：$DSH_WS（缺少 node_modules/@deepseek-ai/dsh）"
    log "dsh 内建锚验证通过：${v}（$DSH_WS）"
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
    mkdir -p "$VERSIONS_DIR/${VERSION}"
    tar -xzf "$tgz_src" -C "$VERSIONS_DIR/${VERSION}" --strip-components=1
    ln -sfn "$VERSIONS_DIR/${VERSION}" "$GATEWAY_DIR/current" 2>/dev/null || true
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

  # 5) 服务
  if [[ "$SERVICE_MODE" == "foreground" ]] || ! have systemctl; then
    SERVICE_MODE="foreground"
    start_foreground || die "前台启动失败（见 ${BASE_DIR}/run/gateway.log）"
  else
    write_unit
    health_wait "$GATEWAY_PORT" 30 || die "gateway 启动后未通过健康检查（journalctl -u dsh-chamber-gateway）"
  fi

  log "安装完成。管理命令：install-gateway.sh status | logs | update | uninstall"
}

# ---------------------------------------------------------------------------
# 管理子命令
# ---------------------------------------------------------------------------
load_conf() {
  [[ -f "$CONF_FILE" ]] || die "未检测到安装（$CONF_FILE 不存在）。先运行 install。"
  # shellcheck disable=SC1090
  . "$CONF_FILE"
}

cmd_status() {
  load_conf
  printf 'gateway %s @ 127.0.0.1:%s（dsh :%s）\n' "$VERSION" "$GATEWAY_PORT" "$DSH_PORT"
  if [[ "$SERVICE_MODE" == "foreground" ]]; then
    if [[ -f "${BASE_DIR}/run/gateway.pid" ]] && kill -0 "$(cat "${BASE_DIR}/run/gateway.pid")" 2>/dev/null; then
      printf '状态: 前台运行中（pid %s）\n' "$(cat "${BASE_DIR}/run/gateway.pid")"
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

cmd_update() {
  load_conf
  log "当前版本：$VERSION"
  local old_version="$VERSION"
  if [[ -n "$OFFLINE_TGZ" ]]; then
    die "update 不支持离线模式；离线请用 install（先卸载）"
  fi
  VERSION=""
  resolve_version
  if [[ "$VERSION" == "$old_version" ]]; then
    log "已是最新版本 $VERSION"
    return 0
  fi
  log "升级到 $VERSION …"
  local backup_dir="${GATEWAY_DIR}/versions/previous"
  if [[ "$INSTALL_METHOD" == "local" && -d "$VERSIONS_DIR/$old_version" ]]; then
    rm -rf "$backup_dir"
    cp -a "$VERSIONS_DIR/$old_version" "$backup_dir"
  fi
  download_verify "$GATEWAY_DIR"
  if [[ "$INSTALL_METHOD" == "global" ]]; then
    npm install -g "$GATEWAY_DIR/dsh-chamber-gateway-${VERSION}.tgz" || {
      warn "升级安装失败，尝试回滚…"
      [[ "$old_version" != "local" ]] && npm install -g "$GATEWAY_DIR/dsh-chamber-gateway-${old_version}.tgz" || true
      die "升级失败且回滚未完全成功，请手动检查"
    }
  else
    mkdir -p "$VERSIONS_DIR/${VERSION}"
    tar -xzf "$GATEWAY_DIR/dsh-chamber-gateway-${VERSION}.tgz" -C "$VERSIONS_DIR/${VERSION}" --strip-components=1
    ln -sfn "$VERSIONS_DIR/${VERSION}" "$GATEWAY_DIR/current" 2>/dev/null || true
  fi
  # 重启 + 健康检查 + 回滚
  if [[ "$SERVICE_MODE" == "foreground" ]]; then
    local fg_pid
    fg_pid=$(cat "${BASE_DIR}/run/gateway.pid" 2>/dev/null || true)
    if [[ -n "$fg_pid" ]]; then
      kill "$fg_pid" 2>/dev/null || true
      for _ in $(seq 1 10); do
        kill -0 "$fg_pid" 2>/dev/null || break
        sleep 1
      done
      kill -0 "$fg_pid" 2>/dev/null && { warn "前台进程未在 10s 内退出，强制终止"; kill -9 "$fg_pid" 2>/dev/null || true; }
    fi
    start_foreground || die "升级后健康检查失败"
  else
    if [[ "$SERVICE_MODE" == "user" ]]; then
      systemctl --user restart dsh-chamber-gateway || true
    else
      systemctl restart dsh-chamber-gateway || true
    fi
    if ! health_wait "$GATEWAY_PORT" 30; then
      warn "升级后健康检查失败，回滚到 $old_version …"
      if [[ "$INSTALL_METHOD" == "global" ]]; then
        npm install -g "$GATEWAY_DIR/dsh-chamber-gateway-${old_version}.tgz" 2>/dev/null || true
      else
        rm -rf "$VERSIONS_DIR/${VERSION}"
        [[ -d "$backup_dir" ]] && mv "$backup_dir" "$VERSIONS_DIR/$old_version"
      fi
      systemctl restart dsh-chamber-gateway 2>/dev/null || true
      health_wait "$GATEWAY_PORT" 20 || warn "回滚后仍未通过健康检查，请人工介入"
      die "升级失败，已回滚到 $old_version"
    fi
  fi
  sed -i.bak "s/^VERSION=.*/VERSION=${VERSION}/" "$CONF_FILE" && rm -f "$CONF_FILE.bak"
  log "已升级到 $VERSION"
}

cmd_uninstall() {
  load_conf
  if [[ "$NONINTERACTIVE" == "1" ]]; then
    :  # -y 显式放行（脚本化卸载）
  elif ! confirm "确认卸载 gateway（保留 state，--purge 才删 dsh-runtime/ 与 dsh-home/）？" "n"; then
    die "已取消"
  fi
  if [[ "$SERVICE_MODE" == "foreground" ]]; then
    local fg_pid
    fg_pid=$(cat "${BASE_DIR}/run/gateway.pid" 2>/dev/null || true)
    if [[ -n "$fg_pid" ]]; then
      kill "$fg_pid" 2>/dev/null || true
      for _ in $(seq 1 10); do
        kill -0 "$fg_pid" 2>/dev/null || break
        sleep 1
      done
      kill -0 "$fg_pid" 2>/dev/null && { warn "前台进程未在 10s 内退出，强制终止"; kill -9 "$fg_pid" 2>/dev/null || true; }
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
  rm -f "$CONF_FILE"
  # 非 purge 卸载仍清掉指向已删程序文件的启动器与运行期痕迹（state 保留）。
  rm -f "${BASE_DIR}/bin/gateway" 2>/dev/null || true
  rm -f "${BASE_DIR}/run/gateway.pid" "${BASE_DIR}"/run/gateway*.log 2>/dev/null || true
  if [[ "${PURGE:-0}" == "1" ]]; then
    rm -rf "$GATEWAY_DIR"
    log "已彻底卸载（含 state：dsh-runtime/ 版本树与快照、dsh-home/ 会话数据）"
  else
    log "已卸载（配置与数据保留于 $GATEWAY_DIR，含 data/dsh-runtime/ 版本树与快照、data/dsh-home/ 会话数据；仅 --purge 删除）"
  fi
}

# ---------------------------------------------------------------------------
# 参数解析
# ---------------------------------------------------------------------------
usage() {
  # 打印头部注释块（第 2 行起，止于 set -euo pipefail 之前）
  awk 'NR>=2 { if ($0=="set -euo pipefail") exit; sub(/^# ?/, ""); print }' "$0"
  exit 0
}

SUBCOMMAND="install"
while [[ $# -gt 0 ]]; do
  case "$1" in
    install|update|status|logs|uninstall|help|-h|--help) SUBCOMMAND="$1"; shift ;;
    -y|--yes) NONINTERACTIVE=1; shift ;;
    --version) VERSION="${2:?--version 需要值}"; shift 2 ;;
    --channel) CHANNEL="$2"; shift 2 ;;
    --tgz) OFFLINE_TGZ="$2"; shift 2 ;;
    --gateway-port) GATEWAY_PORT="$2"; shift 2 ;;
    --dsh-port) DSH_PORT="$2"; shift 2 ;;
    --dsh-path) DSH_WS="$2"; DSH_FOUND="explicit"; shift 2 ;;
    --bind) BIND_HOST="$2"; shift 2 ;;
    --origin) PUBLIC_ORIGIN="$2"; shift 2 ;;
    --trusted-proxy) TRUSTED_PROXY="$2"; shift 2 ;;
    --ui-password) UI_PASSWORD="$2"; shift 2 ;;
    --api-token) API_TOKEN="$2"; shift 2 ;;
    --no-auth) NO_AUTH=1; shift ;;
    --local) INSTALL_METHOD="local"; shift ;;
    --foreground) SERVICE_MODE="foreground"; shift ;;
    --skip-dsh) SKIP_DSH=1; shift ;;
    --purge) PURGE=1; shift ;;
    *) die "未知选项：$1（--help 查看用法）" ;;
  esac
done

case "$SUBCOMMAND" in
  help|-h|--help) usage ;;
  install) wizard; do_install ;;
  update) cmd_update ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  uninstall) cmd_uninstall ;;
esac
