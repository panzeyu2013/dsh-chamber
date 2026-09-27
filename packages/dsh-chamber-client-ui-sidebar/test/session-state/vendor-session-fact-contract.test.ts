/**
 * 上游会话事实语义的**源码 lockstep 锁**（design 14 §D4；checklist §4 登记项）。
 *
 * 运行位活性守卫与 tier-3 写回押在以下上游事实上。本文件直接读 pin 住的 vendor 源
 * （`vendor/harness-packages/@deepseek-ai/*`，由 ensure-harness-vendor 建链、指向 submodule）
 * 逐条钉住：
 *  1. `api-session/status` 是 `dsh-api-remotes` 白名单里的 **emit 型**转发事件；
 *  2. 客户端半 `ctx.remote.$on('api-session/status')` → `sessions.handleSessionStatus(...)`；
 *  3. `ClientSessions.handleSessionStatus` 是**公开**方法（且不在 `ISessions` 契约里 ——
 *     写回因此是「上游公开但非契约」的面，pin 升级必须在此处见红而不是静默降级）；
 *  4. 它一次写三处：list summaries（`recordMutation` 的 `status` mutation，rc.2 起
 *     同时落 `agentAvailable: true`）、物化 Session（`handleRunning`，聊天面）与子代理
 *     父可用性（`updateParentAvailability`，rc.2 取代旧 catalog activity）；
 *  5. `refreshList()` 对 remote 失败**照常 resolve**（只置 `listState='error'`）并把权威
 *     running 下推已物化会话；
 *  6. `mergeOrderedBaseline` **移除**权威基线里缺席的 id（⑨ 缺席行不会永久留存）。
 *
 * 语义一变即红：维护者应按 design 14 §D4 重推守卫/写回，而不是把断言改绿。
 *
 * **缺 vendor 树的口径**：默认**响亮失败**，与仓内其它 vendor 门
 * 一致（C6 缺 submodule 树即失败、open-in 的 vendor 契约测试 ENOENT 即失败）——「本地绿」
 * 绝不能靠静默跳过换来。只有确为无 submodule 的本地 worktree 才显式设
 * `DSH_CHAMBER_VENDOR_ABSENT=skip`；CI 不设该变量，这六条语义因此在 CI 上必然执行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

/** pin 住的 vendor 链接树（ensure-harness-vendor 建链）。 */
const VENDOR = fileURLToPath(new URL('../../../../vendor/harness-packages/@deepseek-ai/', import.meta.url))
const MISSING = !existsSync(VENDOR + 'dsh-api-session-controller/src/client/sessions/manager.ts')
const OPT_OUT = process.env.DSH_CHAMBER_VENDOR_ABSENT === 'skip'

const readVendor = (relative: string): string => readFileSync(VENDOR + relative, 'utf8')

/**
 * 按**符号**定位一个 vendor 包里的源文件（`.ts/.tsx`）：路径不是契约，符号才是——
 * 上游挪文件不该让锁变红，符号消失才该。要求恰有一个文件命中（上游拆文件即红，
 * 维护者重新指向，而不是让断言悄悄测到别的文件）。
 */
const vendorSourceCache = new Map<string, string>()
const readVendorSourceProviding = (pkg: string, symbol: string): string => {
  const cached = vendorSourceCache.get(pkg + '\u0000' + symbol)
  if (cached !== undefined) return cached
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = dir + '/' + entry.name
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!/\.tsx?$/.test(entry.name)) continue
      if (readFileSync(path, 'utf8').includes(symbol)) hits.push(path)
    }
  }
  walk(VENDOR + pkg + '/src')
  hits.sort()
  assert.equal(hits.length, 1,
    `vendor 源 ${pkg} 里应恰有一个文件包含 ${symbol}（找到 ${hits.length}: ${hits.join(', ')}）——`
    + '上游若拆分/改名，维护者须重新指向并按 design 06 §4.3 重推运行位解析。')
  return readFileSync(hits[0]!, 'utf8')
}

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
  assert.match(manager, /this\.recordMutation\(\{ kind: 'status', sessionId, running, agentAvailable: true \}\)/,
    '必须仍写 list summaries（侧栏行）并落 agentAvailable 事实（rc.2 的行可用性语义；写回因此不能让行变成不可用）')
  assert.match(manager, /this\.sessions\.get\(sessionId\)\?\.handleRunning\(running\)/,
    '必须仍写物化 Session（聊天面 running）')
  assert.match(manager, /this\.updateParentAvailability\(\)/,
    '必须仍刷新子代理父可用性（rc.2 取代旧 updateCatalogActivity；语义变了 ⇒ 写回的副作用须重推）')
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

