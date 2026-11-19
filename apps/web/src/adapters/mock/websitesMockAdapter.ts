import type {
  WebsiteListReport,
  WebsiteProject,
  WebsiteAccessInput,
  WebsiteProjectCreateInput,
  WebsiteProjectKind,
  WebsiteProjectUpdateInput,
  WebsiteProxyStatus,
} from '@elysian/contracts'
import type { WebsiteMutateResult, WebsitesAdapter } from '../../contracts/adapters'
import { createMockWebsiteDeployments } from './websiteDeploymentsMock'
import { MOCK_WEBSITE_RUNTIME_REPORT } from './websiteRuntimeCatalog'
import {
  addWebsiteProject,
  getWebsiteLogs,
  getWebsiteProjects,
  removeWebsiteProject,
  setWebsiteProjectAccess,
  setWebsiteProjectRunning,
  updateWebsiteProject,
} from './websitesData'

/** 演示环境恒报通道正常：mock 呈现完整功能，不模拟降级与漂移。 */
const DEMO_PROXY_STATUS: WebsiteProxyStatus = { state: 'active', detail: null }

export class MockWebsitesAdapter implements WebsitesAdapter {
  deployment = createMockWebsiteDeployments()
  async runtimeCatalog() {
    return structuredClone(MOCK_WEBSITE_RUNTIME_REPORT)
  }
  async list(): Promise<WebsiteListReport> {
    return { projects: getWebsiteProjects(), proxy: DEMO_PROXY_STATUS }
  }

  async create(kind: WebsiteProjectKind, input: WebsiteProjectCreateInput): Promise<WebsiteMutateResult> {
    return { project: addWebsiteProject(kind, input), firewallPort: null }
  }

  async update(projectId: string, input: WebsiteProjectUpdateInput): Promise<WebsiteProject> {
    return updateWebsiteProject(projectId, input)
  }

  async setAccess(projectId: string, access: WebsiteAccessInput): Promise<WebsiteMutateResult> {
    return { project: setWebsiteProjectAccess(projectId, access), firewallPort: null }
  }

  async remove(projectId: string): Promise<void> {
    removeWebsiteProject(projectId)
  }

  async setRunning(projectId: string, running: boolean): Promise<WebsiteProject> {
    return setWebsiteProjectRunning(projectId, running)
  }

  async logs(projectId: string): Promise<readonly string[]> {
    return getWebsiteLogs(projectId)
  }

  async reconcileProxy(): Promise<WebsiteProxyStatus> {
    // 演示环境没有真实的宿主 Caddy 通道，对账是 no-op，状态保持正常。
    return DEMO_PROXY_STATUS
  }
}
