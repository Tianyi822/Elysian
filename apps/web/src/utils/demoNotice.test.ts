import { expect, it } from 'vitest'
import { demoNoticeSuffix, DEMO_LOG_CLEAR_NOTE, MOCK_ACTION_NOTE } from './demoNotice'

it('只在演示模式下附加原有的全角括号提示', () => {
  expect(demoNoticeSuffix(false)).toBe('（演示数据）')
  expect(demoNoticeSuffix(false, MOCK_ACTION_NOTE)).toBe('（mock，待接入真实执行）')
  expect(demoNoticeSuffix(false, DEMO_LOG_CLEAR_NOTE)).toBe('（演示数据，只清空内存中的演示日志）')
  expect(demoNoticeSuffix(true)).toBe('')
  expect(demoNoticeSuffix(true, DEMO_LOG_CLEAR_NOTE)).toBe('')
})
