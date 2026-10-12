import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatSession } from '../../contracts/agentChat'
import { AGENT_CHAT_STORAGE_KEY, createAgentChatLocalAdapter } from './agentChatLocalAdapter'

const session = (): AgentChatSession => ({ id: 'session-1', createdAt: '2026-10-12T00:00:00.000Z', draft: '草稿', messages: [], attachments: [], permissionMode: 'ask', modelId: null, reasoningLevel: null })

afterEach(() => { localStorage.removeItem(AGENT_CHAT_STORAGE_KEY); vi.restoreAllMocks() })

describe('浏览器会话存储', () => {
  it('损坏或不兼容的数据安全回落，不阻止创建新会话', () => {
    const adapter = createAgentChatLocalAdapter()
    localStorage.setItem(AGENT_CHAT_STORAGE_KEY, '{broken')
    expect(adapter.read()).toBeNull()
    localStorage.setItem(AGENT_CHAT_STORAGE_KEY, JSON.stringify({ id: 'not-a-session' }))
    expect(adapter.read()).toBeNull()
    expect(adapter.write(session())).toBe(true)
    expect(adapter.read()).toEqual(session())
  })

  it('存储额度不足时保留最新内存会话，不重新读入旧会话', () => {
    const adapter = createAgentChatLocalAdapter()
    adapter.write(session())
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('额度不足', 'QuotaExceededError') })
    expect(adapter.write({ ...session(), id: 'session-2', draft: '新草稿' })).toBe(false)
    expect(adapter.read()).toMatchObject({ id: 'session-2', draft: '新草稿' })
  })

  it('持久文本不携带 blob URL，IndexedDB 不可用时刷新明确丢失文件可用性', async () => {
    const adapter = createAgentChatLocalAdapter()
    const result = await adapter.attach([new File(['hello'], 'a.txt', { type: 'text/plain' })])
    adapter.write({ ...session(), attachments: result.attachments })
    const saved = adapter.read()!
    expect(saved.attachments[0]?.available).toBe(false)
    expect((await adapter.restore(saved.attachments))[0]?.available).toBe(true)
    const refreshed = createAgentChatLocalAdapter()
    expect((await refreshed.restore(saved.attachments))[0]?.available).toBe(false)
  })
})
