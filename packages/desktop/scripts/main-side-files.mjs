/**
 * main 侧 IPC 注册文件集（ipcMain.handle / rendererPush 调用所在）——单一来源。
 *
 * 两个消费者必须读同一份名单，否则「通道方向判定/死键」与 IPC 面锁步会各说各话：
 *   - ./emit-bridge-manifest.mjs（bridge-manifest 方向判定与死键检查——main 侧零
 *     引用的通道没有方向）；
 *   - ../test/ipc/ipc-surface-mirror.test.ts（preload/renderer 镜像与「每个通道
 *     恰用一次」的源文本锁；其类型来自同目录的 main-side-files.d.mts）。
 *
 * 注册点迁移（例如把两 flavor 的宿主装配收敛到 host-assembly.ts）只改这里：
 * 名单漂移会让 manifest 把真实存在的 push 报成死键（host-assembly.ts 的
 * SSH_STATUS_CHANGED / SSH_INSTANCES_CHANGED 就是这种迁移）。
 */
export const MAIN_SIDE_FILES = [
  'main.ts',
  'shell-core.ts',
  'electron-edges.ts',
  // shell-core 的 installIpcHandlers 注册体按域分布在 shell-ipc-*.ts；
  // runtime state push 在 runtime-startup-host.ts；两 flavor 共用的宿主装配
  // （ready 注册/committed push）在 host-assembly.ts。
  'shell-ipc-settings.ts',
  'shell-ipc-connections.ts',
  'shell-ipc-plugins-ssh.ts',
  'shell-ipc-plugins-gateway.ts',
  'shell-ipc-plugins-local.ts',
  'shell-ipc-open-in.ts',
  'shell-ipc-update.ts',
  'shell-ipc-runtime.ts',
  'runtime-startup-host.ts',
  'host-assembly.ts',
]
