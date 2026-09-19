import { describe, expect, it } from 'vitest'
import { parseSsListening } from './parseSockets'

describe('parseSsListening', () => {
  it('解析容器内真实 ss -Hultn 输出为监听键集合', () => {
    const listeners = parseSsListening(`udp UNCONN 0      0      127.0.0.11:37622 0.0.0.0:*
tcp LISTEN 0      4096   127.0.0.11:35573 0.0.0.0:*
tcp LISTEN 0      512             *:5173        *:*
tcp LISTEN 0      128          [::]:22             [::]:*`)
    expect(listeners.has('udp:37622')).toBe(true)
    expect(listeners.has('tcp:35573')).toBe(true)
    expect(listeners.has('tcp:5173')).toBe(true)
    expect(listeners.has('tcp:22')).toBe(true)
    expect(listeners.size).toBe(4)
  })

  it('非监听状态与无法识别的行被忽略', () => {
    const listeners = parseSsListening(`tcp ESTAB 0      0      10.0.0.2:5432 10.0.0.9:443
garbage line
`)
    expect(listeners.size).toBe(0)
  })
})
