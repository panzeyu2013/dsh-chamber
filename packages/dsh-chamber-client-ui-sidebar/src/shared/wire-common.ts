/**
 * 六载体 unary 调用机件中的纯微工具(P4-1 登记,审计编号 N6;基线 2026-09
 * 字节级审计,行号以本次改引时为准)。六个自建客户端载体各自手写同一套
 * unary 调用机件:
 * - A packages/dsh-chamber-client-ui-sidebar/src/shared/instance-api.ts
 * - B packages/dsh-chamber-client-ui-sidebar/src/shared/plugin-graph-recheck.ts
 * - C packages/dsh-chamber-client-ui-settings-bridge/src/client/bridge-api.ts
 * - D packages/dsh-chamber-client-ui-settings-connections/src/client/plugin-inventory-api.ts
 * - E packages/dsh-chamber-client-ui-git/src/shared/git-api.ts(仅参考——本模块不收 E 的任何实现)
 * - F packages/renderer/src/host-graph.ts(仅参考)
 *
 * 只收经逐字节核实为「同体/同语义」的纯件,零行为差异:
 *
 * - isRecord:函数体在 B、C、D、E 逐字同体
 *   (`typeof value === 'object' && value !== null && !Array.isArray(value)`;
 *   空对象/Date 等非数组对象均收窄为 record,数组与 null 排除)。各家仅
 *   收窄签名不同——B: `Record<string, unknown>`,C/D: `Record<PropertyKey,
 *   unknown>`,E: `Record<string, any>`;本文件取 B 的签名(本包内唯一消费
 *   方的原签名)。A 与 F 无本地 isRecord(F 用内联 typeof 检查)。
 *
 * - mintRpcId:正文逐字来自 A(instance-api.ts mintRpcId)——crypto.randomUUID
 *   主路径与 B/C/D/F 各处的裸 `crypto.randomUUID()` 等价(B: plugin-graph-
 *   recheck.ts;C: bridge-api.ts;D: plugin-inventory-api.ts;F: host-graph.ts,
 *   同为准 UUIDv4 字符串);randomUUID 不可用时的 `rpc-` 回退沿用 A(零依赖:
 *   仅全局 crypto/Date/Math)。E 的 rpcId() 回退带 `git-` 前缀且 base-16,
 *   语义不同,不收(留在 git 包)。
 *
 * 明确未收(P4-1 逐字核对后不同体,或所在文件不在本步可改范围——详见
 * P4-1 报告,这些留给 P4-2 决策):
 * - server-response 信封断言/解析:A 校验 rpcId 回声、错误走兜底链
 *   ('internal'/'实例返回未知错误');B/F 为 report/throw 风格且不做 rpcId/
 *   type 校验;仅 C≡D 骨架相近但文案前缀('bridge:'/'plugin-inventory:')与
 *   ok 值整形(D 做快照行类型解析)不同——均非纯同体。
 * - 503 instance_unavailable 分类与「实例未就绪/不可达」文案:P4-2 判定留在各
 *   载体本地(理由见下方 P4-2 段)——C≡D 的 503 分支与 wrapWireError 虽逐字
 *   同体,同体字节的动作在 B/F/A 各不相同,收编等于把本地策略配置化;A 的回退
 *   文案('the instance is not ready')/InstanceUnavailableError 类身份/中止
 *   透传均不同;B/F 把 instance_unavailable 当「不可判定」静默路径(无文案)。
 * - sleep/delay:六载体中仅 F(host-graph.ts retry.sleep)有 setTimeout-
 *   promise,sidebar 载体(A/B)无对应实现。
 * - 路径 basename:A 的 basenameOf 处理 `\\` 与根路径回退;E coordinator.ts
 *   pathBasename 仅 POSIX 分隔符且根路径返回 ''(调用点另做 `||` 兜底)——
 *   不同体。
 *
 * 零运行时依赖、零 node 内建、零 import:sidebar shared 会被 renderer
 * composite 静态 import,本模块必须保持纯浏览器可达。
 *
 * P4-2 登记(N6 续):低层 unary 发送内核 postUnary + B≡F 的分类正则收编,见文末
 * 两段。内核的职责边界 = 四载体(C/D/B/F)逐字同块的「URL 拼接 + fetch(POST,
 * JSON body、content-type 头)+ 收集响应体 + JSON 解析」;把 {ok:false,error,...}
 * 信封与 HTTP 态原样交给本地分类。每处本地策略(503 instance_unavailable 的
 * 处理、错误折行文案、信封校验、ok 值整形、重试)一律留在载体本地:
 * - C/D 的 503「实例未就绪」throw 与 wrapWireError「实例不可达:」折行:C≡D
 *   逐字同体,但同一 503 检测字节在 B(‘unchanged’ 不写回)/F(resolve-null)
 *   是另两种动作,A(P4-3)还是第三种(InstanceUnavailableError 类身份),折行
 *   文案 C/D('实例不可达:')与 B/F('宿主启动图不可达:')也不同——收编只能靠
 *   按调用方不同取值的策略选项(onUnavailable/折行回调),那正是 P4-2 规则排除
 *   的「配置化本地策略」,故 503 分支与 wrapWireError 留在各载体本地(选项规则:
 *   选项只有当不改变任何现有调用语义时才进签名)。
 * - envelope/server-response 解析(前缀、rpcId 回显、ok 整形):P4-1 已核实各端
 *   不同体,仍留本地。
 * - A(instance-api)本步不改;P4-3 裁定不合并(见文末 P4-3 段);E(git-api)
 *   禁改。
 */

