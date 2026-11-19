import registryPresets from '../../../../server-go/internal/docker/registry-presets.json'
import { abortableDelay, throwIfAborted } from '../../utils/abortable'
import {
  effectivePortHostIp,
  hostPortBindingsOverlap,
} from '../../features/container/containerCreateForm'
import {
  checkComposeReferences,
  isContainerBuildActive,
  isOfficialImageRegistry,
  normalizeWorkspaceRelativePath,
  validateContainerAppDisplayName,
  validateContainerAppSlug,
} from '@elysian/contracts'
import type {
  Container,
  ContainerAction,
  ContainerApp,
  ContainerAppFile,
  ContainerBuildLogs,
  ContainerBuildPlan,
  ContainerBuildPreviewInput,
  ContainerBuildServicePlan,
  ContainerBuildSubmitInput,
  ContainerBuildTask,
  ContainerCreateInput,
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
import { containerTerminalCompletions, execContainerCommand } from './containerTerminal'
import { mockImageArtifact } from './containersData'
import { autoContainerName } from '@elysian/contracts'
import type { MockDataset } from './dataset'

type MockContainerTerminalSession = {
  containerId: string
  handlers: HostTerminalHandlers
}

/** 构建上下文上限：与工作区文件上限同值（files.go 三件套），preview 预警用。 */
const DEMO_BUILD_CONTEXT_MAX_FILES = 512
const DEMO_BUILD_CONTEXT_MAX_BYTES = 128 * 1024 * 1024

/** requestId 形状：与服务端 safeDeploymentID 同一正则（小写 uuid 形态）。 */
const DEMO_BUILD_REQUEST_ID_PATTERN = /^[a-f0-9-]{36}$/

/** dockerfile 形态的预览结果：收窄用，避免在联合类型上直接取字段。 */
type DockerfileBuildPlan = Extract<ContainerBuildPlan, { mode: 'dockerfile' }>

/** tag = UTC yyyyMMdd-HHmmss（任务提交时刻）+ 任务 id 前 4 字符，与真实侧同规则。 */
function demoBuildTag(createdAtIso: string, taskId: string): string {
  const at = new Date(createdAtIso)
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return (
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}` +
    `-${taskId.slice(0, 4)}`
  )
}

/** 演示镜像 ID：同一 repository:tag 确定性生成，不伪装真实构建产物。 */
function demoBuildImageId(repository: string, tag: string): string {
  let hash = 0
  for (const char of `${repository}:${tag}`) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0')
  return `sha256:${hex(hash)}${hex(hash ^ 0x9e3779b9)}${hex(hash * 31)}${hex(hash ^ 0x85ebca6b)}`
}

export class MockContainerAdapter implements ContainerAdapter {
  readonly terminalMode = 'repl' as const
  private nextTerminalId = 1
  private readonly terminalSessions = new Map<string, MockContainerTerminalSession>()
  /**
   * 演示用工作区：只存内存，刷新即回空（AGENTS.md「演示状态只存在内存」）。
   * 目录形状与真实侧一致（<mountRoot>/apps/<slug>），好让回显路径的样式在演示下也成立。
   */
  private readonly demoApps = new Map<string, { displayName: string; createdAt: string; files: Map<string, string> }>()
  /**
   * 演示构建任务（ADR-0021 同款任务模型）：submit 生成任务并按注入时钟推进
   * queued → building → succeeded；requestId 幂等、取消与日志分页与 HTTP 侧同句。
   * 构建为内存模拟，不执行真实 Docker 构建，日志行里也如实标注。
   */
  private nextBuildSeq = 1
  private readonly demoBuilds = new Map<string, ContainerBuildTask>()
  private readonly demoBuildLogs = new Map<string, string[]>()
  /** 任务推进所需的元数据（目标清单与上下文统计），不进任务对象。 */
  private readonly demoBuildMeta = new Map<string, { targets: readonly { target: string; repository: string }[]; contextFiles: number; contextBytes: number }>()
  private readonly demoBuildTimers = new Map<string, ReturnType<typeof setTimeout>[]>()

  constructor(
    private readonly dataset: () => MockDataset,
    private readonly hooks: {
      onAction: (containerId: string) => void
      scheduleRestart: (containerId: string) => void
      onCreate: (containerId: string) => void
      onRemove?: (containerId: string) => void
    },
    private readonly options: {
      /** 注入时钟：tag 与任务时间戳都取它，测试不依赖当前时间。 */
      now?: () => Date
      /** 状态推进节奏：默认对齐真实观感（0.5s 排队、3s 构建），测试可注入 0。 */
      buildDelays?: { queuedMs: number; buildingMs: number }
    } = {},
  ) {}

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
    const container = this.dataset().containers.find((c) => c.id === containerId)
    if (!container) throw new Error('容器不存在，无法执行演示终端命令')
    const id = `ctr-term-${this.nextTerminalId}`
    this.nextTerminalId += 1
    this.terminalSessions.set(id, { containerId, handlers })
    return { id, user: 'demo', hostLabel: container.name, prompt: '$ ' }
  }

  async executeTerminalCommand(sessionId: string, command: string) {
    const session = this.requireTerminalSession(sessionId)
    const container = this.dataset().containers.find((c) => c.id === session.containerId)
    if (!container) throw new Error('容器不存在，无法执行演示终端命令')
    const image = this.dataset().images.find((i) => i.id === container.imageId)
    if (!image) throw new Error('容器所用镜像不存在，无法执行演示终端命令')
    return execContainerCommand(container, image, command)
  }
  async sendTerminalInput(sessionId: string, _data: Uint8Array): Promise<void> {
    this.requireTerminalSession(sessionId)
    throw new Error('演示终端不提供真实 PTY')
  }
  async resizeTerminal(sessionId: string, _cols: number, _rows: number): Promise<void> { this.requireTerminalSession(sessionId) }
  acknowledgeTerminal(_sessionId: string, _bytes: number): void {}
  terminalCompletions(sessionId: string, input: string): readonly string[] {
    this.requireTerminalSession(sessionId)
    return containerTerminalCompletions(input)
  }

  async disconnectTerminal(sessionId: string): Promise<void> {
    if (!this.terminalSessions.delete(sessionId)) {
      throw new Error(`终端会话不存在 ${sessionId}`)
    }
  }

  /** 取消未决的终端连接：mock 的 connectTerminal 同步 resolve，没有 pending 概念，no-op。 */
  cancelTerminalConnect(): void {}

  private requireTerminalSession(sessionId: string): MockContainerTerminalSession {
    const session = this.terminalSessions.get(sessionId)
    if (!session) throw new Error(`终端会话不存在 ${sessionId}`)
    return session
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

  async create(input: ContainerCreateInput): Promise<Container> {
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
      ports: input.ports.map((p) => ({ ...p })),
      createdAt: now,
      startedAt: now,
      command: input.command?.trim() ?? '',
      env: input.env.map((e) => ({ ...e })),
      volumes: input.volumes.map((v) => ({ ...v })),
      restartPolicy: input.restartPolicy,
    }
    dataset.containers.push(container)
    this.hooks.onCreate(container.id)
    return { ...container }
  }

  /** 演示工作区的绝对目录形状，与真实侧 <mountRoot>/apps/<slug> 一致。 */
  private demoAppDir(slug: string): string {
    return `/srv/elysian/apps/${slug}`
  }

  private requireDemoApp(slug: string) {
    const app = this.demoApps.get(slug)
    if (!app) throw new Error(`容器工作区不存在：${slug}`)
    return app
  }

  private demoFileEntries(files: Map<string, string>): readonly ContainerAppFile[] {
    return [...files.entries()]
      .map(([path, content]) => ({
        path,
        size: new TextEncoder().encode(content).length,
        modifiedAt: new Date().toISOString(),
        text: !content.includes('\u0000'),
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
  }

  async listApps(): Promise<readonly ContainerApp[]> {
    return [...this.demoApps.entries()]
      .map(([slug, app]) => ({
        slug,
        displayName: app.displayName,
        createdAt: app.createdAt,
        directory: this.demoAppDir(slug),
        files: this.demoFileEntries(app.files),
      }))
      .sort((left, right) => left.slug.localeCompare(right.slug))
  }

  async createApp(input: { slug: string; displayName: string }): Promise<ContainerApp> {
    const slugError = validateContainerAppSlug(input.slug)
    if (slugError) throw new Error(slugError)
    const nameError = validateContainerAppDisplayName(input.displayName)
    if (nameError) throw new Error(nameError)
    if (this.demoApps.has(input.slug)) throw new Error(`工作区名称已存在，请换一个：${input.slug}`)
    const createdAt = new Date().toISOString()
    this.demoApps.set(input.slug, {
      displayName: input.displayName || input.slug,
      createdAt,
      files: new Map(),
    })
    return {
      slug: input.slug,
      displayName: input.displayName || input.slug,
      createdAt,
      directory: this.demoAppDir(input.slug),
      files: [],
    }
  }

  async removeApp(slug: string): Promise<void> {
    this.requireDemoApp(slug)
    // 与真实端点同款收紧：活跃构建任务期间删除被拒，409 文案逐字一致。
    if ([...this.demoBuilds.values()].some((task) => task.slug === slug && isContainerBuildActive(task.state))) {
      throw new Error('工作区有进行中的构建任务，请先取消或等待完成')
    }
    this.demoApps.delete(slug)
    for (const [id, task] of this.demoBuilds) {
      if (task.slug !== slug) continue
      this.clearBuildTimers(id)
      this.demoBuilds.delete(id)
      this.demoBuildLogs.delete(id)
      this.demoBuildMeta.delete(id)
    }
  }

  async uploadAppFile(slug: string, path: string, file: Blob): Promise<ContainerAppFile> {
    const app = this.requireDemoApp(slug)
    const normalized = normalizeWorkspaceRelativePath(path)
    const content = await file.text()
    app.files.set(normalized, content)
    return this.demoFileEntries(new Map([[normalized, content]]))[0]!
  }

  async removeAppFile(slug: string, path: string): Promise<void> {
    const app = this.requireDemoApp(slug)
    const normalized = normalizeWorkspaceRelativePath(path)
    if (!app.files.delete(normalized)) throw new Error(`工作区内没有该文件：${normalized}`)
  }

  async readAppContent(slug: string, path: string): Promise<{ path: string; content: string; file: ContainerAppFile }> {
    const app = this.requireDemoApp(slug)
    const normalized = normalizeWorkspaceRelativePath(path)
    const content = app.files.get(normalized)
    if (content === undefined) throw new Error(`工作区内没有该文件：${normalized}`)
    return {
      path: normalized,
      content,
      file: this.demoFileEntries(new Map([[normalized, content]]))[0]!,
    }
  }

  async writeAppContent(slug: string, path: string, content: string): Promise<ContainerAppFile> {
    const app = this.requireDemoApp(slug)
    const normalized = normalizeWorkspaceRelativePath(path)
    if (content.includes('\u0000')) throw new Error('编辑内容必须是 UTF-8 文本且不含空字符')
    app.files.set(normalized, content)
    return this.demoFileEntries(new Map([[normalized, content]]))[0]!
  }

  /**
   * 演示侧的 compose 自检：与 Go 侧同一套保守规则（只判 ./ 开头的相对引用与
   * env_file，绝对路径/变量/锚点/build 一律列入未能判定）。两侧规则一致才不会
   * 出现「演示看着对、真实环境给出另一套结论」。
   */
  async checkCompose(slug: string, path: string): Promise<ComposeCheckResult> {
    const app = this.requireDemoApp(slug)
    const normalized = normalizeWorkspaceRelativePath(path)
    const content = app.files.get(normalized)
    if (content === undefined) throw new Error(`工作区内没有该文件：${normalized}`)
    return checkComposeReferences({
      composePath: normalized,
      composeDir: `${this.demoAppDir(slug)}/${normalized.split('/').slice(0, -1).join('/')}`.replace(/\/$/, ''),
      content,
      hasFile: (relative) => {
        // 演示侧只有文件没有目录：引用指向目录时按「该前缀下有文件」判定存在。
        if (app.files.has(relative)) return true
        const prefix = relative.endsWith('/') ? relative : `${relative}/`
        return [...app.files.keys()].some((candidate) => candidate.startsWith(prefix))
      },
    })
  }

  /* ---------- 镜像构建（ADR-0021）：演示侧与 HTTP 侧同一套错误句与任务形状 ---------- */

  private nowIso(): string {
    return (this.options.now ?? (() => new Date()))().toISOString()
  }

  private requireDemoBuild(slug: string, taskId: string): ContainerBuildTask {
    const task = this.demoBuilds.get(taskId)
    if (!task || task.slug !== slug) throw new Error(`构建任务不存在：${taskId}`)
    return task
  }

  private mutateBuild(taskId: string, mutate: (task: ContainerBuildTask) => void): void {
    const task = this.demoBuilds.get(taskId)
    if (!task) return
    mutate(task)
    task.updatedAt = this.nowIso()
  }

  private appendBuildLog(taskId: string, line: string): void {
    const lines = this.demoBuildLogs.get(taskId) ?? []
    lines.push(line)
    this.demoBuildLogs.set(taskId, lines)
  }

  private clearBuildTimers(taskId: string): void {
    for (const timer of this.demoBuildTimers.get(taskId) ?? []) clearTimeout(timer)
    this.demoBuildTimers.delete(taskId)
  }

  /** 构建上下文归一化：允许字面 "." 与 "./" 前缀，剥完逐段按工作区相对路径同规则校验。 */
  private normalizeBuildContext(context: string): string {
    let value = context.trim()
    if (value.startsWith('./')) value = value.slice(2)
    if (value === '') value = '.'
    if (value === '.') return '.'
    return normalizeWorkspaceRelativePath(value)
  }

  /** 上下文目录存在性：演示侧只有文件，前缀下有文件即算目录存在。 */
  private demoContextStats(
    app: { files: Map<string, string> },
    context: string,
  ): { contextFiles: number; contextBytes: number; exists: boolean } {
    const prefix = context === '.' ? '' : `${context}/`
    let contextFiles = 0
    let contextBytes = 0
    for (const [path, content] of app.files) {
      if (!path.startsWith(prefix)) continue
      contextFiles += 1
      contextBytes += new TextEncoder().encode(content).length
    }
    return { contextFiles, contextBytes, exists: context === '.' || contextFiles > 0 }
  }

  /** FROM 静态预检（演示侧）：只报未解析变量的行，不代入 ARG 默认值，也不做镜像源 DNS 校验。 */
  private scanDemoDockerfileFrom(content: string): string[] {
    const warnings: string[] = []
    content.split('\n').forEach((rawLine, index) => {
      const match = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(rawLine)
      if (match && match[1]!.includes('$')) {
        warnings.push(`第 ${index + 1} 行 FROM 含未解析变量，面板未校验其镜像源`)
      }
    })
    return warnings
  }

  /** compose 模式的固定示例服务：演示侧不解析 YAML，warnings 里如实标注。 */
  private demoComposeServicePlans(slug: string): readonly ContainerBuildServicePlan[] {
    const app = this.requireDemoApp(slug)
    const stats = this.demoContextStats(app, 'web')
    return [
      {
        service: 'web',
        hasBuild: true,
        target: 'web',
        dockerfile: 'web/Dockerfile',
        context: 'web',
        imageRepository: `elysian/${slug}/web`,
        contextFiles: stats.contextFiles,
        contextBytes: stats.contextBytes,
        imageNameInCompose: 'myapp-web',
        repositoryOccupied: false,
        warnings: [],
      },
      {
        service: 'db',
        hasBuild: false,
        target: '',
        dockerfile: '',
        context: '',
        imageRepository: '',
        contextFiles: 0,
        contextBytes: 0,
        imageNameInCompose: 'mariadb:11',
        repositoryOccupied: false,
        warnings: [],
      },
    ]
  }

  private demoBuildPreviewDockerfile(
    slug: string,
    input: Extract<ContainerBuildPreviewInput, { mode: 'dockerfile' }>,
  ): DockerfileBuildPlan {
    const app = this.requireDemoApp(slug)
    const target = input.target?.trim() || 'app'
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(target)) {
      throw new Error('镜像目标名只能由小写字母、数字、下划线和连字符组成，且以字母或数字开头')
    }
    const dockerfile = normalizeWorkspaceRelativePath(input.dockerfile)
    const content = app.files.get(dockerfile)
    if (content === undefined) throw new Error(`工作区内没有该文件：${dockerfile}`)
    const context = this.normalizeBuildContext(input.context ?? '.')
    const stats = this.demoContextStats(app, context)
    if (!stats.exists) throw new Error(`构建上下文目录不存在：${context}`)
    if (dockerfile !== context && !dockerfile.startsWith(context === '.' ? '' : `${context}/`)) {
      throw new Error('Dockerfile 必须位于构建上下文目录内')
    }
    const warnings = this.scanDemoDockerfileFrom(content)
    if (stats.contextFiles > DEMO_BUILD_CONTEXT_MAX_FILES || stats.contextBytes > DEMO_BUILD_CONTEXT_MAX_BYTES) {
      warnings.push('构建上下文超过上限（≤512 个文件、128 MiB），任务将在打包阶段失败')
    }
    return {
      mode: 'dockerfile',
      slug,
      target,
      dockerfile,
      context,
      imageRepository: `elysian/${slug}/${target}`,
      contextFiles: stats.contextFiles,
      contextBytes: stats.contextBytes,
      repositoryOccupied: false,
      warnings,
    }
  }

  async previewAppBuild(slug: string, input: ContainerBuildPreviewInput): Promise<ContainerBuildPlan> {
    if (input.mode === 'dockerfile') return this.demoBuildPreviewDockerfile(slug, input)
    const app = this.requireDemoApp(slug)
    const compose = normalizeWorkspaceRelativePath(input.compose)
    if (!app.files.has(compose)) throw new Error(`工作区内没有该文件：${compose}`)
    return {
      mode: 'compose',
      slug,
      compose,
      services: this.demoComposeServicePlans(slug),
      warnings: ['演示模式返回固定示例,不解析 compose 文件内容'],
    }
  }

  async submitAppBuild(slug: string, input: ContainerBuildSubmitInput): Promise<ContainerBuildTask> {
    this.requireDemoApp(slug)
    if (!DEMO_BUILD_REQUEST_ID_PATTERN.test(input.requestId)) throw new Error('请求标识无效')
    const existing = [...this.demoBuilds.values()].find((task) => task.requestId === input.requestId)
    if (existing) {
      if (JSON.stringify(existing.input) === JSON.stringify(input)) return structuredClone(existing)
      throw new Error('请求标识已用于其他构建')
    }
    let targets: readonly { target: string; repository: string }[]
    let stats: { contextFiles: number; contextBytes: number }
    if (input.mode === 'dockerfile') {
      const plan = this.demoBuildPreviewDockerfile(slug, input)
      targets = [{ target: plan.target, repository: plan.imageRepository }]
      stats = { contextFiles: plan.contextFiles, contextBytes: plan.contextBytes }
    } else {
      const app = this.requireDemoApp(slug)
      const compose = normalizeWorkspaceRelativePath(input.compose)
      if (!app.files.has(compose)) throw new Error(`工作区内没有该文件：${compose}`)
      const services = this.demoComposeServicePlans(slug)
      // 校验次序与真实端点一致：数组内重复名 → 不存在 → 无 build 段。
      const names = input.services ?? services.filter((service) => service.hasBuild).map((service) => service.service)
      const seen = new Set<string>()
      for (const name of names) {
        if (seen.has(name)) throw new Error(`服务 ${name} 重复提交`)
        seen.add(name)
      }
      for (const name of names) {
        const plan = services.find((service) => service.service === name)
        if (!plan) throw new Error(`服务不存在：${name}`)
        if (!plan.hasBuild) throw new Error(`服务没有 build 配置：${name}`)
      }
      targets = names.map((name) => ({ target: name, repository: `elysian/${slug}/${name}` }))
      const web = services.find((service) => service.service === 'web')!
      stats = { contextFiles: web.contextFiles, contextBytes: web.contextBytes }
    }
    if ([...this.demoBuilds.values()].some((task) => task.slug === slug && isContainerBuildActive(task.state))) {
      throw new Error('工作区已有进行中的构建任务')
    }
    const seq = this.nextBuildSeq
    this.nextBuildSeq += 1
    // id 前 4 字符必须是 hex：tag 后缀由它派生（形状 ^\d{8}-\d{6}-[0-9a-f]{4}$）。
    const id = `${(0x1000 + seq).toString(16)}b1d5-build-${seq}`
    const createdAt = this.nowIso()
    const task: ContainerBuildTask = {
      id,
      slug,
      mode: input.mode,
      requestId: input.requestId,
      state: 'queued',
      stage: '等待构建资源',
      createdAt,
      updatedAt: createdAt,
      input: structuredClone(input),
      results: [],
      error: '',
    }
    this.demoBuilds.set(id, task)
    this.demoBuildMeta.set(id, { targets, contextFiles: stats.contextFiles, contextBytes: stats.contextBytes })
    this.appendBuildLog(id, '任务已提交，等待构建资源')
    this.driveBuild(id)
    return structuredClone(task)
  }

  /** 状态推进：queued（0.5s）→ building（打包/校验）→ 逐目标构建（3s）→ succeeded。 */
  private driveBuild(taskId: string): void {
    const delays = this.options.buildDelays ?? { queuedMs: 500, buildingMs: 3000 }
    const timers: ReturnType<typeof setTimeout>[] = []
    this.demoBuildTimers.set(taskId, timers)
    const alive = () => {
      const task = this.demoBuilds.get(taskId)
      return task !== undefined && isContainerBuildActive(task.state)
    }
    timers.push(setTimeout(() => {
      if (!alive()) return
      const meta = this.demoBuildMeta.get(taskId)!
      this.mutateBuild(taskId, (task) => {
        task.state = 'building'
        task.stage = `打包构建上下文（${meta.contextFiles} 个文件，${meta.contextBytes} 字节）`
      })
      this.appendBuildLog(taskId, `打包构建上下文（${meta.contextFiles} 个文件，${meta.contextBytes} 字节）`)
      this.appendBuildLog(taskId, '演示模式：构建为内存模拟,未执行真实 Docker 构建')
      timers.push(setTimeout(() => {
        if (!alive()) return
        this.appendBuildLog(taskId, '校验镜像来源')
        for (const target of meta.targets) {
          if (!alive()) return
          const task = this.demoBuilds.get(taskId)!
          const tag = demoBuildTag(task.createdAt, taskId)
          this.mutateBuild(taskId, (row) => { row.stage = `构建镜像 ${target.repository}` })
          this.appendBuildLog(taskId, `构建镜像 ${target.repository}:${tag}`)
          this.mutateBuild(taskId, (row) => {
            row.results = [...row.results, {
              target: target.target,
              repository: target.repository,
              tag,
              imageId: demoBuildImageId(target.repository, tag),
              state: 'succeeded',
              error: '',
            }]
          })
        }
        if (!alive()) return
        this.appendBuildLog(taskId, '清理旧镜像')
        this.mutateBuild(taskId, (task) => {
          task.state = 'succeeded'
          task.stage = '构建成功'
        })
        this.appendBuildLog(taskId, '构建成功')
      }, delays.buildingMs))
    }, delays.queuedMs))
  }

  async listAppBuilds(slug: string): Promise<readonly ContainerBuildTask[]> {
    this.requireDemoApp(slug)
    return [...this.demoBuilds.values()]
      .filter((task) => task.slug === slug)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((task) => structuredClone(task))
  }

  async getAppBuild(slug: string, taskId: string): Promise<ContainerBuildTask> {
    return structuredClone(this.requireDemoBuild(slug, taskId))
  }

  async getAppBuildLogs(slug: string, taskId: string, offset: number): Promise<ContainerBuildLogs> {
    this.requireDemoBuild(slug, taskId)
    if (!Number.isInteger(offset) || offset < 0) throw new Error('日志偏移无效')
    const lines = this.demoBuildLogs.get(taskId) ?? []
    // 分页与真实端点同口径：字节偏移、行边界切割、单次最多 64 KiB。
    const text = lines.length > 0 ? `${lines.join('\n')}\n` : ''
    const bytes = new TextEncoder().encode(text)
    const total = bytes.length
    if (offset >= total) return { lines: [], next: total, total }
    const chunk = bytes.subarray(offset, Math.min(offset + 64 * 1024, total))
    let lastNewline = -1
    for (let index = chunk.length - 1; index >= 0; index -= 1) {
      if (chunk[index] === 0x0a) { lastNewline = index; break }
    }
    if (lastNewline < 0) {
      const body = new TextDecoder().decode(chunk)
      return { lines: body ? [body] : [], next: offset + chunk.length, total }
    }
    const body = new TextDecoder().decode(chunk.subarray(0, lastNewline))
    return { lines: body ? body.split('\n') : [], next: offset + lastNewline + 1, total }
  }

  async cancelAppBuild(slug: string, taskId: string): Promise<void> {
    const task = this.requireDemoBuild(slug, taskId)
    if (!isContainerBuildActive(task.state)) throw new Error('构建已结束，无法取消')
    this.clearBuildTimers(taskId)
    this.mutateBuild(taskId, (row) => {
      row.state = 'cancelled'
      row.stage = '已取消'
      row.error = '构建已取消'
    })
    this.appendBuildLog(taskId, '构建已取消')
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
