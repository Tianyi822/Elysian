import registryPresets from '../../../../server-go/internal/docker/registry-presets.json'
import { abortableDelay, throwIfAborted } from '../../utils/abortable'
import {
  effectivePortHostIp,
  hostPortBindingsOverlap,
} from '../../features/container/containerCreateForm'
import {
  isOfficialImageRegistry,
} from '@elysian/contracts'
import type {
  Container,
  ContainerAction,
  ContainerApp,
  ContainerAppFile,
  ContainerBuildLogs,
  ContainerBuildPlan,
  ContainerBuildPreviewInput,
  ContainerBuildSubmitInput,
  ContainerBuildTask,
  ContainerCreateInput,
  ContainerCreateResult,
  ComposeCheckResult,
  ContainerImage,
  ImagePullProgress,
  ElysianEvent,
  Unsubscribe,
} from '@elysian/contracts'
import type {
  ContainerAdapter,
  HostTerminalHandlers,
  HostTerminalSessionInfo,
} from '../../contracts/adapters'
import { mockImageArtifact } from './containersData'
import { autoContainerName } from '@elysian/contracts'
import { MockContainerTerminal } from './containerMockTerminal'
import { MockContainerWorkspace, type MockContainerWorkspaceOptions } from './containerMockWorkspace'
import type { MockDataset } from './dataset'

export class MockContainerAdapter implements ContainerAdapter {
  readonly terminalMode = 'repl' as const
  private readonly terminal: MockContainerTerminal
  private readonly workspace: MockContainerWorkspace

  constructor(
    private readonly dataset: () => MockDataset,
    private readonly hooks: {
      onAction: (containerId: string) => void
      scheduleRestart: (containerId: string) => void
      onCreate: (containerId: string) => void
      onRemove?: (containerId: string) => void
    },
    options: MockContainerWorkspaceOptions = {},
  ) {
    this.terminal = new MockContainerTerminal(dataset)
    this.workspace = new MockContainerWorkspace(options)
  }

  async list(): Promise<readonly Container[]> {
    return [...this.dataset().containers]
  }

  async listImages(): Promise<readonly ContainerImage[]> {
    return [...this.dataset().images]
  }

  async listRegistryPresets() {
    return registryPresets.map((preset) => ({ ...preset }))
  }

  async searchImageNames(term: string, registry?: string): Promise<{ names: readonly string[]; searchable: boolean }> {
    if (!isOfficialImageRegistry(registry ?? '')) {
      return { names: [], searchable: false }
    }
    const repositories = [...new Set([
      'alpine', 'busybox', 'docker', 'mysql', 'nginx', 'node', 'postgres', 'redis', 'ubuntu',
      ...this.dataset().images.map((image) => image.name),
    ])].sort()
    const query = term.trim().toLowerCase()
    return { names: repositories.filter((name) => name.includes(query)), searchable: true }
  }

  async imageTags(name: string, registry?: string): Promise<{ tags: readonly string[]; searchable: boolean }> {
    if (!isOfficialImageRegistry(registry ?? '')) {
      return { tags: [], searchable: false }
    }
    const examples: Record<string, string[]> = {
      alpine: ['latest', '3.21', '3.20'],
      nginx: ['latest', '1.27', '1.26-alpine'],
      redis: ['latest', '8-alpine', '7-alpine'],
      ubuntu: ['latest', '24.04', '22.04'],
    }
    const tags = examples[name] ?? ['latest']
    return { tags: [...new Set([...tags, ...this.dataset().images.filter((image) => image.name === name).map((image) => image.tag)])], searchable: true }
  }

  async probeRegistry(): Promise<{ ok: boolean; reason?: string }> {
    // 演示模式不访问真实镜像仓库；给出明确原因，不把假耗时伪装成实测。
    return { ok: false, reason: '演示模式不访问真实镜像仓库，测速不可用' }
  }

  async createPolicy(): Promise<{ mountRoot: string; reservedPorts: readonly number[] }> {
    return { mountRoot: '/srv/elysian', reservedPorts: [48100] }
  }

  async connectTerminal(
    containerId: string,
    handlers: HostTerminalHandlers,
  ): Promise<HostTerminalSessionInfo> {
    return this.terminal.connectTerminal(containerId, handlers)
  }

