/**
 * connection-intent.ts —— 连接意图（"本应用会话里被用户手动断开过"）的行内宿主元数据，
 * 以及排队尝试执行前的唯一授权判定。设计：v2 §P2-B（B 切片 §3.2.2–§3.2.5）。
 *
 * 事实模型（每条都是不变量，测试钉住）：
 * - 意图与行在**同一次整文件原子写**里：`ssh-instances.json` 的行对象带命名空间键
 *   `dshChamber.manualDisconnectSessionId`（spec 之外、非秘密、provider 白名单会剥掉它，
 *   因此不进 TransportInstanceSpec、不进任何身份/指纹）。
 * - 行消失 ⇒ 意图消失；同 id 重加 = 新行 = 无意图；编辑保留意图（desired state 不因
 *   spec 编辑重置）；补偿回滚恢复入口快照（C3：绝不把意图丢成"无"）。
 * - 只有 **本应用会话** 的标记抑制自动连接；无会话身份（Electron 冻结装配 / headless
 *   harness）⇒ 意图功能整体关闭：不读、不写、不抑制，行为与今天逐字相同。
 * - 载入宽松：宿主元数据坏形状 = 空对象，绝不计入 dropped、绝不因此丢整行。
 * - 意图写优先于盘（用户事实不能被写失败回滚）：写盘抛错 ⇒ 内存保持、`volatile:true`。
 *
 * 本文件是纯叶子：无 timer、无 fs、无 transport-manager 依赖（类型取自 provider，
 * 保持 import 图无环）；会话身份生成单源在 Swift 侧（AppDelegate），这里是 TS 镜像。
 */
import { describeError } from './describe-error.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'

/** 非秘密应用会话身份：Swift 每次应用进程装配生成一次；sidecar 崩溃重启复用；完全退出重开变化。 */
export type AppSessionId = string

/** sidecar 侧读取的环境变量（生产路径；Swift 在既有 childEnv 组装处注入一次）。 */
export const APP_SESSION_ID_ENV = 'DSH_CHAMBER_APP_SESSION_ID'
/** 显式参数（测试/诊断用；优先于 env）。 */
export const APP_SESSION_ID_FLAG = '--app-session-id'
/** 形状白名单：绝不让任意环境变量内容进入持久文件。 */
export const APP_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
/** 行文件里的宿主元数据命名空间键（spec 之外，避免与 provider 字段撞名）。 */
export const ROW_HOST_METADATA_KEY = 'dshChamber'

/** 行内宿主元数据（当前唯一字段 = 手动断开意图的会话 id；非秘密）。 */
export interface RowHostMetadata {
  readonly manualDisconnectSessionId?: string
}

/** 持久化行的形状：spec + 宿主元数据命名空间。旧读者/旧 provider 忽略未知键。 */
export type RosterRow = TransportInstanceSpec & { dshChamber?: RowHostMetadata }

/** 解析结果：session=null 表示本宿主不提供会话身份（意图功能关闭）；rejected 只报来源。 */
export interface AppSessionResolution {
  readonly session: AppSessionId | null
  readonly rejected: 'flag' | 'env' | null
}

/**
 * 解析顺序：flag > env > null。形状非法 ⇒ 返回 null 且 rejected 标明来源（调用方
 * loud 告警；绝不 exit——调试参数不得砖掉产品；也绝不让任意 env 内容进持久文件）。
 */
export function resolveAppSessionId(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): AppSessionResolution {
  const flagIndex = argv.indexOf(APP_SESSION_ID_FLAG)
  if (flagIndex >= 0) {
    const raw = flagIndex + 1 < argv.length ? argv[flagIndex + 1] ?? null : null
    if (raw !== null && APP_SESSION_ID_PATTERN.test(raw)) return { session: raw, rejected: null }
    return { session: null, rejected: 'flag' }
  }
  const fromEnv = env[APP_SESSION_ID_ENV]
  if (fromEnv === undefined || fromEnv.length === 0) return { session: null, rejected: null }
  if (APP_SESSION_ID_PATTERN.test(fromEnv)) return { session: fromEnv, rejected: null }
  return { session: null, rejected: 'env' }
}

