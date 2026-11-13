import { describe, expect, it, vi } from 'vitest'
import * as datasetModule from './dataset'
import { createGateway } from './gateway'

/** 全 http 选项：不构造任何 mock adapter，演示数据集不应被构造（首屏 CPU 浪费点）。 */
const allHttp = {
  eventStream: 'auto',
  firewall: 'http',
  ssh: 'http',
  users: 'http',
  files: 'http',
  containers: 'http',
  websites: 'http',
  dependencies: 'http',
  logs: 'http',
  terminals: 'ws',
  session: 'http',
  panel: 'http',
  modelSettings: 'http',
  agentRuntime: 'http',
  agentExtensions: 'http',
  agentMemory: 'http',
} as const

describe('演示数据集惰性构造', () => {
  it('全 http 选项不构造演示数据集', () => {
    const spy = vi.spyOn(datasetModule, 'createMockDataset')
    createGateway(allHttp)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})