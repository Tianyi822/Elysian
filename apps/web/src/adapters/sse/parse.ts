import { EVENT_NAMES } from '@elysian/contracts'
import type { ElysianEvent, EventName } from '@elysian/contracts'

/**
 * SSE 帧的解析与序列化，严格按 text/event-stream 规范。
 *
 * 这一层刻意不依赖 EventSource 也不依赖服务端：帧解析是纯函数，
 * 因此多行 data、注释帧心跳、retry、断线续传与乱序到达都能直接测。
 *
 * 当前运行时路径用的是浏览器原生 EventSource（它自己完成帧解析与断线重连），
 * 所以 `SseFrameParser` 在日常请求里不会被调用。它的作用有两条：
 * 一是把线上格式写成可执行的定义，供 mock 端点序列化、供测试断言；
 * 二是一旦将来换成基于 fetch 的传输（原生事件源不可用，或需要自定义重连策略），
 * 解析器就是现成的实现，不必重新对着规范写一遍。
 */

export type SseFrame = {
  event: string
  data: string
  id?: string
  retry?: number
}

/** 没有 event 字段的帧按规范当作 message。 */
const DEFAULT_EVENT_NAME = 'message'

/** 心跳帧：注释行，客户端解析器会忽略它，但连接因此不会被中间层判定为空闲。 */
export const SSE_HEARTBEAT = ': keep-alive\n\n'

export class SseFrameParser {
  private buffer = ''
  private dataLines: string[] = []
  private eventName: string | undefined
  private lastId: string | undefined
  private retry: number | undefined

  /** 最后一条事件的标识，断线重连时回送给服务端。 */
  get lastEventId(): string | undefined {
    return this.lastId
  }

  /** 投喂一段字节流，返回其中已经完整的帧。不完整的行留在缓冲里等下一次。 */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk
    const frames: SseFrame[] = []

    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer)
      if (!match) break
      const line = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      const frame = this.handleLine(line)
      if (frame) frames.push(frame)
    }

    return frames
  }

  private handleLine(line: string): SseFrame | undefined {
    if (line === '') return this.dispatch()
    // 注释帧：心跳用，不派发。
    if (line.startsWith(':')) return undefined

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'event':
        this.eventName = value
        break
      case 'data':
        this.dataLines.push(value)
        break
      case 'id':
        // 规范：包含 NUL 的 id 必须忽略。
        if (!value.includes('\u0000')) this.lastId = value
        break
      case 'retry': {
        const parsed = Number.parseInt(value, 10)
        if (Number.isFinite(parsed) && parsed >= 0) this.retry = parsed
        break
      }
      default:
        break
    }

    return undefined
  }

  private dispatch(): SseFrame | undefined {
    if (this.dataLines.length === 0) {
      // 规范：没有 data 的帧不派发。
      this.eventName = undefined
      return undefined
    }

    const frame: SseFrame = {
      event: this.eventName ?? DEFAULT_EVENT_NAME,
      data: this.dataLines.join('\n'),
      ...(this.lastId === undefined ? {} : { id: this.lastId }),
      ...(this.retry === undefined ? {} : { retry: this.retry }),
    }

    this.dataLines = []
    this.eventName = undefined
    this.retry = undefined
    return frame
  }
}

/** 把一帧序列化成线上格式。data 即使含换行也会被拆成多行 data 字段。 */
export function formatSseFrame(frame: {
  id: string
  event: string
  data: unknown
  retryMs?: number
}): string {
  const lines = [`id: ${frame.id}`, `event: ${frame.event}`]
  for (const line of JSON.stringify(frame.data).split('\n')) {
    lines.push(`data: ${line}`)
  }
  if (frame.retryMs !== undefined) lines.push(`retry: ${frame.retryMs}`)
  return `${lines.join('\n')}\n\n`
}

function isEventName(value: unknown): value is EventName {
  return typeof value === 'string' && (EVENT_NAMES as readonly string[]).includes(value)
}

/** 把帧里的 data 还原成事件信封。字段不全或事件名未知时返回 undefined，不抛错。 */
export function parseElysianEvent(raw: string): ElysianEvent | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }

  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  const { id, name, at, payload } = candidate

  if (typeof id !== 'string' || typeof at !== 'string' || !isEventName(name)) return undefined

  // payload 的具体形状由 name 决定，这里只校验信封字段；业务侧按 name 收窄后再读 payload。
  return { id, name, at, payload } as ElysianEvent
}
