/**
 * I-6 能力面对齐门的形状锁与 CLI 面：判定阶梯（behind/broken/landed/unresolvable/
 * consumer-missing）与真实 capabilities.json 的校验只有门内 runSelfTest 一份（这里直接
 * 调用它），本文件只钉探针解析、形状/消费者路径腐烂与 CLI 的 --json/退出码。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  DEFAULT_VENDOR_ROOT,
  VERDICT,
  loadCapabilities,
  observeProbe,
  runSelfTest,
  validateCapabilities,
} from './verify-capabilities.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CONSUMER = 'packages/dsh-chamber-client-core/src/instance-api.ts'

/** 夹具 vendor 树：packages/api/workspace.ts 声明 unarchiveSession。 */
function fixtureVendorRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capabilities-test-'))
  const file = join(root, 'packages/api/workspace.ts')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'export async function unarchiveSession() {}\n')
  return root
}

const entry = (id, probe, requires = []) => ({ id, note: 'fixture', probe, requires })

test('observeProbe resolves symbols and reports empty probe roots (absence is unprovable)', () => {
  const root = fixtureVendorRoot()
  try {
    assert.equal(observeProbe({ roots: ['packages/api'], symbol: 'unarchiveSession' }, root).present, true)
    assert.equal(observeProbe({ roots: ['packages/api'], symbol: 'missingThing' }, root).present, false)
    assert.equal(observeProbe({ roots: ['packages/api'], patterns: ['sessions\\.delete'], expect: 'absent' }, root).present, false)
    const gone = observeProbe({ roots: ['packages/api/gone'], symbol: 'unarchiveSession' }, root)
    assert.equal(gone.resolvable, false)
    assert.deepEqual(gone.missingRoots, ['packages/api/gone'])
    // 形态①：声明级锚点（literal 要求恰好一次）。
    assert.equal(observeProbe({ anchors: ['packages/api/workspace.ts#unarchiveSession'] }, root).present, true)
    assert.equal(observeProbe({ anchors: ['packages/api/workspace.ts#=literal:unarchiveSession'] }, root).present, true)
    assert.equal(observeProbe({ anchors: ['packages/api/workspace.ts#neverThere'] }, root).present, false)
    assert.equal(observeProbe({ anchors: ['packages/api/workspace.ts#neverThere'] }, root).anyHit, false)
    const anchorGone = observeProbe({ anchors: ['packages/api/gone.ts#unarchiveSession'] }, root)
    assert.equal(anchorGone.resolvable, true, 'a missing anchor file is absence evidence, not an unresolvable tree')
    assert.equal(anchorGone.present, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the verdict ladder and the real registry shape come from the gate self-test (one copy)', () => {
  // 夹具树与判定阶梯只允许一份：这里调用门导出的 runSelfTest（与 --self-test 同一实现），
  // 不再在测试里复制第二套夹具（负控复制正是这条判据要防的漂移）。
  assert.equal(runSelfTest(), 0)
})

test('validateCapabilities rejects shape rot and dead consumer paths', () => {
  const problems = validateCapabilities({ schema: 1, note: 'x', capabilities: [
    entry('dup', { roots: ['packages/api'], symbol: 'a', expect: 'present' }),
    entry('dup', { roots: ['packages/api'], symbol: 'a', expect: 'present' }),
    entry('both', { roots: ['packages/api'], symbol: 'a', patterns: ['b'], expect: 'present' }),
    entry('bad-expect', { roots: ['packages/api'], symbol: 'a', expect: 'maybe' }),
    entry('bad-pattern', { roots: ['packages/api'], patterns: ['('], expect: 'absent' }),
    entry('dead-consumer', { roots: ['packages/api'], symbol: 'a', expect: 'present' }, ['packages/does-not-exist/src/x.ts']),
    { ...entry('dead-workaround', { roots: ['packages/api'], symbol: 'a', expect: 'absent' }),
      localWorkaround: { by: ['packages/does-not-exist/x.ts'], retireWhen: 'x' } },
  ] })
  const joined = problems.join('\n')
  assert.match(joined, /id 重复/)
  assert.match(joined, /恰好给 anchors 或 symbol 或 patterns/)
  assert.match(joined, /expect 必须是 present\/absent/)
  assert.match(joined, /patterns 非法正则/)
  assert.match(joined, /requires 路径不存在/)
  assert.match(joined, /localWorkaround.by 路径不存在/)
})

test('the real capabilities.json validates; every absent capability names its retirement trigger', () => {
  const capabilities = loadCapabilities()
  assert.deepEqual(validateCapabilities(capabilities), [])
  assert.ok(capabilities.capabilities.length >= 5)
  for (const capability of capabilities.capabilities) {
    assert.ok(capability.note.length > 0, capability.id)
    if (capability.probe.expect === 'absent' && capability.localWorkaround !== undefined) {
      assert.ok(capability.localWorkaround.retireWhen.length > 0, capability.id + ' 的本地替代必须带退役触发')
    }
  }
})

test('the CLI decides exit codes on a fixture tree and answers --json', () => {
  const root = fixtureVendorRoot()
  try {
    const write = (name, capabilityList) => {
      const path = join(root, name)
      writeFileSync(path, JSON.stringify({ schema: 1, note: 'fixture', capabilities: capabilityList }))
      return path
    }
    const red = write('red.json', [entry('broken', { roots: ['packages/api'], symbol: 'neverThere', expect: 'present' }, [CONSUMER])])
    const green = write('green.json', [entry('found', { roots: ['packages/api'], symbol: 'unarchiveSession', expect: 'present' })])
    let redRun
    try {
      execFileSync(process.execPath, ['verify-capabilities.mjs', '--json', '--vendor-root', root, '--capabilities', red], { cwd: HERE, encoding: 'utf8' })
      assert.fail('夹具 red 必须非零退出')
    } catch (error) {
      redRun = error
    }
    assert.equal(redRun.status, 1)
    const payload = JSON.parse(redRun.stdout)
    assert.equal(payload.ok, false)
    assert.equal(payload.rows[0].verdict, VERDICT.broken)
    const out = execFileSync(process.execPath, ['verify-capabilities.mjs', '--json', '--vendor-root', root, '--capabilities', green], { cwd: HERE, encoding: 'utf8' })
    assert.equal(JSON.parse(out).ok, true)
    assert.ok(DEFAULT_VENDOR_ROOT.endsWith(join('vendor', 'harness-checkout')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
