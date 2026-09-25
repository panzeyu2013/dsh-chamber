import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { payloadNoticeSection } from './primary-runtime-notices.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const LOCK = JSON.parse(readFileSync(join(ROOT, 'packages/desktop/primary-runtime-lock.json'), 'utf8'))

test('载荷声明小节：CPython/node/每个 python 发行版都在，中英同集同序', () => {
  const zh = payloadNoticeSection('zh')
  const en = payloadNoticeSection('en')
  assert.ok(zh.includes('`CPython`'))
  assert.ok(zh.includes(LOCK.pythonVersion))
  assert.ok(zh.includes(LOCK.nodeVersion))
  assert.ok(en.includes('Bundled payload'))
  for (const [name, version] of Object.entries(LOCK.pythonPackages)) {
    assert.ok(zh.includes('`' + name + '`'), name + ' 中文缺行')
    assert.ok(zh.includes(version), name + ' 中文缺版本')
    assert.ok(en.includes('`' + name + '`'), name + ' 英文缺行')
  }
  const zhRows = zh.split('\n').filter((line) => line.startsWith('| `'))
  const enRows = en.split('\n').filter((line) => line.startsWith('| `'))
  assert.equal(zhRows.length, enRows.length, '中英行数必须相同')
  assert.equal(zhRows.length, Object.keys(LOCK.pythonPackages).length + 2, '每个发行版一行 + CPython + Node.js')
})

test('载荷声明小节：锁缺失必须抛（声明不能悄悄缺一段）', () => {
  const missing = join(ROOT, 'packages/desktop/definitely-missing-lock.json')
  assert.throws(() => payloadNoticeSection('zh', missing))
  assert.throws(() => payloadNoticeSection('en', missing))
})

test('载荷声明小节与生成产物锁步：两份声明都含该小节（跑 pnpm run gen:notices）', () => {
  const zhNotice = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  const enNotice = readFileSync(join(ROOT, 'docs/THIRD_PARTY_NOTICES.en-US.md'), 'utf8')
  assert.ok(zhNotice.includes(payloadNoticeSection('zh')), 'THIRD_PARTY_NOTICES.md 不含生成小节')
  assert.ok(enNotice.includes(payloadNoticeSection('en')), 'en-US 镜像不含生成小节')
})
