import type { PlatformMemoryAdapter } from '../../contracts/adapters'
import { parsePlatformMemoryResponse } from '../platformMemory/types'
import { createDomainJsonClient } from './domainJson'

const { requestJson } = createDomainJsonClient('平台内存', {
  networkError: '平台内存采集失败',
  httpError: '平台内存采集失败',
})

export function createHttpPlatformMemoryAdapter(): PlatformMemoryAdapter {
  return {
    read: (signal) => requestJson('/api/platform/memory', { cache: 'no-store', signal }).then(parsePlatformMemoryResponse),
  }
}
