/**
 * SSH 密码凭据镜像 `<userData>/ssh-passwords.json`（design 05 §8）的文件层：加密、
 * 旧格式兼容、迁移与损坏处置都收敛在这里；内存态与 endpoint binding 判定仍留在
 * ssh-provider.ts（本次只做最小接线）。
 *
 * 存储策略（与 gateway-secrets 的 v3 判别符同构，但**拒绝策略不同**）：
 * - 注入 `SshCredentialCryptoAdapter`（Electron safeStorage，main.ts 无条件注入）且
 *   `isAvailable()` 为真 → 写 schemaVersion 3 + `storage: 'safeStorage'` 的密文；
 * - 适配器**不存在**（Swift sidecar / 纯 Node 测试）→ 保持文档化的 0600 明文回退
 *   （design 25：Swift flavor 语义不变）；
 * - 适配器存在但 `isAvailable()` 为假（Linux 无 keyring）→ **新保存/改密一律拒绝**
 *   并给出可操作错误（绝不静默写明文）；旧明文文件仍可读、可清除（不静默丢弃）。
 * - `storage: 'safeStorage'` 而本进程无可用适配器（跨 flavor）⇒ 不是损坏：文件原地
 *   保留、条目 fail closed、loud 文案，绝不 rename 成 `.corrupt`。
 * - 结构损坏 / 解密失败 ⇒ 保留为 `<file>.corrupt`（可逆取证），store 空，绝不静默清空。
 *
 * 明文文件（schemaVersion 2，无 `storage` 判别符）在适配器可用时读后立刻原子迁移重写
 * 为密文；迁移失败时条目仍可用、文件保持明文并 loud 报出（与 gateway 的 S22 迁移同款）。
 *
 * Askpass 侧的 v1 边界（2FA）：本模块与 ssh-askpass.ts 都不回答 keyboard-interactive /
 * OTP 提示——ssh 的 keyboard-interactive（服务器端 2FA、OTP、密码变更）在 v1 **不支持**，
 * 受影响主机请改用 SSH 密钥认证；提示分类仍是 fail-closed（见 buildAskpassScript）。
 */

import { dirname } from 'node:path'
import { INSTANCE_ID_PATTERN } from './transport-provider.ts'
import { isCredentialBinding } from './credential-binding.ts'
import { isPlainRecord, preserveInvalidCredentialFile, removeLegacyTmpResidue } from './store-file-hygiene.ts'
import { readOwnerOnlySecretFile } from './owner-only-secret-file.ts'
import { atomicWritePrivateFileNoFollow, ensurePrivateDirectoryNoFollow } from './control-plane-module.ts'

/** SSH 密码长度上限（字符）；IPC 门禁与 store 校验共用的单一来源。 */
export const MAX_SSH_PASSWORD_CHARS = 4096

/**
 * 凭据镜像的加密边界，形状与 gateway 的 SecretCryptoAdapter 相同（刻意不共享类型：
 * 两个 store 的**可用性策略**不同，共享一个"可选"类型只会让调用点误以为语义一致）。
 * `decrypt` 必须对非本适配器产出的 blob 抛错——带 safeStorage 判别符却解不开 = 损坏。
 */
export interface SshCredentialCryptoAdapter {
  isAvailable(): boolean
  encrypt(plain: string): string
  decrypt(blob: string): string
}

/** 文件级持久化判别符：密文与明文永不靠字符形状猜测。 */
export type SshCredentialStorage = 'safeStorage' | 'plaintext'

/** 一条凭据：密码 + 它被写入时的 SSH endpoint 绑定（崩溃窗口 fail-closed 的锚）。 */
export interface SshCredentialEntry {
  password: string
  binding: string
}

/** 打开后的 store：读结果 + 写入口（写入口是 write-through 的唯一落盘点）。 */
export interface OpenedSshCredentialStore {
  /** 解密后的条目；损坏/跨 flavor 不可读时为空（fail closed）。 */
  entries: Map<string, SshCredentialEntry>
  /** 文件**实际**的持久化模式（不因适配器可用就谎称 safeStorage）。 */
  storage: SshCredentialStorage
  /** loud 启动文案（损坏保留 / 跨 flavor 不可读 / 明文无 keyring / 迁移失败），或 null。 */
  notice: string | null
  /** 原子写回；加密不可用且本次写入含新/变更密钥时抛可操作错误。 */
  persist(next: ReadonlyMap<string, SshCredentialEntry>): void
}

/** 拒绝新保存时的可操作文案（IPC 会原样展示给设置页）。 */
export const SSH_PASSWORD_ENCRYPTION_UNAVAILABLE =
  'refusing to save the SSH password: OS keychain encryption (Electron safeStorage) is unavailable, '
  + 'and this build never writes a new password in plaintext — install and unlock an OS keyring '
  + '(GNOME Keyring or KWallet on Linux) and restart dsh-chamber, or use SSH key authentication instead. '
  + 'Existing plaintext passwords remain readable.'

