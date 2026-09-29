/** Domain IPC registrations：设置 / 通知 / 徽标 / deep-link 就绪。 */
import type { ShellIpcCtx } from './shell-ipc-ctx.ts'
import type { NotificationSettingsLike } from './notifications.ts'
import { DEFAULT_CHAMBER_SETTINGS, validatePatch } from './chamber-settings.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { cpus, release as osRelease, totalmem } from 'node:os'
import { adjudicateBadgeCount, validateBadgeRequest } from './badge.ts'
import { MAX_SHOWN_NOTIFICATION_RECEIPTS, ShownNotificationReceipts, claimNotificationDetailed, decideNotification, releaseNotificationClaim, validateNotificationRequest } from './notifications.ts'

export function registerSettingsHandlers(ctx: ShellIpcCtx): void {
  // Durable receipts (design 19 §6 D2): a host restart keeps the shown set, so a
  // retried renderer edge cannot double-show a banner whose IPC reply was lost.
  const shownReceipts = new ShownNotificationReceipts(MAX_SHOWN_NOTIFICATION_RECEIPTS, ctx.notificationReceiptsSeam)
  const { deps, state, version, applySettingsPatch, chamberSettingsStatus, pushSettingsChanged, applyBadgePresentation, reconcileBadgeCount, notificationSourceIncarnations, pendingNotificationOpens, pendingRendererIntents, nativeNotificationRateLimiter, enqueueNotificationOpen, drainPendingNotificationOpens, drainPendingRendererDeepLinkIntents } = ctx
  const { settingsIO, hostFacts, confirmRegistryOriginSwitch } = ctx.deps.ctx
  async function maybeShowNativeNotification(
    payload: unknown,
  ): Promise<{ shown: boolean; outcome: 'shown' | 'suppressed' | 'retryable' | 'permanent'; error?: string }> {
    const validated = validateNotificationRequest(payload);
    if (!validated.ok) {
      console.warn(`[dsh-chamber] 拒绝非法通知 payload：${validated.error}`);
      return { shown: false, outcome: 'permanent', error: `invalid notification request: ${validated.error}` };
    }
    const request = validated.request;
    // 设置权威在装配侧内存 holder（settings-set 即时更新）；旧文件缺字段用 DEFAULT 兜底（normalizeSettings 已归一，此处仅防御）。
    const settings: NotificationSettingsLike = {
      ...DEFAULT_CHAMBER_SETTINGS.notifications,
      ...(settingsIO.current().notifications ?? {}),
    };
    // isFocused 由实现侧保证异常安全恒 boolean：探测异常与未聚焦两态同值（有意收敛）。
    const anyWindowFocused = deps.edges.isFocused();
    const decision = decideNotification({
      request,
      settings,
      anyWindowFocused,
    });
    if (decision.action === 'skip') {
      return { shown: false, outcome: 'suppressed', error: 'notification suppressed by settings or window focus' };
    }
    if (!notificationSourceIncarnations.matches(request.sourceId, request.sourceFingerprint)) {
      console.warn(`[dsh-chamber] 通知来源 fingerprint 已过期：${request.sourceId}`);
      return { shown: false, outcome: 'permanent', error: 'notification source fingerprint is stale' };
    }
    const sourceToken = request.kind === 'test' ? null : notificationSourceIncarnations.capture(request.sourceId);
    if (request.kind !== 'test' && sourceToken === null) {
      console.warn(`[dsh-chamber] 通知来源已不在当前 registry：${request.sourceId}`);
      return { shown: false, outcome: 'permanent', error: 'notification source is no longer in the registry' };
    }
    // A suppressed decision is terminal before consulting the host: the unsupported-platform
    // log must describe an actual show attempt, not every suppressed renderer edge (probe failure ≡ unsupported).
    if (!deps.edges.notificationSupported()) {
      console.warn('[dsh-chamber] 通知裁决跳过：平台不支持原生通知');
      return { shown: false, outcome: 'permanent', error: 'native notifications are not supported on this platform' };
    }
    // The settings-page test button is a fresh explicit request on every click.
    // It has no completion identity and must never inherit a prior shown receipt.
    if (request.kind !== 'test' && shownReceipts.has(request)) return { shown: true, outcome: 'shown' };
    // 去重 claim（5s TTL）：防同一事件双路径/重放双发；'test' 不走 claim。
    // 顺序在裁决之后：被设置/焦点跳过的请求不消费去重槽（design 19 §3.3）。
    const claim = claimNotificationDetailed(request);
    if (!claim.accepted) {
      if (claim.reason === 'saturated') {
        console.warn('[dsh-chamber] 通知去重窗口已达硬上限，拒绝新通知');
      }
      return { shown: false, outcome: 'retryable', error: 'notification suppressed by the dedupe window' };
    }
    if (!nativeNotificationRateLimiter.tryAcquire()) {
      releaseNotificationClaim(claim.token);
      console.warn('[dsh-chamber] 原生通知发送速率达到硬上限，拒绝新通知');
      return { shown: false, outcome: 'retryable', error: 'native notification rate limit reached' };
    }
    // 宿主腿（构造 + 有界登记/淘汰 + click + honest-show 结算）在实现侧且不 throw；
    // shown 结算后 core 释放 claim 并如实返回 IPC 结果。
    const clickRoute = sourceToken === null
      ? null
      : {
        token: sourceToken,
        // click 回灌（宿主先 activate/restore/focus 成功才回调）：代际复查后入队打开意图（旧来源代际的 click 不落到同 id 替换后的新 shell）。
        onActivated: () => {
          if (!notificationSourceIncarnations.owns(sourceToken)) {
            console.warn(`[dsh-chamber] 忽略旧来源代际的通知点击：${request.sourceId}`);
            return;
          }
          enqueueNotificationOpen(sourceToken, request.sessionId);
        },
      };
    const handle = deps.edges.showNativeNotification(
      { title: request.title, body: request.body },
      clickRoute,
    );
    const outcome = await handle.shown;
    if (!outcome.shown) {
      releaseNotificationClaim(claim.token);
      console.warn(`[dsh-chamber] 原生通知显示失败：${outcome.error}`);
      return { shown: false, outcome: outcome.failureClass ?? 'retryable', error: outcome.error };
    }
    if (request.kind !== 'test') shownReceipts.record(request);
    return { shown: true, outcome: 'shown' };
  }
  // info 载荷 = 4 个页面标量 + flavor（E2）。flavor 是**有意保留的零消费者
  // 字段**：preload 不镜像、页面无消费者（用前须补消费者与 preload.cts /
  // global.d.ts 镜像测试），E2 复核若仍无消费者即删除；4 个标量是 preload/shim/
  // manifest 的暴露面契约（4 标量 + 10 命名空间），不得随内部 seam 删除。
  deps.ipc.handle(IPC_CHANNELS.INFO, () => ({
    controlPlaneUrl: hostFacts.controlPlaneUrl,
    dshVersion: deps.ctx.runtimeFacts?.dshVersion() ?? null,
    version,
    platform: hostFacts.platform,
    flavor: hostFacts.flavor,
    // 官方反馈问卷的机器描述（上游 apps/desktop/src/device-info.ts 同形）。
    // 不是 4 标量暴露面的一部分：carrier 的 deviceInfo() 按需读这一条。
    deviceInfo: readDeviceInfo(),
  }));

  /**
   * Local machine description for the official feedback questionnaire, the
   * upstream `apps/desktop/src/device-info.ts` shape (`platform=…; os=…;
   * app_arch=…; cpu=…; memory_gib=…`) with unavailable fields omitted, so a
   * refused source never fails the whole payload.
   */
  function readDeviceInfo(): string {
    const fields = [`platform=${process.platform}`]
    // `process.getSystemVersion` is Electron-only; the plain-Node sidecar flavor
    // falls back to the kernel release (`os.version()` would carry "; " and break
    // the name=value list the upstream format is parsed as).
    collectDeviceField(fields, 'os', () => (typeof process.getSystemVersion === 'function'
      ? process.getSystemVersion()
      : osRelease()))
    fields.push(`app_arch=${process.arch}`)
    collectDeviceField(fields, 'cpu', () => cpus()[0]?.model)
    collectDeviceField(fields, 'memory_gib', () => (totalmem() / 1024 ** 3).toFixed(1))
    return fields.join('; ')
  }

  function collectDeviceField(fields: string[], name: string, read: () => string | undefined): void {
    let value: string | undefined
    try {
      value = read()
    } catch (_error) {
      return
    }
    // The payload is `name=value` pairs joined by "; ": a separator inside a value
    // would fabricate fields for whoever parses it (upstream omits only empty ones).
    const safe = value?.replace(/[;\r\n]+/g, ' ').trim()
    if (safe !== undefined && safe !== '') fields.push(`${name}=${safe}`)
  }

  // 原生外观跟随页面主题（上游 dsh-desktop:native-theme-set）：来源是页面 bootstrap
  // 观察到的 html[data-ds-theme-source]，不是页面 API ⇒ 白名单只放三个合法值；非法值
  // loud 回错而不猜（绝不把任意串塞进 nativeTheme.themeSource）。宿主叶异常安全。
  deps.ipc.handle(IPC_CHANNELS.NATIVE_THEME_SET, (payload: unknown) => {
    const source = (payload as { source?: unknown } | null)?.source;
    if (source !== 'light' && source !== 'dark' && source !== 'system') {
      return { error: 'native-theme-set:invalid-source' };
    }
    deps.edges.nativeThemeSet(source);
    return { ok: true };
  });

  // Chamber settings 查询：非秘密投影（当前值 + 平台能力门控）。
  deps.ipc.handle(IPC_CHANNELS.SETTINGS_GET, () => chamberSettingsStatus());

  // Chamber settings 应用并持久化 + 变更推送。失败 loud {error}，绝不静默假成功。
  deps.ipc.handle(IPC_CHANNELS.SETTINGS_SET, async (payload: unknown) => {
    const { patch } = payload as { patch?: unknown };
    const validated = validatePatch(patch);
    if (!validated.ok) return { error: validated.error };
    // Switching the runtime version source moves the trust boundary of version checks/
    // downloads/installs — require native user confirmation before applying the patch.
    const currentSettings = settingsIO.current();
    const nextOrigin = validated.patch.registryOrigin;
    if (nextOrigin !== undefined && nextOrigin !== currentSettings.registryOrigin) {
      const verdict = await confirmRegistryOriginSwitch(currentSettings.registryOrigin, nextOrigin);
      if (verdict === 'unavailable') return { error: 'native confirmation unavailable' };
      if (verdict !== 'confirmed') return { error: 'cancelled', code: 'cancelled' };
    }
    // applySettingsPatch 为 async（Electron 同步叶被 await 吸收；Swift 叶 await B 桥应答）；失败 loud {error} 返回。
    const applied = await applySettingsPatch(validated.patch);
    if (!applied.ok) return applied;
    // badgeEnabled 翻转的即时收敛：仅当本次 patch 实际携带该键时重新裁决最近一次 renderer
    // 计数意图（关闭→立即清零；开启→恢复未读数），无关设置变更不重发 setBadgeCount。
    if (validated.patch.notifications?.badgeEnabled !== undefined) {
      reconcileBadgeCount();
    }
    pushSettingsChanged();
    return chamberSettingsStatus();
  });

  // 桌面通知：渲染端检测会话边沿并组装 payload → notify（invoke，返回是否实际显示）→
  // 主进程白名单/去重/裁决 + 原生通知；invoke 实参对象解构在处理器内完成（registrar 只收单参 unknown）。
  deps.ipc.handle(IPC_CHANNELS.NOTIFY, (payload: unknown) =>
    maybeShowNativeNotification((payload as { payload?: unknown }).payload));
  // Renderer 通知就绪信号：onOpen 监听注册后调用，通知点击推送只在就绪后放行
  // （did-finish-load 早于监听注册）；返回 true 与 preload 的 Promise<boolean> 一致。
  deps.ipc.handle(IPC_CHANNELS.NOTIFICATIONS_READY, () => {
    state.notificationOpenDrainReady = true;
    const drainAccepted = drainPendingNotificationOpens();
    // A send race can revoke ready inside the drain; returning false makes the renderer's bounded readiness retry re-establish the handshake.
    return drainAccepted && state.notificationOpenDrainReady;
  });
  deps.ipc.handle(IPC_CHANNELS.NOTIFICATION_OPEN_ACK, (payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return false;
    const { deliveryId, attempt } = payload as { deliveryId?: unknown; attempt?: unknown };
    return pendingNotificationOpens.acknowledge(deliveryId as number, attempt as number);
  });
  // 未读徽标计数：renderer 推真实计数（0 = 清除）→ 白名单校验 → 记录意图 → 设置裁决
  // （badgeEnabled）→ 平台门 + edges.setBadge；返回是否实际应用，渲染端静默容忍 false。
  deps.ipc.handle(IPC_CHANNELS.BADGE_COUNT, async (payload: unknown) => {
    const validated = validateBadgeRequest(payload);
    if (!validated.ok) {
      console.error(`[dsh-chamber] 徽标计数请求校验失败：${validated.error}`);
      return false;
    }
    state.badgeTarget = validated.count;
    const count = adjudicateBadgeCount(
      { badgeEnabled: settingsIO.current().notifications.badgeEnabled },
      validated.count,
    );
    // W4：返回**真实投递结果**（Swift 形态等腿回执），渲染端据此提交/重试而非被乐观值锁死。
    return await applyBadgePresentation(count);
  });
  // Deep-link renderer readiness (hold/replay): App invokes this only after installing
  // deepLink.onIntent; cold-start launches held before that point replay now, navigation/crash resets the bit.
  deps.ipc.handle(IPC_CHANNELS.DEEP_LINK_READY, () => {
    state.deepLinkRendererReady = true;
    const drainAccepted = drainPendingRendererDeepLinkIntents();
    return drainAccepted && state.deepLinkRendererReady;
  });
  deps.ipc.handle(IPC_CHANNELS.DEEP_LINK_ACK, (payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return false;
    const { deliveryId, attempt } = payload as { deliveryId?: unknown; attempt?: unknown };
    return pendingRendererIntents.acknowledge(deliveryId as number, attempt as number);
  });
}
