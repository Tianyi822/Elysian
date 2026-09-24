import * as http from 'node:http'

export type DockerTransport = {
  request(input: {
    method: string
    path: string
    body?: unknown
    timeoutMs: number
    maxBytes: number
  }): Promise<{ status: number; json: unknown }>
  openStream?(input: {
    method: string
    path: string
    onLine: (line: string) => void
    onError: (error: Error) => void
    onClose: () => void
  }): () => void
}

const MIN_API_MAJOR = 1
const MIN_API_MINOR = 41

function parseApiVersion(version: string): { major: number; minor: number } {
  const [majorPart, minorPart] = version.split('.')
  const major = Number(majorPart)
  const minor = Number(minorPart ?? '0')
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return { major: 0, minor: 0 }
  }
  return { major, minor }
}

function isApiVersionSupported(apiVersion: string): boolean {
  const { major, minor } = parseApiVersion(apiVersion)
  if (major > MIN_API_MAJOR) return true
  if (major < MIN_API_MAJOR) return false
  return minor >= MIN_API_MINOR
}

export async function assertEngineApi(transport: DockerTransport): Promise<void> {
  const { json } = await transport.request({
    method: 'GET',
    path: '/version',
    timeoutMs: 3000,
    maxBytes: 1_048_576,
  })
  const apiVersion =
    json !== null && typeof json === 'object' && 'ApiVersion' in json
      ? (json as { ApiVersion: unknown }).ApiVersion
      : undefined
  if (typeof apiVersion !== 'string' || !isApiVersionSupported(apiVersion)) {
    throw new Error('Docker Engine API 版本过低，需要 1.41 及以上')
  }
}

function requestOverSocket(
  socketPath: string,
  input: {
    method: string
    path: string
    body?: unknown
    timeoutMs: number
    maxBytes: number
  },
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyPayload =
      input.body === undefined ? undefined : JSON.stringify(input.body)
    const req = http.request(
      {
        socketPath,
        hostname: 'localhost',
        method: input.method,
        path: input.path,
        headers:
          bodyPayload === undefined
            ? undefined
            : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyPayload),
              },
      },
      (res) => {
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > input.maxBytes) {
            req.destroy()
            reject(new Error('Docker 响应过大'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (raw.length === 0) {
            resolve({ status: res.statusCode ?? 0, json: null })
            return
          }
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) })
          } catch {
            reject(new Error('Docker 响应不是有效 JSON'))
          }
        })
        res.on('error', (err) => reject(err))
      },
    )
    req.setTimeout(input.timeoutMs, () => {
      req.destroy()
      reject(new Error('Docker 请求超时'))
    })
    req.on('error', (err) => reject(err))
    if (bodyPayload !== undefined) {
      req.write(bodyPayload)
    }
    req.end()
  })
}

function openStreamOverSocket(
  socketPath: string,
  input: {
    method: string
    path: string
    onLine: (line: string) => void
    onError: (error: Error) => void
    onClose: () => void
  },
): () => void {
  let buffer = ''
  let closed = false

  const req = http.request(
    {
      socketPath,
      hostname: 'localhost',
      method: input.method,
      path: input.path,
    },
    (res) => {
      res.on('data', (chunk: Buffer) => {
        if (closed) return
        buffer += chunk.toString('utf8')
        for (;;) {
          const newline = buffer.indexOf('\n')
          if (newline === -1) break
          let line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (line.endsWith('\r')) line = line.slice(0, -1)
          if (line.length > 0) input.onLine(line)
        }
      })
      res.on('end', () => {
        if (closed) return
        if (buffer.length > 0) {
          const tail = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
          if (tail.length > 0) input.onLine(tail)
          buffer = ''
        }
        input.onClose()
      })
      res.on('error', (err) => {
        if (closed) return
        input.onError(err instanceof Error ? err : new Error(String(err)))
      })
    },
  )
  req.on('error', (err) => {
    if (closed) return
    input.onError(err instanceof Error ? err : new Error(String(err)))
  })
  req.end()

  return () => {
    closed = true
    req.destroy()
  }
}

export function createDockerTransport(options: {
  socketPath: string
  requestImpl?: DockerTransport['request']
  openStreamImpl?: NonNullable<DockerTransport['openStream']>
}): DockerTransport {
  const request =
    options.requestImpl ??
    ((input) => requestOverSocket(options.socketPath, input))
  const openStream =
    options.openStreamImpl ??
    (options.requestImpl
      ? undefined
      : (input) => openStreamOverSocket(options.socketPath, input))
  return openStream === undefined ? { request } : { request, openStream }
}
