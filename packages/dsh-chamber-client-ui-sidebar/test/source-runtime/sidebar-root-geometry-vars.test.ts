/**
 * Vendor lock: the `--dsh-sidebar-*` geometry words the shell publishes mirror the pinned
 * upstream ui-sidebar stylesheet. The three words below exist ONLY because the bundled
 * upstream CSS (ui-workspace rows, ui-settings-* panels) reads them; a silent drift would
 * re-break those surfaces' calc()/gap the same way an undefined word does. The fourth word
 * (inline padding) is chamber's own geometry and is deliberately NOT compared.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

const OWN = read('../../src/client/SidebarRoot.module.css')
const VENDOR_CSS = fileURLToPath(new URL(
  '../../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-sidebar/src/client/SidebarRoot.module.css',
  import.meta.url,
))
const MISSING = !existsSync(VENDOR_CSS)
const OPT_OUT = process.env.DSH_CHAMBER_VENDOR_ABSENT === 'skip'

if (MISSING) {
  console.error(`[vendor-lockstep] vendor 树未物化：${VENDOR_CSS}`)
  console.error(OPT_OUT
    ? '[vendor-lockstep] DSH_CHAMBER_VENDOR_ABSENT=skip 已显式设置 ⇒ 本文件跳过（CI 不设该变量）。'
    : '[vendor-lockstep] 默认失败：本 lockstep 必须读 pin 住的 vendor 源。')
}

test('the published sidebar geometry words carry the pinned vendor values',
  { skip: MISSING && OPT_OUT ? 'vendor tree absent; explicit DSH_CHAMBER_VENDOR_ABSENT=skip' : false },
  () => {
    if (MISSING) {
      assert.fail('vendor/harness-packages 未物化：本 lockstep 读 pin 住的 vendor 源，缺树即失败'
        + '（显式 DSH_CHAMBER_VENDOR_ABSENT=skip 才跳过）。')
    }
    const vendor = readFileSync(VENDOR_CSS, 'utf8')
    for (const word of ['--dsh-sidebar-row-padding', '--dsh-sidebar-label-gap', '--dsh-sidebar-paint-inset']) {
      const own = new RegExp(word + ':\\s*([^;]+);', 'u').exec(OWN)
      const up = new RegExp(word + ':\\s*([^;]+);', 'u').exec(vendor)
      assert.ok(own, `本壳必须发布 ${word}（随包上游 CSS 读它；缺定义 = 整条 calc/gap 声明失效）`)
      assert.ok(up, `vendor 侧找不到 ${word}：上游契约变了，重裁本仓的发布面`)
      assert.equal(own[1].trim(), up[1].trim(), `${word} 必须与 vendor pin 同值（本仓只镜像，不另立几何）`)
    }
  })