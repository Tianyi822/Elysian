import type { Container, ContainerImage, DatabaseInstance } from '@elysian/contracts'

export type DatabaseCardView = {
  container?: Container
  /** `镜像:标签`，容器缺失时为空串。 */
  imageLabel: string
  /** 来源容器在数据集里找不到：卡片如实说明，不静默留空。 */
  missingContainer: boolean
}

/** 按 containerId 取来源容器并合成卡片视图；容器与镜像数据来自各自数据集，这里不复制它们的字段。 */
export function projectDatabaseCard(
  database: DatabaseInstance,
  containerById: ReadonlyMap<string, Container>,
  imageById: ReadonlyMap<string, ContainerImage>,
): DatabaseCardView {
  const container = containerById.get(database.containerId)
  if (!container) return { imageLabel: '', missingContainer: true }

  const image = imageById.get(container.imageId)
  return {
    container,
    imageLabel: image ? `${image.name}:${image.tag}` : '',
    missingContainer: false,
  }
}
