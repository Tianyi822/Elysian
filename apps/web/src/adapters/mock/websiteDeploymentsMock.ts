import type { WebsiteBuildConfig, WebsiteDeploymentTask, WebsiteSource, WebsiteProjectCandidate, WebsiteDeploymentInput } from '@elysian/contracts'
import type { WebsiteDeploymentsAdapter } from '../../contracts/adapters'
import { addWebsiteProject, applyWebsiteDeploymentConfig, getWebsiteProjects, setWebsiteProjectRunning } from './websitesData'

/** 演示来源与任务只在内存；日志明确标注演示，不执行解压、联网或构建。 */
export function createMockWebsiteDeployments(): WebsiteDeploymentsAdapter {
  let sequence = 0
  const sources = new Map<string, WebsiteSource>()
  const tasks = new Map<string, WebsiteDeploymentTask>()
  const inputs = new Map<string, WebsiteDeploymentInput>()
  const stamp = '2026-10-01T00:00:00Z'
  const candidate = (kind: WebsiteProjectCandidate['kind']): WebsiteProjectCandidate => ({
    id: kind, directory: '.', kind, tool: { java: 'javac', node: 'npm', go: 'go', python: 'pip', html: 'static' }[kind] as WebsiteProjectCandidate['tool'],
    wrapper: false, entries: kind === 'java' ? ['Main'] : kind === 'go' ? ['.'] : [],
    testSteps: kind === 'go' ? ['go test ./...'] : [], buildSteps: ['演示构建步骤'], artifacts: ['.'],
    suggestedCommand: { java: "java -cp '/app/app.jar:/app/lib/*' Main", node: 'node /app/app.js', go: '/app/server', python: '/app/.venv/bin/python /app/app.py', html: '' }[kind], warnings: ['演示识别报告，不读取真实源码'],
  })
  const source = (name: string, type: WebsiteSource['type'], mode: WebsiteSource['mode']): WebsiteSource => {
    const value: WebsiteSource = { id: `demo-source-${++sequence}`, name, type, mode, state: 'ready', createdAt: stamp, expiresAt: '2026-10-02T00:00:00Z', report: { candidates: (['java', 'node', 'go', 'python', 'html'] as const).map(candidate), warnings: ['演示环境不执行 Git 拉取、压缩包解压或构建'] } }
    sources.set(value.id, value); return structuredClone(value)
  }
  const getTask = (id: string) => { const value = tasks.get(id); if (!value) throw new Error('部署任务不存在'); const projectStatus: WebsiteDeploymentTask['projectStatus'] = getWebsiteProjects().some((p) => p.id === value.projectId) ? 'present' : value.projectId && (inputs.get(id)?.projectId || value.state === 'succeeded') ? 'deleted' : 'not-created'; return { ...structuredClone(value), projectStatus } }
  return {
    async archive(file, mode, signal) { if (signal?.aborted) throw new Error('上传已取消'); return source(file.name, 'archive', mode) },
    async git(input) { return source(input.url, 'git', input.mode) },
    async source(id) { const value = sources.get(id); if (!value) throw new Error('来源不存在'); return structuredClone(value) },
    async discardSource(id) { sources.delete(id) },
    async submit(input) {
      const previous = [...inputs.entries()].find(([, value]) => value.requestId === input.requestId)
      if (previous) return getTask(previous[0])
      const src = sources.get(input.sourceId); const c = src?.report?.candidates.find((entry) => entry.id === input.config.candidateId)
      if (!c) throw new Error('请选择项目目录')
      const value: WebsiteDeploymentTask = { id: `demo-task-${++sequence}`, sourceId: input.sourceId, projectId: input.projectId, name: input.name, port: input.port, state: 'queued', stage: '等待演示部署', createdAt: stamp, updatedAt: stamp, config: input.config, testResult: input.config.skipTests || src?.mode === 'artifact' ? 'skipped' : c.testSteps.length ? 'pending' : 'absent' }
      tasks.set(value.id, value); inputs.set(value.id, input); return structuredClone(value)
    },
    async list() { return [...tasks.keys()].map(getTask) },
    async task(id) {
      const value = tasks.get(id); const input = inputs.get(id)
      if (!value) throw new Error('部署任务不存在')
      if (value.state === 'queued' && input) {
        const c = sources.get(input.sourceId)?.report?.candidates.find((entry) => entry.id === input.config.candidateId)
        if (!c) throw new Error('演示来源不存在')
        const project = input.projectId ? getWebsiteProjects().find((p) => p.id === input.projectId) : addWebsiteProject(c.kind, { name: input.name, port: input.port, runtimeVersion: input.config.runtimeVersion, access: input.access, command: input.config.command, note: input.note }, input.config)
        if (project && project.kind !== c.kind) throw new Error('重新部署的项目类型必须与原项目一致')
        if (project) { applyWebsiteDeploymentConfig(project.id, input.config); setWebsiteProjectRunning(project.id, true); value.projectId = project.id }
        value.state = 'succeeded'; value.stage = '演示部署完成'; if (value.testResult === 'pending') value.testResult = 'passed'
      }
      return getTask(id)
    },
    async logs() { return { lines: ['演示环境：未执行真实构建或发布。\n'], next: 1, total: 1 } },
    async cancel(id) { const value = tasks.get(id); if (value) { value.state = 'cancelled'; value.stage = '演示任务已取消' } },
    async resume(id, config: WebsiteBuildConfig) { const value = tasks.get(id); if (!value) throw new Error('部署任务不存在'); value.config = config; value.state = 'queued'; return getTask(id) },
    async rollback() { throw new Error('演示项目没有真实发布版本') },
  }
}
