// BridgeManifest.swift — GENERATED, do not edit.
//
// 通道 manifest（W-17 / design 25 §4.4.3）：Swift 侧 IPC 白名单单源
// （68 通道 = 60 invoke + 8 push）。
// 重新生成（工作目录 packages/desktop）：node scripts/emit-bridge-manifest.mjs
// 生成器 scripts/emit-bridge-manifest.mjs —— 输入 ipc-events.ts 的
// IPC_CHANNELS 常量表 + main 侧（main.ts ∪ shell-core.ts ∪ electron-edges.ts）
// handle/send 注册事实；与提交物 packages/desktop/bridge-manifest.json 同源。

/// IPC 通道 manifest —— 生成物，勿手改；增删通道请先改 IPC_CHANNELS 并重新生成。
enum BridgeManifest {
    /// invoke 通道：renderer invoke → main 的 handle 注册面（ipcMain|deps.ipc），共 60 条。
    static let invokeChannels: Set<String> = [
        "dsh-chamber:info",
        "dsh-chamber:settings-get",
        "dsh-chamber:settings-set",
        "dsh-chamber:notify",
        "dsh-chamber:notifications-ready",
        "dsh-chamber:notification-open-ack",
        "dsh-chamber:badge-count",
        "dsh-chamber:update-state",
        "dsh-chamber:update-check",
        "dsh-chamber:update-download",
        "dsh-chamber:update-restart",
        "dsh-chamber:open-release",
        "dsh-chamber:open-in-apps",
        "dsh-chamber:open-in",
        "dsh-chamber:deep-link-ready",
        "dsh-chamber:deep-link-ack",
        "desktop_ssh_instances_get",
        "desktop_ssh_instances_set",
        "desktop_ssh_save_connection",
        "desktop_ssh_delete_connection",
        "desktop_ssh_set_password",
        "desktop_gateway_set_token",
        "desktop_gateway_set_password",
        "desktop_gateway_plugin_sync",
        "desktop_gateway_plugin_apply",
        "desktop_gateway_plugin_materialize",
        "desktop_ssh_config_list",
        "desktop_ssh_connect",
        "desktop_ssh_disconnect",
        "desktop_ssh_status",
        "desktop_ssh_reverify",
        "desktop_ssh_logs",
        "desktop_ssh_logs_clear",
        "desktop_ssh_start_service",
        "desktop_ssh_stop_service",
        "desktop_ssh_is_active",
        "desktop_ssh_restart_service",
        "desktop_ssh_plugin_list",
        "desktop_ssh_plugin_apply",
        "desktop_ssh_plugin_undo",
        "desktop_local_plugin_list",
        "desktop_npm_search",
        "desktop_ssh_seed_host_graph",
        "desktop_ssh_plugin_materialize_add",
        "desktop_ssh_plugin_materialize_add_pick",
        "desktop_local_plugin_add_file",
        "desktop_local_plugin_add",
        "desktop_local_plugin_remove",
        "dsh-chamber:runtime-state",
        "dsh-chamber:runtime-check",
        "dsh-chamber:runtime-install",
        "dsh-chamber:runtime-cleanup-version",
        "dsh-chamber:runtime-clear-failure",
        "dsh-chamber:runtime-recover-metadata",
        "dsh-chamber:runtime-reset-builtin",
        "dsh-chamber:runtime-restart",
        "dsh-chamber:runtime-apply-now",
        "dsh-chamber:runtime-retry-apply",
        "dsh-chamber:runtime-retry-restore",
        "dsh-chamber:runtime-restore-pre-rollback",
    ]

    /// push 通道：main → renderer（webContents.send|rendererPush 推送面），共 8 条。
    static let pushChannels: Set<String> = [
        "dsh-chamber:settings-changed",
        "dsh-chamber:notification-open",
        "dsh-chamber:update-state-changed",
        "dsh-chamber:deep-link-intent",
        "dsh-chamber:system-resume",
        "desktop_ssh_status_changed",
        "desktop_ssh_instances_changed",
        "dsh-chamber:runtime-state-changed",
    ]

    /// 全量通道（invoke ∪ push 推导，不重复字面量 —— 与上两集合永不漂移）。
    static let allChannels: Set<String> = invokeChannels.union(pushChannels)
}
