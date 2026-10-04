import { describe, expect, it } from 'vitest'
import type { WebsiteDeploymentTask } from '@elysian/contracts'
import { deploymentTaskSummary } from './deploymentTaskSummary'

const task: WebsiteDeploymentTask = { id: 'task', sourceId: 'source', name: '站点', state: 'succeeded', stage: '部署成功，端口已就绪', createdAt: '2026-10-01', updatedAt: '2026-10-01', testResult: 'skipped', config: { candidateId: 'html', target: 'static', command: '', skipTests: true } }
describe('部署状态说明', () => {
  it('已删除项目保留历史成功，并去掉重复成功阶段', () => {
    expect(deploymentTaskSummary({ ...task, projectStatus: 'deleted' })).toBe('历史部署成功 · 项目已删除')
    expect(deploymentTaskSummary({ ...task, projectStatus: 'present' })).toBe('部署成功')
  })
  it('新建项目尚未完成时不标记为已删除', () => {
    expect(deploymentTaskSummary({ ...task, projectStatus: 'not-created', state: 'publishing', stage: '检查端口' })).toBe('发布与就绪检查 · 检查端口')
  })
})
