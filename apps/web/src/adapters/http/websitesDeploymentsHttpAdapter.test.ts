import { describe, expect, it, vi } from 'vitest'
import { createHttpWebsitesAdapter, parseDeploymentSource, parseDeploymentTask } from './websitesHttpAdapter'

const source = { id: 'source', name: 'app', type: 'git', mode: 'source', state: 'ready', createdAt: '2026-10-01', expiresAt: '2026-10-02', report: { candidates: [{ id: 'candidate', directory: '.', kind: 'node', tool: 'npm', wrapper: false, entries: ['app.js'], testSteps: [], buildSteps: [], artifacts: [], suggestedCommand: 'node /app/app.js', warnings: [] }], warnings: [] } }
const config = { candidateId: 'candidate', target: 'service', command: 'node /app/app.js', skipTests: false }
const task = { id: 'task', sourceId: 'source', name: 'app', state: 'queued', stage: '等待', createdAt: '2026-10-01', updatedAt: '2026-10-01', config, testResult: 'absent' }

describe('部署 HTTP 契约', () => {
  it('拒绝会导致配置页崩溃的识别报告与任务形状', () => {
    expect(parseDeploymentSource(source).report?.candidates[0]?.tool).toBe('npm')
    expect(() => parseDeploymentSource({ ...source, report: { candidates: [{ ...source.report.candidates[0], entries: null }], warnings: [] } })).toThrow('项目识别候选无效')
    expect(() => parseDeploymentTask({ ...task, config: { ...config, target: 'unknown' } })).toThrow('部署配置响应无效')
    expect(() => parseDeploymentTask({ ...task, artifacts: [null] })).toThrow('部署产物响应无效')
    expect(parseDeploymentTask(task).testResult).toBe('absent')
  })
  it('上传使用文件正文与取消信号，来源和任务接口分开', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(source), { status: 201 })).mockResolvedValueOnce(new Response(JSON.stringify(task), { status: 202 }))
    vi.stubGlobal('fetch', fetcher)
    try {
      const api = createHttpWebsitesAdapter().deployment!
      const file = new File(['fixture'], '项目.zip')
      const signal = new AbortController().signal
      await api.archive(file, 'source', signal)
      expect(fetcher.mock.calls[0]?.[0]).toBe('/api/websites/sources/archive?mode=source')
      expect(fetcher.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ body: file, signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'x-file-name': encodeURIComponent(file.name) }) }))
      await api.resume('task', config as Parameters<typeof api.resume>[1])
      expect(fetcher.mock.calls[1]?.[0]).toBe('/api/websites/deployments/task/resume')
    } finally { vi.unstubAllGlobals() }
  })
})
