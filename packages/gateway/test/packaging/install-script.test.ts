/**
 * Installer script contract: sourced-library flows, service/layout/update paths
 * and the harness-composition guard.
 *
 * P0 split siblings: install-anchor.test.ts (dsh-anchor sync/rollback) and
 * test/support/installer-harness.ts (shared harness).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  installer,
  source,
  library,
  harnessSource,
  runLibrary,
  runLibraryResult,
  writeGatewayTree,
} from '../support/installer-harness.ts'

/**
 * A harness that sources the installer library — or spawns the real script —
 * needs a HOME: the library resolves BASE_DIR through `${HOME:?...}` unless
 * DSH_CHAMBER_BASE_DIR is set. The environment this suite diagnoses (a gateway
 * service started without a login environment) has none, so the acceptance run
 * must not depend on the caller's variable. Use the passwd entry instead:
 * os.userInfo() ignores $HOME, and an empty $HOME counts as unset for the
 * installer's `${HOME:?...}`, while os.homedir() would happily return ''.
 */
const INSTALLER_ENV = { ...process.env, HOME: userInfo().homedir || process.env.HOME }

test('interactive/default assignment keeps shell metacharacters as data', () => {
  const payload = "safe'; PROMPT_INJECTED=owned; : 'still-data"
  const output = runLibrary(`
NONINTERACTIVE=1
PROMPT_INJECTED=safe
ask_text TEST_VALUE label "" "$PAYLOAD"
printf '%s\\n%s\\n' "$PROMPT_INJECTED" "$TEST_VALUE"
`, { PAYLOAD: payload })
  assert.deepEqual(output.trimEnd().split('\n'), ['safe', payload])
  assert.doesNotMatch(source, /^\s*eval\b/m, 'installer input assignment must never reintroduce eval')
})

