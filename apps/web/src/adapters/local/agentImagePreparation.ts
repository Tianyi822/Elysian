import { AGENT_ATTACHMENT_LIMITS } from '@elysian/contracts'

const MAX_EDGE = 6000
const MAX_QUALITY = 0.95
const MIN_QUALITY = 0.8
const SCALE_STEP = 0.85

type DecodedImage = {
  source: CanvasImageSource
  width: number
  height: number
  release(): void
}

const abortError = () => new DOMException('图片处理已取消。', 'AbortError')
const checkAborted = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError() }
const isAbortError = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

async function decodeImage(file: File, signal?: AbortSignal): Promise<DecodedImage> {
  checkAborted(signal)
  if (typeof createImageBitmap === 'function') {
    try {
      return await new Promise<DecodedImage>((resolve, reject) => {
        let settled = false
        const abort = () => { settled = true; reject(abortError()) }
        signal?.addEventListener('abort', abort, { once: true })
        // 原生解码器先应用 EXIF 方向，尺寸和绘制均使用校正后的像素。
        Promise.resolve().then(() => createImageBitmap(file, { imageOrientation: 'from-image' })).then(bitmap => {
          signal?.removeEventListener('abort', abort)
          if (settled || signal?.aborted) { bitmap.close(); reject(abortError()); return }
          settled = true
          resolve({ source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() })
        }, error => {
          signal?.removeEventListener('abort', abort)
          if (!settled) { settled = true; reject(signal?.aborted ? abortError() : error) }
        })
      })
    } catch (error) { if (isAbortError(error)) throw error }
  }
  checkAborted(signal)
  const url = URL.createObjectURL(file)
  const image = new Image()
  return new Promise<DecodedImage>((resolve, reject) => {
    const detach = () => {
      image.onload = null
      image.onerror = null
      signal?.removeEventListener('abort', abort)
    }
    const release = () => { image.removeAttribute('src'); URL.revokeObjectURL(url) }
    const abort = () => { detach(); release(); reject(abortError()) }
    signal?.addEventListener('abort', abort, { once: true })
    image.onload = () => {
      detach()
      if (signal?.aborted) { release(); reject(abortError()); return }
      resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight, release })
    }
    image.onerror = () => { detach(); release(); reject(new Error('无法解码图片。')) }
    image.src = url
  })
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number | undefined, signal?: AbortSignal): Promise<Blob> {
  checkAborted(signal)
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError())
    signal?.addEventListener('abort', abort, { once: true })
    try {
      canvas.toBlob(blob => {
        signal?.removeEventListener('abort', abort)
        if (signal?.aborted) { reject(abortError()); return }
        if (!blob?.size || blob.type !== type) { reject(new Error('浏览器无法编码图片。')); return }
        resolve(blob)
      }, type, quality)
    } catch (error) {
      signal?.removeEventListener('abort', abort)
      reject(error)
    }
  })
}

async function fitJPEG(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob | undefined> {
  const largest = await encode(canvas, 'image/jpeg', MAX_QUALITY, signal)
  if (largest.size <= AGENT_ATTACHMENT_LIMITS.maxFileBytes) return largest
  let best = await encode(canvas, 'image/jpeg', MIN_QUALITY, signal)
  if (best.size > AGENT_ATTACHMENT_LIMITS.maxFileBytes) return undefined
  let low = MIN_QUALITY
  let high = MAX_QUALITY
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const quality = (low + high) / 2
    const candidate = await encode(canvas, 'image/jpeg', quality, signal)
    if (candidate.size <= AGENT_ATTACHMENT_LIMITS.maxFileBytes) { best = candidate; low = quality }
    else high = quality
  }
  return best
}