/** 旧明文仍可读、但本次不能新增/改密时的 loud 启动说明。 */
const PLAINTEXT_WITHOUT_KEYRING_NOTICE =
  'OS keychain encryption is unavailable (no keyring): the SSH password mirror stays plaintext and existing '
  + 'entries remain readable, but new or changed passwords will be refused until a keyring is available '
  + '(install/unlock GNOME Keyring or KWallet and restart, or use SSH key authentication)'

/** 跨 flavor：文件由 Electron flavor 以 safeStorage 写出，本进程无法解密（不是损坏）。 */
export const SSH_PASSWORD_SAFESTORAGE_UNREADABLE =
  'SSH password mirror is safeStorage-encrypted by the Electron flavor and this process has no usable OS '
  + 'keychain crypto adapter, so it cannot decrypt it — the file was preserved unchanged (reopen the Electron '
  + 'flavor to keep using those passwords, or re-enter them there; new plaintext passwords are never written)'

/** 结构上已通过校验的文档（值仍是存储形态，未解密）。 */
interface SshCredentialDocument {
  storage: SshCredentialStorage
  passwords: Record<string, string>
  bindings: Record<string, string>
}

/** 结构/格式校验：schemaVersion 2（无判别符 = 明文）或 3（显式 storage），表形状与 id/binding 白名单。 */
function parseDocument(parsed: unknown): SshCredentialDocument | null {
  if (!isPlainRecord(parsed)) return null
  if (!isPlainRecord(parsed.passwords) || !isPlainRecord(parsed.bindings)) return null
  let storage: SshCredentialStorage
  if (parsed.schemaVersion === 2) storage = 'plaintext'
  else if (parsed.schemaVersion === 3 && (parsed.storage === 'safeStorage' || parsed.storage === 'plaintext')) storage = parsed.storage
  else return null
  const passwords = parsed.passwords
  const bindings = parsed.bindings
  const passwordIds = Object.keys(passwords)
  if (passwordIds.length !== Object.keys(bindings).length) return null
  const document: SshCredentialDocument = { storage, passwords: {}, bindings: {} }
  for (const id of passwordIds) {
    const value = passwords[id]
    const binding = bindings[id]
    // id 进 /api/i/dsh-<id> 路径段：白名单外的 id（含保留的 'local'）整文件拒绝。
    if (id === 'local' || !INSTANCE_ID_PATTERN.test(id) || typeof value !== 'string' || value === '') return null
    if (!Object.hasOwn(bindings, id) || !isCredentialBinding(binding)) return null
    document.passwords[id] = value
    document.bindings[id] = binding
  }
  return document
}

/** 按文件判别符解码：明文原样返回，密文交给适配器（抛错 = 该文件损坏）。 */
function decodeEntry(value: string, storage: SshCredentialStorage, crypto: SshCredentialCryptoAdapter): string | null {
  if (storage === 'plaintext') return value
  try {
    return crypto.decrypt(value)
  } catch {
    return null
  }
}

/** 原子写回：随机 O_EXCL 0600 tmp → fsync → rename → parent fsync（控制面单源原语）。 */
function writeCredentialFile(
  file: string,
  next: ReadonlyMap<string, SshCredentialEntry>,
  storage: SshCredentialStorage,
  encode: (plain: string) => string,
): void {
  const passwords: Record<string, string> = {}
  const bindings: Record<string, string> = {}
  for (const [id, entry] of next) {
    passwords[id] = encode(entry.password)
    bindings[id] = entry.binding
  }
  const payload = `${JSON.stringify({ schemaVersion: 3, storage, passwords, bindings }, undefined, 2)}\n`
  ensurePrivateDirectoryNoFollow(dirname(file), 0o700)
  atomicWritePrivateFileNoFollow(file, payload, { mode: 0o600 })
}

/** 本次写入是否包含**新增或变更**的密码（只删除/原样保留不算新保存）。 */
function introducesSecret(next: ReadonlyMap<string, SshCredentialEntry>, previous: ReadonlyMap<string, SshCredentialEntry>): boolean {
  for (const [id, entry] of next) {
    if (previous.get(id)?.password !== entry.password) return true
  }
  return false
}

function cloneEntries(source: ReadonlyMap<string, SshCredentialEntry>): Map<string, SshCredentialEntry> {
  const copy = new Map<string, SshCredentialEntry>()
  for (const [id, entry] of source) copy.set(id, { password: entry.password, binding: entry.binding })
  return copy
}

/**
 * 打开（并可能迁移）密码镜像。`file === null` = 仅内存（测试/显式关闭）：无读、persist no-op。
 * 加密适配器缺省 = 文档化明文回退（Swift flavor / 纯 Node 测试）；显式传入但不可用 = 拒绝新保存。
 */
