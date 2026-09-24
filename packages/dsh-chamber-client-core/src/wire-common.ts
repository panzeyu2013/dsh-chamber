/**
 * 载体 unary 调用机件中的纯微工具。多个自建客户端载体（client-core 的
 * instance-api.ts / plugin-graph-recheck.ts、settings-connections 的
 * plugin-inventory-api.ts、renderer 的 host-graph.ts）各自手写同一套 unary
 * 调用机件，这里只放「同体/同语义」的纯件，零行为差异：
 * - isRecord：函数体逐字同体；只取本包消费方的签名 `Record<string, unknown>`（调用点
 *   只做字符串键读取，收窄差异在该面无行为差异）；
 * - mintRpcId：正文逐字来自 instance-api.ts，crypto.randomUUID 主路径与各载体的裸
 *   调用等价，`rpc-` 回退沿用其零依赖实现（仅全局 crypto/Date/Math）。
 * 未共享：server-response 信封断言/解析、503 instance_unavailable 分类与文案、
 * sleep/delay、路径 basename——各载体动作或文案不同体，共享等于把本地策略配置化。
 * 本模块零运行时依赖、零 node 内建、零 import（renderer composite 静态 import，必须
 * 保持纯浏览器可达）。
 */

/** True for any non-null, non-array object (a Record-shaped wire object).
 *  Boundary semantics match the carrier copies verbatim: an empty object and a
 *  Date are records; arrays, null, and non-objects are not. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Correlation id minted per unary request and echoed by the server-response
 *  envelope (verbatim from instance-api.ts). The `rpc-` fallback only fires where
 *  the global crypto lacks randomUUID, preserving the no-crypto behavior. */
export function mintRpcId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/* ---------------------------------------------------------------------------
 * 低层 unary 发送内核(postUnary)的职责边界。
 *
 * 内核承载各载体逐字同块的发送字节:URL 拼接 + fetch(POST, JSON body、
 * content-type 头) + 收集响应体 + JSON 解析;把 {ok:false,error,...} 信封与 HTTP
 * 态原样交给本地分类。响应体只在 503(探 instance_unavailable,解析失败静默为
 * 「无体」)与 2xx(读 server-response 信封)读且只读一次;其余状态只看 status。
 * 2xx 解析失败保留原始 rejection;503 解析失败静默为「无体」。
 *
 * 未共享:503 检测/动作与 wrapWireError/wrapGraphTransportFailure 折行、envelope
 * 解析、payload 之外的方法面/缓存/重试回调——动作与文案逐载体不同,保持本地。
 * ------------------------------------------------------------------------ */

/** Bounded-unary budget of every postUnary call — the byte-identical
 *  `AbortSignal.timeout(30000)` the carriers post. The proxy's 45s upstream idle
 *  window outlasts it, so the client-side cap is what must fail loud. */
const UNARY_TIMEOUT_MS = 30000

/** Options for one postUnary call. Every member defaults to the current carrier
 *  bytes, so passing none reproduces the shared behavior exactly; per-carrier seams
 *  override only what they already overrode locally. */
export interface UnaryPostOptions {
  /** Client-request correlation id, defaulting to mintRpcId(). Callers that keep
   *  their bare crypto.randomUUID() pass it here so the evaluation stays in their
   *  own try (preserving the exotic no-randomUUID failure path). */
  rpcId?: string
  /** fetch override — the test seam; defaults to the ambient fetch. */
  fetchImpl?: typeof fetch
  /** Origin override — used verbatim when set; defaults to `location.origin`,
   *  or '' for the 'null'-origin document / a non-browser runtime. */
  origin?: string
}

/** The HTTP answer of one postUnary call with the body already collected.
 *  Classification is deliberately NOT performed here: every carrier decides locally
 *  what a 503 instance_unavailable / non-ok status / parse failure means. */
export interface UnaryPostOutcome {
  /** HTTP status of the answer. */
  readonly status: number
  /** 2xx-class verdict (response.ok). */
  readonly ok: boolean
  /** The parsed JSON body when it was collected and parseable (on 503 and 2xx
   *  answers); undefined when the body was not read or did not parse. */
  readonly body: unknown
  /** The ORIGINAL body-parse rejection when a 2xx body was not valid JSON
   *  (carriers rethrow it or fold its message); undefined otherwise — 503 parse
   *  failures are swallowed as "no body". */
  readonly jsonError: unknown
}

/** One bounded unary POST of the client-request envelope
 *  (`{type:'client-request', rpcId, method, payload:{args}}`) to
 *  `<origin><basePath>/api/<method>`. Transport rejections propagate RAW
 *  (unwrapped, unclassified) — each carrier folds them with its own wire-error
 *  copy, exactly as its local try around the fetch does. */
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
  // Transport rejections are NOT folded here: each carrier keeps its own try/catch.
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
  // Collect + JSON-parse on exactly the statuses every carrier reads; other statuses
  // are classified by status alone.
  if (response.status === 503 || response.ok) {
    try {
      const body: unknown = await response.json()
      return { status: response.status, ok: response.ok, body, jsonError: undefined }
    } catch (error) {
      if (response.status === 503) {
        // A failing 503-body parse reads as "no body" — the code probe simply misses.
        return { status: response.status, ok: response.ok, body: undefined, jsonError: undefined }
      }
      return { status: response.status, ok: response.ok, body: undefined, jsonError: error }
    }
  }
  return { status: response.status, ok: response.ok, body: undefined, jsonError: undefined }
}

/** host-graph 通道失败分类（各载体逐字同体的正则三分支），由
 *  `plugin-graph-classify.ts` 单一消费。调用面错误文案提及 not-found /
 *  unknown-method / missing / unsupported → 通道在答但方法/行缺失 → 'not-injected'；
 *  其余一律 'graph-unreachable'。纯函数，文案由消费方统一产出。
 */
export function classifyGraphChannelFailure(classification: string): 'not-injected' | 'graph-unreachable' {
  return /not.?found|unknown.?method|method.+(?:missing|unknown|unsupported)/i.test(classification)
    ? 'not-injected'
    : 'graph-unreachable'
}
