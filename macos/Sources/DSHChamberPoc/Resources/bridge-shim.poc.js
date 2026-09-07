/**
 * bridge-shim.poc.js — W-04 A-bridge shim for the macOS Swift shell POC
 * (todo companion §0.2⑤ W-04; design 25 §4.4.1). Swift's BridgeShimInjector
 * injects this file as a WKUserScript (.page world, documentStart) from
 * macos/Sources/DSHChamberPoc/Resources/.
 *
 * It mirrors the window.dshChamber surface of packages/desktop/preload.cts
 * (design 05 §7.4): 4 info scalars (controlPlaneUrl/dshVersion/version/
 * platform) + 9 namespaces (desktopSsh/update/settings/systemResume/openIn/
 * deepLink/runtime/notifications/badge). S-B（全表面实现）：每个方法的通道、
 * payload 形状与返回映射逐字对齐 preload.cts（59 个 invoke-backed 方法 →
 * 60 manifest invoke 通道（含 info）+ 8 个 on* 订阅 → 8 manifest push
 * 通道），文件内零 poc-unimplemented 兜底。语义校验（payload schema、来源
 * 指纹、ACK 队列……）在 sidecar 原处理器（design 25 §4.4.1）；本文件是
 * 传输 + preload 逐字面。
 *
 * 方法→通道/载荷映射（与 preload.cts 逐字；payload 键即 preload 现形状）：
 *   desktopSsh（32 invoke + 2 订阅）
 *     instances_get()            → desktop_ssh_instances_get（无载荷）
 *     instances_set(instances)   → desktop_ssh_instances_set（instances 数组原文）
 *     delete_connection(id)      → desktop_ssh_delete_connection {id}
 *     save_connection(prevId,input,creds) → desktop_ssh_save_connection
 *                                 {previousId,input,credentials}
 *     set_password(id,password)  → desktop_ssh_set_password {id,password}
 *     set_gateway_token(id,token)→ desktop_gateway_set_token {id,token}
 *     set_gateway_password(id,pw) → desktop_gateway_set_password {id,password}
 *     gateway_plugin_sync(id)    → desktop_gateway_plugin_sync {id}
 *     gateway_plugin_apply(id,input) → desktop_gateway_plugin_apply
 *                                 {id,add,remove,deferRestart}
 *     gateway_plugin_materialize(id) → desktop_gateway_plugin_materialize {id}
 *     config_list()              → desktop_ssh_config_list（无载荷）
 *     connect/disconnect/status/reverify/logs/logs_clear/start_service/
 *       stop_service/is_active/restart_service/plugin_list/ssh_plugin_undo/
 *       seed_host_graph/plugin_materialize_add_pick(id)
 *                               → 各自 desktop_ssh_* 通道 {id}
 *     plugin_apply(id,input)     → desktop_ssh_plugin_apply {id,add,remove,restart}
 *     local_plugin_list()        → desktop_local_plugin_list（无载荷）
 *     npm_search(query)          → desktop_npm_search {query}
 *     plugin_materialize_add(id,name) → desktop_ssh_plugin_materialize_add {id,name}
 *     local_plugin_add(spec)     → desktop_local_plugin_add {spec}
 *     local_plugin_add_file()    → desktop_local_plugin_add_file（无载荷）
 *     local_plugin_remove(name)  → desktop_local_plugin_remove {name}
 *     onStatusChanged / onInstancesChanged → 订阅 desktop_ssh_status_changed /
 *                                 desktop_ssh_instances_changed
 *   update（5 invoke + 1 订阅）→ dsh-chamber:update-{state,check,download,
 *     restart} + dsh-chamber:open-release {url}；onChanged → update-state-changed
 *   settings（2 invoke + 1 订阅）→ dsh-chamber:settings-get / settings-set
 *     {patch}；onChanged → settings-changed
 *   systemResume（1 订阅）→ onResume → system-resume
 *   openIn（2 invoke）→ open-in-apps（返回解包 {apps}）/
 *     open-in {appId,instanceId,path,sourceFingerprint}
 *   deepLink（2 invoke + 1 订阅）→ deep-link-ready / deep-link-ack
 *     {deliveryId,attempt}；onIntent → deep-link-intent
 *   runtime（12 invoke + 1 订阅）→ dsh-chamber:runtime-*（install {version} /
 *     cleanupVersion {version} / clearFailure {version} /
 *     restorePreRollback {stashName}，其余无载荷）；onChanged →
 *     runtime-state-changed
 *   notifications（3 invoke + 1 订阅）→ dsh-chamber:notify {payload} /
 *     notifications-ready / notification-open-ack {deliveryId,attempt}；
 *     onOpen → notification-open
 *   badge（1 invoke）→ badge-count {count}
 *
 * 宿主侧差异注记（shim 层照常 invoke，错误如实上抛；行为对齐待 S-D/验收批）：
 *   - update.restartAndInstall：Electron flavor = updater quitAndInstall（退出
 *     + 安装 + 重启宿主）；Swift flavor 无 updater 宿主（sidecar ctx
 *     updateController 为 loud stub）→ invoke 错误如实上抛（W-22 flavor 接
 *     v1 blocked-available）。
 *   - pick 类（gateway_plugin_materialize / plugin_materialize_add_pick /
 *     local_plugin_add_file）：picker 的弹出/取消语义在宿主侧（Electron dialog /
 *     Swift 侧 node-edges pickPluginSource → NSOpenPanel E8 腿已实现）——
 *     shim 直接 invoke，pick 决策不属本文件。
 *   - desktop_ssh_* 载荷用官方 {id} schema（sidecar-entry/shell-core 同款）。
 *     W-05 切片桩 poc-sidecar.ts 仍读 {instanceId}——该桩的调和归属 P1
 *     sidecar-entry 侧（poc-sidecar 头注释声明），shim 不为其改形。
 *
 * POC 期注意：Swift 默认回退侧车是 poc-sidecar.ts（只注册 W-05 8 通道，
 * 其余回 {error:'poc-unimplemented'}）——该回退属 sidecar 桩而非本 shim；
 * 60/60 语义侧车是 sidecar-entry.ts（POC_SIDECAR env 指向，dev 循环已用）。
 *
 * A-bridge envelope (web → Swift, through the WKScriptMessageHandler named
 * "dshChamber"): postMessage({id, method, payload}) — payload is JSON or
 * null. Swift answers by evaluating the page-world globals defined here:
 *   __dshChamberResolve(id, <jsonOrNull>, null)   → resolves the promise
 *   __dshChamberResolve(id, null, "<errorString>") → rejects with Error
 *   __dshChamberEmit("<eventName>", <payloadJsonOrNull>) → dispatches to the
 *     subscription table (payload null is passed to listeners as undefined).
 * When no native handler exists (the page opened outside WKWebView, e.g.
 * directly in Safari) every invoke rejects {error:'no-native-bridge'} and a
 * single console.warn explains why (warn-once, never spam).
 *
 * Info hydration: the scalars start null and are filled by a
 * dsh-chamber:info invoke that retries 10×50 ms on rejection only — the
 * exact preload.cts semantics (INFO_MAX_ATTEMPTS=10 / INFO_RETRY_MS=50,
 * preload.cts:839-857). Total failure keeps the scalars null: defining the
 * shim never depends on info, and pushes only arrive after the matching
 * invoke, so there is no subscribe-before-info ordering hazard in the POC.
 *
 * Trust note: page-world injection means page code can observe these globals
 * and forge resolve/emit frames. The Swift-side fences (main frame / origin /
 * manifest whitelist, design 25 §4.4.1, MessageHandler.swift) are the real
 * enforcement boundary — POC code registers them alongside this shim.
 */

