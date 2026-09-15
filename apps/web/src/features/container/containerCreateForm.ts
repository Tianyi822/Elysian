import type {
  Container,
  ContainerCreateInput,
  EnvPair,
  PortMapping,
  PortProtocol,
  RestartPolicy,
  VolumeMount,
} from '@elysian/contracts'

/**
 * 创建容器表单的草稿与校验：纯函数、无 React 依赖。
 * 端口在草稿里存字符串（输入中允许未完成态），提交时 toCreateInput 再转数字。
 */

export type PortDraftRow = { containerPort: string; hostPort: string; protocol: PortProtocol }
export type EnvDraftRow = { key: string; value: string }
export type VolumeDraftRow = { hostPath: string; containerPath: string }

export type ContainerCreateDraft = {
  imageId: string
  name: string
  ports: PortDraftRow[]
  env: EnvDraftRow[]
  volumes: VolumeDraftRow[]
  command: string
  restartPolicy: RestartPolicy
}

export function emptyDraft(): ContainerCreateDraft {
  return {
    imageId: '',
    name: '',
    ports: [],
    env: [],
    volumes: [],
    command: '',
    restartPolicy: 'no',
  }
}

/** 行级错误：undefined 表示该行（或该字段）无错。 */
export type CreateFormErrors = {
  imageId?: string
  name?: string
  ports: ReadonlyArray<{ containerPort?: string; hostPort?: string } | undefined>
  env: ReadonlyArray<{ key?: string } | undefined>
  volumes: ReadonlyArray<{ hostPath?: string; containerPath?: string } | undefined>
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
const PORT_PATTERN = /^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/

export function validateCreateDraft(
  draft: ContainerCreateDraft,
  existing: readonly Container[],
): CreateFormErrors {
  const errors: CreateFormErrors = { ports: [], env: [], volumes: [] }

  if (!draft.imageId) errors.imageId = '请选择镜像'

  const name = draft.name.trim()
  if (name) {
    if (!NAME_PATTERN.test(name)) {
      errors.name = '名称须以字母或数字开头，仅含字母、数字、下划线、点与连字符'
    } else if (existing.some((container) => container.name === name)) {
      errors.name = '容器名称已存在'
    }
  }

  const usedHostPorts = new Set(existing.flatMap((c) => c.ports.map((p) => p.hostPort)))
  const formHostPortCounts = new Map<number, number>()
  for (const row of draft.ports) {
    if (PORT_PATTERN.test(row.hostPort)) {
      const port = Number(row.hostPort)
      formHostPortCounts.set(port, (formHostPortCounts.get(port) ?? 0) + 1)
    }
  }
  errors.ports = draft.ports.map((row) => {
    if (!row.containerPort && !row.hostPort) return undefined
    const rowErrors: { containerPort?: string; hostPort?: string } = {}
    if (!PORT_PATTERN.test(row.containerPort)) {
      rowErrors.containerPort = '容器端口须为 1-65535 的整数'
    }
    if (!PORT_PATTERN.test(row.hostPort)) {
      rowErrors.hostPort = '宿主端口须为 1-65535 的整数'
    } else {
      const hostPort = Number(row.hostPort)
      if ((formHostPortCounts.get(hostPort) ?? 0) > 1 || usedHostPorts.has(hostPort)) {
        rowErrors.hostPort = '宿主端口已被占用'
      }
    }
    return rowErrors.containerPort || rowErrors.hostPort ? rowErrors : undefined
  })

  const seenEnvKeys = new Set<string>()
  errors.env = draft.env.map((row) => {
    if (!row.key && !row.value) return undefined
    if (!row.key) return { key: '变量名不能为空' }
    if (seenEnvKeys.has(row.key)) return { key: '变量名重复' }
    seenEnvKeys.add(row.key)
    return undefined
  })

  const seenContainerPaths = new Set<string>()
  errors.volumes = draft.volumes.map((row) => {
    if (!row.hostPath && !row.containerPath) return undefined
    const rowErrors: { hostPath?: string; containerPath?: string } = {}
    if (!row.hostPath) rowErrors.hostPath = '宿主机路径不能为空'
    if (!row.containerPath) {
      rowErrors.containerPath = '容器路径不能为空'
    } else if (seenContainerPaths.has(row.containerPath)) {
      rowErrors.containerPath = '容器路径重复'
    } else {
      seenContainerPaths.add(row.containerPath)
    }
    return rowErrors.hostPath || rowErrors.containerPath ? rowErrors : undefined
  })

  return errors
}

export function hasCreateErrors(errors: CreateFormErrors): boolean {
  return Boolean(
    errors.imageId ||
      errors.name ||
      errors.ports.some(Boolean) ||
      errors.env.some(Boolean) ||
      errors.volumes.some(Boolean),
  )
}

/** 草稿转提交输入：全空行直接丢弃，名称与命令去空白后为空则转 undefined。 */
export function toCreateInput(draft: ContainerCreateDraft): ContainerCreateInput {
  const ports: PortMapping[] = draft.ports
    .filter((row) => row.containerPort && row.hostPort)
    .map((row) => ({
      containerPort: Number(row.containerPort),
      hostPort: Number(row.hostPort),
      protocol: row.protocol,
    }))
  const env: EnvPair[] = draft.env
    .filter((row) => row.key)
    .map((row) => ({ key: row.key, value: row.value }))
  const volumes: VolumeMount[] = draft.volumes
    .filter((row) => row.hostPath && row.containerPath)
    .map((row) => ({ hostPath: row.hostPath, containerPath: row.containerPath }))
  return {
    name: draft.name.trim() || undefined,
    imageId: draft.imageId,
    ports,
    env,
    volumes,
    command: draft.command.trim() || undefined,
    restartPolicy: draft.restartPolicy,
  }
}
