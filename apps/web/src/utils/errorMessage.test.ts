import { expect, it } from 'vitest'
import { messageOf } from './errorMessage'

it('原样返回 Error 的消息，包括空消息', () => {
  expect(messageOf(new TypeError('读取失败'), '备用提示')).toBe('读取失败')
  expect(messageOf(new Error(''), '备用提示')).toBe('')
})

it('对非 Error 值使用调用方提示，不读取伪造的 message', () => {
  expect(messageOf({ message: '不是 Error' }, '备用提示')).toBe('备用提示')
  expect(messageOf('不是 Error', '')).toBe('')
  expect(messageOf(undefined)).toBe('未知错误')
})
