import { describe, expect, it } from 'vitest'
import { CONTAINERS } from './containersData'
import { formatPort, formatUptime, imageUsageCount } from './containerViews'

describe('容器视图纯函数', () => {
  it('镜像引用数按容器列表独立计数', () => {
    expect(imageUsageCount(CONTAINERS, 'img-node')).toBe(4)
    expect(imageUsageCount(CONTAINERS, 'img-grafana')).toBe(0)
  })

  it('端口格式为「容器端口 → 宿主端口/协议」', () => {
    expect(formatPort({ containerPort: 80, hostPort: 8080, protocol: 'tcp' })).toBe('80 → 8080/tcp')
    expect(formatPort({ containerPort: 24224, hostPort: 24224, protocol: 'udp' })).toBe('24224 → 24224/udp')
  })

  it('运行时长按天/小时/分钟分档，未启动显示 —', () => {
    const now = new Date('2026-09-12T12:00:00.000Z')
    expect(formatUptime('2026-09-09T10:30:00.000Z', now)).toBe('3 天 1 小时')
    expect(formatUptime('2026-09-12T09:30:00.000Z', now)).toBe('2 小时')
    expect(formatUptime('2026-09-12T11:20:00.000Z', now)).toBe('40 分钟')
    expect(formatUptime(undefined, now)).toBe('—')
  })
})
