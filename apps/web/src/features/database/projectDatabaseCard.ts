import type { Container, ContainerImage, DatabaseInstance } from '@elysian/contracts'
import { formatUptime } from '../../components/format'

export type DatabaseCardView = {
  container?: Container
  /** `镜像:标签`，容器缺失时为空串。 */
  imageLabel: string
  /** `运行 12 天 6 小时`，容器缺失或未启动时为空串。 */
  uptimeLabel: string
  /** 来源容器在数据集里找不到：卡片如实说明，不静默留空。 */
  missingContainer: boolean
}

/** 按 containerId 取来源容器并合成卡片视图；容器与镜像数据来自各自数据集，这里不复制它们的字段。 */
export function projectDatabaseCard(
  database: DatabaseInstance,
  containerById: ReadonlyMap<string, Container>,
  imageById: ReadonlyMap<string, ContainerImage>,
  now: Date,
): DatabaseCardView {
  const container = containerById.get(database.containerId)
  if (!container) return { imageLabel: '', uptimeLabel: '', missingContainer: true }

  const image = imageById.get(container.imageId)
  return {
    container,
    imageLabel: image ? `${image.name}:${image.tag}` : '',
    uptimeLabel: container.startedAt ? `运行 ${formatUptime(container.startedAt, now)}` : '',
    missingContainer: false,
  }
}
