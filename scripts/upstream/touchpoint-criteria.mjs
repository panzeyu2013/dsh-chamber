/**
 * touchpoint-criteria.mjs — C1–C16 判据 id 表（纯数据、无副作用）。
 *
 * 用途：`scripts/upstream/registry.json` 的 `criteria` 字段与
 * `docs/checklists/upstream-touchpoints.md` §6 共用同一份 id。判据的**实现**仍在
 * `scripts/upstream/verify-upstream-touchpoints.mjs`（命令式，刻意不迁入数据 ——
 * 它们里有重建-比对、类型解析、竞态形状判定，数据化只会制造"假单一源"）。
 *
 * 漂移纪律：增删判据 = 同批改本表、verifier 头注与 checklist §6。id 与实现的漂移由
 * `scripts/upstream/registry.test.mjs` 兜住（每个 id 必须出现在 verifier 源码里），
 * id 与 registry 的关系由 `verify-registry.mjs` 兜住（`criteria` 并集 ∪
 * `criteriaCodeOnly` 必须恰为 C1–C16，不重不漏）。
 */
export const CRITERIA = Object.freeze({
  C1: 'fork 纯文件字节恒等：未登记补丁的文件必须与上游锚逐字节一致',
  C2: '--tags <old> <new>：已登记 fork 面的重放差异报告（advisory）',
  C3: '完整性：fork 每文件有分类、上游每文件有裁决（漏分类/漏裁决 = 硬失败）',
  C4: 'roster：typert remote 装配契约 23（集合与顺序）、covered/factory 存在性、删包 fail-loud',
  C5: '过期锚扫描：shadow fork package.json 版本 == 上游；submodule HEAD == harness.commit',
  C6: 'EXCLUDED 上游存在性：ensure-harness-vendor 排除的 shadow fork 源目录仍在',
  C7: '种子域锁步：gateway HOST_PACKAGE_PROBE_DOMAINS == dsh-runtime HOST_DOMAIN_PROBE_NAMES',
  C8: '构建期生成物 == src：确定性重建-比对（硬失败）',
  C9: 'vendor 源码补丁锚：每处 expect 在 pin 住的上游文件里恰好命中一次',
  C10: '版本锚一致性 + 活版本字面量白名单（运行时锁文件为单一来源）',
  C11: '运行时线族集合：受保护集合的 F 分量只认运行时锁文件闭包',
  C12: 'profile 契约锚：dsh.profile.bundles / dsh.bundle.patch / web 模板 / hoisted + 不自动装 peer',
  C13: '播种注册表结构：HOST_*_PACKAGE_NAME ↔ HOST_*_INSERT ↔ CHAMBER_HOST_PACKAGES',
  C14: 'plugin-row 单源（wire ./plugin-row 唯一声明；control-plane/client-core/preload/renderer/settings-connections 只引用不重声明）+ manifest 三方字段集镜像',
  C15: '悬停卡自持移植的上游退役门：竞态两侧形状仍在 + 时间常数锁步',
  C16: 'vendor 源消费者清单与真实相对 import 双向一致：符号集合相等 + 导出仍是 export function',
})

export const CRITERIA_IDS = Object.freeze(Object.keys(CRITERIA))
