import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { serve } from 'bun'
import { Hono } from 'hono'
import { resolveAvailability } from '../shared/availability.ts'
import { bunWebSocket } from './bunWebSocket.ts'
import { TERMINAL_MOUNT, createTerminalsApp } from './terminalsRoutes.ts'
import { createTerminalsHostDeps } from './terminalsHostDeps.ts'

/*
 * 终端片的容器内真实冒烟（bun test 点名执行，vitest 不收集）：真 app + 真升级 +
 * 真 PTY（script 管道驱动容器内 bash）。宿主机上整文件跳过——真实执行纪律：一切
 * spawn PTY 的动作只发生在容器内。
 *
 * 安全基线 1 的唯一真升级锚定在本文件：无 Origin、Origin 与 Host 不一致、Host 不在
 * 名单三种握手断言 onopen 均不触发。冒烟客户端一律用 Bun 扩展签名注入 Origin
 * （裸 new WebSocket(url) 不发 Origin 头，会被「Origin 缺失即拒」403 挡掉），
 * 绝不为让裸客户端连上而放宽同源校验。
 */

const IN_DOCKER = resolveAvailability(process.env, existsSync('/.dockerenv'))

type AnyFrame = { type: string } & Record<string, unknown>

type CloseInfo = { code: number; reason: string }

function createClient(url: string, headers?: Record<string, string>) {
  const frames: AnyFrame[] = []
  const waiters: Array<{ match: (frame: AnyFrame) => boolean; resolve: (frame: AnyFrame) => void }> = []
  let closed: CloseInfo | null = null
  const closeWaiters: Array<(info: CloseInfo) => void> = []
  const ws = headers ? new WebSocket(url, { headers }) : new WebSocket(url)
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('WebSocket 连接失败'))
  })
  ws.onmessage = (evt) => {
    const frame = JSON.parse(String(evt.data)) as AnyFrame
    frames.push(frame)
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i]!.match(frame)) {
        const waiter = waiters[i]!
        waiters.splice(i, 1)
        waiter.resolve(frame)
      }
    }
  }
  ws.onclose = (evt) => {
    closed = { code: evt.code, reason: evt.reason }
    for (const cb of closeWaiters.splice(0)) cb(closed)
  }
  return {
    ws,
    frames,
    opened,
    send(value: unknown) {
      ws.send(JSON.stringify(value))
    },
    sendRaw(text: string) {
      ws.send(text)
    },
    /** 只等待注册之后到达的帧（不回扫历史），保序断言靠它。 */
    waitFrame(match: (frame: AnyFrame) => boolean, timeoutMs = 10000): Promise<AnyFrame> {
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve })
        setTimeout(() => reject(new Error('等待帧超时')), timeoutMs)
      })
    },
    waitClose(timeoutMs = 10000): Promise<CloseInfo> {
      return new Promise((resolve, reject) => {
        if (closed) {
          resolve(closed)
          return
        }
        closeWaiters.push(resolve)
        setTimeout(() => reject(new Error('等待关闭超时')), timeoutMs)
      })
    },
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`超时：${label}`)), ms)),
  ])
}

/** 断言握手被拒：onopen 绝不触发，onclose（或 onerror 后的 onclose）到达。 */
function expectUpgradeRejected(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    let opened = false
    ws.onopen = () => {
      opened = true
    }
    ws.onerror = () => undefined
    ws.onclose = () => {
      if (opened) reject(new Error('连接被升级打开（安全基线 1 失效）'))
      else resolve()
    }
    setTimeout(() => {
      if (opened) reject(new Error('连接被升级打开（安全基线 1 失效）'))
      else reject(new Error('握手既未打开也未关闭'))
    }, 4000)
  })
}

/** ps 残留检查：过滤自身 grep，返回匹配行（空串即零残留）。 */
function psGrep(pattern: string): string {
  const proc = Bun.spawnSync(['sh', '-c', `ps -eo pid,ppid,args | grep -E '${pattern}' | grep -v grep || true`])
  return proc.stdout.toString().trim()
}

