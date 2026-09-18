import { describe, expect, it } from 'vitest'
import { parseResourceHistoryResponse } from './resourceHistoryAdapter'

describe('parseResourceHistoryResponse', () => {
  it('接受升序采样点数组', () => {
    const points = parseResourceHistoryResponse([
      { ts: 1, cpu: 10, memory: 20, networkIo: 30, networkRx: 30, networkTx: 0, diskIo: 40 , diskRead: 40 , diskWrite: 0 },
      { ts: 2, cpu: 11, memory: 21, networkIo: 31, networkRx: 31, networkTx: 0, diskIo: 41 , diskRead: 41 , diskWrite: 0 },
    ])
    expect(points).toHaveLength(2)
  })

  it('非数组时抛中文错误', () => {
    expect(() => parseResourceHistoryResponse({})).toThrow('历史响应格式无效')
  })

  it('缺少字段时抛中文错误', () => {
    expect(() => parseResourceHistoryResponse([{ ts: 1, cpu: 2 }])).toThrow('无效的采样点')
  })
})
