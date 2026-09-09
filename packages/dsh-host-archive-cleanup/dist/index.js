var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __knownSymbol = (name, symbol) => (symbol = Symbol[name]) ? symbol : Symbol.for("Symbol." + name);
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __decoratorStart = (base) => [, , , __create(base?.[__knownSymbol("metadata")] ?? null)];
var __decoratorStrings = ["class", "method", "getter", "setter", "accessor", "field", "value", "get", "set"];
var __expectFn = (fn) => fn !== void 0 && typeof fn !== "function" ? __typeError("Function expected") : fn;
var __decoratorContext = (kind, name, done, metadata, fns) => ({ kind: __decoratorStrings[kind], name, metadata, addInitializer: (fn) => done._ ? __typeError("Already initialized") : fns.push(__expectFn(fn || null)) });
var __decoratorMetadata = (array, target) => __defNormalProp(target, __knownSymbol("metadata"), array[3]);
var __runInitializers = (array, flags, self, value) => {
  for (var i = 0, fns = array[flags >> 1], n = fns && fns.length; i < n; i++) flags & 1 ? fns[i].call(self) : value = fns[i].call(self, value);
  return value;
};
var __decorateElement = (array, flags, name, decorators, target, extra) => {
  var fn, it, done, ctx, access, k = flags & 7, s = !!(flags & 8), p = !!(flags & 16);
  var j = k > 3 ? array.length + 1 : k ? s ? 1 : 2 : 0, key = __decoratorStrings[k + 5];
  var initializers = k > 3 && (array[j - 1] = []), extraInitializers = array[j] || (array[j] = []);
  var desc = k && (!p && !s && (target = target.prototype), k < 5 && (k > 3 || !p) && __getOwnPropDesc(k < 4 ? target : { get [name]() {
    return __privateGet(this, extra);
  }, set [name](x) {
    return __privateSet(this, extra, x);
  } }, name));
  k ? p && k < 4 && __name(extra, (k > 2 ? "set " : k > 1 ? "get " : "") + name) : __name(target, name);
  for (var i = decorators.length - 1; i >= 0; i--) {
    ctx = __decoratorContext(k, name, done = {}, array[3], extraInitializers);
    if (k) {
      ctx.static = s, ctx.private = p, access = ctx.access = { has: p ? (x) => __privateIn(target, x) : (x) => name in x };
      if (k ^ 3) access.get = p ? (x) => (k ^ 1 ? __privateGet : __privateMethod)(x, target, k ^ 4 ? extra : desc.get) : (x) => x[name];
      if (k > 2) access.set = p ? (x, y) => __privateSet(x, target, y, k ^ 4 ? extra : desc.set) : (x, y) => x[name] = y;
    }
    it = (0, decorators[i])(k ? k < 4 ? p ? extra : desc[key] : k > 4 ? void 0 : { get: desc.get, set: desc.set } : target, ctx), done._ = 1;
    if (k ^ 4 || it === void 0) __expectFn(it) && (k > 4 ? initializers.unshift(it) : k ? p ? extra = it : desc[key] = it : target = it);
    else if (typeof it !== "object" || it === null) __typeError("Object expected");
    else __expectFn(fn = it.get) && (desc.get = fn), __expectFn(fn = it.set) && (desc.set = fn), __expectFn(fn = it.init) && initializers.unshift(fn);
  }
  return k || __decoratorMetadata(array, target), desc && __defProp(target, name, desc), p ? k ^ 4 ? extra : desc : target;
};
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateIn = (member, obj) => Object(obj) !== obj ? __typeError('Cannot use the "in" operator on this value') : member.has(obj);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), setter ? setter.call(obj, value) : member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);