/** True for any non-null, non-array object (a Record-shaped wire object).
 *  Boundary semantics match the B/C/D/E copies verbatim: an empty object and
 *  a Date are records; arrays, null, and non-objects are not. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Correlation id minted per unary request and echoed by the server-response
 *  envelope (A instance-api.ts, verbatim; B/C/D/F's bare crypto.randomUUID()
 *  is the equivalent primary path). The `rpc-` fallback only fires where the
 *  global crypto lacks randomUUID, preserving A's no-crypto behavior. */
export function mintRpcId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/* ---------------------------------------------------------------------------
 * P4-2 登记(N6 续):低层 unary 发送内核(postUnary)。
 *
 * 收编范围 = 四载体逐字同块的发送字节,审计行号(以 P4-2 改引时为准):
 * - URL 拼接:C bridge-api.ts call() 与 D plugin-inventory-api.ts 的
 *   origin/base 三段同体(也是 F host-graph.ts fetchHostGraph 的同体段);统一
 *   形态 = `${base}${basePath}/api/${method}`(C: basePath='/api/i/<id>' +
 *   method='settings/describe' …;D/B/F 同形)。
 * - fetch 头 + envelope 行:B plugin-graph-recheck.ts L142-152 == F host-graph.ts
 *   L132-142(8 行 fetch 头逐字同体;rpcId 表达式 C/D/F 为裸 crypto.randomUUID()、
 *   B 为 mintRpcId(),同为准 UUIDv4 主路径,P4-1 判定等价——内核默认 mintRpcId(),
 *   C/D/F 为保持「无 randomUUID 环境照样抛错进本地折行」的逐字节语义,显式传
 *   rpcId: crypto.randomUUID());method/args 逐载体取值,envelope 形状四载体
 *   全同;`AbortSignal.timeout(30000)` 四载体同字节(官方 DEFAULT_TIMEOUT_MS)。
 * - 响应体收集:四载体都在 503(探 instance_unavailable,解析失败静默为「无体」)
 *   与 2xx(读 server-response 信封)读且只读一次 body;其余状态只看 status、
 *   从不读体(Response body 单次消费)。内核只收集+JSON 解析,解析结果原样交给
 *   本地:2xx 解析失败保留原始 rejection(C/D 原样重抛,B/F 折进各自文案);
 *   503 解析失败静默为「无体」(四载体同一个 `catch { body = null }` 字节)。
 *
 * 明确未收(每处选项只有当它不改变任何现有调用语义时才进签名,否则保持本地):
 * - 503 instance_unavailable 检测/动作与 wrapWireError/wrapRecheckError/
 *   wrapGraphError 折行:见文件头 P4-2 段——动作与文案逐载体不同。
 * - envelope/server-response 解析(前缀、ok 整形、rpcId 回显):各端不同体。
 * - payload 之外的任何方法面、缓存 Map、重试/诊断回调:页面语义,留本地。
 * - A(instance-api)未收(P4-3 裁定不合并,见文末 P4-3 段);E(git-api)禁改。
 * ------------------------------------------------------------------------ */