  async executeTerminalCommand(sessionId: string, command: string) {
    return this.terminal.executeTerminalCommand(sessionId, command)
  }
  async sendTerminalInput(sessionId: string, _data: Uint8Array): Promise<void> {
    return this.terminal.sendTerminalInput(sessionId, _data)
  }
  async resizeTerminal(sessionId: string, _cols: number, _rows: number): Promise<void> {
    return this.terminal.resizeTerminal(sessionId, _cols, _rows)
  }
  acknowledgeTerminal(sessionId: string, bytes: number): void {
    this.terminal.acknowledgeTerminal(sessionId, bytes)
  }
  terminalCompletions(sessionId: string, input: string): readonly string[] {
    return this.terminal.terminalCompletions(sessionId, input)
  }

  async disconnectTerminal(sessionId: string): Promise<void> {
    return this.terminal.disconnectTerminal(sessionId)
  }

  /** 取消未决的终端连接：mock 的 connectTerminal 同步 resolve，没有 pending 概念，no-op。 */
  cancelTerminalConnect(): void {
    this.terminal.cancelTerminalConnect()
  }

  async requestAction(containerId: string, action: ContainerAction): Promise<Container> {
    const container = this.dataset().containers.find((c) => c.id === containerId)
    if (!container) throw new Error('容器不存在，操作失败')
    if (action === 'start') {
      container.status = 'running'
      container.startedAt = new Date().toISOString()
    } else if (action === 'stop') {
      container.status = 'stopped'
      container.startedAt = undefined
    } else {
      container.status = 'restarting'
      this.hooks.scheduleRestart(containerId)
    }
    this.hooks.onAction(containerId)
    return { ...container }
  }

  async removeContainer(containerId: string): Promise<void> {
    const containers = this.dataset().containers
    const index = containers.findIndex((container) => container.id === containerId)
    const container = containers[index]
    if (!container) throw new Error('容器不存在')
    if (container.removeBlockedReason) throw new Error(container.removeBlockedReason)
    if (container.status !== 'stopped') throw new Error('容器未停止，无法删除')
    containers.splice(index, 1)
    this.hooks.onRemove?.(containerId)
  }

  async create(input: ContainerCreateInput): Promise<ContainerCreateResult> {
    const dataset = this.dataset()
    const image = dataset.images.find((i) => i.id === input.imageId)
    if (!image) throw new Error('镜像不存在，无法创建容器')
    const name = input.name?.trim() || autoContainerName(dataset.containers, image.name)
    if (dataset.containers.some((c) => c.name === name)) {
      throw new Error(`容器名称已存在：${name}`)
    }
    const policy = await this.createPolicy()
    for (const port of input.ports) {
      if (policy.reservedPorts.includes(port.hostPort)) {
        throw new Error(`宿主端口为面板保留：${port.hostPort}`)
      }
      const hostIp = effectivePortHostIp(port.hostIp)
      const conflicts = (entry: { hostPort: number; protocol: string; hostIp?: string }) =>
        entry.hostPort === port.hostPort &&
        entry.protocol === port.protocol &&
        hostPortBindingsOverlap(hostIp, effectivePortHostIp(entry.hostIp))
      if (dataset.containers.some((container) => container.ports.some(conflicts))) {
        throw new Error('宿主端口已被占用')
      }
      const dupInInput = input.ports.some(
        (other) =>
          other !== port &&
          other.hostPort === port.hostPort &&
          other.protocol === port.protocol &&
          hostPortBindingsOverlap(hostIp, effectivePortHostIp(other.hostIp)),
      )
      if (dupInInput) {
        throw new Error('宿主端口已被占用')
      }
    }
    const now = new Date().toISOString()
    const container: Container = {
      id: `ctr-${name}`,
      name,
      status: 'running',
      imageId: input.imageId,
      ports: input.ports.map(({ allowFirewall: _allowFirewall, ...port }) => port),
      createdAt: now,
      startedAt: now,
      command: input.command?.trim() ?? '',
      env: input.env.map((e) => ({ ...e })),
      volumes: input.volumes.map((v) => ({ ...v })),
      restartPolicy: input.restartPolicy,
    }
    dataset.containers.push(container)
    this.hooks.onCreate(container.id)
    const firewallResults = input.ports.filter(port => port.allowFirewall).map(({ hostPort, protocol }) => ({
      port: hostPort, protocol, state: 'skipped' as const, detail: '演示模式未启用宿主防火墙',
    }))
    return firewallResults.length ? { ...container, firewallResults } : { ...container }
  }

