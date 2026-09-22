/**
 * 载体 unary 调用机件中的纯微工具。自建客户端载体各自手写同一套
 * unary 调用机件:
 * - A packages/dsh-chamber-client-ui-sidebar/src/shared/instance-api.ts
 * - B packages/dsh-chamber-client-ui-sidebar/src/shared/plugin-graph-recheck.ts
 * - D packages/dsh-chamber-client-ui-settings-connections/src/client/plugin-inventory-api.ts
 * - E packages/dsh-chamber-client-ui-git/src/shared/git-api.ts(仅参考——本模块不收 E 的任何实现)
 * - F packages/renderer/src/host-graph.ts(仅参考)
 *
 * 消费本文件共享件的载体：A（`instance-api.ts` 取 mintRpcId）、
 * B（`plugin-graph-recheck.ts`）、D（settings-connections 的
 * `plugin-inventory-api.ts` 经 shared 面）与 F（`renderer/src/host-graph.ts`
 * 直接 import postUnary + 分类件）；E 仅参考，不收其任何实现。
 *
 * 本文件只放「同体/同语义」的纯件,零行为差异:
 *
 * - isRecord:函数体在 B、D、E 逐字同体
 *   (`typeof value === 'object' && value !== null && !Array.isArray(value)`;
 *   空对象/Date 等非数组对象均收窄为 record,数组与 null 排除)。各家仅
 *   收窄签名不同——B: `Record<string, unknown>`,D: `Record<PropertyKey,
 *   unknown>`,E: `Record<string, any>`;本文件取 B 的签名(本包内唯一消费
 *   方的原签名)。A 与 F 无本地 isRecord(F 用内联 typeof 检查)。
 *   (今日唯一消费方是 D，其调用点只做字符串键读取,`Record<PropertyKey, unknown>` 与
 *   `Record<string, unknown>` 收窄在该面上无行为差异;E 属禁改包,仍留本地。)
 *
 * - mintRpcId:正文逐字来自 A(instance-api.ts mintRpcId)——crypto.randomUUID
 *   主路径与 B/D/F 各处的裸 `crypto.randomUUID()` 等价(B: plugin-graph-
 *   recheck.ts;D: plugin-inventory-api.ts;F: host-graph.ts,
 *   同为准 UUIDv4 字符串);randomUUID 不可用时的 `rpc-` 回退沿用 A(零依赖:
 *   仅全局 crypto/Date/Math)。E 的 rpcId() 回退带 `git-` 前缀且 base-16,
 *   语义不同,不收(留在 git 包)。
 *
 * 未共享的件(与共享面不同体,或所在文件不在可改范围):
 * - server-response 信封断言/解析:A 校验 rpcId 回声、错误走兜底链
 *   ('internal'/'实例返回未知错误');B/F 为 report/throw 风格且不做 rpcId/
 *   type 校验;D 的骨架相近但文案前缀('plugin-inventory:')与
 *   ok 值整形(D 做快照行类型解析)不同——均非纯同体。
 * - 503 instance_unavailable 分类与「实例未就绪/不可达」文案:判定留在各
 *   载体本地——D 的 503 分支与 wrapWireError 虽逐字
 *   同体(token 级;缩进随嵌套深度不同),同体字节的动作在 B/F/A 各不相同,共享
 *   等于把本地策略配置化;A 的回退文案('the instance is not ready')/
 *   InstanceUnavailableError 类身份/中止透传均不同;B/F 把 instance_unavailable
 *   当「不可判定」静默路径(无文案)。
 *   D 的 wrapWireError 折叠与 503 instance_unavailable throw 位于共享面
 *   wire-error.ts(无选项构造器 + throw 守卫,零语义变化)——本条"留在本地"指
 *   未共享的 A/B/F 策略层与分类动作;详见 wire-error.ts 头注释。
 * - sleep/delay:各载体中仅 F(host-graph.ts retry.sleep)有 setTimeout-
 *   promise,sidebar 载体(A/B)无对应实现。
 * - 路径 basename:A 的 basenameOf 处理 `\\` 与根路径回退;E coordinator.ts
 *   pathBasename 仅 POSIX 分隔符且根路径返回 ''(调用点另做 `||` 兜底)——
 *   不同体。
 *
 * 零运行时依赖、零 node 内建、零 import:sidebar shared 会被 renderer
 * composite 静态 import,本模块必须保持纯浏览器可达。
 *
 */

/** True for any non-null, non-array object (a Record-shaped wire object).
 *  Boundary semantics match the B/D/E copies verbatim: an empty object and
 *  a Date are records; arrays, null, and non-objects are not. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Correlation id minted per unary request and echoed by the server-response
 *  envelope (A instance-api.ts, verbatim; B/D/F's bare crypto.randomUUID()
 *  is the equivalent primary path). The `rpc-` fallback only fires where the
 *  global crypto lacks randomUUID, preserving A's no-crypto behavior. */
