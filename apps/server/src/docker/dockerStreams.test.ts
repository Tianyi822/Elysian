import { describe, expect, it } from 'vitest'
import { demuxDockerStream, readPullProgress } from './dockerStreams'

const encoder = new TextEncoder()
const MAX_BYTES = 64 * 1024 * 1024

function chunk(text: string): Uint8Array {
  return encoder.encode(text)
}

describe('readPullProgress', () => {
  it('无内容或仅进度行时成功', () => {
    expect(readPullProgress([])).toEqual({ ok: true })
    const line = JSON.stringify({ status: 'Downloading', progressDetail: { current: 1, total: 10 } })
    expect(readPullProgress([chunk(`${line}\n`)])).toEqual({ ok: true })
  })

  it('忽略无 error 的进度对象', () => {
    const lines = [
      JSON.stringify({ status: 'Pulling fs layer', id: 'abc' }),
      JSON.stringify({ status: 'Download complete', progressDetail: {} }),
    ].join('\n')
    expect(readPullProgress([chunk(lines)])).toEqual({ ok: true })
  })

  it('任一行含非空 error 则失败并返回该字符串', () => {
    const message = 'pull access denied for library/redis'
    const body = [
      JSON.stringify({ status: 'Downloading' }),
      JSON.stringify({ error: message }),
    ].join('\n')
    expect(readPullProgress([chunk(`${body}\n`)])).toEqual({ ok: false, error: message })
  })

  it('JSON 可在块边界切开', () => {
    const line = JSON.stringify({ status: 'Downloading', id: 'layer1' })
    const full = `${line}\n`
    const splitAt = 12
    expect(readPullProgress([chunk(full.slice(0, splitAt)), chunk(full.slice(splitAt))])).toEqual({
      ok: true,
    })
  })

  it('error 字段可在块边界切开', () => {
    const message = 'manifest unknown'
    const line = JSON.stringify({ error: message })
    const full = `${line}\n`
    const mid = 8
    expect(readPullProgress([chunk(full.slice(0, mid)), chunk(full.slice(mid))])).toEqual({
      ok: false,
      error: message,
    })
  })

  it('总字节超过 64 MiB 时返回拉取进度过大', () => {
    const over = new Uint8Array(MAX_BYTES + 1)
    expect(readPullProgress([over])).toEqual({ ok: false, error: '拉取进度过大' })
  })

  it('恰好 64 MiB 仍成功', () => {
    const exact = new Uint8Array(MAX_BYTES)
    expect(readPullProgress([exact])).toEqual({ ok: true })
  })
})

describe('demuxDockerStream', () => {
  it('8 字节头 stream 1、大端长度与载荷写入 stdout', () => {
    const payload = encoder.encode('payload!')
    const header = new Uint8Array(8)
    header[0] = 1
    header[7] = payload.length
    const frame = new Uint8Array(header.length + payload.length)
    frame.set(header, 0)
    frame.set(payload, header.length)
    const { stdout, stderr } = demuxDockerStream(frame)
    expect(stderr).toEqual(new Uint8Array(0))
    expect(stdout).toEqual(payload)
  })
})
