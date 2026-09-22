/**
 * gateway 凭据的两维交叉矩阵（design 17 §2.3；N8 前置，ARCH-IMPL-026）。
 *
 * design 17 §2.3 的原文约束：token 与 password 是**相互独立的 nullable 凭据**——
 * token 清除永不触碰实例 password（反之亦然）。本文件在**任何重构之前**把这条
 * 独立性以矩阵形式钉住：每个维度 × {写入 / 清除 / 清除不存在者} 之后，另一维度
 * 的值与绑定必须逐字不变；失败写入也不得污染另一维度。
 *
 * Run directly: node packages/desktop/test/gateway/gateway-credential-matrix.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configureGatewaySecretStore as configureRaw, getGatewayPassword, getGatewayToken,
  setGatewayPassword, setGatewayToken,
} from '../../gateway-provider.ts'
import type { TransportInstanceSpec } from '../../transport-provider.ts'

const TOKEN = '0123456789abcdef0123456789abcdef'
const PASSWORD = 'gateway-login-password-123'
const ID = 'gw-matrix'

function spec(id: string): TransportInstanceSpec {
  return {
    id, label: id, kind: 'gateway', transport: 'http', host: 'gw.example.com',
    user: null, sshPort: null, remotePort: 443, serviceName: null,
    remoteDshHome: null, insecureHttp: false,
  }
}

/** 每个用例一个临时密钥文件（避免跨用例状态）。 */
function withStore<T>(run: (file: string) => T, resolver: (id: string) => TransportInstanceSpec | null = spec): T {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-matrix-'))
  const file = join(dir, 'gateway-secrets.json')
  try {
    assert.equal(configureRaw(file, undefined, resolver), null)
    return run(file)
  } finally {
    configureRaw(null, undefined, resolver)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('矩阵 1：只写 token —— password 维度完全不存在（值、绑定皆无）', () => {
  withStore(file => {
    setGatewayToken(ID, TOKEN)
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(stored.tokens[ID], TOKEN)
    assert.ok(stored.tokenBindings[ID], 'token 绑定随写入建立')
    assert.equal(getGatewayPassword(ID), null, 'password 仍然不存在')
    assert.equal(stored.passwords[ID], undefined, 'password 表未被 token 写入制造条目')
    assert.equal(stored.passwordBindings[ID], undefined, 'password 绑定未被 token 写入建立')
  })
})

test('矩阵 2：两维都写 —— 各自独立保存，互不覆盖', () => {
  withStore(file => {
    setGatewayToken(ID, TOKEN)
    setGatewayPassword(ID, PASSWORD)
    assert.equal(getGatewayToken(ID), TOKEN)
    assert.equal(getGatewayPassword(ID), PASSWORD)
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    assert.notEqual(stored.tokenBindings[ID], undefined)
    assert.notEqual(stored.passwordBindings[ID], undefined)
  })
})

test('矩阵 3（§2.3 核心）：清除 token 绝不触碰 password', () => {
  withStore(() => {
    setGatewayToken(ID, TOKEN)
    setGatewayPassword(ID, PASSWORD)
    setGatewayToken(ID, null)
    assert.equal(getGatewayToken(ID), null, 'token 已清除')
    assert.equal(getGatewayPassword(ID), PASSWORD, 'password 逐字保留')
    setGatewayToken(ID, `${TOKEN}2`)
    setGatewayPassword(ID, null)
    assert.equal(getGatewayPassword(ID), null)
    assert.equal(getGatewayToken(ID), `${TOKEN}2`, '反向同理：清除 password 不触碰 token')
  })
})

test('矩阵 4：清除「不存在的维度」是磁盘 no-op —— 另一维度与文件内容都不变', () => {
  withStore(file => {
    setGatewayPassword(ID, PASSWORD)
    // 哨兵法：把文件内容改成 store 内存里不存在的文本。若这次 clear 真的触发了
    // 落盘，文件会被内存表重写、哨兵消失——比「内容相等」更能锁住「不重写」本身。
    const sentinel = `${readFileSync(file, 'utf8')}\n/* sentinel-${Date.now()} */\n`
    writeFileSync(file, sentinel)
    setGatewayToken(ID, null)
    assert.equal(readFileSync(file, 'utf8'), sentinel, '无 token 可清时不得重写密钥文件')
    assert.equal(getGatewayPassword(ID), PASSWORD)
    assert.equal(getGatewayToken(ID), null)
  })
})

test('矩阵 5：非法 id 的拒绝文案分维（token / password 各自点名）', () => {
  withStore(() => {
    assert.throws(() => setGatewayToken('local', TOKEN), /refusing token for invalid instance id/)
    assert.throws(() => setGatewayPassword('local', PASSWORD), /refusing password for invalid instance id/)
    assert.equal(getGatewayToken('local'), null)
    assert.equal(getGatewayPassword('local'), null)
  })
})

test('矩阵 6：校验失败的写入不污染另一维度', () => {
  withStore(() => {
    setGatewayPassword(ID, PASSWORD)
    assert.throws(() => setGatewayToken(ID, 'short'), /./)
    assert.equal(getGatewayPassword(ID), PASSWORD, 'token 校验失败不影响已是 password 的维度')
    assert.equal(getGatewayToken(ID), null)
    setGatewayToken(ID, TOKEN)
    assert.throws(() => setGatewayPassword(ID, 'x'), /./)
    assert.equal(getGatewayToken(ID), TOKEN, '反向同理')
    assert.equal(getGatewayPassword(ID), PASSWORD, '被拒的 password 写入保持原值（不清除旧值）')
  })
})

test('矩阵 7：无匹配目标绑定时，两个维度**各自**拒绝且都不落盘（文案分维）', () => {
  // 实测行为：durable 文件 + 无目标绑定时，任一维度的写入*本身*就抛错（write-through
  // 的前提是绑定）；因此这里钉住「两维各自拒绝、互不代偿、文件无新条目」。
  withStore(file => {
    assert.throws(() => setGatewayToken(ID, TOKEN), /refusing to persist a gateway token/)
    assert.throws(() => setGatewayPassword(ID, PASSWORD), /refusing to persist a gateway password/)
    assert.equal(getGatewayToken(ID), null)
    assert.equal(getGatewayPassword(ID), null)
    assert.equal(existsSync(file), false, '两次写入都被拒 ⇒ 密钥文件从未创建（无半套落盘）')
  }, () => null)
})
