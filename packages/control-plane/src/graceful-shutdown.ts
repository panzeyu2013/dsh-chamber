/**
 * The SIGINT/SIGTERM ladder shared by the standalone entry and the cli thin
 * shell: one-flight stop, then the conventional exit code (130 = SIGINT,
 * 0 = SIGTERM). One implementation because a shutdown path that diverges
 * between the two launchers is invisible until someone's terminal hangs.
 */
export interface GracefulShutdownPlane {
  stop(): Promise<void> | void
}

export function installGracefulShutdown(
  plane: GracefulShutdownPlane,
  logger: { log(message: string): void },
): void {
  let exiting = false
  const shutdown = async (signal: string, code: number): Promise<void> => {
    if (exiting) return
    exiting = true
    logger.log(`received ${signal}, stopping`)
    try {
      await plane.stop()
    } finally {
      process.exit(code)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT', 130))
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0))
}
