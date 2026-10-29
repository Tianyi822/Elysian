import { describe, expect, it, vi } from 'vitest'
import { createMessageLocalAdapter } from './messageLocalAdapter'
import { createMessageStore } from '../../stores/messageStore'
import type { FeedbackMessage } from '../../contracts/messages'

let sequence = 0
const message = (id: string, occurredAt = '2026-10-29T05:00:00.000Z'): FeedbackMessage => ({ id, occurredAt, message: id, tone: 'info', read: false })
describe('本地消息事务与标签页同步', () => {
  it('相同时间按稳定 ID 倒序分页，不遗漏或重复边界记录', async () => {
    const adapter = createMessageLocalAdapter(`message-adapter-${++sequence}`)
    for (const id of ['a', 'B', '9', 'z']) await adapter.put(message(id))
    await adapter.put(message('newest', '2026-10-29T05:01:00.000Z'))
    const first = await adapter.list(undefined, 3)
    expect(first.messages.map(item => item.id)).toEqual(['newest', 'z', 'a'])
    const second = await adapter.list(first.cursor, 3)
    expect(second.messages.map(item => item.id)).toEqual(['B', '9'])
    expect(second.cursor).toBeUndefined()
  })

  it('事务中止时保留所有记录，重试清空后不恢复', async () => {
    const adapter = createMessageLocalAdapter(`message-adapter-${++sequence}`)
    await adapter.put(message('keep'))
    const transaction = IDBDatabase.prototype.transaction
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(function (this: IDBDatabase, ...args: Parameters<typeof transaction>) {
      const tx = transaction.apply(this, args)
      queueMicrotask(() => tx.abort())
      return tx
    })
    await expect(adapter.clear()).rejects.toThrow()
    spy.mockRestore()
    expect((await adapter.list()).messages.map(item => item.id)).toEqual(['keep'])
    await adapter.clear()
    expect((await adapter.list()).messages).toEqual([])
  })

  it('两个独立标签页同步新增、展开期间已读和清空，已读广播不会循环', async () => {
    const name = `message-adapter-${++sequence}`
    const firstAdapter = createMessageLocalAdapter(name)
    const secondAdapter = createMessageLocalAdapter(name)
    const first = createMessageStore(firstAdapter)
    const second = createMessageStore(secondAdapter)
    const stopFirst = first.getState().subscribe()
    const stopSecond = second.getState().subscribe()
    try {
      await Promise.all([first.getState().flush(), second.getState().flush()])
      first.getState().notify({ tone: 'success', message: '跨标签消息' })
      await vi.waitFor(() => expect(second.getState().messages).toHaveLength(1))
      expect(second.getState().unread).toBe(true)
      second.getState().setViewing(true)
      await vi.waitFor(() => expect(first.getState().unread).toBe(false))
      first.getState().notify({ tone: 'info', message: '另一页已展开' })
      await vi.waitFor(() => expect(second.getState().messages).toHaveLength(2))
      await vi.waitFor(() => expect(first.getState().unread).toBe(false))
      const reads = vi.spyOn(secondAdapter, 'list')
      await first.getState().clear()
      await vi.waitFor(() => expect(second.getState().messages).toEqual([]))
      expect(reads.mock.calls.length).toBeLessThan(8)
    } finally { stopFirst(); stopSecond() }
  })
})
