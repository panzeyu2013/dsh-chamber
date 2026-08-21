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
  var fn, it, done, ctx, access2, k = flags & 7, s = !!(flags & 8), p = !!(flags & 16);
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
      ctx.static = s, ctx.private = p, access2 = ctx.access = { has: p ? (x) => __privateIn(target, x) : (x) => name in x };
      if (k ^ 3) access2.get = p ? (x) => (k ^ 1 ? __privateGet : __privateMethod)(x, target, k ^ 4 ? extra : desc.get) : (x) => x[name];
      if (k > 2) access2.set = p ? (x, y) => __privateSet(x, target, y, k ^ 4 ? extra : desc.set) : (x, y) => x[name] = y;
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
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
var READ_TIMEOUT_MS = 1e4;
var MUTATION_TIMEOUT_MS = 3e4;
var READ_OUTPUT_CAP = 1024 * 1024;
var MUTATION_OUTPUT_CAP = 256 * 1024;
var PREVIEW_TTL_MS = 5 * 6e4;
var OPERATION_TTL_MS = 24 * 60 * 6e4;
var SNAPSHOT_DEADLINE_MS = 2e4;
var DISCOVERY_TTL_MS = 3e4;
var SNAPSHOT_WALL_TIMEOUT_MS = 25e3;
var MAX_WORKSPACES = 128;
var MAX_REPOSITORIES = 64;
var MAX_WORKTREES_PER_REPOSITORY = 128;
var MAX_TOTAL_WORKTREES = 256;
var MAX_AGENTS = 4096;
var MAX_SESSIONS_PER_WORKSPACE = 4096;
var MAX_TOTAL_SESSION_MEMBERSHIPS = 16384;
var SNAPSHOT_STATUS_TIMEOUT_MS = 1500;
var MAX_PATH_LENGTH = 4096;
var MAX_PREVIEWS = 512;
var MAX_OPERATIONS = 2048;
var GitWorktreeError = class extends Error {
  code;
  retryable;
  details;
  constructor(code, message, options = {}) {
    super(message);
    this.name = "GitWorktreeError";
    this.code = code;
    this.retryable = options.retryable;
    this.details = options.details;
  }
};
var RETRYABLE_CODES = /* @__PURE__ */ new Set([
  "git-timeout",
  "git-output-limit",
  "git-spawn-failed",
  "git-command-failed",
  "git-protocol-error",
  "path-unavailable",
  "path-check-failed",
  "postcondition-failed",
  "operation-busy",
  "state-source-unavailable",
  "state-source-invalid",
  "state-source-capacity",
  "snapshot-deadline",
  "workspace-path-unavailable",
  "running-agent-cwd-unavailable"
]);
async function domainResult(operation) {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (!(error instanceof GitWorktreeError)) throw error;
    const retryable = error.retryable ?? RETRYABLE_CODES.has(error.code);
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...retryable ? { retryable: true } : {},
        ...error.details === void 0 ? {} : { details: error.details }
      }
    };
  }
}
var nodeFileSystem = {
  realpath,
  lstat,
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  // Bounded read: a hostile or corrupt `.git` pointer file must never be read
  // whole into memory (gitdir lines are tiny; nothing beyond the prefix is
  // used by worktreeGitDir's parse).
  readFile: async (path) => {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(GIT_DIR_POINTER_MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, GIT_DIR_POINTER_MAX_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }
};
function fail(code, message) {
  throw new GitWorktreeError(code, message);
}
function safeErrorMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[\r\n\t]+/g, " ").slice(0, 512);
}
function assertRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalid-input", `${label} must be an object`);
  }
}
function assertExactKeys(value, keys, label) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("invalid-input", `${label} contains unsupported field '${key}'`);
  }
  for (const key of keys) {
    if (!(key in value)) fail("invalid-input", `${label}.${key} is required`);
  }
}
function requiredString(value, label, max = 1024) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("invalid-input", `${label} must be a non-empty bounded string without control characters`);
  }
  return value;
}
function operationId(value) {
  const id = requiredString(value, "operationId", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) {
    fail("invalid-input", "operationId contains unsupported characters");
  }
  return id;
}
function previewToken(value) {
  const token = requiredString(value, "previewToken", 128);
  if (!/^[A-Za-z0-9-]+$/u.test(token)) fail("invalid-input", "previewToken is malformed");
  return token;
}
function safeBasename(value) {
  const name = requiredString(value, "basename", 255);
  if (name !== name.trim() || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    fail("unsafe-path", "basename must be one trimmed path segment");
  }
  if (Buffer.byteLength(name, "utf8") > 255) fail("unsafe-path", "basename is too long");
  return name;
}
function safeBranchName(value, label = "branch.name") {
  const name = requiredString(value, label, 1024);
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.includes("\\")) {
    fail("invalid-branch", `${label} is not a safe local branch name`);
  }
  return name;
}
function absoluteExpectedPath(value, label) {
  const path = requiredString(value, label, 4096);
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail("unsafe-path", `${label} must be a normalized absolute path`);
  }
  return path;
}
function objectFingerprint(value) {
  return JSON.stringify(value);
}
function opaqueId(kind, ...parts) {
  const digest = createHash("sha256");
  digest.update(kind);
  for (const part of parts) {
    digest.update("\0");
    digest.update(part);
  }
  return `${kind}_${digest.digest("hex")}`;
}
function expectedOpaqueId(value, kind) {
  const id = requiredString(value, `input.expected.${kind}Id`, 80);
  if (!new RegExp(`^${kind}_[0-9a-f]{64}$`, "u").test(id)) {
    fail("invalid-input", `input.expected.${kind}Id is malformed`);
  }
  return id;
}
function parsePreviewInput(value) {
  assertRecord(value, "input");
  {
    const allowed = /* @__PURE__ */ new Set(["sourceWorkspaceId", "basename", "branch", "startRef"]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) fail("invalid-input", `input contains unsupported field '${key}'`);
    }
    for (const key of ["sourceWorkspaceId", "basename", "branch"]) {
      if (!(key in value)) fail("invalid-input", `input.${key} is required`);
    }
  }
  const sourceWorkspaceId = requiredString(value.sourceWorkspaceId, "sourceWorkspaceId", 256);
  const basename2 = safeBasename(value.basename);
  assertRecord(value.branch, "input.branch");
  assertExactKeys(value.branch, ["kind", "name"], "input.branch");
  if (value.branch.kind !== "existing" && value.branch.kind !== "new") {
    fail("invalid-input", "input.branch.kind must be 'existing' or 'new'");
  }
  const name = safeBranchName(value.branch.name);
  return {
    sourceWorkspaceId,
    basename: basename2,
    branch: { kind: value.branch.kind, name },
    // Same validation as the branch name: a control character or leading
    // dash must never reach the localBranchHead argv (the allowlist would
    // reject a leading dash, but input-layer validation is fail-closed).
    ...value.startRef === void 0 ? {} : { startRef: safeBranchName(value.startRef, "input.startRef") }
  };
}
function parseCreateInput(value) {
  assertRecord(value, "input");
  assertExactKeys(value, ["previewToken", "operationId"], "input");
  return { previewToken: previewToken(value.previewToken), operationId: operationId(value.operationId) };
}
function parseRollbackInput(value) {
  assertRecord(value, "input");
  assertExactKeys(value, ["operationId"], "input");
  return { operationId: operationId(value.operationId) };
}
function parseRemoveInput(value) {
  assertRecord(value, "input");
  {
    const allowed = /* @__PURE__ */ new Set(["operationId", "workspaceId", "path", "expected", "deleteBranch"]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) fail("invalid-input", `input contains unsupported field '${key}'`);
    }
    for (const key of ["operationId", "expected"]) {
      if (!(key in value)) fail("invalid-input", `input.${key} is required`);
    }
  }
  assertRecord(value.expected, "input.expected");
  assertExactKeys(value.expected, ["repoId", "worktreeId", "branch", "head"], "input.expected");
  const head = requiredString(value.expected.head, "input.expected.head", 128);
  if (!/^[0-9a-fA-F]{40,64}$/u.test(head)) fail("invalid-input", "input.expected.head is not an object id");
  return {
    operationId: operationId(value.operationId),
    workspaceId: value.workspaceId === void 0 ? void 0 : requiredString(value.workspaceId, "workspaceId", 256),
    expected: {
      repoId: expectedOpaqueId(value.expected.repoId, "repo"),
      worktreeId: expectedOpaqueId(value.expected.worktreeId, "worktree"),
      branch: value.expected.branch === null ? null : safeBranchName(value.expected.branch, "input.expected.branch"),
      head: head.toLowerCase()
    },
    deleteBranch: value.deleteBranch === void 0 ? void 0 : safeBranchName(value.deleteBranch, "input.deleteBranch"),
    path: value.path === void 0 ? void 0 : value.workspaceId !== void 0 ? fail("invalid-input", "input.path and input.workspaceId are mutually exclusive") : absoluteExpectedPath(value.path, "input.path")
  };
}
function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sameMembership(left, right) {
  if (left.length !== right.length) return false;
  return sameArray([...left].sort(), [...right].sort());
}
function assertSafeGitArgv(args) {
  const [verb, ...rest] = args;
  const allStrings = args.every((arg) => typeof arg === "string" && !arg.includes("\0"));
  if (!allStrings) fail("unsafe-git-argv", "Git argv contains a non-string or NUL");
  const exact = (...expected) => sameArray(rest, expected);
  if (verb === "rev-parse" && (exact("--show-toplevel") || exact("--path-format=absolute", "--git-common-dir"))) return;
  if (verb === "check-ref-format" && rest.length === 2 && rest[0] === "--branch" && !rest[1].startsWith("-")) return;
  if (verb === "show-ref" && rest.length === 3 && rest[0] === "--hash" && rest[1] === "--verify" && rest[2].startsWith("refs/heads/") && !rest[2].slice("refs/heads/".length).startsWith("-")) return;
  if (verb === "show-ref" && exact("--heads")) return;
  if (verb === "branch" && rest.length === 2 && rest[0] === "-D" && !rest[1].startsWith("-") && !rest[1].startsWith("/")) return;
  if (verb === "status" && exact("--porcelain=v1", "-z", "--untracked-files=normal")) return;
  if (verb === "status" && exact("--porcelain=v1", "-z", "--branch", "--untracked-files=normal")) return;
  if (verb === "worktree" && exact("list", "--porcelain", "-z")) return;
  if (verb === "worktree" && rest.length === 4 && rest[0] === "add" && rest[1] === "--" && isAbsolute(rest[2]) && !rest[3].startsWith("-")) return;
  if (verb === "worktree" && rest.length === 6 && rest[0] === "add" && rest[1] === "-b" && !rest[2].startsWith("-") && rest[3] === "--" && isAbsolute(rest[4]) && /^[0-9a-fA-F]{40,64}$/u.test(rest[5])) return;
  if (verb === "worktree" && rest.length === 3 && rest[0] === "remove" && rest[1] === "--" && isAbsolute(rest[2])) return;
  fail("unsafe-git-argv", `Git command '${verb ?? "<empty>"}' is outside the worktree allowlist`);
}
function createLocalGitRunner(spawnGit = spawn) {
  return (request) => new Promise((resolvePromise, rejectPromise) => {
    try {
      if (!isAbsolute(request.cwd)) fail("unsafe-git-cwd", "Git cwd must be absolute");
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 6e4) {
        fail("unsafe-git-limit", "Git timeout is outside the supported range");
      }
      if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > 4 * 1024 * 1024) {
        fail("unsafe-git-limit", "Git output cap is outside the supported range");
      }
      assertSafeGitArgv(request.args);
    } catch (error) {
      rejectPromise(error);
      return;
    }
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("GIT_")) delete environment[key];
    }
    Object.assign(environment, {
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
      // `worktree add` normally runs post-checkout. A wire lifecycle action
      // must not become a caller-triggered hook execution surface. This does
      // not disable repository-configured clean/smudge/process filters: those
      // remain inside the host OS user's trusted repository-config boundary.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: process.platform === "win32" ? "NUL" : "/dev/null",
      GCM_INTERACTIVE: "never",
      LC_ALL: "C"
    });
    let child;
    try {
      child = spawnGit("git", [...request.args], {
        cwd: request.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: environment
      });
    } catch (error) {
      rejectPromise(new GitWorktreeError("git-spawn-failed", safeErrorMessage(error)));
      return;
    }
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    let terminationError;
    let timer;
    const rejectImmediately = (error) => {
      if (settled) return;
      settled = true;
      if (timer !== void 0) clearTimeout(timer);
      rejectPromise(error);
    };
    const terminateThenReject = (error) => {
      if (settled || terminationError !== void 0) return;
      terminationError = error;
      if (timer !== void 0) clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
      }
    };
    const append = (target, chunk) => {
      if (settled || terminationError !== void 0) return;
      bytes += chunk.byteLength;
      if (bytes > request.maxOutputBytes) {
        terminateThenReject(new GitWorktreeError("git-output-limit", "Git output exceeded the bounded response limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.on("error", (error) => {
      if (terminationError !== void 0) return;
      rejectImmediately(new GitWorktreeError("git-spawn-failed", safeErrorMessage(error)));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer !== void 0) clearTimeout(timer);
      if (terminationError !== void 0) {
        rejectPromise(terminationError);
        return;
      }
      resolvePromise({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
    timer = setTimeout(() => {
      terminateThenReject(new GitWorktreeError("git-timeout", `Git command exceeded ${request.timeoutMs}ms`));
    }, request.timeoutMs);
    timer.unref();
  });
}
var KeyedMutex = class {
  tails = /* @__PURE__ */ new Map();
  async run(key, operation) {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
};
function parseBranchLine(line) {
  if (!line.startsWith("## ")) return { upstream: null, ahead: 0, behind: 0 };
  const rest = line.slice(3);
  let ahead = 0;
  let behind = 0;
  const bracket = rest.lastIndexOf(" [");
  const namePart = bracket >= 0 ? rest.slice(0, bracket) : rest;
  if (bracket >= 0) {
    const meta = rest.slice(bracket + 2, rest.length - 1);
    const aheadMatch = /ahead (\d+)/u.exec(meta);
    const behindMatch = /behind (\d+)/u.exec(meta);
    if (aheadMatch !== null) ahead = Number(aheadMatch[1]);
    if (behindMatch !== null) behind = Number(behindMatch[1]);
  }
  const sep2 = namePart.indexOf("...");
  return {
    upstream: sep2 >= 0 ? namePart.slice(sep2 + 3) || null : null,
    ahead,
    behind
  };
}
function parseWorktreePorcelain(output) {
  const records = [];
  let current;
  const flush = () => {
    if (current === void 0) return;
    if (current.path.length === 0 || current.path.length > MAX_PATH_LENGTH || /[\0\r\n]/u.test(current.path) || !isAbsolute(current.path)) {
      fail("git-protocol-error", "Git returned an invalid or overlong worktree path");
    }
    if (!/^[0-9a-fA-F]{40,64}$/u.test(current.head)) fail("git-protocol-error", "Git returned an invalid worktree HEAD");
    current.head = current.head.toLowerCase();
    records.push(current);
    current = void 0;
  };
  for (const field of output.split("\0")) {
    if (field === "") {
      flush();
      continue;
    }
    if (field.startsWith("worktree ")) {
      flush();
      current = {
        path: field.slice("worktree ".length),
        head: "",
        branch: null,
        locked: false,
        prunable: false,
        bare: false
      };
      continue;
    }
    if (current === void 0) fail("git-protocol-error", "Git worktree output did not begin with a worktree field");
    if (field.startsWith("HEAD ")) current.head = field.slice("HEAD ".length);
    else if (field.startsWith("branch refs/heads/")) current.branch = field.slice("branch refs/heads/".length);
    else if (field === "locked" || field.startsWith("locked ")) current.locked = true;
    else if (field === "prunable" || field.startsWith("prunable ")) current.prunable = true;
    else if (field === "bare") current.bare = true;
    else if (field === "detached") current.branch = null;
  }
  flush();
  if (records.length === 0) fail("git-protocol-error", "Git returned no worktrees");
  return records;
}
var ZERO_HEAD = /^0+$/u;
var GIT_DIR_POINTER_MAX_BYTES = 4096;
var ATTENTION_PROBES = [
  { name: "MERGE_HEAD", reason: "merge" },
  { name: "REBASE_HEAD", reason: "rebase" },
  { name: "rebase-merge", reason: "rebase" },
  { name: "rebase-apply", reason: "rebase" },
  { name: "CHERRY_PICK_HEAD", reason: "cherry-pick" },
  { name: "REVERT_HEAD", reason: "revert" },
  { name: "BISECT_LOG", reason: "bisect" }
];
function isNotARepositoryError(error) {
  return error instanceof GitWorktreeError && /not a git repository/i.test(error.message);
}
async function worktreeGitDir(path, fs) {
  const dotGit = join(path, ".git");
  try {
    const stat = await fs.lstat(dotGit);
    if (stat.isDirectory()) return dotGit;
  } catch {
  }
  try {
    const pointer = (await fs.readFile(dotGit)).slice(0, GIT_DIR_POINTER_MAX_BYTES);
    const match = /^gitdir:\s*(.+)$/u.exec(pointer.trim());
    if (match === null) return null;
    const target = match[1].trim();
    return isAbsolute(target) ? target : resolve(path, target);
  } catch {
    return null;
  }
}
async function detectAttention(gitDir, fs, withinBudget) {
  const found = [];
  for (const probe of ATTENTION_PROBES) {
    if (!withinBudget()) break;
    if (await fs.exists(join(gitDir, probe.name))) found.push(probe.reason);
  }
  return [...new Set(found)];
}
var GitWorktreeCore = class {
  source;
  git;
  fs;
  now;
  nextToken;
  operationCapacity;
  snapshotWallTimeoutMs;
  worktreesRoot;
  mutex = new KeyedMutex();
  previews = /* @__PURE__ */ new Map();
  createOperations = /* @__PURE__ */ new Map();
  removeOperations = /* @__PURE__ */ new Map();
  workspaceDiscoverCache = /* @__PURE__ */ new Map();
  repoTopologyCache = /* @__PURE__ */ new Map();
  lastWorkspaceSignature = "";
  snapshotInFlight;
  constructor(options) {
    this.source = options.source;
    this.git = options.git ?? createLocalGitRunner();
    this.fs = options.fs ?? nodeFileSystem;
    this.now = options.now ?? Date.now;
    this.nextToken = options.token ?? randomUUID;
    this.operationCapacity = options.operationCapacity ?? MAX_OPERATIONS;
    if (!Number.isSafeInteger(this.operationCapacity) || this.operationCapacity < 1 || this.operationCapacity > MAX_OPERATIONS) {
      fail("invalid-core-option", `operationCapacity must be between 1 and ${MAX_OPERATIONS}`);
    }
    this.snapshotWallTimeoutMs = options.snapshotWallTimeoutMs ?? SNAPSHOT_WALL_TIMEOUT_MS;
    const worktreesRoot = options.worktreesRoot ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "worktrees");
    if (!isAbsolute(worktreesRoot)) {
      fail("invalid-config", "worktreesRoot must be an absolute path");
    }
    this.worktreesRoot = worktreesRoot;
    if (!Number.isSafeInteger(this.snapshotWallTimeoutMs) || this.snapshotWallTimeoutMs < 1 || this.snapshotWallTimeoutMs > SNAPSHOT_WALL_TIMEOUT_MS) {
      fail("invalid-core-option", `snapshotWallTimeoutMs must be between 1 and ${SNAPSHOT_WALL_TIMEOUT_MS}`);
    }
  }
  /** Coalesce overlapping polls so a slow old snapshot cannot pile up behind the next tick. */
  snapshot() {
    if (this.snapshotInFlight !== void 0) return this.snapshotInFlight;
    const scan = this.collectSnapshot();
    let timer;
    const responseDeadline = new Promise((resolvePromise) => {
      timer = setTimeout(() => resolvePromise({
        repos: [],
        errors: [],
        sourceError: {
          code: "snapshot-deadline",
          message: `snapshot did not settle within ${this.snapshotWallTimeoutMs}ms; the old scan remains single-flight`
        }
      }), this.snapshotWallTimeoutMs);
    });
    const response = Promise.race([scan, responseDeadline]);
    this.snapshotInFlight = response;
    const clear = () => {
      clearTimeout(timer);
      if (this.snapshotInFlight === response) this.snapshotInFlight = void 0;
    };
    void scan.then(clear, clear);
    return response;
  }
  /** Best-effort per-repository projection. State-source failure is not an empty snapshot. */
  async collectSnapshot() {
    const deadline = this.now() + SNAPSHOT_DEADLINE_MS;
    let state;
    try {
      state = await this.readSource();
    } catch (error) {
      const code = error instanceof GitWorktreeError && error.code === "state-source-capacity" ? "state-source-capacity" : "state-source-unavailable";
      return {
        repos: [],
        errors: [],
        sourceError: { code, message: safeErrorMessage(error) }
      };
    }
    const errors = [];
    let sourceError;
    const signature = state.workspaces.map((workspace) => `${workspace.workspaceId}:${workspace.path}`).sort().join("|");
    if (signature !== this.lastWorkspaceSignature) {
      this.clearDiscoveryCaches();
      this.lastWorkspaceSignature = signature;
    }
    const canonicalWorkspaces = [];
    for (const workspace of state.workspaces) {
      if (this.now() >= deadline) {
        sourceError = {
          code: "snapshot-deadline",
          message: `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms probe budget during workspace association`
        };
        break;
      }
      try {
        canonicalWorkspaces.push({ ...workspace, canonicalPath: await this.existingPath(workspace.path) });
      } catch (error) {
        errors.push({
          code: error instanceof GitWorktreeError ? error.code : "workspace-path-failed",
          operation: "discover",
          message: safeErrorMessage(error),
          path: workspace.path,
          workspaceId: workspace.workspaceId
        });
      }
    }
    const runningLocationsResult = await this.snapshotRunningLocations(state, deadline, errors);
    const runningLocations = runningLocationsResult.locations;
    if (runningLocationsResult.deadlineExceeded) {
      sourceError ??= {
        code: "snapshot-deadline",
        message: `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms probe budget during agent association`
      };
    }
    const groups = /* @__PURE__ */ new Map();
    let gitSpawnFailures = 0;
    for (const workspace of canonicalWorkspaces) {
      try {
        let discovered;
        const cachedDiscover = this.workspaceDiscoverCache.get(workspace.canonicalPath);
        if (cachedDiscover !== void 0 && this.now() - cachedDiscover.at < DISCOVERY_TTL_MS) {
          discovered = { commonDir: cachedDiscover.commonDir, topLevel: cachedDiscover.topLevel };
        } else {
          discovered = await this.snapshotDiscover(workspace.canonicalPath, deadline);
          this.workspaceDiscoverCache.set(workspace.canonicalPath, { ...discovered, at: this.now() });
        }
        const group = groups.get(discovered.commonDir);
        if (group === void 0) {
          if (groups.size >= MAX_REPOSITORIES) {
            errors.push({
              code: "snapshot-repository-limit",
              operation: "discover",
              message: `snapshot exceeded the ${MAX_REPOSITORIES} repository limit`,
              path: workspace.path,
              workspaceId: workspace.workspaceId
            });
            sourceError = {
              code: "snapshot-capacity",
              message: `snapshot stopped after ${MAX_REPOSITORIES} repositories`
            };
            break;
          }
          groups.set(discovered.commonDir, { cwd: discovered.topLevel, workspaces: [workspace] });
        } else {
          group.workspaces.push(workspace);
        }
      } catch (error) {
        if (error instanceof GitWorktreeError && error.code === "git-spawn-failed") {
          gitSpawnFailures += 1;
        }
        errors.push({
          code: error instanceof GitWorktreeError ? error.code : "git-discovery-failed",
          operation: "discover",
          message: safeErrorMessage(error),
          path: workspace.path,
          workspaceId: workspace.workspaceId
        });
        if (error instanceof GitWorktreeError && error.code === "snapshot-deadline") {
          sourceError = { code: "snapshot-deadline", message: error.message };
          break;
        }
      }
    }
    if (canonicalWorkspaces.length > 0 && groups.size === 0 && gitSpawnFailures === canonicalWorkspaces.length) {
      return {
        repos: [],
        errors,
        sourceError: {
          code: "git-unavailable",
          message: "Git executable is unavailable for this dsh instance"
        }
      };
    }
    const repos = [];
    let remainingWorktrees = MAX_TOTAL_WORKTREES;
    for (const [commonDir, group] of groups) {
      if (remainingWorktrees === 0) {
        errors.push({
          code: "snapshot-total-worktree-limit",
          operation: "list",
          message: `snapshot stopped after ${MAX_TOTAL_WORKTREES} worktrees`,
          path: group.cwd
        });
        sourceError ??= {
          code: "snapshot-capacity",
          message: `snapshot stopped after ${MAX_TOTAL_WORKTREES} total worktrees`
        };
        break;
      }
      try {
        let raw;
        let branches;
        const cachedTopology = this.repoTopologyCache.get(commonDir);
        if (cachedTopology !== void 0 && this.now() - cachedTopology.at < DISCOVERY_TTL_MS) {
          raw = cachedTopology.listedRaw;
          branches = cachedTopology.branches;
        } else {
          const listed = await this.snapshotGitChecked(
            group.cwd,
            ["worktree", "list", "--porcelain", "-z"],
            deadline
          );
          raw = parseWorktreePorcelain(listed.stdout);
          branches = await this.listBranches(group.cwd, deadline);
          this.repoTopologyCache.set(commonDir, { listedRaw: raw, branches, at: this.now() });
        }
        if (raw.length > MAX_WORKTREES_PER_REPOSITORY) {
          errors.push({
            code: "snapshot-worktree-limit",
            operation: "list",
            message: `repository exceeds the ${MAX_WORKTREES_PER_REPOSITORY} worktree snapshot limit`,
            path: group.cwd
          });
          sourceError ??= {
            code: "snapshot-capacity",
            message: "one or more repositories exceeded the worktree snapshot limit"
          };
        }
        const perRepository = Math.min(raw.length, MAX_WORKTREES_PER_REPOSITORY);
        const allowedWorktrees = Math.min(perRepository, remainingWorktrees);
        if (perRepository > remainingWorktrees) {
          errors.push({
            code: "snapshot-total-worktree-limit",
            operation: "list",
            message: `snapshot stopped after ${MAX_TOTAL_WORKTREES} total worktrees`,
            path: group.cwd
          });
          sourceError ??= {
            code: "snapshot-capacity",
            message: `snapshot stopped after ${MAX_TOTAL_WORKTREES} total worktrees`
          };
        }
        const worktrees = [];
        const associated = /* @__PURE__ */ new Set();
        let statusDeadlineReported = false;
        const boundedRaw = raw.slice(0, allowedWorktrees);
        remainingWorktrees -= boundedRaw.length;
        for (let index = 0; index < boundedRaw.length; index += 1) {
          const entry = boundedRaw[index];
          let path = resolve(entry.path);
          let pathAvailable = false;
          if (this.now() < deadline) {
            try {
              path = await this.existingPath(entry.path);
              pathAvailable = true;
            } catch (error) {
              errors.push({
                code: error instanceof GitWorktreeError ? error.code : "worktree-path-failed",
                operation: "list",
                message: safeErrorMessage(error),
                path: entry.path
              });
            }
          } else if (!statusDeadlineReported) {
            statusDeadlineReported = true;
            sourceError ??= {
              code: "snapshot-deadline",
              message: `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms probe budget`
            };
            errors.push({
              code: "snapshot-deadline",
              operation: "associate",
              message: "remaining filesystem and dirty associations were skipped after the snapshot deadline",
              path
            });
          }
          const matches = group.workspaces.filter((workspace2) => workspace2.canonicalPath === path);
          if (matches.length > 1) {
            errors.push({
              code: "duplicate-workspace-path",
              operation: "associate",
              message: `multiple workspace records own '${path}'`,
              path
            });
          }
          let workspace = matches[0];
          if (workspace === void 0 && pathAvailable === false) {
            workspace = state.workspaces.find((candidate) => candidate.path === entry.path);
          }
          if (workspace !== void 0) associated.add(workspace.workspaceId);
          let dirty = null;
          let upstream = null;
          let ahead = 0;
          let behind = 0;
          let statusUnhealthy = null;
          if (pathAvailable && !entry.bare) {
            if (this.now() >= deadline) {
              if (!statusDeadlineReported) {
                statusDeadlineReported = true;
                sourceError ??= {
                  code: "snapshot-deadline",
                  message: `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms Git probe budget`
                };
                errors.push({
                  code: "snapshot-deadline",
                  operation: "status",
                  message: "remaining dirty checks were skipped after the snapshot deadline",
                  path,
                  ...workspace === void 0 ? {} : { workspaceId: workspace.workspaceId }
                });
              }
            } else {
              try {
                const statusOutput = (await this.snapshotGitChecked(path, [
                  "status",
                  "--porcelain=v1",
                  "-z",
                  "--branch",
                  "--untracked-files=normal"
                ], deadline, SNAPSHOT_STATUS_TIMEOUT_MS)).stdout;
                const nul = statusOutput.indexOf("\0");
                const headerLine = nul >= 0 ? statusOutput.slice(0, nul) : statusOutput;
                dirty = nul >= 0 && statusOutput.length > nul + 1;
                const branchFacts = parseBranchLine(headerLine);
                upstream = branchFacts.upstream;
                ahead = branchFacts.ahead;
                behind = branchFacts.behind;
              } catch (error) {
                if (error instanceof GitWorktreeError && error.code === "snapshot-deadline") {
                  statusDeadlineReported = true;
                  sourceError ??= { code: "snapshot-deadline", message: error.message };
                }
                errors.push({
                  code: error instanceof GitWorktreeError ? error.code : "git-status-failed",
                  operation: "status",
                  message: safeErrorMessage(error),
                  path,
                  ...workspace === void 0 ? {} : { workspaceId: workspace.workspaceId }
                });
                statusUnhealthy = isNotARepositoryError(error) ? "not-a-repo" : "invalid";
              }
            }
          }
          const status = !pathAvailable ? "missing" : statusUnhealthy ?? "ready";
          const headState = entry.branch === null ? "detached" : ZERO_HEAD.test(entry.head) ? "unborn" : "branch";
          let attention = [];
          if (pathAvailable && !entry.bare && this.now() < deadline) {
            try {
              const gitDir = await worktreeGitDir(path, this.fs);
              if (gitDir !== null) {
                attention = await detectAttention(gitDir, this.fs, () => this.now() < deadline);
              }
            } catch {
            }
          }
          const sessionIds = workspace === void 0 ? [] : [...workspace.sessionIds];
          const runningSessionIds = sessionIds.filter((id) => state.runningSessionIds.has(id));
          for (const id of this.runningAtSnapshotPath(path, runningLocations)) {
            if (!runningSessionIds.includes(id)) runningSessionIds.push(id);
          }
          worktrees.push({
            worktreeId: opaqueId("worktree", commonDir, path),
            path,
            head: entry.head,
            branch: entry.branch,
            isMain: index === 0,
            dirty,
            locked: entry.locked,
            status,
            headState,
            upstream,
            ahead,
            behind,
            attention,
            workspaceId: workspace?.workspaceId ?? null,
            sessionIds,
            runningSessionIds
          });
        }
        for (const workspace of group.workspaces) {
          if (!associated.has(workspace.workspaceId)) {
            errors.push({
              code: "workspace-not-worktree-root",
              operation: "associate",
              message: `workspace '${workspace.workspaceId}' is inside the repository but is not a worktree root`,
              path: workspace.path,
              workspaceId: workspace.workspaceId
            });
          }
        }
        repos.push({
          repoId: opaqueId("repo", commonDir),
          commonDir,
          mainPath: worktrees[0].path,
          worktrees,
          branches
        });
      } catch (error) {
        errors.push({
          code: error instanceof GitWorktreeError ? error.code : "git-list-failed",
          operation: "list",
          message: safeErrorMessage(error),
          path: group.cwd
        });
        if (error instanceof GitWorktreeError && error.code === "snapshot-deadline") {
          sourceError ??= { code: "snapshot-deadline", message: error.message };
          break;
        }
      }
    }
    return { repos, errors, ...sourceError === void 0 ? {} : { sourceError } };
  }
  /** Issue a short-lived, in-memory preview after a coherent repository read. */
  async previewCreate(untrusted) {
    const input = parsePreviewInput(untrusted);
    const initial = await this.readSource();
    const initialWorkspace = this.workspace(initial, input.sourceWorkspaceId);
    const discovered = await this.discover(initialWorkspace.path);
    return await this.mutex.run(discovered.commonDir, async () => {
      const state = await this.readSource();
      const workspace = this.workspace(state, input.sourceWorkspaceId);
      const topology = await this.topology(workspace.path);
      if (topology.commonDir !== discovered.commonDir) {
        fail("repository-changed", "the source workspace changed repositories during preview");
      }
      const main = topology.worktrees[0];
      if (main.bare) fail("bare-repository", "bare repositories cannot own linked worktrees");
      const targetRoot = this.worktreeRootFor(topology.mainPath, topology.commonDir);
      const targetPath = resolve(targetRoot, input.basename);
      if (!targetPath.startsWith(`${targetRoot}${sep}`)) fail("unsafe-path", "target escaped the unified worktree root");
      await this.assertPathAbsent(targetPath);
      await this.assertBranchFormat(topology.mainPath, input.branch.name);
      const branchHead = await this.localBranchHead(topology.mainPath, input.branch.name);
      let startHead;
      if (input.branch.kind === "existing") {
        if (branchHead === null) fail("branch-not-found", `local branch '${input.branch.name}' does not exist`);
        if (topology.worktrees.some((worktree) => worktree.branch === input.branch.name)) {
          fail("branch-checked-out", `local branch '${input.branch.name}' is already checked out`);
        }
        startHead = branchHead;
      } else {
        if (branchHead !== null) fail("branch-exists", `local branch '${input.branch.name}' already exists`);
        if (input.startRef !== void 0) {
          const startHeadOf = await this.localBranchHead(topology.mainPath, input.startRef);
          if (startHeadOf === null) fail("branch-not-found", `source branch '${input.startRef}' does not exist`);
          startHead = startHeadOf;
        } else {
          startHead = main.head;
        }
      }
      this.pruneCaches();
      if (this.previews.size >= MAX_PREVIEWS) fail("preview-capacity", "too many live worktree previews");
      const token = this.uniquePreviewToken();
      const createdAt = this.now();
      const preview = {
        previewToken: token,
        expiresAt: createdAt + PREVIEW_TTL_MS,
        repoId: opaqueId("repo", topology.commonDir),
        commonDir: topology.commonDir,
        mainPath: topology.mainPath,
        targetPath,
        branch: input.branch.name,
        branchMode: input.branch.kind,
        baseHead: startHead,
        startRef: input.branch.kind === "new" ? input.startRef : void 0,
        sourceWorkspaceId: input.sourceWorkspaceId,
        basename: input.basename,
        createdAt
      };
      this.previews.set(token, preview);
      return this.publicPreview(preview);
    });
  }
  /** Create exactly the previewed worktree, with bounded same-process TTL idempotency. */
  async create(untrusted) {
    const input = parseCreateInput(untrusted);
    this.clearDiscoveryCaches();
    this.pruneCaches();
    const existing = this.createOperations.get(input.operationId);
    let preview;
    if (existing !== void 0) {
      if (existing.previewToken !== input.previewToken) {
        fail("operation-conflict", "operationId is already bound to another preview");
      }
      preview = existing.preview;
      if (existing.state === "creating") {
        const result = await existing.createPromise;
        return { ...result, replayed: true };
      }
      if (existing.state === "created") return await this.verifyCreatedReplay(existing);
      if (existing.state === "rolling-back" || existing.state === "rollback-uncertain" || existing.state === "rolled-back") {
        fail("operation-rolled-back", "the create operation has already been rolled back");
      }
    } else {
      const candidate = this.previews.get(input.previewToken);
      if (candidate === void 0) fail("preview-not-found", "preview token is unknown or expired");
      if (candidate.expiresAt <= this.now()) {
        this.previews.delete(input.previewToken);
        fail("preview-expired", "preview token has expired");
      }
      this.evictOldestCreateOperationIfFull();
      if (this.createOperations.size >= this.operationCapacity) {
        fail("operation-capacity", "too many retained worktree operations");
      }
      preview = candidate;
    }
    const record = existing ?? {
      previewToken: input.previewToken,
      preview,
      state: "ready",
      updatedAt: this.now(),
      attemptedCreate: false,
      gitAccepted: false,
      attemptedRollback: false
    };
    this.createOperations.set(input.operationId, record);
    record.state = "creating";
    record.updatedAt = this.now();
    const promise = this.performCreate(input.operationId, preview, record, existing !== void 0);
    record.createPromise = promise;
    try {
      const result = await promise;
      record.state = "created";
      record.updatedAt = this.now();
      record.createResult = result;
      if (result.rollbackAuthorized) {
        record.facts = {
          repoId: result.repoId,
          worktreeId: result.worktreeId,
          commonDir: result.commonDir,
          mainPath: preview.mainPath,
          path: result.path,
          branch: result.branch,
          head: result.head,
          branchCreated: result.branchCreated
        };
      }
      return result;
    } catch (error) {
      record.state = record.attemptedCreate ? "uncertain" : "ready";
      record.updatedAt = this.now();
      record.createPromise = void 0;
      throw error;
    }
  }
  /**
   * Compensate only a worktree proven to have been created by this operation.
   * No force and no branch deletion are ever available.
   */
  async rollbackCreate(untrusted) {
    const input = parseRollbackInput(untrusted);
    this.clearDiscoveryCaches();
    this.pruneCaches();
    const record = this.createOperations.get(input.operationId);
    if (record === void 0) fail("operation-not-found", "no create operation can authorize this rollback");
    if (record.state === "creating") fail("operation-busy", "create operation is still running");
    if (record.state === "ready") fail("operation-not-created", "create operation did not create a worktree");
    if (record.state === "rolling-back") {
      const result = await record.rollbackPromise;
      return { ...result, replayed: true };
    }
    if (record.state === "rolled-back") return { ...record.rollbackResult, replayed: true };
    if (!record.gitAccepted || record.facts === void 0) {
      fail("rollback-not-authorized", "Git add success was not observed; automatic rollback has no provenance");
    }
    const stateBeforeRollback = record.state;
    record.state = "rolling-back";
    record.updatedAt = this.now();
    const promise = this.performRollback(
      input.operationId,
      record.facts,
      record,
      stateBeforeRollback === "rollback-uncertain"
    );
    record.rollbackPromise = promise;
    try {
      const result = await promise;
      record.state = "rolled-back";
      record.updatedAt = this.now();
      record.rollbackResult = result;
      return result;
    } catch (error) {
      record.state = record.attemptedRollback ? "rollback-uncertain" : stateBeforeRollback;
      record.updatedAt = this.now();
      record.rollbackPromise = void 0;
      throw error;
    }
  }
  /** Git-first removal; the durable workspace registration remains for the caller's next step. */
  async remove(untrusted) {
    const input = parseRemoveInput(untrusted);
    const fingerprint = objectFingerprint(input);
    this.clearDiscoveryCaches();
    this.pruneCaches();
    const existing = this.removeOperations.get(input.operationId);
    if (existing !== void 0) {
      if (existing.fingerprint !== fingerprint) fail("operation-conflict", "operationId is bound to another removal");
      if (existing.state === "removing") {
        const result = await existing.promise;
        return { ...result, replayed: true };
      }
      if (existing.state === "removed") return await this.verifyRemovedReplay(existing);
    }
    if (existing === void 0) {
      this.evictOldestRemoveOperationIfFull();
      if (this.removeOperations.size >= this.operationCapacity) {
        fail("operation-capacity", "too many retained worktree operations");
      }
    }
    const record = existing ?? {
      fingerprint,
      state: "ready",
      updatedAt: this.now(),
      attemptedRemove: false,
      branchDeleteAttempted: false
    };
    this.removeOperations.set(input.operationId, record);
    record.state = "removing";
    record.updatedAt = this.now();
    const promise = this.performRemove(input, record, existing !== void 0);
    record.promise = promise;
    try {
      const result = await promise;
      record.state = "removed";
      record.updatedAt = this.now();
      record.result = result;
      return result;
    } catch (error) {
      record.state = record.attemptedRemove ? "uncertain" : "ready";
      record.updatedAt = this.now();
      record.promise = void 0;
      throw error;
    }
  }
  /** A terminal result is a receipt, not a substitute for current Git facts. */
  async verifyCreatedReplay(record) {
    const result = record.createResult;
    if (result === void 0) throw new Error("created operation is missing its terminal result");
    return await this.mutex.run(result.commonDir, async () => {
      const topology = await this.topology(record.preview.mainPath);
      if (topology.commonDir !== result.commonDir || topology.commonDir !== record.preview.commonDir || topology.mainPath !== record.preview.mainPath || opaqueId("repo", topology.commonDir) !== result.repoId) {
        fail("operation-conflict", "created operation repository changed before terminal replay");
      }
      const target = topology.worktrees.find((worktree) => worktree.path === result.path);
      if (target === void 0 || target === topology.worktrees[0] || target.bare || result.path !== record.preview.targetPath || target.branch !== result.branch || target.branch !== record.preview.branch || target.head !== result.head || target.head !== record.preview.baseHead || opaqueId("worktree", topology.commonDir, target.path) !== result.worktreeId) {
        fail("operation-conflict", "created worktree no longer has the terminal operation identity");
      }
      return { ...result, replayed: true };
    });
  }
  /** Verify the Git-first receipt again before a client retries workspace.delete. */
  async verifyRemovedReplay(record) {
    const intent = record.intent;
    const result = record.result;
    if (intent === void 0 || result === void 0) {
      throw new Error("removed operation is missing its terminal receipt");
    }
    return await this.mutex.run(intent.commonDir, async () => {
      const topology = await this.topology(intent.mainPath);
      if (topology.commonDir !== intent.commonDir || topology.mainPath !== intent.mainPath || opaqueId("repo", topology.commonDir) !== intent.repoId) {
        fail("operation-conflict", "removed operation repository changed before terminal replay");
      }
      if (topology.worktrees.some((worktree) => worktree.path === intent.path)) {
        fail("operation-conflict", "removed worktree path reappeared before terminal replay");
      }
      const state = await this.readSource();
      await this.assertRemovedWorkspaceReceipt(intent, state);
      return { ...result, replayed: true };
    });
  }
  async assertRemovedWorkspaceReceipt(intent, state) {
    const workspace = state.workspaces.find((candidate) => candidate.workspaceId === intent.workspaceId);
    if (workspace === void 0) return;
    if (workspace.path !== intent.workspacePath || !sameMembership(workspace.sessionIds, intent.sessionIds)) {
      fail("operation-conflict", "workspace receipt changed after Git-first removal");
    }
    this.assertNoRunningSessions(workspace, state.runningSessionIds);
    await this.assertNoRunningAtPath(intent.path, state);
  }
  async performCreate(id, preview, operation, replayed) {
    return await this.mutex.run(preview.commonDir, async () => {
      const state = await this.readSource();
      const workspace = this.workspace(state, preview.sourceWorkspaceId);
      const topology = await this.topology(workspace.path);
      if (topology.commonDir !== preview.commonDir || topology.mainPath !== preview.mainPath) {
        fail("preview-stale", "repository identity changed after preview");
      }
      const targetRoot = this.worktreeRootFor(topology.mainPath, topology.commonDir);
      const targetPath = resolve(targetRoot, preview.basename);
      if (targetPath !== preview.targetPath || !targetPath.startsWith(`${this.worktreesRoot}${sep}`)) {
        fail("preview-stale", "target identity changed after preview");
      }
      const reconciled = topology.worktrees.find((worktree) => worktree.path === targetPath);
      if (reconciled !== void 0) {
        if (!operation.attemptedCreate) {
          fail("target-exists", `target path '${targetPath}' was not created by this operation`);
        }
        if (reconciled.bare || reconciled.branch !== preview.branch || reconciled.head !== preview.baseHead) {
          fail("operation-conflict", "operation target exists with a different branch or HEAD");
        }
        const facts = {
          repoId: opaqueId("repo", topology.commonDir),
          worktreeId: opaqueId("worktree", topology.commonDir, reconciled.path),
          commonDir: topology.commonDir,
          mainPath: topology.mainPath,
          path: reconciled.path,
          branch: preview.branch,
          head: reconciled.head,
          branchCreated: preview.branchMode === "new" && operation.gitAccepted
        };
        if (operation.gitAccepted) operation.facts = facts;
        return {
          operationId: id,
          created: true,
          replayed: true,
          repoId: facts.repoId,
          worktreeId: facts.worktreeId,
          commonDir: facts.commonDir,
          path: facts.path,
          branch: facts.branch,
          head: facts.head,
          rollbackAuthorized: operation.gitAccepted,
          branchCreated: facts.branchCreated
        };
      }
      await this.assertPathAbsent(targetPath);
      await this.assertBranchFormat(topology.mainPath, preview.branch);
      const branchHead = await this.localBranchHead(topology.mainPath, preview.branch);
      if (preview.branchMode === "existing") {
        if (branchHead !== preview.baseHead) fail("preview-stale", "existing branch moved after preview");
        if (topology.worktrees.some((worktree) => worktree.branch === preview.branch)) {
          fail("branch-checked-out", `local branch '${preview.branch}' is already checked out`);
        }
      } else {
        if (branchHead !== null) {
          fail(
            "operation-conflict",
            operation.gitAccepted && branchHead === preview.baseHead ? "the confirmed worktree disappeared while its preserved branch remains" : "new branch now exists without confirmed operation provenance"
          );
        } else if (preview.startRef !== void 0) {
          const startHead = await this.localBranchHead(topology.mainPath, preview.startRef);
          if (startHead !== preview.baseHead) fail("preview-stale", "source branch moved after preview");
        } else if (topology.worktrees[0].head !== preview.baseHead) {
          fail("preview-stale", "main checkout moved after preview");
        }
      }
      const latest = await this.readSource();
      const latestWorkspace = this.workspace(latest, preview.sourceWorkspaceId);
      if (await this.existingPath(latestWorkspace.path) !== await this.existingPath(workspace.path)) {
        fail("preview-stale", "source workspace path changed after preview");
      }
      const expectedFacts = {
        repoId: opaqueId("repo", topology.commonDir),
        worktreeId: opaqueId("worktree", topology.commonDir, targetPath),
        commonDir: topology.commonDir,
        mainPath: topology.mainPath,
        path: targetPath,
        branch: preview.branch,
        head: preview.baseHead,
        branchCreated: preview.branchMode === "new"
      };
      operation.attemptedCreate = true;
      await this.ensureWorktreeRoot(targetRoot);
      const args = preview.branchMode === "existing" ? ["worktree", "add", "--", targetPath, preview.branch] : ["worktree", "add", "-b", preview.branch, "--", targetPath, preview.baseHead];
      try {
        await this.gitChecked(topology.mainPath, args, true);
      } catch (error) {
        if (error instanceof GitWorktreeError && error.code === "git-spawn-failed") {
          operation.attemptedCreate = false;
        }
        throw error;
      }
      operation.gitAccepted = true;
      operation.facts = expectedFacts;
      const after = await this.topology(topology.mainPath);
      const created = after.worktrees.find((worktree) => worktree.path === targetPath);
      if (after.commonDir !== topology.commonDir || created === void 0 || created.branch !== preview.branch || created.head !== preview.baseHead || created.bare) {
        fail("postcondition-failed", "Git did not publish the expected worktree identity");
      }
      return {
        operationId: id,
        created: true,
        replayed,
        repoId: opaqueId("repo", after.commonDir),
        worktreeId: opaqueId("worktree", after.commonDir, created.path),
        commonDir: after.commonDir,
        path: created.path,
        branch: preview.branch,
        head: created.head,
        rollbackAuthorized: true,
        branchCreated: preview.branchMode === "new"
      };
    });
  }
  async performRollback(id, facts, operation, replayed) {
    return await this.mutex.run(facts.commonDir, async () => {
      const state = await this.readSource();
      if (await this.anyWorkspaceOwnsPath(state, facts.path)) {
        fail("rollback-has-workspace", "rollback is forbidden after a workspace registration exists");
      }
      await this.assertNoRunningAtPath(facts.path, state);
      const topology = await this.topology(facts.mainPath);
      if (topology.commonDir !== facts.commonDir) fail("repository-changed", "created repository identity changed");
      const target = topology.worktrees.find((worktree) => worktree.path === facts.path);
      if (target === void 0) {
        return {
          operationId: id,
          removed: true,
          replayed: true,
          repoId: facts.repoId,
          worktreeId: facts.worktreeId,
          commonDir: facts.commonDir,
          path: facts.path,
          branch: facts.branch,
          head: facts.head,
          branchPreserved: true
        };
      }
      if (target === topology.worktrees[0]) fail("main-worktree", "the main checkout can never be rolled back");
      if (target.locked) fail("worktree-locked", "locked worktrees cannot be rolled back");
      if (target.branch !== facts.branch) fail("worktree-changed", "the operation-created worktree changed branch");
      if (target.head !== facts.head) fail("worktree-changed", "the operation-created worktree changed HEAD");
      if (await this.isDirty(target.path)) fail("worktree-dirty", "dirty worktrees cannot be rolled back");
      const latest = await this.readSource();
      if (await this.anyWorkspaceOwnsPath(latest, facts.path)) {
        fail("rollback-has-workspace", "workspace registration appeared during rollback");
      }
      await this.assertNoRunningAtPath(facts.path, latest);
      const finalTopology = await this.topology(facts.mainPath);
      if (finalTopology.commonDir !== facts.commonDir || finalTopology.mainPath !== facts.mainPath) {
        fail("repository-changed", "created repository identity changed immediately before rollback");
      }
      const finalTarget = finalTopology.worktrees.find((worktree) => worktree.path === facts.path);
      if (finalTarget === void 0) {
        return {
          operationId: id,
          removed: true,
          replayed: true,
          repoId: facts.repoId,
          worktreeId: facts.worktreeId,
          commonDir: facts.commonDir,
          path: facts.path,
          branch: facts.branch,
          head: facts.head,
          branchPreserved: true
        };
      }
      if (finalTarget === finalTopology.worktrees[0] || finalTarget.locked || finalTarget.branch !== facts.branch || finalTarget.head !== facts.head) {
        fail("worktree-changed", "operation-created worktree identity changed immediately before rollback");
      }
      if (await this.isDirty(finalTarget.path)) {
        fail("worktree-dirty", "worktree became dirty immediately before rollback");
      }
      operation.attemptedRollback = true;
      await this.gitChecked(finalTopology.mainPath, ["worktree", "remove", "--", facts.path], true);
      const after = await this.topology(finalTopology.mainPath);
      if (after.worktrees.some((worktree) => worktree.path === facts.path)) {
        fail("postcondition-failed", "Git still reports the rolled-back worktree");
      }
      return {
        operationId: id,
        removed: true,
        replayed,
        repoId: facts.repoId,
        worktreeId: facts.worktreeId,
        commonDir: facts.commonDir,
        path: facts.path,
        branch: facts.branch,
        head: target.head,
        branchPreserved: true
      };
    });
  }
  async performRemove(input, operation, replayed) {
    if (operation.intent !== void 0) {
      return await this.mutex.run(operation.intent.commonDir, async () => {
        return await this.reconcileBoundRemove(input, operation, operation.intent, true);
      });
    }
    if (input.workspaceId === void 0) {
      const unregisteredPath = input.path;
      if (unregisteredPath === void 0) fail("invalid-input", "input.path is required for an unregistered removal");
      const discovered2 = await this.discover(unregisteredPath);
      return await this.mutex.run(discovered2.commonDir, async () => {
        const state = await this.readSource();
        const canonicalPath = await this.existingPath(unregisteredPath);
        await this.assertNoRunningAtPath(canonicalPath, state);
        for (const candidate of state.workspaces) {
          const candidatePath = await this.existingPath(candidate.path).catch(() => null);
          if (candidatePath === null) continue;
          if (candidatePath === canonicalPath || candidatePath.startsWith(`${canonicalPath}${sep}`)) {
            fail("workspace-registered", "the target worktree is already registered as a workspace");
          }
        }
        const topology = await this.topology(canonicalPath);
        if (topology.commonDir !== discovered2.commonDir) fail("expected-mismatch", "worktree changed repositories");
        const repoId = opaqueId("repo", topology.commonDir);
        if (repoId !== input.expected.repoId) fail("expected-mismatch", "repository identity changed");
        const target = topology.worktrees.find((worktree) => worktree.path === canonicalPath);
        if (target === void 0) fail("worktree-not-found", "path is not an exact worktree root");
        const worktreeId = opaqueId("worktree", topology.commonDir, target.path);
        if (worktreeId !== input.expected.worktreeId) fail("expected-mismatch", "worktree identity changed");
        if (target === topology.worktrees[0]) fail("main-worktree", "the main checkout cannot be removed");
        if (target.locked) fail("worktree-locked", "locked worktrees cannot be removed");
        if (target.branch !== input.expected.branch) fail("expected-mismatch", "worktree branch changed");
        if (target.head !== input.expected.head) fail("expected-mismatch", "worktree HEAD changed");
        if (await this.isDirty(target.path)) fail("worktree-dirty", "dirty worktrees cannot be removed");
        const intent = {
          repoId,
          worktreeId,
          commonDir: topology.commonDir,
          mainPath: topology.mainPath,
          path: target.path,
          branch: target.branch,
          head: target.head,
          sessionIds: [],
          deleteBranch: input.deleteBranch
        };
        operation.intent = intent;
        return await this.commitBoundRemove(input.operationId, operation, intent, replayed);
      });
    }
    const registeredWorkspaceId = input.workspaceId;
    const initialState = await this.readSource();
    const initialWorkspace = this.workspace(initialState, registeredWorkspaceId);
    const discovered = await this.discover(initialWorkspace.path);
    return await this.mutex.run(discovered.commonDir, async () => {
      let state = await this.readSource();
      let workspace = this.workspace(state, registeredWorkspaceId);
      const workspacePath = await this.existingPath(workspace.path);
      await this.assertNoOtherWorkspaceWithin(state, workspacePath, registeredWorkspaceId);
      this.assertNoRunningSessions(workspace, state.runningSessionIds);
      await this.assertNoRunningAtPath(workspacePath, state);
      const topology = await this.topology(workspace.path);
      if (topology.commonDir !== discovered.commonDir) fail("expected-mismatch", "workspace changed repositories");
      const repoId = opaqueId("repo", topology.commonDir);
      if (repoId !== input.expected.repoId) fail("expected-mismatch", "repository identity changed");
      const target = topology.worktrees.find((worktree) => worktree.path === workspacePath);
      if (target === void 0) fail("worktree-not-found", "workspace is not an exact worktree root");
      const worktreeId = opaqueId("worktree", topology.commonDir, target.path);
      if (worktreeId !== input.expected.worktreeId) fail("expected-mismatch", "worktree identity changed");
      if (target === topology.worktrees[0]) fail("main-worktree", "the main checkout cannot be removed");
      if (target.locked) fail("worktree-locked", "locked worktrees cannot be removed");
      if (target.branch !== input.expected.branch) fail("expected-mismatch", "worktree branch changed");
      if (target.head !== input.expected.head) fail("expected-mismatch", "worktree HEAD changed");
      if (await this.isDirty(target.path)) fail("worktree-dirty", "dirty worktrees cannot be removed");
      state = await this.readSource();
      workspace = this.workspace(state, registeredWorkspaceId);
      if (await this.existingPath(workspace.path) !== workspacePath) {
        fail("expected-mismatch", "workspace path changed during removal");
      }
      await this.assertNoOtherWorkspaceWithin(state, workspacePath, registeredWorkspaceId);
      this.assertNoRunningSessions(workspace, state.runningSessionIds);
      await this.assertNoRunningAtPath(workspacePath, state);
      const sessionIds = [...workspace.sessionIds];
      const intent = {
        workspaceId: input.workspaceId,
        workspacePath: workspace.path,
        repoId,
        worktreeId,
        commonDir: topology.commonDir,
        mainPath: topology.mainPath,
        path: target.path,
        branch: target.branch,
        head: target.head,
        sessionIds,
        deleteBranch: input.deleteBranch
      };
      operation.intent = intent;
      return await this.commitBoundRemove(input.operationId, operation, intent, replayed);
    });
  }
  /** Best-effort optional branch deletion after a removal, once per
   *  operation (design 08 §11 user decision). Called from every terminal
   *  removal path — including the target-absent replay paths — so a removal
   *  that committed before a failure still reports the branch outcome
   *  honestly (branchDeleted / branchDeleteFailed on the result). */
  async attemptBranchDelete(operation, intent, mainPath) {
    if (intent.deleteBranch === void 0 || operation.branchDeleteAttempted) return;
    operation.branchDeleteAttempted = true;
    try {
      await this.assertBranchFormat(mainPath, intent.deleteBranch);
      await this.gitChecked(mainPath, ["branch", "-D", intent.deleteBranch], true);
      intent.branchDeleted = true;
    } catch {
      intent.branchDeleteFailed = true;
    }
  }
  /** Reconcile a removal whose Git subprocess may have committed before failure. */
  async reconcileBoundRemove(input, operation, intent, replayed) {
    const topology = await this.topology(intent.mainPath);
    if (topology.commonDir !== intent.commonDir || topology.mainPath !== intent.mainPath) {
      fail("operation-conflict", "bound removal repository identity changed");
    }
    const target = topology.worktrees.find((worktree) => worktree.path === intent.path);
    if (target === void 0) {
      const state2 = await this.readSource();
      await this.assertRemovedWorkspaceReceipt(intent, state2);
      await this.attemptBranchDelete(operation, intent, topology.mainPath);
      return this.removeResult(input.operationId, intent, true);
    }
    const repoId = opaqueId("repo", topology.commonDir);
    const worktreeId = opaqueId("worktree", topology.commonDir, target.path);
    if (repoId !== intent.repoId || worktreeId !== intent.worktreeId || target.branch !== intent.branch || target.head !== intent.head) {
      fail("operation-conflict", "bound removal target changed while its outcome was uncertain");
    }
    if (target === topology.worktrees[0]) fail("operation-conflict", "bound linked worktree became the main checkout");
    if (target.locked) fail("worktree-locked", "locked worktrees cannot be removed");
    if (await this.isDirty(target.path)) fail("worktree-dirty", "dirty worktrees cannot be removed");
    if (input.workspaceId === void 0) {
      const state2 = await this.readSource();
      const canonicalPath = await this.existingPath(intent.path);
      await this.assertNoRunningAtPath(canonicalPath, state2);
      operation.intent = intent;
      return await this.commitBoundRemove(input.operationId, operation, intent, replayed);
    }
    const state = await this.readSource();
    const workspace = this.workspace(state, input.workspaceId);
    const workspacePath = await this.existingPath(workspace.path);
    if (workspacePath !== intent.path) fail("operation-conflict", "workspace path changed during removal recovery");
    await this.assertNoOtherWorkspaceWithin(state, workspacePath, input.workspaceId);
    this.assertNoRunningSessions(workspace, state.runningSessionIds);
    await this.assertNoRunningAtPath(workspacePath, state);
    const refreshed = {
      ...intent,
      workspacePath: workspace.path,
      sessionIds: [...workspace.sessionIds]
    };
    operation.intent = refreshed;
    return await this.commitBoundRemove(input.operationId, operation, refreshed, replayed);
  }
  async commitBoundRemove(operationIdValue, operation, intent, replayed) {
    const finalTopology = await this.topology(intent.mainPath);
    if (finalTopology.commonDir !== intent.commonDir || finalTopology.mainPath !== intent.mainPath) {
      fail("operation-conflict", "removal repository changed immediately before mutation");
    }
    const finalTarget = finalTopology.worktrees.find((worktree) => worktree.path === intent.path);
    if (finalTarget === void 0) {
      const state = await this.readSource();
      await this.assertRemovedWorkspaceReceipt(intent, state);
      await this.attemptBranchDelete(operation, intent, finalTopology.mainPath);
      return this.removeResult(operationIdValue, intent, true);
    }
    if (finalTarget === finalTopology.worktrees[0] || finalTarget.locked || opaqueId("worktree", finalTopology.commonDir, finalTarget.path) !== intent.worktreeId || finalTarget.branch !== intent.branch || finalTarget.head !== intent.head) {
      fail("operation-conflict", "removal target changed immediately before mutation");
    }
    if (await this.isDirty(finalTarget.path)) {
      fail("worktree-dirty", "worktree became dirty immediately before removal");
    }
    operation.attemptedRemove = true;
    await this.gitChecked(finalTopology.mainPath, ["worktree", "remove", "--", intent.path], true);
    const after = await this.topology(finalTopology.mainPath);
    if (after.commonDir !== intent.commonDir || after.worktrees.some((worktree) => worktree.path === intent.path)) {
      fail("postcondition-failed", "Git still reports the removed worktree or repository identity changed");
    }
    await this.attemptBranchDelete(operation, intent, finalTopology.mainPath);
    return this.removeResult(operationIdValue, intent, replayed);
  }
  removeResult(operationIdValue, intent, replayed) {
    return {
      operationId: operationIdValue,
      removed: true,
      replayed,
      ...intent.workspaceId === void 0 ? {} : { workspaceId: intent.workspaceId },
      repoId: intent.repoId,
      worktreeId: intent.worktreeId,
      commonDir: intent.commonDir,
      path: intent.path,
      branch: intent.branch,
      head: intent.head,
      sessionIds: [...intent.sessionIds],
      next: intent.workspaceId === void 0 ? "none" : "delete-workspace",
      branchPreserved: true,
      ...intent.branchDeleted === true ? { branchDeleted: true } : {},
      ...intent.branchDeleteFailed === true ? { branchDeleteFailed: true } : {}
    };
  }
  /** Repo-specific worktree subdirectory: `<root>/<repo-name>-<hash12>` — a
   *  unified location keyed by the repository identity (common dir), so two
   *  same-named repositories never block each other, and never inside a
   *  working tree (git status stays clean). */
  worktreeRootFor(mainPath, commonDir) {
    const repoName = basename(mainPath) || "repo";
    const digest = createHash("sha256").update(commonDir).digest("hex").slice(0, 12);
    return join(this.worktreesRoot, `${repoName}-${digest}`);
  }
  /** Ensure the unified worktree root exists before `git worktree add`
   *  (git requires the parent directory; mkdir is recursive + idempotent). */
  async ensureWorktreeRoot(root) {
    try {
      await this.fs.mkdir(root);
    } catch {
    }
  }
  clearDiscoveryCaches() {
    this.workspaceDiscoverCache.clear();
    this.repoTopologyCache.clear();
  }
  async readSource() {
    let rawWorkspaces;
    let rawAgents;
    try {
      [rawWorkspaces, rawAgents] = await Promise.all([
        this.source.listWorkspaces(),
        this.source.listAgents()
      ]);
    } catch (error) {
      if (error instanceof GitWorktreeError) throw error;
      fail("state-source-unavailable", `host state source is unavailable: ${safeErrorMessage(error)}`);
    }
    if (!Array.isArray(rawWorkspaces) || !Array.isArray(rawAgents)) {
      fail("state-source-invalid", "host state source returned a non-array");
    }
    if (rawWorkspaces.length > MAX_WORKSPACES) {
      fail("state-source-capacity", `host returned more than ${MAX_WORKSPACES} workspaces`);
    }
    if (rawAgents.length > MAX_AGENTS) {
      fail("state-source-capacity", `host returned more than ${MAX_AGENTS} agents`);
    }
    let totalSessionMemberships = 0;
    const workspaces = rawWorkspaces.map((raw, index) => {
      assertRecord(raw, `workspaces[${index}]`);
      const workspaceId = requiredString(raw.workspaceId, `workspaces[${index}].workspaceId`, 256);
      const path = absoluteExpectedPath(raw.path, `workspaces[${index}].path`);
      if (!Array.isArray(raw.sessionIds) || raw.sessionIds.some((id) => typeof id !== "string")) {
        fail("state-source-invalid", `workspaces[${index}].sessionIds is invalid`);
      }
      if (raw.sessionIds.length > MAX_SESSIONS_PER_WORKSPACE) {
        fail(
          "state-source-capacity",
          `workspace '${workspaceId}' has more than ${MAX_SESSIONS_PER_WORKSPACE} sessions`
        );
      }
      totalSessionMemberships += raw.sessionIds.length;
      if (totalSessionMemberships > MAX_TOTAL_SESSION_MEMBERSHIPS) {
        fail(
          "state-source-capacity",
          `host returned more than ${MAX_TOTAL_SESSION_MEMBERSHIPS} total workspace/session memberships`
        );
      }
      const sessionIds = raw.sessionIds.map((id, sessionIndex) => requiredString(
        id,
        `workspaces[${index}].sessionIds[${sessionIndex}]`,
        256
      ));
      return { workspaceId, path, sessionIds };
    });
    const runningSessionIds = /* @__PURE__ */ new Set();
    const runningAgents = [];
    for (let index = 0; index < rawAgents.length; index += 1) {
      const raw = rawAgents[index];
      assertRecord(raw, `agents[${index}]`);
      const sessionId = requiredString(raw.sessionId, `agents[${index}].sessionId`, 256);
      if (raw.status !== "idle" && raw.status !== "running") {
        fail("state-source-invalid", `agents[${index}].status is invalid`);
      }
      const cwd = raw.cwd === void 0 ? void 0 : absoluteExpectedPath(raw.cwd, `agents[${index}].cwd`);
      if (raw.status === "running") {
        runningSessionIds.add(sessionId);
        runningAgents.push({ sessionId, status: "running", ...cwd === void 0 ? {} : { cwd } });
      }
    }
    return { workspaces, runningSessionIds, runningAgents };
  }
  workspace(state, id) {
    const workspace = state.workspaces.find((candidate) => candidate.workspaceId === id);
    if (workspace === void 0) fail("workspace-not-found", `workspace '${id}' does not exist`);
    return workspace;
  }
  assertNoRunningSessions(workspace, running) {
    const blocked = workspace.sessionIds.filter((id) => running.has(id));
    if (blocked.length > 0) {
      fail("running-agent", `worktree has running associated session(s): ${blocked.join(", ")}`);
    }
  }
  /** Canonicalize each distinct live cwd at most once for the whole snapshot. */
  async snapshotRunningLocations(state, deadline, errors) {
    const canonicalByCwd = /* @__PURE__ */ new Map();
    const locations = [];
    let deadlineExceeded = false;
    for (const agent of state.runningAgents) {
      if (agent.cwd === void 0) continue;
      const paths = [resolve(agent.cwd)];
      if (this.now() >= deadline) {
        deadlineExceeded = true;
      } else {
        let canonical = canonicalByCwd.get(agent.cwd);
        if (canonical === void 0 && !canonicalByCwd.has(agent.cwd)) {
          try {
            canonical = await this.existingPath(agent.cwd);
            canonicalByCwd.set(agent.cwd, canonical);
          } catch (error) {
            canonical = null;
            canonicalByCwd.set(agent.cwd, null);
            errors.push({
              code: error instanceof GitWorktreeError ? error.code : "running-agent-path-failed",
              operation: "associate",
              message: `cannot canonicalize running session '${agent.sessionId}': ${safeErrorMessage(error)}`,
              path: agent.cwd
            });
          }
        }
        if (canonical !== null && canonical !== void 0 && !paths.includes(canonical)) paths.push(canonical);
      }
      locations.push({ sessionId: agent.sessionId, paths });
    }
    return { locations, deadlineExceeded };
  }
  runningAtSnapshotPath(target, locations) {
    const matches = /* @__PURE__ */ new Set();
    for (const location of locations) {
      if (location.paths.some((path) => this.containsPath(target, path))) matches.add(location.sessionId);
    }
    return [...matches];
  }
  async runningAtPath(target, state, strict) {
    const matches = /* @__PURE__ */ new Set();
    for (const agent of state.runningAgents) {
      if (agent.cwd === void 0) continue;
      if (this.containsPath(target, agent.cwd)) {
        matches.add(agent.sessionId);
        continue;
      }
      try {
        const canonical = await this.existingPath(agent.cwd);
        if (this.containsPath(target, canonical)) matches.add(agent.sessionId);
      } catch (error) {
        if (strict) {
          fail(
            "running-agent-cwd-unavailable",
            `cannot safely resolve running session '${agent.sessionId}' cwd: ${safeErrorMessage(error)}`
          );
        }
      }
    }
    return [...matches];
  }
  async assertNoRunningAtPath(target, state) {
    const blocked = await this.runningAtPath(target, state, true);
    if (blocked.length > 0) {
      fail("running-agent", `worktree contains running session cwd(s): ${blocked.join(", ")}`);
    }
  }
  containsPath(root, candidate) {
    const suffix = relative(root, candidate);
    return suffix === "" || !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
  }
  async anyWorkspaceOwnsPath(state, target) {
    for (const workspace of state.workspaces) {
      if (this.containsPath(target, resolve(workspace.path))) return true;
      let canonical;
      try {
        canonical = await this.existingPath(workspace.path);
      } catch (error) {
        fail(
          "workspace-path-unavailable",
          `cannot prove workspace '${workspace.workspaceId}' is unrelated to rollback target: ${safeErrorMessage(error)}`
        );
      }
      if (this.containsPath(target, canonical)) return true;
    }
    return false;
  }
  async assertNoOtherWorkspaceWithin(state, target, allowedWorkspaceId) {
    for (const workspace of state.workspaces) {
      if (workspace.workspaceId === allowedWorkspaceId) continue;
      let canonical;
      try {
        canonical = await this.existingPath(workspace.path);
      } catch {
        continue;
      }
      if (this.containsPath(target, canonical)) {
        fail("nested-workspace", `worktree contains workspace '${workspace.workspaceId}'`);
      }
    }
  }
  async existingPath(path) {
    if (path.length === 0 || path.length > MAX_PATH_LENGTH || /[\0\r\n]/u.test(path) || !isAbsolute(path)) {
      fail("unsafe-path", "filesystem path must be a bounded absolute path");
    }
    let canonical;
    try {
      canonical = await this.fs.realpath(path);
    } catch (error) {
      fail("path-unavailable", `cannot resolve '${path}': ${safeErrorMessage(error)}`);
    }
    if (canonical.length === 0 || canonical.length > MAX_PATH_LENGTH || /[\0\r\n]/u.test(canonical) || !isAbsolute(canonical)) {
      fail("unsafe-path", "realpath returned an invalid or overlong absolute path");
    }
    return resolve(canonical);
  }
  async assertPathAbsent(path) {
    try {
      await this.fs.lstat(path);
    } catch (error) {
      if (this.isNotFound(error)) return;
      fail("path-check-failed", `cannot inspect target path: ${safeErrorMessage(error)}`);
    }
    fail("target-exists", `target path '${path}' already exists`);
  }
  isNotFound(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }
  async discover(cwd) {
    const canonicalCwd = await this.existingPath(cwd);
    const [topLevelResult, commonResult] = await Promise.all([
      this.gitChecked(canonicalCwd, ["rev-parse", "--show-toplevel"]),
      this.gitChecked(canonicalCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ]);
    const topLevel = await this.existingPath(this.singleLine(topLevelResult.stdout, "worktree root"));
    const commonDir = await this.existingPath(this.singleLine(commonResult.stdout, "Git common directory"));
    return { commonDir, topLevel };
  }
  async snapshotDiscover(cwd, deadline) {
    if (this.now() >= deadline) {
      fail("snapshot-deadline", `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms Git probe budget`);
    }
    const canonicalCwd = await this.existingPath(cwd);
    const [topLevelResult, commonResult] = await Promise.all([
      this.snapshotGitChecked(canonicalCwd, ["rev-parse", "--show-toplevel"], deadline),
      this.snapshotGitChecked(
        canonicalCwd,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        deadline
      )
    ]);
    const topLevel = await this.existingPath(this.singleLine(topLevelResult.stdout, "worktree root", MAX_PATH_LENGTH));
    const commonDir = await this.existingPath(this.singleLine(
      commonResult.stdout,
      "Git common directory",
      MAX_PATH_LENGTH
    ));
    return { commonDir, topLevel };
  }
  async topology(cwd) {
    const discovered = await this.discover(cwd);
    const output = await this.gitChecked(discovered.topLevel, ["worktree", "list", "--porcelain", "-z"]);
    const parsed = parseWorktreePorcelain(output.stdout);
    const worktrees = [];
    const paths = /* @__PURE__ */ new Set();
    for (const entry of parsed) {
      const path = await this.existingPath(entry.path);
      if (paths.has(path)) fail("git-protocol-error", `Git returned duplicate worktree path '${path}'`);
      paths.add(path);
      worktrees.push({ ...entry, path });
    }
    if (worktrees[0].bare) fail("bare-repository", "bare repositories cannot own this lifecycle");
    if (!paths.has(discovered.topLevel)) fail("git-protocol-error", "Git omitted the current worktree from its topology");
    return { commonDir: discovered.commonDir, mainPath: worktrees[0].path, worktrees };
  }
  singleLine(output, label, maxLength = 4096) {
    const value = output.replace(/\r?\n$/u, "");
    if (value.length === 0 || value.length > maxLength || /[\r\n\0]/u.test(value)) {
      fail("git-protocol-error", `Git returned an invalid or overlong ${label}`);
    }
    return value;
  }
  async assertBranchFormat(cwd, branch) {
    const result = await this.gitCommand(cwd, ["check-ref-format", "--branch", branch]);
    if (result.exitCode !== 0) fail("invalid-branch", `Git rejected local branch '${branch}'`);
  }
  /** Local branch head, or null when the branch does not exist. Git versions
   *  disagree on the missing-ref exit code (`show-ref --verify` exits 1 in
   *  some, 128 with `fatal: ... not a valid ref` in others) — ANY non-zero
   *  exit means "branch absent" for this fixed invocation; a genuinely broken
   *  git would have failed the earlier rev-parse/worktree reads already.
   *  (2026-08 fix: exit 128 was misreported as a hard git-command-failed.) */
  async localBranchHead(cwd, branch) {
    const result = await this.gitCommand(cwd, ["show-ref", "--hash", "--verify", `refs/heads/${branch}`]);
    if (result.exitCode !== 0) return null;
    const head = this.singleLine(result.stdout, "local branch head").toLowerCase();
    if (!/^[0-9a-f]{40,64}$/u.test(head)) fail("git-protocol-error", "Git returned an invalid local branch head");
    return head;
  }
  async isDirty(path) {
    const result = await this.gitChecked(path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
    return result.stdout.length > 0;
  }
  async gitChecked(cwd, args, mutation = false) {
    const result = await this.gitCommand(cwd, args, mutation);
    if (result.exitCode !== 0) this.gitExitError(result, args[0] ?? "unknown");
    return result;
  }
  async snapshotGitChecked(cwd, args, deadline, perCommandLimit = READ_TIMEOUT_MS) {
    const remaining = deadline - this.now();
    if (remaining <= 0) {
      fail("snapshot-deadline", `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms Git probe budget`);
    }
    const result = await this.gitCommand(cwd, args, false, Math.max(1, Math.min(perCommandLimit, remaining)));
    if (result.exitCode !== 0) this.gitExitError(result, args[0] ?? "unknown");
    return result;
  }
  /** Local branch names for the existing-branch picker (`show-ref --heads`).
   *  A convenience read: any failure (git down, budget exhausted) yields an
   *  empty list and must never fail or stall the snapshot. */
  async listBranches(cwd, deadline) {
    if (this.now() >= deadline) return [];
    let result;
    try {
      result = await this.gitCommand(cwd, ["show-ref", "--heads"], false, READ_TIMEOUT_MS);
    } catch {
      return [];
    }
    if (result.exitCode !== 0) return [];
    const branches = [];
    for (const line of result.stdout.split("\n")) {
      const match = /^[0-9a-fA-F]{40,64}\s+refs\/heads\/(.+)$/u.exec(line);
      if (match !== null && match[1] !== "" && !match[1].startsWith("-")) branches.push(match[1]);
    }
    return branches;
  }
  async gitCommand(cwd, args, mutation = false, readTimeoutMs = READ_TIMEOUT_MS) {
    if (!isAbsolute(cwd)) fail("unsafe-git-cwd", "Git cwd must be absolute");
    assertSafeGitArgv(args);
    const maxOutputBytes = mutation ? MUTATION_OUTPUT_CAP : READ_OUTPUT_CAP;
    const result = await this.git({
      cwd,
      args: [...args],
      timeoutMs: mutation ? MUTATION_TIMEOUT_MS : readTimeoutMs,
      maxOutputBytes
    });
    if (!Number.isInteger(result.exitCode) || typeof result.stdout !== "string" || typeof result.stderr !== "string") {
      fail("git-runner-invalid", "Git runner returned an invalid result");
    }
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maxOutputBytes) {
      fail("git-output-limit", "Git runner exceeded the bounded response limit");
    }
    return result;
  }
  gitExitError(result, operation) {
    const detail = result.stderr.trim() || result.stdout.trim();
    fail("git-command-failed", `Git ${operation} failed with exit ${result.exitCode}${detail ? `: ${safeErrorMessage(detail)}` : ""}`);
  }
  uniquePreviewToken() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = previewToken(this.nextToken());
      if (!this.previews.has(token)) return token;
    }
    fail("token-collision", "could not allocate a unique preview token");
  }
  publicPreview(preview) {
    return {
      previewToken: preview.previewToken,
      expiresAt: preview.expiresAt,
      repoId: preview.repoId,
      commonDir: preview.commonDir,
      mainPath: preview.mainPath,
      targetPath: preview.targetPath,
      branch: preview.branch,
      baseHead: preview.baseHead
    };
  }
  evictOldestCreateOperationIfFull() {
    if (this.createOperations.size < this.operationCapacity) return;
    let oldest;
    for (const [id, record] of this.createOperations) {
      if (record.state !== "ready" || record.attemptedCreate || record.attemptedRollback || record.facts !== void 0 || record.createResult !== void 0 || record.rollbackResult !== void 0) continue;
      if (oldest === void 0 || record.updatedAt < oldest.updatedAt) {
        oldest = { id, updatedAt: record.updatedAt };
      }
    }
    if (oldest !== void 0) this.createOperations.delete(oldest.id);
  }
  evictOldestRemoveOperationIfFull() {
    if (this.removeOperations.size < this.operationCapacity) return;
    let oldest;
    for (const [id, record] of this.removeOperations) {
      if (record.state !== "ready" || record.attemptedRemove || record.intent !== void 0 || record.result !== void 0) continue;
      if (oldest === void 0 || record.updatedAt < oldest.updatedAt) {
        oldest = { id, updatedAt: record.updatedAt };
      }
    }
    if (oldest !== void 0) this.removeOperations.delete(oldest.id);
  }
  pruneCaches() {
    const now = this.now();
    for (const [token, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(token);
    }
    const terminalCutoff = now - OPERATION_TTL_MS;
    for (const [id, record] of this.createOperations) {
      if (record.state !== "creating" && record.state !== "rolling-back" && record.updatedAt <= terminalCutoff) {
        this.createOperations.delete(id);
      }
    }
    for (const [id, record] of this.removeOperations) {
      if (record.state !== "removing" && record.updatedAt <= terminalCutoff) {
        this.removeOperations.delete(id);
      }
    }
  }
};

// src/index.ts
var _remove_dec, _rollbackCreate_dec, _create_dec, _previewCreate_dec, _snapshot_dec, _a, _init;
var GitWorktreeGateway = class extends (_a = TypertRemoteService, _snapshot_dec = [Remote("snapshot")], _previewCreate_dec = [Remote("previewCreate")], _create_dec = [Remote("create")], _rollbackCreate_dec = [Remote("rollbackCreate")], _remove_dec = [Remote("remove")], _a) {
  constructor(ctx) {
    super(ctx, "gitWorktree");
    __runInitializers(_init, 5, this);
    __publicField(this, "core");
    const host = ctx;
    this.core = new GitWorktreeCore({
      source: {
        listWorkspaces: () => host.workspaceRegistry.list().map((workspace) => ({
          workspaceId: String(workspace.id),
          path: workspace.path,
          sessionIds: workspace.sessionIds.map(String)
        })),
        // Agent-registry membership is live state; status narrows the
        // destructive guard to active drivers, while cwd also covers
        // ungrouped sessions and subagents below a worktree.
        listAgents: () => host.agents.list().map((agent) => ({
          sessionId: String(agent.id),
          status: agent.status,
          ...agent.session.header.cwd === void 0 ? {} : { cwd: agent.session.header.cwd }
        }))
      }
    });
  }
  snapshot() {
    return domainResult(() => this.core.snapshot());
  }
  previewCreate(input) {
    return domainResult(() => this.core.previewCreate(input));
  }
  create(input) {
    return domainResult(() => this.core.create(input));
  }
  rollbackCreate(input) {
    return domainResult(() => this.core.rollbackCreate(input));
  }
  remove(input) {
    return domainResult(() => this.core.remove(input));
  }
};
_init = __decoratorStart(_a);
__decorateElement(_init, 1, "snapshot", _snapshot_dec, GitWorktreeGateway);
__decorateElement(_init, 1, "previewCreate", _previewCreate_dec, GitWorktreeGateway);
__decorateElement(_init, 1, "create", _create_dec, GitWorktreeGateway);
__decorateElement(_init, 1, "rollbackCreate", _rollbackCreate_dec, GitWorktreeGateway);
__decorateElement(_init, 1, "remove", _remove_dec, GitWorktreeGateway);
__decoratorMetadata(_init, GitWorktreeGateway);
__publicField(GitWorktreeGateway, "inject", ["workspaceRegistry", "agents"]);
var index_default = GitWorktreeGateway;
export {
  GitWorktreeCore,
  GitWorktreeError,
  GitWorktreeGateway,
  MAX_OPERATIONS,
  MAX_REPOSITORIES,
  MAX_TOTAL_SESSION_MEMBERSHIPS,
  MAX_TOTAL_WORKTREES,
  MAX_WORKSPACES,
  MAX_WORKTREES_PER_REPOSITORY,
  OPERATION_TTL_MS,
  PREVIEW_TTL_MS,
  SNAPSHOT_DEADLINE_MS,
  SNAPSHOT_WALL_TIMEOUT_MS,
  assertSafeGitArgv,
  createLocalGitRunner,
  index_default as default,
  domainResult,
  parseBranchLine
};