/** 从磁盘行对象抽取宿主元数据；任何形状异常 ⇒ 空对象（load 宽松，绝不丢整行）。 */
export function readRowHostMetadata(row: unknown): RowHostMetadata {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return {}
  const namespace = (row as Record<string, unknown>)[ROW_HOST_METADATA_KEY]
  if (namespace === null || typeof namespace !== 'object' || Array.isArray(namespace)) return {}
  const session = (namespace as Record<string, unknown>).manualDisconnectSessionId
  if (typeof session !== 'string' || session.length === 0) return {}
  return { manualDisconnectSessionId: session }
}

/** 写盘前回填：返回**新对象**（绝不改传入 spec），只在有意图时加一个命名空间键。 */
export function attachRowHostMetadata<T extends TransportInstanceSpec>(
  spec: T,
  metadata: RowHostMetadata,
): T & { dshChamber?: RowHostMetadata } {
  if (metadata.manualDisconnectSessionId === undefined) return spec
  return { ...spec, [ROW_HOST_METADATA_KEY]: { manualDisconnectSessionId: metadata.manualDisconnectSessionId } }
}

/** 唯一的行文件序列化：spec + 意图回填 → 与旧格式逐字节同形的 JSON（无意图时零差异）。 */
export function serializeRoster(
  rows: readonly TransportInstanceSpec[],
  metadata: ReadonlyMap<string, RowHostMetadata>,
): string {
  const serialized = rows.map((spec) => {
    const intent = metadata.get(spec.id)
    return intent === undefined ? spec : attachRowHostMetadata(spec, intent)
  })
  return `${JSON.stringify(serialized, undefined, 2)}\n`
}

/** 唯一意图判定：只有「本会话」的标记才抑制自动连接（他会话/缺失 = 默认可连，I4）。 */
export function isSuppressedByIntent(metadata: RowHostMetadata, session: AppSessionId | null): boolean {
  return session !== null && metadata.manualDisconnectSessionId === session
}

/** 宿主对账/显式动作读面（内存镜像；绝不进 renderer 载荷）。 */
export interface ConnectionIntentSnapshot {
  /** 本进程应用会话身份；null = 意图功能关闭。 */
  readonly session: AppSessionId | null
  /** 本会话被显式断开的 id 集合。 */
  readonly suppressed: ReadonlySet<string>
  /** 行集合修订：任何 save/意图写 +1（内存态，不落盘；排队票据的代际判据）。 */
  readonly revision: number
  /** 名册健康：false 时拒绝一切意图写入（I6）。 */
  readonly rostersWritable: boolean
}

/** 意图写结果：volatile = 内存已生效、盘上未生效（用户事实优先，I5）。 */
export type IntentWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly volatile: boolean }

/** registry 健康位（与 TransportRegistryDeps.state 同形的最小只读子集）。 */
export interface IntentRosterHealth {
  readonly loadFailure: string | null
  readonly incomplete: boolean
}

/** 保存事务开始时的快照：authoritative 回填/清理与补偿恢复共用同一入口快照（C3）。 */
export interface IntentSaveSnapshot {
  readonly revision: number
  readonly intents: ReadonlyMap<string, RowHostMetadata>
  readonly beforeIds: ReadonlySet<string>
}

export interface IntentStoreDeps {
  /** 本进程应用会话身份；null = 功能关闭（载入清空、写入拒绝、抑制为空）。 */
  readonly session: AppSessionId | null
  /** 唯一落盘函数（registry 的 writeFileAtomic 绑定）；抛错由调用方映射 volatile。 */
  readonly write: (text: string) => void
  /** 当前行集（意图写落盘时序列化用；registry.listInstances 的结构面）。 */
  readonly rows: () => readonly TransportInstanceSpec[]
  /** 权威保存的新增行钩子（宿主对账 added 波次；注册表不依赖 timer）。 */
  readonly onInstancesAdded?: (ids: readonly string[]) => void
  readonly warn?: (message: string) => void
}

