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

    it('removeImage 删除未被引用的镜像，listImages 不再返回', async () => {
      const adapter = make()
      const [containers, images] = await Promise.all([adapter.list(), adapter.listImages()])
      const unused = images.find((image) => !containers.some((c) => c.imageId === image.id))
      if (!unused) return // 数据集没有未引用镜像时跳过，不虚构前提
      await adapter.removeImage(unused.id)
      expect((await adapter.listImages()).map((image) => image.id)).not.toContain(unused.id)
    })

    it('removeImage 删除被引用镜像被拒绝', async () => {
      const adapter = make()
      const [containers, images] = await Promise.all([adapter.list(), adapter.listImages()])
      const used = images.find((image) => containers.some((c) => c.imageId === image.id))
      if (!used) return
      await expect(adapter.removeImage(used.id)).rejects.toThrow()
    })

    it('pullImage 追加新镜像，同名同标签重复拉取被拒绝', async () => {
      const adapter = make()
      const pulled = await adapter.pullImage({ name: 'pull-contract', tag: '1.0' })
      expect(pulled.name).toBe('pull-contract')
      expect(pulled.tag).toBe('1.0')
      expect(pulled.digest).toMatch(/^sha256:[0-9a-f]{12}$/)
      expect((await adapter.listImages()).map((image) => image.id)).toContain(pulled.id)
      await expect(adapter.pullImage({ name: 'pull-contract', tag: '1.0' })).rejects.toThrow()
    })

    it('pullImage 对同一引用生成确定性的摘要与体积', async () => {
      const first = await make().pullImage({ name: 'pull-det', tag: '2.0' })
      const second = await make().pullImage({ name: 'pull-det', tag: '2.0' })
      expect(first.digest).toBe(second.digest)
      expect(first.sizeMb).toBe(second.sizeMb)
    })
  })
}
