/**
 * sidecar-ctx.ts —— Swift flavor sidecar 无头 ctx 装配（S-C-1 第一片；design 25
 * §3.1/§4.1；原 sidecar-entry.ts 的 buildHeadlessCtx 拆分落位）
 *
 * S-C-1（本片）把 C/D/E 组注册体（registry+凭据 / ssh 连接状态 / exec+systemd，
 * shell-core installIpcHandlers ② C/D/E 组段）的 ctx 依赖从 loud stub 换成与
 * main.ts 装配**同源同参**的真实实现。每段注记 main.ts 装配行号来源（当前
 * swift 分支 HEAD f8efa7d 的 main.ts 行区）：
 *  1. providers 真实（模块级单例 sshProvider/gatewayProvider——shell-core C 组
 *     normalizeConnectionInput 直 import 同一实例；configureSshPasswordStore /
 *     configureGatewaySecretStore / configureGatewaySessionProvider 各凭据存储
 *     注入 <userData> 等价位路径 + 现实例解析器——main 1344-1426 行区）。
 *     spawnFn 无需注入：ssh-provider/gateway-provider 的 spawn/askpass 均为纯
 *     Node 叶（askpass 0700 sh 助手 mkdtemp 于 os.tmpdir、child_process spawn），
 *     transport-manager 缺省 spawnFn = node:child_process spawn（main 装配同样
 *     未传 spawnFn，main 1437-1451）——无 Electron askpass 专用叶需要适配。
 *  2. transportManager 真实：createTransportManager 全参（provider/providers/
 *     instancesFile=userData/ssh-instances.json（instancesFilePath 模板）/
 *     logger→stderr [transport-manager] 前缀）——main 1437-1451。
 *  3. loadInstances 启动（corrupt→loud + 保留 .corrupt，语义同 main 1452-1466）；
 *  4. audit 真实：configureAuditLog + appendAuditEvent({file})（main 1433-1436；
 *     JSONL append + 5 MiB 轮换 + 白名单序列化——S24）；
 *  5. publishRegistryTransition 真实叶（main 2094-2159 纯逻辑部分：投影计算 /
 *     来源代际同步 / setGatewaySyncRegistration 注销 / sshPluginJournal 撤销 /
 *     SSH_INSTANCES_CHANGED committed push——push 经注入 edges.rendererPush +
 *     attemptCommittedRegistryPush（core delivery，transport-manager 导出）；
 *     main 侧宿主对象的纯模块工厂部分按 S6 字段注入真实实例（createSshPluginJournal
 *     (userData) / ExactOwnershipRegistry / ReadyPhaseEdges——main 1297/1618/1619）；
 *  6. confirmRegistryOriginSwitch 真实：edges.showMessage 宿主腿——main
 *     3752-3766 闭包文案/按钮序（['取消','切换版本源']，defaultId/cancelId 0）/
 *     应答映射逐字一致；无存活主窗 = edges.mainWindowAlive() 预检 + 竞态
 *     showMessage 抛错折算 → 'unavailable'。
 *
 * S-C-2 范围（仍为 loud methodStub，见 buildHeadlessCtx 尾部注释清单）：
 * runtime 控制器族（J/K 组）、updateController（M3/W-22）、F/G 组共享闭包束
 * （sshPluginTargets/chamberHostPackageSeeds/syncGatewayChamberPluginsFor）、
 * H 组 runLocalPluginMutation 与自动 seed ready 边缘（S6 装配后 publish 叶的
 * reseed 行随批补回）等。sshPluginJournal / hostPackageSeeding / gatewaySessions
 * 本片已按 publish 叶依赖注入真实实例（S6 字段部分注资——F 组落地时同实例）。
 *
 * Electron-free 不变式：本文件零 electron import（electron-free-gate 面 A 对
 * packages/desktop 顶层源码自动覆盖）；secret 存储路径一律 <userData> 等价位。
 * sidecar 无 Electron safeStorage：gateway 凭据镜像按 design 17 §12/S22 走诚实
 * loud 的 0600 plaintext 回退（main 无 keychain 分支同语义），绝不静默。
 */
import { mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import type { ChamberSettings } from './chamber-settings.ts'
import { DEFAULT_CHAMBER_SETTINGS, readSettingsFile, writeSettingsFile } from './chamber-settings.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import {
  auditLogFilePath,
  chamberSettingsFilePath,
  gatewaySecretsFilePath,
  instancesFilePath,
  projectInstanceSecrets,
  projectNotificationSourceInstances,
  sshPasswordsFilePath,
  syncNotificationSourceRegistry,
  type HostMessageOptions,
  type ProjectedRegistryInstance,
  type ShellAssemblyCtx,
} from './shell-core.ts'
import {
  attemptCommittedRegistryPush,
  computeRemovedInstanceIds,
  computeRetiredInstanceIds,
  createTransportManager,
  type TransportManager,
} from './transport-manager.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'
import {
  cleanupStaleAskpassHelpers,
  configureSshPasswordStore,
  sshProvider,
} from './ssh-provider.ts'
import {
  configureGatewaySecretStore,
  configureGatewaySessionProvider,
  gatewayProvider,
} from './gateway-provider.ts'
import { createGatewaySessionManager } from './gateway-session.ts'
import { appendAuditEvent, configureAuditLog, type AuditEvent } from './audit-log.ts'
import { createSshPluginJournal } from './ssh-plugin-journal.ts'
import { ExactOwnershipRegistry, ReadyPhaseEdges } from './plugin-sync.ts'
import { setGatewaySyncRegistration } from './gateway-sync-registry.ts'

/** publish/confirm 等真实叶所需的宿主边沿子集（node-edges 实现——sidecar-entry
 *  把同一 edges 实例传给 buildHeadlessCtx 与 installIpcHandlers：单装配不变式，
 *  push/确认对话框宿主腿与 core 投递状态机同对象、同事实缓存）。 */
export interface HeadlessCtxEdges {
  rendererPush(channel: string, payload: unknown): boolean
  mainWindowAlive(): boolean
  retireNotificationsForSources(retiredSourceIds: ReadonlySet<string>): number
  showMessage(opts: HostMessageOptions): Promise<number>
}

/** buildHeadlessCtx 的装配结果：ctx（installIpcHandlers 消费）+ 优雅回收腿
 *  （sidecar SIGTERM/SIGINT 路径调用——transportManager.disposeAsync() +
 *  gatewaySessions.dispose()，与 main.ts will-quit 清理同源（main 1050/1062）；
 *  cp.stop 由 sidecar-entry 自行编排）。 */
export interface HeadlessCtxAssembly {
  ctx: ShellAssemblyCtx
  dispose(): Promise<void>
}

/**
 * 装配 Swift flavor 无头 ctx。签名相对 W-13 原型（buildHeadlessCtx(userDataDir)）
 * 增加 edges 参数：S-C-1 真实叶需要宿主边沿（publish push / 通知退役驱逐 /
 *  mainWindowAlive 预检 / 确认对话框 showMessage 腿）；sidecar-ctx 不 import
 *  node-edges——edges 实例由 sidecar-entry 构造后注入，本文件保持纯装配面。
 */
