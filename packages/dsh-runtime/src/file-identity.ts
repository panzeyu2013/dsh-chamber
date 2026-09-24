/**
 * The dev+ino identity pair the runtime's no-follow readers and writers trust
 * across one path round-trip. One leaf so private-fs.ts, dsh-runtime-store.ts
 * and snapshot-store.ts share the comparison instead of carrying three copies
 * (private-fs.ts is export-surface-locked against control-plane's
 * private-file.ts, so this primitive deliberately lives outside its surface).
 */
export interface FileIdentity {
  dev: number | bigint
  ino: number | bigint
}

export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}