/** Bounded-unary budget of every postUnary call — the byte-identical
 *  `AbortSignal.timeout(30000)` all four carriers posted (official
 *  DEFAULT_TIMEOUT_MS): the control-plane proxy forwards without an upstream
 *  timeout, so a silently hung host must fail loud instead of pinning the
 *  settings page / inventory view / recheck pass / shell boot forever. */
const UNARY_TIMEOUT_MS = 30000

/** Options for one postUnary call. Every member defaults to the four
 *  carriers' current bytes, so passing none of them reproduces the shared
 *  behavior exactly; per-carrier seams (B's test deps) override only what
 *  they already overrode locally. */
export interface UnaryPostOptions {
  /** Client-request correlation id. Defaults to mintRpcId() (B's P4-1-migrated
   *  call site semantics). C/D/F keep their pre-migration bare
   *  crypto.randomUUID() by passing it here — the evaluation then stays in the
   *  caller's own try, preserving the exotic no-randomUUID failure path
   *  (a throw folded by the local wire-error wrapper, never a fallback id). */
  rpcId?: string
  /** fetch override — the test seam B's recheck exposes as deps.fetchImpl;
   *  defaults to the ambient fetch (C/D/F semantics). */
  fetchImpl?: typeof fetch
  /** Origin override — the test seam B's recheck exposes as deps.origin, used
   *  verbatim when set; defaults to the page-origin rule all four carriers
   *  share: location.origin, '' for the 'null'-origin document or a non-browser
   *  runtime. */
  origin?: string
}

/** The HTTP answer of one postUnary call with the body already collected.
 *  Classification is deliberately NOT performed here: every carrier decides
 *  locally what a 503 instance_unavailable / non-ok status / parse failure /
 *  envelope shape means for its own surface. */
export interface UnaryPostOutcome {
  /** HTTP status of the answer. */
  readonly status: number
  /** 2xx-class verdict (response.ok). */
  readonly ok: boolean
  /** The parsed JSON body when the answer body was collected and parseable
   *  (collected exactly on 503 and 2xx answers); undefined when the body was
   *  not read (every other status) or did not parse. */
  readonly body: unknown
  /** The ORIGINAL body-parse rejection when a 2xx body was not valid JSON
   *  (C/D rethrow it raw, B/F fold its message into their own copy);
   *  undefined otherwise — 503 parse failures are swallowed as "no body",
   *  the shared `catch { body = null }` byte of all four carriers. */
  readonly jsonError: unknown
}

/** One bounded unary POST of the dsh-v0.1.2-alpha.1 client-request envelope
 *  (`{type:'client-request', rpcId, method, payload:{args}}`) to
 *  `<origin><basePath>/api/<method>`. Transport rejections propagate RAW
 *  (unwrapped, unclassified) — each carrier folds them with its own wire-error
 *  copy, exactly as its local try around the fetch did before.
 *  @param basePath - the per-instance proxy prefix ('/api/i/<id>').
 *  @param method - the slash Remote endpoint ('clientGraph/graph', …).
 *  @param args - the Remote method's positional argument values.
 *  @param options - seams; all optional, see UnaryPostOptions. */
