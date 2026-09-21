/**
 * 本地实例的来源 id（单一来源；2026-12 阶段 3 从 App.tsx 提出）。
 * N-ctx 里 local 常驻、不参与 roster 回收：prune/retire 路径都以它为豁免键。
 */
export const LOCAL_INSTANCE_ID = 'local'
