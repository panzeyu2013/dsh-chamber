/**
 * 上游会话事实语义的**源码 lockstep 锁**（design 14 §D4；checklist §4 登记项）。
 *
 * 运行位活性守卫与 tier-3 写回押在以下上游事实上，而此前只有仓内接线/语义测试、**没有
 * 读 vendor 源**的 lockstep（上游改语义时静默 fail-open）。本文件直接读 pin 住的 vendor 源
 * （`vendor/harness-packages/@deepseek-ai/*`，由 ensure-harness-vendor 建链、指向 submodule）
 * 逐条钉住：
 *  1. `api-session/status` 是 `dsh-api-remotes` 白名单里的 **emit 型**转发事件；
 *  2. 客户端半 `ctx.remote.$on('api-session/status')` → `sessions.handleSessionStatus(...)`；
 *  3. `ClientSessions.handleSessionStatus` 是**公开**方法（且不在 `ISessions` 契约里 ——
 *     写回因此是「上游公开但非契约」的面，pin 升级必须在此处见红而不是静默降级）；
 *  4. 它一次写三处：list summaries（`recordMutation` 的 `status` mutation）、物化
 *     Session（`handleRunning`，聊天面）与 catalog activity；
 *  5. `refreshList()` 对 remote 失败**照常 resolve**（只置 `listState='error'`）并把权威
 *     running 下推已物化会话；
 *  6. `mergeOrderedBaseline` **移除**权威基线里缺席的 id（⑨ 缺席行不会永久留存）。
 *
 * 语义一变即红：维护者应按 design 14 §D4 重推守卫/写回，而不是把断言改绿。
 *
 * **缺 vendor 树的口径**（2026-12 四轮独立复核修正）：默认**响亮失败**，与仓内其它 vendor 门
 * 一致（C6 缺 submodule 树即失败、open-in 的 vendor 契约测试 ENOENT 即失败）——「本地绿」
 * 绝不能靠静默跳过换来。只有确为无 submodule 的本地 worktree 才显式设
 * `DSH_CHAMBER_VENDOR_ABSENT=skip`；CI 不设该变量，这六条语义因此在 CI 上必然执行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** pin 住的 vendor 链接树（ensure-harness-vendor 建链）。 */
const VENDOR = fileURLToPath(new URL('../../../../vendor/harness-packages/@deepseek-ai/', import.meta.url))
const MISSING = !existsSync(VENDOR + 'dsh-api-session-controller/src/client/sessions/manager.ts')
const OPT_OUT = process.env.DSH_CHAMBER_VENDOR_ABSENT === 'skip'

const readVendor = (relative: string): string => readFileSync(VENDOR + relative, 'utf8')

if (MISSING) {
  console.error(`[vendor-lockstep] vendor 树未物化：${VENDOR}`)
  console.error(OPT_OUT
    ? '[vendor-lockstep] DSH_CHAMBER_VENDOR_ABSENT=skip 已显式设置 ⇒ 本文件跳过（CI 不设该变量）。'
    : '[vendor-lockstep] 默认失败：本 lockstep 必须读 pin 住的 vendor 源。'
      + '若确为无 submodule 的本地 worktree，显式设 DSH_CHAMBER_VENDOR_ABSENT=skip。')
}

/** 缺树时：默认按断言失败处理（响亮），只有显式 opt-out 才 skip。 */
const vendorTest = (name: string, body: () => void): void => {
  test(name, { skip: MISSING && OPT_OUT ? 'vendor tree absent; explicit DSH_CHAMBER_VENDOR_ABSENT=skip' : false }, () => {
    if (MISSING) {
      assert.fail('vendor/harness-packages 未物化：本 lockstep 读 pin 住的 vendor 源，缺树即失败'
        + '（显式 DSH_CHAMBER_VENDOR_ABSENT=skip 才跳过）。')
    }
    body()
  })
}

vendorTest('上游：api-session/status 在 dsh-api-remotes 白名单里是 emit 型（无重传/无重放的根据）', () => {
  const whitelist = readVendor('dsh-api-remotes/src/remote-events.ts')
  assert.match(whitelist, /\{ event: 'api-session\/status', mode: 'emit' \}/,
    'api-session/status 必须仍是 emit 型；改成 waterfall/baseline 型意味着上游可能已给出口，守卫/写回须重推')
  const remotes = readVendor('dsh-api-remotes/src/index.ts')
  assert.match(remotes, /if \(mode === 'emit'\)/,
    '转发装配的 emit 分支必须仍在（白名单是 host 全局的：任何 host 插件 emit 同名事件都会被转发）')
})