export async function postUnary(
  basePath: string,
  method: string,
  args: Record<string, unknown>,
  options: UnaryPostOptions = {},
): Promise<UnaryPostOutcome> {
  let origin: string | undefined
  if (options.origin === undefined) {
    origin = typeof location !== 'undefined' ? location.origin : undefined
  } else {
    origin = options.origin
  }
  const base = origin !== undefined && origin !== 'null' ? origin : ''
  const url = `${base}${basePath}/api/${method}`
  const fetchImpl = options.fetchImpl ?? fetch
  // Transport rejections are NOT folded here: each carrier keeps its own
  // try/catch with its own error copy around the kernel call.
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: options.rpcId ?? mintRpcId(),
      method,
      payload: { args },
    }),
    signal: AbortSignal.timeout(UNARY_TIMEOUT_MS),
  })
  // Collect + JSON-parse on exactly the statuses every carrier reads. Other
  // statuses are classified by status alone and their body is never consumed.
  if (response.status === 503 || response.ok) {
    try {
      const body: unknown = await response.json()
      return { status: response.status, ok: response.ok, body, jsonError: undefined }
    } catch (error) {
      if (response.status === 503) {
        // Shared `catch { body = null }` byte: a failing 503-body parse reads
        // as "no body" — the code probe simply misses.
        return { status: response.status, ok: response.ok, body: undefined, jsonError: undefined }
      }
      return { status: response.status, ok: response.ok, body: undefined, jsonError: error }
    }
  }
  return { status: response.status, ok: response.ok, body: undefined, jsonError: undefined }
}

/** B≡F 的 host-graph 通道失败分类(P4-2 收编;审计行号 B plugin-graph-recheck.ts
 *  ≈ F renderer/src/host-graph.ts 的 `/not.?found|unknown.?method|method.+…/i`
 *  正则三分支,逐字同体):调用面错误文案(code+message 拼串)提及 not-found /
 *  unknown-method / missing / unsupported → 通道在答但方法/行缺失 →
 *  'not-injected';其余一律 'graph-unreachable'。纯函数,零运行时依赖;两个载体
 *  各自把结果折进本地消息与错误(「宿主启动图:graph 调用失败:…」)——收编后
 *  两处的镜像正则不可能再漂移。 */
export function classifyGraphChannelFailure(classification: string): 'not-injected' | 'graph-unreachable' {
  return /not.?found|unknown.?method|method.+(?:missing|unknown|unsupported)/i.test(classification)
    ? 'not-injected'
    : 'graph-unreachable'
}

