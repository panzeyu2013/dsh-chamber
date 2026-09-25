/**
 * Desktop IPC channel names — the single source for MAIN-process senders and
 * handlers (main.ts + the ipc-*.ts wiring modules). `SYSTEM_RESUME_EVENT` is
 * also referenced (as the same literal) by preload.cts: the preload build
 * contract is a self-contained single file (build-preload.mjs), so it cannot
 * import this module — the duplication is deliberate and pinned by
 * test/ipc/ipc-surface-mirror.test.ts (which asserts the main-side handle/send literal
 * sets EQUAL the preload-side invoke/on literal sets).
 *
 * The renderer-side twin lives in
 * packages/dsh-client-connection/src/client/index.ts (same literal; the two
 * processes cannot share one module).
 */

/** Every main-process IPC channel: request/response (ipcMain.handle) and
 *  main→renderer pushes (webContents.send). Value-object form so the surface
 *  mirror test can resolve the full channel set from one import. */
export const IPC_CHANNELS = {
  INFO: 'dsh-chamber:info',

  SETTINGS_GET: 'dsh-chamber:settings-get',
  SETTINGS_SET: 'dsh-chamber:settings-set',
  SETTINGS_CHANGED: 'dsh-chamber:settings-changed',

  NOTIFY: 'dsh-chamber:notify',
  NOTIFICATIONS_READY: 'dsh-chamber:notifications-ready',
  NOTIFICATION_OPEN_ACK: 'dsh-chamber:notification-open-ack',
  NOTIFICATION_OPEN: 'dsh-chamber:notification-open',
  /** Unread badge count: renderer push → main adjudication (badgeEnabled) +
   *  platform-gated app.setBadgeCount. */
  BADGE_COUNT: 'dsh-chamber:badge-count',

  UPDATE_STATE: 'dsh-chamber:update-state',
  UPDATE_CHECK: 'dsh-chamber:update-check',
  UPDATE_DOWNLOAD: 'dsh-chamber:update-download',
  /** User-triggered restart into the downloaded update (settings「重启并安装」
   *  button): main updater.restartAndInstall → electron-updater quitAndInstall
   *  (quit + install + relaunch). */
  UPDATE_RESTART: 'dsh-chamber:update-restart',
  UPDATE_STATE_CHANGED: 'dsh-chamber:update-state-changed',
  OPEN_RELEASE: 'dsh-chamber:open-release',
  /** 权限被拒后的恢复入口：打开 macOS「系统设置 → 通知」面板。renderer 不带
   *  URL——目标地址固定在 main 侧，不把 OPEN_RELEASE 的白名单语义扩成任意 URL
   *  打开面。 */
  OPEN_NOTIFICATION_SETTINGS: 'dsh-chamber:open-notification-settings',

  OPEN_IN_APPS: 'dsh-chamber:open-in-apps',
  OPEN_IN: 'dsh-chamber:open-in',
  DEEP_LINK_READY: 'dsh-chamber:deep-link-ready',
  DEEP_LINK_ACK: 'dsh-chamber:deep-link-ack',
  DEEP_LINK_INTENT: 'dsh-chamber:deep-link-intent',

  SYSTEM_RESUME: 'dsh-chamber:system-resume',

  /** Renderer-stall evidence (frame-probe strikes / input-block RTT): main →
   *  renderer. The page cannot observe its own stopped frame loop or blocked JS
   *  thread; the shell's bounded reload stays the acting path. */
  RENDERER_STALL_EVIDENCE: 'dsh-chamber:renderer-stall-evidence',

  SSH_INSTANCES_GET: 'desktop_ssh_instances_get',
  /** Registry load health (degraded gate): the renderer must NOT treat an
   *  instances_get empty array as an authoritative roster while the persisted
   *  registry failed to load. */
  SSH_INSTANCES_HEALTH: 'desktop_ssh_instances_health',
  SSH_SAVE_CONNECTION: 'desktop_ssh_save_connection',
  SSH_DELETE_CONNECTION: 'desktop_ssh_delete_connection',
  SSH_SET_PASSWORD: 'desktop_ssh_set_password',
  GATEWAY_SET_TOKEN: 'desktop_gateway_set_token',
  GATEWAY_SET_PASSWORD: 'desktop_gateway_set_password',
  /** Manual chamber-plugin seed-cache sync onto a gateway instance. */
  GATEWAY_PLUGIN_SYNC: 'desktop_gateway_plugin_sync',
  SSH_CONFIG_LIST: 'desktop_ssh_config_list',
  SSH_CONNECT: 'desktop_ssh_connect',
  SSH_DISCONNECT: 'desktop_ssh_disconnect',
  SSH_STATUS: 'desktop_ssh_status',
  /** On-demand ready-state re-verification (user activation of a source or
   *  session): main runs one identity probe for a READY transport. */
  SSH_REVERIFY: 'desktop_ssh_reverify',
  SSH_LOGS: 'desktop_ssh_logs',
  SSH_LOGS_CLEAR: 'desktop_ssh_logs_clear',
  SSH_START_SERVICE: 'desktop_ssh_start_service',
  SSH_STOP_SERVICE: 'desktop_ssh_stop_service',
  SSH_IS_ACTIVE: 'desktop_ssh_is_active',
  SSH_RESTART_SERVICE: 'desktop_ssh_restart_service',

  SSH_PLUGIN_LIST: 'desktop_ssh_plugin_list',
  LOCAL_PLUGIN_LIST: 'desktop_local_plugin_list',
  SSH_SEED_HOST_GRAPH: 'desktop_ssh_seed_host_graph',

  SSH_STATUS_CHANGED: 'desktop_ssh_status_changed',
  SSH_INSTANCES_CHANGED: 'desktop_ssh_instances_changed',

  RUNTIME_STATE: 'dsh-chamber:runtime-state',
  RUNTIME_CHECK: 'dsh-chamber:runtime-check',
  RUNTIME_INSTALL: 'dsh-chamber:runtime-install',
  RUNTIME_CLEANUP_VERSION: 'dsh-chamber:runtime-cleanup-version',
  RUNTIME_CLEAR_FAILURE: 'dsh-chamber:runtime-clear-failure',
  RUNTIME_RECOVER_METADATA: 'dsh-chamber:runtime-recover-metadata',
  RUNTIME_RESET_BUILTIN: 'dsh-chamber:runtime-reset-builtin',
  RUNTIME_RESTART: 'dsh-chamber:runtime-restart',
  RUNTIME_APPLY_NOW: 'dsh-chamber:runtime-apply-now',
  RUNTIME_RETRY_APPLY: 'dsh-chamber:runtime-retry-apply',
  RUNTIME_RETRY_RESTORE: 'dsh-chamber:runtime-retry-restore',
  RUNTIME_RESTORE_PRE_ROLLBACK: 'dsh-chamber:runtime-restore-pre-rollback',
  RUNTIME_STATE_CHANGED: 'dsh-chamber:runtime-state-changed',
} as const

/** OS wake-from-sleep push channel; named export for its main.ts importer. */
export const SYSTEM_RESUME_EVENT = IPC_CHANNELS.SYSTEM_RESUME
