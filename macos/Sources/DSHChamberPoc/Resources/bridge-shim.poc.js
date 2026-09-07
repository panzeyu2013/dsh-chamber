/**
 * bridge-shim.poc.js — W-04 A-bridge shim for the macOS Swift shell POC
 * (todo companion §0.2⑤ W-04; design 25 §4.4.1). Swift's BridgeShimInjector
 * injects this file as a WKUserScript (.page world, documentStart) from
 * macos/Sources/DSHChamberPoc/Resources/.
 *
 * It mirrors the window.dshChamber surface of packages/desktop/preload.cts
 * (design 05 §7.4): 4 info scalars (controlPlaneUrl/dshVersion/version/
 * platform) + 9 namespaces (desktopSsh/update/settings/systemResume/openIn/
 * deepLink/runtime/notifications/badge). The POC implements only the W-05
 * slice subset — desktopSsh instances_get/connect/disconnect/status + the
 * status/instances subscriptions, settings get/set/onChanged, and the
 * reserved event subscriptions of the other namespaces (kept so M3 has its
 * plumbing in place; those events never arrive during the POC). EVERY other
 * method exists as a loud stub rejecting {error:'poc-unimplemented'} —
 * never silent, never an undefined call, never a fake success. Semantic
 * validation lives on the sidecar / real-processor side (B bridge, P1);
 * this file is transport only.
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
 * shim never depends on info, and pushes (desktop_ssh_status_changed) only
 * arrive after the matching invoke, so there is no subscribe-before-info
 * ordering hazard in the POC.
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
    console.warn("[dsh-chamber] no native bridge: window.webkit.messageHandlers.dshChamber is absent (page opened outside the WKWebView shell?) — every dshChamber invoke rejects {error:'no-native-bridge'}")
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
   *  returns an unsubscribe function (preload parity). */
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

  // ---- loud stubs --------------------------------------------------------

  /** Placeholder for every POC-unimplemented method: loud, never silent. */
  function pocUnimplemented() {
    return Promise.reject(new Error('poc-unimplemented'))
  }

  function rejectMethods(namespace, names) {
    for (var i = 0; i < names.length; i += 1) {
      var name = names[i]
      // Never overwrite an implemented method — stubs only fill gaps.
      if (namespace[name] === undefined) namespace[name] = pocUnimplemented
    }
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

  // ---- the 9 namespaces + 4 scalars --------------------------------------

  /** desktopSsh — the W-05 slice subset is real; the rest of the preload
   *  surface (save/delete/plugins/…) is loud-reject stubs. */
  var desktopSsh = {
    instances_get: function () { return invoke('desktop_ssh_instances_get', null) },
    // POC desktop_ssh_* payloads carry {instanceId} (the sidecar validates
    // the same field; P1 reconciles with the official {id} schemas).
    connect: function (instanceId) { return invoke('desktop_ssh_connect', { instanceId: instanceId }) },
    disconnect: function (instanceId) { return invoke('desktop_ssh_disconnect', { instanceId: instanceId }) },
    status: function (instanceId) { return invoke('desktop_ssh_status', { instanceId: instanceId }) },
    onStatusChanged: function (callback) { return subscribe(PUSH_EVENTS.SSH_STATUS_CHANGED, callback) },
    onInstancesChanged: function (callback) { return subscribe(PUSH_EVENTS.SSH_INSTANCES_CHANGED, callback) }
  }
  rejectMethods(desktopSsh, [
    'instances_set', 'delete_connection', 'save_connection', 'set_password',
    'set_gateway_token', 'set_gateway_password', 'gateway_plugin_sync',
    'gateway_plugin_apply', 'gateway_plugin_materialize', 'config_list',
    'reverify', 'logs', 'logs_clear', 'start_service', 'stop_service',
    'is_active', 'restart_service', 'plugin_list', 'plugin_apply',
    'ssh_plugin_undo', 'local_plugin_list', 'npm_search', 'seed_host_graph',
    'plugin_materialize_add', 'plugin_materialize_add_pick', 'local_plugin_add',
    'local_plugin_add_file', 'local_plugin_remove'
  ])

  /** settings — get/set are real (sidecar stubs return {}), onChanged keeps
   *  the subscription reserved for the real settings-changed source. */
  var settings = {
    get: function () { return invoke('dsh-chamber:settings-get', null) },
    set: function (patch) { return invoke('dsh-chamber:settings-set', { patch: patch }) },
    onChanged: function (callback) { return subscribe(PUSH_EVENTS.SETTINGS_CHANGED, callback) }
  }

  /** update — subscription kept (reserved for M3); all actions loud-reject.
   *  onStateChanged is the reserved subscription spelling; onChanged is the
   *  preload-parity alias (same table entry). */
  var update = {
    onStateChanged: function (callback) { return subscribe(PUSH_EVENTS.UPDATE_STATE_CHANGED, callback) },
    onChanged: function (callback) { return subscribe(PUSH_EVENTS.UPDATE_STATE_CHANGED, callback) }
  }
  rejectMethods(update, ['state', 'check', 'download', 'restartAndInstall', 'openReleasePage'])

  /** systemResume — subscription kept; no actions exist in preload. */
  var systemResume = {
    onResume: function (callback) { return subscribe(PUSH_EVENTS.SYSTEM_RESUME, callback) }
  }

  /** openIn — no push surface in preload; both actions loud-reject. */
  var openIn = {}
  rejectMethods(openIn, ['apps', 'open'])

  /** deepLink — intent subscription kept; ready/ack 接真实通道（sidecar
   *  60/60 实现，W-18 manifest 单源通道名）。 */
  var deepLink = {
    onIntent: function (callback) { return subscribe(PUSH_EVENTS.DEEP_LINK_INTENT, callback) },
    ready: function () { return invoke('dsh-chamber:deep-link-ready', null) },
    ack: function (intentId) {
      return invoke('dsh-chamber:deep-link-ack', { intentId: intentId ?? null })
    }
  }

  /** runtime — state push subscription kept; all actions loud-reject.
   *  onStateChanged is the reserved spelling, onChanged the preload alias. */
  var runtime = {
    onStateChanged: function (callback) { return subscribe(PUSH_EVENTS.RUNTIME_STATE_CHANGED, callback) },
    onChanged: function (callback) { return subscribe(PUSH_EVENTS.RUNTIME_STATE_CHANGED, callback) }
  }
  rejectMethods(runtime, [
    'state', 'check', 'install', 'resetBuiltin', 'applyNow', 'retryApply',
    'retryRestore', 'recoverMetadata', 'cleanupVersion', 'clearFailure',
    'restorePreRollback', 'restart'
  ])

  /** notifications — onOpen subscription kept（click loopback in the POC）；
   *  ready/ack 接真实通道（sidecar 60/60；ack 载荷带 id——core
   *  NOTIFICATION_OPEN_ACK 契约）。notify 保持 loud（通知显示走 Swift 宿主
   *  腿是 M3 集成点）。 */
  var notifications = {
    onOpen: function (callback) { return subscribe(PUSH_EVENTS.NOTIFICATION_OPEN, callback) },
    ready: function () { return invoke('dsh-chamber:notifications-ready', null) },
    ack: function (openIntentId) {
      return invoke('dsh-chamber:notification-open-ack', { id: openIntentId ?? null })
    },
    notify: pocUnimplemented
  }

  /** badge — setter 接真实通道（core BADGE_COUNT → node-edges setBadge →
   *  Swift dock 腿；窗口守卫在 legs）。 */
  var badge = {
    set: function (count) {
      return invoke('dsh-chamber:badge-count', { count: typeof count === 'number' ? count : 0 })
    }
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
