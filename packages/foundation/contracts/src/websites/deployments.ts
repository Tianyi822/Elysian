import type { WebsiteProjectKind, WebsiteAccessInput } from './websites.ts'

/** 来源不含认证凭据；Git 实际提交在准备完成后固定。 */
export type WebsiteSource = {
  id: string; type: 'archive' | 'git'; mode: 'source' | 'artifact'
  state: 'preparing' | 'ready' | 'failed' | 'interrupted'; name: string
  gitUrl?: string; ref?: string; commit?: string
  createdAt: string; expiresAt: string; error?: string
  report?: WebsiteAnalysisReport
}
export type WebsiteBuildTool = 'javac' | 'maven' | 'gradle' | 'npm' | 'pnpm' | 'yarn' | 'bun' | 'go' | 'pip' | 'uv' | 'poetry' | 'static' | 'artifact'
export type WebsiteDeploymentTarget = 'service' | 'static'
export type WebsiteProjectCandidate = {
  id: string; directory: string; kind: WebsiteProjectKind; tool: WebsiteBuildTool
  toolVersion?: string; wrapper: boolean; entries: readonly string[]
  testSteps: readonly string[]; buildSteps: readonly string[]
  artifacts: readonly string[]; suggestedCommand: string; warnings: readonly string[]
  requiredVersion?: string
}
export type WebsiteAnalysisReport = { candidates: readonly WebsiteProjectCandidate[]; warnings: readonly string[] }
/** 所有自定义步骤仅在一次性非特权构建容器内执行。 */
export type WebsiteBuildConfig = {
  candidateId: string; buildVersion?: string; runtimeVersion?: string
  toolVersion?: string; entry?: string; artifact?: string
  target: WebsiteDeploymentTarget; command: string; skipTests: boolean
  testSteps?: readonly string[]; buildSteps?: readonly string[]
}
export type WebsiteDeploymentInput = {
  sourceId: string; projectId?: string; requestId: string
  name: string; port: number; note?: string; access: WebsiteAccessInput
  config: WebsiteBuildConfig
}
export type WebsiteDeploymentState = 'queued' | 'building' | 'awaiting-config' | 'publishing' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export const WEBSITE_DEPLOYMENT_STATE_LABELS: Record<WebsiteDeploymentState, string> = {
  queued: '等待构建', building: '测试与构建', 'awaiting-config': '等待补充配置', publishing: '发布与就绪检查',
  succeeded: '部署成功', failed: '部署失败', cancelled: '已取消', interrupted: '重启中断',
}
export type WebsiteRelease = {
  id: string; createdAt: string; sourceId: string; commit?: string
  directory: string; target: WebsiteDeploymentTarget
  buildImage?: string; runtimeImage: string; buildVersion?: string; runtimeVersion?: string
  command: string; containerId: string; containerName: string
}
export type WebsiteDeploymentTask = {
  id: string; sourceId: string; projectId?: string; name: string; port?: number
  state: WebsiteDeploymentState; stage: string; createdAt: string; updatedAt: string
  config: WebsiteBuildConfig; buildImage?: string; runtimeImage?: string
  error?: string; testResult: 'pending' | 'passed' | 'failed' | 'absent' | 'skipped'
  artifacts?: readonly string[]; suggestedCommand?: string; release?: WebsiteRelease
}
export type WebsiteDeploymentLogs = { lines: readonly string[]; next: number; total: number }
export type WebsiteGitSourceInput = { url: string; ref?: string; token?: string; mode: 'source' | 'artifact' }
export function websiteDeploymentIsActive(state: WebsiteDeploymentState): boolean {
  return state === 'queued' || state === 'building' || state === 'publishing'
}
