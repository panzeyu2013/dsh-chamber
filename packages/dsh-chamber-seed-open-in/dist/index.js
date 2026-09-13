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
import { stat as stat3 } from "node:fs/promises";
import { isAbsolute as isAbsolute3 } from "node:path";

// src/catalog.ts
var PATH_TOKEN = "{path}";
function macApp(...fsNames) {
  return { locators: [{ kind: "app", fsNames }] };
}
function spec(...locators) {
  return { locators };
}
function desktopSpec(desktopId, ...locators) {
  return { locators, desktopId };
}
function cli(name, ...args) {
  return { kind: "cli", name, args };
}
function desktopCli(name, ...args) {
  return { kind: "cli", name, args, requiresDesktop: true };
}
function file(candidates, ...args) {
  return { kind: "file", candidates, args };
}
function appPaths(exe, ...args) {
  return { kind: "app-paths", exe, args };
}
function installRecord(displayNamePrefix, relativeLauncher, ...args) {
  return { kind: "install-record", displayNamePrefix, relativeLauncher, args };
}
function jetBrains(id, productName, cliName, winExe, macNames) {
  return {
    id,
    platforms: {
      darwin: macApp(...macNames),
      win32: spec(
        {
          kind: "scan",
          root: "${ProgramFiles}/JetBrains",
          namePrefix: productName,
          relativeLauncher: `bin/${winExe}`,
          args: []
        },
        installRecord(productName, `bin/${winExe}`)
      ),
      linux: spec(cli(cliName), file([`~/.local/share/JetBrains/Toolbox/scripts/${cliName}`]))
    }
  };
}
var OPEN_IN_APP_CATALOG = [
  {
    id: "finder",
    platforms: {
      darwin: spec({
        kind: "fixed",
        launch: { kind: "shell-open" },
        iconPath: "/System/Library/CoreServices/Finder.app"
      })
    }
  },
  {
    id: "explorer",
    platforms: {
      win32: spec({
        kind: "fixed",
        launch: { kind: "shell-open" },
        iconPath: "${SystemRoot}/explorer.exe"
      })
    }
  },
  { id: "filemanager", platforms: { linux: spec(desktopCli("xdg-open")) } },
  {
    id: "cursor",
    platforms: {
      darwin: macApp("Cursor.app"),
      win32: spec(
        appPaths("Cursor.exe"),
        installRecord("Cursor"),
        file(["${LOCALAPPDATA}/Programs/cursor/Cursor.exe"])
      ),
      linux: spec(cli("cursor"))
    }
  },
  {
    id: "vscode",
    platforms: {
      darwin: macApp("Visual Studio Code.app"),
      win32: spec(
        appPaths("Code.exe"),
        installRecord("Microsoft Visual Studio Code", "Code.exe"),
        file([
          "${LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe",
          "${ProgramFiles}/Microsoft VS Code/Code.exe"
        ])
      ),
      linux: desktopSpec("code", cli("code"))
    }
  },
  {
    id: "vscodeinsiders",
    platforms: {
      darwin: macApp("Visual Studio Code - Insiders.app"),
      win32: spec(
        appPaths("Code - Insiders.exe"),
        installRecord("Microsoft Visual Studio Code Insiders", "Code - Insiders.exe"),
        file(["${LOCALAPPDATA}/Programs/Microsoft VS Code Insiders/Code - Insiders.exe"])
      ),
      linux: desktopSpec("code-insiders", cli("code-insiders"))
    }
  },
  {
    id: "windsurf",
    platforms: {
      darwin: macApp("Windsurf.app"),
      win32: spec(
        appPaths("Windsurf.exe"),
        installRecord("Windsurf"),
        file(["${LOCALAPPDATA}/Programs/Windsurf/Windsurf.exe"])
      ),
      linux: spec(cli("windsurf"))
    }
  },
  {
    id: "zed",
    platforms: {
      darwin: macApp("Zed.app", "Zed Preview.app"),
      linux: desktopSpec("dev.zed.Zed", cli("zed"), { kind: "desktop", desktopId: "dev.zed.Zed", args: [] })
    }
  },
  {
    id: "sublimetext",
    platforms: {
      darwin: macApp("Sublime Text.app"),
      win32: spec(
        appPaths("sublime_text.exe"),
        installRecord("Sublime Text"),
        file(["${ProgramFiles}/Sublime Text/sublime_text.exe"])
      ),
      linux: desktopSpec("sublime_text", cli("subl"))
    }
  },
  { id: "xcode", platforms: { darwin: spec({ kind: "xcode" }) } },
  {
    id: "androidstudio",
    platforms: {
      darwin: macApp("Android Studio.app"),
      win32: spec(
        installRecord("Android Studio", "bin/studio64.exe"),
        file(["${ProgramFiles}/Android/Android Studio/bin/studio64.exe"])
      ),
      linux: spec(cli("studio"), file([
        "~/.local/share/JetBrains/Toolbox/scripts/studio",
        "/opt/android-studio/bin/studio.sh"
      ]))
    }
  },
  jetBrains(
    "intellij",
    "IntelliJ IDEA",
    "idea",
    "idea64.exe",
    ["IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app", "IntelliJ IDEA CE.app"]
  ),
  jetBrains(
    "pycharm",
    "PyCharm",
    "pycharm",
    "pycharm64.exe",
    ["PyCharm.app", "PyCharm Professional.app", "PyCharm CE.app", "PyCharm Community.app"]
  ),
  jetBrains("webstorm", "WebStorm", "webstorm", "webstorm64.exe", ["WebStorm.app"]),
  jetBrains("phpstorm", "PhpStorm", "phpstorm", "phpstorm64.exe", ["PhpStorm.app"]),
  jetBrains("goland", "GoLand", "goland", "goland64.exe", ["GoLand.app"]),
  jetBrains("rider", "Rider", "rider", "rider64.exe", ["Rider.app", "JetBrains Rider.app"]),
  jetBrains("rustrover", "RustRover", "rustrover", "rustrover64.exe", ["RustRover.app"]),
  {
    id: "fork",
    platforms: {
      darwin: macApp("Fork.app"),
      win32: spec(installRecord("Fork"), file(["${LOCALAPPDATA}/Fork/Fork.exe"]))
    }
  },
  { id: "sourcetree", platforms: { darwin: macApp("Sourcetree.app") } },
  {
    id: "github",
    platforms: {
      darwin: macApp("GitHub Desktop.app"),
      win32: spec({ kind: "github-desktop", root: "${LOCALAPPDATA}/GitHubDesktop" })
    }
  },
  { id: "tower", platforms: { darwin: macApp("Tower.app") } },
  { id: "gitkraken", platforms: { darwin: macApp("GitKraken.app") } },
  { id: "smartgit", platforms: { darwin: macApp("SmartGit.app") } },
  {
    id: "sublimemerge",
    platforms: {
      darwin: macApp("Sublime Merge.app"),
      win32: spec(
        appPaths("sublime_merge.exe"),
        installRecord("Sublime Merge"),
        file(["${ProgramFiles}/Sublime Merge/sublime_merge.exe"])
      ),
      linux: desktopSpec("sublime_merge", cli("smerge"))
    }
  },
  {
    id: "ghostty",
    platforms: {
      darwin: macApp("Ghostty.app"),
      linux: desktopSpec(
        "com.mitchellh.ghostty",
        cli("ghostty", `--working-directory=${PATH_TOKEN}`),
        { kind: "desktop", desktopId: "com.mitchellh.ghostty", args: [`--working-directory=${PATH_TOKEN}`] }
      )
    }
  },
  { id: "warp", platforms: { darwin: macApp("Warp.app") } },
  { id: "iterm", platforms: { darwin: macApp("iTerm.app") } },
  {
    id: "kitty",
    platforms: {
      darwin: macApp("kitty.app"),
      linux: desktopSpec(
        "kitty",
        cli("kitty", "--directory"),
        { kind: "desktop", desktopId: "kitty", args: ["--directory"] }
      )
    }
  },
  {
    id: "terminal",
    platforms: {
      darwin: spec({
        kind: "fixed",
        launch: { kind: "argv", command: "open", args: ["-a", "Terminal"] },
        iconPath: "/System/Applications/Utilities/Terminal.app"
      })
    }
  },
  { id: "windowsterminal", platforms: { win32: spec(cli("wt", "-d")) } },
  {
    id: "gitbash",
    platforms: {
      win32: spec(
        // Git for Windows registers as "Git version <x.y.z>"; the bare "Git"
        // prefix would also match "GitHub Desktop".
        installRecord("Git version", "git-bash.exe", `--cd=${PATH_TOKEN}`),
        file(["${ProgramFiles}/Git/git-bash.exe"], `--cd=${PATH_TOKEN}`)
      )
    }
  },
  {
    id: "gnometerminal",
    platforms: {
      linux: desktopSpec(
        "org.gnome.Terminal",
        cli("gnome-terminal", `--working-directory=${PATH_TOKEN}`),
        { kind: "desktop", desktopId: "org.gnome.Terminal", args: [`--working-directory=${PATH_TOKEN}`] }
      )
    }
  },
  {
    id: "konsole",
    platforms: {
      linux: desktopSpec(
        "org.kde.konsole",
        cli("konsole", "--workdir"),
        { kind: "desktop", desktopId: "org.kde.konsole", args: ["--workdir"] }
      )
    }
  }
];

