import type { Container, ContainerImage, DatabaseEngine, DatabaseInstance } from '@elysian/contracts'
import type { DatabaseCreateInput } from '../../contracts/adapters'

/**
 * 添加数据库表单的草稿与校验：纯函数、无 React 依赖。
 * 访问权限与字符集是演示取值，随表单提交、由真实实现落到服务端。
 */

export type DatabaseAccessScope = 'localhost' | 'container-network' | 'any-host'

export const DATABASE_ACCESS_SCOPES = [
  'localhost',
  'container-network',
  'any-host',
] as const satisfies readonly DatabaseAccessScope[]

export const DATABASE_ACCESS_SCOPE_LABELS: Record<DatabaseAccessScope, string> = {
  localhost: '仅本机（localhost）',
  'container-network': '容器网络内',
  'any-host': '任意主机（%）',
}

/** 字符集候选；只对 SQL 引擎展示，其余引擎不收集该字段。 */
export const DATABASE_CHARSET_OPTIONS = ['utf8mb4', 'utf8mb3', 'latin1', 'ascii'] as const

export type DatabaseCreateDraft = {
  name: string
  charset: string
  username: string
  password: string
  accessScope: DatabaseAccessScope
  containerId: string
}

export function emptyDraft(engine: DatabaseEngine): DatabaseCreateDraft {
  return {
    name: '',
    charset: engine === 'MariaDB' || engine === 'MySQL' ? 'utf8mb4' : '',
    username: '',
    password: '',
    accessScope: 'localhost',
    containerId: '',
  }
}

/** 字段级错误：undefined 表示无错；首次提交前不展示。 */
export type DatabaseCreateFormErrors = {
  name?: string
  username?: string
  password?: string
  containerId?: string
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

export function validateDatabaseCreateDraft(
  draft: DatabaseCreateDraft,
  existing: readonly DatabaseInstance[],
  engine: DatabaseEngine,
): DatabaseCreateFormErrors {
  const errors: DatabaseCreateFormErrors = {}

  const name = draft.name.trim()
  if (!name) errors.name = '请填写数据库名'
  else if (!NAME_PATTERN.test(name)) errors.name = '只能包含字母、数字、下划线与连字符，且以字母或数字开头'
  else if (existing.some((item) => item.engine === engine && item.name === name))
    errors.name = '该引擎下已有同名数据库'

  if (!draft.username.trim()) errors.username = '请填写用户名'
  if (!draft.password) errors.password = '请填写密码'
  if (!draft.containerId) errors.containerId = '请选择承载容器'

  return errors
}

export function hasDatabaseCreateErrors(errors: DatabaseCreateFormErrors): boolean {
  return Object.values(errors).some(Boolean)
}

export function toDatabaseCreateInput(
  draft: DatabaseCreateDraft,
  engine: DatabaseEngine,
): DatabaseCreateInput {
  return {
    engine,
    name: draft.name.trim(),
    charset: engine === 'MariaDB' || engine === 'MySQL' ? draft.charset : undefined,
    username: draft.username.trim(),
    password: draft.password,
    accessScope: draft.accessScope,
    containerId: draft.containerId,
  }
}

/** 引擎与镜像名的对应关系：只把运行中、且镜像名匹配该引擎家族的容器列为承载候选。 */
const ENGINE_IMAGE_PREFIX: Partial<Record<DatabaseEngine, string>> = {
  MariaDB: 'mariadb',
  MySQL: 'mysql',
  Redis: 'redis',
}

export function containersForEngine(
  engine: DatabaseEngine,
  containers: readonly Container[],
  images: readonly ContainerImage[],
): Container[] {
  const prefix = ENGINE_IMAGE_PREFIX[engine]
  if (!prefix) return []
  const imageNameById = new Map(images.map((image) => [image.id, image.name]))
  return containers.filter(
    (container) =>
      container.status === 'running' && imageNameById.get(container.imageId)?.startsWith(prefix),
  )
}

/** 演示密码生成：16 位大小写字母与数字，仅用于表单快捷填充（用户触发，不进确定性数据集）。 */
export function generateDemoPassword(length = 16): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let password = ''
  for (let i = 0; i < length; i += 1) {
    password += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return password
}
