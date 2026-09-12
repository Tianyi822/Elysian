import { describe, expect, it } from 'vitest'
import { SSE_HEARTBEAT, SseFrameParser, formatSseFrame, parseElysianEvent } from './parse'

describe('SSE 帧解析器', () => {
  it('解析命名事件、数据与事件标识', () => {
    const parser = new SseFrameParser()
    const frames = parser.push('id: evt-1\nevent: agent/status\ndata: {"ok":true}\n\n')
    expect(frames).toEqual([{ event: 'agent/status', data: '{"ok":true}', id: 'evt-1' }])
  })

  it('跨分片投喂也能拼出完整帧', () => {
    const parser = new SseFrameParser()
    expect(parser.push('event: incident/created\nda')).toEqual([])
    expect(parser.push('ta: {"a":1}\n\n')).toHaveLength(1)
  })

  it('多行 data 用换行拼接', () => {
    const parser = new SseFrameParser()
    const frames = parser.push('data: 第一行\ndata: 第二行\n\n')
    expect(frames[0]?.data).toBe('第一行\n第二行')
  })

  it('注释帧被忽略，心跳不会变成事件', () => {
    const parser = new SseFrameParser()
    expect(parser.push(SSE_HEARTBEAT)).toEqual([])
    expect(parser.push('data: x\n\n')).toHaveLength(1)
  })

  it('没有 event 字段的帧按规范当作 message', () => {
    const parser = new SseFrameParser()
    expect(parser.push('data: x\n\n')[0]?.event).toBe('message')
  })

  it('没有 data 的帧不派发', () => {
    const parser = new SseFrameParser()
    expect(parser.push('event: agent/status\n\n')).toEqual([])
  })

  it('retry 字段被解析，非法值被忽略', () => {
    const parser = new SseFrameParser()
    expect(parser.push('retry: 5000\ndata: x\n\n')[0]?.retry).toBe(5000)
    expect(parser.push('retry: abc\ndata: y\n\n')[0]?.retry).toBeUndefined()
  })

  it('记录最后一条事件标识，供断线续传回送', () => {
    const parser = new SseFrameParser()
    parser.push('id: evt-7\ndata: a\n\n')
    parser.push('id: evt-8\ndata: b\n\n')
    expect(parser.lastEventId).toBe('evt-8')
  })

  it('含 NUL 的标识按规范忽略', () => {
    const parser = new SseFrameParser()
    parser.push('id: bad\u0000id\ndata: a\n\n')
    expect(parser.lastEventId).toBeUndefined()
  })

  it('兼容 CRLF 与 CR 换行', () => {
    const crlf = new SseFrameParser()
    expect(crlf.push('event: a\r\ndata: 1\r\n\r\n')).toHaveLength(1)
    const cr = new SseFrameParser()
    expect(cr.push('event: a\rdata: 1\r\r')).toHaveLength(1)
  })

  it('连续多帧与乱序到达都各自成形', () => {
    const parser = new SseFrameParser()
    const frames = parser.push('event: a\ndata: 1\n\nevent: b\ndata: 2\n\ndata: 3\n\n')
    expect(frames.map((frame) => frame.event)).toEqual(['a', 'b', 'message'])
    expect(frames.map((frame) => frame.data)).toEqual(['1', '2', '3'])
  })

  it('未知字段被忽略，不影响同一帧的数据', () => {
    const parser = new SseFrameParser()
    const frames = parser.push('foo: bar\ndata: x\n\n')
    expect(frames[0]?.data).toBe('x')
  })

  it('data 值只去掉一个前导空格', () => {
    const parser = new SseFrameParser()
    expect(parser.push('data: 一个空格\n\n')[0]?.data).toBe('一个空格')
    expect(parser.push('data:  两个空格\n\n')[0]?.data).toBe(' 两个空格')
  })
})

describe('SSE 帧序列化', () => {
  it('生成的帧能被解析器原样还原', () => {
    const text = formatSseFrame({
      id: 'evt-1',
      event: 'approval/asked',
      data: { approvalId: 'APR-1' },
    })
    const frames = new SseFrameParser().push(text)
    expect(frames).toHaveLength(1)
    expect(frames[0]?.id).toBe('evt-1')
    expect(frames[0]?.event).toBe('approval/asked')
    expect(JSON.parse(frames[0]?.data ?? '')).toEqual({ approvalId: 'APR-1' })
  })

  it('重连间隔写成 retry 字段', () => {
    const text = formatSseFrame({ id: 'evt-2', event: 'agent/status', data: {}, retryMs: 2500 })
    expect(text).toContain('retry: 2500')
    expect(new SseFrameParser().push(text)[0]?.retry).toBe(2500)
  })
})

describe('事件信封还原', () => {
  const valid = {
    id: 'evt-9',
    name: 'incident/updated',
    at: '2026-09-12T08:00:00.000Z',
    payload: { incidentId: 'INC-2100' },
  }

  it('合法信封可以还原', () => {
    const event = parseElysianEvent(JSON.stringify(valid))
    expect(event?.id).toBe('evt-9')
    expect(event?.name).toBe('incident/updated')
  })

  it('内容不是 JSON、字段不全或事件名未知时返回 undefined 而不抛错', () => {
    expect(parseElysianEvent('这不是 JSON')).toBeUndefined()
    expect(parseElysianEvent('{"id":"evt-1"}')).toBeUndefined()
    expect(parseElysianEvent('null')).toBeUndefined()
    expect(
      parseElysianEvent(JSON.stringify({ ...valid, name: 'unknown/event' })),
    ).toBeUndefined()
  })
})
