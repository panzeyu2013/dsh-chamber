import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
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

function runLibrary(body: string, env: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-installer-test-'))
  const harness = join(dir, 'harness.sh')
  try {
    writeFileSync(harness, `${library}\n${body}\n`, { mode: 0o700 })
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
    writeFileSync(harness, `${library}\n${body}\n`, { mode: 0o700 })
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
prompt TEST_VALUE label "$PAYLOAD"
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
write_env
# Model a pre-migration install whose foreground-only values exist solely in
# EnvironmentFile. load_conf must decode those assignments as data.
sed -i '' '/^ENV_ANCHOR=/d;/^UI_PASSWORD=/d;/^API_TOKEN=/d' "$CONF_FILE"
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
`, { PAYLOAD: payload, TOKEN: token })
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
  mkdir -p "$destination/dist"
  printf '%s\\n' '{"name":"@dsh-chamber/gateway","version":"2.0.0"}' > "$destination/package.json"
  printf '%s\\n' '#!/usr/bin/env node' > "$destination/dist/cli.js"
}
stage_local_version /fixture.tgz 2.0.0
switch_local_current "$VERSIONS_DIR/2.0.0"
printf '%s\\n' "$(readlink "$GATEWAY_DIR/current")"
`)
  assert.equal(output.trimEnd().split('\n').at(-1)?.endsWith('/gateway/versions/2.0.0'), true)
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
    assert.deepEqual(readFileSync(join(base, 'npm-artifacts'), 'utf8').trimEnd().split('\n'), [
      join(gatewayDir, 'dsh-chamber-gateway-2.0.0.tgz'),
      join(gatewayDir, 'dsh-chamber-gateway-1.0.0.tgz'),
    ])
    assert.match(readFileSync(join(gatewayDir, 'gateway.conf'), 'utf8'), /^VERSION=1\.0\.0$/m)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
