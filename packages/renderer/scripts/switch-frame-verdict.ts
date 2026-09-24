/**
 * 切源「无白帧」判据：对逐帧观测做三形态判定（任一命中即 FAIL）：
 *  (a) 无可见视图帧（`visibleView === null`）；
 *  (b) 平坦 #fff 帧（可见面是无内容平面且颜色 = 设计系统默认浅色 #ffffff）；
 *  (c) 主题失配进度面：可见面是进度面，其颜色既不是目标来源的精确期望色（cache 命中），
 *      也不落在 chamber 暗色族（无 cache 时的回退）；
 *  第 4 条：目标在切换前已 settle（温壳）时，切换窗口内不应出现任何进度面帧。
 *
 * 判据是纯函数，只判**采集到的事实**：探针异常 / 未演练 / 未采到帧一律 `ok === null` = INFO
 * （"没执行"绝不读成绿）；`applyRequireSwitch` 在严格旗标下把未演练的 INFO 升为 FAIL。
 * Leg B 像素采样率受 screencast 帧率限制（静止期可能没有帧），Leg A（DOM 逐帧）是主判据。
 */

/** 无 cache 时进度面底色的回退族：相对亮度低于该值视为 chamber 暗色域。 */
export const DARK_SURFACE_MAX_LUMA = 64

export interface SwitchFrameSample {
  /** 探针单调钟读数（ms）。 */
  at: number
  /** Leg A：该帧可见视图的 data-instance；null = 没有任何可见视图（形态 a）。 */
  visibleView?: string | null
  /** Leg A：本腿切换的目标来源（探针在点击前声明）。 */
  selectedView?: string | null
  /** Leg A：可见视图里遮罩（进度面）在 DOM 且可见。 */
  veil?: boolean
  /** Leg A：遮罩的 computed backgroundColor（DOM 真值，不需要截图）。 */
  veilBg?: string | null
  /** Leg B：内容区为平面时的众数颜色；区域有内容时为 null。 */
  flatColor?: string | null
  /** Leg B：内容区非众数像素占比（0..1）。 */
  inkRatio?: number | null
  /** 目标在**切换前**已 settle（温壳）；缺省 = 未知（该帧不参与第 4 条判定）。 */
  targetSettledBeforeSwitch?: boolean
  /** 该帧可见视图的相位（Leg A 的 data-phase，可缺省；只进证据不进判据）。 */
  phase?: string | null
}

export interface SwitchFrameCounts {
  frames: number
  /** 形态 (a)：无可见视图帧。 */
  noVisibleViewFrames: number
  /** 形态 (b)：平坦 #fff 帧（浅色目标来源已声明豁免的帧不计）。 */
  flatWhiteFrames: number
  /** 形态 (c)：主题失配的进度面帧。 */
  themeMismatchedFrames: number
  /** 观测到进度面的帧数（证据用）。 */
  veilFrames: number
  /** 温壳（切换前已 settle）上仍出现进度面的帧数（第 4 条）。 */
  settledVeilFrames: number
}

export interface SwitchFrameVerdictInput {
  samples?: readonly SwitchFrameSample[]
  /** 目标来源 cache 命中时的精确期望底色（App 的 per-source 主题快照；缺省 = 无 cache）。 */
  expectedVeilBg?: Readonly<Record<string, string>>
  /** 声明的浅色来源：它们的纯白/浅色平面是合法主题，不判 (b)/(c)。 */
  declaredLightViewIds?: readonly string[]
  /** 本腿是否真的演练过切换（未演练 ⇒ INFO；`--require-switch` 下升 FAIL）。 */
  switchExercised?: boolean
  /** 探针异常（非空 ⇒ INFO，"探针坏了"不得读成通过）。 */
  error?: string | null
}

export interface SwitchFrameVerdict {
  /** true = 过；false = FAIL；null = INFO（未执行/无法判定）。 */
  ok: boolean | null
  counts: SwitchFrameCounts
  evidence: string
}

/** 解析 CSS 颜色（#rgb/#rrggbb/rgb()/rgba()）为 {r,g,b,a}；无法解析返回 null。 */
function parseColor(value: unknown): { r: number; g: number; b: number; a: number } | null {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text)
  if (hex !== null) {
    const digits = hex[1]
    const parts = digits.length === 3
      ? [digits[0] + digits[0], digits[1] + digits[1], digits[2] + digits[2]]
      : [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)]
    return { r: parseInt(parts[0], 16), g: parseInt(parts[1], 16), b: parseInt(parts[2], 16), a: 1 }
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(text)
  if (fn === null) return null
  const parts = fn[1].split(/[,\/]/).map(part => part.trim()).filter(part => part !== '')
  if (parts.length < 3) return null
  const channel = (part: string): number => {
    if (part.endsWith('%')) return Math.round((Number(part.slice(0, -1)) / 100) * 255)
    return Math.round(Number(part))
  }
  const r = channel(parts[0])
  const g = channel(parts[1])
  const b = channel(parts[2])
  const a = parts[3] === undefined ? 1 : (parts[3].endsWith('%') ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3]))
  if (![r, g, b, a].every(Number.isFinite)) return null
  return { r, g, b, a }
}

/** 归一化为 `#rrggbb`（alpha < 0.5 视为不确定 ⇒ null：半透明面下面是什么颜色不是本帧事实）。 */
function normalizeColor(value: unknown): string | null {
  const parsed = parseColor(value)
  if (parsed === null || parsed.a < 0.5) return null
  const hex = (channel: number): string => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, '0')
  return '#' + hex(parsed.r) + hex(parsed.g) + hex(parsed.b)
}