describe.skipIf(!IN_DOCKER)('terminalsWiring（容器内真实冒烟）', () => {
  let port = 0
  let server: ReturnType<typeof serve>

  beforeAll(async () => {
    const app = createTerminalsApp(await createTerminalsHostDeps())
    server = serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, srv) => app.fetch(request, srv),
      websocket: bunWebSocket.websocket,
    })
    port = server.port
  })

  afterAll(async () => {
    server.stop(true)
    // 停机清场：给 onClose → dispose → SIGKILL 一点完成时间，不留孤儿进测试之后。
    await new Promise((resolve) => setTimeout(resolve, 800))
  })

  function wsUrl(): string {
    return `ws://127.0.0.1:${port}/ws`
  }

  function sameOrigin(): Record<string, string> {
    return { origin: `http://127.0.0.1:${port}` }
  }

  /** 打开一个会话并等到 ready 帧与首个 prompt 帧（初始命令结束信号）；失败即关连接不留槽位。 */
  async function openSession() {
    const client = createClient(wsUrl(), sameOrigin())
    try {
      await client.opened
      const ready = await client.waitFrame((frame) => frame.type === 'ready')
      await client.waitFrame((frame) => frame.type === 'prompt')
      return { client, ready }
    } catch (error) {
      client.ws.close()
      throw error
    }
  }

  it('/status 可用时返回 200 {ok:true}', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/status`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('升级握手通过，ready 帧带真实身份与命令表', async () => {
    const { client, ready } = await openSession()
    const session = ready.session as { id: string; user: string; hostLabel: string; prompt: string }
    expect(typeof session.id).toBe('string')
    expect(session.id.length).toBeGreaterThan(0)
    expect(typeof session.user).toBe('string')
    expect(session.user.length).toBeGreaterThan(0)
    expect(typeof session.hostLabel).toBe('string')
    expect(session.prompt).toContain(':~$ ')
    const commands = (ready.completion as { commands: string[] }).commands
    expect(Array.isArray(commands)).toBe(true)
    expect(commands).toContain('ls')
    client.ws.close()
  })

  it('input 往返：echo 输出经 output 帧回流，cd 后 prompt 帧跟踪 cwd', async () => {
    const { client } = await openSession()
    client.send({ type: 'input', data: 'echo marker-one' })
    const afterEcho = await client.waitFrame((frame) => frame.type === 'prompt')
    const outputs = client.frames.filter((frame) => frame.type === 'output') as Array<{ lines: string[] }>
    expect(outputs.some((frame) => frame.lines.includes('marker-one'))).toBe(true)

    client.send({ type: 'input', data: 'cd /tmp' })
    const afterCd = await client.waitFrame((frame) => frame.type === 'prompt' && frame.cwd === '/tmp')
    expect((afterCd as { prompt: string }).prompt).toContain(':/tmp$ ')
    const files = (afterCd as { completion: { files: string[] | null } }).completion.files
    expect(Array.isArray(files)).toBe(true)
    client.ws.close()
  }, 15000)

  it('interrupt 帧写 \\x03：sleep 30 在数秒内被打断并回到提示符', async () => {
    const { client } = await openSession()
    client.send({ type: 'input', data: 'sleep 30' })
    await new Promise((resolve) => setTimeout(resolve, 400))
    client.send({ type: 'interrupt' })
    await withTimeout(client.waitFrame((frame) => frame.type === 'prompt'), 5000, 'interrupt 后的 prompt 帧')
    client.ws.close()
  }, 15000)

  it('ping 帧立即回 pong', async () => {
    const { client } = await openSession()
    client.send({ type: 'ping' })
    const pong = await client.waitFrame((frame) => frame.type === 'pong')
    expect(pong.type).toBe('pong')
    client.ws.close()
  })

  it('违规帧：非 JSON 文本以 1008 关闭并带中文 reason', async () => {
    const { client } = await openSession()
    client.sendRaw('not json')
    const info = await client.waitClose()
    expect(info.code).toBe(1008)
    expect(info.reason).toBe('终端消息不是有效 JSON')
  })

  it('exit：exit 帧带退出码并以 1000 关闭', async () => {
    const { client } = await openSession()
    client.send({ type: 'input', data: 'exit' })
    const exit = await client.waitFrame((frame) => frame.type === 'exit')
    expect((exit as { exitCode: number }).exitCode).toBe(0)
    const info = await client.waitClose()
    expect(info.code).toBe(1000)
  })

  it('单轮预算：洪水触发 truncated 帧且会话存活', async () => {
    const { client } = await openSession()
    try {
      // 单行 280000 字节（无换行）：行内容字节数直接超 256 KiB 单轮预算 → 整行丢弃。
      // 体积刻意贴着预算上浮：script 管道的实测吞吐在更大体量（600KB）会出现十余秒级迟滞。
      client.send({ type: 'input', data: "head -c 280000 /dev/zero | tr '\\0' x" })
      const truncated = await client.waitFrame((frame) => frame.type === 'truncated', 20000)
      expect((truncated as { droppedBytes: number }).droppedBytes).toBe(280000)
      await client.waitFrame((frame) => frame.type === 'prompt', 20000)
    } finally {
      client.ws.close()
    }
  }, 45000)

  it('并发上限：第 6 条连接升级后以 1008 中文 reason 关闭', async () => {
    const sessions: Array<Awaited<ReturnType<typeof openSession>>> = []
    try {
      for (let i = 0; i < 5; i += 1) {
        sessions.push(await openSession())
      }
      const sixth = createClient(wsUrl(), sameOrigin())
      await sixth.opened
      const info = await sixth.waitClose()
      expect(info.code).toBe(1008)
      expect(info.reason).toBe('并发终端会话已达上限（5）')
    } finally {
      for (const session of sessions) session.client.ws.close()
    }
  }, 45000)

  it('断开即杀：关闭连接后容器内无 script/sleep 残留', async () => {
    const { client } = await openSession()
    client.send({ type: 'input', data: 'sleep 300' })
    await new Promise((resolve) => setTimeout(resolve, 500))
    client.ws.close()
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(psGrep('sleep 300|script -qfc')).toBe('')
  }, 15000)

  describe('负向握手（安全基线 1 的唯一真升级锚定）', () => {
    it('无 Origin（裸客户端不发 Origin 头）不触发 onopen', async () => {
      await expectUpgradeRejected(new WebSocket(wsUrl()))
    })

    it('Origin 与 Host 不一致不触发 onopen', async () => {
      await expectUpgradeRejected(new WebSocket(wsUrl(), { headers: { origin: 'http://evil.example' } }))
    })

    it('Host 不在回环名单（Origin 与 Host 一致的 rebinding 形）不触发 onopen', async () => {
      await expectUpgradeRejected(
        new WebSocket(wsUrl(), { headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}` } }),
      )
    })
  })

  it('挂载前缀形态可用（与 app.ts 同构的 route 挂载后 /api/terminals/ws 可升级）', async () => {
    const app = new Hono({ strict: false })
    app.route(TERMINAL_MOUNT, createTerminalsApp(await createTerminalsHostDeps()))
    const mounted = serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, srv) => app.fetch(request, srv),
      websocket: bunWebSocket.websocket,
    })
    try {
      const client = createClient(`ws://127.0.0.1:${mounted.port}${TERMINAL_MOUNT}/ws`, {
        origin: `http://127.0.0.1:${mounted.port}`,
      })
      await client.opened
      const ready = await client.waitFrame((frame) => frame.type === 'ready')
      expect(ready.type).toBe('ready')
      client.ws.close()
    } finally {
      mounted.stop(true)
    }
  }, 15000)
})
