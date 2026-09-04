var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/prune-runtime.mjs
var prune_runtime_exports = {};
__export(prune_runtime_exports, {
  PRUNE_DIR_NAMES: () => PRUNE_DIR_NAMES,
  PRUNE_FILE_PATTERNS: () => PRUNE_FILE_PATTERNS,
  pruneRuntimeArtifacts: () => pruneRuntimeArtifacts
});
import { existsSync as existsSync2, readdirSync as readdirSync2, rmSync as rmSync2 } from "node:fs";
import { join as join4 } from "node:path";
function pruneRuntimeArtifacts(root) {
  const pnpmDir = join4(root, "node_modules", ".pnpm");
  function packageDirs(rel) {
    const dirs = /* @__PURE__ */ new Set();
    const top = join4(root, "node_modules", rel);
    if (existsSync2(top)) dirs.add(top);
    let pnpmEntries = [];
    try {
      pnpmEntries = readdirSync2(pnpmDir);
    } catch {
    }
    for (const entry of pnpmEntries) {
      const pkg = join4(pnpmDir, entry, "node_modules", rel);
      if (existsSync2(pkg)) dirs.add(pkg);
    }
    return [...dirs];
  }
  for (const pkg of packageDirs("node-pty")) {
    for (const sub of ["deps", "third_party", "src", "scripts", "typings", "binding.gyp"]) {
      rmSync2(join4(pkg, sub), { recursive: true, force: true });
    }
    const prebuilds = join4(pkg, "prebuilds");
    if (existsSync2(prebuilds)) {
      const current = `${process.platform}-${process.arch}`;
      for (const entry of readdirSync2(prebuilds)) {
        if (entry !== current) rmSync2(join4(prebuilds, entry), { recursive: true, force: true });
      }
    }
  }
  for (const rel of ["@mistralai/mistralai", "openai"]) {
    for (const pkg of packageDirs(rel)) {
      for (const sub of ["src", "examples", "tests"]) rmSync2(join4(pkg, sub), { recursive: true, force: true });
    }
  }
  let removedFiles = 0;
  let removedDirs = 0;
  const countFiles = (dir) => {
    let n = 0;
    for (const entry of readdirSync2(dir, { withFileTypes: true })) {
      const full = join4(dir, entry.name);
      if (entry.isDirectory()) n += countFiles(full);
      else n += 1;
    }
    return n;
  };
  const walk = (dir) => {
    for (const entry of readdirSync2(dir, { withFileTypes: true })) {
      const full = join4(dir, entry.name);
      if (entry.isDirectory()) {
        if (PRUNE_DIR_NAMES.has(entry.name)) {
          removedFiles += countFiles(full);
          removedDirs += 1;
          rmSync2(full, { recursive: true, force: true });
          continue;
        }
        walk(full);
      } else if (PRUNE_FILE_PATTERNS.some((pattern) => pattern.test(entry.name)) || /\.d\.(ts|cts|mts)$/.test(entry.name) || entry.name.endsWith(".map")) {
        rmSync2(full, { force: true });
        removedFiles += 1;
      }
    }
  };
  walk(root);
  return { removedFiles, removedDirs };
}
var PRUNE_DIR_NAMES, PRUNE_FILE_PATTERNS;
var init_prune_runtime = __esm({
  "src/prune-runtime.mjs"() {
    "use strict";
    PRUNE_DIR_NAMES = /* @__PURE__ */ new Set([
      "test",
      "tests",
      "__tests__",
      "__snapshots__",
      "fixtures",
      "test-fixtures",
      "examples",
      "example",
      "benchmark",
      "bench",
      "perf",
      "coverage",
      ".github",
      ".nyc_output"
    ]);
    PRUNE_FILE_PATTERNS = [
      /\.md$/i,
      /^(licen[cs]e|notice|authors|patents|copying)(\.|$)/i,
      /\.(test|spec)\.(js|cjs|mjs|mts|cts|ts|tsx|jsx)$/i,
      /^tsconfig.*\.json$/,
      /^\.(gitignore|npmignore|editorconfig|prettierrc.*|eslintrc.*|eslintignore|prettierignore|babelrc.*|yarnrc|npmrc|gitattributes|dockerignore|travis\.yml|appveyor\.yml|nycrc.*|gitmodules)$/,
      /\.tsbuildinfo$/
    ];
  }
});

// src/activation-gate.ts
var REQUIRED_ACTIVATION_PROBES = [
  "commands/execute",
  "session/list",
  "clientGraph/graph",
  "settings/describe",
  "gitWorktree/previewCreate",
  "data.settings",
  "data.sessions"
];
var HOST_DOMAIN_PROBE_NAMES = [
  "clientGraph/graph",
  "gitWorktree/previewCreate"
];
var HOST_DOMAIN_PROBE_NAME_SET = new Set(HOST_DOMAIN_PROBE_NAMES);
var PROBE_NAMES_WITHOUT_HOST_DOMAINS = REQUIRED_ACTIVATION_PROBES.filter((name) => !HOST_DOMAIN_PROBE_NAME_SET.has(name));
var DEFAULT_PROBE_WINDOW_MS = 6e4;
function decideVerdict(probes, opts) {
  const expected = opts.expectedNames ?? REQUIRED_ACTIVATION_PROBES;
  const windowMs = opts.windowMs ?? DEFAULT_PROBE_WINDOW_MS;
  const counts = /* @__PURE__ */ new Map();
  for (const probe of probes) counts.set(probe.name, (counts.get(probe.name) ?? 0) + 1);
  const exactSet = probes.length === expected.length && expected.every((name) => counts.get(name) === 1) && probes.every((probe) => expected.includes(probe.name));
  const withinWindow = Number.isFinite(opts.elapsedMs) && opts.elapsedMs >= 0 && Number.isFinite(windowMs) && windowMs > 0 && opts.elapsedMs <= windowMs;
  if (exactSet && withinWindow && probes.every((p) => p.ok)) return "pass";
  if (opts.observedOnce === true) return "fail";
  return "observe";
}
function rollbackTarget(opts) {
  const { previousVersion, previousWasKnownGood, knownGoodVersion } = opts;
  if (previousVersion !== null && (previousWasKnownGood || previousVersion === knownGoodVersion)) {
    return previousVersion;
  }
  return knownGoodVersion;
}
function shouldAutoRollback(restartExhausted, activeIsOverride) {
  return restartExhausted && activeIsOverride;
}

// src/apply-phase.ts
import { basename } from "node:path";

// src/sanitize-error.ts
function sanitizeErrorText(message) {
  return message.replace(/\bfile:\/\/[^\s"'<>]*/giu, "[path]").replace(/(?:[A-Za-z]:[\\/](?![/]))[^\s]*/g, "[path]").replace(/(?<![:/])\/(?:[^\s/]+(?:[/\\][^\s]*)?)/g, "[path]");
}

// src/apply-phase.ts
function errorText(error) {
  return sanitizeErrorText(error instanceof Error ? error.message : String(error));
}
function currentPointer(deps) {
  const state = deps.readCurrentPointerState();
  if (state.kind === "corrupt") throw new Error("current pointer metadata \u635F\u574F\uFF1B\u62D2\u7EDD\u7EE7\u7EED\u6FC0\u6D3B\u4E8B\u52A1");
  return state.kind === "valid" ? state.version : null;
}
function makeOutcome(input) {
  return {
    status: input.status,
    snapshotPath: input.snapshotPath ?? null,
    rollbackTarget: input.rollbackTarget ?? null,
    restoreOutcome: input.restoreOutcome ?? "none",
    swapAttempted: input.swapAttempted ?? false,
    error: input.error ?? null,
    retainPending: input.retainPending ?? false,
    retryAction: input.retryAction ?? null,
    runtimeBlocked: input.runtimeBlocked ?? false,
    failureKind: input.failureKind ?? null
  };
}
async function safeProbe(probe) {
  try {
    return await probe();
  } catch (error) {
    return [{ name: "probe", ok: false, error: errorText(error) }];
  }
}
function abortedOutcome() {
  return makeOutcome({
    status: "failed",
    retainPending: true,
    runtimeBlocked: false,
    retryAction: null,
    failureKind: null,
    error: "\u8FD0\u884C\u65F6\u6FC0\u6D3B\u4E8B\u52A1\u5DF2\u88AB\u5BBF\u4E3B\u4E2D\u6B62\uFF1B\u6301\u4E45\u5316\u73B0\u573A\u5C06\u5728\u4E0B\u6B21\u542F\u52A8\u7EED\u4F5C"
  });
}
function rollbackProbeSignal(signal) {
  return signal !== void 0 && signal.aborted ? void 0 : signal;
}
function advance(journal, phase, deps, patch = {}) {
  let next = {
    ...journal,
    ...patch,
    phase,
    updatedAt: (deps.now?.() ?? /* @__PURE__ */ new Date()).toISOString()
  };
  const latest = deps.readActivationJournal?.();
  if (latest?.kind === "valid" && latest.journal.startedAt === journal.startedAt && latest.journal.targetVersion === journal.targetVersion && latest.journal.nextIntent !== null) {
    next = { ...next, nextIntent: latest.journal.nextIntent };
  }
  deps.writeActivationJournal(next);
  return next;
}
function beginDelayedRollback(journal, writeJournal, now = /* @__PURE__ */ new Date()) {
  if (journal.phase !== "applied-monitoring") throw new Error("F7 rollback requires applied-monitoring journal");
  const target = rollbackTarget({
    previousVersion: journal.sourceIsBuiltin ? null : journal.sourceVersion,
    previousWasKnownGood: journal.sourceWasKnownGood === true || journal.sourceVersion === journal.knownGoodVersion,
    knownGoodVersion: journal.knownGoodVersion
  });
  const next = {
    ...journal,
    phase: "rollback-needed",
    rollbackTarget: target,
    updatedAt: now.toISOString()
  };
  writeJournal(next);
  return next;
}
async function resolvePreSwap(journal, deps) {
  return journal.preSwapSnapshotName === null ? null : deps.resolveSnapshotName(journal.preSwapSnapshotName);
}
async function prepareJournal(opts) {
  const { deps, pendingVersion, sourceVersion } = opts;
  const existing = opts.journal ?? null;
  if (existing !== null && existing.phase !== "intent") return existing;
  if (existing !== null && existing.targetVersion !== pendingVersion) {
    return makeOutcome({
      status: "failed",
      retainPending: true,
      runtimeBlocked: true,
      failureKind: "journal",
      error: "activation journal target \u4E0E pending \u4E0D\u4E00\u81F4"
    });
  }
  const targetIsBuiltin = existing?.targetIsBuiltin ?? opts.targetIsBuiltin === true;
  const intentKind = existing?.intentKind ?? opts.intentKind ?? "version-switch";
  const manualRollback = existing?.manualRollback ?? opts.manualRollback === true;
  const validIntent = intentKind === "version-switch" ? !targetIsBuiltin : targetIsBuiltin && !manualRollback;
  if (!validIntent) {
    return makeOutcome({
      status: "failed",
      retainPending: true,
      runtimeBlocked: true,
      failureKind: "journal",
      error: "activation intent kind \u4E0E target \u4E0D\u4E00\u81F4"
    });
  }
  if (targetIsBuiltin && pendingVersion !== opts.builtinVersion) {
    return makeOutcome({
      status: "failed",
      retainPending: true,
      runtimeBlocked: true,
      failureKind: "journal",
      error: "builtin activation target \u4E0E packaged manifest version \u4E0D\u4E00\u81F4"
    });
  }
  const targetValidation = deps.validateTarget(pendingVersion, targetIsBuiltin);
  if (!targetValidation.ok) {
    return makeOutcome({
      status: "failed",
      retainPending: true,
      retryAction: "apply",
      runtimeBlocked: false,
      failureKind: "target-invalid",
      error: `\u5F85\u5E94\u7528\u8FD0\u884C\u65F6\u6811\u65E0\u6548\uFF1A${targetValidation.error}`
    });
  }
  if (sourceVersion === null) {
    return makeOutcome({
      status: "snapshot-failed",
      retainPending: true,
      retryAction: "apply",
      runtimeBlocked: false,
      failureKind: "snapshot",
      error: "\u65E0\u6CD5\u786E\u5B9A\u5207\u6362\u524D\u8FD0\u884C\u65F6\u7248\u672C\uFF1B\u672A\u89E6\u78B0\u6307\u9488"
    });
  }
  let preSwapSnapshot;
  let manual = { snapshotPath: null, stashPath: null };
  if (targetIsBuiltin && manualRollback) {
    return makeOutcome({
      status: "failed",
      retainPending: true,
      runtimeBlocked: false,
      failureKind: "journal",
      error: "builtin fallback \u4E0D\u80FD\u540C\u65F6\u6807\u8BB0 manualRollback"
    });
  }
  try {
    preSwapSnapshot = await deps.snapshot(sourceVersion);
    if (manualRollback) manual = await deps.prepareManualRollback(pendingVersion);
  } catch (error) {
    return makeOutcome({
      status: "snapshot-failed",
      retainPending: true,
      retryAction: "apply",
      runtimeBlocked: false,
      failureKind: "snapshot",
      error: errorText(error)
    });
  }
  const now = deps.now?.() ?? /* @__PURE__ */ new Date();
  const prepared = {
    schemaVersion: 1,
    phase: "prepared",
    targetVersion: pendingVersion,
    targetIsBuiltin,
    manualRollback,
    intentKind,
    sourceVersion,
    sourceIsBuiltin: opts.sourceIsBuiltin === true,
    sourceWasKnownGood: opts.sourceWasKnownGood === true,
    knownGoodVersion: opts.knownGoodVersion,
    preSwapSnapshotName: basename(preSwapSnapshot),
    manualDataSnapshotName: manual.snapshotPath === null ? null : basename(manual.snapshotPath),
    preRollbackStashName: manual.stashPath === null ? null : basename(manual.stashPath),
    rollbackTarget: null,
    nextIntent: null,
    startedAt: existing?.startedAt ?? now.toISOString(),
    updatedAt: now.toISOString()
  };
  try {
    const latest = deps.readActivationJournal?.();
    const durablePrepared = latest?.kind === "valid" && latest.journal.startedAt === prepared.startedAt && latest.journal.targetVersion === prepared.targetVersion && latest.journal.nextIntent !== null ? { ...prepared, nextIntent: latest.journal.nextIntent } : prepared;
    deps.writeActivationJournal(durablePrepared);
    return durablePrepared;
  } catch (error) {
    return makeOutcome({
      status: "snapshot-failed",
      snapshotPath: preSwapSnapshot,
      retainPending: true,
      retryAction: "apply",
      runtimeBlocked: false,
      failureKind: "journal",
      error: `\u65E0\u6CD5\u6301\u4E45\u5316\u6FC0\u6D3B\u4E8B\u52A1\uFF1B\u672A\u89E6\u78B0\u6307\u9488\uFF1A${errorText(error)}`
    });
  }
}
async function delayedVerdict(opts) {
  const nowMs = opts.deps.nowMs ?? Date.now;
  const firstStartedAt = nowMs();
  const probeTarget = () => opts.deps.probe(opts.pendingVersion, opts.targetIsBuiltin === true, opts.signal);
  let verdict = decideVerdict(await safeProbe(probeTarget), {
    elapsedMs: nowMs() - firstStartedAt,
    observedOnce: false,
    ...opts.deps.probeExpectedNames === void 0 ? {} : { expectedNames: opts.deps.probeExpectedNames }
  });
  if (verdict === "observe") {
    const wait = opts.deps.waitBeforeRetry ?? ((delayMs) => new Promise((resolve3) => setTimeout(resolve3, delayMs)));
    await wait(opts.retryDelayMs ?? 2e3);
    const secondStartedAt = nowMs();
    verdict = decideVerdict(await safeProbe(probeTarget), {
      elapsedMs: nowMs() - secondStartedAt,
      observedOnce: true,
      ...opts.deps.probeExpectedNames === void 0 ? {} : { expectedNames: opts.deps.probeExpectedNames }
    });
  }
  return verdict === "pass" ? "pass" : "fail";
}
async function restoreJournalSnapshot(snapshotName, deps) {
  if (snapshotName === null) return { path: null, restoreOutcome: "incomplete", error: "journal snapshot \u7F3A\u5931" };
  const snapshotPath = await deps.resolveSnapshotName(snapshotName);
  if (snapshotPath === null) return { path: null, restoreOutcome: "incomplete", error: `journal snapshot ${snapshotName} \u7F3A\u5931\u6216\u4E0D\u53EF\u4FE1` };
  try {
    return { path: snapshotPath, restoreOutcome: await deps.restore(snapshotPath), error: null };
  } catch (error) {
    return { path: snapshotPath, restoreOutcome: "half", error: errorText(error) };
  }
}
async function continueRollback(opts, initial) {
  if (opts.signal?.aborted) return abortedOutcome();
  const { deps } = opts;
  let journal = initial;
  const preSwapPath = await resolvePreSwap(journal, deps);
  if (preSwapPath === null) {
    return makeOutcome({
      status: "failed",
      retainPending: true,
      runtimeBlocked: true,
      retryAction: "restore",
      failureKind: "journal",
      rollbackTarget: journal.rollbackTarget,
      error: "pre-swap snapshot \u7F3A\u5931\uFF1B\u62D2\u7EDD\u7EE7\u7EED\u56DE\u9000"
    });
  }
  if (journal.phase === "rollback-needed" || journal.phase === "restoring" || journal.phase === "restore-complete") {
    const fallbackVersion = journal.rollbackTarget ?? opts.builtinVersion;
    const fallbackValidation = deps.validateTarget(fallbackVersion, journal.rollbackTarget === null);
    if (!fallbackValidation.ok) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        rollbackTarget: journal.rollbackTarget,
        retainPending: true,
        retryAction: "apply",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "target-invalid",
        error: `\u56DE\u9000\u8FD0\u884C\u65F6\u6811\u65E0\u6548\uFF1A${fallbackValidation.error}`
      });
    }
  }
  if (journal.phase === "rollback-needed") {
    try {
      await deps.stopHost();
    } catch (error) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        rollbackTarget: journal.rollbackTarget,
        retainPending: true,
        retryAction: "apply",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "stop-host",
        error: `\u65E0\u6CD5\u505C\u6B62\u5931\u8D25\u8FD0\u884C\u65F6\uFF1B\u672A\u89E6\u78B0\u6570\u636E\uFF1A${errorText(error)}`
      });
    }
    try {
      deps.switchPointer(journal.rollbackTarget);
    } catch (error) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        rollbackTarget: journal.rollbackTarget,
        retainPending: true,
        retryAction: "apply",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "rollback-switch",
        error: `\u56DE\u9000\u6307\u9488\u5207\u6362\u5931\u8D25\uFF08\u5931\u8D25\u8FD0\u884C\u65F6\u5DF2\u505C\u6B62\uFF0C\u6570\u636E\u672A\u6062\u590D\uFF09\uFF1A${errorText(error)}`
      });
    }
    try {
      journal = advance(journal, "restoring", deps);
    } catch (error) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        rollbackTarget: journal.rollbackTarget,
        retainPending: true,
        retryAction: "restore",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "journal",
        error: `\u56DE\u9000\u6307\u9488\u5DF2\u5207\u6362\u4F46\u65E0\u6CD5\u8BB0\u5F55\u6062\u590D\u76F8\u4F4D\uFF1A${errorText(error)}`
      });
    }
  }
  if (journal.phase === "restoring") {
    if (currentPointer(deps) !== journal.rollbackTarget) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        rollbackTarget: journal.rollbackTarget,
        retainPending: true,
        retryAction: "restore",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "journal",
        error: "restoring journal \u4E0E current rollback pointer \u4E0D\u4E00\u81F4"
      });
    }
    const restored = await restoreJournalSnapshot(journal.preSwapSnapshotName, deps);
    if (restored.restoreOutcome !== "complete") {
      const message = restored.restoreOutcome === "half" ? `\u6570\u636E\u6062\u590D\u5931\u8D25\uFF08\u73B0\u573A .old \u4FDD\u7559\uFF0C\u53EF\u91CD\u8BD5\u6062\u590D\uFF09\uFF1A${restored.error ?? "snapshot restore \u672A\u5B8C\u6210"}` : `\u6570\u636E\u6062\u590D\u672A\u5B8C\u6210\uFF08\u73B0\u573A\u4FDD\u7559\uFF09\uFF1A${restored.error ?? "snapshot restore \u672A\u5B8C\u6210"}`;
      return makeOutcome({
        status: "rolled-back",
        snapshotPath: preSwapPath,
        rollbackTarget: journal.rollbackTarget,
        restoreOutcome: restored.restoreOutcome,
        retainPending: true,
        retryAction: "restore",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "restore",
        error: message
      });
    }
    try {
      journal = advance(journal, "restore-complete", deps);
    } catch (error) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        rollbackTarget: journal.rollbackTarget,
        restoreOutcome: "complete",
        retainPending: true,
        retryAction: "apply",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "journal",
        error: `\u6570\u636E\u5DF2\u6062\u590D\u4F46\u65E0\u6CD5\u8BB0\u5F55\u5B8C\u6210\u76F8\u4F4D\uFF1A${errorText(error)}`
      });
    }
  }
  if (journal.phase === "restore-complete") {
    if (currentPointer(deps) !== journal.rollbackTarget) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        rollbackTarget: journal.rollbackTarget,
        restoreOutcome: "complete",
        retainPending: true,
        retryAction: "apply",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "journal",
        error: "restore-complete journal \u4E0E current rollback pointer \u4E0D\u4E00\u81F4"
      });
    }
    const fallbackVersion = journal.rollbackTarget ?? opts.builtinVersion;
    const fallbackVerdict = decideVerdict(
      await safeProbe(() => deps.probe(fallbackVersion, journal.rollbackTarget === null, rollbackProbeSignal(opts.signal))),
      { elapsedMs: 0, observedOnce: true, ...deps.probeExpectedNames === void 0 ? {} : { expectedNames: deps.probeExpectedNames } }
    );
    if (fallbackVerdict === "pass") {
      return makeOutcome({
        status: "rolled-back",
        snapshotPath: preSwapPath,
        rollbackTarget: journal.rollbackTarget,
        restoreOutcome: "complete",
        swapAttempted: true
      });
    }
    if (journal.rollbackTarget === null) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        restoreOutcome: "complete",
        swapAttempted: true,
        runtimeBlocked: true,
        failureKind: "terminal",
        error: "\u5185\u5EFA\u56DE\u9000\u8FD0\u884C\u65F6\u63A2\u9488\u5931\u8D25"
      });
    }
    try {
      journal = advance(journal, "fallback-builtin", deps, { rollbackTarget: null });
    } catch (error) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        restoreOutcome: "complete",
        retainPending: true,
        retryAction: "apply",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "journal",
        error: `\u56DE\u9000\u76EE\u6807\u5931\u8D25\u4E14\u65E0\u6CD5\u8BB0\u5F55\u5185\u5EFA\u964D\u7EA7\uFF1A${errorText(error)}`
      });
    }
  }
  if (journal.phase === "fallback-builtin") {
    const builtinValidation = deps.validateTarget(opts.builtinVersion, true);
    if (!builtinValidation.ok) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        restoreOutcome: "complete",
        retainPending: true,
        retryAction: "apply",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "target-invalid",
        error: `\u5185\u5EFA\u56DE\u9000\u6811\u65E0\u6548\uFF1A${builtinValidation.error}`
      });
    }
    try {
      await deps.stopHost();
      deps.switchPointer(null);
    } catch (error) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        restoreOutcome: "complete",
        retainPending: true,
        retryAction: "apply",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "fallback",
        error: `\u56DE\u9000\u76EE\u6807\u5931\u8D25\uFF0C\u843D\u5185\u5EFA\u8FD0\u884C\u65F6\u4E5F\u5931\u8D25\uFF1A${errorText(error)}`
      });
    }
    const builtinVerdict = decideVerdict(
      await safeProbe(() => deps.probe(opts.builtinVersion, true, rollbackProbeSignal(opts.signal))),
      { elapsedMs: 0, observedOnce: true, ...deps.probeExpectedNames === void 0 ? {} : { expectedNames: deps.probeExpectedNames } }
    );
    return makeOutcome({
      status: "failed",
      snapshotPath: preSwapPath,
      restoreOutcome: "complete",
      swapAttempted: true,
      retainPending: builtinVerdict !== "pass",
      retryAction: builtinVerdict !== "pass" ? "apply" : null,
      runtimeBlocked: builtinVerdict !== "pass",
      failureKind: "terminal",
      error: builtinVerdict === "pass" ? "\u53EF\u4FE1\u56DE\u9000\u76EE\u6807\u63A2\u9488\u5931\u8D25\uFF0C\u5DF2\u843D\u5185\u5EFA\u8FD0\u884C\u65F6" : "\u53EF\u4FE1\u56DE\u9000\u76EE\u6807\u4E0E\u5185\u5EFA\u8FD0\u884C\u65F6\u63A2\u9488\u5747\u5931\u8D25"
    });
  }
  return makeOutcome({
    status: "failed",
    snapshotPath: preSwapPath,
    retainPending: true,
    runtimeBlocked: true,
    retryAction: "apply",
    failureKind: "journal",
    error: `\u65E0\u6CD5\u4ECE journal phase ${journal.phase} \u7EE7\u7EED\u56DE\u9000`
  });
}
async function runApplyTransaction(opts) {
  if (opts.signal?.aborted) return abortedOutcome();
  const { deps, pendingVersion } = opts;
  const prepared = await prepareJournal(opts);
  if (!("schemaVersion" in prepared)) return prepared;
  let journal = prepared;
  if (journal.targetVersion !== pendingVersion) {
    return makeOutcome({
      status: "failed",
      retainPending: true,
      runtimeBlocked: true,
      failureKind: "journal",
      error: "activation journal target \u4E0E pending \u4E0D\u4E00\u81F4"
    });
  }
  const preSwapPath = await resolvePreSwap(journal, deps);
  if (preSwapPath === null) {
    return makeOutcome({
      status: "failed",
      retainPending: true,
      runtimeBlocked: journal.phase !== "prepared",
      retryAction: journal.phase === "prepared" ? "apply" : "restore",
      failureKind: "journal",
      error: "activation journal \u7684 pre-swap snapshot \u7F3A\u5931"
    });
  }
  if (journal.phase === "rollback-needed" || journal.phase === "restoring" || journal.phase === "restore-complete" || journal.phase === "fallback-builtin") {
    return continueRollback(opts, journal);
  }
  const targetValidation = deps.validateTarget(pendingVersion, journal.targetIsBuiltin);
  if (!targetValidation.ok) {
    const targetPointer2 = journal.targetIsBuiltin ? null : pendingVersion;
    return makeOutcome({
      status: "failed",
      retainPending: true,
      retryAction: "apply",
      runtimeBlocked: currentPointer(deps) === targetPointer2,
      failureKind: "target-invalid",
      error: `\u5F85\u5E94\u7528\u8FD0\u884C\u65F6\u6811\u65E0\u6548\uFF1A${targetValidation.error}`
    });
  }
  if (journal.phase === "prepared") {
    const current = currentPointer(deps);
    const targetPointer2 = journal.targetIsBuiltin ? null : pendingVersion;
    if (current !== targetPointer2) {
      const expectedSourcePointer = journal.sourceIsBuiltin ? null : journal.sourceVersion;
      if (current !== expectedSourcePointer) {
        return makeOutcome({
          status: "failed",
          snapshotPath: preSwapPath,
          retainPending: true,
          runtimeBlocked: true,
          retryAction: "apply",
          failureKind: "journal",
          error: `current pointer \u4E0E journal source \u4E0D\u4E00\u81F4\uFF08current=${current ?? "builtin"}\uFF09`
        });
      }
      try {
        deps.switchPointer(targetPointer2);
      } catch (error) {
        return makeOutcome({
          status: "failed",
          snapshotPath: preSwapPath,
          retainPending: true,
          retryAction: "apply",
          runtimeBlocked: false,
          swapAttempted: true,
          failureKind: "initial-switch",
          error: `switchPointer \u5931\u8D25\uFF1A${errorText(error)}`
        });
      }
    }
    try {
      journal = advance(journal, "switched", deps);
    } catch (error) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        retainPending: true,
        retryAction: "apply",
        runtimeBlocked: true,
        swapAttempted: current !== targetPointer2,
        failureKind: "journal",
        error: `\u6307\u9488\u5DF2\u5207\u6362\u4F46\u65E0\u6CD5\u6301\u4E45\u5316\u76F8\u4F4D\uFF1A${errorText(error)}`
      });
    }
  }
  const targetPointer = journal.targetIsBuiltin ? null : pendingVersion;
  if (journal.phase === "switched" && currentPointer(deps) !== targetPointer) {
    return makeOutcome({
      status: "failed",
      snapshotPath: preSwapPath,
      retainPending: true,
      retryAction: "apply",
      runtimeBlocked: true,
      failureKind: "journal",
      error: "switched journal \u4E0E current pointer \u4E0D\u4E00\u81F4"
    });
  }
  if (journal.phase === "switched" && journal.manualDataSnapshotName !== null) {
    try {
      journal = advance(journal, "manual-restoring", deps);
    } catch (error) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        retainPending: true,
        retryAction: "restore",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "journal",
        error: `\u65E0\u6CD5\u8BB0\u5F55\u624B\u52A8\u56DE\u6EDA\u6570\u636E\u6062\u590D\u76F8\u4F4D\uFF1A${errorText(error)}`
      });
    }
  }
  if (journal.phase === "manual-restoring") {
    if (currentPointer(deps) !== targetPointer) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        retainPending: true,
        retryAction: "restore",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "journal",
        error: "manual-restoring journal \u4E0E current target pointer \u4E0D\u4E00\u81F4"
      });
    }
    const restored = await restoreJournalSnapshot(journal.manualDataSnapshotName, deps);
    if (restored.restoreOutcome !== "complete") {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        restoreOutcome: restored.restoreOutcome,
        retainPending: true,
        retryAction: "restore",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "manual-restore",
        error: restored.restoreOutcome === "half" ? `\u76EE\u6807\u7248\u672C\u6570\u636E\u6062\u590D\u5931\u8D25\uFF08\u73B0\u573A .old \u4FDD\u7559\uFF09\uFF1A${restored.error ?? "snapshot restore \u672A\u5B8C\u6210"}` : `\u76EE\u6807\u7248\u672C\u6570\u636E\u6062\u590D\u672A\u5B8C\u6210\uFF08\u73B0\u573A\u4FDD\u7559\uFF09\uFF1A${restored.error ?? "snapshot restore \u672A\u5B8C\u6210"}`
      });
    }
    try {
      journal = advance(journal, "manual-restored", deps);
    } catch (error) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        restoreOutcome: "complete",
        retainPending: true,
        retryAction: "apply",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "journal",
        error: `\u76EE\u6807\u7248\u672C\u6570\u636E\u5DF2\u6062\u590D\u4F46\u65E0\u6CD5\u8BB0\u5F55\u76F8\u4F4D\uFF1A${errorText(error)}`
      });
    }
  }
  if (journal.phase !== "switched" && journal.phase !== "manual-restored") {
    return makeOutcome({
      status: "failed",
      snapshotPath: preSwapPath,
      retainPending: true,
      retryAction: "apply",
      runtimeBlocked: true,
      failureKind: "journal",
      error: `\u4E0D\u652F\u6301\u7684 activation journal phase: ${journal.phase}`
    });
  }
  if (await delayedVerdict(opts) === "pass") {
    if (!journal.targetIsBuiltin) {
      try {
        deps.recordProbePass(pendingVersion);
      } catch {
      }
    }
    try {
      journal = advance(journal, "applied-monitoring", deps, { nextIntent: null });
    } catch (error) {
      return makeOutcome({
        status: "failed",
        snapshotPath: preSwapPath,
        retainPending: true,
        retryAction: "apply",
        runtimeBlocked: true,
        swapAttempted: true,
        failureKind: "journal",
        error: `\u63A2\u9488\u901A\u8FC7\u4F46\u65E0\u6CD5\u6301\u4E45\u5316 F7 \u76D1\u63A7\u4E0A\u4E0B\u6587\uFF1A${errorText(error)}`
      });
    }
    return makeOutcome({ status: "applied", snapshotPath: preSwapPath, swapAttempted: true });
  }
  const target = rollbackTarget({
    previousVersion: journal.sourceIsBuiltin ? null : journal.sourceVersion,
    previousWasKnownGood: journal.sourceWasKnownGood === true || journal.sourceVersion === journal.knownGoodVersion,
    knownGoodVersion: journal.knownGoodVersion
  });
  try {
    journal = advance(journal, "rollback-needed", deps, { rollbackTarget: target });
  } catch (error) {
    return makeOutcome({
      status: "failed",
      snapshotPath: preSwapPath,
      rollbackTarget: target,
      retainPending: true,
      retryAction: "apply",
      runtimeBlocked: true,
      swapAttempted: true,
      failureKind: "journal",
      error: `\u63A2\u9488\u5931\u8D25\u4F46\u65E0\u6CD5\u6301\u4E45\u5316\u56DE\u9000\u610F\u56FE\uFF1A${errorText(error)}`
    });
  }
  return continueRollback(opts, journal);
}
async function applyPendingVersion(opts) {
  try {
    return await runApplyTransaction(opts);
  } catch (error) {
    return makeOutcome({
      status: "failed",
      retainPending: true,
      runtimeBlocked: true,
      failureKind: "journal",
      error: errorText(error)
    });
  }
}

// src/dsh-runtime-store.ts
import {
  chmodSync,
  existsSync,
  lstatSync as lstatSync2,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync
} from "node:fs";
import { basename as basename3, dirname as dirname2, isAbsolute, join as join2, relative as relative2 } from "node:path";
import { createHash, randomBytes as randomBytes2 } from "node:crypto";

// src/version-safety.ts
var EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function isSafeVersion(raw) {
  const trimmed = raw.trim();
  if (!EXACT_SEMVER.test(trimmed)) return false;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return false;
  return true;
}
function assertSafeVersion(raw) {
  const trimmed = raw.trim();
  if (!isSafeVersion(trimmed)) {
    throw new Error(
      `\u4E0D\u5B89\u5168\u7684 dsh \u8FD0\u884C\u65F6\u7248\u672C\u4E32 ${JSON.stringify(raw)}\uFF1A\u5FC5\u987B\u662F\u7CBE\u786E semver\uFF08\u5982 0.1.1-rc.2\uFF09\u4E14\u4E0D\u542B /\u3001\\\u3001..`
    );
  }
  return trimmed;
}

// src/private-fs.ts
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename as basename2, dirname, join, relative, sep } from "node:path";
var PRIVATE_RUNTIME_DIR_MODE = 448;
var PRIVATE_RUNTIME_FILE_MODE = 384;
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameFileSnapshot(left, right) {
  return sameIdentity(left, right) && left.isFile() && right.isFile() && left.nlink === 1 && right.nlink === 1 && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function samePreciseFileSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.isFile() && right.isFile() && left.nlink === 1n && right.nlink === 1n && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function noFollowReadFlags() {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("\u5F53\u524D\u5E73\u53F0\u7F3A\u5C11 O_NOFOLLOW\uFF0C\u62D2\u7EDD\u8BBF\u95EE runtime \u79C1\u6709\u72B6\u6001");
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW;
}
function noFollowWriteFlags() {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("\u5F53\u524D\u5E73\u53F0\u7F3A\u5C11 O_NOFOLLOW\uFF0C\u62D2\u7EDD\u5199\u5165 runtime \u79C1\u6709\u72B6\u6001");
  }
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
}
function noFollowDirectoryFlags() {
  const directory = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
  return noFollowReadFlags() | directory;
}
function syncFd(fd, deps) {
  const sync = deps?.fsync ?? fsyncSync;
  sync(fd);
}
function verifyPinnedDirectory(pin, message) {
  const opened = fstatSync(pin.fd);
  const atPath = lstatSync(pin.path);
  const parent = lstatSync(pin.parentPath);
  if (!opened.isDirectory() || atPath.isSymbolicLink() || !atPath.isDirectory() || !sameIdentity(pin.identity, opened) || !sameIdentity(opened, atPath) || parent.isSymbolicLink() || !parent.isDirectory() || !sameIdentity(pin.parentIdentity, parent)) {
    throw new Error(message);
  }
  return atPath;
}
function pinRealDirectory(path, tighten) {
  const parentPath = dirname(path);
  const parentBefore = lstatSync(parentPath);
  if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) {
    throw new Error(`\u4E0D\u5B89\u5168\u7684\u79C1\u6709\u76EE\u5F55\u7236\u7EA7\uFF1A${basename2(path)}`);
  }
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`\u4E0D\u5B89\u5168\u7684\u79C1\u6709\u76EE\u5F55\uFF1A${basename2(path)}`);
  }
  let fd = null;
  try {
    fd = openSync(path, noFollowDirectoryFlags());
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || !sameIdentity(before, opened)) {
      throw new Error(`\u79C1\u6709\u76EE\u5F55\u8EAB\u4EFD\u4E0D\u7A33\u5B9A\uFF1A${basename2(path)}`);
    }
    if (tighten && (opened.mode & 511) !== PRIVATE_RUNTIME_DIR_MODE) {
      fchmodSync(fd, PRIVATE_RUNTIME_DIR_MODE);
    }
    const pin = {
      path,
      parentPath,
      fd,
      identity: { dev: opened.dev, ino: opened.ino },
      parentIdentity: { dev: parentBefore.dev, ino: parentBefore.ino }
    };
    verifyPinnedDirectory(pin, `\u79C1\u6709\u76EE\u5F55\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25\uFF1A${basename2(path)}`);
    fd = null;
    return pin;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
