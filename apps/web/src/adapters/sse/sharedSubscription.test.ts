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
  it.each(['constructor', 'hello', 'request', 'rejection'])('共享能力在 %s 阶段失败时保留直接订阅并能退出', async failure => {
    browserChannels()
    const close = vi.fn()
    if (failure === 'constructor' || failure === 'hello') {
      vi.stubGlobal('BroadcastChannel', class {
        onmessage = null
        constructor() { if (failure === 'constructor') throw new DOMException('blocked', 'SecurityError') }
        postMessage() { throw new DOMException('blocked', 'SecurityError') }
        close = close
      })
    } else if (failure === 'request') vi.mocked(navigator.locks.request).mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    else vi.mocked(navigator.locks.request).mockRejectedValue(new DOMException('blocked', 'SecurityError'))
    const stop = vi.fn(), receive = vi.fn()
    const start = vi.fn((emit: (value: string) => void) => { emit('真实采样'); return stop })
    const dispose = sharedSubscription('blocked-events', start, receive, () => 'latest')
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
    expect(receive).toHaveBeenCalledWith('真实采样')
    if (failure === 'hello') expect(close).toHaveBeenCalledOnce()
    dispose()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('广播在持有连接后失败时释放旧连接，只保留一条直接订阅', async () => {
    browserChannels()
    let posts = 0
    vi.stubGlobal('BroadcastChannel', class {
      onmessage = null
      postMessage() { if (++posts > 1) throw new DOMException('blocked', 'SecurityError') }
      close() {}
    })
    const stop = vi.fn(), receive = vi.fn()
    const start = vi.fn((emit: (value: string) => void) => { emit('首拍'); return stop })
    const dispose = sharedSubscription('failed-broadcast', start, receive, () => 'latest')
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2))
    expect(stop).toHaveBeenCalledOnce()
    dispose()
    await Promise.resolve()
    expect(stop).toHaveBeenCalledTimes(2)
  })

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
