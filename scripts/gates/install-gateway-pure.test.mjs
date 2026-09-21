/**
 * install-gateway.sh 内嵌纯函数的负例锁（B8，2026-12 stage-A）。
 *
 * 为什么从脚本正文抽取程序文本：install-gateway.sh 以单文件分发（curl 下来即跑），
 * 不允许 side-car 文件，所以纯校验/比较逻辑（B8 第一批：参数校验、版本比较、
 * 两个纯路径/unit 映射）唯一实现就是脚本里的那段 node 程序。
 * 本测试读取 scripts/install-gateway.sh，抽出该文本，在 node:vm 里执行并用真实
 * 调用路径（node -e）各验一次——测的就是发出去的那份代码，改判定必须同批改这里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const INSTALLER = join(REPO_ROOT, 'scripts', 'install-gateway.sh')
const source = readFileSync(INSTALLER, 'utf8')
const START = "INSTALL_GATEWAY_PURE_JS=$(cat <<'INSTALL_GATEWAY_PURE_JS_EOF'"
const END = '\nINSTALL_GATEWAY_PURE_JS_EOF\n'

function extractProgram() {
  const start = source.indexOf(START)
  assert.notEqual(start, -1, 'installer must carry the embedded pure-helper program (B8)')
  const end = source.indexOf(END, start + START.length)
  assert.notEqual(end, -1, 'embedded program must keep its heredoc terminator on its own line')
  return source.slice(start + START.length + 1, end)
}

const program = extractProgram()
const messages = []
const sandbox = {
  __installGatewayPureTest: {},
  console: { log: (message) => messages.push(String(message)), error: (message) => messages.push(String(message)) },
}
vm.runInNewContext(program, sandbox, { filename: 'install-gateway-pure-js' })
const ops = sandbox.__installGatewayPureTest

const lastMessage = () => messages[messages.length - 1]
const expectRed = (code, fragment) => {
  assert.equal(code, 1, 'negative input must return 1')
  assert.match(lastMessage(), /^\u001b\[1;31m✗ /, 'message must keep the installer red prefix')
  assert.ok(lastMessage().includes(fragment), 'message must name the failure: ' + lastMessage())
}

test('the extracted program is the shipped one and runs as the installer runs it', () => {
  assert.ok(program.length > 1000, 'program must actually be embedded (' + program.length + ' chars)')
  assert.ok(program.includes("OPS['valid-port']"))
  const real = spawnSync(process.execPath, ['-e', program, 'foreground-record-file', '/opt/gw'], { encoding: 'utf8' })
  assert.equal(real.status, 0)
  assert.equal(real.stdout, '/opt/gw/run/gateway.pid', 'value ops must print without a trailing newline')
  const denied = spawnSync(process.execPath, ['-e', program, 'valid-port', '0'], { encoding: 'utf8' })
  assert.equal(denied.status, 1, 'the real node -e path must fail closed')
  assert.match(denied.stdout, /端口必须是 1-65535 的数字/)
  const unknown = spawnSync(process.execPath, ['-e', program, 'no-such-op'], { encoding: 'utf8' })
  assert.equal(unknown.status, 2, 'an unknown op is a usage error, never a silent pass')
})

test('valid-port: 1-65535 only (negatives: 0 / 65536 / non-numeric)', () => {
  assert.equal(ops['valid-port']('1'), 0)
  assert.equal(ops['valid-port']('30801'), 0)
  assert.equal(ops['valid-port']('65535'), 0)
  expectRed(ops['valid-port']('0'), '端口必须是 1-65535 的数字')
  expectRed(ops['valid-port']('65536'), '端口必须是 1-65535 的数字')
  expectRed(ops['valid-port']('80a'), '端口必须是 1-65535 的数字')
  expectRed(ops['valid-port'](''), '端口必须是 1-65535 的数字')
})

test('valid-semver / valid-semver-v: canonical SemVer, v-prefix only where allowed', () => {
  assert.equal(ops['valid-semver']('0.1.5'), 0)
  assert.equal(ops['valid-semver']('0.2.0-beta.4'), 0)
  assert.equal(ops['valid-semver']('1.2.3+build.7'), 0)
  expectRed(ops['valid-semver']('v1.2.3'), 'canonical SemVer')
  expectRed(ops['valid-semver']('1.2'), 'canonical SemVer')
  expectRed(ops['valid-semver']('01.2.3'), 'canonical SemVer')
  expectRed(ops['valid-semver']('1.2.3-'), 'canonical SemVer')
  assert.equal(ops['valid-semver-v']('v1.2.3'), 0)
  assert.equal(ops['valid-semver-v']('1.2.3'), 0)
  expectRed(ops['valid-semver-v']('vv1.2.3'), 'canonical SemVer')
})

test('valid-bind / valid-origin / valid-ip-list: exact shapes, empties where documented', () => {
  assert.equal(ops['valid-bind']('127.0.0.1'), 0)
  assert.equal(ops['valid-bind']('0.0.0.0'), 0)
  expectRed(ops['valid-bind']('127.0.0.2'), 'bind host 只允许')
  expectRed(ops['valid-bind']('localhost'), 'bind host 只允许')
  assert.equal(ops['valid-origin'](''), 0, 'origin is optional for the non-proxy shapes')
  assert.equal(ops['valid-origin']('https://gateway.example.com:8443'), 0)
  expectRed(ops['valid-origin']('https://gateway.example.com/path'), '公网地址必须是')
  expectRed(ops['valid-origin']('ftp://gateway.example.com'), '公网地址必须是')
  expectRed(ops['valid-origin-required'](''), '反向代理形态必须填写公网域名')
  assert.equal(ops['valid-origin-required']('https://gateway.example.com'), 0)
  assert.equal(ops['valid-ip-list'](''), 0)
  assert.equal(ops['valid-ip-list']('1.2.3.4, 5.6.7.8'), 0, 'comma+space is accepted')
  assert.equal(ops['valid-ip-list']('01.2.3.4'), 0, 'one leading zero is stripped（bash ${x#0} 语义）')
  assert.equal(ops['valid-ip-list']('255.255.255.255'), 0)
  expectRed(ops['valid-ip-list']('1.2.3'), '精确 IPv4')
  expectRed(ops['valid-ip-list']('1.2.3.4.5'), '精确 IPv4')
  expectRed(ops['valid-ip-list']('1.2.3.256'), 'IPv4 每段必须在 0-255：1.2.3.256')
  expectRed(ops['valid-ip-list']('1.2.3.999'), 'IPv4 每段必须在 0-255')
})

test('numstr-lt / version-lt: numeric main segments, prerelease ordering, build metadata ignored', () => {
  assert.equal(ops['numstr-lt']('9', '10'), 0)
  assert.equal(ops['numstr-lt']('10', '9'), 1)
  assert.equal(ops['numstr-lt']('010', '10'), 1, 'leading zeros are not less-than')
  assert.equal(ops['numstr-lt']('99999999999999999999', '1'), 1, 'arbitrary length is not truncated')
  assert.equal(ops['version-lt']('0.1.5', '0.2.0'), 0)
  assert.equal(ops['version-lt']('0.2.0', '0.1.5'), 1)
  assert.equal(ops['version-lt']('1.0.0-beta.1', '1.0.0'), 0, 'prerelease < final')
  assert.equal(ops['version-lt']('1.0.0', '1.0.0-beta.1'), 1)
  assert.equal(ops['version-lt']('1.0.0-beta.9', '1.0.0-beta.10'), 0, 'numeric identifiers compare numerically')
  assert.equal(ops['version-lt']('1.0.0-alpha', '1.0.0-beta'), 0)
  assert.equal(ops['version-lt']('1.0.0+b1', '1.0.0+b2'), 1, 'build metadata is ignored (equal)')
  assert.equal(ops['version-lt']('1.0.0', '1.0.0'), 1, 'equal is not less-than')
})

test('unit mapping: WantedBy per service mode, unknown mode is a loud failure', () => {
  assert.equal(ops['unit-wanted-by']('user'), 'default.target')
  assert.equal(ops['unit-wanted-by']('systemd'), 'multi-user.target')
  assert.equal(ops['unit-wanted-by']('local'), 2, 'an unmapped mode returns the usage code (the wrapper die()s)')
})
