import { describe, expect, it } from 'vitest'
import { createApp } from './app'

/*
 * app 组装冒烟测试：锚定挂载点与健康检查的可达性。三片安全路由全部装配真实接线：
 * 非容器环境（测试进程无 ELSYIAN_DOCKER 且无 /.dockerenv）下整片 503，
 * 这里锚定挂载形态与容器边界文案。
 */

describe('createApp 组装', () => {
  it('GET /api/health 返回 200 与 ok', async () => {
    const res = await (await createApp()).request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('平台内存挂在 /api/platform/memory，形状与换算来自契约', async () => {
    const res = await (await createApp()).request('/api/platform/memory')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, number>
    expect(Object.keys(body).sort()).toEqual(['heapTotalMb', 'heapUsedMb', 'rssMb'])
    for (const value of Object.values(body)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('SSH 与用户管理两片挂真实接线：非容器环境整片 503（含未知路径），文案与容器边界一致', async () => {
    const app = await createApp()
    const expects: readonly [string, string][] = [
      ['/api/security/ssh/overview', '真实 SSH 管理仅在 Docker 容器内可用'],
      ['/api/security/users', '真实用户管理仅在 Docker 容器内可用'],
      ['/api/security/users/', '真实用户管理仅在 Docker 容器内可用'],
      ['/api/security/users/nowhere', '真实用户管理仅在 Docker 容器内可用'],
    ]
    for (const [path, error] of expects) {
      const res = await app.request(path)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error })
    }
  })

  it('防火墙片挂真实接线：非容器环境整片 503（含未知路径与写方法），文案与容器边界一致', async () => {
    const app = await createApp()
    const expects: readonly [string, string][] = [
      ['/api/security/firewall', '真实防火墙仅在 Docker 容器内可用'],
      ['/api/security/firewall/toggles', '真实防火墙仅在 Docker 容器内可用'],
      ['/api/security/firewall/nowhere', '真实防火墙仅在 Docker 容器内可用'],
    ]
    for (const [path, error] of expects) {
      const res = await app.request(path)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error })
    }
  })

  it('文件管理片挂真实接线：非容器环境整片 503（含未知路径），文案与容器边界一致', async () => {
    const app = await createApp()
    const expects: readonly [string, string][] = [
      ['/api/files/entries?path=%2Fvar%2Flog', '真实文件管理仅在 Docker 容器内可用'],
      ['/api/files/search?keyword=log', '真实文件管理仅在 Docker 容器内可用'],
      ['/api/files/nowhere', '真实文件管理仅在 Docker 容器内可用'],
    ]
    for (const [path, error] of expects) {
      const res = await app.request(path)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error })
    }
  })
})
