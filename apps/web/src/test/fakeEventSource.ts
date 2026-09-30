import type { EventSourceLike } from '../adapters/sse/eventsAdapter'

/**
 * 事件源的测试替身。SSE 适配器本身与「适配器契约」测试都用它，
 * 因此放在测试工具里而不是某个测试文件内部。
 */
export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = []

  static reset(): void {
    FakeEventSource.instances = []
  }

  static latest(): FakeEventSource | undefined {
    return FakeEventSource.instances.at(-1)
  }

  readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>()
  private readonly statusCommentHandlers = new Set<(status: 'live' | 'connecting') => void>()
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  /** 与真实事件源一致：关闭之后监听器与回调全部失效，不再向订阅者派发任何东西。 */
  close(): void {
    this.closed = true
    this.listeners.clear()
    this.statusCommentHandlers.clear()
    this.onopen = null
    this.onerror = null
  }

  registerStatusCommentHandler(handler: (status: 'live' | 'connecting') => void): () => void {
    this.statusCommentHandlers.add(handler)
    return () => {
      this.statusCommentHandlers.delete(handler)
    }
  }

  /** 投递 SSE 注释行（不含末尾换行），支持 `: status connecting` 和 `: status live`。 */
  emitCommentLine(line: string): void {
    if (!line.startsWith(':')) return
    const comment = line.slice(1).trimStart()
    if (comment !== 'status connecting' && comment !== 'status live') return
    for (const handler of this.statusCommentHandlers) {
      handler(comment === 'status live' ? 'live' : 'connecting')
    }
  }

  emitOpen(): void {
    this.onopen?.(new Event('open'))
  }

  emitError(): void {
    this.onerror?.(new Event('error'))
  }

  /** 投递一帧原始数据（不自动构造信封，便于测试坏数据）。 */
  emitRaw(name: string, data: string): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({ data } as MessageEvent<string>)
    }
  }

  /** 投递一个合法的命名事件。 */
  emit(name: string, envelope: unknown): void {
    this.emitRaw(name, JSON.stringify(envelope))
  }
}
