#!/usr/bin/env bash
# ============================================================================
# dsh-chamber Gateway 一键安装器（design 17 服务器部署 + design 18 运行时管理）
#
# 用途：从 GitHub release 拉取 gateway 包（npm 未发布也能装），交互式确认
# 每个配置（默认值合理、全部可改、非交互 -y 供 CI），探测/安装 dsh，
# 生成 systemd 单元（root）或 systemctl --user / 前台（非 root），
# 提供 install / update / status / logs / uninstall 管理子命令。
#
# dsh 定位（design 18 §9，2026-09 受控锚决策）：dsh 内建/回退锚安装在
# gateway 自己的受控目录 ${BASE_DIR}/gateway/dsh-anchor（workspace 形态，
# 经 --dsh-path / DSH_GATEWAY_DSH_PATH 提供给 gateway），不使用 npm 全局
# 安装——dsh 运行时由 gateway 拥有，锚与版本树都在受控位置。
# 安装完成后 dsh 版本可在 gateway 的 /chamber/ 页面（或 /chamber/runtime API）
# 运行期管理（安装/切换/回滚）；运行期安装由 gateway 嵌入式 pnpm 落到
# DSH_GATEWAY_STATE（默认 ${BASE_DIR}/gateway/data）下的 dsh-runtime/ 目录。
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
DSH_CHAMBER_DSH_VERSION="${DSH_CHAMBER_DSH_VERSION:-0.1.2-alpha.2}"
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
  if [[ "${input:-}" == "q" ]]; then die "已退出（q）"; fi
  assign_var "$var" "${input:-$def}"
}

