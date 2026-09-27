/*
 * 容器域类型与词典。本期只描述本机容器的状态与配置，
 * 操作（启动/停止/重启）全部为 mock，接口形状为未来接真实运行时预留。
 */

export type ContainerStatus = 'running' | 'stopped' | 'restarting' | 'paused'

export const CONTAINER_STATUSES = [
  'running',
  'stopped',
  'restarting',
  'paused',
] as const satisfies readonly ContainerStatus[]

export const CONTAINER_STATUS_LABELS: Record<ContainerStatus, string> = {
  running: '运行中',
  stopped: '已停止',
  restarting: '重启中',
  paused: '已暂停',
}

export type RestartPolicy = 'no' | 'always' | 'on-failure' | 'unless-stopped'

export const RESTART_POLICIES = [
  'no',
  'always',
  'on-failure',
  'unless-stopped',
] as const satisfies readonly RestartPolicy[]

export const RESTART_POLICY_LABELS: Record<RestartPolicy, string> = {
  no: '不重启',
  always: '总是重启',
  'on-failure': '失败时重启',
  'unless-stopped': '除非手动停止',
}

export type PortProtocol = 'tcp' | 'udp'

/** 端口映射：容器内监听端口 → 宿主机端口。 */
export type PortMapping = {
  containerPort: number
  hostPort: number
  protocol: PortProtocol
  hostIp?: string
}

export type EnvPair = { key: string; value: string | null }

/** 绑定挂载：宿主机路径 → 容器内路径。 */
export type VolumeMount = {
  hostPath: string
  containerPath: string
  kind?: 'bind' | 'volume' | 'tmpfs'
}

export type Container = {
  id: string
  name: string
  status: ContainerStatus
  imageId: string
  imageRef?: string
  ports: readonly PortMapping[]
  /** 创建时间（ISO，相对数据集基准时间）。 */
  createdAt: string
  /** 最近一次启动时间；停止后为 undefined。 */
  startedAt?: string
  command: string
  env: readonly EnvPair[]
  volumes: readonly VolumeMount[]
  restartPolicy: RestartPolicy
}

export type ContainerImage = {
  id: string
  name: string
  tag: string
  digest: string
  /** 镜像大小（MB）。 */
  sizeMb: number
  /** 拉取时间（ISO）；未拉取或未知时为 null。 */
  pulledAt: string | null
  otherTags?: readonly string[]
}

/** Docker 拉取流中单个镜像层的实时进度；数值只来自 Engine 的 progressDetail。 */
export type ImagePullProgress = {
  phase: 'preparing' | 'downloading' | 'extracting' | 'finalizing'
  layerId?: string
  currentBytes?: number
  totalBytes?: number
}

/** 容器资源采样的单项（事件 container/sample 的载荷成员）。 */
export type ContainerSample = {
  containerId: string
  /** CPU 占用百分比。 */
  cpuPercent: number
  /** 内存占用（MB）。 */
  memMb: number
}

/** 创建容器的输入：界面表单收集后经 adapter 提交；name 留空由实现按镜像名生成唯一名。 */
export type ContainerCreateInput = {
  name?: string
  imageId: string
  ports: readonly PortMapping[]
  env: readonly EnvPair[]
  volumes: readonly VolumeMount[]
  /** 启动命令；留空表示沿用镜像默认入口。 */
  command?: string
  restartPolicy: RestartPolicy
}

/** 容器动作：启动、停止、重启。本期均为 mock。 */
export type ContainerAction = 'start' | 'stop' | 'restart'

/** 自动容器名：镜像名中的 / 换成 -，再追加不冲突的最小序号（从 2 起）。 */
export function autoContainerName(
  existing: readonly { name: string }[],
  imageName: string,
): string {
  const base = imageName.replaceAll('/', '-')
  let seq = 2
  let name = base
  while (existing.some((container) => container.name === name)) {
    name = `${base}-${seq}`
    seq += 1
  }
  return name
}
