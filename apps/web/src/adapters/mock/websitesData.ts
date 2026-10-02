import type { WebsiteAccessInput, WebsiteProject, WebsiteProjectCreateInput, WebsiteProjectUpdateInput } from '@elysian/contracts'
import { isValidWebsiteDomain, isValidWebsitePort, isValidWebsiteProjectName, websiteDefaultDeployCommand, websiteProjectRootDir, websiteProjectUsesRuntime, websiteRuntimeImageRef } from '@elysian/contracts'
import { MOCK_WEBSITE_RUNTIME_REPORT } from './websiteRuntimeCatalog'

/** 本地演示从空项目列表开始；每次刷新重置，不保留旧网站测试种子。 */
export const SEED_PROJECTS: readonly WebsiteProject[] = []
let projects: WebsiteProject[] = []

export function resetWebsitesData(): void { projects = [] }
export function getWebsiteProjects(): readonly WebsiteProject[] { return projects.map((project) => ({ ...project })) }

function seedContainerId(id: string): string {
  let hex = ''
  for (let i = 0; i < 64; i += 1) hex += ((id.charCodeAt(i % id.length) * 31 + i * 7) % 16).toString(16)
  return hex
}

function pseudoPid(id: string): number {
  return 10000 + (Array.from(id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 89999)
}

function metadata(access: WebsiteAccessInput): WebsiteProject['certificate'] {
  if (access.mode === 'direct') return null
  if (!access.certificatePem || !access.privateKeyPem) throw new Error('域名访问需要上传公开 CA 证书链和私钥')
  return { issuer: '演示证书', notAfter: '2027-09-30T00:00:00.000Z', fingerprint256: '演示指纹', applied: true }
}

export function addWebsiteProject(kind: WebsiteProject['kind'], input: WebsiteProjectCreateInput): WebsiteProject {
  const name = input.name.trim()
  if (!isValidWebsiteProjectName(name)) throw new Error('项目名称需为 1-64 个字符')
  if (!isValidWebsitePort(input.port)) throw new Error('端口需为 1-65535 的整数')
  if (projects.some((project) => project.name === name)) throw new Error(`项目已存在：${name}`)
  if (projects.some((project) => project.port === input.port)) throw new Error(`宿主端口已被站点占用：${input.port}`)
  const runtimeVersion = websiteProjectUsesRuntime(kind) ? input.runtimeVersion?.trim() ?? null : null
  if (websiteProjectUsesRuntime(kind) && !websiteRuntimeImageRef(kind, runtimeVersion, MOCK_WEBSITE_RUNTIME_REPORT.catalog)) throw new Error('请选择正式运行时版本')
  const access = input.access
  const domain = access.mode === 'domain' ? access.domain.trim().toLowerCase() : null
  if (domain && !isValidWebsiteDomain(domain)) throw new Error('域名无效')
  if (domain && projects.some((project) => project.domain === domain)) throw new Error(`域名已被绑定：${domain}`)
  const certificate = metadata(access)
  const command = kind === 'html' ? websiteDefaultDeployCommand(kind) : input.command?.trim()
  if (!command) throw new Error('请填写容器启动命令')
  const id = `website-${kind}-${name}`
  const project: WebsiteProject = {
    id, kind, name, pid: null, containerId: seedContainerId(id), port: input.port,
    runtimeVersion, rootDir: websiteProjectRootDir(name), runState: 'stopped',
    accessMode: access.mode, domain, routeApplied: domain !== null, certificate,
    expiryAt: null, note: input.note ?? null, category: 'development',
    deployCommand: command, gitUrl: input.gitUrl ?? null, traffic: { todayMb: 0, totalGb: 0 },
  }
  projects.push(project)
  return { ...project }
}

export function updateWebsiteProject(projectId: string, input: WebsiteProjectUpdateInput): WebsiteProject {
  const existing = projects.find((project) => project.id === projectId)
  if (!existing) throw new Error(`未找到项目 ${projectId}`)
  const next = { ...existing, ...input, ...(input.command === undefined ? {} : { deployCommand: input.command }) }
  projects = projects.map((project) => project.id === projectId ? next : project)
  return { ...next }
}

export function setWebsiteProjectAccess(projectId: string, access: WebsiteAccessInput): WebsiteProject {
  const existing = projects.find((project) => project.id === projectId)
  if (!existing) throw new Error(`未找到项目 ${projectId}`)
  const domain = access.mode === 'domain' ? access.domain.trim().toLowerCase() : null
  if (domain && !isValidWebsiteDomain(domain)) throw new Error('域名无效')
  if (domain && projects.some((project) => project.id !== projectId && project.domain === domain)) throw new Error(`域名已被绑定：${domain}`)
  const certificate = access.mode === 'domain' && !access.certificatePem && existing.certificate
    ? existing.certificate : metadata(access)
  const next: WebsiteProject = { ...existing, accessMode: access.mode, domain, certificate, routeApplied: domain !== null }
  projects = projects.map((project) => project.id === projectId ? next : project)
  return { ...next }
}

export function removeWebsiteProject(projectId: string): void {
  if (!projects.some((project) => project.id === projectId)) throw new Error(`未找到项目 ${projectId}`)
  projects = projects.filter((project) => project.id !== projectId)
}

export function setWebsiteProjectRunning(projectId: string, running: boolean): WebsiteProject {
  const existing = projects.find((project) => project.id === projectId)
  if (!existing) throw new Error(`未找到项目 ${projectId}`)
  const next: WebsiteProject = { ...existing, runState: running ? 'running' : 'stopped', pid: running ? pseudoPid(projectId) : null }
  projects = projects.map((project) => project.id === projectId ? next : project)
  return { ...next }
}

export function getWebsiteLogs(projectId: string): readonly string[] {
  const project = projects.find((item) => item.id === projectId)
  if (!project) throw new Error(`未找到项目 ${projectId}`)
  return project.runState === 'running'
    ? [`[${project.name}] 容器运行中`, `监听容器端口 ${project.kind === 'html' ? 80 : project.port}`]
    : [`[${project.name}] 容器已停止`]
}
