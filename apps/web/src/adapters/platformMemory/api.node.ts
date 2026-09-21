import type { Connect } from 'vite'
import { createPlatformMemoryHandler } from './api'

/** 挂载到 /api/platform/memory：始终采集本进程，不设容器边界。 */
export function createPlatformMemoryMiddleware(): Connect.NextHandleFunction {
  return createPlatformMemoryHandler()
}