// src/index.ts
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// src/core.ts
var MAX_PURGE_SESSIONS = 65536;
var MAX_PURGE_ERROR_RECORDS = 1e3;
var ArchiveCleanupError = class extends Error {
  code;
  retryable;
  constructor(code, message, retryable = false) {
    super(message);
    this.name = "ArchiveCleanupError";
    this.code = code;
    this.retryable = retryable;
  }
};
async function domainResult(operation) {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (!(error instanceof ArchiveCleanupError)) throw error;
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...error.retryable === true ? { retryable: true } : {}
      }
    };
  }
}
function subtreeLiveness(sessionId, statesBySession, childrenOf, facts) {
  const visited = /* @__PURE__ */ new Set();
  const queue = [sessionId];
  let sawLoaded = false;
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    const state = statesBySession.get(current);
    if (facts.running.has(current) || state?.running === true) return "running";
    if (facts.loaded.has(current)) sawLoaded = true;
    for (const child of childrenOf.get(current) ?? []) queue.push(child);
  }
  return sawLoaded ? "loaded" : "clear";
}
function indexChildren(states) {
  const childrenOf = /* @__PURE__ */ new Map();
  for (const state of states) {
    if (state.origin !== "subagent") continue;
    if (state.parentSessionId === void 0) continue;
    const list = childrenOf.get(state.parentSessionId);
    if (list === void 0) childrenOf.set(state.parentSessionId, [state.sessionId]);
    else list.push(state.sessionId);
  }
  return childrenOf;
}
function resolveDeletableTree(rootSessionId, statesBySession, childrenOf, facts, force = false) {
  if (!statesBySession.has(rootSessionId)) return null;
  const liveness = subtreeLiveness(rootSessionId, statesBySession, childrenOf, facts);
  if (liveness === "running") return null;
  if (liveness === "loaded" && !force) return null;
  const order = [];
  const visited = /* @__PURE__ */ new Set();
  const stack = [
    { sessionId: rootSessionId, expanded: false }
  ];
  while (stack.length > 0) {
    const { sessionId, expanded } = stack.pop();
    if (expanded) {
      order.push(sessionId);
      continue;
    }
    if (visited.has(sessionId)) continue;
    visited.add(sessionId);
    stack.push({ sessionId, expanded: true });
    const children = childrenOf.get(sessionId) ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ sessionId: children[i], expanded: false });
    }
  }
  return {
    rootSessionId,
    order,
    subagentCount: order.length - 1
  };
}
var ArchiveCleanupCore = class {
  host;
  constructor(host) {
    this.host = host;
  }
  /** Step 1–3 read pass shared by preview and purge. */
  async readAuthoritativeState() {
    let archivedIds;
    let states;
    let live;
    try {
      ;
      [archivedIds, states, live] = await Promise.all([
        this.host.listArchivedSessionIds(),
        this.host.listSessionStates(),
        this.host.listLiveSessionFacts()
      ]);
    } catch (error) {
      if (error instanceof ArchiveCleanupError) throw error;
      throw new ArchiveCleanupError("registry-unreadable", `\u5F52\u6863\u72B6\u6001\u4E0D\u53EF\u8BFB\uFF1A${error instanceof Error ? error.message : String(error)}`);
    }
    const statesBySession = /* @__PURE__ */ new Map();
    for (const state of states) {
      const existing = statesBySession.get(state.sessionId);
      if (existing === void 0) statesBySession.set(state.sessionId, state);
    }
    const childrenOf = /* @__PURE__ */ new Map();
    for (const [parent, children] of indexChildren(states)) {
      childrenOf.set(parent, children);
    }
    return {
      archivedIds: [...new Set(archivedIds.map(String))],
      statesBySession,
      childrenOf,
      liveFacts: {
        running: new Set(live.running.map(String)),
        loaded: new Set(live.loaded.map(String))
      }
    };
  }
  /** Resolve the run plan: candidate roots not already covered by another
   *  deletable root's subtree, each mapped to its deletable tree (or skipped
   *  when running, or when loaded without `force`). Candidates are the full
   *  archived set (purge without a filter) or the requested subset ∩ archived
   *  set (filtered purge); a root that is itself a subagent descendant of an
   *  earlier deletable root is covered by that root's tree and skipped here
   *  (no double deletion). */
  resolvePlan(candidateIds, statesBySession, childrenOf, liveFacts, force) {
    const trees = [];
    let skippedRunning = 0;
    let skippedLoaded = 0;
    const orphanRoots = [];
    const covered = /* @__PURE__ */ new Set();
    for (const id of candidateIds) {
      if (covered.has(id)) continue;
      if (!statesBySession.has(id)) {
        orphanRoots.push(id);
        continue;
      }
      const tree = resolveDeletableTree(id, statesBySession, childrenOf, liveFacts, force);
      if (tree === null) {
        if (subtreeLiveness(id, statesBySession, childrenOf, liveFacts) === "running") skippedRunning += 1;
        else skippedLoaded += 1;
        continue;
      }
      for (const member of tree.order) covered.add(member);
      trees.push(tree);
    }
    return { trees, skippedRunning, skippedLoaded, orphanRoots };
  }
  /** Read-only preview (design 24 §3): a point-in-time snapshot for confirm
   *  copy — never authoritative for the purge itself. */
  async preview() {
    const { archivedIds, statesBySession, childrenOf, liveFacts } = await this.readAuthoritativeState();
    const plan = this.resolvePlan(archivedIds, statesBySession, childrenOf, liveFacts, false);
    let deletableSessions = 0;
    let deletableSubagents = 0;
    for (const tree of plan.trees) {
      deletableSessions += 1;
      deletableSubagents += tree.subagentCount;
    }
    return {
      archived: archivedIds.length,
      deletableSessions,
      deletableSubagents,
      skippedRunning: plan.skippedRunning,
      skippedLoaded: plan.skippedLoaded
    };
  }
  /**
   * Delete the content of every archived session (children-first, archived
   * member removed last — ONE batched set removal at the end).
   *
   * Optional `sessionIds` subset filter (2026-09 revision, design 24 wire
   * amendment): when provided, ONLY the listed archived-set members are
   * candidate roots (each with its own deletable subtree). The filter can
   * never extend the deletion set — candidates are ALWAYS the intersection
   * with the authoritative archived set read at run start — and a listed id
   * that already left the set (concurrent purge in another shell) is simply
   * no candidate: idempotent, never an error. `undefined` = the full set
   * (unchanged semantics); a provided EMPTY array = delete nothing.
   *
   * BUCKET SEMANTICS NOTE (review round 2026-09): counts are per TREE ROOT,
   * not per row origin — when the archived set itself contains a
   * subagent-origin row and it is selected WITHOUT any deletable ancestor
   * (reachable over the wire), it is its own tree root and counts in
   * `deletedSessions`; when the same row is covered by a selected ancestor's
   * completed tree it counts in `deletedSubagents`. The buckets can
   * therefore flip with candidate order for one selection — the UI never
   * selects hidden subagent rows, so presentation is unaffected.
   *
   * Performance contract (design 24 perf review): the authoritative snapshot
   * (archived set + session states + lineage) is read ONCE; per deletable
   * tree only the cheap in-memory live set is re-read and checked at the
   * TREE level (the real running guard — no per-member pre-check, review F2:
   * a mid-tree live flip surfaces through the binding's delete-time
   * `running` refusal). Per-member deletion uses the snapshot's cwd so the
   * binding never re-enumerates the corpus. Completed roots (and any
   * archived descendants their completed trees covered) plus orphans are
   * removed from the archived set in a single official write after the whole
   * run. Per-session failures land in `errors` (truncated at
   * MAX_PURGE_ERROR_RECORDS with `truncated`). The FIRST in-tree failure
   * aborts the REMAINING members of that tree (review F1): ancestors and the
   * root stay untouched and archived so a rerun re-enumerates and converges,
   * while members deleted before the failure stay deleted (prefix deletions
   * are not rolled back). Per-session isolation across INDEPENDENT trees is
   * unchanged: the run continues with the next tree.
   *
   * `force` (2026-09 revision, user motion "已归档的对话应该终止"): when true,
   * a subtree whose strongest liveness is merely `loaded` (idle agent /
   * attached session) is deleted too — the caller MUST have terminated the
   * run first (client-orchestrated `session/cancel` before purge). A RUNNING
   * member is still refused unconditionally (a live writer recreates a
   * header-less artifact through `open(path,"a")`, design 24 §21). Default
   * (absent) = the historical fail-closed behavior, byte-for-byte.
   */
  async purge(sessionIds, force = false) {
    if (sessionIds !== void 0) {
      if (!Array.isArray(sessionIds) || sessionIds.some((id) => typeof id !== "string" || id === "")) {
        throw new ArchiveCleanupError(
          "invalid-request",
          "archiveCleanup: purge subset filter must be an array of non-empty session id strings"
        );
      }
      if (sessionIds.length > MAX_PURGE_SESSIONS) {
        throw new ArchiveCleanupError(
          "invalid-request",
          `archiveCleanup: purge subset filter exceeds ${MAX_PURGE_SESSIONS} entries`
        );
      }
      if (sessionIds.length === 0) {
        return {
          deletedSessions: 0,
          deletedSubagents: 0,
          skippedRunning: 0,
          skippedLoaded: 0,
          forcedLoaded: 0,
          errors: []
        };
      }
    }
    const { archivedIds, statesBySession, childrenOf, liveFacts } = await this.readAuthoritativeState();
    let candidates;
    if (sessionIds === void 0) {
      if (archivedIds.length > MAX_PURGE_SESSIONS) {
        throw new ArchiveCleanupError("purge-capacity", `archived set exceeds the ${MAX_PURGE_SESSIONS}-session purge capacity`);
      }
      candidates = archivedIds;
    } else {
      const selected = new Set(sessionIds);
      candidates = archivedIds.filter((id) => selected.has(id));
    }
    const archivedAtStart = new Set(archivedIds);
    const plan = this.resolvePlan(candidates, statesBySession, childrenOf, liveFacts, force);
    let deletedSessions = 0;
    let deletedSubagents = 0;
    let forcedLoaded = 0;
    let truncated = false;
    const errors = [];
    const recordError = (sessionId, code, message) => {
      if (errors.length >= MAX_PURGE_ERROR_RECORDS) {
        truncated = true;
        return;
      }
      errors.push({ sessionId, code, message });
    };
    const completedRoots = [];
    const coveredArchivedMembers = [];
    for (const tree of plan.trees) {
      let nowFacts;
      try {
        const facts = await this.host.listLiveSessionFacts();
        nowFacts = { running: new Set(facts.running.map(String)), loaded: new Set(facts.loaded.map(String)) };
      } catch (error) {
        if (error instanceof ArchiveCleanupError) throw error;
        throw new ArchiveCleanupError("registry-unreadable", `live agent \u72B6\u6001\u4E0D\u53EF\u8BFB\uFF1A${error instanceof Error ? error.message : String(error)}`);
      }
      const liveness = subtreeLiveness(tree.rootSessionId, statesBySession, childrenOf, nowFacts);
      if (liveness === "running") {
        plan.skippedRunning += 1;
        continue;
      }
      if (liveness === "loaded" && !force) {
        plan.skippedLoaded += 1;
        continue;
      }
      let treeAborted = false;
      for (const sessionId of tree.order) {
        const state = statesBySession.get(sessionId);
        try {
          const outcome = await this.host.deleteSessionContent(sessionId, state?.cwd, force);
          if (sessionId === tree.rootSessionId) {
            if (outcome === "deleted") deletedSessions += 1;
          } else if (outcome === "deleted") {
            deletedSubagents += 1;
          }
          try {
            await this.host.emitSessionRemoved(sessionId);
          } catch (error) {
            if (!(error instanceof ArchiveCleanupError)) throw error;
            treeAborted = true;
            recordError(sessionId, error.code, error.message);
            break;
          }
        } catch (error) {
          if (!(error instanceof ArchiveCleanupError)) throw error;
          treeAborted = true;
          recordError(sessionId, error.code, error.message);
          break;
        }
      }
      if (treeAborted) {
        continue;
      }
      completedRoots.push(tree.rootSessionId);
      if (liveness === "loaded") forcedLoaded += 1;
      for (const member of tree.order) {
        if (member !== tree.rootSessionId && archivedAtStart.has(member)) {
          coveredArchivedMembers.push(member);
        }
      }
    }
    const clearIds = [.../* @__PURE__ */ new Set([...completedRoots, ...coveredArchivedMembers, ...plan.orphanRoots])];
    if (clearIds.length > 0) {
      try {
        await this.host.removeArchivedSessionIds(clearIds);
      } catch (error) {
        if (!(error instanceof ArchiveCleanupError)) throw error;
        recordError("", "archive-set", error.message);
      }
      try {
        await this.host.emitArchivedSessionsChanged();
      } catch (error) {
        if (!(error instanceof ArchiveCleanupError)) throw error;
        recordError("", "archive-set", error.message);
      }
    }
    return {
      deletedSessions,
      deletedSubagents,
      skippedRunning: plan.skippedRunning,
      skippedLoaded: plan.skippedLoaded,
      forcedLoaded,
      errors,
      ...truncated ? { truncated: true } : {}
    };
  }
};

