import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Duplex } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createBoundedChunkQueue, createContainerExecRunner } from './dockerExecRunner.ts'

/*
 * 容器 exec 劫持连接的传输测试：在本地 unix socket 上架一个 fake Engine，走真实
 * node:http 链路驱动 createContainerExecRunner。start 响应按真实引擎的 hijack 语义
 * 回 101 Upgrade（POST /exec/{id}/start 带 Upgrade: tcp 的实测形态），升级后的裸
 * socket 直接收发字节。引擎下行统一以 READY-FROM-ENGINE 哨兵标记 attach 完成，
 * 上行以回显验证写出次序。
 */

const SOCKET_PATH = path.join(os.tmpdir(), `elysian-exec-runner-test-${process.pid}.sock`)

let server: http.Server
let createBodies: Record<string, unknown>[] = []
let upgradeRequestSeen = false
let startResponseMode: 'upgrade' | 'ok' = 'upgrade'
/** 升级后的裸 socket 脱离 http.Server 的连接管理，收尾必须显式销毁。 */
const upgradedSockets = new Set<Duplex>()

const GREETING = 'READY-FROM-ENGINE\n'

function writeRaw(socket: Duplex, head: string): void {
  socket.write(head)
}

async function collectUntil(
  stdout: AsyncIterable<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stdout) {
    text += decoder.decode(chunk, { stream: true })
    if (predicate(text)) return text
  }
  return text
}

beforeAll(async () => {
  fs.rmSync(SOCKET_PATH, { force: true })
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1.41/exec/exec-1/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ExitCode: 7 }))
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      createBodies.push(raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {})
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ Id: 'exec-1' }))
    })
  })
  server.on('upgrade', (_req, socket, _head) => {
    upgradeRequestSeen = true
    upgradedSockets.add(socket)
    socket.on('close', () => upgradedSockets.delete(socket))
    socket.on('error', () => undefined)
    if (startResponseMode === 'ok') {
      // 非 101 的 2xx 分支仍受 HTTP 帧语义约束：下行以响应体送达，不做裸 socket 回显。
      writeRaw(socket, `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(GREETING)}\r\n\r\n`)
      writeRaw(socket, GREETING)
      return
    }
    writeRaw(socket, 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n')
    writeRaw(socket, GREETING)
    socket.on('data', (chunk) => socket.write(chunk))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(SOCKET_PATH, () => resolve())
  })
})

afterAll(async () => {
  // 实测：hijack socket 已脱离 http.Server 连接表（closeAllConnections 不断它），
  // 客户端 agent 的 keep-alive 空连接也要断——先清两路连接，close 回调才会触发。
  for (const socket of upgradedSockets) socket.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(SOCKET_PATH, { force: true })
})

beforeEach(() => {
  createBodies = []
  upgradeRequestSeen = false
  startResponseMode = 'upgrade'
})

describe('createContainerExecRunner', () => {
  it('exec inspect 返回真实退出码', async () => {
    const runner = createContainerExecRunner(SOCKET_PATH, 'target-container')
    const session = runner.run(['/bin/sh'], true)
    await collectUntil(session.stdout, (text) => text.includes(GREETING.trim()))
    await expect(session.exitCode?.()).resolves.toBe(7)
    session.close()
  })

  it('连接尚未建立就 close 时不继续创建交互 exec', async () => {
    const runner = createContainerExecRunner(SOCKET_PATH, 'target-container')
    const session = runner.run(['/bin/sh'], true)
    session.close()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(upgradeRequestSeen).toBe(false)
  })

  it(
    'exec createBody 携带 Env，start 请求以 Upgrade: tcp 走 101 hijack',
    async () => {
      const runner = createContainerExecRunner(SOCKET_PATH, 'target-container')
      const session = runner.run(['/bin/sh'], true, { PS1: 'x' })
      const text = await collectUntil(session.stdout, (t) => t.includes(GREETING.trim()))
      expect(upgradeRequestSeen).toBe(true)
      expect(createBodies[0]).toMatchObject({
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Cmd: ['/bin/sh'],
        Env: ['PS1=x'],
      })
      expect(text).toContain(GREETING.trim())
      session.close()
    },
    10_000,
  )

  it(
    'attach 前的 write 进入缓冲，attach 后按序写出',
    async () => {
      const runner = createContainerExecRunner(SOCKET_PATH, 'target-container')
      const session = runner.run(['/bin/sh'], true)
      // 此刻 create/start 请求尚在途，两次 write 必须落入 pendingWrites 而非丢失。
      session.write('echo one\n')
      session.write('echo two\n')
      const text = await collectUntil(session.stdout, (t) => t.includes('echo two'))
      const attachIndex = text.indexOf(GREETING.trim())
      const oneIndex = text.indexOf('echo one')
      const twoIndex = text.indexOf('echo two')
      expect(attachIndex).toBeGreaterThanOrEqual(0)
      expect(oneIndex).toBeGreaterThan(attachIndex)
      expect(twoIndex).toBeGreaterThan(oneIndex)
      session.close()
    },
    10_000,
  )

  it(
    'start 返回非 101 的 2xx 响应时经 response 分支 attach',
    async () => {
      startResponseMode = 'ok'
      const runner = createContainerExecRunner(SOCKET_PATH, 'target-container')
      const session = runner.run(['/bin/sh'], true)
      const text = await collectUntil(session.stdout, (t) => t.includes(GREETING.trim()))
      expect(upgradeRequestSeen).toBe(true)
      expect(text).toContain(GREETING.trim())
      session.close()
      startResponseMode = 'upgrade'
    },
    10_000,
  )
})

describe('createBoundedChunkQueue', () => {
  const decoder = new TextDecoder()
  const encode = (text: string) => new TextEncoder().encode(text)

  it('未消费字节超过上限时显式失败，不静默丢掉旧输出', () => {
    const queue = createBoundedChunkQueue(10)
    queue.push(encode('12345'))
    queue.push(encode('67890'))
    expect(() => queue.push(encode('ab'))).toThrow('输出缓冲超限')
    expect(decoder.decode(queue.shift()!)).toBe('12345')
    expect(decoder.decode(queue.shift()!)).toBe('67890')
    expect(queue.shift()).toBeUndefined()
  })

  it('单个超过上限的块拒绝，不截断成无法解释的尾部', () => {
    const queue = createBoundedChunkQueue(4)
    expect(() => queue.push(encode('abcdefgh'))).toThrow('输出缓冲超限')
    expect(queue.shift()).toBeUndefined()
  })

  it('消费即释放驻留：shift 出队后可继续容纳新块', () => {
    const queue = createBoundedChunkQueue(8)
    queue.push(encode('12345678'))
    expect(decoder.decode(queue.shift()!)).toBe('12345678')
    queue.push(encode('x'))
    expect(decoder.decode(queue.shift()!)).toBe('x')
    expect(queue.shift()).toBeUndefined()
  })
})
