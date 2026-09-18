import { describe, expect, it } from 'vitest'
import type { WebsitesAdapter } from './adapters'
import { MockWebsitesAdapter } from '../adapters/mock/mockAdapters'

/**
 * 网站适配器的共同契约。
 *
 * 只依赖 `WebsitesAdapter` 接口本身，不依赖任何 mock 细节——将来换成
 * HTTP adapter 时对同一套断言再跑一次，这就是「mock 可替换」的验证方式。
 */

export function createWebsitesAdapterContractTests(
  name: string,
  make: () => WebsitesAdapter,
): void {
  describe(`WebsitesAdapter 契约：${name}`, () => {
    it('list 返回全部项目，标识唯一且字段按类型自洽', async () => {
      const projects = await make().list()
      expect(projects.length).toBeGreaterThan(0)
      expect(new Set(projects.map((project) => project.id)).size).toBe(projects.length)

      for (const project of projects) {
        expect(project.name.trim().length).toBeGreaterThan(0)
        expect(project.rootDir.startsWith('/www/wwwroot/')).toBe(true)
        expect(project.port).toBeGreaterThanOrEqual(1)
        expect(project.port).toBeLessThanOrEqual(65535)

        if (project.kind === 'html') {
          expect(project.runtimeVersion).toBeNull()
          expect(project.pid).toBeNull()
          expect(project.deployCommand).toBeNull()
        } else {
          expect(project.runtimeVersion).toBeTruthy()
          expect(project.deployCommand).not.toBeNull()
        }
        if (project.runState === 'running' && project.kind !== 'html') {
          expect(project.pid).not.toBeNull()
        }
        if (project.runState === 'stopped') {
          expect(project.pid).toBeNull()
        }
        expect(project.traffic).toBeTruthy()
        expect(project.traffic.todayMb).toBeGreaterThanOrEqual(0)
        expect(project.traffic.totalGb).toBeGreaterThanOrEqual(0)
        expect(project.gitUrl === null || project.gitUrl.length > 0).toBe(true)
      }
    })

    it('五种类型各有种子数据，界面不会一进来就空', async () => {
      const projects = await make().list()
      for (const kind of ['java', 'node', 'go', 'python', 'html'] as const) {
        expect(projects.some((project) => project.kind === kind), `缺 ${kind} 种子`).toBe(true)
      }
    })

    it('create 新建即已停止、无证书；根目录固定前缀；端口与版本落库；同名同类型拒绝', async () => {
      const adapter = make()
      const created = await adapter.create('python', {
        name: '报表服务',
        port: 8010,
        runtimeVersion: '3.11.9',
        note: '演示新建',
        gitUrl: 'https://github.com/acme/report.git',
      })

      expect(created.kind).toBe('python')
      expect(created.name).toBe('报表服务')
      expect(created.runState).toBe('stopped')
      expect(created.pid).toBeNull()
      expect(created.cert).toBe('none')
      expect(created.rootDir).toBe('/www/wwwroot/报表服务')
      expect(created.port).toBe(8010)
      expect(created.runtimeVersion).toBe('3.11.9')
      expect(created.gitUrl).toBe('https://github.com/acme/report.git')
      expect(created.traffic).toEqual({ todayMb: 0, totalGb: 0 })
      expect(created.deployCommand).not.toBeNull()

      const again = adapter.create('python', {
        name: '报表服务',
        port: 8011,
        runtimeVersion: '3.11.9',
      })
      await expect(again).rejects.toThrow('已存在')

      await expect(
        adapter.create('go', { name: '报表服务', port: 9010, runtimeVersion: '1.22.4' }),
      ).resolves.toBeTruthy()
    })

    it('create 所有类型都接受端口；HTML 忽略运行时版本且无部署命令', async () => {
      const adapter = make()
      const java = await adapter.create('java', {
        name: 'port-check-java',
        port: 18080,
        runtimeVersion: '17',
      })
      expect(java.port).toBe(18080)
      expect(java.runtimeVersion).toBe('17')

      const html = await adapter.create('html', {
        name: 'port-check-html',
        port: 18081,
        runtimeVersion: '17',
      })
      expect(html.port).toBe(18081)
      expect(html.runtimeVersion).toBeNull()
      expect(html.deployCommand).toBeNull()
    })

    it('create 缺少端口或非 HTML 缺少版本时拒绝', async () => {
      const adapter = make()
      await expect(
        adapter.create('node', { name: 'no-port', port: 0 as unknown as number, runtimeVersion: '20.11.1' }),
      ).rejects.toThrow('端口')
      await expect(
        adapter.create('go', { name: 'no-version', port: 9105 }),
      ).rejects.toThrow('运行时版本')
    })

    it('setRunning 启停改运行状态：非 HTML 启动后补进程号，停止后清空', async () => {
      const adapter = make()
      const created = await adapter.create('node', {
        name: 'start-check',
        port: 3210,
        runtimeVersion: '20.11.1',
      })

      const running = await adapter.setRunning(created.id, true)
      expect(running.runState).toBe('running')
      expect(running.pid).not.toBeNull()

      const off = await adapter.setRunning(created.id, false)
      expect(off.runState).toBe('stopped')
      expect(off.pid).toBeNull()
    })

    it('setRunning 对 HTML 启动后仍无 PID；未知标识报错', async () => {
      const adapter = make()
      const created = await adapter.create('html', { name: '静态主页', port: 8088 })
      const running = await adapter.setRunning(created.id, true)
      expect(running.runState).toBe('running')
      expect(running.pid).toBeNull()
      await expect(adapter.setRunning('site-not-exist', true)).rejects.toThrow()
    })

    it('update 只改备注与到期时间，未知标识报错', async () => {
      const adapter = make()
      const [seed] = await adapter.list()
      const expiry = '2027-01-01T00:00:00'
      const updated = await adapter.update(seed!.id, { note: '改过的备注', expiryAt: expiry })
      expect(updated.note).toBe('改过的备注')
      expect(updated.expiryAt).toBe(expiry)
      expect(updated.name).toBe(seed!.name)

      await expect(adapter.update('site-not-exist', { note: 'x' })).rejects.toThrow()
    })

    it('remove 把项目从列表移除，未知标识报错', async () => {
      const adapter = make()
      const created = await adapter.create('java', {
        name: 'remove-check',
        port: 18082,
        runtimeVersion: '17',
      })
      expect((await adapter.list()).some((project) => project.id === created.id)).toBe(true)

      await adapter.remove(created.id)
      expect((await adapter.list()).some((project) => project.id === created.id)).toBe(false)
      await expect(adapter.remove(created.id)).rejects.toThrow()
    })

    it('logs 对每个项目返回非空行数组；运行中的 HTML 站由 Nginx 提供服务', async () => {
      const adapter = make()
      const projects = await adapter.list()
      for (const project of projects) {
        const lines = await adapter.logs(project.id)
        expect(lines.length).toBeGreaterThan(0)
        expect(lines.every((line) => line.length > 0)).toBe(true)
      }

      const runningHtml = projects.find(
        (project) => project.kind === 'html' && project.runState === 'running',
      )
      expect(runningHtml).toBeTruthy()
      const htmlLogs = await adapter.logs(runningHtml!.id)
      expect(htmlLogs.join('\n')).toContain('Nginx')
    })

    it('logs 对已停止项目包含「已停止」；对不存在的项目拒绝', async () => {
      const adapter = make()
      const projects = await adapter.list()
      const stopped = projects.find((project) => project.runState === 'stopped')
      expect(stopped).toBeTruthy()
      const stoppedLogs = await adapter.logs(stopped!.id)
      expect(stoppedLogs.join('\n')).toContain('已停止')

      await expect(adapter.logs('website-not-exist')).rejects.toThrow('未找到项目')
    })
  })
}

createWebsitesAdapterContractTests('mock 实现', () => new MockWebsitesAdapter())
