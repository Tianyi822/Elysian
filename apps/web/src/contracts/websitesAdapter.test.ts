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
        expect(project.rootDir.startsWith('/')).toBe(true)

        // PID 与端口只有 Java 与 Node 才有；Node 才有运行时版本；Go 没有到期时间。
        if (project.kind === 'java' || project.kind === 'node') {
          expect(project.port).not.toBeNull()
        } else {
          expect(project.port).toBeNull()
          expect(project.pid).toBeNull()
        }
        if (project.kind === 'node') {
          expect(project.runtimeVersion).toBeTruthy()
        } else {
          expect(project.runtimeVersion).toBeNull()
        }
        if (project.kind === 'go') {
          expect(project.expiryAt).toBeNull()
        }
        // 运行中的 Java/Node 项目必有进程号；已停止的没有。
        if (project.runState === 'running' && (project.kind === 'java' || project.kind === 'node')) {
          expect(project.pid).not.toBeNull()
        }
        if (project.runState === 'stopped') {
          expect(project.pid).toBeNull()
        }
        // 流量统计存在且非负；部署命令与类型互斥：HTML 静态站为 null，其余类型必有。
        expect(project.traffic).toBeTruthy()
        expect(project.traffic.todayMb).toBeGreaterThanOrEqual(0)
        expect(project.traffic.totalGb).toBeGreaterThanOrEqual(0)
        if (project.kind === 'html') {
          expect(project.deployCommand).toBeNull()
        } else {
          expect(project.deployCommand).not.toBeNull()
        }
      }
    })

    it('五种类型各有种子数据，界面不会一进来就空', async () => {
      const projects = await make().list()
      for (const kind of ['java', 'node', 'go', 'python', 'html'] as const) {
        expect(projects.some((project) => project.kind === kind), `缺 ${kind} 种子`).toBe(true)
      }
    })

    it('create 新建即已停止、无证书；根目录缺省由名称推导；同名同类型拒绝', async () => {
      const adapter = make()
      const created = await adapter.create('python', { name: '报表服务', note: '演示新建' })

      expect(created.kind).toBe('python')
      expect(created.name).toBe('报表服务')
      expect(created.runState).toBe('stopped')
      expect(created.pid).toBeNull()
      expect(created.cert).toBe('none')
      expect(created.rootDir).toBe('/www/wwwroot/报表服务')
      expect(created.port).toBeNull()
      // 新建项目流量从零计起；非 HTML 类型的部署命令按类型给缺省。
      expect(created.traffic).toEqual({ todayMb: 0, totalGb: 0 })
      expect(created.deployCommand).not.toBeNull()

      const again = adapter.create('python', { name: '报表服务' })
      await expect(again).rejects.toThrow('已存在')

      // 不同类型同名不冲突：项目与隔离目录天然按类型分开。
      await expect(adapter.create('go', { name: '报表服务' })).resolves.toBeTruthy()
    })

    it('create 只有 Java 与 Node 接受端口，其余类型端口被忽略', async () => {
      const adapter = make()
      const java = await adapter.create('java', { name: 'port-check-java', port: 18080 })
      expect(java.port).toBe(18080)

      const html = await adapter.create('html', { name: 'port-check-html', port: 18081 })
      expect(html.port).toBeNull()
      // HTML 静态站没有部署命令，由 Web 服务直接托管。
      expect(html.deployCommand).toBeNull()
    })

    it('setRunning 启停改运行状态：Java/Node 启动后补进程号，停止后清空', async () => {
      const adapter = make()
      const created = await adapter.create('node', { name: 'start-check', port: 3210 })

      const running = await adapter.setRunning(created.id, true)
      expect(running.runState).toBe('running')
      expect(running.pid).not.toBeNull()

      const stopped = await adapter.setRunning(created.id, true)
      expect(stopped.runState).toBe('running')

      const off = await adapter.setRunning(created.id, false)
      expect(off.runState).toBe('stopped')
      expect(off.pid).toBeNull()
    })

    it('setRunning 对不存在或非端口类型的 PID 语义稳定：HTML 启动后仍无 PID', async () => {
      const adapter = make()
      const created = await adapter.create('html', { name: '静态主页' })
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
      const created = await adapter.create('java', { name: 'remove-check', port: 18082 })
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
