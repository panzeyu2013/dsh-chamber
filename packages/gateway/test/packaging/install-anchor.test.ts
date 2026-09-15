/**
 * Installer dsh-anchor sync: flags, manifest/tgz baseline reads, staged
 * upgrades, rollback and lock/conf recovery. Split from install-script.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  source,
  runLibrary,
  runLibraryResult,
  writeGatewayTree,
} from '../support/installer-harness.ts'

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

test('update heals a conf-ahead version mismatch (rollback leftover) and completes the interrupted upgrade', () => {
  const base = mkdtempSync(join(tmpdir(), 'gateway-installer-f6-heal-upgrade-'))
  const gatewayDir = join(base, 'gateway')
  const versionsDir = join(gatewayDir, 'versions')
  const oldTree = join(versionsDir, '1.0.0')
  const current = join(gatewayDir, 'current')
  try {
    writeGatewayTree(oldTree, '1.0.0')
    const result = runLibraryResult(`
mkdir -p "$GATEWAY_DIR"
ln -s "$VERSIONS_DIR/1.0.0" "$GATEWAY_DIR/current"
VERSION=2.0.0
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

# Rollback leftover: conf was committed to 2.0.0 by an aborted transaction
# while gateway/current still points at the 1.0.0 tree. Simulate the parsed
# CLI flag (latest is also 2.0.0) before cmd_update reloads gateway.conf.
VERSION=2.0.0
NONINTERACTIVE=1
resolve_version() { :; }
DOWNLOAD_V=""
download_verify() { DOWNLOAD_V="$VERSION"; mkdir -p "$1"; : > "$1/dsh-chamber-gateway-\${VERSION}.tgz"; }
stage_local_version() { mkdir -p "$VERSIONS_DIR/$2"; }
systemctl_for_mode() { [[ "$1" == "is-active" ]] && return 1; return 0; }
launch_identity() { printf old-boot; }
write_unit() { return 0; }
restart_service() { return 0; }
health_wait() { return 0; }
cmd_update
printf 'download-version=<%s>\\n' "$DOWNLOAD_V"
`, { DSH_CHAMBER_BASE_DIR: base })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /版本树与配置不一致：配置 VERSION=2\.0\.0，current 树为 v1\.0\.0/, 'the heal must be announced before proceeding')
    assert.match(result.stdout, /安装配置已对齐到实际版本树：VERSION=1\.0\.0/)
    assert.match(result.stdout, /download-version=<2\.0\.0>/, 'the target download must use the requested version, not the healed tree version')
    assert.match(result.stdout, /已升级到 2\.0\.0/, 'a plain update replays the interrupted upgrade instead of dying')
    assert.equal(readlinkSync(current), join(versionsDir, '2.0.0'), 'the pointer must land on the requested target')
    assert.match(readFileSync(join(gatewayDir, 'gateway.conf'), 'utf8'), /^VERSION=2\.0\.0$/m, 'the final config records the completed upgrade')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('update heals a conf-ahead version mismatch and no-ops at the actual tree version', () => {
  const base = mkdtempSync(join(tmpdir(), 'gateway-installer-f6-heal-only-'))
  const gatewayDir = join(base, 'gateway')
  const versionsDir = join(gatewayDir, 'versions')
  const oldTree = join(versionsDir, '1.0.0')
  const current = join(gatewayDir, 'current')
  try {
    writeGatewayTree(oldTree, '1.0.0')
    const result = runLibraryResult(`
mkdir -p "$GATEWAY_DIR"
ln -s "$VERSIONS_DIR/1.0.0" "$GATEWAY_DIR/current"
VERSION=2.0.0
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

# The operator asks for exactly the version the tree already runs; the conf
# only needs to be reconciled, nothing else may change.
VERSION=1.0.0
NONINTERACTIVE=1
resolve_version() { :; }
launch_identity() { printf old-boot; }
cmd_update
`, { DSH_CHAMBER_BASE_DIR: base })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    assert.match(result.stdout, /版本树与配置不一致/)
    assert.match(result.stdout, /已是最新版本 1\.0\.0（指针\/树身份校验通过）/)
    assert.equal(readlinkSync(current), oldTree, 'the pointer must not move on the heal-only path')
    assert.equal(existsSync(join(versionsDir, '2.0.0')), false, 'no target tree is staged on the heal-only path')
    assert.match(readFileSync(join(gatewayDir, 'gateway.conf'), 'utf8'), /^VERSION=1\.0\.0$/m, 'the config is reconciled down to the actual tree version')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('update rollback persists the OLD version in gateway.conf even when it fails after the config commit', () => {
  const base = mkdtempSync(join(tmpdir(), 'gateway-installer-rollback-conf-'))
  const gatewayDir = join(base, 'gateway')
  const versionsDir = join(gatewayDir, 'versions')
  const oldTree = join(versionsDir, '1.0.0')
  const current = join(gatewayDir, 'current')
  try {
    writeGatewayTree(oldTree, '1.0.0')
    const result = runLibraryResult(`
mkdir -p "$GATEWAY_DIR"
ln -s "$VERSIONS_DIR/1.0.0" "$GATEWAY_DIR/current"
VERSION=1.0.0
INSTALL_METHOD=local
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
NONINTERACTIVE=1
resolve_version() { :; }
download_verify() { mkdir -p "$1"; : > "$1/dsh-chamber-gateway-\${VERSION}.tgz"; }
stage_local_version() { mkdir -p "$VERSIONS_DIR/$2"; }
systemctl_for_mode() { [[ "$1" == "is-active" ]] && return 1; return 0; }
launch_identity() { printf old-boot; }
write_unit() { return 0; }
restart_service() { return 0; }
health_wait() { return 0; }
# Simulate the post-commit tail step failing (ownership handover): the first
# call (pre-restart) succeeds, the second (after the conf commit) fails, and
# the rollback's own ownership step keeps failing too.
APPLY_CALLS=0
apply_service_user_ownership() { APPLY_CALLS=$((APPLY_CALLS + 1)); [[ "$APPLY_CALLS" -eq 1 ]]; }
cmd_update
`, { DSH_CHAMBER_BASE_DIR: base })
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`)
    assert.match(`${result.stdout}${result.stderr}`, /升级失败且回滚未完全成功，请人工介入：数据目录属主移交失败/)
    assert.equal(readlinkSync(current), oldTree, 'rollback restores the exact old current target')
    assert.equal(existsSync(join(versionsDir, '2.0.0')), false, 'the failed target tree is removed after rollback')
    assert.match(readFileSync(join(gatewayDir, 'gateway.conf'), 'utf8'), /^VERSION=1\.0\.0$/m,
      'rollback must write the old version back into gateway.conf so the next update/restart is not bricked by an identity mismatch')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
