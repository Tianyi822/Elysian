import { describe, expect, it } from 'vitest'
import type { ContainerImage } from '@elysian/contracts'
import type { DockerTransport } from '../docker/dockerTransport.ts'
import {
  createWebsiteDocker,
  isValidSiteContainerName,
  stripContainerLogFrames,
  websiteContainerCmd,
} from './websitesDocker.ts'

const ID = 'a'.repeat(64)
const NODE_IMAGE: ContainerImage = { id: `sha256:${'b'.repeat(64)}`, name: 'node', tag: '20.11.1', digest: `sha256:${'b'.repeat(64)}`, sizeMb: 200, pulledAt: null }

type Call = { method: string; path: string; body?: unknown }

function inspectJson(overrides: Record<string, unknown> = {}) {
  return {
    Id: ID,
    Name: '/elysian-site-0123456789ab',
    Image: 'sha256:deadbeef',
    State: { Running: true, Pid: 4242 },
    Config: {
      Image: 'node:20.11.1',
      Labels: {
        'elysian.managed': 'true',
        'elysian.website': 'true',
        'elysian.website.project': 'project-1',
        'elysian.website.kind': 'node',
        'elysian.website.version': '20.11.1',
      },
    },
    Mounts: [{ Type: 'bind', Source: '/srv/wwwroot/官网', Destination: '/app' }],
    ...overrides,
  }
}

function fixture(options: {
  images?: readonly ContainerImage[]
  inspectJson?: Record<string, unknown>
  inspectStatus?: number
  actionStatus?: number
  pullStatus?: number
  pullChunks?: readonly Uint8Array[]
} = {}) {
  const calls: Call[] = []
  const transport: DockerTransport = {
    async request(input) {
      calls.push({ method: input.method, path: input.path, body: input.body })
      if (input.path.includes('/containers/create?')) return { status: 201, json: { Id: ID } }
      if (input.path.endsWith('/json')) {
        return { status: options.inspectStatus ?? 200, json: options.inspectJson ?? inspectJson() }
      }
      if (input.path.endsWith('/start') || input.path.endsWith('/stop?t=10')) {
        return { status: options.actionStatus ?? 204, json: null }
      }
      return { status: 204, json: null }
    },
    async pullCreate(input) {
      calls.push({ method: input.method ?? 'POST', path: input.path })
      return { status: options.pullStatus ?? 200, chunks: options.pullChunks ?? [] }
    },
  }
  const fs = {
    mkdirCalls: [] as string[],
    realpath: (path: string) => Promise.resolve(path),
    rmCalls: [] as string[],
  }
  const docker = createWebsiteDocker(transport, async () => options.images ?? [NODE_IMAGE], {
    mkdir: async (path) => { fs.mkdirCalls.push(path) },
    realpath: (path) => fs.realpath(path),
    rm: async (path) => { fs.rmCalls.push(path) },
  })
  return { docker, calls, fs }
}

describe('ensureImage 镜像核对', () => {
  it('镜像在本地（主 tag 或 otherTags 命中）通过；缺失抛中文错误引导容器页拉取', async () => {
    const ok = fixture()
    await expect(ok.docker.ensureImage('node:20.11.1')).resolves.toBeUndefined()
    const byOtherTag = fixture({
      images: [{ ...NODE_IMAGE, name: 'docker.io/library/node', tag: 'latest', otherTags: ['node:20.11.1'] }],
    })
    await expect(byOtherTag.docker.ensureImage('node:20.11.1')).resolves.toBeUndefined()
    const missing = fixture({ images: [] })
    await expect(missing.docker.ensureImage('node:20.11.1')).rejects.toMatchObject({
      status: 409,
      message: '指定版本的运行时镜像尚未拉取：node:20.11.1',
    })
  })
})

describe('ensureSiteDir 站点目录防护', () => {
  it('mkdir 站点目录并返回 <mountRoot>/wwwroot/<项目名>', async () => {
    const { docker, fs } = fixture()
    await expect(docker.ensureSiteDir('官网门户', '/srv')).resolves.toBe('/srv/wwwroot/官网门户')
    expect(fs.mkdirCalls).toEqual(['/srv/wwwroot/官网门户'])
  })

  it('realpath 解析结果逃出 wwwroot 前缀时拒绝（符号链接防线）', async () => {
    const evil = fixture()
    evil.fs.realpath = (path) => Promise.resolve(path === '/srv/wwwroot/官网门户' ? '/srv/escape' : path)
    await expect(evil.docker.ensureSiteDir('官网门户', '/srv')).rejects.toMatchObject({ message: '站点目录经过符号链接，已拒绝' })
  })

  it('挂载根带结尾斜杠时归一化后拼接', async () => {
    const { docker } = fixture()
    await expect(docker.ensureSiteDir('x', '/srv/')).resolves.toBe('/srv/wwwroot/x')
  })
})

