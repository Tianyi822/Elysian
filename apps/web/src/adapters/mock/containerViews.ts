import type { Container, PortMapping } from '@elysian/contracts'

/** 镜像被几个容器引用；删除前要知道有没有容器在用。 */
export function imageUsageCount(containers: readonly Container[], imageId: string): number {
  return containers.filter((c) => c.imageId === imageId).length
}

/** 卡片与详情共用的端口映射格式：容器端口 → 宿主端口/协议。 */
export function formatPort(mapping: PortMapping): string {
  return `${mapping.containerPort} → ${mapping.hostPort}/${mapping.protocol}`
}

/** 运行时长：3 天 1 小时 / 2 小时 / 40 分钟；未启动为 —。 */
export function formatUptime(startedAt: string | undefined, now: Date): string {
  if (!startedAt) return '—'
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(startedAt).getTime()) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时`
  return `${minutes} 分钟`
}