  listApps(): Promise<readonly ContainerApp[]> {
    return this.workspace.listApps()
  }

  createApp(input: { slug: string; displayName: string }): Promise<ContainerApp> {
    return this.workspace.createApp(input)
  }

  removeApp(slug: string): Promise<void> {
    return this.workspace.removeApp(slug)
  }

  uploadAppFile(slug: string, path: string, file: Blob): Promise<ContainerAppFile> {
    return this.workspace.uploadAppFile(slug, path, file)
  }

  removeAppFile(slug: string, path: string): Promise<void> {
    return this.workspace.removeAppFile(slug, path)
  }

  readAppContent(slug: string, path: string): Promise<{ path: string; content: string; file: ContainerAppFile }> {
    return this.workspace.readAppContent(slug, path)
  }

  writeAppContent(slug: string, path: string, content: string): Promise<ContainerAppFile> {
    return this.workspace.writeAppContent(slug, path, content)
  }

  checkCompose(slug: string, path: string): Promise<ComposeCheckResult> {
    return this.workspace.checkCompose(slug, path)
  }

  previewAppBuild(slug: string, input: ContainerBuildPreviewInput): Promise<ContainerBuildPlan> {
    return this.workspace.previewAppBuild(slug, input)
  }

  submitAppBuild(slug: string, input: ContainerBuildSubmitInput): Promise<ContainerBuildTask> {
    return this.workspace.submitAppBuild(slug, input)
  }

  listAppBuilds(slug: string): Promise<readonly ContainerBuildTask[]> {
    return this.workspace.listAppBuilds(slug)
  }

  getAppBuild(slug: string, taskId: string): Promise<ContainerBuildTask> {
    return this.workspace.getAppBuild(slug, taskId)
  }

  getAppBuildLogs(slug: string, taskId: string, offset: number): Promise<ContainerBuildLogs> {
    return this.workspace.getAppBuildLogs(slug, taskId, offset)
  }

  cancelAppBuild(slug: string, taskId: string): Promise<void> {
    return this.workspace.cancelAppBuild(slug, taskId)
  }

  async removeImage(imageId: string): Promise<void> {
    const dataset = this.dataset()
    const image = dataset.images.find((i) => i.id === imageId)
    if (!image) throw new Error('镜像不存在，删除失败')
    if (dataset.containers.some((c) => c.imageId === imageId)) {
      throw new Error('镜像仍被容器引用，删除失败')
    }
    dataset.images = dataset.images.filter((i) => i.id !== imageId)
  }

  async pullImage(input: { name: string; tag: string; registry?: string }, onProgress?: (progress: ImagePullProgress) => void, signal?: AbortSignal): Promise<ContainerImage> {
    throwIfAborted(signal)
    // registry 只是界面记录的拉取源：mock 不区分来源，全部走同一份确定性数据。
    const dataset = this.dataset()
    if (dataset.images.some((i) => i.name === input.name && i.tag === input.tag)) {
      throw new Error(`镜像已存在：${input.name}:${input.tag}`)
    }
    if (onProgress) {
      for (const currentBytes of [0, 25, 65, 100]) {
        onProgress({ phase: currentBytes === 100 ? 'finalizing' : 'downloading', layerId: '演示镜像层', currentBytes: currentBytes * 1024 * 1024, totalBytes: 100 * 1024 * 1024 })
        await abortableDelay(100, signal)
      }
    }
    throwIfAborted(signal)
    const { id, digest, sizeMb } = mockImageArtifact(input.name, input.tag)
    const image: ContainerImage = {
      id,
      name: input.name,
      tag: input.tag,
      digest,
      sizeMb,
      pulledAt: new Date().toISOString(),
    }
    dataset.images.push(image)
    return { ...image }
  }

  watchLive(handlers: {
    onEvent: (event: ElysianEvent) => void
    onStatus: (status: 'live' | 'connecting') => void
  }): Unsubscribe {
    handlers.onStatus('live')
    return () => {}
  }
}
