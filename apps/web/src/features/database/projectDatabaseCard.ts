import type { Container, DatabaseContainerInstance, DatabaseInstance } from '@elysian/contracts'

/**
 * 卡片视图：容器行渲染 Docker 容器事实，文件行（SQLite）按文件路径渲染——
 * 两类行的差异集中在这里，卡片的 JSX 只读视图、不判断行类型。
 * 行类型以 engine 判别：'SQLite' 是文件行标记，容器行引擎只在三服务引擎内。
 */
export type DatabaseCardView =
  | {
      kind: 'container'
      /** 容器数据集中的完整容器行（ContainerDetailSheet 消费）；缺失时卡片如实说明。 */
      container?: Container
      /** 容器镜像的完整引用（行自带 Docker inspect 事实）。 */
      imageLabel: string
      /** 容器数据集里找不到该容器：详情入口禁用，不静默留空。 */
      missingContainer: boolean
    }
  | {
      kind: 'file'
      /** 数据库文件的绝对路径。 */
      filePath: string
      /** 文件大小（MB）。 */
      fileSizeMb?: number
    }

/** 按行类型合成卡片视图；容器行自带全部事实，容器数据集只用于就地打开详情面板。 */
export function projectDatabaseCard(
  row: DatabaseContainerInstance | DatabaseInstance,
  containerById: ReadonlyMap<string, Container>,
): DatabaseCardView {
  if (row.engine === 'SQLite') {
    return {
      kind: 'file',
      filePath: row.filePath ?? '',
      fileSizeMb: row.fileSizeMb,
    }
  }

  const container = containerById.get(row.containerId)
  return {
    kind: 'container',
    container,
    imageLabel: row.image,
    missingContainer: !container,
  }
}