/** 相对亮度（0..255）。 */
function luma(color: string): number {
  const parsed = parseColor(color)
  if (parsed === null) return 255
  return 0.2126 * parsed.r + 0.7152 * parsed.g + 0.0722 * parsed.b
}

function isWhite(color: string): boolean {
  return color === '#ffffff'
}

function isDarkSurface(color: string): boolean {
  return luma(color) <= DARK_SURFACE_MAX_LUMA
}

const EMPTY_COUNTS: SwitchFrameCounts = {
  frames: 0,
  noVisibleViewFrames: 0,
  flatWhiteFrames: 0,
  themeMismatchedFrames: 0,
  veilFrames: 0,
  settledVeilFrames: 0,
}

function info(evidence: string, counts: SwitchFrameCounts = EMPTY_COUNTS): SwitchFrameVerdict {
  return { ok: null, counts, evidence }
}

/** 三形态 + 温壳进度面判定（规则见文件头）；`ok === null` 是 INFO，不是通过。 */
export function switchFrameVerdict(input: SwitchFrameVerdictInput = {}): SwitchFrameVerdict {
  const error = input.error
  if (error !== null && error !== undefined && String(error) !== '') {
    return info(`探针异常（${String(error)}）：本次逐帧白帧判定未执行——"探针坏了"不得读成通过`)
  }
  if (input.switchExercised !== true) {
    return info('本次运行未演练来源切换（<2 个来源 / 未点中行？）：白帧判定不适用')
  }
  const samples = Array.isArray(input.samples) ? input.samples.filter(sample => sample !== null && typeof sample === 'object') : []
  if (samples.length === 0) {
    return info('切换已演练但一帧都没有采到（探针未装/读回丢失）：白帧判定不适用')
  }
  const declaredLight = new Set(input.declaredLightViewIds ?? [])
  const expectedVeilBg = input.expectedVeilBg ?? {}
  const counts: SwitchFrameCounts = { ...EMPTY_COUNTS, frames: samples.length }
  const firstAt = { noVisible: null as number | null, white: null as number | null, mismatch: null as number | null, settledVeil: null as number | null }
  for (const sample of samples) {
    const target = typeof sample.selectedView === 'string'
      ? sample.selectedView
      : (typeof sample.visibleView === 'string' ? sample.visibleView : null)
    const lightSource = target !== null && declaredLight.has(target)
    if (sample.visibleView === null) {
      counts.noVisibleViewFrames += 1
      firstAt.noVisible ??= sample.at
      continue
    }
    if (sample.veil === true) counts.veilFrames += 1
    if (sample.veil === true && sample.targetSettledBeforeSwitch === true) {
      counts.settledVeilFrames += 1
      firstAt.settledVeil ??= sample.at
    }
    // 有效可见底：像素平面（Leg B）优先；没有像素事实时取遮罩底色（Leg A）。
    const surface = typeof sample.flatColor === 'string' ? normalizeColor(sample.flatColor) : null
    const veilSurface = sample.veil === true ? normalizeColor(sample.veilBg) : null
    const observed = surface ?? veilSurface
    if (observed === null || lightSource) continue
    if (isWhite(observed)) {
      counts.flatWhiteFrames += 1
      firstAt.white ??= sample.at
      continue
    }
    const expected = target !== null ? expectedVeilBg[target] : undefined
    const expectedColor = expected === undefined ? null : normalizeColor(expected)
    if (expectedColor !== null) {
      if (observed !== expectedColor) {
        counts.themeMismatchedFrames += 1
        firstAt.mismatch ??= sample.at
      }
    } else if (!isDarkSurface(observed)) {
      counts.themeMismatchedFrames += 1
      firstAt.mismatch ??= sample.at
    }
  }
  const failures: string[] = []
  if (counts.noVisibleViewFrames > 0) {
    failures.push(`形态(a) 无可见视图 ${counts.noVisibleViewFrames} 帧（首帧 t=${Math.round(firstAt.noVisible ?? 0)}ms）`)
  }
  if (counts.flatWhiteFrames > 0) {
    failures.push(`形态(b) 平坦 #fff ${counts.flatWhiteFrames} 帧（首帧 t=${Math.round(firstAt.white ?? 0)}ms）`)
  }
  if (counts.themeMismatchedFrames > 0) {
    failures.push(`形态(c) 主题失配进度面 ${counts.themeMismatchedFrames} 帧（首帧 t=${Math.round(firstAt.mismatch ?? 0)}ms）`)
  }
  if (counts.settledVeilFrames > 0) {
    failures.push(`温壳仍出现进度面 ${counts.settledVeilFrames} 帧（首帧 t=${Math.round(firstAt.settledVeil ?? 0)}ms）`)
  }
  const note = `帧 ${counts.frames}（进度面 ${counts.veilFrames}）`
  if (failures.length > 0) {
    return { ok: false, counts, evidence: `${note}：${failures.join('；')}——逐帧采样见 JSON 产物` }
  }
  return { ok: true, counts, evidence: `${note}：无可见视图帧 0、平坦 #fff 帧 0、主题失配进度面 0、温壳进度面 0` }
}

/** 严格旗标：未演练/探针坏掉给出 INFO 时改判 FAIL——一次"没执行"的运行不得读成绿。 */
export function applyRequireSwitch(verdict: SwitchFrameVerdict, requireSwitch: boolean): SwitchFrameVerdict {
  if (requireSwitch !== true || verdict.ok !== null) return verdict
  return {
    ...verdict,
    ok: false,
    evidence: `${verdict.evidence}（--require-switch：本次运行要求切换腿必须真实执行）`,
  }
}
