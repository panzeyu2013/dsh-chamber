// chamber-bridge.stub.js — GENERATED, do not edit.
//
// E8 shim 存根（W-18 后半 A / design 25 §4.4.3）：manifest 通道常量单源桥
// （68 通道 = 60 invoke + 8 push）。
// 与手写 bridge-shim.poc.js（POC 运行时面）并存——全量 shim 生成以此为准。
// 重新生成（工作目录 packages/desktop）：node scripts/emit-bridge-manifest.mjs
// 用法：在 WebKit 页面上下文执行本文件后，window.__DSH_CHAMBER_MANIFEST__
// 与 __dshChamberAssertMethod/__dshChamberAssertEvent 可用。
'use strict';
(function (global) {
  var manifest = {
    invoke: [
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
    ],
    push: [
        "dsh-chamber:settings-changed",
        "dsh-chamber:notification-open",
        "dsh-chamber:update-state-changed",
        "dsh-chamber:deep-link-intent",
        "dsh-chamber:system-resume",
        "desktop_ssh_status_changed",
        "desktop_ssh_instances_changed",
        "dsh-chamber:runtime-state-changed",
    ],
    counts: { invoke: 60, push: 8, total: 68 }
  };
  var invokeSet = {};
  manifest.invoke.forEach(function (ch) { invokeSet[ch] = true; });
  var pushSet = {};
  manifest.push.forEach(function (ch) { pushSet[ch] = true; });
  Object.defineProperty(global, "__DSH_CHAMBER_MANIFEST__", {
    value: manifest,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  function assertMethod(method) {
    if (typeof method !== "string" || !invokeSet[method]) {
      throw new Error("chamber-bridge: unknown invoke method: " + method);
    }
  }
  function assertEvent(event) {
    if (typeof event !== "string" || !pushSet[event]) {
      throw new Error("chamber-bridge: unknown push event: " + event);
    }
  }
  global.__dshChamberAssertMethod = assertMethod;
  global.__dshChamberAssertEvent = assertEvent;
})(typeof window !== "undefined" ? window : globalThis);
