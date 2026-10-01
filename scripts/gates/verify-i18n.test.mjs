/**
 * verify-i18n.test.mjs — 双语记录门的 **sidecar 发现面**负例测试（临时仓根，spawn 真门）。
 *
 * 为什么需要：sidecar 的键此前只认行首（平铺记录），于是 4 个用 en:/zh: 缩进映射的
 * sidecar 全部被静默跳过；hash 也只认 64 位 sha-256，2 个沿用 git blob（40 位 sha1）
 * 的上游拷贝包同样 0 对——「记录文件在、其实没校验任何一对」。这里把真实门跑在
 * 临时仓根上钉住：缩进键 / 两种 hash 都会被校验，陈旧即红，解析不出任何一对也红。
 *
 * 跑法：node --test scripts/gates/verify-i18n.test.mjs（run-script-tests.mjs gates 组）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')

const sha256 = text => createHash('sha256').update(text).digest('hex')
const gitBlob = text => createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\u0000').update(text).digest('hex')

/**
 * 一个最小临时仓根：门脚本 + i18n 结构模块 + 空的 docs/ + 指定的 packages 记录。
 * @param {object} input
 * @param {Record<string, string>} input.sidecars - 包名 -> README.i18n.yaml 内容。
 * @param {Record<string, string>} [input.readmes] - 仓库根相对路径 -> 内容（默认给每个包两份）。
 */
function makeFixture(t, { sidecars, readmes = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'i18n-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts', 'gates'), { recursive: true })
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'packages'), { recursive: true })
  copyFileSync(join(REPO_ROOT, 'scripts', 'gates', 'verify-i18n.mjs'), join(root, 'scripts', 'gates', 'verify-i18n.mjs'))
  copyFileSync(join(REPO_ROOT, 'scripts', 'lib', 'i18n-structure.mjs'), join(root, 'scripts', 'lib', 'i18n-structure.mjs'))
  for (const [pkg, text] of Object.entries(sidecars)) {
    mkdirSync(join(root, 'packages', pkg), { recursive: true })
    writeFileSync(join(root, 'packages', pkg, 'README.i18n.yaml'), text)
  }
  for (const [rel, text] of Object.entries(readmes)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  return root
}

const run = (root, args = []) => spawnSync(process.execPath, [join(root, 'scripts', 'gates', 'verify-i18n.mjs'), ...args], { cwd: root, encoding: 'utf8' })

test('嵌套 en:/zh: 缩进键 + sha-256：一致即绿，陈旧即红', t => {
  const en = '# Title\n\nBody en\n'
  const zh = '# 标题\n\n正文\n'
  const sidecar = 'en:\n  README.md: ' + sha256(en) + '\nzh:\n  README.zh.md: ' + sha256(zh) + '\n'
  const clean = makeFixture(t, { sidecars: { demo: sidecar }, readmes: { 'packages/demo/README.md': en, 'packages/demo/README.zh.md': zh } })
  const green = run(clean)
  assert.equal(green.status, 0, green.stdout + green.stderr)
  assert.match(green.stdout, /consistent {3}packages\/demo\/README\.md/)
  assert.match(green.stdout, /consistent {3}packages\/demo\/README\.zh\.md/)

  // 中文侧改一个字节、记录不更新 ⇒ 必须红（旧正则根本看不到这两行，永远绿）。
  const stale = makeFixture(t, { sidecars: { demo: sidecar }, readmes: { 'packages/demo/README.md': en, 'packages/demo/README.zh.md': zh + 'changed\n' } })
  const red = run(stale)
  assert.equal(red.status, 1, red.stdout + red.stderr)
  assert.match(red.stdout, /DRIFTED {6}packages\/demo\/README\.zh\.md/)
})

