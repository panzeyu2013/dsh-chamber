/**
 * Minimal Cordis Context used by the api-gateway client behaviour suites.
 *
 * The vendor checkout ships cordis source only, with no built `lib/` the package
 * exports point at, so the suites drive the real `apply()` service through this
 * fake: a service registry (`provide` nests dotted names under `ctx.remote`, as
 * cordis does), the effect/plugin lifecycle the service owns, and the Typert
 * registry seam.
 */
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

export interface FakeContext {
  remote?: {
    $mount(contribution: TypertRemoteContribution): Promise<() => Promise<void>>
    probe?: unknown
  }
  readonly reflect: {
    readonly props: Record<string, unknown>
    provide(name: string, service: unknown): void
  }
  get(name: string): unknown
  effect(execute: () => unknown, label?: string): (() => unknown) & { then?: unknown }
  plugin(plugin: { name: string; apply(ctx: unknown): void }): unknown
  emit(name: string): void
  on(name: string, listener: unknown): () => void
  /** Test teardown: run every effect disposer in reverse order, like a fiber unload. */
  disposeAll(): Promise<void>
}

export function createFakeContext(connection: unknown): FakeContext {
  const fake = {} as FakeContext & Record<string, unknown>
  const services: Record<string, unknown> = { connection }

  const provide = (name: string, service: unknown): void => {
    const parts = name.split('.')
    let target: Record<string, unknown> = fake
    for (const part of parts.slice(0, -1)) {
      const next = target[part]
      if (next === undefined || typeof next !== 'object') target[part] = {}
      target = target[part] as Record<string, unknown>
    }
    target[parts[parts.length - 1] as string] = service
  }

  const effects: Array<() => Promise<unknown>> = []
  const effect: FakeContext['effect'] = execute => {
    const disposers: Array<() => unknown> = []
    const result = execute()
    if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
      void (result as Promise<unknown>).then(value => {
        if (typeof value === 'function') disposers.push(value as () => unknown)
      }, () => {})
    } else if (typeof result === 'function') {
      disposers.push(result)
    }
    let disposal: Promise<unknown> | undefined
    const dispose = (): Promise<unknown> => {
      if (disposal === undefined) {
        let task: Promise<unknown> | undefined
        for (const disposer of disposers.splice(0).reverse()) {
          task = task === undefined ? Promise.resolve(disposer()) : task.then(() => disposer())
        }
        disposal = task ?? Promise.resolve()
      }
      return disposal
    }
    // Cordis's async-effect disposer is itself awaitable; $mount awaits it to
    // know the namespace group is installed. It must resolve to a PLAIN value —
    // resolving to the callable itself would re-enter this thenable forever.
    ;(dispose as { then?: unknown }).then = (onFulfilled?: (value: unknown) => unknown) =>
      Promise.resolve(result).then(() => onFulfilled?.(undefined))
    effects.push(dispose)
    return dispose
  }

  const plugin: FakeContext['plugin'] = definition => {
    const child = Object.create(fake) as FakeContext
    const result = definition.apply(child)
    return {
      dispose: async () => {},
      then: (onFulfilled: (value: unknown) => unknown) => Promise.resolve(result).then(() => onFulfilled(undefined)),
    }
  }

  const disposeAll = async (): Promise<void> => {
    for (const dispose of effects.splice(0).reverse()) await dispose()
  }

  Object.assign(fake, {
    reflect: { props: {}, provide },
    disposeAll,
    get: (name: string) => services[name],
    effect,
    plugin,
    emit: () => {},
    on: () => () => {},
    typert: {
      remotes: { register: () => () => {} },
      contexts: { getClient: () => undefined },
    },
  })
  return fake
}
