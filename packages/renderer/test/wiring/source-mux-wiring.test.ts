/**
 * W6 接线锁：SSH/dsh 远端来源必须**在没有只读镜像**的情况下也有一条只读观察通道，
 * 且它的快照必须走**同一条** applySessionFacts 管线（同形事实 = 同一套未读判定），
 * 生命周期随连接状态收敛（不泄观察者）。
 *
 * Run directly: node test/wiring/source-mux-wiring.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const APP = readFileSync(fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8')

test('only dsh/ssh sources get the mux observer, and only while connected', () => {
  assert.match(APP, /import \{ createSourceMuxFacts \} from '\.\/source-mux-facts\.ts'/)
  // 网关来源有自己的镜像事实源；这里只挑 kind === 'dsh'（SSH/其它 dsh 远端）。
  assert.match(APP, /filter\(server => server\.kind === 'dsh'\)/)
  assert.match(APP, /if \(server\.kind !== 'dsh' \|\| server\.connected !== true\) continue/)
})

test('observer snapshots ride the same facts pipeline (no second judgement path)', () => {
  assert.match(APP, /onSnapshot: snapshot => applySessionFacts\(sourceId, snapshot\)/)
  // 观察者的来源是页面 origin（控制面窗口同源），不是 host origin。
  assert.match(APP, /origin: window\.location\.origin/)
})

test('the observer lifecycle is torn down with the source (no leak) and is idempotent', () => {
  assert.match(APP, /sourceMuxTeardownRef\.current\.set\(sourceId, \(\) => observer\.stop\(\)\)/)
  // 身份（sourceId + fingerprint）而非仅 id：同 id 新化身必须重建观察者（审计 APP-9）。
  assert.match(APP, /sourceMuxIdentityRef\.current\.set\(sourceId, fingerprint\)/)
  assert.match(APP, /if \(wanted\.get\(sourceId\) === sourceMuxIdentityRef\.current\.get\(sourceId\)\) continue[\s\S]{0,220}?sourceMuxTeardownRef\.current\.delete\(sourceId\)[\s\S]{0,120}?sourceMuxIdentityRef\.current\.delete\(sourceId\)/)
  // 来源退役块必须同时收敛 gateway 事实源与无壳观察者（只拆一个会留下孤观察者）。
  assert.match(APP, /sessionFactsTeardownRef\.current\.delete\(sourceId\)[\s\S]{0,400}?sourceMuxTeardownRef\.current\.get\(sourceId\)\?\.\(\)[\s\S]{0,160}?sourceMuxIdentityRef\.current\.delete\(sourceId\)/)
})

test('the observer is read-only: no waterfall answer anywhere in its module', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/source-mux-facts.ts', import.meta.url)), 'utf8')
  const code = source.split('\n').filter(line => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//')).join('\n')
  assert.equal(code.includes('$events/result'), false)
  // send( 只在开场帧与（无）瀑布应答处出现：实现里只有一次 send 调用点。
  assert.equal((code.match(/\.send\(/g) ?? []).length, 1)
})
