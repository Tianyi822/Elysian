import { describe, expect, it } from 'vitest'
import { WEBSITE_DEPLOYMENT_STATE_LABELS, websiteDeploymentIsActive } from './deployments'
import type { WebsiteSource, WebsiteRelease } from './deployments'

describe('部署流程共享契约', () => {
  it('所有任务状态有中文标签，等待配置不当成执行中', () => {
    expect(Object.keys(WEBSITE_DEPLOYMENT_STATE_LABELS)).toEqual(['queued', 'building', 'awaiting-config', 'publishing', 'succeeded', 'failed', 'cancelled', 'interrupted'])
    for (const state of ['queued', 'building', 'publishing'] as const) expect(websiteDeploymentIsActive(state)).toBe(true)
    for (const state of ['awaiting-config', 'failed', 'cancelled', 'interrupted', 'succeeded'] as const) expect(websiteDeploymentIsActive(state)).toBe(false)
  })
  it('来源仅记录实际提交，发布版本分别记录构建和运行版本', () => {
    const source: WebsiteSource = { id: 'source', type: 'git', name: 'app', mode: 'source', state: 'ready', commit: 'fixed-commit', gitUrl: 'https://example.org/app.git', createdAt: '2026-10-01', expiresAt: '2026-10-02' }
    const release: WebsiteRelease = { id: 'release', sourceId: source.id, directory: '/srv/app', createdAt: '2026-10-01', target: 'static', buildVersion: '22.19.0', buildImage: 'node:22.19.0', runtimeImage: 'nginx:1.30.4-alpine3.24', command: '', containerId: 'own', containerName: 'own' }
    expect(JSON.stringify(source)).not.toContain('token')
    expect(release.buildImage).not.toBe(release.runtimeImage)
  })
})
