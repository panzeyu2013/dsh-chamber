#!/usr/bin/env bash
#
# collect-macos-evidence.sh —— macOS 实机收口证据的**只读**采集器。
#
# 面向 docs/checklists/macos-real-machine-checklist.md：把壳日志、刷新率对照行、
# sidecar/控制面归因行、崩溃留痕、.app/.dmg 签名与 Gatekeeper 输出打成一页可粘贴
# 的报告。它**不是门禁**（不进 run-checks），也不修任何东西：
#   - 不挂载 dmg、不写 userData、不联网、不改系统状态；
#   - 只读 <userData>/logs/*、<userData>/state/logs/control-plane.log、
#     ~/Library/Logs/DiagnosticReports，以及对给定 .app/.dmg 跑只读校验命令。
#
# 退出码（供人工判读；无真机证据时给人类可读的失败说明，绝不吐 set -e 裸错误）：
#   0  已采集到最低证据面（shell.log 存在且含 ≥1 条 [native] 刷新率 行）
#       ——打包态只要成功建窗就会写这行；日志在但一行都没有 = 证据不完整，按 4 处理
#   2  用法错误
#   3  环境不适用（非 macOS）
#   4  没找到 Swift 壳证据（本机没跑过打包 .app / userData 指错）——报告照常打印
#   5  内部错误（临时文件/输出不可写）
#
# 用法：
#   bash scripts/dev/collect-macos-evidence.sh [选项]
#     --user-data <dir>   指定 userData 根（默认见下）；也可用环境变量 DSH_CHAMBER_USER_DATA
#     --app <path>        .app 路径（默认试 macos/release/dsh-chamber.app）
#     --dmg <path>        .dmg 路径（默认试 macos/release/dsh-chamber.dmg）
#     --out <file>        同时把报告写到文件（默认只打印）
#     --tail <n>          每个日志面的摘录行数（默认 40）
#     --report-only       即使缺最低证据面也以 0 退出（只出报告）
#     --with-display      额外采集 system_profiler 显示器信息（慢；S-48 面板上限对照）
#     -h | --help
#
set -uo pipefail

SCRIPT_NAME="${0##*/}"
DEFAULT_USER_DATA="${HOME}/Library/Application Support/@dsh-chamber/desktop"
DEV_USER_DATA="${HOME}/Library/Application Support/dsh-chamber-poc-dev"

USER_DATA="${DSH_CHAMBER_USER_DATA:-}"
APP_PATH=""
DMG_PATH=""
OUT_FILE=""
TAIL_LINES=40
REPORT_ONLY=0
WITH_DISPLAY=0

usage() {
  sed -n '2,40p' "$0" | sed 's/^#//; s/^ //'
}