vendorTest('上游：客户端订阅 api-session/status 并交给 handleSessionStatus', () => {
  const client = readVendor('dsh-api-session-controller/src/client/index.ts')
  assert.match(client, /ctx\.remote\.\$on\('api-session\/status', \(sessionId, running\) => \{/,
    '客户端必须仍以 $on 订阅该事件（tier-3 写回走的正是它下游的同一个方法）')
  assert.match(client, /sessions\.handleSessionStatus\(sessionId, running\)/,
    '订阅体必须仍直连 handleSessionStatus')
})

vendorTest('上游：handleSessionStatus 是公开方法、且一次写 summaries + 物化 Session + catalog activity', () => {
  const service = readVendor('dsh-api-session-controller/src/client/sessions/service.ts')
  assert.match(service, /handleSessionStatus\(\.\.\.args: Parameters<SessionManager\['handleSessionStatus'\]>\): void \{/,
    'chamber 的 tier-3 写回调用 ClientSessions.handleSessionStatus —— 签名/可见性一变，写回即须重推')
  assert.match(service, /this\.manager\.handleSessionStatus\(\.\.\.args\)/,
    'service 层必须仍委托给 manager（两跳都在链上）')
  const manager = readVendor('dsh-api-session-controller/src/client/sessions/manager.ts')
  assert.match(manager, /handleSessionStatus\(sessionId: SessionId, running: boolean\): void \{/,
    'manager 侧的签名变了 ⇒ 写回的语义前提变了')
  assert.match(manager, /this\.recordMutation\(\{ kind: 'status', sessionId, running \}\)/,
    '必须仍写 list summaries（侧栏行）')
  assert.match(manager, /this\.sessions\.get\(sessionId\)\?\.handleRunning\(running\)/,
    '必须仍写物化 Session（聊天面 running）')
  assert.match(manager, /this\.updateCatalogActivity\(sessionId, running\)/,
    '必须仍写子代理 catalog activity')
})

vendorTest('上游：refreshList 对 remote 失败照常 resolve（回执必须自带权威判定）且把 running 下推', () => {
  const manager = readVendor('dsh-api-session-controller/src/client/sessions/manager.ts')
  assert.match(manager, /this\.listState = 'error'/,
    '失败只置 listState（promise 仍 resolve）——这是 verify seam 必须存在的根据')
  assert.match(manager, /session\.handleRunning\(s\.running\)/,
    'refreshList 必须仍把权威 running 回灌到已物化会话（契约内修复路径）')
  assert.match(manager, /if \(this\.listInflight !== null\) return this\.listInflight/,
    '单飞语义必须仍是「复用在途 promise」——悬挂形态（STATUS ③）正是写回存在的原因')
})

vendorTest('上游：mergeOrderedBaseline 移除权威基线里缺席的 id（⑨「缺席行」不会永久留存）', () => {
  const baseline = readVendor('dsh-api-session-controller/src/client/ordered-baseline.ts')
  assert.match(baseline, /identities absent from the baseline are removed/,
    '缺席 id 被移除的语义变了 ⇒ STATUS ⑨ 的严重性须重估')
  assert.match(baseline, /const merged = current\s*\n?\s*\.map\(value => baselineByKey\.get\(keyOf\(value\)\)\)\s*\n?\s*\.filter\(\(value\): value is T => value !== undefined\)/,
    '实现必须仍是「按权威值取行、缺席即过滤」')
})

vendorTest('上游：handleSessionStatus 不在 ISessions 契约里（chamber 的能力守卫与上游诉求的依据）', () => {
  const contract = readVendor('dsh-api-session-controller/src/client/contract/sessions.ts')
  assert.doesNotMatch(contract, /handleSessionStatus/,
    '该面一旦进入契约，chamber 的非契约依赖与上游诉求（proposals §4 第 6 条）即可删除')
  assert.match(contract, /refresh\(\): Promise<void>/,
    '契约里的 refresh() 必须仍在（chamber 的 L1 走它）')
})