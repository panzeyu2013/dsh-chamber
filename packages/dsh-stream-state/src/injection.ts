/**
 * Cross-shell fault-injection harness (P1 acceptance).
 *
 * ONE protocol, three scenarios: `frame-stop` (the page's animation loop stops -
 * the Electron probe or the Swift watchdog must observe it), `append-silent`
 * (bytes reach the transport but the consumer never receives a frame) and
 * `break-streams` (the physical carrier dies). A shell ARMS the harness
 * explicitly (acceptance driver or page console); nothing fires without it, so
 * the production path pays one global read.
 *
 * PURITY: zero imports, no clock reads (callers stamp `at`). The wrapper is a
 * generic async-iterable decorator, so a carrier leg composes it without the
 * harness module importing the transport.
 */

export type InjectionScenario = 'frame-stop' | 'append-silent' | 'break-streams'

const INJECTION_SCENARIOS: readonly InjectionScenario[] = ['frame-stop', 'append-silent', 'break-streams']

/** The page global the probe script and the acceptance driver share. */
const INJECTION_GLOBAL_KEY = '__dshChamberInjection'

export interface InjectionPlan {
  readonly scenario: InjectionScenario
  /** Re-arm period; the first fault fires on the first poll. */
  readonly everyMs: number
  /** Total faults; undefined = unbounded until clear(). */
  readonly count?: number
}

export interface InjectionAction {
  readonly seq: number
  readonly scenario: InjectionScenario
  readonly at: number
}

export interface InjectionHarness {
  arm(plan: InjectionPlan): void
  /** At most one action per scenario per poll; idempotent at the same `at`. */
  poll(at: number): readonly InjectionAction[]
  /** Consume one scenario only (a carrier item must not eat an unrelated fault). */
  consume(scenario: InjectionScenario, at: number): boolean
  /** Scenarios with pending faults (the page script's read-only question). */
  armed(): readonly InjectionScenario[]
  clear(): void
}

interface ArmedPlan {
  readonly everyMs: number
  remaining: number
  nextAt: number
}

export function createInjectionHarness(): InjectionHarness {
  const plans = new Map<InjectionScenario, ArmedPlan>()
  let seq = 0
  return {
    arm(plan) {
      if (!INJECTION_SCENARIOS.includes(plan.scenario)) return
      plans.set(plan.scenario, {
        everyMs: Number.isFinite(plan.everyMs) && plan.everyMs > 0 ? plan.everyMs : 0,
        remaining: plan.count === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(plan.count)),
        nextAt: 0,
      })
    },
    poll(at) {
      const due: InjectionAction[] = []
      for (const [scenario, plan] of plans) {
        if (plan.remaining <= 0) continue
        if (Number.isFinite(at) && at < plan.nextAt) continue
        plan.remaining -= 1
        plan.nextAt = at + plan.everyMs
        due.push({ seq: ++seq, scenario, at })
        if (plan.remaining <= 0) plans.delete(scenario)
      }
      return due
    },
    consume(scenario, at) {
      const plan = plans.get(scenario)
      if (plan === undefined || plan.remaining <= 0) return false
      if (Number.isFinite(at) && at < plan.nextAt) return false
      plan.remaining -= 1
      plan.nextAt = at + plan.everyMs
      if (plan.remaining <= 0) plans.delete(scenario)
      return true
    },
    armed() {
      return [...plans.keys()]
    },
    clear() {
      plans.clear()
    },
  }
}

/** Publish the harness under the one page global (idempotent). */
export function installInjectionHarness(target: unknown, harness: InjectionHarness): void {
  ;(target as Record<string, unknown>)[INJECTION_GLOBAL_KEY] = harness
}

export function readInjectionHarness(target: unknown = globalThis): InjectionHarness | undefined {
  const candidate = (target as Record<string, unknown> | null | undefined)?.[INJECTION_GLOBAL_KEY]
  if (candidate === null || typeof candidate !== 'object') return undefined
  const view = candidate as Partial<InjectionHarness>
  if (typeof view.poll !== 'function' || typeof view.consume !== 'function'
      || typeof view.armed !== 'function') return undefined
  return candidate as InjectionHarness
}

/** One scenario's fault, consumed once (the per-item carrier read). */
function injectedFault(
  harness: InjectionHarness | undefined,
  scenario: InjectionScenario,
  at: number,
): boolean {
  if (harness === undefined) return false
  return harness.consume(scenario, at)
}

export interface InjectedOpenOptions {
  readonly name: string
  /** Read per call: a harness may be installed after this leg was built. */
  readonly harness: () => InjectionHarness | undefined
  /** The consumer's retryable carrier error (the gateway passes RemoteStreamCarrierError). */
  readonly makeBreakError: (reason: string) => Error
  readonly now?: () => number
}

/**
 * Decorate a carrier `open` leg. Without an armed harness this forwards items
 * unchanged; `break-streams` throws the consumer's carrier error, and
 * `append-silent` holds the consumer until the signal aborts (bytes arrived, no
 * frame did) - exactly the two starvations the carrier watchdog owns.
 */
export function wrapOpenWithInjection<Item>(
  open: (signal: AbortSignal) => AsyncIterable<Item>,
  options: InjectedOpenOptions,
): (signal: AbortSignal) => AsyncIterable<Item> {
  const now = options.now ?? ((): number => Date.now())
  return signal => ({
    async *[Symbol.asyncIterator]() {
      for await (const item of open(signal)) {
        const harness = options.harness()
        if (harness === undefined) {
          yield item
          continue
        }
        if (injectedFault(harness, 'break-streams', now())) {
          throw options.makeBreakError(options.name + ': injected carrier break')
        }
        if (injectedFault(harness, 'append-silent', now())) {
          await new Promise<void>(resolve => {
            if (signal.aborted) {
              resolve()
              return
            }
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return
        }
        yield item
      }
    },
  })
}
