import { AGENT_CHAT_TEXT_BYTES } from '../../contracts/agentChat'

const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'log', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'scss', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'sh', 'bash', 'zsh', 'sql', 'toml', 'ini', 'cfg', 'conf', 'env', 'gitignore', 'dockerignore']
const TEXT_MIMES = new Set(['application/json', 'application/ld+json', 'application/x-ndjson', 'application/yaml', 'application/x-yaml', 'application/xml', 'application/javascript', 'application/x-javascript', 'application/x-sh', 'application/sql', 'application/toml'])
export const AGENT_COMPOSER_FILE_ACCEPT = ['image/jpeg', 'image/png', '.jpg', '.jpeg', '.png', 'text/*', ...TEXT_MIMES, ...TEXT_EXTENSIONS.map(extension => `.${extension}`)].join(',')

export function agentComposerImageMime(file: File): 'image/jpeg' | 'image/png' | undefined {
  const mime = file.type.toLowerCase().split(';')[0]!.trim()
  if (mime === 'image/jpeg' || mime === 'image/png') return mime
  if (!mime || mime === 'application/octet-stream') {
    if (/\.jpe?g$/i.test(file.name)) return 'image/jpeg'
    if (/\.png$/i.test(file.name)) return 'image/png'
  }
  return undefined
}

export function agentComposerFileKind(file: File): 'image' | 'text' | 'unsupported' {
  const mime = file.type.toLowerCase().split(';')[0]!.trim()
  if (agentComposerImageMime(file)) return 'image'
  if (mime.startsWith('text/') || TEXT_MIMES.has(mime)) return 'text'
  if (mime && mime !== 'application/octet-stream') return 'unsupported'
  const name = file.name.toLowerCase()
  return TEXT_EXTENSIONS.some(extension => name.endsWith(`.${extension}`)) || ['dockerfile', 'makefile', 'license', 'readme'].includes(name) ? 'text' : 'unsupported'
}

function readBytes(file: File, signal?: AbortSignal): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const abort = () => reader.abort()
    const finish = () => signal?.removeEventListener('abort', abort)
    reader.onload = () => { finish(); resolve(reader.result as ArrayBuffer) }
    reader.onerror = () => { finish(); reject(new Error(`无法读取文本文件“${file.name}”，请重新选择。`)) }
    reader.onabort = () => { finish(); reject(new DOMException('文件读取已取消。', 'AbortError')) }
    if (signal?.aborted) { reject(new DOMException('文件读取已取消。', 'AbortError')); return }
    signal?.addEventListener('abort', abort, { once: true })
    reader.readAsArrayBuffer(file)
  })
}

/** 文本文件显式读入可编辑草稿，不伪装成模型的原生附件。整批校验后才返回。 */
export async function readAgentTextFiles(files: readonly File[], signal?: AbortSignal): Promise<string> {
  if (files.reduce((total, file) => total + file.size, 0) > AGENT_CHAT_TEXT_BYTES) throw new Error('文本文件合计不能超过 32 KiB，请缩短或分批添加。')
  const blocks: string[] = []
  for (const file of files) {
    const bytes = new Uint8Array(await readBytes(file, signal))
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
    let text: string
    try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes) }
    catch { throw new Error(`“${file.name}”不是有效的 UTF-8 或带 BOM 的 UTF-16 文本，请转换编码后重试。`) }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error(`“${file.name}”含有二进制或不支持的控制字符，无法作为文本导入。`)
    if (!text.trim()) throw new Error(`文本文件“${file.name}”为空，请选择有内容的文件。`)
    blocks.push(`文件：${JSON.stringify(file.name)}\n${text}`)
  }
  return blocks.join('\n\n')
}

export function appendAgentTextFiles(draft: string, content: string): string {
  if (!content) return draft
  const next = draft ? `${draft}\n\n${content}` : content
  if (new TextEncoder().encode(next).length > AGENT_CHAT_TEXT_BYTES) throw new Error('导入后的消息超过 32 KiB，已保留原草稿，请缩短内容后再添加。')
  return next
}