function hasTransparency(image: DecodedImage, renderedCanvas: HTMLCanvasElement, renderedContext: CanvasRenderingContext2D, signal?: AbortSignal): boolean {
  // 原图按像素块检查，避免缩放抹去微小透明区，也不额外分配整图像素。
  const originalSize = renderedCanvas.width === image.width && renderedCanvas.height === image.height
  const canvas = originalSize ? undefined : document.createElement('canvas')
  try {
    const tileWidth = Math.min(512, image.width)
    const tileHeight = Math.min(512, image.height)
    if (canvas) { canvas.width = tileWidth; canvas.height = tileHeight }
    const context = canvas ? canvas.getContext('2d', { willReadFrequently: true }) : renderedContext
    if (!context) throw new Error('浏览器无法检查图片透明度。')
    if (canvas) context.imageSmoothingEnabled = false
    for (let y = 0; y < image.height; y += tileHeight) {
      for (let x = 0; x < image.width; x += tileWidth) {
        checkAborted(signal)
        const width = Math.min(tileWidth, image.width - x)
        const height = Math.min(tileHeight, image.height - y)
        if (canvas) {
          context.clearRect(0, 0, tileWidth, tileHeight)
          context.drawImage(image.source, x, y, width, height, 0, 0, width, height)
        }
        const pixels = context.getImageData(canvas ? 0 : x, canvas ? 0 : y, width, height).data
        for (let alpha = 3; alpha < pixels.length; alpha += 4) if (pixels[alpha] !== 255) return true
      }
    }
    return false
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0 }
  }
}

function preparedFile(blob: Blob, source: File): File {
  const name = source.type === blob.type ? source.name : `${source.name.replace(/\.[^.]*$/, '') || 'image'}.${blob.type === 'image/jpeg' ? 'jpg' : 'png'}`
  return new File([blob], name, { type: blob.type, lastModified: source.lastModified })
}

/** 合规图片保留原字节，所有压缩候选始终从解码后的原图绘制。 */
export async function prepareAgentImage(file: File, signal?: AbortSignal): Promise<File> {
  checkAborted(signal)
  if (!(AGENT_ATTACHMENT_LIMITS.acceptMimeTypes as readonly string[]).includes(file.type)) throw new Error(`“${file.name}”仅支持 JPEG 或 PNG 图片。`)
  let decoded: DecodedImage | undefined
  let canvas: HTMLCanvasElement | undefined
  try {
    decoded = await decodeImage(file, signal)
    checkAborted(signal)
    if (!Number.isFinite(decoded.width) || !Number.isFinite(decoded.height) || decoded.width < 1 || decoded.height < 1) throw new Error('图片尺寸无效。')
    if (file.size <= AGENT_ATTACHMENT_LIMITS.maxFileBytes && Math.max(decoded.width, decoded.height) <= MAX_EDGE) return file

    const scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height))
    let width = Math.max(1, Math.floor(decoded.width * scale))
    let height = Math.max(1, Math.floor(decoded.height * scale))
    canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: file.type === 'image/png' })
    if (!context) throw new Error('浏览器不支持图片压缩。')
    let transparent: boolean | undefined
    while (true) {
      checkAborted(signal)
      canvas.width = width
      canvas.height = height
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.drawImage(decoded.source, 0, 0, width, height)
      let result: Blob | undefined
      if (file.type === 'image/png') {
        const png = await encode(canvas, 'image/png', undefined, signal)
        if (png.size <= AGENT_ATTACHMENT_LIMITS.maxFileBytes) result = png
        else {
          transparent ??= hasTransparency(decoded, canvas, context, signal)
          if (!transparent) result = await fitJPEG(canvas, signal)
        }
      } else result = await fitJPEG(canvas, signal)
      checkAborted(signal)
      if (result) return preparedFile(result, file)
      if (width === 1 && height === 1) throw new Error('无法将图片压缩至 1 MiB，请换一张图片。')
      width = Math.max(1, Math.floor(width * SCALE_STEP))
      height = Math.max(1, Math.floor(height * SCALE_STEP))
    }
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw abortError()
    throw new Error(`“${file.name}”处理失败：${error instanceof Error ? error.message : '无法读取或压缩图片。'}`)
  } finally {
    decoded?.release()
    if (canvas) { canvas.width = 0; canvas.height = 0 }
  }
}