test('systemd service arguments use systemd quoting rather than bash printf %q', { skip: process.platform !== 'linux' }, () => {
  const analyze = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' })
  if (analyze.status !== 0) return
  const execStart = runLibrary(`
DSH_WS="$PAYLOAD"
ENV_ANCHOR=0
NO_AUTH=1
systemd_exec_start /bin/echo
`, { PAYLOAD: "/tmp/dsh anchor'with%percent\\and$dollar" })
  const dir = mkdtempSync(join(tmpdir(), 'gateway-systemd-unit-'))
  const unit = join(dir, 'dsh-chamber-installer-quote.service')
  try {
    writeFileSync(unit, `[Service]\nType=oneshot\nExecStart=${execStart}\n`, { mode: 0o600 })
    const verified = spawnSync('systemd-analyze', ['verify', unit], { encoding: 'utf8' })
    assert.equal(verified.status, 0, `${verified.stdout}${verified.stderr}`)
    assert.match(execStart, /--dsh-path "/)
    assert.match(execStart, /%%percent/, 'literal percent must not become a unit specifier')
    assert.match(execStart, /\$\$dollar/, 'literal dollar must not become environment expansion')
    assert.doesNotMatch(execStart, /\\ /, 'bash-style escaped spaces are invalid in systemd ExecStart')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('environment and unit publication refuse symlink leaves without touching victims', () => {
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
ENV_FILE="$GATEWAY_DIR/gateway.env"
mkdir -p "$GATEWAY_DIR"
GATEWAY_PORT=30801
DSH_PORT=30800
BIND_HOST=127.0.0.1
DSH_WS=""
ENV_ANCHOR=0
PUBLIC_ORIGIN=""
TRUSTED_PROXY=""
NO_AUTH=0
UI_PASSWORD=""
API_TOKEN=""
printf 'env-victim' > "$BASE_DIR/env-victim"
ln -s "$BASE_DIR/env-victim" "$ENV_FILE"
if write_env; then printf 'env-accepted\n'; else printf 'env-refused\n'; fi
printf 'ENV-VICTIM<%s>\n' "$(cat "$BASE_DIR/env-victim")"

SERVICE_MODE=user
XDG_CONFIG_HOME="$BASE_DIR/xdg"
mkdir -p "$XDG_CONFIG_HOME/systemd/user"
printf 'unit-victim' > "$BASE_DIR/unit-victim"
ln -s "$BASE_DIR/unit-victim" "$XDG_CONFIG_HOME/systemd/user/dsh-chamber-gateway.service"
gateway_exec() { printf '/tmp/gateway'; }
systemctl() { printf 'systemctl-called\n'; }
if write_unit; then printf 'unit-accepted\n'; else printf 'unit-refused\n'; fi
printf 'UNIT-VICTIM<%s>\n' "$(cat "$BASE_DIR/unit-victim")"
`)
  assert.match(output, /env-refused/)
  assert.match(output, /ENV-VICTIM<env-victim>/)
  assert.match(output, /unit-refused/)
  assert.match(output, /UNIT-VICTIM<unit-victim>/)
  assert.doesNotMatch(output, /systemctl-called/)
})

test('systemd unit EnvironmentFile line is unquoted (systemd does not support quoting there)', () => {
  // systemd's EnvironmentFile= directive takes the path verbatim: quotes are
  // treated as literal characters and the file silently fails to load. The
  // unit template must emit the raw path (ExecStart= is the only place where
  // quoting is legal).
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
ENV_FILE="$GATEWAY_DIR/gateway.env"
mkdir -p "$GATEWAY_DIR"
GATEWAY_PORT=30801
DSH_PORT=30800
BIND_HOST=127.0.0.1
DSH_WS=""
ENV_ANCHOR=0
PUBLIC_ORIGIN=""
TRUSTED_PROXY=""
NO_AUTH=0
UI_PASSWORD=""
API_TOKEN=""
SERVICE_MODE=user
XDG_CONFIG_HOME="$BASE_DIR/xdg"
gateway_exec() { printf '/tmp/gateway'; }
systemctl() { return 0; }
write_unit
if grep -q '^EnvironmentFile='"$ENV_FILE"'$' "$XDG_CONFIG_HOME/systemd/user/dsh-chamber-gateway.service"; then printf 'envfile-unquoted\n'; fi
if grep -q 'EnvironmentFile="/' "$XDG_CONFIG_HOME/systemd/user/dsh-chamber-gateway.service"; then printf 'envfile-quoted\n'; fi
`)
  assert.match(output, /envfile-unquoted/)
  assert.doesNotMatch(output, /envfile-quoted/)
})

/** Minimal state write_unit reads; each unit test appends its own stubs. */
const UNIT_PREAMBLE = `
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
ENV_FILE="$GATEWAY_DIR/gateway.env"
mkdir -p "$GATEWAY_DIR"
GATEWAY_PORT=30801
DSH_PORT=30800
BIND_HOST=127.0.0.1
DSH_WS=""
ENV_ANCHOR=0
PUBLIC_ORIGIN=""
TRUSTED_PROXY=""
NO_AUTH=0
UI_PASSWORD=""
API_TOKEN=""
SERVICE_MODE=user
XDG_CONFIG_HOME="$BASE_DIR/xdg"
gateway_exec() { printf '/tmp/gateway'; }
systemctl() { return 0; }
`

const UNIT_TAIL = `
write_unit
cat "$XDG_CONFIG_HOME/systemd/user/dsh-chamber-gateway.service"
`

test('current-user units inject the login environment systemd omits without User=', () => {
  // systemd sets $HOME/$LOGNAME/$SHELL only for units carrying User=,
  // DynamicUser= or PAMName= (systemd.exec: SetLoginEnvironment= defaults to
  // true for exactly those, false otherwise). The "current user" service shape
  // carries none of them, so the unit used to start with an EMPTY HOME — in the
  // gateway process and in every child it spawns (managed dsh -> code runtime
  // -> bash tool -> gh / npm / git credential.helper): gh reported "not logged
  // in", npm could not find its cache, git credential helpers read no token.
  const runUser = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim()
  const output = runLibrary(`${UNIT_PREAMBLE}
SERVICE_USER=""
passwd_home_of() { printf '/home/probe-user'; }
${UNIT_TAIL}`, { HOME: '/decoy-home' })
  assert.doesNotMatch(output, /^User=/m, 'the current-user shape must not gain a User= line')
  assert.match(output, /^Environment=HOME=\/home\/probe-user$/m, 'HOME must be the passwd home')
  assert.match(output, new RegExp(`^Environment=LOGNAME=${runUser}$`, 'm'))
  assert.match(output, new RegExp(`^Environment=USER=${runUser}$`, 'm'))
  assert.match(output, /^Environment=XDG_CONFIG_HOME=\/home\/probe-user\/\.config$/m)
  assert.equal((output.match(/^Environment=/gm) ?? []).length, 4, 'exactly four login-environment lines')
  // The pitfall this pins: a multi-line login_env expanded into the comment
  // line above it would comment out HOME= and leave the rest live.
  assert.doesNotMatch(output, /^#.*Environment=/m, 'login_env must be its own heredoc line, never folded into a comment')
  assert.doesNotMatch(output, /decoy-home/, 'the ambient (possibly sudo-preserved) HOME must never reach the unit')
  const serviceAt = output.indexOf('[Service]')
  const installAt = output.indexOf('[Install]')
  for (const line of output.split('\n').filter((entry) => entry.startsWith('Environment='))) {
    const at = output.indexOf(line)
    assert.ok(at > serviceAt && at < installAt, `${line} must live in [Service]`)
  }
})

test('write_unit resolves the run user home from passwd, not from an exported HOME', () => {
  const runUser = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim()
  const output = runLibrary(`${UNIT_PREAMBLE}
SERVICE_USER=""
${UNIT_TAIL}`, { HOME: '/decoy-home' })
  const match = /^Environment=HOME=(.+)$/m.exec(output)
  assert.ok(match, 'the unit must carry an explicit HOME=')
  assert.notEqual(match[1], '/decoy-home', 'HOME must be looked up, never inherited from the installer environment')
  assert.ok(existsSync(match[1]), `resolved home must be a real directory on this host: ${match[1]}`)
  assert.match(output, new RegExp(`^Environment=LOGNAME=${runUser}$`, 'm'))
})

test('write_unit fails closed when the run user home cannot be resolved', () => {
  const result = runLibraryResult(`${UNIT_PREAMBLE}
SERVICE_USER=""
passwd_home_of() { printf ''; }
if write_unit; then printf 'UNIT-WRITTEN\\n'; else printf 'UNIT-REFUSED\\n'; fi
`)
  assert.notEqual(result.status, 0, 'an unresolvable home must not produce a unit with an empty HOME')
  assert.match(`${result.stderr}${result.stdout}`, /无法解析用户/)
  assert.doesNotMatch(result.stdout, /UNIT-WRITTEN/)
})

test('--service-user renders User= in the unit and is refused outside systemd mode', () => {
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
ENV_FILE="$GATEWAY_DIR/gateway.env"
mkdir -p "$GATEWAY_DIR"
GATEWAY_PORT=30801
DSH_PORT=30800
BIND_HOST=127.0.0.1
DSH_WS=""
ENV_ANCHOR=0
PUBLIC_ORIGIN=""
TRUSTED_PROXY=""
NO_AUTH=0
UI_PASSWORD=""
API_TOKEN=""
SERVICE_MODE=user
SERVICE_USER=dsh-chamber
XDG_CONFIG_HOME="$BASE_DIR/xdg"
gateway_exec() { printf '/tmp/gateway'; }
systemctl() { return 0; }
write_unit
cat "$XDG_CONFIG_HOME/systemd/user/dsh-chamber-gateway.service"
`)
  assert.match(output, /^User=dsh-chamber$/m, 'SERVICE_USER must render as a User= line in the unit')
  assert.doesNotMatch(output, /^Environment=HOME=/m, 'User= units get HOME from systemd; the installer must not inject its own')
  const refused = runLibraryResult(`
SERVICE_MODE=foreground
SERVICE_USER=dsh-chamber
validate_service_user
`)
  assert.notEqual(refused.status, 0, '--service-user must be refused outside the systemd service shape')
  assert.match(`${refused.stderr}${refused.stdout}`, /仅支持 systemd 系统服务形态/)
})

test('validate_service_user and ownership tolerate an unset SERVICE_USER (install path)', () => {
  // Regression: the install flow (do_install step 0) calls validate_service_user
  // BEFORE gateway.conf is loaded, so SERVICE_USER is never assigned there.
  // Under `set -u` a bare $SERVICE_USER was an unbound-variable death.
  const output = runLibrary(`
unset SERVICE_USER
validate_service_user
apply_service_user_ownership
printf 'ok\\n'
`)
  assert.match(output, /ok/, 'unset SERVICE_USER must be a no-op, not an unbound-variable error')
})

test('download_verify RETURN trap must not re-fire with tmp unset in the caller', () => {
  // Regression: on some bash versions (3.2 and several 4.x/5.x) a RETURN trap
  // set inside a function is not cleared when that function returns — it
  // migrates up the call stack and fires again at each enclosing function's
  // return. download_verify's `trap 'rm -rf "$tmp"' RETURN` therefore fired a
  // second time at do_install's return, after $tmp (a download_verify local)
  // was already destroyed: under `set -u` the install died with
  // 'line <do_install def>: tmp: unbound variable' right after the completion
  // messages. The trap body must self-disarm and guard `${tmp:-}` so a stale
  // firing is a no-op instead of a crash.
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
mkdir -p "$GATEWAY_DIR"
curl() {
  local out=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "-o" ]]; then out="$2"; shift 2; else shift; fi
  done
  [[ -n "$out" ]] && printf 'fake-artifact\\n' > "$out"
}
sha256sum() { return 0; }
VERSION=9.9.9
flow() {
  download_verify "$GATEWAY_DIR"
  printf 'flow-return-ok\\n'
}
flow
printf 'done\\n'
`)
  assert.match(output, /flow-return-ok/, 'caller functions must survive their return without a set -u crash')
  assert.match(output, /done/)
})

test('suggest_port splits its locals so $base is bound before $p reads it', () => {
  // Regression: `local base="$1" p="$base"` expands $base before the local
  // assignment takes effect — under `set -u` the wizard crashed with
  // 'base: unbound variable' on ANY occupied default port (same bug class as
  // the SERVICE_USER unbound). Both locals must be separate statements.
  const output = runLibrary(`
p=$(suggest_port "$DEFAULT_GATEWAY_PORT")
printf 'suggested=%s\\n' "$p"
`)
  assert.match(output, /^suggested=[0-9]+$/m, 'suggest_port must return a numeric port without a set -u crash')
})

test('foreground launch preserves each dsh path and auth argument as one argv entry', () => {
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
ENV_FILE="$BASE_DIR/gateway.env"
printf '%s\\n' 'SAFE_ENV="yes"' > "$ENV_FILE"
DSH_WS="/tmp/dsh anchor'with%percent and spaces"
ENV_ANCHOR=0
NO_AUTH=1
GATEWAY_PORT=30801
gateway_exec() { printf '/tmp/gateway binary'; }
nohup() { printf '<%s>\\n' "$@"; }
process_start_identity() { printf '%s:fixture' "$1"; }
health_wait() { return 0; }
start_foreground
wait
cat "$BASE_DIR/run/gateway.log"
`)
  assert.deepEqual(output.trimEnd().split('\n').slice(-5), [
    '</tmp/gateway binary>',
    '<serve>',
    '<--dsh-path>',
    "</tmp/dsh anchor'with%percent and spaces>",
    '<--no-auth>',
  ])
})

test('foreground mode never evaluates systemd EnvironmentFile credentials as Bash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-installer-backtick-'))
  const sentinel = join(dir, 'command-substitution-ran')
  const payload = `pa\`touch ${sentinel}\`$$ word"quote\\slash\nDSH_GATEWAY_TOKEN="injected-line"\nsecond-line\n`
  const token = '0123456789abcdef0123456789abcdef'
  try {
    const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
CONF_FILE="$GATEWAY_DIR/gateway.conf"
ENV_FILE="$BASE_DIR/gateway.env"
mkdir -p "$GATEWAY_DIR"
GATEWAY_PORT=30801
DSH_PORT=30800
BIND_HOST=127.0.0.1
DSH_WS="/tmp/env anchor"
ENV_ANCHOR=1
PUBLIC_ORIGIN=""
TRUSTED_PROXY=""
NO_AUTH=0
VERSION=1.0.0
INSTALL_METHOD=local
SERVICE_MODE=foreground
UI_PASSWORD="$PAYLOAD"
API_TOKEN="$TOKEN"
write_config
# write_env 现在拒绝含换行的值（EnvironmentFile 单行条目纪律，与
# systemd_quote_arg 一致）。本用例模拟"换行豁免时期写入的遗留 env 文件"，
# 故按 systemd_env_assignment 的转义规则（先反斜杠后引号）直接构造文件，
# 继续验证数据式解析器对遗留多行值的处理与不可执行性。
printf 'DSH_GATEWAY_PASSWORD="%s"\n' "$ESCAPED_PAYLOAD" > "$ENV_FILE"
printf 'DSH_GATEWAY_TOKEN="%s"\n' "$TOKEN" >> "$ENV_FILE"
printf 'DSH_GATEWAY_DSH_PATH="/tmp/env anchor"\n' >> "$ENV_FILE"
# Model a pre-migration install whose foreground-only values exist solely in
# EnvironmentFile. load_conf must decode those assignments as data.
# (No "sed -i": its suffix-argument spelling differs between BSD and GNU sed —
# "-i ''" breaks under GNU, where the empty string becomes the script and the
# expression a filename. Redirect + mv is portable across both.)
sed -e '/^ENV_ANCHOR=/d;/^UI_PASSWORD=/d;/^API_TOKEN=/d' "$CONF_FILE" > "$CONF_FILE.tmp" && mv "$CONF_FILE.tmp" "$CONF_FILE"
UI_PASSWORD=""
API_TOKEN=""
DSH_WS=""
ENV_ANCHOR=0
load_conf
gateway_exec() { printf '/tmp/gateway'; }
nohup() { printf 'PASSWORD<%s>\\nTOKEN<%s>\\nANCHOR<%s>\\n' "$DSH_GATEWAY_PASSWORD" "$DSH_GATEWAY_TOKEN" "$DSH_GATEWAY_DSH_PATH"; }
process_start_identity() { printf '%s:fixture' "$1"; }
health_wait() { return 0; }
start_foreground
wait
cat "$BASE_DIR/run/gateway.log"
`, { PAYLOAD: payload, TOKEN: token, ESCAPED_PAYLOAD: payload.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") })
    assert.match(output, /PASSWORD</)
    assert.ok(output.includes(payload), 'credential bytes survive the data-only EnvironmentFile parser')
    assert.ok(output.includes(`TOKEN<${token}>`), 'an assignment-looking line inside the password cannot replace the real token')
    assert.ok(output.includes('ANCHOR</tmp/env anchor>'), 'the env anchor is restored for foreground update/restart')
    assert.equal(spawnSync('test', ['-e', sentinel]).status, 1, 'credential backticks must never execute')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the data-only EnvironmentFile parser preserves absent versus malformed status', () => {
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
ENV_FILE="$GATEWAY_DIR/gateway.env"
mkdir -p "$GATEWAY_DIR"
printf 'NOT_THE_KEY="ok"\n' > "$ENV_FILE"
if capture_systemd_env_value DSH_GATEWAY_PASSWORD; then printf 'missing-accepted\n'; else printf 'missing<%s>\n' "$?"; fi
printf 'DSH_GATEWAY_PASSWORD=unquoted\n' > "$ENV_FILE"
if capture_systemd_env_value DSH_GATEWAY_PASSWORD; then printf 'malformed-accepted\n'; else printf 'malformed<%s>\n' "$?"; fi
rm -f "$ENV_FILE"
if capture_systemd_env_value DSH_GATEWAY_PASSWORD; then printf 'absent-accepted\n'; else printf 'absent<%s>\n' "$?"; fi
`)
  assert.deepEqual(output.trimEnd().split('\n'), ['missing<3>', 'malformed<2>', 'absent<1>'])
})

test('external deployment predicate covers bind, public origin and trusted proxy uniformly', () => {
  const output = runLibrary(`
BIND_HOST=127.0.0.1
PUBLIC_ORIGIN=""
TRUSTED_PROXY=""
external_deployment && printf 'unexpected\\n' || printf 'local\\n'
PUBLIC_ORIGIN=https://gateway.example
external_deployment && printf 'origin\\n'
PUBLIC_ORIGIN=""
TRUSTED_PROXY=127.0.0.1
external_deployment && printf 'proxy\\n'
TRUSTED_PROXY=""
BIND_HOST=0.0.0.0
external_deployment && printf 'bind\\n'
`)
  assert.deepEqual(output.trimEnd().split('\n'), ['local', 'origin', 'proxy', 'bind'])
})

test('dsh workspace detection and verification support the real source-tree CLI path', () => {
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
DSH_WS="$BASE_DIR/dsh-source"
mkdir -p "$DSH_WS/apps/cli/src"
printf 'source-entry\n' > "$DSH_WS/apps/cli/src/bin.ts"
DSH_FOUND=explicit
SKIP_DSH=0
node() {
  printf '<%s>\n' "$@" > "$BASE_DIR/node-args"
  printf '0.2.0-source\n'
}
detect_dsh
printf 'FOUND<%s>\n' "$DSH_FOUND"
printf 'VERSION<%s>\n' "$(verify_dsh "$DSH_WS")"
cat "$BASE_DIR/node-args"

BAD="$BASE_DIR/wrong-old-layout"
mkdir -p "$BAD/node_modules/@deepseek-ai/dsh/apps/cli/src"
printf stale > "$BAD/node_modules/@deepseek-ai/dsh/apps/cli/src/bin.ts"
if dsh_workspace_has_entry "$BAD"; then printf 'wrong-layout-accepted\n'; else printf 'wrong-layout-refused\n'; fi
`)
  assert.match(output, /FOUND<explicit>/)
  assert.match(output, /VERSION<0\.2\.0-source>/)
  assert.match(output, /<--import>/)
  assert.match(output, /<tsx\/esm>/)
  assert.match(output, /<[^\n]*\/apps\/cli\/src\/bin\.ts>/)
  assert.match(output, /wrong-layout-refused/)
})

test('--no-auth remains inert when an explicit credential is present', () => {
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
ENV_FILE="$GATEWAY_DIR/gateway.env"
mkdir -p "$GATEWAY_DIR"
GATEWAY_PORT=30801
DSH_PORT=30800
BIND_HOST=0.0.0.0
DSH_WS=""
ENV_ANCHOR=0
PUBLIC_ORIGIN=""
TRUSTED_PROXY=""
NO_AUTH=1
UI_PASSWORD="$PAYLOAD"
API_TOKEN=""
write_env
capture_systemd_env_value DSH_GATEWAY_PASSWORD
printf 'ENV<%s>\n' "$SYSTEMD_ENV_VALUE"
gateway_exec() { printf '/tmp/gateway'; }
nohup() { printf 'FOREGROUND<%s>\n' "$DSH_GATEWAY_PASSWORD"; }
process_start_identity() { printf '%s:fixture' "$1"; }
health_wait() { return 0; }
start_foreground
wait
cat "$BASE_DIR/run/gateway.log"
`, { PAYLOAD: 'correct-horse-battery' })
  assert.match(output, /ENV<correct-horse-battery>/)
  assert.match(output, /FOREGROUND<correct-horse-battery>/)
})

test('local publication is fresh-only and current replacement refuses a real directory', () => {
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
VERSIONS_DIR="$GATEWAY_DIR/versions"
mkdir -p "$VERSIONS_DIR/2.0.0"
printf stale > "$VERSIONS_DIR/2.0.0/removed-in-new-release"
if stage_local_version /unused.tgz 2.0.0; then printf 'overlay-accepted\\n'; else printf 'overlay-refused\\n'; fi
printf '%s\\n' "$(cat "$VERSIONS_DIR/2.0.0/removed-in-new-release")"
mkdir -p "$GATEWAY_DIR/current" "$VERSIONS_DIR/3.0.0"
if switch_local_current "$VERSIONS_DIR/3.0.0"; then printf 'directory-replaced\\n'; else printf 'directory-refused\\n'; fi
`)
  assert.match(output, /overlay-refused/)
  assert.match(output, /\nstale\n/)
  assert.match(output, /directory-refused/)
})

test('local staging validates a fresh artifact and switches current atomically', () => {
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
VERSIONS_DIR="$GATEWAY_DIR/versions"
tar() {
  local destination=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "-C" ]]; then destination="$2"; shift 2; else shift; fi
  done
  mkdir -p "$destination/dist/pnpm/bin"
  printf '%s\\n' '{"name":"@dsh-chamber/gateway","version":"2.0.0"}' > "$destination/package.json"
  printf '%s\\n' '#!/usr/bin/env node' > "$destination/dist/cli.js"
  printf '%s\\n' '#!/usr/bin/env node' > "$destination/dist/pnpm/bin/pnpm.cjs"
}
stage_local_version /fixture.tgz 2.0.0
switch_local_current "$VERSIONS_DIR/2.0.0"
printf '%s\\n' "$(readlink "$GATEWAY_DIR/current")"
`)
  assert.equal(output.trimEnd().split('\n').at(-1)?.endsWith('/gateway/versions/2.0.0'), true)
})

test('local staging refuses an artifact without the bundled pnpm (dist/pnpm/bin/pnpm.cjs)', () => {
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
VERSIONS_DIR="$GATEWAY_DIR/versions"
tar() {
  local destination=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "-C" ]]; then destination="$2"; shift 2; else shift; fi
  done
  mkdir -p "$destination/dist"
  printf '%s\\n' '{"name":"@dsh-chamber/gateway","version":"2.0.0"}' > "$destination/package.json"
  printf '%s\\n' '#!/usr/bin/env node' > "$destination/dist/cli.js"
}
if stage_local_version /fixture.tgz 2.0.0; then printf 'missing-pnpm-accepted\\n'; else printf 'missing-pnpm-refused\\n'; fi
printf 'staged=%s\\n' "$([[ -e "$VERSIONS_DIR/2.0.0" ]] && printf yes || printf no)"
`)
  assert.match(output, /missing-pnpm-refused/)
  assert.match(output, /staged=no/)
})

test('health proof rejects an old listener identity and requires the target package version', () => {
  const output = runLibrary(`
SERVICE_MODE=user
IDENTITY=old-boot
curl() { return 0; }
launch_identity() { printf '%s' "$IDENTITY"; }
installed_gateway_version() { printf '%s' "$INSTALLED"; }
sleep() { :; }
INSTALLED=2.0.0
if health_wait 30801 1 2.0.0 old-boot; then printf 'old-accepted\\n'; else printf 'old-refused\\n'; fi
IDENTITY=new-boot
INSTALLED=1.0.0
if health_wait 30801 1 2.0.0 old-boot; then printf 'wrong-version-accepted\\n'; else printf 'wrong-version-refused\\n'; fi
INSTALLED=2.0.0
health_wait 30801 1 2.0.0 old-boot
printf 'new-accepted\\n'
`)
  assert.match(output, /old-refused/)
  assert.match(output, /wrong-version-refused/)
  assert.match(output, /new-accepted/)
})

test('service restart preserves the configured systemd scope', () => {
  const output = runLibrary(`
systemctl() { printf '<%s>\\n' "$@"; }
SERVICE_MODE=user
restart_service
SERVICE_MODE=systemd
restart_service
`)
  assert.deepEqual(output.trimEnd().split('\n'), [
    '<--user>', '<restart>', '<dsh-chamber-gateway.service>',
    '<restart>', '<dsh-chamber-gateway.service>',
  ])
})

test('update keeps explicit --version and rolls local current back when restart fails', () => {
  const base = mkdtempSync(join(tmpdir(), 'gateway-installer-update-'))
  const gatewayDir = join(base, 'gateway')
  const versionsDir = join(gatewayDir, 'versions')
  const oldTree = join(versionsDir, '1.0.0')
  const current = join(gatewayDir, 'current')
  try {
    writeGatewayTree(oldTree, '1.0.0')
    const result = runLibraryResult(`
mkdir -p "$GATEWAY_DIR" "$VERSIONS_DIR/1.0.0"
ln -s "$VERSIONS_DIR/1.0.0" "$GATEWAY_DIR/current"
VERSION=1.0.0
INSTALL_METHOD=local
GATEWAY_PORT=30801
DSH_PORT=30800
BIND_HOST=127.0.0.1
PUBLIC_ORIGIN=""
TRUSTED_PROXY=""
SERVICE_MODE=user
DSH_WS=/tmp/dsh
NO_AUTH=1
ENV_ANCHOR=0
UI_PASSWORD=""
API_TOKEN=""
write_config

# Simulate the parsed CLI flag before cmd_update reloads gateway.conf.
VERSION=v2.0.0
resolve_version() { printf '%s\\n' "$VERSION" > "$BASE_DIR/resolved-input"; VERSION="\${VERSION#v}"; }
download_verify() { mkdir -p "$1"; : > "$1/dsh-chamber-gateway-\${VERSION}.tgz"; }
stage_local_version() { mkdir -p "$VERSIONS_DIR/$2"; }
systemctl_for_mode() { [[ "$1" == "is-active" ]] && return 1; return 0; }
launch_identity() { printf old-boot; }
write_unit() { return 0; }
RESTARTS=0
restart_service() { RESTARTS=$((RESTARTS + 1)); printf '%s\\n' "$RESTARTS" >> "$BASE_DIR/restarts"; [[ "$RESTARTS" -gt 1 ]]; }
health_wait() { return 0; }
cmd_update
`, { DSH_CHAMBER_BASE_DIR: base })
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
    assert.match(`${result.stdout}${result.stderr}`, /升级失败，已回滚到/, 'rollback must die loudly, not end rc=0 (trap-independent)')
    assert.equal(readFileSync(join(base, 'resolved-input'), 'utf8').trim(), 'v2.0.0')
    assert.equal(readlinkSync(current), oldTree, 'rollback restores the exact old current target')
    assert.equal(existsSync(join(versionsDir, '2.0.0')), false, 'unreferenced failed target is removed after pointer rollback')
    assert.match(readFileSync(join(gatewayDir, 'gateway.conf'), 'utf8'), /^VERSION=1\.0\.0$/m)
    assert.deepEqual(
      readFileSync(join(base, 'restarts'), 'utf8').trimEnd().split('\n'),
      ['1', '2'],
      `${result.stdout}${result.stderr}`,
    )
    assert.equal(lstatSync(current).isSymbolicLink(), true)
    assert.doesNotMatch(result.stdout, /已升级到/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('foreground update restores the old local pointer and relaunches after target launch failure', () => {
  const base = mkdtempSync(join(tmpdir(), 'gateway-installer-foreground-rollback-'))
  const oldTree = join(base, 'gateway', 'versions', '1.0.0')
  const current = join(base, 'gateway', 'current')
  try {
    writeGatewayTree(oldTree, '1.0.0')
    const result = runLibraryResult(`
ln -s "$VERSIONS_DIR/1.0.0" "$GATEWAY_DIR/current"
VERSION=1.0.0
INSTALL_METHOD=local
GATEWAY_PORT=30801
DSH_PORT=30800
BIND_HOST=127.0.0.1
PUBLIC_ORIGIN=""
TRUSTED_PROXY=""
SERVICE_MODE=foreground
DSH_WS=/tmp/dsh
NO_AUTH=1
ENV_ANCHOR=0
UI_PASSWORD=""
API_TOKEN=""
write_config
VERSION=2.0.0
resolve_version() { :; }
download_verify() { : > "$1/dsh-chamber-gateway-\${VERSION}.tgz"; }
stage_local_version() { mkdir -p "$VERSIONS_DIR/$2"; }
launch_identity() { printf old-boot; }
STARTS=0
start_foreground() { STARTS=$((STARTS + 1)); printf '%s:%s\\n' "$STARTS" "$1" >> "$BASE_DIR/starts"; [[ "$STARTS" -gt 1 ]]; }
cmd_update
`, { DSH_CHAMBER_BASE_DIR: base })
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
    assert.match(`${result.stdout}${result.stderr}`, /升级失败，已回滚到/, 'rollback must die loudly, not end rc=0 (trap-independent)')
    assert.equal(readlinkSync(current), oldTree)
    assert.deepEqual(readFileSync(join(base, 'starts'), 'utf8').trimEnd().split('\n'), ['1:2.0.0', '2:1.0.0'])
    assert.equal(existsSync(join(base, 'gateway', 'versions', '2.0.0')), false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('global system update reinstalls the secured old artifact when restart fails', () => {
  const base = mkdtempSync(join(tmpdir(), 'gateway-installer-global-rollback-'))
  const gatewayDir = join(base, 'gateway')
  try {
    mkdirSync(gatewayDir, { recursive: true })
    writeFileSync(join(gatewayDir, 'dsh-chamber-gateway-1.0.0.tgz'), 'old')
    const result = runLibraryResult(`
VERSION=1.0.0
INSTALL_METHOD=global
GATEWAY_PORT=30801
DSH_PORT=30800
BIND_HOST=127.0.0.1
PUBLIC_ORIGIN=""
TRUSTED_PROXY=""
SERVICE_MODE=systemd
DSH_WS=/tmp/dsh
NO_AUTH=1
ENV_ANCHOR=0
UI_PASSWORD=""
API_TOKEN=""
write_config
VERSION=2.0.0
resolve_version() { :; }
download_verify() { : > "$1/dsh-chamber-gateway-\${VERSION}.tgz"; }
launch_identity() { printf old-boot; }
systemctl_for_mode() { [[ "$1" == "is-active" ]] && return 1; return 0; }
npm() { printf '%s\\n' "\${!#}" >> "$BASE_DIR/npm-artifacts"; }
write_unit() { return 0; }
RESTARTS=0
restart_service() { RESTARTS=$((RESTARTS + 1)); [[ "$RESTARTS" -gt 1 ]]; }
health_wait() { return 0; }
cmd_update
`, { DSH_CHAMBER_BASE_DIR: base })
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
    assert.match(`${result.stdout}${result.stderr}`, /升级失败，已回滚到/, 'rollback must die loudly, not end rc=0 (trap-independent)')
    assert.deepEqual(readFileSync(join(base, 'npm-artifacts'), 'utf8').trimEnd().split('\n'), [
      join(gatewayDir, 'dsh-chamber-gateway-2.0.0.tgz'),
      join(gatewayDir, 'dsh-chamber-gateway-1.0.0.tgz'),
    ])
    assert.match(readFileSync(join(gatewayDir, 'gateway.conf'), 'utf8'), /^VERSION=1\.0\.0$/m)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('private layout dirs converge to 0700 even when created under a loose umask', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-installer-layout-'))
  try {
    const base = join(dir, 'base')
    const harness = join(dir, 'harness.sh')
    // 全局 umask 077 之外的第二道保险：即使调用方以松散 umask（022）创建，
    // ensure_private_layout 也必须把全部自有目录收敛到 0700。
    writeFileSync(harness, harnessSource(`umask 0022\nensure_private_layout\nprintf 'layout-ok\\n'`), { mode: 0o700 })
    const result = spawnSync('bash', [harness], {
      encoding: 'utf8',
      env: { ...process.env, DSH_CHAMBER_BASE_DIR: base },
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /layout-ok/)
    for (const sub of ['', 'gateway', 'gateway/versions', 'gateway/dsh-anchor', 'bin', 'run']) {
      assert.equal(statSync(join(base, sub)).mode & 0o777, 0o700, join(base, sub))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('library EXIT-trap contract: clean ends fail closed without the EXITED_OK marker', () => {
  // 9297eac registers `trap on_exit_cleanup EXIT` at library top level:
  // rc=0 ends only count as success with EXITED_OK=1 (the real main sets it
  // before its final exit); expansion-class crashes reach the trap with $?
  // masked to 0, so the marker is the discriminator. This pins the raw
  // semantics so harness changes can never silently mask real failures.
  const dir = mkdtempSync(join(tmpdir(), 'gateway-installer-trap-'))
  try {
    const harness = join(dir, 'harness.sh')
    const run = (tail: string) => {
      writeFileSync(harness, `${library}\nprintf 'body-ran\\n'\n${tail}`, { mode: 0o700 })
      return spawnSync('bash', [harness], { encoding: 'utf8', env: INSTALLER_ENV })
    }
    const clean = run('')
    assert.equal(clean.status, 1, 'a clean rc=0 end without EXITED_OK=1 must fail closed through the trap')
    assert.match(clean.stdout, /body-ran/)
    const marked = run('EXITED_OK=1\n')
    assert.equal(marked.status, 0, 'EXITED_OK=1 marks the natural end as success')
    const coded = run('exit 3\n')
    assert.equal(coded.status, 3, 'a non-zero rc is preserved through the trap')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('real installer exit wiring: --help exits 0, missing option values die in parse', () => {
  // No test exercised the real script's exit-code wiring (usage EXITED_OK
  // path, parse-level die) — only library-slice harnesses. Parse failures
  // die before any BASE_DIR/wizard mutation, so they are safe to run here.
  const help = spawnSync('bash', [installer, '--help'], { encoding: 'utf8', env: INSTALLER_ENV })
  assert.equal(help.status, 0, `${help.stdout}${help.stderr}`)
  assert.match(help.stdout, /install-gateway\.sh/)
  const missing = spawnSync('bash', [installer, 'install', '--version'], { encoding: 'utf8', env: INSTALLER_ENV })
  assert.equal(missing.status, 1, 'a value option without a value must fail fast in parse')
  assert.match(`${missing.stdout}${missing.stderr}`, /需要值/)
})

test('overlay install rollback restores the old pointer/conf and restarts the old deployment', () => {
  // Regression (S1/S4): restore_overlay_install parsed the old conf with a
  // quoted-value regex while write_config emits %q bare tokens — old_mode/
  // old_ver were always empty (no restart) — and the pointer snapshot was
  // taken AFTER switch_local_current (rollback restored the NEW tree).
  const base = mkdtempSync(join(tmpdir(), 'gateway-installer-overlay-rollback-'))
  try {
    const gatewayDir = join(base, 'gateway')
    const versionsDir = join(gatewayDir, 'versions')
    const oldTree = join(versionsDir, '1.0.0')
    writeGatewayTree(oldTree, '1.0.0')
    // A real previous install: conf on disk (VERSION=1.0.0, foreground) and
    // gateway/current -> the old tree.
    writeFileSync(join(gatewayDir, 'gateway.conf'), [
      '# fixture conf',
      'VERSION=1.0.0',
      'INSTALL_METHOD=local',
      'GATEWAY_PORT=30801',
      'DSH_PORT=30800',
      'BIND_HOST=127.0.0.1',
      'SERVICE_MODE=foreground',
      'NO_AUTH=1',
      '',
    ].join('\n'))
    symlinkSync(oldTree, join(gatewayDir, 'current'))
    const result = runLibraryResult(`
SKIP_DSH=1
INSTALL_METHOD=local
VERSION=2.0.0
SERVICE_MODE=foreground
download_verify() { mkdir -p "$1"; : > "$1/dsh-chamber-gateway-\${VERSION}.tgz"; }
stage_local_version() { mkdir -p "$VERSIONS_DIR/$2/dist/pnpm/bin"; printf '%s\\n' '{"name":"@dsh-chamber/gateway","version":"'$2'"}' > "$VERSIONS_DIR/$2/package.json"; printf '%s\\n' '#!/usr/bin/env node' > "$VERSIONS_DIR/$2/dist/cli.js"; : > "$VERSIONS_DIR/$2/dist/pnpm/bin/pnpm.cjs"; }
write_config() { return 1; }
start_foreground() { printf '%s:%s\\n' "\${1:-}" "\${2:-}" >> "$BASE_DIR/restarts"; return 0; }
health_wait() { return 0; }
do_install
`, { DSH_CHAMBER_BASE_DIR: base })
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
    assert.match(`${result.stdout}${result.stderr}`, /安装配置写入失败/)
    assert.equal(readlinkSync(join(gatewayDir, 'current')), oldTree, 'rollback must restore the OLD pointer target')
    assert.match(readFileSync(join(gatewayDir, 'gateway.conf'), 'utf8'), /^VERSION=1\.0\.0$/m, 'rollback must restore the old conf')
    const restarts = readFileSync(join(base, 'restarts'), 'utf8').trimEnd().split('\n')
    assert.deepEqual(restarts, ['1.0.0:'], 'restore must restart the old deployment with the old version (S1 old_ver parse)')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('installer has no unbraced $VAR immediately followed by a multibyte char (bash 3.2 name-scan crash class)', () => {
  // bash 3.2 under a UTF-8 LC_CTYPE eats the first byte of a multibyte char
  // into the variable name: "$x）" → "x…: unbound variable" under set -u.
  // The runtime test only bites on bash-3.2 hosts (macOS); Linux CI (bash 5)
  // cannot reproduce it — this source assertion makes the class CI-effective.
  const offenders: string[] = []
  for (const [i, line] of source.split('\n').entries()) {
    // Strip comments and single-quoted regions crudely: only flag expansions
    // that sit outside single quotes (double-quoted or bare).
    let cleaned = line.replace(/'[^']*'/g, "''").replace(/#.*$/, '')
    for (const m of cleaned.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)([^\x00-\x7f])/g)) {
      offenders.push(`${i + 1}: ${m[0]} in ${line.trim().slice(0, 100)}`)
    }
  }
  assert.deepEqual(offenders, [], 'unbraced variable before a multibyte char crashes bash 3.2 under UTF-8 locales')
})

test('the host-safe stub really intercepts a bare systemctl from a harness body', { skip: process.platform !== 'linux' ? 'linux-only (the stub is inert without a real systemctl)' : false }, () => {
  // 2026-12 复查 MINOR：上面那条只钉"组合方式"；这条钉**桩本身有效**——在真实
  // systemctl 存在的机器上，harness 里的裸 `systemctl stop <unit>` 必须被截获并
  // 打印 systemctl-stubbed: 标记（macOS 上桩按设计不生效，故跳过）。
  const result = runLibraryResult(`systemctl stop dsh-chamber-gateway.service`)
  assert.match(result.stderr, /systemctl-stubbed: stop dsh-chamber-gateway\.service/,
    'the injected stub must intercept the installer\'s bare systemctl call')
})

test('every harness is composed through harnessSource (host-global stubs cannot be bypassed)', () => {
  // The D2 cross-mode cleanup calls BARE `systemctl` with the fixed unit name
  // `dsh-chamber-gateway.service` (scripts/install-gateway.sh:2619-2623), so a
  // harness body that reaches an install/update flow without the injected stub
  // stops and disables the REAL service of the machine running the suite (that
  // is how this suite killed the project's own gateway rig three times on
  // 2026-09-08). `harnessSource()` is the only thing keeping that out, so pin
  // the invariant mechanically: every raw harness must be an explicit,
  // systemctl-free allowlist entry.
  //
  // 2026-12 split (P0 test reorg): the installer suite is now the family
  // install-script.test.ts + install-anchor.test.ts +
  // test/support/installer-harness.ts. The scan covers every family member and
  // aggregates their write sites, so a harness write moved into a sibling
  // cannot escape the guard. Ownership is pinned the same way: a NON-family
  // file under test/packaging that mentions the installer fails the walk
  // below, and admitting a new file means extending the family list here.
  const testDir = fileURLToPath(new URL('.', import.meta.url))
  const family = [
    fileURLToPath(import.meta.url),
    join(testDir, 'install-anchor.test.ts'),
    join(testDir, '..', 'support', 'installer-harness.ts'),
  ]
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : [join(dir, entry.name)])
  const siblings = walk(testDir).filter(path =>
    (path.endsWith('.ts') || path.endsWith('.mjs')) && !family.includes(path))
  const foreignInstallerRefs = siblings.filter(path =>
    readFileSync(path, 'utf8').includes('install-gateway'))
  assert.deepEqual(foreignInstallerRefs, [],
    'installer harnesses belong to the install-script family (composed through harnessSource); a new file touching the installer must extend this guard')
  // Structural allowlist (a substring check would let a body that merely
  // mentions the marker pass): the single allowed raw body is the EXIT-trap
  // harness — a printf-only template over `${library}`/`${tail}` with no other
  // command, separator, substitution or systemctl call.
  const isAllowlistedRawBody = (body: string): boolean =>
    body.startsWith('`${library}')
    && body.endsWith('${tail}`')
    && /printf 'body-ran/.test(body)
    && !/[;&|]|systemctl|\$\(/.test(body)
  // Shape-robust scan (2026-12 review MINOR): an exact-literal regex misses a
  // body containing a comma, different write options, a differently named path
  // variable, or a bare `writeFileSync(harness, body)`. Walk EVERY
  // `writeFileSync(` call, take its balanced argument list, and judge the
  // second argument.
  const argumentsOf = (text: string, open: number): string[] => {
    const parts: string[] = []
    let depth = 1
    let current = ''
    for (let i = open + 1; i < text.length; i += 1) {
      const char = text[i]
      if (char === '(' || char === '[' || char === '{') depth += 1
      else if (char === ')' || char === ']' || char === '}') {
        depth -= 1
        if (depth === 0) { parts.push(current.trim()); return parts }
      }
      if (char === ',' && depth === 1) { parts.push(current.trim()); current = ''; continue }
      current += char
    }
    return parts
  }
  // Comments never count as call sites: this test's own prose names
  // `writeFileSync(harness, body)` as an evasion example. Line comments are
  // removed by dropping whole comment-only lines (a regex would also eat a
  // call site that follows a `//` inside a string).
  const codeOf = (text: string): string => text
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  // The second argument must BE one complete harnessSource(...) call: a
  // trailing concatenation (`harnessSource(x) + raw`) is still a raw body.
  const isCompleteHarnessSourceCall = (body: string): boolean => {
    if (!body.startsWith('harnessSource(')) return false
    const args = argumentsOf(body, 'harnessSource'.length)
    if (args.length !== 1) return false
    // argumentsOf returns at the balanced close paren; require nothing after it.
    return body.trimEnd().endsWith(')')
      && body.slice(body.trimEnd().length - 1) === ')'
      && !/\+/.test(body.slice(0, body.lastIndexOf(')')))
  }
  const calls: { file: string; target: string; body: string; options: string }[] = []
  for (const file of family) {
    const code = codeOf(readFileSync(file, 'utf8'))
    // An aliased writer cannot be followed statically — forbid the shape instead.
    assert.doesNotMatch(code,
      /=\s*(?:write|append|copy)FileSync\b/,
      `do not alias the write API: the harness guard cannot follow aliases (${file})`)
    // Identifiers that hold a harness path (`const h = join(dir, 'harness.sh')`)
    // so an aliased target cannot slip through.
    const harnessAliases = new Set<string>()
    for (const match of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^\n]*?(?:harness|\.sh)/g)) {
      harnessAliases.add(match[1])
    }
    for (const match of code.matchAll(/\b(?:write|append|copy)FileSync\b/g)) {
      const index = match.index
      const open = code.indexOf('(', index + match[0].length)
      // `writeFileSync (` (whitespace before the paren) must not slip through.
      if (open === -1 || !/^\s*$/.test(code.slice(index + match[0].length, open))) continue
      const args = argumentsOf(code, open)
      if (args.length < 2) continue
      const [target, body, options = ''] = args
      const inScope = /harness/i.test(target)
        || /\.(?:sh|bash|zsh|ksh)['"`]/.test(target)
        || /0o700/.test(options)
        || harnessAliases.has(target)
      if (!inScope) continue
      calls.push({ file, target, body, options })
    }
  }
  assert.ok(calls.length >= 3, `expected the harness write sites to stay discoverable, saw ${calls.length}`)
  const offenders = calls.filter(({ body }) =>
    !isCompleteHarnessSourceCall(body) && !isAllowlistedRawBody(body))
  assert.deepEqual(offenders, [],
    'every harness body must be composed through harnessSource() (or be an allowlisted stub-free body) — a raw body can reach the real systemctl')
})