export interface IntentStore {
  /** 载入前清空内存镜像（重复 load/损坏 load 不继承上一轮的行元数据）。 */
  beginLoad(): void
  /** 单行载入：仅在 `validateSpec` 通过后调用（dropped 行不入表）；坏元数据 = 空对象。 */
  observeRow(row: unknown, id: string): void
  /** 保存事务入口快照（必须在任何写盘/内存变更之前调用）。 */
  beginSave(before: readonly TransportInstanceSpec[]): IntentSaveSnapshot
  /** 保存的**唯一**写盘（与 setManual 共用 serializeRoster+write）：编辑回填 previous 意图。 */
  writeSave(specs: readonly TransportInstanceSpec[], snapshot: IntentSaveSnapshot): void
  /** 保存提交：authoritative 按新行集清理、compensation 恢复入口快照；+1 修订；返回新增 id。 */
  commitSave(
    snapshot: IntentSaveSnapshot,
    provenance: 'authoritative' | 'compensation',
    kept: readonly TransportInstanceSpec[],
  ): readonly string[]
  /** 显式断开的唯一写入口：内存先生效、再落盘；失败 loud 且内存保持意图。 */
  setManual(id: string, suppressed: boolean, health: IntentRosterHealth, rowExists: boolean): IntentWriteResult
  /** 只读投影（supressed 仅含本会话行；revision 即行修订）。 */
  snapshot(health: IntentRosterHealth): ConnectionIntentSnapshot
}

/**
 * 意图表 + 行修订的单实现（registry 内唯一的意图状态所有者）。写顺序纪律：
 * save 先落盘后改内存（失败全不动，由 registry 保证）；intent 先改内存后落盘
 * （用户事实优先，失败 volatile）。
 */
export function createIntentStore(deps: IntentStoreDeps): IntentStore {
  const intents = new Map<string, RowHostMetadata>()
  let revision = 0
  const enabled = (): boolean => deps.session !== null

  function writeRoster(specs: readonly TransportInstanceSpec[], metadata: ReadonlyMap<string, RowHostMetadata>): void {
    deps.write(serializeRoster(specs, metadata))
  }

  return {
    beginLoad(): void {
      intents.clear()
    },
    observeRow(row: unknown, id: string): void {
      if (!enabled()) return
      const metadata = readRowHostMetadata(row)
      if (metadata.manualDisconnectSessionId !== undefined) intents.set(id, metadata)
    },
    beginSave(before: readonly TransportInstanceSpec[]): IntentSaveSnapshot {
      return {
        revision,
        intents: new Map(intents),
        beforeIds: new Set(before.map(instance => instance.id)),
      }
    },
    writeSave(specs: readonly TransportInstanceSpec[], snapshot: IntentSaveSnapshot): void {
      writeRoster(specs, snapshot.intents)
    },
    commitSave(snapshot, provenance, kept): readonly string[] {
      const keptIds = new Set(kept.map(instance => instance.id))
      intents.clear()
      if (provenance === 'compensation') {
        // C3：删除事务的补偿回滚恢复入口快照——只对 before 中存在的 id（绝不把回滚洗成"无意图"）。
        for (const [id, metadata] of snapshot.intents) {
          if (snapshot.beforeIds.has(id)) intents.set(id, metadata)
        }
        revision = snapshot.revision + 1
        return []
      }
      // 编辑保留 previous 意图、新增无、删除随行消失；补偿/权威都 +1 修订。
      for (const id of keptIds) {
        const metadata = snapshot.intents.get(id)
        if (metadata !== undefined) intents.set(id, metadata)
      }
      revision = snapshot.revision + 1
      const added = [...keptIds].filter(id => !snapshot.beforeIds.has(id))
      if (added.length > 0) deps.onInstancesAdded?.(added)
      return added
    },
    setManual(id, suppressed, health, rowExists): IntentWriteResult {
      if (health.loadFailure !== null) {
        return { ok: false, error: 'registry load is degraded; intent not persisted', volatile: false }
      }
      if (health.incomplete) {
        return { ok: false, error: 'roster is incomplete; intent not persisted', volatile: false }
      }
      if (!rowExists) return { ok: false, error: 'unknown instance', volatile: false }
      if (!enabled() || deps.session === null) {
        return { ok: false, error: 'host provides no app session identity; intent persistence disabled', volatile: false }
      }
      const session = deps.session
      if (suppressed) {
        if (intents.get(id)?.manualDisconnectSessionId === session) return { ok: true }
        intents.set(id, { manualDisconnectSessionId: session })
      } else if (!intents.delete(id)) {
        // 无意图可清：显式连接不制造空写（幂等 no-op）。
        return { ok: true }
      }
      revision += 1
      try {
        writeRoster(deps.rows(), intents)
        return { ok: true }
      } catch (error) {
        // 内存保持用户事实（断开不能被写失败回滚），但明确告知盘上未生效。
        deps.warn?.(`connection intent write failed: ${describeError(error)}`)
        return { ok: false, error: describeError(error), volatile: true }
      }
    },
    snapshot(health): ConnectionIntentSnapshot {
      const suppressed = new Set<string>()
      if (deps.session !== null) {
        for (const [id, metadata] of intents) {
          if (isSuppressedByIntent(metadata, deps.session)) suppressed.add(id)
        }
      }
      return {
        session: deps.session,
        suppressed,
        revision,
        rostersWritable: health.loadFailure === null && !health.incomplete,
      }
    },
  }
}

