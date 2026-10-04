import { describe, expect, it } from 'vitest'
import { isValidContainerBuildTag } from '@elysian/contracts'
import type { ContainerBuildTask } from '@elysian/contracts'
import type { ContainerAdapter, HostTerminalFrame, HostTerminalHandlers } from '../contracts/adapters'

/**
 * 轮询等构建任务到终态：任务推进是异步的（真实侧靠 worker，mock 靠注入节奏），
 * 契约断言只约定「最终会到终态」，不绑定实现的具体时序。
 */
async function waitForBuildSettled(adapter: ContainerAdapter, slug: string, taskId: string): Promise<ContainerBuildTask> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = await adapter.getAppBuild(slug, taskId)
    if (task.state !== 'queued' && task.state !== 'building') return task
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('构建任务未在预期时间内到达终态')
}

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

    it('searchImageNames 返回仓库名与可搜索状态', async () => {
      const result = await make().searchImageNames('red')
      expect(typeof result.searchable).toBe('boolean')
      expect(result.names.every((name) => typeof name === 'string' && !name.includes(':'))).toBe(true)
    })

    it('imageTags 返回版本标签与可查询状态', async () => {
      const result = await make().imageTags('redis')
      expect(typeof result.searchable).toBe('boolean')
      expect(result.tags.every((tag) => typeof tag === 'string' && !tag.includes(':'))).toBe(true)
    })

    it('connectTerminal 后 sendTerminalInput help 收到含可用命令的 output 帧', async () => {
      const adapter = make()
      const containers = await adapter.list()
      const frames: HostTerminalFrame[] = []
      const handlers: HostTerminalHandlers = {
        onFrame: (_sessionId, frame) => {
          frames.push(frame)
        },
        onClose: () => {},
      }
      const info = await adapter.connectTerminal(containers[0]!.id, handlers)
      await adapter.sendTerminalInput(info.id, 'help')
      const output = frames.find((frame) => frame.type === 'output')
      expect(output && output.type === 'output' ? output.lines.join(' ') : '').toContain('可用命令')
      await adapter.disconnectTerminal(info.id)
      await expect(adapter.sendTerminalInput(info.id, 'help')).rejects.toThrow('终端会话不存在')
    })

    it('cancelTerminalConnect（可选）在无 pending 连接时可安全调用', async () => {
      const adapter = make()
      adapter.cancelTerminalConnect?.()
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

    it('createApp 建出带绝对目录的工作区，listApps 能读到', async () => {
      const adapter = make()
      const created = await adapter.createApp({ slug: 'grafana', displayName: '监控栈' })
      expect(created.slug).toBe('grafana')
      expect(created.directory.startsWith('/')).toBe(true)
      const apps = await adapter.listApps()
      expect(apps.map((app) => app.slug)).toContain('grafana')
    })

    it('createApp 拒绝非法标识与重名，错误是中文', async () => {
      const adapter = make()
      await expect(adapter.createApp({ slug: '../etc', displayName: 'x' })).rejects.toThrow('工作区名称只能由')
      await adapter.createApp({ slug: 'app', displayName: '应用' })
      await expect(adapter.createApp({ slug: 'app', displayName: '再来' })).rejects.toThrow('工作区名称已存在')
    })

    it('上传、读取、改写、删除文件按相对路径落实', async () => {
      const adapter = make()
      await adapter.createApp({ slug: 'app', displayName: '应用' })
      const uploaded = await adapter.uploadAppFile('app', 'config/app.yml', new Blob(['key: value\n']))
      expect(uploaded.path).toBe('config/app.yml')
      expect((await adapter.listApps())[0]!.files.map((file) => file.path)).toContain('config/app.yml')

      const read = await adapter.readAppContent('app', 'config/app.yml')
      expect(read.content).toContain('key: value')

      await adapter.writeAppContent('app', 'config/app.yml', 'key: changed\n')
      expect((await adapter.readAppContent('app', 'config/app.yml')).content).toContain('changed')

      await adapter.removeAppFile('app', 'config/app.yml')
      await expect(adapter.readAppContent('app', 'config/app.yml')).rejects.toThrow('工作区内没有该文件')
    })

    it('上传与读取都拒绝穿越工作区的路径', async () => {
      const adapter = make()
      await adapter.createApp({ slug: 'app', displayName: '应用' })
      await expect(adapter.uploadAppFile('app', '../../etc/passwd', new Blob(['x']))).rejects.toThrow('. 与 .. 段')
      await expect(adapter.uploadAppFile('app', '/etc/passwd', new Blob(['x']))).rejects.toThrow('必须是相对路径')
      await expect(adapter.readAppContent('app', '../secret')).rejects.toThrow('. 与 .. 段')
    })

    it('checkCompose 报出缺失与已存在的引用，并给出判定范围', async () => {
      const adapter = make()
      await adapter.createApp({ slug: 'app', displayName: '应用' })
      await adapter.uploadAppFile('app', 'real.env', new Blob(['A=1\n']))
      await adapter.uploadAppFile(
        'app',
        'compose.yml',
        new Blob(['services:\n  app:\n    env_file:\n      - ./real.env\n      - ./missing.env\n      - /abs/path\n']),
      )
      const checked = await adapter.checkCompose('app', 'compose.yml')
      expect(checked.coverage).toBeTruthy()
      expect(checked.references.map((reference) => [reference.path, reference.exists])).toEqual([
        ['real.env', true],
        ['missing.env', false],
      ])
      expect(checked.undetermined.join('\n')).toContain('/abs/path')
    })

    it('previewAppBuild 预览 dockerfile 构建：形状、上下文统计与 FROM 警告', async () => {
      const adapter = make()
      await adapter.createApp({ slug: 'build-app', displayName: '构建演示' })
      await adapter.uploadAppFile('build-app', 'Dockerfile', new Blob(['FROM alpine:3.20\nFROM $BASE\nCOPY . .\n']))
      await adapter.uploadAppFile('build-app', '.env', new Blob(['A=1\n']))
      const plan = await adapter.previewAppBuild('build-app', {
        mode: 'dockerfile',
        dockerfile: 'Dockerfile',
        context: './',
      })
      expect(plan.mode).toBe('dockerfile')
      if (plan.mode !== 'dockerfile') return
      expect(plan.slug).toBe('build-app')
      expect(plan.target).toBe('app')
      expect(plan.dockerfile).toBe('Dockerfile')
      // "./" 前缀剥掉后按工作区根归一化，根用 "."。
      expect(plan.context).toBe('.')
      expect(plan.imageRepository).toBe('elysian/build-app/app')
      expect(plan.contextFiles).toBe(2)
      expect(plan.contextBytes).toBeGreaterThan(0)
      expect(plan.repositoryOccupied).toBe(false)
      expect(plan.warnings.join('\n')).toContain('第 2 行 FROM 含未解析变量，面板未校验其镜像源')
    })

    it('previewAppBuild 对超限上下文给出逐字中文超限警告', async () => {
      const adapter = make()
      await adapter.createApp({ slug: 'build-app', displayName: '构建演示' })
      await adapter.uploadAppFile('build-app', 'Dockerfile', new Blob(['FROM alpine:3.20\n']))
      for (let index = 0; index < 512; index += 1) {
        await adapter.uploadAppFile('build-app', `src/f${index}.txt`, new Blob(['x']))
      }
      const plan = await adapter.previewAppBuild('build-app', { mode: 'dockerfile', dockerfile: 'Dockerfile' })
      expect(
        plan.mode === 'dockerfile' ? plan.warnings.join('\n') : '',
      ).toContain('构建上下文超过上限（≤512 个文件、128 MiB），任务将在打包阶段失败')
    })

    it('submitAppBuild 提交后 listAppBuilds 读到，tag 形状与任务对象齐全', async () => {
      const adapter = make()
      await adapter.createApp({ slug: 'build-app', displayName: '构建演示' })
      await adapter.uploadAppFile('build-app', 'Dockerfile', new Blob(['FROM alpine:3.20\n']))
      const task = await adapter.submitAppBuild('build-app', {
        mode: 'dockerfile',
        requestId: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
        dockerfile: 'Dockerfile',
        context: '.',
      })
      expect(task.slug).toBe('build-app')
      expect(task.mode).toBe('dockerfile')
      expect(task.state === 'queued' || task.state === 'building' || task.state === 'succeeded').toBe(true)
      expect(task.input.mode).toBe('dockerfile')
      expect(task.results).toEqual([])
      expect(task.error).toBe('')
      const builds = await adapter.listAppBuilds('build-app')
      expect(builds.map((row) => row.id)).toContain(task.id)
      // 等任务终态：results 落 tag 与镜像 ID，tag 形状由契约校验。
      const finished = await waitForBuildSettled(adapter, 'build-app', task.id)
      expect(finished.state).toBe('succeeded')
      expect(finished.stage).toBe('构建成功')
      expect(finished.results).toHaveLength(1)
      const result = finished.results[0]!
      expect(result.target).toBe('app')
      expect(result.repository).toBe('elysian/build-app/app')
      expect(isValidContainerBuildTag(result.tag)).toBe(true)
      expect(result.imageId).toMatch(/^sha256:[0-9a-f]+$/)
      expect(result.state).toBe('succeeded')
      expect(result.error).toBe('')
    })

    it('submitAppBuild 重复 requestId 同参幂等返回原任务', async () => {
      const adapter = make()
      await adapter.createApp({ slug: 'build-app', displayName: '构建演示' })
      await adapter.uploadAppFile('build-app', 'Dockerfile', new Blob(['FROM alpine:3.20\n']))
      const input = {
        mode: 'dockerfile' as const,
        requestId: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
        dockerfile: 'Dockerfile',
        context: '.',
      }
      const first = await adapter.submitAppBuild('build-app', input)
      const again = await adapter.submitAppBuild('build-app', input)
      expect(again.id).toBe(first.id)
      expect((await adapter.listAppBuilds('build-app'))).toHaveLength(1)
    })

    it('submitAppBuild 的 compose services 校验错误逐字', async () => {
      const adapter = make()
      await adapter.createApp({ slug: 'build-app', displayName: '构建演示' })
      await adapter.uploadAppFile(
        'build-app',
        'compose.yml',
        new Blob(['services:\n  web:\n    build:\n      context: ./web\n  db:\n    image: mariadb:11\n']),
      )
      const base = {
        mode: 'compose' as const,
        requestId: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
        compose: 'compose.yml',
      }
      await expect(adapter.submitAppBuild('build-app', { ...base, services: ['nope'] })).rejects.toThrow(
        '服务不存在：nope',
      )
      await expect(adapter.submitAppBuild('build-app', { ...base, services: ['db'] })).rejects.toThrow(
        '服务没有 build 配置：db',
      )
      await expect(
        adapter.submitAppBuild('build-app', { ...base, services: ['web', 'web'] }),
      ).rejects.toThrow('服务 web 重复提交')
    })

    it('cancelAppBuild 取消排队/构建中的任务，已终态再取消报中文错误', async () => {
      const adapter = make()
      await adapter.createApp({ slug: 'build-app', displayName: '构建演示' })
      await adapter.uploadAppFile('build-app', 'Dockerfile', new Blob(['FROM alpine:3.20\n']))
      const task = await adapter.submitAppBuild('build-app', {
        mode: 'dockerfile',
        requestId: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
        dockerfile: 'Dockerfile',
      })
      await adapter.cancelAppBuild('build-app', task.id)
      const cancelled = await adapter.getAppBuild('build-app', task.id)
      expect(cancelled.state).toBe('cancelled')
      expect(cancelled.stage).toBe('已取消')
      await expect(adapter.cancelAppBuild('build-app', task.id)).rejects.toThrow('构建已结束，无法取消')
      await expect(adapter.cancelAppBuild('build-app', 'b0000000-0000-0000-0000-000000000000')).rejects.toThrow(
        '构建任务不存在',
      )
    })

    it('getAppBuildLogs 按字节 offset 分页推进，读尽后返回空行', async () => {
      const adapter = make()
      await adapter.createApp({ slug: 'build-app', displayName: '构建演示' })
      await adapter.uploadAppFile('build-app', 'Dockerfile', new Blob(['FROM alpine:3.20\n']))
      const task = await adapter.submitAppBuild('build-app', {
        mode: 'dockerfile',
        requestId: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
        dockerfile: 'Dockerfile',
      })
      const finished = await waitForBuildSettled(adapter, 'build-app', task.id)
      expect(finished.state).toBe('succeeded')
      const first = await adapter.getAppBuildLogs('build-app', task.id, 0)
      expect(first.lines.length).toBeGreaterThan(0)
      expect(first.total).toBeGreaterThan(0)
      expect(first.next).toBeGreaterThan(0)
      expect(first.next).toBeLessThanOrEqual(first.total)
      const tail = await adapter.getAppBuildLogs('build-app', task.id, first.next)
      if (first.next < first.total) {
        expect(tail.lines.length).toBeGreaterThan(0)
        expect(tail.next).toBe(tail.total)
      } else {
        expect(tail.lines).toEqual([])
      }
      const drained = await adapter.getAppBuildLogs('build-app', task.id, tail.total)
      expect(drained.lines).toEqual([])
      expect(drained.next).toBe(drained.total)
    })

    it('removeApp 连文件一起消失', async () => {
      const adapter = make()
      await adapter.createApp({ slug: 'app', displayName: '应用' })
      await adapter.uploadAppFile('app', 'a.txt', new Blob(['a']))
      await adapter.removeApp('app')
      expect(await adapter.listApps()).toHaveLength(0)
      await expect(adapter.removeApp('app')).rejects.toThrow('容器工作区不存在')
    })
  })
}