export function mintRpcId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/* ---------------------------------------------------------------------------
 * 低层 unary 发送内核(postUnary)的职责边界。
 *
 * 内核承载 B/D/F 逐字同块的发送字节:URL 拼接(`${base}${basePath}/api/
 * ${method}`)+ fetch(POST, JSON body、content-type 头)+ 收集响应体 + JSON
 * 解析;把 {ok:false,error,...} 信封与 HTTP 态原样交给本地分类。响应体只在
 * 503(探 instance_unavailable,解析失败静默为「无体」)与 2xx(读
 * server-response 信封)读且只读一次;其余状态只看 status、从不读体(Response
 * body 单次消费)。2xx 解析失败保留原始 rejection(D 原样重抛,B/F 折进各自
 * 文案);503 解析失败静默为「无体」(三载体同一个 `catch { body = null }` 字节)。
 *
 * 未共享——每处选项只有当它不改变任何现有调用语义时才进签名,否则保持本地:
 * - 503 instance_unavailable 检测/动作与 wrapWireError/wrapRecheckError/
 *   wrapGraphError 折行:见文件头——动作与文案逐载体不同。
 * - envelope/server-response 解析(前缀、ok 整形、rpcId 回显):各端不同体。
 * - payload 之外的任何方法面、缓存 Map、重试/诊断回调:页面语义,留本地。
 * - A(instance-api)未共享;E(git-api)禁改。
 * ------------------------------------------------------------------------ */

/** Bounded-unary budget of every postUnary call — the byte-identical
 *  `AbortSignal.timeout(30000)` the postUnary carriers post (official
 *  DEFAULT_TIMEOUT_MS): the control-plane proxy's 45s upstream idle window
 *  (design 03 §3.4; long-RPC paths exempted) outlasts this budget, so the
 *  client-side cap is what must fail loud — a silently hung host would
 *  otherwise pin the settings page / inventory view / recheck pass / shell
 *  boot until the proxy window. */
const UNARY_TIMEOUT_MS = 30000

/** Options for one postUnary call. Every member defaults to the current
 *  B/D/F bytes, so passing none of them reproduces the shared behavior
 *  exactly; per-carrier seams (B's test deps) override only what
 *  they already overrode locally. */
export interface UnaryPostOptions {
  /** Client-request correlation id. Defaults to mintRpcId() (B's call site
   *  semantics). D/F keep their bare crypto.randomUUID() by passing it here —
   *  the evaluation then stays in the caller's own try, preserving the exotic
   *  no-randomUUID failure path (a throw folded by the local wire-error
   *  wrapper, never a fallback id). */
  rpcId?: string
  /** fetch override — the test seam B's recheck exposes as deps.fetchImpl;
   *  defaults to the ambient fetch (D/F semantics). */
  fetchImpl?: typeof fetch
  /** Origin override — the test seam B's recheck exposes as deps.origin, used
   *  verbatim when set; defaults to the page-origin rule B/D/F
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
   *  (D rethrows it raw, B/F fold its message into their own copy);
   *  undefined otherwise — 503 parse failures are swallowed as "no body",
   *  the shared `catch { body = null }` byte of all three carriers. */
  readonly jsonError: unknown
}

/** One bounded unary POST of the dsh-v0.1.2-alpha.1 client-request envelope
 *  (`{type:'client-request', rpcId, method, payload:{args}}`) to
 *  `<origin><basePath>/api/<method>`. Transport rejections propagate RAW
 *  (unwrapped, unclassified) — each carrier folds them with its own wire-error
 *  copy, exactly as its local try around the fetch does.
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

/** B≡F 的 host-graph 通道失败分类(B plugin-graph-recheck.ts ≈ F
 *  renderer/src/host-graph.ts 的 `/not.?found|unknown.?method|method.+…/i`
 *  正则三分支,逐字同体):调用面错误文案(code+message 拼串)提及 not-found /
 *  unknown-method / missing / unsupported → 通道在答但方法/行缺失 →
 *  'not-injected';其余一律 'graph-unreachable'。纯函数,零运行时依赖;两个载体
 *  各自把结果折进本地消息与错误(「宿主启动图:graph 调用失败:…」)——两处共享
 *  同一实现,镜像正则不可能再漂移。 */
export function classifyGraphChannelFailure(classification: string): 'not-injected' | 'graph-unreachable' {
  return /not.?found|unknown.?method|method.+(?:missing|unknown|unsupported)/i.test(classification)
    ? 'not-injected'
    : 'graph-unreachable'
}
