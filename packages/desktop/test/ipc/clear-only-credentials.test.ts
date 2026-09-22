/**
 * clear-only 凭据 IPC 的准入契约。
 *
 * 三个 legacy 凭据 setter（desktop_ssh_set_password / desktop_gateway_set_token /
 * desktop_gateway_set_password）共用同一段准入前奏：id 白名单 + 注册表存在性 +
 * 「非空写入一律拒绝」的 clear-only 拒绝文案；各自的**清除体保持独立**
 * （design 17 §2.3：token 与 password 是相互独立的凭据）。
 *
 * Run directly: node packages/desktop/test/ipc/clear-only-credentials.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { admitClearOnly } from '../../clear-only-credentials.ts'

type Spec = { id: string; kind: 'ssh' | 'gateway' }
// 后两条刻意放在注册表里但**违反 id 白名单**（`local` 被 lookahead 排除；超长 id）：
// 它们让白名单检查与「注册表存在性」解耦——否则 spec === undefined 会掩盖白名单被跳过的回归。
const registry: Spec[] = [
  { id: 'prod', kind: 'ssh' },
  { id: 'gw-1', kind: 'gateway' },
  { id: 'local', kind: 'ssh' },
  { id: 'x'.repeat(65), kind: 'ssh' },
]
const list = () => registry

const PASSWORD = { field: 'password', refusal: 'refused: password is clear-only', list } as const
const TOKEN = { field: 'token', refusal: 'refused: token is clear-only', list } as const

test('null / 空串是「清除」：放行并回带 id 与注册表 spec', () => {
  const cleared = admitClearOnly<Spec>(PASSWORD, { id: 'prod', password: null })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.ok && cleared.id, 'prod')
  assert.equal(cleared.ok && cleared.spec.kind, 'ssh')
  assert.equal(cleared.ok && cleared.clearing, true)
  const empty = admitClearOnly<Spec>(PASSWORD, { id: 'prod', password: '' })
  assert.equal(empty.ok, true)
})

test('非空写入被拒：拒绝文案**由调用侧描述符提供**（三种方法各自的字面文案）', () => {
  const pw = admitClearOnly<Spec>(PASSWORD, { id: 'prod', password: 'secret' })
  assert.deepEqual(pw, { ok: false, error: 'refused: password is clear-only' })
  const tk = admitClearOnly<Spec>(TOKEN, { id: 'gw-1', token: 'secret' })
  assert.deepEqual(tk, { ok: false, error: 'refused: token is clear-only' })
})

test('id 校验：非字符串 / 不合白名单（local 被排除）/ 未知 id / 缺失 id 一律同一错误', () => {
  for (const payload of [
    { id: 42, password: null },
    { id: 'local', password: null },
    { id: 'nope', password: null },
    { password: null },
    { id: 'a b', password: null },
    // 存在性通过、白名单不通过：只有白名单能挡住这两条。
    { id: 'local', password: null },
    { id: 'x'.repeat(65), password: null },
  ]) {
    assert.deepEqual(admitClearOnly<Spec>(PASSWORD, payload), { ok: false, error: 'invalid or unknown instance id' })
  }
})

test('凭据值类型：非字符串非 null 一律判非法（数字/布尔/对象）', () => {
  for (const password of [42, true, {}, []]) {
    assert.deepEqual(admitClearOnly<Spec>(PASSWORD, { id: 'prod', password }), { ok: false, error: 'invalid or unknown instance id' })
  }
})

test('独立字段：token 描述符不读 password 字段（反之亦然）', () => {
  // 同一 payload：对 password 描述符是「非空写入」（拒），对 token 描述符是「未提供 → 不清除」（拒，但理由不同）。
  const asPassword = admitClearOnly<Spec>(PASSWORD, { id: 'prod', password: 'x' })
  const asToken = admitClearOnly<Spec>(TOKEN, { id: 'prod', password: 'x' })
  assert.equal(asPassword.ok, false)
  assert.equal(asToken.ok, false)
  assert.equal(asPassword.ok === false && asPassword.error, 'refused: password is clear-only')
  assert.equal(asToken.ok === false && asToken.error, 'invalid or unknown instance id', 'token 未提供时不能当成一次清除')
})
