#!/usr/bin/env node
/** Bundle the host plugin once in the chamber tree; managed profiles receive dist/index.js. */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const requireFromRenderer = createRequire(fileURLToPath(new URL('../../renderer/package.json', import.meta.url)))
const viteEntry = requireFromRenderer.resolve('vite')
const esbuildModule = await import(pathToFileURL(createRequire(viteEntry).resolve('esbuild')).href)

const result = await esbuildModule.build({
  entryPoints: [join(packageRoot, 'src/index.ts')],
  absWorkingDir: packageRoot,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(packageRoot, 'dist/index.js'),
  external: ['@deepseek-ai/*'],
  logLevel: 'info',
})
if (result.errors.length > 0) {
  console.error('build.mjs: esbuild reported errors')
  process.exit(1)
}
console.log(`build.mjs: bundled ${join(packageRoot, 'dist/index.js')}`)
