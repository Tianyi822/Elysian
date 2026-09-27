import type { ImagePullProgress } from '@elysian/contracts'

const MAX_PULL_PROGRESS_BYTES = 64 * 1024 * 1024
const MAX_PULL_LINE_LENGTH = 128 * 1024

export type PullProgressResult = { ok: true } | { ok: false; error: string }

function pullErrorFromLine(line: string): string | null {
  if (line.length === 0) return null
  try {
    const value = JSON.parse(line) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const frame = value as { error?: unknown; errorDetail?: { message?: unknown } }
    const error = typeof frame.errorDetail?.message === 'string' ? frame.errorDetail.message : frame.error
    if (typeof error !== 'string' || error.length === 0) return null
    return error
  } catch {
    return null
  }
}

function progressFromLine(line: string): ImagePullProgress | null {
  let frame: unknown
  try { frame = JSON.parse(line) } catch { return null }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return null
  const value = frame as { status?: unknown; id?: unknown; progressDetail?: { current?: unknown; total?: unknown } }
  if (typeof value.status !== 'string') return null
  const status = value.status
  const phase: ImagePullProgress['phase'] =
    status === 'Downloading' ? 'downloading' :
    status === 'Extracting' ? 'extracting' :
    status === 'Pulling fs layer' || status === 'Waiting' || status.startsWith('Pulling from ') ? 'preparing' : 'finalizing'
  const layerId = typeof value.id === 'string' && value.id.length <= 64 && !status.startsWith('Pulling from ')
    ? value.id : undefined
  const current = value.progressDetail?.current
  const total = value.progressDetail?.total
  const hasBytes = (phase === 'downloading' || phase === 'extracting') &&
    typeof current === 'number' && Number.isFinite(current) && current >= 0 &&
    typeof total === 'number' && Number.isFinite(total) && total > 0
  return {
    phase,
    ...(layerId ? { layerId } : {}),
    ...(hasBytes ? { currentBytes: Math.min(current, total), totalBytes: total } : {}),
  }
}

/** 按行增量解码 Engine 的 JSON 进度；跨块 UTF-8 与分行均不丢帧。 */
export function createPullProgressDecoder(onProgress: (progress: ImagePullProgress) => void | Promise<void>) {
  const decoder = new TextDecoder()
  let buffer = ''
  let lastKey = ''

  async function consume(line: string): Promise<void> {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    const error = pullErrorFromLine(line)
    if (error) throw new Error(error)
    const progress = progressFromLine(line)
    if (!progress) return
    const percent = progress.totalBytes
      ? Math.floor((progress.currentBytes ?? 0) / progress.totalBytes * 100)
      : null
    const key = `${progress.phase}:${progress.layerId ?? ''}:${percent ?? 'unknown'}`
    if (key === lastKey) return
    lastKey = key
    await onProgress(progress)
  }

  async function feed(chunk: Uint8Array): Promise<void> {
    buffer += decoder.decode(chunk, { stream: true })
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.length > MAX_PULL_LINE_LENGTH) throw new Error('拉取进度行过大')
      await consume(line)
    }
    if (buffer.length > MAX_PULL_LINE_LENGTH) throw new Error('拉取进度行过大')
  }

  async function finish(): Promise<void> {
    buffer += decoder.decode()
    if (buffer) await consume(buffer)
    buffer = ''
  }

  return { feed, finish }
}

export function readPullProgress(chunks: readonly Uint8Array[]): PullProgressResult {
  const decoder = new TextDecoder()
  let totalBytes = 0
  let textBuffer = ''

  for (const chunk of chunks) {
    totalBytes += chunk.length
    if (totalBytes > MAX_PULL_PROGRESS_BYTES) {
      return { ok: false, error: '拉取进度过大' }
    }
    textBuffer += decoder.decode(chunk, { stream: true })
    for (;;) {
      const newline = textBuffer.indexOf('\n')
      if (newline === -1) break
      let line = textBuffer.slice(0, newline)
      textBuffer = textBuffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      const pullError = pullErrorFromLine(line)
      if (pullError !== null) {
        return { ok: false, error: pullError }
      }
    }
  }

  textBuffer += decoder.decode()
  if (textBuffer.length > 0) {
    const tail = textBuffer.endsWith('\r') ? textBuffer.slice(0, -1) : textBuffer
    const pullError = pullErrorFromLine(tail)
    if (pullError !== null) {
      return { ok: false, error: pullError }
    }
  }

  return { ok: true }
}

function concatUint8Arrays(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0)
  if (parts.length === 1) return parts[0]!
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function demuxDockerStream(bytes: Uint8Array): { stdout: Uint8Array; stderr: Uint8Array } {
  const stdoutParts: Uint8Array[] = []
  const stderrParts: Uint8Array[] = []
  let offset = 0

  while (offset + 8 <= bytes.length) {
    const streamType = bytes[offset]
    const size =
      ((bytes[offset + 4]! << 24) |
        (bytes[offset + 5]! << 16) |
        (bytes[offset + 6]! << 8) |
        bytes[offset + 7]!) >>> 0
    offset += 8
    if (offset + size > bytes.length) break
    const payload = bytes.subarray(offset, offset + size)
    offset += size
    if (streamType === 1) stdoutParts.push(payload)
    else if (streamType === 2) stderrParts.push(payload)
  }

  return {
    stdout: concatUint8Arrays(stdoutParts),
    stderr: concatUint8Arrays(stderrParts),
  }
}
