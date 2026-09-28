import { createConnection } from 'node:net'
import { InvalidRequestError } from '../shared/errors.ts'

const MAX_REPLY_BYTES = 1024 * 1024
const MAX_ARRAY_ITEMS = 500
const MAX_DEPTH = 16
const AUTH_TIMEOUT = 5000
const COMMAND_TIMEOUT = 15_000

type Reply = string | number | null | Reply[]
type Parsed = { value: Reply; next: number; error?: string }

function lineAt(buffer: Buffer, start: number): { text: string; next: number } | undefined {
  const end = buffer.indexOf('\r\n', start)
  if (end < 0) return undefined
  return { text: buffer.toString('utf8', start, end), next: end + 2 }
}

/** RESP2 帧只在 1 MiB 有界缓冲内解析；大 bulk 头一到就拒绝，避免先分配完整结果。 */
export function parseRedisReply(buffer: Buffer, start = 0, depth = 0): Parsed | undefined {
  if (depth > MAX_DEPTH) throw new Error('Redis 结果嵌套过深')
  if (start >= buffer.length) return undefined
  const prefix = String.fromCharCode(buffer[start]!)
  const header = lineAt(buffer, start + 1)
  if (!header) return undefined
  if (prefix === '+' || prefix === '-') return {
    value: header.text, next: header.next, ...(prefix === '-' ? { error: header.text } : {}),
  }
  if (prefix === ':') {
    if (!/^-?\d+$/.test(header.text)) throw new Error('Redis 整数结果无效')
    return { value: Number(header.text), next: header.next }
  }
  if (prefix === '$') {
    if (!/^-?\d+$/.test(header.text)) throw new Error('Redis 字符串长度无效')
    const length = Number(header.text)
    if (length === -1) return { value: null, next: header.next }
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_REPLY_BYTES) throw new Error('Redis 结果超过 1 MiB，已中断')
    const end = header.next + length
    if (buffer.length < end + 2) return undefined
    if (buffer[end] !== 13 || buffer[end + 1] !== 10) throw new Error('Redis 字符串帧无效')
    return { value: buffer.toString('utf8', header.next, end), next: end + 2 }
  }
  if (prefix === '*') {
    if (!/^-?\d+$/.test(header.text)) throw new Error('Redis 数组长度无效')
    const count = Number(header.text)
    if (count === -1) return { value: null, next: header.next }
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_ARRAY_ITEMS) throw new Error('Redis 结果超过 500 项，已中断')
    const values: Reply[] = []
    let next = header.next
    for (let index = 0; index < count; index += 1) {
      const item = parseRedisReply(buffer, next, depth + 1)
      if (!item) return undefined
      if (item.error) throw new Error(item.error)
      values.push(item.value)
      next = item.next
    }
    return { value: values, next }
  }
  throw new Error('Redis 响应类型不受支持')
}

function encodeCommand(args: readonly string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)]
  for (const arg of args) {
    const value = Buffer.from(arg)
    parts.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n'))
  }
  return Buffer.concat(parts)
}

export async function openBoundedRedisTerminal(
  address: { host: string; port: number },
  credential: { username: string; password: string },
  validate: (input: string) => string[],
): Promise<{ execute(input: string): Promise<string[]>; close(): Promise<void> }> {
  const socket = createConnection({ host: address.host, port: address.port })
  socket.setNoDelay(true)
  let buffer = Buffer.alloc(0)
  let closed = false
  let pending: { resolve(value: Reply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined
  const fail = (error: Error) => {
    closed = true
    socket.destroy()
    const active = pending
    pending = undefined
    if (active) { clearTimeout(active.timer); active.reject(error) }
  }
  socket.on('error', (error) => fail(error))
  socket.on('close', () => fail(new Error('Redis 连接已断开')))
  socket.on('data', (chunk: Buffer) => {
    if (!pending) return
    if (buffer.length + chunk.length > MAX_REPLY_BYTES + 128) { fail(new Error('Redis 结果超过 1 MiB，已中断')); return }
    buffer = Buffer.concat([buffer, chunk])
    try {
      const parsed = parseRedisReply(buffer)
      if (!parsed) return
      buffer = buffer.subarray(parsed.next)
      const active = pending
      pending = undefined
      clearTimeout(active.timer)
      if (parsed.error) active.reject(new InvalidRequestError(400, parsed.error))
      else active.resolve(parsed.value)
    } catch (error) { fail(error instanceof Error ? error : new Error('Redis 结果解析失败')) }
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Redis 连接超时')) }, AUTH_TIMEOUT)
    socket.once('connect', () => { clearTimeout(timer); resolve() })
    socket.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
  function request(args: readonly string[], timeout = COMMAND_TIMEOUT): Promise<Reply> {
    if (closed) return Promise.reject(new Error('Redis 连接已断开'))
    if (pending) return Promise.reject(new Error('上一条 Redis 命令仍在执行'))
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('Redis 命令超时，连接已关闭')), timeout)
      pending = { resolve, reject, timer }
      socket.write(encodeCommand(args), (error) => { if (error) fail(error) })
    })
  }
  try {
    const result = await request(['AUTH', credential.username, credential.password], AUTH_TIMEOUT)
    if (result !== 'OK') throw new Error('Redis 普通账号认证失败')
  } catch (error) {
    fail(error instanceof Error ? error : new Error('Redis 普通账号认证失败'))
    throw error
  }
  return {
    async execute(input) {
      const result = await request(validate(input))
      const text = JSON.stringify(result)
      if (Buffer.byteLength(text) > MAX_REPLY_BYTES) throw new Error('Redis 结果超过 1 MiB，已中断')
      return [text]
    },
    async close() { fail(new Error('Redis 会话已关闭')) },
  }
}