// src/icons.ts
import { mkdtemp, readdir as readdir2, readFile as readFile2, rm, stat as stat2, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute as isAbsolute2, join as join2 } from "node:path";

// src/resolver.ts
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  canOpenNativePath,
  openNativePath,
  runNativeCommand
} from "@deepseek-ai/dsh-native-command";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
var launchDetachedApp = (command, args, options) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: options.windowsHide,
    env: { ...scrubbedParentEnv(), ...options.env }
  });
  let settled = false;
  const settle = (outcome) => {
    if (settled) return;
    settled = true;
    clearTimeout(watch);
    child.unref();
    outcome();
  };
  const watch = setTimeout(() => {
    settle(resolve);
  }, options.watchMs);
  child.on("error", (error) => {
    settle(() => {
      reject(error);
    });
  });
  child.on("exit", (code, signalName) => {
    if (code === 0) settle(resolve);
    else settle(() => {
      reject(new Error(`launcher exited with code ${String(code)}, signal ${String(signalName)}`));
    });
  });
});
function resolveInternals(internals) {
  const home = internals.home ?? homedir();
  const resolveExecutable = internals.resolveExecutable;
  if (resolveExecutable === void 0) {
    throw new Error("open-in-app: internals.resolveExecutable is required (the subprocess capability provides it)");
  }
  return {
    platform: internals.platform ?? osPlatform(),
    ssh: internals.ssh ?? false,
    applicationRoots: internals.applicationRoots ?? ["/Applications", join(home, "Applications")],
    env: internals.env ?? process.env,
    home,
    run: internals.run ?? runNativeCommand,
    launch: internals.launch ?? launchDetachedApp,
    resolveExecutable
  };
}
function assertNever(value) {
  throw new Error(`unhandled open-in-app catalog kind: ${JSON.stringify(value)}`);
}
async function output(command, args, timeoutMs, internals) {
  try {
    const { stdout } = await internals.run(command, args, AbortSignal.timeout(timeoutMs));
    return stdout;
  } catch {
    return null;
  }
}
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
function expandCandidate(template, internals) {
  const unset = [];
  const expanded = template.replace(/\$\{([^}]+)\}/g, (token, name) => {
    const value = internals.env[name];
    if (value === void 0) unset.push(name);
    return value ?? token;
  });
  if (unset.length > 0) return null;
  return expanded.startsWith("~/") ? join(internals.home, expanded.slice(2)) : expanded;
}
function expandRegistryValue(value, internals) {
  const unset = [];
  const expanded = value.replace(/%([^%]+)%/g, (token, name) => {
    const found = internals.env[name];
    if (found === void 0) unset.push(name);
    return found ?? token;
  });
  return unset.length > 0 ? null : expanded;
}
var APP_PATHS_ROOTS = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths"
];
var UNINSTALL_ROOTS = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
];
function parseRegistryDump(dump) {
  const keys = /* @__PURE__ */ new Map();
  let current;
  for (const line of dump.split(/\r?\n/)) {
    if (/^HK/.test(line)) {
      current = /* @__PURE__ */ new Map();
      keys.set(line.trim(), current);
      continue;
    }
    const value = /^\s+(.*?)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line);
    if (value === null || current === void 0) continue;
    const [name, data] = [value[1], value[3]];
    current.set(/^\(.*\)$/.test(name) ? "(Default)" : name, data.trim());
  }
  return keys;
}
async function readWindowsRegistryView(timeoutMs, internals) {
  const appPaths2 = /* @__PURE__ */ new Map();
  const installRecords = [];
  for (const root of APP_PATHS_ROOTS) {
    const dump = await output("reg.exe", ["query", root, "/s"], timeoutMs, internals);
    if (dump === null) continue;
    for (const [key, values] of parseRegistryDump(dump)) {
      const exe = key.slice(key.lastIndexOf("\\") + 1).toLowerCase();
      const target = values.get("(Default)");
      if (!exe.endsWith(".exe") || target === void 0 || appPaths2.has(exe)) continue;
      const expanded = expandRegistryValue(target.replace(/^"|"$/g, ""), internals);
      if (expanded !== null) appPaths2.set(exe, expanded);
    }
  }
  for (const root of UNINSTALL_ROOTS) {
    const dump = await output("reg.exe", ["query", root, "/s"], timeoutMs, internals);
    if (dump === null) continue;
    for (const values of parseRegistryDump(dump).values()) {
      const displayName = values.get("DisplayName");
      if (displayName === void 0) continue;
      installRecords.push({
        displayName,
        installLocation: values.get("InstallLocation"),
        displayIcon: values.get("DisplayIcon")
      });
    }
  }
  return { appPaths: appPaths2, installRecords };
}
var RegistryViewOnce = class {
  constructor(timeoutMs, internals) {
    this.timeoutMs = timeoutMs;
    this.internals = internals;
  }
  view;
  /** The pass's registry view, read on first use. */
  read() {
    this.view ??= readWindowsRegistryView(this.timeoutMs, this.internals);
    return this.view;
  }
};
async function recordLauncher(record, relativeLauncher, internals) {
  if (relativeLauncher !== void 0 && record.installLocation !== void 0 && record.installLocation !== "") {
    const expanded = expandRegistryValue(record.installLocation.replace(/^"|"$/g, ""), internals);
    if (expanded !== null) {
      const candidate = join(expanded, relativeLauncher);
      if (await isFile(candidate)) return candidate;
    }
  }
  if (record.displayIcon !== void 0) {
    const bare = record.displayIcon.replace(/,-?\d+$/, "").replace(/^"|"$/g, "").trim();
    const expanded = expandRegistryValue(bare, internals);
    if (expanded !== null && expanded.toLowerCase().endsWith(".exe") && await isFile(expanded)) return expanded;
  }
  return null;
}
function parseDesktopEntry(text) {
  let inEntry = false;
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inEntry = trimmed === "[Desktop Entry]";
      continue;
    }
    if (!inEntry) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key === "Exec") fields.exec = value;
    else if (key === "TryExec") fields.tryExec = value;
    else if (key === "Icon") fields.icon = value;
  }
  return fields;
}
function xdgDataDirectories(internals) {
  const dataHome = internals.env["XDG_DATA_HOME"] ?? join(internals.home, ".local", "share");
  const dataDirs = internals.env["XDG_DATA_DIRS"] ?? "/usr/local/share:/usr/share";
  return [dataHome, ...dataDirs.split(":").filter((dir) => dir !== "")];
}
async function findDesktopEntry(desktopId, internals) {
  for (const dataDir of xdgDataDirectories(internals)) {
    const path = join(dataDir, "applications", `${desktopId}.desktop`);
    try {
      return parseDesktopEntry(await readFile(path, "utf8"));
    } catch {
    }
  }
  return null;
}
async function desktopLauncher(entry, internals) {
  const candidate = entry.tryExec ?? execCommand(entry.exec);
  if (candidate === null || candidate === "") return null;
  if (isAbsolute(candidate)) return await isFile(candidate) ? candidate : null;
  return internals.resolveExecutable(candidate);
}
function execCommand(exec) {
  if (exec === void 0) return null;
  const quoted = /^"([^"]+)"/.exec(exec);
  if (quoted?.[1] !== void 0) return quoted[1];
  const bare = /^\S+/.exec(exec);
  return bare === null ? null : bare[0];
}
function specFor(app, platform) {
  return platform === "darwin" || platform === "win32" || platform === "linux" ? app.platforms[platform] : void 0;
}
function executableIcon(path, internals) {
  return internals.platform === "win32" ? { kind: "executable", path } : void 0;
}
async function locate(locator, probeTimeoutMs, registry, internals) {
  switch (locator.kind) {
    case "fixed": {
      const iconPath = expandCandidate(locator.iconPath, internals);
      const icon = iconPath === null ? void 0 : internals.platform === "win32" ? { kind: "executable", path: iconPath } : { kind: "app-bundle", path: iconPath };
      return { launch: locator.launch, icon };
    }
    case "app": {
      for (const root of internals.applicationRoots) {
        for (const fsName of locator.fsNames) {
          const bundle = join(root, fsName);
          if (await isDirectory(bundle)) {
            return {
              launch: { kind: "argv", command: "open", args: ["-a", bundle] },
              icon: { kind: "app-bundle", path: bundle }
            };
          }
        }
      }
      return null;
    }
    case "xcode": {
      const developer = await output("xcode-select", ["-p"], probeTimeoutMs, internals);
      if (developer === null) return null;
      const bundle = dirname(dirname(developer.trim()));
      if (!bundle.endsWith(".app") || !await isDirectory(bundle)) return null;
      return {
        launch: { kind: "argv", command: "xed", args: [] },
        fallbackLaunch: { kind: "argv", command: "open", args: ["-a", bundle] },
        icon: { kind: "app-bundle", path: bundle }
      };
    }
    case "cli": {
      if (locator.requiresDesktop === true && !canOpenNativePath({
        platform: internals.platform,
        env: { ...internals.env }
      })) return null;
      const found = await internals.resolveExecutable(locator.name);
      return found === null ? null : { launch: { kind: "argv", command: found, args: locator.args }, icon: executableIcon(found, internals) };
    }
    case "file": {
      for (const candidate of locator.candidates) {
        const path = expandCandidate(candidate, internals);
        if (path !== null && await isFile(path)) {
          return { launch: { kind: "argv", command: path, args: locator.args }, icon: executableIcon(path, internals) };
        }
      }
      return null;
    }
    case "scan": {
      const root = expandCandidate(locator.root, internals);
      if (root === null) return null;
      let entries;
      try {
        entries = await readdir(root);
      } catch {
        return null;
      }
      const versions = entries.filter((entry) => entry.startsWith(locator.namePrefix)).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
      for (const version of versions) {
        const launcher = join(root, version, locator.relativeLauncher);
        if (await isFile(launcher)) {
          return { launch: { kind: "argv", command: launcher, args: locator.args }, icon: executableIcon(launcher, internals) };
        }
      }
      return null;
    }
    case "app-paths": {
      const target = (await registry.read()).appPaths.get(locator.exe.toLowerCase());
      if (target === void 0 || !await isFile(target)) return null;
      return { launch: { kind: "argv", command: target, args: locator.args }, icon: { kind: "executable", path: target } };
    }
    case "install-record": {
      for (const record of (await registry.read()).installRecords) {
        if (!record.displayName.startsWith(locator.displayNamePrefix)) continue;
        const launcher = await recordLauncher(record, locator.relativeLauncher, internals);
        if (launcher !== null) {
          return { launch: { kind: "argv", command: launcher, args: locator.args }, icon: { kind: "executable", path: launcher } };
        }
      }
      return null;
    }
    case "github-desktop": {
      const root = expandCandidate(locator.root, internals);
      if (root === null) return null;
      let versions;
      try {
        versions = (await readdir(root)).filter((entry) => entry.startsWith("app-")).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
      } catch {
        return null;
      }
      for (const version of versions) {
        const directory = join(root, version);
        const executable = join(directory, "GitHubDesktop.exe");
        const cli2 = join(directory, "resources", "app", "cli.js");
        if (await isFile(executable) && await isFile(cli2)) {
          return {
            launch: {
              kind: "argv",
              command: executable,
              args: [cli2, "open"],
              env: { ELECTRON_RUN_AS_NODE: "1" },
              windowsHide: true
            },
            icon: { kind: "executable", path: executable }
          };
        }
      }
      return null;
    }
    case "desktop": {
      const entry = await findDesktopEntry(locator.desktopId, internals);
      if (entry === null) return null;
      const launcher = await desktopLauncher(entry, internals);
      return launcher === null ? null : { launch: { kind: "argv", command: launcher, args: locator.args } };
    }
    /* v8 ignore next -- closed locator union */
    default:
      return assertNever(locator);
  }
}
async function resolveLaunch(app, probeTimeoutMs, internals = {}) {
  const resolved = resolveInternals(internals);
  if (resolved.ssh) return null;
  return resolveWithRegistry(app, probeTimeoutMs, new RegistryViewOnce(probeTimeoutMs, resolved), resolved);
}
async function resolveWithRegistry(app, probeTimeoutMs, registry, internals) {
  const platformSpec = specFor(app, internals.platform);
  if (platformSpec === void 0) return null;
  for (const locator of platformSpec.locators) {
    const found = await locate(locator, probeTimeoutMs, registry, internals);
    if (found !== null) return found;
  }
  return null;
}
async function resolveOpenInAppApps(probeTimeoutMs, internals = {}) {
  const resolved = resolveInternals(internals);
  if (resolved.ssh) {
    return /* @__PURE__ */ new Map();
  }
  const registry = new RegistryViewOnce(probeTimeoutMs, resolved);
  const entries = await Promise.all(OPEN_IN_APP_CATALOG.map(async (app) => [app.id, await resolveWithRegistry(app, probeTimeoutMs, registry, resolved)]));
  const map = /* @__PURE__ */ new Map();
  for (const [id, launch] of entries) {
    if (launch !== null) map.set(id, launch);
  }
  return map;
}
function launchArgs(args, path) {
  return args.some((arg) => arg.includes(PATH_TOKEN)) ? args.map((arg) => arg.replaceAll(PATH_TOKEN, path)) : [...args, path];
}
function isMissingExecutable(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function runShellOpen(path, watchMs, internals) {
  const opening = openNativePath(path, new AbortController().signal, {
    platform: internals.platform,
    run: internals.run,
    env: internals.env
  });
  return new Promise((resolve) => {
    const watch = setTimeout(() => {
      opening.catch(() => {
      });
      resolve("launched");
    }, watchMs);
    opening.then(
      () => {
        clearTimeout(watch);
        resolve("launched");
      },
      (error) => {
        clearTimeout(watch);
        resolve(isMissingExecutable(error) ? "missing" : "failed");
      }
    );
  });
}
async function runLaunch(launch, path, watchMs, internals) {
  switch (launch.kind) {
    case "shell-open":
      return runShellOpen(path, watchMs, internals);
    case "argv":
      try {
        await internals.launch(launch.command, launchArgs(launch.args, path), {
          watchMs,
          ...launch.env === void 0 ? {} : { env: launch.env },
          ...launch.windowsHide === void 0 ? {} : { windowsHide: launch.windowsHide }
        });
        return "launched";
      } catch (error) {
        return isMissingExecutable(error) ? "missing" : "failed";
      }
    /* v8 ignore next -- closed launch union */
    default:
      return assertNever(launch);
  }
}
async function launchResolved(resolved, path, watchMs, internals = {}) {
  const completed = resolveInternals(internals);
  const primary = await runLaunch(resolved.launch, path, watchMs, completed);
  if (primary === "launched" || resolved.fallbackLaunch === void 0) return primary;
  const fallback = await runLaunch(resolved.fallbackLaunch, path, watchMs, completed);
  if (fallback === "launched") return "launched";
  return primary === "missing" || fallback === "missing" ? "missing" : "failed";
}

// src/icons.ts
async function extractBundleIconPng(bundlePath, timeoutMs, internals) {
  const resources = join2(bundlePath, "Contents", "Resources");
  let iconFile = null;
  const plistJson = await output(
    "plutil",
    ["-convert", "json", "-o", "-", join2(bundlePath, "Contents", "Info.plist")],
    timeoutMs,
    internals
  );
  if (plistJson !== null) {
    try {
      const declared = JSON.parse(plistJson).CFBundleIconFile;
      if (typeof declared === "string" && declared !== "") {
        iconFile = declared.endsWith(".icns") ? declared : `${declared}.icns`;
      }
    } catch {
    }
  }
  if (iconFile === null) {
    try {
      iconFile = (await readdir2(resources)).find((entry) => entry.endsWith(".icns")) ?? null;
    } catch {
      return null;
    }
  }
  if (iconFile === null) return null;
  const icns = join2(resources, iconFile);
  try {
    await stat2(icns);
  } catch {
    return null;
  }
  const workDir = await mkdtemp(join2(tmpdir(), "dsh-open-in-app-"));
  try {
    const outPng = join2(workDir, "icon.png");
    if (await output("sips", ["-s", "format", "png", "-Z", "128", icns, "--out", outPng], timeoutMs, internals) === null) {
      return null;
    }
    try {
      return await readFile2(outPng);
    } catch {
      return null;
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
var EXTRACT_ICON_PS1 = [
  "param([string]$Source, [string]$Target)",
  '$ErrorActionPreference = "Stop"',
  "Add-Type -AssemblyName System.Drawing",
  "$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Source)",
  "if ($null -eq $icon) { exit 1 }",
  "$bitmap = $icon.ToBitmap()",
  "$bitmap.Save($Target, [System.Drawing.Imaging.ImageFormat]::Png)",
  ""
].join("\n");
async function extractExecutableIconPng(executablePath, timeoutMs, internals) {
  const workDir = await mkdtemp(join2(tmpdir(), "dsh-open-in-app-"));
  try {
    const script = join2(workDir, "extract-icon.ps1");
    const outPng = join2(workDir, "icon.png");
    await writeFile(script, EXTRACT_ICON_PS1, "utf8");
    const ran = await output("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      executablePath,
      outPng
    ], timeoutMs, internals);
    if (ran === null) return null;
    try {
      return await readFile2(outPng);
    } catch {
      return null;
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
var HICOLOR_SIZES = ["512x512", "256x256", "128x128", "64x64", "48x48", "32x32"];
function iconContentType(path) {
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return null;
}
async function readIconFile(path) {
  const contentType = iconContentType(path);
  if (contentType === null || !await isFile(path)) return null;
  return { bytes: await readFile2(path), contentType };
}
async function findLinuxThemeIcon(name, dataDirs) {
  for (const dataDir of dataDirs) {
    for (const size of HICOLOR_SIZES) {
      for (const extension of ["png", "svg"]) {
        const icon = await readIconFile(join2(dataDir, "icons", "hicolor", size, "apps", `${name}.${extension}`));
        if (icon !== null) return icon;
      }
    }
    const scalable = await readIconFile(join2(dataDir, "icons", "hicolor", "scalable", "apps", `${name}.svg`));
    if (scalable !== null) return scalable;
    for (const extension of ["png", "svg"]) {
      const pixmap = await readIconFile(join2(dataDir, "pixmaps", `${name}.${extension}`));
      if (pixmap !== null) return pixmap;
    }
  }
  return null;
}
async function extractLinuxIcon(desktopId, internals) {
  const entry = await findDesktopEntry(desktopId, internals);
  const icon = entry?.icon;
  if (icon === void 0 || icon === "") return null;
  if (isAbsolute2(icon)) return readIconFile(icon);
  return findLinuxThemeIcon(icon, xdgDataDirectories(internals));
}
async function extractAppIcon(app, resolved, timeoutMs, internals = {}) {
  const completed = resolveInternals(internals);
  if (completed.platform === "linux") {
    const desktopId = specFor(app, completed.platform)?.desktopId;
    return desktopId === void 0 ? null : extractLinuxIcon(desktopId, completed);
  }
  if (resolved.icon === void 0) return null;
  if (resolved.icon.kind === "app-bundle") {
    const bytes2 = await extractBundleIconPng(resolved.icon.path, timeoutMs, completed);
    return bytes2 === null ? null : { bytes: bytes2, contentType: "image/png" };
  }
  const bytes = await extractExecutableIconPng(resolved.icon.path, timeoutMs, completed);
  return bytes === null ? null : { bytes, contentType: "image/png" };
}

// src/core.ts
var OPEN_IN_APP_PROBE_TIMEOUT_MS = 1e4;
var OPEN_IN_APP_ICON_TIMEOUT_MS = 1e4;
var OPEN_IN_APP_LAUNCH_WATCH_MS = 1e3;
var OpenInAppError = class extends Error {
  code;
  retryable;
  constructor(code, message, retryable = false) {
    super(message);
    this.name = "OpenInAppError";
    this.code = code;
    this.retryable = retryable;
  }
};
async function domainResult(operation) {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (!(error instanceof OpenInAppError)) throw error;
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...error.retryable ? { retryable: true } : {}
      }
    };
  }
}
var OpenInAppCore = class {
  options;
  probeTimeoutMs;
  iconTimeoutMs;
  launchWatchMs;
  /** Lazy once-per-plugin-life resolution; the map is the mutable authority. */
  resolutions;
  /** Per-app icon promise cache (null = resolved as unavailable). */
  icons = /* @__PURE__ */ new Map();
  constructor(options) {
    this.options = options;
    this.probeTimeoutMs = options.probeTimeoutMs ?? OPEN_IN_APP_PROBE_TIMEOUT_MS;
    this.iconTimeoutMs = options.iconTimeoutMs ?? OPEN_IN_APP_ICON_TIMEOUT_MS;
    this.launchWatchMs = options.launchWatchMs ?? OPEN_IN_APP_LAUNCH_WATCH_MS;
  }
  /**
   * The cheap activation answer: platform plus protocol, no detection at all.
   * @returns the probe value.
   */
  probe() {
    return { platform: String(this.internals().platform ?? this.options.host.platform) };
  }
  /**
   * Catalog ids probed as installed on this host, in menu order.
   * @returns the apps value.
   */
  async apps() {
    return { apps: [...(await this.availability()).keys()] };
  }
  /**
   * One application's real bundle icon, base64-encoded.
   * @param app - catalog id (untrusted wire input).
   * @returns the icon value.
   */
  async icon(app) {
    const entry = this.catalogEntry(app);
    const resolved = (await this.availability()).get(entry.id);
    if (resolved === void 0) {
      throw new OpenInAppError("unavailable-app", `${entry.id} is not installed on this host`);
    }
    const icon = await this.iconOf(entry, resolved);
    if (icon === null) {
      throw new OpenInAppError("icon-unavailable", `no icon for ${entry.id}`);
    }
    return { mime: icon.contentType, dataBase64: icon.bytes.toString("base64") };
  }
  /**
   * Launch one installed application on one absolute directory.
   * @param app - catalog id (untrusted wire input).
   * @param path - absolute directory (untrusted wire input).
   * @returns after the host acknowledged the launch.
   */
  async open(app, path) {
    const entry = this.catalogEntry(app);
    const resolved = (await this.availability()).get(entry.id);
    if (resolved === void 0) {
      throw new OpenInAppError("unavailable-app", `${entry.id} is not installed on this host`);
    }
    if (typeof path !== "string" || path === "" || !isAbsolute3(path)) {
      throw new OpenInAppError("invalid-path", "path must be an absolute directory path");
    }
    let directory;
    try {
      directory = (await stat3(path)).isDirectory();
    } catch {
      directory = false;
    }
    if (!directory) {
      throw new OpenInAppError("directory-missing", `directory does not exist: ${path}`);
    }
    let outcome = await launchResolved(resolved, path, this.launchWatchMs, this.internals());
    if (outcome === "missing") {
      const fresh = await this.refreshResolution(entry);
      outcome = fresh === void 0 ? "failed" : await launchResolved(fresh, path, this.launchWatchMs, this.internals());
    }
    if (outcome !== "launched") {
      throw new OpenInAppError("launch-failed", `failed to launch ${entry.id}`, true);
    }
  }
  /** Resolve one catalog id at the wire, before any host work happens. */
  catalogEntry(app) {
    const id = typeof app === "string" ? app : "";
    const entry = OPEN_IN_APP_CATALOG.find((candidate) => candidate.id === id);
    if (entry === void 0) {
      throw new OpenInAppError("unknown-app", `unknown open-in application: ${JSON.stringify(app)}`);
    }
    return entry;
  }
  /** The internals every resolver call receives (host facts first, seams last). */
  internals() {
    return {
      platform: this.options.host.platform,
      resolveExecutable: (name) => this.options.host.resolveExecutable(name),
      ...this.options.internals
    };
  }
  /** Lazy once-per-plugin-life catalog resolution. */
  availability() {
    return this.resolutions ??= resolveOpenInAppApps(this.probeTimeoutMs, this.internals());
  }
  /** Per-app icon promise cache (null = resolved as unavailable). */
  iconOf(app, resolved) {
    let cached = this.icons.get(app.id);
    if (cached === void 0) {
      cached = extractAppIcon(app, resolved, this.iconTimeoutMs, this.internals());
      this.icons.set(app.id, cached);
    }
    return cached;
  }
  /**
   * Replace one stale resolution after a missing-executable launch: the entry
   * (and its icon) re-resolves once; an entry that no longer resolves leaves
   * the map and the next apps read no longer offers it.
   */
  async refreshResolution(app) {
    const map = await this.availability();
    const fresh = await resolveLaunch(app, this.probeTimeoutMs, this.internals());
    this.icons.delete(app.id);
    if (fresh === null) {
      map.delete(app.id);
      return void 0;
    }
    map.set(app.id, fresh);
    return fresh;
  }
};

// src/shared.ts
var OPEN_IN_APP_REMOTE_NAMESPACE = "openInApp";
var OPEN_IN_APP_METHODS = ["probe", "apps", "icon", "open"];
var OPEN_IN_APP_PROBE_METHOD = `${OPEN_IN_APP_REMOTE_NAMESPACE}/probe`;
var OPEN_IN_APP_APPS_METHOD = `${OPEN_IN_APP_REMOTE_NAMESPACE}/apps`;
var OPEN_IN_APP_ICON_METHOD = `${OPEN_IN_APP_REMOTE_NAMESPACE}/icon`;
var OPEN_IN_APP_OPEN_METHOD = `${OPEN_IN_APP_REMOTE_NAMESPACE}/open`;
var OPEN_IN_APP_ERROR_CODES = [
  /** The id is not a catalog member (or not a non-empty string). */
  "unknown-app",
  /** The id is a catalog member that does not resolve as installed on this host. */
  "unavailable-app",
  /** The path is missing, empty or not absolute. */
  "invalid-path",
  /** The path names something that is not an existing directory. */
  "directory-missing",
  /** The launcher ran but the application did not come up. */
  "launch-failed",
  /** No icon could be extracted for this application. */
  "icon-unavailable"
];

// src/index.ts
var _open_dec, _icon_dec, _apps_dec, _probe_dec, _a, _init;
var OpenInAppGateway = class extends (_a = TypertRemoteService, _probe_dec = [Remote("probe")], _apps_dec = [Remote("apps")], _icon_dec = [Remote("icon")], _open_dec = [Remote("open")], _a) {
  constructor(ctx) {
    super(ctx, OPEN_IN_APP_REMOTE_NAMESPACE);
    __runInitializers(_init, 5, this);
    __publicField(this, "core");
    this.core = new OpenInAppCore({
      host: {
        platform: process.platform,
        resolveExecutable: async (name) => {
          try {
            return await ctx.subprocess.resolveExecutable(name);
          } catch {
            return null;
          }
        }
      }
    });
  }
  probe() {
    return this.core.probe();
  }
  apps() {
    return domainResult(() => this.core.apps());
  }
  icon(app) {
    return domainResult(() => this.core.icon(app));
  }
  open(app, path) {
    return domainResult(async () => {
      await this.core.open(app, path);
      return {};
    });
  }
};
_init = __decoratorStart(_a);
__decorateElement(_init, 1, "probe", _probe_dec, OpenInAppGateway);
__decorateElement(_init, 1, "apps", _apps_dec, OpenInAppGateway);
__decorateElement(_init, 1, "icon", _icon_dec, OpenInAppGateway);
__decorateElement(_init, 1, "open", _open_dec, OpenInAppGateway);
__decoratorMetadata(_init, OpenInAppGateway);
__publicField(OpenInAppGateway, "inject", ["subprocess"]);
var index_default = OpenInAppGateway;
export {
  OPEN_IN_APP_APPS_METHOD,
  OPEN_IN_APP_ERROR_CODES,
  OPEN_IN_APP_ICON_METHOD,
  OPEN_IN_APP_ICON_TIMEOUT_MS,
  OPEN_IN_APP_LAUNCH_WATCH_MS,
  OPEN_IN_APP_METHODS,
  OPEN_IN_APP_OPEN_METHOD,
  OPEN_IN_APP_PROBE_METHOD,
  OPEN_IN_APP_PROBE_TIMEOUT_MS,
  OPEN_IN_APP_REMOTE_NAMESPACE,
  OpenInAppCore,
  OpenInAppError,
  OpenInAppGateway,
  index_default as default,
  domainResult
};
