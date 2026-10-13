import { afterEach, describe, expect, it, vi } from 'vitest'
import { sharedSubscription } from './sharedSubscription'

function browserChannels() {
  const channels = new Set<Channel>()
  class Channel {
    onmessage: ((event: { data: unknown }) => void) | null = null
    constructor(readonly name: string) { channels.add(this) }
    postMessage(data: unknown) {
      for (const channel of channels) if (channel !== this && channel.name === this.name) {
        queueMicrotask(() => { if (channels.has(channel)) channel.onmessage?.({ data }) })
      }
    }
    close() { channels.delete(this) }
  }
  const queues = new Map<string, Promise<void>>()
  const locks = { request: vi.fn(async (name: string, { signal }: { signal: AbortSignal }, callback: () => Promise<void>) => {
    const previous = queues.get(name) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    queues.set(name, previous.then(() => held))
    await previous
    try {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError')
      await callback()
    } finally { release() }
  }) }
  vi.stubGlobal('BroadcastChannel', Channel)
  vi.stubGlobal('navigator', { locks })
}

afterEach(() => vi.unstubAllGlobals())

describe('跨页面共用展示事件连接', () => {
  it('三个前台页面只开一组连接，广播状态与事件，新页面收到最近采样', async () => {
    browserChannels()
    let emit!: (value: string) => void
    const stop = vi.fn()
    const start = vi.fn((next: typeof emit) => { emit = next; return stop })
    const receiveA = vi.fn(), receiveB = vi.fn(), receiveC = vi.fn()
    const subscribe = (receive: typeof receiveA) => sharedSubscription('events', start, receive, () => 'latest')
    const a = subscribe(receiveA), b = subscribe(receiveB)
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    emit('第一拍')
    await vi.waitFor(() => expect(receiveB).toHaveBeenCalledWith('第一拍'))
    expect(receiveA).toHaveBeenCalledWith('第一拍')
    const c = subscribe(receiveC)
    await vi.waitFor(() => expect(receiveC).toHaveBeenCalledWith('第一拍'))
    expect(start).toHaveBeenCalledOnce()
    b(); c(); a()
    await Promise.resolve()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('连接持有页离开后只交接一次，已退订页面不会收到后续事件或重新连接', async () => {
    browserChannels()
    let emit!: (value: string) => void
    const stop = vi.fn()
    const start = vi.fn((next: typeof emit) => { emit = next; return stop })
    const receiveA = vi.fn(), receiveB = vi.fn(), receiveC = vi.fn()
    const subscribe = (receive: typeof receiveA) => sharedSubscription('events', start, receive, () => undefined)
    const a = subscribe(receiveA), b = subscribe(receiveB), c = subscribe(receiveC)
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    b(); a()
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    emit('交接后的事件')
    expect(receiveC).toHaveBeenCalledWith('交接后的事件')
    expect(receiveA).not.toHaveBeenCalled()
    expect(receiveB).not.toHaveBeenCalled()
    c(); c()
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('浏览器没有跨页锁时保留原订阅与退订行为', () => {
    vi.stubGlobal('navigator', {})
    const stop = vi.fn(), receive = vi.fn()
    const start = vi.fn((emit: (value: string) => void) => { emit('就绪'); return stop })
    const dispose = sharedSubscription('events', start, receive, () => undefined)
    expect(receive).toHaveBeenCalledWith('就绪')
    dispose()
    expect(stop).toHaveBeenCalledOnce()
  })
})
