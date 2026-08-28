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
  NOTIFICATION_OPEN: 'dsh-chamber:notification-open',

  UPDATE_STATE: 'dsh-chamber:update-state',
  UPDATE_CHECK: 'dsh-chamber:update-check',
  UPDATE_DOWNLOAD: 'dsh-chamber:update-download',
  UPDATE_STATE_CHANGED: 'dsh-chamber:update-state-changed',
  OPEN_RELEASE: 'dsh-chamber:open-release',

  OPEN_IN_APPS: 'dsh-chamber:open-in-apps',
  OPEN_IN: 'dsh-chamber:open-in',
  DEEP_LINK_INTENT: 'dsh-chamber:deep-link-intent',

  SYSTEM_RESUME: 'dsh-chamber:system-resume',

  SSH_INSTANCES_GET: 'desktop_ssh_instances_get',
  SSH_INSTANCES_SET: 'desktop_ssh_instances_set',
  SSH_SET_PASSWORD: 'desktop_ssh_set_password',
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
} as const

/** OS wake-from-sleep push channel (design 14 D4). Kept as a named export for
 *  the historical importers (main.ts / tests). */
export const SYSTEM_RESUME_EVENT = IPC_CHANNELS.SYSTEM_RESUME