// src/binding.ts
import { rm, rmdir, lstat } from "node:fs/promises";
import { basename, dirname } from "node:path";
var BUSY_MESSAGE = "archiveCleanup is already running on this instance \u2014 retry after it settles";
function assertHeaderShape(header) {
  if (header === null || typeof header !== "object") {
    throw new ArchiveCleanupError(
      "registry-unreadable",
      "archiveCleanup: a session header is not an object \u2014 refusing the read (pinned-vendor header drift)"
    );
  }
  const h = header;
  const who = typeof h.id === "string" && h.id !== "" ? `session ${h.id}` : "an unnamed session header";
  const malformed = (field, expected) => {
    throw new ArchiveCleanupError(
      "registry-unreadable",
      `archiveCleanup: ${who}: header.${field} must be ${expected} \u2014 refusing the read (pinned-vendor header drift would silently empty the cleanup cascade)`
    );
  };
  if (typeof h.id !== "string") malformed("id", "a string");
  if (h.cwd !== void 0 && typeof h.cwd !== "string") malformed("cwd", "a string when present");
  if (h.parentSession !== void 0 && typeof h.parentSession !== "string") {
    malformed("parentSession", "a string when present");
  }
  if (h.origin !== void 0 && h.origin !== "subagent") malformed("origin", "exactly 'subagent' when present");
}
function headerToState(header) {
  assertHeaderShape(header);
  return {
    sessionId: header.id,
    ...header.origin === "subagent" ? { origin: "subagent" } : {},
    ...typeof header.parentSession === "string" && header.parentSession !== "" ? { parentSessionId: header.parentSession } : {},
    ...typeof header.cwd === "string" ? { cwd: header.cwd } : {},
    running: false
  };
}
function assertHostSurface(ctx) {
  const registry = ctx.workspaceRegistry;
  if (registry === void 0 || typeof registry.setState !== "function" || !Array.isArray(registry.archivedSessionIds) || typeof registry.list !== "function") {
    throw new ArchiveCleanupError(
      "registry-unreadable",
      "archiveCleanup: the workspaceRegistry service is not mounted with the expected surface"
    );
  }
  const query = ctx.sessionQuery;
  const persistence = ctx.sessionPersistence;
  const canEnumerate = query !== void 0 && typeof query.listSessions === "function" || persistence !== void 0 && typeof persistence.list === "function";
  if (!canEnumerate || persistence === void 0 || typeof persistence.locate !== "function") {
    throw new ArchiveCleanupError(
      "registry-unreadable",
      "archiveCleanup: the session enumeration/storage surface is not mounted with the expected shape"
    );
  }
}
function liveSessionFacts(ctx) {
  const running = /* @__PURE__ */ new Set();
  const loaded = /* @__PURE__ */ new Set();
  for (const agent of ctx.agents?.list?.() ?? []) {
    if (agent === null || typeof agent !== "object" || typeof agent.id !== "string") {
      throw new ArchiveCleanupError(
        "registry-unreadable",
        "archiveCleanup: an agent entry has no string id \u2014 refusing the read (pinned-vendor drift)"
      );
    }
    const id = String(agent.id);
    const status = agent.status;
    if (status !== "idle" && status !== "running") {
      throw new ArchiveCleanupError(
        "registry-unreadable",
        `archiveCleanup: agent ${id} reports an unknown status ${JSON.stringify(status)} \u2014 refusing the read (a drifted status would silently reclassify a running agent as idle)`
      );
    }
    loaded.add(id);
    if (status === "running") running.add(id);
  }
  for (const session of ctx.sessions?.list?.() ?? []) {
    if (session !== null && typeof session === "object" && typeof session.id === "string") {
      loaded.add(String(session.id));
    }
  }
  return { running, loaded };
}
function makeHostBinding(ctx) {
  const registry = ctx.workspaceRegistry;
  const query = ctx.sessionQuery;
  const persistence = ctx.sessionPersistence;
  const requireRegistry = () => {
    if (registry === void 0 || typeof registry.setState !== "function" || !Array.isArray(registry.archivedSessionIds) || typeof registry.list !== "function") {
      throw new ArchiveCleanupError(
        "registry-unreadable",
        "archiveCleanup: the workspaceRegistry service is not mounted with the expected surface"
      );
    }
    return registry;
  };
  const listHeaders = async () => {
    if (query?.listSessions !== void 0) {
      const records = await query.listSessions();
      if (Array.isArray(records)) {
        for (const record of records) assertHeaderShape(record?.header);
        return records.map((record) => record.header);
      }
    }
    if (persistence?.list !== void 0) {
      const headers = await persistence.list();
      if (Array.isArray(headers)) {
        for (const header of headers) assertHeaderShape(header);
        return headers;
      }
    }
    throw new ArchiveCleanupError(
      "registry-unreadable",
      "archiveCleanup: no session enumeration service (sessionQuery/sessionPersistence) is mounted"
    );
  };
  return {
    async listArchivedSessionIds() {
      const reg = requireRegistry();
      return [...reg.archivedSessionIds];
    },
    async listSessionStates() {
      const headers = await listHeaders();
      const byId = /* @__PURE__ */ new Map();
      for (const header of headers) {
        byId.set(header.id, headerToState(header));
      }
      return [...byId.values()];
    },
    async listLiveSessionFacts() {
      const facts = liveSessionFacts(ctx);
      return { running: [...facts.running], loaded: [...facts.loaded] };
    },
    async deleteSessionContent(sessionId, cwd, force = false) {
      try {
        const facts = liveSessionFacts(ctx);
        if (facts.running.has(sessionId)) {
          throw new ArchiveCleanupError("running", `archiveCleanup: ${sessionId} is running`);
        }
        if (!force && facts.loaded.has(sessionId)) {
          throw new ArchiveCleanupError(
            "loaded",
            `archiveCleanup: ${sessionId} is loaded in this process \u2014 delete it with force after stopping it, or restart dsh`
          );
        }
        if (persistence === void 0 || typeof persistence.locate !== "function") {
          throw new ArchiveCleanupError(
            "storage",
            `archiveCleanup: sessionPersistence.locate is not mounted \u2014 cannot resolve content of ${sessionId}`
          );
        }
        let header;
        if (typeof cwd === "string") {
          header = { id: sessionId, cwd };
          assertHeaderShape(header);
        } else {
          const headers = await listHeaders();
          header = headers.find((candidate) => candidate.id === sessionId);
        }
        if (header === void 0) return "missing";
        const location = persistence.locate(header);
        const artifactPath = location?.path;
        if (typeof artifactPath !== "string" || artifactPath === "") {
          return "missing";
        }
        const dir = dirname(artifactPath);
        const dirStat = await lstat(dir).catch((error) => {
          if (error.code === "ENOENT") return void 0;
          throw error;
        });
        if (dirStat === void 0) return "missing";
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
          throw new ArchiveCleanupError("storage", `archiveCleanup: refusing a non-directory/symlinked session path for ${sessionId}`);
        }
        const artifactStat = await lstat(artifactPath).catch(() => void 0);
        if (artifactStat === void 0) return "missing";
        if (artifactStat.isSymbolicLink() || artifactStat.isDirectory()) {
          throw new ArchiveCleanupError("storage", `archiveCleanup: refusing a symlinked/non-file artifact for ${sessionId}`);
        }
        try {
          await rm(artifactPath, { force: false });
        } catch (error) {
          if (error.code === "ENOENT") return "missing";
          throw error;
        }
        if (basename(dir) !== "" && basename(dir) !== "." && basename(dir) !== "..") {
          try {
            await rmdir(dir);
          } catch {
          }
        }
        return "deleted";
      } catch (error) {
        if (error instanceof ArchiveCleanupError) throw error;
        throw new ArchiveCleanupError(
          "storage",
          `archiveCleanup: ${sessionId} content removal failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    async removeArchivedSessionIds(ids) {
      const reg = requireRegistry();
      const mutate = async () => {
        const current = [...reg.archivedSessionIds];
        const wanted = new Set(ids);
        const next = current.filter((id) => !wanted.has(id));
        if (next.length === current.length) return;
        const workspaceIds = reg.list().map((workspace) => String(workspace.id));
        await reg.setState({ initialized: true, workspaceIds, archivedSessionIds: next });
      };
      try {
        if (typeof reg.enqueueOperation !== "function") {
          throw new ArchiveCleanupError(
            "registry-unreadable",
            "archiveCleanup: the workspaceRegistry mutation chain is not mounted \u2014 refusing an out-of-chain archived-set write"
          );
        }
        await reg.enqueueOperation(mutate);
      } catch (error) {
        if (error instanceof ArchiveCleanupError) throw error;
        throw new ArchiveCleanupError(
          "storage",
          `archiveCleanup: archived-set removal failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    async emitSessionRemoved() {
    },
    async emitArchivedSessionsChanged() {
    }
  };
}
var RunGate = class {
  inFlight = false;
  async run(operation) {
    if (this.inFlight) throw new ArchiveCleanupError("busy", BUSY_MESSAGE, true);
    this.inFlight = true;
    try {
      return await operation();
    } finally {
      this.inFlight = false;
    }
  }
};

// src/index.ts
var _probe_dec, _purge_dec, _preview_dec, _a, _init;
var ArchiveCleanupGateway = class extends (_a = TypertRemoteService, _preview_dec = [Remote("preview")], _purge_dec = [Remote("purge")], _probe_dec = [Remote("probe")], _a) {
  constructor(ctx) {
    super(ctx, "archiveCleanup");
    __runInitializers(_init, 5, this);
    __publicField(this, "core");
    __publicField(this, "gate", new RunGate());
    __publicField(this, "logger");
    __publicField(this, "hostCtx");
    this.hostCtx = ctx;
    this.core = new ArchiveCleanupCore(makeHostBinding(this.hostCtx));
    const maybeLogger = ctx.logger;
    this.logger = maybeLogger;
  }
  preview() {
    return domainResult(() => this.gate.run(async () => {
      const value = await this.core.preview();
      this.logger?.info?.("[archiveCleanup] preview answered", {
        archived: value.archived,
        deletable: value.deletableSessions,
        skippedRunning: value.skippedRunning,
        skippedLoaded: value.skippedLoaded
      });
      return value;
    }));
  }
  purge(sessionIds, force) {
    return domainResult(() => this.gate.run(async () => {
      this.logger?.info?.("[archiveCleanup] purge started", {
        ...sessionIds === void 0 ? {} : { filterCount: sessionIds.length },
        ...force === true ? { force: true } : {}
      });
      const value = await this.core.purge(sessionIds, force === true);
      this.logger?.info?.("[archiveCleanup] purge finished", {
        deletedSessions: value.deletedSessions,
        deletedSubagents: value.deletedSubagents,
        skippedRunning: value.skippedRunning,
        skippedLoaded: value.skippedLoaded,
        forcedLoaded: value.forcedLoaded,
        errorCount: value.errors.length
      });
      return value;
    }));
  }
  probe() {
    try {
      assertHostSurface(this.hostCtx);
      return Promise.resolve({ ok: true, value: {} });
    } catch (error) {
      if (error instanceof ArchiveCleanupError) {
        return Promise.resolve({
          ok: false,
          error: { code: error.code, message: error.message, ...error.retryable === true ? { retryable: true } : {} }
        });
      }
      throw error;
    }
  }
};
_init = __decoratorStart(_a);
__decorateElement(_init, 1, "preview", _preview_dec, ArchiveCleanupGateway);
__decorateElement(_init, 1, "purge", _purge_dec, ArchiveCleanupGateway);
__decorateElement(_init, 1, "probe", _probe_dec, ArchiveCleanupGateway);
__decoratorMetadata(_init, ArchiveCleanupGateway);
__publicField(ArchiveCleanupGateway, "inject", ["workspaceRegistry", "agents", "sessions", "sessionQuery", "sessionPersistence"]);
var index_default = ArchiveCleanupGateway;
export {
  ArchiveCleanupCore,
  ArchiveCleanupError,
  ArchiveCleanupGateway,
  BUSY_MESSAGE,
  MAX_PURGE_ERROR_RECORDS,
  MAX_PURGE_SESSIONS,
  RunGate,
  assertHostSurface,
  index_default as default,
  domainResult,
  indexChildren,
  makeHostBinding,
  resolveDeletableTree,
  subtreeLiveness
};