fail_usage() {
  printf '%s: %s\n' "$SCRIPT_NAME" "$1" >&2
  printf '用法：bash %s [--user-data <dir>] [--app <path>] [--dmg <path>] [--out <file>] [--tail <n>] [--report-only] [--with-display]\n' "$SCRIPT_NAME" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user-data)
      [[ $# -ge 2 ]] || fail_usage "--user-data 需要一个目录参数"
      USER_DATA="$2"; shift 2 ;;
    --app)
      [[ $# -ge 2 ]] || fail_usage "--app 需要一个路径参数"
      APP_PATH="$2"; shift 2 ;;
    --dmg)
      [[ $# -ge 2 ]] || fail_usage "--dmg 需要一个路径参数"
      DMG_PATH="$2"; shift 2 ;;
    --out)
      [[ $# -ge 2 ]] || fail_usage "--out 需要一个文件参数"
      OUT_FILE="$2"; shift 2 ;;
    --tail)
      [[ $# -ge 2 ]] || fail_usage "--tail 需要一个数字"
      case "$2" in ''|*[!0-9]*) fail_usage "--tail 只接受非负整数（收到 $2）" ;; esac
      TAIL_LINES="$2"; shift 2 ;;
    --report-only)
      REPORT_ONLY=1; shift ;;
    --with-display)
      WITH_DISPLAY=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      fail_usage "未知参数：$1" ;;
  esac
done

[[ -n "$USER_DATA" ]] || USER_DATA="$DEFAULT_USER_DATA"

# ---- 输出通道：stdout +（可选）文件，二者同一份文本 -----------------------------

if [[ -n "$OUT_FILE" ]]; then
  if ! : > "$OUT_FILE" 2>/dev/null; then
    printf '%s: 无法写入 --out 文件：%s\n' "$SCRIPT_NAME" "$OUT_FILE" >&2
    exit 5
  fi
fi

emit() {
  printf '%s\n' "$*"
  if [[ -n "$OUT_FILE" ]]; then
    printf '%s\n' "$*" >> "$OUT_FILE" 2>/dev/null || true
  fi
}

section() {
  emit ""
  emit "────────────────────────────────────────────────────────────────────────"
  emit "## $*"
  emit "────────────────────────────────────────────────────────────────────────"
}

have() { command -v "$1" >/dev/null 2>&1; }

# 只读执行一条命令并记录输出与退出码；命令失败只影响这一节，不中断报告。
run_readonly() {
  local output status
  emit "\$ $*"
  output="$("$@" 2>&1)"; status=$?
  if [[ -n "$output" ]]; then emit "$output"; fi
  emit "(exit=$status)"
}

# ---- 0. 环境判定 ---------------------------------------------------------------

emit "# macOS 实机收口证据报告"
emit ""
emit "生成时间：$(date '+%Y-%m-%d %H:%M:%S %z')"
emit "脚本：$SCRIPT_NAME（只读；不进 run-checks）"
emit "userData：$USER_DATA"
emit "对照 runbook：docs/checklists/macos-real-machine-checklist.md"

section "0. 环境"

if [[ "$(uname -s)" != "Darwin" ]]; then
  emit "环境不适用：本脚本只服务 macOS 实机收口（当前 uname -s = $(uname -s)）。"
  emit "若这台机器是 Windows 腿，走 runbook §9（需要在 Windows 11 x64 上执行）。"
  exit 3
fi

emit "uname：$(uname -srm)"
if have sw_vers; then
  emit "sw_vers：$(sw_vers -productVersion)（build $(sw_vers -buildVersion)）"
fi
# 版本/构建头 + 分享警示（§22.3.1：无版本头的证据无法定位被测构建；证据含本机线索不得裸外发）
ROOT_FOR_HEADER="$(cd "$(dirname "$0")/../.." && pwd)"
APP_FOR_HEADER="${APP_PATH:-$ROOT_FOR_HEADER/macos/release/dsh-chamber.app}"
if [[ -d "$APP_FOR_HEADER" && -x /usr/libexec/PlistBuddy ]]; then
  header_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_FOR_HEADER/Contents/Info.plist" 2>/dev/null || true)"
  header_build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_FOR_HEADER/Contents/Info.plist" 2>/dev/null || true)"
  emit "app 版本：${header_version:-unknown}（build ${header_build:-unknown}）——$APP_FOR_HEADER"
else
  emit "app 版本：未采到（未找到 .app；用 --app 指定，或先 pnpm run build:swift-app）"
fi
emit "分享警示：本报告含本机路径/用户名/进程事实与日志摘录；外发（issue/聊天/附件）前必须人工复核，minidump 一律不得外发。"
if have system_profiler && [[ "$WITH_DISPLAY" == "1" ]]; then
  section "0.1 显示器（--with-display；S-48 面板上限对照）"
  run_readonly system_profiler SPDisplaysDataType
fi

# ---- 1. 日志面存在性 -----------------------------------------------------------

NATIVE_LOG="$USER_DATA/logs/shell.log"
NATIVE_LOG_1="$NATIVE_LOG.1"
SIDECAR_LOG="$USER_DATA/logs/sidecar.log"
SIDECAR_LOG_1="$SIDECAR_LOG.1"
CONTROL_LOG="$USER_DATA/state/logs/control-plane.log"
FATAL_REPORT_LOG="$USER_DATA/logs/fatal-report.log"

section "1. 日志面"
emit "shell.log      ：$NATIVE_LOG"
emit "shell.log.1    ：$NATIVE_LOG_1"
emit "sidecar.log           ：$SIDECAR_LOG"
emit "control-plane.log     ：$CONTROL_LOG"
emit "fatal-report.log      ：$FATAL_REPORT_LOG"
emit ""
if [[ -f "$FATAL_REPORT_LOG" ]]; then
  emit "Electron 致命报告尾部（最近 $TAIL_LINES 行；只落盘不外发）："
  run_readonly tail -n "$TAIL_LINES" "$FATAL_REPORT_LOG"
else
  emit "（无 Electron 致命报告：$FATAL_REPORT_LOG —— 无记录即无记录，不据此判「没发生过」）"
fi
emit ""
if [[ -d "$USER_DATA" ]]; then
  emit "userData 目录存在；logs/ 内容："
  run_readonly ls -la "$USER_DATA/logs"
else
  emit "userData 目录**不存在**：$USER_DATA"
  emit "（打包 .app 从未在这台机器启动过，或 --user-data 指错了；dev 装配的根是 $DEV_USER_DATA）"
fi

MINIMUM_OK=0
if [[ -f "$NATIVE_LOG" ]]; then
  MINIMUM_OK=1
fi

if [[ "$MINIMUM_OK" != "1" ]]; then
  section "1.1 最低证据面：缺失"
  emit "未找到 $NATIVE_LOG。"
  emit ""
  emit "原因（按可能性排序）："
  emit "  1) 本机从未运行过 Swift 打包 .app（runbook 的实机项都还没跑）——这是「无真机证据」；"
  emit "  2) userData 指到了别处（打包态默认 $DEFAULT_USER_DATA；dev 态是 $DEV_USER_DATA）；"
  emit "  3) .app 启动后立刻致命退出且 shell.log 未能创建（那要先看 stderr / 崩溃报告）。"
  emit ""
  emit "先做：open -a <打包 .app> 等页面加载完成，再重跑本脚本。"
  emit "本次报告不含 S-48/S-10 的壳侧证据，**不得据此写任何「通过」**。"
  if [[ "$REPORT_ONLY" == "1" ]]; then
    emit ""
    emit "（--report-only：按请求以 0 退出，但结论仍是「未采集」。）"
    exit 0
  fi
  emit ""
  emit "退出码 4 = 没找到 Swift 壳证据；用 --report-only 可只看报告。"
  exit 4
fi

# ---- 2. S-48 刷新率对照行 -------------------------------------------------------

section "2. S-48 刷新率对照（打包态唯一口径：shell.log 的 [native] 刷新率 行）"
REFRESH_COUNT=0
for candidate in "$NATIVE_LOG" "$NATIVE_LOG_1"; do
  [[ -f "$candidate" ]] || continue
  count="$(grep -c '刷新率' "$candidate" 2>/dev/null || true)"
  emit "grep -c '刷新率' $candidate → $count"
  REFRESH_COUNT=$((REFRESH_COUNT + count))
done
emit ""
emit "最近 $TAIL_LINES 条刷新率行（含时间戳）："
for candidate in "$NATIVE_LOG_1" "$NATIVE_LOG"; do
  [[ -f "$candidate" ]] || continue
  emit "—— $candidate"
  refresh_lines="$(grep '刷新率' "$candidate" 2>/dev/null | tail -n "$TAIL_LINES" || true)"
  if [[ -n "$refresh_lines" ]]; then emit "$refresh_lines"; else emit "（无匹配）"; fi
done
emit ""
emit "FPS_PROBE_COUNT（[native-fps]，只在 POC_DEBUG=1 且非 .app 注入；打包态必须为 0）："
for candidate in "$NATIVE_LOG" "$NATIVE_LOG_1"; do
  [[ -f "$candidate" ]] || continue
  probe="$(grep -c '\[native-fps\]' "$candidate" 2>/dev/null || true)"
  emit "  $candidate → $probe"
done
emit ""
emit "判读：把上面三工况读数对 runbook §1 的表（插电 120 / 低电量 60 / 60Hz 外接屏 60）。"
emit "本脚本只负责把行捞出来——ceiling 折算与「偏好是否已关闭」由人判。"

# ---- 3. S-49 窗口几何（尽力而为） ----------------------------------------------

section "3. S-49 窗口几何（需要 .app 正在运行 + 终端有辅助功能权限）"
if pgrep -x dsh-chamber >/dev/null 2>&1; then
  emit "dsh-chamber 正在运行，尝试读窗框："
  run_readonly osascript -e 'tell application "System Events" to tell process "dsh-chamber" to get {position of window 1, size of window 1}'
  emit "（读失败常见原因：终端未获「辅助功能」权限 / 窗口标题选择器变化；如实记「未判」。）"
else
  emit "dsh-chamber 未在运行 → 本项未采集。启动打包 .app 后重跑，或按 runbook §2 手测。"
fi
emit "对照登记值：S 内容区 1280×786（外框约 814）/ E 外框 1280×800（视口 772）/ 上游外框 1280×840。"

# ---- 4. S-10 隐藏/遮挡态归因行 ---------------------------------------------------

section "4. S-10 隐藏/遮挡态流与恢复（归因行摘录）"
for candidate in "$SIDECAR_LOG" "$SIDECAR_LOG_1" "$CONTROL_LOG"; do
  [[ -f "$candidate" ]] || { emit "（缺文件：$candidate）"; continue; }
  hits="$(grep -cE 'heartbeat lost|WebSocket stream|visibility|hidden|resume|reconnect' "$candidate" 2>/dev/null || true)"
  emit "—— $candidate（匹配 $hits 行；摘录最近 $TAIL_LINES 行的匹配）"
  recent="$(tail -n 400 "$candidate" 2>/dev/null | grep -E 'heartbeat lost|WebSocket stream|visibility|hidden|resume|reconnect' | tail -n "$TAIL_LINES" || true)"
  if [[ -n "$recent" ]]; then emit "$recent"; else emit "（无匹配）"; fi
done
emit ""
emit "判读：隐藏 ≥60s 期间出现 'heartbeat lost' 或非预期断流 = 失败；恢复后必须即时重连并出首帧。"
emit "本脚本看不到「隐藏了几秒」——时间线要人工从隐藏/恢复时刻对齐（runbook §4）。"

# ---- 5. 异常退出留痕 -----------------------------------------------------------

section "5. 异常退出留痕"
emit "口径：崩溃诊断（「上次异常退出」标记 / shell-crash.log 一类文件）属台账 §8.a P0"
emit "「原生崩溃最小诊断」的交付面；本采集器**有则采、无则如实说无**，不替它的落地状态下结论"
emit "（以 STATUS / 台账为准）。下面同时给出候选标记文件扫描、致命行与系统崩溃报告。"
emit ""
emit "候选标记/崩溃文件（<userData>/logs 下 *crash* / *marker* / *abnormal* 与 shell-crash.log）："
marker_found=0
for candidate_marker in "$USER_DATA"/logs/*crash* "$USER_DATA"/logs/*marker* "$USER_DATA"/logs/*abnormal* "$USER_DATA"/logs/shell-crash.log; do
  [[ -e "$candidate_marker" ]] || continue
  marker_found=1
  emit "  命中：$candidate_marker"
  run_readonly ls -la "$candidate_marker"
done
if [[ "$marker_found" == "0" ]]; then
  emit "  未命中（P0 若已落地而这里仍为空，再看 runbook/STATUS 是否记了别的落点）。"
fi
emit ""
if [[ -f "$USER_DATA/logs/shell-crash.log" ]]; then
  emit "shell-crash.log 记录内容（最近 $TAIL_LINES 行）："
  run_readonly tail -n "$TAIL_LINES" "$USER_DATA/logs/shell-crash.log"
else
  emit "（无 shell-crash.log）"
fi
if [[ -f "$USER_DATA/logs/shell-crash.marker" ]]; then
  emit "上次异常退出：marker 存在（上一次进程未走正常退出路径）"
else
  emit "上次异常退出：无 marker（正常退出，或从未运行过）"
fi
emit ""
emit "Crashpad minidump 统计（只报数量/最新/总字节；dmp 含原始内存，一律不得外发）："
crashpad_dir="$USER_DATA/Crashpad/completed"
if [[ -d "$crashpad_dir" ]]; then
  dmp_list="$(find "$crashpad_dir" -name '*.dmp' -type f 2>/dev/null | sort || true)"
  dmp_count="$(printf '%s\n' "$dmp_list" | grep -c . || true)"
  emit "  目录：$crashpad_dir"
  emit "  数量：$dmp_count"
  if [[ "$dmp_count" != "0" ]]; then
    emit "  最新：$(printf '%s\n' "$dmp_list" | tail -n 1)"
    emit "  总字节：$(printf '%s\n' "$dmp_list" | xargs du -ck 2>/dev/null | tail -n 1 | awk '{print $1 * 1024}')"
  fi
else
  emit "  （无 Crashpad/completed 目录：或没崩过，或未启用 Crashpad）"
fi
emit ""
if [[ -f "$NATIVE_LOG" ]]; then
  emit "shell.log 的致命/supervisor fatal 行（最近 $TAIL_LINES 条）："
  fatal_lines="$(grep -nE '致命错误|fatal|supervisor|目录锁被占用|exit=' "$NATIVE_LOG" 2>/dev/null | tail -n "$TAIL_LINES" || true)"
  if [[ -n "$fatal_lines" ]]; then emit "$fatal_lines"; else emit "（无匹配）"; fi
else
  emit "（无 shell.log）"
fi
emit ""
emit "系统崩溃报告（~/Library/Logs/DiagnosticReports 里 dsh-chamber* 最近 5 个）："
if [[ -d "$HOME/Library/Logs/DiagnosticReports" ]]; then
  crash_reports="$(ls -lt "$HOME/Library/Logs/DiagnosticReports" 2>/dev/null | grep -i 'dsh-chamber' | head -n 5 || true)"
  if [[ -n "$crash_reports" ]]; then emit "$crash_reports"; else emit "（无匹配）"; fi
else
  emit "（无 DiagnosticReports 目录）"
fi

# ---- 6. .app / .dmg 签名与 Gatekeeper -----------------------------------------

section "6. S 侧 dmg 本体签名 + Gatekeeper（runbook §7）"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ -z "$APP_PATH" && -d "$REPO_ROOT/macos/release/dsh-chamber.app" ]]; then
  APP_PATH="$REPO_ROOT/macos/release/dsh-chamber.app"
fi
if [[ -z "$DMG_PATH" && -f "$REPO_ROOT/macos/release/dsh-chamber.dmg" ]]; then
  DMG_PATH="$REPO_ROOT/macos/release/dsh-chamber.dmg"
fi

if [[ -z "$APP_PATH" && -z "$DMG_PATH" ]]; then
  emit "未提供 --app/--dmg，默认产物路径也不存在："
  emit "  $REPO_ROOT/macos/release/dsh-chamber.app"
  emit "  $REPO_ROOT/macos/release/dsh-chamber.dmg"
  emit "先构建：pnpm run build:sidecar && pnpm run build:swift-app [--identity <id>]"
  emit "或显式指定：--app <path> --dmg <path>。本项未采集（不影响 S-48 证据的采集）。"
else
  emit "app：${APP_PATH:-（未提供）}"
  emit "dmg：${DMG_PATH:-（未提供）}"
  emit ""
  emit "判读口径（runbook §7）：正式产物 = codesign verify + spctl accepted + stapler validate 全绿；"
  emit "dmg 本体未签名是 §5.1 的已知缺口（写「未签名」而不是「通过」）；ad-hoc 演练包的预期失败不得当发布证据。"
  if [[ -n "$APP_PATH" ]]; then
    if [[ -d "$APP_PATH" ]]; then
      run_readonly codesign --verify --deep --strict --verbose=2 "$APP_PATH"
      run_readonly codesign -dv --verbose=4 "$APP_PATH"
      run_readonly spctl -a -vv "$APP_PATH"
      run_readonly xcrun stapler validate "$APP_PATH"
    else
      emit "（--app 指向的路径不存在：$APP_PATH → 本腿未采集）"
    fi
  fi
  if [[ -n "$DMG_PATH" ]]; then
    if [[ -f "$DMG_PATH" ]]; then
      run_readonly xcrun stapler validate "$DMG_PATH"
      run_readonly spctl -a -vv -t open --context context:primary-signature "$DMG_PATH"
      emit "# 下面这条今天预期失败（S 侧 dmg 本体未 codesign，§5.1）："
      run_readonly codesign -dv "$DMG_PATH"
    else
      emit "（--dmg 指向的路径不存在：$DMG_PATH → 本腿未采集）"
    fi
  fi
fi

# ---- 7. 收尾 -------------------------------------------------------------------

section "7. 结论面（脚本只报事实，不替人判通过/失败）"
emit "S-48 刷新率行数：$REFRESH_COUNT（≥1 才有可判读数；三工况要三条语义不同的行）"
if [[ "$REFRESH_COUNT" -lt 1 ]]; then
  emit "最低证据面：**不完整**——shell.log 存在，但没有任何 [native] 刷新率 行。"
  emit ""
  emit "这意味着壳没有走到「窗口建好并记录所在屏」：可能 .app 启动后立刻致命退出，"
  emit "或日志被手动截断/轮转丢了。先看下面的致命行与崩溃报告，再重跑。"
  if [[ "$REPORT_ONLY" == "1" ]]; then
    emit "（--report-only：按请求以 0 退出，但结论仍是「未采集」。）"
    exit 0
  fi
  emit "退出码 4 = 没采到 S-48 读数；用 --report-only 可只看报告。"
  exit 4
fi
emit "最低证据面：已满足（shell.log 存在且含 $REFRESH_COUNT 条刷新率行）"
emit ""
emit "接下来按 runbook 逐项补人工证据：§3 S-50 录屏、§4 S-10 时间线、§5 折叠/徽标截图、"
emit "§6 主题截图、§8 C4 三选框与 relaunch（要 GUI 操作）。"
emit "输出文件（--out）与截图一起放进 PR；不要把轮次/绿灯写进 STATUS。"

exit 0
