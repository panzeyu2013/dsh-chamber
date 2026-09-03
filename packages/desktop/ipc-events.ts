/**
 * Desktop IPC channel names — the single source for MAIN-process senders and
 * handlers (main.ts + the ipc-*.ts wiring modules). `SYSTEM_RESUME_EVENT` is
 * also referenced (as the same literal) by preload.cts: the preload build
 * contract is a self-contained single file (build-preload.mjs), so it cannot
 * import this module — the duplication is deliberate and pinned by
 * ipc-surface-mirror.test.ts (which asserts the main-side handle/send literal
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

  UPDATE_STATE: 'dsh-chamber:update-state',
  UPDATE_CHECK: 'dsh-chamber:update-check',
  UPDATE_DOWNLOAD: 'dsh-chamber:update-download',
  UPDATE_STATE_CHANGED: 'dsh-chamber:update-state-changed',
  OPEN_RELEASE: 'dsh-chamber:open-release',

  OPEN_IN_APPS: 'dsh-chamber:open-in-apps',
  OPEN_IN: 'dsh-chamber:open-in',
  DEEP_LINK_READY: 'dsh-chamber:deep-link-ready',
  DEEP_LINK_ACK: 'dsh-chamber:deep-link-ack',
  DEEP_LINK_INTENT: 'dsh-chamber:deep-link-intent',

  SYSTEM_RESUME: 'dsh-chamber:system-resume',

  SSH_INSTANCES_GET: 'desktop_ssh_instances_get',
  SSH_INSTANCES_SET: 'desktop_ssh_instances_set',
  SSH_SAVE_CONNECTION: 'desktop_ssh_save_connection',
  SSH_DELETE_CONNECTION: 'desktop_ssh_delete_connection',
  SSH_SET_PASSWORD: 'desktop_ssh_set_password',
  GATEWAY_SET_TOKEN: 'desktop_gateway_set_token',
  GATEWAY_SET_PASSWORD: 'desktop_gateway_set_password',
  /** Manual chamber-plugin seed-cache sync onto a gateway instance (design 21 §6.5). */
  GATEWAY_PLUGIN_SYNC: 'desktop_gateway_plugin_sync',
  /** Batch registry install/remove + restart-to-apply onto a gateway
   *  instance (design 21 §6.5, plan Phase 4.6): main-process confirmation
   *  (showMessageBox), serial per-op submissions over the registered
   *  transport, bounded executor-settle + restart readiness polls. */
  GATEWAY_PLUGIN_APPLY: 'desktop_gateway_plugin_apply',
  /** Folder pick → tarball upload onto a gateway instance (design 21 §6.5,
   *  plan Phase 4.6): PICK-ONLY (main opens the folder dialog, no
   *  renderer-supplied path). */
  GATEWAY_PLUGIN_MATERIALIZE: 'desktop_gateway_plugin_materialize',
  SSH_CONFIG_LIST: 'desktop_ssh_config_list',
  SSH_CONNECT: 'desktop_ssh_connect',
  SSH_DISCONNECT: 'desktop_ssh_disconnect',
  SSH_STATUS: 'desktop_ssh_status',
  SSH_LOGS: 'desktop_ssh_logs',
  SSH_LOGS_CLEAR: 'desktop_ssh_logs_clear',
  SSH_START_SERVICE: 'desktop_ssh_start_service',
  SSH_STOP_SERVICE: 'desktop_ssh_stop_service',
  SSH_IS_ACTIVE: 'desktop_ssh_is_active',
  SSH_RESTART_SERVICE: 'desktop_ssh_restart_service',

  SSH_PLUGIN_LIST: 'desktop_ssh_plugin_list',
  SSH_PLUGIN_APPLY: 'desktop_ssh_plugin_apply',
  /** Undo the latest ok ssh plugin change (design 21 §6.4 undo journal:
   *  main-process confirm → inverse row through the same ssh apply flow). */
  SSH_PLUGIN_UNDO: 'desktop_ssh_plugin_undo',
  LOCAL_PLUGIN_LIST: 'desktop_local_plugin_list',
  NPM_SEARCH: 'desktop_npm_search',
  SSH_SEED_HOST_GRAPH: 'desktop_ssh_seed_host_graph',
  SSH_PLUGIN_MATERIALIZE_ADD: 'desktop_ssh_plugin_materialize_add',
  SSH_PLUGIN_MATERIALIZE_ADD_PICK: 'desktop_ssh_plugin_materialize_add_pick',
  LOCAL_PLUGIN_ADD_FILE: 'desktop_local_plugin_add_file',
  LOCAL_PLUGIN_ADD: 'desktop_local_plugin_add',
  LOCAL_PLUGIN_REMOVE: 'desktop_local_plugin_remove',

  SSH_STATUS_CHANGED: 'desktop_ssh_status_changed',
  SSH_INSTANCES_CHANGED: 'desktop_ssh_instances_changed',

  RUNTIME_STATE: 'dsh-chamber:runtime-state',
  RUNTIME_CHECK: 'dsh-chamber:runtime-check',
  RUNTIME_INSTALL: 'dsh-chamber:runtime-install',
  RUNTIME_CLEANUP_VERSION: 'dsh-chamber:runtime-cleanup-version',
  RUNTIME_RECOVER_METADATA: 'dsh-chamber:runtime-recover-metadata',
  RUNTIME_RESET_BUILTIN: 'dsh-chamber:runtime-reset-builtin',
  RUNTIME_RESTART: 'dsh-chamber:runtime-restart',
  RUNTIME_APPLY_NOW: 'dsh-chamber:runtime-apply-now',
  RUNTIME_RETRY_APPLY: 'dsh-chamber:runtime-retry-apply',
  RUNTIME_RETRY_RESTORE: 'dsh-chamber:runtime-retry-restore',
  RUNTIME_RESTORE_PRE_ROLLBACK: 'dsh-chamber:runtime-restore-pre-rollback',
  RUNTIME_STATE_CHANGED: 'dsh-chamber:runtime-state-changed',
} as const

/** OS wake-from-sleep push channel (design 14 D4). Kept as a named export for
 *  the historical importers (main.ts / tests). */
export const SYSTEM_RESUME_EVENT = IPC_CHANNELS.SYSTEM_RESUME
