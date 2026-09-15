import type { Container, PortMapping } from '@elysian/contracts'

/** 镜像被几个容器引用；删除前要知道有没有容器在用。 */
export function imageUsageCount(containers: readonly Container[], imageId: string): number {
  return containers.filter((c) => c.imageId === imageId).length
}

/** 卡片与详情共用的端口映射格式：容器端口 → 宿主端口/协议。 */
export function formatPort(mapping: PortMapping): string {
  return `${mapping.containerPort} → ${mapping.hostPort}/${mapping.protocol}`
}