export function openSshCredentialStore(
  file: string | null,
  crypto?: SshCredentialCryptoAdapter,
): OpenedSshCredentialStore {
  const cryptoReady = (): boolean => {
    if (crypto === undefined) return false
    try {
      return crypto.isAvailable()
    } catch {
      return false
    }
  }
  const entries = new Map<string, SshCredentialEntry>()
  let storage: SshCredentialStorage = 'plaintext'
  let lastCommitted = new Map<string, SshCredentialEntry>()
  if (file === null) return { entries, storage, notice: null, persist: () => {} }

  /** write-through 落盘：加密可用写密文；只有文档化明文档（无适配器）才写明文。 */
  function persist(next: ReadonlyMap<string, SshCredentialEntry>): void {
    if (file === null) return
    if (cryptoReady()) {
      try {
        writeCredentialFile(file, next, 'safeStorage', plain => (crypto as SshCredentialCryptoAdapter).encrypt(plain))
      } catch (error) {
        throw new Error(`cannot save the SSH password: OS keychain encryption failed (${String(error)}); the password was not written`)
      }
      storage = 'safeStorage'
      lastCommitted = cloneEntries(next)
      return
    }
    if (crypto === undefined) {
      // Cross-flavor: a safeStorage file can be READ only fail-closed here. A
      // plaintext rewrite would both downgrade the new entry and ERASE every
      // entry this process could not decrypt (review R1-B M3).
      if (storage === 'safeStorage') throw new Error(SSH_PASSWORD_SAFESTORAGE_UNREADABLE)
      writeCredentialFile(file, next, 'plaintext', plain => plain)
      storage = 'plaintext'
      lastCommitted = cloneEntries(next)
      return
    }
    // 适配器存在但不可用：只有"不引入新密钥"的写入（清除 / 原样重写）允许保持明文，
    // 任何新保存或改密都拒绝——绝不降级成明文落盘。
    if (storage !== 'plaintext' || introducesSecret(next, lastCommitted)) {
      throw new Error(SSH_PASSWORD_ENCRYPTION_UNAVAILABLE)
    }
    writeCredentialFile(file, next, 'plaintext', plain => plain)
    lastCommitted = cloneEntries(next)
  }

  // 旧 persist 的固定名 `.tmp` 崩溃残留一次性回收；原子替换用随机 O_EXCL tmp。
  removeLegacyTmpResidue(file)

  let text: string
  try {
    text = readOwnerOnlySecretFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // 首次运行：空 store；无 keyring 时仍然 loud 说明新保存会被拒绝。
      const notice = crypto !== undefined && !cryptoReady() ? PLAINTEXT_WITHOUT_KEYRING_NOTICE : null
      return { entries, storage, notice, persist }
    }
    // 不可读（symlink / 多链接 / 非普通文件 / 权限）：loud、非致命，store 空（fail closed）。
    return { entries, storage, notice: `cannot read ${file}: ${String(error)}`, persist }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { entries, storage, notice: preserveInvalidCredentialFile(file, 'password file'), persist }
  }
  const document = parseDocument(parsed)
  if (document === null) return { entries, storage, notice: preserveInvalidCredentialFile(file, 'password file'), persist }

  // 跨 flavor：密文 + 本进程无适配器/适配器不可用。**不是损坏**——绝不 rename。
  if (document.storage === 'safeStorage' && !cryptoReady()) {
    // Keep the CLOSURE storage in sync with what was read: persist() consults
    // it to refuse a plaintext rewrite that would erase every ciphertext entry.
    storage = 'safeStorage'
    return { entries, storage, notice: SSH_PASSWORD_SAFESTORAGE_UNREADABLE, persist }
  }

  storage = document.storage
  for (const id of Object.keys(document.passwords)) {
    const raw = document.passwords[id]
    const password = crypto !== undefined ? decodeEntry(raw, document.storage, crypto) : raw
    if (password === null || password === '' || password.length > MAX_SSH_PASSWORD_CHARS) {
      entries.clear()
      return { entries, storage, notice: preserveInvalidCredentialFile(file, 'password file'), persist }
    }
    entries.set(id, { password, binding: document.bindings[id] })
  }
  lastCommitted = cloneEntries(entries)

  // 旧明文 + 适配器可用 → 立刻原子迁移重写；失败时条目仍可用、文件保持明文并 loud。
  if (document.storage === 'plaintext' && cryptoReady()) {
    try {
      writeCredentialFile(file, entries, 'safeStorage', plain => (crypto as SshCredentialCryptoAdapter).encrypt(plain))
      storage = 'safeStorage'
      lastCommitted = cloneEntries(entries)
      return { entries, storage, notice: null, persist }
    } catch (error) {
      return {
        entries,
        storage,
        notice: `loaded plaintext SSH passwords, but the safeStorage upgrade failed: ${String(error)}; the mirror remains plaintext`,
        persist,
      }
    }
  }
  if (document.storage === 'plaintext' && crypto !== undefined && !cryptoReady()) {
    return { entries, storage, notice: PLAINTEXT_WITHOUT_KEYRING_NOTICE, persist }
  }
  return { entries, storage, notice: null, persist }
}