/** 排队/延迟尝试的票据：执行前必须仍「同一行代 + 同一传输代 + 未被意图抑制 + 未退出」。 */
export interface AttemptTicket {
  readonly id: string
  /** InstanceState 对象身份（同 id 删行/重加换对象；null = 调用方无该事实，跳过该查）。 */
  readonly state: object | null
  /** 传输代（每次 start/disconnect +1；null = 无该事实）。 */
  readonly tunnelEpoch: number | null
  /** 行集合修订（authoritative save/删行/意图写 +1；null = 无该事实）。 */
  readonly rowRevision: number | null
}

export type AttemptAuthorization = 'authorized' | 'stale-row' | 'stale-transport' | 'suppressed' | 'quitting'

export interface AttemptAuthorizationDeps {
  readonly isQuitting: () => boolean
  readonly stateOf: (id: string) => object | null
  readonly tunnelEpochOf: (id: string) => number | null
  readonly rowRevision: () => number | null
  /** 当前本会话抑制集（执行时重读，不用排队时的快照）。 */
  readonly suppressed: ReadonlySet<string>
}

/**
 * 队列票据的权威复查（唯一实现；唤醒/启动/新增三条波次共用）。顺序即优先级：
 * quitting → 行身份/行修订 → 传输代 → 意图抑制。
 */
export function attemptStillAuthorized(
  ticket: AttemptTicket,
  deps: AttemptAuthorizationDeps,
): AttemptAuthorization {
  if (deps.isQuitting()) return 'quitting'
  if (ticket.state !== null) {
    const state = deps.stateOf(ticket.id)
    if (state === null || state !== ticket.state) return 'stale-row'
  }
  if (ticket.rowRevision !== null) {
    const revision = deps.rowRevision()
    if (revision !== null && revision !== ticket.rowRevision) return 'stale-row'
  }
  if (ticket.tunnelEpoch !== null) {
    const epoch = deps.tunnelEpochOf(ticket.id)
    if (epoch !== null && epoch !== ticket.tunnelEpoch) return 'stale-transport'
  }
  if (deps.suppressed.has(ticket.id)) return 'suppressed'
  return 'authorized'
}
