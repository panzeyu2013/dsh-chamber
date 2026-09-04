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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const installer = fileURLToPath(new URL('../../../scripts/install-gateway.sh', import.meta.url))
const source = readFileSync(installer, 'utf8')
const mainMarker = '\nSUBCOMMAND="install"\n'
const mainOffset = source.indexOf(mainMarker)
assert.notEqual(mainOffset, -1, 'installer main marker must remain discoverable')
const library = source.slice(0, mainOffset)

// The installer library registers `trap on_exit_cleanup EXIT` at top level:
// under the fail-closed guard, a clean rc=0 end only counts as success when
// the flow reached the EXITED_OK=1 marker (the real main sets it right before
// its final `exit`). Unit harnesses have no dispatcher, so the epilogue marks
// their natural end — mid-body crashes (die/set -u/expansion errors) abort
// before it and still fail closed through the trap.
const LIB_EPILOGUE = '\nEXITED_OK=1\n'

function runLibrary(body: string, env: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-installer-test-'))
  const harness = join(dir, 'harness.sh')
  try {
    writeFileSync(harness, `${library}\n${body}${LIB_EPILOGUE}`, { mode: 0o700 })
    const result = spawnSync('bash', [harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_CHAMBER_BASE_DIR: env.DSH_CHAMBER_BASE_DIR ?? join(dir, 'base'),
        ...env,
      },
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      throw new Error(`installer harness exited ${String(result.status)}\n${result.stdout}${result.stderr}`)
    }
    return result.stdout
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function runLibraryResult(body: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-installer-test-'))
  const harness = join(dir, 'harness.sh')
  try {
    writeFileSync(harness, `${library}\n${body}${LIB_EPILOGUE}`, { mode: 0o700 })
    return spawnSync('bash', [harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_CHAMBER_BASE_DIR: env.DSH_CHAMBER_BASE_DIR ?? join(dir, 'base'),
        ...env,
      },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeGatewayTree(root: string, version: string): void {
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@dsh-chamber/gateway', version }))
  writeFileSync(join(root, 'dist', 'cli.js'), '#!/usr/bin/env node\n')
}

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

test('system and user services enable against real boot targets', () => {
  const output = runLibrary(`
SERVICE_MODE=systemd
printf '%s\\n' "$(unit_wanted_by)"
SERVICE_MODE=user
printf '%s\\n' "$(unit_wanted_by)"
`)
  assert.deepEqual(output.trimEnd().split('\n'), ['multi-user.target', 'default.target'])
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
    writeFileSync(harness, `${library}\numask 0022\nensure_private_layout\nprintf 'layout-ok\\n'${LIB_EPILOGUE}`, { mode: 0o700 })
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
      return spawnSync('bash', [harness], { encoding: 'utf8' })
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
  const help = spawnSync('bash', [installer, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, `${help.stdout}${help.stderr}`)
  assert.match(help.stdout, /install-gateway\.sh/)
  const missing = spawnSync('bash', [installer, 'install', '--version'], { encoding: 'utf8' })
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

test('update dsh-anchor sync: flags exist and are parsed for update only', () => {
  // The option parser lives in the dispatcher half (not the sourced library),
  // so the parse arms are asserted on the source itself.
  assert.match(source, /--dsh-upgrade\) DSH_UPGRADE=1; DSH_UPGRADE_FLAG=1; shift ;;/)
  assert.match(source, /--no-dsh-upgrade\) DSH_UPGRADE=0; DSH_UPGRADE_FLAG=1; shift ;;/)
  assert.match(source, /^DSH_UPGRADE=1$/m, 'default must be upgrade')
  // Non-update subcommands must warn instead of silently ignoring the flags.
  assert.match(source, /dsh \u951a\u540c\u6b65\u9009\u9879\u53ea\u5f71\u54cd update/)
})

test('dsh_baseline_of_manifest reads dshAnchorVersion and refuses missing/invalid values', () => {
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
mkdir -p "$BASE_DIR/a" "$BASE_DIR/b" "$BASE_DIR/c"
printf '%s\\n' '{"name":"@dsh-chamber/gateway","version":"1.0.0","dshAnchorVersion":"0.1.2-rc.1"}' > "$BASE_DIR/a/package.json"
printf '%s\\n' '{"name":"@dsh-chamber/gateway","version":"1.0.0"}' > "$BASE_DIR/b/package.json"
printf '%s\\n' '{"name":"@dsh-chamber/gateway","version":"1.0.0","dshAnchorVersion":"not-a-version"}' > "$BASE_DIR/c/package.json"
printf 'A=<%s>\\n' "$(dsh_baseline_of_manifest "$BASE_DIR/a/package.json" || true)"
printf 'B=<%s>\\n' "$(dsh_baseline_of_manifest "$BASE_DIR/b/package.json" || true)"
printf 'C=<%s>\\n' "$(dsh_baseline_of_manifest "$BASE_DIR/c/package.json" || true)"
printf 'T=<%s>\\n' "$(dsh_baseline_of_tree "$BASE_DIR/a" || true)"
`)
  assert.match(output, /A=<0\.1\.2-rc\.1>/)
  assert.match(output, /B=<>/, 'missing field must fall back to empty')
  assert.match(output, /C=<>/, 'invalid value must be refused')
  assert.match(output, /T=<0\.1\.2-rc\.1>/)
})

test('dsh_baseline_of_tgz reads package/package.json (npm pack layout) and bare layout', () => {
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
mkdir -p "$GATEWAY_DIR" "$BASE_DIR/pack/package" "$BASE_DIR/plain"
printf '%s\\n' '{"dshAnchorVersion":"9.9.9"}' > "$BASE_DIR/pack/package/package.json"
printf '%s\\n' '{"dshAnchorVersion":"8.8.8"}' > "$BASE_DIR/plain/package.json"
tar -czf "$GATEWAY_DIR/npm-pack.tgz" -C "$BASE_DIR/pack" package
tar -czf "$GATEWAY_DIR/plain.tgz" -C "$BASE_DIR/plain" package.json
printf 'P=<%s>\\n' "$(dsh_baseline_of_tgz "$GATEWAY_DIR/npm-pack.tgz" || true)"
printf 'B=<%s>\\n' "$(dsh_baseline_of_tgz "$GATEWAY_DIR/plain.tgz" || true)"
printf 'M=<%s>\\n' "$(dsh_baseline_of_tgz "$GATEWAY_DIR/missing.tgz" || true)"
`)
  assert.match(output, /P=<9\.9\.9>/)
  assert.match(output, /B=<8\.8\.8>/)
  assert.match(output, /M=<>/, 'missing asset must be empty, never an error')
})

test('dsh_anchor_version reads the controlled anchor manifest exactly', () => {
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
mkdir -p "$GATEWAY_DIR/dsh-anchor/node_modules/@deepseek-ai/dsh"
printf '%s\\n' '{"name":"@deepseek-ai/dsh","version":"0.1.2-rc.1"}' > "$GATEWAY_DIR/dsh-anchor/node_modules/@deepseek-ai/dsh/package.json"
printf 'V=<%s>\\n' "$(dsh_anchor_version || true)"
rm -rf "$GATEWAY_DIR/dsh-anchor"
printf 'M=<%s>\\n' "$(dsh_anchor_version || true)"
`)
  assert.match(output, /V=<0\.1\.2-rc\.1>/)
  assert.match(output, /M=<>/, 'missing anchor must be empty')
})

test('stage_dsh_anchor_upgrade installs into a sibling stage, verifies, and cleans on mismatch', () => {
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
VERSIONS_DIR="$GATEWAY_DIR/versions"
mkdir -p "$VERSIONS_DIR"
npm() {
  # npm config get registry → stub registry;
  # npm install --prefix <dir> "@deepseek-ai/dsh@<v>" … → plant the tree
  local prefix="" i
  if [[ "\${1:-}" == "config" ]]; then printf 'https://registry.npmjs.org\\n'; return 0; fi
  i=1
  while (( i <= $# )); do
    if [[ "\${!i}" == "--prefix" ]]; then
      i=$((i + 1))
      prefix="\${!i}"
    fi
    i=$((i + 1))
  done
  [[ -n "$prefix" ]] || return 1
  mkdir -p "$prefix/node_modules/@deepseek-ai/dsh/lib"
  printf '%s\\n' '{"name":"@deepseek-ai/dsh","version":"9.9.9"}' > "$prefix/node_modules/@deepseek-ai/dsh/package.json"
  printf '#!/usr/bin/env node\\n' > "$prefix/node_modules/@deepseek-ai/dsh/lib/bin.js"
  return 0
}
verify_dsh() { printf '9.9.9'; }
STAGE=$(stage_dsh_anchor_upgrade 9.9.9)
printf 'stage-ok=<%s>\\n' "\${STAGE:+yes}"
[[ -d "$STAGE/node_modules/@deepseek-ai/dsh" ]] && printf 'entry-present\\n'
if stage_dsh_anchor_upgrade 1.0.0 >/dev/null 2>&1; then printf 'mismatch-accepted\\n'; else printf 'mismatch-refused\\n'; fi
# The first (successful) stage legitimately remains until the caller swaps it
# in; drop it, then a failed attempt must leave no stage behind.
rm -rf "$STAGE"
if ls "$VERSIONS_DIR"/.anchor-stage.* >/dev/null 2>&1; then printf 'leftover-present\\n'; else printf 'leftover-clean\\n'; fi
`)
  assert.match(output, /stage-ok=<yes>/)
  assert.match(output, /entry-present/)
  assert.match(output, /mismatch-refused/, 'verified version must equal the requested target')
  assert.match(output, /leftover-clean/, 'failed staging must clean its stage directory')
})

function writeFakeAnchor(anchorDir: string, version: string): void {
  mkdirSync(join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  writeFileSync(join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '#!/usr/bin/env node\n')
}

// Shared cmd_update-level fixture: a real anchor workspace + a faithful npm
// stub (answers the registry query, plants @deepseek-ai/dsh, and prints
// real-npm-style stdout noise — the regression guard for the stage-path
// capture, which must not let npm's stdout pollute anchor_stage).
const ANCHOR_TEST_BODY = (failFirstHealth: boolean) => `
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
VERSION=2.0.0
resolve_version() { :; }
download_verify() { mkdir -p "$1"; : > "$1/dsh-chamber-gateway-\${VERSION}.tgz"; }
stage_local_version() { mkdir -p "$VERSIONS_DIR/$2"; }
launch_identity() { printf old-boot; }
systemctl_for_mode() { [[ "$1" == "is-active" ]] && return 1; return 0; }
npm() {
  if [[ "\${1:-}" == "config" ]]; then printf 'https://registry.npmjs.org\n'; return 0; fi
  local prefix="" i
  i=1
  while (( i <= $# )); do
    if [[ "\${!i}" == "--prefix" ]]; then i=$((i + 1)); prefix="\${!i}"; fi
    i=$((i + 1))
  done
  [[ -n "$prefix" ]] || return 1
  mkdir -p "$prefix/node_modules/@deepseek-ai/dsh/lib"
  printf '%s\n' '{"name":"@deepseek-ai/dsh","version":"0.2.0"}' > "$prefix/node_modules/@deepseek-ai/dsh/package.json"
  printf '%s\n' '#!/usr/bin/env node' > "$prefix/node_modules/@deepseek-ai/dsh/lib/bin.js"
  printf 'added 1 package in 2s\n'
  return 0
}
verify_dsh() { printf '0.2.0'; }
write_unit() { return 0; }
restart_service() { return 0; }
HEALTHCALLS=0
health_wait() { HEALTHCALLS=$((HEALTHCALLS + 1)); [[ "$HEALTHCALLS" -gt ${failFirstHealth ? 1 : 0} ]]; }
cmd_update
`

test('update with default dsh-anchor sync swaps the anchor in and cleans temp dirs on success', () => {
  const base = mkdtempSync(join(tmpdir(), 'gateway-installer-anchor-sync-'))
  const gatewayDir = join(base, 'gateway')
  const versionsDir = join(gatewayDir, 'versions')
  const oldTree = join(versionsDir, '1.0.0')
  const anchorDir = join(gatewayDir, 'dsh-anchor')
  try {
    writeGatewayTree(oldTree, '1.0.0')
    writeFakeAnchor(anchorDir, '0.1.0')
    const body = `${ANCHOR_TEST_BODY(false)}\nprintf 'anchor-version=<%s>\\n' "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$GATEWAY_DIR/dsh-anchor/node_modules/@deepseek-ai/dsh/package.json")"\n`
    const result = runLibraryResult(body, { DSH_CHAMBER_BASE_DIR: base, DSH_CHAMBER_DSH_VERSION: '0.2.0' })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /dsh 内建锚已同步/)
    assert.match(result.stdout, /anchor-version=<0\.2\.0>/, 'the anchor workspace must carry the release baseline after success')
    assert.deepEqual(readdirSync(versionsDir).filter(name => name.startsWith('.anchor')), [], 'anchor temp dirs are cleaned after success')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('update rollback restores the old dsh anchor when the new service fails the health check', () => {
  const base = mkdtempSync(join(tmpdir(), 'gateway-installer-anchor-rollback-'))
  const gatewayDir = join(base, 'gateway')
  const versionsDir = join(gatewayDir, 'versions')
  const oldTree = join(versionsDir, '1.0.0')
  const anchorDir = join(gatewayDir, 'dsh-anchor')
  try {
    writeGatewayTree(oldTree, '1.0.0')
    writeFakeAnchor(anchorDir, '0.1.0')
    const result = runLibraryResult(ANCHOR_TEST_BODY(true), { DSH_CHAMBER_BASE_DIR: base, DSH_CHAMBER_DSH_VERSION: '0.2.0' })
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
    assert.match(`${result.stdout}${result.stderr}`, /升级失败，已回滚到/, 'rollback must die loudly')
    assert.match(result.stdout, /dsh 内建锚已回滚/)
    const manifest = JSON.parse(readFileSync(join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version?: unknown }
    assert.equal(manifest.version, '0.1.0', 'rollback must restore the OLD anchor version')
    assert.deepEqual(readdirSync(versionsDir).filter(name => name.startsWith('.anchor')), [], 'anchor temp dirs are cleaned after rollback')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('stage_dsh_anchor_upgrade survives UTF-8 locales (bash 3.2 multibyte variable-name parsing)', () => {
  // Regression: the progress log ended with "…镜像 $registry）…" — under bash
  // 3.2 + any UTF-8 LC_CTYPE the parameter-name scanner eats the first byte
  // of the multibyte ） into the name, so set -u crashed with
  // "registry…: unbound variable" on EVERY anchor-syncing update (default ON)
  // → full rollback. CI (bash 5) never saw it; this spawns its own harness
  // under LC_ALL=C.UTF-8 so macOS-bash-3.2 semantics are exercised.
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
VERSIONS_DIR="$GATEWAY_DIR/versions"
mkdir -p "$VERSIONS_DIR"
npm() {
  local prefix="" i
  if [[ "\${1:-}" == "config" ]]; then printf 'https://registry.npmjs.org\n'; return 0; fi
  i=1
  while (( i <= $# )); do
    if [[ "\${!i}" == "--prefix" ]]; then i=$((i + 1)); prefix="\${!i}"; fi
    i=$((i + 1))
  done
  [[ -n "$prefix" ]] || return 1
  mkdir -p "$prefix/node_modules/@deepseek-ai/dsh/lib"
  printf '%s\n' '{"name":"@deepseek-ai/dsh","version":"9.9.9"}' > "$prefix/node_modules/@deepseek-ai/dsh/package.json"
  printf '#!/usr/bin/env node\n' > "$prefix/node_modules/@deepseek-ai/dsh/lib/bin.js"
  printf 'added 1 package in 2s\n'
  return 0
}
verify_dsh() { printf '9.9.9'; }
STAGE=$(stage_dsh_anchor_upgrade 9.9.9)
printf 'ok=<%s>\n' "\${STAGE:+yes}"
rm -rf "$STAGE"
`, { LC_ALL: 'C.UTF-8' })
  assert.match(output, /ok=<yes>/, 'stage must not crash under a UTF-8 locale (unbraced var + multibyte char)')
})

test('NPM_REGISTRY round-trips through write_config and load_conf and never leaks from env', () => {
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
CONF_FILE="$GATEWAY_DIR/gateway.conf"
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
VERSION=1.0.0
INSTALL_METHOD=local
SERVICE_MODE=foreground
SERVICE_USER=""
npm_mirror="https://registry.npmmirror.com"
write_config
printf 'line=<%s>\\n' "$(grep -c '^NPM_REGISTRY=' "$CONF_FILE")"
# load_conf must restore it onto npm_mirror…
npm_mirror=""
load_conf
printf 'restored=<%s>\\n' "$npm_mirror"
# …but only when the conf really carries the key: an ambient env variable must
# never steer the mirror when the conf has no NPM_REGISTRY line.
sed -e '/^NPM_REGISTRY=/d' "$CONF_FILE" > "$CONF_FILE.tmp" && mv "$CONF_FILE.tmp" "$CONF_FILE"
npm_mirror=""
NPM_REGISTRY="https://evil.example"
load_conf
printf 'env-leak=<%s>\\n' "\${npm_mirror:-none}"
`)
  assert.match(output, /line=<1>/)
  assert.match(output, /restored=<https:\/\/registry\.npmmirror\.com>/)
  assert.match(output, /env-leak=<none>/, 'an ambient NPM_REGISTRY must not leak into npm_mirror when the conf lacks the key')
})

test('acquire_lock restores an orphaned anchor backup over an empty placeholder dir (crash between swap renames)', () => {
  // ensure_private_layout recreates dsh-anchor as an EMPTY dir before every
  // update lock, so an existence-based recovery predicate would delete the
  // only remaining old anchor (.anchor.prev.*) as garbage on the crash-retry
  // path. Recovery must be content-based: empty placeholder → mv the backup
  // back.
  const output = runLibrary(`
BASE_DIR="$(mktemp -d)"
GATEWAY_DIR="$BASE_DIR/gateway"
VERSIONS_DIR="$GATEWAY_DIR/versions"
mkdir -p "$GATEWAY_DIR/dsh-anchor" "$VERSIONS_DIR/.anchor.prev.99999/node_modules/@deepseek-ai/dsh/lib"
printf '%s\\n' '{"name":"@deepseek-ai/dsh","version":"0.1.0"}' > "$VERSIONS_DIR/.anchor.prev.99999/node_modules/@deepseek-ai/dsh/package.json"
printf '%s\\n' '#!/usr/bin/env node' > "$VERSIONS_DIR/.anchor.prev.99999/node_modules/@deepseek-ai/dsh/lib/bin.js"
acquire_lock
printf 'anchor-entry=<%s>\\n' "$([[ -f "$GATEWAY_DIR/dsh-anchor/node_modules/@deepseek-ai/dsh/package.json" ]] && printf yes || printf no)"
printf 'prev-count=<%s>\\n' "$(ls -d "$VERSIONS_DIR"/.anchor.prev.* 2>/dev/null | wc -l | tr -d ' ')"
printf 'anchor-version=<%s>\\n' "$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$GATEWAY_DIR/dsh-anchor/node_modules/@deepseek-ai/dsh/package.json" 2>/dev/null || true)"
`)
  assert.match(output, /anchor-entry=<yes>/, 'the backup anchor must be restored over the empty placeholder')
  assert.match(output, /prev-count=<0>/, 'no backup leftover after restore')
  assert.match(output, /anchor-version=<0\.1\.0>/)
})

test('update anchor sync can be declined interactively and proceeds without touching the anchor', () => {
  const base = mkdtempSync(join(tmpdir(), 'gateway-installer-anchor-decline-'))
  const gatewayDir = join(base, 'gateway')
  const versionsDir = join(gatewayDir, 'versions')
  const oldTree = join(versionsDir, '1.0.0')
  const anchorDir = join(gatewayDir, 'dsh-anchor')
  try {
    writeGatewayTree(oldTree, '1.0.0')
    writeFakeAnchor(anchorDir, '0.1.0')
    // First confirm (gateway upgrade) accepted, second confirm (anchor sync) declined.
    const prelude = 'CONFIRMS=0\nconfirm() { CONFIRMS=$((CONFIRMS + 1)); [[ "$CONFIRMS" -eq 1 ]]; }\n'
    const result = runLibraryResult(prelude + ANCHOR_TEST_BODY(false), { DSH_CHAMBER_BASE_DIR: base, DSH_CHAMBER_DSH_VERSION: '0.2.0' })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /已拒绝 dsh 锚同步/, 'decline is logged')
    assert.doesNotMatch(result.stdout, /dsh 内建锚已同步/)
    const manifest = JSON.parse(readFileSync(join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version?: unknown }
    assert.equal(manifest.version, '0.1.0', 'the anchor must be untouched after a decline')
    assert.deepEqual(readdirSync(versionsDir).filter(name => name.startsWith('.anchor')), [], 'no anchor temp dirs on the decline path')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('--no-dsh-upgrade skips anchor work entirely and the update still succeeds', () => {
  const base = mkdtempSync(join(tmpdir(), 'gateway-installer-no-dsh-upgrade-'))
  const gatewayDir = join(base, 'gateway')
  const versionsDir = join(gatewayDir, 'versions')
  const oldTree = join(versionsDir, '1.0.0')
  const anchorDir = join(gatewayDir, 'dsh-anchor')
  try {
    writeGatewayTree(oldTree, '1.0.0')
    writeFakeAnchor(anchorDir, '0.1.0')
    const result = runLibraryResult('DSH_UPGRADE=0\n' + ANCHOR_TEST_BODY(false), { DSH_CHAMBER_BASE_DIR: base, DSH_CHAMBER_DSH_VERSION: '0.2.0' })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    assert.doesNotMatch(result.stdout, /dsh 内建锚已同步|已拒绝/, 'no anchor activity at all')
    const manifest = JSON.parse(readFileSync(join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version?: unknown }
    assert.equal(manifest.version, '0.1.0', 'the anchor stays pinned under --no-dsh-upgrade')
    assert.deepEqual(readdirSync(versionsDir).filter(name => name.startsWith('.anchor')), [], 'no anchor temp dirs')
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
