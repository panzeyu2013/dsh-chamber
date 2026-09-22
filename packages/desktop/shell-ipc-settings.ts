/**
 * shell-ipc-settings — domain IPC registrations split out of shell-core.ts
 */
import type { ShellIpcCtx } from './shell-core.ts'
import type { NotificationSettingsLike } from './notifications.ts'
import { DEFAULT_CHAMBER_SETTINGS, validatePatch } from './chamber-settings.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { adjudicateBadgeCount, validateBadgeRequest } from './badge.ts'
import { claimNotificationDetailed, decideNotification, releaseNotificationClaim, validateNotificationRequest } from './notifications.ts'

export function registerSettingsHandlers(ctx: ShellIpcCtx): void {
  const { deps, state, version, applySettingsPatch, chamberSettingsStatus, pushSettingsChanged, applyBadgePresentation, reconcileBadgeCount, notificationSourceIncarnations, pendingNotificationOpens, pendingRendererIntents, nativeNotificationRateLimiter, enqueueNotificationOpen, drainPendingNotificationOpens, drainPendingRendererDeepLinkIntents } = ctx
  const { settingsIO, hostFacts, confirmRegistryOriginSwitch } = ctx.deps.ctx
  async function maybeShowNativeNotification(
    payload: unknown,
  ): Promise<{ shown: boolean; error?: string }> {
    const validated = validateNotificationRequest(payload);
    if (!validated.ok) {
      console.warn(`[dsh-chamber] 拒绝非法通知 payload：${validated.error}`);
      return { shown: false, error: `invalid notification request: ${validated.error}` };
    }
    const request = validated.request;
    // 设置权威在装配侧内存 holder（settingsIO.current——settings-set 即时更新）；
    // 旧文件缺字段时用 DEFAULT 兜底（normalizeSettings 已归一，此处仅防御）。
    const settings: NotificationSettingsLike = {
      ...DEFAULT_CHAMBER_SETTINGS.notifications,
      ...(settingsIO.current().notifications ?? {}),
    };
    // 搬迁差异注记：搬迁前的 host-probe boolean 适配区分「探测异常（拒发）」与
    // 「未聚焦」；接缝下 isFocused 由实现侧保证异常安全恒 boolean（单窗守卫内
    // isVisible/isFocused 探测不可达异常），两态同值——有意收敛，注释于
    // electron-edges isFocused。
    const anyWindowFocused = deps.edges.isFocused();
    const decision = decideNotification({
      request,
      settings,
      anyWindowFocused,
    });
    if (decision.action === 'skip') {
      return { shown: false, error: 'notification suppressed by settings or window focus' };
    }
    if (!notificationSourceIncarnations.matches(request.sourceId, request.sourceFingerprint)) {
      console.warn(`[dsh-chamber] 通知来源 fingerprint 已过期：${request.sourceId}`);
      return { shown: false, error: 'notification source fingerprint is stale' };
    }
    const sourceToken = request.kind === 'test' ? null : notificationSourceIncarnations.capture(request.sourceId);
    if (request.kind !== 'test' && sourceToken === null) {
      console.warn(`[dsh-chamber] 通知来源已不在当前 registry：${request.sourceId}`);
      return { shown: false, error: 'notification source is no longer in the registry' };
    }
    // A disabled/kind/focus decision is terminal before consulting the host.
    // Unsupported-platform logging should describe an actual show attempt, not
    // every deliberately suppressed renderer edge（notificationSupported 探测失败
    // 与不支持同值——实现侧异常安全；与搬迁前区分「探测失败」消息的有意收敛）。
    if (!deps.edges.notificationSupported()) {
      console.warn('[dsh-chamber] 通知裁决跳过：平台不支持原生通知');
      return { shown: false, error: 'native notifications are not supported on this platform' };
    }
    // 去重 claim（5s TTL）：防同一事件双路径/重放双发；'test' 不走 claim。
    // 顺序在裁决之后：被设置/焦点跳过的请求不消费去重槽（design 19 §3.3）。
    const claim = claimNotificationDetailed(request);
    if (!claim.accepted) {
      if (claim.reason === 'saturated') {
        console.warn('[dsh-chamber] 通知去重窗口已达硬上限，拒绝新通知');
      }
      return { shown: false, error: 'notification suppressed by the dedupe window' };
    }
    if (!nativeNotificationRateLimiter.tryAcquire()) {
      releaseNotificationClaim(claim.token);
      console.warn('[dsh-chamber] 原生通知发送速率达到硬上限，拒绝新通知');
      return { shown: false, error: 'native notification rate limit reached' };
    }
    // 宿主腿（构造 + 有界登记/淘汰 + click 腿 + honest-show 结算全在实现侧，
    // B4——见 HostEdges.showNativeNotification 注释）：实现侧不 throw，shown 结
    // 算后 core 释放 claim 并如实返回 IPC 结果。
    const clickRoute = sourceToken === null
      ? null
      : {
        token: sourceToken,
        // click 回灌（宿主先 activate/restore/focus 成功才回调本闭包）：代际复
        // 查（旧来源代际的 click 不回灌同 id 替换后的新 shell）后入队打开意图。
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
      return { shown: false, error: outcome.error };
    }
    return { shown: true };
  }
  deps.ipc.handle(IPC_CHANNELS.INFO, () => ({
    controlPlaneUrl: hostFacts.controlPlaneUrl,
    dshVersion: deps.ctx.runtimeFacts?.dshVersion() ?? null,
    version,
    platform: hostFacts.platform,
    flavor: hostFacts.flavor,
  }));

  // Chamber settings 查询：非秘密投影（当前值 + 平台能力门控）。
  deps.ipc.handle(IPC_CHANNELS.SETTINGS_GET, () => chamberSettingsStatus());

  // Chamber settings 应用并持久化 + 变更推送。失败 loud {error}，绝不静默假成功。
  deps.ipc.handle(IPC_CHANNELS.SETTINGS_SET, async (payload: unknown) => {
    const { patch } = payload as { patch?: unknown };
    const validated = validatePatch(patch);
    if (!validated.ok) return { error: validated.error };
    // Switching the dsh runtime version source moves the trust boundary of
    // version checks/downloads/installs — require native user confirmation
    // (design 18) before applying the patch.
    const currentSettings = settingsIO.current();
    const nextOrigin = validated.patch.registryOrigin;
    if (nextOrigin !== undefined && nextOrigin !== currentSettings.registryOrigin) {
      const verdict = await confirmRegistryOriginSwitch(currentSettings.registryOrigin, nextOrigin);
      if (verdict === 'unavailable') return { error: 'native confirmation unavailable' };
      if (verdict !== 'confirmed') return { error: 'cancelled', code: 'cancelled' };
    }
    // applySettingsPatch 现为 async（S-E：叶 Promise 兼容——Electron 同步叶被
    // await 吸收零变；Swift 叶 await B 桥应答）。失败 loud {error} 返回。
    const applied = await applySettingsPatch(validated.patch);
    if (!applied.ok) return applied;
    // badgeEnabled 翻转的即时收敛：仅在本次 patch 实际携带该键时重新裁决
    // 最近一次 renderer 计数意图（关闭 → 立即清零；开启 → 恢复当前未读数），
    // 绝不等到下一次推送；无关设置变更不重发 setBadgeCount。
    if (validated.patch.notifications?.badgeEnabled !== undefined) {
      reconcileBadgeCount();
    }
    pushSettingsChanged();
    return chamberSettingsStatus();
  });

  // —— B 组（S2 批；W-10 S2 施工图第 1 项）——
  // 桌面通知（design 19 §3.3）：渲染端检测会话边沿并组装 payload → notify
  // （invoke，返回是否实际显示）→ 主进程白名单/去重/裁决 + 原生通知。
  // 载荷形状 = 原 main.ts 的 trustedIpc(({ payload }) => …)——invoke 实参对象
  // 解构在处理器内完成（registrar 处理器只收单参 unknown）。
  deps.ipc.handle(IPC_CHANNELS.NOTIFY, (payload: unknown) =>
    maybeShowNativeNotification((payload as { payload?: unknown }).payload));
  // Renderer 通知就绪信号（design 19 §3.3）：onOpen 监听注册后调用——通知点击
  // 的推送只在就绪后放行（did-finish-load 早于监听注册，见 drain 条件）。
  // 返回 true 与 preload 的 Promise<boolean> 声明一致（成功置位信号）。
  deps.ipc.handle(IPC_CHANNELS.NOTIFICATIONS_READY, () => {
    state.notificationOpenDrainReady = true;
    const drainAccepted = drainPendingNotificationOpens();
    // A send race revokes ready inside the drain. Returning false makes the
    // renderer's bounded readiness retry establish the next handshake.
    return drainAccepted && state.notificationOpenDrainReady;
  });
  deps.ipc.handle(IPC_CHANNELS.NOTIFICATION_OPEN_ACK, (payload: unknown) => {
    if (payload === null || typeof payload !== 'object') return false;
    const { deliveryId, attempt } = payload as { deliveryId?: unknown; attempt?: unknown };
    return pendingNotificationOpens.acknowledge(deliveryId as number, attempt as number);
  });
  // 未读徽标计数（design 19 §3.7）：renderer 推真实计数（0 = 清除）→ 白名单
  // 校验 → 记录意图 → 设置裁决（badgeEnabled）→ 平台门 + edges.setBadge。
  // 返回是否实际应用；渲染端静默容忍 false（主进程已 loud 记平台/失败原因）。
  deps.ipc.handle(IPC_CHANNELS.BADGE_COUNT, (payload: unknown) => {
    const validated = validateBadgeRequest(payload);
    if (!validated.ok) {
      console.error(`[dsh-chamber] 徽标计数请求校验失败：${validated.error}`);
      return false;
    }
    state.pendingBadgeCount = validated.count;
    const count = adjudicateBadgeCount(
      { badgeEnabled: settingsIO.current().notifications.badgeEnabled },
      validated.count,
    );
    return applyBadgePresentation(count);
  });
  // Deep-link renderer readiness (design 16 hold/replay): App invokes this
  // only after installing deepLink.onIntent. Successful cold-start launches
  // held before that point are replayed now; navigation/crash resets the bit.
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