vendorTest('上游：官方运行位解析 = status?.running ?? s.running（chamber 唯一规则的来源）', () => {
  const nav = readVendorSourceProviding('dsh-client-ui-workspace', 'visiblePendingKind')
  assert.match(nav, /const status = statuses\.get\(s\.id\)/,
    '该规则的前提是会话节点能取到自己的 status 行')
  assert.match(nav, /running: status\?\.running \?\? s\.running/,
    '官方 nav 的运行位必须仍是「status 投影优先、列表行兜底」；规则一变，resolveSessionRunning '
    + '与它的全部消费点（环/事实通道/运行身份/子代理计数）必须按 design 06 §4.3 重推')
  assert.match(nav, /completed: status\?\.completionUnread === true/,
    '官方完成位读的是 sessionStatus.completionUnread；若上游改回 store 行字段，chamber 的完成归属（生产者消费）须重审')
  assert.match(nav, /statuses\.get\(child\.id\)\?\.running \?\? list\.byId\[child\.id\]\?\.running/,
    '**子行**运行位走同一规则——chamber 的 indexSubagentDescendants 镜像的正是这条，'
    + '改成单读 list 行会让子代理运行环与官方计数分歧')
})

vendorTest('上游：status 投影行形状（running 可为 undefined ⇒ 回落的 ?? 是承重的）', () => {
  // 定位符用**复合表达式**而非裸标识符：裸标识符在真实多文件 src 树里可能多处命中
  // （恰一命中的断言会因上游拆文件而假红），且它不能与下面的断言同义。
  const status = readVendorSourceProviding('dsh-client-ui-session', 'this.completionUnread.has')
  assert.match(status, /running: this\.running\.get\(id\)/,
    'status 行的 running 直取观测表 ⇒ 可能是 undefined（不是布尔默认）')
  assert.match(status, /completionUnread: this\.completionUnread\.has\(id\)/,
    '完成未读与运行位同源同拍发布')
  assert.match(status, /\.\.\.this\.pendingSnapshot\.keys\(\)/,
    'id 并集含「只因 pending 交互而存在」的行 ⇒ 那些行的 running 必然 undefined，回落分支是必需的')
  assert.match(status, /\$on\('api-session\/status', \(sessionId, running\) => \{[\s\S]{0,120}observeRunning/,
    'status 由 frame 直驱——这正是它可能领先于 list 行、从而必须优先的根据')
  assert.doesNotMatch(status, /running: this\.running\.get\(id\) \?\?/,
    'status 行的 running 必须仍原样透出观测（可为 undefined）；上游若给它兜底成布尔，'
    + 'chamber 侧「?? 承重」的回落语义就消失了')
  assert.match(status, /sessions\.list\.subscribe\(\(\) => \{ this\.reconcileStatus\(\) \}\)/,
    'list→status 回灌（reconcileStatus）仍在：这是 status 行通常有定义的根据，也是两链可分歧的根据')
  assert.match(status, /if \(running\) this\.completionUnread\.delete\(sessionId\)/,
    'true→false 的完成未读语义仍在（tier-3 写回的爆炸半径：写回会点亮官方完成位）')
  assert.match(status, /else if \(\(previous === true \|\| \(previous === undefined && beforeBaseline\)\)/,
    '未读只在「真观测过 running」之后武装——诊断性写回不得被误当作运行观测')
})

vendorTest('对齐锁：chamber 生产者消费官方 completionUnread（读投影 → 第 6 参 → 稀疏行字段）', () => {
  // vendor 只给事实（内存 Set）；chamber 侧必须真的把它读出来、写进通道行——
  // 生产者的唯一入口是 projectRuntimeFacts 的第 6 参，行字段稀疏（true 才写）。
  const producer = stripComments(readFileSync(fileURLToPath(new URL('../../src/client/index.ts', import.meta.url)), 'utf8'))
  assert.match(producer, /const readStatusCompleted = \(\): ReadonlySet<string> => \{/,
    '生产者必须定义官方完成位的读（与 readStatusRunning 同一份 sessionStatus 投影）')
  assert.match(producer, /if \(status\.completionUnread === true\) ids\.add\(sessionId\)/,
    '只有官方为真才进集合（稀疏）：缺席 = 未武装，chamber 不得自行补位')
  assert.match(producer,
    /projectRuntimeFacts\(snapshot, subagentRunning, pendingBySession, runIds, statusRunning, readStatusCompleted\(\)\)/,
    '该读必须作为第 6 参喂给 projectRuntimeFacts（完成位唯一的生产者入口）')
  const derive = stripComments(readFileSync(fileURLToPath(new URL('../../../dsh-chamber-client-core/src/derive.ts', import.meta.url)), 'utf8'))
  assert.match(derive, /statusCompleted\?: ReadonlySet<string>/, 'projectRuntimeFacts 声明第 6 余参 statusCompleted')
  assert.match(derive, /if \(statusCompleted\?\.has\(id\) === true\) row\.completed = true/,
    '行字段必须只在官方位为真时稀疏写入（true 才写字段）')
  assert.doesNotMatch(derive, /row\.completed = false/, '清位只由官方集合缺席表达，绝不写 false 字段')
})

vendorTest('对齐锁：客户端 store 行没有 completed —— 官方 completionUnread 才是唯一来源', () => {
  const list = readVendorSourceProviding('dsh-api-session-controller', 'id: entry.sessionId')
  // 断言锚刻意不同于定位符（否则是自证）：parentId 的改名才是 ambient 模型的另一半依据。
  assert.match(list, /parentId: entry\.parentSessionId/,
    'store 行把 sessionId 改名为 id、parentSessionId 改名为 parentId（ambient 模型的依据）')
  assert.match(list, /retainedBy: this\.retentionSnapshot\(entry\.sessionId\)\.retainedBy/,
    "current 判定所依赖的 retainedBy 必须仍在 store 行上")
  assert.doesNotMatch(list, /completed:/,
    'store 行必须仍无 completed：完成位的唯一官方载体是 sessionStatus.completionUnread（chamber 经生产者消费，见上一条对齐锁）')
})

vendorTest('上游：visiblePendingKind 三档与 chamber pendingKindOf 逐字一致（词表缺口登记）', () => {
  const nav = readVendorSourceProviding('dsh-client-ui-workspace', 'visiblePendingKind')
  for (const kind of ['approval', 'plan-review', 'question']) {
    // 引号不敏感：源里是单引号，构建产物里是双引号。
    assert.match(nav, new RegExp('case [\'"]' + kind + '[\'"]'),
      '待办词表必须仍含 ' + kind + '；词表一变，pendingKindOf 与琥珀点/等待分类须同步')
  }
})

vendorTest('上游：归档准入是两段式（无 stopActivity 拒绝 + details.activity；带则写归档后由 provider 停止）', () => {
  // 1) 注册表：非 stopActivity 路径以活动拒绝；stopActivity 路径由宿主自己的
  //    workspace/session-stop provider 停止该会话的工作（chamber 不再有客户端补偿腿）。
  const registry = readVendorSourceProviding('dsh-workspace', 'WorkspaceActiveSessionError')
  // 逐字 includes（非正则）：锚点全是代码原文，转义不参与，改一处即红。
  assert.ok(registry.includes('if (options.stopActivity !== true) {'),
    'stopActivity 必须短路活动检查（否则第二调仍会被拒）')
  assert.ok(registry.includes('if (activity.length > 0) throw new WorkspaceActiveSessionError(sessionId, activity)'),
    '非 stopActivity 路径必须在写入前以活动拒绝')
  assert.ok(registry.includes('if (options.stopActivity === true) await this.stopSessionActivity(sessionId)'),
    'stopActivity 路径必须由宿主的 provider 停止会话工作')
  // 2) 活动条目形状：items 可选（turn 家族不带）、label 可选（chamber 以 id 兜底）。
  const activityTypes = readVendorSourceProviding('dsh-workspace', 'readonly items?: readonly SessionActivityItem[]')
  assert.ok(activityTypes.includes('readonly label?: string'),
    'label 必须仍可选（chamber 的确认列表以 id 兜底）')
  // 3) RPC：拒绝码 + details 的 activity 载体（chamber 的 sessionArchiveRefusal 只认这一对）。
  const commands = readVendorSourceProviding('dsh-api-workspace-controller', 'activity: error.activity')
  assert.ok(commands.includes("'workspace/session-active'"),
    '拒绝码必须仍是 workspace/session-active')
  // 4) 官方客户端：首调不带 stopActivity，拒绝后才带 stopActivity 重发；拒绝按 error.name 认
  //    （跨 bundle 类身份不可靠），chamber 同 bundle 因此用 instanceof + code。
  const officialClient = readVendorSourceProviding('dsh-client-ui-workspace', 'activeSessionRefusal')
  assert.ok(officialClient.includes("reason.name !== 'WorkspaceArchiveError'"),
    '官方客户端按 error.name 识别归档拒绝')
  assert.ok(officialClient.includes('uiWorkspace.archiveSession(sessionId).then'),
    '首调必须不带 stopActivity')
  assert.ok(officialClient.includes('archiveSession(sessionId, { stopActivity: true })'),
    '确认后必须带 stopActivity 重发')
  assert.ok(officialClient.includes("rpcError.code === 'workspace/session-active' ? rpcError.details.activity : undefined"),
    '拒绝解析必须只认该码并读 details.activity')
  // 5) 请求字段本身是加法契约（wire 类型文件按路径读，同 §handleSessionStatus 的先例）：
  //    上游改名会让 chamber 的确认相位退回首调语义而所有测试仍绿。
  const archiveRequest = readVendor('dsh-api-workspace-controller/src/types.ts')
  assert.ok(archiveRequest.includes('export interface WorkspaceArchiveSessionRequest {')
    && archiveRequest.includes('readonly stopActivity?: boolean'),
  '请求字段 stopActivity 必须仍是可选布尔（chamber 只在确认后发送它）')
  assert.ok(commands.includes('request.stopActivity === true ? { stopActivity: true } : {}'),
    'controller 必须把 stopActivity 原样转发给 registry（否则第二调退化为首调）')
  // 6) 顺序：先写归档集、再 await 宿主停止——确认相位的成功语义押在「resolve 时归档已持久」。
  const archiveWrite = registry.indexOf('archivedSessionIds: [...state.archivedSessionIds, sessionId],')
  const stopAfterWrite = registry.indexOf('if (options.stopActivity === true) await this.stopSessionActivity(sessionId)')
  assert.ok(archiveWrite !== -1 && stopAfterWrite > archiveWrite,
    '必须先把 session 写进归档集、再 await 停止（顺序变了确认的成功含义就变了）')
  // 7) 停止 provider 失败被吞（记日志、不重抛）：归档已落时确认相位仍 resolve，
  //    chamber 的 confirmArchive 不会把「已归档但停止失败」报成整体失败。
  const stopPass = readVendorSourceProviding('dsh-workspace', 'workspace/session-stop')
  assert.ok(stopPass.includes("await this.ctx.parallel('workspace/session-stop', { sessionId })"),
    '宿主停止必须走 workspace/session-stop provider')
  assert.ok(stopPass.includes('this.ctx.logger.warn('),
    'provider 失败必须只记日志、不重抛（确认相位仍 resolve）')
})

vendorTest('上游：handleSessionStatus 不在 ISessions 契约里（chamber 的能力守卫与上游诉求的依据）', () => {
  const contract = readVendor('dsh-api-session-controller/src/client/contract/sessions.ts')
  assert.doesNotMatch(contract, /handleSessionStatus/,
    '该面一旦进入契约，chamber 的非契约依赖与上游诉求（proposals §4 第 6 条）即可删除')
  assert.match(contract, /refresh\(\): Promise<void>/,
    '契约里的 refresh() 必须仍在（chamber 的 L1 走它）')
})