/**
 * dsh 运行时版本管理（design 16）——目录数据面，纯逻辑、无 electron（M2）。
 *
 * 存储根：<baseDir>/dsh-runtime/（baseDir 由调用方注入，绝不读 app.getPath，
 * 便于临时目录单测）。布局（design 16 §3.2）：
 *
 *   <baseDir>/dsh-runtime/
 *     current                 —— 指针文件（普通 JSON {version}，**禁 symlink**，
 *                                切换 = 指针原子写（tmp + rename），不 rename 目录树）
 *     override.json           —— override 记录（原子写；损坏保留 *.corrupt，非秘密）
 *     known-good.json         —— known-good 标记（{versions: {<ver>: ISO时间戳}}，
 *                                M3 的「持续健康推进」需要时间戳）
 *     failures/<version>.json —— 失败现场记录（受保护）
 *     <version>.failed/       —— 失败现场树（受保护）
 *     snapshots/ pre-rollback/ .pnpm-store/ —— 非版本树条目（listVersionTrees 排除）
 *     <version>/              —— 不可变版本树（仅精确 semver 目录名）
 *
 * 不变式（design 16 §3.2/§3.5）：
 *   - 所有写都是 tmp + rename 原子写（异常时清理 tmp）；
 *   - override 损坏 → 保留 *.corrupt（可逆，绝不静默当成默认值）；
 *   - 受保护类版本（当前指针 / known-good / pending 指向 / .failed 失败现场）
 *     绝不逐出；
 *   - 版本串进入任何路径前强制 EXACT_SEMVER + 拒绝 /、\、..（design 16 §4
 *     路径安全）；写路径 fail-closed（不安全版本 throw），读路径 fail-safe
 *     （不安全/损坏 → null，绝不用坏数据参与判定）。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { EXACT_SEMVER, assertSafeVersion, isSafeVersion } from './version-safety.ts';

/** override 记录（design 16 §3.5）：壳版本 + 用户选择 + 实际解析 + 未决切换 + 重试标记。 */
export interface OverrideRecord {
  shellVersion: string
  chosenVersion: string | null
  resolvedVersion: string | null
  pending: string | null
  swapAttempted: boolean
}

function runtimeDirPath(baseDir: string): string {
  return join(baseDir, 'dsh-runtime');
}

/** 原子写 JSON（tmp + rename，异常时清理 tmp；0600 与 chamber-settings 同款）。 */
function atomicWriteJson(filePath: string, payload: unknown): void {
  const tmpPath = `${filePath}.tmp`;
  mkdirSync(dirname(filePath), { recursive: true });
  try {
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // 清理是 best-effort；原始错误必须继续上抛。
    }
    throw error;
  }
}