/* ---------------------------------------------------------------------------
 * P4-3 登记(N6 续,2026-09):「C bridge-api 传输层落回 A instance-api」等价性
 * 分析 → 裁定不合并。行号以本次改引时为准(A = sidebar instance-api.ts,
 * C = settings-bridge bridge-api.ts)。逐维核对结论:
 *
 * - 信封协议:两方 wire 请求体逐字同形({type:'client-request', rpcId, method,
 *   payload:{args:{参数名:…}}}——A 的命名空间访问器先在 payload 层包
 *   {args:…}(L198-236),C 经 postUnary 内包;URL/头/30s 同)。响应同为
 *   server-response {ok,value|error}。差异在解析:回声校验 A call() 内
 *   envelope.rpcId === 发出 rpcId 否则 throw 'rpcId mismatch…'(L173-175,
 *   与官方 client rpc.ts L96-98 同);C parseRemoteResult 仅校验 rpcId 为
 *   string、不做相等(L174)——回声容忍差。真机证据:被调端点(session/* 与
 *   settings/* 同为 per-instance dsh host 的同一 generic-RPC gateway)恒
 *   回声(rpc-host.ts L275、rpc-schema.ts L43-47、cp rpc-envelope.ts
 *   L154-176 均以回声为协议不变量),故对合规应答两方等价;容忍差仅在协议
 *   违例响应(错 id/非记录信封)上可观测。
 * - 错误模型/文案(均为用户可见:行控制器 state.error = err.message,
 *   permission-row-controller.ts L164-169):
 *   - 503 instance_unavailable:A throw 私有类 InstanceUnavailableError
 *     (message = 代理原文,默认 'the instance is not ready')(L156-166),折行
 *     在 A 包装层——保类身份、前缀 '实例未就绪：'(L277-281);C 在 client
 *     内 throw plain Error '实例未就绪：' + body.error ?? '实例尚未就绪'
 *     (L71-76)。控制平面 503 体恒带 error 字段(writeError {error,code},
 *     proxy-forward.ts L519-520),故默认文案是死分支、前缀+代理原文文本两方
 *     相同,但错误类身份/err.name 与折行点不同。
 *   - 非 2xx:A 'transport failure for <endpoint>: HTTP <n>'(L167,包装层再折
 *     '实例不可达：');C '实例不可达：HTTP <n>'(L77-79)——文案不同。
 *   - 2xx 体解析失败:A 原始 rejection 在包装层折 '实例不可达：';C 原样
 *     rethrow outcome.jsonError(L80,不折)——折行与否不同。
 *   - 信封/result 校验:C TypeError('bridge: invalid …',result 非 record /
 *     ok 非布尔 / error.code·message 非 string)(L175-185);A 不抛,走
 *     code 'internal'/message '实例返回未知错误'/details {} 兜底链
 *     (L178-185);details 非 record:C 丢弃、A 透传——业务失败整形不同。
 * - 超时/中止:A AbortSignal.any([30s, 外部 signal])(L147-149),且其包装层对
 *   AbortError/TimeoutError 直通不折(L282-284);C 无外部 signal 参数,30s
 *   超时 rejection 一律折 '实例不可达：'。
 * - rpcId 表达式:A mintRpcId(无 randomUUID 环境回退 'rpc-' 前缀,永不抛);
 *   C 裸 crypto.randomUUID() 且评估在自身 try 内——无 randomUUID 环境抛错
 *   并折 '实例不可达：'(P4-2 逐字节保留的旧语义;两方容忍不同)。
 * - origin/basePath:A resolveOrigin 无 location/‘null’ origin 时回退
 *   'http://dsh.internal'(L120-123,L145);C 经 postUnary 同环境得 '' → 相对
 *   URL(wire-common L173-180)。浏览器真运行(origin 恒在)下两方等价。
 * - 缓存:A Map<instanceId> + getInstanceClient/releaseInstanceClient
 *   (L239-253,release 全仓零调用);C Map<instanceId> + getBridgeApiClient、
 *   无 release(L201-210)。键(instanceId,无 token)与增长语义今日等价;释放
 *   路径两方均为死码(仅 A 暴露了导出)。
 *
 * 裁定:按 N6 纪律(存在任何可观测行为差——回声容忍、错误类身份/文案、
 * 信封校验严格度与兜底、details 整形、超时错误直通 vs 折行、无 randomUUID
 * 容忍、origin 回退——即不合并),P4-3 不合并:C 保留自建 BridgeApiClient +
 * Map,其 envelope/503/折行已是 P4-1/P4-2 声明的本地策略,传输字节已与 A 同
 * 源(本文件 postUnary)。要合并需先统一:① 回声——C 接受 A 的 rpcId 相等校
 * 验(含 'rpcId mismatch' 折行路径)或为 A 增开「免回声」模式;② 503 错误类
 * 身份与默认文案(InstanceUnavailableError 导出与否 + 'the instance is not
 * ready' vs '实例尚未就绪');③ 非 2xx 文案(是否嵌端点名)与 2xx 解析失败折
 * 行与否;④ 信封校验严格度(C TypeError vs A 兜底链)与 details 非 record 处
 * 理;⑤ TimeoutError/AbortError 直通 vs 折行 + 外部 signal 语义;⑥ origin
 * 回退统一;⑦ 缓存共享(两包实例隔离消失、A 侧 release 一旦被调用将波及 C)。
 * 任一项未决前不动 A/C 传输面;本段即 P4-3 登记,STATUS 行由 P4 总执行并入。
 * ------------------------------------------------------------------------ */