# prompt_secret VAR 提示语 —— 隐藏输入（stty 不可用时警告后明文）
prompt_secret() {
  local var="$1" label="$2"
  if [[ "$NONINTERACTIVE" == "1" || ! -t 0 ]]; then
    warn "非交互模式：凭据需通过 --ui-password/--api-token 显式提供"
    assign_var "$var" ""
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
  assign_var "$var" "$input"
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

validate_gateway_version() {
  local version="$1"
  [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]] \
    || die "gateway 版本必须是 canonical SemVer：$version"
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
  trap 'rm -rf "$tmp"' RETURN
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
  ( cd "$tmp" && sha256sum -c "$sha_file" >/dev/null 2>&1 ) || {
    rm -rf "$tmp"
    die "sha256 校验失败：下载包与 release 资产不一致，已中止（现场保留于 $tmp 之外）"
  }
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
  # 受控锚复用（2026-09 实机决策）：gateway 自己的 dsh-anchor 目录存在且
  # 有效即复用；不探测/复用 npm 全局安装——dsh 运行时由 gateway 拥有，
  # 锚与版本树都应在受控位置（<GATEWAY_DIR>/dsh-anchor 与
  # <stateDir>/dsh-runtime/）。
  if dsh_workspace_has_entry "${GATEWAY_DIR}/dsh-anchor"; then
    DSH_WS="${GATEWAY_DIR}/dsh-anchor"
    DSH_FOUND="controlled"
    return 0
  fi
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
  log "安装 dsh 内建锚 @${target_version}（受控位置 $anchor_dir）…"
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
  log "dsh 内建锚就绪：$ver（$DSH_WS）"
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

# 配置落盘（该文件由 bash source，故使用 bash 自己的 %q 语法）。
write_config() {
  mkdir -p "$GATEWAY_DIR"
  umask 077
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
  mkdir -p "$GATEWAY_DIR"
  umask 077
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
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\\$}"
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
  if ! tar -xzf "$tgz" -C "$stage" --strip-components=1; then
    rm -rf "$stage"
    return 1
  fi
  local artifact_version
  artifact_version=$(gateway_tree_version "$stage" || true)
  if [[ -z "$artifact_version" || ( "$version" != "local" && "$artifact_version" != "$version" ) ]]; then
    warn "gateway 资产版本不匹配：期望 $version，得到 ${artifact_version:-未知}"
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
  local unit_dir owner expected_owner
  unit_dir=$(dirname "$unit_file")
  owner=$(stat -Lc '%u' "$unit_dir" 2>/dev/null) || return 1
  expected_owner="$EUID"
  [[ "$SERVICE_MODE" != "systemd" ]] || expected_owner=0
  if [[ "$owner" != "$expected_owner" ]]; then
    warn "systemd unit 目录 owner 不可信：$unit_dir（uid=$owner，期望 $expected_owner）"
    return 1
  fi
  local content
  content=$(cat <<EOF
[Unit]
Description=dsh-chamber gateway (design 17 server shape)
After=network.target

[Service]
Type=simple
EnvironmentFile=$(systemd_quote_arg "$ENV_FILE")
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
  local record identity pid
  record=$(foreground_record_file)
  [[ -f "$record" ]] || return 0
  identity=$(foreground_identity || true)
  if [[ -z "$identity" ]]; then
    warn "foreground pid 记录已陈旧或身份不匹配，拒绝终止可能无关的进程"
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
  mkdir -p "${BASE_DIR}/run"
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
    sleep 0.05
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

wizard() {
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
      validate_gateway_version "$VERSION"
    fi
  fi

  # [2] dsh 内建锚（探测优先；design 18 §9：此为「锚」，激活版本运行期切换）
  detect_dsh
  if [[ "$SKIP_DSH" == "1" && "$DSH_FOUND" != "explicit" && -z "${DSH_GATEWAY_DSH_PATH:-}" ]]; then
    die "--skip-dsh 需要显式内建锚（design 18 §9.3）：gateway 启动必须有 --dsh-path 或 DSH_GATEWAY_DSH_PATH。请提供 --dsh-path <workspace>（含 node_modules/@deepseek-ai/dsh），或设 DSH_GATEWAY_DSH_PATH，或去掉 --skip-dsh 让脚本自动探测/安装 dsh。"
  fi
  if [[ "$DSH_FOUND" == "controlled" ]]; then
    local v
    v=$(verify_dsh "$DSH_WS")
    log "检测到受控锚 dsh${v:+（${v}）}：复用 ${GATEWAY_DIR}/dsh-anchor 作为内建锚（跳过安装；运行期可在 /chamber/runtime 切换激活版本）"
  else
    if [[ "$SKIP_DSH" != "1" ]]; then
      prompt DSH_VER "安装 dsh 锚版本（默认与 gateway 发布绑定，安装到受控锚目录）" "$DSH_CHAMBER_DSH_VERSION"
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

  # [6] 凭据（S1：外部绑定必须；--no-auth 显式传入时跳过自动生成且不重置，
  #      由 [9] 危险项二次确认放行）
  if [[ "$NO_AUTH" != "1" ]]; then
    NO_AUTH=0
  fi
  if external_deployment; then
    if [[ "$NO_AUTH" == "1" ]]; then
      log "外部部署形态：--no-auth 已显式指定，跳过凭据自动生成（S1 由 gateway 的 --no-auth 放行）"
    else
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
  fi

  # [7] 安装方式
  prompt INSTALL_METHOD "安装方式（global=npm 全局 / local=本地 ~/.dsh-chamber）" "global"
  [[ "$INSTALL_METHOD" == "global" || "$INSTALL_METHOD" == "local" ]] || die "安装方式仅允许 global 或 local：$INSTALL_METHOD"

  # [8] 服务形态
  if [[ "$EUID" -eq 0 ]] && have systemctl; then
    prompt SERVICE_MODE "服务形态（systemd / user / foreground）" "systemd"
  elif have systemctl; then
    prompt SERVICE_MODE "服务形态（非 root：user / foreground）" "user"
  else
    SERVICE_MODE="foreground"
    log "未检测到 systemd，使用前台模式"
  fi
  [[ "$SERVICE_MODE" == "systemd" || "$SERVICE_MODE" == "user" || "$SERVICE_MODE" == "foreground" ]] || die "服务形态仅允许 systemd、user 或 foreground：$SERVICE_MODE"

  # [9] 危险项：外部绑定 + 无凭据（design 17：--no-auth 有二次确认步骤；
  #     交互确认，-y 放行）
  if [[ -z "$UI_PASSWORD" && -z "$API_TOKEN" ]] && external_deployment; then
    if [[ "$NONINTERACTIVE" == "1" ]]; then
      NO_AUTH=1
      warn "--no-auth 已放行：外部绑定无认证运行（仅限可信网络）"
    elif confirm "允许 --no-auth 无认证外部绑定？（危险，仅限可信网络）" "n"; then
      NO_AUTH=1
    else
      die "外部绑定必须有凭据；请提供 --ui-password/--api-token 或改 bind 为 127.0.0.1"
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
      log "检测到保留的 gateway state（非 purge 卸载或既有安装）：原地复用；程序版本树仅校验复用或全新发布"
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

  # 5) 服务
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

  log "安装完成。管理命令：install-gateway.sh status | logs | update | uninstall"
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
  printf 'gateway %s @ 127.0.0.1:%s（dsh :%s）\n' "$VERSION" "$GATEWAY_PORT" "$DSH_PORT"
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

cmd_update() {
  # Preserve the caller's requested target before gateway.conf restores the
  # installed VERSION. An explicit --version must not silently become latest.
  local requested_version="$VERSION"
  load_conf
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
      || die "gateway/current 旧版本身份与配置不匹配：期望 $old_version，得到 ${old_tree_version:-未知}"
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
  fi

  if [[ -n "$failure_reason" ]]; then
    warn "$failure_reason；回滚到 $old_version …"
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
      restart_service || rollback_ok=0
      health_wait "$GATEWAY_PORT" 20 "$rollback_expected_version" "$rollback_previous" || rollback_ok=0
    fi
    if [[ "$INSTALL_METHOD" == "local" && -n "$new_local_target" && "$local_pointer_restored" == "1" ]]; then
      rm -rf "$new_local_target"
    fi
    if [[ "$rollback_ok" == "1" ]]; then
      die "升级失败，已回滚到 $old_version：$failure_reason"
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