/** 损坏文件保留为 *.corrupt（可逆，非秘密）。读路径绝不 throw。 */
function preserveCorrupt(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.corrupt`);
  } catch (error) {
    console.error(`[dsh-runtime-store] 保留损坏文件失败：`, error);
  }
}

/** <baseDir>/dsh-runtime/current —— 当前指针文件路径。 */
export function currentPointerPath(baseDir: string): string {
  return join(runtimeDirPath(baseDir), 'current');
}

/**
 * 读当前指针：JSON {version} → 版本串；缺失 / 损坏 / 非对象 / 版本串不安全
 * → null（fail-safe：回落内建链，绝不用坏数据）。损坏文件不回写、不删除，
 * 由上层按「无 override 生效」处理。
 */
export function readCurrentPointer(baseDir: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(currentPointerPath(baseDir), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const version = (parsed as Record<string, unknown>).version;
    if (typeof version !== 'string' || version.length === 0) return null;
    if (!isSafeVersion(version)) return null;
    return version;
  } catch {
    return null;
  }
}

/** 原子写当前指针；版本串不安全（非精确 semver / 含 /、\、..）→ throw。 */
export function writeCurrentPointer(baseDir: string, version: string): void {
  const safe = assertSafeVersion(version);
  atomicWriteJson(currentPointerPath(baseDir), { version: safe });
}

/** <baseDir>/dsh-runtime/override.json —— override 记录路径。 */
export function overridePath(baseDir: string): string {
  return join(runtimeDirPath(baseDir), 'override.json');
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** 解析并校验 override 形状（五字段齐全、类型正确；未知额外键容忍）。 */
function parseOverrideRecord(parsed: unknown): OverrideRecord | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.shellVersion !== 'string') return null;
  if (!isNullableString(record.chosenVersion)) return null;
  if (!isNullableString(record.resolvedVersion)) return null;
  if (!isNullableString(record.pending)) return null;
  if (typeof record.swapAttempted !== 'boolean') return null;
  // 读路径 fail-safe（§4 路径安全）：版本字段非 null 时必须 EXACT_SEMVER 且不含
  // /、\、..，否则视为损坏 → null（上层走 *.corrupt 保留），绝不把不安全串当有效记录。
  if (record.chosenVersion !== null && !isSafeVersion(record.chosenVersion)) return null;
  if (record.resolvedVersion !== null && !isSafeVersion(record.resolvedVersion)) return null;
  if (record.pending !== null && !isSafeVersion(record.pending)) return null;
  return {
    shellVersion: record.shellVersion,
    chosenVersion: record.chosenVersion,
    resolvedVersion: record.resolvedVersion,
    pending: record.pending,
    swapAttempted: record.swapAttempted,
  };
}

/**
 * 读 override：缺失 → null；损坏 / 形状不合法 → **保留 *.corrupt** 并返回 null
 * （design 16 §3.2：损坏保留、可逆，绝不静默当成默认）。
 */
export function readOverride(baseDir: string): OverrideRecord | null {
  const filePath = overridePath(baseDir);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    preserveCorrupt(filePath);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    preserveCorrupt(filePath);
    return null;
  }
  const record = parseOverrideRecord(parsed);
  if (record === null) preserveCorrupt(filePath);
  return record;
}

function assertNullableSafeVersion(value: string | null, field: string): void {
  if (value === null) return;
  if (!isSafeVersion(value)) {
    throw new Error(`override.${field} 不是安全版本串：${JSON.stringify(value)}（必须是精确 semver 且不含 /、\\、..）`);
  }
}

/**
 * 原子写 override。写入前校验形状 + 非空版本字段路径安全（fail-closed）；
 * 版本字段统一 trim 归一化后落盘。
 */
export function writeOverride(baseDir: string, record: OverrideRecord): void {
  const { shellVersion, chosenVersion, resolvedVersion, pending, swapAttempted } = record;
  if (typeof shellVersion !== 'string' || shellVersion.length === 0) {
    throw new Error(`override.shellVersion 必须是非空字符串，收到 ${JSON.stringify(shellVersion)}`);
  }
  assertNullableSafeVersion(chosenVersion, 'chosenVersion');
  assertNullableSafeVersion(resolvedVersion, 'resolvedVersion');
  assertNullableSafeVersion(pending, 'pending');
  if (typeof swapAttempted !== 'boolean') {
    throw new Error(`override.swapAttempted 必须是 boolean，收到 ${JSON.stringify(swapAttempted)}`);
  }
  atomicWriteJson(overridePath(baseDir), {
    shellVersion,
    chosenVersion: chosenVersion === null ? null : assertSafeVersion(chosenVersion),
    resolvedVersion: resolvedVersion === null ? null : assertSafeVersion(resolvedVersion),
    pending: pending === null ? null : assertSafeVersion(pending),
    swapAttempted,
  });
}

/**
 * 版本树目录名列表：<baseDir>/dsh-runtime/<version>/ 中**精确 semver 目录名**
 * （排除 current/override.json/known-good.json 等文件与 failures/snapshots/
 * pre-rollback/.pnpm-store/<version>.failed 等非版本树条目）。目录缺失 → []。
 */
export function listVersionTrees(baseDir: string): string[] {
  let entries;
  try {
    entries = readdirSync(runtimeDirPath(baseDir), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue; // .pnpm-store 等隐藏条目
    if (!EXACT_SEMVER.test(entry.name)) continue; // 仅精确 semver = 版本树
    names.push(entry.name);
  }
  return names.sort();
}

function versionTreeMtimeMs(baseDir: string, version: string): number {
  try {
    return statSync(join(runtimeDirPath(baseDir), version)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 磁盘模型逐出（design 16 §4 R3-2 F21 / §3.2 三版本缓存）：受保护类版本
 * （当前指针 / known-good / pending / .failed，见 `isProtectedVersion`）**绝不
 * 逐出**；其余非保护版本树按 mtime 从旧到新逐出，直到总版本树数 ≤ `keep`
 * （默认 3）。返回被逐出的版本串数组（空 = 无需逐出）。
 */
export function evictVersions(baseDir: string, keep = 3): string[] {
  const trees = listVersionTrees(baseDir);
  if (trees.length <= keep) return [];
  const protectedSet = new Set(trees.filter((v) => isProtectedVersion(baseDir, v)));
  const removable = trees
    .filter((v) => !protectedSet.has(v))
    .sort((a, b) => versionTreeMtimeMs(baseDir, a) - versionTreeMtimeMs(baseDir, b));
  const evicted: string[] = [];
  let total = trees.length;
  for (const version of removable) {
    if (total <= keep) break;
    rmSync(join(runtimeDirPath(baseDir), version), { recursive: true, force: true });
    evicted.push(version);
    total -= 1;
  }
  return evicted;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = the process exists but we lack permission to signal it → alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 启动判活清扫（design 16 §4 R3-2 F21）：移除上一次被硬杀留下的 `.work-<hex>`
 * 安装残留（`pid` 标记的进程已不存活）。返回被移除的 work 目录名数组。
 */
export function cleanupStaleInstalls(baseDir: string): string[] {
  let entries;
  try {
    entries = readdirSync(runtimeDirPath(baseDir), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.work-')) continue;
    const workDir = join(runtimeDirPath(baseDir), entry.name);
    let pid: number | null = null;
    try {
      const raw = readFileSync(join(workDir, 'pid'), 'utf8').trim();
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0) pid = n;
    } catch {
      pid = null; // no/invalid pid file → treat as stale
    }
    if (pid !== null && isPidAlive(pid)) continue;
    rmSync(workDir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

/** <baseDir>/dsh-runtime/known-good.json 内容（缺失/损坏 → 空 map）。 */
function readKnownGoodMap(filePath: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const versions = (parsed as Record<string, unknown>).versions;
    if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) return {};
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(versions as Record<string, unknown>)) {
      if (typeof value === 'string') map[key] = value;
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * 写 known-good 标记：known-good.json（{versions: {<ver>: ISO 时间戳}}，原子写）。
 * 标记是派生态——缺失/损坏只缩小受保护集、不触碰任何版本树/数据，直接重建
 * （与 override.json 的损坏保留语义不同）。版本串不安全 → throw。
 */
export function markKnownGood(baseDir: string, version: string): void {
  const safe = assertSafeVersion(version);
  const filePath = join(runtimeDirPath(baseDir), 'known-good.json');
  const versions = readKnownGoodMap(filePath);
  versions[safe] = new Date().toISOString();
  atomicWriteJson(filePath, { versions });
}

function isKnownGood(baseDir: string, version: string): boolean {
  const versions = readKnownGoodMap(join(runtimeDirPath(baseDir), 'known-good.json'));
  return Object.prototype.hasOwnProperty.call(versions, version);
}

/**
 * 受保护类版本（design 16 §3.2 保留策略，**绝不逐出**）：
 *   1. 当前指针指向；
 *   2. known-good 标记；
 *   3. override.pending 指向；
 *   4. .failed 失败现场（failures/<version>.json 或 <version>.failed 树）。
 * 异常版本串（非精确 semver / 含 /、\、..）→ 恒 false（路径安全守卫）。
 */
export function isProtectedVersion(baseDir: string, version: string): boolean {
  if (!isSafeVersion(version)) return false;
  const runtimeDir = runtimeDirPath(baseDir);
  if (readCurrentPointer(baseDir) === version) return true;
  if (isKnownGood(baseDir, version)) return true;
  const override = readOverride(baseDir);
  if (override !== null && override.pending === version) return true;
  if (existsSync(join(runtimeDir, 'failures', `${version}.json`))) return true;
  if (existsSync(join(runtimeDir, `${version}.failed`))) return true;
  return false;
}
