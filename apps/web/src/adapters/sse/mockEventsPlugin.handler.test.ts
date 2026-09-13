import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEventsHandler, eventIdAt } from './mockEventsPlugin'

/**
 * 端点处理器的行为测试。这里曾出过真实事故：
 * 补发循环的计数器丢失导致死循环，服务器在空转时被无限写帧耗尽内存——
 * 因此处理器必须有直接驱动的测试：断言写入有界、断言终止、断言帧内容与顺序。
 */

function createStubStream(url = '/api/events', lastEventId?: string) {
  const headers: Record<string, string> = lastEventId ? { 'last-event-id': lastEventId } : {}
  const req = {
    method: 'GET',
    url,
    headers,
    on: () => {},
  } as unknown as IncomingMessage

  const written: string[] = []
  const res = {
    statusCode: 200,
    writeHead: () => {},
    setHeader: () => {},
    write: (chunk: string) => {
      written.push(chunk)
    },
    end: () => {},
    on: () => {},
  } as unknown as ServerResponse

  return { req, res, written }
}

function parseFrames(written: readonly string[]) {
  // 每次 write 是一个完整的多行帧；按行解析出事件标识与事件名。
  const ids = written.flatMap((frame) =>
    frame
      .split('\n')
      .filter((line) => line.startsWith('id: '))
      .map((line) => line.slice(4).trim()),
  )
  const names = written
    .map((frame) => /^event: (.+)$/m.exec(frame)?.[1])
    .filter((name): name is string => Boolean(name))
  return { ids, names }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('事件流端点处理器', () => {
  it('补发有界数量的帧后返回，不会死循环写帧', () => {
    const handler = createEventsHandler()
    const { req, res, written } = createStubStream()

    // 回归守卫：补发循环一旦失去计数器，这里会无限写帧直接挂死测试。
    handler(req, res)

    const { ids } = parseFrames(written)
    // 一个 retry 行 + 每帧一次 write
    expect(written.length).toBe(ids.length + 1)
    expect(written.length).toBeLessThan(20)
    // 事件标识严格连续递增（起点取决于全局序列，相对断言以兼容乱序测试）
    const sequences = ids.map((id) => Number(id.replace('evt-', '')))
    for (let index = 1; index < sequences.length; index += 1) {
      const previous = sequences[index - 1]
      const current = sequences[index]
      expect(previous !== undefined && current !== undefined && current === previous + 1).toBe(true)
    }
    expect(written[0]).toContain('retry:')
  })

  it('补发帧是资源采样与计划内事件交替到达', () => {
    const handler = createEventsHandler()
    const { req, res, written } = createStubStream()

    handler(req, res)

    const { names } = parseFrames(written)
    expect(names).toContain('resource/sample')
    expect(names.some((name) => name !== 'resource/sample')).toBe(true)
  })

  it('每一拍推进一个事件 id；第 8 拍诞生第一例实时新事故', () => {
    vi.useFakeTimers()
    const handler = createEventsHandler()
    const { req, res, written } = createStubStream()
    handler(req, res)

    // 本连接的已发生拍数 = resource/sample 条数（每拍恰好一条）。
    const ticksSoFar = () =>
      parseFrames(written).names.filter((name) => name === 'resource/sample').length

    expect(ticksSoFar()).toBe(3)
    expect(
      parseFrames(written).names.filter((name) => name === 'incident/created'),
    ).toHaveLength(0)

    // 推进到本连接第 8 拍：第一次实时新事故诞生，且只有一次。
    vi.advanceTimersByTime(2_500 * (8 - ticksSoFar()))

    expect(ticksSoFar()).toBe(8)
    expect(
      parseFrames(written).names.filter((name) => name === 'incident/created'),
    ).toHaveLength(1)
    const createdFrame = written.find((frame) => frame.includes('incident/created'))
    expect(createdFrame).toContain('INC-LIVE-1')

    // 再过 8 拍又诞生一次，序号递增。
    vi.advanceTimersByTime(2_500 * 8)
    expect(
      parseFrames(written).names.filter((name) => name === 'incident/created'),
    ).toHaveLength(2)
    const secondFrame = written.find((frame) => frame.includes('INC-LIVE-2'))
    expect(secondFrame).toBeDefined()
  })

  it('续传客户端从其标识之后继续，已投递的帧不重发', () => {
    const handler = createEventsHandler()
    const { req, res, written } = createStubStream('/api/events', 'evt-2')

    handler(req, res)

    const { ids } = parseFrames(written)
    expect(ids[0]).toBe('evt-3')
    expect(ids).not.toContain('evt-2')
  })

  it('非 GET 请求返回 405 且不写任何帧', () => {
    const handler = createEventsHandler()
    const { req, res, written } = createStubStream()
    ;(req as { method: string }).method = 'POST'

    handler(req, res)

    expect(res.statusCode).toBe(405)
    expect(written).toHaveLength(0)
  })

  it('事件标识可解析回序号（续传协议的一致性）', () => {
    expect(eventIdAt(42)).toBe('evt-42')
  })
})
