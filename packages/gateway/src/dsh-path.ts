import { existsSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join, parse, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A directory shape accepted by control-plane's resolveDshEntry(). */
export function isDshWorkspace(path: string): boolean {
  return existsSync(join(path, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    || existsSync(join(path, 'apps', 'cli', 'src', 'bin.ts'))
}

/**
 * Resolve a dsh installation without relying on the gateway bundle's own
 * import.meta.url. In a global npm install the `dsh` bin is normally a
 * symlink into `<root>/node_modules/@deepseek-ai/dsh/lib/bin.js`; its real
 * target therefore identifies exactly the workspace root expected by the
 * shared spawn code. Returns null instead of guessing.
 */
export function findDshWorkspace(
  fallback: string,
  pathValue = process.env.PATH ?? '',
  platform = process.platform,
  modulePath = fileURLToPath(import.meta.url),
): string | null {
  if (isDshWorkspace(fallback)) return fallback
  // npm/pnpm/Windows may install `dsh` as a shell/.cmd shim instead of a
  // symlink, so realpath(PATH/dsh) alone cannot reveal its package. Walk from
  // this installed gateway bundle as well: globally or project-locally
  // installed sibling packages meet at an ancestor `<root>/node_modules`.
  let directory = dirname(modulePath)
  const filesystemRoot = parse(directory).root
  while (true) {
    if (isDshWorkspace(directory)) return realpathSync(directory)
    if (directory === filesystemRoot) break
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const executableNames = platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']
  const marker = `${sep}node_modules${sep}@deepseek-ai${sep}dsh${sep}lib${sep}bin.js`
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '') continue
    for (const name of executableNames) {
      const candidate = join(directory, name)
      if (!existsSync(candidate)) continue
      let target: string
      try {
        target = realpathSync(candidate)
      } catch {
        continue
      }
      const markerIndex = target.lastIndexOf(marker)
      if (markerIndex === -1) continue
      const root = target.slice(0, markerIndex)
      if (isDshWorkspace(root)) return root
    }
  }
  return null
}
