import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatSession } from '../../contracts/agentChat'
import { AGENT_CHAT_STORAGE_KEY, AGENT_CHAT_LEGACY_KEY, AGENT_CHAT_RECORD_PREFIX, createAgentChatLocalAdapter } from './agentChatLocalAdapter'

const session = (): AgentChatSession => ({ id: 'session-1', createdAt: '2026-10-12T00:00:00.000Z', draft: '草稿', messages: [], attachments: [], permissionMode: 'ask', modelId: null, reasoningLevel: null })

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

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


describe('多会话存储迁移与隔离', () => {
  it('v1 保留草稿、附件与精确 pending，写入完整 v2 后才清旧记录', () => {
    const legacy = { ...session(), remote: { sessionId: 'remote-a' }, pending: { input: { requestId: 'original-id', content: '原输入', reasoningLevel: 'high' } } }
    localStorage.setItem(AGENT_CHAT_LEGACY_KEY, JSON.stringify(legacy))
    const adapter = createAgentChatLocalAdapter()
    expect(adapter.read()).toEqual(legacy)
    expect(localStorage.getItem(AGENT_CHAT_LEGACY_KEY)).toBeNull()
    expect(localStorage.getItem(AGENT_CHAT_STORAGE_KEY)).toBe('remote-a')
    adapter.write({ ...session(), id: 'draft:b', draft: '另一条草稿' })
    expect(adapter.read('remote-a')?.pending?.input.requestId).toBe('original-id')
    expect(adapter.list()).toHaveLength(2)
  })

  it('迁移中途存储失败不会清除旧记录，恢复后可重试', () => {
    localStorage.setItem(AGENT_CHAT_LEGACY_KEY, JSON.stringify(session()))
    const original = Storage.prototype.setItem
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key === AGENT_CHAT_STORAGE_KEY) throw new Error('存储已满')
      original.call(this, key, value)
    })
    const adapter = createAgentChatLocalAdapter()
    expect(adapter.read()?.draft).toBe('草稿')
    expect(localStorage.getItem(AGENT_CHAT_LEGACY_KEY)).not.toBeNull()
    failure.mockRestore()
    expect(adapter.read()?.draft).toBe('草稿')
    expect(localStorage.getItem(AGENT_CHAT_LEGACY_KEY)).toBeNull()
  })

  it('后台回执不更改选中指针，草稿转远端ID后不残留重复记录', () => {
    const adapter = createAgentChatLocalAdapter()
    adapter.write({ ...session(), id: 'draft:a' })
    adapter.write({ ...session(), id: 'draft:b' })
    adapter.write({ ...session(), id: 'draft:a', remote: { sessionId: 'remote-a' } }, false)
    expect(adapter.read()?.id).toBe('draft:b')
    expect(localStorage.getItem(AGENT_CHAT_RECORD_PREFIX + encodeURIComponent('draft:a'))).toBeNull()
    expect(adapter.list().map(row => row.id).sort()).toEqual(['draft:a', 'draft:b'])
  })
})
