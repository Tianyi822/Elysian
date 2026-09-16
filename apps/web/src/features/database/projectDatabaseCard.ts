import type { Container, ContainerImage, DatabaseInstance } from '@elysian/contracts'
import { isFileBacked } from '@elysian/contracts'

/**
 * 卡片视图：服务型按来源容器渲染，文件型（SQLite）按文件路径渲染——
 * 两类来源的差异集中在这里，卡片的 JSX 只读视图、不判断引擎。
 */
export type DatabaseCardView =
  | {
      kind: 'container'
      container?: Container
      /** `镜像:标签`，容器缺失时为空串。 */
      imageLabel: string
      /** 来源容器在数据集里找不到：卡片如实说明，不静默留空。 */
      missingContainer: boolean
    }
  | {
      kind: 'file'
      /** 数据库文件的绝对路径。 */
      filePath: string
      /** 文件大小（MB）。 */
      fileSizeMb: number
    }

/** 按来源合成卡片视图；容器与镜像数据来自各自数据集，这里不复制它们的字段。 */
export function projectDatabaseCard(
  database: DatabaseInstance,
  containerById: ReadonlyMap<string, Container>,
  imageById: ReadonlyMap<string, ContainerImage>,
): DatabaseCardView {
  if (isFileBacked(database)) {
    return {
      kind: 'file',
      filePath: database.filePath ?? '',
      fileSizeMb: database.fileSizeMb ?? 0,
    }
  }

  const container = database.containerId ? containerById.get(database.containerId) : undefined
  if (!container) return { kind: 'container', imageLabel: '', missingContainer: true }

  const image = imageById.get(container.imageId)
  return {
    kind: 'container',
    container,
    imageLabel: image ? `${image.name}:${image.tag}` : '',
    missingContainer: false,
  }
}
