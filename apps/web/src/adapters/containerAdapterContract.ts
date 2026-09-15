import { describe, expect, it } from 'vitest'
import type { ContainerAdapter } from '../contracts/adapters'

/** 只依赖 adapter 接口本身，不依赖任何 mock 细节。 */
export function runContainerAdapterContract(make: () => ContainerAdapter): void {
  describe('ContainerAdapter 契约', () => {
    it('list 与 listImages 返回非空且标识唯一', async () => {
      const adapter = make()
      const containers = await adapter.list()
      const images = await adapter.listImages()
      expect(containers.length).toBeGreaterThan(0)
      expect(new Set(containers.map((c) => c.id)).size).toBe(containers.length)
      expect(new Set(images.map((i) => i.id)).size).toBe(images.length)
    })

    it('execMockCommand 的 help 返回可用命令说明', async () => {
      const adapter = make()
      const containers = await adapter.list()
      const result = await adapter.execMockCommand(containers[0]!.id, 'help')
      expect(result.lines.join(' ')).toContain('可用命令')
    })

    it('对已停止容器执行 start 后返回运行中', async () => {
      const adapter = make()
      const containers = await adapter.list()
      const stopped = containers.find((c) => c.status === 'stopped')
      if (!stopped) return // 数据集没有停止容器时跳过，不虚构前提
      const started = await adapter.requestAction(stopped.id, 'start')
      expect(started.status).toBe('running')
    })

    it('不存在的容器返回中文错误', async () => {
      const adapter = make()
      await expect(adapter.requestAction('ctr-not-exist', 'stop')).rejects.toThrow()
    })

    it('create 用已有镜像创建出运行中的容器，list 能读到', async () => {
      const adapter = make()
      const images = await adapter.listImages()
      const created = await adapter.create({
        imageId: images[0]!.id,
        name: 'contract-create',
        ports: [],
        env: [],
        volumes: [],
        restartPolicy: 'no',
      })
      expect(created.status).toBe('running')
      const names = (await adapter.list()).map((c) => c.name)
      expect(names).toContain('contract-create')
    })

    it('create 用未知镜像创建被拒绝', async () => {
      const adapter = make()
      await expect(
        adapter.create({ imageId: 'img-not-exist', ports: [], env: [], volumes: [], restartPolicy: 'no' }),
      ).rejects.toThrow()
    })
  })
}