test('40 位 git blob 记录（上游拷贝侧沿用）：按 sha1(\"blob len\\0\" + 内容) 校验', t => {
  const en = '# Copied readme\n'
  const zh = '# 拷贝的说明\n'
  const sidecar = 'README.md: ' + gitBlob(en) + '\nREADME.zh.md: ' + gitBlob(zh) + '\n'
  const clean = makeFixture(t, { sidecars: { copied: sidecar }, readmes: { 'packages/copied/README.md': en, 'packages/copied/README.zh.md': zh } })
  const green = run(clean)
  assert.equal(green.status, 0, green.stdout + green.stderr)
  assert.match(green.stdout, /consistent {3}packages\/copied\/README\.md/)

  const stale = makeFixture(t, { sidecars: { copied: sidecar }, readmes: { 'packages/copied/README.md': en, 'packages/copied/README.zh.md': zh + 'x' } })
  const red = run(stale)
  assert.equal(red.status, 1, red.stdout + red.stderr)
  assert.match(red.stdout, /DRIFTED {6}packages\/copied\/README\.zh\.md/)
  // 位数选算法：把 git blob 记录当成 sha-256 去验会误报，这里明确两种互不冒充。
  assert.notEqual(sha256(en), gitBlob(en))
})

test('解析不出任何一对的 sidecar 直接红，不静默当「没有记录」', t => {
  const bogus = makeFixture(t, { sidecars: { broken: 'en:\n  README.md: not-a-hash\n' } })
  const red = run(bogus)
  assert.equal(red.status, 1, red.stdout + red.stderr)
  assert.match(red.stderr, /解析不到任何 README 文件\/hash 对/)
  assert.match(red.stderr, /packages\/broken\/README\.i18n\.yaml/)
})
test('子目录镜像递归发现：docs/<sub>/x.en-US.md ↔ 同目录 x.md 必须成对登记', t => {
  const en = '# Sub title\n\nBody\n'
  const zh = '# 子标题\n\n正文\n'
  const root = makeFixture(t, { sidecars: {}, readmes: { 'docs/sub/x.en-US.md': en, 'docs/sub/x.md': zh } })
  // 旧实现只扫 docs/ 顶层：这一对整对落在发现面之外，删掉镜像也不会红。
  const red = run(root)
  assert.equal(red.status, 1, red.stdout + red.stderr)
  assert.match(red.stdout, /DRIFTED {6}docs\/sub\/x\.en-US\.md/)
  // --write 登记后必须绿：证明这一对真的进了记录，而不是只会红。
  const written = run(root, ['--write'])
  assert.equal(written.status, 0, written.stdout + written.stderr)
  assert.match(written.stdout, /recorded {5}docs\/sub\/x\.en-US\.md/)
  const green = run(root)
  assert.equal(green.status, 0, green.stdout + green.stderr)
  assert.match(green.stdout, /consistent {3}docs\/sub\/x\.en-US\.md/)
})

test('非 write 分支：哈希记录最新但结构不对等（镜像少一节）也必须红', t => {
  const en = '# Title\n'
  const zh = '# 标题\n\n## 多出来的一节\n'
  const root = makeFixture(t, { sidecars: {}, readmes: { 'docs/x.en-US.md': en, 'docs/x.md': zh } })
  writeFileSync(join(root, 'docs', 'i18n-record.json'), JSON.stringify({
    files: { 'docs/x.en-US.md': { en: sha256(en), zh: sha256(zh) } },
  }))
  const red = run(root)
  assert.equal(red.status, 1, red.stdout + red.stderr)
  assert.match(red.stdout, /consistent {3}docs\/x\.en-US\.md/, '哈希侧一致 ⇒ 红必须来自结构，不是 drift')
  assert.match(red.stderr, /结构不对等/, '非 write 分支此前只看 drifted，结构残缺可以一路绿')
})

test('双语 README 缺 sidecar：发现面必须硬失败，不静默跳过', t => {
  // 发现面只枚举「已存在」的 sidecar 时，删掉一份记录就能让整对静默失去校验。
  const root = makeFixture(t, { sidecars: {}, readmes: { 'packages/pair/README.md': '# Title\n', 'packages/pair/README.zh.md': '# 标题\n' } })
  const red = run(root)
  assert.equal(red.status, 1, red.stdout + red.stderr)
  assert.match(red.stderr, /双语 README 缺 README\.i18n\.yaml/)
  assert.match(red.stderr, /packages\/pair\/README\.md/)
})

test('write 分支：sidecar 记录指向不存在的文件也必须 exit 1（不得静默重录）', t => {
  const root = makeFixture(t, { sidecars: { ghost: 'README.md: ' + sha256('whatever') + '\n' } })
  const written = run(root, ['--write'])
  assert.equal(written.status, 1, written.stdout + written.stderr)
  assert.match(written.stderr, /记录指向不存在的文件：packages\/ghost\/README\.md/)
  assert.match(written.stderr, /--write 不能凭空重录/)
})