describe('create 容器创建请求', () => {
  it('镜像、Cmd、标签、bind、127.0.0.1 同号端口逐字段对齐设计', async () => {
    const { docker, calls } = fixture()
    const { containerId } = await docker.create({
      imageRef: 'node:20.11.1', kind: 'node', version: '20.11.1', projectId: 'project-1',
      port: 3000, bindSource: '/srv/wwwroot/admin-console', containerName: 'elysian-site-0123456789ab',
    })
    expect(containerId).toBe(ID)
    const create = calls.find((call) => call.path.includes('/containers/create?'))
    expect(create?.path).toBe('/v1.41/containers/create?name=elysian-site-0123456789ab')
    const body = create?.body as {
      Image: string
      Cmd: string[]
      Labels: Record<string, string>
      HostConfig: { Binds: string[]; PortBindings: Record<string, { HostIp: string; HostPort: string }[]>; RestartPolicy: { Name: string } }
      ExposedPorts: Record<string, unknown>
    }
    expect(body.Image).toBe('node:20.11.1')
    expect(body.Cmd).toEqual(websiteContainerCmd('node', 3000))
    expect(body.Labels).toEqual({
      'elysian.managed': 'true',
      'elysian.website': 'true',
      'elysian.website.project': 'project-1',
      'elysian.website.kind': 'node',
      'elysian.website.version': '20.11.1',
    })
    expect(body.HostConfig.Binds).toEqual(['/srv/wwwroot/admin-console:/app'])
    expect(body.HostConfig.PortBindings['3000/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: '3000' }])
    expect(body.HostConfig.RestartPolicy).toEqual({ Name: 'unless-stopped' })
    expect(body.ExposedPorts).toEqual({ '3000/tcp': {} })
  })

  it('容器名不符合面板生成形态时拒绝，不发起引擎请求', async () => {
    const { docker, calls } = fixture()
    await expect(docker.create({
      imageRef: 'node:20.11.1', kind: 'node', version: '20.11.1', projectId: 'p',
      port: 3000, bindSource: '/srv/wwwroot/x', containerName: 'my-site',
    })).rejects.toMatchObject({ message: '容器名称无效' })
    expect(calls).toHaveLength(0)
    expect(isValidSiteContainerName('elysian-site-0123456789ab')).toBe(true)
    expect(isValidSiteContainerName('elysian-site-XYZ')).toBe(false)
  })

  it('非 201 响应抛「创建站点容器失败」并带引擎消息', async () => {
    const calls: Call[] = []
    const transport: DockerTransport = {
      async request(input) {
        calls.push({ method: input.method, path: input.path, body: input.body })
        if (input.path.includes('/containers/create?')) return { status: 404, json: { message: 'No such image' } }
        return { status: 204, json: null }
      },
    }
    const docker = createWebsiteDocker(transport, async () => [NODE_IMAGE], {
      mkdir: async () => undefined, realpath: (path: string) => Promise.resolve(path), rm: async () => undefined,
    })
    await expect(docker.create({
      imageRef: 'node:20.11.1', kind: 'node', version: '20.11.1', projectId: 'p',
      port: 3000, bindSource: '/srv/wwwroot/x', containerName: 'elysian-site-0123456789ab',
    })).rejects.toMatchObject({ message: '创建站点容器失败：No such image' })
  })
})

describe('websiteContainerCmd 命令推导', () => {
  it('与契约显示字符串保持一致（单一事实来源）', () => {
    expect(websiteContainerCmd('python', 8000)).toEqual([
      'python3', '-m', 'http.server', '8000', '--bind', '0.0.0.0', '--directory', '/app',
    ])
    expect(websiteContainerCmd('java', 8080)).toEqual(['tail', '-f', '/dev/null'])
    expect(websiteContainerCmd('go', 9100)).toEqual(['tail', '-f', '/dev/null'])
    const node = websiteContainerCmd('node', 3000)
    expect(node).toHaveLength(3)
    expect(node[0]).toBe('node')
    expect(node[1]).toBe('-e')
    expect(node[2]).toContain('.listen(3000)')
    expect(node[2]).not.toContain('\n')
  })
})

describe('启停与 inspect 的 404 语义', () => {
  it('start/stop 404 语义化为「站点容器已不存在」，304 幂等视为成功', async () => {
    const missing = fixture({ inspectStatus: 404, inspectJson: {}, actionStatus: 404 })
    await expect(missing.docker.start(ID)).rejects.toMatchObject({ status: 404, message: '站点容器已不存在' })
    await expect(missing.docker.inspect(ID)).rejects.toMatchObject({ status: 404, message: '站点容器已不存在' })
    const ok = fixture()
    await expect(ok.docker.start(ID)).resolves.toBeUndefined()
    await expect(ok.docker.stop(ID)).resolves.toBeUndefined()
    expect(ok.calls.find((call) => call.path.endsWith('/stop?t=10'))).toMatchObject({ method: 'POST' })
    const idempotent = fixture({ actionStatus: 304 })
    await expect(idempotent.docker.stop(ID)).resolves.toBeUndefined()
  })
})

describe('stripContainerLogFrames 帧头剥离', () => {
  it('按 8 字节帧头切分并拼接多帧 stdout/stderr 交织样本', () => {
    const frame = (streamType: number, payload: string): Uint8Array => {
      const header = Buffer.alloc(8)
      header[0] = streamType
      header.writeUInt32BE(Buffer.byteLength(payload), 4)
      return Buffer.concat([header, Buffer.from(payload)])
    }
    const stream = Buffer.concat([
      frame(1, '第一行\n'),
      frame(2, '错误输出\n'),
      frame(1, '第二行'),
    ])
    expect(stripContainerLogFrames(stream)).toBe('第一行\n错误输出\n第二行')
  })

  it('无帧头的裸文本兜底按 UTF-8 解码（防御性）', () => {
    expect(stripContainerLogFrames(Buffer.from('裸文本\n'))).toBe('裸文本\n')
  })

  it('logs 走 GET + stdout/stderr + tail=200，非 200 抛中文错误', async () => {
    const frame = (payload: string): Uint8Array => {
      const header = Buffer.alloc(8)
      header[0] = 1
      header.writeUInt32BE(Buffer.byteLength(payload), 4)
      return Buffer.concat([header, Buffer.from(payload)])
    }
    const ok = fixture({ pullChunks: [frame('line-1\n'), frame('line-2\n')] })
    await expect(ok.docker.logs(ID)).resolves.toEqual(['line-1', 'line-2'])
    expect(ok.calls.find((call) => call.path.includes('/logs?'))).toMatchObject({
      method: 'GET',
      path: `/v1.41/containers/${ID}/logs?stdout=1&stderr=1&tail=200`,
    })
    const failing = fixture({ pullStatus: 500 })
    await expect(failing.docker.logs(ID)).rejects.toMatchObject({ message: '读取容器日志失败' })
  })
})

describe('removeManaged 五重核对删除', () => {
  const identity = {
    containerId: ID,
    containerName: 'elysian-site-0123456789ab',
    projectId: 'project-1',
    kind: 'node' as const,
    version: '20.11.1',
    imageRef: 'node:20.11.1',
    rootDir: '/srv/wwwroot/官网',
  }

  it('核对全过：先 stop 再 remove（v=false）', async () => {
    const { docker, calls } = fixture()
    await expect(docker.removeManaged(identity)).resolves.toBe('removed')
    expect(calls.find((call) => call.path.endsWith('/stop?t=10'))).toMatchObject({ method: 'POST' })
    expect(calls.find((call) => call.method === 'DELETE' && call.path === `/v1.41/containers/${ID}?v=false`)).toBeDefined()
  })

  it('容器已被外部删除（inspect 404）返回 missing，跳过容器删除', async () => {
    const { docker, calls } = fixture({ inspectStatus: 404, inspectJson: {} })
    await expect(docker.removeManaged(identity)).resolves.toBe('missing')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
  })

  it.each([
    ['容器名不符', inspectJson({ Name: '/not-our-container' })],
    ['标签缺失', inspectJson({ Config: { Image: 'node:20.11.1', Labels: { 'elysian.managed': 'true' } } })],
    ['镜像引用不符', inspectJson({ Config: { Image: 'node:18.19.1', Labels: inspectJson().Config.Labels } })],
    ['bind 挂载缺失', inspectJson({ Mounts: [] })],
  ])('核对不过（%s）抛「站点容器身份核对失败」且不删', async (_label, json) => {
    const { docker, calls } = fixture({ inspectJson: json })
    await expect(docker.removeManaged(identity)).rejects.toMatchObject({ status: 409, message: '站点容器身份核对失败' })
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
  })

  it('面板自身容器先于核对被拒绝（自保双保险）', async () => {
    const self = fixture()
    // 自容器判定允许 selfContainerId 以 inspect Id 为前缀（对齐 selfContainer 通道口径）。
    await expect(self.docker.removeManaged({ ...identity, selfContainerId: `${ID}ff` }))
      .rejects.toMatchObject({ status: 403, message: '不能删除面板自身容器' })
  })
})

describe('removeSiteDir 目录删除防护', () => {
  it('realpath 复核仍在 wwwroot 下后递归删除', async () => {
    const { docker, fs } = fixture()
    await docker.removeSiteDir('/srv/wwwroot/官网', '/srv')
    expect(fs.rmCalls).toEqual(['/srv/wwwroot/官网'])
  })

  it('目录逃出 wwwroot 前缀时拒绝；已被外部删除时视为已清理', async () => {
    const evil = fixture()
    evil.fs.realpath = (path) => Promise.resolve(path === '/srv/wwwroot/x' ? '/srv/escape' : path)
    await expect(evil.docker.removeSiteDir('/srv/wwwroot/x', '/srv')).rejects.toMatchObject({ message: '站点目录经过符号链接，已拒绝' })
    const gone = fixture()
    gone.fs.realpath = (_path: string) => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    await expect(gone.docker.removeSiteDir('/srv/wwwroot/x', '/srv')).resolves.toBeUndefined()
    const outside = fixture()
    await expect(outside.docker.removeSiteDir('/etc/passwd', '/srv')).rejects.toMatchObject({ message: '站点目录无效' })
  })
})
