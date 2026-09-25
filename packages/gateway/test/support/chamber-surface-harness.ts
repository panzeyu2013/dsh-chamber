/**
 * Shared chamber-surface test harness: the logger literal, the empty
 * channel-registry stub, the createChamberSurface deps assembly and the fake
 * request/response runner used by chamber-installed /
 * chamber-plugins-mutations / feature-lifecycle.
 *
 * The factory keeps every injection point (stateDir, logger, channels)
 * so the suites express only their differences.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiRequest, ApiResponse, Logger } from '@dsh-chamber/control-plane'
import { createChamberPlugins } from '../../src/plugins.ts'
import { createChamberInstalled } from '../../src/plugins-installed.ts'
import { createChamberSurface, type ChamberSurfaceDeps } from '../../src/routes.ts'
import { FakeRequest, FakeResponse } from './utils.ts'

/** The silent logger for every chamber-surface suite. */
export const surfaceSilentLogger: Logger = { log() {}, warn() {}, error() {} }

/** The MVP channel registry: no providers, list() always empty. */
export const surfaceStubChannels: ChamberSurfaceDeps['channels'] = {
  register() {},
  async start() {},
  async stop() {},
  resolve: () => null,
  health: () => 'unknown' as const,
  list: () => [],
}

export interface ChamberSurfaceHarnessOptions {
  /** Caller-owned stateDir (the suite registers its own cleanup); omitted →
   *  a temp dir is created and removed via `t.after`. */
  stateDir?: string
  prefix?: string
  logger?: Logger
  channels?: ChamberSurfaceDeps['channels']
}

export interface ChamberSurfaceHarness {
  surface: ReturnType<typeof createChamberSurface>
  stateDir: string
}

export function makeChamberSurfaceHarness(
  t: { after(fn: () => void): void } | undefined,
  options: ChamberSurfaceHarnessOptions = {},
): ChamberSurfaceHarness {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), options.prefix ?? 'gateway-surface-'))
  if (options.stateDir === undefined) {
    t?.after(() => rmSync(stateDir, { recursive: true, force: true }))
  }
  const logger = options.logger ?? surfaceSilentLogger
  const surface = createChamberSurface({
    logger,
    channels: options.channels ?? surfaceStubChannels,
    plugins: createChamberPlugins(stateDir, logger),
    installed: createChamberInstalled(stateDir),
  })
  return { surface, stateDir }
}

/** GET/POST a chamber-surface path through the fake transport. */
export async function handleChamberSurface(
  host: ReturnType<typeof createChamberSurface>,
  method: string,
  path: string,
): Promise<FakeResponse> {
  const response = new FakeResponse()
  await host.handle(new FakeRequest(method) as unknown as ApiRequest,
    response as unknown as ApiResponse, path)
  return response
}
