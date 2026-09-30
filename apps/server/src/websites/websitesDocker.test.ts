import { describe, expect, it } from 'vitest'
import type { DockerTransport } from '../docker/dockerTransport.ts'
import { createWebsiteDocker, websiteContainerCmd } from './websitesDocker.ts'

const ID = 'a'.repeat(64)
const name = 'elysian-site-0123456789ab'

function fixture() {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const transport: DockerTransport = {
    async request(input) {
      calls.push({ method: input.method, path: input.path, body: input.body })
      if (input.path.includes('/containers/create?')) return { status: 201, json: { Id: ID } }
      if (input.path.endsWith('/json')) return { status: 200, json: { Id: ID, Name: `/${name}`, Config: { Image: 'nginx:1.30.4-alpine3.24', Labels: {
        'elysian.managed': 'true', 'elysian.website': 'true', 'elysian.website.project': 'p',
        'elysian.website.kind': 'html', 'elysian.website.version': 'html',
      } }, Mounts: [{ Type: 'bind', Source: '/srv/wwwroot/site', Destination: '/usr/share/nginx/html' }], State: { Running: false } } }
      return { status: 204, json: null }
    },
    async pullCreate() { return { status: 200, chunks: [] } },
  }
  const docker = createWebsiteDocker(transport, async () => [], { mkdir: async () => undefined, realpath: async (path) => path, rm: async () => undefined })
  return { docker, calls }
}

describe('网站容器访问方式', () => {
  it('直连绑定 0.0.0.0，同一个端口进入 Node 容器', async () => {
    const { docker, calls } = fixture()
    await docker.create({ imageRef: 'node:24.21.0', kind: 'node', version: '24.21.0', projectId: 'p', port: 3000,
      bindSource: '/srv/wwwroot/site', containerName: name, accessMode: 'direct', command: 'node dist/main.js' })
    const body = calls[0]!.body as any
    expect(body.HostConfig.PortBindings['3000/tcp']).toEqual([{ HostIp: '0.0.0.0', HostPort: '3000' }])
    expect(body.Cmd).toEqual(['node', 'dist/main.js'])
    expect(body.HostConfig.Binds).toEqual(['/srv/wwwroot/site:/app'])
  })

  it('域名模式回环绑定，HTML 用固定 Nginx 80 端口和只读挂载', async () => {
    const { docker, calls } = fixture()
    await docker.create({ imageRef: 'nginx:1.30.4-alpine3.24', kind: 'html', version: 'html', projectId: 'p', port: 8088,
      bindSource: '/srv/wwwroot/site', containerName: name, accessMode: 'domain', command: null })
    const body = calls[0]!.body as any
    expect(body.HostConfig.PortBindings['80/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: '8088' }])
    expect(body.HostConfig.Binds).toEqual(['/srv/wwwroot/site:/usr/share/nginx/html:ro'])
    expect(body.Cmd).toEqual(['nginx', '-g', 'daemon off;'])
    await expect(docker.removeManaged({ containerId: ID, containerName: name, projectId: 'p', kind: 'html', version: 'html', imageRef: 'nginx:1.30.4-alpine3.24', rootDir: '/srv/wwwroot/site' })).resolves.toBe('removed')
  })

  it('命令按 argv 执行，引号可包含空格且不经 Shell', () => {
    expect(websiteContainerCmd('java', 'java -jar "my app.jar"')).toEqual(['java', '-jar', 'my app.jar'])
    expect(websiteContainerCmd('go', './server --addr 0.0.0.0:8080')).toEqual(['./server', '--addr', '0.0.0.0:8080'])
    expect(() => websiteContainerCmd('go', "./server '未闭合")).toThrow('启动命令的引号或转义不完整')
  })
})
