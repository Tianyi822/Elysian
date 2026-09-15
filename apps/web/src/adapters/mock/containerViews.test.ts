import { describe, expect, it } from 'vitest'
import { CONTAINERS } from './containersData'
import { formatPort, imageUsageCount } from './containerViews'

describe('容器视图纯函数', () => {
  it('镜像引用数按容器列表独立计数', () => {
    expect(imageUsageCount(CONTAINERS, 'img-node')).toBe(4)
    expect(imageUsageCount(CONTAINERS, 'img-grafana')).toBe(0)
  })

  it('端口格式为「容器端口 → 宿主端口/协议」', () => {
    expect(formatPort({ containerPort: 80, hostPort: 8080, protocol: 'tcp' })).toBe('80 → 8080/tcp')
    expect(formatPort({ containerPort: 24224, hostPort: 24224, protocol: 'udp' })).toBe('24224 → 24224/udp')
  })
})
