/**
 * i18n 结构对等签名的行为用例（升级计划 §22.3.7）：语言无关的骨架可比、
 * 语言相关的措辞/标题文本/表格内容不可比。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareStructures, signatureText, structuralSignature } from './i18n-structure.mjs'

const ZH = [
  '# 标题',
  '',
  '文字段落。',
  '',
  '## 第一节',
  '',
  '| 列 | 值 |',
  '|---|---|',
  '| a | b |',
  '',
  '```js',
  'const x = 1 // # 不是标题',
  '```',
  '',
  '<!-- GENERATED:block -->',
  '## 第二节',
  '',
].join('\n')

test('结构签名：只数语言无关的面（标题文本/正文/表格内容不参与）', () => {
  const en = ZH
    .replace('# 标题', '# Title')
    .replace('文字段落。', 'A paragraph.')
    .replace('## 第一节', '## First section')
    .replace('## 第二节', '## Second section')
    .replace('| a | b |', '| x | y |')
    .replace('const x = 1', 'const y = 2')
  assert.deepEqual(compareStructures(ZH, en), { ok: true, problems: [], zh: structuralSignature(ZH), en: structuralSignature(en) })
  assert.equal(signatureText(structuralSignature(ZH)), 'headings=[1,2,2] fences=2 tables=1 comments=1')
})

test('结构签名：`#hashtag`（无空格）与代码里的 # 不算标题', () => {
  const text = ['#hashtag', '```', '# in code', '```'].join('\n')
  const signature = structuralSignature(text)
  assert.deepEqual(signature.headings, [])
  assert.equal(signature.fences, 2)
})

test('结构不对等：镜像少一节 / 少一段代码 / 少一张表 / 少一个注释都必须报差异面', () => {
  const missingSection = compareStructures(ZH, ZH.replace('## 第二节\n', ''))
  assert.equal(missingSection.ok, false)
  assert.match(missingSection.problems.join('；'), /标题层级序列/u)

  const missingFence = compareStructures(ZH, ZH.replace('```js\nconst x = 1 // # 不是标题\n```\n', ''))
  assert.equal(missingFence.ok, false)
  assert.match(missingFence.problems.join('；'), /围栏代码块数/u)

  const missingTable = compareStructures(ZH, ZH.replace('| 列 | 值 |\n|---|---|\n| a | b |\n', ''))
  assert.equal(missingTable.ok, false)
  assert.match(missingTable.problems.join('；'), /表格数/u)

  const missingComment = compareStructures(ZH, ZH.replace('<!-- GENERATED:block -->\n', ''))
  assert.equal(missingComment.ok, false)
  assert.match(missingComment.problems.join('；'), /HTML 注释数/u)
})
