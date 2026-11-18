export const MOCK_ACTION_NOTE = 'mock，待接入真实执行'
export const DEMO_LOG_CLEAR_NOTE = '演示数据，只清空内存中的演示日志'

export function demoNoticeSuffix(dockerRuntime: boolean, note = '演示数据'): string {
  return dockerRuntime ? '' : `（${note}）`
}