export function buildHeadlessCtx(userDataDir: string, edges: HeadlessCtxEdges): HeadlessCtxAssembly {
  const stateDir = path.join(userDataDir, 'state')
  mkdirSync(stateDir, { recursive: true })
  const settingsPath = chamberSettingsFilePath(userDataDir)
  const auditLogPath = auditLogFilePath(userDataDir)

  // —— 装配序与 main.ts whenReady 同向（行号 = 当前 swift 分支 main.ts）——
  // ssh plugin undo journal 现实例（main 1297-1300：createSshPluginJournal
  // (<userData>, {log,warn})——文件 <userData>/ssh-plugin-journal.json；本片
  // publish 叶的删除/操作目标变更撤销清理与后续 F 组 undo/apply 共用同一实例）。
  const sshPluginJournal = createSshPluginJournal(userDataDir, {
    log: (...args) => console.log('[sidecar-journal]', ...args),
    warn: (...args) => console.warn('[sidecar-journal]', ...args),
  })

  // chamber settings（design 14 D7）：启动加载（损坏 loud——readSettingsFile
  // 自身保留 *.corrupt，绝不静默假默认）。
  let settings: ChamberSettings = (() => {
    try {
      const loaded = readSettingsFile(settingsPath)
      return loaded.settings
    } catch {
      return DEFAULT_CHAMBER_SETTINGS
    }
  })()
  // main 1306-1313 的 keep-awake / 登录自启副作用 reconcile 为 Electron 宿主
  // 腿（setKeepAwakeActive/applyLaunchAtLogin）——Swift flavor 对应宿主面留
  // M3（W-22 清单），settings 只加载不应用，与既有 sidecar 行为一致。

  // askpass 崩溃残留回收（main 1344-1345：cleanupStaleAskpassHelpers——启动期
  // 清理 crash 遗留的密码载体助手；纯 Node 叶，同模块同参）。
  const askpassNotice = cleanupStaleAskpassHelpers()
  if (askpassNotice !== null) console.error(`[sidecar] ${askpassNotice}`)

  // registry 现实例先占位：凭据存储配置期只持有惰性解析器（main 1346-1347 的
  // resolveCredentialSpec 闭包形态——transportManager 赋值后按引用共享）。
  let transportManager: TransportManager | null = null
  const resolveCredentialSpec = (id: string): TransportInstanceSpec | null =>
    transportManager?.listInstances().find(instance => instance.id === id) ?? null

  // SSH password store（design 05 §8 plaintext fallback, 0600/原子写/损坏 loud
  // 保留）：<userData>/ssh-passwords.json（sshPasswordsFilePath 模板——main
  // 1348-1352 同参）。凭据值绝不进 registry/日志/渲染器；写入纪律（write-only、
  // 绝不回读）在 ssh-provider 纯模块与 shell-core C 组注册体内，随迁保留。
  const passwordNotice = configureSshPasswordStore(sshPasswordsFilePath(userDataDir), resolveCredentialSpec)
  if (passwordNotice !== null) console.error(`[sidecar] ssh password store: ${passwordNotice}`)

  // Gateway credentials store（design 17 §12 schema v3, 0600, 原子写）：main
  // 1362-1394 经 Electron safeStorage 适配器（crypto adapter）加密镜像；sidecar
  // 为 Electron-free flavor——无 safeStorage，等同 main 无 keychain 分支的诚实
  // loud 语义：非 win32 = S22 0600 plaintext 回退（用户决策 2026-08，绝不静默——
  // loud 注册 + renderer 可见 secretStorage:'plaintext' 投影，projectInstanceSecrets
  // 经 gatewaySecretStorageMode 读真实存储模式）；win32（不可达于 Swift flavor，
  // 防御分支同 main 1374-1379）= memory-only（file null）拒绝明文。
  const windowsRefusePlaintext = process.platform === 'win32'
  if (windowsRefusePlaintext) {
    console.error('[sidecar] Windows safeStorage (DPAPI) 不可用 — 拒绝明文镜像回退 (design 21 C16)；gateway 凭据仅本次会话内存驻留，每次连接需重录')
  } else {
    console.warn('[sidecar] OS keychain (Electron safeStorage) 在 Swift flavor 不可用（Electron-free sidecar）— gateway credentials will be mirrored to the 0600 plaintext file fallback (design 17 §12/S22)')
  }
  const gatewaySecretNotice = configureGatewaySecretStore(
    windowsRefusePlaintext ? null : gatewaySecretsFilePath(userDataDir),
    undefined, // 无 Electron safeStorage 适配器 —— S22 plaintext 回退（上方 loud）
    resolveCredentialSpec,
  )
  if (gatewaySecretNotice !== null) console.error(`[sidecar] gateway secrets store: ${gatewaySecretNotice}`)

  // Gateway password-session manager（design 17 §7.1/§9.3——纯主进程内存；C 组
  // 注册体的 invalidation 直接面）：createGatewaySessionManager 纯 Node headless
  // 构造可行（gateway-session.ts 零 electron），与 main 1418 同源构造 + main
  // 1419-1426 的 configureGatewaySessionProvider 六钩子全量接线（密码会话流
  // ensure/cached/proof/invalidate 同源——ssh 隧道与 http 直连双形态共用）。
  const gatewaySessions = createGatewaySessionManager()
  configureGatewaySessionProvider({
    ensureSession: (origin, password) => gatewaySessions.ensureSession(origin, password),
    generation: origin => gatewaySessions.generation(origin),
    registrationAuthProof: origin => gatewaySessions.registrationAuthProof(origin),
    setRegistrationAuthProof: (origin, proof) => gatewaySessions.setRegistrationAuthProof(origin, proof),
    cachedCookie: origin => gatewaySessions.cachedCookie(origin),
    invalidate: origin => gatewaySessions.invalidate(origin),
  })

  // S24 非秘密审计叶（design 17 §13.4.4, JSONL append + 5 MiB 轮换, 0600——
  // audit-log.ts 模块；main 1433-1436 同参：configureAuditLog(<userData>/
  // audit-log.jsonl) + appendAuditEvent({file})。序列化白名单/凭据值绝不入日志
  // 纪律在 serializeAuditEvent（control-plane 审计单源）——本叶只做文件绑定）。
  const auditLogNotice = configureAuditLog(auditLogPath)
  if (auditLogNotice !== null) console.error(`[sidecar] audit log: ${auditLogNotice}`)
  const audit = (event: AuditEvent): void => appendAuditEvent({ file: auditLogPath }, event)

  // Transport manager（design 03 §2.2/05 §7-§8）：与 main 1437-1451 同源同参。
  // provider 缺省 = sshProvider（legacy kind-keyed 条目解析）；providers 按
  // TRANSPORT 注册 {ssh, http}（design 17 §2.2）；instancesFile =
  // <userData>/ssh-instances.json；logger → stderr（sidecar-entry 已把 console
  // 重定向到 stderr），[transport-manager] 前缀同 main。
  const created = createTransportManager({
    provider: sshProvider,
    providers: { ssh: sshProvider, http: gatewayProvider },
    instancesFile: instancesFilePath(userDataDir),
    logger: {
      log: (...args) => console.log('[transport-manager]', ...args),
      warn: (...args) => console.warn('[transport-manager]', ...args),
      error: (...args) => console.error('[transport-manager]', ...args),
    },
  })
  transportManager = created
  const sm = created
  try {
    sm.loadInstances()
  } catch (loadError) {
    // Corrupt instance file: loud failure — PRESERVE the file (rename to
    // *.corrupt, reversible) before starting empty; the next authoritative
    // save_connection rebuilds the registry (never silently faked as empty).
    // 语义与 main 1452-1466 逐字同向。
    console.error('[sidecar] 加载 SSH 实例失败：', loadError)
    const file = instancesFilePath(userDataDir)
    try {
      renameSync(file, `${file}.corrupt`)
      console.warn(`[sidecar] 已保留损坏的实例文件为 ${file}.corrupt`)
    } catch (renameError) {
      console.error('[sidecar] 保留损坏实例文件失败：', renameError)
    }
  }
  // 初始来源代际同步（main 1491——installIpcHandlers 之前建立首代证明，
  // 装配序与 main 相同：先 sync 后 handler 注册）。
  syncNotificationSourceRegistry(projectNotificationSourceInstances(sm.listInstances()))

  // —— publishRegistryTransition 真实叶（main 2094-2159 纯逻辑部分的同源装配）——
  // registry 变更生命周期权威 sidecar（source-lifecycle）：投影计算/来源代际
  // 同步/journal 撤销/committed push。main 侧宿主对象中凡纯模块工厂者按 S6 字段
  // 注入真实实例：sshPluginJournal（上方 createSshPluginJournal——S-C-1 已注资
  // ctx.sshPluginJournal，F 组落地时共用同一 journal 写者）、hostPackageSeeding
  // （ExactOwnershipRegistry——main 1618）、readySeedEdges（ReadyPhaseEdges——
  // main 1619；本 flavor 暂无自动 seed ready 边缘，注册表恒空，forget 语义同
  // main 的空态 no-op，S-C-2 装配 ready 边缘后同实例继续有效）。
  const hostPackageSeeding = new ExactOwnershipRegistry()
  const readySeedEdges = new ReadyPhaseEdges()
  const transportIdentityFingerprint = (instance: TransportInstanceSpec): string => JSON.stringify([
    instance.kind,
    instance.transport,
    instance.host,
    instance.user,
    instance.sshPort,
    instance.remotePort,
  ])
  const operationalFingerprint = (instance: TransportInstanceSpec): string => JSON.stringify([
    transportIdentityFingerprint(instance),
    instance.serviceName,
    instance.remoteDshHome,
  ])
  /**
   * Finish every committed registry transition through the source-lifecycle
   * authority. Metadata/secret persistence is owned by the transaction
   * (connection-save.ts → sm.saveInstances); this sidecar rotates
   * renderer/native-notification proofs, revokes exact plugin-seed owners,
   * and publishes the committed roster.
   */
  const publishRegistryTransition = (
    before: readonly TransportInstanceSpec[],
    after: readonly TransportInstanceSpec[],
  ): ProjectedRegistryInstance[] => {
    const projected = projectNotificationSourceInstances(after)
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return projected.map(projectInstanceSecrets)
    }
    const projectedSaved = projected.map(projectInstanceSecrets)

    const removedIds = computeRemovedInstanceIds(before, after)
    // Manual gateway-sync re-entry dies with the instance (design 21 §6.5):
    // a removed row must never keep a registration a later
    // gateway_plugin_sync(id) call could sync against. setGatewaySyncRegistration
    // = gateway-sync-registry.ts 纯模块级注册表（shell-core G 组同源直 import）。
    for (const id of removedIds) {
      setGatewaySyncRegistration(id, null)
      sshPluginJournal.clear(id)
    }
    const retiredIds = computeRetiredInstanceIds(before, after)
    const afterById = new Map(after.map(instance => [instance.id, instance]))
    for (const previous of before) {
      const current = afterById.get(previous.id)
      if (current === undefined || operationalFingerprint(previous) !== operationalFingerprint(current)) {
        // S-C-1 范围注记：main 2140-2142 的 reseed 调度行
        // （`if (sm.status(id)?.phase === 'ready') startAutomaticHostSeed(id)`）
        // 依赖 F 组自动 seed 闭包族（chamberHostPackageSeeds/目标束）——留
        // S-C-2 装配后随批补回；本片无任何 seed 可撤销/可重播（F 组仍 loud
        // stub、无 ready 边缘），撤销清理（forget/revoke/journal.clear）照跑，
        // 语义与 main 空态一致。
        readySeedEdges.forget(previous.id)
        hostPackageSeeding.revoke(previous.id)
        // The plugin undo journal is bound to the OPERATIONAL target: an
        // id-stable edit that changed host/user/service/home invalidates
        // every op recorded on the previous target (design 21 §6.4 review
        // P1) — drop them here AND at undo time (latestOkForTarget).
        sshPluginJournal.clear(previous.id)
      }
    }

    // 代际同步 + 队列退役丢弃 = syncNotificationSourceRegistry（core 导出）；
    // 活跃原生通知驱逐 = edges.retireNotificationsForSources（node-edges →
    // Swift notify 'retireNotifications'）。
    const retiredNotificationSources = new Set(syncNotificationSourceRegistry(projected))
    if (retiredNotificationSources.size > 0) {
      edges.retireNotificationsForSources(retiredNotificationSources)
    }

    // Committed lifecycle push（{removedIds, retiredIds} 文本与 main 2144-2157
    // 逐字一致；renderer-trust 锚定）。Electron main 以 registryWindow !== null
    // 为门 + push 前窗口身份复查；Swift flavor 无 window 对象——同值判据 =
    // edges.mainWindowAlive()（node-edges 事实缓存，hostFacts 推送刷新），
    // push 前竞态复查同一叶。叶 false = 无存活主窗，折算失败 loud（与 main
    // 的「throw → {sent:false}」语义等价）；无窗口常驻期间由下次查询兜底。
    if (edges.mainWindowAlive()) {
      const pushed = attemptCommittedRegistryPush(() => {
        if (!edges.mainWindowAlive()) {
          throw new Error('registry renderer changed before push')
        }
        if (!edges.rendererPush(IPC_CHANNELS.SSH_INSTANCES_CHANGED, { removedIds, retiredIds })) {
          throw new Error('registry renderer push failed')
        }
      })
      if (!pushed.sent) {
        console.warn(`[sidecar] registry 已保存但 lifecycle push 失败（等待 renderer 重拉）：${pushed.error}`)
      }
    }
    return projectedSaved
  }

  // —— ctx 完成形态：真实字段 + Proxy 兜底（未实现字段 = loud 抛
  // 'sidecar-ctx-unavailable:<field>'——绝不静默）。——
  const hostFacts = {
    flavor: 'swift' as const,
    controlPlaneUrl: '',
    platform: process.platform,
    trayPresent: () => true,
  }
  const real: Record<string, unknown> = {
    hostFacts,
    runtimeBaseDir: userDataDir,
    localDshHome: path.join(stateDir, 'dsh-home'),
    settingsIO: {
      current: () => settings,
      commit: (next: ChamberSettings) => {
        settings = next
      },
      persist: (next: ChamberSettings) => {
        writeSettingsFile(settingsPath, next)
      },
    },
    isQuitting: () => false,
    runtimeFacts: {
      dshVersion: () => {
        // Swift flavor：dsh 版本事实由 Swift 壳/运行时管理层提供（M3 真实
        // 化）；v1 返回 null = INFO 载荷 dshVersion:null（与可选语义一致）。
        return null
      },
    },
    // S-C-1 真实化字段（C/D/E 组注册体装配依赖）：
    audit,
    transportManager: sm,
    gatewaySessions,
    publishRegistryTransition,
    confirmRegistryOriginSwitch: async (currentOrigin: string, nextOrigin: string) => {
      // registryOrigin 切换确认（SETTINGS_SET——design 18 trust boundary 变更需
      // 原生用户确认）。文案/按钮/默认序与 main.ts 3752-3766 闭包逐字一致；
      // 宿主腿 = edges.showMessage（node-edges → Swift NSAlert，按钮序号应答）。
      // 无存活主窗预检 = edges.mainWindowAlive()（与 main 的 win===null||destroyed
      // 同值）；预检与调用间窗口销毁的竞态 = showMessage 叶抛错 → loud + 折算
      // 'unavailable'（与 electron-edges S6 的 'native confirmation unavailable'
      // 语义同形——绝不误报 cancelled）。
      if (!edges.mainWindowAlive()) return 'unavailable' as const
      let response = 0
      try {
        response = await edges.showMessage({
          type: 'warning',
          title: '切换 dsh 运行时版本源？',
          message: '切换 dsh 运行时版本源？',
          detail: `版本检查、下载与安装的信任边界将从\n${currentOrigin}\n切换到\n${nextOrigin}`,
          buttons: ['取消', '切换版本源'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
      } catch (err) {
        console.error(`[sidecar] registryOrigin 切换确认失败（按不可用处理）：${String(err)}`)
        return 'unavailable' as const
      }
      return response === 1 ? ('confirmed' as const) : ('cancelled' as const)
    },
    // S-C-1 部分注资（S6 字段——publish 叶撤销清理依赖；F 组落地共用实例）：
    sshPluginJournal,
    hostPackageSeeding,
  }
  /** 递归 stub：可调用（调用即抛）+ 任意成员访问返回同款 stub（供
   *  installIpcHandlers 顶部解构对象字段/方法后、在 handler 运行时才调用
   *  的形态）；个别装配期必须可调用的成员在 real 中显式提供（见
   *  updateController.subscribe）。 */
  const methodStub = (prefix: string): ((..._args: never[]) => never) =>
    new Proxy(
      function stub(): never {
        throw new Error('sidecar-ctx-unavailable:' + prefix)
      },
      {
        get(target, key) {
          const own = Reflect.get(target, key)
          if (own !== undefined) return own
          if (key === 'apply' || key === 'bind' || key === 'call') {
            return Function.prototype[key as 'apply' | 'bind' | 'call']
          }
          if (typeof key === 'string') return methodStub(prefix + '.' + key)
          return undefined
        },
      },
    ) as ((..._args: never[]) => never)
  // S-C-2 范围（仍 loud stub，逐个注记归属批）：
  // - updateController：Swift flavor 更新状态经 hostFacts/update 事件面
  //   （M3/W-22 接真实推送）——subscribe 装配期空实现（installIpcHandlers I 组
  //   段先订阅后 start 契约）。
  real.updateController = Object.assign(methodStub('updateController'), {
    subscribe: () => {
      /* Swift flavor 更新状态经 hostFacts/update 事件面，M3/W-22 接真实推送 */
    },
  })
  // - runtime 控制器族（runtimeController / runtimeOperationBusy /
  //   runtimeWriterFence / runtimeActionAllowed / runtimeBaseDir 已真实 /
  //   refreshRuntimeEvidence / runStorePruneIfNeeded / restartLocalDsh /
  //   runRuntimeStartup / publishBlockedStartup / setRuntimeGate /
  //   authoritativeMetadataRecoveryStatus / runUserMetadataRecovery /
  //   readApplyNowGateInput / selectedJournalIntent / stopLocalDsh /
  //   runtimeOperationSlot / bundledRuntimeVersion）：J/K 组注册体宿主依赖，
  //   Swift flavor 运行时管理线（M3，S-C-2）。
  // - chamberHostPackageSeeds / sshPluginTargets 闭包族 /
  //   syncGatewayChamberPluginsFor（F/G 组共享实例与目标束——S-C-2 装配，
  //   含 publish 叶 reseed 行补回）/ runLocalPluginMutation（H 组宿主叶——
  //   S-C-2）。sshPluginJournal / hostPackageSeeding 本片已真实（见上）。
  const ctx = new Proxy(real as object, {
    get(target: Record<string, unknown>, key: string | symbol) {
      if (typeof key === 'symbol') return undefined
      if (key in target) return target[key]
      return methodStub(String(key))
    },
  }) as unknown as ShellAssemblyCtx

  // 优雅回收腿：传输层（SSH 隧道/在途 exec）+ gateway 会话内存（design 17
  // §13.5 会话仅主进程内存）。main will-quit 同源（main 1050/1062——disposeAsync
  // 等待每个 SIGKILL 升级，正常 ~1-2s 完成；SIGTERM 忽略的 ssh 子进程不孤儿化）。
  const dispose = async (): Promise<void> => {
    try {
      await transportManager?.disposeAsync()
    } catch (err) {
      console.error('[sidecar] 传输层关闭失败：' + String(err))
    } finally {
      gatewaySessions.dispose()
    }
  }
  return { ctx, dispose }
}
