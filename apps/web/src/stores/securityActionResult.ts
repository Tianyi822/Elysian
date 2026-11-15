import { tableBatchFailure } from '../utils/tableBatch'

/** 单项与批量入口共用可信结果，不以 Promise 正常结束代替执行证据。 */
export type SecurityActionResult = { status: 'succeeded' | 'failed' | 'unknown'; error?: string }

export const securityActionFailure = (error: unknown, fallback: string): SecurityActionResult => ({
  ...tableBatchFailure(error),
  error: error instanceof Error ? error.message : fallback,
})

export const securitySessionChanged = (): SecurityActionResult => ({
  status: 'unknown', error: '登录状态已变化，操作结果需在重新登录后核实',
})