(function () {
  'use strict'

  // Duplicate-injection guard: BridgeShimInjector may run more than once per
  // page (reload edge / re-inject). The first definition wins; later copies
  // are inert.
  if ('dshChamber' in window) return

  // ---- constants (write-once literals, mirroring ipc-events.ts) ----------

  var INFO_CHANNEL = 'dsh-chamber:info'
  var INFO_RETRY_MS = 50
  var INFO_MAX_ATTEMPTS = 10

  /** The 8 push events the bridge can subscribe to — one constant per event
   *  name so every method ↔ event mapping stays literal and reviewable. */
  var PUSH_EVENTS = {
    SSH_STATUS_CHANGED: 'desktop_ssh_status_changed',
    SSH_INSTANCES_CHANGED: 'desktop_ssh_instances_changed',
    SETTINGS_CHANGED: 'dsh-chamber:settings-changed',
    NOTIFICATION_OPEN: 'dsh-chamber:notification-open',
    DEEP_LINK_INTENT: 'dsh-chamber:deep-link-intent',
    RUNTIME_STATE_CHANGED: 'dsh-chamber:runtime-state-changed',
    SYSTEM_RESUME: 'dsh-chamber:system-resume',
    UPDATE_STATE_CHANGED: 'dsh-chamber:update-state-changed'
  }

  /** The four info scalars, mirroring the preload bridge's top-level fields. */
  var INFO_SCALAR_KEYS = ['controlPlaneUrl', 'dshVersion', 'version', 'platform']

  // ---- push-payload validation mirrors ------------------------------------
  // preload.cts keeps its runtime self-contained (no cross-module imports);
  // this shim keeps the same discipline. The patterns/texts are verbatim
  // copies of preload.cts:16-27 so on* listeners shape deliveries exactly like
  // the preload side (malformed → loud console.error, never a crash).

  var INSTANCE_ID_PATTERN = /^(?!local$)[a-zA-Z0-9_-]{1,64}$/
  var REMOTE_SOURCE_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/

  function validSourceFingerprint(sourceId, value) {
    return sourceId === 'local'
      ? value === 'local'
      : REMOTE_SOURCE_FINGERPRINT_PATTERN.test(typeof value === 'string' ? value : '')
  }

  function validDeliveryCoordinate(value) {
    return Number.isSafeInteger(value) && value >= 1
  }

  // ---- invoke: id-correlated promises over the native message handler ----

  var nextRequestId = 1
  var pending = new Map() // id -> { resolve, reject }
  var warnedNoBridge = false

  /** Resolve the native bridge only while invoking (covers an inject-before-
   *  register ordering in either direction) and call through the handler
   *  object so the native receiver stays bound. */
  function nativePostMessage() {
    try {
      var webkit = window.webkit
      if (!webkit || !webkit.messageHandlers) return null
      var handler = webkit.messageHandlers.dshChamber
      if (!handler || typeof handler.postMessage !== 'function') return null
      return function postToNative(message) {
        handler.postMessage(message)
      }
    } catch (err) {
      return null
    }
  }

  function warnNoBridgeOnce() {
    if (warnedNoBridge) return
    warnedNoBridge = true
    console.warn('[dsh-chamber] no native bridge: window.webkit.messageHandlers.dshChamber is absent (page opened outside the WKWebView shell?) — every dshChamber invoke rejects {error:\'no-native-bridge\'}')
  }

  /** Send {id, method, payload} (payload defaults to null) and correlate the
   *  promise with the id. __dshChamberResolve settles it later. */
  function invoke(method, payload) {
    return new Promise(function (resolve, reject) {
      var post = nativePostMessage()
      if (post === null) {
        warnNoBridgeOnce()
        reject(new Error('no-native-bridge'))
        return
      }
      var id = nextRequestId
      nextRequestId += 1
      pending.set(id, { resolve: resolve, reject: reject })
      var envelope = { id: id, method: method, payload: payload === undefined ? null : payload }
      try {
        post(envelope)
      } catch (err) {
        // Native post threw (bridge torn down mid-flight): fail loud instead
        // of leaving the promise dangling in the pending table.
        pending.delete(id)
        reject(new Error('native-bridge-post-failed'))
      }
    })
  }

  /** Called by Swift as window.__dshChamberResolve(id, result, err). */
  function resolveInvocation(id, result, err) {
    var entry = pending.get(id)
    // Unknown id = leftover from an earlier page generation (Swift replay /
    // reload race). The pending table is per-document; ignoring is safe.
    if (!entry) return
    pending.delete(id)
    if (err) {
      entry.reject(new Error(String(err)))
    } else {
      entry.resolve(result)
    }
  }

  // ---- push subscriptions ------------------------------------------------

  var listeners = new Map() // eventName -> Array<Function>

  /** Called by Swift as window.__dshChamberEmit(event, payload). Payload is
   *  JSON or null; listeners receive undefined for null (matching how the
   *  preload-side push handlers see an absent payload). */
  function emitToListeners(event, payload) {
    var callbacks = listeners.get(event)
    if (callbacks === undefined || callbacks.length === 0) return
    var value = payload === null ? undefined : payload
    // Snapshot: a listener may unsubscribe itself during the dispatch.
    var snapshot = callbacks.slice()
    for (var i = 0; i < snapshot.length; i += 1) {
      try {
        snapshot[i](value)
      } catch (err) {
        // One throwing listener must not drop the rest of the dispatch or
        // surface into Swift's evaluateJavaScript.
        console.error('[dsh-chamber] listener for "' + event + '" threw:', err)
      }
    }
  }

  function noopUnsubscribe() {}

  /** Shared subscription kernel: every on* method subscribes here and
   *  returns an unsubscribe function (preload parity). A listener that is
   *  not a function is refused with a no-op unsubscribe (preload: return
   *  () => {}). */
  function subscribe(event, callback) {
    if (typeof callback !== 'function') return noopUnsubscribe
    var callbacks = listeners.get(event)
    if (callbacks === undefined) {
      callbacks = []
      listeners.set(event, callbacks)
    }
    callbacks.push(callback)
    return function unsubscribe() {
      var index = callbacks.indexOf(callback)
      if (index !== -1) callbacks.splice(index, 1)
    }
  }

  /** preload.cts onStatusChanged/onChanged/onResume parity: pass the payload
   *  through untouched. */
  function makePassthroughListener(callback) {
    return function listener(payload) {
      callback(payload)
    }
  }

  /** preload.cts onInstancesChanged parity (lines 617-640): malformed payload
   *  → loud console.error + empty-delta callback (never a crash); the ids are
   *  validated against INSTANCE_ID_PATTERN and deduplicated before the
   *  callback. The wrapped listener is what subscribe() stores, so the
   *  returned unsubscribe removes exactly this wrapper. */
  function makeInstancesChangedListener(callback) {
    return function listener(payload) {
      if (payload === null || typeof payload !== 'object') {
        console.error('[dsh-chamber] ignored malformed instances-changed payload')
        callback({ removedIds: [], retiredIds: [] })
        return
      }
      var removedIds = payload.removedIds
      var retiredIds = payload.retiredIds
      function validIds(ids) {
        return Array.isArray(ids) && ids.every(function (id) {
          return typeof id === 'string' && INSTANCE_ID_PATTERN.test(id)
        })
      }
      if (!validIds(removedIds) || !validIds(retiredIds)) {
        console.error('[dsh-chamber] ignored malformed instances-changed lifecycle delta')
        callback({ removedIds: [], retiredIds: [] })
        return
      }
      callback({
        removedIds: Array.from(new Set(removedIds)),
        retiredIds: Array.from(new Set(retiredIds))
      })
    }
  }

  /** preload.cts deepLink onIntent parity (lines 741-764): malformed / out of
   *  contract deliveries are dropped loudly (callback never fires) — never a
   *  listener crash, never a bogus intent handed to the renderer. */
  function makeDeepLinkIntentListener(callback) {
    return function listener(payload) {
      if (payload === null || typeof payload !== 'object') {
        console.error('[dsh-chamber] ignored malformed deep-link delivery')
        return
      }
      var intent = payload
      if (
        typeof intent.instanceId !== 'string'
        || (intent.instanceId !== 'local' && !INSTANCE_ID_PATTERN.test(intent.instanceId))
        || typeof intent.path !== 'string'
        || !validSourceFingerprint(intent.instanceId, intent.sourceFingerprint)
        || !validDeliveryCoordinate(intent.deliveryId)
        || !validDeliveryCoordinate(intent.attempt)
      ) {
        console.error('[dsh-chamber] ignored malformed deep-link delivery')
        return
      }
      callback(intent)
    }
  }

  /** preload.cts notifications onOpen parity (lines 784-817): the sourceId
   *  grammar accepts `local` plus the dsh-/gateway-/ssh- prefixed remotes
   *  (ssh- is the legacy alias the main process normalizes); everything else
   *  is dropped loudly. */
  function makeNotificationOpenListener(callback) {
    return function listener(payload) {
      if (payload === null || typeof payload !== 'object') {
        console.error('[dsh-chamber] ignored malformed notification-open delivery')
        return
      }
      var req = payload
      var sourceId = req.sourceId
      var validRemoteSourceId = typeof sourceId === 'string'
        && ['dsh-', 'gateway-', 'ssh-'].some(function (prefix) {
          if (sourceId.slice(0, prefix.length) !== prefix) return false
          return INSTANCE_ID_PATTERN.test(sourceId.slice(prefix.length))
        })
      var validSourceId = typeof sourceId === 'string' && (
        sourceId === 'local'
        || validRemoteSourceId
      )
      if (
        !validSourceId
        || !validSourceFingerprint(sourceId, req.sourceFingerprint)
        || typeof req.sessionId !== 'string'
        || req.sessionId.length === 0
        || !validDeliveryCoordinate(req.deliveryId)
        || !validDeliveryCoordinate(req.attempt)
      ) {
        console.error('[dsh-chamber] ignored malformed notification-open delivery')
        return
      }
      callback(req)
    }
  }

  // ---- the 9 namespaces + 4 scalars --------------------------------------
  // Every method below invokes its real manifest channel with the exact
  // preload.cts payload shape; no poc-unimplemented stub remains (S-B).

  /** desktopSsh — 全 32 invoke 方法接真实通道；载荷键逐字 preload（id 寻址
   *  通道一律 {id}，instances_set 直传数组原文）。W-05 切片桩 poc-sidecar.ts
   *  读 {instanceId}（superseded by sidecar-entry，见文件头注记），此处不迁就。 */
  var desktopSsh = {
    instances_get: function () { return invoke('desktop_ssh_instances_get', null) },
    // preload 逐字：第二参原文直传（主进程校验数组；legacy no-op roster 通道）。
    instances_set: function (instances) { return invoke('desktop_ssh_instances_set', instances) },
    delete_connection: function (id) { return invoke('desktop_ssh_delete_connection', { id: id }) },
    save_connection: function (previousId, input, credentials) {
      return invoke('desktop_ssh_save_connection', { previousId: previousId, input: input, credentials: credentials })
    },
    set_password: function (id, password) { return invoke('desktop_ssh_set_password', { id: id, password: password }) },
    set_gateway_token: function (id, token) { return invoke('desktop_gateway_set_token', { id: id, token: token }) },
    set_gateway_password: function (id, password) { return invoke('desktop_gateway_set_password', { id: id, password: password }) },
    gateway_plugin_sync: function (id) { return invoke('desktop_gateway_plugin_sync', { id: id }) },
    gateway_plugin_apply: function (id, input) {
      return invoke('desktop_gateway_plugin_apply', { id: id, add: input.add, remove: input.remove, deferRestart: input.deferRestart })
    },
    gateway_plugin_materialize: function (id) { return invoke('desktop_gateway_plugin_materialize', { id: id }) },
    config_list: function () { return invoke('desktop_ssh_config_list', null) },
    connect: function (id) { return invoke('desktop_ssh_connect', { id: id }) },
    disconnect: function (id) { return invoke('desktop_ssh_disconnect', { id: id }) },
    status: function (id) { return invoke('desktop_ssh_status', { id: id }) },
    reverify: function (id) { return invoke('desktop_ssh_reverify', { id: id }) },
    logs: function (id) { return invoke('desktop_ssh_logs', { id: id }) },
    logs_clear: function (id) { return invoke('desktop_ssh_logs_clear', { id: id }) },
    start_service: function (id) { return invoke('desktop_ssh_start_service', { id: id }) },
    stop_service: function (id) { return invoke('desktop_ssh_stop_service', { id: id }) },
    is_active: function (id) { return invoke('desktop_ssh_is_active', { id: id }) },
    restart_service: function (id) { return invoke('desktop_ssh_restart_service', { id: id }) },
    plugin_list: function (id) { return invoke('desktop_ssh_plugin_list', { id: id }) },
    plugin_apply: function (id, input) {
      return invoke('desktop_ssh_plugin_apply', { id: id, add: input.add, remove: input.remove, restart: input.restart })
    },
    ssh_plugin_undo: function (id) { return invoke('desktop_ssh_plugin_undo', { id: id }) },
    local_plugin_list: function () { return invoke('desktop_local_plugin_list', null) },
    npm_search: function (query) { return invoke('desktop_npm_search', { query: query }) },
    seed_host_graph: function (id) { return invoke('desktop_ssh_seed_host_graph', { id: id }) },
    plugin_materialize_add: function (id, name) { return invoke('desktop_ssh_plugin_materialize_add', { id: id, name: name }) },
    // pick 语义宿主侧（NSOpenPanel E8 腿已实现）；shim 只 invoke。
    plugin_materialize_add_pick: function (id) { return invoke('desktop_ssh_plugin_materialize_add_pick', { id: id }) },
    local_plugin_add: function (spec) { return invoke('desktop_local_plugin_add', { spec: spec }) },
    // pick 语义宿主侧（同上）。
    local_plugin_add_file: function () { return invoke('desktop_local_plugin_add_file', null) },
    local_plugin_remove: function (name) { return invoke('desktop_local_plugin_remove', { name: name }) },
    onStatusChanged: function (callback) {
      return subscribe(PUSH_EVENTS.SSH_STATUS_CHANGED, makePassthroughListener(callback))
    },
    onInstancesChanged: function (callback) {
      return subscribe(PUSH_EVENTS.SSH_INSTANCES_CHANGED, makeInstancesChangedListener(callback))
    }
  }

  /** settings — get/set/onChanged（preload 同形）。载荷 {patch}；set 的
   *  {error,code?} 拒绝形态（如 invalid-registry-origin）由 sidecar 裁决并
   *  如实上抛。 */
  var settings = {
    get: function () { return invoke('dsh-chamber:settings-get', null) },
    set: function (patch) { return invoke('dsh-chamber:settings-set', { patch: patch }) },
    onChanged: function (callback) {
      return subscribe(PUSH_EVENTS.SETTINGS_CHANGED, makePassthroughListener(callback))
    }
  }

  /** update — 5 invoke + onChanged。restartAndInstall 宿主腿差异见文件头
   *  （Swift flavor updater 宿主落地前错误如实上抛）。onChanged 是 preload
   *  唯一订阅拼写（W-04 时代的 onStateChanged 别名已移除——超集不在
   *  preload 面内）。 */
  var update = {
    state: function () { return invoke('dsh-chamber:update-state', null) },
    check: function () { return invoke('dsh-chamber:update-check', null) },
    download: function () { return invoke('dsh-chamber:update-download', null) },
    restartAndInstall: function () { return invoke('dsh-chamber:update-restart', null) },
    openReleasePage: function (url) { return invoke('dsh-chamber:open-release', { url: url }) },
    onChanged: function (callback) {
      return subscribe(PUSH_EVENTS.UPDATE_STATE_CHANGED, makePassthroughListener(callback))
    }
  }

  /** systemResume — 只有 onResume 订阅（preload 同形；无任何 invoke 方法）。 */
  var systemResume = {
    onResume: function (callback) {
      return subscribe(PUSH_EVENTS.SYSTEM_RESUME, makePassthroughListener(callback))
    }
  }

  /** openIn — apps() 解包 {apps}（preload 唯一返回变换）；open() 载荷四键
   *  逐字 preload。 */
  var openIn = {
    apps: function () {
      return invoke('dsh-chamber:open-in-apps', null).then(function (payload) {
        return payload.apps
      })
    },
    open: function (appId, instanceId, path, sourceFingerprint) {
      return invoke('dsh-chamber:open-in', { appId: appId, instanceId: instanceId, path: path, sourceFingerprint: sourceFingerprint })
    }
  }

  /** deepLink — ready/ack 接真实通道（sidecar 60/60）。ack 载荷按 preload
   *  现契约 {deliveryId, attempt}（core pendingRendererIntents.acknowledge
   *  同款；W-04 时代的单 id 形态已被 deliveryId+attempt 取代）。onIntent
   *  校验镜像 preload（malformed → loud drop）。 */
  var deepLink = {
    onIntent: function (callback) {
      return subscribe(PUSH_EVENTS.DEEP_LINK_INTENT, makeDeepLinkIntentListener(callback))
    },
    ready: function () { return invoke('dsh-chamber:deep-link-ready', null) },
    ack: function (deliveryId, attempt) {
      return invoke('dsh-chamber:deep-link-ack', { deliveryId: deliveryId, attempt: attempt })
    }
  }

  /** runtime — 12 invoke 全接 dsh-chamber:runtime-* 真实通道（sidecar
   *  60/60；payload 逐字 preload：install/cleanupVersion/clearFailure 带
   *  {version}、restorePreRollback 带 {stashName}、其余无载荷）。Swift flavor
   *  的 runtime 控制器腿（ctx）落地前 invoke 错误如实上抛。 */
  var runtime = {
    state: function () { return invoke('dsh-chamber:runtime-state', null) },
    check: function () { return invoke('dsh-chamber:runtime-check', null) },
    install: function (version) { return invoke('dsh-chamber:runtime-install', { version: version }) },
    resetBuiltin: function () { return invoke('dsh-chamber:runtime-reset-builtin', null) },
    applyNow: function () { return invoke('dsh-chamber:runtime-apply-now', null) },
    retryApply: function () { return invoke('dsh-chamber:runtime-retry-apply', null) },
    retryRestore: function () { return invoke('dsh-chamber:runtime-retry-restore', null) },
    recoverMetadata: function () { return invoke('dsh-chamber:runtime-recover-metadata', null) },
    cleanupVersion: function (version) { return invoke('dsh-chamber:runtime-cleanup-version', { version: version }) },
    clearFailure: function (version) { return invoke('dsh-chamber:runtime-clear-failure', { version: version }) },
    restorePreRollback: function (stashName) { return invoke('dsh-chamber:runtime-restore-pre-rollback', { stashName: stashName }) },
    // 事务性 managed-dsh 重启宿主叶（design 18 §3.6 项 8）；Swift flavor 装配
    // 面落地前错误如实上抛。
    restart: function () { return invoke('dsh-chamber:runtime-restart', null) },
    onChanged: function (callback) {
      return subscribe(PUSH_EVENTS.RUNTIME_STATE_CHANGED, makePassthroughListener(callback))
    }
  }

  /** notifications — notify 载荷 {payload}（preload 逐字；通知裁决/去重在
   *  core，Swift 侧经 node-edges 异步通知腿展示）；ready 握手后 core 才放行
   *  notification-open 推送；ack 按 {deliveryId, attempt}（core
   *  NOTIFICATION_OPEN_ACK 契约）。 */
  var notifications = {
    notify: function (payload) { return invoke('dsh-chamber:notify', { payload: payload }) },
    ready: function () { return invoke('dsh-chamber:notifications-ready', null) },
    ack: function (deliveryId, attempt) {
      return invoke('dsh-chamber:notification-open-ack', { deliveryId: deliveryId, attempt: attempt })
    },
    onOpen: function (callback) {
      return subscribe(PUSH_EVENTS.NOTIFICATION_OPEN, makeNotificationOpenListener(callback))
    }
  }

  /** badge — 单 invoke {count}（0 = 清除）；应用与否由主进程裁决 +
   *  平台门 + Swift dock 腿（返回值如实透传，渲染端静默容忍 false）。 */
  var badge = {
    set: function (count) { return invoke('dsh-chamber:badge-count', { count: count }) }
  }

  var dshChamberApi = {
    controlPlaneUrl: null,
    dshVersion: null,
    version: null,
    platform: null,
    desktopSsh: desktopSsh,
    update: update,
    settings: settings,
    systemResume: systemResume,
    openIn: openIn,
    deepLink: deepLink,
    runtime: runtime,
    notifications: notifications,
    badge: badge
  }

  // ---- info hydration ----------------------------------------------------

  function applyInfo(info) {
    if (info === null || typeof info !== 'object') return
    for (var i = 0; i < INFO_SCALAR_KEYS.length; i += 1) {
      var key = INFO_SCALAR_KEYS[i]
      var value = info[key]
      // Strings land as-is; junk (or an absent key) leaves null in place.
      if (typeof value === 'string') dshChamberApi[key] = value
    }
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms)
    })
  }

  /** preload.cts requestAppInfo mirror: retry only on rejection, 50 ms apart,
   *  INFO_MAX_ATTEMPTS total tries. Total failure keeps the scalars null —
   *  this promise never rejects, because defining the shim never depends on
   *  info. */
  function fetchInfo(attemptsLeft) {
    return invoke(INFO_CHANNEL, null).then(function (info) {
      applyInfo(info)
      return null
    }, function () {
      if (attemptsLeft > 1) {
        return delay(INFO_RETRY_MS).then(function () {
          return fetchInfo(attemptsLeft - 1)
        })
      }
      console.warn('[dsh-chamber] dsh-chamber:info failed after ' + INFO_MAX_ATTEMPTS + ' attempts; bridge scalars stay null')
      return null
    })
  }

  // ---- expose (non-configurable, non-writable — page cannot re-cover) ----

  function defineWindowGlobal(name, value) {
    Object.defineProperty(window, name, {
      value: value,
      configurable: false,
      enumerable: false,
      writable: false
    })
  }

  defineWindowGlobal('dshChamber', dshChamberApi)
  defineWindowGlobal('__dshChamberResolve', resolveInvocation)
  defineWindowGlobal('__dshChamberEmit', emitToListeners)

  // Kick off info hydration (documentStart; scalars fill when it resolves).
  fetchInfo(INFO_MAX_ATTEMPTS)
})()
