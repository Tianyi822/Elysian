const MAX_PULL_PROGRESS_BYTES = 64 * 1024 * 1024

export type PullProgressResult = { ok: true } | { ok: false; error: string }

function pullErrorFromLine(line: string): string | null {
  if (line.length === 0) return null
  try {
    const value = JSON.parse(line) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const error = (value as { error?: unknown }).error
    if (typeof error !== 'string' || error.length === 0) return null
    return error
  } catch {
    return null
  }
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