function closePinnedDirectory(pin) {
  closeSync(pin.fd);
}
function syncPinnedDirectory(pin, deps) {
  verifyPinnedDirectory(pin, `\u79C1\u6709\u76EE\u5F55 fsync \u524D\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25\uFF1A${basename2(pin.path)}`);
  syncFd(pin.fd, deps);
  verifyPinnedDirectory(pin, `\u79C1\u6709\u76EE\u5F55 fsync \u540E\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25\uFF1A${basename2(pin.path)}`);
}
function inspectRealDirectory(path, tighten) {
  const pin = pinRealDirectory(path, tighten);
  try {
    return verifyPinnedDirectory(pin, `\u79C1\u6709\u76EE\u5F55\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25\uFF1A${basename2(path)}`);
  } finally {
    closePinnedDirectory(pin);
  }
}
function ensurePrivateDirectoryNoFollow(path, deps) {
  const parent = dirname(path);
  const parentPin = pinRealDirectory(parent, false);
  let childPin = null;
  try {
    verifyPinnedDirectory(parentPin, `\u79C1\u6709\u76EE\u5F55\u521B\u5EFA\u524D\u7236\u76EE\u5F55\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25\uFF1A${basename2(path)}`);
    try {
      mkdirSync(path, { recursive: false, mode: PRIVATE_RUNTIME_DIR_MODE });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    childPin = pinRealDirectory(path, true);
    syncPinnedDirectory(parentPin, deps);
    verifyPinnedDirectory(childPin, `\u79C1\u6709\u76EE\u5F55\u521B\u5EFA\u540E\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25\uFF1A${basename2(path)}`);
  } finally {
    if (childPin !== null) closePinnedDirectory(childPin);
    closePinnedDirectory(parentPin);
  }
}
function createPrivateDirectoryNoFollow(path, deps) {
  const parentPin = pinRealDirectory(dirname(path), false);
  let childPin = null;
  try {
    verifyPinnedDirectory(parentPin, `\u79C1\u6709\u76EE\u5F55\u521B\u5EFA\u524D\u7236\u76EE\u5F55\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25\uFF1A${basename2(path)}`);
    mkdirSync(path, { recursive: false, mode: PRIVATE_RUNTIME_DIR_MODE });
    childPin = pinRealDirectory(path, true);
    syncPinnedDirectory(parentPin, deps);
    verifyPinnedDirectory(childPin, `\u79C1\u6709\u76EE\u5F55\u521B\u5EFA\u540E\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25\uFF1A${basename2(path)}`);
  } finally {
    if (childPin !== null) closePinnedDirectory(childPin);
    closePinnedDirectory(parentPin);
  }
}
function runtimeRootPath(baseDir) {
  return join(baseDir, "dsh-runtime");
}
function ensureRuntimeRootNoFollow(baseDir, deps) {
  inspectRealDirectory(baseDir, false);
  const root = runtimeRootPath(baseDir);
  ensurePrivateDirectoryNoFollow(root, deps);
  return root;
}
function assertRuntimeRootNoFollow(baseDir) {
  inspectRealDirectory(baseDir, false);
  const root = runtimeRootPath(baseDir);
  inspectRealDirectory(root, true);
  return root;
}
function ensureRuntimeSubdirectoryNoFollow(baseDir, ...segments) {
  let current = ensureRuntimeRootNoFollow(baseDir);
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || basename2(segment) !== segment) {
      throw new Error(`\u4E0D\u5B89\u5168\u7684 runtime \u5B50\u76EE\u5F55\u540D\uFF1A${JSON.stringify(segment)}`);
    }
    current = join(current, segment);
    ensurePrivateDirectoryNoFollow(current);
  }
  return current;
}
function ensureOwnedParent(baseDir, filePath, deps) {
  const root = ensureRuntimeRootNoFollow(baseDir, deps);
  const parent = dirname(filePath);
  const rel = relative(root, parent);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("runtime \u79C1\u6709\u6587\u4EF6\u8D8A\u51FA\u53D7\u63A7\u6839\u76EE\u5F55");
  }
  if (rel === "") {
    inspectRealDirectory(root, true);
    return;
  }
  const segments = rel.split(sep);
  ensureRuntimeSubdirectoryNoFollow(baseDir, ...segments);
}
function assertReplaceableLeaf(filePath) {
  try {
    const info = lstatSync(filePath);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`runtime \u79C1\u6709\u6587\u4EF6\u4E0D\u662F\u5355\u94FE\u63A5\u666E\u901A\u6587\u4EF6\uFF1A${basename2(filePath)}`);
    }
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}
function removePinnedLeafBestEffort(parentPin, filePath, identity) {
  if (identity === null) return;
  try {
    verifyPinnedDirectory(parentPin, "runtime \u4E34\u65F6\u6587\u4EF6\u6E05\u7406\u524D\u7236\u76EE\u5F55\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25");
    const leaf = lstatSync(filePath);
    if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.nlink !== 1 || !sameIdentity(identity, leaf)) return;
    unlinkSync(filePath);
    verifyPinnedDirectory(parentPin, "runtime \u4E34\u65F6\u6587\u4EF6\u6E05\u7406\u540E\u7236\u76EE\u5F55\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25");
  } catch {
  }
}
function atomicWriteRuntimeFileNoFollow(baseDir, filePath, data, deps) {
  ensureOwnedParent(baseDir, filePath, deps);
  assertReplaceableLeaf(filePath);
  const parent = dirname(filePath);
  const tmp = join(parent, `.${basename2(filePath)}.tmp-${randomBytes(6).toString("hex")}`);
  const parentPin = pinRealDirectory(parent, true);
  let fd = null;
  let tmpIdentity = null;
  try {
    fd = openSync(
      tmp,
      noFollowWriteFlags(),
      PRIVATE_RUNTIME_FILE_MODE
    );
    fchmodSync(fd, PRIVATE_RUNTIME_FILE_MODE);
    const created = fstatSync(fd);
    if (!created.isFile() || created.nlink !== 1) throw new Error("runtime \u4E34\u65F6\u6587\u4EF6\u8EAB\u4EFD\u4E0D\u5B89\u5168");
    tmpIdentity = { dev: created.dev, ino: created.ino };
    writeFileSync(fd, data);
    syncFd(fd, deps);
    const written = fstatSync(fd);
    if (!written.isFile() || written.nlink !== 1 || !sameIdentity(tmpIdentity, written)) {
      throw new Error("runtime \u4E34\u65F6\u6587\u4EF6\u8EAB\u4EFD\u4E0D\u5B89\u5168");
    }
    closeSync(fd);
    fd = null;
    verifyPinnedDirectory(parentPin, "runtime \u539F\u5B50\u5199\u63D0\u4EA4\u524D\u7236\u76EE\u5F55\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25");
    const tmpAtCommit = lstatSync(tmp);
    if (tmpAtCommit.isSymbolicLink() || !tmpAtCommit.isFile() || tmpAtCommit.nlink !== 1 || !sameIdentity(tmpIdentity, tmpAtCommit)) {
      throw new Error("runtime \u539F\u5B50\u5199\u63D0\u4EA4\u524D\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25");
    }
    renameSync(tmp, filePath);
    const published = lstatSync(filePath);
    const parentAfter = lstatSync(parent);
    if (published.isSymbolicLink() || !published.isFile() || published.nlink !== 1 || !sameIdentity(tmpIdentity, published) || parentAfter.isSymbolicLink() || !parentAfter.isDirectory() || !sameIdentity(parentPin.identity, parentAfter)) {
      throw new Error("runtime \u539F\u5B50\u5199\u53D1\u5E03\u540E\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25");
    }
    syncPinnedDirectory(parentPin, deps);
    const publishedAfterSync = lstatSync(filePath);
    if (publishedAfterSync.isSymbolicLink() || !publishedAfterSync.isFile() || publishedAfterSync.nlink !== 1 || !sameIdentity(tmpIdentity, publishedAfterSync)) {
      throw new Error("runtime \u539F\u5B50\u5199 fsync \u540E\u6587\u4EF6\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25");
    }
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
      }
      fd = null;
    }
    removePinnedLeafBestEffort(parentPin, tmp, tmpIdentity);
    throw error;
  } finally {
    closePinnedDirectory(parentPin);
  }
}
function createRuntimeFileExclusiveNoFollow(baseDir, filePath, data, deps) {
  ensureOwnedParent(baseDir, filePath, deps);
  const parent = dirname(filePath);
  const parentPin = pinRealDirectory(parent, true);
  let fd = null;
  let identity = null;
  try {
    verifyPinnedDirectory(parentPin, "runtime \u72EC\u5360\u521B\u5EFA\u524D\u7236\u76EE\u5F55\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25");
    fd = openSync(filePath, noFollowWriteFlags(), PRIVATE_RUNTIME_FILE_MODE);
    const created = fstatSync(fd);
    if (!created.isFile() || created.nlink !== 1) {
      throw new Error("runtime \u72EC\u5360\u521B\u5EFA\u6587\u4EF6\u8EAB\u4EFD\u4E0D\u5B89\u5168");
    }
    identity = { dev: created.dev, ino: created.ino };
    fchmodSync(fd, PRIVATE_RUNTIME_FILE_MODE);
    writeFileSync(fd, data);
    syncFd(fd, deps);
    const written = fstatSync(fd);
    const atPath = lstatSync(filePath);
    if (!written.isFile() || written.nlink !== 1 || !sameIdentity(identity, written) || atPath.isSymbolicLink() || !atPath.isFile() || atPath.nlink !== 1 || !sameIdentity(identity, atPath)) {
      throw new Error("runtime \u72EC\u5360\u521B\u5EFA\u6587\u4EF6\u5199\u5165\u540E\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25");
    }
    verifyPinnedDirectory(parentPin, "runtime \u72EC\u5360\u521B\u5EFA\u540E\u7236\u76EE\u5F55\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25");
    syncPinnedDirectory(parentPin, deps);
    const after = fstatSync(fd);
    const atPathAfterSync = lstatSync(filePath);
    if (!after.isFile() || after.nlink !== 1 || !sameIdentity(identity, after) || atPathAfterSync.isSymbolicLink() || !atPathAfterSync.isFile() || atPathAfterSync.nlink !== 1 || !sameIdentity(identity, atPathAfterSync)) {
      throw new Error("runtime \u72EC\u5360\u521B\u5EFA fsync \u540E\u6587\u4EF6\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25");
    }
  } finally {
    if (fd !== null) closeSync(fd);
    closePinnedDirectory(parentPin);
  }
}
function assertLeafMissing(filePath, message) {
  try {
    lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(message);
}
function removeRuntimeFileNoFollow(baseDir, filePath, deps) {
  inspectRealDirectory(baseDir, false);
  const root = runtimeRootPath(baseDir);
  let rootInfo;
  try {
    rootInfo = lstatSync(root);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("dsh-runtime \u6839\u76EE\u5F55\u4E0D\u5B89\u5168\uFF0C\u62D2\u7EDD\u5220\u9664\u79C1\u6709\u6587\u4EF6");
  }
  inspectRealDirectory(root, true);
  const parent = dirname(filePath);
  const rel = relative(root, parent);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("runtime \u79C1\u6709\u6587\u4EF6\u8D8A\u51FA\u53D7\u63A7\u6839\u76EE\u5F55");
  let parentPin;
  try {
    parentPin = pinRealDirectory(parent, true);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  try {
    let leaf;
    try {
      leaf = lstatSync(filePath);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.nlink !== 1) {
      throw new Error(`runtime \u79C1\u6709\u6587\u4EF6\u4E0D\u5B89\u5168\uFF0C\u62D2\u7EDD\u5220\u9664\uFF1A${basename2(filePath)}`);
    }
    if (deps?.expectedIdentity !== void 0 && !sameIdentity(leaf, deps.expectedIdentity)) {
      throw new Error(`runtime \u79C1\u6709\u6587\u4EF6\u8EAB\u4EFD\u5DF2\u66FF\u6362\uFF0C\u62D2\u7EDD\u5220\u9664\uFF1A${basename2(filePath)}`);
    }
    verifyPinnedDirectory(parentPin, "runtime \u79C1\u6709\u6587\u4EF6\u5220\u9664\u524D\u7236\u76EE\u5F55\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25");
    const leafAtCommit = lstatSync(filePath);
    if (leafAtCommit.isSymbolicLink() || !leafAtCommit.isFile() || leafAtCommit.nlink !== 1 || !sameIdentity(leaf, leafAtCommit) || deps?.expectedIdentity !== void 0 && !sameIdentity(leafAtCommit, deps.expectedIdentity)) {
      throw new Error(`runtime \u79C1\u6709\u6587\u4EF6\u5220\u9664\u63D0\u4EA4\u524D\u8EAB\u4EFD\u5DF2\u66FF\u6362\uFF1A${basename2(filePath)}`);
    }
    unlinkSync(filePath);
    assertLeafMissing(filePath, "runtime \u79C1\u6709\u6587\u4EF6\u5220\u9664\u540E\u4ECD\u5B58\u5728");
    verifyPinnedDirectory(parentPin, "runtime \u79C1\u6709\u6587\u4EF6\u5220\u9664\u540E\u7236\u76EE\u5F55\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25");
    syncPinnedDirectory(parentPin, deps);
    assertLeafMissing(filePath, "runtime \u79C1\u6709\u6587\u4EF6 fsync \u540E\u91CD\u65B0\u51FA\u73B0");
  } finally {
    closePinnedDirectory(parentPin);
  }
}
function sameLeafKind(left, right) {
  return left.isFile() === right.isFile() && left.isSymbolicLink() === right.isSymbolicLink() && left.isDirectory() === right.isDirectory();
}
function quarantineRuntimeFileNoFollow(baseDir, filePath, destinationPath, deps) {
  inspectRealDirectory(baseDir, false);
  const root = assertRuntimeRootNoFollow(baseDir);
  const parent = dirname(filePath);
  if (dirname(destinationPath) !== parent || destinationPath === filePath) {
    throw new Error("runtime \u9694\u79BB\u76EE\u6807\u5FC5\u987B\u662F\u540C\u4E00\u79C1\u6709\u76EE\u5F55\u4E2D\u7684\u4E0D\u540C\u6587\u4EF6");
  }
  const rel = relative(root, parent);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("runtime \u9694\u79BB\u6587\u4EF6\u8D8A\u51FA\u53D7\u63A7\u6839\u76EE\u5F55");
  }
  if (rel !== "") {
    let current = root;
    for (const segment of rel.split(sep)) {
      if (segment === "" || segment === "." || segment === ".." || basename2(segment) !== segment) {
        throw new Error("runtime \u9694\u79BB\u6587\u4EF6\u7236\u76EE\u5F55\u4E0D\u5B89\u5168");
      }
      current = join(current, segment);
      inspectRealDirectory(current, true);
    }
  }
  const parentPin = pinRealDirectory(parent, true);
  try {
    const source = lstatSync(filePath);
    if (source.isDirectory()) throw new Error(`runtime \u9694\u79BB\u6E90\u4E0D\u80FD\u662F\u76EE\u5F55\uFF1A${basename2(filePath)}`);
    if (deps?.expectedIdentity !== void 0 && !sameIdentity(source, deps.expectedIdentity)) {
      throw new Error(`runtime \u9694\u79BB\u6E90\u8EAB\u4EFD\u5DF2\u66FF\u6362\uFF1A${basename2(filePath)}`);
    }
    const identity = { dev: source.dev, ino: source.ino };
    assertLeafMissing(destinationPath, `runtime \u9694\u79BB\u76EE\u6807\u5DF2\u5B58\u5728\uFF1A${basename2(destinationPath)}`);
    verifyPinnedDirectory(parentPin, "runtime \u9694\u79BB\u63D0\u4EA4\u524D\u7236\u76EE\u5F55\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25");
    const sourceAtCommit = lstatSync(filePath);
    if (!sameIdentity(sourceAtCommit, identity) || !sameLeafKind(source, sourceAtCommit)) {
      throw new Error(`runtime \u9694\u79BB\u63D0\u4EA4\u524D\u6E90\u8EAB\u4EFD\u5DF2\u66FF\u6362\uFF1A${basename2(filePath)}`);
    }
    deps?.beforeRename?.();
    renameSync(filePath, destinationPath);
    assertLeafMissing(filePath, "runtime \u9694\u79BB\u63D0\u4EA4\u540E\u6E90\u6587\u4EF6\u4ECD\u5B58\u5728");
    const moved = lstatSync(destinationPath);
    if (!sameIdentity(moved, identity) || !sameLeafKind(source, moved)) {
      throw new Error("runtime \u9694\u79BB\u63D0\u4EA4\u540E\u8BC1\u636E\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25");
    }
    syncPinnedDirectory(parentPin, deps);
    assertLeafMissing(filePath, "runtime \u9694\u79BB fsync \u540E\u6E90\u6587\u4EF6\u91CD\u65B0\u51FA\u73B0");
    const movedAfterSync = lstatSync(destinationPath);
    if (!sameIdentity(movedAfterSync, identity) || !sameLeafKind(source, movedAfterSync)) {
      throw new Error("runtime \u9694\u79BB fsync \u540E\u8BC1\u636E\u8EAB\u4EFD\u590D\u9A8C\u5931\u8D25");
    }
    return identity;
  } finally {
    closePinnedDirectory(parentPin);
  }
}
function readPrivateFileNoFollow(filePath, maxBytes, options = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return { kind: "unsafe" };
  const parent = dirname(filePath);
  let parentBefore;
  try {
    parentBefore = inspectRealDirectory(parent, options.tightenMode !== false);
  } catch (error) {
    return error.code === "ENOENT" ? { kind: "missing" } : { kind: "unsafe" };
  }
  let leafBefore;
  try {
    leafBefore = lstatSync(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") return { kind: "unsafe" };
    try {
      const parentAfter = lstatSync(parent);
      return parentAfter.isDirectory() && !parentAfter.isSymbolicLink() && sameIdentity(parentBefore, parentAfter) ? { kind: "missing" } : { kind: "unsafe" };
    } catch {
      return { kind: "unsafe" };
    }
  }
  if (leafBefore.isSymbolicLink() || !leafBefore.isFile() || leafBefore.nlink !== 1 || leafBefore.size > maxBytes) {
    return { kind: "unsafe" };
  }
  let fd = null;
  try {
    fd = openSync(filePath, noFollowReadFlags());
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(leafBefore, opened) || opened.size > maxBytes) {
      return { kind: "unsafe" };
    }
    if (options.tightenMode !== false && (opened.mode & 511) !== PRIVATE_RUNTIME_FILE_MODE) {
      fchmodSync(fd, PRIVATE_RUNTIME_FILE_MODE);
    }
    const beforeRead = fstatSync(fd);
    const beforeReadPrecise = fstatSync(fd, { bigint: true });
    if (!beforeRead.isFile() || beforeRead.nlink !== 1 || beforeRead.size > maxBytes) {
      return { kind: "unsafe" };
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const read = options.read ?? readSync;
    let offset = 0;
    while (offset <= maxBytes) {
      const count = read(fd, buffer, offset, maxBytes + 1 - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maxBytes || offset !== beforeRead.size) return { kind: "unsafe" };
    const after = fstatSync(fd);
    const afterPrecise = fstatSync(fd, { bigint: true });
    const leafAfter = lstatSync(filePath);
    const parentAfter = lstatSync(parent);
    if (!sameFileSnapshot(beforeRead, after) || !samePreciseFileSnapshot(beforeReadPrecise, afterPrecise) || !sameIdentity(after, leafAfter) || parentAfter.isSymbolicLink() || !parentAfter.isDirectory() || !sameIdentity(parentBefore, parentAfter)) return { kind: "unsafe" };
    return {
      kind: "valid",
      raw: buffer.subarray(0, offset).toString("utf8"),
      identity: { dev: after.dev, ino: after.ino }
    };
  } catch {
    return { kind: "unsafe" };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}

// src/dsh-runtime-store.ts
var MAX_CURRENT_POINTER_BYTES = 16 * 1024;
var MAX_OVERRIDE_BYTES = 64 * 1024;
var MAX_ACTIVATION_JOURNAL_BYTES = 128 * 1024;
var PUBLISH_BACKUP_NAME = /^\.(.+)\.publish-backup-[0-9a-f]{8}$/;
var BUILTIN_ANCHOR_VERSION_TOKEN = "builtin-anchor";
function runtimeDirPath(baseDir) {
  return join2(baseDir, "dsh-runtime");
}
function atomicWriteJson(baseDir, filePath, payload) {
  atomicWriteRuntimeFileNoFollow(baseDir, filePath, `${JSON.stringify(payload, null, 2)}
`);
}
function sameIdentity2(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function readAuthorityMetadata(filePath, maxBytes) {
  return readPrivateFileNoFollow(filePath, maxBytes);
}
function hasCorruptOverrideSentinel(filePath) {
  const parent = dirname2(filePath);
  let parentBefore;
  try {
    parentBefore = lstatSync2(parent);
  } catch {
    return false;
  }
  if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) return false;
  try {
    lstatSync2(`${filePath}.corrupt`);
  } catch {
    return false;
  }
  try {
    const parentAfter = lstatSync2(parent);
    return parentAfter.isDirectory() && !parentAfter.isSymbolicLink() && sameIdentity2(parentBefore, parentAfter);
  } catch {
    return false;
  }
}
function preserveSafeCorruptAuthority(baseDir, filePath, expected) {
  try {
    const preferred = `${filePath}.corrupt`;
    const dest = existsSync(preferred) ? `${preferred}-${Date.now()}-${randomBytes2(3).toString("hex")}` : preferred;
    quarantineRuntimeFileNoFollow(baseDir, filePath, dest, { expectedIdentity: expected });
    return true;
  } catch (error) {
    console.error("[dsh-runtime-store] \u4FDD\u7559\u635F\u574F\u6587\u4EF6\u5931\u8D25\uFF1A", error);
    return false;
  }
}
function currentPointerPath(baseDir) {
  return join2(runtimeDirPath(baseDir), "current");
}
function readCurrentPointerState(baseDir) {
  const filePath = currentPointerPath(baseDir);
  const read = readAuthorityMetadata(filePath, MAX_CURRENT_POINTER_BYTES);
  if (read.kind === "missing") return { kind: "missing" };
  if (read.kind === "unsafe") return { kind: "corrupt" };
  try {
    const parsed = JSON.parse(read.raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "corrupt" };
    const version = parsed.version;
    return typeof version === "string" && isSafeVersion(version) ? { kind: "valid", version } : { kind: "corrupt" };
  } catch {
    return { kind: "corrupt" };
  }
}
function readCurrentPointer(baseDir) {
  const state = readCurrentPointerState(baseDir);
  return state.kind === "valid" ? state.version : null;
}
function writeCurrentPointer(baseDir, version) {
  atomicWriteJson(baseDir, currentPointerPath(baseDir), { version: assertSafeVersion(version) });
}
function clearCurrentPointer(baseDir) {
  removeRuntimeFileNoFollow(baseDir, currentPointerPath(baseDir));
}
function overridePath(baseDir) {
  return join2(runtimeDirPath(baseDir), "override.json");
}
function nullableString(record, field) {
  const value = record[field];
  return value === void 0 || value === null || typeof value === "string" ? value : void 0;
}
function parseOverrideRecord(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed;
  if (typeof record.shellVersion !== "string" || !isSafeVersion(record.shellVersion)) return null;
  if (!Object.prototype.hasOwnProperty.call(record, "chosenVersion") || !Object.prototype.hasOwnProperty.call(record, "resolvedVersion") || !Object.prototype.hasOwnProperty.call(record, "pending")) return null;
  const chosenVersion = nullableString(record, "chosenVersion");
  const resolvedVersion = nullableString(record, "resolvedVersion");
  const pending = nullableString(record, "pending");
  if (chosenVersion === void 0 || resolvedVersion === void 0 || pending === void 0) return null;
  if (typeof record.swapAttempted !== "boolean") return null;
  for (const version of [chosenVersion, resolvedVersion, pending]) {
    if (version !== null && !isSafeVersion(version)) return null;
  }
  const out = {
    shellVersion: record.shellVersion,
    chosenVersion,
    resolvedVersion,
    pending,
    swapAttempted: record.swapAttempted
  };
  if (record.selectedOnly !== void 0) {
    if (typeof record.selectedOnly !== "boolean") return null;
    out.selectedOnly = record.selectedOnly;
  }
  for (const field of [
    "invalidatedAt",
    "invalidatedReason",
    "lastInvalidatedAt",
    "lastInvalidatedReason",
    "lastInvalidatedFromVersion",
    "lastOutcome",
    "lastError"
  ]) {
    if (record[field] !== void 0) {
      if (record[field] !== null && typeof record[field] !== "string") return null;
      out[field] = record[field];
    }
  }
  if (record.lastInvalidationRecovered !== void 0) {
    if (record.lastInvalidationRecovered !== null && typeof record.lastInvalidationRecovered !== "boolean") return null;
    out.lastInvalidationRecovered = record.lastInvalidationRecovered;
  }
  if (record.restoreOutcome !== void 0) {
    if (record.restoreOutcome !== null && record.restoreOutcome !== "none" && record.restoreOutcome !== "complete" && record.restoreOutcome !== "half" && record.restoreOutcome !== "incomplete") return null;
    out.restoreOutcome = record.restoreOutcome;
  }
  return out;
}
function readOverrideState(baseDir) {
  const filePath = overridePath(baseDir);
  const read = readAuthorityMetadata(filePath, MAX_OVERRIDE_BYTES);
  if (read.kind === "missing") {
    return hasCorruptOverrideSentinel(filePath) ? { kind: "corrupt" } : { kind: "missing" };
  }
  if (read.kind === "unsafe") return { kind: "corrupt" };
  let parsed;
  try {
    parsed = JSON.parse(read.raw);
  } catch {
    preserveSafeCorruptAuthority(baseDir, filePath, read.identity);
    return { kind: "corrupt" };
  }
  const record = parseOverrideRecord(parsed);
  if (record === null) {
    preserveSafeCorruptAuthority(baseDir, filePath, read.identity);
    return { kind: "corrupt" };
  }
  return { kind: "valid", record };
}
function readOverride(baseDir) {
  const state = readOverrideState(baseDir);
  return state.kind === "valid" ? state.record : null;
}
function assertOptionalText(value, field) {
  if (value === void 0 || value === null) return;
  if (typeof value !== "string" || value.length > 4e3 || /[\u0000]/.test(value)) {
    throw new Error(`override.${field} \u5FC5\u987B\u662F\u81F3\u591A 4000 \u5B57\u7B26\u4E14\u4E0D\u542B NUL \u7684\u5B57\u7B26\u4E32\u6216 null`);
  }
}
function writeOverride(baseDir, record) {
  if (typeof record.shellVersion !== "string" || !isSafeVersion(record.shellVersion)) {
    throw new Error(`override.shellVersion \u5FC5\u987B\u662F\u7CBE\u786E semver\uFF0C\u6536\u5230 ${JSON.stringify(record.shellVersion)}`);
  }
  for (const [, version] of [
    ["chosenVersion", record.chosenVersion],
    ["resolvedVersion", record.resolvedVersion],
    ["pending", record.pending]
  ]) {
    if (version !== null) assertSafeVersion(version);
  }
  if (typeof record.swapAttempted !== "boolean") throw new Error("override.swapAttempted \u5FC5\u987B\u662F boolean");
  if (record.selectedOnly !== void 0 && typeof record.selectedOnly !== "boolean") {
    throw new Error("override.selectedOnly \u5FC5\u987B\u662F boolean");
  }
  assertOptionalText(record.invalidatedAt, "invalidatedAt");
  assertOptionalText(record.invalidatedReason, "invalidatedReason");
  assertOptionalText(record.lastInvalidatedAt, "lastInvalidatedAt");
  assertOptionalText(record.lastInvalidatedReason, "lastInvalidatedReason");
  assertOptionalText(record.lastInvalidatedFromVersion, "lastInvalidatedFromVersion");
  if (record.lastInvalidatedFromVersion != null) assertSafeVersion(record.lastInvalidatedFromVersion);
  if (record.lastInvalidationRecovered !== void 0 && record.lastInvalidationRecovered !== null && typeof record.lastInvalidationRecovered !== "boolean") {
    throw new Error("override.lastInvalidationRecovered \u5FC5\u987B\u662F boolean \u6216 null");
  }
  assertOptionalText(record.lastOutcome, "lastOutcome");
  assertOptionalText(record.lastError, "lastError");
  if (record.restoreOutcome !== void 0 && record.restoreOutcome !== null && !["none", "complete", "half", "incomplete"].includes(record.restoreOutcome)) {
    throw new Error("override.restoreOutcome \u975E\u6CD5");
  }
  const payload = {
    shellVersion: record.shellVersion,
    chosenVersion: record.chosenVersion,
    resolvedVersion: record.resolvedVersion,
    pending: record.pending,
    swapAttempted: record.swapAttempted
  };
  if (record.selectedOnly !== void 0) payload.selectedOnly = record.selectedOnly;
  for (const field of [
    "invalidatedAt",
    "invalidatedReason",
    "lastInvalidatedAt",
    "lastInvalidatedReason",
    "lastInvalidatedFromVersion",
    "lastInvalidationRecovered",
    "lastOutcome",
    "lastError",
    "restoreOutcome"
  ]) {
    if (record[field] !== void 0) payload[field] = record[field];
  }
  atomicWriteJson(baseDir, overridePath(baseDir), payload);
}
function deleteOverride(baseDir) {
  removeRuntimeFileNoFollow(baseDir, overridePath(baseDir));
}
function activationJournalPath(baseDir) {
  return join2(runtimeDirPath(baseDir), "activation-journal.json");
}
function isActivationJournalPhase(value) {
  return value === "intent" || value === "prepared" || value === "switched" || value === "manual-restoring" || value === "manual-restored" || value === "rollback-needed" || value === "restoring" || value === "restore-complete" || value === "fallback-builtin" || value === "applied-monitoring";
}
function isIsoTimestamp(value) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}
function isSafeStoredBasename(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 255 && basename3(value) === value && value !== "." && value !== ".." && !value.includes("\0");
}
function parseNullableSafeVersion(value) {
  if (value === null) return null;
  return typeof value === "string" && isSafeVersion(value) ? value : void 0;
}
function parseNullableSnapshotName(value) {
  if (value === null) return null;
  if (!isSafeStoredBasename(value)) return void 0;
  const separator = value.lastIndexOf("-");
  if (separator <= 0) return void 0;
  const version = value.slice(0, separator);
  const timestamp = value.slice(separator + 1);
  return isSafeVersion(version) && /^\d+$/.test(timestamp) ? value : void 0;
}
function parseNullablePreRollbackName(value) {
  if (value === null) return null;
  return isSafeStoredBasename(value) && /^\d{13}-[0-9a-f]{8}$/.test(value) ? value : void 0;
}
function parseJournalIntent(value) {
  if (value === null) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const record = value;
  if (typeof record.targetIsBuiltin !== "boolean" || typeof record.manualRollback !== "boolean") return void 0;
  if (typeof record.targetVersion !== "string" || !(record.targetIsBuiltin && record.targetVersion === BUILTIN_ANCHOR_VERSION_TOKEN) && !isSafeVersion(record.targetVersion)) return void 0;
  const intentKind = parseIntentKind(record.intentKind);
  if (intentKind === null || !validIntentShape(intentKind, record.targetIsBuiltin, record.manualRollback)) return void 0;
  return {
    targetVersion: record.targetVersion,
    targetIsBuiltin: record.targetIsBuiltin,
    manualRollback: record.manualRollback,
    intentKind
  };
}
function parseIntentKind(value) {
  if (value === void 0) return "version-switch";
  return value === "version-switch" || value === "reset-builtin" || value === "shell-invalidation" ? value : null;
}
function validIntentShape(kind, targetIsBuiltin, manualRollback) {
  if (kind === "version-switch") return !targetIsBuiltin;
  return targetIsBuiltin && !manualRollback;
}
function parseActivationJournal(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed;
  if (record.schemaVersion !== 1 || !isActivationJournalPhase(record.phase)) return null;
  if (typeof record.targetIsBuiltin !== "boolean") return null;
  if (typeof record.targetVersion !== "string" || !(record.targetIsBuiltin && record.targetVersion === BUILTIN_ANCHOR_VERSION_TOKEN) && !isSafeVersion(record.targetVersion)) return null;
  if (typeof record.manualRollback !== "boolean") return null;
  const intentKind = parseIntentKind(record.intentKind);
  if (intentKind === null || !validIntentShape(intentKind, record.targetIsBuiltin, record.manualRollback)) return null;
  const sourceVersion = parseNullableSafeVersion(record.sourceVersion);
  const knownGoodVersion = parseNullableSafeVersion(record.knownGoodVersion);
  const rollbackTarget2 = parseNullableSafeVersion(record.rollbackTarget);
  const preSwapSnapshotName = parseNullableSnapshotName(record.preSwapSnapshotName);
  const manualDataSnapshotName = parseNullableSnapshotName(record.manualDataSnapshotName);
  const preRollbackStashName = parseNullablePreRollbackName(record.preRollbackStashName);
  const nextIntent = parseJournalIntent(record.nextIntent);
  if (sourceVersion === void 0 || knownGoodVersion === void 0 || rollbackTarget2 === void 0) return null;
  if (preSwapSnapshotName === void 0 || manualDataSnapshotName === void 0 || preRollbackStashName === void 0) return null;
  if (nextIntent === void 0) return null;
  if (!isIsoTimestamp(record.startedAt) || !isIsoTimestamp(record.updatedAt)) return null;
  if (record.phase === "intent") {
    if (record.sourceIsBuiltin !== null || record.sourceWasKnownGood !== null) return null;
    if (sourceVersion !== null || preSwapSnapshotName !== null || manualDataSnapshotName !== null || preRollbackStashName !== null) return null;
    if (knownGoodVersion !== null || rollbackTarget2 !== null) return null;
  } else {
    if (typeof record.sourceIsBuiltin !== "boolean" || typeof record.sourceWasKnownGood !== "boolean") return null;
    if (sourceVersion === null || preSwapSnapshotName === null) return null;
    if (record.manualRollback) {
      if (manualDataSnapshotName === null !== (preRollbackStashName === null)) return null;
    } else if (manualDataSnapshotName !== null || preRollbackStashName !== null) {
      return null;
    }
  }
  return {
    schemaVersion: 1,
    phase: record.phase,
    targetVersion: record.targetVersion,
    targetIsBuiltin: record.targetIsBuiltin,
    manualRollback: record.manualRollback,
    intentKind,
    sourceVersion,
    sourceIsBuiltin: record.sourceIsBuiltin,
    sourceWasKnownGood: record.sourceWasKnownGood,
    knownGoodVersion,
    preSwapSnapshotName,
    manualDataSnapshotName,
    preRollbackStashName,
    rollbackTarget: rollbackTarget2,
    nextIntent,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt
  };
}
function readActivationJournalState(baseDir) {
  const filePath = activationJournalPath(baseDir);
  const read = readAuthorityMetadata(filePath, MAX_ACTIVATION_JOURNAL_BYTES);
  if (read.kind === "missing") return { kind: "missing" };
  if (read.kind === "unsafe") return { kind: "corrupt" };
  try {
    const journal = parseActivationJournal(JSON.parse(read.raw));
    return journal === null ? { kind: "corrupt" } : { kind: "valid", journal };
  } catch {
    return { kind: "corrupt" };
  }
}
function writeActivationJournal(baseDir, journal) {
  const parsed = parseActivationJournal(journal);
  if (parsed === null) throw new Error("activation journal \u5F62\u72B6\u65E0\u6548");
  atomicWriteJson(baseDir, activationJournalPath(baseDir), parsed);
}
function writeActivationIntent(baseDir, input, now = /* @__PURE__ */ new Date()) {
  const targetVersion = input.targetIsBuiltin ? input.targetVersion === BUILTIN_ANCHOR_VERSION_TOKEN ? input.targetVersion : assertSafeVersion(input.targetVersion) : assertSafeVersion(input.targetVersion);
  const targetIsBuiltin = input.targetIsBuiltin ?? false;
  if (typeof targetIsBuiltin !== "boolean") throw new Error("targetIsBuiltin \u5FC5\u987B\u662F boolean");
  if (typeof input.manualRollback !== "boolean") throw new Error("manualRollback \u5FC5\u987B\u662F boolean");
  if (input.intentKind !== "version-switch" && input.intentKind !== "reset-builtin" && input.intentKind !== "shell-invalidation") {
    throw new Error("intentKind \u975E\u6CD5");
  }
  if (!validIntentShape(input.intentKind, targetIsBuiltin, input.manualRollback)) {
    throw new Error("activation intent kind/target/manualRollback \u7EC4\u5408\u65E0\u6548");
  }
  if (Number.isNaN(now.getTime())) throw new Error("activation intent \u65F6\u95F4\u6233\u65E0\u6548");
  const existing = readActivationJournalState(baseDir);
  if (existing.kind === "corrupt") throw new Error("activation journal \u635F\u574F\uFF1B\u62D2\u7EDD\u8986\u76D6\u6062\u590D\u8BC1\u636E");
  if (existing.kind === "valid" && existing.journal.phase === "applied-monitoring") {
    if (existing.journal.nextIntent !== null) {
      const queued = existing.journal.nextIntent;
      if (queued.targetVersion !== targetVersion || queued.targetIsBuiltin !== targetIsBuiltin || queued.manualRollback !== input.manualRollback || queued.intentKind !== input.intentKind) {
        throw new Error("\u5DF2\u6709 queued activation intent\uFF0C\u62D2\u7EDD\u8986\u76D6\u7528\u6237\u9009\u62E9");
      }
      return existing.journal;
    }
    const journal2 = {
      ...existing.journal,
      nextIntent: { targetVersion, targetIsBuiltin, manualRollback: input.manualRollback, intentKind: input.intentKind },
      updatedAt: now.toISOString()
    };
    writeActivationJournal(baseDir, journal2);
    return journal2;
  }
  if (existing.kind === "valid" && existing.journal.phase !== "intent") {
    throw new Error("\u5DF2\u6709\u8FD0\u884C\u65F6\u6FC0\u6D3B\u4E8B\u52A1\uFF0C\u62D2\u7EDD\u8986\u76D6");
  }
  const timestamp = now.toISOString();
  const journal = {
    schemaVersion: 1,
    phase: "intent",
    targetVersion,
    targetIsBuiltin,
    manualRollback: input.manualRollback,
    intentKind: input.intentKind,
    sourceVersion: null,
    sourceIsBuiltin: null,
    sourceWasKnownGood: null,
    knownGoodVersion: null,
    preSwapSnapshotName: null,
    manualDataSnapshotName: null,
    preRollbackStashName: null,
    rollbackTarget: null,
    nextIntent: null,
    startedAt: timestamp,
    updatedAt: timestamp
  };
  writeActivationJournal(baseDir, journal);
  return journal;
}
function queueActivationIntent(baseDir, input, now = /* @__PURE__ */ new Date()) {
  const targetVersion = input.targetIsBuiltin ? input.targetVersion === BUILTIN_ANCHOR_VERSION_TOKEN ? input.targetVersion : assertSafeVersion(input.targetVersion) : assertSafeVersion(input.targetVersion);
  const targetIsBuiltin = input.targetIsBuiltin ?? false;
  if (typeof targetIsBuiltin !== "boolean" || typeof input.manualRollback !== "boolean") {
    throw new Error("queued activation intent \u5F62\u72B6\u65E0\u6548");
  }
  if (input.intentKind !== "version-switch" && input.intentKind !== "reset-builtin" && input.intentKind !== "shell-invalidation") throw new Error("queued activation intent kind \u975E\u6CD5");
  if (!validIntentShape(input.intentKind, targetIsBuiltin, input.manualRollback)) {
    throw new Error("queued activation intent kind/target/manualRollback \u7EC4\u5408\u65E0\u6548");
  }
  if (Number.isNaN(now.getTime())) throw new Error("queued activation intent \u65F6\u95F4\u6233\u65E0\u6548");
  const existing = readActivationJournalState(baseDir);
  if (existing.kind !== "valid") throw new Error("\u6CA1\u6709\u53EF\u5B89\u5168\u6392\u961F\u7684\u8FD0\u884C\u65F6\u6FC0\u6D3B\u4E8B\u52A1");
  const queued = {
    targetVersion,
    targetIsBuiltin,
    manualRollback: input.manualRollback,
    intentKind: input.intentKind
  };
  if (existing.journal.nextIntent !== null) {
    const current = existing.journal.nextIntent;
    if (current.targetVersion === queued.targetVersion && current.targetIsBuiltin === queued.targetIsBuiltin && current.manualRollback === queued.manualRollback && current.intentKind === queued.intentKind) return existing.journal;
    throw new Error("\u5DF2\u6709 queued activation intent\uFF0C\u62D2\u7EDD\u8986\u76D6\u7528\u6237\u9009\u62E9");
  }
  const journal = {
    ...existing.journal,
    nextIntent: queued,
    updatedAt: now.toISOString()
  };
  writeActivationJournal(baseDir, journal);
  return journal;
}
function clearActivationJournal(baseDir) {
  removeRuntimeFileNoFollow(baseDir, activationJournalPath(baseDir));
}
function listVersionTrees(baseDir) {
  let entries;
  try {
    entries = readdirSync(runtimeDirPath(baseDir), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && EXACT_SEMVER.test(entry.name)).map((entry) => entry.name).sort();
}
var CRITICAL_RUNTIME_FILES = [
  "node_modules/@deepseek-ai/dsh/package.json",
  "node_modules/@deepseek-ai/dsh/lib/bin.js"
];
function validateCriticalRuntimeFiles(treePath, version, dshManifest) {
  const critical = dshManifest.criticalFiles;
  if (critical === null || typeof critical !== "object" || Array.isArray(critical)) {
    return "\u7248\u672C\u6811\u7F3A\u5C11\u5173\u952E\u6587\u4EF6\u6458\u8981";
  }
  let rootReal;
  try {
    rootReal = realpathSync(treePath);
  } catch {
    return "\u7248\u672C\u6811\u771F\u5B9E\u8DEF\u5F84\u4E0D\u53EF\u89E3\u6790";
  }
  for (const relativePath of CRITICAL_RUNTIME_FILES) {
    const expected = critical[relativePath];
    if (typeof expected !== "string" || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(expected)) {
      return `\u7248\u672C\u6811\u5173\u952E\u6587\u4EF6\u6458\u8981\u65E0\u6548\uFF1A${relativePath}`;
    }
    const candidate = join2(treePath, relativePath);
    try {
      const info = lstatSync2(candidate);
      if (!info.isFile() || info.isSymbolicLink()) return `\u7248\u672C\u6811\u5173\u952E\u6587\u4EF6\u4E0D\u662F\u5B9E\u4F53\u6587\u4EF6\uFF1A${relativePath}`;
      const candidateReal = realpathSync(candidate);
      const fromRoot = relative2(rootReal, candidateReal);
      if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
        return `\u7248\u672C\u6811\u5173\u952E\u6587\u4EF6\u9003\u9038\u76EE\u5F55\uFF1A${relativePath}`;
      }
      const actual = `sha256-${createHash("sha256").update(readFileSync(candidate)).digest("base64")}`;
      if (actual !== expected) return `\u7248\u672C\u6811\u5173\u952E\u6587\u4EF6\u6458\u8981\u4E0D\u5339\u914D\uFF1A${relativePath}`;
    } catch {
      return `\u7248\u672C\u6811\u5173\u952E\u6587\u4EF6\u7F3A\u5931\u6216\u4E0D\u53EF\u8BFB\uFF1A${relativePath}`;
    }
  }
  try {
    const packageManifest = JSON.parse(readFileSync(join2(treePath, CRITICAL_RUNTIME_FILES[0]), "utf8"));
    if (packageManifest === null || typeof packageManifest !== "object" || Array.isArray(packageManifest)) {
      return "\u7248\u672C\u6811 dsh package manifest \u5F62\u72B6\u65E0\u6548";
    }
    const pkg = packageManifest;
    if (pkg.name !== "@deepseek-ai/dsh" || pkg.version !== version) return "\u7248\u672C\u6811 dsh package \u8EAB\u4EFD\u4E0D\u5339\u914D";
  } catch {
    return "\u7248\u672C\u6811 dsh package manifest \u65E0\u6548";
  }
  return null;
}
function validateVersionTree(baseDir, version, platform = `${process.platform}-${process.arch}`) {
  if (!isSafeVersion(version)) return { ok: false, error: "\u7248\u672C\u53F7\u4E0D\u662F\u5B89\u5168\u7684\u7CBE\u786E semver" };
  const treePath = join2(runtimeDirPath(baseDir), version);
  try {
    if (!lstatSync2(treePath).isDirectory()) return { ok: false, error: "\u7248\u672C\u6811\u4E0D\u5B58\u5728\u6216\u4E0D\u662F\u5B9E\u4F53\u76EE\u5F55" };
  } catch {
    return { ok: false, error: "\u7248\u672C\u6811\u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u8BFB" };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join2(treePath, "package.json"), "utf8"));
  } catch {
    return { ok: false, error: "\u7248\u672C\u6811 package.json \u7F3A\u5931\u6216\u635F\u574F" };
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return { ok: false, error: "\u7248\u672C\u6811 manifest \u5F62\u72B6\u65E0\u6548" };
  const root = manifest;
  const dependencies = root.dependencies;
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies) || dependencies["@deepseek-ai/dsh"] !== version) {
    return { ok: false, error: `\u7248\u672C\u6811 manifest \u672A\u7CBE\u786E\u9489\u4F4F @deepseek-ai/dsh@${version}` };
  }
  const dsh = root.dsh;
  if (dsh === null || typeof dsh !== "object" || Array.isArray(dsh) || dsh.platform !== platform) {
    return { ok: false, error: `\u7248\u672C\u6811\u5E73\u53F0\u4E0D\u5339\u914D\uFF08\u9700\u8981 ${platform}\uFF09` };
  }
  const criticalError = validateCriticalRuntimeFiles(treePath, version, dsh);
  if (criticalError !== null) return { ok: false, error: criticalError };
  return { ok: true, path: treePath };
}
function listValidVersionTrees(baseDir, platform = `${process.platform}-${process.arch}`) {
  return listVersionTrees(baseDir).filter((version) => validateVersionTree(baseDir, version, platform).ok);
}
function explicitInstallsPath(baseDir) {
  return join2(runtimeDirPath(baseDir), "explicit-installs.json");
}
function readVersionTimestampMap(filePath) {
  const read = readAuthorityMetadata(filePath, 256 * 1024);
  if (read.kind === "missing") return { kind: "missing", versions: {} };
  if (read.kind === "unsafe") return { kind: "corrupt", versions: {} };
  try {
    const parsed = JSON.parse(read.raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "corrupt", versions: {}, identity: read.identity };
    }
    const versions = parsed.versions;
    if (versions === null || typeof versions !== "object" || Array.isArray(versions)) {
      return { kind: "corrupt", versions: {}, identity: read.identity };
    }
    const out = {};
    for (const [version, timestamp] of Object.entries(versions)) {
      if (!isSafeVersion(version) || typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
        return { kind: "corrupt", versions: {}, identity: read.identity };
      }
      out[version] = timestamp;
    }
    return { kind: "valid", versions: out };
  } catch {
    return { kind: "corrupt", versions: {}, identity: read.identity };
  }
}
function quarantineCorruptTimestampMap(baseDir, filePath, state) {
  if (state.kind !== "corrupt") return;
  if (state.identity === void 0 || !preserveSafeCorruptAuthority(baseDir, filePath, state.identity)) {
    throw new Error(`runtime \u7248\u672C\u4FDD\u7559\u5143\u6570\u636E\u4E0D\u5B89\u5168\uFF0C\u62D2\u7EDD\u8986\u76D6\uFF1A${basename3(filePath)}`);
  }
}
function seedExplicitInstalls(baseDir, state) {
  if (state.kind === "valid") return { ...state.versions };
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  return Object.fromEntries(listVersionTrees(baseDir).map((version) => [version, timestamp]));
}
function listExplicitlyInstalledVersions(baseDir) {
  const state = readVersionTimestampMap(explicitInstallsPath(baseDir));
  return Object.keys(seedExplicitInstalls(baseDir, state)).sort();
}
function recordExplicitInstall(baseDir, version, now = /* @__PURE__ */ new Date(), platform = `${process.platform}-${process.arch}`) {
  ensureRuntimeRootNoFollow(baseDir);
  const safe = assertSafeVersion(version);
  const validation = validateVersionTree(baseDir, safe, platform);
  if (!validation.ok) throw new Error(`\u4E0D\u80FD\u4FDD\u7559\u65E0\u6548\u8FD0\u884C\u65F6\u5B89\u88C5\uFF1A${validation.error}`);
  if (Number.isNaN(now.getTime())) throw new Error("\u663E\u5F0F\u5B89\u88C5\u65F6\u95F4\u6233\u65E0\u6548");
  const filePath = explicitInstallsPath(baseDir);
  const state = readVersionTimestampMap(filePath);
  quarantineCorruptTimestampMap(baseDir, filePath, state);
  const versions = seedExplicitInstalls(baseDir, state);
  versions[safe] = now.toISOString();
  atomicWriteJson(baseDir, filePath, { versions });
}
function forgetExplicitInstall(baseDir, version) {
  ensureRuntimeRootNoFollow(baseDir);
  const safe = assertSafeVersion(version);
  const filePath = explicitInstallsPath(baseDir);
  const state = readVersionTimestampMap(filePath);
  quarantineCorruptTimestampMap(baseDir, filePath, state);
  const versions = seedExplicitInstalls(baseDir, state);
  delete versions[safe];
  atomicWriteJson(baseDir, filePath, { versions });
}
function isExplicitInstall(baseDir, version) {
  const state = readVersionTimestampMap(explicitInstallsPath(baseDir));
  if (state.kind !== "valid") return listVersionTrees(baseDir).includes(version);
  return Object.prototype.hasOwnProperty.call(state.versions, version);
}
function knownGoodPath(baseDir) {
  return join2(runtimeDirPath(baseDir), "known-good.json");
}
function listKnownGoodVersions(baseDir) {
  const state = readVersionTimestampMap(knownGoodPath(baseDir));
  if (state.kind !== "valid") return [];
  return Object.entries(state.versions).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).map(([version]) => version);
}
function latestKnownGood(baseDir, excludeVersion = null, platform = `${process.platform}-${process.arch}`) {
  return listKnownGoodVersions(baseDir).find((version) => version !== excludeVersion && validateVersionTree(baseDir, version, platform).ok) ?? null;
}
function markKnownGood(baseDir, version, now = /* @__PURE__ */ new Date(), platform = `${process.platform}-${process.arch}`) {
  ensureRuntimeRootNoFollow(baseDir);
  const safe = assertSafeVersion(version);
  const validation = validateVersionTree(baseDir, safe, platform);
  if (!validation.ok) throw new Error(`\u4E0D\u80FD\u6807\u8BB0\u65E0\u6548\u8FD0\u884C\u65F6\u4E3A known-good\uFF1A${validation.error}`);
  if (Number.isNaN(now.getTime())) throw new Error("known-good \u65F6\u95F4\u6233\u65E0\u6548");
  const filePath = knownGoodPath(baseDir);
  const state = readVersionTimestampMap(filePath);
  quarantineCorruptTimestampMap(baseDir, filePath, state);
  const versions = state.kind === "valid" ? { ...state.versions } : {};
  versions[safe] = now.toISOString();
  atomicWriteJson(baseDir, filePath, { versions });
}
function forgetKnownGood(baseDir, version) {
  ensureRuntimeRootNoFollow(baseDir);
  const safe = assertSafeVersion(version);
  const filePath = knownGoodPath(baseDir);
  const state = readVersionTimestampMap(filePath);
  if (state.kind !== "valid") return;
  const versions = { ...state.versions };
  delete versions[safe];
  atomicWriteJson(baseDir, filePath, { versions });
}
function failurePath(baseDir, version) {
  return join2(runtimeDirPath(baseDir), "failures", `${assertSafeVersion(version)}.json`);
}
function validFailurePhase(phase) {
  return /^[a-z][a-z0-9-]{0,63}$/.test(phase);
}
function parseFailureRecord(parsed, expectedVersion) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed;
  if (typeof record.version !== "string" || !isSafeVersion(record.version) || expectedVersion !== void 0 && record.version !== expectedVersion) return null;
  if (typeof record.phase !== "string" || !validFailurePhase(record.phase)) return null;
  if (typeof record.firstFailedAt !== "string" || Number.isNaN(Date.parse(record.firstFailedAt))) return null;
  if (typeof record.lastFailedAt !== "string" || Number.isNaN(Date.parse(record.lastFailedAt))) return null;
  if (typeof record.occurrences !== "number" || !Number.isInteger(record.occurrences) || record.occurrences < 1) return null;
  if (typeof record.error !== "string") return null;
  if (record.restoreOutcome !== null && record.restoreOutcome !== "none" && record.restoreOutcome !== "complete" && record.restoreOutcome !== "half" && record.restoreOutcome !== "incomplete") return null;
  const snapshotName = parseNullableSnapshotName(record.snapshotName);
  if (snapshotName === void 0) return null;
  return {
    version: record.version,
    phase: record.phase,
    firstFailedAt: record.firstFailedAt,
    lastFailedAt: record.lastFailedAt,
    occurrences: record.occurrences,
    error: record.error,
    restoreOutcome: record.restoreOutcome,
    snapshotName
  };
}
function readRuntimeFailureState(baseDir, version) {
  const safe = assertSafeVersion(version);
  const filePath = failurePath(baseDir, safe);
  const read = readAuthorityMetadata(filePath, 64 * 1024);
  if (read.kind === "missing" || read.kind === "unsafe") return { kind: read.kind };
  let parsed;
  try {
    parsed = JSON.parse(read.raw);
  } catch {
    parsed = null;
  }
  const record = parseFailureRecord(parsed, safe);
  return record === null ? { kind: "corrupt", identity: read.identity } : { kind: "valid", record };
}
function readRuntimeFailure(baseDir, version) {
  const safe = assertSafeVersion(version);
  const state = readRuntimeFailureState(baseDir, safe);
  if (state.kind === "corrupt") {
    preserveSafeCorruptAuthority(baseDir, failurePath(baseDir, safe), state.identity);
    return null;
  }
  return state.kind === "valid" ? state.record : null;
}
function recordRuntimeFailure(baseDir, input, now = /* @__PURE__ */ new Date()) {
  ensureRuntimeRootNoFollow(baseDir);
  const version = assertSafeVersion(input.version);
  if (!validFailurePhase(input.phase)) throw new Error("failure.phase \u5FC5\u987B\u662F\u5B89\u5168\u7684\u77ED\u6A2A\u7EBF\u6807\u8BC6\u7B26");
  const filePath = failurePath(baseDir, version);
  const previousState = readRuntimeFailureState(baseDir, version);
  if (previousState.kind === "unsafe") {
    throw new Error(`runtime failure \u5143\u6570\u636E\u4E0D\u5B89\u5168\uFF0C\u62D2\u7EDD\u8986\u76D6\uFF1A${basename3(filePath)}`);
  }
  if (previousState.kind === "corrupt" && !preserveSafeCorruptAuthority(baseDir, filePath, previousState.identity)) {
    throw new Error(`runtime failure \u635F\u574F\u5143\u6570\u636E\u65E0\u6CD5\u5B89\u5168\u9694\u79BB\uFF0C\u62D2\u7EDD\u8986\u76D6\uFF1A${basename3(filePath)}`);
  }
  const previous = previousState.kind === "valid" ? previousState.record : null;
  const timestamp = now.toISOString();
  const record = {
    version,
    phase: input.phase,
    firstFailedAt: previous?.firstFailedAt ?? timestamp,
    lastFailedAt: timestamp,
    occurrences: (previous?.occurrences ?? 0) + 1,
    error: sanitizeErrorText(input.error instanceof Error ? input.error.message : String(input.error)).slice(0, 2e3),
    restoreOutcome: input.restoreOutcome ?? null,
    snapshotName: input.snapshotPath ? basename3(input.snapshotPath) : null
  };
  atomicWriteJson(baseDir, filePath, record);
  return record;
}
function listRuntimeFailures(baseDir) {
  const dir = join2(runtimeDirPath(baseDir), "failures");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const version = entry.name.slice(0, -".json".length);
    if (!isSafeVersion(version)) continue;
    const record = readRuntimeFailure(baseDir, version);
    if (record !== null) records.push(record);
  }
  return records.sort((a, b) => Date.parse(b.lastFailedAt) - Date.parse(a.lastFailedAt));
}
function runtimeFailureSummary(baseDir) {
  const failures = listRuntimeFailures(baseDir);
  return { count: failures.length, latest: failures[0] ?? null };
}
function runtimeSnapshotRetentionState(baseDir) {
  const pointer = readCurrentPointerState(baseDir);
  const override = readOverrideState(baseDir);
  const activation = readActivationJournalState(baseDir);
  const knownGood = readVersionTimestampMap(knownGoodPath(baseDir));
  if (pointer.kind === "corrupt" || override.kind === "corrupt" || activation.kind === "corrupt" || knownGood.kind === "corrupt") return { kind: "corrupt" };
  const protectedVersions = /* @__PURE__ */ new Set();
  const protectedSnapshotNames = /* @__PURE__ */ new Set();
  if (pointer.kind === "valid") protectedVersions.add(pointer.version);
  if (override.kind === "valid") {
    for (const version of [override.record.chosenVersion, override.record.resolvedVersion, override.record.pending]) {
      if (version !== null) protectedVersions.add(version);
    }
  }
  if (knownGood.kind === "valid") {
    for (const version of Object.keys(knownGood.versions)) protectedVersions.add(version);
  }
  if (activation.kind === "valid") {
    const journal = activation.journal;
    for (const version of [
      journal.targetVersion,
      journal.sourceVersion,
      journal.rollbackTarget,
      journal.knownGoodVersion,
      journal.nextIntent?.targetVersion ?? null
    ]) {
      if (version !== null) protectedVersions.add(version);
    }
    for (const name of [journal.preSwapSnapshotName, journal.manualDataSnapshotName]) {
      if (name !== null) protectedSnapshotNames.add(name);
    }
  }
  const failureDir = join2(runtimeDirPath(baseDir), "failures");
  let failureEntries = [];
  try {
    failureEntries = readdirSync(failureDir);
  } catch (error) {
    if (error.code !== "ENOENT") return { kind: "corrupt" };
  }
  if (failureEntries.some((name) => name.includes(".json.corrupt"))) return { kind: "corrupt" };
  for (const name of failureEntries) {
    if (!name.endsWith(".json")) continue;
    const version = name.slice(0, -".json".length);
    if (!isSafeVersion(version)) return { kind: "corrupt" };
    const failure = readRuntimeFailure(baseDir, version);
    if (failure === null) return { kind: "corrupt" };
    protectedVersions.add(failure.version);
    if (failure.snapshotName !== null) protectedSnapshotNames.add(failure.snapshotName);
  }
  return {
    kind: "valid",
    protectedVersions: [...protectedVersions].sort(),
    protectedSnapshotNames: [...protectedSnapshotNames].sort()
  };
}
function clearRuntimeFailure(baseDir, version) {
  removeRuntimeFileNoFollow(baseDir, failurePath(baseDir, version));
}
function isKnownGoodProtected(baseDir, version) {
  const state = readVersionTimestampMap(knownGoodPath(baseDir));
  return state.kind === "corrupt" || state.kind === "valid" && Object.prototype.hasOwnProperty.call(state.versions, version);
}
function isKnownGoodCandidateProtected(baseDir, version) {
  const filePath = join2(runtimeDirPath(baseDir), "known-good-candidates.json");
  const read = readAuthorityMetadata(filePath, 256 * 1024);
  if (read.kind === "missing") return false;
  if (read.kind === "unsafe") return true;
  let parsed;
  try {
    parsed = JSON.parse(read.raw);
  } catch {
    return true;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  const versions = parsed.versions;
  if (versions === null || typeof versions !== "object" || Array.isArray(versions)) return true;
  return Object.prototype.hasOwnProperty.call(versions, version);
}
function hasFailureEvidence(baseDir, version) {
  const prefix = `${version}.json`;
  const failureDir = join2(runtimeDirPath(baseDir), "failures");
  try {
    const info = lstatSync2(failureDir);
    if (info.isSymbolicLink() || !info.isDirectory()) return true;
    return readdirSync(failureDir).some((name) => name === prefix || name.startsWith(`${prefix}.corrupt`));
  } catch (error) {
    return error.code !== "ENOENT";
  }
}
function isProtectedVersion(baseDir, version, options = {}) {
  if (!isSafeVersion(version)) return false;
  const runtimeDir = runtimeDirPath(baseDir);
  const activation = readActivationJournalState(baseDir);
  if (activation.kind === "corrupt") return true;
  if (activation.kind === "valid") {
    const journal = activation.journal;
    if (journal.targetVersion === version || journal.sourceVersion === version || journal.rollbackTarget === version || journal.knownGoodVersion === version || journal.nextIntent?.targetVersion === version) return true;
  }
  const pointer = readCurrentPointerState(baseDir);
  if (pointer.kind === "corrupt") return true;
  if (pointer.kind === "valid" && pointer.version === version) return true;
  if (isKnownGoodProtected(baseDir, version)) return true;
  if (isKnownGoodCandidateProtected(baseDir, version)) return true;
  const override = readOverrideState(baseDir);
  if (override.kind === "corrupt") return true;
  if (override.kind === "valid" && (override.record.pending === version || override.record.chosenVersion === version || override.record.resolvedVersion === version)) return true;
  if (hasFailureEvidence(baseDir, version)) return true;
  if (existsSync(join2(runtimeDir, `${version}.failed`))) return true;
  if (options.ignoreExplicitInstall !== true && isExplicitInstall(baseDir, version)) return true;
  return false;
}
function cleanupExplicitRuntimeVersion(baseDir, version) {
  ensureRuntimeRootNoFollow(baseDir);
  const safe = assertSafeVersion(version);
  if (isProtectedVersion(baseDir, safe, { ignoreExplicitInstall: true })) {
    return { removed: false, retentionCleared: false, stillProtected: true };
  }
  const treePath = join2(runtimeDirPath(baseDir), safe);
  const exists = existsSync(treePath);
  if (exists) {
    makeOwnedTreeWritable(treePath);
    rmSync(treePath, { recursive: true, force: true });
  }
  forgetExplicitInstall(baseDir, safe);
  if (exists) {
    markStorePruneNeeded(baseDir, `explicit-cleanup:${safe}`);
    markStorePruneNeeded(baseDir, "cache-reclaim");
  }
  return { removed: exists, retentionCleared: true, stillProtected: false };
}
function storePruneMarkerPath(baseDir) {
  return join2(runtimeDirPath(baseDir), "store-prune-needed.json");
}
function readStorePruneRequest(baseDir) {
  const read = readAuthorityMetadata(storePruneMarkerPath(baseDir), 64 * 1024);
  if (read.kind !== "valid") return null;
  let parsed;
  try {
    parsed = JSON.parse(read.raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed;
  if (typeof rec.requestedAt !== "string" || !Array.isArray(rec.reasons) || !rec.reasons.every((v) => typeof v === "string")) return null;
  return { requestedAt: rec.requestedAt, reasons: rec.reasons };
}
function markStorePruneNeeded(baseDir, reason) {
  ensureRuntimeRootNoFollow(baseDir);
  const previous = readStorePruneRequest(baseDir);
  const reasons = Array.from(/* @__PURE__ */ new Set([...previous?.reasons ?? [], reason])).slice(-20);
  atomicWriteJson(baseDir, storePruneMarkerPath(baseDir), { requestedAt: (/* @__PURE__ */ new Date()).toISOString(), reasons });
}
function clearStorePruneRequest(baseDir) {
  removeRuntimeFileNoFollow(baseDir, storePruneMarkerPath(baseDir));
}
function versionTreeMtimeMs(baseDir, version) {
  try {
    return statSync(join2(runtimeDirPath(baseDir), version)).mtimeMs;
  } catch {
    return 0;
  }
}
function makeOwnedTreeWritable(treePath) {
  const visit = (entryPath) => {
    const info = lstatSync2(entryPath);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      chmodSync(entryPath, info.mode | 448);
      for (const entry of readdirSync(entryPath, { withFileTypes: true })) {
        visit(join2(entryPath, entry.name));
      }
      return;
    }
    if (info.isFile()) chmodSync(entryPath, info.mode | 384);
  };
  visit(treePath);
}
function evictVersions(baseDir, keep = 3) {
  ensureRuntimeRootNoFollow(baseDir);
  if (!Number.isInteger(keep) || keep < 0) throw new Error("keep \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570");
  const trees = listVersionTrees(baseDir);
  if (trees.length <= keep) return [];
  const removable = trees.filter((version) => !isProtectedVersion(baseDir, version)).sort((a, b) => versionTreeMtimeMs(baseDir, a) - versionTreeMtimeMs(baseDir, b));
  const evicted = [];
  let total = trees.length;
  for (const version of removable) {
    if (total <= keep) break;
    const treePath = join2(runtimeDirPath(baseDir), version);
    makeOwnedTreeWritable(treePath);
    rmSync(treePath, { recursive: true, force: true });
    evicted.push(version);
    total -= 1;
  }
  if (evicted.length > 0) {
    markStorePruneNeeded(baseDir, `evicted:${evicted.join(",")}`);
    markStorePruneNeeded(baseDir, "cache-reclaim");
  }
  return evicted;
}
function isPidAlive(pid, group = false) {
  try {
    process.kill(group && process.platform !== "win32" ? -pid : pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function readWorkStateMarker(workDir) {
  try {
    const info = lstatSync2(join2(workDir, "state"));
    if (info.isSymbolicLink() || !info.isFile() || info.size > 32) return null;
    const value = readFileSync(join2(workDir, "state"), "utf8").trim();
    return value === "preparing" || value === "spawning" || value === "spawned" || value === "failed" ? value : null;
  } catch {
    return null;
  }
}
function cleanupStaleInstalls(baseDir) {
  ensureRuntimeRootNoFollow(baseDir);
  let entries;
  try {
    entries = readdirSync(runtimeDirPath(baseDir), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(".work-")) continue;
    const workDir = join2(runtimeDirPath(baseDir), entry.name);
    const pidPath = join2(workDir, "pid");
    let pid = null;
    let pidEvidence = "missing";
    try {
      const info = lstatSync2(pidPath);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 64) {
        pidEvidence = "corrupt";
      } else {
        const parsed = Number(readFileSync(pidPath, "utf8").trim());
        if (Number.isSafeInteger(parsed) && parsed > 0) {
          pid = parsed;
          pidEvidence = "valid";
        } else {
          pidEvidence = "corrupt";
        }
      }
    } catch (error) {
      pidEvidence = error.code === "ENOENT" ? "missing" : "corrupt";
    }
    if (pid === null) {
      const entries2 = readdirSync(workDir);
      if (pidEvidence === "missing" && entries2.length === 0) {
        rmSync(workDir, { recursive: true, force: true });
        removed.push(entry.name);
        continue;
      }
      const workState = readWorkStateMarker(workDir);
      if (workState === "preparing" || workState === "failed") {
        rmSync(workDir, { recursive: true, force: true });
        removed.push(entry.name);
        continue;
      }
      throw new Error(`\u8FD0\u884C\u65F6\u5B89\u88C5\u73B0\u573A\u7684 PID/PGID \u8BC1\u636E${pidEvidence === "missing" ? "\u7F3A\u5931" : "\u635F\u574F"}\uFF08${entry.name}\uFF09\uFF1B\u62D2\u7EDD\u6E05\u7406\u5E76\u963B\u6B62\u542F\u52A8`);
    }
    if (pid !== null && (isPidAlive(pid, true) || isPidAlive(pid))) {
      throw new Error(`\u8FD0\u884C\u65F6\u5B89\u88C5\u73B0\u573A\u4ECD\u6709\u6D3B\u52A8\u5199\u8FDB\u7A0B\uFF08pid/pgid ${pid}\uFF09\uFF1B\u62D2\u7EDD\u6E05\u7406\u5E76\u963B\u6B62\u542F\u52A8`);
    }
    rmSync(workDir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  if (removed.length > 0) markStorePruneNeeded(baseDir, `stale-work:${removed.length}`);
  return removed;
}
function measurePathBytes(path) {
  let info;
  try {
    info = lstatSync2(path);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  if (info.isSymbolicLink()) return info.size;
  if (!info.isDirectory()) return info.size;
  let total = info.size;
  for (const entry of readdirSync(path)) total += measurePathBytes(join2(path, entry));
  return total;
}
function measureDedupedBytes(roots) {
  const seen = /* @__PURE__ */ new Set();
  const visit = (entryPath, missingIsZero) => {
    let info;
    try {
      info = lstatSync2(entryPath);
    } catch (error) {
      if (missingIsZero && error.code === "ENOENT") return 0;
      throw error;
    }
    const key = `${info.dev}:${info.ino}`;
    if (seen.has(key)) return 0;
    seen.add(key);
    if (info.isSymbolicLink() || !info.isDirectory()) return info.size;
    let total2 = info.size;
    for (const entry of readdirSync(entryPath)) total2 += visit(join2(entryPath, entry), false);
    return total2;
  };
  let total = 0;
  for (const root of roots) total += visit(root, true);
  return total;
}
function isRuntimePublishBackupName(name) {
  const match = PUBLISH_BACKUP_NAME.exec(name);
  if (!match) return false;
  const version = match[1];
  return version === version.trim() && isSafeVersion(version);
}
function runtimeDiskSummary(baseDir, dshHome = join2(baseDir, "state", "dsh-home")) {
  const runtime = runtimeDirPath(baseDir);
  const trees = listVersionTrees(baseDir);
  const treeSet = new Set(trees);
  const runtimeEntries = (() => {
    try {
      return readdirSync(runtime, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  })();
  const workDirs = runtimeEntries.filter((entry) => entry.isDirectory() && entry.name.startsWith(".work-")).map((entry) => join2(runtime, entry.name));
  const failedTrees = runtimeEntries.filter((entry) => entry.isDirectory() && entry.name.endsWith(".failed")).map((entry) => join2(runtime, entry.name));
  const publishBackups = runtimeEntries.filter((entry) => isRuntimePublishBackupName(entry.name)).map((entry) => join2(runtime, entry.name));
  const dshHomeParent = dirname2(dshHome);
  const dshHomeName = basename3(dshHome);
  const restoreBackups = (() => {
    try {
      return readdirSync(dshHomeParent, { withFileTypes: true }).filter((entry) => entry.isDirectory() && (entry.name === `${dshHomeName}.old` || entry.name.startsWith(`${dshHomeName}.old-`))).map((entry) => join2(dshHomeParent, entry.name));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  })();
  const unclassifiedPaths = [];
  for (const entry of runtimeEntries) {
    const name = entry.name;
    const known = treeSet.has(name) && entry.isDirectory() || entry.isDirectory() && name.startsWith(".work-") || entry.isDirectory() && name.endsWith(".failed") || isRuntimePublishBackupName(name) || name === "failures" || name === "metadata-recovery-data" || name === "metadata-recovery-rescue-data" || name === "metadata-recovery.json" || name === ".pnpm-store" || name === ".pnpm-cache" || name === ".install-home" || name === ".xdg-cache" || name === "snapshots" || name === "pre-rollback";
    if (!known) unclassifiedPaths.push(join2(runtime, name));
  }
  const versionTreeBytes = trees.reduce((sum, version) => sum + measurePathBytes(join2(runtime, version)), 0);
  const storeBytes = measurePathBytes(join2(runtime, ".pnpm-store"));
  const cacheBytes = measurePathBytes(join2(runtime, ".pnpm-cache"));
  const installHomeBytes = measurePathBytes(join2(runtime, ".install-home"));
  const xdgCacheBytes = measurePathBytes(join2(runtime, ".xdg-cache"));
  const workBytes = workDirs.reduce((sum, dir) => sum + measurePathBytes(dir), 0);
  const failureBytes = measurePathBytes(join2(runtime, "failures")) + failedTrees.reduce((sum, tree) => sum + measurePathBytes(tree), 0) + publishBackups.reduce((sum, backup) => sum + measurePathBytes(backup), 0) + measurePathBytes(join2(runtime, "metadata-recovery-data")) + measurePathBytes(join2(runtime, "metadata-recovery-rescue-data")) + measurePathBytes(join2(runtime, "metadata-recovery.json"));
  const snapshotBytes = measurePathBytes(join2(runtime, "snapshots"));
  const preRollbackBytes = measurePathBytes(join2(runtime, "pre-rollback"));
  const restoreBackupBytes = restoreBackups.reduce((sum, backup) => sum + measurePathBytes(backup), 0);
  const unclassifiedBytes = measureDedupedBytes(unclassifiedPaths);
  const totalBytes = measureDedupedBytes([
    ...runtimeEntries.map((entry) => join2(runtime, entry.name)),
    ...restoreBackups
  ]);
  return {
    versionTrees: trees.length,
    versionTreeBytes,
    storeBytes,
    cacheBytes,
    installHomeBytes,
    xdgCacheBytes,
    workBytes,
    failureBytes,
    snapshotBytes,
    preRollbackBytes,
    restoreBackupBytes,
    unclassifiedBytes,
    totalBytes,
    storePruneNeeded: existsSync(storePruneMarkerPath(baseDir))
  };
}

// src/registry-url.ts
var ALLOWED_REGISTRY_ORIGINS = [
  "https://registry.npmjs.org",
  "https://registry.npmmirror.com"
];
var NPMIRROR_CDN_ORIGIN = "https://cdn.npmmirror.com";
function registryRedirectOrigins(origin) {
  if (origin === "https://registry.npmmirror.com") {
    return ["https://registry.npmmirror.com", NPMIRROR_CDN_ORIGIN];
  }
  return [origin];
}
function canonicalRegistryOrigin(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const url = new URL(raw);
    const loopbackHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
    if (url.protocol !== "https:" && !loopbackHttp) return null;
    if (url.username !== "" || url.password !== "") return null;
    if (url.pathname !== "" && url.pathname !== "/") return null;
    if (url.search !== "" || url.hash !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}
function isAllowedRegistryUrl(raw, origins) {
  if (typeof raw !== "string") return false;
  const allowed = origins ?? ALLOWED_REGISTRY_ORIGINS;
  try {
    const url = new URL(raw);
    if (!allowed.includes(url.origin)) return false;
    if (url.username !== "" || url.password !== "") return false;
    const normalized = new URL(`${url.origin}${decodeURIComponent(url.pathname)}`).pathname;
    return isAllowedRegistryPath(normalized, url.origin);
  } catch {
    return false;
  }
}
function isAllowedRegistryPath(pathname, origin) {
  if (pathname === "/-/v1/search" || pathname.startsWith("/-/v1/search/")) return true;
  if (origin === NPMIRROR_CDN_ORIGIN && /^\/packages\/(?:@[^/]+\/)?[^/]+\/[^/]+\/[^/]+\.tgz$/.test(pathname)) return true;
  return /^\/(?:@[^/]+\/)?[^/]+(?:\/-\/[^/]+)?$/.test(pathname);
}

// src/registry-integrity.ts
import { createHash as createHash2, timingSafeEqual } from "node:crypto";
var ALGORITHM_STRENGTH = {
  sha256: 256,
  sha384: 384,
  sha512: 512
};
var DIGEST_LENGTH = {
  sha256: 32,
  sha384: 48,
  sha512: 64
};
function parseIntegrity(raw) {
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > 4096) return null;
  const parsed = [];
  for (const token of raw.trim().split(/\s+/)) {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    if (match === null) continue;
    const algorithm = match[1];
    const encoded = match[2];
    const digest = Buffer.from(encoded, "base64");
    if (digest.length !== DIGEST_LENGTH[algorithm]) continue;
    if (digest.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) continue;
    parsed.push({ algorithm, digest });
  }
  if (parsed.length === 0) return null;
  const strongest = parsed.reduce((best, item) => ALGORITHM_STRENGTH[item.algorithm] > ALGORITHM_STRENGTH[best.algorithm] ? item : best).algorithm;
  return {
    algorithm: strongest,
    digests: parsed.filter((item) => item.algorithm === strongest).map((item) => item.digest)
  };
}
function isSupportedIntegrity(raw) {
  return parseIntegrity(raw) !== null;
}
function createIntegrityVerifier(raw) {
  const parsed = parseIntegrity(raw);
  if (parsed === null) throw new Error("registry tarball \u7F3A\u5C11\u53EF\u7528\u7684 sha256/sha384/sha512 integrity");
  const hash = createHash2(parsed.algorithm);
  let finished = false;
  return {
    update(chunk) {
      if (finished) throw new Error("integrity verifier already finalized");
      hash.update(chunk);
    },
    assertMatch() {
      if (finished) throw new Error("integrity verifier already finalized");
      finished = true;
      const actual = hash.digest();
      if (!parsed.digests.some((expected) => expected.length === actual.length && timingSafeEqual(expected, actual))) {
        throw new Error(`registry tarball integrity mismatch (${parsed.algorithm})`);
      }
    }
  };
}

// src/dsh-runtime-updater.ts
function bindRuntimeInstallResolution(meta, version, currentRegistryOrigin) {
  const currentOrigin = canonicalRegistryOrigin(currentRegistryOrigin);
  if (currentOrigin === null || meta.origin !== currentOrigin) {
    throw new Error("registry \u6E90\u5DF2\u53D8\u66F4\uFF1B\u8BF7\u91CD\u65B0\u68C0\u67E5\u7248\u672C\u540E\u518D\u5B89\u88C5");
  }
  if (!EXACT_SEMVER.test(version)) throw new Error(`invalid runtime version: ${version}`);
  const record = meta.byVersion.get(version);
  if (record === void 0 || record.version !== version || !isSupportedIntegrity(record.integrity)) {
    throw new Error(`\u7248\u672C\u7F3A\u5C11\u53EF\u9A8C\u8BC1\u7684 tarball integrity\uFF1A${version}`);
  }
  if (!isAllowedRegistryUrl(record.tarball, registryRedirectOrigins(currentOrigin))) {
    throw new Error(`\u7248\u672C tarball \u4E0D\u5728 registry \u767D\u540D\u5355\uFF1A${version}`);
  }
  return Object.freeze({
    packageName: meta.packageName,
    version,
    registryOrigin: currentOrigin,
    tarball: record.tarball,
    integrity: record.integrity
  });
}
var SingleFlight = class {
  busy = false;
  /** 尝试进入在途：已有在途 → false；否则置位并返回 true。 */
  tryBegin() {
    if (this.busy) return false;
    this.busy = true;
    return true;
  }
  /** 结束在途（无论是否在途都安全；不在途时调用无副作用）。 */
  end() {
    this.busy = false;
  }
  /** 是否有在途切换。 */
  get inFlight() {
    return this.busy;
  }
};
function isNoopSelection(chosen, active) {
  return chosen !== null && active !== null && chosen === active;
}
function parseSemverTriple(v) {
  if (!EXACT_SEMVER.test(v)) return null;
  const plus = v.indexOf("+");
  const withoutBuild = plus === -1 ? v : v.slice(0, plus);
  const dash = withoutBuild.indexOf("-");
  const nums = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? "" : withoutBuild.slice(dash + 1);
  const [major, minor, patch] = nums.split(".");
  return { major, minor, patch, prerelease: pre === "" ? [] : pre.split(".") };
}
function compareNumericText(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}
function semverCompareAsc(a, b) {
  const pa = parseSemverTriple(a);
  const pb = parseSemverTriple(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  for (const [left, right] of [
    [pa.major, pb.major],
    [pa.minor, pb.minor],
    [pa.patch, pb.patch]
  ]) {
    const compared = compareNumericText(left, right);
    if (compared !== 0) return compared;
  }
  const aPre = pa.prerelease.length > 0;
  const bPre = pb.prerelease.length > 0;
  if (aPre !== bPre) return aPre ? -1 : 1;
  const common = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < common; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const compared = compareNumericText(x, y);
      if (compared !== 0) return compared;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return pa.prerelease.length - pb.prerelease.length;
}
function compareRuntimeVersions(a, b) {
  if (!EXACT_SEMVER.test(a) || !EXACT_SEMVER.test(b)) return null;
  const compared = semverCompareAsc(a, b);
  return compared === 0 ? 0 : compared < 0 ? -1 : 1;
}
function semverCompareDesc(a, b) {
  return semverCompareAsc(b, a);
}
function isListable(v, byVersion) {
  const record = byVersion.get(v);
  return record !== void 0 && record.tarball.length > 0 && EXACT_SEMVER.test(v);
}
function buildVersionList(meta, opts) {
  const byVersion = meta.byVersion;
  const cached = new Set(opts.cachedVersions.filter((version) => EXACT_SEMVER.test(version)));
  const emitted = /* @__PURE__ */ new Set();
  const entries = [];
  const makeEntry = (v) => {
    const baseline = opts.compatibilityBaseline;
    const belowBaseline = baseline !== null && EXACT_SEMVER.test(baseline) && semverCompareAsc(v, baseline) < 0;
    return {
      version: v,
      latest: meta.latest !== null && v === meta.latest,
      cached: cached.has(v),
      belowBaseline
    };
  };
  if (opts.active !== null && EXACT_SEMVER.test(opts.active)) {
    entries.push(makeEntry(opts.active));
    emitted.add(opts.active);
  }
  const candidates = /* @__PURE__ */ new Set();
  for (const version of meta.versions) {
    if (isListable(version, byVersion)) candidates.add(version);
  }
  for (const version of cached) candidates.add(version);
  const rest = [...candidates].filter((v) => !emitted.has(v)).sort(semverCompareDesc);
  for (const v of rest) {
    if (emitted.has(v)) continue;
    emitted.add(v);
    entries.push(makeEntry(v));
  }
  return entries;
}
function versionExists(meta, version) {
  const record = meta.byVersion.get(version);
  return record !== void 0 && record.tarball.length > 0 && isSupportedIntegrity(record.integrity);
}
function buildCachedVersionList(cachedVersions, active) {
  const entries = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (v) => {
    if (!EXACT_SEMVER.test(v) || seen.has(v)) return;
    seen.add(v);
    entries.push({ version: v, latest: false, cached: true, belowBaseline: false });
  };
  if (active !== null) add(active);
  for (const v of cachedVersions) add(v);
  return entries;
}

// src/known-good-monitor.ts
import { join as join3 } from "node:path";
var DEFAULT_HEALTH_POLICY = {
  minUptimeMs: 24 * 60 * 60 * 1e3,
  minBoots: 1
};
function shouldPromote(candidate, nowMs, policy = DEFAULT_HEALTH_POLICY) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(candidate.firstProbePassAt)) return false;
  if (!Number.isInteger(candidate.bootCount) || candidate.bootCount < 0) return false;
  if (!Number.isFinite(policy.minUptimeMs) || policy.minUptimeMs < 0 || !Number.isInteger(policy.minBoots) || policy.minBoots < 0) return false;
  if (candidate.healthWindowStartedAt === null || !Number.isFinite(candidate.healthWindowStartedAt)) return false;
  return nowMs - candidate.healthWindowStartedAt >= policy.minUptimeMs && candidate.bootCount >= policy.minBoots;
}
function knownGoodCandidatesPath(baseDir) {
  return join3(baseDir, "dsh-runtime", "known-good-candidates.json");
}
function readCandidates(baseDir) {
  const read = readPrivateFileNoFollow(knownGoodCandidatesPath(baseDir), 256 * 1024);
  if (read.kind === "missing") return {};
  if (read.kind === "unsafe") throw new Error("known-good \u5019\u9009\u5143\u6570\u636E\u4E0D\u5B89\u5168\uFF0C\u62D2\u7EDD\u8BFB\u53D6\u6216\u8986\u76D6");
  try {
    const parsed = JSON.parse(read.raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("known-good \u5019\u9009\u5143\u6570\u636E\u5F62\u72B6\u65E0\u6548");
    }
    const versions = parsed.versions;
    if (versions === null || typeof versions !== "object" || Array.isArray(versions)) {
      throw new Error("known-good \u5019\u9009\u7248\u672C\u8868\u5F62\u72B6\u65E0\u6548");
    }
    const out = {};
    for (const [version, value] of Object.entries(versions)) {
      if (!isSafeVersion(version) || value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("known-good \u5019\u9009\u8BB0\u5F55\u5F62\u72B6\u65E0\u6548");
      }
      const rec = value;
      if (typeof rec.firstProbePassAt !== "number" || !Number.isFinite(rec.firstProbePassAt)) {
        throw new Error("known-good \u5019\u9009\u9996\u6B21\u63A2\u6D4B\u65F6\u95F4\u65E0\u6548");
      }
      if (typeof rec.bootCount !== "number" || !Number.isInteger(rec.bootCount) || rec.bootCount < 0) {
        throw new Error("known-good \u5019\u9009\u542F\u52A8\u8BA1\u6570\u65E0\u6548");
      }
      const hasV2Window = Object.prototype.hasOwnProperty.call(rec, "healthWindowStartedAt") && Object.prototype.hasOwnProperty.call(rec, "healthWindowResetAt");
      if (!hasV2Window) {
        out[version] = {
          firstProbePassAt: rec.firstProbePassAt,
          bootCount: 0,
          healthWindowStartedAt: null,
          healthWindowResetAt: null
        };
        continue;
      }
      const startedAt = rec.healthWindowStartedAt;
      const resetAt = rec.healthWindowResetAt;
      if (startedAt !== null && (typeof startedAt !== "number" || !Number.isFinite(startedAt))) {
        throw new Error("known-good \u5019\u9009\u5065\u5EB7\u7A97\u53E3\u8D77\u70B9\u65E0\u6548");
      }
      if (resetAt !== null && (typeof resetAt !== "number" || !Number.isFinite(resetAt))) {
        throw new Error("known-good \u5019\u9009\u5065\u5EB7\u7A97\u53E3\u91CD\u7F6E\u65F6\u95F4\u65E0\u6548");
      }
      out[version] = {
        firstProbePassAt: rec.firstProbePassAt,
        bootCount: rec.bootCount,
        healthWindowStartedAt: startedAt,
        healthWindowResetAt: resetAt
      };
    }
    return out;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("known-good \u5019\u9009\u5143\u6570\u636E JSON \u635F\u574F");
    throw error;
  }
}
function writeCandidates(baseDir, versions) {
  const filePath = knownGoodCandidatesPath(baseDir);
  atomicWriteRuntimeFileNoFollow(baseDir, filePath, `${JSON.stringify({ versions }, null, 2)}
`);
}
function recordProbePass(baseDir, version, nowMs = Date.now()) {
  const safe = assertSafeVersion(version);
  if (!Number.isFinite(nowMs)) throw new Error("nowMs \u5FC5\u987B\u662F\u6709\u9650\u6570");
  ensureRuntimeRootNoFollow(baseDir);
  const valid = validateVersionTree(baseDir, safe);
  if (!valid.ok) throw new Error(`\u4E0D\u80FD\u8BB0\u5F55\u65E0\u6548\u8FD0\u884C\u65F6\u4E3A known-good \u5019\u9009\uFF1A${valid.error}`);
  const versions = readCandidates(baseDir);
  const existing = versions[safe];
  const existingWindow = existing?.healthWindowStartedAt;
  const keepExistingWindow = typeof existingWindow === "number" && existingWindow <= nowMs;
  versions[safe] = {
    firstProbePassAt: existing?.firstProbePassAt ?? nowMs,
    bootCount: existing?.bootCount ?? 0,
    healthWindowStartedAt: keepExistingWindow ? existingWindow : nowMs,
    healthWindowResetAt: existing?.healthWindowResetAt ?? null
  };
  writeCandidates(baseDir, versions);
}
function noteBoot(baseDir, version, nowMs = Date.now()) {
  if (!Number.isFinite(nowMs)) throw new Error("nowMs \u5FC5\u987B\u662F\u6709\u9650\u6570");
  if (!isSafeVersion(version)) return;
  ensureRuntimeRootNoFollow(baseDir);
  if (!validateVersionTree(baseDir, version).ok) return;
  const versions = readCandidates(baseDir);
  const rec = versions[version];
  if (rec === void 0) return;
  const keepExistingWindow = rec.healthWindowStartedAt !== null && rec.healthWindowStartedAt <= nowMs;
  versions[version] = {
    ...rec,
    bootCount: rec.bootCount + 1,
    healthWindowStartedAt: keepExistingWindow ? rec.healthWindowStartedAt : nowMs
  };
  writeCandidates(baseDir, versions);
}
function resetCandidateHealthWindow(baseDir, nowMs = Date.now()) {
  if (!Number.isFinite(nowMs)) throw new Error("nowMs \u5FC5\u987B\u662F\u6709\u9650\u6570");
  ensureRuntimeRootNoFollow(baseDir);
  const versions = readCandidates(baseDir);
  if (Object.keys(versions).length === 0) return;
  for (const [version, rec] of Object.entries(versions)) {
    versions[version] = {
      ...rec,
      bootCount: 0,
      healthWindowStartedAt: null,
      healthWindowResetAt: nowMs
    };
  }
  writeCandidates(baseDir, versions);
}
function removeKnownGoodCandidate(baseDir, version) {
  const safe = assertSafeVersion(version);
  ensureRuntimeRootNoFollow(baseDir);
  const versions = readCandidates(baseDir);
  if (!Object.prototype.hasOwnProperty.call(versions, safe)) return;
  delete versions[safe];
  writeCandidates(baseDir, versions);
}
function promoteDueCandidates(baseDir, nowMs = Date.now(), policy = DEFAULT_HEALTH_POLICY) {
  ensureRuntimeRootNoFollow(baseDir);
  const versions = readCandidates(baseDir);
  const promoted = [];
  const remaining = {};
  for (const [version, rec] of Object.entries(versions)) {
    if (shouldPromote(rec, nowMs, policy) && validateVersionTree(baseDir, version).ok) {
      markKnownGood(baseDir, version, new Date(nowMs));
      promoted.push(version);
    } else {
      remaining[version] = rec;
    }
  }
  writeCandidates(baseDir, remaining);
  return promoted;
}

// src/override-lifecycle.ts
function shouldInvalidate(record, currentShellVersion) {
  return record.invalidatedAt != null || record.shellVersion !== currentShellVersion;
}
function invalidate(record, reason = "shell-version-changed", now = /* @__PURE__ */ new Date()) {
  const invalidatedAt = record.invalidatedAt ?? now.toISOString();
  const invalidatedReason = record.invalidatedReason ?? reason;
  return {
    ...record,
    swapAttempted: false,
    invalidatedAt,
    invalidatedReason,
    lastInvalidatedAt: record.lastInvalidatedAt ?? invalidatedAt,
    lastInvalidatedReason: record.lastInvalidatedReason ?? invalidatedReason,
    lastInvalidatedFromVersion: record.lastInvalidatedFromVersion ?? record.resolvedVersion ?? record.chosenVersion,
    lastInvalidationRecovered: record.lastInvalidationRecovered ?? false
  };
}
function effectivePending(record, currentShellVersion) {
  if (record === null) return null;
  if (shouldInvalidate(record, currentShellVersion)) return null;
  return record.pending;
}
function shouldRetrySwap(record) {
  return !record.swapAttempted;
}
function replayDecision(record, currentPointerVersion) {
  if (record.pending === null) return "none";
  if (currentPointerVersion === record.pending) return "skip-switch-probe-only";
  return "apply-switch";
}

// src/registry-metadata.ts
var DEFAULT_REGISTRY_TIMEOUT_MS = 15e3;
var DEFAULT_REGISTRY_MAX_REDIRECTS = 5;
var DEFAULT_REGISTRY_METADATA_MAX_BYTES = 5 * 1024 * 1024;
var REDIRECT_STATUSES = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
function safeUrlForError(raw) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "<invalid registry URL>";
  }
}
async function fetchRegistryResponse(rawUrl, opts) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_REGISTRY_MAX_REDIRECTS;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) {
    throw new Error(`invalid registry redirect limit: ${maxRedirects}`);
  }
  let current = new URL(rawUrl).toString();
  for (let redirects = 0; ; redirects += 1) {
    if (!isAllowedRegistryUrl(current, opts.allowedOrigins)) {
      throw new Error(`registry URL \u4E0D\u5728\u767D\u540D\u5355\uFF1A${safeUrlForError(current)}`);
    }
    const response = await fetchImpl(current, {
      headers: opts.headers,
      redirect: "manual",
      signal: opts.signal
    });
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current };
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {
    });
    if (location === null || location === "") {
      throw new Error(`registry redirect ${response.status} \u7F3A\u5C11 Location`);
    }
    if (redirects >= maxRedirects) {
      throw new Error(`registry redirect exceeded limit (${maxRedirects})`);
    }
    const next = new URL(location, current).toString();
    if (!isAllowedRegistryUrl(next, opts.allowedOrigins)) {
      throw new Error(`registry redirect \u79BB\u5F00\u767D\u540D\u5355\uFF1A${safeUrlForError(next)}`);
    }
    current = next;
  }
}
function createDeadline(external, timeoutMs) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(external?.reason);
  if (external?.aborted) forwardAbort();
  else external?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`registry request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", forwardAbort);
    }
  };
}
async function readJsonLimited(response, maxBytes, signal) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error(`invalid registry metadata limit: ${maxBytes}`);
  if (response.body === null) throw new Error("registry metadata response body is empty");
  const chunks = [];
  let total = 0;
  for await (const raw of response.body) {
    signal.throwIfAborted();
    const chunk = Buffer.from(raw);
    total += chunk.length;
    if (total > maxBytes) throw new Error(`registry metadata exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
}
async function fetchRegistryMetadata(packageName, opts) {
  const rawOrigin = opts?.origin ?? "https://registry.npmjs.org";
  const origin = canonicalRegistryOrigin(rawOrigin);
  if (origin === null) throw new Error("invalid registry origin");
  const url = new URL(`/${packageName}`, origin);
  if (!isAllowedRegistryUrl(url.toString(), [origin])) {
    throw new Error(`registry metadata URL \u4E0D\u5728\u767D\u540D\u5355\uFF1A${url.toString()}`);
  }
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_REGISTRY_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid registry timeout: ${timeoutMs}`);
  const deadline = createDeadline(opts?.signal, timeoutMs);
  try {
    const { response } = await fetchRegistryResponse(url.toString(), {
      allowedOrigins: [origin],
      signal: deadline.signal,
      maxRedirects: opts?.maxRedirects,
      fetchImpl: opts?.fetchImpl,
      headers: { accept: "application/vnd.npm.install-v1+json" }
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {
      });
      throw new Error(`registry metadata fetch failed: HTTP ${response.status} for ${packageName}`);
    }
    const doc = await readJsonLimited(
      response,
      opts?.maxBytes ?? DEFAULT_REGISTRY_METADATA_MAX_BYTES,
      deadline.signal
    );
    return parseRegistryMetadata(doc, packageName, origin, registryRedirectOrigins(origin));
  } finally {
    deadline.cleanup();
  }
}
function parseRegistryMetadata(doc, packageName, origin, allowedOrigins) {
  const packument = doc ?? {};
  const byVersion = /* @__PURE__ */ new Map();
  const rawVersions = packument.versions;
  if (rawVersions !== null && typeof rawVersions === "object" && !Array.isArray(rawVersions)) {
    for (const [version, entry] of Object.entries(rawVersions)) {
      if (!EXACT_SEMVER.test(version)) continue;
      const tarball = entry?.dist?.tarball;
      if (typeof tarball !== "string" || tarball === "" || tarball.length > 8192) continue;
      if (!isAllowedRegistryUrl(tarball, allowedOrigins)) continue;
      const integrity = entry?.dist?.integrity;
      if (!isSupportedIntegrity(integrity)) continue;
      const info = {
        version,
        tarball,
        integrity
      };
      byVersion.set(version, Object.freeze(info));
    }
  }
  const versions = [...byVersion.keys()].sort(compareVersionsDesc);
  const latest = pickLatest(packument["dist-tags"], versions);
  return Object.freeze({
    packageName,
    origin,
    latest,
    versions: Object.freeze(versions),
    byVersion: asReadonlyMap(byVersion)
  });
}
function asReadonlyMap(map) {
  return new Proxy(map, {
    get(target, prop) {
      if (prop === "set" || prop === "delete" || prop === "clear") {
        return () => {
          throw new TypeError("registry metadata is immutable");
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
function pickLatest(distTags, versions) {
  const latest = distTags?.latest;
  if (typeof latest === "string" && latest.length > 0 && versions.includes(latest)) {
    return latest;
  }
  return versions.length > 0 ? versions[0] : null;
}
function compareVersionsDesc(a, b) {
  const ap = a.split(/[.-]/);
  const bp = b.split(/[.-]/);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const av = ap[i];
    const bv = bp[i];
    if (av === void 0) return -1;
    if (bv === void 0) return 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av) ? Number(av) : NaN;
    const bn = /^\d+$/.test(bv) ? Number(bv) : NaN;
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return bn - an;
    if (!Number.isNaN(an)) return 1;
    if (!Number.isNaN(bn)) return -1;
    return av < bv ? 1 : -1;
  }
  return 0;
}

// src/restart-exhausted-rollback.ts
import { basename as basename4 } from "node:path";
var RECOVERY_PHASES = /* @__PURE__ */ new Set([
  "rollback-needed",
  "restoring",
  "restore-complete",
  "fallback-builtin"
]);
function isSafeStoredBasename2(value) {
  return value !== null && value.length > 0 && value.length <= 255 && basename4(value) === value && value !== "." && value !== ".." && !value.includes("\0");
}
function monitoringFactsAreUsable(journal) {
  if (journal.schemaVersion !== 1 || journal.phase !== "applied-monitoring") return false;
  if (!isSafeVersion(journal.targetVersion) || journal.targetIsBuiltin) return false;
  if (journal.sourceVersion === null || !isSafeVersion(journal.sourceVersion)) return false;
  if (typeof journal.sourceIsBuiltin !== "boolean" || typeof journal.sourceWasKnownGood !== "boolean") return false;
  if (journal.knownGoodVersion !== null && !isSafeVersion(journal.knownGoodVersion)) return false;
  return isSafeStoredBasename2(journal.preSwapSnapshotName);
}
function targetForDelayedRollback(journal, failedVersion) {
  if (journal.sourceIsBuiltin === true) return null;
  const selected = rollbackTarget({
    previousVersion: journal.sourceVersion,
    previousWasKnownGood: journal.sourceWasKnownGood === true || journal.sourceVersion === journal.knownGoodVersion,
    knownGoodVersion: journal.knownGoodVersion
  });
  if (selected !== failedVersion) return selected;
  return journal.knownGoodVersion !== null && journal.knownGoodVersion !== failedVersion ? journal.knownGoodVersion : null;
}
function planRestartExhaustedRollback(opts) {
  if (!opts.restartExhausted) {
    return { status: "not-triggered", reason: "not-restart-exhausted" };
  }
  if (!opts.activeIsOverride || !shouldAutoRollback(true, opts.activeIsOverride)) {
    return { status: "not-triggered", reason: "active-runtime-not-override" };
  }
  if (!isSafeVersion(opts.failedVersion)) {
    return { status: "not-triggered", reason: "failed-version-invalid" };
  }
  if (opts.journalState.kind === "missing") {
    return { status: "not-triggered", reason: "journal-missing" };
  }
  if (opts.journalState.kind === "corrupt") {
    return { status: "not-triggered", reason: "journal-corrupt" };
  }
  const journal = opts.journalState.journal;
  if (journal.targetIsBuiltin) {
    return { status: "not-triggered", reason: "journal-target-builtin" };
  }
  if (journal.targetVersion !== opts.failedVersion) {
    return { status: "not-triggered", reason: "journal-target-mismatch" };
  }
  if (RECOVERY_PHASES.has(journal.phase)) {
    return {
      status: "already-in-recovery",
      journal,
      rollbackTarget: journal.rollbackTarget
    };
  }
  if (journal.phase !== "applied-monitoring") {
    return { status: "not-triggered", reason: "journal-not-monitoring" };
  }
  if (!monitoringFactsAreUsable(journal)) {
    return { status: "not-triggered", reason: "journal-monitoring-invalid" };
  }
  const now = opts.now?.() ?? /* @__PURE__ */ new Date();
  if (Number.isNaN(now.getTime())) {
    return { status: "not-triggered", reason: "clock-invalid" };
  }
  const target = targetForDelayedRollback(journal, opts.failedVersion);
  const planned = {
    ...journal,
    phase: "rollback-needed",
    rollbackTarget: target,
    // Detach the deferred intent from the rollback journal: the owner re-queues
    // it (main.ts runRestartExhaustedRollback) after the rollback lands safely,
    // so a crash between plan and re-queue never replays the failed version.
    nextIntent: null,
    updatedAt: now.toISOString()
  };
  return {
    status: "planned",
    journal: planned,
    rollbackTarget: target,
    deferredIntent: journal.nextIntent
  };
}

// src/runtime-installer.ts
import { createHash as createHash3, randomBytes as randomBytes3 } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync as chmodSync2,
  existsSync as existsSync3,
  lstatSync as lstatSync3,
  readFileSync as readFileSync2,
  readdirSync as readdirSync3,
  realpathSync as realpathSync2,
  renameSync as renameSync2,
  rmSync as rmSync3,
  writeFileSync as writeFileSync2
} from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute as isAbsolute2, join as join5, relative as relative3 } from "node:path";

// src/allow-builds.mjs
var ALLOW_BUILDS = [
  "node-pty",
  "koffi",
  "protobufjs",
  "@google/genai",
  "@deepseek-ai/dsh-subprocess-local"
];

// src/windows-process.ts
import { spawnSync } from "node:child_process";
var PROBE_TIMEOUT_MS = 3e4;
var TABLE_CACHE_TTL_MS = 500;
function assertWindows() {
  if (process.platform !== "win32") {
    throw new Error("windows process probes are only available on win32");
  }
}
function execWindowsTool(file, args) {
  const res = spawnSync(file, args, {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  if (res.error !== void 0) throw res.error;
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
function parseProcessTable(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value;
    const pid = toInt(record.ProcessId);
    if (pid === null) return;
    rows.push({ pid, ppid: toInt(record.ParentProcessId) });
  };
  visit(parsed);
  return rows;
}
function toInt(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}
function descendantPidsOf(rows, rootPid) {
  const childrenOf = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (row.ppid === null || row.ppid === row.pid) continue;
    const siblings = childrenOf.get(row.ppid);
    if (siblings === void 0) childrenOf.set(row.ppid, [row.pid]);
    else siblings.push(row.pid);
  }
  const found = [];
  const seen = /* @__PURE__ */ new Set();
  const stack = [rootPid];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const child of childrenOf.get(current) ?? []) {
      if (child === rootPid || seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      stack.push(child);
    }
  }
  return found;
}
function taskkillTreeArgs(pid) {
  return ["/PID", String(pid), "/T", "/F"];
}
function classifyTaskkill(status, combined) {
  if (status === 0) return "signalled";
  if (/not found|no running instance/i.test(combined)) return "gone";
  return "error";
}
function processTableCommand() {
  return [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)",
    "ConvertTo-Json -InputObject $rows -Compress"
  ].join("; ");
}
function queryWindowsProcessTable() {
  assertWindows();
  const now = Date.now();
  if (tableCache !== null && now - tableCache.at < TABLE_CACHE_TTL_MS) return tableCache.rows;
  const { status, stdout, stderr } = execWindowsTool("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    processTableCommand()
  ]);
  const rows = status === 0 ? parseProcessTable(stdout) : [];
  if (rows.length === 0) {
    throw new Error(`windows CIM process table unavailable (exit ${String(status)}): ${stderr.trim().slice(0, 512) || "empty output"}`);
  }
  tableCache = { at: Date.now(), rows };
  return rows;
}
var tableCache = null;
function hasWindowsDescendants(pid) {
  assertWindows();
  let rows;
  try {
    rows = queryWindowsProcessTable();
  } catch {
    return true;
  }
  return descendantPidsOf(rows, pid).length > 0;
}
function killWindowsTree(pid) {
  assertWindows();
  const { status, stdout, stderr } = execWindowsTool("taskkill.exe", taskkillTreeArgs(pid));
  let outcome = classifyTaskkill(status, `${stdout}
${stderr}`);
  if (outcome === "error") {
    if (!windowsPidExists(pid)) outcome = "gone";
    else throw new Error(`taskkill tree ${pid} failed`);
  }
  if (outcome === "signalled") return true;
  return false;
}
function windowsPidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error.code;
    if (code === "ESRCH") return false;
    return true;
  }
}
function killWindowsTreeWithResidual(pid) {
  assertWindows();
  if (killWindowsTree(pid)) return true;
  let rows;
  try {
    rows = queryWindowsProcessTable();
  } catch (error) {
    throw new Error(`taskkill tree ${pid}: leader gone but residual probe unavailable: ${String(error)}`);
  }
  const residual = descendantPidsOf(rows, pid);
  let killedAny = false;
  for (const childPid of residual) {
    if (killWindowsTree(childPid)) killedAny = true;
  }
  return killedAny;
}

// src/runtime-installer.ts
var DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1e3;
var INSTALL_TERMINATE_GRACE_MS = 1e3;
var INSTALL_OUTPUT_LIMIT_BYTES = 64 * 1024;
var DEFAULT_TARBALL_MAX_BYTES = 512 * 1024 * 1024;
var CRITICAL_RUNTIME_FILES2 = [
  "node_modules/@deepseek-ai/dsh/package.json",
  "node_modules/@deepseek-ai/dsh/lib/bin.js"
];
var FAILED_ERROR_LIMIT = 2e3;
var INSTALL_ENV_WHITELIST = /^(PATH|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)$/;
function scrubInstallEnv(base) {
  const out = {};
  for (const [key, value] of Object.entries(base)) {
    if (INSTALL_ENV_WHITELIST.test(key) && value !== void 0) out[key] = value;
  }
  return out;
}
function sanitizeInstallerOutput(raw, limit) {
  const withoutUrlSecrets = raw.replace(/https?:\/\/[^\s"'<>]+/gi, (token) => {
    try {
      const url = new URL(token);
      return `${url.protocol}//${url.host}/[redacted]`;
    } catch {
      return "[url]";
    }
  });
  const withoutNamedSecrets = withoutUrlSecrets.replace(
    /\b(token|password|passwd|secret|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi,
    "$1=[redacted]"
  );
  const sanitized = sanitizeErrorText(withoutNamedSecrets);
  if (Buffer.byteLength(sanitized) <= limit) return sanitized;
  return Buffer.from(sanitized).subarray(0, limit).toString("utf8").replace(/\uFFFD$/u, "");
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function criticalFilePath(root, relativePath) {
  const rootReal = realpathSync2(root);
  const candidate = join5(root, relativePath);
  const info = lstatSync3(candidate);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`runtime critical file is not a regular file: ${relativePath}`);
  }
  const fileReal = realpathSync2(candidate);
  const fromRoot = relative3(rootReal, fileReal);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute2(fromRoot)) {
    throw new Error(`runtime critical file escapes the version tree: ${relativePath}`);
  }
  return candidate;
}
function sha256File(root, relativePath) {
  return `sha256-${createHash3("sha256").update(readFileSync2(criticalFilePath(root, relativePath))).digest("base64")}`;
}
function assertRuntimePackageIdentity(root, version) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync2(criticalFilePath(root, CRITICAL_RUNTIME_FILES2[0]), "utf8"));
  } catch (error) {
    throw new Error(`runtime package manifest is missing or invalid: ${sanitizeInstallerOutput(errorMessage(error), 300)}`);
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("runtime package manifest has an invalid shape");
  }
  const record = manifest;
  if (record.name !== "@deepseek-ai/dsh" || record.version !== version) {
    throw new Error(`runtime package identity mismatch (wanted @deepseek-ai/dsh@${version})`);
  }
}
function computeCriticalDigests(root, version) {
  assertRuntimePackageIdentity(root, version);
  return Object.fromEntries(CRITICAL_RUNTIME_FILES2.map((relativePath) => [relativePath, sha256File(root, relativePath)]));
}
function verifyRuntimeTreeCriticalFiles(root, version) {
  const safeVersion = assertSafeVersion(version);
  let rootManifest;
  try {
    rootManifest = JSON.parse(readFileSync2(join5(root, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(`published runtime manifest is missing or invalid: ${sanitizeInstallerOutput(errorMessage(error), 300)}`);
  }
  if (rootManifest === null || typeof rootManifest !== "object" || Array.isArray(rootManifest)) {
    throw new Error("published runtime manifest has an invalid shape");
  }
  const dsh = rootManifest.dsh;
  if (dsh === null || typeof dsh !== "object" || Array.isArray(dsh)) {
    throw new Error("published runtime manifest is missing dsh metadata");
  }
  const rawDigests = dsh.criticalFiles;
  if (rawDigests === null || typeof rawDigests !== "object" || Array.isArray(rawDigests)) {
    throw new Error("published runtime manifest is missing critical-file digests");
  }
  const expected = rawDigests;
  const expectedKeys = Object.keys(expected).sort();
  const requiredKeys = [...CRITICAL_RUNTIME_FILES2].sort();
  if (expectedKeys.length !== requiredKeys.length || expectedKeys.some((key, index) => key !== requiredKeys[index])) {
    throw new Error("published runtime critical-file set is incomplete");
  }
  assertRuntimePackageIdentity(root, safeVersion);
  for (const relativePath of CRITICAL_RUNTIME_FILES2) {
    const digest = expected[relativePath];
    if (typeof digest !== "string" || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(digest)) {
      throw new Error(`published runtime has an invalid digest for ${relativePath}`);
    }
    if (sha256File(root, relativePath) !== digest) {
      throw new Error(`published runtime critical-file digest mismatch: ${relativePath}`);
    }
  }
}
function makeRuntimeTreeReadOnly(root) {
  const visit = (entryPath) => {
    const info = lstatSync3(entryPath);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const entry of readdirSync3(entryPath)) visit(join5(entryPath, entry));
    } else if (!info.isFile()) {
      throw new Error("runtime version tree contains an unsupported special file");
    }
    const readOnlyMode = info.isDirectory() ? info.mode & ~146 | 320 : info.mode & ~146 | 256;
    chmodSync2(entryPath, readOnlyMode);
  };
  visit(root);
}
function makeOwnedTreeWritable2(root) {
  if (!existsSync3(root)) return;
  const visit = (entryPath) => {
    const info = lstatSync3(entryPath);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      chmodSync2(entryPath, info.mode | 448);
      for (const entry of readdirSync3(entryPath)) visit(join5(entryPath, entry));
    } else if (info.isFile()) {
      chmodSync2(entryPath, info.mode | 384);
    }
  };
  try {
    visit(root);
  } catch {
  }
}
function removeOwnedTree(root) {
  if (!existsSync3(root)) return;
  makeOwnedTreeWritable2(root);
  rmSync3(root, { recursive: true, force: true });
}
function failedScenePath(runtimeDir, version) {
  return join5(runtimeDir, `${assertSafeVersion(version)}.failed`);
}
function writeFailedScene(runtimeDir, version, stage, error) {
  const destination = failedScenePath(runtimeDir, version);
  const tmp = join5(runtimeDir, `.${version}.failed-tmp-${randomBytes3(4).toString("hex")}`);
  try {
    createPrivateDirectoryNoFollow(tmp);
    const detail = sanitizeInstallerOutput(errorMessage(error), FAILED_ERROR_LIMIT);
    writeFileSync2(join5(tmp, "failure.json"), `${JSON.stringify({
      schemaVersion: 1,
      version,
      stage,
      failedAt: (/* @__PURE__ */ new Date()).toISOString(),
      error: detail
    }, null, 2)}
`, { mode: 384 });
    removeOwnedTree(destination);
    renameSync2(tmp, destination);
    chmodSync2(destination, 448);
  } catch {
    try {
      removeOwnedTree(tmp);
    } catch {
    }
  }
}
function existingRuntimeTreeIsValid(baseDir, version) {
  const structural = validateVersionTree(baseDir, version);
  if (!structural.ok) return false;
  try {
    verifyRuntimeTreeCriticalFiles(structural.path, version);
    return true;
  } catch {
    return false;
  }
}
var BoundedOutput = class {
  value = Buffer.alloc(0);
  truncated = false;
  limit;
  constructor(limit) {
    this.limit = limit;
  }
  append(raw) {
    const chunk = Buffer.from(raw);
    if (chunk.length >= this.limit) {
      this.value = chunk.subarray(chunk.length - this.limit);
      this.truncated = true;
      return;
    }
    const combined = Buffer.concat([this.value, chunk]);
    if (combined.length > this.limit) {
      this.value = combined.subarray(combined.length - this.limit);
      this.truncated = true;
    } else {
      this.value = combined;
    }
  }
  text() {
    return this.value.toString("utf8");
  }
};
function abortError(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(typeof signal.reason === "string" ? signal.reason : "runtime install aborted");
  error.name = "AbortError";
  return error;
}
function delay(ms) {
  return new Promise((resolve3) => {
    setTimeout(resolve3, ms);
  });
}
var RUNTIME_INSTALLER_RESIDUAL_PROCESS_GROUP_ERROR = "ERR_DSH_RESIDUAL_PROCESS_GROUP";
var RUNTIME_INSTALLER_WRITER_UNSAFE_ERROR = "ERR_DSH_WRITER_UNSAFE";
function residualProcessGroupError() {
  return Object.assign(new Error("runtime installer child process group did not exit"), {
    code: RUNTIME_INSTALLER_RESIDUAL_PROCESS_GROUP_ERROR
  });
}
function writerUnsafeError(message, cause) {
  return Object.assign(new Error(message, cause === void 0 ? void 0 : { cause }), {
    code: RUNTIME_INSTALLER_WRITER_UNSAFE_ERROR
  });
}
function isRuntimeInstallerWriterSafetyError(error) {
  const code = error?.code;
  return code === RUNTIME_INSTALLER_RESIDUAL_PROCESS_GROUP_ERROR || code === RUNTIME_INSTALLER_WRITER_UNSAFE_ERROR;
}
var RuntimeInstallerSupervisor = class {
  active = /* @__PURE__ */ new Set();
  disposing = false;
  outputLimit;
  terminateGraceMs;
  constructor(outputLimit = INSTALL_OUTPUT_LIMIT_BYTES, terminateGraceMs = INSTALL_TERMINATE_GRACE_MS) {
    this.outputLimit = outputLimit;
    this.terminateGraceMs = terminateGraceMs;
  }
  get activeCount() {
    return this.active.size;
  }
  /** Signal the whole Unix group. ESRCH alone proves that there is no writer;
   * EPERM means the group is alive but not signalable and must remain fenced.
   * On Windows every signal maps to the same bounded taskkill /T /F tree kill
   * (no POSIX signals exist); a dead leader's residual descendants are killed
   * individually so a daemonized lifecycle script cannot outlive the reap. */
  sendSignal(tracked, signal) {
    const pid = tracked.pid;
    if (pid === null) return tracked.childClosed ? "quiet" : "alive";
    if (process.platform === "win32") {
      try {
        return killWindowsTreeWithResidual(pid) ? "sent" : "quiet";
      } catch (error) {
        throw writerUnsafeError(`runtime installer could not terminate windows child tree (${error.code ?? "unknown error"})`, error);
      }
    }
    try {
      process.kill(-pid, signal);
      return "sent";
    } catch (error) {
      const code = error.code;
      if (code === "ESRCH") return "quiet";
      if (code === "EPERM") return "alive";
      throw writerUnsafeError(`runtime installer could not signal child process group (${code ?? "unknown error"})`, error);
    }
  }
  /** Probe writer liveness without treating an unknown failure as absence.
   * `kill(..., 0)` success and EPERM both mean alive; only ESRCH means quiet.
   * On Windows a dead leader is not proof of quiescence: stale ParentProcessId
   * descendants can keep writing the install tree, so the CIM table is
   * consulted before reporting quiet (fail closed on probe doubt). */
  processGroupState(tracked) {
    const pid = tracked.pid;
    if (pid === null) return tracked.childClosed ? "quiet" : "alive";
    try {
      process.kill(process.platform === "win32" ? pid : -pid, 0);
      return "alive";
    } catch (error) {
      const code = error.code;
      if (code === "ESRCH") {
        if (process.platform !== "win32") return "quiet";
        return hasWindowsDescendants(pid) ? "alive" : "quiet";
      }
      if (code === "EPERM") return "alive";
      throw writerUnsafeError(`runtime installer could not verify child process group (${code ?? "unknown error"})`, error);
    }
  }
  async waitForProcessGroupQuiet(tracked) {
    const deadline = Date.now() + this.terminateGraceMs;
    for (; ; ) {
      if (this.processGroupState(tracked) === "quiet") return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(25, remaining));
    }
  }
  async quiesceProcessGroup(tracked) {
    if (tracked.settled) return;
    if (this.processGroupState(tracked) === "quiet") return;
    const term = this.sendSignal(tracked, "SIGTERM");
    if (term === "quiet" || await this.waitForProcessGroupQuiet(tracked)) return;
    const kill = this.sendSignal(tracked, "SIGKILL");
    if (kill === "quiet" || await this.waitForProcessGroupQuiet(tracked)) return;
    throw residualProcessGroupError();
  }
  /** Coalesce concurrent abort/close/dispose reapers. A failed proof is not
   * cached: dispose may retry, but the tracked writer remains fenced. */
  async ensureProcessGroupQuiet(tracked) {
    if (tracked.settled) return;
    if (tracked.quiescence !== null) return await tracked.quiescence;
    const proof = this.quiesceProcessGroup(tracked);
    tracked.quiescence = proof;
    try {
      await proof;
    } finally {
      if (tracked.quiescence === proof) tracked.quiescence = null;
    }
  }
  finishTracked(tracked) {
    if (tracked.settled) return;
    tracked.settled = true;
    this.active.delete(tracked);
  }
  async terminate(tracked) {
    await this.ensureProcessGroupQuiet(tracked);
    this.finishTracked(tracked);
  }
  /** A lifecycle script may outlive a successfully-exited pnpm parent. Reap
   * the detached group before reporting completion or forgetting its pgid. */
  async reapResidualGroup(tracked) {
    await this.ensureProcessGroupQuiet(tracked);
    this.finishTracked(tracked);
  }
  async disposeTracked(tracked) {
    try {
      await this.terminate(tracked);
    } catch (error) {
      if (isRuntimeInstallerWriterSafetyError(error)) throw error;
      throw writerUnsafeError("runtime installer could not prove writer quiescence during disposal", error);
    }
  }
  async run(args, opts) {
    if (this.disposing) {
      throw writerUnsafeError("runtime installer is shutting down");
    }
    if (this.active.size > 0) {
      throw writerUnsafeError("runtime installer still has an unverified active writer");
    }
    const [file, ...rest] = args;
    if (file === void 0 || file === "") throw new Error("runtime installer command is empty");
    opts.signal?.throwIfAborted();
    const child = spawn(file, rest, {
      cwd: opts.cwd,
      env: { ...scrubInstallEnv(process.env), ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let resolveClosed;
    const tracked = {
      child,
      pid: child.pid ?? null,
      closed: new Promise((resolve3) => {
        resolveClosed = resolve3;
      }),
      resolveClosed: () => resolveClosed(),
      childClosed: false,
      settled: false,
      quiescence: null
    };
    this.active.add(tracked);
    const stdout = new BoundedOutput(this.outputLimit);
    const stderr = new BoundedOutput(this.outputLimit);
    child.stdout?.on("data", (chunk) => stdout.append(chunk));
    child.stderr?.on("data", (chunk) => stderr.append(chunk));
    const completion = new Promise((resolve3, reject) => {
      let forcedError = null;
      let timer = null;
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      const markChildClosed = () => {
        if (tracked.childClosed) return;
        tracked.childClosed = true;
        tracked.resolveClosed();
      };
      const terminateFor = (reason) => {
        forcedError = reason;
        void this.terminate(tracked).then(() => {
          cleanup();
          reject(reason);
        }, (quiescenceError) => {
          cleanup();
          reject(quiescenceError);
        });
      };
      const onAbort = () => {
        terminateFor(abortError(opts.signal));
      };
      if (opts.signal !== void 0) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (opts.timeoutMs !== void 0) {
        timer = setTimeout(() => {
          terminateFor(new Error(`runtime installer child timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }
      child.once("error", (error) => {
        cleanup();
        markChildClosed();
        void this.reapResidualGroup(tracked).then(() => {
          reject(forcedError ?? error);
        }, (quiescenceError) => {
          reject(quiescenceError);
        });
      });
      child.once("close", (code) => {
        cleanup();
        markChildClosed();
        void this.reapResidualGroup(tracked).then(() => {
          if (forcedError !== null) reject(forcedError);
          else resolve3({
            status: code,
            stdout: stdout.text(),
            stderr: stderr.text(),
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated
          });
        }, (error) => {
          reject(error);
        });
      });
    });
    try {
      if (child.pid !== void 0) opts.onSpawn?.(child.pid);
    } catch (onSpawnError) {
      try {
        await this.terminate(tracked);
      } catch (quiescenceError) {
        if (isRuntimeInstallerWriterSafetyError(quiescenceError)) throw quiescenceError;
        throw writerUnsafeError("runtime installer onSpawn failed and writer quiescence is unknown", quiescenceError);
      }
      const completionError = await completion.then(() => null, (error) => error);
      if (isRuntimeInstallerWriterSafetyError(completionError)) throw completionError;
      throw onSpawnError;
    }
    return await completion;
  }
  /** App-quit hook: stop accepting work and reap every pnpm/process group. */
  async dispose() {
    this.disposing = true;
    const results = await Promise.allSettled([...this.active].map((tracked) => this.disposeTracked(tracked)));
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length > 0) {
      if (failures.length === 1) throw failures[0];
      throw Object.assign(new AggregateError(failures, "runtime installer writers did not become quiescent"), {
        code: RUNTIME_INSTALLER_WRITER_UNSAFE_ERROR
      });
    }
    if (this.active.size > 0) {
      throw writerUnsafeError("runtime installer disposal completed without proving every writer quiescent");
    }
  }
  /** Reopen the supervisor after a disposal that PROVED writer quiescence
   * (same-process host restart, e.g. gateway stop → start). Only a fully
   * settled disposal may reset: while any writer is still tracked, the
   * shutting-down latch must stay so an unproven writer never gets
   * concurrent work (review fix — the module latch reset alone left
   * `defaultSupervisor.disposing` true forever, rejecting every later
   * install/prune in the same process). */
  reset() {
    if (this.active.size > 0) throw writerUnsafeError("runtime installer cannot reset while writers are still tracked");
    this.disposing = false;
  }
};
var defaultSupervisor = new RuntimeInstallerSupervisor();
var activeInstallerOperations = /* @__PURE__ */ new Set();
var runtimeInstallerDisposing = false;
var runtimeInstallerPoisoned = false;
var runtimeInstallerDisposePromise = null;
function disposeRuntimeInstaller(deps = {}) {
  if (runtimeInstallerDisposePromise !== null) return runtimeInstallerDisposePromise;
  runtimeInstallerDisposing = true;
  runtimeInstallerPoisoned = true;
  const proof = (async () => {
    const supervisorProof = Promise.allSettled([defaultSupervisor.dispose()]);
    while (activeInstallerOperations.size > 0) {
      const operations2 = [...activeInstallerOperations];
      for (const operation of operations2) {
        operation.controller.abort(new Error("runtime installer is shutting down"));
      }
      await Promise.allSettled(operations2.map((operation) => operation.closed));
    }
    const [supervisorResult] = await supervisorProof;
    if (supervisorResult.status === "rejected") throw supervisorResult.reason;
    deps.beforeReset?.();
    defaultSupervisor.reset();
    runtimeInstallerPoisoned = false;
  })();
  runtimeInstallerDisposePromise = proof.then(
    () => {
      runtimeInstallerDisposing = false;
      runtimeInstallerDisposePromise = null;
    },
    (error) => {
      runtimeInstallerDisposing = false;
      runtimeInstallerDisposePromise = null;
      throw error;
    }
  );
  return runtimeInstallerDisposePromise;
}
function resolveInstallerNodeExecutable() {
  return { file: process.execPath, args: [], env: {} };
}
function assertInstallResolution(resolution) {
  if (resolution.packageName !== "@deepseek-ai/dsh") {
    throw new Error(`unexpected runtime package: ${resolution.packageName}`);
  }
  assertSafeVersion(resolution.version);
  const origin = canonicalRegistryOrigin(resolution.registryOrigin);
  if (origin === null || origin !== resolution.registryOrigin) {
    throw new Error(`invalid bound registry origin: ${resolution.registryOrigin}`);
  }
  if (!isAllowedRegistryUrl(resolution.tarball, registryRedirectOrigins(origin))) {
    throw new Error("bound runtime tarball is outside the registry whitelist");
  }
  if (!isSupportedIntegrity(resolution.integrity)) {
    throw new Error("bound runtime tarball has no supported integrity");
  }
  return resolution;
}
async function downloadVerifiedRegistryTarball(rawResolution, destination, opts) {
  const resolution = assertInstallResolution(rawResolution);
  const maxBytes = opts.maxBytes ?? DEFAULT_TARBALL_MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error(`invalid registry tarball limit: ${maxBytes}`);
  const verifier = createIntegrityVerifier(resolution.integrity);
  let file = null;
  try {
    const { response } = await fetchRegistryResponse(resolution.tarball, {
      allowedOrigins: registryRedirectOrigins(resolution.registryOrigin),
      signal: opts.signal,
      fetchImpl: opts.fetchImpl
    });
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => {
      });
      throw new Error(`registry tarball fetch failed: HTTP ${response.status}`);
    }
    const rawLength = response.headers.get("content-length");
    const declaredLength = rawLength === null ? Number.NaN : Number(rawLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body.cancel().catch(() => {
      });
      throw new Error(`registry tarball exceeds ${maxBytes} bytes`);
    }
    const total = Number.isFinite(declaredLength) && declaredLength >= 0 ? declaredLength : null;
    file = await open(destination, "wx", 384);
    let received = 0;
    for await (const raw of response.body) {
      opts.signal.throwIfAborted();
      const chunk = Buffer.from(raw);
      if (received + chunk.length > maxBytes) throw new Error(`registry tarball exceeds ${maxBytes} bytes`);
      let offset = 0;
      while (offset < chunk.length) {
        opts.signal.throwIfAborted();
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset, null);
        if (bytesWritten === 0) throw new Error("registry tarball write made no progress");
        verifier.update(chunk.subarray(offset, offset + bytesWritten));
        offset += bytesWritten;
        received += bytesWritten;
        opts.onProgress?.(received, total);
      }
    }
    opts.signal.throwIfAborted();
    verifier.assertMatch();
    await file.sync();
  } catch (error) {
    await file?.close().catch(() => {
    });
    file = null;
    rmSync3(destination, { force: true });
    throw error;
  } finally {
    await file?.close().catch(() => {
    });
  }
}
async function defaultPrune(root) {
  const mod = await Promise.resolve().then(() => (init_prune_runtime(), prune_runtime_exports));
  return mod.pruneRuntimeArtifacts(root);
}
function createOperationDeadline(external, timeoutMs) {
  if (runtimeInstallerDisposing || runtimeInstallerPoisoned) {
    throw writerUnsafeError(runtimeInstallerDisposing ? "runtime installer is shutting down" : "runtime installer writer quiescence is unproven");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid install timeout: ${timeoutMs}`);
  const controller = new AbortController();
  let resolveClosed;
  const tracked = {
    controller,
    closed: new Promise((resolve3) => {
      resolveClosed = resolve3;
    }),
    resolveClosed: () => resolveClosed()
  };
  activeInstallerOperations.add(tracked);
  const forwardAbort = () => controller.abort(external?.reason);
  if (external?.aborted) forwardAbort();
  else external?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`dsh runtime install timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  let cleaned = false;
  return {
    signal: controller.signal,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      external?.removeEventListener("abort", forwardAbort);
      activeInstallerOperations.delete(tracked);
      tracked.resolveClosed();
    }
  };
}
function reclaimRuntimeCacheContents(baseDir) {
  ensureRuntimeRootNoFollow(baseDir);
  for (const segment of [".pnpm-cache", ".xdg-cache"]) {
    const dir = ensureRuntimeSubdirectoryNoFollow(baseDir, segment);
    let entries;
    try {
      entries = readdirSync3(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = join5(dir, entry.name);
      let info;
      try {
        info = lstatSync3(entryPath);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      rmSync3(entryPath, { recursive: info.isDirectory() && !info.isSymbolicLink(), force: true });
    }
  }
}
async function pruneRuntimeStore(opts) {
  const runtimeDir = ensureRuntimeRootNoFollow(opts.baseDir);
  const deadline = createOperationDeadline(opts.signal, opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS);
  const storeDir = join5(runtimeDir, ".pnpm-store");
  const installHome = join5(runtimeDir, ".install-home");
  const xdgCacheDir = join5(runtimeDir, ".xdg-cache");
  const npmrc = join5(runtimeDir, ".npmrc");
  const nodeFn = opts.deps?.node ?? resolveInstallerNodeExecutable;
  const runFn = opts.deps?.run ?? ((args, runOpts) => defaultSupervisor.run(args, runOpts));
  try {
    ensureRuntimeSubdirectoryNoFollow(opts.baseDir, ".pnpm-store");
    ensureRuntimeSubdirectoryNoFollow(opts.baseDir, ".install-home");
    ensureRuntimeSubdirectoryNoFollow(opts.baseDir, ".xdg-cache");
    atomicWriteRuntimeFileNoFollow(opts.baseDir, npmrc, "");
    const node = nodeFn();
    deadline.signal.throwIfAborted();
    const result = await runFn([
      node.file,
      ...node.args,
      opts.pnpmEntry,
      "store",
      "prune",
      "--store-dir",
      storeDir
    ], {
      cwd: runtimeDir,
      env: {
        ...node.env,
        HOME: installHome,
        XDG_CACHE_HOME: xdgCacheDir,
        NPM_CONFIG_USERCONFIG: npmrc
      },
      signal: deadline.signal
    });
    deadline.signal.throwIfAborted();
    if (result.status !== 0) {
      const detail = sanitizeInstallerOutput((result.stderr || result.stdout).trim(), 800);
      throw new Error(`dsh runtime store prune failed (exit ${result.status}): ${detail}`);
    }
    const request = readStorePruneRequest(opts.baseDir);
    if (request !== null && request.reasons.includes("cache-reclaim")) {
      reclaimRuntimeCacheContents(opts.baseDir);
    }
  } finally {
    deadline.cleanup();
  }
}
async function defaultSmoke(node, run, workDir, version, context) {
  const n = node();
  const bin = join5(workDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  const res = await run([n.file, ...n.args, bin, "--version"], {
    cwd: workDir,
    env: n.env,
    signal: context.signal,
    onSpawn: context.onSpawn
  });
  if (res.status !== 0 || res.stdout.trim() !== version) {
    const detail = sanitizeInstallerOutput((res.stderr || res.stdout).trim(), 500);
    throw new Error(`dsh smoke check failed (exit ${res.status}, want ${version}): ${detail}`);
  }
}
async function installRuntimeVersion(opts) {
  const resolution = assertInstallResolution(opts.resolution);
  const version = resolution.version;
  const runtimeDir = ensureRuntimeRootNoFollow(opts.baseDir);
  const versionTreeDir = join5(runtimeDir, version);
  if (existsSync3(versionTreeDir) && existingRuntimeTreeIsValid(opts.baseDir, version)) {
    throw new Error(`dsh runtime ${version} is already installed and valid; refusing to overwrite it`);
  }
  const workDir = join5(runtimeDir, `.work-${randomBytes3(4).toString("hex")}`);
  const backupDir = join5(runtimeDir, `.${version}.publish-backup-${randomBytes3(4).toString("hex")}`);
  let stage = "prepare";
  let deadline = null;
  let previousTreeBackedUp = false;
  let workPublished = false;
  let completed = false;
  let preserveWorkDir = false;
  const restorePreviousTree = (renameFn) => {
    assertRuntimeRootNoFollow(opts.baseDir);
    if (workPublished && existsSync3(versionTreeDir)) {
      removeOwnedTree(versionTreeDir);
      workPublished = false;
    }
    if (previousTreeBackedUp && existsSync3(backupDir)) {
      renameFn(backupDir, versionTreeDir);
      previousTreeBackedUp = false;
    }
  };
  try {
    deadline = createOperationDeadline(opts.signal, opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS);
    const nodeFn = opts.deps?.node ?? resolveInstallerNodeExecutable;
    const runFn = opts.deps?.run ?? ((args, runOpts) => defaultSupervisor.run(args, runOpts));
    const downloadFn = opts.deps?.download ?? downloadVerifiedRegistryTarball;
    const pruneFn = opts.deps?.prune ?? defaultPrune;
    const renameFn = opts.deps?.rename ?? renameSync2;
    const makeReadOnlyFn = opts.deps?.makeReadOnly ?? makeRuntimeTreeReadOnly;
    const verifyPublishedFn = opts.deps?.verifyPublished ?? verifyRuntimeTreeCriticalFiles;
    const storeDir = join5(runtimeDir, ".pnpm-store");
    const cacheDir = join5(runtimeDir, ".pnpm-cache");
    const installHome = join5(runtimeDir, ".install-home");
    const xdgCacheDir = join5(runtimeDir, ".xdg-cache");
    const npmrc = join5(runtimeDir, ".npmrc");
    const pidPath = join5(workDir, "pid");
    const tarballPath = join5(workDir, "dsh-runtime-package.tgz");
    const statePath = join5(workDir, "state");
    const writeState = (value) => {
      atomicWriteRuntimeFileNoFollow(opts.baseDir, statePath, `${value}
`);
    };
    const noteChildPid = (pid) => {
      atomicWriteRuntimeFileNoFollow(opts.baseDir, pidPath, String(pid));
      writeState("spawned");
    };
    const runCommand = async (args, runOpts) => {
      writeState("spawning");
      try {
        return await runFn(args, {
          ...runOpts,
          signal: deadline.signal,
          onSpawn: noteChildPid
        });
      } catch (error) {
        writeState("failed");
        throw error;
      }
    };
    createPrivateDirectoryNoFollow(workDir);
    ensureRuntimeSubdirectoryNoFollow(opts.baseDir, ".pnpm-store");
    ensureRuntimeSubdirectoryNoFollow(opts.baseDir, ".pnpm-cache");
    ensureRuntimeSubdirectoryNoFollow(opts.baseDir, ".install-home");
    ensureRuntimeSubdirectoryNoFollow(opts.baseDir, ".xdg-cache");
    atomicWriteRuntimeFileNoFollow(opts.baseDir, npmrc, "");
    writeState("preparing");
    atomicWriteRuntimeFileNoFollow(opts.baseDir, join5(workDir, "package.json"), `${JSON.stringify({
      name: "dsh-runtime-install",
      version: "0.0.0",
      private: true,
      dependencies: { "@deepseek-ai/dsh": "file:./dsh-runtime-package.tgz" }
    }, null, 2)}
`);
    atomicWriteRuntimeFileNoFollow(opts.baseDir, join5(workDir, "pnpm-workspace.yaml"), `minimumReleaseAge: 0
allowBuilds:
${ALLOW_BUILDS.map((name) => `  ${JSON.stringify(name)}: true`).join("\n")}
`);
    const nodeWithSandbox = () => {
      const resolved = nodeFn();
      return {
        ...resolved,
        env: {
          ...resolved.env,
          HOME: installHome,
          XDG_CACHE_HOME: xdgCacheDir
        }
      };
    };
    const smokeFn = opts.deps?.smoke ?? ((work, ver, context) => defaultSmoke(nodeWithSandbox, runFn, work, ver, context));
    const node = nodeWithSandbox();
    const installArgs = [
      node.file,
      ...node.args,
      opts.pnpmEntry,
      "install",
      "--config.node-linker=hoisted",
      "--store-dir",
      storeDir,
      "--cache-dir",
      cacheDir,
      "--registry",
      resolution.registryOrigin,
      "--fetch-retries=0"
    ];
    const installEnv = { ...node.env, NPM_CONFIG_USERCONFIG: npmrc };
    stage = "download";
    deadline.signal.throwIfAborted();
    const reportStage = (next) => opts.onProgress?.(next);
    reportStage({ stage: "download", received: 0, total: null });
    await downloadFn(resolution, tarballPath, {
      signal: deadline.signal,
      onProgress: (received, total) => reportStage({ stage: "download", received, total })
    });
    deadline.signal.throwIfAborted();
    stage = "install";
    reportStage({ stage: "install" });
    let res = await runCommand(installArgs, { cwd: workDir, env: installEnv });
    if (res.status !== 0) {
      deadline.signal.throwIfAborted();
      res = await runCommand(installArgs, { cwd: workDir, env: installEnv });
    }
    if (res.status !== 0) {
      const detail = sanitizeInstallerOutput((res.stderr || res.stdout).trim(), 800);
      throw new Error(`dsh runtime install failed (exit ${res.status}): ${detail}`);
    }
    rmSync3(tarballPath, { force: true });
    stage = "prune";
    reportStage({ stage: "prune" });
    await pruneFn(workDir);
    deadline.signal.throwIfAborted();
    stage = "smoke";
    reportStage({ stage: "smoke" });
    await smokeFn(workDir, version, {
      signal: deadline.signal,
      onSpawn: noteChildPid
    });
    deadline.signal.throwIfAborted();
    stage = "manifest";
    const manifest = JSON.parse(readFileSync2(join5(workDir, "package.json"), "utf8"));
    manifest.dependencies = { "@deepseek-ai/dsh": version };
    manifest.dsh = {
      platform: `${process.platform}-${process.arch}`,
      registryOrigin: resolution.registryOrigin,
      integrity: resolution.integrity,
      criticalFiles: computeCriticalDigests(workDir, version)
    };
    atomicWriteRuntimeFileNoFollow(opts.baseDir, join5(workDir, "package.json"), `${JSON.stringify(manifest, null, 2)}
`);
    rmSync3(pidPath, { force: true });
    deadline.signal.throwIfAborted();
    stage = "publish";
    reportStage({ stage: "publish" });
    assertRuntimeRootNoFollow(opts.baseDir);
    if (existsSync3(versionTreeDir)) {
      if (existingRuntimeTreeIsValid(opts.baseDir, version)) {
        throw new Error(`dsh runtime ${version} became valid during install; refusing to overwrite it`);
      }
      renameFn(versionTreeDir, backupDir);
      previousTreeBackedUp = true;
    }
    try {
      renameFn(workDir, versionTreeDir);
      workPublished = true;
    } catch (publishError) {
      try {
        restorePreviousTree(renameFn);
      } catch (restoreError) {
        throw new Error(`runtime publish failed and the previous tree could not be restored: ${sanitizeInstallerOutput(errorMessage(restoreError), 500)}`, { cause: publishError });
      }
      throw publishError;
    }
    stage = "finalize";
    try {
      makeReadOnlyFn(versionTreeDir);
      verifyPublishedFn(versionTreeDir, version);
      deadline.signal.throwIfAborted();
    } catch (finalizeError) {
      try {
        restorePreviousTree(renameFn);
      } catch (restoreError) {
        throw new Error(`runtime finalization failed and the previous tree could not be restored: ${sanitizeInstallerOutput(errorMessage(restoreError), 500)}`, { cause: finalizeError });
      }
      throw finalizeError;
    }
    completed = true;
    if (previousTreeBackedUp) {
      try {
        removeOwnedTree(backupDir);
      } catch {
      }
      previousTreeBackedUp = false;
    }
    try {
      removeOwnedTree(failedScenePath(runtimeDir, version));
    } catch {
    }
    reportStage({ stage: "done" });
    return { versionTreeDir, resolvedVersion: version };
  } catch (error) {
    preserveWorkDir = isRuntimeInstallerWriterSafetyError(error);
    if (!completed) {
      if (previousTreeBackedUp || workPublished) {
        const renameFn = opts.deps?.rename ?? renameSync2;
        try {
          restorePreviousTree(renameFn);
        } catch {
        }
      }
      try {
        assertRuntimeRootNoFollow(opts.baseDir);
        writeFailedScene(runtimeDir, version, stage, error);
      } catch {
      }
    }
    throw error;
  } finally {
    deadline?.cleanup();
    if (!preserveWorkDir) {
      try {
        assertRuntimeRootNoFollow(opts.baseDir);
        removeOwnedTree(workDir);
      } catch {
      }
    }
  }
}

// src/runtime-metadata-recovery.ts
import {
  chmodSync as chmodSync3,
  closeSync as closeSync3,
  constants as constants3,
  existsSync as existsSync5,
  fstatSync as fstatSync3,
  fsyncSync as fsyncSync2,
  lstatSync as lstatSync5,
  mkdirSync as mkdirSync2,
  openSync as openSync3,
  readFileSync as readFileSync3,
  readlinkSync,
  readSync as readSync3,
  readdirSync as readdirSync4,
  realpathSync as realpathSync3,
  renameSync as renameSync3,
  rmSync as rmSync4,
  symlinkSync,
  writeFileSync as writeFileSync3,
  writeSync
} from "node:fs";
import { createHash as createHash4, randomBytes as randomBytes5 } from "node:crypto";
import { basename as basename6, dirname as dirname4, isAbsolute as isAbsolute3, join as join7, relative as relative4, resolve as resolve2, sep as sep3 } from "node:path";

// src/snapshot-store.ts
import { cp, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import {
  closeSync as closeSync2,
  constants as constants2,
  existsSync as existsSync4,
  fchmodSync as fchmodSync2,
  fstatSync as fstatSync2,
  lstatSync as lstatSync4,
  openSync as openSync2,
  readSync as readSync2
} from "node:fs";
import { basename as basename5, dirname as dirname3, join as join6, resolve, sep as sep2 } from "node:path";
import { randomBytes as randomBytes4 } from "node:crypto";

// src/rename-retry.ts
import { rename as renameFile } from "node:fs/promises";
var WINDOWS_RENAME_RETRY_DELAYS_MS = [100, 250, 500, 1e3];
function isTransientWindowsRenameError(error) {
  const code = error?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}
function delay2(ms) {
  return new Promise((resolve3) => {
    setTimeout(resolve3, ms);
  });
}
async function renameWithWindowsRetry(from, to, deps = {}) {
  const rename2 = deps.renameFn ?? renameFile;
  const isWindows = deps.isWindows ?? process.platform === "win32";
  if (!isWindows) {
    await rename2(from, to);
    return;
  }
  const sleep = deps.sleep ?? delay2;
  let lastError;
  for (let attempt = 0; attempt <= WINDOWS_RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await rename2(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientWindowsRenameError(error)) throw error;
      if (attempt < WINDOWS_RENAME_RETRY_DELAYS_MS.length) {
        await sleep(WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastError;
}

// src/snapshot-store.ts
var PRIVATE_DIR_MODE = 448;
var PRIVATE_FILE_MODE = 384;
var MAX_RESTORE_MARKER_BYTES = 128 * 1024;
function sameIdentity3(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameFileSnapshot2(left, right) {
  return sameIdentity3(left, right) && left.isFile() && right.isFile() && left.nlink === 1 && right.nlink === 1 && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function readRestoreMarkerAuthority(baseDir) {
  const markerPath = snapshotPaths(baseDir).restoreMarker;
  const parent = dirname3(markerPath);
  let parentBefore;
  try {
    parentBefore = lstatSync4(parent);
  } catch (error) {
    return error.code === "ENOENT" ? { kind: "missing" } : { kind: "unsafe" };
  }
  if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) return { kind: "unsafe" };
  let leafBefore;
  try {
    leafBefore = lstatSync4(markerPath);
  } catch (error) {
    if (error.code !== "ENOENT") return { kind: "unsafe" };
    try {
      const parentAfter = lstatSync4(parent);
      return parentAfter.isDirectory() && !parentAfter.isSymbolicLink() && sameIdentity3(parentBefore, parentAfter) ? { kind: "missing" } : { kind: "unsafe" };
    } catch {
      return { kind: "unsafe" };
    }
  }
  if (leafBefore.isSymbolicLink() || !leafBefore.isFile() || leafBefore.nlink !== 1 || leafBefore.size < 0 || leafBefore.size > MAX_RESTORE_MARKER_BYTES) return { kind: "unsafe" };
  let fd = null;
  try {
    fd = openSync2(markerPath, constants2.O_RDONLY | constants2.O_NOFOLLOW);
    const opened = fstatSync2(fd);
    const parentOpened = lstatSync4(parent);
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity3(leafBefore, opened) || parentOpened.isSymbolicLink() || !parentOpened.isDirectory() || !sameIdentity3(parentBefore, parentOpened)) return { kind: "unsafe" };
    fchmodSync2(fd, PRIVATE_FILE_MODE);
    const beforeRead = fstatSync2(fd);
    if (!beforeRead.isFile() || beforeRead.nlink !== 1 || beforeRead.size > MAX_RESTORE_MARKER_BYTES) {
      return { kind: "unsafe" };
    }
    const buffer = Buffer.allocUnsafe(MAX_RESTORE_MARKER_BYTES + 1);
    let offset = 0;
    while (offset <= MAX_RESTORE_MARKER_BYTES) {
      const count = readSync2(fd, buffer, offset, MAX_RESTORE_MARKER_BYTES + 1 - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_RESTORE_MARKER_BYTES || offset !== beforeRead.size) return { kind: "unsafe" };
    const afterRead = fstatSync2(fd);
    const leafAfter = lstatSync4(markerPath);
    const parentAfter = lstatSync4(parent);
    if (!sameFileSnapshot2(beforeRead, afterRead) || leafAfter.isSymbolicLink() || !leafAfter.isFile() || leafAfter.nlink !== 1 || !sameIdentity3(afterRead, leafAfter) || parentAfter.isSymbolicLink() || !parentAfter.isDirectory() || !sameIdentity3(parentBefore, parentAfter)) return { kind: "unsafe" };
    return { kind: "valid", raw: buffer.subarray(0, offset).toString("utf8") };
  } catch {
    return { kind: "unsafe" };
  } finally {
    if (fd !== null) {
      try {
        closeSync2(fd);
      } catch {
      }
    }
  }
}
function restoreMarkerAuthorityStatus(baseDir) {
  const state = readRestoreMarkerAuthority(baseDir);
  if (state.kind === "missing") return "missing";
  return state.kind === "valid" ? "present" : "unsafe";
}
function snapshotPaths(baseDir) {
  const runtime = join6(baseDir, "dsh-runtime");
  return {
    snapshotsDir: join6(runtime, "snapshots"),
    preRollbackDir: join6(runtime, "pre-rollback"),
    restoreMarker: join6(runtime, "restore-in-progress")
  };
}
var defaultCopy = async (src, dest) => {
  await cp(src, dest, { recursive: true });
};
async function ensurePrivateDir(dir) {
  try {
    await mkdir(dir, { recursive: false, mode: PRIVATE_DIR_MODE });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (!tightenOwnedDirectory(dir)) throw new Error(`\u4E0D\u5B89\u5168\u7684\u79C1\u6709\u76EE\u5F55\uFF1A${basename5(dir)}`);
}
async function ensureRuntimeSubdir(baseDir, dir) {
  const runtimeDir = dirname3(snapshotPaths(baseDir).snapshotsDir);
  await ensurePrivateDir(runtimeDir);
  await ensurePrivateDir(dir);
}
async function atomicWriteMarker(filePath, marker) {
  await ensurePrivateDir(dirname3(filePath));
  const tmp = `${filePath}.tmp-${randomBytes4(4).toString("hex")}`;
  try {
    await writeFile(tmp, `${JSON.stringify(marker, null, 2)}
`, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE,
      flag: "wx"
    });
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {
    });
    throw error;
  }
}
async function pathIsDirectoryNoFollow(path) {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}
function ownedDirectoryState(path) {
  const parent = dirname3(path);
  let parentBefore;
  try {
    parentBefore = lstatSync4(parent);
  } catch (error) {
    return error.code === "ENOENT" ? "missing" : "unsafe";
  }
  if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) return "unsafe";
  try {
    const info = lstatSync4(path);
    const parentAfter = lstatSync4(parent);
    return !info.isSymbolicLink() && info.isDirectory() && parentAfter.isDirectory() && !parentAfter.isSymbolicLink() && sameIdentity3(parentBefore, parentAfter) ? "directory" : "unsafe";
  } catch (error) {
    if (error.code !== "ENOENT") return "unsafe";
    try {
      const parentAfter = lstatSync4(parent);
      return parentAfter.isDirectory() && !parentAfter.isSymbolicLink() && sameIdentity3(parentBefore, parentAfter) ? "missing" : "unsafe";
    } catch {
      return "unsafe";
    }
  }
}
function entryExistsNoFollow(path) {
  try {
    lstatSync4(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    return true;
  }
}
function tightenOwnedDirectory(path) {
  const parent = dirname3(path);
  let parentBefore;
  try {
    parentBefore = lstatSync4(parent);
  } catch {
    return false;
  }
  if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) return false;
  let before;
  try {
    before = lstatSync4(path);
  } catch {
    return false;
  }
  if (before.isSymbolicLink() || !before.isDirectory()) return false;
  let fd = null;
  try {
    fd = openSync2(path, constants2.O_RDONLY | constants2.O_NOFOLLOW);
    const opened = fstatSync2(fd);
    if (!opened.isDirectory() || !sameIdentity3(before, opened)) return false;
    fchmodSync2(fd, PRIVATE_DIR_MODE);
    const afterFd = fstatSync2(fd);
    const afterPath = lstatSync4(path);
    const parentAfter = lstatSync4(parent);
    return afterFd.isDirectory() && afterPath.isDirectory() && !afterPath.isSymbolicLink() && sameIdentity3(opened, afterFd) && sameIdentity3(afterFd, afterPath) && parentAfter.isDirectory() && !parentAfter.isSymbolicLink() && sameIdentity3(parentBefore, parentAfter);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync2(fd);
      } catch {
      }
    }
  }
}
async function removeCrashTemporaryEntries(root, relativeRoot) {
  const rootState = ownedDirectoryState(root);
  if (rootState === "missing") return [];
  if (rootState === "unsafe") throw new Error(`${relativeRoot} \u6839\u76EE\u5F55\u4E0D\u5B89\u5168\uFF0C\u62D2\u7EDD\u6E05\u7406`);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(".tmp-")) continue;
    await rm(join6(root, entry.name), { recursive: true, force: true });
    removed.push(`${relativeRoot}/${entry.name}`);
  }
  return removed;
}
function restoreBackupNameMatches(homeName, entryName) {
  return entryName === `${homeName}.old` || entryName.startsWith(`${homeName}.old-`);
}
function backupNameTimestamp(homeName, entryName) {
  if (entryName === `${homeName}.old`) return 0;
  const match = /^(\d+)(?:-|$)/.exec(entryName.slice(`${homeName}.old-`.length));
  if (match === null) return 0;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : 0;
}
async function cleanupSnapshotArtifacts(baseDir, dshHome) {
  const paths = snapshotPaths(baseDir);
  const result = {
    removedTemporaryEntries: [],
    removedRestoreBackups: [],
    restoreBackupCleanup: "completed"
  };
  if (restoreMarkerAuthorityStatus(baseDir) !== "missing") {
    result.restoreBackupCleanup = "blocked-marker";
    return result;
  }
  if (ownedDirectoryState(paths.snapshotsDir) === "unsafe" || ownedDirectoryState(paths.preRollbackDir) === "unsafe") {
    result.restoreBackupCleanup = "blocked-unsafe-entry";
    return result;
  }
  result.removedTemporaryEntries.push(
    ...await removeCrashTemporaryEntries(paths.snapshotsDir, "snapshots"),
    ...await removeCrashTemporaryEntries(paths.preRollbackDir, "pre-rollback")
  );
  const resolvedHome = resolve(dshHome);
  const homeState = ownedDirectoryState(resolvedHome);
  if (homeState === "missing") {
    result.restoreBackupCleanup = "blocked-home-missing";
    return result;
  }
  if (homeState === "unsafe") {
    result.restoreBackupCleanup = "blocked-unsafe-entry";
    return result;
  }
  if (restoreMarkerAuthorityStatus(baseDir) !== "missing") {
    result.restoreBackupCleanup = "blocked-marker";
    return result;
  }
  const homeParent = dirname3(resolvedHome);
  const homeName = basename5(resolvedHome);
  if (ownedDirectoryState(homeParent) !== "directory") {
    result.restoreBackupCleanup = "blocked-unsafe-entry";
    return result;
  }
  let siblingEntries;
  try {
    siblingEntries = await readdir(homeParent, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      result.restoreBackupCleanup = "blocked-home-missing";
      return result;
    }
    throw error;
  }
  const backups = [];
  for (const entry of siblingEntries) {
    if (!restoreBackupNameMatches(homeName, entry.name)) continue;
    const path = join6(homeParent, entry.name);
    let info;
    try {
      info = await lstat(path);
    } catch {
      result.restoreBackupCleanup = "blocked-unsafe-entry";
      return result;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      result.restoreBackupCleanup = "blocked-unsafe-entry";
      return result;
    }
    backups.push({
      name: entry.name,
      path,
      recencyMs: Math.max(info.mtimeMs, info.ctimeMs, info.birthtimeMs, backupNameTimestamp(homeName, entry.name))
    });
  }
  backups.sort((a, b) => b.recencyMs - a.recencyMs || b.name.localeCompare(a.name));
  for (const backup of backups.slice(1)) {
    if (ownedDirectoryState(homeParent) !== "directory" || ownedDirectoryState(backup.path) !== "directory") {
      result.restoreBackupCleanup = "blocked-unsafe-entry";
      return result;
    }
    await rm(backup.path, { recursive: true, force: true });
    result.removedRestoreBackups.push(backup.name);
  }
  return result;
}
async function isPublishedSnapshotPath(baseDir, path) {
  const { snapshotsDir } = snapshotPaths(baseDir);
  if (ownedDirectoryState(snapshotsDir) !== "directory") return false;
  const candidate = resolve(path);
  if (dirname3(candidate) !== resolve(snapshotsDir)) return false;
  if (parseSnapshotEntry(snapshotsDir, basename5(candidate)) === null) return false;
  return pathIsDirectoryNoFollow(candidate);
}
async function isPublishedStashPath(baseDir, path) {
  const { preRollbackDir } = snapshotPaths(baseDir);
  if (ownedDirectoryState(preRollbackDir) !== "directory") return false;
  const candidate = resolve(path);
  if (dirname3(candidate) !== resolve(preRollbackDir)) return false;
  if (!isStashName(basename5(candidate))) return false;
  return ownedDirectoryState(candidate) === "directory";
}
async function isPublishedRestoreSource(baseDir, path) {
  if (await isPublishedSnapshotPath(baseDir, path)) return true;
  return isPublishedStashPath(baseDir, path);
}
function pathIsInside(path, parent) {
  const candidate = resolve(path);
  const root = resolve(parent);
  return candidate === root || candidate.startsWith(`${root}${sep2}`);
}
function safeSnapshotSource(sourceVersion) {
  return assertSafeVersion(sourceVersion);
}
async function nextSnapshotPath(snapshotsDir, sourceVersion) {
  let timestamp = Date.now();
  let candidate = join6(snapshotsDir, `${sourceVersion}-${timestamp}`);
  while (existsSync4(candidate)) {
    timestamp += 1;
    candidate = join6(snapshotsDir, `${sourceVersion}-${timestamp}`);
  }
  return candidate;
}
async function snapshotDshHome(baseDir, dshHome, sourceVersion, copyFn = defaultCopy) {
  const paths = snapshotPaths(baseDir);
  const safeSource = safeSnapshotSource(sourceVersion);
  await ensureRuntimeSubdir(baseDir, paths.snapshotsDir);
  const staging = join6(paths.snapshotsDir, `.tmp-${randomBytes4(6).toString("hex")}`);
  const finalPath = await nextSnapshotPath(paths.snapshotsDir, safeSource);
  await ensurePrivateDir(staging);
  try {
    const sourceState = ownedDirectoryState(dshHome);
    if (sourceState === "unsafe") throw new Error("DSH_HOME \u4E0D\u662F\u5B89\u5168\u7684\u771F\u5B9E\u76EE\u5F55");
    if (sourceState === "directory") await copyFn(dshHome, staging);
    if (ownedDirectoryState(paths.snapshotsDir) !== "directory" || !tightenOwnedDirectory(staging)) throw new Error("\u5FEB\u7167\u6682\u5B58\u76EE\u5F55\u8EAB\u4EFD\u4E0D\u518D\u53EF\u4FE1");
    await renameWithWindowsRetry(staging, finalPath);
    if (ownedDirectoryState(paths.snapshotsDir) !== "directory" || !tightenOwnedDirectory(finalPath)) throw new Error("\u5FEB\u7167\u53D1\u5E03\u76EE\u5F55\u8EAB\u4EFD\u4E0D\u518D\u53EF\u4FE1");
    return finalPath;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {
    });
    throw error;
  }
}
function newTransactionPaths(dshHome) {
  const id = `${Date.now()}-${randomBytes4(5).toString("hex")}`;
  const stagingPath = join6(dirname3(dshHome), `.${basename5(dshHome)}.restore-${id}`);
  const preferredBackup = `${dshHome}.old`;
  const backupPath = entryExistsNoFollow(preferredBackup) ? `${preferredBackup}-${id}` : preferredBackup;
  return { stagingPath, backupPath };
}
function isRestorePhase(value) {
  return value === "copying" || value === "staged" || value === "backing-up" || value === "publishing" || value === "published";
}
function parseMarker(raw, baseDir, dshHome) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed;
  if (record.schemaVersion === void 0) {
    return typeof record.snapshotPath === "string" && record.snapshotPath !== "" ? { legacySnapshotPath: record.snapshotPath } : null;
  }
  if (record.schemaVersion !== 1 || !isRestorePhase(record.phase)) return null;
  if (typeof record.snapshotPath !== "string" || typeof record.dshHome !== "string") return null;
  if (typeof record.stagingPath !== "string" || typeof record.backupPath !== "string") return null;
  if (typeof record.hadDshHome !== "boolean" || typeof record.startedAt !== "number" || typeof record.updatedAt !== "number") return null;
  if (resolve(record.dshHome) !== resolve(dshHome)) return null;
  if (!pathIsInside(record.snapshotPath, snapshotPaths(baseDir).snapshotsDir) && !pathIsInside(record.snapshotPath, snapshotPaths(baseDir).preRollbackDir)) return null;
  const homeParent = dirname3(resolve(dshHome));
  const homeName = basename5(dshHome);
  if (dirname3(resolve(record.stagingPath)) !== homeParent || !basename5(record.stagingPath).startsWith(`.${homeName}.restore-`)) return null;
  const backupName = basename5(record.backupPath);
  if (dirname3(resolve(record.backupPath)) !== homeParent || backupName !== `${homeName}.old` && !backupName.startsWith(`${homeName}.old-`)) return null;
  return {
    schemaVersion: 1,
    phase: record.phase,
    snapshotPath: record.snapshotPath,
    dshHome: record.dshHome,
    stagingPath: record.stagingPath,
    backupPath: record.backupPath,
    hadDshHome: record.hadDshHome,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt
  };
}
async function persistPhase(markerPath, marker, phase, hooks) {
  marker.phase = phase;
  marker.updatedAt = Date.now();
  await atomicWriteMarker(markerPath, marker);
  await hooks.afterPhase?.(phase, marker);
}
async function beginRestore(baseDir, dshHome, snapshotPath, hooks) {
  const { restoreMarker } = snapshotPaths(baseDir);
  const paths = newTransactionPaths(dshHome);
  const legacyBackup = `${dshHome}.old`;
  const legacyBackupState = ownedDirectoryState(legacyBackup);
  if (legacyBackupState === "unsafe") throw new Error("\u65E7\u6062\u590D\u5907\u4EFD\u4E0D\u662F\u5B89\u5168\u7684\u771F\u5B9E\u76EE\u5F55");
  if (legacyBackupState === "directory" && !tightenOwnedDirectory(legacyBackup)) {
    throw new Error("\u65E0\u6CD5\u5B89\u5168\u786E\u8BA4\u65E7\u6062\u590D\u5907\u4EFD");
  }
  const homeState = ownedDirectoryState(dshHome);
  if (homeState === "unsafe") throw new Error("DSH_HOME \u4E0D\u662F\u5B89\u5168\u7684\u771F\u5B9E\u76EE\u5F55");
  const now = Date.now();
  const marker = {
    schemaVersion: 1,
    phase: "copying",
    snapshotPath: resolve(snapshotPath),
    dshHome: resolve(dshHome),
    stagingPath: resolve(paths.stagingPath),
    backupPath: resolve(paths.backupPath),
    hadDshHome: homeState === "directory",
    startedAt: now,
    updatedAt: now
  };
  await atomicWriteMarker(restoreMarker, marker);
  await hooks.afterPhase?.("copying", marker);
  return marker;
}
function interruptedOutcome(marker, dshHome) {
  if (entryExistsNoFollow(marker.backupPath) || marker.hadDshHome && !entryExistsNoFollow(dshHome)) return "half";
  return "incomplete";
}
async function runRestoreTransaction(baseDir, dshHome, marker, copyFn, hooks) {
  const markerPath = snapshotPaths(baseDir).restoreMarker;
  try {
    if (marker.phase === "copying") {
      if (!await isPublishedRestoreSource(baseDir, marker.snapshotPath)) return "incomplete";
      await rm(marker.stagingPath, { recursive: true, force: true });
      await ensurePrivateDir(marker.stagingPath);
      try {
        await copyFn(marker.snapshotPath, marker.stagingPath);
      } catch {
        await rm(marker.stagingPath, { recursive: true, force: true }).catch(() => {
        });
        return "incomplete";
      }
      if (!tightenOwnedDirectory(marker.stagingPath)) return "incomplete";
      await persistPhase(markerPath, marker, "staged", hooks);
    }
    if (marker.phase === "staged") {
      const stagingState = ownedDirectoryState(marker.stagingPath);
      if (stagingState === "unsafe") return "incomplete";
      if (stagingState === "missing") {
        await persistPhase(markerPath, marker, "copying", hooks);
        return runRestoreTransaction(baseDir, dshHome, marker, copyFn, hooks);
      }
      if (!tightenOwnedDirectory(marker.stagingPath)) return "incomplete";
      await persistPhase(markerPath, marker, "backing-up", hooks);
    }
    if (marker.phase === "backing-up") {
      let homeState = ownedDirectoryState(dshHome);
      let backupState = ownedDirectoryState(marker.backupPath);
      if (homeState === "unsafe" || backupState === "unsafe") return "incomplete";
      if (marker.hadDshHome) {
        if (homeState === "directory" && backupState === "directory") return "half";
        if (homeState === "missing" && backupState === "missing") return "incomplete";
        if (homeState === "directory") {
          if (!tightenOwnedDirectory(dshHome)) return "incomplete";
          await renameWithWindowsRetry(dshHome, marker.backupPath);
          homeState = ownedDirectoryState(dshHome);
          backupState = ownedDirectoryState(marker.backupPath);
          if (homeState !== "missing" || backupState !== "directory") return "incomplete";
        }
        if (!tightenOwnedDirectory(marker.backupPath)) return "incomplete";
      } else if (homeState !== "missing" || backupState !== "missing") {
        return "half";
      }
      await persistPhase(markerPath, marker, "publishing", hooks);
    }
    if (marker.phase === "publishing") {
      let stagingState = ownedDirectoryState(marker.stagingPath);
      let homeState = ownedDirectoryState(dshHome);
      if (stagingState === "unsafe" || homeState === "unsafe") return "incomplete";
      if (stagingState === "directory" && homeState === "directory") return "half";
      if (stagingState === "missing" && homeState === "missing") return "incomplete";
      if (stagingState === "directory") {
        if (!tightenOwnedDirectory(marker.stagingPath)) return "incomplete";
        await renameWithWindowsRetry(marker.stagingPath, dshHome);
        stagingState = ownedDirectoryState(marker.stagingPath);
        homeState = ownedDirectoryState(dshHome);
        if (stagingState !== "missing" || homeState !== "directory") return "incomplete";
      }
      if (!tightenOwnedDirectory(dshHome)) return "incomplete";
      await persistPhase(markerPath, marker, "published", hooks);
    }
    if (marker.phase === "published") {
      if (ownedDirectoryState(dshHome) !== "directory" || !tightenOwnedDirectory(dshHome)) return "incomplete";
      await rm(markerPath, { force: true });
      return "complete";
    }
  } catch {
    return interruptedOutcome(marker, dshHome);
  }
  return interruptedOutcome(marker, dshHome);
}
async function restoreSnapshot(baseDir, dshHome, snapshotPath, copyFn = defaultCopy, hooks = {}) {
  const { restoreMarker, snapshotsDir } = snapshotPaths(baseDir);
  let authority = readRestoreMarkerAuthority(baseDir);
  if (authority.kind === "unsafe") return "incomplete";
  if (authority.kind === "missing") {
    await ensurePrivateDir(dirname3(restoreMarker));
    authority = readRestoreMarkerAuthority(baseDir);
    if (authority.kind === "unsafe") return "incomplete";
  }
  let marker;
  if (authority.kind === "valid") {
    const parsed = parseMarker(authority.raw, baseDir, dshHome);
    if (parsed === null) return "incomplete";
    if ("legacySnapshotPath" in parsed) {
      const legacySnapshot = parsed.legacySnapshotPath;
      if (!pathIsInside(legacySnapshot, snapshotsDir) || !await isPublishedSnapshotPath(baseDir, legacySnapshot)) return "incomplete";
      try {
        marker = await beginRestore(baseDir, dshHome, legacySnapshot, hooks);
      } catch {
        return "incomplete";
      }
    } else {
      marker = parsed;
    }
  } else {
    if (!pathIsInside(snapshotPath, snapshotsDir) || !await isPublishedSnapshotPath(baseDir, snapshotPath)) return "incomplete";
    try {
      marker = await beginRestore(baseDir, dshHome, snapshotPath, hooks);
    } catch {
      return "incomplete";
    }
  }
  return runRestoreTransaction(baseDir, dshHome, marker, copyFn, hooks);
}
async function restorePreRollback(baseDir, dshHome, stashName, copyFn = defaultCopy, hooks = {}) {
  const stashPath = await resolveStashPath(baseDir, stashName);
  if (stashPath === null) return "incomplete";
  const { restoreMarker, snapshotsDir } = snapshotPaths(baseDir);
  let authority = readRestoreMarkerAuthority(baseDir);
  if (authority.kind === "unsafe") return "incomplete";
  if (authority.kind === "missing") {
    await ensurePrivateDir(dirname3(restoreMarker));
    authority = readRestoreMarkerAuthority(baseDir);
    if (authority.kind === "unsafe") return "incomplete";
  }
  let marker;
  if (authority.kind === "valid") {
    const parsed = parseMarker(authority.raw, baseDir, dshHome);
    if (parsed === null) return "incomplete";
    if ("legacySnapshotPath" in parsed) {
      const legacySnapshot = parsed.legacySnapshotPath;
      if (!pathIsInside(legacySnapshot, snapshotsDir) || !await isPublishedSnapshotPath(baseDir, legacySnapshot)) return "incomplete";
      try {
        marker = await beginRestore(baseDir, dshHome, legacySnapshot, hooks);
      } catch {
        return "incomplete";
      }
    } else {
      marker = parsed;
    }
  } else {
    try {
      marker = await beginRestore(baseDir, dshHome, stashPath, hooks);
    } catch {
      return "incomplete";
    }
  }
  const outcome = await runRestoreTransaction(baseDir, dshHome, marker, copyFn, hooks);
  if (outcome === "complete") {
    await rm(stashPath, { recursive: true, force: true }).catch(() => {
    });
  }
  return outcome;
}
async function listSnapshotsForVersion(baseDir, version) {
  const safe = assertSafeVersion(version);
  const { snapshotsDir } = snapshotPaths(baseDir);
  const rootState = ownedDirectoryState(snapshotsDir);
  if (rootState === "missing") return [];
  if (rootState === "unsafe") throw new Error("\u5FEB\u7167\u6839\u76EE\u5F55\u4E0D\u5B89\u5168");
  let entries;
  try {
    entries = await readdir(snapshotsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const prefix = `${safe}-`;
  return entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && /^\d+$/.test(entry.name.slice(prefix.length))).map((entry) => ({ path: join6(snapshotsDir, entry.name), timestamp: Number(entry.name.slice(prefix.length)) })).sort((a, b) => b.timestamp - a.timestamp).map((entry) => entry.path);
}
async function findLatestSnapshotForVersion(baseDir, version) {
  return (await listSnapshotsForVersion(baseDir, version))[0] ?? null;
}
async function resolveSnapshotName(baseDir, snapshotName) {
  if (typeof snapshotName !== "string" || snapshotName.length === 0 || snapshotName.length > 255 || basename5(snapshotName) !== snapshotName || snapshotName === "." || snapshotName === "..") return null;
  const { snapshotsDir } = snapshotPaths(baseDir);
  const candidate = join6(snapshotsDir, snapshotName);
  return pathIsInside(candidate, snapshotsDir) && await isPublishedSnapshotPath(baseDir, candidate) ? candidate : null;
}
function isStashName(name) {
  return name.length <= 255 && /^\d{13}-[0-9a-f]{8}$/.test(name);
}
function stashTimestamp(name) {
  const match = /^(\d+)-/.exec(name);
  if (match === null) return 0;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : 0;
}
async function listPreRollbackStashes(baseDir) {
  const { preRollbackDir } = snapshotPaths(baseDir);
  const rootState = ownedDirectoryState(preRollbackDir);
  if (rootState === "missing") return [];
  if (rootState === "unsafe") throw new Error("\u56DE\u6EDA\u6682\u5B58\u6839\u76EE\u5F55\u4E0D\u5B89\u5168");
  let entries;
  try {
    entries = await readdir(preRollbackDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory() && isStashName(entry.name)).sort((a, b) => stashTimestamp(b.name) - stashTimestamp(a.name) || b.name.localeCompare(a.name)).map((entry) => entry.name);
}
async function resolveStashPath(baseDir, stashName) {
  if (typeof stashName !== "string" || !isStashName(stashName)) return null;
  const { preRollbackDir } = snapshotPaths(baseDir);
  const candidate = join6(preRollbackDir, stashName);
  if (!pathIsInside(candidate, preRollbackDir)) return null;
  if (ownedDirectoryState(candidate) !== "directory" || !tightenOwnedDirectory(candidate)) return null;
  return candidate;
}
async function stashPreRollback(baseDir, dshHome, copyFn = defaultCopy) {
  const { preRollbackDir } = snapshotPaths(baseDir);
  await ensureRuntimeSubdir(baseDir, preRollbackDir);
  const dest = join6(preRollbackDir, `${Date.now()}-${randomBytes4(4).toString("hex")}`);
  const staging = join6(preRollbackDir, `.tmp-${randomBytes4(6).toString("hex")}`);
  await ensurePrivateDir(staging);
  try {
    const sourceState = ownedDirectoryState(dshHome);
    if (sourceState === "unsafe") throw new Error("DSH_HOME \u4E0D\u662F\u5B89\u5168\u7684\u771F\u5B9E\u76EE\u5F55");
    if (sourceState === "directory") await copyFn(dshHome, staging);
    if (ownedDirectoryState(preRollbackDir) !== "directory" || !tightenOwnedDirectory(staging)) throw new Error("\u56DE\u6EDA\u6682\u5B58\u76EE\u5F55\u8EAB\u4EFD\u4E0D\u518D\u53EF\u4FE1");
    await renameWithWindowsRetry(staging, dest);
    if (ownedDirectoryState(preRollbackDir) !== "directory" || !tightenOwnedDirectory(dest)) throw new Error("\u56DE\u6EDA\u6682\u5B58\u53D1\u5E03\u76EE\u5F55\u8EAB\u4EFD\u4E0D\u518D\u53EF\u4FE1");
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {
    });
    throw error;
  }
  let entries = [];
  try {
    entries = await readdir(preRollbackDir);
  } catch (error) {
    if (error.code === "ENOENT") return dest;
    throw error;
  }
  for (const entry of entries) {
    const full = join6(preRollbackDir, entry);
    if (full !== dest) {
      if (ownedDirectoryState(preRollbackDir) !== "directory") throw new Error("\u56DE\u6EDA\u6682\u5B58\u6839\u76EE\u5F55\u4E0D\u5B89\u5168");
      await rm(full, { recursive: true, force: true }).catch(() => {
      });
    }
  }
  return dest;
}
function parseSnapshotEntry(snapshotsDir, name) {
  const match = /^(.*)-(\d+)$/.exec(name);
  if (match === null || !isSafeVersion(match[1])) return null;
  const timestamp = Number(match[2]);
  if (!Number.isSafeInteger(timestamp)) return null;
  return { name, path: join6(snapshotsDir, name), sourceVersion: match[1], timestamp };
}
async function readRestoreSnapshotProtection(baseDir) {
  const paths = snapshotPaths(baseDir);
  const authority = readRestoreMarkerAuthority(baseDir);
  if (authority.kind === "missing") return { kind: "missing" };
  if (authority.kind === "unsafe") return { kind: "corrupt" };
  try {
    const parsed = JSON.parse(authority.raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "corrupt" };
    const snapshotPath = parsed.snapshotPath;
    if (typeof snapshotPath !== "string") return { kind: "corrupt" };
    const resolved = resolve(snapshotPath);
    if (dirname3(resolved) !== resolve(paths.snapshotsDir)) return { kind: "corrupt" };
    const name = basename5(resolved);
    return parseSnapshotEntry(paths.snapshotsDir, name) === null ? { kind: "corrupt" } : { kind: "valid", name };
  } catch {
    return { kind: "corrupt" };
  }
}
async function pruneSnapshots(baseDir, policy) {
  const protectedVersions = new Set(policy.protectedVersions.map(assertSafeVersion));
  const protectedNames = /* @__PURE__ */ new Set();
  for (const name of policy.protectedSnapshotNames ?? []) {
    if (basename5(name) !== name || name === "." || name === "..") throw new Error("protectedSnapshotNames \u5FC5\u987B\u662F basename");
    protectedNames.add(name);
  }
  const restoreProtection = await readRestoreSnapshotProtection(baseDir);
  if (restoreProtection.kind === "corrupt") return [];
  if (restoreProtection.kind === "valid") protectedNames.add(restoreProtection.name);
  const keepRecent = policy.keepRecentUnprotected ?? 3;
  if (!Number.isInteger(keepRecent) || keepRecent < 0) throw new Error("keepRecentUnprotected \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570");
  const { snapshotsDir } = snapshotPaths(baseDir);
  const rootState = ownedDirectoryState(snapshotsDir);
  if (rootState !== "directory") return [];
  let entries;
  try {
    entries = await readdir(snapshotsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const snapshots = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => parseSnapshotEntry(snapshotsDir, entry.name)).filter((entry) => entry !== null).sort((a, b) => b.timestamp - a.timestamp);
  for (const version of protectedVersions) {
    const newest = snapshots.find((entry) => entry.sourceVersion === version);
    if (newest !== void 0) protectedNames.add(newest.name);
  }
  const unprotectedTail = snapshots.filter((entry) => !protectedNames.has(entry.name)).slice(0, keepRecent);
  for (const entry of unprotectedTail) protectedNames.add(entry.name);
  const removed = [];
  for (const entry of snapshots) {
    if (protectedNames.has(entry.name)) continue;
    if (ownedDirectoryState(snapshotsDir) !== "directory") return removed;
    await rm(entry.path, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}
async function prepareManualRollbackData(baseDir, dshHome, targetVersion) {
  const snapshotPath = await findLatestSnapshotForVersion(baseDir, targetVersion);
  if (snapshotPath === null) return { snapshotPath: null, stashPath: null };
  const stashPath = await stashPreRollback(baseDir, dshHome);
  return { snapshotPath, stashPath };
}
async function snapshotSummary(baseDir) {
  const paths = snapshotPaths(baseDir);
  let snapshots = [];
  const snapshotRootState = ownedDirectoryState(paths.snapshotsDir);
  if (snapshotRootState === "unsafe") throw new Error("\u5FEB\u7167\u6839\u76EE\u5F55\u4E0D\u5B89\u5168");
  if (snapshotRootState === "directory") try {
    snapshots = (await readdir(paths.snapshotsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => {
      const match = /-(\d+)$/.exec(entry.name);
      return match === null ? null : { path: join6(paths.snapshotsDir, entry.name), timestamp: Number(match[1]) };
    }).filter((entry) => entry !== null && Number.isSafeInteger(entry.timestamp) && !Number.isNaN(new Date(entry.timestamp).getTime())).sort((a, b) => b.timestamp - a.timestamp);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let preRollbackCount = 0;
  let latestStashName = null;
  const preRollbackRootState = ownedDirectoryState(paths.preRollbackDir);
  if (preRollbackRootState === "unsafe") throw new Error("\u56DE\u6EDA\u6682\u5B58\u6839\u76EE\u5F55\u4E0D\u5B89\u5168");
  if (preRollbackRootState === "directory") {
    const stashes = await listPreRollbackStashes(baseDir);
    preRollbackCount = stashes.length;
    latestStashName = stashes[0] ?? null;
  }
  return {
    count: snapshots.length,
    latestName: snapshots[0] === void 0 ? null : basename5(snapshots[0].path),
    latestAt: snapshots[0] === void 0 ? null : new Date(snapshots[0].timestamp).toISOString(),
    restoreInProgress: restoreMarkerAuthorityStatus(baseDir) !== "missing",
    preRollbackCount,
    latestStashName
  };
}
async function dirNonEmpty(dir) {
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}
async function completeInterruptedRestore(baseDir, dshHome, copyFn = defaultCopy, hooks = {}) {
  if (restoreMarkerAuthorityStatus(baseDir) === "missing") return "none";
  return restoreSnapshot(baseDir, dshHome, "", copyFn, hooks);
}

// src/runtime-metadata-recovery.ts
var PRIVATE_DIR_MODE2 = 448;
var PRIVATE_FILE_MODE2 = 384;
var RECOVERY_SCHEMA_VERSION = 1;
var RECOVERY_MARKER = "metadata-recovery.json";
var RECOVERY_DATA_DIR = "metadata-recovery-data";
var RECOVERY_RESCUE_DATA_DIR = "metadata-recovery-rescue-data";
var PRIOR_RECOVERY_MARKER_EVIDENCE = "metadata-recovery.json.prior-corrupt";
var RESTORE_MARKER_EVIDENCE = "restore-in-progress";
var MAX_RECOVERY_MARKER_PARSE_BYTES = 1024 * 1024;
var STASH_TMP_DIR = ".dsh-home.stash.tmp";
var STASH_DIR = "dsh-home.stash";
var STASH_READY = "stash-ready.json";
var EVIDENCE_DIR = "evidence";
var FINALIZED_RECEIPT = "finalized.json";
var RECOVERY_ID = /^\d{13}-[0-9a-f]{16}$/;
var SHA256_HEX = /^[0-9a-f]{64}$/;
var METADATA_BASENAMES = Object.freeze([
  "current",
  "override.json",
  "activation-journal.json"
]);
function isContained(root, candidate) {
  const fromRoot = relative4(root, candidate);
  return fromRoot === "" || fromRoot !== ".." && !fromRoot.startsWith(`..${sep3}`) && !isAbsolute3(fromRoot);
}
function assertContained(root, candidate, label) {
  if (!isContained(root, candidate)) throw new Error(`${label} escaped its recovery root`);
}
function normalizeOwnedPath(input, label) {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0") || !isAbsolute3(input)) {
    throw new Error(`${label} must be an absolute, NUL-free main-process path`);
  }
  if (input.split(/[\\/]+/).includes("..")) throw new Error(`${label} must not contain parent traversal`);
  return resolve2(input);
}
function assertSafeBasename(value, label) {
  if (value.length === 0 || value.length > 255 || value.includes("\0") || value.includes("/") || value.includes("\\") || basename6(value) !== value || value === "." || value === "..") {
    throw new Error(`${label} is not a safe basename`);
  }
}
function isSelectionEvidenceBasename(name) {
  try {
    assertSafeBasename(name, "metadata evidence");
  } catch {
    return false;
  }
  return METADATA_BASENAMES.some((base) => name === base || name.startsWith(`${base}.corrupt`));
}
function isEvidenceBasename(name) {
  return name === PRIOR_RECOVERY_MARKER_EVIDENCE || name === RESTORE_MARKER_EVIDENCE || isSelectionEvidenceBasename(name);
}
function assertRecoveryId(id) {
  assertSafeBasename(id, "metadata recovery id");
  if (!RECOVERY_ID.test(id)) throw new Error("metadata recovery id has an invalid shape");
  return id;
}
function assertExistingRealDirectory(path, label) {
  let info;
  try {
    info = lstatSync5(path);
  } catch {
    throw new Error(`${label} does not exist or is unreadable`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory`);
}
function ensurePrivateDirectory(path, parentRoot) {
  assertContained(parentRoot, path, "private recovery directory");
  if (existsSync5(path)) {
    const info = lstatSync5(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`private recovery path is not a real directory: ${basename6(path)}`);
    }
  } else {
    mkdirSync2(path, { mode: PRIVATE_DIR_MODE2 });
  }
  chmodSync3(path, PRIVATE_DIR_MODE2);
}
function fsyncRegularFileNoFollow(path, label) {
  const pathInfo = lstatSync5(path);
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1) {
    throw new Error(`${label} is not a uniquely linked real file`);
  }
  const noFollow = typeof constants3.O_NOFOLLOW === "number" ? constants3.O_NOFOLLOW : 0;
  let descriptor = null;
  try {
    descriptor = openSync3(path, constants3.O_RDONLY | noFollow);
    const info = fstatSync3(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.dev !== pathInfo.dev || info.ino !== pathInfo.ino) {
      throw new Error(`${label} identity changed before sync`);
    }
    fsyncSync2(descriptor);
  } finally {
    if (descriptor !== null) closeSync3(descriptor);
  }
}
function fsyncRealDirectory(path, label) {
  const info = lstatSync5(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} is not a real directory`);
  const noFollow = typeof constants3.O_NOFOLLOW === "number" ? constants3.O_NOFOLLOW : 0;
  const directoryOnly = typeof constants3.O_DIRECTORY === "number" ? constants3.O_DIRECTORY : 0;
  let descriptor = null;
  try {
    descriptor = openSync3(path, constants3.O_RDONLY | noFollow | directoryOnly);
    const opened = fstatSync3(descriptor);
    if (!opened.isDirectory() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new Error(`${label} identity changed before sync`);
    }
    try {
      fsyncSync2(descriptor);
    } catch (error) {
      const code = error.code;
      if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
    }
  } finally {
    if (descriptor !== null) closeSync3(descriptor);
  }
}
function recoveryRootPaths(baseDirInput, storageKind = "default") {
  const baseDir = normalizeOwnedPath(baseDirInput, "baseDir");
  assertExistingRealDirectory(baseDir, "baseDir");
  const runtimeDir = join7(baseDir, "dsh-runtime");
  assertContained(baseDir, runtimeDir, "runtime directory");
  if (existsSync5(runtimeDir)) assertExistingRealDirectory(runtimeDir, "runtime directory");
  return {
    runtimeDir,
    marker: join7(runtimeDir, RECOVERY_MARKER),
    dataRoot: join7(
      runtimeDir,
      storageKind === "marker-rescue" ? RECOVERY_RESCUE_DATA_DIR : RECOVERY_DATA_DIR
    )
  };
}
function recoveryPaths(baseDirInput, id, storageKind = "default") {
  const roots = recoveryRootPaths(baseDirInput, storageKind);
  const safeId = assertRecoveryId(id);
  const transactionDir = join7(roots.dataRoot, safeId);
  const paths = {
    ...roots,
    transactionDir,
    stashTmp: join7(transactionDir, STASH_TMP_DIR),
    stash: join7(transactionDir, STASH_DIR),
    stashReady: join7(transactionDir, STASH_READY),
    evidence: join7(transactionDir, EVIDENCE_DIR),
    finalizedReceipt: join7(transactionDir, FINALIZED_RECEIPT)
  };
  for (const candidate of Object.values(paths)) {
    if (candidate !== roots.runtimeDir) assertContained(roots.runtimeDir, candidate, "metadata recovery path");
  }
  return paths;
}
function isIsoTimestamp2(value) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}
function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function parseStringArray(value, label) {
  if (!Array.isArray(value) || value.length > 128) return null;
  const result = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !isEvidenceBasename(entry)) return null;
    result.push(entry);
  }
  const sorted = [...new Set(result)].sort();
  if (!arraysEqual(result, sorted)) return null;
  if (label === "evidenceFiles" && result.length === 0) return null;
  return result;
}
function parseRecoveryRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value;
  if (record.schemaVersion !== RECOVERY_SCHEMA_VERSION) return null;
  if (typeof record.id !== "string" || !RECOVERY_ID.test(record.id) || basename6(record.id) !== record.id) return null;
  if (record.phase !== "stashing" && record.phase !== "archiving" && record.phase !== "probe-required" && record.phase !== "finalized") return null;
  if (record.storageKind !== void 0 && record.storageKind !== "default" && record.storageKind !== "marker-rescue") return null;
  const storageKind = record.storageKind === "marker-rescue" ? "marker-rescue" : "default";
  if (typeof record.builtinVersion !== "string" || !isSafeVersion(record.builtinVersion)) return null;
  if (typeof record.dshHomePathHash !== "string" || !SHA256_HEX.test(record.dshHomePathHash)) return null;
  if (typeof record.dshHomeWasMissing !== "boolean") return null;
  const evidenceFiles = parseStringArray(record.evidenceFiles, "evidenceFiles");
  const archivedEvidence = parseStringArray(record.archivedEvidence, "archivedEvidence");
  if (evidenceFiles === null || archivedEvidence === null) return null;
  if (!archivedEvidence.every((name) => evidenceFiles.includes(name))) return null;
  let priorRecoveryMarker = null;
  if (record.priorRecoveryMarker !== void 0 && record.priorRecoveryMarker !== null) {
    if (typeof record.priorRecoveryMarker !== "object" || Array.isArray(record.priorRecoveryMarker)) return null;
    const prior = record.priorRecoveryMarker;
    if (prior.name !== PRIOR_RECOVERY_MARKER_EVIDENCE || !Number.isSafeInteger(prior.byteLength) || prior.byteLength < 0 || typeof prior.sha256 !== "string" || !SHA256_HEX.test(prior.sha256)) return null;
    priorRecoveryMarker = {
      name: PRIOR_RECOVERY_MARKER_EVIDENCE,
      byteLength: prior.byteLength,
      sha256: prior.sha256
    };
  }
  if (storageKind === "marker-rescue") {
    if (priorRecoveryMarker === null || !evidenceFiles.includes(PRIOR_RECOVERY_MARKER_EVIDENCE) || !archivedEvidence.includes(PRIOR_RECOVERY_MARKER_EVIDENCE)) return null;
  } else if (priorRecoveryMarker !== null || evidenceFiles.includes(PRIOR_RECOVERY_MARKER_EVIDENCE)) return null;
  if (!Number.isSafeInteger(record.probeAttempts) || record.probeAttempts < 0) return null;
  if (!isIsoTimestamp2(record.startedAt) || !isIsoTimestamp2(record.updatedAt)) return null;
  if (record.lastProbeAt !== null && !isIsoTimestamp2(record.lastProbeAt)) return null;
  if (record.lastProbeError !== null && (typeof record.lastProbeError !== "string" || record.lastProbeError.length === 0 || record.lastProbeError.length > 4e3 || record.lastProbeError.includes("\0"))) return null;
  if (record.finalizedAt !== null && !isIsoTimestamp2(record.finalizedAt)) return null;
  if (record.phase === "stashing" && archivedEvidence.length !== 0) return null;
  if ((record.phase === "probe-required" || record.phase === "finalized") && !arraysEqual(archivedEvidence, evidenceFiles)) return null;
  if (record.phase === "finalized" !== (record.finalizedAt !== null)) return null;
  return {
    schemaVersion: 1,
    id: record.id,
    phase: record.phase,
    storageKind,
    builtinVersion: record.builtinVersion,
    dshHomePathHash: record.dshHomePathHash,
    dshHomeWasMissing: record.dshHomeWasMissing,
    evidenceFiles,
    archivedEvidence,
    priorRecoveryMarker,
    probeAttempts: record.probeAttempts,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    lastProbeAt: record.lastProbeAt,
    lastProbeError: record.lastProbeError,
    finalizedAt: record.finalizedAt
  };
}
function sameFileIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode && left.linkCount === right.linkCount && left.byteLength === right.byteLength && left.modifiedMs === right.modifiedMs && left.changedMs === right.changedMs;
}
function sameOpaqueBytes(left, right) {
  return left.byteLength === right.byteLength && left.sha256 === right.sha256;
}
function fingerprintRegularFile(filePath, retainContent, requireNoFollow = true) {
  if (requireNoFollow && typeof constants3.O_NOFOLLOW !== "number") {
    throw new Error("this platform cannot safely open recovery-marker evidence");
  }
  const noFollow = typeof constants3.O_NOFOLLOW === "number" ? constants3.O_NOFOLLOW : 0;
  let descriptor = null;
  try {
    descriptor = openSync3(filePath, constants3.O_RDONLY | noFollow);
    const before = fstatSync3(descriptor);
    if (!before.isFile() || before.nlink !== 1 || !Number.isSafeInteger(before.size) || before.size < 0) {
      throw new Error("recovery marker is not a bounded regular file");
    }
    const pathBefore = lstatSync5(filePath);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino) {
      throw new Error("recovery marker identity changed before it could be read");
    }
    const hash = createHash4("sha256");
    const chunks = retainContent && before.size <= MAX_RECOVERY_MARKER_PARSE_BYTES ? [] : null;
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size)));
    let offset = 0;
    while (offset < before.size) {
      const count = readSync3(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset
      );
      if (count === 0) throw new Error("recovery marker changed while it was read");
      const bytes = buffer.subarray(0, count);
      hash.update(bytes);
      if (chunks !== null) chunks.push(Buffer.from(bytes));
      offset += count;
    }
    const after = fstatSync3(descriptor);
    const pathAfter = lstatSync5(filePath);
    const beforeIdentity = {
      byteLength: before.size,
      sha256: "",
      device: before.dev,
      inode: before.ino,
      linkCount: before.nlink,
      modifiedMs: before.mtimeMs,
      changedMs: before.ctimeMs
    };
    const afterIdentity = {
      byteLength: after.size,
      sha256: "",
      device: after.dev,
      inode: after.ino,
      linkCount: after.nlink,
      modifiedMs: after.mtimeMs,
      changedMs: after.ctimeMs
    };
    if (!sameFileIdentity(beforeIdentity, afterIdentity) || pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino) {
      throw new Error("recovery marker changed while it was read");
    }
    return {
      fingerprint: { ...afterIdentity, sha256: hash.digest("hex") },
      content: chunks === null ? null : Buffer.concat(chunks, offset)
    };
  } finally {
    if (descriptor !== null) closeSync3(descriptor);
  }
}
function assertCopySourceConstraint(source, constraint, openedDevice, openedInode) {
  const rootInfo = lstatSync5(constraint.sourceRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || rootInfo.dev !== constraint.sourceRootDevice || rootInfo.ino !== constraint.sourceRootInode) {
    throw new Error("copy source root identity changed");
  }
  const sourceInfo = lstatSync5(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile() || sourceInfo.nlink !== 1 || sourceInfo.dev !== constraint.sourceDevice || sourceInfo.ino !== constraint.sourceInode || sourceInfo.size !== constraint.sourceByteLength || sourceInfo.mtimeMs !== constraint.sourceModifiedMs || sourceInfo.ctimeMs !== constraint.sourceChangedMs || openedDevice !== constraint.sourceDevice || openedInode !== constraint.sourceInode) {
    throw new Error("copy source identity changed");
  }
  const realRoot = realpathSync3(constraint.sourceRoot);
  const realSource = realpathSync3(source);
  if (!isContained(realRoot, realSource)) throw new Error("copy source escaped its pinned root");
}
function defaultCopyFile(source, destination, constraint) {
  const noFollow = constants3.O_NOFOLLOW ?? 0;
  let sourceFd = null;
  let destinationFd = null;
  try {
    sourceFd = openSync3(source, constants3.O_RDONLY | noFollow);
    const sourceInfo = fstatSync3(sourceFd);
    if (!sourceInfo.isFile() || sourceInfo.nlink !== 1) {
      throw new Error("source file is not a uniquely linked regular file");
    }
    if (sourceInfo.size !== constraint.sourceByteLength || sourceInfo.mtimeMs !== constraint.sourceModifiedMs || sourceInfo.ctimeMs !== constraint.sourceChangedMs) {
      throw new Error("copy source changed before it was read");
    }
    assertCopySourceConstraint(source, constraint, sourceInfo.dev, sourceInfo.ino);
    destinationFd = openSync3(
      destination,
      constants3.O_WRONLY | constants3.O_CREAT | constants3.O_EXCL | noFollow,
      PRIVATE_FILE_MODE2
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const count = readSync3(sourceFd, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      let written = 0;
      while (written < count) {
        written += writeSync(destinationFd, buffer, written, count - written);
      }
      offset += count;
    }
    const sourceAfter = fstatSync3(sourceFd);
    if (sourceAfter.dev !== sourceInfo.dev || sourceAfter.ino !== sourceInfo.ino || sourceAfter.nlink !== 1 || sourceAfter.size !== sourceInfo.size || sourceAfter.mtimeMs !== sourceInfo.mtimeMs || sourceAfter.ctimeMs !== sourceInfo.ctimeMs) {
      throw new Error("copy source changed while it was read");
    }
    assertCopySourceConstraint(source, constraint, sourceAfter.dev, sourceAfter.ino);
    fsyncSync2(destinationFd);
  } catch (error) {
    try {
      rmSync4(destination, { force: true });
    } catch {
    }
    throw error;
  } finally {
    if (destinationFd !== null) closeSync3(destinationFd);
    if (sourceFd !== null) closeSync3(sourceFd);
  }
}
var DEFAULT_OPERATIONS = {
  copyFile: defaultCopyFile,
  renamePath: (source, destination) => renameSync3(source, destination),
  now: () => /* @__PURE__ */ new Date(),
  randomHex: () => randomBytes5(8).toString("hex"),
  afterCheckpoint: () => void 0
};
function operations(injected) {
  return { ...DEFAULT_OPERATIONS, ...injected };
}
function nowIso(ops) {
  const now = ops.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("metadata recovery clock is invalid");
  return now.toISOString();
}
function writePrivateJson(filePath, payload, runtimeRoot, ops, kind) {
  assertContained(runtimeRoot, filePath, "metadata recovery JSON");
  const parent = dirname4(filePath);
  assertExistingRealDirectory(parent, "metadata recovery JSON parent");
  const tmp = join7(parent, `.${basename6(filePath)}.tmp-${randomBytes5(4).toString("hex")}`);
  assertContained(parent, tmp, "metadata recovery JSON temporary file");
  try {
    writeFileSync3(tmp, `${JSON.stringify(payload, null, 2)}
`, {
      encoding: "utf8",
      mode: PRIVATE_FILE_MODE2,
      flag: "wx"
    });
    chmodSync3(tmp, PRIVATE_FILE_MODE2);
    fsyncRegularFileNoFollow(tmp, "metadata recovery JSON temporary file");
    ops.renamePath(tmp, filePath, kind);
    const published = lstatSync5(filePath);
    if (published.isSymbolicLink() || !published.isFile() || published.nlink !== 1) {
      throw new Error("metadata recovery JSON did not publish as a uniquely linked real file");
    }
    chmodSync3(filePath, PRIVATE_FILE_MODE2);
    fsyncRegularFileNoFollow(filePath, "published metadata recovery JSON");
    fsyncRealDirectory(parent, "metadata recovery JSON parent");
  } catch (error) {
    try {
      rmSync4(tmp, { force: true });
    } catch {
    }
    throw error;
  }
}
function checkpoint(paths, record, checkpointName, ops, markerKind = "marker-write") {
  const parsed = parseRecoveryRecord(record);
  if (parsed === null) throw new Error("refusing to write invalid metadata recovery state");
  writePrivateJson(paths.marker, parsed, paths.runtimeDir, ops, markerKind);
  ops.afterCheckpoint(checkpointName, parsed);
  return parsed;
}
function stateForUnsafeExactFile(filePath) {
  try {
    const info = lstatSync5(filePath);
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 ? "regular" : "unsafe";
  } catch (error) {
    return error.code === "ENOENT" ? "missing" : "unsafe";
  }
}
function corruptEvidenceBasenames(runtimeDir) {
  if (!existsSync5(runtimeDir)) return [];
  return readdirSync4(runtimeDir, { withFileTypes: true }).map((entry) => entry.name).filter((name) => METADATA_BASENAMES.some((base) => name.startsWith(`${base}.corrupt`))).filter((name) => {
    try {
      assertSafeBasename(name, "corrupt metadata evidence");
      return true;
    } catch {
      return false;
    }
  }).sort();
}
function readMetadataRecoveryState(baseDir) {
  const { runtimeDir, marker } = recoveryRootPaths(baseDir);
  if (!existsSync5(runtimeDir)) return { kind: "missing" };
  let info;
  try {
    info = lstatSync5(marker);
  } catch (error) {
    return error.code === "ENOENT" ? { kind: "missing" } : { kind: "corrupt", error: "metadata recovery marker is unreadable" };
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    return { kind: "corrupt", error: "metadata recovery marker is not a uniquely linked real file" };
  }
  try {
    const snapshot = fingerprintRegularFile(marker, true, false);
    const parsed = snapshot.content === null ? null : parseRecoveryRecord(JSON.parse(snapshot.content.toString("utf8")));
    return parsed === null ? { kind: "corrupt", error: "metadata recovery marker has an invalid shape" } : { kind: "valid", record: parsed };
  } catch {
    return { kind: "corrupt", error: "metadata recovery marker is malformed or unreadable" };
  }
}
function inspectCorruptMetadataRecoveryMarker(baseDir) {
  const { runtimeDir, marker } = recoveryRootPaths(baseDir);
  if (!existsSync5(runtimeDir)) return { recoverable: false, reason: "marker-missing" };
  let info;
  try {
    info = lstatSync5(marker);
  } catch (error) {
    return {
      recoverable: false,
      reason: error.code === "ENOENT" ? "marker-missing" : "marker-unreadable"
    };
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    return { recoverable: false, reason: "marker-unsafe" };
  }
  try {
    const snapshot = fingerprintRegularFile(marker, true);
    if (snapshot.content !== null) {
      try {
        if (parseRecoveryRecord(JSON.parse(snapshot.content.toString("utf8"))) !== null) {
          return { recoverable: false, reason: "marker-valid" };
        }
      } catch {
      }
    }
    return {
      recoverable: true,
      byteLength: snapshot.fingerprint.byteLength,
      sha256: snapshot.fingerprint.sha256
    };
  } catch {
    return { recoverable: false, reason: "marker-unreadable" };
  }
}
function detectRuntimeMetadataHealth(baseDir, shellVersion) {
  const { runtimeDir } = recoveryRootPaths(baseDir);
  const currentPath = currentPointerPath(baseDir);
  const current = stateForUnsafeExactFile(currentPath) === "unsafe" ? { kind: "corrupt" } : readCurrentPointerState(baseDir);
  const overrideFile = overridePath(baseDir);
  const override = stateForUnsafeExactFile(overrideFile) === "unsafe" ? { kind: "corrupt" } : readOverrideState(baseDir);
  const journalPath = activationJournalPath(baseDir);
  const activationJournal = stateForUnsafeExactFile(journalPath) === "unsafe" ? { kind: "corrupt" } : readActivationJournalState(baseDir);
  const corruptEvidence = corruptEvidenceBasenames(runtimeDir);
  const recovery = readMetadataRecoveryState(baseDir);
  const selectionCorrupt = current.kind === "corrupt" || override.kind === "corrupt" || activationJournal.kind === "corrupt" || corruptEvidence.length > 0 || detectSemanticMismatch(baseDir, shellVersion, current, override, activationJournal);
  let status;
  if (recovery.kind === "corrupt") status = "recovery-marker-corrupt";
  else if (recovery.kind === "valid" && recovery.record.phase !== "finalized") status = "recovery-in-progress";
  else if (selectionCorrupt) status = "selection-corrupt";
  else if (recovery.kind === "valid") status = "recovery-finalized";
  else status = "healthy";
  return { status, current, override, activationJournal, corruptEvidence, recovery };
}
var ROLLBACK_CONTINUATION_PHASES = /* @__PURE__ */ new Set(["rollback-needed", "restoring", "restore-complete", "fallback-builtin"]);
var ACTIVE_RESTORE_PHASES = /* @__PURE__ */ new Set(["rollback-needed", "restoring", "manual-restoring"]);
function publishedSnapshotEntryExists(baseDir, snapshotName) {
  try {
    const info = lstatSync5(join7(snapshotPaths(baseDir).snapshotsDir, snapshotName));
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}
function detectSemanticMismatch(baseDir, shellVersion, current, override, journal) {
  const pending = override.kind === "valid" ? override.record.pending : null;
  if (journal.kind === "missing") {
    return pending !== null && current.kind === "valid" && current.version === pending;
  }
  if (journal.kind !== "valid") return false;
  const j = journal.journal;
  if (ACTIVE_RESTORE_PHASES.has(j.phase)) {
    const needed = j.phase === "manual-restoring" ? j.manualDataSnapshotName : j.preSwapSnapshotName;
    if (needed !== null && !publishedSnapshotEntryExists(baseDir, needed)) return true;
  }
  if (shellVersion !== void 0 && override.kind === "valid" && (override.record.invalidatedAt != null || override.record.shellVersion !== shellVersion) && j.intentKind === "version-switch" && !ROLLBACK_CONTINUATION_PHASES.has(j.phase)) {
    return true;
  }
  if (j.targetIsBuiltin) return false;
  if (ROLLBACK_CONTINUATION_PHASES.has(j.phase)) return false;
  if (pending === null || pending === void 0) return false;
  const expected = j.nextIntent !== null && !j.nextIntent.targetIsBuiltin ? j.nextIntent.targetVersion : j.targetVersion;
  return expected !== pending;
}
function sourcePathHash(dshHomeInput, runtimeDir) {
  const dshHome = normalizeOwnedPath(dshHomeInput, "dshHome");
  if (isContained(runtimeDir, dshHome)) throw new Error("dshHome must not be inside the runtime recovery directory");
  let missing = false;
  try {
    const info = lstatSync5(dshHome);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("dshHome must be a real directory when present");
    const realHome = realpathSync3(dshHome);
    const realRuntime = existsSync5(runtimeDir) ? realpathSync3(runtimeDir) : runtimeDir;
    if (isContained(realRuntime, realHome)) throw new Error("dshHome must not resolve inside the runtime recovery directory");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    missing = true;
  }
  return {
    dshHome,
    // Hash the stable expected path so a legitimately missing DSH_HOME can be
    // created by the builtin probe without changing transaction identity.
    hash: createHash4("sha256").update(dshHome).digest("hex"),
    missing
  };
}
function collectEvidence(runtimeDir, requireSelectionEvidence = true) {
  const entries = readdirSync4(runtimeDir, { withFileTypes: true }).filter((entry) => isSelectionEvidenceBasename(entry.name) || entry.name === RESTORE_MARKER_EVIDENCE).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const source = join7(runtimeDir, entry.name);
    assertContained(runtimeDir, source, "metadata evidence source");
    const info = lstatSync5(source);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`metadata evidence is not a real file: ${entry.name}`);
    }
  }
  const names = entries.map((entry) => entry.name);
  if (requireSelectionEvidence && !names.some(isSelectionEvidenceBasename)) {
    throw new Error("corrupt metadata was reported but no archivable evidence file exists");
  }
  return names;
}
function sourceTreeIdentity(source) {
  const info = lstatSync5(source);
  const common = {
    device: info.dev,
    inode: info.ino,
    linkCount: info.nlink,
    byteLength: info.size,
    modifiedMs: info.mtimeMs,
    changedMs: info.ctimeMs
  };
  if (info.isSymbolicLink()) {
    return {
      ...common,
      kind: "symlink",
      linkTarget: readlinkSync(source),
      children: null
    };
  }
  if (info.isFile()) {
    if (info.nlink !== 1) throw new Error("DSH_HOME contains a multiply linked file");
    return { ...common, kind: "file", linkTarget: null, children: null };
  }
  if (!info.isDirectory()) throw new Error("DSH_HOME contains a non-file, non-directory entry");
  const children = readdirSync4(source, { withFileTypes: true }).map((entry) => {
    assertSafeBasename(entry.name, "DSH_HOME entry");
    return entry.name;
  }).sort();
  return { ...common, kind: "directory", linkTarget: null, children };
}
function sourceTreeIdentityEqual(left, right) {
  return left.kind === right.kind && left.device === right.device && left.inode === right.inode && left.linkCount === right.linkCount && left.byteLength === right.byteLength && left.modifiedMs === right.modifiedMs && left.changedMs === right.changedMs && left.linkTarget === right.linkTarget && (left.children === null && right.children === null || left.children !== null && right.children !== null && arraysEqual(left.children, right.children));
}
function assertSourceTreeIdentity(source, expected) {
  const actual = sourceTreeIdentity(source);
  if (!sourceTreeIdentityEqual(actual, expected)) {
    throw new Error("DSH_HOME entry identity changed while it was stashed");
  }
}
function buildSourceTreeManifest(source, manifest = /* @__PURE__ */ new Map()) {
  const identity = sourceTreeIdentity(source);
  manifest.set(source, identity);
  if (identity.children !== null) {
    for (const child of identity.children) buildSourceTreeManifest(join7(source, child), manifest);
    assertSourceTreeIdentity(source, identity);
  }
  return manifest;
}
function copySourceTree(source, destination, destinationRoot, sourceRoot, sourceManifest, ops) {
  const expected = sourceManifest.get(source);
  if (expected === void 0) throw new Error("DSH_HOME source manifest is incomplete");
  assertSourceTreeIdentity(source, expected);
  assertContained(destinationRoot, destination, "DSH_HOME stash destination");
  if (expected.kind === "symlink") {
    const target = expected.linkTarget;
    if (target === null) throw new Error("DSH_HOME symlink manifest is invalid");
    symlinkSync(target, destination);
    const copied = lstatSync5(destination);
    if (!copied.isSymbolicLink() || readlinkSync(destination) !== target) {
      throw new Error("stash copy did not preserve a symbolic link as an opaque link entity");
    }
    assertSourceTreeIdentity(source, expected);
    return;
  }
  if (expected.kind === "file") {
    const rootIdentity = sourceManifest.get(sourceRoot);
    if (rootIdentity === void 0 || rootIdentity.kind !== "directory") {
      throw new Error("DSH_HOME root manifest is invalid");
    }
    ops.copyFile(source, destination, {
      sourceRoot,
      sourceRootDevice: rootIdentity.device,
      sourceRootInode: rootIdentity.inode,
      sourceDevice: expected.device,
      sourceInode: expected.inode,
      sourceByteLength: expected.byteLength,
      sourceModifiedMs: expected.modifiedMs,
      sourceChangedMs: expected.changedMs
    });
    assertSourceTreeIdentity(source, expected);
    const copied = lstatSync5(destination);
    if (copied.isSymbolicLink() || !copied.isFile() || copied.nlink !== 1) {
      throw new Error("stash copy did not create a uniquely linked real file");
    }
    chmodSync3(destination, PRIVATE_FILE_MODE2);
    fsyncRegularFileNoFollow(destination, "DSH_HOME stash file");
    return;
  }
  ensurePrivateDirectory(destination, destinationRoot);
  if (expected.children === null) throw new Error("DSH_HOME directory manifest is invalid");
  for (const child of expected.children) {
    assertSourceTreeIdentity(source, expected);
    copySourceTree(
      join7(source, child),
      join7(destination, child),
      destinationRoot,
      sourceRoot,
      sourceManifest,
      ops
    );
    assertSourceTreeIdentity(source, expected);
  }
  fsyncRealDirectory(destination, "DSH_HOME stash directory");
}
function assertStashTreeSafe(path) {
  const info = lstatSync5(path);
  if (info.isSymbolicLink()) {
    readlinkSync(path);
    return;
  }
  if (info.isFile()) {
    if (info.nlink !== 1) throw new Error("owned recovery data contains a multiply linked file");
    return;
  }
  if (!info.isDirectory()) throw new Error("owned recovery data contains a special filesystem entry");
  for (const entry of readdirSync4(path, { withFileTypes: true })) {
    assertSafeBasename(entry.name, "owned recovery entry");
    assertStashTreeSafe(join7(path, entry.name));
  }
}
function removeOwnedPartialTree(path, transactionDir) {
  assertContained(transactionDir, path, "partial stash");
  if (!existsSync5(path)) return;
  assertExistingRealDirectory(path, "partial DSH_HOME stash");
  assertStashTreeSafe(path);
  rmSync4(path, { recursive: true, force: true });
}
function parseStashReady(path, record) {
  try {
    const info = lstatSync5(path);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) return false;
    chmodSync3(path, PRIVATE_FILE_MODE2);
    const value = JSON.parse(readFileSync3(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const ready = value;
    return ready.schemaVersion === 1 && ready.recoveryId === record.id && ready.dshHomePathHash === record.dshHomePathHash;
  } catch {
    return false;
  }
}
function assertPublishedStash(paths, record) {
  assertExistingRealDirectory(paths.stash, "published DSH_HOME stash");
  assertStashTreeSafe(paths.stash);
  if (!parseStashReady(paths.stashReady, record)) throw new Error("published DSH_HOME stash lacks a valid completion record");
}
function ensurePublishedStash(paths, dshHome, record, ops) {
  if (existsSync5(paths.stash)) {
    assertPublishedStash(paths, record);
    if (existsSync5(paths.stashTmp)) removeOwnedPartialTree(paths.stashTmp, paths.transactionDir);
    return;
  }
  if (existsSync5(paths.stashTmp) && parseStashReady(paths.stashReady, record)) {
    assertExistingRealDirectory(paths.stashTmp, "temporary DSH_HOME stash");
    assertStashTreeSafe(paths.stashTmp);
    fsyncRealDirectory(paths.stashTmp, "temporary DSH_HOME stash");
    ops.renamePath(paths.stashTmp, paths.stash, "stash-publish");
    fsyncRealDirectory(paths.transactionDir, "metadata recovery transaction directory");
    assertPublishedStash(paths, record);
    return;
  }
  if (existsSync5(paths.stashTmp)) removeOwnedPartialTree(paths.stashTmp, paths.transactionDir);
  if (existsSync5(paths.stashReady)) {
    const info = lstatSync5(paths.stashReady);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error("stash completion record is unsafe");
    }
    rmSync4(paths.stashReady, { force: true });
  }
  let sourceMissing = false;
  try {
    const info = lstatSync5(dshHome);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("dshHome must be a real directory when present");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    sourceMissing = true;
  }
  if (sourceMissing !== record.dshHomeWasMissing) {
    throw new Error("DSH_HOME presence changed before its recovery stash was published");
  }
  const sourceManifest = sourceMissing ? null : buildSourceTreeManifest(dshHome);
  ensurePrivateDirectory(paths.stashTmp, paths.transactionDir);
  if (sourceManifest !== null) {
    copySourceTree(
      dshHome,
      paths.stashTmp,
      paths.stashTmp,
      dshHome,
      sourceManifest,
      ops
    );
  }
  fsyncRealDirectory(paths.stashTmp, "temporary DSH_HOME stash");
  const ready = {
    schemaVersion: 1,
    recoveryId: record.id,
    dshHomePathHash: record.dshHomePathHash
  };
  writePrivateJson(paths.stashReady, ready, paths.runtimeDir, ops, "receipt-write");
  ops.renamePath(paths.stashTmp, paths.stash, "stash-publish");
  fsyncRealDirectory(paths.transactionDir, "metadata recovery transaction directory");
  assertPublishedStash(paths, record);
}
function ensureRecoveryDirectories(paths) {
  if (!existsSync5(paths.runtimeDir)) {
    const baseDir = dirname4(paths.runtimeDir);
    ensurePrivateDirectory(paths.runtimeDir, baseDir);
  } else {
    assertExistingRealDirectory(paths.runtimeDir, "runtime directory");
    chmodSync3(paths.runtimeDir, PRIVATE_DIR_MODE2);
  }
  ensurePrivateDirectory(paths.dataRoot, paths.runtimeDir);
  ensurePrivateDirectory(paths.transactionDir, paths.dataRoot);
  ensurePrivateDirectory(paths.evidence, paths.transactionDir);
}
function allocateRecoveryRecord(baseDir, builtinVersion, dshHomePathHash, dshHomeWasMissing, evidenceFiles, ops, storageKind, priorRecoveryMarker) {
  const now = ops.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("metadata recovery clock is invalid");
  const timestamp = now.toISOString();
  const random = ops.randomHex();
  if (!/^[0-9a-f]{16}$/.test(random)) throw new Error("metadata recovery random id is invalid");
  const id = `${now.getTime()}-${random}`;
  const paths = recoveryPaths(baseDir, id, storageKind);
  if (existsSync5(paths.transactionDir)) throw new Error("metadata recovery id collision");
  ensureRecoveryDirectories(paths);
  const record = {
    schemaVersion: 1,
    id,
    phase: "stashing",
    storageKind,
    builtinVersion,
    dshHomePathHash,
    dshHomeWasMissing,
    evidenceFiles,
    archivedEvidence: [],
    priorRecoveryMarker,
    probeAttempts: 0,
    startedAt: timestamp,
    updatedAt: timestamp,
    lastProbeAt: null,
    lastProbeError: null,
    finalizedAt: null
  };
  return { paths, record };
}
function newRecoveryRecord(baseDir, builtinVersion, dshHomePathHash, dshHomeWasMissing, evidenceFiles, ops) {
  const allocated = allocateRecoveryRecord(
    baseDir,
    builtinVersion,
    dshHomePathHash,
    dshHomeWasMissing,
    evidenceFiles,
    ops,
    "default",
    null
  );
  return {
    paths: allocated.paths,
    record: checkpoint(allocated.paths, allocated.record, "stashing", ops)
  };
}
function archiveEvidenceFile(paths, name, ops) {
  assertSafeBasename(name, "metadata evidence");
  if (!isEvidenceBasename(name)) throw new Error("refusing to archive a non-metadata basename");
  const source = join7(paths.runtimeDir, name);
  const destination = join7(paths.evidence, name);
  assertContained(paths.runtimeDir, source, "metadata evidence source");
  assertContained(paths.evidence, destination, "metadata evidence destination");
  const sourceExists = existsSync5(source);
  const destinationExists = existsSync5(destination);
  if (sourceExists && destinationExists) throw new Error(`metadata evidence exists at source and destination: ${name}`);
  if (!sourceExists && !destinationExists) throw new Error(`metadata evidence disappeared during recovery: ${name}`);
  if (sourceExists) {
    const info = lstatSync5(source);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`metadata evidence is unsafe: ${name}`);
    }
    chmodSync3(source, PRIVATE_FILE_MODE2);
    ops.renamePath(source, destination, "evidence");
    fsyncRealDirectory(paths.evidence, "metadata recovery evidence directory");
    fsyncRealDirectory(paths.runtimeDir, "runtime metadata directory");
  }
  const archived = lstatSync5(destination);
  if (archived.isSymbolicLink() || !archived.isFile() || archived.nlink !== 1) {
    throw new Error(`archived metadata evidence is unsafe: ${name}`);
  }
  chmodSync3(destination, PRIVATE_FILE_MODE2);
}
function assertNoUnplannedEvidence(paths, record) {
  const remaining = readdirSync4(paths.runtimeDir, { withFileTypes: true }).map((entry) => entry.name).filter(isEvidenceBasename);
  if (remaining.length > 0) {
    throw new Error(`new runtime metadata appeared during recovery: ${remaining.sort().join(", ")}`);
  }
  for (const name of record.evidenceFiles) {
    const archivedPath = join7(paths.evidence, name);
    const info = lstatSync5(archivedPath);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`metadata evidence is incomplete: ${name}`);
    }
  }
  if (record.priorRecoveryMarker !== null) {
    const priorPath = join7(paths.evidence, PRIOR_RECOVERY_MARKER_EVIDENCE);
    const prior = fingerprintRegularFile(priorPath, false).fingerprint;
    if (!sameOpaqueBytes(prior, record.priorRecoveryMarker)) {
      throw new Error("prior corrupt recovery-marker evidence no longer matches its provenance");
    }
  }
}
function corruptMarkerSnapshotForRescue(marker) {
  const snapshot = fingerprintRegularFile(marker, true);
  if (snapshot.content !== null) {
    try {
      if (parseRecoveryRecord(JSON.parse(snapshot.content.toString("utf8"))) !== null) {
        throw new Error("metadata recovery marker is already valid");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "metadata recovery marker is already valid") throw error;
    }
  }
  return snapshot.fingerprint;
}
function bootstrapCorruptMetadataRecoveryMarker(options) {
  const ops = operations(options.operations);
  const builtinVersion = assertSafeVersion(options.builtinVersion);
  const roots = recoveryRootPaths(options.baseDir);
  const source = sourcePathHash(options.dshHome, roots.runtimeDir);
  const capability = inspectCorruptMetadataRecoveryMarker(options.baseDir);
  if (!capability.recoverable) {
    throw new Error(`corrupt recovery marker cannot be rescued: ${capability.reason}`);
  }
  const original = corruptMarkerSnapshotForRescue(roots.marker);
  if (!sameOpaqueBytes(original, capability)) {
    throw new Error("recovery marker changed after its rescue capability was checked");
  }
  const selectionEvidence = collectEvidence(roots.runtimeDir, false);
  const evidenceFiles = [...selectionEvidence, PRIOR_RECOVERY_MARKER_EVIDENCE].sort();
  const provenance = {
    name: PRIOR_RECOVERY_MARKER_EVIDENCE,
    byteLength: original.byteLength,
    sha256: original.sha256
  };
  const { paths, record: provisional } = allocateRecoveryRecord(
    options.baseDir,
    builtinVersion,
    source.hash,
    source.missing,
    evidenceFiles,
    ops,
    "marker-rescue",
    provenance
  );
  ensurePublishedStash(paths, source.dshHome, provisional, ops);
  const opaqueTmp = join7(paths.evidence, `.${PRIOR_RECOVERY_MARKER_EVIDENCE}.tmp`);
  const opaqueEvidence = join7(paths.evidence, PRIOR_RECOVERY_MARKER_EVIDENCE);
  assertContained(paths.evidence, opaqueTmp, "opaque recovery-marker temporary evidence");
  assertContained(paths.evidence, opaqueEvidence, "opaque recovery-marker evidence");
  try {
    const runtimeInfo = lstatSync5(roots.runtimeDir);
    if (runtimeInfo.isSymbolicLink() || !runtimeInfo.isDirectory()) {
      throw new Error("runtime metadata directory identity is unsafe");
    }
    ops.copyFile(roots.marker, opaqueTmp, {
      sourceRoot: roots.runtimeDir,
      sourceRootDevice: runtimeInfo.dev,
      sourceRootInode: runtimeInfo.ino,
      sourceDevice: original.device,
      sourceInode: original.inode,
      sourceByteLength: original.byteLength,
      sourceModifiedMs: original.modifiedMs,
      sourceChangedMs: original.changedMs
    });
    const copiedInfo = lstatSync5(opaqueTmp);
    if (copiedInfo.isSymbolicLink() || !copiedInfo.isFile() || copiedInfo.nlink !== 1) {
      throw new Error("opaque recovery-marker copy is not a uniquely linked real file");
    }
    chmodSync3(opaqueTmp, PRIVATE_FILE_MODE2);
    fsyncRegularFileNoFollow(opaqueTmp, "opaque recovery-marker temporary evidence");
    const copied = fingerprintRegularFile(opaqueTmp, false).fingerprint;
    if (!sameOpaqueBytes(copied, original)) {
      throw new Error("opaque recovery-marker copy does not match its source");
    }
    const sourceAfterCopy = corruptMarkerSnapshotForRescue(roots.marker);
    if (!sameFileIdentity(sourceAfterCopy, original) || !sameOpaqueBytes(sourceAfterCopy, original)) {
      throw new Error("recovery marker changed while its evidence was copied");
    }
    ops.renamePath(opaqueTmp, opaqueEvidence, "opaque-marker-publish");
    fsyncRealDirectory(paths.evidence, "metadata recovery evidence directory");
  } catch (error) {
    try {
      rmSync4(opaqueTmp, { force: true });
    } catch {
    }
    throw error;
  }
  const published = fingerprintRegularFile(opaqueEvidence, false).fingerprint;
  if (!sameOpaqueBytes(published, original)) {
    throw new Error("published recovery-marker evidence does not match its source");
  }
  const sourceBeforeCommit = corruptMarkerSnapshotForRescue(roots.marker);
  if (!sameFileIdentity(sourceBeforeCommit, original) || !sameOpaqueBytes(sourceBeforeCommit, original)) {
    throw new Error("recovery marker changed before the rescue commit");
  }
  fsyncRealDirectory(paths.evidence, "metadata recovery evidence directory");
  fsyncRealDirectory(paths.transactionDir, "metadata recovery transaction directory");
  fsyncRealDirectory(paths.dataRoot, "metadata recovery rescue data root");
  fsyncRealDirectory(paths.runtimeDir, "runtime metadata directory");
  checkpoint(paths, {
    ...provisional,
    phase: "archiving",
    archivedEvidence: [PRIOR_RECOVERY_MARKER_EVIDENCE],
    updatedAt: nowIso(ops)
  }, "marker-rescue-committed", ops, "marker-rescue-commit");
  return resumeMetadataRecoveryCore({ ...options, operations: ops });
}
function resumeMetadataRecoveryCore(options) {
  const ops = operations(options.operations);
  const builtinVersion = assertSafeVersion(options.builtinVersion);
  const roots = recoveryRootPaths(options.baseDir);
  const source = sourcePathHash(options.dshHome, roots.runtimeDir);
  const existing = readMetadataRecoveryState(options.baseDir);
  if (existing.kind === "corrupt") throw new Error(existing.error);
  let paths;
  let record;
  if (existing.kind === "valid" && existing.record.phase !== "finalized") {
    record = existing.record;
    if (record.builtinVersion !== builtinVersion) {
      throw new Error(`metadata recovery is pinned to builtin ${record.builtinVersion}; refusing ${builtinVersion}`);
    }
    if (record.dshHomePathHash !== source.hash) throw new Error("metadata recovery DSH_HOME identity changed");
    paths = recoveryPaths(options.baseDir, record.id, record.storageKind);
    ensureRecoveryDirectories(paths);
  } else {
    const health = detectRuntimeMetadataHealth(options.baseDir, options.shellVersion);
    if (health.status !== "selection-corrupt") {
      return existing.kind === "valid" ? { phase: "finalized", record: existing.record } : { phase: "not-needed", record: null };
    }
    if (!existsSync5(roots.runtimeDir)) throw new Error("runtime metadata directory disappeared");
    const evidenceFiles = collectEvidence(roots.runtimeDir);
    ({ paths, record } = newRecoveryRecord(
      options.baseDir,
      builtinVersion,
      source.hash,
      source.missing,
      evidenceFiles,
      ops
    ));
  }
  if (record.phase === "probe-required") {
    assertPublishedStash(paths, record);
    assertNoUnplannedEvidence(paths, record);
    return { phase: "probe-required", record };
  }
  if (record.phase === "finalized") return { phase: "finalized", record };
  ensurePublishedStash(paths, source.dshHome, record, ops);
  if (record.phase === "stashing") {
    record = checkpoint(paths, {
      ...record,
      phase: "archiving",
      updatedAt: nowIso(ops)
    }, "archiving", ops);
  }
  if (record.phase !== "archiving") throw new Error(`unsupported metadata recovery phase: ${record.phase}`);
  for (const name of record.evidenceFiles) {
    archiveEvidenceFile(paths, name, ops);
    if (!record.archivedEvidence.includes(name)) {
      record = checkpoint(paths, {
        ...record,
        archivedEvidence: [...record.archivedEvidence, name].sort(),
        updatedAt: nowIso(ops)
      }, `evidence:${name}`, ops);
    }
  }
  assertPublishedStash(paths, record);
  assertNoUnplannedEvidence(paths, record);
  record = checkpoint(paths, {
    ...record,
    phase: "probe-required",
    archivedEvidence: [...record.evidenceFiles],
    updatedAt: nowIso(ops)
  }, "probe-required", ops);
  return { phase: "probe-required", record };
}
function selectionMetadataIsAbsent(baseDir) {
  const health = detectRuntimeMetadataHealth(baseDir);
  return health.current.kind === "missing" && health.override.kind === "missing" && health.activationJournal.kind === "missing" && health.corruptEvidence.length === 0;
}
function recordMetadataRecoveryProbeFailure(baseDir, expectedRecoveryId, error, injected) {
  const ops = operations(injected);
  const state = readMetadataRecoveryState(baseDir);
  if (state.kind !== "valid" || state.record.phase !== "probe-required") {
    throw new Error("metadata recovery is not awaiting a probe");
  }
  if (state.record.id !== assertRecoveryId(expectedRecoveryId)) throw new Error("metadata recovery id changed");
  const paths = recoveryPaths(baseDir, state.record.id, state.record.storageKind);
  assertPublishedStash(paths, state.record);
  assertNoUnplannedEvidence(paths, state.record);
  const timestamp = nowIso(ops);
  const message = sanitizeErrorText(error instanceof Error ? error.message : String(error)).slice(0, 4e3) || "builtin runtime probe failed";
  return checkpoint(paths, {
    ...state.record,
    probeAttempts: state.record.probeAttempts + 1,
    lastProbeAt: timestamp,
    lastProbeError: message,
    updatedAt: timestamp
  }, "probe-failed", ops);
}
function finalizeMetadataRecovery(baseDir, expectedRecoveryId, injected) {
  const ops = operations(injected);
  const state = readMetadataRecoveryState(baseDir);
  if (state.kind !== "valid" || state.record.phase !== "probe-required") {
    throw new Error("metadata recovery is not awaiting a successful probe");
  }
  if (state.record.id !== assertRecoveryId(expectedRecoveryId)) throw new Error("metadata recovery id changed");
  const paths = recoveryPaths(baseDir, state.record.id, state.record.storageKind);
  assertPublishedStash(paths, state.record);
  assertNoUnplannedEvidence(paths, state.record);
  if (!selectionMetadataIsAbsent(baseDir)) throw new Error("selection metadata reappeared before recovery finalization");
  const timestamp = nowIso(ops);
  const finalized = {
    ...state.record,
    phase: "finalized",
    probeAttempts: state.record.probeAttempts + 1,
    lastProbeAt: timestamp,
    lastProbeError: null,
    updatedAt: timestamp,
    finalizedAt: timestamp
  };
  writePrivateJson(paths.finalizedReceipt, finalized, paths.runtimeDir, ops, "receipt-write");
  return checkpoint(paths, finalized, "finalized", ops);
}
function assertRestoreOutcome(outcome) {
  if (outcome !== "none" && outcome !== "complete" && outcome !== "half" && outcome !== "incomplete") {
    throw new Error("completeRestore returned an invalid outcome");
  }
}
function restoreBlockedResult(outcome, record) {
  return {
    status: "restore-blocked",
    phase: "restore-blocked",
    record,
    restoreOutcome: outcome,
    error: outcome === "half" ? "an interrupted DSH_HOME restore is only partially complete" : "an interrupted DSH_HOME restore is incomplete"
  };
}
async function probeAndFinalizeMetadataRecovery(options, resumed, restoreOutcome) {
  if (resumed.phase === "not-needed") {
    return { status: "not-needed", phase: "not-needed", record: null, restoreOutcome: "none", error: null };
  }
  if (resumed.phase === "finalized") {
    return {
      status: "already-finalized",
      phase: "finalized",
      record: resumed.record,
      restoreOutcome,
      error: null
    };
  }
  let probe;
  try {
    probe = await options.probeBuiltin();
  } catch (error) {
    probe = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (probe === null || typeof probe !== "object" || typeof probe.ok !== "boolean") {
    probe = { ok: false, error: "probeBuiltin returned an invalid result" };
  }
  if (!probe.ok) {
    const failed = recordMetadataRecoveryProbeFailure(
      options.baseDir,
      resumed.record.id,
      probe.error,
      options.operations
    );
    let error = failed.lastProbeError ?? "builtin runtime probe failed";
    try {
      await options.stopHost();
    } catch (stopError) {
      error = `${error}; failed to stop rejected builtin: ${sanitizeErrorText(stopError instanceof Error ? stopError.message : String(stopError))}`;
    }
    return {
      status: "probe-failed",
      phase: "probe-required",
      record: failed,
      restoreOutcome,
      error
    };
  }
  const finalized = finalizeMetadataRecovery(
    options.baseDir,
    resumed.record.id,
    options.operations
  );
  return {
    status: "finalized",
    phase: "finalized",
    record: finalized,
    restoreOutcome,
    error: null
  };
}
async function rescueCorruptMetadataRecoveryMarker(options) {
  assertSafeVersion(options.builtinVersion);
  const capability = inspectCorruptMetadataRecoveryMarker(options.baseDir);
  if (!capability.recoverable) {
    throw new Error(`corrupt recovery marker cannot be rescued: ${capability.reason}`);
  }
  await options.stopHost();
  const restoreOutcome = await options.completeRestore();
  assertRestoreOutcome(restoreOutcome);
  if (restoreOutcome === "half") {
    return restoreBlockedResult(restoreOutcome, null);
  }
  const resumed = bootstrapCorruptMetadataRecoveryMarker(options);
  return probeAndFinalizeMetadataRecovery(options, resumed, restoreOutcome);
}
async function recoverRuntimeMetadata(options) {
  assertSafeVersion(options.builtinVersion);
  const initial = detectRuntimeMetadataHealth(options.baseDir, options.shellVersion);
  if (initial.recovery.kind === "corrupt") throw new Error(initial.recovery.error);
  if (initial.recovery.kind === "missing" && initial.status !== "selection-corrupt") {
    return { status: "not-needed", phase: "not-needed", record: null, restoreOutcome: "none", error: null };
  }
  if (initial.recovery.kind === "valid" && initial.recovery.record.phase === "finalized" && initial.status !== "selection-corrupt") {
    return {
      status: "already-finalized",
      phase: "finalized",
      record: initial.recovery.record,
      restoreOutcome: "none",
      error: null
    };
  }
  await options.stopHost();
  const restoreOutcome = await options.completeRestore();
  assertRestoreOutcome(restoreOutcome);
  if (restoreOutcome === "half") {
    return restoreBlockedResult(
      restoreOutcome,
      initial.recovery.kind === "valid" ? initial.recovery.record : null
    );
  }
  const resumed = resumeMetadataRecoveryCore(options);
  return probeAndFinalizeMetadataRecovery(options, resumed, restoreOutcome);
}

// src/runtime-operation-fence.ts
var RuntimeOperationFence = class {
  activeOwner = null;
  waiters = [];
  get busy() {
    return this.activeOwner !== null || this.waiters.length > 0;
  }
  get owner() {
    return this.activeOwner;
  }
  tryAcquire(owner) {
    if (owner.length === 0 || this.activeOwner !== null || this.waiters.length > 0) return null;
    this.activeOwner = owner;
    return this.makeLease(owner);
  }
  acquire(owner, signal) {
    if (owner.length === 0) return Promise.reject(new Error("operation owner is required"));
    if (signal?.aborted) return Promise.reject(new Error("operation acquisition aborted"));
    const immediate = this.tryAcquire(owner);
    if (immediate !== null) return Promise.resolve(immediate);
    return new Promise((resolve3, reject) => {
      const waiter = { owner, resolve: resolve3, reject, signal };
      if (signal !== void 0) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("operation acquisition aborted"));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }
  makeLease(owner) {
    let released = false;
    return {
      owner,
      release: () => {
        if (released) return;
        released = true;
        if (this.activeOwner !== owner) return;
        this.activeOwner = null;
        this.wakeNext();
      }
    };
  }
  wakeNext() {
    while (this.activeOwner === null && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter.abort !== void 0) waiter.signal?.removeEventListener("abort", waiter.abort);
      if (waiter.signal?.aborted) {
        waiter.reject(new Error("operation acquisition aborted"));
        continue;
      }
      this.activeOwner = waiter.owner;
      waiter.resolve(this.makeLease(waiter.owner));
    }
  }
};

// src/runtime-probes.ts
import { constants as constants4 } from "node:fs";
import { open as open2 } from "node:fs/promises";
import { join as join8 } from "node:path";
import { TextDecoder } from "node:util";
var SETTINGS_FILE_MAX_BYTES = 16 * 1024 * 1024;
var MAX_TIMER_MS = 2147483647;
var SETTINGS_FILE_READ_CHUNK_BYTES = 64 * 1024;
var COMMAND_SYNTAX_MISS = "dsh-chamber-activation-probe";
var COMMAND_MISSING_SESSION = "__dsh_chamber_missing_session_probe__";
function renderError(error) {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "<unrenderable error>";
  }
}
var resultError = (error) => {
  const withoutQuotedPaths = renderError(error).replace(/(['"])(?:[A-Za-z]:[\\/]|\/)[^'"\r\n]*\1/gu, "[path]");
  return sanitizeErrorText(withoutQuotedPaths).slice(0, 2e3);
};
function abortReason(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(typeof signal.reason === "string" ? signal.reason : "runtime probe aborted");
}
function raceWithSignal(operation, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve3, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve3(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
function safeFsCode(error) {
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : void 0;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/u.test(code) ? ` (${code})` : "";
}
async function readBoundedRegularUtf8File(filePath, signal) {
  signal.throwIfAborted();
  let handle;
  try {
    handle = await open2(filePath, constants4.O_RDONLY | constants4.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`settings.yaml could not be opened${safeFsCode(error)}`);
  }
  try {
    let info;
    try {
      info = await handle.stat();
    } catch (error) {
      throw new Error(`settings.yaml could not be inspected${safeFsCode(error)}`);
    }
    if (!info.isFile()) throw new Error("settings.yaml is not a regular file");
    if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > SETTINGS_FILE_MAX_BYTES) {
      throw new Error("settings.yaml is unexpectedly large");
    }
    const capacity = Math.min(SETTINGS_FILE_MAX_BYTES + 1, Math.max(1, info.size + 1));
    const bytes = Buffer.allocUnsafe(capacity);
    let offset = 0;
    while (offset < capacity) {
      signal.throwIfAborted();
      const length = Math.min(SETTINGS_FILE_READ_CHUNK_BYTES, capacity - offset);
      let bytesRead;
      try {
        const readResult = await handle.read(bytes, offset, length, null);
        bytesRead = readResult.bytesRead;
      } catch (error) {
        throw new Error(`settings.yaml could not be read${safeFsCode(error)}`);
      }
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== info.size || offset > SETTINGS_FILE_MAX_BYTES) {
      throw new Error("settings.yaml changed while being read or is unexpectedly large");
    }
    signal.throwIfAborted();
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    } catch {
      throw new Error("settings.yaml is not valid UTF-8");
    }
  } finally {
    await handle.close().catch(() => {
    });
  }
}
function sessionItems(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const items = value.items;
  if (!Array.isArray(items) || !items.every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) return null;
  return items;
}
function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function graphValue(value) {
  return objectValue(value) && Array.isArray(value.entries);
}
function settingsValue(value) {
  return objectValue(value) && Array.isArray(value.namespaces);
}
function expectedGitValidationMiss(value) {
  if (!objectValue(value)) return false;
  const result = value;
  if (result.ok !== false || !objectValue(result.error)) return false;
  return result.error.code === "invalid-input";
}
async function runRuntimeActivationProbes(opts) {
  const windowMs = opts.windowMs ?? 6e4;
  const rpcTimeoutMs = opts.rpcTimeoutMs ?? 7500;
  if (!Number.isInteger(windowMs) || windowMs <= 0 || windowMs > MAX_TIMER_MS) {
    throw new Error("probe window must be a positive timer-safe integer");
  }
  if (!Number.isInteger(rpcTimeoutMs) || rpcTimeoutMs <= 0 || rpcTimeoutMs > MAX_TIMER_MS) {
    throw new Error("RPC timeout must be a positive timer-safe integer");
  }
  const windowSignal = AbortSignal.timeout(windowMs);
  const signal = opts.signal === void 0 ? windowSignal : AbortSignal.any([opts.signal, windowSignal]);
  const perCallTimeoutMs = Math.min(windowMs, rpcTimeoutMs);
  const call = (method, payload) => {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    const rpcDeadline = new AbortController();
    const timer = setTimeout(
      () => rpcDeadline.abort(new Error("runtime RPC probe timed out")),
      perCallTimeoutMs
    );
    const rpcSignal = AbortSignal.any([signal, rpcDeadline.signal]);
    const operation = Promise.resolve().then(() => opts.call(opts.baseUrl, method, payload, {
      signal: rpcSignal,
      timeoutMs: perCallTimeoutMs
    }));
    return raceWithSignal(operation, rpcSignal).finally(() => clearTimeout(timer));
  };
  let sessionsValue;
  let settingsRpcOk = false;
  const probe = async (name, method, payload, accept) => {
    try {
      const response = await call(method, payload);
      const value = response.result?.value;
      if (accept !== void 0 && !accept(value)) {
        return { name, ok: false, error: "malformed probe response" };
      }
      return { name, ok: true };
    } catch (error) {
      return { name, ok: false, error: resultError(error) };
    }
  };
  const hostDomains = opts.hostDomains !== false;
  const [sessions, graph, settings, git] = await Promise.all([
    // host.describe was deleted upstream (dsh-v0.1.2-alpha.1); the surviving
    // session/list read-only unary doubles as the host-capability probe
    // proving the installed dsh answers the business wire.
    (async () => {
      try {
        const response = await call("session/list", { args: { _request: {} } });
        sessionsValue = response.result?.value;
        return sessionItems(sessionsValue) === null ? { name: "session/list", ok: false, error: "malformed session list" } : { name: "session/list", ok: true };
      } catch (error) {
        return { name: "session/list", ok: false, error: resultError(error) };
      }
    })(),
    hostDomains ? probe("clientGraph/graph", "clientGraph/graph", { args: {} }, graphValue) : Promise.resolve(null),
    (async () => {
      const outcome = await probe("settings/describe", "settings/describe", { args: {} }, settingsValue);
      settingsRpcOk = outcome.ok;
      return outcome;
    })(),
    // Empty input is rejected by domain validation before any git process or
    // repository scan. Require that exact business miss; a success value would
    // no longer prove the request stayed on the side-effect-free path.
    hostDomains ? probe(
      "gitWorktree/previewCreate",
      "gitWorktree/previewCreate",
      { args: { input: {} } },
      expectedGitValidationMiss
    ) : Promise.resolve(null)
  ]);
  let commands;
  try {
    await call("commands/execute", {
      args: {
        agentId: COMMAND_MISSING_SESSION,
        line: COMMAND_SYNTAX_MISS,
        images: []
      }
    });
    commands = { name: "commands/execute", ok: false, error: "missing-session command probe unexpectedly executed" };
  } catch (error) {
    const code = typeof error === "object" && error !== null ? error.code : void 0;
    commands = code === "session/not-found" ? { name: "commands/execute", ok: true } : { name: "commands/execute", ok: false, error: resultError(error) };
  }
  let dataSettings;
  try {
    await readBoundedRegularUtf8File(join8(opts.dshHome, "settings.yaml"), signal);
    if (!settingsRpcOk) throw new Error("settings RPC could not parse the active profile");
    dataSettings = { name: "data.settings", ok: true };
  } catch (error) {
    dataSettings = { name: "data.settings", ok: false, error: resultError(error) };
  }
  const dataSessions = sessionItems(sessionsValue) !== null ? { name: "data.sessions", ok: true } : { name: "data.sessions", ok: false, error: "session data is unreadable" };
  const byName = /* @__PURE__ */ new Map();
  byName.set(commands.name, commands);
  byName.set(sessions.name, sessions);
  if (hostDomains) {
    if (graph === null || git === null) throw new Error("internal: chamber host-domain probes did not run");
    byName.set(graph.name, graph);
    byName.set(git.name, git);
  }
  byName.set(settings.name, settings);
  byName.set(dataSettings.name, dataSettings);
  byName.set(dataSessions.name, dataSessions);
  const expected = hostDomains ? REQUIRED_ACTIVATION_PROBES : PROBE_NAMES_WITHOUT_HOST_DOMAINS;
  return expected.map((name) => byName.get(name) ?? { name, ok: false, error: "probe not wired" });
}

// src/runtime-startup.ts
function shouldProbeEnvWithDormantCorruptSelection(status, envOverrideActive) {
  return envOverrideActive && status === "selection-corrupt";
}
function outcomeError(outcome) {
  if (outcome.error !== null) return outcome.error;
  if (outcome.status === "rolled-back") return "activation probe failed; runtime rolled back";
  if (outcome.status === "snapshot-failed") return "runtime data snapshot failed";
  return "runtime activation failed";
}
function reachedSafeFallback(outcome) {
  return outcome.status === "rolled-back" || outcome.status === "failed" && outcome.failureKind === "terminal" && !outcome.runtimeBlocked;
}
function resultBase(restored, blockedReason, cleanedWorkDirs, evicted, monitoringJournal = null) {
  return { applyOutcome: null, restored, blockedReason, cleanedWorkDirs, evicted, monitoringJournal };
}
function normalizedIntent(input) {
  return {
    targetVersion: input.targetVersion,
    targetIsBuiltin: input.targetIsBuiltin,
    manualRollback: input.manualRollback,
    intentKind: input.intentKind
  };
}
function convertMonitoringToIntent(_journal, intent) {
  return {
    schemaVersion: 1,
    phase: "intent",
    ...normalizedIntent(intent),
    sourceVersion: null,
    sourceIsBuiltin: null,
    sourceWasKnownGood: null,
    knownGoodVersion: null,
    preSwapSnapshotName: null,
    manualDataSnapshotName: null,
    preRollbackStashName: null,
    rollbackTarget: null,
    nextIntent: null,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function resumedRestorePhase(journal) {
  const phase = journal.phase === "restoring" ? "restore-complete" : journal.phase === "manual-restoring" ? "manual-restored" : null;
  if (phase === null) return null;
  return { ...journal, phase, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
}
function safeClearJournal(deps) {
  try {
    deps.clearActivationJournal();
  } catch {
  }
}
function pointerVersion(state) {
  return state.kind === "valid" ? state.version : null;
}
function corruptMetadataReason(journal, pointer, override) {
  if (journal.kind === "corrupt") return "journal-corrupt";
  if (pointer.kind === "corrupt") return "current-corrupt";
  if (override.kind === "corrupt") return "override-corrupt";
  return null;
}
async function runStartupPhase(deps, signal) {
  let journalState = deps.readActivationJournal();
  let pointerState = deps.readCurrentPointerState();
  let overrideState = deps.readOverrideState();
  const initialMetadataError = corruptMetadataReason(journalState, pointerState, overrideState);
  if (initialMetadataError !== null) {
    const restored2 = await deps.completeInterruptedRestore();
    if (restored2 === "half" || restored2 === "incomplete") {
      return resultBase(restored2, restored2 === "half" ? "restore-half" : "restore-incomplete", [], []);
    }
    if (deps.envOverrideActive?.() === true) {
      return resultBase(restored2, "env-override", [], []);
    }
    return resultBase(restored2, initialMetadataError, [], []);
  }
  const cleanedWorkDirs = deps.cleanupStaleInstalls();
  const evicted = deps.evict();
  const restored = await deps.completeInterruptedRestore();
  if (restored === "half" || restored === "incomplete") {
    return resultBase(
      restored,
      restored === "half" ? "restore-half" : "restore-incomplete",
      cleanedWorkDirs,
      evicted
    );
  }
  journalState = deps.readActivationJournal();
  pointerState = deps.readCurrentPointerState();
  overrideState = deps.readOverrideState();
  const metadataError = corruptMetadataReason(journalState, pointerState, overrideState);
  if (metadataError !== null) {
    return resultBase(restored, metadataError, cleanedWorkDirs, evicted);
  }
  if (restored === "complete" && journalState.kind === "valid") {
    const resumed = resumedRestorePhase(journalState.journal);
    if (resumed !== null) {
      try {
        deps.writeActivationJournal(resumed);
        journalState = { kind: "valid", journal: resumed };
      } catch {
        return resultBase(restored, "journal-corrupt", cleanedWorkDirs, evicted);
      }
    }
  }
  const override = overrideState.kind === "valid" ? overrideState.record : null;
  const effectivePending2 = effectivePending(override, deps.shellVersion);
  if (deps.envOverrideActive?.() === true) {
    const monitoring = journalState.kind === "valid" && journalState.journal.phase === "applied-monitoring" ? journalState.journal : null;
    return resultBase(restored, "env-override", cleanedWorkDirs, evicted, monitoring);
  }
  let journal = journalState.kind === "valid" ? journalState.journal : null;
  if (journal?.phase === "applied-monitoring") {
    const queued = journal.nextIntent;
    const expectedPointer = journal.targetIsBuiltin ? null : journal.targetVersion;
    if (pointerVersion(pointerState) !== expectedPointer) {
      return resultBase(restored, "journal-mismatch", cleanedWorkDirs, evicted, journal);
    }
    if (queued === null) {
      if (!journal.targetIsBuiltin && override?.pending === journal.targetVersion) {
        deps.writeOverride({
          ...override,
          chosenVersion: journal.targetVersion,
          resolvedVersion: journal.targetVersion,
          pending: null,
          swapAttempted: false,
          lastOutcome: "applied",
          lastError: null,
          restoreOutcome: "none"
        });
        return resultBase(restored, null, cleanedWorkDirs, evicted, journal);
      }
      if (journal.targetIsBuiltin) {
        if (journal.intentKind === "version-switch") {
          return resultBase(restored, "journal-mismatch", cleanedWorkDirs, evicted, journal);
        }
        if (journal.intentKind === "reset-builtin") {
          deps.deleteOverride();
        } else {
          if (override === null) {
            return resultBase(restored, "journal-mismatch", cleanedWorkDirs, evicted, journal);
          }
          deps.writeOverride({
            ...override,
            swapAttempted: false,
            invalidatedAt: override.invalidatedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
            invalidatedReason: override.invalidatedReason ?? "shell-version-changed",
            lastInvalidatedAt: override.lastInvalidatedAt ?? override.invalidatedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
            lastInvalidatedReason: override.lastInvalidatedReason ?? override.invalidatedReason ?? "shell-version-changed",
            lastInvalidatedFromVersion: override.lastInvalidatedFromVersion ?? override.resolvedVersion ?? override.chosenVersion,
            lastInvalidationRecovered: false,
            lastOutcome: "applied",
            lastError: null,
            restoreOutcome: "none"
          });
        }
        safeClearJournal(deps);
        return resultBase(restored, null, cleanedWorkDirs, evicted);
      }
      if (effectivePending2 === null) {
        return resultBase(restored, null, cleanedWorkDirs, evicted, journal);
      }
      return resultBase(restored, "journal-mismatch", cleanedWorkDirs, evicted, journal);
    }
    if (queued !== null && !queued.targetIsBuiltin && effectivePending2 === null) {
      const monitoring = { ...journal, nextIntent: null, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
      deps.writeActivationJournal(monitoring);
      return resultBase(restored, null, cleanedWorkDirs, evicted, monitoring);
    }
    const intent = queued;
    if (!intent.targetIsBuiltin && effectivePending2 !== intent.targetVersion) {
      return resultBase(restored, "journal-mismatch", cleanedWorkDirs, evicted, journal);
    }
    journal = convertMonitoringToIntent(journal, intent);
    deps.writeActivationJournal(journal);
  }
  if (journal?.phase === "intent") {
    if (journal.targetIsBuiltin && journal.intentKind === "shell-invalidation" && override === null) {
      return resultBase(restored, "journal-mismatch", cleanedWorkDirs, evicted);
    }
    if (!journal.targetIsBuiltin && effectivePending2 === null) {
      safeClearJournal(deps);
      return resultBase(restored, null, cleanedWorkDirs, evicted);
    }
    if (!journal.targetIsBuiltin && effectivePending2 !== journal.targetVersion) {
      return resultBase(restored, "journal-mismatch", cleanedWorkDirs, evicted);
    }
  }
  const overrideInvalidated = override !== null && (override.invalidatedAt != null || override.shellVersion !== deps.shellVersion);
  const journalIsRollbackContinuation = journal?.phase === "rollback-needed" || journal?.phase === "restoring" || journal?.phase === "restore-complete" || journal?.phase === "fallback-builtin";
  if (overrideInvalidated && journal?.intentKind === "version-switch" && !journalIsRollbackContinuation) {
    return resultBase(
      restored,
      "journal-mismatch",
      cleanedWorkDirs,
      evicted,
      journal.phase === "applied-monitoring" ? journal : null
    );
  }
  if (journal !== null && effectivePending2 !== null && !journal.targetIsBuiltin) {
    const expectedPending = journal.nextIntent !== null && !journal.nextIntent.targetIsBuiltin ? journal.nextIntent.targetVersion : journal.targetVersion;
    if (expectedPending !== effectivePending2) {
      return resultBase(
        restored,
        "journal-mismatch",
        cleanedWorkDirs,
        evicted,
        journal.phase === "applied-monitoring" ? journal : null
      );
    }
  }
  const recoveryInFlight = journal !== null && journal.phase !== "intent" && journal.phase !== "applied-monitoring";
  if (!recoveryInFlight && journal === null && effectivePending2 === null) {
    return resultBase(restored, null, cleanedWorkDirs, evicted);
  }
  if (journal === null && effectivePending2 !== null && pointerVersion(pointerState) === effectivePending2) {
    return resultBase(restored, "journal-mismatch", cleanedWorkDirs, evicted);
  }
  const targetVersion = journal?.targetVersion ?? effectivePending2;
  if (targetVersion === null) return resultBase(restored, "journal-mismatch", cleanedWorkDirs, evicted);
  const targetIsBuiltin = journal?.targetIsBuiltin ?? false;
  const intentKind = journal?.intentKind ?? "version-switch";
  const restoreRecovery = journal?.phase === "restoring" || journal?.phase === "restore-complete" || journal?.phase === "manual-restoring" || journal?.phase === "manual-restored";
  if (!restoreRecovery && override !== null) {
    if (override.lastOutcome === "snapshot-failed") {
      return resultBase(restored, "snapshot-failed", cleanedWorkDirs, evicted);
    }
    if (override.swapAttempted) {
      return resultBase(restored, "swap-attempted", cleanedWorkDirs, evicted);
    }
  }
  const facts = journal !== null && journal.phase !== "intent" ? {
    sourceVersion: journal.sourceVersion,
    sourceIsBuiltin: journal.sourceIsBuiltin === true,
    sourceWasKnownGood: journal.sourceWasKnownGood === true,
    knownGoodVersion: journal.knownGoodVersion
  } : deps.activationFacts();
  const applyOutcome = await applyPendingVersion({
    pendingVersion: targetVersion,
    builtinVersion: deps.builtinVersion,
    targetIsBuiltin,
    intentKind: journal?.intentKind ?? "version-switch",
    sourceVersion: facts.sourceVersion,
    sourceIsBuiltin: facts.sourceIsBuiltin,
    sourceWasKnownGood: facts.sourceWasKnownGood,
    knownGoodVersion: facts.knownGoodVersion,
    journal,
    manualRollback: journal?.manualRollback ?? false,
    signal,
    deps: {
      snapshot: deps.snapshot,
      resolveSnapshotName: deps.resolveSnapshotName,
      prepareManualRollback: deps.prepareManualRollback,
      readCurrentPointerState: deps.readCurrentPointerState,
      validateTarget: deps.validateTarget,
      switchPointer: deps.switchPointer,
      probe: deps.spawnAndProbe,
      probeExpectedNames: deps.probeExpectedNames,
      stopHost: deps.stopHost,
      restore: deps.restore,
      recordProbePass: deps.recordProbePass,
      readActivationJournal: deps.readActivationJournal,
      writeActivationJournal: deps.writeActivationJournal,
      waitBeforeRetry: deps.waitBeforeRetry
    }
  });
  const verdictJournalState = deps.readActivationJournal();
  if (verdictJournalState.kind === "corrupt") {
    return {
      applyOutcome,
      restored,
      blockedReason: "journal-corrupt",
      cleanedWorkDirs,
      evicted,
      monitoringJournal: null
    };
  }
  const verdictJournal = verdictJournalState.kind === "valid" ? verdictJournalState.journal : null;
  const queuedIntent = verdictJournal?.nextIntent ?? null;
  const currentState = deps.readOverrideState();
  if (currentState.kind === "corrupt") {
    return {
      applyOutcome,
      restored,
      blockedReason: "override-corrupt",
      cleanedWorkDirs,
      evicted,
      monitoringJournal: null
    };
  }
  const current = currentState.kind === "valid" ? currentState.record : null;
  const resetBuiltinApplied = targetIsBuiltin && intentKind === "reset-builtin" && applyOutcome.status === "applied";
  if (resetBuiltinApplied) {
    deps.deleteOverride();
  } else if (current !== null) {
    const next = {
      ...current,
      pending: queuedIntent !== null && !queuedIntent.targetIsBuiltin ? current.pending : targetIsBuiltin ? current.pending : applyOutcome.retainPending ? targetVersion : null,
      swapAttempted: applyOutcome.retryAction === "apply" && applyOutcome.status === "failed",
      lastOutcome: applyOutcome.status,
      lastError: applyOutcome.error,
      restoreOutcome: applyOutcome.restoreOutcome
    };
    if (!targetIsBuiltin && applyOutcome.status === "applied") {
      next.chosenVersion = targetVersion;
      next.resolvedVersion = targetVersion;
      next.swapAttempted = false;
    } else if (targetIsBuiltin && applyOutcome.status === "applied") {
      next.invalidatedAt = current.invalidatedAt ?? (/* @__PURE__ */ new Date()).toISOString();
      next.invalidatedReason = current.invalidatedReason ?? "shell-version-changed";
      next.lastInvalidatedAt = current.lastInvalidatedAt ?? next.invalidatedAt;
      next.lastInvalidatedReason = current.lastInvalidatedReason ?? next.invalidatedReason;
      next.lastInvalidatedFromVersion = current.lastInvalidatedFromVersion ?? current.resolvedVersion ?? current.chosenVersion;
      next.lastInvalidationRecovered = false;
      next.swapAttempted = false;
    } else if (applyOutcome.status === "rolled-back" && applyOutcome.rollbackTarget !== null) {
      next.chosenVersion = applyOutcome.rollbackTarget;
      next.resolvedVersion = applyOutcome.rollbackTarget;
    }
    if (targetIsBuiltin && applyOutcome.status === "rolled-back" && applyOutcome.rollbackTarget !== null) {
      next.shellVersion = deps.shellVersion;
      next.invalidatedAt = null;
      next.invalidatedReason = null;
      next.lastInvalidatedAt = current.lastInvalidatedAt ?? current.invalidatedAt ?? (/* @__PURE__ */ new Date()).toISOString();
      next.lastInvalidatedReason = current.lastInvalidatedReason ?? current.invalidatedReason ?? "shell-version-changed";
      next.lastInvalidatedFromVersion = current.lastInvalidatedFromVersion ?? current.resolvedVersion ?? current.chosenVersion;
      next.lastInvalidationRecovered = true;
      next.pending = null;
      next.chosenVersion = applyOutcome.rollbackTarget;
      next.resolvedVersion = applyOutcome.rollbackTarget;
      next.swapAttempted = false;
    }
    deps.writeOverride(next);
  }
  const keepMonitoring = applyOutcome.status === "applied" && !targetIsBuiltin;
  let postApplyJournalMismatch = false;
  if (reachedSafeFallback(applyOutcome) && verdictJournal !== null && queuedIntent !== null) {
    if (queuedIntent.targetIsBuiltin || current?.pending === queuedIntent.targetVersion) {
      deps.writeActivationJournal(convertMonitoringToIntent(verdictJournal, queuedIntent));
    } else if (current?.pending == null) {
      safeClearJournal(deps);
    } else {
      postApplyJournalMismatch = true;
    }
  } else if (!applyOutcome.retainPending && !keepMonitoring && queuedIntent === null) {
    safeClearJournal(deps);
  }
  if (applyOutcome.status !== "applied") {
    try {
      deps.recordFailure({
        version: targetVersion,
        phase: applyOutcome.failureKind ?? applyOutcome.status,
        error: outcomeError(applyOutcome),
        restoreOutcome: applyOutcome.restoreOutcome,
        snapshotPath: applyOutcome.snapshotPath
      });
    } catch {
    }
  }
  const latestJournal = deps.readActivationJournal();
  const monitoringJournal = latestJournal.kind === "valid" && latestJournal.journal.phase === "applied-monitoring" ? latestJournal.journal : null;
  const blockedReason = latestJournal.kind === "corrupt" ? "journal-corrupt" : postApplyJournalMismatch ? "journal-mismatch" : applyOutcome.status === "snapshot-failed" ? "snapshot-failed" : applyOutcome.runtimeBlocked && applyOutcome.restoreOutcome === "half" ? "restore-half" : applyOutcome.runtimeBlocked && applyOutcome.restoreOutcome === "incomplete" ? "restore-incomplete" : applyOutcome.retryAction === "apply" && applyOutcome.status === "failed" ? "swap-attempted" : null;
  return {
    applyOutcome,
    restored,
    blockedReason,
    cleanedWorkDirs,
    evicted,
    monitoringJournal
  };
}
async function runDelayedRollback(deps, monitoring, signal) {
  if (deps.envOverrideActive?.() === true) throw new Error("env override active; persisted F7 rollback is deferred");
  const durableState = deps.readActivationJournal();
  if (durableState.kind !== "valid" || durableState.journal.phase !== "applied-monitoring") {
    throw new Error("F7 rollback requires a durable applied-monitoring journal");
  }
  if (durableState.journal.startedAt !== monitoring.startedAt || durableState.journal.targetVersion !== monitoring.targetVersion) {
    throw new Error("F7 monitoring handle is stale");
  }
  if (durableState.journal.targetIsBuiltin) throw new Error("builtin runtime is not an F7 override target");
  const pointer = deps.readCurrentPointerState();
  if (pointer.kind !== "valid" || pointer.version !== durableState.journal.targetVersion) {
    throw new Error("F7 current pointer no longer matches the monitored activation");
  }
  if (deps.readOverrideState().kind === "corrupt") throw new Error("override metadata \u635F\u574F\uFF1B\u62D2\u7EDD F7 \u56DE\u9000");
  const journal = beginDelayedRollback(durableState.journal, deps.writeActivationJournal);
  const targetVersion = journal.targetVersion;
  const applyOutcome = await applyPendingVersion({
    pendingVersion: targetVersion,
    builtinVersion: deps.builtinVersion,
    targetIsBuiltin: journal.targetIsBuiltin,
    intentKind: journal.intentKind,
    sourceVersion: journal.sourceVersion,
    sourceIsBuiltin: journal.sourceIsBuiltin === true,
    sourceWasKnownGood: journal.sourceWasKnownGood === true,
    knownGoodVersion: journal.knownGoodVersion,
    journal,
    signal,
    deps: {
      snapshot: deps.snapshot,
      resolveSnapshotName: deps.resolveSnapshotName,
      prepareManualRollback: deps.prepareManualRollback,
      readCurrentPointerState: deps.readCurrentPointerState,
      validateTarget: deps.validateTarget,
      switchPointer: deps.switchPointer,
      probe: deps.spawnAndProbe,
      probeExpectedNames: deps.probeExpectedNames,
      stopHost: deps.stopHost,
      restore: deps.restore,
      recordProbePass: deps.recordProbePass,
      readActivationJournal: deps.readActivationJournal,
      writeActivationJournal: deps.writeActivationJournal,
      waitBeforeRetry: deps.waitBeforeRetry
    }
  });
  const verdictJournalState = deps.readActivationJournal();
  if (verdictJournalState.kind === "corrupt") {
    return {
      ...applyOutcome,
      status: "failed",
      retainPending: true,
      runtimeBlocked: true,
      failureKind: "journal",
      error: "F7 \u56DE\u9000\u540E activation journal \u635F\u574F\uFF1B\u62D2\u7EDD\u63D0\u4EA4\u88C1\u51B3"
    };
  }
  const verdictJournal = verdictJournalState.kind === "valid" ? verdictJournalState.journal : null;
  const queuedIntent = verdictJournal?.nextIntent ?? null;
  const currentState = deps.readOverrideState();
  if (currentState.kind === "corrupt") {
    return {
      ...applyOutcome,
      status: "failed",
      retainPending: true,
      runtimeBlocked: true,
      failureKind: "journal",
      error: "F7 \u56DE\u9000\u540E override metadata \u635F\u574F\uFF1B\u62D2\u7EDD\u63D0\u4EA4\u88C1\u51B3"
    };
  }
  const current = currentState.kind === "valid" ? currentState.record : null;
  if (current !== null) {
    const next = {
      ...current,
      pending: queuedIntent !== null && !queuedIntent.targetIsBuiltin ? current.pending : applyOutcome.retainPending ? current.pending : null,
      swapAttempted: applyOutcome.retryAction === "apply" && applyOutcome.status === "failed",
      lastOutcome: applyOutcome.status,
      lastError: applyOutcome.error,
      restoreOutcome: applyOutcome.restoreOutcome
    };
    if (applyOutcome.status === "rolled-back" && applyOutcome.rollbackTarget !== null) {
      next.chosenVersion = applyOutcome.rollbackTarget;
      next.resolvedVersion = applyOutcome.rollbackTarget;
    }
    deps.writeOverride(next);
  }
  let finalOutcome = applyOutcome;
  if (reachedSafeFallback(applyOutcome) && verdictJournal !== null && queuedIntent !== null) {
    if (queuedIntent.targetIsBuiltin || current?.pending === queuedIntent.targetVersion) {
      deps.writeActivationJournal(convertMonitoringToIntent(verdictJournal, queuedIntent));
    } else if (current?.pending == null) {
      safeClearJournal(deps);
    } else {
      finalOutcome = {
        ...applyOutcome,
        status: "failed",
        retainPending: true,
        runtimeBlocked: true,
        failureKind: "journal",
        error: "F7 queued intent \u4E0E override.pending \u4E0D\u4E00\u81F4\uFF1B\u5DF2\u5B89\u5168\u56DE\u9000\u4F46\u62D2\u7EDD\u7EE7\u7EED\u9009\u62E9"
      };
    }
  } else if (!applyOutcome.retainPending && queuedIntent === null) {
    safeClearJournal(deps);
  }
  try {
    deps.recordFailure({
      version: targetVersion,
      phase: "restart-exhausted",
      error: outcomeError(finalOutcome),
      restoreOutcome: finalOutcome.restoreOutcome,
      snapshotPath: finalOutcome.snapshotPath
    });
  } catch {
  }
  return finalOutcome;
}
async function probeKoffiLoadable(versionTreeDir) {
  const { existsSync: existsSync6 } = await import("node:fs");
  const path = await import("node:path");
  const hasBuildDir = existsSync6(path.join(versionTreeDir, "node_modules", "koffi", "build"));
  return {
    ok: hasBuildDir,
    detail: hasBuildDir ? "koffi prebuilt present (no toolchain needed)" : "koffi prebuilt missing (source build would need a toolchain)"
  };
}

// src/runtime-state-machine.ts
function transition(state, event) {
  switch (event.type) {
    case "check":
      switch (state) {
        case "idle":
        case "available":
        case "applied":
        case "rollback":
        case "failed":
        case "error":
          return "checking";
        default:
          return state;
      }
    case "check-done":
      if (state !== "checking") return state;
      return event.available ? "available" : "idle";
    case "install-confirm":
      return allowedActions(state).includes("install") ? "installing" : state;
    case "install-done":
      if (state === "installing" || state === "downloading") return "pending";
      return state;
    case "apply-start":
      if (state !== "pending") return state;
      return "applying";
    case "probe-pass":
      if (state !== "applying") return state;
      return "applied";
    case "probe-fail":
      if (state !== "applying") return state;
      return "rollback";
    case "rollback-exhausted":
      if (state !== "applying") return state;
      return "failed";
    case "snapshot-fail":
      if (state !== "applying") return state;
      return "snapshot-failed";
    case "retry-apply":
      if (state !== "snapshot-failed") return state;
      return "applying";
    case "reset-builtin":
      switch (state) {
        case "pending":
        case "applying":
        case "applied":
        case "rollback":
        case "snapshot-failed":
        case "failed":
        case "error":
          return "idle";
        default:
          return state;
      }
    case "error":
      return "error";
    default:
      return state;
  }
}
var LIFECYCLE_PROJECTION_EDGES = {
  idle: ["applying", "failed"],
  checking: [],
  available: ["applying", "failed"],
  downloading: [],
  installing: [],
  pending: ["applying", "failed"],
  applying: ["idle", "applied", "rollback", "snapshot-failed", "failed"],
  applied: ["applying", "failed"],
  rollback: ["applying", "failed"],
  "snapshot-failed": ["applying", "failed"],
  failed: ["applying"],
  // `error → idle` is reserved for a successful writer-fenced maintenance
  // action that clears the disk-accounting/quota error without changing the
  // active runtime. Reset/switch transactions still go through applying.
  error: ["idle", "applying", "failed"]
};
function transitionLifecycleProjection(current, next) {
  if (current === next) return current;
  return LIFECYCLE_PROJECTION_EDGES[current].includes(next) ? next : current;
}
function allowedActions(state, capabilities = {}) {
  switch (state) {
    case "idle": {
      const base = ["check", "restore-pre-rollback", "select-version", "install", "cleanup-version", "reset-builtin", "restart-dsh"];
      if (capabilities.canRecoverMetadata === true && capabilities.canRetryRestore !== true) {
        base.unshift("recover-metadata");
      }
      return base;
    }
    case "available":
      return ["check", "select-version", "install", "cleanup-version", "reset-builtin", "restart-dsh"];
    case "checking":
    case "downloading":
    case "installing":
      return [];
    case "pending":
      return ["apply-now", "reset-builtin"];
    case "applying":
      return ["reset-builtin"];
    case "applied":
      return ["check", "select-version", "install", "cleanup-version", "reset-builtin", "restart-dsh"];
    case "rollback": {
      const base = ["check", "restore-pre-rollback", "select-version", "install", "cleanup-version", "reset-builtin", "restart-dsh"];
      return capabilities.canRetryRestore === true ? ["retry-restore", ...base] : base;
    }
    case "failed": {
      const base = ["check", "restore-pre-rollback", "select-version", "install", "cleanup-version", "reset-builtin", "restart-dsh"];
      if (capabilities.canRetryRestore === true) base.unshift("retry-restore");
      else if (capabilities.canRecoverMetadata === true) base.unshift("recover-metadata");
      if (capabilities.canRetryApply === true) base.unshift("retry-apply");
      return base;
    }
    case "snapshot-failed":
      return capabilities.canRetryApply === true ? ["retry-apply", "reset-builtin"] : ["reset-builtin"];
    case "error":
      return ["check", "select-version", "install", "cleanup-version", "reset-builtin", "restart-dsh"];
  }
}
function isTerminal(state) {
  return state === "rollback" || state === "failed";
}

// src/index.ts
init_prune_runtime();
export {
  ALLOWED_REGISTRY_ORIGINS,
  ALLOW_BUILDS,
  BUILTIN_ANCHOR_VERSION_TOKEN,
  DEFAULT_HEALTH_POLICY,
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEFAULT_PROBE_WINDOW_MS,
  DEFAULT_REGISTRY_MAX_REDIRECTS,
  DEFAULT_REGISTRY_METADATA_MAX_BYTES,
  DEFAULT_REGISTRY_TIMEOUT_MS,
  DEFAULT_TARBALL_MAX_BYTES,
  EXACT_SEMVER,
  HOST_DOMAIN_PROBE_NAMES,
  INSTALL_ENV_WHITELIST,
  INSTALL_OUTPUT_LIMIT_BYTES,
  INSTALL_TERMINATE_GRACE_MS,
  NPMIRROR_CDN_ORIGIN,
  PRIVATE_RUNTIME_DIR_MODE,
  PRIVATE_RUNTIME_FILE_MODE,
  PROBE_NAMES_WITHOUT_HOST_DOMAINS,
  PRUNE_DIR_NAMES,
  PRUNE_FILE_PATTERNS,
  REQUIRED_ACTIVATION_PROBES,
  RUNTIME_INSTALLER_RESIDUAL_PROCESS_GROUP_ERROR,
  RUNTIME_INSTALLER_WRITER_UNSAFE_ERROR,
  RuntimeInstallerSupervisor,
  RuntimeOperationFence,
  SETTINGS_FILE_MAX_BYTES,
  SingleFlight,
  activationJournalPath,
  allowedActions,
  applyPendingVersion,
  assertRuntimeRootNoFollow,
  assertSafeVersion,
  atomicWriteRuntimeFileNoFollow,
  beginDelayedRollback,
  bindRuntimeInstallResolution,
  bootstrapCorruptMetadataRecoveryMarker,
  buildCachedVersionList,
  buildVersionList,
  canonicalRegistryOrigin,
  cleanupExplicitRuntimeVersion,
  cleanupSnapshotArtifacts,
  cleanupStaleInstalls,
  clearActivationJournal,
  clearCurrentPointer,
  clearRuntimeFailure,
  clearStorePruneRequest,
  compareRuntimeVersions,
  completeInterruptedRestore,
  createIntegrityVerifier,
  createPrivateDirectoryNoFollow,
  createRuntimeFileExclusiveNoFollow,
  currentPointerPath,
  decideVerdict,
  deleteOverride,
  detectRuntimeMetadataHealth,
  dirNonEmpty,
  disposeRuntimeInstaller,
  downloadVerifiedRegistryTarball,
  effectivePending,
  ensurePrivateDirectoryNoFollow,
  ensureRuntimeRootNoFollow,
  ensureRuntimeSubdirectoryNoFollow,
  evictVersions,
  fetchRegistryMetadata,
  fetchRegistryResponse,
  finalizeMetadataRecovery,
  findLatestSnapshotForVersion,
  forgetExplicitInstall,
  forgetKnownGood,
  inspectCorruptMetadataRecoveryMarker,
  installRuntimeVersion,
  invalidate,
  isAllowedRegistryUrl,
  isNoopSelection,
  isProtectedVersion,
  isRuntimeInstallerWriterSafetyError,
  isSafeVersion,
  isSupportedIntegrity,
  isTerminal,
  knownGoodCandidatesPath,
  latestKnownGood,
  listExplicitlyInstalledVersions,
  listKnownGoodVersions,
  listPreRollbackStashes,
  listRuntimeFailures,
  listSnapshotsForVersion,
  listValidVersionTrees,
  listVersionTrees,
  markKnownGood,
  markStorePruneNeeded,
  noteBoot,
  overridePath,
  planRestartExhaustedRollback,
  prepareManualRollbackData,
  probeKoffiLoadable,
  promoteDueCandidates,
  pruneRuntimeArtifacts,
  pruneRuntimeStore,
  pruneSnapshots,
  quarantineRuntimeFileNoFollow,
  queueActivationIntent,
  readActivationJournalState,
  readCurrentPointer,
  readCurrentPointerState,
  readMetadataRecoveryState,
  readOverride,
  readOverrideState,
  readPrivateFileNoFollow,
  readRuntimeFailure,
  readStorePruneRequest,
  recordExplicitInstall,
  recordMetadataRecoveryProbeFailure,
  recordProbePass,
  recordRuntimeFailure,
  recoverRuntimeMetadata,
  registryRedirectOrigins,
  removeKnownGoodCandidate,
  removeRuntimeFileNoFollow,
  replayDecision,
  rescueCorruptMetadataRecoveryMarker,
  resetCandidateHealthWindow,
  resolveSnapshotName,
  restoreMarkerAuthorityStatus,
  restorePreRollback,
  restoreSnapshot,
  resumeMetadataRecoveryCore,
  rollbackTarget,
  runDelayedRollback,
  runRuntimeActivationProbes,
  runStartupPhase,
  runtimeDiskSummary,
  runtimeFailureSummary,
  runtimeRootPath,
  runtimeSnapshotRetentionState,
  sanitizeErrorText,
  sanitizeInstallerOutput,
  scrubInstallEnv,
  shouldAutoRollback,
  shouldInvalidate,
  shouldProbeEnvWithDormantCorruptSelection,
  shouldPromote,
  shouldRetrySwap,
  snapshotDshHome,
  snapshotPaths,
  snapshotSummary,
  stashPreRollback,
  transition,
  transitionLifecycleProjection,
  validateVersionTree,
  verifyRuntimeTreeCriticalFiles,
  versionExists,
  writeActivationIntent,
  writeActivationJournal,
  writeCurrentPointer,
  writeOverride
};
